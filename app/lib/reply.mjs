// ─── Common chat style prompt ───────────────────────────────
export const COMMON_CHAT_STYLE_PROMPT = [
  "【共同聊天风格】",
  "像熟人微信私聊：先接住当下，不把消息当任务处理。",
  "允许自然长短——轻松接话可以很短，认真回应时也允许展开。",
  "短不是敷衍，长也不是默认目标。",
].join("\n");

export const MAX_REPLY_LEN = 3800;
const SOCIAL_REPLY_MAX_PARTS = 6;

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
  return clean.slice(0, maxParts);
}

export function splitSocialReply(text) {
  const sentences = text
    .replace(/\r/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/([。！？!?\n])\s*/g, "$1\n")
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);
  if (!sentences.length) return [text.trim()];
  if (shouldSplitImplicitly(text, sentences)) {
    const beats = makeChatBeats(sentences);
    return limitSocialParts(beats, SOCIAL_REPLY_MAX_PARTS);
  }
  return [text.trim()];
}

// ─── Kaomoji memory ────────────────────────────────────────
let recentKaomojiMap = new Map();
let lastCleanup = Date.now();

export function rememberRecentKaomoji(sess, text) {
  if (!sess) return;
  const extracted = extractKaomoji(text);
  if (!extracted.length) return;
  const now = Date.now();
  if (now - lastCleanup > 3600 * 1000) {
    for (const [k, v] of recentKaomojiMap) {
      if (now - v > 3600 * 1000) recentKaomojiMap.delete(k);
    }
    lastCleanup = now;
  }
  const kaomojiTurn = (sess._kaomojiTurn || 0) + extracted.length;
  sess._kaomojiTurn = kaomojiTurn;
  sess._recentKaomoji = [...new Set([...(sess._recentKaomoji || []), ...extracted])].slice(-20);
}

function extractKaomoji(text) {
  const results = [];
  const regex = /[\u{1F600}-\u{1F64F}\u{1FAE0}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{200D}\u{FE0F}]|[(（][一-鿿぀-ゟ゠-ヿ（）()]{1,12}[。！？!?.…‥]?[)）]|[（(][A-Za-zÀ-ɏ\s]{1,12}[。！？!?.]?[）)]/gu;
  let m;
  while ((m = regex.exec(text)) !== null) {
    results.push(m[0]);
  }
  return [...new Set(results)];
}
