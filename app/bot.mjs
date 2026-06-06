import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, execSync } from "node:child_process";

// ─── CONFIG ───────────────────────────────────────────────────
import { configValue, envOrConfig, configBool, configNumber } from "./lib/config.mjs";
import { RUNTIME_DIR, dataPath, ensureDir, resolveProjectPath } from "./lib/paths.mjs";

const RAG_SCRIPT = resolveProjectPath(configValue("paths.ragScript", "app/rag.py"));
const RAG_ENABLED = configBool("rag.enabled", true);
const RAG_KNOWLEDGE_DIR = resolveProjectPath(configValue("rag.knowledgeDir", "data/knowledge"));
const RAG_TIMEOUT_MS = configNumber("rag.timeoutMs", 45_000);
const RAG_HTTPS_PROXY = envOrConfig("WECHAT_RAG_HTTPS_PROXY", "proxy.ragHttps", envOrConfig("WECHAT_HTTPS_PROXY", "proxy.https", ""));
const RAG_PROFILE_RULE_MAX_CHARS = configNumber("rag.profileRuleMaxChars", 1400);
const INPUT_BATCH_MS = 30_000;
const CURRENT_SITE_AND_SEARCH_GUARD = [
  "【当前现场与检索补充规则】",
  "如果本轮没有被上下文明确限制，scenelet 优先选择千圣此刻正在经历的当前现场，而不是把外部活动写成回家后的回顾。片场、摄影棚、经纪公司、化妆间、后台、排练室、录制现场、通告车上、商场、书店、车站、电车、旅行地、散步路上都可以成为当前现场。",
  "外部活动一旦被选为当前现场，就让她停留在那里接这句话：写现场声音、身体状态、等待/移动/工作间隙和手边的小物，不要自动收束到公寓、Leo、花音、餐桌、沙发。",
  "可以自然形成 1-3 天的短期生活线，例如短途旅行、外景拍摄、连续排练、广告/节目通告；它只能是轻量、可过期的私有生活安排，不要写成官方公开事实。",
  "如果回复要给出真实作品、书名、作者、歌曲、艺人近况、公开活动、截图/OCR 文字后的具体判断或安利，必须使用 WebSearch/WebFetch 确认；不搜索就不要给精确推荐或精确断言。",
  "最终 visible reply 不能使用方括号表情或动作，例如 [笑]、[偷笑]、[微笑]、[推眼镜]。可以用自然文字、中文圆括号、emoji 或 kaomoji。",
].join("\n");

const SESSION_LOCK_RETRIES = 3;
const SESSION_LOCK_RETRY_MS = 2_000;
const SESSION_RELEASE_GRACE_MS = 800;
const TOKEN_FILE = dataPath("wechat-token.json");
const LOG_RETENTION_DAYS = Number(process.env.WECHAT_LOG_RETENTION_DAYS ?? configValue("logs.retentionDays", 30));
const LOG_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INSTANCE_LOCK_FILE = dataPath("runtime", ".wechat-aibot.lock");
import { MAX_REPLY_LEN, splitText, hasInboundAttachment, splitSocialReply, loadPrompts } from "./lib/reply.mjs";
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
import { extractInboundPayload, isDuplicateInput, shouldUseExternalVision, hasExternalVisionConfig, VOICE_ASR_ENABLED, VOICE_WHISPERX_PYTHON, VISION_MODE, VISION_MODEL, VISION_BASE_URL } from "./lib/media.mjs";

// ─── STATE ──────────────────────────────────────────────────
import { getUpdatesBuf, sessions, activeAI, profileTemplates, modelNames, pendingInputs, setToken, setSyncBuf, setActiveAI } from "./lib/state.mjs";
import { uuid, sleep, log, isPidRunning } from "./lib/utils.mjs";
import { loadToken, saveToken, loginWithQr, sendMessage, apiPost } from "./lib/wechat.mjs";
import { renderMemoryPrompt, memoryListText, memoryMaintenanceNotice, normalizeMemoryCategory } from "./lib/memory.mjs";
import { getSceneConfig, normalizeSceneState, normalizeVisibleHistory, normalizeToolUsage, emptyToolUsage, normalizeWorldState, sanitizeVisibleReplyText } from "./lib/normalize.mjs";
import { envWithProxy, commandExists, runClaudeStream, runCodexStream, toolUsageFromUsage, killProc, CLAUDE, CODEX, LOGS_DIR } from "./lib/claude-runner.mjs";
import { sessionProfile, mergeToolUsage, markToolUsage, getRoleWorld, saveRoleWorlds, loadRoleWorlds, syncRoleWorldToSession, applyLifeArcOps } from "./lib/world-state.mjs";
import { loadProfiles, makeSession, saveSessions, loadSessions } from "./lib/session-store.mjs";
import { buildStableStylePrompt, buildTurnBody, sceneStateText, appendVisibleHistory } from "./lib/prompts.mjs";
import { generateSceneletForTurn, buildSceneContextBlock, addProactiveCandidates, setSceneStateFromText, recordChatHistory, sendFinalAssistantMessage, checkProactiveIntents, updateUserMemoryFromTurn, replyPrefix } from "./lib/turn.mjs";
const USER_HOME = process.env.USERPROFILE || process.env.HOME || process.cwd();
const LONG_POLL_TIMEOUT_MS = 35_000;
let lastProactiveCheckAt = 0;
const roleWorlds = new Map();
globalThis.__wechatRoleWorlds = roleWorlds;
globalThis.__wechatSaveRoleWorlds = saveRoleWorlds;
globalThis.__wechatSaveSessions = saveSessions;

function loadModelNames() {
  try {
    const p = path.join(USER_HOME, ".claude", "settings.json");
    if (fs.existsSync(p)) {
      const d = JSON.parse(fs.readFileSync(p, "utf-8"));
      modelNames.cc = d.env?.ANTHROPIC_MODEL || d.model || "unknown";
    }
  } catch {}
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

// ─── RAG query ──────────────────────────────────────────────
function hasExplicitProfileName(userMessage, currentProfile = "") {
  return Object.keys(profileTemplates).some(name => name !== "默认" && name !== currentProfile && userMessage.includes(name));
}

function shouldUseRoleplayRag(userMessage) {
  const text = String(userMessage || "").trim();
  if (!text) return false;
  const kw = loadPrompts().ragKeywords || {};
  for (const key of ["lore", "names"]) {
    const pattern = String(kw[key] || "").trim();
    if (!pattern) continue;
    try { if (new RegExp(pattern, "u").test(text)) return true; } catch {}
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
  if (!RAG_ENABLED) return "";
  if (!fs.existsSync(RAG_SCRIPT)) return null;
  try {
    const t0 = Date.now();
    const queryFile = path.join(RUNTIME_DIR, ".rag_query.txt");
    ensureDir(RUNTIME_DIR);
    fs.writeFileSync(queryFile, userMessage, "utf-8");
    const args = ["-X", "utf8", RAG_SCRIPT, "query", "--file", queryFile];
    if (profile) args.push("--profile", profile);
    const result = spawnSync("python", args, {
      encoding: "utf8", timeout: RAG_TIMEOUT_MS, maxBuffer: 1024 * 1024,
      cwd: path.dirname(RAG_SCRIPT),
      env: envWithProxy(RAG_HTTPS_PROXY, { HF_HUB_DISABLE_SYMLINKS_WARNING: "1" }),
    });
    try { if (fs.existsSync(queryFile)) fs.rmSync(queryFile, { force: true }); } catch {}
    const ms = Date.now() - t0;
    if (result.status !== 0) return "";
    const raw = (result.stdout || "").trim();
    if (raw) log("\u{1F4DA}", `RAG hit in ${ms}ms (${raw.length} chars)`);
    return raw;
  } catch (e) { return ""; }
}

function profileRuleCandidates(profile) {
  const text = String(profileTemplates[profile] || "");
  const rulesDir = path.join(RAG_KNOWLEDGE_DIR, "05_模型规则");
  if (!text || !fs.existsSync(rulesDir)) return [];
  const results = [];
  try {
    for (const file of fs.readdirSync(rulesDir)) {
      if (!file.endsWith(".md")) continue;
      const content = fs.readFileSync(path.join(rulesDir, file), "utf-8");
      const headerMatch = content.match(/^# (.+)$/m);
      const title = headerMatch ? headerMatch[1].trim() : file.replace(/\.md$/, "");
      if (text.includes(title)) { results.push(content.slice(0, RAG_PROFILE_RULE_MAX_CHARS)); if (results.length >= 2) break; }
    }
  } catch {}
  return results;
}

function loadPinnedProfileRules(profile) {
  if (!profile || !profileTemplates[profile]) return "";
  const rules = profileRuleCandidates(profile);
  if (!rules.length) return "";
  return ["【角色补充规则（从知识库注入）】", "以下是在知识库中历史沉淀的角色补充规则，已写入 profile template，不要重复或覆盖：", ...rules, "【角色补充规则结束】"].join("\n");
}

// ─── SESSION MANAGEMENT ─────────────────────────────────────
function sessionMap(ai) { return sessions[ai || activeAI]; }
function ensureUser(userId, ai = activeAI) {
  const sMap = sessionMap(ai);
  if (!sMap.has(userId)) {
    const sess = makeSession("S1");
    sMap.set(userId, { activeId: sess.id, list: [sess] });
  }
  return sMap.get(userId);
}
function activeSession(userId, ai = activeAI) {
  const u = ensureUser(userId, ai);
  return u.list.find(s => s.id === u.activeId) || u.list[0];
}
function sessionById(ai, userId, sessionId) {
  return ensureUser(userId, ai).list.find(s => s.id === sessionId) || null;
}
function hasSessionName(userId, name, excludeId = null, ai = activeAI) {
  return ensureUser(userId, ai).list.some(s => s.name === name && s.id !== excludeId);
}
function nextSessionName(userId, ai = activeAI) {
  const existing = ensureUser(userId, ai).list.map(s => s.name);
  for (let i = 1; ; i++) { const c = `S${i}`; if (!existing.includes(c)) return c; }
}
function findSession(userId, key) {
  const u = ensureUser(userId);
  const byName = u.list.find(s => s.name === key);
  if (byName) return { sess: byName, setActive: true };
  const idx = parseInt(key, 10);
  if (Number.isFinite(idx) && idx >= 1 && idx <= u.list.length) return { sess: u.list[idx - 1], setActive: true };
  return { sess: u.list.find(s => s.id === u.activeId) || u.list[0], setActive: false };
}
function sessionsListText(userId) {
  const u = ensureUser(userId);
  const aiLabel = activeAI === "cc" ? "Claude Code" : "Codex";
  return [`${aiLabel} 会话 (${userId}):`].concat(
    u.list.map((s, i) => {
      const active = s.id === u.activeId ? " [当前]" : "";
      const busy = s.busy ? " [Busy]" : "";
      const q = (s.queue || []).length ? ` [Queue:${s.queue.length}]` : "";
      const profile = s._profile || "默认";
      return `\u{1F539}[${i + 1}] ${s.name}${busy}${q}  角色:${profile}`;
    })
  ).join("\n");
}

const TRANSIENT_GETUPDATES_CODES = new Set([
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED",
  "EPIPE", "ENETRESET", "ENETUNREACH", "EHOSTUNREACH",
]);
function isTransientGetUpdatesError(e) {
  const code = e?.cause?.code || e?.code || "";
  return (e?.message === "fetch failed" || e?.name === "TypeError") && TRANSIENT_GETUPDATES_CODES.has(code);
}

// ─── PROCESS ONE TURN ───────────────────────────────────────
async function processTurn(ai, userId, sid, sessionName, body, contextToken, firstTurn, onProc, styleState, failedTurn = null) {
  const turnStarted = Date.now();
  const turnProfile = sessionProfile(styleState);
  const prefix = replyPrefix(sessionName, ai);
  const isProfileChat = Boolean(turnProfile && profileTemplates[turnProfile] && turnProfile !== "默认");

  if (failedTurn) {
    const failedBody = failedTurn.body || "";
    const failedAt = Date.parse(failedTurn.timestamp || "");
    if (failedBody === body && failedAt && (turnStarted - failedAt < 10_000)) {
      log("\u{1F6AB}", `[${sessionName}] duplicate turn blocked`);
      return;
    }
  }

  const memoryPrompt = isProfileChat ? renderMemoryPrompt(userId, { profile: turnProfile }) : "";

  let sceneletResult = null;
  let sceneletError = null;
  if (isProfileChat) {
    try {
      sceneletResult = await generateSceneletForTurn({ userId, sess: styleState, profile: turnProfile, userBody: body, memoryPrompt });
    } catch (e) {
      sceneletError = e.message;
      log("\u{1F6A8}", `[${sessionName}] scenelet failed: ${e.message}`);
    }
  }

  const logEntry = { ts: new Date().toISOString(), ai, userId, sessionName, sid, firstTurn, isProfileChat, profile: turnProfile || "默认", bodyChars: String(body || "").length, sceneletChars: sceneletResult?.innerScenelet?.length || 0, sceneletError: sceneletError || null };
  const safeName = sessionName.replace(/[<>:"/\\|?*]/g, "_");
  const logFile = path.join(LOGS_DIR, `${safeName}-${ai}.jsonl`);
  const txtLogFile = path.join(LOGS_DIR, `${safeName}-${ai}.txt`);

  function appendLog(extra = {}) {
    try { if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true }); fs.appendFileSync(logFile, JSON.stringify({ ...logEntry, ...extra }) + "\n"); } catch {}
  }
  function writeTxtLog(label, content) {
    try { if (!content) return; if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true }); fs.appendFileSync(txtLogFile, `\n=== ${label} [${new Date().toISOString()}] ===\n` + String(content).trim() + "\n", "utf-8"); } catch {}
  }

  writeTxtLog("USER MESSAGE", body);
  if (memoryPrompt) writeTxtLog("MEMORY SNAPSHOT", memoryPrompt);
  if (sceneletResult?.innerScenelet) writeTxtLog("INNER SCENELET", sceneletResult.innerScenelet);

  let turnSucceeded = false;
  let assistantFullText = "";
  let toolUsage = emptyToolUsage();

  try {
    const ragContext = RAG_ENABLED && !hasInboundAttachment(body) && isProfileChat && shouldUseRagForTurn(body, turnProfile) ? queryRag(body, turnProfile) : "";
    const stableStyle = isProfileChat ? buildStableStylePrompt() : "";
    const ctxParts = [];
    if (sceneletResult) ctxParts.push(buildSceneContextBlock(styleState, sceneletResult));
    const sceneContext = ctxParts.join("\n\n---\n\n");
    const turnBody = buildTurnBody(body, ragContext, sceneContext, memoryPrompt);

    writeTxtLog("TURN BODY", turnBody);
    if (stableStyle) writeTxtLog("STABLE STYLE", stableStyle);

    let textBuf = "";
    let lastFlushAt = Date.now();
    const FLUSH_CHARS = isProfileChat ? 800 : 300;

    const streamResult = ai === "cc"
      ? await runClaudeStream(ai, sid, sessionName, turnBody, firstTurn, (event) => {
          if (event.type === "stream_event" && event.event?.type === "content_block_delta" && event.event.delta?.type === "text_delta") {
            textBuf += event.event.delta.text;
          } else if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text") textBuf += block.text;
              if (block.type === "tool_use") markToolUsage(toolUsage, block.name);
            }
          }
          if (event.type === "stream_event" && event.event?.type === "content_block_start" && event.event.content_block?.type === "tool_use") {
            markToolUsage(toolUsage, event.event.content_block.name);
          }
          if (textBuf.length >= FLUSH_CHARS || Date.now() - lastFlushAt >= 3000) {
            const flushText = textBuf.trim();
            if (flushText) { onProc({ type: "flush", text: flushText }); textBuf = ""; lastFlushAt = Date.now(); }
          }
        }, stableStyle, memoryPrompt, turnProfile, { routingBody: body })
      : await runCodexStream(ai, sid, sessionName, turnBody, firstTurn, (event) => {
          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text") textBuf += block.text;
              if (block.type === "tool_use") markToolUsage(toolUsage, block.name);
            }
          }
          if (textBuf.length >= FLUSH_CHARS || Date.now() - lastFlushAt >= 3000) {
            const flushText = textBuf.trim();
            if (flushText) { onProc({ type: "flush", text: flushText }); textBuf = ""; lastFlushAt = Date.now(); }
          }
        }, ragContext, stableStyle, memoryPrompt, turnProfile, { routingBody: body });

    if (streamResult?.proc) styleState._lastProc = streamResult.proc;
    if (streamResult?.code !== 0) throw new Error(`AI exited ${streamResult.code}${streamResult.stderr ? ": " + streamResult.stderr.slice(-500) : ""}`);
    if (textBuf.trim()) onProc({ type: "flush", text: textBuf.trim() });
    assistantFullText = textBuf.trim();

    const toolSummary = toolUsageFromUsage(streamResult?.toolUsage);
    if (toolSummary) { toolUsage.webSearch += toolSummary.webSearch; toolUsage.webFetch += toolSummary.webFetch; for (const t of toolSummary.tools) { if (!toolUsage.tools.includes(t)) toolUsage.tools.push(t); } }
    appendLog({ ragChars: ragContext?.length || 0, toolUsage: { webSearch: toolUsage.webSearch, webFetch: toolUsage.webFetch, tools: toolUsage.tools } });

    const t = (isProfileChat ? sanitizeVisibleReplyText(assistantFullText) : String(assistantFullText || "")).trim();
    if (t) {
      turnSucceeded = true;
      await sendFinalAssistantMessage(userId, t, contextToken, prefix, isProfileChat);
    }
  } catch (e) {
    log("\u{1F534}", `[${sessionName}] turn failed: ${e.message}`);
    styleState._lastFailedTurn = { body, timestamp: new Date().toISOString(), reason: e.message?.slice(0, 500), sid };
    await sendMessage(userId, `[系统提示] 回复失败：${e.message?.slice(0, 150)}`, contextToken).catch(() => {});
    appendLog({ error: e.message?.slice(0, 500) });
  } finally {
    if (turnSucceeded) {
      if (isProfileChat) assistantFullText = sanitizeVisibleReplyText(assistantFullText);
      styleState._lastAssistantAt = new Date().toISOString();
      styleState._lastContextToken = contextToken;
      styleState._lastFailedTurn = null;
      styleState._firstTurn = false;

      if (sceneletResult?.lifeArcOps?.length && isProfileChat) {
        const roleWorld = getRoleWorld(turnProfile);
        applyLifeArcOps(roleWorld, sceneletResult.lifeArcOps);
        syncRoleWorldToSession(styleState, turnProfile);
        saveRoleWorlds();
      }

      if (sceneletResult?.proactiveCandidates?.length && isProfileChat) {
        await addProactiveCandidates(styleState, sceneletResult, body);
      }

      appendVisibleHistory(styleState, "user", body, "chat", new Date().toISOString());
      appendVisibleHistory(styleState, "assistant", assistantFullText, "chat", new Date().toISOString());

      recordChatHistory({ ai, userId, sess: styleState, role: "assistant", kind: "chat", text: assistantFullText, scenelet: sceneletResult?.innerScenelet || "", sceneletStatus: sceneletResult ? "ok" : (sceneletError ? "error" : "skipped"), sceneletError: sceneletError || "", toolUsage });

      if (isProfileChat && assistantFullText) {
        updateUserMemoryFromTurn(userId, body, turnProfile).catch(e => log("⚠️", `memory writer skipped: ${e.message}`));
      }
      if (isProfileChat) {
        const notice = memoryMaintenanceNotice(userId, turnProfile);
        if (notice) sendMessage(userId, `[Memory]\n${notice}`, contextToken).catch(() => {});
      }

      if (styleState._kaomojiTurn >= 5) {
        styleState._recentKaomoji = (styleState._recentKaomoji || []).slice(-30);
        styleState._kaomojiTurn = 0;
      }
    }
    saveSessions();
  }
}

// ─── SESSION LOOP ──────────────────────────────────────────
async function sessionLoop(ai, userId, sessionId) {
  let currentSid = null, firstTurn = false;
  while (true) {
    const sess = sessionById(ai, userId, sessionId);
    if (!sess || sess._closing) break;
    if (sess.id !== (ensureUser(userId, ai).activeId)) break;
    if (sess.queue?.length && !sess.busy) {
      const next = sess.queue.shift();
      const { body, contextToken, onProc } = next;
      sess.busy = true;
      if (!currentSid || currentSid !== sess.sid) { currentSid = sess.sid; firstTurn = sess._firstTurn; }
      try {
        await processTurn(ai, userId, currentSid, sess.name, body, contextToken, firstTurn, onProc, sess, sess._lastFailedTurn);
        firstTurn = false;
      } catch (e) {
        log("\u{1F534}", `[${sess.name}] session loop error: ${e.message}`);
      } finally { sess.busy = false; sess._lastEnd = Date.now(); saveSessions(); }
    }
    await sleep(250);
  }
}

function queueTurn(messageAI, userId, body, ctx, sessionId = null) {
  const ai = messageAI || activeAI;
  const sess = sessionId ? sessionById(ai, userId, sessionId) : activeSession(userId, ai);
  if (!sess) return false;
  sess.queue.push({ body, contextToken: ctx.context_token || ctx.contextToken, onProc: ctx.onProc || (() => {}) });
  if (!sess._loopRunning) { sess._loopRunning = true; sessionLoop(ai, userId, sess.id).finally(() => { sess._loopRunning = false; }); }
  return true;
}

function enqueueUserBody(messageAI, userId, body, ctx, opts = {}) {
  if (isDuplicateInput(userId, body)) return false;
  const ai = messageAI || activeAI;
  const sess = activeSession(userId, ai);
  if (!sess) return false;
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

function flushPendingInput(userId) {
  const pending = pendingInputs.get(userId);
  if (!pending) return;
  pendingInputs.delete(userId); clearTimeout(pending.timer);
  enqueueUserBody(pending.messageAI, userId, pending.body, pending.ctx);
}

function clearPendingInput(userId) {
  const pending = pendingInputs.get(userId);
  if (pending) { clearTimeout(pending.timer); pendingInputs.delete(userId); }
}

// ─── MESSAGE HANDLER ───────────────────────────────────────
async function handleMessage(msg) {
  const { body, shouldBatch, canAppendToBatch } = await extractInboundPayload(msg);
  if (!body?.trim()) return;
  const userId = msg.from_user_id;
  const contextToken = msg.context_token;

  const cmdMatch = body.match(/^\s*\/(\S+)(?:\s+(.*))?$/s);
  if (cmdMatch) {
    const cmd = cmdMatch[1].toLowerCase();
    const arg = (cmdMatch[2] || "").trim();
    if (cmd === "cc" || cmd === "codex") {
      if (activeAI !== cmd) { setActiveAI(cmd); await sendMessage(userId, `已切换到 ${cmd === "cc" ? "Claude Code" : "Codex"}`, contextToken); }
      return;
    }
    if (cmd === "new") {
      const profileName = arg && Object.keys(profileTemplates).includes(arg) ? arg : null;
      const name = profileName || arg || nextSessionName(userId);
      const sess = makeSession(name, profileName);
      const u = ensureUser(userId); u.list.push(sess); u.activeId = sess.id;
      saveSessions();
      await sendMessage(userId, `已创建${profileName ? `角色[${profileName}]` : ""}会话：${name}`, contextToken);
      return;
    }
    if (cmd === "switch") {
      const { sess, setActive } = findSession(userId, arg);
      if (setActive) ensureUser(userId).activeId = sess.id;
      await sendMessage(userId, `已切换到：${sess.name}`, contextToken);
      return;
    }
    if (cmd === "rename") {
      const parts = arg.split(/\s+/);
      const { sess } = findSession(userId, parts[0] || "");
      const newName = parts.slice(1).join(" ") || parts[0];
      if (!newName || hasSessionName(userId, newName, sess.id)) { await sendMessage(userId, `名称无效或已存在：${newName || "(空)"}`, contextToken); return; }
      sess.name = newName; saveSessions();
      await sendMessage(userId, `已重命名为：${newName}`, contextToken);
      return;
    }
    if (cmd === "close") {
      const { sess } = findSession(userId, arg);
      if (ensureUser(userId).list.length <= 1) { await sendMessage(userId, "无法关闭最后一个会话", contextToken); return; }
      sess._closing = true;
      const u = ensureUser(userId);
      if (u.activeId === sess.id) u.activeId = u.list.find(s => s.id !== sess.id)?.id || u.list[0].id;
      u.list = u.list.filter(s => s.id !== sess.id);
      saveSessions();
      await sendMessage(userId, `已关闭：${sess.name}`, contextToken);
      return;
    }
    if (cmd === "status") {
      const sess = activeSession(userId);
      const aiLabel = activeAI === "cc" ? "Claude Code" : "Codex";
      const model = modelNames[activeAI] || "unknown";
      await sendMessage(userId, `[${aiLabel}] ${model}\n会话: ${sess.name} | 角色: ${sess._profile || "默认"}`, contextToken);
      return;
    }
    if (cmd === "profile") {
      const sess = activeSession(userId);
      if (!arg || arg === "off") { sess._profile = null; saveSessions(); await sendMessage(userId, "已解除角色绑定", contextToken); return; }
      if (!profileTemplates[arg]) { await sendMessage(userId, `角色 "${arg}" 不存在。可用角色：${Object.keys(profileTemplates).join("、")}`, contextToken); return; }
      sess._profile = arg; saveSessions();
      await sendMessage(userId, `当前会话已绑定角色：${arg}`, contextToken);
      return;
    }
    if (cmd === "memory") { await handleMemoryCommand(userId, body, contextToken, activeSession(userId)._profile || "默认"); return; }
    if (cmd === "sessions" || cmd === "threads" || cmd === "list") { await sendMessage(userId, sessionsListText(userId), contextToken); return; }
    if (cmd === "cancel") {
      const sess = activeSession(userId);
      if (sess._lastProc && sess._lastProc.pid) { killProc(sess._lastProc); sess._lastProc = null; await sendMessage(userId, "已取消当前任务", contextToken); }
      else { await sendMessage(userId, "没有正在运行的任务", contextToken); }
      return;
    }
    if (cmd === "help") {
      await sendMessage(userId, ["WeChat AI Bot 命令：", "/cc /codex /new /switch /rename /close /sessions /status /cancel /profile /memory /help"].join("\n"), contextToken);
      return;
    }
  }

  const messageAI = activeAI;
  if (shouldBatch) {
    const pending = pendingInputs.get(userId);
    if (pending && body === pending.body) clearTimeout(pending.timer);
    const combinedBody = pending && pending.messageAI === messageAI ? `${pending.body}\n---\n${body}` : body;
    clearPendingInput(userId);
    pendingInputs.set(userId, { messageAI, ctx: { context_token: contextToken }, body: combinedBody, timer: setTimeout(() => flushPendingInput(userId), INPUT_BATCH_MS) });
  } else if (canAppendToBatch) {
    const pending = pendingInputs.get(userId);
    if (pending && pending.messageAI === messageAI) { clearTimeout(pending.timer); pending.body = `${pending.body}\n${body}`; pending.timer = setTimeout(() => flushPendingInput(userId), INPUT_BATCH_MS); }
    else { clearPendingInput(userId); enqueueUserBody(messageAI, userId, body, { context_token: contextToken }); }
  } else {
    clearPendingInput(userId);
    enqueueUserBody(messageAI, userId, body, { context_token: contextToken });
  }
}

async function handleMemoryCommand(userId, body, ctx, activeProfile) {
  const arg = body.replace(/^\s*\/memory\s*/, "").trim();
  if (arg === "all") { const text = memoryListText(userId, { profile: activeProfile, full: true }); await sendMessage(userId, text || "暂无长期记忆", ctx); return; }
  const cat = normalizeMemoryCategory(arg);
  if (cat) { const text = memoryListText(userId, { profile: activeProfile, category: cat }); const labels = { trait: "性格/价值观", preference: "偏好", fact: "事实" }; await sendMessage(userId, text || `暂无[${labels[cat]}]分类记忆`, ctx); return; }
  if (arg && profileTemplates[arg]) { const text = memoryListText(userId, { profile: arg }); await sendMessage(userId, text || `角色 ${arg} 暂无长期记忆`, ctx); return; }
  if (arg && !profileTemplates[arg]) { await sendMessage(userId, `未知角色: ${arg}`, ctx); return; }
  const text = memoryListText(userId, { profile: activeProfile });
  await sendMessage(userId, text || "暂无长期记忆", ctx);
}

// ─── STARTUP CHECK ─────────────────────────────────────────
function startupCheck() {
  const results = [];
  const pass = (name, detail) => results.push({ name, status: "ok", detail });
  const warn = (name, detail) => results.push({ name, status: "warn", detail });
  const fail = (name, detail) => results.push({ name, status: "fail", detail });
  pass("Node.js", process.version);
  if (commandExists(CLAUDE)) pass("Claude Code", CLAUDE); else fail("Claude Code", `${CLAUDE} 不存在`);
  if (commandExists(CODEX)) pass("Codex", CODEX); else warn("Codex", `${CODEX} 不存在`);
  const py = spawnSync("python", ["--version"], { encoding: "utf8", timeout: 3000, windowsHide: true });
  if (py.status === 0) pass("Python", (py.stdout || py.stderr || "").trim()); else fail("Python", "python 不可用");
  if (VOICE_ASR_ENABLED) {
    const wx = spawnSync(VOICE_WHISPERX_PYTHON, ["-m", "whisperx", "--version"], { encoding: "utf8", timeout: 15000, windowsHide: true });
    if (wx.status === 0) pass("Voice WhisperX", (wx.stdout || wx.stderr || VOICE_WHISPERX_PYTHON).trim().split(/\r?\n/)[0]);
    else warn("Voice WhisperX", `${VOICE_WHISPERX_PYTHON} is not available`);
  } else warn("Voice WhisperX", "disabled");
  const ff = spawnSync("ffmpeg", ["-version"], { encoding: "utf8", timeout: 3000, windowsHide: true });
  if (ff.status === 0) pass("ffmpeg", "已安装"); else warn("ffmpeg", "未找到");
  if (RAG_ENABLED) {
    const storeDir = resolveProjectPath(configValue("rag.storeDir", "data/rag_vector_store"));
    const metaPath = path.join(storeDir, "rag_meta.json");
    if (fs.existsSync(metaPath)) pass("RAG 知识库", `${storeDir} (索引存在)`);
    else warn("RAG 知识库", `${storeDir} (索引不存在)`);
  }
  if (shouldUseExternalVision()) {
    if (hasExternalVisionConfig()) pass("视觉模式", `${VISION_MODE} -> external: ${VISION_MODEL} @ ${VISION_BASE_URL}`);
    else warn("视觉模式", `${VISION_MODE}: 外部视觉 API 未完整配置`);
  } else if (VISION_MODE === "off" || VISION_MODE === "none") warn("视觉模式", "off");
  else pass("视觉模式", `${VISION_MODE || "native"}`);
  return results;
}

// ─── MAIN LOOP ─────────────────────────────────────────────
async function mainLoop() {
  let consecutiveFails = 0;
  let transientFails = 0;
  let lastTransientLog = 0;
  while (true) {
    try {
      const resp = await apiPost("ilink/bot/getupdates", { get_updates_buf: getUpdatesBuf || "" }, LONG_POLL_TIMEOUT_MS + 5000);
      if (resp.errcode === -14) { log("⏸️", "session expired, retry in 5min..."); await sleep(300_000); continue; }
      if (resp.ret && resp.ret !== 0) {
        consecutiveFails++;
        log("⚠️", `getupdates ret=${resp.ret} (${consecutiveFails}/3)`);
        if (consecutiveFails >= 3) { await sleep(30_000); consecutiveFails = 0; } else { await sleep(2000); }
        continue;
      }
      consecutiveFails = 0; transientFails = 0;
      if (resp.get_updates_buf) { setSyncBuf(resp.get_updates_buf); saveToken(); }
      for (const m of (resp.msgs || [])) {
        if (m.message_type === 1 && m.from_user_id) handleMessage(m).catch(e => log("\u{1F534}", `handleMessage: ${e.message}`));
      }
      checkProactiveIntents().catch(e => log("⚠️", `proactive check: ${e.message}`));
    } catch (e) {
      if (isTransientGetUpdatesError(e)) {
        transientFails++;
        const now = Date.now();
        if (transientFails >= 3 && now - lastTransientLog > 60_000) {
          log("⚠️", `getupdates network issue (${transientFails} in a row)`);
          lastTransientLog = now;
        }
        await sleep(Math.min(transientFails * 500, 8_000));
      } else {
        log("\u{1F534}", `getupdates fatal: ${e.message}`);
        await sleep(3_000);
      }
    }
  }
}

async function main() {
  process.on("uncaughtException", (e) => { log("\u{1F4A5}", `uncaught: ${e.message}\n${e.stack?.slice(0, 300)}`); });
  process.on("unhandledRejection", (r) => { log("\u{1F4A5}", `unhandled rejection: ${r}`); });
  process.on("exit", releaseInstanceLock);
  process.on("SIGINT", () => { stopServer(); releaseInstanceLock(); process.exit(0); });
  process.on("SIGTERM", () => { stopServer(); releaseInstanceLock(); process.exit(0); });

  acquireInstanceLock();
  process.stdout.write("\nWeChat AI Bot\n=============\n");
  startupCheck();
  cleanupOldLogs();
  setInterval(cleanupOldLogs, LOG_CLEANUP_INTERVAL_MS).unref();

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

  registerStatusRoutes(); registerSessionRoutes(); registerProfileRoutes(); registerConfigRoutes();
  registerHistoryRoutes(); registerProactiveRoutes(); registerMemoryRoutes(); registerPromptsRoutes(); registerWorldRoutes();
  await startServer();
  sleep(600).then(() => { try { execSync("cmd /c start http://127.0.0.1:18720", { timeout: 5000, windowsHide: true }); } catch {} });

  process.stdout.write("GUI will open automatically after login at http://127.0.0.1:18720\n\n");
  loadToken();
  if (!getUpdatesBuf) await loginWithQr();
  saveToken();
  if (!getUpdatesBuf) loadSessions();
  log("\u{1F440}", "listening for WeChat messages...");
  await mainLoop();
}

await sleep(0);
main().catch(e => { process.stderr.write(`\u{1F4A5} uncaught: ${e.message}\n${e.stack}\n`); process.exit(1); });
