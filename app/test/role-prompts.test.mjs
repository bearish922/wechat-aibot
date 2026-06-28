// ─── 角色提示词套件测试 ───
// 验证角色提示词系统的隔离性：各角色文本独立、运行时策略边界清晰、
// 遗留格式兼容、以及角色默认值不污染全局模块。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getGenericRolePromptDefaults, mergeRolePrompts, roleRuntimePolicy, ROLE_PROMPT_FIELDS } from "../lib/role-prompts.mjs";
import { loadPromptDocument, loadPrompts } from "../lib/reply.mjs";
import * as globalDefaults from "../lib/default-prompts.mjs";

describe("Role prompt suites", () => {
  // 不同角色文本相互隔离，共享级设置（visibleContextTurns、ragKeywords）保持全局
  it("isolates role text while shared runtime settings stay global", () => {
    const document = {
      visibleContextTurns: 12,
      ragKeywords: { lore: ["shared"], names: [] },
      roles: {
        A: { memoryUpdatePrompt: "memory-a", sceneletInstructions: "scene-a" },
        B: { memoryUpdatePrompt: "memory-b", sceneletInstructions: "scene-b" },
      },
    };

    assert.equal(mergeRolePrompts(document, "A").memoryUpdatePrompt, "memory-a");
    assert.equal(mergeRolePrompts(document, "B").memoryUpdatePrompt, "memory-b");
    assert.notEqual(mergeRolePrompts(document, "A").sceneletInstructions, mergeRolePrompts(document, "B").sceneletInstructions);
  });

  // 遗留平铺格式（无 roles 对象）仍然可读，迁移前不破坏已有配置
  it("keeps legacy flat prompt documents readable before migration", () => {
    const legacy = { memoryUpdatePrompt: "legacy-memory", sceneletInstructions: "legacy-scene" };
    assert.equal(mergeRolePrompts(legacy, "any-role").memoryUpdatePrompt, "legacy-memory");
    assert.equal(mergeRolePrompts(legacy, "any-role").sceneletInstructions, "legacy-scene");
  });

  // 当前已调优的千圣配置不泄露到新角色——新角色使用无角色名的基线
  it("migrates the current tuned suite to Chisato without leaking it to new roles", () => {
    const document = loadPromptDocument();
    assert.equal(document.version, 2);
    assert.deepEqual(Object.keys(document.roles), ["千早爱音", "丸山彩", "长崎素世", "白鹭千圣", "梦中的千圣"]);
    assert.ok(ROLE_PROMPT_FIELDS.every(field => typeof document.roles["白鹭千圣"][field] === "string"));
    assert.equal(document.roles["白鹭千圣"].runtimePolicy.actorMode, "single");

    const chisato = loadPrompts("白鹭千圣");
    const untuned = loadPrompts("新角色");
    assert.notEqual(chisato.hiddenWorldChatStyle, untuned.hiddenWorldChatStyle);
    assert.deepEqual(chisato.ragKeywords, untuned.ragKeywords);
  });

  // 千圣内心因果链条完整，但不泄露内心独白到用户可见输出——桥接指令过滤语言成品
  it("keeps Chisato inner emotion causal without leaking inner prose", () => {
    const scenelet = loadPrompts("白鹭千圣").sceneletInstructions;
    assert.match(scenelet, /新事实、纠正前提或说明自己已有经验时，先更新判断/);
    assert.match(scenelet, /普通低风险日常不主动发明专业审查项/);
    assert.match(scenelet, /visible_reply 是千圣在微信里实际发给沃沃的中文消息/);
    assert.match(scenelet, /不是 inner_scenelet 的摘要或改写/);
  });

  // 特定角色运行时策略例外（如"梦中的千圣"的 scenelet 回复模式）不影响其他角色默认的完整 pipeline
  it("keeps role runtime exceptions isolated and defaults other roles to the full pipeline", () => {
    const document = loadPromptDocument();
    assert.deepEqual(roleRuntimePolicy(document, "梦中的千圣"), {
      actorMode: "single",
      actorVisibleContextTurns: 2,
      visibleReplySource: "scenelet",
      lifeArcEnabled: false,
      visibleContextTurns: 0,
      proactiveEnabled: false,
      weatherEnabled: false,
    });
    assert.deepEqual(roleRuntimePolicy(document, "白鹭千圣"), {
      actorMode: "single",
      actorVisibleContextTurns: 2,
      visibleReplySource: "main",
      lifeArcEnabled: true,
      visibleContextTurns: 0,
      proactiveEnabled: true,
      weatherEnabled: true,
    });
    assert.deepEqual(loadPrompts("新角色").runtimePolicy, {
      actorMode: "single",
      actorVisibleContextTurns: 8,
      visibleReplySource: "main",
      lifeArcEnabled: true,
      visibleContextTurns: 0,
      proactiveEnabled: true,
      weatherEnabled: true,
    });
  });

  it("keeps every single-actor main-reply prompt compatible with its validator", () => {
    const document = loadPromptDocument();
    for (const profile of Object.keys(document.roles)) {
      const prompts = loadPrompts(profile);
      if (prompts.runtimePolicy.actorMode !== "single" || prompts.runtimePolicy.visibleReplySource !== "main") continue;
      assert.match(prompts.sceneletInstructions, /visible_reply/, `${profile} must request visible_reply`);
    }
    assert.match(loadPrompts("新角色").sceneletInstructions, /visible_reply/);
  });

  // 每个角色域字段都有完整的中性基线值，不会缺失而导致运行时错误
  it("provides a complete neutral baseline for every scoped field", () => {
    const generic = getGenericRolePromptDefaults();
    assert.deepEqual(Object.keys(generic).sort(), [...ROLE_PROMPT_FIELDS].sort());
    for (const key of ROLE_PROMPT_FIELDS) assert.equal(typeof generic[key], "string", `${key} should have a string baseline`);
  });

  // 角色提示词默认值不污染全局 defaults 模块，保持模块边界清晰
  it("keeps role prompt defaults out of the global defaults module", () => {
    for (const key of ROLE_PROMPT_FIELDS) {
      const exportName = `DEFAULT_${key.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}`;
      assert.equal(exportName in globalDefaults, false, `${exportName} should not be globally exported`);
    }
  });

  // 明确设为空字符串的角色字段不会回退到其他角色或基线
  it("preserves an explicit empty role prompt without falling back to another role", () => {
    const document = { roles: { A: { scheduleSpecialDates: "" } } };
    assert.equal(mergeRolePrompts(document, "A").scheduleSpecialDates, "");
  });
});
