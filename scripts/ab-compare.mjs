#!/usr/bin/env node
// scripts/ab-compare.mjs
// Phase 0: A/B comparison — CC CLI vs Direct API
// Reads real chat-history, replays messages through both backends, saves results.
// Does NOT modify any existing data files.
// Usage: node scripts/ab-compare.mjs [--resume] [--limit N] [--api-base-url URL] [--api-key KEY] [--api-model MODEL]

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execSync } from "node:child_process";
import { beijingISO } from "../app/lib/time-utils.mjs";

// ─── Path setup — ensure imports from app/lib resolve correctly ───
const SCRIPT_DIR = import.meta.dirname;
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");
const APP_DIR = path.join(PROJECT_DIR, "app");
const DATA_DIR = path.join(PROJECT_DIR, "data");
const RUNTIME_DIR = path.join(DATA_DIR, "runtime");
const OUTPUT_DIR = path.join(RUNTIME_DIR, "ab-compare");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── CLI args ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const FLAG_RESUME = args.includes("--resume");
const FLAG_DRY_RUN = args.includes("--dry-run");
const EXCLUDE_TYPES = (() => { const i = args.indexOf("--exclude-type"); return i >= 0 ? new Set(args[i + 1].split(",")) : new Set(); })();
const LIMIT = (() => {
  const idx = args.indexOf("--limit");
  if (idx >= 0 && args[idx + 1]) { const n = parseInt(args[idx + 1], 10); return n > 0 ? n : null; }
  return null;
})();
const API_BASE_URL = (() => { const i = args.indexOf("--api-base-url"); return i >= 0 ? args[i + 1] : ""; })();
const API_KEY = (() => { const i = args.indexOf("--api-key"); return i >= 0 ? args[i + 1] : ""; })();
const API_MODEL = (() => { const i = args.indexOf("--api-model"); return i >= 0 ? args[i + 1] : ""; })();

// ─── Config loading (read config.json directly, no side effects) ───
let APP_CONFIG = {};
try {
  APP_CONFIG = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "config.json"), "utf-8"));
} catch { /* use defaults */ }

function configValue(key, fallback = null) {
  let cur = APP_CONFIG;
  for (const part of key.split(".")) {
    if (!cur || typeof cur !== "object" || !(part in cur)) return fallback;
    cur = cur[part];
  }
  return cur ?? fallback;
}

// ─── Load wechat-profiles.json ─────────────────────────────────
let profileTemplates = {};
try {
  const profileFile = path.join(DATA_DIR, "wechat-profiles.json");
  const d = JSON.parse(fs.readFileSync(profileFile, "utf-8"));
  profileTemplates = d.templates || { "默认": "保持 AI 的默认风格" };
} catch { profileTemplates = { "默认": "保持 AI 的默认风格" }; }

// ─── Load prompts.json ─────────────────────────────────────────
let promptConfig = {};
try {
  promptConfig = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "prompts.json"), "utf-8"));
} catch { /* use defaults */ }

// ─── Load chat-history.json ────────────────────────────────────
function loadAllEvents() {
  const file = path.join(DATA_DIR, "chat-history.json");
  const bak = path.join(DATA_DIR, "chat-history.bak.json");
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      return Array.isArray(data?.events) ? data.events : [];
    }
  } catch {}
  try {
    if (fs.existsSync(bak)) {
      const data = JSON.parse(fs.readFileSync(bak, "utf-8"));
      return Array.isArray(data?.events) ? data.events : [];
    }
  } catch {}
  return [];
}

// ─── Time formatting helpers ───────────────────────────────────
function formatZonedTimeParts(date, tz) {
  try {
    const opts = { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" };
    const parts = new Intl.DateTimeFormat("zh-CN", opts).formatToParts(date);
    const get = (type) => parts.find(p => p.type === type)?.value || "";
    const hour = parseInt(get("hour"), 10);
    let period;
    if (hour >= 5 && hour < 8) period = "清晨";
    else if (hour >= 8 && hour < 12) period = "上午";
    else if (hour >= 12 && hour < 13) period = "中午";
    else if (hour >= 13 && hour < 18) period = "下午";
    else if (hour >= 18 && hour < 21) period = "傍晚";
    else if (hour >= 21 && hour < 23) period = "晚上";
    else period = "深夜";
    const weekdayMap = { "周一": "周一", "周二": "周二", "周三": "周三", "周四": "周四", "周五": "周五", "周六": "周六", "周日": "周日" };
    return {
      stamp: `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`,
      shortWeekday: weekdayMap[get("weekday")] || get("weekday"),
      period,
    };
  } catch {
    return { stamp: beijingISO(date), shortWeekday: "", period: "" };
  }
}

function formatLocalChatReality(date) {
  const beijing = formatZonedTimeParts(date, "Asia/Shanghai");
  const tokyo = formatZonedTimeParts(date, "Asia/Tokyo");
  const instructions = promptConfig.chatRealityInstructions || "【当前聊天现实】\n当前用户侧时间和当前角色侧时间见上方动态注入。";
  return [
    instructions,
    "",
    `用户侧时间：${beijing.stamp} ${beijing.shortWeekday}${beijing.period}（北京时间）`,
    `角色侧时间：${tokyo.stamp} ${tokyo.shortWeekday}${tokyo.period}（东京时间）`,
  ].join("\n");
}

// ─── Prompt builders (replicating app/lib/prompts.mjs logic) ──
function getChatStyle() {
  return promptConfig.chatStyle || [
    "【共同聊天风格】",
    "【回复写法】",
    "像在真实的社交软件私聊，不要把回复写成总结、下判断、金句、漂亮独白或文章段落。",
  ].join("\n");
}

function buildTurnBody(userBody, ragContext, sceneContext, memoryPrompt, sceneMemory, now = new Date()) {
  const sections = [];
  if (sceneMemory) sections.push("【本轮之前的对话摘要】\n" + sceneMemory);
  if (memoryPrompt) sections.push(memoryPrompt);
  if (sceneContext) sections.push(sceneContext);
  if (ragContext) sections.push("【关于千圣自己】\n" + (promptConfig.ragContextInstruction || "") + "\n" + ragContext);
  sections.push(getChatStyle());
  sections.push(formatLocalChatReality(now));
  const beijing = formatZonedTimeParts(now, "Asia/Shanghai");
  const tokyo = formatZonedTimeParts(now, "Asia/Tokyo");
  const timeTag = `${beijing.stamp} ${beijing.shortWeekday}${beijing.period}（北京时间；角色侧东京时间 ${tokyo.stamp} ${tokyo.shortWeekday}${tokyo.period}）`;
  sections.push([`【用户消息】- ${timeTag}`, userBody].join("\n"));
  return sections.join("\n\n---\n\n");
}

function buildHiddenWorldSystemPrompt(profile, sceneMemory = "") {
  const parts = [
    "角色 prompt：",
    profile && profileTemplates[profile] ? profileTemplates[profile] : "",
  ];
  if (sceneMemory) parts.push("", sceneMemory);
  parts.push(
    "",
    "【角色世界特殊日期】",
    promptConfig.scheduleSpecialDates || "",
    "",
    "【月度行事与季节事件】",
    promptConfig.seasonalMonthlyNotes
      ? Object.entries(promptConfig.seasonalMonthlyNotes).map(([m, lines]) => `[${m}月] ${Array.isArray(lines) ? lines.join("；") : lines}`).join("\n")
      : "",
    "",
    promptConfig.sceneletInstructions || "",
    "",
    promptConfig.hiddenWorldChatStyle || "",
  );
  return parts.filter(Boolean).join("\n");
}

function buildHiddenWorldPrompt(opts = {}) {
  const { userId, sessionName, profile, userBody, visibleContext, memoryPrompt, worldState } = opts;
  const now = new Date();
  const beijing = formatZonedTimeParts(now, "Asia/Shanghai");
  const tokyo = formatZonedTimeParts(now, "Asia/Tokyo");
  return [
    "你将收到本轮动态上下文。请按 hidden-world system prompt 的规则输出 JSON。",
    "",
    memoryPrompt ? `关于她，千圣一直记得：\n${memoryPrompt}` : "",
    "",
    "当前时间：",
    JSON.stringify({
      iso: beijingISO(now),
      beijing: { local: beijing.stamp, weekday: beijing.shortWeekday, period: beijing.period, timezone: "Asia/Shanghai" },
      tokyo: { local: tokyo.stamp, weekday: tokyo.shortWeekday, period: tokyo.period, timezone: "Asia/Tokyo" },
    }, null, 2),
    "",
    "输入：",
    JSON.stringify({
      userId,
      sessionName,
      profile,
      world_state: worldState,
      active_life_arcs: [],
      pending_proactive_intents: [],
      visible_context_instruction: promptConfig.chatHistoryIntro || "",
      recent_visible_context: visibleContext || [],
      user_message: userBody,
    }, null, 2),
  ].filter(Boolean).join("\n");
}

// ─── Load memory document ──────────────────────────────────────
function loadMemoryDocument() {
  const file = path.join(DATA_DIR, "wechat-memory.md");
  const bak = path.join(DATA_DIR, "wechat-memory.bak.md");
  try { if (fs.existsSync(file)) return fs.readFileSync(file, "utf-8"); } catch {}
  try { if (fs.existsSync(bak)) return fs.readFileSync(bak, "utf-8"); } catch {}
  return "";
}

// ─── CC Backend (using Claude Code CLI subprocess) ─────────────
// We import from claude-runner.mjs to reuse the exact same CC calling logic.
// This ensures the CC path is 100% identical to production.

// Since claude-runner.mjs has side-effect imports (config loading, path resolution),
// we need to be careful. Let's instead replicate the minimal CC spawn logic here
// to avoid pulling in the full module chain.

function needsWindowsShell(command) {
  return process.platform === "win32" && (!path.extname(command) || /\.(cmd|bat|ps1)$/i.test(command));
}

function spawnCli(command, args, options = {}) {
  return spawn(command, args, { ...options, shell: options.shell ?? needsWindowsShell(command) });
}

// Resolve Claude Code path (with npm stub → native binary resolution)
const USER_HOME = process.env.USERPROFILE || process.env.HOME || process.cwd();
const NPM_GLOBAL = configValue("paths.npmGlobal", path.join(process.env.APPDATA || path.join(USER_HOME, "AppData", "Roaming"), "npm"));

function isNpmClaudeStub(command) {
  try {
    const normalized = path.normalize(command).toLowerCase();
    return process.platform === "win32"
      && normalized.endsWith(path.normalize("@anthropic-ai/claude-code/bin/claude.exe").toLowerCase())
      && fs.statSync(command).size < 4096;
  } catch { return false; }
}

function listDirs(parent) {
  try { return fs.readdirSync(parent, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return []; }
}

function latestExisting(paths) {
  return paths.filter(p => p && fs.existsSync(p)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

function claudeNativeFallback() {
  if (process.platform !== "win32") return null;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const anthropicDir = path.join(NPM_GLOBAL, "node_modules", "@anthropic-ai");
  const tempCandidates = listDirs(anthropicDir)
    .filter(name => name.startsWith(".claude-code-"))
    .map(name => path.join(anthropicDir, name, "node_modules", "@anthropic-ai", `claude-code-win32-${arch}`, "claude.exe"));
  const claudeDesktopCache = path.join(
    process.env.LOCALAPPDATA || path.join(USER_HOME, "AppData", "Local"),
    "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude", "claude-code",
  );
  const desktopCandidates = listDirs(claudeDesktopCache).map(name => path.join(claudeDesktopCache, name, "claude.exe"));
  return latestExisting([
    path.join(anthropicDir, "claude-code", "node_modules", "@anthropic-ai", `claude-code-win32-${arch}`, "claude.exe"),
    ...tempCandidates,
    ...desktopCandidates,
  ]);
}

function resolveClaudeCommand(command) {
  if (!isNpmClaudeStub(command)) return command;
  return claudeNativeFallback() || command;
}

const CLAUDE_PATH_RAW = process.env.WECHAT_CLAUDE_PATH || configValue("paths.claude", path.join(NPM_GLOBAL, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
const CLAUDE_PATH = resolveClaudeCommand(CLAUDE_PATH_RAW);
const AI_WORK_DIR = process.env.WECHAT_AI_WORK_DIR || configValue("paths.workDir", USER_HOME) || USER_HOME;
const CC_MODEL = process.env.WECHAT_CLAUDE_MAIN_MODEL || configValue("models.claudeMain", "deepseek-v4-pro[1m]");
const CC_PROXY = process.env.WECHAT_CLAUDE_HTTPS_PROXY || configValue("proxy.claudeHttps", process.env.WECHAT_HTTPS_PROXY || configValue("proxy.https", ""));

function envWithProxy(proxyUrl) {
  const env = { ...process.env };
  if (proxyUrl && String(proxyUrl).trim()) {
    const v = String(proxyUrl).trim();
    env.HTTP_PROXY = v; env.HTTPS_PROXY = v; env.http_proxy = v; env.https_proxy = v;
  }
  return env;
}

function killProc(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /T /F /PID ${proc.pid}`, { timeout: 8000, windowsHide: true });
    } else {
      proc.kill("SIGKILL");
    }
  } catch {
    try { process.kill(proc.pid, "SIGKILL"); } catch {}
  }
}

function parseHiddenJson(raw) {
  const trimmed = String(raw).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(trimmed); } catch {}
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error("no JSON object found");
}

// Run a hidden (non-streaming) CC call — replicates runHiddenJson from claude-runner.mjs
async function ccRunHidden(prompt, opts = {}) {
  const { label = "hidden", timeoutMs = 300_000, bare = true, model = CC_MODEL, systemPrompt = "" } = opts;
  if (!fs.existsSync(CLAUDE_PATH)) return { success: false, error: `claude not found: ${CLAUDE_PATH}` };

  const systemPromptFile = systemPrompt
    ? path.join(RUNTIME_DIR, `.ab_hidden_sys_${crypto.randomUUID()}.txt`)
    : null;

  const args = ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions", "--tools", "WebSearch,WebFetch", "--model", model];
  if (bare) args.splice(1, 0, "--bare");
  args.push("--no-session-persistence");

  if (systemPromptFile) {
    ensureDir(RUNTIME_DIR);
    fs.writeFileSync(systemPromptFile, systemPrompt, "utf-8");
    args.push("--append-system-prompt-file", systemPromptFile);
  }

  const startedMs = Date.now();
  const proc = spawnCli(CLAUDE_PATH, args, {
    cwd: AI_WORK_DIR,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: envWithProxy(CC_PROXY),
  });
  proc.stdin.on("error", () => {});
  proc.stdin.end(prompt, "utf8");

  let stdout = "";
  let stderr = "";
  const code = await new Promise(resolve => {
    const timer = setTimeout(() => { killProc(proc); resolve(null); }, timeoutMs);
    proc.stdout.on("data", d => { stdout += d; });
    proc.stderr.on("data", d => { stderr += d; if (stderr.length > 3000) stderr = stderr.slice(-3000); });
    proc.on("close", c => { clearTimeout(timer); resolve(c); });
    proc.on("error", () => { clearTimeout(timer); resolve(-1); });
  });
  if (systemPromptFile) { try { fs.rmSync(systemPromptFile, { force: true }); } catch {} }

  const durationMs = Date.now() - startedMs;
  if (code !== 0 && !stdout.trim()) {
    return { success: false, error: `exit ${code}`, stderr: stderr.slice(-500), durationMs };
  }
  try {
    const parsed = parseHiddenJson(stdout);
    const content = parsed.result || parsed.message || parsed.text || stdout;
    let inner;
    try { inner = typeof content === "string" ? parseHiddenJson(content) : parsed; } catch { inner = content; }
    return {
      success: true,
      data: inner && typeof inner === "object" ? inner : { raw: content },
      durationMs,
      usage: {
        inputTokens: Number(parsed?.usage?.input_tokens || 0) || 0,
        outputTokens: Number(parsed?.usage?.output_tokens || 0) || 0,
        costUSD: Number(parsed?.total_cost_usd || 0) || 0,
      },
    };
  } catch (e) {
    return { success: false, error: `parse: ${e.message}`, stderr: stderr.slice(-500), durationMs };
  }
}

// Run a streaming CC call — replicates runClaudeStream from claude-runner.mjs
async function ccRunStream(opts = {}) {
  const { sessionName = "ab-test", systemPrompt = "", body = "", model = CC_MODEL } = opts;
  if (!fs.existsSync(CLAUDE_PATH)) return { success: false, error: `claude not found: ${CLAUDE_PATH}` };

  const systemPromptFile = systemPrompt
    ? path.join(RUNTIME_DIR, `.ab_stream_sys_${crypto.randomUUID()}.txt`)
    : null;

  const args = [
    "-p", "--name", sessionName,
    "--output-format", "stream-json", "--verbose",
    "--permission-mode", "bypassPermissions",
    "--tools", "WebSearch,WebFetch",
    "--no-session-persistence",
    "--model", model,
  ];

  if (systemPromptFile) {
    ensureDir(RUNTIME_DIR);
    fs.writeFileSync(systemPromptFile, systemPrompt, "utf-8");
    args.push("--append-system-prompt-file", systemPromptFile);
  }

  const startedMs = Date.now();
  const proc = spawnCli(CLAUDE_PATH, args, {
    cwd: AI_WORK_DIR,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: envWithProxy(CC_PROXY),
  });
  proc.stdin.on("error", () => {});
  proc.stdin.end(body, "utf8");

  let buf = "";
  let stderrOut = "";
  const events = [];

  proc.stdout.on("data", d => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { events.push(JSON.parse(trimmed)); } catch {}
    }
  });
  proc.stderr.on("data", d => { stderrOut += d; if (stderrOut.length > 5000) stderrOut = stderrOut.slice(-5000); });

  const code = await new Promise(resolve => {
    proc.on("close", c => { resolve(c); });
    proc.on("error", () => { resolve(-1); });
  });
  if (systemPromptFile) { try { fs.rmSync(systemPromptFile, { force: true }); } catch {} }
  if (buf.trim()) { try { events.push(JSON.parse(buf.trim())); } catch {} }

  const durationMs = Date.now() - startedMs;
  if (code !== 0) return { success: false, error: `exit ${code}`, stderr: stderrOut.slice(-500), durationMs };

  // Extract reply text from stream events
  const textParts = [];
  let lastUsage = null;
  for (const ev of events) {
    if (ev.type === "assistant" && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === "text" && block.text) textParts.push(block.text);
      }
    }
    if (ev.usage) lastUsage = ev.usage;
    if (ev.message?.usage) lastUsage = ev.message.usage;
  }
  return {
    success: true,
    text: textParts.join(""),
    durationMs,
    usage: lastUsage ? {
      inputTokens: Number(lastUsage.input_tokens || 0) || 0,
      outputTokens: Number(lastUsage.output_tokens || 0) || 0,
      costUSD: Number(lastUsage?.total_cost_usd || 0) || 0,
    } : null,
    events,
  };
}

// ─── API Backend (direct HTTP to OpenAI-compatible endpoint) ───
function resolveApiConfig() {
  const baseUrl = API_BASE_URL || process.env.AB_API_BASE_URL || configValue("api.baseUrl", configValue("vision.baseUrl", "https://api.siliconflow.cn/v1"));
  const apiKey = API_KEY || process.env.AB_API_KEY || configValue("api.apiKey", configValue("vision.apiKey", ""));
  const model = API_MODEL || process.env.AB_API_MODEL || configValue("api.model", "deepseek-ai/DeepSeek-V4-Pro");
  return { baseUrl, apiKey, model };
}

async function apiChatCompletion(messages, opts = {}) {
  const { baseUrl, apiKey, model } = resolveApiConfig();
  const { temperature = 0.7, maxTokens = 4000, timeoutMs = 300_000, stream = false } = opts;
  // Base URL may already include /v1; normalize to avoid double path
  let url = baseUrl.replace(/\/+$/, "");
  if (!url.endsWith("/v1")) url += "/v1";
  url += "/chat/completions";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const startedMs = Date.now();
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { success: false, error: `HTTP ${resp.status}: ${errText.slice(0, 500)}`, durationMs: Date.now() - startedMs };
    }

    if (stream) {
      // Collect streaming response
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      const textParts = [];
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") continue;
          try {
            const json = JSON.parse(data);
            const choice = json.choices?.[0];
            if (choice?.delta?.content) textParts.push(choice.delta.content);
            if (choice?.finish_reason) {
              // capture final usage
            }
          } catch {}
        }
      }
      return {
        success: true,
        text: textParts.join(""),
        durationMs: Date.now() - startedMs,
        usage: null, // streaming doesn't always return usage
      };
    } else {
      const json = await resp.json();
      const choice = json.choices?.[0];
      return {
        success: true,
        text: choice?.message?.content?.trim() || "",
        durationMs: Date.now() - startedMs,
        usage: json.usage ? {
          inputTokens: Number(json.usage.prompt_tokens || 0) || 0,
          outputTokens: Number(json.usage.completion_tokens || 0) || 0,
        } : null,
      };
    }
  } catch (e) {
    return { success: false, error: e.message, durationMs: Date.now() - startedMs };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Sample Selection ──────────────────────────────────────────
function buildConversationGroups(events) {
  // Group events by sessionKey = ai|userId|sessionId
  const groups = new Map();
  for (const ev of events) {
    const key = [ev.ai || "cc", ev.userId || "", ev.sessionId || ""].join("|");
    if (!groups.has(key)) groups.set(key, { key, ai: ev.ai, userId: ev.userId, sessionId: ev.sessionId, sessionName: ev.sessionName, profile: ev.profile, events: [] });
    groups.get(key).events.push(ev);
  }
  // Sort events chronologically within each group
  for (const g of groups.values()) {
    g.events.sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
  }
  return Array.from(groups.values());
}

function selectSamples(groups) {
  const samples = [];

  // Helper: get user messages from a group
  const userMessages = (g) => g.events.filter(e => e.role === "user" && e.text?.trim());

  // 1. Long sessions (30+ user messages)
  const longGroups = groups.filter(g => userMessages(g).length >= 30).sort((a, b) => userMessages(b).length - userMessages(a).length);
  for (const g of longGroups.slice(0, 3)) {
    samples.push({ type: "long_session", group: g, messages: userMessages(g).slice(0, 30) });
  }

  // 2. Medium sessions (10-20 user messages)
  const mediumGroups = groups.filter(g => { const n = userMessages(g).length; return n >= 10 && n <= 20; });
  const shuffled = [...mediumGroups].sort((a, b) => a.key.localeCompare(b.key));
  for (const g of shuffled.slice(0, 5)) {
    const msgs = userMessages(g).slice(0, 10);
    if (msgs.length >= 5) samples.push({ type: "medium_session", group: g, messages: msgs });
  }

  // 3. Search-triggered sessions
  const questionWords = ["什么时候", "有没有", "最近", "怎么", "为什么", "谁", "哪里", "哪个", "多少", "如何"];
  for (const g of groups) {
    const umsgs = userMessages(g);
    const hasQuestion = umsgs.some(m => questionWords.some(q => (m.text || "").includes(q)));
    if (!hasQuestion) continue;
    const hasSearchReply = g.events.some(e => e.role === "assistant" && e.text && (e.text.includes("搜索") || e.text.includes("查到") || e.text.includes("http") || (e.toolUsage && (e.toolUsage.webSearch > 0 || e.toolUsage.webFetch > 0))));
    if (hasSearchReply) {
      const searchMsgs = umsgs.filter(m => questionWords.some(q => (m.text || "").includes(q))).slice(0, 5);
      if (searchMsgs.length >= 2) {
        samples.push({ type: "search_session", group: g, messages: searchMsgs });
        break;
      }
    }
  }

  // 4. Short messages (≤5 chars) — collect individually
  for (const g of groups) {
    for (const m of userMessages(g)) {
      if ((m.text || "").trim().length <= 5 && (m.text || "").trim().length > 0) {
        samples.push({ type: "short_message", group: g, messages: [m] });
        break; // one per group max
      }
    }
  }

  // 5. Long messages (≥200 chars) — collect individually
  for (const g of groups) {
    for (const m of userMessages(g)) {
      if ((m.text || "").length >= 200) {
        samples.push({ type: "long_message", group: g, messages: [m] });
        break; // one per group max
      }
    }
  }

  // 6. Special chars
  for (const g of groups) {
    for (const m of userMessages(g)) {
      const t = m.text || "";
      if (/\[表情\]|\\u[0-9a-fA-F]{4}|[^\x00-\x7F一-鿿　-〿＀-￯]/.test(t) && !/^[a-zA-Z0-9\s.,!?]+$/.test(t)) {
        samples.push({ type: "special_chars", group: g, messages: [m] });
        break;
      }
    }
  }

  // 7. Media messages
  for (const g of groups) {
    for (const m of userMessages(g)) {
      if (["image", "voice", "video"].includes(m.kind) && m.text?.trim()) {
        samples.push({ type: "media_message", group: g, messages: [m] });
        break;
      }
    }
  }

  return samples;
}

// ─── Test Runner ───────────────────────────────────────────────
function statusPath() {
  return path.join(OUTPUT_DIR, "_status.json");
}

function loadStatus() {
  try {
    if (fs.existsSync(statusPath())) return JSON.parse(fs.readFileSync(statusPath(), "utf-8"));
  } catch {}
  return { completed: [], results: {} };
}

function saveStatus(status) {
  ensureDir(OUTPUT_DIR);
  fs.writeFileSync(statusPath(), JSON.stringify(status, null, 2), "utf-8");
}

function sampleKey(sample, msgIdx) {
  const g = sample.group;
  const msg = sample.messages[msgIdx];
  const ts = msg?.timestamp ? String(msg.timestamp).replace(/[^0-9T:-]/g, "").slice(0, 19) : `m${msgIdx}`;
  return `${sample.type}__${g.sessionId}__${ts}`;
}

function sampleDir(sample) {
  const g = sample.group;
  const dirName = `${sample.type}__${g.sessionId}`.replace(/[<>:"/\\|?*]/g, "_").slice(0, 100);
  return path.join(OUTPUT_DIR, dirName);
}

async function runOneComparison(sample, msgIdx, userMsg) {
  const profile = sample.group.profile || "千圣";
  const sessionName = sample.group.sessionName || "ab-test";
  const userId = sample.group.userId || "test-user";
  const now = new Date();

  // Build the prompt components (same for both CC and API)
  const memoryDoc = loadMemoryDocument();
  const systemPrompt = profileTemplates[profile] || "";

  // Build scenelet prompt
  const hwSystemPrompt = buildHiddenWorldSystemPrompt(profile);
  const hwPrompt = buildHiddenWorldPrompt({
    userId, sessionName, profile,
    userBody: userMsg.text || "",
    visibleContext: [],
    memoryPrompt: memoryDoc,
    worldState: null,
  });

  // Build main turn body (without scenelet for now — scenelet will be prepended by CC logic)
  const turnBody = buildTurnBody(userMsg.text || "", "", "", memoryDoc, "", now);

  const result = {
    key: sampleKey(sample, msgIdx),
    type: sample.type,
    sessionName,
    profile,
    userMessage: userMsg.text?.slice(0, 500) || "",
    timestamp: beijingISO(now),
  };

  // ── Path A: Claude Code CLI ──
  console.log(`  [CC] Running scenelet...`);
  const ccSceneletRes = await ccRunHidden(hwPrompt, {
    label: "ab-scenelet",
    bare: true,
    model: CC_MODEL,
    systemPrompt: hwSystemPrompt,
    timeoutMs: 300_000,
  });
  result.cc = { scenelet: ccSceneletRes };

  // Build context with scenelet for main reply
  let sceneContext = "";
  if (ccSceneletRes.success && ccSceneletRes.data) {
    const innerScenelet = ccSceneletRes.data.inner_scenelet || ccSceneletRes.data.innerScenelet || "";
    if (innerScenelet) {
      sceneContext = [
        "【隐藏中间层：inner_scenelet】",
        promptConfig.innerSceneletIntro || "",
        innerScenelet,
        promptConfig.sceneletReplyBridgeInstruction || "",
      ].filter(Boolean).join("\n");
    }
  }

  const mainBody = buildTurnBody(userMsg.text || "", "", sceneContext, memoryDoc, "", now);
  const mainSystemPrompt = [systemPrompt, promptConfig.chatStyle || getChatStyle()].filter(Boolean).join("\n\n");

  console.log(`  [CC] Running main reply...`);
  const ccReplyRes = await ccRunStream({
    sessionName: `ab-${sample.type}`,
    systemPrompt: mainSystemPrompt,
    body: mainBody,
    model: CC_MODEL,
  });
  result.cc.reply = ccReplyRes;

  // ── Path B: Direct API ──
  const { baseUrl, apiKey, model: apiModel } = resolveApiConfig();
  if (apiKey) {
    console.log(`  [API] Running scenelet...`);
    const apiSceneletRes = await apiChatCompletion([
      { role: "system", content: hwSystemPrompt },
      { role: "user", content: hwPrompt },
    ], { stream: false, temperature: 0.7, maxTokens: 4000 });

    result.api = { scenelet: apiSceneletRes };

    // Parse API scenelet JSON
    let apiSceneContext = "";
    if (apiSceneletRes.success && apiSceneletRes.text) {
      try {
        const parsed = parseHiddenJson(apiSceneletRes.text);
        const innerScenelet = parsed.inner_scenelet || parsed.innerScenelet || "";
        if (innerScenelet) {
          apiSceneContext = [
            "【隐藏中间层：inner_scenelet】",
            promptConfig.innerSceneletIntro || "",
            innerScenelet,
            promptConfig.sceneletReplyBridgeInstruction || "",
          ].filter(Boolean).join("\n");
        }
      } catch {
        // If JSON parse fails, use the raw text as context
        apiSceneContext = [
          "【隐藏中间层：inner_scenelet】",
          promptConfig.innerSceneletIntro || "",
          apiSceneletRes.text.slice(0, 2000),
          promptConfig.sceneletReplyBridgeInstruction || "",
        ].filter(Boolean).join("\n");
      }
    }

    const apiMainBody = buildTurnBody(userMsg.text || "", "", apiSceneContext, memoryDoc, "", now);
    console.log(`  [API] Running main reply...`);
    const apiReplyRes = await apiChatCompletion([
      { role: "system", content: mainSystemPrompt },
      { role: "user", content: apiMainBody },
    ], { stream: true, temperature: 0.7, maxTokens: 4000 });
    result.api.reply = apiReplyRes;
  } else {
    result.api = { scenelet: { success: false, error: "API key not configured. Set --api-key or AB_API_KEY env var." }, reply: null };
  }

  return result;
}

// ─── Labeled Comparison Report Generator ──────────────────────
function generateComparisonReport(results, status) {
  const reportDir = path.join(OUTPUT_DIR, "report");
  ensureDir(reportDir);

  const comparisons = [];
  for (const [key, result] of Object.entries(results)) {
    if (!result.cc?.reply?.success && !result.api?.reply?.success) continue;
    comparisons.push({ key, ...result });
  }
  // Sort by type then key
  comparisons.sort((a, b) => a.type.localeCompare(b.type) || a.key.localeCompare(b.key));

  let md = "# A/B Comparison Report — CC CLI vs Direct API\n\n";
  md += `Generated: ${beijingISO()}\n`;
  md += `Total: ${comparisons.length} comparisons\n\n`;
  md += "---\n\n";

  for (let i = 0; i < comparisons.length; i++) {
    const c = comparisons[i];
    const ccOk = c.cc?.reply?.success ? "✅" : "❌";
    const apiOk = c.api?.reply?.success ? "✅" : "❌";
    const ccText = c.cc?.reply?.text || `[FAIL: ${c.cc?.reply?.error || "unknown"}]`;
    const apiText = c.api?.reply?.text || `[FAIL: ${c.api?.reply?.error || "unknown"}]`;
    const ccMs = c.cc?.reply?.durationMs || 0;
    const apiMs = c.api?.reply?.durationMs || 0;
    const ccCost = c.cc?.scenelet?.usage?.costUSD || 0;

    // Check for issues
    const issues = [];
    if (ccText && /^[^\x00-\x7F一-鿿　-〿＀-￯]+$/.test(ccText.trim())) {
      issues.push("⚠️ CC: 纯非中文回复（可能是日文）");
    }
    if (apiText && /^[^\x00-\x7F一-鿿　-〿＀-￯]+$/.test(apiText.trim())) {
      issues.push("⚠️ API: 纯非中文回复（可能是日文）");
    }
    if (ccText.length > 0 && apiText.length > 0) {
      const ratio = Math.max(ccText.length, apiText.length) / Math.min(ccText.length, apiText.length);
      if (ratio > 2.5) issues.push(`⚠️ 长度差异大（CC: ${ccText.length} vs API: ${apiText.length}）`);
    }

    md += `## ${i + 1}. [${c.type}] ${ccOk}CC ${apiOk}API\n\n`;
    md += `**用户消息:** ${(c.userMessage || "").slice(0, 200)}\n\n`;
    if (issues.length) md += `**问题标记:** ${issues.join(" / ")}\n\n`;
    md += `| 来源 | 回复 | 耗时 |\n`;
    md += `|------|------|------|\n`;
    md += `| **CC** | ${ccText.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 400)} | ${ccMs}ms |\n`;
    md += `| **API** | ${apiText.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 400)} | ${apiMs}ms |\n`;
    md += `\n---\n\n`;
  }

  fs.writeFileSync(path.join(reportDir, "comparison.md"), md, "utf-8");
  console.log(`\nComparison report: ${path.join(reportDir, "comparison.md")}`);
}

// ─── Summary Generator ─────────────────────────────────────────
function generateSummary(status) {
  const summary = { dimensions: {}, totals: { cc: { sceneletOk: 0, replyOk: 0, totalTokens: 0, totalCost: 0, totalMs: 0 }, api: { sceneletOk: 0, replyOk: 0, totalTokens: 0, totalCost: 0, totalMs: 0 }, compared: 0 } };

  for (const [key, r] of Object.entries(status.results)) {
    summary.totals.compared++;

    // Scenelet success
    if (r.cc?.scenelet?.success) summary.totals.cc.sceneletOk++;
    if (r.api?.scenelet?.success) summary.totals.api.sceneletOk++;

    // Reply success
    if (r.cc?.reply?.success) summary.totals.cc.replyOk++;
    if (r.api?.reply?.success) summary.totals.api.replyOk++;

    // Timing
    summary.totals.cc.totalMs += r.cc?.scenelet?.durationMs || 0;
    summary.totals.cc.totalMs += r.cc?.reply?.durationMs || 0;
    summary.totals.api.totalMs += r.api?.scenelet?.durationMs || 0;
    summary.totals.api.totalMs += r.api?.reply?.durationMs || 0;

    // Token/cost from CC
    if (r.cc?.scenelet?.usage) {
      summary.totals.cc.totalTokens += (r.cc.scenelet.usage.inputTokens || 0) + (r.cc.scenelet.usage.outputTokens || 0);
      summary.totals.cc.totalCost += r.cc.scenelet.usage.costUSD || 0;
    }
    if (r.cc?.reply?.usage) {
      summary.totals.cc.totalTokens += (r.cc.reply.usage.inputTokens || 0) + (r.cc.reply.usage.outputTokens || 0);
      summary.totals.cc.totalCost += r.cc.reply.usage.costUSD || 0;
    }

    // Token from API
    if (r.api?.scenelet?.usage) {
      summary.totals.api.totalTokens += (r.api.scenelet.usage.inputTokens || 0) + (r.api.scenelet.usage.outputTokens || 0);
    }
    if (r.api?.reply?.usage) {
      summary.totals.api.totalTokens += (r.api.reply.usage.inputTokens || 0) + (r.api.reply.usage.outputTokens || 0);
    }
  }

  // Reply length comparison
  let ccTotalLen = 0, apiTotalLen = 0, ccCount = 0, apiCount = 0;
  for (const r of Object.values(status.results)) {
    if (r.cc?.reply?.text) { ccTotalLen += r.cc.reply.text.length; ccCount++; }
    if (r.api?.reply?.text) { apiTotalLen += r.api.reply.text.length; apiCount++; }
  }
  summary.replyLength = {
    ccAvg: ccCount > 0 ? Math.round(ccTotalLen / ccCount) : 0,
    apiAvg: apiCount > 0 ? Math.round(apiTotalLen / apiCount) : 0,
  };

  summary.totals.cc.avgMs = summary.totals.compared > 0 ? Math.round(summary.totals.cc.totalMs / summary.totals.compared) : 0;
  summary.totals.api.avgMs = summary.totals.compared > 0 ? Math.round(summary.totals.api.totalMs / summary.totals.compared) : 0;

  return summary;
}

// ─── Main ──────────────────────────────────────────────────────
async function main() {
  console.log("=== A/B Compare: CC CLI vs Direct API ===\n");

  // Verify Claude Code exists
  if (!fs.existsSync(CLAUDE_PATH)) {
    console.error(`ERROR: Claude Code not found at: ${CLAUDE_PATH}`);
    console.error("Set WECHAT_CLAUDE_PATH env var or configure paths.claude in config.json");
    process.exit(1);
  }
  console.log(`Claude Code: ${CLAUDE_PATH}`);
  console.log(`Model: ${CC_MODEL}`);

  const apiCfg = resolveApiConfig();
  if (apiCfg.apiKey) {
    console.log(`API Base URL: ${apiCfg.baseUrl}`);
    console.log(`API Model: ${apiCfg.model}`);
  } else {
    console.log(`API: NOT CONFIGURED — set --api-key or AB_API_KEY to enable API comparisons`);
    console.log(`  (CC-only mode: will run CC path and save baseline data)`);
  }
  console.log("");

  // Load chat history
  const allEvents = loadAllEvents();
  console.log(`Loaded ${allEvents.length} chat history events`);

  const groups = buildConversationGroups(allEvents);
  console.log(`Found ${groups.length} conversation groups`);

  const samples = selectSamples(groups);
  console.log(`Selected ${samples.length} samples across ${new Set(samples.map(s => s.type)).size} types:`);
  for (const [i, s] of samples.entries()) {
    console.log(`  ${i + 1}. [${s.type}] ${s.group.sessionName} — ${s.messages.length} messages`);
  }

  if (FLAG_DRY_RUN) {
    console.log("\n--dry-run: stopping after sample selection.");
    return;
  }

  // Load or init status
  let status = loadStatus();
  const completedSet = new Set(status.completed || []);

  // Run comparisons
  console.log(`\nRunning comparisons...`);
  let runCount = 0;
  for (const sample of samples) {
    if (EXCLUDE_TYPES.has(sample.type)) { console.log(`  SKIP type ${sample.type} (excluded)`); continue; }
    if (LIMIT && runCount >= LIMIT) break;
    const dir = sampleDir(sample);
    ensureDir(dir);

    for (let i = 0; i < sample.messages.length; i++) {
      if (LIMIT && runCount >= LIMIT) break;
      const key = sampleKey(sample, i);
      if (FLAG_RESUME && completedSet.has(key)) {
        console.log(`  SKIP ${key} (already completed)`);
        continue;
      }
      if (LIMIT && runCount >= LIMIT) {
        console.log(`  STOP (limit ${LIMIT} reached)`);
        break;
      }

      const userMsg = sample.messages[i];
      console.log(`\n[${runCount + 1}] ${key}`);
      console.log(`  User: ${(userMsg.text || "").slice(0, 80)}`);

      try {
        const result = await runOneComparison(sample, i, userMsg);
        status.results[key] = result;
        status.completed.push(key);
        status.completed = [...new Set(status.completed)];
        saveStatus(status);
        const resultFile = path.join(dir, `turn_${String(i).padStart(3, "0")}.json`);
        fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), "utf-8");

        const ccOk = result.cc?.reply?.success ? "OK" : "FAIL";
        const apiOk = result.api?.reply?.success ? "OK" : (result.api?.reply ? "FAIL" : "SKIP");
        const ccLen = result.cc?.reply?.text?.length || 0;
        const apiLen = result.api?.reply?.text?.length || 0;
        console.log(`  CC: ${ccOk} (${ccLen} chars, ${result.cc?.reply?.durationMs || 0}ms)`);
        console.log(`  API: ${apiOk} (${apiLen} chars, ${result.api?.reply?.durationMs || 0}ms)`);
        runCount++;
      } catch (e) {
        console.error(`  ERROR [${key}]: ${e.message}`);
        status.results[key] = { key, type: sample.type, error: e.message, cc: { scenelet: null, reply: null }, api: { scenelet: null, reply: null } };
        status.completed.push(key);
        status.completed = [...new Set(status.completed)];
        saveStatus(status);
        // Continue to next sample — don't let one failure stop everything
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  // Generate summary
  status = loadStatus(); // reload latest
  const summary = generateSummary(status);
  const summaryFile = path.join(OUTPUT_DIR, "summary.json");
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), "utf-8");

  // Generate labeled comparison report
  generateComparisonReport(status.results, status);

  // Print summary
  console.log("\n=== Summary ===");
  console.log(`Total comparisons: ${summary.totals.compared}`);
  console.log(`CC scenelet OK: ${summary.totals.cc.sceneletOk}/${summary.totals.compared}`);
  console.log(`API scenelet OK: ${summary.totals.api.sceneletOk}/${summary.totals.compared}`);
  console.log(`CC reply OK: ${summary.totals.cc.replyOk}/${summary.totals.compared}`);
  console.log(`API reply OK: ${summary.totals.api.replyOk}/${summary.totals.compared}`);
  console.log(`CC avg time: ${summary.totals.cc.avgMs}ms`);
  console.log(`API avg time: ${summary.totals.api.avgMs}ms`);
  console.log(`CC avg reply length: ${summary.replyLength.ccAvg} chars`);
  console.log(`API avg reply length: ${summary.replyLength.apiAvg} chars`);
  console.log(`CC estimated cost: $${summary.totals.cc.totalCost.toFixed(4)}`);
  console.log(`\nComparison report: ${path.join(OUTPUT_DIR, "report", "comparison.md")}`);
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
