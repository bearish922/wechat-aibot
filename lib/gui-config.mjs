import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { addRoute } from "./server.mjs";
import { log } from "./utils.mjs";

const CONFIG_PATH = join(import.meta.dirname, "..", "config.json");

export function registerConfigRoutes() {
  addRoute("GET", "/api/config", () => {
    try {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      // Mask sensitive fields
      if (raw.vision?.apiKey) {
        raw.vision.apiKey = raw.vision.apiKey.slice(0, 8) + "****";
      }
      return { ok: true, config: raw };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  addRoute("POST", "/api/config", ({ body }) => {
    try {
      // Backup before saving
      const backupPath = CONFIG_PATH + ".backup";
      copyFileSync(CONFIG_PATH, backupPath);

      // Read current config to preserve masked fields
      const current = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      // Merge: only update fields that were explicitly sent
      if (body.vision?.apiKey && body.vision.apiKey.includes("****")) {
        body.vision.apiKey = current.vision?.apiKey || body.vision.apiKey;
      }

      writeFileSync(CONFIG_PATH, JSON.stringify(body, null, 2));
      log("\u{2699}", "config.json updated (backup saved)");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}
