import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appJs = readFileSync(join(process.cwd(), "static", "app.js"), "utf-8");

describe("Prompts runtime pipeline UI", () => {
  it("renders runtime steps in execution order", () => {
    const steps = [
      "WeChat 入站轮询",
      "会话 Profile 绑定",
      "入站附件 / Vision Caption",
      "失败轮次保护",
      "Profile Template",
      "长期记忆注入",
      "稳定表达能力",
      "可见上下文窗口",
      "延续 scene_state",
      "隐藏 inner_scenelet 调用",
      "RAG Eligibility Gate",
      "聊天写法 / 聊天现实 + 用户消息",
      "后端 Prompt 组装",
      "流式输出、切分、发送",
      "成功后状态写回",
      "Memory Writer",
      "Proactive Candidate Queue",
      "Daily Share Seed",
      "Proactive Evaluation",
    ];

    let last = -1;
    for (const step of steps) {
      const idx = appJs.indexOf(step);
      assert.ok(idx > last, `${step} should appear after the previous step`);
      last = idx;
    }
  });

  it("exposes editable controls used by the runtime prompt pipeline", () => {
    const textFields = [
      "chatStyle",
      "expressionCapability",
      "chatRealityInstructions",
      "sceneletInstructions",
      "dailyShareSeedInstructions",
      "memoryWriterInstructions",
      "proactiveInstructions",
      "visionCaptionPrompt",
      "ragContextInstruction",
      "chatHistoryIntro",
      "sceneStateIntro",
      "innerSceneletIntro",
      "sceneletReplyBridgeInstruction",
      "memoryContextInstruction",
    ];
    const numFields = [
      "visibleContextTurns",
      "sceneStateMaxChars",
      "memorySoftItemLimit",
      "memorySoftPromptChars",
      "proactiveCheckIntervalMs",
      "proactiveCooldownMs",
      "proactiveDailyMax",
      "dailyShareSeedIntervalMs",
      "dailyShareMinIdleMs",
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
    assert.doesNotMatch(appJs, /renderNumberControl\("memoryDefaultLimit"/, "memoryDefaultLimit is not used by the current stable memory snapshot path");
  });

  it("keeps RAG keyword controls limited to lore and names", () => {
    assert.match(appJs, /\{ key: "lore", label: "Lore" \}/);
    assert.match(appJs, /\{ key: "names", label: "Names" \}/);
    assert.doesNotMatch(appJs, /questionSubjects|questionContents|dailyMinLen|questionMinLen/);
  });
});
