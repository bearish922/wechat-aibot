import fs from "node:fs";
import { dataPath, ensureDir, PROJECT_ROOT } from "./paths.mjs";
import { loadPrompts } from "./reply.mjs";
import { CLAUDE_MAIN_MODEL, runHiddenCall } from "./claude-runner.mjs";

// 长期记忆文档的主文件路径(wechat-memory.md)
export const MEMORY_FILE = dataPath("wechat-memory.md");
// 长期记忆文档的备份文件路径
const MEMORY_BAK_FILE = dataPath("wechat-memory.bak.md");

// 世界记忆文档 —— 纯手动维护，不走 LLM update
const WORLD_MEMORY_FILE = dataPath("wechat-world-memory.md");
const WORLD_MEMORY_BAK_FILE = dataPath("wechat-world-memory.bak.md");

// ─── core read/write ────────────────────────────────────────

// 从文件系统加载记忆 Markdown 文档
// 返回: 记忆文档全文(字符串)，优先读主文件，主文件失败则读备份，都失败返回空字符串
export function loadMemoryDocument() {
  try {
    // 优先读主文件
    if (fs.existsSync(MEMORY_FILE)) {
      return fs.readFileSync(MEMORY_FILE, "utf-8").trim();
    }
  } catch {}
  try {
    // 主文件不可用时回退到备份
    if (fs.existsSync(MEMORY_BAK_FILE)) {
      return fs.readFileSync(MEMORY_BAK_FILE, "utf-8").trim();
    }
  } catch {}
  return "";
}

// 原子写入方式保存记忆文档：先写临时文件，备份旧文件，再重命名(原子写入防数据损坏)
// 参数: text - 要保存的 Markdown 文本
export function saveMemoryDocument(text) {
  ensureDir(PROJECT_ROOT);
  const content = String(text || "").trim();
  // 空内容不写入，防止误清空记忆
  if (!content) return;
  const tmp = MEMORY_FILE + ".tmp";
  // 先写入临时文件
  fs.writeFileSync(tmp, content, "utf-8");
  // 备份当前主文件
  if (fs.existsSync(MEMORY_FILE)) {
    fs.copyFileSync(MEMORY_FILE, MEMORY_BAK_FILE);
  }
  // 原子重命名: 将临时文件替换为主文件
  fs.renameSync(tmp, MEMORY_FILE);
}

// ─── LLM update ─────────────────────────────────────────────

// 调用 LLM 根据用户最近消息更新长期记忆文档(Markdown 格式)
// 参数: userMessages - 用户最近消息文本数组
// 返回: 更新后的记忆文档完整文本
export async function updateMemoryDocument(userMessages) {
  const msgs = (userMessages || []).filter(Boolean);
  // 无消息时不更新
  if (!msgs.length) return loadMemoryDocument();

  // 加载记忆更新 Prompt 模板
  const prompt = loadPrompts().memoryUpdatePrompt;
  if (!prompt) return loadMemoryDocument();

  // 构建 LLM 输入：Prompt 模板 + 当前记忆 + 用户最新消息
  const currentDoc = loadMemoryDocument();
  const input = [
    prompt,
    "",
    "当前记忆文档：",
    currentDoc || "(空——这是第一次创建)",
    "",
    "用户最近的消息（按时间顺序）：",
    msgs.map((m, i) => `[${i + 1}] ${m}`).join("\n\n"),
    "",
    "请输出更新后的完整 Markdown 文档（不要 JSON，直接输出 Markdown）：",
  ].join("\n");

  // 调用隐藏 LLM 生成更新后的记忆文档(bare=false 获取原始文本)
  const raw = await runHiddenCall(input, {
    label: "memory_update",
    bare: false,
    model: CLAUDE_MAIN_MODEL,
    timeoutMs: 120000,
  });

  // 解析返回结果：可能是纯文本字符串或 JSON 包装对象
  const updated = typeof raw === "string" ? raw : (raw?.result || raw?.text || "");
  if (updated && updated.trim()) {
    // 原子写入更新后的记忆文档
    saveMemoryDocument(updated.trim());
  }
  return loadMemoryDocument();
}

// ─── world memory (manual only, no LLM update) ──────────────

export function loadWorldMemoryDocument() {
  try {
    if (fs.existsSync(WORLD_MEMORY_FILE)) {
      return fs.readFileSync(WORLD_MEMORY_FILE, "utf-8").trim();
    }
  } catch {}
  try {
    if (fs.existsSync(WORLD_MEMORY_BAK_FILE)) {
      return fs.readFileSync(WORLD_MEMORY_BAK_FILE, "utf-8").trim();
    }
  } catch {}
  return "";
}

export function saveWorldMemoryDocument(text) {
  ensureDir(PROJECT_ROOT);
  const content = String(text || "").trim();
  if (!content) return;
  const tmp = WORLD_MEMORY_FILE + ".tmp";
  fs.writeFileSync(tmp, content, "utf-8");
  if (fs.existsSync(WORLD_MEMORY_FILE)) {
    fs.copyFileSync(WORLD_MEMORY_FILE, WORLD_MEMORY_BAK_FILE);
  }
  fs.renameSync(tmp, WORLD_MEMORY_FILE);
}

// ─── legacy API (kept for bot commands) ─────────────────────

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
// 返回: 记忆文档文本
export function memoryItemsText() {
  const doc = loadMemoryDocument();
  if (!doc) return "";
  return doc;
}

// 获取格式化的记忆列表展示文本(带标题和长度信息)
// 返回: 格式化的记忆展示字符串
export function memoryListText() {
  const doc = loadMemoryDocument();
  if (!doc) return "暂无记忆记录。";
  return `当前记忆文档 (${doc.length} 字符)：\n\n${doc}`;
}
