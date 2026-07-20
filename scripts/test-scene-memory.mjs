import { loadSessions, loadProfiles } from "../app/lib/session-store.mjs";
import { loadRoleWorlds, getRoleWorld, sessionProfile } from "../app/lib/world-state.mjs";
import { generateSceneMemory } from "../app/lib/turn.mjs";
import { sessions } from "../app/lib/state.mjs";

const roleWorlds = new Map();
globalThis.__wechatRoleWorlds = roleWorlds;

loadProfiles();
loadSessions();
loadRoleWorlds();

const profile = process.argv[2] || "白鹭千圣";
const ai = process.argv[3] || "cc";
const requestedUserId = process.argv[4] || "";
const backendSessions = sessions[ai];
if (!backendSessions) {
  throw new Error(`Unknown backend "${ai}". Use cc, codex, or api.`);
}

let userId = "";
let sess = null;
for (const [candidateUserId, user] of backendSessions) {
  if (requestedUserId && candidateUserId !== requestedUserId) continue;
  const active = user.list.find(s => s.id === user.activeId);
  if (active && sessionProfile(active) === profile) {
    userId = candidateUserId;
    sess = active;
    break;
  }
}
if (!sess) {
  throw new Error(`No active ${ai} session found for profile "${profile}"${requestedUserId ? ` and user "${requestedUserId}"` : ""}.`);
}
const roleWorld = getRoleWorld(profile);

console.log("Session:", sess.name, "turn:", sess._turnCount);
console.log("Calling model...");
const start = Date.now();
try {
  const summary = await generateSceneMemory({ ai, userId, sess, profile, roleWorld });
  const elapsed = Date.now() - start;
  console.log("Done in", elapsed, "ms");
  console.log("");
  console.log("=".repeat(60));
  console.log(summary);
  console.log("=".repeat(60));
} catch (e) {
  console.error("Error:", e.message);
}
