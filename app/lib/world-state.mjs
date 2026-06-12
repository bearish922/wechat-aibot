import fs from "node:fs";
import crypto from "node:crypto";
import { uuid } from "./utils.mjs";
import { log } from "./utils.mjs";
import { DATA_DIR, dataPath, ensureDir } from "./paths.mjs";
import { sessions, profileTemplates } from "./state.mjs";
import { normalizeWorldState, normalizeWorldSession, normalizeLifeArcs, getSceneConfig } from "./normalize.mjs";
import { backendModel, normalizeBackend } from "./backend-adapter.mjs";

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

// 确保 session 拥有一个有效的 worldSession 对象，不存在则创建，已存在则规范化并补全缺失字段
// 参数: sess - session 对象
// 返回: 规范化后的 worldSession 对象
function ensureWorldSession(sess, backend = "cc") {
  const provider = normalizeBackend(backend);
  if (!sess._worldSessions || typeof sess._worldSessions !== "object") sess._worldSessions = {};
  if (!sess._worldSessions[provider]) {
    // 首次创建 worldSession
    const nowIso = new Date().toISOString();
    sess._worldSessions[provider] = {
      sid: uuid(),
      firstTurn: true,
      model: backendModel(provider),
      startedAt: nowIso,
      lastUsedAt: null,
      resetReason: "",
      lastUsage: null,
      turnCount: 0,
    };
  } else {
    // 已有则通过规范化器清洗，若清洗失败则递归重建
    sess._worldSessions[provider] = normalizeWorldSession(sess._worldSessions[provider]) || null;
    if (!sess._worldSessions[provider]) return ensureWorldSession(sess, provider);
    // 缺少 sid 时重新生成
    if (!sess._worldSessions[provider].sid) {
      sess._worldSessions[provider].sid = uuid();
      sess._worldSessions[provider].firstTurn = true;
    }
    // 缺少 model 时补默认值
    if (!sess._worldSessions[provider].model) sess._worldSessions[provider].model = backendModel(provider);
  }
  return sess._worldSessions[provider];
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
  const nowIso = new Date().toISOString();
  const worldSessions = normalizeWorldSessions(raw._worldSessions || raw.worldSessions);
  const legacyWorldSession = normalizeWorldSession(raw._worldSession || raw.worldSession);
  if (legacyWorldSession && !worldSessions.cc) worldSessions.cc = legacyWorldSession;
  return {
    profile: roleWorldKey(raw.profile || profile),
    // 规范化角色当前状态(位置、活动等)
    _worldState: normalizeWorldState(raw._worldState || raw.worldState),
    // 世界内容跨后端共享；模型线程按后端分别续接
    _worldSessions: worldSessions,
    // 运行时默认只保留仍有效的 active life arcs；关闭项仅在显式查询时读取。
    _lifeArcs: normalizeLifeArcs(raw._lifeArcs || raw.lifeArcs),
    // 上次每日分享种子时间戳
    _lastDailyShareSeedAt: raw._lastDailyShareSeedAt ? String(raw._lastDailyShareSeedAt) : null,
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
    _lifeArcs: normalizeLifeArcs(world?._lifeArcs),
    _lastDailyShareSeedAt: world?._lastDailyShareSeedAt || null,
    _lastScheduleCheckAt: world?._lastScheduleCheckAt || null,
    _pendingScheduleCandidates: Array.isArray(world?._pendingScheduleCandidates) ? world._pendingScheduleCandidates : [],
    _sceneMemory: normalizeSceneMemoryMap(world?._sceneMemory),
    _sceneMemoryAt: normalizeSceneMemoryMap(world?._sceneMemoryAt),
    _proactiveIntents: Array.isArray(world?._proactiveIntents) ? world._proactiveIntents : [],
    _lastProactiveAt: world?._lastProactiveAt || null,
    updatedAt: world?.updatedAt || new Date().toISOString(),
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
    kind: arc.kind || null,
    time_start: arc.timeStart || null,
    time_end: arc.timeEnd || null,
    updated_at: arc.updatedAt,
    expires_at: arc.expiresAt,
  }));
}

const ROLE_WORLD_FILE = dataPath("wechat-worlds.json");

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

export function getSceneMemory(roleWorld, backend = "cc") {
  const map = roleWorld?._sceneMemory;
  if (map && typeof map === "object") return map[normalizeBackend(backend)] || "";
  return "";
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
  roleWorld._sceneMemoryAt[b] = new Date().toISOString();
  roleWorld.updatedAt = new Date().toISOString();
}

// 将所有角色世界数据持久化到 JSON 文件(wechat-worlds.json)
export function saveRoleWorlds() {
  try {
    const worlds = roleWorldsMap();
    if (!worlds) return;
    ensureDir(DATA_DIR);
    // 构建序列化数据结构: { version, roles: { profileName: snapshot } }
    const data = { version: 1, roles: {} };
    for (const [profile, world] of worlds) {
      // 每个角色世界取其快照(仅保留可持久化字段)
      data.roles[profile] = roleWorldSnapshot(world);
    }
    // 同步写入文件，末尾加换行符
    fs.writeFileSync(ROLE_WORLD_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch (e) {
    log("⚠️", `save hidden worlds failed: ${e.message}`);
  }
}

// 从 JSON 文件加载角色世界数据，并从旧 session 迁移，最后确保所有 profile 模板都有对应世界对象
export function loadRoleWorlds() {
  const worlds = roleWorldsMap();
  if (!worlds) return;
  // 清空现有数据准备重新加载
  worlds.clear();
  try {
    if (fs.existsSync(ROLE_WORLD_FILE)) {
      const data = JSON.parse(fs.readFileSync(ROLE_WORLD_FILE, "utf-8"));
      // 解析 roles 字段，兼容空对象
      const roles = data?.roles && typeof data.roles === "object" ? data.roles : {};
      for (const [profile, raw] of Object.entries(roles)) {
        // 逐条规范化后放入 Map
        worlds.set(roleWorldKey(profile), normalizeRoleWorld(raw, profile));
      }
    }
  } catch (e) {
    log("⚠️", `load hidden worlds failed: ${e.message}`);
  }
  // 确保所有已注册的 profile 模板都有对应的世界对象
  for (const profile of Object.keys(profileTemplates || {})) getRoleWorld(profile);
  // 迁移：将旧版 session 级 _proactiveIntents 合并到 roleWorld
  migrateProactiveIntentsFromSessions(worlds);
  // 加载完成后保存一次以确保文件与内存一致
  saveRoleWorlds();
}

// 对角色世界的生活弧线执行批量操作(create/update/close)，由 scenelet 输出驱动
// 参数: roleWorld - 角色世界对象; rawOps - 操作数组，每项包含 op、id/title、各字段值
export function applyLifeArcOps(roleWorld, rawOps = []) {
  if (!roleWorld || !Array.isArray(rawOps) || !rawOps.length) return;
  const now = new Date();
  const nowIso = now.toISOString();
  // 计算默认过期时间
  const defaultExpiresAt = new Date(now.getTime() + getSceneConfig().scheduleDefaultExpiryFromNowMs).toISOString();
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
      continue;
    }

    // 构建更新/创建所需的字段补丁
    const expiresAt = raw.expires_at || raw.expiresAt ? String(raw.expires_at || raw.expiresAt) : (existing?.expiresAt || defaultExpiresAt);
    const lifeArcKinds = ["travel", "work", "school", "personal", "special_date"];
    const lifeArcSubjects = ["role", "user", "shared"];
    // 校验 kind 和 subject 是否在合法枚举中
    const kind = lifeArcKinds.includes(raw.kind) ? raw.kind : (existing?.kind || null);
    const subject = lifeArcSubjects.includes(raw.subject) ? raw.subject : (existing?.subject || null);
    const patch = {
      title: raw.title ? String(raw.title).trim().slice(0, 80) : existing?.title || "",
      summary: raw.summary ? String(raw.summary).trim().slice(0, 500) : existing?.summary || "",
      progressNote: raw.progress_note || raw.progressNote ? String(raw.progress_note || raw.progressNote).trim().slice(0, 500) : existing?.progressNote || "",
      source: raw.source || raw.basis ? String(raw.source || raw.basis).trim().slice(0, 300) : existing?.source || "",
      kind,
      subject,
      timeStart: raw.time_start || raw.timeStart ? String(raw.time_start || raw.timeStart) : (existing?.timeStart || null),
      timeEnd: raw.time_end || raw.timeEnd ? String(raw.time_end || raw.timeEnd) : (existing?.timeEnd || null),
      expiresAt,
    };
    // 如果没有有效内容则跳过
    if (!patch.title && !patch.summary && !patch.progressNote) continue;

    if (existing) {
      // 已有关闭的弧线不再更新
      if (existing.status === "closed") continue;
      // 更新已有弧线
      Object.assign(existing, patch, { status: "active", updatedAt: nowIso });
    } else if (op === "create") {
      // 创建新弧线
      arcs.push({
        id: crypto.randomUUID(),
        status: "active",
        ...patch,
        createdAt: nowIso,
        updatedAt: nowIso,
        closedAt: null,
        closeReason: "",
      });
    }
  }

  roleWorld._lifeArcs = normalizeLifeArcs(arcs, { includeClosed: true });
}

export {
  sessionProfile,
  ensureWorldSession,
  roleWorldKey,
  lifeArcPromptItems,
};
