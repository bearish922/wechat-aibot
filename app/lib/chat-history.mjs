// chat-history.mjs — SQLite 支持的聊天事件存储(通过 sql.js WASM 实现)
import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";
import { dataPath, ensureDir, DATA_DIR } from "./paths.mjs";
import { beijingISO } from "./reply.mjs";

// SQLite 数据库主文件路径
const DB_FILE = dataPath("chat-history.db");
// 旧版 JSON 格式的聊天历史文件(迁移用)
const JSON_LEGACY = dataPath("chat-history.json");
const JSON_BAK = dataPath("chat-history.bak.json");

// ─── SQLite init ───────────────────────────────────────────────
let _db = null;
let _dbReady = false;
let _dbInitPromise = null;

// 懒加载获取 SQLite 数据库实例(单例模式)，首次调用时初始化并执行迁移
// 返回: sql.js Database 实例的 Promise
async function getDb() {
  // 已就绪直接返回
  if (_dbReady) return _db;
  // 正在初始化则复用同一个 Promise
  if (_dbInitPromise) return _dbInitPromise;
  _dbInitPromise = (async () => {
    // 加载 sql.js WASM 模块
    const SQL = await initSqlJs();
    ensureDir(DATA_DIR);
    // 已有数据库文件则加载，否则创建空库
    if (fs.existsSync(DB_FILE)) {
      const buf = fs.readFileSync(DB_FILE);
      _db = new SQL.Database(buf);
    } else {
      _db = new SQL.Database();
    }
    // 创建 events 表(如不存在)
    _db.run(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      userId TEXT NOT NULL DEFAULT '',
      ai TEXT NOT NULL DEFAULT 'cc',
      sessionId TEXT NOT NULL DEFAULT '',
      sessionName TEXT NOT NULL DEFAULT '',
      sessionKey TEXT NOT NULL DEFAULT '',
      profile TEXT NOT NULL DEFAULT '默认',
      role TEXT NOT NULL DEFAULT 'assistant',
      kind TEXT NOT NULL DEFAULT 'chat',
      text TEXT NOT NULL DEFAULT '',
      scenelet TEXT NOT NULL DEFAULT '',
      sceneletStatus TEXT NOT NULL DEFAULT '',
      sceneletError TEXT NOT NULL DEFAULT '',
      proactiveIntentId TEXT NOT NULL DEFAULT '',
      toolUsage TEXT NOT NULL DEFAULT '{}',
      ragUsage TEXT NOT NULL DEFAULT '{}',
      sceneState TEXT NOT NULL DEFAULT ''
    )`);
    _db.run(`CREATE INDEX IF NOT EXISTS idx_events_ts ON events(timestamp)`);
    _db.run(`CREATE INDEX IF NOT EXISTS idx_events_session ON events(sessionKey)`);
    _db.run(`CREATE INDEX IF NOT EXISTS idx_events_role ON events(role)`);
    _db.run(`CREATE INDEX IF NOT EXISTS idx_events_ai ON events(ai)`);
    _db.run(`CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(sessionKey, timestamp DESC)`);
    // 迁移：如果 sessionKey 是生成列(GENERATED ALWAYS)，重建为普通列
    migrateSessionKeyColumn(_db);
    // 迁移：将 sessionKey 从 userId|sessionId 改为 userId|profile
    migrateSessionKeyToProfile(_db);
    // 迁移：添加 sceneState 列（双输出架构新增）
    migrateAddSceneStateColumn(_db);
    _dbReady = true;
    // 数据库为空且存在旧 JSON 文件时，执行数据迁移
    const cnt = _db.exec("SELECT COUNT(*) as c FROM events")[0]?.values[0]?.[0] || 0;
    if (cnt === 0 && (fs.existsSync(JSON_LEGACY) || fs.existsSync(JSON_BAK))) {
      migrateJsonToDb(_db);
      saveDb();
    }
    if (backfillUsedRagFromLogs(_db) > 0) saveDb();
    return _db;
  })();
  return _dbInitPromise;
}

// 从旧运行日志回填明确发生过的 RAG 检索。只处理 ragChars > 0 的成功轮次，
// 不猜测 ragChars=0 究竟是未触发还是检索无结果。
export function backfillUsedRagFromLogs(db, logsDir = dataPath("logs")) {
  if (!fs.existsSync(logsDir)) return 0;
  const runs = [];
  for (const file of fs.readdirSync(logsDir).filter(name => name.endsWith(".jsonl") && name !== "hidden-usage.jsonl")) {
    try {
      for (const line of fs.readFileSync(path.join(logsDir, file), "utf-8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        const item = JSON.parse(line);
        if (item.error || !(Number(item.ragChars) > 0)) continue;
        runs.push({ ...item, used: false });
      }
    } catch {}
  }
  if (!runs.length) return 0;
  runs.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  const res = db.exec("SELECT id,timestamp,userId,ai,sessionName,role,kind,text,ragUsage FROM events ORDER BY timestamp ASC");
  if (!res.length) return 0;
  const rows = res[0].values;
  const users = new Map();
  for (const row of rows) {
    if (row[5] === "user" && row[6] === "chat") users.set(`${row[1]}|${row[2]}|${row[3]}|${row[4]}`, String(row[7] || ""));
  }

  let changed = 0;
  for (const row of rows) {
    if (row[5] !== "assistant" || row[6] !== "chat" || (row[8] && row[8] !== "{}")) continue;
    const key = `${row[1]}|${row[2]}|${row[3]}|${row[4]}`;
    const userText = users.get(key);
    if (userText === undefined) continue;
    const assistantMs = Date.parse(row[1]);
    let match = null;
    for (const run of runs) {
      if (run.used || run.ai !== row[3] || run.userId !== row[2] || run.sessionName !== row[4]) continue;
      const runMs = Date.parse(run.ts);
      if (!Number.isFinite(runMs) || runMs > assistantMs || assistantMs - runMs > 30 * 60_000) continue;
      if (Number(run.bodyChars) !== userText.length) continue;
      if (!match || runMs > Date.parse(match.ts)) match = run;
    }
    if (!match) continue;
    match.used = true;
    db.run("UPDATE events SET ragUsage = ? WHERE id = ?", [JSON.stringify({ eligible: true, used: true, chars: Number(match.ragChars) }), row[0]]);
    changed += db.getRowsModified();
  }
  if (changed) console.log("[chat-history] backfilled RAG usage rows:", changed);
  return changed;
}

// 检查并迁移 sessionKey 从生成列变为普通列
// 旧版 schema 将 sessionKey 定义为 GENERATED ALWAYS AS (userId || '|' || sessionId) STORED，
// 但代码的 INSERT 语句手动写入该列，导致 "cannot INSERT into generated column" 错误。
// 通过重建表来修复 schema。
function migrateSessionKeyColumn(db) {
  try {
    const info = db.exec("PRAGMA table_xinfo('events')");
    if (!info.length) return;
    // table_xinfo 返回 cid,name,type,notnull,dflt_value,pk,hidden
    // hidden=2 表示 STORED 生成列，hidden=3 表示 VIRTUAL 生成列
    const sessionKeyCol = info[0].values.find(r => r[1] === "sessionKey");
    if (!sessionKeyCol || sessionKeyCol[6] === 0) return; // 已经是普通列，无需迁移

    console.log("[chat-history] migrating sessionKey from generated to regular column...");

    // 1. 创建新表(不含生成列)
    db.run(`CREATE TABLE events_new (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      userId TEXT NOT NULL DEFAULT '',
      ai TEXT NOT NULL DEFAULT 'cc',
      sessionId TEXT NOT NULL DEFAULT '',
      sessionName TEXT NOT NULL DEFAULT '',
      sessionKey TEXT NOT NULL DEFAULT '',
      profile TEXT NOT NULL DEFAULT '默认',
      role TEXT NOT NULL DEFAULT 'assistant',
      kind TEXT NOT NULL DEFAULT 'chat',
      text TEXT NOT NULL DEFAULT '',
      scenelet TEXT NOT NULL DEFAULT '',
      sceneletStatus TEXT NOT NULL DEFAULT '',
      sceneletError TEXT NOT NULL DEFAULT '',
      proactiveIntentId TEXT NOT NULL DEFAULT '',
      toolUsage TEXT NOT NULL DEFAULT '{}',
      ragUsage TEXT NOT NULL DEFAULT '{}',
      sceneState TEXT NOT NULL DEFAULT ''
    )`);

    // 2. 从旧表复制数据，sessionKey 手动计算
    db.run(`INSERT INTO events_new
      (id,timestamp,userId,ai,sessionId,sessionName,sessionKey,profile,role,kind,text,scenelet,sceneletStatus,sceneletError,proactiveIntentId,toolUsage,ragUsage,sceneState)
      SELECT id,timestamp,userId,ai,sessionId,sessionName,
             userId || '|' || sessionId,
             profile,role,kind,text,scenelet,sceneletStatus,sceneletError,proactiveIntentId,toolUsage,ragUsage,'' as sceneState
      FROM events`);

    // 3. 替换旧表
    db.run("DROP TABLE events");
    db.run("ALTER TABLE events_new RENAME TO events");

    // 4. 重建索引
    db.run("CREATE INDEX IF NOT EXISTS idx_events_ts ON events(timestamp)");
    db.run("CREATE INDEX IF NOT EXISTS idx_events_session ON events(sessionKey)");
    db.run("CREATE INDEX IF NOT EXISTS idx_events_role ON events(role)");
    db.run("CREATE INDEX IF NOT EXISTS idx_events_ai ON events(ai)");
    db.run("CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(sessionKey, timestamp DESC)");

    const cnt = db.exec("SELECT COUNT(*) FROM events")[0]?.values[0]?.[0] || 0;
    console.log("[chat-history] migration complete, rows:", cnt);
    saveDb();
  } catch (e) {
    console.error("[chat-history] sessionKey migration failed:", e.message);
  }
}

// 将 sessionKey 从 userId|sessionId 格式迁移到 userId|profile 格式
function migrateSessionKeyToProfile(db) {
  try {
    const info = db.exec("SELECT COUNT(*) FROM events WHERE sessionKey != (userId || '|' || profile)");
    const mismatched = info.length ? info[0].values[0][0] : 0;
    if (!mismatched) return;
    console.log(`[chat-history] migrating ${mismatched} sessionKey(s) to userId|profile...`);
    db.run("UPDATE events SET sessionKey = userId || '|' || profile");
    saveDb();
    console.log("[chat-history] sessionKey migration to profile complete");
  } catch (e) {
    console.error("[chat-history] sessionKey->profile migration failed:", e.message);
  }
}

// 为已有数据库添加 sceneState 列（双输出架构新增字段）
function migrateAddSceneStateColumn(db) {
  try {
    const info = db.exec("PRAGMA table_info(events)");
    const cols = info.length ? info[0].values.map(v => v[1]) : [];
    if (cols.includes("sceneState")) return;
    console.log("[chat-history] adding sceneState column...");
    db.run("ALTER TABLE events ADD COLUMN sceneState TEXT NOT NULL DEFAULT ''");
    saveDb();
    console.log("[chat-history] sceneState column added");
  } catch (e) {
    console.error("[chat-history] sceneState migration failed:", e.message);
  }
}

// 写入 SQLite 数据库到磁盘: tmp -> bak -> copy
function saveDb() {
  if (!_db) throw new Error("[chat-history] saveDb: _db is null");
  const tmp = DB_FILE + ".tmp";
  const data = Buffer.from(_db.export());
  fs.writeFileSync(tmp, data);
  if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, DB_FILE + ".bak");
  fs.copyFileSync(tmp, DB_FILE);
  try { fs.unlinkSync(tmp); } catch { /* tmp 清理失败不影响主流程 */ }
}

// 从旧版 JSON 文件迁移聊天历史到 SQLite 数据库
// 参数: db - sql.js Database 实例
function migrateJsonToDb(db) {
  const rows = [];
  // 优先从主文件迁移，失败则尝试备份
  for (const file of [JSON_LEGACY, JSON_BAK]) {
    try {
      if (!fs.existsSync(file)) continue;
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      const events = Array.isArray(data?.events) ? data.events : [];
      // 将每个事件转换为 SQLite 行数组
      for (const ev of events) {
        ev.toolUsage = normalizeToolUsage(ev.toolUsage);
        ev.ragUsage = normalizeRagUsage(ev.ragUsage);
        rows.push(rowFromEvent(ev));
      }
      break;
    } catch { /* 当前文件解析失败则尝试下一个备用文件 */ }
  }
  if (rows.length) {
    const stmt = db.prepare(`INSERT OR IGNORE INTO events
      (id,timestamp,userId,ai,sessionId,sessionName,sessionKey,profile,role,kind,text,scenelet,sceneletStatus,sceneletError,proactiveIntentId,toolUsage,ragUsage,sceneState)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const r of rows) {
      stmt.run(r);
    }
    stmt.free();
  }
}

// 将内存中的事件对象转换为 SQLite 行数组(按列顺序)
// 参数: ev - 事件对象
// 返回: 17 元素数组对应 events 表的所有列
function rowFromEvent(ev) {
  return [
    ev.id || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    ev.timestamp || beijingISO(),
    String(ev.userId || ""),
    ev.ai || "cc",
    ev.sessionId || "",
    ev.sessionName || "",
    [String(ev.userId || ""), ev.profile || "默认"].join("|"),
    ev.profile || "默认",
    ev.role || "assistant",
    ev.kind || "chat",
    String(ev.text || ""),
    ev.scenelet ? String(ev.scenelet) : "",
    ev.sceneletStatus ? String(ev.sceneletStatus) : "",
    ev.sceneletError ? String(ev.sceneletError) : "",
    ev.proactiveIntentId || "",
    JSON.stringify(ev.toolUsage || {}),
    JSON.stringify(ev.ragUsage || {}),
    ev.sceneState ? String(ev.sceneState) : "",
  ];
}

// 将 SQLite 行数组(按列顺序)还原为事件对象
// 参数: row - 来自 SELECT * 的 values 数组
// 返回: 事件对象
function eventFromRow(row) {
  return {
    id: row[0],
    timestamp: row[1],
    userId: row[2],
    ai: row[3],
    sessionId: row[4],
    sessionName: row[5],
    // row[6] 是 sessionKey 列，事件对象中不暴露，跳过
    profile: row[7],
    role: row[8],
    kind: row[9],
    text: row[10],
    scenelet: row[11] || "",
    sceneletStatus: row[12] || "",
    sceneletError: row[13] || "",
    proactiveIntentId: row[14] || "",
    // JSON 字符串反序列化
    toolUsage: parseJsonField(row[15]),
    ragUsage: parseJsonField(row[16]),
    sceneState: row[17] || "",
  };
}

// 转义 LIKE 通配符，防止用户输入中的 % 和 _ 被当作通配符
function escapeLike(str) {
  return str.replace(/[%_]/g, '\\$&');
}

// 安全解析 JSON 字符串字段，空值或 "{}" 返回 null
function parseJsonField(val) {
  if (!val || val === "{}") return null;
  try { return JSON.parse(val); } catch { return null; }
}

// 规范化工具使用统计对象(本地版本，与 normalize.mjs 中定义相同)
function normalizeToolUsage(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  return {
    webSearch: Math.max(0, Number(raw.webSearch || 0) || 0),
    webFetch: Math.max(0, Number(raw.webFetch || 0) || 0),
    tools: Array.isArray(raw.tools) ? [...new Set(raw.tools.map(x => String(x || "").trim()).filter(Boolean))] : [],
  };
}

// 规范化 RAG 使用统计对象
function normalizeRagUsage(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  return {
    eligible: Boolean(raw.eligible),
    used: Boolean(raw.used),
    chars: Math.max(0, Number(raw.chars || 0) || 0),
  };
}

// ─── Public API (与旧 JSON 存储接口兼容) ─────────────────────

// 加载全部聊天事件，按时间升序排列，user 排在 assistant 之前
// 返回: 事件对象数组
export async function loadAllEvents() {
  const db = await getDb();
  // 按时间升序，同时间戳时 user 在前
  const res = db.exec("SELECT * FROM events ORDER BY timestamp ASC, CASE WHEN role='user' THEN 0 ELSE 1 END");
  if (!res.length) return [];
  return res[0].values.map(eventFromRow);
}

// 按 userId + profile 加载跨后端共享的最近可见历史。
// CC/Codex 的运行线程保持独立，但角色对话上下文统一来自 SQLite role-level sessionKey。
export async function loadRoleVisibleHistory(userId, profile, limit = 100) {
  const db = await getDb();
  const sessionKey = [String(userId || ""), profile || "默认"].join("|");
  const safeLimit = Math.max(1, Number(limit) || 100);
  const res = db.exec(`SELECT timestamp,role,kind,text FROM (
    SELECT timestamp,role,kind,text
    FROM events
    WHERE sessionKey = ? AND text != '' AND role IN ('user','assistant')
    ORDER BY timestamp DESC, CASE WHEN role='assistant' THEN 0 ELSE 1 END
    LIMIT ?
  ) ORDER BY timestamp ASC, CASE WHEN role='user' THEN 0 ELSE 1 END`, [sessionKey, safeLimit]);
  if (!res.length) return [];
  return res[0].values.map(row => ({
    timestamp: row[0],
    role: row[1],
    kind: row[2] || "chat",
    text: row[3] || "",
  }));
}

// 向数据库追加一条聊天事件
// 参数: event - 事件对象(含 id, timestamp, userId, role, kind, text 等)
// 返回: 实际写入的事件对象，text 和 scenelet 都为空时返回 null
export async function appendChatEvent(event) {
  // text 和 scenelet 至少有一个非空才写入
  if (!event?.text && !event?.scenelet) return null;
  const db = await getDb();
  // 构建事件对象，填充默认值
  const item = {
    id: event.id || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: event.timestamp || beijingISO(),
    userId: String(event.userId || ""),
    ai: event.ai || "cc",
    sessionId: event.sessionId || "",
    sessionName: event.sessionName || "",
    profile: event.profile || "默认",
    role: event.role || "assistant",
    kind: event.kind || "chat",
    text: String(event.text || ""),
    scenelet: event.scenelet ? String(event.scenelet) : "",
    sceneletStatus: event.sceneletStatus ? String(event.sceneletStatus) : "",
    sceneletError: event.sceneletError ? String(event.sceneletError) : "",
    proactiveIntentId: event.proactiveIntentId || "",
    toolUsage: normalizeToolUsage(event.toolUsage),
    ragUsage: normalizeRagUsage(event.ragUsage),
  };
  const row = rowFromEvent(item);
  db.run(`INSERT INTO events
    (id,timestamp,userId,ai,sessionId,sessionName,sessionKey,profile,role,kind,text,scenelet,sceneletStatus,sceneletError,proactiveIntentId,toolUsage,ragUsage,sceneState)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, row);
  // 写入后立即持久化
  saveDb();
  return item;
}

// 更新指定事件的 text / sceneState / scenelet 字段
// 参数: eventId - 事件 ID; updates - { text?, sceneState?, scenelet? } 更新对象
// 返回: true 有行被修改，false 未匹配到事件
export async function updateChatEvent(eventId, updates) {
  const db = await getDb();
  // 仅当字段被明确传入时才更新
  if (updates.text !== undefined) {
    db.run("UPDATE events SET text = ? WHERE id = ?", [String(updates.text), eventId]);
  }
  if (updates.sceneState !== undefined) {
    db.run("UPDATE events SET sceneState = ? WHERE id = ?", [String(updates.sceneState), eventId]);
  }
  if (updates.scenelet !== undefined) {
    db.run("UPDATE events SET scenelet = ? WHERE id = ?", [String(updates.scenelet), eventId]);
  }
  const changes = db.getRowsModified();
  // 有变更时持久化
  if (changes > 0) saveDb();
  return changes > 0;
}

// 从数据库删除指定事件
// 参数: eventId - 事件 ID
// 返回: true 删除成功，false 未找到
export async function deleteChatEvent(eventId) {
  const db = await getDb();
  db.run("DELETE FROM events WHERE id = ?", [eventId]);
  const changes = db.getRowsModified();
  if (changes > 0) saveDb();
  return changes > 0;
}

// 分页列出聊天事件，支持搜索、日期范围过滤、会话过滤
// 参数: options - { q?, sessionKey?, dateFrom?, dateTo?, offset?, limit? }
// 返回: { events: 事件数组, total: 总记录数 }
export async function listChatEvents(options = {}) {
  const db = await getDb();
  // 解析并清洗各查询参数
  const q = String(options.q || "").trim().toLowerCase();
  const sessionKey = String(options.sessionKey || "").trim();
  const dateFrom = options.dateFrom ? String(options.dateFrom) : "";
  const dateTo = options.dateTo ? String(options.dateTo) : "";
  const offset = Math.max(0, Number(options.offset || 0));
  const rawLimit = Number(options.limit ?? 50);
  const limit = rawLimit <= 0 ? Number.MAX_SAFE_INTEGER : Math.max(1, rawLimit);

  // 动态构建 WHERE 条件
  const conditions = [];
  const params = [];
  if (dateFrom) { conditions.push("timestamp >= ?"); params.push(dateFrom); }
  // 日期上界附加 Unicode 最大字符确保包含当天全部记录
  if (dateTo) { conditions.push("timestamp <= ?"); params.push(dateTo + "￿"); }
  if (sessionKey) { conditions.push("sessionKey = ?"); params.push(sessionKey); }
  // 搜索关键词: 在 text、scenelet、sessionName、profile、userId 中模糊匹配
  if (q) {
    const escaped = escapeLike(q);
    const likeQ = `%${escaped}%`;
    conditions.push("(text LIKE ? ESCAPE '\\' OR sceneState LIKE ? ESCAPE '\\' OR scenelet LIKE ? ESCAPE '\\' OR sessionName LIKE ? ESCAPE '\\' OR profile LIKE ? ESCAPE '\\' OR userId LIKE ? ESCAPE '\\')");
    params.push(likeQ, likeQ, likeQ, likeQ, likeQ, likeQ);
  }
  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

  let total;
  if (!q) {
    const countRes = db.exec(`SELECT COUNT(*) FROM events ${where}`, params);
    total = countRes[0]?.values[0]?.[0] || 0;
  }

  let res, events;
  if (q) {
    res = db.exec(`SELECT * FROM events ${where} ORDER BY timestamp DESC, CASE WHEN role='assistant' THEN 0 ELSE 1 END`, params);
    events = res.length ? res[0].values.map(eventFromRow) : [];
    if (events.length) {
      const pairedIds = new Set(events.map(e => e.id));
      const needPairing = events.filter(e => e.kind !== "proactive" && (e.role === "user" || e.role === "assistant"));
      if (needPairing.length) {
        // 批量查询：一次拉取所有相关 session 的 user+assistant 消息，按 sessionId+timestamp 排序
        const sessionIds = [...new Set(needPairing.map(e => e.sessionId))];
        const ph = sessionIds.map(() => '?').join(',');
        const candRes = db.exec(
          `SELECT * FROM events WHERE sessionId IN (${ph}) AND role IN ('user','assistant') AND kind != 'proactive' ORDER BY sessionId, timestamp ASC, CASE WHEN role='user' THEN 0 ELSE 1 END`,
          sessionIds
        );
        const bySession = {};
        if (candRes.length) {
          for (const row of candRes[0].values) {
            const ev = eventFromRow(row);
            (bySession[ev.sessionId] ??= []).push(ev);
          }
        }
        const toAdd = [];
        for (const ev of needPairing) {
          const msgs = bySession[ev.sessionId];
          if (!msgs) continue;
          if (ev.role === "user") {
            const partner = msgs.find(m => m.role === "assistant" && m.timestamp >= ev.timestamp);
            if (partner && !pairedIds.has(partner.id)) { pairedIds.add(partner.id); toAdd.push(partner); }
          } else {
            let partner = null;
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === "user" && msgs[i].timestamp <= ev.timestamp) { partner = msgs[i]; break; }
            }
            if (partner && !pairedIds.has(partner.id)) { pairedIds.add(partner.id); toAdd.push(partner); }
          }
        }
        events.push(...toAdd);
      }
      events.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    }
  } else {
    res = db.exec(`SELECT * FROM events ${where} ORDER BY timestamp DESC, CASE WHEN role='assistant' THEN 0 ELSE 1 END LIMIT ? OFFSET ?`, [...params, limit, offset]);
    events = res.length ? res[0].values.map(eventFromRow) : [];
  }

  if (q) total = events.length;
  const page = q ? events.slice(offset, offset + limit) : events;
  return { events: page, total };
}

// 列出所有会话(按 sessionKey 聚合)，支持搜索和日期过滤
// 参数: options - { q?, dateFrom?, dateTo? }
// 返回: 会话摘要对象数组(含 key, ai, userId, profile, lastTimestamp, count, lastText 等)
export async function listConversations(options = {}) {
  const db = await getDb();
  const q = String(options.q || "").trim().toLowerCase();
  const dateFrom = options.dateFrom ? String(options.dateFrom) : "";
  const dateTo = options.dateTo ? String(options.dateTo) : "";

  // 构建过滤条件(同 listChatEvents)
  const conditions = [];
  const params = [];
  if (dateFrom) { conditions.push("timestamp >= ?"); params.push(dateFrom); }
  if (dateTo) { conditions.push("timestamp <= ?"); params.push(dateTo + "￿"); }
  if (q) {
    const escaped = escapeLike(q);
    const likeQ = `%${escaped}%`;
    conditions.push("(text LIKE ? ESCAPE '\\' OR sceneState LIKE ? ESCAPE '\\' OR scenelet LIKE ? ESCAPE '\\' OR sessionName LIKE ? ESCAPE '\\' OR profile LIKE ? ESCAPE '\\' OR userId LIKE ? ESCAPE '\\')");
    params.push(likeQ, likeQ, likeQ, likeQ, likeQ, likeQ);
  }
  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

  // 按 sessionKey 分组聚合: MAX(timestamp) 获取最后活跃时间，COUNT(*) 获取消息总数
  // 子查询获取该会话最后一条消息的文本
  // sessionKey is role-level, so sessionId/sessionName/ai must come from the latest row,
  // not SQLite's arbitrary non-grouped row.
  const latestOrder = "ORDER BY e2.timestamp DESC, CASE WHEN e2.role='assistant' THEN 0 ELSE 1 END LIMIT 1";
  const res = db.exec(`SELECT
    e1.sessionKey,
    (SELECT e2.ai FROM events e2 WHERE e2.sessionKey = e1.sessionKey ${latestOrder}) as ai,
    e1.userId,
    (SELECT e2.sessionId FROM events e2 WHERE e2.sessionKey = e1.sessionKey ${latestOrder}) as sessionId,
    (SELECT e2.sessionName FROM events e2 WHERE e2.sessionKey = e1.sessionKey ${latestOrder}) as sessionName,
    e1.profile,
    MAX(e1.timestamp) as lastTs,
    COUNT(*) as cnt,
    SUM(CASE WHEN e1.scenelet != '' THEN 1 ELSE 0 END) as sceneletCnt,
    (SELECT e2.text FROM events e2 WHERE e2.sessionKey = e1.sessionKey ${latestOrder}) as lastText
    FROM events e1 ${where}
    GROUP BY e1.sessionKey
    ORDER BY lastTs DESC`, params);
  if (!res.length) return [];
  return res[0].values.map(row => ({
    key: row[0],
    ai: row[1],
    userId: row[2],
    sessionId: row[3],
    sessionName: row[4],
    profile: row[5],
    lastTimestamp: row[6],
    count: row[7],
    sceneletCount: row[8] || 0,
    lastText: row[9] || "",
  }));
}
