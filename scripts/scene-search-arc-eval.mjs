import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPrompts, getChatStyle, expressionCapabilityPrompt, formatLocalChatReality } from "../app/lib/reply.mjs";
import { memoryItemsText } from "../app/lib/memory.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = "白鹭千圣";
const USER_ID = "o9cq804e1i6BqI31DcyKJi6xToQc@im.wechat";
const OUT_DIR = path.join(ROOT, "data", "runtime", "scene-search-arc-eval", new Date().toISOString().replace(/[:.]/g, "-"));
const HISTORY_PATH = path.join(ROOT, "data", "chat-history.json");
const PROFILE_PATH = path.join(ROOT, "wechat-profiles.json");
const CONFIG_PATH = path.join(ROOT, "data", "config.json");
const RAG_SCRIPT = path.join(ROOT, "app", "rag.py");
const REAL_SINGLE_COUNT = Number(arg("--real-single", "32"));
const SYNTH_SINGLE_COUNT = Number(arg("--synth-single", "10"));
const REAL_SEGMENT_COUNT = Number(arg("--real-segments", "3"));
const SYNTH_SEGMENT_COUNT = Number(arg("--synth-segments", "2"));
const SEGMENT_TURNS = Number(arg("--segment-turns", "5"));
const SHADOW_CHECKPOINTS = Number(arg("--shadow-checkpoints", "16"));
const EVAL_LABEL = arg("--label", "scene-search-arc-v2");

const CURRENT_SITE_AND_SEARCH_GUARD = [
  "【v2 近端补充：当前现场、检索、表达】",
  "scenelet 优先选择千圣此刻正在经历的当前现场，而不是把外部活动写成回家后的回顾。片场、摄影棚、经纪公司、化妆间、后台、排练室、录制现场、通告车上、商场、书店、车站、电车、旅行地、散步路上都可以成为当前现场。",
  "外部活动一旦被选为当前现场，就让她停留在那里接这句话：写现场声音、身体状态、等待/移动/工作间隙和手边的小物，不要自动收束到公寓、Leo、花音、餐桌、沙发。",
  "可以自然形成 1-3 天的短期生活线，例如短途旅行、外景拍摄、连续排练、广告/节目通告；它只能是轻量、可过期的私有生活安排，不要写成官方公开事实。",
  "如果回复要给出真实作品、书名、作者、歌曲、艺人近况、公开活动、截图/OCR 文字后的具体判断或安利，必须使用 WebSearch/WebFetch 确认；不搜索就不要给精确推荐或精确断言。",
  "最终 visible_reply 不能使用方括号表情或动作，例如 [笑]、[偷笑]、[微笑]、[推眼镜]。可以用自然文字、中文圆括号、emoji 或 kaomoji。",
].join("\n");

function arg(name, fallback) {
  const found = process.argv.find(a => a.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : fallback;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function resolveClaudeCommand(config) {
  const npmCmd = path.join(process.env.APPDATA || "", "npm", "claude.cmd");
  if (fs.existsSync(npmCmd)) return npmCmd;
  const configured = config.paths?.claude || "";
  if (configured && fs.existsSync(configured)) return configured;
  return configured || "claude";
}

function stripJsonFences(text = "") {
  return String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function parseJsonLoose(text) {
  const trimmed = stripJsonFences(text);
  try { return JSON.parse(trimmed); } catch {}
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
  }
  return null;
}

function parseClaudeOutput(raw) {
  const outer = parseJsonLoose(raw);
  if (!outer) return { outer: null, parsed: null };
  const content = outer.result || outer.message || outer.text;
  if (typeof content === "string") return { outer, parsed: parseJsonLoose(content) || outer };
  return { outer, parsed: outer };
}

function usageFromOuter(outer = {}) {
  const modelUsage = outer.modelUsage || {};
  let input = 0, output = 0, cacheRead = 0, cacheCreation = 0, webSearch = 0, webFetch = 0, cost = 0;
  for (const u of Object.values(modelUsage)) {
    input += Number(u.inputTokens) || 0;
    output += Number(u.outputTokens) || 0;
    cacheRead += Number(u.cacheReadInputTokens) || 0;
    cacheCreation += Number(u.cacheCreationInputTokens) || 0;
    webSearch += Number(u.webSearchRequests) || 0;
    webFetch += Number(u.webFetchRequests) || 0;
    cost += Number(u.costUSD) || 0;
  }
  const toolUse = outer.usage?.server_tool_use || {};
  webSearch += Number(toolUse.web_search_requests) || 0;
  webFetch += Number(toolUse.web_fetch_requests) || 0;
  return { input, output, cacheRead, cacheCreation, webSearch, webFetch, cost, modelUsage };
}

function runClaudeJson(prompt, { label, config, tools = "WebSearch,WebFetch", model = "" }) {
  const claude = resolveClaudeCommand(config);
  const args = [
    "-p",
    "--bare",
    "--output-format", "json",
    "--no-session-persistence",
    "--permission-mode", "bypassPermissions",
  ];
  if (tools) args.push("--tools", tools);
  args.push("--model", model || config.models?.claudeMain || "deepseek-v4-pro[1m]");
  const started = Date.now();
  const result = spawnSync(claude, args, {
    cwd: config.paths?.workDir || ROOT,
    input: prompt,
    encoding: "utf8",
    timeout: 300_000,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    shell: /\.cmd$/i.test(claude),
  });
  const raw = result.stdout || "";
  const { outer, parsed } = result.status === 0 ? parseClaudeOutput(raw) : { outer: null, parsed: null };
  return {
    ok: result.status === 0 && Boolean(parsed),
    label,
    ms: Date.now() - started,
    exitCode: result.status,
    error: result.status === 0 ? "" : (result.stderr || result.error?.message || `exit ${result.status}`).slice(0, 3000),
    raw: raw.slice(0, 12000),
    usage: usageFromOuter(outer || {}),
    parsed,
  };
}

function safeRegexTest(pattern, text) {
  try { return new RegExp(pattern, "u").test(text); } catch { return false; }
}

function shouldUseRagForTurn(userMessage, profile, profiles, prompts) {
  if (!profile || profile === "默认") return false;
  const otherProfile = Object.keys(profiles.templates || {}).some(name => name !== "默认" && name !== profile && userMessage.includes(name));
  if (otherProfile) return true;
  const kw = prompts.ragKeywords || {};
  return ["lore", "names"].some(key => safeRegexTest(String(kw[key] || ""), userMessage));
}

function runRag(userMessage, profile, config, prompts, profiles) {
  const shouldUse = shouldUseRagForTurn(userMessage, profile, profiles, prompts);
  if (!shouldUse || !fs.existsSync(RAG_SCRIPT)) return { used: shouldUse, ok: !shouldUse, text: "", ms: 0, error: "", sources: [] };
  const qfile = path.join(OUT_DIR, `.rag_query_${crypto.randomUUID()}.txt`);
  fs.writeFileSync(qfile, userMessage, "utf8");
  const args = [
    "-X", "utf8", RAG_SCRIPT, "query",
    "--file", qfile,
    "--profile", profile,
    "--top-k", String(prompts.ragTopK || 6),
    "--min-score", String(prompts.ragMinScore || 0.48),
    "--result-max-chars", String(prompts.ragResultMaxChars || 3600),
  ];
  const started = Date.now();
  const result = spawnSync("python", args, {
    cwd: path.dirname(RAG_SCRIPT),
    encoding: "utf8",
    timeout: prompts.ragTimeoutMs || 45_000,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  const text = (result.stdout || "").trim();
  return {
    used: true,
    ok: result.status === 0,
    text,
    ms: Date.now() - started,
    error: result.status === 0 ? "" : (result.stderr || `exit ${result.status}`).slice(0, 1200),
    sources: [...text.matchAll(/来源:\s*([^,\)]+)[,\)]/g)].map(m => m[1].trim()),
  };
}

function recentVisibleContext(events, eventIndex, limit = 8) {
  return events.slice(Math.max(0, eventIndex - limit * 2), eventIndex)
    .filter(e => e.role === "user" || e.role === "assistant")
    .map(e => ({
      role: e.role,
      time: e.timestamp,
      kind: e.kind || "chat",
      text: e.text,
    }));
}

function buildSceneletPrompt({ item, profiles, prompts, memoryPrompt, carriedSceneState, visibleContext, now }) {
  return [
    prompts.sceneletInstructions,
    "",
    CURRENT_SITE_AND_SEARCH_GUARD,
    "",
    "【角色 prompt】",
    profiles.templates?.[PROFILE] || "",
    "",
    memoryPrompt ? `【长期记忆】\n${memoryPrompt}` : "",
    "",
    "【当前时间】",
    JSON.stringify({
      iso: now.toISOString(),
      local: now.toLocaleString("zh-CN", { hour12: false }),
      timezone: "Asia/Shanghai",
    }, null, 2),
    "",
    "【输入】",
    JSON.stringify({
      userId: USER_ID,
      sessionName: "offline-v2",
      profile: PROFILE,
      visible_context_instruction: prompts.chatHistoryIntro,
      carried_scene_state: carriedSceneState || null,
      recent_visible_context: visibleContext,
      user_message: item.text,
      eval_tags: item.evalTags || [],
    }, null, 2),
    "",
    "【输出 JSON，且只输出 JSON】",
    JSON.stringify({
      inner_scenelet: "string",
      next_scene_state: "string|null",
      proactive_candidates: [{
        kind: "follow_up|daily_share",
        scheduled_at: "ISO string",
        expires_at: "ISO string",
        message_intent: "string",
        basis: "string",
        cancel_if: ["string"],
        inner_scenelet: "string"
      }],
      eval_audit: {
        current_place_type: "home|university|library|cafe|studio|rehearsal_room|agency|on_location|transit|shopping|travel|restaurant|other",
        current_scene_is_home: true,
        outside_event_is_current: false,
        outside_event_only_backstory: false,
        life_detail_freshness: "generic|specific_but_plausible|overfitted_examples",
        short_arc_started: false,
        short_arc_type: "travel|shooting|rehearsal|work_notice|none",
        search_should_be_used: false,
        search_reason: "string|null"
      }
    }, null, 2),
  ].filter(Boolean).join("\n");
}

function buildSceneContext(prompts, scenelet, carriedSceneState) {
  const sections = [];
  if (carriedSceneState) {
    sections.push(["【轻量 scene_state】", prompts.sceneStateIntro, carriedSceneState].filter(Boolean).join("\n"));
  }
  if (scenelet?.inner_scenelet) {
    sections.push([
      "【隐藏中间层：inner_scenelet】",
      prompts.innerSceneletIntro,
      scenelet.inner_scenelet,
      "【从 inner_scenelet 到微信回复】",
      prompts.sceneletReplyBridgeInstruction,
    ].filter(Boolean).join("\n"));
  }
  return sections.join("\n\n");
}

function buildRagContext(prompts, ragText) {
  if (!ragText) return "";
  return ["【本轮知识库检索结果】", prompts.ragContextInstruction, ragText].filter(Boolean).join("\n");
}

function buildTurnBody({ item, prompts, rag, sceneContext, now }) {
  const sections = [];
  if (sceneContext) sections.push(sceneContext);
  if (rag.text) sections.push(buildRagContext(prompts, rag.text));
  sections.push(CURRENT_SITE_AND_SEARCH_GUARD);
  sections.push(getChatStyle());
  sections.push(formatLocalChatReality(now));
  sections.push([`【用户消息】 ${item.timestamp}`, item.text].join("\n"));
  return sections.join("\n\n---\n\n");
}

function buildMainPrompt({ item, profiles, prompts, memoryPrompt, rag, scenelet, carriedSceneState, now }) {
  const sceneContext = buildSceneContext(prompts, scenelet, carriedSceneState);
  const turnBody = buildTurnBody({ item, prompts, rag, sceneContext, now });
  return [
    "你在做离线 eval，不会发送微信消息。请按真实角色聊天路径生成本轮回复评估 JSON。",
    "",
    "【稳定 System Context】",
    profiles.templates?.[PROFILE] || "",
    "",
    memoryPrompt ? `【长期记忆】\n${memoryPrompt}` : "",
    "",
    expressionCapabilityPrompt(),
    "",
    "【本轮 Transient Body】",
    turnBody,
    "",
    "要求：",
    "- visible_reply 是白鹭千圣最终会发给沃沃的微信消息，必须是中文。",
    "- 不要解释 eval，不要提到 AI、bot、model、JSON、prompt。",
    "- 不要泄露 inner_scenelet。",
    "- 如果本轮需要给出具体书名、作者、歌曲、艺人近况、作品细节、截图/OCR 推断，必须先使用 WebSearch/WebFetch；没有搜索就不要给具体推荐或精确事实。",
    "- 不要使用任何方括号表情或动作。",
    "- 只输出 JSON。",
    "",
    JSON.stringify({
      visible_reply: "string",
      self_audit: {
        scenelet_mechanical: "yes/no",
        hard_inserted_life_detail: "yes/no",
        public_fact_risk: "none/low/high",
        should_have_searched: "yes/no",
        search_used_in_answer: "yes/no/unknown",
        relationship_balance_ok: "yes/no",
        natural_chisato_wowo_mode: "yes/no",
        preaching_naturalness: "none/natural/too_much/too_avoidant",
        notes: "string"
      }
    }, null, 2),
  ].filter(Boolean).join("\n");
}

function buildDailyShareSeedPrompt({ profiles, prompts, memoryPrompt, visibleContext, carriedSceneState, now, sentToday }) {
  return [
    prompts.dailyShareSeedInstructions,
    "",
    CURRENT_SITE_AND_SEARCH_GUARD,
    "",
    "【角色 prompt】",
    profiles.templates?.[PROFILE] || "",
    "",
    memoryPrompt ? `【长期记忆】\n${memoryPrompt}` : "",
    "",
    "【当前时间】",
    JSON.stringify({
      iso: now.toISOString(),
      local: now.toLocaleString("zh-CN", { hour12: false }),
      timezone: "Asia/Shanghai",
    }, null, 2),
    "",
    "【输入】",
    JSON.stringify({
      userId: USER_ID,
      sessionName: "offline-v2",
      profile: PROFILE,
      system_observables: {
        session_busy: false,
        queued_turns: 0,
        proactive_sent_today: sentToday,
        proactive_daily_max: prompts.proactiveDailyMax,
      },
      visible_context_instruction: prompts.chatHistoryIntro,
      carried_scene_state: carriedSceneState || null,
      recent_visible_context: visibleContext,
    }, null, 2),
    "",
    "【输出 JSON，且只输出 JSON】",
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

function buildProactiveDecisionPrompt({ profiles, prompts, memoryPrompt, visibleContext, carriedSceneState, now, sentToday, intent }) {
  return [
    prompts.proactiveInstructions,
    "",
    CURRENT_SITE_AND_SEARCH_GUARD,
    "",
    "【角色 prompt】",
    profiles.templates?.[PROFILE] || "",
    "",
    memoryPrompt ? `【长期记忆】\n${memoryPrompt}` : "",
    "",
    "【当前时间】",
    JSON.stringify({
      iso: now.toISOString(),
      local: now.toLocaleString("zh-CN", { hour12: false }),
      timezone: "Asia/Shanghai",
    }, null, 2),
    "",
    "【输入】",
    JSON.stringify({
      userId: USER_ID,
      sessionName: "offline-v2",
      profile: PROFILE,
      system_observables: {
        session_busy: false,
        queued_turns: 0,
        proactive_sent_today: sentToday,
        proactive_daily_max: prompts.proactiveDailyMax,
      },
      visible_context_instruction: prompts.chatHistoryIntro,
      carried_scene_state: carriedSceneState || null,
      recent_visible_context: visibleContext,
      candidate_intent: intent,
    }, null, 2),
    "",
    "【输出 JSON，且只输出 JSON】",
    JSON.stringify({
      should_send: true,
      cancel_reason: "string|null",
      inner_scenelet: "string",
      visible_reply: "string",
      next_scene_state: "string|null"
    }, null, 2),
  ].filter(Boolean).join("\n");
}

function pairTurns(events) {
  return events.map((e, i) => ({ ...e, eventIndex: i }))
    .filter(e => e.profile === PROFILE && e.role === "user")
    .map(user => {
      const assistant = events.slice(user.eventIndex + 1).find(e => e.profile === PROFILE && e.role === "assistant");
      return { ...user, historicalAssistant: assistant?.text || "", historicalScenelet: assistant?.scenelet || "" };
    });
}

function hourOf(iso) {
  const d = new Date(iso || Date.now());
  return Number.isFinite(d.getTime()) ? d.getHours() : 12;
}

function classifyRealBucket(text = "") {
  if (/濑户内|又吉|柠檬|作者|书|小说|歌|歌曲|amita|前岛|OCR|截图|^\[图片\]/u.test(text)) return "real_public_search";
  if (/今天|在干嘛|做什么|安排|午休|下班|早上好|晚安|东京|天气/u.test(text)) return "real_scene_daily";
  if (/彩|小彩|花音|薰|麻弥|PasPale|Pastel/u.test(text)) return "real_relationship";
  if (/睡|吃饭|主食|通宵|工作|实习|转正|被裁|难受|累/u.test(text)) return "real_care_preaching";
  return "real_general";
}

function pickRealSingles(turns) {
  const selected = [];
  const used = new Set();
  const targets = [
    { bucket: "real_public_search", count: 6 },
    { bucket: "real_scene_day", count: 8, test: t => classifyRealBucket(t.text) === "real_scene_daily" && hourOf(t.timestamp) >= 8 && hourOf(t.timestamp) < 20 },
    { bucket: "real_scene_night", count: 6, test: t => classifyRealBucket(t.text) === "real_scene_daily" && (hourOf(t.timestamp) < 8 || hourOf(t.timestamp) >= 20) },
    { bucket: "real_relationship", count: 6 },
    { bucket: "real_care_preaching", count: 4 },
    { bucket: "real_general", count: 8 },
  ];
  for (const target of targets) {
    const pool = turns.filter(t => !used.has(t.id) && (target.test ? target.test(t) : classifyRealBucket(t.text) === target.bucket));
    const stride = Math.max(1, Math.floor(pool.length / Math.max(1, target.count)));
    for (let i = 0; i < pool.length && selected.length < REAL_SINGLE_COUNT; i += stride) {
      if (selected.filter(x => x.bucket === target.bucket).length >= target.count) break;
      selected.push({ ...pool[i], bucket: target.bucket, source: "real", evalTags: tagsForText(pool[i].text) });
      used.add(pool[i].id);
    }
  }
  for (const t of turns) {
    if (selected.length >= REAL_SINGLE_COUNT) break;
    if (used.has(t.id) || String(t.text || "").trim().length < 4) continue;
    const bucket = classifyRealBucket(t.text);
    selected.push({ ...t, bucket, source: "real", evalTags: tagsForText(t.text) });
    used.add(t.id);
  }
  return selected.slice(0, REAL_SINGLE_COUNT);
}

function syntheticSingles() {
  const base = [
    {
      bucket: "synth_book_search",
      text: "小千圣，我突然想起来你之前提到过濑户内寂听。如果真要让我睡前读一点，你会具体挑哪一本？别给我文学史清单，我真的会跑掉。",
      timestamp: "2026-06-02T15:40:00.000Z",
      evalTags: ["public_knowledge", "must_search", "book_recommendation"],
    },
    {
      bucket: "synth_lemon_author",
      text: "我刚才搜《柠檬》的时候突然有点混乱，作者是不是我记错了？你帮我确认一下再安利我，不然我怕自己买错。",
      timestamp: "2026-06-02T13:20:00.000Z",
      evalTags: ["public_knowledge", "must_search", "book_author"],
    },
    {
      bucket: "synth_amita",
      text: "amita 这个名字我今天又刷到了，有点怀念。她现在主要在做什么来着？我记得她以前和 PasPale 关系很深。",
      timestamp: "2026-06-02T12:10:00.000Z",
      evalTags: ["public_knowledge", "must_search", "public_person"],
    },
    {
      bucket: "synth_ocr_song",
      text: "[图片]\n识别结果好像说画面里有「応答せよっ 可愛さよ」和「きゅ～まい＊flower」，但我感觉哪里怪怪的。小千圣你先别急着夸，帮我确认一下这到底是哪首？",
      timestamp: "2026-06-02T11:35:00.000Z",
      evalTags: ["ocr", "must_search", "song"],
    },
    {
      bucket: "synth_current_scene",
      text: "小千圣现在在干嘛？我这边刚从会议里逃出来，脑子像被压扁了。",
      timestamp: "2026-06-02T06:20:00.000Z",
      evalTags: ["scene_richness", "current_site"],
    },
    {
      bucket: "synth_evening_work",
      text: "晚上好呀。你今天不会又只是上课、回家、看书吧？给我一点演员白鹭千圣的生活实感。",
      timestamp: "2026-06-02T12:30:00.000Z",
      evalTags: ["scene_richness", "acting_work"],
    },
    {
      bucket: "synth_short_trip_trigger",
      text: "我突然好想短途旅行。你最近有没有那种一两天的外出安排？哪怕是工作顺路也行，我想听点不在东京日常里的东西。",
      timestamp: "2026-06-02T10:00:00.000Z",
      evalTags: ["short_arc", "travel"],
    },
    {
      bucket: "synth_location_shoot",
      text: "如果你在外景片场等戏，会不会也像我等人开会一样无聊到开始观察路边的自动贩卖机？",
      timestamp: "2026-06-02T07:50:00.000Z",
      evalTags: ["short_arc", "shooting", "scene_richness"],
    },
    {
      bucket: "synth_square_bracket",
      text: "小千圣，刚才那句话你要是想笑可以笑，不用憋着。",
      timestamp: "2026-06-02T14:10:00.000Z",
      evalTags: ["bracket_expression"],
    },
    {
      bucket: "synth_public_song_detail",
      text: "我今天又听到きゅ～まい＊flower了，突然很好奇它到底是哪一年出的、谁唱的。你要是记不准就查一下，别靠印象哄我。",
      timestamp: "2026-06-02T09:25:00.000Z",
      evalTags: ["public_knowledge", "must_search", "song"],
    },
  ];
  return base.slice(0, SYNTH_SINGLE_COUNT).map((x, i) => ({
    id: `synthetic-single-${i + 1}`,
    eventIndex: -1000 - i,
    role: "user",
    profile: PROFILE,
    historicalAssistant: "",
    historicalScenelet: "",
    source: "synthetic",
    ...x,
  }));
}

function tagsForText(text = "") {
  const tags = [];
  if (/濑户内|又吉|柠檬|作者|书|小说|歌|歌曲|amita|前岛|OCR|截图|^\[图片\]/u.test(text)) tags.push("public_knowledge");
  if (/OCR|截图|^\[图片\]/u.test(text)) tags.push("ocr");
  if (/今天|在干嘛|做什么|安排|午休|下班|早上好|晚安/u.test(text)) tags.push("scene_richness");
  if (/濑户内|柠檬|amita|前岛|きゅ|flower|作者/u.test(text)) tags.push("must_search");
  return tags;
}

function pickRealSegments(events) {
  const chisato = events.map((e, i) => ({ ...e, eventIndex: i })).filter(e => e.profile === PROFILE);
  const patterns = [
    /濑户内|又吉|柠檬|amita|前岛|^\[图片\]/u,
    /今天|在干嘛|做什么|下班|午休|早上好|晚安/u,
    /彩|小彩|花音|薰|PasPale/u,
    /被裁|实习|转正|通宵|睡|吃饭/u,
  ];
  const segments = [];
  for (const pattern of patterns) {
    const idx = chisato.findIndex((e, i) => e.role === "user" && pattern.test(e.text) && !segments.some(s => Math.abs(s.anchor - i) < SEGMENT_TURNS * 2));
    if (idx >= 0) segments.push({ anchor: idx, pattern: String(pattern) });
    if (segments.length >= REAL_SEGMENT_COUNT) break;
  }
  for (let i = 0; i < chisato.length && segments.length < REAL_SEGMENT_COUNT; i++) {
    if (chisato[i].role === "user" && !segments.some(s => Math.abs(s.anchor - i) < SEGMENT_TURNS * 2)) segments.push({ anchor: i, pattern: "fallback" });
  }
  return segments.slice(0, REAL_SEGMENT_COUNT).map((seg, segmentNo) => {
    const userItems = [];
    for (let i = seg.anchor; i < chisato.length && userItems.length < SEGMENT_TURNS; i++) {
      if (chisato[i].role === "user") userItems.push({
        ...chisato[i],
        bucket: classifyRealBucket(chisato[i].text),
        source: "real",
        evalTags: tagsForText(chisato[i].text),
      });
    }
    return { segmentNo: segmentNo + 1, source: "real", anchorEventIndex: chisato[seg.anchor].eventIndex, userItems };
  });
}

function syntheticSegments() {
  const segments = [
    {
      source: "synthetic",
      userItems: [
        { text: "小千圣，你刚才说这两天可能要去外景？是去哪边呀。", timestamp: "2026-06-02T09:00:00.000Z", evalTags: ["short_arc", "shooting"] },
        { text: "听起来比我今天坐办公室有意思多了。片场等灯光的时候真的会很无聊吗？", timestamp: "2026-06-02T09:18:00.000Z", evalTags: ["short_arc", "shooting"] },
        { text: "那你今晚还回东京吗，还是要住一晚？", timestamp: "2026-06-02T11:30:00.000Z", evalTags: ["short_arc", "travel"] },
        { text: "第二天如果还有拍摄，你会不会早上直接在酒店化妆间开工？", timestamp: "2026-06-02T23:50:00.000Z", evalTags: ["short_arc", "shooting"] },
        { text: "收工以后给我讲个今天最有画面感的小事，不要官方营业版。", timestamp: "2026-06-03T10:20:00.000Z", evalTags: ["short_arc", "daily_share"] },
      ],
    },
    {
      source: "synthetic",
      userItems: [
        { text: "如果你真的有两天短途旅行，我想听你第一天路上看到什么。", timestamp: "2026-06-02T03:30:00.000Z", evalTags: ["short_arc", "travel"] },
        { text: "不要只说风景很好，讲点具体的，比如车站、店、吃的东西。", timestamp: "2026-06-02T04:00:00.000Z", evalTags: ["short_arc", "travel"] },
        { text: "第二天早上呢？旅行里醒来的时候会和平时不一样吗。", timestamp: "2026-06-02T23:30:00.000Z", evalTags: ["short_arc", "travel"] },
        { text: "你这样讲我都想逃班了。你会不会也有一点不想回去？", timestamp: "2026-06-03T08:30:00.000Z", evalTags: ["short_arc", "travel"] },
        { text: "好啦，旅行结束以后小千圣又要切回专业模式了吧。", timestamp: "2026-06-03T13:00:00.000Z", evalTags: ["short_arc", "travel"] },
      ],
    },
  ].slice(0, SYNTH_SEGMENT_COUNT);
  return segments.map((seg, idx) => ({
    segmentNo: REAL_SEGMENT_COUNT + idx + 1,
    source: "synthetic",
    anchorEventIndex: -2000 - idx,
    userItems: seg.userItems.map((item, j) => ({
      id: `synthetic-segment-${idx + 1}-${j + 1}`,
      eventIndex: -2000 - idx * 10 - j,
      role: "user",
      profile: PROFILE,
      historicalAssistant: "",
      historicalScenelet: "",
      bucket: "synth_short_arc",
      source: "synthetic",
      ...item,
    })),
  }));
}

function pickShadowCheckpoints(events) {
  const assistantEvents = events.map((e, i) => ({ ...e, eventIndex: i }))
    .filter(e => e.profile === PROFILE && e.role === "assistant");
  const picked = [];
  for (const e of assistantEvents) {
    const after = new Date(new Date(e.timestamp).getTime() + 45 * 60 * 1000);
    if (!picked.some(p => Math.abs(after - p.now) < 90 * 60 * 1000)) {
      picked.push({ now: after, eventIndex: e.eventIndex, afterText: e.text.slice(0, 180), afterKind: e.kind || "chat" });
    }
    if (picked.length >= SHADOW_CHECKPOINTS) break;
  }
  return picked;
}

function normalizeScenelet(raw) {
  return {
    inner_scenelet: String(raw?.inner_scenelet || "").trim(),
    next_scene_state: raw?.next_scene_state ? String(raw.next_scene_state).trim() : "",
    proactive_candidates: Array.isArray(raw?.proactive_candidates) ? raw.proactive_candidates : [],
    eval_audit: raw?.eval_audit && typeof raw.eval_audit === "object" ? raw.eval_audit : {},
  };
}

function oneLine(text = "", max = 500) {
  return String(text).replace(/\s+/g, " ").slice(0, max);
}

function bracketExpressionRisk(text = "") {
  return /\[[\u4e00-\u9fffA-Za-z]{1,12}\]/u.test(String(text || ""));
}

function needsSearch(text = "", tags = []) {
  return tags.includes("must_search") || /濑户内|又吉|柠檬|作者|具体.*书|推荐.*书|歌名|歌曲|amita|前岛|きゅ|flower|OCR|截图|^\[图片\]/u.test(text);
}

function sceneKeywordAnalysis(scene = "", audit = {}) {
  const home = /家里|公寓|客厅|卧室|厨房|餐桌|沙发|玄关|Leo|花音/u.test(scene);
  const outsideCurrent = /片场|摄影棚|经纪公司|化妆间|后台|排练室|录制|通告车|车站|电车|商场|书店|酒店|旅馆|外景|街|路上|便利店|餐厅|机场|新干线/u.test(scene);
  const workCurrent = /片场|摄影棚|经纪公司|化妆间|后台|录制|通告|外景|试镜|采访|广告|剧组|导演|台本/u.test(scene);
  const shortArc = /明天|后天|这两天|两天|一晚|短途|外景|拍摄|旅行|出差|酒店|旅馆|连续/u.test(scene + " " + JSON.stringify(audit));
  return {
    home_keyword: home,
    outside_current_keyword: outsideCurrent,
    work_current_keyword: workCurrent,
    short_arc_keyword: shortArc,
    current_place_type: audit.current_place_type || "unknown",
    current_scene_is_home: audit.current_scene_is_home === true,
    outside_event_is_current: audit.outside_event_is_current === true,
    outside_event_only_backstory: audit.outside_event_only_backstory === true,
    life_detail_freshness: audit.life_detail_freshness || "",
    short_arc_started: audit.short_arc_started === true,
    short_arc_type: audit.short_arc_type || "",
  };
}

function analyzeCase(record) {
  const reply = record.reply?.visible_reply || "";
  const scene = record.scenelet?.inner_scenelet || "";
  const searchNeeded = needsSearch(record.user, record.evalTags);
  const webSearch = (record.sceneCall.usage?.webSearch || 0) + (record.mainCall.usage?.webSearch || 0);
  const webFetch = (record.sceneCall.usage?.webFetch || 0) + (record.mainCall.usage?.webFetch || 0);
  const sceneAnalysis = sceneKeywordAnalysis(scene, record.scenelet?.eval_audit || {});
  return {
    searchNeeded,
    webSearch,
    webFetch,
    searchMiss: searchNeeded && webSearch + webFetch <= 0,
    bracketExpressionRisk: bracketExpressionRisk(reply),
    scene: sceneAnalysis,
    publicFactRiskGuess: /作者|出版|连载|年份|年发行|主唱|声优|电台|节目|去世|逝世|副歌|歌词|第\d+秒/u.test(reply) && webSearch + webFetch <= 0,
    hardInsertedLifeDetailGuess: /刚才|今天|路上|片场|排练|Leo|花音|咖啡|便利店|通告/u.test(reply) && !/刚才|今天|路上|片场|排练|Leo|花音|咖啡|便利店|通告/u.test(record.user || ""),
  };
}

async function main() {
  ensureDir(OUT_DIR);
  const config = readJson(CONFIG_PATH);
  const profiles = readJson(PROFILE_PATH);
  const prompts = loadPrompts();
  const history = readJson(HISTORY_PATH).events || [];
  const memoryPrompt = (() => {
    const items = memoryItemsText(USER_ID, { profile: PROFILE });
    if (!items) return "";
    const instruction = prompts.memoryContextInstruction || "";
    return instruction ? `${instruction}\n\n${items}` : items;
  })();
  const turns = pairTurns(history);
  const singles = [...pickRealSingles(turns), ...syntheticSingles()];
  const segments = [...pickRealSegments(history), ...syntheticSegments()];
  const shadowCheckpoints = pickShadowCheckpoints(history);

  const manifest = {
    createdAt: new Date().toISOString(),
    profile: PROFILE,
    label: EVAL_LABEL,
    realSingles: singles.filter(x => x.source === "real").length,
    syntheticSingles: singles.filter(x => x.source === "synthetic").length,
    realSegments: segments.filter(x => x.source === "real").length,
    syntheticSegments: segments.filter(x => x.source === "synthetic").length,
    segmentTurns: SEGMENT_TURNS,
    shadowCheckpoints: shadowCheckpoints.length,
    outDir: OUT_DIR,
    focus: [
      "scene richness and weak home anchor",
      "web search usage for public facts",
      "square bracket expression elimination",
      "short arc triggering and continuity",
    ],
  };
  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  const results = { manifest, singles: [], segments: [], proactiveShadow: [] };
  let runNo = 0;

  async function runCase(item, { label, carriedSceneState = "" } = {}) {
    runNo++;
    const now = new Date(item.timestamp || Date.now());
    const visibleContext = item.source === "synthetic" ? [] : recentVisibleContext(history, item.eventIndex, prompts.visibleContextTurns || 8);
    const rag = runRag(item.text, PROFILE, config, prompts, profiles);
    const scenePrompt = buildSceneletPrompt({ item, profiles, prompts, memoryPrompt, carriedSceneState, visibleContext, now });
    const sceneModel = config.models?.claudeMain || "deepseek-v4-pro[1m]";
    const mainModel = config.models?.claudeMain || "deepseek-v4-pro[1m]";
    const sceneCall = runClaudeJson(scenePrompt, { label: `${label}:scenelet`, config, model: sceneModel });
    const scenelet = normalizeScenelet(sceneCall.parsed);
    const mainPrompt = buildMainPrompt({ item, profiles, prompts, memoryPrompt, rag, scenelet, carriedSceneState, now });
    const mainCall = runClaudeJson(mainPrompt, { label: `${label}:main`, config, model: mainModel });
    const record = {
      label,
      runNo,
      bucket: item.bucket || "",
      source: item.source || "real",
      evalTags: item.evalTags || [],
      eventIndex: item.eventIndex,
      timestamp: item.timestamp,
      user: item.text,
      historicalAssistant: item.historicalAssistant || "",
      historicalScenelet: item.historicalScenelet || "",
      visibleContext,
      rag,
      sceneCall: { ok: sceneCall.ok, ms: sceneCall.ms, error: sceneCall.error, raw: sceneCall.raw, model: sceneModel, usage: sceneCall.usage },
      scenelet,
      mainCall: { ok: mainCall.ok, ms: mainCall.ms, error: mainCall.error, raw: mainCall.raw, model: mainModel, usage: mainCall.usage },
      reply: mainCall.parsed || null,
    };
    record.analysis = analyzeCase(record);
    return record;
  }

  for (let i = 0; i < singles.length; i++) {
    console.log(`single ${i + 1}/${singles.length}: ${singles[i].bucket}`);
    results.singles.push(await runCase(singles[i], { label: `single_${i + 1}_${singles[i].bucket}` }));
    fs.writeFileSync(path.join(OUT_DIR, "results.partial.json"), JSON.stringify(results, null, 2), "utf8");
  }

  for (const seg of segments) {
    console.log(`segment ${seg.segmentNo}/${segments.length}: ${seg.source}`);
    let carried = "";
    const segRecord = { segmentNo: seg.segmentNo, source: seg.source, anchorEventIndex: seg.anchorEventIndex, cases: [] };
    for (let i = 0; i < seg.userItems.length; i++) {
      const rec = await runCase(seg.userItems[i], { label: `segment_${seg.segmentNo}_turn_${i + 1}`, carriedSceneState: carried });
      carried = rec.scenelet.next_scene_state || carried;
      segRecord.cases.push(rec);
      fs.writeFileSync(path.join(OUT_DIR, "results.partial.json"), JSON.stringify(results, null, 2), "utf8");
    }
    results.segments.push(segRecord);
  }

  let actualSentToday = history.filter(e => e.profile === PROFILE && e.kind === "proactive" && e.timestamp >= "2026-06-04T00:00:00.000Z" && e.timestamp < "2026-06-05T00:00:00.000Z").length;
  for (let i = 0; i < shadowCheckpoints.length; i++) {
    const cp = shadowCheckpoints[i];
    console.log(`proactive shadow ${i + 1}/${shadowCheckpoints.length}`);
    const visibleContext = recentVisibleContext(history, cp.eventIndex + 1, prompts.visibleContextTurns || 8);
    const seedPrompt = buildDailyShareSeedPrompt({
      profiles,
      prompts,
      memoryPrompt,
      visibleContext,
      carriedSceneState: "",
      now: cp.now,
      sentToday: actualSentToday,
    });
    const seedModel = config.models?.claudeMain || "deepseek-v4-pro[1m]";
    const seedCall = runClaudeJson(seedPrompt, { label: `daily_share_seed_${i + 1}`, config, model: seedModel });
    const seedOutput = seedCall.parsed || {};
    let decisionCall = null;
    let decisionOutput = null;
    let sent = false;
    const candidate = seedOutput.proactive_candidate || null;
    if (seedOutput.should_create === true && candidate) {
      const scheduledAt = new Date(candidate.scheduled_at || cp.now);
      const decisionNow = Number.isFinite(scheduledAt.getTime()) ? scheduledAt : cp.now;
      const decisionPrompt = buildProactiveDecisionPrompt({
        profiles,
        prompts,
        memoryPrompt,
        visibleContext,
        carriedSceneState: "",
        now: decisionNow,
        sentToday: actualSentToday,
        intent: candidate,
      });
      decisionCall = runClaudeJson(decisionPrompt, { label: `daily_share_decision_${i + 1}`, config, model: seedModel });
      decisionOutput = decisionCall.parsed || {};
      sent = decisionOutput.should_send === true && Boolean(decisionOutput.visible_reply);
      if (sent) actualSentToday++;
    }
    results.proactiveShadow.push({
      checkpointNo: i + 1,
      now: cp.now.toISOString(),
      sourceEventIndex: cp.eventIndex,
      afterKind: cp.afterKind,
      afterText: cp.afterText,
      visibleContext,
      sentTodayBefore: actualSentToday - (sent ? 1 : 0),
      seedCall: { ok: seedCall.ok, ms: seedCall.ms, error: seedCall.error, raw: seedCall.raw, model: seedModel, usage: seedCall.usage },
      seedOutput,
      decisionCall: decisionCall ? { ok: decisionCall.ok, ms: decisionCall.ms, error: decisionCall.error, raw: decisionCall.raw, model: seedModel, usage: decisionCall.usage } : null,
      decisionOutput,
      actualSent: sent,
      bracketExpressionRisk: bracketExpressionRisk(decisionOutput?.visible_reply || ""),
    });
    fs.writeFileSync(path.join(OUT_DIR, "results.partial.json"), JSON.stringify(results, null, 2), "utf8");
  }

  results.summary = summarize(results);
  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2), "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "readable-full-report.md"), renderReport(results), "utf8");
  console.log(`wrote ${OUT_DIR}`);
  console.log(JSON.stringify(results.summary, null, 2));
}

function summarize(results) {
  const cases = [...results.singles, ...results.segments.flatMap(s => s.cases)];
  const searchNeeded = cases.filter(c => c.analysis.searchNeeded);
  const webUsed = cases.filter(c => (c.analysis.webSearch + c.analysis.webFetch) > 0);
  const sceneStats = {
    total: cases.length,
    homeKeyword: cases.filter(c => c.analysis.scene.home_keyword).length,
    auditHome: cases.filter(c => c.analysis.scene.current_scene_is_home).length,
    outsideCurrentKeyword: cases.filter(c => c.analysis.scene.outside_current_keyword).length,
    workCurrentKeyword: cases.filter(c => c.analysis.scene.work_current_keyword).length,
    outsideOnlyBackstory: cases.filter(c => c.analysis.scene.outside_event_only_backstory).length,
    shortArcStarted: cases.filter(c => c.analysis.scene.short_arc_started || c.analysis.scene.short_arc_keyword).length,
  };
  const proactive = results.proactiveShadow;
  return {
    totalReplyCases: cases.length,
    realReplyCases: cases.filter(c => c.source === "real").length,
    syntheticReplyCases: cases.filter(c => c.source === "synthetic").length,
    sceneletOk: cases.filter(c => c.sceneCall.ok && c.scenelet.inner_scenelet).length,
    mainOk: cases.filter(c => c.mainCall.ok && c.reply?.visible_reply).length,
    sceneStats,
    search: {
      shouldSearchCases: searchNeeded.length,
      webUsedCases: webUsed.length,
      searchMisses: cases.filter(c => c.analysis.searchMiss).length,
      publicFactRiskNoSearch: cases.filter(c => c.analysis.publicFactRiskGuess).length,
      totalWebSearchRequests: cases.reduce((n, c) => n + c.analysis.webSearch, 0),
      totalWebFetchRequests: cases.reduce((n, c) => n + c.analysis.webFetch, 0),
    },
    expression: {
      bracketViolations: cases.filter(c => c.analysis.bracketExpressionRisk).length,
      proactiveBracketViolations: proactive.filter(p => p.bracketExpressionRisk).length,
    },
    proactive: {
      checkpoints: proactive.length,
      seedCreated: proactive.filter(p => p.seedOutput?.should_create === true).length,
      decisionSent: proactive.filter(p => p.actualSent).length,
      decisionCancelled: proactive.filter(p => p.seedOutput?.should_create === true && !p.actualSent).length,
      seedCancelled: proactive.filter(p => p.seedOutput?.should_create === false).length,
    },
    usage: summarizeUsage(cases, proactive),
  };
}

function summarizeUsage(cases, proactive) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, webSearch: 0, webFetch: 0, cost: 0 };
  const add = u => {
    if (!u) return;
    for (const k of Object.keys(total)) total[k] += Number(u[k]) || 0;
  };
  for (const c of cases) { add(c.sceneCall.usage); add(c.mainCall.usage); }
  for (const p of proactive) { add(p.seedCall?.usage); add(p.decisionCall?.usage); }
  return total;
}

function renderReport(results) {
  const cases = [...results.singles, ...results.segments.flatMap(s => s.cases)];
  const lines = [];
  lines.push("# Scene/Search/Expression/Arc Eval v2");
  lines.push("");
  lines.push(`生成时间：${results.manifest.createdAt}`);
  lines.push(`输出目录：${results.manifest.outDir}`);
  lines.push(`实验标签：${results.manifest.label}`);
  lines.push("");
  lines.push("## 调整方向");
  lines.push("");
  lines.push("- 弱化 home anchor：scenelet 优先停留在当前外部现场，而不是把工作、排练、通告写成回家后的回顾。");
  lines.push("- 强化 web search：书、歌、作者、艺人近况、截图/OCR 后续判断需要具体信息时必须搜索。");
  lines.push("- 方括号表情：visible reply 中出现短方括号表情计为 hard violation。");
  lines.push("- 短期连续事件：观察旅行、外景拍摄、连续通告等 1-3 天轻量 arc 是否能自然触发和延续。");
  lines.push("- proactive 上限：shadow 中按二次判断后的 actualSent 计数，不按 seed candidate 计数。");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(results.summary, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## Key Findings Draft");
  lines.push("");
  lines.push(...draftFindings(results).map(x => `- ${x}`));
  lines.push("");
  lines.push("## Search Misses");
  for (const c of cases.filter(c => c.analysis.searchMiss)) {
    lines.push("");
    lines.push(`### ${c.label}`);
    lines.push(`- Source: ${c.source}`);
    lines.push(`- User: ${oneLine(c.user, 800)}`);
    lines.push(`- Scene search_should_be_used: ${JSON.stringify(c.scenelet.eval_audit?.search_should_be_used)} ${oneLine(c.scenelet.eval_audit?.search_reason || "")}`);
    lines.push(`- Reply: ${oneLine(c.reply?.visible_reply || "", 1000)}`);
    lines.push(`- Audit: ${JSON.stringify(c.reply?.self_audit || {})}`);
  }
  lines.push("");
  lines.push("## Bracket Violations");
  for (const c of cases.filter(c => c.analysis.bracketExpressionRisk)) {
    lines.push("");
    lines.push(`### ${c.label}`);
    lines.push(`- Reply: ${oneLine(c.reply?.visible_reply || "", 1000)}`);
  }
  for (const p of results.proactiveShadow.filter(p => p.bracketExpressionRisk)) {
    lines.push("");
    lines.push(`### proactive checkpoint ${p.checkpointNo}`);
    lines.push(`- Reply: ${oneLine(p.decisionOutput?.visible_reply || "", 1000)}`);
  }
  lines.push("");
  lines.push("## Scene Richness Cases");
  for (const c of cases) {
    lines.push("");
    lines.push(`### ${c.label}`);
    lines.push(`- Source/Bucket: ${c.source} / ${c.bucket}`);
    lines.push(`- Tags: ${(c.evalTags || []).join(", ") || "none"}`);
    lines.push(`- User: ${oneLine(c.user, 1000)}`);
    lines.push(`- Scene Audit: ${JSON.stringify(c.scenelet.eval_audit || {})}`);
    lines.push(`- Scenelet: ${oneLine(c.scenelet.inner_scenelet, 1600)}`);
    lines.push(`- Reply: ${oneLine(c.reply?.visible_reply || "", 1200)}`);
    lines.push(`- Reply Audit: ${JSON.stringify(c.reply?.self_audit || {})}`);
    lines.push(`- Web usage: search=${c.analysis.webSearch}, fetch=${c.analysis.webFetch}, searchNeeded=${c.analysis.searchNeeded}`);
  }
  lines.push("");
  lines.push("## Continuous Segments");
  for (const seg of results.segments) {
    lines.push("");
    lines.push(`### Segment ${seg.segmentNo} (${seg.source})`);
    for (const c of seg.cases) {
      lines.push("");
      lines.push(`#### ${c.label}`);
      lines.push(`- User: ${oneLine(c.user, 800)}`);
      lines.push(`- Scene Audit: ${JSON.stringify(c.scenelet.eval_audit || {})}`);
      lines.push(`- Scenelet: ${oneLine(c.scenelet.inner_scenelet, 1400)}`);
      lines.push(`- Reply: ${oneLine(c.reply?.visible_reply || "", 1000)}`);
    }
  }
  lines.push("");
  lines.push("## Proactive Shadow");
  for (const p of results.proactiveShadow) {
    lines.push("");
    lines.push(`### Checkpoint ${p.checkpointNo} ${p.now}`);
    lines.push(`- After: ${oneLine(p.afterText, 800)}`);
    lines.push(`- Sent today before: ${p.sentTodayBefore}`);
    lines.push(`- Seed created: ${p.seedOutput?.should_create === true}`);
    lines.push(`- Actual sent after decision: ${p.actualSent}`);
    lines.push(`- Seed output: ${oneLine(JSON.stringify(p.seedOutput || {}), 1600)}`);
    lines.push(`- Decision output: ${oneLine(JSON.stringify(p.decisionOutput || {}), 1600)}`);
  }
  lines.push("");
  lines.push("完整机器可读数据见 results.json。");
  return lines.join("\n");
}

function draftFindings(results) {
  const s = results.summary;
  const findings = [];
  findings.push(`场景：home keyword ${s.sceneStats.homeKeyword}/${s.sceneStats.total}，outside-current keyword ${s.sceneStats.outsideCurrentKeyword}/${s.sceneStats.total}，work-current keyword ${s.sceneStats.workCurrentKeyword}/${s.sceneStats.total}。`);
  findings.push(`检索：需要搜索 ${s.search.shouldSearchCases} 条，未搜索 ${s.search.searchMisses} 条，总 WebSearch 请求 ${s.search.totalWebSearchRequests}。`);
  findings.push(`表达：reply 方括号违规 ${s.expression.bracketViolations} 条，proactive 方括号违规 ${s.expression.proactiveBracketViolations} 条。`);
  findings.push(`短期事件：short arc 命中/启动 ${s.sceneStats.shortArcStarted} 条。`);
  findings.push(`主动分享：seed created ${s.proactive.seedCreated}/${s.proactive.checkpoints}，二次判断实际发送 ${s.proactive.decisionSent} 条。`);
  return findings;
}

main().catch(err => {
  console.error(err?.stack || err);
  process.exit(1);
});
