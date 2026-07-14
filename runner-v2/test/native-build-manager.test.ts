import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BuildRuntime } from "../src/build-runtime.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { ArtifactReachabilityGuard } from "../src/artifact-reachability.js";
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
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";

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
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resumeCalls, 0);
    assert.equal(pauseCalls, 0);
    assert.equal(architectHandoffCalls, 0);
    releaseFirstCompact();
    await manager.awaitIdle("run_settled");
    await Promise.all([resuming, pausing, selecting]);
    assert.equal(resumeCalls, 1);
    assert.equal(pauseCalls, 1);
    assert.equal(architectHandoffCalls, 1);
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
          ? {
              ...fakeRuntime(input.runId).projection(),
              status: "paused",
              runPolicy: "plan_only",
              projectHandoff: {
                status: "requested",
                summary: "Ready",
                options: ["keep_integration_branch", "apply_to_project"],
              },
            }
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
