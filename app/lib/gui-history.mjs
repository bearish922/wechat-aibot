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
      conversations: listConversations({ q: params.get("q") || "" }),
    };
  });

  addRoute("GET", "/api/history/messages", ({ req }) => {
    const params = queryParams(req);
    return {
      ok: true,
      messages: listChatEvents({
        sessionKey: params.get("sessionKey") || "",
        q: params.get("q") || "",
        limit: params.get("limit") || 500,
      }),
    };
  });
}
