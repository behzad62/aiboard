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
