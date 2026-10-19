import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { rebuildSchedulerProjection, type NewSchedulerEvent } from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";

const plan = (runId: string): NewSchedulerEvent => ({
  runId,
  type: "plan.created",
  occurredAt: "2026-10-19T00:00:00.000Z",
  actor: { role: "architect", id: "architect_1" },
  idempotencyKey: "plan:1",
  payload: {
    revision: 1,
    tasks: [{ id: "task_1", objective: "Implement feature", dependencies: [], status: "planned", requiredCapabilities: [], attempt: 0 }],
  },
});
const transition = (runId: string, key: string, payload: Record<string, unknown>): NewSchedulerEvent => ({
  runId,
  type: "task.transitioned",
  occurredAt: "2026-10-19T00:00:01.000Z",
  actor: { role: "runner", id: "runner_1" },
  idempotencyKey: key,
  payload,
});

test("the replay cache sees appends from another store on the same database and returns copies", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-replay-cache-"));
  const database = join(root, "scheduler.sqlite");
  const reader = new SqliteSchedulerStore(database);
  const writer = new SqliteSchedulerStore(database);
  try {
    writer.append(plan("run_1"));
    assert.equal(reader.readRun("run_1").length, 1);
    assert.equal(reader.readProjection("run_1")?.tasks.task_1?.status, "planned");

    writer.append(transition("run_1", "assign:1", { taskId: "task_1", status: "assigned", patch: { assignedWorkerId: "worker_1" } }));
    assert.deepEqual(reader.readRun("run_1", 1).map((event) => event.sequence), [2]);
    assert.equal(reader.readProjection("run_1")?.tasks.task_1?.status, "assigned");
    assert.deepEqual(reader.readProjection("run_1"), rebuildSchedulerProjection(writer.readRun("run_1")));

    // Callers own what they get back: changing it never reaches the next read.
    const events = reader.readRun("run_1");
    (events[0]!.payload as { revision: number }).revision = 99;
    reader.readProjection("run_1")!.tasks.task_1!.status = "failed";
    assert.equal((reader.readRun("run_1")[0]!.payload as { revision: number }).revision, 1);
    assert.equal(reader.readProjection("run_1")?.tasks.task_1?.status, "assigned");
  } finally {
    reader.close();
    writer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refused append leaves the cached replay unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-replay-cache-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    store.append(plan("run_1"));
    const before = store.readProjection("run_1");
    assert.throws(() => store.append(transition("run_1", "bad:1", { taskId: "task_missing", status: "assigned", patch: {} })));
    assert.deepEqual(store.readProjection("run_1"), before);
    assert.equal(store.readRun("run_1").length, 1);
    store.append(transition("run_1", "assign:1", { taskId: "task_1", status: "assigned", patch: { assignedWorkerId: "worker_1" } }));
    assert.deepEqual(store.readProjection("run_1"), rebuildSchedulerProjection(store.readRun("run_1")));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rebuildSchedulerProjection returns an independent copy for identical events", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-replay-cache-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    store.append(plan("run_1"));
    const first = rebuildSchedulerProjection(store.readRun("run_1"));
    first.tasks.task_1!.status = "failed";
    assert.equal(rebuildSchedulerProjection(store.readRun("run_1")).tasks.task_1?.status, "planned");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
