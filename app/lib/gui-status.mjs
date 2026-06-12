import { addRoute } from "./server.mjs";
import { token, activeAI, sessions, modelNames } from "./state.mjs";
import { sessionProfile, getRoleWorld } from "./world-state.mjs";
import { getSceneConfig } from "./normalize.mjs";
import { configNumber } from "./config.mjs";
import { readClaudeSessionContext } from "./claude-context.mjs";

function activeSessionForBackend(backend) {
  let newest = null;
  let newestAt = -1;
  for (const [, user] of sessions[backend] || new Map()) {
    const active = (user.list || []).find(session => session.id === user.activeId);
    if (!active) continue;
    const at = Math.max(
      new Date(active._lastUserAt || 0).getTime() || 0,
      new Date(active._lastAssistantAt || 0).getTime() || 0,
    );
    if (!newest || at > newestAt) {
      newest = active;
      newestAt = at;
    }
  }
  return newest;
}

function contextTokens(usage, backend) {
  if (!usage) return 0;
  const input = Number(usage.input_tokens || 0) || 0;
  const output = Number(usage.output_tokens || 0) || 0;
  if (backend === "codex" || backend === "api") return input + output;
  return input
    + (Number(usage.cache_read_input_tokens || 0) || 0)
    + (Number(usage.cache_creation_input_tokens || 0) || 0)
    + output;
}

function contextMax(backend) {
  if (backend === "codex") return configNumber("models.codexContextMax", 1_000_000);
  return configNumber("models.claudeContextMax", 1_000_000);
}

export function registerStatusRoutes() {
  addRoute("GET", "/api/status", () => {
    const counts = {};
    for (const [backend, map] of Object.entries(sessions)) {
      counts[backend] = Array.from(map.values()).reduce((sum, user) => sum + user.list.length, 0);
    }

    const activeSess = activeSessionForBackend(activeAI);
    const activeProfile = activeSess ? sessionProfile(activeSess) : "";
    const activeApiMsgs = activeAI === "api" ? activeSess?._apiMessages?.length || 0 : 0;
    const activeApiTurns = activeAI === "api" ? activeSess?._turnCount || 0 : 0;

    // Keep the historical response key for frontend compatibility; the data now follows current backend.
    let ccContext = null;
    if ((activeAI === "cc" || activeAI === "codex") && activeSess) {
      const profile = sessionProfile(activeSess);
      const roleWorld = profile ? getRoleWorld(profile) : null;
      const worldSession = roleWorld?._worldSessions?.[activeAI] || null;
      const cfg = getSceneConfig();
      const userTranscript = activeAI === "cc" ? readClaudeSessionContext(activeSess.sid) : null;
      const hwTranscript = activeAI === "cc" ? readClaudeSessionContext(worldSession?.sid) : null;
      const max = Number(activeSess._lastUsage?.model_context_window || 0) || contextMax(activeAI);
      const worldMax = Number(worldSession?.lastUsage?.model_context_window || 0) || max;
      ccContext = {
        backend: activeAI,
        backendLabel: activeAI === "codex" ? "Codex" : "CC",
        profile: profile || "",
        turnCount: activeSess._turnCount || 0,
        turnThreshold: cfg.turnResetThreshold,
        userCtx: {
          tokens: userTranscript?.tokens ?? contextTokens(activeSess._lastUsage, activeAI),
          max,
          turns: userTranscript?.promptCount || activeSess._turnCount || 0,
        },
        hwCtx: {
          tokens: hwTranscript?.tokens ?? contextTokens(worldSession?.lastUsage, activeAI),
          max: worldMax,
          turns: hwTranscript?.promptCount || worldSession?.turnCount || 0,
        },
        sceneMemory: roleWorld?._sceneMemory?.[activeAI] || "",
      };
    }

    return {
      ok: true,
      online: Boolean(token),
      currentAI: activeAI,
      currentModel: modelNames[activeAI] || "unknown",
      activeProfile: activeProfile || "",
      sessions: counts,
      apiContext: activeAI === "api" ? { messages: activeApiMsgs, turns: activeApiTurns } : null,
      ccContext,
    };
  });
}
