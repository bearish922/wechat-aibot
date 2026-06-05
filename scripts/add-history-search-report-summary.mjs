import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: node scripts/add-history-search-report-summary.mjs <run-dir>");
  process.exit(1);
}

const reportPath = path.join(dir, "report.md");
const resultsPath = path.join(dir, "results.json");
const report = fs.readFileSync(reportPath, "utf8");
const data = JSON.parse(fs.readFileSync(resultsPath, "utf8"));

function visibleReply(result) {
  return result?.main?.parsed?.visible_reply || result?.main?.parsed?.reply || "";
}

function audit(result) {
  return result?.main?.parsed?.self_audit || {};
}

function usage(result) {
  return [result.scenelet, result.factPass, result.main].filter(Boolean).reduce((acc, call) => {
    for (const key of ["webSearch", "webFetch", "cost", "input", "output", "cacheRead", "cacheCreation"]) {
      acc[key] += Number(call.usage?.[key]) || 0;
    }
    acc.ms += Number(call.ms) || 0;
    return acc;
  }, { webSearch: 0, webFetch: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, ms: 0 });
}

const groups = new Map();
for (const result of data.allResults) {
  const group = groups.get(result.architecture) || { n: 0, webSearch: 0, webFetch: 0, cost: 0, ms: 0, fail: 0 };
  const u = usage(result);
  group.n += 1;
  group.webSearch += u.webSearch;
  group.webFetch += u.webFetch;
  group.cost += u.cost;
  group.ms += u.ms;
  if (!result.scenelet?.ok || !result.main?.ok || (result.factPass && !result.factPass.ok)) group.fail += 1;
  groups.set(result.architecture, group);
}

const lines = [];
lines.push("## 初步结论");
lines.push("");
lines.push("这轮专题实验比前一轮更接近真实运行：用的是历史真实消息，注入了最近可见上下文、profile、长期记忆、scenelet bridge、chatStyle、当前现场与检索规则。它仍然不是完整线上回放，因为没有复用真实会话 session，也没有真实发送消息；但对于“模型会不会搜索、怎么搜索、搜索后会不会仍然乱编”已经有判断价值。");
lines.push("");
lines.push("### 架构对比");
lines.push("");
for (const [name, group] of groups) {
  lines.push(`- ${name}: ${group.n} cases，WebSearch ${group.webSearch}，WebFetch ${group.webFetch}，失败 ${group.fail}，总成本约 $${group.cost.toFixed(2)}，总耗时约 ${(group.ms / 60_000).toFixed(1)} 分钟。`);
}
lines.push("");
lines.push("### 主要观察");
lines.push("");
lines.push("- `hidden_flag_fact_pass` 最像“先查证再说话”：濑户内寂听、又吉直树电台、きゅ～まい＊flower OCR 都能把可核验事实塞进 fact_pack，再交给主回复。缺点是贵，而且 fact pass 可能查得过多。");
lines.push("- `non_bare_searchable_scenelet` 的场景和回复常常更有生活感，且 scenelet 确实能真实调用 WebSearch；但它也更容易把搜索确认过的事实和角色内部视角混在一起，song OCR case 里又编出了“小彩录音棚重录七八遍”的不可核验细节，这是重点风险。");
lines.push("- `main_self_search` 能在主回复中自行搜索，成本最低；但它对 scenelet 里的暗示更敏感，book-setouchi-style 里搜索后仍然说“刚好看到她的连载”，说明只让主回复自己搜索还不够。");
lines.push("- no-search 控制样本表现正常：三个架构都没有搜索，回复也没有硬塞公共事实。");
lines.push("- 当前 Claude Code 工具使用并不是“不会搜”，而是需要放在非 bare 调用里才可靠。bare scenelet 适合标记，不适合承担实际搜索。");
lines.push("");
lines.push("### 值得继续验证的风险");
lines.push("");
lines.push("- 搜索后仍可能产生未被搜索支撑的“角色幕后细节”，尤其是原作/歌曲/录音现场这类模型很想补完的内容。需要把“公共事实搜索”和“角色私有生活想象”边界再拆细：作品元数据可查，角色在原作未明确的幕后细节不能因为查了作品就随便断言。");
lines.push("- fact pass 的查询数偏高，尤其 AI 产业 case 里 `hidden_flag_fact_pass` 到了 18 次 WebSearch。上线前需要一个轻量预算策略，例如只在 fact pass 内部最多 2-4 次搜索，除非用户明确要求深入查。");
lines.push("- 输出 JSON 解析仍有稳定性问题：`book-lemon-author-title` 的 bare scenelet 两个架构都 exit 1，主回复仍能跑，但说明 hidden call 的失败恢复还要继续看。");
lines.push("- main reply 的自审计不完全可信：有些 case 明明总调用里发生了搜索，主回复自审计仍写 `search_used=no` 或缺失字段。判断搜索是否发生必须以后端 usage 为准。");
lines.push("");
lines.push("### 当前偏向");
lines.push("");
lines.push("我目前更倾向下一步测试一种混合方案：普通 scenelet 继续 bare；让 scenelet 只输出 `needs_public_fact_check` 和少量查询建议；命中后进入一个有搜索预算的 fact pass；主回复优先使用 fact_pack，必要时才二次搜索。这样比全量 non-bare scenelet 稳，也比 main 自己判断更可控。");
lines.push("");

const marker = "## 总览";
const nextReport = report.includes(marker)
  ? report.replace(marker, `${lines.join("\n")}\n\n${marker}`)
  : `${lines.join("\n")}\n\n${report}`;

fs.writeFileSync(reportPath, nextReport, "utf8");
console.log(reportPath);
