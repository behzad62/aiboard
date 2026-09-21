import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  architectLifecycleEventMatchesReason,
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
} from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { createWorkerLifecycleTools } from "../src/worker-lifecycle-tools.js";

const RUN_ID = "run_replan";
const AT = "2026-09-02T00:00:00.000Z";

function event(
  type: NewSchedulerEvent["type"],
  idempotencyKey: string,
  payload: Record<string, unknown>,
  actor: NewSchedulerEvent["actor"] = { role: "runner", id: "test" },
): NewSchedulerEvent {
  return { runId: RUN_ID, type, occurredAt: AT, actor, idempotencyKey, payload };
}

function seededStore(root: string): SqliteSchedulerStore {
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  store.append(event("run.initialized", "init", { runId: RUN_ID }));
  store.append(event("plan.created", "plan:1", {
    revision: 1,
    tasks: [{
      id: "T1", objective: "Add caching", dependencies: [], status: "planned",
      requiredCapabilities: ["code"], attempt: 0,
      acceptanceCriteria: [{ id: "AC-1", text: "Cache invalidates on membership change." }],
      acceptanceCriteriaVersion: 1,
    }],
  }, { role: "architect", id: "architect_1" }));
  store.append(event("task.transitioned", "T1:assigned", {
    taskId: "T1", status: "assigned", patch: { attempt: 1, assignedWorkerId: "worker:T1:1" },
  }, { role: "runner", id: "scheduler" }));
  store.append(event("task.transitioned", "T1:running", { taskId: "T1", status: "running" },
    { role: "runner", id: "scheduler" }));
  return store;
}

test("request_replan appends a blocking replan guidance request and ends the worker turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-replan-"));
  const store = seededStore(root);
  try {
    const tool = createWorkerLifecycleTools({ store, taskId: "T1", clock: () => AT })
      .find((candidate) => candidate.definition.name === "request_replan");
    assert.ok(tool, "request_replan tool is registered");
    assert.equal(tool.definition.lifecycle, true);
    const validated = tool.validate({
      requestId: "replan-1",
      reason: "scope_exceeded",
      summary: "The cache key factory lives outside this task and must change.",
      proposedChange: "Split into T1a (key factory) and T1b (invalidation) with T1b depending on T1a.",
      evidenceSequence: 4,
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = await tool.execute(validated.value, {
      runId: RUN_ID, sessionId: "worker:T1:1", actor: { role: "worker", id: "worker:T1:1" },
    });
    assert.equal(output.isError, false);
    assert.deepEqual(output.lifecycle, { type: "request_replan", requestId: "replan-1" });

    const projection = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.equal(projection.tasks.T1.status, "waiting_guidance");
    assert.equal(projection.guidance["replan-1"].kind, "replan");
    assert.equal(projection.guidance["replan-1"].blocking, true);
    assert.equal(projection.guidance["replan-1"].replan?.reason, "scope_exceeded");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a replan guidance request must be blocking and carry a known reason", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-replan-"));
  const store = seededStore(root);
  try {
    assert.throws(() => store.append(event("guidance.requested", "g:bad-blocking", {
      requestId: "bad-blocking", taskId: "T1", question: "x", blocking: false, evidenceSequence: 1,
      kind: "replan", replan: { reason: "scope_exceeded", summary: "s", proposedChange: "p" },
    }, { role: "worker", id: "worker:T1:1" })), /replan guidance must be blocking/);
    assert.throws(() => store.append(event("guidance.requested", "g:bad-reason", {
      requestId: "bad-reason", taskId: "T1", question: "x", blocking: true, evidenceSequence: 1,
      kind: "replan", replan: { reason: "bored", summary: "s", proposedChange: "p" },
    }, { role: "worker", id: "worker:T1:1" })), /replan reason bored is invalid/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconciling the plan answers the open replan request and satisfies guidance_required", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-replan-"));
  const store = seededStore(root);
  try {
    store.append(event("guidance.requested", "g:replan-2", {
      requestId: "replan-2", taskId: "T1", question: "Replan requested.", blocking: true,
      evidenceSequence: 4, kind: "replan",
      replan: { reason: "scope_exceeded", summary: "s", proposedChange: "split" },
    }, { role: "worker", id: "worker:T1:1" }));
    const reconciled = store.append(event("plan.reconciled", "plan:2", {
      revision: 2,
      summary: "Split T1 per worker replan request.",
      taskUpdates: [{ taskId: "T1", action: "cancel" }],
      newTasks: [
        { id: "T1a", objective: "Key factory", dependencies: [], requiredCapabilities: ["code"],
          acceptanceCriteria: [{ id: "AC-1", text: "Factory builds org-scoped keys." }] },
        { id: "T1b", objective: "Invalidation", dependencies: ["T1a"], requiredCapabilities: ["code"],
          acceptanceCriteria: [{ id: "AC-1", text: "Membership change invalidates the key." }] },
      ],
    }, { role: "architect", id: "architect_1" }));
    const projection = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.equal(projection.tasks.T1.status, "cancelled");
    assert.equal(projection.guidance["replan-2"].status, "answered");
    assert.equal(projection.guidance["replan-2"].answer, "plan_reconciled:2");
    assert.equal(
      architectLifecycleEventMatchesReason(reconciled, {
        type: "guidance_required", requestId: "replan-2", taskId: "T1",
      }),
      true,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an open replan request survives store reopen as waiting_guidance", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-replan-"));
  const database = join(root, "scheduler.sqlite");
  let store = seededStore(root);
  try {
    store.append(event("guidance.requested", "g:replan-replay", {
      requestId: "replan-replay", taskId: "T1", question: "Replan requested.", blocking: true,
      evidenceSequence: 4, kind: "replan",
      replan: {
        reason: "dependency_missing",
        summary: "Auth helper is not in this task.",
        proposedChange: "Add T0 for the helper.",
      },
    }, { role: "worker", id: "worker:T1:1" }));
    store.close();
    store = new SqliteSchedulerStore(database);
    const projection = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.equal(projection.tasks.T1.status, "waiting_guidance");
    assert.equal(projection.guidance["replan-replay"].status, "open");
    assert.equal(projection.guidance["replan-replay"].kind, "replan");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
