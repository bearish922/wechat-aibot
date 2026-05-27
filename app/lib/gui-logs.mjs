import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { addRoute } from "./server.mjs";
import { dataPath } from "./paths.mjs";

const LOGS_DIR = dataPath("logs");

export function registerLogRoutes() {
  addRoute("GET", "/api/logs", ({ req }) => {
    const url = new URL(req.url, "http://localhost");
    const q = url.searchParams.get("q") || "";
    const limit = parseInt(url.searchParams.get("limit")) || 20;

    if (!existsSync(LOGS_DIR)) return { ok: true, entries: [] };

    const files = readdirSync(LOGS_DIR, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith(".txt"))
      .map(e => ({ name: e.name, mtime: e.mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit * 2);

    const entries = [];
    for (const f of files) {
      try {
        const content = readFileSync(join(LOGS_DIR, f.name), "utf-8");
        if (q && !content.includes(q)) continue;
        entries.push({
          file: f.name,
          mtime: new Date(f.mtime).toISOString(),
          preview: content.slice(0, 800),
        });
        if (entries.length >= limit) break;
      } catch {}
    }
    return { ok: true, entries };
  });
}
