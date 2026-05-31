import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitText, hasInboundAttachment, isInfoSeekingTurn, isCasualQuestionTurn, chooseReplyBudget, constrainCasualReply, needsReplyCondense, isStructuredReply, splitSocialReply, localTimePeriod, formatLocalChatReality, buildStylePrompt, normalizeTerminology, terminologyPrompt, loadTerminologyConfig, expressionCapabilityPrompt, extractRhetoricalPatterns, rememberRecentRhetoricalPatterns } from "../lib/reply.mjs";

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
    assert.equal(isInfoSeekingTurn("小千圣呀，你周日准备怎么度过呢？"), false);
    assert.equal(isInfoSeekingTurn("我不说，你可以猜猜她们写了什么，猜猜我的感觉？"), false);
    assert.equal(isInfoSeekingTurn("[引用: 不过你说\"实在太明显\"——对谁明显？]\n是在夸你哦"), false);
  });
});

describe("isCasualQuestionTurn", () => {
  it("keeps role-chat questions casual", () => {
    assert.equal(isCasualQuestionTurn("去咖啡店兼职？小千圣会被认出来吗"), true);
    assert.equal(isCasualQuestionTurn("怎么修这个bug?"), false);
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

describe("rhetorical pattern memory", () => {
  it("detects AI-sounding rhetorical patterns", () => {
    const patterns = extractRhetoricalPatterns("这一步，很多人一辈子迈不出来。不是逃避，而是清醒。");
    assert.ok(patterns.some(item => item.key === "contrast"));
    assert.ok(patterns.some(item => item.key === "grandComparison"));
  });

  it("adds a temporary reminder only for casual replies", () => {
    const sess = {};
    rememberRecentRhetoricalPatterns(sess, "这一点，足够珍贵。");
    const casual = buildStylePrompt([], "嗯嗯", { instruction: "短", maxChars: 20, maxParts: 1, enforce: true }, sess._recentRhetoricalPatterns);
    const task = buildStylePrompt([], "怎么修这个报错？", { instruction: "正常说明", maxChars: 220, maxParts: 2, enforce: false }, sess._recentRhetoricalPatterns);
    assert.match(casual, /【近期表达提醒】/u);
    assert.doesNotMatch(task, /【近期表达提醒】/u);
  });
});

describe("constrainCasualReply", () => {
  it("passes through when enforce is false", () => {
    const r = constrainCasualReply("a long reply here", { enforce: false, maxChars: 5 });
    assert.equal(r, "a long reply here");
  });
  it("keeps complete sentence units instead of cutting mid-sentence", () => {
    const r = constrainCasualReply("第一句完整但是比较长。第二句应该被删掉。", { enforce: true, maxChars: 10, maxParts: 1 });
    assert.equal(r, "第一句完整但是比较长。");
  });
  it("detects replies that should be condensed before sending", () => {
    assert.equal(needsReplyCondense("第一句完整但是比较长。第二句继续展开很多。第三句又开始总结升华。第四句继续补充很多心理分析和漂亮收束。第五句还是没有停下来。", { enforce: true, maxChars: 20, maxParts: 1 }), true);
    assert.equal(needsReplyCondense("短短一句。", { enforce: true, maxChars: 20, maxParts: 1 }), false);
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
