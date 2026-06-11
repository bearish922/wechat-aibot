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

export function readClaudeSessionContext(sessionId) {
  if (!sessionId) return null;
  const transcript = path.join(
    USER_HOME,
    ".claude",
    "projects",
    claudeProjectSlug(AI_WORK_DIR),
    `${sessionId}.jsonl`,
  );
  try {
    return parseClaudeContextTranscript(fs.readFileSync(transcript, "utf-8"));
  } catch {
    return null;
  }
}
