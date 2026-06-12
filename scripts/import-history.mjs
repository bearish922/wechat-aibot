import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Legacy one-off importer: rebuild data/chat-history.json from old JSONL logs.
// The application only consumes this file when initializing an empty SQLite history DB.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const LOGS_DIR = path.join(DATA_DIR, "logs");
const SESSION_FILE = path.join(DATA_DIR, "wechat-sessions.json");
const HISTORY_FILE = path.join(DATA_DIR, "chat-history.json");

// Load session info
const sessionsRaw = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));

// Build session lookup: sessionName -> { ai, userId, sessionId, sessionName, profile }
const sessionMap = new Map();
for (const [ai, userMap] of Object.entries(sessionsRaw)) {
  for (const [userId, userData] of Object.entries(userMap)) {
    for (const s of userData.list || []) {
      const name = (s.name || "").toLowerCase();
      sessionMap.set(name, {
        ai,
        userId,
        sessionId: s.id,
        sessionName: s.name,
        profile: s._profile || null,
      });
    }
  }
}

// Collect all JSONL files
const logFiles = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith(".jsonl"));

// Group by session name
const targetSessions = ["cst", "aya", "anon"];
const events = [];

for (const logFile of logFiles.sort()) {
  // Extract session name from filename like "cc-cst-2026-05-27T20-50-17.jsonl"
  const parts = logFile.replace(/\.jsonl$/, "").split("-");
  // Format: {ai}-{sessionName}-{timestamp}
  const aiFromFile = parts[0];
  const sessionNameFromFile = parts.slice(1, -5).join("-"); // handle names with hyphens
  // Simpler: match known session names
  let matchedSession = null;
  for (const name of targetSessions) {
    const lowerFile = logFile.toLowerCase();
    if (lowerFile.includes(`-${name}-`) || lowerFile.includes(`-${name.toUpperCase()}-`)) {
      matchedSession = name;
      break;
    }
  }
  if (!matchedSession) continue;

  const sess = sessionMap.get(matchedSession);
  if (!sess) {
    console.log(`WARN: no session found for ${matchedSession}, skipping ${logFile}`);
    continue;
  }

  const filePath = path.join(LOGS_DIR, logFile);
  const lines = fs.readFileSync(filePath, "utf-8").trim().split(/\r?\n/).filter(Boolean);

  let userMessage = null;
  let assistantText = null;

  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      if (evt.type === "user_message") {
        userMessage = {
          body: evt.body || "",
          timestamp: evt.timestamp || "",
        };
      }
      if (evt.type === "result" && evt.subtype === "success") {
        assistantText = evt.result || "";
      }
    } catch { /* skip malformed lines */ }
  }

  if (!userMessage || !assistantText) continue;

  // User event
  events.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-u`,
    timestamp: userMessage.timestamp,
    userId: sess.userId,
    ai: sess.ai,
    sessionId: sess.sessionId,
    sessionName: sess.sessionName,
    profile: sess.profile || "默认",
    role: "user",
    kind: "chat",
    text: userMessage.body,
    scenelet: "",
    sceneState: "",
    proactiveIntentId: "",
  });

  // Assistant event
  events.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-a`,
    timestamp: userMessage.timestamp, // same approximate time
    userId: sess.userId,
    ai: sess.ai,
    sessionId: sess.sessionId,
    sessionName: sess.sessionName,
    profile: sess.profile || "默认",
    role: "assistant",
    kind: "chat",
    text: assistantText,
    scenelet: "",
    sceneState: "",
    proactiveIntentId: "",
  });
}

// Sort by timestamp
events.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

// Write
const existing = (() => {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const d = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
      return Array.isArray(d?.events) ? d.events : [];
    }
  } catch {}
  return [];
})();

// Merge: keep existing + new, deduplicate by id
const allEvents = [...existing, ...events];

fs.writeFileSync(HISTORY_FILE, JSON.stringify({ events: allEvents }, null, 2), "utf-8");

// Stats
const convKeys = new Set(allEvents.map(e => `${e.ai}|${e.userId}|${e.sessionId}`));
console.log(`Imported ${events.length} events (${events.filter(e => e.role === "user").length} turns)`);
console.log(`Total events in history: ${allEvents.length}`);
console.log(`Conversations: ${convKeys.size}`);
for (const name of targetSessions) {
  const sess = sessionMap.get(name);
  if (!sess) continue;
  const count = allEvents.filter(e => e.sessionId === sess.sessionId).length;
  console.log(`  ${sess.sessionName} (${sess.profile}): ${count} events`);
}
