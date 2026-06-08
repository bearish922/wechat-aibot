import { uuid, log, sleep } from "./utils.mjs";
import { sessions, profileTemplates, pendingInputs } from "./state.mjs";
import { SCENELET_BARE, CLAUDE_MAIN_MODEL, runHiddenJson } from "./claude-runner.mjs";
import { loadPrompts, MAX_REPLY_LEN, splitText, splitSocialReply } from "./reply.mjs";
import { getSceneConfig, normalizeProactiveIntents, normalizeToolUsage, normalizeWorldState, applyWorldStatePatch, normalizeLifeArcs, normalizeSceneletResult, normalizeRawProactiveCandidate, normalizeScheduleCandidates, normalizeMemoryCandidates, normalizeMemoryOps, normalizeProactiveDecision, sanitizeVisibleReplyText, proactiveSentToday, lastConversationActivityMs } from "./normalize.mjs";
import { sessionProfile, roleWorldKey, ensureWorldSession, getRoleWorld, saveRoleWorlds, syncRoleWorldToSession, checkIntentDuplicateFlash, applyLifeArcOps, lifeArcPromptItems, getSceneMemory, setSceneMemory } from "./world-state.mjs";
import { saveSessions } from "./session-store.mjs";
import { getSceneMemorySystemBlock, buildSceneMemorySummaryPrompt, buildHiddenWorldSystemPrompt, buildHiddenWorldPrompt, buildProactivePrompt, buildScheduleFinalizationPrompt, recentVisibleContext, buildMemoryCandidatePrompt, buildMemoryMergePrompt, appendVisibleHistory } from "./prompts.mjs";
import { memoryItemsText, isMemoryEnabled, shouldRunMemoryWriter, listMemoryItems, applyMemoryOps } from "./memory.mjs";
import { appendChatEvent, loadAllEvents } from "./chat-history.mjs";
import { sendMessage } from "./wechat.mjs";

// ─── proactive timer ─────────────────────────────────────────
let lastProactiveCheckAt = 0;

// ─── orchestration ───────────────────────────────────────────

export async function generateSceneletForTurn({ userId, sess, profile, userBody, memoryPrompt }) {
  if (!profile || !profileTemplates[profile]) return null;
  const roleWorld = getRoleWorld(profile);
  const world = ensureWorldSession(roleWorld);
  const prompt = buildHiddenWorldPrompt({
    userId,
    sessionName: sess.name,
    profile,
    userBody,
    lifeArcs: lifeArcPromptItems(roleWorld),
    visibleContext: recentVisibleContext(sess),
    memoryPrompt,
    worldState: normalizeWorldState(roleWorld._worldState),
    proactiveIntents: normalizeProactiveIntents(sess._proactiveIntents).filter(i => i.status === "pending").slice(-getSceneConfig().hiddenWorldMaxPendingIntents),
    worldSession: world,
  });
  const sceneMemoryBlock = world.firstTurn ? getSceneMemorySystemBlock(roleWorld) : "";
  let raw = await runHiddenJson(prompt, {
    label: "hidden_world",
    bare: SCENELET_BARE,
    persist: true,
    sessionName: `hidden-world-${roleWorldKey(profile)}`,
    sessionId: world.sid,
    firstTurn: world.firstTurn,
    model: world.model || CLAUDE_MAIN_MODEL,
    systemPrompt: buildHiddenWorldSystemPrompt(profile, sceneMemoryBlock),
  });
  if (!raw) {
    world.sid = uuid();
    world.firstTurn = true;
    world.startedAt = new Date().toISOString();
    world.resetReason = "hidden world retry after failed attempt";
    raw = await runHiddenJson(prompt, {
      label: "hidden_world_retry",
      bare: SCENELET_BARE,
      persist: true,
      sessionName: `hidden-world-${roleWorldKey(profile)}`,
      sessionId: world.sid,
      firstTurn: true,
      model: world.model || CLAUDE_MAIN_MODEL,
      systemPrompt: buildHiddenWorldSystemPrompt(profile, getSceneMemorySystemBlock(roleWorld)),
    });
  }
  const result = normalizeSceneletResult(raw);
  if (!result?.innerScenelet) return null;
  if (raw?._hiddenCall?.session_id) world.sid = raw._hiddenCall.session_id;
  world.firstTurn = false;
  world.lastUsedAt = new Date().toISOString();
  world.lastUsage = result.hiddenCall || null;
  applyWorldStatePatch(roleWorld, result.worldStatePatch);
  roleWorld._worldLastOutput = {
    timestamp: world.lastUsedAt,
    innerScenelet: result.innerScenelet,
    worldStatePatch: result.worldStatePatch,
  };
  roleWorld.updatedAt = world.lastUsedAt;
  syncRoleWorldToSession(sess, profile);
  saveRoleWorlds();
  return result;
}

export function buildSceneContextBlock(sess, sceneletResult) {
  const cfg = loadPrompts();
  const profile = sessionProfile(sess);
  const lifeArcSummary = profile ? lifeArcPromptItems(getRoleWorld(profile)).map(arc => ({
    title: arc.title,
    progress_note: arc.progress_note,
    kind: arc.kind,
    time_start: arc.time_start,
    time_end: arc.time_end,
  })) : [];
  const parts = [
    lifeArcSummary.length ? [
      "【正在发生的事】",
      "千圣生活中跨越多天的安排，只作为时间参考和自然接话线索，不要主动复述。",
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

export async function addFollowUpCandidates(sess, sceneletResult, userBody) {
  if (!sess || !sceneletResult?.followUpCandidates?.length) return;
  const nowIso = new Date().toISOString();
  const existing = normalizeProactiveIntents(sess._proactiveIntents);
  for (const raw of sceneletResult.followUpCandidates.slice(0, getSceneConfig().maxFollowUpCandidatesPerTurn)) {
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

export function recordChatHistory({ ai, userId, sess, role, kind = "chat", text, scenelet = "", sceneletStatus = "", sceneletError = "", proactiveIntentId = "", toolUsage = null, ragUsage = null, timestamp = new Date().toISOString() }) {
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

export async function sendFinalAssistantMessage(userId, text, contextToken, prefix, isProfileChat = true) {
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
    if (messages.length > 1) await sleep(getSceneConfig().chunkSendDelayMs);
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
  if (reason) intent.cancelReason = String(reason).slice(0, getSceneConfig().maxCancelReasonLength);
}

async function evaluateProactiveIntent({ ai, userId, sess, profile, intent }) {
  const prompt = buildProactivePrompt({
    userId,
    sessionName: sess.name,
    profile,
    intent,
    visibleContext: recentVisibleContext(sess),
    sess,
  });
  const raw = await runHiddenJson(prompt, { label: "proactive" });
  return normalizeProactiveDecision(raw);
}

async function runDailyShareSeed({ sess, profile }) {
  const cfg = getSceneConfig();
  const roleWorld = getRoleWorld(profile);
  const now = new Date();
  const nowIso = now.toISOString();

  const promptParts = [
    loadPrompts().dailyShareSeedPrompt || "",
    "",
    "当前状态：",
    JSON.stringify({
      current_time: nowIso,
      time_of_day: now.getHours() < 6 ? "凌晨" : now.getHours() < 9 ? "清晨" : now.getHours() < 12 ? "上午" : now.getHours() < 14 ? "中午" : now.getHours() < 17 ? "下午" : now.getHours() < 20 ? "傍晚" : now.getHours() < 23 ? "晚上" : "深夜",
      month: now.getMonth() + 1,
      season: ["冬","冬","春","春","春","夏","夏","夏","秋","秋","秋","冬"][now.getMonth()],
      location: roleWorld._worldState?.location || "未知",
      activity: roleWorld._worldState?.activity || "未知",
      awake_state: roleWorld._worldState?.awakeState || "awake",
      profile: profile,
    }, null, 2),
  ];

  const raw = await runHiddenJson(promptParts.join("\n"), {
    label: "daily_share_seed",
    bare: true,
    model: CLAUDE_MAIN_MODEL,
    timeoutMs: 60000,
  });

  if (!raw || typeof raw !== "object") return null;
  if (!raw.has_share || !raw.message_intent) return null;

  const scheduledAt = raw.scheduled_at || new Date(now.getTime() + cfg.dailyShareDefaultScheduleOffsetMs).toISOString();
  const expiresAt = raw.expires_at || new Date(Date.parse(scheduledAt) + cfg.dailyShareDefaultExpiryOffsetMs).toISOString();

  return normalizeRawProactiveCandidate({
    kind: "daily_share",
    scheduled_at: scheduledAt,
    expires_at: expiresAt,
    message_intent: raw.message_intent,
    basis: raw.basis || "",
    cancel_if: raw.cancel_if || cfg.dailyShareDefaultCancelIf,
    inner_scenelet: raw.inner_scenelet || "",
  }, {
    nowIso,
    sourceUserText: "",
    defaultKind: "daily_share",
  });
}

async function maybeSeedDailyShareIntent({ ai, userId, sess, profile }) {
  const cfg = getSceneConfig();
  const roleWorld = getRoleWorld(profile);

  const nowMs = Date.now();
  const lastSeedMs = Date.parse(roleWorld._lastDailyShareSeedAt || sess._lastDailyShareSeedAt || "");
  if (Number.isFinite(lastSeedMs) && nowMs - lastSeedMs < cfg.dailyShareSeedIntervalMs) return { changed: false, intent: null };

  const lastActivityMs = lastConversationActivityMs(sess);
  if (!lastActivityMs || nowMs - lastActivityMs < cfg.dailyShareMinIdleMs) return { changed: false, intent: null };

  const nowIso = new Date(nowMs).toISOString();
  roleWorld._lastDailyShareSeedAt = nowIso;
  sess._lastDailyShareSeedAt = nowIso;
  saveRoleWorlds();

  const intent = await runDailyShareSeed({ sess, profile });
  return { changed: true, intent };
}



export async function runScheduleExtractor({ userBody, scenelet, profile }) {
  const prompt = [
    loadPrompts().scheduleExtractorPrompt || "",
    "",
    "本轮用户消息：",
    userBody || "",
    "",
    "千圣的内心叙事：",
    scenelet || "",
    "",
    "角色profile：", profile,
  ].join("\n");

  const raw = await runHiddenJson(prompt, {
    label: "schedule_extractor",
    bare: true,
    model: CLAUDE_MAIN_MODEL,
    timeoutMs: 45000,
  });

  if (!raw || !Array.isArray(raw.candidates)) return [];
  return raw.candidates.filter(c => c && c.title);
}
async function maybeCreateScheduleEntry({ sess, profile }) {
  const cfg = getSceneConfig();
  const roleWorld = getRoleWorld(profile);
  const activeSchedules = normalizeLifeArcs(roleWorld._lifeArcs).filter(a => a.kind);
  const candidates = normalizeScheduleCandidates(roleWorld._pendingScheduleCandidates || []);
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
    .slice(-cfg.scheduleRecentKindsLimit)
    .map(a => a.kind);

  const visibleCtx = recentVisibleContext(sess);
  const visibleContext = visibleCtx.length ? JSON.stringify(visibleCtx, null, 2) : "";
  const prompt = buildScheduleFinalizationPrompt({
    profileSnippet: profile && profileTemplates[profile] ? profileTemplates[profile].slice(0, cfg.schedulePromptProfileMaxChars) : "",
    candidates,
    activeSchedules: activeSchedules.length
      ? activeSchedules.map(a => `- [${a.kind}] ${a.title || ""} (${a.timeStart || "?"} ~ ${a.timeEnd || "?"}) id:${a.id}`).join("\n")
      : "",
    recentKindsHint: recentKinds.length ? `最近曾创建过的日程类型：${[...new Set(recentKinds)].join("、")}。请避免短期内重复同类安排。` : "",
  });

  const result = await runHiddenJson(prompt, {
    label: "schedule_finalization",
    bare: false,
    model: CLAUDE_MAIN_MODEL,
    timeoutMs: cfg.scheduleFinalizationTimeoutMs,
  });

  if (!result || result.selected === "none" || Number(result.selected_index ?? -1) < 0) return true;
  const op = ["create", "update", "close"].includes(result.op) ? result.op : "create";
  const arc = result.life_arc;
  if (!arc) return true;
  if (op === "create") {
    if (!arc.title || !arc.kind) return true;
    if (activeSchedules.length >= cfg.scheduleMaxActive) return true;
  }
  if ((op === "update" || op === "close") && !arc.id) return true;

  const reason = result.basis ? String(result.basis).slice(0, cfg.scheduleBasisMaxLength) : "schedule creator";

  if (op === "close") {
    applyLifeArcOps(roleWorld, [{ op, id: arc.id, reason }]);
  } else {
    const timeEnd = arc.time_end || arc.timeEnd || null;
    const parsedEnd = Date.parse(timeEnd || "");
    const expiresAt = Number.isFinite(parsedEnd)
      ? new Date(parsedEnd + cfg.scheduleExpiryAfterEndBufferMs).toISOString()
      : new Date(nowMs + cfg.scheduleDefaultExpiryFromNowMs).toISOString();

    applyLifeArcOps(roleWorld, [{
      op,
      id: op === "update" ? arc.id : undefined,
      title: String(arc.title || "").slice(0, cfg.scheduleArcTitleMaxLength),
      summary: String(arc.summary || "").slice(0, cfg.scheduleArcSummaryMaxLength),
      kind: arc.kind,
      subject: arc.subject || null,
      time_start: arc.time_start || arc.timeStart || null,
      time_end: timeEnd,
      expires_at: expiresAt,
      progress_note: arc.progress_note || arc.progressNote || '',
      reason,
    }]);
  }

  roleWorld.updatedAt = new Date().toISOString();
  roleWorld._pendingScheduleCandidates = [];
  syncRoleWorldToSession(sess, profile);
  saveRoleWorlds();
  const opLabel = op === "close" ? "closed" : op === "update" ? "updated" : "created";
  log("\u{1F4C5}", `[${sess.name}] schedule ${opLabel}: [${arc.kind || "?"}] ${arc.title || arc.id || ""}`);
  return true;
}

export async function checkProactiveIntents() {
  const nowMs = Date.now();
  if (nowMs - lastProactiveCheckAt < getSceneConfig().proactiveCheckIntervalMs) return;
  lastProactiveCheckAt = nowMs;

  for (const { ai, userId, sess, profile } of activeProfileSessionEntries()) {
    if (sess.busy || sess.queue?.length || pendingInputs.has(userId)) continue;
    let allIntents = normalizeProactiveIntents(sess._proactiveIntents);
    let pending = allIntents.filter(x => x.status === "pending");

    let changed = false;

    const scheduleChanged = await maybeCreateScheduleEntry({ sess, profile }).catch(e => {
      log("⚠️", `schedule creator skipped: ${e.message}`);
      return false;
    });
    if (scheduleChanged) changed = true;

    const seeded = await maybeSeedDailyShareIntent({ ai, userId, sess, profile });
    if (seeded.changed) changed = true;
    if (seeded.intent) {
      allIntents = normalizeProactiveIntents([...allIntents, seeded.intent]);
      pending = allIntents.filter(x => x.status === "pending");
    }
    if (!pending.length) {
      if (changed) saveSessions();
      continue;
    }

    for (const intent of pending) {
      const scheduled = Date.parse(intent.scheduledAt);
      const expires = intent.expiresAt ? Date.parse(intent.expiresAt) : scheduled + getSceneConfig().proactiveDefaultExpiryOffsetMs;
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
        markProactiveIntent(intent, "cancelled", "send failed");
        changed = true;
        continue;
      }

      const sentAt = new Date().toISOString();
      markProactiveIntent(intent, "sent");
      sess._lastProactiveAt = sentAt;
      sess._lastAssistantAt = sentAt;
      appendVisibleHistory(sess, "assistant", decision.visibleReply, "proactive", sentAt);
      recordChatHistory({
        ai,
        userId,
        sess,
        role: "assistant",
        kind: "proactive",
        text: decision.visibleReply,
        scenelet: decision.innerScenelet || intent.innerScenelet,
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

export async function updateUserMemoryFromTurn(userId, userBody, profile) {
  if (!isMemoryEnabled(userId)) return [];
  if (!shouldRunMemoryWriter(userBody)) return [];
  const candidatesRaw = await runHiddenJson(buildMemoryCandidatePrompt(userBody, userId, profile), {
    label: "memory_candidate_extractor",
    bare: true,
    model: CLAUDE_MAIN_MODEL,
    timeoutMs: getSceneConfig().memoryCandidateTimeoutMs,
  });
  const candidates = normalizeMemoryCandidates(candidatesRaw?.candidates || candidatesRaw?.memory_candidates || []);
  if (!candidates.length) return [];

  const existingItems = listMemoryItems(userId, { profile });
  const planRaw = await runHiddenJson(buildMemoryMergePrompt({ userBody, userId, profile, candidates, existingItems }), {
    label: "memory_merge_planner",
    bare: true,
    model: CLAUDE_MAIN_MODEL,
    timeoutMs: getSceneConfig().memoryMergeTimeoutMs,
  });
  const ops = normalizeMemoryOps(planRaw?.ops || []);
  if (!ops.length) log("⚠️", `memory planner returned no ops for ${candidates.length} candidates`);
  const applied = applyMemoryOps(userId, profile, ops, "auto");
  if (applied.length) log("\u{1F9E0}", `memory updated: ${applied.map(x => x.op).join(",")}`);
  return applied;
}

// ─── scene memory ───────────────────────────────────────────

export async function generateSceneMemory({ userId, sess, profile, roleWorld }) {
  const cfg = getSceneConfig();
  const threshold = cfg.turnResetThreshold || 16;
  const memoryPrompt = memoryItemsText(userId, { profile });
  const allEvents = loadAllEvents();
  const sessionEvents = allEvents.filter(e => e.userId === userId && e.sessionId === sess.id && e.role && e.text);
  const chatHistory = sessionEvents.slice(-threshold * 2).map(e => ({
    role: e.role === "assistant" ? "assistant" : "user",
    time: e.timestamp || "",
    kind: e.kind || "chat",
    text: e.text,
  }));
  const recentScenelets = allEvents
    .filter(e => e.userId === userId && e.sessionId === sess.id && e.role === "assistant" && e.scenelet)
    .slice(-5)
    .map(e => e.scenelet);
  const worldState = normalizeWorldState(roleWorld._worldState);
  const lifeArcs = lifeArcPromptItems(roleWorld);
  const prompt = buildSceneMemorySummaryPrompt({
    visibleHistory: chatHistory,
    recentScenelets,
    worldState,
    lifeArcs,
    memoryPrompt,
    profile,
  });
  const raw = await runHiddenJson(prompt, {
    label: "scene_memory",
    bare: true,
    model: CLAUDE_MAIN_MODEL,
    timeoutMs: 90000,
  });
  return typeof raw === "string" ? raw : (raw?.summary || raw?.scene_memory || raw?.inner_scenelet || "");
}

export async function batchUpdateMemory({ userId, userMessages, profile }) {
  if (!isMemoryEnabled(userId)) return [];
  const msgs = (userMessages || []).filter(Boolean);
  if (!msgs.length) return [];

  const combinedBody = msgs.join("\n---\n");
  if (!shouldRunMemoryWriter(combinedBody)) return [];

  const candidatesRaw = await runHiddenJson(buildMemoryCandidatePrompt(combinedBody, userId, profile), {
    label: "memory_batch_candidates",
    bare: true,
    model: CLAUDE_MAIN_MODEL,
    timeoutMs: getSceneConfig().memoryCandidateTimeoutMs,
  });
  const candidates = normalizeMemoryCandidates(candidatesRaw?.candidates || candidatesRaw?.memory_candidates || []);
  if (!candidates.length) return [];

  const existingItems = listMemoryItems(userId, { profile });
  const planRaw = await runHiddenJson(buildMemoryMergePrompt({ userBody: combinedBody, userId, profile, candidates, existingItems }), {
    label: "memory_batch_merge",
    bare: true,
    model: CLAUDE_MAIN_MODEL,
    timeoutMs: getSceneConfig().memoryMergeTimeoutMs,
  });
  const ops = normalizeMemoryOps(planRaw?.ops || []);
  const applied = applyMemoryOps(userId, profile, ops, "auto");
  if (applied.length) log("\u{1F9E0}", `batch memory updated: ${applied.map(x => x.op).join(",")}`);
  return applied;
}

// replyPrefix helper - used by checkProactiveIntents and processTurn
export function replyPrefix(sessionName, ai = "cc") {
  const label = ai === "codex" ? "Codex" : "CC";
  return `[${label}] ${sessionName}`;
}
