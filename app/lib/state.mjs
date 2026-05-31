// ─── Centralized mutable state ─────────────────────────────
// All modules import from here instead of holding their own globals.
// No circular imports: state.mjs never imports other lib/*.mjs modules.

export let token = null;
export let getUpdatesBuf = "";
export const sessions = { cc: new Map(), codex: new Map() };
export let activeAI = "cc";
export let profileTemplates = {};
export let modelNames = { cc: "unknown", codex: "unknown" };
export const pendingInputs = new Map();
export const recentInputs = new Map();
export const DEFAULT_CHAT_CC_SESSIONS = new Set(["cst", "anon", "soyo", "aya"]);
export const MODE_CHAT = "chat";
export const MODE_TOOL = "tool";

export function defaultSessionMode(ai, name) {
  return ai === "cc" && DEFAULT_CHAT_CC_SESSIONS.has(String(name || "").trim().toLowerCase()) ? MODE_CHAT : MODE_TOOL;
}

// Setter helpers for reassignable primitives
export function setToken(v) { token = v; }
export function setSyncBuf(v) { getUpdatesBuf = v; }
export function setActiveAI(v) { activeAI = v; }
export function setProfileTemplates(v) { profileTemplates = v; }
