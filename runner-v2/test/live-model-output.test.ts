import assert from "node:assert/strict";
import test from "node:test";
import { AccountRunnerModel } from "../src/account-runner-model.js";
import { runAgentLoop } from "../src/agent-loop.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { OpenAICompatibleModel } from "../src/openai-compatible-model.js";
import { AnthropicModel } from "../src/anthropic-model.js";
import { GoogleModel } from "../src/google-model.js";
import { publishLiveModelOutput, activeLiveModelOutput, recentLiveModelOutput } from "../src/live-model-output.js";
import type { AgentModelRequest } from "../src/agent-contracts.js";

function sse(events: Array<Record<string, unknown>>, type = "message"): Response {
  const body = events.map((event) => `event: ${typeof event.type === "string" ? event.type : type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
function request(onTextDelta: (value: string) => void): AgentModelRequest {
  return { sessionId: "test", messages: [{ id: "u", role: "user", content: "hello" }], tools: [], onTextDelta };
}
test("native live hub keeps roles and bounds replay; retry resets active output", () => {
  const runId = `test-live-${Date.now()}`;
  const actor = { role: "worker" as const, id: "w1" };
  const base = { runId, sessionId: "w1:session", actor, turn: 2 };
  publishLiveModelOutput({ ...base, attempt: 1, phase: "reset", text: "" });
  publishLiveModelOutput({ ...base, attempt: 1, phase: "delta", text: "part 1" });
  assert.equal(activeLiveModelOutput(runId)[0]?.text, "part 1");
  publishLiveModelOutput({ ...base, attempt: 2, phase: "reset", text: "" });
  publishLiveModelOutput({ ...base, attempt: 2, phase: "delta", text: "part 2" });
  assert.equal(activeLiveModelOutput(runId)[0]?.text, "part 2");
  publishLiveModelOutput({ ...base, attempt: 2, phase: "discard", text: "" });
  assert.equal(activeLiveModelOutput(runId).length, 0);
  assert.equal(recentLiveModelOutput(runId, 2).length, 3);
});
test("OpenAI chat SSE streams visible text and assembles tool calls", async () => {
  const received: string[] = [];
  const provider = new OpenAICompatibleModel({ baseUrl: "https://example.test", apiKey: "test",
    modelId: "model", fetch: async (_url, init) => {
      assert.equal(JSON.parse(init?.body as string).stream, true);
      return sse([
        { choices: [{ delta: { content: "hello " } }] },
        { choices: [{ delta: { content: "world" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call1", function: { name: "do_work", arguments: '{"a":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 9, completion_tokens: 5 } },
      ]);
    } });
  const turn = await provider.complete(request((x) => received.push(x)));
  assert.deepEqual(received, ["hello ", "world", "\n-> calling do_work\n"], "tool-call starts show in the live feed");
  assert.equal(turn.blocks[0]?.type, "text");
  assert.equal(turn.blocks[1]?.type, "tool_call");
  assert.equal(turn.stopReason, "tool_calls");
  assert.equal(turn.usage?.outputTokens, 5);
});
test("OpenAI Responses SSE emits deltas and waits for authoritative completed output", async () => {
  const received: string[] = [];
  const provider = new OpenAICompatibleModel({ baseUrl: "https://example.test", apiKey: "test",
    modelId: "model", protocol: "responses", fetch: async (_url, init) => {
      assert.equal(JSON.parse(init?.body as string).stream, true);
      return sse([
        { type: "response.output_text.delta", delta: "hi" },
        { type: "response.completed", response: { output: [
          { type: "message", content: [{ type: "output_text", text: "hi" }] },
          { type: "function_call", name: "do_work", call_id: "t1", arguments: "{}" },
        ], usage: { input_tokens: 8, output_tokens: 3 } } },
      ]);
    } });
  const turn = await provider.complete(request((x) => received.push(x)));
  assert.deepEqual(received, ["hi"]);
  assert.equal(turn.blocks.length, 2);
  assert.equal(turn.stopReason, "tool_calls");
  assert.equal(turn.usage?.outputTokens, 3);
});
test("Anthropic SSE emits text, not tool argument fragments", async () => {
  const received: string[] = [];
  const provider = new AnthropicModel({ apiKey: "test", modelId: "claude", fetch: async (_url, init) => {
    assert.equal(JSON.parse(init?.body as string).stream, true);
    return sse([
      { type: "message_start", message: { id: "m1", usage: { input_tokens: 3 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "do_work" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"x":1}' } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } },
    ]);
  } });
  const turn = await provider.complete(request((x) => received.push(x)));
  assert.deepEqual(received, ["hello"]);
  assert.equal(turn.stopReason, "tool_calls");
  assert.equal(turn.usage?.outputTokens, 8);
});
test("Gemini SSE streams text and preserves function calls", async () => {
  const received: string[] = [];
  const provider = new GoogleModel({ apiKey: "test", modelId: "gemini", fetch: async (url) => {
    assert.ok(String(url).includes(":streamGenerateContent?alt=sse"));
    return sse([
      { candidates: [{ content: { parts: [{ text: "private reasoning", thought: true }, { text: "hello" }] } }] },
      { candidates: [{ finishReason: "STOP", content: { parts: [{ functionCall: { name: "do_work", args: {} } }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 8 } },
    ]);
  } });
  const turn = await provider.complete(request((x) => received.push(x)));
  assert.deepEqual(received, ["hello"]);
  assert.equal(turn.stopReason, "tool_calls");
});

test("account-runner streaming hides TOOL_CALL argument records split across frames", async () => {
  const received: string[] = [];
  const tool = { name: "fs.read", description: "Read", inputSchema: { type: "object" },
    readOnly: true as const, effect: "none" as const };
  const provider = new AccountRunnerModel({
    baseUrl: "https://example.test", runnerPath: "chatgpt", runnerToken: "secret",
    modelId: "model", fetch: async () => sse([
      { type: "token", content: "Planning actions.\nTOO" },
      { type: "token", content: 'L_CALL {"id":"call1","name":"fs_read","arguments":{"token":"private"}}' },
      { type: "done" },
    ]),
  });
  const turn = await provider.complete({ ...request((x) => received.push(x)), tools: [tool] });
  assert.equal(turn.stopReason, "tool_calls");
  assert.equal(turn.blocks.at(-1)?.type, "tool_call");
  assert.equal(received.join(""), "Planning actions.\n");
  assert.ok(!received.join("").includes("private"));
});

test("agent loop exposes streaming output before a turn completes without persisting it", async () => {
  const runId = `stream-loop-${Date.now()}`;
  const actor = { role: "subagent" as const, id: "sub1" };
  let sawPartialDuringRequest = false;
  const result = await runAgentLoop({
    model: {
      complete: async (request) => {
        request.onTextDelta?.("hello ");
        request.onTextDelta?.("world");
        sawPartialDuringRequest = activeLiveModelOutput(runId).some((event) =>
          event.actor.role === "subagent" && event.text === "hello world");
        return { blocks: [{ type: "text" as const, text: "hello world" }], stopReason: "end_turn" as const };
      },
    },
    registry: new ToolRegistry(),
    context: { runId, sessionId: "sub1-session", actor },
    initialMessages: [{ id: "system", role: "system", content: "Explain the task" }],
    maxTurns: 1,
  });
  assert.equal(result.status, "suspended");
  assert.equal(sawPartialDuringRequest, true);
  assert.equal(activeLiveModelOutput(runId).length, 0);
  assert.deepEqual(recentLiveModelOutput(runId, 0).map((event) => event.phase),
    ["reset", "delta", "delta", "finish"]);
});
