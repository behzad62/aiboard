import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { FinalVerificationPlan } from "../src/final-verification-runtime.js";
import {
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
} from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { readyTaskIds, validateTaskGraph } from "../src/task-graph.js";
import { TaskScheduler } from "../src/task-scheduler.js";

const REVISION_ONE = "integration revision one";
const REVISION_TWO = "integration revision two";
const GENERATION_ONE = "verification-generation-one";
const PLAN = finalVerificationPlan();

test("final verification is a distinct kernel task and is never auto-run", async () => {
  const fixture = createFixture();
  try {
    const projection = fixture.projection;
    const task = projection.tasks[fixture.taskId];
    assert.ok(task);
    assert.equal(task.kind, "final_verification");
    assert.equal(task.generationId, GENERATION_ONE);
    assert.equal(task.targetRevision, REVISION_ONE);
    assert.equal(task.planVersion, 1);
    assert.deepEqual(task.verificationPlan, PLAN);
    assert.equal(task.changeSetId, undefined);
    assert.deepEqual(readyTaskIds(Object.values(projection.tasks)), []);
    assert.equal(validateTaskGraph(Object.values(projection.tasks)).valid, true);

    let driverCalls = 0;
    let workspaceCalls = 0;
    const scheduler = new TaskScheduler({
      runId: fixture.runId,
      store: fixture.store,
      driver: { run: async () => { driverCalls += 1; return { type: "failed", reason: "must not run" }; } },
      maxConcurrency: 1,
      workspaceFor: async () => { workspaceCalls += 1; return "never"; },
    });
    await scheduler.tick();
    await scheduler.awaitIdle();
    assert.equal(driverCalls, 0);
    assert.equal(workspaceCalls, 0);
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("same final verification generation is idempotent and conflicting current generations reject", () => {
  const fixture = createFixture();
  try {
    const duplicate = fixture.store.append(generationEvent({
      idempotencyKey: "verification:generation:one",
    }));
    assert.equal(duplicate.eventId, fixture.generationEvent.eventId);
    assert.equal(
      rebuildSchedulerProjection(fixture.store.readRun(fixture.runId)).finalVerification?.history.length,
      0,
    );

    assert.throws(
      () => fixture.store.append(generationEvent({
        idempotencyKey: "verification:generation:conflict",
        generationId: "different-generation",
      })),
      /current.*generation|already|conflict/i,
    );
    assert.throws(
      () => fixture.store.append(generationEvent({
        idempotencyKey: "verification:generation:target-conflict",
        targetRevision: REVISION_TWO,
      })),
      /current.*revision|stale|conflict/i,
    );
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("submission and review references must stay bound to the current generation", () => {
  const fixture = createFixture();
  try {
    fixture.store.append(event(fixture.runId, "final_verification.submitted", "verification:submission:one", {
      taskId: fixture.taskId,
      generationId: GENERATION_ONE,
      targetRevision: REVISION_ONE,
      attempt: 1,
      submissionId: "submission-one",
    }));
    fixture.store.append(event(fixture.runId, "final_verification.review_requested", "verification:review:request", {
      taskId: fixture.taskId,
      generationId: GENERATION_ONE,
      targetRevision: REVISION_ONE,
      attempt: 1,
      submissionId: "submission-one",
      reviewId: "review-one",
    }));
    fixture.store.append(event(fixture.runId, "final_verification.review_decided", "verification:review:decision", {
      taskId: fixture.taskId,
      generationId: GENERATION_ONE,
      targetRevision: REVISION_ONE,
      attempt: 1,
      submissionId: "submission-one",
      reviewId: "review-one",
      decision: "approved",
    }));
    const current = rebuildSchedulerProjection(fixture.store.readRun(fixture.runId)).finalVerification?.current;
    assert.ok(current);
    assert.deepEqual(current.submission, {
      submissionId: "submission-one",
      generationId: GENERATION_ONE,
      targetRevision: REVISION_ONE,
      attempt: 1,
    });
    assert.deepEqual(current.review, {
      reviewId: "review-one",
      submissionId: "submission-one",
      generationId: GENERATION_ONE,
      targetRevision: REVISION_ONE,
      attempt: 1,
      status: "approved",
    });

    assert.throws(
      () => fixture.store.append(event(fixture.runId, "final_verification.review_decided", "verification:review:foreign", {
        taskId: fixture.taskId,
        generationId: "stale-generation",
        targetRevision: REVISION_ONE,
        attempt: 1,
        submissionId: "submission-one",
        reviewId: "review-one",
        decision: "approved",
      })),
      /current|stale|generation/i,
    );
    assert.throws(
      () => fixture.store.append(event(fixture.runId, "final_verification.review_requested", "verification:review:wrong-submission", {
        taskId: fixture.taskId,
        generationId: GENERATION_ONE,
        targetRevision: REVISION_ONE,
        attempt: 1,
        submissionId: "foreign-submission",
        reviewId: "review-two",
      })),
      /submission|generation|current/i,
    );
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("integration revision advancement invalidates current verification and survives replay", () => {
  const fixture = createFixture();
  const database = join(fixture.root, "scheduler.sqlite");
  try {
    fixture.store.append(event(fixture.runId, "final_verification.submitted", "verification:submission:history", {
      taskId: fixture.taskId,
      generationId: GENERATION_ONE,
      targetRevision: REVISION_ONE,
      attempt: 1,
      submissionId: "submission-history",
    }));
    fixture.store.append(event(fixture.runId, "final_verification.review_requested", "verification:review:history", {
      taskId: fixture.taskId,
      generationId: GENERATION_ONE,
      targetRevision: REVISION_ONE,
      attempt: 1,
      submissionId: "submission-history",
      reviewId: "review-history",
    }));
    fixture.store.append(event(fixture.runId, "final_verification.review_decided", "verification:review:history-decision", {
      taskId: fixture.taskId,
      generationId: GENERATION_ONE,
      targetRevision: REVISION_ONE,
      attempt: 1,
      submissionId: "submission-history",
      reviewId: "review-history",
      decision: "approved",
    }));
    fixture.store.append(event(fixture.runId, "integration.revision_advanced", "integration:revision:two", {
      integrationRevision: REVISION_TWO,
      previousIntegrationRevision: REVISION_ONE,
    }));

    const stale = rebuildSchedulerProjection(fixture.store.readRun(fixture.runId));
    assert.equal(stale.integrationRevision, REVISION_TWO);
    assert.equal(stale.finalVerification?.current, undefined);
    assert.equal(stale.finalVerification?.history.length, 1);
    assert.deepEqual(stale.finalVerification?.history[0], {
      taskId: fixture.taskId,
      generationId: GENERATION_ONE,
      targetRevision: REVISION_ONE,
      planVersion: 1,
      plan: PLAN,
      state: "invalidated",
      invalidatedByRevision: REVISION_TWO,
      submission: {
        submissionId: "submission-history",
        generationId: GENERATION_ONE,
        targetRevision: REVISION_ONE,
        attempt: 1,
      },
      review: {
        reviewId: "review-history",
        submissionId: "submission-history",
        generationId: GENERATION_ONE,
        targetRevision: REVISION_ONE,
        attempt: 1,
        status: "approved",
      },
    });
    assert.throws(
      () => fixture.store.append(event(fixture.runId, "final_verification.submitted", "verification:submission:stale", {
        taskId: fixture.taskId,
        generationId: GENERATION_ONE,
        targetRevision: REVISION_ONE,
        attempt: 1,
        submissionId: "stale-submission",
      })),
      /current|stale|generation/i,
    );
    assert.throws(
      () => fixture.store.append(generationEvent({
        idempotencyKey: "verification:generation:stale-replay",
      })),
      /stale|history|invalidated|revision/i,
    );

    fixture.store.close();
    const reopened = new SqliteSchedulerStore(database);
    try {
      assert.deepEqual(
        rebuildSchedulerProjection(reopened.readRun(fixture.runId)),
        stale,
      );
      reopened.append(event(fixture.runId, "final_verification.generation_created", "verification:generation:two", {
        taskId: "final-verification-two",
        generationId: "verification-generation-two",
        targetRevision: REVISION_TWO,
        planVersion: 2,
        plan: PLAN,
      }));
      const current = rebuildSchedulerProjection(reopened.readRun(fixture.runId)).finalVerification?.current;
      assert.equal(current?.generationId, "verification-generation-two");
      assert.equal(current?.targetRevision, REVISION_TWO);
      assert.equal(current?.state, "current");
    } finally {
      reopened.close();
    }
  } finally {
    try { fixture.store.close(); } catch { /* already closed for reopen */ }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

interface Fixture {
  root: string;
  store: SqliteSchedulerStore;
  runId: string;
  taskId: string;
  generationEvent: ReturnType<SqliteSchedulerStore["append"]>;
  projection: ReturnType<typeof rebuildSchedulerProjection>;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 final verification scheduler "));
  const runId = "run-final-verification";
  const taskId = "final-verification-one";
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  store.append(event(runId, "run.initialized", "run:initialized", {}));
  store.append(event(runId, "plan.created", "plan:created", {
    revision: 1,
    tasks: [{
      id: "implementation-one",
      objective: "Implement the feature",
      dependencies: [],
      status: "integrated",
      requiredCapabilities: ["code"],
      attempt: 0,
    }],
  }));
  store.append(event(runId, "integration.revision_advanced", "integration:revision:one", {
    integrationRevision: REVISION_ONE,
  }));
  const generationEvent = store.append(generationEventFor(runId, {
    taskId,
    generationId: GENERATION_ONE,
    targetRevision: REVISION_ONE,
    planVersion: 1,
    plan: PLAN,
  }));
  const projection = rebuildSchedulerProjection(store.readRun(runId));
  return { root, store, runId, taskId, generationEvent, projection };
}

function generationEvent(overrides: Partial<{
  taskId: string;
  generationId: string;
  targetRevision: string;
  planVersion: number;
  plan: FinalVerificationPlan;
  idempotencyKey: string;
}> = {}): NewSchedulerEvent {
  return generationEventFor("run-final-verification", {
    taskId: overrides.taskId ?? "final-verification-one",
    generationId: overrides.generationId ?? GENERATION_ONE,
    targetRevision: overrides.targetRevision ?? REVISION_ONE,
    planVersion: overrides.planVersion ?? 1,
    plan: overrides.plan ?? PLAN,
    idempotencyKey: overrides.idempotencyKey,
  });
}

function generationEventFor(
  runId: string,
  input: {
    taskId: string;
    generationId: string;
    targetRevision: string;
    planVersion: number;
    plan: FinalVerificationPlan;
    idempotencyKey?: string;
  },
): NewSchedulerEvent {
  return event(
    runId,
    "final_verification.generation_created",
    input.idempotencyKey ?? `verification:generation:${input.generationId}`,
    {
      taskId: input.taskId,
      generationId: input.generationId,
      targetRevision: input.targetRevision,
      planVersion: input.planVersion,
      plan: input.plan,
    },
  );
}

function finalVerificationPlan(): FinalVerificationPlan {
  return {
    checks: ["build", "tests", "runtime_smoke", "browser"].map((category) => ({
      category: category as "build" | "tests" | "runtime_smoke" | "browser",
      status: "not_applicable" as const,
      rationale: `No ${category} fixture is configured.`,
      repositoryInspection: {
        paths: ["package.json"],
        summary: `No ${category} fixture is configured.`,
      },
    })),
  };
}

function event(
  runId: string,
  type: NewSchedulerEvent["type"],
  idempotencyKey: string,
  payload: Record<string, unknown>,
): NewSchedulerEvent {
  return {
    runId,
    type,
    occurredAt: "2026-08-26T00:00:00.000Z",
    actor: type === "final_verification.review_decided"
      ? { role: "architect", id: "architect-test" }
      : type.startsWith("final_verification") || type.startsWith("integration.")
        ? { role: "runner", id: "runner-test" }
      : type === "plan.created"
        ? { role: "architect", id: "architect-test" }
        : { role: "runner", id: "runner-test" },
    idempotencyKey,
    payload,
  };
}
