import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  splitText,
  hasInboundAttachment,
  isStructuredReply,
  splitSocialReply,
  localTimePeriod,
  formatLocalChatReality,
  expressionCapabilityPrompt,
} from "../lib/reply.mjs";

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

describe("local chat reality", () => {
  it("classifies deep night periods", () => {
    assert.equal(localTimePeriod(new Date(2026, 4, 28, 2, 13)), "凌晨");
    assert.equal(localTimePeriod(new Date(2026, 4, 28, 23, 13)), "深夜");
  });

  it("formats local time and action guidance", () => {
    const text = formatLocalChatReality(new Date(2026, 4, 28, 2, 13));
    assert.match(text, /当前本地时间：2026-05-28 02:13，星期四，凌晨。/u);
    assert.match(text, /微信私聊/u);
    assert.match(text, /不确定时可以不用动作/u);
  });
});

describe("expression capability", () => {
  it("describes allowed expression surface", () => {
    const text = expressionCapabilityPrompt();
    assert.match(text, /\[旺柴\]/u);
    assert.match(text, /不能主动发送微信内置表情包占位文本/u);
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
  it("returns at least one part", () => {
    const r = splitSocialReply("Short reply.");
    assert.ok(Array.isArray(r));
    assert.ok(r.length >= 1);
  });
});
