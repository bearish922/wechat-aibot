import { copyFileSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { addRoute } from "./server.mjs";
import { profileTemplates, sessions } from "./state.mjs";
import { log } from "./utils.mjs";
import { DATA_DIR, dataPath, ensureDir } from "./paths.mjs";
import { deleteRolePromptSuite } from "./gui-prompts.mjs";

const PROFILE_FILE = dataPath("wechat-profiles.json");

export function registerProfileRoutes() {
  addRoute("GET", "/api/profiles", () => {
    const list = Object.entries(profileTemplates).map(([name, prompt]) => ({
      name,
      prompt,
      bindings: countBindings(name),
    }));
    return { ok: true, profiles: list };
  });

  addRoute("POST", "/api/profiles", ({ body }) => {
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    if (!name || !prompt) return { ok: false, error: "name and prompt required" };
    if (profileTemplates[name]) return { ok: false, error: `"${name}" already exists` };
    profileTemplates[name] = prompt;
    saveToDisk();
    log("\u{1F464}", `profile added: ${name}`);
    return { ok: true };
  });

  addRoute("PUT", "/api/profiles", ({ body }) => {
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const prompt = typeof body?.prompt === "string" ? body.prompt : "";
    if (!name || !prompt) return { ok: false, error: "name and prompt required" };
    if (!profileTemplates[name]) return { ok: false, error: `"${name}" not found` };
    profileTemplates[name] = prompt;
    saveToDisk();
    log("\u{1F464}", `profile updated: ${name}`);
    return { ok: true };
  });

  addRoute("DELETE", "/api/profiles", ({ body }) => {
    const { name } = body;
    if (!name) return { ok: false, error: "name required" };
    if (name === "默认") return { ok: false, error: "cannot delete default" };
    if (!profileTemplates[name]) return { ok: false, error: `"${name}" not found` };

    // Revert bound sessions
    let reverted = 0;
    for (const [, map] of Object.entries(sessions)) {
      for (const [, u] of map) {
        for (const s of u.list) {
          if (s._profile === name) { s._profile = null; reverted++; }
        }
      }
    }
    delete profileTemplates[name];
    deleteRolePromptSuite(name);
    saveToDisk();
    globalThis.__wechatSaveSessions?.();
    log("\u{1F464}", `profile deleted: ${name} (${reverted} sessions reverted)`);
    return { ok: true, reverted };
  });
}

function countBindings(name) {
  let count = 0;
  for (const [, map] of Object.entries(sessions)) {
    for (const [, u] of map) {
      for (const s of u.list) {
        if (s._profile === name) count++;
      }
    }
  }
  return count;
}

function saveToDisk() {
  ensureDir(DATA_DIR);
  const tmp = `${PROFILE_FILE}.tmp`;
  const backup = `${PROFILE_FILE}.backup`;
  if (existsSync(PROFILE_FILE)) copyFileSync(PROFILE_FILE, backup);
  try {
    writeFileSync(tmp, JSON.stringify({ templates: profileTemplates }, null, 2) + "\n", "utf-8");
    renameSync(tmp, PROFILE_FILE);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}
