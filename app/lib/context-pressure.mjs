export function contextTokensForUsage(usage, backend = "") {
  if (!usage) return 0;
  const inputTokens = Number(usage.input_tokens || 0) || 0;
  const outputTokens = Number(usage.output_tokens || 0) || 0;
  if (backend === "codex" || backend === "api") return inputTokens + outputTokens;
  return inputTokens
    + (Number(usage.cache_read_input_tokens || 0) || 0)
    + (Number(usage.cache_creation_input_tokens || 0) || 0)
    + outputTokens;
}

export function contextWindowForUsage(usage, fallback = 0) {
  const reported = Number(usage?.model_context_window || 0) || 0;
  return reported > 0 ? reported : (Number(fallback || 0) || 0);
}

export function contextPressureForUsage(usage, backend = "", fallbackWindow = 0) {
  const tokens = contextTokensForUsage(usage, backend);
  const max = contextWindowForUsage(usage, fallbackWindow);
  const ratio = tokens > 0 && max > 0 ? tokens / max : 0;
  return { tokens, max, ratio, known: tokens > 0 && max > 0 };
}

export function shouldResetActorSession({
  usage = null,
  backend = "",
  turnCount = 0,
  turnThreshold = 30,
  ratioThreshold = 0.5,
  fallbackWindow = 0,
} = {}) {
  const pressure = contextPressureForUsage(usage, backend, fallbackWindow);
  const threshold = Number(ratioThreshold || 0) || 0;
  if (pressure.known && threshold > 0) {
    const shouldReset = pressure.ratio >= threshold;
    return {
      ...pressure,
      shouldReset,
      reason: shouldReset ? "context" : "",
    };
  }

  const turns = Number(turnCount || 0) || 0;
  const turnLimit = Number(turnThreshold || 0) || 0;
  const shouldReset = turnLimit > 0 && turns >= turnLimit;
  return {
    ...pressure,
    shouldReset,
    reason: shouldReset ? "turns" : "",
  };
}
