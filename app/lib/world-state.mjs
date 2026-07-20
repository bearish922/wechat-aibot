import fs from "node:fs";
import crypto from "node:crypto";
import { uuid } from "./utils.mjs";
import { log } from "./utils.mjs";
import { DATA_DIR, dataPath, ensureDir } from "./paths.mjs";
import { sessions, profileTemplates } from "./state.mjs";
import { normalizeWorldState, normalizeWorldSession, normalizeLifeArcs, normalizeLifeTexture, normalizeLifeArcTimeSlots, getSceneConfig } from "./normalize.mjs";
import { beijingISO, loadPrompts } from "./reply.mjs";
import { backendModel, normalizeBackend } from "./backend-adapter.mjs";
import { validateScheduleArc } from "./schedule-validation.mjs";
import { timeSlotsFromRange } from "./time-slots.mjs";

function normalizeSceneMemoryMap(raw) {
  const out = { cc: "", codex: "", api: "" };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const k of ["cc", "codex", "api"]) {
      out[k] = typeof raw[k] === "string" ? raw[k].slice(0, 8000) : "";
    }
  } else if (typeof raw === "string" && raw.trim()) {
    out.cc = raw.slice(0, 8000);
  }
  return out;
}

function migrateProactiveIntentsFromSessions(worlds) {
  if (!sessions) return;
  let migrated = 0;
  for (const [, map] of Object.entries(sessions)) {
    for (const [, u] of map) {
      for (const s of u.list) {
        const intents = s._proactiveIntents;
        if (!Array.isArray(intents) || !intents.length) continue;
        const profile = s._profile || "默认";
        const world = worlds.get(roleWorldKey(profile)) || getRoleWorld(profile);
        const existing = new Map();
        for (const i of (world._proactiveIntents || [])) {
          if (i?.id) existing.set(i.id, i);
        }
        for (const i of intents) {
          if (!i?.id) continue;
          const prev = existing.get(i.id);
          if (!prev || new Date(i.sentAt || i.cancelledAt || 0) > new Date(prev.sentAt || prev.cancelledAt || 0)) {
            existing.set(i.id, i);
          }
        }
        world._proactiveIntents = [...existing.values()];
        migrated += intents.length;
      }
    }
  }
  if (migrated > 0) {
    console.log(`[world-state] migrated ${migrated} proactive intents from sessions to roleWorlds`);
  }
}

// 从 session 对象中提取 profile 字段，若不存在则返回 null
function sessionProfile(sess) {
  return sess?._profile ?? null;
}

// 显式创建一个新的后端 Actor session。只有首次初始化和 reset 可以调用。
function initializeWorldSession(sess, backend = "cc", { reason = "initial", now = beijingISO() } = {}) {
  const provider = normalizeBackend(backend);
  if (!sess._worldSessions || typeof sess._worldSessions !== "object") sess._worldSessions = {};
  const previous = normalizeWorldSession(sess._worldSessions[provider]);
  if (previous?.sid) {
    throw new Error(`${provider} Actor session already exists; reset is required before replacing its SID`);
  }
  const generation = Math.max(0, Number(previous?.generation || 0) || 0) + 1;
  sess._worldSessions[provider] = {
    sid: uuid(),
    firstTurn: true,
    model: backendModel(provider),
    startedAt: now,
    lastUsedAt: null,
    resetReason: reason,
    lastUsage: null,
    turnCount: 0,
    generation,
  };
  log("↻", `[${sess.profile || "角色"}] ${provider} Actor session initialized: ${reason}`);
  return sess._worldSessions[provider];
}

// 获取已有 worldSession。缺失或损坏时必须显式报错，不能静默补 SID。
// 参数: sess - session 对象
// 返回: 已存在且包含 SID 的规范化 worldSession 对象
function ensureWorldSession(sess, backend = "cc") {
  const provider = normalizeBackend(backend);
  const raw = sess?._worldSessions?.[provider];
  if (!raw) {
    throw new Error(`${provider} Actor session is not initialized; explicit initialization or reset is required`);
  }
  sess._worldSessions[provider] = normalizeWorldSession(raw);
  if (!sess._worldSessions[provider]?.sid) {
    throw new Error(`${provider} Actor session SID is missing; reset is required before opening a new session`);
  }
  if (!sess._worldSessions[provider].model) sess._worldSessions[provider].model = backendModel(provider);
  return sess._worldSessions[provider];
}

function resetWorldSession(roleWorld, backend = "cc", reason = "reset", now = beijingISO()) {
  const provider = normalizeBackend(backend);
  const current = ensureWorldSession(roleWorld, provider);
  const oldSid = current.sid;
  const generation = Math.max(0, Number(current.generation || 0) || 0) + 1;
  Object.assign(current, {
    sid: uuid(),
    firstTurn: true,
    startedAt: now,
    lastUsedAt: null,
    resetReason: reason,
    lastUsage: null,
    turnCount: 0,
    generation,
  });
  roleWorld.updatedAt = now;
  log("↻", `[${roleWorld.profile || "角色"}] ${provider} Actor SID ${oldSid} -> ${current.sid}: ${reason}`);
  return current;
}

function normalizeWorldSessions(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const sessionsByBackend = {};
  for (const backend of ["cc", "codex", "api"]) {
    const normalized = normalizeWorldSession(source[backend]);
    if (normalized) {
      if (!source[backend]?.model) normalized.model = backendModel(backend);
      sessionsByBackend[backend] = normalized;
    }
  }
  return sessionsByBackend;
}

// 根据 profile 名称生成角色世界状态的唯一 key，空值回退为 "默认"
function roleWorldKey(profile) {
  return String(profile || "默认").trim() || "默认";
}

// 将原始角色世界数据规范化为标准格式，填充所有必要字段及默认值
// 参数: raw - 原始世界数据对象; profile - 角色名称
// 返回: 规范化后的角色世界对象(包含 _worldState、_worldSession、_lifeArcs 等)
function normalizeRoleWorld(raw = {}, profile = "默认") {
  const nowIso = beijingISO();
  const worldSessions = normalizeWorldSessions(raw._worldSessions || raw.worldSessions);
  const legacyWorldSession = normalizeWorldSession(raw._worldSession || raw.worldSession);
  if (legacyWorldSession && !worldSessions.cc) worldSessions.cc = legacyWorldSession;
  return {
    profile: roleWorldKey(raw.profile || profile),
    // 规范化角色当前状态(位置、活动等)
    _worldState: normalizeWorldState(raw._worldState || raw.worldState),
    // 世界内容跨后端共享；模型线程按后端分别续接
    _worldSessions: worldSessions,
    // 持久层保留 active / closed / expired life arcs；运行时查询时再筛选。
    _lifeArcs: normalizeLifeArcs(raw._lifeArcs || raw.lifeArcs, { includeClosed: true }),
    // 上次每日分享种子时间戳
    _lastDailyShareSeedAt: raw._lastDailyShareSeedAt ? String(raw._lastDailyShareSeedAt) : null,
    // 世界状态推进或 daily-share 生成失败后的短退避截止时间
    _dailyShareSeedRetryAfter: raw._dailyShareSeedRetryAfter ? String(raw._dailyShareSeedRetryAfter) : null,
    _dailyShareSeedRetryReason: raw._dailyShareSeedRetryReason ? String(raw._dailyShareSeedRetryReason) : null,
    // 上次日程检查时间戳
    _lastScheduleCheckAt: raw._lastScheduleCheckAt ? String(raw._lastScheduleCheckAt) : null,
    // 待处理的日程候选列表
    _pendingScheduleCandidates: Array.isArray(raw._pendingScheduleCandidates) ? raw._pendingScheduleCandidates : [],
    // scene 记忆按后端隔离
    _sceneMemory: normalizeSceneMemoryMap(raw._sceneMemory),
    _sceneMemoryAt: normalizeSceneMemoryMap(raw._sceneMemoryAt),
    // 主动意图列表（跨后端共享）
    _proactiveIntents: Array.isArray(raw._proactiveIntents) ? raw._proactiveIntents : [],
    _lastProactiveAt: raw._lastProactiveAt ? String(raw._lastProactiveAt) : null,
    _lastWorkEventGenerationAt: raw._lastWorkEventGenerationAt ? String(raw._lastWorkEventGenerationAt) : null,
    _lastGenerationTemplateIndices: Array.isArray(raw._lastGenerationTemplateIndices) ? raw._lastGenerationTemplateIndices : [],
    // 更新时间
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : nowIso,
  };
}

// 从角色世界对象中提取一个序列化快照，用于持久化存储(不含运行时临时字段)
// 参数: world - 角色世界对象
// 返回: 可序列化的快照对象
function roleWorldSnapshot(world) {
  return {
    profile: roleWorldKey(world?.profile),
    _worldState: normalizeWorldState(world?._worldState),
    _worldSessions: normalizeWorldSessions(world?._worldSessions),
    _lifeArcs: normalizeLifeArcs(world?._lifeArcs, { includeClosed: true }),
    _lastDailyShareSeedAt: world?._lastDailyShareSeedAt || null,
    _dailyShareSeedRetryAfter: world?._dailyShareSeedRetryAfter || null,
    _dailyShareSeedRetryReason: world?._dailyShareSeedRetryReason || null,
    _lastScheduleCheckAt: world?._lastScheduleCheckAt || null,
    _pendingScheduleCandidates: Array.isArray(world?._pendingScheduleCandidates) ? world._pendingScheduleCandidates : [],
    _sceneMemory: normalizeSceneMemoryMap(world?._sceneMemory),
    _sceneMemoryAt: normalizeSceneMemoryMap(world?._sceneMemoryAt),
    _proactiveIntents: Array.isArray(world?._proactiveIntents) ? world._proactiveIntents : [],
    _lastProactiveAt: world?._lastProactiveAt || null,
    _lastWorkEventGenerationAt: world?._lastWorkEventGenerationAt || null,
    _lastGenerationTemplateIndices: Array.isArray(world?._lastGenerationTemplateIndices) ? world._lastGenerationTemplateIndices : [],
    updatedAt: world?.updatedAt || beijingISO(),
  };
}

// 从角色世界中提取生活弧线的 Prompt 友好摘要列表，用于注入 LLM 上下文
// 参数: roleWorld - 角色世界对象
// 返回: 包含 id、title、summary、progress_note 等字段的对象数组
function lifeArcPromptItems(roleWorld) {
  return normalizeLifeArcs(roleWorld?._lifeArcs).map(arc => ({
    id: arc.id,
    title: arc.title,
    summary: arc.summary,
    progress_note: arc.progressNote,
    life_texture: arc.lifeTexture || null,
    kind: arc.kind || null,
    time_start: arc.timeStart || null,
    time_end: arc.timeEnd || null,
    time_slots: arc.timeSlots || null,
    duration_hours: arc.durationHours || null,
    updated_at: arc.updatedAt,
    expires_at: arc.expiresAt,
  }));
}

function cleanLifeText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncateText(value = "", max = 180) {
  const text = cleanLifeText(value);
  return text.length > max ? text.slice(0, Math.max(0, max - 1)) + "…" : text;
}

function splitLifeDetails(value = "", maxItems = 4, maxText = 120) {
  const seen = new Set();
  return cleanLifeText(value)
    .split(/(?<=[。])|[；;]/)
    .map(part => truncateText(part, maxText))
    .map(part => part.replace(/[。！？!?]$/, "").trim())
    .filter(part => part.length >= 8)
    .filter(part => {
      const key = part.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxItems);
}

function arcTimeMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
}

function lifeArcRelevance(arc, nowMs) {
  const startMs = arcTimeMs(arc.timeStart);
  const endMs = arcTimeMs(arc.timeEnd);
  const dayMs = 24 * 60 * 60 * 1000;
  if (arc.kind === "school" && startMs !== null && endMs !== null && endMs - startMs > 14 * dayMs) {
    return "background";
  }
  if (startMs !== null && endMs !== null && startMs <= nowMs && nowMs <= endMs) return "current";
  if (startMs !== null && startMs >= nowMs && startMs - nowMs <= 36 * 60 * 60 * 1000) return "near";
  if (startMs !== null && startMs >= nowMs && startMs - nowMs <= 7 * dayMs) return "later_this_week";
  if (arc.kind === "school") return "background";
  return "future";
}

function relevanceRank(value) {
  return { current: 0, near: 1, later_this_week: 2, background: 3, future: 4 }[value] ?? 9;
}

function whenLabel(relevance) {
  return {
    current: "现在相关",
    near: "接下来一两天",
    later_this_week: "这周稍后",
    background: "长期背景",
    future: "未来安排",
  }[relevance] || "背景";
}

function lifeArcOneLine(arc, relevance, maxText = 180) {
  if (arc?.lifeTexture?.currentLifeTexture) return truncateText(arc.lifeTexture.currentLifeTexture, maxText);
  const detailSource = [arc.summary, arc.progressNote].filter(Boolean).join(" ");
  const details = splitLifeDetails(detailSource, 4, maxText);
  const detail = details.find(part => !part.startsWith("为")) || details[0] || "";
  const prefix = `${whenLabel(relevance)}有${arc.title || "一项安排"}`;
  return truncateText(detail ? `${prefix}。${detail}` : prefix, maxText);
}

function lifeTextureDetails(arc, maxDetails = 4) {
  const modelDetails = Array.isArray(arc?.lifeTexture?.concreteChatableDetails)
    ? arc.lifeTexture.concreteChatableDetails.map(x => truncateText(x, 130)).filter(Boolean)
    : [];
  if (modelDetails.length) return modelDetails.slice(0, maxDetails);
  const detailSource = arc ? [arc.summary, arc.progressNote].filter(Boolean).join(" ") : "";
  const primaryDetails = arc ? splitLifeDetails(detailSource, maxDetails + 2, 130) : [];
  return primaryDetails.length > 1
    ? primaryDetails.filter(part => !part.startsWith("为")).slice(0, maxDetails)
    : primaryDetails.slice(0, maxDetails);
}

function lifeTexturePromptItems(roleWorld, { now = new Date(), maxDetails = 4, maxBackground = 2 } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const arcs = normalizeLifeArcs(roleWorld?._lifeArcs)
    .map(arc => ({ ...arc, relevance: lifeArcRelevance(arc, Number.isFinite(nowMs) ? nowMs : Date.now()) }))
    .sort((a, b) => {
      const rank = relevanceRank(a.relevance) - relevanceRank(b.relevance);
      if (rank !== 0) return rank;
      return (arcTimeMs(a.timeStart) ?? Number.MAX_SAFE_INTEGER) - (arcTimeMs(b.timeStart) ?? Number.MAX_SAFE_INTEGER);
    });
  const primary = arcs.find(arc => arc.relevance !== "future") || arcs[0] || null;
  const primaryTexture = primary?.lifeTexture || null;
  const salientDetails = primary ? lifeTextureDetails(primary, maxDetails) : [];
  return {
    current_life_texture: primary ? lifeArcOneLine(primary, primary.relevance, 220) : "",
    salient_details: salientDetails,
    private_pressure: primaryTexture?.privatePressure || "",
    mood_residue: primaryTexture?.moodResidue || "",
    proactive_sendability: primaryTexture?.proactiveSendability || null,
    what_not_to_say: primaryTexture?.whatNotToSay || [],
    current_focus: primary ? {
      title: primary.title,
      kind: primary.kind || null,
      relevance: primary.relevance,
      time_start: primary.timeStart || null,
      time_end: primary.timeEnd || null,
    } : null,
    background_threads: arcs
      .filter(arc => !primary || arc.id !== primary.id)
      .filter(arc => ["current", "near", "later_this_week", "background"].includes(arc.relevance))
      .slice(0, Math.max(0, Number(maxBackground) || 0))
      .map(arc => ({
        title: arc.title,
        kind: arc.kind || null,
        relevance: arc.relevance,
        texture: lifeArcOneLine(arc, arc.relevance, 140),
      })),
    chat_priority: "background",
    usage_note: "这是当前生活背景和可用细节，不是默认聊天议题；只有用户询问、场景自然碰到或一句话吐槽足够自然时才显化。",
  };
}

function resetRoleRuntimeWorld(profile, now = beijingISO()) {
  const key = roleWorldKey(profile);
  const worlds = roleWorldsMap();
  const fresh = normalizeRoleWorld({ profile: key, updatedAt: now }, key);
  worlds.set(key, fresh);
  return fresh;
}

const ROLE_WORLD_FILE = dataPath("wechat-worlds.json");
const ROLE_WORLD_BAK_FILE = dataPath("wechat-worlds.backup.json");

// 获取存储在 globalThis 上的全局角色世界 Map
function roleWorldsMap() {
  return globalThis.__wechatRoleWorlds;
}

// 根据 profile 名称获取对应的角色世界对象，不存在时自动创建并初始化
// 参数: profile - 角色配置名称(如 "默认"、"彩" 等)
// 返回: 角色世界对象(包含 _worldState、_worldSession、_lifeArcs 等)
export function getRoleWorld(profile) {
  const worlds = roleWorldsMap();
  const key = roleWorldKey(profile);
  // 若 Map 中不存在该 profile，创建规范化默认对象
  if (!worlds.has(key)) {
    worlds.set(key, normalizeRoleWorld({ profile: key }, key));
  }
  return worlds.get(key);
}

export function setSceneMemory(roleWorld, text, backend = "cc") {
  if (!roleWorld) return;
  const b = normalizeBackend(backend);
  if (!roleWorld._sceneMemory || typeof roleWorld._sceneMemory !== "object") {
    roleWorld._sceneMemory = { cc: "", codex: "", api: "" };
  }
  roleWorld._sceneMemory[b] = typeof text === "string" ? text.slice(0, 8000) : "";
  if (!roleWorld._sceneMemoryAt || typeof roleWorld._sceneMemoryAt !== "object") {
    roleWorld._sceneMemoryAt = { cc: null, codex: null, api: null };
  }
  roleWorld._sceneMemoryAt[b] = beijingISO();
  roleWorld.updatedAt = beijingISO();
}

// 将所有角色世界数据持久化到 JSON 文件(wechat-worlds.json)
export function saveRoleWorlds() {
  let tempFile = "";
  try {
    const worlds = roleWorldsMap();
    if (!worlds) return false;
    ensureDir(DATA_DIR);
    // 构建序列化数据结构: { version, roles: { profileName: snapshot } }
    const data = { version: 1, roles: {} };
    for (const [profile, world] of worlds) {
      // 每个角色世界取其快照(仅保留可持久化字段)
      data.roles[profile] = roleWorldSnapshot(world);
    }
    // 先写临时文件，再原子替换，避免进程中断留下半截 JSON。
    tempFile = `${ROLE_WORLD_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2) + "\n", "utf-8");
    if (fs.existsSync(ROLE_WORLD_FILE)) fs.copyFileSync(ROLE_WORLD_FILE, ROLE_WORLD_BAK_FILE);
    fs.renameSync(tempFile, ROLE_WORLD_FILE);
    return true;
  } catch (e) {
    log("⚠️", `save hidden worlds failed: ${e.message}`);
    if (tempFile) {
      try { fs.rmSync(tempFile, { force: true }); } catch {}
    }
    return false;
  }
}

// 从 JSON 文件加载角色世界数据，并从旧 session 迁移，最后确保所有 profile 模板都有对应世界对象
export function loadRoleWorlds() {
  const worlds = roleWorldsMap();
  if (!worlds) return;
  const loaded = new Map();
  try {
    if (fs.existsSync(ROLE_WORLD_FILE)) {
      let data;
      let recovered = false;
      try {
        data = JSON.parse(fs.readFileSync(ROLE_WORLD_FILE, "utf-8"));
      } catch (mainError) {
        if (!fs.existsSync(ROLE_WORLD_BAK_FILE)) throw mainError;
        data = JSON.parse(fs.readFileSync(ROLE_WORLD_BAK_FILE, "utf-8"));
        recovered = true;
        log("⚠️", `主角色世界文件损坏，已从备份恢复: ${mainError.message}`);
      }
      // 解析 roles 字段，兼容空对象
      const roles = data?.roles && typeof data.roles === "object" ? data.roles : {};
      for (const [profile, raw] of Object.entries(roles)) {
        loaded.set(roleWorldKey(profile), normalizeRoleWorld(raw, profile));
      }
      if (recovered) fs.copyFileSync(ROLE_WORLD_BAK_FILE, ROLE_WORLD_FILE);
    }
  } catch (e) {
    log("⚠️", `load hidden worlds failed: ${e.message}`);
    throw new Error(`hidden world state is unreadable; refusing to replace it: ${e.message}`);
  }
  worlds.clear();
  for (const [profile, world] of loaded) worlds.set(profile, world);
  // 确保所有已注册的 profile 模板都有对应的世界对象
  for (const profile of Object.keys(profileTemplates || {})) getRoleWorld(profile);
  // 迁移：将旧版 session 级 _proactiveIntents 合并到 roleWorld
  migrateProactiveIntentsFromSessions(worlds);
  // 加载完成后保存一次以确保文件与内存一致
  saveRoleWorlds();
}

export function activeWorldSessionIds() {
  const ids = new Set();
  for (const world of roleWorldsMap()?.values?.() || []) {
    for (const raw of Object.values(world?._worldSessions || {})) {
      const sid = normalizeWorldSession(raw)?.sid;
      if (sid) ids.add(sid);
    }
  }
  return ids;
}

// 对角色世界的生活弧线执行批量操作(create/update/close)，由 scenelet 输出驱动
// 参数: roleWorld - 角色世界对象; rawOps - 操作数组，每项包含 op、id/title、各字段值
export function applyLifeArcOps(roleWorld, rawOps = [], options = {}) {
  if (!roleWorld || !Array.isArray(rawOps) || !rawOps.length) return { applied: 0, rejected: [] };
  const now = new Date();
  const nowIso = beijingISO(now);
  const applied = [];
  const rejected = [];
  const workConfig = options.workEventConfig || loadPrompts(roleWorld.profile).workEventConfig || {};
  // 计算默认过期时间
  const defaultExpiresAt = beijingISO(new Date(now.getTime() + getSceneConfig().scheduleDefaultExpiryFromNowMs));
  // 获取当前所有弧线(含已关闭的)
  const arcs = normalizeLifeArcs(roleWorld._lifeArcs, { includeClosed: true });
  // 辅助函数：通过 id 或 title 查找已有弧线
  const findArc = (raw) => {
    const id = raw?.id ? String(raw.id) : "";
    // 优先按 id 查找
    if (id) {
      const byId = arcs.find(a => a.id === id);
      if (byId) return byId;
    }
    // 回退按 title 模糊匹配(小写)
    const title = raw?.title ? String(raw.title).trim().toLowerCase() : "";
    return title ? arcs.find(a => a.title.toLowerCase() === title) : null;
  };

  // 最多处理 5 个操作
  for (const raw of rawOps.slice(0, 5)) {
    if (!raw || typeof raw !== "object") continue;
    const op = String(raw.op || "").toLowerCase();
    // 只支持 create、update、close 三种操作
    if (!["create", "update", "close"].includes(op)) continue;
    const existing = findArc(raw);

    // 关闭操作：标记弧线为 closed 并记录关闭原因和时间
    if (op === "close") {
      if (!existing) continue;
      existing.status = "closed";
      existing.updatedAt = nowIso;
      existing.closedAt = nowIso;
      existing.closeReason = raw.reason ? String(raw.reason).slice(0, 300) : existing.closeReason || "closed by scenelet";
      existing.expiresAt = nowIso;
      applied.push({ op, id: existing.id });
      continue;
    }

    // 构建更新/创建所需的字段补丁
    const expiresAt = raw.expires_at || raw.expiresAt ? String(raw.expires_at || raw.expiresAt) : (existing?.expiresAt || defaultExpiresAt);
    const lifeArcKinds = ["travel", "work", "school", "personal", "special_date"];
    const lifeArcSubjects = ["role", "user", "shared"];
    // 校验 kind 和 subject 是否在合法枚举中
    const kind = lifeArcKinds.includes(raw.kind) ? raw.kind : (existing?.kind || null);
    const subject = lifeArcSubjects.includes(raw.subject) ? raw.subject : (existing?.subject || null);
    // time_slots: 可选的结构化时间段，create/update 均可传入
    const rawTimeSlots = raw.time_slots ?? raw.timeSlots;
    const hasExplicitTimeSlots = rawTimeSlots !== undefined && rawTimeSlots !== null;
    let timeSlots = existing?.timeSlots || null;
    if (hasExplicitTimeSlots) {
      timeSlots = normalizeLifeArcTimeSlots(rawTimeSlots);
    }
    const durationHoursRaw = raw.duration_hours ?? raw.durationHours ?? existing?.durationHours;
    const durationHours = Number.isFinite(Number(durationHoursRaw)) && Number(durationHoursRaw) > 0 ? Number(durationHoursRaw) : null;
    const timeStart = raw.time_start || raw.timeStart ? String(raw.time_start || raw.timeStart) : (existing?.timeStart || null);
    const timeEnd = raw.time_end || raw.timeEnd ? String(raw.time_end || raw.timeEnd) : (existing?.timeEnd || null);
    const timingChanged = [
      "time_start", "timeStart", "time_end", "timeEnd",
      "duration_hours", "durationHours",
    ].some(key => raw[key] !== undefined);
    if (!hasExplicitTimeSlots && timingChanged) {
      timeSlots = timeSlotsFromRange(timeStart, timeEnd, { durationHours });
    }
    const lifeTexture = raw.life_texture !== undefined || raw.lifeTexture !== undefined
      ? normalizeLifeTexture(raw.life_texture ?? raw.lifeTexture)
      : existing?.lifeTexture || null;
    const patch = {
      title: raw.title ? String(raw.title).trim().slice(0, 80) : existing?.title || "",
      summary: raw.summary ? String(raw.summary).trim().slice(0, 500) : existing?.summary || "",
      progressNote: raw.progress_note || raw.progressNote ? String(raw.progress_note || raw.progressNote).trim().slice(0, 500) : existing?.progressNote || "",
      lifeTexture,
      source: raw.source || raw.basis ? String(raw.source || raw.basis).trim().slice(0, 300) : existing?.source || "",
      kind,
      subject,
      timeStart,
      timeEnd,
      timeSlots,
      durationHours,
      expiresAt,
    };
    // 如果没有有效内容则跳过
    if (!patch.title && !patch.summary && !patch.progressNote) continue;

    const candidateId = existing?.id || crypto.randomUUID();
    const candidate = {
      ...(existing || {}),
      id: candidateId,
      status: "active",
      ...patch,
    };
    const scheduleFieldsChanged = op === "create" || timingChanged || hasExplicitTimeSlots || raw.kind !== undefined;
    if (scheduleFieldsChanged) {
      const validation = validateScheduleArc(candidate, arcs, {
        conflictPolicy: workConfig.conflictPolicy,
        minGapMinutes: workConfig.conflictPolicy?.minGapBetweenEventsMinutes,
        workHoursPerDay: workConfig.workHoursPerDay,
      });
      if (!validation.valid) {
        rejected.push({ op, id: candidateId, title: candidate.title, errors: validation.errors });
        log("⚠️", `schedule write rejected [${candidate.title || candidateId}]: ${validation.errors.join("; ")}`);
        continue;
      }
      candidate.timeSlots = validation.timeSlots;
    }

    if (existing) {
      // 已有关闭的弧线不再更新
      if (existing.status === "closed") continue;
      // 更新已有弧线
      Object.assign(existing, candidate, { status: "active", updatedAt: nowIso });
      applied.push({ op, id: existing.id });
    } else if (op === "create") {
      // 创建新弧线
      arcs.push({
        id: candidateId,
        status: "active",
        ...candidate,
        createdAt: nowIso,
        updatedAt: nowIso,
        closedAt: null,
        closeReason: "",
      });
      applied.push({ op, id: candidateId });
    }
  }

  roleWorld._lifeArcs = normalizeLifeArcs(arcs, { includeClosed: true });
  return { applied: applied.length, operations: applied, rejected };
}

export {
  sessionProfile,
  initializeWorldSession,
  ensureWorldSession,
  resetWorldSession,
  roleWorldKey,
  lifeArcPromptItems,
  lifeTexturePromptItems,
  resetRoleRuntimeWorld,
};
