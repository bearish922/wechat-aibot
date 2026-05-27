import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitText, hasInboundAttachment, isInfoSeekingTurn, chooseReplyBudget, constrainCasualReply, isStructuredReply, splitSocialReply } from "../lib/reply.mjs";

describe("splitText", () => {
  it("returns single element for short text", () => {
    assert.deepEqual(splitText("hello", 100), ["hello"]);
  });
  it("splits long text at maxLen", () => {
    const r = splitText("abcdefghij", 5);
    assert.ok(r.length >= 2);
  });
});

describe("hasInboundAttachment", () => {
  it("detects image marker", () => {
    assert.ok(hasInboundAttachment("[图片]\nsome text"));
  });
  it("returns false for plain text", () => {
    assert.equal(hasInboundAttachment("hello world"), false);
  });
});

describe("isInfoSeekingTurn", () => {
  it("detects questions", () => {
    assert.ok(isInfoSeekingTurn("怎么修这个bug?"));
    assert.ok(isInfoSeekingTurn("为什么代码报错"));
  });
  it("returns false for casual chat", () => {
    assert.equal(isInfoSeekingTurn("今天天气真好"), false);
  });
});

describe("chooseReplyBudget", () => {
  it("returns budget object for casual", () => {
    const b = chooseReplyBudget("今天天气真好");
    assert.ok(b.instruction);
    assert.ok(typeof b.maxChars === "number");
    assert.ok(b.maxChars > 0);
  });
  it("returns budget for info-seeking", () => {
    const b = chooseReplyBudget("怎么修这个bug");
    assert.equal(b.enforce, false);
  });
  it("enforces casual budgets", () => {
    const b = chooseReplyBudget("哈哈");
    assert.equal(b.enforce, true);
  });
});

describe("constrainCasualReply", () => {
  it("passes through when enforce is false", () => {
    const r = constrainCasualReply("a long reply here", { enforce: false, maxChars: 5 });
    assert.equal(r, "a long reply here");
  });
  it("truncates when enforce is true and over budget", () => {
    const r = constrainCasualReply("this is way too long for the budget allowed", { enforce: true, maxChars: 10, maxParts: 1 });
    assert.ok(r.length <= 12); // 10 + "..."
  });
});

describe("isStructuredReply", () => {
  it("detects code blocks", () => {
    assert.ok(isStructuredReply("```\ncode\n```"));
  });
  it("returns false for plain chat", () => {
    assert.equal(isStructuredReply("hey there"), false);
  });
});

describe("splitSocialReply", () => {
  it("returns single element for short text", () => {
    const r = splitSocialReply("Short reply.");
    assert.ok(Array.isArray(r));
    assert.ok(r.length >= 1);
  });
});
