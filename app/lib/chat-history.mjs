import fs from "node:fs";
import { dataPath, ensureDir, DATA_DIR } from "./paths.mjs";

const CHAT_HISTORY_FILE = dataPath("chat-history.json");
export function loadAllEvents() {
  try {
    if (!fs.existsSync(CHAT_HISTORY_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, "utf-8"));
    return Array.isArray(data?.events) ? data.events : [];
  } catch {
    return [];
  }
}

function saveAllEvents(events) {
  ensureDir(DATA_DIR);
  fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify({ events }, null, 2), "utf-8");
}

function normalizeToolUsage(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  const tools = Array.isArray(raw.tools)
    ? [...new Set(raw.tools.map(x => String(x || "").trim()).filter(Boolean))]
    : [];
  return {
    webSearch: Math.max(0, Number(raw.webSearch || 0) || 0),
    webFetch: Math.max(0, Number(raw.webFetch || 0) || 0),
    tools,
  };
}

function normalizeRagUsage(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  return {
    eligible: Boolean(raw.eligible),
    used: Boolean(raw.used),
    chars: Math.max(0, Number(raw.chars || 0) || 0),
  };
}

export function appendChatEvent(event) {
  if (!event?.text && !event?.scenelet) return null;
  const events = loadAllEvents();
  const item = {
    id: event.id || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: event.timestamp || new Date().toISOString(),
    userId: String(event.userId || ""),
    ai: event.ai || "cc",
    sessionId: event.sessionId || "",
    sessionName: event.sessionName || "",
    profile: event.profile || "默认",
    role: event.role || "assistant",
    kind: event.kind || "chat",
    text: String(event.text || ""),
    scenelet: event.scenelet ? String(event.scenelet) : "",
    sceneletStatus: event.sceneletStatus ? String(event.sceneletStatus) : "",
    sceneletError: event.sceneletError ? String(event.sceneletError) : "",
    proactiveIntentId: event.proactiveIntentId || "",
    toolUsage: normalizeToolUsage(event.toolUsage),
    ragUsage: normalizeRagUsage(event.ragUsage),
  };
  events.push(item);
  saveAllEvents(events);
  return item;
}

export function listChatEvents(options = {}) {
  const q = String(options.q || "").trim().toLowerCase();
  const sessionKey = String(options.sessionKey || "").trim();
  const dateFrom = options.dateFrom ? String(options.dateFrom) : "";
  const dateTo = options.dateTo ? String(options.dateTo) : "";
  const offset = Math.max(0, Number(options.offset || 0));
  const rawLimit = Number(options.limit ?? 50);
  const limit = rawLimit <= 0 ? Number.MAX_SAFE_INTEGER : Math.max(1, rawLimit);

  let events = loadAllEvents();

  if (dateFrom) {
    events = events.filter(e => String(e.timestamp || "") >= dateFrom);
  }
  if (dateTo) {
    events = events.filter(e => String(e.timestamp || "") <= dateTo + "￿");
  }

  if (sessionKey) {
    events = events.filter(e => conversationKey(e) === sessionKey);
  }
  if (q) {
    events = events.filter(e => [
      e.text,
      e.scenelet,
      e.sceneletStatus,
      e.sceneletError,
      e.sessionName,
      e.profile,
      e.userId,
      e.toolUsage ? `WebSearch:${e.toolUsage.webSearch > 0 ? "yes" : "no"} WebFetch:${e.toolUsage.webFetch > 0 ? "yes" : "no"} ${(e.toolUsage.tools || []).join(" ")}` : "",
      e.ragUsage ? `RAG:${e.ragUsage.used ? "yes" : "no"} eligible:${e.ragUsage.eligible ? "yes" : "no"} chars:${e.ragUsage.chars || 0}` : "",
    ].some(v => String(v || "").toLowerCase().includes(q)));
  }

  events.reverse();

  const total = events.length;
  const page = events.slice(offset, offset + limit);
  return { events: page, total };
}

export function conversationKey(event) {
  return [event.ai || "cc", event.userId || "", event.sessionId || ""].join("|");
}

export function listConversations(options = {}) {
  const q = String(options.q || "").trim().toLowerCase();
  const dateFrom = options.dateFrom ? String(options.dateFrom) : "";
  const dateTo = options.dateTo ? String(options.dateTo) : "";

  let events = loadAllEvents();

  if (dateFrom) {
    events = events.filter(e => String(e.timestamp || "") >= dateFrom);
  }
  if (dateTo) {
    events = events.filter(e => String(e.timestamp || "") <= dateTo + "￿");
  }

  const map = new Map();
  for (const event of events) {
    if (q && ![
      event.text,
      event.scenelet,
      event.sessionName,
      event.profile,
      event.userId,
    ].some(v => String(v || "").toLowerCase().includes(q))) {
      continue;
    }
    const key = conversationKey(event);
    const existing = map.get(key) || {
      key,
      ai: event.ai,
      userId: event.userId,
      sessionId: event.sessionId,
      sessionName: event.sessionName,
      profile: event.profile,
      count: 0,
      sceneletCount: 0,
      lastTimestamp: event.timestamp,
      lastText: "",
    };
    existing.count += 1;
    if (event.scenelet) existing.sceneletCount += 1;
    existing.lastTimestamp = event.timestamp;
    existing.lastText = event.text;
    existing.sessionName = event.sessionName || existing.sessionName;
    existing.profile = event.profile || existing.profile;
    map.set(key, existing);
  }
  return Array.from(map.values()).sort((a, b) => String(b.lastTimestamp).localeCompare(String(a.lastTimestamp)));
}
