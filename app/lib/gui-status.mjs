import { addRoute } from "./server.mjs";
import { token, activeAI, sessions, modelNames } from "./state.mjs";
import { sessionProfile, getRoleWorld } from "./world-state.mjs";
import { getSceneConfig } from "./normalize.mjs";

export function registerStatusRoutes() {
  addRoute("GET", "/api/status", () => {
    const ccCount = Array.from(sessions.cc.values()).reduce((s, u) => s + u.list.length, 0);
    const codexCount = Array.from(sessions.codex.values()).reduce((s, u) => s + u.list.length, 0);

    // API backend context info
    let activeApiMsgs = 0, activeApiTurns = 0;
    for (const [, u] of sessions.cc) {
      for (const s of u.list) {
        if (s.id === u.activeId) {
          activeApiMsgs = s._apiMessages?.length || 0;
          activeApiTurns = s._turnCount || 0;
        }
      }
    }

    // CC backend context info
    let ccContext = null;
    if (activeAI === "cc") {
      let activeSess = null;
      for (const [, u] of sessions.cc) {
        for (const s of u.list) {
          if (s.id === u.activeId) { activeSess = s; break; }
        }
        if (activeSess) break;
      }
      if (activeSess) {
        const profile = sessionProfile(activeSess);
        const roleWorld = profile ? getRoleWorld(profile) : null;
        const cfg = getSceneConfig();
        const userTokens = activeSess._lastUsage?.input_tokens || 0;
        const hwTokens = roleWorld?._worldSession?.lastUsage?.input_tokens || 0;
        const CTX_MAX = 1_000_000;
        ccContext = {
          profile: profile || "",
          turnCount: activeSess._turnCount || 0,
          turnThreshold: cfg.turnResetThreshold,
          userCtx: { tokens: userTokens, max: CTX_MAX },
          hwCtx: { tokens: hwTokens, max: CTX_MAX },
          sceneMemory: roleWorld?._sceneMemory || "",
        };
      }
    }

    return {
      ok: true,
      online: Boolean(token),
      currentAI: activeAI,
      currentModel: modelNames[activeAI] || "unknown",
      sessions: { cc: ccCount, codex: codexCount },
      apiContext: activeAI === "api" ? { messages: activeApiMsgs, turns: activeApiTurns } : null,
      ccContext,
    };
  });
}
