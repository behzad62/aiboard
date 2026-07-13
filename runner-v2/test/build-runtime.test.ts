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
import {
  TaskScheduler,
  type WorkerAssignment,
  type WorkerOutcome,
  type WorkerRuntimeDriver,
} from "../src/task-scheduler.js";

test("build runtime plans, guides, reviews, integrates, and completes across restarts", async () => {
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
  const workers = new ScriptedWorkers(router);
  const architect = new ScriptedArchitect();
  const integration = new ScriptedIntegration();
  try {
    for (let restart = 0; restart < 20; restart += 1) {
      const store = new SqliteSchedulerStore(database);
      const runtime = new BuildRuntime({
        runId: "run_1",
        store,
        workerDriver: workers,
        architectDriver: architect,
        integrationDriver: integration,
        maxConcurrency: 2,
        workspaceFor: async (task) => `C:/work/${task.id}`,
        clock: () => "2026-07-12T00:00:00.000Z",
      });
      const step = await runtime.step();
      const projection = runtime.projection();
      store.close();
      if (projection.projectHandoff?.status === "requested") {
        assert.equal(step.status, "paused");
        break;
      }
    }

    const recoveredStore = new SqliteSchedulerStore(database);
    const recovered = new BuildRuntime({
      runId: "run_1",
      store: recoveredStore,
      workerDriver: workers,
      architectDriver: architect,
      integrationDriver: integration,
      maxConcurrency: 2,
      workspaceFor: async (task) => `C:/work/${task.id}`,
    });
    const projection = recovered.projection();
    assert.equal(projection.status, "paused");
    assert.equal(projection.projectHandoff?.status, "requested");
    assert.deepEqual(
      Object.values(projection.tasks).map((task) => task.status),
      ["integrated", "integrated"]
    );
    assert.equal(workers.providerFailures, 1);
    assert.equal(workers.callsByTask.task_a, 1, "provider failover stays inside one attempt");
    assert.equal(workers.callsByTask.task_b, 2, "blocking guidance resumes the same attempt");
    assert.deepEqual(integration.calls.sort(), ["task_a", "task_b"]);
    assert.equal(new Set(integration.calls).size, integration.calls.length);
    assert.equal(architect.planCalls, 1);
    assert.equal(architect.completeCalls, 1);
    const selected = recovered.selectProjectHandoff(
      "keep_integration_branch",
      {
        integrationRevision: "revision_task_b",
        integrationBranch: "aiboard/integration/run_1",
        appliedToProject: false,
      },
      "handoff:keep"
    );
    assert.equal(selected.status, "completed");
    assert.equal(selected.projectHandoff?.choice, "keep_integration_branch");
    recoveredStore.close();
  } finally {
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
            await invoke("plan_tasks", {
              revision: 1,
              tasks: [
                {
                  id: "task_a",
                  objective: "Draft the public API",
                  dependencies: [],
                  requiredCapabilities: ["code"],
                },
                {
                  id: "task_b",
                  objective: "Document the public API",
                  dependencies: ["task_a"],
                  requiredCapabilities: ["code"],
                },
              ],
            });
            return;
          }
          assert.deepEqual(request.reason, {
            type: "completion_decision_required",
            runPolicy: "plan_only",
          });
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
    assert.equal(store.readRun("run_noop").length, 0);
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
    assert.equal(runtime.pause("user", "pause:1").status, "paused");
    assert.equal((await runtime.step()).status, "paused");
    assert.equal(runtime.resume("resume:1").status, "running");
    assert.deepEqual(
      runtime.events().map((event) => event.type),
      ["run.initialized", "run.paused", "run.resumed"]
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

class ScriptedWorkers implements WorkerRuntimeDriver {
  readonly callsByTask: Record<string, number> = { task_a: 0, task_b: 0 };
  providerFailures = 0;

  constructor(private readonly router: RuntimeRouter) {}

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
      return { type: "submitted", changeSetId: "changeset_a" };
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
    return { type: "submitted", changeSetId: "changeset_b" };
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
          },
          {
            id: "task_b",
            objective: "Implement B",
            dependencies: [],
            requiredCapabilities: ["code"],
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
      await this.invoke(request, "review_task", {
        taskId: request.reason.taskId,
        decision: "approved",
        summary: "Task intent is satisfied.",
        evidenceArtifactHashes: [],
      });
      return;
    }
    if (request.reason.type === "integration_approval_required") {
      await this.invoke(request, "request_integration", {
        taskId: request.reason.taskId,
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
