// Initialize memory document from all historical user messages
import { loadAllEvents } from "../app/lib/chat-history.mjs";
import { loadMemoryDocument, saveMemoryDocument } from "../app/lib/memory.mjs";
import { loadPrompts } from "../app/lib/reply.mjs";
import { CLAUDE_MAIN_MODEL, runHiddenJson } from "../app/lib/claude-runner.mjs";
const profile = process.argv[2] || "白鹭千圣";
const requestedUserId = process.argv[3] || "";

const events = await loadAllEvents();
const userMessages = events
  .filter(e => e.role === "user" && e.text && e.profile === profile && (!requestedUserId || e.userId === requestedUserId))
  .map((e, i) => `[${i + 1}] ${e.timestamp?.slice(0, 16)} ${e.text}`);

console.log(`Found ${userMessages.length} user messages for ${profile}${requestedUserId ? ` / ${requestedUserId}` : ""}`);

const prompt = loadPrompts(profile).memoryUpdatePrompt;
if (!prompt) {
  console.error("memoryUpdatePrompt not found in prompts.json");
  process.exit(1);
}

const input = [
  prompt,
  "",
  "当前记忆文档：",
  loadMemoryDocument(profile) || "(空——这是第一次创建)",
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

saveMemoryDocument(result.trim(), profile);
console.log(`Written ${result.length} chars to memory for ${profile}`);
