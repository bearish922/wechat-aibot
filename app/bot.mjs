import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
const CLAUDE_FAST_MODEL = envOrConfig("WECHAT_CLAUDE_FAST_MODEL", "models.claudeFast", "deepseek-v4-flash[1m]");
const CLAUDE_FALLBACK_MODEL = envOrConfig("WECHAT_CLAUDE_FALLBACK_MODEL", "models.claudeFallback", "deepseek-v4-flash[1m]");
const CLAUDE_TIMEOUT_MS = configNumber("timeouts.aiMs", 600_000);
const RAG_SCRIPT = resolveProjectPath(configValue("paths.ragScript", "app/rag.py"));
const RAG_ENABLED = configBool("rag.enabled", true);
const INPUT_BATCH_MS = 30_000;
const DUPLICATE_INPUT_MS = 5000;
const SESSION_LOCK_RETRIES = 3;
const SESSION_LOCK_RETRY_MS = 2_000;
const SESSION_RELEASE_GRACE_MS = 800;
const TOKEN_FILE = dataPath("wechat-token.json");
const PROFILE_FILE = rootPath("wechat-profiles.json");
const SESSION_FILE = dataPath("wechat-sessions.json");
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
import { MAX_REPLY_LEN, splitText, hasInboundAttachment, splitSocialReply, rememberRecentKaomoji, COMMON_CHAT_STYLE_PROMPT, formatLocalChatReality, expressionCapabilityPrompt } from "./lib/reply.mjs";
import { RAG_SKIP_PATTERNS, shouldSkipRag } from "./lib/rag.mjs";
import { startServer, stopServer } from "./lib/server.mjs";
import { registerStatusRoutes } from "./lib/gui-status.mjs";
import { registerSessionRoutes } from "./lib/gui-sessions.mjs";
import { registerProfileRoutes } from "./lib/gui-profiles.mjs";
import { registerConfigRoutes } from "./lib/gui-config.mjs";
import { registerRagRoutes } from "./lib/gui-rag.mjs";
import { registerMediaRoutes } from "./lib/gui-media.mjs";
import { registerLogRoutes } from "./lib/gui-logs.mjs";
import { registerControlRoutes } from "./lib/gui-control.mjs";

// ─── STATE ──────────────────────────────────────────────────
import { token, getUpdatesBuf, sessions, activeAI, profileTemplates, modelNames, pendingInputs, recentInputs, setToken, setSyncBuf, setActiveAI } from "./lib/state.mjs";
import { uuid, sleep, log, isPidRunning } from "./lib/utils.mjs";
import { loadToken, saveToken, loginWithQr, sendMessage, apiPost, apiGet } from "./lib/wechat.mjs";
import { applyMemoryOps, buildMemoryWriterSystemPrompt, isMemoryEnabled, shouldRunMemoryWriter, memoryListText, memoryMaintenanceNotice, normalizeMemoryCategory, parseMemoryWriterOutput, renderMemoryPrompt } from "./lib/memory.mjs";
const LONG_POLL_TIMEOUT_MS = 35_000;

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
function hasExplicitProfileName(userMessage) {
  return Object.keys(profileTemplates).some(name => name !== "默认" && userMessage.includes(name));
}

function shouldAnchorRagProfile(userMessage, profile) {
  if (!profile || profile === "默认" || hasExplicitProfileName(userMessage)) return false;
  return /你|自己|身高|生日|喜欢|讨厌|学校|乐队|经历|过去|关系|朋友|队友|称呼|为什么|怎么/u.test(userMessage);
}

function shouldUseRagForTurn(userMessage, profile) {
  if (!profile || profile === "默认") return false;
  if (shouldSkipRag(userMessage)) return false;
  return hasExplicitProfileName(userMessage)
    || /身高|生日|血型|学校|学部|乐队|成员|经历|过去|关系|朋友|队友|称呼|设定|资料|官方|剧情|假唱|退团|作品|歌曲|角色/u.test(userMessage);
}

function queryRag(userMessage, profile = null) {
  if (!fs.existsSync(RAG_SCRIPT)) return null;
  if (shouldSkipRag(userMessage)) {
    log("\u{1F50D}", "RAG skip (casual)");
    return null;
  }
  const queryText = (profile && profile !== "默认") ? `${profile} ${userMessage}` : userMessage;
  ensureDir(RUNTIME_DIR);
  const queryFile = path.join(RUNTIME_DIR, `.rag_query_${crypto.randomUUID()}.txt`);
  const started = Date.now();
  try {
    fs.writeFileSync(queryFile, queryText, "utf-8");
    const result = spawnSync("python", ["-X", "utf8", RAG_SCRIPT, "query", "--file", queryFile], {
      cwd: path.dirname(RAG_SCRIPT),
      encoding: "utf-8",
      timeout: 8000,
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
  };
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
        })),
      };
    }
    data[ai] = aiData;
  }
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));

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
  const prompt = [
    "请为另一个聊天模型客观解析这张图片，输出中文。",
    "优先识别：画面主体、可见文字/OCR、物品类型、作品名或品牌名、场景、数量/分量。",
    "请区分“看清楚的事实”和“不确定的推测”。不要把推测写成事实。",
    "如果能清楚读出漫画/书/商品的标题，请写出标题；如果读不清，明确说读不清。",
    "如果存在电脑屏幕、桌面、背景物体等，只描述确实入镜且清晰可见的内容。",
    "不要从少量视觉线索脑补作品类型、剧情、用餐人数、几碗饭或用户偏好。",
    "输出 3-6 句；需要时可加一行“低置信度/不确定点”。不要角色扮演。",
    hint ? `用户补充文字（可能不完整或带偏）：${hint.slice(0, 300)}` : "",
  ].filter(Boolean).join("\n");

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
    return { kind: "voice", path: filePath, mime: "audio/silk", transcript: voice.text || "", playtime: voice.playtime };
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
    const transcript = info.transcript ? `\n语音转文字: ${info.transcript}` : "";
    return `[语音]\n本地路径: ${info.path || "未保存"}\nMIME: ${info.mime || "unknown"}${transcript}`;
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
    if ([2, 4, 5].includes(item?.type)) shouldBatch = true;
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
  if (memoryPrompt && options.includeMemoryInSystem !== false) systemPromptParts.push(memoryPrompt);
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
  if (firstTurn) {
    args.push("--session-id", sid);
  } else {
    args.push("--resume", sid);
  }
  if (fastCasual) {
    args.push("--model", CLAUDE_FAST_MODEL, "--effort", "low");
  } else {
    args.push("--fallback-model", CLAUDE_FALLBACK_MODEL);
  }
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
  if (fastCasual) log("\u{26A1}", `[${sessionName}] CC fast casual model`);

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
  if (memoryPrompt) systemParts.push(memoryPrompt);
  if (stylePrompt) systemParts.push(stylePrompt);
  let prompt = systemParts.length ? `${systemParts.join("\n\n---\n\n")}\n\n---\n\n${userBody}` : userBody;
  if (ragContext) {
    prompt = [
      "【可能相关的背景资料】",
      "以下资料由向量检索自动召回，可能相关，也可能无关。",
      "不要假设用户正在阅读、分享或讨论这些资料；只有当它确实能帮助回答时才使用。",
      "",
      ragContext,
      "",
      "---",
      "",
      prompt,
    ].join("\n");
  }
  return prompt;
}

function runCodexStream(ai, sid, sessionName, body, firstTurn, onEvent, ragContext, stylePrompt, memoryPrompt = "", profileOverride = null) {
  const prompt = buildCodexPrompt(ai, body, ragContext, stylePrompt, memoryPrompt, profileOverride);
  let args;
  if (firstTurn) {
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
  return [
    COMMON_CHAT_STYLE_PROMPT,
    "",
    expressionCapabilityPrompt(),
    "",
    "【自然长短】",
    "不要按固定字数写。轻松接话、确认、调侃可以很短；对方认真倾诉、展开复杂观点或需要陪伴时，再自然多说。",
    "短不是敷衍，长也不是默认目标；只要一句话能准确接住，就停在一句话。",
  ].join("\n");
}

function buildTurnBody(userBody, ragContext = "") {
  const sections = [
    [
      "【本轮临时上下文】",
      formatLocalChatReality(),
    ].join("\n"),
  ];
  if (ragContext) {
    sections.push([
      "【可能相关的背景资料】",
      "以下资料由本地向量检索自动召回，可能相关，也可能无关；只有当它确实能帮助回答时才使用。",
      ragContext,
    ].join("\n"));
  }
  sections.push(["【用户消息】", userBody].join("\n"));
  return sections.join("\n\n---\n\n");
}

async function updateUserMemoryFromTurn(userId, userBody, profile) {
  if (!isMemoryEnabled(userId)) return [];
  if (!shouldRunMemoryWriter(userBody)) return [];
  if (!commandExists(CLAUDE)) return [];
  const systemPromptFile = path.join(RUNTIME_DIR, `.memory_writer_system_${crypto.randomUUID()}.txt`);
  ensureDir(RUNTIME_DIR);
  fs.writeFileSync(systemPromptFile, buildMemoryWriterSystemPrompt(userId, profile), "utf-8");
  const args = [
    "--bare",
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "bypassPermissions",
    "--model", CLAUDE_FAST_MODEL,
    "--effort", "low",
    "--system-prompt-file", systemPromptFile,
  ];
  const proc = spawnCli(CLAUDE, args, {
    cwd: AI_WORK_DIR,
    timeout: 60_000,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: envWithProxy(CLAUDE_HTTPS_PROXY),
  });
  proc.stdin.on("error", () => {});
  proc.stdin.end(userBody, "utf8");

  let stdout = "";
  let stderr = "";
  const code = await new Promise(resolve => {
    proc.stdout.on("data", d => { stdout += d; });
    proc.stderr.on("data", d => { stderr += d; if (stderr.length > 2000) stderr = stderr.slice(-2000); });
    proc.on("close", resolve);
    proc.on("error", () => resolve(-1));
  }).finally(() => {
    try { fs.unlinkSync(systemPromptFile); } catch {}
  });
  if (code !== 0) {
    log("⚠️", `memory writer failed: exit ${code}${stderr ? `; ${stderr.slice(-300)}` : ""}`);
    return [];
  }

  let text = "";
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const evt = JSON.parse(trimmed);
      if (evt.type === "assistant" && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === "text" && block.text) text += block.text;
        }
      } else if (evt.type === "result" && evt.result) {
        text += String(evt.result);
      }
    } catch {}
  }
  const ops = parseMemoryWriterOutput(text);
  if (!ops.length) log("⚠️", `memory writer returned no JSON ops${text ? `: ${text.slice(0, 120)}` : ""}`);
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
// Returns the AI session ID reported by the CLI (CC session_id or Codex thread_id).
async function processTurn(ai, userId, sid, sessionName, body, contextToken, firstTurn, onProc, styleState) {
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

  let textBuf = "";
  let lastFlush = Date.now();
  let lastSent = "";

  async function flush(force, isFinal) {
    const t = textBuf.trim();
    if (!t || t === lastSent) { textBuf = ""; return true; }
    if (!force && t.length < 300 && Date.now() - lastFlush < 3000) return true;
    lastSent = t;
    const isProfileChat = Boolean(turnProfile);
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
    lastFlush = Date.now();
    return sentOk;
  }

  let hasOutput = false;
  let newSid = sid;
  let assistantFullText = "";

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
        if (evt.usage) {
          writeFmt(`\n[usage] input=${evt.usage.input_tokens} output=${evt.usage.output_tokens}`);
        }
        writeFmt(`\n=== completed ===`);
        return;
      }
      if (evt.type === "turn.failed") {
        const errMsg = evt.error?.message || JSON.stringify(evt.error || evt);
        textBuf += `\n⚠️ ${errMsg}`;
        hasOutput = true;
        writeFmt(`\n=== FAILED ===\n${errMsg}`);
        return;
      }
    }

    const profile = turnProfile;
    const useRagCdx = RAG_ENABLED && !hasInboundAttachment(body) && profile && profile !== "默认" && profileTemplates[profile] && shouldUseRagForTurn(body, profile);
    const ragContext = useRagCdx ? queryRag(body, profile) : null;
    const turnBody = buildTurnBody(body, null);
    writeLog(JSON.stringify({
      type: "turn_context",
      backend: "codex",
      memoryChars: memoryPrompt.length,
      ragChars: ragContext?.length || 0,
      transientBodyChars: turnBody.length,
      stableSystemChars: stylePrompt.length + memoryPrompt.length + (profile && profileTemplates[profile] ? profileTemplates[profile].length : 0),
      timestamp: new Date().toISOString(),
    }));
    const task = runCodexStream(ai, sid, sessionName, turnBody, firstTurn, handleCodexEvent, ragContext, stylePrompt, memoryPrompt, profile);
    if (onProc) onProc(task.proc);

    let { code, stderr, killed } = await task;

    for (let retry = 0; retry < SESSION_LOCK_RETRIES && !killed && code !== 0 && !hasOutput; retry++) {
      if (!stderr.includes("already in use") && !stderr.includes("timeout")) break;
      log("\u{1F501}", `[${sessionName}] retry ${retry + 1}/${SESSION_LOCK_RETRIES}...`);
      await sleep(SESSION_LOCK_RETRY_MS);
      hasOutput = false; textBuf = ""; lastSent = ""; lastFlush = Date.now();
      writeFmt(`\n--- Retry ${retry + 1} ---`);
      const retryTask = runCodexStream(ai, newSid || sid, sessionName, turnBody, firstTurn, handleCodexEvent, ragContext, stylePrompt, memoryPrompt, profile);
      if (onProc) onProc(retryTask.proc);
      ({ code, stderr, killed } = await retryTask);
    }

    const ok = !killed && (code === 0 || hasOutput);
    await flush(true, ok);

    if (killed) {
      await sendMessage(userId, `# ${prefix}\n⏹️ 已取消`, contextToken);
      writeFmt("\n=== CANCELLED ===");
    } else if (code !== 0 && !hasOutput) {
      await sendMessage(userId, `# ${prefix}\n❌ Codex exited ${code}\n${stderr.slice(0, 500)}`, contextToken);
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
        if (evt.subtype !== "success") {
          textBuf += `\n⚠️ ${evt.subtype}: ${evt.result || ""}`;
          hasOutput = true;
        }
        writeFmt(`\n=== ${evt.subtype || "completed"} ===`);
        if (evt.result) writeFmt(`Result: ${JSON.stringify(evt.result).slice(0, 1000)}`);
      }
    }

    const profile = turnProfile;
    const useRag = RAG_ENABLED && !hasInboundAttachment(body) && profile && profile !== "默认" && profileTemplates[profile] && shouldUseRagForTurn(body, profile);
    const ragContext = useRag ? queryRag(body, profile) : null;
    const claudeBody = buildTurnBody(body, ragContext);
    writeLog(JSON.stringify({
      type: "turn_context",
      backend: "claude_stream",
      memoryChars: memoryPrompt.length,
      ragChars: ragContext?.length || 0,
      transientBodyChars: claudeBody.length,
      stableSystemChars: stylePrompt.length + memoryPrompt.length + (profile && profileTemplates[profile] ? profileTemplates[profile].length : 0),
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
      writeFmt(`\n--- Retry ${retry + 1} ---`);
      const retryTask = runClaudeStream(ai, newSid || sid, sessionName, claudeBody, firstTurn, handleClaudeEvent, stylePrompt, memoryPrompt, profile, {
        routingBody: body,
      });
      if (onProc) onProc(retryTask.proc);
      ({ code, stderr, killed } = await retryTask);
    }

    const ok = !killed && (code === 0 || hasOutput);
    await flush(true, ok);

    if (killed) {
      await sendMessage(userId, `# ${prefix}\n⏹️ 已取消`, contextToken);
      writeFmt("\n=== CANCELLED ===");
    } else if (code !== 0 && !hasOutput) {
      await sendMessage(userId, `# ${prefix}\n❌ CC exited ${code}\n${stderr.slice(0, 500)}`, contextToken);
      writeFmt(`\n=== ERROR exit ${code} ===\n${stderr.slice(0, 500)}`);
    }
  }

  writeFmt(`\n=== End ===`);
  if (styleState && assistantFullText) {
    rememberRecentKaomoji(styleState, assistantFullText);
  }
  try {
    await updateUserMemoryFromTurn(userId, body, turnProfile);
    const notice = memoryMaintenanceNotice(userId, { profile: turnProfile, mark: true });
    if (notice) await sendMessage(userId, notice, contextToken);
  } catch (e) {
    log("⚠️", `memory writer skipped: ${e.message}`);
  }
  log("\u{23F1}", `[${ai}] [${sessionName}] turn done in ${Date.now() - turnStarted}ms`);
  } finally {
    try { if (logStream) logStream.end(); } catch {}
    try { if (fmtStream) fmtStream.end(); } catch {}
  }

  return newSid;
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
      const newSid = await processTurn(ai, userId, sess.sid, sess.name, item.body, item.ctx, sess._firstTurn, (proc) => { sess._proc = proc; }, sess);
      if (newSid) sess.sid = newSid;
      sess._firstTurn = false;
      saveSessions();
    } catch (e) {
      log("❌", `[${sess.name}] error: ${e.message}`);
      await sendMessage(userId, `# ${replyPrefix(sess.name, ai)}\n❌ ${e.message}`, item.ctx);
    }
    sess._lastEnd = Date.now();
    sess._proc = null;
  }
}

function queueTurn(messageAI, userId, body, ctx, sessionId = null) {
  const sess = sessionId ? sessionById(messageAI, userId, sessionId) : activeSession(userId, messageAI);
  if (!sess || sess._closing) return;

  log("\u{1F4E9}", `[${messageAI}] [${sess.name}] ${userId}: ${body.slice(0, 80)}`);

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
  if (rest && rest !== "all" && !["性格", "偏好", "事实"].includes(rest)) {
    // check if rest matches a known profile name
    if (profileTemplates[rest]) {
      targetProfile = rest;
    } else {
      // fuzzy match
      const match = Object.keys(profileTemplates).find(k => k.includes(rest) || rest.includes(k));
      if (match) targetProfile = match;
    }
  }

  const isOtherRole = targetProfile !== activeProfile;
  const label = isOtherRole ? `角色: ${targetProfile}` : "";

  if (!rest) {
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

  // if rest didn't match any profile, show help
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
  const py = spawnSync("python", ["--version"], { encoding: "utf8", timeout: 8000, windowsHide: true });
  if (py.status === 0) {
    pass("Python", (py.stdout || py.stderr || "").trim());
  } else {
    fail("Python", "python 命令不可用 (RAG / 文件提取将不可用)");
  }

  // ffmpeg (optional)
  const ff = spawnSync("ffmpeg", ["-version"], { encoding: "utf8", timeout: 8000, windowsHide: true });
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

  // ─── Start GUI server first ──────────────────────────────────
  registerStatusRoutes();
  registerSessionRoutes();
  registerProfileRoutes();
  registerConfigRoutes();
  registerRagRoutes();
  registerMediaRoutes();
  registerLogRoutes();
  registerControlRoutes();
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
