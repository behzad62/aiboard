import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentModel, AgentModelRequest } from "../../src/agent-contracts.js";
import { ArtifactStore } from "../../src/artifact-store.js";
import { BuildRuntime, type ArchitectRuntimeDriver, type ProjectDocsPort, type StopNotesDriver } from "../../src/build-runtime.js";
import type { NativeBuildSpec } from "../../src/build-spec.js";
import type { RunnerProviderConfig } from "../../src/provider-config-store.js";
import { createExecutionHost } from "../../src/execution-host.js";
import {
  assertProjectHandoffSelectionAccepted,
  currentExplicitStartIdentity,
  handoffSnapshotAtCurrentStop,
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
  type ProjectHandoffChoice,
  type SchedulerActorRole,
  type SchedulerProjection,
} from "../../src/scheduler-store.js";
import { buildSourceManifest } from "../../src/source-manifest.js";
import { verifyHandoffSnapshotDigest } from "../../src/handoff-snapshot.js";
import { IntegrationManager as ProductionIntegrationManager } from "../../src/integration-manager.js";
import type { ProjectHandoffResult } from "../../src/integration-manager.js";
import {
  buildExecutionPlanRevision,
  T1A_SEEDED_HOST_PLANNING_CAPABILITIES,
  type CoverageReview,
  type ExecutionPlanPhase,
  type ExecutionTaskContract,
  type SourceRequirement,
} from "../../src/planning-contracts.js";
import { SqliteSchedulerStore } from "../../src/sqlite-scheduler-store.js";
import { SqliteEvidenceStore } from "../../src/sqlite-evidence-store.js";
import type { FinalVerificationPlan } from "../../src/final-verification-contracts.js";
import { assessBuildRisk, type BuildRiskAssessmentInput } from "../../src/risk-policy.js";
import { snapshotNativeBuildAmbientEnvironment } from "../../src/native-build-factory.js";
import { NativeBuildFactory, captureGitBaseline, runGit, IntegrationManager as FixtureIntegrationManager } from "./git-fixture.js";
import {
  acceptFinalVerificationProfile,
  emptyFinalVerificationProfile,
} from "./final-verification-profile.js";
import type { EvidenceStore } from "../../src/evidence-store.js";
import type { ValidationScope } from "../../src/validation-scope.js";
import type { IndependentVerifierDriver } from "../../src/build-runtime.js";

/**
 * TX-2 fast handoff harness. A test reaches the kernel handoff snapshot
 * commit without a worker, review or integration pump: a real temp git
 * repository, the docs port that NativeBuildFactory builds (read off a
 * factory-built runtime, never hand-built), a real SQLite scheduler log
 * seeded up to the handoff stop (the `project.handoff_requested` event is
 * seeded directly, exactly as the Architect's `complete_run` records it),
 * and the runtime's real snapshot step driven directly through
 * `BuildRuntime.step()` / `runUntilBlocked()`.
 *
 * The architect driver throws on any call, so a harness test that reaches
 * its assertions proves the snapshot path makes no model call.
 */

export const CLOCK = "2026-09-25T00:00:00.000Z";
export const SOURCE_TEXT = "SECTION 1: MANDATORY. The value module must export the value 2.";
export const COMPLETION_SUMMARY = "The plan is ready for handoff. Notes for the next tool: keep the value module as is.";

// Objective shared by factory-port recovery specs and the seeds they recover:
// the recorded run.initialized objective must equal the spec objective.
export const FACTORY_PORT_OBJECTIVE = "Prove the factory-wired docs port.";

export function scenario() {
  const manifest = buildSourceManifest(Buffer.from(SOURCE_TEXT, "utf-8"), [{ id: "s1", startByte: 0, endByte: Buffer.byteLength(SOURCE_TEXT) }], {
    manifestId: "manifest_value",
    sourceId: "source_value",
    mediaType: "text/plain",
    encoding: "utf-8",
    authority: "owner",
    createdAt: "2026-09-24T00:00:00.000Z",
  });
  const requirements: SourceRequirement[] = [{
    id: "REQ-1",
    reference: { sourceId: manifest.sourceId, sectionIds: ["s1"] },
    purpose: "Export the value 2.",
    observableOutcome: "The value module exports 2.",
    obligationKind: "mandatory",
    applicability: { status: "applicable" },
    accountablePhaseId: "P1",
    contributingTaskIds: ["T1"],
    acceptanceConditions: [{ id: "REQ-1-ac1", description: "value is 2.", responsibleGateId: "P1-exit", requiredEvidenceKinds: ["command"] }],
  }];
  const phases: ExecutionPlanPhase[] = [{
    id: "P1",
    purpose: "Deliver the value module.",
    requirementIds: ["REQ-1"],
    scope: { includes: ["src/value.mjs"], excludes: ["docs/project/STATE.md"] },
    entryConditions: ["Plan ready."],
    contributingTaskIds: ["T1"],
    exitCriteria: ["The value module is accepted."],
    requiredCombinedValidation: ["tests"],
    exitUnlocks: ["final verification"],
  }];
  const tasks: ExecutionTaskContract[] = [{
    id: "T1",
    lineage: [],
    accountablePhaseId: "P1",
    requirementIds: ["REQ-1"],
    outcome: { user: "Create src/value.mjs exporting value = 2.", system: "The value module exports 2." },
    scope: { includes: ["src/value.mjs"], excludes: ["test/value.test.mjs"] },
    writableSurfaces: ["src/value.mjs"],
    forbiddenSurfaces: ["test/value.mjs"],
    dependencies: [],
    requiredBase: "accepted plan revision revision_value",
    inputs: ["accepted plan revision"],
    outputs: ["src/value.mjs"],
    steps: ["Write the module.", "Run the tests."],
    acceptance: { criteria: [{ id: "c1", text: "src/value.mjs exports value = 2 and the tests pass." }], definitionOfDone: "Tests pass." },
    validation: { targetedRationale: "The value test.", affectedScopeRationale: "The module only." },
    negativeProofApplicability: { applicable: false, rationale: "A new module has no prior-incorrect case." },
    reviewCriteria: ["Independent review confirms the value."],
    integrationChecks: ["Post-integration tests."],
    cleanup: { cleanup: "None.", recovery: "Retry.", rollback: "Revert." },
    requirementCriteriaMap: [{ taskLocalCriterionId: "c1", requirementId: "REQ-1" }],
  }];
  const revision = buildExecutionPlanRevision({
    revisionId: "revision_value",
    runId: "run-c2a",
    sourceManifestId: manifest.manifestId,
    sourceManifestDigest: manifest.artifactDigest,
    requirements,
    tasks,
    phases,
    workflowPolicyVersion: 1,
    planningDecisions: [],
    validationObligations: ["tests"],
    createdAt: "2026-09-24T00:00:00.000Z",
  });
  const coverageReview: CoverageReview = {
    id: "coverage_value",
    runId: "run-c2a",
    reviewerRuntimeId: "reviewer:distinct-model",
    independence: "distinct_model",
    sourceReadManifestId: manifest.manifestId,
    planRevisionId: revision.revisionId,
    planRevisionDigest: revision.digest,
    derivedObligations: [{ id: "obl-REQ-1", requirementId: "REQ-1", description: "Export 2.", recordedBeforePlanOrDiffProvided: true, recordedAt: "2026-09-24T00:05:00.000Z" }],
    obligationVerdicts: [{ obligationId: "obl-REQ-1", verdict: "covered", severity: "advisory", rationale: "T1 covers it.", evidenceRefs: ["ledger:REQ-1"] }],
    findings: [],
    recordedAt: "2026-09-24T00:10:00.000Z",
  };
  return { manifest, requirements, phases, revision, coverageReview };
}

export function seedEvent(
  runId: string,
  type: string,
  key: string,
  role: SchedulerActorRole,
  id: string,
  payload: Record<string, unknown>,
): NewSchedulerEvent {
  return {
    runId,
    type: type as NewSchedulerEvent["type"],
    occurredAt: CLOCK,
    actor: { role, id },
    idempotencyKey: key,
    payload,
  };
}

export function lowRiskSeed(runId: string, baselineRevision: string, key = "risk:baseline-low"): NewSchedulerEvent[] {
  const input: BuildRiskAssessmentInput = {
    architectDeclaration: "low",
    stricterQualification: false,
    kernelFacts: {
      destructiveEffects: false,
      credentialEffects: false,
      externalWriteEffects: false,
      integrationConflict: false,
      changedPaths: ["docs/project/STATE.md"],
    },
  };
  return [seedEvent(runId, "build.risk_assessed", key, "runner", "build-manager", {
    targetRevision: baselineRevision,
    input,
    assessment: assessBuildRisk(input),
  })];
}

export function v2PlanOnlySeed(runId: string, objective = FACTORY_PORT_OBJECTIVE): NewSchedulerEvent[] {
  const { manifest, requirements, phases, revision, coverageReview } = scenario();
  const e = (
    type: string,
    key: string,
    role: SchedulerActorRole,
    id: string,
    payload: Record<string, unknown>,
  ): NewSchedulerEvent => seedEvent(runId, type, key, role, id, payload);
  return [
    e("project_docs.policy_configured", "project-docs-policy", "runner", "build-runtime", { version: 2 }),
    e("run.initialized", "run-initialized", "runner", "build-runtime", { testIntegrityPolicyVersion: 1, submissionScopePolicyVersion: 1, reviewIntegrityPolicyVersion: 1, encodingSafetyPolicyVersion: 1, reviewEvidencePolicyVersion: 1, validationScopePolicyVersion: 1, objective }),
    e("planning.policy_configured", "planning-policy", "runner", "build-runtime", { version: 1 }),
    e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "plan_only" }),
    e("planning.source_registered", "source", "user", "owner", { manifest }),
    e("request.triaged", "triage", "architect", "architect", { decision: "build", rationale: "Plan the module." }),
    e("planning.ledger_persisted", "ledger", "architect", "architect", { id: "ledger", requirements, phases, nonNormativeSections: [] }),
    ...manifest.sections.map((section) => e("planning.source_section_read", `read:${section.id}`, "architect", "architect", { manifestId: manifest.manifestId, manifestDigest: manifest.artifactDigest, sectionId: section.id, sectionDigest: section.digest, readAt: CLOCK })),
    e("planning.plan_drafted", "plan", "architect", "architect", { revision, expectedRevisionId: null, expectedDigest: null }),
    e("planning.coverage_review_requested", "coverage-request", "architect", "architect", { reviewId: coverageReview.id, planRevisionId: revision.revisionId, planRevisionDigest: revision.digest, sourceManifestId: manifest.manifestId, requestedAt: CLOCK }),
    e("planning.coverage_obligations_recorded", "coverage-obligations", "verifier", "coverage-reviewer", { reviewId: coverageReview.id, sourceManifestId: manifest.manifestId, sourceManifestDigest: manifest.artifactDigest, obligations: coverageReview.derivedObligations, sectionCoverage: manifest.sections.map((section) => ({ sectionId: section.id, obligationIds: ["obl-REQ-1"] })), recordedAt: CLOCK }),
    e("planning.coverage_plan_delivered", "coverage-plan", "runner", "build-runtime", { reviewId: coverageReview.id, planRevisionId: revision.revisionId, planRevisionDigest: revision.digest, sourceManifestId: manifest.manifestId, deliveredAt: CLOCK }),
    e("planning.coverage_review_recorded", "coverage-review", "verifier", "coverage-reviewer", { review: coverageReview }),
    e("planning.plan_ready", "ready", "runner", "build-runtime", { hostCapabilities: T1A_SEEDED_HOST_PLANNING_CAPABILITIES }),
  ];
}

export function v2AnsweredSeed(runId: string, objective = FACTORY_PORT_OBJECTIVE): NewSchedulerEvent[] {
  const { manifest } = scenario();
  const e = (
    type: string,
    key: string,
    role: SchedulerActorRole,
    id: string,
    payload: Record<string, unknown>,
  ): NewSchedulerEvent => seedEvent(runId, type, key, role, id, payload);
  return [
    e("project_docs.policy_configured", "project-docs-policy", "runner", "build-runtime", { version: 2 }),
    e("run.initialized", "run-initialized", "runner", "build-runtime", { testIntegrityPolicyVersion: 1, submissionScopePolicyVersion: 1, reviewIntegrityPolicyVersion: 1, encodingSafetyPolicyVersion: 1, reviewEvidencePolicyVersion: 1, validationScopePolicyVersion: 1, objective }),
    e("planning.policy_configured", "planning-policy", "runner", "build-runtime", { version: 1 }),
    e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "finish" }),
    e("planning.source_registered", "source", "user", "owner", { manifest }),
    e("request.triaged", "triage", "architect", "architect", { decision: "answer", rationale: "A pure question." }),
    e("request.answered", "answer", "architect", "architect", {
      answerText: "The value module must export 2.",
      addressedParts: ["What to export"],
    }),
  ];
}

const FV_CATEGORIES = ["build", "tests", "runtime_smoke", "browser"] as const;
const FV_GENERATION_ID = "generation-c2a-finish";
const FV_TASK_ID = "final-verification-c2a";
const FV_SUBMISSION_ID = `final-verification-submission:${FV_GENERATION_ID}`;
const FV_REVIEW_ID = `final-verification-review:${FV_GENERATION_ID}`;

export function finishPlan(): FinalVerificationPlan {
  return {
    checks: FV_CATEGORIES.map((category) => ({
      category,
      status: "not_applicable" as const,
      rationale: `No ${category} fixture exists.`,
      repositoryInspection: {
        paths: ["package.json"],
        summary: `The repository has no ${category} entry point.`,
      },
    })),
  };
}

export function v2FinishSeed(runId: string, integrationRevision: string): NewSchedulerEvent[] {
  const plan = finishPlan();
  const e = (
    type: string,
    key: string,
    role: SchedulerActorRole,
    id: string,
    payload: Record<string, unknown>,
  ): NewSchedulerEvent => seedEvent(runId, type, key, role, id, payload);
  const events: NewSchedulerEvent[] = [
    e("project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 2 }),
    e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "finish" }),
    e("plan.created", "plan", "architect", "architect", {
      revision: 1,
      tasks: [{
        id: "implementation",
        objective: "Implement the requested behavior.",
        dependencies: [],
        status: "integrated",
        requiredCapabilities: ["code"],
        acceptanceCriteria: [{ id: "done", text: "The behavior is implemented." }],
        acceptanceCriteriaVersion: 1,
        attempt: 1,
      }],
    }),
    e("integration.revision_advanced", "integration-revision", "runner", "integration", { integrationRevision }),
    e("final_verification.generation_created", "generation", "runner", "runtime", {
      taskId: FV_TASK_ID,
      generationId: FV_GENERATION_ID,
      targetRevision: integrationRevision,
      planVersion: 1,
      plan,
      executionProfile: emptyFinalVerificationProfile(integrationRevision),
    }),
  ];
  for (const [index, check] of plan.checks.entries()) {
    events.push(e("final_verification.check_completed", `check:${check.category}`, "runner", "runtime", {
      taskId: FV_TASK_ID,
      generationId: FV_GENERATION_ID,
      targetRevision: integrationRevision,
      attempt: 1,
      workspacePath: "C:/verification",
      startedAt: `2026-09-26T00:00:0${index + 4}.000Z`,
      finishedAt: "2026-09-26T00:00:05.000Z",
      result: { ...check, green: true, evidenceIds: [], facts: [], issues: [] },
    }));
  }
  const submissionChecks = plan.checks.map((check) => ({ ...check, green: true as const, evidenceIds: [], facts: [] }));
  const submissionResult = {
    kind: "final_verification_submission",
    generationId: FV_GENERATION_ID,
    runId,
    taskId: FV_TASK_ID,
    attempt: 1,
    targetRevision: integrationRevision,
    plan,
    executionProfile: emptyFinalVerificationProfile(integrationRevision),
    checks: submissionChecks,
    evidenceIds: [],
    submittedAt: "2026-09-26T00:00:06.000Z",
    green: true,
  };
  events.push(
    e("final_verification.submitted", "submission", "runner", "runtime", {
      taskId: FV_TASK_ID,
      generationId: FV_GENERATION_ID,
      targetRevision: integrationRevision,
      submissionId: FV_SUBMISSION_ID,
      attempt: 1,
      submissionResult,
    }),
    e("final_verification.cleanup_started", "cleanup-start", "runner", "runtime", {
      taskId: FV_TASK_ID, generationId: FV_GENERATION_ID, targetRevision: integrationRevision, attempt: 1,
    }),
    e("final_verification.cleanup_succeeded", "cleanup-success", "runner", "runtime", {
      taskId: FV_TASK_ID, generationId: FV_GENERATION_ID, targetRevision: integrationRevision, attempt: 1,
    }),
    e("final_verification.review_requested", "review-request", "runner", "runtime", {
      taskId: FV_TASK_ID,
      generationId: FV_GENERATION_ID,
      targetRevision: integrationRevision,
      submissionId: FV_SUBMISSION_ID,
      reviewId: FV_REVIEW_ID,
      attempt: 1,
    }),
    e("final_verification.review_decided", "review-decision", "architect", "architect", {
      taskId: FV_TASK_ID,
      generationId: FV_GENERATION_ID,
      targetRevision: integrationRevision,
      submissionId: FV_SUBMISSION_ID,
      reviewId: FV_REVIEW_ID,
      attempt: 1,
      decision: "approved",
      summary: "Every persisted category supports completion.",
      categoryReviews: plan.checks.map((check) => ({
        category: check.category,
        verdict: "approved",
        rationale: `The ${check.category} inspection supports approval.`,
        evidenceIds: [],
      })),
    }),
  );
  return events;
}

export function fvRerunSeed(runId: string, integrationRevision: string): NewSchedulerEvent[] {
  const plan = finishPlan();
  const rerunTaskId = "final-verification-c2a-rerun";
  const generationId = "generation-c2a-finish-rerun";
  const submissionId = `final-verification-submission:${generationId}`;
  const reviewId = `final-verification-review:${generationId}`;
  const e = (
    type: string,
    key: string,
    role: SchedulerActorRole,
    id: string,
    payload: Record<string, unknown>,
  ): NewSchedulerEvent => seedEvent(runId, type, key, role, id, payload);
  const events: NewSchedulerEvent[] = [
    e("final_verification.generation_created", "generation-rerun", "runner", "runtime", {
      taskId: rerunTaskId,
      generationId,
      targetRevision: integrationRevision,
      planVersion: 1,
      plan,
      executionProfile: emptyFinalVerificationProfile(integrationRevision),
    }),
  ];
  for (const [index, check] of plan.checks.entries()) {
    events.push(e("final_verification.check_completed", `check-rerun:${check.category}`, "runner", "runtime", {
      taskId: rerunTaskId,
      generationId,
      targetRevision: integrationRevision,
      attempt: 1,
      workspacePath: "C:/verification",
      startedAt: `2026-09-26T00:10:0${index + 4}.000Z`,
      finishedAt: "2026-09-26T00:10:05.000Z",
      result: { ...check, green: true, evidenceIds: [], facts: [], issues: [] },
    }));
  }
  const submissionChecks = plan.checks.map((check) => ({ ...check, green: true as const, evidenceIds: [], facts: [] }));
  const submissionResult = {
    kind: "final_verification_submission",
    generationId,
    runId,
    taskId: rerunTaskId,
    attempt: 1,
    targetRevision: integrationRevision,
    plan,
    executionProfile: emptyFinalVerificationProfile(integrationRevision),
    checks: submissionChecks,
    evidenceIds: [],
    submittedAt: "2026-09-26T00:10:06.000Z",
    green: true,
  };
  events.push(
    e("final_verification.submitted", "submission-rerun", "runner", "runtime", {
      taskId: rerunTaskId,
      generationId,
      targetRevision: integrationRevision,
      submissionId,
      attempt: 1,
      submissionResult,
    }),
    e("final_verification.cleanup_started", "cleanup-start-rerun", "runner", "runtime", {
      taskId: rerunTaskId, generationId, targetRevision: integrationRevision, attempt: 1,
    }),
    e("final_verification.cleanup_succeeded", "cleanup-success-rerun", "runner", "runtime", {
      taskId: rerunTaskId, generationId, targetRevision: integrationRevision, attempt: 1,
    }),
    e("final_verification.review_requested", "review-request-rerun", "runner", "runtime", {
      taskId: rerunTaskId,
      generationId,
      targetRevision: integrationRevision,
      submissionId,
      reviewId,
      attempt: 1,
    }),
    e("final_verification.review_decided", "review-decision-rerun", "architect", "architect", {
      taskId: rerunTaskId,
      generationId,
      targetRevision: integrationRevision,
      submissionId,
      reviewId,
      attempt: 1,
      decision: "approved",
      summary: "Every persisted category supports completion.",
      categoryReviews: plan.checks.map((check) => ({
        category: check.category,
        verdict: "approved",
        rationale: `The ${check.category} inspection supports approval.`,
        evidenceIds: [],
      })),
    }),
  );
  return events;
}

export function runnerActor(): { role: "runner"; id: string } {
  return { role: "runner", id: "build-runtime" };
}

export function safeSegment(value: string): string {
  const readable = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run";
  return `${readable}-${createHash("sha256").update(value).digest("hex").slice(0, 10)}`;
}

export function provider(runtimeId: string, priority: number): RunnerProviderConfig {
  const [providerId, modelId] = runtimeId.split(":");
  return { runtimeId, providerId: providerId!, modelId: modelId!, transport: "openai-compatible", baseUrl: "http://127.0.0.1:9", secret: "unused", capabilities: ["code"], priority };
}

export class UnusedModel implements AgentModel {
  async complete(): Promise<never> {
    throw new Error("This model must not be called on a plan-only run.");
  }
}

export interface GitRepo {
  root: string;
  project: string;
  state: string;
  baselineRevision: string;
  integration: FixtureIntegrationManager;
  close: () => Promise<void>;
}

export async function openGitRepo(label: string, runId: string): Promise<GitRepo> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-c2a-${label}-`));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "shared.txt"), "baseline\n");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: `c2a-${label}-fixture`, version: "1.0.0", type: "module" }, null, 2));
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const integration = new FixtureIntegrationManager({
    repositoryRoot: project,
    stateDirectory: state,
    runId,
    baselineRevision: baseline.revision,
  });
  await integration.initialize();
  return {
    root,
    project,
    state,
    baselineRevision: baseline.revision,
    integration,
    close: async () => {
      await integration.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface DocsPortHooks {
  failNextSnapshot?: boolean;
  failSnapshotCount?: number;
  failNextRead?: boolean;
  snapshotCalls?: unknown[];
  readCalls?: unknown[];
}

/** Production-shaped docs port backed by the real IntegrationManager, with injectable failures. */
export function gitDocsPort(
  integration: FixtureIntegrationManager,
  hooks: DocsPortHooks = {},
): ProjectDocsPort {
  return {
    commit: async () => {
      throw new Error("The v2 kernel path never uses the Architect document commit.");
    },
    commitHandoffSnapshot: async (input) => {
      hooks.snapshotCalls?.push(input);
      if (hooks.failNextSnapshot === true) {
        hooks.failNextSnapshot = false;
        throw new Error("Injected handoff snapshot commit failure.");
      }
      if ((hooks.failSnapshotCount ?? 0) > 0) {
        hooks.failSnapshotCount = (hooks.failSnapshotCount ?? 0) - 1;
        throw new Error("Injected handoff snapshot commit failure.");
      }
      return integration.commitHandoffSnapshot(input);
    },
    readHandoffSnapshotFile: async (input) => {
      hooks.readCalls?.push(input);
      if (hooks.failNextRead === true) {
        hooks.failNextRead = false;
        throw new Error("Injected handoff snapshot read failure.");
      }
      return integration.readHandoffSnapshotFile(input);
    },
    readIntegrationTipFile: async (input) => integration.readIntegrationTipFile(input),
    findTrackedFileWithDigest: async (input) => integration.findTrackedFileWithDigest(input),
    findHandoffSnapshotCommit: async (input) => integration.findHandoffSnapshotCommit(input),
    readIntegrationBaselineRevision: async () => integration.readIntegrationBaselineRevision(),
    canStageSpecPath: async (input) => integration.canStageSpecPath(input),
    relateRevision: async () => "strict_descendant" as const,
  };
}

export type ModelTurn = import("../../src/agent-contracts.js").ModelTurn;

export const toolCall = (name: string, args: unknown, id: string): ModelTurn => ({
  blocks: [{ type: "tool_call", callId: id, name, arguments: args }],
  stopReason: "tool_calls",
  usage: { inputTokens: 8, outputTokens: 4 },
});

/** Scripted Architect: the only expected turn completes the run; anything else is a test failure. */
export class CompletionArchitect implements AgentModel {
  calls = 0;
  constructor(private readonly projection: () => SchedulerProjection) {}
  async complete(): Promise<ModelTurn> {
    this.calls += 1;
    const projection = this.projection();
    if (projection.projectHandoff) {
      throw new Error(`Unexpected Architect turn after handoff: ${projection.projectHandoff.status}.`);
    }
    if (this.calls > 1) {
      throw new Error(`Unexpected second Architect turn (call ${this.calls}).`);
    }
    return toolCall("complete_run", { summary: COMPLETION_SUMMARY }, `complete-${this.calls}`);
  }
}

/** The harness architect driver: any model call is a test failure. */
export function throwingArchitect(): { driver: ArchitectRuntimeDriver } {
  return {
    driver: {
      run: async () => {
        throw new Error("The handoff harness seeds the stop directly: no model call is expected.");
      },
    },
  };
}

export function silentArchitect(summary = COMPLETION_SUMMARY): { driver: ArchitectRuntimeDriver; calls: () => number } {
  let calls = 0;
  let sequence = 0;
  return {
    calls: () => calls,
    driver: {
      run: async (request) => {
        calls += 1;
        const invoke = async (name: string, args: unknown) => {
          sequence += 1;
          const result = await request.tools.invoke({ type: "tool_call", callId: `c2a-${sequence}`, name, arguments: args }, request.context);
          assert.equal(result.isError, false, result.error?.message ?? `${name} failed`);
        };
        await invoke("complete_run", { summary });
      },
    },
  };
}

export function buildRuntimeForHandoff(options: {
  runId: string;
  store: SqliteSchedulerStore;
  projectDocs: ProjectDocsPort;
  architect: { driver: ArchitectRuntimeDriver };
  stopNotes?: StopNotesDriver;
  stopNotesTimeoutMs?: number;
  clock: () => string;
  runPolicy: "finish" | "plan_only";
  evidenceStore?: EvidenceStore;
  artifacts?: ArtifactStore;
  specCopy?: boolean;
  handoffFiles?: "commit" | "export_only";
  independentVerifier?: IndependentVerifierDriver;
}): BuildRuntime {
  return new BuildRuntime({
    runId: options.runId,
    runPolicy: options.runPolicy,
    store: options.store,
    workerDriver: { run: async () => ({ type: "failed" as const, reason: "unused" }) },
    architectDriver: options.architect.driver,
    ...(options.stopNotes ? { stopNotes: options.stopNotes } : {}),
    ...(options.stopNotesTimeoutMs !== undefined ? { stopNotesTimeoutMs: options.stopNotesTimeoutMs } : {}),
    integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
    ...(options.independentVerifier ? { independentVerifier: options.independentVerifier } : {}),
    maxConcurrency: 1,
    workspaceFor: async () => "C:/unused",
    clock: options.clock,
    projectDocs: options.projectDocs,
    ...(options.evidenceStore ? { evidenceStore: options.evidenceStore } : {}),
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    ...(options.specCopy !== undefined ? { specCopy: options.specCopy } : {}),
    ...(options.handoffFiles !== undefined ? { handoffFiles: options.handoffFiles } : {}),
  });
}

export function advancingClock(start = "2026-09-26T00:00:00.000Z"): () => string {
  let now = Date.parse(start);
  return () => new Date((now += 1000)).toISOString();
}

export function withRunOptions(
  seed: NewSchedulerEvent[],
  options: { specCopy?: boolean; handoffFiles?: "commit" | "export_only" },
): NewSchedulerEvent[] {
  return seed.map((event) => event.type === "run.policy_configured"
    ? { ...event, payload: { ...(event.payload as Record<string, unknown>), ...options } }
    : event);
}

export function managerSpec(runId: string, runPolicy: "finish" | "plan_only" | "budgeted"): NativeBuildSpec {
  return {
    version: 2,
    runId,
    projectId: "c2a-fixture",
    objective: "Prove the docs-v2 kernel handoff.",
    architectRuntimeId: "arch:architect",
    workerRuntimeIds: ["work:worker"],
    verifierRuntimeIds: ["rev:reviewer"],
    alwaysRequireIndependentVerifier: false,
    maxConcurrency: 1,
    permissionProfile: "full",
    runPolicy,
    budgetLimits: {},
    createdAt: CLOCK,
    idempotencyKey: `c2a-${runId}`,
  };
}

function zeroUsage() {
  return {
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    estimatedCostMicros: 0,
    activeMs: 0,
    artifactBytes: 0,
  };
}

/** Production NativeBuildManager handle around a real BuildRuntime; only the project mutation is spied. */
export function managedHandle(
  runtime: BuildRuntime,
  projectHandoff: (choice: ProjectHandoffChoice) => Promise<ProjectHandoffResult>,
  runId: string,
) {
  return {
    runtime,
    usage: () => ({
      scopeId: runId,
      reservations: {},
      activeSegments: {},
      effective: zeroUsage(),
      lifetime: zeroUsage(),
      window: { index: 1 },
      lastSequence: 0,
      attributedModelReservationCount: 0,
      models: [],
    }),
    observability: async () => ({
      runId,
      budget: {
        scopeId: runId,
        reservations: {},
        activeSegments: {},
        effective: zeroUsage(),
        lifetime: zeroUsage(),
        window: { index: 1 },
        lastSequence: 0,
        attributedModelReservationCount: 0,
        models: [],
      },
      toolCallCount: 0,
      agents: [],
      tools: [],
      evidence: [],
      memories: [],
      skills: [],
      processes: [],
      providers: [],
      events: [],
      git: { integrationBranch: "", integrationRevision: "", commits: [] },
      contextManifestCount: 0,
      files: [],
    }),
    transcript: async () => ({ turns: [], cursor: 0 }),
    files: async () => ({
      source: "integration" as const,
      revision: "a".repeat(40),
      appliedToProject: false,
      omittedFileCount: 0,
      files: [],
    }),
    compact: async () => undefined,
    projectHandoff,
    cleanup: async () => undefined,
    close: async () => undefined,
  } as never;
}

/** Minimal handoff fixture: state, docs port, and evidence. Factory ports add the factory and stop-notes driver. */
export interface HandoffFixture {
  root: string;
  project: string;
  state: string;
  baselineRevision: string;
  integration: ProductionIntegrationManager;
  port: ProjectDocsPort;
  evidence: SqliteEvidenceStore;
  close: () => Promise<void>;
}

export interface FactoryPortFixture extends HandoffFixture {
  /** C3b: the factory-built runtime's stop-notes driver (the actual Architect runtime). */
  stopNotes: StopNotesDriver;
  factory: NativeBuildFactory;
}

/**
 * The docs port under test is ALWAYS the one NativeBuildFactory.create
 * builds -- read off the factory-built runtime, never hand-built. Failure
 * injection patches the factory's own integration manager instance (the
 * port keeps delegating to it); the port object itself is the factory's.
 */
/**
 * P6.6 T8 Layer-4: factory-port finish acceptance. Build-finish handoff
 * tests run through NativeBuildFactory with docs v2, so the seed must
 * carry the exact new-policy provisioning prefix with planning v1 (the
 * legacy-planning v2FinishSeed is intentionally unrecoverable via the
 * factory). Planning v1 finish completion requires durable delivery
 * acceptance, which cannot be faked: the helper below drives the real
 * factory pump with scripted worker/reviewer/architect models (copied
 * from the delivery factory scenario) until T1 is integrated and the
 * P1 phase is accepted. Callers then append FV + risk and drive handoff
 * exactly as before; complete_run succeeds because acceptance exists.
 */
const FINISH_VALUE_TEST = "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value', () => assert.equal(value, 2));\n";
const FINISH_LOW_CONTENT = "export const value = 2;\n";
const FINISH_VALIDATION_SCOPE: ValidationScope = {
  changed: ["src/value.mjs"],
  verified: ["src/value.mjs exports value = 2"],
  testsRun: [{ command: "node --test", counts: { selected: 1, passed: 1, failed: 0, skipped: 0 } }],
  notRun: [],
};

function finishCall(name: string, args: unknown, id: string): ModelTurn {
  return {
    blocks: [{ type: "tool_call", callId: id, name, arguments: args }],
    stopReason: "tool_calls",
    usage: { inputTokens: 8, outputTokens: 4 },
  };
}

function finishLastToolValue(request: AgentModelRequest): Record<string, unknown> | undefined {
  const message = [...request.messages].reverse().find((candidate) => candidate.role === "tool");
  const content = (message?.content as { content?: Array<{ type: string; value?: unknown }> } | undefined)?.content;
  return content?.find((item) => item.type === "json")?.value as Record<string, unknown> | undefined;
}

class FinishWorkerModel implements AgentModel {
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    const toolCount = request.messages.filter((message) => message.role === "tool").length;
    if (toolCount === 0) return finishCall("fs.write", { path: "src/value.mjs", content: FINISH_LOW_CONTENT, createDirectories: true }, "write-1");
    if (toolCount === 1) return finishCall("run_evidence_command", { label: "tests", command: process.execPath, args: ["--test"] }, "evidence-1");
    const record = finishLastToolValue(request)!;
    const fact = record.fact as { stdoutArtifactHash: string };
    return finishCall("submit_task", {
      summary: "Added src/value.mjs exporting value = 2; node --test passes.",
      readiness: "ready_for_architect_review",
      unresolvedConcerns: [],
      criterionEvidenceLinks: [{ criterionId: "c1", evidenceId: record.id, artifactHashes: [fact.stdoutArtifactHash] }],
      validationScope: FINISH_VALIDATION_SCOPE,
    }, "submit-1");
  }
}

class FinishReviewerModel implements AgentModel {
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    const system = request.messages.find((message) => message.role === "system");
    const pass = system?.id ?? "";
    const text = request.messages.filter((message) => typeof message.content === "string").map((message) => message.content as string).join("\n");
    const tools = request.messages.filter((message) => message.role === "tool").length;
    if (pass === "delivery-obligations-system") {
      return finishCall("record_deliverable_obligations", { obligations: [{ id: "o1", description: "value must be 2." }] }, `obl-${tools}`);
    }
    if (pass === "delivery-findings-system") {
      if (tools === 0) return finishCall("fs.read", { path: "src/value.mjs" }, "read-1");
      return finishCall("record_deliverable_findings", { findings: [] }, `findings-${tools}`);
    }
    if (tools === 0) return finishCall("fs.read", { path: "src/value.mjs" }, "verdict-read-1");
    const claimIds = [...new Set([...text.matchAll(/"id"\s*:\s*"(claim:[^"]+)"/g)].map((match) => match[1]!))];
    return finishCall("submit_deliverable_verdict", {
      summary: "The module exports 2 and the cited test run passed.",
      satisfied: true,
      survivorDispositions: [],
      claimVerdicts: claimIds.map((claimId) => ({ claimId, status: "verified", rationale: "Confirmed in the checkout.", citations: [{ path: "src/value.mjs", line: 1 }] })),
    }, `verdict-${tools}`);
  }
}

class FinishArchitectModel implements AgentModel {
  constructor(private readonly projection: () => SchedulerProjection) {}
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    const projection = this.projection();
    const tools = request.messages.filter((message) => message.role === "tool").length;
    const task = projection.tasks.T1!;
    if (task.status === "submitted" || task.status === "architect_review") {
      const links = task.criterionEvidenceLinks ?? [];
      return finishCall("review_task", {
        taskId: "T1",
        decision: "approved",
        summary: "The deliverable review is satisfied and the evidence passes.",
        evidenceArtifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
        criterionVerdicts: [{ criterionId: "c1", verdict: "satisfied", rationale: "Tests pass.", evidenceIds: links.map((link) => link.evidenceId), artifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))] }],
      }, `review-${request.messages.length}-${tools}`);
    }
    if (task.status === "approved") return finishCall("request_integration", { taskId: "T1" }, `integrate-${request.messages.length}-${tools}`);
    throw new Error(`Unexpected Architect turn with T1 ${task.status}.`);
  }
}

/**
 * Current-policy factory finish pre-seed: the exact T7a provisioning
 * prefix (docs2/run.initialized/planning1) with FACTORY_PORT_OBJECTIVE,
 * the finish run policy, the shared scenario planned through ready, and
 * the explicit owner start for the current ready identity. No scheduler
 * tasks are faked: T1 materializes from the ready plan and is driven to
 * integrated + accepted by openFactoryFinishPort's real pump. FV, risk
 * and handoff are appended by the caller exactly as before.
 */
export function v2FactoryFinishPreSeed(runId: string, objective = FACTORY_PORT_OBJECTIVE): NewSchedulerEvent[] {
  const base = v2PlanOnlySeed(runId, objective).map((event) =>
    event.type === "run.policy_configured"
      ? { ...event, payload: { ...event.payload, runPolicy: "finish" } }
      : event);
  const synthesized = base.map((event, index) => ({ ...event, sequence: index + 1, eventId: `finish-pre-${index}` }));
  const projection = rebuildSchedulerProjection(synthesized as unknown as Parameters<typeof rebuildSchedulerProjection>[0]);
  const startIdentity = currentExplicitStartIdentity(projection);
  assert.ok(startIdentity, "the factory finish pre-seed is ready with a complete start identity");
  return [
    ...base,
    seedEvent(runId, "planning.execution_authorized", "owner-start", "user", "local-user", {
      authorization: { ...startIdentity, version: 1, ownerChoice: "execute" },
    }),
  ];
}

export interface FactoryPortHooks {
  /** Runs against the factory-built runtime before the fixture is returned. */
  onBuilt?: (built: { runtime: BuildRuntime }) => Promise<void>;
  /** Prepares the project directory before the git baseline is captured. */
  prepareProject?: (project: string) => void;
}

export async function openFactoryPort(
  label: string,
  runId: string,
  seed: (runId: string, baselineRevision: string) => NewSchedulerEvent[],
  runPolicy: "finish" | "plan_only",
  specOptions: { specCopy?: boolean; handoffFiles?: "commit" | "export_only"; modelsFor?: (config: RunnerProviderConfig) => AgentModel } = {},
  hooks: FactoryPortHooks = {},
): Promise<FactoryPortFixture> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-c2b-factory-${label}-`));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "shared.txt"), "baseline\n");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: `c2b-${label}-fixture`, version: "1.0.0", type: "module" }, null, 2));
  hooks.prepareProject?.(project);
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const runRoot = join(state, "builds", safeSegment(runId));
  mkdirSync(runRoot, { recursive: true });
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const schedulerDbOptions = {
    evidenceStore: evidence,
    validateExecutionProfile: acceptFinalVerificationProfile,
    validateCleanupReceipt: () => undefined,
  };
  const planned = seed(runId, baseline.revision);
  // Supported policy shapes only. New-policy seeds (planning.policy_configured
  // present) must carry the exact T7a provisioning prefix and recover with the
  // explicit planningPolicy v1 opt-in. Genuinely legacy seeds carry neither
  // docs v2 nor planning v1. A legacy-planning seed carrying docs v2 is
  // intentionally unrecoverable via the factory: production fails closed
  // rather than downgrade, so the helper refuses it instead of hiding the
  // docs stamp from the guard and mutating history after creation.
  const newPolicySeed = planned.some((event) => event.type === "planning.policy_configured");
  const hasDocsV2 = planned.some((event) =>
    event.type === "project_docs.policy_configured" &&
    (event.payload as Record<string, unknown>).version === 2);
  assert.equal(
    hasDocsV2 && !newPolicySeed,
    false,
    "openFactoryPort refuses a legacy-planning seed carrying docs v2: modernize to the exact " +
    "new-policy prefix (docs2/run.initialized/planning1) with planningPolicy v1, or keep the seed " +
    "genuinely legacy (no docs2/planning1). Withholding the docs stamp around create() is not supported.",
  );
  if (newPolicySeed) {
    const [docs, init, planning] = planned;
    assert.equal(docs?.type, "project_docs.policy_configured", "new-policy seeds open with docs v2");
    assert.equal(docs?.idempotencyKey, "project-docs-policy", "docs v2 carries the provisioning key");
    assert.deepEqual(docs?.payload, { version: 2 }, "docs v2 carries exactly version 2");
    assert.equal(init?.type, "run.initialized", "new-policy seeds carry run.initialized second");
    assert.equal(init?.idempotencyKey, "run-initialized", "run.initialized carries the provisioning key");
    assert.deepEqual(
      init?.payload,
      {
        testIntegrityPolicyVersion: 1,
        submissionScopePolicyVersion: 1,
        reviewIntegrityPolicyVersion: 1,
        encodingSafetyPolicyVersion: 1,
        reviewEvidencePolicyVersion: 1,
        validationScopePolicyVersion: 1,
        objective: FACTORY_PORT_OBJECTIVE,
      },
      "run.initialized carries the exact provisioning policies and the factory-port objective",
    );
    assert.equal(planning?.type, "planning.policy_configured", "new-policy seeds carry planning v1 third");
    assert.equal(planning?.idempotencyKey, "planning-policy", "planning v1 carries the provisioning key");
    assert.deepEqual(planning?.payload, { version: 1 }, "planning v1 carries exactly version 1");
  }
  const seeder = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"), schedulerDbOptions);
  for (const input of planned) seeder.append(input);
  seeder.close();
  const seen: ProductionIntegrationManager[] = [];
  const origInitialize = ProductionIntegrationManager.prototype.initialize;
  ProductionIntegrationManager.prototype.initialize = async function (this: ProductionIntegrationManager): Promise<void> {
    seen.push(this);
    return origInitialize.call(this);
  };
  const executionHost = createExecutionHost({
    projectRoot: project,
    stateDirectory: state,
    artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment: snapshotNativeBuildAmbientEnvironment(),
  });
  const factory = new NativeBuildFactory({
    projectRoot: project,
    stateDirectory: state,
    providerConfigs: {
      load: () => [provider("arch:architect", 1), provider("work:worker", 2), provider("rev:reviewer", 3)],
      save: () => undefined,
      close: () => undefined,
    },
    executionHost,
    baselineFor: () => baseline.revision,
    providerModelFactory: (config) => specOptions.modelsFor?.(config) ?? new UnusedModel(),
  });
  if (newPolicySeed) {
    // Truthful registered-source bytes for creation-time verification: the
    // shared scenario manifest's exact bytes, in the store the factory reads.
    const artifacts = new ArtifactStore(join(state, "artifacts"));
    await artifacts.put(Buffer.from(SOURCE_TEXT, "utf-8"), "text/plain", "approved source");
  }
  let built: { runtime: BuildRuntime; cleanup: () => Promise<void>; close: () => Promise<void> };
  try {
    built = await factory.create(await factory.prepareSpec({
      version: 2,
      runId,
      projectId: "c2b-factory-fixture",
      objective: FACTORY_PORT_OBJECTIVE,
      architectRuntimeId: "arch:architect",
      workerRuntimeIds: ["work:worker"],
      verifierRuntimeIds: ["rev:reviewer"],
      alwaysRequireIndependentVerifier: false,
      maxConcurrency: 1,
      permissionProfile: "full",
      runPolicy,
      ...(newPolicySeed ? { planningPolicy: { version: 1 as const } } : {}),
      budgetLimits: {},
      createdAt: CLOCK,
      idempotencyKey: `c2b-factory-${label}`,
      ...specOptions,
    })) as unknown as { runtime: BuildRuntime; cleanup: () => Promise<void>; close: () => Promise<void> };
  } finally {
    ProductionIntegrationManager.prototype.initialize = origInitialize;
  }
  assert.equal(seen.length, 1, "the factory builds exactly one integration manager");
  if (hooks.onBuilt) await hooks.onBuilt(built);
  const integration = seen[0]!;
  const port = (built.runtime as unknown as { projectDocs: ProjectDocsPort }).projectDocs;
  assert.ok(port, "the factory builds a docs port");
  const stopNotes = (built.runtime as unknown as { stopNotes: StopNotesDriver }).stopNotes;
  assert.ok(stopNotes, "the factory wires the Architect stop-notes driver");
  return {
    root,
    project,
    state,
    baselineRevision: baseline.revision,
    integration,
    port,
    stopNotes,
    factory,
    evidence,
    close: async () => {
      await built.cleanup();
      await built.close();
      await factory.close();
      await executionHost.close();
      evidence.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * A direct (non-factory) handoff fixture for logs the factory intentionally
 * cannot recover. Legacy-planning docs-v2 logs (the N6 baseline-fallback
 * shape) are supported by the reducer and the direct BuildRuntime, but
 * production fails closed when a legacy spec recovers against docs2, so no
 * factory spec can legally open them. This helper seeds the log as-is and
 * builds the production-shaped docs port directly around a fixture
 * integration manager, without hiding events from any guard. New-policy
 * factory tests keep using openFactoryPort; only genuinely factory-
 * unrecoverable legacy shapes use this path.
 */
/**
 * Factory-port finish fixture with real delivery acceptance. Opens the
 * factory on v2FactoryFinishPreSeed, then steps the factory-built runtime
 * with scripted worker/reviewer/architect models until T1 is integrated
 * and P1 accepted (stopping before FV starts). The caller appends fvSeed
 * + lowRiskSeed and drives handoff exactly as before.
 */
export async function openFactoryFinishPort(
  label: string,
  runId: string,
  specOptions: { specCopy?: boolean; handoffFiles?: "commit" | "export_only" } = {},
): Promise<FactoryPortFixture> {
  let runtimeRef: BuildRuntime | undefined;
  const worker = new FinishWorkerModel();
  const reviewer = new FinishReviewerModel();
  const modelsFor = (config: RunnerProviderConfig): AgentModel => {
    if (config.runtimeId === "arch:architect") return new FinishArchitectModel(() => runtimeRef!.projection());
    if (config.runtimeId === "work:worker") return worker;
    return reviewer;
  };
  const fixture = await openFactoryPort(
    label,
    runId,
    (seedRunId) => v2FactoryFinishPreSeed(seedRunId),
    "finish",
    { ...specOptions, modelsFor },
    {
      // The scripted finish worker runs `node --test` and expects the value
      // fixture: scoped to finish fixtures only via the preparation hook, so
      // generic factory and direct fixtures keep their committed contents.
      prepareProject: (project) => {
        const packagePath = join(project, "package.json");
        const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
        writeFileSync(packagePath, JSON.stringify({ ...pkg, scripts: { test: "node --test" } }, null, 2));
        mkdirSync(join(project, "test"), { recursive: true });
        writeFileSync(join(project, "test", "value.test.mjs"), FINISH_VALUE_TEST);
      },
      onBuilt: async (built) => {
        runtimeRef = built.runtime;
        for (let step = 0; step < 40; step += 1) {
          const projection = built.runtime.projection();
          if (Object.keys(projection.delivery?.phaseAcceptances ?? {}).length > 0) break;
          const result = await built.runtime.step();
          if (result.status === "paused" || result.status === "failed") break;
        }
        const final = built.runtime.projection();
        assert.ok(Object.keys(final.delivery?.phaseAcceptances ?? {}).length > 0, "the finish drive reaches phase acceptance");
        assert.ok(final.delivery?.taskAcceptances.T1, "T1 is accepted before handoff");
        assert.ok(final.integrationRevision, "integration revision exists before FV");
      },
    },
  );
  // The worker drive recorded evidence in the factory's own evidence store
  // (runRoot), not the fixture's pre-create store. Point the fixture at the
  // factory file so later harness opens replay with the worker evidence.
  const factoryEvidence = new SqliteEvidenceStore(join(fixture.state, "builds", safeSegment(runId), "evidence.sqlite"));
  const origClose = fixture.close;
  fixture.evidence = factoryEvidence;
  fixture.close = async () => {
    factoryEvidence.close();
    await origClose();
  };
  return fixture;
}

/**
 * The scheduler integration revision after openFactoryFinishPort's worker
 * drive. Handoff tests seed FV + risk against this revision (not the git
 * baseline: worker integration advanced it) and scope rev-list assertions
 * from it so worker commits do not pollute handoff commit counts.
 */
export function finishIntegrationRevision(fixture: FactoryPortFixture, runId: string): string {
  const { projection } = readHandoffLog(fixture, runId);
  assert.ok(projection.integrationRevision, "the finish drive leaves an integration revision");
  return projection.integrationRevision;
}

export async function openDirectPort(
  label: string,
  runId: string,
  seed: (runId: string, baselineRevision: string) => NewSchedulerEvent[],
): Promise<HandoffFixture> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-c2b-direct-${label}-`));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "shared.txt"), "baseline\n");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: `c2b-${label}-fixture`, version: "1.0.0", type: "module" }, null, 2));
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const runRoot = join(state, "builds", safeSegment(runId));
  mkdirSync(runRoot, { recursive: true });
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const seeder = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"), {
    evidenceStore: evidence,
    validateExecutionProfile: acceptFinalVerificationProfile,
    validateCleanupReceipt: () => undefined,
  });
  for (const input of seed(runId, baseline.revision)) seeder.append(input);
  seeder.close();
  const integration = new FixtureIntegrationManager({
    repositoryRoot: project,
    stateDirectory: state,
    runId,
    baselineRevision: baseline.revision,
  });
  await integration.initialize();
  const port = gitDocsPort(integration);
  return {
    root,
    project,
    state,
    baselineRevision: baseline.revision,
    integration,
    port,
    evidence,
    close: async () => {
      await integration.cleanup();
      evidence.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Fail the factory integration's next snapshot read once (a transient post-commit failure). */
export function failNextSnapshotReadOnce(integration: ProductionIntegrationManager, message: string): void {
  const orig = integration.readHandoffSnapshotFile.bind(integration);
  let armed = true;
  integration.readHandoffSnapshotFile = async (input: { commit: string; path: string }) => {
    if (armed) {
      armed = false;
      throw new Error(message);
    }
    return orig(input);
  };
}

/** Fail the factory integration's next snapshot lookup once (a transient reconciliation failure). */
export function failNextSnapshotLookupOnce(integration: ProductionIntegrationManager, message: string): void {
  const orig = integration.findHandoffSnapshotCommit.bind(integration);
  let armed = true;
  integration.findHandoffSnapshotCommit = async (input: { snapshotKey: string }) => {
    if (armed) {
      armed = false;
      throw new Error(message);
    }
    return orig(input);
  };
}

/** Fail the harness store's next handoff-snapshot append once (a refused reducer append). */
export function failNextSnapshotAppendOnce(store: SqliteSchedulerStore, message: string): void {
  const orig = store.append.bind(store);
  let armed = true;
  store.append = (event: NewSchedulerEvent) => {
    if (armed && event.type === "project_docs.handoff_snapshot_committed") {
      armed = false;
      throw new Error(message);
    }
    return orig(event);
  };
}

/** Fail the factory integration's next N snapshot commits (a persistent commit failure). */
export function failNextSnapshotCommits(integration: ProductionIntegrationManager, count: number, message: string): void {
  const orig = integration.commitHandoffSnapshot.bind(integration);
  let remaining = count;
  integration.commitHandoffSnapshot = async (input: Parameters<typeof orig>[0]) => {
    if (remaining > 0) {
      remaining -= 1;
      throw new Error(message);
    }
    return orig(input);
  };
}

export function headerDigest(body: string): string {
  assert.equal(verifyHandoffSnapshotDigest(body), true);
  const digest = /body_sha256: ([a-f0-9]{64})/.exec(body.split("\n")[0] ?? "")?.[1] ?? "";
  assert.match(digest, /^[a-f0-9]{64}$/);
  return digest;
}

export function openHandoffStore(fixture: HandoffFixture, runId: string): SqliteSchedulerStore {
  return new SqliteSchedulerStore(join(fixture.state, "builds", safeSegment(runId), "scheduler.sqlite"), {
    evidenceStore: fixture.evidence,
    artifacts: new ArtifactStore(join(fixture.state, "artifacts")),
    validateExecutionProfile: acceptFinalVerificationProfile,
    validateCleanupReceipt: () => undefined,
  });
}

/**
 * Seed the handoff stop directly: the `project.handoff_requested` event
 * exactly as the Architect's `complete_run` records it, so the runtime's
 * real snapshot step runs with no model call.
 */
export function seedHandoffRequested(
  fixture: HandoffFixture,
  runId: string,
  key = "handoff-requested",
  summary = COMPLETION_SUMMARY,
): void {
  const store = openHandoffStore(fixture, runId);
  try {
    store.append(seedEvent(runId, "project.handoff_requested", key, "architect", "architect", { summary }));
  } finally {
    store.close();
  }
}

export function appendHandoffEvents(
  fixture: HandoffFixture,
  runId: string,
  events: NewSchedulerEvent[],
): void {
  const store = openHandoffStore(fixture, runId);
  try {
    for (const input of events) store.append(input);
  } finally {
    store.close();
  }
}

export function readHandoffLog(
  fixture: HandoffFixture,
  runId: string,
): { events: ReturnType<SqliteSchedulerStore["readRun"]>; projection: SchedulerProjection } {
  const store = openHandoffStore(fixture, runId);
  try {
    const events = store.readRun(runId);
    return { events, projection: rebuildSchedulerProjection(events) };
  } finally {
    store.close();
  }
}

export interface DriveHandoffOptions {
  runPolicy?: "finish" | "plan_only";
  architect?: { driver: ArchitectRuntimeDriver };
  stopNotes?: StopNotesDriver;
  stopNotesTimeoutMs?: number;
  clock?: () => string;
  specCopy?: boolean;
  handoffFiles?: "commit" | "export_only";
  artifacts?: ArtifactStore;
  independentVerifier?: IndependentVerifierDriver;
}

/**
 * Drive the runtime's real snapshot step directly: open the seeded store,
 * build a real BuildRuntime around the factory's port, and step until
 * blocked. Replaces the manager create -> activate -> awaitIdle pump; the
 * automatic project handoff (manager logic) is NOT performed -- use
 * applyAutomaticHandoff or selectHandoffOwner afterwards.
 */
export async function driveHandoff(
  fixture: HandoffFixture,
  runId: string,
  options: DriveHandoffOptions = {},
): Promise<{ events: ReturnType<SqliteSchedulerStore["readRun"]>; projection: SchedulerProjection }> {
  const store = openHandoffStore(fixture, runId);
  try {
    const runtime = buildRuntimeForHandoff({
      runId,
      store,
      projectDocs: fixture.port,
      architect: options.architect ?? throwingArchitect(),
      clock: options.clock ?? advancingClock(),
      runPolicy: options.runPolicy ?? "plan_only",
      evidenceStore: fixture.evidence,
      artifacts: new ArtifactStore(join(fixture.state, "artifacts")),
      ...(options.specCopy !== undefined ? { specCopy: options.specCopy } : {}),
      ...(options.handoffFiles !== undefined ? { handoffFiles: options.handoffFiles } : {}),
      ...(options.artifacts ? { artifacts: options.artifacts } : {}),
      ...(options.independentVerifier ? { independentVerifier: options.independentVerifier } : {}),
      ...(options.stopNotes ? { stopNotes: options.stopNotes } : {}),
      ...(options.stopNotesTimeoutMs !== undefined ? { stopNotesTimeoutMs: options.stopNotesTimeoutMs } : {}),
    });
    await runtime.runUntilBlocked();
    const events = store.readRun(runId);
    return { events, projection: rebuildSchedulerProjection(events) };
  } finally {
    store.close();
  }
}

/**
 * The owner's pause through the real runtime (stacks on top of a snapshot
 * failure). Forwards the run-policy and stop-notes options exactly like
 * driveHandoff: a pause on an export_only run must carry the recorded
 * handoffFiles policy, and a pause that a later drive snapshots must carry
 * the same notes driver (R1-4: dropping stopNotes here snapshots the new
 * stop without notes).
 */
export async function pauseHandoff(
  fixture: HandoffFixture,
  runId: string,
  reason: string,
  key: string,
  options: DriveHandoffOptions = {},
): Promise<SchedulerProjection> {
  const store = openHandoffStore(fixture, runId);
  try {
    const runtime = buildRuntimeForHandoff({
      runId,
      store,
      projectDocs: fixture.port,
      architect: options.architect ?? throwingArchitect(),
      clock: options.clock ?? advancingClock(),
      runPolicy: options.runPolicy ?? "plan_only",
      evidenceStore: fixture.evidence,
      artifacts: new ArtifactStore(join(fixture.state, "artifacts")),
      ...(options.specCopy !== undefined ? { specCopy: options.specCopy } : {}),
      ...(options.handoffFiles !== undefined ? { handoffFiles: options.handoffFiles } : {}),
      ...(options.stopNotes ? { stopNotes: options.stopNotes } : {}),
      ...(options.stopNotesTimeoutMs !== undefined ? { stopNotesTimeoutMs: options.stopNotesTimeoutMs } : {}),
    });
    return runtime.pause(reason, key);
  } finally {
    store.close();
  }
}

/** The owner's resume through the real runtime: clears the failure pause so the next drive retries. */
export async function resumeHandoff(
  fixture: HandoffFixture,
  runId: string,
  key: string,
  options: DriveHandoffOptions = {},
): Promise<SchedulerProjection> {
  const store = openHandoffStore(fixture, runId);
  try {
    const runtime = buildRuntimeForHandoff({
      runId,
      store,
      projectDocs: fixture.port,
      architect: options.architect ?? throwingArchitect(),
      clock: options.clock ?? advancingClock(),
      runPolicy: options.runPolicy ?? "plan_only",
      evidenceStore: fixture.evidence,
      artifacts: new ArtifactStore(join(fixture.state, "artifacts")),
      ...(options.specCopy !== undefined ? { specCopy: options.specCopy } : {}),
      ...(options.handoffFiles !== undefined ? { handoffFiles: options.handoffFiles } : {}),
    });
    return runtime.resume(key);
  } finally {
    store.close();
  }
}

/**
 * The owner's selection, mirroring NativeBuildManager.selectProjectHandoff:
 * the shared acceptance pre-check runs BEFORE any project mutation, then
 * `apply_to_project` really applies through the factory integration while
 * any other choice records a stub result without touching the project.
 */
export async function selectHandoffOwner(
  fixture: HandoffFixture,
  runId: string,
  choice: ProjectHandoffChoice,
  key: string,
  options: DriveHandoffOptions & {
    /**
     * Record a stub result without touching the project (mirrors the
     * plan-only managedHandle stubs and the answered-run stub). Default
     * stubs every choice except `apply_to_project`.
     */
    stubResult?: boolean;
  } = {},
): Promise<SchedulerProjection> {
  const store = openHandoffStore(fixture, runId);
  try {
    const runtime = buildRuntimeForHandoff({
      runId,
      store,
      projectDocs: fixture.port,
      architect: options.architect ?? throwingArchitect(),
      clock: options.clock ?? advancingClock(),
      runPolicy: options.runPolicy ?? "plan_only",
      evidenceStore: fixture.evidence,
      artifacts: new ArtifactStore(join(fixture.state, "artifacts")),
      ...(options.specCopy !== undefined ? { specCopy: options.specCopy } : {}),
      ...(options.handoffFiles !== undefined ? { handoffFiles: options.handoffFiles } : {}),
    });
    const projection = runtime.projection();
    assertProjectHandoffSelectionAccepted(
      projection,
      handoffSnapshotAtCurrentStop(projection)?.head ?? projection.integrationRevision,
    );
    const result: ProjectHandoffResult = choice === "apply_to_project" && options.stubResult !== true
      ? await fixture.integration.applyToProject()
      : { integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false };
    return runtime.selectProjectHandoff(choice, result, key);
  } finally {
    store.close();
  }
}

/**
 * The manager's automatic finish-run handoff, mirrored without the manager:
 * the shared acceptance pre-check, then apply, then record the runner-owned
 * selection.
 */
export async function applyAutomaticHandoff(
  fixture: HandoffFixture,
  runId: string,
  options: DriveHandoffOptions = {},
): Promise<SchedulerProjection> {
  const store = openHandoffStore(fixture, runId);
  try {
    const runtime = buildRuntimeForHandoff({
      runId,
      store,
      projectDocs: fixture.port,
      architect: options.architect ?? throwingArchitect(),
      clock: options.clock ?? advancingClock(),
      runPolicy: options.runPolicy ?? "finish",
      evidenceStore: fixture.evidence,
      artifacts: new ArtifactStore(join(fixture.state, "artifacts")),
    });
    const projection = runtime.projection();
    assertProjectHandoffSelectionAccepted(
      projection,
      handoffSnapshotAtCurrentStop(projection)?.head ?? projection.integrationRevision,
    );
    const result = await fixture.integration.applyToProject();
    return runtime.selectProjectHandoff("apply_to_project", result, "automatic-project-handoff", {
      role: "runner",
      id: "native-build-manager",
    });
  } finally {
    store.close();
  }
}

export async function commitEntryLinkMode(worktree: string, linkPath: string, targetText: string): Promise<void> {
  writeFileSync(join(worktree, "link-target.txt"), targetText);
  const hashed = await runGit({ cwd: worktree, args: ["hash-object", "-w", "link-target.txt"] });
  const blob = hashed.stdout.trim();
  assert.match(blob, /^[a-f0-9]{40}$/);
  rmSync(join(worktree, "link-target.txt"), { force: true });
  await runGit({ cwd: worktree, args: ["update-index", "--add", "--cacheinfo", `120000,${blob},${linkPath}`] });
  await runGit({ cwd: worktree, args: ["commit", "-m", `link ${linkPath}`] });
}

export async function checkoutEntryLinkAsPlainFile(worktree: string, linkPath: string, targetText: string): Promise<void> {
  await runGit({ cwd: worktree, args: ["config", "core.symlinks", "false"] });
  rmSync(join(worktree, linkPath), { force: true });
  await runGit({ cwd: worktree, args: ["checkout", "--", linkPath] });
  assert.equal(lstatSync(join(worktree, linkPath)).isSymbolicLink(), false);
  assert.equal(readFileSync(join(worktree, linkPath), "utf8"), targetText);
  const staged = await runGit({ cwd: worktree, args: ["ls-files", "-s", "--", linkPath] });
  assert.match(staged.stdout.trim(), /^120000 /);
}

export async function checkoutDirLinkAsRealLink(worktree: string, linkPath: string): Promise<void> {
  await runGit({ cwd: worktree, args: ["config", "core.symlinks", "true"] });
  rmSync(join(worktree, ...linkPath.split("/")), { recursive: true, force: true });
  await runGit({ cwd: worktree, args: ["checkout", "--", linkPath] });
  assert.ok(lstatSync(join(worktree, ...linkPath.split("/"))).isSymbolicLink(), `${linkPath} checks out as a real link`);
  const staged = await runGit({ cwd: worktree, args: ["ls-files", "-s", "--", linkPath] });
  assert.match(staged.stdout.trim(), /^120000 /);
}
