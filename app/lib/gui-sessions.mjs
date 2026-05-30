import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addRoute } from "./server.mjs";
import { sessions, activeAI } from "./state.mjs";
import { dataPath } from "./paths.mjs";

const LOGS_DIR = dataPath("logs");
const DEFAULT_CHAT_CC_SESSIONS = new Set(["cst", "anon", "soyo", "aya"]);

function sessionMode(ai, session) {
  if (session._mode) return session._mode;
  return ai === "cc" && DEFAULT_CHAT_CC_SESSIONS.has(String(session.name || "").trim().toLowerCase()) ? "chat" : "tool";
}

export function registerSessionRoutes() {
  addRoute("GET", "/api/sessions", () => {
    const all = [];
    for (const [ai, map] of Object.entries(sessions)) {
      for (const [, u] of map) {
        for (const s of u.list) {
          all.push({
            ai,
            id: s.id,
            name: s.name,
            sid: s.sid,
            active: s.id === u.activeId,
            busy: s.busy || false,
            queue: s.queue?.length || 0,
            profile: s._profile || "默认",
            mode: sessionMode(ai, s),
            firstTurn: s._firstTurn,
          });
        }
      }
    }
    return { ok: true, sessions: all, currentAI: activeAI };
  });

  addRoute("GET", "/api/sessions/:id/history", ({ params }) => {
    const sid = params.id;
    if (!sid) return { ok: false, error: "session id required" };

    const lines = [];
    try {
      const files = readdirSync(LOGS_DIR)
        .filter(f => f.includes(sid.slice(0, 8)) && f.endsWith(".txt"))
        .sort()
        .slice(-5);
      for (const f of files) {
        const content = readFileSync(join(LOGS_DIR, f), "utf-8");
        lines.push(`--- ${f} ---`);
        lines.push(content.slice(0, 3000));
      }
    } catch {}
    return { ok: true, history: lines.join("\n") || "暂无历史记录" };
  });

  addRoute("GET", "/api/sessions/resume", () => {
    const lines = [];
    const commands = [];
    lines.push("# 会话恢复指令");
    lines.push(`# ${new Date().toLocaleString("zh-CN")}`);
    lines.push("");
    for (const [ai, map] of Object.entries(sessions)) {
      const aiLabel = ai === "cc" ? "Claude Code" : "Codex";
      lines.push(`## ${aiLabel}`);
      for (const [, u] of map) {
        for (const s of u.list) {
          const active = s.id === u.activeId ? " [当前]" : "";
          const profile = s._profile || "默认";
          const mode = sessionMode(ai, s);
          const command = mode === "chat" ? "chat session (no CLI resume)" : (ai === "cc" ? `claude --resume ${s.sid}` : `codex resume ${s.sid}`);
          lines.push(`  ${s.name}${active}`);
          lines.push(`    角色: ${profile}`);
          lines.push(`    类型: ${mode}`);
          lines.push(`    ${command}`);
          commands.push({
            ai,
            aiLabel,
            name: s.name,
            profile,
            mode,
            active: s.id === u.activeId,
            sid: s.sid,
            command,
          });
          lines.push("");
        }
      }
    }
    return { ok: true, text: lines.join("\n"), commands };
  });
}
