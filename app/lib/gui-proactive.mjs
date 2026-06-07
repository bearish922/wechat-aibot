import { addRoute } from "./server.mjs";
import { sessions, activeAI } from "./state.mjs";

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
      currentState: a.currentState || "",
      nextUsefulMoment: a.nextUsefulMoment || "",
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
    const result = [];
    for (const [ai, map] of Object.entries(sessions)) {
      for (const [, u] of map) {
        for (const s of u.list) {
          const intents = uniqueIntents(s._proactiveIntents || []);
          const lifeArcs = allLifeArcs(s._lifeArcs || []);
          if (!intents.length && !lifeArcs.length) continue;
          result.push({
            sessionId: s.id,
            sessionName: s.name,
            ai,
            profile: s._profile || "default",
            active: s.id === u.activeId,
            busy: s.busy || false,
            lifeArcs,
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
