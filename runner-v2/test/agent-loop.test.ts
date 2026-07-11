import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentMessage,
  AgentModel,
  AgentModelRequest,
  ModelTurn,
  NativeTool,
} from "../src/agent-contracts.js";
import { runAgentLoop } from "../src/agent-loop.js";
import { ToolRegistry } from "../src/tool-registry.js";

class ScriptedModel implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  constructor(private readonly turns: Array<ModelTurn | Error>) {}
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const turn = this.turns.shift();
    if (!turn) throw new Error("script exhausted");
    if (turn instanceof Error) throw turn;
    return turn;
  }
}

const initialMessages: AgentMessage[] = [
  { id: "system_1", role: "system", content: "Use tools." },
  { id: "user_1", role: "user", content: "Implement the task." },
];

test("prose completion and model EOF never complete a task", async () => {
  const model = new ScriptedModel([
    {
      blocks: [{ type: "text", text: "Done. Everything is complete." }],
      stopReason: "end_turn",
    },
  ]);
  const result = await runAgentLoop({
    model,
    registry: new ToolRegistry(),
    context: context(),
    initialMessages,
  });
  assert.equal(result.status, "suspended");
  assert.equal(result.reason, "model_ended_without_lifecycle");
  assert.equal(result.turns, 1);
});

test("native tool results feed the next turn and only submit_task submits work", async () => {
  const registry = new ToolRegistry();
  registry.register(textTool("read_file", "file contents"));
  registry.register(submitTool());
  const model = new ScriptedModel([
    {
      blocks: [
        { type: "text", text: "I will inspect first." },
        { type: "tool_call", callId: "read_1", name: "read_file", arguments: {} },
      ],
      stopReason: "tool_calls",
    },
    {
      blocks: [
        {
          type: "tool_call",
          callId: "submit_1",
          name: "submit_task",
          arguments: { changeSetId: "changeset_1" },
        },
      ],
      stopReason: "tool_calls",
    },
  ]);
  const result = await runAgentLoop({
    model,
    registry,
    context: context(),
    initialMessages,
  });
  assert.equal(result.status, "submitted");
  assert.equal(result.changeSetId, "changeset_1");
  assert.equal(model.requests.length, 2);
  const secondRequest = model.requests[1];
  const toolMessage = secondRequest.messages.find(
    (message) => message.role === "tool"
  );
  assert.equal(
    typeof toolMessage?.content === "object" &&
      !Array.isArray(toolMessage.content) &&
      toolMessage.content.content[0].type === "text"
      ? toolMessage.content.content[0].text
      : null,
    "file contents"
  );
});

test("duplicate call IDs suspend before the repeated tool executes", async () => {
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register(textTool("read_file", "content", () => executions++));
  const duplicateTurn: ModelTurn = {
    blocks: [
      { type: "tool_call", callId: "same", name: "read_file", arguments: {} },
    ],
    stopReason: "tool_calls",
  };
  const model = new ScriptedModel([duplicateTurn, duplicateTurn]);
  const result = await runAgentLoop({
    model,
    registry,
    context: context(),
    initialMessages,
  });
  assert.equal(result.status, "suspended");
  assert.equal(result.reason, "protocol_error");
  assert.equal(executions, 1);
});

test("provider errors and hard turn limits suspend with resumable messages", async () => {
  const providerFailure = await runAgentLoop({
    model: new ScriptedModel([new Error("provider unavailable")]),
    registry: new ToolRegistry(),
    context: context(),
    initialMessages,
  });
  assert.equal(providerFailure.status, "suspended");
  assert.equal(providerFailure.reason, "provider_error");
  assert.match(providerFailure.error ?? "", /provider unavailable/);

  const registry = new ToolRegistry();
  registry.register(textTool("read_file", "content"));
  const limited = await runAgentLoop({
    model: new ScriptedModel([
      {
        blocks: [
          { type: "tool_call", callId: "one", name: "read_file", arguments: {} },
        ],
        stopReason: "tool_calls",
      },
    ]),
    registry,
    context: context(),
    initialMessages,
    maxTurns: 1,
  });
  assert.equal(limited.status, "suspended");
  assert.equal(limited.reason, "turn_limit");
});

test("restart executes a persisted pending tool call before another model turn", async () => {
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register(textTool("read_file", "recovered content", () => executions++));
  registry.register(submitTool());
  const resumedMessages: AgentMessage[] = [
    ...initialMessages,
    {
      id: "assistant_pending",
      role: "assistant",
      content: [
        {
          type: "tool_call",
          callId: "pending_read",
          name: "read_file",
          arguments: {},
        },
      ],
    },
  ];
  const model = new ScriptedModel([
    {
      blocks: [
        {
          type: "tool_call",
          callId: "submit_after_recovery",
          name: "submit_task",
          arguments: { changeSetId: "changeset_recovered" },
        },
      ],
      stopReason: "tool_calls",
    },
  ]);
  const result = await runAgentLoop({
    model,
    registry,
    context: context(),
    initialMessages: resumedMessages,
  });
  assert.equal(executions, 1);
  assert.equal(result.status, "submitted");
  assert.equal(model.requests.length, 1);
  assert.equal(
    model.requests[0].messages.some(
      (message) =>
        message.role === "tool" &&
        typeof message.content === "object" &&
        !Array.isArray(message.content) &&
        message.content.callId === "pending_read"
    ),
    true
  );
});

test("checkpoint failure suspends before a newly proposed tool side effect", async () => {
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register(textTool("write_file", "written", () => executions++));
  const result = await runAgentLoop({
    model: new ScriptedModel([
      {
        blocks: [
          {
            type: "tool_call",
            callId: "write_1",
            name: "write_file",
            arguments: {},
          },
        ],
        stopReason: "tool_calls",
      },
    ]),
    registry,
    context: context(),
    initialMessages,
    onCheckpoint: async () => {
      throw new Error("disk unavailable");
    },
  });
  assert.equal(result.status, "suspended");
  assert.equal(result.reason, "checkpoint_error");
  assert.equal(executions, 0);
});

function context() {
  return {
    runId: "run_1",
    sessionId: "session_1",
    actor: { role: "worker" as const, id: "worker_1" },
  };
}

function textTool(
  name: string,
  output: string,
  onExecute: () => void = () => undefined
): NativeTool<Record<string, never>> {
  return {
    definition: {
      name,
      description: "Read text",
      inputSchema: { type: "object", additionalProperties: false },
      readOnly: true,
      effect: "none",
    },
    validate: () => ({ ok: true, value: {} }),
    execute: async () => {
      onExecute();
      return { content: [{ type: "text", text: output }], isError: false };
    },
  };
}

function submitTool(): NativeTool<{ changeSetId: string }> {
  return {
    definition: {
      name: "submit_task",
      description: "Submit a typed change set",
      inputSchema: { type: "object" },
      readOnly: false,
      effect: "workspace",
      lifecycle: true,
    },
    validate: (input) =>
      typeof input === "object" &&
      input !== null &&
      typeof (input as { changeSetId?: unknown }).changeSetId === "string"
        ? { ok: true, value: input as { changeSetId: string } }
        : { ok: false, issues: ["changeSetId is required"] },
    execute: async (input) => ({
      content: [{ type: "text", text: `Submitted ${input.changeSetId}` }],
      isError: false,
      lifecycle: { type: "submit_task", changeSetId: input.changeSetId },
    }),
  };
}
