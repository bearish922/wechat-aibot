import { uuid, log, sleep } from "./utils.mjs";
import { sessions, profileTemplates, pendingInputs } from "./state.mjs";
import { SCENELET_BARE, CLAUDE_FAST_MODEL, CLAUDE_MAIN_MODEL, runHiddenJson } from "./claude-runner.mjs";
import { loadPrompts, MAX_REPLY_LEN, splitText, splitSocialReply } from "./reply.mjs";
import { getSceneConfig, normalizeProactiveIntents, normalizeToolUsage, normalizeWorldState, applyWorldStatePatch, normalizeLifeArcs, normalizeSceneletResult, normalizeRawProactiveCandidate, normalizeScheduleCandidates, normalizeMemoryCandidates, normalizeMemoryOps, normalizeProactiveDecision, sanitizeVisibleReplyText, proactiveSentToday, lastConversationActivityMs } from "./normalize.mjs";
import { sessionProfile, roleWorldKey, ensureWorldSession, getRoleWorld, saveRoleWorlds, syncRoleWorldToSession, checkIntentDuplicateFlash, applyLifeArcOps, lifeArcPromptItems } from "./world-state.mjs";
import { saveSessions } from "./session-store.mjs";
import { buildHiddenWorldSystemPrompt, buildHiddenWorldPrompt, buildProactivePrompt, buildScheduleFinalizationPrompt, recentVisibleContext, buildMemoryCandidatePrompt, buildMemoryMergePrompt, appendVisibleHistory } from "./prompts.mjs";
import { memoryItemsText, isMemoryEnabled, shouldRunMemoryWriter, listMemoryItems, applyMemoryOps } from "./memory.mjs";
import { appendChatEvent } from "./chat-history.mjs";
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
  let raw = await runHiddenJson(prompt, {
    label: "hidden_world",
    bare: SCENELET_BARE,
    persist: true,
    sessionName: `hidden-world-${roleWorldKey(profile)}`,
    sessionId: world.sid,
    firstTurn: world.firstTurn,
    model: world.model || CLAUDE_MAIN_MODEL,
    systemPrompt: buildHiddenWorldSystemPrompt(profile),
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
  roleWorld._worldLastOutput = {
    timestamp: world.lastUsedAt,
    innerScenelet: result.innerScenelet,
    worldStatePatch: result.worldStatePatch,
    dailyShareCandidates: result.dailyShareCandidates,
    scheduleCandidates: result.scheduleCandidates,
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
    current_state: arc.current_state,
    next_useful_moment: arc.next_useful_moment,
    kind: arc.kind,
    time_start: arc.time_start,
    time_end: arc.time_end,
  })).slice(-getSceneConfig().sceneContextMaxLifeArcs) : [];
  const parts = [
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
  const memoryPrompt = (() => {
    const items = memoryItemsText(userId, { profile });
    if (!items) return "";
    const instruction = loadPrompts().memoryContextInstruction || "";
    return instruction ? `${instruction}\n\n${items}` : items;
  })();
  const prompt = buildProactivePrompt({
    userId,
    sessionName: sess.name,
    profile,
    intent,
    memoryPrompt,
    visibleContext: recentVisibleContext(sess),
    sess,
  });
  const raw = await runHiddenJson(prompt, { label: "proactive" });
  return normalizeProactiveDecision(raw);
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
  const rawScheduledAt = candidate.scheduled_at || new Date(nowMs + cfg.dailyShareDefaultScheduleOffsetMs).toISOString();
  const parsedScheduledAt = Date.parse(rawScheduledAt || "");
  const scheduledAt = Number.isFinite(parsedScheduledAt) ? rawScheduledAt : new Date(nowMs + cfg.dailyShareDefaultScheduleOffsetMs).toISOString();
  const parsedFinalScheduledAt = Date.parse(scheduledAt);
  const rawExpiresAt = candidate.expires_at || "";
  const parsedExpiresAt = Date.parse(rawExpiresAt);
  const expiresAt = Number.isFinite(parsedExpiresAt)
    ? rawExpiresAt
    : new Date(parsedFinalScheduledAt + cfg.dailyShareDefaultExpiryOffsetMs).toISOString();
  const intent = normalizeRawProactiveCandidate({
    kind: "daily_share",
    scheduled_at: scheduledAt,
    expires_at: expiresAt,
    message_intent: candidate.message_intent,
    basis: candidate.basis || "",
    cancel_if: candidate.cancel_if || cfg.dailyShareDefaultCancelIf,
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
    .slice(-cfg.scheduleRecentKindsLimit)
    .map(a => a.kind);

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
    model: CLAUDE_FAST_MODEL,
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
      reason,
    }]);
  }

  roleWorld.updatedAt = new Date().toISOString();
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
    model: CLAUDE_FAST_MODEL,
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

// replyPrefix helper - used by checkProactiveIntents and processTurn
export function replyPrefix(sessionName, ai = "cc") {
  const label = ai === "codex" ? "Codex" : "CC";
  return `[${label}] ${sessionName}`;
}
