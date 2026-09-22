import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolCallBlock } from "../src/agent-contracts.js";
import {
  BuildRuntime,
  type ArchitectActionReason,
  type ArchitectRuntimeDriver,
  type IndependentVerifierDriver,
  type PlanCriticDriver,
  type PlanCriticResult,
} from "../src/build-runtime.js";
import type { PlanCritiqueFinding } from "../src/plan-critique-contracts.js";
import { SchedulerPlanCritiqueAuthority } from "../src/plan-critique-authority.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import type { BuildTask } from "../src/task-contracts.js";

const RUN_ID = "run-plan-critique-runtime";
const CLOCK = () => "2026-09-02T00:00:00.000Z";
const CRITIC_RUNTIME_IDS = ["google:verifier", "fallback:verifier"] as const;

test("mode off never calls the critic and dispatches workers", async () => {
  await withRuntime({
    critic: { mode: "off" },
    taskCount: 3,
  }, async ({ runtime, critic, worker }) => {
    const planned = await runtime.step();
    assert.equal(planned.action, "plan_required");
    const workers = await runtime.step();
    assert.equal(workers.action, "workers_advanced");
    assert.equal(critic.calls, 0);
    assert.equal(runtime.projection().planCritique?.policy?.mode, "off");
    assert.equal(runtime.projection().planCritique?.risk, undefined);
    assert.equal(worker.calls.length > 0, true);
  });
});

test("low plan risk is skipped durably before workers start", async () => {
  await withRuntime({
    critic: { mode: "risk_based" },
    taskCount: 3,
  }, async ({ runtime, critic, worker }) => {
    assert.equal((await runtime.step()).action, "plan_required");
    assert.equal((await runtime.step()).action, "plan_risk_assessed");
    assert.equal((await runtime.step()).action, "plan_critique_skipped");
    assert.equal(runtime.projection().planCritique?.skipped?.reason, "low_plan_risk");
    assert.equal(critic.calls, 0);
    assert.equal(worker.calls.length, 0);
    assert.equal((await runtime.step()).action, "workers_advanced");
    assert.equal(critic.calls, 0);
    assert.equal(worker.calls.length > 0, true);
  });
});

test("high plan risk runs the critic once and auto-resolves an advisory-only critique", async () => {
  await withRuntime({
    critic: { mode: "risk_based", findings: [advisoryFinding()] },
    taskCount: 5,
  }, async ({ runtime, critic, worker, store }) => {
    assert.equal((await runtime.step()).action, "plan_required");
    assert.equal((await runtime.step()).action, "plan_risk_assessed");
    assert.equal((await runtime.step()).action, "plan_critique_submitted");
    assert.equal(critic.calls, 1);
    assert.equal(worker.calls.length, 0);
    assert.equal((await runtime.step()).action, "plan_critique_resolved_by_runner");
    const resolvedEvent = store.readRun(RUN_ID).find((event) => event.type === "plan_critique.resolved");
    assert.ok(resolvedEvent);
    assert.equal(resolvedEvent.actor.role, "runner");
    assert.equal((await runtime.step()).action, "workers_advanced");
    assert.equal(critic.calls, 1);
    assert.equal(worker.calls.length > 0, true);
    assert.equal(worker.calls.every((call) => call.sequence > resolvedEvent.sequence), true);
  });
});

test("blocking findings route to exactly one Architect resolution before any worker", async () => {
  await withRuntime({
    critic: { mode: "risk_based", findings: [blockingFinding()] },
    taskCount: 5,
  }, async ({ runtime, critic, worker, architect }) => {
    const tickOrder = instrumentSchedulerTick(runtime);
    assert.equal((await runtime.step()).action, "plan_required");
    assert.equal((await runtime.step()).action, "plan_risk_assessed");
    assert.equal((await runtime.step()).action, "plan_critique_submitted");
    assert.equal(worker.calls.length, 0);
    const resolved = await runtime.step();
    assert.equal(resolved.action, "plan_critique_resolution_required");
    assert.equal(architect.critiqueReasons.length, 1);
    assert.deepEqual(architect.critiqueReasons[0], {
      type: "plan_critique_resolution_required",
      critiqueId: "critique-1",
      planRevision: 1,
      blockingFindingIds: ["F-1"],
    });
    assert.equal(architect.sawResolveTool, true);
    assert.equal(runtime.projection().planCritique?.current?.status, "resolved");
    assert.equal(runtime.projection().planRevision, 2);
    assert.equal(runtime.projection().tasks.B.status, "cancelled");
    assert.equal(critic.calls, 1);
    assert.equal(worker.calls.length, 0);
    assert.equal(tickOrder.ticksWhilePending, 0, "scheduler.tick must wait until the critique is resolved");
    assert.equal((await runtime.step()).action, "workers_advanced");
    assert.equal(architect.critiqueReasons.length, 1);
    assert.equal(critic.calls, 1);
    assert.equal(worker.calls.length > 0, true);
  });
});

test("an unavailable critic pauses for verifier selection", async () => {
  await withRuntime({
    critic: { mode: "risk_based", result: "unavailable" },
    taskCount: 5,
  }, async ({ runtime, critic }) => {
    assert.equal((await runtime.step()).action, "plan_required");
    assert.equal((await runtime.step()).action, "plan_risk_assessed");
    const paused = await runtime.step();
    assert.equal(paused.status, "paused");
    assert.equal(paused.action, "verifier_selection_required");
    assert.equal(runtime.projection().verifierSelection?.reason, "plan_critique_no_independent_runtime");
    runtime.selectVerifierRuntime("fallback:verifier", "select:1");
    assert.equal((await runtime.step()).action, "plan_critique_submitted");
    assert.equal(critic.preferredRuntimeIds.at(-1), "fallback:verifier");
  });
});

test("three provider failures on a non-strict run end in a durable critic_failed skip; a strict run pauses instead", async () => {
  await withRuntime({
    critic: { mode: "risk_based", result: "provider_error" },
    taskCount: 5,
  }, async ({ runtime, critic, worker }) => {
    assert.equal((await runtime.step()).action, "plan_required");
    assert.equal((await runtime.step()).action, "plan_risk_assessed");
    assert.equal((await runtime.step()).action, "plan_critic_provider_failed");
    assert.equal((await runtime.step()).action, "plan_critic_provider_failed");
    assert.equal((await runtime.step()).action, "plan_critique_skipped");
    assert.equal(runtime.projection().planCritique?.skipped?.reason, "critic_failed");
    assert.equal(critic.calls, 3);
    assert.equal((await runtime.step()).action, "workers_advanced");
    assert.equal(worker.calls.length > 0, true);
  });

  await withRuntime({
    critic: { mode: "risk_based", result: "provider_error", stricterQualification: true },
    taskCount: 5,
  }, async ({ runtime, critic, worker }) => {
    assert.equal((await runtime.step()).action, "plan_required");
    assert.equal((await runtime.step()).action, "plan_risk_assessed");
    assert.equal((await runtime.step()).action, "plan_critic_provider_failed");
    assert.equal((await runtime.step()).action, "plan_critic_provider_failed");
    const paused = await runtime.step();
    assert.equal(paused.status, "paused");
    assert.equal(paused.action, "verifier_selection_required");
    assert.equal(runtime.projection().planCritique?.skipped, undefined);
    assert.equal(critic.calls, 3);
    assert.equal(worker.calls.length, 0);
  });
});

test("plan critic candidate runtime IDs must be unique and equal the verifier policy candidates", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-plan-critique-candidates-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const base = {
    runId: RUN_ID,
    store,
    workerDriver: new ScriptedWorker(store),
    architectDriver: new ScriptedArchitect(1),
    integrationDriver: {
      integrate: async () => ({ status: "integrated" as const, integrationRevision: "unused" }),
    },
    independentVerifier: stubVerifier(false),
    runPolicy: "finish" as const,
    maxConcurrency: 1,
    workspaceFor: async (task: BuildTask) => `C:/work/${task.id}`,
    clock: CLOCK,
  };
  const critic = (candidateRuntimeIds: string[]): PlanCriticDriver => ({
    candidateRuntimeIds,
    mode: "risk_based",
    stricterQualification: false,
    architectDeclaration: () => "low",
    critique: async () => ({ status: "unavailable", reason: "runtime_unavailable" }),
  });
  try {
    assert.throws(
      () => new BuildRuntime({ ...base, planCritic: critic([]) }),
      /Plan critic requires unique non-empty candidate runtime IDs/,
    );
    assert.throws(
      () => new BuildRuntime({ ...base, planCritic: critic(["other:verifier"]) }),
      /Plan critic candidate runtime IDs must equal the verifier policy candidates/,
    );
    assert.throws(
      () => new BuildRuntime({
        ...base,
        planCritic: critic(["fallback:verifier", "google:verifier"]),
      }),
      /Plan critic candidate runtime IDs must equal the verifier policy candidates/,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan_only runs skip the critique with reason plan_only", async () => {
  await withRuntime({
    critic: { mode: "risk_based" },
    taskCount: 5,
    runPolicy: "plan_only",
  }, async ({ runtime, critic, worker }) => {
    assert.equal((await runtime.step()).action, "plan_required");
    assert.equal((await runtime.step()).action, "plan_critique_skipped");
    assert.equal(runtime.projection().planCritique?.skipped?.reason, "plan_only");
    assert.equal(critic.calls, 0);
    assert.equal(worker.calls.length, 0);
  });
});

async function withRuntime(
  options: {
    critic: {
      mode: PlanCriticDriver["mode"];
      findings?: PlanCritiqueFinding[];
      result?: "unavailable" | "provider_error";
      stricterQualification?: boolean;
    };
    taskCount: number;
    runPolicy?: "finish" | "plan_only";
  },
  run: (input: {
    runtime: BuildRuntime;
    store: SqliteSchedulerStore;
    critic: ScriptedPlanCritic;
    worker: ScriptedWorker;
    architect: ScriptedArchitect;
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "aiboard-plan-critique-runtime-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const worker = new ScriptedWorker(store);
  const architect = new ScriptedArchitect(options.taskCount);
  const critic = new ScriptedPlanCritic(store, options.critic);
  const independentVerifier = stubVerifier(options.critic.stricterQualification === true);
  try {
    const runtime = new BuildRuntime({
      runId: RUN_ID,
      store,
      workerDriver: worker,
      architectDriver: architect,
      integrationDriver: {
        integrate: async () => ({ status: "integrated", integrationRevision: "unused" }),
      },
      independentVerifier,
      planCritic: critic,
      runPolicy: options.runPolicy ?? "finish",
      maxConcurrency: 1,
      workspaceFor: async (task) => `C:/work/${task.id}`,
      clock: CLOCK,
    });
    await run({ runtime, store, critic, worker, architect });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function instrumentSchedulerTick(runtime: BuildRuntime): { ticksWhilePending: number } {
  const host = runtime as unknown as {
    scheduler: { tick: () => Promise<void> };
  };
  const original = host.scheduler.tick.bind(host.scheduler);
  const state = { ticksWhilePending: 0 };
  host.scheduler.tick = async () => {
    const critique = runtime.projection().planCritique;
    if (
      critique?.policy &&
      critique.policy.mode !== "off" &&
      !critique.skipped &&
      critique.current?.status !== "resolved"
    ) {
      state.ticksWhilePending += 1;
    }
    return original();
  };
  return state;
}

class ScriptedWorker {
  readonly calls: Array<{ taskId: string; sequence: number }> = [];
  constructor(private readonly store: SqliteSchedulerStore) {}
  async run(assignment: { task: BuildTask }): Promise<{ type: "failed"; reason: string }> {
    const sequence = this.store.readRun(RUN_ID).at(-1)?.sequence ?? 0;
    this.calls.push({ taskId: assignment.task.id, sequence });
    return { type: "failed", reason: "unused" };
  }
}

class ScriptedArchitect implements ArchitectRuntimeDriver {
  readonly critiqueReasons: ArchitectActionReason[] = [];
  sawResolveTool = false;
  constructor(private readonly taskCount: number) {}
  async run(request: Parameters<ArchitectRuntimeDriver["run"]>[0]): Promise<void> {
    if (request.reason.type === "plan_required") {
      const result = await request.tools.invoke(call("plan_tasks", {
        revision: 1,
        tasks: planTasks(this.taskCount),
        riskDeclaration: { risk: "low", rationale: "routine" },
      }), request.context);
      assert.equal(result.isError, false, result.error?.message ?? "plan_tasks failed");
      return;
    }
    if (request.reason.type === "plan_critique_resolution_required") {
      this.critiqueReasons.push(request.reason);
      this.sawResolveTool = request.tools.definitions().some((tool) => tool.name === "resolve_plan_critique");
      const result = await request.tools.invoke(call("resolve_plan_critique", {
        critiqueId: request.reason.critiqueId,
        planRevision: request.reason.planRevision,
        resolutions: [{
          findingId: "F-1",
          resolution: "plan_reconciled",
          rationale: "B is folded into A.",
        }],
        planReconciliation: {
          revision: 2,
          summary: "Fold B into A.",
          taskUpdates: [
            { taskId: "B", action: "cancel" },
            { taskId: "E", action: "revise", dependencies: ["A"] },
          ],
        },
      }), request.context);
      assert.equal(result.isError, false, result.error?.message ?? "resolve_plan_critique failed");
      return;
    }
    if (request.reason.type === "completion_decision_required") {
      const result = await request.tools.invoke(call("complete_run", {
        summary: "Plan only complete.",
      }), request.context);
      assert.equal(result.isError, false, result.error?.message ?? "complete_run failed");
      return;
    }
    assert.fail(`unexpected Architect reason ${request.reason.type}`);
  }
}

class ScriptedPlanCritic implements PlanCriticDriver {
  calls = 0;
  preferredRuntimeIds: Array<string | undefined> = [];
  readonly candidateRuntimeIds = [...CRITIC_RUNTIME_IDS];
  readonly mode: PlanCriticDriver["mode"];
  readonly stricterQualification: boolean;
  private readonly authority: SchedulerPlanCritiqueAuthority;
  private readonly findings: PlanCritiqueFinding[];
  private readonly result?: "unavailable" | "provider_error";
  constructor(
    store: SqliteSchedulerStore,
    options: {
      mode: PlanCriticDriver["mode"];
      findings?: PlanCritiqueFinding[];
      result?: "unavailable" | "provider_error";
      stricterQualification?: boolean;
    },
  ) {
    this.mode = options.mode;
    this.stricterQualification = options.stricterQualification === true;
    this.findings = options.findings ?? [];
    this.result = options.result;
    this.authority = new SchedulerPlanCritiqueAuthority(store);
  }
  architectDeclaration(projection: { planRiskDeclaration?: { risk: "low" | "high" } }): "low" | "high" {
    return projection.planRiskDeclaration?.risk ?? "low";
  }
  async critique(input: {
    runId: string;
    projection: { planRevision: number };
    preferredRuntimeId?: string;
  }): Promise<PlanCriticResult> {
    this.calls += 1;
    this.preferredRuntimeIds.push(input.preferredRuntimeId);
    if (this.result === "unavailable") {
      if (input.preferredRuntimeId === "fallback:verifier") {
        return await this.submit(input);
      }
      return { status: "unavailable", reason: "no_independent_healthy_capability_match" };
    }
    if (this.result === "provider_error") {
      await this.request(input);
      return { status: "suspended", reason: "provider_error" };
    }
    return await this.submit(input);
  }
  private async submit(input: {
    runId: string;
    projection: { planRevision: number };
  }): Promise<PlanCriticResult> {
    const requested = this.request(input);
    this.authority.submitFindings({
      runId: input.runId,
      critiqueId: requested.critiqueId,
      planRevision: input.projection.planRevision,
      sessionId: requested.runtime.sessionId,
      actor: { role: "verifier", id: requested.runtime.runtimeId },
      findings: this.findings,
      occurredAt: CLOCK(),
    });
    return { status: "submitted", critiqueId: requested.critiqueId };
  }
  private request(input: {
    runId: string;
    projection: { planRevision: number };
  }) {
    const critiqueId = `critique-${this.calls}`;
    const runtime = {
      runtimeId: inputPreferredOrDefault(this.preferredRuntimeIds.at(-1)),
      providerId: "google",
      modelId: "verifier",
      modelIdentity: "verifier",
      sessionId: `plan-critic:s${this.calls}`,
    };
    return this.authority.requestCritique({
      runId: input.runId,
      critiqueId,
      planRevision: input.projection.planRevision,
      runtime,
      excludedModels: [{
        source: "architect",
        runtimeId: "openai:architect",
        modelIdentity: "architect",
      }],
      occurredAt: CLOCK(),
    });
  }
}

function inputPreferredOrDefault(preferred?: string): string {
  return preferred && CRITIC_RUNTIME_IDS.includes(preferred as typeof CRITIC_RUNTIME_IDS[number])
    ? preferred
    : "google:verifier";
}

function stubVerifier(alwaysRequireIndependentVerifier: boolean): IndependentVerifierDriver {
  return {
    candidateRuntimeIds: [...CRITIC_RUNTIME_IDS],
    alwaysRequireIndependentVerifier,
    assessRisk: async () => {
      throw new Error("independent verifier must not run during plan critique tests");
    },
    verify: async () => {
      throw new Error("independent verifier must not run during plan critique tests");
    },
  };
}

function planTasks(count: number) {
  const ids = ["A", "B", "C", "D", "E"];
  return ids.slice(0, count).map((id) => ({
    id,
    objective: id === "B" ? "Own src/cache.ts as well." : `Do ${id}`,
    dependencies: id === "E" ? ["A", "B"] : [],
    requiredCapabilities: ["code"],
    acceptanceCriteria: [{ id: "AC-1", text: `${id} works.` }],
  }));
}

function blockingFinding(): PlanCritiqueFinding {
  return {
    findingId: "F-1",
    severity: "blocking",
    category: "overlapping_scope",
    taskIds: ["A", "B"],
    claim: "A and B both own src/cache.ts.",
    evidence: ["A objective mentions src/cache.ts", "B objective mentions src/cache.ts"],
  };
}

function advisoryFinding(): PlanCritiqueFinding {
  return {
    findingId: "F-2",
    severity: "advisory",
    category: "missing_failure_mode",
    taskIds: ["E"],
    claim: "E ignores empty input.",
    evidence: ["E criteria never mention empty input"],
  };
}

function call(name: string, argumentsValue: unknown): ToolCallBlock {
  return { type: "tool_call", callId: `${name}:call`, name, arguments: argumentsValue };
}
