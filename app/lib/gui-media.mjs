import { readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { addRoute } from "./server.mjs";
import { dataPath } from "./paths.mjs";

const MEDIA_DIR = dataPath("inbound_media");

export function registerMediaRoutes() {
  addRoute("GET", "/api/media", ({ req }) => {
    const url = new URL(req.url, "http://localhost");
    const days = parseInt(url.searchParams.get("days")) || 30;

    if (!existsSync(MEDIA_DIR)) return { ok: true, files: [], totalSize: 0, oldCount: 0, oldSize: 0 };

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const files = readdirSync(MEDIA_DIR, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => {
        const fp = join(MEDIA_DIR, e.name);
        const stat = statSync(fp);
        return { name: e.name, size: stat.size, mtime: stat.mtimeMs, isOld: stat.mtimeMs < cutoff };
      })
      .sort((a, b) => b.mtime - a.mtime);

    const totalSize = files.reduce((s, f) => s + f.size, 0);
    const oldFiles = files.filter(f => f.isOld);
    const oldSize = oldFiles.reduce((s, f) => s + f.size, 0);

    return { ok: true, files: files.slice(0, 100), totalSize, oldCount: oldFiles.length, oldSize };
  });

  addRoute("DELETE", "/api/media", ({ body }) => {
    const { days } = body;
    if (!days || days < 1) return { ok: false, error: "days required (>= 1)" };

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let removed = 0, errors = 0;

    if (!existsSync(MEDIA_DIR)) return { ok: true, removed: 0 };

    for (const entry of readdirSync(MEDIA_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const fp = join(MEDIA_DIR, entry.name);
      if (statSync(fp).mtimeMs < cutoff) {
        try { rmSync(fp, { force: true }); removed++; } catch { errors++; }
      }
    }
    return { ok: true, removed, errors };
  });
}
