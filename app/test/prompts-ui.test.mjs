import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appJs = readFileSync(join(import.meta.dirname, "..", "static", "app.js"), "utf-8");

describe("Prompts UI — 主回复 + 辅助独立模块", () => {
  it("主回复面板包含完整的 Prompt 管道步骤", () => {
    const steps = [
      'title: "Profile"',
      'title: "Scenelet 指令"',
      'title: "Actor 内心风格"',
      'title: "动态上下文补充"',
      'title: "聊天历史"',
      'title: "RAG 知识库检索"',
    ];

    let last = -1;
    for (const step of steps) {
      const idx = appJs.indexOf(step);
      assert.ok(idx > last, `${step} should appear in order within main reply pipeline`);
      last = idx;
    }
  });

  it("辅助独立模块按面板分组：continuity → proactive → reset → lifearc → work → 其他", () => {
    const panels = [
      { label: "continuity", title: 'title: "Continuity Update"' },
      { label: "proactive", title: 'title: "Daily Share Seed"' },
      { label: "proactive", title: 'title: "Proactive 二次判断"' },
      { label: "reset", title: 'title: "情景记忆 (Scene Memory)"' },
      { label: "reset", title: 'title: "长期记忆维护 (Memory Update)"' },
      { label: "reset", title: 'title: "Reset 参数"' },
      { label: "lifearc", title: 'title: "特殊日期与月度行事"' },
      { label: "lifearc", title: 'title: "Schedule Extractor"' },
      { label: "lifearc", title: 'title: "Life Arc 审批 (Schedule Creator)"' },
      { label: "work", title: 'title: "日程预生成器"' },
      { label: "其他", title: 'title: "行为开关"' },
      { label: "其他", title: 'title: "回复来源"' },
    ];

    let last = -1;
    for (const panel of panels) {
      const idx = appJs.indexOf(panel.title);
      assert.ok(idx > last, `${panel.title} should appear in order (${panel.label})`);
      last = idx;
    }
  });

  it("公开了主回复和辅助模块中的可编辑字段", () => {
    const textFields = [
      "continuityUpdatePrompt",
      "dailyShareSeedPrompt",
      "proactiveInstructions",
      "sceneMemorySystemBlockIntro",
      "sceneMemoryPromptInstructions",
      "memoryUpdatePrompt",
      "ragContextInstruction",
      "chatHistoryIntro",
      "scheduleExtractorPrompt",
      "scheduleCreatorInstructions",
    ];
    const numFields = [
      "contextResetRatio",
      "turnResetThreshold",
      "stateStaleThresholdMs",
      "maxCancelReasonLength",
      "scheduleCheckIntervalMs",
    ];
    const toggles = [
      "runtimePolicy.lifeArcEnabled",
      "runtimePolicy.proactiveEnabled",
      "runtimePolicy.weatherEnabled",
    ];

    for (const key of textFields) {
      assert.match(appJs, new RegExp(`renderTextPreview\\("${key}"`), `${key} should be editable`);
    }
    for (const key of numFields) {
      assert.match(appJs, new RegExp(`renderNumberControl\\("${key}"`), `${key} should be editable`);
    }
    for (const key of ["ragTopK", "ragMinScore", "ragResultMaxChars", "ragTimeoutMs"]) {
      assert.doesNotMatch(appJs, new RegExp(`renderNumberControl\\("${key}"`), `${key} belongs to global Config RAG settings, not Prompt editing`);
    }
    assert.match(appJs, /Config 页的 RAG 区域编辑/);
    for (const key of toggles) {
      assert.match(appJs, new RegExp(`renderToggleControl\\("${key}"`), `${key} should be toggleable`);
    }
    assert.doesNotMatch(appJs, /renderNumberControl\("memoryDefaultLimit"/, "memoryDefaultLimit is not in the current UI");
  });

  it("日程预生成器开关和参数全部暴露", () => {
    assert.match(appJs, /renderToggleControl\("workEventConfig\.enabled"/);
    assert.match(appJs, /renderNumberControl\("workEventConfig\.workHoursPerDay"/);
    assert.match(appJs, /renderNumberControl\("workEventConfig\.generationIntervalMs"/);
    assert.match(appJs, /generationIntervalMs \|\| 43200000/);
    assert.match(appJs, /renderNumberControl\("workEventConfig\.maxEventsPerGeneration"/);
    assert.match(appJs, /renderNumberControl\("workEventConfig\.minLeadHours\.light"/);
    assert.match(appJs, /renderNumberControl\("workEventConfig\.minLeadHours\.medium"/);
    assert.match(appJs, /renderNumberControl\("workEventConfig\.minLeadHours\.heavy"/);
    assert.match(appJs, /renderNumberControl\("workEventConfig\.conflictPolicy\.minGapBetweenEventsMinutes"/);
    assert.match(appJs, /renderSelectControl\("workEventConfig\.conflictPolicy\.light\.allow"/);
    assert.match(appJs, /renderSelectControl\("workEventConfig\.conflictPolicy\.medium\.allow"/);
    assert.match(appJs, /renderSelectControl\("workEventConfig\.conflictPolicy\.heavy\.allow"/);
  });

  it("去掉了旧的 renderWorldPipeline 命名和面板标题", () => {
    assert.match(appJs, /function renderAuxModules/);
    assert.match(appJs, /function renderMainReplyPipeline/);
    assert.doesNotMatch(appJs, /renderWorldPipeline\(role, p\)/);
    assert.doesNotMatch(appJs, /renderPromptsPipeline\(p, profile, profiles\)/);
    assert.doesNotMatch(appJs, /Hidden World 与主动子系统/);
  });

  it("角色管理弹窗依然存在", () => {
    assert.match(appJs, /id="manageProfilesBtn"/);
    assert.match(appJs, /async function openRoleManager/);
    assert.match(appJs, /class="modal-box modal-box-wide role-manager-modal"/);
    assert.match(appJs, /data-action="role-create"/);
    assert.match(appJs, /data-action="role-save"/);
    assert.match(appJs, /data-action="role-delete"/);
  });

  it("RAG 关键词控件仍限于 lore 和 names", () => {
    assert.match(appJs, /\{ key: "lore", label: "Lore" \}/);
    assert.match(appJs, /\{ key: "names", label: "Names" \}/);
    assert.doesNotMatch(appJs, /questionSubjects|questionContents|dailyMinLen|questionMinLen/);
  });

  it("只使用一个 profile 选择器（主回复面板内）", () => {
    assert.match(appJs, /id="promptProfileSelect"/);
    assert.match(appJs, /selectedRoleProfile = e\.target\.value/);
    assert.match(appJs, /\/api\/prompts\/\$\{encodeURIComponent\(selectedRoleProfile\)\}/);
    assert.doesNotMatch(appJs, /id="worldProfileSelect"/);
    assert.doesNotMatch(appJs, /<thead><tr><th>名称<\/th><th>Prompt 预览/);
  });
});
