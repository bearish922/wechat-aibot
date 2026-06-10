// gui-context.mjs — GUI API for API session context management
import { addRoute } from "./server.mjs";
import { sessions, activeAI } from "./state.mjs";
import { isApiConfigured } from "./api-client.mjs";
import { uuid } from "./utils.mjs";

function sessionStore() {
  const key = activeAI === "api" ? "cc" : activeAI;
  return sessions[key] || sessions.cc;
}

export function registerGuiContext() {
  // GET /api/context — list all sessions with context info
  addRoute("GET", "/api/context", () => {
    const store = sessionStore();
    const list = [];
    for (const [userId, u] of store) {
      for (const s of u.list) {
        const msgs = s._apiMessages || [];
        const estTokens = msgs.reduce((sum, m) => sum + Math.ceil(String(m.content || "").length / 2), 0);
        list.push({
          id: s.id,
          name: s.name,
          userId,
          profile: s._profile || "none",
          busy: s.busy,
          turnCount: s._turnCount || 0,
          apiMessages: msgs.length,
          apiTokens: estTokens,
        });
      }
    }
    return { sessions: list, apiConfigured: isApiConfigured(), activeBackend: activeAI };
  });

  // GET /api/context/:sessionId — get messages for a session
  addRoute("GET", "/api/context/:sessionId", ({ params }) => {
    const store = sessionStore();
    let sess = null;
    for (const [, u] of store) {
      const found = u.list.find(s => s.id === params.sessionId);
      if (found) { sess = found; break; }
    }
    if (!sess) return { error: "session not found", status: 404 };

    const msgs = sess._apiMessages || [];
    const messages = msgs.map((m, i) => ({
      index: i,
      role: m.role,
      content: String(m.content || ""),
      preview: String(m.content || "").slice(0, 200),
      length: String(m.content || "").length,
    }));

    return {
      sessionId: sess.id,
      sessionName: sess.name,
      turnCount: sess._turnCount || 0,
      messages,
    };
  });

  // DELETE /api/context/:sessionId/:msgIndex — delete a message
  addRoute("DELETE", "/api/context/:sessionId/:msgIndex", ({ params, body }) => {
    const store = sessionStore();
    let sess = null;
    for (const [, u] of store) {
      const found = u.list.find(s => s.id === params.sessionId);
      if (found) { sess = found; break; }
    }
    if (!sess) return { error: "session not found", status: 404 };

    const idx = parseInt(params.msgIndex, 10);
    if (!Array.isArray(sess._apiMessages) || idx < 0 || idx >= sess._apiMessages.length) {
      return { error: "invalid message index", status: 400 };
    }
    sess._apiMessages.splice(idx, 1);
    return { ok: true, remaining: sess._apiMessages.length };
  });

  // PUT /api/context/:sessionId/:msgIndex — edit a message
  addRoute("PUT", "/api/context/:sessionId/:msgIndex", ({ params, body }) => {
    const store = sessionStore();
    let sess = null;
    for (const [, u] of store) {
      const found = u.list.find(s => s.id === params.sessionId);
      if (found) { sess = found; break; }
    }
    if (!sess) return { error: "session not found", status: 404 };

    const idx = parseInt(params.msgIndex, 10);
    if (!Array.isArray(sess._apiMessages) || idx < 0 || idx >= sess._apiMessages.length) {
      return { error: "invalid message index", status: 400 };
    }
    const { content } = body || {};
    if (typeof content !== "string" || !content.trim()) {
      return { error: "content is required", status: 400 };
    }
    sess._apiMessages[idx].content = String(content);
    return { ok: true };
  });

  // POST /api/context/:sessionId/reset — trigger manual reset
  addRoute("POST", "/api/context/:sessionId/reset", ({ params, body }) => {
    const store = sessionStore();
    let sess = null;
    for (const [, u] of store) {
      const found = u.list.find(s => s.id === params.sessionId);
      if (found) { sess = found; break; }
    }
    if (!sess) return { error: "session not found", status: 404 };

    const keepTurns = parseInt(body?.keepTurns || 4, 10);
    const msgs = sess._apiMessages || [];
    const kept = msgs.slice(-Math.max(keepTurns * 2, 4));
    sess._apiMessages = kept;
    sess._turnCount = 0;
    sess._firstTurn = true;
    sess.sid = uuid();

    return { ok: true, kept: kept.length, newSid: sess.sid };
  });
}
