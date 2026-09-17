import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
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
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const evidence = evidenceStore.record({
    runId: "run_1",
    taskId: "a",
    actor: { role: "worker", id: "worker_a_1" },
    fact: {
      kind: "browser_screenshot",
      label: "Task a evidence",
      capturedAt: "2026-07-12T00:00:00.000Z",
      screenshotArtifactHash: "a".repeat(64),
      mediaType: "image/png",
      byteLength: 16,
    },
    createdAt: "2026-07-12T00:00:00.000Z",
    idempotencyKey: "task-a-evidence",
    attempt: 1,
  });
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), {
    evidenceStore,
  });
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
      workspaceFor: async (taskValue, attempt) => ({
        path: `C:/work/${taskValue.id}/${attempt}`,
        workspaceId: `${taskValue.id}:attempt:${attempt}`,
        baselineRevision: `integration-${attempt}`,
      }),
      clock: () => "2026-07-12T00:00:00.000Z",
    });
    await scheduler.tick();
    assert.deepEqual(driver.assignments.map((item) => item.task.id), ["a", "b"]);
    assert.equal(driver.assignments[0].workspacePath, "C:/work/a/1");
    assert.equal(driver.assignments[0].task.workspaceId, "a:attempt:1");
    assert.equal(
      driver.assignments[0].task.workspaceBaselineRevision,
      "integration-1"
    );
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

    driver.resolve("a", {
      type: "submitted",
      changeSetId: "changeset_a",
      criterionEvidenceLinks: [{
        criterionId: "ready",
        evidenceId: evidence.id,
        artifactHashes: ["a".repeat(64)],
      }],
    });
    await waitFor(() => scheduler.projection().tasks.a.status === "submitted");
    transitionToIntegrated(store, "run_1", "a");
    await scheduler.tick();
    assert.equal(driver.assignments.at(-1)?.task.id, "c");
  } finally {
    store.close();
    evidenceStore.close();
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

test("scheduler threads the active lifecycle signal and absolute retry deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-task-scheduler-lifecycle-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const driver = new DeferredDriver();
  const controller = new AbortController();
  try {
    store.append(planEvent("run_1", [task("a")]));
    const scheduler = new TaskScheduler({
      runId: "run_1",
      store,
      driver,
      maxConcurrency: 1,
      workspaceFor: async () => "C:/work/a",
      lifecycleSignal: () => controller.signal,
      providerRetryDeadlineMs: () => 12_345,
    });
    await scheduler.tick();
    assert.equal(driver.assignments[0].signal, controller.signal);
    assert.equal(driver.assignments[0].providerRetryDeadlineMs, 12_345);
    driver.resolve("a", { type: "paused", reason: "test_complete" });
    await scheduler.awaitIdle();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an aborted active worker cannot persist a stale outcome or consume another attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-task-scheduler-steering-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const driver = new DeferredDriver();
  const controller = new AbortController();
  try {
    store.append(planEvent("run_1", [task("a")]));
    const scheduler = new TaskScheduler({
      runId: "run_1",
      store,
      driver,
      maxConcurrency: 1,
      workspaceFor: async () => "C:/work/a",
      lifecycleSignal: () => controller.signal,
    });
    await scheduler.tick();
    assert.equal(scheduler.projection().tasks.a.attempt, 1);

    controller.abort(new DOMException("User guidance arrived.", "AbortError"));
    driver.resolve("a", { type: "submitted", changeSetId: "stale-change-set" });
    await scheduler.awaitIdle();

    const projection = scheduler.projection();
    assert.equal(projection.status, "running");
    assert.equal(projection.tasks.a.status, "running");
    assert.equal(projection.tasks.a.attempt, 1);
    assert.equal(projection.tasks.a.changeSetId, undefined);
  } finally {
    store.close();
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
    acceptanceCriteria: [{
      id: "ready",
      text: `Task ${id} is complete.`,
    }],
    acceptanceCriteriaVersion: 1,
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
    const role = status === "integrated" ? "runner" as const : "architect" as const;
    store.append({
      runId,
      type: "task.transitioned",
      occurredAt: "2026-07-12T00:00:00.000Z",
      actor: { role, id: role === "architect" ? "architect_1" : "integration_manager" },
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
