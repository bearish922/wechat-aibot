import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activeSessionEntriesForProfile } from "../lib/gui-world.mjs";

const appJs = readFileSync(join(import.meta.dirname, "..", "static", "app.js"), "utf-8");
const turn = readFileSync(join(import.meta.dirname, "..", "lib", "turn.mjs"), "utf-8");
const claudeRunner = readFileSync(join(import.meta.dirname, "..", "lib", "claude-runner.mjs"), "utf-8");
const guiWorld = readFileSync(join(import.meta.dirname, "..", "lib", "gui-world.mjs"), "utf-8");

describe("Hidden World pipeline UI", () => {
  it("exposes hidden-world prompts and parameters outside the main reply page", () => {
    for (const key of [
      "sceneletInstructions",
      "proactiveInstructions",
      "scheduleCreatorInstructions",
      "chatHistoryIntro",
      "innerSceneletIntro",
      "sceneletReplyBridgeInstruction",
    ]) {
      assert.match(appJs, new RegExp(`renderTextPreview\\("${key}"`), `${key} should be editable in Hidden World`);
    }
    // scheduleSpecialDates uses a dedicated calendar renderer
    assert.match(appJs, /renderScheduleCalendar/, "scheduleSpecialDates should be editable in Hidden World");
    for (const key of [
      "visibleContextTurns",
      "dailyShareSeedIntervalMs",
      "dailyShareMinIdleMs",
      "dailyShareDefaultScheduleOffsetMs",
      "dailyShareDefaultExpiryOffsetMs",
      "scheduleCheckIntervalMs",
      "scheduleFinalizationTimeoutMs",
      "scheduleRecentKindsLimit",
      "scheduleBasisMaxLength",
      "scheduleArcTitleMaxLength",
      "scheduleExpiryAfterEndBufferMs",
      "scheduleDefaultExpiryFromNowMs",
      "proactiveCheckIntervalMs",
      "proactiveCooldownMs",
      "proactiveDailyMax",
      "proactiveDefaultExpiryOffsetMs",
      "hiddenWorldMaxPendingIntents",
    ]) {
      assert.match(appJs, new RegExp(`renderNumberControl\\("${key}"`), `${key} should be editable in Hidden World`);
    }
    assert.doesNotMatch(appJs, /renderNumberControl\("sceneContextMaxLifeArcs"/);
    assert.doesNotMatch(appJs, /renderNumberControl\("chunkSendDelayMs"/);
    assert.doesNotMatch(appJs, /renderNumberControl\("maxCancelReasonLength"/);
    assert.match(appJs, /renderArrayTextarea\("dailyShareDefaultCancelIf"/, "dailyShareDefaultCancelIf should be editable");
  });

  it("uses a role-level hidden-world session with a system prompt", () => {
    assert.match(turn, /const roleWorld = getRoleWorld\(profile\)/);
    assert.match(turn, /sessionName: `hidden-world-\$\{roleWorldKey\(profile\)\}`/);
    assert.match(turn, /systemPrompt: buildHiddenWorldSystemPrompt\(profile, sceneMemoryBlock, memoryPrompt\)/);
    assert.match(claudeRunner, /--append-system-prompt-file/);
  });

  it("resets only the active session for the selected role", () => {
    const activeTarget = { id: "target", _profile: "白鹭千圣" };
    const inactiveSameRole = { id: "inactive", _profile: "白鹭千圣" };
    const activeOtherRole = { id: "other", _profile: "丸山彩" };
    const sessionMap = new Map([
      ["user-a", { activeId: "target", list: [activeTarget, inactiveSameRole] }],
      ["user-b", { activeId: "other", list: [activeOtherRole] }],
    ]);
    assert.deepEqual(activeSessionEntriesForProfile(sessionMap, "白鹭千圣"), [
      { userId: "user-a", user: sessionMap.get("user-a"), session: activeTarget },
    ]);
    assert.match(guiWorld, /activeSessionEntriesForProfile\(sessions\.cc, profile\)/);
    assert.doesNotMatch(guiWorld, /if \(!s\.active\) continue;/);
  });
});
