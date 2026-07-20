import { addRoute } from "./server.mjs";
import { listChatEvents, listConversations, updateChatEvent, deleteChatEvent } from "./chat-history.mjs";
import { listArchivedConversations, listArchivedMessages } from "./worldline-archive.mjs";
import { sessions, activeAI } from "./state.mjs";

function queryParams(req) {
  const url = new URL(req.url, "http://127.0.0.1");
  return url.searchParams;
}

function persistSessions() {
  globalThis.__wechatSaveSessions?.();
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
      archivedConversations: listArchivedConversations({
        q: params.get("q") || "",
        dateFrom: params.get("dateFrom") || "",
        dateTo: params.get("dateTo") || "",
      }),
    };
  });

  addRoute("GET", "/api/history/messages", async ({ req }) => {
    const params = queryParams(req);
    const requestedPageSize = Number(params.get("pageSize") || 50);
    const requestedPage = Number(params.get("page") || 1);
    const pageSize = Number.isFinite(requestedPageSize) ? Math.max(1, Math.min(requestedPageSize, 200)) : 50;
    const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1;
    const offset = (page - 1) * pageSize;
    const source = params.get("source") || "active";
    const result = source === "archive"
      ? listArchivedMessages({
        archiveId: params.get("archiveId") || "",
        profile: params.get("profile") || "",
        q: params.get("q") || "",
        dateFrom: params.get("dateFrom") || "",
        dateTo: params.get("dateTo") || "",
        offset,
        limit: pageSize,
      })
      : await listChatEvents({
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
      source,
    };
  });

  addRoute("PUT", "/api/history/:eventId", async ({ params, body }) => {
    const ok = await updateChatEvent(params.eventId, { text: body?.text });
    if (!ok) return { error: "event not found", status: 404 };
    // SQLite history is the project-visible history used for visible context.
    // CC/Codex native backend threads cannot be edited in place; reset them if
    // their hidden/native transcript must stop carrying old content. Direct API
    // has no external native thread, so mirror the edit into its in-memory API
    // message list as well.
    if (activeAI === "api" && body?.syncToApi) {
      for (const [, u] of sessions.api || new Map()) {
        for (const s of u.list) {
          if (!s._apiMessages) continue;
          for (const m of s._apiMessages) {
            if (m._eventId === params.eventId) { m.content = body.text; break; }
          }
        }
      }
      persistSessions();
    }
    return { ok: true };
  });

  addRoute("DELETE", "/api/history/:eventId", async ({ params, body }) => {
    const ok = await deleteChatEvent(params.eventId);
    if (!ok) return { error: "event not found", status: 404 };
    // See PUT route above: local SQLite edits affect project-visible history;
    // CC/Codex native threads still require reset if their hidden transcript
    // needs to be discarded.
    if (activeAI === "api" && body?.syncToApi) {
      for (const [, u] of sessions.api || new Map()) {
        for (const s of u.list) {
          if (!s._apiMessages) continue;
          s._apiMessages = s._apiMessages.filter(m => m._eventId !== params.eventId);
        }
      }
      persistSessions();
    }
    return { ok: true };
  });
}
