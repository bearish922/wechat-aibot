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

describe("core runtime invariants", () => {
  it("allows one immediate retry after a failed turn", () => {
    assert.match(bot, /duplicate && sess\._lastFailedTurn\?\.body !== body/);
    assert.match(bot, /if \(duplicate\) sess\._lastFailedTurn = null/);
    assert.doesNotMatch(bot, /failedBody === body/);
  });

  it("persists a normal turn only after the complete reply was sent", () => {
    const sendAt = bot.indexOf("const sent = await sendFinalAssistantMessage");
    const successAt = bot.indexOf("turnSucceeded = true", sendAt);
    assert.ok(sendAt >= 0 && successAt > sendAt);
    assert.match(bot, /if \(!sent\) throw new Error\("failed to send complete reply to WeChat"\)/);
  });

  it("closes queued sessions without leaving an unreachable queue", () => {
    assert.match(commands, /target\.queue\.length = 0;\s*u\.list\.splice\(targetIdx, 1\)/);
  });

  it("uses route status values as HTTP response statuses", () => {
    assert.match(server, /json\(res, result, Number\(result\?\.status\) \|\| 200\)/);
  });

  it("keeps role-level history metadata tied to the latest row", () => {
    assert.match(history, /SELECT e2\.sessionName FROM events e2 WHERE e2\.sessionKey = e1\.sessionKey/);
    assert.match(history, /m\.timestamp >= ev\.timestamp/);
    assert.match(history, /msgs\[i\]\.timestamp <= ev\.timestamp/);
  });

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
