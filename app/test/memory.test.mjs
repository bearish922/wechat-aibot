import fs from "node:fs";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { addMemoryItem, buildMemoryWriterPrompt, buildMemoryWriterSystemPrompt, clearMemory, parseMemoryWriterOutput, shouldRunMemoryWriter, memoryListText, MEMORY_FILE } from "../lib/memory.mjs";

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
    const prompt = buildMemoryWriterPrompt("我不希望你每次都夸我", "");
    assert.match(prompt, /审慎的人类助手/u);
    assert.match(prompt, /宠物\/长期陪伴对象/u);
    assert.match(prompt, /回复方式的长期偏好/u);
    assert.match(prompt, /实习、转正、求职/u);
    assert.match(prompt, /单次歌曲\/作品即时反应/u);
    assert.match(prompt, /饭点\/天气\/通勤\/犯困/u);
    assert.match(prompt, /只抽取稳定信息写入/u);
    assert.match(prompt, /不要推断用户能力、性格缺陷、岗位适配性/u);
    assert.match(prompt, /用户有一只猫，名叫盼盼/u);
    assert.match(prompt, /用户不希望每次回复都被夸奖/u);
    assert.match(prompt, /用户目前处在实习、转正、求职相关阶段/u);
  });

  it("can render instructions separately for a system prompt file", () => {
    const prompt = buildMemoryWriterSystemPrompt("");
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

describe("memoryListText", () => {
  it("limits the default view and shows the full view on request", () => {
    const userId = "test_memory_display";
    clearMemory(userId);
    addMemoryItem(userId, "偏好", "用户喜欢黄瓜味薯片");
    addMemoryItem(userId, "偏好", "用户喜欢晚上学习");
    addMemoryItem(userId, "偏好", "用户偏好短回复");
    addMemoryItem(userId, "偏好", "用户喜欢练习架子鼓");

    const summary = memoryListText(userId);
    assert.match(summary, /偏好: 4 条/u);
    assert.match(summary, /\.\.\. 另 1 条/u);
    assert.doesNotMatch(summary, /用户喜欢练习架子鼓/u);

    const full = memoryListText(userId, { full: true });
    assert.match(full, /用户喜欢练习架子鼓/u);

    const onlyPreference = memoryListText(userId, { category: "偏好", full: true });
    assert.match(onlyPreference, /【偏好】/u);
    assert.doesNotMatch(onlyPreference, /【事实】/u);
  });
});
