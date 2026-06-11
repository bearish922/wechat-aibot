import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  splitText,
  hasInboundAttachment,
  isStructuredReply,
  splitSocialReply,
  formatZonedTimeParts,
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
  it("formats local time and action guidance", () => {
    const text = formatLocalChatReality(new Date(2026, 4, 28, 2, 13));
    assert.match(text, /当前用户侧时间：2026-05-28 02:13，星期四，凌晨（北京时间，Asia\/Shanghai）。/u);
    assert.match(text, /当前角色侧时间：2026-05-28 03:13，星期四，凌晨（东京时间，Asia\/Tokyo；角色所处时间以此为准）。/u);
    assert.match(text, /微信私聊/u);
    assert.match(text, /用户主动补充互动场景时，以其描述为准/u);
  });

  it("formats explicit Beijing and Tokyo time parts", () => {
    const date = new Date(2026, 4, 28, 23, 13);
    assert.deepEqual(formatZonedTimeParts(date, "Asia/Shanghai"), {
      stamp: "2026-05-28 23:13",
      weekday: "星期四",
      shortWeekday: "周四",
      period: "深夜",
      timeZone: "Asia/Shanghai",
    });
    assert.deepEqual(formatZonedTimeParts(date, "Asia/Tokyo"), {
      stamp: "2026-05-29 00:13",
      weekday: "星期五",
      shortWeekday: "周五",
      period: "凌晨",
      timeZone: "Asia/Tokyo",
    });
  });
});

describe("expression capability", () => {
  it("describes allowed expression surface", () => {
    const text = expressionCapabilityPrompt();
    assert.match(text, /\[旺柴\]/u);
    assert.match(text, /不能发送微信原生表情包/u);
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

  it("does not merge social beats into an artificial part count", () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const text = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n");
      const r = splitSocialReply(text);
      assert.ok(r.length > 6);
      assert.match(r.join("\n"), /line-7/);
      assert.match(r.join("\n"), /line-30/);
    } finally {
      Math.random = originalRandom;
    }
  });
});
