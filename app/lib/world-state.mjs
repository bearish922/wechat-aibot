import fs from "node:fs";
import crypto from "node:crypto";
import { uuid } from "./utils.mjs";
import { log } from "./utils.mjs";
import { DATA_DIR, dataPath, ensureDir } from "./paths.mjs";
import { sessions, profileTemplates } from "./state.mjs";
import { normalizeWorldState, normalizeWorldSession, normalizeWorldLastOutput, normalizeLifeArcs, getSceneConfig } from "./normalize.mjs";
import { CLAUDE_MAIN_MODEL, CLAUDE_FAST_MODEL, runHiddenJson } from "./claude-runner.mjs";

function sessionProfile(sess) {
  return sess?._profile ?? null;
}

function ensureWorldSession(sess) {
  if (!sess._worldSession) {
    const nowIso = new Date().toISOString();
    sess._worldSession = {
      sid: uuid(),
      firstTurn: true,
      model: CLAUDE_MAIN_MODEL,
      startedAt: nowIso,
      lastUsedAt: null,
      resetReason: "",
      lastUsage: null,
    };
  } else {
    sess._worldSession = normalizeWorldSession(sess._worldSession) || null;
    if (!sess._worldSession) return ensureWorldSession(sess);
    if (!sess._worldSession.sid) {
      sess._worldSession.sid = uuid();
      sess._worldSession.firstTurn = true;
    }
    if (!sess._worldSession.model) sess._worldSession.model = CLAUDE_MAIN_MODEL;
  }
  return sess._worldSession;
}

function roleWorldKey(profile) {
  return String(profile || "默认").trim() || "默认";
}

function normalizeRoleWorld(raw = {}, profile = "默认") {
  const nowIso = new Date().toISOString();
  return {
    profile: roleWorldKey(raw.profile || profile),
    _worldState: normalizeWorldState(raw._worldState || raw.worldState),
    _worldSession: normalizeWorldSession(raw._worldSession || raw.worldSession) || {
      sid: uuid(),
      firstTurn: true,
      model: CLAUDE_MAIN_MODEL,
      startedAt: nowIso,
      lastUsedAt: null,
      resetReason: "",
      lastUsage: null,
    },
    _worldLastOutput: normalizeWorldLastOutput(raw._worldLastOutput || raw.worldLastOutput),
    _lifeArcs: normalizeLifeArcs(raw._lifeArcs || raw.lifeArcs, { includeClosed: true }),
    _lastDailyShareSeedAt: raw._lastDailyShareSeedAt ? String(raw._lastDailyShareSeedAt) : null,
    _lastScheduleCheckAt: raw._lastScheduleCheckAt ? String(raw._lastScheduleCheckAt) : null,
    _pendingScheduleCandidates: Array.isArray(raw._pendingScheduleCandidates) ? raw._pendingScheduleCandidates : [],
    _sceneMemory: typeof raw._sceneMemory === "string" ? raw._sceneMemory.slice(0, 8000) : "",
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : nowIso,
  };
}

function roleWorldSnapshot(world) {
  return {
    profile: roleWorldKey(world?.profile),
    _worldState: normalizeWorldState(world?._worldState),
    _worldSession: normalizeWorldSession(world?._worldSession),
    _worldLastOutput: normalizeWorldLastOutput(world?._worldLastOutput),
    _lifeArcs: normalizeLifeArcs(world?._lifeArcs, { includeClosed: true }),
    _lastDailyShareSeedAt: world?._lastDailyShareSeedAt || null,
    _lastScheduleCheckAt: world?._lastScheduleCheckAt || null,
    _pendingScheduleCandidates: Array.isArray(world?._pendingScheduleCandidates) ? world._pendingScheduleCandidates : [],
    _sceneMemory: world?._sceneMemory || "",
    updatedAt: world?.updatedAt || new Date().toISOString(),
  };
}

function markToolUsage(usage, name, count = 1) {
  if (!usage || !name) return;
  const tool = String(name);
  const lower = tool.toLowerCase();
  if (!usage.tools.includes(tool)) usage.tools.push(tool);
  if (/web[_-]?search|websearch/i.test(lower)) usage.webSearch += count;
  if (/web[_-]?fetch|webfetch/i.test(lower)) usage.webFetch += count;
}

function lifeArcPromptItems(roleWorld) {
  return normalizeLifeArcs(roleWorld?._lifeArcs).map(arc => ({
    id: arc.id,
    title: arc.title,
    summary: arc.summary,
    current_state: arc.currentState,
    next_useful_moment: arc.nextUsefulMoment,
    kind: arc.kind || null,
    time_start: arc.timeStart || null,
    time_end: arc.timeEnd || null,
    updated_at: arc.updatedAt,
    expires_at: arc.expiresAt,
  }));
}

const ROLE_WORLD_FILE = dataPath("wechat-worlds.json");

function roleWorldsMap() {
  return globalThis.__wechatRoleWorlds;
}

export function getRoleWorld(profile) {
  const worlds = roleWorldsMap();
  const key = roleWorldKey(profile);
  if (!worlds.has(key)) {
    worlds.set(key, normalizeRoleWorld({ profile: key }, key));
  }
  return worlds.get(key);
}

export function getSceneMemory(roleWorld) {
  return roleWorld?._sceneMemory || "";
}

export function setSceneMemory(roleWorld, text) {
  if (!roleWorld) return;
  roleWorld._sceneMemory = typeof text === "string" ? text.slice(0, 8000) : "";
  roleWorld.updatedAt = new Date().toISOString();
}

export function saveRoleWorlds() {
  try {
    const worlds = roleWorldsMap();
    if (!worlds) return;
    ensureDir(DATA_DIR);
    const data = { version: 1, roles: {} };
    for (const [profile, world] of worlds) {
      data.roles[profile] = roleWorldSnapshot(world);
    }
    fs.writeFileSync(ROLE_WORLD_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch (e) {
    log("⚠️", `save hidden worlds failed: ${e.message}`);
  }
}

export function loadRoleWorlds() {
  const worlds = roleWorldsMap();
  if (!worlds) return;
  worlds.clear();
  try {
    if (fs.existsSync(ROLE_WORLD_FILE)) {
      const data = JSON.parse(fs.readFileSync(ROLE_WORLD_FILE, "utf-8"));
      const roles = data?.roles && typeof data.roles === "object" ? data.roles : {};
      for (const [profile, raw] of Object.entries(roles)) {
        worlds.set(roleWorldKey(profile), normalizeRoleWorld(raw, profile));
      }
    }
  } catch (e) {
    log("⚠️", `load hidden worlds failed: ${e.message}`);
  }
  migrateRoleWorldsFromSessions();
  for (const profile of Object.keys(profileTemplates || {})) getRoleWorld(profile);
  saveRoleWorlds();
}

function migrateRoleWorldsFromSessions() {
  const worlds = roleWorldsMap();
  if (!worlds) return;
  for (const map of Object.values(sessions)) {
    for (const [, u] of map) {
      for (const sess of u.list || []) {
        const profile = sessionProfile(sess);
        if (!profile || !profileTemplates[profile]) continue;
        const key = roleWorldKey(profile);
        if (worlds.has(key)) continue;
        const hasWorldData = sess._worldSession || sess._worldState || sess._worldLastOutput || sess._lifeArcs?.length;
        if (!hasWorldData) continue;
        worlds.set(key, normalizeRoleWorld({
          profile: key,
          _worldState: sess._worldState,
          _worldSession: sess._worldSession,
          _worldLastOutput: sess._worldLastOutput,
          _lifeArcs: sess._lifeArcs,
          _lastDailyShareSeedAt: sess._lastDailyShareSeedAt,
          _lastScheduleCheckAt: sess._lastScheduleCheckAt,
        }, key));
      }
    }
  }
}

export function syncRoleWorldToSession(sess, profile) {
  if (!sess || !profile) return;
  const world = getRoleWorld(profile);
  sess._worldState = normalizeWorldState(world._worldState);
  sess._worldSession = normalizeWorldSession(world._worldSession);
  sess._worldLastOutput = normalizeWorldLastOutput(world._worldLastOutput);
  sess._lifeArcs = normalizeLifeArcs(world._lifeArcs, { includeClosed: true });
  sess._lastDailyShareSeedAt = world._lastDailyShareSeedAt || sess._lastDailyShareSeedAt || null;
  sess._lastScheduleCheckAt = world._lastScheduleCheckAt || sess._lastScheduleCheckAt || null;
  sess._pendingScheduleCandidates = Array.isArray(world._pendingScheduleCandidates) ? world._pendingScheduleCandidates : [];
}

export async function checkIntentDuplicateFlash(candidate, existingPending) {
  if (!existingPending.length) return false;
  const prompt = [
    "你判断一条新生成的主动消息意图，是否与已有意图本质上是重复的。",
    "重复 = 讲的是同一件事、目的相同，只是措辞不同。",
    "不重复 = 不同话题，或相同话题但目的明显不同（如追问结果 vs 分享经验）。",
    "",
    "新意图：",
    JSON.stringify({ kind: candidate.kind, intent: candidate.messageIntent }, null, 2),
    "",
    "已有意图（编号从1开始）：",
    existingPending.map((e, i) => `${i + 1}. [${e.kind}] ${e.messageIntent}`).join("\n"),
    "",
    "只输出 JSON，不要解释：",
    JSON.stringify({ duplicate: false }, null, 2),
  ].join("\n");
  const result = await runHiddenJson(prompt, {
    label: "intent_dedup",
    bare: true,
    model: CLAUDE_MAIN_MODEL,
    timeoutMs: 30_000,
  });
  if (!result) return true;
  return Boolean(result.duplicate);
}

export function applyLifeArcOps(roleWorld, rawOps = []) {
  if (!roleWorld || !Array.isArray(rawOps) || !rawOps.length) return;
  const now = new Date();
  const nowIso = now.toISOString();
  const defaultExpiresAt = new Date(now.getTime() + getSceneConfig().scheduleDefaultExpiryFromNowMs).toISOString();
  const arcs = normalizeLifeArcs(roleWorld._lifeArcs, { includeClosed: true });
  const findArc = (raw) => {
    const id = raw?.id ? String(raw.id) : "";
    if (id) {
      const byId = arcs.find(a => a.id === id);
      if (byId) return byId;
    }
    const title = raw?.title ? String(raw.title).trim().toLowerCase() : "";
    return title ? arcs.find(a => a.title.toLowerCase() === title) : null;
  };

  for (const raw of rawOps.slice(0, 5)) {
    if (!raw || typeof raw !== "object") continue;
    const op = String(raw.op || "").toLowerCase();
    if (!["create", "update", "close"].includes(op)) continue;
    const existing = findArc(raw);
    if (op === "close") {
      if (!existing) continue;
      existing.status = "closed";
      existing.updatedAt = nowIso;
      existing.closedAt = nowIso;
      existing.closeReason = raw.reason ? String(raw.reason).slice(0, 300) : existing.closeReason || "closed by scenelet";
      existing.expiresAt = nowIso;
      continue;
    }

    const expiresAt = raw.expires_at || raw.expiresAt ? String(raw.expires_at || raw.expiresAt) : (existing?.expiresAt || defaultExpiresAt);
    const lifeArcKinds = ["travel", "work", "school", "personal", "special_date"];
    const lifeArcSubjects = ["role", "user", "shared"];
    const kind = lifeArcKinds.includes(raw.kind) ? raw.kind : (existing?.kind || null);
    const subject = lifeArcSubjects.includes(raw.subject) ? raw.subject : (existing?.subject || null);
    const patch = {
      title: raw.title ? String(raw.title).trim().slice(0, 80) : existing?.title || "",
      summary: raw.summary ? String(raw.summary).trim().slice(0, 500) : existing?.summary || "",
      currentState: raw.current_state || raw.currentState ? String(raw.current_state || raw.currentState).trim().slice(0, 500) : existing?.currentState || "",
      nextUsefulMoment: raw.next_useful_moment || raw.nextUsefulMoment ? String(raw.next_useful_moment || raw.nextUsefulMoment).trim().slice(0, 300) : existing?.nextUsefulMoment || "",
      source: raw.reason ? String(raw.reason).trim().slice(0, 300) : existing?.source || "",
      kind,
      subject,
      timeStart: raw.time_start || raw.timeStart ? String(raw.time_start || raw.timeStart) : (existing?.timeStart || null),
      timeEnd: raw.time_end || raw.timeEnd ? String(raw.time_end || raw.timeEnd) : (existing?.timeEnd || null),
      expiresAt,
    };
    if (!patch.title && !patch.summary && !patch.currentState) continue;
    if (existing) {
      if (existing.status === "closed") continue;
      Object.assign(existing, patch, { status: "active", updatedAt: nowIso });
    } else if (op === "create") {
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

  roleWorld._lifeArcs = normalizeLifeArcs(arcs, { includeClosed: true }).slice(-6);
}

export {
  sessionProfile,
  ensureWorldSession,
  roleWorldKey,
  markToolUsage,
  lifeArcPromptItems,
};
