// ─── Common chat style prompt ───────────────────────────────
export const COMMON_CHAT_STYLE_PROMPT = [
  "【共同聊天风格】",
  "你是在和熟人私聊，不是在写标准答案。不要形成固定模板，不要总是先回应、再展开、最后反问。",
  "多条消息应该像微信里的自然停顿、重复感、补一句、突然反应过来，而不是把一段说明文硬切开。",
  "如果一句话已经接住了，就停在那里；如果想连发，用自然换行分隔每条短消息。",
  "可以接话、吐槽、顺着情绪笑一下、分享一个小念头，或者把话停在一个自然的位置。反问只在你真的好奇或对话需要继续时使用。",
  "别每句话都像总结陈词；少用列表式结构和解释腔。抓住当下语气，而不是把消息当任务处理。",
  "颜文字和括号动作要像语气里的小装饰，不要机械重复。",
  "颜文字要跟情绪匹配并保持丰富，避免连续复用同一个。可在可爱、得意、心虚、惊讶、无奈、开心、认真等情绪之间自然变化。",
].join("\n");

export const MAX_REPLY_LEN = 3800;
export const SOCIAL_REPLY_MAX_PARTS = 6;

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
    if (/[｡•̀́ᴗω▽︿﹏∀◍〃^><;｀´≧≦╯╰･_]/u.test(item)) found.add(item);
  }
  const standalone = text.match(/[ヾヽ][^\s\n]{2,24}/gu) || [];
  for (const item of standalone) {
    if (/[｡ωᴗ▽︿﹏∀◍]/u.test(item)) found.add(item);
  }
  return Array.from(found).slice(0, 5);
}

export function rememberRecentKaomoji(sess, text) {
  const kaomoji = extractKaomoji(text);
  if (!kaomoji.length) return;
  const recent = sess._recentKaomoji || [];
  sess._recentKaomoji = [...kaomoji, ...recent.filter(k => !kaomoji.includes(k))].slice(0, 8);
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
export function buildStylePrompt(recentKaomoji = [], userBody = "", budget = chooseReplyBudget(userBody)) {
  const isTask = isInfoSeekingTurn(userBody);
  const chatGuidance = isTask ? [
    "【任务模式风格】",
    "对方在正经求助，可以比闲聊说得更多、更完整。允许结构化表达——列表、分段、代码块在需要时都能用。",
    "但你不是无个性的AI助手，保持你的角色语气和思维方式。过程中可以带出角色反应——遇到难题可以吐槽、解决后可以小小满意、解释时可以拿你生活里的东西类比。",
    "不要因为要完成任务就把角色特征收起来；正因为是认真的事，对方才更需要\"你\"来帮忙。",
  ].join("\n") : COMMON_CHAT_STYLE_PROMPT;

  const parts = [
    chatGuidance,
    "",
    "【本轮回复长度签】",
    budget.instruction,
    "长度签是本轮硬约束，不要告诉用户这件事。除非用户明确要求详细说明，否则不要突破长度签。",
  ];
  if (recentKaomoji?.length) {
    parts.push(
      "",
      `【近期表达记忆】最近几轮已经用过这些颜文字：${recentKaomoji.join(" ")}`,
      "接下来如果需要颜文字，优先换一个，不要连续复用这些同款；也可以干脆不用颜文字，让语气靠文字本身成立。",
    );
  }
  return parts.join("\n");
}
