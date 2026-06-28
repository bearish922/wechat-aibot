import fs from "node:fs";
import { uuid, log, sleep } from "./utils.mjs";
import { sessions, activeAI, profileTemplates, pendingInputs } from "./state.mjs";
import { SCENELET_BARE, findExactSessionFile } from "./claude-runner.mjs";
import { backendModel, runBackendStructured } from "./backend-adapter.mjs";
import { loadPrompts, MAX_REPLY_LEN, splitText, splitSocialReply, beijingISO } from "./reply.mjs";
import { getSceneConfig, takeLastRounds, normalizeProactiveIntents, normalizeToolUsage, mergeToolUsage, normalizeWorldState, applyWorldStatePatch, normalizeLifeArcs, normalizeSceneletResult, normalizeRawProactiveCandidate, normalizeScheduleCandidates, normalizeProactiveDecision, sanitizeVisibleReplyText, proactiveSentToday, lastConversationActivityMs } from "./normalize.mjs";
import { sessionProfile, roleWorldKey, initializeWorldSession, ensureWorldSession, getRoleWorld, saveRoleWorlds, applyLifeArcOps, lifeArcPromptItems } from "./world-state.mjs";
import { getSceneMemorySystemBlock, buildSceneMemorySummaryPrompt, buildSingleActorSystemPrompt, buildSingleActorDynamicPrompt, hasWeatherKeywords, buildProactivePrompt, buildScheduleFinalizationPrompt, recentVisibleContext, appendVisibleHistory, currentTimeContext } from "./prompts.mjs";
import { isMemoryEnabled, shouldRunMemoryWriter, loadMemoryDocument, updateMemoryDocument } from "./memory.mjs";
import { appendChatEvent, loadAllEvents } from "./chat-history.mjs";
import { sendMessage } from "./wechat.mjs";

// ─── proactive timer ─────────────────────────────────────────
// 上次主动意图检查的时间戳（毫秒），用于控制检查频率
let lastProactiveCheckAt = 0;

// ═══════════ 单 Actor 架构 ═══════════
// generateSingleActorReply —— 单 Actor 模式下的回复生成
// 一次 API 调用同时产出 inner_scenelet 和 visible_reply，消除第二个回复模型造成的信息损失。
// Actor 只负责心理选择与文字表达，不承担状态记账、open thread 维护或主动消息创建。
// 参数中 runtimePolicy.actorVisibleContextTurns 控制每轮注入的可见对话轮数
// 返回：{ innerScenelet, visibleReply, toolUsage, hiddenCall, ragUsage } 或 null
export async function generateSingleActorReply({ ai, userId, sess, profile, userBody, memoryPrompt, ragContext = "", runtimePolicy = {} }) {
  if (!profile || !profileTemplates[profile]) return null;
  const roleWorld = getRoleWorld(profile);
  const world = roleWorld._worldSessions?.[ai]
    ? ensureWorldSession(roleWorld, ai)
    : initializeWorldSession(roleWorld, ai, { reason: "initial Actor session" });
  const cfg = loadPrompts(profile);
  const visibleContextTurns = runtimePolicy.actorVisibleContextTurns || 1;

  // 构建单 Actor system prompt（不含 specialDates/seasonalNotes——这些是 hidden-world 叙事规划字段）
  const sceneMemoryBlock = world.firstTurn || ai === "api" || (world.turnCount || 0) < 15
    ? getSceneMemorySystemBlock(roleWorld, ai, profile)
    : "";
  const systemPrompt = buildSingleActorSystemPrompt(profile, sceneMemoryBlock, memoryPrompt);

  // ① 准备注入数据：完整 worldState + 活跃 life arcs
  const worldState = normalizeWorldState(roleWorld._worldState);
  const lifeArcs = lifeArcPromptItems(roleWorld);

  // ② 天气注入：仅当角色启用天气且用户消息命中天气关键词时才获取实时天气
  //    默认不获取天气——节约 API 调用和 prompt token，
  //    天气获取失败时静默降级（空字符串），不影响主流程
  //    weatherEnabled 角色级开关：cst18 等纯叙事角色关闭以避免现实数据污染内心独白
  let weather = "";
  if (cfg.runtimePolicy.weatherEnabled !== false && hasWeatherKeywords(userBody)) {
    try {
      const { getWeatherReality } = await import("./reply.mjs");
      weather = await getWeatherReality();
    } catch {}
  }

  const prompt = await buildSingleActorDynamicPrompt({
    userId,
    userBody,
    profile,
    visibleContext: recentVisibleContext(sess, visibleContextTurns),
    ragContext,
    worldState,
    lifeArcs,
    worldSession: world,
    weather,
  });

  // ③ 首次尝试：使用持久 session，保留完整 hidden world 上下文
  const sessionName = `hidden-world-${roleWorldKey(profile)}`;
  const firstAttemptWasFirstTurn = world.firstTurn;
  const expectedSid = world.sid;
  const sessionFile = findExactSessionFile(world.sid);
  if (ai === "cc" && !firstAttemptWasFirstTurn && !sessionFile) {
    throw new Error(`CC Actor session ${world.sid} is missing; reset is required before opening a new hidden-world session`);
  }
  let sessionBackup = null;
  if (sessionFile) {
    try { sessionBackup = fs.readFileSync(sessionFile); } catch {}
  }

  const sceneletOnly = cfg.runtimePolicy.visibleReplySource === "scenelet";
  const structuredOptions = {
    backend: ai,
    label: "single_actor",
    bare: SCENELET_BARE,
    persist: true,
    sessionName,
    sessionId: world.sid,
    firstTurn: world.firstTurn,
    model: world.model || backendModel(ai),
    systemPrompt,
    profile,
  };
  let raw = await runBackendStructured(prompt, structuredOptions);
  let result = normalizeSceneletResult(raw);
  const firstAttemptToolUsage = result?.toolUsage;

  const hasValidReply = sceneletOnly
    ? Boolean(result?.innerScenelet)
    : Boolean(result?.innerScenelet && result?.visibleReply);
  if (!hasValidReply) {
    // ④ 重试：恢复 session 文件到调用前的干净状态，然后用同一个 session 重试。
    //    非首轮失败时，--resume 已将空/畸形响应写入 session 文件，先恢复备份再重试。
    //    首轮失败时，--session-id 已创建新文件；删除无效首轮后用同一 SID 重新创建，
    //    避免加载污染历史，也避免相同 SID 再次创建时触发 already in use。
    let retryFirstTurn = firstAttemptWasFirstTurn;
    await sleep(750);
    if (firstAttemptWasFirstTurn) {
      // 只允许删除本次 SID 对应的精确文件，绝不能按同名 session 回退匹配。
      const createdSessionFile = findExactSessionFile(world.sid);
      if (createdSessionFile) {
        try {
          fs.rmSync(createdSessionFile, { force: true });
        } catch { retryFirstTurn = false; }
      }
    } else if (sessionFile && sessionBackup) {
      try { fs.writeFileSync(sessionFile, sessionBackup); } catch {}
    }
    await sleep(250);
    raw = await runBackendStructured(prompt, {
      ...structuredOptions,
      label: "single_actor_retry",
      firstTurn: retryFirstTurn,
    });
    result = normalizeSceneletResult(raw);
    if (result) result.toolUsage = mergeToolUsage(firstAttemptToolUsage, result.toolUsage);
  }
  // 两次调用都无效：回滚到调用前状态，保留同一个 SID，
  // 让失败回合既不污染上下文，也不暗中切换 session。
  if (!result?.innerScenelet || (!sceneletOnly && !result?.visibleReply)) {
    if (firstAttemptWasFirstTurn) {
      const createdSessionFile = findExactSessionFile(world.sid);
      if (createdSessionFile) {
        try { fs.rmSync(createdSessionFile, { force: true }); } catch {}
      }
    } else if (sessionFile && sessionBackup) {
      try { fs.writeFileSync(sessionFile, sessionBackup); } catch {}
    }
    throw new Error(sceneletOnly
      ? "single actor returned no valid inner_scenelet"
      : "single actor returned no valid inner_scenelet and visible_reply");
  }

  // ⑤ 更新 world session 元数据
  //    注意：此处不应用 worldStatePatch——Actor 不负责状态记账。
  //    世界状态的更新由 finalizeTurnSuccess 中的 generateContinuityUpdateForTurn 独立完成，
  //    这样 Actor 始终只面对"当下的世界"，不会因为自身的输出侧效应在下轮看到不一致的状态。
  //    这也意味着 Actor 产生的 inner_scenelet 中的状态暗示不会被持久化，
  //    除非 continuity updater 明确认为这些暗示应该写回 worldState。
  const returnedSid = raw?._hiddenCall?.session_id ? String(raw._hiddenCall.session_id) : "";
  const canAdoptInitialCodexSid = firstAttemptWasFirstTurn && ai === "codex";
  if (returnedSid && returnedSid !== expectedSid && !canAdoptInitialCodexSid) {
    if (firstAttemptWasFirstTurn) {
      const createdSessionFile = findExactSessionFile(returnedSid);
      if (createdSessionFile) {
        try { fs.rmSync(createdSessionFile, { force: true }); } catch {}
      }
    } else if (sessionFile && sessionBackup) {
      try { fs.writeFileSync(sessionFile, sessionBackup); } catch {}
    }
    throw new Error(`Actor backend changed SID unexpectedly (${expectedSid} -> ${returnedSid}); reset is required`);
  }
  if (canAdoptInitialCodexSid && returnedSid) world.sid = returnedSid;
  world.firstTurn = false;
  world.lastUsedAt = beijingISO();
  world.lastUsage = result.hiddenCall || null;
  world.turnCount = (world.turnCount || 0) + 1;
  roleWorld.updatedAt = world.lastUsedAt;
  saveRoleWorlds();
  if (ragContext) result.ragUsage = { eligible: true, used: true, chars: ragContext.length };
  return { ...result, replySource: "single_actor" };
}

// ═══════════ 连续性记账 (continuity update) ═══════════
// generateContinuityUpdateForTurn —— 单 Actor 模式发送成功后的连续性记录
// 在 visible_reply 成功发送后调用。使用独立的非角色 session，只输出结构化记录，
// 不扮演角色，不生成回复文本。
// 参数（解构自对象）：
//   worldState - 当前完整 world state
//   lifeArcs - 当前活跃 life arcs
//   visibleContext - 最近 2 轮可见对话（用于事实核对）
//   userBody - 本轮用户消息文本
//   assistantReply - 实际已发送的回复文本
//   innerScenelet - Actor 生成的第一人称内心叙事
//   profile - 角色标识
// 返回：{ worldStatePatch, openThreadOps, followUpCandidates } 或 null（失败时）
export async function generateContinuityUpdateForTurn({ ai, worldState, lifeArcs, visibleContext, userBody, assistantReply, innerScenelet, profile }) {
  const cfg = loadPrompts(profile);
  const prompt = cfg.continuityUpdatePrompt;
  if (!prompt) return null;

  const now = new Date();
  const timeCtx = currentTimeContext(now);

  try {
    // 输入构造：将 Actor 的产出（inner_scenelet + sent_reply）以及当前世界的完整状态
    // 交给一个非角色的"审计"模型，让它判断本轮对话暗示了哪些世界状态变化
    const input = [
      prompt,
      "",
      "当前时间：",
      JSON.stringify(timeCtx, null, 2),
      "",
      "输入：",
      JSON.stringify({
        profile,
        world_state: worldState,          // 完整世界状态（Actor 只看到投影，continuity 看到全貌）
        active_life_arcs: lifeArcs,       // 当前活跃 life arcs（用于判断是否需要推进或关闭）
        recent_visible_context: visibleContext,   // 最近 2 轮可见对话，用于事实核对
        user_message: userBody,           // 本轮用户消息原文
        sent_reply: assistantReply,      // 实际已发送的回复文本——不可撤回，只能基于它做后续
        inner_scenelet: innerScenelet,   // Actor 的第一人称内心叙事，用于推断隐含的状态变化
      }, null, 2),
    ].join("\n");

    // ═══ 独立 session 模式 ═══
    // persist 未设置（默认 false），不关联任何角色 session。
    // 这意味着每次 continuity update 都是无上下文的独立调用。
    // 这样做是有意的：continuity updater 的职责是"基于本轮事实做增量判断"，
    // 它不需要记住上一轮的状态（worldState 已经是累积结果）。
    // 使用独立 session 还避免了角色 session 被非角色的系统级 prompt 污染。
    const raw = await runBackendStructured(input, {
      backend: ai,
      label: "continuity_update",
      bare: true,
      model: backendModel(ai),
      timeoutMs: 30000,
      profile,
      // 不使用持久角色 session——continuity updater 不扮演角色
    });

    if (!raw || typeof raw !== "object") return null;
    // 返回结构化输出：
    //   world_state_patch —— 需要写入 worldState 的增量字段
    //   open_thread_ops    —— open thread 的增删操作列表
    //   follow_up_candidates —— 从本轮对话中识别到的潜在主动消息候选
    //   life_arc_updates   —— 本轮对话推进了进展的 life_arc 的 progress_note 更新
    return {
      worldStatePatch: raw.world_state_patch || null,
      openThreadOps: Array.isArray(raw.open_thread_ops) ? raw.open_thread_ops : [],
      followUpCandidates: Array.isArray(raw.follow_up_candidates) ? raw.follow_up_candidates : [],
      lifeArcUpdates: Array.isArray(raw.life_arc_updates) ? raw.life_arc_updates : [],
    };
  } catch (e) {
    // ═══ 失败策略：不回滚 ═══
    // continuity update 失败时，只记录警告日志并返回 null。
    // 不影响已发送的消息——消息已经到达用户，撤回只会造成更差的体验。
    // worldState 保持本轮之前的状态，这意味着下轮 Actor 面对的世界状态
    // 可能略微落后于实际对话进展，但这比错误地写入不完整/不准确的状态要好。
    log("⚠", `continuity update fail: ${e.message}`);
    return null;
  }
}

// 构建"场景上下文块"：将 lifeArc 摘要和 inner_scenelet 拼接为一段结构化的上下文文本，
// 将 scenelet 生成的 follow_up 候选追加到会话的主动意图列表中。
// 每轮最多取 1 条，去重由 scenelet prompt 中 pending_proactive_intents 保证。
export async function addFollowUpCandidates(sess, sceneletResult, userBody, roleWorld) {
  if (!sceneletResult?.followUpCandidates?.length) return;
  if (!roleWorld) return;
  const nowIso = beijingISO();
  const existing = normalizeProactiveIntents(roleWorld._proactiveIntents);
  for (const raw of sceneletResult.followUpCandidates.slice(0, 1)) {
    const candidate = normalizeRawProactiveCandidate(raw, {
      nowIso,
      sourceUserText: userBody,
      defaultKind: "follow_up",
    });
    if (!candidate) continue;
    existing.push(candidate);
  }
  roleWorld._proactiveIntents = normalizeProactiveIntents(existing);
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
export async function recordChatHistory({ ai, userId, sess, role, kind = "chat", text, scenelet = "", sceneletStatus = "", sceneletError = "", proactiveIntentId = "", toolUsage = null, ragUsage = null, timestamp = beijingISO() }) {
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
export async function sendFinalAssistantMessage(userId, text, contextToken, prefix, skipSanitize = false) {
  const trimmed = skipSanitize ? text.trim() : sanitizeVisibleReplyText(text).trim();
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
    if (ai !== activeAI) continue;
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
  if (status === "sent") intent.sentAt = beijingISO();
  if (status === "cancelled") intent.cancelledAt = beijingISO();
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
  const raw = await runBackendStructured(prompt, { backend: ai, label: "proactive", profile });
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
async function advanceWorldState({ ai, roleWorld, profile, now }) {
  const cfg = getSceneConfig();
  const prompt = loadPrompts(profile).timeAdvancementPrompt;
  // 未配置时间推进提示词模板则跳过
  if (!prompt) return false;

  const nowIso = beijingISO(now);
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
  const raw = await runBackendStructured(input, {
    backend: ai,
    label: "time_advance",
    bare: true,
    model: backendModel(ai),
    timeoutMs: 30000,
    profile,
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
async function runDailyShareSeed({ ai, sess, profile }) {
  const cfg = getSceneConfig();
  const roleWorld = getRoleWorld(profile);
  const now = new Date();
  const nowIso = beijingISO(now);

  // 获取实时天气（失败时静默降级）
  let weather = "";
  try {
    const { getWeatherReality } = await import("./reply.mjs");
    weather = await getWeatherReality();
  } catch {}

  // 构建生成提示词输入：当前时间、位置、活动、清醒状态、天气
  const promptParts = [
    loadPrompts(profile).dailyShareSeedPrompt || "",
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
      weather: weather || null,
    }, null, 2),
  ];

  // 注入最近几次已发送 daily share 的风格，帮助模型切换风格
  const recentIntents = (roleWorld._proactiveIntents || [])
    .filter(p => p.status === "sent" && p.kind === "daily_share" && p.message_intent)
    .sort((a, b) => (new Date(b.sentAt || 0)) - (new Date(a.sentAt || 0)))
    .slice(0, 3)
    .map(p => p.message_intent);
  if (recentIntents.length) {
    promptParts.push(
      "",
      "最近几次分享的风格：",
      ...recentIntents.map(i => `- ${i}`),
      "请在风格上与上述有所区分，避免连续同一种情绪走向（尤其是抱怨/不耐烦类的连续出现）。",
    );
  }

  const raw = await runBackendStructured(promptParts.join("\n"), {
    backend: ai,
    label: "daily_share_seed",
    bare: true,
    model: backendModel(ai),
    timeoutMs: 60000,
    systemPrompt: profileTemplates[profile] || "",
    profile,
  });

  // 验证返回：必须有 has_share 标记且 message_intent 非空
  if (!raw || typeof raw !== "object") return null;
  if (!raw.has_share || !raw.message_intent) return null;

  // 使用模型给出的时间或回退到默认偏移
  const scheduledAt = raw.scheduled_at || beijingISO(new Date(now.getTime() + cfg.dailyShareDefaultScheduleOffsetMs));
  const expiresAt = raw.expires_at || beijingISO(new Date(Date.parse(scheduledAt) + cfg.dailyShareDefaultExpiryOffsetMs));

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
  const nowIso = beijingISO(new Date(nowMs));
  roleWorld._lastDailyShareSeedAt = nowIso;
  sess._lastDailyShareSeedAt = nowIso;

  // 如果 world event 时间戳太旧（超过阈值），先推进世界状态
  const lastEventMs = Date.parse(roleWorld._worldState?.lastWorldEventAt || "");
  if (!Number.isFinite(lastEventMs) || nowMs - lastEventMs >= (cfg.stateStaleThresholdMs || 1800000)) {
    await advanceWorldState({ ai, roleWorld, profile, now: new Date(nowMs) }).catch(() => {});
  }

  saveRoleWorlds();

  // 生成日常分享意图
  const intent = await runDailyShareSeed({ ai, sess, profile });
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
export async function runScheduleExtractor({ ai, userBody, scenelet, assistantReply, profile, activeSchedules }) {
  if (!loadPrompts(profile).runtimePolicy.lifeArcEnabled) return [];
  const arcs = Array.isArray(activeSchedules) ? activeSchedules.filter(a => a.status === "active" && a.kind) : [];
  // 构建提取提示词：提供当前日程、用户消息、AI 回复和内心叙事
  const prompt = [
    loadPrompts(profile).scheduleExtractorPrompt || "",
    "",
    "当前活跃 life_arcs：",
    arcs.length
      ? arcs.map(a => `- [${a.kind}] ${a.title || ""} (id: ${a.id}) ${a.summary || ""}`).join("\n")
      : "(无)",
    "",
    "本轮用户消息：",
    userBody || "",
    "",
    `${profile || "角色"}的实际回复：`,
    assistantReply || "",
    "",
    `${profile || "角色"}的内心叙事：`,
    scenelet || "",
    "",
    "角色profile：", profile,
  ].join("\n");

  // 调用 AI 提取日程候选项
  const raw = await runBackendStructured(prompt, {
    backend: ai,
    label: "schedule_extractor",
    bare: true,
    model: backendModel(ai),
    timeoutMs: 60000,
    profile,
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
export async function maybeCreateScheduleEntry({ ai, sess, profile }) {
  if (!loadPrompts(profile).runtimePolicy.lifeArcEnabled) return false;
  const cfg = getSceneConfig();
  const roleWorld = getRoleWorld(profile);
  // 当前活跃的日程列表
  const activeSchedules = normalizeLifeArcs(roleWorld._lifeArcs).filter(a => a.kind);
  // 标准化 pending 候选项
  const candidates = normalizeScheduleCandidates(roleWorld._pendingScheduleCandidates || []);
  if (!candidates.length) return false;
  // 后续 selected_index 以这份规范化数组为准；先回写可避免原始无效项造成索引错位。
  roleWorld._pendingScheduleCandidates = candidates;

  const nowMs = Date.now();
  // 检查距离上次日程确认是否已过最小间隔
  const lastCheckMs = Date.parse(roleWorld._lastScheduleCheckAt || "");
  if (Number.isFinite(lastCheckMs) && nowMs - lastCheckMs < cfg.scheduleCheckIntervalMs) return false;

  // 记录本次检查时间
  const nowIso = beijingISO(new Date(nowMs));
  roleWorld._lastScheduleCheckAt = nowIso;
  saveRoleWorlds();

  // 获取最近 N 种日程类型，用于避免短期内重复同类安排
  const recentKinds = normalizeLifeArcs(roleWorld._lifeArcs, { includeClosed: true })
    .filter(a => a.kind)
    .slice(-cfg.scheduleRecentKindsLimit)
    .map(a => a.kind);

  // 构建日程确认提示词
  const prompt = buildScheduleFinalizationPrompt({
    profile,
    candidates,
    activeSchedules: activeSchedules.length
      ? activeSchedules.map(a => `- [${a.kind}] ${a.title || ""} (${a.timeStart || "?"} ~ ${a.timeEnd || "?"}) id:${a.id}`).join("\n")
      : "",
    recentKindsHint: recentKinds.length ? `最近曾创建过的日程类型：${[...new Set(recentKinds)].join("、")}。请避免短期内重复同类安排。` : "",
  });

  // 调用 AI 审阅候选项并做出最终决定
  const result = await runBackendStructured(prompt, {
    backend: ai,
    label: "schedule_finalization",
    bare: false,
    model: backendModel(ai),
    timeoutMs: cfg.scheduleFinalizationTimeoutMs,
    profile,
  });

  // 模型选择跳过：无候选项被选中，清空待处理列表
  if (!result || result.selected === "none" || Number(result.selected_index ?? -1) < 0) {
    const reason = result?.basis ? String(result.basis).slice(0, cfg.scheduleBasisMaxLength) : "model skipped";
    log("📅", `[${sess.name}] schedule skipped (${candidates.length} candidates dismissed): ${reason}`);
    roleWorld._pendingScheduleCandidates = [];
    roleWorld.updatedAt = beijingISO();
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
      ? beijingISO(new Date(parsedEnd + cfg.scheduleExpiryAfterEndBufferMs))
      : beijingISO(new Date(nowMs + cfg.scheduleDefaultExpiryFromNowMs));

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
  roleWorld.updatedAt = beijingISO();
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
    // 角色级开关：runtimePolicy.proactiveEnabled === false 时跳过主动消息
    if (loadPrompts(profile).runtimePolicy.proactiveEnabled === false) continue;
    const roleWorld = getRoleWorld(profile);
    let allIntents = normalizeProactiveIntents(roleWorld._proactiveIntents);
    let pending = allIntents.filter(x => x.status === "pending");
    let changed = false;

    // 步骤 1：尝试确认日程候选项
    const scheduleChanged = await maybeCreateScheduleEntry({ ai, sess, profile }).catch(e => {
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
      if (changed) { roleWorld._proactiveIntents = normalizeProactiveIntents(allIntents); saveRoleWorlds(); }
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
      if (proactiveSentToday(roleWorld) >= getSceneConfig().proactiveDailyMax) {
        markProactiveIntent(intent, "cancelled", "daily proactive limit reached");
        changed = true;
        continue;
      }
      // 检查冷却时间内是否有其他主动消息刚发送
      if (roleWorld._lastProactiveAt && nowMs - Date.parse(roleWorld._lastProactiveAt) < getSceneConfig().proactiveCooldownMs) continue;

      intent.lastCheckedAt = beijingISO();
      // 防止并发：在开始异步门控评估前先设置 _lastProactiveAt，
      // 这样如果另一个并发检查同时运行，冷却守卫会看到此时间戳并跳过。
      const prevLastProactiveAt = roleWorld._lastProactiveAt;
      roleWorld._lastProactiveAt = beijingISO();
      // 步骤 4：二次门控——AI 判断该意图是否真的应该发送
      const decision = await evaluateProactiveIntent({ ai, userId, sess, profile, intent });
      if (!decision?.shouldSend || !decision.visibleReply) {
        // 门控拒绝：恢复上次主动时间，标记取消
        roleWorld._lastProactiveAt = prevLastProactiveAt;
        markProactiveIntent(intent, "cancelled", decision?.cancelReason || "second check declined");
        changed = true;
        continue;
      }

      // 步骤 5：发送主动消息到微信
      const sent = await sendFinalAssistantMessage(userId, decision.visibleReply, sess._lastContextToken, replyPrefix(sess.name, ai));
      if (!sent) {
        // sendMessage 有 3 次重试，返回 false 时消息可能已送达微信
        // 仍写入 visibleHistory 和 DB，确保 bot 后续轮次能感知到
        const failAt = beijingISO();
        sess._lastAssistantAt = failAt;
        appendVisibleHistory(sess, "assistant", decision.visibleReply, "proactive", failAt);
        try {
          await recordChatHistory({
            ai, userId, sess,
            role: "assistant", kind: "proactive",
            text: decision.visibleReply,
            scenelet: decision.innerScenelet || "",
            proactiveIntentId: intent.id,
            toolUsage: decision.toolUsage,
            timestamp: failAt,
          });
        } catch (e) { log("⚠", `[${sess.name}] record proactive history fail: ${e.message}`); }
        // 不回滚 _lastProactiveAt：消息可能已送达，保持冷却避免连发
        markProactiveIntent(intent, "cancelled", "send failed (delivery uncertain, context preserved)");
        changed = true;
        continue;
      }

      // 步骤 6：发送成功后的善后处理
      const sentAt = beijingISO();
      markProactiveIntent(intent, "sent");
      roleWorld._lastProactiveAt = sentAt;
      // 立即持久化意图状态变更，防止并发调用将此意图再次视为 pending
      roleWorld._proactiveIntents = normalizeProactiveIntents(allIntents);
      sess._lastAssistantAt = sentAt;
      const replyBytes = Buffer.byteLength(decision.visibleReply, "utf-8");
      log(">>", `[${sess.name}] ${intent.kind} (${replyBytes}B) "${intent.messageIntent.slice(0, 50)}"`);
      // 追加到可见聊天历史
      appendVisibleHistory(sess, "assistant", decision.visibleReply, "proactive", sentAt);
      // 记录聊天历史事件
      try {
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
      } catch (e) { log("⚠", `[${sess.name}] record proactive history fail: ${e.message}`); }
      // 从已发送的主动消息中再次提取日程候选项
      try {
        const activeSchedules = normalizeLifeArcs(roleWorld._lifeArcs).filter(a => a.status === "active" && a.kind);
        const newCandidates = await runScheduleExtractor({
          ai,
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

    // 如果有变更，持久化到角色世界
    if (changed) {
      roleWorld._proactiveIntents = normalizeProactiveIntents(allIntents);
      saveRoleWorlds();
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
export async function generateSceneMemory({ ai, userId, sess, profile, roleWorld, maxTurns, since = "" }) {
  const allEvents = await loadAllEvents();
  // 场景记忆按 user + profile 聚合，允许同一角色的多个会话共享连续性。
  const sessionEvents = allEvents.filter(e => e.userId === userId && e.profile === profile && e.role && e.text);
  const limit = maxTurns || 40;
  const sinceMs = Date.parse(since || "");
  const scopedEvents = Number.isFinite(sinceMs)
    ? sessionEvents.filter(e => {
        const eventMs = Date.parse(e.timestamp || "");
        return Number.isFinite(eventMs) && eventMs >= sinceMs;
      })
    : [];
  const memoryEvents = scopedEvents.length ? scopedEvents : takeLastRounds(sessionEvents, limit);
  const chatHistory = memoryEvents.map(e => ({
    role: e.role === "assistant" ? "assistant" : "user",
    time: e.timestamp || "",
    kind: e.kind || "chat",
    text: e.text,
  }));
  // scenelet 必须与可见历史使用同一 reset 区间，不能混入上个 session，
  // 也不能只截最后几条而漏掉本区间早期的隐形状态。
  const recentScenelets = memoryEvents
    .filter(e => e.role === "assistant" && e.scenelet)
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
  const raw = await runBackendStructured(prompt, {
    backend: ai,
    label: "scene_memory",
    bare: true,
    model: backendModel(ai),
    timeoutMs: 240000,
    profile,
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
export async function batchUpdateMemory({ ai, userId, userMessages, profile }) {
  if (!isMemoryEnabled(userId)) return;
  const msgs = (userMessages || []).filter(Boolean);
  if (!msgs.length) return;

  // 合并消息并检查是否满足写入条件（如文本长度阈值）
  const combined = msgs.join("\n---\n");
  if (!shouldRunMemoryWriter(combined)) return;

  // 对比写入前后的文档大小，记录变更
  const before = loadMemoryDocument(profile);
  await updateMemoryDocument(msgs, ai, profile);
  const after = loadMemoryDocument(profile);
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
  const label = ai === "codex" ? "Codex" : ai === "api" ? "API" : "CC";
  return `[${label}] ${sessionName}`;
}
