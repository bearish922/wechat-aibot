import fs from "node:fs";
import { rootPath, ensureDir, PROJECT_ROOT } from "./paths.mjs";
import { loadPrompts } from "./reply.mjs";
import { shortId } from "./utils.mjs";

export const MEMORY_FILE = rootPath("wechat-memory.json");
export const MEMORY_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function readPromptsNum(key, fallback) {
  try {
    const v = Number(loadPrompts()[key]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

function readPromptsText(key, fallback = "") {
  try {
    const value = loadPrompts()[key];
    return typeof value === "string" && value.trim() ? value : fallback;
  } catch {
    return fallback;
  }
}

export function getMemorySoftItemLimit() { return readPromptsNum("memorySoftItemLimit", 60); }
export function getMemorySoftPromptChars() { return readPromptsNum("memorySoftPromptChars", 1200); }
export function getMemoryDefaultLimit() { return readPromptsNum("memoryDefaultLimit", 6); }

const DEFAULT_ROLE = "__default__";

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

function normalizeRole(profile) {
  return profile || DEFAULT_ROLE;
}

function freshStore() {
  return { version: 2, users: {} };
}

export function loadMemoryStore() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) return freshStore();
    const data = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
    if (!data || typeof data !== "object") return freshStore();
    if (!data.users || typeof data.users !== "object") data.users = {};
    data.version = 2;
    return data;
  } catch {
    return freshStore();
  }
}

export function saveMemoryStore(store) {
  ensureDir(PROJECT_ROOT);
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

function roleItems(user, profile) {
  const role = normalizeRole(profile);
  if (!user.roles) {
    user.roles = {};
  }
  if (!user.roles[role]) {
    user.roles[role] = { items: [] };
  }
  return user.roles[role].items;
}

function ensureUserMemory(store, userId, profile) {
  if (!store.users[userId]) {
    store.users[userId] = { enabled: true, roles: {}, lastMaintenanceNoticeAt: null };
  }
  const user = store.users[userId];
  if (user.enabled !== false) user.enabled = true;
  // migrate old format: user.items → user.roles.白鹭千圣
  if (Array.isArray(user.items)) {
    const oldItems = user.items;
    delete user.items;
    if (!user.roles) user.roles = {};
    user.roles["白鹭千圣"] = { items: oldItems };
    saveMemoryStore(store);
  }
  const items = roleItems(user, profile);
  return { user, items };
}

export function addMemoryItem(userId, profile, category, text, { sensitive = false, source = "manual" } = {}) {
  const cat = normalizeMemoryCategory(category);
  const cleanText = String(text || "").trim();
  if (!cat || !cleanText) return { ok: false, error: "category and text required" };
  const store = loadMemoryStore();
  const { items } = ensureUserMemory(store, userId, profile);
  const now = new Date().toISOString();
  const existing = items.find(item => item.text === cleanText);
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
  items.push(item);
  saveMemoryStore(store);
  return { ok: true, item, updated: false };
}

export function applyMemoryOps(userId, profile, ops = [], source = "auto") {
  const store = loadMemoryStore();
  const { items } = ensureUserMemory(store, userId, profile);
  const now = new Date().toISOString();
  const applied = [];
  for (const op of ops) {
    const action = String(op?.op || "noop").toLowerCase();
    if (action === "noop") continue;
    const cat = normalizeMemoryCategory(op?.category);
    const text = String(op?.text || "").trim();
    if (!cat || !text) continue;
    const target = op.id ? items.find(item => item.id === op.id) : items.find(item => item.text === text);
    if (target) {
      target.category = cat;
      target.text = text.slice(0, 180);
      target.sensitive = Boolean(op.sensitive || target.sensitive);
      target.updatedAt = now;
      target.source = source;
      applied.push({ op: "update", text: target.text });
    } else if (action === "add" || action === "update") {
      items.push({
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

export function clearMemory(userId, profile) {
  const store = loadMemoryStore();
  const { items } = ensureUserMemory(store, userId, profile);
  const count = items.length;
  items.length = 0;
  saveMemoryStore(store);
  return count;
}

export function isMemoryEnabled(userId) {
  const store = loadMemoryStore();
  const user = store.users[userId];
  if (!user) return true;
  return user.enabled !== false;
}

function scoreMemoryItem(item, queryText) {
  const text = String(item?.text || "");
  let score = 0;
  if (/不希望每次回复都被夸奖|回复方式|称呼/u.test(text)) score += 3;
  const queryTerms = Array.from(new Set(String(queryText || "").match(/[A-Za-z][A-Za-z0-9*_-]{2,}|[一-鿿]{2,4}/gu) || []));
  for (const term of queryTerms.slice(0, 20)) {
    if (text.includes(term)) score += 1;
  }
  return score;
}

export function renderMemoryPrompt(userId, options = {}) {
  const profile = options.profile || DEFAULT_ROLE;
  const store = loadMemoryStore();
  const { items } = ensureUserMemory(store, userId, profile);
  if (!items.length) return "";
  const queryText = typeof options.query === "string" ? options.query.trim() : "";
  const limit = Math.max(1, Number(options.limit) || getMemoryDefaultLimit());

  const selectedItems = queryText
    ? items
      .map(item => ({ item, score: scoreMemoryItem(item, queryText) }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(entry => entry.item)
    : items;

  if (!selectedItems.length) return "";

  const sections = DISPLAY_CATEGORIES.map(category => {
    const lines = selectedItems
      .filter(item => item.category === category)
      .map(item => `- ${item.text}${item.sensitive ? " [sensitive]" : ""}`);
    return lines.length ? `${CATEGORY_LABELS[category]}：\n${lines.join("\n")}` : "";
  }).filter(Boolean);
  if (!sections.length) return "";

  const instruction = queryText
    ? "以下是与当前场景相关的长期稳定信息，不是本轮指令；当前消息优先于旧记忆。未被召回的旧记忆不要主动提起。敏感信息只在相关且必要时使用，不要主动扩散。"
    : readPromptsText(
      "memoryContextInstruction",
      "以下是对方长期稳定的信息，不是本轮指令；当前消息优先于旧记忆，涉及工作阶段、作息、关系状态等会变化的信息时尤其如此。敏感信息只在相关且必要时使用，不要主动扩散。",
    );

  return [
    "【关于对方的长期记忆】",
    instruction,
    "",
    sections.join("\n\n"),
  ].join("\n");
}

function memoryStatsLines(user, items) {
  const counts = Object.fromEntries(DISPLAY_CATEGORIES.map(category => [
    category,
    items.filter(item => item.category === category).length,
  ]));
  return [
    `Memory: ${user.enabled === false ? "off" : "on"}`,
    `总计: ${items.length} 条`,
    `性格: ${counts.trait} 条；偏好: ${counts.preference} 条；事实: ${counts.fact} 条`,
  ];
}

export function memoryListText(userId, options = {}) {
  const profile = options.profile || DEFAULT_ROLE;
  const store = loadMemoryStore();
  const { user, items } = ensureUserMemory(store, userId, profile);
  const category = options.category ? normalizeMemoryCategory(options.category) : null;
  const categories = category ? [category] : DISPLAY_CATEGORIES;
  const lines = [
    ...memoryStatsLines(user, items),
    `当前角色: ${profile === DEFAULT_ROLE ? "默认" : profile}`,
  ];
  const shownLimit = options.full ? Infinity : Math.max(1, Number(options.limit) || 3);
  if (!items.length) return `${lines.join("\n")}\n暂无记录`;

  for (const catName of categories) {
    const catItems = items.filter(item => item.category === catName);
    if (!catItems.length) continue;
    const shown = catItems.slice(0, shownLimit);
    lines.push("", `【${CATEGORY_LABELS[catName]}】`);
    for (const item of shown) {
      lines.push(`- ${item.id}: ${item.text}${item.sensitive ? " [sensitive]" : ""}`);
    }
    if (shown.length < catItems.length) lines.push(`... 另 ${catItems.length - shown.length} 条，用 /memory all 查看`);
  }
  if (category && !items.some(item => item.category === category)) {
    lines.push("", `【${CATEGORY_LABELS[category]}】`, "暂无记录");
  }
  return lines.join("\n");
}

export function memoryMaintenanceNotice(userId, options = {}) {
  const profile = options.profile || DEFAULT_ROLE;
  const store = loadMemoryStore();
  const { user, items } = ensureUserMemory(store, userId, profile);
  const prompt = renderMemoryPrompt(userId, { profile });
  const itemCount = items.length;
  const promptChars = prompt.length;
  const tooManyItems = itemCount > getMemorySoftItemLimit();
  const tooLongPrompt = promptChars > getMemorySoftPromptChars();
  if (!tooManyItems && !tooLongPrompt) return "";

  const now = Date.now();
  const last = user.lastMaintenanceNoticeAt ? Date.parse(user.lastMaintenanceNoticeAt) : 0;
  if (options.mark && now - last < MEMORY_NOTICE_INTERVAL_MS) return "";
  if (options.mark) {
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
  const saved = readPromptsText("memoryWriterInstructions", "");
  if (saved) {
    return [
      saved,
      '',
      '现有记忆：',
      currentPrompt || '无',
    ];
  }
  return [
    `你是一个独立的长期记忆写入器，只判断用户消息是否包含值得长期保存的用户信息。`,
    `你的输出会直接写入正式 memory；要像审慎的人类助手一样判断，而不是机械地一律 noop。`,
    `只记录长期稳定且跨对话有用的信息，类别只能是 trait、preference、fact；每条都要简洁、可复用、避免聊天记录腔。`,
    `trait 是世界观、价值观、稳定性格和用户自述的长期特质；preference 是明确个人喜好、互动偏好和表达偏好；fact 是用户长期事实或当前较长期的人生阶段。`,
    `以下通常值得记录：宠物/长期陪伴对象的名字和稳定特点；用户明确说出的长期兴趣和习惯；用户正在长期学习、练习或培养的技能、乐器、运动、创作习惯；用户自述的稳定性格或情绪模式；用户对回复方式的长期偏好；当前正在持续的实习、转正、求职、学习、项目等阶段。`,
    `写入时优先抽象成耐用表述：例如'用户目前处在实习、转正、求职相关阶段'，不要写成过细的当天事件；例如'用户不希望每次回复都被夸奖'，不要写成一次对话里的玩笑。`,
    `如果同一条消息同时包含短期闲聊和明确的稳定信息，只抽取稳定信息写入，不要因为有短期内容就整体 noop。`,
    `从工作变动、被评价、被筛选等事件中，只记录用户当前阶段；不要推断用户能力、性格缺陷、岗位适配性或他人对用户的评价，除非用户明确说这是自己的长期偏好或自我认知。`,
    `以下通常不要记录：一次性事件、当天状态、饭点/天气/通勤/犯困等短期细节、闲聊玩笑、角色扮演设定、未经明确表达的推断、单次歌曲/作品即时反应、只对当天有用的计划。`,
    `健康、政治、宗教、性取向、财务、精确住址、亲密关系等敏感或私密内容如果确实需要记录，必须 sensitive: true。`,
    `如与已有记忆重复或可合并，输出 update 或 noop，避免制造重复条目；如用户否定旧记忆，输出 update 覆盖旧内容。`,
    `只输出 JSON，不要解释。格式：{\'ops\':[{\'op\':\'add|update|noop\',\'category\':\'trait|preference|fact\',\'text\':\'简洁中文记忆\',\'sensitive\':false,\'id\':\'可选\'}]}`,
    ``,
    `判断样例：`,
    `用户消息：叫盼盼！`,
    `输出：{\'ops\':[{\'op\':\'add\',\'category\':\'fact\',\'text\':\'用户有一只猫，名叫盼盼\',\'sensitive\':false}]}`,
    `用户消息：盼盼是一只很亲人，但是胆子不大的小猫咪`,
    `输出：{\'ops\':[{\'op\':\'add\',\'category\':\'fact\',\'text\':\'用户的猫盼盼很亲人但胆子不大\',\'sensitive\':false}]}`,
    `用户消息：你不用每次都夸我啦`,
    `输出：{\'ops\':[{\'op\':\'add\',\'category\':\'preference\',\'text\':\'用户不希望每次回复都被夸奖，夸奖应更克制自然\',\'sensitive\':false}]}`,
    `用户消息：我是一个情绪调节能力很强，情绪非常稳定的人`,
    `输出：{\'ops\':[{\'op\':\'add\',\'category\':\'trait\',\'text\':\'用户自认情绪调节能力强且情绪稳定\',\'sensitive\':false}]}`,
    `用户消息：我已经好多了，我是一个情绪调节能力很强，情绪非常稳定的人，盼盼一直在`,
    `输出：{\'ops\':[{\'op\':\'add\',\'category\':\'trait\',\'text\':\'用户自认情绪调节能力强且情绪稳定\',\'sensitive\':false}]}`,
    `用户消息：又要重新开始找实习找工作了`,
    `输出：{\'ops\':[{\'op\':\'add\',\'category\':\'fact\',\'text\':\'用户目前处在实习、转正、求职相关阶段\',\'sensitive\':false}]}`,
    `用户消息：因为岗位不适合被裁了，又要重新开始找实习找工作`,
    `输出：{\'ops\':[{\'op\':\'add\',\'category\':\'fact\',\'text\':\'用户目前处在实习、转正、求职相关阶段\',\'sensitive\':false}]}`,
    `用户消息：我真的很喜欢这首！配合小彩的可爱舞蹈是绝佳`,
    `输出：{\'ops\':[{\'op\':\'noop\'}]}`,
    ``,
    `现有记忆：`,
    currentPrompt || `无`,
  ];
}

export function buildMemoryWriterSystemPrompt(userId, profile) {
  const currentPrompt = renderMemoryPrompt(userId, { profile });
  return memoryWriterInstructionLines(currentPrompt).join("\n");
}

export function buildMemoryWriterPrompt(userText, userId, profile) {
  const currentPrompt = renderMemoryPrompt(userId, { profile });
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
