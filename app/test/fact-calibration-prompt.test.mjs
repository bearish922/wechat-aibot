import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadPrompts } from "../lib/reply.mjs";

describe("Fact calibration prompt contract", () => {
  it("separates public facts from virtual private experience", () => {
    const runtime = loadPrompts("白鹭千圣");
    assert.match(runtime.chatStyle, /具体断言逐项判断/);
    assert.match(runtime.chatStyle, /公共世界骨架/);
    assert.match(runtime.chatStyle, /小彩拿到歌词时脸红/);
    assert.match(runtime.chatStyle, /搜索只用于内部校准/);

    assert.match(runtime.sceneletInstructions, /公共硬事实/);
    assert.match(runtime.sceneletInstructions, /公共解释/);
    assert.match(runtime.sceneletInstructions, /虚拟私人经历/);
    assert.match(runtime.sceneletInstructions, /水無月、自由之丘或日本粽子/);
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
    assert.match(runtime.sceneletReplyBridgeInstruction, /公共事实走 WebSearch\/WebFetch 校准/);
    assert.match(runtime.sceneletReplyBridgeInstruction, /不影响回复体裁/);

    const obsoleteHardTrigger = /用户明确要求或建议搜索时必须实际调用/;
    assert.doesNotMatch(runtime.chatStyle, obsoleteHardTrigger);
    assert.doesNotMatch(runtime.sceneletInstructions, obsoleteHardTrigger);
  });
});
