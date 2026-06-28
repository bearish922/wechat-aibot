import fs from "node:fs";
import path from "node:path";

const USER_HOME = process.env.USERPROFILE || process.env.HOME || process.cwd();
const CODEX_SESSIONS_DIR = path.join(USER_HOME, ".codex", "sessions");
const usageCache = new Map();

function numberValue(value) {
  return Number(value || 0) || 0;
}

export function codexUsageFromTokenCountInfo(info = null) {
  const last = info?.last_token_usage || info?.total_token_usage || null;
  if (!last || typeof last !== "object") return null;
  const total = info?.total_token_usage || null;
  return {
    input_tokens: numberValue(last.input_tokens),
    cache_read_input_tokens: numberValue(last.cached_input_tokens || last.cache_read_input_tokens),
    cache_creation_input_tokens: 0,
    output_tokens: numberValue(last.output_tokens),
    reasoning_output_tokens: numberValue(last.reasoning_output_tokens),
    total_input_tokens: numberValue(total?.input_tokens),
    total_output_tokens: numberValue(total?.output_tokens),
    model_context_window: numberValue(info?.model_context_window),
  };
}

function findCodexSessionFile(sessionId) {
  if (!sessionId || !fs.existsSync(CODEX_SESSIONS_DIR)) return null;
  const stack = [CODEX_SESSIONS_DIR];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) {
        return full;
      }
    }
  }
  return null;
}

export function readCodexSessionUsage(sessionId) {
  if (!sessionId) return null;
  const cached = usageCache.get(sessionId);
  if (cached !== undefined) return cached;

  const file = findCodexSessionFile(sessionId);
  if (!file) {
    usageCache.set(sessionId, null);
    return null;
  }

  let latest = null;
  try {
    const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.includes("token_count")) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      const payload = parsed?.type === "event_msg" ? parsed.payload : null;
      if (payload?.type !== "token_count") continue;
      latest = codexUsageFromTokenCountInfo(payload.info);
    }
  } catch {
    latest = null;
  }
  usageCache.set(sessionId, latest);
  return latest;
}

export function repairCodexUsageFromSession(usage, sessionId) {
  if (!usage || !sessionId) return usage || null;
  if (numberValue(usage.model_context_window) > 0) return usage;
  const repaired = readCodexSessionUsage(sessionId);
  return repaired ? { ...usage, ...repaired } : usage;
}
