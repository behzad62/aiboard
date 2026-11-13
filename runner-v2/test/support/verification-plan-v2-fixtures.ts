/**
 * VF3 fixtures shared by the in-memory contract tests (verification-plan-v2-contract) and the
 * process tests that run checks in a fresh verification checkout (verification-plan-v2).
 */
import assert from "node:assert/strict";

import type { FinalVerificationPlan } from "../../src/final-verification-contracts.js";
import {
  cloneFinalVerificationExecutionProfile,
  type FinalVerificationExecutionProfile,
} from "../../src/final-verification-profile.js";
import type { SqliteSchedulerStore } from "../../src/sqlite-scheduler-store.js";
import {
  detectedVerificationSuggestions,
  type VerificationCheckV2,
  type VerificationPlanV2,
} from "../../src/verification-plan-v2.js";
import { emptyFinalVerificationProfile } from "./final-verification-profile.js";

export const FINAL_TASK_ID = "final-verification-v2";
export const GENERATION_ID = "final-verification-v2-generation";
export const SUBMISSION_ID = `final-verification-submission:${GENERATION_ID}`;
export const REVIEW_ID = `final-verification-review:${GENERATION_ID}`;
export const WHEN = "2026-11-13T00:00:00.000Z";

export function detectedSuggestions(): VerificationCheckV2[] {
  return detectedVerificationSuggestions({
    build: [{ label: "npm run build", executable: "npm", args: ["run", "build"] }],
    tests: [{ label: "npm test", executable: "npm", args: ["test"] }],
  }).map((suggestion) => suggestion.check);
}

export function seedTasks(store: SqliteSchedulerStore, runId: string, revision: string): void {
  store.append({ runId, type: "plan.created", occurredAt: WHEN, actor: { role: "architect", id: "architect" }, idempotencyKey: "plan", payload: { revision: 1, tasks: [{ id: "implementation-one", objective: "Implement feature", dependencies: [], status: "integrated", requiredCapabilities: ["code"], acceptanceCriteria: [{ id: "done", text: "Feature implemented." }], acceptanceCriteriaVersion: 1, attempt: 1 }] } });
  store.append({ runId, type: "integration.revision_advanced", occurredAt: WHEN, actor: { role: "runner", id: "integration" }, idempotencyKey: "rev-one", payload: { integrationRevision: revision } });
}

export function v1NotApplicablePlan(rationale = "None."): FinalVerificationPlan {
  return {
    checks: (["build", "tests", "runtime_smoke", "browser"] as const).map((category) => ({
      category,
      status: "not_applicable" as const,
      rationale,
      repositoryInspection: { paths: ["package.json"], summary: rationale },
    })),
  };
}

/** A v2 run with one integrated task and the plan's generation; a v1 plan on it is refused. */
export function seedV2Run(
  store: SqliteSchedulerStore,
  runId: string,
  revision: string,
  plan: VerificationPlanV2,
  profile: FinalVerificationExecutionProfile,
): void {
  store.append({ runId, type: "run.initialized", occurredAt: WHEN, actor: { role: "runner", id: "runner" }, idempotencyKey: "init", payload: { verificationContractVersion: 2 } });
  seedTasks(store, runId, revision);
  assert.throws(() => store.append({ runId, type: "final_verification.generation_created", occurredAt: WHEN, actor: { role: "runner", id: "runtime" }, idempotencyKey: "generation-v1", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, planVersion: 1, plan: v1NotApplicablePlan(), executionProfile: emptyFinalVerificationProfile(revision) } }), /must be a list of checks/);
  store.append({ runId, type: "final_verification.generation_created", occurredAt: WHEN, actor: { role: "runner", id: "runtime" }, idempotencyKey: "generation", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, planVersion: 1, plan, executionProfile: cloneFinalVerificationExecutionProfile(profile) } });
}

export function appendCheck(store: SqliteSchedulerStore, runId: string, revision: string, workspacePath: string, result: unknown): void {
  const checkId = (result as { checkId: string }).checkId;
  store.append({ runId, type: "final_verification.check_completed", occurredAt: WHEN, actor: { role: "runner", id: "runtime" }, idempotencyKey: `check:${checkId}`, payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, attempt: 1, workspacePath, startedAt: WHEN, finishedAt: WHEN, result } });
}

export function cleanupAndRequestReview(store: SqliteSchedulerStore, runId: string, revision: string): void {
  store.append({ runId, type: "final_verification.cleanup_started", occurredAt: WHEN, actor: { role: "runner", id: "runtime" }, idempotencyKey: "cleanup-start", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, attempt: 1 } });
  store.append({ runId, type: "final_verification.cleanup_succeeded", occurredAt: WHEN, actor: { role: "runner", id: "runtime" }, idempotencyKey: "cleanup-success", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, attempt: 1 } });
  store.append({ runId, type: "final_verification.review_requested", occurredAt: WHEN, actor: { role: "runner", id: "runtime" }, idempotencyKey: "review-request", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, submissionId: SUBMISSION_ID, reviewId: REVIEW_ID, attempt: 1 } });
}

export function approveV2(
  store: SqliteSchedulerStore,
  runId: string,
  revision: string,
  submission: unknown,
  reviews: Array<{ checkId: string; evidenceIds: string[] }>,
): void {
  store.append({ runId, type: "final_verification.submitted", occurredAt: WHEN, actor: { role: "runner", id: "runtime" }, idempotencyKey: "submission", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, submissionId: SUBMISSION_ID, attempt: 1, submissionResult: submission } });
  cleanupAndRequestReview(store, runId, revision);
  store.append({ runId, type: "final_verification.review_decided", occurredAt: WHEN, actor: { role: "architect", id: "architect" }, idempotencyKey: "review-decision", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, submissionId: SUBMISSION_ID, reviewId: REVIEW_ID, attempt: 1, decision: "approved", summary: "Every executed check supports approval.", architectRisk: "low", architectRiskRationale: "The checks cover what a user does.", checkReviews: reviews.map((review) => ({ ...review, verdict: "approved", rationale: `Check ${review.checkId} passed with its evidence.` })) } });
}
