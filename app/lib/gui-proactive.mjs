import { addRoute } from "./server.mjs";
import { sessions, activeAI } from "./state.mjs";

function roleWorldForProfile(profile) {
  const worlds = globalThis.__wechatRoleWorlds;
  return worlds?.get?.(profile || "默认") || null;
}

function uniqueIntents(intents = []) {
  const byId = new Map();
  for (const intent of intents) {
    if (!intent?.id) continue;
    byId.set(intent.id, { ...byId.get(intent.id), ...intent });
  }
  return [...byId.values()];
}

function allLifeArcs(arcs = []) {
  return arcs
    .filter(a => a?.id)
    .map(a => ({
      id: a.id,
      title: a.title || "",
      summary: a.summary || "",
      progressNote: a.progressNote || "",
      lifeTexture: a.lifeTexture || null,
      source: a.source || "",
      status: a.status || "active",
      kind: a.kind || null,
      timeStart: a.timeStart || null,
      timeEnd: a.timeEnd || null,
      createdAt: a.createdAt || null,
      updatedAt: a.updatedAt || null,
      expiresAt: a.expiresAt || null,
    }));
}

export function registerProactiveRoutes() {
  addRoute("GET", "/api/proactive/intents", () => {
    const seenProfiles = new Set();
    const result = [];
    for (const [ai, map] of Object.entries(sessions)) {
      for (const [, u] of map) {
        for (const s of u.list) {
          const profile = s._profile || "默认";
          const rw = roleWorldForProfile(profile);
          const lifeArcs = allLifeArcs(rw?._lifeArcs || []);
          const intents = uniqueIntents(rw?._proactiveIntents || []);
          if (!intents.length && !lifeArcs.length) continue;
          const scheduleCandidates = (rw?._pendingScheduleCandidates || []).map(c => ({
            title: c.title || "",
            summary: c.summary || "",
            kind: c.kind || null,
            subject: c.subject || null,
            timeStart: c.timeStart || null,
            timeEnd: c.timeEnd || null,
            basis: c.basis || "",
          }));
          // intents 已跨后端共享，同一 profile 只返回首条 session
          if (seenProfiles.has(profile)) continue;
          seenProfiles.add(profile);
          result.push({
            sessionId: s.id,
            sessionName: s.name,
            ai,
            profile,
            active: s.id === u.activeId,
            busy: s.busy || false,
            lifeArcs,
            scheduleCandidates,
            intents: intents.map(i => ({
              id: i.id,
              status: i.status,
              createdAt: i.createdAt,
              scheduledAt: i.scheduledAt,
              expiresAt: i.expiresAt,
              sourceTurnAt: i.sourceTurnAt,
              sourceUserText: i.sourceUserText,
              basis: i.basis,
              cancelIf: i.cancelIf,
              innerScenelet: i.innerScenelet,
              messageIntent: i.messageIntent,
              kind: i.kind,
              lastCheckedAt: i.lastCheckedAt,
              sentAt: i.sentAt,
              cancelledAt: i.cancelledAt,
              cancelReason: i.cancelReason,
            })),
          });
        }
      }
    }
    return { ok: true, sessions: result, currentAI: activeAI };
  });
}
