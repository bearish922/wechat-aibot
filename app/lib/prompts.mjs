import { loadPrompts, getChatStyle, formatLocalChatReality, formatZonedTimeParts } from "./reply.mjs";
import { normalizeVisibleHistory, getSceneConfig, unansweredProactiveSummary } from "./normalize.mjs";
import { lifeArcPromptItems } from "./world-state.mjs";
import { profileTemplates } from "./state.mjs";

function buildRagContextBlock(ragContext) {
  if (!ragContext) return "";
  const cfg = loadPrompts();
  return [
    "【关于千圣自己】",
    cfg.ragContextInstruction,
    ragContext,
  ].filter(Boolean).join("\n");
}

function buildTurnBody(userBody, ragContext = "", sceneContext = "", memoryPrompt = "", sceneMemory = "") {
  const sections = [];
  const now = new Date();
  if (sceneMemory) {
    sections.push("【本轮之前的对话摘要】\n" + sceneMemory);
  }
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
  if (role === "user") {
    if (!Array.isArray(sess._userMessageLog)) sess._userMessageLog = [];
    sess._userMessageLog.push(String(text));
  }
}

function getSceneMemorySystemBlock(roleWorld) {
  const text = roleWorld?._sceneMemory || roleWorld?.sceneMemory || "";
  if (!text) return "";
  const cfg = loadPrompts();
  const intro = cfg.sceneMemorySystemBlockIntro || "【情景记忆】";
  return `${intro}\n\n${text}`;
}

function buildSceneMemorySummaryPrompt({ visibleHistory, recentScenelets, worldState, lifeArcs, memoryPrompt, profile }) {
  const cfg = loadPrompts();
  const instructions = cfg.sceneMemoryPromptInstructions || "";
  const now = new Date();
  const input = {
    profile,
    visible_history: visibleHistory,
    world_state: worldState,
    life_arcs: lifeArcs,
    memory_snapshot: memoryPrompt || "",
  };
  if (recentScenelets && recentScenelets.length) {
    input.recent_inner_scenelets = recentScenelets.map((s, i) => `[第${i + 1}条] ${s}`);
  }
  return [
    instructions,
    "",
    "当前时间：",
    JSON.stringify(currentTimeContext(now), null, 2),
    "",
    "输入：",
    JSON.stringify(input, null, 2),
  ].join("\n");
}

function buildHiddenWorldSystemPrompt(profile, sceneMemory = "") {
  const cfg = loadPrompts();
  const parts = [
    "角色 prompt：",
    profile && profileTemplates[profile] ? profileTemplates[profile] : "",
  ];
  if (sceneMemory) {
    parts.push("", sceneMemory);
  }
  parts.push(
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
    "",
    cfg.hiddenWorldChatStyle || "",
  );
  return parts.filter(Boolean).join("\n");
}

function buildHiddenWorldPrompt({ userId, sessionName, profile, userBody, lifeArcs = [], visibleContext, memoryPrompt, worldState = null, proactiveIntents = [], worldSession = null }) {
  const now = new Date();
  const cfg = loadPrompts();
  return [
    "你将收到本轮动态上下文。请按 hidden-world system prompt 的规则输出 JSON。",
    "",
    memoryPrompt ? `关于她，千圣一直记得：\n${memoryPrompt}` : "",
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

function buildProactivePrompt({ userId, sessionName, profile, intent, visibleContext, sess }) {
  const now = new Date();
  const cfg = loadPrompts();
  const instr = cfg.proactiveInstructions || "";
  return [
    instr,
    "",
    "角色 prompt：",
    profile && profileTemplates[profile] ? profileTemplates[profile] : "",
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

function buildScheduleFinalizationPrompt({
  profileSnippet,
  candidates,
  activeSchedules,
  recentKindsHint,
  visibleContext,
}) {
  const cfg = loadPrompts();
  const instr = cfg.scheduleCreatorInstructions || "";
  const sections = [
    instr,
    "",
    "角色 prompt（截取关键身份信息）：",
    profileSnippet || "",
  ];
  if (visibleContext) {
    sections.push(
      "",
      "【最近对话上下文 — 用于核对 candidate 事实】",
      "以下为角色与用户的近期对话摘要。请逐条核对 candidate 中的事实信息（时间、地点、频率、细节）是否与对话一致：",
      visibleContext,
    );
  }
  sections.push(
    "",
    "Hidden-world 提出的 schedule candidates：",
    JSON.stringify(candidates, null, 2),
    "",
    "当前活跃日程：",
    activeSchedules || "(无)",
    "",
    recentKindsHint,
  );
  return sections.filter(Boolean).join("\n");
}

export {
  buildRagContextBlock,
  buildTurnBody,
  currentTimeContext,
  recentVisibleContext,
  appendVisibleHistory,
  getSceneMemorySystemBlock,
  buildSceneMemorySummaryPrompt,
  buildHiddenWorldSystemPrompt,
  buildHiddenWorldPrompt,
  buildMemoryCandidatePrompt,
  buildMemoryMergePrompt,
  buildProactivePrompt,
  buildScheduleFinalizationPrompt,
};
