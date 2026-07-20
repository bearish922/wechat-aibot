import { loadSessions } from "../app/lib/session-store.mjs";
import { sessions } from "../app/lib/state.mjs";
import { getRoleWorld, loadRoleWorlds, saveRoleWorlds } from "../app/lib/world-state.mjs";
import { maybeCreateScheduleEntry } from "../app/lib/turn.mjs";

const profile = process.argv[2] || "白鹭千圣";

// 初始化全局状态
globalThis.__wechatRoleWorlds = new Map();

// 加载所有 session 和 role worlds
loadSessions();
loadRoleWorlds();

// 找白鹭千圣的 session
let sess = null;
let ai = null;
for (const [backend, map] of Object.entries(sessions)) {
  for (const [, u] of map) {
    for (const s of u.list) {
      if (s._profile === profile) { sess = s; ai = backend; break; }
    }
    if (sess) break;
  }
  if (sess) break;
}

if (!sess) {
  console.log(`ERROR: no session found for ${profile}`);
  process.exit(1);
}

const roleWorld = getRoleWorld(profile);
if (!roleWorld) {
  console.log(`ERROR: no role world for ${profile}`);
  process.exit(1);
}

// 看当前待审批的 candidates
const candidates = roleWorld._pendingScheduleCandidates || [];
console.log(`Pending candidates: ${candidates.length}`);
candidates.forEach((c, i) => {
  console.log(`  [${i}] ${c.title} — ${c.summary?.slice(0, 80)}...`);
});

if (!candidates.length) {
  console.log("No pending candidates, nothing to do.");
  process.exit(0);
}

// 跳过间隔门 — 把 lastCheckAt 设为 0
roleWorld._lastScheduleCheckAt = "2000-01-01T00:00:00.000Z";
saveRoleWorlds();

console.log("\nTriggering maybeCreateScheduleEntry...\n");

const changed = await maybeCreateScheduleEntry({ ai, sess, profile });

console.log(`\nResult: ${changed ? "processed" : "skipped"}`);
console.log(`Pending candidates remaining: ${(roleWorld._pendingScheduleCandidates || []).length}`);

// 看结果
const arcs = roleWorld._lifeArcs || [];
const activeArcs = arcs.filter(a => a.status === "active");
console.log(`\nActive life_arcs: ${activeArcs.length}`);
activeArcs.forEach(a => {
  console.log(`  [${a.kind}] ${a.title}`);
  console.log(`    summary: ${a.summary?.slice(0, 100)}`);
  console.log(`    progressNote: ${a.progressNote?.slice(0, 100) || "(empty)"}`);
  console.log(`    time: ${a.timeStart || "?"} ~ ${a.timeEnd || "?"}`);
});

process.exit(0);
