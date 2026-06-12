import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CHAT_STYLE,
  DEFAULT_SCENELET_INSTRUCTIONS,
  DEFAULT_RAG_CONTEXT_INSTRUCTION,
  DEFAULT_SCENELET_REPLY_BRIDGE_INSTRUCTION,
} from "../lib/default-prompts.mjs";
import { loadPrompts } from "../lib/reply.mjs";

describe("Fact calibration prompt contract", () => {
  it("separates public facts from virtual private experience", () => {
    const runtime = loadPrompts();
    for (const prompt of [DEFAULT_CHAT_STYLE, runtime.chatStyle]) {
      assert.match(prompt, /具体断言逐项判断/);
      assert.match(prompt, /公共世界骨架/);
      assert.match(prompt, /小彩拿到歌词时脸红/);
      assert.match(prompt, /搜索只用于内部校准/);
    }

    for (const prompt of [DEFAULT_SCENELET_INSTRUCTIONS, runtime.sceneletInstructions]) {
      assert.match(prompt, /公共硬事实/);
      assert.match(prompt, /公共解释/);
      assert.match(prompt, /虚拟私人经历/);
      assert.match(prompt, /水無月、自由之丘或日本粽子/);
      assert.match(prompt, /搜索是静默校准，不是回复体裁/);
    }
  });

  it("does not treat relevance or character confidence as evidence", () => {
    const runtime = loadPrompts();
    for (const prompt of [DEFAULT_SCENELET_INSTRUCTIONS, runtime.sceneletInstructions]) {
      assert.match(prompt, /RAG 只证明它实际写到的内容/);
      assert.match(prompt, /角色理应熟悉自己的作品/);
      assert.match(prompt, /不能代替核实/);
    }
    for (const prompt of [DEFAULT_RAG_CONTEXT_INSTRUCTION, runtime.ragContextInstruction]) {
      assert.match(prompt, /RAG 只支持正文直接写到的内容/);
      assert.match(prompt, /不代表它已经覆盖/);
    }
  });

  it("keeps search invisible in the final conversational style", () => {
    const runtime = loadPrompts();
    for (const prompt of [DEFAULT_SCENELET_REPLY_BRIDGE_INSTRUCTION, runtime.sceneletReplyBridgeInstruction]) {
      assert.match(prompt, /公共事实和虚拟私人经历可以在同一条回复里并存/);
      assert.match(prompt, /搜索只影响事实准确性，不改变回复体裁/);
      assert.match(prompt, /不要汇报检索过程/);
    }

    const obsoleteHardTrigger = /用户明确要求或建议搜索时必须实际调用/;
    assert.doesNotMatch(runtime.chatStyle, obsoleteHardTrigger);
    assert.doesNotMatch(runtime.sceneletInstructions, obsoleteHardTrigger);
  });
});
