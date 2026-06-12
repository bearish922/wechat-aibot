import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { loadPrompts } from "./reply.mjs";

import { dataPath } from "./paths.mjs";

// 从 data/config.json 加载用户配置，文件不存在或解析失败返回空对象
function loadConfig() {
  const configPath = dataPath("config.json");
  if (!existsSync(configPath)) return {};
  try { return JSON.parse(readFileSync(configPath, "utf-8")); } catch { return {}; }
}

// 从 prompts.json 和 config.json 聚合生成场景全局配置对象
// 返回: 包含所有场景参数的对象(可见上下文轮数、主动消息间隔、RAG 参数、日程配置等)
function getSceneConfig() {
  const p = loadPrompts();
  const c = loadConfig();
  return {
    // 可见对话历史的最大轮数（每轮=user+assistant各一条）
    visibleContextTurns: p.visibleContextTurns,
    // 回合计数器阈值，达到后触发场景重置 + 记忆批量更新
    turnResetThreshold: p.turnResetThreshold,
    // 主动消息检查间隔（毫秒），定时扫描是否有待发送的主动消息
    proactiveCheckIntervalMs: p.proactiveCheckIntervalMs,
    // 主动消息冷却时间（毫秒），上次发送后多久内不再次发送
    proactiveCooldownMs: p.proactiveCooldownMs,
    // 每日主动消息上限（自然日）
    proactiveDailyMax: p.proactiveDailyMax,
    // 每日分享种子生成间隔（毫秒），每隔多久生成一次日常分享候选
    dailyShareSeedIntervalMs: p.dailyShareSeedIntervalMs,
    // 每日分享最小空闲时间（毫秒），用户持续不活跃多久后才考虑发送
    dailyShareMinIdleMs: p.dailyShareMinIdleMs,
    // 日程检查间隔（毫秒），默认24小时
    scheduleCheckIntervalMs: p.scheduleCheckIntervalMs,
    // RAG 记忆检索 top-K 条数
    ragTopK: p.ragTopK,
    // RAG 记忆检索最低相似度分数阈值
    ragMinScore: p.ragMinScore,
    // RAG 单条结果最大字符数
    ragResultMaxChars: p.ragResultMaxChars,
    // RAG 检索调用超时（毫秒）
    ragTimeoutMs: p.ragTimeoutMs,
    // 隐藏世界同时最多维护的 pending intent 数量
    hiddenWorldMaxPendingIntents: p.hiddenWorldMaxPendingIntents,
    // 每日分享候选的默认调度偏移（毫秒），距 seed 生成后多久触发
    dailyShareDefaultScheduleOffsetMs: p.dailyShareDefaultScheduleOffsetMs,
    // 每日分享候选的默认过期偏移（毫秒），到期未发送则作废
    dailyShareDefaultExpiryOffsetMs: p.dailyShareDefaultExpiryOffsetMs,
    // 每日分享默认取消条件列表（自然语言描述）
    dailyShareDefaultCancelIf: p.dailyShareDefaultCancelIf,
    // 主动消息默认过期偏移（毫秒），到期未发送则作废
    proactiveDefaultExpiryOffsetMs: p.proactiveDefaultExpiryOffsetMs,
    // 日程最终确认超时（毫秒），超时未确认的日程候选丢弃
    scheduleFinalizationTimeoutMs: p.scheduleFinalizationTimeoutMs,
    // 近期日程种类去重窗口（条数），同种类不会重复创建
    scheduleRecentKindsLimit: p.scheduleRecentKindsLimit,
    // 日程候选依据文本最大长度
    scheduleBasisMaxLength: p.scheduleBasisMaxLength,
    // 日程弧线标题最大长度
    scheduleArcTitleMaxLength: p.scheduleArcTitleMaxLength,
    // 日程结束后的过期缓冲时间（毫秒），避免刚结束就被清理
    scheduleExpiryAfterEndBufferMs: p.scheduleExpiryAfterEndBufferMs,
    // 日程从创建到默认过期的时间（毫秒），默认3天
    scheduleDefaultExpiryFromNowMs: p.scheduleDefaultExpiryFromNowMs,
    // 消息分块发送间隔（毫秒），优先 config.json
    chunkSendDelayMs: c.send?.chunkSendDelayMs ?? p.chunkSendDelayMs,
    // 取消原因最大长度（字符），优先 config.json
    maxCancelReasonLength: c.send?.maxCancelReasonLength ?? p.maxCancelReasonLength,
    // 状态过期阈值（毫秒），超时未更新的世界状态视为过期
    stateStaleThresholdMs: p.stateStaleThresholdMs,
  };
}

// 规范化失败的对话轮次记录
// 参数: raw - 原始失败轮次对象(必须有 body 字段)
// 返回: 规范化后的失败轮次对象，或 null
function normalizeFailedTurn(raw) {
  if (!raw?.body) return null;
  return {
    body: String(raw.body),
    timestamp: raw.timestamp ? String(raw.timestamp) : null,
    // 失败原因上限 500 字符
    reason: raw.reason ? String(raw.reason).slice(0, 500) : "",
    sid: raw.sid ? String(raw.sid) : null,
  };
}

// takeLastRounds —— 从事件数组末尾向前取最近的 maxRounds 轮对话。
// 计数规则：assistant 消息计 1 轮（正常 user+assistant 配对 + proactive 均适用）；
// user 消息本身不计（由配对的 assistant 覆盖）。
// 参数: events - 事件数组（需含 role 字段）；maxRounds - 最大轮数
// 返回: 截取后的事件子数组
export function takeLastRounds(events, maxRounds) {
  if (!Array.isArray(events) || !events.length) return [];
  let rounds = 0;
  const result = [];
  for (let i = events.length - 1; i >= 0; i--) {
    result.unshift(events[i]);
    if (events[i]?.role === "assistant") rounds++;
    if (rounds >= maxRounds) break;
  }
  return result;
}

// 规范化用户可见的对话历史列表，截断到配置的轮数并限制每条文本长度
// 参数: raw - 原始历史数组
// 返回: 规范化后的历史条目数组(最多 visibleContextTurns 轮，每条文本上限 4000 字符)
function normalizeVisibleHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const normalized = raw
    // 过滤掉缺少 role 或 text 的无效条目
    .filter(item => item?.role && item?.text)
    .map(item => ({
      role: item.role === "assistant" ? "assistant" : "user",
      text: String(item.text).slice(0, 4000),
      timestamp: item.timestamp ? String(item.timestamp) : null,
      kind: item.kind ? String(item.kind) : "chat",
    }));
  // 按轮次截取（assistant 消息计 1 轮，含 proactive）
  return takeLastRounds(normalized, getSceneConfig().visibleContextTurns);
}

// 规范化单条主动消息意图(proactive intent)
// 参数: raw - 原始意图对象(必须有 id 和 scheduledAt)
// 返回: 规范化后的意图对象，字段缺失时填充默认值，各文本字段有长度上限
function normalizeProactiveIntent(raw) {
  // 如果没有 id 或调度时间，视为无效
  if (!raw?.id || !raw?.scheduledAt) return null;
  return {
    id: String(raw.id),
    // 状态只允许 pending/sent/cancelled，默认 pending
    status: ["pending", "sent", "cancelled"].includes(raw.status) ? raw.status : "pending",
    createdAt: raw.createdAt ? String(raw.createdAt) : new Date().toISOString(),
    scheduledAt: String(raw.scheduledAt),
    expiresAt: raw.expiresAt ? String(raw.expiresAt) : null,
    sourceTurnAt: raw.sourceTurnAt ? String(raw.sourceTurnAt) : null,
    // 源用户文本上限 500 字符
    sourceUserText: raw.sourceUserText ? String(raw.sourceUserText).slice(0, 500) : "",
    // 意图依据上限 800 字符
    basis: raw.basis ? String(raw.basis).slice(0, 800) : "",
    // 取消条件列表，每项上限 200 字符，最多 8 项
    cancelIf: Array.isArray(raw.cancelIf) ? raw.cancelIf.map(x => String(x).slice(0, 200)).slice(0, 8) : [],
    // 消息意图描述上限 500 字符
    messageIntent: raw.messageIntent ? String(raw.messageIntent).slice(0, 500) : "",
    // 类型只允许 follow_up 或 daily_share，默认 follow_up
    kind: ["follow_up", "daily_share"].includes(raw.kind) ? raw.kind : "follow_up",
    lastCheckedAt: raw.lastCheckedAt ? String(raw.lastCheckedAt) : null,
    sentAt: raw.sentAt ? String(raw.sentAt) : null,
    cancelledAt: raw.cancelledAt ? String(raw.cancelledAt) : null,
    // 取消原因上限 500 字符
    cancelReason: raw.cancelReason ? String(raw.cancelReason).slice(0, 500) : "",
  };
}

// 规范化主动消息意图数组：逐条规范化 -> 按 id 去重合并 -> 按时间排序
// pending 保留最近 20 条，sent/cancelled 不设上限
function normalizeProactiveIntents(raw) {
  if (!Array.isArray(raw)) return [];
  const byId = new Map();
  for (const intent of raw.map(normalizeProactiveIntent).filter(Boolean)) {
    byId.set(intent.id, { ...byId.get(intent.id), ...intent });
  }
  const sorted = [...byId.values()]
    .sort((a, b) => Date.parse(a.createdAt || a.scheduledAt || 0) - Date.parse(b.createdAt || b.scheduledAt || 0));
  const pending = sorted.filter(i => i.status === "pending").slice(-20);
  const rest = sorted.filter(i => i.status !== "pending");
  return [...rest, ...pending].sort((a, b) => Date.parse(a.createdAt || a.scheduledAt || 0) - Date.parse(b.createdAt || b.scheduledAt || 0));
}

// 创建空的工具使用统计对象
function emptyToolUsage() {
  return { webSearch: 0, webFetch: 0, tools: [] };
}

// 规范化工具使用统计对象，兼容 snake_case 和 camelCase 字段名
// 参数: raw - 原始工具使用统计对象
// 返回: 规范化后的统计对象，或 null
function normalizeToolUsage(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  // 工具列表去重并过滤空值
  const tools = Array.isArray(raw.tools)
    ? [...new Set(raw.tools.map(x => String(x || "").trim()).filter(Boolean))]
    : [];
  return {
    // 兼容 webSearch 和 web_search_requests 字段名
    webSearch: Math.max(0, Number(raw.webSearch || raw.web_search_requests || 0) || 0),
    webFetch: Math.max(0, Number(raw.webFetch || raw.web_fetch_requests || 0) || 0),
    tools,
  };
}

function mergeToolUsage(...items) {
  const merged = emptyToolUsage();
  for (const item of items) {
    const usage = normalizeToolUsage(item);
    if (!usage) continue;
    merged.webSearch += usage.webSearch;
    merged.webFetch += usage.webFetch;
    for (const tool of usage.tools) {
      if (!merged.tools.includes(tool)) merged.tools.push(tool);
    }
  }
  return merged;
}

// 创建空的世界状态对象(所有字段为默认空值)
function emptyWorldState() {
  return {
    location: "",
    activity: "",
    awakeState: "",
    currentPlan: "",
    openThreads: [],
    lastWorldEventAt: null,
    updatedAt: null,
  };
}

// 规范化角色世界状态对象，兼容 snake_case 字段名，各文本字段有长度上限
// 参数: raw - 原始世界状态对象
// 返回: 规范化后的世界状态对象；如果所有字段都为空则返回 null
function normalizeWorldState(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  // 开放线程列表：去重、过滤空值、上限 8 条
  const openThreads = Array.isArray(raw.openThreads || raw.open_threads)
    ? (raw.openThreads || raw.open_threads).map(x => String(x || "").trim()).filter(Boolean).slice(0, 8)
    : [];
  const state = {
    // 位置上限 160 字符
    location: raw.location ? String(raw.location).slice(0, 160) : "",
    // 活动上限 200 字符
    activity: raw.activity ? String(raw.activity).slice(0, 200) : "",
    // 清醒状态上限 80 字符
    awakeState: raw.awakeState || raw.awake_state ? String(raw.awakeState || raw.awake_state).slice(0, 80) : "",
    // 当前计划上限 300 字符
    currentPlan: raw.currentPlan || raw.current_plan ? String(raw.currentPlan || raw.current_plan).slice(0, 300) : "",
    openThreads,
    lastWorldEventAt: raw.lastWorldEventAt || raw.last_world_event_at ? String(raw.lastWorldEventAt || raw.last_world_event_at) : null,
    updatedAt: raw.updatedAt || raw.updated_at ? String(raw.updatedAt || raw.updated_at) : null,
  };
  // 如果所有值都为空且无线程则返回 null
  return Object.values(state).some(Boolean) || openThreads.length ? state : null;
}

// 将世界状态补丁合并到 session 的当前世界状态中(非空字段覆盖)
// 参数: sess - session 对象; rawPatch - 世界状态补丁对象
function applyWorldStatePatch(roleWorld, rawPatch = null) {
  if (!roleWorld || !rawPatch || typeof rawPatch !== "object") return;
  // 获取当前世界状态，缺失时使用空状态
  const current = normalizeWorldState(roleWorld._worldState) || emptyWorldState();
  const patch = normalizeWorldState(rawPatch);
  if (!patch) return;
  // 合并当前状态与补丁，只覆盖有实际值的字段(过滤 null、空字符串、空数组)
  roleWorld._worldState = normalizeWorldState({
    ...current,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => {
      if (Array.isArray(v)) return v.length;
      return v !== null && v !== "";
    })),
    // 记录补丁应用时间
    updatedAt: new Date().toISOString(),
  });
}

// 规范化世界会话对象，设置默认 model 及各字段上限
// 参数: raw - 原始世界会话对象
// 返回: 规范化后的世界会话对象，或 null
function normalizeWorldSession(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  return {
    sid: raw.sid ? String(raw.sid) : null,
    firstTurn: raw.firstTurn === true,
    model: raw.model ? String(raw.model) : "",
    startedAt: raw.startedAt ? String(raw.startedAt) : null,
    lastUsedAt: raw.lastUsedAt ? String(raw.lastUsedAt) : null,
    // 重置原因上限 300 字符
    resetReason: raw.resetReason ? String(raw.resetReason).slice(0, 300) : "",
    lastUsage: raw.lastUsage && typeof raw.lastUsage === "object" ? raw.lastUsage : null,
    turnCount: Math.max(0, Number(raw.turnCount || 0) || 0),
  };
}

// 规范化单条生活弧线(life arc)记录，校验数据类型、截断文本、填充默认值
// 参数: raw - 原始弧线对象(必须有 id、title、summary，progressNote 可为空)
// 返回: 规范化后的弧线对象，或 null
function normalizeLifeArc(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = raw.id ? String(raw.id) : "";
  // 各文本字段截断到配置上限
  const title = raw.title ? String(raw.title).trim().slice(0, 80) : "";
  const summary = raw.summary ? String(raw.summary).trim().slice(0, 500) : "";
  const progressNote = raw.progressNote || raw.progress_note ? String(raw.progressNote || raw.progress_note).trim().slice(0, 500) : "";
  // 必须有 id、标题和摘要，进展备注允许为空
  if (!id || !title || !summary) return null;
  const nowIso = new Date().toISOString();
  // 状态只允许 active/closed
  const status = ["active", "closed"].includes(raw.status) ? raw.status : "active";
  const createdAt = raw.createdAt || raw.created_at ? String(raw.createdAt || raw.created_at) : nowIso;
  const updatedAt = raw.updatedAt || raw.updated_at ? String(raw.updatedAt || raw.updated_at) : createdAt;
  // 过期时间：优先用原始值，否则用配置的默认过期偏移(从当前时间算)
  const defaultExpiresAt = new Date(Date.now() + getSceneConfig().scheduleDefaultExpiryFromNowMs).toISOString();
  const rawExpiresAt = raw.expiresAt || raw.expires_at ? String(raw.expiresAt || raw.expires_at) : defaultExpiresAt;
  const expiresAt = Number.isFinite(Date.parse(rawExpiresAt)) ? rawExpiresAt : defaultExpiresAt;
  // 合法种类和主体枚举
  const lifeArcKinds = ["travel", "work", "school", "personal", "special_date"];
  const lifeArcSubjects = ["role", "user", "shared"];
  const kind = lifeArcKinds.includes(raw.kind) ? raw.kind : null;
  const subject = lifeArcSubjects.includes(raw.subject) ? raw.subject : null;
  const timeStart = raw.timeStart || raw.time_start ? String(raw.timeStart || raw.time_start) : null;
  const timeEnd = raw.timeEnd || raw.time_end ? String(raw.timeEnd || raw.time_end) : null;
  return {
    id,
    status,
    title,
    summary,
    progressNote,
    // 来源依据上限 300 字符
    source: raw.source ? String(raw.source).trim().slice(0, 300) : "",
    kind,
    subject,
    timeStart,
    timeEnd,
    createdAt,
    updatedAt,
    expiresAt,
    // 兼容 camelCase 和 snake_case
    closedAt: raw.closedAt || raw.closed_at ? String(raw.closedAt || raw.closed_at) : null,
    closeReason: raw.closeReason || raw.close_reason ? String(raw.closeReason || raw.close_reason).trim().slice(0, 300) : "",
  };
}

// 规范化生活弧线数组：逐条规范化 -> 过期/非活跃过滤 -> 按 id 去重 -> 排序
// 参数: raw - 原始弧线数组; includeClosed - 是否包含已关闭的弧线(默认 false)
// 返回: 规范化后的弧线数组
function normalizeLifeArcs(raw, { includeClosed = false } = {}) {
  if (!Array.isArray(raw)) return [];
  const nowMs = Date.now();
  const byId = new Map();
  for (const arc of raw.map(normalizeLifeArc).filter(Boolean)) {
    const expiresMs = Date.parse(arc.expiresAt || "");
    // 不包含已关闭时：过滤已过期但仍标注 active 的弧线
    if (!includeClosed && arc.status === "active" && Number.isFinite(expiresMs) && expiresMs < nowMs) continue;
    // 不包含已关闭时：过滤非 active 状态的弧线
    if (!includeClosed && arc.status !== "active") continue;
    // 按 id 合并(后者覆盖前者)
    byId.set(arc.id, { ...byId.get(arc.id), ...arc });
  }
  return [...byId.values()]
    // 按更新时间或创建时间升序
    .sort((a, b) => Date.parse(a.updatedAt || a.createdAt || 0) - Date.parse(b.updatedAt || b.createdAt || 0));
}

// 规范化 scenelet 执行结果对象(LLM 返回的 JSON 结构)
// 参数: raw - 原始 scenelet 结果对象(snake_case 字段名)
// 返回: 规范化后的结果对象，包含 innerScenelet、候选列表、世界状态补丁、工具统计等
function normalizeSceneletResult(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    // scenelet 内心独白文本
    innerScenelet: raw.inner_scenelet ? String(raw.inner_scenelet).trim() : "",
    // follow-up 候选消息列表
    followUpCandidates: Array.isArray(raw.follow_up_candidates) ? raw.follow_up_candidates : [],
    // 世界状态补丁
    worldStatePatch: raw.world_state_patch && typeof raw.world_state_patch === "object" ? raw.world_state_patch : null,
    // 工具使用统计
    toolUsage: normalizeToolUsage(raw._toolUsage) || emptyToolUsage(),
    // 隐藏调用元信息
    hiddenCall: raw._hiddenCall || null,
  };
}

// 将原始主动消息候选转换为规范化的 proactive intent 对象
// 参数: raw - 原始候选对象(含 scheduled_at 等 snake_case 字段)
//       nowIso - 当前时间戳; sourceUserText - 触发源的用户文本; defaultKind - 默认种类
// 返回: 规范化后的意图对象(调用 normalizeProactiveIntent)，调度时间无效时返回 null
function normalizeRawProactiveCandidate(raw, { nowIso = new Date().toISOString(), sourceUserText = "", defaultKind = "follow_up" } = {}) {
  // 解析调度时间
  const scheduled = raw?.scheduled_at ? new Date(raw.scheduled_at) : null;
  if (!scheduled || Number.isNaN(scheduled.getTime())) return null;
  // 解析过期时间，无效时用默认偏移
  const expires = raw.expires_at ? new Date(raw.expires_at) : new Date(scheduled.getTime() + getSceneConfig().proactiveDefaultExpiryOffsetMs);
  return normalizeProactiveIntent({
    id: crypto.randomUUID(),
    status: "pending",
    createdAt: nowIso,
    scheduledAt: scheduled.toISOString(),
    // 过期时间无效时回退到默认值
    expiresAt: Number.isNaN(expires.getTime()) ? new Date(scheduled.getTime() + getSceneConfig().proactiveDefaultExpiryOffsetMs).toISOString() : expires.toISOString(),
    sourceTurnAt: nowIso,
    sourceUserText,
    basis: raw.basis || "",
    cancelIf: raw.cancel_if || [],
    messageIntent: raw.message_intent || "",
    kind: raw.kind || defaultKind,
  });
}

// 规范化日程候选列表：校验 title 和 kind 必填，各字段截断，最多 5 条
// 参数: raw - 原始日程候选数组
// 返回: 规范化后的日程候选数组(最多 5 条)
function normalizeScheduleCandidates(raw = []) {
  if (!Array.isArray(raw)) return [];
  const kinds = ["travel", "work", "school", "personal", "special_date"];
  const subjects = ["role", "user", "shared"];
  return raw.map(item => {
    if (!item || typeof item !== "object") return null;
    const title = String(item.title || "").trim().slice(0, 80);
    // kind 必须在合法枚举中
    const kind = kinds.includes(item.kind) ? item.kind : "";
    // title 和 kind 缺一不可
    if (!title || !kind) return null;
    return {
      title,
      summary: String(item.summary || "").trim().slice(0, 500),
      kind,
      // subject 在校验合法时设置，否则为 null
      subject: subjects.includes(item.subject) ? item.subject : null,
      timeStart: item.time_start || item.timeStart || null,
      timeEnd: item.time_end || item.timeEnd || null,
      // 依据文本上限 300 字符
      basis: String(item.basis || "").trim().slice(0, 300),
    };
  }).filter(Boolean).slice(0, 5);
}

// 清洗用户可见的回复文本：移除场景标记、分隔线、多余空行、压缩空格
// 参数: text - 原始回复文本
// 返回: 清洗后的干净文本
function sanitizeVisibleReplyText(text) {
  return String(text || "")
    // 移除 [某某某] 格式的场景标记(如 [思考] [回忆])
    .replace(/\[[一-鿿A-Za-z]{1,12}\]/gu, "")
    // 移除独立分隔线行
    .replace(/^\s*[—\-－]{2,}\s*$/gm, "")
    // 破折号替换为逗号
    .replace(/—+/g, "，")
    // 压缩多个空格/制表符为一个
    .replace(/[ \t]{2,}/g, " ")
    // 压缩 3 个以上连续空行为 2 个
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 生成本地日期 key 字符串(YYYY-MM-DD 格式)
// 参数: date - Date 对象(默认当前时间)
// 返回: 如 "2026-06-10" 格式的日期字符串
function localDayKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

// 判断 ISO 时间字符串是否与给定日期处于同一天(本地时间比较)
// 参数: iso - ISO 时间字符串; date - 参考日期(默认当前)
// 返回: 布尔值
function sameLocalDay(iso, date = new Date()) {
  const d = iso ? new Date(iso) : null;
  return d && Number.isFinite(d.getTime()) && localDayKey(d) === localDayKey(date);
}

// 统计指定 session 当天已发送的主动消息数量
// 参数: sess - session 对象; date - 参考日期(默认当前)
// 返回: 当天已发送的主动消息数
function proactiveSentToday(roleWorld, date = new Date()) {
  return normalizeProactiveIntents(roleWorld?._proactiveIntents)
    // 筛选状态为 sent 且与给定日期同天的意图
    .filter(i => i.status === "sent" && sameLocalDay(i.sentAt || i.scheduledAt, date))
    .length;
}

// 获取 session 中最后一次对话活动的时间戳(毫秒)
// 参数: sess - session 对象
// 返回: 最近的用户或助手消息时间(毫秒时间戳)，无记录时返回 0
function lastConversationActivityMs(sess) {
  const times = [sess?._lastUserAt, sess?._lastAssistantAt]
    .map(x => Date.parse(x || ""))
    .filter(Number.isFinite);
  // 取最大的(最近的时间)
  return times.length ? Math.max(...times) : 0;
}

// 规范化主动消息决策结果(LLM 判断是否发送主动消息)
// 参数: raw - 原始决策对象(snake_case 字段名)
// 返回: 规范化后的决策对象，或 null
function normalizeProactiveDecision(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    // 是否应该发送
    shouldSend: raw.should_send === true,
    // 取消原因上限 500 字符
    cancelReason: raw.cancel_reason ? String(raw.cancel_reason).slice(0, 500) : "",
    // 内心独白
    innerScenelet: raw.inner_scenelet ? String(raw.inner_scenelet).trim() : "",
    // 清洗后对外可见的回复文本
    visibleReply: raw.visible_reply ? sanitizeVisibleReplyText(raw.visible_reply) : "",
    // 工具使用统计
    toolUsage: normalizeToolUsage(raw._toolUsage) || emptyToolUsage(),
  };
}

export {
  getSceneConfig,
  normalizeFailedTurn,
  normalizeVisibleHistory,
  normalizeProactiveIntent,
  normalizeProactiveIntents,
  emptyToolUsage,
  normalizeToolUsage,
  mergeToolUsage,
  normalizeWorldState,
  applyWorldStatePatch,
  normalizeWorldSession,
  normalizeLifeArcs,
  normalizeSceneletResult,
  normalizeRawProactiveCandidate,
  normalizeScheduleCandidates,
  sanitizeVisibleReplyText,
  normalizeProactiveDecision,
  proactiveSentToday,
  lastConversationActivityMs,
};
