import crypto from "node:crypto";
import { addRoute } from "./server.mjs";
import { sessions, activeAI, profileTemplates } from "./state.mjs";

function worldsMap() {
  return globalThis.__wechatRoleWorlds;
}

function saveWorlds() {
  if (typeof globalThis.__wechatSaveRoleWorlds === "function") {
    globalThis.__wechatSaveRoleWorlds();
  }
}

function saveSessions() {
  if (typeof globalThis.__wechatSaveSessions === "function") {
    globalThis.__wechatSaveSessions();
  }
}

function roleKey(profile) {
  return String(profile || "默认").trim() || "默认";
}

function sessionRowsForProfile(profile) {
  const key = roleKey(profile);
  const rows = [];
  for (const [ai, map] of Object.entries(sessions)) {
    for (const [userId, u] of map) {
      for (const s of u.list) {
        if (roleKey(s._profile || "默认") !== key) continue;
        rows.push({
          ai,
          userId,
          sessionId: s.id,
          sessionName: s.name,
          active: s.id === u.activeId,
          busy: Boolean(s.busy),
          sid: s.sid,
          firstTurn: Boolean(s._firstTurn),
          visibleTurns: Array.isArray(s._visibleHistory) ? s._visibleHistory.length : 0,
          pendingIntents: (s._proactiveIntents || []).filter(i => i?.status === "pending").length,
          intents: s._proactiveIntents || [],
        });
      }
    }
  }
  return rows;
}

function safeWorld(profile) {
  const key = roleKey(profile);
  const world = worldsMap()?.get?.(key) || {};
  return {
    profile: key,
    worldState: world._worldState || null,
    worldSession: world._worldSession || null,
    lastOutput: world._worldLastOutput || null,
    continuityWarnings: world._continuityWarnings || [],
    lifeArcs: world._lifeArcs || [],
    lastDailyShareSeedAt: world._lastDailyShareSeedAt || null,
    lastScheduleCheckAt: world._lastScheduleCheckAt || null,
    updatedAt: world.updatedAt || null,
    sessions: sessionRowsForProfile(key),
    threadIntents: sessionRowsForProfile(key).map(s => ({
      ai: s.ai,
      sessionId: s.sessionId,
      sessionName: s.sessionName,
      intents: s.intents || [],
    })),
  };
}

function allProfiles() {
  const names = new Set(Object.keys(profileTemplates || {}));
  for (const key of worldsMap()?.keys?.() || []) names.add(key);
  return [...names].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function parseObject(value, fallback) {
  if (value === undefined) return fallback;
  if (value === null || value === "") return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(String(value)); } catch {
    throw new Error("invalid JSON snapshot field");
  }
}

function syncSessions(profile, world) {
  const key = roleKey(profile);
  for (const [, map] of Object.entries(sessions)) {
    for (const [, u] of map) {
      for (const s of u.list) {
        if (roleKey(s._profile || "默认") !== key) continue;
        s._worldState = world._worldState || null;
        s._worldSession = world._worldSession || null;
        s._worldLastOutput = world._worldLastOutput || null;
        s._lifeArcs = Array.isArray(world._lifeArcs) ? world._lifeArcs : [];
        s._continuityWarnings = world._continuityWarnings || [];
        s._lastDailyShareSeedAt = world._lastDailyShareSeedAt || null;
        s._lastScheduleCheckAt = world._lastScheduleCheckAt || null;
      }
    }
  }
}

function applyThreadIntents(threadIntents = []) {
  if (!Array.isArray(threadIntents)) return;
  const byKey = new Map(threadIntents.map(item => [`${item.ai}|${item.sessionId}`, item]));
  for (const [ai, map] of Object.entries(sessions)) {
    for (const [, u] of map) {
      for (const s of u.list) {
        const item = byKey.get(`${ai}|${s.id}`);
        if (item && Array.isArray(item.intents)) s._proactiveIntents = item.intents;
      }
    }
  }
}

export function registerWorldRoutes() {
  addRoute("GET", "/api/world/roles", () => ({
    ok: true,
    currentAI: activeAI,
    profiles: allProfiles(),
    roles: allProfiles().map(safeWorld),
  }));

  addRoute("GET", "/api/world/roles/:profile", ({ params }) => ({
    ok: true,
    role: safeWorld(params.profile),
  }));

  addRoute("POST", "/api/world/reset", ({ body }) => {
    const profile = roleKey(body?.profile);
    const map = worldsMap();
    if (!map) return { ok: false, error: "role world store unavailable" };
    const current = map.get(profile) || { profile };
    const now = new Date().toISOString();
    const next = {
      ...current,
      profile,
      _worldState: parseObject(body?.worldState, current._worldState || null),
      _lifeArcs: parseObject(body?.lifeArcs, current._lifeArcs || []),
      _continuityWarnings: parseObject(body?.continuityWarnings, current._continuityWarnings || []),
      _worldLastOutput: parseObject(body?.lastOutput, current._worldLastOutput || null),
      _lastDailyShareSeedAt: body?.lastDailyShareSeedAt ?? current._lastDailyShareSeedAt ?? null,
      _lastScheduleCheckAt: body?.lastScheduleCheckAt ?? current._lastScheduleCheckAt ?? null,
      _worldSession: {
        sid: crypto.randomUUID(),
        firstTurn: true,
        model: current._worldSession?.model || null,
        startedAt: now,
        lastUsedAt: null,
        resetReason: "manual reset from Hidden World GUI",
        lastUsage: null,
      },
      updatedAt: now,
    };
    map.set(profile, next);
    syncSessions(profile, next);
    applyThreadIntents(parseObject(body?.threadIntents, []));
    saveWorlds();
    saveSessions();
    return { ok: true, role: safeWorld(profile) };
  });
}
