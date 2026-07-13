import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
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
import { AccountRunnerModel } from "../src/account-runner-model.js";

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

test("account-runner textual tool records execute through the agent loop", async () => {
  let requestCount = 0;
  let readExecutions = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = requestCount === 1
      ? {
          type: "token",
          content: 'TOOL_CALL {"id":"read_text","name":"read_file","arguments":{}}',
        }
      : {
          type: "tool_call",
          toolCall: {
            id: "submit_native",
            name: "submit_task",
            arguments: { changeSetId: "changeset_textual_recovery" },
          },
        };
    response.end(`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify({ type: "done" })}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const registry = new ToolRegistry();
    registry.register(textTool("read_file", "file contents", () => readExecutions++));
    registry.register(submitTool());
    const result = await runAgentLoop({
      model: new AccountRunnerModel({
        baseUrl: `http://127.0.0.1:${address.port}`,
        runnerPath: "chatgpt",
        runnerToken: "local-token",
        modelId: "gpt-5.4",
      }),
      registry,
      context: context(),
      initialMessages,
    });

    assert.equal(result.status, "submitted");
    assert.equal(result.changeSetId, "changeset_textual_recovery");
    assert.equal(readExecutions, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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

test("sustained read-only turns warn once and suspend without a further model call", async () => {
  const registry = new ToolRegistry();
  registry.register(textTool("read_file", "content"));
  const model = new ScriptedModel(Array.from({ length: 5 }, (_, index) => ({
    blocks: [{
      type: "tool_call" as const,
      callId: `read_stall_${index}`,
      name: "read_file",
      arguments: {},
    }],
    stopReason: "tool_calls" as const,
  })));
  const result = await runAgentLoop({
    model,
    registry,
    context: context(),
    initialMessages,
    readOnlyStall: { warnTurns: 3, suspendTurns: 5 },
  });
  assert.equal(result.status, "suspended");
  assert.equal(result.reason, "read_only_stall");
  assert.equal(model.requests.length, 5);
  assert.match(
    String(model.requests[3].messages.find((message) =>
      message.id.startsWith("progress-reminder:")
    )?.content ?? ""),
    /does not decide whether the task is complete/i
  );
});

test("the default worker guard warns after eight unproductive turns", async () => {
  const registry = new ToolRegistry();
  registry.register(textTool("read_file", "content"));
  registry.register(mutationTool());
  registry.register(submitTool());
  const model = new ScriptedModel([
    ...Array.from({ length: 8 }, (_, index) => ({
      blocks: [{
        type: "tool_call" as const,
        callId: `default_read_${index}`,
        name: "read_file",
        arguments: {},
      }],
      stopReason: "tool_calls" as const,
    })),
    {
      blocks: [{ type: "tool_call", callId: "default_mutate", name: "write_file", arguments: {} }],
      stopReason: "tool_calls" as const,
    },
    {
      blocks: [{
        type: "tool_call",
        callId: "default_submit",
        name: "submit_task",
        arguments: { changeSetId: "changeset_default_guard" },
      }],
      stopReason: "tool_calls" as const,
    },
  ]);
  const result = await runAgentLoop({
    model,
    registry,
    context: context(),
    initialMessages,
  });
  assert.equal(result.status, "submitted");
  assert.match(
    String(model.requests[8].messages.find((message) =>
      message.id.startsWith("progress-reminder:")
    )?.content ?? ""),
    /last 8 model turns/i
  );
});

test("a workspace mutation resets the mechanical read-only streak", async () => {
  const registry = new ToolRegistry();
  registry.register(textTool("read_file", "content"));
  registry.register(mutationTool());
  registry.register(submitTool());
  const readTurns = (prefix: string) => Array.from({ length: 3 }, (_, index) => ({
    blocks: [{
      type: "tool_call" as const,
      callId: `${prefix}_${index}`,
      name: "read_file",
      arguments: {},
    }],
    stopReason: "tool_calls" as const,
  }));
  const model = new ScriptedModel([
    ...readTurns("before"),
    {
      blocks: [{ type: "tool_call", callId: "mutate", name: "write_file", arguments: {} }],
      stopReason: "tool_calls",
    },
    ...readTurns("after"),
    {
      blocks: [{
        type: "tool_call",
        callId: "submit_after_reset",
        name: "submit_task",
        arguments: { changeSetId: "changeset_after_reset" },
      }],
      stopReason: "tool_calls",
    },
  ]);
  const result = await runAgentLoop({
    model,
    registry,
    context: context(),
    initialMessages,
    readOnlyStall: { warnTurns: 3, suspendTurns: 5 },
  });
  assert.equal(result.status, "submitted");
  assert.equal(result.changeSetId, "changeset_after_reset");
});

test("the default read-only stall guard does not constrain the Architect", async () => {
  const registry = new ToolRegistry();
  registry.register(textTool("read_file", "content"));
  const model = new ScriptedModel([
    ...Array.from({ length: 20 }, (_, index) => ({
      blocks: [{
        type: "tool_call" as const,
        callId: `architect_read_${index}`,
        name: "read_file",
        arguments: {},
      }],
      stopReason: "tool_calls" as const,
    })),
    { blocks: [{ type: "text", text: "still reasoning" }], stopReason: "end_turn" },
  ]);
  const result = await runAgentLoop({
    model,
    registry,
    context: {
      ...context(),
      actor: { role: "architect", id: "architect_1" },
    },
    initialMessages,
  });
  assert.equal(result.status, "suspended");
  assert.equal(result.reason, "model_ended_without_lifecycle");
  assert.equal(model.requests.length, 21);
});

test("a recovered pending read suspends at the durable threshold before another model call", async () => {
  const registry = new ToolRegistry();
  registry.register(textTool("read_file", "content"));
  const resumedMessages: AgentMessage[] = [...initialMessages];
  for (let index = 0; index < 4; index += 1) {
    const callId = `completed_read_${index}`;
    resumedMessages.push({
      id: `assistant_completed_${index}`,
      role: "assistant",
      content: [{ type: "tool_call", callId, name: "read_file", arguments: {} }],
    });
    resumedMessages.push({
      id: `tool_completed_${index}`,
      role: "tool",
      content: {
        callId,
        toolName: "read_file",
        content: [{ type: "text", text: "content" }],
        isError: false,
      },
    });
  }
  resumedMessages.push({
    id: "assistant_pending_threshold",
    role: "assistant",
    content: [{
      type: "tool_call",
      callId: "pending_threshold_read",
      name: "read_file",
      arguments: {},
    }],
  });
  const model = new ScriptedModel([]);
  const result = await runAgentLoop({
    model,
    registry,
    context: context(),
    initialMessages: resumedMessages,
    readOnlyStall: { warnTurns: 3, suspendTurns: 5 },
  });
  assert.equal(result.status, "suspended");
  assert.equal(result.reason, "read_only_stall");
  assert.equal(model.requests.length, 0);
});

test("a failed mutation does not reset the mechanical no-progress streak", async () => {
  const registry = new ToolRegistry();
  registry.register(textTool("read_file", "content"));
  registry.register(failingMutationTool());
  const read = (callId: string) => ({
    blocks: [{ type: "tool_call" as const, callId, name: "read_file", arguments: {} }],
    stopReason: "tool_calls" as const,
  });
  const model = new ScriptedModel([
    read("read_1"), read("read_2"), read("read_3"),
    {
      blocks: [{
        type: "tool_call",
        callId: "failed_mutation",
        name: "write_file",
        arguments: {},
      }],
      stopReason: "tool_calls",
    },
    read("read_4"), read("read_5"),
  ]);
  const result = await runAgentLoop({
    model,
    registry,
    context: context(),
    initialMessages,
    readOnlyStall: { warnTurns: 3, suspendTurns: 5 },
  });
  assert.equal(result.status, "suspended");
  assert.equal(result.reason, "read_only_stall");
  assert.equal(model.requests.length, 5);
});

test("repeated equivalent evidence failures advise a worker to seek Architect guidance", async () => {
  const registry = new ToolRegistry();
  registry.register(failingEvidenceTool());
  registry.register(submitTool());
  const model = new ScriptedModel([
    ...Array.from({ length: 4 }, (_, index) => ({
      blocks: [{
        type: "tool_call" as const,
        callId: `failed_evidence_${index}`,
        name: "run_evidence_command",
        arguments: {
          label: `renderer-rerun-${index}`,
          command: "node",
          args: ["--test", "tests/renderer.test.mjs"],
          cwd: "C:\\project",
        },
      }],
      stopReason: "tool_calls" as const,
    })),
    {
      blocks: [{
        type: "tool_call",
        callId: "submit_after_failure_advice",
        name: "submit_task",
        arguments: { changeSetId: "changeset_after_failure_advice" },
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
  assert.equal(result.status, "submitted");
  const reminder = model.requests[3].messages.find((message) =>
    message.id.startsWith("evidence-failure-reminder:")
  );
  assert.match(String(reminder?.content ?? ""), /failed 3 times/i);
  assert.match(String(reminder?.content ?? ""), /ask the Architect/i);
  assert.match(String(reminder?.content ?? ""), /does not decide/i);
  const refreshedReminder = model.requests[4].messages.find((message) =>
    message.id.startsWith("evidence-failure-reminder:")
  );
  assert.match(String(refreshedReminder?.content ?? ""), /failed 4 times/i);
});

test("eight equivalent evidence failures suspend the worker for Architect resolution", async () => {
  const registry = new ToolRegistry();
  registry.register(failingEvidenceTool());
  const model = new ScriptedModel(Array.from({ length: 8 }, (_, index) => ({
    blocks: [{
      type: "tool_call" as const,
      callId: `exhausted_evidence_${index}`,
      name: "run_evidence_command",
      arguments: {
        label: `same-check-${index}`,
        command: "node",
        args: ["--test", "tests/renderer.test.mjs"],
        cwd: "C:\\project",
      },
    }],
    stopReason: "tool_calls" as const,
  })));
  const result = await runAgentLoop({
    model,
    registry,
    context: context(),
    initialMessages,
  });
  assert.equal(result.status, "suspended");
  assert.equal(result.reason, "repeated_evidence_failure");
  assert.match(result.error ?? "", /failed 8 times/i);
  assert.equal(model.requests.length, 8);
});

test("restart still escalates when the eighth-failure reminder is already durable", async () => {
  const signature = createHash("sha256").update(JSON.stringify({
    command: "node",
    args: ["--test", "tests/renderer.test.mjs"],
    cwd: "C:\\project",
  })).digest("hex").slice(0, 16);
  const history: AgentMessage[] = [...initialMessages];
  for (let index = 0; index < 8; index += 1) {
    const callId = `recovered_failed_evidence_${index}`;
    history.push({
      id: `assistant_${callId}`,
      role: "assistant",
      content: [{
        type: "tool_call",
        callId,
        name: "run_evidence_command",
        arguments: {},
      }],
    });
    history.push({
      id: `tool_${callId}`,
      role: "tool",
      content: {
        callId,
        toolName: "run_evidence_command",
        content: [{
          type: "json",
          value: {
            fact: {
              kind: "command",
              command: "node",
              args: ["--test", "tests/renderer.test.mjs"],
              cwd: "C:\\project",
              exitCode: 1,
            },
          },
        }],
        isError: false,
      },
    });
  }
  history.push({
    id: `evidence-failure-reminder:${signature}:8`,
    role: "user",
    content: "The same command failed 8 times.",
  });
  const model = new ScriptedModel([]);
  const result = await runAgentLoop({
    model,
    registry: new ToolRegistry(),
    context: context(),
    initialMessages: history,
  });
  assert.equal(result.status, "suspended");
  assert.equal(result.reason, "repeated_evidence_failure");
  assert.equal(model.requests.length, 0);
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
        arguments: index === 40
          ? {
              path: `file-${index}.ts`,
              content: `${"😀".repeat(5_000)}END`,
              apiKey: "must-not-survive-compaction",
            }
          : { path: `file-${index}.ts` },
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
  assert.match(
    summary.content,
    /"arguments":\{"path":"file-0\.ts"\}/,
    "ordinary tool arguments survive working-set compaction"
  );
  assert.match(summary.content, /argumentsSummary/);
  assert.match(summary.content, /file-40\.ts/);
  const oversizedArgumentBytes = Buffer.byteLength(JSON.stringify({
    path: "file-40.ts",
    content: `${"😀".repeat(5_000)}END`,
    apiKey: "[REDACTED]",
  }));
  assert.match(summary.content, new RegExp(`"byteLength":${oversizedArgumentBytes}`));
  assert.equal(
    summary.content.includes("😀".repeat(1_000)),
    false,
    "large tool arguments are represented by a bounded summary"
  );
  assert.equal(summary.content.includes("must-not-survive-compaction"), false);
  assert.equal(summary.content.includes("�"), false, "UTF-8 previews keep code points intact");
  for (const line of summary.content.split("\n").filter((line) => line.startsWith("{"))) {
    assert.equal(
      Buffer.byteLength(line) <= 8 * 1024,
      true,
      "each compacted fact remains independently bounded"
    );
  }
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

function mutationTool(): NativeTool<Record<string, never>> {
  return {
    definition: {
      name: "write_file",
      description: "Change workspace state",
      inputSchema: { type: "object", additionalProperties: false },
      readOnly: false,
      effect: "workspace",
    },
    validate: () => ({ ok: true, value: {} }),
    execute: async () => ({
      content: [{ type: "text", text: "written" }],
      isError: false,
    }),
  };
}

function failingMutationTool(): NativeTool<Record<string, never>> {
  return {
    ...mutationTool(),
    execute: async () => ({
      content: [{ type: "text", text: "write failed" }],
      isError: true,
      error: { code: "write_failed", message: "write failed" },
    }),
  };
}

function failingEvidenceTool(): NativeTool<Record<string, unknown>> {
  return {
    definition: {
      name: "run_evidence_command",
      description: "Run deterministic evidence",
      inputSchema: { type: "object" },
      readOnly: true,
      effect: "none",
    },
    validate: (input) => ({
      ok: true,
      value: input as Record<string, unknown>,
    }),
    execute: async (input) => ({
      content: [{
        type: "json",
        value: {
          fact: {
            kind: "command",
            label: input.label,
            command: input.command,
            args: input.args,
            cwd: input.cwd,
            exitCode: 1,
          },
        },
      }],
      isError: false,
    }),
  };
}
