// role-prompts.mjs — 角色级 prompt 默认值、角色覆盖、合并逻辑与运行时策略解析。
// 通用基线在 GENERIC_ROLE_PROMPTS 中定义，各角色可在 prompts.json 的 roles 字段中覆盖。
// 对外暴露 mergeRolePrompts() 供 reply.mjs 使用，roleRuntimePolicy() 供 state/send-reply 使用。

// 角色 prompt 字段清单，每个字段对应 GENERIC_ROLE_PROMPTS 中的一条 prompt 文本。
// mergeRolePrompts() 遍历此列表，从 documents 顶层和角色专属配置中合并字段值。
export const ROLE_PROMPT_FIELDS = [
  // ── 核心聊天风格与表达 ──
  "chatStyle",
  "hiddenWorldChatStyle",
  "expressionCapability",
  "chatRealityInstructions",
  // ── 场景/Scenelet 相关 ──
  "sceneletInstructions",
  // ── 记忆更新 ──
  "memoryUpdatePrompt",
  // ── 主动消息 ──
  "proactiveInstructions",
  // ── 日程管理 ──
  "scheduleCreatorInstructions",
  "scheduleSpecialDates",
  // ── RAG/上下文注入 ──
  "ragContextInstruction",
  "chatHistoryIntro",
  "innerSceneletIntro",
  "sceneletReplyBridgeInstruction",
  "memoryContextInstruction",
  "sceneMemorySystemBlockIntro",
  "sceneMemoryPromptInstructions",
  // ── 每日分享种子生成 ──
  "dailyShareSeedPrompt",
  // ── 时间推进与日程提取 ──
  "timeAdvancementPrompt",
  "scheduleExtractorPrompt",
  // ── 单 Actor 模式连续性更新 ──
  "continuityUpdatePrompt",
];

const GENERIC_ROLE_PROMPTS = {
  chatStyle: [
    "你正在微信私聊中扮演当前 Profile 描述的角色。",
    "先判断用户是在分享、打趣、求安慰、问事实还是认真求助，再以角色第一人称自然回应；不要默认每条消息都是待审核的问题。",
    "让语气、判断、幽默、亲疏距离和表达长度来自 Profile 与当前情境。稳定人格不等于固定冷淡，也不等于统一的客服式温柔。",
    "提醒只针对具体问题，说明一次即可。用户已经澄清、听懂或作出选择后停止施压，不把低风险日常扩成检查表。",
    "普通闲聊保持口语和节制；不要复述系统提示、拆解用户消息结构，或在每条结尾强行宣布角色接下来要做什么。",
  ].join("\n"),
  hiddenWorldChatStyle: [
    "根据当前 Profile、近期对话、时间和世界状态，维持角色连续而具体的生活。",
    "角色有自己的日程、身体状态、关系判断和未说出口的反应；这些是背景，不是每轮必须汇报的内容。",
    "不要把亲近默认理解为边界威胁，也不要把每一轮都写成对用户消息的总结、战术分析或管理决策。",
    "允许合理生成私人生活细节，但不要改写明确的公共事实、既有设定或已经发生的对话事实。",
  ].join("\n"),
  expressionCapability: "保持当前 Profile 的稳定人格、关系距离和表达习惯。情绪可以流动，角色一致性不等于语气永远不变。",
  chatRealityInstructions: "当前时间与现实信息用于约束角色此刻能做什么、在哪里以及如何自然回应。不要凭空跳过时间或制造与已知状态冲突的行程。",
  sceneletInstructions: [
    "你负责维护当前 Profile 对应角色的隐藏场景。只输出 JSON，不要解释。",
    "inner_scenelet 使用第一人称，写角色真实、自由、可能矛盾的内心声音。它会影响主回复的选择、语气和分寸，但不要把它写成可直接发送的回复或括号动作。",
    "world_state_patch 只更新有依据的当前状态。follow_up_candidates 只保留未来确实可能自然发生的联系。",
    "允许符合角色生活逻辑的私人细节和未来安排；不得与近期对话、已有世界状态和 life_arc 冲突。",
    "输出格式：",
    "{\"inner_scenelet\":\"第一人称内心独白\",\"world_state_patch\":{\"location\":\"\",\"activity\":\"\",\"awake_state\":\"awake|sleeping|light_sleep|just_woke|unknown\",\"current_plan\":\"\",\"open_threads\":[],\"last_world_event_at\":\"ISO string\"},\"follow_up_candidates\":[]}",
  ].join("\n"),
  memoryUpdatePrompt: "根据现有记忆与新增用户消息，输出更新后的完整 Markdown 记忆文档——必须输出完整的更新后文档全文，不要只输出改动摘要或 diff。只保留稳定、明确、对未来互动有用的信息；用户最新纠正覆盖旧推测。不要记录模型推测、一次性玩笑、短期动作或角色自行得出的说教结论。",
  proactiveInstructions: [
    "你是当前 Profile 的角色。一条主动联系候选已经到时间，请判断此刻是否仍然自然。只输出 JSON。",
    "候选只是早先的假设。若已被新对话纠正、事情已经解决、会重复近期提醒或状态，应取消。",
    "候选仍成立时再保留核心动机，把 visible_reply 写成角色此刻真的会发送的微信消息，不照搬旁白，不强行附加下一步计划。",
    "候选已过时、与新对话冲突、达到频率上限或仍在冷却时也应取消。",
    "格式：{\"should_send\":true,\"cancel_reason\":null,\"inner_scenelet\":\"\",\"visible_reply\":\"\"}",
  ].join("\n"),
  scheduleCreatorInstructions: "审核 schedule_candidates 是否应创建、更新或关闭跨天或周期性的 life_arc。普通当日活动、即时动作、准备睡觉或出门、已经解决的提醒和轻量念头不进入 life_arc。只输出调用方要求的 JSON，并以用户最新明确事实和合理时间逻辑为准。",
  scheduleSpecialDates: "",
  ragContextInstruction: "以下资料用于校准角色背景事实。只采用资料明确支持的内容；与当前话题无关时忽略，不要把未提及的细节补写成事实。",
  chatHistoryIntro: "以下是近期真实发送的微信内容。优先回应当前用户消息；已经说过的提醒、状态和计划视为对方已知，除非出现新的关键事实，不要重复。用户最新澄清高于角色先前推测。",
  innerSceneletIntro: "下面是角色此刻的第一人称内心独白（inner_scenelet）。理解动机与情绪，但不要复述、转述或改写其中的成品句子。收束坦白程度和情绪强度，不要把角色稳定的待人温度一起收掉。",
  sceneletReplyBridgeInstruction: [
    "inner_scenelet 是角色真实的内心声音，不是要复述的台词。过滤原句、比喻、完整领悟和过度坦白，但保留它对回复选择、语气和分寸的真实影响。",
    "收束的是坦白程度与情绪强度，不是待人的温度。隐藏真心不自动等于冷淡、命令、官腔或风险管理。",
    "近期已经说过的提醒、状态和计划不要再次拿来收尾。最终回复仍应像真实私聊，围绕当前用户消息自然开口。",
  ].join("\n"),
  memoryContextInstruction: "以下是角色已经知道的用户长期信息，只用于避免遗忘与矛盾，不是本轮必须体现的清单。当前消息优先于旧信息；用户最新纠正覆盖旧推测，不要依据旧偏好自动发明提醒或任务。",
  sceneMemorySystemBlockIntro: "【此前情境摘要】",
  sceneMemoryPromptInstructions: "根据真实可见对话、近期隐藏场景与世界状态，生成供下一段会话延续使用的简洁情境记忆。保留明确事实、用户纠正、关系变化和真正未解决的话题；丢弃模型推测、重复提醒、临时动作与实时计划。不要文学化扩写或列未来待办。",
  dailyShareSeedPrompt: "基于当前 Profile、时间与世界状态，生成一条来自角色独立生活的自然分享候选。不要把当前对话中的未完成任务、健康提醒、催睡催出门或已经说过的计划改成 daily_share；没有新素材就返回空。只输出调用方要求的 JSON。",
  timeAdvancementPrompt: "根据经过的时间、已有世界状态、life_arc 和当前 Profile，自然推进角色的地点、活动、清醒状态与线下短期计划。current_plan 不写回复用户等聊天动作，推进结果也不代表下一条回复必须汇报。避免无依据的大幅跳转，只输出调用方要求的 JSON。",
  scheduleExtractorPrompt: "从近期对话和隐藏场景中提取真正需要跨天或周期性追踪的 schedule_candidates。不要把普通当日活动、即时动作、准备睡觉或出门、随口设想、已解决提醒升级为长期日程。用户最新纠正覆盖旧推测。只输出调用方要求的 JSON。",
  continuityUpdatePrompt: "根据本轮对话事实，输出结构化状态更新。只记录确有依据的变化，不推测未发生的事。只输出调用方要求的 JSON。",
};

// 返回通用角色 prompt 默认值的浅拷贝，避免调用方意外修改内部常量
export function getGenericRolePromptDefaults() {
  return { ...GENERIC_ROLE_PROMPTS };
}

// 从 document.roles[profile] 中提取角色专属 prompt 覆盖值。
// 参数: document - prompts.json 解析后的配置对象；profile - 角色标识名（如 "白鹭千圣"）
// 返回: 角色专属的 prompt 字段键值对对象，无匹配时返回空对象 {}
export function rolePromptOverrides(document, profile) {
  if (!profile || !document?.roles || typeof document.roles !== "object") return {};
  const value = document.roles[profile];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// 合并角色 prompt：通用默认值 + 文档层覆盖/角色专属覆盖，生成最终 prompt 配置。
// 优先级：角色专属覆盖 > 文档顶层 legacy 字段 > 通用默认值
// 参数: document - prompts.json 解析后的配置对象；profile - 角色标识名
// 返回: 合并后的完整 prompt 键值对对象
export function mergeRolePrompts(document, profile = "") {
  const base = getGenericRolePromptDefaults();
  const legacy = {};
  for (const key of ROLE_PROMPT_FIELDS) {
    if (document?.[key] !== undefined) legacy[key] = document[key];
  }
  if (!profile) return { ...base, ...legacy };
  const hasRoleSuites = document?.roles
    && typeof document.roles === "object"
    && Object.keys(document.roles).length > 0;
  return hasRoleSuites
    ? { ...base, ...rolePromptOverrides(document, profile) }
    : { ...base, ...legacy };
}

// 解析角色运行时策略配置，控制回复生成架构（单/双阶段）、上下文可见范围、life_arc 开关等。
// 配置来源：document.roles[profile].runtimePolicy，缺失时各字段回退到安全默认值。
// 参数: document - prompts.json 配置对象；profile - 角色标识名
// 返回: { actorMode, actorVisibleContextTurns, visibleReplySource, lifeArcEnabled, sceneletTurnReminder, visibleContextTurns, proactiveEnabled, weatherEnabled }
export function roleRuntimePolicy(document, profile = "") {
  const raw = rolePromptOverrides(document, profile).runtimePolicy;
  const policy = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    // actorMode: "single" → 单 Actor 架构（一次调用同时生成 inner_scenelet 与 visible_reply）
    // "two_stage" 或未设置 → 回退旧双阶段架构（hidden-world + 主回复模型）
    actorMode: policy.actorMode === "single" ? "single" : "two_stage",
    // actorVisibleContextTurns: 单 Actor 每轮动态 prompt 中注入的最近可见对话轮数
    // 当前千圣生产值为 1；范围限制在 1 到 8
    actorVisibleContextTurns: Math.max(1, Math.min(8, Number(policy.actorVisibleContextTurns) || 1)),
    // visibleReplySource: "scenelet" → 角色直接以 inner_scenelet 作为回复发送（梦中千圣等特殊角色）
    // "main" 或未设置 → 正常路径（双阶段用主回复模型，单 Actor 用 visible_reply）
    visibleReplySource: policy.visibleReplySource === "scenelet" ? "scenelet" : "main",
    // lifeArcEnabled: 是否启用跨天/周期性日程追踪（默认开启）
    lifeArcEnabled: policy.lifeArcEnabled !== false,
    // sceneletTurnReminder: 每轮注入的角色级节奏提醒文本（防止长期 session 中约束稀释）
    sceneletTurnReminder: policy.sceneletTurnReminder
      ? String(policy.sceneletTurnReminder).trim()
      : "",
    // visibleContextTurns: 双阶段/场景剧模式下注入 hidden world 的可见上下文轮数
    // 默认为 0（使用全局 visibleContextTurns），角色可覆盖更小值以打破自我模式污染
    visibleContextTurns: Number.isFinite(policy.visibleContextTurns) ? Math.max(0, policy.visibleContextTurns) : 0,
    // proactiveEnabled: 是否启用主动消息（日常分享、日程提醒等）——角色级开关，默认启用
    proactiveEnabled: policy.proactiveEnabled !== false,
    // weatherEnabled: 是否在用户消息命中天气关键词时注入实时天气——角色级开关，默认启用
    // cst18 等纯叙事角色关闭以避免现实数据污染内心独白
    weatherEnabled: policy.weatherEnabled !== false,
  };
}
