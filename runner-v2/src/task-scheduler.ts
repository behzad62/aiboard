import type {
  SchedulerProjection,
  SchedulerStore,
} from "./scheduler-store.js";
import { rebuildSchedulerProjection } from "./scheduler-store.js";
import type { BuildTask } from "./task-contracts.js";
import { readyTaskIds } from "./task-graph.js";

export interface WorkerAssignment {
  runId: string;
  task: BuildTask;
  attempt: number;
  workerId: string;
  workspacePath: string;
}

export type WorkerOutcome =
  | { type: "submitted"; changeSetId: string }
  | {
      type: "guidance";
      requestId: string;
      blocking: boolean;
      question: string;
      evidenceSequence: number;
    }
  | { type: "failed"; reason: string };

export interface WorkerRuntimeDriver {
  run(assignment: WorkerAssignment): Promise<WorkerOutcome>;
}

export interface TaskSchedulerOptions {
  runId: string;
  store: SchedulerStore;
  driver: WorkerRuntimeDriver;
  maxConcurrency: number;
  workspaceFor: (task: BuildTask) => Promise<string>;
  maxTaskAttempts?: number;
  clock?: () => string;
}

export class TaskScheduler {
  private readonly runId: string;
  private readonly store: SchedulerStore;
  private readonly driver: WorkerRuntimeDriver;
  private readonly maxConcurrency: number;
  private readonly workspaceFor: TaskSchedulerOptions["workspaceFor"];
  private readonly maxTaskAttempts: number;
  private readonly clock: () => string;
  private readonly active = new Map<string, Promise<void>>();
  private tickQueue = Promise.resolve();

  constructor(options: TaskSchedulerOptions) {
    if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
      throw new Error("maxConcurrency must be a positive integer.");
    }
    this.runId = options.runId;
    this.store = options.store;
    this.driver = options.driver;
    this.maxConcurrency = options.maxConcurrency;
    this.workspaceFor = options.workspaceFor;
    this.maxTaskAttempts = options.maxTaskAttempts ?? 2;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  projection(): SchedulerProjection {
    return rebuildSchedulerProjection(this.store.readRun(this.runId));
  }

  activeCount(): number {
    return this.active.size;
  }

  async awaitIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.all([...this.active.values()]);
    }
  }

  async tick(): Promise<void> {
    const previous = this.tickQueue;
    let release!: () => void;
    this.tickQueue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    try {
      let projection = this.projection();
      if (projection.status !== "running") return;

      for (const task of Object.values(projection.tasks)) {
        if (this.active.size >= this.maxConcurrency) break;
        if (
          (task.status === "assigned" || task.status === "running") &&
          !this.active.has(task.id)
        ) {
          const workspacePath =
            task.workspacePath ?? (await this.workspaceFor(task));
          if (task.status === "assigned") {
            this.transition(task.id, "running", task.attempt, {
              workspacePath,
            });
            projection = this.projection();
          }
          this.dispatch(projection.tasks[task.id], workspacePath);
        }
      }

      projection = this.projection();
      for (const taskId of readyTaskIds(Object.values(projection.tasks))) {
        if (this.active.size >= this.maxConcurrency) break;
        const task = projection.tasks[taskId];
        if (task.attempt >= this.maxTaskAttempts) {
          this.store.append({
            runId: this.runId,
            type: "run.paused",
            occurredAt: this.clock(),
            actor: { role: "runner", id: "scheduler" },
            idempotencyKey: `budget:${taskId}:${task.attempt}`,
            payload: { reason: "task_attempt_budget", taskId },
          });
          break;
        }
        const attempt = task.attempt + 1;
        const workspacePath = await this.workspaceFor(task);
        const workerId = `worker_${taskId}_${attempt}`;
        this.transition(taskId, "assigned", attempt, {
          attempt,
          assignedWorkerId: workerId,
          workspacePath,
        });
        this.transition(taskId, "running", attempt, { workspacePath });
        this.dispatch(this.projection().tasks[taskId], workspacePath);
      }
    } finally {
      release();
    }
  }

  pause(reason: string, idempotencyKey: string): void {
    this.store.append({
      runId: this.runId,
      type: "run.paused",
      occurredAt: this.clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey,
      payload: { reason },
    });
  }

  resume(idempotencyKey: string): void {
    this.store.append({
      runId: this.runId,
      type: "run.resumed",
      occurredAt: this.clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey,
      payload: {},
    });
  }

  private dispatch(task: BuildTask, workspacePath: string): void {
    const assignment: WorkerAssignment = {
      runId: this.runId,
      task: { ...task },
      attempt: task.attempt,
      workerId: task.assignedWorkerId ?? `worker_${task.id}_${task.attempt}`,
      workspacePath,
    };
    const operation = Promise.resolve()
      .then(async () => await this.driver.run(assignment))
      .then((outcome) => this.recordOutcome(task.id, task.attempt, outcome))
      .catch((error: unknown) =>
        this.recordOutcome(task.id, task.attempt, {
          type: "failed",
          reason: error instanceof Error ? error.message : String(error),
        })
      )
      .finally(() => {
        this.active.delete(task.id);
      });
    this.active.set(task.id, operation);
  }

  private recordOutcome(
    taskId: string,
    attempt: number,
    outcome: WorkerOutcome
  ): void {
    if (outcome.type === "submitted") {
      this.transition(taskId, "submitted", attempt, {
        changeSetId: outcome.changeSetId,
      });
      return;
    }
    if (outcome.type === "guidance") {
      this.store.append({
        runId: this.runId,
        type: "guidance.requested",
        occurredAt: this.clock(),
        actor: { role: "worker", id: `worker_${taskId}_${attempt}` },
        idempotencyKey: `guidance:${outcome.requestId}`,
        payload: {
          requestId: outcome.requestId,
          taskId,
          blocking: outcome.blocking,
          question: outcome.question,
          evidenceSequence: outcome.evidenceSequence,
        },
      });
      return;
    }
    this.transition(taskId, "failed", attempt, {
      failureReason: outcome.reason,
    });
  }

  private transition(
    taskId: string,
    status: BuildTask["status"],
    attempt: number,
    patch: Record<string, unknown>
  ): void {
    this.store.append({
      runId: this.runId,
      type: "task.transitioned",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: `task:${taskId}:attempt:${attempt}:${status}`,
      payload: { taskId, status, patch },
    });
  }
}
