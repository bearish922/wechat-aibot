import fs from "node:fs";
import { dataPath, ensureDir, PROJECT_ROOT } from "./paths.mjs";
import { shortId } from "./utils.mjs";

export const MEMORY_FILE = dataPath("wechat-memory.json");

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

export function memoryItemsText(userId, options = {}) {
  const profile = options.profile || DEFAULT_ROLE;
  const store = loadMemoryStore();
  const { items } = ensureUserMemory(store, userId, profile);
  if (!items.length) return "";

  const sections = DISPLAY_CATEGORIES.map(category => {
    const lines = items
      .filter(item => item.category === category)
      .map(item => `- ${item.text}${item.sensitive ? " [sensitive]" : ""}`);
    return lines.length ? `${CATEGORY_LABELS[category]}：\n${lines.join("\n")}` : "";
  }).filter(Boolean);
  if (!sections.length) return "";

  return sections.join("\n\n");
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

export function listMemoryItems(userId, options = {}) {
  const profile = options.profile || DEFAULT_ROLE;
  const store = loadMemoryStore();
  const { items } = ensureUserMemory(store, userId, profile);
  return items.map(item => ({
    id: item.id,
    category: item.category,
    text: item.text,
    sensitive: Boolean(item.sensitive),
    source: item.source || "",
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
  }));
}


export function shouldRunMemoryWriter(text = "") {
  const value = String(text || "").trim();
  if (!value) return false;
  return !/^\/\S+/.test(value);
}

