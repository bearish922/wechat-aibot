import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { dataPath, rootPath, ensureDir, DATA_DIR, PROJECT_ROOT } from "./paths.mjs";
import { sessions } from "./state.mjs";
import { loadEventsForProfiles, deleteEventsForProfiles } from "./chat-history.mjs";
import { loadMemoryDocument, loadWorldMemoryDocument, saveMemoryDocument, saveWorldMemoryDocument } from "./memory.mjs";
import { getRoleWorld, resetRoleRuntimeWorld, saveRoleWorlds } from "./world-state.mjs";
import { beijingISO } from "./reply.mjs";
import { uuid } from "./utils.mjs";

const ARCHIVE_ROOT = dataPath("archives", "worldlines");
const HISTORY_FILE = "archived-history.json";

function safeId(id = "") {
  return String(id || "").replace(/[^a-zA-Z0-9._-]/g, "");
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
}

function profileSlug(profiles = []) {
  return profiles
    .map(p => String(p || "").trim())
    .filter(Boolean)
    .map(p => Buffer.from(p).toString("hex").slice(0, 24))
    .filter(Boolean)
    .join("__")
    .slice(0, 80) || "worldline";
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function writeText(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, String(value || ""), "utf-8");
}

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) return false;
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  return true;
}

function gitText(args) {
  try {
    return execFileSync("git", args, { cwd: PROJECT_ROOT, encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 });
  } catch (error) {
    return `[git ${args.join(" ")} failed]\n${error.message}\n`;
  }
}

function profileEventsSummary(events = []) {
  const byProfile = new Map();
  for (const event of events) {
    const key = event.profile || "默认";
    const row = byProfile.get(key) || {
      profile: key,
      count: 0,
      firstTimestamp: null,
      lastTimestamp: null,
      sessionNames: new Set(),
    };
    row.count += 1;
    if (!row.firstTimestamp || String(event.timestamp).localeCompare(row.firstTimestamp) < 0) row.firstTimestamp = event.timestamp;
    if (!row.lastTimestamp || String(event.timestamp).localeCompare(row.lastTimestamp) > 0) row.lastTimestamp = event.timestamp;
    if (event.sessionName) row.sessionNames.add(event.sessionName);
    byProfile.set(key, row);
  }
  return [...byProfile.values()].map(item => ({
    ...item,
    sessionNames: [...item.sessionNames].sort(),
  }));
}

function markdownHistory(events = []) {
  if (!events.length) return "# Archived Visible History\n\nNo messages.\n";
  const lines = ["# Archived Visible History", ""];
  let lastProfile = "";
  for (const event of events) {
    if (event.profile !== lastProfile) {
      lastProfile = event.profile;
      lines.push("", `## ${lastProfile || "Unknown Profile"}`, "");
    }
    const speaker = event.role === "assistant" ? (event.profile || "Assistant") : "User";
    const kind = event.kind && event.kind !== "chat" ? ` · ${event.kind}` : "";
    lines.push(`### ${event.timestamp} · ${speaker}${kind}`);
    lines.push("");
    lines.push(String(event.text || "").trim() || "(empty)");
    if (event.scenelet) {
      lines.push("", "<details><summary>inner scenelet</summary>", "");
      lines.push("```");
      lines.push(event.scenelet);
      lines.push("```", "", "</details>");
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n{4,}/g, "\n\n\n") + "\n";
}

function markdownWorldState(profiles = []) {
  const lines = ["# Runtime World State", ""];
  for (const profile of profiles) {
    const world = getRoleWorld(profile);
    lines.push(`## ${profile}`, "");
    lines.push("### world_state", "");
    lines.push("```json");
    lines.push(JSON.stringify(world?._worldState || null, null, 2));
    lines.push("```", "");
    lines.push("### world_sessions", "");
    lines.push("```json");
    lines.push(JSON.stringify(world?._worldSessions || {}, null, 2));
    lines.push("```", "");
  }
  return lines.join("\n");
}

function markdownLifeArcs(profiles = []) {
  const lines = ["# Life Arcs", ""];
  for (const profile of profiles) {
    const arcs = getRoleWorld(profile)?._lifeArcs || [];
    lines.push(`## ${profile}`, "");
    if (!arcs.length) {
      lines.push("No life arcs.", "");
      continue;
    }
    for (const arc of arcs) {
      lines.push(`### ${arc.title || arc.id}`);
      lines.push("");
      lines.push(`- id: ${arc.id || ""}`);
      lines.push(`- status: ${arc.status || ""}`);
      lines.push(`- kind: ${arc.kind || ""}`);
      lines.push(`- time: ${arc.timeStart || ""} -> ${arc.timeEnd || ""}`);
      if (arc.summary) lines.push(`- summary: ${arc.summary}`);
      if (arc.progressNote) lines.push(`- progress: ${arc.progressNote}`);
      if (arc.lifeTexture) lines.push(`- life_texture: ${JSON.stringify(arc.lifeTexture)}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function markdownProactiveIntents(profiles = []) {
  const lines = ["# Proactive Intents", ""];
  for (const profile of profiles) {
    const intents = getRoleWorld(profile)?._proactiveIntents || [];
    lines.push(`## ${profile}`, "");
    if (!intents.length) {
      lines.push("No proactive intents.", "");
      continue;
    }
    for (const intent of intents) {
      lines.push(`- ${intent.status || "unknown"} · ${intent.kind || "intent"} · ${intent.scheduledAt || ""}`);
      lines.push(`  ${String(intent.messageIntent || intent.basis || "").replace(/\s+/g, " ").trim()}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function copyRuntimeFiles(archiveDir, events = []) {
  const runtimeDir = path.join(archiveDir, "runtime-state");
  const files = [
    "chat-history.db",
    "chat-history.db.bak",
    "wechat-sessions.json",
    "wechat-sessions.bak.json",
    "wechat-worlds.json",
    "wechat-worlds.backup.json",
  ];
  for (const file of files) copyIfExists(dataPath(file), path.join(runtimeDir, file));

  const sessionNames = new Set(events.map(e => e.sessionName).filter(Boolean));
  const logsDir = dataPath("logs");
  const archiveLogsDir = path.join(runtimeDir, "logs");
  if (fs.existsSync(logsDir)) {
    for (const file of fs.readdirSync(logsDir)) {
      if (![...sessionNames].some(name => file.includes(name))) continue;
      copyIfExists(path.join(logsDir, file), path.join(archiveLogsDir, file));
    }
  }

  for (const file of fs.readdirSync(DATA_DIR).filter(name => /^wechat-(world-)?memory-.*\.md$/.test(name))) {
    copyIfExists(dataPath(file), path.join(runtimeDir, "memory", file));
  }
}

function copyProductionSnapshot(archiveDir) {
  const dir = path.join(archiveDir, "production-snapshot");
  for (const rel of [
    ["data", "prompts.json"],
    ["data", "prompts.local.json"],
    ["data", "wechat-profiles.json"],
    ["data", "wechat-profiles.local.json"],
    ["docs", "CHANGELOG.md"],
    ["docs", "VERSION"],
    ["app", "package.json"],
  ]) {
    copyIfExists(rootPath(...rel), path.join(dir, ...rel));
  }
  writeText(path.join(dir, "git-info.txt"), [
    "$ git rev-parse HEAD",
    gitText(["rev-parse", "HEAD"]).trim(),
    "",
    "$ git status --short",
    gitText(["status", "--short"]).trim(),
    "",
    "$ git log --oneline --decorate -20",
    gitText(["log", "--oneline", "--decorate", "-20"]).trim(),
    "",
  ].join("\n"));
  writeText(path.join(dir, "working-tree.diff"), gitText(["diff", "--", "."]));
}

function archiveReadme({ archiveId, profiles, reason, hardReset, events }) {
  const summaries = profileEventsSummary(events);
  return [
    `# Worldline Archive ${archiveId}`,
    "",
    "This folder is a sealed snapshot of runtime worldline data. It is not part of the active conversation unless explicitly restored.",
    "",
    `- profiles: ${profiles.join(", ")}`,
    `- reason: ${reason || "not specified"}`,
    `- hard reset requested: ${hardReset ? "yes" : "no"}`,
    `- archived visible events: ${events.length}`,
    "",
    "## Profiles",
    "",
    ...summaries.map(s => `- ${s.profile}: ${s.count} events, ${s.firstTimestamp || "?"} -> ${s.lastTimestamp || "?"}, sessions: ${s.sessionNames.join(", ") || "unknown"}`),
    "",
    "## Folder Layout",
    "",
    "- production-snapshot: prompt/profile/code metadata needed to understand the product line.",
    "- runtime-state: raw SQLite/JSON/log snapshots useful for restore or forensic inspection.",
    "- extracted: readable exports for another model or maintainer.",
    "- restore: restore notes and cautions.",
    "",
    "Do not merge this archive into a fresh active worldline by default. Treat it as a separate timeline.",
    "",
  ].join("\n");
}

function restoreDoc(profiles = []) {
  return [
    "# Restore Notes",
    "",
    "This archive preserves an old worldline. Restoring it should be a deliberate worldline switch, not a merge into the active fresh start.",
    "",
    "Recommended restore modes:",
    "",
    "1. Inspect only: read `extracted/` and leave active runtime untouched.",
    "2. Full old-worldline restore: stop the bot, copy files from `runtime-state/` back to `data/`, then restart.",
    "3. Selective import: import specific messages or memories into a separate profile/session name, clearly labelled as old-worldline material.",
    "",
    `Profiles in this archive: ${profiles.join(", ")}`,
    "",
  ].join("\n");
}

export async function createWorldlineArchive({ profiles = [], reason = "", hardReset = false } = {}) {
  const names = [...new Set(profiles.map(p => String(p || "").trim()).filter(Boolean))];
  if (!names.length) throw new Error("profiles are required");
  const now = beijingISO();
  const archiveId = `${stamp()}_${profileSlug(names)}`;
  const archiveDir = path.join(ARCHIVE_ROOT, archiveId);
  ensureDir(archiveDir);

  const events = await loadEventsForProfiles(names);
  const manifest = {
    version: 1,
    archiveId,
    createdAt: now,
    reason,
    profiles: names,
    hardResetRequested: Boolean(hardReset),
    eventCount: events.length,
    profileSummaries: profileEventsSummary(events),
    files: {
      history: `extracted/${HISTORY_FILE}`,
      readableHistory: "extracted/visible-history.md",
      worldState: "extracted/world-state.md",
      lifeArcs: "extracted/life-arcs.md",
      proactiveIntents: "extracted/proactive-intents.md",
    },
  };

  writeJson(path.join(archiveDir, "MANIFEST.json"), manifest);
  writeText(path.join(archiveDir, "README.md"), archiveReadme({ archiveId, profiles: names, reason, hardReset, events }));
  writeJson(path.join(archiveDir, "extracted", HISTORY_FILE), { archiveId, profiles: names, events });
  writeText(path.join(archiveDir, "extracted", "visible-history.md"), markdownHistory(events));
  writeText(path.join(archiveDir, "extracted", "world-state.md"), markdownWorldState(names));
  writeText(path.join(archiveDir, "extracted", "life-arcs.md"), markdownLifeArcs(names));
  writeText(path.join(archiveDir, "extracted", "proactive-intents.md"), markdownProactiveIntents(names));
  writeJson(path.join(archiveDir, "extracted", "memories.json"), Object.fromEntries(names.map(profile => [profile, {
    userMemory: loadMemoryDocument(profile),
    worldMemory: loadWorldMemoryDocument(profile),
  }])));
  writeText(path.join(archiveDir, "restore", "RESTORE.md"), restoreDoc(names));
  copyRuntimeFiles(archiveDir, events);
  copyProductionSnapshot(archiveDir);

  return { archiveId, archiveDir, manifest };
}

export function listWorldlineArchives() {
  if (!fs.existsSync(ARCHIVE_ROOT)) return [];
  return fs.readdirSync(ARCHIVE_ROOT)
    .map(id => {
      const clean = safeId(id);
      if (!clean || clean !== id) return null;
      const manifestFile = path.join(ARCHIVE_ROOT, id, "MANIFEST.json");
      if (!fs.existsSync(manifestFile)) return null;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
        return {
          archiveId: id,
          createdAt: manifest.createdAt || null,
          reason: manifest.reason || "",
          profiles: manifest.profiles || [],
          eventCount: manifest.eventCount || 0,
          profileSummaries: manifest.profileSummaries || [],
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt || b.archiveId).localeCompare(String(a.createdAt || a.archiveId)));
}

function readArchiveHistory(archiveId) {
  const id = safeId(archiveId);
  if (!id || id !== archiveId) throw new Error("invalid archive id");
  const file = path.join(ARCHIVE_ROOT, id, "extracted", HISTORY_FILE);
  if (!fs.existsSync(file)) return { archiveId: id, events: [] };
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

export function listArchivedConversations({ q = "", dateFrom = "", dateTo = "" } = {}) {
  const query = String(q || "").trim().toLowerCase();
  const rows = [];
  for (const archive of listWorldlineArchives()) {
    const history = readArchiveHistory(archive.archiveId);
    for (const summary of archive.profileSummaries || []) {
      let events = (history.events || []).filter(e => e.profile === summary.profile);
      if (dateFrom) events = events.filter(e => String(e.timestamp || "") >= dateFrom);
      if (dateTo) events = events.filter(e => String(e.timestamp || "") <= `${dateTo}\uffff`);
      if (query) {
        events = events.filter(e => [e.text, e.scenelet, e.profile, e.sessionName].some(v => String(v || "").toLowerCase().includes(query)));
      }
      if (!events.length) continue;
      const last = events[events.length - 1];
      rows.push({
        key: `archive:${archive.archiveId}:${summary.profile}`,
        source: "archive",
        archiveId: archive.archiveId,
        archiveCreatedAt: archive.createdAt,
        ai: last.ai,
        userId: last.userId,
        sessionId: last.sessionId,
        sessionName: last.sessionName,
        profile: summary.profile,
        lastTimestamp: last.timestamp,
        count: events.length,
        sceneletCount: events.filter(e => e.scenelet).length,
        lastText: last.text || "",
      });
    }
  }
  return rows.sort((a, b) => String(b.archiveCreatedAt || b.lastTimestamp).localeCompare(String(a.archiveCreatedAt || a.lastTimestamp)));
}

export function listArchivedMessages({ archiveId, profile, q = "", dateFrom = "", dateTo = "", offset = 0, limit = 50 } = {}) {
  const history = readArchiveHistory(archiveId);
  const query = String(q || "").trim().toLowerCase();
  let events = (history.events || []).filter(e => !profile || e.profile === profile);
  if (dateFrom) events = events.filter(e => String(e.timestamp || "") >= dateFrom);
  if (dateTo) events = events.filter(e => String(e.timestamp || "") <= `${dateTo}\uffff`);
  if (query) events = events.filter(e => [e.text, e.scenelet, e.profile, e.sessionName].some(v => String(v || "").toLowerCase().includes(query)));
  events = events.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  const start = Math.max(0, Number(offset || 0));
  const max = Math.max(1, Number(limit || 50));
  return {
    events: events.slice(start, start + max).map(e => ({ ...e, archived: true, archiveId })),
    total: events.length,
  };
}

function resetSessionsForProfiles(profiles = []) {
  const names = new Set(profiles);
  let changed = 0;
  for (const map of Object.values(sessions)) {
    for (const [, user] of map) {
      for (const session of user.list || []) {
        if (!names.has(session._profile || "默认")) continue;
        session.sid = uuid();
        session._firstTurn = true;
        session._visibleHistory = [];
        session._proactiveIntents = [];
        session._lastUserAt = null;
        session._lastAssistantAt = null;
        session._lastProactiveAt = null;
        session._lastContextToken = null;
        session._lastUsage = null;
        session._apiMessages = [];
        session._turnCount = 0;
        session._lastFailedTurn = null;
        changed += 1;
      }
    }
  }
  if (changed && typeof globalThis.__wechatSaveSessions === "function") globalThis.__wechatSaveSessions();
  return changed;
}

export async function archiveAndHardResetWorldlines({ profiles = [], reason = "" } = {}) {
  const names = [...new Set(profiles.map(p => String(p || "").trim()).filter(Boolean))];
  if (!names.length) throw new Error("profiles are required");
  const archive = await createWorldlineArchive({ profiles: names, reason, hardReset: true });
  const deletedEvents = await deleteEventsForProfiles(names);
  for (const profile of names) {
    resetRoleRuntimeWorld(profile);
    saveMemoryDocument("", profile);
    saveWorldMemoryDocument("", profile);
  }
  if (!saveRoleWorlds()) throw new Error("failed to persist reset world state");
  const resetSessions = resetSessionsForProfiles(names);
  return { ok: true, ...archive, deletedEvents, resetSessions };
}
