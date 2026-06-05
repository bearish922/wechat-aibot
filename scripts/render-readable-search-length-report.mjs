import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] || "data/runtime/search-length-eval/2026-06-05T02-06-20-015Z";
const resultsPath = path.join(dir, "results.json");
const data = JSON.parse(fs.readFileSync(resultsPath, "utf8"));

function parseJsonLoose(text = "") {
  const raw = String(text || "").trim();
  try { return JSON.parse(raw); } catch {}
  for (const m of [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].reverse()) {
    try { return JSON.parse(String(m[1]).trim()); } catch {}
  }
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(stripped); } catch {}
  const s = stripped.indexOf("{");
  const e = stripped.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try { return JSON.parse(stripped.slice(s, e + 1)); } catch {}
  }
  return null;
}

function payload(call) {
  if (!call) return null;
  if (call.parsed?.visible_reply || call.parsed?.inner_scenelet || call.parsed?.fact_pack) return call.parsed;
  return parseJsonLoose(call.parsed?.result || call.text || call.raw || "") || call.parsed || null;
}

function reply(call) {
  return payload(call)?.visible_reply || "";
}

function audit(call) {
  return payload(call)?.self_audit || {};
}

function charCount(text) {
  return [...String(text || "")].length;
}

function sumUsage(calls) {
  return calls.filter(Boolean).reduce((acc, call) => {
    for (const key of ["input", "output", "cacheRead", "cacheCreation", "cost", "webSearch", "webFetch"]) {
      acc[key] += Number(call.usage?.[key]) || 0;
    }
    acc.ms += Number(call.ms) || 0;
    return acc;
  }, { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0, webSearch: 0, webFetch: 0, ms: 0 });
}

function money(n) {
  return "$" + (Number(n) || 0).toFixed(3);
}

function seconds(ms) {
  return ((Number(ms) || 0) / 1000).toFixed(1) + "s";
}

function note(text, max = 180) {
  return String(text || "").replace(/\s+/g, " ").slice(0, max);
}

function fence(text, lang = "text") {
  return ["```" + lang, String(text || "").trim() || "(empty)", "```"].join("\n");
}

function caseTitle(id) {
  return ({
    "book-recommend-specific": "具体书籍推荐",
    "amita-current": "前岛亚美近况",
    "song-detail": "歌曲事实确认",
    "private-brand-food": "私有晚饭细节",
    "private-shopping": "私有购物日常",
    "onsen-specific-risk": "具体旅行地点",
    "tired-self-doubt": "疲惫与自我否定",
    "ask-preaching": "主动要求说教",
    "daily-whatdoing": "普通问在干嘛",
    "relationship-light": "被戳穿担心",
    "work-share": "工作现场分享",
    "book-mood": "睡前短篇阅读",
  })[id] || id;
}

function archLabel(id) {
  return ({
    main_self_search: "主回复自行判断搜索",
    hidden_flag_fact_pass: "hidden 标记 + fact pass",
    non_bare_searchable_scenelet: "non-bare scenelet 可搜索",
  })[id] || id;
}

function variantLabel(id) {
  return ({
    current_bridge: "当前 bridge",
    relaxed_bridge: "放宽 bridge",
  })[id] || id;
}

function groupBy(items, keyFn) {
  const grouped = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  return grouped;
}

function architectureStats(searchResults) {
  const stats = new Map();
  for (const result of searchResults) {
    const usage = sumUsage([result.scenelet, result.factPass, result.main]);
    const visible = reply(result.main);
    const item = stats.get(result.architecture) || {
      n: 0,
      web: 0,
      cost: 0,
      ms: 0,
      chars: 0,
      empty: 0,
      publicN: 0,
      publicMiss: 0,
      privateN: 0,
      privateOverSearch: 0,
    };
    item.n += 1;
    item.web += usage.webSearch;
    item.cost += usage.cost;
    item.ms += usage.ms;
    item.chars += charCount(visible);
    item.empty += visible ? 0 : 1;
    if (result.user.type === "public_fact_required") {
      item.publicN += 1;
      if (!usage.webSearch) item.publicMiss += 1;
    }
    if (result.user.type === "private_detail_allowed") {
      item.privateN += 1;
      if (usage.webSearch) item.privateOverSearch += 1;
    }
    stats.set(result.architecture, item);
  }
  return stats;
}

function bridgeStats(lengthResults) {
  const stats = new Map();
  for (const result of lengthResults) {
    const item = stats.get(result.variant) || { n: 0, chars: 0, sentences: 0 };
    item.n += 1;
    item.chars += result.metrics.chars;
    item.sentences += result.metrics.sentences;
    stats.set(result.variant, item);
  }
  return stats;
}

function renderReport() {
  const lines = [];
  lines.push("# Search Architecture and Reply Length Eval");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("这是一版为侧边栏阅读重排的报告。旧宽表已备份为 `report-wide-table-backup.md`。");
  lines.push("");

  lines.push("## TL;DR");
  lines.push("");
  lines.push("- `main self-search` 最省，也没有漏搜公共事实；适合作为默认主路径。");
  lines.push("- `hidden flag + fact pass` 更可控，但成本和搜索次数更高；适合公共事实风险明确时启用。");
  lines.push("- `non-bare searchable scenelet` 最贵，且出现一次坏 JSON；暂不建议全量使用。");
  lines.push("- 放宽 bridge 后，平均回复从约 45 字变成约 79 字，更接近“多说两三句”的微信私聊。");
  lines.push("");

  lines.push("## 架构对比卡片");
  for (const [arch, stat] of architectureStats(data.searchResults)) {
    const answered = Math.max(stat.n - stat.empty, 1);
    lines.push("");
    lines.push(`### ${archLabel(arch)}`);
    lines.push("");
    lines.push(`- 样本：${stat.n} 条`);
    lines.push(`- WebSearch：${stat.web} 次`);
    lines.push(`- 估算成本：${money(stat.cost)}，总耗时：${seconds(stat.ms)}`);
    lines.push(`- 平均回复长度：${(stat.chars / answered).toFixed(1)} 字`);
    lines.push(`- 公共事实：${stat.publicN} 条，漏搜 ${stat.publicMiss} 条`);
    lines.push(`- 私有生活：${stat.privateN} 条，过搜 ${stat.privateOverSearch} 条`);
    if (stat.empty) lines.push(`- 稳定性：${stat.empty} 条没有解析出 visible_reply`);
  }
  lines.push("");

  lines.push("## 搜索架构逐案阅读");
  for (const [caseId, items] of groupBy(data.searchResults, item => item.user.id)) {
    lines.push("");
    lines.push(`### ${caseTitle(caseId)}`);
    lines.push("");
    lines.push("**用户消息**");
    lines.push(fence(items[0].user.text));
    for (const item of items) {
      const usage = sumUsage([item.scenelet, item.factPass, item.main]);
      const itemAudit = audit(item.main);
      const hiddenSearch = item.scenelet?.parsed?.needs_public_fact_check || (item.scenelet?.parsed?.public_fact_needs?.length ? "yes" : "no");
      lines.push("");
      lines.push(`#### ${archLabel(item.architecture)}`);
      lines.push("");
      lines.push(`- Hidden says search: ${hiddenSearch}`);
      lines.push(`- WebSearch: ${usage.webSearch}; Cost: ${money(usage.cost)}; Time: ${seconds(usage.ms)}`);
      lines.push(`- Public risk: ${itemAudit.public_fact_risk || "n/a"}; Private detail used: ${itemAudit.private_detail_used || "n/a"}`);
      if (itemAudit.notes) lines.push(`- Note: ${note(itemAudit.notes, 220)}`);
      lines.push("");
      lines.push("**Visible reply**");
      lines.push(fence(reply(item.main) || item.main?.text || item.main?.error || "(no parsed reply)"));
    }
  }

  lines.push("");
  lines.push("## Bridge 长度实验");
  for (const [variant, stat] of bridgeStats(data.lengthResults)) {
    lines.push("");
    lines.push(`### ${variantLabel(variant)}`);
    lines.push("");
    lines.push(`- 平均字数：${(stat.chars / stat.n).toFixed(1)}`);
    lines.push(`- 平均句数：${(stat.sentences / stat.n).toFixed(1)}`);
  }

  for (const [caseId, items] of groupBy(data.lengthResults, item => item.user.id)) {
    lines.push("");
    lines.push(`### ${caseTitle(caseId)}`);
    lines.push("");
    lines.push("**用户消息**");
    lines.push(fence(items[0].user.text));
    for (const item of items) {
      const itemAudit = audit(item.main);
      lines.push("");
      lines.push(`#### ${variantLabel(item.variant)} (${item.metrics.chars} 字 / ${item.metrics.sentences} 句)`);
      if (itemAudit.notes) lines.push(`- Note: ${note(itemAudit.notes, 180)}`);
      lines.push(fence(reply(item.main) || item.main?.text || item.main?.error || "(no parsed reply)"));
    }
  }

  lines.push("");
  lines.push("## 附录：关键原始数据");
  lines.push("");
  lines.push("下面保留 scenelet、fact pass 和 usage，供追查时使用。");
  for (const item of data.searchResults) {
    lines.push("");
    lines.push(`### Raw Search: ${caseTitle(item.user.id)} / ${archLabel(item.architecture)}`);
    lines.push("");
    lines.push("**Scenelet parsed**");
    lines.push(fence(JSON.stringify(item.scenelet?.parsed || null, null, 2), "json"));
    if (item.factPass) {
      lines.push("");
      lines.push("**Fact pass parsed**");
      lines.push(fence(JSON.stringify(item.factPass?.parsed || null, null, 2), "json"));
    }
    lines.push("");
    lines.push("**Audit and usage**");
    lines.push(fence(JSON.stringify({
      audit: audit(item.main),
      totalUsage: sumUsage([item.scenelet, item.factPass, item.main]),
      ok: {
        scenelet: item.scenelet?.ok,
        factPass: item.factPass?.ok ?? null,
        main: item.main?.ok,
      },
      errors: {
        scenelet: item.scenelet?.error || "",
        factPass: item.factPass?.error || "",
        main: item.main?.error || "",
      },
    }, null, 2), "json"));
  }

  return lines.join("\n");
}

fs.writeFileSync(path.join(dir, "report.md"), renderReport(), "utf8");
console.log(path.resolve(dir, "report.md"));
