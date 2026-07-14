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

test("autonomous pump continues after bounded progress without user Resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-yield-"));
  let pumpCalls = 0;
  let projection = fakeRuntime("run_1").projection();
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: async (input) => ({
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

test("close retries cleanup that failed after settlement", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-close-cleanup-"));
  let cleanupCalls = 0;
  let projection: SchedulerProjection = fakeRuntime("run_1").projection();
  const manager = new NativeBuildManager({
    specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
    createRuntime: async () => ({
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

function requestedHandoffProjection(
  runPolicy: "finish" | "budgeted" | "plan_only" | undefined
): SchedulerProjection {
  return {
    ...fakeRuntime("run_1").projection(),
    ...(runPolicy ? { runPolicy } : {}),
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
