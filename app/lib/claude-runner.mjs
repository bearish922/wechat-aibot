import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execSync } from "node:child_process";
import { configValue, envOrConfig, configBool, configNumber } from "./config.mjs";
import { DATA_DIR, RUNTIME_DIR, appPath, dataPath, ensureDir, rootPath } from "./paths.mjs";
import { log } from "./utils.mjs";
import { shouldSkipRag } from "./rag.mjs";
import { loadPrompts } from "./reply.mjs";
import { profileTemplates } from "./state.mjs";

const USER_HOME = process.env.USERPROFILE || process.env.HOME || process.cwd();
const DEFAULT_NPM_GLOBAL = process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : path.join(USER_HOME, "AppData", "Roaming", "npm");
function usableConfigString(value, fallback) {
  const text = String(value ?? "").trim();
  return text && !/^(填写|可选)/u.test(text) ? text : fallback;
}
function commandOnPath(command) {
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const result = spawn(finder, [command], { encoding: "utf8", timeout: 3000, windowsHide: true });
  if (result.status !== 0) return null;
  const found = (result.stdout || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return found.filter(p => /\.exe$/i.test(p))[0] || found.filter(p => /\.(cmd|bat)$/i.test(p))[0] || found[0] || null;
}
const NPM_GLOBAL = usableConfigString(configValue("paths.npmGlobal", DEFAULT_NPM_GLOBAL), DEFAULT_NPM_GLOBAL);
function latestExisting(paths) {
  return paths
    .filter(p => p && fs.existsSync(p))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
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
function firstExisting(paths) {
  return paths.find(p => p && fs.existsSync(p)) || null;
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
const CLAUDE_MAIN_MODEL = envOrConfig("WECHAT_CLAUDE_MAIN_MODEL", "models.claudeMain", "deepseek-v4-pro[1m]");
const CLAUDE_FAST_MODEL = envOrConfig("WECHAT_CLAUDE_FAST_MODEL", "models.claudeFast", "deepseek-v4-flash[1m]");
const CLAUDE_FALLBACK_MODEL = envOrConfig("WECHAT_CLAUDE_FALLBACK_MODEL", "models.claudeFallback", "deepseek-v4-pro[1m]");
const SCENELET_MODEL = envOrConfig("WECHAT_SCENELET_MODEL", "models.scenelet", "deepseek-v4-pro[1m]");
const SCENELET_BARE = configBool("scene.sceneletBare", false);
const CLAUDE_TIMEOUT_MS = configNumber("timeouts.aiMs", 600_000);
const LOGS_DIR = dataPath("logs");

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

function runClaudeStream(ai, sid, sessionName, body, firstTurn, onEvent, stylePrompt, memoryPrompt = "", profileOverride = null, options = {}) {
  const profile = profileOverride;
  const fastCasual = shouldSkipRag(options.routingBody || body);
  const systemPromptParts = [];
  if (profile && profileTemplates[profile]) systemPromptParts.push(profileTemplates[profile]);
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

function buildRagContextBlock(ragContext) {
  if (!ragContext) return "";
  const cfg = loadPrompts();
  return [
    "【本轮知识库检索结果】",
    cfg.ragContextInstruction,
    ragContext,
  ].filter(Boolean).join("\n");
}

function buildCodexPrompt(ai, userBody, ragContext, stylePrompt, memoryPrompt = "", profileOverride = null) {
  const profile = profileOverride;
  const systemParts = [];
  if (profile && profileTemplates[profile]) {
    systemParts.push(profileTemplates[profile]);
  }
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

export {
  usableConfigString,
  firstExisting,
  listDirs,
  latestExisting,
  commandOnPath,
  claudeNativeFallback,
  isNpmClaudeStub,
  resolveClaudeCommand,
  needsWindowsShell,
  spawnCli,
  envWithProxy,
  commandExists,
  stripJsonFences,
  parseHiddenJson,
  runHiddenJson,
  runClaudeStream,
  buildCodexPrompt,
  runCodexStream,
  toolUsageFromUsage,
  usageSummary,
  writeHiddenUsageEvent,
  killProc,
  CLAUDE,
  CLAUDE_MAIN_MODEL,
  CLAUDE_FAST_MODEL,
  CLAUDE_FALLBACK_MODEL,
  SCENELET_MODEL,
  SCENELET_BARE,
  CLAUDE_HTTPS_PROXY,
  CODEX_HTTPS_PROXY,
  CLAUDE_TIMEOUT_MS,
  AI_WORK_DIR,
  NODE,
  CODEX,
  LOGS_DIR,
};
