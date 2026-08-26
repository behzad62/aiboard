import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolCallBlock } from "../src/agent-contracts.js";
import { createArchitectTools } from "../src/architect-tools.js";
import { BuildRuntime, type ArchitectActionRequest } from "../src/build-runtime.js";
import type { FinalVerificationPlan } from "../src/final-verification-contracts.js";
import { rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { TaskScheduler } from "../src/task-scheduler.js";
import { ToolRegistry } from "../src/tool-registry.js";

const RUN_ID = "run-final-verification-repair";
const FINAL_TASK_ID = "final-verification-repair-source";
const GENERATION_ID = "final-verification-repair-generation";
const SUBMISSION_ID = `final-verification-submission:${GENERATION_ID}`;
const REVIEW_ID = `final-verification-review:${GENERATION_ID}`;
const REVISION_ONE = "a".repeat(40);
const REVISION_TWO = "b".repeat(40);

test("repair-required review mandates a typed Architect repair plan and prose cannot clear it", async () => {
  const fixture = createFixture();
  let reason: ArchitectActionRequest["reason"] | undefined;
  try {
    const runtime = buildRuntime(fixture, async (request) => {
      reason = request.reason;
      assert.equal(request.reason.type, "final_verification_repair_plan_required");
      if (request.reason.type === "final_verification_repair_plan_required") {
        assert.equal(request.reason.finalVerificationTaskId, FINAL_TASK_ID);
        assert.equal(request.reason.generationId, GENERATION_ID);
        assert.equal(request.reason.submissionId, SUBMISSION_ID);
        assert.equal(request.reason.reviewId, REVIEW_ID);
        assert.equal(request.reason.targetRevision, REVISION_ONE);
        assert.deepEqual(request.reason.failedCategories, ["tests", "browser"]);
        assert.deepEqual(request.reason.evidenceIds, []);
      }
      assert.equal(request.tools.definitions().some(
        (tool) => tool.name === "plan_verification_repairs",
      ), true);
    });
    await assert.rejects(
      () => runtime.step(),
      /final_verification_repair_plan_required.*typed action/i,
    );
    assert.equal(reason?.type, "final_verification_repair_plan_required");
    assert.equal(repairs(fixture.store).length, 0);
    assert.equal(current(fixture.store)?.review?.status, "repair_required");
  } finally {
    fixture.close();
  }
});

test("typed repair plan creates provenance-bound ordinary worker tasks covering failures once", async () => {
  const fixture = createFixture();
  let workerCalls = 0;
  try {
    const result = await invokeRepairs(repairTools(fixture), validRepairPlan(), "repairs-one");
    assert.equal(result.isError, false, result.error?.message ?? "repair plan failed");
    const planned = repairs(fixture.store);
    assert.deepEqual(planned.map((task) => task.id).sort(), ["repair-browser", "repair-tests"]);
    assert.deepEqual(planned[0]!.verificationRepair?.sourceGenerationId, GENERATION_ID);
    assert.equal(planned.every((task) => task.status === "planned"), true);
    assert.equal(planned.every((task) => task.acceptanceCriteria?.length === 1), true);

    const scheduler = new TaskScheduler({
      runId: RUN_ID,
      store: fixture.store,
      driver: {
        run: async () => {
          workerCalls += 1;
          return { type: "failed", reason: "worker eligibility proved" };
        },
      },
      maxConcurrency: 2,
      workspaceFor: async (task) => `C:/repair/${task.id}`,
    });
    await scheduler.tick();
    await scheduler.awaitIdle();
    assert.equal(workerCalls, 2);
  } finally {
    fixture.close();
  }
});

test("repair planning rejects uncovered or duplicated failed categories atomically", async () => {
  const fixture = createFixture();
  try {
    const missing = validRepairPlan();
    missing.tasks.pop();
    let result = await invokeRepairs(repairTools(fixture), missing, "missing-category");
    assert.equal(result.isError, true);
    assert.match(result.error?.message ?? "", /cover|category|failed/i);
    assert.equal(repairs(fixture.store).length, 0);

    const duplicate = validRepairPlan();
    duplicate.tasks[1]!.categories = ["tests"];
    result = await invokeRepairs(repairTools(fixture), duplicate, "duplicate-category");
    assert.equal(result.isError, true);
    assert.match(result.error?.message ?? "", /duplicate|cover|category/i);
    assert.equal(repairs(fixture.store).length, 0);
  } finally {
    fixture.close();
  }
});

test("repair planning rejects stale identity and unknown review evidence", async () => {
  const fixture = createFixture();
  try {
    const stale = validRepairPlan();
    stale.targetRevision = REVISION_TWO;
    let result = await invokeRepairs(repairTools(fixture), stale, "stale-repair");
    assert.equal(result.isError, true);
    assert.match(result.error?.message ?? "", /stale|current|revision/i);

    const unknown = validRepairPlan();
    unknown.tasks[0]!.evidenceIds = ["unknown-evidence"];
    result = await invokeRepairs(repairTools(fixture), unknown, "unknown-repair-evidence");
    assert.equal(result.isError, true);
    assert.match(result.error?.message ?? "", /evidence|unknown/i);
    assert.equal(repairs(fixture.store).length, 0);
  } finally {
    fixture.close();
  }
});

test("repair tasks and provenance deduplicate across scheduler reopen", async () => {
  const fixture = createFixture();
  try {
    let result = await invokeRepairs(repairTools(fixture), validRepairPlan(), "first-plan");
    assert.equal(result.isError, false, result.error?.message ?? "first repair plan failed");
    fixture.store.close();
    fixture.store = new SqliteSchedulerStore(fixture.database, {
      evidenceStore: fixture.evidence,
    });
    const reordered = validRepairPlan();
    reordered.tasks.reverse();
    result = await invokeRepairs(repairTools(fixture), reordered, "reopen-plan");
    assert.equal(result.isError, false, result.error?.message ?? "replay failed");
    assert.equal(repairs(fixture.store).length, 2);
    assert.equal(fixture.store.readRun(RUN_ID).filter(
      (event) => event.type === "final_verification.repairs_planned",
    ).length, 1);
  } finally {
    fixture.close();
  }
});

test("ordinary task transitions cannot rewrite verification repair provenance", async () => {
  const fixture = createFixture();
  try {
    assert.equal((await invokeRepairs(
      repairTools(fixture), validRepairPlan(), "repairs-for-provenance",
    )).isError, false);
    assert.throws(() => fixture.store.append({
      runId: RUN_ID,
      type: "task.transitioned",
      occurredAt: "2026-08-26T00:30:00.000Z",
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: "rewrite-repair-provenance",
      payload: {
        taskId: "repair-tests",
        status: "assigned",
        patch: {
          attempt: 1,
          assignedWorkerId: "worker-repair-tests",
          verificationRepair: {
            sourceGenerationId: "forged-generation",
            finalVerificationTaskId: FINAL_TASK_ID,
            submissionId: SUBMISSION_ID,
            reviewId: REVIEW_ID,
            targetRevision: REVISION_ONE,
            categories: ["tests"],
            evidenceIds: [],
          },
        },
      },
    }), /repair provenance.*immutable|immutable.*provenance/i);
    assert.equal(
      projection(fixture.store).tasks["repair-tests"]?.verificationRepair?.sourceGenerationId,
      GENERATION_ID,
    );
  } finally {
    fixture.close();
  }
});

test("integration revision invalidates repaired generation and fresh planning waits for terminal repairs", async () => {
  const fixture = createFixture();
  const architectReasons: string[] = [];
  try {
    assert.equal((await invokeRepairs(
      repairTools(fixture), validRepairPlan(), "repairs-before-integration",
    )).isError, false);
    integrateRepair(fixture, "repair-tests", REVISION_TWO);
    assert.equal(current(fixture.store), undefined);
    assert.equal(projection(fixture.store).finalVerification?.history.at(-1)?.review?.status,
      "repair_required");
    assert.equal(fixture.store.readRun(RUN_ID).filter(
      (event) => event.type === "final_verification.generation_created",
    ).length, 1);

    for (const task of repairs(fixture.store).filter((task) => task.status === "planned")) {
      fixture.store.append({
        runId: RUN_ID,
        type: "task.transitioned",
        occurredAt: "2026-08-26T01:00:01.000Z",
        actor: { role: "architect", id: "architect-test" },
        idempotencyKey: `cancel-repair:${task.id}`,
        payload: { taskId: task.id, status: "cancelled" },
      });
    }
    const runtime = buildRuntime(fixture, async (request) => {
      architectReasons.push(request.reason.type);
      assert.equal(request.reason.type, "final_verification_plan_required");
      const result = await request.tools.invoke({
        type: "tool_call",
        callId: "fresh-generation",
        name: "plan_final_verification",
        arguments: { plan: finalPlan() },
      }, request.context);
      assert.equal(result.isError, false, result.error?.message ?? "fresh plan failed");
    });
    assert.equal((await runtime.step()).action, "final_verification_plan_required");
    assert.deepEqual(architectReasons, ["final_verification_plan_required"]);
    assert.equal(current(fixture.store)?.targetRevision, REVISION_TWO);
    assert.equal(fixture.store.readRun(RUN_ID).filter(
      (event) => event.type === "final_verification.generation_created",
    ).length, 2);
  } finally {
    fixture.close();
  }
});

test("approved verification review never creates repair tasks", async () => {
  const fixture = createFixture({ reviewStatus: "approved" });
  try {
    const runtime = buildRuntime(fixture, async (request) => {
      assert.equal(request.reason.type, "completion_decision_required");
      const result = await request.tools.invoke({
        type: "tool_call", callId: "complete-approved", name: "complete_run",
        arguments: { summary: "Approved verification is complete." },
      }, request.context);
      assert.equal(result.isError, false, result.error?.message ?? "completion failed");
    });
    assert.equal((await runtime.step()).action, "completion_decision_required");
    assert.equal(repairs(fixture.store).length, 0);
  } finally {
    fixture.close();
  }
});

function buildRuntime(
  fixture: Fixture,
  run: (request: ArchitectActionRequest) => Promise<void>,
) {
  return new BuildRuntime({
    runId: RUN_ID,
    store: fixture.store,
    evidenceStore: fixture.evidence,
    workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
    architectDriver: { run },
    integrationDriver: {
      integrate: async () => ({ status: "integrated", integrationRevision: REVISION_TWO }),
    },
    maxConcurrency: 2,
    workspaceFor: async (task) => `C:/repair/${task.id}`,
  });
}

function repairTools(fixture: Fixture) {
  const tools = new ToolRegistry();
  for (const tool of createArchitectTools({
    store: fixture.store,
    evidenceStore: fixture.evidence,
    finalVerificationRepairPlanAvailable: true,
  })) tools.register(tool);
  return tools;
}

async function invokeRepairs(
  tools: ToolRegistry,
  input: ReturnType<typeof validRepairPlan>,
  callId: string,
) {
  const call: ToolCallBlock = {
    type: "tool_call",
    callId,
    name: "plan_verification_repairs",
    arguments: input,
  };
  return await tools.invoke(call, {
    runId: RUN_ID,
    sessionId: "architect:repair-test",
    actor: { role: "architect", id: "architect-repair-test" },
  });
}

function validRepairPlan() {
  return {
    finalVerificationTaskId: FINAL_TASK_ID,
    generationId: GENERATION_ID,
    submissionId: SUBMISSION_ID,
    reviewId: REVIEW_ID,
    targetRevision: REVISION_ONE,
    tasks: [
      {
        id: "repair-tests",
        objective: "Repair the test behavior identified by final verification review.",
        categories: ["tests"] as Array<"tests" | "browser">,
        evidenceIds: [] as string[],
        dependencies: ["implementation-one"],
        requiredCapabilities: ["code"],
        acceptanceCriteria: [{
          id: "tests-repaired",
          text: "The reviewed tests gap is repaired and regression evidence is recorded.",
        }],
      },
      {
        id: "repair-browser",
        objective: "Repair the browser behavior identified by final verification review.",
        categories: ["browser"] as Array<"tests" | "browser">,
        evidenceIds: [] as string[],
        dependencies: ["implementation-one"],
        requiredCapabilities: ["browser", "code"],
        acceptanceCriteria: [{
          id: "browser-repaired",
          text: "The reviewed browser gap is repaired and browser evidence is recorded.",
        }],
      },
    ],
  };
}

interface Fixture {
  root: string;
  database: string;
  evidence: SqliteEvidenceStore;
  store: SqliteSchedulerStore;
  close(): void;
}

function createFixture(options: { reviewStatus?: "approved" | "repair_required" } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 final verification repair "));
  const database = join(root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const fixture: Fixture = {
    root,
    database,
    evidence,
    store: new SqliteSchedulerStore(database, { evidenceStore: evidence }),
    close() {
      this.store.close();
      this.evidence.close();
      rmSync(this.root, { recursive: true, force: true });
    },
  };
  seed(fixture.store, options.reviewStatus ?? "repair_required");
  return fixture;
}

function seed(store: SqliteSchedulerStore, reviewStatus: "approved" | "repair_required") {
  const plan = finalPlan();
  store.append({ runId: RUN_ID, type: "run.initialized", occurredAt: "2026-08-26T00:00:00.000Z", actor: { role: "runner", id: "runner" }, idempotencyKey: "init", payload: {} });
  store.append({
    runId: RUN_ID, type: "plan.created", occurredAt: "2026-08-26T00:00:01.000Z",
    actor: { role: "architect", id: "architect" }, idempotencyKey: "plan", payload: {
      revision: 1, tasks: [{ id: "implementation-one", objective: "Implement feature", dependencies: [], status: "integrated", requiredCapabilities: ["code"], acceptanceCriteria: [{ id: "done", text: "Feature implemented." }], acceptanceCriteriaVersion: 1, attempt: 1 }],
    },
  });
  store.append({ runId: RUN_ID, type: "integration.revision_advanced", occurredAt: "2026-08-26T00:00:02.000Z", actor: { role: "runner", id: "integration" }, idempotencyKey: "rev-one", payload: { integrationRevision: REVISION_ONE } });
  store.append({ runId: RUN_ID, type: "final_verification.generation_created", occurredAt: "2026-08-26T00:00:03.000Z", actor: { role: "runner", id: "runtime" }, idempotencyKey: "generation", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: REVISION_ONE, planVersion: 1, plan } });
  for (const [index, check] of plan.checks.entries()) {
    store.append({ runId: RUN_ID, type: "final_verification.check_completed", occurredAt: `2026-08-26T00:00:0${index + 4}.000Z`, actor: { role: "runner", id: "runtime" }, idempotencyKey: `check:${check.category}`, payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: REVISION_ONE, attempt: 1, workspacePath: "C:/verify", startedAt: "2026-08-26T00:00:04.000Z", finishedAt: "2026-08-26T00:00:05.000Z", result: { ...check, green: true, evidenceIds: [], facts: [], issues: [] } } });
  }
  store.append({ runId: RUN_ID, type: "final_verification.submitted", occurredAt: "2026-08-26T00:00:09.000Z", actor: { role: "runner", id: "runtime" }, idempotencyKey: "submission", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: REVISION_ONE, submissionId: SUBMISSION_ID, attempt: 1, submissionResult: { kind: "final_verification_submission", generationId: GENERATION_ID, runId: RUN_ID, taskId: FINAL_TASK_ID, attempt: 1, targetRevision: REVISION_ONE, plan, checks: plan.checks.map((check) => ({ ...check, green: true, evidenceIds: [], facts: [] })), evidenceIds: [], submittedAt: "2026-08-26T00:00:09.000Z", green: true } } });
  store.append({ runId: RUN_ID, type: "final_verification.cleanup_started", occurredAt: "2026-08-26T00:00:09.100Z", actor: { role: "runner", id: "runtime" }, idempotencyKey: "cleanup-start", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: REVISION_ONE, attempt: 1 } });
  store.append({ runId: RUN_ID, type: "final_verification.cleanup_succeeded", occurredAt: "2026-08-26T00:00:09.200Z", actor: { role: "runner", id: "runtime" }, idempotencyKey: "cleanup-success", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: REVISION_ONE, attempt: 1 } });
  store.append({ runId: RUN_ID, type: "final_verification.review_requested", occurredAt: "2026-08-26T00:00:10.000Z", actor: { role: "runner", id: "runtime" }, idempotencyKey: "review-request", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: REVISION_ONE, submissionId: SUBMISSION_ID, reviewId: REVIEW_ID, attempt: 1 } });
  const failed = reviewStatus === "repair_required" ? ["tests", "browser"] : [];
  store.append({ runId: RUN_ID, type: "final_verification.review_decided", occurredAt: "2026-08-26T00:00:11.000Z", actor: { role: "architect", id: "architect" }, idempotencyKey: "review-decision", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: REVISION_ONE, submissionId: SUBMISSION_ID, reviewId: REVIEW_ID, attempt: 1, decision: reviewStatus, summary: reviewStatus === "repair_required" ? "Tests and browser behavior need targeted repairs." : "All verification evidence supports approval.", categoryReviews: plan.checks.map((check) => ({ category: check.category, verdict: failed.includes(check.category) ? "repair_required" : "approved", rationale: `Persisted ${check.category} facts were semantically reviewed.`, evidenceIds: [] })) } });
}

function finalPlan(): FinalVerificationPlan {
  return { checks: ["build", "tests", "runtime_smoke", "browser"].map((category) => ({ category: category as FinalVerificationPlan["checks"][number]["category"], status: "not_applicable" as const, rationale: `No ${category} fixture.`, repositoryInspection: { paths: ["package.json"], summary: `No ${category} fixture.` } })) };
}

function integrateRepair(fixture: Fixture, taskId: string, revision: string): void {
  const workerId = `worker_${taskId}_1`;
  const artifactHash = "c".repeat(64);
  const evidence = fixture.evidence.record({
    runId: RUN_ID,
    taskId,
    actor: { role: "worker", id: workerId },
    fact: {
      kind: "browser_screenshot",
      label: "Repair evidence",
      capturedAt: "2026-08-26T01:00:00.000Z",
      screenshotArtifactHash: artifactHash,
      mediaType: "image/png",
      byteLength: 16,
    },
    createdAt: "2026-08-26T01:00:00.000Z",
    idempotencyKey: `repair-evidence:${taskId}`,
    attempt: 1,
  });
  const criterionId = projection(fixture.store).tasks[taskId]!.acceptanceCriteria![0]!.id;
  const links = [{
    criterionId,
    evidenceId: evidence.id,
    artifactHashes: [artifactHash],
    taskId,
    attempt: 1,
  }];
  const transition = (
    status: "assigned" | "running" | "submitted" | "integrating" | "integrated",
    actor: { role: "runner" | "worker" | "architect"; id: string },
    patch: Record<string, unknown> = {},
  ) => fixture.store.append({
    runId: RUN_ID,
    type: "task.transitioned",
    occurredAt: "2026-08-26T01:00:01.000Z",
    actor,
    idempotencyKey: `repair-transition:${taskId}:${status}`,
    payload: { taskId, status, patch },
  });
  transition("assigned", { role: "runner", id: "scheduler" }, {
    attempt: 1,
    assignedWorkerId: workerId,
    workspacePath: `C:/repair/${taskId}`,
  });
  transition("running", { role: "runner", id: "scheduler" });
  transition("submitted", { role: "worker", id: workerId }, {
    changeSetId: `changeset-${taskId}`,
    criterionEvidenceLinks: links,
  });
  fixture.store.append({
    runId: RUN_ID,
    type: "review.requested",
    occurredAt: "2026-08-26T01:00:02.000Z",
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: `repair-review-request:${taskId}`,
    payload: { taskId, evidenceArtifactHashes: [artifactHash], criterionEvidenceLinks: links },
  });
  fixture.store.append({
    runId: RUN_ID,
    type: "review.decided",
    occurredAt: "2026-08-26T01:00:03.000Z",
    actor: { role: "architect", id: "architect-test" },
    idempotencyKey: `repair-review-decision:${taskId}`,
    payload: {
      taskId,
      decision: "approved",
      summary: "Repair acceptance criterion is satisfied.",
      evidenceArtifactHashes: [artifactHash],
      criterionVerdicts: [{
        criterionId,
        verdict: "satisfied",
        rationale: "The repair evidence satisfies the criterion.",
        evidenceIds: [evidence.id],
        artifactHashes: [artifactHash],
      }],
    },
  });
  transition("integrating", { role: "architect", id: "architect-test" });
  transition("integrated", { role: "runner", id: "integration-manager" }, {
    integrationRevision: revision,
  });
}

function projection(store: SqliteSchedulerStore) { return rebuildSchedulerProjection(store.readRun(RUN_ID)); }
function current(store: SqliteSchedulerStore) { return projection(store).finalVerification?.current; }
function repairs(store: SqliteSchedulerStore) { return Object.values(projection(store).tasks).filter((task) => task.kind === "verification_repair"); }
