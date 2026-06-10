import { loadPrompts, getChatStyle, formatLocalChatReality, formatZonedTimeParts, getWeatherReality } from "./reply.mjs";
import { normalizeVisibleHistory, getSceneConfig } from "./normalize.mjs";
import { lifeArcPromptItems } from "./world-state.mjs";
import { profileTemplates } from "./state.mjs";

// buildRagContextBlock —— 构建 RAG（检索增强生成）上下文块
// 将关于角色自身的事实知识（如"关于千圣自己"）组装为系统可注入的上下文字符串。
// 参数：
//   ragContext - RAG 检索到的上下文文本，如果为空则返回空字符串
// 返回：格式化后的 RAG 上下文字符串（包含标题、指令和正文）
function buildRagContextBlock(ragContext) {
  // 如果没有 RAG 上下文，直接返回空字符串
  if (!ragContext) return "";
  // 加载提示词配置
  const cfg = loadPrompts();
  return [
    // 固定标题
    "【关于角色自己】",
    // 来自配置的 RAG 上下文使用说明
    cfg.ragContextInstruction,
    // 实际的 RAG 检索内容
    ragContext,
  ].filter(Boolean).join("\n");
}

// buildVisibleHistoryBlock —— 格式化可见对话历史为文本块
// 参数：history - recentVisibleContext 返回的数组 [{ role, time, kind, text }]
// 返回：带标签的文本块字符串；空数组返回空字符串
function buildVisibleHistoryBlock(history) {
  if (!history || !history.length) return "";
  const lines = history.map(item => {
    const role = item.role === "user" ? "用户" : item.role === "assistant" ? "AI" : item.role;
    const time = item.time ? item.time.slice(11, 16) : "";
    return `[${role}]${time ? " " + time : ""} - ${item.text}`;
  });
  return "【近期对话】\n" + lines.join("\n");
}

// buildTurnBody —— 组装单轮对话的消息体
// 将情景记忆、可见历史、场景上下文、RAG 上下文、聊天风格、时间标签与用户消息按顺序拼接，
// 用 "---" 分隔各段，形成发给 AI 的完整 prompt 消息体。
// 参数：
//   userBody       - 用户的原始消息文本
//   ragContext     - RAG 检索上下文（可选）
//   sceneContext   - 场景上下文（可选）
//   visibleHistory - recentVisibleContext 返回的数组（可选）
//   sceneMemory    - 情景记忆/对话摘要文本（可选，仅 reset 后首轮注入）
// 返回：拼接好的多段落 prompt 字符串，各段以 "\n\n---\n\n" 分隔
async function buildTurnBody(userBody, ragContext = "", sceneContext = "", visibleHistory = [], sceneMemory = "") {
  // 存储各段内容的数组
  const sections = [];
  const now = new Date();
  // 情景记忆（reset 后首轮注入，之后不再出现）
  if (sceneMemory) {
    sections.push("【本轮之前的对话摘要】\n" + sceneMemory);
  }
  // 可见对话历史
  const historyBlock = buildVisibleHistoryBlock(visibleHistory);
  if (historyBlock) {
    sections.push(historyBlock);
  }
  // 场景上下文
  if (sceneContext) {
    sections.push(sceneContext);
  }
  // RAG 上下文块
  if (ragContext) {
    sections.push(buildRagContextBlock(ragContext));
  }
  // 聊天风格指令
  sections.push(getChatStyle());
  // 本地时间现实描述（日期、星期、节日等）
  sections.push(formatLocalChatReality(now));
  // 实时天气（失败时静默降级为空字符串）
  const weather = await getWeatherReality();
  if (weather) sections.push(weather);
  // 构建双时区时间标签（北京时间 + 东京时间）
  const beijing = formatZonedTimeParts(now, "Asia/Shanghai");
  const tokyo = formatZonedTimeParts(now, "Asia/Tokyo");
  const timeTag = `${beijing.stamp} ${beijing.shortWeekday}${beijing.period}（北京时间；角色侧东京时间 ${tokyo.stamp} ${tokyo.shortWeekday}${tokyo.period}）`;
  // 最后拼接用户消息（带时间标签）
  sections.push([`【用户消息】- ${timeTag}`, userBody].join("\n"));
  // 所有段落用分隔符连接
  return sections.join("\n\n---\n\n");
}

// currentTimeContext —— 生成当前时间上下文对象
// 返回包含 ISO 时间戳、北京时间（用户侧）和东京时间（角色侧）的结构化时间对象，
// 供 hidden-world prompt 等场景使用，让 AI 感知双时区的时间信息。
// 参数：
//   date - Date 对象，默认为当前时间
// 返回：{ iso, beijing: { local, weekday, period, timezone, note }, tokyo: { ... } }
function currentTimeContext(date = new Date()) {
  // 格式化北京时间各部分
  const beijing = formatZonedTimeParts(date, "Asia/Shanghai");
  // 格式化东京时间各部分
  const tokyo = formatZonedTimeParts(date, "Asia/Tokyo");
  return {
    // ISO 8601 格式的时间戳
    iso: date.toISOString(),
    beijing: {
      // 北京本地时间字符串
      local: beijing.stamp,
      // 星期简称
      weekday: beijing.shortWeekday,
      // 早/中/晚时段
      period: beijing.period,
      // 时区标识
      timezone: "Asia/Shanghai",
      // 说明：用户所在时区
      note: "用户侧时间，北京时间",
    },
    tokyo: {
      // 东京本地时间字符串
      local: tokyo.stamp,
      // 星期简称
      weekday: tokyo.shortWeekday,
      // 早/中/晚时段
      period: tokyo.period,
      // 时区标识
      timezone: "Asia/Tokyo",
      // 说明：角色所在时区
      note: "角色侧时间；东京时间",
    },
  };
}

// recentVisibleContext —— 提取最近的可见对话历史
// 从会话的可见历史中截取最近 N 轮对话（assistant 消息计 1 轮，含 proactive），
// 并格式化为精简的 { role, time, kind, text } 数组，供 prompt 上下文使用。
// 参数：
//   sess - 会话对象，包含 _visibleHistory 数组
// 返回：精简后的最近对话历史数组
function recentVisibleContext(sess) {
  return normalizeVisibleHistory(sess?._visibleHistory)
    .map(item => ({
      role: item.role,
      time: item.timestamp || "",
      kind: item.kind || "chat",
      text: item.text,
    }));
}

// appendVisibleHistory —— 向会话的可见历史中追加一条消息
// 将新消息追加到 sess._visibleHistory 数组末尾并做规范化处理。
// 如果是用户消息，同时记录到 _userMessageLog 日志中。
// 参数：
//   sess      - 会话对象
//   role      - 消息角色（"user" 或 "assistant"）
//   text      - 消息文本
//   kind      - 消息类型，默认 "chat"
//   timestamp - 时间戳，默认当前 ISO 时间
// 无返回值（直接修改 sess 对象）
function appendVisibleHistory(sess, role, text, kind = "chat", timestamp = new Date().toISOString()) {
  // 如果会话不存在或文本为空则跳过
  if (!sess || !text?.trim()) return;
  // 将新消息追加到历史数组并规范化
  sess._visibleHistory = normalizeVisibleHistory([
    ...(sess._visibleHistory || []),
    { role, text: String(text), timestamp, kind },
  ]);
  // 用户消息额外写入消息日志，供后续分析使用
  if (role === "user") {
    if (!Array.isArray(sess._userMessageLog)) sess._userMessageLog = [];
    sess._userMessageLog.push(String(text));
  }
}

// getSceneMemorySystemBlock —— 获取情景记忆系统提示块
// 从角色世界对象中提取情景记忆文本，并计算记忆的新鲜度（生成于多久前），
// 添加时效性提醒，形成完整的情景记忆 system prompt 片段。
// 参数：
//   roleWorld - 角色世界对象，可能包含 _sceneMemory / sceneMemory / updatedAt 等字段
// 返回：格式化的情景记忆字符串（含标题、时效提示和正文）；无记忆时返回空字符串
function getSceneMemorySystemBlock(roleWorld) {
  // 提取情景记忆文本
  const text = roleWorld?._sceneMemory || roleWorld?.sceneMemory || "";
  if (!text) return "";
  // 加载提示词配置
  const cfg = loadPrompts();
  // 获取章节引入语
  const intro = cfg.sceneMemorySystemBlockIntro || "【情景记忆】";
  // 获取记忆的生成时间
  const generatedAt = roleWorld?._sceneMemoryAt || roleWorld?.updatedAt || "";
  let stalenessNote = "";
  if (generatedAt) {
    // 计算距今的毫秒数
    const deltaMs = Date.now() - new Date(generatedAt).getTime();
    if (deltaMs > 0) {
      // 转换为分钟
      const deltaMin = Math.round(deltaMs / 60000);
      // 根据时间跨度生成人性化描述（分钟/小时/天）
      const deltaStr = deltaMin < 60 ? `${deltaMin} 分钟前` : deltaMin < 1440 ? `约 ${Math.round(deltaMin / 60)} 小时前` : `约 ${Math.round(deltaMin / 1440)} 天前`;
      // 提醒 AI 此记忆可能已过时，以最近的 visible_context 为准
      stalenessNote = `（此记忆生成于 ${deltaStr}，仅供了解背景；近期对话中可能有更新信息，以当前 visible_context 为准）`;
    }
  }
  // 拼接标题、时效提示和正文
  return `${intro}\n${stalenessNote}\n\n${text}`;
}

// buildSceneMemorySummaryPrompt —— 构建情景记忆摘要生成的 prompt
// 将对话历史、世界状态、生命弧线等信息打包为 JSON 输入，
// 结合配置中的指令模板，生成发给 AI 的情景记忆摘要请求 prompt。
// 参数（解构自对象）：
//   chatHistory     - 本次 reset 周期内的对话历史（从 DB 加载，最多 40 轮）
//   recentScenelets - 最近的内部 scenelet（内心独白/心理状态片段）
//   worldState      - 当前世界状态
//   lifeArcs        - 活跃的生命弧线
//   profile          - 角色标识（如 "chisato"）
// 返回：完整的场景记忆摘要生成 prompt 字符串
function buildSceneMemorySummaryPrompt({ chatHistory, recentScenelets, worldState, lifeArcs, profile }) {
  // 加载提示词配置
  const cfg = loadPrompts();
  // 获取情景记忆摘要的指令模板
  const instructions = cfg.sceneMemoryPromptInstructions || "";
  const now = new Date();
  // 构建输入数据结构
  const input = {
    profile,
    visible_history: chatHistory,
    world_state: worldState,
    life_arcs: lifeArcs,
  };
  // 如有最近的内部 scenelet，按编号添加到输入中
  if (recentScenelets && recentScenelets.length) {
    input.recent_inner_scenelets = recentScenelets.map((s, i) => `[第${i + 1}条] ${s}`);
  }
  // 拼接指令、当前时间和 JSON 格式的输入数据
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

// buildHiddenWorldSystemPrompt —— 构建 hidden-world 的 system prompt
// 将角色人设模板、情景记忆、长期记忆、特殊日期、月度行事、scenelet 指令和聊天风格
// 组装为 hidden-world 角色（内心世界 AI）的 system prompt。
// 参数：
//   profile      - 角色标识（如 "chisato"），用于查找对应的人设模板
//   sceneMemory  - 情景记忆文本（可选）
//   memoryPrompt - 长期记忆提示词（可选），以"关于沃沃"章节呈现
// 返回：完整的 hidden-world system prompt 字符串
function buildHiddenWorldSystemPrompt(profile, sceneMemory = "", memoryPrompt = "") {
  // 加载提示词配置
  const cfg = loadPrompts();
  // 第一部分：角色人设 prompt
  const parts = [
    "角色 prompt：",
    profile && profileTemplates[profile] ? profileTemplates[profile] : "",
  ];
  // 第二部分：情景记忆（如有）
  if (sceneMemory) {
    parts.push("", sceneMemory);
  }
  // 第三部分：长期记忆（如有），以"关于沃沃"为章节标题
  if (memoryPrompt) {
    parts.push("", "【关于沃沃 — 长期记忆】", memoryPrompt);
  }
  // 后续部分：特殊日期、月度行事、scenelet 指令和聊天风格
  parts.push(
    "",
    "【角色世界特殊日期】",
    cfg.scheduleSpecialDates || "",
    "",
    "【月度行事与季节事件】",
    // 如果配置中有季节性月度备注，按月份逐条展开
    cfg.seasonalMonthlyNotes
      ? Object.entries(cfg.seasonalMonthlyNotes).map(([m, lines]) => `[${m}月] ${Array.isArray(lines) ? lines.join("；") : lines}`).join("\n")
      : "",
    "",
    // scenelet（内心独白）生成指令
    cfg.sceneletInstructions,
    "",
    // hidden-world 专用的聊天风格
    cfg.hiddenWorldChatStyle || "",
  );
  // 过滤掉空字符串后拼接
  return parts.filter(Boolean).join("\n");
}

// buildHiddenWorldPrompt —— 构建 hidden-world 单轮调用的用户消息 prompt
// 将当前时间的上下文、会话元信息、世界状态、活跃生命弧线、待处理主动意图、
// 最近可见对话上下文和用户消息打包为 JSON，供 hidden-world AI 进行内心活动推理。
// 参数（解构自对象）：
//   userId          - 用户 ID
//   sessionName     - 会话名称
//   profile         - 角色标识
//   userBody        - 用户的原始消息文本
//   lifeArcs        - 活跃的生命弧线列表（默认空数组）
//   visibleContext  - 最近的可见对话上下文
//   memoryPrompt    - 长期记忆提示词
//   worldState      - 当前世界状态（默认 null）
//   proactiveIntents - 待处理的主动意图列表（默认空数组）
//   worldSession    - hidden-world 自身的会话信息（默认 null）
// 返回：完整的 hidden-world 用户消息 prompt 字符串
async function buildHiddenWorldPrompt({ userId, sessionName, profile, userBody, lifeArcs = [], visibleContext, memoryPrompt, worldState = null, proactiveIntents = [], worldSession = null }) {
  const now = new Date();
  // 加载提示词配置
  const cfg = loadPrompts();
  // 实时天气（失败时静默降级为空）
  const weather = await getWeatherReality();
  return [
    // 提示语：要求按 hidden-world system prompt 规则输出 JSON
    "你将收到本轮动态上下文。请按 hidden-world system prompt 的规则输出 JSON。",
    "",
    "当前时间：",
    JSON.stringify(currentTimeContext(now), null, 2),
    ...(weather ? ["", weather] : []),
    "",
    "输入：",
    // 核心输入数据，以 JSON 格式提供
    JSON.stringify({
      userId,
      sessionName,
      profile,
      // hidden-world 自身会话摘要
      hidden_world_session: worldSession ? {
        sid: worldSession.sid,
        firstTurn: worldSession.firstTurn,
        startedAt: worldSession.startedAt,
        lastUsedAt: worldSession.lastUsedAt,
      } : null,
      world_state: worldState,
      // 活跃的生命弧线
      active_life_arcs: lifeArcs,
      // 待处理的主动意图
      pending_proactive_intents: proactiveIntents,
      // 可见上下文使用说明
      visible_context_instruction: cfg.chatHistoryIntro,
      // 最近的可见对话
      recent_visible_context: visibleContext,
      // 用户的当前消息
      user_message: userBody,
    }, null, 2),
  ].filter(Boolean).join("\n");
}

// buildProactivePrompt —— 构建主动消息决策 prompt
// 当 hidden-world 产生了一个候选主动意图时，用此 prompt 交给 AI 判断是否应该发送主动消息。
// prompt 包含角色人设、系统可观测状态（会话是否忙碌、排队轮数、最后活动时间等）、
// 最近对话上下文、活跃生命弧线和候选意图的详细信息。
// 参数（解构自对象）：
//   userId        - 用户 ID
//   sessionName   - 会话名称
//   profile       - 角色标识
//   intent        - 候选的主动意图对象（含 kind、scheduledAt、expiresAt 等）
//   visibleContext - 最近的可见对话上下文
//   sess          - 会话对象，用于提取系统可观测状态
// 返回：主动消息决策的 prompt 字符串
function buildProactivePrompt({ userId, sessionName, profile, intent, visibleContext, sess }) {
  const now = new Date();
  // 加载提示词配置
  const cfg = loadPrompts();
  // 获取主动消息的决策指令模板
  const instr = cfg.proactiveInstructions || "";
  return [
    instr,
    "",
    // 角色人设 prompt
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
      // 系统可观测状态：帮助 AI 判断当前是否适合发送主动消息
      system_observables: {
        // 会话是否正在处理消息
        session_busy: Boolean(sess?.busy),
        // 队列中的待处理轮数
        queued_turns: Number(sess?.queue?.length || 0),
        // 最后一次用户消息时间
        last_user_at: sess?._lastUserAt || null,
        // 最后一次助手回复时间
        last_assistant_at: sess?._lastAssistantAt || null,
        // 最后一次主动消息时间
        last_proactive_at: sess?._lastProactiveAt || null,
      },
      // 可见上下文使用说明
      visible_context_instruction: cfg.chatHistoryIntro,
      // 最近的可见对话
      recent_visible_context: visibleContext,
      // 活跃的生命弧线
      active_life_arcs: lifeArcPromptItems(sess),
      // 候选主动意图的详细信息
      candidate_intent: {
        kind: intent.kind,
        scheduled_at: intent.scheduledAt,
        expires_at: intent.expiresAt,
        message_intent: intent.messageIntent,
        basis: intent.basis,
        cancel_if: intent.cancelIf,
      },
    }, null, 2),
  ].filter(Boolean).join("\n");
}

// buildScheduleFinalizationPrompt —— 构建日程最终确认 prompt
// hidden-world 生成候选日程后，由本函数构建 prompt 交给日程专用 AI 进行最终审核。
// prompt 包含角色身份摘要、最近对话上下文（用于事实核对）、候选日程列表和当前活跃日程，
// 确保新日程不与已有日程冲突且基于真实对话内容。
// 参数（解构自对象）：
//   candidates       - hidden-world 提出的候选日程列表
//   activeSchedules  - 当前已激活的日程列表
//   recentKindsHint  - 最近日程类型的提示文本
//   visibleContext   - 最近的可见对话上下文（用于事实核对，可选）
// 返回：日程最终确认的 prompt 字符串
function buildScheduleFinalizationPrompt({
  candidates,
  activeSchedules,
  recentKindsHint,
  visibleContext,
}) {
  // 加载提示词配置
  const cfg = loadPrompts();
  // 获取日程创建/确认的指令模板
  const instr = cfg.scheduleCreatorInstructions || "";
  const sections = [
    instr,
  ];
  // 如果有最近对话上下文，加入用于逐条核对候选日程中的事实
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
    // hidden-world 提出的候选日程（JSON 格式）
    "Hidden-world 提出的 schedule candidates：",
    JSON.stringify(candidates, null, 2),
    "",
    // 当前已有日程，防止冲突
    "当前活跃日程：",
    activeSchedules || "(无)",
    "",
    // 最近日程类型的提示
    recentKindsHint,
  );
  // 过滤空字符串后拼接
  return sections.filter(Boolean).join("\n");
}

export {
  buildRagContextBlock,
  buildVisibleHistoryBlock,
  buildTurnBody,
  currentTimeContext,
  recentVisibleContext,
  appendVisibleHistory,
  getSceneMemorySystemBlock,
  buildSceneMemorySummaryPrompt,
  buildHiddenWorldSystemPrompt,
  buildHiddenWorldPrompt,
  buildProactivePrompt,
  buildScheduleFinalizationPrompt,
};
