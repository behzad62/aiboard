import { ContextManifestRecordingError } from "./context-manifest-store.js";
import {
  errorMessage,
  isProcessStopUnprovenError,
  processStopUnprovenPauseReason,
  boundedText,
  PROCESS_STOP_UNRECORDED_PAUSE_PREFIX,
  PROCESS_STOP_OUTCOME_UNRECORDED_PAUSE_PREFIX,
} from "./process-stop-proof.js";
import type {
  SchedulerProjection,
  SchedulerStore,
} from "./scheduler-store.js";
import {
  newPolicyTaskAdmissionBlocked,
  explicitStartBlocked,
  planCritiquePending,
  readyPlanIdentity,
  rebuildSchedulerProjection,
  repairParentContractId,
  type UnprovenWorkerStopProjection,
} from "./scheduler-store.js";
import { isFinalVerificationTask, type BuildTask } from "./task-contracts.js";
import { readyTaskIds } from "./task-graph.js";
import type { NativePlanningSchedule } from "./planning-view-contracts.js";
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
      reviewSignals?: import("./review-integrity.js").ReviewSignalsRecord;
      encodingSubmission?: import("./encoding-safety.js").EncodingSubmissionRecord;
      submissionScope?: import("./submission-scope-contracts.js").SubmissionScopeRecord;
      validationScope?: import("./validation-scope.js").ValidationScope;
      validationBudget?: import("./validation-budget.js").ValidationBudgetSubmission;
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
  | { type: "paused"; reason: string }
  /**
   * The attempt ended with `outcome`, but its stop was not proven: a process
   * it started may still run and write in its worktree. The scheduler keeps
   * the packet claim, records nothing of `outcome` yet, and pauses the run
   * with `process_stop_unproven:<taskId>`. On resume it retries the stop
   * (`retryStop`) before anything else; a proven stop releases the claim as
   * `stopped_fenced` and then records `outcome`.
   */
  | {
      type: "stop_unproven";
      reason: string;
      outcome: SettledWorkerOutcome;
      /**
       * The error the attempt threw, when it threw (in memory only): the
       * scheduler handles it as its catch path would, so a context
       * recording failure keeps its own pause.
       */
      thrown?: unknown;
    };

/** A worker outcome whose stop was proven (or needs no proof). */
export type SettledWorkerOutcome = Exclude<WorkerOutcome, { type: "stop_unproven" }>;

export interface WorkerRuntimeDriver {
  run(assignment: WorkerAssignment): Promise<WorkerOutcome>;
  /**
   * Stops again, for an attempt that returned `stop_unproven`, everything
   * that attempt's owner started. Resolves only when the stop is proven and
   * throws otherwise. A driver without it keeps such a run paused.
   */
  retryStop?(assignment: WorkerAssignment): Promise<void>;
}

export interface TaskSchedulerOptions {
  runId: string;
  assertPlanningArtifact?: (projection: SchedulerProjection) => void;
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
  private readonly assertPlanningArtifact?: TaskSchedulerOptions["assertPlanningArtifact"];
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
  /**
   * Tasks whose unproven stop is being recorded, or failed to be recorded:
   * nothing is dispatched while one is here, so a failed append never lets
   * the attempt start again beside a process that may still run.
   */
  private readonly unrecordedStops = new Set<string>();
  private tickQueue = Promise.resolve();

  private assertCurrentPlanningArtifact(projection: SchedulerProjection): void {
    if (projection.planningPolicyVersion !== 1) return;
    if (!this.assertPlanningArtifact) throw new Error("Current planning source artifact authority unavailable before worker allocation.");
    this.assertPlanningArtifact(projection);
  }

  constructor(options: TaskSchedulerOptions) {
    if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
      throw new Error("maxConcurrency must be a positive integer.");
    }
    this.assertPlanningArtifact = options.assertPlanningArtifact;
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

  /** Read-only admission snapshot. Allocation/artifact checks remain pending. */
  schedulingView(): NativePlanningSchedule {
    const projection = this.projection();
    const capacity = typeof this.resourceCapacity === "function" ? this.resourceCapacity() : this.resourceCapacity;
    const bound = effectiveMaxWorkers({ planningPolicyVersion: projection.planningPolicyVersion, configuredMax: this.maxConcurrency, ...(capacity !== undefined ? { resourceCapacity: capacity } : {}) });
    const used = this.capacityInUse(projection);
    const blockers: string[] = [];
    if (projection.status !== "running") blockers.push(`Run is ${projection.status}`);
    if (hasPendingUserGuidance(projection)) blockers.push("Pending user guidance");
    if (projection.blockingArchitectQuestionId) blockers.push(`Architect question ${projection.blockingArchitectQuestionId} requires an answer`);
    if (Object.values(projection.userGuidance ?? {}).some((guidance) => guidance.interruptionStatus !== "completed")) blockers.push("User guidance interruption pending");
    if (projection.acceptanceContractStatus === "acceptance_contract_upgrade_required") blockers.push("Acceptance contract upgrade required");
    if (planCritiquePending(projection)) blockers.push("Plan critique pending");
    if (newPolicyAdmissionClosed(projection)) blockers.push("No executable ready plan");
    if (explicitStartBlocked(projection)) blockers.push("Current plan requires explicit owner start");
    const ready = new Set(readyTaskIds(Object.values(projection.tasks)));
    const tasks = Object.values(projection.tasks).map((task) => {
      const active = this.active.has(task.id);
      const reasons = [...blockers];
      const contract = this.readyContractFor(projection, task.id);
      const restart = task.status === "assigned" || task.status === "running";
      if (active) reasons.push("Worker active in this controller");
      if (projection.unprovenWorkerStops?.[task.id] || this.unrecordedStops.has(task.id)) reasons.push("Worker stop not yet settled");
      else if (!ready.has(task.id) && !restart) reasons.push("Task is not ready for worker admission");
      if ((restart ? this.active.size : used) >= bound && !active) reasons.push("Worker capacity in use");
      if (!restart && task.attempt >= (task.attemptLimit ?? this.maxTaskAttempts)) reasons.push("Task attempt budget reached");
      if (newPolicyTaskAdmissionBlocked(projection, task.id)) reasons.push("Task is not bound to the current ready plan");
      const dependency = this.currentDependencyBlock(projection, task);
      if (dependency) reasons.push(dependency);
      const ownership = restart && !active ? this.restartOwnership(projection, task) : undefined;
      if (ownership) reasons.push(ownership);
      const conflict = this.claimConflictFor(projection, task, task.workspacePath ?? task.workspaceId ?? "");
      if (conflict) reasons.push(conflict);
      return { taskId: task.id, status: task.status, eligible: reasons.length === 0, active, reasons, dependencies: [...(contract?.dependencies ?? task.dependencies)], ...(contract ? { contractId: contract.id } : {}) };
    });
    const candidates = tasks.filter((task) => task.eligible).map((row) => projection.tasks[row.taskId]);
    const conflicts: NativePlanningSchedule["conflicts"] = [];
    for (let index = 0; index < candidates.length; index++) {
      const task = candidates[index];
      // Advisory pair comparison: unknown future worktrees are distinct placeholders,
      // never recorded ownership. Actual allocation still checks canonical paths.
      const candidate = schedulerTaskWriteClaim(task, this.readyContractFor(projection, task.id), task.workspacePath ?? task.workspaceId ?? `unallocated-view/${encodeURIComponent(task.id)}`);
      for (const other of candidates.slice(index + 1)) {
        const conflict = findClaimConflict(candidate, [schedulerTaskWriteClaim(other, this.readyContractFor(projection, other.id), other.workspacePath ?? other.workspaceId ?? `unallocated-view/${encodeURIComponent(other.id)}`)]);
        if (conflict) conflicts.push({ taskId: task.id, otherTaskId: other.id, detail: conflict.detail });
      }
    }
    const plan = projection.planning?.plan;
    const manifest = projection.planning?.source.manifestsById[projection.planning.source.currentManifestId];
    return { version: 1, runId: this.runId, lastSequence: projection.lastSequence, planRevisionId: plan?.currentRevisionId, planDigest: plan?.currentDigest, sourceManifestId: manifest?.manifestId, sourceArtifactDigest: manifest?.artifactDigest, blockers, configuredMax: this.maxConcurrency, effectiveMax: bound, capacityInUse: used, ...(capacity !== undefined ? { resourceCapacity: capacity } : {}), tasks, conflicts,
      activeClaims: Object.values(projection.planning?.assignments ?? {}).map((entry) => entry.claim).filter((claim) => claim.state === "claimed").map((claim) => ({ id: claim.id, packetId: claim.packetId, workerOrSessionId: claim.workerOrSessionId, ownershipGeneration: claim.ownershipGeneration, state: claim.state, branchOrWorktree: claim.branchOrWorktree, writableSurfaces: [...claim.writableSurfaces], forbiddenSurfaces: [...claim.forbiddenSurfaces] })),
    };
  }

  async awaitIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.all([...this.active.values()]);
    }
  }

  /**
   * Retries the stop of every attempt whose stop is unproven, before
   * anything else runs. Returns "clear" when none is left, or "paused" when
   * the run is (still) paused: a stop that stays unproven re-pauses it with
   * the claim kept. Serialized with tick().
   */
  async settleUnprovenStops(): Promise<"clear" | "paused"> {
    const previous = this.tickQueue;
    let release!: () => void;
    this.tickQueue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    try {
      return await this.settleUnprovenStopsInQueue();
    } finally {
      release();
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
      // An attempt whose stop is unproven keeps its claim; nothing is
      // admitted or resumed until its retried stop is proven.
      if (await this.settleUnprovenStopsInQueue() === "paused") return;
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
          // An attempt whose stop is unproven is never resumed beside it.
          if (projection.unprovenWorkerStops?.[task.id] || this.unrecordedStops.has(task.id)) continue;
          // T3a repair (B1c): only tasks bound to the current ready plan may
          // be dispatched; anything else is skipped without spending work.
          if (explicitStartBlocked(projection) || newPolicyTaskAdmissionBlocked(projection, task.id)) continue;
          this.assertCurrentPlanningArtifact(projection);
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
          if (explicitStartBlocked(projection) || newPolicyTaskAdmissionBlocked(projection, task.id)) continue;
          this.assertCurrentPlanningArtifact(projection);
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
          // The same attempt runs again (after a Runner restart, an owner
          // pause or a kept pause). Its earlier run may have left processes:
          // a restart can reattach live managed processes, so it proves
          // nothing. Retry that stop first; an unproven one keeps the claim.
          if (this.driver.retryStop) {
            const resumed = projection.tasks[task.id];
            const prior: WorkerAssignment = {
              runId: this.runId,
              task: { ...resumed },
              attempt: resumed.attempt,
              workerId: resumed.assignedWorkerId ?? standardWorkerId(resumed.id, resumed.attempt),
              workspacePath,
            };
            try {
              await this.driver.retryStop(prior);
            } catch (error) {
              this.recordStopUnproven(resumed, prior,
                `The earlier run of this attempt could not be proven stopped: ${errorMessage(error)}`,
                { type: "paused", reason: "process_stop_unproven" }, true);
              return;
            }
            projection = this.projection();
            if (projection.status !== "running" || hasPendingUserGuidance(projection)) return;
            const after = projection.tasks[task.id];
            if (after?.status !== "running" || after.attempt !== resumed.attempt ||
              after.assignedWorkerId !== resumed.assignedWorkerId) continue;
          }
          // T3a repair (N3): final check before each dispatch (this also
          // covers the no-await workspacePath path). The check and the
          // transition/dispatch below are synchronous, so no change can land
          // between them and tick() never throws an admission error.
          if (explicitStartBlocked(projection) || newPolicyTaskAdmissionBlocked(projection, task.id)) continue;
          this.assertCurrentPlanningArtifact(projection);
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
        if (explicitStartBlocked(projection) || newPolicyTaskAdmissionBlocked(projection, taskId)) continue;
        this.assertCurrentPlanningArtifact(projection);
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
        if (explicitStartBlocked(projection) || newPolicyTaskAdmissionBlocked(projection, taskId)) continue;
        this.assertCurrentPlanningArtifact(projection);
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
        if (explicitStartBlocked(projection) || newPolicyTaskAdmissionBlocked(projection, taskId)) continue;
        this.assertCurrentPlanningArtifact(projection);
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
    // Set once the unproven-stop path starts: a failure to record it must
    // never fall through to a path that releases the claim.
    let stopUnproven = false;
    const operation = Promise.resolve()
      .then(async () => await this.driver.run(assignment))
      .then((outcome) => {
        // An unproven stop keeps the claim even when the lifecycle aborted:
        // "stopped_fenced" would claim a stop nobody proved.
        if (outcome.type === "stop_unproven") {
          stopUnproven = true;
          // A context-recording failure keeps its note with the stop: settle
          // records the note and its context_recording_failed pause together
          // once the stop is proven, or neither when no outcome is recorded.
          // As on the catch path below, an aborted attempt (owner pause,
          // steering) keeps none: an abort keeps nothing of its outcome.
          if (outcome.thrown instanceof ContextManifestRecordingError && !assignment.signal?.aborted) {
            this.recordStopUnproven(task, assignment, outcome.reason,
              { type: "paused", reason: "context_recording_failed" }, undefined,
              this.contextRecordingFailurePayload(task, outcome.thrown));
            return;
          }
          this.recordStopUnproven(task, assignment, outcome.reason, outcome.outcome);
          return;
        }
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
        // A thrown cleanup failure (process_cleanup_unverified, or an agent
        // cleanup that could not be verified) is an unproven stop too, never
        // a failure that releases the claim as "stopped_fenced".
        if (stopUnproven) throw error;
        if (isProcessStopUnprovenError(error)) {
          stopUnproven = true;
          this.recordStopUnproven(task, assignment, errorMessage(error), {
            type: "failed",
            reason: boundedDetail(errorMessage(error)),
          });
          return undefined;
        }
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
    this.appendContextRecordingNote(task.id, task.attempt, this.contextRecordingFailurePayload(task, error),
      `context-recording-failed:${task.id}:${task.attempt}:${this.projection().lastSequence}`);
  }

  private contextRecordingFailurePayload(
    task: BuildTask,
    error: ContextManifestRecordingError,
  ): NonNullable<UnprovenWorkerStopProjection["contextRecordingFailure"]> {
    const projection = this.projection();
    const current = projection.tasks[task.id] ?? task;
    const revision = current.workspaceBaselineRevision ?? projection.integrationRevision;
    return { purpose: error.purpose, attempts: error.attempts, reason: error.message, ...(revision ? { revision } : {}) };
  }

  private appendContextRecordingNote(
    taskId: string,
    attempt: number,
    failure: NonNullable<UnprovenWorkerStopProjection["contextRecordingFailure"]>,
    idempotencyKey: string,
  ): void {
    this.store.append({
      runId: this.runId,
      type: "context_manifest.recording_failed",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey,
      payload: {
        purpose: failure.purpose,
        attempts: failure.attempts,
        reason: failure.reason,
        taskId,
        attempt,
        ...(failure.revision ? { revision: failure.revision } : {}),
      },
    });
  }

  private recordOutcome(
    taskId: string,
    attempt: number,
    workerId: string,
    outcome: WorkerOutcome,
    options: {
      /** A stable key for a kept pause replayed after a proven stop, so a crash and a second settle never pause twice. */
      pauseKey?: string;
      /** The retried stop's proof, recorded with any stopped_fenced release of this outcome. */
      stopEvidence?: string;
    } = {},
  ): void {
    const fenced = (own: string) => options.stopEvidence ? `${options.stopEvidence}; ${own}` : own;
    if (outcome.type === "submitted") {
      // T4: the worker is done writing — release the packet claim so later
      // tasks can reuse its files/resources (best-effort, idempotent).
      this.transition(taskId, "submitted", attempt, {
        ...(outcome.reviewSignals ? { reviewSignals: structuredClone(outcome.reviewSignals) } : {}),
        ...(outcome.encodingSubmission ? { encodingSubmission: structuredClone(outcome.encodingSubmission) } : {}),
        ...(outcome.submissionScope ? { submissionScope: structuredClone(outcome.submissionScope) } : {}),
        ...(outcome.validationScope ? { validationScope: structuredClone(outcome.validationScope) } : {}),
        ...(outcome.validationBudget ? { validationBudget: structuredClone(outcome.validationBudget) } : {}),
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
      // Native lifecycle tools already persist guidance. Settle that exact
      // receipt instead of recreating its payload with a different key order.
      const projection = this.projection();
      const prior = projection.submissionScopePolicyVersion === 1 ? projection.guidance[outcome.requestId] : undefined;
      if (prior) {
        const events = this.store.readRun(this.runId);
        const receiptIndex = events.findIndex((event) => event.type === "guidance.requested" && event.payload.requestId === outcome.requestId);
        const receipt = events[receiptIndex];
        const receiptTask = receipt ? rebuildSchedulerProjection(events.slice(0, receiptIndex)).tasks[taskId] : undefined;
        const task = projection.tasks[taskId];
        if (!receipt || receipt.actor.role !== "worker" || receipt.actor.id !== workerId ||
          receiptTask?.status !== "running" || receiptTask.attempt !== attempt || receiptTask.assignedWorkerId !== workerId ||
          receipt.payload.question !== outcome.question || receipt.payload.blocking !== outcome.blocking || receipt.payload.evidenceSequence !== outcome.evidenceSequence ||
          receipt.payload.taskId !== taskId || task?.attempt !== attempt || task.assignedWorkerId !== workerId ||
          prior.taskId !== taskId || prior.blocking !== outcome.blocking || prior.question !== outcome.question ||
          prior.evidenceSequence !== outcome.evidenceSequence || prior.status !== "open") {
          throw new Error("Guidance outcome differs from the exact durable worker receipt.");
        }
      }
      this.releasePacketClaim(
        taskId,
        "stopped_fenced",
        fenced("driver returned: guidance"),
      );
      if (prior) return;
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
        fenced(`worker paused: ${outcome.reason}`),
      );
      const lastSequence = this.projection().lastSequence;
      this.store.append({
        runId: this.runId,
        type: "run.paused",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "scheduler" },
        idempotencyKey: options.pauseKey ?? `worker-pause:${taskId}:${attempt}:${lastSequence}`,
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
      fenced(`driver returned: ${outcome.reason}`),
    );
  }

  /**
   * The attempt's stop is unproven: keep the packet claim (no release of any
   * kind), keep `outcome` unrecorded, and pause the run. The task stays
   * running at this attempt, so nothing else is admitted into its claim.
   */
  private recordStopUnproven(
    task: BuildTask,
    assignment: WorkerAssignment,
    reason: string,
    outcome: SettledWorkerOutcome,
    abortedOverride?: boolean,
    contextRecordingFailure?: UnprovenWorkerStopProjection["contextRecordingFailure"],
  ): void {
    const aborted = abortedOverride ?? assignment.signal?.aborted === true;
    this.unrecordedStops.add(task.id);
    const lastSequence = this.projection().lastSequence;
    this.store.append({
      runId: this.runId,
      type: "worker.stop_unproven",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: `worker-stop-unproven:${task.id}:${task.attempt}:${lastSequence}`,
      payload: {
        taskId: task.id,
        attempt: task.attempt,
        workerId: assignment.workerId,
        reason: boundedDetail(reason) || "worker stop not proven",
        outcome: structuredClone(outcome),
        // An aborted attempt (owner pause, steering) keeps abort semantics:
        // once its stop is proven only the claim is released.
        ...(aborted ? { aborted: true } : {}),
        ...(contextRecordingFailure ? { contextRecordingFailure: structuredClone(contextRecordingFailure) } : {}),
      },
    });
    // Durable now: settle retries it even if the pause below fails.
    this.unrecordedStops.delete(task.id);
    this.pauseForUnprovenStop(task.id, task.attempt, reason);
  }

  private pauseForUnprovenStop(
    taskId: string,
    attempt: number,
    detail: string,
    reason = processStopUnprovenPauseReason(taskId),
  ): void {
    const lastSequence = this.projection().lastSequence;
    this.store.append({
      runId: this.runId,
      type: "run.paused",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: `worker-stop-unproven-pause:${taskId}:${attempt}:${lastSequence}`,
      payload: {
        reason,
        taskId,
        ...(boundedDetail(detail) ? { detail: boundedDetail(detail) } : {}),
      },
    });
  }

  private async settleUnprovenStopsInQueue(): Promise<"clear" | "paused"> {
    let projection = this.projection();
    // An unproven stop this process could not record (a store append
    // failed) leaves no durable stop to retry: stay paused, with no worker
    // and no Architect turn, until the Runner restarts. The restart then
    // retries the attempt's stop before running it again (tick).
    if (this.unrecordedStops.size > 0) {
      const [taskId] = [...this.unrecordedStops].sort();
      if (projection.status === "running") {
        try {
          this.pauseForUnprovenStop(taskId, projection.tasks[taskId]?.attempt ?? 0,
            "The Runner could not save the record that this worker's stop is unproven.",
            `${PROCESS_STOP_UNRECORDED_PAUSE_PREFIX}${taskId}`);
        } catch {
          // Still paused in this process: nothing runs while a stop is unrecorded.
        }
      }
      return "paused";
    }
    const pending = Object.values(projection.unprovenWorkerStops ?? {})
      .sort((left, right) => left.taskId.localeCompare(right.taskId));
    if (pending.length === 0) return "clear";
    if (projection.status !== "running") return "paused";
    for (const stop of pending) {
      const task = projection.tasks[stop.taskId];
      if (!task) {
        this.pauseForUnprovenStop(stop.taskId, stop.attempt, `Task ${stop.taskId} is missing from the run.`);
        return "paused";
      }
      const assignment: WorkerAssignment = {
        runId: this.runId,
        task: { ...task, attempt: stop.attempt },
        attempt: stop.attempt,
        workerId: stop.workerId,
        workspacePath: task.workspacePath ?? task.workspaceId ?? "",
      };
      try {
        if (!this.driver.retryStop) {
          throw new Error("This worker driver cannot retry an unproven stop.");
        }
        await this.driver.retryStop(assignment);
      } catch (error) {
        // Keep the first cause in front: the retry's own message alone
        // ("still not proven") would hide what failed.
        this.pauseForUnprovenStop(stop.taskId, stop.attempt, `${stop.reason} Retry: ${errorMessage(error)}`);
        return "paused";
      }
      const evidence = `worker stop proven on retry after: ${stop.reason}`;
      // The attempt goes on with the outcome it had, recorded while its
      // claim is still claimed and released through the outcome's own path,
      // as in dispatch (a submission's scope is bound to the live claim).
      // Nothing is recorded when the attempt was aborted (owner pause,
      // steering: an abort releases the claim only) or when the task moved
      // on meanwhile (cancelled, say).
      const current = this.projection().tasks[stop.taskId];
      const keeps = !stop.aborted && current?.status === "running" && current.attempt === stop.attempt;
      if (keeps && outcomeHeldBack(this.projection())) {
        // Pending guidance or an open question refuses every task outcome.
        // The stop stays pending with its claim kept, so nothing else runs
        // in its scope and the task is not run again; the outcome is
        // recorded at the first settle after the Architect has answered.
        // The run is not held paused: the Architect's turn must answer.
        continue;
      }
      if (keeps) {
        const kept = structuredClone(stop.outcome) as SettledWorkerOutcome;
        const options = {
          pauseKey: `worker-pause:${stop.taskId}:${stop.attempt}:stop:${stop.sequence}`,
          stopEvidence: evidence,
        };
        const note = stop.contextRecordingFailure;
        try {
          if (note) {
            // The note and its pause go together, as on the catch path in
            // dispatch: never a failure in their place, which would leave
            // the note unresolved and refuse the run's completion. Both
            // keys are stable, so a retry after a crash repeats neither.
            this.appendContextRecordingNote(stop.taskId, stop.attempt, note,
              `context-recording-failed:${stop.taskId}:${stop.attempt}:stop:${stop.sequence}`);
            this.recordOutcome(stop.taskId, stop.attempt, stop.workerId, kept, options);
          } else {
            try {
              this.recordOutcome(stop.taskId, stop.attempt, stop.workerId, kept, options);
            } catch (error) {
              // As in dispatch: an outcome that cannot be recorded is a failure.
              this.recordOutcome(stop.taskId, stop.attempt, stop.workerId, {
                type: "failed",
                reason: boundedDetail(errorMessage(error)),
              }, options);
            }
          }
        } catch (error) {
          // It could not be recorded: the stop stays pending with its
          // claim, and the run pauses with the cause instead of retrying
          // (and throwing) on every pass. Resume tries to record it again.
          this.pauseForUnprovenStop(stop.taskId, stop.attempt,
            `The worker's stop was proven, but the outcome of its attempt could not be saved: ${errorMessage(error)}`,
            `${PROCESS_STOP_OUTCOME_UNRECORDED_PAUSE_PREFIX}${stop.taskId}`);
          return "paused";
        }
      }
      // No outcome recorded, or a crash after it and before the release:
      // release the claim as stopped_fenced now (a no-op without a live
      // claim). Then clear the pending stop. A crash anywhere before that
      // leaves the stop pending, and the next settle repeats only what is
      // missing (the kept pause has a stable key).
      this.releasePacketClaim(stop.taskId, "stopped_fenced", evidence);
      this.store.append({
        runId: this.runId,
        type: "worker.stop_proven",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "scheduler" },
        idempotencyKey: `worker-stop-proven:${stop.taskId}:${stop.attempt}:${stop.sequence}`,
        payload: { taskId: stop.taskId, attempt: stop.attempt, evidence },
      });
      projection = this.projection();
      if (projection.status !== "running") return "paused";
    }
    return "clear";
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
      // An unproven stop keeps its claim until the retried stop is proven.
      if (projection.unprovenWorkerStops?.[task.id]) continue;
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

/**
 * Pending guidance or an open blocking question refuses every task outcome
 * (scheduler-store guidance gates), so a kept outcome waits for the answer.
 */
function outcomeHeldBack(projection: SchedulerProjection): boolean {
  return hasPendingUserGuidance(projection) || Boolean(projection.blockingArchitectQuestionId);
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

/** Pause details and stop reasons stay readable: aggregated cleanup errors can be long. */
function boundedDetail(text: string): string {
  return boundedText(text);
}
