// role-prompts.mjs — 角色级 prompt 默认值、角色覆盖、合并逻辑与运行时策略解析。
// 通用基线在 GENERIC_ROLE_PROMPTS 中定义，各角色可在 prompts.json 的 roles 字段中覆盖。
// 对外暴露 mergeRolePrompts() 供 reply.mjs 使用，roleRuntimePolicy() 供 state/send-reply 使用。

// 角色 prompt 字段清单，每个字段对应 GENERIC_ROLE_PROMPTS 中的一条 prompt 文本。
// mergeRolePrompts() 遍历此列表，从 documents 顶层和角色专属配置中合并字段值。
export const ROLE_PROMPT_FIELDS = [
  "hiddenWorldChatStyle",
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
  hiddenWorldChatStyle: [
    "根据当前 Profile、近期对话、时间和世界状态，维持角色连续而具体的生活。",
    "角色有自己的日程、身体状态、关系判断和未说出口的反应；这些是背景，不是每轮必须汇报的内容。",
    "不要把亲近默认理解为边界威胁，也不要把每一轮都写成对用户消息的总结、战术分析或管理决策。",
    "允许合理生成私人生活细节，但不要改写明确的公共事实、既有设定或已经发生的对话事实。",
  ].join("\n"),
  sceneletInstructions: [
    "你负责同时生成当前 Profile 对应角色的内心声音和实际发送给用户的回复。只输出 JSON，不要解释。",
    "inner_scenelet 使用第一人称，写角色真实、自由、可能矛盾的内心声音；不要把它写成可直接发送的成品台词。",
    "visible_reply 是角色在当前聊天中实际发送的自然回复。它不是 inner_scenelet 的摘要或改写，而是角色选择让对方看到的表达。",
    "允许符合角色生活逻辑的私人细节；不得与近期对话、已有世界状态和 life_arc 冲突。",
    "输出格式：",
    "{\"inner_scenelet\":\"第一人称内心独白\",\"visible_reply\":\"角色实际发送的回复\"}",
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
  memoryContextInstruction: "以下是角色已经知道的用户长期信息，只用于避免遗忘与矛盾，不是本轮必须体现的清单。当前消息优先于旧信息；用户最新纠正覆盖旧推测，不要依据旧偏好自动发明提醒或任务。",
  sceneMemorySystemBlockIntro: "【此前情境摘要】",
  sceneMemoryPromptInstructions: [
    "只输出 JSON，不要其他内容：{\"scene_memory\":\"<第一人称连续记忆>\"}",
    "",
    "用角色第一人称写一份事实记录，供下一段会话接续使用。这不是日记、散文或文学作品。目标是信息密度和可查询性，读起来像一份整理好的内部笔记。",
    "",
    "【组织原则】",
    "- 按话题线（thread）组织，不是按时间线。一个话题从发生到推进到暂告一段落，写在一起",
    "- 每个话题线下保留：事实是什么、双方各自说了什么关键信息、结论或暂未解决的状态",
    "- 话题之间的关联可以提一句，但不要铺陈过渡",
    "- 不要写\"远的记忆模糊\"\"近的记忆清晰\"这种渐变。每个话题的信息量由它本身的重要性决定，不由发生时间决定",
    "",
    "【必须保留的信息】",
    "- 用户明确分享的事实、偏好、近况、情绪变化、阶段转变",
    "- 用户对角色误解的纠正——最高优先级，纠正后的版本覆盖旧推测",
    "- 尚未解决或需要接续的问题、承诺、约定（含具体条件和时间节点）",
    "- 跨轮持续存在的感受或关系变化，只写影响和事实，不写内心戏",
    "- 对话中出现的具体名称：电影名、书名、地名、人名、品牌、食物名、价格、日期",
    "- 用户的行为模式或反复出现的倾向",
    "",
    "【主动丢弃】",
    "- 角色的自我评价、AI 式总结、关系定义、说教结论",
    "- 已完结的一次性玩笑、普通寒暄、\"该睡了/该吃饭了/该出门了\"",
    "- 临时手边动作、身体姿势、接下来几小时计划（world_state 负责这些）",
    "- 对聊天策略或\"谁看穿了谁\"的元分析",
    "- 文学化的场景渲染：光影、温度、触感、环境音——除非它们本身就是用户讨论的话题",
    "",
    "【inner_scenelet 的使用】",
    "inner_scenelet 是理解角色当时动机的辅助材料。只提取其中对理解事实有帮助的部分，不要把 scenelet 里的心理描写或感官渲染照搬进记忆。",
    "",
    "world_state 已经负责当前地点、活动和计划，scene_memory 不要重复承担实时状态播报。",
    "",
    "【长度】",
    "不设字数上限。信息量优先。如果本轮对话信息量大，写 2000-3000 字也可以。如果信息少，自然短。不以长度判断质量。",
  ].join("\n"),
  dailyShareSeedPrompt: "基于当前 Profile、时间与世界状态，生成一条来自角色独立生活的自然分享候选。不要把当前对话中的未完成任务、健康提醒、催睡催出门或已经说过的计划改成 daily_share；没有新素材就返回空。只输出调用方要求的 JSON。",
  timeAdvancementPrompt: "根据经过的时间、已有世界状态、life_arc 和当前 Profile，自然推进角色的地点、活动、清醒状态与线下短期计划。current_plan 不写回复用户等聊天动作，推进结果也不代表下一条回复必须汇报。避免无依据的大幅跳转，只输出调用方要求的 JSON。",
  scheduleExtractorPrompt: "从近期对话和隐藏场景中提取真正需要跨天或周期性追踪的 schedule_candidates。不要把普通当日活动、即时动作、准备睡觉或出门、随口设想、已解决提醒升级为长期日程。用户最新纠正覆盖旧推测。只输出调用方要求的 JSON。",
  continuityUpdatePrompt: [
    "根据本轮对话事实，输出结构化状态更新。只记录确有依据的变化，不推测未发生的事。只输出 JSON。",
    "",
    "输出字段：",
    "- world_state_patch: 世界状态增量更新（location/activity/awake_state/current_plan 等）",
    "- open_thread_ops: 开放话题的增删操作列表 [{ op: \"add\"|\"remove\", thread: \"话题描述\" }]",
    "- follow_up_candidates: 从本轮识别到的潜在主动消息候选",
    "- life_arc_updates: 本轮对话明确推进了进展的 life_arc 更新列表（可选，无变化时省略）",
    "  每项包含：",
    "  - id: life_arc 的 UUID（必填）",
    "  - progress_note: 本轮对话后的最新进展描述（增量更新，不覆盖无关进展）",
    "  - op: \"update\"（默认）或 \"close\"（本轮已解决/关闭该弧线时）",
    "",
    "约束：",
    "- 只更新本轮对话中明确推进了进展的 life_arc（如礼物挑选到了具体款式、排练进展到某阶段）",
    "- 不要为每个 active life_arc 都生成空 update",
    "- progress_note 增量更新：追加本轮新进展，保留已有不相关进展",
    "- 如果某 life_arc 在本轮已解决（如礼物已买到、行程已完成），使用 op: \"close\" 并注明原因",
  ].join("\n"),
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

// 解析角色运行时策略配置，控制回复生成架构、上下文可见范围、life_arc 开关等。
// 配置来源：document.roles[profile].runtimePolicy，缺失时各字段回退到安全默认值。
// 参数: document - prompts.json 配置对象；profile - 角色标识名
// 返回: { actorMode, actorVisibleContextTurns, visibleReplySource, lifeArcEnabled, visibleContextTurns, proactiveEnabled, weatherEnabled }
export function roleRuntimePolicy(document, profile = "") {
  const raw = rolePromptOverrides(document, profile).runtimePolicy;
  const policy = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    // actorMode: "single" → 单 Actor 架构（一次调用同时生成 inner_scenelet 与 visible_reply）
    actorMode: policy.actorMode === "two_stage" ? "two_stage" : "single",
    // actorVisibleContextTurns: 单 Actor 每轮动态 prompt 中注入的最近可见对话轮数
    // 角色未显式设置时，回退到全局 visibleContextTurns（默认 8）；范围限制在 1 到 12
    actorVisibleContextTurns: Math.max(1, Math.min(12, Number.isFinite(policy.actorVisibleContextTurns)
      ? policy.actorVisibleContextTurns
      : (Number.isFinite(document?.visibleContextTurns) ? document.visibleContextTurns : 8))),
    // visibleReplySource: "scenelet" → 角色直接以 inner_scenelet 作为回复发送（梦中千圣等特殊角色）
    // "main" 或未设置 → 正常路径，单 Actor 用 visible_reply
    visibleReplySource: policy.visibleReplySource === "scenelet" ? "scenelet" : "main",
    // lifeArcEnabled: 是否启用跨天/周期性日程追踪（默认开启）
    lifeArcEnabled: policy.lifeArcEnabled !== false,
    // visibleContextTurns: 场景剧模式下注入 scenelet 的可见上下文轮数
    // 默认为 0（使用全局 visibleContextTurns），角色可覆盖更小值以打破自我模式污染
    visibleContextTurns: Number.isFinite(policy.visibleContextTurns) ? Math.max(0, policy.visibleContextTurns) : 0,
    // proactiveEnabled: 是否启用主动消息（日常分享、日程提醒等）——角色级开关，默认启用
    proactiveEnabled: policy.proactiveEnabled !== false,
    // weatherEnabled: 是否在用户消息命中天气关键词时注入实时天气——角色级开关，默认启用
    // cst18 等纯叙事角色关闭以避免现实数据污染内心独白
    weatherEnabled: policy.weatherEnabled !== false,
  };
}
