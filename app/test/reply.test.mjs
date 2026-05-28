import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitText, hasInboundAttachment, isInfoSeekingTurn, chooseReplyBudget, constrainCasualReply, isStructuredReply, splitSocialReply, localTimePeriod, formatLocalChatReality, buildStylePrompt, normalizeTerminology, terminologyPrompt, loadTerminologyConfig, expressionCapabilityPrompt } from "../lib/reply.mjs";

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

  it("includes chat reality in the style prompt", () => {
    const text = buildStylePrompt([], "早上好", { instruction: "短", maxChars: 20, maxParts: 1, enforce: true });
    assert.match(text, /【当前聊天现实】/u);
    assert.match(text, /【本轮回复长度签】/u);
  });
});

describe("terminology", () => {
  it("loads editable terminology config", () => {
    const config = loadTerminologyConfig();
    assert.ok(config.promptRules.some(rule => rule.includes("PasPale")));
    assert.ok(config.replacements.some(rule => rule.replace === "伊芙"));
  });

  it("normalizes unwanted PasPale transliterations", () => {
    assert.equal(normalizeTerminology("帕斯帕雷今天也很可爱"), "PasPale今天也很可爱");
    assert.equal(normalizeTerminology("帕斯帕莱"), "PasPale");
  });

  it("normalizes unwanted Eve names for Wakamiya Eve", () => {
    assert.equal(normalizeTerminology("eve今天也在说武士道"), "伊芙今天也在说武士道");
    assert.equal(normalizeTerminology("Eve和日菜"), "伊芙和日菜");
  });

  it("adds terminology guidance to the style prompt", () => {
    assert.match(terminologyPrompt(), /Pastel\*Palettes/u);
    assert.match(terminologyPrompt(), /伊芙/u);
    const text = buildStylePrompt([], "paspale", { instruction: "短", maxChars: 20, maxParts: 1, enforce: true });
    assert.match(text, /【术语规范】/u);
    assert.match(text, /不要写“帕斯帕雷”“帕斯帕莱”/u);
  });
});

describe("expression capability", () => {
  it("adds expression capability guidance to the style prompt", () => {
    assert.match(expressionCapabilityPrompt(), /\[旺柴\]/u);
    const text = buildStylePrompt([], "哈哈[旺柴]", { instruction: "短", maxChars: 20, maxParts: 1, enforce: true });
    assert.match(text, /【表情能力】/u);
    assert.match(text, /不能主动发送微信内置表情包占位文本/u);
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
