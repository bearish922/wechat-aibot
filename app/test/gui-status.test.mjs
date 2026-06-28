import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeContextTranscript } from "../lib/claude-context.mjs";

const statusSource = readFileSync(join(import.meta.dirname, "..", "lib", "gui-status.mjs"), "utf-8");
const pressureSource = readFileSync(join(import.meta.dirname, "..", "lib", "context-pressure.mjs"), "utf-8");
const appSource = readFileSync(join(import.meta.dirname, "..", "static", "app.js"), "utf-8");

describe("GUI context status", () => {
  it("uses in-memory world session usage as the primary context source", () => {
    assert.match(statusSource, /const usage = worldSession\?\.lastUsage/);
    assert.match(statusSource, /contextTokens\(usage, activeAI\)/);
    assert.match(pressureSource, /usage\.input_tokens/);
    assert.match(pressureSource, /usage\.cache_read_input_tokens/);
    assert.match(pressureSource, /usage\.cache_creation_input_tokens/);
    assert.match(pressureSource, /usage\.output_tokens/);
    assert.match(pressureSource, /backend === "codex" \|\| backend === "api"/);
    assert.match(statusSource, /activeAI === "codex"/);
    assert.match(statusSource, /repairCodexUsageFromSession/);
    assert.match(statusSource, /contextTokensForUsage\(usage, backend\)/);
    assert.match(statusSource, /contextWindowForUsage\(usage, cfgMax\)/);
    assert.match(statusSource, /contextTokens\(uu, activeAI\)/);
    assert.match(statusSource, /contextTokens\(wu, activeAI\)/);
    assert.doesNotMatch(statusSource, /total_input_tokens/);
    assert.match(statusSource, /roleWorld\?\._worldSessions\?\.\[activeAI\]/);
    assert.match(pressureSource, /return reported > 0 \? reported : \(Number\(fallback \|\| 0\) \|\| 0\)/);
    assert.doesNotMatch(statusSource, /Math\.max\(mcw, cfgMax\)/);
    assert.match(statusSource, /turnCount: worldSession\?\.turnCount \|\| activeSess\._turnCount \|\| 0/);
    assert.match(statusSource, /contextResetRatio: cfg\.contextResetRatio/);
  });

  it("renders the active backend label instead of a hard-coded CC heading", () => {
    assert.match(appSource, /contextBackendLabel\(cc\)/);
    assert.match(appSource, /contextResetRule\(cc\)/);
    assert.match(appSource, /data-cc="resetRule"/);
    assert.match(appSource, /data-cc="title"/);
    assert.doesNotMatch(appSource, /<h2>CC Context/);
  });

  it("reports the completed-turn context and transcript prompt count", () => {
    const transcript = [
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 20, output_tokens: 80 } } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "first" } }),
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 150, cache_read_input_tokens: 1050, cache_creation_input_tokens: 0, output_tokens: 100 } } }),
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 150, cache_read_input_tokens: 1050, cache_creation_input_tokens: 0, output_tokens: 100 } } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "second" } }),
      JSON.stringify({ type: "last-prompt" }),
    ].join("\n");

    assert.deepEqual(parseClaudeContextTranscript(transcript), {
      tokens: 1300,
      inputTokens: 1200,
      outputTokens: 100,
      promptCount: 2,
    });
  });
});
