// manual-reset.mjs — clean hallucinated world state + regenerate scene memory
import { loadProfiles, loadSessions, saveSessions } from "../app/lib/session-store.mjs";
import { loadRoleWorlds, getRoleWorld, saveRoleWorlds, setSceneMemory, ensureWorldSession, resetWorldSession } from "../app/lib/world-state.mjs";
import { generateSceneMemory, batchUpdateMemory } from "../app/lib/turn.mjs";
import { loadAllEvents } from "../app/lib/chat-history.mjs";
import { loadMemoryDocument } from "../app/lib/memory.mjs";
import { sessions } from "../app/lib/state.mjs";
import { beijingISO } from "../app/lib/time-utils.mjs";
import { uuid } from "../app/lib/utils.mjs";

const roleWorlds = new Map();
globalThis.__wechatRoleWorlds = roleWorlds;

loadProfiles();
loadSessions();
loadRoleWorlds();
loadMemoryDocument();

const userId = "o9cq804e1i6BqI31DcyKJi6xToQc@im.wechat";
const u = sessions.cc.get(userId);
if (!u) { console.error("User not found"); process.exit(1); }
const sess = u.list.find(s => s.id === u.activeId);
if (!sess) { console.error("No active session"); process.exit(1); }
const profile = "白鹭千圣";
const roleWorld = getRoleWorld(profile);
const actorSession = ensureWorldSession(roleWorld, "cc");
const actorStartedMs = Date.parse(actorSession.startedAt || "");
if (!Number.isFinite(actorStartedMs)) throw new Error("CC Actor reset blocked: session start time is missing");

console.log("=== BEFORE RESET ===");
console.log("turnCount:", sess._turnCount);
console.log("apiMessages:", sess._apiMessages?.length || 0);
console.log("visibleHistory:", sess._visibleHistory?.length || 0);

// ─── 1. Clean up world state ───────────────────────────────
const ws = roleWorld._worldState;
if (ws) {
  // Remove hallucinated open threads
  const badThreads = [
    "沃沃自称4点睡6点醒但聊天记录里没出现过这个完整表述——正在质疑中",
  ];
  ws.openThreads = (ws.openThreads || []).filter(t => !badThreads.includes(t));

  // Reset location/activity to neutral (was stuck at hallucinated class)
  ws.location = "东京，公寓";
  ws.activity = "日常";
  ws.currentPlan = "";
  ws.awakeState = "awake";
  ws.lastWorldEventAt = beijingISO();
  ws.updatedAt = beijingISO();
  console.log("openThreads cleaned, location/activity reset to neutral");
}

// ─── 2. Remove hallucinated life_arc entries ─────────────────
// The "千圣的课表" has English conversation on Tuesday — keep it but note
// that today (Wednesday) has no class. The issue was the bot ignoring the day.
// Actually keep the life_arc but clear the progress_note that references upcoming class
const classArc = roleWorld._lifeArcs?.find(a => a.title === "千圣的课表");
if (classArc) {
  classArc.progressNote = "";
  console.log("class schedule progress_note cleared");
}

// ─── 3. Fix scheduling arcs — remove stale/expired ones ─────
// Look for any arc that created the "weekly drum class" assumption
// The drum class was a single Saturday event, not weekly

// ─── 4. Preserve the complete reset interval ─────────────────
const oldTurnCount = sess._turnCount || 0;
console.log("\nCalling model to generate scene memory...");
const start = Date.now();
const summary = await generateSceneMemory({
  ai: "cc",
  userId,
  sess,
  profile,
  roleWorld,
  maxTurns: actorSession.turnCount || 30,
  since: actorSession.startedAt,
});
if (!String(summary || "").trim()) {
  throw new Error("CC Actor reset blocked: scene memory generation returned empty");
}
const allEvents = await loadAllEvents();
const userMessages = allEvents
  .filter(event => {
    if (event.userId !== userId || event.profile !== profile || event.role !== "user" || !event.text) return false;
    const eventMs = Date.parse(event.timestamp || "");
    return Number.isFinite(eventMs) && eventMs >= actorStartedMs;
  })
  .map(event => event.text);
await batchUpdateMemory({ ai: "cc", userId, userMessages, profile });

const elapsed = Date.now() - start;
setSceneMemory(roleWorld, summary, "cc");
console.log(`Done in ${elapsed}ms (${summary.length} chars)`);
console.log("\n" + "=".repeat(60));
console.log("=== NEW SCENE MEMORY ===");
console.log("=".repeat(60));
console.log(summary);
console.log("=".repeat(60));

// ─── 5. Reset session state ──────────────────────────────────
sess._turnCount = 0;
sess._firstTurn = true;
sess.sid = uuid();
sess._apiMessages = [];
sess._visibleHistory = (sess._visibleHistory || []).slice(-8);
sess._lastFailedTurn = null;
sess._lastProactiveAt = null;

// Reset world session
resetWorldSession(roleWorld, "cc", `manual reset (was ${oldTurnCount} turns)`, beijingISO());

console.log("session reset: turnCount " + oldTurnCount + " → 0");

// ─── 6. Save everything ─────────────────────────────────────
if (!saveRoleWorlds()) throw new Error("CC Actor reset blocked: failed to persist the new session");
saveSessions();
console.log("\nAll state saved. Restart bot to pick up changes.");
