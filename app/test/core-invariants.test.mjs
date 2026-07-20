// ─── 核心运行时不变性测试 ───
// 验证系统关键行为不会被意外破坏：重试路径、回复发送顺序、
// 角色场景层、Session 队列管理、路由状态码、历史元数据一致性等。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const bot = readFileSync(join(import.meta.dirname, "..", "bot.mjs"), "utf-8");
const commands = readFileSync(join(import.meta.dirname, "..", "lib", "commands.mjs"), "utf-8");
const history = readFileSync(join(import.meta.dirname, "..", "lib", "chat-history.mjs"), "utf-8");
const server = readFileSync(join(import.meta.dirname, "..", "lib", "server.mjs"), "utf-8");
const turn = readFileSync(join(import.meta.dirname, "..", "lib", "turn.mjs"), "utf-8");
const prompts = readFileSync(join(import.meta.dirname, "..", "lib", "prompts.mjs"), "utf-8");
const claudeRunner = readFileSync(join(import.meta.dirname, "..", "lib", "claude-runner.mjs"), "utf-8");
const claudeContext = readFileSync(join(import.meta.dirname, "..", "lib", "claude-context.mjs"), "utf-8");
const worldState = readFileSync(join(import.meta.dirname, "..", "lib", "world-state.mjs"), "utf-8");
const workEventGenerator = readFileSync(join(import.meta.dirname, "..", "lib", "work-event-generator.mjs"), "utf-8");

describe("core runtime invariants", () => {
  // 失败后仅允许一次即时重试，使用 _lastFailedTurn 标记防止无限循环
  it("allows one immediate retry after a failed turn", () => {
    assert.match(bot, /duplicate && sess\._lastFailedTurn\?\.body !== body/);
    assert.match(bot, /if \(duplicate\) sess\._lastFailedTurn = null/);
    assert.doesNotMatch(bot, /failedBody === body/);
  });

  // hidden-world 重试复用已有 session，不复用会创建孤立 session 并丢失状态连续性
  it("keeps hidden-world retries in the existing session", () => {
    const retryStart = turn.indexOf('label: "single_actor_retry"');
    const retryEnd = turn.indexOf("// 两次调用都无效", retryStart);
    const retryBlock = turn.slice(retryStart, retryEnd);
    assert.ok(retryStart >= 0 && retryEnd > retryStart);
    assert.match(turn, /reset is required before opening a new hidden-world session/);
    assert.match(turn, /findExactSessionFile\(world\.sid,\s*profile\)/);
    assert.doesNotMatch(turn, /findSessionFile\(world\.sid,\s*sessionName\)/);
    assert.match(turn, /sessionId: world\.sid/);
    assert.match(turn, /const retryPrompt = \[/);
    assert.match(turn, /上一次响应因输出格式不合法被丢弃/);
    assert.match(turn, /JSON\.parse 直接解析的 JSON 对象/);
    assert.match(turn, /runBackendStructured\(retryPrompt,\s*\{\s*\.\.\.structuredOptions,\s*label: "single_actor_retry"/);
    assert.match(turn, /let retryFirstTurn = firstAttemptWasFirstTurn/);
    assert.match(turn, /fs\.rmSync\(createdSessionFile, \{ force: true \}\)/);
    assert.match(retryBlock, /firstTurn: retryFirstTurn/);
    assert.doesNotMatch(turn.slice(retryEnd, turn.indexOf("// ⑤ 更新 world session 元数据", retryEnd)), /world\.sid\s*=\s*uuid\(|world\.firstTurn\s*=\s*true/);
  });

  it("rejects unexpected SID changes", () => {
    assert.match(turn, /Actor backend changed SID unexpectedly/);
    assert.match(claudeRunner, /outer\.result \|\| outer\.message \|\| outer\.text \|\| stdout/);
  });

  it("protects persisted Actor state and active session files", () => {
    assert.match(worldState, /SID is missing; reset is required before opening a new session/);
    assert.doesNotMatch(worldState, /if \(!sess\._worldSessions\[provider\]\.sid\)[\s\S]*uuid\(\)/);
    assert.match(worldState, /fs\.renameSync\(tempFile, ROLE_WORLD_FILE\)/);
    assert.match(worldState, /refusing to replace it/);
    assert.match(claudeContext, /protectedSessionIds/);
    assert.match(claudeContext, /protectedIds\.has\(fileSessionId\)/);
    assert.match(bot, /Actor reset blocked: scene memory generation returned empty/);
    assert.match(bot, /if \(!saveRoleWorlds\(\)\)/);
    assert.match(turn, /const recentScenelets = memoryEvents/);
    assert.doesNotMatch(turn, /filter\(e => e\.userId === userId && e\.profile === profile && e\.role === "assistant" && e\.scenelet\)\s*\.slice\(-5\)/);
  });

  it("keeps the 1M alias on Claude Code while stripping it only for direct API calls", () => {
    assert.doesNotMatch(claudeRunner, /function cleanModelForProfile/);
    assert.match(claudeRunner, /const selectedModel = model \|\| CLAUDE_MAIN_MODEL/);
    assert.match(claudeRunner, /args\.push\("--model", CLAUDE_MAIN_MODEL\)/);
    assert.match(claudeRunner, /function apiModelName\(model\)/);
    assert.ok(claudeRunner.includes('return String(model || CLAUDE_MAIN_MODEL).replace(/\\[.*\\]$/, "");'));
  });

  it("resets the shared Actor session from context pressure with turn fallback", () => {
    assert.match(bot, /const actorTurnCount = actorSession\?\.turnCount \|\| 0/);
    assert.match(bot, /shouldResetActorSession\(\{/);
    assert.match(bot, /ratioThreshold: sceneCfg\.contextResetRatio \?\? 0\.5/);
    assert.match(bot, /if \(resetDecision\.shouldReset\)/);
    assert.match(bot, /reason === "context"/);
    assert.doesNotMatch(bot, /if \(styleState\._turnCount >= threshold\)/);
  });

  it("extends scene memory injection only for the dream Chisato roleplay profile", () => {
    assert.match(turn, /const sceneMemoryTurns = profile === "梦中的千圣" \? 25 : 15/);
    assert.match(turn, /\(world\.turnCount \|\| 0\) < sceneMemoryTurns/);
  });

  it("registers the schedule timer unconditionally and commits against current world state", () => {
    assert.match(bot, /const runWorkEventTick = \(\) => runWorkEventGenerator\(\)/);
    assert.match(bot, /runWorkEventTick\(\);\s*setInterval\(runWorkEventTick, WORK_EVENT_GEN_INTERVAL_MS\)/);
    assert.doesNotMatch(bot, /if \(hasEnabledRoles\(\)\)/);
    assert.match(workEventGenerator, /config\.generationIntervalMs \|\| 12 \* 3600000/);
    assert.match(workEventGenerator, /const currentArcs = normalizeLifeArcs\(roleWorld\._lifeArcs/);
    assert.match(workEventGenerator, /const applyResult = applyLifeArcOps\(roleWorld, \[lifeArcOp\], \{ workEventConfig: config \}\)/);
    assert.match(workEventGenerator, /if \(!applyResult\.applied\)/);
    assert.doesNotMatch(workEventGenerator, /_pendingGeneratedEvents\.push/);
  });

  it("has no stale stable chatstyle reference in the single-Actor path", () => {
    assert.doesNotMatch(bot, /stableChatStyle|stableStyle/);
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
    assert.match(bot, /if \(useSceneletAsReply\)/);
    assert.match(bot, /throw new Error\(sceneletError \|\| "single actor returned no valid inner_scenelet and visible_reply"\)/);
    assert.doesNotMatch(bot, /stylePrompt: stableStyle/);
    assert.match(bot, /const startChatAttempt = \(sessionId, isFirstTurn\) => startBackendChat/);
    assert.match(turn, /if \(!loadPrompts\(profile\)\.runtimePolicy\.lifeArcEnabled\) return \[\];/);
    assert.match(turn, /if \(!loadPrompts\(profile\)\.runtimePolicy\.lifeArcEnabled\) return false;/);
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
    const sceneletAt = bot.indexOf("sceneletResult = await generateSingleActorReply", sharedHistoryAt);
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
    assert.match(turn, /`\$\{profile \|\| "角色"\}的实际回复：`/);
  });
});
