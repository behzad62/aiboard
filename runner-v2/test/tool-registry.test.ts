import assert from "node:assert/strict";
import test from "node:test";

import type { NativeTool, ToolCallBlock } from "../src/agent-contracts.js";
import {
  AgentProtocolError,
  ToolRegistry,
  type ValidationResult,
} from "../src/tool-registry.js";

function stringValue(input: unknown): ValidationResult<{ value: string }> {
  if (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { value?: unknown }).value === "string"
  ) {
    return { ok: true, value: input as { value: string } };
  }
  return { ok: false, issues: ["value must be a string"] };
}

test("tool registry exposes native schemas and executes validated calls", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  const echo: NativeTool<{ value: string }> = {
    definition: {
      name: "echo",
      description: "Echo a value",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      readOnly: true,
      effect: "none",
    },
    validate: stringValue,
    execute: async (input) => {
      executions += 1;
      return { content: [{ type: "text", text: input.value }], isError: false };
    },
  };
  registry.register(echo);
  assert.deepEqual(registry.definitions(), [echo.definition]);

  const result = await registry.invoke(
    { type: "tool_call", callId: "call_1", name: "echo", arguments: { value: "hi" } },
    { runId: "run_1", sessionId: "session_1", actor: { role: "worker", id: "worker_1" } }
  );
  assert.equal(result.isError, false);
  assert.deepEqual(result.content, [{ type: "text", text: "hi" }]);
  assert.equal(executions, 1);
});

test("unknown and malformed calls return one structured error without side effects", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    definition: {
      name: "write_value",
      description: "Write a value",
      inputSchema: { type: "object" },
      readOnly: false,
      effect: "workspace",
    },
    validate: stringValue,
    execute: async () => {
      executions += 1;
      return { content: [], isError: false };
    },
  });
  const context = {
    runId: "run_1",
    sessionId: "session_1",
    actor: { role: "worker" as const, id: "worker_1" },
  };
  const invalid = await registry.invoke(
    { type: "tool_call", callId: "call_1", name: "write_value", arguments: {} },
    context
  );
  assert.equal(invalid.isError, true);
  assert.equal(invalid.error?.code, "invalid_arguments");
  const unknown = await registry.invoke(
    { type: "tool_call", callId: "call_2", name: "missing", arguments: {} },
    context
  );
  assert.equal(unknown.isError, true);
  assert.equal(unknown.error?.code, "unknown_tool");
  assert.equal(executions, 0);
});

test("duplicate tool names and call IDs are rejected before execution", () => {
  const registry = new ToolRegistry();
  const tool: NativeTool<{ value: string }> = {
    definition: {
      name: "echo",
      description: "Echo",
      inputSchema: { type: "object" },
      readOnly: true,
      effect: "none",
    },
    validate: stringValue,
    execute: async () => ({ content: [], isError: false }),
  };
  registry.register(tool);
  assert.throws(() => registry.register(tool), /already registered/i);

  const calls: ToolCallBlock[] = [
    { type: "tool_call", callId: "same", name: "echo", arguments: { value: "1" } },
    { type: "tool_call", callId: "same", name: "echo", arguments: { value: "2" } },
  ];
  assert.throws(
    () => registry.assertUniqueCallIds(calls, new Set()),
    (error: unknown) =>
      error instanceof AgentProtocolError && error.code === "duplicate_call_id"
  );
});


test("internal tools remain invokable without being advertised to the model", async () => {
  const registry = new ToolRegistry();
  registry.register({
    definition: {
      name: "internal.patch",
      description: "Internal patch executor",
      inputSchema: { type: "object" },
      readOnly: false,
      effect: "workspace",
      modelVisible: false,
    },
    validate: () => ({ ok: true, value: {} }),
    execute: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
  });
  assert.equal(registry.definitions().some((tool) => tool.name === "internal.patch"), false);
  const result = await registry.invoke(
    { type: "tool_call", callId: "internal_1", name: "internal.patch", arguments: {} },
    { runId: "run_1", sessionId: "session_1", actor: { role: "worker", id: "worker_1" } }
  );
  assert.equal(result.isError, false);
});

test("unparseable provider arguments are reported as invalid JSON with the failure position", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    definition: { name: "draft_plan", description: "Draft", inputSchema: { type: "object" }, readOnly: false, effect: "workspace" },
    validate: stringValue,
    execute: async () => { executions += 1; return { content: [], isError: false }; },
  });
  const raw = "{\"revision\": {\"tasks\": [{\"id\": \"t1\"}, {\"id\": \"t2\"}, {\"id\": \"t3\"} }}";
  const result = await registry.invoke(
    { type: "tool_call", callId: "call_json", name: "draft_plan", arguments: { _malformedArgumentsJson: raw } },
    { runId: "run_1", sessionId: "session_1", actor: { role: "architect" as const, id: "architect_1" } },
  );
  assert.equal(result.isError, true);
  assert.equal(result.error?.code, "invalid_arguments_json");
  assert.match(result.error?.message ?? "", /not valid JSON/);
  assert.match(result.error?.message ?? "", /at character \d+ of \d+/);
  assert.doesNotMatch(result.error?.message ?? "", /revisionId is required/);
  assert.equal(executions, 0);
});

test("extra closing brackets after complete arguments are dropped; other malformed JSON is reported (tunnel run)", async () => {
  const { parseToolArgumentsJson } = await import("../src/provider-model-utils.js");
  // A 12 KB submit_task was refused for one stray "}" after an otherwise complete object.
  assert.deepEqual(parseToolArgumentsJson('{"summary":"done","items":["a"]}}'), { summary: "done", items: ["a"] });
  assert.deepEqual(parseToolArgumentsJson('{"a":{"b":[1]}}]}\n'), { a: { b: [1] } });
  assert.deepEqual(parseToolArgumentsJson('{"a":1}'), { a: 1 });
  for (const raw of ['{"a":"unterminated}', '{"a":1,}', '{"a":1} trailing', '[1]]']) {
    assert.deepEqual(parseToolArgumentsJson(raw), { _malformedArgumentsJson: raw }, raw);
  }
});

test("an unknown tool named after another tool's argument points to that tool (tunnel run)", async () => {
  // The Architect called review_task's claimDispositions argument as if it were a tool, twice.
  const { ToolRegistry } = await import("../src/tool-registry.js");
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: "review_task", description: "r", inputSchema: { type: "object", properties: { taskId: { type: "string" }, claimDispositions: { type: "array" } } }, readOnly: false, effect: "none" },
    validate: (input: unknown) => ({ ok: true, value: input }),
    execute: async () => ({ content: [], isError: false }),
  } as never);
  const result = await registry.invoke({ type: "tool_call", callId: "c1", name: "claimDispositions", arguments: {} }, { runId: "r", sessionId: "s", actor: { role: "architect", id: "a" } });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /claimDispositions is an argument of review_task\. Call review_task with it\./);
  const other = await registry.invoke({ type: "tool_call", callId: "c2", name: "nothing", arguments: {} }, { runId: "r", sessionId: "s", actor: { role: "architect", id: "a" } });
  assert.match(JSON.stringify(other.content), /Tool nothing is not registered\.(?!;)/);
});
