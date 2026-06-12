import { writeFileSync } from "node:fs";
import { addRoute } from "./server.mjs";
import { rootPath, ensureDir } from "./paths.mjs";
import { loadPromptDocument, loadPrompts } from "./reply.mjs";
import { ROLE_PROMPT_FIELDS } from "./role-prompts.mjs";

const PROMPTS_FILE = rootPath("data/prompts.json");

function savePrompts(obj) {
  ensureDir(rootPath("data"));
  writeFileSync(PROMPTS_FILE, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

export function registerPromptsRoutes() {
  addRoute("GET", "/api/prompts", () => {
    const prompts = loadPrompts();
    return { ok: true, prompts };
  });

  addRoute("GET", "/api/prompts/:profile", ({ params }) => {
    const profile = String(params.profile || "").trim();
    return { ok: true, profile, prompts: loadPrompts(profile), roleFields: ROLE_PROMPT_FIELDS };
  });

  addRoute("PUT", "/api/prompts", ({ body }) => {
    const profile = String(body.profile || "").trim();
    const document = loadPromptDocument();
    const current = loadPrompts(profile);
    const updates = {};
    const numFields = ["visibleContextTurns", "turnResetThreshold", "proactiveCheckIntervalMs", "proactiveCooldownMs", "proactiveDailyMax", "dailyShareSeedIntervalMs", "dailyShareMinIdleMs", "scheduleCheckIntervalMs", "ragTopK", "ragMinScore", "ragResultMaxChars", "ragTimeoutMs", "hiddenWorldMaxPendingIntents", "dailyShareDefaultScheduleOffsetMs", "dailyShareDefaultExpiryOffsetMs", "proactiveDefaultExpiryOffsetMs", "scheduleFinalizationTimeoutMs", "scheduleRecentKindsLimit", "scheduleBasisMaxLength", "scheduleArcTitleMaxLength", "scheduleExpiryAfterEndBufferMs", "scheduleDefaultExpiryFromNowMs"];
    for (const key of ROLE_PROMPT_FIELDS) {
      if (body[key] !== undefined) updates[key] = String(body[key]);
    }
    for (const key of numFields) {
      if (body[key] !== undefined) updates[key] = Number(body[key]);
    }
    if (body.ragKeywords !== undefined) {
      const kw = body.ragKeywords;
      updates.ragKeywords = {
        lore: kw.lore !== undefined ? String(kw.lore) : (current.ragKeywords?.lore || ""),
        names: kw.names !== undefined ? String(kw.names) : (current.ragKeywords?.names || ""),
      };
    }
    if (body.seasonalMonthlyNotes !== undefined) {
      try { updates.seasonalMonthlyNotes = typeof body.seasonalMonthlyNotes === "string" ? JSON.parse(body.seasonalMonthlyNotes) : body.seasonalMonthlyNotes; } catch { updates.seasonalMonthlyNotes = current.seasonalMonthlyNotes || null; }
    }
    if (body.dailyShareDefaultCancelIf !== undefined) {
      updates.dailyShareDefaultCancelIf = Array.isArray(body.dailyShareDefaultCancelIf)
        ? body.dailyShareDefaultCancelIf.map(x => String(x).trim()).filter(Boolean)
        : String(body.dailyShareDefaultCancelIf).split("\n").map(x => x.trim()).filter(Boolean);
    }
    const roleUpdates = {};
    const globalUpdates = { ...updates };
    for (const key of ROLE_PROMPT_FIELDS) {
      if (globalUpdates[key] === undefined) continue;
      roleUpdates[key] = globalUpdates[key];
      delete globalUpdates[key];
    }

    const merged = { ...document, ...globalUpdates };
    if (profile && Object.keys(roleUpdates).length) {
      merged.version = 2;
      merged.roles = { ...(document.roles || {}) };
      merged.roles[profile] = { ...(merged.roles[profile] || {}), ...roleUpdates };
    } else if (Object.keys(roleUpdates).length) {
      Object.assign(merged, roleUpdates);
    }
    savePrompts(merged);
    return { ok: true, profile, prompts: loadPrompts(profile) };
  });
}

export function deleteRolePromptSuite(profile) {
  if (!profile) return;
  const document = loadPromptDocument();
  if (!document.roles?.[profile]) return;
  const roles = { ...document.roles };
  delete roles[profile];
  savePrompts({ ...document, roles });
}
