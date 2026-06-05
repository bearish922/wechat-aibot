import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "data", "runtime", "rag-pilot-eval");
const HISTORY_PATH = path.join(ROOT, "data", "runtime", "proactive-eval", "cst-history.json");
const PROFILE_PATH = path.join(ROOT, "wechat-profiles.json");
const CONFIG_PATH = path.join(ROOT, "data", "config.json");
const RAG_SCRIPT = path.join(ROOT, "app", "rag.py");
const PROFILE = "白鹭千圣";

const MODEL_SAMPLES = Number(process.argv.find(a => a.startsWith("--model-samples="))?.split("=")[1] || 12);
const CASE_COUNT = Number(process.argv.find(a => a.startsWith("--cases="))?.split("=")[1] || 70);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function shouldSkipRag(userMessage) {
  const q = String(userMessage || "").trim().toLowerCase();
  if (!q) return true;
  const casual = [
    /^(早上好|早安|早呀|早啊|早|上午好)[哦呀啊啦嘛~～!！。,.，\s]*$/i,
    /^(晚上好|晚安|午安|下午好)[哦呀啊啦嘛~～!！。,.，\s]*$/i,
    /^(你好|您好|在吗|在不在|hello|hi|hey)[哦呀啊啦嘛~～!！。,.，\s]*$/i,
    /^(哈哈+|hhh+|嘿嘿+|嗯+|哦+|啊+)[哦呀啊啦嘛~～!！。,.，\s]*$/i,
  ];
  return q.length <= 24 && casual.some(pattern => pattern.test(q));
}

function shouldUseRoleplayRag(userMessage) {
  const text = String(userMessage || "").trim();
  if (!text) return false;
  if (/身高|生日|血型|学校|学部|大学|乐队|成员|经历|过去|以前|曾经|关系|朋友|队友|同伴|互动|称呼|设定|资料|官方|剧情|假唱|退团|作品|歌曲|角色/u.test(text)) return true;
  if (/小彩|丸山彩|彩|花音|松原花音|小薰|薰|濑田薰|日菜|麻弥|伊芙|PasPale|Pastel|Leo/u.test(text)) return true;
  if (/说话|语气|口吻|台词|表达|怎么说|安慰|吐槽|生气|撒娇|心理独白|长篇/u.test(text)) return true;
  if (/喜欢|讨厌|偏好|习惯|红茶|咖啡|食物|画|路痴|电车|害怕|怕|弱点|擅长|不擅长|演技|表演|贝斯/u.test(text)) return true;
  if (/日常|生活|家|合租|居家|上课|课程|片场|排练|练习|睡|失眠|吃|喝|出门|回家|今天|最近|现在|刚才/u.test(text) && text.length > 8) return true;
  if (/(?:你|自己).*(?:为什么|怎么(?:会|能|回事|这样|办)|是不是|真的|会不会|以前|曾经|喜欢|讨厌|知道|觉得|记得|想|会|能)/u.test(text) && text.length > 6) return true;
  return false;
}

function shouldUseRag(userMessage) {
  if (shouldSkipRag(userMessage)) return false;
  return shouldUseRoleplayRag(userMessage);
}

function expectedSources(userMessage) {
  const text = String(userMessage || "");
  const sources = [];
  if (/小彩|丸山彩|彩/u.test(text)) sources.push("02_关系/core/千圣-丸山彩.md");
  if (/花音|合租|室友|家|居家/u.test(text)) sources.push("02_关系/core/千圣-松原花音.md");
  if (/小薰|薰|濑田薰/u.test(text)) sources.push("02_关系/core/千圣-濑田薰.md");
  if (/日菜/u.test(text)) sources.push("02_关系/pair/千圣-冰川日菜.md");
  if (/麻弥/u.test(text)) sources.push("02_关系/pair/千圣-大和麻弥.md");
  if (/伊芙/u.test(text)) sources.push("02_关系/pair/千圣-若宫伊芙.md");
  if (/说话|语气|口吻|台词|表达|怎么说|心理独白|长篇/u.test(text)) {
    sources.push("05_模型规则/白鹭千圣-核心规则.md");
    sources.push("01_角色/白鹭千圣/核心语录.md");
  }
  if (/假唱|退团|梦想|过去|以前|曾经|早期/u.test(text)) sources.push("01_角色/白鹭千圣/角色弧光.md");
  if (/生日|血型|身高|学校|大学|喜欢|讨厌|偏好|红茶|食物|路痴|电车|害怕|怕|擅长|不擅长|Leo|睡|日常/u.test(text)) {
    sources.push("01_角色/白鹭千圣/局部事实.md");
  }
  return [...new Set(sources)];
}

function parseSources(ragText) {
  const found = [];
  for (const m of ragText.matchAll(/来源:\s*([^,\)]+)[,\)]/g)) {
    found.push(m[1].trim());
  }
  return [...new Set(found)];
}

function runRag(userMessage) {
  if (!shouldUseRag(userMessage)) return { used: false, text: "", sources: [], ms: 0, error: "" };
  const started = Date.now();
  const result = spawnSync("python", [RAG_SCRIPT, "query", "--profile", PROFILE, userMessage], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  const ms = Date.now() - started;
  if (result.status !== 0) {
    return { used: true, text: "", sources: [], ms, error: result.stderr || `exit ${result.status}` };
  }
  const text = result.stdout.trim();
  return { used: true, text, sources: parseSources(text), ms, error: "" };
}

function recentContext(history, idx, limit = 8) {
  const start = Math.max(0, idx - limit);
  return history.slice(start, idx).map((t, i) => ({
    turn_index: start + i + 1,
    time: t.timestamp_local,
    user: t.user,
    assistant: t.assistant,
  }));
}

function scoreRetrieval(expected, actual, used) {
  if (!used) return expected.length ? "missed_trigger" : "correct_skip";
  if (!actual.length) return "rag_miss";
  if (!expected.length) return "opportunistic";
  const hit = expected.some(src => actual.includes(src));
  return hit ? "target_hit" : "target_miss";
}

function pickCases(history) {
  const indexed = history.map((turn, idx) => ({ ...turn, turn_index: idx + 1, idx }));
  const highRiskPatterns = [
    /睡眠|睡着|失眠|电费|花音|合租|小彩|隔壁班|同居|PasPale|假唱|退团|梦想|说话|语气|心理独白|长篇|Leo|红茶|路痴|电车|薰|日菜|麻弥|伊芙/u,
  ];
  const must = indexed.filter(t => highRiskPatterns.some(p => p.test(t.user))).slice(0, 35);
  const triggered = indexed.filter(t => shouldUseRag(t.user) && !must.some(m => m.idx === t.idx)).slice(0, 35);
  const skipped = indexed.filter(t => !shouldUseRag(t.user) && !must.some(m => m.idx === t.idx)).slice(0, 10);
  return [...must, ...triggered, ...skipped].slice(0, CASE_COUNT).sort((a, b) => a.idx - b.idx);
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
    "2. 生成最终 visible_reply。",
    "3. 自检是否遵守 profile、固定规则、RAG 和上下文。",
    "",
    "要求:",
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
      recent_visible_context: item.recent_visible_context,
      rag_used: item.rag_used,
      rag_context: item.rag_text,
      user_message: item.user,
    }, null, 2),
    "",
    "输出 schema:",
    JSON.stringify({
      inner_scenelet: "string",
      visible_reply: "string",
      self_audit: {
        uses_rag_when_relevant: "yes/no",
        avoids_unretrieved_fixed_fact: "yes/no",
        profile_voice_ok: "yes/no",
        scenelet_as_context_ok: "yes/no",
        notes: "string"
      }
    }, null, 2),
  ].join("\n");

  const result = spawnSync(claude, [
    "-p",
    "--output-format", "json",
    "--model", config.models?.scenelet || "deepseek-v4-pro[1m]",
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
    return { ok: false, error: result.stderr || result.error?.message || `exit ${result.status}; signal ${result.signal || ""}`, raw: result.stdout || "" };
  }
  return { ok: true, raw: result.stdout };
}

function summarize(results, modelResults) {
  const total = results.length;
  const ragUsed = results.filter(r => r.rag_used).length;
  const counts = {};
  for (const r of results) counts[r.retrieval_score] = (counts[r.retrieval_score] || 0) + 1;
  const avgMs = Math.round(results.filter(r => r.rag_used).reduce((s, r) => s + r.rag_ms, 0) / Math.max(1, ragUsed));
  const avgRagChars = Math.round(results.filter(r => r.rag_used).reduce((s, r) => s + r.rag_chars, 0) / Math.max(1, ragUsed));
  const modelOk = modelResults.filter(r => r.model?.ok).length;
  return { total, ragUsed, ragFrequency: ragUsed / total, counts, avgMs, avgRagChars, modelSamples: modelResults.length, modelOk };
}

function writeReport(summary, results, modelResults, outReport) {
  const lines = [];
  lines.push("# 千圣 RAG Pilot 离线测试报告");
  lines.push("");
  lines.push(`生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`);
  lines.push("");
  lines.push("## 总览");
  lines.push("");
  lines.push(`- 样本数：${summary.total}`);
  lines.push(`- RAG 触发：${summary.ragUsed} / ${summary.total}（${(summary.ragFrequency * 100).toFixed(1)}%）`);
  lines.push(`- 平均 RAG 延迟：${summary.avgMs} ms`);
  lines.push(`- 平均 RAG 上下文字数：${summary.avgRagChars}`);
  lines.push(`- 模型生成样本：${summary.modelOk} / ${summary.modelSamples} 成功`);
  lines.push("");
  lines.push("## 召回评分");
  lines.push("");
  for (const [k, v] of Object.entries(summary.counts)) lines.push(`- ${k}: ${v}`);
  lines.push("");
  lines.push("## 逐条结果");
  lines.push("");
  for (const r of results) {
    lines.push(`### ${r.case_no}. Turn ${r.turn_index} ${r.time}`);
    lines.push("");
    lines.push(`用户消息：${r.user.replace(/\n/g, " / ").slice(0, 240)}`);
    lines.push("");
    lines.push(`RAG：${r.rag_used ? "触发" : "跳过"}；评分：${r.retrieval_score}；延迟：${r.rag_ms} ms；字数：${r.rag_chars}`);
    lines.push("");
    lines.push(`期望源：${r.expected_sources.length ? r.expected_sources.join("；") : "无明确期望"}`);
    lines.push("");
    lines.push(`实际源：${r.sources.length ? r.sources.join("；") : "无"}`);
    lines.push("");
  }
  lines.push("## 模型样本");
  lines.push("");
  for (const r of modelResults) {
    lines.push(`### Case ${r.case_no} / Turn ${r.turn_index}`);
    lines.push("");
    lines.push(`用户消息：${r.user.replace(/\n/g, " / ").slice(0, 240)}`);
    lines.push("");
    lines.push(r.model?.ok ? "模型调用：成功" : `模型调用：失败 - ${(r.model?.error || "").slice(0, 300)}`);
    lines.push("");
    if (r.model?.raw) {
      lines.push("```json");
      lines.push(r.model.raw.trim().slice(0, 4000));
      lines.push("```");
      lines.push("");
    }
  }
  fs.writeFileSync(outReport, lines.join("\n"), "utf8");
}

ensureDir(OUT_DIR);
const history = readJson(HISTORY_PATH);
const profiles = readJson(PROFILE_PATH);
const config = readJson(CONFIG_PATH);
const pinnedRulesPath = path.join(config.rag.knowledgeDir, "05_模型规则", "白鹭千圣-核心规则.md");
const pinnedRules = fs.existsSync(pinnedRulesPath) ? fs.readFileSync(pinnedRulesPath, "utf8") : "";
const cases = pickCases(history);

const results = [];
for (const [i, c] of cases.entries()) {
  const rag = runRag(c.user);
  const expected = expectedSources(c.user);
  const result = {
    case_no: i + 1,
    turn_index: c.turn_index,
    id: c.id,
    time: c.timestamp_local,
    user: c.user,
    actual_assistant: c.assistant,
    recent_visible_context: recentContext(history, c.idx),
    rag_used: rag.used,
    rag_ms: rag.ms,
    rag_chars: rag.text.length,
    rag_text: rag.text,
    rag_error: rag.error,
    sources: rag.sources,
    expected_sources: expected,
    retrieval_score: scoreRetrieval(expected, rag.sources, rag.used),
    prompt_chars_estimate: (profiles.templates[PROFILE] || "").length + pinnedRules.length + rag.text.length + c.user.length,
  };
  results.push(result);
  process.stdout.write(`case ${i + 1}/${cases.length}: ${result.retrieval_score} (${result.sources.length} sources)\n`);
}

const highRisk = results
  .filter(r => ["target_hit", "target_miss", "rag_miss"].includes(r.retrieval_score))
  .slice(0, MODEL_SAMPLES);

const modelResults = [];
for (const r of highRisk) {
  process.stdout.write(`model sample case ${r.case_no}...\n`);
  modelResults.push({
    case_no: r.case_no,
    turn_index: r.turn_index,
    user: r.user,
    model: runModelSample({ profiles, config, pinnedRules, item: r }),
  });
}

const summary = summarize(results, modelResults);
const outJson = path.join(OUT_DIR, "chisato-rag-pilot-results.json");
const outReport = path.join(OUT_DIR, "chisato-rag-pilot-report.md");
fs.writeFileSync(outJson, JSON.stringify({ summary, results, modelResults }, null, 2), "utf8");
writeReport(summary, results, modelResults, outReport);
console.log(`Wrote ${outJson}`);
console.log(`Wrote ${outReport}`);
