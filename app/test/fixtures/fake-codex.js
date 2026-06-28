const args = process.argv.slice(2);
if (args.includes("app-server")) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        process.stdout.write(JSON.stringify({ id: message.id, result: { codexHome: "fake", platformFamily: "windows", platformOs: "windows", userAgent: "fake" } }) + "\n");
      } else if (message.method === "thread/start") {
        process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: "fake-thread-001", turns: [] } } }) + "\n");
      } else if (message.method === "thread/resume") {
        process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } }) + "\n");
      } else if (message.method === "turn/start") {
        const text = message.params.input?.[0]?.text || "";
        const second = text.includes("SECOND");
        const turnId = second ? "turn-002" : "turn-001";
        const reply = second ? "SECOND_OK" : "FIRST_OK";
        process.stdout.write(JSON.stringify({ id: message.id, result: { turn: { id: turnId, items: [], status: "inProgress" } } }) + "\n");
        process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId, itemId: "agent-1", delta: reply.slice(0, 4) } }) + "\n");
        process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId, itemId: "agent-1", delta: reply.slice(4) } }) + "\n");
        process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: message.params.threadId, turnId, item: { id: "search-1", type: "webSearch" } } }) + "\n");
        process.stdout.write(JSON.stringify({ method: "thread/tokenUsage/updated", params: {
          threadId: message.params.threadId,
          turnId,
          tokenUsage: {
            last: { inputTokens: second ? 200 : 100, cachedInputTokens: 50, outputTokens: 10, reasoningOutputTokens: 2, totalTokens: second ? 212 : 112 },
            total: { inputTokens: second ? 300 : 100, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 4, totalTokens: second ? 324 : 114 },
            modelContextWindow: 1000000,
          },
        } }) + "\n");
        process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, items: [], status: "completed" } } }) + "\n");
      }
    }
  });
} else {
const resumeIndex = args.indexOf("resume");
const threadId = resumeIndex >= 0 ? args[resumeIndex + 1] : "fake-thread-001";

let input = "";
for await (const chunk of process.stdin) input += chunk;

process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: threadId }) + "\n");
process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: input.includes("SECOND") ? "SECOND_OK" : "FIRST_OK" },
}) + "\n");
process.stdout.write(JSON.stringify({
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: resumeIndex >= 0 ? 300 : 100,
        cached_input_tokens: 50,
        output_tokens: resumeIndex >= 0 ? 20 : 10,
        reasoning_output_tokens: resumeIndex >= 0 ? 4 : 2,
        total_tokens: resumeIndex >= 0 ? 324 : 112,
      },
      last_token_usage: {
        input_tokens: resumeIndex >= 0 ? 200 : 100,
        cached_input_tokens: 50,
        output_tokens: 10,
        reasoning_output_tokens: 2,
        total_tokens: resumeIndex >= 0 ? 212 : 112,
      },
      model_context_window: 1000000,
    },
  },
}) + "\n");
process.stdout.write(JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: resumeIndex >= 0 ? 300 : 100, cached_input_tokens: 50, output_tokens: resumeIndex >= 0 ? 20 : 10 },
}) + "\n");
}
