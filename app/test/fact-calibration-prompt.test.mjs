import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadPrompts } from "../lib/reply.mjs";

describe("Fact calibration prompt contract", () => {
  it("separates public facts from virtual private experience", () => {
    const runtime = loadPrompts("白鹭千圣");
    assert.match(runtime.sceneletInstructions, /公共硬事实/);
    assert.match(runtime.sceneletInstructions, /公共解释/);
    assert.match(runtime.sceneletInstructions, /虚拟私人经历/);
    assert.match(runtime.sceneletInstructions, /搜索是静默校准，不是回复体裁/);
  });

  it("does not treat relevance or character confidence as evidence", () => {
    const runtime = loadPrompts("白鹭千圣");
    assert.match(runtime.sceneletInstructions, /RAG 只证明它实际写到的内容/);
    assert.match(runtime.sceneletInstructions, /角色理应熟悉自己的作品/);
    assert.match(runtime.sceneletInstructions, /不能代替核实/);
    assert.match(runtime.ragContextInstruction, /RAG 只支持正文直接写到的内容/);
    assert.match(runtime.ragContextInstruction, /不代表它已经覆盖/);
  });

  it("keeps search invisible in the final conversational style", () => {
    const runtime = loadPrompts("白鹭千圣");
    assert.match(runtime.sceneletInstructions, /搜索是静默校准，不是回复体裁/);
    assert.match(runtime.sceneletInstructions, /不在 inner_scenelet 或 visible_reply 里汇报过程/);

    const obsoleteHardTrigger = /用户明确要求或建议搜索时必须实际调用/;
    assert.doesNotMatch(runtime.sceneletInstructions, obsoleteHardTrigger);
  });
});
