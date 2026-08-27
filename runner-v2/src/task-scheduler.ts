import type {
  SchedulerProjection,
  SchedulerStore,
} from "./scheduler-store.js";
import { rebuildSchedulerProjection } from "./scheduler-store.js";
import { isFinalVerificationTask, type BuildTask } from "./task-contracts.js";
import { readyTaskIds } from "./task-graph.js";
import type { CriterionEvidenceLink } from "./acceptance-contracts.js";

export interface WorkerAssignment {
  runId: string;
  task: BuildTask;
  attempt: number;
  workerId: string;
  workspacePath: string;
  signal?: AbortSignal;
  providerRetryDeadlineMs?: number;
}

export type WorkerOutcome =
  | {
      type: "submitted";
      changeSetId: string;
      criterionEvidenceLinks?: CriterionEvidenceLink[];
    }
  | {
      type: "guidance";
      requestId: string;
      blocking: boolean;
      question: string;
      evidenceSequence: number;
    }
  | { type: "failed"; reason: string }
  | { type: "paused"; reason: string };

export interface WorkerRuntimeDriver {
  run(assignment: WorkerAssignment): Promise<WorkerOutcome>;
}

export interface TaskSchedulerOptions {
  runId: string;
  store: SchedulerStore;
  driver: WorkerRuntimeDriver;
  maxConcurrency: number;
  workspaceFor: (
    task: BuildTask,
    attempt: number
  ) => Promise<string | WorkspaceAllocation>;
  maxTaskAttempts?: number;
  clock?: () => string;
  lifecycleSignal?: () => AbortSignal;
  providerRetryDeadlineMs?: () => number | undefined;
}

export interface WorkspaceAllocation {
  path: string;
  workspaceId: string;
  baselineRevision: string;
}

export class TaskScheduler {
  private readonly runId: string;
  private readonly store: SchedulerStore;
  private readonly driver: WorkerRuntimeDriver;
  private readonly maxConcurrency: number;
  private readonly workspaceFor: TaskSchedulerOptions["workspaceFor"];
  private readonly maxTaskAttempts: number;
  private readonly clock: () => string;
  private readonly lifecycleSignal?: TaskSchedulerOptions["lifecycleSignal"];
  private readonly providerRetryDeadlineMs?: TaskSchedulerOptions["providerRetryDeadlineMs"];
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
    this.lifecycleSignal = options.lifecycleSignal;
    this.providerRetryDeadlineMs = options.providerRetryDeadlineMs;
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
      if (
        projection.acceptanceContractStatus ===
        "acceptance_contract_upgrade_required"
      ) return;

      for (const task of Object.values(projection.tasks)) {
        if (this.active.size >= this.maxConcurrency) break;
        if (isFinalVerificationTask(task)) continue;
        if (
          (task.status === "assigned" || task.status === "running") &&
          !this.active.has(task.id)
        ) {
          const allocation = task.workspacePath
            ? { path: task.workspacePath }
            : normalizeWorkspace(await this.workspaceFor(task, task.attempt));
          const workspacePath = allocation.path;
          if (task.status === "assigned") {
            this.transition(task.id, "running", task.attempt, {
              ...workspacePatch(allocation),
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
        if (task.attempt >= (task.attemptLimit ?? this.maxTaskAttempts)) {
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
        const allocation = normalizeWorkspace(
          await this.workspaceFor(task, attempt)
        );
        const workspacePath = allocation.path;
        const workerId = `worker_${taskId}_${attempt}`;
        this.transition(taskId, "assigned", attempt, {
          attempt,
          assignedWorkerId: workerId,
          ...workspacePatch(allocation),
        });
        this.transition(taskId, "running", attempt, workspacePatch(allocation));
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
    const providerRetryDeadlineMs = this.providerRetryDeadlineMs?.();
    const assignment: WorkerAssignment = {
      runId: this.runId,
      task: { ...task },
      attempt: task.attempt,
      workerId: task.assignedWorkerId ?? `worker_${task.id}_${task.attempt}`,
      workspacePath,
      ...(this.lifecycleSignal ? { signal: this.lifecycleSignal() } : {}),
      ...(providerRetryDeadlineMs !== undefined
        ? { providerRetryDeadlineMs }
        : {}),
    };
    const operation = Promise.resolve()
      .then(async () => await this.driver.run(assignment))
      .then((outcome) => {
        if (assignment.signal?.aborted) return;
        this.recordOutcome(task.id, task.attempt, outcome);
      })
      .catch((error: unknown) =>
        assignment.signal?.aborted
          ? undefined
          : this.recordOutcome(task.id, task.attempt, {
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
        ...(outcome.criterionEvidenceLinks
          ? {
              criterionEvidenceLinks: outcome.criterionEvidenceLinks.map((link) => ({
                ...link,
                artifactHashes: [...link.artifactHashes],
              })),
            }
          : {}),
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
    if (outcome.type === "paused") {
      const lastSequence = this.projection().lastSequence;
      this.store.append({
        runId: this.runId,
        type: "run.paused",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "scheduler" },
        idempotencyKey: `worker-pause:${taskId}:${attempt}:${lastSequence}`,
        payload: { reason: outcome.reason, taskId },
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

function normalizeWorkspace(
  allocation: string | WorkspaceAllocation
): { path: string; workspaceId?: string; baselineRevision?: string } {
  return typeof allocation === "string" ? { path: allocation } : allocation;
}

function workspacePatch(
  allocation: { path: string; workspaceId?: string; baselineRevision?: string }
): Record<string, string> {
  return {
    workspacePath: allocation.path,
    ...(allocation.workspaceId ? { workspaceId: allocation.workspaceId } : {}),
    ...(allocation.baselineRevision
      ? { workspaceBaselineRevision: allocation.baselineRevision }
      : {}),
  };
}
