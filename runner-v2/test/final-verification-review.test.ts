import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolCallBlock } from "../src/agent-contracts.js";
import { createArchitectTools } from "../src/architect-tools.js";
import { buildArchitectContext } from "../src/agent-prompts.js";
import { BuildRuntime } from "../src/build-runtime.js";
import type { FinalVerificationPlan } from "../src/final-verification-contracts.js";
import { rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import {
  acceptFinalVerificationProfile,
  emptyFinalVerificationProfile,
} from "./support/final-verification-profile.js";
import { ToolRegistry } from "../src/tool-registry.js";

const RUN_ID = "run-final-verification-review";
const TASK_ID = "final-verification-review-task";
const GENERATION_ID = "final-verification-review-generation";
const SUBMISSION_ID = `final-verification-submission:${GENERATION_ID}`;
const REVISION_ONE = "a".repeat(40);
const REVISION_TWO = "b".repeat(40);

test("prose or a no-op Architect response cannot approve final verification", async () => {
  const fixture = createFixture({ reviewRequested: false });
  try {
    const runtime = buildRuntime(fixture, async (request) => {
      assert.equal(request.reason.type, "final_verification_review_required");
      assert.equal(
        request.tools.definitions().some((tool) => tool.name === "review_final_verification"),
        true,
      );
    });
    await assert.rejects(
      () => runtime.step(),
      /final_verification_review_required.*typed action/i,
    );
    assert.equal(runtime.projection().finalVerification?.current?.review?.status, "requested");
  } finally {
    fixture.close();
  }
});

test("stale revision or generation cannot approve final verification", async () => {
  const fixture = createFixture();
  const tools = reviewTools(fixture.store, fixture.evidence);
  try {
    fixture.store.append({
      runId: RUN_ID,
      type: "integration.revision_advanced",
      occurredAt: "2026-08-26T00:01:00.000Z",
      actor: { role: "runner", id: "integration-manager" },
      idempotencyKey: "integration:revision:two",
      payload: {
        integrationRevision: REVISION_TWO,
        previousIntegrationRevision: REVISION_ONE,
      },
    });
    const result = await invokeReview(tools, approvedReview(), "stale-review");
    assert.equal(result.isError, true);
    assert.match(result.error?.message ?? "", /current|stale|generation|revision/i);
    assert.equal(projection(fixture.store).finalVerification?.current, undefined);
  } finally {
    fixture.close();
  }
});

test("unknown or category-foreign evidence cannot approve final verification", async () => {
  const fixture = createFixture();
  const tools = reviewTools(fixture.store, fixture.evidence);
  try {
    const review = approvedReview();
    review.categoryReviews[0]!.evidenceIds = ["missing-evidence-id"];
    const result = await invokeReview(tools, review, "unknown-evidence");
    assert.equal(result.isError, true);
    assert.match(result.error?.message ?? "", /evidence|unknown|category/i);
    assert.equal(projection(fixture.store).finalVerification?.current?.review?.status, "requested");
  } finally {
    fixture.close();
  }
});

test("a review missing any final-verification category is rejected", async () => {
  const fixture = createFixture();
  const tools = reviewTools(fixture.store, fixture.evidence);
  try {
    const review = approvedReview();
    review.categoryReviews.pop();
    const result = await invokeReview(tools, review, "missing-category");
    assert.equal(result.isError, true);
    assert.match(result.error?.message ?? "", /invalid|category|exactly|represent/i);
    assert.equal(projection(fixture.store).finalVerification?.current?.review?.status, "requested");
  } finally {
    fixture.close();
  }
});

test("mechanically non-green or unvalidated submission cannot be approved", () => {
  assert.throws(
    () => createFixture({ nonGreenCategory: "tests" }),
    /submission result|validated submission|mechanical/i,
  );
});

test("valid current review persists across reopen and is semantically deduplicated", async () => {
  const fixture = createFixture();
  try {
    let result = await invokeReview(
      reviewTools(fixture.store, fixture.evidence),
      approvedReview(),
      "approve-one",
    );
    assert.equal(result.isError, false, result.error?.message ?? "review failed");
    fixture.store.close();
    fixture.store = new SqliteSchedulerStore(fixture.database, {
      evidenceStore: fixture.evidence,
      validateCleanupReceipt: () => undefined,
      validateExecutionProfile: acceptFinalVerificationProfile,
    });
    const current = projection(fixture.store).finalVerification?.current;
    assert.equal(current?.review?.status, "approved");
    assert.equal(current?.review?.decision?.categoryReviews.length, 4);
    assert.equal(current?.review?.decision?.targetRevision, REVISION_ONE);

    const reordered = approvedReview();
    reordered.categoryReviews.reverse();
    result = await invokeReview(
      reviewTools(fixture.store, fixture.evidence),
      reordered,
      "approve-after-reopen",
    );
    assert.equal(result.isError, false, result.error?.message ?? "replay failed");
    assert.equal(
      fixture.store.readRun(RUN_ID)
        .filter((event) => event.type === "final_verification.review_decided").length,
      1,
    );
    const conflicting = approvedReview();
    conflicting.summary = "A conflicting semantic decision must not replace approval.";
    result = await invokeReview(
      reviewTools(fixture.store, fixture.evidence),
      conflicting,
      "approve-conflict",
    );
    assert.equal(result.isError, true);
    assert.match(result.error?.message ?? "", /already|different|unavailable/i);
  } finally {
    fixture.close();
  }
});

test("semantic rejection durably records repair-required categories without creating tasks", async () => {
  const fixture = createFixture();
  try {
    const review = approvedReview();
    review.decision = "repair_required";
    review.summary = "Tests need a targeted repair before verification can be approved.";
    review.categoryReviews[1]!.verdict = "repair_required";
    review.categoryReviews[1]!.rationale =
      "The persisted tests category facts do not establish the intended regression behavior.";
    const result = await invokeReview(
      reviewTools(fixture.store, fixture.evidence),
      review,
      "repair-required",
    );
    assert.equal(result.isError, false, result.error?.message ?? "repair review failed");
    const current = projection(fixture.store).finalVerification?.current;
    assert.equal(current?.review?.status, "repair_required");
    assert.deepEqual(current?.review?.decision?.failedCategories, ["tests"]);
    assert.match(current?.review?.decision?.summary ?? "", /targeted repair/i);
    assert.equal(
      Object.values(projection(fixture.store).tasks).filter(
        (task) => task.kind !== "final_verification",
      ).length,
      1,
    );
  } finally {
    fixture.close();
  }
});

test("Architect context contains the exact current submission and durable category facts", () => {
  const fixture = createFixture();
  try {
    const currentProjection = projection(fixture.store);
    const context = buildArchitectContext({
      limits: { maxBytes: 128 * 1024, maxEstimatedTokens: 32 * 1024 },
      objective: "Semantically review final verification.",
      reason: {
        type: "final_verification_review_required",
        taskId: TASK_ID,
        generationId: GENERATION_ID,
        submissionId: SUBMISSION_ID,
        targetRevision: REVISION_ONE,
      },
      projection: currentProjection,
      instructions: [],
      skills: [],
      memories: [],
      evidence: [],
      recentHistory: [],
    });
    assert.match(context.text, new RegExp(GENERATION_ID));
    assert.match(context.text, new RegExp(REVISION_ONE));
    assert.match(context.text, /"submissionResult"/);
    assert.match(context.text, /"completedChecks"/);
    assert.match(context.text, /"repositoryInspection"/);
  } finally {
    fixture.close();
  }
});

function buildRuntime(fixture: Fixture, runArchitect: ConstructorParameters<typeof BuildRuntime>[0]["architectDriver"]["run"]) {
  return new BuildRuntime({
    runId: RUN_ID,
    store: fixture.store,
    evidenceStore: fixture.evidence,
    workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
    architectDriver: { run: runArchitect },
    integrationDriver: {
      integrate: async () => ({ status: "integrated", integrationRevision: REVISION_ONE }),
    },
    maxConcurrency: 1,
    workspaceFor: async () => "C:/unused",
  });
}

function reviewTools(store: SqliteSchedulerStore, evidenceStore: SqliteEvidenceStore) {
  const tools = new ToolRegistry();
  for (const tool of createArchitectTools({
    store,
    evidenceStore,
    finalVerificationReviewAvailable: true,
  })) tools.register(tool);
  return tools;
}

async function invokeReview(
  tools: ToolRegistry,
  review: ReturnType<typeof approvedReview>,
  callId: string,
) {
  const call: ToolCallBlock = {
    type: "tool_call",
    callId,
    name: "review_final_verification",
    arguments: review,
  };
  return await tools.invoke(call, {
    runId: RUN_ID,
    sessionId: "architect:review-test",
    actor: { role: "architect", id: "architect-review-test" },
  });
}

function approvedReview() {
  return {
    taskId: TASK_ID,
    generationId: GENERATION_ID,
    targetRevision: REVISION_ONE,
    submissionId: SUBMISSION_ID,
    attempt: 1,
    decision: "approved" as "approved" | "repair_required",
    summary: "Every persisted final-verification category supports approval.",
    categoryReviews: finalPlan().checks.map((check) => ({
      category: check.category,
      verdict: "approved" as "approved" | "repair_required",
      rationale: `The persisted ${check.category} result supports this semantic decision.`,
      evidenceIds: [] as string[],
    })),
  };
}

interface Fixture {
  root: string;
  database: string;
  evidence: SqliteEvidenceStore;
  store: SqliteSchedulerStore;
  close(): void;
}

function createFixture(options: {
  reviewRequested?: boolean;
  nonGreenCategory?: FinalVerificationPlan["checks"][number]["category"];
} = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 final verification review "));
  const database = join(root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const fixture: Fixture = {
    root,
    database,
    evidence,
    store: new SqliteSchedulerStore(database, {
      evidenceStore: evidence,
      validateCleanupReceipt: () => undefined,
      validateExecutionProfile: acceptFinalVerificationProfile,
    }),
    close() {
      this.store.close();
      this.evidence.close();
      rmSync(this.root, { recursive: true, force: true });
    },
  };
  try {
    appendBase(fixture.store, options);
    return fixture;
  } catch (error) {
    fixture.close();
    throw error;
  }
}

function appendBase(
  store: SqliteSchedulerStore,
  options: {
    reviewRequested?: boolean;
    nonGreenCategory?: FinalVerificationPlan["checks"][number]["category"];
  },
) {
  const plan = finalPlan(options.nonGreenCategory ? [options.nonGreenCategory] : []);
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
    idempotencyKey: "plan-one",
    payload: {
      revision: 1,
      tasks: [{
        id: "implementation-one",
        objective: "Implement the feature",
        dependencies: [],
        status: "integrated",
        requiredCapabilities: ["code"],
        acceptanceCriteria: [{ id: "implemented", text: "Feature implemented." }],
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
    idempotencyKey: "integration-one",
    payload: { integrationRevision: REVISION_ONE },
  });
  store.append({
    runId: RUN_ID,
    type: "final_verification.generation_created",
    occurredAt: "2026-08-26T00:00:03.000Z",
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: "generation-one",
    payload: {
      taskId: TASK_ID,
      generationId: GENERATION_ID,
      targetRevision: REVISION_ONE,
      planVersion: 1,
      plan,
      executionProfile: emptyFinalVerificationProfile(REVISION_ONE),
    },
  });
  for (const [index, check] of plan.checks.entries()) {
    const green = check.category !== options.nonGreenCategory;
    store.append({
      runId: RUN_ID,
      type: "final_verification.check_completed",
      occurredAt: `2026-08-26T00:00:0${index + 4}.000Z`,
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `check-${check.category}`,
      payload: {
        taskId: TASK_ID,
        generationId: GENERATION_ID,
        targetRevision: REVISION_ONE,
        attempt: 1,
        workspacePath: "C:/verification-workspace",
        startedAt: "2026-08-26T00:00:04.000Z",
        finishedAt: "2026-08-26T00:00:05.000Z",
        result: {
          ...check,
          green,
          evidenceIds: [],
          facts: [],
          issues: green ? [] : [`${check.category} failed mechanically.`],
        },
      },
    });
  }
  store.append({
    runId: RUN_ID,
    type: "final_verification.submitted",
    occurredAt: "2026-08-26T00:00:09.000Z",
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: "submission-one",
    payload: {
      taskId: TASK_ID,
      generationId: GENERATION_ID,
      targetRevision: REVISION_ONE,
      submissionId: SUBMISSION_ID,
      attempt: 1,
      ...(options.nonGreenCategory ? {} : {
        submissionResult: {
          kind: "final_verification_submission",
          generationId: GENERATION_ID,
          runId: RUN_ID,
          taskId: TASK_ID,
          attempt: 1,
          targetRevision: REVISION_ONE,
          plan,
          checks: plan.checks.map((check) => ({
            ...check,
            green: true,
            evidenceIds: [],
            facts: [],
          })),
          evidenceIds: [],
          submittedAt: "2026-08-26T00:00:09.000Z",
          green: true,
        },
      }),
    },
  });
  if (!options.nonGreenCategory) {
    for (const [type, suffix] of [["final_verification.cleanup_started", "started"], ["final_verification.cleanup_succeeded", "succeeded"]] as const) {
      store.append({
        runId: RUN_ID, type, occurredAt: "2026-08-26T00:00:09.500Z",
        actor: { role: "runner", id: "build-runtime" }, idempotencyKey: `cleanup-${suffix}`,
        payload: { taskId: TASK_ID, generationId: GENERATION_ID, targetRevision: REVISION_ONE, attempt: 1 },
      });
    }
  }
  if (options.reviewRequested !== false && !options.nonGreenCategory) {
    store.append({
      runId: RUN_ID,
      type: "final_verification.review_requested",
      occurredAt: "2026-08-26T00:00:10.000Z",
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "review-request-one",
      payload: {
        taskId: TASK_ID,
        generationId: GENERATION_ID,
        targetRevision: REVISION_ONE,
        submissionId: SUBMISSION_ID,
        reviewId: `final-verification-review:${GENERATION_ID}`,
        attempt: 1,
      },
    });
  }
}

function projection(store: SqliteSchedulerStore) {
  return rebuildSchedulerProjection(store.readRun(RUN_ID));
}

function finalPlan(
  requiredCategories: readonly FinalVerificationPlan["checks"][number]["category"][] = [],
): FinalVerificationPlan {
  return {
    checks: ["build", "tests", "runtime_smoke", "browser"].map((category) => ({
      category: category as FinalVerificationPlan["checks"][number]["category"],
      ...(requiredCategories.includes(category as FinalVerificationPlan["checks"][number]["category"])
        ? { status: "required" as const }
        : {
            status: "not_applicable" as const,
            rationale: `No ${category} surface is configured in this fixture.`,
            repositoryInspection: {
              paths: ["package.json"],
              summary: `The persisted inspection found no ${category} surface.`,
            },
          }),
    })),
  };
}
