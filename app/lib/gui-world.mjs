import crypto from "node:crypto";
import { addRoute } from "./server.mjs";
import { sessions, activeAI, profileTemplates } from "./state.mjs";
import { generateSceneMemory } from "./turn.mjs";
import { getRoleWorld, setSceneMemory } from "./world-state.mjs";

function worldsMap() {
  return globalThis.__wechatRoleWorlds;
}

function saveWorlds() {
  if (typeof globalThis.__wechatSaveRoleWorlds === "function") {
    globalThis.__wechatSaveRoleWorlds();
  }
}

function roleKey(profile) {
  return String(profile || "默认").trim() || "默认";
}

export function activeSessionEntriesForProfile(sessionMap, profile, ai = null) {
  const key = roleKey(profile);
  const entries = [];
  for (const [userId, u] of sessionMap || new Map()) {
    const active = (u.list || []).find(s => s.id === u.activeId);
    if (!active || roleKey(active._profile || "默认") !== key) continue;
    entries.push({ ...(ai ? { ai } : {}), userId, user: u, session: active });
  }
  return entries;
}

function saveSessions() {
  if (typeof globalThis.__wechatSaveSessions === "function") {
    globalThis.__wechatSaveSessions();
  }
}

function sessionRowsForProfile(profile) {
  const key = roleKey(profile);
  const world = worldsMap()?.get?.(key) || {};
  const sharedIntents = world._proactiveIntents || [];
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
          turnCount: s._turnCount || 0,
          visibleTurns: Array.isArray(s._visibleHistory) ? s._visibleHistory.length : 0,
          pendingIntents: sharedIntents.filter(i => i?.status === "pending").length,
          intents: sharedIntents,
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
    worldSession: world._worldSessions?.[activeAI] || null,
    worldSessions: world._worldSessions || {},
    lifeArcs: world._lifeArcs || [],
    lastDailyShareSeedAt: world._lastDailyShareSeedAt || null,
    lastScheduleCheckAt: world._lastScheduleCheckAt || null,
    sceneMemory: world._sceneMemory || null,
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

  addRoute("PUT", "/api/world/scene-memory", ({ body }) => {
    const profile = roleKey(body?.profile);
    const backend = body?.backend || activeAI;
    const content = String(body?.content ?? "").slice(0, 8000);
    const roleWorld = getRoleWorld(profile);
    setSceneMemory(roleWorld, content, backend);
    saveWorlds();
    return { ok: true, length: content.length };
  });

  addRoute("POST", "/api/world/reset", async ({ body }) => {
    const profile = roleKey(body?.profile);
    const now = new Date().toISOString();
    const roleWorld = getRoleWorld(profile);
    const activeSessions = Object.entries(sessions).flatMap(([ai, map]) => activeSessionEntriesForProfile(map, profile, ai));

    // Step 1: Generate scene memory from accumulated context (before resetting state)
    let generated = false;
    const preferred = activeSessions.filter(entry => entry.ai === activeAI);
    for (const { ai, userId, session } of (preferred.length ? preferred : activeSessions)) {
      try {
        const summary = await generateSceneMemory({ ai, userId, sess: session, profile, roleWorld });
        if (summary) {
          setSceneMemory(roleWorld, summary, ai);
          generated = true;
          break;
        }
      } catch (e) {
        console.error("[gui] scene memory generation failed:", e.message);
      }
    }

    // Step 2: Reset session state
    for (const { session } of activeSessions) {
      session.sid = crypto.randomUUID();
      session._firstTurn = true;
      session._turnCount = 0;
      session._lastUsage = null;
    }

    for (const [backend, worldSession] of Object.entries(roleWorld?._worldSessions || {})) {
      if (!activeSessions.some(e => e.ai === backend)) continue;
      worldSession.sid = crypto.randomUUID();
      worldSession.firstTurn = true;
      worldSession.startedAt = now;
      worldSession.resetReason = "manual from GUI";
      worldSession.turnCount = 0;
      worldSession.lastUsage = null;
    }

    saveSessions();
    saveWorlds();
    return { ok: true, sceneMemoryGenerated: generated };
  });

}
