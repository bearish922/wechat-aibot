import { loadPrompts, expressionCapabilityPrompt, getChatStyle, formatLocalChatReality, formatZonedTimeParts } from "./reply.mjs";
import { normalizeSceneState, normalizeVisibleHistory, getSceneConfig, unansweredProactiveSummary, proactiveSentToday } from "./normalize.mjs";
import { lifeArcPromptItems } from "./world-state.mjs";
import { profileTemplates } from "./state.mjs";
const SEASONAL_MONTHLY_NOTES = {
  1: ["新年氛围，初詣、年贺状、お年玉", "成人の日（1月第2月曜），各地成人式", "寒冷严冬，北部有雪，东京偶有积雪"],
  2: ["节分（2/3前后），豆まき、恵方巻", "バレンタインデー（2/14），日本女生送义理/本命チョコ", "受験シーズン，大学入学共通テスト后期", "札幌雪まつり（2月上旬）"],
  3: ["雛祭り（3/3），桃の節句，女孩节日", "ホワイトデー（3/14），情人节回礼", "春分の日/お彼岸，扫墓祭祖", "毕业式季节（3月中下旬），樱花初绽预告", "春假开始（3月下旬～4月初）"],
  4: ["樱花季（3月下旬～4月中旬），花见名所热闹", "入学式/入社式（4月初），新学期开始，社会人入职", "灌仏会/花まつり（4/8）", "新年度，生活节奏变化期"],
  5: ["黄金周（4/29～5/5前后），大型连休，旅游出行高峰", "こどもの日/端午の節句（5/5），挂鲤鱼旗", "新绿季节，气候宜人，户外活动增多", "神田祭（5月中旬，隔年大祭），三社祭（5月第3周末）"],
  6: ["梅雨入り（6月上旬～中旬），闷热多雨，出行不便", "夏越の大祓（6/30），茅の輪くぐり，半年晦日", "紫阳花（あじさい）盛开，镰仓/箱根赏花人流多"],
  7: ["梅雨明け（7月中旬前后），正式入夏", "七夕（7/7），各地七夕祭り，短冊に願い事", "京都祇園祭（7月整月，山鉾巡行17日），日本三大祭", "天神祭（7/24-25），大阪天満宮，船渡御と奉納花火", "暑假开始（7月下旬～8月末），学生出游增多", "花火大会季开始，各地周末均有"],
  8: ["盛夏酷暑，台风季高峰期", "お盆（8/13-15），帰省ラッシュ，先祖供養，盆踊り", "青森ねぶた祭（8/2-7），秋田竿燈（8/3-6），仙台七夕（8/6-8）", "阿波踊り（8/12-15），よさこい祭り（8/9-12）", "花火大会各地持续，夏休みUターンラッシュ"],
  9: ["残暑持续，台风季尾声", "シルバーウィーク（敬老の日+秋分の日连休，约5连休）", "中秋の名月/十五夜（9月中旬～10月上旬），月見団子", "运动会季节（9～10月），体育の日改称スポーツの日"],
  10: ["秋季红叶季开始，行楽の秋", "スポーツの日（10月第2月曜），三连休", "ハロウィン（10/31），渋谷等地仮装イベント", "大学学園祭季节（10～11月），各大学文化祭/学園祭集中"],
  11: ["红叶季高峰，紅葉狩り", "文化の日（11/3）", "七五三（11/15），3岁5岁7岁儿童参拜神社", "勤労感謝の日（11/23），三连休", "酉の市（11月酉の日），熊手等缘起物"],
  12: ["忘年会季节（12月），飲み会增多", "クリスマス（12/24-25），日本定番KFC+ケーキ", "年末大掃除/煤払い", "大晦日（12/31），年越しそば，除夜の鐘（108回）", "冬季休業/寒假（12月下旬～1月中旬），帰省/旅行"],
};

function buildStableStylePrompt() {
  return expressionCapabilityPrompt();
}

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
  sections.push(CURRENT_SITE_AND_SEARCH_GUARD);
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
      note: "角色侧时间；千圣所处时间以东京时间为准",
    },
  };
}

function nthMonday(year, month, n) {
  const first = new Date(year, month - 1, 1);
  const dayOfWeek = first.getDay();
  const firstMonday = 1 + ((8 - dayOfWeek) % 7);
  return new Date(year, month - 1, firstMonday + (n - 1) * 7);
}

function vernalEquinoxDay(year) {
  if (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) return 20;
  return (year >= 2025 && year <= 2028) ? 20 : 20;
}

function autumnalEquinoxDay(year) {
  return (year >= 2024 && year <= 2028) ? 22 : 23;
}

function japaneseHolidaysInRange(year, month, day, rangeDays = 14) {
  const ref = new Date(year, month - 1, day);
  const refTs = ref.getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  const fixed = [
    [1, 1, "元日"], [2, 11, "建国記念の日"], [2, 23, "天皇誕生日"],
    [4, 29, "昭和の日"], [5, 3, "憲法記念日"], [5, 4, "みどりの日"],
    [5, 5, "こどもの日"], [8, 11, "山の日"],
    [11, 3, "文化の日"], [11, 23, "勤労感謝の日"],
  ];

  const floating = [
    [1, 2, 1, "成人の日"],
    [7, 3, 1, "海の日"],
    [9, 3, 1, "敬老の日"],
    [10, 2, 1, "スポーツの日"],
  ];

  const results = [];

  for (const [m, d, name] of fixed) {
    const dt = new Date(year, m - 1, d);
    if (Math.abs(dt.getTime() - refTs) <= rangeDays * dayMs) {
      results.push({ date: `${m}月${d}日`, name, ts: dt.getTime() });
    }
  }

  for (const [m, weekOfMonth, dayOfWeek, name] of floating) {
    const dt = nthMonday(year, m, weekOfMonth);
    if (Math.abs(dt.getTime() - refTs) <= rangeDays * dayMs) {
      results.push({ date: `${m}月${dt.getDate()}日`, name, ts: dt.getTime() });
    }
  }

  const veDay = vernalEquinoxDay(year);
  const veDate = new Date(year, 2, veDay);
  if (Math.abs(veDate.getTime() - refTs) <= rangeDays * dayMs) {
    results.push({ date: `3月${veDay}日`, name: "春分の日", ts: veDate.getTime() });
  }

  const aeDay = autumnalEquinoxDay(year);
  const aeDate = new Date(year, 8, aeDay);
  if (Math.abs(aeDate.getTime() - refTs) <= rangeDays * dayMs) {
    results.push({ date: `9月${aeDay}日`, name: "秋分の日", ts: aeDate.getTime() });
  }

  results.sort((a, b) => a.ts - b.ts);
  return results;
}

function buildScheduleStaticContext(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const cfg = loadPrompts();

  // Semester
  const md = month * 100 + day;
  let semester;
  if (md >= 401 && md < 721) semester = "前期（4月～7月下旬），通常授课中";
  else if (md >= 721 && md < 921) semester = "夏季休業中（暑假，7月下旬～9月下旬）";
  else if (md >= 921 && md < 1221) semester = "後期（9月下旬～12月下旬），通常授课中";
  else if (md >= 1221 || md < 115) semester = "冬季休業中（寒假，12月下旬～1月中旬）";
  else if (md >= 115 && md < 215) semester = "後期試験期間（1月中旬～2月中旬）";
  else semester = "春休み（2月中旬～3月下旬），学年末假期，即将进入新学年";

  // Exam periods
  let examNote = "";
  if (md >= 115 && md < 215) examNote = "大学後期試験期间，学生多在备考或考试中。";
  else if (md >= 701 && md < 721) examNote = "大学前期試験临近，学生开始准备期末考。";
  else if (md >= 1201 && md < 1221) examNote = "大学後期試験临近（1月），レポート課題增多。";

  // Season
  let season;
  if (month === 3 || month === 4) season = "春季，樱花季，天气转暖，新年度开始";
  else if (month === 5) season = "晚春/新绿，气候宜人，户外活动增多";
  else if (month === 6 || (month === 7 && day <= 15)) season = "梅雨季（梅雨），闷热多雨，出行不便，紫阳花盛开";
  else if (month === 7 || month === 8) season = "盛夏，酷暑，台风季，花火大会/祭典/お盆季";
  else if (month === 9) season = "初秋/残暑，台风季尾声，运动会/月见季节";
  else if (month === 10 || month === 11) season = "秋季，红叶季高峰，气候凉爽宜人，行楽の秋/学園祭季节";
  else season = "冬季，寒冷，忘年会/クリスマス/年末年始季";

  // Golden Week / Silver Week
  let longHolidayNote = "";
  if (md >= 427 && md <= 506) longHolidayNote = "黄金周期间（4/29～5/5前后），大型连休，旅游出行高峰。";
  const silverStart = new Date(year, 8, 18);
  const silverEnd = new Date(year, 8, 24);
  if (date >= silverStart && date <= silverEnd) longHolidayNote = "シルバーウィーク（敬老の日+秋分の日），约5连休，旅游出行高峰。";

  // Holidays in range
  const holidays = japaneseHolidaysInRange(year, month, day, 14);
  const holidayText = holidays.length
    ? "近期节日：\n" + holidays.map(h => `  - ${h.date} ${h.name}`).join("\n")
    : "近期无日本国民祝日。";

  // Monthly notes
  const monthly = SEASONAL_MONTHLY_NOTES[month] || [];
  const prevMonth = month === 1 ? 12 : month - 1;
  const nextMonth = month === 12 ? 1 : month + 1;
  const seasonalNotes = [
    ...(SEASONAL_MONTHLY_NOTES[prevMonth]?.slice(-1) || []).map(s => `[${prevMonth}月尾] ${s}`),
    ...monthly.map(s => `[${month}月] ${s}`),
    ...(SEASONAL_MONTHLY_NOTES[nextMonth]?.slice(0, 1) || []).map(s => `[${nextMonth}月初] ${s}`),
  ];

  // Special dates from prompts
  const specialDatesText = (cfg.scheduleSpecialDates || "").trim();

  return [
    "【当前时间与季节上下文】",
    `当前日期：${year}年${month}月${day}日`,
    `学期状态：${semester}`,
    examNote ? `考试相关：${examNote}` : "",
    `季节特征：${season}`,
    longHolidayNote ? `连休提醒：${longHolidayNote}` : "",
    holidayText,
    "",
    "【近期行事与季节事件】",
    ...seasonalNotes,
    "",
    specialDatesText ? `【角色相关特殊日期】\n${specialDatesText}` : "",
  ].filter(Boolean).join("\n");
}

function sceneStateText(sess) {
  const state = normalizeSceneState(sess?._sceneState);
  if (!state) return "";
  if (state.expiresAt && Date.parse(state.expiresAt) && Date.now() > Date.parse(state.expiresAt)) return "";
  return state.text || "";
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

function buildSceneletPrompt({ userId, sessionName, profile, userBody, carriedSceneState, lifeArcs = [], visibleContext, memoryPrompt }) {
  const now = new Date();
  const cfg = loadPrompts();
  const instructions = cfg.sceneletInstructions || [
    "你在为微信角色私聊生成隐藏中间层，不会发送任何消息，不能调用工具，不能联网，不能写文件。",
    "",
    "任务：先生成本轮 inner_scenelet，再给出极短 next_scene_state，并判断是否存在一次性主动回复候选。",
  ].join("\n");
  return [
    instructions,
    "",
    cfg.lifeArcInstructions || "",
    "",
    CURRENT_SITE_AND_SEARCH_GUARD,
    "",
    "角色 prompt：",
    profile && profileTemplates[profile] ? profileTemplates[profile] : "",
    loadPinnedProfileRules(profile),
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
      visible_context_instruction: cfg.chatHistoryIntro,
      carried_scene_state: carriedSceneState || null,
      active_life_arcs: lifeArcs,
      recent_visible_context: visibleContext,
      user_message: userBody,
    }, null, 2),
    "",
    "输出 JSON，且只输出 JSON：",
    JSON.stringify({
      inner_scenelet: "string",
      next_scene_state: "string|null",
      life_arc_ops: [{
        op: "create|update|close",
        id: "existing id when updating/closing, omit for create",
        title: "short private life line title",
        summary: "what is continuing for 1-3 days",
        current_state: "where it stands now",
        next_useful_moment: "when it may naturally matter again",
        expires_at: "ISO string within a few days",
        reason: "why this op is useful"
      }],
      proactive_candidates: [{
        kind: "follow_up|daily_share",
        scheduled_at: "ISO string",
        expires_at: "ISO string",
        message_intent: "string",
        basis: "string",
        cancel_if: ["string"],
        inner_scenelet: "string"
      }]
    }, null, 2),
  ].filter(Boolean).join("\n");
}

function buildHiddenWorldSystemPrompt(profile) {
  const cfg = loadPrompts();
  const sceneletBase = cfg.sceneletInstructions || "";
  return [
    "你在维护一个微信角色私聊的隐藏世界 session。用户看不到你的输出；你的输出只用于帮助主回复和本地状态更新。",
    "",
    "核心任务：",
    "1. 必须生成本轮 inner_scenelet。它的职责和旧 scenelet 完全一致：帮助主回复理解角色此刻状态、身体感、情绪落点和接话方式。",
    "2. 生成 next_scene_state，保持短、轻、可过期。",
    "3. 更新 world_state_patch。只写结构化的当前生活状态，不要写长期设定。",
    "4. 生成 life_arc_ops，用于 1-3 天内的短期生活线。",
    "5. 生成 proactive_candidates，用于一次性 follow_up 或 daily_share 候选。",
    "6. 生成 daily_share_candidates，标出来源类型；它们只是候选，不等于会发送。",
    "7. 生成 schedule_candidates，提出可能的短期日程候选；不要直接当作已确认日程。",
    "8. 写出 time_reasoning 和 continuity_warnings，供程序和人类审计。",
    "",
    "时间连续性硬规则：",
    "- 先根据 current_time、recent_visible_context 和 last_world_event_at 判断时间差。",
    "- 几分钟到十几分钟内的连续对话，一般属于同一次醒来/同一段聊天，不要重复写成第二次、第三次被叫醒。",
    "- 睡眠、起床、通勤、排练等时间必须能算得通；不能凭空把还剩数小时写成只剩两三小时。",
    "- 用户纠正时间逻辑时，优先修正 hidden world，而不是沿用旧 scene_state 或 life_arc。",
    "",
    "daily_share 来源类型：",
    "- life_arc_related: 来自当前日程或生活线。",
    "- ambient_observation: 路上、手机、店铺、书、音乐、社交网络等偶然见闻。",
    "- memory_resurfacing: 从过去聊天自然想起。",
    "- pure_mood: 没有具体事件，只是熟人间突然想说一句。",
    "不要让 daily_share 全部围绕当前日程转。",
    "",
    sceneletBase,
    "",
    cfg.lifeArcInstructions || "",
    "",
    CURRENT_SITE_AND_SEARCH_GUARD,
    "",
    "角色 prompt：",
    profile && profileTemplates[profile] ? profileTemplates[profile] : "",
    loadPinnedProfileRules(profile),
    "",
    "聊天写法参考（用于降低 scenelet 的 AI 味；最终微信回复仍由主回复模型负责）：",
    getChatStyle(),
  ].filter(Boolean).join("\n");
}

function buildHiddenWorldPrompt({ userId, sessionName, profile, userBody, carriedSceneState, lifeArcs = [], visibleContext, memoryPrompt, worldState = null, proactiveIntents = [], worldSession = null }) {
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
      visible_context_instruction: cfg.chatHistoryIntro,
      carried_scene_state: carriedSceneState || null,
      active_life_arcs: lifeArcs,
      pending_proactive_intents: proactiveIntents,
      recent_visible_context: visibleContext,
      user_message: userBody,
    }, null, 2),
    "",
    "只输出 JSON，不要解释。格式：",
    JSON.stringify({
      inner_scenelet: "string",
      next_scene_state: "string|null",
      world_state_patch: {
        location: "short current place",
        activity: "short current activity",
        awake_state: "awake|sleeping|light_sleep|just_woke|unknown",
        current_plan: "next few hours only",
        open_threads: ["short unresolved visible or hidden threads"],
        last_world_event_at: "ISO string"
      },
      life_arc_ops: [{
        op: "create|update|close",
        id: "existing id when updating/closing, omit for create",
        title: "short private life line title",
        summary: "what is continuing for 1-3 days",
        current_state: "where it stands now",
        next_useful_moment: "when it may naturally matter again",
        kind: "travel|work|school|personal|special_date|null",
        time_start: "ISO string|null",
        time_end: "ISO string|null",
        expires_at: "ISO string within a few days",
        reason: "why this op is useful"
      }],
      proactive_candidates: [{
        kind: "follow_up|daily_share",
        scheduled_at: "ISO string",
        expires_at: "ISO string",
        message_intent: "string",
        basis: "string",
        cancel_if: ["string"],
        inner_scenelet: "string"
      }],
      daily_share_candidates: [{
        source_type: "life_arc_related|ambient_observation|memory_resurfacing|pure_mood",
        message_intent: "string",
        basis: "string",
        scheduled_at: "ISO string|null",
        expires_at: "ISO string|null",
        inner_scenelet: "string"
      }],
      schedule_candidates: [{
        title: "short title",
        summary: "short summary",
        kind: "travel|work|school|personal|special_date",
        time_start: "ISO string|null",
        time_end: "ISO string|null",
        confidence: "low|medium|high",
        basis: "string"
      }],
      time_reasoning: {
        current_role_time: "string",
        elapsed_since_last_visible_turn: "string",
        event_continuity: "string",
        sleep_reasoning: "string"
      },
      continuity_warnings: ["string"]
    }, null, 2),
  ].filter(Boolean).join("\n");
}

function buildMemoryCandidatePrompt(userBody, userId, profile) {
  return [
    "你是长期记忆候选抽取器，只判断用户这条消息中是否有值得长期保存的信息。",
    "不要查看或推断角色设定；不要记录当天闲聊、一次性情绪、饭点、天气、临时计划、角色扮演内容。",
    "只抽取长期稳定、跨对话有用、由用户明确表达的信息。",
    "类别只能是 trait、preference、fact。敏感或私密内容如健康、政治、宗教、性取向、财务、精确住址、亲密关系，确需记录时 sensitive=true。",
    "如果没有候选，输出空数组。",
    "",
    "输入：",
    JSON.stringify({ userId, profile, user_message: userBody }, null, 2),
    "",
    "只输出 JSON，不要解释。格式：",
    JSON.stringify({
      candidates: [{
        category: "trait|preference|fact",
        text: "简洁中文长期记忆候选",
        sensitive: false,
        reason: "为什么长期有用"
      }]
    }, null, 2),
  ].join("\n");
}

function buildMemoryMergePrompt({ userBody, userId, profile, candidates, existingItems }) {
  const cfg = loadPrompts();
  const policy = cfg.memoryWriterInstructions || "";
  return [
    "你是长期记忆合并规划器。你会拿到候选记忆和当前正式 memory items。",
    "目标：避免重复，能合并就 update，用户否定旧信息就 update 覆盖，只有确实没有相近旧条目时才 add。",
    "不要机械新增；不要把同一事实拆成多条；不要根据角色聊天内容写用户长期记忆。",
    "op 只能是 add、update、noop。update 必须带现有 id；noop 不需要 category/text。",
    "text 必须是可长期复用的简洁中文，最多 180 字。",
    "",
    policy ? `补充写入规则：\n${policy.slice(0, 2200)}` : "",
    "",
    "输入：",
    JSON.stringify({
      userId,
      profile,
      user_message: userBody,
      candidates,
      existing_memory_items: existingItems,
    }, null, 2),
    "",
    "只输出 JSON，不要解释。格式：",
    JSON.stringify({
      ops: [{
        op: "add|update|noop",
        id: "existing id when update",
        category: "trait|preference|fact",
        text: "简洁中文长期记忆",
        sensitive: false,
        reason: "简短说明"
      }]
    }, null, 2),
  ].filter(Boolean).join("\n");
}

function buildProactivePrompt({ userId, sessionName, profile, intent, memoryPrompt, carriedSceneState, visibleContext, sess }) {
  const now = new Date();
  const cfg = loadPrompts();
  const instr = (cfg.proactiveInstructions || "你在为微信角色私聊做一次性主动回复的到点二次判断。\n\n任务：根据系统可观察状态、上下文和候选意图，判断现在是否应该主动发送。如果发送，生成 inner_scenelet 和最终 visible_reply。");
  return [
    instr,
    "",
    "角色 prompt：",
    profile && profileTemplates[profile] ? profileTemplates[profile] : "",
    loadPinnedProfileRules(profile),
    "",
    memoryPrompt ? `长期记忆：\n${memoryPrompt}` : "",
    "",
    "机制要求：",
    "- 这不是定时循环，而是一次性候选；发送或取消后结束。",
    "- inner_scenelet 在这里承担 timing reason：贴近角色视角说明为什么此刻主动说话自然，并帮助生成回复；它不会直接发给用户。",
    "- 取消条件必须基于系统可观察事实：用户已经发来消息、事项已完成/取消、超过窗口、近期已主动发过、当天主动回复已达到上限、当前对话有更强主题等。",
    "- 不要用固定静默时段作为取消理由；夜里是否适合发送，只看候选本身、角色状态和当前关系语境是否自然。",
    "- 不要把角色生活氛围当成执行逻辑；例如'她忘了/她很忙'只能写在 inner_scenelet 的氛围里，不能作为系统取消原因。",
    "- 如果 system_observables.unanswered_proactive_since_last_user 显示近期已有多条主动消息但用户没有回复，要把这视为关系节奏：通常更克制或取消；如果仍发送，应像熟人随手补一句，而不是继续追问、查岗或叠加关心。",
    "- visible_reply 可以长可以短，由语境决定；不要泄露 inner_scenelet、机制、JSON、bot/AI/model 身份。",
    "- 固定角色事实不要为了漂亮类比而编造；不确定就模糊处理。",
    "- 用户（沃沃）是女性，指代用户时始终使用「她」。",
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
        last_daily_share_seed_at: sess?._lastDailyShareSeedAt || null,
        unanswered_proactive_since_last_user: unansweredProactiveSummary(sess),
      },
      visible_context_instruction: cfg.chatHistoryIntro,
      carried_scene_state: carriedSceneState || null,
      active_life_arcs: lifeArcPromptItems(sess),
      recent_visible_context: visibleContext,
      candidate_intent: intent,
    }, null, 2),
    "",
    "输出 JSON，且只输出 JSON：",
    JSON.stringify({
      should_send: true,
      cancel_reason: "string|null",
      inner_scenelet: "string",
      visible_reply: "string",
      next_scene_state: "string|null"
    }, null, 2),
  ].filter(Boolean).join("\n");
}

function buildDailyShareSeedPrompt({ userId, sessionName, profile, memoryPrompt, carriedSceneState, visibleContext, sess }) {
  const now = new Date();
  const cfg = loadPrompts();
  const instr = cfg.dailyShareSeedInstructions || "你在为社交软件角色私聊判断是否生成一条 daily_share 主动候选。只输出 JSON。";
  return [
    instr,
    "",
    "关系节奏补充：如果 system_observables.unanswered_proactive_since_last_user 显示近期已有多条主动消息但用户没有回复，不要把这当成继续主动发起话题的许可；除非此刻的分享非常自然、轻、低压力，否则应取消生成。",
    "",
    CURRENT_SITE_AND_SEARCH_GUARD,
    "",
    "角色 prompt：",
    profile && profileTemplates[profile] ? profileTemplates[profile] : "",
    loadPinnedProfileRules(profile),
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
        last_daily_share_seed_at: sess?._lastDailyShareSeedAt || null,
        proactive_sent_today: proactiveSentToday(sess, now),
        proactive_daily_max: cfg.proactiveDailyMax,
        unanswered_proactive_since_last_user: unansweredProactiveSummary(sess),
      },
      visible_context_instruction: cfg.chatHistoryIntro,
      carried_scene_state: carriedSceneState || null,
      active_life_arcs: lifeArcPromptItems(sess),
      recent_visible_context: visibleContext,
    }, null, 2),
    "",
    "输出 JSON，且只输出 JSON：",
    JSON.stringify({
      should_create: true,
      cancel_reason: "string|null",
      proactive_candidate: {
        kind: "daily_share",
        scheduled_at: "ISO string",
        expires_at: "ISO string",
        message_intent: "string",
        basis: "string",
        cancel_if: ["string"],
        inner_scenelet: "string"
      }
    }, null, 2),
  ].filter(Boolean).join("\n");
}
export {
  SEASONAL_MONTHLY_NOTES,
  buildStableStylePrompt,
  buildRagContextBlock,
  buildTurnBody,
  currentTimeContext,
  nthMonday,
  vernalEquinoxDay,
  autumnalEquinoxDay,
  japaneseHolidaysInRange,
  buildScheduleStaticContext,
  sceneStateText,
  recentVisibleContext,
  appendVisibleHistory,
  buildSceneletPrompt,
  buildHiddenWorldSystemPrompt,
  buildHiddenWorldPrompt,
  buildMemoryCandidatePrompt,
  buildMemoryMergePrompt,
  buildProactivePrompt,
  buildDailyShareSeedPrompt,
};
