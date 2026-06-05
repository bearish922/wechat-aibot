import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appJs = readFileSync(join(process.cwd(), "static", "app.js"), "utf-8");
const bot = readFileSync(join(process.cwd(), "bot.mjs"), "utf-8");

describe("Hidden World pipeline UI", () => {
  it("exposes hidden-world prompts and parameters outside the main reply page", () => {
    for (const key of [
      "sceneletInstructions",
      "lifeArcInstructions",
      "dailyShareSeedInstructions",
      "proactiveInstructions",
      "scheduleCreatorInstructions",
      "scheduleSpecialDates",
      "chatHistoryIntro",
      "sceneStateIntro",
      "innerSceneletIntro",
      "sceneletReplyBridgeInstruction",
    ]) {
      assert.match(appJs, new RegExp(`renderTextPreview\\("${key}"`), `${key} should be editable in Hidden World`);
    }
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
    assert.match(bot, /const roleWorld = getRoleWorld\(profile\)/);
    assert.match(bot, /sessionName: `hidden-world-\$\{roleWorldKey\(profile\)\}`/);
    assert.match(bot, /systemPrompt: buildHiddenWorldSystemPrompt\(profile\)/);
    assert.match(bot, /--append-system-prompt-file/);
  });
});
