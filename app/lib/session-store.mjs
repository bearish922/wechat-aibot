import fs from "node:fs";
import { uuid, log } from "./utils.mjs";
import { DATA_DIR, dataPath, ensureDir } from "./paths.mjs";
import { sessions, profileTemplates } from "./state.mjs";
import { saveRoleWorlds } from "./world-state.mjs";
import { normalizeFailedTurn, normalizeWorldState, normalizeWorldSession, normalizeWorldLastOutput, normalizeLifeArcs, normalizeVisibleHistory, normalizeProactiveIntents } from "./normalize.mjs";

const SESSION_FILE = dataPath("wechat-sessions.json");
const PROFILE_FILE = dataPath("wechat-profiles.json");

export function loadProfiles() {
  for (const k of Object.keys(profileTemplates)) delete profileTemplates[k];
  try {
    if (fs.existsSync(PROFILE_FILE)) {
      const d = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf-8"));
      Object.assign(profileTemplates, d.templates || { "默认": "保持 AI 的默认风格" });
    } else {
      Object.assign(profileTemplates, { "默认": "保持 AI 的默认风格" });
    }
  } catch { Object.assign(profileTemplates, { "默认": "保持 AI 的默认风格" }); }
}

export function makeSession(name, profile = null) {
  return {
    id: uuid(),
    name,
    busy: false,
    queue: [],
    _closing: false,
    _lastEnd: 0,
    sid: uuid(),
    _firstTurn: true,
    _profile: profile,
    _lastFailedTurn: null,
    _worldState: null,
    _worldSession: null,
    _worldLastOutput: null,
    _lifeArcs: [],
    _visibleHistory: [],
    _proactiveIntents: [],
    _lastUserAt: null,
    _lastAssistantAt: null,
    _lastProactiveAt: null,
    _lastDailyShareSeedAt: null,
    _lastScheduleCheckAt: null,
    _lastContextToken: null,
  };
}

export function hydrateSession(ai, raw = {}) {
  return {
    id: raw.id || uuid(),
    name: raw.name || "S1",
    sid: raw.sid || uuid(),
    _firstTurn: raw._firstTurn ?? true,
    busy: false,
    queue: [],
    _closing: false,
    _lastEnd: 0,
    _profile: raw._profile ?? null,
    _lastFailedTurn: normalizeFailedTurn(raw._lastFailedTurn),
    _worldState: normalizeWorldState(raw._worldState),
    _worldSession: normalizeWorldSession(raw._worldSession),
    _worldLastOutput: normalizeWorldLastOutput(raw._worldLastOutput),
    _lifeArcs: normalizeLifeArcs(raw._lifeArcs, { includeClosed: true }),
    _visibleHistory: normalizeVisibleHistory(raw._visibleHistory),
    _proactiveIntents: normalizeProactiveIntents(raw._proactiveIntents),
    _lastUserAt: raw._lastUserAt ? String(raw._lastUserAt) : null,
    _lastAssistantAt: raw._lastAssistantAt ? String(raw._lastAssistantAt) : null,
    _lastProactiveAt: raw._lastProactiveAt ? String(raw._lastProactiveAt) : null,
    _lastDailyShareSeedAt: raw._lastDailyShareSeedAt ? String(raw._lastDailyShareSeedAt) : null,
    _lastScheduleCheckAt: raw._lastScheduleCheckAt ? String(raw._lastScheduleCheckAt) : null,
    _lastContextToken: raw._lastContextToken ? String(raw._lastContextToken) : null,
  };
}

export function saveSessions() {
  ensureDir(DATA_DIR);
  const data = {};
  for (const [ai, map] of Object.entries(sessions)) {
    const aiData = {};
    for (const [userId, u] of map) {
      aiData[userId] = {
        activeId: u.activeId,
        list: u.list.map(s => ({
          id: s.id,
          name: s.name,
          sid: s.sid,
          _firstTurn: s._firstTurn,
          _profile: s._profile ?? null,
          _lastFailedTurn: normalizeFailedTurn(s._lastFailedTurn),
          _worldState: normalizeWorldState(s._worldState),
          _worldSession: normalizeWorldSession(s._worldSession),
          _worldLastOutput: normalizeWorldLastOutput(s._worldLastOutput),
          _lifeArcs: normalizeLifeArcs(s._lifeArcs, { includeClosed: true }),
          _visibleHistory: normalizeVisibleHistory(s._visibleHistory),
          _proactiveIntents: normalizeProactiveIntents(s._proactiveIntents),
          _lastUserAt: s._lastUserAt || null,
          _lastAssistantAt: s._lastAssistantAt || null,
          _lastProactiveAt: s._lastProactiveAt || null,
          _lastDailyShareSeedAt: s._lastDailyShareSeedAt || null,
          _lastScheduleCheckAt: s._lastScheduleCheckAt || null,
          _lastContextToken: s._lastContextToken || null,
        })),
      };
    }
    data[ai] = aiData;
  }
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
  saveRoleWorlds();
}

export function loadSessions() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
      const topKeys = Object.keys(data);
      const isNewFormat = topKeys.includes("cc") || topKeys.includes("codex");
      if (!isNewFormat) {
        const ccMap = new Map();
        for (const [userId, u] of Object.entries(data)) {
          ccMap.set(userId, {
            activeId: u.activeId,
            list: (u.list || []).map(s => hydrateSession("cc", s)),
          });
        }
        sessions.cc = ccMap;
        sessions.codex = new Map();
      } else {
        for (const ai of ["cc", "codex"]) {
          const aiData = data[ai] || {};
          const map = new Map();
          for (const [userId, u] of Object.entries(aiData)) {
            map.set(userId, {
              activeId: u.activeId,
              list: (u.list || []).map(s => hydrateSession(ai, s)),
            });
          }
          sessions[ai] = map;
        }
      }
      const ccCount = Array.from(sessions.cc.values()).reduce((s, u) => s + u.list.length, 0);
      const codexCount = Array.from(sessions.codex.values()).reduce((s, u) => s + u.list.length, 0);
      log("\u{1F4C2}", `loaded sessions: CC ${ccCount}, Codex ${codexCount}`);
      return true;
    }
  } catch (e) { log("⚠️", `load sessions failed: ${e.message}`); }
  return false;
}
