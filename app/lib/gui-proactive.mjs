import { addRoute } from "./server.mjs";
import { sessions, activeAI } from "./state.mjs";

export function registerProactiveRoutes() {
  addRoute("GET", "/api/proactive/intents", () => {
    const result = [];
    for (const [ai, map] of Object.entries(sessions)) {
      for (const [, u] of map) {
        for (const s of u.list) {
          const intents = (s._proactiveIntents || []);
          if (!intents.length) continue;
          result.push({
            sessionId: s.id,
            sessionName: s.name,
            ai,
            profile: s._profile || "default",
            active: s.id === u.activeId,
            busy: s.busy || false,
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
