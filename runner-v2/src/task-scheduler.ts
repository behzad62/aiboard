import { ContextManifestRecordingError } from "./context-manifest-store.js";
import type {
  SchedulerProjection,
  SchedulerStore,
} from "./scheduler-store.js";
import {
  newPolicyTaskAdmissionBlocked,
  planCritiquePending,
  readyPlanIdentity,
  rebuildSchedulerProjection,
  repairParentContractId,
} from "./scheduler-store.js";
import { isFinalVerificationTask, type BuildTask } from "./task-contracts.js";
import { readyTaskIds } from "./task-graph.js";
import type {
  AssignmentClaim,
  ExecutionTaskContract,
} from "./planning-contracts.js";
import {
  assignmentPacketIdFor,
  assignmentMatchesTask,
  buildAssignmentClaim,
  effectiveMaxWorkers,
  findClaimConflict,
  nextClaimGeneration,
  normalizeClaimPath,
  releaseAssignmentClaim,
  resolveClaimPathAgainstRoot,
  schedulerTaskWriteClaim,
  taskWriteClaimFromAssignment,
  type TaskWriteClaim,
} from "./task-resource-claims.js";
import type { CriterionEvidenceLink } from "./acceptance-contracts.js";
import {
  isSteeringReassignedWorkerId,
  standardWorkerId,
} from "./worker-identity.js";

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
  /**
   * T4: actual resource/provider capacity when the host reports one.
   * New-policy admission is bounded by
   * `min(MAX_WORKERS, maxConcurrency, resourceCapacity)`; legacy runs
   * ignore it. Absent means unknown (no further bound, recorded as
   * procedural — never invented).
   */
  resourceCapacity?: number | (() => number | undefined);
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
  private readonly resourceCapacity?: TaskSchedulerOptions["resourceCapacity"];
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
    if (
      typeof options.resourceCapacity === "number" &&
      (!Number.isSafeInteger(options.resourceCapacity) ||
        options.resourceCapacity < 0)
    ) {
      throw new Error("resourceCapacity must be a non-negative integer.");
    }
    this.resourceCapacity = options.resourceCapacity;
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
      if (hasPendingUserGuidance(projection)) return;
      if (
        projection.acceptanceContractStatus ===
        "acceptance_contract_upgrade_required"
      ) return;
      if (planCritiquePending(projection)) return;
      // T3a (EP32/EP23): a new-policy run admits no worker until the plan is
      // ready; a changed source or plan flips readiness back (T2 reducer),
      // which re-blocks admission until re-readiness. Plan-only runs never
      // admit workers, even with a ready plan. Legacy runs are untouched.
      if (newPolicyAdmissionClosed(projection)) return;

      const bound = this.workerBound(projection);
      for (const task of Object.values(projection.tasks)) {
        if (this.active.size >= bound) break;
        if (isFinalVerificationTask(task)) continue;
        if (
          (task.status === "assigned" || task.status === "running") &&
          !this.active.has(task.id) &&
          this.active.size < bound
        ) {
          // T3a repair (B1c): only tasks bound to the current ready plan may
          // be dispatched; anything else is skipped without spending work.
          if (newPolicyTaskAdmissionBlocked(projection, task.id)) continue;
          // T4: restart reconciliation with authenticated ownership. A
          // live claim owned by another writer, or an unknown running
          // writer with no durable claim, blocks reassignment — competing
          // controllers are refused, never silently adopted.
          const restartBlock = this.restartOwnership(projection, task);
          if (restartBlock !== undefined) {
            this.recordAssignmentClaimFailure(task.id, restartBlock);
            continue;
          }
          // T4: file/resource pre-check before spending a workspace
          // allocation (the worktree half re-checks after allocation).
          if (
            this.claimConflictFor(
              projection,
              task,
              task.workspacePath ?? task.workspaceId ?? "",
            ) !== undefined
          ) continue;
          const allocation = task.workspacePath
            ? { path: task.workspacePath }
            : normalizeWorkspace(await this.workspaceFor(task, task.attempt));
          projection = this.projection();
          if (hasPendingUserGuidance(projection)) return;
          // T3a repair (N3): re-check admission after the async gap, so a
          // source/plan change landing during the await cannot dispatch. A
          // global loss stops the tick; a per-task loss skips just this
          // task. Either way the task is skipped cleanly, never thrown.
          if (newPolicyAdmissionClosed(projection)) return;
          if (newPolicyTaskAdmissionBlocked(projection, task.id)) continue;
          if (
            this.restartOwnership(projection, projection.tasks[task.id] ?? task) !==
            undefined
          ) {
            this.recordAssignmentClaimFailure(
              task.id,
              "restart ownership became blocked after workspace allocation",
            );
            continue;
          }
          if (
            this.claimConflictFor(
              projection,
              projection.tasks[task.id] ?? task,
              allocation.path,
            ) !== undefined
          ) continue;
          const workspacePath = allocation.path;
          try {
            this.ensurePacketClaim(projection, task, allocation, workerIdFor(task));
          } catch (error) {
            if (!(error instanceof Error) ||
              !/claim conflict|overlapping|shared worktree/i.test(error.message)) {
              this.recordAssignmentClaimFailure(task.id, error);
            }
            continue;
          }
          projection = this.projection();
          if (task.status === "assigned") {
            this.transition(task.id, "running", task.attempt, {
              ...workspacePatch(allocation),
            }, task.assignedWorkerId);
            projection = this.projection();
          }
          // T3a repair (N3): final check before each dispatch (this also
          // covers the no-await workspacePath path). The check and the
          // transition/dispatch below are synchronous, so no change can land
          // between them and tick() never throws an admission error.
          if (newPolicyTaskAdmissionBlocked(projection, task.id)) continue;
          // T4: the restart path reuses the durable packet claim — it never
          // appends a competing reservation for the same packet.
          this.dispatch(projection.tasks[task.id], workspacePath);
        }
      }

      projection = this.projection();
      // T4: release packet claims for terminal tasks (best-effort,
      // idempotent) so later tasks can reuse their files/resources.
      this.releaseTerminalPacketClaims(projection);
      const plannedBound = this.workerBound(projection);
      for (const taskId of readyTaskIds(Object.values(projection.tasks))) {
        if (this.capacityInUse(this.projection()) >= plannedBound) break;
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
        // T3a repair (B1c): skip tasks not bound to the current ready plan
        // before spending a workspace allocation on them.
        if (newPolicyTaskAdmissionBlocked(projection, taskId)) continue;
        const dependencyBlock = this.currentDependencyBlock(
          projection,
          projection.tasks[taskId],
        );
        if (dependencyBlock) continue;
        // T4: file/resource pre-check before spending a workspace
        // allocation (the worktree half re-checks after allocation).
        if (
          this.claimConflictFor(
            projection,
            task,
            task.workspacePath ?? task.workspaceId ?? "",
          ) !== undefined
        ) continue;
        const attempt = task.attempt + 1;
        const workerId = standardWorkerId(taskId, attempt);
        const allocation = normalizeWorkspace(
          await this.workspaceFor(task, attempt)
        );
        projection = this.projection();
        if (hasPendingUserGuidance(projection)) return;
        // T3a repair (N3): re-check after the async gap; skip cleanly.
        if (newPolicyAdmissionClosed(projection)) return;
        if (newPolicyTaskAdmissionBlocked(projection, taskId)) continue;
        const current = projection.tasks[taskId];
        // T4: dependency/resource admission — overlapping writes, aliased
        // paths, shared DB/port/schema/config resources, a shared
        // worktree, or an unknown running writer each prevent dual
        // admission. Skipped cleanly, never thrown.
        if (
          this.claimConflictFor(projection, current, allocation.path) !==
          undefined
        ) continue;
        // T4: atomic reservation of claims + task identity before dispatch.
        // Each durable append is atomic (SQLite BEGIN IMMEDIATE); across
        // appends the sole controller serializes (procedural). A competing
        // reservation or lost readiness skips cleanly here.
        try {
          this.ensurePacketClaim(projection, current, allocation, workerId);
        } catch (error) {
          this.recordAssignmentClaimFailure(taskId, error);
          continue;
        }
        projection = this.projection();
        const workspacePath = allocation.path;
        // T3a repair (N3): final check before the transitions and dispatch;
        // synchronous with them, so tick() never throws an admission error.
        if (newPolicyTaskAdmissionBlocked(projection, taskId)) continue;
        this.transition(taskId, "assigned", attempt, {
          attempt,
          assignedWorkerId: workerId,
          ...workspacePatch(allocation),
        }, workerId);
        this.transition(taskId, "running", attempt, workspacePatch(allocation), workerId);
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
      workerId: task.assignedWorkerId ?? standardWorkerId(task.id, task.attempt),
      workspacePath,
      ...(this.lifecycleSignal ? { signal: this.lifecycleSignal() } : {}),
      ...(providerRetryDeadlineMs !== undefined
        ? { providerRetryDeadlineMs }
        : {}),
    };
    const operation = Promise.resolve()
      .then(async () => await this.driver.run(assignment))
      .then((outcome) => {
        if (assignment.signal?.aborted) {
          this.releasePacketClaim(
            task.id,
            "stopped_fenced",
            "lifecycle aborted before outcome settlement",
          );
          return;
        }
        this.recordOutcome(task.id, task.attempt, assignment.workerId, outcome);
      })
      .catch((error: unknown) => {
        if (assignment.signal?.aborted) {
          this.releasePacketClaim(
            task.id,
            "stopped_fenced",
            "lifecycle aborted before outcome settlement",
          );
          return undefined;
        }
        if (error instanceof ContextManifestRecordingError) {
          try {
            this.appendContextRecordingFailure(task, error);
          } catch {
            throw error;
          }
          this.recordOutcome(task.id, task.attempt, assignment.workerId, {
            type: "paused",
            reason: "context_recording_failed",
          });
          return undefined;
        }
        this.recordOutcome(task.id, task.attempt, assignment.workerId, {
          type: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      })
      .finally(() => {
        this.active.delete(task.id);
      });
    this.active.set(task.id, operation);
  }

  private appendContextRecordingFailure(
    task: BuildTask,
    error: ContextManifestRecordingError,
  ): void {
    const projection = this.projection();
    const current = projection.tasks[task.id] ?? task;
    const revision = current.workspaceBaselineRevision ?? projection.integrationRevision;
    this.store.append({
      runId: this.runId,
      type: "context_manifest.recording_failed",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: `context-recording-failed:${task.id}:${task.attempt}:${projection.lastSequence}`,
      payload: {
        purpose: error.purpose,
        attempts: error.attempts,
        reason: error.message,
        taskId: task.id,
        attempt: task.attempt,
        ...(revision ? { revision } : {}),
      },
    });
  }

  private recordOutcome(
    taskId: string,
    attempt: number,
    workerId: string,
    outcome: WorkerOutcome
  ): void {
    if (outcome.type === "submitted") {
      // T4: the worker is done writing — release the packet claim so later
      // tasks can reuse its files/resources (best-effort, idempotent).
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
      }, workerId);
      this.releasePacketClaim(taskId, "released");
      return;
    }
    if (outcome.type === "guidance") {
      this.releasePacketClaim(
        taskId,
        "stopped_fenced",
        "driver returned: guidance",
      );
      this.store.append({
        runId: this.runId,
        type: "guidance.requested",
        occurredAt: this.clock(),
        actor: { role: "worker", id: workerId },
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
      this.releasePacketClaim(
        taskId,
        "stopped_fenced",
        `worker paused: ${outcome.reason}`,
      );
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
    // T4: a failed writer must prove stopped/fenced before its packet can
    // be reassigned — record that evidence now (best-effort, idempotent).
    this.transition(taskId, "failed", attempt, {
      failureReason: outcome.reason,
    }, workerId);
    this.releasePacketClaim(
      taskId,
      "stopped_fenced",
      `driver returned: ${outcome.reason}`,
    );
  }

  /**
   * T4: effective concurrent-worker bound for this tick. Legacy runs keep
   * the configured maximum unchanged; new-policy admission is bounded by
   * `min(MAX_WORKERS, configured user maximum, resource capacity)`.
   */
  private capacityInUse(projection: SchedulerProjection): number {
    const durable = projection.planningPolicyVersion === 1
      ? new Set(
          Object.values(projection.tasks)
            .filter((task) =>
              task.status === "assigned" ||
              task.status === "running" ||
              task.status === "waiting_guidance",
            )
            .map((task) => task.id),
        ).size
      : 0;
    return Math.max(this.active.size, durable);
  }

  private currentDependencyBlock(
    projection: SchedulerProjection,
    task: BuildTask | undefined,
  ): string | undefined {
    if (!task) return undefined;
    const contract = this.readyContractFor(projection, task.id);
    const dependencies = contract?.dependencies ?? task.dependencies;
    for (const dependency of dependencies) {
      const parent = projection.tasks[dependency];
      if (!parent || parent.status !== "integrated") {
        return `Task ${task.id} waits for dependency ${dependency}`;
      }
    }
    return undefined;
  }

  private workerBound(projection: SchedulerProjection): number {
    const capacity = typeof this.resourceCapacity === "function"
      ? this.resourceCapacity()
      : this.resourceCapacity;
    return effectiveMaxWorkers({
      planningPolicyVersion: projection.planningPolicyVersion,
      configuredMax: this.maxConcurrency,
      ...(capacity !== undefined ? { resourceCapacity: capacity } : {}),
    });
  }

  /**
   * T4: the ready-plan contract behind a scheduler task — directly for
   * bridged tasks, through the parent for kernel-created repair tasks.
   * Undefined on legacy runs and for tasks with no ready contract.
   */
  private readyContractFor(
    projection: SchedulerProjection,
    taskId: string,
  ): ExecutionTaskContract | undefined {
    if (projection.planningPolicyVersion !== 1) return undefined;
    const plan = projection.planning?.plan;
    const revision = plan?.revisionsById[plan.currentRevisionId];
    if (!revision) return undefined;
    const binding = projection.readyPlanTaskBindings?.[taskId];
    const directId = binding?.contractId ?? (binding ? taskId : undefined);
    const direct = revision.tasks.find((contract) => contract.id === directId);
    if (direct) return direct;
    const task = projection.tasks[taskId];
    if (task?.kind === "verification_repair") {
      const parent = repairParentContractId(projection, task);
      if (parent !== undefined) {
        return revision.tasks.find((contract) => contract.id === parent);
      }
    }
    return undefined;
  }

  private packetAssignmentEntries(
    projection: SchedulerProjection,
    taskId: string,
  ): Array<{ claim: AssignmentClaim; status: string }> {
    return Object.values(projection.planning?.assignments ?? {})
      .filter((entry) => assignmentMatchesTask(entry.claim.packetId, taskId))
      .map((entry) => ({ claim: entry.claim, status: entry.status }))
      .sort(
        (left, right) =>
          left.claim.ownershipGeneration - right.claim.ownershipGeneration,
      );
  }

  private livePacketAssignment(
    projection: SchedulerProjection,
    taskId: string,
  ): AssignmentClaim | undefined {
    return this.packetAssignmentEntries(projection, taskId)
      .filter((entry) => entry.status === "claimed")
      .at(-1)?.claim;
  }

  private latestPacketAssignment(
    projection: SchedulerProjection,
    taskId: string,
  ): AssignmentClaim | undefined {
    return this.packetAssignmentEntries(projection, taskId).at(-1)?.claim;
  }

  /**
   * T4: effective write claims of every OTHER active writer — durable
   * packet claims where they exist (files/resources from the ready
   * contract, worktree from the recorded claim), worktree-only where the
   * writer is unknown (fail closed on a shared worktree; files unknown).
   */
  private activeWriterClaims(
    projection: SchedulerProjection,
    excludeTaskId: string,
  ): TaskWriteClaim[] {
    if (projection.planningPolicyVersion !== 1) return [];
    const claims: TaskWriteClaim[] = [];
    for (const task of Object.values(projection.tasks)) {
      if (task.id === excludeTaskId) continue;
      const live = this.livePacketAssignment(projection, task.id);
      if (
        task.status !== "assigned" &&
        task.status !== "running" &&
        task.status !== "waiting_guidance" &&
        !live
      ) continue;
      const contract = this.readyContractFor(projection, task.id);
      const worktree = normalizeClaimPath(
        live?.branchOrWorktree ?? task.workspacePath ?? task.workspaceId ?? "",
      );
      if (live) {
        claims.push(taskWriteClaimFromAssignment(live, task.id));
        continue;
      }
      if (!contract) {
        claims.push({
          taskId: task.id,
          files: ["."],
          resources: [],
          worktree,
        });
        continue;
      }
      claims.push(schedulerTaskWriteClaim(task, contract, worktree));
    }
    return claims;
  }

  /**
   * T4: first claim conflict blocking this task, or undefined when it is
   * independent of every active writer. Legacy runs never conflict here.
   */
  private claimConflictFor(
    projection: SchedulerProjection,
    task: BuildTask,
    worktreePath: string,
  ): string | undefined {
    if (projection.planningPolicyVersion !== 1) return undefined;
    const contract = this.readyContractFor(projection, task.id);
    const rawCandidate = schedulerTaskWriteClaim(task, contract, worktreePath);
    const resolver = worktreePath
      ? (path: string) => resolveClaimPathAgainstRoot(path, worktreePath)
      : undefined;
    const candidate = resolver
      ? {
          ...rawCandidate,
          files: rawCandidate.files.map((file) => resolver(file).resolved),
        }
      : rawCandidate;
    return findClaimConflict(
      candidate,
      this.activeWriterClaims(projection, task.id),
    )?.detail;
  }

  /**
   * T4: reserve the packet claim + task identity atomically before
   * dispatch. The append itself is atomic (SQLite BEGIN IMMEDIATE); the
   * sole controller serializes across appends (procedural). Reuses a
   * live claim when one exists; repair tasks carry no durable packet
   * claim (their packet is not a revision contract) and are checked
   * ephemerally instead. Throws when no claim can be reserved — the
   * caller skips cleanly, so tick() never throws an admission error.
   */
  private ensurePacketClaim(
    projection: SchedulerProjection,
    task: BuildTask,
    allocation: { path: string; workspaceId?: string; baselineRevision?: string },
    workerId: string,
  ): void {
    if (projection.planningPolicyVersion !== 1) return;
    const contract = this.readyContractFor(projection, task.id);
    const kernelRepair =
      task.kind === "verification_repair" && contract === undefined;
    if (!contract && !kernelRepair) {
      throw new Error(`Task ${task.id} has no ready contract to claim.`);
    }
    const live = this.livePacketAssignment(projection, task.id);
    if (live) {
      if (live.workerOrSessionId !== workerId) {
        throw new Error(
          `Task ${task.id} is owned by another writer ${live.workerOrSessionId}.`,
        );
      }
      return;
    }
    const priors = this.packetAssignmentEntries(projection, task.id).map(
      (entry) => entry.claim,
    );
    const claim = buildAssignmentClaim({
      packetId: assignmentPacketIdFor(
        task.id,
        repairParentContractId(projection, task),
        kernelRepair,
      ),
      laneId: contract?.accountablePhaseId ?? "kernel-repair",
      workerOrSessionId: workerId,
      acceptedBaseRevision:
        allocation.baselineRevision ??
        task.workspaceBaselineRevision ??
        contract?.requiredBase ??
        "kernel repair base",
      branchOrWorktree: allocation.path,
      writableSurfaces: kernelRepair
        ? ["."]
        : [
            ...contract!.writableSurfaces.map((surface) =>
              resolveClaimPathAgainstRoot(surface, allocation.path).resolved,
            ),
            ...(contract!.sharedResourceClaims ?? []).map(
              (resource) => `resource:${resource}`,
            ),
          ],
      forbiddenSurfaces: [...(contract?.forbiddenSurfaces ?? [])],
      ownershipGeneration: nextClaimGeneration(priors),
    });
    this.store.append({
      runId: this.runId,
      type: "planning.assignment_claimed",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: `t4-claim:${this.runId}:${claim.id}`,
      payload: { claim },
    });
  }

  /**
   * T4: restart reconciliation with authenticated ownership. Returns the
   * blocking reason, or undefined when this controller may resume the
   * attempt. A live claim owned by another writer, or a running task
   * with no durable claim at all (unknown running writer), blocks
   * reassignment; a confirmed-live claim (running status or a recorded
   * worker session) is ambiguous after restart and also blocks, until
   * stopped/fenced writer evidence is recorded. Legacy runs resume as
   * before.
   */
  private restartOwnership(
    projection: SchedulerProjection,
    task: BuildTask,
  ): string | undefined {
    if (projection.planningPolicyVersion !== 1) return undefined;
    const workerId = workerIdFor(task);
    const live = this.livePacketAssignment(projection, task.id);
    const latest = this.latestPacketAssignment(projection, task.id);
    if (latest && latest.state !== "claimed") {
      return undefined;
    }
    if (latest && latest.workerOrSessionId === workerId && !live) {
      return undefined;
    }
    if (!live) {
      return (
        `Task ${task.id} is assigned/running without a durable packet ` +
        `claim (unknown running writer); reassignment is blocked until the ` +
        `writer is stopped/fenced and reconciled.`
      );
    }
    if (live.workerOrSessionId !== workerId) {
      return (
        `Task ${task.id} is owned by another writer ` +
        `(${live.workerOrSessionId}); competing controllers are refused.`
      );
    }
    return undefined;
  }

  /**
   * T4: best-effort idempotent packet-claim release. Never throws: a
   * leaked claim only ever blocks while its task is active (conflict
   * checks scope to active writers), and the terminal sweep retries.
   * Ending a caller never releases anything — only these explicit
   * terminal events do.
   */
  private recordAssignmentClaimFailure(taskId: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Assignment claim failed for ${taskId}: ${reason}`);
    this.store.append({
      runId: this.runId,
      type: "run.paused",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: `assignment-claim-error:${taskId}:${this.projection().lastSequence}`,
      payload: { reason: "assignment_claim_error", taskId, error: reason },
    });
  }

  private releasePacketClaim(
    taskId: string,
    state: "released" | "stopped_fenced",
    writerStopEvidence?: string,
  ): void {
    const projection = this.projection();
    if (projection.planningPolicyVersion !== 1) return;
    const live = this.livePacketAssignment(projection, taskId);
    if (!live) return;
    const evidence = (writerStopEvidence ?? "").trim() || "worker_failed";
    const released = releaseAssignmentClaim(
      live,
      state,
      state === "stopped_fenced" ? evidence : undefined,
    );
    this.store.append({
      runId: this.runId,
      type: "planning.assignment_released",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: `t4-release:${this.runId}:${released.id}:${state}`,
      payload: { claim: released },
    });
  }

  /** T4: release claims for terminal tasks so later tasks reuse their scope. */
  private releaseTerminalPacketClaims(projection: SchedulerProjection): void {
    if (projection.planningPolicyVersion !== 1) return;
    for (const task of Object.values(projection.tasks)) {
      if (task.status !== "integrated" && task.status !== "cancelled") continue;
      if (!this.livePacketAssignment(projection, task.id)) continue;
      try {
        this.releasePacketClaim(
          task.id,
          task.status === "cancelled" ? "stopped_fenced" : "released",
          task.status === "cancelled"
            ? "managed interruption completed before cancellation"
            : undefined,
        );
      } catch (error) {
        this.recordAssignmentClaimFailure(task.id, error);
      }
    }
  }

  /**
   * T4: active writers with no ready contract and no durable claim —
   * their files are unknown, so only same-worktree admission is refused
   * for them and their own task is never re-dispatched.
   */
  private transition(
    taskId: string,
    status: BuildTask["status"],
    attempt: number,
    patch: Record<string, unknown>,
    workerId?: string
  ): void {
    this.store.append({
      runId: this.runId,
      type: "task.transitioned",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: taskTransitionIdempotencyKey(
        taskId,
        attempt,
        status,
        workerId
      ),
      payload: { taskId, status, patch },
    });
  }
}

function taskTransitionIdempotencyKey(
  taskId: string,
  attempt: number,
  status: BuildTask["status"],
  workerId?: string
): string {
  const legacyKey = `task:${taskId}:attempt:${attempt}:${status}`;
  return workerId !== undefined &&
    isSteeringReassignedWorkerId(taskId, attempt, workerId)
    ? `${legacyKey}:worker:${workerId}`
    : legacyKey;
}

function workerIdFor(task: BuildTask): string {
  return task.assignedWorkerId ?? standardWorkerId(task.id, task.attempt);
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

function hasPendingUserGuidance(projection: SchedulerProjection): boolean {
  return Object.values(projection.userGuidance).some(
    (guidance) => guidance.status === "submitted"
  );
}

/**
 * T3a repair (N3): the global half of new-policy admission — plan-only, or
 * no ready plan at all. When closed, the whole tick stops; per-task binding
 * loss instead skips just that task (`newPolicyTaskAdmissionBlocked`).
 * Legacy runs are never closed here.
 */
function newPolicyAdmissionClosed(projection: SchedulerProjection): boolean {
  return projection.planningPolicyVersion === 1 &&
    (projection.runPolicy === "plan_only" || !readyPlanIdentity(projection));
}
