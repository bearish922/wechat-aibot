import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const bot = readFileSync(join(process.cwd(), "bot.mjs"), "utf-8");

describe("prompt cache layout", () => {
  it("keeps memory out of the default stable Claude system prompt", () => {
    assert.match(bot, /options\.includeMemoryInSystem === true/);
    assert.doesNotMatch(bot, /options\.includeMemoryInSystem !== false/);
  });

  it("places memory at the front of the dynamic turn body", () => {
    assert.match(bot, /function buildTurnBody\(userBody, ragContext = "", sceneContext = "", memoryPrompt = ""\)/);
    assert.match(bot, /const sections = \[\];\s+const now = new Date\(\);\s+if \(memoryPrompt\) \{\s+sections\.push\(memoryPrompt\);/);
  });

  it("does not count memory as stable system prompt chars", () => {
    assert.doesNotMatch(bot, /stableSystemChars: stylePrompt\.length \+ memoryPrompt\.length/);
    assert.match(bot, /dynamicMemoryChars: memoryPrompt\.length/);
  });
});
