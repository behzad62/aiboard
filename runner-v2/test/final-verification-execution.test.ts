import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BuildRuntime,
  type FinalVerificationCheckDriver,
  type FinalVerificationCheckExecution,
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
    assert.equal((await runtime.step()).action, "final_verification_failure_reported");
    assert.deepEqual(calls, ["build"]);
    assert.equal(current?.submission, undefined);
    assert.equal(runtime.projection().finalVerification?.current?.failure?.failedCategories[0], "build");
  } finally {
    fixture.store.close();
    fixture.evidence.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a persisted mechanical failure is cleaned, typed into repair work, and survives restart exactly once", async () => {
  const fixture = createFixture();
  const calls: FinalVerificationCategory[] = [];
  const cleanupFailures: unknown[] = [];
  let architectCalls = 0;
  let workerCalls = 0;
  const runtimeFor = () => new BuildRuntime({
    runId: RUN_ID,
    store: fixture.store,
    evidenceStore: fixture.evidence,
    finalVerificationDriver: actualNonZeroTestDriver(calls),
    finalVerificationCleanupDriver: {
      cleanup: async (input) => {
        cleanupFailures.push(input.failed);
        return { diagnosticsPath: "C:/runner-state/diagnostics/failure.json" };
      },
    },
    workerDriver: {
      run: async () => {
        workerCalls += 1;
        return { type: "failed" as const, reason: "worker eligibility proved" };
      },
    },
    architectDriver: {
      run: async (request) => {
        architectCalls += 1;
        assert.equal(request.reason.type, "final_verification_repair_plan_required");
        if (request.reason.type !== "final_verification_repair_plan_required") return;
        assert.equal(request.reason.source.type, "mechanical_failure");
        assert.deepEqual(request.reason.failedCategories, ["tests"]);
        const result = await request.tools.invoke({
          type: "tool_call",
          callId: "plan-mechanical-repair",
          name: "plan_verification_repairs",
          arguments: {
            finalVerificationTaskId: TASK_ID,
            generationId: GENERATION_ID,
            targetRevision: REVISION_ONE,
            source: request.reason.source,
            tasks: [{
              id: "repair-tests-mechanical",
              objective: "Repair the mechanically failing test command.",
              categories: ["tests"],
              evidenceIds: request.reason.evidenceIds,
              dependencies: ["implementation-one"],
              requiredCapabilities: ["code"],
              acceptanceCriteria: [{
                id: "tests-green",
                text: "The exact failing test command exits successfully in final verification.",
              }],
            }],
          },
        }, request.context);
        assert.equal(result.isError, false, result.error?.message ?? "repair planning failed");
      },
    },
    integrationDriver: {
      integrate: async () => ({ status: "integrated" as const, integrationRevision: REVISION_ONE }),
    },
    maxConcurrency: 1,
    workspaceFor: async () => "C:/repair-workspace",
  });
  try {
    let runtime = runtimeFor();
    assert.equal((await runtime.step()).action, "final_verification_check_completed");
    assert.equal((await runtime.step()).action, "final_verification_check_non_green");
    assert.equal((await runtime.step()).action, "final_verification_failure_reported");
    const failure = runtime.projection().finalVerification?.current?.failure;
    assert.equal(failure?.failedCategories[0], "tests");
    assert.equal(failure?.attempt, 1);
    assert.equal(failure?.issueIds.length, 1);
    assert.equal(runtime.projection().finalVerification?.current?.submission, undefined);

    fixture.store.close();
    fixture.store = new SqliteSchedulerStore(fixture.database, { evidenceStore: fixture.evidence });
    runtime = runtimeFor();
    assert.equal((await runtime.step()).action, "final_verification_cleanup_succeeded");
    assert.equal(cleanupFailures.length, 1);
    assert.deepEqual(
      (cleanupFailures[0] as { checks: Array<{ category: string; green: boolean }> }).checks
        .map((check) => [check.category, check.green]),
      [["build", true], ["tests", false]],
    );
    assert.equal(runtime.projection().finalVerification?.current?.cleanup?.diagnosticsPath,
      "C:/runner-state/diagnostics/failure.json");

    fixture.store.close();
    fixture.store = new SqliteSchedulerStore(fixture.database, { evidenceStore: fixture.evidence });
    runtime = runtimeFor();
    assert.equal((await runtime.step()).action, "final_verification_repair_plan_required");
    const repair = runtime.projection().tasks["repair-tests-mechanical"];
    assert.equal(repair?.kind, "verification_repair");
    assert.equal(repair?.verificationRepair?.source.type, "mechanical_failure");
    assert.equal(repair?.verificationRepair?.source.failureId, failure?.failureId);
    assert.equal(architectCalls, 1);
    assert.equal(
      fixture.store.readRun(RUN_ID).filter((event) => event.type === "final_verification.failure_reported").length,
      1,
    );
    assert.equal(
      fixture.store.readRun(RUN_ID).filter((event) => event.type === "final_verification.repairs_planned").length,
      1,
    );
    await runtime.step();
    assert.equal(workerCalls, 1);
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

test("mechanical cleanup failure retries after restart without duplicating the failure report", async () => {
  const fixture = createFixture();
  let cleanupCalls = 0;
  const cleanupDriver: FinalVerificationCleanupDriver = {
    cleanup: async (input) => {
      cleanupCalls += 1;
      assert.equal(input.failed?.checks.length, 1);
      if (cleanupCalls === 1) throw new Error("diagnostic archive unavailable token=secret");
      return { diagnosticsPath: "C:/diagnostics/mechanical.json" };
    },
  };
  try {
    let runtime = buildRuntime(
      fixture.store, fixture.evidence, checkDriver([], "build"), undefined, cleanupDriver,
    );
    await runtime.step();
    await runtime.step();
    assert.equal((await runtime.step()).action, "final_verification_cleanup_failed");
    assert.match(runtime.projection().finalVerification?.current?.cleanup?.error ?? "", /token=\[REDACTED\]/);

    fixture.store.close();
    fixture.store = new SqliteSchedulerStore(fixture.database, { evidenceStore: fixture.evidence });
    runtime = buildRuntime(
      fixture.store, fixture.evidence, checkDriver([], "build"), undefined, cleanupDriver,
    );
    assert.equal((await runtime.step()).action, "final_verification_cleanup_succeeded");
    assert.equal(cleanupCalls, 2);
    assert.equal(
      fixture.store.readRun(RUN_ID).filter((event) => event.type === "final_verification.failure_reported").length,
      1,
    );
    assert.equal(runtime.projection().finalVerification?.current?.cleanup?.attempt, 2);
  } finally {
    fixture.store.close(); fixture.evidence.close(); rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("forged or stale failure reports and raw review approval cannot bypass mechanical failure", async () => {
  const fixture = createFixture();
  try {
    const runtime = buildRuntime(fixture.store, fixture.evidence, checkDriver([], "build"));
    await runtime.step();
    await runtime.step();
    const failure = runtime.projection().finalVerification?.current?.failure;
    assert.ok(failure);
    assert.throws(() => fixture.store.append({
      runId: RUN_ID,
      type: "final_verification.failure_reported",
      occurredAt: "2026-08-26T00:10:00.000Z",
      actor: { role: "runner", id: "forger" },
      idempotencyKey: "forged-failure",
      payload: { ...failure, issueIds: ["issue:forged"] },
    }), /conflicts with persisted mechanical facts/i);
    assert.throws(() => fixture.store.append({
      runId: RUN_ID,
      type: "final_verification.review_decided",
      occurredAt: "2026-08-26T00:10:01.000Z",
      actor: { role: "architect", id: "architect" },
      idempotencyKey: "raw-approval-bypass",
      payload: {
        taskId: TASK_ID,
        generationId: GENERATION_ID,
        targetRevision: REVISION_ONE,
        submissionId: "forged-submission",
        reviewId: "forged-review",
        attempt: 1,
        decision: "approved",
      },
    }), /submission|review|current/i);
    fixture.store.append({
      runId: RUN_ID,
      type: "final_verification.cleanup_started",
      occurredAt: "2026-08-26T00:10:01.500Z",
      actor: { role: "runner", id: "runtime" },
      idempotencyKey: "failed-cleanup-start",
      payload: { taskId: TASK_ID, generationId: GENERATION_ID, targetRevision: REVISION_ONE, attempt: 1 },
    });
    assert.throws(() => fixture.store.append({
      runId: RUN_ID,
      type: "final_verification.cleanup_succeeded",
      occurredAt: "2026-08-26T00:10:01.600Z",
      actor: { role: "runner", id: "runtime" },
      idempotencyKey: "failed-cleanup-without-diagnostics",
      payload: { taskId: TASK_ID, generationId: GENERATION_ID, targetRevision: REVISION_ONE, attempt: 1 },
    }), /diagnostic/i);
    fixture.store.append({
      runId: RUN_ID,
      type: "integration.revision_advanced",
      occurredAt: "2026-08-26T00:10:02.000Z",
      actor: { role: "runner", id: "integration" },
      idempotencyKey: "advance-after-failure",
      payload: { integrationRevision: REVISION_TWO, previousIntegrationRevision: REVISION_ONE },
    });
    assert.throws(() => fixture.store.append({
      runId: RUN_ID,
      type: "final_verification.failure_reported",
      occurredAt: "2026-08-26T00:10:03.000Z",
      actor: { role: "runner", id: "runtime" },
      idempotencyKey: "stale-failure",
      payload: { ...failure },
    }), /current generation|stale/i);
    const history = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).finalVerification?.history[0];
    assert.equal(history?.failure?.failureId, failure.failureId);
  } finally {
    fixture.store.close(); fixture.evidence.close(); rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("timeout, cancellation, browser policy, and missing evidence outcomes map into durable failures", async () => {
  const cases = [
    { category: "build" as const, issue: "build timed out", fact: commandFailureFact({ timedOut: true }) },
    { category: "tests" as const, issue: "tests cancelled", fact: commandFailureFact({ cancelled: true }) },
    { category: "browser" as const, issue: "browser console and network policy violation", fact: undefined },
    { category: "runtime_smoke" as const, issue: "required runtime evidence is missing", fact: undefined },
  ];
  for (const scenario of cases) {
    const fixture = createFixture();
    const driver: FinalVerificationCheckDriver = {
      executeCheck: async (input) => {
        const result = completedCheck(input.category, input.category !== scenario.category);
        if (input.category === scenario.category) {
          result.check.issues = [scenario.issue];
          result.check.facts = scenario.fact ? [scenario.fact] : [];
        }
        return result;
      },
    };
    try {
      const runtime = buildRuntime(fixture.store, fixture.evidence, driver);
      let action = "";
      while (action !== "final_verification_check_non_green") {
        action = (await runtime.step()).action ?? "";
      }
      assert.equal((await runtime.step()).action, "final_verification_failure_reported");
      const failure = runtime.projection().finalVerification?.current?.failure;
      assert.deepEqual(failure?.failedCategories, [scenario.category]);
      assert.equal(failure?.issueIds.length, 1);
      assert.equal(failure?.factIds.length, scenario.fact ? 1 : 0);
      assert.equal(runtime.projection().finalVerification?.current?.submission, undefined);
    } finally {
      fixture.store.close(); fixture.evidence.close(); rmSync(fixture.root, { recursive: true, force: true });
    }
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

function actualNonZeroTestDriver(calls: FinalVerificationCategory[]): FinalVerificationCheckDriver {
  return {
    executeCheck: async (input) => {
      calls.push(input.category);
      if (input.category !== "tests") return completedCheck(input.category);
      const result = spawnSync(process.execPath, ["-e", "process.exit(7)"], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      assert.equal(result.status, 7);
      const completed = completedCheck("tests", false);
      completed.check.issues = [`test command exited with non-zero status ${result.status}`];
      completed.check.facts = [{
        kind: "command",
        label: "actual non-zero test check",
        command: process.execPath,
        executable: process.execPath,
        args: ["-e", "process.exit(7)"],
        cwd: process.cwd(),
        startedAt: completed.startedAt,
        finishedAt: completed.finishedAt,
        exitCode: result.status,
        signal: result.signal,
        timedOut: false,
        cancelled: false,
        outputTruncated: false,
        stdoutArtifactHash: "0".repeat(64),
        stderrArtifactHash: "0".repeat(64),
        category: "tests",
        targetRevision: REVISION_ONE,
        startState: { revision: REVISION_ONE, status: "" },
        endState: { revision: REVISION_ONE, status: "" },
      }];
      return completed;
    },
  };
}

function commandFailureFact(overrides: { timedOut?: boolean; cancelled?: boolean }) {
  return {
    kind: "command" as const,
    label: "failed command",
    command: process.execPath,
    executable: process.execPath,
    args: ["-e", "process.exit(1)"],
    cwd: process.cwd(),
    startedAt: "2026-08-26T00:00:03.000Z",
    finishedAt: "2026-08-26T00:00:04.000Z",
    exitCode: null,
    signal: null,
    timedOut: overrides.timedOut ?? false,
    cancelled: overrides.cancelled ?? false,
    outputTruncated: false,
    stdoutArtifactHash: "0".repeat(64),
    stderrArtifactHash: "0".repeat(64),
    category: "build" as const,
    targetRevision: REVISION_ONE,
    startState: { revision: REVISION_ONE, status: "" },
    endState: { revision: REVISION_ONE, status: "" },
  };
}

function completedCheck(
  category: FinalVerificationCategory,
  green = true,
): FinalVerificationCheckExecution {
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
