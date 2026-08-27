import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolCallBlock } from "../src/agent-contracts.js";
import {
  BuildRuntime,
  type ArchitectActionRequest,
  type ArchitectRuntimeDriver,
} from "../src/build-runtime.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import type { BuildTask } from "../src/task-contracts.js";
import type { WorkerAssignment, WorkerOutcome } from "../src/task-scheduler.js";

const RUN_ID = "steering-run";
const CLOCK = () => "2026-08-27T00:00:00.000Z";
const OBJECTIVE = "Build\nexactly\tthis application.  ";

test("production initialization preserves the objective bytes and durable guidance wins the next Architect action", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-steering-init-"));
  const database = join(root, "scheduler.sqlite");
  let store: SqliteSchedulerStore | undefined = new SqliteSchedulerStore(database);
  const reasons: string[] = [];
  try {
    const runtime = runtimeFor(store, {
      run: async (request) => {
        reasons.push(request.reason.type);
        if (request.reason.type === "plan_required") {
          await invoke(request, "plan_tasks", {
            revision: 1,
            tasks: [{
              id: "task-a",
              objective: "Implement the application.",
              dependencies: [],
              requiredCapabilities: ["code"],
              acceptanceCriteria: [{ id: "done", text: "The application is implemented." }],
            }],
          });
          return;
        }
        if (request.reason.type === "user_guidance_required") {
          assert.equal(request.projection.initialObjective, OBJECTIVE);
          assert.equal(request.projection.userGuidance["guidance-1"].text, "Keep the public API stable.");
          acknowledge(store!, "guidance-1", 1);
          return;
        }
        throw new Error(`Unexpected reason ${request.reason.type}`);
      },
    });
    assert.equal(runtime.projection().initialObjective, OBJECTIVE);
    await runtime.step();
    runtime.submitUserGuidance({
      guidanceId: "guidance-1",
      text: "Keep the public API stable.",
      version: 1,
      idempotencyKey: "guidance:1",
    });
    store.close();
    store = undefined;

    const recoveredStore = new SqliteSchedulerStore(database);
    try {
      const recovered = runtimeFor(recoveredStore, {
        run: async (request) => {
          reasons.push(request.reason.type);
          assert.equal(request.reason.type, "user_guidance_required");
          assert.equal(request.projection.initialObjective, OBJECTIVE);
          acknowledge(recoveredStore, "guidance-1", 1);
        },
      });
      assert.equal((await recovered.step()).action, "user_guidance_required");
      assert.deepEqual(reasons, ["plan_required", "user_guidance_required"]);
      assert.equal(recovered.projection().initialObjective, OBJECTIVE);
      assert.throws(() => new BuildRuntime({
        runId: RUN_ID,
        initialObjective: `${OBJECTIVE}changed`,
        store: recoveredStore,
        workerDriver: { run: async () => ({ type: "paused", reason: "unused" }) },
        architectDriver: { run: async () => undefined },
        integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
        maxConcurrency: 1,
        workspaceFor: async () => "unused",
      }), /durable initial objective.*does not match/i);
    } finally {
      recoveredStore.close();
    }
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("guidance submitted before planning is included in the initial plan action then acknowledged before later progress", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-steering-before-plan-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const reasons: string[] = [];
  try {
    const runtime = runtimeFor(store, {
      run: async (request) => {
        reasons.push(request.reason.type);
        if (request.reason.type === "plan_required") {
          assert.equal(request.projection.userGuidance["guidance-before-plan"].status, "submitted");
          await invoke(request, "plan_tasks", {
            revision: 1,
            tasks: [{
              id: "task-a",
              objective: "Implement the guided initial plan.",
              dependencies: [],
              requiredCapabilities: ["code"],
              acceptanceCriteria: [{ id: "done", text: "The guided plan is implemented." }],
            }],
          });
          return;
        }
        assert.equal(request.reason.type, "user_guidance_required");
        acknowledge(store, "guidance-before-plan", 1);
      },
    });
    runtime.submitUserGuidance({
      guidanceId: "guidance-before-plan",
      text: "Include a stable public API in the plan.",
      version: 1,
      idempotencyKey: "guidance:before-plan",
    });
    assert.equal((await runtime.step()).action, "plan_required");
    assert.equal(runtime.projection().planRevision, 1);
    assert.equal(runtime.projection().userGuidance["guidance-before-plan"].status, "submitted");
    assert.equal((await runtime.step()).action, "user_guidance_required");
    assert.deepEqual(reasons, ["plan_required", "user_guidance_required"]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("guidance appended during an active worker aborts first and suppresses stale submission without pausing or incrementing", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-steering-worker-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  let assignment: WorkerAssignment | undefined;
  let resumedAssignment: WorkerAssignment | undefined;
  let workerCalls = 0;
  let resolveWorker!: (outcome: WorkerOutcome) => void;
  let workerStarted!: () => void;
  let guidanceDurableWhenAborted = false;
  const started = new Promise<void>((resolve) => { workerStarted = resolve; });
  const architectReasons: string[] = [];
  try {
    seedPlan(store, [task("task-a", "planned")]);
    const runtime = new BuildRuntime({
      runId: RUN_ID,
      store,
      workerDriver: {
        run: async (input) => {
          workerCalls += 1;
          if (workerCalls > 1) {
            resumedAssignment = input;
            return { type: "failed", reason: "resume probe complete" };
          }
          assignment = input;
          input.signal?.addEventListener("abort", () => {
            guidanceDurableWhenAborted = store.readRun(RUN_ID).some(
              (event) => event.type === "user.guidance_submitted" &&
                event.payload.guidanceId === "guidance-worker"
            );
          }, { once: true });
          workerStarted();
          return await new Promise<WorkerOutcome>((resolve) => { resolveWorker = resolve; });
        },
      },
      architectDriver: {
        run: async (request) => {
          architectReasons.push(request.reason.type);
          assert.equal(request.reason.type, "user_guidance_required");
          acknowledge(store, request.reason.guidanceId, request.reason.version);
        },
      },
      integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/work/task-a",
      clock: CLOCK,
    });

    const activeStep = runtime.step();
    await started;
    runtime.submitUserGuidance({
      guidanceId: "guidance-worker",
      text: "Use the revised naming requirement.",
      version: 1,
      idempotencyKey: "guidance:worker",
    });
    assert.equal(assignment?.signal?.aborted, true, "guidance is durable before cancellation is observed");
    assert.equal(guidanceDurableWhenAborted, true);
    assert.equal(runtime.projection().userGuidance["guidance-worker"].status, "submitted");
    runtime.submitUserGuidance({
      guidanceId: "guidance-worker-second",
      text: "Also preserve the existing public API.",
      version: 2,
      idempotencyKey: "guidance:worker:second",
    });
    resolveWorker({ type: "submitted", changeSetId: "stale-change-set" });
    assert.equal((await activeStep).action, "workers_advanced");

    const afterWorker = runtime.projection();
    assert.equal(afterWorker.status, "running");
    assert.equal(afterWorker.tasks["task-a"].status, "running");
    assert.equal(afterWorker.tasks["task-a"].attempt, 1);
    assert.equal(afterWorker.tasks["task-a"].changeSetId, undefined);
    assert.equal((await runtime.step()).action, "user_guidance_required");
    assert.equal(runtime.projection().userGuidance["guidance-worker-second"].status, "submitted");
    assert.equal((await runtime.step()).action, "user_guidance_required");
    assert.deepEqual(architectReasons, ["user_guidance_required", "user_guidance_required"]);
    assert.equal((await runtime.step()).action, "workers_advanced");
    assert.equal(workerCalls, 2);
    assert.equal(resumedAssignment?.attempt, 1);
    assert.equal(resumedAssignment?.task.objective, "Implement task-a");
    assert.equal(runtime.projection().tasks["task-a"].attempt, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("guidance arriving during workspace allocation prevents old-intent dispatch and recovers before the same attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-steering-allocation-window-"));
  const database = join(root, "scheduler.sqlite");
  let store: SqliteSchedulerStore | undefined = new SqliteSchedulerStore(database);
  let allocationStarted!: () => void;
  let releaseAllocation!: () => void;
  const started = new Promise<void>((resolve) => { allocationStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseAllocation = resolve; });
  let workerCalls = 0;
  try {
    seedPlan(store, [task("task-a", "planned")]);
    const runtime = new BuildRuntime({
      runId: RUN_ID,
      store,
      workerDriver: {
        run: async () => {
          workerCalls += 1;
          return { type: "paused", reason: "stale worker must not start" };
        },
      },
      architectDriver: { run: async () => undefined },
      integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
      maxConcurrency: 1,
      workspaceFor: async () => {
        allocationStarted();
        await release;
        return "C:/work/task-a";
      },
      clock: CLOCK,
    });
    const allocatingStep = runtime.step();
    await started;
    runtime.submitUserGuidance({
      guidanceId: "guidance-allocation",
      text: "Change direction before this worker starts.",
      version: 1,
      idempotencyKey: "guidance:allocation",
    });
    releaseAllocation();
    assert.equal((await allocatingStep).action, "workers_advanced");
    assert.equal(workerCalls, 0);
    assert.equal(runtime.projection().status, "running");
    assert.equal(runtime.projection().tasks["task-a"].status, "planned");
    assert.equal(runtime.projection().tasks["task-a"].attempt, 0);
    store.close();
    store = undefined;

    const recoveredStore = new SqliteSchedulerStore(database);
    try {
      const recovered = new BuildRuntime({
        runId: RUN_ID,
        store: recoveredStore,
        workerDriver: {
          run: async () => {
            workerCalls += 1;
            return { type: "paused", reason: "guidance was not prioritized" };
          },
        },
        architectDriver: {
          run: async (request) => {
            assert.equal(request.reason.type, "user_guidance_required");
            acknowledge(recoveredStore, "guidance-allocation", 1);
          },
        },
        integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
        maxConcurrency: 1,
        workspaceFor: async () => "C:/work/task-a",
        clock: CLOCK,
      });
      assert.equal((await recovered.step()).action, "user_guidance_required");
      assert.equal(workerCalls, 0);
      assert.equal(recovered.projection().tasks["task-a"].attempt, 0);
    } finally {
      recoveredStore.close();
    }
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending guidance preempts a legacy acceptance-contract upgrade without deadlocking", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-steering-legacy-upgrade-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    store.append({
      runId: RUN_ID,
      type: "plan.created",
      occurredAt: CLOCK(),
      actor: { role: "architect", id: "legacy-architect" },
      idempotencyKey: "legacy-plan",
      payload: { revision: 1, tasks: [{
        id: "legacy-task",
        objective: "Recover the legacy task.",
        dependencies: [],
        requiredCapabilities: ["code"],
        status: "planned",
        attempt: 0,
      }] },
    });
    const runtime = new BuildRuntime({
      runId: RUN_ID,
      store,
      workerDriver: { run: async () => ({ type: "paused", reason: "unused" }) },
      architectDriver: {
        run: async (request) => {
          assert.equal(request.reason.type, "user_guidance_required");
          acknowledge(store, "guidance-legacy", 1);
        },
      },
      integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
      maxConcurrency: 1,
      workspaceFor: async () => "unused",
      clock: CLOCK,
    });
    runtime.submitUserGuidance({
      guidanceId: "guidance-legacy",
      text: "Apply this before upgrading the legacy acceptance contract.",
      version: 1,
      idempotencyKey: "guidance:legacy",
    });
    assert.equal((await runtime.step()).action, "user_guidance_required");
    assert.equal(runtime.projection().userGuidance["guidance-legacy"].status, "acknowledged");
    assert.equal(runtime.events().some((event) => event.type === "acceptance_contract.upgrade_required"), false);
    assert.equal(runtime.projection().acceptanceContractStatus, "acceptance_contract_upgrade_required");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an idempotent guidance retry does not abort a newer lifecycle and a conflicting retry rejects before abort", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-steering-idempotent-abort-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  let assignment: WorkerAssignment | undefined;
  let resolveWorker!: (outcome: WorkerOutcome) => void;
  let workerStarted!: () => void;
  const started = new Promise<void>((resolve) => { workerStarted = resolve; });
  try {
    seedPlan(store, [task("task-a", "planned")]);
    const runtime = new BuildRuntime({
      runId: RUN_ID,
      store,
      workerDriver: {
        run: async (input) => {
          assignment = input;
          workerStarted();
          return await new Promise<WorkerOutcome>((resolve) => { resolveWorker = resolve; });
        },
      },
      architectDriver: { run: async () => acknowledge(store, "guidance-idempotent", 1) },
      integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/work/task-a",
      clock: CLOCK,
    });
    const input = {
      guidanceId: "guidance-idempotent",
      text: "Keep the task intent stable.",
      version: 1,
      idempotencyKey: "guidance:idempotent",
    };
    runtime.submitUserGuidance(input);
    await runtime.step();
    const workerStep = runtime.step();
    await started;
    assert.equal(assignment?.signal?.aborted, false);

    runtime.submitUserGuidance(input);
    assert.equal(assignment?.signal?.aborted, false);
    assert.throws(() => runtime.submitUserGuidance({
      ...input,
      text: "Conflicting retry payload.",
    }), /idempotency|conflict/i);
    assert.equal(assignment?.signal?.aborted, false);
    assert.equal(store.readRun(RUN_ID).filter((event) => event.type === "user.guidance_submitted").length, 1);

    resolveWorker({ type: "failed", reason: "test finished" });
    await workerStep;
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale Architect lifecycle tool cannot advance review or integration after guidance is durable", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-steering-architect-race-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  let activeRequest: ArchitectActionRequest | undefined;
  let architectStarted!: () => void;
  let releaseArchitect!: () => void;
  const started = new Promise<void>((resolve) => { architectStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseArchitect = resolve; });
  try {
    seedPlan(store, [task("task-a", "approved", { changeSetId: "change-a" })]);
    const runtime = runtimeFor(store, {
      run: async (request) => {
        activeRequest = request;
        architectStarted();
        await release;
        const result = await request.tools.invoke({
          type: "tool_call",
          callId: "stale-integration",
          name: "request_integration",
          arguments: { taskId: "task-a" },
        }, request.context);
        assert.equal(result.isError, true);
        assert.match(result.error?.message ?? "", /user guidance/i);
      },
    });
    const activeStep = runtime.step();
    await started;
    assert.equal(activeRequest?.reason.type, "integration_approval_required");
    runtime.submitUserGuidance({
      guidanceId: "guidance-race",
      text: "Do not integrate until the naming is reconciled.",
      version: 1,
      idempotencyKey: "guidance:race",
    });
    releaseArchitect();
    assert.equal((await activeStep).action, "integration_approval_required");
    assert.equal(runtime.projection().tasks["task-a"].status, "approved");
    assert.equal(runtime.projection().userGuidance["guidance-race"].status, "submitted");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the scheduler authority boundary blocks stale review, integration, completion, and handoff events", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-steering-authority-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    seedPlan(store, [task("task-a", "planned")]);
    store.append({
      runId: RUN_ID,
      type: "user.guidance_submitted",
      occurredAt: CLOCK(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "guidance:authority",
      payload: { guidanceId: "guidance-authority", text: "Reconcile this first.", version: 1 },
    });
    for (const [type, payload] of [
      ["review.decided", { taskId: "task-a" }],
      ["task.transitioned", { taskId: "task-a", status: "integrating" }],
      ["run.completed", {}],
      ["project.handoff_requested", { summary: "stale" }],
    ] as const) {
      assert.throws(() => store.append({
        runId: RUN_ID,
        type,
        occurredAt: CLOCK(),
        actor: { role: "architect", id: "stale-architect" },
        idempotencyKey: `stale:${type}`,
        payload,
      }), /user guidance/i);
    }
    assert.throws(() => store.append({
      runId: RUN_ID,
      type: "task.transitioned",
      occurredAt: CLOCK(),
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: "stale:worker-submission",
      payload: { taskId: "task-a", status: "submitted", patch: { changeSetId: "stale" } },
    }), /stale worker submission|user guidance/i);

    for (const [type, actor, payload] of [
      ["guidance.requested", { role: "worker", id: "stale-worker" }, {
        requestId: "stale-guidance",
        taskId: "task-a",
        blocking: false,
        question: "Should stale work continue?",
        evidenceSequence: 1,
      }],
      ["task.transitioned", { role: "runner", id: "scheduler" }, {
        taskId: "task-a",
        status: "assigned",
        patch: { assignedWorkerId: "stale-worker", workspacePath: "C:/stale" },
      }],
      ["task.transitioned", { role: "runner", id: "scheduler" }, {
        taskId: "task-a",
        status: "failed",
        patch: { failureReason: "stale worker failure" },
      }],
      ["final_verification.generation_created", { role: "runner", id: "final-verification" }, {
        generationId: "stale-generation",
        targetRevision: "stale-revision",
      }],
      ["final_verification.check_completed", { role: "runner", id: "final-verification" }, {
        generationId: "stale-generation",
        category: "tests",
        status: "passed",
      }],
    ] as const) {
      assert.throws(() => store.append({
        runId: RUN_ID,
        type,
        occurredAt: CLOCK(),
        actor,
        idempotencyKey: `stale:${type}:${JSON.stringify(payload)}`,
        payload,
      }), /user guidance/i);
    }

    assert.doesNotThrow(() => store.append({
      runId: RUN_ID,
      type: "architect.runtime_assigned",
      occurredAt: CLOCK(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "recovery:architect-runtime",
      payload: { runtimeId: "architect-runtime-recovery" },
    }));
    assert.equal(store.readRun(RUN_ID).at(-1)?.type, "architect.runtime_assigned");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("guidance during an already-started integration records its exact revision before preempting later semantic progress", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-steering-integration-checkpoint-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  let integrationStarted!: () => void;
  let finishIntegration!: () => void;
  const started = new Promise<void>((resolve) => { integrationStarted = resolve; });
  const finished = new Promise<void>((resolve) => { finishIntegration = resolve; });
  try {
    seedPlan(store, [task("task-a", "integrating", { changeSetId: "change-a" })]);
    const runtime = new BuildRuntime({
      runId: RUN_ID,
      store,
      workerDriver: { run: async () => ({ type: "paused", reason: "unused" }) },
      architectDriver: {
        run: async (request) => {
          assert.equal(request.reason.type, "user_guidance_required");
          acknowledge(store, "guidance-integration", 1);
        },
      },
      integrationDriver: {
        integrate: async () => {
          integrationStarted();
          await finished;
          return { status: "integrated", integrationRevision: "revision-after-git-checkpoint" };
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => "unused",
      clock: CLOCK,
    });
    const activeStep = runtime.step();
    await started;
    runtime.submitUserGuidance({
      guidanceId: "guidance-integration",
      text: "Reconcile after the in-flight Git checkpoint.",
      version: 1,
      idempotencyKey: "guidance:integration",
    });
    finishIntegration();
    assert.equal((await activeStep).action, "integration_integrated");
    assert.equal(runtime.projection().tasks["task-a"].status, "integrated");
    assert.equal(runtime.projection().integrationRevision, "revision-after-git-checkpoint");
    assert.equal((await runtime.step()).action, "user_guidance_required");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function runtimeFor(store: SqliteSchedulerStore, architectDriver: ArchitectRuntimeDriver): BuildRuntime {
  return new BuildRuntime({
    runId: RUN_ID,
    initialObjective: OBJECTIVE,
    store,
    workerDriver: { run: async () => ({ type: "paused", reason: "unused" }) },
    architectDriver,
    integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
    maxConcurrency: 1,
    workspaceFor: async () => "C:/work/unused",
    clock: CLOCK,
  });
}

async function invoke(request: ArchitectActionRequest, name: string, argumentsValue: unknown): Promise<void> {
  const call: ToolCallBlock = { type: "tool_call", callId: `${name}:1`, name, arguments: argumentsValue };
  const result = await request.tools.invoke(call, request.context);
  assert.equal(result.isError, false, result.error?.message ?? `${name} failed`);
}

function acknowledge(store: SqliteSchedulerStore, guidanceId: string, expectedVersion: number): void {
  store.append({
    runId: RUN_ID,
    type: "user.guidance_acknowledged",
    occurredAt: CLOCK(),
    actor: { role: "architect", id: "architect-test" },
    idempotencyKey: `ack:${guidanceId}`,
    payload: {
      guidanceId,
      expectedVersion,
      resolution: { type: "no_plan_change", rationale: "No plan change is required for this test.", evidenceIds: ["evidence-1"] },
    },
  });
}

function seedPlan(store: SqliteSchedulerStore, tasks: BuildTask[]): void {
  store.append({
    runId: RUN_ID,
    type: "run.initialized",
    occurredAt: CLOCK(),
    actor: { role: "runner", id: "test" },
    idempotencyKey: "init",
    payload: { objective: OBJECTIVE },
  });
  store.append({
    runId: RUN_ID,
    type: "plan.created",
    occurredAt: CLOCK(),
    actor: { role: "architect", id: "architect-test" },
    idempotencyKey: "plan:1",
    payload: { revision: 1, tasks },
  });
}

function task(id: string, status: BuildTask["status"], patch: Partial<BuildTask> = {}): BuildTask {
  return {
    id,
    objective: `Implement ${id}`,
    dependencies: [],
    requiredCapabilities: ["code"],
    acceptanceCriteria: [{ id: "done", text: `${id} is complete.` }],
    acceptanceCriteriaVersion: 1,
    status,
    attempt: status === "planned" ? 0 : 1,
    ...patch,
  };
}
