import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  splitText,
  hasInboundAttachment,
  isStructuredReply,
  splitSocialReply,
  formatZonedTimeParts,
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

describe("time parts", () => {
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

  it("sends a standalone parenthetical action as its own message", () => {
    assert.deepEqual(
      splitSocialReply("粽子加白煮蛋，今天早饭合格。\n（Leo已经在玄关催我了。）"),
      ["粽子加白煮蛋，今天早饭合格。", "（Leo已经在玄关催我了。）"],
    );
  });

  it("keeps inline parentheses in the surrounding message", () => {
    assert.deepEqual(
      splitSocialReply("今天早饭合格（白煮蛋也算）。"),
      ["今天早饭合格（白煮蛋也算）。"],
    );
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
