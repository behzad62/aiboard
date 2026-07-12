import type {
  AgentToolRuntime,
} from "./tool-registry.js";
import type { ToolExecutionContext } from "./agent-contracts.js";
import { createArchitectTools } from "./architect-tools.js";
import type {
  ProjectHandoffChoice,
  SchedulerProjection,
  SchedulerStore,
} from "./scheduler-store.js";
import { rebuildSchedulerProjection } from "./scheduler-store.js";
import type { BuildTask } from "./task-contracts.js";
import {
  TaskScheduler,
  type WorkerRuntimeDriver,
} from "./task-scheduler.js";
import { ToolRegistry } from "./tool-registry.js";

export type ArchitectActionReason =
  | { type: "plan_required" }
  | { type: "guidance_required"; requestId: string; taskId: string }
  | { type: "review_required"; taskId: string; changeSetId: string }
  | { type: "integration_approval_required"; taskId: string; changeSetId: string }
  | { type: "completion_decision_required" }
  | {
      type: "task_failure_resolution_required";
      taskId: string;
      attempt: number;
      failureReason: string;
    }
  | { type: "integration_resolution_required"; taskId: string };

export interface ArchitectActionRequest {
  runId: string;
  reason: ArchitectActionReason;
  projection: SchedulerProjection;
  tools: AgentToolRuntime;
  context: ToolExecutionContext;
}

export interface ArchitectRuntimeDriver {
  run(request: ArchitectActionRequest): Promise<void>;
}

export type IntegrationRuntimeResult =
  | { status: "integrated"; integrationRevision: string }
  | {
      status: "conflict";
      integrationRevision: string;
      conflictPaths: string[];
    };

export interface IntegrationRuntimeDriver {
  integrate(input: {
    runId: string;
    taskId: string;
    changeSetId: string;
  }): Promise<IntegrationRuntimeResult>;
}

export interface BuildRuntimeOptions {
  runId: string;
  store: SchedulerStore;
  workerDriver: WorkerRuntimeDriver;
  architectDriver: ArchitectRuntimeDriver;
  integrationDriver: IntegrationRuntimeDriver;
  maxConcurrency: number;
  workspaceFor: (task: BuildTask) => Promise<string>;
  maxTaskAttempts?: number;
  architectId?: string;
  clock?: () => string;
  renewBudgetWindow?: (idempotencyKey: string, occurredAt: string) => void;
}

export interface BuildStepResult {
  status: "progressed" | "paused" | "completed" | "idle";
  action?: string;
}

export class BuildRuntime {
  readonly id: string;
  private readonly runId: string;
  private readonly store: SchedulerStore;
  private readonly scheduler: TaskScheduler;
  private readonly architectDriver: ArchitectRuntimeDriver;
  private readonly integrationDriver: IntegrationRuntimeDriver;
  private readonly maxTaskAttempts: number;
  private readonly architectId: string;
  private readonly clock: () => string;
  private readonly renewBudgetWindow?: BuildRuntimeOptions["renewBudgetWindow"];
  private stepQueue = Promise.resolve();

  constructor(options: BuildRuntimeOptions) {
    this.id = options.runId;
    this.runId = options.runId;
    this.store = options.store;
    this.architectDriver = options.architectDriver;
    this.integrationDriver = options.integrationDriver;
    this.maxTaskAttempts = options.maxTaskAttempts ?? 2;
    this.architectId = options.architectId ?? "architect_1";
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.renewBudgetWindow = options.renewBudgetWindow;
    this.scheduler = new TaskScheduler({
      runId: options.runId,
      store: options.store,
      driver: options.workerDriver,
      maxConcurrency: options.maxConcurrency,
      workspaceFor: options.workspaceFor,
      maxTaskAttempts: options.maxTaskAttempts,
      clock: this.clock,
    });
  }

  projection(): SchedulerProjection {
    const events = this.store.readRun(this.runId);
    return events.length === 0
      ? emptyProjection(this.runId)
      : rebuildSchedulerProjection(events);
  }

  events(afterSequence = 0) {
    return this.store.readRun(this.runId, afterSequence);
  }

  pause(reason: string, idempotencyKey: string): SchedulerProjection {
    this.ensureInitialized();
    const projection = this.projection();
    if (projection.status === "completed") {
      throw new Error("A completed Build cannot be paused.");
    }
    this.store.append({
      runId: this.runId,
      type: "run.paused",
      occurredAt: this.clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey,
      payload: { reason },
    });
    return this.projection();
  }

  resume(idempotencyKey: string): SchedulerProjection {
    this.ensureInitialized();
    const projection = this.projection();
    if (projection.status === "completed") {
      throw new Error("A completed Build cannot be resumed.");
    }
    if (projection.projectHandoff?.status === "requested") {
      throw new Error(
        "This Build is awaiting the user's final project handoff selection."
      );
    }
    const occurredAt = this.clock();
    if (projection.status === "paused") {
      this.renewBudgetWindow?.(`budget-window:${idempotencyKey}`, occurredAt);
    }
    this.store.append({
      runId: this.runId,
      type: "run.resumed",
      occurredAt,
      actor: { role: "user", id: "local-user" },
      idempotencyKey,
      payload: {},
    });
    return this.projection();
  }

  selectArchitectHandoff(
    runtimeId: string,
    idempotencyKey: string
  ): SchedulerProjection {
    this.store.append({
      runId: this.runId,
      type: "architect.handoff_selected",
      occurredAt: this.clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey,
      payload: { runtimeId },
    });
    return this.projection();
  }

  selectProjectHandoff(
    choice: ProjectHandoffChoice,
    result: {
      integrationRevision: string;
      integrationBranch: string;
      appliedToProject: boolean;
    },
    idempotencyKey: string
  ): SchedulerProjection {
    this.store.append({
      runId: this.runId,
      type: "project.handoff_selected",
      occurredAt: this.clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey,
      payload: { choice, ...result },
    });
    return this.projection();
  }

  async step(): Promise<BuildStepResult> {
    const previous = this.stepQueue;
    let release!: () => void;
    this.stepQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.stepOnce();
    } finally {
      release();
    }
  }

  async runUntilBlocked(maxSteps = 100): Promise<BuildStepResult> {
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
      throw new Error("maxSteps must be a positive integer.");
    }
    let latest: BuildStepResult = { status: "idle" };
    for (let index = 0; index < maxSteps; index += 1) {
      latest = await this.step();
      if (latest.status !== "progressed") return latest;
    }
    if (this.store.readRun(this.runId).length > 0) {
      this.store.append({
        runId: this.runId,
        type: "run.paused",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `step-budget:${this.projection().lastSequence}`,
        payload: { reason: "build_step_budget" },
      });
    }
    return { status: "paused", action: "build_step_budget" };
  }

  private async stepOnce(): Promise<BuildStepResult> {
    const events = this.store.readRun(this.runId);
    if (events.length === 0) {
      await this.runArchitect({ type: "plan_required" }, emptyProjection(this.runId));
      return this.afterArchitect("plan_required");
    }

    let projection = rebuildSchedulerProjection(events);
    if (projection.status === "completed") return { status: "completed" };
    if (projection.status === "paused") return { status: "paused" };
    if (projection.planRevision === 0) {
      await this.runArchitect({ type: "plan_required" }, projection);
      return this.afterArchitect("plan_required");
    }

    const openGuidance = Object.values(projection.guidance)
      .filter((guidance) => guidance.status === "open")
      .sort((left, right) => left.requestId.localeCompare(right.requestId))[0];
    if (openGuidance) {
      await this.runArchitect({
        type: "guidance_required",
        requestId: openGuidance.requestId,
        taskId: openGuidance.taskId,
      }, projection);
      return this.afterArchitect("guidance_required");
    }

    const submitted = firstTask(projection, "submitted");
    if (submitted?.changeSetId) {
      await this.runArchitect({
        type: "review_required",
        taskId: submitted.id,
        changeSetId: submitted.changeSetId,
      }, projection);
      return this.afterArchitect("review_required");
    }

    const approved = firstTask(projection, "approved");
    if (approved?.changeSetId) {
      await this.runArchitect({
        type: "integration_approval_required",
        taskId: approved.id,
        changeSetId: approved.changeSetId,
      }, projection);
      return this.afterArchitect("integration_approval_required");
    }

    const integrating = firstTask(projection, "integrating");
    if (integrating?.changeSetId) {
      const result = await this.integrationDriver.integrate({
        runId: this.runId,
        taskId: integrating.id,
        changeSetId: integrating.changeSetId,
      });
      this.store.append({
        runId: this.runId,
        type: "task.transitioned",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "integration-manager" },
        idempotencyKey: `integration:${integrating.changeSetId}:${result.status}`,
        payload: {
          taskId: integrating.id,
          status:
            result.status === "integrated"
              ? "integrated"
              : "integration_resolution",
          patch: {
            integrationRevision: result.integrationRevision,
            ...(result.status === "conflict"
              ? { conflictPaths: result.conflictPaths }
              : {}),
          },
        },
      });
      return { status: "progressed", action: `integration_${result.status}` };
    }

    const conflict = firstTask(projection, "integration_resolution");
    if (conflict) {
      await this.runArchitect({
        type: "integration_resolution_required",
        taskId: conflict.id,
      }, projection);
      return this.afterArchitect("integration_resolution_required");
    }

    const failed = [...Object.values(projection.tasks)]
      .sort((left, right) => left.id.localeCompare(right.id))
      .find((task) => task.status === "failed");
    if (failed) {
      await this.runArchitect({
        type: "task_failure_resolution_required",
        taskId: failed.id,
        attempt: failed.attempt,
        failureReason: failed.failureReason ?? "worker_failed",
      }, projection);
      return this.afterArchitect("task_failure_resolution_required");
    }

    const rejected = [...Object.values(projection.tasks)]
      .sort((left, right) => left.id.localeCompare(right.id))
      .find((task) => task.status === "rejected");
    if (rejected) {
      if (rejected.attempt >= (rejected.attemptLimit ?? this.maxTaskAttempts)) {
        await this.runArchitect({
          type: "task_failure_resolution_required",
          taskId: rejected.id,
          attempt: rejected.attempt,
          failureReason: "architect_rejected_attempt_budget_exhausted",
        }, projection);
        return this.afterArchitect("rejected_task_resolution_required");
      }
      this.store.append({
        runId: this.runId,
        type: "task.transitioned",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `retry:${rejected.id}:${rejected.attempt}`,
        payload: { taskId: rejected.id, status: "planned" },
      });
      return { status: "progressed", action: "task_retry_planned" };
    }

    const exhaustedPlanned = [...Object.values(projection.tasks)]
      .sort((left, right) => left.id.localeCompare(right.id))
      .find(
        (task) =>
          task.status === "planned" &&
          task.attempt >= (task.attemptLimit ?? this.maxTaskAttempts)
      );
    if (exhaustedPlanned) {
      await this.runArchitect({
        type: "task_failure_resolution_required",
        taskId: exhaustedPlanned.id,
        attempt: exhaustedPlanned.attempt,
        failureReason: "task_attempt_budget_exhausted",
      }, projection);
      return this.afterArchitect("planned_task_resolution_required");
    }

    projection = this.projection();
    const tasks = Object.values(projection.tasks);
    if (
      tasks.every(
        (task) => task.status === "integrated" || task.status === "cancelled"
      )
    ) {
      await this.runArchitect({ type: "completion_decision_required" }, projection);
      return this.afterArchitect("completion_decision_required");
    }

    const sequenceBeforeWorkers = projection.lastSequence;
    await this.scheduler.tick();
    await this.scheduler.awaitIdle();
    const afterWorkers = this.projection();
    if (afterWorkers.status === "paused") {
      return { status: "paused", action: "worker_paused" };
    }
    if (afterWorkers.status === "completed") {
      return { status: "completed", action: "worker_completed" };
    }
    if (afterWorkers.lastSequence > sequenceBeforeWorkers) {
      return { status: "progressed", action: "workers_advanced" };
    }
    return { status: "idle", action: "no_mechanical_progress" };
  }

  private ensureInitialized(): void {
    if (this.store.readRun(this.runId).length > 0) return;
    this.store.append({
      runId: this.runId,
      type: "run.initialized",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "run-initialized",
      payload: {},
    });
  }

  private async runArchitect(
    reason: ArchitectActionReason,
    projection: SchedulerProjection
  ): Promise<void> {
    const sequenceBefore = this.store.readRun(this.runId).at(-1)?.sequence ?? 0;
    const tools = new ToolRegistry();
    for (const tool of createArchitectTools({ store: this.store, clock: this.clock })) {
      tools.register(tool);
    }
    await this.architectDriver.run({
      runId: this.runId,
      reason,
      projection,
      tools,
      context: {
        runId: this.runId,
        sessionId: `architect:${this.runId}`,
        actor: { role: "architect", id: this.architectId },
      },
    });
    const sequenceAfter = this.store.readRun(this.runId).at(-1)?.sequence ?? 0;
    if (sequenceAfter <= sequenceBefore) {
      throw new Error(
        `Architect returned from ${reason.type} without a typed action.`
      );
    }
  }

  private afterArchitect(action: string): BuildStepResult {
    const events = this.store.readRun(this.runId);
    if (events.length === 0) {
      throw new Error(`Architect returned from ${action} without a typed action.`);
    }
    const projection = rebuildSchedulerProjection(events);
    return projection.status === "completed"
      ? { status: "completed", action }
      : projection.status === "paused"
        ? { status: "paused", action }
        : { status: "progressed", action };
  }
}

function firstTask(
  projection: SchedulerProjection,
  status: BuildTask["status"]
): BuildTask | undefined {
  return Object.values(projection.tasks)
    .filter((task) => task.status === status)
    .sort((left, right) => left.id.localeCompare(right.id))[0];
}

function emptyProjection(runId: string): SchedulerProjection {
  return {
    runId,
    status: "running",
    planRevision: 0,
    tasks: {},
    guidance: {},
    reviews: {},
    runtime: {
      providerHealth: {},
      workerAssignments: {},
      architect: {},
    },
    lastSequence: 0,
  };
}
