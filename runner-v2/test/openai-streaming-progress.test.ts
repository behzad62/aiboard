import assert from "node:assert/strict";
import test from "node:test";
import { streamOpenAIChat, streamOpenAIResponses } from "../src/openai-streaming.js";

const sse = (events: Array<{ event?: string; data: unknown }>) => async () => new Response(
  events.map(({ event, data }) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`).join("") + "data: [DONE]\n\n",
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

test("chat streaming shows reasoning and tool-call starts live, but the turn holds only content and calls", async () => {
  const live: string[] = [];
  const result = await streamOpenAIChat(sse([
    { data: { id: "c1", choices: [{ delta: { reasoning_content: "Read the brief " } }] } },
    { data: { choices: [{ delta: { reasoning_content: "first." } }] } },
    { data: { choices: [{ delta: { content: "Reading it." } }] } },
    { data: { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "fs_read", arguments: "{\"path\":" } }] } }] } },
    { data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"README.md\"}" } }] }, finish_reason: "tool_calls" }] } },
  ]) as typeof fetch, "https://api.example/v1/chat/completions", { method: "POST" }, (delta) => live.push(delta));
  const shown = live.join("");
  assert.match(shown, /^Thinking: Read the brief first\./);
  assert.match(shown, /Reading it\./);
  assert.match(shown, /-> calling fs_read/);
  assert.equal(result.choices[0]!.message.content, "Reading it.", "reasoning never enters the turn content");
  assert.deepEqual(result.choices[0]!.message.tool_calls, [{ id: "t1", function: { name: "fs_read", arguments: "{\"path\":\"README.md\"}" } }]);
});

test("responses streaming shows reasoning summaries and function-call starts live", async () => {
  const live: string[] = [];
  await streamOpenAIResponses(sse([
    { event: "response.reasoning_summary_text.delta", data: { type: "response.reasoning_summary_text.delta", delta: "Plan the relay." } },
    { event: "response.output_item.added", data: { type: "response.output_item.added", item: { type: "function_call", name: "fs_list" } } },
    { event: "response.completed", data: { type: "response.completed", response: { output: [] } } },
  ]) as typeof fetch, "https://api.example/v1/responses", { method: "POST" }, (delta) => live.push(delta));
  assert.match(live.join(""), /^Thinking: Plan the relay\.\n-> calling fs_list\n$/);
});
