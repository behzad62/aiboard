import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ContextManifestRecordingError } from "../src/context-manifest-store.js";
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

test("tick dispatches nothing while a plan critique is pending and resumes after it is skipped", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-task-scheduler-critique-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const driver = new DeferredDriver();
  try {
    store.append({
      runId: "run_1",
      type: "run.initialized",
      occurredAt: "2026-07-12T00:00:00.000Z",
      actor: { role: "runner", id: "test" },
      idempotencyKey: "init",
      payload: { runId: "run_1" },
    });
    store.append(planEvent("run_1", [task("a"), task("b"), task("c"), task("d")]));
    store.append({
      runId: "run_1",
      type: "plan_critique.policy_configured",
      occurredAt: "2026-07-12T00:00:00.000Z",
      actor: { role: "runner", id: "test" },
      idempotencyKey: "critique-policy",
      payload: { mode: "always" },
    });
    const scheduler = new TaskScheduler({
      runId: "run_1",
      store,
      driver,
      maxConcurrency: 2,
      workspaceFor: async (taskValue, attempt) => `C:/work/${taskValue.id}/${attempt}`,
      clock: () => "2026-07-12T00:00:00.000Z",
    });
    await scheduler.tick();
    assert.equal(driver.assignments.length, 0, "tick() must wait while planCritiquePending is true");
    store.append({
      runId: "run_1",
      type: "plan_critique.skipped",
      occurredAt: "2026-07-12T00:00:00.000Z",
      actor: { role: "runner", id: "test" },
      idempotencyKey: "critique-skipped",
      payload: { planRevision: 1, reason: "critic_failed" },
    });
    await scheduler.tick();
    assert.ok(driver.assignments.length > 0, "tick() dispatches after the critique is no longer pending");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker context recording failure appends one note and pauses without failing or redispatching", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-task-scheduler-recording-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const failure = recordingFailure("run_1", "worker:task");
  const driver = new ThrowingDriver(failure);
  try {
    store.append(planEvent("run_1", [task("a")]));
    const scheduler = recordingScheduler(store, driver);
    await scheduler.tick();
    let idleError: unknown;
    try {
      await scheduler.awaitIdle();
    } catch (error) {
      idleError = error;
    }
    assert.equal(idleError, undefined, "context recording failure is recorded as a pause");
    const notes = store.readRun("run_1").filter((event) => event.type === "context_manifest.recording_failed");
    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.actor.role, "runner");
    assert.deepEqual(notes[0]?.payload, {
      purpose: "worker:task",
      attempts: 3,
      reason: failure.message,
      taskId: "a",
      attempt: 1,
      revision: "baseline-1",
    });
    assert.equal(scheduler.projection().status, "paused");
    assert.equal(scheduler.projection().pauseReason?.reason, "context_recording_failed");
    assert.equal(scheduler.projection().tasks.a?.status, "running");
    assert.notEqual(scheduler.projection().tasks.a?.status, "failed");
    await scheduler.tick();
    assert.equal(driver.assignments.length, 1, "paused context recording does not redispatch the worker");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a worker error other than context recording still fails the task", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-task-scheduler-other-failure-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const driver = new ThrowingDriver(new Error("worker exploded"));
  try {
    store.append(planEvent("run_1", [task("a")]));
    const scheduler = recordingScheduler(store, driver);
    await scheduler.tick();
    await scheduler.awaitIdle();
    assert.equal(scheduler.projection().tasks.a?.status, "failed");
    assert.equal(
      store.readRun("run_1").filter((event) => event.type === "context_manifest.recording_failed").length,
      0,
    );
    assert.notEqual(scheduler.projection().pauseReason?.reason, "context_recording_failed");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a context recording note whose scheduler append throws keeps the original error", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-task-scheduler-recording-append-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const failure = recordingFailure("run_1", "worker:task");
  const driver = new ThrowingDriver(failure);
  const originalAppend = store.append.bind(store);
  store.append = ((event) => {
    if (event.type === "context_manifest.recording_failed") {
      throw new Error("scheduler append failed");
    }
    return originalAppend(event);
  }) as SqliteSchedulerStore["append"];
  try {
    store.append(planEvent("run_1", [task("a")]));
    const scheduler = recordingScheduler(store, driver);
    await scheduler.tick();
    await assert.rejects(() => scheduler.awaitIdle(), (error: unknown) => {
      assert.ok(error instanceof ContextManifestRecordingError);
      assert.equal(error, failure);
      return true;
    });
    assert.equal(
      store.readRun("run_1").filter((event) => event.type === "context_manifest.recording_failed").length,
      0,
    );
    assert.equal(scheduler.projection().status, "running");
    assert.notEqual(scheduler.projection().tasks.a?.status, "failed");
    assert.equal(driver.assignments.length, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function recordingFailure(runId: string, purpose: string): ContextManifestRecordingError {
  return new ContextManifestRecordingError({
    runId,
    sessionId: `${purpose}:session`,
    purpose,
    attempts: 3,
  }, new Error("sqlite locked"));
}

function recordingScheduler(store: SqliteSchedulerStore, driver: WorkerRuntimeDriver): TaskScheduler {
  return new TaskScheduler({
    runId: "run_1",
    store,
    driver,
    maxConcurrency: 1,
    workspaceFor: async () => ({
      path: "C:/work/a/1",
      workspaceId: "a:attempt:1",
      baselineRevision: "baseline-1",
    }),
    clock: () => "2026-07-12T00:00:00.000Z",
  });
}

class ThrowingDriver implements WorkerRuntimeDriver {
  readonly assignments: WorkerAssignment[] = [];
  constructor(private readonly error: Error) {}
  async run(assignment: WorkerAssignment): Promise<WorkerOutcome> {
    this.assignments.push(assignment);
    throw this.error;
  }
}

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
