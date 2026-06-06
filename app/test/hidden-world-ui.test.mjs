import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appJs = readFileSync(join(import.meta.dirname, "..", "static", "app.js"), "utf-8");
const turn = readFileSync(join(import.meta.dirname, "..", "lib", "turn.mjs"), "utf-8");
const claudeRunner = readFileSync(join(import.meta.dirname, "..", "lib", "claude-runner.mjs"), "utf-8");

describe("Hidden World pipeline UI", () => {
  it("exposes hidden-world prompts and parameters outside the main reply page", () => {
    for (const key of [
      "sceneletInstructions",
      "dailyShareSeedInstructions",
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
      "scheduleCheckIntervalMs",
      "scheduleMaxActive",
      "proactiveCheckIntervalMs",
      "proactiveCooldownMs",
      "proactiveDailyMax",
    ]) {
      assert.match(appJs, new RegExp(`renderNumberControl\\("${key}"`), `${key} should be editable in Hidden World`);
    }
  });

  it("uses a role-level hidden-world session with a system prompt", () => {
    assert.match(turn, /const roleWorld = getRoleWorld\(profile\)/);
    assert.match(turn, /sessionName: `hidden-world-\$\{roleWorldKey\(profile\)\}`/);
    assert.match(turn, /systemPrompt: buildHiddenWorldSystemPrompt\(profile\)/);
    assert.match(claudeRunner, /--append-system-prompt-file/);
  });
});
