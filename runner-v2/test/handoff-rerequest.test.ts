import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BuildRuntime, type IndependentVerifierDriver, type ProjectDocsPort } from "../src/build-runtime.js";
import type { NativeBuildSpec } from "../src/build-spec.js";
import type { FinalVerificationPlan } from "../src/final-verification-contracts.js";
import { IntegrationManager as ProductionIntegrationManager } from "../src/integration-manager.js";
import type { ProjectHandoffResult } from "../src/integration-manager.js";
import { NativeBuildManager } from "../src/native-build-manager.js";
import {
  deriveNativeVerifierRiskInput,
  NativeBuildFactory,
  snapshotNativeBuildAmbientEnvironment,
} from "../src/native-build-factory.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import { assessBuildRisk } from "../src/risk-policy.js";
import type { BuildRiskAssessmentInput } from "../src/risk-policy.js";
import {
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
  type ProjectHandoffChoice,
  type SchedulerActorRole,
} from "../src/scheduler-store.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import {
  IntegrationManager,
  captureGitBaseline,
  runGit,
} from "./support/git-fixture.js";
import {
  acceptFinalVerificationProfile,
  emptyFinalVerificationProfile,
} from "./support/final-verification-profile.js";

/**
 * FX-2: repeatable handoff requests (CR-1) and verifier re-selection (N1),
 * plus repair-1 owner-answer scoping (B1/M2).
 *
 * CR-1: complete_run keyed its request `project-handoff-requested`, so after
 * user guidance withdrew a handoff a second complete_run deduped to the stale
 * event (same summary) or threw an idempotency conflict (different summary)
 * and the run could never complete. The request is now keyed by the
 * withdrawals it follows (`project-handoff-requested:<history length>`,
 * bare for the first request), so the Architect's real second complete_run
 * records a new request while replays stay idempotent.
 *
 * N1: the verifier-selection pause was keyed
 * `verifier-selection:<revision>:<reason>`, so after the owner selected and
 * the verifier became unavailable again with the same reason the append
 * deduped: step() returned paused/verifier_selection_required while the
 * projection stayed running with selection "selected" and no prompt. The
 * requirement is now keyed by the selection it follows (`:sel-<count>` after
 * a selection, bare before any selection).
 *
 * B1/M2 (repair 1): the owner's answer reused one client key per runtime
 * (`verifier-handoff:<run>:<runtime>`, `architect-handoff:<run>:<runtime>`),
 * so an answer to a NEW requirement deduped into the first selection and a
 * single-candidate run stayed stuck behind an unanswerable prompt.
 * BuildRuntime now scopes the STORED selection key to the requirement it
 * answers (`<caller key>:req-<requirement count>`, bare for the first
 * requirement), so a re-answer records while a replay still dedupes.
 *
 * Driver honesty: the CR-1 v1/restart, probe D, and B1 tests drive the
 * production NativeBuildManager end to end with real SQLite and an advancing
 * clock; the CR-1 docs-v2 test does the same through a factory-built docs
 * port. The M2 test drives both Architect-handoff selections through the
 * manager; its handoff requirements are seeded runner-authored events (the
 * same style as finishSeed) because the native architect router failure path
 * is not under test -- the fixed selection path is. The old-key test uses no
 * runtime at all: it replays a closed pre-fix log through a reopened store.
 * BuildRuntime is constructed only inside the manager-handle factory and is
 * never stepped or selected directly; every runtime interaction in every
 * test goes through NativeBuildManager.
 */

const CLOCK = "2026-09-26T00:00:00.000Z";
const COMPLETION_SUMMARY = "The build is complete and verified.";
const FV_CATEGORIES = ["build", "tests", "runtime_smoke", "browser"] as const;

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

interface FinishSeedOptions {
  docsVersion: 1 | 2;
  generationId: string;
  taskId: string;
  keyPrefix: string;
  planVersion: number;
  /** Omit the review decision so the run still has to verify (probe F). */
  reviewDecision?: boolean;
}

/**
 * Legacy-planning finish seed: plan.created with one integrated task, a
 * canonical integration revision, and a green FV generation. Docs v1 also
 * seeds the model-written STATE.md commit the v1 readiness gate requires;
 * docs v2 relies on the kernel snapshot instead.
 */
function finishSeed(runId: string, integrationRevision: string, options: FinishSeedOptions): NewSchedulerEvent[] {
  const plan = finishPlan();
  const e = (
    type: string,
    key: string,
    role: SchedulerActorRole,
    id: string,
    payload: Record<string, unknown>,
  ): NewSchedulerEvent => seedEvent(runId, type, key, role, id, payload);
  const submissionId = `final-verification-submission:${options.generationId}`;
  const reviewId = `final-verification-review:${options.generationId}`;
  const p = options.keyPrefix;
  const events: NewSchedulerEvent[] = [
    e("project_docs.policy_configured", `${p}docs-policy`, "runner", "build-runtime", { version: options.docsVersion }),
    e("run.policy_configured", `${p}policy`, "runner", "build-runtime", { runPolicy: "finish" }),
    e("verifier.policy_configured", `${p}verifier-policy`, "runner", "build-runtime", {
      mode: "risk_based",
      candidateRuntimeIds: ["rev:reviewer"],
      alwaysRequireIndependentVerifier: false,
    }),
    e("plan.created", `${p}plan`, "architect", "architect", {
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
    e("integration.revision_advanced", `${p}integration-revision`, "runner", "integration", { integrationRevision }),
  ];
  if (options.docsVersion === 1) {
    events.push(
      e("project_doc.requested", `${p}req-state`, "architect", "architect", {
        requestId: `${p}req-state`,
        path: "docs/project/STATE.md",
        contentArtifactHash: "a".repeat(64),
        contentBytes: 10,
        summary: "Write the project state",
      }),
      e("project_doc.committed", `${p}commit-state`, "runner", "integration-manager", {
        requestId: `${p}req-state`,
        path: "docs/project/STATE.md",
        commit: "c".repeat(40),
        parent: "p".repeat(40),
        head: "c".repeat(40),
        readme: true,
        agentsMarkedSection: true,
        claudePointer: true,
      }),
    );
  }
  events.push(
    e("final_verification.generation_created", `${p}generation`, "runner", "runtime", {
      taskId: options.taskId,
      generationId: options.generationId,
      targetRevision: integrationRevision,
      planVersion: options.planVersion,
      plan,
      executionProfile: emptyFinalVerificationProfile(integrationRevision),
    }),
  );
  for (const [index, check] of plan.checks.entries()) {
    events.push(e("final_verification.check_completed", `${p}check:${check.category}`, "runner", "runtime", {
      taskId: options.taskId,
      generationId: options.generationId,
      targetRevision: integrationRevision,
      attempt: 1,
      workspacePath: "C:/verification",
      startedAt: `2026-09-26T00:00:0${index + 4}.000Z`,
      finishedAt: "2026-09-26T00:00:05.000Z",
      result: { ...check, green: true, evidenceIds: [], facts: [], issues: [] },
    }));
  }
  const submissionChecks = plan.checks.map((check) => ({ ...check, green: true as const, evidenceIds: [], facts: [] }));
  events.push(
    e("final_verification.submitted", `${p}submission`, "runner", "runtime", {
      taskId: options.taskId,
      generationId: options.generationId,
      targetRevision: integrationRevision,
      submissionId,
      attempt: 1,
      submissionResult: {
        kind: "final_verification_submission",
        generationId: options.generationId,
        runId,
        taskId: options.taskId,
        attempt: 1,
        targetRevision: integrationRevision,
        plan,
        executionProfile: emptyFinalVerificationProfile(integrationRevision),
        checks: submissionChecks,
        evidenceIds: [],
        submittedAt: "2026-09-26T00:00:06.000Z",
        green: true,
      },
    }),
    e("final_verification.cleanup_started", `${p}cleanup-start`, "runner", "runtime", {
      taskId: options.taskId, generationId: options.generationId, targetRevision: integrationRevision, attempt: 1,
    }),
    e("final_verification.cleanup_succeeded", `${p}cleanup-success`, "runner", "runtime", {
      taskId: options.taskId, generationId: options.generationId, targetRevision: integrationRevision, attempt: 1,
    }),
    e("final_verification.review_requested", `${p}review-request`, "runner", "runtime", {
      taskId: options.taskId,
      generationId: options.generationId,
      targetRevision: integrationRevision,
      submissionId,
      reviewId,
      attempt: 1,
    }),
  );
  if (options.reviewDecision !== false) {
    events.push(
      e("final_verification.review_decided", `${p}review-decision`, "architect", "architect", {
        taskId: options.taskId,
        generationId: options.generationId,
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
  }
  return events;
}

function guidanceTriple(
  runId: string,
  store: SqliteSchedulerStore,
  evidence: SqliteEvidenceStore,
  evidenceKey: string,
): void {
  const e = (
    type: string,
    key: string,
    role: SchedulerActorRole,
    id: string,
    payload: Record<string, unknown>,
  ): NewSchedulerEvent => seedEvent(runId, type, key, role, id, payload);
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
    runId,
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
    idempotencyKey: evidenceKey,
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
}

function advancingClock(start = "2026-09-26T00:00:00.000Z"): () => string {
  let now = Date.parse(start);
  return () => new Date((now += 1000)).toISOString();
}

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run";
}

/**
 * Scripted Architect: exactly two completion turns with the SAME summary --
 * the stale-dedupe case under the old fixed complete_run key. A third turn
 * is a test failure. Both turns go through the real complete_run tool.
 */
function twoTurnCompletionArchitect(
  projection: () => import("../src/scheduler-store.js").SchedulerProjection,
  shared: { calls: number },
  summary = COMPLETION_SUMMARY,
): { driver: import("../src/build-runtime.js").ArchitectRuntimeDriver } {
  let sequence = 0;
  return {
    driver: {
      run: async (request) => {
        shared.calls += 1;
        if (projection().projectHandoff) {
          throw new Error(`Unexpected Architect turn after handoff: ${projection().projectHandoff?.status}.`);
        }
        if (shared.calls > 2) {
          throw new Error(`Unexpected third Architect turn (call ${shared.calls}).`);
        }
        sequence += 1;
        const result = await request.tools.invoke({
          type: "tool_call",
          callId: `fx2-complete-${sequence}`,
          name: "complete_run",
          arguments: { summary },
        }, request.context);
        assert.equal(result.isError, false, result.error?.message ?? "complete_run failed");
      },
    },
  };
}

/** Production-shaped independent verifier: the real kernel risk derivation; low risk never verifies. */
function productionShapedVerifier(
  runId: string,
  store: () => SqliteSchedulerStore,
  counter: { calls: number },
): IndependentVerifierDriver {
  return {
    candidateRuntimeIds: ["rev:reviewer"],
    alwaysRequireIndependentVerifier: false,
    assessRisk: async ({ projection }) => {
      counter.calls += 1;
      return deriveNativeVerifierRiskInput({
        projection,
        sessions: [],
        schedulerEvents: store().readRun(runId),
        toolEvents: [],
        stricterQualification: false,
      });
    },
    verify: async () => {
      throw new Error("A low-risk run must never reach independent verification.");
    },
  };
}

/**
 * High-risk verifier for the B1 regression: risk is always high, the first
 * two verifications are unavailable with the SAME reason (so the second
 * unavailability re-requires selection), and the third performs a real
 * single-pass review with a satisfied verdict so the run can complete. The
 * review and verdict are recorded through the production event shapes the
 * reducer enforces (exact criteria, independent model identity, session
 * binding); single-pass needs no expectations.
 */
function reselectThenSatisfiedVerifier(
  runId: string,
  store: () => SqliteSchedulerStore,
  counter: { assess: number; verify: number },
  clock: () => string,
  evidence: SqliteEvidenceStore,
): IndependentVerifierDriver {
  const high: BuildRiskAssessmentInput = {
    architectDeclaration: "high",
    stricterQualification: false,
    kernelFacts: {
      destructiveEffects: false,
      credentialEffects: false,
      externalWriteEffects: false,
      integrationConflict: false,
      changedPaths: ["src/index.ts"],
    },
  };
  const reviewId = "verifier-review-fx2-b1";
  const sessionId = `verifier:${runId}:session`;
  let evidenceId: string | undefined;
  return {
    candidateRuntimeIds: ["rev:reviewer"],
    alwaysRequireIndependentVerifier: false,
    assessRisk: async () => {
      counter.assess += 1;
      return high;
    },
    verify: async (request) => {
      counter.verify += 1;
      if (counter.verify <= 2) {
        return { status: "unavailable", reason: "runtime_unavailable" };
      }
      const targetRevision = request.projection.integrationRevision;
      assert.ok(targetRevision, "verification needs a current integrated revision");
      const generationId = request.projection.finalVerification?.current?.generationId;
      assert.ok(generationId, "verification needs a current final-verification generation");
      const architectRuntimeId = request.projection.runtime.architect.runtimeId ?? "arch:architect";
      if (evidenceId === undefined) {
        evidenceId = evidence.record({
          runId,
          taskId: "implementation",
          actor: { role: "verifier", id: "rev:reviewer" },
          fact: {
            kind: "browser_screenshot",
            label: "the implementation meets its acceptance criterion",
            capturedAt: clock(),
            screenshotArtifactHash: "d".repeat(64),
            mediaType: "image/png",
            byteLength: 1,
          },
          createdAt: clock(),
          idempotencyKey: "fx2-b1:verifier-evidence",
        }).id;
      }
      store().append(seedEvent(runId, "verifier.review_requested", "fx2-b1:verifier:review", "runner", "native-verifier-runtime", {
        reviewId,
        targetRevision,
        finalVerificationGenerationId: generationId,
        runtime: {
          runtimeId: "rev:reviewer",
          providerId: "rev",
          modelId: "rev/reviewer-model",
          modelIdentity: "reviewer-model",
          sessionId,
        },
        excludedModels: [
          { source: "architect", runtimeId: architectRuntimeId, modelIdentity: "architect-model" },
        ],
        criteria: [{ taskId: "implementation", criterionId: "done" }],
      }));
      store().append(seedEvent(runId, "verifier.verdict_submitted", "fx2-b1:verifier:verdict", "verifier", "rev:reviewer", {
        reviewId,
        targetRevision,
        sessionId,
        criterionVerdicts: [{
          taskId: "implementation",
          criterionId: "done",
          verdict: "satisfied",
          rationale: "The implementation meets its acceptance criterion.",
          evidenceIds: [evidenceId],
        }],
      }));
      return { status: "verdict_submitted" };
    },
  };
}

function selectionSelected(store: SqliteSchedulerStore, runId: string): import("../src/scheduler-store.js").SchedulerEvent[] {
  return store.readRun(runId).filter((event) => event.type === "verifier.selection_selected");
}

function handoffSelected(store: SqliteSchedulerStore, runId: string): import("../src/scheduler-store.js").SchedulerEvent[] {
  return store.readRun(runId).filter((event) => event.type === "architect.handoff_selected");
}

/** Step the manager until a given verifier-selection requirement count lands (or the bound runs out). */
async function stepUntilSelections(
  manager: NativeBuildManager,
  store: SqliteSchedulerStore,
  runId: string,
  count: number,
  maxSteps = 10,
): Promise<void> {
  for (let index = 0; index < maxSteps; index += 1) {
    if (selectionRequirements(store, runId).length >= count) return;
    await manager.step(runId);
  }
}

function riskEvents(store: SqliteSchedulerStore, runId: string): import("../src/scheduler-store.js").SchedulerEvent[] {
  return store.readRun(runId).filter((event) => event.type === "build.risk_assessed");
}

function handoffRequests(store: SqliteSchedulerStore, runId: string): import("../src/scheduler-store.js").SchedulerEvent[] {
  return store.readRun(runId).filter((event) => event.type === "project.handoff_requested");
}

function selectionRequirements(
  store: SqliteSchedulerStore,
  runId: string,
): import("../src/scheduler-store.js").SchedulerEvent[];
function selectionRequirements(
  runtime: import("../src/build-runtime.js").BuildRuntime,
): import("../src/scheduler-store.js").SchedulerEvent[];
function selectionRequirements(
  source: SqliteSchedulerStore | import("../src/build-runtime.js").BuildRuntime,
  runId?: string,
): import("../src/scheduler-store.js").SchedulerEvent[] {
  const events = source instanceof SqliteSchedulerStore
    ? source.readRun(runId!)
    : (source as import("../src/build-runtime.js").BuildRuntime).events();
  return events.filter((event) => event.type === "verifier.selection_required");
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
  const root = mkdtempSync(join(tmpdir(), `aiboard-fx2-${label}-`));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "shared.txt"), "baseline\n");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: `fx2-${label}-fixture`, version: "1.0.0", type: "module" }, null, 2));
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

/** Production-shaped docs port backed by the real IntegrationManager. */
function gitDocsPort(integration: IntegrationManager): ProjectDocsPort {
  return {
    commit: async () => {
      throw new Error("The v1 kernel path never uses the Architect document commit.");
    },
    commitHandoffSnapshot: async (input) => integration.commitHandoffSnapshot(input),
    readHandoffSnapshotFile: async (input) => integration.readHandoffSnapshotFile(input),
    readIntegrationTipFile: async (input) => integration.readIntegrationTipFile(input),
    findTrackedFileWithDigest: async (input) => integration.findTrackedFileWithDigest(input),
    findHandoffSnapshotCommit: async (input) => integration.findHandoffSnapshotCommit(input),
    readIntegrationBaselineRevision: async () => integration.readIntegrationBaselineRevision(),
    canStageSpecPath: async (input) => integration.canStageSpecPath(input),
    relateRevision: async () => "strict_descendant" as const,
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

/** Production NativeBuildManager handle around a real BuildRuntime; only the project mutation is injected. */
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

function managerSpec(runId: string, runPolicy: "finish" | "plan_only" | "budgeted"): NativeBuildSpec {
  return {
    version: 2,
    runId,
    projectId: "fx2-fixture",
    objective: "Prove repeatable handoff requests and verifier re-selection.",
    architectRuntimeId: "arch:architect",
    workerRuntimeIds: ["work:worker"],
    verifierRuntimeIds: ["rev:reviewer"],
    alwaysRequireIndependentVerifier: false,
    maxConcurrency: 1,
    permissionProfile: "full",
    runPolicy,
    budgetLimits: {},
    createdAt: CLOCK,
    idempotencyKey: `fx2-${runId}`,
  };
}

function buildHarnessRuntime(options: {
  runId: string;
  store: SqliteSchedulerStore;
  projectDocs: ProjectDocsPort;
  architect: { driver: import("../src/build-runtime.js").ArchitectRuntimeDriver };
  verifier: IndependentVerifierDriver;
  clock: () => string;
  evidenceStore: SqliteEvidenceStore;
}): BuildRuntime {
  return new BuildRuntime({
    runId: options.runId,
    runPolicy: "finish",
    store: options.store,
    workerDriver: { run: async () => ({ type: "failed" as const, reason: "unused" }) },
    architectDriver: options.architect.driver,
    integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
    independentVerifier: options.verifier,
    maxConcurrency: 1,
    workspaceFor: async () => "C:/unused",
    clock: options.clock,
    projectDocs: options.projectDocs,
    evidenceStore: options.evidenceStore,
  });
}

/**
 * Step the manager until a second risk assessment lands (or the bound
 * runs out). The assessment precedes any completion turn, so the bounded
 * walk records the re-assessment before the Architect re-requests.
 */
async function stepUntilReassessed(
  manager: NativeBuildManager,
  store: SqliteSchedulerStore,
  runId: string,
  maxSteps = 10,
): Promise<void> {
  for (let index = 0; index < maxSteps; index += 1) {
    if (riskEvents(store, runId).length >= 2) return;
    await manager.step(runId);
  }
}

/** Step the manager until the Architect's re-request lands (or the bound runs out). */
async function stepUntilReRequested(
  manager: NativeBuildManager,
  store: SqliteSchedulerStore,
  runId: string,
  maxSteps = 10,
): Promise<void> {
  for (let index = 0; index < maxSteps; index += 1) {
    if (handoffRequests(store, runId).length >= 2) return;
    await manager.step(runId);
  }
}

function provider(runtimeId: string, priority: number): RunnerProviderConfig {
  const [providerId, modelId] = runtimeId.split(":");
  return { runtimeId, providerId: providerId!, modelId: modelId!, transport: "openai-compatible", baseUrl: "http://127.0.0.1:9", secret: "unused", capabilities: ["code"], priority };
}

class UnusedModel {
  async complete(): Promise<never> {
    throw new Error("This model must not be called on a harness-driven run.");
  }
}

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

/**
 * The docs port under test is ALWAYS the one NativeBuildFactory.create
 * builds -- read off the factory-built runtime, never hand-built.
 */
async function openFactoryPort(
  label: string,
  runId: string,
  seed: (runId: string, baselineRevision: string) => NewSchedulerEvent[],
  runPolicy: "finish" | "plan_only",
): Promise<FactoryPortFixture> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-fx2-factory-${label}-`));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "shared.txt"), "baseline\n");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: `fx2-${label}-fixture`, version: "1.0.0", type: "module" }, null, 2));
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
    providerModelFactory: () => new UnusedModel(),
  });
  let built: { runtime: BuildRuntime; cleanup: () => Promise<void>; close: () => Promise<void> };
  try {
    built = await factory.create(await factory.prepareSpec({
      version: 2,
      runId,
      projectId: "fx2-factory-fixture",
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
      idempotencyKey: `fx2-factory-${label}`,
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

test("FX-2 CR-1 v1 finish: a withdrawn handoff re-requests through the Architect's real second complete_run", async () => {
  const RUN = "run-fx2-v1";
  const repo = await openGitRepo("v1", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(repo.root, "evidence.sqlite"));
  const seeder = new SqliteSchedulerStore(schedulerPath, {
    evidenceStore: evidence,
    validateExecutionProfile: acceptFinalVerificationProfile,
    validateCleanupReceipt: () => undefined,
  });
  for (const input of finishSeed(RUN, repo.baselineRevision, {
    docsVersion: 1,
    generationId: "generation-fx2-v1",
    taskId: "final-verification-fx2-v1",
    keyPrefix: "",
    planVersion: 1,
  })) seeder.append(input);
  seeder.close();
  // The stop-1 project mutation fails once: the handoff stays requested and
  // paused instead of completing, so guidance can withdraw it below.
  let handoffCalls = 0;
  const verifierCalls = { calls: 0 };
  const architectCalls = { calls: 0 };
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath, {
          evidenceStore: evidence,
          validateExecutionProfile: acceptFinalVerificationProfile,
          validateCleanupReceipt: () => undefined,
        });
        const runtime = buildHarnessRuntime({
          runId: RUN,
          store,
          projectDocs: gitDocsPort(repo.integration),
          architect: twoTurnCompletionArchitect(() => manager!.projection(RUN), architectCalls),
          verifier: productionShapedVerifier(RUN, () => store!, verifierCalls),
          clock: advancingClock(),
          evidenceStore: evidence,
        });
        return managedHandle(runtime, async (choice: ProjectHandoffChoice) => {
          handoffCalls += 1;
          if (handoffCalls === 1) throw new Error("Injected stop-1 project apply failure.");
          return {
            integrationRevision: repo.baselineRevision,
            integrationBranch: "integration",
            appliedToProject: choice === "apply_to_project",
          };
        }, RUN);
      },
    });
    await manager.create(managerSpec(RUN, "finish"));
    assert.ok(store);
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    // Stop 1: the runtime assessed risk through the real derivation, the
    // Architect completed, and the refused project mutation left the
    // requested handoff paused.
    assert.equal(manager.projection(RUN).projectHandoff?.status, "requested");
    assert.equal(handoffCalls, 1);
    assert.equal(architectCalls.calls, 1);
    assert.equal(handoffRequests(store, RUN).length, 1);
    assert.equal(handoffRequests(store, RUN)[0]!.idempotencyKey, "project-handoff-requested");
    // Guidance with no plan change withdraws the handoff and invalidates
    // the assessment; final verification re-runs green on the same revision.
    guidanceTriple(RUN, store, evidence, "fx2-v1:evidence");
    assert.equal(manager.projection(RUN).projectHandoff, undefined);
    assert.equal((manager.projection(RUN).projectHandoffHistory ?? []).length, 1);
    for (const input of finishSeed(RUN, repo.baselineRevision, {
      docsVersion: 1,
      generationId: "generation-fx2-v1-rerun",
      taskId: "final-verification-fx2-v1-rerun",
      keyPrefix: "rerun:",
      planVersion: 1,
    }).filter((event) => event.type.startsWith("final_verification."))) store.append(input);
    await stepUntilReassessed(manager, store, RUN);
    assert.equal(riskEvents(store, RUN).length, 2, "the re-assessment is recorded instead of deduped");
    // The Architect's real second complete_run (same summary) records stop 2
    // as a NEW request instead of deduping to the withdrawn stop 1.
    const final = await manager.runUntilBlocked(RUN);
    assert.notEqual(final.action, "step_allowance_yielded", "no livelock after the re-request");
    const requests = handoffRequests(store, RUN);
    assert.equal(requests.length, 2, "the second complete_run records a new request");
    assert.equal(requests[0]!.idempotencyKey, "project-handoff-requested");
    assert.equal(requests[1]!.idempotencyKey, "project-handoff-requested:1");
    assert.equal(architectCalls.calls, 2, "completion goes through a real second complete_run");
    assert.equal(manager.projection(RUN).status, "completed");
    assert.equal(manager.projection(RUN).projectHandoff?.choice, "apply_to_project");
    assert.equal(handoffRequests(store, RUN).length, 2, "completion records no third request");
  } finally {
    await manager?.close();
    store?.close();
    evidence.close();
    await repo.close();
  }
});

test("FX-2 CR-1 docs-v2 finish: the re-request carries a new snapshot for the new stop", async () => {
  const RUN = "run-fx2-docsv2";
  const preSeed = (runId: string, baseline: string): NewSchedulerEvent[] =>
    finishSeed(runId, baseline, {
      docsVersion: 2,
      generationId: "generation-fx2-docs",
      taskId: "final-verification-fx2-docs",
      keyPrefix: "",
      planVersion: 1,
    }).filter((event) => !event.type.startsWith("final_verification."));
  const fvSeed = (runId: string, baseline: string): NewSchedulerEvent[] =>
    finishSeed(runId, baseline, {
      docsVersion: 2,
      generationId: "generation-fx2-docs",
      taskId: "final-verification-fx2-docs",
      keyPrefix: "",
      planVersion: 1,
    }).filter((event) => event.type.startsWith("final_verification."));
  const fixture = await openFactoryPort("docsv2", RUN, preSeed, "finish");
  // The stop-1 commit lands, then the read-back fails: a transient failure
  // after the commit (or a crash before the append).
  failNextSnapshotReadOnce(fixture.integration, "Injected handoff snapshot read failure.");
  const verifierCalls = { calls: 0 };
  const architectCalls = { calls: 0 };
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
        const runtime = buildHarnessRuntime({
          runId: RUN,
          store,
          projectDocs: fixture.port,
          architect: twoTurnCompletionArchitect(() => manager!.projection(RUN), architectCalls),
          verifier: productionShapedVerifier(RUN, () => store!, verifierCalls),
          clock: advancingClock(),
          evidenceStore: fixture.evidence,
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
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    // Stop 1: risk assessed through the real derivation, handoff requested,
    // the kernel commit landed but the read-back failed -- paused, nothing
    // recorded, the project untouched.
    assert.equal(manager.projection(RUN).pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    assert.deepEqual(order, [], "no project mutation precedes the kernel record");
    const landed = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(landed.stdout.trim(), "1", "the stop-1 kernel commit landed");
    assert.equal(architectCalls.calls, 1);
    const stop1 = manager.events(RUN).find((event) => event.type === "project.handoff_requested")!.sequence;
    // Guidance with no plan change withdraws the handoff and invalidates
    // the assessment; final verification re-runs green on the same revision.
    guidanceTriple(RUN, store, fixture.evidence, "fx2-docsv2:evidence");
    const withdrawn = manager.projection(RUN);
    assert.equal(withdrawn.projectHandoff, undefined, "guidance withdrew the handoff");
    assert.equal((withdrawn.projectHandoffHistory ?? []).length, 1);
    for (const input of finishSeed(RUN, fixture.baselineRevision, {
      docsVersion: 2,
      generationId: "generation-fx2-docs-rerun",
      taskId: "final-verification-fx2-docs-rerun",
      keyPrefix: "rerun:",
      planVersion: 1,
    }).filter((event) => event.type.startsWith("final_verification."))) store.append(input);
    await stepUntilReassessed(manager, store, RUN);
    assert.equal(riskEvents(store, RUN).length, 2, "the re-assessment is recorded instead of deduped");
    // The Architect's real second complete_run records stop 2; the withdrawn
    // stop reconciles as history, the chain continues, and the handoff
    // completes with a new snapshot for the new stop.
    const final = await manager.runUntilBlocked(RUN);
    assert.notEqual(final.action, "step_allowance_yielded", "no livelock after the re-request");
    const requests = handoffRequests(store, RUN);
    assert.equal(requests.length, 2, "the second complete_run records a new request");
    assert.equal(requests[1]!.idempotencyKey, "project-handoff-requested:1");
    assert.equal(architectCalls.calls, 2, "completion goes through a real second complete_run");
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 2);
    const first = snapshots[0]!.payload as Record<string, unknown>;
    const second = snapshots[1]!.payload as Record<string, unknown>;
    assert.equal(first.stopSequence, stop1, "the withdrawn stop is recorded first, as history");
    assert.equal(second.stopSequence, requests[1]!.sequence, "the second record belongs to the re-request");
    assert.equal(second.parent, first.commit, "the new snapshot continues the withdrawn commit");
    const projection = manager.projection(RUN);
    assert.equal(projection.status, "completed", "the handoff succeeds after re-request");
    assert.equal(projection.projectHandoff?.choice, "apply_to_project");
    assert.deepEqual(order, ["projectHandoff:2", "applied"], "the project changes only after the kernel accepts");
  } finally {
    await manager?.close();
    store?.close();
    await fixture.close();
  }
});

test("FX-2 CR-1 restart: a restart after the re-request replays without a duplicate request", async () => {
  const RUN = "run-fx2-restart";
  const repo = await openGitRepo("restart", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(repo.root, "evidence.sqlite"));
  const seeder = new SqliteSchedulerStore(schedulerPath, {
    evidenceStore: evidence,
    validateExecutionProfile: acceptFinalVerificationProfile,
    validateCleanupReceipt: () => undefined,
  });
  for (const input of finishSeed(RUN, repo.baselineRevision, {
    docsVersion: 1,
    generationId: "generation-fx2-restart",
    taskId: "final-verification-fx2-restart",
    keyPrefix: "",
    planVersion: 1,
  })) seeder.append(input);
  seeder.close();
  const verifierCalls = { calls: 0 };
  const architectCalls = { calls: 0 };
  let handoffCalls = 0;
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  const specsPath = join(repo.root, "builds.sqlite");
  const openManager = () => new NativeBuildManager({
    specs: new SqliteBuildSpecStore(specsPath),
    createRuntime: async () => {
      store = new SqliteSchedulerStore(schedulerPath, {
        evidenceStore: evidence,
        validateExecutionProfile: acceptFinalVerificationProfile,
        validateCleanupReceipt: () => undefined,
      });
      const runtime = buildHarnessRuntime({
        runId: RUN,
        store,
        projectDocs: gitDocsPort(repo.integration),
        architect: twoTurnCompletionArchitect(() => manager!.projection(RUN), architectCalls),
        verifier: productionShapedVerifier(RUN, () => store!, verifierCalls),
        clock: advancingClock(),
        evidenceStore: evidence,
      });
      return managedHandle(runtime, async (choice: ProjectHandoffChoice) => {
        handoffCalls += 1;
        // Both applies fail: stop 1 stays requested so guidance can withdraw
        // it, and stop 2 stays requested so the restart lands mid-way.
        if (handoffCalls <= 2) throw new Error(`Injected stop-${handoffCalls} project apply failure.`);
        return {
          integrationRevision: repo.baselineRevision,
          integrationBranch: "integration",
          appliedToProject: choice === "apply_to_project",
        };
      }, RUN);
    },
  });
  try {
    manager = openManager();
    await manager.create(managerSpec(RUN, "finish"));
    assert.ok(store);
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    assert.equal(manager.projection(RUN).projectHandoff?.status, "requested");
    guidanceTriple(RUN, store, evidence, "fx2-restart:evidence");
    for (const input of finishSeed(RUN, repo.baselineRevision, {
      docsVersion: 1,
      generationId: "generation-fx2-restart-rerun",
      taskId: "final-verification-fx2-restart-rerun",
      keyPrefix: "rerun:",
      planVersion: 1,
    }).filter((event) => event.type.startsWith("final_verification."))) store.append(input);
    await stepUntilReassessed(manager, store, RUN);
    assert.equal(riskEvents(store, RUN).length, 2);
    // Step until the Architect's second complete_run lands, then restart
    // mid-way: close everything and reopen on the same files.
    await stepUntilReRequested(manager, store, RUN);
    assert.equal(handoffRequests(store, RUN).length, 2, "stop 2 is recorded before the restart");
    assert.equal(handoffRequests(store, RUN)[1]!.idempotencyKey, "project-handoff-requested:1");
    const callsBeforeRestart = architectCalls.calls;
    assert.equal(callsBeforeRestart, 2);
    await manager.close();
    store?.close();
    manager = openManager();
    await manager.recover();
    assert.ok(store, "recovery reopens the scheduler store");
    assert.equal(handoffRequests(store, RUN).length, 2, "replay records no duplicate request");
    assert.equal(
      manager.projection(RUN).projectHandoff?.status,
      "requested",
      "the re-request is still requested after replay",
    );
    // The restarted run completes without a third Architect turn and without
    // a third request.
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    assert.equal(manager.projection(RUN).status, "completed");
    assert.equal(handoffRequests(store, RUN).length, 2, "no duplicate request after restart");
    assert.equal(architectCalls.calls, callsBeforeRestart, "the restarted run makes no third Architect turn");
  } finally {
    await manager?.close();
    store?.close();
    evidence.close();
    await repo.close();
  }
});

test("FX-2 CR-1 old key: a pre-fix log with the fixed key shape replays unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-fx2-oldkey-"));
  const database = join(root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const revision = "b".repeat(40);
  const RUN = "run-fx2-oldkey";
  const store = new SqliteSchedulerStore(database, {
    evidenceStore: evidence,
    validateExecutionProfile: acceptFinalVerificationProfile,
    validateCleanupReceipt: () => undefined,
  });
  try {
    // A production-shaped finish run (green FV, v1 STATE.md) so the handoff
    // readiness gate holds.
    for (const input of finishSeed(RUN, revision, {
      docsVersion: 1,
      generationId: "generation-fx2-oldkey",
      taskId: "final-verification-fx2-oldkey",
      keyPrefix: "",
      planVersion: 1,
    })) store.append(input);
    // A current risk assessment so the handoff readiness gate holds.
    const riskInput = {
      architectDeclaration: "low" as const,
      stricterQualification: false,
      kernelFacts: {
        destructiveEffects: false,
        credentialEffects: false,
        externalWriteEffects: false,
        integrationConflict: false,
        changedPaths: ["docs/project/STATE.md"],
      },
    };
    store.append(seedEvent(RUN, "build.risk_assessed", `build-risk:${revision}:generation-fx2-oldkey`, "runner", "build-runtime", {
      targetRevision: revision,
      input: riskInput,
      assessment: assessBuildRisk(riskInput),
    }));
    // The old production key shape: the fixed key, no occurrence suffix.
    store.append(seedEvent(RUN, "project.handoff_requested", "project-handoff-requested", "architect", "architect", {
      summary: COMPLETION_SUMMARY,
    }));
    // Guidance withdraws it into history (the reducer path is unchanged).
    store.append(seedEvent(RUN, "user.guidance_submitted", "guidance-1", "user", "local-user", {
      guidanceId: "guidance-1",
      text: "Hold the handoff.",
      version: 1,
      interruptionProtocolVersion: 1,
    }));
    const before = rebuildSchedulerProjection(store.readRun(RUN));
    assert.equal(before.projectHandoff, undefined, "guidance withdrew the old-key handoff");
    assert.equal((before.projectHandoffHistory ?? []).length, 1);
    const eventCount = store.readRun(RUN).length;
    store.close();
    // Reopen: the old events replay byte-for-byte through today's reducer.
    const reopened = new SqliteSchedulerStore(database, {
      evidenceStore: evidence,
      validateExecutionProfile: acceptFinalVerificationProfile,
      validateCleanupReceipt: () => undefined,
    });
    try {
      const after = rebuildSchedulerProjection(reopened.readRun(RUN));
      assert.deepEqual(after.projectHandoffHistory, before.projectHandoffHistory, "the withdrawn old-key handoff replays unchanged");
      assert.equal(reopened.readRun(RUN).length, eventCount, "replay appends nothing");
      assert.equal(
        reopened.readRun(RUN).find((event) => event.type === "project.handoff_requested")!.idempotencyKey,
        "project-handoff-requested",
        "the old key shape survives the round trip",
      );
    } finally {
      reopened.close();
    }
  } finally {
    try { store.close(); } catch { /* already closed */ }
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("FX-2 probe D: guidance before any handoff completes through a real first complete_run", async () => {
  const RUN = "run-fx2-probed";
  const repo = await openGitRepo("probed", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(repo.root, "evidence.sqlite"));
  const seeder = new SqliteSchedulerStore(schedulerPath, {
    evidenceStore: evidence,
    validateExecutionProfile: acceptFinalVerificationProfile,
    validateCleanupReceipt: () => undefined,
  });
  for (const input of finishSeed(RUN, repo.baselineRevision, {
    docsVersion: 1,
    generationId: "generation-fx2-probed",
    taskId: "final-verification-fx2-probed",
    keyPrefix: "",
    planVersion: 1,
  })) seeder.append(input);
  seeder.close();
  const verifierCalls = { calls: 0 };
  const architectCalls = { calls: 0 };
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath, {
          evidenceStore: evidence,
          validateExecutionProfile: acceptFinalVerificationProfile,
          validateCleanupReceipt: () => undefined,
        });
        const runtime = buildHarnessRuntime({
          runId: RUN,
          store,
          projectDocs: gitDocsPort(repo.integration),
          architect: twoTurnCompletionArchitect(() => manager!.projection(RUN), architectCalls),
          verifier: productionShapedVerifier(RUN, () => store!, verifierCalls),
          clock: advancingClock(),
          evidenceStore: evidence,
        });
        return managedHandle(runtime, async (choice: ProjectHandoffChoice) => ({
          integrationRevision: repo.baselineRevision,
          integrationBranch: "integration",
          appliedToProject: choice === "apply_to_project",
        }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "finish"));
    assert.ok(store);
    // Step until the risk is assessed but before the Architect completes:
    // no handoff is requested yet.
    for (let index = 0; index < 10 && riskEvents(store, RUN).length < 1; index += 1) {
      await manager.step(RUN);
    }
    assert.equal(riskEvents(store, RUN).length, 1);
    assert.equal(handoffRequests(store, RUN).length, 0, "guidance lands before any handoff");
    // Guidance with no plan change (nothing to withdraw) invalidates the
    // assessment; final verification re-runs green on the same revision.
    guidanceTriple(RUN, store, evidence, "fx2-probed:evidence");
    assert.equal(manager.projection(RUN).projectHandoff, undefined);
    for (const input of finishSeed(RUN, repo.baselineRevision, {
      docsVersion: 1,
      generationId: "generation-fx2-probed-rerun",
      taskId: "final-verification-fx2-probed-rerun",
      keyPrefix: "rerun:",
      planVersion: 1,
    }).filter((event) => event.type.startsWith("final_verification."))) store.append(input);
    // The run completes through a real FIRST complete_run (bare key).
    const final = await manager.runUntilBlocked(RUN);
    assert.notEqual(final.action, "step_allowance_yielded", "no livelock after guidance before handoff");
    const requests = handoffRequests(store, RUN);
    assert.equal(requests.length, 1, "exactly one handoff request");
    assert.equal(requests[0]!.idempotencyKey, "project-handoff-requested", "the first request keeps the old key shape");
    assert.equal(architectCalls.calls, 1, "completion goes through a real first complete_run");
    assert.equal(manager.projection(RUN).status, "completed");
    assert.equal(manager.projection(RUN).projectHandoff?.choice, "apply_to_project");
  } finally {
    await manager?.close();
    store?.close();
    evidence.close();
    await repo.close();
  }
});

test("FX-2 B1 (N1 probe F): the owner's re-answer with the same product key records a new selection and the run completes", async () => {
  const RUN = "run-fx2-probeb1";
  const repo = await openGitRepo("probeb1", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(repo.root, "evidence.sqlite"));
  const seeder = new SqliteSchedulerStore(schedulerPath, {
    evidenceStore: evidence,
    validateExecutionProfile: acceptFinalVerificationProfile,
    validateCleanupReceipt: () => undefined,
  });
  // The FV review is already decided: the high-risk run proceeds to risk
  // assessment and then to verification, where the verifier is unavailable.
  for (const input of finishSeed(RUN, repo.baselineRevision, {
    docsVersion: 1,
    generationId: "generation-fx2-probeb1",
    taskId: "final-verification-fx2-probeb1",
    keyPrefix: "",
    planVersion: 1,
  })) seeder.append(input);
  seeder.close();
  const counter = { assess: 0, verify: 0 };
  const architectCalls = { calls: 0 };
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath, {
          evidenceStore: evidence,
          validateExecutionProfile: acceptFinalVerificationProfile,
          validateCleanupReceipt: () => undefined,
        });
        const clock = advancingClock();
        const runtime = buildHarnessRuntime({
          runId: RUN,
          store,
          projectDocs: gitDocsPort(repo.integration),
          architect: twoTurnCompletionArchitect(() => manager!.projection(RUN), architectCalls),
          verifier: reselectThenSatisfiedVerifier(RUN, () => store!, counter, clock, evidence),
          clock,
          evidenceStore: evidence,
        });
        return managedHandle(runtime, async (choice: ProjectHandoffChoice) => ({
          integrationRevision: repo.baselineRevision,
          integrationBranch: "integration",
          appliedToProject: choice === "apply_to_project",
        }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "finish"));
    assert.ok(store);
    // The product answers a verifier prompt with one key per runtime; the
    // spec offers exactly one verifier runtime.
    const productKey = `verifier-handoff:${RUN}:rev:reviewer`;
    // The high-risk run pauses for verifier selection (first requirement,
    // old key shape).
    await stepUntilSelections(manager, store, RUN, 1);
    assert.equal(counter.assess, 1, "one assessRisk call assessed the run");
    assert.equal(counter.verify, 1, "verify ran once and was unavailable");
    const firstRequirements = selectionRequirements(store, RUN);
    assert.equal(firstRequirements.length, 1);
    assert.equal(
      firstRequirements[0]!.idempotencyKey,
      `verifier-selection:${repo.baselineRevision}:runtime_unavailable`,
      "the first requirement keeps the old key shape",
    );
    assert.equal(manager.projection(RUN).status, "paused");
    assert.equal(manager.projection(RUN).verifierSelection?.status, "required");
    // The owner selects with the product key; the run resumes.
    await manager.selectVerifierRuntime(RUN, "rev:reviewer", productKey);
    assert.equal(manager.projection(RUN).status, "running");
    assert.equal(manager.projection(RUN).verifierSelection?.status, "selected");
    const firstSelections = selectionSelected(store, RUN);
    assert.equal(firstSelections.length, 1);
    assert.equal(firstSelections[0]!.idempotencyKey, productKey, "the first answer keeps the caller key");
    // The selected verifier is unavailable again with the same reason: a NEW
    // requirement is recorded (keyed by the selection it follows) and the
    // owner is prompted again.
    await stepUntilSelections(manager, store, RUN, 2);
    assert.equal(counter.verify, 2, "verify ran again and was unavailable again");
    const secondRequirements = selectionRequirements(store, RUN);
    assert.equal(secondRequirements.length, 2, "the re-requirement is recorded instead of deduped");
    assert.equal(
      secondRequirements[1]!.idempotencyKey,
      `verifier-selection:${repo.baselineRevision}:runtime_unavailable:sel-1`,
      "the re-requirement is keyed by the selection it follows",
    );
    assert.equal(manager.projection(RUN).status, "paused", "the owner is prompted again");
    assert.equal(manager.projection(RUN).verifierSelection?.status, "required");
    // The owner answers the NEW prompt the way the product does -- same
    // runtime, same key. Pre-fix this deduped into the first selection and
    // the single-candidate run stayed stuck; now a NEW selection records.
    await manager.selectVerifierRuntime(RUN, "rev:reviewer", productKey);
    const secondSelections = selectionSelected(store, RUN);
    assert.equal(secondSelections.length, 2, "the re-answer records a new selection");
    assert.equal(
      secondSelections[1]!.idempotencyKey,
      `${productKey}:req-2`,
      "the re-answer is scoped to the requirement it answers",
    );
    assert.equal(manager.projection(RUN).status, "running");
    assert.equal(manager.projection(RUN).verifierSelection?.status, "selected");
    assert.equal(manager.projection(RUN).verifierSelection?.selectedRuntimeId, "rev:reviewer");
    // A replay of the exact second answer dedupes: same requirement count,
    // same stored key, no third event.
    await manager.selectVerifierRuntime(RUN, "rev:reviewer", productKey);
    assert.equal(selectionSelected(store, RUN).length, 2, "the replay dedupes");
    assert.equal(manager.projection(RUN).verifierSelection?.status, "selected");
    // The run continues to completion: the third verify submits a satisfied
    // verdict, the Architect's real complete_run requests the handoff, and
    // the manager auto-applies it.
    const final = await manager.runUntilBlocked(RUN);
    assert.equal(final.status, "completed", "the run completes instead of staying stuck");
    assert.equal(counter.verify, 3, "verify ran a third time and submitted the verdict");
    assert.equal(counter.assess, 1, "no re-assessment was needed");
    assert.equal(architectCalls.calls, 1, "completion goes through one real complete_run");
    assert.equal(selectionRequirements(store, RUN).length, 2, "completion records no third requirement");
    assert.equal(selectionSelected(store, RUN).length, 2, "completion records no third selection");
    assert.equal(manager.projection(RUN).status, "completed");
    assert.equal(manager.projection(RUN).projectHandoff?.choice, "apply_to_project");
  } finally {
    await manager?.close();
    store?.close();
    evidence.close();
    await repo.close();
  }
});

test("FX-2 M2: an Architect-handoff re-offer answered with the same product key records a new selection", async () => {
  const RUN = "run-fx2-archb1";
  const repo = await openGitRepo("archb1", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(repo.root, "evidence.sqlite"));
  const seeder = new SqliteSchedulerStore(schedulerPath, {
    evidenceStore: evidence,
    validateExecutionProfile: acceptFinalVerificationProfile,
    validateCleanupReceipt: () => undefined,
  });
  for (const input of finishSeed(RUN, repo.baselineRevision, {
    docsVersion: 1,
    generationId: "generation-fx2-archb1",
    taskId: "final-verification-fx2-archb1",
    keyPrefix: "",
    planVersion: 1,
  })) seeder.append(input);
  seeder.close();
  const verifierCalls = { calls: 0 };
  const architectCalls = { calls: 0 };
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath, {
          evidenceStore: evidence,
          validateExecutionProfile: acceptFinalVerificationProfile,
          validateCleanupReceipt: () => undefined,
        });
        const runtime = buildHarnessRuntime({
          runId: RUN,
          store,
          projectDocs: gitDocsPort(repo.integration),
          architect: twoTurnCompletionArchitect(() => manager!.projection(RUN), architectCalls),
          verifier: productionShapedVerifier(RUN, () => store!, verifierCalls),
          clock: advancingClock(),
          evidenceStore: evidence,
        });
        return managedHandle(runtime, async (choice: ProjectHandoffChoice) => ({
          integrationRevision: repo.baselineRevision,
          integrationBranch: "integration",
          appliedToProject: choice === "apply_to_project",
        }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "finish"));
    assert.ok(store);
    // The product answers an Architect-handoff prompt with one key per
    // runtime. The requirements below are seeded runner-authored events, the
    // same shape the native architect router records on a provider failure;
    // the selections under test go through the manager.
    const productKey = `architect-handoff:${RUN}:arch:standby`;
    store.append(seedEvent(RUN, "architect.handoff_required", "fx2-archb1:req-1", "runner", "runtime-router", {
      reason: "architect_unavailable",
      requiredCapabilities: ["code"],
      candidateRuntimeIds: ["arch:standby"],
    }));
    assert.equal(manager.projection(RUN).status, "paused");
    await manager.selectArchitectHandoff(RUN, "arch:standby", productKey);
    assert.equal(manager.projection(RUN).runtime.architect.runtimeId, "arch:standby");
    assert.equal(manager.projection(RUN).status, "running");
    const firstSelections = handoffSelected(store, RUN);
    assert.equal(firstSelections.length, 1);
    assert.equal(firstSelections[0]!.idempotencyKey, productKey, "the first answer keeps the caller key");
    // A second offer after another failure, answered the way the product
    // does: same runtime, same key. Pre-fix this deduped into the first
    // selection and the run stayed paused; now a NEW selection records.
    store.append(seedEvent(RUN, "architect.handoff_required", "fx2-archb1:req-2", "runner", "runtime-router", {
      reason: "architect_unavailable",
      requiredCapabilities: ["code"],
      candidateRuntimeIds: ["arch:standby"],
    }));
    assert.equal(manager.projection(RUN).status, "paused", "the owner is prompted again");
    await manager.selectArchitectHandoff(RUN, "arch:standby", productKey);
    const secondSelections = handoffSelected(store, RUN);
    assert.equal(secondSelections.length, 2, "the re-answer records a new selection");
    assert.equal(
      secondSelections[1]!.idempotencyKey,
      `${productKey}:req-2`,
      "the re-answer is scoped to the requirement it answers",
    );
    assert.equal(manager.projection(RUN).runtime.architect.runtimeId, "arch:standby");
    assert.equal(manager.projection(RUN).status, "running");
    // A replay of the exact second answer dedupes.
    await manager.selectArchitectHandoff(RUN, "arch:standby", productKey);
    assert.equal(handoffSelected(store, RUN).length, 2, "the replay dedupes");
    assert.equal(manager.projection(RUN).runtime.architect.runtimeId, "arch:standby");
  } finally {
    await manager?.close();
    store?.close();
    evidence.close();
    await repo.close();
  }
});
