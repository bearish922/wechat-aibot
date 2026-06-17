// ─── 核心运行时不变性测试 ───
// 验证系统关键行为不会被意外破坏：重试路径、回复发送顺序、
// 角色场景层、Session 队列管理、路由状态码、历史元数据一致性等。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSceneContextBlock } from "../lib/turn.mjs";

const bot = readFileSync(join(import.meta.dirname, "..", "bot.mjs"), "utf-8");
const commands = readFileSync(join(import.meta.dirname, "..", "lib", "commands.mjs"), "utf-8");
const history = readFileSync(join(import.meta.dirname, "..", "lib", "chat-history.mjs"), "utf-8");
const server = readFileSync(join(import.meta.dirname, "..", "lib", "server.mjs"), "utf-8");
const turn = readFileSync(join(import.meta.dirname, "..", "lib", "turn.mjs"), "utf-8");
const prompts = readFileSync(join(import.meta.dirname, "..", "lib", "prompts.mjs"), "utf-8");

describe("core runtime invariants", () => {
  // 失败后仅允许一次即时重试，使用 _lastFailedTurn 标记防止无限循环
  it("allows one immediate retry after a failed turn", () => {
    assert.match(bot, /duplicate && sess\._lastFailedTurn\?\.body !== body/);
    assert.match(bot, /if \(duplicate\) sess\._lastFailedTurn = null/);
    assert.doesNotMatch(bot, /failedBody === body/);
  });

  // hidden-world 重试复用已有 session，不复用会创建孤立 session 并丢失状态连续性
  it("keeps hidden-world retries in the existing session", () => {
    const retryStart = turn.indexOf('label: "hidden_world_retry"');
    const retryEnd = turn.indexOf("if (!result?.innerScenelet) throw", retryStart);
    const retryBlock = turn.slice(retryStart, retryEnd);
    assert.ok(retryStart >= 0 && retryEnd > retryStart);
    assert.match(retryBlock, /sessionId: world\.sid/);
    assert.match(retryBlock, /firstTurn: false/);
    assert.doesNotMatch(retryBlock, /world\.sid\s*=\s*uuid\(|world\.firstTurn\s*=\s*true/);
  });

  // 只有完整回复成功发送后才标记 turnSucceeded，防止未送达的回复被当作成功
  it("persists a normal turn only after the complete reply was sent", () => {
    const sendAt = bot.indexOf("const sent = await sendFinalAssistantMessage");
    const successAt = bot.indexOf("turnSucceeded = true", sendAt);
    assert.ok(sendAt >= 0 && successAt > sendAt);
    assert.match(bot, /if \(!sent\) throw new Error\("failed to send complete reply to WeChat"\)/);
  });

  // 角色级别的 scenelet 回复路径不破坏默认主回复路径——两种模式通过 runtimePolicy.visibleReplySource 切换
  it("supports role-scoped scenelet replies without changing the default main reply path", () => {
    assert.match(bot, /runtimePolicy\.visibleReplySource === "scenelet"/);
    assert.match(bot, /assistantFullText = sceneletResult\?\.innerScenelet\?\.trim\(\) \|\| ""/);
    assert.match(bot, /return \{ turnSucceeded, assistantFullText, toolUsage, ragUsage, lastUsage \};\s*}\s*\/\/ (单 Actor|双阶段).*架构/);
    assert.match(bot, /const startChatAttempt = \(sessionId, isFirstTurn\) => startBackendChat/);
    assert.match(turn, /if \(!loadPrompts\(profile\)\.runtimePolicy\.lifeArcEnabled\) return \[\];/);
    assert.match(turn, /if \(!loadPrompts\(profile\)\.runtimePolicy\.lifeArcEnabled\) return false;/);
  });

  // sceneletTurnReminder 注入每轮 hidden-world turn 中，控制叙事节奏/长度
  it("injects role-scoped scenelet pacing guidance into every hidden-world turn", () => {
    assert.match(prompts, /turn_style_reminder: cfg\.runtimePolicy\.sceneletTurnReminder \|\| null/);
  });

  // 关闭排队 session 时清空队列并从列表移除，不留悬空队列条目
  it("closes queued sessions without leaving an unreachable queue", () => {
    assert.match(commands, /target\.queue\.length = 0;\s*u\.list\.splice\(targetIdx, 1\)/);
  });

  // 路由返回的状态值直接映射为 HTTP 响应状态码
  it("uses route status values as HTTP response statuses", () => {
    assert.match(server, /json\(res, result, Number\(result\?\.status\) \|\| 200\)/);
  });

  // 角色级别的历史元数据（sessionName）总是关联到最新一行，防止滞后
  it("keeps role-level history metadata tied to the latest row", () => {
    assert.match(history, /SELECT e2\.sessionName FROM events e2 WHERE e2\.sessionKey = e1\.sessionKey/);
    assert.match(history, /m\.timestamp >= ev\.timestamp/);
    assert.match(history, /msgs\[i\]\.timestamp <= ev\.timestamp/);
  });

  // 每轮开始前从统一 SQLite 历史表中恢复角色可见上下文，确保状态不丢失
  it("hydrates role visible context from shared SQLite history before each turn", () => {
    assert.match(history, /export async function loadRoleVisibleHistory\(userId, profile/);
    assert.match(history, /WHERE sessionKey = \? AND text != '' AND role IN \('user','assistant'\)/);
    assert.match(bot, /styleState\._visibleHistory = await loadRoleVisibleHistory\(userId, turnProfile\)/);
    const sharedHistoryAt = bot.indexOf("styleState._visibleHistory = await loadRoleVisibleHistory");
    const sceneletAt = bot.indexOf("sceneletResult = await generateSceneletForTurn", sharedHistoryAt);
    assert.ok(sharedHistoryAt >= 0 && sceneletAt > sharedHistoryAt);
  });

  // 提示词中角色名使用已选 profile 名称，不会混入其他角色
  it("uses the selected profile name in shared role prompts", () => {
    globalThis.__wechatRoleWorlds = new Map([
      ["丸山彩", {
        profile: "丸山彩",
        _lifeArcs: [{
          id: "arc-1",
          title: "录音安排",
          summary: "下午录音",
          status: "active",
          kind: "work",
          expiresAt: "2099-01-01T00:00:00.000Z",
        }],
      }],
    ]);
    const text = buildSceneContextBlock({ _profile: "丸山彩" }, { innerScenelet: "正在准备。" });
    assert.match(text, /丸山彩生活中跨越多天的安排/);
    assert.doesNotMatch(text, /千圣生活中跨越多天的安排/);
    assert.match(turn, /`\$\{profile \|\| "角色"\}的实际回复：`/);
  });
});
