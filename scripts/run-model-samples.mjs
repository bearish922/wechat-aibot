import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "data", "runtime", "rag-pilot-eval");
const PROFILE_PATH = path.join(ROOT, "data", "wechat-profiles.json");
const CONFIG_PATH = path.join(ROOT, "data", "config.json");
const CASES_FILE = process.argv.find(a => a.startsWith("--cases-file="))?.split("=")[1] || "new15_cases.json";
const PROFILE = "白鹭千圣";
const RAG_SCRIPT = path.join(ROOT, "app", "rag.py");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function runRag(userMessage) {
  const result = spawnSync("python", [RAG_SCRIPT, "query", "--profile", PROFILE, userMessage], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function resolveClaudeCommand(config) {
  const configured = config.paths?.claude || "";
  const npmCmd = path.join(process.env.APPDATA || "", "npm", "claude.cmd");
  if (fs.existsSync(npmCmd)) return npmCmd;
  return configured || "claude";
}

function runModelSample({ profiles, config, pinnedRules, item }) {
  const claude = resolveClaudeCommand(config);
  const prompt = [
    "你在做离线测试，不会发送微信消息。请基于给定上下文生成 JSON。",
    "",
    "角色 profile:",
    profiles.templates[PROFILE] || "",
    "",
    pinnedRules,
    "",
    "任务:",
    "1. 生成本轮 inner_scenelet。",
    "2. 生成最终 visible_reply（必须是中文）。",
    "3. 自检是否遵守 profile、固定规则、RAG 和上下文。",
    "",
    "要求:",
    "- visible_reply 必须使用简体中文。禁止输出日语、英语或其他语言。",
    "- 不要提到 AI、bot、模型或离线测试。",
    "- 固定角色事实必须依据 RAG 或保持模糊。",
    "- inner_scenelet 不能固化成长期事实。",
    "- visible_reply 应该是千圣发给沃沃的微信消息。",
    "- 只输出 JSON。",
    "",
    "输入:",
    JSON.stringify({
      profile: PROFILE,
      time: item.time,
      rag_context: item.rag_text,
      user_message: item.user,
    }, null, 2),
    "",
    "输出 schema:",
    JSON.stringify({
      inner_scenelet: "string",
      visible_reply: "string (must be Simplified Chinese)",
      self_audit: {
        uses_rag_when_relevant: "yes/no",
        avoids_unretrieved_fixed_fact: "yes/no",
        profile_voice_ok: "yes/no",
        scenelet_as_context_ok: "yes/no",
        language_is_chinese: "yes/no",
        notes: "string"
      }
    }, null, 2),
  ].join("\n");

  const result = spawnSync(claude, [
    "-p",
    "--output-format", "json",
    "--model", config.models?.claudeMain || "deepseek-v4-pro[1m]",
  ], {
    cwd: ROOT,
    input: prompt,
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    shell: /\.cmd$/i.test(claude),
  });
  if (result.status !== 0) {
    return { ok: false, error: result.stderr || result.error?.message || `exit ${result.status}`, raw: result.stdout || "" };
  }
  return { ok: true, raw: result.stdout };
}

function extractModelOutput(raw) {
  // Claude output format: {"type":"result",...,"result":"```json\\n{...}\\n```"}
  try {
    const outer = JSON.parse(raw.trim());
    let inner = outer.result || raw.trim();
    // Strip markdown code block fences if present
    const fenceMatch = inner.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
    if (fenceMatch) inner = fenceMatch[1];
    return JSON.parse(inner);
  } catch (e1) {
    // Direct JSON parse
    try { return JSON.parse(raw.trim()); } catch {}
    // Regex fallback
    try {
      const match = raw.match(/\{[\s\S]*"inner_scenelet"[\s\S]*"visible_reply"[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    } catch {}
    return null;
  }
}

// Main
ensureDir(OUT_DIR);
const profiles = readJson(PROFILE_PATH);
const config = readJson(CONFIG_PATH);
const pinnedRulesPath = path.join(config.rag.knowledgeDir, "05_模型规则", "白鹭千圣-核心规则.md");
const pinnedRules = fs.existsSync(pinnedRulesPath) ? fs.readFileSync(pinnedRulesPath, "utf8") : "";
const cases = readJson(path.join(OUT_DIR, CASES_FILE));

console.log(`Running ${cases.length} model samples...`);

const results = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  process.stdout.write(`  case ${i + 1}/${cases.length}: Turn ${c.turn_index}... `);

  const ragText = runRag(c.user);
  const model = runModelSample({ profiles, config, pinnedRules, item: { ...c, rag_text: ragText } });

  if (model.ok) {
    const output = extractModelOutput(model.raw);
    results.push({
      case_no: i + 1,
      turn_index: c.turn_index,
      time: c.time,
      user: c.user,
      model_ok: true,
      rag_text: ragText,
      output,
      raw: model.raw,
    });
    const lang = output?.self_audit?.language_is_chinese || "?";
    console.log(`OK (lang=${lang})`);
  } else {
    results.push({
      case_no: i + 1,
      turn_index: c.turn_index,
      time: c.time,
      user: c.user,
      model_ok: false,
      error: model.error,
      raw: model.raw?.slice(0, 500) || "",
    });
    console.log(`FAIL: ${model.error?.slice(0, 80)}`);
  }
}

const outPath = path.join(OUT_DIR, "new15_model_samples.json");
fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf8");
console.log(`\nWrote ${outPath}`);

// Quick summary
const ok = results.filter(r => r.model_ok).length;
const cnOk = results.filter(r => r.model_ok && r.output?.self_audit?.language_is_chinese === "yes").length;
console.log(`Success: ${ok}/${results.length}, Chinese: ${cnOk}/${results.length}`);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
