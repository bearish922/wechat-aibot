import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  contextPressureForUsage,
  shouldResetActorSession,
} from "../lib/context-pressure.mjs";
import { codexUsageFromTokenCountInfo } from "../lib/codex-session-usage.mjs";

describe("context pressure reset policy", () => {
  it("uses Claude-style cache fields as visible context pressure", () => {
    assert.deepEqual(contextPressureForUsage({
      input_tokens: 100,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 50,
      output_tokens: 25,
      model_context_window: 1000,
    }, "cc"), {
      tokens: 475,
      max: 1000,
      ratio: 0.475,
      known: true,
    });
  });

  it("uses Codex last usage without billing-style totals", () => {
    const decision = shouldResetActorSession({
      backend: "codex",
      usage: {
        input_tokens: 86821,
        cache_read_input_tokens: 82816,
        output_tokens: 405,
        total_input_tokens: 944733,
        total_output_tokens: 10197,
        model_context_window: 258400,
      },
      turnCount: 17,
      turnThreshold: 30,
      ratioThreshold: 0.5,
    });

    assert.equal(decision.tokens, 87226);
    assert.equal(decision.max, 258400);
    assert.equal(Number(decision.ratio.toFixed(3)), 0.338);
    assert.equal(decision.shouldReset, false);
  });

  it("normalizes raw Codex token_count info to current context usage", () => {
    const usage = codexUsageFromTokenCountInfo({
      total_token_usage: {
        input_tokens: 944733,
        cached_input_tokens: 622976,
        output_tokens: 10197,
        reasoning_output_tokens: 4054,
      },
      last_token_usage: {
        input_tokens: 86821,
        cached_input_tokens: 82816,
        output_tokens: 405,
        reasoning_output_tokens: 94,
      },
      model_context_window: 258400,
    });

    assert.equal(usage.input_tokens + usage.output_tokens, 87226);
    assert.equal(usage.total_input_tokens + usage.total_output_tokens, 954930);
    assert.equal(usage.model_context_window, 258400);
  });

  it("resets at the configured context ratio before the fallback turn threshold", () => {
    const decision = shouldResetActorSession({
      backend: "codex",
      usage: {
        input_tokens: 129200,
        output_tokens: 1,
        model_context_window: 258400,
      },
      turnCount: 18,
      turnThreshold: 30,
      ratioThreshold: 0.5,
    });

    assert.equal(decision.shouldReset, true);
    assert.equal(decision.reason, "context");
  });

  it("falls back to the turn threshold only when pressure is unknown", () => {
    const decision = shouldResetActorSession({
      backend: "codex",
      usage: null,
      turnCount: 30,
      turnThreshold: 30,
      ratioThreshold: 0.5,
    });

    assert.equal(decision.shouldReset, true);
    assert.equal(decision.reason, "turns");
  });
});
