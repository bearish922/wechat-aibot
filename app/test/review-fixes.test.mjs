import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..");
const bot = readFileSync(join(root, "bot.mjs"), "utf-8");
const turn = readFileSync(join(root, "lib", "turn.mjs"), "utf-8");
const claudeContext = readFileSync(join(root, "lib", "claude-context.mjs"), "utf-8");
const workEvents = readFileSync(join(root, "lib", "work-event-generator.mjs"), "utf-8");
const appJs = readFileSync(join(root, "static", "app.js"), "utf-8");
const appCss = readFileSync(join(root, "static", "app.css"), "utf-8");
const guiPrompts = readFileSync(join(root, "lib", "gui-prompts.mjs"), "utf-8");
const media = readFileSync(join(root, "lib", "media.mjs"), "utf-8");
const prompts = readFileSync(join(root, "lib", "prompts.mjs"), "utf-8");
const worldState = readFileSync(join(root, "lib", "world-state.mjs"), "utf-8");
const scheduleValidation = readFileSync(join(root, "lib", "schedule-validation.mjs"), "utf-8");
const workflows = [
  readFileSync(join(root, "..", ".github", "workflows", "ci.yml"), "utf-8"),
  readFileSync(join(root, "..", ".github", "workflows", "release.yml"), "utf-8"),
];

describe("repository review regression checks", () => {
  it("uses a unique RAG query file and always removes it", () => {
    assert.match(bot, /\.rag_query_\$\{process\.pid\}_\$\{crypto\.randomUUID\(\)\}\.txt/);
    assert.match(bot, /finally\s*\{[\s\S]*?fs\.rmSync\(queryFile, \{ force: true \}\)/);
    assert.match(bot, /if \(!fs\.existsSync\(RAG_SCRIPT\)\) return ""/);
  });

  it("limits Claude transcript cleanup to app-owned hidden-world sessions", () => {
    assert.match(claudeContext, /title\.startsWith\("hidden-world-"\)/);
    assert.match(claudeContext, /unrelated or unreadable session: never delete it/);
    assert.doesNotMatch(claudeContext, /age > maxAgeMs/);
  });

  it("uses normalized daily-share intent fields for repetition history", () => {
    assert.match(turn, /p\.kind === "daily_share" && p\.messageIntent/);
    assert.match(turn, /\.map\(p => p\.messageIntent\)/);
    assert.doesNotMatch(turn, /p\.message_intent/);
  });

  it("does not shift the current instant while formatting Tokyo work events", () => {
    assert.match(workEvents, /function tokyoNow\(\)\s*\{\s*return new Date\(\);\s*\}/);
    assert.match(workEvents, /timeZone: "Asia\/Tokyo", weekday: "short"/);
    assert.match(workEvents, /Number\.isFinite\(relevantMs\) && relevantMs >= cutoffMs && mentionsPrerequisite/);
    assert.match(workEvents, /if \(!result \|\| !Array\.isArray\(result\.events\)\)/);
  });

  it("preserves unsaved memory edits when toggling preview", () => {
    assert.match(appJs, /function captureMemoryEditors\(\)/);
    assert.match(appJs, /renderMemory\(\{ reload: false \}\)/);
    assert.match(appJs, /当前角色有尚未保存的记忆修改/);
    assert.match(appJs, /if \(!result\.ok\)/);
  });

  it("associates config labels with controls and avoids invalid CSS", () => {
    assert.match(appJs, /<label for="\$\{id\}">/);
    assert.match(appJs, /<select id="\$\{id\}" name="\$\{key\}">/);
    assert.match(appJs, /Select\("rag\.enabled"/);
    assert.doesNotMatch(appCss, /:contains\(/);
  });

  it("labels Direct API sessions correctly on the status page", () => {
    assert.match(appJs, /d\.currentAI === 'api' \? 'Direct API' : 'Codex'/);
  });

  it("keeps prompt writes atomic and never builds the main file from merged local secrets", () => {
    assert.match(guiPrompts, /function writeJsonAtomic/);
    assert.match(guiPrompts, /const document = loadMainDocument\(\)/);
    assert.doesNotMatch(guiPrompts, /const document = loadPromptDocument\(\)/);
  });

  it("keeps RAG numeric settings in global Config rather than stale Prompt editing", () => {
    for (const key of ["ragTopK", "ragMinScore", "ragResultMaxChars", "ragTimeoutMs"]) {
      assert.doesNotMatch(guiPrompts, new RegExp(`"${key}"`));
      assert.doesNotMatch(appJs, new RegExp(`renderNumberControl\\("${key}"`));
    }
    assert.match(appJs, /Config 页的 RAG 区域编辑/);
  });

  it("uses compact role-world life texture for proactive decisions", () => {
    assert.match(prompts, /life_texture: lifeArcs \|\| null/);
    assert.match(prompts, /life_texture: lifeArcs/);
    assert.doesNotMatch(prompts, /active_life_arcs: lifeArcPromptItems\(sess\)/);
    assert.doesNotMatch(prompts, /active_life_arcs: Array\.isArray\(lifeArcs\)/);
    assert.match(turn, /lifeArcs: lifeTexturePromptItems\(getRoleWorld\(profile\)\)/);
    assert.match(worldState, /function lifeTexturePromptItems/);
    assert.match(worldState, /current_life_texture/);
    assert.match(worldState, /salient_details/);
    assert.match(worldState, /chat_priority: "background"/);
    assert.match(worldState, /arc\?\.lifeTexture\?\.currentLifeTexture/);
    assert.match(workEvents, /"life_texture":\{"current_life_texture"/);
    assert.match(workEvents, /life_texture: event\.life_texture \|\| event\.lifeTexture \|\| null/);
    assert.match(prompts, /【life_texture 输出要求】/);
    assert.match(turn, /life_texture: arc\.life_texture \|\| arc\.lifeTexture \|\| null/);
  });

  it("preserves closed and expired life arcs and carries time slot conflict data", () => {
    assert.match(worldState, /normalizeLifeArcs\(raw\._lifeArcs \|\| raw\.lifeArcs, \{ includeClosed: true \}\)/);
    assert.match(worldState, /normalizeLifeArcs\(world\?\._lifeArcs, \{ includeClosed: true \}\)/);
    assert.match(worldState, /time_slots: arc\.timeSlots \|\| null/);
    assert.match(worldState, /duration_hours: arc\.durationHours \|\| null/);
    assert.match(workEvents, /time_slots: timeSlotsFromEvent\(event\)/);
    assert.match(workEvents, /duration_hours: event\.duration_hours/);
    assert.match(workEvents, /validateScheduleArc\(/);
    assert.match(scheduleValidation, /slotGapMinutes\(candidateSlot, existingSlot\)/);
    assert.match(scheduleValidation, /gap < minGapMinutes/);
  });

  it("does not let malformed schedule finalization repeat the same bad candidate forever", () => {
    assert.match(turn, /function dropScheduleCandidate/);
    assert.match(turn, /dropScheduleCandidate\(roleWorld, selIdx, candidates\)/);
    assert.match(turn, /visibleContext: recentVisibleContext\(sess, 4\)/);
  });

  it("defaults auto vision away from external API on Codex but keeps CC eligible", () => {
    assert.match(media, /String\(backend \|\| ""\)\.toLowerCase\(\) === "codex"\) return false/);
    assert.match(bot, /extractInboundPayload\(msg, \{ backend: arrivalAI \}\)/);
    assert.match(bot, /shouldUseExternalVision\(activeAI\)/);
  });

  it("installs locked dependencies before CI and release tests", () => {
    for (const workflow of workflows) assert.match(workflow, /npm ci[\s\S]*npm (?:test|run check)/);
  });

  it("refreshes Codex JSONL usage when the session file grows without overwriting live counters", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-usage-"));
    const sid = "session-refresh-test";
    const dir = join(home, ".codex", "sessions", "2026", "06", "29");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-${sid}.jsonl`);
    const event = (input, output, window) => JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: input, output_tokens: output },
          model_context_window: window,
        },
      },
    }) + "\n";
    writeFileSync(file, event(10, 2, 1000), "utf-8");
    const moduleUrl = pathToFileURL(join(root, "lib", "codex-session-usage.mjs")).href;
    const script = `
      import { readCodexSessionUsage, repairCodexUsageFromSession } from ${JSON.stringify(moduleUrl)};
      import { appendFileSync } from "node:fs";
      const first = readCodexSessionUsage(${JSON.stringify(sid)});
      appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(event(25, 4, 2000))}, "utf-8");
      const second = readCodexSessionUsage(${JSON.stringify(sid)});
      const repaired = repairCodexUsageFromSession({ input_tokens: 999, output_tokens: 9, model_context_window: 0 }, ${JSON.stringify(sid)});
      process.stdout.write(JSON.stringify({ first, second, repaired }));
    `;
    try {
      const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf-8",
        env: { ...process.env, USERPROFILE: home, HOME: home },
      });
      const result = JSON.parse(output);
      assert.equal(result.first.input_tokens, 10);
      assert.equal(result.second.input_tokens, 25);
      assert.equal(result.repaired.input_tokens, 999);
      assert.equal(result.repaired.model_context_window, 2000);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
