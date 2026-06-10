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

function saveSessions() {
  if (typeof globalThis.__wechatSaveSessions === "function") {
    globalThis.__wechatSaveSessions();
  }
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
          turnCount: s._turnCount || 0,
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

  addRoute("POST", "/api/world/reset", async ({ body }) => {
    const profile = roleKey(body?.profile);
    const now = new Date().toISOString();
    const roleWorld = getRoleWorld(profile);

    // Step 1: Generate scene memory from accumulated context (before resetting state)
    let generated = false;
    for (const [userId, u] of sessions.cc) {
      for (const s of u.list || []) {
        if (roleKey(s._profile || "默认") !== profile) continue;
        if (!s.active) continue;
        try {
          const summary = await generateSceneMemory({ userId, sess: s, profile, roleWorld });
          if (summary) {
            setSceneMemory(roleWorld, summary);
            generated = true;
          }
        } catch (e) {
          console.error("[gui] scene memory generation failed:", e.message);
        }
      }
    }

    // Step 2: Reset session state
    for (const [, u] of sessions.cc) {
      for (const s of u.list || []) {
        if (roleKey(s._profile || "默认") !== profile) continue;
        if (!s.active) continue;

        s.sid = crypto.randomUUID();
        s._firstTurn = true;
        s._turnCount = 0;

        if (s._worldSession) {
          s._worldSession.sid = crypto.randomUUID();
          s._worldSession.firstTurn = true;
          s._worldSession.startedAt = now;
          s._worldSession.resetReason = "manual from GUI";
        }
      }
    }

    if (roleWorld?._worldSession) {
      roleWorld._worldSession.sid = crypto.randomUUID();
      roleWorld._worldSession.firstTurn = true;
      roleWorld._worldSession.startedAt = now;
      roleWorld._worldSession.resetReason = "manual from GUI";
    }

    saveSessions();
    saveWorlds();
    return { ok: true, sceneMemoryGenerated: generated };
  });

}
