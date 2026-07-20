import { addRoute } from "./server.mjs";
import { loadMemoryDocument, saveMemoryDocument, loadWorldMemoryDocument, saveWorldMemoryDocument } from "./memory.mjs";

export function registerMemoryRoutes() {
  addRoute("GET", "/api/memory", ({ query }) => {
    const profile = String(query?.profile || "").trim();
    const doc = loadMemoryDocument(profile);
    return { ok: true, content: doc, length: doc.length, profile: profile || null };
  });

  addRoute("PUT", "/api/memory", ({ body }) => {
    const content = String(body?.content ?? "").trim();
    const profile = String(body?.profile || "").trim();
    saveMemoryDocument(content, profile);
    return { ok: true, length: content.length, profile: profile || null };
  });

  addRoute("GET", "/api/world-memory", ({ query }) => {
    const profile = String(query?.profile || "").trim();
    const doc = loadWorldMemoryDocument(profile);
    return { ok: true, content: doc, length: doc.length, profile: profile || null };
  });

  addRoute("PUT", "/api/world-memory", ({ body }) => {
    const content = String(body?.content ?? "").trim();
    const profile = String(body?.profile || "").trim();
    saveWorldMemoryDocument(content, profile);
    return { ok: true, length: content.length, profile: profile || null };
  });
}
