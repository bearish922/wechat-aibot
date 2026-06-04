import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldSkipRag } from "../lib/rag.mjs";

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
