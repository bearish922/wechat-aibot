import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

// ─── mock API server ───────────────────────────────────────────
function jsonResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sseResponse(res, events) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const ev of events) {
    if (ev === "[DONE]") { res.write("data: [DONE]\n\n"); break; }
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }
  res.end();
}

let server;
let baseUrl;
const API_KEY = "test-key-abc123";
const requestCounts = new Map();

// Import after env vars are set — avoids concurrent env manipulation
let resolveApiConfig, isApiConfigured, apiChatStream, apiChatJson, apiChatWithTools;

before(async () => {
  await new Promise((resolve) => {
    server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const auth = req.headers["authorization"];

      if (!auth || auth !== `Bearer ${API_KEY}`) {
        return jsonResponse(res, 401, { error: "unauthorized" });
      }

      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        let body = "";
        req.on("data", c => body += c);
        req.on("end", () => {
          let data;
          try { data = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: "bad json" }); }
          const content = data.messages?.at(-1)?.content || "";
          requestCounts.set(content, (requestCounts.get(content) || 0) + 1);

          if (content.includes("ERROR_500")) return jsonResponse(res, 500, { error: "server error" });
          if (content.includes("ERROR_429")) return jsonResponse(res, 429, { error: "rate limited" });
          if (content === "TOOLS_AFTER_RETRY" && requestCounts.get(content) === 1) {
            return jsonResponse(res, 429, { error: "rate limited once" });
          }
          if (content === "TOOLS_AFTER_RETRY") {
            return jsonResponse(res, 200, {
              choices: [{
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [{ id: "tool-1", type: "function", function: { name: "unknown_tool", arguments: "{}" } }],
                },
              }],
            });
          }

          if (data.stream) {
            if (content === "USAGE_ONLY_CHUNK") {
              return sseResponse(res, [
                { choices: [{ delta: { content: "ok" }, finish_reason: null }] },
                { choices: [], usage: { prompt_tokens: 77, completion_tokens: 11 } },
                "[DONE]",
              ]);
            }
            return sseResponse(res, [
              { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
              { choices: [{ delta: { content: " world" }, finish_reason: null }] },
              { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 30 } },
              "[DONE]",
            ]);
          }

          if (content.includes("JSON_OUTPUT")) {
            return jsonResponse(res, 200, {
              choices: [{ message: { role: "assistant", content: '{"result":"ok","score":42}' } }],
              usage: { prompt_tokens: 20, completion_tokens: 15 },
            });
          }

          return jsonResponse(res, 200, {
            choices: [{ message: { role: "assistant", content: "plain response" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          });
        });
        return;
      }

      jsonResponse(res, 404, { error: "not found" });
    });

    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      process.env.WECHAT_API_BASE_URL = baseUrl;
      process.env.WECHAT_API_KEY = API_KEY;
      resolve();
    });
  });

  const mod = await import(`../lib/api-client.mjs?t=${Date.now()}`);
  resolveApiConfig = mod.resolveApiConfig;
  isApiConfigured = mod.isApiConfigured;
  apiChatStream = mod.apiChatStream;
  apiChatJson = mod.apiChatJson;
  apiChatWithTools = mod.apiChatWithTools;
});

after(() => {
  if (server) server.close();
  delete process.env.WECHAT_API_BASE_URL;
  delete process.env.WECHAT_API_KEY;
});

// ─── Config resolution ────────────────────────────────────────
describe("API config resolution", () => {
  it("resolves config from env vars set by mock server", () => {
    assert.equal(isApiConfigured(), true);
    const cfg = resolveApiConfig();
    assert.equal(cfg.baseUrl, baseUrl);
    assert.equal(cfg.apiKey, API_KEY);
  });

  it("falls back to config.json api.model default", () => {
    const cfg = resolveApiConfig();
    assert.equal(cfg.model, "deepseek-v4-pro");
  });
});

// ─── Streaming: apiChatStream ──────────────────────────────────
describe("apiChatStream", () => {
  it("streams text chunks and returns usage", async () => {
    const result = await apiChatStream({ body: "hello", model: "test-model", timeoutMs: 5000 });
    assert.equal(result.success, true);
    assert.equal(result.text, "Hello world");
    assert.ok(result.durationMs > 0);
    assert.ok(result.usage);
    assert.equal(result.usage.inputTokens, 50);
    assert.equal(result.usage.outputTokens, 30);
  });

  it("reads usage from providers that send it in a choices-free final chunk", async () => {
    const result = await apiChatStream({ body: "USAGE_ONLY_CHUNK", model: "test-model", timeoutMs: 5000 });
    assert.equal(result.success, true);
    assert.equal(result.text, "ok");
    assert.deepEqual(result.usage, { inputTokens: 77, outputTokens: 11 });
  });

  it("retries on 429 up to 3 times then returns error", async () => {
    const before = requestCounts.get("ERROR_429") || 0;
    const result = await apiChatStream({ body: "ERROR_429", model: "test", timeoutMs: 5000 });
    assert.equal(result.success, false);
    assert.ok(result.error);
    assert.equal((requestCounts.get("ERROR_429") || 0) - before, 3);
  });

  it("retries transient server 500 responses before returning an error", async () => {
    const before = requestCounts.get("ERROR_500") || 0;
    const result = await apiChatStream({ body: "ERROR_500", model: "test", timeoutMs: 5000 });
    assert.equal(result.success, false);
    assert.match(result.error || "", /500|internal|server error/i);
    assert.equal((requestCounts.get("ERROR_500") || 0) - before, 3);
  });
});

// ─── Non-streaming: apiChatJson ────────────────────────────────
describe("apiChatJson", () => {
  it("parses JSON from response content", async () => {
    const result = await apiChatJson({ body: "JSON_OUTPUT", model: "test", timeoutMs: 5000 });
    assert.equal(result.success, true);
    assert.deepEqual(result.data, { result: "ok", score: 42 });
    assert.ok(result.usage);
    assert.equal(result.usage.inputTokens, 20);
  });

  it("falls back to raw text when response is not JSON", async () => {
    const result = await apiChatJson({ body: "plain text", model: "test", timeoutMs: 5000 });
    assert.equal(result.success, true);
    assert.equal(result.data.raw, "plain response");
  });
});

// ─── Tool calling: apiChatWithTools ────────────────────────────
describe("apiChatWithTools", () => {
  it("completes a simple query without tool calls", async () => {
    const result = await apiChatWithTools({ body: "plain chat", model: "test", timeoutMs: 5000 });
    assert.equal(result.success, true);
    assert.equal(result.text, "plain response");
  });

  it("continues tool rounds after a transient retry", async () => {
    const result = await apiChatWithTools({ body: "TOOLS_AFTER_RETRY", model: "test", timeoutMs: 5000 });
    assert.equal(result.success, true);
    assert.equal(result.text, "plain response");
    assert.deepEqual(result.toolUsage.tools, ["unknown_tool"]);
  });
});

// ─── Integration: end-to-end with system prompt ────────────────
describe("API end-to-end", () => {
  it("passes system prompt and messages correctly", async () => {
    const result = await apiChatStream({
      systemPrompt: "You are a helpful bot.",
      body: "hello",
      model: "test",
      timeoutMs: 5000,
    });
    assert.equal(result.success, true);
    assert.equal(result.text, "Hello world");
  });

  it("accepts prebuilt messages array", async () => {
    const result = await apiChatStream({
      messages: [
        { role: "system", content: "You are a test bot." },
        { role: "user", content: "hello" },
      ],
      model: "test",
      timeoutMs: 5000,
    });
    assert.equal(result.success, true);
    assert.equal(result.text, "Hello world");
  });
});
