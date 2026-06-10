import { addRoute } from "./server.mjs";
import { loadMemoryDocument, saveMemoryDocument, loadWorldMemoryDocument, saveWorldMemoryDocument } from "./memory.mjs";

export function registerMemoryRoutes() {
  addRoute("GET", "/api/memory", () => {
    const doc = loadMemoryDocument();
    return { ok: true, content: doc, length: doc.length };
  });

  addRoute("PUT", "/api/memory", ({ body }) => {
    const content = String(body?.content || "").trim();
    if (!content) return { ok: false, error: "content is required" };
    saveMemoryDocument(content);
    return { ok: true, length: content.length };
  });

  addRoute("GET", "/api/world-memory", () => {
    const doc = loadWorldMemoryDocument();
    return { ok: true, content: doc, length: doc.length };
  });

  addRoute("PUT", "/api/world-memory", ({ body }) => {
    const content = String(body?.content || "").trim();
    if (!content) return { ok: false, error: "content is required" };
    saveWorldMemoryDocument(content);
    return { ok: true, length: content.length };
  });
}
