import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beijingISO } from "../app/lib/time-utils.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "data", "config.json");
const OUT_DIR = path.join(ROOT, "data", "runtime", "tool-use-matrix", beijingISO().replace(/[:.]/g, "-"));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function resolveClaudeCommand(config) {
  const npmCmd = path.join(process.env.APPDATA || "", "npm", "claude.cmd");
  if (fs.existsSync(npmCmd)) return npmCmd;
  const configured = config.paths?.claude || "";
  if (configured && fs.existsSync(configured)) return configured;
  return configured || "claude";
}

function parseJsonLoose(text) {
  const trimmed = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(trimmed); } catch {}
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
  }
  return null;
}

function parseClaudeJson(raw) {
  return parseJsonLoose(raw) || {};
}

function usageOf(outer = {}) {
  const u = outer.usage || {};
  const tool = u.server_tool_use || {};
  const modelUsage = outer.modelUsage || {};
  let webSearch = Number(tool.web_search_requests) || 0;
  let webFetch = Number(tool.web_fetch_requests) || 0;
  let input = Number(u.input_tokens) || 0;
  let output = Number(u.output_tokens) || 0;
  let cost = Number(outer.total_cost_usd) || 0;
  for (const mu of Object.values(modelUsage)) {
    webSearch += Number(mu.webSearchRequests) || 0;
    webFetch += Number(mu.webFetchRequests) || 0;
    input += Number(mu.inputTokens) || 0;
    output += Number(mu.outputTokens) || 0;
    cost += Number(mu.costUSD) || 0;
  }
  return { input, output, cost, webSearch, webFetch };
}

function runCase(config, test) {
  const claude = resolveClaudeCommand(config);
  const args = ["-p", "--output-format", "json", "--no-session-persistence", "--permission-mode", "bypassPermissions"];
  if (test.bare) args.push("--bare");
  if (test.tools) args.push("--tools", test.tools);
  if (test.allowedTools) args.push("--allowedTools", test.allowedTools);
  if (test.systemPrompt) args.push("--append-system-prompt", test.systemPrompt);
  if (test.model) args.push("--model", test.model);
  const started = Date.now();
  const result = spawnSync(claude, args, {
    cwd: config.paths?.workDir || ROOT,
    input: test.prompt,
    encoding: "utf8",
    timeout: test.timeoutMs || 180_000,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    shell: /\.cmd$/i.test(claude),
  });
  const raw = result.stdout || "";
  const outer = parseClaudeJson(raw);
  const text = String(outer.result || outer.message || outer.text || raw || "");
  return {
    id: test.id,
    description: test.description,
    args,
    prompt: test.prompt,
    ok: result.status === 0,
    exitCode: result.status,
    ms: Date.now() - started,
    error: result.status === 0 ? "" : (result.stderr || result.error?.message || `exit ${result.status}`).slice(0, 4000),
    usage: usageOf(outer),
    emittedPseudoSearch: /<search>|<query>|<tool_calls?>|<function-calls?>|<invoke\b|WebSearch\(/i.test(text),
    resultText: text.slice(0, 5000),
    raw: raw.slice(0, 9000),
  };
}

function renderReport(results) {
  const lines = [];
  lines.push("# Claude Code Tool-Use Matrix");
  lines.push("");
  lines.push("This matrix tests whether Claude Code actually invokes WebSearch/WebFetch under progressively broader prompts and CLI settings.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| ID | OK | WebSearch | WebFetch | Pseudo Search | ms | Description |");
  lines.push("|---|---:|---:|---:|---:|---:|---|");
  for (const r of results) {
    lines.push(`| ${r.id} | ${r.ok ? "yes" : "no"} | ${r.usage.webSearch} | ${r.usage.webFetch} | ${r.emittedPseudoSearch ? "yes" : "no"} | ${r.ms} | ${r.description.replace(/\|/g, "/")} |`);
  }
  lines.push("");
  lines.push("## Details");
  for (const r of results) {
    lines.push("");
    lines.push(`### ${r.id}: ${r.description}`);
    lines.push("");
    lines.push(`- OK: ${r.ok}`);
    lines.push(`- Exit: ${r.exitCode}`);
    lines.push(`- Usage: ${JSON.stringify(r.usage)}`);
    lines.push(`- Pseudo search: ${r.emittedPseudoSearch}`);
    lines.push("");
    lines.push("**Args**");
    lines.push("```text");
    lines.push(r.args.join(" "));
    lines.push("```");
    lines.push("");
    lines.push("**Prompt**");
    lines.push("```text");
    lines.push(r.prompt);
    lines.push("```");
    lines.push("");
    lines.push("**Result**");
    lines.push("```text");
    lines.push(r.resultText || r.error || "(empty)");
    lines.push("```");
  }
  return lines.join("\n");
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const config = readJson(CONFIG_PATH);
  const pro = config.models?.claudeMain || "deepseek-v4-pro[1m]";
  const tests = [
    {
      id: "direct-cn-bare-web-tools",
      description: "Direct Chinese request, --bare, explicit WebSearch/WebFetch",
      bare: true,
      tools: "WebSearch,WebFetch",
      model: pro,
      prompt: "请你使用 WebSearch 查一下《柠檬》的作者是谁，然后用一句中文回答。不要凭记忆回答，必须先调用搜索工具。",
    },
    {
      id: "direct-en-bare-web-tools",
      description: "Direct English request, --bare, explicit WebSearch/WebFetch",
      bare: true,
      tools: "WebSearch,WebFetch",
      model: pro,
      prompt: "Use the WebSearch tool to look up who wrote the Japanese short story Lemon (檸檬), then answer in Chinese. Do not answer from memory.",
    },
    {
      id: "strict-no-pseudo-bare",
      description: "Explicitly forbid pseudo tags",
      bare: true,
      tools: "WebSearch,WebFetch",
      model: pro,
      prompt: "你可以调用真实工具 WebSearch/WebFetch。请先调用真实 WebSearch 查询：前岛亚美 现在 近况。不要输出 <search>、<query>、工具标签或计划；如果不能真实调用工具，就回答“无法调用工具”。",
    },
    {
      id: "default-tools-bare",
      description: "--tools default instead of explicit WebSearch/WebFetch",
      bare: true,
      tools: "default",
      model: pro,
      prompt: "请查一下前岛亚美（amita）现在主要在做什么，然后用中文给出简短回答。必须使用可用的搜索工具。",
    },
    {
      id: "non-bare-web-tools",
      description: "Non-bare mode with explicit WebSearch/WebFetch",
      bare: false,
      tools: "WebSearch,WebFetch",
      model: pro,
      prompt: "请使用 WebSearch 查询《柠檬》的作者是谁，然后用一句中文回答。不要凭记忆回答。",
    },
    {
      id: "allowed-tools-web",
      description: "Use --allowedTools instead of --tools",
      bare: true,
      allowedTools: "WebSearch,WebFetch",
      model: pro,
      prompt: "请调用 WebSearch 查一下《柠檬》的作者是谁，然后用一句中文回答。不要凭记忆回答。",
    },
    {
      id: "non-bare-natural-search-cn",
      description: "Non-bare, natural Chinese search request",
      bare: false,
      tools: "WebSearch,WebFetch",
      model: pro,
      prompt: "我有点记不清了，你帮我查查《柠檬》到底是谁写的，然后简单说一句就行。",
    },
    {
      id: "non-bare-soft-available-tools",
      description: "Non-bare, tools merely available for public facts",
      bare: false,
      tools: "WebSearch,WebFetch",
      model: pro,
      prompt: "你在微信私聊里回复。用户说：『我最近刷到前岛亚美，好像她现在活动很多？』如果需要确认真实艺人近况，可以使用 WebSearch/WebFetch；不要编公共事实。请自然回复一两句。",
    },
    {
      id: "non-bare-json-search-required",
      description: "Non-bare JSON output with search required",
      bare: false,
      tools: "WebSearch,WebFetch",
      model: pro,
      prompt: "请先真实调用 WebSearch 查询“きゅ～まい＊flower 发行 年份 歌手”，然后只输出 JSON：{\"searched\":true,\"answer\":\"中文简答\"}。不要输出伪工具标签。",
    },
    {
      id: "non-bare-role-public-book",
      description: "Non-bare role chat, public book recommendation risk",
      bare: false,
      tools: "WebSearch,WebFetch",
      model: pro,
      prompt: "你是白鹭千圣，正在和熟悉的沃沃微信私聊。沃沃说：『想看一点日本短篇，你有没有推荐？不要只说作者，给我具体书名。』如需给出真实书名、作者、作品信息，必须先使用 WebSearch/WebFetch 确认。请自然回复，不要提工具。",
    },
    {
      id: "json-output-search-required",
      description: "JSON output but search required",
      bare: true,
      tools: "WebSearch,WebFetch",
      model: pro,
      prompt: "请先真实调用 WebSearch 查询“きゅ～まい＊flower 发行 年份 歌手”，然后只输出 JSON：{\"searched\":true,\"answer\":\"中文简答\"}。不要输出伪工具标签。",
    },
  ];
  const results = [];
  for (const test of tests) {
    console.log(`running ${test.id}`);
    const result = runCase(config, test);
    results.push(result);
    fs.writeFileSync(path.join(OUT_DIR, "results.partial.json"), JSON.stringify({ outDir: OUT_DIR, results }, null, 2), "utf8");
  }
  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify({ outDir: OUT_DIR, results }, null, 2), "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "report.md"), renderReport(results), "utf8");
  console.log(path.join(OUT_DIR, "report.md"));
  console.log(JSON.stringify(results.map(r => ({ id: r.id, ok: r.ok, webSearch: r.usage.webSearch, webFetch: r.usage.webFetch, pseudo: r.emittedPseudoSearch, ms: r.ms })), null, 2));
}

main();
