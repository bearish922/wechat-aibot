import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadAllEvents } from "../app/lib/chat-history.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const LOG_FILE = path.join(ROOT, "data", "logs", "cst-cc.txt");
const PROFILE_FILE = path.join(ROOT, "data", "wechat-profiles.json");
const OUTPUT_DIR = path.join(ROOT, "data", "runtime", "expanded-actor-experiment", "2026-06-13-round-1");
const CLAUDE_SHIM = path.join(process.env.APPDATA || "", "npm", "claude.cmd");
const MODEL = "deepseek-v4-pro[1m]";
const REPEATS = 2;
const CONCURRENCY = 3;

const cases = [
  { id: "show-me-anxious", marker: "2026-06-12T05:25:40.721Z", focus: "直接要求显露着急" },
  { id: "happy-and-pudding", marker: "2026-06-12T06:10:07.080Z", focus: "被点破欣喜并转入日常行动" },
  { id: "admit-fault-and-teasing", marker: "2026-06-12T09:17:54.571Z", focus: "承认判断错误后继续面对暧昧逗弄" },
  { id: "ask-aya-no-screenshot", marker: "2026-06-12T12:13:02.569Z", focus: "不知道彩会怎样回答且无法看到截图" },
  { id: "wait-for-the-shoes", marker: "2026-06-12T14:24:32.179Z", focus: "接受礼物后的柔软与克制" },
  { id: "weekend-stay-up", marker: "2026-06-12T14:27:13.437Z", focus: "周末夜晚的日常关心与继续聊天" },
  { id: "late-night-dog-pancake", marker: "2026-06-12T16:40:00.798Z", focus: "被吵醒后的低能量短回复" },
  { id: "already-asleep-goodnight", marker: "2026-06-12T16:56:10.832Z", focus: "已经睡着时是否应该回复" },
];

function between(text, startMarker, endMarkers) {
  const start = text.indexOf(startMarker);
  if (start < 0) return "";
  const contentStart = start + startMarker.length;
  const ends = endMarkers.map(marker => text.indexOf(marker, contentStart)).filter(index => index >= 0);
  const end = ends.length ? Math.min(...ends) : text.length;
  return text.slice(contentStart, end).trim();
}

function section(text, startMarker, endMarkers) {
  const start = text.indexOf(startMarker);
  if (start < 0) return "";
  const ends = endMarkers.map(marker => text.indexOf(marker, start + startMarker.length)).filter(index => index >= 0);
  const end = ends.length ? Math.min(...ends) : text.length;
  return text.slice(start, end).trim();
}

function nextBlock(text, marker, label) {
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`Missing marker: ${marker}`);
  const blockStart = text.indexOf(`=== ${label} [`, start);
  if (blockStart < 0) return "";
  const contentStart = text.indexOf("===\n", blockStart) + 4;
  const next = text.indexOf("\n=== ", contentStart);
  return text.slice(contentStart, next < 0 ? text.length : next).trim();
}

function parseJsonText(text) {
  const stripped = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(stripped); } catch {}
  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  const candidate = first >= 0 && last > first ? stripped.slice(first, last + 1) : stripped;
  try { return JSON.parse(candidate); } catch {}
  let repaired = "";
  let inString = false;
  let escaped = false;
  for (const char of candidate) {
    if (inString && (char === "\n" || char === "\r" || char === "\t")) {
      repaired += char === "\n" ? "\\n" : char === "\r" ? "\\r" : "\\t";
      escaped = false;
      continue;
    }
    repaired += char;
    if (escaped) escaped = false;
    else if (char === "\\" && inString) escaped = true;
    else if (char === '"') inString = !inString;
  }
  try { return JSON.parse(repaired); } catch {}
  throw new Error("Model output is not valid JSON");
}

function resolveClaudeExecutable() {
  if (!fs.existsSync(CLAUDE_SHIM)) throw new Error(`Claude CLI shim not found: ${CLAUDE_SHIM}`);
  const shim = fs.readFileSync(CLAUDE_SHIM, "utf8");
  const match = shim.match(/^"([^"]+\.exe)"/m);
  if (!match || !fs.existsSync(match[1])) throw new Error(`Claude executable not found via: ${CLAUDE_SHIM}`);
  return match[1];
}

function runClaude({ systemPrompt, prompt, label }) {
  const systemFile = path.join(OUTPUT_DIR, `.system-${label}-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(systemFile, systemPrompt, "utf8");
  const args = [
    "-p", "--bare", "--output-format", "json", "--permission-mode", "bypassPermissions",
    "--tools", "", "--strict-mcp-config", "--model", MODEL, "--no-session-persistence",
    "--append-system-prompt-file", systemFile,
  ];
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveClaudeExecutable(), args, { cwd: ROOT, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => proc.kill(), 300_000);
    proc.stdout.on("data", chunk => { stdout += chunk; });
    proc.stderr.on("data", chunk => { stderr += chunk; });
    proc.on("error", reject);
    proc.on("close", code => {
      clearTimeout(timer);
      fs.rmSync(systemFile, { force: true });
      if (code !== 0) return reject(new Error(`${label}: Claude exited ${code}: ${stderr.slice(-1000)}`));
      try {
        const envelope = JSON.parse(stdout);
        resolve({ result: String(envelope.result || ""), envelope, duration_ms: Date.now() - started, stderr });
      } catch (error) {
        reject(new Error(`${label}: invalid Claude envelope: ${error.message}`));
      }
    });
    proc.stdin.end(prompt, "utf8");
  });
}

async function runStructured({ systemPrompt, prompt, label, requiredKeys }) {
  const attempts = [];
  let currentPrompt = prompt;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const raw = await runClaude({
      systemPrompt,
      prompt: currentPrompt,
      label: attempt === 1 ? label : `${label}-format-retry`,
    });
    attempts.push(raw);
    try {
      const parsed = parseJsonText(raw.result);
      for (const key of requiredKeys) {
        if (typeof parsed?.[key] !== "string") throw new Error(`Missing string field: ${key}`);
      }
      return { ...raw, parsed, format_attempts: attempts.length, attempts };
    } catch (error) {
      if (attempt === 2) throw error;
      currentPrompt = `${prompt}\n\n上一次内容因 JSON 格式无效而未被读取。保持同一内容任务，只输出严格合法的 JSON；字符串中的换行必须转义，不要附加任何说明或 Markdown。`;
    }
  }
  throw new Error(`${label}: structured output retry exhausted`);
}

const actorCore = `你直接扮演白鹭千圣，完成一次真实的微信私聊认知与表达。这不是分析、评论或评分任务。

先写 inner_scenelet，再写可见回复。两者必须来自同一次连续认知：先允许千圣完整地想，再由她自己决定实际说多少、怎样说。

【inner_scenelet】
- 第一人称，是千圣此刻真正对自己说的话。可以碎、短、矛盾、羞赧、烦躁、柔软或失控。
- 不要用中文圆括号写动作，不要写成第三人称镜头、剧本、心理报告或漂亮独白。
- 不要逐句拆解用户用了什么话术，不要默认把互动理解为输赢、攻防、武器、供词、战报或回合。
- 环境不是必填项。只有当周围事物自然进入注意、触发联想、打断思考或提供行动出口时才写。
- 千圣在日常中理性、有掌控感、会照顾、吐槽、说教和开玩笑；感情被点到时可能同时羞赧、欣喜、紧张、退避、反击、摆烂或短暂失控。不要把任何一种反应固定成模板。

【可见回复】
- 必须由刚才的完整 inner 自然导出，不能另起炉灶。
- 不要求复述 inner。千圣可以隐瞒、暗示、转移、只说一部分或不回复；但承认程度、关系立场和心理因果必须一致。
- 如果 inner 明确决定某个内容不说，回复不得直接或近义泄漏。
- 像真实微信私聊，优先回应当前消息。普通闲聊可以很短；确有内容时自然展开。
- 避免总结、金句、漂亮独白、固定反转句和对用户消息的逐句分析。动作只有在微信里确有必要时少量使用。

【事实与上下文】
- 本轮相关 RAG/事实材料已经在输入中前置。只使用其直接支持的公共事实。
- 私人感受可以自然生成，但不要创造会改变本轮含义的新行程、承诺、公共事实或既往事件。
- 不生成 scene_state、world state、follow-up、日程或任何其他辅助字段。
- 不出现系统、模型、提示词、RAG、JSON、session、pipeline 等机制词。`;

const singleSystem = `${actorCore}

只输出合法 JSON，不加 markdown，键顺序固定：
{"inner_scenelet":"第一人称内心声音","visible_reply":"最终实际发送的微信回复"}`;

const dualActorSystem = `${actorCore}

你输出的 visible_reply_seed 必须已经是一条完整、自然、可直接发送的微信回复。下游只允许做很轻的表述整理，因此不能把它写成提纲、策略、说明或半成品。

只输出合法 JSON，不加 markdown，键顺序固定：
{"inner_scenelet":"第一人称内心声音","visible_reply_seed":"完整可发送的微信回复"}`;

const finalizerSystem = `你是白鹭千圣微信回复的受约束 Finalizer。Actor 已经完成心理判断和表达决策。

visible_reply_seed 是语义合同：
- 不改变承认、否认、回避、暗示、感谢、拒绝、关心和关系立场的程度。
- 不增加 seed 没有的新事实、新心理解释、新行动、新承诺或新问题。
- 不重新分析用户，也不尝试比 Actor 更聪明地重写回复方向。
- 只在确有必要时改善口语、节奏、冗余、标点和微信体裁；seed 已自然时原样保留。
- 不读取 inner_scenelet，也不得猜测未提供的内心。
- 本轮事实包只用于避免表述错误，不用于扩写。

只输出合法 JSON，不加 markdown：
{"visible_reply":"最终实际发送的微信回复"}`;

function historyForCase(events, currentMessage, marker) {
  const normalizeText = value => String(value || "").replace(/\s+/g, " ").trim();
  const parseHistoricalTime = value => Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(String(value || "")) ? value : `${value}Z`);
  let userIndex = events.findIndex(event => event.role === "user" && event.profile === "白鹭千圣"
    && normalizeText(event.text) === normalizeText(currentMessage));
  if (userIndex < 0) {
    const markerMs = Date.parse(marker);
    userIndex = events.findIndex(event => event.role === "user" && event.profile === "白鹭千圣"
      && Math.abs(parseHistoricalTime(event.timestamp) - markerMs) < 120_000);
  }
  if (userIndex < 0) {
    const assistantIndex = events.findIndex(event => event.role === "assistant" && event.profile === "白鹭千圣"
      && Math.abs(parseHistoricalTime(event.timestamp) - Date.parse(marker)) < 120_000);
    if (assistantIndex >= 0) {
      for (let index = assistantIndex - 1; index >= 0; index -= 1) {
        if (events[index].role === "user" && events[index].profile === "白鹭千圣") {
          userIndex = index;
          break;
        }
      }
    }
  }
  if (userIndex < 0) throw new Error(`History event not found for ${marker}`);
  const assistant = events.slice(userIndex + 1).find(event => event.role === "assistant" && event.profile === "白鹭千圣");
  const priorInner = events.slice(0, userIndex).filter(event => event.role === "assistant" && event.profile === "白鹭千圣" && event.scenelet).slice(-3);
  return { userIndex, assistant, priorInner };
}

function buildCaseInput(logText, events, profile, testCase) {
  const userLabel = `=== USER MESSAGE [${testCase.marker}] ===`;
  const currentMessage = between(logText, userLabel, ["\n=== "]);
  if (!currentMessage) throw new Error(`Current message missing for ${testCase.id}`);
  const memory = nextBlock(logText, userLabel, "MEMORY SNAPSHOT");
  const turnBody = nextBlock(logText, userLabel, "TURN BODY");
  const recentVisible = section(turnBody, "【近期对话】", ["【正在发生的事】", "【隐藏中间层", "【角色场景状态", "【关于角色自己】"]);
  const lifeArcs = section(turnBody, "【正在发生的事】", ["【隐藏中间层", "【角色场景状态", "【关于角色自己】"]);
  const rag = section(turnBody, "【关于角色自己】", ["【聊天风格】", "当前用户侧时间："]);
  const time = section(turnBody, "当前用户侧时间：", ["【当前聊天现实】", "【当前用户消息】"]);
  const weather = section(turnBody, "【当前天气】", ["（以上为实时天气数据", "【当前聊天现实】", "【当前用户消息】"]);
  const history = historyForCase(events, currentMessage, testCase.marker);
  const priorInner = history.priorInner.map((event, index) => `[较早 ${history.priorInner.length - index}] ${event.scenelet}`).join("\n\n");
  const prompt = [
    "【角色 Profile】", profile,
    memory ? `\n【当时的长期记忆快照】\n${memory}` : "",
    recentVisible ? `\n${recentVisible}` : "",
    priorInner ? `\n【最近几轮内心连续性，仅用于理解未闭合心理，不要复述】\n${priorInner}` : "",
    lifeArcs ? `\n${lifeArcs}` : "",
    rag ? `\n【本轮前置 RAG / 事实材料】\n${rag}` : "\n【本轮前置 RAG / 事实材料】\n（无检索结果）",
    time ? `\n【时间上下文】\n${time}` : "",
    weather ? `\n${weather}` : "",
    `\n【当前用户消息】\n${currentMessage}`,
    "\n现在直接生成规定字段。不要评价，不要解释。",
  ].filter(Boolean).join("\n");
  return {
    ...testCase,
    currentMessage,
    memory,
    recentVisible,
    priorInner,
    lifeArcs,
    rag,
    time,
    weather,
    prompt,
    baseline: {
      inner_scenelet: history.assistant?.scenelet || "",
      scene_state: history.assistant?.sceneState || "",
      visible_reply: history.assistant?.text || "",
      timestamp: history.assistant?.timestamp || "",
    },
  };
}

async function runSingle(input, run) {
  const label = `${input.id}-single-${run}`;
  const raw = await runStructured({
    systemPrompt: singleSystem,
    prompt: input.prompt,
    label,
    requiredKeys: ["inner_scenelet", "visible_reply"],
  });
  return { architecture: "single", run, ...raw };
}

async function runDual(input, run) {
  const actorLabel = `${input.id}-dual-actor-${run}`;
  const actorRaw = await runStructured({
    systemPrompt: dualActorSystem,
    prompt: input.prompt,
    label: actorLabel,
    requiredKeys: ["inner_scenelet", "visible_reply_seed"],
  });
  const actor = actorRaw.parsed;
  const finalizerPrompt = [
    "【角色 Profile】", JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8")).templates["白鹭千圣"],
    input.recentVisible ? `\n${input.recentVisible}` : "",
    input.rag ? `\n【本轮前置 RAG / 事实材料】\n${input.rag}` : "\n【本轮前置 RAG / 事实材料】\n（无检索结果）",
    `\n【当前用户消息】\n${input.currentMessage}`,
    `\n【Actor 的 visible_reply_seed】\n${actor.visible_reply_seed || ""}`,
    "\n忠实完成最终回复。",
  ].filter(Boolean).join("\n");
  const finalizerLabel = `${input.id}-dual-finalizer-${run}`;
  const finalRaw = await runStructured({
    systemPrompt: finalizerSystem,
    prompt: finalizerPrompt,
    label: finalizerLabel,
    requiredKeys: ["visible_reply"],
  });
  const finalizer = finalRaw.parsed;
  return {
    architecture: "dual",
    run,
    actor: { ...actorRaw, parsed: actor },
    finalizer: { ...finalRaw, parsed: finalizer },
    parsed: { inner_scenelet: actor.inner_scenelet || "", visible_reply_seed: actor.visible_reply_seed || "", visible_reply: finalizer.visible_reply || "" },
  };
}

async function pool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= tasks.length) return;
      try {
        results[index] = await tasks[index]();
      } catch (error) {
        results[index] = { error: error.message, stack: error.stack };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

function hasValidResultFile(file, architecture) {
  if (!fs.existsSync(file)) return false;
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    const parsed = saved?.parsed;
    if (typeof parsed?.inner_scenelet !== "string" || typeof parsed?.visible_reply !== "string") return false;
    if (architecture === "dual" && typeof parsed?.visible_reply_seed !== "string") return false;
    return true;
  } catch {
    return false;
  }
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const logText = fs.readFileSync(LOG_FILE, "utf8");
const events = await loadAllEvents();
const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8")).templates?.["白鹭千圣"];
if (!profile) throw new Error("Missing 白鹭千圣 profile");
resolveClaudeExecutable();

const inputs = cases.map(testCase => buildCaseInput(logText, events, profile, testCase));
for (const input of inputs) {
  fs.writeFileSync(path.join(OUTPUT_DIR, `${input.id}-input.json`), JSON.stringify(input, null, 2), "utf8");
}
fs.writeFileSync(path.join(OUTPUT_DIR, "single-system-prompt.txt"), singleSystem, "utf8");
fs.writeFileSync(path.join(OUTPUT_DIR, "dual-actor-system-prompt.txt"), dualActorSystem, "utf8");
fs.writeFileSync(path.join(OUTPUT_DIR, "dual-finalizer-system-prompt.txt"), finalizerSystem, "utf8");
fs.writeFileSync(path.join(OUTPUT_DIR, "manifest.json"), JSON.stringify({
  created_at: new Date().toISOString(), model: MODEL, repeats: REPEATS, concurrency: CONCURRENCY,
  session_persistence: false, tools: [], model_self_evaluation: false, rag_before_actor: true,
  scene_state_generated: false, postprocessor_enabled: false,
  architectures: { H: "historical reference", D: "actor plus finalizer", S: "single actor" },
  cases: cases.map(({ id, marker, focus }) => ({ id, marker, focus })),
}, null, 2), "utf8");

const tasks = [];
for (const input of inputs) {
  for (let run = 1; run <= REPEATS; run += 1) {
    const singleFile = path.join(OUTPUT_DIR, `${input.id}-single-${run}.json`);
    if (!hasValidResultFile(singleFile, "single")) {
      tasks.push(async () => {
        const result = await runSingle(input, run);
        const item = { id: input.id, architecture: "single", run, result };
        fs.writeFileSync(singleFile, JSON.stringify(result, null, 2), "utf8");
        process.stdout.write(`Saved ${input.id}-single-${run}.json\n`);
        return item;
      });
    }
    const dualFile = path.join(OUTPUT_DIR, `${input.id}-dual-${run}.json`);
    if (!hasValidResultFile(dualFile, "dual")) {
      tasks.push(async () => {
        const result = await runDual(input, run);
        const item = { id: input.id, architecture: "dual", run, result };
        fs.writeFileSync(dualFile, JSON.stringify(result, null, 2), "utf8");
        process.stdout.write(`Saved ${input.id}-dual-${run}.json\n`);
        return item;
      });
    }
  }
}

const completed = await pool(tasks, CONCURRENCY);
const resultFiles = cases.flatMap(testCase => Array.from({ length: REPEATS }, (_, index) => index + 1)
  .flatMap(run => ["single", "dual"].map(architecture => ({
    id: testCase.id,
    architecture,
    run,
    file: `${testCase.id}-${architecture}-${run}.json`,
  }))));
const consolidated = resultFiles.map(item => {
  const file = path.join(OUTPUT_DIR, item.file);
  if (!fs.existsSync(file)) return { ...item, error: "missing result file" };
  return { ...item, result: JSON.parse(fs.readFileSync(file, "utf8")) };
});
fs.writeFileSync(path.join(OUTPUT_DIR, "run-results.json"), JSON.stringify(consolidated, null, 2), "utf8");

const failures = completed.filter(item => item?.error);
process.stdout.write(`Ran ${completed.length} missing samples with ${failures.length} failures in ${OUTPUT_DIR}\n`);
