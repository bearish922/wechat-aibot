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
        A: { chatStyle: "style-a", sceneletInstructions: "scene-a" },
        B: { chatStyle: "style-b", sceneletInstructions: "scene-b" },
      },
    };

    assert.equal(mergeRolePrompts(document, "A").chatStyle, "style-a");
    assert.equal(mergeRolePrompts(document, "B").chatStyle, "style-b");
    assert.notEqual(mergeRolePrompts(document, "A").sceneletInstructions, mergeRolePrompts(document, "B").sceneletInstructions);
  });

  // 遗留平铺格式（无 roles 对象）仍然可读，迁移前不破坏已有配置
  it("keeps legacy flat prompt documents readable before migration", () => {
    const legacy = { chatStyle: "legacy-style", sceneletInstructions: "legacy-scene" };
    assert.equal(mergeRolePrompts(legacy, "any-role").chatStyle, "legacy-style");
    assert.equal(mergeRolePrompts(legacy, "any-role").sceneletInstructions, "legacy-scene");
  });

  // 当前已调优的千圣配置不泄露到新角色——新角色使用无角色名的基线
  it("migrates the current tuned suite to Chisato without leaking it to new roles", () => {
    const document = loadPromptDocument();
    assert.equal(document.version, 2);
    assert.deepEqual(Object.keys(document.roles), ["千早爱音", "丸山彩", "长崎素世", "白鹭千圣", "梦中的千圣"]);
    assert.equal(Object.keys(document.roles["白鹭千圣"]).length, ROLE_PROMPT_FIELDS.length + 1); // +1 为 runtimePolicy

    const chisato = loadPrompts("白鹭千圣");
    const untuned = loadPrompts("新角色");
    assert.notEqual(chisato.chatStyle, untuned.chatStyle);
    assert.match(chisato.sceneletReplyBridgeInstruction, /千圣/);
    assert.doesNotMatch(untuned.sceneletReplyBridgeInstruction, /千圣|小彩|PasPale|Leo/);
    assert.deepEqual(chisato.ragKeywords, untuned.ragKeywords);
  });

  // 千圣内心因果链条完整，但不泄露内心独白到用户可见输出——桥接指令过滤语言成品
  it("keeps Chisato inner emotion causal without leaking inner prose", () => {
    const scenelet = loadPrompts("白鹭千圣").sceneletInstructions;
    const bridge = loadPrompts("白鹭千圣").sceneletReplyBridgeInstruction;
    assert.match(scenelet, /新事实、纠正前提或说明自己已有经验时，先更新判断/);
    assert.match(scenelet, /普通低风险日常不主动发明专业审查项/);
    assert.match(bridge, /过滤的是语言成品/);
    assert.match(bridge, /感性金句.*外溢/);
    assert.match(bridge, /保留的是表达选择和互动后果/);
    assert.match(bridge, /不是强制每轮显露温柔/);
    assert.match(bridge, /不自动禁止它对语气、取舍和让步产生影响/);
    assert.match(bridge, /角色一致性不等于坚持旧判断/);
    assert.match(bridge, /给最少够用的答案，不自动扩写成完整检查表/);
  });

  // 特定角色运行时策略例外（如"梦中的千圣"的 scenelet 回复模式）不影响其他角色默认的完整 pipeline
  it("keeps role runtime exceptions isolated and defaults other roles to the full pipeline", () => {
    const document = loadPromptDocument();
    assert.deepEqual(roleRuntimePolicy(document, "梦中的千圣"), {
      actorMode: "single",
      actorVisibleContextTurns: 1,
      visibleReplySource: "scenelet",
      lifeArcEnabled: false,
      sceneletTurnReminder: "本轮写到一个自然停顿点即可。允许叙事悬而未决，不要总结、收束、压缩前文，也不要为了完整覆盖所有想法而继续展开。可以中断叙事，但不能中断句子。该停的时候就停。",
      visibleContextTurns: 2,
      proactiveEnabled: false,
      weatherEnabled: false,
    });
    assert.deepEqual(roleRuntimePolicy(document, "白鹭千圣"), {
      actorMode: "single",
      actorVisibleContextTurns: 1,
      visibleReplySource: "main",
      lifeArcEnabled: true,
      sceneletTurnReminder: "",
      visibleContextTurns: 0,
      proactiveEnabled: true,
      weatherEnabled: true,
    });
    assert.deepEqual(loadPrompts("新角色").runtimePolicy, {
      actorMode: "two_stage",
      actorVisibleContextTurns: 1,
      visibleReplySource: "main",
      lifeArcEnabled: true,
      sceneletTurnReminder: "",
      visibleContextTurns: 0,
      proactiveEnabled: true,
      weatherEnabled: true,
    });
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
