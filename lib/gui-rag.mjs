import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { addRoute } from "./server.mjs";
import { configValue } from "./config.mjs";

const RAG_SCRIPT = configValue("paths.ragScript", join(import.meta.dirname, "..", "rag.py"));

export function registerRagRoutes() {
  addRoute("GET", "/api/rag/status", () => {
    const storeDir = configValue("rag.storeDir", "rag_vector_store");
    const metaPath = join(import.meta.dirname, "..", storeDir, "meta.json");
    const knowledgeDir = configValue("rag.knowledgeDir", "knowledge");
    const knowledgeExists = existsSync(join(import.meta.dirname, "..", knowledgeDir));
    const indexExists = existsSync(metaPath);
    let chunkCount = 0;
    if (indexExists) {
      try {
        chunkCount = JSON.parse(require("fs").readFileSync(metaPath, "utf-8")).chunk_count || 0;
      } catch {}
    }
    return { ok: true, knowledgeExists, indexExists, chunkCount };
  });

  addRoute("POST", "/api/rag/rebuild", () => {
    // Run rebuild in background
    const proc = spawnSync("python", ["-X", "utf8", RAG_SCRIPT, "build"], {
      cwd: join(import.meta.dirname, ".."),
      encoding: "utf-8",
      timeout: 120_000,
      windowsHide: true,
    });
    if (proc.status === 0) {
      return { ok: true, output: proc.stdout?.trim() || "Rebuild complete" };
    }
    return { ok: false, error: proc.stderr?.trim() || `exit ${proc.status}` };
  });
}
