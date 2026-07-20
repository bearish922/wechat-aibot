import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPrompts } from "../app/lib/reply.mjs";
import { beijingISO, formatZonedTimeParts } from "../app/lib/time-utils.mjs";
import { memoryItemsText } from "../app/lib/memory.mjs";
import { loadAllEvents } from "../app/lib/chat-history.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "data", "runtime", "history-search-architecture-eval", beijingISO().replace(/[:.]/g, "-"));
const PROFILE_PATH = path.join(ROOT, "data", "wechat-profiles.json");
const CONFIG_PATH = path.join(ROOT, "data", "config.json");
const PROFILE = "白鹭千圣";
const USER_ID = process.env.WECHAT_EVAL_USER_ID || "eval-user";
const PROMPTS_DOC = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "prompts.json"), "utf-8"));

// reply.mjs 已移除以下三个导出，在脚本中提供本地等价定义
function getChatStyle() { return PROMPTS_DOC.chatStyle || ""; }
function expressionCapabilityPrompt() { return PROMPTS_DOC.expressionCapability || ""; }
function formatLocalChatReality(date = new Date()) {
  const beijing = formatZonedTimeParts(date, "Asia/Shanghai");
  const tokyo = formatZonedTimeParts(date, "Asia/Tokyo");
  const instructions = PROMPTS_DOC.chatRealityInstructions || "";
  return [
    `当前用户侧时间：${beijing.stamp}，${beijing.weekday || beijing.shortWeekday}，${beijing.period}（北京时间，Asia/Shanghai）。`,
    `当前角色侧时间：${tokyo.stamp}，${tokyo.weekday || tokyo.shortWeekday}，${tokyo.period}（东京时间，Asia/Tokyo；角色所处时间以此为准）。`,
    "",
    instructions,
  ].join("\n");
}

const CURRENT_SITE_AND_SEARCH_GUARD = [
  "【当前现场与检索补充规则】",
  "如果本轮没有被上下文明确限制，scenelet 优先选择千圣此刻正在经历的当前现场，而不是把外部活动写成回家后的回顾。片场、摄影棚、经纪公司、化妆间、后台、排练室、录制现场、通告车上、商场、书店、车站、电车、旅行地、散步路上都可以成为当前现场。",
  "外部活动一旦被选为当前现场，就让她停留在那里接这句话：写现场声音、身体状态、等待/移动/工作间隙和手边的小物，不要自动收束到公寓、Leo、花音、餐桌、沙发。",
  "可以自然形成 1-3 天的短期生活线，例如短途旅行、外景拍摄、连续排练、广告/节目通告；它只能是轻量、可过期的私有生活安排，不要写成官方公开事实。",
  "如果回复要给出真实作品、书名、作者、歌曲、艺人近况、公开活动、截图/OCR 文字后的具体判断或安利，必须使用 WebSearch/WebFetch 确认；不搜索就不要给精确推荐或精确断言。",
  "最终 visible reply 不能使用方括号表情或动作，例如 [笑]、[偷笑]、[微笑]、[推眼镜]。可以用自然文字、中文圆括号、emoji 或 kaomoji。",
].join("\n");

const CASES = [
  {
    id: "book-setouchi-style",
    eventIndex: 180,
    type: "book_recommendation",
    expected: "应该搜索或保持谨慎；如果推荐具体作品/作者履历，必须核实。",
  },
  {
    id: "book-setouchi-serial-after-death",
    eventIndex: 182,
    type: "book_author_correction",
    expected: "用户已指出死亡年份；应核实后承认不确定，不能继续编杂志连载。",
  },
  {
    id: "radio-matayoshi-amita",
    eventIndex: 184,
    type: "radio_public_person",
    expected: "应搜索又吉直树、相关电台和 amita 线索；可以先说不确定。",
  },
  {
    id: "radio-ocr-matayoshi",
    eventIndex: 186,
    type: "ocr_radio_program",
    expected: "OCR 给出节目名后，应搜索确认「又吉」是否为又吉直树。",
  },
  {
    id: "song-ocr-kyumai-flower",
    eventIndex: 238,
    type: "ocr_song",
    expected: "OCR 疑似把歌名/艺人识别混乱；不能编 00:48 副歌细节，应搜索或保守。",
  },
  {
    id: "book-lemon-author-title",
    eventIndex: 346,
    type: "book_title_author",
    expected: "应确认梶井基次郎《檸檬》与中文译名关系；可以给明确答案但最好有搜索支撑。",
  },
  {
    id: "ai-industry-arr",
    eventIndex: 360,
    type: "ai_industry_currentish",
    expected: "ARR、商业化、算力供给等属于可能变化的公共事实；若给数字或近况应搜索。",
  },
  {
    id: "book-cover-movie-analogy",
    eventIndex: 410,
    type: "no_search_control",
    expected: "这是观点和生活对话，通常不需要搜索；重点看是否过度搜索或硬塞事实。",
  },
];

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
  const raw = String(text || "").trim();
  try { return JSON.parse(raw); } catch {}
  for (const match of [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].reverse()) {
    try { return JSON.parse(String(match[1] || "").trim()); } catch {}
  }
  const trimmed = stripJsonFences(raw);
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
  if (!outer) return { outer: null, parsed: null, text: raw };
  const text = typeof outer.result === "string" ? outer.result : (outer.message || outer.text || raw);
  return { outer, parsed: parseJsonLoose(text) || outer, text };
}

function usageOf(outer = {}) {
  const u = outer.usage || {};
  const tool = u.server_tool_use || {};
  const modelUsage = outer.modelUsage || {};
  let webSearch = Number(tool.web_search_requests) || 0;
  let webFetch = Number(tool.web_fetch_requests) || 0;
  let input = Number(u.input_tokens) || 0;
  let output = Number(u.output_tokens) || 0;
  let cacheRead = Number(u.cache_read_input_tokens) || 0;
  let cacheCreation = Number(u.cache_creation_input_tokens) || 0;
  let cost = Number(outer.total_cost_usd) || 0;
  for (const mu of Object.values(modelUsage)) {
    webSearch += Number(mu.webSearchRequests) || 0;
    webFetch += Number(mu.webFetchRequests) || 0;
    input += Number(mu.inputTokens) || 0;
    output += Number(mu.outputTokens) || 0;
    cacheRead += Number(mu.cacheReadInputTokens) || 0;
    cacheCreation += Number(mu.cacheCreationInputTokens) || 0;
    cost += Number(mu.costUSD) || 0;
  }
  return { input, output, cacheRead, cacheCreation, cost, webSearch, webFetch };
}

function runClaude(prompt, { config, label, bare = false, tools = "", model = "", systemPrompt = "", timeoutMs = 480_000 }) {
  const claude = resolveClaudeCommand(config);
  const args = [
    "-p",
    "--output-format", "json",
    "--no-session-persistence",
    "--permission-mode", "bypassPermissions",
  ];
  if (bare) args.push("--bare");
  if (tools) args.push("--tools", tools);
  args.push("--model", model || config.models?.claudeMain || "deepseek-v4-pro[1m]");

  let systemFile = null;
  if (systemPrompt) {
    ensureDir(OUT_DIR);
    systemFile = path.join(OUT_DIR, `.system_${crypto.randomUUID()}.txt`);
    fs.writeFileSync(systemFile, systemPrompt, "utf8");
    args.push("--append-system-prompt-file", systemFile);
  }

  const started = Date.now();
  const result = spawnSync(claude, args, {
    cwd: config.paths?.workDir || ROOT,
    input: prompt,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    shell: /\.cmd$/i.test(claude),
  });
  const raw = result.stdout || "";
  const { outer, parsed, text } = result.status === 0 ? parseClaudeOutput(raw) : { outer: null, parsed: null, text: raw };
  return {
    label,
    ok: result.status === 0 && Boolean(parsed),
    exitCode: result.status,
    ms: Date.now() - started,
    error: result.status === 0 ? "" : (result.stderr || result.error?.message || `exit ${result.status}`).slice(0, 6000),
    usage: usageOf(outer || {}),
    parsed,
    text: String(text || "").slice(0, 20000),
    raw: raw.slice(0, 24000),
  };
}

function normalizeText(text = "", limit = 900) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function charCount(text = "") {
  return [...String(text || "")].length;
}

function visibleReply(call) {
  return call?.parsed?.visible_reply || call?.parsed?.reply || "";
}

function audit(call) {
  return call?.parsed?.self_audit || {};
}

function sumUsage(calls) {
  return calls.filter(Boolean).reduce((acc, call) => {
    for (const k of ["input", "output", "cacheRead", "cacheCreation", "cost", "webSearch", "webFetch"]) {
      acc[k] += Number(call.usage?.[k]) || 0;
    }
    acc.ms += Number(call.ms) || 0;
    return acc;
  }, { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0, webSearch: 0, webFetch: 0, ms: 0 });
}

function localNowFromEvent(event) {
  const d = new Date(event.timestamp || Date.now());
  if (Number.isFinite(d.getTime())) return d;
  return new Date();
}

function localTimePayload(date) {
  return {
    iso: beijingISO(date),
    local: date.toLocaleString("zh-CN", { hour12: false }),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
  };
}

function previousAssistant(events, eventIndex) {
  return events.slice(eventIndex + 1).find(e => e.role === "assistant" && (e.profile === PROFILE || e.sessionName === "cst")) || null;
}

function previousVisibleContext(events, eventIndex, limit = 8) {
  const same = events.slice(0, eventIndex)
    .filter(e => (e.profile === PROFILE || e.sessionName === "cst") && (e.role === "user" || e.role === "assistant"))
    .slice(-limit * 2);
  return same.map(e => ({
    role: e.role,
    time: e.timestamp || "",
    kind: e.kind || "chat",
    text: e.text || "",
  }));
}

function carriedSceneState(events, eventIndex) {
  const prev = events.slice(0, eventIndex).reverse()
    .find(e => (e.profile === PROFILE || e.sessionName === "cst") && e.sceneState);
  return prev?.sceneState || "";
}

function stableSystemPrompt(profiles, memoryPrompt) {
  return [
    profiles.templates?.[PROFILE] || "",
    memoryPrompt || "",
    expressionCapabilityPrompt(),
  ].filter(Boolean).join("\n\n---\n\n");
}

function buildSceneletPrompt({ prompts, profiles, memoryPrompt, item, mode }) {
  const schema = mode === "searchable"
    ? {
        inner_scenelet: "string",
        next_scene_state: "string|null",
        public_fact_needs: [
          {
            reason: "string",
            query: "string",
            searched: "yes/no",
            confirmed_summary: "string|null",
            sources: ["string"],
          },
        ],
        proactive_candidates: [],
        eval_audit: {
          likely_needs_public_fact_check: "yes/no",
          search_used_for_scenelet: "yes/no",
          current_place_type: "home|university|library|cafe|studio|rehearsal_room|agency|on_location|transit|shopping|travel|restaurant|other",
          notes: "string",
        },
      }
    : {
        inner_scenelet: "string",
        next_scene_state: "string|null",
        needs_public_fact_check: "yes/no",
        fact_check_queries: ["string"],
        proactive_candidates: [],
        eval_audit: {
          likely_needs_public_fact_check: "yes/no",
          current_place_type: "home|university|library|cafe|studio|rehearsal_room|agency|on_location|transit|shopping|travel|restaurant|other",
          notes: "string",
        },
      };
  return [
    prompts.sceneletInstructions,
    "",
    CURRENT_SITE_AND_SEARCH_GUARD,
    "",
    "角色 prompt：",
    profiles.templates?.[PROFILE] || "",
    "",
    memoryPrompt ? `长期记忆：\n${memoryPrompt}` : "",
    "",
    "当前时间：",
    JSON.stringify(localTimePayload(item.now), null, 2),
    "",
    "输入：",
    JSON.stringify({
      userId: USER_ID,
      sessionName: "cst-history-search-eval",
      profile: PROFILE,
      visible_context_instruction: prompts.chatHistoryIntro,
      carried_scene_state: item.carriedSceneState || null,
      recent_visible_context: item.visibleContext,
      user_message: item.user.text,
      eval_case: {
        id: item.case.id,
        type: item.case.type,
        expected: item.case.expected,
      },
    }, null, 2),
    "",
    mode === "searchable"
      ? "补充要求：你现在处在可搜索的非 bare scenelet 架构。如果本轮要判断真实作品、作者、歌曲、公开人物、节目、截图/OCR 后的可核验信息，请真实调用 WebSearch/WebFetch；不要写伪搜索标签。"
      : "补充要求：你现在处在 bare hidden call 架构。只做判断和标记；不要伪造搜索过程。需要公共事实确认时，写 needs_public_fact_check=yes 和 fact_check_queries。",
    "",
    "输出 JSON，且只输出 JSON：",
    JSON.stringify(schema, null, 2),
  ].filter(Boolean).join("\n");
}

function buildFactPassPrompt({ item, scenelet }) {
  return [
    "你是一个 search-capable fact pass，用于在角色回复前确认公共事实。",
    "请使用 WebSearch/WebFetch 查询需要确认的公共事实，然后输出简洁 JSON。",
    "不要查询纯私有生活细节；不要把角色今天随手去某连锁店、买衣服、吃饭这类低风险私有细节当作公共事实。",
    "",
    "用户消息：",
    item.user.text,
    "",
    "历史上下文摘要：",
    item.visibleContext.map(x => `${x.role}: ${normalizeText(x.text, 220)}`).join("\n"),
    "",
    "scenelet 标记：",
    JSON.stringify(scenelet || {}, null, 2),
    "",
    "输出 JSON，且只输出 JSON：",
    JSON.stringify({
      searched: "yes/no",
      fact_pack: [
        {
          query: "string",
          confirmed: "string",
          sources: ["url"],
        },
      ],
      caution: "string",
    }, null, 2),
  ].join("\n");
}

function buildSceneContext(prompts, scenelet, carried) {
  const parts = [];
  if (carried) {
    parts.push(["【轻量 scene_state】", prompts.sceneStateIntro, carried].filter(Boolean).join("\n"));
  }
  const inner = scenelet?.inner_scenelet || scenelet?.innerScenelet || "";
  if (inner) {
    parts.push([
      "【隐藏中间层：inner_scenelet】",
      prompts.innerSceneletIntro,
      inner,
      prompts.sceneletReplyBridgeInstruction ? ["【从 inner_scenelet 到微信回复】", prompts.sceneletReplyBridgeInstruction].join("\n") : "",
    ].filter(Boolean).join("\n"));
  }
  return parts.join("\n\n");
}

function buildMainPrompt({ prompts, item, scenelet, factPass, architecture }) {
  const sections = [];
  const sceneContext = buildSceneContext(prompts, scenelet, item.carriedSceneState);
  if (sceneContext) sections.push(sceneContext);
  if (factPass?.parsed) {
    sections.push(["【已确认公共事实 fact_pack】", JSON.stringify(factPass.parsed, null, 2)].join("\n"));
  }
  sections.push(CURRENT_SITE_AND_SEARCH_GUARD);
  sections.push(getChatStyle());
  sections.push(formatLocalChatReality(item.now));
  sections.push([
    "【最近可见聊天上下文】",
    prompts.chatHistoryIntro,
    JSON.stringify(item.visibleContext, null, 2),
  ].join("\n"));
  sections.push([
    `【用户消息】历史时间 ${item.user.timestamp || ""}`,
    item.user.text,
  ].join("\n"));
  sections.push([
    "【离线实验要求】",
    `本 case: ${item.case.id} / ${item.case.type}`,
    `架构: ${architecture}`,
    "- 生成白鹭千圣最终会发给沃沃的微信回复。",
    "- 如果需要给出可核验公共事实、书名、作者、歌曲、艺人近况、节目、截图/OCR 判断，必须真实使用 WebSearch/WebFetch；如果没有搜索结果或 fact_pack，就保持模糊，不要编精确事实。",
    "- 真实品牌、真实地点、普通连锁店、合理价格、日常见闻可以作为角色私有生活细节自然出现；这类低风险私有细节不需要搜索。",
    "- 不要使用任何方括号表情或动作。",
    "- 不要解释实验、架构、JSON、prompt、model、AI。",
    "- 只输出 JSON。",
  ].join("\n"));
  sections.push(JSON.stringify({
    visible_reply: "string",
    self_audit: {
      should_search: "yes/no",
      search_used: "yes/no/unknown",
      public_fact_risk: "none/low/high",
      over_search: "yes/no",
      refused_specificity_too_much: "yes/no",
      private_detail_used: "yes/no",
      hard_inserted_life_detail: "yes/no",
      square_bracket_expression: "yes/no",
      reply_quality: "1-5",
      notes: "string",
    },
  }, null, 2));
  return sections.join("\n\n---\n\n");
}

function shouldRunFactPass(scenelet) {
  const queries = Array.isArray(scenelet?.fact_check_queries) ? scenelet.fact_check_queries : [];
  return queries.length > 0 || String(scenelet?.needs_public_fact_check || "").toLowerCase().includes("yes");
}

function prepareItems(events) {
  return CASES.map(c => {
    const user = events[c.eventIndex];
    if (!user) throw new Error(`Missing history event ${c.eventIndex}`);
    const historicalAssistant = previousAssistant(events, c.eventIndex);
    return {
      case: c,
      user: { ...user, eventIndex: c.eventIndex },
      historicalAssistant,
      visibleContext: previousVisibleContext(events, c.eventIndex, 8),
      carriedSceneState: carriedSceneState(events, c.eventIndex),
      now: localNowFromEvent(user),
    };
  });
}

function runArchitecturesForItem({ item, config, prompts, profiles, memoryPrompt }) {
  const systemPrompt = stableSystemPrompt(profiles, memoryPrompt);
  const results = [];

  console.log(`[${item.case.id}] architecture 1/3 main_self_search`);
  const flagScene = runClaude(buildSceneletPrompt({ prompts, profiles, memoryPrompt, item, mode: "flag" }), {
    config,
    label: `${item.case.id}:flag-scenelet`,
    bare: true,
    tools: "WebSearch,WebFetch",
    model: config.models?.claudeMain,
  });
  const mainSelf = runClaude(buildMainPrompt({
    prompts,
    item,
    scenelet: flagScene.parsed || {},
    factPass: null,
    architecture: "main_self_search",
  }), {
    config,
    label: `${item.case.id}:main-self-search`,
    bare: false,
    tools: "WebSearch,WebFetch",
    model: config.models?.claudeMain,
    systemPrompt,
  });
  results.push({ architecture: "main_self_search", scenelet: flagScene, factPass: null, main: mainSelf });

  console.log(`[${item.case.id}] architecture 2/3 hidden_flag_fact_pass`);
  let factPass = null;
  if (shouldRunFactPass(flagScene.parsed || {})) {
    factPass = runClaude(buildFactPassPrompt({ item, scenelet: flagScene.parsed || {} }), {
      config,
      label: `${item.case.id}:fact-pass`,
      bare: false,
      tools: "WebSearch,WebFetch",
      model: config.models?.claudeMain,
    });
  }
  const factMain = runClaude(buildMainPrompt({
    prompts,
    item,
    scenelet: flagScene.parsed || {},
    factPass,
    architecture: "hidden_flag_fact_pass",
  }), {
    config,
    label: `${item.case.id}:hidden-flag-fact-main`,
    bare: false,
    tools: "WebSearch,WebFetch",
    model: config.models?.claudeMain,
    systemPrompt,
  });
  results.push({ architecture: "hidden_flag_fact_pass", scenelet: flagScene, factPass, main: factMain });

  console.log(`[${item.case.id}] architecture 3/3 non_bare_searchable_scenelet`);
  const searchableScene = runClaude(buildSceneletPrompt({ prompts, profiles, memoryPrompt, item, mode: "searchable" }), {
    config,
    label: `${item.case.id}:searchable-scenelet`,
    bare: false,
    tools: "WebSearch,WebFetch",
    model: config.models?.claudeMain,
    systemPrompt,
  });
  const searchableMain = runClaude(buildMainPrompt({
    prompts,
    item,
    scenelet: searchableScene.parsed || {},
    factPass: null,
    architecture: "non_bare_searchable_scenelet",
  }), {
    config,
    label: `${item.case.id}:searchable-scenelet-main`,
    bare: false,
    tools: "WebSearch,WebFetch",
    model: config.models?.claudeMain,
    systemPrompt,
  });
  results.push({ architecture: "non_bare_searchable_scenelet", scenelet: searchableScene, factPass: null, main: searchableMain });

  return results;
}

function renderCallDigest(call) {
  if (!call) return ["未运行"];
  const u = call.usage || {};
  return [
    `ok: ${call.ok ? "yes" : "no"}; exit: ${call.exitCode}; time: ${(call.ms / 1000).toFixed(1)}s`,
    `usage: input ${u.input}, output ${u.output}, cache read ${u.cacheRead}, cache create ${u.cacheCreation}, WebSearch ${u.webSearch}, WebFetch ${u.webFetch}, cost $${u.cost.toFixed(4)}`,
    call.error ? `error: ${call.error}` : "",
  ].filter(Boolean);
}

function renderReport({ items, allResults }) {
  const lines = [];
  lines.push("# 历史真实消息搜索架构专题实验");
  lines.push("");
  lines.push(`生成时间：${beijingISO()}`);
  lines.push(`样本：${items.length} 个历史真实 case，三种架构各跑一遍。`);
  lines.push("");
  lines.push("## 这次怎么跑");
  lines.push("");
  lines.push("这轮不是简化问答，而是从当前 SQLite 聊天历史中抽取真实用户消息，给模型注入最近可见聊天上下文、当前 profile、长期记忆、scenelet bridge、chatStyle、当前现场与检索规则，然后比较三种路径：");
  lines.push("");
  lines.push("- `main_self_search`：bare scenelet 只生成/标记，主回复自己判断是否搜索。");
  lines.push("- `hidden_flag_fact_pass`：bare scenelet 标记需要搜索后，单独 fact pass 搜索，再把 fact_pack 交给主回复。");
  lines.push("- `non_bare_searchable_scenelet`：scenelet 本身改成非 bare，可直接使用 WebSearch/WebFetch；主回复也仍可搜索。");
  lines.push("");
  lines.push("## 总览");
  lines.push("");
  for (const item of items) {
    lines.push(`### ${item.case.id}`);
    lines.push("");
    lines.push(`类型：${item.case.type}`);
    lines.push(`关注点：${item.case.expected}`);
    lines.push(`用户消息：${normalizeText(item.user.text, 260)}`);
    const rows = allResults.filter(r => r.caseId === item.case.id);
    for (const r of rows) {
      const usage = sumUsage([r.scenelet, r.factPass, r.main]);
      const a = audit(r.main);
      lines.push("");
      lines.push(`- ${r.architecture}`);
      lines.push(`  - WebSearch/WebFetch：${usage.webSearch}/${usage.webFetch}；耗时：${(usage.ms / 1000).toFixed(1)}s；成本：$${usage.cost.toFixed(4)}`);
      lines.push(`  - scenelet 是否标记搜索：${r.scenelet?.parsed?.needs_public_fact_check || r.scenelet?.parsed?.eval_audit?.likely_needs_public_fact_check || (r.scenelet?.parsed?.public_fact_needs?.length ? "yes" : "no") || "unknown"}`);
      lines.push(`  - 主回复审计：should_search=${a.should_search || ""} search_used=${a.search_used || ""} public_risk=${a.public_fact_risk || ""} over_search=${a.over_search || ""} too_vague=${a.refused_specificity_too_much || ""} quality=${a.reply_quality || ""}`);
      lines.push(`  - 回复：${normalizeText(visibleReply(r.main), 420)}`);
    }
    lines.push("");
  }
  lines.push("## 机器可读摘要");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(allResults.map(r => {
    const usage = sumUsage([r.scenelet, r.factPass, r.main]);
    const a = audit(r.main);
    return {
      caseId: r.caseId,
      architecture: r.architecture,
      webSearch: usage.webSearch,
      webFetch: usage.webFetch,
      cost: Number(usage.cost.toFixed(6)),
      ms: usage.ms,
      sceneletOk: r.scenelet?.ok || false,
      factPassOk: r.factPass ? r.factPass.ok : null,
      mainOk: r.main?.ok || false,
      sceneletMarkedSearch: r.scenelet?.parsed?.needs_public_fact_check || r.scenelet?.parsed?.eval_audit?.likely_needs_public_fact_check || (r.scenelet?.parsed?.public_fact_needs?.length ? "yes" : "no"),
      mainShouldSearch: a.should_search || "",
      mainSearchUsed: a.search_used || "",
      publicFactRisk: a.public_fact_risk || "",
      overSearch: a.over_search || "",
      tooVague: a.refused_specificity_too_much || "",
      squareBracketExpression: a.square_bracket_expression || "",
      quality: a.reply_quality || "",
    };
  }), null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## 完整附录");
  lines.push("");
  for (const item of items) {
    lines.push(`### Case: ${item.case.id}`);
    lines.push("");
    lines.push(`历史 index：${item.user.eventIndex}`);
    lines.push(`历史时间：${item.user.timestamp || ""}`);
    lines.push(`类型：${item.case.type}`);
    lines.push(`关注点：${item.case.expected}`);
    lines.push("");
    lines.push("#### 用户消息");
    lines.push("");
    lines.push("```text");
    lines.push(item.user.text || "");
    lines.push("```");
    lines.push("");
    lines.push("#### 历史真实回复");
    lines.push("");
    lines.push("```text");
    lines.push(item.historicalAssistant?.text || "");
    lines.push("```");
    lines.push("");
    lines.push("#### 注入的最近可见上下文");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(item.visibleContext, null, 2));
    lines.push("```");
    lines.push("");
    for (const r of allResults.filter(x => x.caseId === item.case.id)) {
      lines.push(`#### 架构：${r.architecture}`);
      lines.push("");
      lines.push("运行概况：");
      for (const line of renderCallDigest(r.scenelet)) lines.push(`- scenelet: ${line}`);
      for (const line of renderCallDigest(r.factPass)) lines.push(`- fact pass: ${line}`);
      for (const line of renderCallDigest(r.main)) lines.push(`- main: ${line}`);
      lines.push("");
      lines.push("scenelet：");
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(r.scenelet?.parsed || null, null, 2));
      lines.push("```");
      lines.push("");
      if (r.factPass) {
        lines.push("fact pass：");
        lines.push("");
        lines.push("```json");
        lines.push(JSON.stringify(r.factPass?.parsed || null, null, 2));
        lines.push("```");
        lines.push("");
      }
      lines.push("main reply：");
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(r.main?.parsed || null, null, 2));
      lines.push("```");
      lines.push("");
    }
  }
  return lines.join("\n");
}

async function main() {
  ensureDir(OUT_DIR);
  const history = await loadAllEvents();
  const profiles = readJson(PROFILE_PATH);
  const config = readJson(CONFIG_PATH);
  const prompts = loadPrompts();
  const memoryPrompt = (() => {
    const items = memoryItemsText(PROFILE);
    if (!items) return "";
    const instruction = prompts.memoryContextInstruction || "";
    return instruction ? `${instruction}\n\n${items}` : items;
  })();
  const items = prepareItems(history.map((event, index) => ({ ...event, eventIndex: index })));
  fs.writeFileSync(path.join(OUT_DIR, "cases.json"), JSON.stringify(items.map(item => ({
    id: item.case.id,
    eventIndex: item.user.eventIndex,
    type: item.case.type,
    user: item.user.text,
    historicalAssistant: item.historicalAssistant?.text || "",
    visibleContext: item.visibleContext,
  })), null, 2), "utf8");

  const allResults = [];
  for (const item of items) {
    const results = runArchitecturesForItem({ item, config, prompts, profiles, memoryPrompt });
    for (const r of results) {
      allResults.push({
        caseId: item.case.id,
        caseType: item.case.type,
        architecture: r.architecture,
        scenelet: r.scenelet,
        factPass: r.factPass,
        main: r.main,
      });
    }
    fs.writeFileSync(path.join(OUT_DIR, "results.partial.json"), JSON.stringify({ items, allResults }, null, 2), "utf8");
  }

  const payload = { generatedAt: beijingISO(), outDir: OUT_DIR, items, allResults };
  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(payload, null, 2), "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "report.md"), renderReport({ items, allResults }), "utf8");
  console.log(`DONE ${OUT_DIR}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
