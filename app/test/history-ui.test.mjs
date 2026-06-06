import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appJs = readFileSync(join(import.meta.dirname, "..", "static", "app.js"), "utf-8");
const chatHistory = readFileSync(join(import.meta.dirname, "..", "lib", "chat-history.mjs"), "utf-8");

describe("History tool usage UI", () => {
  it("renders a small missing-scenelet note for assistant messages", () => {
    assert.match(appJs, /function renderHistorySceneletNote/);
    assert.match(appJs, /Scenelet: missing/);
    assert.match(appJs, /renderHistorySceneletNote\(item\)/);
    assert.match(chatHistory, /sceneletStatus: event\.sceneletStatus/);
    assert.match(chatHistory, /sceneletError: event\.sceneletError/);
  });

  it("renders a small WebSearch note for assistant messages", () => {
    assert.match(appJs, /function renderHistoryToolNote/);
    assert.match(appJs, /WebSearch: not recorded/);
    assert.match(appJs, /WebSearch: \$\{searched \? "yes" : "no"\}/);
    assert.match(appJs, /RAG: not recorded/);
    assert.match(appJs, /RAG: \$\{rag\.used \? "yes" : "no"\}/);
    assert.match(appJs, /renderHistoryToolNote\(item\)/);
  });

  it("persists tool usage metadata in chat history", () => {
    assert.match(chatHistory, /function normalizeToolUsage/);
    assert.match(chatHistory, /function normalizeRagUsage/);
    assert.match(chatHistory, /toolUsage: normalizeToolUsage\(event\.toolUsage\)/);
    assert.match(chatHistory, /ragUsage: normalizeRagUsage\(event\.ragUsage\)/);
  });
});
