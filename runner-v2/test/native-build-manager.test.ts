import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BuildRuntime } from "../src/build-runtime.js";
import type { NativeBuildSpec } from "../src/build-spec.js";
import { NativeBuildManager } from "../src/native-build-manager.js";
import {
  configuredModelUsageRuntime,
  providerHealthFromSchedulerEvents,
  selectRuntimeCandidates,
} from "../src/native-build-factory.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import type { SchedulerProjection } from "../src/scheduler-store.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";

const spec: NativeBuildSpec = {
  version: 1,
  runId: "run_1",
  projectId: "project_1",
  objective: "Build a reliable application.",
  architectRuntimeId: "chatgpt:gpt-5.5",
  workerRuntimeIds: ["chatgpt:gpt-5.4"],
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
          runtime: fakeRuntime(input.runId),
          usage: () => emptyBudget(input.runId),
          observability: async () => emptyObservability(input.runId),
          projectHandoff: async () => ({
            integrationRevision: "revision_final",
            integrationBranch: "aiboard/run/integration",
            appliedToProject: false,
          }),
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
  let manager: NativeBuildManager | undefined;
  let projection: SchedulerProjection = {
    ...fakeRuntime("run_1").projection(),
    status: "paused" as const,
    projectHandoff: {
      status: "requested" as const,
      summary: "Ready",
      options: ["keep_integration_branch", "apply_to_project"],
    },
  };
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: async () => ({
        runtime: {
          ...fakeRuntime("run_1"),
          projection: () => projection,
          selectProjectHandoff: (choice: "keep_integration_branch" | "apply_to_project") => {
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
        close: () => undefined,
      }),
    });
    await manager.create(spec);
    await manager.selectProjectHandoff("run_1", "apply_to_project", "handoff:apply");
    const replay = await manager.selectProjectHandoff(
      "run_1",
      "apply_to_project",
      "handoff:apply"
    );
    assert.equal(replay.status, "completed");
    assert.equal(handoffCalls, 1);
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
  ];
  const selected = selectRuntimeCandidates(configs, spec);
  assert.deepEqual(
    selected.all.map((candidate) => candidate.runtimeId),
    ["chatgpt:gpt-5.5", "chatgpt:gpt-5.4"]
  );
  assert.deepEqual(
    selected.workers.map((candidate) => candidate.runtimeId),
    ["chatgpt:gpt-5.4"]
  );
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

  assert.deepEqual(architect.roles, ["architect"]);
  assert.equal(architect.selectable, false);
  assert.deepEqual(worker.roles, ["worker"]);
  assert.equal(worker.selectable, true);
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
