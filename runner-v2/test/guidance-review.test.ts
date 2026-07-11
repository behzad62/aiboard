import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentMessage,
  AgentModel,
  AgentModelRequest,
  ModelTurn,
  ToolCallBlock,
} from "../src/agent-contracts.js";
import { runAgentLoop } from "../src/agent-loop.js";
import { createArchitectTools } from "../src/architect-tools.js";
import { rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { createWorkerLifecycleTools } from "../src/worker-lifecycle-tools.js";

const now = () => "2026-07-12T00:00:00.000Z";

test("Architect and worker lifecycle tools publish complete model-facing schemas", async () => {
  await withStore(async (store) => {
    const tools = [
      ...createArchitectTools({ store, clock: now }),
      ...createWorkerLifecycleTools({ store, taskId: "task_a", clock: now }),
    ];
    const expectedRequired: Record<string, string[]> = {
      plan_tasks: ["revision", "tasks"],
      revise_task: ["taskId", "revision"],
      answer_guidance: ["requestId", "expectedVersion", "answer"],
      review_task: ["taskId", "decision", "summary", "evidenceArtifactHashes"],
      request_integration: ["taskId"],
      complete_run: ["summary"],
      ask_architect: ["requestId", "question", "blocking", "evidenceSequence"],
      challenge_guidance: ["requestId", "expectedVersion", "evidenceSequence", "reason"],
    };
    for (const tool of tools) {
      const schema = tool.definition.inputSchema as Record<string, unknown>;
      assert.equal(schema.type, "object", tool.definition.name);
      assert.deepEqual(schema.required, expectedRequired[tool.definition.name], tool.definition.name);
      assert.equal(schema.additionalProperties, false, tool.definition.name);
      assert.equal(typeof schema.properties, "object", tool.definition.name);
    }
  });
});

test("architect lifecycle changes require typed tool calls, not completion prose", async () => {
  await withStore(async (store) => {
    const registry = new ToolRegistry();
    for (const tool of createArchitectTools({ store, clock: now })) {
      registry.register(tool);
    }
    const model = new ScriptedModel([
      {
        blocks: [{ type: "text", text: "I planned and completed the build." }],
        stopReason: "end_turn",
      },
    ]);
    const result = await runAgentLoop({
      model,
      registry,
      context: architectContext(),
      initialMessages: initialMessages(),
    });
    assert.equal(result.status, "suspended");
    assert.equal(store.readRun("run_1").length, 0);

    const plan = await invoke(registry, architectContext(), "plan_tasks", {
      revision: 1,
      tasks: [
        {
          id: "task_a",
          objective: "Use any prose, including 'invalid plan', without interpretation",
          dependencies: [],
          requiredCapabilities: ["code"],
        },
      ],
    });
    assert.equal(plan.isError, false);
    assert.equal(projection(store).tasks.task_a.status, "planned");

    const invalid = await invoke(registry, architectContext(), "plan_tasks", {
      revision: 2,
      tasks: [
        { id: "dup", objective: "one", dependencies: [], requiredCapabilities: [] },
        { id: "dup", objective: "two", dependencies: [], requiredCapabilities: [] },
      ],
    });
    assert.equal(invalid.isError, true);
    assert.match(invalid.error?.message ?? "", /duplicate_task_id/);
  });
});

test("blocking guidance pauses one task while advisory guidance preserves scope", async () => {
  await withStore(async (store) => {
    seedRunningTask(store);
    const registry = new ToolRegistry();
    for (const tool of createWorkerLifecycleTools({
      store,
      taskId: "task_a",
      clock: now,
    })) {
      registry.register(tool);
    }
    const advisory = await invoke(registry, workerContext(), "ask_architect", {
      requestId: "advisory_1",
      question: "Which naming style is preferred?",
      blocking: false,
      evidenceSequence: 4,
    });
    assert.equal(advisory.isError, false);
    assert.equal(advisory.lifecycle, undefined);
    assert.equal(projection(store).tasks.task_a.status, "running");
    assert.deepEqual(projection(store).tasks.task_a.requiredCapabilities, ["code"]);

    const blocking = await invoke(registry, workerContext(), "ask_architect", {
      requestId: "blocking_1",
      question: "Which incompatible API contract should I implement?",
      blocking: true,
      evidenceSequence: 5,
    });
    assert.equal(blocking.isError, false);
    assert.deepEqual(blocking.lifecycle, {
      type: "ask_architect",
      requestId: "blocking_1",
      blocking: true,
    });
    assert.equal(projection(store).tasks.task_a.status, "waiting_guidance");
    assert.equal(projection(store).guidance.blocking_1.status, "open");
  });
});

test("guidance challenges require fresh evidence and only one challenge per version", async () => {
  await withStore(async (store) => {
    seedRunningTask(store);
    const workerRegistry = new ToolRegistry();
    for (const tool of createWorkerLifecycleTools({
      store,
      taskId: "task_a",
      clock: now,
    })) workerRegistry.register(tool);
    const architectRegistry = new ToolRegistry();
    for (const tool of createArchitectTools({ store, clock: now })) {
      architectRegistry.register(tool);
    }
    await invoke(workerRegistry, workerContext(), "ask_architect", {
      requestId: "guidance_1",
      question: "Use API A or B?",
      blocking: true,
      evidenceSequence: 10,
    });
    const answer = await invoke(architectRegistry, architectContext(), "answer_guidance", {
      requestId: "guidance_1",
      expectedVersion: 1,
      answer: "Use API A.",
    });
    assert.equal(answer.isError, false);
    assert.equal(projection(store).tasks.task_a.status, "running");

    const stale = await invoke(workerRegistry, workerContext(), "challenge_guidance", {
      requestId: "guidance_1",
      expectedVersion: 1,
      evidenceSequence: 10,
      reason: "Same evidence should not reopen it.",
    });
    assert.equal(stale.isError, true);
    assert.match(stale.error?.message ?? "", /newer evidence/i);

    const challenge = await invoke(workerRegistry, workerContext(), "challenge_guidance", {
      requestId: "guidance_1",
      expectedVersion: 1,
      evidenceSequence: 11,
      reason: "The repository shows API A was removed.",
    });
    assert.equal(challenge.isError, false);
    assert.equal(projection(store).tasks.task_a.status, "waiting_guidance");

    const duplicate = await invoke(workerRegistry, workerContext(), "challenge_guidance", {
      requestId: "guidance_1",
      expectedVersion: 1,
      evidenceSequence: 12,
      reason: "A second challenge is not allowed for this version.",
    });
    assert.equal(duplicate.isError, true);
    assert.match(duplicate.error?.message ?? "", /already challenged/i);

    await invoke(architectRegistry, architectContext(), "answer_guidance", {
      requestId: "guidance_1",
      expectedVersion: 1,
      answer: "Use API B given the new evidence.",
    });
    assert.equal(projection(store).guidance.guidance_1.version, 2);
  });
});

test("only Architect tools can approve, request integration, and complete", async () => {
  await withStore(async (store) => {
    seedSubmittedTask(store);
    const registry = new ToolRegistry();
    for (const tool of createArchitectTools({ store, clock: now })) {
      registry.register(tool);
    }
    const workerReview = await invoke(registry, workerContext(), "review_task", {
      taskId: "task_a",
      decision: "approved",
      summary: "Looks good",
      evidenceArtifactHashes: [],
    });
    assert.equal(workerReview.isError, true);
    assert.equal(projection(store).tasks.task_a.status, "submitted");

    const review = await invoke(registry, architectContext(), "review_task", {
      taskId: "task_a",
      decision: "approved",
      summary: "The change meets the task intent.",
      evidenceArtifactHashes: ["a".repeat(64)],
    });
    assert.equal(review.isError, false);
    assert.equal(projection(store).tasks.task_a.status, "approved");

    const integration = await invoke(
      registry,
      architectContext(),
      "request_integration",
      { taskId: "task_a" }
    );
    assert.equal(integration.isError, false);
    assert.equal(projection(store).tasks.task_a.status, "integrating");

    const workerComplete = await invoke(registry, workerContext(), "complete_run", {
      summary: "Done",
    });
    assert.equal(workerComplete.isError, true);
    assert.equal(projection(store).status, "running");

    const complete = await invoke(registry, architectContext(), "complete_run", {
      summary: "Architect accepts the handoff.",
    });
    assert.equal(complete.isError, false);
    assert.equal(projection(store).status, "completed");
  });
});

test("durable reducer rejects authority bypass events", async () => {
  await withStore(async (store) => {
    seedSubmittedTask(store);
    assert.throws(
      () => store.append({
        runId: "run_1",
        type: "task.transitioned",
        occurredAt: now(),
        actor: { role: "runner", id: "bypass" },
        idempotencyKey: "bypass-review",
        payload: { taskId: "task_a", status: "architect_review" },
      }),
      /only the Architect/i
    );
    assert.equal(projection(store).tasks.task_a.status, "submitted");
  });
});

class ScriptedModel implements AgentModel {
  constructor(private readonly turns: ModelTurn[]) {}
  async complete(_request: AgentModelRequest): Promise<ModelTurn> {
    const turn = this.turns.shift();
    if (!turn) throw new Error("script exhausted");
    return turn;
  }
}

async function invoke(
  registry: ToolRegistry,
  context: ReturnType<typeof architectContext> | ReturnType<typeof workerContext>,
  name: string,
  args: unknown
) {
  const call: ToolCallBlock = {
    type: "tool_call",
    callId: `${name}_${Math.random()}`,
    name,
    arguments: args,
  };
  return await registry.invoke(call, context);
}

function initialMessages(): AgentMessage[] {
  return [
    { id: "system", role: "system", content: "Use native lifecycle tools." },
    { id: "user", role: "user", content: "Build it." },
  ];
}

function architectContext() {
  return {
    runId: "run_1",
    sessionId: "architect_session",
    actor: { role: "architect" as const, id: "architect_1" },
  };
}

function workerContext() {
  return {
    runId: "run_1",
    sessionId: "worker_session",
    actor: { role: "worker" as const, id: "worker_1" },
  };
}

function projection(store: SqliteSchedulerStore) {
  return rebuildSchedulerProjection(store.readRun("run_1"));
}

function seedRunningTask(store: SqliteSchedulerStore): void {
  seedPlan(store);
  transition(store, "assigned", { attempt: 1, assignedWorkerId: "worker_1" });
  transition(store, "running", {});
}

function seedSubmittedTask(store: SqliteSchedulerStore): void {
  seedRunningTask(store);
  transition(store, "submitted", { changeSetId: "changeset_1" });
}

function seedPlan(store: SqliteSchedulerStore): void {
  store.append({
    runId: "run_1",
    type: "plan.created",
    occurredAt: now(),
    actor: { role: "architect", id: "architect_1" },
    idempotencyKey: "plan:1",
    payload: {
      revision: 1,
      tasks: [
        {
          id: "task_a",
          objective: "Implement the requested behavior",
          dependencies: [],
          status: "planned",
          requiredCapabilities: ["code"],
          attempt: 0,
        },
      ],
    },
  });
}

function transition(
  store: SqliteSchedulerStore,
  status: "assigned" | "running" | "submitted",
  patch: Record<string, unknown>
): void {
  store.append({
    runId: "run_1",
    type: "task.transitioned",
    occurredAt: now(),
    actor: { role: "runner", id: "test" },
    idempotencyKey: `task_a:${status}`,
    payload: { taskId: "task_a", status, patch },
  });
}

async function withStore(
  run: (store: SqliteSchedulerStore) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "aiboard-guidance-review-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    await run(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}
