import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const bot = readFileSync(join(import.meta.dirname, "..", "bot.mjs"), "utf-8");
const claudeRunner = readFileSync(join(import.meta.dirname, "..", "lib", "claude-runner.mjs"), "utf-8");
const backendAdapter = readFileSync(join(import.meta.dirname, "..", "lib", "backend-adapter.mjs"), "utf-8");
const prompts = readFileSync(join(import.meta.dirname, "..", "lib", "prompts.mjs"), "utf-8");

describe("prompt cache layout", () => {
  it("keeps memory out of the default stable Claude system prompt", () => {
    assert.match(claudeRunner, /options\.includeMemoryInSystem === true/);
    assert.doesNotMatch(claudeRunner, /options\.includeMemoryInSystem !== false/);
  });

  it("keeps memory out of the dynamic turn body and opts into the Claude system prompt", () => {
    assert.match(prompts, /async function buildTurnBody\(userBody, sceneContext = "", visibleHistory = \[\], sceneMemory = "", profile = ""\)/);
    assert.doesNotMatch(prompts, /buildTurnBody\([^)]*memoryPrompt/);
    assert.match(bot, /startBackendChat\(/);
    assert.match(backendAdapter, /includeMemoryInSystem: true/);
  });

  it("does not count memory as stable system prompt chars", () => {
    assert.doesNotMatch(claudeRunner, /stableSystemChars: stylePrompt\.length \+ memoryPrompt\.length/);
  });
});
