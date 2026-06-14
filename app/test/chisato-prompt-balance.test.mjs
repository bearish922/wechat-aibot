import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getGenericRolePromptDefaults } from "../lib/role-prompts.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(appDir, "..", "data");
const promptDocument = JSON.parse(fs.readFileSync(path.join(dataDir, "prompts.json"), "utf8"));
const profileDocument = JSON.parse(fs.readFileSync(path.join(dataDir, "wechat-profiles.json"), "utf8"));
const role = promptDocument.roles["白鹭千圣"];
const profile = profileDocument.templates["白鹭千圣"];

describe("Chisato prompt balance", () => {
  it("keeps warmth as the stable social surface and authority domain-gated", () => {
    assert.match(profile, /礼貌、优雅和得体并非虚假的职业面具/);
    assert.match(profile, /威严来自能力、判断准确、边界稳定以及愿意承担责任/);
    assert.match(profile, /真正严格只在有明确对象与后果时出现/);
    assert.match(profile, /同一件事说一次通常就够了/);
    assert.doesNotMatch(profile, /养了Leo这么多年，你习惯了管教/);
    assert.doesNotMatch(profile, /不留商量余地/);
  });

  it("keeps the split scenelet contract while preventing adjacent audits", () => {
    assert.match(role.sceneletInstructions, /"scene_state"/);
    assert.match(role.sceneletInstructions, /"inner_scenelet"/);
    assert.match(role.sceneletInstructions, /"world_state_patch"/);
    assert.match(role.sceneletInstructions, /不要为了维持原立场，转去追问相邻属性或发明新的审查项/);
    assert.match(role.sceneletInstructions, /同一件事在后续轮次保持安静/);
  });

  it("keeps hidden emotion causal without turning it into cold management", () => {
    assert.match(role.sceneletReplyBridgeInstruction, /收束的是坦白程度、情绪强度和语言成品，不是待人的温度/);
    assert.match(role.sceneletReplyBridgeInstruction, /不要把所有情绪都翻译成缩小要求、安排任务和风险管理/);
    assert.match(role.sceneletReplyBridgeInstruction, /current_plan 是背景，不是回复议程/);
    assert.match(role.chatStyle, /同一件计划或状态只在确有必要时说一次/);
  });

  it("drops transient plans across memory and proactive flows", () => {
    assert.match(role.sceneMemoryPromptInstructions, /主动丢弃/);
    assert.match(role.sceneMemoryPromptInstructions, /重复出现的“要睡\/出门\/吃饭”/);
    assert.match(role.sceneMemoryPromptInstructions, /临时地点、手边动作、身体姿势和接下来几小时计划/);
    assert.match(role.sceneMemoryPromptInstructions, /800-1600/);
    assert.match(role.proactiveInstructions, /候选只是早先的假设/);
    assert.match(role.dailyShareSeedPrompt, /不要重复近期说过的健康建议、催睡催出门/);
    assert.match(role.timeAdvancementPrompt, /current_plan 只写接下来几小时的现实生活安排/);
  });

  it("carries the same anti-repetition rules in generic hardcoded fallbacks", () => {
    const generic = getGenericRolePromptDefaults();
    assert.match(generic.chatHistoryIntro, /已经说过的提醒、状态和计划/);
    assert.match(generic.sceneletReplyBridgeInstruction, /收束的是坦白程度与情绪强度，不是待人的温度/);
    assert.match(generic.dailyShareSeedPrompt, /催睡催出门/);
    assert.match(generic.timeAdvancementPrompt, /不写回复用户等聊天动作/);
  });
});
