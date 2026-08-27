import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolCallBlock } from "../src/agent-contracts.js";
import {
  BuildRuntime,
  type ArchitectActionRequest,
  type ArchitectRuntimeDriver,
  type IntegrationRuntimeDriver,
} from "../src/build-runtime.js";
import { ProviderHealthRegistry } from "../src/provider-health.js";
import { RuntimeRouter } from "../src/runtime-router.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import {
  TaskScheduler,
  type WorkerAssignment,
  type WorkerOutcome,
  type WorkerRuntimeDriver,
} from "../src/task-scheduler.js";
import {
  acceptFinalVerificationProfile,
  emptyFinalVerificationProfile,
} from "./support/final-verification-profile.js";

test("build runtime plans final verification after ordinary integration across restarts", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-runtime-"));
  const database = join(root, "scheduler.sqlite");
  const health = new ProviderHealthRegistry({ clock: () => 1_000 });
  const router = new RuntimeRouter({
    health,
    candidates: [
      {
        runtimeId: "primary:code",
        providerId: "primary",
        modelId: "code",
        capabilities: ["code"],
        priority: 1,
      },
      {
        runtimeId: "fallback:code",
        providerId: "fallback",
        modelId: "code",
        capabilities: ["code"],
        priority: 2,
      },
    ],
  });
  const architect = new ScriptedArchitect();
  let recoveredStore: SqliteSchedulerStore | undefined;
  const evidenceStore = new SqliteEvidenceStore(":memory:");
  const evidenceHash = "e".repeat(64);
  const evidenceByTask = new Map<string, string>();
  for (const taskId of ["task_a", "task_b"]) {
    const evidence = evidenceStore.record({
      runId: "run_1",
      taskId,
      actor: { role: "worker", id: `worker_${taskId}_1` },
      fact: {
        kind: "browser_screenshot",
        label: `${taskId} evidence`,
        capturedAt: "2026-07-12T00:00:00.000Z",
        screenshotArtifactHash: evidenceHash,
        mediaType: "image/png",
        byteLength: 10,
      },
      createdAt: "2026-07-12T00:00:00.000Z",
      idempotencyKey: `evidence:${taskId}`,
      attempt: 1,
    });
    evidenceByTask.set(taskId, evidence.id);
  }
  const workers = new ScriptedWorkers(router, evidenceByTask);
  const integration = new ScriptedIntegration();
  const schedulerOptions = {
    evidenceStore,
    validateExecutionProfile: acceptFinalVerificationProfile,
  };
  try {
    for (let restart = 0; restart < 20; restart += 1) {
      const store = new SqliteSchedulerStore(database, schedulerOptions);
      const runtime = new BuildRuntime({
        runId: "run_1",
        store,
        workerDriver: workers,
        architectDriver: architect,
        integrationDriver: integration,
        maxConcurrency: 2,
        workspaceFor: async (task) => `C:/work/${task.id}`,
        clock: () => "2026-07-12T00:00:00.000Z",
        evidenceStore,
        finalVerificationProfileFor: async (revision) => emptyFinalVerificationProfile(revision),
      });
      const step = await runtime.step();
      const projection = runtime.projection();
      store.close();
      if (projection.finalVerification?.current) {
        assert.equal(step.status, "progressed");
        break;
      }
    }

    recoveredStore = new SqliteSchedulerStore(database, schedulerOptions);
    const recovered = new BuildRuntime({
      runId: "run_1",
      store: recoveredStore,
      workerDriver: workers,
      architectDriver: architect,
      integrationDriver: integration,
      maxConcurrency: 2,
      workspaceFor: async (task) => `C:/work/${task.id}`,
      evidenceStore,
      finalVerificationProfileFor: async (revision) => emptyFinalVerificationProfile(revision),
    });
    const projection = recovered.projection();
    assert.equal(projection.status, "running");
    assert.equal(projection.projectHandoff, undefined);
    assert.equal(projection.finalVerification?.current?.targetRevision, "revision_task_b");
    assert.deepEqual(
      Object.values(projection.tasks)
        .filter((task) => task.kind !== "final_verification")
        .map((task) => task.status),
      ["integrated", "integrated"]
    );
    assert.equal(
      projection.tasks[projection.finalVerification!.current!.taskId].status,
      "planned"
    );
    assert.equal(workers.providerFailures, 1);
    assert.equal(workers.callsByTask.task_a, 1, "provider failover stays inside one attempt");
    assert.equal(workers.callsByTask.task_b, 2, "blocking guidance resumes the same attempt");
    assert.deepEqual(integration.calls.sort(), ["task_a", "task_b"]);
    assert.equal(new Set(integration.calls).size, integration.calls.length);
    assert.equal(architect.planCalls, 1);
    assert.equal(architect.completeCalls, 0);
  } finally {
    recoveredStore?.close();
    evidenceStore.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

test("pausing a Build aborts the active Architect lifecycle signal and carries its deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-runtime-cancel-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  let request: ArchitectActionRequest | undefined;
  let admit!: () => void;
  const admitted = new Promise<void>((resolve) => {
    admit = resolve;
  });
  const architect: ArchitectRuntimeDriver = {
    run: async (value) => {
      request = value;
      admit();
      await new Promise<void>((resolve) => {
        value.context.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
  try {
    const runtime = new BuildRuntime({
      runId: "run_cancel",
      store,
      workerDriver: { run: async () => ({ type: "paused", reason: "unused" }) },
      architectDriver: architect,
      integrationDriver: {
        integrate: async () => ({ status: "integrated", integrationRevision: "unused" }),
      },
      maxConcurrency: 1,
      workspaceFor: async () => "unused",
      providerRetryDeadlineMs: () => 54_321,
    });
    const step = runtime.step();
    await admitted;
    assert.equal(request?.providerRetryDeadlineMs, 54_321);
    assert.equal(request?.context.signal?.aborted, false);
    runtime.pause("user", "pause:cancel-active");
    assert.equal(request?.context.signal?.aborted, true);
    assert.equal((await step).status, "paused");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan-only Builds stay behind the scheduling boundary and require explicit handoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-runtime-plan-only-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const originalTick = TaskScheduler.prototype.tick;
  let schedulerTicks = 0;
  let workspaceCreations = 0;
  let workerAssignments = 0;
  let integrations = 0;
  let completionDecisions = 0;
  let callSequence = 0;
  TaskScheduler.prototype.tick = async function () {
    schedulerTicks += 1;
    return originalTick.call(this);
  };
  try {
    const runtime = new BuildRuntime({
      runId: "run_plan_only",
      runPolicy: "plan_only",
      store,
      workerDriver: {
        run: async () => {
          workerAssignments += 1;
          return { type: "submitted", changeSetId: "forbidden_changeset" };
        },
      },
      architectDriver: {
        run: async (request) => {
          const invoke = async (name: string, argumentsValue: unknown) => {
            callSequence += 1;
            const result = await request.tools.invoke({
              type: "tool_call",
              callId: `plan_only_${callSequence}`,
              name,
              arguments: argumentsValue,
            }, request.context);
            assert.equal(
              result.isError,
              false,
              result.error?.message ?? `Architect ${name} action failed`
            );
          };
          if (request.reason.type === "plan_required") {
            assert.deepEqual(
              request.tools.definitions().map((tool) => tool.name).sort(),
              [
                "answer_guidance",
                "plan_tasks",
                "revise_task",
                "upgrade_acceptance_contract",
              ]
            );
            for (const name of [
              "complete_run",
              "review_task",
              "request_integration",
            ]) {
              callSequence += 1;
              const rejected = await request.tools.invoke({
                type: "tool_call",
                callId: `plan_only_forbidden_${callSequence}`,
                name,
                arguments: {},
              }, request.context);
              assert.equal(rejected.isError, true, `${name} must be unavailable`);
              assert.equal(rejected.error?.code, "unknown_tool");
            }
            await invoke("plan_tasks", {
              revision: 1,
              tasks: [
                {
                  id: "task_a",
                  objective: "Draft the public API",
                  dependencies: [],
                  requiredCapabilities: ["code"],
                  acceptanceCriteria: [{ id: "api", text: "The public API is drafted." }],
                },
                {
                  id: "task_b",
                  objective: "Document the public API",
                  dependencies: ["task_a"],
                  requiredCapabilities: ["code"],
                  acceptanceCriteria: [{ id: "docs", text: "The public API is documented." }],
                },
              ],
            });
            return;
          }
          assert.deepEqual(request.reason, {
            type: "completion_decision_required",
            runPolicy: "plan_only",
          });
          assert.deepEqual(
            request.tools.definitions().map((tool) => tool.name).sort(),
            [
              "answer_guidance",
              "complete_run",
              "plan_tasks",
              "revise_task",
              "upgrade_acceptance_contract",
            ]
          );
          for (const name of ["review_task", "request_integration"]) {
            callSequence += 1;
            const rejected = await request.tools.invoke({
              type: "tool_call",
              callId: `plan_only_post_plan_forbidden_${callSequence}`,
              name,
              arguments: {},
            }, request.context);
            assert.equal(rejected.isError, true, `${name} must remain unavailable`);
            assert.equal(rejected.error?.code, "unknown_tool");
          }
          completionDecisions += 1;
          if (completionDecisions === 1) {
            await invoke("revise_task", {
              taskId: "task_b",
              revision: 2,
              objective: "Document the stable public API",
            });
            return;
          }
          await invoke("complete_run", {
            summary: "The implementation plan is ready for handoff.",
          });
        },
      },
      integrationDriver: {
        integrate: async () => {
          integrations += 1;
          return {
            status: "integrated",
            integrationRevision: "forbidden_revision",
          };
        },
      },
      maxConcurrency: 2,
      workspaceFor: async () => {
        workspaceCreations += 1;
        return "C:/forbidden-workspace";
      },
      clock: () => "2026-07-13T00:00:00.000Z",
    });

    assert.equal((await runtime.step()).action, "plan_required");
    assert.equal((await runtime.step()).action, "completion_decision_required");
    const handoff = await runtime.step();

    assert.equal(handoff.status, "paused");
    assert.equal(handoff.action, "completion_decision_required");
    assert.equal(runtime.projection().projectHandoff?.status, "requested");
    assert.equal(runtime.projection().runPolicy, "plan_only");
    assert.equal(runtime.projection().tasks.task_a.status, "planned");
    assert.equal(runtime.projection().tasks.task_b.status, "planned");
    assert.equal(
      runtime.projection().tasks.task_b.objective,
      "Document the stable public API"
    );
    assert.equal(completionDecisions, 2);
    assert.equal(schedulerTicks, 0);
    assert.equal(workspaceCreations, 0);
    assert.equal(workerAssignments, 0);
    assert.equal(integrations, 0);

    const selected = runtime.selectProjectHandoff(
      "keep_integration_branch",
      {
        integrationRevision: "baseline_revision",
        integrationBranch: "aiboard/integration/run_plan_only",
        appliedToProject: false,
      },
      "handoff:plan-only:keep"
    );
    assert.equal(selected.status, "completed");
  } finally {
    TaskScheduler.prototype.tick = originalTick;
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy scheduler logs configure their migrated policy once before stepping", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-runtime-policy-recovery-"));
  const database = join(root, "scheduler.sqlite");
  let store = new SqliteSchedulerStore(database);
  try {
    store.append({
      runId: "run_policy_recovery",
      type: "plan.created",
      occurredAt: "2026-07-12T00:00:00.000Z",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "plan:1",
      payload: {
        revision: 1,
        tasks: [{
          id: "task_1",
          objective: "Preserve the recovered plan",
          dependencies: [],
          status: "planned",
          requiredCapabilities: ["code"],
          attempt: 0,
        }],
      },
    });
    const architectDriver: ArchitectRuntimeDriver = {
      run: async (request) => {
        if (request.reason.type === "acceptance_contract_upgrade_required") {
          const upgrade = await request.tools.invoke({
            type: "tool_call",
            callId: "upgrade_recovered_plan",
            name: "upgrade_acceptance_contract",
            arguments: {
              revision: 2,
              criteriaByTask: [{
                taskId: "task_1",
                acceptanceCriteria: [{
                  id: "preserved",
                  text: "The recovered plan remains inspectable.",
                }],
              }],
            },
          }, request.context);
          assert.equal(
            upgrade.isError,
            false,
            upgrade.error?.message ?? "Recovered plan upgrade failed"
          );
          return;
        }
        assert.deepEqual(request.reason, {
          type: "completion_decision_required",
          runPolicy: "plan_only",
        });
        const result = await request.tools.invoke({
          type: "tool_call",
          callId: "complete_recovered_plan",
          name: "complete_run",
          arguments: { summary: "Recovered plan is ready" },
        }, request.context);
        assert.equal(
          result.isError,
          false,
          result.error?.message ?? "Recovered plan completion failed"
        );
      },
    };
    const runtimeOptions = {
      runId: "run_policy_recovery",
      runPolicy: "plan_only" as const,
      workerDriver: { run: async () => ({ type: "failed" as const, reason: "unused" }) },
      architectDriver,
      integrationDriver: {
        integrate: async () => ({
          status: "integrated" as const,
          integrationRevision: "unused",
        }),
      },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
    };
    let runtime = new BuildRuntime({ ...runtimeOptions, store });
    assert.equal(runtime.projection().runPolicy, "plan_only");
    assert.equal((await runtime.step()).status, "progressed");
    assert.equal((await runtime.step()).status, "paused");
    assert.deepEqual(
      runtime.events().map((event) => event.type),
      [
        "plan.created",
        "run.policy_configured",
        "acceptance_contract.upgrade_required",
        "acceptance_contract.upgraded",
        "project.handoff_requested",
      ]
    );
    store.close();

    store = new SqliteSchedulerStore(database);
    runtime = new BuildRuntime({ ...runtimeOptions, store });
    assert.equal(runtime.projection().projectHandoff?.status, "requested");
    assert.equal(
      runtime.events().filter((event) => event.type === "run.policy_configured").length,
      1
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovered scheduler policy rejects a mismatched runtime policy", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-runtime-policy-mismatch-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    const common = {
      runId: "run_policy_mismatch",
      store,
      workerDriver: { run: async () => ({ type: "failed" as const, reason: "unused" }) },
      architectDriver: { run: async () => undefined },
      integrationDriver: {
        integrate: async () => ({ status: "integrated" as const, integrationRevision: "unused" }),
      },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
    };
    new BuildRuntime({ ...common, runPolicy: "finish" });
    assert.throws(
      () => new BuildRuntime({ ...common, runPolicy: "budgeted" }),
      /already configured as finish/i
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Architect prose or no-op return cannot fabricate scheduler progress", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-runtime-noop-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    const runtime = new BuildRuntime({
      runId: "run_noop",
      store,
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: { run: async () => undefined },
      integrationDriver: {
        integrate: async () => ({ status: "integrated", integrationRevision: "unused" }),
      },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
    });
    await assert.rejects(() => runtime.step(), /without a typed action/i);
    assert.deepEqual(
      store.readRun("run_noop").map((event) => event.type),
      ["run.initialized", "run.policy_configured"]
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh native Builds expose an empty projection and obey durable user pause/resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-runtime-control-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    const runtime = new BuildRuntime({
      runId: "run_control",
      store,
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: { run: async () => undefined },
      integrationDriver: {
        integrate: async () => ({ status: "integrated", integrationRevision: "unused" }),
      },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
      clock: () => "2026-07-12T00:00:00.000Z",
    });
    assert.equal(runtime.projection().planRevision, 0);
    const paused = runtime.pause("user", "pause:1");
    assert.equal(paused.status, "paused");
    assert.deepEqual(paused.pauseReason, { reason: "user" });
    assert.equal((await runtime.step()).status, "paused");
    const resumed = runtime.resume("resume:1");
    assert.equal(resumed.status, "running");
    assert.equal(resumed.pauseReason, undefined);
    assert.deepEqual(
      runtime.events().map((event) => event.type),
      ["run.initialized", "run.policy_configured", "run.paused", "run.resumed"]
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("each explicit paused Resume renews exactly one budget window", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-runtime-budget-resume-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const renewals: string[] = [];
  try {
    const runtime = new BuildRuntime({
      runId: "run_budget_resume",
      runPolicy: "budgeted",
      store,
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: { run: async () => undefined },
      integrationDriver: {
        integrate: async () => ({ status: "integrated", integrationRevision: "unused" }),
      },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
      renewBudgetWindow: (idempotencyKey) => renewals.push(idempotencyKey),
    });
    runtime.pause("budget_exhausted:modelCalls", "pause:budget");
    runtime.resume("resume:budget");
    runtime.resume("resume:duplicate-while-running");
    assert.deepEqual(renewals, ["budget-window:resume:budget"]);

    runtime.pause("user", "pause:user");
    runtime.resume("resume:user");
    assert.deepEqual(renewals, [
      "budget-window:resume:budget",
      "budget-window:resume:user",
    ]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("benchmark continuation resumes without renewing the budget window", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-runtime-budget-continue-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const renewals: string[] = [];
  try {
    const runtime = new BuildRuntime({
      runId: "run_budget_continue",
      store,
      workerDriver: { run: async () => ({ type: "paused", reason: "unused" }) },
      architectDriver: { run: async () => undefined },
      integrationDriver: {
        integrate: async () => ({ status: "integrated", integrationRevision: "unused" }),
      },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
      runPolicy: "budgeted",
      renewBudgetWindow: (idempotencyKey) => renewals.push(idempotencyKey),
    });
    runtime.pause("protocol_error:invalid_lifecycle_batch", "pause:protocol");
    const projection = runtime.continue("continue:protocol");
    assert.equal(projection.status, "running");
    assert.equal(projection.pauseReason, undefined);
    assert.deepEqual(renewals, []);
    assert.throws(
      () => runtime.continue("continue:not-paused"),
      /requires a paused Build/
    );
    assert.equal(runtime.projection().status, "running");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Finish and Plan-only resumes do not create budget windows", () => {
  for (const runPolicy of ["finish", "plan_only"] as const) {
    const root = mkdtempSync(join(tmpdir(), `aiboard-${runPolicy}-resume-`));
    const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
    const renewals: string[] = [];
    try {
      const runtime = new BuildRuntime({
        runId: `run_${runPolicy}`,
        runPolicy,
        store,
        workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
        architectDriver: { run: async () => undefined },
        integrationDriver: {
          integrate: async () => ({ status: "integrated", integrationRevision: "unused" }),
        },
        maxConcurrency: 1,
        workspaceFor: async () => "C:/unused",
        renewBudgetWindow: (idempotencyKey) => renewals.push(idempotencyKey),
      });
      runtime.pause("user", `pause:${runPolicy}`);
      runtime.resume(`resume:${runPolicy}`);
      assert.deepEqual(renewals, []);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("bounded run work yields progress without a durable step-budget pause", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-runtime-yield-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    const runtime = new BuildRuntime({
      runId: "run_yield",
      store,
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: { run: async () => undefined },
      integrationDriver: {
        integrate: async () => ({ status: "integrated", integrationRevision: "unused" }),
      },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
    });
    let steps = 0;
    runtime.step = async () => {
      steps += 1;
      return { status: "progressed", action: `step_${steps}` };
    };
    assert.deepEqual(await runtime.runUntilBlocked(100), {
      status: "progressed",
      action: "step_allowance_yielded",
    });
    assert.equal(steps, 100);
    assert.equal(runtime.events().some((event) => event.payload.reason === "build_step_budget"), false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an idempotently repeated worker pause remains paused instead of becoming idle", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-runtime-repeat-pause-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    store.append({
      runId: "run_repeat_pause",
      type: "plan.created",
      occurredAt: "2026-07-12T00:00:00.000Z",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "plan:1",
      payload: {
        revision: 1,
        tasks: [{
          id: "task_a",
          objective: "Do work",
          dependencies: [],
          status: "running",
          requiredCapabilities: ["code"],
          acceptanceCriteria: [{ id: "work", text: "The work is completed." }],
          attempt: 1,
          assignedWorkerId: "worker_task_a_1",
          workspacePath: "C:/work/task_a",
        }],
      },
    });
    const runtime = new BuildRuntime({
      runId: "run_repeat_pause",
      store,
      workerDriver: { run: async () => ({ type: "paused", reason: "blocked" }) },
      architectDriver: { run: async () => undefined },
      integrationDriver: {
        integrate: async () => ({ status: "integrated", integrationRevision: "unused" }),
      },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/work/task_a",
      clock: () => "2026-07-12T00:00:00.000Z",
    });
    await runtime.step();
    runtime.resume("resume:repeat");
    assert.equal((await runtime.step()).status, "paused");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("exhausted failed tasks return to the Architect for revision instead of deadlocking", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-runtime-exhausted-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    store.append({
      runId: "run_exhausted",
      type: "plan.created",
      occurredAt: "2026-07-12T00:00:00.000Z",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "plan:1",
      payload: {
        revision: 1,
        tasks: [{
          id: "task_a",
          objective: "Original approach",
          dependencies: [],
          status: "failed",
          requiredCapabilities: ["code"],
          acceptanceCriteria: [{ id: "work", text: "The revised approach is used." }],
          attempt: 2,
          failureReason: "model_ended_without_lifecycle",
        }],
      },
    });
    let reasonSeen: ArchitectActionRequest["reason"] | undefined;
    const runtime = new BuildRuntime({
      runId: "run_exhausted",
      store,
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: {
        run: async (request) => {
          reasonSeen = request.reason;
          const result = await request.tools.invoke({
            type: "tool_call",
            callId: "revise_failed_task",
            name: "revise_task",
            arguments: {
              taskId: "task_a",
              revision: 2,
              objective: "Use a revised approach",
            },
          }, request.context);
          assert.equal(result.isError, false, result.error?.message ?? "revision failed");
        },
      },
      integrationDriver: {
        integrate: async () => ({ status: "integrated", integrationRevision: "unused" }),
      },
      maxConcurrency: 1,
      maxTaskAttempts: 2,
      workspaceFor: async () => "C:/work/task_a",
    });

    const step = await runtime.step();
    assert.equal(step.status, "progressed");
    assert.equal(reasonSeen?.type, "task_failure_resolution_required");
    assert.equal(runtime.projection().tasks.task_a.status, "planned");
    assert.equal(runtime.projection().tasks.task_a.attemptLimit, 3);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("exhausted rejected tasks return to the Architect instead of pausing in planned state", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-runtime-rejected-exhausted-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    store.append({
      runId: "run_rejected_exhausted",
      type: "plan.created",
      occurredAt: "2026-07-12T00:00:00.000Z",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "plan:1",
      payload: {
        revision: 1,
        tasks: [{
          id: "task_browser",
          objective: "Collect browser acceptance evidence",
          dependencies: [],
          status: "rejected",
          requiredCapabilities: ["browser-acceptance"],
          acceptanceCriteria: [{ id: "evidence", text: "Acceptance evidence is collected." }],
          attempt: 2,
        }],
      },
    });
    let reasonSeen: ArchitectActionRequest["reason"] | undefined;
    const runtime = new BuildRuntime({
      runId: "run_rejected_exhausted",
      store,
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: {
        run: async (request) => {
          reasonSeen = request.reason;
          const result = await request.tools.invoke({
            type: "tool_call",
            callId: "revise_rejected_task",
            name: "revise_task",
            arguments: {
              taskId: "task_browser",
              revision: 2,
              objective: "Collect durable browser acceptance facts",
            },
          }, request.context);
          assert.equal(result.isError, false, result.error?.message ?? "revision failed");
        },
      },
      integrationDriver: {
        integrate: async () => ({ status: "integrated", integrationRevision: "unused" }),
      },
      maxConcurrency: 1,
      maxTaskAttempts: 2,
      workspaceFor: async () => "C:/work/task_browser",
    });

    const step = await runtime.step();
    assert.equal(step.status, "progressed");
    assert.deepEqual(reasonSeen, {
      type: "task_failure_resolution_required",
      taskId: "task_browser",
      attempt: 2,
      failureReason: "architect_rejected_attempt_budget_exhausted",
    });
    assert.equal(runtime.projection().tasks.task_browser.status, "planned");
    assert.equal(runtime.projection().tasks.task_browser.attemptLimit, 3);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy exhausted planned checkpoints recover through Architect revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-runtime-planned-exhausted-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    store.append({
      runId: "run_planned_exhausted",
      type: "plan.created",
      occurredAt: "2026-07-12T00:00:00.000Z",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "plan:1",
      payload: {
        revision: 1,
        tasks: [{
          id: "task_browser",
          objective: "Collect browser acceptance evidence",
          dependencies: [],
          status: "planned",
          requiredCapabilities: ["browser-acceptance"],
          acceptanceCriteria: [{ id: "evidence", text: "Acceptance evidence is collected." }],
          attempt: 2,
        }],
      },
    });
    let reasonSeen: ArchitectActionRequest["reason"] | undefined;
    const runtime = new BuildRuntime({
      runId: "run_planned_exhausted",
      store,
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: {
        run: async (request) => {
          reasonSeen = request.reason;
          const result = await request.tools.invoke({
            type: "tool_call",
            callId: "revise_legacy_task",
            name: "revise_task",
            arguments: {
              taskId: "task_browser",
              revision: 2,
              objective: "Collect durable browser acceptance facts",
            },
          }, request.context);
          assert.equal(result.isError, false, result.error?.message ?? "revision failed");
        },
      },
      integrationDriver: {
        integrate: async () => ({ status: "integrated", integrationRevision: "unused" }),
      },
      maxConcurrency: 1,
      maxTaskAttempts: 2,
      workspaceFor: async () => "C:/work/task_browser",
    });

    const step = await runtime.step();
    assert.equal(step.status, "progressed");
    assert.deepEqual(reasonSeen, {
      type: "task_failure_resolution_required",
      taskId: "task_browser",
      attempt: 2,
      failureReason: "task_attempt_budget_exhausted",
    });
    assert.equal(runtime.projection().tasks.task_browser.attemptLimit, 3);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("exhausted stale tasks can be cancelled and rewired without a third worker attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-runtime-reconcile-exhausted-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  let workerCalls = 0;
  try {
    store.append({
      runId: "run_reconcile_exhausted",
      type: "plan.created",
      occurredAt: "2026-07-12T00:00:00.000Z",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "plan:1",
      payload: {
        revision: 1,
        tasks: [
          {
            id: "task_a",
            objective: "Inspect the baseline",
            dependencies: [],
            status: "integrated",
            requiredCapabilities: ["code"],
            acceptanceCriteria: [{ id: "baseline", text: "The baseline is inspected." }],
            attempt: 1,
          },
          {
            id: "task_b",
            objective: "Obsolete change disproved by inspection",
            dependencies: ["task_a"],
            status: "planned",
            requiredCapabilities: ["code"],
            acceptanceCriteria: [{ id: "stale", text: "The stale change is not required." }],
            attempt: 2,
          },
          {
            id: "task_c",
            objective: "Continue useful implementation",
            dependencies: ["task_b"],
            status: "planned",
            requiredCapabilities: ["code"],
            acceptanceCriteria: [{ id: "successor", text: "The useful implementation continues." }],
            attempt: 0,
          },
        ],
      },
    });
    const runtime = new BuildRuntime({
      runId: "run_reconcile_exhausted",
      store,
      workerDriver: {
        run: async () => {
          workerCalls += 1;
          return { type: "failed", reason: "worker must not receive stale task" };
        },
      },
      architectDriver: {
        run: async (request) => {
          assert.equal(request.reason.type, "task_failure_resolution_required");
          assert.equal(
            request.tools.definitions().some((tool) => tool.name === "reconcile_plan"),
            true
          );
          const result = await request.tools.invoke({
            type: "tool_call",
            callId: "reconcile_stale_plan",
            name: "reconcile_plan",
            arguments: {
              revision: 2,
              summary: "Inspection proved task_b was already satisfied.",
              taskUpdates: [
                { taskId: "task_b", action: "cancel" },
                { taskId: "task_c", action: "revise", dependencies: ["task_a"] },
              ],
            },
          }, request.context);
          assert.equal(result.isError, false, result.error?.message ?? "reconciliation failed");
        },
      },
      integrationDriver: {
        integrate: async () => ({ status: "integrated", integrationRevision: "unused" }),
      },
      maxConcurrency: 1,
      maxTaskAttempts: 2,
      workspaceFor: async () => "C:/work/unused",
    });

    const step = await runtime.step();
    assert.equal(step.status, "progressed");
    assert.equal(workerCalls, 0);
    assert.equal(runtime.projection().tasks.task_b.status, "cancelled");
    assert.equal(runtime.projection().tasks.task_c.status, "planned");
    assert.deepEqual(runtime.projection().tasks.task_c.dependencies, ["task_a"]);
    assert.equal(runtime.projection().planRevision, 2);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

class ScriptedWorkers implements WorkerRuntimeDriver {
  readonly callsByTask: Record<string, number> = { task_a: 0, task_b: 0 };
  providerFailures = 0;

  constructor(
    private readonly router: RuntimeRouter,
    private readonly evidenceByTask: ReadonlyMap<string, string>
  ) {}

  async run(assignment: WorkerAssignment): Promise<WorkerOutcome> {
    this.callsByTask[assignment.task.id] += 1;
    if (assignment.task.id === "task_a") {
      const selected = this.router.selectWorker(assignment.task.requiredCapabilities);
      assert.equal(selected.status, "assigned");
      const routed = this.router.routeWorkerFailure({
        currentRuntimeId: selected.runtime.runtimeId,
        requiredCapabilities: assignment.task.requiredCapabilities,
        failure: { kind: "provider_unavailable", message: "primary failed" },
        handoff: {
          runId: assignment.runId,
          taskId: assignment.task.id,
          sessionId: `${assignment.task.id}:${assignment.attempt}`,
          attempt: assignment.attempt,
          checkpointArtifactHash: "a".repeat(64),
          workspacePath: assignment.workspacePath,
        },
      });
      assert.equal(routed.status, "assigned");
      assert.equal(routed.runtime.runtimeId, "fallback:code");
      this.providerFailures += 1;
      return this.submitted("task_a", "changeset_a", assignment.attempt);
    }
    if (this.callsByTask.task_b === 1) {
      return {
        type: "guidance",
        requestId: "guidance_b",
        blocking: true,
        question: "Choose the public API name",
        evidenceSequence: 7,
      };
    }
    return this.submitted("task_b", "changeset_b", assignment.attempt);
  }

  private submitted(
    taskId: string,
    changeSetId: string,
    attempt: number
  ): WorkerOutcome {
    return {
      type: "submitted",
      changeSetId,
      criterionEvidenceLinks: [{
        criterionId: taskId === "task_a" ? "a" : "b",
        evidenceId: this.evidenceByTask.get(taskId) ?? "missing-evidence",
        artifactHashes: ["e".repeat(64)],
        taskId,
        attempt,
      }],
    };
  }
}

class ScriptedArchitect implements ArchitectRuntimeDriver {
  planCalls = 0;
  completeCalls = 0;
  private callSequence = 0;

  async run(request: ArchitectActionRequest): Promise<void> {
    if (request.reason.type === "plan_required") {
      this.planCalls += 1;
      await this.invoke(request, "plan_tasks", {
        revision: 1,
        tasks: [
          {
            id: "task_a",
            objective: "Implement A",
            dependencies: [],
            requiredCapabilities: ["code"],
            acceptanceCriteria: [{ id: "a", text: "Task A is implemented." }],
          },
          {
            id: "task_b",
            objective: "Implement B",
            dependencies: [],
            requiredCapabilities: ["code"],
            acceptanceCriteria: [{ id: "b", text: "Task B is implemented." }],
          },
        ],
      });
      return;
    }
    if (request.reason.type === "guidance_required") {
      const guidance = request.projection.guidance[request.reason.requestId];
      await this.invoke(request, "answer_guidance", {
        requestId: guidance.requestId,
        expectedVersion: guidance.version,
        answer: "Use the stable public name.",
      });
      return;
    }
    if (request.reason.type === "review_required") {
      const task = request.projection.tasks[request.reason.taskId];
      const links = task.criterionEvidenceLinks ?? [];
      await this.invoke(request, "review_task", {
        taskId: request.reason.taskId,
        decision: "approved",
        summary: "Task intent is satisfied.",
        evidenceArtifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
        criterionVerdicts: (task.acceptanceCriteria ?? []).map((criterion) => {
          const link = links.find((candidate) => candidate.criterionId === criterion.id);
          return {
            criterionId: criterion.id,
            verdict: "satisfied",
            rationale: "The worker evidence supports this criterion.",
            evidenceIds: link ? [link.evidenceId] : [],
            artifactHashes: link?.artifactHashes,
          };
        }),
      });
      return;
    }
    if (request.reason.type === "integration_approval_required") {
      await this.invoke(request, "request_integration", {
        taskId: request.reason.taskId,
      });
      return;
    }
    if (request.reason.type === "final_verification_plan_required") {
      await this.invoke(request, "plan_final_verification", {
        plan: {
          checks: ["build", "tests", "runtime_smoke", "browser"].map((category) => ({
            category,
            status: "not_applicable",
            rationale: `No ${category} fixture is configured.`,
            repositoryInspection: {
              paths: ["package.json"],
              summary: `No ${category} fixture is configured.`,
            },
          })),
        },
      });
      return;
    }
    if (request.reason.type === "completion_decision_required") {
      this.completeCalls += 1;
      await this.invoke(request, "complete_run", {
        summary: "All intended work is accepted.",
      });
      return;
    }
    throw new Error(`Unexpected Architect reason ${request.reason.type}`);
  }

  private async invoke(
    request: ArchitectActionRequest,
    name: string,
    argumentsValue: unknown
  ): Promise<void> {
    this.callSequence += 1;
    const call: ToolCallBlock = {
      type: "tool_call",
      callId: `architect_${this.callSequence}`,
      name,
      arguments: argumentsValue,
    };
    const result = await request.tools.invoke(call, request.context);
    assert.equal(result.isError, false, result.error?.message ?? "Architect tool failed");
  }
}

class ScriptedIntegration implements IntegrationRuntimeDriver {
  readonly calls: string[] = [];
  async integrate(input: { taskId: string; changeSetId: string }) {
    this.calls.push(input.taskId);
    return {
      status: "integrated" as const,
      integrationRevision: `revision_${input.taskId}`,
    };
  }
}
