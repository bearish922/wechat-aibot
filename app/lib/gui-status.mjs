import { addRoute } from "./server.mjs";
import { token, activeAI, sessions, modelNames } from "./state.mjs";
import { sessionProfile, getRoleWorld } from "./world-state.mjs";
import { getSceneConfig } from "./normalize.mjs";
import { configNumber } from "./config.mjs";
import { contextTokensForUsage, contextWindowForUsage } from "./context-pressure.mjs";
import { repairCodexUsageFromSession } from "./codex-session-usage.mjs";

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

function contextTokens(usage, backend = "") {
  return contextTokensForUsage(usage, backend);
}

function contextMax(backend, usage) {
  const cfgMax = backend === "codex"
    ? configNumber("models.codexContextMax", 1_000_000)
    : configNumber("models.claudeContextMax", 1_000_000);
  // 上游有真实窗口上报时必须如实显示；配置值只用于未上报场景。
  // 这样错误选到 200k alias 时不会被默认 1M 静默掩盖。
  return contextWindowForUsage(usage, cfgMax);
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

      // 按后端选择累计 token 来源
      let userTokens, userTurns, hwTokens, hwTurns;
      if (activeAI === "cc") {
        // 单 Actor 架构：user 和 hidden world 共用一个 world session，直接读内存 usage
        const usage = worldSession?.lastUsage;
        userTokens = contextTokens(usage, activeAI);
        userTurns = worldSession?.turnCount || activeSess._turnCount || 0;
        hwTokens = userTokens;
        hwTurns = userTurns;
      } else if (activeAI === "codex") {
        // Codex reports current context pressure in last_token_usage; total_token_usage is billing-style cumulative usage.
        const uu = repairCodexUsageFromSession(activeSess._lastUsage, activeSess._lastUsage?.session_id || activeSess.sid);
        const wu = repairCodexUsageFromSession(worldSession?.lastUsage, worldSession?.lastUsage?.session_id || worldSession?.sid);
        userTokens = contextTokens(uu, activeAI);
        userTurns = activeSess._turnCount || 0;
        hwTokens = contextTokens(wu, activeAI);
        hwTurns = worldSession?.turnCount || 0;
      } else {
        userTokens = contextTokens(activeSess._lastUsage, activeAI);
        userTurns = activeSess._turnCount || 0;
        hwTokens = contextTokens(worldSession?.lastUsage, activeAI);
        hwTurns = worldSession?.turnCount || 0;
      }

      const activeUsage = activeAI === "codex"
        ? repairCodexUsageFromSession(activeSess._lastUsage, activeSess._lastUsage?.session_id || activeSess.sid)
        : activeSess._lastUsage;
      const worldUsage = activeAI === "codex"
        ? repairCodexUsageFromSession(worldSession?.lastUsage, worldSession?.lastUsage?.session_id || worldSession?.sid)
        : worldSession?.lastUsage;
      const max = contextMax(activeAI, activeUsage);
      const worldMax = contextMax(activeAI, worldUsage) || max;

      ccContext = {
        backend: activeAI,
        backendLabel: activeAI === "codex" ? "Codex" : "CC",
        profile: profile || "",
        // 顶部 Turn 是自动 reset 的计数器：角色会话使用共享 Actor 主 session 调用次数。
        turnCount: worldSession?.turnCount || activeSess._turnCount || 0,
        turnThreshold: cfg.turnResetThreshold,
        contextResetRatio: cfg.contextResetRatio,
        userCtx: { tokens: userTokens, max, turns: userTurns },
        hwCtx: { tokens: hwTokens, max: worldMax, turns: hwTurns },
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
