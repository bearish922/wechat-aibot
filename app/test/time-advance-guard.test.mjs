import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { worldStateFreshness } from "../lib/prompts.mjs";

const appRoot = join(import.meta.dirname, "..");
const turnSource = readFileSync(join(appRoot, "lib", "turn.mjs"), "utf-8");
const runnerSource = readFileSync(join(appRoot, "lib", "claude-runner.mjs"), "utf-8");
const worldSource = readFileSync(join(appRoot, "lib", "world-state.mjs"), "utf-8");

describe("world-state advancement guards", () => {
  it("marks old or missing world state as stale and forbids inferred schedule completion", () => {
    const now = new Date("2026-07-03T15:27:00+09:00");
    const fresh = worldStateFreshness(
      { lastWorldEventAt: "2026-07-03T15:10:00+09:00" },
      now,
      30 * 60_000,
    );
    const stale = worldStateFreshness(
      { lastWorldEventAt: "2026-07-03T11:17:11+09:00" },
      now,
      30 * 60_000,
    );
    const missing = worldStateFreshness(null, now, 30 * 60_000);

    assert.equal(fresh.status, "fresh");
    assert.equal(stale.status, "stale");
    assert.equal(missing.status, "stale");
    assert.match(stale.instruction, /不得仅根据 life_texture 自行宣布后续活动已经完成/);
    assert.match(stale.instruction, /保持最后确认场景/);
  });

  it("uses a 60-second advancement timeout and blocks proactive work after stale-state failure", () => {
    assert.match(turnSource, /const TIME_ADVANCE_TIMEOUT_MS = 60_000/);
    assert.match(turnSource, /timeoutMs: TIME_ADVANCE_TIMEOUT_MS/);
    assert.match(turnSource, /_dailyShareSeedRetryReason = "world_state"/);
    assert.match(turnSource, /return \{ changed: true, intent: null, blocked: true \}/);
    assert.match(turnSource, /if \(seeded\.blocked\)[\s\S]*?continue/);
  });

  it("backs off briefly without consuming the normal seed interval", () => {
    assert.match(turnSource, /const DAILY_SHARE_RETRY_DELAY_MS = 10 \* 60_000/);
    const generationAt = turnSource.indexOf("const seeded = await runDailyShareSeed");
    const intervalAt = turnSource.indexOf("roleWorld._lastDailyShareSeedAt = nowIso");
    assert.ok(generationAt >= 0 && intervalAt > generationAt);
    assert.match(worldSource, /_dailyShareSeedRetryAfter/);
    assert.match(worldSource, /_dailyShareSeedRetryReason/);
  });

  it("records explicit timeout metadata instead of an ambiguous null exit", () => {
    assert.match(runnerSource, /timed_out: true/);
    assert.match(runnerSource, /timeout after \$\{timeoutMs\}ms/);
    assert.match(runnerSource, /timed_out: timedOut/);
  });
});
