import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync, execSync } from "node:child_process";
import { configValue, envOrConfig, configBool, configNumber } from "./config.mjs";
import { RUNTIME_DIR, dataPath, ensureDir } from "./paths.mjs";
import { log } from "./utils.mjs";
import { loadPrompts } from "./reply.mjs";
import { profileTemplates } from "./state.mjs";
import { apiChatStream, apiChatJson, apiChatWithTools, isApiConfigured, resolveApiConfig } from "./api-client.mjs";

const USER_HOME = process.env.USERPROFILE || process.env.HOME || process.cwd();
const DEFAULT_NPM_GLOBAL = process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : path.join(USER_HOME, "AppData", "Roaming", "npm");
// usableConfigString - 对配置字符串进行可用性校验
// 参数: value - 原始配置值; fallback - 当 value 无效时的后备值
// 返回: 如果 value 是有效字符串（非空、非占位文本如"填写"或"可选"），返回 value，否则返回 fallback
function usableConfigString(value, fallback) {
  // 将 value 转为去首尾空格的字符串
  const text = String(value ?? "").trim();
  // 如果 text 非空且不包含中文占位关键词，则视为有效配置
  return text && !/^(填写|可选)/u.test(text) ? text : fallback;
}
// commandOnPath - 在系统 PATH 中查找命令的完整路径
// 参数: command - 要查找的命令名
// 返回: 找到的 .exe 文件路径，优先返回 .exe 后缀的，其次 .cmd/.bat，最后取第一条结果；未找到返回 null
function commandOnPath(command) {
  // 根据平台选择查找命令：Windows 用 where.exe, Unix 用 which
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(finder, [command], { encoding: "utf8", timeout: 3000, windowsHide: true });
  // 命令执行失败则返回 null
  if (result.status !== 0) return null;
  // 解析输出，按行分割并去除空行
  const found = (result.stdout || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  // 优先返回 .exe 路径，其次 .cmd/.bat，最后取第一条结果
  return found.filter(p => /\.exe$/i.test(p))[0] || found.filter(p => /\.(cmd|bat)$/i.test(p))[0] || found[0] || null;
}
const NPM_GLOBAL = usableConfigString(configValue("paths.npmGlobal", DEFAULT_NPM_GLOBAL), DEFAULT_NPM_GLOBAL);
// latestExisting - 从一组路径中选出最新修改的文件
// 参数: paths - 文件路径数组
// 返回: 存在且 mtimeMs 最大的文件路径，全不存在时返回 null
function latestExisting(paths) {
  return paths
    // 过滤掉不存在的路径
    .filter(p => p && fs.existsSync(p))
    // 按修改时间降序排列，取最新者
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}
// listDirs - 列出指定目录下所有直接子目录的名称
// 参数: parent - 父目录路径
// 返回: 子目录名称数组，如果目录不存在或无法读取则返回空数组
function listDirs(parent) {
  try {
    return fs.readdirSync(parent, { withFileTypes: true })
      // 只保留目录类型
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    // 读取失败时返回空数组
    return [];
  }
}
// claudeNativeFallback - 在不支持直接使用 npm 全局 stub 时查找 Claude 原生可执行文件的路径
// 仅在 Windows 平台下工作，搜索 npm 全局安装目录下的临时安装目录和 Claude Desktop 缓存目录
// 参数: 无
// 返回: 找到的最新 claude.exe 路径，未找到返回 null
function claudeNativeFallback() {
  // 非 Windows 平台直接返回 null
  if (process.platform !== "win32") return null;
  // 根据 CPU 架构确定二进制目录名
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const anthropicDir = path.join(NPM_GLOBAL, "node_modules", "@anthropic-ai");
  // 扫描临时安装目录（npm 安装时的临时缓存目录前缀为 .claude-code-）
  const tempCandidates = listDirs(anthropicDir)
    .filter(name => name.startsWith(".claude-code-"))
    .map(name => path.join(anthropicDir, name, "node_modules", "@anthropic-ai", `claude-code-win32-${arch}`, "claude.exe"));
  // Claude Desktop 应用的本地缓存目录
  const claudeDesktopCache = path.join(
    process.env.LOCALAPPDATA || path.join(USER_HOME, "AppData", "Local"),
    "Packages",
    "Claude_pzs8sxrjxfjjc",
    "LocalCache",
    "Roaming",
    "Claude",
    "claude-code",
  );
  // 扫描 Claude Desktop 缓存中的 claude.exe
  const desktopCandidates = listDirs(claudeDesktopCache).map(name => path.join(claudeDesktopCache, name, "claude.exe"));
  // 在所有候选路径中返回最新存在的那个
  return latestExisting([
    // 标准的 npm 全局安装路径
    path.join(anthropicDir, "claude-code", "node_modules", "@anthropic-ai", `claude-code-win32-${arch}`, "claude.exe"),
    ...tempCandidates,
    ...desktopCandidates,
  ]);
}
// isNpmClaudeStub - 检测给定命令是否为 npm 全局安装的小体积 stub 文件
// npm 全局安装的 claude-code 会生成一个极小的占位 exe（<4KB），实际二进制在别处
// 参数: command - 要检测的命令路径
// 返回: 如果是 Windows 下的 npm claude stub 文件则返回 true，否则 false
function isNpmClaudeStub(command) {
  try {
    const normalized = path.normalize(command).toLowerCase();
    // 判断条件：Windows平台 + 路径指向 npm 全局包路径 + 文件小于 4096 字节
    return process.platform === "win32"
      && normalized.endsWith(path.normalize("@anthropic-ai/claude-code/bin/claude.exe").toLowerCase())
      && fs.statSync(command).size < 4096;
  } catch {
    // 无法读取文件时返回 false
    return false;
  }
}
// resolveClaudeCommand - 解析最终的 Claude 命令路径
// 如果给定命令是 npm stub 文件，尝试找到真实的原生可执行文件作为替代
// 参数: command - 当前配置的 Claude 命令路径
// 返回: 真实可用的 Claude 命令路径；如果找不到原生二进制，则回退到原命令
function resolveClaudeCommand(command) {
  // 不是 npm stub 就直接使用
  if (!isNpmClaudeStub(command)) return command;
  // 是 stub 则尝试查找原生可执行文件，找不到则回退到原命令
  return claudeNativeFallback() || command;
}
// firstExisting - 返回数组中第一个在文件系统中存在的路径
// 参数: paths - 候选路径数组
// 返回: 第一个存在的路径，全部不存在则返回 null
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
const CODEX_MAIN_MODEL = usableConfigString(envOrConfig("WECHAT_CODEX_MAIN_MODEL", "models.codexMain", "gpt-5.5"), "gpt-5.5");
const CODEX_REASONING_EFFORT = usableConfigString(envOrConfig("WECHAT_CODEX_REASONING_EFFORT", "models.codexReasoningEffort", "high"), "high");
const SCENELET_BARE = configBool("scene.sceneletBare", false);
const CLAUDE_TIMEOUT_MS = configNumber("timeouts.aiMs", 600_000);
const LOGS_DIR = dataPath("logs");

// needsWindowsShell - 判断给定命令在 Windows 下是否需要通过 shell 启动
// 无扩展名的命令、.cmd/.bat/.ps1 脚本都需要通过 shell 执行
// 参数: command - 命令路径
// 返回: 需要 shell 则 true，否则 false
function needsWindowsShell(command) {
  return process.platform === "win32" && (!path.extname(command) || /\.(cmd|bat|ps1)$/i.test(command));
}

// spawnCli - 智能派生子进程，自动处理 Windows 下的 shell 需求
// 参数: command - 要执行的命令; args - 命令行参数数组; options - spawn 选项（可覆盖 shell 设置）
// 返回: ChildProcess 对象
function spawnCli(command, args, options = {}) {
  return spawn(command, args, {
    ...options,
    // 如果调用者未显式设置 shell，则根据平台和命令类型自动判断
    shell: options.shell ?? needsWindowsShell(command),
  });
}

// envWithProxy - 构建带有代理设置的环境变量对象
// 如果提供了代理 URL，则同时设置大小写形式的 HTTP_PROXY 和 HTTPS_PROXY
// 参数: proxyUrl - 代理 URL（可为空）; extra - 额外要合并的环境变量
// 返回: 合并后的环境变量对象
function envWithProxy(proxyUrl, extra = {}) {
  // 以当前进程环境变量为基础，合并额外变量
  const env = { ...process.env, ...extra };
  if (proxyUrl && String(proxyUrl).trim()) {
    const value = String(proxyUrl).trim();
    // 同时设置大写和小写形式的代理变量以兼容不同的工具
    env.HTTP_PROXY = value;
    env.HTTPS_PROXY = value;
    env.http_proxy = value;
    env.https_proxy = value;
  } else {
    // 未提供代理时清除所有代理环境变量，避免残留影响
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
    delete env.http_proxy;
    delete env.https_proxy;
  }
  return env;
}

// commandExists - 检查命令是否存在于文件系统或 PATH 中
// 参数: command - 命令路径或名称
// 返回: 存在则 true，否则 false
function commandExists(command) {
  // 先检查直接路径是否存在，再检查是否在 PATH 中可找到
  return fs.existsSync(command) || Boolean(commandOnPath(command));
}

// stripJsonFences - 去除文本两端的 Markdown 代码块标记
// 处理 AI 输出中常见的 ```json ... ``` 包裹格式，提取纯 JSON 文本
// 参数: text - 可能包含 Markdown fences 的文本
// 返回: 去除 fences 后的纯文本
function stripJsonFences(text = "") {
  return String(text).trim()
    // 去除开头的 ``` 或 ```json
    .replace(/^```(?:json)?\s*/i, "")
    // 去除结尾的 ```
    .replace(/\s*```$/i, "")
    .trim();
}

// parseHiddenJson - 从 AI 原始输出中解析 JSON 对象
// 先尝试整体解析，失败则提取第一个 { 到最后一个 } 之间的内容再解析
// 参数: raw - AI 输出的原始文本（可能包裹在 Markdown fences 中或混有非 JSON 文本）
// 返回: 解析后的 JavaScript 对象
// 抛出: 当无法找到有效 JSON 对象时抛出 Error
function parseHiddenJson(raw) {
  // 先去除 Markdown 代码块标记
  const trimmed = stripJsonFences(raw);
  // 尝试直接整体解析 JSON
  try { return JSON.parse(trimmed); } catch {}
  // 整体解析失败时，尝试提取最外层花括号之间的内容
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  // 完全找不到 JSON 对象时抛出错误
  throw new Error("hidden call returned no JSON object");
}

// emptyToolUsage - 返回一个空的工具使用统计对象
// 参数: 无
// 返回: 包含 webSearch/webFetch 计数（均为0）和空工具列表的对象
function emptyToolUsage() {
  return { webSearch: 0, webFetch: 0, tools: [] };
}

// normalizeToolUsage - 将原始的工具使用记录标准化为统一格式
// 兼容不同的字段命名（webSearch/web_search_requests, webFetch/web_fetch_requests），
// 并对 tools 数组去重
// 参数: raw - 原始的工具使用记录对象（可为 null）
// 返回: 标准化后的工具使用对象，输入无效时返回 null
function normalizeToolUsage(raw = null) {
  // 输入非对象时返回 null
  if (!raw || typeof raw !== "object") return null;
  // 对工具名列表去重并过滤空字符串
  const tools = Array.isArray(raw.tools)
    ? [...new Set(raw.tools.map(x => String(x || "").trim()).filter(Boolean))]
    : [];
  return {
    // 兼容 webSearch 和 web_search_requests 两种命名，确保最小值为 0
    webSearch: Math.max(0, Number(raw.webSearch || raw.web_search_requests || 0) || 0),
    webFetch: Math.max(0, Number(raw.webFetch || raw.web_fetch_requests || 0) || 0),
    tools,
  };
}

// toolUsageFromUsage - 从 Claude Code 的 usage 对象中提取工具使用统计
// 从 server_tool_use 子对象和顶层字段中聚合 web_search_requests 和 web_fetch_requests 数量
// 参数: raw - 包含 usage 字段的 AI 响应对象（或直接传入 usage 对象）
// 返回: 工具使用统计对象，无效输入时返回空对象
function toolUsageFromUsage(raw = null) {
  // 获取 usage 对象（兼容传入整包响应或直接传入 usage）
  const usage = raw?.usage || raw;
  if (!usage || typeof usage !== "object") return emptyToolUsage();
  // 获取 server 侧的工具使用子对象
  const server = usage.server_tool_use || {};
  const result = emptyToolUsage();
  // 汇总 WebSearch 请求数，兼容顶层 usage 和按模型拆分的 modelUsage。
  const directWebSearch = Number(server.web_search_requests || usage.web_search_requests || usage.webSearchRequests || 0) || 0;
  const modelWebSearch = raw?.modelUsage && typeof raw.modelUsage === "object"
    ? Object.values(raw.modelUsage).reduce((sum, item) => sum + (Number(item?.webSearchRequests || 0) || 0), 0)
    : 0;
  result.webSearch = Math.max(directWebSearch, modelWebSearch);
  // 汇总 WebFetch 请求数，兼容多种字段命名
  result.webFetch += Number(server.web_fetch_requests || usage.web_fetch_requests || usage.webFetchRequests || 0) || 0;
  // 根据计数决定是否将对应工具名加入列表
  if (result.webSearch > 0) result.tools.push("WebSearch");
  if (result.webFetch > 0) result.tools.push("WebFetch");
  return result;
}

// usageSummary - 从 AI 响应中提取用量摘要信息
// 汇总 token 消耗（输入、缓存读取、缓存创建、输出）和美元成本
// 参数: raw - AI 响应对象（包含 usage 字段和可选的 total_cost_usd）; modelUsage - 按模型拆分的用量数据
// 返回: 包含 token 计数和成本的摘要对象
function usageSummary(raw = null, modelUsage = null) {
  // 提取 usage 子对象，兼容传入整包响应或直接传入 usage
  const usage = raw?.usage || raw || {};
  // 确定按模型拆分的用量数据来源
  const models = modelUsage && typeof modelUsage === "object" ? modelUsage : raw?.modelUsage;
  // 从各模型条目中汇总总成本
  const costFromModels = models && typeof models === "object"
    ? Object.values(models).reduce((sum, item) => sum + (Number(item?.costUSD || 0) || 0), 0)
    : 0;
  return {
    // 输入 token 数（包括缓存命中和缓存写入）
    input_tokens: Number(usage.input_tokens || 0) || 0,
    // 从缓存中读取的 token 数（缓存命中）
    cache_read_input_tokens: Number(usage.cache_read_input_tokens || 0) || 0,
    // 新写入缓存的 token 数
    cache_creation_input_tokens: Number(usage.cache_creation_input_tokens || 0) || 0,
    // 输出 token 数
    output_tokens: Number(usage.output_tokens || 0) || 0,
    // 总成本（优先使用顶层字段，其次按模型汇总）
    cost_usd: Number(raw?.total_cost_usd || costFromModels || 0) || 0,
    // 按模型拆分的原始用量数据
    modelUsage: models || null,
  };
}

// writeHiddenUsageEvent - 将一次隐藏调用的用量事件写入 JSONL 日志文件
// 以 append 方式写入，每条事件占一行，用于后续用量分析和计费追踪
// 参数: event - 用量事件对象
// 返回: 无（写入失败时静默忽略）
function writeHiddenUsageEvent(event) {
  try {
    // 确保日志目录存在
    ensureDir(LOGS_DIR);
    // 以 JSONL 格式追加写入
    fs.appendFileSync(path.join(LOGS_DIR, "hidden-usage.jsonl"), JSON.stringify(event) + "\n", "utf-8");
  } catch {}
}

// runHiddenJson - 在后台以 JSON 输出模式调用 Claude Code，获取结构化数据
// 用于非对话场景的后台 AI 调用（如记忆提取、内容分类等），不保持会话上下文
// 参数:
//   prompt - 发送给 AI 的提示文本
//   options.label - 调用标签，用于日志区分（默认 "hidden"）
//   options.timeoutMs - 超时毫秒数（默认 300000）
//   options.bare - 是否使用 --bare 模式（仅输出结果，默认 true）
//   options.model - 指定模型（默认使用 CLAUDE_MAIN_MODEL）
//   options.sessionName - 会话名称（避免控制台提示）
//   options.sessionId - 会话 ID（持久化场景用）
//   options.firstTurn - 是否为会话首轮（决定用 --session-id 还是 --resume）
//   options.persist - 是否保持会话上下文（默认 false，即无状态调用）
//   options.systemPrompt - 系统提示词（会写入临时文件）
// 返回: 解析后的 JSON 对象（含 _toolUsage、_hiddenUsage、_hiddenCall 元数据），失败返回 null
async function runHiddenJson(prompt, { label = "hidden", timeoutMs = 300_000, bare = true, model = null, sessionName = "", sessionId = "", firstTurn = false, persist = false, systemPrompt = "" } = {}) {
  // Claude 命令不可用时直接返回 null
  if (!commandExists(CLAUDE)) return null;
  // 记录调用开始时间和模型
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const selectedModel = model || CLAUDE_MAIN_MODEL;
  // 如果有系统提示词，写入临时文件（通过 --append-system-prompt-file 传给 Claude）
  const systemPromptFile = systemPrompt
    ? path.join(RUNTIME_DIR, `.hidden_system_${label}_${crypto.randomUUID()}.txt`)
    : null;
  // 构建 Claude Code CLI 参数
  const args = [
    "-p",
    "--output-format", "json",
    "--permission-mode", "bypassPermissions",
    "--tools", "WebSearch,WebFetch",
    "--model", selectedModel,
  ];
  // 设置会话名称（避免交互式提示）
  if (sessionName) args.push("--name", sessionName);
  // 根据 persist 标志决定会话持久化方式
  if (persist) {
    // 持久模式：首轮用 --session-id 指定新会话，后续用 --resume 恢复
    if (firstTurn && sessionId) args.push("--session-id", sessionId);
    else if (sessionId) args.push("--resume", sessionId);
  } else {
    // 无状态模式：明确禁止会话持久化
    args.push("--no-session-persistence");
  }
  // --bare 模式插入到参数列表第2位（-p 之后），使输出仅包含结果无多余信息
  if (bare) args.splice(1, 0, "--bare");
  // 将系统提示词写入临时文件并添加 CLI 参数
  if (systemPromptFile) {
    ensureDir(RUNTIME_DIR);
    fs.writeFileSync(systemPromptFile, systemPrompt, "utf-8");
    args.push("--append-system-prompt-file", systemPromptFile);
  }
  // 启动子进程，设置工作目录、隐藏窗口、管道 I/O
  const proc = spawnCli(CLAUDE, args, {
    cwd: AI_WORK_DIR,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: envWithProxy(CLAUDE_HTTPS_PROXY),
  });
  // 忽略 stdin 错误，将 prompt 写入 stdin 后关闭
  proc.stdin.on("error", () => {});
  proc.stdin.end(prompt, "utf8");
  // 收集 stdout 和 stderr 的输出
  let stdout = "";
  let stderr = "";
  let timer;
  // 等待子进程结束，设置超时定时器
  const code = await new Promise(resolve => {
    // 超时后强制杀掉子进程
    timer = setTimeout(() => {
      killProc(proc);
      resolve(null);
    }, timeoutMs);
    // 收集标准输出
    proc.stdout.on("data", d => { stdout += d; });
    // 收集标准错误，最多保留末尾 3000 字符
    proc.stderr.on("data", d => { stderr += d; if (stderr.length > 3000) stderr = stderr.slice(-3000); });
    // 正常退出时清除定时器并返回退出码
    proc.on("close", c => { clearTimeout(timer); resolve(c); });
    // 进程错误时清除定时器并返回 -1
    proc.on("error", () => { clearTimeout(timer); resolve(-1); });
  }).finally(() => {
    // 无论结果如何，清理定时器和临时文件
    clearTimeout(timer);
    if (systemPromptFile) { try { fs.rmSync(systemPromptFile, { force: true }); } catch {} }
  });
  // 构建基础的用量事件对象，用于后续写日志
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
  // 非零退出码且无标准输出时视为完全失败
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
    // 解析 Claude 的外层 JSON 输出
    const outer = parseHiddenJson(stdout);
    // 提取实际内容（优先取 result 字段，其次 message、text，最后使用原始 stdout）
    const content = outer.result || outer.message || outer.text || stdout;
    let parsed;
    try {
      // 如果 content 是字符串，尝试再次解析内层 JSON
      parsed = typeof content === "string" ? parseHiddenJson(content) : outer;
    } catch {
      // 内层解析失败时使用原始 content
      parsed = content;
    }
    // 如果解析结果是对象，附加工具使用统计和用量摘要等元数据
    if (parsed && typeof parsed === "object") {
      parsed._toolUsage = toolUsageFromUsage(outer);
      parsed._hiddenUsage = usageSummary(outer, outer.modelUsage);
      parsed._hiddenCall = {
        ...baseUsageEvent,
        session_id: outer.session_id || sessionId || null,
        duration_ms: Date.now() - startedMs,
        success: true,
        output_chars: String(content || "").length,
        toolUsage: parsed._toolUsage,
        ...parsed._hiddenUsage,
      };
      // 将成功的调用写入用量日志
      writeHiddenUsageEvent(parsed._hiddenCall);
    }
    return parsed;
  } catch (e) {
    // JSON 解析失败时记录警告并写入失败日志
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

// runClaudeStream - 以 stream-json 模式启动 Claude Code 进行流式对话
// 将 AI 输出逐行解析为 JSON 事件，通过 onEvent 回调实时推送
// 参数:
//   ai - AI 引擎标识（用于日志）
//   sid - 会话 ID
//   sessionName - 会话名（用于 AI 工作目录隔离）
//   body - 用户消息正文
//   firstTurn - 是否为首轮对话（决定会话管理方式）
//   onEvent - 每行 JSON 事件回调函数
//   stylePrompt - 角色/风格提示词（拼入系统提示）
//   memoryPrompt - 记忆上下文提示词（可选拼入系统提示）
//   profileOverride - 角色配置文件覆盖
//   options - 额外选项 { sceneMemoryPrompt, includeMemoryInSystem, includeStyleInSystem, noSessionPersistence }
// 返回: Promise，resolve 时返回 { code, stderr, killed }；promise 上挂载 .proc 引用
function runClaudeStream(ai, sid, sessionName, body, firstTurn, onEvent, stylePrompt, memoryPrompt = "", profileOverride = null, options = {}) {
  const profile = profileOverride;
  // 按优先级拼接系统提示词的各个组成部分
  const systemPromptParts = [];
  // 1) 角色模板（最高优先级）
  if (profile && profileTemplates[profile]) systemPromptParts.push(profileTemplates[profile]);
  // 2) 记忆上下文（仅在显式配置为纳入系统提示时添加）
  if (memoryPrompt && options.includeMemoryInSystem === true) systemPromptParts.push(memoryPrompt);
  // 3) 风格提示词（默认包含，除非显式设为 false）
  if (stylePrompt && options.includeStyleInSystem !== false) systemPromptParts.push(stylePrompt);
  // 如果有系统提示内容，写入临时文件
  const systemPromptFile = systemPromptParts.length
    ? path.join(RUNTIME_DIR, `.claude_system_${crypto.randomUUID()}.txt`)
    : null;

  // 构建 Claude Code CLI 参数列表
  const args = [
    "-p",
    "--name", sessionName,
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "bypassPermissions",
  ];
  // 有角色配置时启用 WebSearch 和 WebFetch 工具
  if (profile && profileTemplates[profile]) {
    args.push("--tools", "WebSearch,WebFetch");
  }
  // 根据是否持久化选择会话管理方式
  if (options.noSessionPersistence) {
    // 无会话持久化：每次调用都是独立的
    args.push("--no-session-persistence");
  } else if (firstTurn) {
    // 首轮：指定新会话 ID
    args.push("--session-id", sid);
  } else {
    // 后续轮次：恢复已有会话
    args.push("--resume", sid);
  }
  // 指定主模型
  args.push("--model", CLAUDE_MAIN_MODEL);
  // 配置 fallback 模型（主模型不可用时的备选）
  if (CLAUDE_FALLBACK_MODEL && CLAUDE_FALLBACK_MODEL !== CLAUDE_MAIN_MODEL) {
    args.push("--fallback-model", CLAUDE_FALLBACK_MODEL);
  }
  // 将系统提示词写入临时文件
  if (systemPromptFile) {
    ensureDir(RUNTIME_DIR);
    // 各部分用 --- 分隔拼接
    fs.writeFileSync(systemPromptFile, systemPromptParts.join("\n\n---\n\n"), "utf-8");
    args.push("--append-system-prompt-file", systemPromptFile);
  }
  // 启动子进程
  const proc = spawnCli(CLAUDE, args, {
    cwd: AI_WORK_DIR,
    timeout: CLAUDE_TIMEOUT_MS,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: envWithProxy(CLAUDE_HTTPS_PROXY),
  });

  // 将用户消息写入 stdin 后关闭
  proc.stdin.on("error", () => {});
  proc.stdin.end(body, "utf8");

  // 缓冲区和状态变量
  let buf = "";        // stdout 行缓冲（处理跨 data chunk 的断行）
  let stderrOut = "";  // stderr 输出（保留末尾最多 5000 字符）
  let resolved = false; // 防止重复 resolve

  // 处理流式 stdout：按行分割，每行尝试解析为 JSON 事件并回调
  proc.stdout.on("data", d => {
    buf += d;
    const lines = buf.split("\n");
    // 最后一段可能是不完整的行，保留在缓冲区
    buf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // 尝试解析每一行为 JSON，非 JSON 行静默跳过
      try { onEvent(JSON.parse(trimmed)); } catch { /* 跳过非 JSON 行，静默忽略 */ }
    }
  });
  // 收集 stderr 输出，限制最大长度
  proc.stderr.on("data", d => { stderrOut += d; if (stderrOut.length > 5000) stderrOut = stderrOut.slice(-5000); });

  // 构建返回的 Promise，封装进程结束的处理逻辑
  const promise = new Promise((resolve) => {
    proc.on("close", (code) => {
      // 非零退出码时记录警告
      if (code !== 0) log("⚠", `[${sessionName}] CC exited code=${code}`);
      // 清理临时系统提示词文件
      if (systemPromptFile) { try { fs.rmSync(systemPromptFile, { force: true }); } catch {} }
      if (resolved) return;
      resolved = true;
      // 处理缓冲区中残留的最后一整行数据
      if (buf.trim()) { try { onEvent(JSON.parse(buf.trim())); } catch { /* 跳过残留缓冲区的解析错误 */ } }
      resolve({ code, stderr: stderrOut, killed: proc.killed });
    });
    proc.on("error", (e) => {
      // 进程启动/运行出错时的清理和 resolve
      if (systemPromptFile) { try { fs.rmSync(systemPromptFile, { force: true }); } catch {} }
      if (resolved) return;
      resolved = true;
      resolve({ code: -1, stderr: e.message, killed: false });
    });
  });

  // 将子进程引用挂载到 Promise 上，方便外部调用 killProc
  promise.proc = proc;
  return promise;
}

// buildRagContextBlock - 构建 RAG（检索增强生成）上下文块
// 将知识库检索结果与配置中的引导指令拼接为结构化文本块
// 参数: ragContext - RAG 检索结果文本（可为空）
// 返回: 格式化后的上下文块字符串，ragContext 为空时返回空字符串
function buildRagContextBlock(ragContext, profile = "") {
  if (!ragContext) return "";
  const cfg = loadPrompts(profile);
  return [
    "【本轮知识库检索结果】",
    cfg.ragContextInstruction,
    ragContext,
  ].filter(Boolean).join("\n");
}

// buildCodexPrompt - 构建用于 Codex（OpenAI Codex CLI）的完整提示文本
// 将角色配置、风格提示、RAG 上下文和用户消息拼接为单一提示字符串
// 参数:
//   ai - AI 引擎标识
//   userBody - 用户消息正文
//   ragContext - RAG 检索结果（可选）
//   stylePrompt - 风格提示词
//   profileOverride - 角色配置文件覆盖
// 返回: 拼接完成的完整提示文本
function buildCodexPrompt(ai, userBody, ragContext, profile = "") {
  let prompt = userBody;
  // 如果有 RAG 检索结果，将其作为最高优先级的上下文块前置
  if (ragContext) {
    prompt = [
      buildRagContextBlock(ragContext, profile),
      "",
      "---",
      "",
      prompt,
    ].join("\n");
  }
  return prompt;
}

function codexTomlString(value) {
  return JSON.stringify(String(value || ""));
}

function codexSystemPrompt(stylePrompt, memoryPrompt = "", profileOverride = null) {
  const parts = [];
  if (profileOverride && profileTemplates[profileOverride]) parts.push(profileTemplates[profileOverride]);
  if (memoryPrompt) parts.push(memoryPrompt);
  if (stylePrompt) parts.push(stylePrompt);
  return parts.join("\n\n---\n\n");
}

function codexUsageSummary(usage = null) {
  if (!usage || typeof usage !== "object") return null;
  return {
    input_tokens: Number(usage.input_tokens || 0) || 0,
    cache_read_input_tokens: Number(usage.cached_input_tokens || usage.cache_read_input_tokens || 0) || 0,
    cache_creation_input_tokens: 0,
    output_tokens: Number(usage.output_tokens || 0) || 0,
    reasoning_output_tokens: Number(usage.reasoning_output_tokens || 0) || 0,
  };
}

function codexToolName(item = null) {
  const type = String(item?.type || "");
  if (type === "web_search" || type === "webSearch") return "WebSearch";
  if (type === "mcp_tool_call" || type === "mcpToolCall") return item?.tool || item?.name || "MCP";
  if (type === "command_execution" || type === "commandExecution") return "Shell";
  if (type === "dynamic_tool_call" || type === "dynamicToolCall") return item?.tool || "DynamicTool";
  return "";
}

function createCodexEventState(sessionId = "") {
  return {
    threadId: sessionId || "",
    text: "",
    usage: null,
    toolUsage: emptyToolUsage(),
  };
}

function reduceCodexEvent(state, event) {
  if (event?.type === "thread.started" && event.thread_id) state.threadId = String(event.thread_id);
  if (event?.type === "item.completed") {
    const item = event.item || {};
    if ((item.type === "agent_message" || item.type === "agentMessage") && item.text) state.text += String(item.text);
    const tool = codexToolName(item);
    if (tool) {
      if (!state.toolUsage.tools.includes(tool)) state.toolUsage.tools.push(tool);
      if (tool === "WebSearch") state.toolUsage.webSearch += 1;
    }
  }
  if (event?.type === "turn.completed") state.usage = codexUsageSummary(event.usage);
  return state;
}

function codexAppServerUsage(tokenUsage = null) {
  const last = tokenUsage?.last || {};
  const total = tokenUsage?.total || {};
  return {
    input_tokens: Number(last.inputTokens || 0) || 0,
    cache_read_input_tokens: Number(last.cachedInputTokens || 0) || 0,
    cache_creation_input_tokens: 0,
    output_tokens: Number(last.outputTokens || 0) || 0,
    reasoning_output_tokens: Number(last.reasoningOutputTokens || 0) || 0,
    total_input_tokens: Number(total.inputTokens || 0) || 0,
    total_output_tokens: Number(total.outputTokens || 0) || 0,
    model_context_window: Number(tokenUsage?.modelContextWindow || 0) || 0,
  };
}

function runCodexAppServer(prompt, {
  sessionId = "",
  persist = true,
  systemPrompt = "",
  model = "",
  allowWebSearch = false,
  timeoutMs = CLAUDE_TIMEOUT_MS,
  onEvent = () => {},
} = {}) {
  const args = ["app-server", "--listen", "stdio://"];
  const codexCommand = /\.js$/i.test(CODEX) ? NODE : CODEX;
  const codexArgs = /\.js$/i.test(CODEX) ? [CODEX, ...args] : args;
  const proc = spawnCli(codexCommand, codexArgs, {
    cwd: AI_WORK_DIR,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: envWithProxy(CODEX_HTTPS_PROXY),
  });
  proc.stdin.on("error", () => {});

  let nextRequestId = 1;
  let stdoutBuf = "";
  let stderrOut = "";
  let threadId = sessionId || "";
  let turnId = "";
  let text = "";
  let usage = null;
  let completed = false;
  let timedOut = false;
  let settled = false;
  const toolUsage = emptyToolUsage();
  const pending = new Map();

  const send = message => proc.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  const notify = (method, params = {}) => send({ method, params });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextRequestId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });

  let resolveResult;
  const promise = new Promise(resolve => { resolveResult = resolve; });
  promise.proc = proc;

  const finish = (code, error = "") => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    for (const waiter of pending.values()) waiter.reject(new Error(error || "Codex app-server stopped"));
    pending.clear();
    resolveResult({
      code,
      stderr: error || stderrOut,
      killed: proc.killed,
      timedOut,
      threadId,
      text,
      usage,
      toolUsage,
    });
    if (proc.exitCode === null && proc.pid) killProc(proc);
  };

  const handleNotification = message => {
    const method = message?.method;
    const params = message?.params || {};
    if (method === "item/agentMessage/delta" && params.threadId === threadId) {
      const delta = String(params.delta || "");
      text += delta;
      onEvent(message);
      return;
    }
    if (method === "item/completed" && params.threadId === threadId) {
      const item = params.item || {};
      if (!text && item.type === "agentMessage" && item.text) text = String(item.text);
      const tool = codexToolName(item);
      if (tool) {
        if (!toolUsage.tools.includes(tool)) toolUsage.tools.push(tool);
        if (tool === "WebSearch") toolUsage.webSearch += 1;
      }
      onEvent(message);
      return;
    }
    if (method === "thread/tokenUsage/updated" && params.threadId === threadId) {
      usage = codexAppServerUsage(params.tokenUsage);
      onEvent(message);
      return;
    }
    if (method === "turn/completed" && params.threadId === threadId) {
      if (turnId && params.turn?.id && params.turn.id !== turnId) return;
      completed = true;
      const status = params.turn?.status || "completed";
      const error = params.turn?.error?.message || (status === "completed" ? "" : `Codex turn ${status}`);
      finish(status === "completed" ? 0 : -1, error);
      return;
    }
    onEvent(message);
  };

  const handleMessage = message => {
    if (Object.prototype.hasOwnProperty.call(message || {}, "id")) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else waiter.resolve(message.result || {});
      return;
    }
    handleNotification(message);
  };

  proc.stdout.on("data", chunk => {
    stdoutBuf += chunk;
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { handleMessage(JSON.parse(line)); } catch {}
    }
  });
  proc.stderr.on("data", chunk => {
    stderrOut += chunk;
    if (stderrOut.length > 5000) stderrOut = stderrOut.slice(-5000);
  });
  proc.on("error", error => finish(-1, error.message));
  proc.on("close", code => {
    if (stdoutBuf.trim()) { try { handleMessage(JSON.parse(stdoutBuf)); } catch {} }
    if (!settled) finish(completed ? 0 : (code ?? -1), stderrOut || "Codex app-server exited before turn completion");
  });

  const timer = setTimeout(() => {
    timedOut = true;
    finish(-1, `Codex app-server timed out after ${timeoutMs}ms`);
  }, timeoutMs);

  (async () => {
    try {
      await request("initialize", {
        clientInfo: { name: "weixin-aibot", title: "Weixin AI Bot", version: "1" },
        capabilities: { experimentalApi: true },
      });
      notify("initialized");

      const threadParams = {
        model: model || CODEX_MAIN_MODEL,
        cwd: AI_WORK_DIR,
        approvalPolicy: "never",
        sandbox: "read-only",
        developerInstructions: systemPrompt || null,
        config: {
          web_search: allowWebSearch ? "live" : "disabled",
          tools: { web_search: allowWebSearch },
        },
      };
      let threadResult;
      if (sessionId) {
        try {
          threadResult = await request("thread/resume", { ...threadParams, threadId: sessionId });
        } catch {
          threadResult = await request("thread/start", { ...threadParams, ephemeral: !persist });
        }
      } else {
        threadResult = await request("thread/start", { ...threadParams, ephemeral: !persist });
      }
      threadId = String(threadResult?.thread?.id || sessionId || "");
      if (!threadId) throw new Error("Codex app-server did not return a thread id");

      const turnResult = await request("turn/start", {
        threadId,
        input: [{ type: "text", text: String(prompt || "") }],
        model: model || CODEX_MAIN_MODEL,
        effort: CODEX_REASONING_EFFORT || null,
      });
      turnId = String(turnResult?.turn?.id || "");
    } catch (error) {
      finish(-1, error.message);
    }
  })();

  return promise;
}

function buildCodexExecArgs({ sessionId = "", persist = true, systemPrompt = "", model = "", allowWebSearch = false, outputSchemaFile = "" } = {}) {
  const args = ["-a", "never", "-s", "read-only"];
  if (allowWebSearch) args.push("--search");
  if (model) args.push("-m", model);
  if (CODEX_REASONING_EFFORT) args.push("-c", `model_reasoning_effort=${codexTomlString(CODEX_REASONING_EFFORT)}`);
  if (systemPrompt) args.push("-c", `developer_instructions=${codexTomlString(systemPrompt)}`);
  args.push("exec");
  if (sessionId) args.push("resume", sessionId);
  args.push("--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules");
  if (!persist) args.push("--ephemeral");
  if (outputSchemaFile) args.push("--output-schema", outputSchemaFile);
  args.push("-");
  return args;
}

function runCodexExec(prompt, {
  sessionId = "",
  persist = true,
  systemPrompt = "",
  model = "",
  allowWebSearch = false,
  outputSchema = null,
  timeoutMs = CLAUDE_TIMEOUT_MS,
  onEvent = () => {},
} = {}) {
  const schemaFile = outputSchema
    ? path.join(RUNTIME_DIR, `.codex_schema_${crypto.randomUUID()}.json`)
    : "";
  if (schemaFile) {
    ensureDir(RUNTIME_DIR);
    fs.writeFileSync(schemaFile, JSON.stringify(outputSchema), "utf-8");
  }
  const args = buildCodexExecArgs({
    sessionId,
    persist,
    systemPrompt,
    model: model || CODEX_MAIN_MODEL,
    allowWebSearch,
    outputSchemaFile: schemaFile,
  });
  const codexCommand = /\.js$/i.test(CODEX) ? NODE : CODEX;
  const codexArgs = /\.js$/i.test(CODEX) ? [CODEX, ...args] : args;
  const proc = spawnCli(codexCommand, codexArgs, {
    cwd: AI_WORK_DIR,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: envWithProxy(CODEX_HTTPS_PROXY),
  });
  proc.stdin.on("error", () => {});
  proc.stdin.end(prompt, "utf8");

  let buf = "";
  let stderrOut = "";
  const eventState = createCodexEventState(sessionId);
  let resolved = false;
  let timedOut = false;

  const handleEvent = (event) => {
    reduceCodexEvent(eventState, event);
    onEvent(event);
  };

  proc.stdout.on("data", d => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { handleEvent(JSON.parse(trimmed)); } catch {}
    }
  });
  proc.stderr.on("data", d => {
    stderrOut += d;
    if (stderrOut.length > 5000) stderrOut = stderrOut.slice(-5000);
  });

  let timer = null;
  const promise = new Promise(resolve => {
    timer = setTimeout(() => {
      timedOut = true;
      killProc(proc);
    }, timeoutMs);
    proc.on("close", code => {
      clearTimeout(timer);
      if (schemaFile) { try { fs.rmSync(schemaFile, { force: true }); } catch {} }
      if (resolved) return;
      resolved = true;
      if (buf.trim()) { try { handleEvent(JSON.parse(buf.trim())); } catch {} }
      resolve({ code, stderr: stderrOut, killed: proc.killed, timedOut, ...eventState });
    });
    proc.on("error", e => {
      clearTimeout(timer);
      if (schemaFile) { try { fs.rmSync(schemaFile, { force: true }); } catch {} }
      if (resolved) return;
      resolved = true;
      resolve({ code: -1, stderr: e.message, killed: false, timedOut, ...eventState });
    });
  });
  promise.proc = proc;
  return promise;
}

// runCodexStream - 以流式 JSON 模式启动 OpenAI Codex CLI 进行对话
// 结构与 runClaudeStream 类似，但针对 Codex 的命令行接口做适配
// 参数:
//   ai - AI 引擎标识
//   sid - 会话 ID
//   sessionName - 会话名（用于日志）
//   body - 用户消息正文
//   firstTurn - 是否为首轮对话
//   onEvent - 每行 JSON 事件回调函数
//   ragContext - RAG 检索结果
//   stylePrompt - 角色/风格提示词
//   memoryPrompt - 记忆上下文
//   profileOverride - 角色配置文件覆盖
//   options - 额外选项（如 noSessionPersistence）
// 返回: Promise，resolve 时返回 { code, stderr, killed }；promise 上挂载 .proc 引用
function runCodexStream(ai, sid, sessionName, body, firstTurn, onEvent, ragContext, stylePrompt, memoryPrompt = "", profileOverride = null, options = {}) {
  const prompt = buildCodexPrompt(ai, body, ragContext, profileOverride);
  return runCodexAppServer(prompt, {
    sessionId: (!firstTurn && !options.noSessionPersistence) ? sid : "",
    persist: !options.noSessionPersistence,
    systemPrompt: codexSystemPrompt(stylePrompt, memoryPrompt, profileOverride),
    model: options.model || CODEX_MAIN_MODEL,
    allowWebSearch: Boolean(profileOverride && profileTemplates[profileOverride]),
    timeoutMs: options.timeoutMs || CLAUDE_TIMEOUT_MS,
    onEvent,
  });
}

async function runCodexJson(prompt, { label = "hidden", timeoutMs = 300_000, model = null, sessionId = "", firstTurn = false, persist = false, systemPrompt = "", outputSchema = null } = {}) {
  if (!commandExists(CODEX)) return null;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const task = runCodexExec(prompt, {
    sessionId: persist && !firstTurn ? sessionId : "",
    persist,
    systemPrompt,
    model: model || CODEX_MAIN_MODEL,
    allowWebSearch: true,
    outputSchema,
    timeoutMs,
  });
  const result = await task;
  const baseEvent = {
    type: "hidden_call_usage",
    backend: "codex",
    label,
    model: model || CODEX_MAIN_MODEL || "default",
    session_id: result.threadId || sessionId || null,
    started_at: startedAt,
    duration_ms: Date.now() - startedMs,
    context_chars: String(prompt || "").length,
    system_chars: String(systemPrompt || "").length,
  };
  if (result.code !== 0 || !result.text.trim()) {
    writeHiddenUsageEvent({ ...baseEvent, success: false, error: result.stderr || `exit ${result.code}` });
    return null;
  }
  try {
    let parsed;
    try { parsed = parseHiddenJson(result.text); }
    catch { parsed = result.text.trim(); }
    if (parsed && typeof parsed === "object") {
      parsed._toolUsage = result.toolUsage || emptyToolUsage();
      parsed._hiddenUsage = result.usage || null;
      parsed._hiddenCall = {
        ...baseEvent,
        success: true,
        output_chars: result.text.length,
        ...(result.usage || {}),
      };
      writeHiddenUsageEvent(parsed._hiddenCall);
    }
    return parsed;
  } catch (e) {
    writeHiddenUsageEvent({ ...baseEvent, success: false, error: e.message, output_chars: result.text.length });
    return null;
  }
}

// killProc - 强制终止一个子进程及其所有子进程
// Windows 下使用 taskkill /T /F 强制结束整个进程树，Unix 下发送 SIGTERM 信号
// 参数: proc - 要终止的 ChildProcess 对象
// 返回: 无
function killProc(proc) {
  // 进程不存在或无 PID 时直接返回
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === "win32") {
      // Windows: 强制结束进程树（父进程和所有子进程）
      execSync(`taskkill /T /F /PID ${proc.pid}`, { timeout: 5000, windowsHide: true });
    } else {
      // Unix: 发送 SIGTERM 信号
      proc.kill("SIGTERM");
    }
  } catch {
    // 进程可能已经退出，忽略错误
  }
}

// ─── API Backend (direct HTTP to OpenAI-compatible endpoint) ───

// apiModelName - 去除模型名中的后缀标记，返回 API 期望的裸模型名
// 例如将 "deepseek-v4-pro[1m]" 转换为 "deepseek-v4-pro"
// 参数: model - 可能带后缀的模型名（默认使用 CLAUDE_MAIN_MODEL）
// 返回: 去除 [...] 后缀的纯模型名
function apiModelName(model) {
  // 去除 [1m] 等方括号后缀标记 —— 直接 API 调用需要纯模型名，不能带方括号后缀
  return String(model || CLAUDE_MAIN_MODEL).replace(/\[.*\]$/, "");
}

// runApiStream - 通过直接 API（HTTP OpenAI 兼容接口）进行流式对话
// 委托给 api-client.mjs 中的 apiChatStream 或 apiChatWithTools 实现
// 参数:
//   systemPrompt - 系统提示词
//   body - 用户消息正文
//   messages - 完整的消息数组（与 body 二选一）
//   sessionName - 会话名称（用于日志）
//   model - 模型名（默认使用 CLAUDE_MAIN_MODEL）
//   useTools - 是否允许使用工具调用（影响底层调用方选择）
//   options - 额外选项
// 返回: 流式对话结果对象，包含 model 和 startedMs 元数据
async function runApiStream({ systemPrompt = "", body = "", messages = null, sessionName = "api", model = null, useTools = false, options = {} } = {}) {
  // 记录调用起始时间
  const startedMs = Date.now();
  // 去除模型名后缀标记
  const selectedModel = apiModelName(model);
  // 根据是否使用工具选择不同的 API 调用方法
  const caller = useTools ? apiChatWithTools : apiChatStream;
  // 调用底层 API 流式接口
  const result = await caller({
    systemPrompt,
    body,
    messages,
    model: selectedModel,
    maxTokens: 4000,
    temperature: 0.7,
    timeoutMs: CLAUDE_TIMEOUT_MS,
  });
  // 附加模型名和起始时间元数据
  result.model = selectedModel;
  result.startedMs = startedMs;
  return result;
}

// runApiJson - 通过直接 API 进行后台 JSON 调用（类似 runHiddenJson 但走 HTTP API 而非 CLI）
// 用于后台结构化数据提取场景，返回解析好的 JSON 数据
// 参数:
//   systemPrompt - 系统提示词
//   body - 用户消息正文
//   label - 调用标签（用于用量日志区分，默认 "api_hidden"）
//   model - 模型名（默认使用 CLAUDE_MAIN_MODEL）
//   timeoutMs - 超时毫秒数（默认 300000）
// 返回: API 响应结果对象，成功时附加 _apiCall 用量元数据；失败时记录错误日志
async function runApiJson({ systemPrompt = "", body = "", label = "api_hidden", model = null, timeoutMs = 300_000 } = {}) {
  // 记录调用开始时间
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  // 去除模型名后缀标记
  const selectedModel = apiModelName(model);
  // 调用底层 API JSON 接口
  const result = await apiChatJson({
    systemPrompt,
    body,
    model: selectedModel,
    maxTokens: 8000,
    temperature: 0.7,
    timeoutMs,
  });
  // 构建基础的用量日志事件
  const baseEvent = {
    type: "api_call_usage",
    label,
    model: selectedModel,
    started_at: startedAt,
    duration_ms: Date.now() - startedMs,
    context_chars: String(body || "").length,
    system_chars: String(systemPrompt || "").length,
    success: result.success,
  };
  if (result.success) {
    // 成功时将用量信息附加到结果对象并写日志
    result._apiCall = {
      ...baseEvent,
      output_chars: JSON.stringify(result.data || "").length,
      ...(result.usage || {}),
    };
    try { writeHiddenUsageEvent(result._apiCall); } catch {}
  } else {
    // 失败时仅记录包含错误信息的日志
    try { writeHiddenUsageEvent({ ...baseEvent, error: result.error || "unknown" }); } catch {}
  }
  return result;
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
  buildCodexExecArgs,
  createCodexEventState,
  reduceCodexEvent,
  codexAppServerUsage,
  runCodexAppServer,
  runHiddenJson,
  runCodexJson,
  runClaudeStream,
  buildCodexPrompt,
  runCodexStream,
  runApiStream,
  runApiJson,
  toolUsageFromUsage,
  usageSummary,
  writeHiddenUsageEvent,
  killProc,
  isApiConfigured,
  resolveApiConfig,
  CLAUDE,
  CLAUDE_MAIN_MODEL,
  CODEX_MAIN_MODEL,
  CODEX_REASONING_EFFORT,
  CLAUDE_FAST_MODEL,
  CLAUDE_FALLBACK_MODEL,
  SCENELET_BARE,
  CLAUDE_HTTPS_PROXY,
  CODEX_HTTPS_PROXY,
  CLAUDE_TIMEOUT_MS,
  AI_WORK_DIR,
  NODE,
  CODEX,
  LOGS_DIR,
};
