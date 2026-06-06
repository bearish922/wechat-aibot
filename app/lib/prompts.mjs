import { loadPrompts, getChatStyle, formatLocalChatReality, formatZonedTimeParts } from "./reply.mjs";
import { normalizeVisibleHistory, getSceneConfig, unansweredProactiveSummary } from "./normalize.mjs";
import { lifeArcPromptItems } from "./world-state.mjs";
import { profileTemplates } from "./state.mjs";

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
      note: "角色侧时间；东京时间",
    },
  };
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

function buildHiddenWorldSystemPrompt(profile) {
  const cfg = loadPrompts();
  return [
    "角色 prompt：",
    profile && profileTemplates[profile] ? profileTemplates[profile] : "",
    "",
    "【角色世界特殊日期】",
    cfg.scheduleSpecialDates || "",
    "",
    "【月度行事与季节事件】",
    cfg.seasonalMonthlyNotes
      ? Object.entries(cfg.seasonalMonthlyNotes).map(([m, lines]) => `[${m}月] ${Array.isArray(lines) ? lines.join("；") : lines}`).join("\n")
      : "",
    "",
    cfg.sceneletInstructions,
  ].filter(Boolean).join("\n");
}

function buildHiddenWorldPrompt({ userId, sessionName, profile, userBody, lifeArcs = [], visibleContext, memoryPrompt, worldState = null, proactiveIntents = [], worldSession = null }) {
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
      active_life_arcs: lifeArcs,
      pending_proactive_intents: proactiveIntents,
      visible_context_instruction: cfg.chatHistoryIntro,
      recent_visible_context: visibleContext,
      user_message: userBody,
    }, null, 2),
  ].filter(Boolean).join("\n");
}

function buildMemoryCandidatePrompt(userBody, userId, profile) {
  const cfg = loadPrompts();
  const instr = cfg.memoryCandidateInstructions || "";
  return [
    instr,
    "",
    "输入：",
    JSON.stringify({ userId, profile, user_message: userBody }, null, 2),
  ].join("\n");
}

function buildMemoryMergePrompt({ userBody, userId, profile, candidates, existingItems }) {
  const cfg = loadPrompts();
  const instr = cfg.memoryWriterInstructions || "";
  return [
    instr,
    "",
    "输入：",
    JSON.stringify({
      userId,
      profile,
      user_message: userBody,
      candidates,
      existing_memory_items: existingItems,
    }, null, 2),
  ].join("\n");
}

function buildProactivePrompt({ userId, sessionName, profile, intent, memoryPrompt, visibleContext, sess }) {
  const now = new Date();
  const cfg = loadPrompts();
  const instr = cfg.proactiveInstructions || "";
  return [
    instr,
    "",
    "角色 prompt：",
    profile && profileTemplates[profile] ? profileTemplates[profile] : "",
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
        unanswered_proactive_since_last_user: unansweredProactiveSummary(sess),
      },
      visible_context_instruction: cfg.chatHistoryIntro,
      recent_visible_context: visibleContext,
      active_life_arcs: lifeArcPromptItems(sess),
      candidate_intent: intent,
    }, null, 2),
  ].filter(Boolean).join("\n");
}

export {
  buildRagContextBlock,
  buildTurnBody,
  currentTimeContext,
  recentVisibleContext,
  appendVisibleHistory,
  buildHiddenWorldSystemPrompt,
  buildHiddenWorldPrompt,
  buildMemoryCandidatePrompt,
  buildMemoryMergePrompt,
  buildProactivePrompt,
};
