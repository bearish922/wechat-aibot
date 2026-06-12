import fs from "node:fs";
import { uuid, log } from "./utils.mjs";
import { DATA_DIR, dataPath, ensureDir } from "./paths.mjs";
import { sessions, profileTemplates, activeAI, pendingInputs } from "./state.mjs";
import { saveRoleWorlds } from "./world-state.mjs";
import { normalizeFailedTurn, normalizeVisibleHistory, normalizeProactiveIntents } from "./normalize.mjs";

// session 持久化主文件路径
const SESSION_FILE = dataPath("wechat-sessions.json");
// 角色模板/profile 配置文件路径
const PROFILE_FILE = dataPath("wechat-profiles.json");

// 从 wechat-profiles.json 加载角色模板到全局 profileTemplates 对象
// 文件不存在或解析失败时，回退到只有 "默认" 模板
export function loadProfiles() {
  // 先清空现有模板
  for (const k of Object.keys(profileTemplates)) delete profileTemplates[k];
  try {
    if (fs.existsSync(PROFILE_FILE)) {
      const d = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf-8"));
      // 使用文件中的 templates 字段，缺失时回退默认
      Object.assign(profileTemplates, d.templates || { "默认": "保持 AI 的默认风格" });
    } else {
      // 文件不存在时使用硬编码默认模板
      Object.assign(profileTemplates, { "默认": "保持 AI 的默认风格" });
    }
  } catch { Object.assign(profileTemplates, { "默认": "保持 AI 的默认风格" }); }
}

// 创建一个全新的 session 对象，初始化所有运行时字段为默认值
// 参数: name - session 显示名称; profile - 可选的绑定角色模板名称
// 返回: 全新的 session 对象
export function makeSession(name, profile = null) {
  return {
    id: uuid(),
    name,
    // 忙标记：正在处理消息时为 true
    busy: false,
    // 消息队列
    queue: [],
    // 关闭中标记
    _closing: false,
    // 上次结束时间戳
    _lastEnd: 0,
    // 会话标识符
    sid: uuid(),
    // 是否为首轮对话
    _firstTurn: true,
    // 绑定的角色模板
    _profile: profile,
    // 上次失败的轮次
    _lastFailedTurn: null,
    // 用户可见的对话历史
    _visibleHistory: [],
    // 主动消息意图列表
    _proactiveIntents: [],
    // 上次用户消息时间
    _lastUserAt: null,
    // 上次助手消息时间
    _lastAssistantAt: null,
    // 上次主动消息时间
    _lastProactiveAt: null,
    // 上一条消息的 context_token
    _lastContextToken: null,
    // 上次隐藏调用工具使用统计
    _lastUsage: null,
    // API 模式下的消息累积
    _apiMessages: [],
    // 轮次计数
    _turnCount: 0,
  };
}

// 从持久化的原始数据还原 session 对象(通过各规范化器清洗字段)
// 参数: ai - AI 后端标识("cc" 或 "codex"); raw - 持久化的原始 session 数据
// 返回: 还原后的完整 session 对象
export function hydrateSession(ai, raw = {}) {
  return {
    id: raw.id || uuid(),
    name: raw.name || "S1",
    sid: raw.sid || uuid(),
    _firstTurn: raw._firstTurn ?? true,
    // 运行时字段重置为非持久化状态
    busy: false,
    queue: [],
    _closing: false,
    _lastEnd: 0,
    _profile: raw._profile ?? null,
    // 以下字段逐一通过规范化器处理
    _lastFailedTurn: normalizeFailedTurn(raw._lastFailedTurn),
    _visibleHistory: normalizeVisibleHistory(raw._visibleHistory),
    _proactiveIntents: normalizeProactiveIntents(raw._proactiveIntents),
    _lastUserAt: raw._lastUserAt ? String(raw._lastUserAt) : null,
    _lastAssistantAt: raw._lastAssistantAt ? String(raw._lastAssistantAt) : null,
    _lastProactiveAt: raw._lastProactiveAt ? String(raw._lastProactiveAt) : null,
    _lastContextToken: raw._lastContextToken ? String(raw._lastContextToken) : null,
    // 轮次计数
    _turnCount: typeof raw._turnCount === "number" ? raw._turnCount : 0,
    // lastUsage 深拷贝以避免引用共享
    _lastUsage: raw._lastUsage && typeof raw._lastUsage === "object" ? { ...raw._lastUsage } : null,
    _apiMessages: Array.isArray(raw._apiMessages) ? raw._apiMessages : [],
  };
}

// 将所有 session 数据原子写入持久化到 JSON 文件(wechat-sessions.json)
// 采用 tmp -> bak -> rename 三步原子写入策略防止数据损坏
export function saveSessions() {
  ensureDir(DATA_DIR);
  // 构建持久化数据结构: { _lastActiveAI, cc/codex: { userId: { activeId, list } } }
  const data = { _lastActiveAI: activeAI };
  // 遍历所有 AI 后端(cc, codex)
  for (const [ai, map] of Object.entries(sessions)) {
    const aiData = {};
    // 遍历每个 AI 后端下的所有用户
    for (const [userId, u] of map) {
      aiData[userId] = {
        activeId: u.activeId,
        // 每个 session 只保留持久化字段(通过规范化器清洗)，过滤掉运行时字段(busy, queue, _closing 等)
        list: u.list.map(s => ({
          id: s.id,
          name: s.name,
          sid: s.sid,
          _firstTurn: s._firstTurn,
          _profile: s._profile ?? null,
          // 规范化器保证存储格式一致
          _lastFailedTurn: normalizeFailedTurn(s._lastFailedTurn),
          _visibleHistory: normalizeVisibleHistory(s._visibleHistory),
          _proactiveIntents: normalizeProactiveIntents(s._proactiveIntents),
          _lastUserAt: s._lastUserAt || null,
          _lastAssistantAt: s._lastAssistantAt || null,
          _lastProactiveAt: s._lastProactiveAt || null,
          _lastContextToken: s._lastContextToken || null,
          _turnCount: typeof s._turnCount === "number" ? s._turnCount : 0,
          // lastUsage 深拷贝
          _lastUsage: s._lastUsage && typeof s._lastUsage === "object" ? { ...s._lastUsage } : null,
          _apiMessages: Array.isArray(s._apiMessages) ? s._apiMessages : [],
        })),
      };
    }
    data[ai] = aiData;
  }
  // 三步原子写入: 写 tmp -> 备份原文件 -> rename
  const tmp = SESSION_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  if (fs.existsSync(SESSION_FILE)) {
    fs.copyFileSync(SESSION_FILE, SESSION_FILE.replace(/\.json$/, ".bak.json"));
  }
  fs.renameSync(tmp, SESSION_FILE);
  // session 保存后同步保存角色世界数据
  saveRoleWorlds();
}

// 从 JSON 文件加载 session 数据到全局 sessions 对象
// 兼容旧格式(顶层为用户数据)和新格式(顶层为 cc/codex 键)
// 返回: true 加载成功，false 文件不存在或解析失败
export function loadSessions() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
      const topKeys = Object.keys(data);
      // 通过顶层 key 判断是新格式还是旧格式
      const isNewFormat = topKeys.includes("cc") || topKeys.includes("codex") || topKeys.includes("api");
      if (!isNewFormat) {
        // 旧格式: 顶层键为 userId，所有数据归到 cc 后端
        const ccMap = new Map();
        for (const [userId, u] of Object.entries(data)) {
          ccMap.set(userId, {
            activeId: u.activeId,
            list: (u.list || []).map(s => hydrateSession("cc", s)),
          });
        }
        sessions.cc = ccMap;
        // codex 初始化为空 Map
        sessions.codex = new Map();
        sessions.api = new Map();
      } else {
        // 新格式: 顶层键为 "cc" / "codex"
        for (const ai of ["cc", "codex", "api"]) {
          const aiData = data[ai] || {};
          const map = new Map();
          for (const [userId, u] of Object.entries(aiData)) {
            map.set(userId, {
              activeId: u.activeId,
              list: (u.list || []).map(s => hydrateSession(ai, s)),
            });
          }
          sessions[ai] = map;
        }
      }
      return true;
    }
  } catch (e) { log("⚠️", `load sessions failed: ${e.message}`); }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// sessionMap() —— 获取指定 AI 后端的会话映射表
// ═══════════════════════════════════════════════════════════════
// 用途：每个后端拥有独立线程；角色级记忆和世界状态在 world-state 中共享
// 输入：ai - AI 后端标识 ("cc"/"api"/"codex")，默认使用全局 activeAI
// 输出：Map<userId, userSessionStore>
export function sessionMap(ai) { const k = ai || activeAI; return sessions[k] || sessions.cc; }

// ═══════════════════════════════════════════════════════════════
// ensureUser() —— 确保用户存在于会话映射中
// ═══════════════════════════════════════════════════════════════
// 用途：如果指定 userId 在会话映射中不存在，自动为其创建一个默认会话 "S1"
// 输入：userId - 用户微信 ID；ai - AI 后端标识（可选，默认 activeAI）
// 输出：该用户的会话存储对象 { activeId, list }
export function ensureUser(userId, ai = activeAI) {
  const sMap = sessionMap(ai);
  if (!sMap.has(userId)) {
    // 为用户创建初始会话 "S1"
    const sess = makeSession("S1");
    sMap.set(userId, { activeId: sess.id, list: [sess] });
  }
  return sMap.get(userId);
}

// ═══════════════════════════════════════════════════════════════
// activeSession() —— 获取用户当前活跃会话
// ═══════════════════════════════════════════════════════════════
// 输入：userId - 用户微信 ID；ai - AI 后端标识（可选，默认 activeAI）
// 输出：当前活跃的 session 对象，找不到则返回列表中第一个会话
export function activeSession(userId, ai = activeAI) {
  const u = ensureUser(userId, ai);
  return u.list.find(s => s.id === u.activeId) || u.list[0];
}

// ═══════════════════════════════════════════════════════════════
// sessionById() —— 按 ID 查找会话
// ═══════════════════════════════════════════════════════════════
// 输入：ai - AI 后端标识；userId - 用户 ID；sessionId - 会话 ID
// 输出：匹配的 session 对象，找不到返回 null
export function sessionById(ai, userId, sessionId) {
  return ensureUser(userId, ai).list.find(s => s.id === sessionId) || null;
}

// ═══════════════════════════════════════════════════════════════
// hasSessionName() —— 检查会话名称是否已被占用
// ═══════════════════════════════════════════════════════════════
// 用途：在创建新会话或重命名时检查名称冲突，避免同一用户下出现重复会话名
// 输入：userId - 用户 ID；name - 待检查的名称；excludeId - 排除的会话 ID（用于重命名时排除自身）；ai - AI 后端标识（可选）
// 输出：Boolean - 名称是否已存在
export function hasSessionName(userId, name, excludeId = null, ai = activeAI) {
  return ensureUser(userId, ai).list.some(s => s.name === name && s.id !== excludeId);
}

// ═══════════════════════════════════════════════════════════════
// nextSessionName() —— 生成下一个可用的默认会话名称
// ═══════════════════════════════════════════════════════════════
// 用途：从 S1 开始递增，找到第一个未被占用的名称（如 "S3"）
// 输入：userId - 用户 ID；ai - AI 后端标识（可选，默认 activeAI）
// 输出：String - 可用的默认会话名称
export function nextSessionName(userId, ai = activeAI) {
  const existing = ensureUser(userId, ai).list.map(s => s.name);
  for (let i = 1; ; i++) { const c = `S${i}`; if (!existing.includes(c)) return c; }
}

// ═══════════════════════════════════════════════════════════════
// findSession() —— 按序号或名称查找用户会话
// ═══════════════════════════════════════════════════════════════
// 用途：支持通过数字编号（如 1, 2）或名称（支持精确匹配和部分匹配）来查找会话
// 输入：userId - 用户 ID；key - 序号（数字字符串）或名称字符串
// 输出：匹配的 session 对象，找不到返回 null
export function findSession(userId, key) {
  const u = ensureUser(userId);
  const n = parseInt(key);
  // 数字编号匹配：直接取列表中的对应位置（索引 = 编号 - 1）
  if (n >= 1 && n <= u.list.length) return u.list[n - 1];
  // 精确名称匹配 → 部分名称匹配
  return u.list.find(s => s.name === key) || u.list.find(s => s.name.includes(key)) || null;
}

// ═══════════════════════════════════════════════════════════════
// sessionsListText() —— 生成会话列表的可读文本
// ═══════════════════════════════════════════════════════════════
// 用途：将用户的所有会话格式化为一条多行文本消息，包含编号、名称、状态（繁忙/排队）、角色
// 输入：userId - 用户 ID
// 输出：String - 格式化后的会话列表文本
export function sessionsListText(userId) {
  const u = ensureUser(userId);
  const aiLabel = activeAI === "cc" ? "Claude Code" : activeAI === "api" ? "Direct API" : "Codex";
  return [`${aiLabel} 会话 (${userId}):`].concat(
    u.list.map((s, i) => {
      const active = s.id === u.activeId ? " [当前]" : "";      // 标记当前活跃会话
      const busy = s.busy ? " [Busy]" : "";                     // 标记是否正在处理中
      const q = (s.queue || []).length ? ` [Queue:${s.queue.length}]` : ""; // 排队消息数
      const profile = s._profile || "默认";
      return `[${i + 1}] ${s.name}${busy}${q}  角色:${profile}`;
    })
  ).join("\n");
}

// ═══════════════════════════════════════════════════════════════
// clearPendingInput() —— 清除用户的待处理批量输入
// ═══════════════════════════════════════════════════════════════
// 用途：取消定时器并清除某用户的待处理消息，通常配合 /cancel 或 /close 命令使用
// 输入：userId - 用户 ID
// 输出：Boolean - 是否有待处理消息被清除
export function clearPendingInput(userId) {
  const pending = pendingInputs.get(userId);
  if (!pending) return false;
  if (typeof pending.cancel === "function") return pending.cancel();
  clearTimeout(pending.timer);
  pendingInputs.delete(userId);
  return true;
}
