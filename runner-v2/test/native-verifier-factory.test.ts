import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import type { AgentSessionProjection } from "../src/agent-session-store.js";
import {
  buildNativeVerifierInspectionRequest,
  buildPlanCritiqueRequest,
  deriveNativeVerifierRiskInput,
  runBaselineRevision,
} from "../src/native-build-factory.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import { assessBuildRisk } from "../src/risk-policy.js";
import type {
  SchedulerEvent,
  SchedulerProjection,
} from "../src/scheduler-store.js";
import type { ToolLedgerEvent } from "../src/tool-ledger.js";
import { captureGitBaseline, NativeBuildFactory } from "./support/git-fixture.js";

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
    schedulerEvents,
    twoPass: true,
    risk,
    preferredRuntimeId: "fallback:verifier",
    providerRetryDeadlineMs: 42_000,
  });

  assert.equal(request.targetRevision, REVISION);
  assert.equal(request.twoPass, true);
  assert.equal(request.baselineRevision, REVISION);
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

test("runBaselineRevision keeps the first advanced previous revision and rejects an unknown baseline", () => {
  const baseline = "b".repeat(40);
  const later = "c".repeat(40);
  const projection = { integrationRevision: REVISION } as SchedulerProjection;
  const advanced = (previous: string, sequence: number): SchedulerEvent => ({
    eventId: `event-${sequence}`,
    runId: "run-factory-verifier",
    sequence,
    type: "integration.revision_advanced",
    occurredAt: "2026-08-27T00:00:00.000Z",
    actor: { role: "runner", id: "integration-manager" },
    idempotencyKey: `integration:${sequence}`,
    payload: {
      integrationRevision: sequence === 1 ? baseline : later,
      previousIntegrationRevision: previous,
    },
  });
  assert.equal(
    runBaselineRevision([advanced(baseline, 1), advanced(later, 2)], projection),
    baseline,
  );
  assert.equal(runBaselineRevision([], projection), REVISION);
  assert.equal(
    runBaselineRevision([advanced("   ", 1)], projection),
    REVISION,
  );
  assert.throws(
    () => runBaselineRevision([], {} as SchedulerProjection),
    /Run baseline revision is unknown/,
  );
});

test("buildPlanCritiqueRequest maps live ordinary tasks and verifier-shaped guidance", () => {
  const projection = verifierProjection();
  const request = buildPlanCritiqueRequest({
    runId: "run-factory-verifier",
    objective: "Build the requested application robustly.",
    architectRuntimeId: "openai:architect",
    projection,
    baselineRevision: REVISION,
    riskReasons: [{ code: "task_count", evidence: ["tasks:5"] }],
    preferredRuntimeId: "fallback:verifier",
    providerRetryDeadlineMs: 42_000,
  });
  assert.equal(request.planRevision, 1);
  assert.equal(request.baselineRevision, REVISION);
  assert.equal(request.architectRuntimeId, "openai:architect");
  assert.deepEqual(request.tasks.map((task) => task.id), ["task-api"]);
  assert.equal(request.tasks.some((task) => task.id === "task-cancelled" || task.kind === "final_verification"), false);
  assert.deepEqual(request.guidance.map((guidance) => [
    guidance.id,
    guidance.kind,
    guidance.text,
  ]), [
    ["architect-question", "architect_answer", "Use the approved data model."],
    ["user-guidance", "user_guidance", "Preserve backward compatibility."],
    ["worker-guidance", "architect_answer", "Keep the API stable."],
  ]);
  assert.equal(request.preferredRuntimeId, "fallback:verifier");
  assert.equal(request.providerRetryDeadlineMs, 42_000);
  assert.deepEqual(request.riskReasons, [{ code: "task_count", evidence: ["tasks:5"] }]);
});

test("a submitted critique leaves no verifier-workspaces/<run> directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-plan-critique-factory-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "README.md"), "fixture\n");
  const runId = "run_critique_cleanup";
  const architectTurns: ModelTurn[] = [{
    blocks: [{
      type: "tool_call",
      callId: "plan",
      name: "plan_tasks",
      arguments: {
        revision: 1,
        tasks: [{
          id: "A",
          objective: "Implement A",
          dependencies: [],
          requiredCapabilities: ["code"],
          acceptanceCriteria: [{ id: "done", text: "A works." }],
        }],
        riskDeclaration: { risk: "low", rationale: "routine" },
      },
    }],
    stopReason: "tool_calls",
  }, {
    blocks: [{ type: "text", text: "Plan submitted." }],
    stopReason: "end_turn",
  }];
  const criticTurns: ModelTurn[] = [{
    blocks: [{
      type: "tool_call",
      callId: "critique",
      name: "submit_plan_critique",
      arguments: { findings: [] },
    }],
    stopReason: "tool_calls",
  }, {
    blocks: [{ type: "text", text: "Critique submitted." }],
    stopReason: "end_turn",
  }];
  const architectModel = new ScriptedFactoryModel(architectTurns);
  const criticModel = new ScriptedFactoryModel(criticTurns);
  let factory: NativeBuildFactory | undefined;
  let handle: Awaited<ReturnType<NativeBuildFactory["create"]>> | undefined;
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId,
    });
    factory = new NativeBuildFactory({
      projectRoot: project,
      stateDirectory: state,
      providerConfigs: {
        load: () => [
          factoryProvider("openai:architect"),
          factoryProvider("google:verifier"),
        ],
        save: () => undefined,
        close: () => undefined,
      },
      baselineFor: () => baseline.revision,
      providerModelFactory: (config) =>
        config.runtimeId === "openai:architect" ? architectModel : criticModel,
    });
    handle = await factory.create(await factory.prepareSpec({
      version: 2,
      runId,
      projectId: "fixture-project",
      objective: "Build the requested application.",
      architectRuntimeId: "openai:architect",
      workerRuntimeIds: ["openai:architect"],
      verifierRuntimeIds: ["google:verifier"],
      alwaysRequireIndependentVerifier: false,
      maxConcurrency: 1,
      permissionProfile: "full",
      runPolicy: "finish",
      planCritique: "always",
      budgetLimits: {},
      createdAt: "2026-09-02T00:00:00.000Z",
      idempotencyKey: "critique-cleanup",
    }));
    const actions: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const step = await handle.runtime.step();
      actions.push(step.action ?? step.status);
      if (step.action === "plan_critique_resolved_by_runner" || step.status === "paused") break;
    }
    assert.equal(actions.includes("plan_critique_submitted"), true, actions.join(","));
    assert.equal(actions.includes("plan_critique_resolved_by_runner"), true, actions.join(","));
    const workspace = independentVerifierWorkspaceDir(state, runId);
    assert.equal(existsSync(workspace), false, workspace);
    assert.equal(existsSync(`${workspace}.metadata.json`), false);
  } finally {
    await handle?.close();
    await factory?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("factory includes the current Architect risk declaration in kernel qualification", () => {
  const projection = verifierProjection();
  const current = projection.finalVerification!.current!;
  current.review = {
    reviewId: "final-review",
    submissionId: "final-submission",
    generationId: current.generationId,
    targetRevision: current.targetRevision,
    attempt: 1,
    status: "approved",
    decision: {
      decision: "approved",
      summary: "The evidence is green but the semantic boundary is high risk.",
      targetRevision: current.targetRevision,
      architectRisk: {
        risk: "high",
        rationale: "The change crosses an authentication trust boundary.",
        source: "architect",
      },
      categoryReviews: [],
      failedCategories: [],
    },
  };
  projection.tasks["task-api"]!.objective = "Implement a card component";
  const sessions = verifierSessions();
  sessions[0]!.changeSet!.changedPaths = ["src/components/card.tsx"];

  const input = deriveNativeVerifierRiskInput({
    projection,
    sessions,
    schedulerEvents: [],
    toolEvents: [],
    stricterQualification: false,
  });
  assert.equal(input.architectDeclaration, "high");
  assert.equal(assessBuildRisk(input).risk, "high");
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

function independentVerifierWorkspaceDir(stateDirectory: string, runId: string): string {
  const readable =
    runId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 12) || "run";
  return join(
    stateDirectory,
    "verifier-workspaces",
    `${readable}-${createHash("sha256").update(runId).digest("hex").slice(0, 10)}`,
  );
}

function factoryProvider(runtimeId: string): RunnerProviderConfig {
  const [providerId, modelId] = runtimeId.split(":");
  return {
    runtimeId,
    providerId: providerId ?? "fixture",
    modelId: modelId ?? "model",
    transport: "openai-compatible",
    baseUrl: "http://127.0.0.1:9",
    secret: "unused",
    capabilities: ["code"],
    priority: runtimeId.includes("architect") ? 1 : 2,
  };
}

class ScriptedFactoryModel implements AgentModel {
  constructor(private readonly turns: Array<ModelTurn | Error>) {}

  async complete(_request: AgentModelRequest): Promise<ModelTurn> {
    const turn = this.turns.shift();
    if (!turn) throw new Error("script exhausted");
    if (turn instanceof Error) throw turn;
    return {
      ...turn,
      usage: turn.usage ?? { inputTokens: 8, outputTokens: 4 },
    };
  }
}
