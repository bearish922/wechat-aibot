import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appJs = readFileSync(join(import.meta.dirname, "..", "static", "app.js"), "utf-8");

describe("Prompts runtime pipeline UI", () => {
  it("renders runtime steps in execution order", () => {
    const steps = [
      "WeChat 入站轮询",
      "会话 Profile 绑定",
      "入站附件 / Vision Caption",
      "失败轮次保护",
      "Profile Template",
      "稳定表达能力",
      "长期记忆注入",
      "Hidden-world 输出注入",
      "RAG Eligibility Gate",
      "聊天写法 / 聊天现实 + 用户消息",
      "后端 Prompt 组装",
      "流式输出、切分、发送",
      "成功后状态写回",
      "Memory Writer",
      "Hidden-world 后续工序",
    ];

    let last = -1;
    for (const step of steps) {
      const idx = appJs.indexOf(step);
      assert.ok(idx > last, `${step} should appear after the previous step`);
      last = idx;
    }
  });

  it("shows memory as a dynamic turn body prefix, not as stable system context", () => {
    const systemIdx = appJs.indexOf("阶段 1 — 稳定 System Context");
    const bodyPrefixIdx = appJs.indexOf("阶段 2 — 主回复动态 Turn Body");
    const memoryIdx = appJs.indexOf("长期记忆注入");
    const modelIdx = appJs.indexOf("阶段 3 — 主模型轮次");

    assert.ok(systemIdx >= 0, "stable system phase should be present");
    assert.ok(bodyPrefixIdx > systemIdx, "dynamic body prefix phase should appear after stable system phase");
    assert.ok(memoryIdx > bodyPrefixIdx, "memory should be rendered inside the dynamic body prefix phase");
    assert.ok(memoryIdx < modelIdx, "memory should appear before main model assembly");
    assert.match(appJs, /稳定 system context 到这里结束；接下来组装主回复动态 turn body/);
    assert.match(appJs, /memory snapshot 放在 turn body 最前面；不再进入稳定 system prompt/);
  });

  it("exposes editable controls used by the runtime prompt pipeline", () => {
    const textFields = [
      "chatStyle",
      "expressionCapability",
      "chatRealityInstructions",
      "memoryCandidateInstructions",
      "memoryWriterInstructions",
      "visionCaptionPrompt",
      "ragContextInstruction",
      "memoryContextInstruction",
    ];
    const numFields = [
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
    assert.doesNotMatch(appJs, /title: "可见上下文窗口"/);
  });

  it("keeps RAG keyword controls limited to lore and names", () => {
    assert.match(appJs, /\{ key: "lore", label: "Lore" \}/);
    assert.match(appJs, /\{ key: "names", label: "Names" \}/);
    assert.doesNotMatch(appJs, /questionSubjects|questionContents|dailyMinLen|questionMinLen/);
  });
});
