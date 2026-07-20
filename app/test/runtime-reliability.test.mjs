import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { providerErrorInfo } from "../lib/claude-runner.mjs";

const turnSource = fs.readFileSync(new URL("../lib/turn.mjs", import.meta.url), "utf8");
const runnerSource = fs.readFileSync(new URL("../lib/claude-runner.mjs", import.meta.url), "utf8");
const worldSource = fs.readFileSync(new URL("../lib/world-state.mjs", import.meta.url), "utf8");
const botSource = fs.readFileSync(new URL("../bot.mjs", import.meta.url), "utf8");

test("proactive auxiliary calls use distinct named budgets and serialize full sweeps", () => {
  assert.match(turnSource, /DAILY_SHARE_SEED_TIMEOUT_MS = 90_000/);
  assert.match(turnSource, /CONTINUITY_UPDATE_TIMEOUT_MS = 45_000/);
  assert.match(turnSource, /if \(proactiveCheckRunning\) return/);
  assert.match(turnSource, /finally\s*\{\s*proactiveCheckRunning = false/);
});

test("failed structured output is archived outside hidden usage accounting", () => {
  assert.match(runnerSource, /failed-structured-output\.jsonl/);
  assert.match(runnerSource, /failureKind: "timeout"/);
  assert.match(runnerSource, /failureKind: "non_object"/);
  assert.match(runnerSource, /failureKind: "parse_error"/);
  assert.match(runnerSource, /failureKind: "schema_validation"/);
  assert.match(runnerSource, /output_sha256/);
  assert.match(turnSource, /archiveRejectedStructuredResult\(raw/);
});

test("known provider failures keep diagnostic codes in logs but use plain WeChat messages", () => {
  const balance = providerErrorInfo(402, "API Error: 402 Insufficient Balance");
  assert.equal(balance.retryable, false);
  assert.equal(balance.userMessage, "模型服务余额不足，请充值或切换可用模型后重试");
  assert.doesNotMatch(balance.userMessage, /402|Insufficient Balance/);
  assert.match(runnerSource, /preserveStructuredErrors/);
  assert.match(turnSource, /raw\?\._structuredError\?\.retryable === false/);
  assert.match(botSource, /\[SYSTEM\] 回复失败：/);
});

test("all schedule writes pass through the shared validator", () => {
  assert.match(worldSource, /validateScheduleArc\(candidate, arcs/);
  assert.match(worldSource, /schedule write rejected/);
  assert.match(worldSource, /return \{ applied: applied\.length, operations: applied, rejected \}/);
});
