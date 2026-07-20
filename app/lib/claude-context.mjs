import fs from "node:fs";
import path from "node:path";
import { envOrConfig } from "./config.mjs";

const USER_HOME = process.env.USERPROFILE || process.env.HOME || process.cwd();
const configuredWorkDir = envOrConfig("WECHAT_AI_WORK_DIR", "paths.workDir", USER_HOME);
const AI_WORK_DIR = typeof configuredWorkDir === "string" && configuredWorkDir.trim()
  ? configuredWorkDir.trim()
  : USER_HOME;

function claudeProjectSlug(workDir) {
  return path.resolve(String(workDir)).replace(/[\\/:]/g, "-");
}

function sessionProjectDir() {
  return path.join(USER_HOME, ".claude", "projects", claudeProjectSlug(AI_WORK_DIR));
}

export function parseClaudeContextTranscript(text) {
  let latestUsage = null;
  let promptCount = 0;

  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === "user") promptCount += 1;
    if (event?.type === "assistant" && event.message?.usage) {
      latestUsage = event.message.usage;
    }
  }

  if (!latestUsage) return null;
  const inputTokens = (Number(latestUsage.input_tokens) || 0)
    + (Number(latestUsage.cache_read_input_tokens) || 0)
    + (Number(latestUsage.cache_creation_input_tokens) || 0);
  const outputTokens = Number(latestUsage.output_tokens) || 0;
  return {
    tokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    promptCount,
  };
}

const HIDDEN_WORLD_KEEP_COUNT = 3;

export function cleanupOldSessionFiles({ protectedSessionIds = new Set() } = {}) {
  const dir = sessionProjectDir();
  if (!fs.existsSync(dir)) return { deleted: 0, freedMB: 0 };
  const protectedIds = protectedSessionIds instanceof Set
    ? protectedSessionIds
    : new Set(protectedSessionIds || []);

  const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));

  const hiddenWorldByProfile = new Map();

  for (const f of files) {
    const fp = path.join(dir, f);
    const fileSessionId = path.basename(f, ".jsonl");
    if (protectedIds.has(fileSessionId)) continue;
    let stat;
    try { stat = fs.statSync(fp); } catch { continue; }

    try {
      const head = fs.readFileSync(fp, "utf-8").slice(0, 400);
      const firstLine = head.split("\n")[0];
      const parsed = JSON.parse(firstLine);
      const title = parsed.customTitle || "";

      if (title.startsWith("hidden-world-")) {
        const profile = title.slice("hidden-world-".length);
        if (!hiddenWorldByProfile.has(profile)) hiddenWorldByProfile.set(profile, []);
        hiddenWorldByProfile.get(profile).push({ path: fp, mtimeMs: stat.mtimeMs });
      }
    } catch { /* unrelated or unreadable session: never delete it */ }
  }

  const toDelete = [];

  for (const [, entries] of hiddenWorldByProfile) {
    if (entries.length <= HIDDEN_WORLD_KEEP_COUNT) continue;
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    toDelete.push(...entries.slice(HIDDEN_WORLD_KEEP_COUNT));
  }

  let freedBytes = 0;
  for (const entry of toDelete) {
    try {
      const s = fs.statSync(entry.path);
      freedBytes += s.size;
      fs.unlinkSync(entry.path);
    } catch { /* skip */ }
  }

  return {
    deleted: toDelete.length,
    freedMB: +(freedBytes / (1024 * 1024)).toFixed(2),
  };
}
