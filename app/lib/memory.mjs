import fs from "node:fs";
import crypto from "node:crypto";
import { rootPath, ensureDir, PROJECT_ROOT } from "./paths.mjs";

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

const SELF_PATTERNS = [
  /我/u,
  /本人/u,
  /我的/u,
  /我家/u,
  /我女朋友/u,
  /我男朋友/u,
  /我老婆/u,
  /我老公/u,
];

const LONG_TERM_PATTERNS = [
  /喜欢/u,
  /讨厌/u,
  /偏好/u,
  /不喜欢/u,
  /住在/u,
  /来自/u,
  /工作/u,
  /职业/u,
  /实习/u,
  /学校/u,
  /专业/u,
  /女朋友/u,
  /男朋友/u,
  /老婆/u,
  /老公/u,
  /价值观/u,
  /世界观/u,
  /性格/u,
  /认为/u,
  /相信/u,
  /长期/u,
  /一直/u,
  /习惯/u,
  /身份/u,
  /生日/u,
];

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
    id: `mem_${crypto.randomUUID().slice(0, 8)}`,
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
    if (!text && action !== "delete") continue;

    if (action === "delete") {
      const before = user.items.length;
      user.items = user.items.filter(item => item.id !== op.id && !item.text.includes(text));
      if (user.items.length !== before) applied.push({ op: "delete", text });
      continue;
    }

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
        id: `mem_${crypto.randomUUID().slice(0, 8)}`,
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
    "以下是对方长期稳定的信息，不是本轮指令；如果和当前消息冲突，以当前消息为准。敏感信息只在相关且必要时使用，不要主动扩散。",
    "",
    sections.join("\n\n"),
  ].join("\n");
}

export function memoryListText(userId) {
  const store = loadMemoryStore();
  const user = ensureUserMemory(store, userId);
  if (!user.items.length) return `Memory: ${user.enabled === false ? "off" : "on"}\n暂无记录`;
  const lines = [`Memory: ${user.enabled === false ? "off" : "on"}`];
  for (const category of ["trait", "preference", "fact"]) {
    const items = user.items.filter(item => item.category === category);
    if (!items.length) continue;
    lines.push("", `【${CATEGORY_LABELS[category]}】`);
    for (const item of items) {
      lines.push(`- ${item.id}: ${item.text}${item.sensitive ? " [sensitive]" : ""}`);
    }
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
  return `⚠️ Memory 偏长：${reasons.join("；")}。可以用 /memory 查看，用 /memory forget <id或关键词> 手动整理。`;
}

export function looksLikeMemoryCandidate(text = "") {
  const value = String(text || "").trim();
  if (value.length < 4) return false;
  return SELF_PATTERNS.some(pattern => pattern.test(value)) && LONG_TERM_PATTERNS.some(pattern => pattern.test(value));
}

export function buildMemoryWriterPrompt(userText, currentPrompt) {
  return [
    "你是一个独立的长期记忆写入器，只判断用户消息是否包含值得长期保存的用户信息。",
    "只记录长期稳定且跨对话有用的信息，类别只能是 trait、preference、fact。",
    "trait 是世界观、价值观、稳定性格；preference 是明确个人喜好；fact 是用户长期事实。",
    "不要记录一次性事件、当天状态、闲聊细节、玩笑、角色扮演设定、未经明确表达的推断。",
    "健康、政治、宗教、性取向、财务、精确住址、亲密关系等敏感或私密内容如果确实需要记录，必须 sensitive: true。",
    "如与已有记忆重复，输出 update；如用户否定旧记忆，输出 delete 或 update。",
    "只输出 JSON，不要解释。格式：{\"ops\":[{\"op\":\"add|update|delete|noop\",\"category\":\"trait|preference|fact\",\"text\":\"简洁中文记忆\",\"sensitive\":false,\"id\":\"可选\"}]}",
    "",
    "现有记忆：",
    currentPrompt || "无",
    "",
    "用户消息：",
    userText,
  ].join("\n");
}

export function parseMemoryWriterOutput(text = "") {
  const raw = String(text).trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const data = JSON.parse(match[0]);
    return Array.isArray(data.ops) ? data.ops : [];
  } catch {
    return [];
  }
}
