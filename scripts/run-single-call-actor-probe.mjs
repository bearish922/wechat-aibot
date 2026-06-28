import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beijingISO } from "../app/lib/time-utils.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const LOG_FILE = path.join(ROOT, "data", "logs", "cst-cc.txt");
const PROFILE_FILE = path.join(ROOT, "data", "wechat-profiles.json");
const OUTPUT_DIR = path.join(ROOT, "data", "runtime", "single-call-actor-probe", "2026-06-13");
const CLAUDE_SHIM = path.join(process.env.APPDATA || "", "npm", "claude.cmd");
const MODEL = "deepseek-v4-pro[1m]";

const cases = [
  {
    id: "dream-boundary-1542",
    userMarker: "=== USER MESSAGE [2026-06-12T07:42:35.680Z] ===",
    memoryMarker: "=== MEMORY SNAPSHOT [2026-06-12T07:42:35.680Z] ===",
    bodyMarker: "=== TURN BODY [2026-06-12T07:42:38.640Z] ===",
    worldState: {
      location: "东京公寓玄关",
      activity: "牵引绳已经拿在手里，Leo 已扣好项圈，正准备赶在下雨前出门散步",
      awake_state: "awake",
      current_plan: "先带 Leo 散步，回来后练贝斯",
      open_threads: ["沃沃追问千圣是否梦到过小彩，以及梦境是否更激烈"],
      last_world_event_at: "2026-06-12T07:42:35.680Z"
    }
  },
  {
    id: "gift-causality-2208",
    userMarker: "=== USER MESSAGE [2026-06-12T14:08:23.491Z] ===",
    memoryMarker: "=== MEMORY SNAPSHOT [2026-06-12T14:08:23.491Z] ===",
    bodyMarker: "=== TURN BODY [2026-06-12T14:08:25.768Z] ===",
    worldState: {
      location: "东京公寓客厅",
      activity: "用笔记本电脑浏览六个购物标签页，为伊芙挑生日礼物",
      awake_state: "awake",
      current_plan: "记下合适的礼物方向，今晚停止继续比较，明天再确认",
      open_threads: ["伊芙的生日礼物仍未定下来", "沃沃说要直接去问小彩且不发截图"],
      last_world_event_at: "2026-06-12T14:08:23.491Z"
    }
  }
];

function between(text, startMarker, endMarkers) {
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing marker: ${startMarker}`);
  const contentStart = start + startMarker.length;
  const ends = endMarkers
    .map(marker => text.indexOf(marker, contentStart))
    .filter(index => index >= 0);
  const end = ends.length ? Math.min(...ends) : text.length;
  return text.slice(contentStart, end).trim();
}

function extractSection(text, startMarker, endMarkers) {
  const start = text.indexOf(startMarker);
  if (start < 0) return "";
  const ends = endMarkers
    .map(marker => text.indexOf(marker, start + startMarker.length))
    .filter(index => index >= 0);
  const end = ends.length ? Math.min(...ends) : text.length;
  return text.slice(start, end).trim();
}

function parseJsonText(text) {
  const stripped = String(text || "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(stripped);
  } catch {
    let repaired = "";
    let inString = false;
    let escaped = false;
    for (const char of stripped) {
      if (inString && (char === "\n" || char === "\r" || char === "\t")) {
        repaired += char === "\n" ? "\\n" : char === "\r" ? "\\r" : "\\t";
        escaped = false;
        continue;
      }
      repaired += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\" && inString) {
        escaped = true;
      } else if (char === '"') {
        inString = !inString;
      }
    }
    return JSON.parse(repaired);
  }
}

function resolveClaudeExecutable() {
  if (!fs.existsSync(CLAUDE_SHIM)) throw new Error(`Claude CLI shim not found: ${CLAUDE_SHIM}`);
  const shim = fs.readFileSync(CLAUDE_SHIM, "utf8");
  const match = shim.match(/^"([^"]+\.exe)"/m);
  if (!match || !fs.existsSync(match[1])) throw new Error(`Claude executable not found via: ${CLAUDE_SHIM}`);
  return match[1];
}

function runClaude({ systemPrompt, prompt }) {
  const systemFile = path.join(OUTPUT_DIR, `.system-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(systemFile, systemPrompt, "utf8");
  const args = [
    "-p",
    "--bare",
    "--output-format", "json",
    "--permission-mode", "bypassPermissions",
    "--tools", "",
    "--strict-mcp-config",
    "--model", MODEL,
    "--no-session-persistence",
    "--append-system-prompt-file", systemFile
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(resolveClaudeExecutable(), args, {
      cwd: ROOT,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => proc.kill(), 300_000);
    proc.stdout.on("data", chunk => { stdout += chunk; });
    proc.stderr.on("data", chunk => { stderr += chunk; });
    proc.on("error", reject);
    proc.on("close", code => {
      clearTimeout(timer);
      fs.rmSync(systemFile, { force: true });
      if (code !== 0) {
        reject(new Error(`Claude exited ${code}: ${stderr.slice(-1000)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    proc.stdin.end(prompt, "utf8");
  });
}

const systemPrompt = `你现在直接扮演白鹭千圣，完成一次真实的微信私聊回复生成。这不是分析、评论或评分任务，不要评价自己的输出。

你必须在同一次思考中依次完成四件事：
1. inner_scenelet：先以第一人称写千圣此刻完整、自由、具体的内心声音。它可以展开，可以承认矛盾、欲望、不耐烦和不能说出口的内容，也可以自然判断哪些话会发出去、哪些不会。不要把它写成文学旁白或摘要。
2. visible_reply：随后写实际发送给沃沃的微信回复。它必须由刚才那份完整内心自然决定，而不是另起炉灶或概括 inner_scenelet。千圣可以选择透露、回避、嘴硬、转移或只说一部分；但如果 inner_scenelet 明确决定某个具体内容不会打出来，visible_reply 不得直接说出或近义复述该内容。只输出用户真正可见的消息，不解释生成过程。
3. world_state_patch：在回复之后记录本轮结束时的真实世界状态。不要为了填字段凭空推进时间、地点或活动。
4. follow_up_candidates：最后判断是否存在自然的后续主动消息机会。没有就输出空数组，不能为了完成任务硬造。

先做角色和回复，再做状态与 follow-up。后两项不能反过来把 visible_reply 写成报告、场景摘要或任务清单。

微信回复要求：中文、自然、口语化，以用户当前消息为中心；普通闲聊通常一两句，确有内容时可以展开。千圣可以温柔、锋利、短促、吐槽、嫌弃、拆穿，不固定为优雅得体。不要写总结、金句、漂亮独白，不使用“不是A而是B”式拔高。动作只在自然需要时用中文圆括号。不要出现任何系统、模型、提示词、JSON、数据库、session、pipeline 等机制词。

事实要求：只使用输入里已给出的公共事实和私人上下文，不联网，不调用任何工具，不补造会改变回复含义的公共事实。虚拟私人感受和生活细节可以自然生成，但必须符合已有场景和连续性。

只输出一个合法 JSON 对象，键必须严格按下列顺序出现，不要加 markdown：
{
  "inner_scenelet": "第一人称内心声音",
  "visible_reply": "实际发送的微信回复",
  "world_state_patch": {
    "location": "short current place",
    "activity": "short current activity",
    "awake_state": "awake|sleeping|light_sleep|just_woke|unknown",
    "current_plan": "next few hours only",
    "open_threads": ["short unresolved visible or hidden threads"],
    "last_world_event_at": "ISO string"
  },
  "follow_up_candidates": [
    {
      "scheduled_at": "ISO",
      "expires_at": "ISO",
      "message_intent": "简短描述将来发什么消息",
      "basis": "为什么届时自然",
      "cancel_if": ["可观察取消条件"]
    }
  ]
}`;

function buildInput(logText, profile, testCase) {
  const memory = between(logText, testCase.memoryMarker, [
    "=== INNER SCENELET",
    "=== SCENE STATE",
    testCase.bodyMarker
  ]);
  const body = between(logText, testCase.bodyMarker, ["=== STABLE STYLE"]);
  const recent = extractSection(body, "【近期对话】", ["【正在发生的事】"]);
  const arcs = extractSection(body, "【正在发生的事】", [
    "【隐藏中间层：inner_scenelet】",
    "【角色场景状态：scene_state】",
    "【关于角色自己】"
  ]);
  const rag = extractSection(body, "【关于角色自己】", ["【聊天风格】"]);
  const temporal = extractSection(body, "当前用户侧时间：", ["【当前聊天现实】"]);
  const weather = extractSection(body, "【当前天气】", ["（以上为实时天气数据"]);
  const currentMessage = between(logText, testCase.userMarker, [testCase.memoryMarker]);

  const prompt = [
    "【角色设定】",
    profile,
    "",
    "【当时的长期记忆快照】",
    memory,
    "",
    recent,
    "",
    arcs,
    "",
    rag,
    "",
    "【本轮开始前的 world_state】",
    JSON.stringify(testCase.worldState, null, 2),
    "",
    temporal,
    "",
    weather,
    "",
    "【当前用户消息】",
    currentMessage,
    "",
    "现在按规定顺序生成四个字段。不要评价，不要解释，不要使用工具。"
  ].filter(Boolean).join("\n");

  return { prompt, memory, recent, arcs, rag, temporal, weather, currentMessage };
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const logText = fs.readFileSync(LOG_FILE, "utf8");
const profiles = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8"));
const profile = profiles.templates?.["白鹭千圣"];
if (!profile) throw new Error("Missing 白鹭千圣 profile");
resolveClaudeExecutable();

const manifest = {
  created_at: beijingISO(),
  model: MODEL,
  calls: 4,
  session_persistence: false,
  tools: [],
  evaluation_by_model: false,
  output_order: ["inner_scenelet", "visible_reply", "world_state_patch", "follow_up_candidates"],
  cases: cases.map(item => item.id)
};
fs.writeFileSync(path.join(OUTPUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
fs.writeFileSync(path.join(OUTPUT_DIR, "system-prompt.txt"), systemPrompt, "utf8");

for (const testCase of cases) {
  const input = buildInput(logText, profile, testCase);
  fs.writeFileSync(
    path.join(OUTPUT_DIR, `${testCase.id}-input.json`),
    JSON.stringify({ case: testCase, systemPrompt, ...input }, null, 2),
    "utf8"
  );

  for (let run = 1; run <= 2; run += 1) {
    const outputFile = path.join(OUTPUT_DIR, `${testCase.id}-sample-${run}.json`);
    if (fs.existsSync(outputFile)) {
      process.stdout.write(`Skipping existing ${testCase.id} sample ${run}.\n`);
      continue;
    }
    process.stdout.write(`Running ${testCase.id} sample ${run}...\n`);
    const startedAt = beijingISO();
    const startedMs = Date.now();
    const raw = await runClaude({ systemPrompt, prompt: input.prompt });
    const outer = parseJsonText(raw.stdout);
    const resultText = outer.result ?? outer.message ?? outer.text ?? raw.stdout;
    fs.writeFileSync(
      path.join(OUTPUT_DIR, `${testCase.id}-sample-${run}-raw.txt`),
      String(resultText),
      "utf8"
    );
    let strictParseError = null;
    try {
      JSON.parse(String(resultText).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    } catch (error) {
      strictParseError = error.message;
    }
    const parsed = parseJsonText(resultText);
    const record = {
      case_id: testCase.id,
      sample: run,
      model: MODEL,
      started_at: startedAt,
      duration_ms: Date.now() - startedMs,
      session_persistence: false,
      tools_available: [],
      strict_parse_error: strictParseError,
      key_order: Object.keys(parsed),
      output: parsed,
      cli_metadata: {
        subtype: outer.subtype ?? null,
        is_error: outer.is_error ?? null,
        duration_ms: outer.duration_ms ?? null,
        duration_api_ms: outer.duration_api_ms ?? null,
        num_turns: outer.num_turns ?? null,
        session_id: outer.session_id ?? null,
        total_cost_usd: outer.total_cost_usd ?? null,
        usage: outer.usage ?? null,
        model_usage: outer.modelUsage ?? null
      },
      raw_cli_response: outer,
      stderr: raw.stderr
    };
    fs.writeFileSync(
      outputFile,
      JSON.stringify(record, null, 2),
      "utf8"
    );
  }
}

process.stdout.write(`Done. Artifacts: ${OUTPUT_DIR}\n`);
