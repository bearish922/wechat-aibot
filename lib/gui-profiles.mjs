import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addRoute } from "./server.mjs";
import { profileTemplates, sessions } from "./state.mjs";
import { log } from "./utils.mjs";

const PROFILE_FILE = join(import.meta.dirname, "..", "wechat-profiles.json");

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
    const { name, prompt } = body;
    if (!name || !prompt) return { ok: false, error: "name and prompt required" };
    if (profileTemplates[name]) return { ok: false, error: `"${name}" already exists` };
    profileTemplates[name] = prompt;
    saveToDisk();
    log("\u{1F464}", `profile added: ${name}`);
    return { ok: true };
  });

  addRoute("PUT", "/api/profiles", ({ body }) => {
    const { name, prompt } = body;
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
    saveToDisk();
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
  writeFileSync(PROFILE_FILE, JSON.stringify({ templates: profileTemplates }, null, 2), "utf-8");
}
