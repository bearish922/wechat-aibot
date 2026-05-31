import fs from "node:fs";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { addMemoryItem, buildMemoryWriterPrompt, buildMemoryWriterSystemPrompt, clearMemory, parseMemoryWriterOutput, shouldRunMemoryWriter, memoryListText, MEMORY_FILE } from "../lib/memory.mjs";

const TEST_USER = "test_memory_user";
const TEST_ROLE = "__default__";
const ROLE_A = "千早爱音";
const ROLE_B = "长崎素世";

let originalMemory = null;

before(() => {
  originalMemory = fs.existsSync(MEMORY_FILE) ? fs.readFileSync(MEMORY_FILE, "utf-8") : null;
});

after(() => {
  if (originalMemory === null) {
    if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);
  } else {
    fs.writeFileSync(MEMORY_FILE, originalMemory, "utf-8");
  }
});

describe("shouldRunMemoryWriter", () => {
  it("lets the AI writer judge ordinary user messages", () => {
    assert.equal(shouldRunMemoryWriter("我在学习和练习架子鼓"), true);
    assert.equal(shouldRunMemoryWriter("哈哈"), true);
  });

  it("skips empty input and commands", () => {
    assert.equal(shouldRunMemoryWriter("   "), false);
    assert.equal(shouldRunMemoryWriter("/memory"), false);
  });
});

describe("buildMemoryWriterPrompt", () => {
  it("guides the writer toward durable user memory without saving chat residue", () => {
    // use a test user so it doesn't pick up real memory from 白鹭千圣
    const prompt = buildMemoryWriterPrompt("我不希望你每次都夸我", TEST_USER, TEST_ROLE);
    assert.match(prompt, /审慎的人类助手/u);
    assert.match(prompt, /宠物\/长期陪伴对象/u);
    assert.match(prompt, /回复方式的长期偏好/u);
    assert.match(prompt, /实习、转正、求职/u);
    assert.match(prompt, /单次歌曲\/作品即时反应/u);
    assert.match(prompt, /饭点\/天气\/通勤\/犯困/u);
    assert.match(prompt, /只抽取稳定信息写入/u);
    assert.match(prompt, /不要推断用户能力、性格缺陷、岗位适配性/u);
    assert.match(prompt, /用户消息：/u);
  });

  it("can render instructions separately for a system prompt file", () => {
    const prompt = buildMemoryWriterSystemPrompt(TEST_USER, TEST_ROLE);
    assert.match(prompt, /独立的长期记忆写入器/u);
    assert.doesNotMatch(prompt, /\n用户消息：\n/u);
  });
});

describe("parseMemoryWriterOutput", () => {
  it("parses the first JSON object when stream-json duplicates result text", () => {
    const raw = "{\"ops\":[{\"op\":\"add\",\"category\":\"trait\",\"text\":\"用户自认情绪稳定\",\"sensitive\":false}]}{\"ops\":[{\"op\":\"add\"}]}";
    const ops = parseMemoryWriterOutput(raw);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].text, "用户自认情绪稳定");
  });
});

describe("per-role memory isolation", () => {
  it("stores and retrieves memory per role, isolated from other roles", () => {
    clearMemory(TEST_USER, TEST_ROLE);
    clearMemory(TEST_USER, ROLE_A);
    clearMemory(TEST_USER, ROLE_B);

    // add to role A
    addMemoryItem(TEST_USER, ROLE_A, "偏好", "用户喜欢黄瓜味薯片");
    addMemoryItem(TEST_USER, ROLE_A, "偏好", "用户喜欢晚上学习");

    // add to role B
    addMemoryItem(TEST_USER, ROLE_B, "偏好", "用户偏好短回复");
    addMemoryItem(TEST_USER, ROLE_B, "偏好", "用户喜欢练习架子鼓");

    // role A sees only its own items
    const summaryA = memoryListText(TEST_USER, { profile: ROLE_A });
    assert.match(summaryA, /黄瓜味薯片/u);
    assert.match(summaryA, /晚上学习/u);
    assert.doesNotMatch(summaryA, /偏好短回复/u);
    assert.doesNotMatch(summaryA, /架子鼓/u);

    // role B sees only its own items
    const summaryB = memoryListText(TEST_USER, { profile: ROLE_B });
    assert.match(summaryB, /偏好短回复/u);
    assert.match(summaryB, /架子鼓/u);
    assert.doesNotMatch(summaryB, /黄瓜味薯片/u);
    assert.doesNotMatch(summaryB, /晚上学习/u);

    // default role sees nothing
    const summaryDefault = memoryListText(TEST_USER, { profile: TEST_ROLE });
    assert.match(summaryDefault, /暂无记录/u);
  });
});

describe("memoryListText", () => {
  it("limits the default view and shows the full view on request", () => {
    clearMemory(TEST_USER, TEST_ROLE);
    addMemoryItem(TEST_USER, TEST_ROLE, "偏好", "用户喜欢黄瓜味薯片");
    addMemoryItem(TEST_USER, TEST_ROLE, "偏好", "用户喜欢晚上学习");
    addMemoryItem(TEST_USER, TEST_ROLE, "偏好", "用户偏好短回复");
    addMemoryItem(TEST_USER, TEST_ROLE, "偏好", "用户喜欢练习架子鼓");

    const summary = memoryListText(TEST_USER, { profile: TEST_ROLE });
    assert.match(summary, /偏好: 4 条/u);
    assert.match(summary, /\.\.\. 另 1 条/u);
    assert.doesNotMatch(summary, /用户喜欢练习架子鼓/u);

    const full = memoryListText(TEST_USER, { profile: TEST_ROLE, full: true });
    assert.match(full, /用户喜欢练习架子鼓/u);

    const onlyPreference = memoryListText(TEST_USER, { profile: TEST_ROLE, category: "偏好", full: true });
    assert.match(onlyPreference, /【偏好】/u);
    assert.doesNotMatch(onlyPreference, /【事实】/u);
  });
});
