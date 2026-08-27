import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSessionProjection } from "../src/agent-session-store.js";
import {
  buildNativeVerifierInspectionRequest,
  deriveNativeVerifierRiskInput,
} from "../src/native-build-factory.js";
import { assessBuildRisk } from "../src/risk-policy.js";
import type {
  SchedulerEvent,
  SchedulerProjection,
} from "../src/scheduler-store.js";
import type { ToolLedgerEvent } from "../src/tool-ledger.js";

const REVISION = "a".repeat(40);
const HASH = "b".repeat(64);

test("factory derives conservative risk and complete verifier context from durable accepted state", () => {
  const projection = verifierProjection();
  const sessions = verifierSessions();
  const schedulerEvents = [{
    eventId: "event-conflict",
    runId: "run-factory-verifier",
    sequence: 1,
    type: "task.transitioned",
    occurredAt: "2026-08-27T00:00:00.000Z",
    actor: { role: "runner", id: "integration-manager" },
    idempotencyKey: "conflict",
    payload: { taskId: "task-api", status: "integration_resolution" },
  }] satisfies SchedulerEvent[];
  const toolEvents = [{
    sequence: 1,
    key: "tool-risk",
    type: "tool.started",
    fingerprint: "fingerprint",
    occurredAt: "2026-08-27T00:00:00.000Z",
    runId: "run-factory-verifier",
    sessionId: "worker-session",
    callId: "external-write",
    toolName: "external.write",
    effect: "external",
    access: {
      capability: "external.write",
      external: true,
      destructive: true,
      credentialChange: true,
    },
    outsideWorkspace: true,
  }] satisfies ToolLedgerEvent[];

  const input = deriveNativeVerifierRiskInput({
    projection,
    sessions,
    schedulerEvents,
    toolEvents,
    stricterQualification: false,
  });
  assert.deepEqual(input, {
    architectDeclaration: "low",
    stricterQualification: false,
    kernelFacts: {
      destructiveEffects: true,
      credentialEffects: true,
      externalWriteEffects: true,
      integrationConflict: true,
      changedPaths: ["src/auth/session.ts"],
    },
  });

  const risk = {
    targetRevision: REVISION,
    input,
    assessment: assessBuildRisk(input),
    state: "current" as const,
    assessedAt: "2026-08-27T00:00:01.000Z",
  };
  const request = buildNativeVerifierInspectionRequest({
    runId: "run-factory-verifier",
    objective: "Build the requested application robustly.",
    architectRuntimeId: "openai:architect",
    projection,
    sessions,
    risk,
    preferredRuntimeId: "fallback:verifier",
    providerRetryDeadlineMs: 42_000,
  });

  assert.equal(request.targetRevision, REVISION);
  assert.equal(request.preferredRuntimeId, "fallback:verifier");
  assert.equal(request.providerRetryDeadlineMs, 42_000);
  assert.deepEqual(request.criteria.map((item) => [
    item.taskId,
    item.taskTitle,
    item.criterion.id,
  ]), [["task-api", "Implement the API", "api-behavior"]]);
  assert.deepEqual(request.reviews.map((review) => [
    review.taskId,
    review.attempt,
    review.status,
  ]), [["task-api", 1, "approved"]]);
  assert.deepEqual(request.guidance.map((guidance) => [
    guidance.id,
    guidance.kind,
    guidance.text,
  ]), [
    ["architect-question", "architect_answer", "Use the approved data model."],
    ["user-guidance", "user_guidance", "Preserve backward compatibility."],
    ["worker-guidance", "architect_answer", "Keep the API stable."],
  ]);
  assert.deepEqual(request.changes.map((change) => [
    change.changeSetId,
    change.authorRuntimeId,
    change.changedPaths,
  ]), [["change-accepted", "anthropic:worker", ["src/auth/session.ts"]]]);
  assert.equal(request.finalVerification.generationId, "final-generation");
  assert.equal(request.finalVerification.green, true);
  assert.deepEqual(request.riskReasons, risk.assessment.reasons);
});

function verifierProjection(): SchedulerProjection {
  return {
    runId: "run-factory-verifier",
    initialObjective: "Build the requested application robustly.",
    status: "running",
    acceptanceContractStatus: "current",
    planRevision: 1,
    tasks: {
      "task-api": {
        id: "task-api",
        objective: "Implement the API",
        dependencies: [],
        status: "integrated",
        requiredCapabilities: ["code"],
        acceptanceCriteria: [{
          id: "api-behavior",
          text: "The API implements the requested behavior.",
        }],
        acceptanceCriteriaVersion: 1,
        attempt: 1,
        changeSetId: "change-accepted",
        integrationRevision: REVISION,
      },
      "task-cancelled": {
        id: "task-cancelled",
        objective: "Discarded work",
        dependencies: [],
        status: "cancelled",
        requiredCapabilities: ["code"],
        acceptanceCriteria: [{ id: "discarded", text: "Discarded." }],
        acceptanceCriteriaVersion: 1,
        attempt: 1,
        changeSetId: "change-ignored",
      },
      "final-verification": {
        id: "final-verification",
        kind: "final_verification",
        objective: "Verify the integration revision.",
        dependencies: [],
        status: "integrated",
        requiredCapabilities: ["verification"],
        attempt: 1,
        generationId: "final-generation",
        targetRevision: REVISION,
        planVersion: 1,
        verificationPlan: { checks: [] },
      },
    },
    guidance: {
      "worker-guidance": {
        requestId: "worker-guidance",
        taskId: "task-api",
        blocking: true,
        question: "Should the API change?",
        evidenceSequence: 1,
        version: 1,
        status: "answered",
        answer: "Keep the API stable.",
      },
    },
    userGuidance: {
      "user-guidance": {
        guidanceId: "user-guidance",
        text: "Preserve backward compatibility.",
        version: 1,
        status: "acknowledged",
        interruptionStatus: "completed",
      },
    },
    userGuidanceVersion: 1,
    architectQuestions: {
      "architect-question": {
        questionId: "architect-question",
        question: "Which data model?",
        version: 1,
        status: "answered",
        answer: "Use the approved data model.",
      },
    },
    architectQuestionVersion: 1,
    reviews: {
      "task-api": {
        taskId: "task-api",
        attempt: 1,
        status: "approved",
        summary: "The API task is accepted.",
        evidenceArtifactHashes: [HASH],
        criterionVerdicts: [{
          criterionId: "api-behavior",
          verdict: "satisfied",
          rationale: "Current evidence supports the behavior.",
          evidenceIds: ["evidence-api"],
        }],
      },
    },
    runtime: {
      providerHealth: {},
      workerAssignments: {},
      architect: { runtimeId: "openai:architect" },
    },
    integrationRevision: REVISION,
    finalVerification: {
      current: {
        taskId: "final-verification",
        generationId: "final-generation",
        targetRevision: REVISION,
        planVersion: 1,
        plan: { checks: [] },
        executionProfile: {} as never,
        state: "current",
        submissionResult: {
          kind: "final_verification_submission",
          runId: "run-factory-verifier",
          taskId: "final-verification",
          generationId: "final-generation",
          targetRevision: REVISION,
          attempt: 1,
          plan: { checks: [] },
          executionProfile: {} as never,
          checks: [],
          green: true,
          evidenceIds: [],
          submittedAt: "2026-08-27T00:00:01.000Z",
        },
      },
      history: [],
    },
    lastSequence: 1,
  };
}

function verifierSessions(): AgentSessionProjection[] {
  return [
    {
      sessionId: "accepted-session",
      runId: "run-factory-verifier",
      actor: { role: "worker", id: "anthropic:worker" },
      status: "completed",
      changeSetId: "change-accepted",
      changeSet: {
        id: "change-accepted",
        runId: "run-factory-verifier",
        taskId: "task-api",
        baselineRevision: "c".repeat(40),
        taskRevision: REVISION,
        commits: [REVISION],
        changedPaths: ["src/auth/session.ts"],
        diffArtifactHash: HASH,
        evidenceArtifactHashes: [HASH],
        externalEffects: [],
        guidanceIds: [],
        memoryIds: [],
        unresolvedConcerns: [],
      },
      lastSequence: 1,
    },
    {
      sessionId: "ignored-session",
      runId: "run-factory-verifier",
      actor: { role: "worker", id: "openai:worker" },
      status: "completed",
      changeSetId: "change-ignored",
      changeSet: {
        id: "change-ignored",
        runId: "run-factory-verifier",
        taskId: "task-cancelled",
        baselineRevision: "c".repeat(40),
        taskRevision: REVISION,
        commits: [REVISION],
        changedPaths: ["package-lock.json"],
        diffArtifactHash: HASH,
        evidenceArtifactHashes: [HASH],
        externalEffects: [{ kind: "external_write", idempotencyKey: "ignored" }],
        guidanceIds: [],
        memoryIds: [],
        unresolvedConcerns: [],
      },
      lastSequence: 1,
    },
  ];
}
