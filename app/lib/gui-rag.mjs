import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { addRoute } from "./server.mjs";
import { configValue } from "./config.mjs";
import { APP_DIR, resolveProjectPath } from "./paths.mjs";

const RAG_SCRIPT = resolveProjectPath(configValue("paths.ragScript", "app/rag.py"));

export function registerRagRoutes() {
  addRoute("GET", "/api/rag/status", () => {
    const storeDir = resolveProjectPath(configValue("rag.storeDir", "data/rag_vector_store"));
    const metaPath = join(storeDir, "rag_meta.json");
    const knowledgeDir = resolveProjectPath(configValue("rag.knowledgeDir", "data/knowledge"));
    const knowledgeExists = existsSync(knowledgeDir);
    const indexExists = existsSync(metaPath);
    let chunkCount = 0;
    let meta = null;
    if (indexExists) {
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        chunkCount = meta.chunks || meta.chunk_count || 0;
      } catch {}
    }
    return { ok: true, knowledgeExists, indexExists, chunkCount, meta };
  });

  addRoute("POST", "/api/rag/rebuild", () => {
    const proc = spawnSync("python", ["-X", "utf8", RAG_SCRIPT, "build"], {
      cwd: APP_DIR,
      encoding: "utf-8",
      timeout: 300_000,
      windowsHide: true,
    });
    if (proc.status === 0) {
      return { ok: true, output: proc.stdout?.trim() || "Rebuild complete" };
    }
    return { ok: false, error: proc.stderr?.trim() || `exit ${proc.status}` };
  });
}
