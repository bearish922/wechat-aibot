import { addRoute } from "./server.mjs";
import { sessions, activeAI } from "./state.mjs";

function hiddenWorldForProfile(profile) {
  const worlds = globalThis.__wechatRoleWorlds;
  const world = worlds?.get?.(profile || "默认");
  return world?._worldSession || null;
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
            firstTurn: s._firstTurn,
            hiddenWorld: hiddenWorldForProfile(s._profile || "默认"),
          });
        }
      }
    }
    return { ok: true, sessions: all, currentAI: activeAI };
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
          const hiddenWorld = hiddenWorldForProfile(profile);
          const command = ai === "cc" ? `claude --resume ${s.sid}` : `codex resume ${s.sid}`;
          lines.push(`  ${s.name}${active}`);
          lines.push(`    角色: ${profile}`);
          lines.push(`    ${command}`);
          if (hiddenWorld?.sid) lines.push(`    Hidden world: claude --resume ${hiddenWorld.sid}`);
          commands.push({
            ai,
            aiLabel,
            name: s.name,
            profile,
            active: s.id === u.activeId,
            sid: s.sid,
            command,
            hiddenWorldSid: hiddenWorld?.sid || "",
            hiddenWorldFirstTurn: Boolean(hiddenWorld?.firstTurn),
          });
          lines.push("");
        }
      }
    }
    return { ok: true, text: lines.join("\n"), commands };
  });
}
