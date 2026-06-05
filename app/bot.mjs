import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decode as decodeSilk, getDuration as getSilkDuration, isSilk as isSilkAudio } from "silk-wasm";

// ─── CONFIG ───────────────────────────────────────────────────
import { configValue, envOrConfig, configBool, configNumber } from "./lib/config.mjs";
import { DATA_DIR, RUNTIME_DIR, appPath, dataPath, rootPath, ensureDir, resolveProjectPath } from "./lib/paths.mjs";

const USER_HOME = process.env.USERPROFILE || process.env.HOME || process.cwd();
const DEFAULT_NPM_GLOBAL = process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : path.join(USER_HOME, "AppData", "Roaming", "npm");
function usableConfigString(value, fallback) {
  const text = String(value ?? "").trim();
  return text && !/^(填写|可选)/u.test(text) ? text : fallback;
}
function firstExisting(paths) {
  return paths.find(p => p && fs.existsSync(p)) || null;
}
function listDirs(parent) {
  try {
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }
}
function latestExisting(paths) {
  return paths
    .filter(p => p && fs.existsSync(p))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}
function commandOnPath(command) {
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(finder, [command], { encoding: "utf8", timeout: 3000, windowsHide: true });
  if (result.status !== 0) return null;
  const found = (result.stdout || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return firstExisting([
    ...found.filter(p => /\.exe$/i.test(p)),
    ...found.filter(p => /\.(cmd|bat)$/i.test(p)),
    ...found,
  ]);
}
const NPM_GLOBAL = usableConfigString(configValue("paths.npmGlobal", DEFAULT_NPM_GLOBAL), DEFAULT_NPM_GLOBAL);
function claudeNativeFallback() {
  if (process.platform !== "win32") return null;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const anthropicDir = path.join(NPM_GLOBAL, "node_modules", "@anthropic-ai");
  const tempCandidates = listDirs(anthropicDir)
    .filter(name => name.startsWith(".claude-code-"))
    .map(name => path.join(anthropicDir, name, "node_modules", "@anthropic-ai", `claude-code-win32-${arch}`, "claude.exe"));
  const claudeDesktopCache = path.join(
    process.env.LOCALAPPDATA || path.join(USER_HOME, "AppData", "Local"),
    "Packages",
    "Claude_pzs8sxrjxfjjc",
    "LocalCache",
    "Roaming",
    "Claude",
    "claude-code",
  );
  const desktopCandidates = listDirs(claudeDesktopCache).map(name => path.join(claudeDesktopCache, name, "claude.exe"));
  return latestExisting([
    path.join(anthropicDir, "claude-code", "node_modules", "@anthropic-ai", `claude-code-win32-${arch}`, "claude.exe"),
    ...tempCandidates,
    ...desktopCandidates,
  ]);
}
function isNpmClaudeStub(command) {
  try {
    const normalized = path.normalize(command).toLowerCase();
    return process.platform === "win32"
      && normalized.endsWith(path.normalize("@anthropic-ai/claude-code/bin/claude.exe").toLowerCase())
      && fs.statSync(command).size < 4096;
  } catch {
    return false;
  }
}
function resolveClaudeCommand(command) {
  if (!isNpmClaudeStub(command)) return command;
  return claudeNativeFallback() || command;
}
const DEFAULT_CLAUDE = commandOnPath("claude") || firstExisting([
  path.join(NPM_GLOBAL, "claude.cmd"),
  path.join(NPM_GLOBAL, "claude.exe"),
  path.join(NPM_GLOBAL, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
]) || "claude";
const DEFAULT_CODEX = commandOnPath("codex") || firstExisting([
  path.join(NPM_GLOBAL, "codex.cmd"),
  path.join(NPM_GLOBAL, "codex.exe"),
  path.join(NPM_GLOBAL, "node_modules", "@openai", "codex", "bin", "codex.js"),
]) || "codex";
const CLAUDE_CONFIGURED = usableConfigString(envOrConfig("WECHAT_CLAUDE_PATH", "paths.claude", DEFAULT_CLAUDE), DEFAULT_CLAUDE);
const CLAUDE = resolveClaudeCommand(CLAUDE_CONFIGURED);
const CODEX = usableConfigString(envOrConfig("WECHAT_CODEX_PATH", "paths.codex", DEFAULT_CODEX), DEFAULT_CODEX);
const NODE = process.execPath;
const AI_WORK_DIR = usableConfigString(envOrConfig("WECHAT_AI_WORK_DIR", "paths.workDir", USER_HOME), USER_HOME);
const SHARED_HTTPS_PROXY = envOrConfig("WECHAT_HTTPS_PROXY", "proxy.https", "");
const CLAUDE_HTTPS_PROXY = envOrConfig("WECHAT_CLAUDE_HTTPS_PROXY", "proxy.claudeHttps", SHARED_HTTPS_PROXY);
const CODEX_HTTPS_PROXY = envOrConfig("WECHAT_CODEX_HTTPS_PROXY", "proxy.codexHttps", SHARED_HTTPS_PROXY);
const RAG_HTTPS_PROXY = envOrConfig("WECHAT_RAG_HTTPS_PROXY", "proxy.ragHttps", SHARED_HTTPS_PROXY);
const CLAUDE_MAIN_MODEL = envOrConfig("WECHAT_CLAUDE_MAIN_MODEL", "models.claudeMain", "deepseek-v4-pro[1m]");
const CLAUDE_FAST_MODEL = envOrConfig("WECHAT_CLAUDE_FAST_MODEL", "models.claudeFast", "deepseek-v4-flash[1m]");
const CLAUDE_FALLBACK_MODEL = envOrConfig("WECHAT_CLAUDE_FALLBACK_MODEL", "models.claudeFallback", "deepseek-v4-pro[1m]");
const SCENELET_MODEL = envOrConfig("WECHAT_SCENELET_MODEL", "models.scenelet", "deepseek-v4-pro[1m]");
const SCENELET_BARE = configBool("scene.sceneletBare", false);
const CLAUDE_TIMEOUT_MS = configNumber("timeouts.aiMs", 600_000);
const RAG_SCRIPT = resolveProjectPath(configValue("paths.ragScript", "app/rag.py"));
const RAG_ENABLED = configBool("rag.enabled", true);
const RAG_KNOWLEDGE_DIR = resolveProjectPath(configValue("rag.knowledgeDir", "data/knowledge"));
const RAG_TIMEOUT_MS = configNumber("rag.timeoutMs", 45_000);
const RAG_PROFILE_RULE_MAX_CHARS = configNumber("rag.profileRuleMaxChars", 1400);
const INPUT_BATCH_MS = 30_000;
const DUPLICATE_INPUT_MS = 5000;
const CURRENT_SITE_AND_SEARCH_GUARD = [
  "【当前现场与检索补充规则】",
  "如果本轮没有被上下文明确限制，scenelet 优先选择千圣此刻正在经历的当前现场，而不是把外部活动写成回家后的回顾。片场、摄影棚、经纪公司、化妆间、后台、排练室、录制现场、通告车上、商场、书店、车站、电车、旅行地、散步路上都可以成为当前现场。",
  "外部活动一旦被选为当前现场，就让她停留在那里接这句话：写现场声音、身体状态、等待/移动/工作间隙和手边的小物，不要自动收束到公寓、Leo、花音、餐桌、沙发。",
  "可以自然形成 1-3 天的短期生活线，例如短途旅行、外景拍摄、连续排练、广告/节目通告；它只能是轻量、可过期的私有生活安排，不要写成官方公开事实。",
  "如果回复要给出真实作品、书名、作者、歌曲、艺人近况、公开活动、截图/OCR 文字后的具体判断或安利，必须使用 WebSearch/WebFetch 确认；不搜索就不要给精确推荐或精确断言。",
  "最终 visible reply 不能使用方括号表情或动作，例如 [笑]、[偷笑]、[微笑]、[推眼镜]。可以用自然文字、中文圆括号、emoji 或 kaomoji。",
].join("\n");

function getSceneConfig() {
  const p = loadPrompts();
  return {
    visibleContextTurns: p.visibleContextTurns || 8,
    sceneStateMaxChars: p.sceneStateMaxChars || 220,
    proactiveCheckIntervalMs: p.proactiveCheckIntervalMs || 20000,
    proactiveCooldownMs: p.proactiveCooldownMs || 1800000,
    proactiveDailyMax: p.proactiveDailyMax || 8,
    dailyShareSeedIntervalMs: p.dailyShareSeedIntervalMs || 2700000,
    dailyShareMinIdleMs: p.dailyShareMinIdleMs || 1800000,
    scheduleCheckIntervalMs: p.scheduleCheckIntervalMs || 86400000,
    scheduleMaxActive: p.scheduleMaxActive || 2,
    ragTopK: p.ragTopK || 6,
    ragMinScore: p.ragMinScore || 0.48,
    ragResultMaxChars: p.ragResultMaxChars || 3600,
    ragTimeoutMs: p.ragTimeoutMs || 45000,
  };
}
const SESSION_LOCK_RETRIES = 3;
const SESSION_LOCK_RETRY_MS = 2_000;
const SESSION_RELEASE_GRACE_MS = 800;
const TOKEN_FILE = dataPath("wechat-token.json");
const PROFILE_FILE = rootPath("wechat-profiles.json");
const SESSION_FILE = dataPath("wechat-sessions.json");
const ROLE_WORLD_FILE = dataPath("wechat-worlds.json");
const SESSION_REF_FILE = dataPath("会话恢复指令.txt");
const LOGS_DIR = dataPath("logs");
const LOG_RETENTION_DAYS = Number(process.env.WECHAT_LOG_RETENTION_DAYS ?? configValue("logs.retentionDays", 30));
const LOG_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INBOUND_MEDIA_DIR = dataPath("inbound_media");
const INSTANCE_LOCK_FILE = dataPath("runtime", ".wechat-aibot.lock");
const WECHAT_MEDIA_MAX_BYTES = 100 * 1024 * 1024;
const FILE_TEXT_PREVIEW_CHARS = 6000;
const DEFAULT_VISION_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_VISION_MODEL = "Qwen/Qwen3-VL-32B-Instruct";
const VISION_MODE = String(envOrConfig("WECHAT_VISION_MODE", "vision.mode", "auto")).trim().toLowerCase();
const VISION_BASE_URL = usableConfigString(process.env.WECHAT_VISION_BASE_URL ?? process.env.OPENAI_BASE_URL ?? configValue("vision.baseUrl", DEFAULT_VISION_BASE_URL), DEFAULT_VISION_BASE_URL);
const VISION_API_KEY = usableConfigString(process.env.WECHAT_VISION_API_KEY ?? process.env.OPENAI_API_KEY ?? configValue("vision.apiKey", ""), "");
const VISION_MODEL = usableConfigString(envOrConfig("WECHAT_VISION_MODEL", "vision.model", DEFAULT_VISION_MODEL), DEFAULT_VISION_MODEL);
const VISION_DETAIL = envOrConfig("WECHAT_VISION_DETAIL", "vision.detail", "high");
const VISION_TIMEOUT_MS = configNumber("vision.timeoutMs", 180_000);
const VOICE_ASR_ENABLED = configBool("voice.enabled", true);
const VOICE_WHISPERX_PYTHON = usableConfigString(envOrConfig("WECHAT_VOICE_WHISPERX_PYTHON", "voice.whisperxPython", envOrConfig("WECHAT_VOICE_PYTHON", "voice.pythonPath", "python")), "python");
const VOICE_MODEL = usableConfigString(envOrConfig("WECHAT_VOICE_MODEL", "voice.model", "large-v3"), "large-v3");
const VOICE_LANGUAGE = String(envOrConfig("WECHAT_VOICE_LANGUAGE", "voice.language", "auto") || "auto").trim();
const VOICE_COMPUTE_TYPE = usableConfigString(envOrConfig("WECHAT_VOICE_COMPUTE_TYPE", "voice.computeType", "default"), "default");
const VOICE_BATCH_SIZE = configNumber("voice.batchSize", 8);
const VOICE_SAMPLE_RATE = configNumber("voice.sampleRate", 24000);
const VOICE_NO_ALIGN = configBool("voice.noAlign", true);
const VOICE_TIMEOUT_MS = configNumber("voice.timeoutMs", 180_000);
import { MAX_REPLY_LEN, splitText, hasInboundAttachment, splitSocialReply, rememberRecentKaomoji, getChatStyle, formatZonedTimeParts, formatLocalChatReality, expressionCapabilityPrompt, loadPrompts } from "./lib/reply.mjs";
import { shouldSkipRag } from "./lib/rag.mjs";
import { startServer, stopServer } from "./lib/server.mjs";
import { registerStatusRoutes } from "./lib/gui-status.mjs";
import { registerSessionRoutes } from "./lib/gui-sessions.mjs";
import { registerProfileRoutes } from "./lib/gui-profiles.mjs";
import { registerConfigRoutes } from "./lib/gui-config.mjs";
import { registerHistoryRoutes } from "./lib/gui-history.mjs";
import { registerProactiveRoutes } from "./lib/gui-proactive.mjs";
import { registerMemoryRoutes } from "./lib/gui-memory.mjs";
import { registerPromptsRoutes } from "./lib/gui-prompts.mjs";
import { registerWorldRoutes } from "./lib/gui-world.mjs";
import { appendChatEvent } from "./lib/chat-history.mjs";

// ─── STATE ──────────────────────────────────────────────────
import { getUpdatesBuf, sessions, activeAI, profileTemplates, modelNames, pendingInputs, recentInputs, setToken, setSyncBuf, setActiveAI } from "./lib/state.mjs";
import { uuid, sleep, log, isPidRunning } from "./lib/utils.mjs";
import { loadToken, saveToken, loginWithQr, sendMessage, apiPost, CDN_BASE_URL } from "./lib/wechat.mjs";
import { applyMemoryOps, isMemoryEnabled, listMemoryItems, shouldRunMemoryWriter, memoryListText, memoryMaintenanceNotice, normalizeMemoryCategory, renderMemoryPrompt } from "./lib/memory.mjs";
const LONG_POLL_TIMEOUT_MS = 35_000;
let lastProactiveCheckAt = 0;
const roleWorlds = new Map();
globalThis.__wechatRoleWorlds = roleWorlds;
globalThis.__wechatSaveRoleWorlds = saveRoleWorlds;
globalThis.__wechatSaveSessions = saveSessions;

function loadModelNames() {
  // CC: read from ~/.claude/settings.json
  try {
    const p = path.join(USER_HOME, ".claude", "settings.json");
    if (fs.existsSync(p)) {
      const d = JSON.parse(fs.readFileSync(p, "utf-8"));
      modelNames.cc = d.env?.ANTHROPIC_MODEL || d.model || "unknown";
    }
  } catch {}
  // Codex: read from ~/.codex/config.toml
  try {
    const p = path.join(USER_HOME, ".codex", "config.toml");
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      const m = raw.match(/^model\s*=\s*"([^"]+)"/m);
      if (m) modelNames.codex = m[1];
    }
  } catch {}
}

// ─── HELPERS ────────────────────────────────────────────────
function cleanupOldLogs() {
  if (!Number.isFinite(LOG_RETENTION_DAYS) || LOG_RETENTION_DAYS <= 0) return;
  try {
    if (!fs.existsSync(LOGS_DIR)) return;
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const entry of fs.readdirSync(LOGS_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const filePath = path.join(LOGS_DIR, entry.name);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs >= cutoff) continue;
      fs.rmSync(filePath, { force: true });
      removed++;
    }
    if (removed) log("\u{1F9F9}", `已清理 ${removed} 个超过 ${LOG_RETENTION_DAYS} 天的日志文件`);
  } catch (e) {
    log("⚠️", `日志清理失败: ${e.message}`);
  }
}

function acquireInstanceLock() {
  try {
    ensureDir(RUNTIME_DIR);
    if (fs.existsSync(INSTANCE_LOCK_FILE)) {
      const oldPid = Number(fs.readFileSync(INSTANCE_LOCK_FILE, "utf-8").trim());
      if (oldPid !== process.pid && isPidRunning(oldPid)) {
        const guiUrl = "http://127.0.0.1:18720";
        process.stdout.write(`WeChat AI Bot is already running: PID ${oldPid}\n`);
        process.stdout.write(`Opening GUI: ${guiUrl}\n`);
        try { execSync(`cmd /c start ${guiUrl}`, { timeout: 5000, windowsHide: true }); } catch {}
        process.exit(0);
      }
    }
    fs.writeFileSync(INSTANCE_LOCK_FILE, String(process.pid));
  } catch (e) {
    process.stderr.write(`Failed to acquire instance lock: ${e.message}\n`);
    process.exit(1);
  }
}

function releaseInstanceLock() {
  try {
    if (!fs.existsSync(INSTANCE_LOCK_FILE)) return;
    const lockPid = Number(fs.readFileSync(INSTANCE_LOCK_FILE, "utf-8").trim());
    if (lockPid === process.pid) fs.unlinkSync(INSTANCE_LOCK_FILE);
  } catch {}
}

// ─── PROFILES ────────────────────────────────────────────────
function loadProfiles() {
  // Mutate in-place so all importing modules see the same object
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

// ── RAG query ──
function hasExplicitProfileName(userMessage, currentProfile = "") {
  return Object.keys(profileTemplates).some(name => name !== "默认" && name !== currentProfile && userMessage.includes(name));
}

function shouldUseRoleplayRag(userMessage) {
  const text = String(userMessage || "").trim();
  if (!text) return false;
  const kw = loadPrompts().ragKeywords || {};
  // Only trigger RAG for explicit lore/world-building terms or configured names.
  for (const key of ["lore", "names"]) {
    const pattern = String(kw[key] || "").trim();
    if (!pattern) continue;
    try {
      if (new RegExp(pattern, "u").test(text)) return true;
    } catch (e) {
      log("⚠️", `invalid RAG keyword regex (${key}): ${e.message}`);
    }
  }
  return false;
}

function shouldUseRagForTurn(userMessage, profile) {
  if (!profile || profile === "默认") return false;
  if (shouldSkipRag(userMessage)) return false;
  if (hasExplicitProfileName(userMessage, profile)) return true;
  return shouldUseRoleplayRag(userMessage);
}

function queryRag(userMessage, profile = null) {
  if (!fs.existsSync(RAG_SCRIPT)) return null;
  if (shouldSkipRag(userMessage)) {
    log("\u{1F50D}", "RAG skip (casual)");
    return null;
  }
  ensureDir(RUNTIME_DIR);
  const queryFile = path.join(RUNTIME_DIR, `.rag_query_${crypto.randomUUID()}.txt`);
  const started = Date.now();
  try {
    fs.writeFileSync(queryFile, userMessage, "utf-8");
    const args = ["-X", "utf8", RAG_SCRIPT, "query", "--file", queryFile];
    if (profile && profile !== "默认") args.push("--profile", profile);
    const sc = getSceneConfig();
    args.push("--top-k", String(sc.ragTopK));
    args.push("--min-score", String(sc.ragMinScore));
    args.push("--result-max-chars", String(sc.ragResultMaxChars));
    const result = spawnSync("python", args, {
      cwd: path.dirname(RAG_SCRIPT),
      encoding: "utf-8",
      timeout: sc.ragTimeoutMs,
      windowsHide: true,
      env: envWithProxy(RAG_HTTPS_PROXY, {
        HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
      }),
    });

    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr?.trim() || `rag.py exited ${result.status}`);

    const out = result.stdout.trim();
    const elapsed = Date.now() - started;
    if (out) log("\u{1F50D}", `RAG hit (${out.length} chars, ${elapsed}ms)`);
    else log("\u{1F50D}", `RAG miss (${elapsed}ms)`);
    return out || null;
  } catch (e) {
    log("\u{1F50D}", `RAG miss: ${e.message?.slice(0, 80) || e}`);
    return null;
  } finally {
    try { fs.rmSync(queryFile, { force: true }); } catch {}
  }
}

function profileRuleCandidates(profile) {
  if (!profile || profile === "默认") return [];
  const rulesDir = path.join(RAG_KNOWLEDGE_DIR, "05_模型规则");
  const candidates = [
    path.join(rulesDir, `${profile}-核心规则.md`),
    path.join(rulesDir, `${profile}-边界规则.md`),
  ];
  if (profile === "白鹭千圣") {
    candidates.unshift(path.join(rulesDir, "白鹭千圣-核心规则.md"));
  }
  return [...new Set(candidates)];
}

function loadPinnedProfileRules(profile) {
  for (const file of profileRuleCandidates(profile)) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, "utf-8").trim();
      if (!raw) continue;
      const text = raw.length > RAG_PROFILE_RULE_MAX_CHARS
        ? `${raw.slice(0, RAG_PROFILE_RULE_MAX_CHARS)}\n\n[...]`
        : raw;
      return [
        "【固定角色规则】",
        "以下规则每轮固定生效，用于约束角色扮演边界。它不是剧情原文，也不是用户消息。",
        text,
      ].join("\n");
    } catch {}
  }
  return "";
}

function sessionProfile(sess) {
  return sess?._profile ?? null;
}

function makeSession(name, profile = null) {
  return {
    id: uuid(),
    name,
    busy: false,
    queue: [],
    _closing: false,
    _lastEnd: 0,
    sid: uuid(),
    _firstTurn: true,
    _recentKaomoji: [],
    _kaomojiTurn: 0,
    _profile: profile,
    _lastFailedTurn: null,
    _worldState: null,
    _worldSession: null,
    _worldLastOutput: null,
    _sceneState: null,
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

function normalizeFailedTurn(raw) {
  if (!raw?.body) return null;
  return {
    body: String(raw.body),
    timestamp: raw.timestamp ? String(raw.timestamp) : null,
    reason: raw.reason ? String(raw.reason).slice(0, 500) : "",
    sid: raw.sid ? String(raw.sid) : null,
  };
}

function normalizeSceneState(raw) {
  if (!raw) return null;
  const text = typeof raw === "string" ? raw : raw.text;
  if (!text) return null;
  return {
    text: String(text).slice(0, getSceneConfig().sceneStateMaxChars),
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : new Date().toISOString(),
    expiresAt: raw.expiresAt ? String(raw.expiresAt) : null,
  };
}

function normalizeVisibleHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(item => item?.role && item?.text)
    .slice(-getSceneConfig().visibleContextTurns * 2)
    .map(item => ({
      role: item.role === "assistant" ? "assistant" : "user",
      text: String(item.text).slice(0, 4000),
      timestamp: item.timestamp ? String(item.timestamp) : null,
      kind: item.kind ? String(item.kind) : "chat",
    }));
}

function normalizeProactiveIntent(raw) {
  if (!raw?.id || !raw?.scheduledAt) return null;
  return {
    id: String(raw.id),
    status: ["pending", "sent", "cancelled"].includes(raw.status) ? raw.status : "pending",
    createdAt: raw.createdAt ? String(raw.createdAt) : new Date().toISOString(),
    scheduledAt: String(raw.scheduledAt),
    expiresAt: raw.expiresAt ? String(raw.expiresAt) : null,
    sourceTurnAt: raw.sourceTurnAt ? String(raw.sourceTurnAt) : null,
    sourceUserText: raw.sourceUserText ? String(raw.sourceUserText).slice(0, 500) : "",
    basis: raw.basis ? String(raw.basis).slice(0, 800) : "",
    cancelIf: Array.isArray(raw.cancelIf) ? raw.cancelIf.map(x => String(x).slice(0, 200)).slice(0, 8) : [],
    innerScenelet: raw.innerScenelet ? String(raw.innerScenelet).slice(0, 2000) : "",
    messageIntent: raw.messageIntent ? String(raw.messageIntent).slice(0, 500) : "",
    kind: ["follow_up", "daily_share"].includes(raw.kind) ? raw.kind : "follow_up",
    lastCheckedAt: raw.lastCheckedAt ? String(raw.lastCheckedAt) : null,
    sentAt: raw.sentAt ? String(raw.sentAt) : null,
    cancelledAt: raw.cancelledAt ? String(raw.cancelledAt) : null,
    cancelReason: raw.cancelReason ? String(raw.cancelReason).slice(0, 500) : "",
  };
}

function normalizeProactiveIntents(raw) {
  if (!Array.isArray(raw)) return [];
  const byId = new Map();
  for (const intent of raw.map(normalizeProactiveIntent).filter(Boolean)) {
    byId.set(intent.id, { ...byId.get(intent.id), ...intent });
  }
  return [...byId.values()]
    .sort((a, b) => Date.parse(a.createdAt || a.scheduledAt || 0) - Date.parse(b.createdAt || b.scheduledAt || 0))
    .slice(-20);
}

function emptyToolUsage() {
  return { webSearch: 0, webFetch: 0, tools: [] };
}

function normalizeToolUsage(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  const tools = Array.isArray(raw.tools)
    ? [...new Set(raw.tools.map(x => String(x || "").trim()).filter(Boolean))]
    : [];
  return {
    webSearch: Math.max(0, Number(raw.webSearch || raw.web_search_requests || 0) || 0),
    webFetch: Math.max(0, Number(raw.webFetch || raw.web_fetch_requests || 0) || 0),
    tools,
  };
}

function emptyWorldState() {
  return {
    location: "",
    activity: "",
    awakeState: "",
    currentPlan: "",
    openThreads: [],
    lastWorldEventAt: null,
    updatedAt: null,
  };
}

function normalizeWorldState(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  const openThreads = Array.isArray(raw.openThreads || raw.open_threads)
    ? (raw.openThreads || raw.open_threads).map(x => String(x || "").trim()).filter(Boolean).slice(0, 8)
    : [];
  const state = {
    location: raw.location ? String(raw.location).slice(0, 160) : "",
    activity: raw.activity ? String(raw.activity).slice(0, 200) : "",
    awakeState: raw.awakeState || raw.awake_state ? String(raw.awakeState || raw.awake_state).slice(0, 80) : "",
    currentPlan: raw.currentPlan || raw.current_plan ? String(raw.currentPlan || raw.current_plan).slice(0, 300) : "",
    openThreads,
    lastWorldEventAt: raw.lastWorldEventAt || raw.last_world_event_at ? String(raw.lastWorldEventAt || raw.last_world_event_at) : null,
    updatedAt: raw.updatedAt || raw.updated_at ? String(raw.updatedAt || raw.updated_at) : null,
  };
  return Object.values(state).some(Boolean) || openThreads.length ? state : null;
}

function applyWorldStatePatch(sess, rawPatch = null) {
  if (!sess || !rawPatch || typeof rawPatch !== "object") return;
  const current = normalizeWorldState(sess._worldState) || emptyWorldState();
  const patch = normalizeWorldState(rawPatch);
  if (!patch) return;
  sess._worldState = normalizeWorldState({
    ...current,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => {
      if (Array.isArray(v)) return v.length;
      return v !== null && v !== "";
    })),
    updatedAt: new Date().toISOString(),
  });
}

function normalizeWorldSession(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  return {
    sid: raw.sid ? String(raw.sid) : null,
    firstTurn: raw.firstTurn === true || raw._firstTurn === true,
    model: raw.model ? String(raw.model) : SCENELET_MODEL,
    startedAt: raw.startedAt ? String(raw.startedAt) : null,
    lastUsedAt: raw.lastUsedAt ? String(raw.lastUsedAt) : null,
    resetReason: raw.resetReason ? String(raw.resetReason).slice(0, 300) : "",
    lastUsage: raw.lastUsage && typeof raw.lastUsage === "object" ? raw.lastUsage : null,
  };
}

function normalizeWorldLastOutput(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  return {
    timestamp: raw.timestamp ? String(raw.timestamp) : null,
    innerScenelet: raw.innerScenelet ? String(raw.innerScenelet).slice(0, 4000) : "",
    nextSceneState: raw.nextSceneState ? String(raw.nextSceneState).slice(0, getSceneConfig().sceneStateMaxChars) : "",
    worldStatePatch: raw.worldStatePatch && typeof raw.worldStatePatch === "object" ? raw.worldStatePatch : null,
    dailyShareCandidates: Array.isArray(raw.dailyShareCandidates) ? raw.dailyShareCandidates.slice(0, 5) : [],
    scheduleCandidates: Array.isArray(raw.scheduleCandidates) ? raw.scheduleCandidates.slice(0, 5) : [],
    timeReasoning: raw.timeReasoning && typeof raw.timeReasoning === "object" ? raw.timeReasoning : null,
    continuityWarnings: Array.isArray(raw.continuityWarnings) ? raw.continuityWarnings.map(x => String(x).slice(0, 300)).slice(0, 8) : [],
  };
}

function ensureWorldSession(sess) {
  if (!sess._worldSession) {
    const nowIso = new Date().toISOString();
    sess._worldSession = {
      sid: uuid(),
      firstTurn: true,
      model: SCENELET_MODEL,
      startedAt: nowIso,
      lastUsedAt: null,
      resetReason: "",
      lastUsage: null,
    };
  } else {
    sess._worldSession = normalizeWorldSession(sess._worldSession) || null;
    if (!sess._worldSession) return ensureWorldSession(sess);
    if (!sess._worldSession.sid) {
      sess._worldSession.sid = uuid();
      sess._worldSession.firstTurn = true;
    }
    if (!sess._worldSession.model) sess._worldSession.model = SCENELET_MODEL;
  }
  return sess._worldSession;
}

function roleWorldKey(profile) {
  return String(profile || "默认").trim() || "默认";
}

function normalizeRoleWorld(raw = {}, profile = "默认") {
  const nowIso = new Date().toISOString();
  return {
    profile: roleWorldKey(raw.profile || profile),
    _worldState: normalizeWorldState(raw._worldState || raw.worldState),
    _worldSession: normalizeWorldSession(raw._worldSession || raw.worldSession) || {
      sid: uuid(),
      firstTurn: true,
      model: SCENELET_MODEL,
      startedAt: nowIso,
      lastUsedAt: null,
      resetReason: "",
      lastUsage: null,
    },
    _worldLastOutput: normalizeWorldLastOutput(raw._worldLastOutput || raw.worldLastOutput),
    _sceneState: normalizeSceneState(raw._sceneState || raw.sceneState),
    _lifeArcs: normalizeLifeArcs(raw._lifeArcs || raw.lifeArcs, { includeClosed: true }),
    _lastDailyShareSeedAt: raw._lastDailyShareSeedAt ? String(raw._lastDailyShareSeedAt) : null,
    _lastScheduleCheckAt: raw._lastScheduleCheckAt ? String(raw._lastScheduleCheckAt) : null,
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : nowIso,
  };
}

function getRoleWorld(profile) {
  const key = roleWorldKey(profile);
  if (!roleWorlds.has(key)) {
    roleWorlds.set(key, normalizeRoleWorld({ profile: key }, key));
  }
  return roleWorlds.get(key);
}

function roleWorldSnapshot(world) {
  return {
    profile: roleWorldKey(world?.profile),
    _worldState: normalizeWorldState(world?._worldState),
    _worldSession: normalizeWorldSession(world?._worldSession),
    _worldLastOutput: normalizeWorldLastOutput(world?._worldLastOutput),
    _sceneState: normalizeSceneState(world?._sceneState),
    _lifeArcs: normalizeLifeArcs(world?._lifeArcs, { includeClosed: true }),
    _lastDailyShareSeedAt: world?._lastDailyShareSeedAt || null,
    _lastScheduleCheckAt: world?._lastScheduleCheckAt || null,
    updatedAt: world?.updatedAt || new Date().toISOString(),
  };
}

function saveRoleWorlds() {
  try {
    ensureDir(DATA_DIR);
    const data = { version: 1, roles: {} };
    for (const [profile, world] of roleWorlds) {
      data.roles[profile] = roleWorldSnapshot(world);
    }
    fs.writeFileSync(ROLE_WORLD_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch (e) {
    log("⚠️", `保存 hidden worlds 失败: ${e.message}`);
  }
}

function loadRoleWorlds() {
  roleWorlds.clear();
  try {
    if (fs.existsSync(ROLE_WORLD_FILE)) {
      const data = JSON.parse(fs.readFileSync(ROLE_WORLD_FILE, "utf-8"));
      const roles = data?.roles && typeof data.roles === "object" ? data.roles : {};
      for (const [profile, raw] of Object.entries(roles)) {
        roleWorlds.set(roleWorldKey(profile), normalizeRoleWorld(raw, profile));
      }
    }
  } catch (e) {
    log("⚠️", `加载 hidden worlds 失败: ${e.message}`);
  }
  migrateRoleWorldsFromSessions();
  for (const profile of Object.keys(profileTemplates || {})) getRoleWorld(profile);
  saveRoleWorlds();
}

function migrateRoleWorldsFromSessions() {
  for (const map of Object.values(sessions)) {
    for (const [, u] of map) {
      for (const sess of u.list || []) {
        const profile = sessionProfile(sess);
        if (!profile || !profileTemplates[profile]) continue;
        const key = roleWorldKey(profile);
        if (roleWorlds.has(key)) continue;
        const hasWorldData = sess._worldSession || sess._worldState || sess._worldLastOutput || sess._lifeArcs?.length || sess._sceneState;
        if (!hasWorldData) continue;
        roleWorlds.set(key, normalizeRoleWorld({
          profile: key,
          _worldState: sess._worldState,
          _worldSession: sess._worldSession,
          _worldLastOutput: sess._worldLastOutput,
          _sceneState: sess._sceneState,
          _lifeArcs: sess._lifeArcs,
          _lastDailyShareSeedAt: sess._lastDailyShareSeedAt,
          _lastScheduleCheckAt: sess._lastScheduleCheckAt,
        }, key));
      }
    }
  }
}

function syncRoleWorldToSession(sess, profile) {
  if (!sess || !profile) return;
  const world = getRoleWorld(profile);
  sess._worldState = normalizeWorldState(world._worldState);
  sess._worldSession = normalizeWorldSession(world._worldSession);
  sess._worldLastOutput = normalizeWorldLastOutput(world._worldLastOutput);
  sess._lifeArcs = normalizeLifeArcs(world._lifeArcs, { includeClosed: true });
  if (world._sceneState) sess._sceneState = normalizeSceneState(world._sceneState);
  sess._lastDailyShareSeedAt = world._lastDailyShareSeedAt || sess._lastDailyShareSeedAt || null;
  sess._lastScheduleCheckAt = world._lastScheduleCheckAt || sess._lastScheduleCheckAt || null;
}

function mergeToolUsage(...items) {
  const merged = emptyToolUsage();
  for (const item of items.map(normalizeToolUsage).filter(Boolean)) {
    merged.webSearch += item.webSearch;
    merged.webFetch += item.webFetch;
    for (const tool of item.tools) {
      if (!merged.tools.includes(tool)) merged.tools.push(tool);
    }
  }
  return merged;
}

function markToolUsage(usage, name, count = 1) {
  if (!usage || !name) return;
  const tool = String(name);
  const lower = tool.toLowerCase();
  if (!usage.tools.includes(tool)) usage.tools.push(tool);
  if (/web[_-]?search|websearch/i.test(lower)) usage.webSearch += count;
  if (/web[_-]?fetch|webfetch/i.test(lower)) usage.webFetch += count;
}

function toolUsageFromUsage(raw = null) {
  const usage = raw?.usage || raw;
  if (!usage || typeof usage !== "object") return emptyToolUsage();
  const server = usage.server_tool_use || {};
  const result = emptyToolUsage();
  result.webSearch += Number(server.web_search_requests || usage.web_search_requests || usage.webSearchRequests || 0) || 0;
  result.webFetch += Number(server.web_fetch_requests || usage.web_fetch_requests || usage.webFetchRequests || 0) || 0;
  if (result.webSearch > 0) result.tools.push("WebSearch");
  if (result.webFetch > 0) result.tools.push("WebFetch");
  return result;
}

function usageSummary(raw = null, modelUsage = null) {
  const usage = raw?.usage || raw || {};
  const models = modelUsage && typeof modelUsage === "object" ? modelUsage : raw?.modelUsage;
  const costFromModels = models && typeof models === "object"
    ? Object.values(models).reduce((sum, item) => sum + (Number(item?.costUSD || 0) || 0), 0)
    : 0;
  return {
    input_tokens: Number(usage.input_tokens || 0) || 0,
    cache_read_input_tokens: Number(usage.cache_read_input_tokens || 0) || 0,
    cache_creation_input_tokens: Number(usage.cache_creation_input_tokens || 0) || 0,
    output_tokens: Number(usage.output_tokens || 0) || 0,
    cost_usd: Number(raw?.total_cost_usd || costFromModels || 0) || 0,
    modelUsage: models || null,
  };
}

function writeHiddenUsageEvent(event) {
  try {
    ensureDir(LOGS_DIR);
    fs.appendFileSync(path.join(LOGS_DIR, "hidden-usage.jsonl"), JSON.stringify(event) + "\n", "utf-8");
  } catch {}
}

async function checkIntentDuplicateFlash(candidate, existingPending) {
  if (!existingPending.length) return false;
  const prompt = [
    "你判断一条新生成的主动消息意图，是否与已有意图本质上是重复的。",
    "重复 = 讲的是同一件事、目的相同，只是措辞不同。",
    "不重复 = 不同话题，或相同话题但目的明显不同（如追问结果 vs 分享经验）。",
    "",
    "新意图：",
    JSON.stringify({ kind: candidate.kind, intent: candidate.messageIntent }, null, 2),
    "",
    "已有意图（编号从1开始）：",
    existingPending.map((e, i) => `${i + 1}. [${e.kind}] ${e.messageIntent}`).join("\n"),
    "",
    "只输出 JSON，不要解释：",
    JSON.stringify({ duplicate: false }, null, 2),
  ].join("\n");
  const result = await runHiddenJson(prompt, {
    label: "intent_dedup",
    bare: true,
    model: CLAUDE_FAST_MODEL,
    timeoutMs: 30_000,
  });
  return Boolean(result?.duplicate);
}

function lifeArcPromptItems(sess) {
  return normalizeLifeArcs(sess?._lifeArcs).map(arc => ({
    id: arc.id,
    title: arc.title,
    summary: arc.summary,
    current_state: arc.currentState,
    next_useful_moment: arc.nextUsefulMoment,
    kind: arc.kind || null,
    time_start: arc.timeStart || null,
    time_end: arc.timeEnd || null,
    updated_at: arc.updatedAt,
    expires_at: arc.expiresAt,
  }));
}

function applyLifeArcOps(sess, rawOps = []) {
  if (!sess || !Array.isArray(rawOps) || !rawOps.length) return;
  const now = new Date();
  const nowIso = now.toISOString();
  const defaultExpiresAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const arcs = normalizeLifeArcs(sess._lifeArcs, { includeClosed: true });
  const findArc = (raw) => {
    const id = raw?.id ? String(raw.id) : "";
    if (id) {
      const byId = arcs.find(a => a.id === id);
      if (byId) return byId;
    }
    const title = raw?.title ? String(raw.title).trim().toLowerCase() : "";
    return title ? arcs.find(a => a.title.toLowerCase() === title) : null;
  };

  for (const raw of rawOps.slice(0, 5)) {
    if (!raw || typeof raw !== "object") continue;
    const op = String(raw.op || "").toLowerCase();
    if (!["create", "update", "close"].includes(op)) continue;
    const existing = findArc(raw);
    if (op === "close") {
      if (!existing) continue;
      existing.status = "closed";
      existing.updatedAt = nowIso;
      existing.closedAt = nowIso;
      existing.closeReason = raw.reason ? String(raw.reason).slice(0, 300) : existing.closeReason || "closed by scenelet";
      existing.expiresAt = nowIso;
      continue;
    }

    const expiresAt = raw.expires_at || raw.expiresAt ? String(raw.expires_at || raw.expiresAt) : (existing?.expiresAt || defaultExpiresAt);
    const lifeArcKinds = ["travel", "work", "school", "personal", "special_date"];
    const kind = lifeArcKinds.includes(raw.kind) ? raw.kind : (existing?.kind || null);
    const patch = {
      title: raw.title ? String(raw.title).trim().slice(0, 80) : existing?.title || "",
      summary: raw.summary ? String(raw.summary).trim().slice(0, 500) : existing?.summary || "",
      currentState: raw.current_state || raw.currentState ? String(raw.current_state || raw.currentState).trim().slice(0, 500) : existing?.currentState || "",
      nextUsefulMoment: raw.next_useful_moment || raw.nextUsefulMoment ? String(raw.next_useful_moment || raw.nextUsefulMoment).trim().slice(0, 300) : existing?.nextUsefulMoment || "",
      source: raw.reason ? String(raw.reason).trim().slice(0, 300) : existing?.source || "",
      kind,
      timeStart: raw.time_start || raw.timeStart ? String(raw.time_start || raw.timeStart) : (existing?.timeStart || null),
      timeEnd: raw.time_end || raw.timeEnd ? String(raw.time_end || raw.timeEnd) : (existing?.timeEnd || null),
      expiresAt,
    };
    if (!patch.title && !patch.summary && !patch.currentState) continue;
    if (existing) {
      Object.assign(existing, patch, { status: "active", updatedAt: nowIso });
    } else if (op === "create") {
      arcs.push({
        id: crypto.randomUUID(),
        status: "active",
        ...patch,
        createdAt: nowIso,
        updatedAt: nowIso,
        closedAt: null,
        closeReason: "",
      });
    }
  }

  sess._lifeArcs = normalizeLifeArcs(arcs, { includeClosed: true }).slice(-6);
}

function hydrateSession(ai, raw = {}) {
  return {
    id: raw.id || uuid(),
    name: raw.name || "S1",
    sid: raw.sid || uuid(),
    _firstTurn: raw._firstTurn ?? true,
    busy: false,
    queue: [],
    _closing: false,
    _lastEnd: 0,
    _recentKaomoji: raw._recentKaomoji || [],
    _kaomojiTurn: raw._kaomojiTurn || 0,
    _profile: raw._profile ?? null,
    _lastFailedTurn: normalizeFailedTurn(raw._lastFailedTurn),
    _worldState: normalizeWorldState(raw._worldState),
    _worldSession: normalizeWorldSession(raw._worldSession),
    _worldLastOutput: normalizeWorldLastOutput(raw._worldLastOutput),
    _sceneState: normalizeSceneState(raw._sceneState),
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

// ─── SESSION PERSISTENCE ─────────────────────────────────────
function saveSessions() {
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
          _recentKaomoji: s._recentKaomoji || [],
          _kaomojiTurn: s._kaomojiTurn || 0,
          _profile: s._profile ?? null,
          _lastFailedTurn: normalizeFailedTurn(s._lastFailedTurn),
          _worldState: normalizeWorldState(s._worldState),
          _worldSession: normalizeWorldSession(s._worldSession),
          _worldLastOutput: normalizeWorldLastOutput(s._worldLastOutput),
          _sceneState: normalizeSceneState(s._sceneState),
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

  // Human-readable resume reference file
  const lines = [];
  lines.push(`# WeChat AI Bot 会话恢复指令`);
  lines.push(`# 更新: ${new Date().toLocaleString("zh-CN")}`);
  lines.push("");
  for (const [ai, map] of Object.entries(sessions)) {
    const aiLabel = ai === "cc" ? "Claude Code" : "Codex";
    lines.push(`## ${aiLabel}`);
    for (const [userId, u] of map) {
      for (const s of u.list) {
        const active = s.id === u.activeId ? " [当前]" : "";
        lines.push(`  ${s.name}${active}`);
        lines.push(`    角色: ${sessionProfile(s) || "默认"}`);
        if (ai === "cc") {
          lines.push(`    claude --resume ${s.sid}`);
        } else {
          lines.push(`    codex resume ${s.sid}`);
        }
        lines.push("");
      }
    }
  }
  fs.writeFileSync(SESSION_REF_FILE, lines.join("\n"), "utf-8");
}

function loadSessions() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
      // Detect format: new has "cc"/"codex" top-level keys, old has userId keys
      const topKeys = Object.keys(data);
      const isNewFormat = topKeys.includes("cc") || topKeys.includes("codex");
      if (!isNewFormat) {
        // Old format: { userId: { activeId, list } } → migrate to cc
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
        for (const [ai, aiData] of Object.entries(data)) {
          const map = new Map();
          for (const [userId, u] of Object.entries(aiData)) {
            map.set(userId, {
              activeId: u.activeId,
              list: (u.list || []).map(s => hydrateSession(ai, s)),
            });
          }
          if (ai === "cc" || ai === "codex") sessions[ai] = map;
        }
      }
      const ccCount = Array.from(sessions.cc.values()).reduce((s, u) => s + u.list.length, 0);
      const codexCount = Array.from(sessions.codex.values()).reduce((s, u) => s + u.list.length, 0);
      log("\u{1F4C2}", `已加载会话: CC ${ccCount} 个, Codex ${codexCount} 个`);
      return true;
    }
  } catch (e) { log("⚠️", `加载会话失败: ${e.message}`); }
  return false;
}


function mediaLogPath() {
  return path.join(LOGS_DIR, "inbound-media.jsonl");
}

function logInboundMedia(msg) {
  if (!msg.item_list?.some(i => i.type !== 1)) return;
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(mediaLogPath(), JSON.stringify({
      timestamp: new Date().toISOString(),
      from_user_id: msg.from_user_id,
      context_token: msg.context_token,
      item_list: msg.item_list,
    }) + "\n");
  } catch {}
}

function getMimeFromFilename(filename = "") {
  const ext = path.extname(filename).toLowerCase();
  const m = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".zip": "application/zip",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
  };
  return m[ext] || "application/octet-stream";
}

function extensionFromMime(mime = "application/octet-stream", fallback = ".bin") {
  const m = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "audio/wav": ".wav",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/silk": ".silk",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/csv": ".csv",
    "application/json": ".json",
    "application/zip": ".zip",
  };
  return m[mime.split(";")[0].trim().toLowerCase()] || fallback;
}

function detectMimeFromBuffer(buf, fallback = "application/octet-stream") {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && ["GIF87a", "GIF89a"].includes(buf.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "%PDF") return "application/pdf";
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return "application/zip";
  return fallback;
}

function imageDimensions(buf) {
  try {
    if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length >= 10 && ["GIF87a", "GIF89a"].includes(buf.subarray(0, 6).toString("ascii"))) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf.length >= 30 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
      const chunk = buf.subarray(12, 16).toString("ascii");
      if (chunk === "VP8X" && buf.length >= 30) {
        return {
          width: 1 + buf.readUIntLE(24, 3),
          height: 1 + buf.readUIntLE(27, 3),
        };
      }
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) { offset++; continue; }
        const marker = buf[offset + 1];
        const len = buf.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
        }
        offset += 2 + len;
      }
    }
  } catch {}
  return null;
}

function sanitizeFilename(name = "file.bin") {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 120) || "file.bin";
}

function parseAesKey(aesKeyBase64, label) {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`${label}: invalid aes_key length ${decoded.length}`);
}

function decryptAesEcb(ciphertext, key) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function cdnDownloadUrl(media) {
  if (media?.full_url) return media.full_url;
  if (!media?.encrypt_query_param) return null;
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
}

async function fetchBuffer(url, label, timeoutMs = 60_000) {
  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), effectiveTimeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${label}: CDN ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > WECHAT_MEDIA_MAX_BYTES) throw new Error(`${label}: media too large (${buf.length} bytes)`);
    return buf;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`${label}: download timeout after ${effectiveTimeout}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function downloadCdnMedia(media, aesKeyBase64, label) {
  const url = cdnDownloadUrl(media);
  if (!url) throw new Error(`${label}: missing CDN download url`);
  const downloaded = await fetchBuffer(url, label);
  if (!aesKeyBase64) return downloaded;
  return decryptAesEcb(downloaded, parseAesKey(aesKeyBase64, label));
}

function saveInboundBuffer(buf, { kind, mime, originalFilename }) {
  if (!fs.existsSync(INBOUND_MEDIA_DIR)) fs.mkdirSync(INBOUND_MEDIA_DIR, { recursive: true });
  const fallbackExt = extensionFromMime(mime);
  const safeOriginal = sanitizeFilename(originalFilename || `${kind}${fallbackExt}`);
  const ext = path.extname(safeOriginal) || fallbackExt;
  const base = path.basename(safeOriginal, path.extname(safeOriginal));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(INBOUND_MEDIA_DIR, `${stamp}-${crypto.randomUUID().slice(0, 8)}-${base}${ext}`);
  fs.writeFileSync(filePath, buf);
  return filePath;
}

function normalizeLifeArc(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = raw.id ? String(raw.id) : "";
  const title = raw.title ? String(raw.title).trim().slice(0, 80) : "";
  const summary = raw.summary ? String(raw.summary).trim().slice(0, 500) : "";
  const currentState = raw.currentState || raw.current_state ? String(raw.currentState || raw.current_state).trim().slice(0, 500) : "";
  if (!id || (!title && !summary && !currentState)) return null;
  const nowIso = new Date().toISOString();
  const status = ["active", "closed"].includes(raw.status) ? raw.status : "active";
  const createdAt = raw.createdAt || raw.created_at ? String(raw.createdAt || raw.created_at) : nowIso;
  const updatedAt = raw.updatedAt || raw.updated_at ? String(raw.updatedAt || raw.updated_at) : createdAt;
  const defaultExpiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const rawExpiresAt = raw.expiresAt || raw.expires_at ? String(raw.expiresAt || raw.expires_at) : defaultExpiresAt;
  const expiresAt = Number.isFinite(Date.parse(rawExpiresAt)) ? rawExpiresAt : defaultExpiresAt;
  const lifeArcKinds = ["travel", "work", "school", "personal", "special_date"];
  const kind = lifeArcKinds.includes(raw.kind) ? raw.kind : null;
  const timeStart = raw.timeStart || raw.time_start ? String(raw.timeStart || raw.time_start) : null;
  const timeEnd = raw.timeEnd || raw.time_end ? String(raw.timeEnd || raw.time_end) : null;
  return {
    id,
    status,
    title,
    summary,
    currentState,
    nextUsefulMoment: raw.nextUsefulMoment || raw.next_useful_moment ? String(raw.nextUsefulMoment || raw.next_useful_moment).trim().slice(0, 300) : "",
    source: raw.source ? String(raw.source).trim().slice(0, 300) : "",
    kind,
    timeStart,
    timeEnd,
    createdAt,
    updatedAt,
    expiresAt,
    closedAt: raw.closedAt || raw.closed_at ? String(raw.closedAt || raw.closed_at) : null,
    closeReason: raw.closeReason || raw.close_reason ? String(raw.closeReason || raw.close_reason).trim().slice(0, 300) : "",
  };
}

function normalizeLifeArcs(raw, { includeClosed = false } = {}) {
  if (!Array.isArray(raw)) return [];
  const nowMs = Date.now();
  const byId = new Map();
  for (const arc of raw.map(normalizeLifeArc).filter(Boolean)) {
    const expiresMs = Date.parse(arc.expiresAt || "");
    if (!includeClosed && arc.status === "active" && Number.isFinite(expiresMs) && expiresMs < nowMs) continue;
    if (!includeClosed && arc.status !== "active") continue;
    byId.set(arc.id, { ...byId.get(arc.id), ...arc });
  }
  return [...byId.values()]
    .sort((a, b) => Date.parse(a.updatedAt || a.createdAt || 0) - Date.parse(b.updatedAt || b.createdAt || 0))
    .slice(-6);
}

function wavFromPcm16le(pcm, sampleRate) {
  const data = Buffer.from(pcm);
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function runProcessText(command, args, { cwd = process.cwd(), timeoutMs = 60_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const proc = spawnCli(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        proc.kill();
      }
    }, timeoutMs);
    proc.stdout.on("data", d => { stdout += d; if (stdout.length > 8000) stdout = stdout.slice(-8000); });
    proc.stderr.on("data", d => { stderr += d; if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      settled = true;
      resolve({ code, stdout, stderr, timedOut: proc.killed });
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      settled = true;
      resolve({ code: -1, stdout, stderr: `${stderr}\n${e.message}`.trim(), timedOut: false });
    });
  });
}

async function transcribeVoiceWithWhisperX(filePath) {
  if (!VOICE_ASR_ENABLED) return null;
  if (!filePath || !fs.existsSync(filePath)) return { error: "voice file missing" };
  if (!commandExists(VOICE_WHISPERX_PYTHON)) return { error: `voice WhisperX python not found: ${VOICE_WHISPERX_PYTHON}` };

  const input = fs.readFileSync(filePath);
  const runtimeDir = path.join(RUNTIME_DIR, "voice_asr");
  ensureDir(runtimeDir);
  const stem = `${path.basename(filePath, path.extname(filePath))}-${crypto.randomUUID().slice(0, 8)}`;
  const wavPath = path.join(runtimeDir, `${stem}.wav`);
  const outDir = path.join(runtimeDir, `${stem}-out`);
  ensureDir(outDir);

  let durationMs = null;
  if (isSilkAudio(input)) {
    durationMs = getSilkDuration(input);
    const decoded = await decodeSilk(input, VOICE_SAMPLE_RATE);
    fs.writeFileSync(wavPath, wavFromPcm16le(decoded.data, VOICE_SAMPLE_RATE));
  } else {
    fs.copyFileSync(filePath, wavPath);
  }

  const args = [
    "-m", "whisperx",
    wavPath,
    "--model", VOICE_MODEL,
    "--output_dir", outDir,
    "--output_format", "txt",
    "--batch_size", String(VOICE_BATCH_SIZE),
    "--compute_type", VOICE_COMPUTE_TYPE,
    "--verbose", "False",
  ];
  if (VOICE_LANGUAGE && VOICE_LANGUAGE.toLowerCase() !== "auto") {
    args.push("--language", VOICE_LANGUAGE);
  }
  if (VOICE_NO_ALIGN) args.push("--no_align");

  const result = await runProcessText(VOICE_WHISPERX_PYTHON, args, {
    cwd: appPath(),
    timeoutMs: VOICE_TIMEOUT_MS,
  });
  const txtPath = path.join(outDir, `${path.basename(wavPath, path.extname(wavPath))}.txt`);
  const transcript = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, "utf-8").trim() : "";
  if (result.code !== 0 && !transcript) {
    const detail = (result.stderr || result.stdout || "").trim().split(/\r?\n/).slice(-3).join(" | ");
    return { error: `WhisperX exited ${result.code}${result.timedOut ? " (timeout)" : ""}${detail ? `: ${detail}` : ""}`, wavPath, durationMs };
  }
  return {
    transcript,
    wavPath,
    durationMs,
    language: VOICE_LANGUAGE || "auto",
    model: VOICE_MODEL,
    error: transcript ? "" : "WhisperX produced empty transcript",
  };
}

function runPythonExtractor(filePath, mode) {
  const code = String.raw`
import json, re, sys, zipfile, xml.etree.ElementTree as ET
path, mode = sys.argv[1], sys.argv[2]
def clean(s):
    return re.sub(r"\s+", " ", s or "").strip()
def xml_text(data):
    root = ET.fromstring(data)
    return clean(" ".join(root.itertext()))
try:
    if mode == "pdf":
        try:
            from pypdf import PdfReader
        except Exception:
            from PyPDF2 import PdfReader
        reader = PdfReader(path)
        print("\n".join((p.extract_text() or "") for p in reader.pages[:8]))
    elif mode == "docx":
        with zipfile.ZipFile(path) as z:
            print(xml_text(z.read("word/document.xml")))
    elif mode == "pptx":
        out = []
        with zipfile.ZipFile(path) as z:
            for name in sorted(n for n in z.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml"))[:20]:
                out.append(xml_text(z.read(name)))
        print("\n".join(out))
    elif mode == "xlsx":
        out = []
        with zipfile.ZipFile(path) as z:
            shared = []
            if "xl/sharedStrings.xml" in z.namelist():
                root = ET.fromstring(z.read("xl/sharedStrings.xml"))
                shared = [clean(" ".join(si.itertext())) for si in root]
            sheets = [n for n in z.namelist() if n.startswith("xl/worksheets/sheet") and n.endswith(".xml")]
            for name in sorted(sheets)[:8]:
                root = ET.fromstring(z.read(name))
                vals = []
                for c in root.iter():
                    if not c.tag.endswith("c"):
                        continue
                    t = c.attrib.get("t")
                    v = next((child.text for child in c if child.tag.endswith("v")), None)
                    if v is None:
                        continue
                    if t == "s" and v.isdigit() and int(v) < len(shared):
                        vals.append(shared[int(v)])
                    else:
                        vals.append(v)
                if vals:
                    out.append(" | ".join(vals[:200]))
        print("\n".join(out))
except Exception as e:
    print("", end="")
`;
  const r = spawnSync("python", ["-X", "utf8", "-c", code, filePath, mode], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: FILE_TEXT_PREVIEW_CHARS * 4,
  });
  return (r.stdout || "").trim();
}

function extractFileTextPreview(filePath, mime, originalFilename = "") {
  const ext = path.extname(originalFilename || filePath).toLowerCase();
  try {
    if (/^text\//.test(mime) || [".txt", ".md", ".csv", ".json", ".log", ".js", ".ts", ".py", ".html", ".css"].includes(ext)) {
      return fs.readFileSync(filePath, "utf-8").slice(0, FILE_TEXT_PREVIEW_CHARS);
    }
  } catch {}
  const mode =
    ext === ".pdf" ? "pdf" :
    ext === ".docx" ? "docx" :
    ext === ".pptx" ? "pptx" :
    ext === ".xlsx" ? "xlsx" : null;
  return mode ? runPythonExtractor(filePath, mode).slice(0, FILE_TEXT_PREVIEW_CHARS) : "";
}

function extractVideoFrame(videoPath) {
  try {
    const out = videoPath.replace(/\.[^.]+$/, "") + "-frame.jpg";
    const r = spawnSync("ffmpeg", ["-y", "-ss", "00:00:01", "-i", videoPath, "-frames:v", "1", "-q:v", "3", out], {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
    if (r.status === 0 && fs.existsSync(out)) return out;
  } catch {}
  return null;
}

async function fetchJsonWithTimeout(url, bodyObj, timeoutMs, headers = {}) {
  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), effectiveTimeout);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(bodyObj),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`request timeout after ${effectiveTimeout}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function completionsUrl(baseUrl = "") {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) return null;
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v\d+$/i.test(base) || /\/compatible-mode\/v\d+$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function extractVisionContent(messageContent) {
  if (typeof messageContent === "string") return messageContent;
  if (Array.isArray(messageContent)) {
    return messageContent
      .map(part => typeof part === "string" ? part : (part.text || part.content || ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function hasExternalVisionConfig() {
  return Boolean(VISION_BASE_URL && VISION_API_KEY && VISION_MODEL);
}

function shouldUseExternalVision() {
  if (VISION_MODE === "off" || VISION_MODE === "none" || VISION_MODE === "native") return false;
  if (VISION_MODE === "external" || VISION_MODE === "cloud") return true;
  return hasExternalVisionConfig();
}

async function captionImageCloud(filePath, hint = "") {
  if (!filePath || !fs.existsSync(filePath)) return null;
  if (!shouldUseExternalVision()) {
    return null;
  }
  if (!hasExternalVisionConfig()) {
    log("\u{1F441}", "external vision skipped: WECHAT_VISION_BASE_URL/API_KEY/MODEL not configured");
    return null;
  }
  const imageBuffer = fs.readFileSync(filePath);
  const mime = detectMimeFromBuffer(imageBuffer, getMimeFromFilename(filePath));
  const imageBase64 = imageBuffer.toString("base64");
  const vcfg = loadPrompts();
  const basePrompt = vcfg.visionCaptionPrompt || `请为另一个聊天模型客观解析这张图片，输出中文。\n优先识别：画面主体、可见文字/OCR、物品类型、作品名或品牌名、场景、数量/分量。\n请区分'看清楚的事实'和'不确定的推测'。不要把推测写成事实。\n如果能清楚读出漫画/书/商品的标题，请写出标题；如果读不清，明确说读不清。\n如果存在电脑屏幕、桌面、背景物体等，只描述确实入镜且清晰可见的内容。\n不要从少量视觉线索脑补作品类型、剧情、用餐人数、几碗饭或用户偏好。\n输出 3-6 句；需要时可加一行'低置信度/不确定点'。不要角色扮演。`;
  const prompt = [
    basePrompt,
    hint ? `用户补充文字（可能不完整或带偏）：${hint.slice(0, 300)}` : '',
  ].filter(Boolean).join('\n');

  try {
    const result = await fetchJsonWithTimeout(completionsUrl(VISION_BASE_URL), {
      model: VISION_MODEL,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:${mime};base64,${imageBase64}`, detail: VISION_DETAIL } },
        ],
      }],
      temperature: 0.1,
      max_tokens: 420,
      stream: false,
    }, VISION_TIMEOUT_MS, { Authorization: `Bearer ${VISION_API_KEY}` });
    const caption = extractVisionContent(result.choices?.[0]?.message?.content).trim();
    if (caption) {
      log("\u{1F441}", `external vision caption ok (${caption.length} chars, model=${VISION_MODEL})`);
      return caption;
    }
  } catch (e) {
    log("⚠️", `external vision caption skipped: ${e.message?.slice(0, 120) || e}`);
  }
  return null;
}

function refMessageText(ref) {
  if (!ref) return "";
  const parts = [];
  if (ref.title) parts.push(ref.title);
  if (ref.message_item?.text_item?.text) parts.push(ref.message_item.text_item.text);
  if (ref.message_item && [2, 3, 4, 5].includes(ref.message_item.type)) parts.push(`[引用了${mediaKindLabel(ref.message_item.type)}]`);
  return parts.length ? `[引用: ${parts.join(" | ")}]\n` : "";
}

function mediaKindLabel(type) {
  return type === 2 ? "图片" : type === 3 ? "语音" : type === 4 ? "文件" : type === 5 ? "视频" : "媒体";
}

async function downloadInboundMedia(item, label) {
  if (item.type === 2) {
    const img = item.image_item || {};
    const media = img.media || img.thumb_media;
    if (!media?.encrypt_query_param && !media?.full_url) return { kind: "image", error: "missing image media" };
    const aesKey = img.aeskey ? Buffer.from(img.aeskey, "hex").toString("base64") : media?.aes_key;
    const buf = await downloadCdnMedia(media, aesKey, label);
    const mime = detectMimeFromBuffer(buf, "image/jpeg");
    const filePath = saveInboundBuffer(buf, { kind: "image", mime, originalFilename: `image${extensionFromMime(mime, ".jpg")}` });
    const caption = await captionImageCloud(filePath);
    return { kind: "image", path: filePath, mime, dimensions: imageDimensions(buf), caption };
  }
  if (item.type === 3) {
    const voice = item.voice_item || {};
    if (!voice.media?.encrypt_query_param && !voice.media?.full_url) return { kind: "voice", transcript: voice.text || "", error: "missing voice media" };
    if (!voice.media?.aes_key) return { kind: "voice", transcript: voice.text || "", error: "missing voice aes_key" };
    const buf = await downloadCdnMedia(voice.media, voice.media.aes_key, label);
    const filePath = saveInboundBuffer(buf, { kind: "voice", mime: "audio/silk", originalFilename: "voice.silk" });
    const asr = await transcribeVoiceWithWhisperX(filePath);
    if (asr?.error) log("⚠️", `voice WhisperX failed: ${asr.error}`);
    return {
      kind: "voice",
      path: filePath,
      mime: "audio/silk",
      transcript: voice.text || "",
      whisperxTranscript: asr?.transcript || "",
      whisperxError: asr?.error || "",
      whisperxWavPath: asr?.wavPath || "",
      whisperxLanguage: asr?.language || "",
      whisperxDurationMs: asr?.durationMs || null,
      playtime: voice.playtime,
    };
  }
  if (item.type === 4) {
    const f = item.file_item || {};
    if (!f.media?.encrypt_query_param && !f.media?.full_url) return { kind: "file", name: f.file_name || "file", error: "missing file media" };
    if (!f.media?.aes_key) return { kind: "file", name: f.file_name || "file", error: "missing file aes_key" };
    const name = sanitizeFilename(f.file_name || "file.bin");
    const buf = await downloadCdnMedia(f.media, f.media?.aes_key, label);
    const mime = detectMimeFromBuffer(buf, getMimeFromFilename(name));
    const filePath = saveInboundBuffer(buf, { kind: "file", mime, originalFilename: name });
    return { kind: "file", path: filePath, mime, name, size: buf.length, textPreview: extractFileTextPreview(filePath, mime, name) };
  }
  if (item.type === 5) {
    const video = item.video_item || {};
    if (!video.media?.encrypt_query_param && !video.media?.full_url) {
      if (video.thumb_media?.encrypt_query_param || video.thumb_media?.full_url) {
        const thumb = await downloadCdnMedia(video.thumb_media, video.thumb_media?.aes_key, `${label} video-thumb`);
        const mime = detectMimeFromBuffer(thumb, "image/jpeg");
        const thumbPath = saveInboundBuffer(thumb, { kind: "video-thumb", mime, originalFilename: `video-thumb${extensionFromMime(mime, ".jpg")}` });
        const caption = await captionImageCloud(thumbPath, "这是视频缩略图或首帧。");
        return { kind: "video", error: "missing video media; saved thumbnail only", framePath: thumbPath, frameCaption: caption };
      }
      return { kind: "video", error: "missing video media" };
    }
    if (!video.media?.aes_key) return { kind: "video", error: "missing video aes_key" };
    const buf = await downloadCdnMedia(video.media, video.media.aes_key, label);
    const mime = detectMimeFromBuffer(buf, "video/mp4");
    const filePath = saveInboundBuffer(buf, { kind: "video", mime, originalFilename: `video${extensionFromMime(mime, ".mp4")}` });
    const framePath = extractVideoFrame(filePath);
    const frameCaption = framePath ? await captionImageCloud(framePath, "这是视频首帧截图。") : null;
    return { kind: "video", path: filePath, mime, size: buf.length, framePath, frameCaption, playLength: video.play_length };
  }
  return { kind: "unknown", error: `unsupported media type ${item.type}` };
}

function mediaInfoToPrompt(info) {
  if (info.error && !info.path && !info.framePath) return `[${info.kind || "媒体"}：${info.error}]`;
  if (info.kind === "image") {
    const dims = info.dimensions ? `\n尺寸: ${info.dimensions.width}x${info.dimensions.height}` : "";
    const caption = info.caption
      ? `\n外部视觉模型描述:\n${info.caption}`
      : "\n外部视觉模型描述: 未生成。请说明无法确认图片细节，不要自行读取本地图片文件。";
    return `[图片]\n本地路径: ${info.path}\nMIME: ${info.mime}${dims}${caption}\n回复时不要仅凭用户补充文字脑补图片细节。若已有外部视觉描述，请优先依据它，但仍要保守处理不确定内容；不要自行读取本地图片文件。`;
  }
  if (info.kind === "voice") {
    const wechatTranscript = info.transcript ? `\n微信自带语音转文字: ${info.transcript}` : "";
    const whisperxTranscript = info.whisperxTranscript ? `\nWhisperX 语音转文字: ${info.whisperxTranscript}` : "";
    const whisperxError = !info.whisperxTranscript && info.whisperxError ? `\nWhisperX 语音转文字: 未生成（${info.whisperxError}）` : "";
    const duration = info.whisperxDurationMs ? `\n估计时长: ${Math.round(info.whisperxDurationMs / 100) / 10}s` : "";
    const guidance = info.whisperxTranscript
      ? "\n若微信自带转写与 WhisperX 冲突，优先参考 WhisperX；短语音仍可能有误，回复时不要编造语音里没有的内容。"
      : "\n微信自带转写可能不准确，尤其是日语；若内容明显不通顺，回复时应保守确认。";
    return `[语音]\n本地路径: ${info.path || "未保存"}\nMIME: ${info.mime || "unknown"}${duration}${wechatTranscript}${whisperxTranscript}${whisperxError}${guidance}`;
  }
  if (info.kind === "file") {
    const preview = info.textPreview ? `\n可提取文本预览:\n${info.textPreview}` : "\n未能直接提取文本；需要时可读取本地文件。";
    return `[文件]\n文件名: ${info.name || path.basename(info.path || "file")}\n本地路径: ${info.path}\nMIME: ${info.mime}\n大小: ${info.size ?? "unknown"} bytes${preview}`;
  }
  if (info.kind === "video") {
    const frame = info.framePath ? `\n首帧截图: ${info.framePath}` : "";
    const frameCaption = info.frameCaption
      ? `\n首帧外部视觉模型描述:\n${info.frameCaption}`
      : (info.framePath ? "\n首帧外部视觉模型描述: 未生成。请说明无法确认视频画面细节，不要自行读取首帧截图。" : "");
    const videoPath = info.path ? `\n本地路径: ${info.path}` : "";
    const err = info.error ? `\n备注: ${info.error}` : "";
    return `[视频]${videoPath}\nMIME: ${info.mime || "unknown"}\n大小: ${info.size ?? "unknown"} bytes${frame}${frameCaption}${err}\n请优先依据可见首帧信息回复；不要脑补视频中不可见的内容。`;
  }
  return `[媒体]\n${JSON.stringify(info)}`;
}

async function inboundItemToText(item, index, msg) {
  const ref = refMessageText(item.ref_msg);
  if (item.type === 1) return `${ref}${item.text_item?.text || ""}`;
  if (item.type === 3 && item.voice_item?.text && !item.voice_item?.media) return `${ref}[语音转文字]\n${item.voice_item.text}`;
  if ([2, 3, 4, 5].includes(item.type)) {
    try {
      const media = await downloadInboundMedia(item, `msg${msg.message_id || "unknown"} item${index}`);
      return `${ref}${mediaInfoToPrompt(media)}`;
    } catch (e) {
      log("⚠️", `media item ${item.type} failed: ${e.message}`);
      return `${ref}[${mediaKindLabel(item.type)}：下载或解析失败：${e.message}]`;
    }
  }
  if (item.type === 11) return `${ref}[工具调用开始: ${item.tool_call_start_item?.tool_name || "unknown"}]`;
  if (item.type === 12) return `${ref}[工具调用结果: ${item.tool_call_result_item?.tool_name || "unknown"} ${item.tool_call_result_item?.status || ""}]`;
  return `${ref}[未知消息类型 ${item.type ?? "unknown"}]`;
}

async function extractInboundPayload(msg) {
  logInboundMedia(msg);
  const parts = [];
  let shouldBatch = false;
  let hasText = false;
  let canAppendToBatch = true;
  for (let i = 0; i < (msg.item_list || []).length; i++) {
    const item = msg.item_list[i];
    if ([2, 3, 4, 5].includes(item?.type)) shouldBatch = true;
    if (item?.type === 1) hasText = true;
    else canAppendToBatch = false;
    const part = await inboundItemToText(item, i, msg);
    if (part?.trim()) parts.push(part.trim());
  }
  return { body: parts.join("\n"), shouldBatch, canAppendToBatch: !shouldBatch && hasText && canAppendToBatch };
}

function isDuplicateInput(userId, body) {
  const key = `${userId}\n${body}`;
  const now = Date.now();
  const last = recentInputs.get(key) || 0;
  recentInputs.set(key, now);
  for (const [k, t] of recentInputs) {
    if (now - t > DUPLICATE_INPUT_MS * 2) recentInputs.delete(k);
  }
  return now - last < DUPLICATE_INPUT_MS;
}

// ─── SESSION MANAGEMENT ─────────────────────────────────────
function sessionMap(ai) { return sessions[ai || activeAI]; }

function ensureUser(userId, ai = activeAI) {
  const sMap = sessionMap(ai);
  if (!sMap.has(userId)) {
    const sess = makeSession("S1", null, "tool", ai);
    sMap.set(userId, { activeId: sess.id, list: [sess] });
  }
  return sMap.get(userId);
}

function activeSession(userId, ai = activeAI) {
  const u = ensureUser(userId, ai);
  return u.list.find(s => s.id === u.activeId) ?? u.list[0];
}

function sessionById(ai, userId, sessionId) {
  const u = sessionMap(ai)?.get(userId);
  if (!u) return null;
  return u.list.find(s => s.id === sessionId) || null;
}

function hasSessionName(userId, name, excludeId = null, ai = activeAI) {
  const u = ensureUser(userId, ai);
  return u.list.some(s => s.id !== excludeId && s.name === name);
}

function nextSessionName(userId, ai = activeAI) {
  const u = ensureUser(userId, ai);
  let n = u.list.length + 1;
  while (hasSessionName(userId, `S${n}`, null, ai)) n++;
  return `S${n}`;
}

function findSession(userId, key) {
  const u = ensureUser(userId);
  const n = parseInt(key);
  if (n >= 1 && n <= u.list.length) return u.list[n - 1];
  return u.list.find(s => s.name === key) || u.list.find(s => s.name.includes(key)) || null;
}

function sessionsListText(userId) {
  const u = ensureUser(userId);
  return u.list.map((s, i) => {
    const arrow = s.id === u.activeId ? "→" : "  ";
    const busy = s.busy ? " ⏳" : "";
    const q = s.queue.length ? ` 排队${s.queue.length}` : " 空闲";
    const profile = sessionProfile(s) || "默认";
    return `${arrow}[${i + 1}] ${s.name}${busy}${q}  角色:${profile}`;
  }).join("\n");
}

function replyPrefix(sessionName, ai = activeAI) {
  const aiName = ai === "cc" ? "CC" : "Codex";
  return `${aiName}-${sessionName}`;
}

function needsWindowsShell(command) {
  return process.platform === "win32" && (!path.extname(command) || /\.(cmd|bat|ps1)$/i.test(command));
}

function spawnCli(command, args, options = {}) {
  return spawn(command, args, {
    ...options,
    shell: options.shell ?? needsWindowsShell(command),
  });
}

function envWithProxy(proxyUrl, extra = {}) {
  const env = { ...process.env, ...extra };
  if (proxyUrl && String(proxyUrl).trim()) {
    const value = String(proxyUrl).trim();
    env.HTTP_PROXY = value;
    env.HTTPS_PROXY = value;
    env.http_proxy = value;
    env.https_proxy = value;
  } else {
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
    delete env.http_proxy;
    delete env.https_proxy;
  }
  return env;
}

function commandExists(command) {
  return fs.existsSync(command) || Boolean(commandOnPath(command));
}

const TRANSIENT_GETUPDATES_CODES = new Set([
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETRESET",
  "EPIPE",
]);

function isTransientGetUpdatesError(e) {
  const code = e?.cause?.code || e?.code || "";
  return (e?.message === "fetch failed" || e?.name === "TypeError") && TRANSIENT_GETUPDATES_CODES.has(code);
}

// ─── RUN CLAUDE (stream-json) ────────────────────────────────
function runClaudeStream(ai, sid, sessionName, body, firstTurn, onEvent, stylePrompt, memoryPrompt = "", profileOverride = null, options = {}) {
  const profile = profileOverride;
  const fastCasual = shouldSkipRag(options.routingBody || body);
  const systemPromptParts = [];
  if (profile && profileTemplates[profile]) systemPromptParts.push(profileTemplates[profile]);
  const pinnedProfileRules = loadPinnedProfileRules(profile);
  if (pinnedProfileRules) systemPromptParts.push(pinnedProfileRules);
  if (memoryPrompt && options.includeMemoryInSystem === true) systemPromptParts.push(memoryPrompt);
  if (stylePrompt && options.includeStyleInSystem !== false) systemPromptParts.push(stylePrompt);
  const systemPromptFile = systemPromptParts.length
    ? path.join(RUNTIME_DIR, `.claude_system_${crypto.randomUUID()}.txt`)
    : null;

  const args = [
    "-p",
    "--name", sessionName,
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "bypassPermissions",
  ];
  if (profile && profileTemplates[profile]) {
    args.push("--tools", "WebSearch,WebFetch");
  }
  if (options.noSessionPersistence) {
    args.push("--no-session-persistence");
  } else if (firstTurn) {
    args.push("--session-id", sid);
  } else {
    args.push("--resume", sid);
  }
  args.push("--model", CLAUDE_MAIN_MODEL);
  if (CLAUDE_FALLBACK_MODEL && CLAUDE_FALLBACK_MODEL !== CLAUDE_MAIN_MODEL) {
    args.push("--fallback-model", CLAUDE_FALLBACK_MODEL);
  }
  if (fastCasual) args.push("--effort", "low");
  if (systemPromptFile) {
    ensureDir(RUNTIME_DIR);
    fs.writeFileSync(systemPromptFile, systemPromptParts.join("\n\n---\n\n"), "utf-8");
    args.push("--append-system-prompt-file", systemPromptFile);
  }
  const proc = spawnCli(CLAUDE, args, {
    cwd: AI_WORK_DIR,
    timeout: CLAUDE_TIMEOUT_MS,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: envWithProxy(CLAUDE_HTTPS_PROXY),
  });

  proc.stdin.on("error", () => {});
  proc.stdin.end(body, "utf8");

  log("\u{1F7E2}", `[${sessionName}] CC pid=${proc.pid}`);
  if (fastCasual) log("\u{26A1}", `[${sessionName}] CC low effort visible reply`);

  let buf = "";
  let stderrOut = "";
  let resolved = false;

  proc.stdout.on("data", d => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { onEvent(JSON.parse(trimmed)); } catch { /* skip */ }
    }
  });
  proc.stderr.on("data", d => { stderrOut += d; if (stderrOut.length > 5000) stderrOut = stderrOut.slice(-5000); });

  const promise = new Promise((resolve) => {
    proc.on("close", (code) => {
      log("\u{1F534}", `[${sessionName}] CC pid=${proc.pid} exited ${code}`);
      if (systemPromptFile) { try { fs.rmSync(systemPromptFile, { force: true }); } catch {} }
      if (resolved) return;
      resolved = true;
      if (buf.trim()) { try { onEvent(JSON.parse(buf.trim())); } catch { /* skip */ } }
      resolve({ code, stderr: stderrOut, killed: proc.killed });
    });
    proc.on("error", (e) => {
      if (systemPromptFile) { try { fs.rmSync(systemPromptFile, { force: true }); } catch {} }
      if (resolved) return;
      resolved = true;
      resolve({ code: -1, stderr: e.message, killed: false });
    });
  });

  promise.proc = proc;
  return promise;
}

// ─── RUN CODEX (JSONL) ───────────────────────────────────────
function buildCodexPrompt(ai, userBody, ragContext, stylePrompt, memoryPrompt = "", profileOverride = null) {
  const profile = profileOverride;
  const systemParts = [];
  if (profile && profileTemplates[profile]) {
    systemParts.push(profileTemplates[profile]);
  }
  const pinnedProfileRules = loadPinnedProfileRules(profile);
  if (pinnedProfileRules) systemParts.push(pinnedProfileRules);
  if (stylePrompt) systemParts.push(stylePrompt);
  let prompt = systemParts.length ? `${systemParts.join("\n\n---\n\n")}\n\n---\n\n${userBody}` : userBody;
  if (ragContext) {
    prompt = [
      buildRagContextBlock(ragContext),
      "",
      "---",
      "",
      prompt,
    ].join("\n");
  }
  return prompt;
}

function runCodexStream(ai, sid, sessionName, body, firstTurn, onEvent, ragContext, stylePrompt, memoryPrompt = "", profileOverride = null, options = {}) {
  const prompt = buildCodexPrompt(ai, body, ragContext, stylePrompt, memoryPrompt, profileOverride);
  let args;
  if (options.noSessionPersistence || firstTurn) {
    args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--cd", AI_WORK_DIR,
      "--sandbox", "workspace-write",
      "-",
    ];
  } else {
    args = [
      "exec", "resume", sid,
      "--json",
      "--skip-git-repo-check",
      "-",
    ];
  }

  const codexCommand = /\.js$/i.test(CODEX) ? NODE : CODEX;
  const codexArgs = /\.js$/i.test(CODEX) ? [CODEX, ...args] : args;
  const proc = spawnCli(codexCommand, codexArgs, {
    cwd: AI_WORK_DIR,
    timeout: CLAUDE_TIMEOUT_MS,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: envWithProxy(CODEX_HTTPS_PROXY),
  });

  proc.stdin.on("error", () => {});
  proc.stdin.write(prompt);
  proc.stdin.end();

  log("\u{1F7E2}", `[${sessionName}] Codex pid=${proc.pid}`);

  let buf = "";
  let stderrOut = "";
  let resolved = false;

  proc.stdout.on("data", d => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { onEvent(JSON.parse(trimmed)); } catch { /* skip non-JSON lines */ }
    }
  });
  proc.stderr.on("data", d => { stderrOut += d; if (stderrOut.length > 5000) stderrOut = stderrOut.slice(-5000); });

  const promise = new Promise((resolve) => {
    proc.on("close", (code) => {
      log("\u{1F534}", `[${sessionName}] Codex pid=${proc.pid} exited ${code}`);
      if (resolved) return;
      resolved = true;
      if (buf.trim()) { try { onEvent(JSON.parse(buf.trim())); } catch { /* skip */ } }
      resolve({ code, stderr: stderrOut, killed: proc.killed });
    });
    proc.on("error", (e) => {
      if (resolved) return;
      resolved = true;
      resolve({ code: -1, stderr: e.message, killed: false });
    });
  });

  promise.proc = proc;
  return promise;
}

function buildStableStylePrompt() {
  return expressionCapabilityPrompt();
}

function buildRagContextBlock(ragContext) {
  if (!ragContext) return "";
  const cfg = loadPrompts();
  return [
    "【本轮知识库检索结果】",
    cfg.ragContextInstruction,
    ragContext,
  ].filter(Boolean).join("\n");
}

function buildTurnBody(userBody, ragContext = "", sceneContext = "", memoryPrompt = "") {
  const sections = [];
  const now = new Date();
  if (memoryPrompt) {
    sections.push(memoryPrompt);
  }
  if (sceneContext) {
    sections.push(sceneContext);
  }
  if (ragContext) {
    sections.push(buildRagContextBlock(ragContext));
  }
  sections.push(CURRENT_SITE_AND_SEARCH_GUARD);
  sections.push(getChatStyle());
  sections.push(formatLocalChatReality(now));
  const beijing = formatZonedTimeParts(now, "Asia/Shanghai");
  const tokyo = formatZonedTimeParts(now, "Asia/Tokyo");
  const timeTag = `${beijing.stamp} ${beijing.shortWeekday}${beijing.period}（北京时间；角色侧东京时间 ${tokyo.stamp} ${tokyo.shortWeekday}${tokyo.period}）`;
  sections.push([`【用户消息】- ${timeTag}`, userBody].join("\n"));
  return sections.join("\n\n---\n\n");
}

function currentTimeContext(date = new Date()) {
  const beijing = formatZonedTimeParts(date, "Asia/Shanghai");
  const tokyo = formatZonedTimeParts(date, "Asia/Tokyo");
  return {
    iso: date.toISOString(),
    beijing: {
      local: beijing.stamp,
      weekday: beijing.shortWeekday,
      period: beijing.period,
      timezone: "Asia/Shanghai",
      note: "用户侧时间，北京时间",
    },
    tokyo: {
      local: tokyo.stamp,
      weekday: tokyo.shortWeekday,
      period: tokyo.period,
      timezone: "Asia/Tokyo",
      note: "角色侧时间；千圣所处时间以东京时间为准",
    },
  };
}

function nthMonday(year, month, n) {
  const first = new Date(year, month - 1, 1);
  const dayOfWeek = first.getDay();
  const firstMonday = 1 + ((8 - dayOfWeek) % 7);
  return new Date(year, month - 1, firstMonday + (n - 1) * 7);
}

function vernalEquinoxDay(year) {
  if (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) return 20;
  return (year >= 2025 && year <= 2028) ? 20 : 20;
}

function autumnalEquinoxDay(year) {
  return (year >= 2024 && year <= 2028) ? 22 : 23;
}

function japaneseHolidaysInRange(year, month, day, rangeDays = 14) {
  const ref = new Date(year, month - 1, day);
  const refTs = ref.getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  const fixed = [
    [1, 1, "元日"], [2, 11, "建国記念の日"], [2, 23, "天皇誕生日"],
    [4, 29, "昭和の日"], [5, 3, "憲法記念日"], [5, 4, "みどりの日"],
    [5, 5, "こどもの日"], [8, 11, "山の日"],
    [11, 3, "文化の日"], [11, 23, "勤労感謝の日"],
  ];

  const floating = [
    [1, 2, 1, "成人の日"],
    [7, 3, 1, "海の日"],
    [9, 3, 1, "敬老の日"],
    [10, 2, 1, "スポーツの日"],
  ];

  const results = [];

  for (const [m, d, name] of fixed) {
    const dt = new Date(year, m - 1, d);
    if (Math.abs(dt.getTime() - refTs) <= rangeDays * dayMs) {
      results.push({ date: `${m}月${d}日`, name, ts: dt.getTime() });
    }
  }

  for (const [m, weekOfMonth, dayOfWeek, name] of floating) {
    const dt = nthMonday(year, m, weekOfMonth);
    if (Math.abs(dt.getTime() - refTs) <= rangeDays * dayMs) {
      results.push({ date: `${m}月${dt.getDate()}日`, name, ts: dt.getTime() });
    }
  }

  const veDay = vernalEquinoxDay(year);
  const veDate = new Date(year, 2, veDay);
  if (Math.abs(veDate.getTime() - refTs) <= rangeDays * dayMs) {
    results.push({ date: `3月${veDay}日`, name: "春分の日", ts: veDate.getTime() });
  }

  const aeDay = autumnalEquinoxDay(year);
  const aeDate = new Date(year, 8, aeDay);
  if (Math.abs(aeDate.getTime() - refTs) <= rangeDays * dayMs) {
    results.push({ date: `9月${aeDay}日`, name: "秋分の日", ts: aeDate.getTime() });
  }

  results.sort((a, b) => a.ts - b.ts);
  return results;
}

const SEASONAL_MONTHLY_NOTES = {
  1: ["新年氛围，初詣、年贺状、お年玉", "成人の日（1月第2月曜），各地成人式", "寒冷严冬，北部有雪，东京偶有积雪"],
  2: ["节分（2/3前后），豆まき、恵方巻", "バレンタインデー（2/14），日本女生送义理/本命チョコ", "受験シーズン，大学入学共通テスト后期", "札幌雪まつり（2月上旬）"],
  3: ["雛祭り（3/3），桃の節句，女孩节日", "ホワイトデー（3/14），情人节回礼", "春分の日/お彼岸，扫墓祭祖", "毕业式季节（3月中下旬），樱花初绽预告", "春假开始（3月下旬～4月初）"],
  4: ["樱花季（3月下旬～4月中旬），花见名所热闹", "入学式/入社式（4月初），新学期开始，社会人入职", "灌仏会/花まつり（4/8）", "新年度，生活节奏变化期"],
  5: ["黄金周（4/29～5/5前后），大型连休，旅游出行高峰", "こどもの日/端午の節句（5/5），挂鲤鱼旗", "新绿季节，气候宜人，户外活动增多", "神田祭（5月中旬，隔年大祭），三社祭（5月第3周末）"],
  6: ["梅雨入り（6月上旬～中旬），闷热多雨，出行不便", "夏越の大祓（6/30），茅の輪くぐり，半年晦日", "紫阳花（あじさい）盛开，镰仓/箱根赏花人流多"],
  7: ["梅雨明け（7月中旬前后），正式入夏", "七夕（7/7），各地七夕祭り，短冊に願い事", "京都祇園祭（7月整月，山鉾巡行17日），日本三大祭", "天神祭（7/24-25），大阪天満宮，船渡御と奉納花火", "暑假开始（7月下旬～8月末），学生出游增多", "花火大会季开始，各地周末均有"],
  8: ["盛夏酷暑，台风季高峰期", "お盆（8/13-15），帰省ラッシュ，先祖供養，盆踊り", "青森ねぶた祭（8/2-7），秋田竿燈（8/3-6），仙台七夕（8/6-8）", "阿波踊り（8/12-15），よさこい祭り（8/9-12）", "花火大会各地持续，夏休みUターンラッシュ"],
  9: ["残暑持续，台风季尾声", "シルバーウィーク（敬老の日+秋分の日连休，约5连休）", "中秋の名月/十五夜（9月中旬～10月上旬），月見団子", "运动会季节（9～10月），体育の日改称スポーツの日"],
  10: ["秋季红叶季开始，行楽の秋", "スポーツの日（10月第2月曜），三连休", "ハロウィン（10/31），渋谷等地仮装イベント", "大学学園祭季节（10～11月），各大学文化祭/学園祭集中"],
  11: ["红叶季高峰，紅葉狩り", "文化の日（11/3）", "七五三（11/15），3岁5岁7岁儿童参拜神社", "勤労感謝の日（11/23），三连休", "酉の市（11月酉の日），熊手等缘起物"],
  12: ["忘年会季节（12月），飲み会增多", "クリスマス（12/24-25），日本定番KFC+ケーキ", "年末大掃除/煤払い", "大晦日（12/31），年越しそば，除夜の鐘（108回）", "冬季休業/寒假（12月下旬～1月中旬），帰省/旅行"],
};

function buildScheduleStaticContext(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const cfg = loadPrompts();

  // Semester
  const md = month * 100 + day;
  let semester;
  if (md >= 401 && md < 721) semester = "前期（4月～7月下旬），通常授课中";
  else if (md >= 721 && md < 921) semester = "夏季休業中（暑假，7月下旬～9月下旬）";
  else if (md >= 921 && md < 1221) semester = "後期（9月下旬～12月下旬），通常授课中";
  else if (md >= 1221 || md < 115) semester = "冬季休業中（寒假，12月下旬～1月中旬）";
  else if (md >= 115 && md < 215) semester = "後期試験期間（1月中旬～2月中旬）";
  else semester = "春休み（2月中旬～3月下旬），学年末假期，即将进入新学年";

  // Exam periods
  let examNote = "";
  if (md >= 115 && md < 215) examNote = "大学後期試験期间，学生多在备考或考试中。";
  else if (md >= 701 && md < 721) examNote = "大学前期試験临近，学生开始准备期末考。";
  else if (md >= 1201 && md < 1221) examNote = "大学後期試験临近（1月），レポート課題增多。";

  // Season
  let season;
  if (month === 3 || month === 4) season = "春季，樱花季，天气转暖，新年度开始";
  else if (month === 5) season = "晚春/新绿，气候宜人，户外活动增多";
  else if (month === 6 || (month === 7 && day <= 15)) season = "梅雨季（梅雨），闷热多雨，出行不便，紫阳花盛开";
  else if (month === 7 || month === 8) season = "盛夏，酷暑，台风季，花火大会/祭典/お盆季";
  else if (month === 9) season = "初秋/残暑，台风季尾声，运动会/月见季节";
  else if (month === 10 || month === 11) season = "秋季，红叶季高峰，气候凉爽宜人，行楽の秋/学園祭季节";
  else season = "冬季，寒冷，忘年会/クリスマス/年末年始季";

  // Golden Week / Silver Week
  let longHolidayNote = "";
  if (md >= 427 && md <= 506) longHolidayNote = "黄金周期间（4/29～5/5前后），大型连休，旅游出行高峰。";
  const silverStart = new Date(year, 8, 18);
  const silverEnd = new Date(year, 8, 24);
  if (date >= silverStart && date <= silverEnd) longHolidayNote = "シルバーウィーク（敬老の日+秋分の日），约5连休，旅游出行高峰。";

  // Holidays in range
  const holidays = japaneseHolidaysInRange(year, month, day, 14);
  const holidayText = holidays.length
    ? "近期节日：\n" + holidays.map(h => `  - ${h.date} ${h.name}`).join("\n")
    : "近期无日本国民祝日。";

  // Monthly notes
  const monthly = SEASONAL_MONTHLY_NOTES[month] || [];
  const prevMonth = month === 1 ? 12 : month - 1;
  const nextMonth = month === 12 ? 1 : month + 1;
  const seasonalNotes = [
    ...(SEASONAL_MONTHLY_NOTES[prevMonth]?.slice(-1) || []).map(s => `[${prevMonth}月尾] ${s}`),
    ...monthly.map(s => `[${month}月] ${s}`),
    ...(SEASONAL_MONTHLY_NOTES[nextMonth]?.slice(0, 1) || []).map(s => `[${nextMonth}月初] ${s}`),
  ];

  // Special dates from prompts
  const specialDatesText = (cfg.scheduleSpecialDates || "").trim();

  return [
    "【当前时间与季节上下文】",
    `当前日期：${year}年${month}月${day}日`,
    `学期状态：${semester}`,
    examNote ? `考试相关：${examNote}` : "",
    `季节特征：${season}`,
    longHolidayNote ? `连休提醒：${longHolidayNote}` : "",
    holidayText,
    "",
    "【近期行事与季节事件】",
    ...seasonalNotes,
    "",
    specialDatesText ? `【角色相关特殊日期】\n${specialDatesText}` : "",
  ].filter(Boolean).join("\n");
}

function sceneStateText(sess) {
  const state = normalizeSceneState(sess?._sceneState);
  if (!state) return "";
  if (state.expiresAt && Date.parse(state.expiresAt) && Date.now() > Date.parse(state.expiresAt)) return "";
  return state.text || "";
}

function recentVisibleContext(sess, limit = getSceneConfig().visibleContextTurns) {
  return normalizeVisibleHistory(sess?._visibleHistory)
    .slice(-limit * 2)
    .map(item => ({
      role: item.role,
      time: item.timestamp || "",
      kind: item.kind || "chat",
      text: item.text,
    }));
}

function appendVisibleHistory(sess, role, text, kind = "chat", timestamp = new Date().toISOString()) {
  if (!sess || !text?.trim()) return;
  sess._visibleHistory = normalizeVisibleHistory([
    ...(sess._visibleHistory || []),
    { role, text: String(text), timestamp, kind },
  ]);
}

function stripJsonFences(text = "") {
  return String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function parseHiddenJson(raw) {
  const trimmed = stripJsonFences(raw);
  try { return JSON.parse(trimmed); } catch {}
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error("hidden call returned no JSON object");
}

async function runHiddenJson(prompt, { label = "hidden", timeoutMs = 300_000, bare = true, model = null, sessionName = "", sessionId = "", firstTurn = false, persist = false, systemPrompt = "" } = {}) {
  if (!commandExists(CLAUDE)) return null;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const selectedModel = model || SCENELET_MODEL;
  const systemPromptFile = systemPrompt
    ? path.join(RUNTIME_DIR, `.hidden_system_${label}_${crypto.randomUUID()}.txt`)
    : null;
  const args = [
    "-p",
    "--output-format", "json",
    "--permission-mode", "bypassPermissions",
    "--tools", "WebSearch,WebFetch",
    "--model", selectedModel,
  ];
  if (sessionName) args.push("--name", sessionName);
  if (persist) {
    if (firstTurn && sessionId) args.push("--session-id", sessionId);
    else if (sessionId) args.push("--resume", sessionId);
  } else {
    args.push("--no-session-persistence");
  }
  if (bare) args.splice(1, 0, "--bare");
  if (systemPromptFile) {
    ensureDir(RUNTIME_DIR);
    fs.writeFileSync(systemPromptFile, systemPrompt, "utf-8");
    args.push("--append-system-prompt-file", systemPromptFile);
  }
  const proc = spawnCli(CLAUDE, args, {
    cwd: AI_WORK_DIR,
    timeout: timeoutMs,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: envWithProxy(CLAUDE_HTTPS_PROXY),
  });
  proc.stdin.on("error", () => {});
  proc.stdin.end(prompt, "utf8");
  let stdout = "";
  let stderr = "";
  const code = await new Promise(resolve => {
    proc.stdout.on("data", d => { stdout += d; });
    proc.stderr.on("data", d => { stderr += d; if (stderr.length > 3000) stderr = stderr.slice(-3000); });
    proc.on("close", resolve);
    proc.on("error", () => resolve(-1));
  }).finally(() => {
    if (systemPromptFile) { try { fs.rmSync(systemPromptFile, { force: true }); } catch {} }
  });
  const baseUsageEvent = {
    type: "hidden_call_usage",
    label,
    model: selectedModel,
    session_id: sessionId || null,
    started_at: startedAt,
    duration_ms: Date.now() - startedMs,
    context_chars: String(prompt || "").length,
    system_chars: String(systemPrompt || "").length,
  };
  if (code !== 0 && !stdout.trim()) {
    log("warn", label + " failed: exit " + code + (stderr ? "; " + stderr.slice(-200) : ""));
    writeHiddenUsageEvent({
      ...baseUsageEvent,
      duration_ms: Date.now() - startedMs,
      success: false,
      error: "exit " + code + (stderr ? "; " + stderr.slice(-300) : ""),
    });
    return null;
  }
  try {
    const outer = parseHiddenJson(stdout);
    const content = outer.result || outer.message || outer.text || stdout;
    const parsed = typeof content === "string" ? parseHiddenJson(content) : outer;
    if (parsed && typeof parsed === "object") {
      parsed._toolUsage = toolUsageFromUsage(outer);
      parsed._hiddenUsage = usageSummary(outer, outer.modelUsage);
      parsed._hiddenCall = {
        ...baseUsageEvent,
        session_id: outer.session_id || sessionId || null,
        duration_ms: Date.now() - startedMs,
        success: true,
        output_chars: String(content || "").length,
        ...parsed._hiddenUsage,
      };
      writeHiddenUsageEvent(parsed._hiddenCall);
    }
    return parsed;
  } catch (e) {
    log("warn", label + " parse failed: " + e.message);
    writeHiddenUsageEvent({
      ...baseUsageEvent,
      duration_ms: Date.now() - startedMs,
      success: false,
      error: e.message,
      output_chars: stdout.length,
    });
    return null;
  }
}

function buildSceneletPrompt({ userId, sessionName, profile, userBody, carriedSceneState, lifeArcs = [], visibleContext, memoryPrompt }) {
  const now = new Date();
  const cfg = loadPrompts();
  const instructions = cfg.sceneletInstructions || [
    "你在为微信角色私聊生成隐藏中间层，不会发送任何消息，不能调用工具，不能联网，不能写文件。",
    "",
    "任务：先生成本轮 inner_scenelet，再给出极短 next_scene_state，并判断是否存在一次性主动回复候选。",
  ].join("\n");
  return [
    instructions,
    "",
    cfg.lifeArcInstructions || "",
    "",
    CURRENT_SITE_AND_SEARCH_GUARD,
    "",
    "角色 prompt：",
    profile && profileTemplates[profile] ? profileTemplates[profile] : "",
    loadPinnedProfileRules(profile),
    "",
    memoryPrompt ? `长期记忆：\n${memoryPrompt}` : "",
    "",
    "当前时间：",
    JSON.stringify(currentTimeContext(now), null, 2),
    "",
    "输入：",
    JSON.stringify({
      userId,
      sessionName,
      profile,
      visible_context_instruction: cfg.chatHistoryIntro,
      carried_scene_state: carriedSceneState || null,
      active_life_arcs: lifeArcs,
      recent_visible_context: visibleContext,
      user_message: userBody,
    }, null, 2),
    "",
    "输出 JSON，且只输出 JSON：",
    JSON.stringify({
      inner_scenelet: "string",
      next_scene_state: "string|null",
      life_arc_ops: [{
        op: "create|update|close",
        id: "existing id when updating/closing, omit for create",
        title: "short private life line title",
        summary: "what is continuing for 1-3 days",
        current_state: "where it stands now",
        next_useful_moment: "when it may naturally matter again",
        expires_at: "ISO string within a few days",
        reason: "why this op is useful"
      }],
      proactive_candidates: [{
        kind: "follow_up|daily_share",
        scheduled_at: "ISO string",
        expires_at: "ISO string",
        message_intent: "string",
        basis: "string",
        cancel_if: ["string"],
        inner_scenelet: "string"
      }]
    }, null, 2),
  ].filter(Boolean).join("\n");
}

function buildHiddenWorldSystemPrompt(profile) {
  const cfg = loadPrompts();
  const sceneletBase = cfg.sceneletInstructions || "";
  return [
    "你在维护一个微信角色私聊的隐藏世界 session。用户看不到你的输出；你的输出只用于帮助主回复和本地状态更新。",
    "",
    "核心任务：",
    "1. 必须生成本轮 inner_scenelet。它的职责和旧 scenelet 完全一致：帮助主回复理解角色此刻状态、身体感、情绪落点和接话方式。",
    "2. 生成 next_scene_state，保持短、轻、可过期。",
    "3. 更新 world_state_patch。只写结构化的当前生活状态，不要写长期设定。",
    "4. 生成 life_arc_ops，用于 1-3 天内的短期生活线。",
    "5. 生成 proactive_candidates，用于一次性 follow_up 或 daily_share 候选。",
    "6. 生成 daily_share_candidates，标出来源类型；它们只是候选，不等于会发送。",
    "7. 生成 schedule_candidates，提出可能的短期日程候选；不要直接当作已确认日程。",
    "8. 写出 time_reasoning 和 continuity_warnings，供程序和人类审计。",
    "",
    "时间连续性硬规则：",
    "- 先根据 current_time、recent_visible_context 和 last_world_event_at 判断时间差。",
    "- 几分钟到十几分钟内的连续对话，一般属于同一次醒来/同一段聊天，不要重复写成第二次、第三次被叫醒。",
    "- 睡眠、起床、通勤、排练等时间必须能算得通；不能凭空把还剩数小时写成只剩两三小时。",
    "- 用户纠正时间逻辑时，优先修正 hidden world，而不是沿用旧 scene_state 或 life_arc。",
    "",
    "daily_share 来源类型：",
    "- life_arc_related: 来自当前日程或生活线。",
    "- ambient_observation: 路上、手机、店铺、书、音乐、社交网络等偶然见闻。",
    "- memory_resurfacing: 从过去聊天自然想起。",
    "- pure_mood: 没有具体事件，只是熟人间突然想说一句。",
    "不要让 daily_share 全部围绕当前日程转。",
    "",
    sceneletBase,
    "",
    cfg.lifeArcInstructions || "",
    "",
    CURRENT_SITE_AND_SEARCH_GUARD,
    "",
    "角色 prompt：",
    profile && profileTemplates[profile] ? profileTemplates[profile] : "",
    loadPinnedProfileRules(profile),
    "",
    "聊天写法参考（用于降低 scenelet 的 AI 味；最终微信回复仍由主回复模型负责）：",
    getChatStyle(),
  ].filter(Boolean).join("\n");
}

function buildHiddenWorldPrompt({ userId, sessionName, profile, userBody, carriedSceneState, lifeArcs = [], visibleContext, memoryPrompt, worldState = null, proactiveIntents = [], worldSession = null }) {
  const now = new Date();
  const cfg = loadPrompts();
  return [
    "你将收到本轮动态上下文。请按 hidden-world system prompt 的规则输出 JSON。",
    "",
    memoryPrompt ? `长期记忆：\n${memoryPrompt}` : "",
    "",
    "当前时间：",
    JSON.stringify(currentTimeContext(now), null, 2),
    "",
    "输入：",
    JSON.stringify({
      userId,
      sessionName,
      profile,
      hidden_world_session: worldSession ? {
        sid: worldSession.sid,
        firstTurn: worldSession.firstTurn,
        startedAt: worldSession.startedAt,
        lastUsedAt: worldSession.lastUsedAt,
      } : null,
      world_state: worldState,
      visible_context_instruction: cfg.chatHistoryIntro,
      carried_scene_state: carriedSceneState || null,
      active_life_arcs: lifeArcs,
      pending_proactive_intents: proactiveIntents,
      recent_visible_context: visibleContext,
      user_message: userBody,
    }, null, 2),
    "",
    "只输出 JSON，不要解释。格式：",
    JSON.stringify({
      inner_scenelet: "string",
      next_scene_state: "string|null",
      world_state_patch: {
        location: "short current place",
        activity: "short current activity",
        awake_state: "awake|sleeping|light_sleep|just_woke|unknown",
        current_plan: "next few hours only",
        open_threads: ["short unresolved visible or hidden threads"],
        last_world_event_at: "ISO string"
      },
      life_arc_ops: [{
        op: "create|update|close",
        id: "existing id when updating/closing, omit for create",
        title: "short private life line title",
        summary: "what is continuing for 1-3 days",
        current_state: "where it stands now",
        next_useful_moment: "when it may naturally matter again",
        kind: "travel|work|school|personal|special_date|null",
        time_start: "ISO string|null",
        time_end: "ISO string|null",
        expires_at: "ISO string within a few days",
        reason: "why this op is useful"
      }],
      proactive_candidates: [{
        kind: "follow_up|daily_share",
        scheduled_at: "ISO string",
        expires_at: "ISO string",
        message_intent: "string",
        basis: "string",
        cancel_if: ["string"],
        inner_scenelet: "string"
      }],
      daily_share_candidates: [{
        source_type: "life_arc_related|ambient_observation|memory_resurfacing|pure_mood",
        message_intent: "string",
        basis: "string",
        scheduled_at: "ISO string|null",
        expires_at: "ISO string|null",
        inner_scenelet: "string"
      }],
      schedule_candidates: [{
        title: "short title",
        summary: "short summary",
        kind: "travel|work|school|personal|special_date",
        time_start: "ISO string|null",
        time_end: "ISO string|null",
        confidence: "low|medium|high",
        basis: "string"
      }],
      time_reasoning: {
        current_role_time: "string",
        elapsed_since_last_visible_turn: "string",
        event_continuity: "string",
        sleep_reasoning: "string"
      },
      continuity_warnings: ["string"]
    }, null, 2),
  ].filter(Boolean).join("\n");
}

function normalizeSceneletResult(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    innerScenelet: raw.inner_scenelet ? String(raw.inner_scenelet).trim() : "",
    nextSceneState: raw.next_scene_state ? String(raw.next_scene_state).trim().slice(0, getSceneConfig().sceneStateMaxChars) : "",
    lifeArcOps: Array.isArray(raw.life_arc_ops) ? raw.life_arc_ops : [],
    proactiveCandidates: Array.isArray(raw.proactive_candidates) ? raw.proactive_candidates : [],
    worldStatePatch: raw.world_state_patch && typeof raw.world_state_patch === "object" ? raw.world_state_patch : null,
    dailyShareCandidates: Array.isArray(raw.daily_share_candidates) ? raw.daily_share_candidates : [],
    scheduleCandidates: Array.isArray(raw.schedule_candidates) ? raw.schedule_candidates : [],
    timeReasoning: raw.time_reasoning && typeof raw.time_reasoning === "object" ? raw.time_reasoning : null,
    continuityWarnings: Array.isArray(raw.continuity_warnings) ? raw.continuity_warnings.map(x => String(x).slice(0, 300)).slice(0, 8) : [],
    toolUsage: normalizeToolUsage(raw._toolUsage) || emptyToolUsage(),
    hiddenCall: raw._hiddenCall || null,
  };
}

async function generateSceneletForTurn({ userId, sess, profile, userBody, memoryPrompt }) {
  if (!profile || !profileTemplates[profile]) return null;
  const roleWorld = getRoleWorld(profile);
  const world = ensureWorldSession(roleWorld);
  const prompt = buildHiddenWorldPrompt({
    userId,
    sessionName: sess.name,
    profile,
    userBody,
    carriedSceneState: "",
    lifeArcs: lifeArcPromptItems(roleWorld),
    visibleContext: recentVisibleContext(sess),
    memoryPrompt,
    worldState: normalizeWorldState(roleWorld._worldState),
    proactiveIntents: normalizeProactiveIntents(sess._proactiveIntents).filter(i => i.status === "pending").slice(-8),
    worldSession: world,
  });
  let raw = await runHiddenJson(prompt, {
    label: "hidden_world",
    bare: SCENELET_BARE,
    persist: true,
    sessionName: `hidden-world-${roleWorldKey(profile)}`,
    sessionId: world.sid,
    firstTurn: world.firstTurn,
    model: world.model || SCENELET_MODEL,
    systemPrompt: buildHiddenWorldSystemPrompt(profile),
  });
  if (!raw && !world.firstTurn) {
    world.sid = uuid();
    world.firstTurn = true;
    world.startedAt = new Date().toISOString();
    world.resetReason = "hidden world retry after failed resume";
    raw = await runHiddenJson(prompt, {
      label: "hidden_world_retry",
      bare: SCENELET_BARE,
      persist: true,
      sessionName: `hidden-world-${roleWorldKey(profile)}`,
      sessionId: world.sid,
      firstTurn: true,
      model: world.model || SCENELET_MODEL,
      systemPrompt: buildHiddenWorldSystemPrompt(profile),
    });
  }
  const result = normalizeSceneletResult(raw);
  if (!result?.innerScenelet) return null;
  if (raw?._hiddenCall?.session_id) world.sid = raw._hiddenCall.session_id;
  world.firstTurn = false;
  world.lastUsedAt = new Date().toISOString();
  world.lastUsage = result.hiddenCall || null;
  applyWorldStatePatch(roleWorld, result.worldStatePatch);
  roleWorld._sceneState = normalizeSceneState({
    text: result.nextSceneState,
    updatedAt: world.lastUsedAt,
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  });
  roleWorld._worldLastOutput = {
    timestamp: world.lastUsedAt,
    innerScenelet: result.innerScenelet,
    nextSceneState: result.nextSceneState,
    worldStatePatch: result.worldStatePatch,
    dailyShareCandidates: result.dailyShareCandidates,
    scheduleCandidates: result.scheduleCandidates,
    timeReasoning: result.timeReasoning,
    continuityWarnings: result.continuityWarnings,
  };
  roleWorld.updatedAt = world.lastUsedAt;
  syncRoleWorldToSession(sess, profile);
  saveRoleWorlds();
  return result;
}

function buildSceneContextBlock(sess, sceneletResult, carriedState) {
  const cfg = loadPrompts();
  const profile = sessionProfile(sess);
  const lifeArcSummary = profile ? lifeArcPromptItems(getRoleWorld(profile)).map(arc => ({
    title: arc.title,
    current_state: arc.current_state,
    next_useful_moment: arc.next_useful_moment,
    kind: arc.kind,
    time_start: arc.time_start,
    time_end: arc.time_end,
  })).slice(-3) : [];
  const parts = [
    sceneletResult?.nextSceneState ? ["【轻量 scene_state】", cfg.sceneStateIntro, sceneletResult.nextSceneState].filter(Boolean).join("\n") : "",
    lifeArcSummary.length ? [
      "【短期 life_arc 简述】",
      "以下是 hidden-world 已确认的短期生活线摘要，只作为时间框架和自然接话参考，不要主动复述 JSON。",
      JSON.stringify(lifeArcSummary, null, 2),
    ].join("\n") : "",
    sceneletResult?.innerScenelet ? [
      "【隐藏中间层：inner_scenelet】",
      cfg.innerSceneletIntro,
      sceneletResult.innerScenelet,
      cfg.sceneletReplyBridgeInstruction ? [
        "【从 inner_scenelet 到微信回复】",
        cfg.sceneletReplyBridgeInstruction,
      ].join("\n") : "",
    ].filter(Boolean).join("\n") : "",
  ].filter(Boolean);
  return parts.join("\n\n");
}

async function addProactiveCandidates(sess, sceneletResult, userBody) {
  if (!sess || !sceneletResult?.proactiveCandidates?.length) return;
  const nowIso = new Date().toISOString();
  const existing = normalizeProactiveIntents(sess._proactiveIntents);
  for (const raw of sceneletResult.proactiveCandidates.slice(0, 3)) {
    const candidate = normalizeRawProactiveCandidate(raw, {
      nowIso,
      sourceUserText: userBody,
      defaultKind: "follow_up",
    });
    if (!candidate) continue;
    const sameKind = existing.filter(x => x.status === "pending" && x.kind === candidate.kind);
    if (sameKind.length) {
      const dup = await checkIntentDuplicateFlash(candidate, sameKind);
      if (dup) continue;
    }
    existing.push(candidate);
  }
  sess._proactiveIntents = normalizeProactiveIntents(existing);
}

function normalizeRawProactiveCandidate(raw, { nowIso = new Date().toISOString(), sourceUserText = "", defaultKind = "follow_up" } = {}) {
  const scheduled = raw?.scheduled_at ? new Date(raw.scheduled_at) : null;
  if (!scheduled || Number.isNaN(scheduled.getTime())) return null;
  const expires = raw.expires_at ? new Date(raw.expires_at) : new Date(scheduled.getTime() + 30 * 60 * 1000);
  return normalizeProactiveIntent({
    id: crypto.randomUUID(),
    status: "pending",
    createdAt: nowIso,
    scheduledAt: scheduled.toISOString(),
    expiresAt: Number.isNaN(expires.getTime()) ? new Date(scheduled.getTime() + 30 * 60 * 1000).toISOString() : expires.toISOString(),
    sourceTurnAt: nowIso,
    sourceUserText,
    basis: raw.basis || "",
    cancelIf: raw.cancel_if || [],
    innerScenelet: raw.inner_scenelet || "",
    messageIntent: raw.message_intent || "",
    kind: raw.kind || defaultKind,
  });
}

function normalizeScheduleCandidates(raw = []) {
  if (!Array.isArray(raw)) return [];
  const kinds = ["travel", "work", "school", "personal", "special_date"];
  return raw.map(item => {
    if (!item || typeof item !== "object") return null;
    const title = String(item.title || "").trim().slice(0, 80);
    const kind = kinds.includes(item.kind) ? item.kind : "";
    if (!title || !kind) return null;
    return {
      title,
      summary: String(item.summary || "").trim().slice(0, 500),
      kind,
      time_start: item.time_start || item.timeStart || null,
      time_end: item.time_end || item.timeEnd || null,
      confidence: ["low", "medium", "high"].includes(item.confidence) ? item.confidence : "medium",
      basis: String(item.basis || "").trim().slice(0, 300),
    };
  }).filter(Boolean).slice(0, 5);
}

function setSceneStateFromText(sess, text, ttlMs = 2 * 60 * 60 * 1000) {
  const normalized = normalizeSceneState({
    text,
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  });
  sess._sceneState = normalized;
}

function recordChatHistory({ ai, userId, sess, role, kind = "chat", text, scenelet = "", sceneState = "", sceneletStatus = "", sceneletError = "", proactiveIntentId = "", toolUsage = null, ragUsage = null, timestamp = new Date().toISOString() }) {
  if (!sess || (!text?.trim() && !scenelet?.trim())) return;
  appendChatEvent({
    timestamp,
    userId,
    ai,
    sessionId: sess.id,
    sessionName: sess.name,
    profile: sessionProfile(sess) || "默认",
    role,
    kind,
    text,
    scenelet,
    sceneState,
    sceneletStatus,
    sceneletError,
    proactiveIntentId,
    toolUsage: normalizeToolUsage(toolUsage),
    ragUsage: ragUsage && typeof ragUsage === "object" ? {
      used: Boolean(ragUsage.used),
      chars: Number(ragUsage.chars || 0) || 0,
      eligible: Boolean(ragUsage.eligible),
    } : null,
  });
}

function buildMemoryCandidatePrompt(userBody, userId, profile) {
  return [
    "你是长期记忆候选抽取器，只判断用户这条消息中是否有值得长期保存的信息。",
    "不要查看或推断角色设定；不要记录当天闲聊、一次性情绪、饭点、天气、临时计划、角色扮演内容。",
    "只抽取长期稳定、跨对话有用、由用户明确表达的信息。",
    "类别只能是 trait、preference、fact。敏感或私密内容如健康、政治、宗教、性取向、财务、精确住址、亲密关系，确需记录时 sensitive=true。",
    "如果没有候选，输出空数组。",
    "",
    "输入：",
    JSON.stringify({ userId, profile, user_message: userBody }, null, 2),
    "",
    "只输出 JSON，不要解释。格式：",
    JSON.stringify({
      candidates: [{
        category: "trait|preference|fact",
        text: "简洁中文长期记忆候选",
        sensitive: false,
        reason: "为什么长期有用"
      }]
    }, null, 2),
  ].join("\n");
}

function normalizeMemoryCandidates(raw = []) {
  if (!Array.isArray(raw)) return [];
  return raw.map(item => {
    const category = normalizeMemoryCategory(item?.category);
    const text = String(item?.text || "").trim().slice(0, 180);
    if (!category || !text) return null;
    return {
      category,
      text,
      sensitive: Boolean(item?.sensitive),
      reason: item?.reason ? String(item.reason).slice(0, 220) : "",
    };
  }).filter(Boolean).slice(0, 6);
}

function buildMemoryMergePrompt({ userBody, userId, profile, candidates, existingItems }) {
  const cfg = loadPrompts();
  const policy = cfg.memoryWriterInstructions || "";
  return [
    "你是长期记忆合并规划器。你会拿到候选记忆和当前正式 memory items。",
    "目标：避免重复，能合并就 update，用户否定旧信息就 update 覆盖，只有确实没有相近旧条目时才 add。",
    "不要机械新增；不要把同一事实拆成多条；不要根据角色聊天内容写用户长期记忆。",
    "op 只能是 add、update、noop。update 必须带现有 id；noop 不需要 category/text。",
    "text 必须是可长期复用的简洁中文，最多 180 字。",
    "",
    policy ? `补充写入规则：\n${policy.slice(0, 2200)}` : "",
    "",
    "输入：",
    JSON.stringify({
      userId,
      profile,
      user_message: userBody,
      candidates,
      existing_memory_items: existingItems,
    }, null, 2),
    "",
    "只输出 JSON，不要解释。格式：",
    JSON.stringify({
      ops: [{
        op: "add|update|noop",
        id: "existing id when update",
        category: "trait|preference|fact",
        text: "简洁中文长期记忆",
        sensitive: false,
        reason: "简短说明"
      }]
    }, null, 2),
  ].filter(Boolean).join("\n");
}

function normalizeMemoryOps(raw = []) {
  if (!Array.isArray(raw)) return [];
  return raw.map(item => {
    const op = String(item?.op || "noop").trim().toLowerCase();
    if (op === "noop") return { op: "noop" };
    if (!["add", "update"].includes(op)) return null;
    const category = normalizeMemoryCategory(item?.category);
    const text = String(item?.text || "").trim().slice(0, 180);
    const id = item?.id ? String(item.id).trim() : "";
    if (!category || !text) return null;
    if (op === "update" && !id) return null;
    return {
      op,
      id,
      category,
      text,
      sensitive: Boolean(item?.sensitive),
    };
  }).filter(Boolean).slice(0, 6);
}

function sanitizeVisibleReplyText(text) {
  return String(text || "")
    .replace(/\[[\u4e00-\u9fffA-Za-z]{1,12}\]/gu, "")
    .replace(/^\s*[—\-－]{2,}\s*$/gm, "")
    .replace(/—+/g, "，")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function sendFinalAssistantMessage(userId, text, contextToken, prefix, isProfileChat = true) {
  const trimmed = (isProfileChat ? sanitizeVisibleReplyText(text) : String(text || "")).trim();
  if (!trimmed) return false;
  const socialParts = isProfileChat ? splitSocialReply(trimmed) : [trimmed];
  const messages = [];
  for (let i = 0; i < socialParts.length; i++) {
    const head = i === 0 ? `# ${prefix}\n` : "";
    const tail = i === socialParts.length - 1 ? "/" : "";
    messages.push(...splitText(`${head}${socialParts[i]}${tail}`, MAX_REPLY_LEN));
  }
  let ok = true;
  for (const chunk of messages) {
    if (!await sendMessage(userId, chunk, contextToken)) ok = false;
    if (messages.length > 1) await sleep(450);
  }
  return ok;
}

function activeProfileSessionEntries() {
  const entries = [];
  for (const [ai, map] of Object.entries(sessions)) {
    for (const [userId, userData] of map) {
      const sess = (userData.list || []).find(s => s.id === userData.activeId);
      const profile = sessionProfile(sess);
      if (sess && profile && profileTemplates[profile]) entries.push({ ai, userId, sess, profile });
    }
  }
  return entries;
}

function markProactiveIntent(intent, status, reason = "") {
  intent.status = status;
  if (status === "sent") intent.sentAt = new Date().toISOString();
  if (status === "cancelled") intent.cancelledAt = new Date().toISOString();
  if (reason) intent.cancelReason = String(reason).slice(0, 500);
}

function buildProactivePrompt({ userId, sessionName, profile, intent, memoryPrompt, carriedSceneState, visibleContext, sess }) {
  const now = new Date();
  const cfg = loadPrompts();
  const instr = (cfg.proactiveInstructions || "你在为微信角色私聊做一次性主动回复的到点二次判断。\n\n任务：根据系统可观察状态、上下文和候选意图，判断现在是否应该主动发送。如果发送，生成 inner_scenelet 和最终 visible_reply。");
  return [
    instr,
    "",
    "角色 prompt：",
    profile && profileTemplates[profile] ? profileTemplates[profile] : "",
    loadPinnedProfileRules(profile),
    "",
    memoryPrompt ? `长期记忆：\n${memoryPrompt}` : "",
    "",
    "机制要求：",
    "- 这不是定时循环，而是一次性候选；发送或取消后结束。",
    "- inner_scenelet 在这里承担 timing reason：贴近角色视角说明为什么此刻主动说话自然，并帮助生成回复；它不会直接发给用户。",
    "- 取消条件必须基于系统可观察事实：用户已经发来消息、事项已完成/取消、超过窗口、近期已主动发过、当天主动回复已达到上限、当前对话有更强主题等。",
    "- 不要用固定静默时段作为取消理由；夜里是否适合发送，只看候选本身、角色状态和当前关系语境是否自然。",
    "- 不要把角色生活氛围当成执行逻辑；例如'她忘了/她很忙'只能写在 inner_scenelet 的氛围里，不能作为系统取消原因。",
    "- 如果 system_observables.unanswered_proactive_since_last_user 显示近期已有多条主动消息但用户没有回复，要把这视为关系节奏：通常更克制或取消；如果仍发送，应像熟人随手补一句，而不是继续追问、查岗或叠加关心。",
    "- visible_reply 可以长可以短，由语境决定；不要泄露 inner_scenelet、机制、JSON、bot/AI/model 身份。",
    "- 固定角色事实不要为了漂亮类比而编造；不确定就模糊处理。",
    "- 用户（沃沃）是女性，指代用户时始终使用「她」。",
    "",
    "当前时间：",
    JSON.stringify(currentTimeContext(now), null, 2),
    "",
    "输入：",
    JSON.stringify({
      userId,
      sessionName,
      profile,
      system_observables: {
        session_busy: Boolean(sess?.busy),
        queued_turns: Number(sess?.queue?.length || 0),
        last_user_at: sess?._lastUserAt || null,
        last_assistant_at: sess?._lastAssistantAt || null,
        last_proactive_at: sess?._lastProactiveAt || null,
        last_daily_share_seed_at: sess?._lastDailyShareSeedAt || null,
        unanswered_proactive_since_last_user: unansweredProactiveSummary(sess),
      },
      visible_context_instruction: cfg.chatHistoryIntro,
      carried_scene_state: carriedSceneState || null,
      active_life_arcs: lifeArcPromptItems(sess),
      recent_visible_context: visibleContext,
      candidate_intent: intent,
    }, null, 2),
    "",
    "输出 JSON，且只输出 JSON：",
    JSON.stringify({
      should_send: true,
      cancel_reason: "string|null",
      inner_scenelet: "string",
      visible_reply: "string",
      next_scene_state: "string|null"
    }, null, 2),
  ].filter(Boolean).join("\n");
}

function normalizeProactiveDecision(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    shouldSend: raw.should_send === true,
    cancelReason: raw.cancel_reason ? String(raw.cancel_reason).slice(0, 500) : "",
    innerScenelet: raw.inner_scenelet ? String(raw.inner_scenelet).trim() : "",
    visibleReply: raw.visible_reply ? sanitizeVisibleReplyText(raw.visible_reply) : "",
    nextSceneState: raw.next_scene_state ? String(raw.next_scene_state).trim().slice(0, getSceneConfig().sceneStateMaxChars) : "",
    toolUsage: normalizeToolUsage(raw._toolUsage) || emptyToolUsage(),
  };
}

async function evaluateProactiveIntent({ ai, userId, sess, profile, intent }) {
  const memoryPrompt = renderMemoryPrompt(userId, { profile });
  const prompt = buildProactivePrompt({
    userId,
    sessionName: sess.name,
    profile,
    intent,
    memoryPrompt,
    carriedSceneState: sceneStateText(sess),
    visibleContext: recentVisibleContext(sess),
    sess,
  });
  const raw = await runHiddenJson(prompt, { label: "proactive" });
  return normalizeProactiveDecision(raw);
}

function localDayKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function sameLocalDay(iso, date = new Date()) {
  const d = iso ? new Date(iso) : null;
  return d && Number.isFinite(d.getTime()) && localDayKey(d) === localDayKey(date);
}

function proactiveSentToday(sess, date = new Date()) {
  return normalizeProactiveIntents(sess?._proactiveIntents)
    .filter(i => i.status === "sent" && sameLocalDay(i.sentAt || i.scheduledAt, date))
    .length;
}

function unansweredProactiveSummary(sess) {
  const lastUserMs = Date.parse(sess?._lastUserAt || "");
  const sent = normalizeProactiveIntents(sess?._proactiveIntents)
    .filter(i => i.status === "sent" && Number.isFinite(Date.parse(i.sentAt || i.scheduledAt)))
    .filter(i => !Number.isFinite(lastUserMs) || Date.parse(i.sentAt || i.scheduledAt) > lastUserMs)
    .sort((a, b) => Date.parse(a.sentAt || a.scheduledAt) - Date.parse(b.sentAt || b.scheduledAt));
  if (!sent.length) return null;
  const recentReplies = normalizeVisibleHistory(sess?._visibleHistory)
    .filter(x => x.role === "assistant" && x.kind === "proactive")
    .filter(x => !Number.isFinite(lastUserMs) || Date.parse(x.timestamp || "") > lastUserMs)
    .slice(-3)
    .map(x => ({
      timestamp: x.timestamp || null,
      text: String(x.text || "").slice(0, 160),
    }));
  return {
    count_since_last_user: sent.length,
    last_user_at: sess?._lastUserAt || null,
    last_sent_at: sent.at(-1)?.sentAt || sent.at(-1)?.scheduledAt || null,
    recent_kinds: sent.slice(-5).map(i => i.kind || "follow_up"),
    recent_message_intents: sent.slice(-5).map(i => i.messageIntent || "").filter(Boolean),
    recent_visible_replies: recentReplies,
    interpretation: "These proactive messages were sent after the user's last message and have not received a user reply yet. Treat this as relationship context, not as permission to keep sending.",
  };
}

function lastConversationActivityMs(sess) {
  const times = [sess?._lastUserAt, sess?._lastAssistantAt]
    .map(x => Date.parse(x || ""))
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : 0;
}

function buildDailyShareSeedPrompt({ userId, sessionName, profile, memoryPrompt, carriedSceneState, visibleContext, sess }) {
  const now = new Date();
  const cfg = loadPrompts();
  const instr = cfg.dailyShareSeedInstructions || "你在为社交软件角色私聊判断是否生成一条 daily_share 主动候选。只输出 JSON。";
  return [
    instr,
    "",
    "关系节奏补充：如果 system_observables.unanswered_proactive_since_last_user 显示近期已有多条主动消息但用户没有回复，不要把这当成继续主动发起话题的许可；除非此刻的分享非常自然、轻、低压力，否则应取消生成。",
    "",
    CURRENT_SITE_AND_SEARCH_GUARD,
    "",
    "角色 prompt：",
    profile && profileTemplates[profile] ? profileTemplates[profile] : "",
    loadPinnedProfileRules(profile),
    "",
    memoryPrompt ? `长期记忆：\n${memoryPrompt}` : "",
    "",
    "当前时间：",
    JSON.stringify(currentTimeContext(now), null, 2),
    "",
    "输入：",
    JSON.stringify({
      userId,
      sessionName,
      profile,
      system_observables: {
        session_busy: Boolean(sess?.busy),
        queued_turns: Number(sess?.queue?.length || 0),
        last_user_at: sess?._lastUserAt || null,
        last_assistant_at: sess?._lastAssistantAt || null,
        last_proactive_at: sess?._lastProactiveAt || null,
        last_daily_share_seed_at: sess?._lastDailyShareSeedAt || null,
        proactive_sent_today: proactiveSentToday(sess, now),
        proactive_daily_max: cfg.proactiveDailyMax,
        unanswered_proactive_since_last_user: unansweredProactiveSummary(sess),
      },
      visible_context_instruction: cfg.chatHistoryIntro,
      carried_scene_state: carriedSceneState || null,
      active_life_arcs: lifeArcPromptItems(sess),
      recent_visible_context: visibleContext,
    }, null, 2),
    "",
    "输出 JSON，且只输出 JSON：",
    JSON.stringify({
      should_create: true,
      cancel_reason: "string|null",
      proactive_candidate: {
        kind: "daily_share",
        scheduled_at: "ISO string",
        expires_at: "ISO string",
        message_intent: "string",
        basis: "string",
        cancel_if: ["string"],
        inner_scenelet: "string"
      }
    }, null, 2),
  ].filter(Boolean).join("\n");
}

async function maybeSeedDailyShareIntent({ ai, userId, sess, profile, pending }) {
  const cfg = getSceneConfig();
  const roleWorld = getRoleWorld(profile);
  if (pending.length) return { changed: false, intent: null };
  if (proactiveSentToday(sess) >= cfg.proactiveDailyMax) return { changed: false, intent: null };

  const nowMs = Date.now();
  const lastSeedMs = Date.parse(roleWorld._lastDailyShareSeedAt || sess._lastDailyShareSeedAt || "");
  if (Number.isFinite(lastSeedMs) && nowMs - lastSeedMs < cfg.dailyShareSeedIntervalMs) return { changed: false, intent: null };

  const lastActivityMs = lastConversationActivityMs(sess);
  if (!lastActivityMs || nowMs - lastActivityMs < cfg.dailyShareMinIdleMs) return { changed: false, intent: null };

  const nowIso = new Date(nowMs).toISOString();
  const worldOutputAt = Date.parse(roleWorld._worldLastOutput?.timestamp || "");
  const candidates = Array.isArray(roleWorld._worldLastOutput?.dailyShareCandidates) ? roleWorld._worldLastOutput.dailyShareCandidates : [];
  roleWorld._lastDailyShareSeedAt = nowIso;
  sess._lastDailyShareSeedAt = nowIso;
  saveRoleWorlds();
  if (!Number.isFinite(worldOutputAt) || (Number.isFinite(lastSeedMs) && worldOutputAt <= lastSeedMs) || !candidates.length) {
    return { changed: true, intent: null };
  }

  const candidate = candidates.find(x => x && typeof x === "object" && x.message_intent);
  if (!candidate) return { changed: true, intent: null };
  const rawScheduledAt = candidate.scheduled_at || new Date(nowMs + 5 * 60 * 1000).toISOString();
  const parsedScheduledAt = Date.parse(rawScheduledAt || "");
  const scheduledAt = Number.isFinite(parsedScheduledAt) ? rawScheduledAt : new Date(nowMs + 5 * 60 * 1000).toISOString();
  const parsedFinalScheduledAt = Date.parse(scheduledAt);
  const rawExpiresAt = candidate.expires_at || "";
  const parsedExpiresAt = Date.parse(rawExpiresAt);
  const expiresAt = Number.isFinite(parsedExpiresAt)
    ? rawExpiresAt
    : new Date(parsedFinalScheduledAt + 30 * 60 * 1000).toISOString();
  const intent = normalizeRawProactiveCandidate({
    kind: "daily_share",
    scheduled_at: scheduledAt,
    expires_at: expiresAt,
    message_intent: candidate.message_intent,
    basis: [candidate.source_type, candidate.basis].filter(Boolean).join(": "),
    cancel_if: candidate.cancel_if || ["用户已经开启新话题", "用户正在忙或没有回应上一条主动消息"],
    inner_scenelet: candidate.inner_scenelet || "",
  }, {
    nowIso,
    sourceUserText: "",
    defaultKind: "daily_share",
  });
  return { changed: true, intent };
}

async function maybeCreateScheduleEntry({ sess, profile }) {
  const cfg = getSceneConfig();
  const roleWorld = getRoleWorld(profile);
  const activeSchedules = normalizeLifeArcs(roleWorld._lifeArcs).filter(a => a.kind);
  if (activeSchedules.length >= cfg.scheduleMaxActive) return false;
  const candidates = normalizeScheduleCandidates(roleWorld._worldLastOutput?.scheduleCandidates || []);
  if (!candidates.length) return false;

  const nowMs = Date.now();
  const lastCheckMs = Date.parse(roleWorld._lastScheduleCheckAt || sess._lastScheduleCheckAt || "");
  if (Number.isFinite(lastCheckMs) && nowMs - lastCheckMs < cfg.scheduleCheckIntervalMs) return false;

  const nowIso = new Date(nowMs).toISOString();
  roleWorld._lastScheduleCheckAt = nowIso;
  sess._lastScheduleCheckAt = nowIso;
  saveRoleWorlds();

  const recentKinds = normalizeLifeArcs(roleWorld._lifeArcs, { includeClosed: true })
    .filter(a => a.kind)
    .slice(-5)
    .map(a => a.kind);

  const now = new Date(nowMs);
  const staticCtx = buildScheduleStaticContext(now);
  // Truncate to keep the prompt manageable for flash model
  const staticCtxShort = staticCtx.length > 2000 ? staticCtx.slice(0, 2000) + "\n...(truncated)" : staticCtx;

  const prompt = [
    cfg.scheduleCreatorInstructions,
    "",
    staticCtxShort,
    "",
    "角色 prompt（截取关键身份信息）：",
    profile && profileTemplates[profile] ? profileTemplates[profile].slice(0, 800) : "",
    "",
    "Hidden-world 提出的 schedule candidates：",
    JSON.stringify(candidates, null, 2),
    "",
    "当前活跃日程：",
    activeSchedules.length
      ? activeSchedules.map(a => `- [${a.kind}] ${a.title} (${a.timeStart || "?"} ~ ${a.timeEnd || "?"})`).join("\n")
      : "(无)",
    "",
    recentKinds.length ? `最近曾创建过的日程类型：${[...new Set(recentKinds)].join("、")}。请避免短期内重复同类安排。` : "",
    "",
    "只输出 JSON，不要解释：",
    JSON.stringify({
      selected_index: -1,
      basis: "简短说明",
      life_arc: {
        title: "string",
        summary: "string",
        kind: "travel|work|school|personal|special_date",
        time_start: "ISO string|null",
        time_end: "ISO string|null"
      }
    }, null, 2),
  ].filter(Boolean).join("\n");

  const result = await runHiddenJson(prompt, {
    label: "schedule_finalization",
    bare: false,
    model: CLAUDE_FAST_MODEL,
    timeoutMs: 60_000,
  });

  if (!result || result.selected === "none" || Number(result.selected_index ?? -1) < 0 || !result.life_arc) return true;
  const arc = result.life_arc;
  if (!arc.title || !arc.kind) return true;
  const timeEnd = arc.time_end || arc.timeEnd || null;
  const parsedEnd = Date.parse(timeEnd || "");
  const expiresAt = Number.isFinite(parsedEnd)
    ? new Date(parsedEnd + 12 * 60 * 60 * 1000).toISOString()
    : new Date(nowMs + 3 * 24 * 60 * 60 * 1000).toISOString();

  applyLifeArcOps(roleWorld, [{
    op: "create",
    title: String(arc.title).slice(0, 80),
    summary: String(arc.summary || "").slice(0, 500),
    kind: arc.kind,
    time_start: arc.time_start || arc.timeStart || null,
    time_end: timeEnd,
    expires_at: expiresAt,
    reason: result.basis ? String(result.basis).slice(0, 300) : "schedule creator",
  }]);
  roleWorld.updatedAt = new Date().toISOString();
  syncRoleWorldToSession(sess, profile);
  saveRoleWorlds();
  log("\u{1F4C5}", `[${sess.name}] schedule created: [${arc.kind}] ${arc.title}`);
  return true;
}

async function checkProactiveIntents() {
  const nowMs = Date.now();
  if (nowMs - lastProactiveCheckAt < getSceneConfig().proactiveCheckIntervalMs) return;
  lastProactiveCheckAt = nowMs;

  for (const { ai, userId, sess, profile } of activeProfileSessionEntries()) {
    if (sess.busy || sess.queue?.length || pendingInputs.has(userId)) continue;
    let allIntents = normalizeProactiveIntents(sess._proactiveIntents);
    let pending = allIntents.filter(x => x.status === "pending");

    let changed = false;

    // Schedule creator — independent of intent queue
    const scheduleChanged = await maybeCreateScheduleEntry({ sess, profile }).catch(e => {
      log("⚠️", `schedule creator skipped: ${e.message}`);
      return false;
    });
    if (scheduleChanged) changed = true;

    if (!pending.length) {
      const seeded = await maybeSeedDailyShareIntent({ ai, userId, sess, profile, pending });
      if (seeded.changed) changed = true;
      if (seeded.intent) {
        allIntents = normalizeProactiveIntents([...allIntents, seeded.intent]);
        pending = allIntents.filter(x => x.status === "pending");
      }
    }
    if (!pending.length) {
      if (changed) saveSessions();
      continue;
    }

    for (const intent of pending) {
      const scheduled = Date.parse(intent.scheduledAt);
      const expires = intent.expiresAt ? Date.parse(intent.expiresAt) : scheduled + 30 * 60 * 1000;
      if (!Number.isFinite(scheduled)) {
        markProactiveIntent(intent, "cancelled", "invalid scheduled_at");
        changed = true;
        continue;
      }
      if (Number.isFinite(expires) && nowMs > expires) {
        markProactiveIntent(intent, "cancelled", "current time exceeded expires_at");
        changed = true;
        continue;
      }
      if (nowMs < scheduled) continue;
      if (proactiveSentToday(sess) >= getSceneConfig().proactiveDailyMax) {
        markProactiveIntent(intent, "cancelled", "daily proactive limit reached");
        changed = true;
        continue;
      }
      if (sess._lastProactiveAt && nowMs - Date.parse(sess._lastProactiveAt) < getSceneConfig().proactiveCooldownMs) continue;

      intent.lastCheckedAt = new Date().toISOString();
      const decision = await evaluateProactiveIntent({ ai, userId, sess, profile, intent });
      if (!decision?.shouldSend || !decision.visibleReply) {
        markProactiveIntent(intent, "cancelled", decision?.cancelReason || "second check declined");
        changed = true;
        continue;
      }

      const sent = await sendFinalAssistantMessage(userId, decision.visibleReply, sess._lastContextToken, replyPrefix(sess.name, ai), true);
      if (!sent) {
        intent.cancelReason = "send failed";
        changed = true;
        continue;
      }

      const sentAt = new Date().toISOString();
      markProactiveIntent(intent, "sent");
      sess._lastProactiveAt = sentAt;
      sess._lastAssistantAt = sentAt;
      appendVisibleHistory(sess, "assistant", decision.visibleReply, "proactive", sentAt);
      if (decision.nextSceneState) setSceneStateFromText(sess, decision.nextSceneState);
      recordChatHistory({
        ai,
        userId,
        sess,
        role: "assistant",
        kind: "proactive",
        text: decision.visibleReply,
        scenelet: decision.innerScenelet || intent.innerScenelet,
        sceneState: decision.nextSceneState,
        proactiveIntentId: intent.id,
        toolUsage: decision.toolUsage,
        timestamp: sentAt,
      });
      changed = true;
    }

    if (changed) {
      sess._proactiveIntents = normalizeProactiveIntents(allIntents);
      saveSessions();
    }
  }
}

async function updateUserMemoryFromTurn(userId, userBody, profile) {
  if (!isMemoryEnabled(userId)) return [];
  if (!shouldRunMemoryWriter(userBody)) return [];
  const candidatesRaw = await runHiddenJson(buildMemoryCandidatePrompt(userBody, userId, profile), {
    label: "memory_candidate_extractor",
    bare: true,
    model: CLAUDE_FAST_MODEL,
    timeoutMs: 45_000,
  });
  const candidates = normalizeMemoryCandidates(candidatesRaw?.candidates || candidatesRaw?.memory_candidates || []);
  if (!candidates.length) return [];

  const existingItems = listMemoryItems(userId, { profile });
  const planRaw = await runHiddenJson(buildMemoryMergePrompt({ userBody, userId, profile, candidates, existingItems }), {
    label: "memory_merge_planner",
    bare: true,
    model: CLAUDE_MAIN_MODEL,
    timeoutMs: 90_000,
  });
  const ops = normalizeMemoryOps(planRaw?.ops || []);
  if (!ops.length) log("⚠️", `memory planner returned no ops for ${candidates.length} candidates`);
  const applied = applyMemoryOps(userId, profile, ops, "auto");
  if (applied.length) log("\u{1F9E0}", `memory updated: ${applied.map(x => x.op).join(",")}`);
  return applied;
}

// ─── KILL PROCESS TREE (Windows) ─────────────────────────────
function killProc(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /T /F /PID ${proc.pid}`, { timeout: 5000, windowsHide: true });
    } else {
      proc.kill("SIGTERM");
    }
  } catch {
    // process may have already exited — ignore.
  }
}

// ─── PROCESS ONE TURN (streaming) ────────────────────────────
// Returns the AI session ID reported by the CLI (CC session_id or Codex thread_id)
// plus whether the turn completed with a normal assistant reply.
async function processTurn(ai, userId, sid, sessionName, body, contextToken, firstTurn, onProc, styleState, failedTurn = null) {
  const turnStarted = Date.now();
  const turnProfile = sessionProfile(styleState);
  const prefix = replyPrefix(sessionName, ai);
  const stylePrompt = buildStableStylePrompt();
  const memoryPrompt = renderMemoryPrompt(userId, { profile: turnProfile });
  log("\u{1F4E4}", `[${ai}] [${sessionName}] ${body.slice(0, 80)}`);

  // ── log files ──
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeName = sessionName.replace(/[<>:"/\\|?*]/g, "_");
  const logBase = path.join(LOGS_DIR, `${ai}-${safeName}-${ts}`);
  const jsonlPath = logBase + ".jsonl";
  const fmtPath = logBase + ".txt";
  let logStream = null;
  let fmtStream = null;
  try { logStream = fs.createWriteStream(jsonlPath); } catch {}
  try { fmtStream = fs.createWriteStream(fmtPath); } catch {}
  function writeLog(line) { try { if (logStream) logStream.write(line + "\n"); } catch {} }
  function writeFmt(line) { try { if (fmtStream) fmtStream.write(line + "\n"); } catch {} }

  writeLog(JSON.stringify({ type: "user_message", ai, body, timestamp: new Date().toISOString() }));
  writeFmt(`=== ${ai} Session: ${sessionName} ===`);
  writeFmt(`Time: ${new Date().toLocaleString("zh-CN")}`);
  writeFmt(`User: ${body}\n`);

  const isProfileChat = Boolean(turnProfile && profileTemplates[turnProfile]);
  const carriedSceneState = sceneStateText(styleState);
  let sceneletResult = null;
  let sceneletError = "";
  if (isProfileChat) {
    try {
      sceneletResult = await generateSceneletForTurn({ userId, sess: styleState, profile: turnProfile, userBody: body, memoryPrompt });
      if (sceneletResult) {
        writeLog(JSON.stringify({
          type: "hidden_world",
          world_state_patch: sceneletResult.worldStatePatch,
          daily_share_candidates: sceneletResult.dailyShareCandidates,
          schedule_candidates: sceneletResult.scheduleCandidates,
          time_reasoning: sceneletResult.timeReasoning,
          continuity_warnings: sceneletResult.continuityWarnings,
          usage: sceneletResult.hiddenCall,
          timestamp: new Date().toISOString(),
        }));
        writeLog(JSON.stringify({
          type: "inner_scenelet",
          inner_scenelet: sceneletResult.innerScenelet,
          next_scene_state: sceneletResult.nextSceneState,
          life_arc_ops: sceneletResult.lifeArcOps,
          proactive_candidates: sceneletResult.proactiveCandidates,
          tool_usage: sceneletResult.toolUsage,
          hidden_usage: sceneletResult.hiddenCall,
          timestamp: new Date().toISOString(),
        }));
      } else {
        sceneletError = "hidden scenelet returned no usable inner_scenelet";
        writeLog(JSON.stringify({
          type: "inner_scenelet_missing",
          reason: sceneletError,
          timestamp: new Date().toISOString(),
        }));
      }
    } catch (e) {
      sceneletError = e.message || "scenelet failed";
      writeLog(JSON.stringify({
        type: "inner_scenelet_missing",
        reason: sceneletError,
        timestamp: new Date().toISOString(),
      }));
      log("⚠️", `scenelet skipped: ${e.message}`);
    }
  }

  let textBuf = "";
  let lastFlush = Date.now();
  let lastSent = "";

  async function flush(force, isFinal) {
    const t = (isProfileChat ? sanitizeVisibleReplyText(textBuf) : String(textBuf || "")).trim();
    if (!t || t === lastSent) { textBuf = ""; return true; }
    if (!force && t.length < 300 && Date.now() - lastFlush < 3000) return true;
    const socialParts = isFinal && isProfileChat ? splitSocialReply(t) : [t];
    const messages = [];
    for (let i = 0; i < socialParts.length; i++) {
      const head = i === 0 ? `# ${prefix}\n` : "";
      const tail = isFinal && i === socialParts.length - 1 ? "/" : "";
      messages.push(...splitText(`${head}${socialParts[i]}${tail}`, MAX_REPLY_LEN));
    }
    let sentOk = true;
    for (const chunk of messages) {
      const ok = await sendMessage(userId, chunk, contextToken);
      if (!ok) sentOk = false;
      if (messages.length > 1) await sleep(450);
    }
    textBuf = "";
    // Only mark as sent if all chunks succeeded; otherwise allow retry
    if (sentOk) lastSent = t;
    lastFlush = Date.now();
    return sentOk;
  }

  let hasOutput = false;
  let newSid = sid;
  let assistantFullText = "";
  let turnCompleted = false;
  let turnSucceeded = false;
  let explicitFailure = false;
  let failureMessage = "";
  const turnToolUsage = emptyToolUsage();
  let turnRagUsage = null;

  try {
  if (ai === "codex") {
    // ─── Codex event handling ───
    function handleCodexEvent(evt) {
      writeLog(JSON.stringify(evt));

      if (evt.type === "thread.started" && evt.thread_id) {
        newSid = evt.thread_id;
        writeFmt(`[thread.started] thread_id=${evt.thread_id}`);
        return;
      }
      if (evt.type === "turn.started") {
        writeFmt(`[turn.started]`);
        return;
      }
      if (evt.type === "item.started" && evt.item) {
        const itype = evt.item.type;
        if (itype === "command_execution" || itype === "function_call") {
          const name = evt.item.name || itype;
          markToolUsage(turnToolUsage, name);
          const input = evt.item.args ? JSON.stringify(evt.item.args).slice(0, 200) : "";
          log("\u{1F527}", `[${sessionName}] ${name} ${input}`);
          writeFmt(`\n--- Tool: ${name} ---`);
          writeFmt(`Args: ${JSON.stringify(evt.item.args, null, 2)}`);
          flush(false, false).catch(() => {});
        }
        return;
      }
      if (evt.type === "item.completed" && evt.item) {
        const itype = evt.item.type;
        if (itype === "agent_message" && evt.item.text) {
          textBuf += evt.item.text;
          assistantFullText += evt.item.text;
          hasOutput = true;
        }
        if (itype === "reasoning" && evt.item.text) {
          writeFmt(`\n--- Thinking ---`);
          writeFmt(evt.item.text.slice(0, 2000));
        }
        if (itype === "command_execution" || itype === "function_call") {
          const output = evt.item.output ? JSON.stringify(evt.item.output).slice(0, 2000) : "(empty)";
          writeFmt(`Result: ${output}`);
        }
        if (textBuf.length > (turnProfile ? 800 : 300)) {
          flush(false, false).catch(() => {});
        }
        return;
      }
      if (evt.type === "turn.completed") {
        turnCompleted = true;
        const finalToolUsage = toolUsageFromUsage(evt.usage);
        turnToolUsage.webSearch = Math.max(turnToolUsage.webSearch, finalToolUsage.webSearch);
        turnToolUsage.webFetch = Math.max(turnToolUsage.webFetch, finalToolUsage.webFetch);
        for (const tool of finalToolUsage.tools) {
          if (!turnToolUsage.tools.includes(tool)) turnToolUsage.tools.push(tool);
        }
        if (evt.usage) {
          writeFmt(`\n[usage] input=${evt.usage.input_tokens} output=${evt.usage.output_tokens}`);
        }
        writeFmt(`\n=== completed ===`);
        return;
      }
      if (evt.type === "turn.failed") {
        const errMsg = evt.error?.message || JSON.stringify(evt.error || evt);
        explicitFailure = true;
        failureMessage = errMsg;
        writeFmt(`\n=== FAILED ===\n${errMsg}`);
        return;
      }
    }

    const profile = turnProfile;
    const pinnedProfileRules = loadPinnedProfileRules(profile);
    const useRagCdx = RAG_ENABLED && !hasInboundAttachment(body) && profile && profile !== "默认" && profileTemplates[profile] && shouldUseRagForTurn(body, profile);
    const ragContext = useRagCdx ? queryRag(body, profile) : null;
    turnRagUsage = { eligible: Boolean(useRagCdx), used: Boolean(ragContext), chars: ragContext?.length || 0 };
    const sceneContext = isProfileChat ? buildSceneContextBlock(styleState, sceneletResult, carriedSceneState) : "";
    const turnBody = buildTurnBody(body, null, sceneContext, memoryPrompt);
    writeLog(JSON.stringify({
      type: "turn_context",
      backend: "codex",
      memoryChars: memoryPrompt.length,
      profileRuleChars: pinnedProfileRules.length,
      ragChars: ragContext?.length || 0,
      transientBodyChars: turnBody.length,
      dynamicMemoryChars: memoryPrompt.length,
      stableSystemChars: stylePrompt.length + pinnedProfileRules.length + (profile && profileTemplates[profile] ? profileTemplates[profile].length : 0),
      timestamp: new Date().toISOString(),
    }));
    const task = runCodexStream(ai, sid, sessionName, turnBody, firstTurn, handleCodexEvent, ragContext, stylePrompt, memoryPrompt, profile, {
      noSessionPersistence: isProfileChat,
    });
    if (onProc) onProc(task.proc);

    let { code, stderr, killed } = await task;

    for (let retry = 0; retry < SESSION_LOCK_RETRIES && !killed && code !== 0 && !hasOutput; retry++) {
      if (!stderr.includes("already in use") && !stderr.includes("timeout")) break;
      log("\u{1F501}", `[${sessionName}] retry ${retry + 1}/${SESSION_LOCK_RETRIES}...`);
      await sleep(SESSION_LOCK_RETRY_MS);
      hasOutput = false; textBuf = ""; lastSent = ""; lastFlush = Date.now();
      assistantFullText = ""; turnCompleted = false; explicitFailure = false; failureMessage = "";
      writeFmt(`\n--- Retry ${retry + 1} ---`);
      const retryTask = runCodexStream(ai, newSid || sid, sessionName, turnBody, firstTurn, handleCodexEvent, ragContext, stylePrompt, memoryPrompt, profile, {
        noSessionPersistence: isProfileChat,
      });
      if (onProc) onProc(retryTask.proc);
      ({ code, stderr, killed } = await retryTask);
    }

    turnSucceeded = !killed && code === 0 && turnCompleted && assistantFullText.trim().length > 0 && !explicitFailure;
    await flush(true, turnSucceeded);

    if (killed) {
      failureMessage = "cancelled";
      await sendMessage(userId, `# ${prefix}\n⏹️ 已取消`, contextToken);
      writeFmt("\n=== CANCELLED ===");
    } else if (!turnSucceeded) {
      failureMessage ||= explicitFailure ? "Codex turn failed" : `Codex exited ${code}`;
      const details = explicitFailure ? failureMessage : stderr.slice(0, 500);
      await sendMessage(userId, `# ${prefix}\n❌ ${failureMessage}${details && details !== failureMessage ? `\n${details}` : ""}`, contextToken);
      writeFmt(`\n=== ERROR exit ${code} ===\n${stderr.slice(0, 500)}`);
    }
  } else {
    // ─── Claude Code event handling ───
    function handleClaudeEvent(evt) {
      writeLog(JSON.stringify(evt));

      if (evt.type === "system" && evt.session_id) {
        newSid = evt.session_id;
        writeFmt(`[system] session_id=${evt.session_id}`);
        return;
      }
      if (evt.type === "assistant" && evt.message?.content) {
        let hasTool = false;
        for (const block of evt.message.content) {
          if (block.type === "text" && block.text) {
            textBuf += block.text;
            assistantFullText += block.text;
            hasOutput = true;
          }
          if (block.type === "tool_use") {
            hasTool = true;
            const name = block.name || "unknown";
            markToolUsage(turnToolUsage, name);
            const input = block.input ? JSON.stringify(block.input).slice(0, 200) : "";
            log("\u{1F527}", `[${sessionName}] ${name} ${input}`);
            writeFmt(`\n--- Tool: ${name} ---`);
            writeFmt(`Input: ${JSON.stringify(block.input, null, 2)}`);
          }
          if (block.type === "thinking" && block.thinking) {
            writeFmt(`\n--- Thinking ---`);
            writeFmt(block.thinking.slice(0, 2000));
          }
        }
        if (hasTool || textBuf.length > (turnProfile ? 800 : 300)) {
          flush(false, false).catch(() => {});
        }
      }
      if (evt.type === "tool_result") {
        writeFmt(`Result: ${JSON.stringify(evt).slice(0, 2000)}`);
      }
      if (evt.type === "result") {
        if (evt.subtype === "success") {
          turnCompleted = true;
        } else {
          explicitFailure = true;
          failureMessage = `${evt.subtype || "failed"}${evt.result ? `: ${evt.result}` : ""}`;
        }
        const finalToolUsage = toolUsageFromUsage(evt.usage);
        turnToolUsage.webSearch = Math.max(turnToolUsage.webSearch, finalToolUsage.webSearch);
        turnToolUsage.webFetch = Math.max(turnToolUsage.webFetch, finalToolUsage.webFetch);
        for (const tool of finalToolUsage.tools) {
          if (!turnToolUsage.tools.includes(tool)) turnToolUsage.tools.push(tool);
        }
        writeFmt(`\n=== ${evt.subtype || "completed"} ===`);
        if (evt.result) writeFmt(`Result: ${JSON.stringify(evt.result).slice(0, 1000)}`);
      }
    }

    const profile = turnProfile;
    const pinnedProfileRules = loadPinnedProfileRules(profile);
    const useRag = RAG_ENABLED && !hasInboundAttachment(body) && profile && profile !== "默认" && profileTemplates[profile] && shouldUseRagForTurn(body, profile);
    const ragContext = useRag ? queryRag(body, profile) : null;
    turnRagUsage = { eligible: Boolean(useRag), used: Boolean(ragContext), chars: ragContext?.length || 0 };
    const sceneContext = isProfileChat ? buildSceneContextBlock(styleState, sceneletResult, carriedSceneState) : "";
    const claudeBody = buildTurnBody(body, ragContext, sceneContext, memoryPrompt);
    writeLog(JSON.stringify({
      type: "turn_context",
      backend: "claude_stream",
      memoryChars: memoryPrompt.length,
      profileRuleChars: pinnedProfileRules.length,
      ragChars: ragContext?.length || 0,
      transientBodyChars: claudeBody.length,
      dynamicMemoryChars: memoryPrompt.length,
      stableSystemChars: stylePrompt.length + pinnedProfileRules.length + (profile && profileTemplates[profile] ? profileTemplates[profile].length : 0),
      timestamp: new Date().toISOString(),
    }));
    const task = runClaudeStream(ai, sid, sessionName, claudeBody, firstTurn, handleClaudeEvent, stylePrompt, memoryPrompt, profile, {
      routingBody: body,
    });
    if (onProc) onProc(task.proc);

    let { code, stderr, killed } = await task;

    for (let retry = 0; retry < SESSION_LOCK_RETRIES && !killed && code !== 0 && (stderr.includes("already in use") || stderr.includes("timeout")); retry++) {
      log("\u{1F501}", `[${sessionName}] session lock, retry ${retry + 1}/${SESSION_LOCK_RETRIES}...`);
      await sleep(SESSION_LOCK_RETRY_MS);
      hasOutput = false; textBuf = ""; lastSent = ""; lastFlush = Date.now();
      assistantFullText = ""; turnCompleted = false; explicitFailure = false; failureMessage = "";
      writeFmt(`\n--- Retry ${retry + 1} ---`);
      const retryTask = runClaudeStream(ai, newSid || sid, sessionName, claudeBody, firstTurn, handleClaudeEvent, stylePrompt, memoryPrompt, profile, {
        routingBody: body,
      });
      if (onProc) onProc(retryTask.proc);
      ({ code, stderr, killed } = await retryTask);
    }

    turnSucceeded = !killed && code === 0 && turnCompleted && assistantFullText.trim().length > 0 && !explicitFailure;
    await flush(true, turnSucceeded);

    if (killed) {
      failureMessage = "cancelled";
      await sendMessage(userId, `# ${prefix}\n⏹️ 已取消`, contextToken);
      writeFmt("\n=== CANCELLED ===");
    } else if (!turnSucceeded) {
      failureMessage ||= explicitFailure ? "CC turn failed" : `CC exited ${code}`;
      const details = explicitFailure ? failureMessage : stderr.slice(0, 500);
      await sendMessage(userId, `# ${prefix}\n❌ ${failureMessage}${details && details !== failureMessage ? `\n${details}` : ""}`, contextToken);
      writeFmt(`\n=== ERROR exit ${code} ===\n${stderr.slice(0, 500)}`);
    }
  }

  writeFmt(`\n=== End ===`);
  if (turnSucceeded && isProfileChat) assistantFullText = sanitizeVisibleReplyText(assistantFullText);
  if (turnSucceeded && styleState && assistantFullText) {
    rememberRecentKaomoji(styleState, assistantFullText);
  }
  if (turnSucceeded && styleState) {
    const userAt = new Date(turnStarted).toISOString();
    const assistantAt = new Date().toISOString();
    styleState._lastUserAt = userAt;
    styleState._lastAssistantAt = assistantAt;
    styleState._lastContextToken = contextToken || styleState._lastContextToken || null;
    appendVisibleHistory(styleState, "user", body, "chat", userAt);
    appendVisibleHistory(styleState, "assistant", assistantFullText.trim(), "chat", assistantAt);
    const roleWorld = isProfileChat ? getRoleWorld(turnProfile) : null;
    if (sceneletResult?.nextSceneState) {
      setSceneStateFromText(styleState, sceneletResult.nextSceneState);
      if (roleWorld) roleWorld._sceneState = normalizeSceneState(styleState._sceneState);
    }
    if (roleWorld) {
      applyLifeArcOps(roleWorld, sceneletResult?.lifeArcOps);
      roleWorld.updatedAt = assistantAt;
      syncRoleWorldToSession(styleState, turnProfile);
      saveRoleWorlds();
    } else {
      applyLifeArcOps(styleState, sceneletResult?.lifeArcOps);
    }
    await addProactiveCandidates(styleState, sceneletResult, body);
    recordChatHistory({ ai, userId, sess: styleState, role: "user", kind: "chat", text: body, timestamp: userAt });
    recordChatHistory({
      ai,
      userId,
      sess: styleState,
      role: "assistant",
      kind: "chat",
      text: assistantFullText.trim(),
      scenelet: sceneletResult?.innerScenelet || "",
      sceneState: sceneletResult?.nextSceneState || "",
      sceneletStatus: isProfileChat ? (sceneletResult?.innerScenelet ? "ok" : "missing") : "not_applicable",
      sceneletError,
      toolUsage: mergeToolUsage(sceneletResult?.toolUsage, turnToolUsage),
      ragUsage: turnRagUsage,
      timestamp: assistantAt,
    });
  }
  if (turnSucceeded) {
    try {
      await updateUserMemoryFromTurn(userId, body, turnProfile);
      const notice = memoryMaintenanceNotice(userId, { profile: turnProfile, mark: true });
      if (notice) await sendMessage(userId, notice, contextToken);
    } catch (e) {
      log("⚠️", `memory writer skipped: ${e.message}`);
    }
  } else {
    log("⚠️", `[${ai}] [${sessionName}] turn failed before normal reply; user message kept out of completed context`);
  }
  log("\u{23F1}", `[${ai}] [${sessionName}] turn done in ${Date.now() - turnStarted}ms`);
  } finally {
    try { if (logStream) logStream.end(); } catch {}
    try { if (fmtStream) fmtStream.end(); } catch {}
  }

  return { sid: newSid, ok: turnSucceeded, error: failureMessage };
}

// ─── SESSION LOOP ──────────────────────────────────────────
async function sessionLoop(ai, userId, sessionId) {
  const sMap = sessionMap(ai);
  const u = sMap.get(userId);
  if (!u) return;
  const sess = u.list.find(s => s.id === sessionId);
  if (!sess) return;

  while (true) {
    if (sess._closing && sess.queue.length === 0) {
      const idx = u.list.indexOf(sess);
      if (idx >= 0) { u.list.splice(idx, 1); saveSessions(); }
      return;
    }
    if (sess.queue.length === 0) {
      sess.busy = false;
      sess._proc = null;
      return;
    }
    if (sess._lastEnd) {
      const waitMs = SESSION_RELEASE_GRACE_MS - (Date.now() - sess._lastEnd);
      if (waitMs > 0) await sleep(waitMs);
    }
    const item = sess.queue.shift();
    if (sess._proc) {
      killProc(sess._proc);
      sess._proc = null;
      await sleep(500);
    }
    try {
      const result = await processTurn(ai, userId, sess.sid, sess.name, item.body, item.ctx, sess._firstTurn, (proc) => { sess._proc = proc; }, sess, sess._lastFailedTurn);
      if (result.ok) {
        if (result.sid) sess.sid = result.sid;
        sess._firstTurn = false;
        sess._lastFailedTurn = null;
      } else {
        if (sess._firstTurn) sess.sid = uuid();
        sess._lastFailedTurn = {
          body: item.body,
          timestamp: new Date().toISOString(),
          reason: result.error || "turn failed before normal reply",
          sid: result.sid || sess.sid,
        };
      }
      saveSessions();
    } catch (e) {
      log("❌", `[${sess.name}] error: ${e.message}`);
      await sendMessage(userId, `# ${replyPrefix(sess.name, ai)}\n❌ ${e.message}`, item.ctx);
      sess._lastFailedTurn = {
        body: item.body,
        timestamp: new Date().toISOString(),
        reason: e.message,
        sid: sess.sid,
      };
      saveSessions();
    }
    sess._lastEnd = Date.now();
    sess._proc = null;
  }
}

function queueTurn(messageAI, userId, body, ctx, sessionId = null) {
  const sess = sessionId ? sessionById(messageAI, userId, sessionId) : activeSession(userId, messageAI);
  if (!sess || sess._closing) return;

  log("\u{1F4E9}", `[${messageAI}] [${sess.name}] ${userId}: ${body.slice(0, 80)}`);

  sess._lastUserAt = new Date().toISOString();
  sess._lastContextToken = ctx || sess._lastContextToken || null;
  sess.queue.push({ body, ctx });

  if (!sess.busy) {
    sess.busy = true;
    sessionLoop(messageAI, userId, sess.id);
  }
}

function enqueueUserBody(messageAI, userId, body, ctx, opts = {}) {
  if (isDuplicateInput(userId, body)) {
    log("\u{1F501}", `duplicate ignored: ${userId}: ${body.slice(0, 80)}`);
    return;
  }

  const sess = activeSession(userId, messageAI);
  const existing = pendingInputs.get(userId);

  if (opts.shouldBatch) {
    if (existing) flushPendingInput(userId);
  } else if (existing) {
    if (opts.canAppendToBatch && existing.ai === messageAI && existing.sessionId === sess?.id) {
      existing.parts.push(body);
      existing.ctx = ctx || existing.ctx;
      return;
    }
    flushPendingInput(userId);
    queueTurn(messageAI, userId, body, ctx);
    return;
  } else {
    queueTurn(messageAI, userId, body, ctx);
    return;
  }

  const pending = {
    ai: messageAI,
    sessionId: sess?.id || null,
    ctx,
    parts: [body],
    timer: null,
  };
  pending.timer = setTimeout(() => flushPendingInput(userId), INPUT_BATCH_MS);
  pendingInputs.set(userId, pending);
}

function flushPendingInput(userId) {
  const pending = pendingInputs.get(userId);
  if (!pending) return;
  pendingInputs.delete(userId);
  const body = pending.parts.join("\n\n").trim();
  if (body) queueTurn(pending.ai, userId, body, pending.ctx, pending.sessionId);
}

function clearPendingInput(userId) {
  const pending = pendingInputs.get(userId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingInputs.delete(userId);
  return true;
}

async function handleMemoryCommand(userId, body, ctx, activeProfile) {
  const rest = body.replace(/^\/memory\s*/i, "").trim();
  const help = [
    "Memory commands:",
    "/memory                  查看当前角色统计和每类前 3 条",
    "/memory all              查看当前角色完整 memory",
    "/memory 性格|偏好|事实   只查看某一类",
    "/memory <角色名>         查看指定角色的 memory",
  ].join("\n");

  // determine which profile to show
  let targetProfile = activeProfile;
  let lookedUpRole = false;
  if (rest && rest !== "all" && !["性格", "偏好", "事实"].includes(rest)) {
    if (profileTemplates[rest]) {
      targetProfile = rest;
      lookedUpRole = true;
    } else {
      const match = Object.keys(profileTemplates).find(k => k.includes(rest) || rest.includes(k));
      if (match) { targetProfile = match; lookedUpRole = true; }
    }
  }

  const isOtherRole = targetProfile !== activeProfile;
  const label = isOtherRole ? `角色: ${targetProfile}` : "";

  if (!rest || lookedUpRole) {
    const notice = memoryMaintenanceNotice(userId, { profile: targetProfile });
    const text = [label, memoryListText(userId, { profile: targetProfile }), notice].filter(Boolean).join("\n\n");
    await sendMessage(userId, text, ctx);
    return;
  }
  if (rest === "all") {
    const notice = memoryMaintenanceNotice(userId, { profile: targetProfile });
    const text = [label, memoryListText(userId, { profile: targetProfile, full: true }), notice].filter(Boolean).join("\n\n");
    await sendMessage(userId, text, ctx);
    return;
  }

  const category = ["性格", "偏好", "事实"].includes(rest) ? normalizeMemoryCategory(rest) : null;
  if (category) {
    const text = [label, memoryListText(userId, { profile: targetProfile, category, full: true })].filter(Boolean).join("\n\n");
    await sendMessage(userId, text, ctx);
    return;
  }

  // show help when rest doesn't match any profile or category
  await sendMessage(userId, help, ctx);
}

// ─── MESSAGE HANDLER ───────────────────────────────────────
async function handleMessage(msg) {
  const userId = msg.from_user_id;
  const ctx = msg.context_token;

  const payload = await extractInboundPayload(msg);
  let body = payload.body;
  if (!body.trim()) return;

  const messageAI = activeAI;
  const activeSess = activeSession(userId, messageAI);
  const prefix = replyPrefix(activeSess?.name || "S1", messageAI);
  const isCommand = /^\/\S+/.test(body);
  if (isCommand && !/^\/cancel$/.test(body)) {
    flushPendingInput(userId);
  }

  // ── /help ──
  if (/^\/help$/.test(body)) {
    await sendMessage(userId, [
      `# 帮助`,
      ``,
      `【AI 切换】`,
      `/cc                 切换到 Claude Code`,
      `/codex              切换到 Codex`,
      ``,
      `【线程管理】`,
      `/new [名称]         创建新会话线程`,
      `/rename [序号|名称] <新名称>  重命名线程`,
      `/switch [序号|名称]  切换活跃线程`,
      `/sessions           查看所有线程`,
      `/close [序号|名称]   关闭线程 (排空中)`,
      `/cancel             取消当前运行的任务`,
      `/memory             查看当前角色 memory 统计和每类前 3 条`,
      `/memory all         查看当前角色完整 memory`,
      `/memory 性格|偏好|事实 查看当前角色某一类 memory`,
      `/memory <角色名>     查看指定角色的 memory`,
      `/status             查看当前状态`,
      ``,
      `【角色管理】`,
      `/profile                     查看所有角色`,
      `/profile <名称>              切换到指定角色`,
      `/profile off                 关闭角色，恢复默认`,
      ``,
      `当前 AI: ${activeAI === "cc" ? "Claude Code" : "Codex"}`,
    ].join("\n"), ctx);
    return;
  }

  // ── /memory ──
  if (/^\/memory(\s|$)/i.test(body)) {
    await handleMemoryCommand(userId, body, ctx, activeSess?._profile ?? null);
    return;
  }

  // ── /cc ──
  if (/^\/cc$/.test(body)) {
    if (activeAI === "cc") { await sendMessage(userId, "⚠️ 当前已是 Claude Code", ctx); return; }
    setActiveAI("cc");
    saveSessions(); saveToken();
    await sendMessage(userId, `✅ 已切换到 Claude Code`, ctx);
    return;
  }

  // ── /codex ──
  if (/^\/codex$/.test(body)) {
    if (activeAI === "codex") { await sendMessage(userId, "⚠️ 当前已是 Codex", ctx); return; }
    setActiveAI("codex");
    saveSessions(); saveToken();
    await sendMessage(userId, `✅ 已切换到 Codex`, ctx);
    return;
  }

  // ── /new ──
  if (/^\/new(\s|$)/.test(body)) {
    let rest = body.slice(5).trim();
    const name = rest || nextSessionName(userId, messageAI);
    if (hasSessionName(userId, name, null, messageAI)) {
      await sendMessage(userId, `⚠️ 线程名 "${name}" 已存在，请换一个名称`, ctx);
      return;
    }
    const boundProfile = name === "默认" ? null : (profileTemplates[name] && name !== "默认" ? name : null);
    const u = ensureUser(userId);
    const sess = makeSession(name, boundProfile);
    u.list.push(sess);
    u.activeId = sess.id;
    saveSessions();
    await sendMessage(userId, `✅ 新线程: ${name}${boundProfile ? `\n角色: ${boundProfile}` : ""}`, ctx);
    return;
  }

  // ── /switch ──
  if (/^\/switch(\s|$)/.test(body)) {
    const key = body.slice(8).trim();
    if (!key) { await sendMessage(userId, `线程:\n${sessionsListText(userId)}`, ctx); return; }
    const sess = findSession(userId, key);
    if (!sess) { await sendMessage(userId, `⚠️ 未找到 "${key}"\n${sessionsListText(userId)}`, ctx); return; }
    ensureUser(userId).activeId = sess.id;
    saveSessions();
    await sendMessage(userId, `✅ 已切换: ${sess.name}`, ctx);
    return;
  }

  // ── /rename ──
  if (/^\/rename(\s|$)/.test(body)) {
    const rest = body.slice(8).trim();
    if (!rest) { await sendMessage(userId, "用法: /rename <新名称>  重命名当前线程\n/rename [序号|名称] <新名称>  重命名指定线程", ctx); return; }
    const tokens = rest.split(/\s+/);
    // If first token is a thread reference (number or existing name) and there's more, treat as "old new"
    const first = tokens[0];
    const numIdx = parseInt(first);
    const u = ensureUser(userId);
    const isNumRef = Number.isInteger(numIdx) && numIdx >= 1 && numIdx <= u.list.length;
    const isNameRef = u.list.some(s => s.name === first || s.name.includes(first));
    let key, newName;
    if ((isNumRef || isNameRef) && tokens.length >= 2) {
      key = first;
      newName = tokens.slice(1).join(" ");
    } else {
      newName = rest;
    }
    if (!newName) { await sendMessage(userId, "⚠️ 新名称不能为空", ctx); return; }
    let target;
    if (key) {
      target = findSession(userId, key);
      if (!target) { await sendMessage(userId, `⚠️ 未找到 "${key}"`, ctx); return; }
    } else {
      target = activeSession(userId);
    }
    if (hasSessionName(userId, newName, target.id, messageAI)) {
      await sendMessage(userId, `⚠️ 线程名 "${newName}" 已存在，重命名失败`, ctx);
      return;
    }
    target.name = newName;
    saveSessions();
    await sendMessage(userId, `✅ 已重命名: ${newName}`, ctx);
    return;
  }

  // ── /sessions ──
  if (/^\/sessions$/.test(body)) {
    await sendMessage(userId, `线程 (${activeAI === "cc" ? "Claude Code" : "Codex"}):\n${sessionsListText(userId)}`, ctx);
    return;
  }

  // ── /profile ──
  if (/^\/profile(\s|$)/.test(body)) {
    const rest = body.slice(9).trim();

    if (!rest) {
      const cur = sessionProfile(activeSession(userId));
      const list = Object.entries(profileTemplates)
        .map(([k, v]) => `${k === cur ? "→" : " "} ${k}: ${v.slice(0, 40)}...`)
        .join("\n");
      const aiLabel = activeAI === "cc" ? "Claude Code" : "Codex";
      const sess = activeSession(userId);
      const current = [
        `AI: ${aiLabel}`,
        `线程: ${sess.name}`,
        `角色: ${cur || "默认"}`,
      ].join("\n");
      await sendMessage(userId, `${current}\n\n模板:\n${list}\n\n/profile 名字 切换\n/profile off 关闭`, ctx);
      return;
    }
    if (rest === "off" || rest === "关闭" || rest === "默认") {
      const sess = activeSession(userId);
      if (sess._profile) {
        await sendMessage(userId, `⚠️ 当前线程已绑定角色「${sess._profile}」，不能切回默认。\n请用 /new 默认 新建默认线程，或 /switch 切到其他默认线程。`, ctx);
        return;
      }
      await sendMessage(userId, `✅ 当前线程保持默认风格`, ctx);
      return;
    }
    if (!profileTemplates[rest]) {
      await sendMessage(userId, `⚠️ 未找到 "${rest}"。\n可用: ${Object.keys(profileTemplates).join(", ")}`, ctx);
      return;
    }
    const sess = activeSession(userId);
    if (sess._profile && sess._profile !== rest) {
      await sendMessage(userId, `⚠️ 当前线程已绑定角色「${sess._profile}」，不能切换成「${rest}」。\n请先 /new ${rest} 新建线程，再 /profile ${rest}。`, ctx);
      return;
    }
    sess._profile = rest;
    saveSessions();
    await sendMessage(userId, `✅ 当前线程已绑定角色: ${rest}${sess._firstTurn ? "" : "\n提示：这个线程已有历史上下文；如果仍有旧口吻残留，请用 /new " + rest + " 新开线程。"}`, ctx);
    return;
  }

  // ── /close ──
  if (/^\/close(\s|$)/.test(body)) {
    const key = body.slice(7).trim();
    const u = ensureUser(userId);
    let target;
    if (key) {
      target = findSession(userId, key);
      if (!target) { await sendMessage(userId, `⚠️ 未找到 "${key}"`, ctx); return; }
    } else {
      target = activeSession(userId);
    }
    if (target.busy) { await sendMessage(userId, `⚠️ ${target.name} 正在运行，请等任务完成后再关闭`, ctx); return; }
    // Clear pending input bound to this session
    const pending = pendingInputs.get(userId);
    let clearedPending = false;
    if (pending && pending.ai === activeAI && pending.sessionId === target.id) {
      clearPendingInput(userId);
      clearedPending = true;
    }

    const targetIdx = u.list.indexOf(target);
    const closedName = target.name;
    target._closing = true;

    if (target.queue.length === 0) {
      u.list.splice(targetIdx, 1);
    }

    // When only one thread left, auto-create a new default thread
    let autoCreated = null;
    if (u.list.length === 0) {
      const newName = nextSessionName(userId);
      const newSess = makeSession(newName);
      u.list.push(newSess);
      u.activeId = newSess.id;
      autoCreated = newName;
    } else if (u.activeId === target.id) {
      // Switch to the thread before the closed one, or the first one
      const prevIdx = Math.max(0, targetIdx - 1);
      u.activeId = u.list[Math.min(prevIdx, u.list.length - 1)].id;
    }
    saveSessions();

    const nowActive = u.list.find(s => s.id === u.activeId);
    const nowName = nowActive ? nowActive.name : "?";
    const parts = [`✅ 已关闭 ${closedName}`];
    if (autoCreated) parts.push(`已自动创建新线程: ${autoCreated}`);
    if (clearedPending) parts.push("已清除该线程的待处理附件");
    parts.push(`当前线程: ${nowName}`);
    await sendMessage(userId, parts.join("\n"), ctx);
    return;
  }

  // ── /status ──
  if (/^\/status$/.test(body)) {
    const u = ensureUser(userId);
    const sess = activeSession(userId);
    const idx = u.list.indexOf(sess) + 1;
    const otherAI = activeAI === "cc" ? "codex" : "cc";
    const otherMap = sessions[otherAI];
    const otherCount = otherMap ? Array.from(otherMap.values()).reduce((s, u) => s + u.list.length, 0) : 0;
    const profile = sessionProfile(sess);
    const status = sess.busy ? "⏳ 运行中" : sess.queue.length ? `排队 ${sess.queue.length}` : "空闲";
    await sendMessage(userId, [
      `# 状态`,
      ``,
      `AI:     ${activeAI === "cc" ? "Claude Code" : "Codex"}  (${modelNames[activeAI]})`,
      `会话:   [${idx}] ${sess.name}`,
      `角色:   ${profile || "默认"}`,
      `状态:   ${status}`,
      `SID:    ${sess.sid}`,
      ``,
      `${activeAI === "cc" ? "CC" : "Codex"} 线程数: ${u.list.length}  |  ${activeAI === "cc" ? "Codex" : "CC"} 线程数: ${otherCount}`,
    ].filter(line => line !== null).join("\n"), ctx);
    return;
  }

  // ── /cancel ──
  if (/^\/cancel$/.test(body)) {
    const sess = activeSession(userId);
    const clearedPending = clearPendingInput(userId);
    if (!sess?.busy) {
      await sendMessage(userId, clearedPending ? "⏹️ 已清除待处理的附件消息" : "⚠️ 当前没有运行中的任务", ctx);
      return;
    }
    if (sess._proc) {
      killProc(sess._proc);
      sess._proc = null;
    }
    sess.queue.length = 0;
    await sendMessage(userId, `# ${prefix}\n⏹️ 正在取消...${clearedPending ? "\n已清除待处理的附件消息" : ""}`, ctx);
    return;
  }

  // ── route to active session ──
  enqueueUserBody(messageAI, userId, body, ctx, { shouldBatch: payload.shouldBatch, canAppendToBatch: payload.canAppendToBatch });
}

// ─── STARTUP CHECK ─────────────────────────────────────────
function startupCheck() {
  const checks = [];
  const pass = (label, detail = "") => checks.push({ ok: true, label, detail });
  const warn = (label, detail = "") => checks.push({ ok: false, label, detail, critical: false });
  const fail = (label, detail = "") => checks.push({ ok: false, label, detail, critical: true });

  // Claude Code
  if (commandExists(CLAUDE)) {
    pass("Claude Code", CLAUDE);
  } else {
    fail("Claude Code", `${CLAUDE} 不存在`);
  }

  // Codex
  if (commandExists(CODEX)) {
    pass("Codex", CODEX);
  } else {
    warn("Codex", `${CODEX} 不存在 (Codex 功能将不可用)`);
  }

  // Python
  const py = spawnSync("python", ["--version"], { encoding: "utf8", timeout: 3000, windowsHide: true });
  if (py.status === 0) {
    pass("Python", (py.stdout || py.stderr || "").trim());
  } else {
    fail("Python", "python 命令不可用 (RAG / 文件提取将不可用)");
  }

  if (VOICE_ASR_ENABLED) {
    const wx = spawnSync(VOICE_WHISPERX_PYTHON, ["-m", "whisperx", "--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    if (wx.status === 0) {
      pass("Voice WhisperX", (wx.stdout || wx.stderr || VOICE_WHISPERX_PYTHON).trim().split(/\r?\n/)[0]);
    } else {
      warn("Voice WhisperX", `${VOICE_WHISPERX_PYTHON} is not available; WeChat voice fallback transcript will still be used`);
    }
  } else {
    warn("Voice WhisperX", "disabled");
  }

  // ffmpeg (optional)
  const ff = spawnSync("ffmpeg", ["-version"], { encoding: "utf8", timeout: 3000, windowsHide: true });
  if (ff.status === 0) {
    pass("ffmpeg", "已安装");
  } else {
    warn("ffmpeg", "未找到 (视频首帧提取将不可用)");
  }

  // RAG index
  if (RAG_ENABLED) {
    const storeDir = resolveProjectPath(configValue("rag.storeDir", "data/rag_vector_store"));
    const metaPath = path.join(storeDir, "rag_meta.json");
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        pass("RAG 知识库", `${storeDir} (索引存在)`);
      } catch {
        warn("RAG 知识库", `${storeDir} (rag_meta.json 解析失败，可运行 scripts\\rebuild-rag.bat 重建)`);
      }
    } else {
      warn("RAG 知识库", `${storeDir} (索引不存在，请运行 scripts\\rebuild-rag.bat 初始化)`);
    }
  }

  // Vision handling
  if (shouldUseExternalVision()) {
    if (hasExternalVisionConfig()) {
      pass("视觉模式", `${VISION_MODE} -> external: ${VISION_MODEL} @ ${VISION_BASE_URL}`);
    } else {
      warn("视觉模式", `${VISION_MODE}: 外部视觉 API 未完整配置，将仅传递本地媒体路径`);
    }
  } else if (VISION_MODE === "off" || VISION_MODE === "none") {
    warn("视觉模式", "off (仅保存媒体路径，不生成视觉描述)");
  } else {
    pass("视觉模式", `${VISION_MODE || "native"} (交给 AI 后端读取本地媒体路径)`);
  }

  // node_modules
  if (fs.existsSync(appPath("node_modules", "qrcode-terminal"))) {
    pass("Node 依赖", "qrcode-terminal 已安装");
  } else {
    warn("Node 依赖", "qrcode-terminal 未安装 (二维码终端显示将降级)");
  }

  // Print report
  process.stdout.write("\n");
  let criticalCount = 0;
  let warnCount = 0;
  for (const c of checks) {
    const flag = c.ok ? "  OK" : (c.critical ? "FAIL" : "WARN");
    process.stdout.write(`[${flag}] ${c.label}${c.detail ? ` — ${c.detail}` : ""}\n`);
    if (!c.ok && c.critical) criticalCount++;
    if (!c.ok && !c.critical) warnCount++;
  }

  if (criticalCount > 0) {
    process.stderr.write(`\n${criticalCount} 个严重问题：关键依赖缺失，bot 可能无法正常工作。请检查 data/config.json 中的路径配置。\n`);
  }
  if (warnCount > 0) {
    process.stdout.write(`${warnCount} 个警告：部分功能将降级或不可用。\n`);
  }
  if (criticalCount === 0 && warnCount === 0) {
    process.stdout.write("全部自检通过。\n");
  }
  process.stdout.write("\n");
}

// ─── MAIN LOOP ─────────────────────────────────────────────
async function mainLoop() {
  let consecutiveFails = 0;
  let transientGetUpdatesFails = 0;
  let lastTransientGetUpdatesLog = 0;
  while (true) {
    try {
      const resp = await apiPost("ilink/bot/getupdates", { get_updates_buf: getUpdatesBuf || "" }, LONG_POLL_TIMEOUT_MS + 5000);
      if (resp.errcode === -14) { log("⏸️", "会话过期，5分钟后重试..."); await sleep(300_000); continue; }
      if (resp.ret && resp.ret !== 0) {
        consecutiveFails++;
        log("⚠️", `getupdates ret=${resp.ret} (${consecutiveFails}/3)`);
        if (consecutiveFails >= 3) { await sleep(30_000); consecutiveFails = 0; } else { await sleep(2000); }
        continue;
      }
      consecutiveFails = 0;
      transientGetUpdatesFails = 0;
      if (resp.get_updates_buf) { setSyncBuf(resp.get_updates_buf); saveToken(); }
      for (const m of (resp.msgs || [])) {
        if (m.message_type === 1 && m.from_user_id) await handleMessage(m);
      }
      await checkProactiveIntents();
    } catch (e) {
      if (isTransientGetUpdatesError(e)) {
        transientGetUpdatesFails++;
        const detail = e.cause?.code || e.cause?.message || e.name || "network";
        if (transientGetUpdatesFails >= 3) {
          const now = Date.now();
          if (now - lastTransientGetUpdatesLog > 60_000) {
            log("⚠️", `getupdates temporary network issue: ${detail} (${transientGetUpdatesFails} in a row)`);
            lastTransientGetUpdatesLog = now;
          }
          await sleep(5000);
        } else {
          await sleep(1000);
        }
        continue;
      }
      consecutiveFails++;
      const detail = e.cause?.code || e.cause?.message || e.name || "";
      log("❌", `getupdates: ${e.message}${detail ? ` (${detail})` : ""} (${consecutiveFails}/3)`);
      if (consecutiveFails >= 3) { await sleep(30_000); consecutiveFails = 0; } else { await sleep(2000); }
    }
  }
}

async function main() {
  // ─── CRASH GUARDS ────────────────────────────────────────────
  process.on("uncaughtException", (e) => { log("\u{1F4A5}", `uncaught: ${e.message}\n${e.stack?.slice(0, 300)}`); });
  process.on("unhandledRejection", (r) => { log("\u{1F4A5}", `unhandled rejection: ${r}`); });
  process.on("exit", releaseInstanceLock);
  process.on("SIGINT", () => { stopServer(); releaseInstanceLock(); process.exit(0); });
  process.on("SIGTERM", () => { stopServer(); releaseInstanceLock(); process.exit(0); });

  // ─── STARTUP ────────────────────────────────────────────────
  acquireInstanceLock();
  process.stdout.write("\nWeChat AI Bot\n=============\n");
  startupCheck();
  cleanupOldLogs();
  setInterval(cleanupOldLogs, LOG_CLEANUP_INTERVAL_MS).unref();

  // Restore last active AI before loading profiles (so profile display is correct).
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const d = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
      if (d.lastActiveAI === "cc" || d.lastActiveAI === "codex") setActiveAI(d.lastActiveAI);
    }
  } catch {}

  loadModelNames();
  loadProfiles();
  loadSessions();
  loadRoleWorlds();

  // ─── Start GUI server first ──────────────────────────────────
  registerStatusRoutes();
  registerSessionRoutes();
  registerProfileRoutes();
  registerConfigRoutes();
  registerHistoryRoutes();
  registerProactiveRoutes();
  registerMemoryRoutes();
  registerPromptsRoutes();
  registerWorldRoutes();
  startServer();

  // ─── WeChat login ────────────────────────────────────────────
  if (!loadToken()) {
    await loginWithQr();
  } else {
    try {
      const resp = await apiPost("ilink/bot/getupdates", { get_updates_buf: "" }, 10_000);
      if (resp.errcode === -14 || (resp.ret && resp.ret !== 0 && resp.errcode)) {
        log("⚠️", "Token 过期，重新登录..."); setToken(null); await loginWithQr();
      } else {
        if (resp.get_updates_buf) setSyncBuf(resp.get_updates_buf);
      }
    } catch {
      log("⚠️", "Token 验证失败，重新登录..."); setToken(null); await loginWithQr();
    }
  }

  log("\u{1F680}", `开始监听微信消息... (当前: ${activeAI === "cc" ? "Claude Code" : "Codex"})`);
  await mainLoop();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
