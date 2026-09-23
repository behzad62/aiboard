import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ContextRecordingLines,
  filterRunnerObservability,
  IndependentVerifierManifest,
  RunnerV2ObservabilityPanel,
  runnerAcceptanceContractSummary,
  runnerBuildControlSummary,
  runnerEvidenceDiagnosticDetail,
  runnerExecutionSafetyDiagnostics,
  runnerNextCooldownExpiry,
  runnerObservabilitySummary,
  runnerUserFacingObservability,
  runnerVerificationTone,
} from "../components/RunnerV2ObservabilityPanel";
import { nativeBuildActivityEntries } from "../lib/client/native-build-activity";
import type {
  NativeBuildObservability,
  NativeBuildProjection,
  NativeIndependentVerifierObservability,
  NativePlanCritiqueFinding,
  NativePlanCritiqueProjection,
  NativePlanCritiqueState,
} from "../lib/client/runner-v2";

const activity = nativeBuildActivityEntries("run_1", [
  {
    sequence: 1,
    type: "task.transitioned",
    occurredAt: "2026-07-12T00:00:00.000Z",
    actor: { role: "runner", id: "scheduler" },
    payload: { taskId: "T1", status: "running" },
  },
  {
    sequence: 2,
    type: "guidance.requested",
    occurredAt: "2026-07-12T00:00:01.000Z",
    actor: { role: "worker", id: "worker_1" },
    payload: { taskId: "T1" },
  },
], 1, (value) => value.slice(11, 19));
assert.deepEqual(activity, [{
  id: "native:run_1:2",
  at: "00:00:01",
  phase: "model_streaming",
  message: "worker worker_1: guidance.requested — T1",
}]);

const projection = {
  runId: "run_1",
  status: "paused",
  planRevision: 2,
  tasks: {
    T1: {
      id: "T1",
      objective: "Implement feature",
      dependencies: [],
      status: "integrated",
      requiredCapabilities: ["code"],
      attempt: 1,
      changeSetId: "change_1",
      integrationRevision: "abc123",
      acceptanceCriteria: [
        { id: "behavior", text: "The feature works." },
        { id: "inspection", text: "The inspection evidence is recorded." },
      ],
      acceptanceCriteriaVersion: 1,
      criterionEvidenceLinks: [{
        criterionId: "behavior",
        evidenceId: "evidence_tests_passed",
        artifactHashes: ["c".repeat(64)],
      }, {
        criterionId: "inspection",
        evidenceId: "evidence_tests_passed",
        artifactHashes: ["c".repeat(64)],
      }],
    },
  },
  guidance: {
    guide_1: {
      requestId: "guide_1",
      taskId: "T1",
      blocking: true,
      question: "Which API shape?",
      evidenceSequence: 4,
      version: 1,
      status: "answered",
      answer: "Preserve the public interface.",
    },
  },
  reviews: {
    T1: {
      taskId: "T1",
      status: "approved",
      summary: "Accepted.",
      evidenceArtifactHashes: ["c".repeat(64)],
      criterionEvidenceLinks: [{
        criterionId: "behavior",
        evidenceId: "evidence_tests_passed",
        artifactHashes: ["c".repeat(64)],
      }],
      criterionVerdicts: [{
        criterionId: "behavior",
        verdict: "satisfied",
        rationale: "The evidence supports the requested behavior.",
        evidenceIds: ["evidence_tests_passed"],
        artifactHashes: ["c".repeat(64)],
      }],
    },
  },
  runtime: { providerHealth: {}, workerAssignments: {}, architect: {} },
  projectHandoff: {
    status: "requested",
    summary: "Ready",
    options: ["keep_integration_branch", "apply_to_project"],
    integrationRevision: "abc123",
    integrationBranch: "aiboard/run/integration",
  },
  lastSequence: 12,
} as const;
const control = runnerBuildControlSummary(projection);
assert.equal(control.guidance[0].question, "Which API shape?");
assert.equal(control.integration[0].revision, "abc123");
assert.equal(control.branch, "aiboard/run/integration");
const acceptance = runnerAcceptanceContractSummary(projection);
assert.equal(acceptance.status, "current");
assert.equal(acceptance.planRevision, 2);
assert.deepEqual(acceptance.tasks, [{
  taskId: "T1",
  title: "Implement feature",
  version: 1,
  criteria: [{
    id: "behavior",
    text: "The feature works.",
    evidence: {
      status: "submitted",
      evidenceIds: ["evidence_tests_passed"],
      artifactHashes: ["c".repeat(64)],
    },
    verdict: {
      status: "satisfied",
      rationale: "The evidence supports the requested behavior.",
      evidenceIds: ["evidence_tests_passed"],
      artifactHashes: ["c".repeat(64)],
    },
  }, {
    id: "inspection",
    text: "The inspection evidence is recorded.",
    evidence: {
      status: "submitted",
      evidenceIds: ["evidence_tests_passed"],
      artifactHashes: ["c".repeat(64)],
    },
    verdict: {
      status: "not_reviewed",
      evidenceIds: [],
      artifactHashes: [],
    },
  }],
}]);

const observability = {
  runId: "run_1",
  toolCallCount: 1,
  contextManifestCount: 2,
  budget: {
    scopeId: "run_1",
    reservations: {},
    activeSegments: {},
    effective: {
      modelCalls: 9,
      toolCalls: 27,
      inputTokens: 12_000,
      cachedInputTokens: 8_000,
      cacheWriteInputTokens: 2_000,
      outputTokens: 3_000,
      estimatedCostMicros: 125_000,
      activeMs: 45_000,
      artifactBytes: 1_024,
    },
    lastSequence: 42,
  },
  agents: [{
    sessionId: "worker:run_1:T1:1",
    actor: { role: "worker", id: "worker_1" },
    status: "submitted",
    turns: 4,
    lastSequence: 8,
  }, {
    sessionId: "worker:run_1:T0:1:subagent:research_1",
    actor: { role: "subagent", id: "worker_old:research_1" },
    status: "suspended",
    turns: 2,
    suspensionReason: "subagent_incomplete",
    lastSequence: 5,
  }],
  tools: [{
    sequence: 1,
    sessionId: "worker:run_1:T1:1",
    callId: "read_1",
    toolName: "fs.read",
    status: "completed",
    occurredAt: "2026-07-12T00:00:00.000Z",
    isError: false,
  }],
  evidence: [{
    id: "evidence_tests_failed",
    runId: "run_1",
    taskId: "T1",
    actor: { role: "worker", id: "worker_1" },
    status: "observed",
    fact: {
      kind: "command",
      label: "Runner tests",
      command: "npm",
      args: ["test"],
      cwd: "C:\\project",
      startedAt: "2026-07-12T00:00:00.000Z",
      finishedAt: "2026-07-12T00:00:01.000Z",
      exitCode: 1,
      signal: null,
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
      stdoutArtifactHash: "a".repeat(64),
      stderrArtifactHash: "b".repeat(64),
    },
    createdAt: "2026-07-12T00:00:01.000Z",
    idempotencyKey: "tests:failed",
  }, {
    id: "evidence_tests_passed",
    runId: "run_1",
    taskId: "T1",
    actor: { role: "worker", id: "worker_1" },
    status: "observed",
    fact: {
      kind: "command",
      label: "Runner tests",
      command: "npm",
      args: ["test"],
      cwd: "C:\\project",
      startedAt: "2026-07-12T00:00:01.000Z",
      finishedAt: "2026-07-12T00:00:02.000Z",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
      stdoutArtifactHash: "c".repeat(64),
      stderrArtifactHash: "d".repeat(64),
    },
    createdAt: "2026-07-12T00:00:02.000Z",
    idempotencyKey: "tests:passed",
  }],
  memories: [],
  skills: [{
    id: "built-in:verification",
    name: "verification",
    description: "Gather fresh evidence",
    source: "built-in",
    digest: "a".repeat(64),
  }],
  processes: [],
  providers: [{
    providerId: "chatgpt",
    status: "healthy",
    consecutiveFailures: 0,
    updatedAt: 1,
  }],
  events: [{
    sequence: 1,
    type: "task.transitioned",
    occurredAt: "2026-07-12T00:00:00.000Z",
    actor: { role: "runner", id: "scheduler" },
    payload: { taskId: "T1", to: "running" },
  }],
  git: {
    integrationBranch: "aiboard/run/integration",
    integrationRevision: "abc123",
    commits: [{ revision: "abc123", parents: [], subject: "Integrate T1" }],
  },
} as const;
const summary = runnerObservabilitySummary(observability);

assert.deepEqual(summary, {
  modelCalls: 9,
  toolCalls: 1,
  totalTokens: 15_000,
  cachedInputTokens: 8_000,
  cacheWriteInputTokens: 2_000,
  agents: 2,
  suspendedAgents: 1,
  toolErrors: 0,
  evidence: 2,
  memories: 0,
  skills: 1,
  runningProcesses: 0,
  providers: 1,
  events: 1,
  contextManifests: 2,
});

const view = runnerUserFacingObservability(observability, projection);
assert.equal(view.lifecycle, "Ready for your decision");
assert.equal(view.progress.completed, 1);
assert.equal(view.progress.total, 1);
assert.equal(view.progress.items[0]?.title, "Implement feature");
assert.equal(view.progress.items[0]?.detail, "Complete");
assert.equal(view.verification.length, 1);
assert.equal(view.verification.find((item) => item.category === "Tests")?.status, "passed");
assert.deepEqual(view.problems, []);

const canonicalSnapshot = {
  ...observability,
  evidence: observability.evidence.slice(0, 1),
  finalVerification: {
    canonicalRevision: "revision-current",
    history: [{ generationId: "old-generation", taskId: "old-verify", targetRevision: "revision-old", revisionStatus: "stale" }],
    current: {
      generationId: "generation-7",
      taskId: "verify-7",
      targetRevision: "revision-current",
      revisionStatus: "current",
      categories: [
        { category: "build", applicability: "required", status: "passed", evidenceIds: ["build-evidence"], issues: [] },
        { category: "tests", applicability: "required", status: "failed", evidenceIds: ["test-evidence"], issues: ["tests exited 1"] },
        { category: "runtime_smoke", applicability: "not_applicable", rationale: "No server", repositoryInspection: { inspectedPaths: ["package.json"], summary: "No server" }, status: "not_applicable", evidenceIds: [], issues: [] },
        { category: "browser", applicability: "required", status: "pending", evidenceIds: [], issues: [] },
      ],
      submission: { status: "pending" },
      mechanicalFailure: { failureId: "failure-7", failedCategories: ["tests"], evidenceIds: ["test-evidence"] },
      cleanup: { status: "succeeded", attempt: 1, diagnosticsAvailable: true },
      review: { status: "pending" },
      repairs: [{ taskId: "repair-tests", status: "running" }],
    },
  },
} as unknown as NativeBuildObservability;
const canonicalProjection = {
  ...projection,
  integrationRevision: "revision-current",
  tasks: {
    ...projection.tasks,
    "verify-7": { id: "verify-7", kind: "final_verification", objective: "Verify integrated revision", dependencies: [], status: "planned", requiredCapabilities: [], attempt: 1, generationId: "generation-7", targetRevision: "revision-current" },
    "repair-tests": { id: "repair-tests", kind: "verification_repair", objective: "Repair failing tests", dependencies: [], status: "running", requiredCapabilities: [], attempt: 1 },
  },
} as unknown as NativeBuildProjection;
const canonicalView = runnerUserFacingObservability(canonicalSnapshot, canonicalProjection);
assert.deepEqual(canonicalView.verification.map((item) => [item.category, item.status]), [
  ["Build", "passed"], ["Tests", "failed"], ["Runtime", "not_applicable"], ["Browser", "pending"],
]);
assert.ok(canonicalView.problems.some((problem) => problem.key === "final-verification:failure"));
assert.ok(canonicalView.problems.some((problem) => problem.key === "final-verification:repair"));
assert.doesNotMatch(JSON.stringify(canonicalView), /old-generation/);

const evidenceCannotApprove = runnerUserFacingObservability({
  ...canonicalSnapshot,
  finalVerification: { ...canonicalSnapshot.finalVerification, current: { ...canonicalSnapshot.finalVerification.current, categories: canonicalSnapshot.finalVerification.current.categories.map((category) => ({ ...category, status: category.applicability === "not_applicable" ? "not_applicable" : "passed" })), mechanicalFailure: undefined, cleanup: { status: "succeeded", diagnosticsAvailable: false }, review: { status: "pending" }, repairs: [] } },
} as NativeBuildObservability, canonicalProjection);
assert.ok(evidenceCannotApprove.verificationSeal?.status === "review_pending");
assert.notEqual(evidenceCannotApprove.verificationSeal?.status, "approved");
const cleanupFailed = runnerUserFacingObservability({
  ...canonicalSnapshot,
  finalVerification: { ...canonicalSnapshot.finalVerification, current: { ...canonicalSnapshot.finalVerification.current, mechanicalFailure: undefined, repairs: [], categories: canonicalSnapshot.finalVerification.current.categories.map((category) => ({ ...category, status: category.applicability === "not_applicable" ? "not_applicable" : "passed" })), cleanup: { status: "failed", attempt: 2, error: "owned workspace busy", diagnosticsAvailable: true }, review: { status: "pending" } } },
} as NativeBuildObservability, canonicalProjection);
assert.equal(cleanupFailed.verificationSeal?.status, "failed");
assert.ok(cleanupFailed.problems.some((problem) => problem.key === "final-verification:cleanup"));

assert.equal(runnerVerificationTone([{ status: "failed" }, { status: "passed" }]), "error");
assert.equal(runnerVerificationTone([{ status: "passed" }, { status: "recorded" }]), "success");
assert.equal(runnerVerificationTone([{ status: "recorded" }]), "progress");
assert.equal(runnerVerificationTone([]), "progress");

const projectionWithoutHandoff = {
  ...projection,
  status: "running",
  projectHandoff: undefined,
};
const problemKeys = (
  snapshot: Parameters<typeof runnerUserFacingObservability>[0],
  projected: Parameters<typeof runnerUserFacingObservability>[1],
  now?: number
) => runnerUserFacingObservability(snapshot, projected, now).problems.map((problem) => problem.key);
const executionSafetySnapshot = {
  ...observability,
  executionSafety: {
    availability: "live",
    fullBypass: true,
    isolation: {
      status: "unconfined_explicit_full",
      securityBoundary: "provider_specific_not_universal_security_boundary",
      activeLeaseCount: 0,
      blockers: [],
    },
    grants: { active: 1, consumed: 0 },
    processes: [{
      kind: "subprocess", invocationId: "invocation-1", logicalProcessId: "logical-1",
      lifecycleState: "outcome_unknown", owned: true, pendingEffects: false,
      backend: { backendId: "runner-windows-job-v1", implementationDigest: "a".repeat(64) },
      lifecycle: { scope: "process_group", termination: "enforced", emptiness: "enforced" },
      requiredLifecycleScope: "process_group",
      capabilities: {
        tree_termination: "enforced", crash_cleanup: "enforced",
        verified_emptiness: "enforced", write_confinement: "unverified",
      },
      requiredCapabilities: ["tree_termination"],
      leaseExpiresAt: "2026-09-15T18:30:00.000Z",
      cleanup: { state: "pending" },
      output: { status: "lossy", totalBytes: 100, truncated: true, lossyBytes: 5 },
    }],
    recovery: [{
      proposalId: "proposal-1", requestedAction: "terminate", state: "user_decision_required",
      reason: "destructive_requires_user", updatedAt: "2026-09-15T18:00:00.000Z", cleanupState: "pending",
    }],
  },
} as unknown as NativeBuildObservability;
const safetyDiagnostics = runnerExecutionSafetyDiagnostics(executionSafetySnapshot);
assert.ok(safetyDiagnostics.some((item) => item.title === "Full permission bypass active"));
assert.ok(safetyDiagnostics.some((item) => item.detail.includes("runner-windows-job-v1")));
assert.ok(safetyDiagnostics.some((item) => item.detail.includes("lifecycle process_group")));
assert.ok(safetyDiagnostics.some((item) => item.detail.includes("required process_group")));
assert.ok(safetyDiagnostics.some((item) => item.detail.includes("lossy")));
assert.ok(safetyDiagnostics.some((item) => item.detail.includes("user decision")));
assert.deepEqual(problemKeys(executionSafetySnapshot, projectionWithoutHandoff), [
  "execution-safety:full-bypass",
  "execution-safety:output:invocation-1",
  "execution-safety:cleanup:invocation-1",
  "execution-safety:recovery:proposal-1",
]);
const unverifiedSafety = {
  ...executionSafetySnapshot,
  executionSafety: {
    ...executionSafetySnapshot.executionSafety,
    fullBypass: false,
    isolation: { ...executionSafetySnapshot.executionSafety.isolation, status: "unverified" },
    processes: [],
    recovery: [],
  },
} as NativeBuildObservability;
assert.deepEqual(problemKeys(unverifiedSafety, projectionWithoutHandoff), ["execution-safety:isolation"]);
const unavailableSafety = {
  ...observability,
  executionSafety: { availability: "unavailable", reason: "historical_execution_safety_unavailable" },
} as NativeBuildObservability;
assert.equal(runnerExecutionSafetyDiagnostics(unavailableSafety)[0]?.title, "Execution safety unavailable");
assert.deepEqual(problemKeys(unavailableSafety, projectionWithoutHandoff), []);

assert.deepEqual(problemKeys(observability, {
  ...projectionWithoutHandoff,
  guidance: {
    guide_1: { ...projection.guidance.guide_1, status: "open", answer: undefined },
  },
}), ["guidance:guide_1"]);
assert.deepEqual(problemKeys(observability, projectionWithoutHandoff), []);
assert.deepEqual(problemKeys(observability, {
  ...projectionWithoutHandoff,
  tasks: { T1: { ...projection.tasks.T1, status: "failed" } },
}), ["task:T1"]);
assert.deepEqual(problemKeys(observability, {
  ...projectionWithoutHandoff,
  tasks: { T1: { ...projection.tasks.T1, status: "rejected" } },
}), ["task:T1"]);
assert.deepEqual(problemKeys(observability, {
  ...projectionWithoutHandoff,
  tasks: {
    T1: {
      ...projection.tasks.T1,
      status: "integration_resolution",
      conflictPaths: ["components/panel.tsx"],
    },
  },
}), ["conflict:T1"]);
assert.deepEqual(problemKeys(observability, {
  ...projectionWithoutHandoff,
  status: "paused",
}), ["run:paused"]);

const verifierSnapshot = {
  ...observability,
  independentVerifier: {
    policy: {
      mode: "risk_based",
      candidateRuntimeIds: ["google:verifier"],
      alwaysRequireIndependentVerifier: false,
      twoPass: true,
    },
    risk: {
      current: {
        targetRevision: "revision-current",
        state: "current",
        risk: "high",
        architectDeclaration: "high",
        architectRationale: "Authentication behavior changed.",
        architectRiskSource: "architect",
        stricterQualification: false,
        kernelFacts: {
          destructiveEffects: false,
          credentialEffects: false,
          externalWriteEffects: false,
          integrationConflict: false,
          changedPaths: ["src/auth/session.ts"],
        },
        reasons: [{
          code: "security_auth_crypto_path",
          evidence: ["src/auth/session.ts"],
        }],
        normalizedChangedPaths: ["src/auth/session.ts"],
        assessedAt: "2026-08-27T01:00:00.000Z",
      },
      history: [],
    },
    selection: {
      status: "selected",
      reason: "A distinct verifier is required.",
      requiredCapabilities: ["code"],
      candidateRuntimeIds: ["google:verifier"],
      selectedRuntimeId: "google:verifier",
    },
    review: {
      current: {
        reviewId: "review-current",
        targetRevision: "revision-current",
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
        criteria: [{ taskId: "T1", criterionId: "behavior" }],
        status: "submitted",
        state: "current",
        requestedAt: "2026-08-27T01:00:01.000Z",
        repairTaskIds: ["repair:behavior"],
        twoPass: true,
        baselineRevision: "b".repeat(40),
        expectations: [{
          taskId: "T1",
          criterionId: "behavior",
          expectedBehaviors: ["Authentication stays scoped to one organization."],
          edgeCases: ["Two organizations share a user id"],
          regressionSurfaces: ["src/auth/session.ts"],
          requiredTests: ["AuthScope"],
        }],
        expectationsSessionId: "verifier:expectations:1",
        verdict: {
          reviewId: "review-current",
          targetRevision: "revision-current",
          sessionId: "verifier:run:1",
          satisfied: false,
          criterionVerdicts: [{
            taskId: "T1",
            criterionId: "behavior",
            verdict: "unsatisfied",
            rationale: "The authentication flow still fails.",
            evidenceIds: ["evidence_auth_failure"],
            location: { path: "src/auth/session.ts", lines: "40-55" },
            reproduction: [
              "Sign in to two organizations",
              "Remove the membership in the first",
              "Observe the second session invalidated",
            ],
          }],
          submittedAt: "2026-08-27T01:00:02.000Z",
        },
      },
      history: [{
        reviewId: "review-stale",
        targetRevision: "revision-stale",
        finalVerificationGenerationId: "generation-stale",
        runtime: {
          runtimeId: "old:verifier",
          providerId: "old",
          modelId: "old-verifier",
          modelIdentity: "old-verifier",
          sessionId: "verifier:old:1",
        },
        excludedModels: [{
          source: "architect",
          runtimeId: "openai:architect",
          modelIdentity: "architect",
        }],
        criteria: [{ taskId: "T1", criterionId: "behavior" }],
        status: "submitted",
        state: "invalidated",
        requestedAt: "2026-08-27T00:00:00.000Z",
        verdict: {
          reviewId: "review-stale",
          targetRevision: "revision-stale",
          sessionId: "verifier:old:1",
          satisfied: true,
          criterionVerdicts: [{
            taskId: "T1",
            criterionId: "behavior",
            verdict: "satisfied",
            rationale: "Stale approval must stay historical.",
            evidenceIds: ["evidence_stale"],
          }],
          submittedAt: "2026-08-27T00:00:01.000Z",
        },
      }],
    },
  },
} as unknown as NativeBuildObservability;
const verifierView = runnerUserFacingObservability(
  verifierSnapshot,
  { ...projectionWithoutHandoff, integrationRevision: "revision-current" },
);
assert.ok(
  verifierView.problems.some((problem) => problem.key === "verifier:repair"),
);
assert.doesNotMatch(JSON.stringify(verifierView), /Stale approval/);

const verifierSelectionView = runnerUserFacingObservability({
  ...verifierSnapshot,
  independentVerifier: {
    ...verifierSnapshot.independentVerifier,
    selection: {
      status: "required",
      reason: "No compatible independent verifier is available.",
      requiredCapabilities: ["code"],
      candidateRuntimeIds: ["google:verifier"],
    },
    review: { history: [] },
  },
}, { ...projectionWithoutHandoff, status: "paused" });
assert.ok(
  verifierSelectionView.problems.some(
    (problem) => problem.key === "verifier:selection",
  ),
);

const repairPauseView = runnerUserFacingObservability(observability, {
  ...projectionWithoutHandoff,
  status: "paused",
  repairCycles: {
    limit: 3,
    used: 3,
    extensions: 0,
    pause: {
      source: "verifier",
      targetRevision: "a".repeat(40),
      used: 3,
      limit: 3,
    },
  },
});
assert.equal(repairPauseView.lifecycle, "Repair budget exhausted");
assert.ok(
  repairPauseView.problems.some(
    (problem) =>
      problem.key === "repair-cycles:limit" &&
      problem.title === "Repair budget exhausted" &&
      problem.detail.includes("Runner used 3 of 3 repair plans"),
  ),
);

const replanView = runnerUserFacingObservability(observability, {
  ...projectionWithoutHandoff,
  guidance: {
    "replan-1": {
      requestId: "replan-1",
      taskId: "T1",
      blocking: true,
      question: "Replan requested.",
      evidenceSequence: 1,
      version: 1,
      status: "open",
      kind: "replan",
      replan: {
        reason: "scope_exceeded",
        summary: "The cache key factory lives outside this task.",
        proposedChange: "Split the task.",
      },
    },
  },
} as typeof projectionWithoutHandoff);
assert.ok(
  replanView.problems.some((problem) => problem.title === "Worker requested a replan"),
);

const pendingRiskMarkup = renderToStaticMarkup(
  createElement(IndependentVerifierManifest, {
    verifier: {
      ...verifierSnapshot.independentVerifier,
      risk: { history: [] },
      selection: undefined,
      review: { history: [] },
    } as unknown as NativeIndependentVerifierObservability,
    projection: projectionWithoutHandoff as unknown as NativeBuildProjection,
  }),
);
assert.match(pendingRiskMarkup, /Risk assessment pending/i);
assert.doesNotMatch(pendingRiskMarkup, /current low-risk revision/i);

const expectationsMarkup = renderToStaticMarkup(
  createElement(IndependentVerifierManifest, {
    verifier: verifierSnapshot.independentVerifier as unknown as NativeIndependentVerifierObservability,
    projection: projectionWithoutHandoff as unknown as NativeBuildProjection,
  }),
);
assert.match(expectationsMarkup, /Expectations recorded \(1 criteria\)/);
assert.match(expectationsMarkup, /src\/auth\/session\.ts:40-55/);
assert.match(expectationsMarkup, /<ol/);
assert.match(expectationsMarkup, /Sign in to two organizations/);
assert.match(expectationsMarkup, /Remove the membership in the first/);
assert.match(expectationsMarkup, /Observe the second session invalidated/);

const cooldownNow = 2_000;
assert.equal(runnerNextCooldownExpiry([{
  providerId: "chatgpt",
  status: "cooldown",
  consecutiveFailures: 1,
  cooldownUntil: cooldownNow + 500,
  updatedAt: cooldownNow - 100,
}, {
  providerId: "openai",
  status: "cooldown",
  consecutiveFailures: 2,
  cooldownUntil: cooldownNow + 100,
  updatedAt: cooldownNow - 50,
}, {
  providerId: "anthropic",
  status: "healthy",
  consecutiveFailures: 0,
  cooldownUntil: cooldownNow + 50,
  updatedAt: cooldownNow,
}], cooldownNow), cooldownNow + 100);
assert.equal(runnerNextCooldownExpiry([{
  providerId: "chatgpt",
  status: "cooldown",
  consecutiveFailures: 1,
  cooldownUntil: cooldownNow,
  updatedAt: cooldownNow - 100,
}, {
  providerId: "openai",
  status: "cooldown",
  consecutiveFailures: 1,
  updatedAt: cooldownNow - 50,
}], cooldownNow), null);
const activeCooldownObservability = {
  ...observability,
  providers: [{
    providerId: "chatgpt",
    status: "cooldown",
    consecutiveFailures: 1,
    cooldownUntil: cooldownNow + 1,
    updatedAt: cooldownNow - 100,
  }],
} as const;
const activeCooldownView = runnerUserFacingObservability(
  activeCooldownObservability,
  projectionWithoutHandoff,
  cooldownNow
);
assert.deepEqual(activeCooldownView.problems.map((problem) => problem.key), ["provider:chatgpt"]);
assert.equal(
  activeCooldownView.problems[0]?.detail,
  "Wait until the provider is available, then resume the build if it is paused."
);
assert.deepEqual(problemKeys({
  ...activeCooldownObservability,
  providers: [{
    ...activeCooldownObservability.providers[0],
    cooldownUntil: cooldownNow,
  }],
}, projectionWithoutHandoff, cooldownNow), []);

const currentWorkerView = runnerUserFacingObservability({
  ...observability,
  agents: [...observability.agents, {
    sessionId: "worker:run_1:T1:2",
    actor: { role: "worker", id: "worker_current" },
    status: "suspended",
    turns: 3,
    suspensionReason: "provider_error",
    lastSequence: 13,
  }],
}, {
  ...projection,
  tasks: {
    T1: {
      ...projection.tasks.T1,
      status: "running",
      attempt: 2,
      assignedWorkerId: "worker_current",
    },
  },
  projectHandoff: undefined,
});
assert.equal(currentWorkerView.problems.length, 1);
assert.equal(currentWorkerView.problems[0]?.key, "agent:worker:run_1:T1:2");
assert.equal(currentWorkerView.problems[0]?.title, "An active agent is paused");

const staleSubmittedWorkerView = runnerUserFacingObservability({
  ...observability,
  agents: [...observability.agents, {
    sessionId: "worker:run_1:T1:1:stale",
    actor: { role: "worker", id: "worker_submitted" },
    status: "suspended",
    turns: 2,
    suspensionReason: "model_ended_without_lifecycle",
    lastSequence: 9,
  }],
}, {
  ...projection,
  status: "running",
  tasks: {
    T1: {
      ...projection.tasks.T1,
      status: "submitted",
      assignedWorkerId: "worker_submitted",
    },
  },
  projectHandoff: undefined,
});
assert.deepEqual(staleSubmittedWorkerView.problems, []);

const browserScreenshotFact = {
  kind: "browser_screenshot",
  label: "internal screenshot evidence label",
  capturedAt: "2026-07-12T00:00:03.000Z",
  screenshotArtifactHash: "e".repeat(64),
  mediaType: "image/png",
  byteLength: 2_048,
} as const;
const browserEventsFact = {
  kind: "browser_events",
  label: "internal events evidence label",
  capturedAt: "2026-07-12T00:00:04.000Z",
  eventsArtifactHash: "f".repeat(64),
  consoleEventCount: 7,
  consoleErrorCount: 2,
  networkEventCount: 11,
  networkFailureCount: 1,
} as const;
const browserSnapshotFact = {
  kind: "browser_snapshot",
  label: "internal snapshot evidence label",
  url: "http://127.0.0.1:3000/discussion?id=demo",
  title: "AI Board",
  capturedAt: "2026-07-12T00:00:05.000Z",
  htmlArtifactHash: "0".repeat(64),
  htmlBytes: 4_096,
  truncated: false,
} as const;
const browserView = runnerUserFacingObservability({
  ...observability,
  evidence: [{
    id: "evidence_browser_screenshot",
    runId: "run_1",
    taskId: "T_BROWSER_SCREENSHOT",
    actor: { role: "worker", id: "worker_1" },
    status: "observed",
    fact: browserScreenshotFact,
    createdAt: "2026-07-12T00:00:03.000Z",
    idempotencyKey: "browser:screenshot",
  }, {
    id: "evidence_browser_events",
    runId: "run_1",
    taskId: "T_BROWSER_EVENTS",
    actor: { role: "worker", id: "worker_1" },
    status: "observed",
    fact: browserEventsFact,
    createdAt: "2026-07-12T00:00:04.000Z",
    idempotencyKey: "browser:events",
  }, {
    id: "evidence_browser_snapshot",
    runId: "run_1",
    taskId: "T_BROWSER_SNAPSHOT",
    actor: { role: "worker", id: "worker_1" },
    status: "observed",
    fact: browserSnapshotFact,
    createdAt: "2026-07-12T00:00:05.000Z",
    idempotencyKey: "browser:snapshot",
  }],
}, null);
assert.equal(browserView.verification.length, 3);
for (const item of browserView.verification) {
  assert.equal(item.status, "recorded");
  assert.equal(item.category, "Browser checks");
  assert.equal(item.detail, "Browser evidence recorded.");
  assert.ok(!item.detail.includes("internal"));
}
assert.equal(view.verification.find((item) => item.category === "Tests")?.detail, "Latest test result passed.");
assert.equal(
  runnerEvidenceDiagnosticDetail(browserScreenshotFact),
  "browser screenshot recorded · 2,048 bytes"
);
assert.equal(
  runnerEvidenceDiagnosticDetail(browserEventsFact),
  "browser events recorded · 2 console errors · 1 network failure"
);
assert.equal(
  runnerEvidenceDiagnosticDetail(browserSnapshotFact),
  "browser snapshot recorded · AI Board · http://127.0.0.1:3000/discussion?id=demo"
);

const panelSource = readFileSync(
  new URL("../components/RunnerV2ObservabilityPanel.tsx", import.meta.url),
  "utf8"
);
for (const copy of [
  "Build activity",
  "Progress",
  "Verification",
  "Acceptance contract",
  "Evidence submitted",
  "Architect verdict",
  "Independent verification",
  "Build risk",
  "Verifier verdict",
  "High-risk builds always require an independent verifier.",
  "Evidence is mechanical; Architect verdict is semantic.",
  "Problems requiring attention",
  "Repair budget exhausted",
  "Extend repair budget",
  "<details",
]) {
  assert.ok(panelSource.includes(copy), `expected panel source to contain ${copy}`);
}
const detailsMatch = panelSource.match(/<details[^>]*>/);
assert.ok(detailsMatch?.index !== undefined, "expected an Advanced diagnostics disclosure");
assert.ok(!/\bopen\b/.test(detailsMatch[0]), "expected Advanced diagnostics to be collapsed by default");
const detailsOpenIndex = detailsMatch.index;
const detailsCloseIndex = panelSource.indexOf("</details>", detailsOpenIndex);
assert.ok(detailsCloseIndex > detailsOpenIndex, "expected the Advanced diagnostics closing tag");
const diagnosticsSource = panelSource.slice(detailsOpenIndex, detailsCloseIndex);
assert.ok(diagnosticsSource.includes("Advanced diagnostics"));
for (const diagnosticCopy of [
  "Diagnostic overview",
  "Model calls",
  "Tool calls",
  "Tokens",
  "Search durable runner records",
  "Download audit",
  "Agent sessions",
  "Recent tools",
  "Evidence",
  "Context resources",
  "Provider health",
  "Recent events",
  "Architect guidance",
  "Integration queue and Git",
  "Background processes",
]) {
  assert.ok(
    diagnosticsSource.includes(diagnosticCopy),
    `expected ${diagnosticCopy} inside the Advanced diagnostics disclosure`
  );
}
for (const rawDiagnosticCopy of [
  "Diagnostic overview",
  "Agent sessions",
  "Recent tools",
  "Context resources",
  "Provider health",
  "Recent events",
  "Architect guidance",
  "Integration queue and Git",
  "Background processes",
]) {
  assert.ok(
    !panelSource.slice(0, detailsOpenIndex).includes(rawDiagnosticCopy),
    `expected ${rawDiagnosticCopy} not to appear before Advanced diagnostics`
  );
}
assert.match(
  diagnosticsSource,
  /<input[\s\S]*?type="search"[\s\S]*?aria-label="Search durable runner records"/,
  "expected diagnostics search to have a stable accessible name"
);

const panelComponentIndex = panelSource.indexOf("export function RunnerV2ObservabilityPanel");
const panelComponentSource = panelSource.slice(panelComponentIndex);
const nullReturnIndex = panelComponentSource.indexOf("if (!snapshot) return null");
const cooldownEffectIndex = panelComponentSource.indexOf("useEffect(() =>");
assert.ok(cooldownEffectIndex >= 0 && cooldownEffectIndex < nullReturnIndex, "expected cooldown effect before null return");
assert.ok(
  panelComponentSource.includes("runnerNextCooldownExpiry(snapshot?.providers ?? [], clock)"),
  "expected the component clock to select the next provider cooldown expiry"
);
assert.ok(panelComponentSource.includes("setTimeout("), "expected a one-shot cooldown expiry timer");
assert.ok(panelComponentSource.includes("clearTimeout("), "expected cooldown timer cleanup");
assert.ok(!panelComponentSource.includes("setInterval("), "expected no cooldown polling interval");
assert.ok(
  panelComponentSource.includes("runnerUserFacingObservability(snapshot, projection ?? null, clock)"),
  "expected the component clock to drive the user-facing projection"
);

const filtered = filterRunnerObservability({
  agents: [],
  tools: [{
    sequence: 1,
    sessionId: "worker:run_1:T1:1",
    callId: "read_1",
    toolName: "fs.read",
    status: "completed",
    occurredAt: "2026-07-12T00:00:00.000Z",
  }],
  evidence: [],
  memories: [],
  skills: [],
  processes: [],
  providers: [],
  events: [{
    sequence: 1,
    type: "task.transitioned",
    occurredAt: "2026-07-12T00:00:00.000Z",
    actor: { role: "runner", id: "scheduler" },
    payload: { taskId: "T1" },
  }],
}, "fs.read");
assert.equal(filtered.tools.length, 1);
assert.equal(filtered.events.length, 0);

const critiqueFailures: string[] = [];
function checkCritique(name: string, fn: () => void) {
  try {
    fn();
  } catch (error) {
    critiqueFailures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function criticBinding(sessionId: string) {
  return {
    runtimeId: "google:verifier",
    providerId: "google",
    modelId: "verifier",
    modelIdentity: "verifier-model",
    sessionId,
  };
}
function critiqueFinding(
  finding: Pick<NativePlanCritiqueFinding, "findingId" | "severity" | "claim"> &
    Partial<NativePlanCritiqueFinding>,
): NativePlanCritiqueFinding {
  return {
    category: "overlapping_scope",
    taskIds: finding.severity === "blocking" ? ["task-a", "task-b"] : ["task-e"],
    evidence: finding.severity === "blocking"
      ? ["task-a objective owns src/cache.ts", "task-b objective owns src/cache.ts"]
      : ["task-e criteria never mention empty input"],
    ...finding,
  };
}
function critiqueProjection(
  status: NativePlanCritiqueProjection["status"],
  findings: NativePlanCritiqueFinding[],
  extras: Partial<NativePlanCritiqueProjection> = {},
): NativePlanCritiqueProjection {
  const blockingFindingIds = findings
    .filter((finding) => finding.severity === "blocking")
    .map((finding) => finding.findingId);
  return {
    critiqueId: "critique-blocking",
    planRevision: 1,
    runtime: criticBinding("plan-critic:session-1"),
    excludedModels: [{
      source: "architect",
      runtimeId: "openai:architect",
      modelIdentity: "architect-model",
    }],
    status,
    requestedAt: "2026-09-02T00:00:00.000Z",
    ...(status === "requested" ? {} : {
      submittedAt: "2026-09-02T00:00:01.000Z",
      findings,
      blockingFindingIds,
    }),
    ...extras,
  };
}
function critiqueState(
  current: NativePlanCritiqueProjection | undefined,
  extras: Partial<NativePlanCritiqueState> = {},
): NativePlanCritiqueState {
  return {
    policy: { mode: "risk_based" },
    risk: {
      planRevision: 1,
      architectDeclaration: current?.status === "requested" ? "low" : "high",
      stricterQualification: false,
      assessment: {
        risk: extras.skipped ? "low" : "high",
        reasons: extras.skipped ? [] : [{ code: "task_count", evidence: ["tasks:5"] }],
      },
      assessedAt: "2026-09-02T00:00:00.000Z",
    },
    history: [],
    ...(current ? { current } : {}),
    ...extras,
  };
}
function critiquePanelProjection(
  planCritique?: NativePlanCritiqueState,
  planRiskDeclaration?: NativeBuildProjection["planRiskDeclaration"],
): NativeBuildProjection {
  const base = projection as unknown as NativeBuildProjection;
  return {
    ...base,
    status: "running",
    projectHandoff: undefined,
    tasks: {
      T1: { ...base.tasks.T1, status: "planned" },
    },
    ...(planCritique ? { planCritique } : {}),
    ...(planRiskDeclaration ? { planRiskDeclaration } : {}),
  };
}
function renderCritiquePanel(
  build: NativeBuildProjection,
  events: NativeBuildObservability["events"] = observability.events as unknown as NativeBuildObservability["events"],
): string {
  return renderToStaticMarkup(createElement(RunnerV2ObservabilityPanel, {
    snapshot: {
      ...(observability as unknown as NativeBuildObservability),
      events,
    },
    projection: build,
  }));
}
const blockingFinding = critiqueFinding({
  findingId: "F-1",
  severity: "blocking",
  claim: "A and B both own src/cache.ts.",
  criterionIds: [{ taskId: "task-a", criterionId: "criterion-overlap" }],
});
const advisoryFinding = critiqueFinding({
  findingId: "F-2",
  severity: "advisory",
  category: "missing_failure_mode",
  claim: "E ignores empty input.",
});
const secondAdvisoryFinding = critiqueFinding({
  findingId: "F-3",
  severity: "advisory",
  category: "unproven_assumption",
  claim: "E assumes the cache is warm.",
});
const secondBlockingFinding = critiqueFinding({
  findingId: "F-4",
  severity: "blocking",
  category: "missing_dependency",
  claim: "C never waits for A.",
  taskIds: ["task-c"],
  evidence: ["C dependencies are empty"],
});
const submittedBlocking = critiqueState(critiqueProjection("submitted", [blockingFinding]));
const submittedMarkup = renderCritiquePanel(
  critiquePanelProjection(submittedBlocking, {
    risk: "high",
    rationale: "The Architect declared overlapping file ownership.",
    source: "architect",
  }),
  [{
    sequence: 4,
    type: "plan_critique.submitted",
    occurredAt: "2026-09-02T00:00:01.000Z",
    actor: { role: "verifier", id: "google:verifier" },
    payload: { critiqueId: "critique-blocking" },
  }],
);
checkCritique("submitted blocking attention title", () => {
  assert.match(submittedMarkup, /Plan critique found blocking issues/);
});
checkCritique("submitted blocking attention key", () => {
  assert.match(submittedMarkup, /data-problem-key="plan-critique:blocking"/);
});
checkCritique("submitted blocking claim in detail", () => {
  assert.match(submittedMarkup, /A and B both own src\/cache\.ts\./);
});
checkCritique("submitted blocking reason label", () => {
  assert.match(submittedMarkup, /Resolving plan critique/);
});
checkCritique("submitted blocking summary", () => {
  assert.match(submittedMarkup, /Plan critique: submitted \(1 blocking, 0 advisory\)/);
});
checkCritique("submitted blocking findings list", () => {
  assert.match(submittedMarkup, /Plan critique findings/);
  assert.match(submittedMarkup, /blocking/);
  assert.match(submittedMarkup, /overlapping_scope/);
  assert.match(submittedMarkup, /task-a, task-b/);
  assert.match(submittedMarkup, /task-a objective owns src\/cache\.ts/);
  assert.match(submittedMarkup, /task-a:criterion-overlap/);
  assert.match(submittedMarkup, /critique-blocking/);
  assert.match(submittedMarkup, /plan-critic:session-1/);
  assert.match(submittedMarkup, /google:verifier/);
  assert.match(submittedMarkup, /architect-model/);
});
checkCritique("submitted blocking has no architect resolution yet", () => {
  assert.doesNotMatch(submittedMarkup, /Architect resolution/);
});
checkCritique("submitted blocking renders risk, declaration, policy, and audit event", () => {
  assert.match(submittedMarkup, /Plan risk: high/);
  assert.match(submittedMarkup, /The Architect declared overlapping file ownership\./);
  assert.match(submittedMarkup, /Risk source: architect/);
  assert.match(submittedMarkup, /Critique mode: risk_based/);
  assert.match(submittedMarkup, /Earlier critiques: 0/);
  assert.match(submittedMarkup, /Architect declared: high/);
  assert.match(submittedMarkup, /plan_critique\.submitted/);
});

const skippedState: NativePlanCritiqueState = critiqueState(undefined, {
  risk: {
    planRevision: 1,
    architectDeclaration: "low",
    stricterQualification: false,
    assessment: { risk: "low", reasons: [] },
    assessedAt: "2026-09-02T00:00:00.000Z",
  },
  skipped: { planRevision: 1, reason: "low_plan_risk", skippedAt: "2026-09-02T00:00:02.000Z" },
});
const skippedMarkup = renderCritiquePanel(critiquePanelProjection(skippedState, {
  risk: "low",
  rationale: "The plan is a routine change.",
  source: "legacy_default",
}));
checkCritique("skipped summary", () => {
  assert.match(skippedMarkup, /Plan critique: skipped \(low plan risk\)/);
});
checkCritique("skipped does not show blocking attention or resolution label", () => {
  assert.doesNotMatch(skippedMarkup, /Plan critique found blocking issues/);
  assert.doesNotMatch(skippedMarkup, /Resolving plan critique/);
  assert.doesNotMatch(skippedMarkup, /data-problem-key="plan-critique:blocking"/);
});
checkCritique("skipped renders low risk and legacy declaration", () => {
  assert.match(skippedMarkup, /Plan risk: low/);
  assert.match(skippedMarkup, /The plan is a routine change\./);
  assert.match(skippedMarkup, /Risk source: legacy_default/);
  assert.match(skippedMarkup, /Architect declared: low/);
  assert.match(skippedMarkup, /Earlier critiques: 0/);
});

const skippedDespiteRequest = critiqueState(
  critiqueProjection("requested", []),
  { skipped: { planRevision: 1, reason: "critic_failed", skippedAt: "2026-09-02T00:00:03.000Z" } },
);
const skippedDespiteRequestMarkup = renderCritiquePanel(critiquePanelProjection(skippedDespiteRequest));
checkCritique("skip wins over a lingering requested critique", () => {
  assert.match(skippedDespiteRequestMarkup, /Plan critique: skipped \(critic failed\)/);
  assert.doesNotMatch(skippedDespiteRequestMarkup, /Plan critique: requested/);
});

const resolvedFindings = [blockingFinding, advisoryFinding];
const resolvedState = critiqueState(critiqueProjection("resolved", resolvedFindings, {
  resolvedAt: "2026-09-02T00:00:04.000Z",
  resolution: {
    planRevisionAfter: 2,
    resolvedBy: "architect",
    resolutions: [
      { findingId: "F-1", resolution: "plan_reconciled", rationale: "B is folded into A." },
      { findingId: "F-2", resolution: "rejected", rationale: "Advisory resolution must stay hidden." },
    ],
  },
}), {
  history: [critiqueProjection("resolved", [], { critiqueId: "critique-superseded", supersededByCritiqueId: "critique-blocking" })],
});
const resolvedMarkup = renderCritiquePanel(critiquePanelProjection(resolvedState));
checkCritique("resolved summary counts", () => {
  assert.match(resolvedMarkup, /Plan critique: resolved \(1 blocking, 1 advisory\)/);
});
checkCritique("resolved blocking resolution is rendered", () => {
  assert.match(resolvedMarkup, /Architect resolution: plan_reconciled - B is folded into A\./);
});
checkCritique("resolved advisory resolution is not rendered", () => {
  assert.doesNotMatch(resolvedMarkup, /Advisory resolution must stay hidden\./);
});
checkCritique("resolved critique is not a blocking attention item", () => {
  assert.doesNotMatch(resolvedMarkup, /Plan critique found blocking issues/);
  assert.doesNotMatch(resolvedMarkup, /Resolving plan critique/);
  assert.doesNotMatch(resolvedMarkup, /data-problem-key="plan-critique:blocking"/);
});
checkCritique("resolved history count differs from an empty history", () => {
  assert.match(resolvedMarkup, /Earlier critiques: 1/);
});

const advisoryOnlyMarkup = renderCritiquePanel(critiquePanelProjection(
  critiqueState(critiqueProjection("submitted", [advisoryFinding, secondAdvisoryFinding])),
));
checkCritique("advisory-only submitted does not use the blocking attention or resolution label", () => {
  assert.match(advisoryOnlyMarkup, /Plan critique: submitted \(0 blocking, 2 advisory\)/);
  assert.doesNotMatch(advisoryOnlyMarkup, /Plan critique found blocking issues/);
  assert.doesNotMatch(advisoryOnlyMarkup, /Resolving plan critique/);
  assert.doesNotMatch(advisoryOnlyMarkup, /data-problem-key="plan-critique:blocking"/);
});

const twoBlockingMarkup = renderCritiquePanel(critiquePanelProjection(
  critiqueState(critiqueProjection("resolved", [blockingFinding, secondBlockingFinding], {
    resolution: {
      planRevisionAfter: 2,
      resolvedBy: "architect",
      resolutions: [
        { findingId: "F-1", resolution: "plan_reconciled", rationale: "B is folded into A." },
        { findingId: "F-4", resolution: "rejected", rationale: "C already depends on the shared module." },
      ],
    },
  })),
));
checkCritique("two blocking and zero advisory renders its own count", () => {
  assert.match(twoBlockingMarkup, /Plan critique: resolved \(2 blocking, 0 advisory\)/);
  assert.doesNotMatch(twoBlockingMarkup, /Plan critique: resolved \(0 blocking, 2 advisory\)/);
  assert.doesNotMatch(twoBlockingMarkup, /Plan critique: resolved \(1 blocking, 1 advisory\)/);
});
checkCritique("zero blocking and two advisory renders its own count", () => {
  assert.match(advisoryOnlyMarkup, /Plan critique: submitted \(0 blocking, 2 advisory\)/);
  const zeroBlockingResolved = renderCritiquePanel(critiquePanelProjection(
    critiqueState(critiqueProjection("resolved", [advisoryFinding, secondAdvisoryFinding], {
      resolution: {
        planRevisionAfter: 1,
        resolvedBy: "runner",
        resolutions: [],
      },
    })),
  ));
  assert.match(zeroBlockingResolved, /Plan critique: resolved \(0 blocking, 2 advisory\)/);
  assert.doesNotMatch(zeroBlockingResolved, /Plan critique: resolved \(2 blocking, 0 advisory\)/);
  assert.doesNotMatch(zeroBlockingResolved, /Plan critique found blocking issues/);
});

const requestedMarkup = renderCritiquePanel(critiquePanelProjection(
  critiqueState(critiqueProjection("requested", [])),
));
checkCritique("requested summary", () => {
  assert.match(requestedMarkup, /Plan critique: requested/);
  assert.doesNotMatch(requestedMarkup, /Plan critique findings/);
  assert.doesNotMatch(requestedMarkup, /Plan critique found blocking issues/);
  assert.doesNotMatch(requestedMarkup, /Resolving plan critique/);
});

const zeroFindingsMarkup = renderCritiquePanel(critiquePanelProjection(
  critiqueState(critiqueProjection("submitted", [])),
));
checkCritique("zero findings renders a count and no findings list or attention", () => {
  assert.match(zeroFindingsMarkup, /Plan critique: submitted \(0 blocking, 0 advisory\)/);
  assert.doesNotMatch(zeroFindingsMarkup, /Plan critique findings/);
  assert.doesNotMatch(zeroFindingsMarkup, /Plan critique found blocking issues/);
  assert.doesNotMatch(zeroFindingsMarkup, /Resolving plan critique/);
});

const absentMarkup = renderCritiquePanel(critiquePanelProjection());
checkCritique("absent plan critique renders without a stale critique line", () => {
  assert.match(absentMarkup, /Build activity/);
  assert.match(absentMarkup, /Ready to start/);
  assert.doesNotMatch(absentMarkup, /Plan critique/);
  assert.doesNotMatch(absentMarkup, /Plan risk:/);
  assert.doesNotMatch(absentMarkup, /Critique mode:/);
  assert.doesNotMatch(absentMarkup, /Earlier critiques:/);
  assert.doesNotMatch(absentMarkup, /Resolving plan critique/);
  assert.doesNotMatch(absentMarkup, /Architect resolution/);
  assert.doesNotMatch(absentMarkup, /data-problem-key="plan-critique:blocking"/);
});

const declarationOnlyMarkup = renderCritiquePanel(critiquePanelProjection(undefined, {
  risk: "high",
  rationale: "The Architect declared high risk.",
  source: "architect",
}));
checkCritique("declaration without an assessed critique still renders plan risk", () => {
  assert.match(declarationOnlyMarkup, /Plan risk: high/);
  assert.match(declarationOnlyMarkup, /The Architect declared high risk\./);
  assert.match(declarationOnlyMarkup, /Risk source: architect/);
  assert.doesNotMatch(declarationOnlyMarkup, /Plan critique:/);
});

const assessmentOnlyMarkup = renderCritiquePanel(critiquePanelProjection(
  critiqueState(critiqueProjection("requested", [])),
));
checkCritique("assessed risk renders without a declaration", () => {
  assert.match(assessmentOnlyMarkup, /Plan risk: high/);
  assert.doesNotMatch(assessmentOnlyMarkup, /Risk source:/);
});

const assessmentWinsMarkup = renderCritiquePanel(critiquePanelProjection(
  critiqueState(undefined, {
    risk: {
      planRevision: 1,
      architectDeclaration: "low",
      stricterQualification: false,
      assessment: { risk: "low", reasons: [] },
      assessedAt: "2026-09-02T00:00:00.000Z",
    },
    skipped: { planRevision: 1, reason: "low_plan_risk", skippedAt: "2026-09-02T00:00:02.000Z" },
  }),
  { risk: "high", rationale: "Stale declaration.", source: "architect" },
));
checkCritique("assessed risk wins over a conflicting declaration", () => {
  assert.match(assessmentWinsMarkup, /Plan risk: low/);
  assert.doesNotMatch(assessmentWinsMarkup, /Plan risk: high/);
});

if (critiqueFailures.length > 0) {
  console.error(critiqueFailures.join("\n"));
  throw new Error(`${critiqueFailures.length} plan critique UI assertions failed`);
}

const recordingProjection: NativeBuildProjection = {
  ...critiquePanelProjection(),
  status: "paused",
  pauseReason: { reason: "context_recording_failed" },
  projectHandoff: undefined,
  repairCycles: undefined,
  verifierSelection: undefined,
  acceptanceContractStatus: undefined,
  contextRecording: {
    notes: [{
      sequence: 4,
      purpose: "worker:task",
      attempts: 3,
      reason: "Context manifest recording failed after 3 attempts.",
      resolution: {
        sequence: 5,
        resolution: "proceed_without_manifest" as const,
        rationale: "The manifest is optional here.",
      },
    }],
    waiver: { sequence: 5, rationale: "The manifest is optional here." },
  },
};
const recordingMarkup = renderCritiquePanel(recordingProjection);
assert.match(recordingMarkup, /Context manifest: worker:task/);
assert.match(recordingMarkup, /Attempts: 3/);
assert.match(recordingMarkup, /Reason: Context manifest recording failed after 3 attempts\./);
assert.match(recordingMarkup, /Resolution: proceed_without_manifest/);
assert.match(recordingMarkup, /Rationale: The manifest is optional here\./);
assert.match(recordingMarkup, /Recording suspended/);
assert.match(recordingMarkup, /Context recording needs a decision/);
const recordingLines = renderToStaticMarkup(createElement(ContextRecordingLines, {
  projection: recordingProjection,
}));
assert.match(recordingLines, /Recording suspended/);

console.log("PASS Runner V2 observability panel");

const authorizedDestructiveRecovery = {
  ...executionSafetySnapshot,
  executionSafety: {
    ...executionSafetySnapshot.executionSafety,
    fullBypass: false,
    isolation: { ...executionSafetySnapshot.executionSafety.isolation, status: "write_confinement_exact_grant" },
    processes: [],
    recovery: [{
      ...executionSafetySnapshot.executionSafety.recovery[0],
      state: "authorized", reason: "user_approved",
    }],
  },
} as NativeBuildObservability;
assert.deepEqual(problemKeys(authorizedDestructiveRecovery, projectionWithoutHandoff), [
  "execution-safety:recovery:proposal-1",
]);
