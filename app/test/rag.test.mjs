import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldSkipRag, buildRagBody } from "../lib/rag.mjs";

describe("shouldSkipRag", () => {
  it("skips empty messages", () => {
    assert.ok(shouldSkipRag(""));
    assert.ok(shouldSkipRag("  "));
  });
  it("skips short greetings", () => {
    assert.ok(shouldSkipRag("早上好"));
    assert.ok(shouldSkipRag("晚安~"));
    assert.ok(shouldSkipRag("你好呀"));
    assert.ok(shouldSkipRag("哈哈"));
  });
  it("does not skip longer messages", () => {
    assert.equal(shouldSkipRag("今天CRYCHIC的排练怎么样"), false);
  });
  it("does not skip messages with content", () => {
    assert.equal(shouldSkipRag("长崎素世和丰川祥子是什么关系"), false);
  });
});

describe("buildRagBody", () => {
  it("returns user message unchanged when no context", () => {
    assert.equal(buildRagBody("hello", null), "hello");
    assert.equal(buildRagBody("hello", ""), "hello");
  });
  it("wraps context around user message", () => {
    const r = buildRagBody("user question", "relevant context");
    assert.ok(r.includes("user question"));
    assert.ok(r.includes("relevant context"));
    assert.ok(r.includes("可能相关的背景资料"));
  });
});
