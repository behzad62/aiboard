import assert from "node:assert/strict";
import test from "node:test";

import { projectIndependentVerifierObservability } from "../src/build-observability.js";
import type { SchedulerProjection } from "../src/scheduler-store.js";

const REVISION = "a".repeat(40);

test("independent verifier observability exposes current policy, risk, selection, and verdict", () => {
  const projection = fixtureProjection();
  const observed = projectIndependentVerifierObservability(projection);

  assert.deepEqual(observed.policy, {
    mode: "risk_based",
    candidateRuntimeIds: ["google:verifier"],
    alwaysRequireIndependentVerifier: true,
    twoPass: false,
  });
  assert.equal(observed.risk.current?.risk, "high");
  assert.equal(observed.risk.current?.architectDeclaration, "high");
  assert.equal(
    observed.risk.current?.architectRationale,
    "Authentication changes require independent review.",
  );
  assert.deepEqual(observed.risk.current?.reasons, [{
    code: "security_auth_crypto_path",
    evidence: ["src/auth/session.ts"],
  }]);
  assert.deepEqual(observed.selection, {
    status: "selected",
    reason: "A distinct verifier is required.",
    requiredCapabilities: ["code"],
    candidateRuntimeIds: ["google:verifier"],
    selectedRuntimeId: "google:verifier",
  });
  assert.equal(observed.review.current?.runtime.runtimeId, "google:verifier");
  assert.equal(observed.review.current?.runtime.sessionId, "verifier:run:1");
  assert.equal(observed.review.current?.verdict?.satisfied, false);
  assert.deepEqual(observed.review.current?.repairTaskIds, ["repair:criterion_ui"]);
  assert.equal(observed.risk.history.length, 8);
  assert.equal(observed.review.history.length, 8);
  assert.equal(observed.review.history.at(-1)?.state, "invalidated");

  observed.policy!.candidateRuntimeIds.push("mutated");
  observed.risk.current!.reasons[0]!.evidence.push("mutated");
  observed.review.current!.runtime.runtimeId = "mutated";
  assert.deepEqual(projection.verifierPolicy?.candidateRuntimeIds, ["google:verifier"]);
  assert.deepEqual(
    projection.buildRisk?.current?.assessment.reasons[0]?.evidence,
    ["src/auth/session.ts"],
  );
  assert.equal(
    projection.verifier?.current?.runtime.runtimeId,
    "google:verifier",
  );
});

function fixtureProjection(): SchedulerProjection {
  const historicalRisks = Array.from({ length: 10 }, (_, index) => ({
    targetRevision: String(index).repeat(40),
    input: {
      architectDeclaration: "low" as const,
      stricterQualification: false,
      kernelFacts: {
        destructiveEffects: false,
        credentialEffects: false,
        externalWriteEffects: false,
        integrationConflict: false,
        changedPaths: [] as string[],
      },
    },
    assessment: {
      risk: "low" as const,
      reasons: [],
      normalizedChangedPaths: [],
    },
    state: "superseded" as const,
    assessedAt: `2026-08-27T00:00:${String(index).padStart(2, "0")}.000Z`,
  }));
  const historicalReviews = Array.from({ length: 10 }, (_, index) => ({
    reviewId: `review-old-${index}`,
    targetRevision: String(index).repeat(40),
    finalVerificationGenerationId: `generation-old-${index}`,
    runtime: {
      runtimeId: "google:verifier",
      providerId: "google",
      modelId: "verifier",
      modelIdentity: "verifier",
      sessionId: `verifier:old:${index}`,
    },
    excludedModels: [{
      source: "architect" as const,
      runtimeId: "openai:architect",
      modelIdentity: "architect",
    }],
    criteria: [{ taskId: "task_ui", criterionId: "criterion_ui" }],
    status: "requested" as const,
    state: "invalidated" as const,
    requestedAt: `2026-08-27T00:01:${String(index).padStart(2, "0")}.000Z`,
  }));
  return {
    runId: "run_observability",
    status: "running",
    planRevision: 1,
    tasks: {},
    guidance: {},
    userGuidance: {},
    userGuidanceVersion: 0,
    architectQuestions: {},
    architectQuestionVersion: 0,
    reviews: {},
    runtime: { providerHealth: {}, workerAssignments: {}, architect: {} },
    integrationRevision: REVISION,
    verifierPolicy: {
      mode: "risk_based",
      candidateRuntimeIds: ["google:verifier"],
      alwaysRequireIndependentVerifier: true,
      twoPass: false,
    },
    buildRisk: {
      current: {
        targetRevision: REVISION,
        input: {
          architectDeclaration: "high",
          stricterQualification: true,
          kernelFacts: {
            destructiveEffects: false,
            credentialEffects: false,
            externalWriteEffects: false,
            integrationConflict: false,
            changedPaths: ["src/auth/session.ts"],
          },
        },
        assessment: {
          risk: "high",
          reasons: [{
            code: "security_auth_crypto_path",
            evidence: ["src/auth/session.ts"],
          }],
          normalizedChangedPaths: ["src/auth/session.ts"],
        },
        state: "current",
        assessedAt: "2026-08-27T01:00:00.000Z",
      },
      history: historicalRisks,
    },
    verifierSelection: {
      status: "selected",
      reason: "A distinct verifier is required.",
      requiredCapabilities: ["code"],
      candidateRuntimeIds: ["google:verifier"],
      selectedRuntimeId: "google:verifier",
    },
    verifier: {
      current: {
        reviewId: "review-current",
        targetRevision: REVISION,
        finalVerificationGenerationId: "generation-current",
        runtime: {
          runtimeId: "google:verifier",
          providerId: "google",
          modelId: "verifier",
          modelIdentity: "verifier",
          sessionId: "verifier:run:1",
        },
        excludedModels: [{
          source: "architect",
          runtimeId: "openai:architect",
          modelIdentity: "architect",
        }],
        criteria: [{ taskId: "task_ui", criterionId: "criterion_ui" }],
        status: "submitted",
        state: "current",
        requestedAt: "2026-08-27T01:00:01.000Z",
        repairTaskIds: ["repair:criterion_ui"],
        verdict: {
          reviewId: "review-current",
          targetRevision: REVISION,
          sessionId: "verifier:run:1",
          satisfied: false,
          criterionVerdicts: [{
            taskId: "task_ui",
            criterionId: "criterion_ui",
            verdict: "unsatisfied",
            rationale: "The current evidence exposes a defect.",
            evidenceIds: ["evidence_ui"],
          }],
          submittedAt: "2026-08-27T01:00:02.000Z",
        },
      },
      history: historicalReviews,
    },
    finalVerification: {
      current: {
        taskId: "verify-current",
        generationId: "generation-current",
        targetRevision: REVISION,
        planVersion: 1,
        plan: { checks: [] },
        executionProfile: {
          version: 1,
          targetRevision: REVISION,
          inspectedPaths: [],
          detectedSignals: [],
          commands: {},
        },
        state: "current",
        review: {
          reviewId: "architect-review",
          submissionId: "submission-current",
          generationId: "generation-current",
          targetRevision: REVISION,
          attempt: 1,
          status: "approved",
          decision: {
            decision: "approved",
            summary: "Mechanical verification is approved.",
            targetRevision: REVISION,
            architectRisk: {
              risk: "high",
              rationale: "Authentication changes require independent review.",
              source: "architect",
            },
            categoryReviews: [],
            failedCategories: [],
          },
        },
      },
      history: [],
    },
    lastSequence: 1,
  };
}
