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
import { compactAgentMessages } from "../src/agent-loop.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { BudgetExceededError } from "../src/budget-ledger.js";

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

test("model budget exhaustion is a typed budget suspension, not a provider failure", async () => {
  const model = new ScriptedModel([
    new BudgetExceededError("run_1", "modelCalls", 201, 200),
  ]);
  const result = await runAgentLoop({
    model,
    registry: new ToolRegistry(),
    context: context(),
    initialMessages,
  });
  assert.equal(result.status, "suspended");
  assert.equal(result.reason, "budget_exhausted");
  assert.match(result.error ?? "", /modelCalls/);
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

test("independent read-only tool calls execute concurrently and preserve result order", async () => {
  let active = 0;
  let maxActive = 0;
  const registry = new ToolRegistry();
  for (const name of ["read_alpha", "read_beta"]) {
    registry.register({
      definition: {
        name,
        description: `Run ${name}`,
        inputSchema: { type: "object" },
        readOnly: true,
        effect: "none",
      },
      validate: () => ({ ok: true, value: {} }),
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        return { content: [{ type: "text" as const, text: name }], isError: false };
      },
    });
  }
  const model = new ScriptedModel([
    {
      blocks: [
        { type: "tool_call", callId: "alpha", name: "read_alpha", arguments: {} },
        { type: "tool_call", callId: "beta", name: "read_beta", arguments: {} },
      ],
      stopReason: "tool_calls",
    },
    { blocks: [{ type: "text", text: "Observed." }], stopReason: "end_turn" },
  ]);
  const result = await runAgentLoop({
    model,
    registry,
    context: context(),
    initialMessages,
  });
  assert.equal(result.status, "suspended");
  assert.equal(maxActive, 2);
  const toolIds = result.messages
    .filter((message) => message.role === "tool")
    .map((message) =>
      typeof message.content === "object" && !Array.isArray(message.content)
        ? message.content.callId
        : ""
    );
  assert.deepEqual(toolIds, ["alpha", "beta"]);
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
  const providerError = Object.assign(new Error("provider unavailable"), {
    status: 429,
    code: "usage_limit_reached",
    retryAfterMs: 60_000,
  });
  const providerFailure = await runAgentLoop({
    model: new ScriptedModel([providerError]),
    registry: new ToolRegistry(),
    context: context(),
    initialMessages,
  });
  assert.equal(providerFailure.status, "suspended");
  assert.equal(providerFailure.reason, "provider_error");
  assert.match(providerFailure.error ?? "", /provider unavailable/);
  assert.deepEqual(providerFailure.providerError, {
    name: "Error",
    status: 429,
    code: "usage_limit_reached",
    retryAfterMs: 60_000,
  });

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

test("a resumed checkpoint receives a fresh per-invocation turn allowance", async () => {
  const registry = new ToolRegistry();
  registry.register(submitTool());
  const history: AgentMessage[] = [
    ...initialMessages,
    ...Array.from({ length: 50 }, (_, index): AgentMessage => ({
      id: `assistant_history_${index}`,
      role: "assistant",
      content: [{ type: "text", text: `Prior turn ${index}` }],
    })),
  ];
  const model = new ScriptedModel([{
    blocks: [{
      type: "tool_call",
      callId: "submit_after_resume",
      name: "submit_task",
      arguments: { changeSetId: "changeset_resumed" },
    }],
    stopReason: "tool_calls",
  }]);
  const result = await runAgentLoop({
    model,
    registry,
    context: context(),
    initialMessages: history,
    maxTurns: 1,
  });
  assert.equal(result.status, "submitted");
  assert.equal(model.requests.length, 1);
});

test("a hard tool budget error suspends before another model call", async () => {
  const registry = new ToolRegistry();
  registry.register({
    definition: {
      name: "budgeted_tool",
      description: "Exercise the hard tool budget",
      inputSchema: { type: "object" },
      readOnly: true,
      effect: "none",
    },
    validate: () => ({ ok: true, value: {} }),
    execute: async () => ({
      content: [{ type: "text", text: "Tool-call budget reached." }],
      isError: true,
      error: { code: "budget_exhausted", message: "Tool-call budget reached." },
    }),
  });
  const model = new ScriptedModel([
    {
      blocks: [{
        type: "tool_call",
        callId: "budget_1",
        name: "budgeted_tool",
        arguments: {},
      }],
      stopReason: "tool_calls",
    },
    {
      blocks: [{
        type: "tool_call",
        callId: "should_not_run",
        name: "budgeted_tool",
        arguments: {},
      }],
      stopReason: "tool_calls",
    },
  ]);
  const result = await runAgentLoop({
    model,
    registry,
    context: context(),
    initialMessages,
  });
  assert.equal(result.status, "suspended");
  assert.equal(result.reason, "budget_exhausted");
  assert.equal(model.requests.length, 1);
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

test("model working context compacts deterministically without deleting raw session history", () => {
  const messages: AgentMessage[] = [
    { id: "system", role: "system", content: "Stable policy" },
    { id: "intent", role: "user", content: "Protected task intent" },
  ];
  for (let index = 0; index < 50; index += 1) {
    messages.push({
      id: `assistant-${index}`,
      role: "assistant",
      content: [{
        type: "tool_call",
        callId: `call-${index}`,
        name: "fs.read",
        arguments: { path: `file-${index}.ts` },
      }],
    });
    messages.push({
      id: `tool-${index}`,
      role: "tool",
      content: {
        callId: `call-${index}`,
        toolName: "fs.read",
        isError: false,
        content: [{ type: "text", text: `content-${index}` }],
      },
    });
  }
  const compacted = compactAgentMessages(messages, {
    maxMessages: 30,
    maxBytes: 64 * 1024,
    retainRecent: 12,
  });
  assert.equal(messages.length, 102, "raw checkpoint history is untouched");
  assert.equal(compacted.length < messages.length, true);
  assert.equal(compacted.some((message) => message.id === "system"), true);
  assert.equal(compacted.some((message) => message.id === "intent"), true);
  const summary = compacted.find((message) => message.id.startsWith("compacted-history:"));
  assert.ok(summary && typeof summary.content === "string");
  assert.match(summary.content, /COMPACTED_AGENT_HISTORY/);
  assert.deepEqual(
    compactAgentMessages(messages, { maxMessages: 30, maxBytes: 64 * 1024, retainRecent: 12 }),
    compacted,
    "same history produces byte-identical working context"
  );
});

test("working context keeps only the newest runner-owned state and resume snapshots", () => {
  const messages: AgentMessage[] = [
    { id: "system", role: "system", content: "Stable policy" },
    { id: "context:old", role: "user", content: "Old projection" },
    { id: "action-resume:1", role: "user", content: "Old action" },
    { id: "context:new", role: "user", content: "Current projection" },
    { id: "action-resume:2", role: "user", content: "Current action" },
  ];
  const working = compactAgentMessages(messages);
  assert.deepEqual(
    working.map((message) => message.id),
    ["system", "context:new", "action-resume:2"]
  );
  assert.equal(messages.length, 5, "durable raw history is not mutated");
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
