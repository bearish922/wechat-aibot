import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appJs = readFileSync(join(process.cwd(), "static", "app.js"), "utf-8");

describe("Prompts runtime pipeline UI", () => {
  it("renders runtime steps in execution order", () => {
    const steps = [
      "WeChat Inbound Poll",
      "Session Profile Binding",
      "Inbound Attachment / Vision Caption",
      "Failed Turn Guard",
      "Profile Template + Pinned Rules",
      "Long-term Memory Injection",
      "Stable Chat Style",
      "Visible Context Window",
      "Carried Scene State",
      "Hidden Inner Scenelet Call",
      "RAG Eligibility Gate",
      "Chat Reality + User Message",
      "Backend Prompt Assembly",
      "Streaming Flush, Split, Send",
      "Success-only State Writeback",
      "Memory Writer",
      "Proactive Candidate Queue",
      "Proactive Evaluation",
    ];

    let last = -1;
    for (const step of steps) {
      const idx = appJs.indexOf(step);
      assert.ok(idx > last, `${step} should appear after the previous step`);
      last = idx;
    }
  });

  it("exposes every editable prompt field accepted by /api/prompts", () => {
    const textFields = [
      "chatStyle",
      "expressionCapability",
      "chatRealityInstructions",
      "sceneletInstructions",
      "memoryWriterInstructions",
      "proactiveInstructions",
      "visionCaptionPrompt",
      "ragContextInstruction",
      "chatHistoryIntro",
      "sceneStateIntro",
      "innerSceneletIntro",
      "memoryContextInstruction",
    ];
    const numFields = [
      "visibleContextTurns",
      "sceneStateMaxChars",
      "memoryDefaultLimit",
      "memorySoftItemLimit",
      "memorySoftPromptChars",
      "proactiveCheckIntervalMs",
      "proactiveCooldownMs",
      "ragTopK",
      "ragMinScore",
      "ragResultMaxChars",
      "ragTimeoutMs",
    ];

    for (const key of textFields) {
      assert.match(appJs, new RegExp(`renderTextPreview\\("${key}"`), `${key} should be editable`);
    }
    for (const key of numFields) {
      assert.match(appJs, new RegExp(`renderNumberControl\\("${key}"`), `${key} should be editable`);
    }
  });

  it("keeps RAG keyword controls limited to lore and names", () => {
    assert.match(appJs, /\{ key: "lore", label: "Lore" \}/);
    assert.match(appJs, /\{ key: "names", label: "Names" \}/);
    assert.doesNotMatch(appJs, /questionSubjects|questionContents|dailyMinLen|questionMinLen/);
  });
});
