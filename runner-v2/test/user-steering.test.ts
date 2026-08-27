import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { rebuildSchedulerProjection, type NewSchedulerEvent } from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { TaskScheduler } from "../src/task-scheduler.js";
import { workerSessionId } from "../src/worker-identity.js";

const RUN_ID = "run_user_steering";
const USER = { role: "user" as const, id: "local-user" };
const ARCHITECT = { role: "architect" as const, id: "architect-1" };

test("P3.1 durable guidance is idempotent, versioned, acknowledged once, and preserves objective bytes", () => {
  withStore((store, database) => {
    initialize(store, "Build\nexactly\tthis application.");
    const guidance = append(store, "user.guidance_submitted", USER, "guidance:one", {
      guidanceId: "guidance-1",
      text: "Use the blue account flow.",
      version: 1,
    });
    const duplicate = append(store, "user.guidance_submitted", USER, "guidance:one", {
      guidanceId: "guidance-1",
      text: "Use the blue account flow.",
      version: 1,
    });
    assert.equal(duplicate.eventId, guidance.eventId);
    assert.equal(store.readRun(RUN_ID).filter((event) => event.type === "user.guidance_submitted").length, 1);
    assert.throws(() => append(store, "user.guidance_submitted", USER, "guidance:one", {
      guidanceId: "guidance-1",
      text: "Use the red account flow.",
      version: 1,
    }), /idempotency conflict/i);

    append(store, "user.guidance_acknowledged", ARCHITECT, "guidance:ack", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
      resolution: {
        type: "no_plan_change",
        rationale: "The existing plan already includes the requested account flow.",
        evidenceIds: ["evidence:plan:1"],
      },
    });
    assert.throws(() => append(store, "user.guidance_acknowledged", ARCHITECT, "guidance:ack:duplicate", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
      resolution: {
        type: "no_plan_change",
        rationale: "A second acknowledgement is forbidden.",
        evidenceIds: ["evidence:plan:1"],
      },
    }), /already acknowledged/i);
    append(store, "user.guidance_submitted", USER, "guidance:two", {
      guidanceId: "guidance-2",
      text: "Also retain the accessible contrast mode.",
      version: 2,
    });
    assert.throws(() => append(store, "user.guidance_submitted", USER, "guidance:out-of-order", {
      guidanceId: "guidance-3",
      text: "This skips a version.",
      version: 4,
    }), /version must advance/i);
    assert.equal(existsSync(`${database}-wal`), true);

    store.close();
    const reopened = new SqliteSchedulerStore(database);
    const projection = rebuildSchedulerProjection(reopened.readRun(RUN_ID));
    assert.equal(projection.initialObjective, "Build\nexactly\tthis application.");
    assert.equal(projection.userGuidance["guidance-1"].version, 1);
    assert.equal(projection.userGuidance["guidance-1"].status, "acknowledged");
    assert.deepEqual(projection.userGuidance["guidance-1"].resolution, {
      type: "no_plan_change",
      rationale: "The existing plan already includes the requested account flow.",
      evidenceIds: ["evidence:plan:1"],
    });
    assert.equal(projection.userGuidanceVersion, 2);
    assert.equal(projection.userGuidance["guidance-2"].status, "submitted");
    reopened.close();
  });
});

test("P3.1 plan-reconciled acknowledgement atomically changes the plan and survives WAL reopen", () => {
  withStore((store, database) => {
    initialize(store, "Build the requested application.");
    seedPlan(store);
    append(store, "user.guidance_submitted", USER, "guidance:reconcile", {
      guidanceId: "guidance-reconcile", text: "Make the dashboard keyboard-accessible.", version: 1,
    });
    const acknowledgement = append(store, "user.guidance_acknowledged", ARCHITECT, "guidance:reconcile:ack", {
      guidanceId: "guidance-reconcile",
      expectedVersion: 1,
      resolution: {
        type: "plan_reconciled",
        rationale: "The new accessibility requirement changes the planned dashboard work.",
        planReconciliation: {
          revision: 2,
          summary: "Add keyboard accessibility to the dashboard task.",
          taskUpdates: [{
            taskId: "task-1",
            action: "revise",
            objective: "Implement the keyboard-accessible dashboard.",
          }],
        },
      },
    });
    const duplicate = append(store, "user.guidance_acknowledged", ARCHITECT, "guidance:reconcile:ack", {
      guidanceId: "guidance-reconcile",
      expectedVersion: 1,
      resolution: {
        type: "plan_reconciled",
        rationale: "The new accessibility requirement changes the planned dashboard work.",
        planReconciliation: {
          revision: 2,
          summary: "Add keyboard accessibility to the dashboard task.",
          taskUpdates: [{
            taskId: "task-1",
            action: "revise",
            objective: "Implement the keyboard-accessible dashboard.",
          }],
        },
      },
    });
    assert.equal(duplicate.eventId, acknowledgement.eventId);
    const current = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.equal(current.userGuidance["guidance-reconcile"].status, "acknowledged");
    assert.equal(current.userGuidance["guidance-reconcile"].resolution?.type, "plan_reconciled");
    assert.equal(current.planRevision, 2);
    assert.equal(current.tasks["task-1"].objective, "Implement the keyboard-accessible dashboard.");
    assert.equal(existsSync(`${database}-wal`), true);

    store.close();
    const reopened = new SqliteSchedulerStore(database);
    const replayed = rebuildSchedulerProjection(reopened.readRun(RUN_ID));
    assert.deepEqual(replayed, current);
    reopened.close();
  });
});

test("steering acknowledgement can revise or cancel interrupted running attempts atomically", () => {
  withStore((store) => {
    initialize(store, "Build the requested application.");
    append(store, "plan.created", ARCHITECT, "plan:running", {
      revision: 1,
      tasks: ["revise", "cancel"].map((suffix) => ({
        id: `task-${suffix}`,
        objective: `Implement ${suffix}.`,
        dependencies: [],
        status: "running",
        requiredCapabilities: ["code"],
        acceptanceCriteria: [{ id: "done", text: `${suffix} is complete.` }],
        acceptanceCriteriaVersion: 1,
        attempt: 2,
        assignedWorkerId: `worker-${suffix}`,
        workspacePath: `C:/work/${suffix}`,
        changeSetId: `stale-${suffix}`,
        criterionEvidenceLinks: [{ criterionId: "done", evidenceIds: ["stale-evidence"], artifactHashes: ["stale-hash"] }],
        failureReason: "stale failure",
      })),
    });
    append(store, "worker.runtime_assigned", { role: "runner", id: "runtime-router" }, "runtime:revise", {
      taskId: "task-revise", attempt: 2, runtimeId: "stale-runtime", sessionId: "stale-session",
    });
    append(store, "worker.runtime_assigned", { role: "runner", id: "runtime-router" }, "runtime:cancel", {
      taskId: "task-cancel", attempt: 2, runtimeId: "stale-runtime", sessionId: "stale-cancel-session",
    });
    append(store, "user.guidance_submitted", USER, "guidance:running", {
      guidanceId: "guidance-running", text: "Revise one active task and cancel the other.", version: 1,
    });
    append(store, "user.guidance_submitted", USER, "guidance:running:second", {
      guidanceId: "guidance-running-second", text: "Revise the first task again before cancelling the second.", version: 2,
    });

    append(store, "user.guidance_acknowledged", ARCHITECT, "guidance:running:ack", {
      guidanceId: "guidance-running",
      expectedVersion: 1,
      resolution: {
        type: "plan_reconciled",
        rationale: "The interrupted work must follow the revised direction.",
        planReconciliation: {
          revision: 2,
          summary: "First revision of interrupted work.",
          taskUpdates: [
            { taskId: "task-revise", action: "revise", objective: "Implement the revised active task.", requiredCapabilities: ["code", "browser"] },
            { taskId: "task-cancel", action: "revise", objective: "Implement the temporarily revised second task." },
          ],
        },
      },
    });

    const afterFirstGuidance = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.equal(afterFirstGuidance.tasks["task-revise"].status, "assigned");
    assert.equal(afterFirstGuidance.tasks["task-revise"].assignedWorkerId, "worker_task-revise_2_plan_2");
    assert.equal(afterFirstGuidance.tasks["task-cancel"].status, "assigned");
    assert.equal(afterFirstGuidance.userGuidance["guidance-running-second"].status, "submitted");

    append(store, "user.guidance_acknowledged", ARCHITECT, "guidance:running:second:ack", {
      guidanceId: "guidance-running-second",
      expectedVersion: 2,
      resolution: {
        type: "plan_reconciled",
        rationale: "The queued guidance supersedes both assigned checkpoints.",
        planReconciliation: {
          revision: 3,
          summary: "Revise the first checkpoint again and cancel the second.",
          taskUpdates: [
            { taskId: "task-revise", action: "revise", objective: "Implement the newest active task intent." },
            { taskId: "task-cancel", action: "cancel" },
          ],
        },
      },
    });

    const projection = rebuildSchedulerProjection(store.readRun(RUN_ID));
    const revised = projection.tasks["task-revise"];
    assert.equal(revised.status, "assigned");
    assert.equal(revised.attempt, 2);
    assert.equal(revised.objective, "Implement the newest active task intent.");
    assert.equal(revised.workspacePath, "C:/work/revise");
    assert.equal(revised.assignedWorkerId, "worker_task-revise_2_plan_3");
    assert.equal(revised.changeSetId, undefined);
    assert.equal(revised.criterionEvidenceLinks, undefined);
    assert.equal(revised.failureReason, undefined);
    assert.equal(projection.runtime.workerAssignments["task-revise:2"], undefined);
    assert.equal(projection.tasks["task-cancel"].status, "cancelled");
    assert.equal(projection.tasks["task-cancel"].attempt, 2);
    assert.equal(projection.tasks["task-cancel"].assignedWorkerId, undefined);
    assert.equal(projection.runtime.workerAssignments["task-cancel:2"], undefined);
  });
});

test("revised running work restarts on its new identity and submits new-worker evidence on the same attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-steering-reassigned-worker-"));
  const database = join(root, "scheduler.sqlite");
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  let store: SqliteSchedulerStore | undefined = new SqliteSchedulerStore(database, { evidenceStore });
  try {
    initialize(store, "Build the requested application.");
    append(store, "plan.created", ARCHITECT, "plan:active", {
      revision: 1,
      tasks: [{
        id: "task-active",
        objective: "Implement the old intent.",
        dependencies: [],
        status: "running",
        requiredCapabilities: ["code"],
        acceptanceCriteria: [{ id: "done", text: "The active task is complete." }],
        acceptanceCriteriaVersion: 1,
        attempt: 1,
        assignedWorkerId: "worker_task-active_1",
        workspacePath: "C:/work/task-active",
      }],
    });
    append(store, "worker.runtime_assigned", { role: "runner", id: "runtime-router" }, "runtime:old", {
      taskId: "task-active",
      attempt: 1,
      runtimeId: "runtime-old",
      sessionId: "worker:run_user_steering:task-active:1",
    });
    append(store, "user.guidance_submitted", USER, "guidance:active", {
      guidanceId: "guidance-active", text: "Use the revised browser-capable implementation.", version: 1,
    });
    append(store, "user.guidance_acknowledged", ARCHITECT, "guidance:active:ack", {
      guidanceId: "guidance-active",
      expectedVersion: 1,
      resolution: {
        type: "plan_reconciled",
        rationale: "The active worker must restart with revised intent.",
        planReconciliation: {
          revision: 2,
          summary: "Revise active work.",
          taskUpdates: [{
            taskId: "task-active",
            action: "revise",
            objective: "Implement the revised browser-capable intent.",
            requiredCapabilities: ["code", "browser"],
          }],
        },
      },
    });
    const reassigned = rebuildSchedulerProjection(store.readRun(RUN_ID)).tasks["task-active"];
    assert.equal(reassigned.status, "assigned");
    assert.equal(reassigned.attempt, 1);
    assert.equal(reassigned.assignedWorkerId, "worker_task-active_1_plan_2");
    const newSessionId = workerSessionId(
      RUN_ID,
      reassigned.id,
      reassigned.attempt,
      reassigned.assignedWorkerId!
    );
    assert.notEqual(newSessionId, "worker:run_user_steering:task-active:1");
    assert.throws(() => append(store!, "worker.runtime_assigned", { role: "runner", id: "runtime-router" }, "runtime:reassigned:stale-session", {
      taskId: "task-active",
      attempt: 1,
      runtimeId: "runtime-browser",
      sessionId: "worker:run_user_steering:task-active:1",
    }), /reassigned worker session/i);
    append(store, "worker.runtime_assigned", { role: "runner", id: "runtime-router" }, "runtime:reassigned", {
      taskId: "task-active",
      attempt: 1,
      runtimeId: "runtime-browser",
      sessionId: newSessionId,
    });
    const staleEvidence = evidenceStore.record({
      runId: RUN_ID,
      taskId: "task-active",
      actor: { role: "worker", id: "worker_task-active_1" },
      fact: {
        kind: "browser_screenshot",
        label: "stale old-worker evidence",
        capturedAt: "2026-08-27T00:00:00.000Z",
        screenshotArtifactHash: "a".repeat(64),
        mediaType: "image/png",
        byteLength: 16,
      },
      createdAt: "2026-08-27T00:00:00.000Z",
      idempotencyKey: "evidence:stale-old-worker",
      attempt: 1,
    });
    store.close();
    store = new SqliteSchedulerStore(database, { evidenceStore });

    const recovered = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.equal(recovered.runtime.workerAssignments["task-active:1"].sessionId, newSessionId);
    const scheduler = new TaskScheduler({
      runId: RUN_ID,
      store,
      driver: {
        run: async (assignment) => {
          assert.equal(assignment.workerId, "worker_task-active_1_plan_2");
          assert.equal(assignment.attempt, 1);
          assert.equal(assignment.task.objective, "Implement the revised browser-capable intent.");
          assert.deepEqual(assignment.task.requiredCapabilities, ["code", "browser"]);
          assert.equal(
            rebuildSchedulerProjection(store!.readRun(RUN_ID)).runtime.workerAssignments["task-active:1"].sessionId,
            newSessionId
          );
          assert.throws(() => append(store!, "task.transitioned", { role: "runner", id: "scheduler" }, "submit:stale-old-worker", {
            taskId: "task-active",
            status: "submitted",
            patch: {
              changeSetId: "stale-change-set",
              criterionEvidenceLinks: [{
                criterionId: "done",
                evidenceId: staleEvidence.id,
                artifactHashes: ["a".repeat(64)],
                taskId: "task-active",
                attempt: 1,
              }],
            },
          }), /outside the assigned worker/i);
          const evidence = evidenceStore.record({
            runId: RUN_ID,
            taskId: "task-active",
            actor: { role: "worker", id: assignment.workerId },
            fact: {
              kind: "browser_screenshot",
              label: "revised worker evidence",
              capturedAt: "2026-08-27T00:00:01.000Z",
              screenshotArtifactHash: "b".repeat(64),
              mediaType: "image/png",
              byteLength: 16,
            },
            createdAt: "2026-08-27T00:00:01.000Z",
            idempotencyKey: "evidence:revised-worker",
            attempt: 1,
          });
          return {
            type: "submitted",
            changeSetId: "revised-change-set",
            criterionEvidenceLinks: [{
              criterionId: "done",
              evidenceId: evidence.id,
              artifactHashes: ["b".repeat(64)],
              taskId: "task-active",
              attempt: 1,
            }],
          };
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/work/task-active",
      clock: () => "2026-08-27T00:00:02.000Z",
    });
    await scheduler.tick();
    await scheduler.awaitIdle();
    const submitted = rebuildSchedulerProjection(store.readRun(RUN_ID)).tasks["task-active"];
    assert.equal(submitted.status, "submitted");
    assert.equal(submitted.attempt, 1);
    assert.equal(submitted.assignedWorkerId, "worker_task-active_1_plan_2");
    assert.equal(submitted.changeSetId, "revised-change-set");
  } finally {
    store?.close();
    evidenceStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan-changing steering revokes stale approval, preserves history, and schedules revised work on a fresh attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-steering-approved-checkpoint-"));
  const database = join(root, "scheduler.sqlite");
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  let store: SqliteSchedulerStore | undefined = new SqliteSchedulerStore(database, { evidenceStore });
  try {
    initialize(store, "Build the requested application.");
    append(store, "plan.created", ARCHITECT, "plan:approved", {
      revision: 1,
      tasks: [{
        id: "task-approved",
        objective: "Implement the old approved intent.",
        dependencies: [],
        status: "running",
        requiredCapabilities: ["code"],
        acceptanceCriteria: [{ id: "done", text: "The implementation is complete." }],
        acceptanceCriteriaVersion: 1,
        attempt: 1,
        assignedWorkerId: "worker_task-approved_1",
        workspacePath: "C:/work/task-approved",
      }],
    });
    const evidence = evidenceStore.record({
      runId: RUN_ID,
      taskId: "task-approved",
      actor: { role: "worker", id: "worker_task-approved_1" },
      fact: {
        kind: "browser_screenshot",
        label: "old approved evidence",
        capturedAt: "2026-08-27T00:00:00.000Z",
        screenshotArtifactHash: "c".repeat(64),
        mediaType: "image/png",
        byteLength: 16,
      },
      createdAt: "2026-08-27T00:00:00.000Z",
      idempotencyKey: "evidence:approved-old",
      attempt: 1,
    });
    const evidenceLinks = [{
      criterionId: "done",
      evidenceId: evidence.id,
      artifactHashes: ["c".repeat(64)],
      taskId: "task-approved",
      attempt: 1,
    }];
    append(store, "task.transitioned", { role: "runner", id: "scheduler" }, "approved:submitted", {
      taskId: "task-approved",
      status: "submitted",
      patch: { changeSetId: "old-approved-change", criterionEvidenceLinks: evidenceLinks },
    });
    append(store, "review.requested", ARCHITECT, "approved:review-requested", {
      taskId: "task-approved",
      evidenceArtifactHashes: ["c".repeat(64)],
      criterionEvidenceLinks: evidenceLinks,
    });
    append(store, "review.decided", ARCHITECT, "approved:review-decided", {
      taskId: "task-approved",
      decision: "approved",
      summary: "The old intent was approved.",
      evidenceArtifactHashes: ["c".repeat(64)],
      criterionVerdicts: [{
        criterionId: "done",
        verdict: "satisfied",
        rationale: "The old evidence satisfied the old intent.",
        evidenceIds: [evidence.id],
        artifactHashes: ["c".repeat(64)],
      }],
    });
    assert.equal(rebuildSchedulerProjection(store.readRun(RUN_ID)).tasks["task-approved"].status, "approved");
    assert.throws(() => append(store!, "plan.reconciled", ARCHITECT, "approved:generic-bypass", {
      revision: 2,
      summary: "Attempt to bypass steering authority.",
      taskUpdates: [{ taskId: "task-approved", action: "revise", objective: "Bypassed intent." }],
    }), /planned, failed, or rejected/i);

    append(store, "user.guidance_submitted", USER, "approved:guidance", {
      guidanceId: "guidance-approved", text: "Replace the approved implementation before integration.", version: 1,
    });
    append(store, "user.guidance_acknowledged", ARCHITECT, "approved:guidance:ack", {
      guidanceId: "guidance-approved",
      expectedVersion: 1,
      resolution: {
        type: "plan_reconciled",
        rationale: "The approved change set implements stale intent.",
        planReconciliation: {
          revision: 2,
          summary: "Revoke stale approval and schedule fresh work.",
          taskUpdates: [{
            taskId: "task-approved",
            action: "revise",
            objective: "Implement the newly requested intent.",
            requiredCapabilities: ["code", "browser"],
            acceptanceCriteria: [{ id: "done", text: "The newly requested behavior is complete." }],
          }],
        },
      },
    });
    const revised = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.equal(revised.tasks["task-approved"].status, "planned");
    assert.equal(revised.tasks["task-approved"].attempt, 1);
    assert.equal(revised.tasks["task-approved"].attemptLimit, 2);
    assert.equal(revised.tasks["task-approved"].acceptanceCriteriaVersion, 2);
    assert.equal(revised.tasks["task-approved"].acceptanceCriteria?.[0]?.text, "The newly requested behavior is complete.");
    assert.equal(revised.tasks["task-approved"].assignedWorkerId, undefined);
    assert.equal(revised.tasks["task-approved"].changeSetId, undefined);
    assert.equal(revised.tasks["task-approved"].criterionEvidenceLinks, undefined);
    assert.equal(revised.reviews["task-approved"], undefined);
    assert.equal(revised.submissionHistory?.["task-approved"]?.length, 1);
    assert.equal(revised.submissionHistory?.["task-approved"]?.[0]?.acceptanceCriteriaVersion, 1);
    assert.equal(revised.reviewHistory?.["task-approved"]?.length, 1);
    assert.equal(revised.reviewHistory?.["task-approved"]?.[0]?.acceptanceCriteriaVersion, 1);
    assert.throws(() => append(store!, "task.transitioned", ARCHITECT, "approved:stale-integrate", {
      taskId: "task-approved", status: "integrating", patch: { changeSetId: "old-approved-change" },
    }), /cannot transition from planned to integrating/i);

    store.close();
    store = new SqliteSchedulerStore(database, { evidenceStore });
    const replayed = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.equal(replayed.tasks["task-approved"].status, "planned");
    assert.equal(replayed.submissionHistory?.["task-approved"]?.[0]?.changeSetId, "old-approved-change");
    assert.equal(replayed.reviewHistory?.["task-approved"]?.[0]?.status, "approved");
    let dispatched = false;
    const scheduler = new TaskScheduler({
      runId: RUN_ID,
      store,
      driver: {
        run: async (assignment) => {
          dispatched = true;
          assert.equal(assignment.attempt, 2);
          assert.equal(assignment.task.objective, "Implement the newly requested intent.");
          assert.deepEqual(assignment.task.requiredCapabilities, ["code", "browser"]);
          assert.equal(assignment.task.acceptanceCriteriaVersion, 2);
          return { type: "failed", reason: "Intent dispatch verified." };
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/work/task-approved-attempt-2",
      clock: () => "2026-08-27T00:00:02.000Z",
    });
    await scheduler.tick();
    await scheduler.awaitIdle();
    assert.equal(dispatched, true);
    assert.equal(rebuildSchedulerProjection(store.readRun(RUN_ID)).tasks["task-approved"].attempt, 2);
  } finally {
    store?.close();
    evidenceStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("steering checkpoint reconciliation covers submitted and architect review while no-change preserves them", () => {
  for (const status of ["submitted", "architect_review", "approved"] as const) {
    withStore((store) => {
      initialize(store, "Build the requested application.");
      append(store, "plan.created", ARCHITECT, `plan:${status}`, {
        revision: 1,
        tasks: [{
          id: `task-${status}`,
          objective: `Implement the ${status} intent.`,
          dependencies: [],
          status,
          requiredCapabilities: ["code"],
          acceptanceCriteria: [{ id: "done", text: "The task is complete." }],
          acceptanceCriteriaVersion: 1,
          criterionEvidenceLinks: [{ criterionId: "done", evidenceIds: ["old-evidence"], artifactHashes: [] }],
          attempt: 1,
          attemptLimit: 1,
          assignedWorkerId: `worker_task-${status}_1`,
          workspacePath: `C:/work/${status}`,
          changeSetId: `change-${status}`,
        }],
      });
      append(store, "user.guidance_submitted", USER, `guidance:${status}:no-change`, {
        guidanceId: `guidance-${status}-no-change`, text: "Keep the current implementation.", version: 1,
      });
      const before = rebuildSchedulerProjection(store.readRun(RUN_ID)).tasks[`task-${status}`];
      append(store, "user.guidance_acknowledged", ARCHITECT, `guidance:${status}:no-change:ack`, {
        guidanceId: `guidance-${status}-no-change`,
        expectedVersion: 1,
        resolution: { type: "no_plan_change", rationale: "The checkpoint remains valid.", evidenceIds: ["old-evidence"] },
      });
      assert.deepEqual(rebuildSchedulerProjection(store.readRun(RUN_ID)).tasks[`task-${status}`], before);
    });

    withStore((store) => {
      initialize(store, "Build the requested application.");
      append(store, "plan.created", ARCHITECT, `plan:${status}:revised`, {
        revision: 1,
        tasks: [{
          id: `task-${status}`,
          objective: `Implement the ${status} intent.`,
          dependencies: [],
          status,
          requiredCapabilities: ["code"],
          acceptanceCriteria: [{ id: "done", text: "The task is complete." }],
          acceptanceCriteriaVersion: 1,
          attempt: 1,
          attemptLimit: 1,
          assignedWorkerId: `worker_task-${status}_1`,
          workspacePath: `C:/work/${status}`,
          changeSetId: `change-${status}`,
        }],
      });
      append(store, "user.guidance_submitted", USER, `guidance:${status}:revised`, {
        guidanceId: `guidance-${status}-revised`, text: "Replace this implementation.", version: 1,
      });
      append(store, "user.guidance_acknowledged", ARCHITECT, `guidance:${status}:revised:ack`, {
        guidanceId: `guidance-${status}-revised`,
        expectedVersion: 1,
        resolution: {
          type: "plan_reconciled",
          rationale: "The checkpoint contains stale intent.",
          planReconciliation: {
            revision: 2,
            summary: "Schedule fresh work.",
            taskUpdates: [{ taskId: `task-${status}`, action: "revise", objective: "Implement fresh intent." }],
          },
        },
      });
      const revised = rebuildSchedulerProjection(store.readRun(RUN_ID)).tasks[`task-${status}`];
      assert.equal(revised.status, "planned");
      assert.equal(revised.attempt, 1);
      assert.equal(revised.attemptLimit, 2);
      assert.equal(revised.assignedWorkerId, undefined);
      assert.equal(revised.changeSetId, undefined);
    });
  }
});

test("steering cancellation clears an architect-review checkpoint without erasing its durable audit trail", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-steering-review-cancel-"));
  const database = join(root, "scheduler.sqlite");
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  let store: SqliteSchedulerStore | undefined = new SqliteSchedulerStore(database, { evidenceStore });
  try {
    initialize(store, "Build the requested application.");
    append(store, "plan.created", ARCHITECT, "plan:review-cancel", {
      revision: 1,
      tasks: [{
        id: "task-review-cancel",
        objective: "Implement work that will be cancelled.",
        dependencies: [],
        status: "running",
        requiredCapabilities: ["code"],
        acceptanceCriteria: [{ id: "done", text: "The work is complete." }],
        acceptanceCriteriaVersion: 1,
        attempt: 1,
        assignedWorkerId: "worker_task-review-cancel_1",
        workspacePath: "C:/work/review-cancel",
      }],
    });
    const artifactHash = "d".repeat(64);
    const evidence = evidenceStore.record({
      runId: RUN_ID,
      taskId: "task-review-cancel",
      actor: { role: "worker", id: "worker_task-review-cancel_1" },
      fact: {
        kind: "browser_screenshot",
        label: "cancelled review evidence",
        capturedAt: "2026-08-27T00:00:00.000Z",
        screenshotArtifactHash: artifactHash,
        mediaType: "image/png",
        byteLength: 16,
      },
      createdAt: "2026-08-27T00:00:00.000Z",
      idempotencyKey: "evidence:review-cancel",
      attempt: 1,
    });
    const links = [{
      criterionId: "done",
      evidenceId: evidence.id,
      artifactHashes: [artifactHash],
      taskId: "task-review-cancel",
      attempt: 1,
    }];
    append(store, "task.transitioned", { role: "runner", id: "scheduler" }, "review-cancel:submitted", {
      taskId: "task-review-cancel",
      status: "submitted",
      patch: { changeSetId: "cancelled-change", criterionEvidenceLinks: links },
    });
    append(store, "review.requested", ARCHITECT, "review-cancel:requested", {
      taskId: "task-review-cancel",
      evidenceArtifactHashes: [artifactHash],
      criterionEvidenceLinks: links,
    });
    append(store, "user.guidance_submitted", USER, "review-cancel:guidance", {
      guidanceId: "guidance-review-cancel", text: "Cancel this obsolete work.", version: 1,
    });
    append(store, "user.guidance_acknowledged", ARCHITECT, "review-cancel:guidance:ack", {
      guidanceId: "guidance-review-cancel",
      expectedVersion: 1,
      resolution: {
        type: "plan_reconciled",
        rationale: "The reviewed work is obsolete.",
        planReconciliation: {
          revision: 2,
          summary: "Cancel obsolete reviewed work.",
          taskUpdates: [{ taskId: "task-review-cancel", action: "cancel" }],
        },
      },
    });
    const projection = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.equal(projection.tasks["task-review-cancel"].status, "cancelled");
    assert.equal(projection.tasks["task-review-cancel"].changeSetId, undefined);
    assert.equal(projection.tasks["task-review-cancel"].criterionEvidenceLinks, undefined);
    assert.equal(projection.reviews["task-review-cancel"], undefined);
    assert.equal(projection.submissionHistory?.["task-review-cancel"]?.[0]?.changeSetId, "cancelled-change");
    assert.equal(store.readRun(RUN_ID).filter((event) => event.type === "review.requested").length, 1);
    assert.throws(() => append(store!, "task.transitioned", ARCHITECT, "review-cancel:stale-integrate", {
      taskId: "task-review-cancel", status: "integrating", patch: { changeSetId: "cancelled-change" },
    }), /cannot transition from cancelled to integrating/i);

    store.close();
    store = new SqliteSchedulerStore(database, { evidenceStore });
    const replayed = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.equal(replayed.tasks["task-review-cancel"].status, "cancelled");
    assert.equal(replayed.submissionHistory?.["task-review-cancel"]?.length, 1);
  } finally {
    store?.close();
    evidenceStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan-changing steering supersedes blocking worker guidance before redispatch", () => {
  withStore((store) => {
    initialize(store, "Build the requested application.");
    append(store, "plan.created", ARCHITECT, "plan:waiting-guidance", {
      revision: 1,
      tasks: [{
        id: "task-waiting",
        objective: "Implement old guided work.",
        dependencies: [],
        status: "running",
        requiredCapabilities: ["code"],
        acceptanceCriteria: [{ id: "done", text: "The work is complete." }],
        acceptanceCriteriaVersion: 1,
        attempt: 1,
        assignedWorkerId: "worker_task-waiting_1",
        workspacePath: "C:/work/waiting",
      }],
    });
    append(store, "guidance.requested", { role: "worker", id: "worker_task-waiting_1" }, "worker-guidance:advisory", {
      requestId: "worker-guidance-advisory",
      taskId: "task-waiting",
      blocking: false,
      question: "Is the old implementation's optional label acceptable?",
      evidenceSequence: 1,
    });
    append(store, "guidance.requested", { role: "worker", id: "worker_task-waiting_1" }, "worker-guidance:old", {
      requestId: "worker-guidance-old",
      taskId: "task-waiting",
      blocking: true,
      question: "Should the old implementation use option A?",
      evidenceSequence: 1,
    });
    append(store, "user.guidance_submitted", USER, "waiting:user-guidance", {
      guidanceId: "guidance-waiting", text: "Replace the old implementation with option B.", version: 1,
    });
    append(store, "user.guidance_acknowledged", ARCHITECT, "waiting:user-guidance:ack", {
      guidanceId: "guidance-waiting",
      expectedVersion: 1,
      resolution: {
        type: "plan_reconciled",
        rationale: "The user's new direction supersedes the worker's old question.",
        planReconciliation: {
          revision: 2,
          summary: "Revise the waiting attempt.",
          taskUpdates: [{ taskId: "task-waiting", action: "revise", objective: "Implement option B." }],
        },
      },
    });
    const projection = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.equal(projection.tasks["task-waiting"].status, "assigned");
    assert.equal(projection.tasks["task-waiting"].attempt, 1);
    assert.equal(projection.tasks["task-waiting"].guidanceRequestId, undefined);
    assert.equal(projection.guidance["worker-guidance-old"].status, "answered");
    assert.match(projection.guidance["worker-guidance-old"].answer ?? "", /superseded.*guidance-waiting/i);
    assert.equal(projection.guidance["worker-guidance-advisory"].status, "answered");
    assert.match(projection.guidance["worker-guidance-advisory"].answer ?? "", /superseded.*guidance-waiting/i);
  });
});

test("generic plan reconciliation cannot revise a running task outside steering acknowledgement", () => {
  withStore((store) => {
    initialize(store, "Build the requested application.");
    append(store, "plan.created", ARCHITECT, "plan:running", {
      revision: 1,
      tasks: [{
        id: "task-running",
        objective: "Implement the active task.",
        dependencies: [],
        status: "running",
        requiredCapabilities: ["code"],
        acceptanceCriteria: [{ id: "done", text: "The active task is complete." }],
        acceptanceCriteriaVersion: 1,
        attempt: 1,
        assignedWorkerId: "worker-running",
        workspacePath: "C:/work/running",
      }, {
        id: "task-unfinished-dependency",
        objective: "Implement a future dependency.",
        dependencies: [],
        status: "planned",
        requiredCapabilities: ["code"],
        acceptanceCriteria: [{ id: "done", text: "The future dependency is complete." }],
        acceptanceCriteriaVersion: 1,
        attempt: 0,
      }],
    });
    assert.throws(() => append(store, "plan.reconciled", ARCHITECT, "plan:generic-running", {
      revision: 2,
      summary: "Attempt an unauthorized active revision.",
      taskUpdates: [{ taskId: "task-running", action: "revise", objective: "Changed active objective." }],
    }), /planned, failed, or rejected/i);

    append(store, "user.guidance_submitted", USER, "guidance:active-immutability", {
      guidanceId: "guidance-active-immutability", text: "Revise the active task safely.", version: 1,
    });
    assert.throws(() => append(store, "user.guidance_acknowledged", ARCHITECT, "guidance:active:criteria", {
      guidanceId: "guidance-active-immutability",
      expectedVersion: 1,
      resolution: {
        type: "plan_reconciled",
        rationale: "Attempt to replace active criteria.",
        planReconciliation: {
          revision: 2,
          summary: "Replace active criteria.",
          taskUpdates: [{ taskId: "task-running", action: "revise", acceptanceCriteria: [{ id: "new", text: "New criterion." }] }],
        },
      },
    }), /criteria are immutable/i);
    assert.throws(() => append(store, "user.guidance_acknowledged", ARCHITECT, "guidance:active:dependency", {
      guidanceId: "guidance-active-immutability",
      expectedVersion: 1,
      resolution: {
        type: "plan_reconciled",
        rationale: "Attempt to add an unfinished dependency.",
        planReconciliation: {
          revision: 2,
          summary: "Add an unfinished dependency.",
          taskUpdates: [{ taskId: "task-running", action: "revise", dependencies: ["task-unfinished-dependency"] }],
        },
      },
    }), /cannot add unfinished dependency/i);
    assert.equal(rebuildSchedulerProjection(store.readRun(RUN_ID)).userGuidance["guidance-active-immutability"].status, "submitted");
  });
});

test("P3.1 invalid reconciliation and whitespace-only steering fields roll back atomically", () => {
  withStore((store) => {
    initialize(store, "Build the requested application.");
    seedPlan(store);
    append(store, "user.guidance_submitted", USER, "guidance:one", {
      guidanceId: "guidance-1", text: "Use keyboard navigation.", version: 1,
    });
    const before = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.throws(() => append(store, "user.guidance_acknowledged", ARCHITECT, "guidance:invalid-reconcile", {
      guidanceId: "guidance-1", expectedVersion: 1,
      resolution: {
        type: "plan_reconciled", rationale: "This should fail atomically.",
        planReconciliation: { revision: 3, summary: "Wrong revision.", taskUpdates: [{ taskId: "task-1", action: "revise", objective: "Changed." }] },
      },
    }), /must advance plan revision/i);
    const afterInvalid = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.equal(afterInvalid.userGuidance["guidance-1"].status, "submitted");
    assert.equal(afterInvalid.planRevision, before.planRevision);
    assert.equal(afterInvalid.tasks["task-1"].objective, before.tasks["task-1"].objective);

    const whitespaceCases: Array<[NewSchedulerEvent["type"], NewSchedulerEvent["actor"], Record<string, unknown>]> = [
      ["user.guidance_submitted", USER, { guidanceId: " ", text: "Text", version: 2 }],
      ["user.guidance_submitted", USER, { guidanceId: "guidance-2", text: " \t", version: 2 }],
      ["architect.question_requested", ARCHITECT, { questionId: " ", question: "Question", version: 1 }],
      ["architect.question_requested", ARCHITECT, { questionId: "question-1", question: " \n", version: 1 }],
      ["architect.question_answered", USER, { questionId: "question-1", expectedVersion: 1, answer: " " }],
      ["user.guidance_acknowledged", ARCHITECT, { guidanceId: "guidance-1", expectedVersion: 1, resolution: { type: "no_plan_change", rationale: " ", evidenceIds: ["evidence-1"] } }],
      ["user.guidance_acknowledged", ARCHITECT, { guidanceId: "guidance-1", expectedVersion: 1, resolution: { type: "plan_reconciled", rationale: "Reason", planReconciliation: [] } }],
    ];
    for (const [type, actor, payload] of whitespaceCases) {
      assert.throws(() => append(store, type, actor, `whitespace:${type}:${JSON.stringify(payload)}`, payload), /required|nonblank|unknown/i);
    }
    assert.deepEqual(rebuildSchedulerProjection(store.readRun(RUN_ID)), afterInvalid);
  });
});

test("P3.1 rejects whitespace-only no-plan-change evidence IDs atomically", () => {
  withSubmittedGuidance((store) => {
    const before = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.throws(() => append(store, "user.guidance_acknowledged", ARCHITECT, "guidance:evidence-id-whitespace", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
      resolution: {
        type: "no_plan_change",
        rationale: "The current plan already covers this request.",
        evidenceIds: [" \t"],
      },
    }), /nonblank strings/i);
    assert.deepEqual(rebuildSchedulerProjection(store.readRun(RUN_ID)), before);
  });
});

test("P3.1 rejects unknown nested acknowledgement-resolution fields atomically", () => {
  withSubmittedGuidance((store) => {
    const before = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.throws(() => append(store, "user.guidance_acknowledged", ARCHITECT, "guidance:resolution-unexpected", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
      resolution: {
        type: "no_plan_change",
        rationale: "The current plan already covers this request.",
        evidenceIds: ["evidence-1"],
        unexpected: true,
      },
    }), /unknown user-steering payload field/i);
    assert.deepEqual(rebuildSchedulerProjection(store.readRun(RUN_ID)), before);
  });
});

test("P3.1 Architect questions block in projection and only the user may answer their exact open version", () => {
  withStore((store) => {
    initialize(store, "Build the requested application.");
    append(store, "architect.question_requested", ARCHITECT, "question:one", {
      questionId: "question-1",
      question: "Which payment provider should we use?",
      version: 1,
    });
    const open = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.equal(open.architectQuestions["question-1"].status, "open");
    assert.equal(open.blockingArchitectQuestionId, "question-1");
    assert.equal(open.architectQuestionVersion, 1);

    assert.throws(() => append(store, "architect.question_answered", ARCHITECT, "question:wrong-authority", {
      questionId: "question-1", expectedVersion: 1, answer: "Provider A.",
    }), /only the user/i);
    assert.throws(() => append(store, "architect.question_answered", USER, "question:stale", {
      questionId: "question-1", expectedVersion: 2, answer: "Provider A.",
    }), /version is 1, not 2/i);
    append(store, "architect.question_answered", USER, "question:answer", {
      questionId: "question-1", expectedVersion: 1, answer: "Provider A.",
    });
    assert.throws(() => append(store, "architect.question_answered", USER, "question:duplicate", {
      questionId: "question-1", expectedVersion: 1, answer: "Provider A.",
    }), /not open/i);
    assert.throws(() => append(store, "architect.question_answered", USER, "question:conflict", {
      questionId: "question-1", expectedVersion: 1, answer: "Provider B.",
    }), /not open/i);
    const answered = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.equal(answered.architectQuestions["question-1"].status, "answered");
    assert.equal(answered.architectQuestions["question-1"].answer, "Provider A.");
    assert.equal(answered.blockingArchitectQuestionId, undefined);
    append(store, "architect.question_requested", ARCHITECT, "question:two", {
      questionId: "question-2",
      question: "Which region should be the initial default?",
      version: 2,
    });
  });
});

test("P3.1 rejects malformed and authority-bypass steering events atomically", () => {
  withStore((store) => {
    initialize(store, "Immutable objective.");
    const before = store.readRun(RUN_ID).length;
    assert.throws(() => append(store, "user.guidance_submitted", ARCHITECT, "guidance:bad-authority", {
      guidanceId: "guidance-1", text: "A user note.", version: 1,
    }), /only the user/i);
    assert.throws(() => append(store, "user.guidance_submitted", USER, "guidance:malformed", {
      guidanceId: "guidance-1", text: "A user note.", version: 2, objective: "replacement",
    }), /version must advance|unknown/i);
    assert.throws(() => append(store, "architect.question_requested", USER, "question:bad-authority", {
      questionId: "question-1", question: "Bad", version: 1,
    }), /only the architect/i);
    assert.equal(store.readRun(RUN_ID).length, before);
    const projection = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.equal(projection.initialObjective, "Immutable objective.");
    assert.deepEqual(projection.userGuidance, {});
    assert.deepEqual(projection.architectQuestions, {});
  });
});

function initialize(store: SqliteSchedulerStore, objective: string): void {
  append(store, "run.initialized", { role: "runner", id: "runner" }, "initialized", { objective });
}

function seedPlan(store: SqliteSchedulerStore): void {
  append(store, "plan.created", ARCHITECT, "plan:1", {
    revision: 1,
    tasks: [{
      id: "task-1",
      objective: "Implement the dashboard.",
      dependencies: [],
      status: "planned",
      requiredCapabilities: ["code"],
      acceptanceCriteria: [{ id: "done", text: "Dashboard is implemented." }],
      acceptanceCriteriaVersion: 1,
      attempt: 0,
    }],
  });
}

function withSubmittedGuidance(run: (store: SqliteSchedulerStore) => void): void {
  withStore((store) => {
    initialize(store, "Build the requested application.");
    append(store, "user.guidance_submitted", USER, "guidance:one", {
      guidanceId: "guidance-1", text: "Use keyboard navigation.", version: 1,
    });
    run(store);
  });
}

function append(
  store: SqliteSchedulerStore,
  type: NewSchedulerEvent["type"],
  actor: NewSchedulerEvent["actor"],
  idempotencyKey: string,
  payload: Record<string, unknown>,
) {
  return store.append({
    runId: RUN_ID,
    type,
    occurredAt: "2026-08-27T00:00:00.000Z",
    actor,
    idempotencyKey,
    payload,
  });
}

function withStore(run: (store: SqliteSchedulerStore, database: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "aiboard-user-steering-"));
  const database = join(root, "scheduler.sqlite");
  let store: SqliteSchedulerStore | undefined;
  try {
    store = new SqliteSchedulerStore(database);
    run(store, database);
  } finally {
    if (store) {
      try { store.close(); } catch { /* test may intentionally close it */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
}
