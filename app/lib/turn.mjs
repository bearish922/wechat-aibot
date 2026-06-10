import { uuid, log, sleep } from "./utils.mjs";
import { sessions, profileTemplates, pendingInputs } from "./state.mjs";
import { SCENELET_BARE, CLAUDE_MAIN_MODEL, runHiddenCall } from "./claude-runner.mjs";
import { loadPrompts, MAX_REPLY_LEN, splitText, splitSocialReply } from "./reply.mjs";
import { getSceneConfig, takeLastRounds, normalizeProactiveIntents, normalizeToolUsage, normalizeWorldState, applyWorldStatePatch, normalizeLifeArcs, normalizeSceneletResult, normalizeRawProactiveCandidate, normalizeScheduleCandidates, normalizeProactiveDecision, sanitizeVisibleReplyText, proactiveSentToday, lastConversationActivityMs } from "./normalize.mjs";
import { sessionProfile, roleWorldKey, ensureWorldSession, getRoleWorld, saveRoleWorlds, applyLifeArcOps, lifeArcPromptItems } from "./world-state.mjs";
import { saveSessions } from "./session-store.mjs";
import { getSceneMemorySystemBlock, buildSceneMemorySummaryPrompt, buildHiddenWorldSystemPrompt, buildHiddenWorldPrompt, buildProactivePrompt, buildScheduleFinalizationPrompt, recentVisibleContext, appendVisibleHistory } from "./prompts.mjs";
import { isMemoryEnabled, shouldRunMemoryWriter, loadMemoryDocument, updateMemoryDocument } from "./memory.mjs";
import { appendChatEvent, loadAllEvents } from "./chat-history.mjs";
import { sendMessage } from "./wechat.mjs";

// ─── proactive timer ─────────────────────────────────────────
// 上次主动意图检查的时间戳（毫秒），用于控制检查频率
let lastProactiveCheckAt = 0;

// ─── orchestration ───────────────────────────────────────────
// 核心编排函数：为本轮对话生成隐藏世界层的中间叙事（inner_scenelet）。
// 该 scenelet 是 AI 角色的"内心独白"，后续用于驱动最终回复的生成。
//
// @param {object} params
//   userId - 用户微信 ID
//   sess - 当前会话对象
//   profile - 当前角色的 profile 名称
//   userBody - 用户发送的消息文本
//   memoryPrompt - 记忆文档内容注入的提示词片段
// @returns {object|null} 标准化后的 scenelet 结果对象，包含 innerScenelet、worldStatePatch 等字段；失败返回 null
export async function generateSceneletForTurn({ userId, sess, profile, userBody, memoryPrompt }) {
  // 如果 profile 无效或未注册，跳过
  if (!profile || !profileTemplates[profile]) return null;
  // 获取角色的世界状态对象
  const roleWorld = getRoleWorld(profile);
  // 确保当前 profile 有一个活跃的 world session，并返回其引用
  const world = ensureWorldSession(roleWorld);
  // 构建发送给隐藏世界模型的提示词
  const prompt = buildHiddenWorldPrompt({
    userId,
    sessionName: sess.name,
    profile,
    userBody,
    lifeArcs: lifeArcPromptItems(roleWorld),
    visibleContext: recentVisibleContext(sess),
    memoryPrompt,
    worldState: normalizeWorldState(roleWorld._worldState),
    // 带入待处理的主动意图，数量受配置上限约束
    proactiveIntents: normalizeProactiveIntents(sess._proactiveIntents).filter(i => i.status === "pending").slice(-getSceneConfig().hiddenWorldMaxPendingIntents),
    worldSession: world,
  });
  // 仅在 world session 的首轮带入场景记忆系统块
  const sceneMemoryBlock = world.firstTurn ? getSceneMemorySystemBlock(roleWorld) : "";
  // 调用隐藏世界模型（首次尝试）
  let raw = await runHiddenCall(prompt, {
    label: "hidden_world",
    bare: SCENELET_BARE,
    persist: true,
    sessionName: `hidden-world-${roleWorldKey(profile)}`,
    sessionId: world.sid,
    firstTurn: world.firstTurn,
    model: world.model || CLAUDE_MAIN_MODEL,
    systemPrompt: buildHiddenWorldSystemPrompt(profile, sceneMemoryBlock, memoryPrompt),
  });
  // 隐藏世界调用失败：重置 world session 并重试
  if (!raw) {
    // 重置会话标识和首轮标记
    world.sid = uuid();
    world.firstTurn = true;
    world.startedAt = new Date().toISOString();
    world.resetReason = "hidden world retry after failed attempt";
    // 使用全新的会话参数重试
    raw = await runHiddenCall(prompt, {
      label: "hidden_world_retry",
      bare: SCENELET_BARE,
      persist: true,
      sessionName: `hidden-world-${roleWorldKey(profile)}`,
      sessionId: world.sid,
      firstTurn: true,
      model: world.model || CLAUDE_MAIN_MODEL,
      systemPrompt: buildHiddenWorldSystemPrompt(profile, getSceneMemorySystemBlock(roleWorld), memoryPrompt),
    });
  }
  // 标准化模型返回的原始数据
  const result = normalizeSceneletResult(raw);
  // 如果没有有效的 innerScenelet，返回 null
  if (!result?.innerScenelet) return null;
  // 如果 API 路径返回了 session_id，更新 world session 标识
  if (raw?._hiddenCall?.session_id) world.sid = raw._hiddenCall.session_id;
  // 更新 world session 的使用状态
  world.firstTurn = false;
  world.lastUsedAt = new Date().toISOString();
  world.lastUsage = result.hiddenCall || null;
  // 将模型输出的 worldStatePatch 应用到角色世界状态
  applyWorldStatePatch(roleWorld, result.worldStatePatch);
  roleWorld.updatedAt = world.lastUsedAt;
  saveRoleWorlds();
  return result;
}

// 构建"场景上下文块"：将 lifeArc 摘要和 inner_scenelet 拼接为一段结构化的上下文文本，
// 供后续回复生成的提示词使用。
//
// @param {object} sess - 当前会话对象
// @param {object} sceneletResult - 标准化后的 scenelet 结果（包含 innerScenelet 等字段）
// @returns {string} 拼接好的场景上下文文本块
export function buildSceneContextBlock(sess, sceneletResult) {
  const cfg = loadPrompts();
  const profile = sessionProfile(sess);
  // 提取 lifeArc 的简化信息（仅保留标题、进度、类型、时间范围）
  const lifeArcSummary = profile ? lifeArcPromptItems(getRoleWorld(profile)).map(arc => ({
    title: arc.title,
    progress_note: arc.progress_note,
    kind: arc.kind,
    time_start: arc.time_start,
    time_end: arc.time_end,
  })) : [];
  const parts = [
    // 如果有活跃的 lifeArc，拼入"正在发生的事"段落
    lifeArcSummary.length ? [
      "【正在发生的事】",
      "千圣生活中跨越多天的安排，只作为时间参考和自然接话线索，不要主动复述。",
      JSON.stringify(lifeArcSummary, null, 2),
    ].join("\n") : "",
    // 如果有 inner_scenelet，拼入隐藏中间层叙事及桥接说明
    sceneletResult?.innerScenelet ? [
      "【隐藏中间层：inner_scenelet】",
      cfg.innerSceneletIntro,
      sceneletResult.innerScenelet,
      cfg.sceneletReplyBridgeInstruction ? [
        "【从 inner_scenelet 到微信回复】",
        cfg.sceneletReplyBridgeInstruction,
      ].join("\n") : "",
    ].filter(Boolean).join("\n") : "",
  ].filter(Boolean);
  return parts.join("\n\n");
}

// 将 scenelet 生成的 follow_up 候选追加到会话的主动意图列表中。
// 每轮最多取 1 条，去重由 scenelet prompt 中 pending_proactive_intents 保证。
export async function addFollowUpCandidates(sess, sceneletResult, userBody) {
  if (!sess || !sceneletResult?.followUpCandidates?.length) return;
  const nowIso = new Date().toISOString();
  const existing = normalizeProactiveIntents(sess._proactiveIntents);
  for (const raw of sceneletResult.followUpCandidates.slice(0, 1)) {
    const candidate = normalizeRawProactiveCandidate(raw, {
      nowIso,
      sourceUserText: userBody,
      defaultKind: "follow_up",
    });
    if (!candidate) continue;
    existing.push(candidate);
  }
  sess._proactiveIntents = normalizeProactiveIntents(existing);
}

// 将本轮对话事件写入聊天历史数据库。
// 同时记录消息文本、scenelet 内部状态、主动意图 ID、工具使用信息等元数据。
//
// @param {object} params
//   ai - AI 标识（如 "cc" 或 "codex"）
//   userId - 微信用户 ID
//   sess - 会话对象
//   role - 发言角色（"user" / "assistant"）
//   kind - 消息类型（"chat" / "proactive" 等）
//   text - 消息文本
//   scenelet - 关联的 inner_scenelet 文本
//   sceneletStatus - scenelet 生成状态
//   sceneletError - scenelet 生成错误信息
//   proactiveIntentId - 关联的主动意图 ID
//   toolUsage - 工具调用信息
//   ragUsage - RAG 检索使用情况
//   timestamp - 事件时间戳
export async function recordChatHistory({ ai, userId, sess, role, kind = "chat", text, scenelet = "", sceneletStatus = "", sceneletError = "", proactiveIntentId = "", toolUsage = null, ragUsage = null, timestamp = new Date().toISOString() }) {
  // 文本和 scenelet 都为空时不记录
  if (!sess || (!text?.trim() && !scenelet?.trim())) return;
  // 将丰富字段封装后追加到聊天历史
  await appendChatEvent({
    timestamp,
    userId,
    ai,
    sessionId: sess.id,
    sessionName: sess.name,
    profile: sessionProfile(sess) || "默认",
    role,
    kind,
    text,
    scenelet,
    sceneletStatus,
    sceneletError,
    proactiveIntentId,
    toolUsage: normalizeToolUsage(toolUsage),
    ragUsage: ragUsage && typeof ragUsage === "object" ? {
      used: Boolean(ragUsage.used),
      chars: Number(ragUsage.chars || 0) || 0,
      eligible: Boolean(ragUsage.eligible),
    } : null,
  });
}

// 将 AI 生成的最终回复发送到微信。
// 对文本做清理和社交拆分后，切分为多条符合微信长度限制的消息逐条发送。
//
// @param {string} userId - 微信用户 ID
// @param {string} text - 要发送的回复文本
// @param {string} contextToken - 微信上下文 token（用于引用回复）
// @param {string} prefix - 消息前缀（如 "[CC] sessionName"）
// @returns {boolean} 是否全部消息发送成功
export async function sendFinalAssistantMessage(userId, text, contextToken, prefix) {
  const trimmed = sanitizeVisibleReplyText(text).trim();
  if (!trimmed) return false;
  const socialParts = splitSocialReply(trimmed);
  const messages = [];
  for (let i = 0; i < socialParts.length; i++) {
    // 第一条消息带前缀和井号头
    const head = i === 0 ? `# ${prefix}\n` : "";
    // 最后一条消息末尾带斜杠标记
    const tail = i === socialParts.length - 1 ? "/" : "";
    // 按 MAX_REPLY_LEN 切分每条消息
    messages.push(...splitText(`${head}${socialParts[i]}${tail}`, MAX_REPLY_LEN));
  }
  // 逐条发送到微信，失败不影响后续发送但标记整体结果为 false
  let ok = true;
  for (const chunk of messages) {
    if (!await sendMessage(userId, chunk, contextToken)) ok = false;
    // 多条消息间添加发送间隔，避免微信风控
    if (messages.length > 1) await sleep(getSceneConfig().chunkSendDelayMs);
  }
  return ok;
}

// 遍历所有 AI 实例下的所有用户会话，筛选出当前活跃且有有效 profile 模板的会话条目。
// 用于主动意图检查等需要遍历所有活跃会话的场景。
//
// @returns {Array<{ai, userId, sess, profile}>} 活跃的 profile 会话条目列表
function activeProfileSessionEntries() {
  const entries = [];
  for (const [ai, map] of Object.entries(sessions)) {
    for (const [userId, userData] of map) {
      // 找到该用户当前激活的会话
      const sess = (userData.list || []).find(s => s.id === userData.activeId);
      const profile = sessionProfile(sess);
      // 只收集有会话、有 profile 且 profile 已注册的条目
      if (sess && profile && profileTemplates[profile]) entries.push({ ai, userId, sess, profile });
    }
  }
  return entries;
}

// 标记某个主动意图的状态（sent / cancelled 等），并记录相应时间戳和原因。
// 该函数会原地修改 intent 对象。
//
// @param {object} intent - 意图对象（会被原地修改）
// @param {string} status - 新状态（"sent" / "cancelled"）
// @param {string} reason - 取消原因（仅在 cancelled 时有效）
function markProactiveIntent(intent, status, reason = "") {
  intent.status = status;
  // 记录发送或取消的时间戳
  if (status === "sent") intent.sentAt = new Date().toISOString();
  if (status === "cancelled") intent.cancelledAt = new Date().toISOString();
  // 截断原因文本到配置允许的最大长度
  if (reason) intent.cancelReason = String(reason).slice(0, getSceneConfig().maxCancelReasonLength);
}

// 对单个 pending 主动意图进行二次评估（"门控"），由独立模型调用决定该意图是否应该发送。
// 这是一个耗时的 AI 调用——模型会综合当前上下文、最近对话和意图内容，做出发送/取消的决策。
//
// @param {object} params
//   ai - AI 标识
//   userId - 微信用户 ID
//   sess - 会话对象
//   profile - 角色 profile 名称
//   intent - 待评估的意图对象
// @returns {object|null} 标准化后的决策结果（含 shouldSend、visibleReply 等字段）
async function evaluateProactiveIntent({ ai, userId, sess, profile, intent }) {
  // 构建用于二次评估意图的提示词
  const prompt = buildProactivePrompt({
    userId,
    sessionName: sess.name,
    profile,
    intent,
    visibleContext: recentVisibleContext(sess),
    sess,
  });
  // 调用 AI 做出决策，并标准化返回结果
  const raw = await runHiddenCall(prompt, { label: "proactive" });
  return normalizeProactiveDecision(raw);
}

// 基于当前时间推进角色的世界状态（时间推进器）。
// 当角色长时间未活动时，模型会根据当前时间、上次状态和活跃日程，
// 推断角色此刻应该在做什么、在什么位置，并更新世界状态。
//
// @param {object} params
//   roleWorld - 角色世界状态对象（会被修改）
//   profile - 角色 profile 名称
//   now - 当前 Date 对象
// @returns {boolean} 是否成功推进了状态
async function advanceWorldState({ roleWorld, profile, now }) {
  const cfg = getSceneConfig();
  const prompt = loadPrompts().timeAdvancementPrompt;
  // 未配置时间推进提示词模板则跳过
  if (!prompt) return false;

  const nowIso = now.toISOString();
  // 筛选活跃的日程安排用于上下文
  const activeArcs = normalizeLifeArcs(roleWorld._lifeArcs).filter(a => a.status === "active");
  const state = roleWorld._worldState || {};

  // 构建时间推进提示词的输入上下文：当前时间 + 上次状态 + 活跃日程
  const input = [
    prompt,
    "",
    "当前时间：",
    JSON.stringify({
      current_time: nowIso,
      time_of_day: now.getHours() < 6 ? "凌晨" : now.getHours() < 9 ? "清晨" : now.getHours() < 12 ? "上午" : now.getHours() < 14 ? "中午" : now.getHours() < 17 ? "下午" : now.getHours() < 20 ? "傍晚" : now.getHours() < 23 ? "晚上" : "深夜",
      month: now.getMonth() + 1,
      season: ["冬","冬","春","春","春","夏","夏","夏","秋","秋","秋","冬"][now.getMonth()],
    }, null, 2),
    "",
    "上次记录的状态：",
    JSON.stringify({
      location: state.location || "未知",
      activity: state.activity || "未知",
      awake_state: state.awakeState || "awake",
      current_plan: state.currentPlan || "",
      last_world_event_at: state.lastWorldEventAt || null,
    }, null, 2),
    "",
    "活跃日程 (life_arcs)：",
    activeArcs.length
      ? activeArcs.map(a => `- [${a.kind}] ${a.title} (${a.timeStart || "?"} ~ ${a.timeEnd || "?"}) ${a.summary || ""}`).join("\n")
      : "(无)",
    "",
    "角色profile：", profile,
  ].join("\n");

  // 调用 AI 根据时间上下文推断角色新状态
  const raw = await runHiddenCall(input, {
    label: "time_advance",
    bare: true,
    model: CLAUDE_MAIN_MODEL,
    timeoutMs: 30000,
  });

  // 验证返回值有效性
  if (!raw || typeof raw !== "object") return false;

  // 将模型输出的新状态通过 normalizeWorldState 写回 worldState
  const patch = normalizeWorldState({
    location: raw.location || undefined,
    activity: raw.activity || undefined,
    awakeState: raw.awake_state || undefined,
    currentPlan: raw.current_plan || undefined,
  });
  roleWorld._worldState = normalizeWorldState({
    ...(roleWorld._worldState || {}),
    ...(patch || {}),
    lastWorldEventAt: nowIso,
    updatedAt: nowIso,
  });
  saveRoleWorlds();
  return true;
}

// 调用 AI 生成一个"日常分享种子"主动意图。
// 在角色长期空闲时，模型生成一条自然的生活分享消息（如练琴进展、日常活动等），
// 并设定发送时间窗口和过期时间。
//
// @param {object} params
//   sess - 当前会话对象
//   profile - 角色 profile 名称
// @returns {object|null} 标准化后的候选项意图对象，或 null 表示模型认为不需要分享
async function runDailyShareSeed({ sess, profile }) {
  const cfg = getSceneConfig();
  const roleWorld = getRoleWorld(profile);
  const now = new Date();
  const nowIso = now.toISOString();

  // 构建生成提示词输入：当前时间、位置、活动、清醒状态
  const promptParts = [
    loadPrompts().dailyShareSeedPrompt || "",
    "",
    "当前状态：",
    JSON.stringify({
      current_time: nowIso,
      time_of_day: now.getHours() < 6 ? "凌晨" : now.getHours() < 9 ? "清晨" : now.getHours() < 12 ? "上午" : now.getHours() < 14 ? "中午" : now.getHours() < 17 ? "下午" : now.getHours() < 20 ? "傍晚" : now.getHours() < 23 ? "晚上" : "深夜",
      month: now.getMonth() + 1,
      season: ["冬","冬","春","春","春","夏","夏","夏","秋","秋","秋","冬"][now.getMonth()],
      location: roleWorld._worldState?.location || "未知",
      activity: roleWorld._worldState?.activity || "未知",
      awake_state: roleWorld._worldState?.awakeState || "awake",
      profile: profile,
    }, null, 2),
  ];

  const raw = await runHiddenCall(promptParts.join("\n"), {
    label: "daily_share_seed",
    bare: true,
    model: CLAUDE_MAIN_MODEL,
    timeoutMs: 60000,
    systemPrompt: profileTemplates[profile] || "",
  });

  // 验证返回：必须有 has_share 标记且 message_intent 非空
  if (!raw || typeof raw !== "object") return null;
  if (!raw.has_share || !raw.message_intent) return null;

  // 使用模型给出的时间或回退到默认偏移
  const scheduledAt = raw.scheduled_at || new Date(now.getTime() + cfg.dailyShareDefaultScheduleOffsetMs).toISOString();
  const expiresAt = raw.expires_at || new Date(Date.parse(scheduledAt) + cfg.dailyShareDefaultExpiryOffsetMs).toISOString();

  // 标准化为统一候选项格式
  return normalizeRawProactiveCandidate({
    kind: "daily_share",
    scheduled_at: scheduledAt,
    expires_at: expiresAt,
    message_intent: raw.message_intent,
    basis: raw.basis || "",
    cancel_if: raw.cancel_if || cfg.dailyShareDefaultCancelIf,
  }, {
    nowIso,
    sourceUserText: "",
    defaultKind: "daily_share",
  });
}

// 检查条件是否满足，如果满足则尝试生成一个"日常分享"主动意图。
// 条件包括：距上次种子生成超过间隔、用户空闲足够长时间。
// 如果世界状态已过期，会先推进世界状态再生成。
//
// @param {object} params
//   ai - AI 标识
//   userId - 微信用户 ID
//   sess - 会话对象
//   profile - 角色 profile 名称
// @returns {{changed: boolean, intent: object|null}} changed 指示是否更新了时间戳，intent 是生成的候选项（可能为 null）
async function maybeSeedDailyShareIntent({ ai, userId, sess, profile }) {
  const cfg = getSceneConfig();
  const roleWorld = getRoleWorld(profile);

  const nowMs = Date.now();
  // 检查距上次种子生成是否已过最小间隔
  const lastSeedMs = Date.parse(roleWorld._lastDailyShareSeedAt || "");
  if (Number.isFinite(lastSeedMs) && nowMs - lastSeedMs < cfg.dailyShareSeedIntervalMs) return { changed: false, intent: null };

  // 检查用户是否已空闲足够长时间（最近对话活动时间）
  const lastActivityMs = lastConversationActivityMs(sess);
  if (!lastActivityMs || nowMs - lastActivityMs < cfg.dailyShareMinIdleMs) return { changed: false, intent: null };

  // 记录本次种子生成时间
  const nowIso = new Date(nowMs).toISOString();
  roleWorld._lastDailyShareSeedAt = nowIso;
  sess._lastDailyShareSeedAt = nowIso;

  // 如果 world event 时间戳太旧（超过阈值），先推进世界状态
  const lastEventMs = Date.parse(roleWorld._worldState?.lastWorldEventAt || "");
  if (!Number.isFinite(lastEventMs) || nowMs - lastEventMs >= (cfg.stateStaleThresholdMs || 1800000)) {
    await advanceWorldState({ roleWorld, profile, now: new Date(nowMs) }).catch(() => {});
  }

  saveRoleWorlds();

  // 生成日常分享意图
  const intent = await runDailyShareSeed({ sess, profile });
  return { changed: true, intent };
}

// 从对话内容中提取日程安排候选项（schedule extractor）。
// 模型基于用户消息、AI 回复和内心叙事，识别对话中隐含的日程/约定信息，
// 输出为候选 life_arc 列表供后续确认。
//
// @param {object} params
//   userBody - 用户消息文本
//   scenelet - 内心叙事文本
//   assistantReply - AI 实际发送给用户的回复文本
//   profile - 角色 profile 名称
//   activeSchedules - 当前活跃的日程列表
// @returns {Array} 提取到的候选 life_arc 对象数组
export async function runScheduleExtractor({ userBody, scenelet, assistantReply, profile, activeSchedules }) {
  const arcs = Array.isArray(activeSchedules) ? activeSchedules.filter(a => a.status === "active" && a.kind) : [];
  // 构建提取提示词：提供当前日程、用户消息、AI 回复和内心叙事
  const prompt = [
    loadPrompts().scheduleExtractorPrompt || "",
    "",
    "当前活跃 life_arcs：",
    arcs.length
      ? arcs.map(a => `- [${a.kind}] ${a.title || ""} (id: ${a.id}) ${a.summary || ""}`).join("\n")
      : "(无)",
    "",
    "本轮用户消息：",
    userBody || "",
    "",
    "千圣的实际回复：",
    assistantReply || "",
    "",
    "千圣的内心叙事：",
    scenelet || "",
    "",
    "角色profile：", profile,
  ].join("\n");

  // 调用 AI 提取日程候选项
  const raw = await runHiddenCall(prompt, {
    label: "schedule_extractor",
    bare: true,
    model: CLAUDE_MAIN_MODEL,
    timeoutMs: 45000,
  });

  // 验证返回结构并过滤掉无效候选项
  if (!raw || !Array.isArray(raw.candidates)) return [];
  return raw.candidates.filter(c => c && c.title);
}
// 从待处理候选中确认并创建/更新/关闭日程条目。
// 该函数由 checkProactiveIntents 周期调度触发：模型审阅所有 pending 的日程候选，
// 选择其中一个并决定操作类型（create/update/close），然后将其应用到 lifeArcs。
//
// @param {object} params
//   sess - 当前会话对象
//   profile - 角色 profile 名称
// @returns {boolean} 是否执行了确认检查（无论是否有候选项被应用）
export async function maybeCreateScheduleEntry({ sess, profile }) {
  const cfg = getSceneConfig();
  const roleWorld = getRoleWorld(profile);
  // 当前活跃的日程列表
  const activeSchedules = normalizeLifeArcs(roleWorld._lifeArcs).filter(a => a.kind);
  // 标准化 pending 候选项
  const candidates = normalizeScheduleCandidates(roleWorld._pendingScheduleCandidates || []);
  if (!candidates.length) return false;

  const nowMs = Date.now();
  // 检查距离上次日程确认是否已过最小间隔
  const lastCheckMs = Date.parse(roleWorld._lastScheduleCheckAt || "");
  if (Number.isFinite(lastCheckMs) && nowMs - lastCheckMs < cfg.scheduleCheckIntervalMs) return false;

  // 记录本次检查时间
  const nowIso = new Date(nowMs).toISOString();
  roleWorld._lastScheduleCheckAt = nowIso;
  sess._lastScheduleCheckAt = nowIso;
  saveRoleWorlds();

  // 获取最近 N 种日程类型，用于避免短期内重复同类安排
  const recentKinds = normalizeLifeArcs(roleWorld._lifeArcs, { includeClosed: true })
    .filter(a => a.kind)
    .slice(-cfg.scheduleRecentKindsLimit)
    .map(a => a.kind);

  // 构建日程确认提示词
  const prompt = buildScheduleFinalizationPrompt({
    candidates,
    activeSchedules: activeSchedules.length
      ? activeSchedules.map(a => `- [${a.kind}] ${a.title || ""} (${a.timeStart || "?"} ~ ${a.timeEnd || "?"}) id:${a.id}`).join("\n")
      : "",
    recentKindsHint: recentKinds.length ? `最近曾创建过的日程类型：${[...new Set(recentKinds)].join("、")}。请避免短期内重复同类安排。` : "",
  });

  // 调用 AI 审阅候选项并做出最终决定
  const result = await runHiddenCall(prompt, {
    label: "schedule_finalization",
    bare: false,
    model: CLAUDE_MAIN_MODEL,
    timeoutMs: cfg.scheduleFinalizationTimeoutMs,
  });

  // 模型选择跳过：无候选项被选中，清空待处理列表
  if (!result || result.selected === "none" || Number(result.selected_index ?? -1) < 0) {
    const reason = result?.basis ? String(result.basis).slice(0, cfg.scheduleBasisMaxLength) : "model skipped";
    log("📅", `[${sess.name}] schedule skipped (${candidates.length} candidates dismissed): ${reason}`);
    roleWorld._pendingScheduleCandidates = [];
    roleWorld.updatedAt = new Date().toISOString();
    saveRoleWorlds();
    return true;
  }
  // 确定操作类型（create / update / close）
  const op = ["create", "update", "close"].includes(result.op) ? result.op : "create";
  const arc = result.life_arc;
  if (!arc) return true;
  // create 操作需验证必填字段：title、kind、timeEnd
  if (op === "create") {
    const timeEnd = arc.time_end || arc.timeEnd || null;
    if (!arc.title || !arc.kind || !timeEnd || !Number.isFinite(Date.parse(timeEnd))) return true;
  }
  // update/close 操作需要目标 arc 的 id
  if ((op === "update" || op === "close") && !arc.id) return true;

  const reason = result.basis ? String(result.basis).slice(0, cfg.scheduleBasisMaxLength) : "schedule creator";

  // 执行日程操作
  if (op === "close") {
    // 关闭日程：只需 id 和原因
    applyLifeArcOps(roleWorld, [{ op, id: arc.id, reason }]);
  } else {
    // 创建或更新：构造完整的 life_arc 对象
    const timeEnd = arc.time_end || arc.timeEnd || null;
    const parsedEnd = Date.parse(timeEnd || "");
    const expiresAt = Number.isFinite(parsedEnd)
      ? new Date(parsedEnd + cfg.scheduleExpiryAfterEndBufferMs).toISOString()
      : new Date(nowMs + cfg.scheduleDefaultExpiryFromNowMs).toISOString();

    applyLifeArcOps(roleWorld, [{
      op,
      id: op === "update" ? arc.id : undefined,
      title: String(arc.title || "").slice(0, cfg.scheduleArcTitleMaxLength),
      summary: String(arc.summary || "").slice(0, 500),
      kind: arc.kind,
      subject: arc.subject || null,
      time_start: arc.time_start || arc.timeStart || null,
      time_end: timeEnd,
      expires_at: expiresAt,
      progress_note: arc.progress_note || arc.progressNote || '',
      reason,
    }]);
  }

  // 更新角色状态：移除已处理的候选项，同步并持久化
  roleWorld.updatedAt = new Date().toISOString();
  const selIdx = Number(result.selected_index ?? -1);
  roleWorld._pendingScheduleCandidates = (roleWorld._pendingScheduleCandidates || []).filter((_, i) => i !== selIdx);
  saveRoleWorlds();
  const opLabel = op === "close" ? "closed" : op === "update" ? "updated" : "created";
  log("📅", `[${sess.name}] schedule ${opLabel} [${arc.kind || "?"}] ${arc.title || arc.id || ""}`);
  return true;
}

// 主动意图主调度器：周期性扫描所有活跃会话，检查并执行待处理的主动意图。
// 该函数由外部定时器驱动调用，是整个"角色主动发消息"流程的入口。
// 处理流程：
//   1. 检查日程确认（maybeCreateScheduleEntry）
//   2. 尝试生成日常分享意图（maybeSeedDailyShareIntent）
//   3. 遍历每个 pending 意图，判断是否到发送时间、是否过期、是否超每日限额
//   4. 到时的意图通过 evaluateProactiveIntent 做二次门控
//   5. 门控通过的意图通过 sendFinalAssistantMessage 发送到微信
//   6. 发送后从发送内容中再次提取日程候选项
export async function checkProactiveIntents() {
  const nowMs = Date.now();
  // 控制检查频率，避免过于频繁触发
  if (nowMs - lastProactiveCheckAt < getSceneConfig().proactiveCheckIntervalMs) return;
  lastProactiveCheckAt = nowMs;

  // 遍历所有活跃的 profile 会话
  for (const { ai, userId, sess, profile } of activeProfileSessionEntries()) {
    // 跳过正忙、有排队消息或有待处理输入的会话
    if (sess.busy || sess.queue?.length || pendingInputs.has(userId)) continue;
    let allIntents = normalizeProactiveIntents(sess._proactiveIntents);
    let pending = allIntents.filter(x => x.status === "pending");
    let changed = false;

    // 步骤 1：尝试确认日程候选项
    const scheduleChanged = await maybeCreateScheduleEntry({ sess, profile }).catch(e => {
      log("⚠", `schedule creator fail: ${e.message}`);
      return false;
    });
    if (scheduleChanged) changed = true;

    // 步骤 2：尝试生成日常分享种子意图
    const seeded = await maybeSeedDailyShareIntent({ ai, userId, sess, profile });
    if (seeded.changed) changed = true;
    if (seeded.intent) {
      allIntents = normalizeProactiveIntents([...allIntents, seeded.intent]);
      pending = allIntents.filter(x => x.status === "pending");
    }
    // 无待处理意图则跳过后续处理
    if (!pending.length) {
      if (changed) saveSessions();
      continue;
    }

    // 步骤 3-6：遍历每个 pending 意图
    for (const intent of pending) {
      // 检查 scheduled_at 是否有效
      const scheduled = Date.parse(intent.scheduledAt);
      const expires = intent.expiresAt ? Date.parse(intent.expiresAt) : scheduled + getSceneConfig().proactiveDefaultExpiryOffsetMs;
      if (!Number.isFinite(scheduled)) {
        markProactiveIntent(intent, "cancelled", "invalid scheduled_at");
        changed = true;
        continue;
      }
      // 检查是否已过期
      if (Number.isFinite(expires) && nowMs > expires) {
        markProactiveIntent(intent, "cancelled", "current time exceeded expires_at");
        changed = true;
        continue;
      }
      // 尚未到预定发送时间
      if (nowMs < scheduled) continue;
      // 检查今日主动发送是否已达上限
      if (proactiveSentToday(sess) >= getSceneConfig().proactiveDailyMax) {
        markProactiveIntent(intent, "cancelled", "daily proactive limit reached");
        changed = true;
        continue;
      }
      // 检查冷却时间内是否有其他主动消息刚发送
      if (sess._lastProactiveAt && nowMs - Date.parse(sess._lastProactiveAt) < getSceneConfig().proactiveCooldownMs) continue;

      intent.lastCheckedAt = new Date().toISOString();
      // 防止并发：在开始异步门控评估前先设置 _lastProactiveAt，
      // 这样如果另一个并发检查同时运行，冷却守卫会看到此时间戳并跳过。
      const prevLastProactiveAt = sess._lastProactiveAt;
      sess._lastProactiveAt = new Date().toISOString();
      // 步骤 4：二次门控——AI 判断该意图是否真的应该发送
      const decision = await evaluateProactiveIntent({ ai, userId, sess, profile, intent });
      if (!decision?.shouldSend || !decision.visibleReply) {
        // 门控拒绝：恢复上次主动时间，标记取消
        sess._lastProactiveAt = prevLastProactiveAt;
        markProactiveIntent(intent, "cancelled", decision?.cancelReason || "second check declined");
        changed = true;
        continue;
      }

      // 步骤 5：发送主动消息到微信
      const sent = await sendFinalAssistantMessage(userId, decision.visibleReply, sess._lastContextToken, replyPrefix(sess.name, ai));
      if (!sent) {
        sess._lastProactiveAt = prevLastProactiveAt;
        markProactiveIntent(intent, "cancelled", "send failed");
        changed = true;
        continue;
      }

      // 步骤 6：发送成功后的善后处理
      const sentAt = new Date().toISOString();
      markProactiveIntent(intent, "sent");
      sess._lastProactiveAt = sentAt;
      // 立即持久化意图状态变更，防止并发调用将此意图再次视为 pending
      sess._proactiveIntents = normalizeProactiveIntents(allIntents);
      sess._lastAssistantAt = sentAt;
      const replyBytes = Buffer.byteLength(decision.visibleReply, "utf-8");
      log(">>", `[${sess.name}] ${intent.kind} (${replyBytes}B) "${intent.messageIntent.slice(0, 50)}"`);
      // 追加到可见聊天历史
      appendVisibleHistory(sess, "assistant", decision.visibleReply, "proactive", sentAt);
      // 记录聊天历史事件
      await recordChatHistory({
        ai,
        userId,
        sess,
        role: "assistant",
        kind: "proactive",
        text: decision.visibleReply,
        scenelet: decision.innerScenelet,
        proactiveIntentId: intent.id,
        toolUsage: decision.toolUsage,
        timestamp: sentAt,
      });
      // 从已发送的主动消息中再次提取日程候选项
      try {
        const roleWorld = getRoleWorld(profile);
        const activeSchedules = normalizeLifeArcs(roleWorld._lifeArcs).filter(a => a.status === "active" && a.kind);
        const newCandidates = await runScheduleExtractor({
          userBody: decision.visibleReply,
          scenelet: decision.innerScenelet || "",
          assistantReply: "",
          profile,
          activeSchedules,
        });
        if (newCandidates.length) {
          const existing = roleWorld._pendingScheduleCandidates || [];
          const existingTitles = new Set(existing.map(c => c.title));
          for (const c of newCandidates) {
            if (!existingTitles.has(c.title)) {
              existing.push(c);
              existingTitles.add(c.title);
            }
          }
          roleWorld._pendingScheduleCandidates = existing;
          saveRoleWorlds();
        }
      } catch (e) { log("⚠", `[${sess.name}] extractor fail: ${e.message}`); }

      sess._turnCount = (sess._turnCount || 0) + 1;
      changed = true;
    }

    // 如果有变更，持久化会话状态
    if (changed) {
      sess._proactiveIntents = normalizeProactiveIntents(allIntents);
      saveSessions();
    }
  }
}

// ─── scene memory ───────────────────────────────────────────

// 生成场景记忆摘要（scene memory summary）。
// 在 turn reset（如对话轮次达到阈值）时调用，由 AI 对近期聊天历史、
// inner_scenelet、世界状态和日程信息做总结，输出为一段结构化摘要文本。
// 该摘要在后续 hidden world session 首轮中作为场景记忆注入。
//
// @param {object} params
//   userId - 微信用户 ID
//   sess - 当前会话对象
//   profile - 角色 profile 名称
//   roleWorld - 角色世界状态对象
// @returns {string} 生成的场景记忆摘要文本
export async function generateSceneMemory({ userId, sess, profile, roleWorld }) {
  const allEvents = await loadAllEvents();
  // 筛选当前会话的历史对话事件（当前 sid 即为上次 reset 后分配，天然划定 reset 边界）
  const sessionEvents = allEvents.filter(e => e.userId === userId && e.sessionId === sess.id && e.role && e.text);
  // 从上次 reset 起全部事件，最多 40 轮（assistant 消息 = 1 轮，含 proactive）
  const chatHistory = takeLastRounds(sessionEvents, 40).map(e => ({
    role: e.role === "assistant" ? "assistant" : "user",
    time: e.timestamp || "",
    kind: e.kind || "chat",
    text: e.text,
  }));
  // 取最近 5 条 assistant 消息的 scenelet 供参考
  const recentScenelets = allEvents
    .filter(e => e.userId === userId && e.sessionId === sess.id && e.role === "assistant" && e.scenelet)
    .slice(-5)
    .map(e => e.scenelet);
  const worldState = normalizeWorldState(roleWorld._worldState);
  const lifeArcs = lifeArcPromptItems(roleWorld);
  // 构建场景记忆摘要提示词
  const prompt = buildSceneMemorySummaryPrompt({
    chatHistory,
    recentScenelets,
    worldState,
    lifeArcs,
    profile,
  });
  // 调用 AI 生成摘要
  const raw = await runHiddenCall(prompt, {
    label: "scene_memory",
    bare: true,
    model: CLAUDE_MAIN_MODEL,
    timeoutMs: 240000,
  });
  // 兼容多种返回格式：纯字符串、summary 字段、scene_memory 字段、inner_scenelet 字段
  return typeof raw === "string" ? raw : (raw?.summary || raw?.scene_memory || raw?.inner_scenelet || "");
}

// 批量更新用户记忆文档。
// 在 reset 流程中调用，将本轮所有用户消息合并后一次性写入记忆。
// 仅在记忆功能启用且内容满足写入条件时执行。
//
// @param {object} params
//   userId - 微信用户 ID
//   userMessages - 用户消息文本数组
//   profile - 角色 profile 名称（未直接使用，保留接口一致性）
export async function batchUpdateMemory({ userId, userMessages, profile }) {
  if (!isMemoryEnabled(userId)) return;
  const msgs = (userMessages || []).filter(Boolean);
  if (!msgs.length) return;

  // 合并消息并检查是否满足写入条件（如文本长度阈值）
  const combined = msgs.join("\n---\n");
  if (!shouldRunMemoryWriter(combined)) return;

  // 对比写入前后的文档大小，记录变更
  const before = loadMemoryDocument();
  await updateMemoryDocument(msgs);
  const after = loadMemoryDocument();
  const changed = before !== after;
  if (changed) log("🧠", `memory ${before.length}→${after.length}B`);
}

// 生成消息发送前缀。格式为 "[Label] SessionName"，如 "[CC] 千圣"。
// 用于 checkProactiveIntents 和 processTurn 中的微信消息前缀。
//
// @param {string} sessionName - 会话名称
// @param {string} ai - AI 标识（"cc" 或 "codex"），默认 "cc"
// @returns {string} 格式化的消息前缀
export function replyPrefix(sessionName, ai = "cc") {
  const label = ai === "codex" ? "Codex" : "CC";
  return `[${label}] ${sessionName}`;
}
