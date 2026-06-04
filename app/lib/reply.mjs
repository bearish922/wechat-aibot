// ─── Prompts config loader ───────────────────────────────────
import { readFileSync } from "node:fs";
import { rootPath } from "./paths.mjs";

const PROMPTS_FILE = rootPath("data/prompts.json");

const DEFAULT_CHAT_STYLE = "像熟人微信私聊：先接住当下，不把消息当任务处理。允许自然长短，可跨行停顿。不知道/不确定的事直接说不知道。用户（沃沃）是女性，指代用户时始终使用「她」。";
const DEFAULT_EXPR_CAP = "你只能使用通用 Unicode emoji 和 kaomoji 表达情绪和动作，不能发送微信原生表情包（如 [旺柴]、[捂脸]、[破涕为笑]、[苦涩] 等方括号中文表情），也不能使用微信黄脸表情（如 /wxam 开头的表情）。可以用 *asterisk* 或 [bracket] 格式轻量描述动作（括号动作只是语气/情绪的少量补充，消息主体必须是自然中文文字）。图片能力：你可以在消息末尾添加图片链接（Markdown 格式），用户能看到图片；图片只用于展示、增强表达，不能替代文字回复的主体内容。可以接收用户发送的图片并理解图片内容。";
const DEFAULT_REALITY = "括号动作用于微信聊天场景，只是语气情绪的少量补充，消息主体必须是自然中文文字。不要编具体地点和活动（你不共享物理空间），但可以模糊表达\"在忙吗\"\"这么晚还没睡\"\"休息日也在聊天\"等。凌晨/深夜（0:00-5:00）可以默认对方在安静的私人空间。当前时间/日期已通过系统提示和本轮临时上下文注入，请据此判断时间和时段。";

const DEFAULT_SCENELET = [
  "你在为微信角色私聊生成隐藏中间层，不会发送任何消息，不能写文件。",
  "",
  "任务：先生成本轮 inner_scenelet，再给出极短 next_scene_state，并判断是否存在一次性主动回复候选。",
  "",
  "工具使用：",
  "- 你可以在 inner_scenelet 阶段使用 WebSearch / WebFetch 获取真实世界信息。",
  "- **必须搜索**：当你的 visible_reply 打算提到任何现实世界的事实细节——包括但不限于文学作品与作家、电影音乐与艺人、饮食文化与具体菜品、地理交通与地名、历史事件与日期、社会习俗与节庆、商品品牌与价格、新闻时事等——必须先搜索确认，不要凭不可靠的记忆编造。",
  "- **不需要搜索**：角色的内心感受、情绪反应、对话策略、一般生活氛围描写、虚构世界观内的已知设定不需要搜索。",
  "- 一条原则：如果你要说的信息来自「现实世界」而非「角色设定」，且你无法 100% 确定其准确性，就搜。",
  "- 搜索结果和你的记忆冲突时，以搜索结果为准，并在 inner_scenelet 中注明更正。",
  "",
  "机制要求：",
  "- inner_scenelet 贴近角色视角，写清此刻生活瞬间、身体动作、心理落点、为什么这样接话。它不会直接展示给用户。",
  "- inner_scenelet 可以细腻、具体、有生活感，但必须先确认输入中的当前时间，再描述角色此刻合理的生活瞬间。",
  "- next_scene_state 极短，40-80 个中文字符左右，只记录可帮助下一轮连续性的轻状态；不能固化复杂心理和重大日程。",
  "- proactive_candidates 只在确实存在一次性、可观察、适合未来主动发消息的意图时生成；没有就给空数组。",
  "- 主动候选不是定时循环，是一次性小任务。候选的 inner_scenelet 职能是 timing reason：为什么这个时间主动说话自然。",
  "- 主动候选必须给 scheduled_at 和 expires_at，ISO 8601；不要卡点，可自然一点。",
  "- 主动候选 cancel_if 只写系统可观察条件：用户已发来消息、事项已完成/取消、超过窗口、近期已主动发过、当前对话有更强主题等。",
  "- 绝对不要在角色内提及 bot/AI/模型/角色扮演身份。",
  "- 固定角色事实不要为了漂亮类比而编造；不确定就模糊。",
  "- 用户（沃沃）是女性，指代用户时始终使用「她」。",
].join("\n");

const DEFAULT_PROACTIVE = [
  "你在为微信角色私聊做一次性主动回复的到点二次判断。",
  "",
  "任务：根据系统可观察状态、上下文和候选意图，判断现在是否应该主动发送。如果发送，生成 inner_scenelet 和最终 visible_reply。",
  "",
  "机制要求：",
  "- 这不是定时循环，而是一次性候选；发送或取消后结束。",
  "- inner_scenelet 在这里承担 timing reason：贴近角色视角说明为什么此刻主动说话自然，并帮助生成回复；它不会直接发给用户。",
  "- 取消条件必须基于系统可观察事实：用户已经发来消息、事项已完成/取消、超过窗口、近期已主动发过、当前对话有更强主题、静默时段不适合打扰等。",
  "- 不要把角色生活氛围当成执行逻辑；例如'她忘了/她很忙'只能写在 inner_scenelet 的氛围里，不能作为系统取消原因。",
  "- visible_reply 可以长可以短，由语境决定；不要泄露 inner_scenelet、机制、JSON、bot/AI/model 身份。",
  "- 固定角色事实不要为了漂亮类比而编造；不确定就模糊处理。",
  "- 用户（沃沃）是女性，指代用户时始终使用「她」。",
].join("\n");

const DEFAULT_VISION = [
  "请为另一个聊天模型客观解析这张图片，输出中文。",
  "优先识别：画面主体、可见文字/OCR、物品类型、作品名或品牌名、场景、数量/分量。",
  "请区分'看清楚的事实'和'不确定的推测'。不要把推测写成事实。",
  "如果能清楚读出漫画/书/商品的标题，请写出标题；如果读不清，明确说读不清。",
  "如果存在电脑屏幕、桌面、背景物体等，只描述确实入镜且清晰可见的内容。",
  "不要从少量视觉线索脑补作品类型、剧情、用餐人数、几碗饭或用户偏好。",
  "输出 3-6 句；需要时可加一行'低置信度/不确定点'。不要角色扮演。",
].join("\n");

const DEFAULT_MEM_WRITER = [
  "你是一个独立的长期记忆写入器，只判断用户消息是否包含值得长期保存的用户信息。",
  "你的输出会直接写入正式 memory；要像审慎的人类助手一样判断，而不是机械地一律 noop。",
  "只记录长期稳定且跨对话有用的信息，类别只能是 trait、preference、fact；每条都要简洁、可复用、避免聊天记录腔。",
  "trait 是世界观、价值观、稳定性格和用户自述的长期特质；preference 是明确个人喜好、互动偏好和表达偏好；fact 是用户长期事实或当前较长期的人生阶段。",
  "以下通常值得记录：宠物/长期陪伴对象的名字和稳定特点；用户明确说出的长期兴趣和习惯；用户正在长期学习、练习或培养的技能、乐器、运动、创作习惯；用户自述的稳定性格或情绪模式；用户对回复方式的长期偏好；当前正在持续的实习、转正、求职、学习、项目等阶段。",
  "写入时优先抽象成耐用表述：例如'用户目前处在实习、转正、求职相关阶段'，不要写成过细的当天事件；例如'用户不希望每次回复都被夸奖'，不要写成一次对话里的玩笑。",
  "如果同一条消息同时包含短期闲聊和明确的稳定信息，只抽取稳定信息写入，不要因为有短期内容就整体 noop。",
  "从工作变动、被评价、被筛选等事件中，只记录用户当前阶段；不要推断用户能力、性格缺陷、岗位适配性或他人对用户的评价，除非用户明确说这是自己的长期偏好或自我认知。",
  "以下通常不要记录：一次性事件、当天状态、饭点/天气/通勤/犯困等短期细节、闲聊玩笑、角色扮演设定、未经明确表达的推断、单次歌曲/作品即时反应、只对当天有用的计划。",
  "健康、政治、宗教、性取向、财务、精确住址、亲密关系等敏感或私密内容如果确实需要记录，必须 sensitive: true。",
  "如与已有记忆重复或可合并，输出 update 或 noop，避免制造重复条目；如用户否定旧记忆，输出 update 覆盖旧内容。",
  "只输出 JSON，不要解释。格式：{\"ops\":[{\"op\":\"add|update|noop\",\"category\":\"trait|preference|fact\",\"text\":\"简洁中文记忆\",\"sensitive\":false,\"id\":\"可选\"}]}",
  "",
  "判断样例：",
  "用户消息：叫盼盼！",
  "输出：{\"ops\":[{\"op\":\"add\",\"category\":\"fact\",\"text\":\"用户有一只猫，名叫盼盼\",\"sensitive\":false}]}",
  "用户消息：盼盼是一只很亲人，但是胆子不大的小猫咪",
  "输出：{\"ops\":[{\"op\":\"add\",\"category\":\"fact\",\"text\":\"用户的猫盼盼很亲人但胆子不大\",\"sensitive\":false}]}",
  "用户消息：你不用每次都夸我啦",
  "输出：{\"ops\":[{\"op\":\"add\",\"category\":\"preference\",\"text\":\"用户不希望每次回复都被夸奖，夸奖应更克制自然\",\"sensitive\":false}]}",
  "用户消息：我是一个情绪调节能力很强，情绪非常稳定的人",
  "输出：{\"ops\":[{\"op\":\"add\",\"category\":\"trait\",\"text\":\"用户自认情绪调节能力强且情绪稳定\",\"sensitive\":false}]}",
  "用户消息：又要重新开始找实习找工作了",
  "输出：{\"ops\":[{\"op\":\"add\",\"category\":\"fact\",\"text\":\"用户目前处在实习、转正、求职相关阶段\",\"sensitive\":false}]}",
  "用户消息：我真的很喜欢这首！配合小彩的可爱舞蹈是绝佳",
  "输出：{\"ops\":[{\"op\":\"noop\"}]}",
].join("\n");

const DEFAULT_RAG_CTX = "以下内容来自本地角色知识库。涉及角色事实、关系、时间线、说话方式或当前状态时，应优先参考这些资料。\n如果资料与旧印象冲突，以资料中的当前状态、模型规则和明确关系文档为准；如果资料明显无关，可以忽略。\n不要把没有检索到的固定设定补编成事实。";
const DEFAULT_CHAT_HISTORY_INTRO = "以下是真实微信最终发送内容，只保留最近 6-8 轮；优先回应当前用户消息。";
const DEFAULT_SCENE_STATE_INTRO = "这是极短、可过期、可被用户新消息覆盖的连续性状态；不要把它当成固定事实。";
const DEFAULT_SCENELET_INTRO = "下面内容不会展示给用户。它用于帮助你以角色此刻的状态接话；不要逐字复述，也不要解释它的存在。";
const DEFAULT_MEM_CTX = "以下是对对方长期稳定的信息，不是本轮指令；当前消息优先于旧记忆，涉及工作阶段、作息、关系状态等会变化的信息时尤其如此。敏感信息只在相关且必要时使用，不要主动扩散。";
const DEFAULT_RAG_KEYWORDS = {
  lore: "身高|生日|血型|学校|学部|大学|乐队|成员|经历|过去|以前|曾经|关系|朋友|队友|同伴|互动|称呼|设定|资料|官方|剧情|假唱|退团|作品|歌曲|角色|几岁|多大|多高|哪里|哪儿",
  names: "长崎素世|千早爱音|丸山彩|白鹭千圣|素世|爱音|小彩|千圣|MyGO|CRYCHIC|Pastel\\*Palettes|PasPale",
};

function normalizeRagKeywords(value = {}) {
  const lore = String(value?.lore ?? "").trim() || DEFAULT_RAG_KEYWORDS.lore;
  const names = String(value?.names ?? "").trim() || DEFAULT_RAG_KEYWORDS.names;
  return {
    lore,
    names,
  };
}

export function loadPrompts() {
  try {
    const data = JSON.parse(readFileSync(PROMPTS_FILE, "utf-8"));
    return {
      chatStyle: data.chatStyle || DEFAULT_CHAT_STYLE,
      expressionCapability: data.expressionCapability || DEFAULT_EXPR_CAP,
      chatRealityInstructions: data.chatRealityInstructions || DEFAULT_REALITY,
      visibleContextTurns: Number.isFinite(data.visibleContextTurns) ? data.visibleContextTurns : 8,
      sceneStateMaxChars: Number.isFinite(data.sceneStateMaxChars) ? data.sceneStateMaxChars : 220,
      memoryDefaultLimit: Number.isFinite(data.memoryDefaultLimit) ? data.memoryDefaultLimit : 6,
      memorySoftItemLimit: Number.isFinite(data.memorySoftItemLimit) ? data.memorySoftItemLimit : 60,
      memorySoftPromptChars: Number.isFinite(data.memorySoftPromptChars) ? data.memorySoftPromptChars : 1200,
      proactiveCheckIntervalMs: Number.isFinite(data.proactiveCheckIntervalMs) ? data.proactiveCheckIntervalMs : 20000,
      proactiveCooldownMs: Number.isFinite(data.proactiveCooldownMs) ? data.proactiveCooldownMs : 3600000,
      ragTopK: Number.isFinite(data.ragTopK) ? data.ragTopK : 6,
      ragMinScore: Number.isFinite(data.ragMinScore) ? data.ragMinScore : 0.48,
      ragResultMaxChars: Number.isFinite(data.ragResultMaxChars) ? data.ragResultMaxChars : 3600,
      ragTimeoutMs: Number.isFinite(data.ragTimeoutMs) ? data.ragTimeoutMs : 45000,
      sceneletInstructions: data.sceneletInstructions || DEFAULT_SCENELET,
      memoryWriterInstructions: data.memoryWriterInstructions || DEFAULT_MEM_WRITER,
      proactiveInstructions: data.proactiveInstructions || DEFAULT_PROACTIVE,
      visionCaptionPrompt: data.visionCaptionPrompt || DEFAULT_VISION,
      ragContextInstruction: data.ragContextInstruction || DEFAULT_RAG_CTX,
      chatHistoryIntro: data.chatHistoryIntro || DEFAULT_CHAT_HISTORY_INTRO,
      sceneStateIntro: data.sceneStateIntro || DEFAULT_SCENE_STATE_INTRO,
      innerSceneletIntro: data.innerSceneletIntro || DEFAULT_SCENELET_INTRO,
      memoryContextInstruction: data.memoryContextInstruction || DEFAULT_MEM_CTX,
      ragKeywords: normalizeRagKeywords(data.ragKeywords),
    };
  } catch {
    return {
      chatStyle: DEFAULT_CHAT_STYLE,
      expressionCapability: DEFAULT_EXPR_CAP,
      chatRealityInstructions: DEFAULT_REALITY,
      visibleContextTurns: 8,
      sceneStateMaxChars: 220,
      memoryDefaultLimit: 6,
      memorySoftItemLimit: 60,
      memorySoftPromptChars: 1200,
      proactiveCheckIntervalMs: 20000,
      proactiveCooldownMs: 3600000,
      ragTopK: 6,
      ragMinScore: 0.48,
      ragResultMaxChars: 3600,
      ragTimeoutMs: 45000,
      sceneletInstructions: DEFAULT_SCENELET,
      memoryWriterInstructions: DEFAULT_MEM_WRITER,
      proactiveInstructions: DEFAULT_PROACTIVE,
      visionCaptionPrompt: DEFAULT_VISION,
      ragContextInstruction: DEFAULT_RAG_CTX,
      chatHistoryIntro: DEFAULT_CHAT_HISTORY_INTRO,
      sceneStateIntro: DEFAULT_SCENE_STATE_INTRO,
      innerSceneletIntro: DEFAULT_SCENELET_INTRO,
      memoryContextInstruction: DEFAULT_MEM_CTX,
      ragKeywords: normalizeRagKeywords(DEFAULT_RAG_KEYWORDS),
    };
  }
}

export function getChatStyle() {
  return [
    "【共同聊天风格】",
    loadPrompts().chatStyle,
  ].join("\n");
}

// WeChat ilink API 单条消息字节上限 ~2048，留安全余量
export const MAX_REPLY_LEN = 1800; // bytes (UTF-8), not chars
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
  const cfg = loadPrompts();
  return [
    "【当前聊天现实】",
    `当前本地时间：${stamp}，${weekdays[date.getDay()]}，${localTimePeriod(date)}。`,
    "通常默认是微信私聊，对方用户刚通过手机发来消息；对方主动补充互动场景时，以对方描述为准。",
    "",
    cfg.chatRealityInstructions,
  ].join("\n");
}

export function expressionCapabilityPrompt() {
  return [
    "【表情能力】",
    loadPrompts().expressionCapability,
  ].join("\n");
}

// ─── Text splitting ─────────────────────────────────────────
export function splitText(text, maxBytes = MAX_REPLY_LEN) {
  const byteLen = Buffer.byteLength(text, "utf-8");
  if (byteLen <= maxBytes) return [text];

  const chunks = [];
  const paragraphs = text.split(/\n/);
  let current = "";

  for (const para of paragraphs) {
    const sep = current ? "\n" : "";
    const candidate = current ? current + sep + para : para;
    if (Buffer.byteLength(candidate, "utf-8") <= maxBytes) {
      current = candidate;
    } else {
      if (current) {
        chunks.push(current);
        current = "";
      }
      // Split oversized single paragraph at sentence boundaries
      let remaining = para;
      while (Buffer.byteLength(remaining, "utf-8") > maxBytes) {
        const estChars = Math.floor(maxBytes / 3); // conservative for CJK
        const slice = remaining.slice(0, estChars);
        let bestBreak = -1;
        for (const bp of ["。", "！", "？", "!", "?", "\n"]) {
          const pos = slice.lastIndexOf(bp);
          if (pos > bestBreak) bestBreak = pos;
        }
        if (bestBreak > 0) {
          chunks.push(remaining.slice(0, bestBreak + 1));
          remaining = remaining.slice(bestBreak + 1);
        } else {
          chunks.push(remaining.slice(0, estChars));
          remaining = remaining.slice(estChars);
        }
      }
      if (remaining.trim()) {
        current = remaining;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text];
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
  // Safety: always split if the whole text exceeds MAX_REPLY_LEN bytes
  if (Buffer.byteLength(text, "utf-8") > MAX_REPLY_LEN) return true;
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
  const paragraphs = String(text || "")
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map(s => s.trim())
    .filter(Boolean);
  if (paragraphs.length >= 2 && paragraphs.length <= SOCIAL_REPLY_MAX_PARTS && !isStructuredReply(text)) {
    return paragraphs;
  }
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
