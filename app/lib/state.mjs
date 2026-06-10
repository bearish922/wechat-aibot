// ─── 集中式可变状态管理 ──────────────────────────────────────
// 所有模块从此处导入共享状态，而非各自维护全局变量，保证状态单一来源。
// 零循环依赖：state.mjs 永远不引用其他 lib/*.mjs 模块。

export let token = null;
export let getUpdatesBuf = "";
export const sessions = { cc: new Map(), codex: new Map() };
export let activeAI = "cc";
export let profileTemplates = {};
export let modelNames = { cc: "unknown", codex: "unknown" };
export const pendingInputs = new Map();
export const recentInputs = new Map();

// 为可重新赋值的原始类型变量提供 setter 辅助函数
export function setToken(v) { token = v; }
export function setSyncBuf(v) { getUpdatesBuf = v; }
export function setActiveAI(v) { activeAI = v; }

