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
export const pendingProfileDeletes = new Map();

// Setter helpers for reassignable primitives
export function setToken(v) { token = v; }
export function setSyncBuf(v) { getUpdatesBuf = v; }
export function setActiveAI(v) { activeAI = v; }
export function setProfileTemplates(v) { profileTemplates = v; }
