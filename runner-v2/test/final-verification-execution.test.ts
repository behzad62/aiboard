import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BuildRuntime,
  type FinalVerificationCheckDriver,
  type FinalVerificationCleanupDriver,
} from "../src/build-runtime.js";
import type {
  FinalVerificationCategory,
  FinalVerificationPlan,
} from "../src/final-verification-contracts.js";
import { rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";

const RUN_ID = "run-final-verification-execution";
const REVISION_ONE = "a".repeat(40);
const REVISION_TWO = "b".repeat(40);
const TASK_ID = "final-verification-a";
const GENERATION_ID = "final-verification-generation-a";

test("restart reuses completed checks and executes only pending categories before one submission", async () => {
  const fixture = createFixture();
  const calls: FinalVerificationCategory[] = [];
  let workerCalls = 0;
  const driver = checkDriver(calls);
  const cleanupCalls: string[] = [];
  const cleanupDriver: FinalVerificationCleanupDriver = {
    cleanup: async (input) => { cleanupCalls.push(input.generationId); return {}; },
  };
  try {
    let runtime = buildRuntime(fixture.store, fixture.evidence, driver, () => {
      workerCalls += 1;
    }, cleanupDriver);
    assert.deepEqual(await runtime.step(), {
      status: "progressed",
      action: "final_verification_check_completed",
    });
    assert.deepEqual(calls, ["build"]);
    assert.deepEqual(
      runtime.projection().finalVerification?.current?.completedChecks?.map((entry) => entry.category),
      ["build"],
    );

    fixture.store.close();
    fixture.store = new SqliteSchedulerStore(fixture.database, {
      evidenceStore: fixture.evidence,
    });
    runtime = buildRuntime(fixture.store, fixture.evidence, driver, () => {
      workerCalls += 1;
    }, cleanupDriver);
    await runtime.step();
    await runtime.step();
    await runtime.step();
    assert.deepEqual(calls, ["build", "tests", "runtime_smoke", "browser"]);

    const submitted = await runtime.step();
    assert.deepEqual(submitted, {
      status: "progressed",
      action: "final_verification_submitted",
    });
    const projection = runtime.projection();
    assert.equal(projection.finalVerification?.current?.submission?.submissionId,
      `final-verification-submission:${GENERATION_ID}`);
    assert.equal(projection.finalVerification?.current?.submissionResult?.green, true);
    assert.equal(
      fixture.store.readRun(RUN_ID)
        .filter((event) => event.type === "final_verification.check_completed").length,
      4,
    );
    assert.equal(
      fixture.store.readRun(RUN_ID)
        .filter((event) => event.type === "final_verification.submitted").length,
      1,
    );

    assert.deepEqual(await runtime.step(), {
      status: "progressed",
      action: "final_verification_cleanup_succeeded",
    });
    assert.deepEqual(cleanupCalls, [GENERATION_ID]);
    assert.equal(runtime.projection().finalVerification?.current?.cleanup?.status, "succeeded");
    await assert.rejects(
      () => runtime.step(),
      /final_verification_review_required.*typed action/i,
    );
    assert.equal(
      runtime.projection().finalVerification?.current?.review?.status,
      "requested",
    );
    assert.deepEqual(calls, ["build", "tests", "runtime_smoke", "browser"]);
    assert.equal(workerCalls, 0);
    assert.equal(
      fixture.store.readRun(RUN_ID)
        .filter((event) => event.type === "final_verification.submitted").length,
      1,
    );
  } finally {
    fixture.store.close();
    fixture.evidence.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a non-green check is persisted once and stops the generation before submission", async () => {
  const fixture = createFixture();
  const calls: FinalVerificationCategory[] = [];
  const driver = checkDriver(calls, "build");
  try {
    const runtime = buildRuntime(fixture.store, fixture.evidence, driver);
    assert.equal((await runtime.step()).action, "final_verification_check_non_green");
    const current = runtime.projection().finalVerification?.current;
    assert.equal(current?.completedChecks?.length, 1);
    assert.equal(current?.completedChecks?.[0].green, false);
    assert.equal((await runtime.step()).action, "final_verification_non_green");
    assert.deepEqual(calls, ["build"]);
    assert.equal(current?.submission, undefined);
  } finally {
    fixture.store.close();
    fixture.evidence.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("durable cleanup failure blocks review and restart retries the exact generation", async () => {
  const fixture = createFixture();
  const categories: FinalVerificationCategory[] = [];
  let cleanupCalls = 0;
  const cleanupDriver: FinalVerificationCleanupDriver = {
    cleanup: async () => {
      cleanupCalls += 1;
      if (cleanupCalls === 1) throw new Error("cleanup token=secret-value failed");
      return {};
    },
  };
  try {
    let runtime = buildRuntime(fixture.store, fixture.evidence, checkDriver(categories), undefined, cleanupDriver);
    for (let index = 0; index < 5; index += 1) await runtime.step();
    assert.equal((await runtime.step()).action, "final_verification_cleanup_failed");
    let current = runtime.projection().finalVerification?.current;
    assert.equal(current?.cleanup?.status, "failed");
    assert.match(current?.cleanup?.error ?? "", /token=\[REDACTED\]/);
    assert.equal(current?.review, undefined);

    fixture.store.close();
    fixture.store = new SqliteSchedulerStore(fixture.database, { evidenceStore: fixture.evidence });
    runtime = buildRuntime(fixture.store, fixture.evidence, checkDriver(categories), undefined, cleanupDriver);
    assert.equal((await runtime.step()).action, "final_verification_cleanup_succeeded");
    current = runtime.projection().finalVerification?.current;
    assert.equal(current?.cleanup?.status, "succeeded");
    assert.equal(current?.cleanup?.attempt, 2);
    assert.equal(current?.review, undefined);
    assert.equal(cleanupCalls, 2);
  } finally {
    fixture.store.close(); fixture.evidence.close(); rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("integration advancement during a check invalidates the generation and forbids stale persistence", async () => {
  const fixture = createFixture();
  const calls: FinalVerificationCategory[] = [];
  const driver: FinalVerificationCheckDriver = {
    executeCheck: async (input) => {
      calls.push(input.category);
      fixture.store.append({
        runId: RUN_ID,
        type: "integration.revision_advanced",
        occurredAt: "2026-08-26T00:00:10.000Z",
        actor: { role: "runner", id: "integration-manager" },
        idempotencyKey: "integration:revision:two",
        payload: {
          integrationRevision: REVISION_TWO,
          previousIntegrationRevision: REVISION_ONE,
        },
      });
      return completedCheck(input.category);
    },
  };
  try {
    const runtime = buildRuntime(fixture.store, fixture.evidence, driver);
    assert.equal((await runtime.step()).action, "final_verification_invalidated");
    const projection = runtime.projection();
    assert.equal(projection.integrationRevision, REVISION_TWO);
    assert.equal(projection.finalVerification?.current, undefined);
    assert.equal(projection.finalVerification?.history.length, 1);
    assert.deepEqual(calls, ["build"]);
    assert.equal(
      fixture.store.readRun(RUN_ID)
        .some((event) => event.type === "final_verification.check_completed"),
      false,
    );
    assert.equal(
      fixture.store.readRun(RUN_ID)
        .some((event) => event.type === "final_verification.submitted"),
      false,
    );
  } finally {
    fixture.store.close();
    fixture.evidence.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function buildRuntime(
  store: SqliteSchedulerStore,
  evidenceStore: SqliteEvidenceStore,
  finalVerificationDriver: FinalVerificationCheckDriver,
  onWorker = () => undefined,
  finalVerificationCleanupDriver?: FinalVerificationCleanupDriver,
) {
  return new BuildRuntime({
    runId: RUN_ID,
    store,
    evidenceStore,
    finalVerificationDriver,
    finalVerificationCleanupDriver,
    workerDriver: {
      run: async () => {
        onWorker();
        return { type: "failed" as const, reason: "final verification must not use workers" };
      },
    },
    architectDriver: { run: async () => undefined },
    integrationDriver: {
      integrate: async () => ({ status: "integrated" as const, integrationRevision: REVISION_ONE }),
    },
    maxConcurrency: 1,
    workspaceFor: async () => "C:/never",
  });
}

function checkDriver(
  calls: FinalVerificationCategory[],
  nonGreen?: FinalVerificationCategory,
): FinalVerificationCheckDriver {
  return {
    executeCheck: async (input) => {
      calls.push(input.category);
      assert.equal(input.generationId, GENERATION_ID);
      assert.equal(input.taskId, TASK_ID);
      assert.equal(input.targetRevision, REVISION_ONE);
      assert.equal(input.attempt, 1);
      return completedCheck(input.category, input.category !== nonGreen);
    },
  };
}

function completedCheck(category: FinalVerificationCategory, green = true) {
  const planned = finalVerificationPlan().checks.find((check) => check.category === category)!;
  return {
    workspacePath: "C:/verification-workspace",
    startedAt: "2026-08-26T00:00:03.000Z",
    finishedAt: "2026-08-26T00:00:04.000Z",
    check: {
      ...planned,
      green,
      evidenceIds: [],
      facts: [],
      issues: green ? [] : [`${category} failed mechanically.`],
    },
  };
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 final verification execution "));
  const database = join(root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(database, { evidenceStore: evidence });
  store.append({
    runId: RUN_ID,
    type: "run.initialized",
    occurredAt: "2026-08-26T00:00:00.000Z",
    actor: { role: "runner", id: "runner-test" },
    idempotencyKey: "run-initialized",
    payload: {},
  });
  store.append({
    runId: RUN_ID,
    type: "plan.created",
    occurredAt: "2026-08-26T00:00:01.000Z",
    actor: { role: "architect", id: "architect-test" },
    idempotencyKey: "plan:one",
    payload: {
      revision: 1,
      tasks: [{
        id: "implementation-one",
        objective: "Implement the feature",
        dependencies: [],
        status: "integrated",
        requiredCapabilities: ["code"],
        acceptanceCriteria: [{ id: "implemented", text: "The feature is implemented." }],
        acceptanceCriteriaVersion: 1,
        attempt: 1,
      }],
    },
  });
  store.append({
    runId: RUN_ID,
    type: "integration.revision_advanced",
    occurredAt: "2026-08-26T00:00:02.000Z",
    actor: { role: "runner", id: "integration-manager" },
    idempotencyKey: "integration:revision:one",
    payload: { integrationRevision: REVISION_ONE },
  });
  store.append({
    runId: RUN_ID,
    type: "final_verification.generation_created",
    occurredAt: "2026-08-26T00:00:03.000Z",
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: "final-verification-plan:one",
    payload: {
      taskId: TASK_ID,
      generationId: GENERATION_ID,
      targetRevision: REVISION_ONE,
      planVersion: 1,
      plan: finalVerificationPlan(),
    },
  });
  return {
    root,
    database,
    evidence,
    store,
    projection: () => rebuildSchedulerProjection(store.readRun(RUN_ID)),
  };
}

function finalVerificationPlan(): FinalVerificationPlan {
  return {
    checks: ["build", "tests", "runtime_smoke", "browser"].map((category) => ({
      category: category as FinalVerificationCategory,
      status: "not_applicable" as const,
      rationale: `No ${category} fixture is configured.`,
      repositoryInspection: {
        paths: ["package.json"],
        summary: `No ${category} fixture is configured.`,
      },
    })),
  };
}
