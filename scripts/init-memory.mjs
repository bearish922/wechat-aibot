// Initialize memory document from all historical user messages
import { loadAllEvents } from "../app/lib/chat-history.mjs";
import { MEMORY_FILE } from "../app/lib/memory.mjs";
import { loadPrompts } from "../app/lib/reply.mjs";
import { CLAUDE_MAIN_MODEL, runHiddenJson } from "../app/lib/claude-runner.mjs";
import fs from "node:fs";

const events = loadAllEvents();
const userMessages = events
  .filter(e => e.role === "user" && e.text && e.sessionName === "cst")
  .map((e, i) => `[${i + 1}] ${e.timestamp?.slice(0, 16)} ${e.text}`);

console.log(`Found ${userMessages.length} user messages from cst session`);

const prompt = loadPrompts().memoryUpdatePrompt;
if (!prompt) {
  console.error("memoryUpdatePrompt not found in prompts.json");
  process.exit(1);
}

const input = [
  prompt,
  "",
  "当前记忆文档：",
  "(空——这是第一次创建)",
  "",
  "用户全部历史消息（按时间顺序，从早到晚）：",
  userMessages.join("\n\n"),
  "",
  "请输出初始记忆文档（直接 Markdown，不要 JSON 包裹）：",
].join("\n");

console.log("Calling model...");
const raw = await runHiddenJson(input, {
  label: "memory_init",
  bare: false,
  model: CLAUDE_MAIN_MODEL,
  timeoutMs: 180000,
});

const result = typeof raw === "string" ? raw : (raw?.result || raw?.text || "");
if (!result.trim()) {
  console.error("Model returned empty result");
  process.exit(1);
}

fs.writeFileSync(MEMORY_FILE, result.trim(), "utf-8");
console.log(`Written ${result.length} chars to ${MEMORY_FILE}`);
