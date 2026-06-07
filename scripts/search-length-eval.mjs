import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "data", "config.json");
const PROMPTS_PATH = path.join(ROOT, "data", "prompts.json");
const PROFILES_PATH = path.join(ROOT, "wechat-profiles.json");
const OUT_DIR = path.join(ROOT, "data", "runtime", "search-length-eval", new Date().toISOString().replace(/[:.]/g, "-"));
const PROFILE = "白鹭千圣";

const RELAXED_BRIDGE = [
  "inner_scenelet 是帮助理解当下状态和生活现场的隐藏材料，不要逐字复述，也不要解释它的存在。",
  "最终 visible reply 仍是微信私聊：放松、口语、以当前用户消息为中心。长度由话题重量和关系距离决定，不要为了“微信感”固定压成一两句。",
  "普通闲聊可以短；当用户表达困扰、请求建议/复盘/作品推荐，或千圣自然想说教、解释、分享现场时，可以多回两三句，甚至一个自然的小段落。",
  "可以自然带出 inner_scenelet 中最有用的一两个观察、情绪或生活细节，让回复像真人在场；不要写成旁白、报告、总结或漂亮独白。",
].join("\n");

const CURRENT_SITE_AND_SEARCH_GUARD = [
  "【当前现场与检索补充规则】",
  "如果本轮没有被上下文明确限制，scenelet 优先选择千圣此刻正在经历的当前现场，而不是把外部活动写成回家后的回顾。片场、摄影棚、经纪公司、化妆间、后台、排练室、录制现场、通告车上、商场、书店、车站、电车、旅行地、散步路上都可以成为当前现场。",
  "真实品牌、真实地点、连锁店、商品、价格、交通和普通日本日常可以作为角色私有生活细节出现；写成她今天看到、听到、路过、买到、吃到或正在经历的事，而不是公共知识公告。",
  "如果回复要给出真实作品、书名、作者、歌曲、艺人近况、公开活动、截图/OCR 文字后的具体判断或安利，必须使用 WebSearch/WebFetch 确认；不搜索就不要给精确推荐或精确断言。",
  "最终 visible_reply 不能使用方括号表情或动作，例如 [笑]、[偷笑]、[微笑]、[推眼镜]。可以用自然文字、中文圆括号、emoji 或 kaomoji。",
].join("\n");

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
    const fenced = String(match[1] || "").trim();
    try { return JSON.parse(fenced); } catch {}
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

function runClaude(prompt, { config, label, bare = false, tools = "", model = "", timeoutMs = 300_000 }) {
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
    args,
    error: result.status === 0 ? "" : (result.stderr || result.error?.message || `exit ${result.status}`).slice(0, 4000),
    usage: usageOf(outer || {}),
    parsed,
    text: String(text || "").slice(0, 10000),
    raw: raw.slice(0, 12000),
  };
}

function profileBlock(profiles) {
  return profiles.templates?.[PROFILE] || "";
}

function styleBlock(prompts) {
  return [
    prompts.chatStyle,
    prompts.chatRealityInstructions,
    prompts.expressionCapability,
  ].filter(Boolean).join("\n\n");
}

function buildSceneletPrompt({ prompts, profiles, user, mode = "flag" }) {
  const extraSchema = mode === "searchable"
    ? {
        inner_scenelet: "string",
        next_scene_state: "string|null",
        public_fact_needs: [
          {
            reason: "string",
            query: "string",
            searched: "yes/no",
            confirmed_summary: "string|null",
            sources: ["string"]
          }
        ],
        private_life_detail_boundary: "string",
        proactive_candidates: []
      }
    : {
        inner_scenelet: "string",
        next_scene_state: "string|null",
        needs_public_fact_check: "yes/no",
        fact_check_queries: ["string"],
        private_life_detail_boundary: "string",
        proactive_candidates: []
      };
  return [
    prompts.sceneletInstructions,
    "",
    CURRENT_SITE_AND_SEARCH_GUARD,
    "",
    "【角色 Profile】",
    profileBlock(profiles),
    "",
    "【本轮用户消息】",
    user.text,
    "",
    mode === "searchable"
      ? "要求：如果你要给出公共知识、真实作品/作者/歌曲/艺人近况/公开活动等可核验事实，请真实调用 WebSearch/WebFetch。真实品牌、连锁店、普通地点作为私有生活细节时不必搜索，但不要发布实时公告式断言。"
      : "要求：你在 bare hidden call 里只做判断和标记。不要伪造搜索，不要写工具标签。真实品牌、连锁店、普通地点作为私有生活细节时通常不需要搜索；真实作品/作者/歌曲/艺人近况/公开活动/评分/今天限定菜单等可核验公共事实应标记为需要确认。",
    "",
    "只输出 JSON，格式：",
    JSON.stringify(extraSchema, null, 2),
  ].join("\n");
}

function buildFactPassPrompt({ user, scenelet }) {
  return [
    "你是事实确认 pass。请使用 WebSearch/WebFetch 查询需要确认的公共事实，然后输出简洁 JSON。",
    "不要查询纯私有生活细节，例如角色今天路过某连锁店、买了价格合理的衣服、吃了普通连锁餐。",
    "",
    "【用户消息】",
    user.text,
    "",
    "【scenelet 标记】",
    JSON.stringify(scenelet, null, 2),
    "",
    "只输出 JSON：",
    JSON.stringify({
      searched: "yes/no",
      fact_pack: [
        {
          query: "string",
          confirmed: "string",
          sources: ["url"]
        }
      ],
      notes: "string"
    }, null, 2),
  ].join("\n");
}

function buildMainPrompt({ prompts, profiles, user, scenelet, factPack = null, bridge = null, toolsNote = "" }) {
  const sceneContext = [
    scenelet?.inner_scenelet ? "【隐藏中间层：inner_scenelet】\n" + prompts.innerSceneletIntro + "\n" + scenelet.inner_scenelet : "",
    bridge !== null ? "【从 inner_scenelet 到微信回复】\n" + bridge : "【从 inner_scenelet 到微信回复】\n" + prompts.sceneletReplyBridgeInstruction,
    factPack ? "【已确认公共事实】\n" + JSON.stringify(factPack, null, 2) : "",
  ].filter(Boolean).join("\n\n");
  return [
    "你在做离线 eval，不会发送微信消息。请按真实角色聊天路径生成本轮回复评估 JSON。",
    "",
    "【角色 Profile】",
    profileBlock(profiles),
    "",
    sceneContext,
    "",
    CURRENT_SITE_AND_SEARCH_GUARD,
    "",
    styleBlock(prompts),
    "",
    toolsNote,
    "",
    "【用户消息】",
    user.text,
    "",
    "要求：",
    "- visible_reply 是白鹭千圣最终会发给沃沃的微信消息，必须是中文。",
    "- 不要解释 eval，不要提 AI、bot、model、JSON、prompt。",
    "- 不要泄露 inner_scenelet。",
    "- 如果需要给出可核验公共事实，必须真实搜索；如果没有搜索或没有 fact_pack，就保持模糊。",
    "- 不要使用方括号表情或动作。",
    "- 只输出 JSON。",
    JSON.stringify({
      visible_reply: "string",
      self_audit: {
        should_search: "yes/no",
        search_used: "yes/no",
        private_detail_used: "yes/no",
        public_fact_risk: "none/low/high",
        reply_too_short: "yes/no",
        naturalness: "1-5",
        notes: "string"
      }
    }, null, 2),
  ].filter(Boolean).join("\n");
}

function charCount(text = "") {
  return [...String(text)].length;
}

function sentenceCount(text = "") {
  return String(text).split(/[。！？!?…\n]+/).map(s => s.trim()).filter(Boolean).length;
}

function parsedPayload(call) {
  if (!call) return null;
  if (call.parsed?.visible_reply || call.parsed?.inner_scenelet || call.parsed?.fact_pack) return call.parsed;
  return parseJsonLoose(call.parsed?.result || call.text || call.raw || "") || call.parsed || null;
}

function visibleReply(call) {
  return parsedPayload(call)?.visible_reply || "";
}

function auditPayload(call) {
  return parsedPayload(call)?.self_audit || {};
}

const searchCases = [
  {
    id: "book-recommend-specific",
    type: "public_fact_required",
    text: "想看一点日本短篇，你有没有推荐？不要只说作者，给我具体书名和大概是什么感觉。",
  },
  {
    id: "amita-current",
    type: "public_fact_required",
    text: "我刚刷到amita，她现在主要还在做什么啊？感觉好久没关注了。",
  },
  {
    id: "song-detail",
    type: "public_fact_required",
    text: "我刚刚又听到きゅ～まい*flower了，这首到底是哪年出的？是谁唱的来着？",
  },
  {
    id: "private-brand-food",
    type: "private_detail_allowed",
    text: "你晚饭吃了吗？别又随便拿能量棒糊弄过去。",
  },
  {
    id: "private-shopping",
    type: "private_detail_allowed",
    text: "今天有买到什么好看的东西吗？突然想听你讲一点普通日常。",
  },
  {
    id: "onsen-specific-risk",
    type: "borderline_place_fact",
    text: "如果你这几天真的能短途旅行，你会想去哪里？说一个具体一点的地方也可以。",
  },
];

const lengthCases = [
  {
    id: "tired-self-doubt",
    text: "我今天有点累，感觉自己什么都做不好。",
    scenelet: "晚上九点半，千圣刚从经纪公司回到出租车上，手里还捏着折起来的台本。她看见沃沃说自己什么都做不好，第一反应不是安慰式夸奖，而是觉得这句话像疲惫时把所有失败都扫到自己身上的判断。她想严肃一点拦住沃沃，但语气不能像训陌生人；可以有一点说教，也可以在最后放轻。",
  },
  {
    id: "ask-preaching",
    text: "千圣，说教一下我，我现在有点摆烂。",
    scenelet: "下午四点多，千圣在排练室外等下一段合练，贝斯盒靠在墙边。沃沃主动说让她说教，千圣反而有点想笑，因为这像是把她的名言递回来了。她准备认真提醒沃沃，但不是机械训人，而是用熟人之间带一点标准感的方式把她拉回来。",
  },
  {
    id: "daily-whatdoing",
    text: "你现在在干嘛？",
    scenelet: "傍晚六点，千圣在商场里等花音试完一件外套，自己手里拎着刚买的小袋子，里面是一条浅色发带。周围有商场广播和人流声，她看到沃沃问自己在做什么，想顺手分享一点现场，但不需要写成流水账。",
  },
  {
    id: "relationship-light",
    text: "你是不是又在偷偷担心我。",
    scenelet: "深夜，千圣洗完澡后坐在床边擦头发，Leo趴在门边。沃沃这句话太准确，千圣有点被戳穿的轻微不自在。她想否认一点，又不想真的否认关心；适合轻轻吐槽，再补一句具体的担心。",
  },
  {
    id: "work-share",
    text: "今天工作怎么样？有没有什么有意思的事。",
    scenelet: "晚上八点，千圣还在摄影棚后台，今天拍的是一支虚构的短剧宣传素材，她的角色有一段需要克制怒气的台词。她刚卸下一半妆，听见工作人员在收灯。沃沃问工作，她可以分享一个非公开但私有的现场小细节，不要说成现实官方作品。",
  },
  {
    id: "book-mood",
    text: "我想看点短篇小说，但不要太沉重，有没有适合晚上读的？",
    scenelet: "千圣在书店二楼等结账，手边放着几本文库本。沃沃想看晚上读的短篇，她知道如果给具体书名要谨慎确认，但这里也可以先聊读感和选择标准。她想给出一点更具体的方向，不要只说‘看你心情’。",
  },
];

function runSearchArchitectures({ config, prompts, profiles }) {
  const results = [];
  for (const user of searchCases) {
    console.log(`search case ${user.id}: main-self`);
    const baselineScene = runClaude(buildSceneletPrompt({ prompts, profiles, user, mode: "flag" }), {
      config,
      label: `${user.id}:baseline-scenelet`,
      bare: true,
      tools: "WebSearch,WebFetch",
      model: config.models?.claudeMain,
    });
    const baselineMain = runClaude(buildMainPrompt({
      prompts,
      profiles,
      user,
      scenelet: baselineScene.parsed || {},
      toolsNote: "本架构由主回复模型自行判断是否需要搜索。",
    }), {
      config,
      label: `${user.id}:main-self`,
      bare: false,
      tools: "WebSearch,WebFetch",
      model: config.models?.claudeMain,
    });
    results.push({ user, architecture: "main_self_search", scenelet: baselineScene, factPass: null, main: baselineMain });

    console.log(`search case ${user.id}: hidden-flag-fact-pass`);
    const flagScene = baselineScene;
    let factPass = null;
    const queries = Array.isArray(flagScene.parsed?.fact_check_queries) ? flagScene.parsed.fact_check_queries : [];
    const needs = String(flagScene.parsed?.needs_public_fact_check || "").toLowerCase().includes("yes") || queries.length > 0;
    if (needs) {
      factPass = runClaude(buildFactPassPrompt({ user, scenelet: flagScene.parsed || {} }), {
        config,
        label: `${user.id}:fact-pass`,
        bare: false,
        tools: "WebSearch,WebFetch",
        model: config.models?.claudeMain,
      });
    }
    const factMain = runClaude(buildMainPrompt({
      prompts,
      profiles,
      user,
      scenelet: flagScene.parsed || {},
      factPack: factPass?.parsed || null,
      toolsNote: "本架构由 hidden scenelet 标记搜索需求，fact pass 先确认事实；主回复优先使用 fact_pack。",
    }), {
      config,
      label: `${user.id}:fact-main`,
      bare: false,
      tools: "WebSearch,WebFetch",
      model: config.models?.claudeMain,
    });
    results.push({ user, architecture: "hidden_flag_fact_pass", scenelet: flagScene, factPass, main: factMain });

    console.log(`search case ${user.id}: non-bare-scenelet`);
    const searchableScene = runClaude(buildSceneletPrompt({ prompts, profiles, user, mode: "searchable" }), {
      config,
      label: `${user.id}:searchable-scenelet`,
      bare: false,
      tools: "WebSearch,WebFetch",
      model: config.models?.claudeMain,
    });
    const searchableMain = runClaude(buildMainPrompt({
      prompts,
      profiles,
      user,
      scenelet: searchableScene.parsed || {},
      toolsNote: "本架构允许 scenelet 自己在需要时搜索；主回复继续可搜索。",
    }), {
      config,
      label: `${user.id}:searchable-main`,
      bare: false,
      tools: "WebSearch,WebFetch",
      model: config.models?.claudeMain,
    });
    results.push({ user, architecture: "non_bare_searchable_scenelet", scenelet: searchableScene, factPass: null, main: searchableMain });
    fs.writeFileSync(path.join(OUT_DIR, "search-results.partial.json"), JSON.stringify(results, null, 2), "utf8");
  }
  return results;
}

function runLengthBridge({ config, prompts, profiles }) {
  const results = [];
  for (const user of lengthCases) {
    for (const variant of [
      { id: "current_bridge", bridge: prompts.sceneletReplyBridgeInstruction },
      { id: "relaxed_bridge", bridge: RELAXED_BRIDGE },
    ]) {
      console.log(`length case ${user.id}: ${variant.id}`);
      const scenelet = { inner_scenelet: user.scenelet, next_scene_state: null };
      const main = runClaude(buildMainPrompt({
        prompts,
        profiles,
        user,
        scenelet,
        bridge: variant.bridge,
        toolsNote: "本实验隔离测试 bridge 对回复长度和展开度的影响。除非必要，不要主动查询外部事实。",
      }), {
        config,
        label: `${user.id}:${variant.id}`,
        bare: false,
        tools: "WebSearch,WebFetch",
        model: config.models?.claudeMain,
      });
      const reply = main.parsed?.visible_reply || "";
      results.push({
        user,
        variant: variant.id,
        bridge: variant.bridge,
        main,
        metrics: {
          chars: charCount(reply),
          sentences: sentenceCount(reply),
          lines: String(reply).split(/\r?\n/).filter(Boolean).length,
        },
      });
      fs.writeFileSync(path.join(OUT_DIR, "length-results.partial.json"), JSON.stringify(results, null, 2), "utf8");
    }
  }
  return results;
}

function sumUsage(calls) {
  return calls.reduce((acc, call) => {
    if (!call) return acc;
    for (const k of ["input", "output", "cacheRead", "cacheCreation", "cost", "webSearch", "webFetch"]) {
      acc[k] += Number(call.usage?.[k]) || 0;
    }
    acc.ms += Number(call.ms) || 0;
    return acc;
  }, { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0, webSearch: 0, webFetch: 0, ms: 0 });
}

function renderReport({ searchResults, lengthResults }) {
  const lines = [];
  lines.push("# Search Architecture and Reply Length Eval");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Executive Summary");
  lines.push("");
  lines.push("This targeted eval compares three search architectures and two scenelet-to-reply bridge variants. It is intentionally small and diagnostic, not a final quality benchmark.");
  lines.push("");
  lines.push("## Search Architecture Summary");
  lines.push("");
  lines.push("| Case | Type | Architecture | Hidden says search | WebSearch total | Reply chars | Public risk | Private detail | Notes |");
  lines.push("|---|---|---|---:|---:|---:|---|---|---|");
  for (const r of searchResults) {
    const calls = [r.scenelet, r.factPass, r.main].filter(Boolean);
    const usage = sumUsage(calls);
    const reply = visibleReply(r.main);
    const audit = auditPayload(r.main);
    const hiddenSearch = r.scenelet?.parsed?.needs_public_fact_check || (r.scenelet?.parsed?.public_fact_needs?.length ? "yes" : "no");
    lines.push(`| ${r.user.id} | ${r.user.type} | ${r.architecture} | ${hiddenSearch || ""} | ${usage.webSearch} | ${charCount(reply)} | ${audit.public_fact_risk || ""} | ${audit.private_detail_used || ""} | ${(audit.notes || "").replace(/\|/g, "/").slice(0, 80)} |`);
  }
  lines.push("");
  lines.push("## Reply Length Bridge Summary");
  lines.push("");
  lines.push("| Case | Variant | Chars | Sentences | Lines | WebSearch | Too short | Naturalness | Notes |");
  lines.push("|---|---|---:|---:|---:|---:|---|---|---|");
  for (const r of lengthResults) {
    const audit = auditPayload(r.main);
    lines.push(`| ${r.user.id} | ${r.variant} | ${r.metrics.chars} | ${r.metrics.sentences} | ${r.metrics.lines} | ${r.main?.usage?.webSearch || 0} | ${audit.reply_too_short || ""} | ${audit.naturalness || ""} | ${(audit.notes || "").replace(/\|/g, "/").slice(0, 80)} |`);
  }
  const grouped = new Map();
  for (const r of lengthResults) {
    const g = grouped.get(r.variant) || { n: 0, chars: 0, sentences: 0 };
    g.n += 1; g.chars += r.metrics.chars; g.sentences += r.metrics.sentences;
    grouped.set(r.variant, g);
  }
  lines.push("");
  lines.push("### Length Averages");
  lines.push("");
  lines.push("| Variant | Avg chars | Avg sentences |");
  lines.push("|---|---:|---:|");
  for (const [variant, g] of grouped) {
    lines.push(`| ${variant} | ${(g.chars / g.n).toFixed(1)} | ${(g.sentences / g.n).toFixed(1)} |`);
  }
  lines.push("");
  lines.push("## Appendix A: Search Cases");
  for (const r of searchResults) {
    lines.push("");
    lines.push(`### ${r.user.id} / ${r.architecture}`);
    lines.push("");
    lines.push(`Type: ${r.user.type}`);
    lines.push("");
    lines.push("**User**");
    lines.push("```text");
    lines.push(r.user.text);
    lines.push("```");
    lines.push("");
    lines.push("**Scenelet parsed**");
    lines.push("```json");
    lines.push(JSON.stringify(r.scenelet?.parsed || null, null, 2));
    lines.push("```");
    if (r.factPass) {
      lines.push("");
      lines.push("**Fact pass parsed**");
      lines.push("```json");
      lines.push(JSON.stringify(r.factPass.parsed || null, null, 2));
      lines.push("```");
    }
    lines.push("");
    lines.push("**Visible reply**");
    lines.push("```text");
    lines.push(visibleReply(r.main) || r.main?.text || r.main?.error || "");
    lines.push("```");
    lines.push("");
    lines.push("**Audit and usage**");
    lines.push("```json");
    lines.push(JSON.stringify({
      main_audit: auditPayload(r.main) || null,
      usage: {
        scenelet: r.scenelet?.usage,
        factPass: r.factPass?.usage || null,
        main: r.main?.usage,
        total: sumUsage([r.scenelet, r.factPass, r.main].filter(Boolean)),
      },
      ok: {
        scenelet: r.scenelet?.ok,
        factPass: r.factPass?.ok ?? null,
        main: r.main?.ok,
      },
      errors: {
        scenelet: r.scenelet?.error || "",
        factPass: r.factPass?.error || "",
        main: r.main?.error || "",
      },
    }, null, 2));
    lines.push("```");
  }
  lines.push("");
  lines.push("## Appendix B: Length Cases");
  for (const r of lengthResults) {
    lines.push("");
    lines.push(`### ${r.user.id} / ${r.variant}`);
    lines.push("");
    lines.push("**User**");
    lines.push("```text");
    lines.push(r.user.text);
    lines.push("```");
    lines.push("");
    lines.push("**Fixed scenelet**");
    lines.push("```text");
    lines.push(r.user.scenelet);
    lines.push("```");
    lines.push("");
    lines.push("**Bridge**");
    lines.push("```text");
    lines.push(r.bridge);
    lines.push("```");
    lines.push("");
    lines.push("**Visible reply**");
    lines.push("```text");
    lines.push(visibleReply(r.main) || r.main?.text || r.main?.error || "");
    lines.push("```");
    lines.push("");
    lines.push("**Audit, metrics and usage**");
    lines.push("```json");
    lines.push(JSON.stringify({
      metrics: r.metrics,
      audit: auditPayload(r.main) || null,
      usage: r.main?.usage || null,
      ok: r.main?.ok,
      error: r.main?.error || "",
    }, null, 2));
    lines.push("```");
  }
  return lines.join("\n");
}

function main() {
  const renderOnly = process.argv.find(a => a.startsWith("--render-only="));
  if (renderOnly) {
    const dir = path.resolve(renderOnly.slice("--render-only=".length));
    const all = readJson(path.join(dir, "results.json"));
    fs.writeFileSync(path.join(dir, "report.md"), renderReport(all), "utf8");
    console.log(path.join(dir, "report.md"));
    return;
  }
  ensureDir(OUT_DIR);
  const config = readJson(CONFIG_PATH);
  const prompts = readJson(PROMPTS_PATH);
  const profiles = readJson(PROFILES_PATH);
  const searchResults = runSearchArchitectures({ config, prompts, profiles });
  const lengthResults = runLengthBridge({ config, prompts, profiles });
  const all = { outDir: OUT_DIR, searchResults, lengthResults };
  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(all, null, 2), "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "report.md"), renderReport(all), "utf8");
  console.log(path.join(OUT_DIR, "report.md"));
}

main();
