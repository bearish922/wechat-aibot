import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appJs = readFileSync(join(import.meta.dirname, "..", "static", "app.js"), "utf-8");

describe("Prompts runtime pipeline UI", () => {
  it("renders runtime steps in execution order", () => {
    const steps = [
      'title: "Profile"',
      'title: "表达能力"',
      'title: "长期记忆 (System Prompt)"',
      'title: "Hidden-world 输出"',
      'title: "RAG"',
      'title: "聊天风格及现实"',
      'title: "用户消息"',
      'title: "模型调用与输出"',
      'title: "Memory Update"',
    ];

    let last = -1;
    for (const step of steps) {
      const idx = appJs.indexOf(step);
      assert.ok(idx > last, `${step} should appear after the previous step`);
      last = idx;
    }
  });

  it("shows memory in stable system context before dynamic turn context", () => {
    const systemIdx = appJs.indexOf("阶段 1 — 稳定 System Context");
    const memoryIdx = appJs.indexOf('title: "长期记忆 (System Prompt)"');
    const dynamicIdx = appJs.indexOf("阶段 2 — 动态上下文");
    const modelIdx = appJs.indexOf("阶段 3 — 输出及memory维护");

    assert.ok(systemIdx >= 0, "stable system phase should be present");
    assert.ok(memoryIdx > systemIdx, "memory should be rendered inside stable system context");
    assert.ok(memoryIdx < dynamicIdx, "memory should appear before dynamic context");
    assert.ok(dynamicIdx < modelIdx, "dynamic context should appear before model output");
    assert.match(appJs, /通过 --append-system-prompt-file 注入 system prompt/);
  });

  it("exposes editable controls used by the runtime prompt pipeline", () => {
    const textFields = [
      "chatStyle",
      "expressionCapability",
      "chatRealityInstructions",
      "memoryUpdatePrompt",
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

  it("combines Prompts and Hidden World under one selected role", () => {
    assert.match(appJs, /id="promptProfileSelect"/);
    assert.doesNotMatch(appJs, /id="worldProfileSelect"/);
    assert.match(appJs, /selectedRoleProfile = e\.target\.value/);
    assert.match(appJs, /\/api\/prompts\/\$\{encodeURIComponent\(selectedRoleProfile\)\}/);
    assert.match(appJs, /renderWorldPipeline\(role, p\)/);
    assert.match(appJs, /Hidden World 与主动子系统/);
    assert.doesNotMatch(appJs, /<thead><tr><th>名称<\/th><th>Prompt 预览/);
  });

  it("manages role creation, editing and deletion in a modal", () => {
    assert.match(appJs, /id="manageProfilesBtn"/);
    assert.match(appJs, /async function openRoleManager/);
    assert.match(appJs, /class="modal-box modal-box-wide role-manager-modal"/);
    assert.match(appJs, /data-action="role-create"/);
    assert.match(appJs, /data-action="role-save"/);
    assert.match(appJs, /data-action="role-delete"/);
  });
});
