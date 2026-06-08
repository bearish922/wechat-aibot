import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { loadPrompts } from "./reply.mjs";
import { normalizeMemoryCategory } from "./memory.mjs";
import { CLAUDE_MAIN_MODEL } from "./claude-runner.mjs";
import { dataPath } from "./paths.mjs";

function loadConfig() {
  const configPath = dataPath("config.json");
  if (!existsSync(configPath)) return {};
  try { return JSON.parse(readFileSync(configPath, "utf-8")); } catch { return {}; }
}

function getSceneConfig() {
  const p = loadPrompts();
  const c = loadConfig();
  return {
    visibleContextTurns: p.visibleContextTurns || 8,
    turnResetThreshold: p.turnResetThreshold || 8,
    proactiveCheckIntervalMs: p.proactiveCheckIntervalMs || 20000,
    proactiveCooldownMs: p.proactiveCooldownMs || 1800000,
    proactiveDailyMax: p.proactiveDailyMax || 8,
    dailyShareSeedIntervalMs: p.dailyShareSeedIntervalMs || 3600000,
    dailyShareMinIdleMs: p.dailyShareMinIdleMs || 1800000,
    scheduleCheckIntervalMs: p.scheduleCheckIntervalMs || 86400000,
    scheduleMaxActive: p.scheduleMaxActive || 2,
    ragTopK: p.ragTopK || 6,
    ragMinScore: p.ragMinScore || 0.48,
    ragResultMaxChars: p.ragResultMaxChars || 3600,
    ragTimeoutMs: p.ragTimeoutMs || 45000,
    hiddenWorldMaxPendingIntents: p.hiddenWorldMaxPendingIntents || 8,
    maxFollowUpCandidatesPerTurn: p.maxFollowUpCandidatesPerTurn || 3,
    dailyShareDefaultScheduleOffsetMs: p.dailyShareDefaultScheduleOffsetMs || 300000,
    dailyShareDefaultExpiryOffsetMs: p.dailyShareDefaultExpiryOffsetMs || 1800000,
    dailyShareDefaultCancelIf: p.dailyShareDefaultCancelIf || ["用户已经开启新话题", "用户正在忙或没有回应上一条主动消息"],
    proactiveDefaultExpiryOffsetMs: p.proactiveDefaultExpiryOffsetMs || 1800000,
    scheduleFinalizationTimeoutMs: p.scheduleFinalizationTimeoutMs || 60000,
    scheduleRecentKindsLimit: p.scheduleRecentKindsLimit || 5,
    schedulePromptProfileMaxChars: p.schedulePromptProfileMaxChars || 800,
    scheduleBasisMaxLength: p.scheduleBasisMaxLength || 300,
    scheduleArcTitleMaxLength: p.scheduleArcTitleMaxLength || 80,
    scheduleArcSummaryMaxLength: p.scheduleArcSummaryMaxLength || 500,
    scheduleExpiryAfterEndBufferMs: p.scheduleExpiryAfterEndBufferMs || 43200000,
    scheduleDefaultExpiryFromNowMs: p.scheduleDefaultExpiryFromNowMs || 259200000,
    memoryCandidateTimeoutMs: p.memoryCandidateTimeoutMs || 45000,
    memoryMergeTimeoutMs: p.memoryMergeTimeoutMs || 90000,
    chunkSendDelayMs: c.send?.chunkSendDelayMs ?? p.chunkSendDelayMs ?? 450,
    maxCancelReasonLength: c.send?.maxCancelReasonLength ?? p.maxCancelReasonLength ?? 500,
  };
}

function normalizeFailedTurn(raw) {
  if (!raw?.body) return null;
  return {
    body: String(raw.body),
    timestamp: raw.timestamp ? String(raw.timestamp) : null,
    reason: raw.reason ? String(raw.reason).slice(0, 500) : "",
    sid: raw.sid ? String(raw.sid) : null,
  };
}

function normalizeVisibleHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(item => item?.role && item?.text)
    .slice(-getSceneConfig().visibleContextTurns * 2)
    .map(item => ({
      role: item.role === "assistant" ? "assistant" : "user",
      text: String(item.text).slice(0, 4000),
      timestamp: item.timestamp ? String(item.timestamp) : null,
      kind: item.kind ? String(item.kind) : "chat",
    }));
}

function normalizeProactiveIntent(raw) {
  if (!raw?.id || !raw?.scheduledAt) return null;
  return {
    id: String(raw.id),
    status: ["pending", "sent", "cancelled"].includes(raw.status) ? raw.status : "pending",
    createdAt: raw.createdAt ? String(raw.createdAt) : new Date().toISOString(),
    scheduledAt: String(raw.scheduledAt),
    expiresAt: raw.expiresAt ? String(raw.expiresAt) : null,
    sourceTurnAt: raw.sourceTurnAt ? String(raw.sourceTurnAt) : null,
    sourceUserText: raw.sourceUserText ? String(raw.sourceUserText).slice(0, 500) : "",
    basis: raw.basis ? String(raw.basis).slice(0, 800) : "",
    cancelIf: Array.isArray(raw.cancelIf) ? raw.cancelIf.map(x => String(x).slice(0, 200)).slice(0, 8) : [],
    innerScenelet: raw.innerScenelet ? String(raw.innerScenelet).slice(0, 2000) : "",
    messageIntent: raw.messageIntent ? String(raw.messageIntent).slice(0, 500) : "",
    kind: ["follow_up", "daily_share"].includes(raw.kind) ? raw.kind : "follow_up",
    lastCheckedAt: raw.lastCheckedAt ? String(raw.lastCheckedAt) : null,
    sentAt: raw.sentAt ? String(raw.sentAt) : null,
    cancelledAt: raw.cancelledAt ? String(raw.cancelledAt) : null,
    cancelReason: raw.cancelReason ? String(raw.cancelReason).slice(0, 500) : "",
  };
}

function normalizeProactiveIntents(raw) {
  if (!Array.isArray(raw)) return [];
  const byId = new Map();
  for (const intent of raw.map(normalizeProactiveIntent).filter(Boolean)) {
    byId.set(intent.id, { ...byId.get(intent.id), ...intent });
  }
  return [...byId.values()]
    .sort((a, b) => Date.parse(a.createdAt || a.scheduledAt || 0) - Date.parse(b.createdAt || b.scheduledAt || 0))
    .slice(-20);
}

function emptyToolUsage() {
  return { webSearch: 0, webFetch: 0, tools: [] };
}

function normalizeToolUsage(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  const tools = Array.isArray(raw.tools)
    ? [...new Set(raw.tools.map(x => String(x || "").trim()).filter(Boolean))]
    : [];
  return {
    webSearch: Math.max(0, Number(raw.webSearch || raw.web_search_requests || 0) || 0),
    webFetch: Math.max(0, Number(raw.webFetch || raw.web_fetch_requests || 0) || 0),
    tools,
  };
}

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

function normalizeWorldState(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  const openThreads = Array.isArray(raw.openThreads || raw.open_threads)
    ? (raw.openThreads || raw.open_threads).map(x => String(x || "").trim()).filter(Boolean).slice(0, 8)
    : [];
  const state = {
    location: raw.location ? String(raw.location).slice(0, 160) : "",
    activity: raw.activity ? String(raw.activity).slice(0, 200) : "",
    awakeState: raw.awakeState || raw.awake_state ? String(raw.awakeState || raw.awake_state).slice(0, 80) : "",
    currentPlan: raw.currentPlan || raw.current_plan ? String(raw.currentPlan || raw.current_plan).slice(0, 300) : "",
    openThreads,
    lastWorldEventAt: raw.lastWorldEventAt || raw.last_world_event_at ? String(raw.lastWorldEventAt || raw.last_world_event_at) : null,
    updatedAt: raw.updatedAt || raw.updated_at ? String(raw.updatedAt || raw.updated_at) : null,
  };
  return Object.values(state).some(Boolean) || openThreads.length ? state : null;
}

function applyWorldStatePatch(sess, rawPatch = null) {
  if (!sess || !rawPatch || typeof rawPatch !== "object") return;
  const current = normalizeWorldState(sess._worldState) || emptyWorldState();
  const patch = normalizeWorldState(rawPatch);
  if (!patch) return;
  sess._worldState = normalizeWorldState({
    ...current,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => {
      if (Array.isArray(v)) return v.length;
      return v !== null && v !== "";
    })),
    updatedAt: new Date().toISOString(),
  });
}

function normalizeSceneMemory(raw) {
  return typeof raw === "string" ? raw.slice(0, 8000) : "";
}

function normalizeWorldSession(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  return {
    sid: raw.sid ? String(raw.sid) : null,
    firstTurn: raw.firstTurn === true || raw._firstTurn === true,
    model: raw.model ? String(raw.model) : CLAUDE_MAIN_MODEL,
    startedAt: raw.startedAt ? String(raw.startedAt) : null,
    lastUsedAt: raw.lastUsedAt ? String(raw.lastUsedAt) : null,
    resetReason: raw.resetReason ? String(raw.resetReason).slice(0, 300) : "",
    lastUsage: raw.lastUsage && typeof raw.lastUsage === "object" ? raw.lastUsage : null,
  };
}

function normalizeWorldLastOutput(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  return {
    timestamp: raw.timestamp ? String(raw.timestamp) : null,
    innerScenelet: raw.innerScenelet ? String(raw.innerScenelet).slice(0, 4000) : "",
    worldStatePatch: raw.worldStatePatch && typeof raw.worldStatePatch === "object" ? raw.worldStatePatch : null,
    dailyShareCandidates: Array.isArray(raw.dailyShareCandidates) ? raw.dailyShareCandidates.slice(0, 5) : [],
    scheduleCandidates: Array.isArray(raw.scheduleCandidates) ? raw.scheduleCandidates.slice(0, 5) : [],
  };
}

function normalizeLifeArc(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = raw.id ? String(raw.id) : "";
  const title = raw.title ? String(raw.title).trim().slice(0, 80) : "";
  const summary = raw.summary ? String(raw.summary).trim().slice(0, 500) : "";
  const progressNote = raw.progressNote || raw.progress_note ? String(raw.progressNote || raw.progress_note).trim().slice(0, 500) : "";
  if (!id || (!title && !summary && !progressNote)) return null;
  const nowIso = new Date().toISOString();
  const status = ["active", "closed"].includes(raw.status) ? raw.status : "active";
  const createdAt = raw.createdAt || raw.created_at ? String(raw.createdAt || raw.created_at) : nowIso;
  const updatedAt = raw.updatedAt || raw.updated_at ? String(raw.updatedAt || raw.updated_at) : createdAt;
  const defaultExpiresAt = new Date(Date.now() + getSceneConfig().scheduleDefaultExpiryFromNowMs).toISOString();
  const rawExpiresAt = raw.expiresAt || raw.expires_at ? String(raw.expiresAt || raw.expires_at) : defaultExpiresAt;
  const expiresAt = Number.isFinite(Date.parse(rawExpiresAt)) ? rawExpiresAt : defaultExpiresAt;
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
    source: raw.source ? String(raw.source).trim().slice(0, 300) : "",
    kind,
    subject,
    timeStart,
    timeEnd,
    createdAt,
    updatedAt,
    expiresAt,
    closedAt: raw.closedAt || raw.closed_at ? String(raw.closedAt || raw.closed_at) : null,
    closeReason: raw.closeReason || raw.close_reason ? String(raw.closeReason || raw.close_reason).trim().slice(0, 300) : "",
  };
}

function normalizeLifeArcs(raw, { includeClosed = false } = {}) {
  if (!Array.isArray(raw)) return [];
  const nowMs = Date.now();
  const byId = new Map();
  for (const arc of raw.map(normalizeLifeArc).filter(Boolean)) {
    const expiresMs = Date.parse(arc.expiresAt || "");
    if (!includeClosed && arc.status === "active" && Number.isFinite(expiresMs) && expiresMs < nowMs) continue;
    if (!includeClosed && arc.status !== "active") continue;
    byId.set(arc.id, { ...byId.get(arc.id), ...arc });
  }
  return [...byId.values()]
    .sort((a, b) => Date.parse(a.updatedAt || a.createdAt || 0) - Date.parse(b.updatedAt || b.createdAt || 0))
    .slice(-6);
}

function normalizeSceneletResult(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    innerScenelet: raw.inner_scenelet ? String(raw.inner_scenelet).trim() : "",
    followUpCandidates: Array.isArray(raw.follow_up_candidates) ? raw.follow_up_candidates : [],
    worldStatePatch: raw.world_state_patch && typeof raw.world_state_patch === "object" ? raw.world_state_patch : null,
    dailyShareCandidates: Array.isArray(raw.daily_share_candidates) ? raw.daily_share_candidates : [],
    scheduleCandidates: Array.isArray(raw.schedule_candidates) ? raw.schedule_candidates : [],
    toolUsage: normalizeToolUsage(raw._toolUsage) || emptyToolUsage(),
    hiddenCall: raw._hiddenCall || null,
  };
}

function normalizeRawProactiveCandidate(raw, { nowIso = new Date().toISOString(), sourceUserText = "", defaultKind = "follow_up" } = {}) {
  const scheduled = raw?.scheduled_at ? new Date(raw.scheduled_at) : null;
  if (!scheduled || Number.isNaN(scheduled.getTime())) return null;
  const expires = raw.expires_at ? new Date(raw.expires_at) : new Date(scheduled.getTime() + getSceneConfig().proactiveDefaultExpiryOffsetMs);
  return normalizeProactiveIntent({
    id: crypto.randomUUID(),
    status: "pending",
    createdAt: nowIso,
    scheduledAt: scheduled.toISOString(),
    expiresAt: Number.isNaN(expires.getTime()) ? new Date(scheduled.getTime() + getSceneConfig().proactiveDefaultExpiryOffsetMs).toISOString() : expires.toISOString(),
    sourceTurnAt: nowIso,
    sourceUserText,
    basis: raw.basis || "",
    cancelIf: raw.cancel_if || [],
    innerScenelet: raw.inner_scenelet || "",
    messageIntent: raw.message_intent || "",
    kind: raw.kind || defaultKind,
  });
}

function normalizeScheduleCandidates(raw = []) {
  if (!Array.isArray(raw)) return [];
  const kinds = ["travel", "work", "school", "personal", "special_date"];
  const subjects = ["role", "user", "shared"];
  return raw.map(item => {
    if (!item || typeof item !== "object") return null;
    const title = String(item.title || "").trim().slice(0, 80);
    const kind = kinds.includes(item.kind) ? item.kind : "";
    if (!title || !kind) return null;
    return {
      title,
      summary: String(item.summary || "").trim().slice(0, 500),
      kind,
      subject: subjects.includes(item.subject) ? item.subject : null,
      time_start: item.time_start || item.timeStart || null,
      time_end: item.time_end || item.timeEnd || null,
      basis: String(item.basis || "").trim().slice(0, 300),
    };
  }).filter(Boolean).slice(0, 5);
}

function normalizeMemoryCandidates(raw = []) {
  if (!Array.isArray(raw)) return [];
  return raw.map(item => {
    const category = normalizeMemoryCategory(item?.category);
    const text = String(item?.text || "").trim().slice(0, 180);
    if (!category || !text) return null;
    return {
      category,
      text,
      sensitive: Boolean(item?.sensitive),
      reason: item?.reason ? String(item.reason).slice(0, 220) : "",
    };
  }).filter(Boolean).slice(0, 6);
}

function normalizeMemoryOps(raw = []) {
  if (!Array.isArray(raw)) return [];
  return raw.map(item => {
    const op = String(item?.op || "noop").trim().toLowerCase();
    if (op === "noop") return { op: "noop" };
    if (!["add", "update"].includes(op)) return null;
    const category = normalizeMemoryCategory(item?.category);
    const text = String(item?.text || "").trim().slice(0, 180);
    const id = item?.id ? String(item.id).trim() : "";
    if (!category || !text) return null;
    if (op === "update" && !id) return null;
    return {
      op,
      id,
      category,
      text,
      sensitive: Boolean(item?.sensitive),
    };
  }).filter(Boolean).slice(0, 6);
}

function sanitizeVisibleReplyText(text) {
  return String(text || "")
    .replace(/\[[一-鿿A-Za-z]{1,12}\]/gu, "")
    .replace(/^\s*[—\-－]{2,}\s*$/gm, "")
    .replace(/—+/g, "，")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function localDayKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function sameLocalDay(iso, date = new Date()) {
  const d = iso ? new Date(iso) : null;
  return d && Number.isFinite(d.getTime()) && localDayKey(d) === localDayKey(date);
}

function proactiveSentToday(sess, date = new Date()) {
  return normalizeProactiveIntents(sess?._proactiveIntents)
    .filter(i => i.status === "sent" && sameLocalDay(i.sentAt || i.scheduledAt, date))
    .length;
}

function unansweredProactiveSummary(sess) {
  const lastUserMs = Date.parse(sess?._lastUserAt || "");
  const sent = normalizeProactiveIntents(sess?._proactiveIntents)
    .filter(i => i.status === "sent" && Number.isFinite(Date.parse(i.sentAt || i.scheduledAt)))
    .filter(i => !Number.isFinite(lastUserMs) || Date.parse(i.sentAt || i.scheduledAt) > lastUserMs)
    .sort((a, b) => Date.parse(a.sentAt || a.scheduledAt) - Date.parse(b.sentAt || b.scheduledAt));
  if (!sent.length) return null;
  const recentReplies = normalizeVisibleHistory(sess?._visibleHistory)
    .filter(x => x.role === "assistant" && x.kind === "proactive")
    .filter(x => !Number.isFinite(lastUserMs) || Date.parse(x.timestamp || "") > lastUserMs)
    .slice(-3)
    .map(x => ({
      timestamp: x.timestamp || null,
      text: String(x.text || "").slice(0, 160),
    }));
  return {
    count_since_last_user: sent.length,
    last_user_at: sess?._lastUserAt || null,
    last_sent_at: sent.at(-1)?.sentAt || sent.at(-1)?.scheduledAt || null,
    recent_kinds: sent.slice(-5).map(i => i.kind || "follow_up"),
    recent_message_intents: sent.slice(-5).map(i => i.messageIntent || "").filter(Boolean),
    recent_visible_replies: recentReplies,
    interpretation: "These proactive messages were sent after the user's last message and have not received a user reply yet. Treat this as relationship context, not as permission to keep sending.",
  };
}

function lastConversationActivityMs(sess) {
  const times = [sess?._lastUserAt, sess?._lastAssistantAt]
    .map(x => Date.parse(x || ""))
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : 0;
}

function normalizeProactiveDecision(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    shouldSend: raw.should_send === true,
    cancelReason: raw.cancel_reason ? String(raw.cancel_reason).slice(0, 500) : "",
    innerScenelet: raw.inner_scenelet ? String(raw.inner_scenelet).trim() : "",
    visibleReply: raw.visible_reply ? sanitizeVisibleReplyText(raw.visible_reply) : "",
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
  normalizeWorldState,
  applyWorldStatePatch,
  normalizeWorldSession,
  normalizeWorldLastOutput,
  normalizeLifeArcs,
  normalizeSceneletResult,
  normalizeRawProactiveCandidate,
  normalizeScheduleCandidates,
  normalizeMemoryCandidates,
  normalizeMemoryOps,
  sanitizeVisibleReplyText,
  normalizeProactiveDecision,
  normalizeSceneMemory,
  proactiveSentToday,
  unansweredProactiveSummary,
  lastConversationActivityMs,
};
