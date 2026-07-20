// api-client.mjs — OpenAI-compatible Chat Completions API wrapper
// Supports: streaming (SSE), non-streaming, function calling, auto-retry, timeout
import { envOrConfig } from "./config.mjs";

function usableConfigString(value, fallback) {
  const text = String(value ?? "").trim();
  return text && !/^(填写|可选)$/u.test(text) ? text : fallback;
}

export function resolveApiConfig() {
  const baseUrl = usableConfigString(
    envOrConfig("WECHAT_API_BASE_URL", "api.baseUrl", ""),
    envOrConfig("WECHAT_CHAT_BASE_URL", "chat.baseUrl", "")
  );
  const apiKey = usableConfigString(
    envOrConfig("WECHAT_API_KEY", "api.apiKey", ""),
    envOrConfig("WECHAT_CHAT_API_KEY", "chat.apiKey", "")
  );
  const model = usableConfigString(
    envOrConfig("WECHAT_API_MODEL", "api.model", ""),
    "deepseek-v4-pro"
  );
  return { baseUrl, apiKey, model };
}

export function isApiConfigured() {
  const { baseUrl, apiKey } = resolveApiConfig();
  return Boolean(baseUrl && apiKey);
}

function chatCompletionsUrl(baseUrl) {
  let url = String(baseUrl).replace(/\/+$/, "");
  if (!url.endsWith("/v1")) url += "/v1";
  return url + "/chat/completions";
}

// ─── Retry + backoff ───────────────────────────────────────────
const RETRIABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRIABLE_ERRORS = new Set(["UND_ERR_SOCKET", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "fetch failed"]);

function isRetriable(status, errMsg = "") {
  if (status && RETRIABLE_STATUSES.has(status)) return true;
  const message = String(errMsg || "");
  const httpStatus = Number(message.match(/\bHTTP\s+(\d{3})\b/i)?.[1] || 0);
  return RETRIABLE_STATUSES.has(httpStatus)
    || RETRIABLE_ERRORS.has(message)
    || /(socket|timeout|reset|refused|network)/i.test(message);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function retryDelay(attempt) { return Math.min(500 * Math.pow(2, Math.max(0, attempt - 1)), 8000); }

// ─── Streaming ─────────────────────────────────────────────────
async function* streamChatCompletion(url, apiKey, body, timeoutMs = 300_000, signal = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = () => controller.abort();
  if (signal) signal.addEventListener("abort", abortFromCaller, { once: true });
  let reader = null;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 300)}`);
    }

    reader = resp.body?.getReader();
    if (!reader) throw new Error("API response body is not readable");
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;
        try {
          const json = JSON.parse(data);
          const choice = json.choices?.[0];
          if (json.usage) yield { type: "usage", usage: json.usage };
          if (choice?.delta?.content) {
            yield { type: "text", text: choice.delta.content };
          }
          if (choice?.finish_reason) {
            yield { type: "finish", reason: choice.finish_reason, usage: json.usage || null };
          }
        } catch { /* skip malformed SSE lines */ }
      }
    }
    if (buf.trim()) {
      const trimmed = buf.trim();
      if (trimmed.startsWith("data: ") && trimmed.slice(6) !== "[DONE]") {
        try {
          const json = JSON.parse(trimmed.slice(6));
          const choice = json.choices?.[0];
          if (json.usage) yield { type: "usage", usage: json.usage };
          if (choice?.delta?.content) yield { type: "text", text: choice.delta.content };
        } catch {}
      }
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abortFromCaller);
    reader?.releaseLock();
  }
}

// ─── Non-streaming (for hidden JSON calls) ─────────────────────
async function nonStreamChatCompletion(url, apiKey, body, timeoutMs = 300_000, signal = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = () => controller.abort();
  if (signal) signal.addEventListener("abort", abortFromCaller, { once: true });
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ ...body, stream: false }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 300)}`);
    }

    return await resp.json();
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abortFromCaller);
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Run a streaming chat completion.
 * Returns { text, usage, durationMs, success, error }
 */
export async function apiChatStream({ systemPrompt = "", body = "", messages: prebuiltMessages = null, model = null, maxTokens = 4000, temperature = 0.7, timeoutMs = 300_000, tools = null } = {}) {
  const { baseUrl, apiKey, model: cfgModel } = resolveApiConfig();
  if (!baseUrl || !apiKey) return { success: false, error: "API not configured" };

  const url = chatCompletionsUrl(baseUrl);
  const selectedModel = model || cfgModel;
  let messages;
  if (prebuiltMessages) {
    messages = prebuiltMessages;
    // If no system message in the prebuilt array, prepend systemPrompt
    if (systemPrompt && !messages.some(m => m.role === "system")) {
      messages = [{ role: "system", content: systemPrompt }, ...messages];
    }
  } else {
    messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: body });
  }

  const reqBody = { model: selectedModel, messages, temperature, max_tokens: maxTokens };
  if (tools && tools.length) {
    reqBody.tools = tools;
    reqBody.tool_choice = "auto";
  }

  const startedMs = Date.now();
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(retryDelay(attempt));
    try {
      const textParts = [];
      let lastUsage = null;
      for await (const ev of streamChatCompletion(url, apiKey, reqBody, timeoutMs)) {
        if (ev.type === "text") textParts.push(ev.text);
        if (ev.type === "usage" && ev.usage) lastUsage = ev.usage;
        if (ev.type === "finish" && ev.usage) lastUsage = ev.usage;
      }
      return {
        success: true,
        text: textParts.join(""),
        durationMs: Date.now() - startedMs,
        usage: lastUsage ? {
          inputTokens: Number(lastUsage.prompt_tokens || 0) || 0,
          outputTokens: Number(lastUsage.completion_tokens || 0) || 0,
        } : null,
      };
    } catch (e) {
      lastError = e;
      if (!isRetriable(null, e.message)) break;
    }
  }
  return { success: false, error: lastError?.message || "unknown", durationMs: Date.now() - startedMs };
}

/**
 * Run a non-streaming chat completion (for hidden JSON calls like scenelet, memory, schedule).
 * Returns { success, data (parsed JSON or raw text), durationMs, usage }
 */
export async function apiChatJson({ systemPrompt = "", body = "", model = null, maxTokens = 4000, temperature = 0.7, timeoutMs = 300_000 } = {}) {
  const { baseUrl, apiKey, model: cfgModel } = resolveApiConfig();
  if (!baseUrl || !apiKey) return { success: false, error: "API not configured" };

  const url = chatCompletionsUrl(baseUrl);
  const selectedModel = model || cfgModel;
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: body });

  const reqBody = { model: selectedModel, messages, temperature, max_tokens: maxTokens };

  const startedMs = Date.now();
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(retryDelay(attempt));
    try {
      const json = await nonStreamChatCompletion(url, apiKey, reqBody, timeoutMs);
      const content = json.choices?.[0]?.message?.content || "";
      // Try to parse as JSON (hidden calls expect structured output)
      let data;
      try {
        const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        data = JSON.parse(trimmed);
      } catch {
        // Try extracting JSON block
        const start = content.indexOf("{");
        const end = content.lastIndexOf("}");
        if (start >= 0 && end > start) {
          try { data = JSON.parse(content.slice(start, end + 1)); } catch { data = { raw: content }; }
        } else {
          data = { raw: content };
        }
      }
      return {
        success: true,
        data,
        durationMs: Date.now() - startedMs,
        usage: json.usage ? {
          inputTokens: Number(json.usage.prompt_tokens || 0) || 0,
          outputTokens: Number(json.usage.completion_tokens || 0) || 0,
        } : null,
      };
    } catch (e) {
      lastError = e;
      if (!isRetriable(null, e.message)) break;
    }
  }
  return { success: false, error: lastError?.message || "unknown", durationMs: Date.now() - startedMs };
}

// ─── Tool definitions for function calling ────────────────────
const WEB_TOOLS = [
  { type: "function", function: { name: "web_search", description: "Search the web for real-time information.", parameters: { type: "object", properties: { query: { type: "string", description: "Search query" } }, required: ["query"] } } },
  { type: "function", function: { name: "web_fetch", description: "Fetch and read a URL.", parameters: { type: "object", properties: { url: { type: "string", description: "URL to fetch" } }, required: ["url"] } } },
];

async function executeWebSearch(query) {
  try {
    const resp = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      signal: AbortSignal.timeout(15000),
    });
    const html = await resp.text();
    const snippets = [];
    const re = /<a[^>]*class="result-link"[^>]*>([^<]+)<\/a>.*?<td[^>]*class="result-snippet"[^>]*>([^<]+)/gs;
    let m;
    while ((m = re.exec(html)) !== null && snippets.length < 5) {
      snippets.push(m[1].trim() + ": " + m[2].trim().replace(/<[^>]+>/g, ""));
    }
    return snippets.length ? snippets.join("\n") : "No results.";
  } catch (e) { return "Search error: " + e.message; }
}

async function executeWebFetch(url) {
  try {
    const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
    const html = await resp.text();
    return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
  } catch (e) { return "Fetch error: " + e.message; }
}

async function handleToolCall(tc) {
  const args = JSON.parse(tc.function?.arguments || "{}");
  const result = tc.function?.name === "web_search" ? await executeWebSearch(args.query || "")
    : tc.function?.name === "web_fetch" ? await executeWebFetch(args.url || "")
    : "Unknown tool";
  return { role: "tool", tool_call_id: tc.id, content: result };
}

export async function apiChatWithTools({ systemPrompt = "", body = "", messages: prebuiltMessages = null, model = null, maxTokens = 4000, temperature = 0.7, timeoutMs = 300_000, maxToolRounds = 3 } = {}) {
  const { baseUrl, apiKey, model: cfgModel } = resolveApiConfig();
  if (!baseUrl || !apiKey) return { success: false, error: "API not configured" };
  const url = chatCompletionsUrl(baseUrl);
  const selectedModel = model || cfgModel;
  let messages = prebuiltMessages ? [...prebuiltMessages] : [];
  if (systemPrompt && !messages.some(m => m.role === "system")) messages.unshift({ role: "system", content: systemPrompt });
  if (!prebuiltMessages) messages.push({ role: "user", content: body });

  const startedMs = Date.now();
  const toolUsage = { webSearch: 0, webFetch: 0, tools: [] };
  for (let round = 0; round < maxToolRounds; round++) {
    let response = null;
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(retryDelay(attempt));
      try {
        const resp = await fetch(url, {
          method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
          body: JSON.stringify({ model: selectedModel, messages, temperature, max_tokens: maxTokens, tools: WEB_TOOLS, tool_choice: "auto" }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!resp.ok) { const t = await resp.text().catch(() => ""); throw new Error(`HTTP ${resp.status}: ${t.slice(0, 200)}`); }
        response = await resp.json();
        lastError = null;
        break;
      } catch (e) { lastError = e; if (!/(socket|timeout|reset|refused|network|429|5\d\d)/i.test(e.message)) break; }
    }
    if (!response) return { success: false, error: lastError?.message || "unknown", durationMs: Date.now() - startedMs, toolUsage };

    const msg = response.choices?.[0]?.message;
    if (msg?.tool_calls?.length) {
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        const name = String(tc.function?.name || "");
        if (name && !toolUsage.tools.includes(name)) toolUsage.tools.push(name);
        if (name === "web_search") toolUsage.webSearch += 1;
        if (name === "web_fetch") toolUsage.webFetch += 1;
        messages.push(await handleToolCall(tc));
      }
      continue;
    }
    return {
      success: true,
      text: msg?.content || "",
      durationMs: Date.now() - startedMs,
      usage: response.usage ? {
        inputTokens: Number(response.usage.prompt_tokens || 0),
        outputTokens: Number(response.usage.completion_tokens || 0),
      } : null,
      toolUsage,
    };
  }
  return { success: false, error: "max tool rounds exceeded", durationMs: Date.now() - startedMs, toolUsage };
}
