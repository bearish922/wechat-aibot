import fs from "node:fs";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { addMemoryItem, clearMemory, shouldRunMemoryWriter, memoryListText, MEMORY_FILE } from "../lib/memory.mjs";

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
