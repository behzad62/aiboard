import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
} from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";

test("Finish and Budgeted reject forged plan-only handoff payloads", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-scheduler-policy-forgery-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    for (const runPolicy of ["finish", "budgeted"] as const) {
      const runId = `run_${runPolicy}`;
      store.append(policyEvent(runId, runPolicy));
      store.append(event(runId, "plan.created", "plan:1", {
        revision: 1,
        tasks: [{
          id: "task_1",
          objective: "Plan work",
          dependencies: [],
          status: "planned",
          requiredCapabilities: [],
          attempt: 0,
        }],
      }));
      assert.throws(() => store.append({
        runId,
        type: "project.handoff_requested",
        occurredAt: "2026-07-13T00:00:00.000Z",
        actor: { role: "architect", id: "architect_1" },
        idempotencyKey: "project-handoff-requested",
        payload: {
          summary: "Forged plan-only handoff",
          runPolicy: "plan_only",
        },
      }), /requires terminal task states/i);
      assert.equal(
        rebuildSchedulerProjection(store.readRun(runId)).projectHandoff,
        undefined
      );
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable plan-only policy requires a plan and survives handoff replay", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-scheduler-plan-policy-"));
  const database = join(root, "scheduler.sqlite");
  let store = new SqliteSchedulerStore(database);
  try {
    store.append(policyEvent("run_plan_only", "plan_only"));
    assert.throws(() => store.append({
      runId: "run_plan_only",
      type: "project.handoff_requested",
      occurredAt: "2026-07-13T00:00:00.000Z",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "handoff:before-plan",
      payload: { summary: "No plan exists" },
    }), /requires a valid plan/i);
    store.append(event("run_plan_only", "plan.created", "plan:1", {
      revision: 1,
      tasks: [{
        id: "task_1",
        objective: "Plan work",
        dependencies: [],
        status: "planned",
        requiredCapabilities: [],
        attempt: 0,
      }],
    }));
    store.append({
      runId: "run_plan_only",
      type: "project.handoff_requested",
      occurredAt: "2026-07-13T00:00:00.000Z",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "project-handoff-requested",
      payload: { summary: "Plan is ready" },
    });
    store.close();

    store = new SqliteSchedulerStore(database);
    const recovered = rebuildSchedulerProjection(store.readRun("run_plan_only"));
    assert.equal(recovered.runPolicy, "plan_only");
    assert.equal(recovered.planRevision, 1);
    assert.equal(recovered.tasks.task_1.status, "planned");
    assert.equal(recovered.projectHandoff?.status, "requested");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scheduler events recover exact task and blocking-guidance state", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-scheduler-store-"));
  const database = join(root, "scheduler.sqlite");
  try {
    const first = new SqliteSchedulerStore(database);
    const plan = first.append(event("run_1", "plan.created", "plan:1", {
      revision: 1,
      tasks: [
        {
          id: "task_1",
          objective: "Implement feature",
          dependencies: [],
          status: "planned",
          requiredCapabilities: [],
          attempt: 0,
        },
      ],
    }));
    const duplicate = first.append(event("run_1", "plan.created", "plan:1", {
      revision: 1,
      tasks: [
        {
          id: "task_1",
          objective: "Implement feature",
          dependencies: [],
          status: "planned",
          requiredCapabilities: [],
          attempt: 0,
        },
      ],
    }));
    assert.equal(duplicate.eventId, plan.eventId);
    first.append(event("run_1", "task.transitioned", "assign:1", {
      taskId: "task_1",
      status: "assigned",
      patch: { assignedWorkerId: "worker_1" },
    }));
    first.append(event("run_1", "task.transitioned", "run:1", {
      taskId: "task_1",
      status: "running",
      patch: { workspacePath: "C:/workspace/task_1" },
    }));
    first.append(event("run_1", "guidance.requested", "guidance:1", {
      requestId: "guidance_1",
      taskId: "task_1",
      blocking: true,
      question: "Which API?",
      evidenceSequence: 4,
    }));
    first.close();

    const recovered = new SqliteSchedulerStore(database);
    const projection = rebuildSchedulerProjection(recovered.readRun("run_1"));
    assert.equal(projection.tasks.task_1.status, "waiting_guidance");
    assert.equal(projection.tasks.task_1.guidanceRequestId, "guidance_1");
    assert.equal(projection.guidance.guidance_1.status, "open");
    assert.equal(projection.lastSequence, 4);
    recovered.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt scheduler payload identifies the event", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-scheduler-corrupt-"));
  const database = join(root, "scheduler.sqlite");
  const store = new SqliteSchedulerStore(database);
  try {
    const appended = store.append(event("run_1", "plan.created", "plan:1", {
      revision: 1,
      tasks: [],
    }));
    const raw = new DatabaseSync(database);
    raw
      .prepare("UPDATE scheduler_events SET payload_json = ? WHERE event_id = ?")
      .run("{", appended.eventId);
    raw.close();
    assert.throws(() => store.readRun("run_1"), new RegExp(appended.eventId));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime assignments, provider cooldown, and Architect handoff recover durably", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-scheduler-runtime-"));
  const database = join(root, "scheduler.sqlite");
  try {
    let store = new SqliteSchedulerStore(database);
    store.append(event("run_1", "plan.created", "plan:1", {
      revision: 1,
      tasks: [{
        id: "task_1",
        objective: "Implement feature",
        dependencies: [],
        status: "planned",
        requiredCapabilities: ["code"],
        attempt: 0,
      }],
    }));
    store.append(event("run_1", "task.transitioned", "assign:1", {
      taskId: "task_1",
      status: "assigned",
      patch: { attempt: 1, assignedWorkerId: "worker_1" },
    }));
    store.append(event("run_1", "task.transitioned", "running:1", {
      taskId: "task_1",
      status: "running",
    }));
    store.append({
      runId: "run_1",
      type: "worker.runtime_assigned",
      occurredAt: "2026-07-12T00:00:00.000Z",
      actor: { role: "runner", id: "runtime-router" },
      idempotencyKey: "runtime:task_1:1:openai",
      payload: {
        taskId: "task_1",
        attempt: 1,
        runtimeId: "openai:code",
        sessionId: "worker:task_1:1",
      },
    });
    store.append({
      runId: "run_1",
      type: "provider.health_changed",
      occurredAt: "2026-07-12T00:00:01.000Z",
      actor: { role: "runner", id: "runtime-router" },
      idempotencyKey: "health:openai:1",
      payload: {
        state: {
          providerId: "openai",
          status: "cooldown",
          consecutiveFailures: 1,
          updatedAt: 1_000,
          failureKind: "usage_limit",
          failureMessage: "limit",
          cooldownUntil: 61_000,
        },
      },
    });
    store.append({
      runId: "run_1",
      type: "architect.handoff_required",
      occurredAt: "2026-07-12T00:00:02.000Z",
      actor: { role: "runner", id: "runtime-router" },
      idempotencyKey: "architect-handoff:1",
      payload: {
        reason: "provider unavailable",
        requiredCapabilities: ["code"],
        candidateRuntimeIds: ["anthropic:code"],
      },
    });
    assert.equal(rebuildSchedulerProjection(store.readRun("run_1")).status, "paused");
    store.close();

    store = new SqliteSchedulerStore(database);
    store.append({
      runId: "run_1",
      type: "architect.handoff_selected",
      occurredAt: "2026-07-12T00:00:03.000Z",
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "architect-handoff:selected:1",
      payload: { runtimeId: "anthropic:code" },
    });
    const recovered = rebuildSchedulerProjection(store.readRun("run_1"));
    assert.equal(recovered.status, "running");
    assert.equal(recovered.runtime.workerAssignments["task_1:1"].runtimeId, "openai:code");
    assert.equal(recovered.runtime.providerHealth.openai.status, "cooldown");
    assert.equal(recovered.runtime.architect.runtimeId, "anthropic:code");
    assert.equal(recovered.runtime.architect.handoff, undefined);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a durable Architect handoff always offers an explicit retry of the current runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-scheduler-empty-handoff-"));
  const database = join(root, "scheduler.sqlite");
  const store = new SqliteSchedulerStore(database);
  try {
    store.append({
      runId: "run_1",
      type: "run.initialized",
      occurredAt: "2026-07-12T00:00:00.000Z",
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "run:initialized",
      payload: {},
    });
    store.append({
      runId: "run_1",
      type: "architect.runtime_assigned",
      occurredAt: "2026-07-12T00:00:00.000Z",
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "architect:assigned",
      payload: { runtimeId: "chatgpt:gpt-5.5" },
    });
    store.append({
      runId: "run_1",
      type: "architect.handoff_required",
      occurredAt: "2026-07-12T00:00:01.000Z",
      actor: { role: "runner", id: "runtime-router" },
      idempotencyKey: "architect:handoff",
      payload: {
        reason: "usage limit reached",
        requiredCapabilities: ["code"],
        candidateRuntimeIds: ["chatgpt:gpt-5.4"],
      },
    });

    const projection = rebuildSchedulerProjection(store.readRun("run_1"));
    assert.deepEqual(projection.runtime.architect.handoff?.candidateRuntimeIds, [
      "chatgpt:gpt-5.5",
      "chatgpt:gpt-5.4",
    ]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function event(
  runId: string,
  type: NewSchedulerEvent["type"],
  idempotencyKey: string,
  payload: Record<string, unknown>
): NewSchedulerEvent {
  return {
    runId,
    type,
    occurredAt: "2026-07-12T00:00:00.000Z",
    actor: {
      role:
        type === "plan.created"
          ? "architect"
          : type === "guidance.requested"
            ? "worker"
            : "runner",
      id: "actor_1",
    },
    idempotencyKey,
    payload,
  };
}

function policyEvent(
  runId: string,
  runPolicy: "finish" | "budgeted" | "plan_only"
): NewSchedulerEvent {
  return {
    runId,
    type: "run.policy_configured",
    occurredAt: "2026-07-13T00:00:00.000Z",
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: "run-policy-configured",
    payload: { runPolicy },
  };
}
