import { activeAI } from "./state.mjs";
import {
  CLAUDE_MAIN_MODEL,
  CODEX_MAIN_MODEL,
  runClaudeStream,
  runCodexStream,
  runApiStream,
  runHiddenJson,
  runCodexJson,
  runApiJson,
  isApiConfigured,
  resolveApiConfig,
} from "./claude-runner.mjs";

export function normalizeBackend(value = activeAI) {
  return value === "codex" || value === "api" ? value : "cc";
}

export function backendModel(backend = activeAI) {
  const id = normalizeBackend(backend);
  if (id === "codex") return CODEX_MAIN_MODEL || "default";
  if (id === "api") return resolveApiConfig().model || "default";
  return CLAUDE_MAIN_MODEL;
}

function emptyToolUsage() {
  return { webSearch: 0, webFetch: 0, tools: [] };
}

function addTool(usage, name) {
  if (!name) return;
  const tool = String(name);
  if (!usage.tools.includes(tool)) usage.tools.push(tool);
  if (/web[_-]?search|websearch/i.test(tool)) usage.webSearch += 1;
  if (/web[_-]?fetch|webfetch/i.test(tool)) usage.webFetch += 1;
}

function startClaudeChat(options) {
  let text = "";
  let usage = null;
  const toolUsage = emptyToolUsage();
  let modelContextWindow = 0;
  const task = runClaudeStream(
    "cc",
    options.sessionId,
    options.sessionName,
    options.body,
    options.firstTurn,
    event => {
      if (event.type === "stream_event" && event.event?.type === "content_block_delta" && event.event.delta?.type === "text_delta") {
        const delta = event.event.delta.text || "";
        text += delta;
        options.onText?.(delta);
      } else if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text") {
            text += block.text || "";
            options.onText?.(block.text || "");
          } else if (block.type === "tool_use") {
            addTool(toolUsage, block.name);
          }
        }
      }
      if (event.type === "stream_event" && event.event?.type === "content_block_start" && event.event.content_block?.type === "tool_use") {
        addTool(toolUsage, event.event.content_block.name);
      }
      if (event.type === "assistant" && event.message?.usage) {
        const raw = event.message.usage;
        usage = {
          type: "chat_usage",
          model: event.message.model || "unknown",
          session_id: event.session_id || options.sessionId,
          input_tokens: Number(raw.input_tokens || 0) || 0,
          cache_read_input_tokens: Number(raw.cache_read_input_tokens || 0) || 0,
          cache_creation_input_tokens: Number(raw.cache_creation_input_tokens || 0) || 0,
          output_tokens: Number(raw.output_tokens || 0) || 0,
          model_context_window: modelContextWindow,
        };
      }
      // 从任意事件中捕获 modelUsage（Claude Code stream-json 可能在 summary 事件中输出）
      if (event.modelUsage && typeof event.modelUsage === "object") {
        modelContextWindow = Object.values(event.modelUsage).reduce(
          (max, item) => Math.max(max, Number(item?.contextWindow || 0) || 0), 0,
        );
        if (usage) usage.model_context_window = modelContextWindow;
      }
    },
    options.stylePrompt,
    options.memoryPrompt,
    options.profile,
    {
      includeMemoryInSystem: true,
      noSessionPersistence: options.noSessionPersistence,
    },
  );
  const promise = task.then(result => ({
    ...result,
    text,
    threadId: options.sessionId,
    usage,
    toolUsage,
  }));
  promise.proc = task.proc;
  return promise;
}

function startCodexChat(options) {
  let emittedText = "";
  const task = runCodexStream(
    "codex",
    options.sessionId,
    options.sessionName,
    options.body,
    options.firstTurn,
    event => {
      if (event?.method === "item/agentMessage/delta") {
        const delta = String(event.params?.delta || "");
        emittedText += delta;
        options.onText?.(delta);
        return;
      }
      if (event?.method !== "item/completed") return;
      const item = event.params?.item || {};
      if ((item.type === "agent_message" || item.type === "agentMessage") && item.text) {
        if (emittedText) return;
        const delta = String(item.text);
        emittedText += delta;
        options.onText?.(delta);
      }
    },
    "",
    options.stylePrompt,
    options.memoryPrompt,
    options.profile,
    {
      noSessionPersistence: options.noSessionPersistence,
      model: options.model || CODEX_MAIN_MODEL,
    },
  );
  const promise = task.then(result => {
    if (!emittedText && result.text) options.onText?.(result.text);
    return {
      ...result,
      text: result.text || emittedText,
      usage: result.usage ? {
        type: "chat_usage",
        model: options.model || CODEX_MAIN_MODEL || "default",
        session_id: result.threadId || options.sessionId,
        ...result.usage,
      } : null,
      toolUsage: result.toolUsage || emptyToolUsage(),
    };
  });
  promise.proc = task.proc;
  return promise;
}

function startApiChat(options) {
  const promise = runApiStream({
    messages: options.apiMessages,
    systemPrompt: options.apiSystemPrompt || "",
    body: options.body,
    sessionName: options.sessionName,
    model: options.model || resolveApiConfig().model,
    useTools: options.useTools,
  }).then(result => {
    if (result.success && result.text) options.onText?.(result.text);
    return {
      code: result.success ? 0 : -1,
      stderr: result.error || "",
      killed: false,
      text: result.text || "",
      threadId: options.sessionId,
      usage: result.usage ? {
        type: "api_usage",
        model: options.model || resolveApiConfig().model,
        session_id: options.sessionId,
        input_tokens: Number(result.usage.inputTokens || 0) || 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: Number(result.usage.outputTokens || 0) || 0,
        model_context_window: Number(result.usage.modelContextWindow || 0) || 0,
      } : null,
      toolUsage: result.toolUsage || emptyToolUsage(),
      durationMs: result.durationMs || 0,
    };
  });
  promise.proc = null;
  return promise;
}

export function startBackendChat(options = {}) {
  const backend = normalizeBackend(options.backend);
  const normalized = {
    sessionId: "",
    sessionName: backend,
    body: "",
    firstTurn: false,
    stylePrompt: "",
    memoryPrompt: "",
    profile: null,
    noSessionPersistence: false,
    onText: () => {},
    ...options,
    backend,
  };
  if (backend === "codex") return startCodexChat(normalized);
  if (backend === "api") return startApiChat(normalized);
  return startClaudeChat(normalized);
}

export async function runBackendStructured(prompt, options = {}) {
  const backend = normalizeBackend(options.backend);
  if (backend === "codex") return runCodexJson(prompt, options);
  if (backend === "api") {
    if (!isApiConfigured()) return null;
    const result = await runApiJson({
      systemPrompt: options.systemPrompt || "",
      body: prompt,
      label: options.label || "api_hidden",
      model: options.model || resolveApiConfig().model,
      timeoutMs: options.timeoutMs || 300_000,
    });
    if (!result.success || !result.data) return null;
    const data = result.data;
    data._hiddenCall = {
      backend: "api",
      session_id: null,
      duration_ms: result.durationMs || 0,
      success: true,
      ...(result._apiCall || {}),
    };
    data._hiddenUsage = result.usage || null;
    return data;
  }
  return runHiddenJson(prompt, options);
}
