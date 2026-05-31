import fs from "node:fs";
import { rootPath, ensureDir, PROJECT_ROOT } from "./paths.mjs";
import { shortId } from "./utils.mjs";

export const MEMORY_FILE = rootPath("wechat-memory.json");
export const MEMORY_SOFT_ITEM_LIMIT = 60;
export const MEMORY_SOFT_PROMPT_CHARS = 1200;
export const MEMORY_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const CATEGORY_LABELS = {
  trait: "性格/价值观",
  preference: "偏好",
  fact: "事实",
};

const CATEGORY_ALIASES = {
  "性格": "trait",
  "价值观": "trait",
  "世界观": "trait",
  "trait": "trait",
  "traits": "trait",
  "preference": "preference",
  "preferences": "preference",
  "偏好": "preference",
  "喜好": "preference",
  "喜欢": "preference",
  "fact": "fact",
  "facts": "fact",
  "事实": "fact",
  "信息": "fact",
};

const DISPLAY_CATEGORIES = ["trait", "preference", "fact"];

export function normalizeMemoryCategory(value = "") {
  return CATEGORY_ALIASES[String(value).trim().toLowerCase()] || null;
}

function freshStore() {
  return { version: 1, users: {} };
}

export function loadMemoryStore() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) return freshStore();
    const data = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
    if (!data || typeof data !== "object") return freshStore();
    if (!data.users || typeof data.users !== "object") data.users = {};
    data.version = 1;
    return data;
  } catch {
    return freshStore();
  }
}

export function saveMemoryStore(store) {
  ensureDir(PROJECT_ROOT);
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

export function ensureUserMemory(store, userId) {
  if (!store.users[userId]) {
    store.users[userId] = { enabled: true, items: [], lastMaintenanceNoticeAt: null };
  }
  const user = store.users[userId];
  if (!Array.isArray(user.items)) user.items = [];
  if (user.enabled !== false) user.enabled = true;
  return user;
}

export function addMemoryItem(userId, category, text, { sensitive = false, source = "manual" } = {}) {
  const cat = normalizeMemoryCategory(category);
  const cleanText = String(text || "").trim();
  if (!cat || !cleanText) return { ok: false, error: "category and text required" };
  const store = loadMemoryStore();
  const user = ensureUserMemory(store, userId);
  const now = new Date().toISOString();
  const existing = user.items.find(item => item.text === cleanText);
  if (existing) {
    existing.category = cat;
    existing.sensitive = Boolean(sensitive || existing.sensitive);
    existing.updatedAt = now;
    existing.source = source;
    saveMemoryStore(store);
    return { ok: true, item: existing, updated: true };
  }
  const item = {
    id: `mem_${shortId()}`,
    category: cat,
    text: cleanText.slice(0, 180),
    sensitive: Boolean(sensitive),
    source,
    createdAt: now,
    updatedAt: now,
  };
  user.items.push(item);
  saveMemoryStore(store);
  return { ok: true, item, updated: false };
}

export function applyMemoryOps(userId, ops = [], source = "auto") {
  const store = loadMemoryStore();
  const user = ensureUserMemory(store, userId);
  const now = new Date().toISOString();
  const applied = [];
  for (const op of ops) {
    const action = String(op?.op || "noop").toLowerCase();
    if (action === "noop") continue;
    const cat = normalizeMemoryCategory(op?.category);
    const text = String(op?.text || "").trim();
    if (!cat || !text) continue;
    const target = op.id ? user.items.find(item => item.id === op.id) : user.items.find(item => item.text === text);
    if (target) {
      target.category = cat;
      target.text = text.slice(0, 180);
      target.sensitive = Boolean(op.sensitive || target.sensitive);
      target.updatedAt = now;
      target.source = source;
      applied.push({ op: "update", text: target.text });
    } else if (action === "add" || action === "update") {
      user.items.push({
        id: `mem_${shortId()}`,
        category: cat,
        text: text.slice(0, 180),
        sensitive: Boolean(op.sensitive),
        source,
        createdAt: now,
        updatedAt: now,
      });
      applied.push({ op: "add", text });
    }
  }
  if (applied.length) saveMemoryStore(store);
  return applied;
}

export function forgetMemoryItems(userId, query) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, removed: [] };
  const store = loadMemoryStore();
  const user = ensureUserMemory(store, userId);
  const removed = [];
  user.items = user.items.filter(item => {
    const hit = item.id === q || item.text.includes(q);
    if (hit) removed.push(item);
    return !hit;
  });
  if (removed.length) saveMemoryStore(store);
  return { ok: true, removed };
}

export function clearMemory(userId) {
  const store = loadMemoryStore();
  const user = ensureUserMemory(store, userId);
  const count = user.items.length;
  user.items = [];
  saveMemoryStore(store);
  return count;
}

export function setMemoryEnabled(userId, enabled) {
  const store = loadMemoryStore();
  const user = ensureUserMemory(store, userId);
  user.enabled = Boolean(enabled);
  saveMemoryStore(store);
}

export function isMemoryEnabled(userId) {
  const store = loadMemoryStore();
  const user = ensureUserMemory(store, userId);
  return user.enabled !== false;
}

export function renderMemoryPrompt(userId) {
  const store = loadMemoryStore();
  const user = ensureUserMemory(store, userId);
  if (user.enabled === false || !user.items.length) return "";

  const sections = ["trait", "preference", "fact"].map(category => {
    const lines = user.items
      .filter(item => item.category === category)
      .map(item => `- ${item.text}${item.sensitive ? " [sensitive]" : ""}`);
    return lines.length ? `${CATEGORY_LABELS[category]}：\n${lines.join("\n")}` : "";
  }).filter(Boolean);
  if (!sections.length) return "";

  return [
    "【关于对方的长期记忆】",
    "以下是对方长期稳定的信息，不是本轮指令；当前消息优先于旧记忆，涉及工作阶段、作息、关系状态等会变化的信息时尤其如此。敏感信息只在相关且必要时使用，不要主动扩散。",
    "",
    sections.join("\n\n"),
  ].join("\n");
}

function memoryStatsLines(user) {
  const counts = Object.fromEntries(DISPLAY_CATEGORIES.map(category => [
    category,
    user.items.filter(item => item.category === category).length,
  ]));
  return [
    `Memory: ${user.enabled === false ? "off" : "on"}`,
    `总计: ${user.items.length} 条`,
    `性格: ${counts.trait} 条；偏好: ${counts.preference} 条；事实: ${counts.fact} 条`,
  ];
}

export function memoryListText(userId, { category = null, limit = 3, full = false } = {}) {
  const store = loadMemoryStore();
  const user = ensureUserMemory(store, userId);
  const selectedCategory = category ? normalizeMemoryCategory(category) : null;
  const categories = selectedCategory ? [selectedCategory] : DISPLAY_CATEGORIES;
  const lines = memoryStatsLines(user);
  const shownLimit = full ? Infinity : Math.max(1, Number(limit) || 3);
  if (!user.items.length) return `${lines.join("\n")}\n暂无记录`;

  for (const categoryName of categories) {
    const items = user.items.filter(item => item.category === categoryName);
    if (!items.length) continue;
    const shown = items.slice(0, shownLimit);
    lines.push("", `【${CATEGORY_LABELS[categoryName]}】`);
    for (const item of shown) {
      lines.push(`- ${item.id}: ${item.text}${item.sensitive ? " [sensitive]" : ""}`);
    }
    if (shown.length < items.length) lines.push(`... 另 ${items.length - shown.length} 条，用 /memory all 查看`);
  }
  if (selectedCategory && !user.items.some(item => item.category === selectedCategory)) {
    lines.push("", `【${CATEGORY_LABELS[selectedCategory]}】`, "暂无记录");
  }
  return lines.join("\n");
}

export function memoryMaintenanceNotice(userId, { mark = false } = {}) {
  const store = loadMemoryStore();
  const user = ensureUserMemory(store, userId);
  const prompt = renderMemoryPrompt(userId);
  const itemCount = user.items.length;
  const promptChars = prompt.length;
  const tooManyItems = itemCount > MEMORY_SOFT_ITEM_LIMIT;
  const tooLongPrompt = promptChars > MEMORY_SOFT_PROMPT_CHARS;
  if (!tooManyItems && !tooLongPrompt) return "";

  const now = Date.now();
  const last = user.lastMaintenanceNoticeAt ? Date.parse(user.lastMaintenanceNoticeAt) : 0;
  if (mark && now - last < MEMORY_NOTICE_INTERVAL_MS) return "";
  if (mark) {
    user.lastMaintenanceNoticeAt = new Date(now).toISOString();
    saveMemoryStore(store);
  }
  const reasons = [];
  if (tooManyItems) reasons.push(`已有 ${itemCount} 条，建议约 60 条以内`);
  if (tooLongPrompt) reasons.push(`注入上下文约 ${promptChars} 字，建议约 800-1200 字`);
  return `⚠️ Memory 偏长：${reasons.join("；")}。可以用 /memory 查看概要，或用 /memory all 查看完整内容后整理 wechat-memory.json。`;
}

export function shouldRunMemoryWriter(text = "") {
  const value = String(text || "").trim();
  if (!value) return false;
  return !/^\/\S+/.test(value);
}

function memoryWriterInstructionLines(currentPrompt) {
  return [
    "你是一个独立的长期记忆写入器，只判断用户消息是否包含值得长期保存的用户信息。",
    "你的输出会直接写入正式 memory；要像审慎的人类助手一样判断，而不是机械地一律 noop。",
    "只记录长期稳定且跨对话有用的信息，类别只能是 trait、preference、fact；每条都要简洁、可复用、避免聊天记录腔。",
    "trait 是世界观、价值观、稳定性格和用户自述的长期特质；preference 是明确个人喜好、互动偏好和表达偏好；fact 是用户长期事实或当前较长期的人生阶段。",
    "以下通常值得记录：宠物/长期陪伴对象的名字和稳定特点；用户明确说出的长期兴趣和习惯；用户正在长期学习、练习或培养的技能、乐器、运动、创作习惯；用户自述的稳定性格或情绪模式；用户对回复方式的长期偏好；当前正在持续的实习、转正、求职、学习、项目等阶段。",
    "写入时优先抽象成耐用表述：例如“用户目前处在实习、转正、求职相关阶段”，不要写成过细的当天事件；例如“用户不希望每次回复都被夸奖”，不要写成一次对话里的玩笑。",
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
    "用户消息：我已经好多了，我是一个情绪调节能力很强，情绪非常稳定的人，盼盼一直在",
    "输出：{\"ops\":[{\"op\":\"add\",\"category\":\"trait\",\"text\":\"用户自认情绪调节能力强且情绪稳定\",\"sensitive\":false}]}",
    "用户消息：又要重新开始找实习找工作了",
    "输出：{\"ops\":[{\"op\":\"add\",\"category\":\"fact\",\"text\":\"用户目前处在实习、转正、求职相关阶段\",\"sensitive\":false}]}",
    "用户消息：因为岗位不适合被裁了，又要重新开始找实习找工作",
    "输出：{\"ops\":[{\"op\":\"add\",\"category\":\"fact\",\"text\":\"用户目前处在实习、转正、求职相关阶段\",\"sensitive\":false}]}",
    "用户消息：我真的很喜欢这首！配合小彩的可爱舞蹈是绝佳",
    "输出：{\"ops\":[{\"op\":\"noop\"}]}",
    "",
    "现有记忆：",
    currentPrompt || "无",
  ];
}

export function buildMemoryWriterSystemPrompt(currentPrompt) {
  return memoryWriterInstructionLines(currentPrompt).join("\n");
}

export function buildMemoryWriterPrompt(userText, currentPrompt) {
  return [
    ...memoryWriterInstructionLines(currentPrompt),
    "",
    "用户消息：",
    userText,
  ].join("\n");
}

function firstJsonObject(raw) {
  const start = raw.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return "";
}

export function parseMemoryWriterOutput(text = "") {
  const raw = String(text).trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const jsonText = firstJsonObject(raw);
  if (!jsonText) return [];
  try {
    const data = JSON.parse(jsonText);
    return Array.isArray(data.ops) ? data.ops : [];
  } catch {
    return [];
  }
}
