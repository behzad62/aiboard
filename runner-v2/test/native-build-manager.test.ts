import assert from "node:assert/strict";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { BuildRuntime } from "../src/build-runtime.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { ArtifactReachabilityGuard } from "../src/artifact-reachability.js";
import type { NativeBuildSpec } from "../src/build-spec.js";
import { NativeBuildManager } from "../src/native-build-manager.js";
import { LocalPluginLoader, type LoadedRunnerExtensions } from "../src/plugin-loader.js";
import {
  createRunnerCapabilityContract,
  RunnerCapabilityContractError,
} from "../src/runner-capability-contract.js";
import {
  configuredModelUsageRuntime,
  providerHealthFromSchedulerEvents,
  selectRuntimeCandidates,
} from "../src/native-build-factory.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import type { SchedulerProjection } from "../src/scheduler-store.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import {
  acceptFinalVerificationProfile,
  emptyFinalVerificationProfile,
} from "./support/final-verification-profile.js";

const spec: NativeBuildSpec = {
  version: 2,
  runId: "run_1",
  projectId: "project_1",
  objective: "Build a reliable application.",
  architectRuntimeId: "chatgpt:gpt-5.5",
  workerRuntimeIds: ["chatgpt:gpt-5.4"],
  verifierRuntimeIds: ["chatgpt:gpt-5.4"],
  alwaysRequireIndependentVerifier: false,
  maxConcurrency: 1,
  permissionProfile: "full",
  runPolicy: "budgeted",
  budgetLimits: {
    maxEstimatedCostMicros: 1_000_000,
    maxActiveMs: 60_000,
  },
  createdAt: "2026-07-12T00:00:00.000Z",
  idempotencyKey: "build-spec:run_1",
};

test("recovery upgrades a parent-format acknowledged interruption while adopting a newer verification generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-legacy-steering-upgrade-"));
  const schedulerPath = join(root, "scheduler.sqlite");
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const initialStore = new SqliteSchedulerStore(schedulerPath, {
    evidenceStore,
    validateExecutionProfile: acceptFinalVerificationProfile,
  });
  initialStore.close();
  const evidence = evidenceStore.record({
    runId: spec.runId,
    taskId: "architect",
    actor: { role: "architect", id: "architect_1" },
    fact: {
      kind: "browser_screenshot",
      label: "parent-format steering evidence",
      capturedAt: spec.createdAt,
      screenshotArtifactHash: "a".repeat(64),
      mediaType: "image/png",
      byteLength: 1,
    },
    createdAt: spec.createdAt,
    idempotencyKey: "legacy-steering-evidence",
  });
  const revision = "b".repeat(40);
  const plan = {
    checks: (["build", "tests", "runtime_smoke", "browser"] as const).map((category) => ({
      category,
      status: "not_applicable" as const,
      rationale: `The parent fixture has no ${category} entry point.`,
      repositoryInspection: {
        paths: ["package.json"],
        summary: `No ${category} entry point is present.`,
      },
    })),
  };
  const generation = (generationId: string, taskId: string, planVersion: number) => ({
    taskId,
    generationId,
    targetRevision: revision,
    planVersion,
    plan,
    executionProfile: emptyFinalVerificationProfile(revision),
  });
  const parentEvents = [
    { type: "run.initialized", actor: { role: "runner", id: "runner" }, key: "run:init", payload: { objective: spec.objective } },
    { type: "run.policy_configured", actor: { role: "runner", id: "runner" }, key: "run:policy", payload: { runPolicy: "finish" } },
    { type: "plan.created", actor: { role: "architect", id: "architect_1" }, key: "plan:one", payload: { revision: 1, tasks: [] } },
    { type: "integration.revision_advanced", actor: { role: "runner", id: "integration-manager" }, key: "revision:one", payload: { integrationRevision: revision } },
    { type: "final_verification.generation_created", actor: { role: "runner", id: "build-runtime" }, key: "generation:a", payload: generation("generation-a", "verification-a", 1) },
    { type: "user.guidance_submitted", actor: { role: "user", id: "local-user" }, key: "guidance:legacy", payload: { guidanceId: "guidance-legacy", text: "Keep the verified scope.", version: 1 } },
    {
      type: "user.guidance_acknowledged", actor: { role: "architect", id: "architect_1" }, key: "guidance:legacy:ack",
      payload: {
        guidanceId: "guidance-legacy", expectedVersion: 1,
        resolution: { type: "no_plan_change", rationale: "Durable evidence proves semantic equivalence.", evidenceIds: [evidence.id] },
      },
    },
    { type: "final_verification.generation_created", actor: { role: "runner", id: "build-runtime" }, key: "generation:b", payload: generation("generation-b", "verification-b", 2) },
  ];
  const database = new DatabaseSync(schedulerPath);
  try {
    const insert = database.prepare(`INSERT INTO scheduler_events (
      event_id, run_id, sequence, event_type, occurred_at, actor_json, idempotency_key, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    parentEvents.forEach((event, index) => insert.run(
      `legacy-${index + 1}`,
      spec.runId,
      index + 1,
      event.type,
      spec.createdAt,
      JSON.stringify(event.actor),
      event.key,
      JSON.stringify(event.payload),
    ));
  } finally {
    database.close();
  }

  const workspaceMarker = join(root, "generation-b-workspace.txt");
  writeFileSync(workspaceMarker, "owned by generation B\n");
  let leaseActive = true;
  let manager: NativeBuildManager | undefined;
  let scheduler: SqliteSchedulerStore | undefined;
  try {
    const savedSpecs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
    savedSpecs.save(spec);
    savedSpecs.close();
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: async () => {
        scheduler = new SqliteSchedulerStore(schedulerPath, {
          evidenceStore,
          validateExecutionProfile: acceptFinalVerificationProfile,
        });
        const runtime = new BuildRuntime({
          runId: spec.runId,
          initialObjective: spec.objective,
          runPolicy: "finish",
          store: scheduler,
          evidenceStore,
          workerDriver: { run: async () => ({ type: "paused", reason: "unused" }) },
          architectDriver: { run: async () => undefined },
          integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: revision }) },
          maxConcurrency: 1,
          workspaceFor: async () => "unused",
        });
        return {
          ...handleProjections(spec.runId), runtime,
          usage: () => emptyBudget(spec.runId), observability: async () => emptyObservability(spec.runId),
          projectHandoff: async () => ({ integrationRevision: revision, integrationBranch: "integration", appliedToProject: false }),
          retireInvalidatedFinalVerification: async (invalidated, current) => {
            assert.equal(invalidated.generationId, "generation-a");
            assert.equal(current?.generationId, "generation-b");
            assert.equal(existsSync(workspaceMarker), true);
            assert.equal(leaseActive, true);
          },
          cleanup: async () => undefined,
          close: async () => {
            scheduler?.close();
            scheduler = undefined;
          },
        };
      },
    });
    await manager.recover();
    const upgraded = manager.projection(spec.runId);
    assert.equal(upgraded.initialObjective, spec.objective);
    assert.equal(upgraded.userGuidance["guidance-legacy"].status, "acknowledged");
    assert.equal(upgraded.userGuidance["guidance-legacy"].interruptionStatus, "completed");
    assert.equal(upgraded.finalVerification?.current?.generationId, "generation-b");
    assert.equal(existsSync(workspaceMarker), true);
    assert.equal(leaseActive, true);
    assert.equal(manager.events(spec.runId).filter((event) => event.type === "user.guidance_interruption_completed").length, 1);
    const replayed = await manager.submitUserGuidance(spec.runId, {
      guidanceId: "guidance-legacy",
      text: "Keep the verified scope.",
      version: 1,
      idempotencyKey: "guidance:legacy",
    });
    assert.equal(replayed.userGuidance["guidance-legacy"].interruptionStatus, "completed");
    assert.equal(manager.events(spec.runId).filter((event) => event.type === "user.guidance_submitted").length, 1);
    assert.equal(manager.events(spec.runId).filter((event) => event.type === "user.guidance_interruption_completed").length, 1);
  } finally {
    leaseActive = false;
    await manager?.close();
    if (scheduler) {
      scheduler.close();
      scheduler = undefined;
    }
    evidenceStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit pause quiesces exact run resources without invoking workspace cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-pause-quiesce-"));
  const calls: string[] = [];
  let manager: NativeBuildManager | undefined;
  try {
    const specs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
    const projection = fakeRuntime("run_1").projection();
    const runtime = {
      ...fakeRuntime("run_1"),
      pause: () => { projection.status = "paused"; calls.push("pause"); return projection; },
      projection: () => projection,
    } as unknown as BuildRuntime;
    manager = new NativeBuildManager({
      specs,
      createRuntime: async () => ({
        ...handleProjections("run_1"), runtime,
        usage: () => emptyBudget("run_1"), observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => ({ integrationRevision: "r", integrationBranch: "b", appliedToProject: false }),
        finalVerificationCleanup: {
          quiesceRun: async () => { calls.push("quiesce"); },
          cleanup: async () => { calls.push("cleanup"); return {}; },
        },
        cleanup: async () => undefined, close: async () => undefined,
      }),
    });
    await manager.create(spec);
    await manager.pause("run_1", "user pause", "pause-one");
    assert.deepEqual(calls, ["pause", "quiesce"]);
  } finally { await manager?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("startup recovery quiesces active run resources without removing verification state", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-recovery-quiesce-"));
  let workspacePresent = true;
  const calls: string[] = [];
  let manager: NativeBuildManager | undefined;
  try {
    const specs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
    specs.save(spec);
    manager = new NativeBuildManager({
      specs,
      createRuntime: async () => ({
        ...handleProjections("run_1"), runtime: fakeRuntime("run_1"),
        usage: () => emptyBudget("run_1"), observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => ({ integrationRevision: "r", integrationBranch: "b", appliedToProject: false }),
        finalVerificationCleanup: {
          quiesceRun: async () => { calls.push("quiesce"); },
          cleanup: async () => { workspacePresent = false; calls.push("cleanup"); return {}; },
        },
        cleanup: async () => undefined, close: async () => undefined,
      }),
    });
    await manager.recover();
    assert.deepEqual(calls, ["quiesce"]);
    assert.equal(workspacePresent, true);
  } finally { await manager?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("autonomous pump error durably pauses then quiesces exact run resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-error-quiesce-"));
  const calls: string[] = [];
  const errors: unknown[] = [];
  let manager: NativeBuildManager | undefined;
  try {
    const projection = fakeRuntime("run_1").projection();
    const runtime = {
      ...fakeRuntime("run_1"), projection: () => projection,
      runUntilBlocked: async () => { throw new Error("pump failed"); },
      pause: () => { projection.status = "paused"; calls.push("pause"); return projection; },
    } as unknown as BuildRuntime;
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      onPumpError: (_runId, error) => errors.push(error),
      createRuntime: async () => ({
        ...handleProjections("run_1"), runtime,
        usage: () => emptyBudget("run_1"), observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => ({ integrationRevision: "r", integrationBranch: "b", appliedToProject: false }),
        finalVerificationCleanup: {
          quiesceRun: async () => { calls.push("quiesce"); }, cleanup: async () => ({}),
        },
        cleanup: async () => undefined, close: async () => undefined,
      }),
    });
    await manager.create(spec); manager.activate("run_1"); await manager.awaitIdle("run_1");
    assert.deepEqual(calls, ["pause", "quiesce"]);
    assert.equal(errors.length, 1);
  } finally { await manager?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an unanswered Architect question quiesces the autonomous pump without pausing the run", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-question-blocked-"));
  const results: Array<{ status: string; action?: string }> = [];
  const errors: unknown[] = [];
  let pauseCalls = 0;
  let quiesceCalls = 0;
  let manager: NativeBuildManager | undefined;
  try {
    const projection: SchedulerProjection = {
      ...fakeRuntime("run_1").projection(),
      status: "running",
      architectQuestions: {
        "question-1": {
          questionId: "question-1",
          version: 1,
          decisionKind: "authority_decision",
          question: "Choose the authoritative deployment target.",
          status: "open",
        },
      },
      architectQuestionVersion: 1,
      blockingArchitectQuestionId: "question-1",
    };
    const runtime = {
      ...fakeRuntime("run_1"),
      projection: () => projection,
      runUntilBlocked: async () => ({
        status: "blocked" as const,
        action: "architect_question_pending",
      }),
      pause: () => {
        pauseCalls += 1;
        projection.status = "paused";
        return projection;
      },
    } as unknown as BuildRuntime;
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      onPumpResult: (_runId, result) => results.push(result),
      onPumpError: (_runId, error) => errors.push(error),
      createRuntime: async () => ({
        ...handleProjections("run_1"),
        runtime,
        usage: () => emptyBudget("run_1"),
        observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => ({
          integrationRevision: "revision_final",
          integrationBranch: "aiboard/run/integration",
          appliedToProject: false,
        }),
        finalVerificationCleanup: {
          quiesceRun: async () => { quiesceCalls += 1; },
          cleanup: async () => ({}),
        },
        cleanup: () => undefined,
        close: () => undefined,
      }),
    });

    await manager.create(spec);
    manager.activate("run_1");
    await manager.awaitIdle("run_1");

    assert.equal(projection.status, "running");
    assert.equal(projection.blockingArchitectQuestionId, "question-1");
    assert.equal(pauseCalls, 0);
    assert.equal(quiesceCalls, 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(results, [
      { status: "blocked", action: "architect_question_pending" },
    ]);
  } finally {
    await manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable steering appends before the manager wakes the autonomous pump", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-steering-wake-"));
  const calls: string[] = [];
  let manager: NativeBuildManager | undefined;
  try {
    const projection = fakeRuntime("run_1").projection();
    const runtime = {
      ...fakeRuntime("run_1"),
      projection: () => projection,
      submitUserGuidance: () => {
        calls.push("guidance-appended");
        return projection;
      },
      answerArchitectQuestion: () => {
        calls.push("answer-appended");
        return projection;
      },
      runUntilBlocked: async () => {
        calls.push("pump-started");
        return { status: "blocked" as const, action: "architect_question_pending" };
      },
    } as unknown as BuildRuntime;
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: async () => ({
        ...handleProjections("run_1"),
        runtime,
        usage: () => emptyBudget("run_1"),
        observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => ({
          integrationRevision: "revision-final",
          integrationBranch: "aiboard/run/integration",
          appliedToProject: false,
        }),
        finalVerificationCleanup: {
          quiesceRun: async () => { calls.push("verification-quiesced"); },
          cleanup: async () => ({}),
        },
        cleanup: async () => undefined,
        close: async () => undefined,
      }),
    });
    await manager.create(spec);

    await manager.submitUserGuidance("run_1", {
      guidanceId: "guidance-1",
      text: "Preserve the public API.",
      version: 1,
      idempotencyKey: "guidance:1",
    });
    await manager.awaitIdle("run_1");
    assert.deepEqual(calls, [
      "guidance-appended",
      "verification-quiesced",
      "pump-started",
      "verification-quiesced",
    ]);

    calls.length = 0;
    await manager.answerArchitectQuestion("run_1", {
      questionId: "question-1",
      expectedVersion: 1,
      answer: "Use the documented API.",
      idempotencyKey: "question:1:answer",
    });
    await manager.awaitIdle("run_1");
    assert.deepEqual(calls, ["answer-appended", "pump-started", "verification-quiesced"]);
  } finally {
    await manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable steering retires the exact invalidated verification generation before pumping", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-steering-retirement-"));
  let manager: NativeBuildManager | undefined;
  const calls: string[] = [];
  let projection = requestedHandoffProjection("finish");
  projection = { ...projection, status: "running", projectHandoff: undefined };
  const invalidated = projection.finalVerification!.current!;
  try {
    const runtime = {
      ...fakeRuntime("run_1"),
      projection: () => projection,
      submitUserGuidance: () => {
        calls.push("guidance-appended");
        projection = {
          ...projection,
          finalVerification: {
            history: [{ ...invalidated, state: "invalidated", invalidatedByGuidanceId: "guidance-retire" }],
          },
        };
        return projection;
      },
      runUntilBlocked: async () => {
        calls.push("pump-started");
        return { status: "blocked" as const, action: "user_guidance_required" };
      },
    } as unknown as BuildRuntime;
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: async () => ({
        ...handleProjections("run_1"),
        runtime,
        usage: () => emptyBudget("run_1"),
        observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => ({
          integrationRevision: "revision-final",
          integrationBranch: "aiboard/run/integration",
          appliedToProject: false,
        }),
        finalVerificationCleanup: {
          quiesceRun: async () => { calls.push("verification-quiesced"); },
          cleanup: async () => ({}),
        },
        retireInvalidatedFinalVerification: async (generation: typeof invalidated) => {
          assert.equal(generation.generationId, invalidated.generationId);
          calls.push("verification-retired");
        },
        cleanup: async () => undefined,
        close: async () => undefined,
      }),
    });
    await manager.create(spec);
    await manager.submitUserGuidance("run_1", {
      guidanceId: "guidance-retire",
      text: "Interrupt verification safely.",
      version: 1,
      idempotencyKey: "guidance:retire",
    });
    await manager.awaitIdle("run_1");
    assert.deepEqual(calls.slice(0, 4), [
      "guidance-appended",
      "verification-retired",
      "pump-started",
      "verification-quiesced",
    ]);
  } finally {
    await manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("active pump cannot consume guidance until exact verification retirement completes", { timeout: 2_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-steering-retirement-barrier-"));
  let manager: NativeBuildManager | undefined;
  let releaseActive!: () => void;
  let releaseRetirement!: () => void;
  let activeStarted!: () => void;
  const activeRelease = new Promise<void>((resolve) => { releaseActive = resolve; });
  const retirementRelease = new Promise<void>((resolve) => { releaseRetirement = resolve; });
  const activeObserved = new Promise<void>((resolve) => { activeStarted = resolve; });
  let projection = requestedHandoffProjection("finish");
  projection = { ...projection, status: "running", projectHandoff: undefined };
  const invalidated = projection.finalVerification!.current!;
  let barrier = false;
  let freshGenerationId: string | undefined;
  let calls = 0;
  const trace: string[] = [];
  const runtime = {
    ...fakeRuntime("run_1"),
    projection: () => projection,
    submitUserGuidanceWithOutcome: () => {
      projection = {
        ...projection,
        finalVerification: {
          history: [{ ...invalidated, state: "invalidated", invalidatedByGuidanceId: "guidance-race" }],
        },
      };
      trace.push("guidance-appended");
      barrier = true;
      trace.push("barrier-set");
      return { projection, appended: true };
    },
    submitManagedUserGuidance: () => {
      projection = {
        ...projection,
        userGuidance: {
          "guidance-race": {
            guidanceId: "guidance-race",
            text: "Retire the old verification before replanning.",
            version: 1,
            status: "submitted",
            interruptionStatus: "pending",
          },
        },
        finalVerification: {
          history: [{ ...invalidated, state: "invalidated", invalidatedByGuidanceId: "guidance-race" }],
        },
      };
      trace.push("guidance-appended");
      barrier = true;
      trace.push("barrier-set");
      return projection;
    },
    completeManagedUserGuidanceInterruption: () => {
      barrier = false;
      projection.userGuidance["guidance-race"].interruptionStatus = "completed";
      trace.push("barrier-released");
      return projection;
    },
    runUntilBlocked: async () => {
      calls += 1;
      if (calls === 1) {
        trace.push("active-checkpoint");
        activeStarted();
        await activeRelease;
        return { status: "progressed" as const, action: "stale-checkpoint-ended" };
      }
      if (barrier) {
        trace.push("pump-blocked-by-retirement");
        return { status: "blocked" as const, action: "user_guidance_retirement_pending" };
      }
      trace.push("guidance-acknowledged-and-fresh-generation-created");
      freshGenerationId = "generation-fresh";
      projection = {
        ...projection,
        finalVerification: {
          current: { ...invalidated, generationId: freshGenerationId },
          history: [...(projection.finalVerification?.history ?? [])],
        },
      };
      return { status: "blocked" as const, action: "fresh_final_verification_planned" };
    },
  } as unknown as BuildRuntime;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: async () => ({
        ...handleProjections("run_1"), runtime,
        usage: () => emptyBudget("run_1"), observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => ({ integrationRevision: "revision-final", integrationBranch: "aiboard/run/integration", appliedToProject: false }),
        retireInvalidatedFinalVerification: async () => {
          trace.push("retirement-started");
          await retirementRelease;
          trace.push("retirement-finished");
        },
        finalVerificationCleanup: { quiesceRun: async () => undefined, cleanup: async () => ({}) },
        cleanup: async () => undefined, close: async () => undefined,
      }),
    });
    await manager.create(spec);
    manager.activate("run_1");
    await activeObserved;
    const steering = manager.submitUserGuidance("run_1", {
      guidanceId: "guidance-race",
      text: "Retire the old verification before replanning.",
      version: 1,
      idempotencyKey: "guidance:race",
    });
    releaseActive();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(trace.includes("guidance-acknowledged-and-fresh-generation-created"), false);
    assert.equal(projection.finalVerification?.current, undefined);
    releaseRetirement();
    await steering;
    await manager.awaitIdle("run_1");
    assert.equal(trace.indexOf("retirement-finished") < trace.indexOf("guidance-acknowledged-and-fresh-generation-created"), true);
    assert.equal(freshGenerationId, "generation-fresh");
  } finally {
    releaseActive?.();
    releaseRetirement?.();
    await manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("acknowledged exact guidance replay performs no later lifecycle side effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-guidance-replay-no-effects-"));
  let manager: NativeBuildManager | undefined;
  let quiesceCalls = 0;
  let retirementCalls = 0;
  const projection = {
    ...fakeRuntime("run_1").projection(),
    userGuidance: {
      "guidance-replay": {
        guidanceId: "guidance-replay",
        text: "Already handled.",
        version: 1,
        status: "acknowledged" as const,
        interruptionStatus: "completed" as const,
        resolution: { type: "no_plan_change" as const, rationale: "Equivalent.", evidenceIds: ["evidence-1"] },
      },
    },
  };
  const runtime = {
    ...fakeRuntime("run_1"),
    projection: () => projection,
    submitManagedUserGuidance: () => projection,
    runUntilBlocked: async () => ({ status: "blocked" as const, action: "later-worker-active" }),
  } as unknown as BuildRuntime;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: async () => ({
        ...handleProjections("run_1"), runtime,
        usage: () => emptyBudget("run_1"), observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => ({ integrationRevision: "r", integrationBranch: "b", appliedToProject: false }),
        finalVerificationCleanup: { quiesceRun: async () => { quiesceCalls += 1; }, cleanup: async () => ({}) },
        retireInvalidatedFinalVerification: async () => { retirementCalls += 1; },
        cleanup: async () => undefined, close: async () => undefined,
      }),
    });
    await manager.create(spec);
    const replayed = await manager.submitUserGuidance("run_1", {
      guidanceId: "guidance-replay",
      text: "Already handled.",
      version: 1,
      idempotencyKey: "guidance:replay",
    });
    assert.equal(replayed.userGuidance?.["guidance-replay"]?.status, "acknowledged");
    assert.equal(quiesceCalls, 0);
    assert.equal(retirementCalls, 0);
  } finally {
    await manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("completed exact guidance replay succeeds without touching a failing cleanup service", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-terminal-guidance-replay-"));
  let manager: NativeBuildManager | undefined;
  const projection = {
    ...fakeRuntime("run_1").projection(),
    status: "completed" as const,
    userGuidance: {
      "guidance-terminal": {
        guidanceId: "guidance-terminal",
        text: "Accepted before completion.",
        version: 1,
        status: "acknowledged" as const,
        interruptionStatus: "completed" as const,
        resolution: { type: "no_plan_change" as const, rationale: "Equivalent.", evidenceIds: ["evidence-1"] },
      },
    },
  };
  const runtime = {
    ...fakeRuntime("run_1"),
    projection: () => projection,
    submitManagedUserGuidance: () => projection,
  } as unknown as BuildRuntime;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: async () => ({
        ...handleProjections("run_1"), runtime,
        usage: () => emptyBudget("run_1"), observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => ({ integrationRevision: "r", integrationBranch: "b", appliedToProject: false }),
        finalVerificationCleanup: {
          quiesceRun: async () => { throw new Error("cleanup unavailable"); },
          cleanup: async () => { throw new Error("cleanup unavailable"); },
        },
        cleanup: async () => undefined, close: async () => undefined,
      }),
    });
    await manager.create(spec);
    const replayed = await manager.submitUserGuidance("run_1", {
      guidanceId: "guidance-terminal",
      text: "Accepted before completion.",
      version: 1,
      idempotencyKey: "guidance:terminal",
    });
    assert.equal(replayed.status, "completed");
  } finally {
    await manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact retry after post-append retirement failure retries cleanup and releases durable progress", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-guidance-retirement-retry-"));
  let manager: NativeBuildManager | undefined;
  let attempts = 0;
  let projection = {
    ...fakeRuntime("run_1").projection(),
    userGuidance: {} as SchedulerProjection["userGuidance"],
  };
  const runtime = {
    ...fakeRuntime("run_1"),
    projection: () => projection,
    submitManagedUserGuidance: () => {
      projection = {
        ...projection,
        userGuidance: {
          "guidance-retry": {
            guidanceId: "guidance-retry", text: "Retry cleanup.", version: 1,
            status: "submitted", interruptionStatus: "pending",
          },
        },
      };
      return projection;
    },
    completeManagedUserGuidanceInterruption: () => {
      projection.userGuidance["guidance-retry"].interruptionStatus = "completed";
      return projection;
    },
    runUntilBlocked: async () => ({ status: "blocked" as const, action: "user_guidance_required" }),
  } as unknown as BuildRuntime;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: async () => ({
        ...handleProjections("run_1"), runtime,
        usage: () => emptyBudget("run_1"), observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => ({ integrationRevision: "r", integrationBranch: "b", appliedToProject: false }),
        finalVerificationCleanup: {
          quiesceRun: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("cleanup unavailable");
          },
          cleanup: async () => ({}),
        },
        cleanup: async () => undefined, close: async () => undefined,
      }),
    });
    await manager.create(spec);
    const input = { guidanceId: "guidance-retry", text: "Retry cleanup.", version: 1, idempotencyKey: "guidance:retry" };
    await assert.rejects(manager.submitUserGuidance("run_1", input), /cleanup unavailable/i);
    assert.equal(projection.userGuidance["guidance-retry"].interruptionStatus, "pending");
    const replayed = await manager.submitUserGuidance("run_1", input);
    assert.equal(attempts, 2);
    assert.equal(replayed.userGuidance?.["guidance-retry"]?.interruptionStatus, "completed");
  } finally {
    await manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery retires a durably invalidated generation after post-append cleanup failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-steering-retirement-recovery-"));
  const specsPath = join(root, "builds.sqlite");
  let first: NativeBuildManager | undefined;
  let recovered: NativeBuildManager | undefined;
  const calls: string[] = [];
  let projection = requestedHandoffProjection("finish");
  projection = { ...projection, status: "running", projectHandoff: undefined };
  const invalidated = projection.finalVerification!.current!;
  const runtime = {
    ...fakeRuntime("run_1"),
    projection: () => projection,
    submitUserGuidance: () => {
      projection = {
        ...projection,
        finalVerification: {
          history: [{ ...invalidated, state: "invalidated", invalidatedByGuidanceId: "guidance-recover-retire" }],
        },
      };
      return projection;
    },
    runUntilBlocked: async () => {
      calls.push("pump-started");
      return { status: "blocked" as const, action: "user_guidance_required" };
    },
  } as unknown as BuildRuntime;
  try {
    first = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(specsPath),
      createRuntime: async () => ({
        ...handleProjections("run_1"), runtime,
        usage: () => emptyBudget("run_1"), observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => ({ integrationRevision: "revision-final", integrationBranch: "aiboard/run/integration", appliedToProject: false }),
        retireInvalidatedFinalVerification: async () => { throw new Error("cleanup storage unavailable"); },
        cleanup: async () => undefined, close: async () => undefined,
      }),
    });
    await first.create(spec);
    await assert.rejects(
      first.submitUserGuidance("run_1", {
        guidanceId: "guidance-recover-retire",
        text: "Persist before cleanup fails.",
        version: 1,
        idempotencyKey: "guidance:recover-retire",
      }),
      /cleanup storage unavailable/i,
    );
    assert.equal(projection.finalVerification?.history[0]?.invalidatedByGuidanceId, "guidance-recover-retire");
    await first.close();
    first = undefined;

    recovered = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(specsPath),
      shouldAutoRun: () => true,
      createRuntime: async () => ({
        ...handleProjections("run_1"), runtime,
        usage: () => emptyBudget("run_1"), observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => ({ integrationRevision: "revision-final", integrationBranch: "aiboard/run/integration", appliedToProject: false }),
        retireInvalidatedFinalVerification: async (generation) => {
          assert.equal(generation.generationId, invalidated.generationId);
          calls.push("verification-retired-after-restart");
        },
        cleanup: async () => undefined, close: async () => undefined,
      }),
    });
    await recovered.recover();
    await recovered.awaitIdle("run_1");
    assert.deepEqual(calls.slice(0, 2), ["verification-retired-after-restart", "pump-started"]);
  } finally {
    await first?.close();
    await recovered?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery adopts an invalidated generation without removing a newer current workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-steering-adoption-recovery-"));
  let manager: NativeBuildManager | undefined;
  const approved = requestedHandoffProjection("finish").finalVerification!.current!;
  const invalidated = {
    ...approved,
    state: "invalidated" as const,
    invalidatedByGuidanceId: "guidance-adopt",
  };
  const current = {
    ...approved,
    generationId: "generation-newer",
    planVersion: approved.planVersion + 1,
  };
  let workspaceExists = true;
  const projection: SchedulerProjection = {
    ...fakeRuntime("run_1").projection(),
    userGuidance: {
      "guidance-adopt": {
        guidanceId: "guidance-adopt", text: "Preserve the newer generation.", version: 1,
        status: "acknowledged", interruptionStatus: "pending",
        resolution: { type: "no_plan_change", rationale: "Already reconciled.", evidenceIds: ["evidence-1"] },
      },
    },
    finalVerification: { current, history: [invalidated] },
  };
  const runtime = {
    ...fakeRuntime("run_1"),
    projection: () => projection,
    completeManagedUserGuidanceInterruption: () => {
      projection.userGuidance["guidance-adopt"].interruptionStatus = "completed";
      return projection;
    },
  } as unknown as BuildRuntime;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: async () => ({
        ...handleProjections("run_1"), runtime,
        usage: () => emptyBudget("run_1"), observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => ({ integrationRevision: "r", integrationBranch: "b", appliedToProject: false }),
        retireInvalidatedFinalVerification: async (generation, preservedCurrent) => {
          assert.equal(generation.generationId, invalidated.generationId);
          assert.equal(preservedCurrent?.generationId, current.generationId);
          // The production callback adopts shared current-generation resources.
          workspaceExists = true;
        },
        finalVerificationCleanup: { quiesceRun: async () => undefined, cleanup: async () => ({}) },
        cleanup: async () => undefined, close: async () => undefined,
      }),
    });
    await manager.create(spec);
    await manager.recover();
    assert.equal(workspaceExists, true);
    assert.equal(projection.finalVerification?.current?.generationId, "generation-newer");
    assert.equal(projection.userGuidance["guidance-adopt"].interruptionStatus, "completed");
  } finally {
    await manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("steering that lands during an active pump schedules a post-checkpoint wake", { timeout: 2_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-steering-active-wake-"));
  let manager: NativeBuildManager | undefined;
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  let markSecondStarted!: () => void;
  const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  let pumpCalls = 0;
  let guidanceAppended = false;
  try {
    const projection = fakeRuntime("run_1").projection();
    const runtime = {
      ...fakeRuntime("run_1"),
      projection: () => projection,
      submitUserGuidance: () => {
        guidanceAppended = true;
        return projection;
      },
      runUntilBlocked: async () => {
        pumpCalls += 1;
        if (pumpCalls === 1) {
          markFirstStarted();
          await firstRelease;
        } else {
          assert.equal(guidanceAppended, true);
          markSecondStarted();
        }
        return { status: "blocked" as const, action: "architect_question_pending" };
      },
    } as unknown as BuildRuntime;
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: async () => ({
        ...handleProjections("run_1"), runtime,
        usage: () => emptyBudget("run_1"), observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => ({ integrationRevision: "r", integrationBranch: "b", appliedToProject: false }),
        cleanup: async () => undefined, close: async () => undefined,
      }),
    });
    await manager.create(spec);
    manager.activate("run_1");
    await firstStarted;
    await manager.submitUserGuidance("run_1", {
      guidanceId: "guidance-active",
      text: "Apply this after the active checkpoint.",
      version: 1,
      idempotencyKey: "guidance:active",
    });
    assert.equal(guidanceAppended, true);
    assert.equal(pumpCalls, 1);
    releaseFirst();
    await secondStarted;
    await manager.awaitIdle("run_1");
    assert.equal(pumpCalls, 2);
  } finally {
    releaseFirst?.();
    await manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("native Build manager recreates persisted runtimes and closes resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-"));
  const database = join(root, "builds.sqlite");
  const created: string[] = [];
  const closed: string[] = [];
  try {
    let specs = new SqliteBuildSpecStore(database);
    specs.save(spec);
    specs.close();

    specs = new SqliteBuildSpecStore(database);
    const manager = new NativeBuildManager({
      specs,
      createRuntime: async (input) => {
        created.push(input.runId);
        return {
          ...handleProjections(input.runId),
          runtime: fakeRuntime(input.runId),
          usage: () => emptyBudget(input.runId),
          observability: async () => emptyObservability(input.runId),
          projectHandoff: async () => ({
            integrationRevision: "revision_final",
            integrationBranch: "aiboard/run/integration",
            appliedToProject: false,
          }),
          cleanup: () => undefined,
          close: () => {
            closed.push(input.runId);
          },
        };
      },
    });
    await manager.recover();
    assert.deepEqual(created, ["run_1"]);
    assert.equal(manager.projection("run_1").runId, "run_1");

    await manager.create(spec);
    assert.deepEqual(created, ["run_1"]);
    await manager.close();
    assert.deepEqual(closed, ["run_1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native Build manager owns one autonomous pump per active run", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-pump-"));
  const results: string[] = [];
  let pumpCalls = 0;
  try {
    const manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      onPumpResult: (runId, result) => results.push(`${runId}:${result.status}`),
      createRuntime: async (input) => ({
        ...handleProjections(input.runId),
        runtime: {
          ...fakeRuntime(input.runId),
          runUntilBlocked: async () => {
            pumpCalls += 1;
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { status: "completed" as const };
          },
        } as BuildRuntime,
        usage: () => emptyBudget(input.runId),
        observability: async () => emptyObservability(input.runId),
        projectHandoff: async () => ({
          integrationRevision: "revision_final",
          integrationBranch: "aiboard/run/integration",
          appliedToProject: false,
        }),
        cleanup: () => undefined,
        close: () => undefined,
      }),
    });
    await manager.create(spec);
    manager.activate("run_1");
    manager.activate("run_1");
    await manager.awaitIdle("run_1");
    assert.equal(pumpCalls, 1);
    assert.deepEqual(results, ["run_1:completed"]);
    await manager.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery autonomously restarts only runs the supervisor still marks active", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-recover-pump-"));
  const pumped: string[] = [];
  try {
    const specs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
    specs.save(spec);
    specs.save({ ...spec, runId: "run_paused", idempotencyKey: "build-spec:paused" });
    const manager = new NativeBuildManager({
      specs,
      shouldAutoRun: (runId) => runId === "run_1",
      createRuntime: async (input) => ({
        ...handleProjections(input.runId),
        runtime: {
          ...fakeRuntime(input.runId),
          runUntilBlocked: async () => {
            pumped.push(input.runId);
            return { status: "paused" as const };
          },
        } as BuildRuntime,
        usage: () => emptyBudget(input.runId),
        observability: async () => emptyObservability(input.runId),
        projectHandoff: async () => ({
          integrationRevision: "revision_final",
          integrationBranch: "aiboard/run/integration",
          appliedToProject: false,
        }),
        cleanup: () => undefined,
        close: () => undefined,
      }),
    });
    await manager.recover();
    await manager.awaitIdle();
    assert.deepEqual(pumped, ["run_1"]);
    await manager.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("completed project handoff replays without applying the project twice", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-handoff-replay-"));
  let handoffCalls = 0;
  const selectionActors: unknown[] = [];
  let manager: NativeBuildManager | undefined;
  let projection: SchedulerProjection = requestedHandoffProjection("budgeted");
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: async () => ({
        ...handleProjections("run_1"),
        runtime: {
          ...fakeRuntime("run_1"),
          projection: () => projection,
          selectProjectHandoff: (
            choice: "keep_integration_branch" | "apply_to_project",
            _result: unknown,
            _idempotencyKey: string,
            actor: unknown
          ) => {
            selectionActors.push(actor);
            projection = {
              ...projection,
              status: "completed",
              projectHandoff: {
                status: "selected",
                summary: "Ready",
                options: ["keep_integration_branch", "apply_to_project"],
                choice,
                integrationRevision: "revision_final",
                integrationBranch: "aiboard/run/integration",
                appliedToProject: choice === "apply_to_project",
              },
            };
            return projection;
          },
        } as unknown as BuildRuntime,
        usage: () => emptyBudget("run_1"),
        observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => {
          handoffCalls += 1;
          return {
            integrationRevision: "revision_final",
            integrationBranch: "aiboard/run/integration",
            appliedToProject: true,
          };
        },
        cleanup: () => undefined,
        close: () => undefined,
      }),
    });
    await manager.create(spec);
    const [selected, replay] = await Promise.all([
      manager.selectProjectHandoff("run_1", "apply_to_project", "handoff:apply"),
      manager.selectProjectHandoff("run_1", "apply_to_project", "handoff:apply"),
    ]);
    assert.equal(selected.status, "completed");
    assert.equal(replay.status, "completed");
    assert.equal(handoffCalls, 1);
    assert.deepEqual(selectionActors, [{ role: "user", id: "local-user" }]);
  } finally {
    await manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("guidance and project handoff are linearized before external project mutation", { timeout: 2_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-handoff-steering-race-"));
  let manager: NativeBuildManager | undefined;
  let projection = requestedHandoffProjection("budgeted");
  let handoffStarted!: () => void;
  let releaseHandoff!: () => void;
  const started = new Promise<void>((resolve) => { handoffStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseHandoff = resolve; });
  const calls: string[] = [];
  try {
    const runtime = {
      ...fakeRuntime("run_1"),
      projection: () => projection,
      submitUserGuidance: () => {
        if (projection.status === "completed") throw new Error("A completed Build cannot receive in-flight user guidance.");
        calls.push("guidance-appended");
        projection = { ...projection, status: "running", projectHandoff: undefined };
        return projection;
      },
      selectProjectHandoff: (choice: "keep_integration_branch" | "apply_to_project") => {
        calls.push("handoff-recorded");
        projection = {
          ...projection,
          status: "completed",
          projectHandoff: { ...projection.projectHandoff!, status: "selected", choice },
        };
        return projection;
      },
    } as unknown as BuildRuntime;
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: async () => ({
        ...handleProjections("run_1"), runtime,
        usage: () => emptyBudget("run_1"), observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => {
          calls.push("handoff-started");
          handoffStarted();
          await release;
          calls.push("project-mutated");
          return { integrationRevision: "revision_final", integrationBranch: "aiboard/run/integration", appliedToProject: true };
        },
        cleanup: () => undefined, close: () => undefined,
      }),
    });
    await manager.create(spec);
    const handoff = manager.selectProjectHandoff("run_1", "apply_to_project", "handoff:apply");
    await started;
    const guidance = manager.submitUserGuidance("run_1", {
      guidanceId: "guidance-race", text: "Change the result before handoff.", version: 1,
      idempotencyKey: "guidance:handoff-race",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, ["handoff-started"]);
    releaseHandoff();
    await handoff;
    await assert.rejects(guidance, /completed Build/i);
    assert.deepEqual(calls, ["handoff-started", "project-mutated", "handoff-recorded"]);
    assert.equal(projection.projectHandoff?.status, "selected");
  } finally {
    releaseHandoff?.();
    await manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("guidance that wins handoff serialization prevents external project mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-guidance-wins-handoff-"));
  let manager: NativeBuildManager | undefined;
  let projection = requestedHandoffProjection("budgeted");
  let handoffCalls = 0;
  try {
    const runtime = {
      ...fakeRuntime("run_1"),
      projection: () => projection,
      submitUserGuidance: () => {
        projection = { ...projection, status: "running", projectHandoff: undefined };
        return projection;
      },
    } as unknown as BuildRuntime;
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: async () => ({
        ...handleProjections("run_1"), runtime,
        usage: () => emptyBudget("run_1"), observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => {
          handoffCalls += 1;
          return { integrationRevision: "revision_final", integrationBranch: "aiboard/run/integration", appliedToProject: true };
        },
        cleanup: () => undefined, close: () => undefined,
      }),
    });
    await manager.create(spec);
    const guidance = manager.submitUserGuidance("run_1", {
      guidanceId: "guidance-wins", text: "Change this before handoff.", version: 1,
      idempotencyKey: "guidance:wins-handoff",
    });
    const handoff = manager.selectProjectHandoff("run_1", "apply_to_project", "handoff:stale");
    await guidance;
    await assert.rejects(handoff, /not awaiting user selection/i);
    assert.equal(handoffCalls, 0);
    assert.equal(projection.status, "running");
    assert.equal(projection.projectHandoff, undefined);
  } finally {
    await manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a brand-new native Build starts with no recovered provider cooldowns", () => {
  assert.deepEqual(providerHealthFromSchedulerEvents([]), []);
});

test("worker routing excludes Architect-only runtimes from the worker pool", () => {
  const configs: RunnerProviderConfig[] = [
    {
      runtimeId: "chatgpt:gpt-5.5",
      providerId: "chatgpt",
      modelId: "gpt-5.5",
      transport: "account-runner",
      secret: "architect-secret",
      capabilities: ["*"],
      priority: 0,
    },
    {
      runtimeId: "chatgpt:gpt-5.4",
      providerId: "chatgpt",
      modelId: "gpt-5.4",
      transport: "account-runner",
      secret: "worker-secret",
      capabilities: ["*"],
      priority: 1,
    },
    {
      runtimeId: "google:gemini-2.5-pro",
      providerId: "google",
      modelId: "gemini-2.5-pro",
      transport: "google",
      secret: "verifier-secret",
      capabilities: ["*"],
      priority: 2,
    },
  ];
  const selected = selectRuntimeCandidates(configs, {
    ...spec,
    verifierRuntimeIds: ["google:gemini-2.5-pro"],
  });
  assert.deepEqual(
    selected.all.map((candidate) => candidate.runtimeId),
    ["chatgpt:gpt-5.5", "chatgpt:gpt-5.4", "google:gemini-2.5-pro"]
  );
  assert.deepEqual(
    selected.workers.map((candidate) => candidate.runtimeId),
    ["chatgpt:gpt-5.4"]
  );
  assert.deepEqual(
    selected.verifiers.map((candidate) => candidate.runtimeId),
    ["google:gemini-2.5-pro"]
  );
});

test("autonomous pump continues after bounded progress without user Resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-yield-"));
  let pumpCalls = 0;
  let projection = fakeRuntime("run_1").projection();
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: async (input) => ({
        ...handleProjections(input.runId),
        runtime: {
          ...fakeRuntime(input.runId),
          projection: () => projection,
          runUntilBlocked: async () => {
            pumpCalls += 1;
            if (pumpCalls === 1) {
              return { status: "progressed" as const, action: "step_allowance_yielded" };
            }
            projection = { ...projection, status: "completed" };
            return { status: "completed" as const };
          },
        } as BuildRuntime,
        usage: () => emptyBudget(input.runId),
        observability: async () => emptyObservability(input.runId),
        projectHandoff: async () => ({
          integrationRevision: "revision_final",
          integrationBranch: "aiboard/run/integration",
          appliedToProject: false,
        }),
        cleanup: () => undefined,
        close: () => undefined,
      }),
    });
    await manager.create(spec);
    manager.activate("run_1");
    await manager.awaitIdle("run_1");
    assert.equal(pumpCalls, 2);
  } finally {
    await manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("requested Finish or Budgeted handoff auto-applies once and cleans up after settlement", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-auto-handoff-"));
  let handoffCalls = 0;
  let cleanupCalls = 0;
  const results: string[] = [];
  const selectionActors: unknown[] = [];
  let projection: SchedulerProjection = fakeRuntime("run_1").projection();
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      onPumpResult: (_runId, result) => results.push(result.status),
      createRuntime: async () => ({
        ...handleProjections("run_1"),
        runtime: {
          ...fakeRuntime("run_1"),
          projection: () => projection,
          runUntilBlocked: async () => {
            projection = requestedHandoffProjection("budgeted");
            return { status: "paused" as const, action: "completion_decision_required" };
          },
          selectProjectHandoff: (
            choice: "keep_integration_branch" | "apply_to_project",
            _result: unknown,
            _idempotencyKey: string,
            actor: unknown
          ) => {
            selectionActors.push(actor);
            projection = selectedHandoffProjection(projection, choice);
            return projection;
          },
        } as unknown as BuildRuntime,
        usage: () => emptyBudget("run_1"),
        observability: async () => emptyObservability("run_1"),
        projectHandoff: async (choice) => {
          handoffCalls += 1;
          assert.equal(choice, "apply_to_project");
          return {
            integrationRevision: "revision_final",
            integrationBranch: "aiboard/run/integration",
            appliedToProject: true,
            projectRevision: "project_revision",
          };
        },
        cleanup: async () => {
          cleanupCalls += 1;
        },
        close: () => undefined,
      }),
    });
    await manager.create(spec);
    manager.activate("run_1");
    manager.activate("run_1");
    await manager.awaitIdle("run_1");
    manager.activate("run_1");
    await manager.awaitIdle("run_1");

    assert.equal(handoffCalls, 1);
    assert.equal(cleanupCalls, 1);
    assert.deepEqual(selectionActors, [
      { role: "runner", id: "native-build-manager" },
    ]);
    assert.deepEqual(results, ["completed"]);
    assert.equal(manager.projection("run_1").status, "completed");
    assert.equal(
      manager.projection("run_1").projectHandoff?.choice,
      "apply_to_project"
    );
  } finally {
    await manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Plan-only requested handoff remains paused for the user", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-plan-handoff-"));
  let handoffCalls = 0;
  let cleanupCalls = 0;
  const results: string[] = [];
  let projection: SchedulerProjection = fakeRuntime("run_1").projection();
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      onPumpResult: (_runId, result) => results.push(result.status),
      createRuntime: async () => ({
        ...handleProjections("run_1"),
        runtime: {
          ...fakeRuntime("run_1"),
          projection: () => projection,
          runUntilBlocked: async () => {
            projection = requestedHandoffProjection("plan_only");
            return { status: "paused" as const, action: "completion_decision_required" };
          },
        } as unknown as BuildRuntime,
        usage: () => emptyBudget("run_1"),
        observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => {
          handoffCalls += 1;
          throw new Error("must not auto-apply");
        },
        cleanup: async () => {
          cleanupCalls += 1;
        },
        close: () => undefined,
      }),
    });
    await manager.create({
      ...spec,
      runPolicy: "plan_only",
      budgetLimits: {},
    });
    manager.activate("run_1");
    await manager.awaitIdle("run_1");

    assert.equal(handoffCalls, 0);
    assert.equal(cleanupCalls, 0);
    assert.deepEqual(results, ["paused"]);
    assert.equal(manager.projection("run_1").projectHandoff?.status, "requested");
  } finally {
    await manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a requested handoff without a durable policy is not auto-applied", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-missing-policy-"));
  let handoffCalls = 0;
  const results: string[] = [];
  let projection: SchedulerProjection = fakeRuntime("run_1").projection();
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      onPumpResult: (_runId, result) => results.push(result.status),
      createRuntime: async () => ({
        ...handleProjections("run_1"),
        runtime: {
          ...fakeRuntime("run_1"),
          projection: () => projection,
          runUntilBlocked: async () => {
            projection = requestedHandoffProjection(undefined);
            return { status: "paused" as const, action: "completion_decision_required" };
          },
        } as unknown as BuildRuntime,
        usage: () => emptyBudget("run_1"),
        observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => {
          handoffCalls += 1;
          throw new Error("must not auto-apply");
        },
        cleanup: () => undefined,
        close: () => undefined,
      }),
    });
    await manager.create(spec);
    manager.activate("run_1");
    await manager.awaitIdle("run_1");

    assert.equal(handoffCalls, 0);
    assert.deepEqual(results, ["paused"]);
    assert.equal(manager.projection("run_1").projectHandoff?.status, "requested");
  } finally {
    await manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatic apply failure leaves requested handoff paused without cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-failed-handoff-"));
  let cleanupCalls = 0;
  const results: string[] = [];
  const errors: unknown[] = [];
  let projection: SchedulerProjection = fakeRuntime("run_1").projection();
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      onPumpResult: (_runId, result) =>
        results.push(`${result.status}:${result.action}`),
      onPumpError: (_runId, error) => errors.push(error),
      createRuntime: async () => ({
        ...handleProjections("run_1"),
        runtime: {
          ...fakeRuntime("run_1"),
          projection: () => projection,
          runUntilBlocked: async () => {
            projection = requestedHandoffProjection("finish");
            return { status: "paused" as const, action: "completion_decision_required" };
          },
        } as unknown as BuildRuntime,
        usage: () => emptyBudget("run_1"),
        observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => {
          throw new Error("project is dirty");
        },
        cleanup: async () => {
          cleanupCalls += 1;
        },
        close: () => undefined,
      }),
    });
    await manager.create({ ...spec, runPolicy: "finish", budgetLimits: {} });
    manager.activate("run_1");
    await manager.awaitIdle("run_1");

    assert.equal(errors.length, 1);
    assert.deepEqual(results, ["paused:automatic_project_handoff_failed"]);
    assert.equal(cleanupCalls, 0);
    assert.equal(manager.projection("run_1").status, "paused");
    assert.equal(manager.projection("run_1").projectHandoff?.status, "requested");
  } finally {
    await manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup failure does not reclassify an already settled handoff as paused", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-cleanup-failure-"));
  const results: string[] = [];
  const errors: unknown[] = [];
  let cleanupCalls = 0;
  let projection: SchedulerProjection = fakeRuntime("run_1").projection();
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      onPumpResult: (_runId, result) => results.push(result.status),
      onPumpError: (_runId, error) => errors.push(error),
      createRuntime: async () => ({
        ...handleProjections("run_1"),
        runtime: {
          ...fakeRuntime("run_1"),
          projection: () => projection,
          runUntilBlocked: async () => {
            projection = requestedHandoffProjection("finish");
            return { status: "paused" as const, action: "completion_decision_required" };
          },
          selectProjectHandoff: (choice: "keep_integration_branch" | "apply_to_project") => {
            projection = selectedHandoffProjection(projection, choice);
            return projection;
          },
        } as unknown as BuildRuntime,
        usage: () => emptyBudget("run_1"),
        observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => ({
          integrationRevision: "revision_final",
          integrationBranch: "aiboard/run/integration",
          appliedToProject: true,
          projectRevision: "project_revision",
        }),
        cleanup: async () => {
          cleanupCalls += 1;
          if (cleanupCalls === 1) throw new Error("cleanup failed");
        },
        close: () => undefined,
      }),
    });
    await manager.create({ ...spec, runPolicy: "finish", budgetLimits: {} });
    manager.activate("run_1");
    await manager.awaitIdle("run_1");

    assert.equal(errors.length, 1);
    assert.deepEqual(results, ["completed"]);
    assert.equal(manager.projection("run_1").status, "completed");
  } finally {
    await manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery retries cleanup for a durably settled Build", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-recover-cleanup-"));
  let cleanupCalls = 0;
  const results: string[] = [];
  const specs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
  specs.save(spec);
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs,
      shouldAutoRun: () => true,
      onPumpResult: (_runId, result) => results.push(result.status),
      createRuntime: async () => ({
        ...handleProjections("run_1"),
        runtime: {
          ...fakeRuntime("run_1"),
          projection: () => selectedHandoffProjection(
            requestedHandoffProjection("budgeted"),
            "apply_to_project"
          ),
          runUntilBlocked: async () => ({ status: "completed" as const }),
        } as unknown as BuildRuntime,
        usage: () => emptyBudget("run_1"),
        observability: async () => emptyObservability("run_1"),
        projectHandoff: async () => {
          throw new Error("already settled");
        },
        cleanup: async () => {
          cleanupCalls += 1;
        },
        close: () => undefined,
      }),
    });
    await manager.recover();
    assert.equal(cleanupCalls, 1);
    assert.deepEqual(results, ["completed"]);
  } finally {
    await manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery compacts every non-running Build, skips active Builds, and continues after one compaction error", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-recover-compact-"));
  const specs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
  for (const runId of ["run_paused", "run_completed", "run_active"]) {
    specs.save({ ...spec, runId, idempotencyKey: `build:${runId}` });
  }
  const compacted: string[] = [];
  const errors: Array<{ runId: string; message: string }> = [];
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs,
      shouldAutoRun: (runId) => runId === "run_active",
      onPumpError: (runId, error) => errors.push({
        runId,
        message: error instanceof Error ? error.message : String(error),
      }),
      createRuntime: async (buildSpec) => ({
        ...handleProjections(buildSpec.runId),
        runtime: {
          ...fakeRuntime(buildSpec.runId),
          projection: () => ({
            ...fakeRuntime(buildSpec.runId).projection(),
            status: buildSpec.runId === "run_completed"
              ? "completed"
              : buildSpec.runId === "run_active"
                ? "running"
                : "paused",
          }),
          runUntilBlocked: async () => ({ status: "paused" as const }),
        } as unknown as BuildRuntime,
        usage: () => emptyBudget(buildSpec.runId),
        observability: async () => emptyObservability(buildSpec.runId),
        transcript: async () => ({ turns: [], cursor: 0 }),
        files: async () => ({
          source: "integration" as const,
          revision: "a".repeat(40),
          appliedToProject: false,
          omittedFileCount: 0,
          files: [],
        }),
        compact: async () => {
          compacted.push(buildSpec.runId);
          if (buildSpec.runId === "run_paused") throw new Error("compact failed");
        },
        projectHandoff: async () => {
          throw new Error("not awaiting handoff");
        },
        cleanup: () => undefined,
        close: () => undefined,
      }),
    });
    await manager.recover();
    await manager.awaitIdle();

    assert.deepEqual(compacted.sort(), ["run_completed", "run_paused"]);
    assert.deepEqual(errors, [{ runId: "run_paused", message: "compact failed" }]);
  } finally {
    await manager?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery reports a global reachability scan failure and still activates recoverable work", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-recover-scan-error-"));
  const specs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
  specs.save({ ...spec, idempotencyKey: "build:scan-error" });
  const errors: Array<{ runId: string; message: string }> = [];
  let pumpCalls = 0;
  const manager = new NativeBuildManager({
    specs,
    shouldAutoRun: () => true,
    onPumpError: (runId, error) => errors.push({
      runId,
      message: error instanceof Error ? error.message : String(error),
    }),
    runArtifactCompaction: async (operation) => await operation(),
    prepareArtifactCleanup: async () => {
      throw new Error("reachability scan failed");
    },
    createRuntime: async () => ({
      ...handleProjections("run_1"),
      runtime: {
        ...fakeRuntime("run_1"),
        runUntilBlocked: async () => {
          pumpCalls += 1;
          return { status: "paused" as const };
        },
      } as unknown as BuildRuntime,
      usage: () => emptyBudget("run_1"),
      observability: async () => emptyObservability("run_1"),
      transcript: async () => ({ turns: [], cursor: 0 }),
      files: async () => ({
        source: "integration" as const,
        revision: "a".repeat(40),
        appliedToProject: false,
        omittedFileCount: 0,
        files: [],
      }),
      compact: () => undefined,
      projectHandoff: async () => { throw new Error("not awaiting handoff"); },
      cleanup: () => undefined,
      close: () => undefined,
    }),
  });
  try {
    await manager.recover();
    await manager.awaitIdle();
    assert.equal(pumpCalls, 1);
    assert.deepEqual(errors, [{
      runId: "startup-artifact-reachability",
      message: "reachability scan failed",
    }]);
  } finally {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("settlement requests live compaction after releasing its own activity lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-live-gc-self-lease-"));
  let projection: SchedulerProjection = fakeRuntime("run_1").projection();
  let scans = 0;
  const manager = new NativeBuildManager({
    specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
    runArtifactCompaction: async (operation) => await operation(),
    prepareArtifactCleanup: async () => { scans += 1; },
    createRuntime: async () => ({
      ...handleProjections("run_1"),
      runtime: {
        ...fakeRuntime("run_1"),
        projection: () => projection,
        runUntilBlocked: async () => {
          projection = { ...projection, status: "completed" };
          return { status: "completed" as const };
        },
      } as unknown as BuildRuntime,
      usage: () => emptyBudget("run_1"),
      observability: async () => emptyObservability("run_1"),
      projectHandoff: async () => { throw new Error("not awaiting handoff"); },
      cleanup: () => undefined,
      close: () => undefined,
    }),
  });
  try {
    await manager.create(spec);
    manager.activate("run_1");
    await Promise.race([
      manager.awaitIdle("run_1"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("settlement deadlocked")), 500)),
    ]);
    assert.equal(scans, 1);
  } finally {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("public step auto-applies Finish handoff and finalizes cleanup once", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-manual-step-finalize-"));
  let projection: SchedulerProjection = fakeRuntime("run_1").projection();
  let handoffCalls = 0;
  let cleanupCalls = 0;
  let scans = 0;
  const manager = new NativeBuildManager({
    specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
    runArtifactCompaction: async (operation) => await operation(),
    prepareArtifactCleanup: async () => { scans += 1; },
    createRuntime: async () => ({
      ...handleProjections("run_1"),
      runtime: {
        ...fakeRuntime("run_1"),
        projection: () => projection,
        step: async () => {
          if (projection.projectHandoff?.status === "selected") {
            return { status: "completed" as const, action: "already_completed" };
          }
          projection = requestedHandoffProjection("finish");
          return { status: "paused" as const, action: "completion_decision_required" };
        },
        selectProjectHandoff: (choice: "keep_integration_branch" | "apply_to_project") => {
          projection = selectedHandoffProjection(projection, choice);
          return projection;
        },
      } as unknown as BuildRuntime,
      usage: () => emptyBudget("run_1"),
      observability: async () => emptyObservability("run_1"),
      projectHandoff: async () => {
        handoffCalls += 1;
        return {
          integrationRevision: "revision_final",
          integrationBranch: "aiboard/run/integration",
          appliedToProject: true,
          projectRevision: "project_revision",
        };
      },
      cleanup: () => { cleanupCalls += 1; },
      close: () => undefined,
    }),
  });
  try {
    await manager.create({ ...spec, runPolicy: "finish", budgetLimits: {} });
    const result = await manager.step("run_1");
    assert.deepEqual(result, {
      status: "completed",
      action: "automatic_project_handoff_applied",
    });
    assert.equal(handoffCalls, 1);
    assert.equal(cleanupCalls, 1);
    assert.equal(scans, 1);

    await manager.step("run_1");
    assert.equal(handoffCalls, 1);
    assert.equal(cleanupCalls, 1);
    assert.equal(scans, 1);
  } finally {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("public runUntilBlocked performs live physical cleanup after completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-manual-run-gc-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const guard = new ArtifactReachabilityGuard(root, artifacts);
  const sessions = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts, {
    deleteArtifactIfGloballyUnreachable: (hash) => guard.removeIfGloballyUnreachable(hash),
  });
  let manager: NativeBuildManager | undefined;
  try {
    const obsolete = await checkpointTwice(sessions, "run_1");
    let projection = fakeRuntime("run_1").projection();
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      runArtifactCompaction: (operation) => guard.runQuiescent(operation),
      prepareArtifactCleanup: () => guard.prepareReachabilityIndex(),
      createRuntime: async () => ({
        ...handleProjections("run_1"),
        runtime: {
          ...fakeRuntime("run_1"),
          projection: () => projection,
          runUntilBlocked: async () => {
            projection = { ...projection, status: "completed" };
            return { status: "completed" as const, action: "architect_completed" };
          },
        } as unknown as BuildRuntime,
        usage: () => emptyBudget("run_1"),
        observability: async () => emptyObservability("run_1"),
        compact: () => sessions.compactRun("run_1"),
        projectHandoff: async () => { throw new Error("not awaiting handoff"); },
        cleanup: () => sessions.compactRun("run_1"),
        close: () => undefined,
      }),
    });
    await manager.create(spec);
    const result = await manager.runUntilBlocked("run_1");
    assert.deepEqual(result, { status: "completed", action: "architect_completed" });
    await assert.rejects(artifacts.verify(obsolete), /not found/i);
    assert.equal(guard.scanCount, 1);
  } finally {
    await manager?.close();
    sessions.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("public step leaves Plan-only handoff requested without mutation or cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-manual-plan-only-"));
  let projection: SchedulerProjection = fakeRuntime("run_1").projection();
  let handoffCalls = 0;
  let cleanupCalls = 0;
  const manager = new NativeBuildManager({
    specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
    createRuntime: async () => ({
      ...handleProjections("run_1"),
      runtime: {
        ...fakeRuntime("run_1"),
        projection: () => projection,
        step: async () => {
          projection = requestedHandoffProjection("plan_only");
          return { status: "paused" as const, action: "plan_handoff_required" };
        },
      } as unknown as BuildRuntime,
      usage: () => emptyBudget("run_1"),
      observability: async () => emptyObservability("run_1"),
      projectHandoff: async () => {
        handoffCalls += 1;
        throw new Error("must remain explicit");
      },
      cleanup: () => { cleanupCalls += 1; },
      close: () => undefined,
    }),
  });
  try {
    await manager.create({ ...spec, runPolicy: "plan_only", budgetLimits: {} });
    const result = await manager.step("run_1");
    assert.deepEqual(result, { status: "paused", action: "plan_handoff_required" });
    assert.equal(handoffCalls, 0);
    assert.equal(cleanupCalls, 0);
    assert.equal(manager.projection("run_1").projectHandoff?.status, "requested");
  } finally {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lifecycle mutations wait during live compaction and pass two recomputes eligibility", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-live-gc-resume-race-"));
  let firstCompactStarted!: () => void;
  const firstCompact = new Promise<void>((resolve) => { firstCompactStarted = resolve; });
  let releaseFirstCompact!: () => void;
  const firstCompactRelease = new Promise<void>((resolve) => { releaseFirstCompact = resolve; });
  const projections = new Map<string, SchedulerProjection>();
  let pausedCompactCalls = 0;
  let resumeCalls = 0;
  let pauseCalls = 0;
  let architectHandoffCalls = 0;
  let verifierSelectionCalls = 0;
  const manager = new NativeBuildManager({
    specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
    runArtifactCompaction: async (operation) => await operation(),
    prepareArtifactCleanup: async () => undefined,
    createRuntime: async (input) => {
      let projection: SchedulerProjection = {
        ...fakeRuntime(input.runId).projection(),
        status: input.runId === "run_paused" ? "paused" : "running",
      };
      projections.set(input.runId, projection);
      return {
        ...handleProjections(input.runId),
        runtime: {
          ...fakeRuntime(input.runId),
          projection: () => projections.get(input.runId)!,
          resume: () => {
            resumeCalls += 1;
            projection = { ...projection, status: "running" };
            projections.set(input.runId, projection);
            return projection;
          },
          pause: () => {
            pauseCalls += 1;
            projection = { ...projection, status: "paused" };
            projections.set(input.runId, projection);
            return projection;
          },
          selectArchitectHandoff: () => {
            architectHandoffCalls += 1;
            return projection;
          },
          selectVerifierRuntime: () => {
            verifierSelectionCalls += 1;
            return projection;
          },
          runUntilBlocked: async () => {
            projection = { ...projection, status: "completed" };
            projections.set(input.runId, projection);
            return { status: "completed" as const };
          },
        } as unknown as BuildRuntime,
        usage: () => emptyBudget(input.runId),
        observability: async () => emptyObservability(input.runId),
        compact: async () => {
          if (input.runId !== "run_paused") return;
          pausedCompactCalls += 1;
          if (pausedCompactCalls === 1) {
            firstCompactStarted();
            await firstCompactRelease;
            projection = { ...projection, status: "running" };
            projections.set(input.runId, projection);
          }
        },
        projectHandoff: async () => { throw new Error("not awaiting handoff"); },
        cleanup: () => undefined,
        close: () => undefined,
      };
    },
  });
  try {
    await manager.create({ ...spec, runId: "run_paused", idempotencyKey: "paused" });
    await manager.create({ ...spec, runId: "run_settled", idempotencyKey: "settled" });
    manager.activate("run_settled");
    await firstCompact;
    const resuming = manager.resume("run_paused", "resume-during-gc");
    const pausing = manager.pause("run_paused", "pause-during-gc", "pause-during-gc");
    const selecting = manager.selectArchitectHandoff(
      "run_paused",
      "chatgpt:gpt-5.4",
      "handoff-during-gc"
    );
    const selectingVerifier = manager.selectVerifierRuntime(
      "run_paused",
      "fallback:verifier",
      "verifier-during-gc",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resumeCalls, 0);
    assert.equal(pauseCalls, 0);
    assert.equal(architectHandoffCalls, 0);
    assert.equal(verifierSelectionCalls, 0);
    releaseFirstCompact();
    await manager.awaitIdle("run_settled");
    await Promise.all([resuming, pausing, selecting, selectingVerifier]);
    assert.equal(resumeCalls, 1);
    assert.equal(pauseCalls, 1);
    assert.equal(architectHandoffCalls, 1);
    assert.equal(verifierSelectionCalls, 1);
    assert.equal(pausedCompactCalls, 1);
  } finally {
    releaseFirstCompact();
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live compaction waits for active work, blocks new work, and scans once", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-live-gc-gate-"));
  const specs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
  let releaseWriter!: () => void;
  const writerRelease = new Promise<void>((resolve) => { releaseWriter = resolve; });
  let writerStarted!: () => void;
  const writerStart = new Promise<void>((resolve) => { writerStarted = resolve; });
  let cleanupDone!: () => void;
  const cleanup = new Promise<void>((resolve) => { cleanupDone = resolve; });
  let releaseScan!: () => void;
  const scanRelease = new Promise<void>((resolve) => { releaseScan = resolve; });
  let scanStarted!: () => void;
  const scanStart = new Promise<void>((resolve) => { scanStarted = resolve; });
  let scans = 0;
  let waiterCalls = 0;
  const projections = new Map<string, SchedulerProjection>();
  const manager = new NativeBuildManager({
    specs,
    runArtifactCompaction: async (operation) => await operation(),
    prepareArtifactCleanup: async () => {
      scans += 1;
      scanStarted();
      await scanRelease;
    },
    createRuntime: async (input) => {
      let projection = fakeRuntime(input.runId).projection();
      projections.set(input.runId, projection);
      return {
        ...handleProjections(input.runId),
        runtime: {
          ...fakeRuntime(input.runId),
          projection: () => projections.get(input.runId)!,
          step: async () => {
            waiterCalls += 1;
            return { status: "progressed" as const };
          },
          runUntilBlocked: async () => {
            if (input.runId === "run_writer") {
              writerStarted();
              await writerRelease;
              return { status: "paused" as const };
            }
            projection = { ...projection, status: "completed" };
            projections.set(input.runId, projection);
            return { status: "completed" as const };
          },
        } as unknown as BuildRuntime,
        usage: () => emptyBudget(input.runId),
        observability: async () => emptyObservability(input.runId),
        projectHandoff: async () => { throw new Error("not awaiting handoff"); },
        cleanup: () => { if (input.runId === "run_settled") cleanupDone(); },
        close: () => undefined,
      };
    },
  });
  try {
    await manager.create({ ...spec, runId: "run_writer", idempotencyKey: "writer" });
    await manager.create({ ...spec, runId: "run_settled", idempotencyKey: "settled" });
    const activeWriter = manager.runUntilBlocked("run_writer");
    await writerStart;
    manager.activate("run_settled");
    await cleanup;
    const waitingStep = manager.step("run_writer");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(waiterCalls, 0);
    releaseWriter();
    await scanStart;
    assert.equal(waiterCalls, 0);
    assert.equal(scans, 1);
    releaseScan();
    await Promise.all([activeWriter, waitingStep, manager.awaitIdle("run_settled")]);
    assert.equal(waiterCalls, 1);
  } finally {
    releaseWriter();
    releaseScan();
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live settlement physically deletes obsolete checkpoints without touching active-run artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-live-gc-delete-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const guard = new ArtifactReachabilityGuard(root, artifacts);
  const sessions = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts, {
    deleteArtifactIfGloballyUnreachable: (hash) => guard.removeIfGloballyUnreachable(hash),
  });
  let manager: NativeBuildManager | undefined;
  try {
    const settledOld = await checkpointTwice(sessions, "run_settled");
    const activeOld = await checkpointTwice(sessions, "run_active");
    const projections = new Map<string, SchedulerProjection>();
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      runArtifactCompaction: (operation) => guard.runQuiescent(operation),
      prepareArtifactCleanup: () => guard.prepareReachabilityIndex(),
      createRuntime: async (input) => {
        let projection = fakeRuntime(input.runId).projection();
        projections.set(input.runId, projection);
        return {
          ...handleProjections(input.runId),
          runtime: {
            ...fakeRuntime(input.runId),
            projection: () => projections.get(input.runId)!,
            runUntilBlocked: async () => {
              if (input.runId === "run_settled") {
                projection = { ...projection, status: "completed" };
                projections.set(input.runId, projection);
                return { status: "completed" as const };
              }
              return { status: "paused" as const };
            },
          } as unknown as BuildRuntime,
          usage: () => emptyBudget(input.runId),
          observability: async () => emptyObservability(input.runId),
          compact: () => sessions.compactRun(input.runId),
          projectHandoff: async () => { throw new Error("not awaiting handoff"); },
          cleanup: () => sessions.compactRun(input.runId),
          close: () => undefined,
        };
      },
    });
    await manager.create({ ...spec, runId: "run_active", idempotencyKey: "active" });
    await manager.create({ ...spec, runId: "run_settled", idempotencyKey: "settled" });
    manager.activate("run_settled");
    await manager.awaitIdle("run_settled");

    await assert.rejects(artifacts.verify(settledOld), /not found/i);
    await artifacts.verify(activeOld);
    assert.equal(guard.scanCount, 1);
  } finally {
    await manager?.close();
    sessions.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent settlements coalesce into one live reachability scan", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-live-gc-coalesce-"));
  let arrivals = 0;
  let releaseBoth!: () => void;
  const bothReleased = new Promise<void>((resolve) => { releaseBoth = resolve; });
  let bothStarted!: () => void;
  const started = new Promise<void>((resolve) => { bothStarted = resolve; });
  let scans = 0;
  const projections = new Map<string, SchedulerProjection>();
  const manager = new NativeBuildManager({
    specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
    runArtifactCompaction: async (operation) => await operation(),
    prepareArtifactCleanup: async () => { scans += 1; },
    createRuntime: async (input) => {
      let projection = fakeRuntime(input.runId).projection();
      projections.set(input.runId, projection);
      return {
        ...handleProjections(input.runId),
        runtime: {
          ...fakeRuntime(input.runId),
          projection: () => projections.get(input.runId)!,
          runUntilBlocked: async () => {
            arrivals += 1;
            if (arrivals === 2) bothStarted();
            await bothReleased;
            projection = { ...projection, status: "completed" };
            projections.set(input.runId, projection);
            return { status: "completed" as const };
          },
        } as unknown as BuildRuntime,
        usage: () => emptyBudget(input.runId),
        observability: async () => emptyObservability(input.runId),
        projectHandoff: async () => { throw new Error("not awaiting handoff"); },
        cleanup: () => undefined,
        close: () => undefined,
      };
    },
  });
  try {
    await manager.create({ ...spec, runId: "run_a", idempotencyKey: "a" });
    await manager.create({ ...spec, runId: "run_b", idempotencyKey: "b" });
    manager.activate("run_a");
    manager.activate("run_b");
    await started;
    releaseBoth();
    await manager.awaitIdle();
    assert.equal(scans, 1);
  } finally {
    releaseBoth();
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("settlement admitted after a live scan schedules a fresh compaction generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-live-gc-generation-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const guard = new ArtifactReachabilityGuard(root, artifacts);
  const sessions = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts, {
    deleteArtifactIfGloballyUnreachable: (hash) => guard.removeIfGloballyUnreachable(hash),
  });
  let firstScanStarted!: () => void;
  const firstScan = new Promise<void>((resolve) => { firstScanStarted = resolve; });
  let releaseFirstScan!: () => void;
  const firstScanRelease = new Promise<void>((resolve) => { releaseFirstScan = resolve; });
  let prepareCalls = 0;
  let manager: NativeBuildManager | undefined;
  try {
    const firstObsolete = await checkpointTwice(sessions, "run_first");
    const queuedObsolete = await checkpointTwice(sessions, "run_queued");
    const projections = new Map<string, SchedulerProjection>();
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      runArtifactCompaction: (operation) => guard.runQuiescent(operation),
      prepareArtifactCleanup: async () => {
        prepareCalls += 1;
        if (prepareCalls === 1) {
          firstScanStarted();
          await firstScanRelease;
        }
        await guard.prepareReachabilityIndex();
      },
      createRuntime: async (input) => {
        let projection: SchedulerProjection = input.runId === "run_queued"
          ? requestedHandoffProjection("plan_only")
          : fakeRuntime(input.runId).projection();
        projections.set(input.runId, projection);
        return {
          ...handleProjections(input.runId),
          runtime: {
            ...fakeRuntime(input.runId),
            projection: () => projections.get(input.runId)!,
            runUntilBlocked: async () => {
              projection = { ...projection, status: "completed" };
              projections.set(input.runId, projection);
              return { status: "completed" as const };
            },
            selectProjectHandoff: (
              choice: "keep_integration_branch" | "apply_to_project"
            ) => {
              projection = selectedHandoffProjection(projection, choice);
              projections.set(input.runId, projection);
              return projection;
            },
          } as unknown as BuildRuntime,
          usage: () => emptyBudget(input.runId),
          observability: async () => emptyObservability(input.runId),
          compact: () => input.runId === "run_queued" &&
            projection.projectHandoff?.status !== "selected"
            ? undefined
            : sessions.compactRun(input.runId),
          projectHandoff: async (choice) => ({
            integrationRevision: "revision_final",
            integrationBranch: "aiboard/run/integration",
            appliedToProject: choice === "apply_to_project",
          }),
          cleanup: () => sessions.compactRun(input.runId),
          close: () => undefined,
        };
      },
    });
    await manager.create({ ...spec, runId: "run_first", idempotencyKey: "first" });
    await manager.create({ ...spec, runId: "run_queued", idempotencyKey: "queued" });
    manager.activate("run_first");
    await firstScan;
    const queuedSettlement = manager.selectProjectHandoff(
      "run_queued",
      "keep_integration_branch",
      "queued-handoff"
    );
    releaseFirstScan();
    await Promise.all([manager.awaitIdle("run_first"), queuedSettlement]);

    await assert.rejects(artifacts.verify(firstObsolete), /not found/i);
    await assert.rejects(artifacts.verify(queuedObsolete), /not found/i);
    assert.equal(prepareCalls, 2);
    assert.equal(guard.scanCount, 2);
  } finally {
    releaseFirstScan();
    await manager?.close();
    sessions.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed live reachability scan retains artifacts and reopens the activity gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-live-gc-failure-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const guard = new ArtifactReachabilityGuard(root, artifacts);
  const sessions = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts, {
    deleteArtifactIfGloballyUnreachable: (hash) => guard.removeIfGloballyUnreachable(hash),
  });
  let manager: NativeBuildManager | undefined;
  try {
    const retained = await checkpointTwice(sessions, "run_settled");
    writeFileSync(
      join(root, "corrupt.sqlite"),
      Buffer.concat([Buffer.from("SQLite format 3\0", "binary"), Buffer.from("broken")])
    );
    let waiterCalls = 0;
    const errors: string[] = [];
    const projections = new Map<string, SchedulerProjection>();
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      onPumpError: (runId) => errors.push(runId),
      runArtifactCompaction: (operation) => guard.runQuiescent(operation),
      prepareArtifactCleanup: () => guard.prepareReachabilityIndex(),
      createRuntime: async (input) => {
        let projection = fakeRuntime(input.runId).projection();
        projections.set(input.runId, projection);
        return {
          ...handleProjections(input.runId),
          runtime: {
            ...fakeRuntime(input.runId),
            projection: () => projections.get(input.runId)!,
            step: async () => {
              waiterCalls += 1;
              return { status: "progressed" as const };
            },
            runUntilBlocked: async () => {
              projection = { ...projection, status: "completed" };
              projections.set(input.runId, projection);
              return { status: "completed" as const };
            },
          } as unknown as BuildRuntime,
          usage: () => emptyBudget(input.runId),
          observability: async () => emptyObservability(input.runId),
          compact: () => input.runId === "run_settled"
            ? sessions.compactRun(input.runId)
            : undefined,
          projectHandoff: async () => { throw new Error("not awaiting handoff"); },
          cleanup: () => input.runId === "run_settled"
            ? sessions.compactRun(input.runId)
            : undefined,
          close: () => undefined,
        };
      },
    });
    await manager.create({ ...spec, runId: "run_settled", idempotencyKey: "settled" });
    await manager.create({ ...spec, runId: "run_waiter", idempotencyKey: "waiter" });
    manager.activate("run_settled");
    await manager.awaitIdle("run_settled");

    await artifacts.verify(retained);
    await manager.step("run_waiter");
    assert.equal(waiterCalls, 1);
    assert.deepEqual(errors, ["live-artifact-reachability"]);
  } finally {
    await manager?.close();
    sessions.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("close rejects work queued behind live compaction and waits for active work", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-live-gc-close-"));
  let releaseWriter!: () => void;
  const writerRelease = new Promise<void>((resolve) => { releaseWriter = resolve; });
  let writerStarted!: () => void;
  const writerStart = new Promise<void>((resolve) => { writerStarted = resolve; });
  let cleanupDone!: () => void;
  const cleanup = new Promise<void>((resolve) => { cleanupDone = resolve; });
  let releaseScan!: () => void;
  const scanRelease = new Promise<void>((resolve) => { releaseScan = resolve; });
  let scanStarted!: () => void;
  const scanStart = new Promise<void>((resolve) => { scanStarted = resolve; });
  let writerFinished = false;
  let closeOverlappedWriter = false;
  const projections = new Map<string, SchedulerProjection>();
  const manager = new NativeBuildManager({
    specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
    runArtifactCompaction: async (operation) => await operation(),
    prepareArtifactCleanup: async () => {
      scanStarted();
      await scanRelease;
    },
    createRuntime: async (input) => {
      let projection = fakeRuntime(input.runId).projection();
      projections.set(input.runId, projection);
      return {
        ...handleProjections(input.runId),
        runtime: {
          ...fakeRuntime(input.runId),
          projection: () => projections.get(input.runId)!,
          step: async () => ({ status: "progressed" as const }),
          runUntilBlocked: async () => {
            if (input.runId === "run_writer") {
              writerStarted();
              await writerRelease;
              writerFinished = true;
              return { status: "paused" as const };
            }
            projection = { ...projection, status: "completed" };
            projections.set(input.runId, projection);
            return { status: "completed" as const };
          },
        } as unknown as BuildRuntime,
        usage: () => emptyBudget(input.runId),
        observability: async () => emptyObservability(input.runId),
        projectHandoff: async () => { throw new Error("not awaiting handoff"); },
        cleanup: () => { if (input.runId === "run_settled") cleanupDone(); },
        close: () => { if (!writerFinished) closeOverlappedWriter = true; },
      };
    },
  });
  try {
    await manager.create({ ...spec, runId: "run_writer", idempotencyKey: "writer" });
    await manager.create({ ...spec, runId: "run_settled", idempotencyKey: "settled" });
    const activeWriter = manager.runUntilBlocked("run_writer");
    await writerStart;
    manager.activate("run_settled");
    await cleanup;
    const queuedStep = manager.step("run_writer");
    const closing = manager.close();
    releaseWriter();
    await scanStart;
    releaseScan();

    await activeWriter;
    await assert.rejects(queuedStep, /clos/i);
    await closing;
    assert.equal(closeOverlappedWriter, false);
  } finally {
    releaseWriter();
    releaseScan();
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("close retries cleanup that failed after settlement", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-close-cleanup-"));
  let cleanupCalls = 0;
  let projection: SchedulerProjection = fakeRuntime("run_1").projection();
  const manager = new NativeBuildManager({
    specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
    createRuntime: async () => ({
      ...handleProjections("run_1"),
      runtime: {
        ...fakeRuntime("run_1"),
        projection: () => projection,
        runUntilBlocked: async () => {
          projection = requestedHandoffProjection("finish");
          return { status: "paused" as const, action: "completion_decision_required" };
        },
        selectProjectHandoff: (choice: "keep_integration_branch" | "apply_to_project") => {
          projection = selectedHandoffProjection(projection, choice);
          return projection;
        },
      } as unknown as BuildRuntime,
      usage: () => emptyBudget("run_1"),
      observability: async () => emptyObservability("run_1"),
      projectHandoff: async () => ({
        integrationRevision: "revision_final",
        integrationBranch: "aiboard/run/integration",
        appliedToProject: true,
        projectRevision: "project_revision",
      }),
      cleanup: async () => {
        cleanupCalls += 1;
        if (cleanupCalls === 1) throw new Error("transient cleanup failure");
      },
      close: () => undefined,
    }),
  });
  try {
    await manager.create({ ...spec, runPolicy: "finish", budgetLimits: {} });
    manager.activate("run_1");
    await manager.awaitIdle("run_1");
    assert.equal(cleanupCalls, 1);
    await manager.close();
    assert.equal(cleanupCalls, 2);
  } finally {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager close shares failures then retries only the handle that still owns a child", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-handle-close-retry-"));
  const project = join(root, "project");
  const successState = join(root, "success-state");
  const failedState = join(root, "failed-state");
  const successPlugin = join(root, "success-plugin");
  const failedPlugin = join(root, "failed-plugin");
  for (const directory of [project, successState, failedState, successPlugin, failedPlugin]) {
    mkdirSync(directory);
  }
  writeManagerCloseExtension(successPlugin, "fixture.success", false);
  writeManagerCloseExtension(failedPlugin, "fixture.failed", true);
  let successExtensions: LoadedRunnerExtensions | undefined;
  let failedExtensions: LoadedRunnerExtensions | undefined;
  let manager: NativeBuildManager | undefined;
  let hasPrimaryFailure = false; let primaryFailure: unknown;
  t.diagnostic(`C5 finalizer10 acquired exact manager fixture: ${root}`);
  let childPid = 0;
  let failedProjectionCalls = 0;
  let failedTeardownStarted = false;
  try {
    successExtensions = await new LocalPluginLoader({
      pluginDirectories: [successPlugin],
      projectDirectory: project,
      stateDirectory: successState,
    }).load();
    failedExtensions = await new LocalPluginLoader({
      pluginDirectories: [failedPlugin],
      projectDirectory: project,
      stateDirectory: failedState,
    }).load();
    const failedPidPath = join(
      failedState,
      "extensions",
      "fixture.failed",
      "child.pid",
    );
    childPid = Number(readFileSync(failedPidPath, "utf8"));
    const handles = new Map([
      ["run_success", successExtensions],
      ["run_failed", failedExtensions],
    ]);
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: async (input) => {
        const runtime = fakeRuntime(input.runId);
        return {
          ...handleProjections(input.runId),
          runtime: {
            ...runtime,
            projection: () => {
              if (input.runId === "run_failed") {
                failedProjectionCalls += 1;
                if (failedTeardownStarted) {
                  throw new Error("projection unavailable after teardown began");
                }
              }
              return runtime.projection();
            },
          } as BuildRuntime,
          usage: () => emptyBudget(input.runId),
          observability: async () => emptyObservability(input.runId),
          projectHandoff: async () => { throw new Error("not awaiting handoff"); },
          cleanup: () => undefined,
          close: async () => {
            if (input.runId === "run_failed") failedTeardownStarted = true;
            await handles.get(input.runId)!.close();
          },
        };
      },
      shouldAutoRun: () => false,
      onPumpError: () => undefined,
      onPumpResult: () => undefined,
    });
    await manager.create({
      ...spec,
      runId: "run_success",
      idempotencyKey: "manager-close-success",
    });
    await manager.create({
      ...spec,
      runId: "run_failed",
      idempotencyKey: "manager-close-failed",
    });

    const firstAttempt = await Promise.allSettled([manager.close(), manager.close()]);
    assert.deepEqual(firstAttempt.map((result) => result.status), ["rejected", "rejected"]);
    assert.equal(processExistsForManagerTest(childPid), true);
    assert.equal(
      readFileSync(join(successState, "extensions", "fixture.success", "lifecycle.log"), "utf8"),
      "start\nclose:1\n",
    );
    assert.equal(
      readFileSync(join(failedState, "extensions", "fixture.failed", "lifecycle.log"), "utf8"),
      "start\nclose:1\n",
    );

    await manager.close();
    await waitForManagerProcess(() => !processExistsForManagerTest(childPid));
    assert.equal(
      readFileSync(join(successState, "extensions", "fixture.success", "lifecycle.log"), "utf8"),
      "start\nclose:1\n",
    );
    assert.equal(
      readFileSync(join(failedState, "extensions", "fixture.failed", "lifecycle.log"), "utf8"),
      "start\nclose:1\nclose:2\n",
    );
    assert.deepEqual(readdirSync(join(successState, "extension-executions")), []);
    assert.deepEqual(readdirSync(join(failedState, "extension-executions")), []);
    assert.equal(failedProjectionCalls, 2);
    manager = undefined;
    successExtensions = undefined;
    failedExtensions = undefined;
  } catch (error) { hasPrimaryFailure = true; primaryFailure = error; }
  finally {
    await finalizeCertifiedFixture({
      fixtureName: "manager handle retry", root, hasPrimaryFailure, primaryFailure,
      cleanup: async () => {
        const failures: unknown[] = [];
        // Retain the actual owners and close each even when another rejects.
        // Their existing idempotent close tracks which handle still owns work.
        for (const owner of [manager, failedExtensions, successExtensions]) {
          if (!owner) continue;
          try { await owner.close(); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, "Retained manager/extension cleanup failed.");
      },
      certify: async () => {
        const pidPath = join(failedState, "extensions", "fixture.failed", "child.pid");
        assert.ok(existsSync(pidPath), "the original child marker must be retained");
        childPid = Number(readFileSync(pidPath, "utf8"));
        assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
        assert.throws(() => process.kill(childPid, 0),
          (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === "ESRCH",
          "only a definite absent observation can certify cleanup; permission/tool failures remain unknown");
        assert.equal(readFileSync(join(successState, "extensions", "fixture.success", "lifecycle.log"), "utf8"), "start\nclose:1\n");
        assert.equal(readFileSync(join(failedState, "extensions", "fixture.failed", "lifecycle.log"), "utf8"), "start\nclose:1\nclose:2\n");
        for (const state of [successState, failedState]) {
          assert.deepEqual(readdirSync(join(state, "extension-executions")), [], "every execution-copy owner must be released");
        }
      },
      removeRoot: () => { rmSync(root, { recursive: true }); t.diagnostic(`C5 finalizer10 removed certified manager fixture: ${root}`); },
    });
  }
});

test("manager close aggregates projection failure but still closes the reachable handle", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-projection-close-"));
  let projectionCalls = 0;
  let closeCalls = 0;
  const specs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
  const manager = new NativeBuildManager({
    specs,
    createRuntime: async (input) => ({
      ...handleProjections(input.runId),
      runtime: {
        ...fakeRuntime(input.runId),
        projection: () => {
          projectionCalls += 1;
          if (projectionCalls > 1) {
            throw new Error("injected shutdown projection failure");
          }
          return fakeRuntime(input.runId).projection();
        },
      } as BuildRuntime,
      usage: () => emptyBudget(input.runId),
      observability: async () => emptyObservability(input.runId),
      projectHandoff: async () => { throw new Error("not awaiting handoff"); },
      cleanup: () => undefined,
      close: () => {
        closeCalls += 1;
      },
    }),
    shouldAutoRun: () => false,
    onPumpError: () => undefined,
    onPumpResult: () => undefined,
  });
  try {
    await manager.create({
      ...spec,
      runId: "run_projection_failure",
      idempotencyKey: "manager-close-projection-failure",
    });
    await assert.rejects(
      manager.close(),
      (error: unknown) => error instanceof AggregateError &&
        error.errors.some((failure) => /shutdown projection failure/i.test(String(failure))),
    );
    assert.equal(projectionCalls, 2);
    assert.equal(closeCalls, 1);

    await manager.close();
    assert.equal(projectionCalls, 2);
    assert.equal(closeCalls, 1);
  } finally {
    await manager.close().catch(() => undefined);
    try {
      specs.close();
    } catch {
      // The manager owns the store in the green path; the red path needs this release.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("close waits for an in-flight automatic handoff before closing resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-close-handoff-"));
  let releasePump!: () => void;
  let markPumpStarted!: () => void;
  const pumpStarted = new Promise<void>((resolve) => {
    markPumpStarted = resolve;
  });
  const pumpRelease = new Promise<void>((resolve) => {
    releasePump = resolve;
  });
  let handoffCalls = 0;
  let cleanupCalls = 0;
  let closedCalls = 0;
  let projection: SchedulerProjection = fakeRuntime("run_1").projection();
  const manager = new NativeBuildManager({
    specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
    createRuntime: async () => ({
      ...handleProjections("run_1"),
      runtime: {
        ...fakeRuntime("run_1"),
        projection: () => projection,
        runUntilBlocked: async () => {
          markPumpStarted();
          await pumpRelease;
          projection = requestedHandoffProjection("finish");
          return { status: "paused" as const, action: "completion_decision_required" };
        },
        selectProjectHandoff: (choice: "keep_integration_branch" | "apply_to_project") => {
          projection = selectedHandoffProjection(projection, choice);
          return projection;
        },
      } as unknown as BuildRuntime,
      usage: () => emptyBudget("run_1"),
      observability: async () => emptyObservability("run_1"),
      projectHandoff: async () => {
        handoffCalls += 1;
        return {
          integrationRevision: "revision_final",
          integrationBranch: "aiboard/run/integration",
          appliedToProject: true,
          projectRevision: "project_revision",
        };
      },
      cleanup: async () => {
        cleanupCalls += 1;
      },
      close: () => {
        closedCalls += 1;
      },
    }),
  });
  try {
    await manager.create({ ...spec, runPolicy: "finish", budgetLimits: {} });
    manager.activate("run_1");
    await pumpStarted;
    const closing = manager.close();
    releasePump();
    await closing;

    assert.equal(handoffCalls, 1);
    assert.equal(cleanupCalls, 1);
    assert.equal(closedCalls, 1);
    assert.equal(projection.status, "completed");
  } finally {
    releasePump();
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery rejects an active missing capability contract before constructing its runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-capability-contract-"));
  const specs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
  let constructed = 0;
  const recoveryErrors: unknown[] = [];
  const manager = new NativeBuildManager({
    specs,
    createRuntime: async () => {
      constructed += 1;
      throw new Error("runtime construction must not reach provider/model startup");
    },
    validateRecoveredSpec: async () => {
      throw new RunnerCapabilityContractError(
        "capability_contract_missing",
        "active Build recovery requires a persisted capability contract",
      );
    },
    onRecoverySpecError: (_runId, error) => {
      recoveryErrors.push(error);
    },
  });
  try {
    specs.save({ ...spec, runPolicy: "finish", budgetLimits: {} });

    await manager.recover();

    assert.equal(constructed, 0);
    assert.equal(recoveryErrors.length, 1);
    assert.equal(
      (recoveryErrors[0] as RunnerCapabilityContractError).code,
      "capability_contract_missing",
    );
  } finally {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery routes an active runtime-construction failure through the durable recovery error path", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-runtime-recovery-error-"));
  const specs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
  const recoveryErrors: unknown[] = [];
  const pumpErrors: unknown[] = [];
  let constructed = 0;
  const manager = new NativeBuildManager({
    specs,
    validateRecoveredSpec: async () => undefined,
    createRuntime: async () => {
      constructed += 1;
      throw new Error("snapshot runtime construction failed");
    },
    onRecoverySpecError: (_runId, error) => recoveryErrors.push(error),
    onPumpError: (_runId, error) => pumpErrors.push(error),
  });
  try {
    specs.save({ ...spec, runPolicy: "finish", budgetLimits: {} });

    await manager.recover();

    assert.equal(constructed, 1);
    assert.equal(recoveryErrors.length, 1);
    assert.match(String(recoveryErrors[0]), /snapshot runtime construction failed/i);
    assert.equal(pumpErrors.length, 1);
  } finally {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal legacy Builds retain read-only historical projections without constructing a live runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-historical-read-"));
  const specs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
  let liveRuntimeConstructed = 0;
  let recoveryValidationCalls = 0;
  let historicalHandles = 0;
  let observedTerminalState: unknown;
  const projection: SchedulerProjection = {
    ...fakeRuntime("run_1").projection(),
    status: "completed",
    lastSequence: 7,
  };
  const historicalRuntime = {
    ...fakeRuntime("run_1"),
    projection: () => projection,
    events: (afterSequence = 0) => afterSequence < 7
      ? [{
          eventId: "historical-event",
          runId: "run_1",
          sequence: 7,
          type: "run.completed" as const,
          occurredAt: spec.createdAt,
          actor: { role: "runner" as const, id: "historical" },
          idempotencyKey: "historical-completed",
          payload: {},
        }]
      : [],
    step: async () => {
      throw new Error("Historical Builds are read-only.");
    },
    runUntilBlocked: async () => {
      throw new Error("Historical Builds are read-only.");
    },
  } as unknown as BuildRuntime;
  const manager = new NativeBuildManager({
    specs,
    shouldRecoverSpec: () => false,
    terminalStateForHistoricalSpec: () => "completed",
    validateRecoveredSpec: async () => {
      recoveryValidationCalls += 1;
      throw new Error("terminal historical reads must not validate live capabilities");
    },
    createRuntime: async () => {
      liveRuntimeConstructed += 1;
      throw new Error("terminal historical reads must not construct a live runtime");
    },
    createHistoricalRuntime: async (_spec, terminalState) => {
      historicalHandles += 1;
      observedTerminalState = terminalState;
      return {
        runtime: historicalRuntime,
        usage: () => ({ ...emptyBudget("run_1"), lastSequence: 3 }),
        observability: async () => ({
          ...emptyObservability("run_1"),
          events: historicalRuntime.events(),
        }),
        transcript: async () => ({
          turns: [{
            id: "turn-1",
            sessionId: "architect:1",
            actor: { role: "architect", id: "architect_1" },
            sequence: 4,
            ordinal: 1,
            occurredAt: spec.createdAt,
            text: "Historical transcript",
          }],
          cursor: 4,
        }),
        files: async () => ({
          source: "integration",
          revision: "a".repeat(40),
          appliedToProject: false,
          omittedFileCount: 0,
          files: [{ path: "historical.txt", content: "preserved\n" }],
        }),
        compact: () => undefined,
        projectHandoff: async () => {
          throw new Error("Historical Builds are read-only.");
        },
        cleanup: () => undefined,
        close: () => undefined,
        historical: true,
      };
    },
  });
  try {
    specs.save({ ...spec, capabilityContract: undefined });

    await manager.recover();

    assert.equal(liveRuntimeConstructed, 0);
    assert.equal(recoveryValidationCalls, 0);
    assert.equal(historicalHandles, 1);
    assert.equal(observedTerminalState, "completed");
    assert.equal(manager.projection("run_1").status, "completed");
    assert.equal(manager.usage("run_1").lastSequence, 3);
    assert.equal((await manager.observability("run_1")).events.length, 1);
    assert.equal((await manager.transcript("run_1")).turns[0]?.text, "Historical transcript");
    assert.equal((await manager.files("run_1")).files[0]?.content, "preserved\n");
    assert.equal(manager.events("run_1").length, 1);
    await assert.rejects(manager.step("run_1"), /read-only/i);
  } finally {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("historical Builds reject every manager mutation before invoking a replayed runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-historical-mutations-"));
  const specs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
  const mutations: string[] = [];
  const projection: SchedulerProjection = {
    ...fakeRuntime("run_1").projection(),
    status: "completed",
    projectHandoff: {
      status: "requested",
      summary: "Historical handoff",
      options: ["keep_integration_branch", "apply_to_project"],
    },
  };
  const mutation = <T>(name: string, value: T): T => {
    mutations.push(name);
    return value;
  };
  const historicalRuntime = {
    id: "run_1",
    projection: () => projection,
    events: () => [],
    step: async () => mutation("step", { status: "idle" as const }),
    runUntilBlocked: async () => mutation("runUntilBlocked", { status: "idle" as const }),
    pause: () => mutation("pause", projection),
    resume: () => mutation("resume", projection),
    continue: () => mutation("continue", projection),
    selectArchitectHandoff: () => mutation("selectArchitectHandoff", projection),
    selectVerifierRuntime: () => mutation("selectVerifierRuntime", projection),
    submitUserGuidance: () => mutation("submitUserGuidance", projection),
    submitManagedUserGuidance: () => mutation("submitManagedUserGuidance", projection),
    completeManagedUserGuidanceInterruption: () => mutation("completeManagedUserGuidanceInterruption", projection),
    answerArchitectQuestion: () => mutation("answerArchitectQuestion", projection),
    selectProjectHandoff: () => mutation("selectProjectHandoff", projection),
  } as unknown as BuildRuntime;
  const manager = new NativeBuildManager({
    specs,
    shouldRecoverSpec: () => false,
    terminalStateForHistoricalSpec: () => "stopped",
    createRuntime: async () => {
      throw new Error("historical mutation guards must not construct a live runtime");
    },
    createHistoricalRuntime: async () => ({
      runtime: historicalRuntime,
      historical: true,
      usage: () => emptyBudget("run_1"),
      observability: async () => emptyObservability("run_1"),
      transcript: async () => ({ turns: [], cursor: 0 }),
      files: async () => ({
        source: "integration",
        revision: "",
        appliedToProject: false,
        omittedFileCount: 0,
        files: [],
      }),
      compact: () => undefined,
      projectHandoff: async () => mutation("projectHandoff", {
        integrationRevision: "",
        integrationBranch: "",
        appliedToProject: false,
      }),
      cleanup: () => undefined,
      close: () => undefined,
    }),
  });
  try {
    specs.save({
      ...spec,
      benchmark: {
        attemptId: "historical-mutations",
        allowedCommands: [],
        hiddenPaths: [],
        protectedPaths: [],
      },
    });
    await manager.recover();

    assert.throws(() => manager.activate("run_1"), /read-only/i);
    const pumps = (manager as unknown as { pumps: Map<string, Promise<void>> }).pumps;
    pumps.set("run_1", Promise.resolve());
    assert.throws(
      () => manager.activate("run_1"),
      /read-only/i,
      "historical activation must reject before an idempotent pump shortcut",
    );
    pumps.delete("run_1");
    await assert.rejects(manager.step("run_1"), /read-only/i);
    await assert.rejects(manager.runUntilBlocked("run_1"), /read-only/i);
    await assert.rejects(manager.submitUserGuidance("run_1", {
      guidanceId: "guidance", text: "Do not mutate history.", version: 1, idempotencyKey: "guidance",
    }), /read-only/i);
    await assert.rejects(manager.answerArchitectQuestion("run_1", {
      questionId: "question", expectedVersion: 1, answer: "No.", idempotencyKey: "answer",
    }), /read-only/i);
    await assert.rejects(manager.pause("run_1", "historical", "pause"), /read-only/i);
    await assert.rejects(manager.resume("run_1", "resume"), /read-only/i);
    await assert.rejects(manager.continue("run_1", "continue"), /read-only/i);
    await assert.rejects(manager.selectArchitectHandoff("run_1", "runtime", "architect"), /read-only/i);
    await assert.rejects(manager.selectVerifierRuntime("run_1", "runtime", "verifier"), /read-only/i);
    await assert.rejects(
      manager.selectProjectHandoff("run_1", "keep_integration_branch", "project"),
      /read-only/i,
    );
    assert.deepEqual(mutations, []);
  } finally {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("new Builds persist a runner-prepared capability contract before runtime construction", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-capability-stamp-"));
  const specs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
  const capabilityContract = await createRunnerCapabilityContract({
    extensions: [],
    languageServers: [],
  });
  let runtimeSpec: NativeBuildSpec | undefined;
  const manager = new NativeBuildManager({
    specs,
    prepareSpec: async (input) => ({
      ...input,
      capabilityContract,
    }),
    createRuntime: async (input) => {
      runtimeSpec = input;
      return {
        ...handleProjections(input.runId),
        runtime: fakeRuntime(input.runId),
        usage: () => emptyBudget(input.runId),
        observability: async () => emptyObservability(input.runId),
        projectHandoff: async () => ({
          integrationRevision: "revision_final",
          integrationBranch: "aiboard/run/integration",
          appliedToProject: false,
        }),
        cleanup: () => undefined,
        close: () => undefined,
      };
    },
  });
  try {
    await manager.create({ ...spec, runPolicy: "finish", budgetLimits: {} });

    assert.equal(
      specs.get(spec.runId).capabilityContract?.digest,
      capabilityContract.digest,
    );
    assert.equal(runtimeSpec?.capabilityContract?.digest, capabilityContract.digest);
  } finally {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("configured usage marks an Architect-only capability mismatch unavailable", () => {
  const architect = configuredModelUsageRuntime({
    runtimeId: "chatgpt:gpt-5.5",
    providerId: "chatgpt",
    modelId: "gpt-5.5",
    transport: "account-runner",
    secret: "architect-secret",
    capabilities: ["vision"],
    priority: 0,
  }, spec);
  const worker = configuredModelUsageRuntime({
    runtimeId: "chatgpt:gpt-5.4",
    providerId: "chatgpt",
    modelId: "gpt-5.4",
    transport: "account-runner",
    secret: "worker-secret",
    capabilities: ["vision"],
    priority: 1,
  }, spec);
  const verifier = configuredModelUsageRuntime({
    runtimeId: "google:verifier-only",
    providerId: "google",
    modelId: "verifier-only",
    transport: "google",
    secret: "verifier-secret",
    capabilities: ["code"],
    priority: 2,
  }, {
    ...spec,
    verifierRuntimeIds: ["google:verifier-only"],
  });

  assert.deepEqual(architect.roles, ["architect"]);
  assert.equal(architect.selectable, false);
  assert.deepEqual(worker.roles, ["worker", "verifier"]);
  assert.equal(worker.selectable, true);
  assert.deepEqual(verifier.roles, ["verifier"]);
  assert.equal(verifier.selectable, true);
});

function emptyBudget(scopeId: string) {
  const usage = () => ({
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    estimatedCostMicros: 0,
    activeMs: 0,
    artifactBytes: 0,
  });
  return {
    scopeId,
    reservations: {},
    activeSegments: {},
    effective: usage(),
    lifetime: usage(),
    window: { index: 1 },
    lastSequence: 0,
    attributedModelReservationCount: 0,
    models: [],
  };
}

function emptyObservability(runId: string) {
  return {
    runId,
    budget: emptyBudget(runId),
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
  };
}

function fakeRuntime(runId: string): BuildRuntime {
  return {
    id: runId,
    projection: () => ({
      runId,
      status: "running",
      planRevision: 0,
      tasks: {},
      guidance: {},
      reviews: {},
      runtime: { providerHealth: {}, workerAssignments: {}, architect: {} },
      lastSequence: 0,
    }),
    events: () => [],
    step: async () => ({ status: "idle" }),
    runUntilBlocked: async () => ({ status: "idle" }),
    selectArchitectHandoff: () => {
      throw new Error("unused");
    },
  } as unknown as BuildRuntime;
}

function handleProjections(_runId: string) {
  return {
    transcript: async () => ({ turns: [], cursor: 0 }),
    files: async () => ({
      source: "integration" as const,
      revision: "a".repeat(40),
      appliedToProject: false,
      omittedFileCount: 0,
      files: [],
    }),
    compact: async () => undefined,
  };
}

function requestedHandoffProjection(
  runPolicy: "finish" | "budgeted" | "plan_only" | undefined
): SchedulerProjection {
  if (runPolicy === "finish" || runPolicy === "budgeted") {
    const revision = "revision_final";
    const generationId = "generation_final";
    const taskId = "final_verification_final";
    const submissionId = "submission_final";
    const reviewId = "review_final";
    const plan = {
      checks: (["build", "tests", "runtime_smoke", "browser"] as const).map(
        (category) => ({
          category,
          status: "not_applicable" as const,
          rationale: `No ${category} fixture exists.`,
          repositoryInspection: {
            paths: ["package.json"],
            summary: `No ${category} entry point exists.`,
          },
        }),
      ),
    };
    const completedChecks = plan.checks.map((check) => ({
      ...check,
      green: true,
      evidenceIds: [],
      facts: [],
      issues: [],
      attempt: 1,
      workspacePath: "C:/verification",
      startedAt: "2026-07-14T00:00:00.000Z",
      finishedAt: "2026-07-14T00:00:01.000Z",
    }));
    const submissionChecks = plan.checks.map((check) => ({
      ...check,
      green: true as const,
      evidenceIds: [],
      facts: [],
    }));
    return {
      ...fakeRuntime("run_1").projection(),
      runPolicy,
      planRevision: 1,
      status: "paused",
      integrationRevision: revision,
      tasks: {
        [taskId]: {
          id: taskId,
          kind: "final_verification",
          objective: "Verify the canonical integrated revision.",
          dependencies: [],
          status: "planned",
          requiredCapabilities: ["verification"],
          attempt: 0,
          generationId,
          targetRevision: revision,
          planVersion: 1,
          verificationPlan: plan,
          verificationSubmissionId: submissionId,
          verificationReviewId: reviewId,
        },
      },
      finalVerification: {
        current: {
          taskId,
          generationId,
          targetRevision: revision,
          planVersion: 1,
          plan,
          executionProfile: emptyFinalVerificationProfile(revision),
          state: "current",
          completedChecks,
          submission: { submissionId, generationId, targetRevision: revision, attempt: 1 },
          submissionResult: {
            kind: "final_verification_submission",
            generationId,
            runId: "run_1",
            taskId,
            attempt: 1,
            targetRevision: revision,
            plan,
            executionProfile: emptyFinalVerificationProfile(revision),
            checks: submissionChecks,
            evidenceIds: [],
            submittedAt: "2026-07-14T00:00:02.000Z",
            green: true,
          },
          cleanup: {
            generationId, taskId, targetRevision: revision, attempt: 1,
            status: "succeeded",
            startedAt: "2026-07-14T00:00:02.100Z",
            finishedAt: "2026-07-14T00:00:02.200Z",
          },
          review: {
            reviewId,
            submissionId,
            generationId,
            targetRevision: revision,
            attempt: 1,
            status: "approved",
            decision: {
              decision: "approved",
              summary: "All final-verification categories are approved.",
              targetRevision: revision,
              architectRisk: {
                risk: "low",
                rationale: "No semantic high-risk condition applies.",
                source: "architect",
              },
              categoryReviews: plan.checks.map((check) => ({
                category: check.category,
                verdict: "approved" as const,
                rationale: `The ${check.category} inspection supports approval.`,
                evidenceIds: [],
              })),
              failedCategories: [],
            },
          },
        },
        history: [],
      },
      projectHandoff: {
        status: "requested",
        summary: "Ready",
        options: ["keep_integration_branch", "apply_to_project"],
      },
    };
  }
  return {
    ...fakeRuntime("run_1").projection(),
    ...(runPolicy ? { runPolicy } : {}),
    ...(runPolicy === "plan_only" ? { planRevision: 1 } : {}),
    status: "paused",
    projectHandoff: {
      status: "requested",
      summary: "Ready",
      options: ["keep_integration_branch", "apply_to_project"],
    },
  };
}

function selectedHandoffProjection(
  projection: SchedulerProjection,
  choice: "keep_integration_branch" | "apply_to_project"
): SchedulerProjection {
  return {
    ...projection,
    status: "completed",
    projectHandoff: {
      status: "selected",
      summary: "Ready",
      options: ["keep_integration_branch", "apply_to_project"],
      choice,
      integrationRevision: "revision_final",
      integrationBranch: "aiboard/run/integration",
      appliedToProject: choice === "apply_to_project",
    },
  };
}

function writeManagerCloseExtension(
  directory: string,
  id: string,
  failOnceWithChild: boolean,
): void {
  writeFileSync(join(directory, "runner-extension.json"), JSON.stringify({
    apiVersion: 1,
    id,
    name: id,
    version: "1.0.0",
    entry: "index.mjs",
    capabilities: [],
  }));
  writeFileSync(join(directory, "index.mjs"), [
    'import { spawn } from "node:child_process";',
    'import { appendFile, writeFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    "let stateDirectory;",
    "let child;",
    "let closeAttempts = 0;",
    "async function stopChild() {",
    "  if (!child || child.exitCode !== null || child.signalCode !== null) return;",
    "  child.kill('SIGTERM');",
    "  await new Promise((resolve, reject) => {",
    "    const timer = setTimeout(() => reject(new Error('manager fixture child did not exit')), 2000);",
    "    child.once('exit', () => { clearTimeout(timer); resolve(); });",
    "  });",
    "}",
    "export function createExtension() {",
    "  return {",
    "    capabilities: () => ({ tools: [], contextContributors: [], languageProviders: [] }),",
    "    start: async (context) => {",
    "      stateDirectory = context.stateDirectory;",
    ...(failOnceWithChild
      ? [
          "      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
          "      await writeFile(join(stateDirectory, 'child.pid'), String(child.pid));",
        ]
      : []),
    "      await appendFile(join(stateDirectory, 'lifecycle.log'), 'start\\n');",
    "    },",
    "    close: async () => {",
    "      closeAttempts += 1;",
    "      await appendFile(join(stateDirectory, 'lifecycle.log'), `close:${closeAttempts}\\n`);",
    ...(failOnceWithChild
      ? ["      if (closeAttempts === 1) throw new Error('injected handle close failure');"]
      : []),
    "      await stopChild();",
    "    },",
    "  };",
    "}",
    "",
  ].join("\n"));
}

function processExistsForManagerTest(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForManagerProcess(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for manager fixture process.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function checkpointTwice(
  sessions: SqliteAgentSessionStore,
  runId: string
): Promise<string> {
  const sessionId = `worker:${runId}:task:1`;
  await sessions.create({
    sessionId,
    runId,
    actor: { role: "worker", id: `worker_${runId}` },
    occurredAt: "2026-07-14T00:00:00.000Z",
  });
  await sessions.checkpoint(sessionId, {
    messages: [{
      id: "assistant_1",
      role: "assistant",
      content: [{ type: "text", text: `${runId}:first` }],
    }],
    turns: 1,
    seenCallIds: [],
  }, "2026-07-14T00:00:01.000Z");
  const oldHash = sessions.events(sessionId)[1]!.artifactHash!;
  await sessions.checkpoint(sessionId, {
    messages: [{
      id: "assistant_2",
      role: "assistant",
      content: [{ type: "text", text: `${runId}:second` }],
    }],
    turns: 2,
    seenCallIds: [],
  }, "2026-07-14T00:00:02.000Z");
  return oldHash;
}

test("terminal historical reader failure is diagnostic and does not block active-resource startup reconciliation", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-historical-report-"));
  const specs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
  specs.save(spec);
  const recoveryErrors: unknown[] = [];
  const pumpErrors: Array<{ runId: string; error: unknown }> = [];
  const manager = new NativeBuildManager({
    specs,
    shouldRecoverSpec: () => false,
    terminalStateForHistoricalSpec: () => "completed",
    createRuntime: async () => { throw new Error("terminal history must not construct a live runtime"); },
    createHistoricalRuntime: async () => { throw new Error("historical reader unavailable"); },
    onRecoverySpecError: (_runId, error) => recoveryErrors.push(error),
    onPumpError: (runId, error) => pumpErrors.push({ runId, error }),
  });
  try {
    const report = await manager.recover();
    assert.deepEqual(report.failures, [], "terminal read-only projection failure is not unresolved active ownership");
    assert.deepEqual(recoveryErrors, [], "terminal reader failure must not mutate active recovery state");
    assert.equal(pumpErrors.length, 1);
    assert.equal(pumpErrors[0]?.runId, spec.runId);
    assert.match(String(pumpErrors[0]?.error), /historical reader unavailable/i);
  } finally {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("startup recovery returns typed failure details instead of silently accepting unresolved active resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-startup-report-"));
  const specs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
  specs.save(spec);
  const manager = new NativeBuildManager({
    specs,
    createRuntime: async () => { throw new Error("owned backend recovery remained unresolved"); },
  });
  try {
    const report = await manager.recover();
    assert.deepEqual(report.failures.map((failure) => ({ runId: failure.runId, stage: failure.stage })), [
      { runId: "run_1", stage: "runtime_construction" },
    ]);
    assert.match(String(report.failures[0]?.error), /owned backend recovery remained unresolved/i);
  } finally {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});
