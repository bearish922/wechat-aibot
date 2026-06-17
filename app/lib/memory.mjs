import fs from "node:fs";
import { dataPath, ensureDir, PROJECT_ROOT } from "./paths.mjs";
import { loadPrompts } from "./reply.mjs";
import { backendModel, runBackendStructured } from "./backend-adapter.mjs";

// 长期记忆文档的主文件路径(wechat-memory.md)
// 当指定 profile 时，使用 wechat-memory-{profile}.md 实现按角色分文件存储
export const MEMORY_FILE = dataPath("wechat-memory.md");
const memoryFileForProfile = (profile) => profile ? dataPath(`wechat-memory-${profile}.md`) : MEMORY_FILE;
// 长期记忆文档的备份文件路径
const MEMORY_BAK_FILE = dataPath("wechat-memory.bak.md");
const memoryBakForProfile = (profile) => profile ? dataPath(`wechat-memory-${profile}.bak.md`) : MEMORY_BAK_FILE;

// 世界记忆文档 —— 纯手动维护，不走 LLM update
const WORLD_MEMORY_FILE = dataPath("wechat-world-memory.md");
const WORLD_MEMORY_BAK_FILE = dataPath("wechat-world-memory.bak.md");
const worldMemoryFileForProfile = (profile) => profile ? dataPath(`wechat-world-memory-${profile}.md`) : WORLD_MEMORY_FILE;
const worldMemoryBakForProfile = (profile) => profile ? dataPath(`wechat-world-memory-${profile}.bak.md`) : WORLD_MEMORY_BAK_FILE;

// ─── core read/write ────────────────────────────────────────

// 从文件系统加载记忆 Markdown 文档
// profile: 角色名；为空时使用全局文件，非空时按角色分文件
// 返回: 记忆文档全文(字符串)，优先读主文件，主文件失败则读备份，都失败返回空字符串
export function loadMemoryDocument(profile = "") {
  const main = memoryFileForProfile(profile);
  const bak = memoryBakForProfile(profile);
  try {
    if (fs.existsSync(main)) {
      return fs.readFileSync(main, "utf-8").trim();
    }
  } catch {}
  try {
    if (fs.existsSync(bak)) {
      return fs.readFileSync(bak, "utf-8").trim();
    }
  } catch {}
  return "";
}

// 原子写入方式保存记忆文档：先写临时文件，备份旧文件，再重命名(原子写入防数据损坏)
// 参数: text - 要保存的 Markdown 文本; profile - 角色名，为空时使用全局文件
export function saveMemoryDocument(text, profile = "") {
  ensureDir(PROJECT_ROOT);
  const content = String(text || "").trim();
  if (!content) return;
  const main = memoryFileForProfile(profile);
  const bak = memoryBakForProfile(profile);
  const tmp = main + ".tmp";
  fs.writeFileSync(tmp, content, "utf-8");
  if (fs.existsSync(main)) {
    fs.copyFileSync(main, bak);
  }
  fs.renameSync(tmp, main);
}

// ─── LLM update ─────────────────────────────────────────────

// 调用 LLM 根据用户最近消息更新长期记忆文档(Markdown 格式)
// 参数: userMessages - 用户最近消息文本数组
// 返回: 更新后的记忆文档完整文本
export async function updateMemoryDocument(userMessages, backend = "cc", profile = "") {
  const msgs = (userMessages || []).filter(Boolean);
  if (!msgs.length) return loadMemoryDocument(profile);

  const prompt = loadPrompts(profile).memoryUpdatePrompt;
  if (!prompt) return loadMemoryDocument(profile);

  const currentDoc = loadMemoryDocument(profile);
  const input = [
    prompt,
    "",
    "当前记忆文档：",
    currentDoc || "(空——这是第一次创建)",
    "",
    "用户最近的消息（按时间顺序）：",
    msgs.map((m, i) => `[${i + 1}] ${m}`).join("\n\n"),
    "",
    "只输出以下 JSON（不要输出改动摘要、diff 或任何说明文字）：{\"result\":\"完整的更新后 Markdown 文档全文——不是你改了什么，而是改完之后的完整文档\"}",
  ].join("\n");

  const raw = await runBackendStructured(input, {
    backend,
    label: "memory_update",
    bare: false,
    model: backendModel(backend),
    timeoutMs: 120000,
    profile,
  });

  const updated = typeof raw === "string" ? raw : (raw?.result || raw?.text || "");
  if (updated && updated.trim()) {
    saveMemoryDocument(updated.trim(), profile);
  }
  return loadMemoryDocument(profile);
}

// ─── world memory (manual only, no LLM update) ──────────────

export function loadWorldMemoryDocument(profile = "") {
  const main = worldMemoryFileForProfile(profile);
  const bak = worldMemoryBakForProfile(profile);
  try {
    if (fs.existsSync(main)) return fs.readFileSync(main, "utf-8").trim();
  } catch {}
  try {
    if (fs.existsSync(bak)) return fs.readFileSync(bak, "utf-8").trim();
  } catch {}
  return "";
}

export function saveWorldMemoryDocument(text, profile = "") {
  ensureDir(PROJECT_ROOT);
  const content = String(text || "").trim();
  if (!content) return;
  const main = worldMemoryFileForProfile(profile);
  const bak = worldMemoryBakForProfile(profile);
  const tmp = main + ".tmp";
  fs.writeFileSync(tmp, content, "utf-8");
  if (fs.existsSync(main)) fs.copyFileSync(main, bak);
  fs.renameSync(tmp, main);
}

// ─── compatibility helpers used by the turn pipeline and eval scripts ───

// 检查记忆功能是否启用(始终返回 true，保留接口兼容性)
export function isMemoryEnabled() {
  return true;
}

// 判断用户输入文本是否应触发记忆写入(排除斜线命令)
// 参数: text - 用户输入文本
// 返回: true 应写入记忆，false 为命令消息不触发写入
export function shouldRunMemoryWriter(text = "") {
  const value = String(text || "").trim();
  if (!value) return false;
  // 以 "/" 开头的命令不触发记忆写入
  return !/^\/\S+/.test(value);
}

// 获取记忆文档的纯文本内容(用于注入 Prompt)
export function memoryItemsText(profile = "") {
  const doc = loadMemoryDocument(profile);
  if (!doc) return "";
  return doc;
}
