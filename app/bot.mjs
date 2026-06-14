// ─── 核心依赖 ──────────────────────────────────────────────────
// Node.js 标准库：文件系统、路径处理、加密、子进程、URL 路径转换
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ─── CONFIG（配置常量）──────────────────────────────────────────
import { configValue, envOrConfig, configBool, configNumber } from "./lib/config.mjs";
import { RUNTIME_DIR, dataPath, ensureDir, resolveProjectPath, appPath } from "./lib/paths.mjs";

// RAG（检索增强生成）相关配置
const RAG_SCRIPT = resolveProjectPath(configValue("paths.ragScript", "app/rag.py"));          // RAG Python 脚本路径
const RAG_ENABLED = configBool("rag.enabled", true);                                           // RAG 功能总开关
const RAG_KNOWLEDGE_DIR = resolveProjectPath(configValue("rag.knowledgeDir", "data/knowledge")); // RAG 知识库目录
const RAG_TIMEOUT_MS = configNumber("rag.timeoutMs", 45_000);                                   // RAG 查询超时时间
const RAG_HTTPS_PROXY = envOrConfig("WECHAT_RAG_HTTPS_PROXY", "proxy.ragHttps", envOrConfig("WECHAT_HTTPS_PROXY", "proxy.https", "")); // RAG 专用 HTTPS 代理

// 用户输入批处理等待时间（毫秒）：在此时间内收到的连续消息会被合并为一条处理
const INPUT_BATCH_MS = 30_000;

// 会话锁重试配置（用于防止同一会话并发处理）
const SESSION_LOCK_RETRIES = 3;
const SESSION_LOCK_RETRY_MS = 2_000;
const SESSION_RELEASE_GRACE_MS = 800;

// 微信 Token 持久化文件路径
const TOKEN_FILE = dataPath("wechat-token.json");

// 日志保留天数（可通过环境变量 WECHAT_LOG_RETENTION_DAYS 覆盖）
const LOG_RETENTION_DAYS = Number(process.env.WECHAT_LOG_RETENTION_DAYS ?? configValue("logs.retentionDays", 90));
// 日志清理间隔：每 24 小时执行一次
const LOG_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// 单实例锁文件路径：确保同一时间只有一个 bot 进程在运行
const INSTANCE_LOCK_FILE = dataPath("runtime", ".wechat-aibot.lock");

// ─── 核心功能模块导入 ───────────────────────────────────────────
import { hasInboundAttachment, loadPrompts, getChatStyle, formatLocalChatReality, expressionCapabilityPrompt } from "./lib/reply.mjs";
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
import { extractInboundPayload, isDuplicateInput, shouldUseExternalVision, hasExternalVisionConfig, VOICE_ASR_ENABLED, VOICE_WHISPERX_PYTHON, VISION_MODE, VISION_MODEL, VISION_BASE_URL } from "./lib/media.mjs";
import { InputBatcher, messageHasBatchableMedia } from "./lib/input-batcher.mjs";

// ─── STATE（全局状态管理）──────────────────────────────────────
import { getUpdatesBuf, sessions, activeAI, profileTemplates, modelNames, pendingInputs, setToken, setSyncBuf, setActiveAI } from "./lib/state.mjs";
import { uuid, sleep, log, isPidRunning } from "./lib/utils.mjs";
import { loadToken, saveToken, loginWithQr, sendMessage, apiPost } from "./lib/wechat.mjs";
import { loadMemoryDocument, loadWorldMemoryDocument } from "./lib/memory.mjs";
import { loadAllEvents, loadRoleVisibleHistory } from "./lib/chat-history.mjs";
import { getSceneConfig, emptyToolUsage, mergeToolUsage, sanitizeVisibleReplyText, normalizeLifeArcs } from "./lib/normalize.mjs";
import { envWithProxy, commandExists, isApiConfigured, resolveApiConfig, CLAUDE, CODEX, LOGS_DIR } from "./lib/claude-runner.mjs";
import { startBackendChat } from "./lib/backend-adapter.mjs";
import { sessionProfile, saveRoleWorlds, loadRoleWorlds, setSceneMemory, getRoleWorld, ensureWorldSession } from "./lib/world-state.mjs";
import { loadProfiles, makeSession, saveSessions, loadSessions, ensureUser, activeSession, sessionById, nextSessionName } from "./lib/session-store.mjs";
import { handleHelp, handleCC, handleCodex, handleAPI, handleNew, handleSwitch, handleRename, handleSessions, handleProfile, handleClose, handleStatus, handleCancel } from "./lib/commands.mjs";
import { buildTurnBody, appendVisibleHistory, getSceneMemorySystemBlock, recentVisibleContext } from "./lib/prompts.mjs";
import { generateSceneletForTurn, buildSceneContextBlock, addFollowUpCandidates, recordChatHistory, sendFinalAssistantMessage, checkProactiveIntents, generateSceneMemory, batchUpdateMemory, runScheduleExtractor, replyPrefix } from "./lib/turn.mjs";

// 当前用户主目录
const USER_HOME = process.env.USERPROFILE || process.env.HOME || process.cwd();
// 微信 API 长轮询超时时间（毫秒）
const LONG_POLL_TIMEOUT_MS = 35_000;

// 角色世界状态缓存 Map：key=角色名，value=该角色的世界状态对象
const roleWorlds = new Map();
// 挂载到全局对象，方便跨模块访问（如 GUI 路由模块）
globalThis.__wechatRoleWorlds = roleWorlds;
globalThis.__wechatSaveRoleWorlds = saveRoleWorlds;
globalThis.__wechatSaveSessions = saveSessions;

// ═══════════════════════════════════════════════════════════════
// loadModelNames() —— 加载各 AI 后端的当前模型名称
// ═══════════════════════════════════════════════════════════════
// 用途：从 Claude Code 和 Codex 的本地配置文件中读取当前使用的模型名称，
//       用于在 /status 命令中展示当前 AI 后端的具体模型版本
// 输入：无
// 输出：无（直接修改全局 modelNames 对象）
function loadModelNames() {
  modelNames.codex = configValue("models.codexMain", "gpt-5.5");
  try {
    // 读取 Claude Code 配置文件 (~/.claude/settings.json)
    const p = path.join(USER_HOME, ".claude", "settings.json");
    if (fs.existsSync(p)) {
      const d = JSON.parse(fs.readFileSync(p, "utf-8"));
      // 优先使用环境变量指定的模型，其次使用配置文件中的 model 字段
      modelNames.cc = d.env?.ANTHROPIC_MODEL || d.model || "unknown";
    }
  } catch {}
  try {
    // 读取 Codex 配置文件 (~/.codex/config.toml)，解析 model 字段
    const p = path.join(USER_HOME, ".codex", "config.toml");
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      // 用正则提取 TOML 格式的 model = "xxx" 配置项
      const m = raw.match(/^model\s*=\s*"([^"]+)"/m);
      if (m && !configValue("models.codexMain", "")) modelNames.codex = m[1];
    }
  } catch {}
  // API 模式直接读取 config.json 中配置的模型名
  modelNames.api = configValue("api.model", "deepseek-v4-pro");
}

// ─── HELPERS（工具函数）────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════
// cleanupOldLogs() —— 定期清理过期日志文件
// ═══════════════════════════════════════════════════════════════
// 用途：扫描日志目录，删除最后修改时间超过 LOG_RETENTION_DAYS 天的旧日志文件，释放磁盘空间
// 输入：无
// 输出：无
// 调用频率：每隔 LOG_CLEANUP_INTERVAL_MS (默认24小时) 通过 setInterval 自动调用
function cleanupOldLogs() {
  // 如果未配置保留天数或无效，跳过清理
  if (!Number.isFinite(LOG_RETENTION_DAYS) || LOG_RETENTION_DAYS <= 0) return;
  try {
    if (!fs.existsSync(LOGS_DIR)) return;
    // 计算截止时间：当前时间减去保留天数
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let removed = 0;
    // 遍历日志目录下的所有文件
    for (const entry of fs.readdirSync(LOGS_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue; // 跳过子目录
      const filePath = path.join(LOGS_DIR, entry.name);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs >= cutoff) continue; // 文件仍在保留期内，跳过
      fs.rmSync(filePath, { force: true });
      removed++;
    }
    if (removed) log("\u{1F9F9}", `已清理 ${removed} 个超过 ${LOG_RETENTION_DAYS} 天的日志文件`);
  } catch (e) {
    log("⚠️", `日志清理失败: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// acquireInstanceLock() —— 获取单实例锁
// ═══════════════════════════════════════════════════════════════
// 用途：通过写锁文件的方式防止同时运行多个 bot 进程，
//       如果检测到已有 bot 进程运行中，自动打开 GUI 页面后退出当前进程
// 输入：无
// 输出：无（成功则继续运行，失败/冲突则退出进程）
function acquireInstanceLock() {
  try {
    ensureDir(RUNTIME_DIR);
    // 检查锁文件是否已存在
    if (fs.existsSync(INSTANCE_LOCK_FILE)) {
      const oldPid = Number(fs.readFileSync(INSTANCE_LOCK_FILE, "utf-8").trim());
      // 如果锁文件中的 PID 不是当前进程且确实在运行，说明已有另一个 bot 实例
      if (oldPid !== process.pid && isPidRunning(oldPid)) {
        const guiUrl = "http://127.0.0.1:18720";
        process.stdout.write(`WeChat AI Bot is already running: PID ${oldPid}\n`);
        process.stdout.write(`Opening GUI: ${guiUrl}\n`);
        // 自动在浏览器中打开现有实例的 GUI 页面（Windows）
        try { execSync(`cmd /c start ${guiUrl}`, { timeout: 5000, windowsHide: true }); } catch {}
        process.exit(0);
      }
    }
    // 将当前进程 PID 写入锁文件
    fs.writeFileSync(INSTANCE_LOCK_FILE, String(process.pid));
  } catch (e) {
    process.stderr.write(`Failed to acquire instance lock: ${e.message}\n`);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════
// releaseInstanceLock() —— 释放单实例锁
// ═══════════════════════════════════════════════════════════════
// 用途：在进程退出时删除锁文件，释放实例锁
// 输入：无
// 输出：无
function releaseInstanceLock() {
  try {
    if (!fs.existsSync(INSTANCE_LOCK_FILE)) return;
    const lockPid = Number(fs.readFileSync(INSTANCE_LOCK_FILE, "utf-8").trim());
    // 只有锁文件中的 PID 与当前进程 PID 一致时才删除（防止误删其他实例的锁）
    if (lockPid === process.pid) fs.unlinkSync(INSTANCE_LOCK_FILE);
  } catch {}
}

// ─── RAG query（检索增强生成查询）─────────────────────────────

// ═══════════════════════════════════════════════════════════════
// hasExplicitProfileName() —— 检查用户消息中是否显式提到了某个角色名称
// ═══════════════════════════════════════════════════════════════
// 用途：判断用户是否在消息中提到了非当前角色、非默认的已知角色名，
//       用于决定是否需要切换到对应角色的 RAG 知识库查询
// 输入：userMessage - 用户消息文本；currentProfile - 当前角色名称（可选）
// 输出：Boolean - 是否包含其他角色名称
function hasExplicitProfileName(userMessage, currentProfile = "") {
  return Object.keys(profileTemplates).some(name => name !== "默认" && name !== currentProfile && userMessage.includes(name));
}

// ═══════════════════════════════════════════════════════════════
// shouldUseRoleplayRag() —— 判断消息是否触发角色扮演 RAG 查询
// ═══════════════════════════════════════════════════════════════
// 用途：根据 prompts.json 中配置的 ragKeywords（关键词正则），
//       检测用户消息是否包含需要触发角色知识库查询的术语
// 输入：userMessage - 用户消息文本
// 输出：Boolean - 是否应触发 RAG
function shouldUseRoleplayRag(userMessage) {
  const text = String(userMessage || "").trim();
  if (!text) return false;
  const kw = loadPrompts().ragKeywords || {};
  // 依次检查 "lore" 和 "names" 两类关键词正则
  for (const key of ["lore", "names"]) {
    const pattern = String(kw[key] || "").trim();
    if (!pattern) continue;
    try { if (new RegExp(pattern, "iu").test(text)) return true; } catch {}
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// shouldUseRagForTurn() —— 综合判断当前轮次是否应触发 RAG
// ═══════════════════════════════════════════════════════════════
// 用途：结合角色匹配和关键词匹配两个维度，决定是否对本轮消息执行 RAG 查询
// 输入：userMessage - 用户消息文本；profile - 当前角色名称
// 输出：Boolean
function shouldUseRagForTurn(userMessage, profile) {
  // 默认角色不触发 RAG
  if (!profile || profile === "默认") return false;
  // 消息中显式提到了其他角色名
  if (hasExplicitProfileName(userMessage, profile)) return true;
  // 消息中含有角色扮演相关的关键词
  return shouldUseRoleplayRag(userMessage);
}

// ═══════════════════════════════════════════════════════════════
// queryRag() —— 执行 RAG 知识库查询
// ═══════════════════════════════════════════════════════════════
// 用途：调用 Python RAG 脚本（rag.py），在向量知识库中搜索与用户消息相关的内容，
//       返回检索到的上下文文本片段
// 输入：userMessage - 用户查询文本；profile - 角色名称（可选，用于限定知识范围）
// 输出：String - 检索结果文本；空字符串表示无结果或查询失败；null 表示 RAG 强制关闭
function queryRag(userMessage, profile = null) {
  if (!RAG_ENABLED) return "";                 // RAG 功能关闭
  if (!fs.existsSync(RAG_SCRIPT)) return null;  // RAG 脚本不存在
  try {
    const t0 = Date.now();
    // 将查询内容写入临时文件，通过 --file 参数传递给 Python 脚本
    const queryFile = path.join(RUNTIME_DIR, ".rag_query.txt");
    ensureDir(RUNTIME_DIR);
    fs.writeFileSync(queryFile, userMessage, "utf-8");
    const args = ["-X", "utf8", RAG_SCRIPT, "query", "--file", queryFile];
    if (profile) args.push("--profile", profile);
    // 同步调用 Python 进程，设置超时、缓冲区大小和代理环境变量
    const result = spawnSync("python", args, {
      encoding: "utf8", timeout: RAG_TIMEOUT_MS, maxBuffer: 1024 * 1024,
      cwd: path.dirname(RAG_SCRIPT),
      env: envWithProxy(RAG_HTTPS_PROXY, { HF_HUB_DISABLE_SYMLINKS_WARNING: "1" }),
    });
    // 清理临时查询文件
    try { if (fs.existsSync(queryFile)) fs.rmSync(queryFile, { force: true }); } catch {}
    const ms = Date.now() - t0;
    if (result.status !== 0) return "";       // Python 脚本执行失败
    const raw = (result.stdout || "").trim();
    if (raw) log("\u{1F4DA}", `RAG hit in ${ms}ms (${raw.length} chars)`);
    return raw;
  } catch (e) { return ""; }
}




// 临时性网络错误码集合：这些错误通常可以通过重试恢复
const TRANSIENT_GETUPDATES_CODES = new Set([
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED",
  "EPIPE", "ENETRESET", "ENETUNREACH", "EHOSTUNREACH",
]);

// ═══════════════════════════════════════════════════════════════
// isTransientGetUpdatesError() —— 判断是否为临时性网络错误
// ═══════════════════════════════════════════════════════════════
// 用途：区分临时网络故障和永久性错误，临时错误用指数退避重试，永久错误需要不同的处理逻辑
// 输入：e - 错误对象
// 输出：Boolean
function isTransientGetUpdatesError(e) {
  const code = e?.cause?.code || e?.code || "";
  return (e?.message === "fetch failed" || e?.name === "TypeError") && TRANSIENT_GETUPDATES_CODES.has(code);
}

// ─── PROCESS ONE TURN（处理单轮对话）───────────────────────────
// 注：processTurn 已拆分为以下模块级子函数 + 轻量编排器：
//   makeStreamHandler   —— 流式输出处理器（textBuf/flush 节流）
//   prepareTurnContext  —— 阶段 0+1：上下文准备
//   executeAICallAndSend —— 阶段 2+3+4：AI 调用、发送回复、错误处理
//   finalizeTurnSuccess —— 阶段 5：成功轮次后处理
//   processTurn         —— 编排器（约 40 行）

// ═══════════════════════════════════════════════════════════════════
// makeStreamHandler() —— 创建流式输出处理器
// ═══════════════════════════════════════════════════════════════════
// 用途：管理 textBuf 缓冲区与 flush 节流逻辑，消除 CC/Codex 路径中的重复代码。
//       内部维护缓冲区状态，在字符数或时间阈值到达时自动 flush。
// 输入：onProc - 输出回调 { type: "flush", text }；flushChars - 缓冲区字符数阈值
// 输出：Function (event) => void，其中 event：
//   event.text  - 追加到缓冲区的文本增量
//   event.drain - 强制清空缓冲区（流结束时调用）
function makeStreamHandler(onProc, flushChars) {
  let textBuf = "";                   // 流式输出缓冲区
  let lastFlushAt = Date.now();       // 上次 flush 时间

  return (event) => {
    // 累积文本增量
    if (event.text) {
      textBuf += event.text;
    }
    // 字符数或时间阈值触发 flush
    if (textBuf.length >= flushChars || Date.now() - lastFlushAt >= 3000) {
      const flushText = textBuf.trim();
      if (flushText) {
        onProc({ type: "flush", text: flushText });
        textBuf = "";
        lastFlushAt = Date.now();
      }
    }
    // 强制清空缓冲区（流结束时调用）
    if (event.drain) {
      if (textBuf.trim()) {
        onProc({ type: "flush", text: textBuf.trim() });
        textBuf = "";
      }
    }
  };
}
// ═══════════════════════════════════════════════════════════════════
// prepareTurnContext() —— 阶段 0+1：准备本轮对话上下文
// ═══════════════════════════════════════════════════════════════════
// 用途：
//   1. 解析 profile/turnProfile/isProfileChat
//   2. 加载 memoryPrompt / roleWorld
//   3. 调用 generateSceneletForTurn 生成 scenelet
//   4. 构建本轮日志基础设施
// 输入：ai/userId/sid/sessionName/body - 本轮基础信息
//       styleState - 会话状态对象
// 输出：本轮上下文对象
async function prepareTurnContext(ai, userId, sid, sessionName, body, styleState) {
  const turnStarted = Date.now();
  const rawProfile = sessionProfile(styleState);                // 获取会话绑定的角色名
  const turnProfile = rawProfile;
  const prefix = replyPrefix(sessionName, ai);                  // 回复前缀
  log("<", `[${sessionName}] ${body.slice(0, 80)}`);
  // 是否进入角色扮演聊天模式
  const isProfileChat = Boolean(turnProfile && profileTemplates[turnProfile] && turnProfile !== "默认");

  // 角色可见历史按 userId + profile 跨后端共享。各后端保留独立运行线程，
  // 但 hidden-world 和主回复每轮都使用 SQLite 中同一份连续聊天上下文。
  if (isProfileChat) {
    try {
      styleState._visibleHistory = await loadRoleVisibleHistory(userId, turnProfile);
    } catch (e) {
      log("⚠", `[${sessionName}] shared visible history load fail: ${e.message}`);
    }
  }

  // 加载角色记忆文档，用于注入 AI 系统提示
  const memoryPrompt = isProfileChat ? (() => {
    const userItems = loadMemoryDocument(turnProfile);
    const worldItems = loadWorldMemoryDocument(turnProfile);
    if (!userItems && !worldItems) return "";
    const instruction = loadPrompts(turnProfile).memoryContextInstruction || "";
    const parts = [];
    if (userItems) parts.push(instruction ? `${instruction}\n\n${userItems}` : userItems);
    if (worldItems) parts.push(`【关于世界 — 用户记录】\n${worldItems}`);
    return parts.join("\n\n");
  })() : "";

  const roleWorld = isProfileChat ? getRoleWorld(turnProfile) : null; // 获取角色世界状态
  let sceneletResult = null;
  let sceneletError = null;
  let ragUsage = null; // 本轮 RAG 检索统计（在 HW 调用中注入）
  // 角色扮演模式下生成场景小剧场
  if (isProfileChat) {
    try {
      // RAG 知识库查询：在 HW 调用之前执行，结果注入 inner scenelet 生成
      const ragEligible = Boolean(RAG_ENABLED && !hasInboundAttachment(body) && shouldUseRagForTurn(body, turnProfile));
      const ragContext = ragEligible ? queryRag(body, turnProfile) : "";
      ragUsage = { eligible: ragEligible, used: Boolean(ragContext), chars: ragContext.length };
      sceneletResult = await generateSceneletForTurn({ ai, userId, sess: styleState, profile: turnProfile, userBody: body, memoryPrompt, ragContext });
    } catch (e) {
      sceneletError = e.message;
      log("⚠", `[${sessionName}] scenelet fail: ${e.message}`);
    }
  }

  // 构建日志条目基础信息
  const logEntry = { ts: new Date().toISOString(), ai, userId, sessionName, sid, firstTurn: styleState._firstTurn, isProfileChat, profile: turnProfile || "默认", bodyChars: String(body || "").length, sceneletChars: sceneletResult?.innerScenelet?.length || 0, sceneletError: sceneletError || null };
  const safeName = sessionName.replace(/[<>:"/\\|?*]/g, "_");  // 文件系统安全的名称
  const logFile = path.join(LOGS_DIR, `${safeName}-${ai}.jsonl`);   // 结构化日志
  const txtLogFile = path.join(LOGS_DIR, `${safeName}-${ai}.txt`);  // 人类可读日志

  // 追加结构化日志条目
  function appendLog(extra = {}) {
    try { if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true }); fs.appendFileSync(logFile, JSON.stringify({ ...logEntry, ...extra }) + "\n"); } catch {}
  }
  // 写入人类可读的文本日志
  function writeTxtLog(label, content) {
    try { if (!content) return; if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true }); fs.appendFileSync(txtLogFile, `\n=== ${label} [${new Date().toISOString()}] ===\n` + String(content).trim() + "\n", "utf-8"); } catch {}
  }

  // 记录用户原始消息和上下文到日志
  writeTxtLog("USER MESSAGE", body);
  if (memoryPrompt) writeTxtLog("MEMORY SNAPSHOT", memoryPrompt);
  if (sceneletResult?.innerScenelet) writeTxtLog("INNER SCENELET", sceneletResult.innerScenelet);


  return {
    turnStarted, rawProfile, turnProfile, prefix,
    isProfileChat, memoryPrompt, roleWorld, sceneletResult, sceneletError, ragUsage,
    logEntry, logFile, txtLogFile, appendLog, writeTxtLog,
  };
}

// ═══════════════════════════════════════════════════════════════════
// executeAICallAndSend() —— 阶段 2+3+4：AI 调用、发送回复、错误处理
// ═══════════════════════════════════════════════════════════════════
// 用途：
//   1. RAG 知识库查询
//   2. 构建 stableStyle / sceneContext / sceneMemoryBlock / turnBody
//   3. 选择 AI 后端（api / cc / codex）执行流式推理，使用 makeStreamHandler 管理缓冲
//   4. 发送最终回复给用户
//   5. 错误捕获与用户通知
// 输入：ai/userId/sid/sessionName/body/contextToken/firstTurn - 本轮基础信息
//       onProc - 输出回调；styleState - 会话状态；ctx - 上下文对象（来自 prepareTurnContext）
// 输出：Object { turnSucceeded, assistantFullText, toolUsage, lastUsage }
async function executeAICallAndSend(ai, userId, sid, sessionName, body, contextToken, firstTurn, onProc, styleState, ctx) {
  const { isProfileChat, turnProfile, memoryPrompt, roleWorld, sceneletResult, prefix, appendLog, writeTxtLog, ragUsage: ctxRagUsage } = ctx;
  let turnSucceeded = false;           // 本轮是否成功完成
  let assistantFullText = "";          // AI 生成的完整回复文本
  let toolUsage = emptyToolUsage();    // 本轮工具使用统计
  let ragUsage = ctxRagUsage;          // RAG 检索统计（来自 prepareTurnContext，已注入 HW）
  let lastUsage = null;                // 最后一次 API 用量数据
  let activeSid = sid;                 // CC 会话失效并恢复时更新为新 SID
  const streamStartedAt = new Date().toISOString();  // 流式处理开始时间

  try {
    // 稳定风格提示
    const stableStyle = isProfileChat ? expressionCapabilityPrompt(turnProfile) : "";
    // 构建场景上下文块
    const ctxParts = [];
    if (sceneletResult) ctxParts.push(buildSceneContextBlock(styleState, sceneletResult));
    const sceneContext = ctxParts.join("\n\n---\n\n");
    // 场景记忆块（仅角色扮演模式的首轮）
    const sceneMemoryBlock = (isProfileChat && firstTurn) ? getSceneMemorySystemBlock(roleWorld, ai, turnProfile) : "";
    // 组装发送给 AI 的完整消息体
    const turnBody = await buildTurnBody(body, sceneContext, recentVisibleContext(styleState), sceneMemoryBlock, turnProfile);

    writeTxtLog("TURN BODY", turnBody);
    if (stableStyle) writeTxtLog("STABLE STYLE", stableStyle);

    const FLUSH_CHARS = isProfileChat ? 800 : 300;  // 角色扮演模式批处理更多字符以减少消息碎片

    // 创建流式处理器（管理 textBuf + flush 节流，消除 CC/Codex 重复代码）
    const streamHandler = makeStreamHandler(onProc, FLUSH_CHARS);

    const apiSystemParts = [];
    if (turnProfile && profileTemplates[turnProfile]) apiSystemParts.push(profileTemplates[turnProfile]);
    if (memoryPrompt) apiSystemParts.push(memoryPrompt);
    if (isProfileChat && getChatStyle(turnProfile)) apiSystemParts.push(getChatStyle(turnProfile));
    if (isProfileChat && formatLocalChatReality(new Date(), turnProfile)) apiSystemParts.push(formatLocalChatReality(new Date(), turnProfile));
    if (stableStyle) apiSystemParts.push(stableStyle);
    if (ai === "api" && !styleState._apiMessages) styleState._apiMessages = [];
    const apiMessages = ai === "api" ? [
      { role: "system", content: apiSystemParts.join("\n\n---\n\n") },
      ...styleState._apiMessages,
      { role: "user", content: turnBody },
    ] : null;

    const startChatAttempt = (sessionId, isFirstTurn) => startBackendChat({
      backend: ai,
      sessionId,
      sessionName,
      body: turnBody,
      firstTurn: isFirstTurn,
      stylePrompt: stableStyle,
      memoryPrompt,
      profile: turnProfile,
      apiMessages,
      useTools: isProfileChat,
      onText: delta => {
        assistantFullText += delta;
        streamHandler({ text: delta });
      },
    });

    const chatTask = startChatAttempt(activeSid, firstTurn);
    styleState._lastProc = chatTask.proc || null;
    const streamResult = await chatTask;
    styleState._lastProc = null;
    const missingCcSession = ai === "cc"
      && streamResult?.code !== 0
      && !assistantFullText
      && !streamResult?.text
      && /No conversation found with session ID/i.test(streamResult?.stderr || "");
    if (missingCcSession) {
      throw new Error("CC conversation is missing; reset the session before retrying");
    }
    if (!assistantFullText && streamResult?.text) assistantFullText = streamResult.text;
    if (streamResult?.threadId && streamResult.threadId !== styleState.sid) styleState.sid = streamResult.threadId;
    if (streamResult?.usage) {
      lastUsage = {
        ...streamResult.usage,
        started_at: streamStartedAt,
        duration_ms: Date.now() - new Date(streamStartedAt).getTime(),
      };
    }
    toolUsage = mergeToolUsage(sceneletResult?.toolUsage, streamResult?.toolUsage);
    if (ai === "api" && streamResult?.code === 0 && assistantFullText.trim()) {
      styleState._apiMessages.push({ role: "user", content: body });
      styleState._apiMessages.push({ role: "assistant", content: assistantFullText.trim() });
    }
    // 检查 AI 后端是否成功返回
    if (streamResult?.code !== 0) throw new Error(`AI exited ${streamResult.code}${streamResult.stderr ? ": " + streamResult.stderr.slice(-500) : ""}`);
    // 清空缓冲区中剩余内容
    streamHandler({ drain: true });

    // 合并 streamResult 中的工具使用统计
    appendLog({ ragChars: ragUsage?.chars || 0, toolUsage: { webSearch: toolUsage.webSearch, webFetch: toolUsage.webFetch, tools: toolUsage.tools } });

    // 发送最终回复给用户
    const t = (isProfileChat ? sanitizeVisibleReplyText(assistantFullText) : String(assistantFullText || "")).trim();
    if (t) {
      const sent = await sendFinalAssistantMessage(userId, t, contextToken, prefix);
      if (!sent) throw new Error("failed to send complete reply to WeChat");
      turnSucceeded = true;
      const replyBytes = Buffer.byteLength(t, "utf-8");
      log(">", `[${sessionName}] (${replyBytes}B) ${t.slice(0, 60).replace(/\n/g, " ")}`);
      // 记录本轮工具使用摘要
      const parts = [];
      if (toolUsage.webSearch > 0) parts.push(`webSearch×${toolUsage.webSearch}`);
      if (toolUsage.webFetch > 0) parts.push(`webFetch×${toolUsage.webFetch}`);
      if (toolUsage.tools.length > 0) parts.push(`tools: ${toolUsage.tools.join(", ")}`);
      if (ragUsage?.used) parts.push(`rag: ${ragUsage.chars}B`);
      if (parts.length) log("\u{2295}", `[${sessionName}] ${parts.join(" ")}`);
    }
  } catch (e) {
    // 错误处理：记录失败、通知用户
    log("⚠", `[${sessionName}] turn failed: ${e.message}`);
    styleState._lastFailedTurn = { body, timestamp: new Date().toISOString(), reason: e.message?.slice(0, 500), sid: activeSid };
    await sendMessage(userId, `[系统提示] 回复失败：${e.message?.slice(0, 150)}`, contextToken).catch(() => {});
    appendLog({ error: e.message?.slice(0, 500) });

    // 即使发送失败，也保留已生成的内容和 scenelet 写入历史
    const failAt = new Date().toISOString();
    const failText = assistantFullText ? sanitizeVisibleReplyText(assistantFullText).trim() : "";
    if (isProfileChat && (failText || ctx.sceneletResult?.innerScenelet)) {
      appendVisibleHistory(styleState, "user", body, "chat", failAt);
      if (failText) appendVisibleHistory(styleState, "assistant", failText, "chat", failAt);
      try {
        await recordChatHistory({ ai, userId, sess: styleState, role: "user", kind: "chat", text: body, timestamp: failAt });
        await recordChatHistory({ ai, userId, sess: styleState, role: "assistant", kind: "chat",
          text: failText || "[发送失败，内容未完整发出]",
          scenelet: ctx.sceneletResult?.innerScenelet || "",
          sceneletStatus: ctx.sceneletResult ? "ok" : (ctx.sceneletError ? "error" : "skipped"),
          sceneletError: ctx.sceneletError || "",
          toolUsage, ragUsage, timestamp: failAt });
      } catch (dbErr) {
        ctx.writeTxtLog("DB WRITE ERROR (fail)", dbErr.message);
      }
    }
  }

  return { turnSucceeded, assistantFullText, toolUsage, ragUsage, lastUsage };
}

// ═══════════════════════════════════════════════════════════════════
// finalizeTurnSuccess() —— 阶段 5：成功轮次的后处理
// ═══════════════════════════════════════════════════════════════════
// 用途：
//   1. 清理 assistantFullText（角色扮演模式可见性过滤）
//   2. 更新会话状态字段（lastAssistantAt / lastContextToken / lastUsage 等）
//   3. 处理 scenelet 生成的 follow_up 候选
//   4. 记录对话历史（appendVisibleHistory + recordChatHistory）
//   5. 日程提取（角色扮演模式）
//   6. 回合计数 + 自动场景重置
// 输入：params Object 包含所有需要的上下文数据
// 输出：无（副作用：修改会话状态、写入历史记录、持久化世界状态）
async function finalizeTurnSuccess(params) {
  const { userId, ai, sessionName, body, styleState, assistantFullText, contextToken,
    sceneletResult, sceneletError, turnProfile, isProfileChat, roleWorld,
    toolUsage, ragUsage, lastUsage, appendLog, writeTxtLog } = params;

  // 角色扮演模式下对回复文本做可见性清理（去除内部标记等）
  let cleanText = assistantFullText;
  if (isProfileChat) cleanText = sanitizeVisibleReplyText(cleanText);

  // 更新会话状态
  styleState._lastAssistantAt = new Date().toISOString();
  styleState._lastContextToken = contextToken;
  styleState._lastFailedTurn = null;
  styleState._firstTurn = false;
  if (lastUsage) styleState._lastUsage = lastUsage;

  // 将 scenelet 生成的 follow_up 候选写入 proactive intents
  if (sceneletResult?.followUpCandidates?.length) {
    await addFollowUpCandidates(styleState, sceneletResult, body, roleWorld).catch(e => { log("⚠", `[${sessionName}] follow_up fail: ${e.message}`); });
  }

  // 记录对话历史（用户消息和 AI 回复）
  const userAt = new Date().toISOString();
  const assistantAt = new Date().toISOString();
  appendVisibleHistory(styleState, "user", body, "chat", userAt);
  appendVisibleHistory(styleState, "assistant", cleanText, "chat", assistantAt);

  // 持久化对话历史到数据库（失败时写入日志便于恢复）
  try {
    await recordChatHistory({ ai, userId, sess: styleState, role: "user", kind: "chat", text: body, timestamp: userAt });
    await recordChatHistory({ ai, userId, sess: styleState, role: "assistant", kind: "chat", text: cleanText, scenelet: sceneletResult?.innerScenelet || "", sceneletStatus: sceneletResult ? "ok" : (sceneletError ? "error" : "skipped"), sceneletError: sceneletError || "", toolUsage, ragUsage, timestamp: assistantAt });
  } catch (e) {
    writeTxtLog("DB WRITE ERROR", e.message);
    // fallback: 将历史数据以 JSON 写入日志，方便手动恢复
    writeTxtLog("HISTORY FALLBACK", JSON.stringify({
      user: { role: "user", kind: "chat", text: body, timestamp: userAt },
      assistant: { role: "assistant", kind: "chat", text: cleanText, scenelet: sceneletResult?.innerScenelet || "", sceneletStatus: sceneletResult ? "ok" : (sceneletError ? "error" : "skipped"), timestamp: assistantAt },
    }, null, 2));
  }

  // 角色扮演模式的额外后处理
  if (isProfileChat && cleanText) {
    // 日程提取器：从本轮对话中提取潜在日程安排
    try {
      const activeSchedules = normalizeLifeArcs(roleWorld._lifeArcs).filter(a => a.status === "active" && a.kind);
      const newCandidates = await runScheduleExtractor({ ai, userBody: body, scenelet: sceneletResult?.innerScenelet || "", assistantReply: cleanText, profile: turnProfile, activeSchedules });
      if (newCandidates.length) {
        const existing = roleWorld._pendingScheduleCandidates || [];
        const existingTitles = new Set(existing.map(c => c.title));
        for (const c of newCandidates) {
          if (!existingTitles.has(c.title)) {
            existing.push(c);
            existingTitles.add(c.title);  // 去重
          }
        }
        roleWorld._pendingScheduleCandidates = existing;
        saveRoleWorlds();
      }
    } catch (e) { log("⚠", `[${sessionName}] schedule extract fail: ${e.message}`); }

    // 回合计数器：达到阈值时自动触发场景重置
    styleState._turnCount = (styleState._turnCount || 0) + 1;
    const threshold = getSceneConfig().turnResetThreshold || 8;
    if (styleState._turnCount >= threshold) {
      try {
        // 批量更新用户记忆
        const userMsgLog = styleState._userMessageLog || [];
        await batchUpdateMemory({ ai, userId, userMessages: userMsgLog, profile: turnProfile });
        styleState._userMessageLog = [];
        // 生成新场景记忆摘要
        const summary = await generateSceneMemory({ ai, userId, sess: styleState, profile: turnProfile, roleWorld });
        if (summary) {
          setSceneMemory(roleWorld, summary, ai);
          // 重置会话 SID、首轮标志、回合计数器
          styleState.sid = uuid();
          styleState._firstTurn = true;
          styleState._turnCount = 0;
          styleState._lastUsage = null;
          // 更新世界会话信息
          const resetAt = new Date().toISOString();
          ensureWorldSession(roleWorld, ai);
          const hw = roleWorld._worldSessions?.[ai];
          if (hw) {
            hw.sid = uuid();
            hw.firstTurn = true;
            hw.startedAt = resetAt;
            hw.resetReason = `auto-reset after ${threshold} turns`;
            hw.turnCount = 0;
            hw.lastUsage = null;
          }
          // 保留最近的 8 条可见历史，避免上下文过长
          styleState._visibleHistory = styleState._visibleHistory.slice(-8);
          // 裁剪 API 上下文到最近 8 轮（每轮 user+assistant 共 2 条）
          if (styleState._apiMessages?.length) {
            styleState._apiMessages = styleState._apiMessages.slice(-16);
          }
          saveRoleWorlds();
          log("↻", `[${sessionName}] reset after ${threshold} turns`);
        }
      } catch (e) {
        log("⚠", `[${sessionName}] reset fail: ${e.message}`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// processTurn() —— 核心对话处理流程（编排器）
// ═══════════════════════════════════════════════════════════════════
// 用途：编排本轮对话的完整生命周期：
//   阶段 0+1：prepareTurnContext —— 上下文准备（去重、角色判断、scenelet、日志基础设施）
//   阶段 2+3+4：executeAICallAndSend —— AI 调用、流式发送、错误处理
//   阶段 5：finalizeTurnSuccess —— 成功轮次后处理（状态更新、历史记录、日程提取、自动重置）
//   阶段 6：saveSessions —— 持久化
// 输入：
//   ai          - AI 后端标识 ("cc"/"codex"/"api")
//   userId      - 用户微信 ID
//   sid         - 当前场景 ID (scene id)
//   sessionName - 会话名称 (如 "S1")
//   body        - 用户消息正文
//   contextToken- 微信 API 上下文 token（用于回复时指定目标消息）
//   firstTurn   - 是否为本场景的第一轮对话
//   onProc      - 流式输出回调函数 { type: "flush", text }
//   styleState  - 会话状态对象（包含对话历史、角色、工具使用记录等）
// 输出：无（副作用：发送微信消息、更新会话状态、记录日志）
async function processTurn(ai, userId, sid, sessionName, body, contextToken, firstTurn, onProc, styleState) {
  // 阶段 0+1：准备上下文
  const ctx = await prepareTurnContext(ai, userId, sid, sessionName, body, styleState);

  // 阶段 2+3+4：执行 AI 调用、发送回复、错误处理
  const { turnSucceeded, assistantFullText, toolUsage, ragUsage, lastUsage } = await executeAICallAndSend(
    ai, userId, sid, sessionName, body, contextToken, firstTurn, onProc, styleState, ctx
  );

  // 阶段 5：成功轮次的后处理
  if (turnSucceeded) {
    await finalizeTurnSuccess({
      userId, ai, sessionName, body, styleState, assistantFullText, contextToken,
      sceneletResult: ctx.sceneletResult, sceneletError: ctx.sceneletError,
      turnProfile: ctx.turnProfile, isProfileChat: ctx.isProfileChat,
      roleWorld: ctx.roleWorld,
      toolUsage, ragUsage, lastUsage, appendLog: ctx.appendLog, writeTxtLog: ctx.writeTxtLog,
    });
  }

  // 阶段 6：持久化
  saveSessions();
}

// ─── SESSION LOOP（会话循环）─────────────────────────────────

// ═══════════════════════════════════════════════════════════════
// sessionLoop() —— 会话消息处理循环
// ═══════════════════════════════════════════════════════════════
// 用途：对指定会话启动一个持续运行的循环，从消息队列中取出一条条消息交给 processTurn 处理
// 输入：ai - AI 后端标识；userId - 用户 ID；sessionId - 会话 ID
// 输出：无（循环持续运行直到会话被关闭或切换）
async function sessionLoop(ai, userId, sessionId) {
  let currentSid = null, firstTurn = false;
  while (true) {
    // 检查会话是否仍然存在且未被关闭或切换
    const sess = sessionById(ai, userId, sessionId);
    if (!sess || sess._closing) break;
    if (sess.id !== (ensureUser(userId, ai).activeId)) break;
    // 如果有排队消息且当前不忙，取出下一条处理
    if (sess.queue?.length && !sess.busy) {
      const next = sess.queue.shift();                    // 从队列头部取出一条消息
      const { body, contextToken, onProc } = next;
      sess.busy = true;                                   // 标记会话为忙碌状态
      if (!currentSid || currentSid !== sess.sid) { currentSid = sess.sid; firstTurn = sess._firstTurn; }
      try {
        await processTurn(ai, userId, currentSid, sess.name, body, contextToken, firstTurn, onProc, sess);
        // 如果本轮成功（无失败记录），后续轮次不视为 firstTurn
        if (!sess._lastFailedTurn) { firstTurn = false; } else { currentSid = null; }
      } catch (e) {
        log("⚠", `[${sess.name}] loop error: ${e.message}`);
      } finally { sess.busy = false; sess._lastEnd = Date.now(); saveSessions(); }
    }
    await sleep(250);                                     // 空闲时 250ms 轮询间隔
  }
}

// ═══════════════════════════════════════════════════════════════
// queueTurn() —— 将一条消息加入指定会话的队列
// ═══════════════════════════════════════════════════════════════
// 用途：把用户消息放入目标会话的待处理队列；如果该会话的循环尚未启动，则自动启动
// 输入：
//   messageAI - 目标 AI 后端（默认使用全局 activeAI）
//   userId    - 用户 ID
//   body      - 消息正文
//   ctx       - 微信上下文对象（含 context_token）
//   sessionId - 目标会话 ID（可选，默认使用当前活跃会话）
// 输出：Boolean - 是否成功入队
function queueTurn(messageAI, userId, body, ctx, sessionId = null) {
  const ai = messageAI || activeAI;
  const sess = sessionId ? sessionById(ai, userId, sessionId) : activeSession(userId, ai);
  if (!sess) return false;
  log("+", `[${sess.name}] queued: ${body.slice(0, 80)}`);
  sess._lastUserAt = new Date().toISOString();
  // 将消息包装后加入队列
  sess.queue.push({ body, contextToken: ctx.context_token || ctx.contextToken, onProc: ctx.onProc || (() => {}) });
  // 如果循环尚未运行，立即启动
  if (!sess._loopRunning) { sess._loopRunning = true; sessionLoop(ai, userId, sess.id).finally(() => { sess._loopRunning = false; }); }
  return true;
}

// ═══════════════════════════════════════════════════════════════
// enqueueUserBody() —— 将用户消息入队（含去重和可选新会话创建）
// ═══════════════════════════════════════════════════════════════
// 用途：对用户消息进行去重检查后入队处理；支持在入队前根据 opts 创建新会话
// 输入：
//   messageAI - AI 后端标识
//   userId    - 用户 ID
//   body      - 消息正文
//   ctx       - 微信上下文对象
//   opts      - 可选参数：createSession（创建新会话）、profile（角色绑定）
// 输出：Boolean - 是否成功入队
function enqueueUserBody(messageAI, userId, body, ctx, opts = {}) {
  const ai = messageAI || activeAI;
  const sess = activeSession(userId, ai);
  if (!sess) return false;
  // 平台重投的重复消息应忽略；上一轮明确失败时，允许同一正文立即重试一次。
  const duplicate = isDuplicateInput(userId, body);
  if (duplicate && sess._lastFailedTurn?.body !== body) {
    log("⏸", `dup ignored: ${body.slice(0, 60)}`);
    return false;
  }
  if (duplicate) sess._lastFailedTurn = null;
  // 可选：先创建新会话再入队
  if (opts.createSession) {
    const name = nextSessionName(userId, ai);
    const profile = opts.profile || sess._profile || null;
    const newSess = makeSession(name, profile);
    const u = ensureUser(userId, ai);
    u.list.push(newSess); u.activeId = newSess.id;
    saveSessions();
    return queueTurn(ai, userId, body, ctx, newSess.id);
  }
  return queueTurn(ai, userId, body, ctx, sess.id);
}

// ═══════════════════════════════════════════════════════════════
// flushPendingInput() —— 立即提交待处理的批量输入
// ═══════════════════════════════════════════════════════════════
// 用途：取消定时器，将累积中的待处理消息立即提交处理（不走批合并逻辑）
// 输入：userId - 用户 ID
// 输出：无
const inputBatcher = new InputBatcher({
  pendingInputs,
  delayMs: INPUT_BATCH_MS,
  onFlush: (messageAI, userId, body, ctx) => enqueueUserBody(messageAI, userId, body, ctx),
});

function flushPendingInput(userId) {
  return inputBatcher.flush(userId);
}


// ─── MESSAGE HANDLER（消息处理入口）────────────────────────────
// ═══════════════════════════════════════════════════════════════
// handleMessage() —— 所有微信消息的统一处理入口
// ═══════════════════════════════════════════════════════════════
// 用途：接收原始微信消息对象，提取有效载荷后按消息类型分发处理：
//       1. 斜杠命令（/help, /cc, /codex, /api, /new, /switch, /rename,
//          /sessions, /mode, /profile, /close, /status, /cancel, /memory）
//       2. 普通文本消息 → 入队等待 AI 回复
//       3. 支持批量合并（附件消息等）和去重
// 输入：msg - 微信原始消息对象 { from_user_id, context_token, ... }
// 输出：无（副作用：发送微信消息、入队处理等）
async function handleMessage(msg) {
  const userId = msg.from_user_id;       // 发送者微信 ID
  const ctx = msg.context_token;         // 微信上下文 token
  const contextToken = msg.context_token;
  const arrivalOrder = inputBatcher.nextOrder();
  const arrivalAI = activeAI;
  const mediaRef = messageHasBatchableMedia(msg)
    ? inputBatcher.reserveMedia({
        userId,
        messageAI: arrivalAI,
        ctx: { context_token: contextToken },
        order: arrivalOrder,
      })
    : null;

  // 提取消息有效载荷（文本、附件、媒体等）
  let payload;
  try {
    payload = await extractInboundPayload(msg);
  } catch (error) {
    if (mediaRef) {
      inputBatcher.completeMedia(mediaRef, {
        body: `[媒体：下载或解析失败：${error.message}]`,
        ctx: { context_token: contextToken },
      });
    }
    throw error;
  }
  let body = payload.body;               // 提取后的消息正文
  const { canAppendToBatch } = payload;  // 批处理标志
  if (mediaRef) {
    inputBatcher.completeMedia(mediaRef, {
      body,
      ctx: { context_token: contextToken },
    });
    return;
  }
  if (!body.trim()) return;              // 空消息直接忽略

  const messageAI = activeAI;            // 当前活跃的 AI 后端
  const activeSess = activeSession(userId, messageAI);
  const prefix = replyPrefix(activeSess?.name || "S1", messageAI);
  const isCommand = /^\/\S+/.test(body); // 是否为斜杠命令
  // 非 /cancel 的命令都会先 flush 待处理的批量输入
  if (isCommand && !/^\/cancel$/.test(body)) {
    await flushPendingInput(userId);
  }

  // /help —— 显示命令列表与使用帮助
  if (/^\/help$/.test(body)) { await handleHelp(userId, ctx); return; }

  // /cc —— 将当前会话切换到 Claude Code AI 后端
  if (/^\/cc$/.test(body)) { await handleCC(userId, ctx); return; }

  // /codex —— 将当前会话切换到 Codex AI 后端
  if (/^\/codex$/.test(body)) { await handleCodex(userId, ctx); return; }

  // /api —— 将当前会话切换到 Direct API AI 后端
  if (/^\/api$/.test(body)) { await handleAPI(userId, ctx, messageAI); return; }

  // /new —— 创建新的命名会话
  if (/^\/new(\s|$)/.test(body)) { await handleNew(userId, body, ctx, messageAI); return; }

  // /switch —— 切换到指定名称的会话
  if (/^\/switch(\s|$)/.test(body)) { await handleSwitch(userId, body, ctx); return; }

  // /rename —— 重命名当前会话
  if (/^\/rename(\s|$)/.test(body)) { await handleRename(userId, body, ctx, messageAI); return; }

  // /sessions —— 列出当前所有会话
  if (/^\/sessions$/.test(body)) { await handleSessions(userId, ctx); return; }

  // /profile —— 管理角色模板配置
  if (/^\/profile(\s|$)/.test(body)) { await handleProfile(userId, body, ctx, activeSess); return; }

  // /close —— 关闭当前会话
  if (/^\/close(\s|$)/.test(body)) { await handleClose(userId, body, ctx); return; }

  // /status —— 查看当前系统运行状态
  if (/^\/status$/.test(body)) { await handleStatus(userId, ctx); return; }

  // /cancel —— 取消待处理的批量输入
  if (/^\/cancel$/.test(body)) { await handleCancel(userId, body, ctx, activeSess); return; }

  // ── route to active session（普通消息路由至活跃会话）───────
  const messageAIFinal = activeAI;
  if (canAppendToBatch) {
    // 可以追加到已有的批量消息中
    const appended = inputBatcher.appendText({
      userId,
      messageAI: messageAIFinal,
      body,
      ctx: { context_token: contextToken },
      order: arrivalOrder,
    });
    if (!appended) enqueueUserBody(messageAIFinal, userId, body, { context_token: contextToken });
  } else {
    // 其他消息先提交已有批次，避免跨类型乱序
    await flushPendingInput(userId);
    enqueueUserBody(messageAIFinal, userId, body, { context_token: contextToken });
  }
}


// ─── STARTUP CHECK（启动自检）─────────────────────────────────
// ═══════════════════════════════════════════════════════════════
// startupCheck() —— 启动时对所有依赖进行自检
// ═══════════════════════════════════════════════════════════════
// 用途：在 bot 启动时检测所有关键依赖是否可用，并在控制台输出检查报告。
//       检查项包括：Claude Code/Codex CLI、Direct API 配置、Python、Voice WhisperX、
//       ffmpeg、RAG 知识库索引、视觉模式配置、Node 依赖
// 输入：无
// 输出：无（直接写入 process.stdout）
function startupCheck() {
  const checks = [];
  const pass = (label, detail = "") => checks.push({ ok: true, label, detail });                      // 正常通过
  const warn = (label, detail = "") => checks.push({ ok: false, label, detail, critical: false });    // 警告（非致命）
  const fail = (label, detail = "") => checks.push({ ok: false, label, detail, critical: true });     // 严重（致命）

  const claudeAvailable = commandExists(CLAUDE);
  const codexAvailable = commandExists(CODEX);
  const apiAvailable = isApiConfigured();

  // Claude Code 和 Codex 都是可选入口；至少有一个 AI 后端可用即可启动聊天。
  if (claudeAvailable) {
    pass("Claude Code", CLAUDE);
  } else {
    warn("Claude Code", `${CLAUDE} 不存在 (Claude Code 功能将不可用)`);
  }

  if (codexAvailable) {
    pass("Codex", CODEX);
  } else {
    warn("Codex", `${CODEX} 不存在 (Codex 功能将不可用)`);
  }

  // 检查 Direct API 配置
  if (apiAvailable) {
    const { baseUrl, model } = resolveApiConfig();
    pass("Direct API", `${baseUrl} (${model})`);
  } else {
    warn("Direct API", "未配置 api.baseUrl/api.apiKey (/api 命令不可用，不影响 CC 使用)");
  }
  if (!claudeAvailable && !codexAvailable && !apiAvailable) {
    fail("AI 后端", "Claude Code、Codex 和 Direct API 均不可用");
  }

  // 检查 Python 可用性（RAG 和文件提取依赖）
  const py = spawnSync("python", ["--version"], { encoding: "utf8", timeout: 3000, windowsHide: true });
  if (py.status === 0) {
    pass("Python", (py.stdout || py.stderr || "").trim());
  } else {
    fail("Python", "python 命令不可用 (RAG / 文件提取将不可用)");
  }

  // 检查语音转文本（WhisperX）可用性
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

  // 检查 ffmpeg 可用性（用于视频首帧提取）
  const ff = spawnSync("ffmpeg", ["-version"], { encoding: "utf8", timeout: 3000, windowsHide: true });
  if (ff.status === 0) {
    pass("ffmpeg", "已安装");
  } else {
    warn("ffmpeg", "未找到 (视频首帧提取将不可用)");
  }

  // 检查 RAG 向量知识库索引状态
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

  // 检查视觉模式配置
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

  // 检查关键 Node 依赖
  if (fs.existsSync(appPath("node_modules", "qrcode-terminal"))) {
    pass("Node 依赖", "qrcode-terminal 已安装");
  } else {
    warn("Node 依赖", "qrcode-terminal 未安装 (二维码终端显示将降级)");
  }

  // 输出检查报告
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

// ─── MAIN LOOP（主消息循环）───────────────────────────────────
// ═══════════════════════════════════════════════════════════════
// mainLoop() —— 微信消息长轮询循环
// ═══════════════════════════════════════════════════════════════
// 用途：通过微信 API 的长轮询机制持续获取新消息，每收到一批消息就交给
//       handleMessage 处理。包含错误重试和会话过期检测。
// 输入：无
// 输出：无（死循环，永不返回；仅进程退出时终止）
async function mainLoop() {
  let consecutiveFails = 0;       // 连续失败计数器（非网络错误）
  let transientFails = 0;        // 临时网络错误计数器
  let lastTransientLog = 0;      // 上次记录网络错误日志的时间
  while (true) {
    try {
      // 调用微信 getupdates API，使用长轮询获取新消息
      const resp = await apiPost("ilink/bot/getupdates", { get_updates_buf: getUpdatesBuf || "" }, LONG_POLL_TIMEOUT_MS + 5000);
      // 会话过期（errcode=-14），等待 5 分钟后重试
      if (resp.errcode === -14) { log("⏸", "session expired, retry in 5min..."); await sleep(300_000); continue; }
      // 非零返回码，递增失败计数
      if (resp.ret && resp.ret !== 0) {
        consecutiveFails++;
        log("⚠", `getupdates ret=${resp.ret} (${consecutiveFails}/3)`);
        if (consecutiveFails >= 3) { await sleep(30_000); consecutiveFails = 0; } else { await sleep(2000); }
        continue;
      }
      // 成功：重置计数器，更新同步缓冲区
      consecutiveFails = 0; transientFails = 0;
      if (resp.get_updates_buf) { setSyncBuf(resp.get_updates_buf); saveToken(); }
      // 处理每条新消息
      for (const m of (resp.msgs || [])) {
        if (m.message_type === 1 && m.from_user_id) handleMessage(m).catch(e => log("⚠", `handleMessage: ${e.message}`));
      }
    } catch (e) {
      // 区分临时网络错误和永久性错误
      if (isTransientGetUpdatesError(e)) {
        transientFails++;
        const now = Date.now();
        // 连续 3 次临时错误且距上次日志超过 60 秒时输出警告
        if (transientFails >= 3 && now - lastTransientLog > 60_000) {
          log("⚠", `getupdates network (${transientFails} in a row)`);
          lastTransientLog = now;
        }
        await sleep(Math.min(transientFails * 500, 8_000));  // 线性退避（最长 8 秒）
      } else {
        log("⚠", `getupdates fatal: ${e.message}`);
        await sleep(3_000);                                   // 永久错误等待 3 秒后重试
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// main() —— 应用主入口
// ═══════════════════════════════════════════════════════════════
// 用途：协调整个 bot 的启动流程，包括：
//       1. 注册崩溃保护（uncaughtException / unhandledRejection）
//       2. 获取实例锁
//       3. 启动自检和日志清理
//       4. 恢复上次 AI 后端状态
//       5. 加载模型名、角色模板、会话数据、世界状态
//       6. 初始化 API 上下文（如以 API 模式启动）
//       7. 启动 GUI 管理服务器并注册所有路由
//       8. 微信登录（Token 验证 / 扫码登录）
//       9. 启动主动意图检查定时器
//      10. 进入主消息循环
// 输入：无
// 输出：无
async function main() {
  // ─── CRASH GUARDS（崩溃保护）─────────────────────────────────
  // 捕获未处理的同步异常和异步 rejected Promise，避免进程静默崩溃
  process.on("uncaughtException", (e) => { log("✕", `uncaught: ${e.message}\n${e.stack?.slice(0, 300)}`); });
  process.on("unhandledRejection", (r) => { log("✕", `unhandled rejection: ${r}`); });
  process.on("exit", releaseInstanceLock);                                                          // 正常退出时释放锁
  process.on("SIGINT", () => { stopServer(); releaseInstanceLock(); process.exit(0); });             // Ctrl+C 信号处理（用户中断进程）
  process.on("SIGTERM", () => { stopServer(); releaseInstanceLock(); process.exit(0); });            // kill 信号

  // ─── STARTUP（启动流程）───────────────────────────────────────
  acquireInstanceLock();                    // 1. 确保单实例运行
  process.stdout.write("\nWeChat AI Bot\n=============\n");
  startupCheck();                           // 2. 依赖自检
  cleanupOldLogs();                         // 3. 立即执行一次日志清理
  setInterval(cleanupOldLogs, LOG_CLEANUP_INTERVAL_MS).unref(); // 4. 定时日志清理（.unref() 使定时器不阻止进程退出）

  // 从 token 文件中恢复上次使用的 AI 后端（CC/Codex/API）
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const d = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
      if (d.lastActiveAI === "cc" || d.lastActiveAI === "codex" || d.lastActiveAI === "api") setActiveAI(d.lastActiveAI);
    }
  } catch {}

  // 加载运行数据
  loadModelNames();    // 读取各 AI 后端的模型名称
  loadProfiles();      // 加载角色模板
  loadSessions();      // 加载会话数据（从持久化存储）
  loadRoleWorlds();    // 加载角色世界状态

  // 以 API 模式启动时，为所有活跃会话加载历史上下文
  if (activeAI === "api") {
    try {
      const store = sessions.api;
      for (const [, u] of store) {
        const activeSess = u.list.find(s => s.id === u.activeId);
        if (activeSess && (!activeSess._apiMessages || activeSess._apiMessages.length === 0)) {
          const events = await loadAllEvents();
          const sessionEvents = events.filter(e => e.sessionId === activeSess.id && e.text?.trim()).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
          activeSess._apiMessages = sessionEvents.map(e => ({ role: e.role === "assistant" ? "assistant" : "user", content: e.text, _eventId: e.id }));
        }
      }
    } catch (e) { log("⚠", `API context init fail: ${e.message}`); }
  }

  // ─── Start GUI server first（启动 GUI 管理界面）──────────────
  // 注册所有 HTTP 路由模块
  registerStatusRoutes();      // 状态监控
  registerSessionRoutes();     // 会话管理
  registerProfileRoutes();     // 角色管理
  registerConfigRoutes();      // 配置管理
  registerHistoryRoutes();     // 聊天历史
  registerProactiveRoutes();   // 主动意图
  registerMemoryRoutes();      // 记忆管理
  registerPromptsRoutes();     // Prompt 管理
  registerWorldRoutes();       // 世界状态
  startServer();               // 启动 HTTP 服务器

  // ─── WeChat login（微信登录）──────────────────────────────────
  if (!loadToken()) {
    // 无 token 或 token 无效 → 扫码登录
    await loginWithQr();
  } else {
    // 有 token → 验证其有效性
    try {
      const resp = await apiPost("ilink/bot/getupdates", { get_updates_buf: "" }, 10_000);
      if (resp.errcode === -14 || (resp.ret && resp.ret !== 0 && resp.errcode)) {
        // Token 过期或无效 → 重新扫码登录
        log("⚠️", "Token 过期，重新登录..."); setToken(null); await loginWithQr();
      } else {
        if (resp.get_updates_buf) setSyncBuf(resp.get_updates_buf);
      }
    } catch {
      // API 调用失败 → 视为 token 问题，重新登录
      log("⚠️", "Token 验证失败，重新登录..."); setToken(null); await loginWithQr();
    }
  }

  log("✓", `listening on WeChat (${activeAI === "cc" ? "CC" : activeAI === "api" ? "API" : "Codex"})`);
  // 启动主动意图检查定时器（每 15 秒检测是否需要主动向用户发送消息）
  const PROACTIVE_TIMER_MS = 15_000;
  setInterval(() => { checkProactiveIntents().catch(e => log("⚠️", `proactive check: ${e.message}`)); }, PROACTIVE_TIMER_MS).unref();
  // 进入主消息循环（阻塞在此，永不返回）
  await mainLoop();
}

// 入口判断：如果当前文件是 Node.js 直接运行的脚本（而非被 import），则执行 main()
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
