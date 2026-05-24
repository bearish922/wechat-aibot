import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { addRoute } from "./server.mjs";
import { configValue } from "./config.mjs";

const APP_ROOT = resolve(import.meta.dirname, "..");
const RAG_SCRIPT = resolve(APP_ROOT, configValue("paths.ragScript", "rag.py"));

function appPath(value) {
  return resolve(APP_ROOT, value);
}

export function registerRagRoutes() {
  addRoute("GET", "/api/rag/status", () => {
    const storeDir = configValue("rag.storeDir", "rag_vector_store");
    const metaPath = appPath(join(storeDir, "rag_meta.json"));
    const knowledgeDir = configValue("rag.knowledgeDir", "knowledge");
    const knowledgeExists = existsSync(appPath(knowledgeDir));
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
      cwd: APP_ROOT,
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
