import { addRoute } from "./server.mjs";
import { listChatEvents, listConversations } from "./chat-history.mjs";

function queryParams(req) {
  const url = new URL(req.url, "http://127.0.0.1");
  return url.searchParams;
}

export function registerHistoryRoutes() {
  addRoute("GET", "/api/history/conversations", ({ req }) => {
    const params = queryParams(req);
    return {
      ok: true,
      conversations: listConversations({
        q: params.get("q") || "",
        dateFrom: params.get("dateFrom") || "",
        dateTo: params.get("dateTo") || "",
      }),
    };
  });

  addRoute("GET", "/api/history/messages", ({ req }) => {
    const params = queryParams(req);
    const pageSize = Math.max(1, Math.min(Number(params.get("pageSize") || 50), 200));
    const page = Math.max(1, Number(params.get("page") || 1));
    const offset = (page - 1) * pageSize;
    const result = listChatEvents({
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
}
