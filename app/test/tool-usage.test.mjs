import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toolUsageFromUsage } from "../lib/claude-runner.mjs";
import { mergeToolUsage } from "../lib/normalize.mjs";

describe("tool usage aggregation", () => {
  it("reads hidden WebSearch counts from modelUsage", () => {
    assert.deepEqual(toolUsageFromUsage({
      usage: {},
      modelUsage: {
        first: { webSearchRequests: 1 },
        fallback: { webSearchRequests: 2 },
      },
    }), {
      webSearch: 3,
      webFetch: 0,
      tools: ["WebSearch"],
    });
  });

  it("merges hidden and visible tool usage without duplicating tool names", () => {
    assert.deepEqual(mergeToolUsage(
      { webSearch: 1, webFetch: 0, tools: ["WebSearch"] },
      { webSearch: 2, webFetch: 1, tools: ["WebSearch", "WebFetch"] },
    ), {
      webSearch: 3,
      webFetch: 1,
      tools: ["WebSearch", "WebFetch"],
    });
  });
});
