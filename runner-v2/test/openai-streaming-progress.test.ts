import assert from "node:assert/strict";
import test from "node:test";
import { streamOpenAIChat, streamOpenAIResponses } from "../src/openai-streaming.js";
import { activeLiveModelOutput, publishLiveModelOutput } from "../src/live-model-output.js";

const sse = (events: Array<{ event?: string; data: unknown }>) => async () => new Response(
  events.map(({ event, data }) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`).join("") + "data: [DONE]\n\n",
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

test("chat streaming separates reasoning, answer text and tool-call starts; the turn holds only content and calls", async () => {
  const live: Array<[string, string | undefined]> = [];
  const result = await streamOpenAIChat(sse([
    { data: { id: "c1", choices: [{ delta: { reasoning_content: "Read the brief " } }] } },
    { data: { choices: [{ delta: { reasoning_content: "first." } }] } },
    { data: { choices: [{ delta: { content: "Reading it." } }] } },
    { data: { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "fs_read", arguments: "{\"path\":" } }] } }] } },
    { data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"README.md\"}" } }] }, finish_reason: "tool_calls" }] } },
  ]) as typeof fetch, "https://api.example/v1/chat/completions", { method: "POST" }, (delta, channel) => live.push([delta, channel]));
  assert.deepEqual(live, [
    ["Read the brief ", "reasoning"],
    ["first.", "reasoning"],
    ["Reading it.", undefined],
    ["fs_read", "tool"],
  ]);
  assert.equal(result.choices[0]!.message.content, "Reading it.", "reasoning never enters the turn content");
  assert.deepEqual(result.choices[0]!.message.tool_calls, [{ id: "t1", function: { name: "fs_read", arguments: "{\"path\":\"README.md\"}" } }]);
});

test("responses streaming routes reasoning summaries and function-call starts to their channels", async () => {
  const live: Array<[string, string | undefined]> = [];
  await streamOpenAIResponses(sse([
    { event: "response.reasoning_summary_text.delta", data: { type: "response.reasoning_summary_text.delta", delta: "Plan the relay." } },
    { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "Planning." } },
    { event: "response.output_item.added", data: { type: "response.output_item.added", item: { type: "function_call", name: "fs_list" } } },
    { event: "response.completed", data: { type: "response.completed", response: { output: [] } } },
  ]) as typeof fetch, "https://api.example/v1/responses", { method: "POST" }, (delta, channel) => live.push([delta, channel]));
  assert.deepEqual(live, [["Plan the relay.", "reasoning"], ["Planning.", undefined], ["fs_list", "tool"]]);
});

test("an active live snapshot keeps channel segments in order and the answer text separate", () => {
  const base = { runId: "run_channels", sessionId: "s1", actor: { role: "architect" as const, id: "architect_1" }, turn: 1, attempt: 1 };
  publishLiveModelOutput({ ...base, phase: "reset", text: "" });
  publishLiveModelOutput({ ...base, phase: "delta", text: "think ", channel: "reasoning" });
  publishLiveModelOutput({ ...base, phase: "delta", text: "more", channel: "reasoning" });
  publishLiveModelOutput({ ...base, phase: "delta", text: "Answer." });
  publishLiveModelOutput({ ...base, phase: "delta", text: "fs_read", channel: "tool" });
  const [active] = activeLiveModelOutput("run_channels");
  assert.equal(active!.text, "Answer.");
  assert.deepEqual(active!.segments, [
    { channel: "reasoning", text: "think more" },
    { channel: "text", text: "Answer." },
    { channel: "tool", text: "fs_read" },
  ]);
});
