import { writeFileSync, readFileSync, existsSync as fsExistsSync } from "node:fs";
import { addRoute } from "./server.mjs";
import { rootPath, ensureDir } from "./paths.mjs";
import { loadPromptDocument, loadPrompts } from "./reply.mjs";
import { ROLE_PROMPT_FIELDS } from "./role-prompts.mjs";

const PROMPTS_FILE = rootPath("data/prompts.json");
const PROMPTS_LOCAL_FILE = rootPath("data/prompts.local.json");

function savePrompts(obj) {
  ensureDir(rootPath("data"));
  writeFileSync(PROMPTS_FILE, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

function saveLocalPrompts(obj) {
  ensureDir(rootPath("data"));
  writeFileSync(PROMPTS_LOCAL_FILE, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

function profileInLocal(profile) {
  if (!profile) return false;
  try {
    if (!fsExistsSync(PROMPTS_LOCAL_FILE)) return false;
    const local = JSON.parse(readFileSync(PROMPTS_LOCAL_FILE, "utf-8"));
    return !!(local?.roles?.[profile]);
  } catch { return false; }
}

function loadLocalDocument() {
  try {
    if (!fsExistsSync(PROMPTS_LOCAL_FILE)) return {};
    const local = JSON.parse(readFileSync(PROMPTS_LOCAL_FILE, "utf-8"));
    return local && typeof local === "object" && !Array.isArray(local) ? local : {};
  } catch { return {}; }
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
    const numFields = ["contextResetRatio", "turnResetThreshold", "proactiveCheckIntervalMs", "proactiveCooldownMs", "proactiveDailyMax", "dailyShareSeedIntervalMs", "dailyShareMinIdleMs", "scheduleCheckIntervalMs", "ragTopK", "ragMinScore", "ragResultMaxChars", "ragTimeoutMs", "dailyShareDefaultScheduleOffsetMs", "dailyShareDefaultExpiryOffsetMs", "proactiveDefaultExpiryOffsetMs", "scheduleFinalizationTimeoutMs", "scheduleRecentKindsLimit", "scheduleBasisMaxLength", "scheduleArcTitleMaxLength", "scheduleExpiryAfterEndBufferMs", "scheduleDefaultExpiryFromNowMs"];
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

    // runtimePolicy: 接收嵌套对象，写入 roles[profile].runtimePolicy
    if (body.runtimePolicy !== undefined && body.runtimePolicy !== null && typeof body.runtimePolicy === "object") {
      const rp = body.runtimePolicy;
      const rpUpdate = {};
      if (rp.lifeArcEnabled !== undefined) rpUpdate.lifeArcEnabled = Boolean(rp.lifeArcEnabled);
      if (rp.proactiveEnabled !== undefined) rpUpdate.proactiveEnabled = Boolean(rp.proactiveEnabled);
      if (rp.weatherEnabled !== undefined) rpUpdate.weatherEnabled = Boolean(rp.weatherEnabled);
      if (rp.visibleReplySource !== undefined) rpUpdate.visibleReplySource = String(rp.visibleReplySource).trim() || "main";
      if (rp.actorVisibleContextTurns !== undefined) rpUpdate.actorVisibleContextTurns = Math.max(1, Math.min(12, Number(rp.actorVisibleContextTurns) || 8));
      if (rp.visibleContextTurns !== undefined) rpUpdate.visibleContextTurns = Math.max(0, Number(rp.visibleContextTurns) || 0);
      if (rp.actorMode !== undefined) rpUpdate.actorMode = "single";
      if (Object.keys(rpUpdate).length) {
        if (profile) roleUpdates.runtimePolicy = rpUpdate;
        else globalUpdates.runtimePolicy = rpUpdate;
      }
    }

    // workEventConfig: 日程预生成器配置（仅角色级）
    if (profile && body.workEventConfig !== undefined && body.workEventConfig !== null && typeof body.workEventConfig === "object") {
      const wec = body.workEventConfig;
      const wecUpdate = {};
      if (wec.enabled !== undefined) wecUpdate.enabled = Boolean(wec.enabled);
      if (wec.workHoursPerDay !== undefined) wecUpdate.workHoursPerDay = Math.max(1, Math.min(24, Number(wec.workHoursPerDay) || 8));
      if (wec.generationIntervalMs !== undefined) wecUpdate.generationIntervalMs = Math.max(3600000, Math.min(86400000, Number(wec.generationIntervalMs) || 43200000));
      if (wec.maxEventsPerGeneration !== undefined) wecUpdate.maxEventsPerGeneration = Math.max(1, Math.min(5, Number(wec.maxEventsPerGeneration) || 1));
      if (wec.minLeadHours) {
        const mlh = {};
        if (wec.minLeadHours.light !== undefined) mlh.light = Math.max(1, Math.min(168, Number(wec.minLeadHours.light) || 24));
        if (wec.minLeadHours.medium !== undefined) mlh.medium = Math.max(1, Math.min(168, Number(wec.minLeadHours.medium) || 48));
        if (wec.minLeadHours.heavy !== undefined) mlh.heavy = Math.max(1, Math.min(168, Number(wec.minLeadHours.heavy) || 72));
        if (Object.keys(mlh).length) wecUpdate.minLeadHours = { ...(roleUpdates.workEventConfig?.minLeadHours || { light: 24, medium: 48, heavy: 72 }), ...mlh };
      }
      if (wec.conflictPolicy) {
        const cp = { ...(roleUpdates.workEventConfig?.conflictPolicy || { light: { allow: false }, medium: { allow: false }, heavy: { allow: "school_only" }, minGapBetweenEventsMinutes: 60 }) };
        if (wec.conflictPolicy.minGapBetweenEventsMinutes !== undefined) cp.minGapBetweenEventsMinutes = Math.max(0, Math.min(240, Number(wec.conflictPolicy.minGapBetweenEventsMinutes) || 60));
        if (wec.conflictPolicy.light?.allow !== undefined) cp.light = { ...cp.light, allow: wec.conflictPolicy.light.allow === true || wec.conflictPolicy.light.allow === "true" ? true : wec.conflictPolicy.light.allow === "school_only" ? "school_only" : false };
        if (wec.conflictPolicy.medium?.allow !== undefined) cp.medium = { ...cp.medium, allow: wec.conflictPolicy.medium.allow === true || wec.conflictPolicy.medium.allow === "true" ? true : wec.conflictPolicy.medium.allow === "school_only" ? "school_only" : false };
        if (wec.conflictPolicy.heavy?.allow !== undefined) cp.heavy = { ...cp.heavy, allow: wec.conflictPolicy.heavy.allow === true || wec.conflictPolicy.heavy.allow === "true" ? true : wec.conflictPolicy.heavy.allow === "school_only" ? "school_only" : false };
        wecUpdate.conflictPolicy = cp;
      }
      if (Object.keys(wecUpdate).length) roleUpdates.workEventConfig = { ...(roleUpdates.workEventConfig || {}), ...wecUpdate };
    }

    const merged = { ...document, ...globalUpdates };
    if (profile && Object.keys(roleUpdates).length) {
      const inLocal = profileInLocal(profile);
      if (inLocal) {
        // 角色敏感配置在 prompts.local.json 中 → 写回 local 文件，不入 git
        const localDoc = loadLocalDocument();
        const localRole = { ...(localDoc.roles?.[profile] || {}) };
        if (roleUpdates.runtimePolicy) {
          localRole.runtimePolicy = { ...(localRole.runtimePolicy || {}), ...roleUpdates.runtimePolicy };
          delete roleUpdates.runtimePolicy;
        }
        if (roleUpdates.workEventConfig) {
          localRole.workEventConfig = { ...(localRole.workEventConfig || {}), ...roleUpdates.workEventConfig };
          delete roleUpdates.workEventConfig;
        }
        Object.assign(localRole, roleUpdates);
        localDoc.roles = { ...(localDoc.roles || {}), [profile]: localRole };
        saveLocalPrompts(localDoc);
        // 全局更新（非角色文本/策略）仍写入主文件
        merged.roles = { ...(document.roles || {}) };
        delete merged.roles[profile]; // 主文件中删除该角色，避免冲突
        savePrompts(merged);
      } else {
        // 普通角色 → 写入主 prompts.json
        merged.version = 2;
        merged.roles = { ...(document.roles || {}) };
        const existingRole = { ...(merged.roles[profile] || {}) };
        if (roleUpdates.runtimePolicy) {
          existingRole.runtimePolicy = { ...(existingRole.runtimePolicy || {}), ...roleUpdates.runtimePolicy };
          delete roleUpdates.runtimePolicy;
        }
        if (roleUpdates.workEventConfig) {
          existingRole.workEventConfig = { ...(existingRole.workEventConfig || {}), ...roleUpdates.workEventConfig };
          delete roleUpdates.workEventConfig;
        }
        merged.roles[profile] = { ...existingRole, ...roleUpdates };
        savePrompts(merged);
      }
    } else if (Object.keys(roleUpdates).length) {
      Object.assign(merged, roleUpdates);
      savePrompts(merged);
    } else {
      savePrompts(merged);
    }
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
