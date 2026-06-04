import { addRoute } from "./server.mjs";
import { loadMemoryStore, saveMemoryStore, normalizeMemoryCategory } from "./memory.mjs";
import { shortId } from "./utils.mjs";

const DISPLAY_CATEGORIES = ["trait", "preference", "fact"];

function flattenMemory(store) {
  const entries = [];
  for (const [userId, user] of Object.entries(store.users || {})) {
    for (const [role, roleData] of Object.entries(user.roles || {})) {
      for (const item of roleData.items || []) {
        entries.push({
          ...item,
          userId,
          role,
          enabled: user.enabled !== false,
        });
      }
    }
  }
  return entries;
}

export function registerMemoryRoutes() {
  addRoute("GET", "/api/memory", () => {
    const store = loadMemoryStore();
    const entries = flattenMemory(store);
    const userIds = Object.keys(store.users || {});
    const users = userIds.map(uid => {
      const user = store.users[uid];
      const roles = Object.keys(user.roles || {});
      return { userId: uid, displayName: user.displayName || "", enabled: user.enabled !== false, roles };
    });
    return { ok: true, entries, users };
  });

  addRoute("POST", "/api/memory", ({ body }) => {
    const { userId, role, category, text, sensitive } = body || {};
    if (!userId || !role || !category || !text) {
      return { ok: false, error: "userId, role, category, and text are required" };
    }
    const cat = normalizeMemoryCategory(category);
    if (!cat) return { ok: false, error: `Invalid category: ${category}. Use trait, preference, or fact.` };
    const store = loadMemoryStore();
    if (!store.users[userId]) {
      store.users[userId] = { enabled: true, roles: {} };
    }
    if (!store.users[userId].roles) {
      store.users[userId].roles = {};
    }
    if (!store.users[userId].roles[role]) {
      store.users[userId].roles[role] = { items: [] };
    }
    const items = store.users[userId].roles[role].items;
    const now = new Date().toISOString();
    const cleanText = String(text).trim().slice(0, 180);
    // deduplicate by text
    const existing = items.find(item => item.text === cleanText);
    if (existing) {
      existing.category = cat;
      existing.sensitive = Boolean(sensitive || existing.sensitive);
      existing.updatedAt = now;
      existing.source = "manual";
      saveMemoryStore(store);
      return { ok: true, item: existing, updated: true };
    }
    const item = {
      id: `mem_${shortId()}`,
      category: cat,
      text: cleanText,
      sensitive: Boolean(sensitive),
      source: "manual",
      createdAt: now,
      updatedAt: now,
    };
    items.push(item);
    saveMemoryStore(store);
    return { ok: true, item, updated: false };
  });

  addRoute("PUT", "/api/memory", ({ body }) => {
    const { id, category, text, sensitive, userId, role } = body || {};
    if (!id || !userId || !role) {
      return { ok: false, error: "id, userId, and role are required" };
    }
    const store = loadMemoryStore();
    const user = store.users?.[userId];
    if (!user) return { ok: false, error: "User not found" };
    const items = user.roles?.[role]?.items;
    if (!items) return { ok: false, error: "Role not found" };
    const item = items.find(item => item.id === id);
    if (!item) return { ok: false, error: "Memory item not found" };
    const now = new Date().toISOString();
    if (category !== undefined) {
      const cat = normalizeMemoryCategory(category);
      if (!cat) return { ok: false, error: `Invalid category: ${category}` };
      item.category = cat;
    }
    if (text !== undefined) {
      item.text = String(text).trim().slice(0, 180);
    }
    if (sensitive !== undefined) {
      item.sensitive = Boolean(sensitive);
    }
    item.updatedAt = now;
    saveMemoryStore(store);
    return { ok: true, item };
  });

  addRoute("DELETE", "/api/memory", ({ body }) => {
    const { id, userId, role } = body || {};
    if (!id || !userId || !role) {
      return { ok: false, error: "id, userId, and role are required" };
    }
    const store = loadMemoryStore();
    const user = store.users?.[userId];
    if (!user) return { ok: false, error: "User not found" };
    const items = user.roles?.[role]?.items;
    if (!items) return { ok: false, error: "Role not found" };
    const idx = items.findIndex(item => item.id === id);
    if (idx < 0) return { ok: false, error: "Memory item not found" };
    const [removed] = items.splice(idx, 1);
    saveMemoryStore(store);
    return { ok: true, removed };
  });

  addRoute("PUT", "/api/memory/user", ({ body }) => {
    const { userId, displayName } = body || {};
    if (!userId) return { ok: false, error: "userId is required" };
    const store = loadMemoryStore();
    if (!store.users[userId]) return { ok: false, error: "User not found" };
    store.users[userId].displayName = String(displayName || "").trim();
    saveMemoryStore(store);
    return { ok: true, userId, displayName: store.users[userId].displayName };
  });
}
