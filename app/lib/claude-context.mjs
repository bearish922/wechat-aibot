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

// 快速统计 JSONL 文件中的 user 事件数（用于判断哪个同名 session 是当前活跃的）
function countUserEvents(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf-8");
    let count = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      // 快速扫描：只需判断 type 字段，无需完整解析
      if (line.includes('"type":"user"')) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

export function readClaudeSessionContext(sessionId, sessionName = "", expectedPrompts = 0) {
  if (!sessionId) return null;

  const dir = sessionProjectDir();
  let transcriptPath = null;

  // 1) 精确文件名匹配
  const exact = path.join(dir, `${sessionId}.jsonl`);
  if (fs.existsSync(exact)) {
    transcriptPath = exact;
  } else if (fs.existsSync(dir)) {
    // 2) 扫描目录：先尝试 first-line sessionId 精确匹配，再按 sessionName + 最接近 expectedPrompts 选
    let bestByName = null;
    let bestScore = Infinity; // 与 expectedPrompts 的差距，越小越好

    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = path.join(dir, f);
      try {
        const head = fs.readFileSync(fp, "utf-8").slice(0, 400);
        const firstLine = head.split("\n")[0];
        const parsed = JSON.parse(firstLine);
        if (parsed.sessionId === sessionId) {
          transcriptPath = fp;
          break;
        }
        if (sessionName && (parsed.customTitle === sessionName || parsed.agentName === sessionName)) {
          const prompts = countUserEvents(fp);
          const score = Math.abs(prompts - expectedPrompts);
          if (score < bestScore) {
            bestScore = score;
            bestByName = fp;
          }
        }
      } catch { /* skip unreadable files */ }
    }

    if (!transcriptPath) transcriptPath = bestByName;
  }

  if (!transcriptPath) return null;

  try {
    return parseClaudeContextTranscript(fs.readFileSync(transcriptPath, "utf-8"));
  } catch {
    return null;
  }
}

const SESSION_CLEANUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HIDDEN_WORLD_KEEP_COUNT = 3;

export function cleanupOldSessionFiles({ protectedSessionIds = new Set() } = {}) {
  const dir = sessionProjectDir();
  if (!fs.existsSync(dir)) return { deleted: 0, freedMB: 0 };
  const protectedIds = protectedSessionIds instanceof Set
    ? protectedSessionIds
    : new Set(protectedSessionIds || []);

  const now = Date.now();
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));

  const hiddenWorldByProfile = new Map();
  const nonHiddenWorld = [];

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
      } else {
        nonHiddenWorld.push({ path: fp, mtimeMs: stat.mtimeMs });
      }
    } catch {
      nonHiddenWorld.push({ path: fp, mtimeMs: stat.mtimeMs || 0 });
    }
  }

  const toDelete = [];

  for (const [, entries] of hiddenWorldByProfile) {
    if (entries.length <= HIDDEN_WORLD_KEEP_COUNT) continue;
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    toDelete.push(...entries.slice(HIDDEN_WORLD_KEEP_COUNT));
  }

  for (const entry of nonHiddenWorld) {
    if (now - entry.mtimeMs > SESSION_CLEANUP_MAX_AGE_MS) {
      toDelete.push(entry);
    }
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
