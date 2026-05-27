import { addRoute } from "./server.mjs";
import { token, activeAI, sessions, modelNames } from "./state.mjs";

export function registerStatusRoutes() {
  addRoute("GET", "/api/status", () => {
    const ccCount = Array.from(sessions.cc.values()).reduce((s, u) => s + u.list.length, 0);
    const codexCount = Array.from(sessions.codex.values()).reduce((s, u) => s + u.list.length, 0);
    return {
      ok: true,
      online: Boolean(token),
      currentAI: activeAI,
      currentModel: modelNames[activeAI] || "unknown",
      sessions: { cc: ccCount, codex: codexCount },
    };
  });
}
