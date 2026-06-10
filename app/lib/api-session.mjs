// api-session.mjs — API session state: messages array, reset, persistence, token stats
// Replaces Claude Code's internal --resume session management.
import { uuid } from "./utils.mjs";

/**
 * Create a fresh API session.
 * Returns an object with messages[], turnCount, sid, etc.
 */
export function createApiSession(opts = {}) {
  return {
    sid: opts.sid || uuid(),
    messages: opts.messages || [],       // [{role, content}, ...]
    turnCount: typeof opts.turnCount === "number" ? opts.turnCount : 0,
    firstTurn: opts.firstTurn ?? true,
    totalTokens: { input: 0, output: 0 }, // cumulative
    lastResetAt: opts.lastResetAt || null,
    sceneMemory: opts.sceneMemory || "",  // preserved across resets
  };
}

/**
 * Add a message to the session and increment turn count.
 */
export function appendApiMessage(sess, role, content, usage = null) {
  if (!content?.trim()) return;
  sess.messages.push({ role, content: String(content) });
  if (usage) {
    sess.totalTokens.input += Number(usage.inputTokens || 0);
    sess.totalTokens.output += Number(usage.outputTokens || 0);
  }
  if (role === "assistant") {
    sess.turnCount += 1;
  }
}

/**
 * Estimate total tokens (rough: ~2.5 chars per token for Chinese, ~4 for English).
 */
export function estimateTokens(sess) {
  let total = 0;
  for (const m of sess.messages) {
    const text = String(m.content || "");
    const chineseChars = (text.match(/[一-鿿　-〿＀-￯]/g) || []).length;
    const otherChars = text.length - chineseChars;
    total += Math.ceil(chineseChars / 1.5) + Math.ceil(otherChars / 3.5);
  }
  return total;
}

/**
 * Reset the session: truncate messages to last N turns, inject scene memory.
 * Called when turnCount reaches threshold.
 */
export function resetApiSession(sess, { keepTurns = 4, sceneMemory = "" } = {}) {
  const systemMsgs = sess.messages.filter(m => m.role === "system");
  const conversationMsgs = sess.messages.filter(m => m.role !== "system");

  // Keep the last keepTurns * 2 messages (user + assistant pairs)
  const kept = conversationMsgs.slice(-Math.max(keepTurns * 2, 4));

  // Build new messages array: system (with scene memory) + kept conversation
  const newMessages = [];
  if (sceneMemory) {
    // Inject scene memory as a system message
    const memContent = `[情景记忆 — 之前对话的摘要]\n${sceneMemory}`;
    if (systemMsgs.length > 0) {
      newMessages.push({ role: "system", content: systemMsgs[0].content + "\n\n" + memContent });
    } else {
      newMessages.push({ role: "system", content: memContent });
    }
  } else if (systemMsgs.length > 0) {
    newMessages.push(...systemMsgs);
  }
  newMessages.push(...kept);

  sess.messages = newMessages;
  sess.turnCount = 0;
  sess.firstTurn = true;
  sess.lastResetAt = new Date().toISOString();
  sess.sceneMemory = sceneMemory || sess.sceneMemory;
  sess.sid = uuid();
}

/**
 * Get the full messages array for API call (system + all history).
 */
export function apiMessagesForTurn(sess, systemPrompt, userBody) {
  const msgs = [...sess.messages];
  if (systemPrompt && !msgs.some(m => m.role === "system")) {
    msgs.unshift({ role: "system", content: systemPrompt });
  }
  if (userBody) {
    msgs.push({ role: "user", content: userBody });
  }
  return msgs;
}

/**
 * Serialize session state for persistence.
 */
export function serializeApiSession(sess) {
  return {
    sid: sess.sid,
    messages: sess.messages,
    turnCount: sess.turnCount,
    firstTurn: sess.firstTurn,
    totalTokens: sess.totalTokens,
    lastResetAt: sess.lastResetAt,
    sceneMemory: sess.sceneMemory,
  };
}

/**
 * Deserialize session state from persistence.
 */
export function deserializeApiSession(raw = {}) {
  return createApiSession({
    sid: raw.sid,
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    turnCount: typeof raw.turnCount === "number" ? raw.turnCount : 0,
    firstTurn: raw.firstTurn ?? true,
    totalTokens: raw.totalTokens || { input: 0, output: 0 },
    lastResetAt: raw.lastResetAt || null,
    sceneMemory: raw.sceneMemory || "",
  });
}
