import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ─── CONFIG ───────────────────────────────────────────────────
import { configValue, envOrConfig, configBool, configNumber } from "./lib/config.mjs";
import { RUNTIME_DIR, dataPath, ensureDir, resolveProjectPath, appPath } from "./lib/paths.mjs";

const RAG_SCRIPT = resolveProjectPath(configValue("paths.ragScript", "app/rag.py"));
const RAG_ENABLED = configBool("rag.enabled", true);
const RAG_KNOWLEDGE_DIR = resolveProjectPath(configValue("rag.knowledgeDir", "data/knowledge"));
const RAG_TIMEOUT_MS = configNumber("rag.timeoutMs", 45_000);
const RAG_HTTPS_PROXY = envOrConfig("WECHAT_RAG_HTTPS_PROXY", "proxy.ragHttps", envOrConfig("WECHAT_HTTPS_PROXY", "proxy.https", ""));
const RAG_PROFILE_RULE_MAX_CHARS = configNumber("rag.profileRuleMaxChars", 1400);
const INPUT_BATCH_MS = 30_000;

const SESSION_LOCK_RETRIES = 3;
const SESSION_LOCK_RETRY_MS = 2_000;
const SESSION_RELEASE_GRACE_MS = 800;
const TOKEN_FILE = dataPath("wechat-token.json");
const LOG_RETENTION_DAYS = Number(process.env.WECHAT_LOG_RETENTION_DAYS ?? configValue("logs.retentionDays", 90));
const LOG_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INSTANCE_LOCK_FILE = dataPath("runtime", ".wechat-aibot.lock");
import { MAX_REPLY_LEN, splitText, hasInboundAttachment, splitSocialReply, loadPrompts, expressionCapabilityPrompt } from "./lib/reply.mjs";
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
import { memoryItemsText, memoryListText, normalizeMemoryCategory } from "./lib/memory.mjs";
import { getSceneConfig, normalizeVisibleHistory, normalizeToolUsage, emptyToolUsage, normalizeWorldState, sanitizeVisibleReplyText, normalizeLifeArcs } from "./lib/normalize.mjs";
import { envWithProxy, commandExists, runClaudeStream, runCodexStream, toolUsageFromUsage, killProc, CLAUDE, CODEX, LOGS_DIR } from "./lib/claude-runner.mjs";
import { sessionProfile, markToolUsage, saveRoleWorlds, loadRoleWorlds, getSceneMemory, setSceneMemory, getRoleWorld, ensureWorldSession, syncRoleWorldToSession } from "./lib/world-state.mjs";
import { loadProfiles, makeSession, saveSessions, loadSessions } from "./lib/session-store.mjs";
import { buildTurnBody, appendVisibleHistory, getSceneMemorySystemBlock } from "./lib/prompts.mjs";
import { generateSceneletForTurn, buildSceneContextBlock, addFollowUpCandidates, generateFollowUpCandidates, recordChatHistory, sendFinalAssistantMessage, checkProactiveIntents, updateUserMemoryFromTurn, generateSceneMemory, batchUpdateMemory, runScheduleExtractor, replyPrefix } from "./lib/turn.mjs";
const USER_HOME = process.env.USERPROFILE || process.env.HOME || process.cwd();
const LONG_POLL_TIMEOUT_MS = 35_000;
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
  const n = parseInt(key);
  if (n >= 1 && n <= u.list.length) return u.list[n - 1];
  return u.list.find(s => s.name === key) || u.list.find(s => s.name.includes(key)) || null;
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
  log("\u{1F4E4}", `[${ai}] [${sessionName}] ${body.slice(0, 80)}`);
  const isProfileChat = Boolean(turnProfile && profileTemplates[turnProfile] && turnProfile !== "默认");

  if (failedTurn) {
    const failedBody = failedTurn.body || "";
    const failedAt = Date.parse(failedTurn.timestamp || "");
    if (failedBody === body && failedAt && (turnStarted - failedAt < 10_000)) {
      log("\u{1F6AB}", `[${sessionName}] duplicate turn blocked`);
      return;
    }
  }

  const memoryPrompt = isProfileChat ? (() => {
    const items = memoryItemsText(userId, { profile: turnProfile });
    if (!items) return "";
    const instruction = loadPrompts().memoryContextInstruction || "";
    return instruction ? `${instruction}\n\n${items}` : items;
  })() : "";

  const roleWorld = isProfileChat ? getRoleWorld(turnProfile) : null;
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

  let followUpPromise = null;
  if (isProfileChat && sceneletResult?.innerScenelet) {
    followUpPromise = generateFollowUpCandidates({
      innerScenelet: sceneletResult.innerScenelet,
      worldState: normalizeWorldState(roleWorld._worldState),
      profile: turnProfile,
      userBody: body,
      sess: styleState,
    }).catch(e => { log("⚠️", `[${sessionName}] follow_up gen failed: ${e.message}`); return []; });
  }

  let turnSucceeded = false;
  let assistantFullText = "";
  let toolUsage = emptyToolUsage();
  let lastUsage = null;
  const streamStartedAt = new Date().toISOString();

  try {
    const ragContext = RAG_ENABLED && !hasInboundAttachment(body) && isProfileChat && shouldUseRagForTurn(body, turnProfile) ? queryRag(body, turnProfile) : "";
    const stableStyle = isProfileChat ? expressionCapabilityPrompt() : "";
    const ctxParts = [];
    if (sceneletResult) ctxParts.push(buildSceneContextBlock(styleState, sceneletResult));
    const sceneContext = ctxParts.join("\n\n---\n\n");
    const sceneMemoryBlock = (isProfileChat && firstTurn) ? getSceneMemorySystemBlock(roleWorld) : "";
    const turnBody = buildTurnBody(body, ragContext, sceneContext, "", sceneMemoryBlock);

    writeTxtLog("TURN BODY", turnBody);
    if (stableStyle) writeTxtLog("STABLE STYLE", stableStyle);

    let textBuf = "";
    let lastFlushAt = Date.now();
    const FLUSH_CHARS = isProfileChat ? 800 : 300;

    const streamResult = ai === "cc"
      ? await runClaudeStream(ai, sid, sessionName, turnBody, firstTurn, (event) => {
          if (event.type === "stream_event" && event.event?.type === "content_block_delta" && event.event.delta?.type === "text_delta") {
            textBuf += event.event.delta.text;
            assistantFullText += event.event.delta.text;
          } else if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text") { textBuf += block.text; assistantFullText += block.text; }
              if (block.type === "tool_use") markToolUsage(toolUsage, block.name);
            }
          }
          if (event.type === "assistant" && event.message?.usage) {
            const u = event.message.usage;
            lastUsage = {
              type: "chat_usage",
              model: event.message.model || "unknown",
              session_id: sid,
              started_at: streamStartedAt,
              duration_ms: Date.now() - new Date(streamStartedAt).getTime(),
              input_tokens: u.input_tokens || 0,
              cache_read_input_tokens: u.cache_read_input_tokens || 0,
              cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
              output_tokens: u.output_tokens || 0,
            };
          }
          if (event.type === "stream_event" && event.event?.type === "content_block_start" && event.event.content_block?.type === "tool_use") {
            markToolUsage(toolUsage, event.event.content_block.name);
          }
          if (textBuf.length >= FLUSH_CHARS || Date.now() - lastFlushAt >= 3000) {
            const flushText = textBuf.trim();
            if (flushText) { onProc({ type: "flush", text: flushText }); textBuf = ""; lastFlushAt = Date.now(); }
          }
        }, stableStyle, memoryPrompt, turnProfile, { routingBody: body, includeMemoryInSystem: true })
      : await runCodexStream(ai, sid, sessionName, turnBody, firstTurn, (event) => {
          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text") { textBuf += block.text; assistantFullText += block.text; }
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
      if (lastUsage) styleState._lastUsage = lastUsage;

      if (followUpPromise) {
        try {
          const followUpCandidates = await followUpPromise;
          if (followUpCandidates.length) {
            await addFollowUpCandidates(styleState, { followUpCandidates }, body);
          }
        } catch (e) { log("⚠️", `[${sessionName}] follow_up gen: ${e.message}`); }
      }

      const userAt = new Date().toISOString();
      const assistantAt = new Date().toISOString();
      appendVisibleHistory(styleState, "user", body, "chat", userAt);
      appendVisibleHistory(styleState, "assistant", assistantFullText, "chat", assistantAt);

      recordChatHistory({ ai, userId, sess: styleState, role: "user", kind: "chat", text: body, timestamp: userAt });
      recordChatHistory({ ai, userId, sess: styleState, role: "assistant", kind: "chat", text: assistantFullText, scenelet: sceneletResult?.innerScenelet || "", sceneletStatus: sceneletResult ? "ok" : (sceneletError ? "error" : "skipped"), sceneletError: sceneletError || "", toolUsage, timestamp: assistantAt });

      if (isProfileChat && assistantFullText) {
        try {
          const activeSchedules = normalizeLifeArcs(roleWorld._lifeArcs).filter(a => a.status === "active" && a.kind);
          const newCandidates = await runScheduleExtractor({ userBody: body, scenelet: sceneletResult?.innerScenelet || "", profile: turnProfile, activeSchedules });
          if (newCandidates.length) {
            const existing = roleWorld._pendingScheduleCandidates || [];
            const existingTitles = new Set(existing.map(c => c.title));
            for (const c of newCandidates) {
              if (!existingTitles.has(c.title)) {
                existing.push(c);
                existingTitles.add(c.title);
              }
            }
            roleWorld._pendingScheduleCandidates = existing;
            syncRoleWorldToSession(styleState, turnProfile);
            saveRoleWorlds();
          }
        } catch (e) { log("⚠️", `[${sessionName}] schedule extractor: ${e.message}`); }

        styleState._turnCount = (styleState._turnCount || 0) + 1;
        const threshold = getSceneConfig().turnResetThreshold || 8;
        if (styleState._turnCount >= threshold) {
          try {
            const userMsgLog = styleState._userMessageLog || [];
            await batchUpdateMemory({ userId, userMessages: userMsgLog, profile: turnProfile });
            styleState._userMessageLog = [];
            const summary = await generateSceneMemory({ userId, sess: styleState, profile: turnProfile, roleWorld });
            if (summary) {
              setSceneMemory(roleWorld, summary);
              styleState.sid = uuid();
              styleState._firstTurn = true;
              styleState._turnCount = 0;
              const hw = ensureWorldSession(roleWorld);
              hw.sid = uuid();
              hw.firstTurn = true;
              hw.resetReason = `auto-reset after ${threshold} turns`;
              styleState._visibleHistory = styleState._visibleHistory.slice(-4);
              saveRoleWorlds();
              log("\u{1F504}", `[${sessionName}] session auto-reset after ${threshold} turns`);
            }
          } catch (e) {
            log("⚠️", `[${sessionName}] reset failed: ${e.message}`);
          }
        }
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
        if (!sess._lastFailedTurn) { firstTurn = false; } else { currentSid = null; }
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
  log("\u{1F4E9}", `[${messageAI}] [${sess.name}] ${userId}: ${body.slice(0, 80)}`);
  sess._lastUserAt = new Date().toISOString();
  sess.queue.push({ body, contextToken: ctx.context_token || ctx.contextToken, onProc: ctx.onProc || (() => {}) });
  if (!sess._loopRunning) { sess._loopRunning = true; sessionLoop(ai, userId, sess.id).finally(() => { sess._loopRunning = false; }); }
  return true;
}

function enqueueUserBody(messageAI, userId, body, ctx, opts = {}) {
  if (isDuplicateInput(userId, body)) { log("\u{1F501}", `duplicate ignored: ${userId}: ${body.slice(0, 80)}`); return false; }
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
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingInputs.delete(userId);
  return true;
}

// ─── MESSAGE HANDLER ───────────────────────────────────────
async function handleMessage(msg) {
  const userId = msg.from_user_id;
  const ctx = msg.context_token;
  const contextToken = msg.context_token;

  const payload = await extractInboundPayload(msg);
  let body = payload.body;
  const { shouldBatch, canAppendToBatch } = payload;
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
    const pending = pendingInputs.get(userId);
    const clearedPending = clearPendingInput(userId);

    const targetIdx = u.list.indexOf(target);
    const closedName = target.name;
    target._closing = true;

    if (target.queue.length === 0) {
      u.list.splice(targetIdx, 1);
    }

    let autoCreated = null;
    if (u.list.length === 0) {
      const newName = nextSessionName(userId);
      const newSess = makeSession(newName);
      u.list.push(newSess);
      u.activeId = newSess.id;
      autoCreated = newName;
    } else if (u.activeId === target.id) {
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
    if (sess._lastProc) {
      killProc(sess._lastProc);
      sess._lastProc = null;
    }
    sess.queue.length = 0;
    await sendMessage(userId, `# ${prefix}\n⏹️ 正在取消...${clearedPending ? "\n已清除待处理的附件消息" : ""}`, ctx);
    return;
  }

  // ── route to active session ──
  const messageAIFinal = activeAI;
  if (shouldBatch) {
    const pending = pendingInputs.get(userId);
    if (pending && body === (pending.body || (pending.parts && pending.parts.join("\n\n")))) {
      clearTimeout(pending.timer);
    }
    const combinedBody = pending && pending.messageAI === messageAIFinal
      ? `${pending.body || (pending.parts && pending.parts.join("\n\n"))}\n---\n${body}`
      : body;
    clearPendingInput(userId);
    pendingInputs.set(userId, {
      messageAI: messageAIFinal,
      ctx: { context_token: contextToken },
      body: combinedBody,
      timer: setTimeout(() => flushPendingInput(userId), INPUT_BATCH_MS),
    });
  } else if (canAppendToBatch) {
    const pending = pendingInputs.get(userId);
    if (pending && pending.messageAI === messageAIFinal) {
      clearTimeout(pending.timer);
      pending.body = `${pending.body || (pending.parts && pending.parts.join("\n\n"))}\n${body}`;
      pending.timer = setTimeout(() => flushPendingInput(userId), INPUT_BATCH_MS);
    } else {
      clearPendingInput(userId);
      enqueueUserBody(messageAIFinal, userId, body, { context_token: contextToken });
    }
  } else {
    clearPendingInput(userId);
    enqueueUserBody(messageAIFinal, userId, body, { context_token: contextToken });
  }
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
    const text = [label, memoryListText(userId, { profile: targetProfile })].filter(Boolean).join("\n\n");
    await sendMessage(userId, text, ctx);
    return;
  }
  if (rest === "all") {
    const text = [label, memoryListText(userId, { profile: targetProfile, full: true })].filter(Boolean).join("\n\n");
    await sendMessage(userId, text, ctx);
    return;
  }

  const category = ["性格", "偏好", "事实"].includes(rest) ? normalizeMemoryCategory(rest) : null;
  if (category) {
    const text = [label, memoryListText(userId, { profile: targetProfile, category, full: true })].filter(Boolean).join("\n\n");
    await sendMessage(userId, text, ctx);
    return;
  }

  await sendMessage(userId, help, ctx);
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
  const PROACTIVE_TIMER_MS = 15_000;
  setInterval(() => { checkProactiveIntents().catch(e => log("⚠️", `proactive check: ${e.message}`)); }, PROACTIVE_TIMER_MS).unref();
  await mainLoop();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
