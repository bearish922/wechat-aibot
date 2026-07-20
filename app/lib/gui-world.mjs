import crypto from "node:crypto";
import { addRoute } from "./server.mjs";
import { sessions, activeAI, profileTemplates } from "./state.mjs";
import { generateSceneMemory, batchUpdateMemory } from "./turn.mjs";
import { getRoleWorld, setSceneMemory, resetWorldSession } from "./world-state.mjs";
import { loadAllEvents } from "./chat-history.mjs";
import { archiveAndHardResetWorldlines, createWorldlineArchive, listWorldlineArchives } from "./worldline-archive.mjs";
import { getSceneConfig } from "./normalize.mjs";
import { beijingISO } from "./reply.mjs";

function worldsMap() {
  return globalThis.__wechatRoleWorlds;
}

function saveWorlds() {
  if (typeof globalThis.__wechatSaveRoleWorlds === "function") {
    return globalThis.__wechatSaveRoleWorlds() !== false;
  }
  return false;
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

  addRoute("GET", "/api/worldline/archives", () => ({
    ok: true,
    archives: listWorldlineArchives(),
  }));

  addRoute("POST", "/api/worldline/archive", async ({ body }) => {
    const profiles = Array.isArray(body?.profiles) ? body.profiles.map(roleKey) : [];
    const reason = String(body?.reason || "").trim();
    const archive = await createWorldlineArchive({ profiles, reason, hardReset: false });
    return { ok: true, archiveId: archive.archiveId, archiveDir: archive.archiveDir, manifest: archive.manifest };
  });

  addRoute("POST", "/api/worldline/archive-reset", async ({ body }) => {
    const profiles = Array.isArray(body?.profiles) ? body.profiles.map(roleKey) : [];
    const reason = String(body?.reason || "hard reset from GUI").trim();
    const result = await archiveAndHardResetWorldlines({ profiles, reason });
    return {
      ok: true,
      archiveId: result.archiveId,
      archiveDir: result.archiveDir,
      deletedEvents: result.deletedEvents,
      resetSessions: result.resetSessions,
    };
  });

  addRoute("PUT", "/api/world/scene-memory", ({ body }) => {
    const profile = roleKey(body?.profile);
    const backend = body?.backend || activeAI;
    const content = String(body?.content ?? "").slice(0, 8000);
    const roleWorld = getRoleWorld(profile);
    setSceneMemory(roleWorld, content, backend);
    if (!saveWorlds()) throw new Error("failed to persist scene memory");
    return { ok: true, length: content.length };
  });

  addRoute("POST", "/api/world/reset", async ({ body }) => {
    const profile = roleKey(body?.profile);
    const now = beijingISO();
    const roleWorld = getRoleWorld(profile);
    const activeSessions = activeSessionEntriesForProfile(sessions[activeAI], profile, activeAI);
    if (!activeSessions.length) throw new Error(`No active session found for ${profile}`);

    const resetEntries = [];
    for (const entry of activeSessions) {
      const worldSession = roleWorld?._worldSessions?.[activeAI];
      if (!worldSession?.sid) continue;
      if (!Number.isFinite(Date.parse(worldSession.startedAt || ""))) {
        throw new Error(`${activeAI} Actor reset blocked: session start time is missing`);
      }
      resetEntries.push({ ...entry, worldSession });
    }
    if (!resetEntries.length) throw new Error(`No initialized Actor session found for ${profile}`);

    // Generate scene memory first. A failed summary must leave the SID untouched.
    const summaries = new Map();
    for (const { ai, userId, session, worldSession } of resetEntries) {
      const summary = await generateSceneMemory({
        ai,
        userId,
        sess: session,
        profile,
        roleWorld,
        maxTurns: worldSession.turnCount || getSceneConfig().turnResetThreshold,
        since: worldSession.startedAt,
      });
      if (!String(summary || "").trim()) {
        throw new Error(`${ai} Actor reset blocked: scene memory generation returned empty`);
      }
      summaries.set(ai, summary);
    }

    // Update long-term memory from the complete persisted interval, grouped by user.
    const allEvents = await loadAllEvents();
    const users = new Map();
    for (const entry of resetEntries) {
      const startedMs = Date.parse(entry.worldSession.startedAt);
      const current = users.get(entry.userId);
      if (!current || startedMs < current.startedMs) {
        users.set(entry.userId, { ai: entry.ai, startedMs });
      }
    }
    for (const [userId, scope] of users) {
      const userMessages = allEvents
        .filter(event => {
          if (event.userId !== userId || event.profile !== profile || event.role !== "user" || !event.text) return false;
          const eventMs = Date.parse(event.timestamp || "");
          return Number.isFinite(eventMs) && eventMs >= scope.startedMs;
        })
        .map(event => event.text);
      await batchUpdateMemory({ ai: scope.ai, userId, userMessages, profile });
    }

    const worldSnapshots = new Map();
    let worldSnapshotSaved = false;
    if (resetEntries.length > 0) {
      const { ai, worldSession } = resetEntries[0];
      worldSnapshots.set(ai, structuredClone(worldSession));
      worldSnapshotSaved = true;
    }
    const sceneMemorySnapshot = structuredClone(roleWorld._sceneMemory || {});
    const sceneMemoryAtSnapshot = structuredClone(roleWorld._sceneMemoryAt || {});
    const sessionSnapshots = activeSessions.map(({ session }) => ({
      session,
      sid: session.sid,
      firstTurn: session._firstTurn,
      turnCount: session._turnCount,
      lastUsage: session._lastUsage,
    }));

    try {
      if (worldSnapshotSaved) {
        const { ai } = resetEntries[0];
        setSceneMemory(roleWorld, summaries.get(ai), ai);
        resetWorldSession(roleWorld, ai, "manual from GUI", now);
      }
      for (const { session } of activeSessions) {
        session.sid = crypto.randomUUID();
        session._firstTurn = true;
        session._turnCount = 0;
        session._lastUsage = null;
      }
      if (!saveWorlds()) throw new Error("failed to persist Actor sessions");
      saveSessions();
    } catch (error) {
      for (const [ai, snapshot] of worldSnapshots) roleWorld._worldSessions[ai] = snapshot;
      roleWorld._sceneMemory = sceneMemorySnapshot;
      roleWorld._sceneMemoryAt = sceneMemoryAtSnapshot;
      for (const snapshot of sessionSnapshots) {
        snapshot.session.sid = snapshot.sid;
        snapshot.session._firstTurn = snapshot.firstTurn;
        snapshot.session._turnCount = snapshot.turnCount;
        snapshot.session._lastUsage = snapshot.lastUsage;
      }
      saveWorlds();
      saveSessions();
      throw error;
    }

    return { ok: true, sceneMemoryGenerated: true };
  });

}
