import { writeFileSync } from "node:fs";
import { addRoute } from "./server.mjs";
import { rootPath, ensureDir } from "./paths.mjs";
import { loadPrompts } from "./reply.mjs";

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

  addRoute("PUT", "/api/prompts", ({ body }) => {
    const current = loadPrompts();
    const updates = {};
    const textFields = ["chatStyle", "hiddenWorldChatStyle", "expressionCapability", "chatRealityInstructions", "sceneletInstructions", "memoryCandidateInstructions", "memoryWriterInstructions", "proactiveInstructions", "scheduleCreatorInstructions", "scheduleSpecialDates", "visionCaptionPrompt", "ragContextInstruction", "chatHistoryIntro", "innerSceneletIntro", "sceneletReplyBridgeInstruction", "memoryContextInstruction", "dailyShareSeedPrompt", "scheduleExtractorPrompt", "followUpGenerationPrompt", "sceneMemorySystemBlockIntro", "sceneMemoryPromptInstructions"];
    const numFields = ["visibleContextTurns", "turnResetThreshold", "proactiveCheckIntervalMs", "proactiveCooldownMs", "proactiveDailyMax", "dailyShareSeedIntervalMs", "dailyShareMinIdleMs", "scheduleCheckIntervalMs", "scheduleMaxActive", "ragTopK", "ragMinScore", "ragResultMaxChars", "ragTimeoutMs", "hiddenWorldMaxPendingIntents", "maxFollowUpCandidatesPerTurn", "dailyShareDefaultScheduleOffsetMs", "dailyShareDefaultExpiryOffsetMs", "proactiveDefaultExpiryOffsetMs", "scheduleFinalizationTimeoutMs", "scheduleRecentKindsLimit", "schedulePromptProfileMaxChars", "scheduleBasisMaxLength", "scheduleArcTitleMaxLength", "scheduleArcSummaryMaxLength", "scheduleExpiryAfterEndBufferMs", "scheduleDefaultExpiryFromNowMs", "memoryCandidateTimeoutMs", "memoryMergeTimeoutMs"];
    for (const key of textFields) {
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
    const merged = { ...current, ...updates };
    savePrompts(merged);
    return { ok: true, prompts: merged };
  });
}
