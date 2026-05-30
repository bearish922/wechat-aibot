import fs from "node:fs";
import { rootPath } from "./paths.mjs";

// ─── Common chat style prompt ───────────────────────────────
export const COMMON_CHAT_STYLE_PROMPT = [
  "【共同聊天风格】",
  "像熟人微信私聊：先接住当下，不把消息当任务处理。",
  "一句话够就停；连发时像自然停顿、补一句、突然反应过来，不要先回应再展开再反问。",
  "语气更口语、更松一点，可以吐槽、顺着情绪笑一下、分享小念头，也可以把话停在不完整但自然的位置。",
  "不要把对方的话改写成金句、人生判断、戏剧旁白或漂亮总结；少用“不是A而是B”“这一点/这一步/这句话 + 价值判断”等拔高句。",
  "反问只在真的好奇或对话需要继续时使用。颜文字和括号动作只是小装饰，跟情绪匹配，避免机械重复；也可以不用。",
].join("\n");

export const MAX_REPLY_LEN = 3800;
export const SOCIAL_REPLY_MAX_PARTS = 6;
export const TERMINOLOGY_FILE = rootPath("wechat-terminology.json");

const DEFAULT_TERMINOLOGY = {
  promptRules: [
    "Pastel*Palettes 可以写全名 Pastel*Palettes，或写简称 PasPale；不要写“帕斯帕雷”“帕斯帕莱”等音译。",
    "若宫伊芙日常称呼写“伊芙”，不要写 Eve/eve。",
  ],
  replacements: [
    { pattern: "帕斯[·・\\s-]?帕[雷莱蕾]", flags: "gu", replace: "PasPale" },
    { pattern: "\\b[Ee]ve\\b", flags: "g", replace: "伊芙" },
  ],
};

export function loadTerminologyConfig() {
  try {
    if (!fs.existsSync(TERMINOLOGY_FILE)) return DEFAULT_TERMINOLOGY;
    const data = JSON.parse(fs.readFileSync(TERMINOLOGY_FILE, "utf-8"));
    return {
      promptRules: Array.isArray(data?.promptRules) ? data.promptRules.filter(rule => typeof rule === "string" && rule.trim()) : DEFAULT_TERMINOLOGY.promptRules,
      replacements: Array.isArray(data?.replacements) ? data.replacements.filter(rule => typeof rule?.pattern === "string" && typeof rule?.replace === "string") : DEFAULT_TERMINOLOGY.replacements,
    };
  } catch {
    return DEFAULT_TERMINOLOGY;
  }
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

export function localTimePeriod(date = new Date()) {
  const hour = date.getHours();
  if (hour < 5) return "凌晨";
  if (hour < 8) return "早上";
  if (hour < 11) return "上午";
  if (hour < 13) return "中午";
  if (hour < 18) return "下午";
  if (hour < 23) return "晚上";
  return "深夜";
}

export function formatLocalChatReality(date = new Date()) {
  const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const stamp = [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join("-") + ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return [
    "【当前聊天现实】",
    `当前本地时间：${stamp}，${weekdays[date.getDay()]}，${localTimePeriod(date)}。`,
    "通常默认是微信私聊，对方用户刚通过手机发来消息；对方主动补充互动场景时，以对方描述为准。",
    "",
    "【动作与神态】",
    "括号动作只是少量语气补充，不必每次都写；不确定时可以不用动作。",
    "动作要符合当前时间、微信私聊形式和已有上下文；不要编具体地点、姿势、物品或身边人。",
    "凌晨/深夜可默认安静的私人空间，但除非上下文给出，不要写成具体场景。",
    "",
    "【优先级】",
    "用户明确描述当前场景时，以用户描述为准；角色日常习惯和当前时间冲突时，以当前聊天现实为准。",
  ].join("\n");
}

export function terminologyPrompt() {
  const rules = loadTerminologyConfig().promptRules;
  return [
    "【术语规范】",
    "乐队、角色、作品、歌曲等专有名词优先沿用上下文、角色模板和知识库里的写法；不要临场自造中文音译。",
    ...rules,
  ].join("\n");
}

export function normalizeTerminology(text = "") {
  let normalized = String(text);
  for (const rule of loadTerminologyConfig().replacements) {
    try {
      normalized = normalized.replace(new RegExp(rule.pattern, rule.flags || "g"), rule.replace);
    } catch {}
  }
  return normalized;
}

export function expressionCapabilityPrompt() {
  return [
    "【表情能力】",
    "你只能使用通用 Unicode emoji、普通标点、文字颜文字或少量括号动作。",
    "你不能主动发送微信内置表情包占位文本，例如 [旺柴]、[捂脸]、[破涕为笑]、[呲牙]、[微笑]。",
    "如果对方消息里出现这类占位，可以理解为对方发了微信表情，但回复时不要照抄这种格式。",
  ].join("\n");
}

// ─── Text splitting ─────────────────────────────────────────
export function splitText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = []; let i = 0;
  while (i < text.length) {
    let end = i + maxLen;
    if (end < text.length) { const nl = text.lastIndexOf("\n", end); if (nl > i + maxLen * 0.5) end = nl + 1; }
    chunks.push(text.slice(i, end)); i = end;
  }
  return chunks;
}

// ─── Attachment detection ───────────────────────────────────
export function hasInboundAttachment(body) {
  return /^\[(图片|语音|文件|视频)\]/m.test(body);
}

// ─── Structured reply detection ─────────────────────────────
export function isStructuredReply(text) {
  return /```|^\s*#{1,6}\s|^\s*[-*]\s|^\s*\d+[.)]\s|^\s*[>|]/m.test(text)
    || /===|--- Tool:|Result:|\[usage\]|❌|⚠️|⏹️/.test(text);
}

// ─── Social reply splitting ─────────────────────────────────
function hasBurstReason(text) {
  return /[！？!?…~～]{2,}|哈{2,}|h{2,}|欸|诶|呜|哇|啊这|等等|不是|真的|草|救命|怎么会/u.test(text);
}

function shouldSplitImplicitly(text, sentences) {
  const r = Math.random();
  if (hasBurstReason(text)) return r < 0.65;
  if (sentences.length >= 5) return r < 0.35;
  if (sentences.length >= 3) return r < 0.18;
  return r < 0.08;
}

function randomBeatLimit() {
  const limits = [12, 18, 24, 32, 46, 70, 110];
  return limits[Math.floor(Math.random() * limits.length)];
}

function makeChatBeats(sentences) {
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    if (!current) {
      current = sentence;
    } else if ((current + sentence).length <= randomBeatLimit()) {
      current += sentence;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function limitSocialParts(parts, maxParts) {
  const clean = parts.map(p => p.trim()).filter(Boolean);
  if (clean.length <= maxParts) return clean;
  if (maxParts <= 1) return [clean.join("")];
  return [...clean.slice(0, maxParts - 1), clean.slice(maxParts - 1).join("")];
}

export function splitSocialReply(text) {
  const t = text.trim();
  if (isStructuredReply(t)) return [t];

  const explicitBeats = t.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (explicitBeats.length >= 2 && explicitBeats.every(p => p.length <= 90)) {
    return limitSocialParts(explicitBeats, SOCIAL_REPLY_MAX_PARTS);
  }

  const sentences = t
    .replace(/\s*\n+\s*/g, " ")
    .match(/[^。！？!?…~～]+[。！？!?…~～]*|.+$/g)
    ?.map(s => s.trim())
    .filter(Boolean) || [t];

  if (sentences.length <= 1) return [t];
  if (!shouldSplitImplicitly(t, sentences)) return [t];

  const chunks = makeChatBeats(sentences);
  return limitSocialParts(chunks, SOCIAL_REPLY_MAX_PARTS);
}

// ─── Kaomoji tracking ───────────────────────────────────────
export function extractKaomoji(text) {
  const found = new Set();
  const bracketed = text.match(/[（(][^）)\n]{1,24}[）)](?:[^\s\w一-鿿]{0,3})/gu) || [];
  for (const item of bracketed) {
    if (/[一-鿿]/u.test(item)) continue;
    if (/[｡•̀́ᴗω▽︿﹏∀◍〃^><;｀´≧≦╯╰･_¯︶]/u.test(item)) found.add(item);
  }
  const standalone = text.match(/[ヾヽ][^\s\n]{2,24}/gu) || [];
  for (const item of standalone) {
    if (/[｡ωᴗ▽︿﹏∀◍¯︶]/u.test(item)) found.add(item);
  }
  return Array.from(found).slice(0, 5);
}

export function rememberRecentKaomoji(sess, text) {
  sess._kaomojiTurn = (sess._kaomojiTurn || 0) + 1;
  const turn = sess._kaomojiTurn;
  const current = (sess._recentKaomoji || [])
    .map(item => typeof item === "string" ? { text: item, lastTurn: turn } : item)
    .filter(item => item?.text && turn - (item.lastTurn || turn) <= 4);
  const kaomoji = extractKaomoji(text);
  if (!kaomoji.length) {
    sess._recentKaomoji = current;
    return;
  }
  const updated = [
    ...kaomoji.map(k => ({ text: k, lastTurn: turn })),
    ...current.filter(item => !kaomoji.includes(item.text)),
  ];
  sess._recentKaomoji = updated.slice(0, 6);
}

const RHETORICAL_PATTERN_RULES = [
  {
    key: "contrast",
    label: "“不是A而是B”式反转",
    regex: /不是[^。！？!?\n]{1,24}(?:，|,)?(?:而是|是)[^。！？!?\n]{1,36}/u,
  },
  {
    key: "judgment",
    label: "“这一步/这句话/这一点 + 价值判断”",
    regex: /这[一]?[^，。！？!?\n]{0,8}(?:，|,)[^。！？!?\n]{0,28}(?:足够|珍贵|勇敢|清醒|锋利|厉害|重要|难得|了不起)/u,
  },
  {
    key: "grandComparison",
    label: "夸张比较或人生化拔高",
    regex: /(?:很多人|一辈子|任何|所有|比我.*(?:都|更)|比.*(?:任何|所有).*(?:都|更))/u,
  },
];

export function extractRhetoricalPatterns(text = "") {
  const value = String(text || "");
  return RHETORICAL_PATTERN_RULES
    .filter(rule => rule.regex.test(value))
    .map(rule => ({ key: rule.key, label: rule.label }));
}

export function rememberRecentRhetoricalPatterns(sess, text) {
  if (!sess) return;
  sess._rhetoricalTurn = (sess._rhetoricalTurn || 0) + 1;
  const turn = sess._rhetoricalTurn;
  const current = (sess._recentRhetoricalPatterns || [])
    .filter(item => item?.key && turn - (item.lastTurn || turn) <= 3);
  const found = extractRhetoricalPatterns(text);
  if (!found.length) {
    sess._recentRhetoricalPatterns = current;
    return;
  }
  const foundKeys = new Set(found.map(item => item.key));
  sess._recentRhetoricalPatterns = [
    ...found.map(item => ({ ...item, lastTurn: turn })),
    ...current.filter(item => !foundKeys.has(item.key)),
  ].slice(0, 4);
}

// ─── Info-seeking detection ─────────────────────────────────
export function isInfoSeekingTurn(userBody = "") {
  return /为什么|怎么|如何|解释|分析|总结|建议|方案|教程|资料|报错|修|代码|测试|可行|区别|哪里|什么原因|能不能|\?|？/u.test(userBody);
}

// ─── Reply length budget ────────────────────────────────────
export function chooseReplyBudget(userBody = "") {
  const infoSeeking = isInfoSeekingTurn(userBody);
  const mediaCasual = hasInboundAttachment(userBody) && !infoSeeking;
  const r = Math.random();
  if (mediaCasual || !infoSeeking) {
    if (r < 0.35) return { instruction: "极短：只回 1 条，中文 6-18 字；像微信里顺手接一句，不解释、不追问。", maxChars: 24, maxParts: 1, enforce: true };
    if (r < 0.72) return { instruction: "短：只回 1 条，中文 20-45 字；抓住一个点回应，立刻停住。", maxChars: 55, maxParts: 1, enforce: true };
    if (r < 0.90) return { instruction: "普通短聊：1 条，中文 45-90 字；可以有一点细节，但不要展开成小作文。", maxChars: 105, maxParts: 1, enforce: true };
    if (r < 0.98) return { instruction: "短连发：2-4 条，每条 6-28 字，总量不超过 90 字；只有自然停顿或情绪跳动时才这样发。", maxChars: 105, maxParts: 4, enforce: true };
    return { instruction: "少见长一点：1-2 条，总量不超过 160 字；仍然像私聊，不要讲设定课。", maxChars: 180, maxParts: 2, enforce: true };
  }
  if (r < 0.20) return { instruction: "短：1 条，中文 25-60 字；先给结论，不铺开。", maxChars: 80, maxParts: 1, enforce: false };
  if (r < 0.65) return { instruction: "正常说明：1-2 条，总量 80-180 字；回答清楚即可，不要顺手扩写。", maxChars: 220, maxParts: 2, enforce: false };
  if (r < 0.92) return { instruction: "较完整：1-3 条，总量 180-320 字；只在问题确实需要时使用。", maxChars: 360, maxParts: 3, enforce: false };
  return { instruction: "长回复：可以超过 320 字，但必须是对方明确需要分析、排查或方案时；闲聊禁用。", maxChars: 800, maxParts: 4, enforce: false };
}

// ─── Budget enforcement ─────────────────────────────────────
export function constrainCasualReply(text, budget) {
  if (!budget?.enforce || !text || text.length <= budget.maxChars || isStructuredReply(text)) return text;
  const normalized = text.trim().replace(/\n{3,}/g, "\n\n");
  const explicit = normalized.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const units = explicit.length > 1 ? explicit : (normalized.match(/[^。！？!?…~～\n]+[。！？!?…~～]*|.+$/g) || [normalized]).map(s => s.trim()).filter(Boolean);
  const kept = [];
  let total = 0;
  for (const unit of units) {
    if (kept.length >= Math.max(1, budget.maxParts || 1)) break;
    if (total && total + unit.length > budget.maxChars) break;
    if (!total && unit.length > budget.maxChars) {
      kept.push(unit.slice(0, Math.max(8, budget.maxChars - 1)).trimEnd() + "…");
      break;
    }
    kept.push(unit);
    total += unit.length;
  }
  return kept.length ? kept.join(budget.maxParts > 1 ? "\n" : "") : normalized.slice(0, budget.maxChars).trimEnd() + "…";
}

// ─── Style prompt builder ───────────────────────────────────
export function buildStylePrompt(recentKaomoji = [], userBody = "", budget = chooseReplyBudget(userBody), recentRhetoricalPatterns = []) {
  const isTask = isInfoSeekingTurn(userBody);
  const chatGuidance = isTask ? [
    "【任务模式风格】",
    "对方在正经求助，可以比闲聊说得更多；需要时允许列表、分段、代码块。",
    "保持角色语气和思维方式，解释清楚即可，不要顺手扩写成标准答案或机械总结。",
    "可以有一点角色反应、吐槽或类比，但内容价值优先。",
  ].join("\n") : COMMON_CHAT_STYLE_PROMPT;

  const parts = [
    chatGuidance,
    "",
    formatLocalChatReality(),
    "",
    terminologyPrompt(),
    "",
    expressionCapabilityPrompt(),
    "",
    "【本轮回复长度签】",
    budget.instruction,
    "长度签是本轮风格指引，不是硬性限制。如果自然表达需要更多字数，完全可以超出。",
  ];
  if (recentKaomoji?.length) {
    const recent = recentKaomoji
      .map(item => typeof item === "string" ? item : item?.text)
      .filter(Boolean)
      .join(" ");
    parts.push(
      "",
      `【近期表达记忆】近期出现过这些颜文字：${recent}`,
      "重点避免高频率或连续复用同款；如果已经隔了三四轮、语气又刚好合适，可以自然复用，不必为了回避而生硬换成陌生颜文字。也可以干脆不用颜文字，让语气靠文字本身成立。",
    );
  }
  if (recentRhetoricalPatterns?.length && !isTask) {
    const labels = recentRhetoricalPatterns
      .map(item => typeof item === "string" ? item : item?.label)
      .filter(Boolean)
      .join("、");
    parts.push(
      "",
      `【近期表达提醒】上一轮附近出现过偏AI的表达模式：${labels}。`,
      "本轮刻意放松一点，直接接话，少做反转、升华、夸张比较或漂亮收束；具体一点、普通一点也可以。",
    );
  }
  return parts.join("\n");
}
