import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FinalVerificationPlan } from "../../src/final-verification-contracts.js";
import {
  BuildRuntime,
  type ArchitectRuntimeDriver,
  type IndependentVerifierDriver,
} from "../../src/build-runtime.js";
import {
  deriveFinalVerificationFailure,
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
  type SchedulerEventType,
} from "../../src/scheduler-store.js";
import { SqliteEvidenceStore } from "../../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../../src/sqlite-scheduler-store.js";
import {
  acceptFinalVerificationProfile,
  emptyFinalVerificationProfile,
  profileForRequiredCategories,
} from "./final-verification-profile.js";

export const RUN_ID = "run-verifier-contract";
export const REVISION = "a".repeat(40);
export const FINAL_TASK_ID = "final-verification";
export const GENERATION_ID = "final-generation";
export const REVIEW_ID = "verifier-review-1";
export const SESSION_ID = "verifier:run-verifier-contract:session";
export const CRITERIA = [
  { taskId: "task-api", criterionId: "shared" },
  { taskId: "task-api", criterionId: "typed" },
  { taskId: "task-ui", criterionId: "shared" },
];

export interface VerifierRunFixture {
  root: string;
  database: string;
  evidenceStore: SqliteEvidenceStore;
  store: SqliteSchedulerStore;
  evidenceIds: string[];
  close(): void;
}

export function createFixture(
  name: string,
  options: { approveFinalReview?: boolean; mechanicalFailure?: boolean } = {},
): VerifierRunFixture {
  const root = mkdtempSync(join(tmpdir(), `aiboard-verifier-contract-${name}-`));
  const database = join(root, "scheduler.sqlite");
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  let store = new SqliteSchedulerStore(database, {
    evidenceStore,
    validateCleanupReceipt: () => undefined,
    validateExecutionProfile: acceptFinalVerificationProfile,
  });
  store.append(event("run.initialized", "run:init", {}));
  store.append(event("plan.created", "plan:1", {
    revision: 1,
    tasks: [
      {
        id: "task-api",
        objective: "Implement the API",
        dependencies: [],
        status: "integrated",
        requiredCapabilities: ["code"],
        acceptanceCriteria: [
          { id: "shared", text: "The API meets its user-visible behavior." },
          { id: "typed", text: "The API rejects malformed input." },
        ],
        acceptanceCriteriaVersion: 1,
        attempt: 1,
      },
      {
        id: "task-ui",
        objective: "Implement the UI",
        dependencies: ["task-api"],
        status: "integrated",
        requiredCapabilities: ["code"],
        acceptanceCriteria: [
          { id: "shared", text: "The UI exposes the requested workflow." },
        ],
        acceptanceCriteriaVersion: 1,
        attempt: 1,
      },
    ],
  }, { role: "architect", id: "openai:architect" }));
  store.append(event("integration.revision_advanced", "integration:1", {
    integrationRevision: REVISION,
  }));
  const plan = options.mechanicalFailure ? mechanicalFailedPlan() : finalPlan();
  store.append(event("final_verification.generation_created", "final:generation", {
    taskId: FINAL_TASK_ID,
    generationId: GENERATION_ID,
    targetRevision: REVISION,
    planVersion: 1,
    plan,
    executionProfile: options.mechanicalFailure
      ? profileForRequiredCategories(REVISION, ["tests"])
      : emptyFinalVerificationProfile(REVISION),
  }));
  if (options.mechanicalFailure) {
    seedMechanicalFinalVerificationFailure(store, plan);
  } else {
    seedGreenFinalVerification(store, plan, options.approveFinalReview !== false);
  }

  const evidenceIds = CRITERIA.map((criterion, index) => evidenceStore.record({
    runId: RUN_ID,
    taskId: criterion.taskId,
    actor: { role: "verifier", id: "google:verifier" },
    fact: {
      kind: "browser_screenshot",
      label: `${criterion.taskId}:${criterion.criterionId}`,
      capturedAt: "2026-08-27T00:00:02.000Z",
      screenshotArtifactHash: `${index + 1}`.repeat(64),
      mediaType: "image/png",
      byteLength: 16,
    },
    createdAt: "2026-08-27T00:00:02.000Z",
    idempotencyKey: `verifier-evidence-${index}`,
    attempt: 1,
  }).id);

  return {
    root,
    database,
    evidenceStore,
    get store() { return store; },
    set store(value) { store = value; },
    evidenceIds,
    close: () => {
      try { store.close(); } catch { /* already closed for replay check */ }
      evidenceStore.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function createRuntime(
  store: SqliteSchedulerStore,
  independentVerifier: IndependentVerifierDriver,
  architectRun: ArchitectRuntimeDriver["run"],
  options: { repairPlanLimit?: number } = {},
): BuildRuntime {
  return new BuildRuntime({
    runId: RUN_ID,
    store,
    workerDriver: {
      run: async () => ({ type: "failed", reason: "unused" }),
    },
    architectDriver: { run: architectRun },
    integrationDriver: {
      integrate: async () => ({
        status: "integrated",
        integrationRevision: REVISION,
      }),
    },
    independentVerifier,
    maxConcurrency: 1,
    workspaceFor: async () => "C:/unused",
    clock: () => "2026-08-27T00:00:04.000Z",
    ...options,
  });
}

export function appendVerifierRequest(store: SqliteSchedulerStore): void {
  store.append(event(
    "verifier.review_requested",
    "verifier:request",
    verifierRequestPayload(),
    { role: "runner", id: "native-verifier-runtime" },
  ));
}

export function verifierRequestPayload(): Record<string, unknown> {
  return {
    reviewId: REVIEW_ID,
    targetRevision: REVISION,
    finalVerificationGenerationId: GENERATION_ID,
    runtime: {
      runtimeId: "google:verifier",
      providerId: "google",
      modelId: "google/verifier-model",
      modelIdentity: "verifier-model",
      sessionId: SESSION_ID,
    },
    excludedModels: [
      {
        source: "architect",
        runtimeId: "openai:architect",
        modelIdentity: "architect-model",
      },
      {
        source: "accepted_change_author",
        runtimeId: "anthropic:author",
        modelIdentity: "author-model",
      },
    ],
    criteria: CRITERIA,
  };
}

export function event(
  type: SchedulerEventType,
  idempotencyKey: string,
  payload: Record<string, unknown>,
  actor: NewSchedulerEvent["actor"] = { role: "runner", id: "runner-test" },
): NewSchedulerEvent {
  return {
    runId: RUN_ID,
    type,
    occurredAt: "2026-08-27T00:00:00.000Z",
    actor,
    idempotencyKey,
    payload,
  };
}

function seedGreenFinalVerification(
  store: SqliteSchedulerStore,
  plan: FinalVerificationPlan,
  approveFinalReview: boolean,
): void {
  for (const check of plan.checks) {
    store.append(event(
      "final_verification.check_completed",
      `final:check:${check.category}`,
      {
        taskId: FINAL_TASK_ID,
        generationId: GENERATION_ID,
        targetRevision: REVISION,
        attempt: 1,
        workspacePath: "C:/independent-final-verification",
        startedAt: "2026-08-27T00:00:00.000Z",
        finishedAt: "2026-08-27T00:00:01.000Z",
        result: { ...check, green: true, evidenceIds: [], facts: [], issues: [] },
      },
    ));
  }
  store.append(event("final_verification.submitted", "final:submitted", {
    taskId: FINAL_TASK_ID,
    generationId: GENERATION_ID,
    targetRevision: REVISION,
    attempt: 1,
    submissionId: "final-submission",
    submissionResult: {
      kind: "final_verification_submission",
      generationId: GENERATION_ID,
      runId: RUN_ID,
      taskId: FINAL_TASK_ID,
      attempt: 1,
      targetRevision: REVISION,
      plan,
      executionProfile: emptyFinalVerificationProfile(REVISION),
      checks: plan.checks.map((check) => ({
        ...check,
        green: true,
        evidenceIds: [],
        facts: [],
      })),
      evidenceIds: [],
      submittedAt: "2026-08-27T00:00:01.000Z",
      green: true,
    },
  }));
  store.append(event("final_verification.cleanup_started", "final:cleanup:start", {
    taskId: FINAL_TASK_ID,
    generationId: GENERATION_ID,
    targetRevision: REVISION,
    attempt: 1,
  }));
  store.append(event("final_verification.cleanup_succeeded", "final:cleanup:done", {
    taskId: FINAL_TASK_ID,
    generationId: GENERATION_ID,
    targetRevision: REVISION,
    attempt: 1,
  }));
  store.append(event("final_verification.review_requested", "final:review:request", {
    taskId: FINAL_TASK_ID,
    generationId: GENERATION_ID,
    targetRevision: REVISION,
    attempt: 1,
    submissionId: "final-submission",
    reviewId: "final-review",
  }));
  if (approveFinalReview) {
    store.append(event("final_verification.review_decided", "final:review:approved", {
      taskId: FINAL_TASK_ID,
      generationId: GENERATION_ID,
      targetRevision: REVISION,
      attempt: 1,
      submissionId: "final-submission",
      reviewId: "final-review",
      decision: "approved",
      summary: "Every final-verification category is approved.",
      categoryReviews: plan.checks.map((check) => ({
        category: check.category,
        verdict: "approved",
        rationale: `${check.category} is current and green.`,
        evidenceIds: [],
      })),
    }, { role: "architect", id: "openai:architect" }));
  }
}

function seedMechanicalFinalVerificationFailure(
  store: SqliteSchedulerStore,
  plan: FinalVerificationPlan,
): void {
  const tests = plan.checks.find((check) => check.category === "tests");
  if (tests === undefined) {
    throw new Error("Mechanical failure fixture requires a tests check.");
  }
  store.append(event("final_verification.check_completed", "final:check:tests", {
    taskId: FINAL_TASK_ID,
    generationId: GENERATION_ID,
    targetRevision: REVISION,
    attempt: 1,
    workspacePath: "C:/independent-final-verification",
    startedAt: "2026-08-27T00:00:00.000Z",
    finishedAt: "2026-08-27T00:00:01.000Z",
    result: {
      ...tests,
      green: false,
      evidenceIds: [],
      facts: [],
      issues: ["tests exited non-zero"],
    },
  }));
  const generation = rebuildSchedulerProjection(store.readRun(RUN_ID)).finalVerification?.current;
  if (generation === undefined) {
    throw new Error("Mechanical failure fixture requires a current final-verification generation.");
  }
  store.append(event(
    "final_verification.failure_reported",
    "final:failure",
    deriveFinalVerificationFailure(generation, 1),
  ));
  store.append(event("final_verification.cleanup_started", "final:cleanup:start", {
    taskId: FINAL_TASK_ID,
    generationId: GENERATION_ID,
    targetRevision: REVISION,
    attempt: 1,
  }));
  store.append(event("final_verification.cleanup_succeeded", "final:cleanup:done", {
    taskId: FINAL_TASK_ID,
    generationId: GENERATION_ID,
    targetRevision: REVISION,
    attempt: 1,
    diagnosticsPath: "C:/runner-state/diagnostics/failure.json",
  }));
}

function finalPlan(): FinalVerificationPlan {
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

function mechanicalFailedPlan(): FinalVerificationPlan {
  return {
    checks: ["build", "tests", "runtime_smoke", "browser"].map((category) => (
      category === "tests"
        ? { category: "tests" as const, status: "required" as const }
        : {
            category: category as "build" | "runtime_smoke" | "browser",
            status: "not_applicable" as const,
            rationale: `No ${category} fixture is configured.`,
            repositoryInspection: {
              paths: ["package.json"],
              summary: `No ${category} fixture is configured.`,
            },
          }
    )),
  };
}
