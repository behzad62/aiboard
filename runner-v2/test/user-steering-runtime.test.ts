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
import { rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import type { EvidenceStore } from "../src/evidence-store.js";
import type { BuildTask } from "../src/task-contracts.js";
import type { WorkerAssignment, WorkerOutcome } from "../src/task-scheduler.js";

const RUN_ID = "steering-run";
const CLOCK = () => "2026-08-27T00:00:00.000Z";
const OBJECTIVE = "Build\nexactly\tthis application.  ";
const FIXTURE_EVIDENCE_STORE: EvidenceStore = {
  record: () => { throw new Error("unused"); },
  list: () => [],
  getByIds: ({ runId, ids }) => ids.map((id) => ({
    id,
    runId,
    taskId: "architect",
    actor: { role: "architect", id: "architect-test" },
    status: "observed",
    fact: {
      kind: "browser_screenshot",
      label: "legacy steering fixture",
      capturedAt: CLOCK(),
      screenshotArtifactHash: "e".repeat(64),
      mediaType: "image/png",
      byteLength: 1,
    },
    createdAt: CLOCK(),
    idempotencyKey: `fixture:${id}`,
  })),
  close: () => undefined,
};

test("answered Architect questions resume their exact action across restarts and allow a follow-up question", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-architect-question-resume-"));
  const database = join(root, "scheduler.sqlite");
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  let store: SqliteSchedulerStore | undefined = new SqliteSchedulerStore(database, { evidenceStore });
  let architectCalls = 0;
  const evidence = evidenceStore.record({
    runId: RUN_ID,
    taskId: "architect",
    actor: { role: "architect", id: "architect-test" },
    fact: {
      kind: "browser_screenshot",
      label: "guided initial plan evidence",
      capturedAt: CLOCK(),
      screenshotArtifactHash: "f".repeat(64),
      mediaType: "image/png",
      byteLength: 16,
    },
    createdAt: CLOCK(),
    idempotencyKey: "question-resume-evidence",
  });
  const driver: ArchitectRuntimeDriver = {
    run: async (request) => {
      architectCalls += 1;
      if (architectCalls === 1) {
        assert.equal(request.reason.type, "plan_required");
        await invoke(request, "ask_user", {
          questionId: "question-one",
          version: 1,
          decisionKind: "authority_decision",
          question: "Which public compatibility contract is authoritative?",
        });
        return;
      }
      if (architectCalls === 2) {
        assert.deepEqual(request.reason, { type: "plan_required" });
        assert.equal(request.projection.userGuidance["guidance-during-question"].status, "submitted");
        await invoke(request, "ask_user", {
          questionId: "question-two",
          version: 2,
          decisionKind: "requirement_conflict",
          question: "Should the documented alias remain supported too?",
        });
        return;
      }
      if (architectCalls === 3) {
        assert.deepEqual(request.reason, { type: "plan_required" });
        await invoke(request, "plan_tasks", {
          revision: 1,
          tasks: [{
            id: "task-a",
            objective: "Implement the user-confirmed compatible API.",
            dependencies: [],
            requiredCapabilities: ["code"],
            acceptanceCriteria: [{ id: "done", text: "The compatible API is implemented." }],
          }],
        });
        return;
      }
      assert.equal(request.reason.type, "user_guidance_required");
      await invoke(request, "acknowledge_user_guidance", {
        guidanceId: "guidance-during-question",
        expectedVersion: 1,
        resolution: {
          type: "no_plan_change",
          rationale: "The user-confirmed initial plan already implements this guidance exactly.",
          evidenceIds: [evidence.id],
        },
      });
    },
  };
  const makeRuntime = () => new BuildRuntime({
    runId: RUN_ID,
    initialObjective: OBJECTIVE,
    store: store!,
    evidenceStore,
    workerDriver: { run: async () => ({ type: "paused", reason: "unused" }) },
    architectDriver: driver,
    integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
    maxConcurrency: 1,
    workspaceFor: async () => "C:/work/unused",
    clock: CLOCK,
  });
  try {
    let runtime = makeRuntime();
    assert.equal((await runtime.step()).action, "plan_required");
    assert.equal(runtime.projection().blockingArchitectQuestionId, "question-one");

    store.close();
    store = new SqliteSchedulerStore(database, { evidenceStore });
    runtime = makeRuntime();
    assert.deepEqual(await runtime.step(), { status: "blocked", action: "architect_question_pending" });
    assert.equal(architectCalls, 1);
    runtime.submitUserGuidance({
      guidanceId: "guidance-during-question",
      text: "Keep the confirmed public API stable.",
      version: 1,
      idempotencyKey: "guidance:during-question",
    });
    appendQuestionAnswer(store, "question-one", 1, "The documented public contract is authoritative.");

    store.close();
    store = new SqliteSchedulerStore(database, { evidenceStore });
    runtime = makeRuntime();
    assert.equal((await runtime.step()).action, "architect_question_resumed");
    assert.equal(runtime.projection().blockingArchitectQuestionId, "question-two");
    assert.equal(runtime.projection().architectQuestions["question-one"].resumeStatus, "consumed");
    appendQuestionAnswer(store, "question-two", 2, "Yes, preserve the documented alias.");
    store.append({
      runId: RUN_ID,
      type: "architect.question_resume_started",
      occurredAt: CLOCK(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "question-two:resume-started-before-crash",
      payload: { questionId: "question-two", expectedVersion: 2 },
    });

    store.close();
    store = new SqliteSchedulerStore(database, { evidenceStore });
    runtime = makeRuntime();
    assert.equal((await runtime.step()).action, "architect_question_resumed");
    assert.equal(runtime.projection().planRevision, 1);
    assert.equal(runtime.projection().architectQuestions["question-two"].resumeStatus, "consumed");
    assert.equal((await runtime.step()).action, "user_guidance_required");
    assert.equal(runtime.projection().userGuidance["guidance-during-question"].status, "acknowledged");
    assert.equal(architectCalls, 4);
  } finally {
    store?.close();
    evidenceStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a question asked while acknowledging guidance resumes that exact guidance before newer steering", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-guidance-question-resume-"));
  const database = join(root, "scheduler.sqlite");
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const evidence = evidenceStore.record({
    runId: RUN_ID,
    taskId: "architect",
    actor: { role: "architect", id: "architect-test" },
    fact: {
      kind: "browser_screenshot",
      label: "guidance equivalence",
      capturedAt: CLOCK(),
      screenshotArtifactHash: "d".repeat(64),
      mediaType: "image/png",
      byteLength: 16,
    },
    createdAt: CLOCK(),
    idempotencyKey: "guidance-question-evidence",
  });
  let store: SqliteSchedulerStore | undefined = new SqliteSchedulerStore(database, { evidenceStore });
  let architectCalls = 0;
  const driver: ArchitectRuntimeDriver = {
    run: async (request) => {
      architectCalls += 1;
      if (architectCalls === 1) {
        assert.deepEqual(request.reason, { type: "user_guidance_required", guidanceId: "guidance-one", version: 1 });
        await invoke(request, "ask_user", {
          questionId: "guidance-question",
          version: 1,
          decisionKind: "authority_decision",
          question: "Which compatibility contract is authoritative?",
        });
        return;
      }
      const guidanceId = architectCalls === 2 ? "guidance-one" : "guidance-two";
      const version = architectCalls === 2 ? 1 : 2;
      assert.deepEqual(request.reason, { type: "user_guidance_required", guidanceId, version });
      await invoke(request, "acknowledge_user_guidance", {
        guidanceId,
        expectedVersion: version,
        resolution: {
          type: "no_plan_change",
          rationale: "Current durable evidence proves semantic equivalence.",
          evidenceIds: [evidence.id],
        },
      });
    },
  };
  const makeRuntime = () => new BuildRuntime({
    runId: RUN_ID,
    initialObjective: OBJECTIVE,
    store: store!,
    evidenceStore,
    workerDriver: { run: async () => ({ type: "paused", reason: "unused" }) },
    architectDriver: driver,
    integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
    maxConcurrency: 1,
    workspaceFor: async () => "C:/work/unused",
    clock: CLOCK,
  });
  try {
    seedPlan(store, [{
      id: "task-a",
      objective: "Implement the existing compatible API.",
      dependencies: [],
      requiredCapabilities: ["code"],
      acceptanceCriteria: [{ id: "done", text: "The compatible API is implemented." }],
      acceptanceCriteriaVersion: 1,
      status: "planned",
      attempt: 0,
    }]);
    let runtime = makeRuntime();
    runtime.submitUserGuidance({ guidanceId: "guidance-one", text: "Preserve compatibility.", version: 1, idempotencyKey: "guidance:one" });
    assert.equal((await runtime.step()).action, "user_guidance_required");
    runtime.submitUserGuidance({ guidanceId: "guidance-two", text: "Retain the alias too.", version: 2, idempotencyKey: "guidance:two" });
    appendQuestionAnswer(store, "guidance-question", 1, "The existing public contract is authoritative.");

    store.close();
    store = new SqliteSchedulerStore(database, { evidenceStore });
    runtime = makeRuntime();
    assert.equal((await runtime.step()).action, "architect_question_resumed");
    assert.equal(runtime.projection().userGuidance["guidance-one"].status, "acknowledged");
    assert.equal(runtime.projection().architectQuestions["guidance-question"].resumeStatus, "consumed");
    assert.equal((await runtime.step()).action, "user_guidance_required");
    assert.equal(runtime.projection().userGuidance["guidance-two"].status, "acknowledged");
    assert.equal(store.readRun(RUN_ID).filter((event) => event.type === "user.guidance_acknowledged").length, 2);
    assert.equal(store.readRun(RUN_ID).filter((event) => event.type === "architect.question_resume_consumed").length, 1);
    assert.equal(architectCalls, 3);
  } finally {
    store?.close();
    evidenceStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan-changing guidance supersedes an answered final-verification-plan checkpoint when it adds implementation work", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-stale-fv-plan-question-"));
  const database = join(root, "scheduler.sqlite");
  let store: SqliteSchedulerStore | undefined = new SqliteSchedulerStore(database, {
    evidenceStore: FIXTURE_EVIDENCE_STORE,
  });
  let workerAssignment: WorkerAssignment | undefined;
  try {
    seedPlan(store, [task("task-a", "integrated")]);
    store.append({
      runId: RUN_ID,
      type: "integration.revision_advanced",
      occurredAt: CLOCK(),
      actor: { role: "runner", id: "integration-manager" },
      idempotencyKey: "integration:revision:stale-fv-plan",
      payload: { integrationRevision: "revision-before-guidance" },
    });
    const checkpointSequence = rebuildSchedulerProjection(store.readRun(RUN_ID)).lastSequence;
    store.append({
      runId: RUN_ID,
      type: "architect.question_requested",
      occurredAt: CLOCK(),
      actor: { role: "architect", id: "architect-test" },
      idempotencyKey: "question:stale-fv-plan",
      payload: {
        questionId: "question-fv-plan",
        version: 1,
        decisionKind: "authority_decision",
        question: "May final verification use the external test account?",
        checkpoint: {
          reason: {
            type: "final_verification_plan_required",
            integrationRevision: "revision-before-guidance",
          },
          sequence: checkpointSequence,
        },
      },
    });
    const architectDriver: ArchitectRuntimeDriver = {
      run: async (request) => {
        assert.equal(request.reason.type, "user_guidance_required");
        await invoke(request, "acknowledge_user_guidance", {
          guidanceId: "guidance-add-work",
          expectedVersion: 1,
          resolution: {
            type: "plan_reconciled",
            rationale: "The new requested behavior requires an additional implementation task.",
            planReconciliation: {
              revision: 2,
              summary: "Add the newly requested implementation work.",
              taskUpdates: [],
              newTasks: [{
                id: "task-b",
                objective: "Implement the newly requested behavior.",
                dependencies: ["task-a"],
                requiredCapabilities: ["code"],
                acceptanceCriteria: [{ id: "task-b-done", text: "The new behavior is implemented." }],
              }],
            },
          },
        });
      },
    };
    const makeRuntime = () => new BuildRuntime({
      runId: RUN_ID,
      initialObjective: OBJECTIVE,
      store: store!,
      workerDriver: {
        run: async (assignment) => {
          workerAssignment = assignment;
          return { type: "failed", reason: "scheduling probe complete" };
        },
      },
      architectDriver,
      integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/work/task-b",
      clock: CLOCK,
    });

    appendQuestionAnswer(store, "question-fv-plan", 1, "Do not use the external account; add a local substitute.");
    let runtime = makeRuntime();
    runtime.submitUserGuidance({
      guidanceId: "guidance-add-work",
      text: "Implement a local substitute before final verification.",
      version: 1,
      idempotencyKey: "guidance:add-work-before-fv",
    });
    assert.equal((await runtime.step()).action, "user_guidance_required");
    assert.equal(runtime.projection().tasks["task-b"].status, "planned");
    assert.equal(runtime.projection().architectQuestions["question-fv-plan"].resumeStatus, "superseded");

    store.close();
    store = new SqliteSchedulerStore(database, { evidenceStore: FIXTURE_EVIDENCE_STORE });
    runtime = makeRuntime();
    assert.equal(runtime.projection().architectQuestions["question-fv-plan"].resumeStatus, "superseded");
    assert.equal((await runtime.step()).action, "workers_advanced");
    assert.equal(workerAssignment?.task.id, "task-b");
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan-changing guidance supersedes a resolved failed-task checkpoint after capacity is granted", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-stale-failure-question-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), {
    evidenceStore: FIXTURE_EVIDENCE_STORE,
  });
  try {
    seedPlan(store, [task("task-a", "failed", {
      attempt: 1,
      attemptLimit: 1,
      failureReason: "old worker failure",
    })]);
    const runtime = runtimeFor(store, {
      run: async (request) => {
        if (request.reason.type === "task_failure_resolution_required") {
          await invoke(request, "ask_user", {
            questionId: "question-failure",
            version: 1,
            decisionKind: "authority_decision",
            question: "May the failed implementation use the compatible fallback?",
          });
          return;
        }
        assert.equal(request.reason.type, "user_guidance_required");
        await invoke(request, "acknowledge_user_guidance", {
          guidanceId: "guidance-revise-failure",
          expectedVersion: 1,
          resolution: {
            type: "plan_reconciled",
            rationale: "The user authorized a revised implementation attempt.",
            planReconciliation: {
              revision: 2,
              summary: "Revise the failed task for a fresh attempt.",
              taskUpdates: [{
                taskId: "task-a",
                action: "revise",
                objective: "Implement task-a using the authorized fallback.",
              }],
            },
          },
        });
      },
    });

    assert.equal((await runtime.step()).action, "task_failure_resolution_required");
    appendQuestionAnswer(store, "question-failure", 1, "Use the compatible fallback.");
    runtime.submitUserGuidance({
      guidanceId: "guidance-revise-failure",
      text: "Retry using the compatible fallback.",
      version: 1,
      idempotencyKey: "guidance:revise-failure",
    });
    assert.equal((await runtime.step()).action, "user_guidance_required");
    const projection = runtime.projection();
    assert.equal(projection.tasks["task-a"].status, "planned");
    assert.equal(projection.tasks["task-a"].attempt, 1);
    assert.equal(projection.tasks["task-a"].attemptLimit, 2);
    assert.equal(projection.tasks["task-a"].failureReason, undefined);
    assert.equal(projection.architectQuestions["question-failure"].resumeStatus, "superseded");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan-changing guidance preserves an answered exhausted-planned checkpoint when its entry invariant still holds", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-exhausted-planned-question-"));
  const database = join(root, "scheduler.sqlite");
  let store: SqliteSchedulerStore | undefined = new SqliteSchedulerStore(database, {
    evidenceStore: FIXTURE_EVIDENCE_STORE,
  });
  try {
    seedPlan(store, [task("task-a", "planned", { attempt: 2, attemptLimit: 2 })]);
    const checkpointSequence = rebuildSchedulerProjection(store.readRun(RUN_ID)).lastSequence;
    store.append({
      runId: RUN_ID,
      type: "architect.question_requested",
      occurredAt: CLOCK(),
      actor: { role: "architect", id: "architect-test" },
      idempotencyKey: "question:exhausted-planned",
      payload: {
        questionId: "question-exhausted-planned",
        version: 1,
        decisionKind: "repair_budget_exhausted",
        question: "May the attempt budget be increased?",
        checkpoint: {
          reason: {
            type: "task_failure_resolution_required",
            taskId: "task-a",
            attempt: 2,
            failureReason: "task_attempt_budget_exhausted",
          },
          sequence: checkpointSequence,
        },
      },
    });
    appendQuestionAnswer(store, "question-exhausted-planned", 1, "Keep the current budget for now.");
    const architectDriver: ArchitectRuntimeDriver = {
      run: async (request) => {
        if (request.reason.type === "user_guidance_required") {
          await invoke(request, "acknowledge_user_guidance", {
            guidanceId: "guidance-unrelated-task",
            expectedVersion: 1,
            resolution: {
              type: "plan_reconciled",
              rationale: "The guidance adds unrelated work and does not resolve the exhausted task.",
              planReconciliation: {
                revision: 2,
                summary: "Add unrelated implementation work.",
                taskUpdates: [],
                newTasks: [{
                  id: "task-b",
                  objective: "Implement the unrelated requested behavior.",
                  dependencies: [],
                  requiredCapabilities: ["code"],
                  acceptanceCriteria: [{ id: "task-b-done", text: "The unrelated behavior is implemented." }],
                }],
              },
            },
          });
          return;
        }
        assert.equal(request.reason.type, "task_failure_resolution_required");
        await invoke(request, "ask_user", {
          questionId: "question-exhausted-follow-up",
          version: 2,
          decisionKind: "repair_budget_exhausted",
          question: "Should the exhausted task now receive another attempt?",
        });
      },
    };
    const makeRuntime = () => runtimeFor(store!, architectDriver);
    let runtime = makeRuntime();
    runtime.submitUserGuidance({
      guidanceId: "guidance-unrelated-task",
      text: "Add an unrelated behavior without changing task-a.",
      version: 1,
      idempotencyKey: "guidance:unrelated-task",
    });
    assert.equal((await runtime.step()).action, "user_guidance_required");
    assert.equal(runtime.projection().architectQuestions["question-exhausted-planned"].resumeStatus, "pending");

    store.close();
    store = new SqliteSchedulerStore(database, { evidenceStore: FIXTURE_EVIDENCE_STORE });
    runtime = makeRuntime();
    assert.equal((await runtime.step()).action, "architect_question_resumed");
    assert.equal(runtime.projection().architectQuestions["question-exhausted-planned"].resumeStatus, "consumed");
    assert.equal(runtime.projection().blockingArchitectQuestionId, "question-exhausted-follow-up");
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("production initialization preserves the objective bytes and durable guidance wins the next Architect action", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-steering-init-"));
  const database = join(root, "scheduler.sqlite");
  let store: SqliteSchedulerStore | undefined = new SqliteSchedulerStore(database, { evidenceStore: FIXTURE_EVIDENCE_STORE });
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

    const recoveredStore = new SqliteSchedulerStore(database, { evidenceStore: FIXTURE_EVIDENCE_STORE });
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
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore: FIXTURE_EVIDENCE_STORE });
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
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore: FIXTURE_EVIDENCE_STORE });
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
  let store: SqliteSchedulerStore | undefined = new SqliteSchedulerStore(database, { evidenceStore: FIXTURE_EVIDENCE_STORE });
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

    const recoveredStore = new SqliteSchedulerStore(database, { evidenceStore: FIXTURE_EVIDENCE_STORE });
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
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore: FIXTURE_EVIDENCE_STORE });
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
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore: FIXTURE_EVIDENCE_STORE });
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
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore: FIXTURE_EVIDENCE_STORE });
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
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore: FIXTURE_EVIDENCE_STORE });
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
      ["run.paused", { role: "runner", id: "scheduler" }, {
        reason: "worker_cancelled",
        taskId: "task-a",
      }],
      ["run.resumed", { role: "worker", id: "stale-worker" }, {}],
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
      type: "run.paused",
      occurredAt: CLOCK(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "user:pause:pending-guidance",
      payload: { reason: "user_requested_pause" },
    }));
    assert.doesNotThrow(() => store.append({
      runId: RUN_ID,
      type: "run.resumed",
      occurredAt: CLOCK(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "user:resume:pending-guidance",
      payload: {},
    }));
    assert.equal(store.readRun(RUN_ID).at(-1)?.type, "run.resumed");
    assert.equal(rebuildSchedulerProjection(store.readRun(RUN_ID)).userGuidance["guidance-authority"].status, "submitted");

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
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore: FIXTURE_EVIDENCE_STORE });
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

test("managed guidance cannot reach the Architect before durable interruption completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-guidance-interruption-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore: FIXTURE_EVIDENCE_STORE });
  let architectCalls = 0;
  try {
    seedPlan(store, [task("task-a", "planned")]);
    const runtime = new BuildRuntime({
      runId: RUN_ID,
      store,
      workerDriver: { run: async () => ({ type: "paused", reason: "unused" }) },
      architectDriver: {
        run: async (request) => {
          architectCalls += 1;
          assert.deepEqual(request.reason, {
            type: "user_guidance_required",
            guidanceId: "guidance-managed",
            version: 1,
          });
          acknowledge(store, "guidance-managed", 1);
        },
      },
      integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
      maxConcurrency: 1,
      workspaceFor: async () => "unused",
      clock: CLOCK,
    });
    runtime.submitManagedUserGuidance({
      guidanceId: "guidance-managed",
      text: "Wait until the old verification is retired.",
      version: 1,
      idempotencyKey: "guidance:managed",
    });
    assert.deepEqual(await runtime.step(), {
      status: "blocked",
      action: "user_guidance_interruption_pending",
    });
    assert.equal(architectCalls, 0);
    runtime.completeManagedUserGuidanceInterruption("guidance-managed", 1);
    assert.equal((await runtime.step()).action, "user_guidance_required");
    assert.equal(architectCalls, 1);
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

function appendQuestionAnswer(
  store: SqliteSchedulerStore,
  questionId: string,
  expectedVersion: number,
  answer: string,
): void {
  store.append({
    runId: RUN_ID,
    type: "architect.question_answered",
    occurredAt: CLOCK(),
    actor: { role: "user", id: "local-user" },
    idempotencyKey: `answer:${questionId}:${expectedVersion}`,
    payload: { questionId, expectedVersion, answer },
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
