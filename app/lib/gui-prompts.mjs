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
    const textFields = ["chatStyle", "expressionCapability", "chatRealityInstructions", "sceneletInstructions", "memoryWriterInstructions", "proactiveInstructions", "visionCaptionPrompt", "ragContextInstruction", "chatHistoryIntro", "sceneStateIntro", "innerSceneletIntro", "memoryContextInstruction"];
    const numFields = ["visibleContextTurns", "sceneStateMaxChars", "memoryDefaultLimit", "memorySoftItemLimit", "memorySoftPromptChars", "proactiveCheckIntervalMs", "proactiveCooldownMs", "ragTopK", "ragMinScore", "ragResultMaxChars", "ragTimeoutMs"];
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
    const merged = { ...current, ...updates };
    savePrompts(merged);
    return { ok: true, prompts: merged };
  });
}
