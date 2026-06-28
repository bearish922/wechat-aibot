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

  it("keeps the single-actor contract while preventing adjacent audits", () => {
    assert.match(role.sceneletInstructions, /"inner_scenelet"/);
    assert.match(role.sceneletInstructions, /"visible_reply"/);
    assert.match(role.sceneletInstructions, /不要为了维持原立场，转去追问相邻属性或发明新的审查项/);
    assert.match(role.sceneletInstructions, /已经说过的提醒、结论、状态或计划视为对方已知/);
  });

  it("separates parenthetical action from dialogue and keeps visible replies conversational", () => {
    assert.match(role.sceneletInstructions, /进入括号后，暂停对沃沃说话/);
    assert.match(role.sceneletInstructions, /括号内不要继续解释、评价、回忆、提问、承诺或命令沃沃/);
    assert.match(role.sceneletInstructions, /去掉括号后.*仍像千圣在直接和沃沃说话/);
    assert.match(role.sceneletInstructions, /盯着屏幕看了两秒，还是把脸偏开了/);
    assert.match(role.sceneletInstructions, /visible_reply 首先是微信私聊，不是散文、短评、文案、独白或段落收束/);
    assert.match(role.sceneletInstructions, /不继续写“主线、支线、体力条、新地图、通关、奖励”/);
    assert.match(role.proactiveInstructions, /主动消息同样是微信口语/);
    assert.match(role.proactiveInstructions, /括号只能描述千圣当前可观察的动作/);
  });

  it("keeps hidden emotion causal without turning it into cold management", () => {
    assert.match(role.sceneletInstructions, /内心允许比外在更乱或更强烈/);
    assert.match(role.sceneletInstructions, /内心可以在不同维度间自然切换/);
    assert.match(role.sceneletInstructions, /普通低风险日常不主动发明专业审查项/);
    assert.match(role.hiddenWorldChatStyle, /当前地点、身体状态和短期计划是背景，不是必须塞进回复的内容/);
  });

  it("drops transient plans across memory and proactive flows", () => {
    assert.match(role.sceneMemoryPromptInstructions, /主动丢弃/);
    assert.match(role.sceneMemoryPromptInstructions, /已完结的一次性玩笑、普通寒暄/);
    assert.match(role.sceneMemoryPromptInstructions, /临时手边动作、身体姿势、接下来几小时计划/);
    assert.match(role.sceneMemoryPromptInstructions, /不设字数上限/);
    assert.match(role.proactiveInstructions, /候选只是早先的假设/);
    assert.match(role.dailyShareSeedPrompt, /不要重复最近的模式/);
    assert.match(role.timeAdvancementPrompt, /current_plan 只写接下来几小时的现实生活安排/);
  });

  it("carries the same anti-repetition rules in generic hardcoded fallbacks", () => {
    const generic = getGenericRolePromptDefaults();
    assert.match(generic.chatHistoryIntro, /已经说过的提醒、状态和计划/);
    assert.match(generic.sceneletInstructions, /visible_reply 是角色在当前聊天中实际发送的自然回复/);
    assert.match(generic.dailyShareSeedPrompt, /催睡催出门/);
    assert.match(generic.timeAdvancementPrompt, /不写回复用户等聊天动作/);
  });
});
