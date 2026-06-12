import { addRoute } from "./server.mjs";
import { listChatEvents, listConversations, updateChatEvent, deleteChatEvent } from "./chat-history.mjs";
import { sessions, activeAI } from "./state.mjs";

function queryParams(req) {
  const url = new URL(req.url, "http://127.0.0.1");
  return url.searchParams;
}

export function registerHistoryRoutes() {
  addRoute("GET", "/api/history/conversations", async ({ req }) => {
    const params = queryParams(req);
    return {
      ok: true,
      conversations: await listConversations({
        q: params.get("q") || "",
        dateFrom: params.get("dateFrom") || "",
        dateTo: params.get("dateTo") || "",
      }),
    };
  });

  addRoute("GET", "/api/history/messages", async ({ req }) => {
    const params = queryParams(req);
    const pageSize = Math.max(1, Math.min(Number(params.get("pageSize") || 50), 200));
    const page = Math.max(1, Number(params.get("page") || 1));
    const offset = (page - 1) * pageSize;
    const result = await listChatEvents({
      sessionKey: params.get("sessionKey") || "",
      q: params.get("q") || "",
      dateFrom: params.get("dateFrom") || "",
      dateTo: params.get("dateTo") || "",
      offset,
      limit: pageSize,
    });
    return {
      ok: true,
      messages: result.events,
      total: result.total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(result.total / pageSize)),
    };
  });

  addRoute("PUT", "/api/history/:eventId", async ({ params, body }) => {
    if (activeAI !== "api") return { error: `${activeAI === "codex" ? "Codex" : "CC"} mode: context is managed by the backend. Switch to /api first.`, status: 403 };
    const ok = await updateChatEvent(params.eventId, { text: body?.text });
    if (!ok) return { error: "event not found", status: 404 };
    if (activeAI === "api" && body?.syncToApi) {
      for (const [, u] of sessions.api || new Map()) {
        for (const s of u.list) {
          if (!s._apiMessages) continue;
          for (const m of s._apiMessages) {
            if (m._eventId === params.eventId) { m.content = body.text; break; }
          }
        }
      }
    }
    return { ok: true };
  });

  addRoute("DELETE", "/api/history/:eventId", async ({ params, body }) => {
    if (activeAI !== "api") return { error: `${activeAI === "codex" ? "Codex" : "CC"} mode: context is managed by the backend. Switch to /api first.`, status: 403 };
    const ok = await deleteChatEvent(params.eventId);
    if (!ok) return { error: "event not found", status: 404 };
    if (activeAI === "api" && body?.syncToApi) {
      for (const [, u] of sessions.api || new Map()) {
        for (const s of u.list) {
          if (!s._apiMessages) continue;
          s._apiMessages = s._apiMessages.filter(m => m._eventId !== params.eventId);
        }
      }
    }
    return { ok: true };
  });
}
