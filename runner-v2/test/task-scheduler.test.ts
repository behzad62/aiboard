import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import {
  TaskScheduler,
  type WorkerAssignment,
  type WorkerOutcome,
  type WorkerRuntimeDriver,
} from "../src/task-scheduler.js";
import type { BuildTask } from "../src/task-contracts.js";

class DeferredDriver implements WorkerRuntimeDriver {
  readonly assignments: WorkerAssignment[] = [];
  private readonly pending = new Map<
    string,
    { resolve: (outcome: WorkerOutcome) => void }
  >();
  run(assignment: WorkerAssignment): Promise<WorkerOutcome> {
    this.assignments.push(assignment);
    return new Promise((resolve) => {
      this.pending.set(assignment.task.id, { resolve });
    });
  }
  resolve(taskId: string, outcome: WorkerOutcome): void {
    this.pending.get(taskId)?.resolve(outcome);
  }
}

test("scheduler bounds concurrency, respects dependencies, and releases guidance slots", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-task-scheduler-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const driver = new DeferredDriver();
  try {
    store.append(planEvent("run_1", [
      task("a"),
      task("b"),
      task("c", ["a"]),
    ]));
    const scheduler = new TaskScheduler({
      runId: "run_1",
      store,
      driver,
      maxConcurrency: 2,
      workspaceFor: async (taskValue) => `C:/work/${taskValue.id}`,
      clock: () => "2026-07-12T00:00:00.000Z",
    });
    await scheduler.tick();
    assert.deepEqual(driver.assignments.map((item) => item.task.id), ["a", "b"]);
    await scheduler.tick();
    assert.equal(driver.assignments.length, 2, "active attempts are not duplicated");

    driver.resolve("b", {
      type: "guidance",
      requestId: "guidance_b",
      blocking: true,
      question: "Choose the API",
      evidenceSequence: 10,
    });
    await waitFor(() => scheduler.projection().tasks.b.status === "waiting_guidance");
    assert.equal(scheduler.activeCount(), 1);
    assert.equal(scheduler.projection().guidance.guidance_b.status, "open");

    driver.resolve("a", { type: "submitted", changeSetId: "changeset_a" });
    await waitFor(() => scheduler.projection().tasks.a.status === "submitted");
    transitionToIntegrated(store, "run_1", "a");
    await scheduler.tick();
    assert.equal(driver.assignments.at(-1)?.task.id, "c");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart resumes the same running attempt without incrementing it", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-task-scheduler-restart-"));
  const database = join(root, "scheduler.sqlite");
  const firstStore = new SqliteSchedulerStore(database);
  const firstDriver = new DeferredDriver();
  try {
    firstStore.append(planEvent("run_1", [task("a")]));
    const first = new TaskScheduler({
      runId: "run_1",
      store: firstStore,
      driver: firstDriver,
      maxConcurrency: 1,
      workspaceFor: async () => "C:/work/a",
    });
    await first.tick();
    assert.equal(first.projection().tasks.a.attempt, 1);
    firstStore.close();

    const recoveredStore = new SqliteSchedulerStore(database);
    const recoveredDriver = new DeferredDriver();
    const recovered = new TaskScheduler({
      runId: "run_1",
      store: recoveredStore,
      driver: recoveredDriver,
      maxConcurrency: 1,
      workspaceFor: async () => "C:/work/a",
    });
    await recovered.tick();
    assert.equal(recoveredDriver.assignments.length, 1);
    assert.equal(recoveredDriver.assignments[0].attempt, 1);
    assert.equal(recovered.projection().tasks.a.attempt, 1);
    recoveredStore.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function planEvent(runId: string, tasks: BuildTask[]) {
  return {
    runId,
    type: "plan.created" as const,
    occurredAt: "2026-07-12T00:00:00.000Z",
    actor: { role: "architect" as const, id: "architect_1" },
    idempotencyKey: "plan:1",
    payload: { revision: 1, tasks },
  };
}

function task(id: string, dependencies: string[] = []): BuildTask {
  return {
    id,
    objective: `Objective ${id}`,
    dependencies,
    status: "planned",
    requiredCapabilities: [],
    attempt: 0,
  };
}

function transitionToIntegrated(
  store: SqliteSchedulerStore,
  runId: string,
  taskId: string
): void {
  for (const status of [
    "architect_review",
    "approved",
    "integrating",
    "integrated",
  ] as const) {
    store.append({
      runId,
      type: "task.transitioned",
      occurredAt: "2026-07-12T00:00:00.000Z",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: `${taskId}:${status}`,
      payload: { taskId, status },
    });
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for scheduler state.");
}
