import type {
  AgentToolRuntime,
} from "./tool-registry.js";
import type { ToolExecutionContext } from "./agent-contracts.js";
import { createArchitectTools } from "./architect-tools.js";
import type { NativeBuildRunPolicy } from "./build-spec.js";
import type {
  ProjectHandoffChoice,
  SchedulerActor,
  SchedulerProjection,
  SchedulerStore,
} from "./scheduler-store.js";
import {
  deriveFinalVerificationFailure,
  rebuildSchedulerProjection,
} from "./scheduler-store.js";
import type { BuildTask } from "./task-contracts.js";
import type { EvidenceStore } from "./evidence-store.js";
import type {
  FinalVerificationCategory,
  FinalVerificationPlan,
} from "./final-verification-contracts.js";
import type {
  FinalVerificationCheckResult,
  FinalVerificationRun,
} from "./final-verification-runtime.js";
import { submitFinalVerification } from "./final-verification-submission.js";
import {
  TaskScheduler,
  type TaskSchedulerOptions,
  type WorkerRuntimeDriver,
} from "./task-scheduler.js";
import { ToolRegistry } from "./tool-registry.js";

export type ArchitectActionReason =
  | { type: "plan_required" }
  | { type: "acceptance_contract_upgrade_required" }
  | { type: "guidance_required"; requestId: string; taskId: string }
  | { type: "review_required"; taskId: string; changeSetId: string }
  | { type: "integration_approval_required"; taskId: string; changeSetId: string }
  | { type: "completion_decision_required"; runPolicy?: "plan_only" }
  | {
      type: "final_verification_plan_required";
      integrationRevision: string;
    }
  | {
      type: "final_verification_review_required";
      taskId: string;
      generationId: string;
      submissionId: string;
      targetRevision: string;
    }
  | {
      type: "final_verification_repair_plan_required";
      finalVerificationTaskId: string;
      generationId: string;
      targetRevision: string;
      source:
        | { type: "semantic_review"; submissionId: string; reviewId: string }
        | { type: "mechanical_failure"; failureId: string; issueIds: string[]; factIds: string[] };
      failedCategories: string[];
      evidenceIds: string[];
    }
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
  providerRetryDeadlineMs?: number;
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

export interface FinalVerificationCheckDriverInput {
  runId: string;
  taskId: string;
  generationId: string;
  targetRevision: string;
  attempt: number;
  plan: FinalVerificationPlan;
  category: FinalVerificationCategory;
  signal?: AbortSignal;
}

export interface FinalVerificationCheckExecution {
  workspacePath: string;
  startedAt: string;
  finishedAt: string;
  check: FinalVerificationCheckResult;
}

export interface FinalVerificationCheckDriver {
  executeCheck(input: FinalVerificationCheckDriverInput): Promise<FinalVerificationCheckExecution>;
}

export interface FinalVerificationCleanupDriver {
  cleanup(input: {
    runId: string;
    generationId: string;
    taskId: string;
    targetRevision: string;
    attempt: number;
    failed?: {
      generationId: string;
      taskId: string;
      targetRevision: string;
      checks: readonly unknown[];
      evidenceReferences: readonly string[];
      logs?: readonly string[];
    };
  }): Promise<{ diagnosticsPath?: string }>;
}

export interface BuildRuntimeOptions {
  runId: string;
  runPolicy?: NativeBuildRunPolicy;
  store: SchedulerStore;
  workerDriver: WorkerRuntimeDriver;
  architectDriver: ArchitectRuntimeDriver;
  integrationDriver: IntegrationRuntimeDriver;
  maxConcurrency: number;
  workspaceFor: TaskSchedulerOptions["workspaceFor"];
  maxTaskAttempts?: number;
  architectId?: string;
  clock?: () => string;
  renewBudgetWindow?: (idempotencyKey: string, occurredAt: string) => void;
  providerRetryDeadlineMs?: () => number | undefined;
  evidenceStore?: EvidenceStore;
  finalVerificationDriver?: FinalVerificationCheckDriver;
  finalVerificationCleanupDriver?: FinalVerificationCleanupDriver;
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
  private readonly runPolicy: NativeBuildRunPolicy;
  private readonly maxTaskAttempts: number;
  private readonly architectId: string;
  private readonly clock: () => string;
  private readonly renewBudgetWindow?: BuildRuntimeOptions["renewBudgetWindow"];
  private readonly providerRetryDeadlineMs?: BuildRuntimeOptions["providerRetryDeadlineMs"];
  private readonly evidenceStore?: EvidenceStore;
  private readonly finalVerificationDriver?: FinalVerificationCheckDriver;
  private readonly finalVerificationCleanupDriver?: FinalVerificationCleanupDriver;
  private lifecycleController = new AbortController();
  private stepQueue = Promise.resolve();

  constructor(options: BuildRuntimeOptions) {
    this.id = options.runId;
    this.runId = options.runId;
    this.store = options.store;
    this.architectDriver = options.architectDriver;
    this.integrationDriver = options.integrationDriver;
    this.runPolicy = options.runPolicy ?? "finish";
    this.maxTaskAttempts = options.maxTaskAttempts ?? 2;
    this.architectId = options.architectId ?? "architect_1";
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.renewBudgetWindow = options.renewBudgetWindow;
    this.providerRetryDeadlineMs = options.providerRetryDeadlineMs;
    this.evidenceStore = options.evidenceStore;
    this.finalVerificationDriver = options.finalVerificationDriver;
    this.finalVerificationCleanupDriver = options.finalVerificationCleanupDriver;
    this.configureRunPolicy();
    this.scheduler = new TaskScheduler({
      runId: options.runId,
      store: options.store,
      driver: options.workerDriver,
      maxConcurrency: options.maxConcurrency,
      workspaceFor: options.workspaceFor,
      maxTaskAttempts: options.maxTaskAttempts,
      clock: this.clock,
      lifecycleSignal: () => this.activeLifecycleSignal(),
      providerRetryDeadlineMs: this.providerRetryDeadlineMs,
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
    this.lifecycleController.abort(
      new DOMException(`Build ${this.runId} paused.`, "AbortError")
    );
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
    return this.resumeInternal(idempotencyKey, true);
  }

  continue(idempotencyKey: string): SchedulerProjection {
    return this.resumeInternal(idempotencyKey, false);
  }

  private resumeInternal(
    idempotencyKey: string,
    renewBudgetWindow: boolean
  ): SchedulerProjection {
    this.ensureInitialized();
    const projection = this.projection();
    if (projection.status === "completed") {
      throw new Error("A completed Build cannot be resumed.");
    }
    if (!renewBudgetWindow && projection.status !== "paused") {
      throw new Error("A benchmark continuation requires a paused Build.");
    }
    if (this.lifecycleController.signal.aborted) {
      this.lifecycleController = new AbortController();
    }
    if (projection.projectHandoff?.status === "requested") {
      throw new Error(
        "This Build is awaiting the user's final project handoff selection."
      );
    }
    const occurredAt = this.clock();
    if (
      renewBudgetWindow &&
      projection.status === "paused" &&
      this.runPolicy === "budgeted"
    ) {
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
      projectRevision?: string;
    },
    idempotencyKey: string,
    actor: SchedulerActor = { role: "user", id: "local-user" }
  ): SchedulerProjection {
    this.store.append({
      runId: this.runId,
      type: "project.handoff_selected",
      occurredAt: this.clock(),
      actor,
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
    return { status: "progressed", action: "step_allowance_yielded" };
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
    if (
      projection.acceptanceContractStatus ===
      "acceptance_contract_upgrade_required"
    ) {
      if (
        !events.some((event) => event.type === "acceptance_contract.upgrade_required")
      ) {
        this.store.append({
          runId: this.runId,
          type: "acceptance_contract.upgrade_required",
          occurredAt: this.clock(),
          actor: { role: "runner", id: "build-runtime" },
          idempotencyKey: "acceptance-contract-upgrade-required",
          payload: {
            taskIds: Object.values(projection.tasks)
              .filter(
                (task) =>
                  task.status !== "cancelled" &&
                  task.acceptanceCriteria === undefined
              )
              .map((task) => task.id)
              .sort(),
          },
        });
        projection = this.projection();
      }
      await this.runArchitect(
        { type: "acceptance_contract_upgrade_required" },
        projection
      );
      return this.afterArchitect("acceptance_contract_upgrade_required");
    }
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

    if (this.runPolicy === "plan_only") {
      await this.runArchitect({
        type: "completion_decision_required",
        runPolicy: "plan_only",
      }, projection);
      return this.afterArchitect("completion_decision_required");
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
    const finalVerification = projection.finalVerification?.current;
    if (finalVerification) {
      const result = await this.advanceFinalVerification(finalVerification);
      if (result) return result;
    }
    const tasks = Object.values(projection.tasks);
    const implementationTasks = tasks.filter(
      (task) => task.kind !== "final_verification"
    );
    const implementationTasksTerminal = implementationTasks.every(
      (task) => task.status === "integrated" || task.status === "cancelled"
    );
    if (
      implementationTasksTerminal &&
      projection.integrationRevision &&
      !projection.finalVerification?.current
    ) {
      await this.runArchitect({
        type: "final_verification_plan_required",
        integrationRevision: projection.integrationRevision,
      }, projection);
      const planned = this.projection().finalVerification?.current;
      if (!planned || planned.targetRevision !== projection.integrationRevision) {
        throw new Error(
          "Architect returned from final_verification_plan_required without a typed action."
        );
      }
      return this.afterArchitect("final_verification_plan_required");
    }
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

  private async advanceFinalVerification(
    generation: NonNullable<SchedulerProjection["finalVerification"]>["current"] & {},
  ): Promise<BuildStepResult | undefined> {
    if (generation.submission) {
      if (!generation.submissionResult) {
        return { status: "idle", action: "final_verification_submission_unvalidated" };
      }
      if (generation.cleanup?.status !== "succeeded") {
        return await this.advanceFinalVerificationCleanup(generation);
      }
      if (generation.review?.status === "approved") {
        await this.runArchitect(
          { type: "completion_decision_required" },
          this.projection(),
        );
        const completed = this.projection();
        if (completed.projectHandoff?.status !== "requested") {
          throw new Error(
            "Architect returned from completion_decision_required without a typed action.",
          );
        }
        return this.afterArchitect("completion_decision_required");
      }
      if (
        generation.review?.status === "repair_required" ||
        generation.review?.status === "rejected"
      ) {
        if (generation.review.status === "rejected") {
          return { status: "idle", action: "final_verification_repair_required" };
        }
        if (generation.repairTaskIds?.length) return undefined;
        const decision = generation.review.decision;
        if (!decision) {
          throw new Error("Final verification repair review lacks a structured decision.");
        }
        await this.runArchitect({
          type: "final_verification_repair_plan_required",
          finalVerificationTaskId: generation.taskId,
          generationId: generation.generationId,
          targetRevision: generation.targetRevision,
          source: {
            type: "semantic_review",
            submissionId: generation.submission.submissionId,
            reviewId: generation.review.reviewId,
          },
          failedCategories: [...decision.failedCategories],
          evidenceIds: [...new Set(decision.categoryReviews.flatMap(
            (review) => review.verdict === "repair_required" ? review.evidenceIds : [],
          ))],
        }, this.projection());
        const repaired = this.projection().finalVerification?.current;
        if (
          repaired?.generationId !== generation.generationId ||
          !repaired.repairTaskIds?.length
        ) {
          throw new Error(
            "Architect returned from final_verification_repair_plan_required without a typed action.",
          );
        }
        return this.afterArchitect("final_verification_repair_plan_required");
      }
      const reviewId = `final-verification-review:${generation.generationId}`;
      if (!generation.review) {
        this.store.append({
          runId: this.runId,
          type: "final_verification.review_requested",
          occurredAt: this.clock(),
          actor: { role: "runner", id: "build-runtime" },
          idempotencyKey: `${generation.generationId}:review-request`,
          payload: {
            taskId: generation.taskId,
            generationId: generation.generationId,
            targetRevision: generation.targetRevision,
            submissionId: generation.submission.submissionId,
            reviewId,
            attempt: generation.submission.attempt,
          },
        });
      }
      const current = this.projection().finalVerification?.current;
      if (!current?.submission || current.review?.status !== "requested") {
        throw new Error("Final verification review request was not durably recorded.");
      }
      await this.runArchitect({
        type: "final_verification_review_required",
        taskId: current.taskId,
        generationId: current.generationId,
        submissionId: current.submission.submissionId,
        targetRevision: current.targetRevision,
      }, this.projection());
      const reviewed = this.projection().finalVerification?.current;
      if (
        reviewed?.generationId !== current.generationId ||
        reviewed.review?.status === "requested" ||
        !reviewed.review
      ) {
        throw new Error(
          "Architect returned from final_verification_review_required without a typed action.",
        );
      }
      return this.afterArchitect("final_verification_review_required");
    }
    if (generation.completedChecks?.some((check) => !check.green)) {
      if (!generation.failure) {
        const failure = deriveFinalVerificationFailure(generation, 1);
        this.store.append({
          runId: this.runId,
          type: "final_verification.failure_reported",
          occurredAt: this.clock(),
          actor: { role: "runner", id: "build-runtime" },
          idempotencyKey: `${generation.generationId}:failure:${failure.failureId}`,
          payload: failure,
        });
        return { status: "progressed", action: "final_verification_failure_reported" };
      }
      if (generation.cleanup?.status !== "succeeded") {
        return await this.advanceFinalVerificationCleanup(generation);
      }
      if (generation.repairTaskIds?.length) return undefined;
      await this.runArchitect({
        type: "final_verification_repair_plan_required",
        finalVerificationTaskId: generation.taskId,
        generationId: generation.generationId,
        targetRevision: generation.targetRevision,
        source: {
          type: "mechanical_failure",
          failureId: generation.failure.failureId,
          issueIds: [...generation.failure.issueIds],
          factIds: [...generation.failure.factIds],
        },
        failedCategories: [...generation.failure.failedCategories],
        evidenceIds: [...generation.failure.evidenceIds],
      }, this.projection());
      const repaired = this.projection().finalVerification?.current;
      if (repaired?.generationId !== generation.generationId || !repaired.repairTaskIds?.length) {
        throw new Error(
          "Architect returned from final_verification_repair_plan_required without a typed action.",
        );
      }
      return this.afterArchitect("final_verification_repair_plan_required");
    }
    const pending = generation.plan.checks.find(
      (planned) => !generation.completedChecks?.some(
        (completed) => completed.category === planned.category,
      ),
    );
    if (pending) {
      if (!this.finalVerificationDriver) {
        throw new Error("Final verification execution requires a FinalVerificationCheckDriver.");
      }
      let result: FinalVerificationCheckExecution;
      try {
        result = await this.finalVerificationDriver.executeCheck({
          runId: this.runId,
          taskId: generation.taskId,
          generationId: generation.generationId,
          targetRevision: generation.targetRevision,
          attempt: 1,
          plan: generation.plan,
          category: pending.category,
          signal: this.activeLifecycleSignal(),
        });
      } catch (error) {
        if (!this.isCurrentGeneration(generation)) {
          return { status: "progressed", action: "final_verification_invalidated" };
        }
        throw error;
      }
      if (!this.isCurrentGeneration(generation)) {
        return { status: "progressed", action: "final_verification_invalidated" };
      }
      if (result.check.category !== pending.category) {
        throw new Error(
          `Final verification driver returned ${result.check.category} for ${pending.category}.`,
        );
      }
      this.store.append({
        runId: this.runId,
        type: "final_verification.check_completed",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `${generation.generationId}:check:${pending.category}`,
        payload: {
          generationId: generation.generationId,
          taskId: generation.taskId,
          targetRevision: generation.targetRevision,
          attempt: 1,
          workspacePath: result.workspacePath,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          result: result.check,
        },
      });
      const status = this.projection().status === "paused" ? "paused" : "progressed";
      return {
        status,
        action: result.check.green
          ? "final_verification_check_completed"
          : "final_verification_check_non_green",
      };
    }
    if (!this.evidenceStore) {
      throw new Error("Final verification submission requires an EvidenceStore.");
    }
    const completed = generation.completedChecks ?? [];
    const run: FinalVerificationRun = {
      generationId: generation.generationId,
      runId: this.runId,
      taskId: generation.taskId,
      attempt: 1,
      plan: generation.plan,
      targetRevision: generation.targetRevision,
      workspacePath: completed[0]!.workspacePath,
      startedAt: completed[0]!.startedAt,
      finishedAt: completed.at(-1)!.finishedAt,
      checks: completed.map(({ attempt: _attempt, workspacePath: _workspacePath,
        startedAt: _startedAt, finishedAt: _finishedAt, ...check }) => check),
      green: true,
    };
    const submission = await submitFinalVerification(
      { plan: generation.plan, run },
      {
        evidenceStore: this.evidenceStore,
        currentIntegrationRevision: () => this.projection().integrationRevision ?? "",
        clock: this.clock,
      },
    );
    if (!this.isCurrentGeneration(generation)) {
      return { status: "progressed", action: "final_verification_invalidated" };
    }
    this.store.append({
      runId: this.runId,
      type: "final_verification.submitted",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `${generation.generationId}:submission`,
      payload: {
        generationId: generation.generationId,
        taskId: generation.taskId,
        targetRevision: generation.targetRevision,
        submissionId: `final-verification-submission:${generation.generationId}`,
        attempt: 1,
        submissionResult: submission,
      },
    });
    return { status: "progressed", action: "final_verification_submitted" };
  }

  private async advanceFinalVerificationCleanup(
    generation: NonNullable<SchedulerProjection["finalVerification"]>["current"] & {},
  ): Promise<BuildStepResult> {
    if (!this.finalVerificationCleanupDriver) {
      throw new Error("Final verification cleanup requires an exact-owned cleanup driver.");
    }
    let cleanup = generation.cleanup;
    if (!cleanup || cleanup.status === "failed") {
      const attempt = (cleanup?.attempt ?? 0) + 1;
      this.store.append({
        runId: this.runId,
        type: "final_verification.cleanup_started",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `${generation.generationId}:cleanup:${attempt}:started`,
        payload: {
          generationId: generation.generationId,
          taskId: generation.taskId,
          targetRevision: generation.targetRevision,
          attempt,
        },
      });
      cleanup = this.projection().finalVerification?.current?.cleanup;
    }
    if (!cleanup || cleanup.status !== "started") {
      throw new Error("Final verification cleanup start was not durably recorded.");
    }
    try {
      const result = await this.finalVerificationCleanupDriver.cleanup({
        runId: this.runId,
        generationId: generation.generationId,
        taskId: generation.taskId,
        targetRevision: generation.targetRevision,
        attempt: cleanup.attempt,
        ...(generation.failure ? {
          failed: {
            generationId: generation.generationId,
            taskId: generation.taskId,
            targetRevision: generation.targetRevision,
            checks: [...(generation.completedChecks ?? [])],
            evidenceReferences: [...generation.failure.evidenceIds],
            logs: (generation.completedChecks ?? [])
              .filter((check) => !check.green)
              .flatMap((check) => check.issues),
          },
        } : {}),
      });
      if (!this.isCurrentGeneration(generation)) {
        return { status: "progressed", action: "final_verification_invalidated" };
      }
      this.store.append({
        runId: this.runId,
        type: "final_verification.cleanup_succeeded",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `${generation.generationId}:cleanup:${cleanup.attempt}:succeeded`,
        payload: {
          generationId: generation.generationId,
          taskId: generation.taskId,
          targetRevision: generation.targetRevision,
          attempt: cleanup.attempt,
          ...(result.diagnosticsPath ? { diagnosticsPath: result.diagnosticsPath } : {}),
        },
      });
      return { status: "progressed", action: "final_verification_cleanup_succeeded" };
    } catch (error) {
      if (!this.isCurrentGeneration(generation)) {
        return { status: "progressed", action: "final_verification_invalidated" };
      }
      this.store.append({
        runId: this.runId,
        type: "final_verification.cleanup_failed",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `${generation.generationId}:cleanup:${cleanup.attempt}:failed`,
        payload: {
          generationId: generation.generationId,
          taskId: generation.taskId,
          targetRevision: generation.targetRevision,
          attempt: cleanup.attempt,
          error: boundedCleanupError(error),
        },
      });
      return { status: "progressed", action: "final_verification_cleanup_failed" };
    }
  }

  private isCurrentGeneration(
    generation: NonNullable<SchedulerProjection["finalVerification"]>["current"] & {},
  ): boolean {
    const projection = this.projection();
    const current = projection.finalVerification?.current;
    return projection.integrationRevision === generation.targetRevision &&
      current?.generationId === generation.generationId &&
      current.targetRevision === generation.targetRevision;
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
    const providerRetryDeadlineMs = this.providerRetryDeadlineMs?.();
    const tools = new ToolRegistry();
    for (const tool of createArchitectTools({
      store: this.store,
      clock: this.clock,
      runPolicy: this.runPolicy,
      planOnlyCompletionAvailable:
        this.runPolicy === "plan_only" &&
        reason.type === "completion_decision_required" &&
        projection.planRevision > 0,
      finalVerificationPlanAvailable:
        reason.type === "final_verification_plan_required",
      finalVerificationReviewAvailable:
        reason.type === "final_verification_review_required",
      finalVerificationRepairPlanAvailable:
        reason.type === "final_verification_repair_plan_required",
      ...(this.evidenceStore ? { evidenceStore: this.evidenceStore } : {}),
    })) {
      tools.register(tool);
    }
    await this.architectDriver.run({
      runId: this.runId,
      reason,
      projection,
      tools,
      ...(providerRetryDeadlineMs !== undefined
        ? { providerRetryDeadlineMs }
        : {}),
      context: {
        runId: this.runId,
        sessionId: `architect:${this.runId}`,
        actor: { role: "architect", id: this.architectId },
        signal: this.activeLifecycleSignal(),
      },
    });
    const sequenceAfter = this.store.readRun(this.runId).at(-1)?.sequence ?? 0;
    if (sequenceAfter <= sequenceBefore) {
      throw new Error(
        `Architect returned from ${reason.type} without a typed action.`
      );
    }
  }

  private activeLifecycleSignal(): AbortSignal {
    if (
      this.lifecycleController.signal.aborted &&
      this.projection().status === "running"
    ) {
      this.lifecycleController = new AbortController();
    }
    return this.lifecycleController.signal;
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

  private configureRunPolicy(): void {
    const events = this.store.readRun(this.runId);
    if (events.length > 0) {
      const recovered = rebuildSchedulerProjection(events);
      if (recovered.runPolicy && recovered.runPolicy !== this.runPolicy) {
        throw new Error(
          `Scheduler run policy is already configured as ${recovered.runPolicy}.`
        );
      }
    }
    this.store.append({
      runId: this.runId,
      type: "run.policy_configured",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "run-policy-configured",
      payload: { runPolicy: this.runPolicy },
    });
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
    acceptanceContractStatus: "current",
    acceptanceUpgradeRequiredEventRecorded: false,
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

function boundedCleanupError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\b(token|password|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s]+/gi, "$1=[REDACTED]")
    .slice(0, 4_096) || "Final verification cleanup failed.";
}
