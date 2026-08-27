import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { rebuildSchedulerProjection, type NewSchedulerEvent } from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";

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
    append(store, "user.guidance_submitted", USER, "guidance:running", {
      guidanceId: "guidance-running", text: "Revise one active task and cancel the other.", version: 1,
    });

    append(store, "user.guidance_acknowledged", ARCHITECT, "guidance:running:ack", {
      guidanceId: "guidance-running",
      expectedVersion: 1,
      resolution: {
        type: "plan_reconciled",
        rationale: "The interrupted work must follow the revised direction.",
        planReconciliation: {
          revision: 2,
          summary: "Revise and cancel interrupted work.",
          taskUpdates: [
            { taskId: "task-revise", action: "revise", objective: "Implement the revised active task.", requiredCapabilities: ["code", "browser"] },
            { taskId: "task-cancel", action: "cancel" },
          ],
        },
      },
    });

    const projection = rebuildSchedulerProjection(store.readRun(RUN_ID));
    const revised = projection.tasks["task-revise"];
    assert.equal(revised.status, "running");
    assert.equal(revised.attempt, 2);
    assert.equal(revised.objective, "Implement the revised active task.");
    assert.equal(revised.workspacePath, "C:/work/revise");
    assert.equal(revised.assignedWorkerId, undefined);
    assert.equal(revised.changeSetId, undefined);
    assert.equal(revised.criterionEvidenceLinks, undefined);
    assert.equal(revised.failureReason, undefined);
    assert.equal(projection.runtime.workerAssignments["task-revise:2"], undefined);
    assert.equal(projection.tasks["task-cancel"].status, "cancelled");
    assert.equal(projection.tasks["task-cancel"].attempt, 2);
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
