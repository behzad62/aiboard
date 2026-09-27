import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import { BuildRuntime, type ProjectDocsPort } from "../src/build-runtime.js";
import {
  handoffSnapshotInputFromProjection,
  renderHandoffSnapshot,
  verifyHandoffSnapshotDigest,
} from "../src/handoff-snapshot.js";
import type { ProjectHandoffResult } from "../src/integration-manager.js";
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
  buildCompletionReadiness,
  handoffSnapshotCoversRevision,
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
  type ProjectHandoffChoice,
  type SchedulerActor,
  type SchedulerActorRole,
} from "../src/scheduler-store.js";
import { buildSourceManifest } from "../src/source-manifest.js";
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
  });
}

function advancingClock(start = "2026-09-26T00:00:00.000Z"): () => string {
  let now = Date.parse(start);
  return () => new Date((now += 1000)).toISOString();
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
    assert.deepEqual(payload.paths, ["docs/project/STATE.md"]);
    const entries = readdirSync(join(state, "integration"));
    assert.equal(entries.length, 1);
    const repoPath = join(state, "integration", entries[0]!);
    const log = await runGit({ cwd: repoPath, args: ["log", "--format=%H", `${baseline.revision}..HEAD`] });
    const commits = log.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    assert.deepEqual(commits, [payload.commit], "exactly one kernel commit");
    const files = await runGit({ cwd: repoPath, args: ["show", "--name-only", "--format=", String(payload.commit)] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["docs/project/STATE.md"]);
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
    assert.deepEqual(payload.paths, ["docs/project/STATE.md"]);
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
  const crashed = await repo.integration.commitHandoffSnapshot({
    writes: [{ path: "docs/project/STATE.md", content: body }],
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
  };
  assert.throws(() => assertHandoffSnapshotGate(v2(), "rev-1"), /kernel handoff snapshot/);
  const covered = v2();
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
  const noState = v2();
  noState.projectDocs = { pending: [], snapshots: [{ ...snapshotRecord, paths: ["docs/project/AGENTS.md"] }] };
  assert.throws(() => assertHandoffSnapshotGate(noState, "rev-1"), /kernel handoff snapshot/);
  assert.equal(handoffSnapshotCoversRevision(covered, "rev-1"), true);
  assert.equal(handoffSnapshotCoversRevision(covered, "rev-2"), false);
  const planOnly = v2();
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
