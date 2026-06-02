import fs from "node:fs";
import { dataPath, ensureDir, DATA_DIR } from "./paths.mjs";

export const CHAT_HISTORY_FILE = dataPath("chat-history.json");
function loadAllEvents() {
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
    sceneState: event.sceneState ? String(event.sceneState) : "",
    proactiveIntentId: event.proactiveIntentId || "",
  };
  events.push(item);
  saveAllEvents(events);
  return item;
}

export function listChatEvents(options = {}) {
  const q = String(options.q || "").trim().toLowerCase();
  const sessionKey = String(options.sessionKey || "").trim();
  const rawLimit = Number(options.limit ?? 500);
  const limit = rawLimit <= 0 ? Number.MAX_SAFE_INTEGER : Math.max(1, rawLimit);
  let events = loadAllEvents();
  if (sessionKey) {
    events = events.filter(e => conversationKey(e) === sessionKey);
  }
  if (q) {
    events = events.filter(e => [
      e.text,
      e.scenelet,
      e.sceneState,
      e.sessionName,
      e.profile,
      e.userId,
    ].some(v => String(v || "").toLowerCase().includes(q)));
  }
  return events.slice(-limit);
}

export function conversationKey(event) {
  return [event.ai || "cc", event.userId || "", event.sessionId || ""].join("|");
}

export function listConversations(options = {}) {
  const q = String(options.q || "").trim().toLowerCase();
  const events = listChatEvents({ limit: 0 });
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
