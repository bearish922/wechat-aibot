import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildCodexExecArgs,
  codexAppServerUsage,
  createCodexEventState,
  reduceCodexEvent,
} from "../lib/claude-runner.mjs";
import { ensureWorldSession } from "../lib/world-state.mjs";

const adapterSource = readFileSync(join(import.meta.dirname, "..", "lib", "backend-adapter.mjs"), "utf-8");
const botSource = readFileSync(join(import.meta.dirname, "..", "bot.mjs"), "utf-8");
const turnSource = readFileSync(join(import.meta.dirname, "..", "lib", "turn.mjs"), "utf-8");
const historySource = readFileSync(join(import.meta.dirname, "..", "lib", "gui-history.mjs"), "utf-8");

describe("Codex backend contract", () => {
  it("parses the real Codex JSONL protocol and captures the actual thread id", () => {
    const state = createCodexEventState("placeholder");
    reduceCodexEvent(state, { type: "thread.started", thread_id: "thread-real" });
    reduceCodexEvent(state, { type: "item.completed", item: { type: "agent_message", text: "hello" } });
    reduceCodexEvent(state, { type: "item.completed", item: { type: "web_search" } });
    reduceCodexEvent(state, { type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 900, output_tokens: 80 } });

    assert.equal(state.threadId, "thread-real");
    assert.equal(state.text, "hello");
    assert.deepEqual(state.usage, {
      input_tokens: 1200,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
      output_tokens: 80,
      reasoning_output_tokens: 0,
    });
    assert.equal(state.toolUsage.webSearch, 1);
  });

  it("starts isolated Codex threads and resumes the captured thread on later turns", () => {
    const first = buildCodexExecArgs({ persist: true, systemPrompt: "role", model: "gpt-test" });
    const resumed = buildCodexExecArgs({ sessionId: "thread-real", persist: true, model: "gpt-test" });

    assert.deepEqual(first.slice(0, 4), ["-a", "never", "-s", "read-only"]);
    assert.ok(first.includes("--ignore-user-config"));
    assert.ok(first.includes("--ignore-rules"));
    assert.ok(!first.includes("resume"));
    assert.ok(resumed.includes("resume"));
    assert.equal(resumed[resumed.indexOf("resume") + 1], "thread-real");
  });

  it("runs the complete child-process and resume path against Codex JSONL", () => {
    const fixture = join(import.meta.dirname, "fixtures", "fake-codex.js");
    const script = [
      "import { runCodexStream } from './lib/claude-runner.mjs';",
      "const deltas = [];",
      "const first = await runCodexStream('codex', '', 'test', 'FIRST', true, event => { if (event.method === 'item/agentMessage/delta') deltas.push(event.params.delta); }, '', '', '', null, { timeoutMs: 10000 });",
      "const second = await runCodexStream('codex', first.threadId, 'test', 'SECOND', false, event => { if (event.method === 'item/agentMessage/delta') deltas.push(event.params.delta); }, '', '', '', null, { timeoutMs: 10000 });",
      "console.log(JSON.stringify({ first, second, deltas }));",
    ].join("\n");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: join(import.meta.dirname, ".."),
      env: {
        ...process.env,
        WECHAT_CODEX_PATH: fixture,
        WECHAT_CODEX_HTTPS_PROXY: "",
        WECHAT_CODEX_MAIN_MODEL: "gpt-test",
      },
      encoding: "utf-8",
      timeout: 30000,
    });

    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim());
    assert.equal(result.first.threadId, "fake-thread-001");
    assert.equal(result.first.text, "FIRST_OK");
    assert.equal(result.second.threadId, "fake-thread-001");
    assert.equal(result.second.text, "SECOND_OK");
    assert.equal(result.second.usage.input_tokens, 200);
    assert.equal(result.second.usage.model_context_window, 1000000);
    assert.equal(result.second.toolUsage.webSearch, 1);
    assert.equal(result.deltas.join(""), "FIRST_OKSECOND_OK");
  });

  it("maps app-server cumulative usage without double-counting cached input", () => {
    assert.deepEqual(codexAppServerUsage({
      last: { inputTokens: 1200, cachedInputTokens: 900, outputTokens: 80, reasoningOutputTokens: 20 },
      total: { inputTokens: 2200, outputTokens: 180 },
      modelContextWindow: 1000000,
    }), {
      input_tokens: 1200,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
      output_tokens: 80,
      reasoning_output_tokens: 20,
      total_input_tokens: 2200,
      total_output_tokens: 180,
      model_context_window: 1000000,
    });
  });

  it("keeps role world content shared while provider runtime threads stay separate", () => {
    const roleWorld = { _worldState: { location: "Tokyo" }, _lifeArcs: [{ id: "arc" }] };
    const cc = ensureWorldSession(roleWorld, "cc");
    const codex = ensureWorldSession(roleWorld, "codex");

    assert.notEqual(cc.sid, codex.sid);
    assert.equal(roleWorld._worldState.location, "Tokyo");
    assert.equal(roleWorld._lifeArcs[0].id, "arc");
    assert.equal(roleWorld._worldSessions.cc, cc);
    assert.equal(roleWorld._worldSessions.codex, codex);
  });

  it("routes main chat, hidden calls, usage and cancellation through the adapter", () => {
    assert.match(botSource, /startChatAttempt = \(sessionId, isFirstTurn\) => startBackendChat\(/);
    assert.match(botSource, /styleState\._lastProc = chatTask\.proc \|\| null/);
    assert.match(botSource, /styleState\.sid = streamResult\.threadId/);
    assert.match(adapterSource, /runCodexJson\(prompt, options\)/);
    assert.match(turnSource, /runBackendStructured\(prompt/);
    assert.doesNotMatch(turnSource, /runHiddenCall/);
    assert.match(historySource, /activeAI !== "api"/);
    assert.match(historySource, /sessions\.api/);
    assert.doesNotMatch(historySource, /sessions\.cc/);
  });

  it("does not replace a missing Claude conversation outside reset", () => {
    assert.match(botSource, /ai === "cc"[\s\S]*!assistantFullText[\s\S]*!streamResult\?\.text/);
    assert.match(botSource, /No conversation found with session ID/i);
    assert.match(botSource, /CC conversation is missing; reset the session before retrying/);
    const missingSessionBlock = botSource.slice(
      botSource.indexOf("const missingCcSession"),
      botSource.indexOf("if (!assistantFullText && streamResult?.text)"),
    );
    assert.doesNotMatch(missingSessionBlock, /uuid\(|_firstTurn\s*=|startChatAttempt\(/);
  });
});
