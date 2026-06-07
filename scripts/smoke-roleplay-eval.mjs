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
const OUT_DIR = path.join(ROOT, "data", "runtime", "smoke-roleplay-eval", new Date().toISOString().replace(/[:.]/g, "-"));
const HISTORY_PATH = path.join(ROOT, "data", "chat-history.json");
const PROFILE_PATH = path.join(ROOT, "wechat-profiles.json");
const CONFIG_PATH = path.join(ROOT, "data", "config.json");
const RAG_SCRIPT = path.join(ROOT, "app", "rag.py");
const SINGLE_COUNT = Number(arg("--single", "8"));
const SEGMENT_COUNT = Number(arg("--segments", "2"));
const SEGMENT_TURNS = Number(arg("--segment-turns", "3"));
const SHADOW_CHECKPOINTS = Number(arg("--shadow-checkpoints", "3"));
const EVAL_LABEL = arg("--label", "smoke");

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
  return configured || "claude";
}

function runClaudeJson(prompt, { label, config, tools = "", model = "" }) {
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
    timeout: 240_000,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    shell: /\.cmd$/i.test(claude),
  });
  const raw = result.stdout || "";
  const parsed = result.status === 0 ? parseClaudeJsonOutput(raw) : null;
  return {
    ok: result.status === 0 && Boolean(parsed),
    label,
    ms: Date.now() - started,
    exitCode: result.status,
    error: result.status === 0 ? "" : (result.stderr || result.error?.message || `exit ${result.status}`).slice(0, 2000),
    raw: raw.slice(0, 6000),
    parsed,
  };
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

function parseClaudeJsonOutput(raw) {
  const outer = parseJsonLoose(raw);
  if (!outer) return null;
  const content = outer.result || outer.message || outer.text;
  if (typeof content === "string") return parseJsonLoose(content) || outer;
  return outer;
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
    "角色 prompt：",
    profiles.templates?.[PROFILE] || "",
    "",
    memoryPrompt ? `长期记忆：\n${memoryPrompt}` : "",
    "",
    "当前时间：",
    JSON.stringify({
      iso: now.toISOString(),
      local: now.toLocaleString("zh-CN", { hour12: false }),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
    }, null, 2),
    "",
    "输入：",
    JSON.stringify({
      userId: USER_ID,
      sessionName: "offline-smoke",
      profile: PROFILE,
      visible_context_instruction: prompts.chatHistoryIntro,
      carried_scene_state: carriedSceneState || null,
      recent_visible_context: visibleContext,
      user_message: item.text,
    }, null, 2),
    "",
    "输出 JSON，且只输出 JSON：",
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
      }]
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
  sections.push(getChatStyle());
  sections.push(formatLocalChatReality(now));
  sections.push([`【用户消息】- ${item.timestamp}`, item.text].join("\n"));
  return sections.join("\n\n---\n\n");
}

function buildMainPrompt({ item, profiles, prompts, memoryPrompt, rag, scenelet, carriedSceneState, now }) {
  const sceneContext = buildSceneContext(prompts, scenelet, carriedSceneState);
  const turnBody = buildTurnBody({ item, prompts, rag, sceneContext, now });
  return [
    "你在做离线 smoke eval，不会发送微信消息。请按真实角色聊天路径生成本轮回复评估 JSON。",
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
    "- 如果涉及书、歌、作者、公开人物、新闻、截图/OCR 中可核验事实，未搜索确认时不要给精确断言。",
    "- 只输出 JSON。",
    "",
    JSON.stringify({
      visible_reply: "string",
      self_audit: {
        scenelet_mechanical: "yes/no",
        hard_inserted_life_detail: "yes/no",
        public_fact_risk: "none/low/high",
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
    "角色 prompt：",
    profiles.templates?.[PROFILE] || "",
    "",
    memoryPrompt ? `长期记忆：\n${memoryPrompt}` : "",
    "",
    "当前时间：",
    JSON.stringify({
      iso: now.toISOString(),
      local: now.toLocaleString("zh-CN", { hour12: false }),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
    }, null, 2),
    "",
    "输入：",
    JSON.stringify({
      userId: USER_ID,
      sessionName: "offline-smoke",
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

function pairTurns(events) {
  return events.map((e, i) => ({ ...e, eventIndex: i }))
    .filter(e => e.profile === PROFILE && e.role === "user")
    .map(user => {
      const assistant = events.slice(user.eventIndex + 1).find(e => e.profile === PROFILE && e.role === "assistant");
      return { ...user, historicalAssistant: assistant?.text || "", historicalScenelet: assistant?.scenelet || "" };
    });
}

function pickSingleCases(turns) {
  const buckets = [
    { id: "relationship_aya_kanon", re: /小彩.*花音|花音.*小彩|同居|合租/u },
    { id: "public_book_author", re: /濑户内|又吉|柠檬|梶井/u },
    { id: "ocr_song_screenshot", re: /^\[图片\][\s\S]*(歌曲|音乐|播放|OCR|文字|画面主体为手机屏)/u },
    { id: "care_preaching_sleep_food", re: /通宵|晚饭|主食|蔬菜汁|作息|熬/u },
    { id: "job_emotion", re: /被裁|找实习|找工作|未来的不确定/u },
    { id: "scene_activity", re: /今天做了什么|排练|片场|在干什么/u },
    { id: "pet_leo_panpan", re: /Leo|盼盼|小猫|橘猫/u },
    { id: "ai_research", re: /AI产业|模型|算力|商业化|coding/u },
  ];
  const chosen = [];
  for (const bucket of buckets) {
    const item = turns.find(t => bucket.re.test(t.text) && !chosen.some(c => c.id === t.id));
    if (item) chosen.push({ bucket: bucket.id, ...item });
  }
  if (chosen.length >= SINGLE_COUNT) return chosen.slice(0, SINGLE_COUNT);
  const used = new Set(chosen.map(c => c.id));
  const classified = turns
    .filter(t => !used.has(t.id) && String(t.text || "").trim().length > 4)
    .map(t => ({ bucket: classifyBucket(t.text), ...t }));
  const stride = Math.max(1, Math.floor(classified.length / Math.max(1, SINGLE_COUNT - chosen.length)));
  for (let i = 0; i < classified.length && chosen.length < SINGLE_COUNT; i += stride) {
    if (used.has(classified[i].id)) continue;
    chosen.push(classified[i]);
    used.add(classified[i].id);
  }
  for (const item of classified) {
    if (chosen.length >= SINGLE_COUNT) break;
    if (used.has(item.id)) continue;
    chosen.push(item);
    used.add(item.id);
  }
  return chosen;
}

function classifyBucket(text = "") {
  if (/小彩|丸山彩|彩|花音|薰|日菜|麻弥|伊芙|PasPale/u.test(text)) return "relationship";
  if (/濑户内|又吉|柠檬|梶井|书|歌|作者|电台|节目/u.test(text)) return "public_knowledge";
  if (/^\[图片\]/u.test(text)) return "image_ocr";
  if (/通宵|晚饭|主食|蔬菜汁|作息|熬|困|睡/u.test(text)) return "care_preaching";
  if (/被裁|找实习|找工作|未来|行业研究|AI|模型|算力|coding/u.test(text)) return "work_research";
  if (/Leo|盼盼|小猫|橘猫|宠物/u.test(text)) return "pet_daily";
  if (/今天|在干什么|做了什么|排练|片场|通告|上课/u.test(text)) return "scene_daily";
  return "general_chat";
}

function pickSegments(events) {
  const chisato = events.map((e, i) => ({ ...e, eventIndex: i })).filter(e => e.profile === PROFILE);
  const anchorPatterns = [
    /濑户内|又吉|柠檬|梶井/u,
    /晚饭|主食|蔬菜汁|作息|熬/u,
    /小彩|花音|薰|同居|合租/u,
    /被裁|找实习|找工作|悲伤/u,
    /AI产业|模型|算力|商业化|coding/u,
    /Leo|盼盼|小猫|橘猫/u,
    /鼓房|打鼓|练习|PasPale|麻弥/u,
    /今天做了什么|在干什么|排练|通告|片场/u,
  ];
  const anchors = [];
  for (const pattern of anchorPatterns) {
    const found = chisato.findIndex((e, idx) =>
      e.role === "user" &&
      pattern.test(e.text) &&
      !anchors.some(a => Math.abs(a - idx) < SEGMENT_TURNS * 2)
    );
    if (found >= 0) anchors.push(found);
    if (anchors.length >= SEGMENT_COUNT) break;
  }
  for (let i = 0; i < chisato.length && anchors.length < SEGMENT_COUNT; i++) {
    if (chisato[i].role !== "user") continue;
    if (anchors.some(a => Math.abs(a - i) < SEGMENT_TURNS * 2)) continue;
    anchors.push(i);
  }
  return anchors.slice(0, SEGMENT_COUNT).map((anchor, segmentNo) => {
    const userItems = [];
    for (let i = anchor; i < chisato.length && userItems.length < SEGMENT_TURNS; i++) {
      if (chisato[i].role === "user") userItems.push(chisato[i]);
    }
    return { segmentNo: segmentNo + 1, anchorEventIndex: chisato[anchor].eventIndex, userItems };
  });
}

function pickShadowCheckpoints(events) {
  const assistantEvents = events.map((e, i) => ({ ...e, eventIndex: i }))
    .filter(e => e.profile === PROFILE && e.role === "assistant");
  const picked = [];
  for (const e of assistantEvents) {
    const after = new Date(new Date(e.timestamp).getTime() + 45 * 60 * 1000);
    if (!picked.some(p => Math.abs(after - p.now) < 2 * 60 * 60 * 1000)) {
      picked.push({ now: after, eventIndex: e.eventIndex, afterText: e.text.slice(0, 160), afterKind: e.kind || "chat" });
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
  };
}

function analyzeResult(item) {
  const scene = item.scenelet?.inner_scenelet || "";
  const reply = item.reply?.visible_reply || "";
  return {
    scene_keywords: {
      school: /课|大学|教室|ゼミ|讲义|图书馆/u.test(scene),
      studio: /片场|拍摄|通告|经纪|录节目|摄影棚/u.test(scene),
      rehearsal: /排练|练贝斯|PasPale|录音/u.test(scene),
      home: /家|客厅|沙发|Leo|花音/u.test(scene),
      cafe_store: /咖啡|便利店|商场|店|餐厅/u.test(scene),
    },
    hard_inserted_life_detail_guess: /刚刚|今天|路上|店|咖啡|Leo|花音|片场|排练/u.test(reply) && !/今天|刚刚|在干什么|吃|睡|Leo|花音|排练|片场|路上|店|咖啡/u.test(item.user || ""),
    bracket_action_risk: /\[[^\]]+\]/u.test(reply),
    public_fact_risk_guess: /作者|连载|出版|第\d+页|秒|副歌|歌词|逝世|去世|电台|节目|书名|歌名/u.test(reply),
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
  const singles = pickSingleCases(turns);
  const segments = pickSegments(history);
  const shadowCheckpoints = pickShadowCheckpoints(history);

  const manifest = {
    createdAt: new Date().toISOString(),
    profile: PROFILE,
    label: EVAL_LABEL,
    singleCount: singles.length,
    segmentCount: segments.length,
    segmentTurns: SEGMENT_TURNS,
    shadowCheckpoints: shadowCheckpoints.length,
    outDir: OUT_DIR,
  };
  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  const results = { manifest, singles: [], segments: [], proactiveShadow: [] };
  let runNo = 0;

  async function runCase(item, { label, carriedSceneState = "" } = {}) {
    runNo++;
    const now = new Date(item.timestamp || Date.now());
    const visibleContext = recentVisibleContext(history, item.eventIndex, prompts.visibleContextTurns || 8);
    const rag = runRag(item.text, PROFILE, config, prompts, profiles);
    const scenePrompt = buildSceneletPrompt({ item, profiles, prompts, memoryPrompt, carriedSceneState, visibleContext, now });
    const sceneModel = config.models?.claudeMain || "deepseek-v4-pro[1m]";
    const mainModel = config.models?.claudeMain || config.models?.claudeFast || "deepseek-v4-pro[1m]";
    const sceneCall = runClaudeJson(scenePrompt, { label: `${label}:scenelet`, config, tools: "WebSearch,WebFetch", model: sceneModel });
    const scenelet = normalizeScenelet(sceneCall.parsed);
    const mainPrompt = buildMainPrompt({ item, profiles, prompts, memoryPrompt, rag, scenelet, carriedSceneState, now });
    const mainCall = runClaudeJson(mainPrompt, { label: `${label}:main`, config, tools: "WebSearch,WebFetch", model: mainModel });
    const record = {
      label,
      runNo,
      bucket: item.bucket || "",
      eventIndex: item.eventIndex,
      timestamp: item.timestamp,
      user: item.text,
      historicalAssistant: item.historicalAssistant || "",
      historicalScenelet: item.historicalScenelet || "",
      visibleContext,
      rag,
      sceneCall: { ok: sceneCall.ok, ms: sceneCall.ms, error: sceneCall.error, raw: sceneCall.raw, model: sceneModel },
      scenelet,
      mainCall: { ok: mainCall.ok, ms: mainCall.ms, error: mainCall.error, raw: mainCall.raw, model: mainModel },
      reply: mainCall.parsed || null,
    };
    record.analysis = analyzeResult({ ...record, user: item.text });
    return record;
  }

  for (let i = 0; i < singles.length; i++) {
    console.log(`single ${i + 1}/${singles.length}: ${singles[i].bucket}`);
    results.singles.push(await runCase(singles[i], { label: `single_${i + 1}_${singles[i].bucket}` }));
    fs.writeFileSync(path.join(OUT_DIR, "results.partial.json"), JSON.stringify(results, null, 2), "utf8");
  }

  for (const seg of segments) {
    console.log(`segment ${seg.segmentNo}/${segments.length}: ${seg.userItems.length} turns`);
    let carried = "";
    const segRecord = { segmentNo: seg.segmentNo, anchorEventIndex: seg.anchorEventIndex, cases: [] };
    for (let i = 0; i < seg.userItems.length; i++) {
      const rec = await runCase(seg.userItems[i], { label: `segment_${seg.segmentNo}_turn_${i + 1}`, carriedSceneState: carried });
      carried = rec.scenelet.next_scene_state || carried;
      segRecord.cases.push(rec);
      fs.writeFileSync(path.join(OUT_DIR, "results.partial.json"), JSON.stringify(results, null, 2), "utf8");
    }
    results.segments.push(segRecord);
  }

  let sentToday = history.filter(e => e.profile === PROFILE && e.kind === "proactive" && e.timestamp >= "2026-06-04T00:00:00.000Z" && e.timestamp < "2026-06-05T00:00:00.000Z").length;
  for (let i = 0; i < shadowCheckpoints.length; i++) {
    const cp = shadowCheckpoints[i];
    console.log(`proactive shadow ${i + 1}/${shadowCheckpoints.length}`);
    const visibleContext = recentVisibleContext(history, cp.eventIndex + 1, prompts.visibleContextTurns || 8);
    const prompt = buildDailyShareSeedPrompt({
      profiles,
      prompts,
      memoryPrompt,
      visibleContext,
      carriedSceneState: "",
      now: cp.now,
      sentToday,
    });
    const seedModel = config.models?.claudeMain || "deepseek-v4-pro[1m]";
    const call = runClaudeJson(prompt, { label: `daily_share_seed_${i + 1}`, config, tools: "WebSearch,WebFetch", model: seedModel });
    const parsed = call.parsed || {};
    if (parsed.should_create === true) sentToday++;
    results.proactiveShadow.push({
      checkpointNo: i + 1,
      now: cp.now.toISOString(),
      sourceEventIndex: cp.eventIndex,
      afterKind: cp.afterKind,
      afterText: cp.afterText,
      visibleContext,
      call: { ok: call.ok, ms: call.ms, error: call.error, raw: call.raw, model: seedModel },
      output: parsed,
    });
    fs.writeFileSync(path.join(OUT_DIR, "results.partial.json"), JSON.stringify(results, null, 2), "utf8");
  }

  results.summary = summarize(results);
  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2), "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "report.md"), renderReport(results), "utf8");
  console.log(`wrote ${OUT_DIR}`);
  console.log(JSON.stringify(results.summary, null, 2));
}

function summarize(results) {
  const cases = [
    ...results.singles,
    ...results.segments.flatMap(s => s.cases),
  ];
  const sceneCounts = { school: 0, studio: 0, rehearsal: 0, home: 0, cafe_store: 0 };
  for (const c of cases) {
    for (const k of Object.keys(sceneCounts)) if (c.analysis?.scene_keywords?.[k]) sceneCounts[k]++;
  }
  return {
    totalReplyCases: cases.length,
    sceneletOk: cases.filter(c => c.sceneCall.ok && c.scenelet.inner_scenelet).length,
    mainOk: cases.filter(c => c.mainCall.ok && c.reply?.visible_reply).length,
    ragUsed: cases.filter(c => c.rag.used).length,
    bracketActionRisk: cases.filter(c => c.analysis.bracket_action_risk).length,
    hardInsertedLifeDetailGuess: cases.filter(c => c.analysis.hard_inserted_life_detail_guess).length,
    publicFactRiskGuess: cases.filter(c => c.analysis.public_fact_risk_guess).length,
    sceneCounts,
    dailyShare: {
      checkpoints: results.proactiveShadow.length,
      created: results.proactiveShadow.filter(x => x.output?.should_create === true).length,
      cancelled: results.proactiveShadow.filter(x => x.output?.should_create === false).length,
      ok: results.proactiveShadow.filter(x => x.call.ok).length,
    },
  };
}

function renderReport(results) {
  const lines = [];
  lines.push("# Smoke Roleplay Eval");
  lines.push("");
  lines.push(`生成时间：${results.manifest.createdAt}`);
  lines.push(`输出目录：${results.manifest.outDir}`);
  lines.push(`实验标签：${results.manifest.label || "smoke"}`);
  lines.push("");
  lines.push("## 本轮正式测试前调整方向");
  lines.push("");
  lines.push("- 场景素材扩展：减少家、大学课程、咖啡店三点循环，增加片场、摄影棚、经纪公司、试镜、台本围读、广告拍摄、杂志采访、综艺录制、后台等待、服装试穿、舞台彩排、通告回程、旅行和偶发日常。");
  lines.push("- 演艺内容自由度：允许千圣私下分享虚构戏、节目或通告的生活细节与剧情氛围，但不把它写成现实已公开的官方事实。");
  lines.push("- proactive 可执行性：cancel_if 收紧到系统可观察条件；当前不能真实拍照或发图片，所以候选不应承诺拍照、发图。");
  lines.push("- 模型路径校正：hidden scenelet / proactive 使用 scenelet 模型，最终 visible reply 使用线上主回复配置模型。");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(results.summary, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## Singles");
  for (const c of results.singles) {
    lines.push("");
    lines.push(`### ${c.label}`);
    lines.push(`- User: ${oneLine(c.user)}`);
    lines.push(`- RAG: ${c.rag.used ? `used (${c.rag.sources.length} sources)` : "skipped"}`);
    lines.push(`- Scenelet: ${oneLine(c.scenelet.inner_scenelet)}`);
    lines.push(`- Reply: ${oneLine(c.reply?.visible_reply || "")}`);
    lines.push(`- Audit: ${JSON.stringify(c.reply?.self_audit || {})}`);
  }
  lines.push("");
  lines.push("## Continuous Segments");
  for (const seg of results.segments) {
    lines.push("");
    lines.push(`### Segment ${seg.segmentNo}`);
    for (const c of seg.cases) {
      lines.push(`- ${c.label}: ${oneLine(c.user)} => ${oneLine(c.reply?.visible_reply || "")}`);
      lines.push(`  - scenelet: ${oneLine(c.scenelet.inner_scenelet)}`);
      lines.push(`  - audit: ${JSON.stringify(c.reply?.self_audit || {})}`);
    }
  }
  lines.push("");
  lines.push("## Proactive Shadow");
  for (const p of results.proactiveShadow) {
    lines.push("");
    lines.push(`### Checkpoint ${p.checkpointNo} ${p.now}`);
    lines.push(`- After: ${oneLine(p.afterText)}`);
    lines.push(`- Output: ${JSON.stringify(p.output)}`);
  }
  lines.push("");
  lines.push("完整附录见 results.json。");
  return lines.join("\n");
}

function oneLine(text = "") {
  return String(text).replace(/\s+/g, " ").slice(0, 500);
}

main().catch(err => {
  console.error(err?.stack || err);
  process.exit(1);
});
