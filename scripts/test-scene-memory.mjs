import { loadSessions, loadProfiles } from "../app/lib/session-store.mjs";
import { loadRoleWorlds, getRoleWorld } from "../app/lib/world-state.mjs";
import { generateSceneMemory } from "../app/lib/turn.mjs";
import { loadMemoryStore } from "../app/lib/memory.mjs";
import { sessions } from "../app/lib/state.mjs";

const roleWorlds = new Map();
globalThis.__wechatRoleWorlds = roleWorlds;

loadProfiles();
loadSessions();
loadRoleWorlds();
loadMemoryStore();

const userId = "o9cq804e1i6BqI31DcyKJi6xToQc@im.wechat";
const u = sessions.cc.get(userId);
const sess = u.list.find(s => s.id === u.activeId);
const profile = "白鹭千圣";
const roleWorld = getRoleWorld(profile);

console.log("Session:", sess.name, "turn:", sess._turnCount);
console.log("Calling model...");
const start = Date.now();
try {
  const summary = await generateSceneMemory({ userId, sess, profile, roleWorld });
  const elapsed = Date.now() - start;
  console.log("Done in", elapsed, "ms");
  console.log("");
  console.log("=".repeat(60));
  console.log(summary);
  console.log("=".repeat(60));
} catch (e) {
  console.error("Error:", e.message);
}
