import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import { BuildRuntime, sanitizeSpecSourceId, type ProjectDocsPort } from "../src/build-runtime.js";
import { validateBuildSpec } from "../src/build-spec.js";
import {
  handoffSnapshotInputFromProjection,
  renderHandoffSnapshot,
  verifyHandoffSnapshotDigest,
} from "../src/handoff-snapshot.js";
import type { ProjectHandoffResult } from "../src/integration-manager.js";
import { IntegrationManager as ProductionIntegrationManager } from "../src/integration-manager.js";
import { NativeBuildManager } from "../src/native-build-manager.js";
import {
  buildExecutionPlanRevision,
  T1A_SEEDED_HOST_PLANNING_CAPABILITIES,
  type CoverageReview,
  type ExecutionPlanPhase,
  type ExecutionTaskContract,
  type SourceRequirement,
} from "../src/planning-contracts.js";
import type { NativeBuildSpec } from "../src/build-spec.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import {
  assertHandoffSnapshotGate,
  assertProjectHandoffSelectionAccepted,
  buildCompletionReadiness,
  handoffFilesOf,
  handoffSnapshotCoversRevision,
  rebuildSchedulerProjection,
  specCopyOf,
  type NewSchedulerEvent,
  type ProjectHandoffChoice,
  type SchedulerActor,
  type SchedulerActorRole,
} from "../src/scheduler-store.js";
import { buildSourceManifest } from "../src/source-manifest.js";
import {
  AGENTS_SECTION_END,
  AGENTS_SECTION_START,
  V2_AGENTS_SECTION_BODY,
  V2_CLAUDE_POINTER_LINE,
} from "../src/project-docs.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import {
  IntegrationManager,
  NativeBuildFactory,
  captureGitBaseline,
  runGit,
} from "./support/git-fixture.js";
import {
  acceptFinalVerificationProfile,
  emptyFinalVerificationProfile,
} from "./support/final-verification-profile.js";
import type { FinalVerificationPlan } from "../src/final-verification-contracts.js";
import { assessBuildRisk, type BuildRiskAssessmentInput } from "../src/risk-policy.js";

/**
 * C2a repair cycle 1 (docs policy v2 kernel path, STATE.md only): every
 * blocking probe from the independent review is a regression test, driven
 * through the production NativeBuildManager (create -> activate ->
 * awaitIdle -> selectProjectHandoff) with NO manual runtime.step().
 *
 * - B1: the snapshot commits in the handoff step itself; the manager checks
 *   the v2 gate before the project can be mutated.
 * - B2: fail -> resume -> retry returns to the handoff wait, no model call.
 * - B3: the failure pause key is per attempt; consecutive failures re-pause.
 * - B4: the event digest is read back from the commit's own tree.
 * - M1/M2/M3/M4/M6: latest-stop gate, same revision in event and file,
 *   full-trailer reuse, failure detail, finish-run tip coverage.
 */

const CLOCK = "2026-09-25T00:00:00.000Z";
const SOURCE_TEXT = "SECTION 1: MANDATORY. The value module must export the value 2.";
const COMPLETION_SUMMARY = "The plan is ready for handoff. Notes for the next tool: keep the value module as is.";

function scenario() {
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

function seedEvent(
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

/**
 * C2b repair cycle 2 (B1-R/G2-prod, B2/G3): the factory configures the
 * production risk_based verifier policy when its runtime is built, so a
 * finish flow through the factory's port needs a current low-risk
 * assessment before completion is ready. The assessment is computed by the
 * kernel (`assessBuildRisk`), never hand-written. It lands after the
 * factory's policy and the green approved FV generation it qualifies
 * (targeting the unchanged baseline revision), mirroring what the
 * production manager records before completion.
 */
function lowRiskSeed(runId: string, baselineRevision: string, key = "risk:baseline-low"): NewSchedulerEvent[] {
  const input: BuildRiskAssessmentInput = {
    architectDeclaration: "low",
    // Must equal the factory spec's alwaysRequireIndependentVerifier (false).
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

/** New-policy plan-only seed with docs policy v2 (CD-1: tests seed both policies). */
function v2PlanOnlySeed(runId: string): NewSchedulerEvent[] {
  const { manifest, requirements, phases, revision, coverageReview } = scenario();
  const e = (
    type: string,
    key: string,
    role: SchedulerActorRole,
    id: string,
    payload: Record<string, unknown>,
  ): NewSchedulerEvent => seedEvent(runId, type, key, role, id, payload);
  return [
    e("project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 2 }),
    e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "plan_only" }),
    e("planning.policy_configured", "planning-policy", "runner", "build-runtime", { version: 1 }),
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

/** New-policy answered seed with docs policy v2: triage answer plus the recorded answer. */
function v2AnsweredSeed(runId: string): NewSchedulerEvent[] {
  const { manifest } = scenario();
  const e = (
    type: string,
    key: string,
    role: SchedulerActorRole,
    id: string,
    payload: Record<string, unknown>,
  ): NewSchedulerEvent => seedEvent(runId, type, key, role, id, payload);
  return [
    e("project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 2 }),
    e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "finish" }),
    e("planning.policy_configured", "planning-policy", "runner", "build-runtime", { version: 1 }),
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

function finishPlan(): FinalVerificationPlan {
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

/**
 * Finish seed with docs policy v2, one Architect turn from handoff: legacy
 * plan with an integrated task, a canonical integration revision, and a
 * fully approved final-verification generation bound to that revision.
 */
function v2FinishSeed(runId: string, integrationRevision: string): NewSchedulerEvent[] {
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

function runnerActor(): SchedulerActor {
  return { role: "runner", id: "build-runtime" };
}

function safeSegment(value: string): string {
  const readable = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run";
  return `${readable}-${createHash("sha256").update(value).digest("hex").slice(0, 10)}`;
}

function provider(runtimeId: string, priority: number): RunnerProviderConfig {
  const [providerId, modelId] = runtimeId.split(":");
  return { runtimeId, providerId: providerId!, modelId: modelId!, transport: "openai-compatible", baseUrl: "http://127.0.0.1:9", secret: "unused", capabilities: ["code"], priority };
}

const toolCall = (name: string, args: unknown, id: string): ModelTurn => ({
  blocks: [{ type: "tool_call", callId: id, name, arguments: args }],
  stopReason: "tool_calls",
  usage: { inputTokens: 8, outputTokens: 4 },
});

/** Scripted Architect: the only expected turn completes the run; anything else is a test failure. */
class CompletionArchitect implements AgentModel {
  calls = 0;
  constructor(private readonly projection: () => import("../src/scheduler-store.js").SchedulerProjection) {}
  async complete(_request: AgentModelRequest): Promise<ModelTurn> {
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

class UnusedModel implements AgentModel {
  async complete(_request: AgentModelRequest): Promise<ModelTurn> {
    throw new Error("This model must not be called on a plan-only run.");
  }
}

interface GitRepo {
  root: string;
  project: string;
  state: string;
  baselineRevision: string;
  integration: IntegrationManager;
  close: () => Promise<void>;
}

async function openGitRepo(label: string, runId: string): Promise<GitRepo> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-c2a-${label}-`));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "shared.txt"), "baseline\n");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: `c2a-${label}-fixture`, version: "1.0.0", type: "module" }, null, 2));
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const integration = new IntegrationManager({
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

interface DocsPortHooks {
  failNextSnapshot?: boolean;
  failSnapshotCount?: number;
  failNextRead?: boolean;
  snapshotCalls?: unknown[];
  readCalls?: unknown[];
}

/** Production-shaped docs port backed by the real IntegrationManager, with injectable failures. */
function gitDocsPort(integration: IntegrationManager, hooks: DocsPortHooks = {}): ProjectDocsPort {
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
    relateRevision: async () => "strict_descendant" as const,
  };
}

function silentArchitect(summary = COMPLETION_SUMMARY): { driver: import("../src/build-runtime.js").ArchitectRuntimeDriver; calls: () => number } {
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

function buildRuntimeForHandoff(options: {
  runId: string;
  store: SqliteSchedulerStore;
  projectDocs: ProjectDocsPort;
  architect: { driver: import("../src/build-runtime.js").ArchitectRuntimeDriver };
  clock: () => string;
  runPolicy: "finish" | "plan_only";
  evidenceStore?: import("../src/evidence-store.js").EvidenceStore;
  artifacts?: ArtifactStore;
  specCopy?: boolean;
  handoffFiles?: "commit" | "export_only";
}): BuildRuntime {
  return new BuildRuntime({
    runId: options.runId,
    runPolicy: options.runPolicy,
    store: options.store,
    workerDriver: { run: async () => ({ type: "failed" as const, reason: "unused" }) },
    architectDriver: options.architect.driver,
    integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
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

function advancingClock(start = "2026-09-26T00:00:00.000Z"): () => string {
  let now = Date.parse(start);
  return () => new Date((now += 1000)).toISOString();
}

/**
 * C2b: carry run options in a seed's `run.policy_configured` payload (the
 * recorded run policy governs the run; the runtime records the same values
 * on a fresh store).
 */
function withRunOptions(
  seed: NewSchedulerEvent[],
  options: { specCopy?: boolean; handoffFiles?: "commit" | "export_only" },
): NewSchedulerEvent[] {
  return seed.map((event) => event.type === "run.policy_configured"
    ? { ...event, payload: { ...(event.payload as Record<string, unknown>), ...options } }
    : event);
}

function managerSpec(runId: string, runPolicy: "finish" | "plan_only" | "budgeted"): NativeBuildSpec {
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
function managedHandle(
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

/**
 * C2b repair cycle 2: the docs port under test is ALWAYS the one
 * NativeBuildFactory.create builds -- read off the factory-built runtime,
 * never hand-built. A test that builds its own port hides missing
 * production wiring (B1-R), so every factory-port regression goes through
 * this helper. Failure injection patches the factory's own integration
 * manager instance (the port keeps delegating to it); the port object
 * itself is the factory's.
 */
interface FactoryPortFixture {
  root: string;
  project: string;
  state: string;
  baselineRevision: string;
  integration: ProductionIntegrationManager;
  port: ProjectDocsPort;
  factory: NativeBuildFactory;
  evidence: SqliteEvidenceStore;
  close: () => Promise<void>;
}

async function openFactoryPort(
  label: string,
  runId: string,
  seed: (runId: string, baselineRevision: string) => NewSchedulerEvent[],
  runPolicy: "finish" | "plan_only",
): Promise<FactoryPortFixture> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-c2b-factory-${label}-`));
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
  // Capture the factory's own integration manager: the built port delegates
  // to this instance, and the test needs it for injection + assertions.
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
    // The factory-built runtime never steps in these tests (the harness
    // builds its own runtime around the factory's port), so any model call
    // through it is a test failure.
    providerModelFactory: () => new UnusedModel(),
  });
  let built: { runtime: BuildRuntime; cleanup: () => Promise<void>; close: () => Promise<void> };
  try {
    built = await factory.create(await factory.prepareSpec({
      version: 2,
      runId,
      projectId: "c2b-factory-fixture",
      objective: "Prove the factory-wired docs port.",
      architectRuntimeId: "arch:architect",
      workerRuntimeIds: ["work:worker"],
      verifierRuntimeIds: ["rev:reviewer"],
      alwaysRequireIndependentVerifier: false,
      maxConcurrency: 1,
      permissionProfile: "full",
      runPolicy,
      budgetLimits: {},
      createdAt: CLOCK,
      idempotencyKey: `c2b-factory-${label}`,
    })) as unknown as { runtime: BuildRuntime; cleanup: () => Promise<void>; close: () => Promise<void> };
  } finally {
    ProductionIntegrationManager.prototype.initialize = origInitialize;
  }
  assert.equal(seen.length, 1, "the factory builds exactly one integration manager");
  const integration = seen[0]!;
  const port = (built.runtime as unknown as { projectDocs: ProjectDocsPort }).projectDocs;
  assert.ok(port, "the factory builds a docs port");
  return {
    root,
    project,
    state,
    baselineRevision: baseline.revision,
    integration,
    port,
    factory,
    evidence,
    close: async () => {
      // The built handle owns the run's processes and worktrees (like the
      // manager's handle in production); release it before removing the
      // tree, or Windows holds the directories open (EPERM).
      await built.cleanup();
      await built.close();
      await factory.close();
      await executionHost.close();
      evidence.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Fail the factory integration's next snapshot read once (a transient post-commit failure). */
function failNextSnapshotReadOnce(integration: ProductionIntegrationManager, message: string): void {
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
function failNextSnapshotLookupOnce(integration: ProductionIntegrationManager, message: string): void {
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

function headerDigest(body: string): string {
  assert.equal(verifyHandoffSnapshotDigest(body), true);
  const digest = /body_sha256: ([a-f0-9]{64})/.exec(body.split("\n")[0] ?? "")?.[1] ?? "";
  assert.match(digest, /^[a-f0-9]{64}$/);
  return digest;
}
test("C2a B1: production-manager plan-only run commits one kernel STATE.md snapshot in the handoff step", async () => {
  const RUN = "run-c2a-factory";
  const root = mkdtempSync(join(tmpdir(), "aiboard c2a factory "));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(join(project, "test"), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "c2a-factory", version: "1.0.0", type: "module", packageManager: "npm@11.0.0", scripts: { test: "node --test" } }, null, 2));
  const runRoot = join(state, "builds", safeSegment(RUN));
  mkdirSync(runRoot, { recursive: true });
  const seed = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"));
  for (const input of v2PlanOnlySeed(RUN)) seed.append(input);
  seed.close();
  const architect = new CompletionArchitect(() => manager!.projection(RUN));
  const executionHost = createExecutionHost({
    projectRoot: project,
    stateDirectory: state,
    artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment: snapshotNativeBuildAmbientEnvironment(),
  });
  let factory: NativeBuildFactory | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: RUN });
    factory = new NativeBuildFactory({
      projectRoot: project,
      stateDirectory: state,
      providerConfigs: {
        load: () => [provider("arch:architect", 1), provider("work:worker", 2), provider("rev:reviewer", 3)],
        save: () => undefined,
        close: () => undefined,
      },
      executionHost,
      baselineFor: () => baseline.revision,
      providerModelFactory: (config) => config.runtimeId === "arch:architect" ? architect : new UnusedModel(),
    });
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: (spec) => factory!.create(spec),
      prepareSpec: (spec) => factory!.prepareSpec(spec),
    });
    // Production flow only: create -> activate -> awaitIdle -> selectProjectHandoff. No manual step().
    await manager.create(await factory.prepareSpec({
      version: 2,
      runId: RUN,
      projectId: "c2a-fixture",
      objective: "Plan the value module.",
      architectRuntimeId: "arch:architect",
      workerRuntimeIds: ["work:worker"],
      verifierRuntimeIds: ["rev:reviewer"],
      alwaysRequireIndependentVerifier: false,
      maxConcurrency: 1,
      permissionProfile: "full",
      runPolicy: "plan_only",
      planCritique: "off",
      budgetLimits: {},
      createdAt: CLOCK,
      idempotencyKey: "c2a-factory",
    }));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    assert.equal(manager.projection(RUN).projectHandoff?.status, "requested");
    assert.equal(architect.calls, 1);
    // The handoff step itself committed the snapshot: no extra step was taken.
    const events = manager.events(RUN);
    const stop = events.find((event) => event.type === "project.handoff_requested")!;
    const snapshots = events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the handoff step commits exactly one snapshot");
    const snapshot = snapshots[0]!;
    assert.equal(snapshot.actor.role, "runner");
    assert.equal(snapshot.idempotencyKey, `handoff-snapshot:${stop.sequence}`);
    const payload = snapshot.payload as Record<string, unknown>;
    assert.equal(payload.stopSequence, stop.sequence);
    assert.equal(payload.stopKind, "plan_only");
    assert.equal(payload.revision, "revision_value");
    assert.match(String(payload.bodyDigest), /^[a-f0-9]{64}$/);
    assert.deepEqual(payload.paths, ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"]);
    assert.equal(payload.previousSnapshotEdited, false);
    assert.equal(payload.agentsSectionCommitted, true);
    assert.equal(payload.claudeLineCommitted, true);
    const entries = readdirSync(join(state, "integration"));
    assert.equal(entries.length, 1);
    const repoPath = join(state, "integration", entries[0]!);
    const log = await runGit({ cwd: repoPath, args: ["log", "--format=%H", `${baseline.revision}..HEAD`] });
    const commits = log.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    assert.deepEqual(commits, [payload.commit], "exactly one kernel commit");
    const files = await runGit({ cwd: repoPath, args: ["show", "--name-only", "--format=", String(payload.commit)] });
    // C2b: one kernel commit holds STATE.md plus the v2 entry lines (no
    // spec copy here: the factory artifact store holds no source bytes).
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"]);
    const meta = await runGit({ cwd: repoPath, args: ["log", "-1", "--format=%an%x00%ae%x00%cn%x00%ce%x00%B", String(payload.commit)] });
    const [authorName, authorEmail, committerName, committerEmail, ...rest] = meta.stdout.split("\0");
    assert.equal(authorName, "AIBoard Integrator");
    assert.equal(authorEmail, "integrator@aiboard.local");
    assert.equal(committerName, "AIBoard Integrator");
    assert.equal(committerEmail, "integrator@aiboard.local");
    const message = rest.join("\0");
    assert.match(message, /AIBoard-Author: runner/);
    assert.match(message, /AIBoard-Generated: handoff-snapshot/);
    assert.match(message, new RegExp(`AIBoard-Snapshot-Key: handoff-snapshot:${stop.sequence}`));
    assert.match(message, new RegExp(`AIBoard-Run: ${RUN}`));
    const stateShow = await runGit({ cwd: repoPath, args: ["show", `${String(payload.commit)}:docs/project/STATE.md`] });
    // M2/M4: the committed file verifies and describes the recorded revision.
    assert.equal(headerDigest(stateShow.stdout), payload.bodyDigest);
    assert.match(stateShow.stdout, /revision: revision_value/);
    assert.match(stateShow.stdout, /## Plan \(ready\)/, "the plan-only snapshot holds the plan view");
    assert.match(stateShow.stdout, /P1/);
    assert.match(stateShow.stdout, /T1/);
    assert.match(stateShow.stdout, /REQ-1/);
    assert.match(stateShow.stdout, /plan_only/);
    assert.match(stateShow.stdout, /The plan is ready for handoff/);
    // The owner's selection through the production manager completes the run.
    const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c2a");
    assert.equal(selected.status, "completed");
    assert.equal(architect.calls, 1, "the kernel snapshot makes no model call");
  } finally {
    await manager?.close();
    await factory?.close();
    await executionHost.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("C2a B1+M6: production-manager finish run snapshots at handoff and the automatic handoff applies afterwards", async () => {
  const RUN = "run-c2a-finish";
  const repo = await openGitRepo("finish", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(repo.root, "evidence.sqlite"));
  const seeder = new SqliteSchedulerStore(schedulerPath, {
    evidenceStore: evidence,
    validateExecutionProfile: acceptFinalVerificationProfile,
    validateCleanupReceipt: () => undefined,
  });
  // The canonical revision is the real baseline, so the kernel commit
  // continues the documents and moves the tip (CD-11) on a finish run.
  for (const input of v2FinishSeed(RUN, repo.baselineRevision)) seeder.append(input);
  seeder.close();
  const hooks: DocsPortHooks = { snapshotCalls: [], readCalls: [] };
  const architect = silentArchitect("The build is complete and verified.");
  const clock = advancingClock();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  const order: string[] = [];
  try {
    const runtimeOf = () => {
      store = new SqliteSchedulerStore(schedulerPath, {
        evidenceStore: evidence,
        validateExecutionProfile: acceptFinalVerificationProfile,
        validateCleanupReceipt: () => undefined,
      });
      return buildRuntimeForHandoff({
        runId: RUN,
        store,
        projectDocs: gitDocsPort(repo.integration, hooks),
        architect,
        clock,
        runPolicy: "finish",
        evidenceStore: evidence,
      });
    };
    let runtime!: BuildRuntime;
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        runtime = runtimeOf();
        return managedHandle(runtime, async () => {
          // The real project mutation, spied: it must run only after the
          // kernel snapshot exists.
          order.push(`projectHandoff:${manager!.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length}`);
          const result = await repo.integration.applyToProject();
          order.push("applied");
          return result;
        }, RUN);
      },
    });
    await manager.create(managerSpec(RUN, "finish"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const projection = manager.projection(RUN);
    assert.equal(projection.status, "completed", "the automatic handoff completes the finish run");
    assert.equal(projection.projectHandoff?.status, "selected");
    assert.equal(projection.projectHandoff?.choice, "apply_to_project");
    assert.equal(architect.calls(), 1, "the kernel snapshot makes no model call");
    const events = manager.events(RUN);
    const stop = events.find((event) => event.type === "project.handoff_requested")!;
    const snapshots = events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.stopSequence, stop.sequence);
    assert.equal(payload.stopKind, "completed");
    assert.equal(payload.revision, repo.baselineRevision);
    // The snapshot moved the v2 document tip to the kernel commit (CD-11).
    assert.equal(manager.projection(RUN).projectDocs?.documentTip, payload.commit);
    // M4/B4: the event digest is the committed file's own digest.
    const stateShow = await runGit({ cwd: repo.integration.path, args: ["show", `${String(payload.commit)}:docs/project/STATE.md`] });
    assert.equal(headerDigest(stateShow.stdout), payload.bodyDigest);
    assert.match(stateShow.stdout, new RegExp(`revision: ${repo.baselineRevision}`));
    // The automatic handoff ran after the snapshot and really applied it.
    assert.deepEqual(order, ["projectHandoff:1", "applied"]);
    const applied = await runGit({ cwd: repo.project, args: ["show", "HEAD:docs/project/STATE.md"], });
    assert.equal(applied.stdout, stateShow.stdout, "the project holds the snapshotted STATE.md");
    const count = await runGit({ cwd: repo.integration.path, args: ["rev-list", "--count", `${repo.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "1");
  } finally {
    await manager?.close();
    store?.close();
    evidence.close();
    await repo.close();
  }
});

test("C2a B1: with the snapshot commit forced to fail, the project is not mutated", async () => {
  const RUN = "run-c2a-nomutate";
  const repo = await openGitRepo("nomutate", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(repo.root, "evidence.sqlite"));
  const seeder = new SqliteSchedulerStore(schedulerPath, {
    evidenceStore: evidence,
    validateExecutionProfile: acceptFinalVerificationProfile,
    validateCleanupReceipt: () => undefined,
  });
  for (const input of v2FinishSeed(RUN, repo.baselineRevision)) seeder.append(input);
  seeder.close();
  const hooks: DocsPortHooks = { failSnapshotCount: 99, snapshotCalls: [], readCalls: [] };
  const architect = silentArchitect("The build is complete and verified.");
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  let physicalHandoffs = 0;
  const pumpResults: unknown[] = [];
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath, {
          evidenceStore: evidence,
          validateExecutionProfile: acceptFinalVerificationProfile,
          validateCleanupReceipt: () => undefined,
        });
        const runtime = buildRuntimeForHandoff({
          runId: RUN,
          store,
          projectDocs: gitDocsPort(repo.integration, hooks),
          architect,
          clock: advancingClock(),
          runPolicy: "finish",
          evidenceStore: evidence,
        });
        return managedHandle(runtime, async () => {
          physicalHandoffs += 1;
          return repo.integration.applyToProject();
        }, RUN);
      },
      onPumpResult: (_runId, result) => { pumpResults.push(result); },
    });
    await manager.create(managerSpec(RUN, "finish"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const projection = manager.projection(RUN);
    assert.equal(projection.projectHandoff?.status, "requested");
    assert.equal(projection.pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    assert.ok((hooks.snapshotCalls?.length ?? 0) >= 1, "the snapshot was attempted");
    // The gate refused before any project mutation.
    assert.equal(physicalHandoffs, 0);
    assert.ok(pumpResults.some((result) => (result as { action?: string }).action === "automatic_project_handoff_failed"));
    const count = await runGit({ cwd: repo.integration.path, args: ["rev-list", "--count", `${repo.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "0", "no kernel commit was left behind");
    assert.equal(existsSync(join(repo.project, "docs", "project", "STATE.md")), false, "the project is untouched");
    // The owner's selection is refused too while the snapshot is missing.
    await assert.rejects(
      manager.selectProjectHandoff(RUN, "apply_to_project", "handoff:c2a-nomutate"),
      /kernel handoff snapshot/,
    );
    assert.equal(physicalHandoffs, 0);
  } finally {
    await manager?.close();
    store?.close();
    evidence.close();
    await repo.close();
  }
});
test("C2a B2+M4: fail -> resume -> retry returns to the handoff wait with no model call", async () => {
  const RUN = "run-c2a-failure";
  const repo = await openGitRepo("failure", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const seeder = new SqliteSchedulerStore(schedulerPath);
  for (const input of v2PlanOnlySeed(RUN)) seeder.append(input);
  seeder.close();
  const hooks: DocsPortHooks = { failNextSnapshot: true, snapshotCalls: [], readCalls: [] };
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath);
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration, hooks),
          architect, clock: advancingClock(), runPolicy: "plan_only",
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    assert.equal(manager.projection(RUN).projectHandoff?.status, "requested");
    assert.equal(architect.calls(), 1);
    assert.equal(manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    assert.equal(hooks.snapshotCalls?.length, 1);
    const failure = manager.projection(RUN).pauseReason;
    assert.equal(failure?.reason, "handoff_snapshot_failed");
    // M4: the bounded cause travels in the pause detail.
    assert.ok(typeof failure?.detail === "string" && failure.detail.length > 0, "the failure pause carries a cause");
    assert.ok(failure.detail.length <= 300, "the cause is bounded");
    assert.equal(failure.detail.includes("\n"), false, "the cause is single-lined");
    const empty = await runGit({ cwd: repo.integration.path, args: ["rev-list", "--count", `${repo.baselineRevision}..HEAD`] });
    assert.equal(empty.stdout.trim(), "0", "a failed commit leaves no commit behind");
    await manager.resume(RUN, "resume:c2a-failure");
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    // B2: the run is back at the handoff wait -- paused, handoff requested, no failure pause.
    const retried = manager.projection(RUN);
    assert.equal(retried.status, "paused");
    assert.equal(retried.projectHandoff?.status, "requested");
    assert.equal(retried.pauseReason, undefined);
    assert.equal(architect.calls(), 1, "the retry makes no model call");
    const events = manager.events(RUN);
    assert.equal(events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 1);
    const count = await runGit({ cwd: repo.integration.path, args: ["rev-list", "--count", `${repo.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "1");
    // A further pump makes no model call either.
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    assert.equal(architect.calls(), 1, "a further step after the handoff wait makes no model call");
    assert.equal(manager.projection(RUN).status, "paused");
    const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c2a-failure");
    assert.equal(selected.status, "completed");
  } finally {
    await manager?.close();
    store?.close();
    await repo.close();
  }
});

test("C2a B3: two consecutive failures pause again and the next resume retries", async () => {
  const RUN = "run-c2a-double-failure";
  const repo = await openGitRepo("double-failure", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const seeder = new SqliteSchedulerStore(schedulerPath);
  for (const input of v2PlanOnlySeed(RUN)) seeder.append(input);
  seeder.close();
  const hooks: DocsPortHooks = { failSnapshotCount: 2, snapshotCalls: [], readCalls: [] };
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath);
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration, hooks),
          architect, clock: advancingClock(), runPolicy: "plan_only",
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const firstPauses = manager.events(RUN).filter((event) => event.type === "run.paused");
    assert.equal(firstPauses.length, 1);
    assert.equal((firstPauses[0]!.payload as Record<string, unknown>).reason, "handoff_snapshot_failed");
    assert.equal(manager.projection(RUN).pauseReason?.reason, "handoff_snapshot_failed");
    // The next resume retries instead of being refused.
    await manager.resume(RUN, "resume:c2a-double-1");
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const secondPauses = manager.events(RUN).filter((event) => event.type === "run.paused");
    assert.equal(secondPauses.length, 2, "the second failure pauses again");
    assert.notEqual(secondPauses[0]!.idempotencyKey, secondPauses[1]!.idempotencyKey, "the failure pause key is per attempt");
    assert.equal(manager.projection(RUN).pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    await manager.resume(RUN, "resume:c2a-double-2");
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const retried = manager.projection(RUN);
    assert.equal(retried.status, "paused");
    assert.equal(retried.projectHandoff?.status, "requested");
    assert.equal(retried.pauseReason, undefined);
    assert.equal(manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 1);
    const count = await runGit({ cwd: repo.integration.path, args: ["rev-list", "--count", `${repo.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "1");
    const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c2a-double");
    assert.equal(selected.status, "completed");
  } finally {
    await manager?.close();
    store?.close();
    await repo.close();
  }
});

test("C2a B4: commit lands, the read fails, retry reuses the commit and records its tree", async () => {
  const RUN = "run-c2a-read-retry";
  const repo = await openGitRepo("read-retry", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const seeder = new SqliteSchedulerStore(schedulerPath);
  for (const input of v2PlanOnlySeed(RUN)) seeder.append(input);
  seeder.close();
  const hooks: DocsPortHooks = { failNextRead: true, snapshotCalls: [], readCalls: [] };
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath);
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration, hooks),
          architect, clock: advancingClock(), runPolicy: "plan_only",
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    // The commit landed but the read failed: paused, one commit, no event.
    assert.equal(manager.projection(RUN).pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    const landed = await runGit({ cwd: repo.integration.path, args: ["rev-list", "--count", `${repo.baselineRevision}..HEAD`] });
    assert.equal(landed.stdout.trim(), "1");
    await manager.resume(RUN, "resume:c2a-read-retry");
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const events = manager.events(RUN);
    assert.equal(events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 1);
    const payload = events.find((event) => event.type === "project_docs.handoff_snapshot_committed")!.payload as Record<string, unknown>;
    const count = await runGit({ cwd: repo.integration.path, args: ["rev-list", "--count", `${repo.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "1", "the retry reuses the commit instead of duplicating it");
    // The event digest is the committed file's own digest.
    const committed = await runGit({ cwd: repo.integration.path, args: ["show", `${String(payload.commit)}:docs/project/STATE.md`] });
    assert.equal(headerDigest(committed.stdout), payload.bodyDigest);
    assert.deepEqual(payload.paths, ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"]);
  } finally {
    await manager?.close();
    store?.close();
    await repo.close();
  }
});
test("C2a: a crash between the kernel commit and the event append resumes to one commit and one event", async () => {
  const RUN = "run-c2a-crash";
  const repo = await openGitRepo("crash", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const seeder = new SqliteSchedulerStore(schedulerPath);
  for (const input of v2PlanOnlySeed(RUN)) seeder.append(input);
  // The stop is recorded but the crashed attempt never appended the event.
  seeder.append(seedEvent(RUN, "project.handoff_requested", "handoff-requested", "architect", "architect", { summary: COMPLETION_SUMMARY }));
  const logged = seeder.readRun(RUN);
  const stop = logged.find((event) => event.type === "project.handoff_requested")!;
  const stopProjection = rebuildSchedulerProjection(logged.filter((event) => event.sequence <= stop.sequence));
  // The crashed attempt committed the deterministic stop body with the
  // snapshot key, then died before the event append.
  const body = renderHandoffSnapshot(handoffSnapshotInputFromProjection(stopProjection, { stopAt: stop.occurredAt, revision: "revision_value" }));
  assert.equal(verifyHandoffSnapshotDigest(body), true);
  // C2b: the crashed attempt committed the full kernel tree (STATE.md plus
  // the v2 entry lines); the pump must reuse it, never duplicate it.
  const crashed = await repo.integration.commitHandoffSnapshot({
    writes: [
      { path: "docs/project/STATE.md", content: body },
      { path: "AGENTS.md", content: V2_AGENTS_SECTION_BODY },
      { path: "CLAUDE.md", content: V2_CLAUDE_POINTER_LINE },
    ],
    summary: "crashed attempt with the same snapshot key",
    runId: RUN,
    snapshotKey: `handoff-snapshot:${stop.sequence}`,
  });
  seeder.close();
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath);
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration),
          architect, clock: advancingClock(), runPolicy: "plan_only",
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    // Production flow only: the pump recovers the crash, no manual step.
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    assert.equal((snapshots[0]!.payload as Record<string, unknown>).commit, crashed.commit);
    const count = await runGit({ cwd: repo.integration.path, args: ["rev-list", "--count", `${repo.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "1", "the crash does not create a second commit");
    const stored = await runGit({ cwd: repo.integration.path, args: ["show", `${crashed.commit}:docs/project/STATE.md`] });
    assert.equal(stored.stdout, body);
    assert.equal((snapshots[0]!.payload as Record<string, unknown>).bodyDigest, headerDigest(body));
    assert.equal(architect.calls(), 0, "recovery makes no model call");
    const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c2a-crash");
    assert.equal(selected.status, "completed");
  } finally {
    await manager?.close();
    store?.close();
    await repo.close();
  }
});
test("C2a: the snapshot moves the v2 document tip on a finish-style revision", async () => {
  const RUN = "run-c2a-tip";
  const repo = await openGitRepo("tip", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const seeder = new SqliteSchedulerStore(schedulerPath);
  for (const input of v2PlanOnlySeed(RUN)) seeder.append(input);
  // A finish-style canonical revision equal to the real baseline, so the
  // kernel commit continues the documents and moves the tip (CD-11).
  seeder.append({
    runId: RUN,
    type: "integration.revision_advanced",
    occurredAt: CLOCK,
    actor: runnerActor(),
    idempotencyKey: "integration:rev",
    payload: { integrationRevision: repo.baselineRevision },
  });
  seeder.close();
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath);
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration),
          architect, clock: advancingClock(), runPolicy: "plan_only",
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.revision, repo.baselineRevision);
    assert.equal(manager.projection(RUN).projectDocs?.documentTip, payload.commit);
    // Selecting the post-snapshot head succeeds through the moved tip.
    const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c2a-tip");
    assert.equal(selected.status, "completed");
  } finally {
    await manager?.close();
    store?.close();
    await repo.close();
  }
});

test("C2a M1: the gate binds to the latest handoff request, not an earlier snapshot", async () => {
  const RUN = "run-c2a-stale-stop";
  const root = mkdtempSync(join(tmpdir(), "aiboard c2a stale "));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore: evidence });
  try {
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    for (const input of v2PlanOnlySeed(RUN)) store.append(input);
    store.append(e("project.handoff_requested", "handoff-1", "architect", "architect", { summary: COMPLETION_SUMMARY }));
    const stop1 = store.readRun(RUN).find((event) => event.type === "project.handoff_requested")!;
    assert.equal(rebuildSchedulerProjection(store.readRun(RUN)).projectHandoff?.requestedSequence, stop1.sequence);
    const snapshotPayload = (stopSequence: number) => ({
      stopSequence,
      stopKind: "plan_only",
      revision: "revision_value",
      commit: "c".repeat(40),
      parent: "p".repeat(40),
      head: "c".repeat(40),
      bodyDigest: "d".repeat(64),
      paths: ["docs/project/STATE.md"],
      // C2b: the reducer requires the commit-tree proof for the v2 entries.
      previousSnapshotEdited: false,
      agentsSectionCommitted: true,
      claudeLineCommitted: true,
    });
    store.append(e("project_docs.handoff_snapshot_committed", `handoff-snapshot:${stop1.sequence}`, "runner", "build-runtime", snapshotPayload(stop1.sequence)));
    // Guidance withdraws the handoff; the Architect requests again (stop 2).
    store.append(e("user.guidance_submitted", "guidance-1", "user", "local-user", {
      guidanceId: "guidance-1",
      text: "Hold the handoff and re-verify the plan.",
      version: 1,
      interruptionProtocolVersion: 1,
    }));
    store.append(e("user.guidance_interruption_completed", "guidance-1:interruption", "runner", "build-manager", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
    }));
    const acknowledgementEvidence = evidence.record({
      runId: RUN,
      taskId: "architect",
      actor: { role: "architect", id: "architect" },
      fact: {
        kind: "browser_screenshot",
        label: "the plan already incorporates the withdrawing guidance",
        capturedAt: CLOCK,
        screenshotArtifactHash: "c".repeat(64),
        mediaType: "image/png",
        byteLength: 1,
      },
      createdAt: CLOCK,
      idempotencyKey: "guidance-stale-stop:evidence",
    });
    store.append(e("user.guidance_acknowledged", "guidance-1:ack", "architect", "architect", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
      resolution: {
        type: "no_plan_change",
        rationale: "The initial plan already incorporates the durable guidance.",
        evidenceIds: [acknowledgementEvidence.id],
      },
    }));
    assert.equal(rebuildSchedulerProjection(store.readRun(RUN)).projectHandoff, undefined);
    store.append(e("project.handoff_requested", "handoff-2", "architect", "architect", { summary: COMPLETION_SUMMARY }));
    const stop2 = [...store.readRun(RUN)].reverse().find((event) => event.type === "project.handoff_requested")!;
    assert.notEqual(stop2.sequence, stop1.sequence);
    // The stop-1 snapshot no longer satisfies the gate.
    const unusedPort: ProjectDocsPort = {
      commit: async () => {
        throw new Error("the stale-stop test never touches the docs port");
      },
      commitHandoffSnapshot: async () => {
        throw new Error("the stale-stop test never touches the docs port");
      },
      readHandoffSnapshotFile: async () => {
        throw new Error("the stale-stop test never touches the docs port");
      },
      readIntegrationTipFile: async () => {
        throw new Error("the stale-stop test never touches the docs port");
      },
      findTrackedFileWithDigest: async () => {
        throw new Error("the stale-stop test never touches the docs port");
      },
      findHandoffSnapshotCommit: async () => {
        throw new Error("the stale-stop test never touches the docs port");
      },
      readIntegrationBaselineRevision: async () => {
        throw new Error("the stale-stop test never touches the docs port");
      },
      relateRevision: async () => "strict_descendant" as const,
    };
    const runtime = buildRuntimeForHandoff({
      runId: RUN,
      store,
      projectDocs: unusedPort,
      architect: silentArchitect(),
      clock: advancingClock(),
      runPolicy: "plan_only",
    });
    assert.throws(
      () => runtime.selectProjectHandoff(
        "keep_integration_branch",
        { integrationRevision: "revision_value", integrationBranch: "aiboard/integration/c2a-stale", appliedToProject: false },
        "handoff:c2a-stale-early",
      ),
      /kernel handoff snapshot/,
    );
    store.append(e("project_docs.handoff_snapshot_committed", `handoff-snapshot:${stop2.sequence}`, "runner", "build-runtime", snapshotPayload(stop2.sequence)));
    const selected = runtime.selectProjectHandoff(
      "keep_integration_branch",
      { integrationRevision: "revision_value", integrationBranch: "aiboard/integration/c2a-stale", appliedToProject: false },
      "handoff:c2a-stale",
    );
    assert.equal(selected.status, "completed");
  } finally {
    store.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("C2a M3: snapshot reuse requires every runner trailer, not just the key line", async () => {
  const RUN = "run-c2a-trailers";
  const repo = await openGitRepo("trailers", RUN);
  try {
    const key = "handoff-snapshot:999";
    // A foreign commit carrying only the key line (as a cherry-picked worker
    // message would): it must NOT be reused.
    const worktreeFile = join(repo.integration.path, "docs", "project", "STATE.md");
    mkdirSync(join(repo.integration.path, "docs", "project"), { recursive: true });
    writeFileSync(worktreeFile, "foreign body\n");
    await runGit({ cwd: repo.integration.path, args: ["add", "--", "docs/project/STATE.md"] });
    await runGit({
      cwd: repo.integration.path,
      args: ["commit", "-m", "worker summary with several lines", "--trailer", `AIBoard-Snapshot-Key: ${key}`],
    });
    const foreign = await runGit({ cwd: repo.integration.path, args: ["rev-parse", "HEAD"] });
    const first = await repo.integration.commitHandoffSnapshot({
      writes: [{ path: "docs/project/STATE.md", content: "kernel body\n" }],
      summary: "kernel attempt",
      runId: RUN,
      snapshotKey: key,
    });
    assert.notEqual(first.commit, foreign.stdout.trim(), "a commit without the runner trailers is not reused");
    const both = await runGit({ cwd: repo.integration.path, args: ["rev-list", "--count", `${repo.baselineRevision}..HEAD`] });
    assert.equal(both.stdout.trim(), "2");
    // The genuine runner commit carries every trailer and IS reused.
    const message = await runGit({ cwd: repo.integration.path, args: ["log", "-1", "--format=%B", first.commit] });
    for (const trailer of [`AIBoard-Run: ${RUN}`, "AIBoard-Author: runner", "AIBoard-Generated: handoff-snapshot", `AIBoard-Snapshot-Key: ${key}`]) {
      assert.ok(message.stdout.split("\n").some((line) => line.trim() === trailer), `missing trailer ${trailer}`);
    }
    const second = await repo.integration.commitHandoffSnapshot({
      writes: [{ path: "docs/project/STATE.md", content: "kernel body\n" }],
      summary: "kernel attempt",
      runId: RUN,
      snapshotKey: key,
    });
    assert.equal(second.commit, first.commit, "the runner-authored commit is reused");
    const still = await runGit({ cwd: repo.integration.path, args: ["rev-list", "--count", `${repo.baselineRevision}..HEAD`] });
    assert.equal(still.stdout.trim(), "2");
    const read = await repo.integration.readHandoffSnapshotFile({ commit: first.commit, path: "docs/project/STATE.md" });
    assert.equal(read.content, "kernel body\n");
    assert.deepEqual(read.paths, ["docs/project/STATE.md"]);
  } finally {
    await repo.close();
  }
});

test("C2a: an answered docs-v2 run writes nothing and completes", async () => {
  const RUN = "run-c2a-answered";
  const repo = await openGitRepo("answered", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const seeder = new SqliteSchedulerStore(schedulerPath);
  for (const input of v2AnsweredSeed(RUN)) seeder.append(input);
  seeder.close();
  const hooks: DocsPortHooks = { snapshotCalls: [], readCalls: [] };
  const architect = silentArchitect("The value module must export 2.");
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath);
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration, hooks),
          architect, clock: advancingClock(), runPolicy: "finish",
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "no-integration", integrationBranch: "b", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "finish"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    assert.equal(manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    assert.equal(hooks.snapshotCalls?.length, 0, "an answered run makes no snapshot commit call");
    assert.equal(hooks.readCalls?.length, 0, "an answered run makes no snapshot read call");
    assert.equal(manager.projection(RUN).status, "completed");
    const count = await runGit({ cwd: repo.integration.path, args: ["rev-list", "--count", `${repo.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "0", "an answered run writes no project file");
  } finally {
    await manager?.close();
    store?.close();
    await repo.close();
  }
});

test("C2a: a seeded docs-v1 run still requires the model-written STATE.md exactly as before", async () => {
  const RUN = "run-c2a-v1";
  const root = mkdtempSync(join(tmpdir(), "aiboard c2a v1 "));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    store.append(e("project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 1 }));
    store.append(e("run.initialized", "run-initialized", "runner", "build-runtime", {}));
    store.append(e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "plan_only" }));
    store.append(e("plan.created", "plan", "architect", "architect", { revision: 1, tasks: [] }));
    assert.equal(store.readRun(RUN).length, 4);
    let projection = rebuildSchedulerProjection(store.readRun(RUN));
    assert.equal(projection.projectDocsPolicyVersion, 1);
    const before = buildCompletionReadiness(projection);
    assert.equal(before.ready, false);
    assert.ok(before.issues.some((issue) => issue.includes("docs/project/STATE.md has not been committed.")), before.issues.join(" | "));
    store.append(e("project_doc.requested", "req-state", "architect", "architect", {
      requestId: "req-state",
      path: "docs/project/STATE.md",
      contentArtifactHash: "a".repeat(64),
      contentBytes: 10,
      summary: "Write the project state",
    }));
    store.append(e("project_doc.committed", "commit-state", "runner", "integration-manager", {
      requestId: "req-state",
      path: "docs/project/STATE.md",
      commit: "c".repeat(40),
      parent: "p".repeat(40),
      head: "c".repeat(40),
      readme: true,
      agentsMarkedSection: true,
      claudePointer: true,
    }));
    projection = rebuildSchedulerProjection(store.readRun(RUN));
    const after = buildCompletionReadiness(projection);
    assert.deepEqual(after.issues, [], after.issues.join(" | "));
    assert.equal(after.ready, true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("C2a: run.completed is refused before the kernel event and accepted after it", () => {
  const RUN = "run-c2a-completed";
  const root = mkdtempSync(join(tmpdir(), "aiboard c2a completed "));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    for (const input of v2PlanOnlySeed(RUN)) store.append(input);
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    store.append(e("project.handoff_requested", "handoff-requested", "architect", "architect", { summary: COMPLETION_SUMMARY }));
    const stop = store.readRun(RUN).find((event) => event.type === "project.handoff_requested")!;
    assert.throws(
      () => store.append(e("run.completed", "completed-early", "architect", "architect", {})),
      /kernel handoff snapshot/,
    );
    store.append(e("run.paused", "paused-failure", "runner", "build-runtime", { reason: "handoff_snapshot_failed" }));
    store.append(e("project_docs.handoff_snapshot_committed", `handoff-snapshot:${stop.sequence}`, "runner", "build-runtime", {
      stopSequence: stop.sequence,
      stopKind: "plan_only",
      revision: "revision_value",
      commit: "c".repeat(40),
      parent: "p".repeat(40),
      head: "c".repeat(40),
      bodyDigest: "d".repeat(64),
      paths: ["docs/project/STATE.md"],
      // C2b: the reducer requires the commit-tree proof for the v2 entries.
      previousSnapshotEdited: false,
      agentsSectionCommitted: true,
      claudeLineCommitted: true,
    }));
    const projection = rebuildSchedulerProjection(store.readRun(RUN));
    assert.equal(projection.pauseReason, undefined, "the snapshot event clears its failure pause");
    assert.equal(projection.projectDocs?.snapshots?.length, 1);
    store.append(e("run.completed", "completed", "architect", "architect", {}));
    assert.equal(rebuildSchedulerProjection(store.readRun(RUN)).status, "completed");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("C2a: the snapshot gate only fires for non-answered docs-v2 runs", () => {
  const RUN = "run-c2a-gate";
  const root = mkdtempSync(join(tmpdir(), "aiboard c2a gate "));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    store.append(e("project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 2 }));
    store.append(e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "finish" }));
    const v2 = () => rebuildSchedulerProjection(store.readRun(RUN));
  const snapshotRecord = {
    stopSequence: 10,
    stopKind: "completed",
    revision: "rev-1",
    commit: "c1",
    parent: "p",
    head: "h1",
    bodyDigest: "d".repeat(64),
    paths: ["docs/project/STATE.md"],
    sequence: 11,
    // C2b: the full AR-R05 gate needs the commit-tree proof for the entries.
    previousSnapshotEdited: false,
    agentsSectionCommitted: true,
    claudeLineCommitted: true,
  };
  // C2b repair N-7: the gate binds to a requested stop, so every
  // snapshot-bearing fixture below carries the matching request (stop 10).
  const withStop10Request = (projection: ReturnType<typeof v2>): ReturnType<typeof v2> => {
    projection.projectHandoff = {
      status: "requested",
      summary: "ready",
      requestedSequence: 10,
      options: ["keep_integration_branch", "apply_to_project"],
    };
    return projection;
  };
  assert.throws(() => assertHandoffSnapshotGate(v2(), "rev-1"), /kernel handoff snapshot/);
  const covered = withStop10Request(v2());
  covered.projectDocs = { pending: [], snapshots: [{ ...snapshotRecord }] };
  assertHandoffSnapshotGate(covered, "rev-1");
  assertHandoffSnapshotGate(covered, "c1");
  assertHandoffSnapshotGate(covered, "h1");
  assert.throws(() => assertHandoffSnapshotGate(covered, "rev-2"), /kernel handoff snapshot/);
  // M1: the gate binds to the latest request stop, never an earlier snapshot.
  const requested = v2();
  requested.projectHandoff = {
    status: "requested",
    summary: "ready",
    requestedSequence: 10,
    options: ["keep_integration_branch", "apply_to_project"],
  };
  requested.projectDocs = { pending: [], snapshots: [{ ...snapshotRecord, stopSequence: 9 }] };
  assert.throws(() => assertHandoffSnapshotGate(requested, "rev-1"), /kernel handoff snapshot/);
  requested.projectDocs = { pending: [], snapshots: [{ ...snapshotRecord, stopSequence: 10 }] };
  assertHandoffSnapshotGate(requested, "rev-1");
  const requestedPlanOnly = v2();
  requestedPlanOnly.runPolicy = "plan_only";
  requestedPlanOnly.projectHandoff = {
    status: "requested",
    summary: "ready",
    requestedSequence: 10,
    options: ["keep_integration_branch", "apply_to_project"],
  };
  requestedPlanOnly.projectDocs = { pending: [], snapshots: [{ ...snapshotRecord, stopSequence: 9 }] };
  assert.throws(() => assertHandoffSnapshotGate(requestedPlanOnly, undefined), /kernel handoff snapshot/);
  requestedPlanOnly.projectDocs = { pending: [], snapshots: [{ ...snapshotRecord, stopSequence: 10 }] };
  assertHandoffSnapshotGate(requestedPlanOnly, undefined);
  const noState = withStop10Request(v2());
  noState.projectDocs = { pending: [], snapshots: [{ ...snapshotRecord, paths: ["docs/project/AGENTS.md"] }] };
  assert.throws(() => assertHandoffSnapshotGate(noState, "rev-1"), /kernel handoff snapshot/);
  // C2b (AR-R05): the gate refuses when the committed tree lacks the v2
  // AGENTS.md section or the marked CLAUDE.md line.
  const noAgents = withStop10Request(v2());
  noAgents.projectDocs = { pending: [], snapshots: [{ ...snapshotRecord, agentsSectionCommitted: false }] };
  assert.throws(() => assertHandoffSnapshotGate(noAgents, "rev-1"), /kernel handoff snapshot/);
  const noClaude = withStop10Request(v2());
  noClaude.projectDocs = { pending: [], snapshots: [{ ...snapshotRecord, claudeLineCommitted: false }] };
  assert.throws(() => assertHandoffSnapshotGate(noClaude, "rev-1"), /kernel handoff snapshot/);
  // C2b (CD-5): export_only satisfies the gate by the recorded run option,
  // with no snapshot at all.
  const exportOnly = v2();
  exportOnly.handoffFiles = "export_only";
  assertHandoffSnapshotGate(exportOnly, "rev-1");
  assert.equal(handoffSnapshotCoversRevision(covered, "rev-1"), true);
  assert.equal(handoffSnapshotCoversRevision(covered, "rev-2"), false);
  const planOnly = withStop10Request(v2());
  planOnly.runPolicy = "plan_only";
  assert.throws(() => assertHandoffSnapshotGate(planOnly, undefined), /kernel handoff snapshot/);
  planOnly.projectDocs = { pending: [], snapshots: [{ ...snapshotRecord }] };
  assertHandoffSnapshotGate(planOnly, undefined);
  const v1 = v2();
  v1.projectDocsPolicyVersion = 1;
  assertHandoffSnapshotGate(v1, "rev-1");
  const answered = v2();
  answered.planningPolicyVersion = 1;
  answered.planningTriageDecision = "answer";
  assertHandoffSnapshotGate(answered, "rev-1");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * C2b (AR-R04): the handoff commit holds STATE.md plus the spliced v2
 * AGENTS.md section and the marked `@AGENTS.md` line. Bytes outside the
 * markers survive byte-for-byte; the proof is recorded and the production
 * manager selection completes. Driven through the production
 * NativeBuildManager with no manual step.
 */
test("C2b: the handoff commit splices the v2 entry lines, keeping outside bytes", async () => {
  const RUN = "run-c2b-entries";
  const repo = await openGitRepo("entries", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const seeder = new SqliteSchedulerStore(schedulerPath);
  for (const input of v2PlanOnlySeed(RUN)) seeder.append(input);
  seeder.close();
  // Pre-existing entry files with content outside the markers.
  const agentsBefore = "# Custom rules\nkeep me\n";
  const claudeBefore = "# Claude notes\nkeep me too\n";
  writeFileSync(join(repo.integration.path, "AGENTS.md"), agentsBefore);
  writeFileSync(join(repo.integration.path, "CLAUDE.md"), claudeBefore);
  await runGit({ cwd: repo.integration.path, args: ["add", "--", "AGENTS.md", "CLAUDE.md"] });
  await runGit({ cwd: repo.integration.path, args: ["commit", "-m", "pre-existing entry files"] });
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath);
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration),
          architect, clock: advancingClock(), runPolicy: "plan_only",
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    const commit = String(payload.commit);
    const files = await runGit({ cwd: repo.integration.path, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"]);
    const agents = await runGit({ cwd: repo.integration.path, args: ["show", `${commit}:AGENTS.md`] });
    assert.ok(agents.stdout.startsWith(agentsBefore), "bytes outside the markers are kept byte-for-byte");
    assert.ok(agents.stdout.includes(V2_AGENTS_SECTION_BODY), "the static v2 section is spliced in");
    const claude = await runGit({ cwd: repo.integration.path, args: ["show", `${commit}:CLAUDE.md`] });
    assert.ok(claude.stdout.startsWith(claudeBefore), "bytes outside the markers are kept byte-for-byte");
    assert.ok(claude.stdout.split("\n").some((line) => line.trim() === V2_CLAUDE_POINTER_LINE), "the marked @AGENTS.md line is spliced in");
    assert.equal(payload.agentsSectionCommitted, true);
    assert.equal(payload.claudeLineCommitted, true);
    const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c2b-entries");
    assert.equal(selected.status, "completed");
  } finally {
    await manager?.close();
    store?.close();
    await repo.close();
  }
});

test("C2b: missing AGENTS.md and CLAUDE.md are created with just the section", async () => {
  const RUN = "run-c2b-entries-missing";
  const repo = await openGitRepo("entries-missing", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const seeder = new SqliteSchedulerStore(schedulerPath);
  for (const input of v2PlanOnlySeed(RUN)) seeder.append(input);
  seeder.close();
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath);
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration),
          architect, clock: advancingClock(), runPolicy: "plan_only",
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const commit = String((snapshots[0]!.payload as Record<string, unknown>).commit);
    const agents = await runGit({ cwd: repo.integration.path, args: ["show", `${commit}:AGENTS.md`] });
    assert.equal(agents.stdout, `${AGENTS_SECTION_START}\n${V2_AGENTS_SECTION_BODY}\n${AGENTS_SECTION_END}\n`);
    const claude = await runGit({ cwd: repo.integration.path, args: ["show", `${commit}:CLAUDE.md`] });
    assert.equal(claude.stdout, `${AGENTS_SECTION_START}\n${V2_CLAUDE_POINTER_LINE}\n${AGENTS_SECTION_END}\n`);
  } finally {
    await manager?.close();
    store?.close();
    await repo.close();
  }
});

test("C2b: the verbatim spec copy is committed when due", async () => {
  const RUN = "run-c2b-speccopy";
  const repo = await openGitRepo("speccopy", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const seeder = new SqliteSchedulerStore(schedulerPath);
  for (const input of v2PlanOnlySeed(RUN)) seeder.append(input);
  seeder.close();
  // The approved source's bytes live in the artifact store under the
  // manifest artifact digest (the T7a provisioning path in miniature).
  const artifacts = new ArtifactStore(join(repo.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath);
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration),
          architect, clock: advancingClock(), runPolicy: "plan_only", artifacts,
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.specPath, "docs/project/specs/source_value.md");
    assert.equal(payload.specCopied, true);
    const commit = String(payload.commit);
    const copy = await runGit({ cwd: repo.integration.path, args: ["show", `${commit}:docs/project/specs/source_value.md`] });
    assert.equal(copy.stdout, SOURCE_TEXT, "the copy holds the approved verbatim bytes");
    const state = await runGit({ cwd: repo.integration.path, args: ["show", `${commit}:docs/project/STATE.md`] });
    assert.ok(state.stdout.includes("spec: docs/project/specs/source_value.md"), "the snapshot names the copy path");
  } finally {
    await manager?.close();
    store?.close();
    await repo.close();
  }
});

test("C2b: the spec copy is skipped when the run opts out", async () => {
  const RUN = "run-c2b-specoptout";
  const repo = await openGitRepo("specoptout", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const seeder = new SqliteSchedulerStore(schedulerPath);
  for (const input of withRunOptions(v2PlanOnlySeed(RUN), { specCopy: false })) seeder.append(input);
  seeder.close();
  const artifacts = new ArtifactStore(join(repo.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath);
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration),
          architect, clock: advancingClock(), runPolicy: "plan_only", artifacts, specCopy: false,
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.ok(!("specPath" in payload), "no spec path is recorded");
    assert.ok(!("specCopied" in payload), "no spec copy is recorded");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: repo.integration.path, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"]);
    // The opt-out skips only the copy: the snapshot still gates completion.
    const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c2b-specoptout");
    assert.equal(selected.status, "completed");
  } finally {
    await manager?.close();
    store?.close();
    await repo.close();
  }
});

test("C2b: export_only writes nothing at handoff and completes", async () => {
  const RUN = "run-c2b-exportonly";
  const repo = await openGitRepo("exportonly", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const seeder = new SqliteSchedulerStore(schedulerPath);
  for (const input of withRunOptions(v2PlanOnlySeed(RUN), { handoffFiles: "export_only" })) seeder.append(input);
  seeder.close();
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath);
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration),
          architect, clock: advancingClock(), runPolicy: "plan_only", handoffFiles: "export_only",
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    assert.equal(manager.projection(RUN).projectHandoff?.status, "requested");
    assert.equal(manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    const count = await runGit({ cwd: repo.integration.path, args: ["rev-list", "--count", `${repo.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "0", "export_only writes no file at handoff");
    // The recorded option satisfies the gate: the owner's selection completes.
    const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c2b-exportonly");
    assert.equal(selected.status, "completed");
  } finally {
    await manager?.close();
    store?.close();
    await repo.close();
  }
});

test("C2b: a reused commit without the v2 entry lines fails instead of recording", async () => {
  const RUN = "run-c2b-stateless-reuse";
  const repo = await openGitRepo("stateless-reuse", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const seeder = new SqliteSchedulerStore(schedulerPath);
  for (const input of v2PlanOnlySeed(RUN)) seeder.append(input);
  seeder.append(seedEvent(RUN, "project.handoff_requested", "handoff-requested", "architect", "architect", { summary: COMPLETION_SUMMARY }));
  const requested = seeder.readRun(RUN).find((event) => event.type === "project.handoff_requested")!;
  const stopProjection = rebuildSchedulerProjection(seeder.readRun(RUN).filter((event) => event.sequence <= requested.sequence));
  // A crashed C2a-era attempt committed STATE.md only, with the same key.
  const body = renderHandoffSnapshot(handoffSnapshotInputFromProjection(stopProjection, { stopAt: requested.occurredAt, revision: "revision_value" }));
  await repo.integration.commitHandoffSnapshot({
    writes: [{ path: "docs/project/STATE.md", content: body }],
    summary: "crashed STATE-only attempt with the same snapshot key",
    runId: RUN,
    snapshotKey: `handoff-snapshot:${requested.sequence}`,
  });
  seeder.close();
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath);
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration),
          architect, clock: advancingClock(), runPolicy: "plan_only",
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    // The reused commit is verified, not trusted: without the v2 entries the
    // snapshot pauses instead of recording a false proof.
    assert.equal(manager.projection(RUN).pauseReason?.reason, "handoff_snapshot_failed");
    assert.match(String(manager.projection(RUN).pauseReason?.detail ?? ""), /v2 AGENTS/);
    assert.equal(manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    const count = await runGit({ cwd: repo.integration.path, args: ["rev-list", "--count", `${repo.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "1", "no second commit is created");
  } finally {
    await manager?.close();
    store?.close();
    await repo.close();
  }
});

test("C2b: the spec copy is skipped when the source is already a repository file", async () => {
  const RUN = "run-c2b-specinrepo";
  const repo = await openGitRepo("specinrepo", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const seeder = new SqliteSchedulerStore(schedulerPath);
  for (const input of v2PlanOnlySeed(RUN)) seeder.append(input);
  seeder.close();
  // The approved bytes already live in the repo under another path.
  mkdirSync(join(repo.integration.path, "brief"), { recursive: true });
  writeFileSync(join(repo.integration.path, "brief", "spec.md"), SOURCE_TEXT);
  await runGit({ cwd: repo.integration.path, args: ["add", "--", "brief/spec.md"] });
  await runGit({ cwd: repo.integration.path, args: ["commit", "-m", "approved spec already in the repo"] });
  const artifacts = new ArtifactStore(join(repo.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath);
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration),
          architect, clock: advancingClock(), runPolicy: "plan_only", artifacts,
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.specPath, "brief/spec.md", "the existing repo path is recorded");
    assert.ok(!("specCopied" in payload), "no copy is written");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: repo.integration.path, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"]);
  } finally {
    await manager?.close();
    store?.close();
    await repo.close();
  }
});


test("C2b: a hand-edited STATE.md is detected and named in the next snapshot", async () => {
  const RUN = "run-c2b-handedit";
  const repo = await openGitRepo("handedit", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(repo.root, "evidence.sqlite"));
  const seeder = new SqliteSchedulerStore(schedulerPath);
  for (const input of v2PlanOnlySeed(RUN)) seeder.append(input);
  seeder.close();
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath, { evidenceStore: evidence });
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration),
          architect, clock: advancingClock(), runPolicy: "plan_only", evidenceStore: evidence,
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    // Snapshot 1: a CRLF/BOM-free clean chain is not flagged.
    const first = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(first.length, 1);
    const firstPayload = first[0]!.payload as Record<string, unknown>;
    assert.equal(firstPayload.previousSnapshotEdited, false);
    const firstBody = await runGit({ cwd: repo.integration.path, args: ["show", `${String(firstPayload.commit)}:docs/project/STATE.md`] });
    assert.equal(firstBody.stdout.includes("edited outside AIBoard"), false);
    // A hand edit lands in a commit outside AIBoard.
    writeFileSync(join(repo.integration.path, "docs", "project", "STATE.md"), `${firstBody.stdout}hand-edited outside AIBoard\n`);
    await runGit({ cwd: repo.integration.path, args: ["add", "--", "docs/project/STATE.md"] });
    await runGit({ cwd: repo.integration.path, args: ["commit", "-m", "hand edit outside AIBoard"] });
    // Guidance withdraws the handoff; the Architect re-requests (stop 2).
    assert.ok(store);
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    store.append(e("user.guidance_submitted", "guidance-1", "user", "local-user", {
      guidanceId: "guidance-1",
      text: "Hold the handoff and re-verify the plan.",
      version: 1,
      interruptionProtocolVersion: 1,
    }));
    store.append(e("user.guidance_interruption_completed", "guidance-1:interruption", "runner", "build-manager", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
    }));
    const acknowledgementEvidence = evidence.record({
      runId: RUN,
      taskId: "architect",
      actor: { role: "architect", id: "architect" },
      fact: {
        kind: "browser_screenshot",
        label: "the plan already incorporates the withdrawing guidance",
        capturedAt: CLOCK,
        screenshotArtifactHash: "c".repeat(64),
        mediaType: "image/png",
        byteLength: 1,
      },
      createdAt: CLOCK,
      idempotencyKey: "guidance-stale-stop:evidence",
    });
    store.append(e("user.guidance_acknowledged", "guidance-1:ack", "architect", "architect", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
      resolution: {
        type: "no_plan_change",
        rationale: "The initial plan already incorporates the durable guidance.",
        evidenceIds: [acknowledgementEvidence.id],
      },
    }));
    store.append(e("project.handoff_requested", "handoff-2", "architect", "architect", { summary: COMPLETION_SUMMARY }));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 2);
    const second = snapshots[1]!.payload as Record<string, unknown>;
    assert.equal(second.previousSnapshotEdited, true);
    const secondBody = await runGit({ cwd: repo.integration.path, args: ["show", `${String(second.commit)}:docs/project/STATE.md`] });
    assert.ok(secondBody.stdout.includes("The previous snapshot was edited outside AIBoard; see this file's git history."));
    const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c2b-handedit");
    assert.equal(selected.status, "completed");
  } finally {
    await manager?.close();
    store?.close();
    evidence.close();
    await repo.close();
  }
});

test("C2b N1 probe F: a withdrawn-stop commit is recorded, never stuck, never mutating", async () => {
  const RUN = "run-c2b-probef";
  const repo = await openGitRepo("probef", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(repo.root, "evidence.sqlite"));
  const seeder = new SqliteSchedulerStore(schedulerPath);
  for (const input of v2PlanOnlySeed(RUN)) seeder.append(input);
  seeder.close();
  const hooks: DocsPortHooks = { failNextSnapshot: true, snapshotCalls: [], readCalls: [] };
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath, { evidenceStore: evidence });
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration, hooks),
          architect, clock: advancingClock(), runPolicy: "plan_only", evidenceStore: evidence,
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    // The first attempt fails before landing: requested, paused, no commit.
    assert.equal(manager.projection(RUN).pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    // Guidance withdraws the handoff while the kernel commit is in flight.
    assert.ok(store);
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    store.append(e("user.guidance_submitted", "guidance-1", "user", "local-user", {
      guidanceId: "guidance-1",
      text: "Hold the handoff and re-verify the plan.",
      version: 1,
      interruptionProtocolVersion: 1,
    }));
    store.append(e("user.guidance_interruption_completed", "guidance-1:interruption", "runner", "build-manager", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
    }));
    const acknowledgementEvidence = evidence.record({
      runId: RUN,
      taskId: "architect",
      actor: { role: "architect", id: "architect" },
      fact: {
        kind: "browser_screenshot",
        label: "the plan already incorporates the withdrawing guidance",
        capturedAt: CLOCK,
        screenshotArtifactHash: "c".repeat(64),
        mediaType: "image/png",
        byteLength: 1,
      },
      createdAt: CLOCK,
      idempotencyKey: "guidance-stale-stop:evidence",
    });
    store.append(e("user.guidance_acknowledged", "guidance-1:ack", "architect", "architect", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
      resolution: {
        type: "no_plan_change",
        rationale: "The initial plan already incorporates the durable guidance.",
        evidenceIds: [acknowledgementEvidence.id],
      },
    }));
    // The in-flight kernel commit lands after the withdrawal: a real commit
    // with the stop-1 key and the full kernel tree.
    const logged = store.readRun(RUN);
    const stop1 = logged.find((event) => event.type === "project.handoff_requested")!;
    const stopProjection = rebuildSchedulerProjection(logged.filter((event) => event.sequence <= stop1.sequence));
    const lateBody = renderHandoffSnapshot(handoffSnapshotInputFromProjection(stopProjection, { stopAt: stop1.occurredAt, revision: "revision_value" }));
    const late = await repo.integration.commitHandoffSnapshot({
      writes: [
        { path: "docs/project/STATE.md", content: lateBody },
        { path: "AGENTS.md", content: V2_AGENTS_SECTION_BODY },
        { path: "CLAUDE.md", content: V2_CLAUDE_POINTER_LINE },
      ],
      summary: "late kernel commit for the withdrawn stop",
      runId: RUN,
      snapshotKey: `handoff-snapshot:${stop1.sequence}`,
    });
    const lateRead = await repo.integration.readHandoffSnapshotFile({ commit: late.commit, path: "docs/project/STATE.md" });
    // The late event append is accepted into history (N1): the commit moves
    // the tip, touches no run state, and never satisfies a later gate.
    store.append(e("project_docs.handoff_snapshot_committed", `handoff-snapshot:${stop1.sequence}`, "runner", "build-runtime", {
      stopSequence: stop1.sequence,
      stopKind: "plan_only",
      revision: "revision_value",
      commit: late.commit,
      parent: late.parent,
      head: late.head,
      bodyDigest: headerDigest(lateRead.content!),
      paths: lateRead.paths,
      previousSnapshotEdited: false,
      agentsSectionCommitted: true,
      claudeLineCommitted: true,
    }));
    const recorded = manager.projection(RUN);
    assert.equal(recorded.projectDocs?.snapshots?.length, 1);
    assert.equal(recorded.status, "running", "a withdrawn-stop record leaves the run state alone");
    assert.equal(recorded.pauseReason?.reason, "handoff_snapshot_failed", "the failure pause is not cleared by history");
    // Re-request: a fresh stop commits a fresh snapshot and completes. The
    // run was never stuck and the project was never mutated.
    store.append(e("project.handoff_requested", "handoff-2", "architect", "architect", { summary: COMPLETION_SUMMARY }));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 2);
    assert.equal((snapshots[1]!.payload as Record<string, unknown>).previousSnapshotEdited, false);
    assert.equal(architect.calls(), 1, "no model call follows the handoff wait");
    const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c2b-probef");
    assert.equal(selected.status, "completed");
    assert.equal(existsSync(join(repo.project, "docs", "project", "STATE.md")), false, "the project is untouched");
  } finally {
    await manager?.close();
    store?.close();
    evidence.close();
    await repo.close();
  }
});


test("C2b N1 probe G: a snapshot that breaks the chain is refused before any mutation", async () => {
  const RUN = "run-c2b-probeg";
  const repo = await openGitRepo("probeg", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(repo.root, "evidence.sqlite"));
  const seeder = new SqliteSchedulerStore(schedulerPath, {
    evidenceStore: evidence,
    validateExecutionProfile: acceptFinalVerificationProfile,
    validateCleanupReceipt: () => undefined,
  });
  for (const input of v2FinishSeed(RUN, repo.baselineRevision)) seeder.append(input);
  seeder.close();
  // The integration branch runs one commit ahead of the canonical revision,
  // so the kernel snapshot's parent continues neither the canonical
  // revision nor the document tip.
  writeFileSync(join(repo.integration.path, "unrelated.txt"), "unrelated work\n");
  await runGit({ cwd: repo.integration.path, args: ["add", "--", "unrelated.txt"] });
  await runGit({ cwd: repo.integration.path, args: ["commit", "-m", "unrelated work ahead of canonical"] });
  const architect = silentArchitect("The build is complete and verified.");
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  let physicalHandoffs = 0;
  const pumpErrors: string[] = [];
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath, {
          evidenceStore: evidence,
          validateExecutionProfile: acceptFinalVerificationProfile,
          validateCleanupReceipt: () => undefined,
        });
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration),
          architect, clock: advancingClock(), runPolicy: "finish", evidenceStore: evidence,
        });
        return managedHandle(runtime, async () => {
          physicalHandoffs += 1;
          return repo.integration.applyToProject();
        }, RUN);
      },
      onPumpError: (_runId, error) => { pumpErrors.push(String((error as Error)?.message ?? error)); },
    });
    await manager.create(managerSpec(RUN, "finish"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    // The snapshot is recorded (the commit landed) but moves no tip; the
    // shared predicate refuses the selection before any project mutation.
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    assert.equal(manager.projection(RUN).projectDocs?.documentTip, undefined);
    assert.equal(physicalHandoffs, 0, "no project mutation precedes the refusal");
    assert.equal(existsSync(join(repo.project, "docs", "project", "STATE.md")), false, "the project is untouched");
    assert.ok(pumpErrors.some((message) => message.includes("does not match the verified integration revision")));
    // The owner's selection is refused with the same kernel rule, and the
    // run is still at the handoff wait -- refused, not stuck terminally.
    await assert.rejects(
      manager.selectProjectHandoff(RUN, "apply_to_project", "handoff:c2b-probeg"),
      /does not match the verified integration revision/,
    );
    assert.equal(physicalHandoffs, 0);
    assert.equal(manager.projection(RUN).projectHandoff?.status, "requested");
  } finally {
    await manager?.close();
    store?.close();
    evidence.close();
    await repo.close();
  }
});

/**
 * C2b repair B1 (probe G2): final verification re-runs green on the unchanged
 * canonical revision after guidance withdrew the handoff. New generation ids;
 * same green approvals as the finish seed.
 */
function fvRerunSeed(runId: string, integrationRevision: string): NewSchedulerEvent[] {
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

test("C2b repair B1 probe G2: a withdrawn stop's landed commit is reconciled, the chain continues", async () => {
  const RUN = "run-c2b-g2";
  const repo = await openGitRepo("g2", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(repo.root, "evidence.sqlite"));
  const seeder = new SqliteSchedulerStore(schedulerPath, {
    evidenceStore: evidence,
    validateExecutionProfile: acceptFinalVerificationProfile,
    validateCleanupReceipt: () => undefined,
  });
  // The canonical revision is the real baseline, so the stop-1 kernel commit
  // continues the documents once it is recorded as history.
  for (const input of v2FinishSeed(RUN, repo.baselineRevision)) seeder.append(input);
  seeder.close();
  // The stop-1 commit lands, then the read-back fails: a transient failure
  // after the commit (or a crash before the append).
  const hooks: DocsPortHooks = { failNextRead: true, snapshotCalls: [], readCalls: [] };
  const architect = silentArchitect("The build is complete and verified.");
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  const order: string[] = [];
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath, {
          evidenceStore: evidence,
          validateExecutionProfile: acceptFinalVerificationProfile,
          validateCleanupReceipt: () => undefined,
        });
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration, hooks),
          architect, clock: advancingClock(), runPolicy: "finish", evidenceStore: evidence,
        });
        return managedHandle(runtime, async () => {
          // The real project mutation, spied: it must run only after the
          // kernel accepts the reconciled chain.
          order.push(`projectHandoff:${manager!.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length}`);
          const result = await repo.integration.applyToProject();
          order.push("applied");
          return result;
        }, RUN);
      },
    });
    await manager.create(managerSpec(RUN, "finish"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    assert.equal(manager.projection(RUN).pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    assert.deepEqual(order, [], "no project mutation precedes the kernel record");
    assert.equal(existsSync(join(repo.project, "docs", "project", "STATE.md")), false, "the project is untouched");
    const landed = await runGit({ cwd: repo.integration.path, args: ["rev-list", "--count", `${repo.baselineRevision}..HEAD`] });
    assert.equal(landed.stdout.trim(), "1", "the stop-1 kernel commit landed");
    const stop1 = manager.events(RUN).find((event) => event.type === "project.handoff_requested")!.sequence;
    // The owner submits guidance instead of resuming: the handoff is
    // withdrawn. The Architect acknowledges with no plan change.
    assert.ok(store);
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    store.append(e("user.guidance_submitted", "guidance-1", "user", "local-user", {
      guidanceId: "guidance-1",
      text: "Hold the handoff and re-verify the plan.",
      version: 1,
      interruptionProtocolVersion: 1,
    }));
    store.append(e("user.guidance_interruption_completed", "guidance-1:interruption", "runner", "build-manager", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
    }));
    const acknowledgementEvidence = evidence.record({
      runId: RUN,
      taskId: "architect",
      actor: { role: "architect", id: "architect" },
      fact: {
        kind: "browser_screenshot",
        label: "the plan already incorporates the withdrawing guidance",
        capturedAt: CLOCK,
        screenshotArtifactHash: "c".repeat(64),
        mediaType: "image/png",
        byteLength: 1,
      },
      createdAt: CLOCK,
      idempotencyKey: "guidance-stale-stop:evidence",
    });
    store.append(e("user.guidance_acknowledged", "guidance-1:ack", "architect", "architect", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
      resolution: {
        type: "no_plan_change",
        rationale: "The initial plan already incorporates the durable guidance.",
        evidenceIds: [acknowledgementEvidence.id],
      },
    }));
    const withdrawn = manager.projection(RUN);
    assert.equal(withdrawn.projectHandoff, undefined, "guidance withdrew the handoff");
    assert.equal((withdrawn.projectHandoffHistory ?? []).length, 1);
    // Final verification re-runs green on the unchanged canonical revision,
    // and the Architect re-requests (stop 2).
    for (const input of fvRerunSeed(RUN, repo.baselineRevision)) store.append(input);
    store.append(e("project.handoff_requested", "handoff-2", "architect", "architect", { summary: COMPLETION_SUMMARY }));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    // The withdrawn stop's landed commit was recorded as history before the
    // next stop committed: two snapshot events, one chain.
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 2);
    const first = snapshots[0]!.payload as Record<string, unknown>;
    const second = snapshots[1]!.payload as Record<string, unknown>;
    assert.equal(first.stopSequence, stop1, "the withdrawn stop is recorded first, as history");
    const restop = manager.events(RUN).filter((event) => event.type === "project.handoff_requested");
    assert.equal(second.stopSequence, restop[restop.length - 1]!.sequence, "the second record belongs to the re-request");
    assert.equal(second.parent, first.commit, "the new snapshot continues the withdrawn commit");
    assert.equal(manager.projection(RUN).projectDocs?.documentTip, second.commit);
    // The handoff succeeds only after the kernel record, and the project
    // holds the new snapshot.
    const projection = manager.projection(RUN);
    assert.equal(projection.status, "completed", "the handoff succeeds after reconciliation");
    assert.equal(projection.projectHandoff?.choice, "apply_to_project");
    assert.equal(architect.calls(), 1, "the kernel snapshot makes no model call");
    assert.deepEqual(order, ["projectHandoff:2", "applied"], "the project changes only after the kernel accepts");
    const stateShow = await runGit({ cwd: repo.integration.path, args: ["show", `${String(second.commit)}:docs/project/STATE.md`] });
    const applied = await runGit({ cwd: repo.project, args: ["show", "HEAD:docs/project/STATE.md"] });
    assert.equal(applied.stdout, stateShow.stdout, "the project holds the reconciled snapshot");
  } finally {
    await manager?.close();
    store?.close();
    evidence.close();
    await repo.close();
  }
});

test("C2b repair m2/probe H: a reused commit's event is derived from the commit, not fresh reads", async () => {
  const RUN = "run-c2b-reused-derive";
  const repo = await openGitRepo("reused-derive", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const seeder = new SqliteSchedulerStore(schedulerPath);
  for (const input of v2PlanOnlySeed(RUN)) seeder.append(input);
  seeder.close();
  // The tip STATE.md is hand-written outside AIBoard, and the spec copy is due.
  mkdirSync(join(repo.integration.path, "docs", "project"), { recursive: true });
  writeFileSync(join(repo.integration.path, "docs", "project", "STATE.md"), "hand-written outside AIBoard\n");
  await runGit({ cwd: repo.integration.path, args: ["add", "--", "docs/project/STATE.md"] });
  await runGit({ cwd: repo.integration.path, args: ["commit", "-m", "hand-written tip snapshot"] });
  const artifacts = new ArtifactStore(join(repo.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  // The commit lands, then the read-back fails; resume retries and reuses it.
  const hooks: DocsPortHooks = { failNextRead: true, snapshotCalls: [], readCalls: [] };
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath);
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration, hooks),
          architect, clock: advancingClock(), runPolicy: "plan_only", artifacts,
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    assert.equal(manager.projection(RUN).pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    await manager.resume(RUN, "resume:c2b-reused-derive");
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    // Derived from the reused commit: the committed STATE.md names the edit
    // and the commit holds the spec copy -- although fresh reads now say
    // clean (the tip IS the commit) and find the spec already tracked.
    assert.equal(payload.previousSnapshotEdited, true);
    assert.equal(payload.specCopied, true);
    assert.equal(payload.specPath, "docs/project/specs/source_value.md");
    const count = await runGit({ cwd: repo.integration.path, args: ["rev-list", "--count", `${repo.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "2", "no second commit: the landed commit is reused");
  } finally {
    await manager?.close();
    store?.close();
    await repo.close();
  }
});

test("C2b repair m4: a spec-copy search failure skips the copy, never the commit", async () => {
  const RUN = "run-c2b-spectracked-fail";
  const repo = await openGitRepo("spectracked-fail", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const seeder = new SqliteSchedulerStore(schedulerPath);
  for (const input of v2PlanOnlySeed(RUN)) seeder.append(input);
  seeder.close();
  const artifacts = new ArtifactStore(join(repo.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath);
        const base = gitDocsPort(repo.integration);
        const runtime = buildRuntimeForHandoff({
          runId: RUN,
          store,
          projectDocs: {
            ...base,
            findTrackedFileWithDigest: async () => {
              throw new Error("Injected tracked search failure.");
            },
          },
          architect, clock: advancingClock(), runPolicy: "plan_only", artifacts,
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the conditional copy never fails the snapshot commit");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.specCopySkipped, "tracked_search_failed");
    assert.ok(!("specCopied" in payload), "no copy is claimed");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: repo.integration.path, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"]);
  } finally {
    await manager?.close();
    store?.close();
    await repo.close();
  }
});

test("C2b repair m5: a CLAUDE.md link to AGENTS.md satisfies the line without writing through it", async () => {
  const RUN = "run-c2b-claudelink";
  const repo = await openGitRepo("claudelink", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const seeder = new SqliteSchedulerStore(schedulerPath);
  for (const input of v2PlanOnlySeed(RUN)) seeder.append(input);
  seeder.close();
  // A common layout: CLAUDE.md is a link to AGENTS.md.
  symlinkSync("AGENTS.md", join(repo.integration.path, "CLAUDE.md"), "file");
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath);
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration),
          architect, clock: advancingClock(), runPolicy: "plan_only",
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the link layout completes instead of failing every snapshot");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.claudeLineCommitted, true);
    assert.equal(payload.claudeLineViaLink, "CLAUDE.md is a symbolic link to AGENTS.md");
    assert.ok(lstatSync(join(repo.integration.path, "CLAUDE.md")).isSymbolicLink(), "never written through the link");
    const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c2b-claudelink");
    assert.equal(selected.status, "completed");
  } finally {
    await manager?.close();
    store?.close();
    rmSync(join(repo.integration.path, "CLAUDE.md"), { force: true });
    await repo.close();
  }
});

test("C2b repair m3: a non-UTF-8 AGENTS.md survives the kernel splice byte-for-byte", async () => {
  const RUN = "run-c2b-latin1";
  const repo = await openGitRepo("latin1", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const seeder = new SqliteSchedulerStore(schedulerPath);
  for (const input of v2PlanOnlySeed(RUN)) seeder.append(input);
  seeder.close();
  // Probe J shape: pre-existing Latin-1 bytes outside any markers.
  const latin1 = Buffer.from([0x23, 0x20, 0x52, 0xe9, 0x67, 0x6c, 0x65, 0x73, 0x0a]);
  writeFileSync(join(repo.integration.path, "AGENTS.md"), latin1);
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath);
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration),
          architect, clock: advancingClock(), runPolicy: "plan_only",
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.agentsSectionCommitted, true);
    const staged = readFileSync(join(repo.integration.path, "AGENTS.md"));
    assert.ok(staged.subarray(0, latin1.length).equals(latin1), "bytes outside the markers are kept exactly");
    assert.ok(staged.includes(V2_AGENTS_SECTION_BODY));
  } finally {
    await manager?.close();
    store?.close();
    await repo.close();
  }
});

test("C2b N2: an owner pause stacked on a snapshot failure still resumes to retry", async () => {
  const RUN = "run-c2b-stacked-pause";
  const repo = await openGitRepo("stacked-pause", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const seeder = new SqliteSchedulerStore(schedulerPath);
  for (const input of v2PlanOnlySeed(RUN)) seeder.append(input);
  seeder.close();
  const hooks: DocsPortHooks = { failNextSnapshot: true, snapshotCalls: [], readCalls: [] };
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath);
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration, hooks),
          architect, clock: advancingClock(), runPolicy: "plan_only",
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    assert.equal(manager.projection(RUN).pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    // An owner pause stacks on top of the snapshot failure through the
    // production pause path.
    await manager.pause(RUN, "owner_hold_for_review", "pause:owner-c2b-n2");
    assert.equal(manager.projection(RUN).pauseReason?.reason, "owner_hold_for_review");
    // Resume is allowed because a snapshot retry is pending for the current
    // stop -- not because of the current pause reason.
    await manager.resume(RUN, "resume:c2b-n2");
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const retried = manager.projection(RUN);
    assert.equal(retried.status, "paused");
    assert.equal(retried.projectHandoff?.status, "requested");
    assert.equal(retried.pauseReason, undefined);
    assert.equal(architect.calls(), 1, "the retry makes no model call");
    assert.equal(manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 1);
    const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c2b-n2");
    assert.equal(selected.status, "completed");
  } finally {
    await manager?.close();
    store?.close();
    await repo.close();
  }
});

test("C2b N4: a cherry-picked worker commit quoting the trailers is not reused", async () => {
  const RUN = "run-c2b-trailers-n4";
  const repo = await openGitRepo("trailers-n4", RUN);
  try {
    const key = "handoff-snapshot:4242";
    // A worker commit cherry-picked with -x keeps its message: the four
    // EXACT trailer lines sit mid-body, followed by the cherry-pick line --
    // never in the trailer block (C2b repair m7: the pre-N4 line-set rule
    // would reuse this message, so the test goes red without the N4 fix).
    // Even with the runner identity on it, the kernel must not reuse it.
    const quoted = [
      "worker summary with several lines",
      "",
      `AIBoard-Run: ${RUN}`,
      "AIBoard-Author: runner",
      "AIBoard-Generated: handoff-snapshot",
      `AIBoard-Snapshot-Key: ${key}`,
      "(cherry picked from commit abcdef1234567890abcdef1234567890abcdef12)",
    ].join("\n");
    const worktreeFile = join(repo.integration.path, "docs", "project", "STATE.md");
    mkdirSync(join(repo.integration.path, "docs", "project"), { recursive: true });
    writeFileSync(worktreeFile, "worker body\n");
    await runGit({ cwd: repo.integration.path, args: ["add", "--", "docs/project/STATE.md"] });
    await runGit({
      cwd: repo.integration.path,
      args: ["-c", "user.name=AIBoard Integrator", "-c", "user.email=integrator@aiboard.local", "commit", "-m", quoted],
    });
    const foreign = await runGit({ cwd: repo.integration.path, args: ["rev-parse", "HEAD"] });
    const kernel = await repo.integration.commitHandoffSnapshot({
      writes: [{ path: "docs/project/STATE.md", content: "kernel body\n" }],
      summary: "kernel attempt",
      runId: RUN,
      snapshotKey: key,
    });
    assert.notEqual(kernel.commit, foreign.stdout.trim(), "a mid-body-trailer commit is not reused even with the runner identity");
    const count = await runGit({ cwd: repo.integration.path, args: ["rev-list", "--count", `${repo.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "2");
  } finally {
    await repo.close();
  }
});


test("C2b CD-14: the reducer does not pair docs v2 with planning v1; run options parse", () => {
  const RUN = "run-c2b-m9";
  const root = mkdtempSync(join(tmpdir(), "aiboard c2b m9 "));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    store.append(e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "finish" }));
    // CD-14 (review probe I): a docs-v2 stamp without planning policy v1
    // is accepted -- the reducer does not enforce the pairing; T7a owns
    // production stamping and stamps both together at creation.
    store.append(e("project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 2 }));
    assert.equal(rebuildSchedulerProjection(store.readRun(RUN)).projectDocsPolicyVersion, 2);
    // Invalid run options are refused.
    assert.throws(
      () => store.append(e("run.policy_configured", "policy-bad", "runner", "build-runtime", { runPolicy: "finish", handoffFiles: "bogus" })),
      /handoffFiles/,
    );
    assert.throws(
      () => store.append(e("run.policy_configured", "policy-bad2", "runner", "build-runtime", { runPolicy: "finish", specCopy: "yes" })),
      /specCopy/,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
  // Legacy-planning runs keep docs v1.
  const legacyRoot = mkdtempSync(join(tmpdir(), "aiboard c2b legacy "));
  const legacy = new SqliteSchedulerStore(join(legacyRoot, "scheduler.sqlite"));
  try {
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    legacy.append(e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "finish" }));
    legacy.append(e("project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 1 }));
    assert.equal(rebuildSchedulerProjection(legacy.readRun(RUN)).projectDocsPolicyVersion, 1);
  } finally {
    legacy.close();
    rmSync(legacyRoot, { recursive: true, force: true });
  }
  // The creation-first docs-v2 stamp (sequence 1, the seed path) stays valid.
  const seedRoot = mkdtempSync(join(tmpdir(), "aiboard c2b seedfirst "));
  const seeded = new SqliteSchedulerStore(join(seedRoot, "scheduler.sqlite"));
  try {
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    seeded.append(e("project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 2 }));
    assert.equal(rebuildSchedulerProjection(seeded.readRun(RUN)).projectDocsPolicyVersion, 2);
  } finally {
    seeded.close();
    rmSync(seedRoot, { recursive: true, force: true });
  }
  // The spec parser accepts the new options and refuses invalid ones.
  const spec = managerSpec(RUN, "plan_only");
  validateBuildSpec({ ...spec, handoffFiles: "export_only", specCopy: false });
  validateBuildSpec(spec);
  assert.throws(() => validateBuildSpec({ ...spec, handoffFiles: "bogus" as "commit" }), /handoffFiles/);
  assert.throws(() => validateBuildSpec({ ...spec, specCopy: "yes" as unknown as boolean }), /specCopy/);
  // The spec-copy file stem never escapes its directory.
  assert.equal(sanitizeSpecSourceId("source_value"), "source_value");
  assert.equal(sanitizeSpecSourceId("a/b"), "a_b");
  assert.equal(sanitizeSpecSourceId(""), undefined);
  // C2b repair m4: Windows reserved stems fall back to a digest name, and
  // long stems are capped -- the copy never fails the snapshot commit.
  const reservedDigest = "b".repeat(64);
  assert.equal(sanitizeSpecSourceId("NUL", reservedDigest), `spec-${"b".repeat(16)}`);
  assert.equal(sanitizeSpecSourceId("NUL"), undefined);
  assert.equal(sanitizeSpecSourceId("CON.txt", reservedDigest), `spec-${"b".repeat(16)}`);
  assert.equal(sanitizeSpecSourceId("com1"), undefined);
  assert.equal(sanitizeSpecSourceId("aux.md", reservedDigest), `spec-${"b".repeat(16)}`);
  assert.equal(sanitizeSpecSourceId("x".repeat(300), reservedDigest), "x".repeat(100));
});

test("C2b: run options are recorded in run.policy_configured with durable defaults", () => {
  const throwingPort: ProjectDocsPort = {
    commit: async () => {
      throw new Error("the recording test never touches the docs port");
    },
    commitHandoffSnapshot: async () => {
      throw new Error("the recording test never touches the docs port");
    },
    readHandoffSnapshotFile: async () => {
      throw new Error("the recording test never touches the docs port");
    },
    readIntegrationTipFile: async () => {
      throw new Error("the recording test never touches the docs port");
    },
    findTrackedFileWithDigest: async () => {
      throw new Error("the recording test never touches the docs port");
    },
    findHandoffSnapshotCommit: async () => {
      throw new Error("the recording test never touches the docs port");
    },
    readIntegrationBaselineRevision: async () => {
      throw new Error("the recording test never touches the docs port");
    },
    relateRevision: async () => "strict_descendant" as const,
  };
  const RUN = "run-c2b-options";
  const root = mkdtempSync(join(tmpdir(), "aiboard c2b options "));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    buildRuntimeForHandoff({
      runId: RUN, store, projectDocs: throwingPort,
      architect: silentArchitect(), clock: advancingClock(), runPolicy: "plan_only",
      specCopy: false, handoffFiles: "export_only",
    });
    const policy = store.readRun(RUN).find((event) => event.type === "run.policy_configured")!;
    assert.equal((policy.payload as Record<string, unknown>).specCopy, false);
    assert.equal((policy.payload as Record<string, unknown>).handoffFiles, "export_only");
    const projection = rebuildSchedulerProjection(store.readRun(RUN));
    assert.equal(specCopyOf(projection), false);
    assert.equal(handoffFilesOf(projection), "export_only");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
  const defaultRoot = mkdtempSync(join(tmpdir(), "aiboard c2b defaults "));
  const defaults = new SqliteSchedulerStore(join(defaultRoot, "scheduler.sqlite"));
  try {
    buildRuntimeForHandoff({
      runId: RUN, store: defaults, projectDocs: throwingPort,
      architect: silentArchitect(), clock: advancingClock(), runPolicy: "plan_only",
    });
    const policy = defaults.readRun(RUN).find((event) => event.type === "run.policy_configured")!;
    assert.equal((policy.payload as Record<string, unknown>).specCopy, true);
    assert.equal((policy.payload as Record<string, unknown>).handoffFiles, "commit");
  } finally {
    defaults.close();
    rmSync(defaultRoot, { recursive: true, force: true });
  }
});

test("C2b repair m6: the shared selection predicate refuses an unresolved context note", () => {
  const RUN = "run-c2b-m6-note";
  const root = mkdtempSync(join(tmpdir(), "aiboard c2b m6note "));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    for (const input of v2PlanOnlySeed(RUN)) store.append(input);
    store.append(e("project.handoff_requested", "handoff-requested", "architect", "architect", { summary: COMPLETION_SUMMARY }));
    store.append(e("context_manifest.recording_failed", "note-m6", "runner", "build-runtime", {
      purpose: "worker:task",
      attempts: 3,
      reason: "disk full",
      taskId: "task_a",
      attempt: 1,
      revision: "rev-1",
    }));
    const projection = rebuildSchedulerProjection(store.readRun(RUN));
    // The shared rule refuses first: without the m6 move the predicate falls
    // through to the revision mismatch instead.
    assert.throws(
      () => assertProjectHandoffSelectionAccepted(projection, "a".repeat(40)),
      /Context recording failure must be resolved before completion or handoff/,
    );
    // The reducer case refuses with the same whole rule.
    assert.throws(
      () => store.append(e("project.handoff_selected", "handoff-select-m6", "user", "local-user", {
        choice: "keep_integration_branch",
        integrationRevision: "a".repeat(40),
        integrationBranch: "aiboard/run/integration",
        appliedToProject: false,
      })),
      /Context recording failure must be resolved before completion or handoff/,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("C2b repair m6: the shared selection predicate refuses an acceptance-contract upgrade", () => {
  const RUN = "run-c2b-m6-upgrade";
  const root = mkdtempSync(join(tmpdir(), "aiboard c2b m6upgrade "));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    // Legacy planning: a plan revision but no planning policy v1. The task
    // carries no acceptance criteria, so the upgrade gate is required.
    store.append(e("project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 2 }));
    store.append(e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "plan_only" }));
    store.append(e("plan.created", "plan", "architect", "architect", {
      revision: 1,
      tasks: [{
        id: "task_raw_legacy",
        objective: "Recover a raw pre-P1 task.",
        dependencies: [],
        status: "integrated",
        requiredCapabilities: ["code"],
        attempt: 1,
      }],
    }));
    store.append(e("acceptance_contract.upgrade_required", "upgrade-gate", "runner", "build-runtime", {
      taskIds: ["task_raw_legacy"],
    }));
    store.append(e("project.handoff_requested", "handoff-requested", "architect", "architect", { summary: COMPLETION_SUMMARY }));
    const projection = rebuildSchedulerProjection(store.readRun(RUN));
    assert.equal(projection.projectHandoff?.status, "requested");
    // The shared rule refuses first: without the m6 move the predicate falls
    // through to the revision mismatch instead.
    assert.throws(
      () => assertProjectHandoffSelectionAccepted(projection, "a".repeat(40)),
      /upgrades acceptance criteria/,
    );
    // The reducer case refuses with the same whole rule.
    assert.throws(
      () => store.append(e("project.handoff_selected", "handoff-select-m6", "user", "local-user", {
        choice: "keep_integration_branch",
        integrationRevision: "a".repeat(40),
        integrationBranch: "aiboard/run/integration",
        appliedToProject: false,
      })),
      /upgrades acceptance criteria/,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("C2b repair CD-14/N6: a docs-v2 run without a plan revision hands off the baseline", async () => {
  const RUN = "run-c2b-n6-baseline";
  const repo = await openGitRepo("n6-baseline", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const seeder = new SqliteSchedulerStore(schedulerPath);
  const e = (
    type: string,
    key: string,
    role: SchedulerActorRole,
    id: string,
    payload: Record<string, unknown>,
  ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
  seeder.append(e("project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 2 }));
  seeder.append(e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "plan_only" }));
  // Legacy planning: a plan revision but no planning policy v1, and no
  // integration revision anywhere in the log (the N6 shape).
  seeder.append(e("plan.created", "plan", "architect", "architect", {
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
  }));
  seeder.close();
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath);
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration),
          architect, clock: advancingClock(), runPolicy: "plan_only",
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    // No endless snapshot-failure pause: the recorded baseline is handed off.
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.revision, repo.baselineRevision);
    assert.equal(payload.specCopySkipped, "no_manifest");
    assert.equal(manager.projection(RUN).pauseReason, undefined);
    const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c2b-n6");
    assert.equal(selected.status, "completed");
  } finally {
    await manager?.close();
    store?.close();
    await repo.close();
  }
});

test("C2b repair B1-R/P1: the factory-built docs port wires both reconciliation methods", async () => {
  const RUN = "run-c2b-p1";
  const fixture = await openFactoryPort("p1", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  try {
    // Probe P1: the runtime that NativeBuildFactory.create builds must
    // carry both methods on its docs port -- not just the six cycle-0 keys.
    for (const key of ["commit", "commitHandoffSnapshot", "findHandoffSnapshotCommit", "readHandoffSnapshotFile", "readIntegrationBaselineRevision", "readIntegrationTipFile", "findTrackedFileWithDigest", "relateRevision"]) {
      assert.equal(typeof (fixture.port as unknown as Record<string, unknown>)[key], "function", `the factory port wires ${key}`);
    }
    const baseline = await fixture.port.readIntegrationBaselineRevision();
    assert.equal(baseline.revision, fixture.baselineRevision);
    assert.equal(await fixture.port.findHandoffSnapshotCommit({ snapshotKey: "handoff-snapshot:1" }), null);
  } finally {
    await fixture.close();
  }
});

test("C2b repair B1-R/G2-prod: the G2 flow through the production manager with the factory's port", async () => {
  const RUN = "run-c2b-g2prod";
  // KEY LESSON: the port below is read off the factory-built runtime, never
  // hand-built -- this is the round-1 G2 probe through the production
  // manager with the factory's own wiring.
  // The factory re-validates final-verification profiles against its audit
  // archive on read, so FV events land after create through the harness
  // store (which accepts the fixture profile); the factory store never
  // re-reads once its runtime is built.
  const preSeed = (runId: string, baseline: string): NewSchedulerEvent[] =>
    v2FinishSeed(runId, baseline).filter((event) => !event.type.startsWith("final_verification."));
  const fvSeed = (runId: string, baseline: string): NewSchedulerEvent[] =>
    v2FinishSeed(runId, baseline).filter((event) => event.type.startsWith("final_verification."));
  const fixture = await openFactoryPort("g2prod", RUN, preSeed, "finish");
  // The stop-1 commit lands, then the read-back fails: a transient failure
  // after the commit (or a crash before the append).
  failNextSnapshotReadOnce(fixture.integration, "Injected handoff snapshot read failure.");
  const architect = silentArchitect("The build is complete and verified.");
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  const order: string[] = [];
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(fixture.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(join(fixture.state, "builds", safeSegment(RUN), "scheduler.sqlite"), {
          evidenceStore: fixture.evidence,
          validateExecutionProfile: acceptFinalVerificationProfile,
          validateCleanupReceipt: () => undefined,
        });
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: fixture.port,
          architect, clock: advancingClock(), runPolicy: "finish", evidenceStore: fixture.evidence,
        });
        return managedHandle(runtime, async () => {
          order.push(`projectHandoff:${manager!.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length}`);
          const result = await fixture.integration.applyToProject();
          order.push("applied");
          return result;
        }, RUN);
      },
    });
    await manager.create(managerSpec(RUN, "finish"));
    assert.ok(store);
    for (const input of fvSeed(RUN, fixture.baselineRevision)) store.append(input);
    // The factory's risk_based verifier policy is already in the shared log
    // (factory.create); qualify the green FV generation before completion.
    for (const input of lowRiskSeed(RUN, fixture.baselineRevision)) store.append(input);
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    assert.equal(manager.projection(RUN).pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    assert.deepEqual(order, [], "no project mutation precedes the kernel record");
    assert.equal(existsSync(join(fixture.project, "docs", "project", "STATE.md")), false, "the project is untouched");
    const landed = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(landed.stdout.trim(), "1", "the stop-1 kernel commit landed");
    const stop1 = manager.events(RUN).find((event) => event.type === "project.handoff_requested")!.sequence;
    // The owner submits guidance instead of resuming: the handoff is
    // withdrawn. The Architect acknowledges with no plan change.
    assert.ok(store);
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    store.append(e("user.guidance_submitted", "guidance-1", "user", "local-user", {
      guidanceId: "guidance-1",
      text: "Hold the handoff and re-verify the plan.",
      version: 1,
      interruptionProtocolVersion: 1,
    }));
    store.append(e("user.guidance_interruption_completed", "guidance-1:interruption", "runner", "build-manager", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
    }));
    const acknowledgementEvidence = fixture.evidence.record({
      runId: RUN,
      taskId: "architect",
      actor: { role: "architect", id: "architect" },
      fact: {
        kind: "browser_screenshot",
        label: "the plan already incorporates the withdrawing guidance",
        capturedAt: CLOCK,
        screenshotArtifactHash: "c".repeat(64),
        mediaType: "image/png",
        byteLength: 1,
      },
      createdAt: CLOCK,
      idempotencyKey: "guidance-stale-stop:evidence",
    });
    store.append(e("user.guidance_acknowledged", "guidance-1:ack", "architect", "architect", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
      resolution: {
        type: "no_plan_change",
        rationale: "The initial plan already incorporates the durable guidance.",
        evidenceIds: [acknowledgementEvidence.id],
      },
    }));
    const withdrawn = manager.projection(RUN);
    assert.equal(withdrawn.projectHandoff, undefined, "guidance withdrew the handoff");
    assert.equal((withdrawn.projectHandoffHistory ?? []).length, 1);
    // Final verification re-runs green on the unchanged canonical revision,
    // and the Architect re-requests (stop 2).
    for (const input of fvRerunSeed(RUN, fixture.baselineRevision)) store.append(input);
    // Guidance invalidated the stop-1 assessment; production re-assesses
    // after the green FV re-run, before the Architect re-requests.
    for (const input of lowRiskSeed(RUN, fixture.baselineRevision, "risk:rerun-low")) store.append(input);
    store.append(e("project.handoff_requested", "handoff-2", "architect", "architect", { summary: COMPLETION_SUMMARY }));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    // The withdrawn stop's landed commit was recorded as history before the
    // next stop committed: two snapshot events, one chain.
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 2);
    const first = snapshots[0]!.payload as Record<string, unknown>;
    const second = snapshots[1]!.payload as Record<string, unknown>;
    assert.equal(first.stopSequence, stop1, "the withdrawn stop is recorded first, as history");
    const restop = manager.events(RUN).filter((event) => event.type === "project.handoff_requested");
    assert.equal(second.stopSequence, restop[restop.length - 1]!.sequence, "the second record belongs to the re-request");
    assert.equal(second.parent, first.commit, "the new snapshot continues the withdrawn commit");
    assert.equal(manager.projection(RUN).projectDocs?.documentTip, second.commit);
    const projection = manager.projection(RUN);
    assert.equal(projection.status, "completed", "the handoff succeeds after reconciliation");
    assert.equal(projection.projectHandoff?.choice, "apply_to_project");
    assert.equal(architect.calls(), 1, "the kernel snapshot makes no model call");
    assert.deepEqual(order, ["projectHandoff:2", "applied"], "the project changes only after the kernel accepts");
    const stateShow = await runGit({ cwd: fixture.integration.path, args: ["show", `${String(second.commit)}:docs/project/STATE.md`] });
    const applied = await runGit({ cwd: fixture.project, args: ["show", "HEAD:docs/project/STATE.md"] });
    assert.equal(applied.stdout, stateShow.stdout, "the project holds the reconciled snapshot");
  } finally {
    await manager?.close();
    store?.close();
    await fixture.close();
  }
});

test("C2b repair B2/G3: a transient reconciliation failure pauses before committing and retries on resume", async () => {
  const RUN = "run-c2b-g3";
  // Probe G3 with the factory's port: the stop-1 commit lands and the read
  // fails; guidance withdraws; FV re-runs green and the Architect
  // re-requests; then the withdrawn-stop lookup throws ONCE (transient).
  const preSeed = (runId: string, baseline: string): NewSchedulerEvent[] =>
    v2FinishSeed(runId, baseline).filter((event) => !event.type.startsWith("final_verification."));
  const fvSeed = (runId: string, baseline: string): NewSchedulerEvent[] =>
    v2FinishSeed(runId, baseline).filter((event) => event.type.startsWith("final_verification."));
  const fixture = await openFactoryPort("g3", RUN, preSeed, "finish");
  failNextSnapshotReadOnce(fixture.integration, "Injected handoff snapshot read failure.");
  const architect = silentArchitect("The build is complete and verified.");
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  const order: string[] = [];
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(fixture.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(join(fixture.state, "builds", safeSegment(RUN), "scheduler.sqlite"), {
          evidenceStore: fixture.evidence,
          validateExecutionProfile: acceptFinalVerificationProfile,
          validateCleanupReceipt: () => undefined,
        });
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: fixture.port,
          architect, clock: advancingClock(), runPolicy: "finish", evidenceStore: fixture.evidence,
        });
        return managedHandle(runtime, async () => {
          order.push(`projectHandoff:${manager!.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length}`);
          const result = await fixture.integration.applyToProject();
          order.push("applied");
          return result;
        }, RUN);
      },
    });
    await manager.create(managerSpec(RUN, "finish"));
    assert.ok(store);
    for (const input of fvSeed(RUN, fixture.baselineRevision)) store.append(input);
    // The factory's risk_based verifier policy is already in the shared log
    // (factory.create); qualify the green FV generation before completion.
    for (const input of lowRiskSeed(RUN, fixture.baselineRevision)) store.append(input);
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    assert.equal(manager.projection(RUN).pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    const landed = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(landed.stdout.trim(), "1", "the stop-1 kernel commit landed");
    assert.ok(store);
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    store.append(e("user.guidance_submitted", "guidance-1", "user", "local-user", {
      guidanceId: "guidance-1",
      text: "Hold the handoff and re-verify the plan.",
      version: 1,
      interruptionProtocolVersion: 1,
    }));
    store.append(e("user.guidance_interruption_completed", "guidance-1:interruption", "runner", "build-manager", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
    }));
    const acknowledgementEvidence = fixture.evidence.record({
      runId: RUN,
      taskId: "architect",
      actor: { role: "architect", id: "architect" },
      fact: {
        kind: "browser_screenshot",
        label: "the plan already incorporates the withdrawing guidance",
        capturedAt: CLOCK,
        screenshotArtifactHash: "c".repeat(64),
        mediaType: "image/png",
        byteLength: 1,
      },
      createdAt: CLOCK,
      idempotencyKey: "guidance-stale-stop:evidence",
    });
    store.append(e("user.guidance_acknowledged", "guidance-1:ack", "architect", "architect", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
      resolution: {
        type: "no_plan_change",
        rationale: "The initial plan already incorporates the durable guidance.",
        evidenceIds: [acknowledgementEvidence.id],
      },
    }));
    assert.equal(manager.projection(RUN).projectHandoff, undefined, "guidance withdrew the handoff");
    for (const input of fvRerunSeed(RUN, fixture.baselineRevision)) store.append(input);
    // Guidance invalidated the stop-1 assessment; production re-assesses
    // after the green FV re-run, before the Architect re-requests.
    for (const input of lowRiskSeed(RUN, fixture.baselineRevision, "risk:rerun-low")) store.append(input);
    store.append(e("project.handoff_requested", "handoff-2", "architect", "architect", { summary: COMPLETION_SUMMARY }));
    // The transient: the withdrawn-stop lookup throws once at stop 2.
    failNextSnapshotLookupOnce(fixture.integration, "Injected transient snapshot lookup failure.");
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    // Fail closed: the current stop pauses with the reconciliation failure
    // named, and commits nothing -- the chain cannot break.
    const paused = manager.projection(RUN);
    assert.equal(paused.pauseReason?.reason, "handoff_snapshot_failed");
    assert.match(String(paused.pauseReason?.detail ?? ""), /withdrawn-stop reconciliation failed/, "the pause names the reconciliation failure");
    assert.equal(manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0, "no stop commits while a withdrawn stop is unclassifiable");
    const stuck = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(stuck.stdout.trim(), "1", "only the stop-1 commit exists");
    assert.deepEqual(order, [], "no project mutation precedes the kernel record");
    // Resume retries: the transient is gone, the history records, the new
    // snapshot continues it, and the handoff completes.
    await manager.resume(RUN, "resume:c2b-g3");
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 2);
    const first = snapshots[0]!.payload as Record<string, unknown>;
    const second = snapshots[1]!.payload as Record<string, unknown>;
    assert.equal(second.parent, first.commit, "the retried snapshot continues the reconciled commit");
    assert.equal(manager.projection(RUN).projectDocs?.documentTip, second.commit);
    const projection = manager.projection(RUN);
    assert.equal(projection.status, "completed", "the handoff completes after resume");
    assert.equal(projection.projectHandoff?.choice, "apply_to_project");
    assert.equal(architect.calls(), 1, "the kernel snapshot makes no model call");
    assert.deepEqual(order, ["projectHandoff:2", "applied"], "the project changes only after the kernel accepts");
  } finally {
    await manager?.close();
    store?.close();
    await fixture.close();
  }
});

test("C2b repair B3/probe L: a link-mode CLAUDE.md under core.symlinks=false is never written", async () => {
  const RUN = "run-c2b-linkmode";
  const fixture = await openFactoryPort("linkmode", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  try {
    const worktree = fixture.integration.path;
    // Store CLAUDE.md as a link entry (mode 120000) without touching a real
    // symlink: hash the target text, then index it as a link.
    writeFileSync(join(worktree, "AGENTS.md"), "pre-existing agents\n");
    await runGit({ cwd: worktree, args: ["add", "--", "AGENTS.md"] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "seed agents file"] });
    writeFileSync(join(worktree, "link-target.txt"), "AGENTS.md");
    const hashed = await runGit({ cwd: worktree, args: ["hash-object", "-w", "link-target.txt"] });
    const blob = hashed.stdout.trim();
    assert.match(blob, /^[a-f0-9]{40}$/);
    rmSync(join(worktree, "link-target.txt"), { force: true });
    await runGit({ cwd: worktree, args: ["update-index", "--add", "--cacheinfo", `120000,${blob},CLAUDE.md`] });
    await runGit({ cwd: worktree, args: ["commit", "-m", "link CLAUDE.md to AGENTS.md"] });
    // The Windows default: links check out as plain files holding the target.
    await runGit({ cwd: worktree, args: ["config", "core.symlinks", "false"] });
    rmSync(join(worktree, "CLAUDE.md"), { force: true });
    await runGit({ cwd: worktree, args: ["checkout", "--", "CLAUDE.md"] });
    // Fixture shape: a plain file in the worktree, a link in the index.
    assert.equal(lstatSync(join(worktree, "CLAUDE.md")).isSymbolicLink(), false);
    const staged = await runGit({ cwd: worktree, args: ["ls-files", "-s", "--", "CLAUDE.md"] });
    assert.match(staged.stdout.trim(), /^120000 /);
    assert.equal(readFileSync(join(worktree, "CLAUDE.md"), "utf8"), "AGENTS.md");
    const architect = silentArchitect();
    let store: SqliteSchedulerStore | undefined;
    let manager: NativeBuildManager | undefined;
    try {
      manager = new NativeBuildManager({
        specs: new SqliteBuildSpecStore(join(fixture.root, "builds.sqlite")),
        createRuntime: async () => {
          store = new SqliteSchedulerStore(join(fixture.state, "builds", safeSegment(RUN), "scheduler.sqlite"), {
            evidenceStore: fixture.evidence,
            validateExecutionProfile: acceptFinalVerificationProfile,
            validateCleanupReceipt: () => undefined,
          });
          const runtime = buildRuntimeForHandoff({
            runId: RUN, store, projectDocs: fixture.port,
            architect, clock: advancingClock(), runPolicy: "plan_only",
          });
          return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
        },
      });
      await manager.create(managerSpec(RUN, "plan_only"));
      manager.activate(RUN);
      await manager.awaitIdle(RUN);
      const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
      assert.equal(snapshots.length, 1, "the link layout completes instead of failing every snapshot");
      const payload = snapshots[0]!.payload as Record<string, unknown>;
      assert.equal(payload.claudeLineCommitted, true);
      assert.equal(payload.claudeLineViaLink, "CLAUDE.md is a symbolic link to AGENTS.md");
      assert.equal(readFileSync(join(worktree, "CLAUDE.md"), "utf8"), "AGENTS.md", "never written through the link");
      assert.equal(lstatSync(join(worktree, "CLAUDE.md")).isSymbolicLink(), false);
      // The commit keeps the link: the gate read the fact from the commit tree.
      const mode = await runGit({ cwd: worktree, args: ["ls-tree", String(payload.commit), "--", "CLAUDE.md"] });
      assert.match(mode.stdout.trim(), /^120000 blob/);
      const target = await runGit({ cwd: worktree, args: ["show", `${String(payload.commit)}:CLAUDE.md`] });
      assert.equal(target.stdout, "AGENTS.md");
      const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c2b-linkmode");
      assert.equal(selected.status, "completed");
    } finally {
      await manager?.close();
      store?.close();
    }
  } finally {
    await fixture.close();
  }
});

test("C2b repair N-1/probe K: a blocked spec directory never fails the snapshot", async () => {
  const RUN = "run-c2b-specblock";
  const fixture = await openFactoryPort("specblock", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  // A tracked FILE where the spec directory belongs: every spec mkdir fails.
  mkdirSync(join(fixture.integration.path, "docs", "project"), { recursive: true });
  writeFileSync(join(fixture.integration.path, "docs", "project", "specs"), "blocking file\n");
  await runGit({ cwd: fixture.integration.path, args: ["add", "--", "docs/project/specs"] });
  await runGit({ cwd: fixture.integration.path, args: ["commit", "-m", "blocking file at the spec directory"] });
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(fixture.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(join(fixture.state, "builds", safeSegment(RUN), "scheduler.sqlite"), {
          evidenceStore: fixture.evidence,
          validateExecutionProfile: acceptFinalVerificationProfile,
          validateCleanupReceipt: () => undefined,
        });
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: fixture.port,
          architect, clock: advancingClock(), runPolicy: "plan_only", artifacts,
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the blocked copy never fails the snapshot commit");
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.specCopySkipped, "write_failed");
    assert.ok(!("specCopied" in payload), "no copy is claimed");
    const commit = String(payload.commit);
    const files = await runGit({ cwd: fixture.integration.path, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"]);
    const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c2b-specblock");
    assert.equal(selected.status, "completed");
  } finally {
    await manager?.close();
    store?.close();
    await fixture.close();
  }
});

test("C2b repair N-2/probe K2: a user's own spec-path file is never overwritten", async () => {
  const RUN = "run-c2b-specown";
  const fixture = await openFactoryPort("specown", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  await artifacts.put(Buffer.from(SOURCE_TEXT, "utf8"), "text/plain", "approved source");
  // The user's own tracked file at the copy's path, holding other bytes.
  mkdirSync(join(fixture.integration.path, "docs", "project", "specs"), { recursive: true });
  writeFileSync(join(fixture.integration.path, "docs", "project", "specs", "source_value.md"), "user's own notes\n");
  await runGit({ cwd: fixture.integration.path, args: ["add", "--", "docs/project/specs/source_value.md"] });
  await runGit({ cwd: fixture.integration.path, args: ["commit", "-m", "user's own spec-path file"] });
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(fixture.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(join(fixture.state, "builds", safeSegment(RUN), "scheduler.sqlite"), {
          evidenceStore: fixture.evidence,
          validateExecutionProfile: acceptFinalVerificationProfile,
          validateCleanupReceipt: () => undefined,
        });
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: fixture.port,
          architect, clock: advancingClock(), runPolicy: "plan_only", artifacts,
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    const digest = createHash("sha256").update(SOURCE_TEXT, "utf8").digest("hex").slice(0, 16);
    const expected = `docs/project/specs/source_value-${digest}.md`;
    assert.equal(payload.specCopied, true);
    assert.equal(payload.specPath, expected);
    assert.equal(
      readFileSync(join(fixture.integration.path, "docs", "project", "specs", "source_value.md"), "utf8"),
      "user's own notes\n",
      "the user's file survives byte-for-byte",
    );
    const commit = String(payload.commit);
    const files = await runGit({ cwd: fixture.integration.path, args: ["show", "--name-only", "--format=", commit] });
    assert.ok(files.stdout.split("\n").map((line) => line.trim()).includes(expected), "the copy lands under the digest-suffixed name");
    const blob = await runGit({ cwd: fixture.integration.path, args: ["show", `${commit}:${expected}`] });
    assert.equal(blob.stdout, SOURCE_TEXT);
    const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c2b-specown");
    assert.equal(selected.status, "completed");
  } finally {
    await manager?.close();
    store?.close();
    await fixture.close();
  }
});

test("C2b repair B1-R/N6-factory: a docs-v2 run without a plan revision hands off the baseline through the factory port", async () => {
  const RUN = "run-c2b-n6factory";
  const seedN6 = (runId: string): NewSchedulerEvent[] => {
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(runId, type, key, role, id, payload);
    return [
      e("project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 2 }),
      e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "plan_only" }),
      // Legacy planning: a plan revision but no planning policy v1, and no
      // integration revision anywhere in the log (the N6 shape).
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
    ];
  };
  const fixture = await openFactoryPort("n6factory", RUN, seedN6, "plan_only");
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(fixture.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(join(fixture.state, "builds", safeSegment(RUN), "scheduler.sqlite"), {
          evidenceStore: fixture.evidence,
          validateExecutionProfile: acceptFinalVerificationProfile,
          validateCleanupReceipt: () => undefined,
        });
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: fixture.port,
          architect, clock: advancingClock(), runPolicy: "plan_only",
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    // No endless snapshot-failure pause: the recorded baseline is handed off.
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.revision, fixture.baselineRevision);
    assert.equal(payload.specCopySkipped, "no_manifest");
    assert.equal(manager.projection(RUN).pauseReason, undefined);
    const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c2b-n6factory");
    assert.equal(selected.status, "completed");
  } finally {
    await manager?.close();
    store?.close();
    await fixture.close();
  }
});

test("C2b repair N-3/probe R: the reducer refuses a snapshot record for a sequence that is no stop", () => {
  const RUN = "run-c2b-r";
  const root = mkdtempSync(join(tmpdir(), "aiboard c2b r "));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    for (const input of v2PlanOnlySeed(RUN)) store.append(input);
    store.append(e("project.handoff_requested", "handoff-1", "architect", "architect", { summary: COMPLETION_SUMMARY }));
    const stop = store.readRun(RUN).find((event) => event.type === "project.handoff_requested")!;
    // A record for a sequence that is neither the requested stop nor a
    // withdrawn stop's requestedSequence: the reducer refuses it, and the
    // tip never moves to it.
    assert.throws(
      () => store.append(e("project_docs.handoff_snapshot_committed", "handoff-snapshot:bogus", "runner", "build-runtime", {
        stopSequence: stop.sequence + 100,
        stopKind: "plan_only",
        revision: "revision_value",
        commit: "b".repeat(40),
        parent: "p".repeat(40),
        head: "b".repeat(40),
        bodyDigest: "d".repeat(64),
        paths: ["docs/project/STATE.md"],
        previousSnapshotEdited: false,
        agentsSectionCommitted: true,
        claudeLineCommitted: true,
      })),
      /Handoff snapshots require a requested project handoff\./,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
