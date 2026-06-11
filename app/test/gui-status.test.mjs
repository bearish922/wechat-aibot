import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeContextTranscript } from "../lib/claude-context.mjs";

const statusSource = readFileSync(join(import.meta.dirname, "..", "lib", "gui-status.mjs"), "utf-8");

describe("GUI context status", () => {
  it("uses the Claude transcript as the primary accumulated context source", () => {
    assert.match(statusSource, /readClaudeSessionContext\(activeSess\.sid\)/);
    assert.match(statusSource, /usage\?\.input_tokens/);
    assert.match(statusSource, /usage\?\.cache_read_input_tokens/);
    assert.match(statusSource, /usage\?\.cache_creation_input_tokens/);
    assert.match(statusSource, /usage\?\.output_tokens/);
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
