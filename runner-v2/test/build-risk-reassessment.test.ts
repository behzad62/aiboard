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
 * FX-1 (NF-6): after the run reaches the handoff, user guidance with
 * `no_plan_change` invalidates the build-risk assessment, and a green final
 * verification re-run lands on the SAME revision. The re-assessment must be
 * recorded as a NEW event (keyed by revision + FV generation); a
 * revision-only key dedupes it into the old event and the runtime calls
 * assessRisk every step without progress (step_allowance_yielded livelock).
 *
 * Every test below drives the production NativeBuildManager around a real
 * BuildRuntime with a production-shaped independent verifier (the real
 * deriveNativeVerifierRiskInput), real SQLite, and an advancing clock.
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
}

/**
 * Legacy-planning finish seed: plan.created with one integrated task, a
 * canonical integration revision, and a fully approved green FV generation.
 * Docs v1 also seeds the model-written STATE.md commit the v1 readiness gate
 * requires; docs v2 relies on the kernel snapshot instead.
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

/** Scripted Architect: exactly two completion turns (stop 1 and the post-guidance re-request); a third turn is a test failure. */
function completionArchitect(
  projection: () => import("../src/scheduler-store.js").SchedulerProjection,
  summary = COMPLETION_SUMMARY,
): { driver: import("../src/build-runtime.js").ArchitectRuntimeDriver; calls: () => number } {
  let calls = 0;
  let sequence = 0;
  return {
    calls: () => calls,
    driver: {
      run: async (request) => {
        calls += 1;
        if (projection().projectHandoff) {
          throw new Error(`Unexpected Architect turn after handoff: ${projection().projectHandoff?.status}.`);
        }
        if (calls > 2) {
          throw new Error(`Unexpected third Architect turn (call ${calls}).`);
        }
        sequence += 1;
        const result = await request.tools.invoke({
          type: "tool_call",
          callId: `fx1-complete-${sequence}`,
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

function riskEvents(store: SqliteSchedulerStore, runId: string): import("../src/scheduler-store.js").SchedulerEvent[] {
  return store.readRun(runId).filter((event) => event.type === "build.risk_assessed");
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
  const root = mkdtempSync(join(tmpdir(), `aiboard-fx1-${label}-`));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "shared.txt"), "baseline\n");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: `fx1-${label}-fixture`, version: "1.0.0", type: "module" }, null, 2));
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
    projectId: "fx1-fixture",
    objective: "Prove build-risk re-assessment after guidance.",
    architectRuntimeId: "arch:architect",
    workerRuntimeIds: ["work:worker"],
    verifierRuntimeIds: ["rev:reviewer"],
    alwaysRequireIndependentVerifier: false,
    maxConcurrency: 1,
    permissionProfile: "full",
    runPolicy,
    budgetLimits: {},
    createdAt: CLOCK,
    idempotencyKey: `fx1-${runId}`,
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
 * walk records the re-assessment before the Architect re-requests: on the
 * fixed code it records exactly one new event; on the broken key it
 * records none.
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

test("FX-1 v1 finish: guidance on the handoff invalidates risk, the green re-run re-assesses, the run completes", async () => {
  const RUN = "run-fx1-v1";
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
    generationId: "generation-fx1-v1",
    taskId: "final-verification-fx1-v1",
    keyPrefix: "",
    planVersion: 1,
  })) seeder.append(input);
  seeder.close();
  // The stop-1 project mutation fails once: the handoff stays requested and
  // paused instead of completing, so guidance can withdraw it below.
  let handoffCalls = 0;
  const verifierCalls = { calls: 0 };
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  const architect = completionArchitect(() => manager!.projection(RUN));
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
          architect,
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
    assert.equal(riskEvents(store, RUN).length, 1);
    assert.equal(
      riskEvents(store, RUN)[0]!.idempotencyKey,
      `build-risk:${repo.baselineRevision}:generation-fx1-v1`,
    );
    assert.equal(verifierCalls.calls, 1, "one assessRisk call assessed stop 1");
    // Guidance with no plan change withdraws the handoff and invalidates
    // the assessment; final verification re-runs green on the same revision.
    guidanceTriple(RUN, store, evidence, "fx1-v1:evidence");
    assert.equal(manager.projection(RUN).projectHandoff, undefined);
    assert.equal(manager.projection(RUN).buildRisk?.current, undefined);
    assert.deepEqual(
      manager.projection(RUN).buildRisk?.history.map((entry) => entry.state),
      ["invalidated"],
    );
    for (const input of finishSeed(RUN, repo.baselineRevision, {
      docsVersion: 1,
      generationId: "generation-fx1-v1-rerun",
      taskId: "final-verification-fx1-v1-rerun",
      keyPrefix: "rerun:",
      planVersion: 1,
    }).filter((event) => event.type.startsWith("final_verification."))) store.append(input);
    // The re-assessment lands as a NEW event even though the revision is
    // unchanged; the walk records it before the Architect re-requests.
    await stepUntilReassessed(manager, store, RUN);
    const risks = riskEvents(store, RUN);
    assert.equal(risks.length, 2, "the re-assessment is recorded instead of deduped");
    assert.equal(
      risks[1]!.idempotencyKey,
      `build-risk:${repo.baselineRevision}:generation-fx1-v1-rerun`,
    );
    assert.ok(verifierCalls.calls <= 3, `no assessRisk spin (${verifierCalls.calls} calls)`);
    assert.equal(manager.projection(RUN).buildRisk?.current?.state, "current");
    // FX-2: the Architect's real second complete_run records stop 2 as a NEW
    // request (no seeded re-request).
    const final = await manager.runUntilBlocked(RUN);
    assert.notEqual(final.action, "step_allowance_yielded", "no livelock after the re-assessment");
    const requests = store.readRun(RUN).filter((event) => event.type === "project.handoff_requested");
    assert.equal(requests.length, 2, "the second complete_run records a new request");
    assert.equal(requests[0]!.idempotencyKey, "project-handoff-requested");
    assert.equal(requests[1]!.idempotencyKey, "project-handoff-requested:1");
    assert.equal(architect.calls(), 2, "completion goes through a real second complete_run");
    assert.equal(manager.projection(RUN).status, "completed");
    assert.equal(manager.projection(RUN).projectHandoff?.choice, "apply_to_project");
    assert.equal(riskEvents(store, RUN).length, 2, "completion records no third assessment");
  } finally {
    await manager?.close();
    store?.close();
    evidence.close();
    await repo.close();
  }
});

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
  const root = mkdtempSync(join(tmpdir(), `aiboard-fx1-factory-${label}-`));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "shared.txt"), "baseline\n");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: `fx1-${label}-fixture`, version: "1.0.0", type: "module" }, null, 2));
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
      projectId: "fx1-factory-fixture",
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
      idempotencyKey: `fx1-factory-${label}`,
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

test("FX-1 docs-v2 finish: guidance on the handoff invalidates risk, the green re-run re-assesses, the run completes", async () => {
  const RUN = "run-fx1-docsv2";
  const preSeed = (runId: string, baseline: string): NewSchedulerEvent[] =>
    finishSeed(runId, baseline, {
      docsVersion: 2,
      generationId: "generation-fx1-docs",
      taskId: "final-verification-fx1-docs",
      keyPrefix: "",
      planVersion: 1,
    }).filter((event) => !event.type.startsWith("final_verification."));
  const fvSeed = (runId: string, baseline: string): NewSchedulerEvent[] =>
    finishSeed(runId, baseline, {
      docsVersion: 2,
      generationId: "generation-fx1-docs",
      taskId: "final-verification-fx1-docs",
      keyPrefix: "",
      planVersion: 1,
    }).filter((event) => event.type.startsWith("final_verification."));
  const fixture = await openFactoryPort("docsv2", RUN, preSeed, "finish");
  // The stop-1 commit lands, then the read-back fails: a transient failure
  // after the commit (or a crash before the append).
  failNextSnapshotReadOnce(fixture.integration, "Injected handoff snapshot read failure.");
  const verifierCalls = { calls: 0 };
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
          architect: completionArchitect(() => manager!.projection(RUN)),
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
    assert.equal(riskEvents(store, RUN).length, 1);
    assert.equal(verifierCalls.calls, 1);
    const stop1 = manager.events(RUN).find((event) => event.type === "project.handoff_requested")!.sequence;
    // Guidance with no plan change withdraws the handoff and invalidates
    // the assessment; final verification re-runs green on the same revision.
    guidanceTriple(RUN, store, fixture.evidence, "fx1-docsv2:evidence");
    const withdrawn = manager.projection(RUN);
    assert.equal(withdrawn.projectHandoff, undefined, "guidance withdrew the handoff");
    assert.equal((withdrawn.projectHandoffHistory ?? []).length, 1);
    for (const input of finishSeed(RUN, fixture.baselineRevision, {
      docsVersion: 2,
      generationId: "generation-fx1-docs-rerun",
      taskId: "final-verification-fx1-docs-rerun",
      keyPrefix: "rerun:",
      planVersion: 1,
    }).filter((event) => event.type.startsWith("final_verification."))) store.append(input);
    await stepUntilReassessed(manager, store, RUN);
    const risks = riskEvents(store, RUN);
    assert.equal(risks.length, 2, "the re-assessment is recorded instead of deduped");
    assert.equal(
      risks[1]!.idempotencyKey,
      `build-risk:${fixture.baselineRevision}:generation-fx1-docs-rerun`,
    );
    assert.ok(verifierCalls.calls <= 3, `no assessRisk spin (${verifierCalls.calls} calls)`);
    // FX-2: the Architect's real second complete_run re-requests (stop 2):
    // the withdrawn stop reconciles as history, the chain continues, and
    // the handoff completes (no seeded re-request).
    const final = await manager.runUntilBlocked(RUN);
    assert.notEqual(final.action, "step_allowance_yielded", "no livelock after the re-assessment");
    const docsv2Requests = manager.events(RUN).filter((event) => event.type === "project.handoff_requested");
    assert.equal(docsv2Requests.length, 2, "the second complete_run records a new request");
    assert.equal(docsv2Requests[1]!.idempotencyKey, "project-handoff-requested:1");
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 2);
    const first = snapshots[0]!.payload as Record<string, unknown>;
    const second = snapshots[1]!.payload as Record<string, unknown>;
    assert.equal(first.stopSequence, stop1, "the withdrawn stop is recorded first, as history");
    assert.equal(second.parent, first.commit, "the new snapshot continues the withdrawn commit");
    const projection = manager.projection(RUN);
    assert.equal(projection.status, "completed", "the handoff succeeds after re-assessment");
    assert.equal(projection.projectHandoff?.choice, "apply_to_project");
    assert.deepEqual(order, ["projectHandoff:2", "applied"], "the project changes only after the kernel accepts");
    assert.equal(riskEvents(store, RUN).length, 2, "completion records no third assessment");
  } finally {
    await manager?.close();
    store?.close();
    await fixture.close();
  }
});

test("FX-1 restart after the re-assessment replays without a duplicate assessment", async () => {
  const RUN = "run-fx1-restart";
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
    generationId: "generation-fx1-restart",
    taskId: "final-verification-fx1-restart",
    keyPrefix: "",
    planVersion: 1,
  })) seeder.append(input);
  seeder.close();
  const verifierCalls = { calls: 0 };
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
        architect: completionArchitect(() => manager!.projection(RUN)),
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
  try {
    manager = openManager();
    await manager.create(managerSpec(RUN, "finish"));
    assert.ok(store);
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    assert.equal(manager.projection(RUN).projectHandoff?.status, "requested");
    guidanceTriple(RUN, store, evidence, "fx1-restart:evidence");
    for (const input of finishSeed(RUN, repo.baselineRevision, {
      docsVersion: 1,
      generationId: "generation-fx1-restart-rerun",
      taskId: "final-verification-fx1-restart-rerun",
      keyPrefix: "rerun:",
      planVersion: 1,
    }).filter((event) => event.type.startsWith("final_verification."))) store.append(input);
    await stepUntilReassessed(manager, store, RUN);
    assert.equal(riskEvents(store, RUN).length, 2);
    const callsBeforeRestart = verifierCalls.calls;
    // Restart in the middle: close everything, reopen on the same files.
    // (store keeps its closed handle until recovery reopens it below.)
    await manager.close();
    store?.close();
    manager = openManager();
    await manager.recover();
    assert.ok(store, "recovery reopens the scheduler store");
    assert.equal(riskEvents(store, RUN).length, 2, "replay records no duplicate assessment");
    assert.equal(
      manager.projection(RUN).buildRisk?.current?.state,
      "current",
      "the re-assessment is current after replay",
    );
    // The restarted run steps without re-assessing; the Architect's real
    // second complete_run records stop 2 (no seeded re-request) and the run
    // completes.
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    assert.equal(manager.projection(RUN).status, "completed");
    const restartRequests = store.readRun(RUN).filter((event) => event.type === "project.handoff_requested");
    assert.equal(restartRequests.length, 2, "the second complete_run records a new request");
    assert.equal(restartRequests[1]!.idempotencyKey, "project-handoff-requested:1");
    assert.equal(riskEvents(store, RUN).length, 2, "no duplicate assessment after restart");
    assert.equal(verifierCalls.calls, callsBeforeRestart, "the restarted run never re-assesses current risk");
  } finally {
    await manager?.close();
    store?.close();
    evidence.close();
    await repo.close();
  }
});

test("FX-1 a pre-fix log with the revision-only key shape replays unchanged", async () => {
  const RUN = "run-fx1-oldkey";
  const root = mkdtempSync(join(tmpdir(), "aiboard-fx1-oldkey-"));
  const database = join(root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const revision = "b".repeat(40);
  const input = {
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
  const store = new SqliteSchedulerStore(database, {
    evidenceStore: evidence,
    validateExecutionProfile: acceptFinalVerificationProfile,
    validateCleanupReceipt: () => undefined,
  });
  try {
    store.append(seedEvent(RUN, "run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "finish" }));
    store.append(seedEvent(RUN, "verifier.policy_configured", "verifier:policy", "runner", "build-runtime", {
      mode: "risk_based",
      candidateRuntimeIds: ["rev:reviewer"],
      alwaysRequireIndependentVerifier: false,
    }));
    store.append(seedEvent(RUN, "plan.created", "plan", "architect", "architect", {
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
    store.append(seedEvent(RUN, "integration.revision_advanced", "integration-revision", "runner", "integration", {
      integrationRevision: revision,
    }));
    for (const event of finishSeed(RUN, revision, {
      docsVersion: 1,
      generationId: "generation-fx1-old",
      taskId: "final-verification-fx1-old",
      keyPrefix: "",
      planVersion: 1,
    }).filter((e) => e.type.startsWith("final_verification.") || e.type === "project_docs.policy_configured")) {
      store.append(event);
    }
    // The old production key shape: revision only, no generation.
    store.append(seedEvent(RUN, "build.risk_assessed", `build-risk:${revision}`, "runner", "build-runtime", {
      targetRevision: revision,
      input,
      assessment: assessBuildRisk(input),
    }));
    const before = rebuildSchedulerProjection(store.readRun(RUN));
    assert.equal(before.buildRisk?.current?.state, "current");
    const eventCount = store.readRun(RUN).length;
    store.close();
    // Reopen: the old event replays byte-for-byte through today's reducer.
    const reopened = new SqliteSchedulerStore(database, {
      evidenceStore: evidence,
      validateExecutionProfile: acceptFinalVerificationProfile,
      validateCleanupReceipt: () => undefined,
    });
    try {
      const after = rebuildSchedulerProjection(reopened.readRun(RUN));
      assert.deepEqual(after.buildRisk, before.buildRisk, "the old assessment replays unchanged");
      assert.equal(reopened.readRun(RUN).length, eventCount, "replay appends nothing");
      assert.equal(
        reopened.readRun(RUN).find((event) => event.type === "build.risk_assessed")!.idempotencyKey,
        `build-risk:${revision}`,
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
