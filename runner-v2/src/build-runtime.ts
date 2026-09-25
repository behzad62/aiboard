import { createHash } from "node:crypto";

import type {
  AgentToolRuntime,
} from "./tool-registry.js";
import type { NativeTool, ToolExecutionContext } from "./agent-contracts.js";
import { createArchitectTools, type ArchitectToolsOptions } from "./architect-tools.js";
import { ANSWER_PATH_LIFECYCLE_TOOLS, ARCHITECT_LIFECYCLE_TOOLS } from "./role-capabilities.js";
import type { NativeBuildRunPolicy } from "./build-spec.js";
import type {
  BuildRiskAssessmentProjection,
  ProjectHandoffChoice,
  SchedulerActor,
  SchedulerEvent,
  SchedulerProjection,
  SchedulerStore,
} from "./scheduler-store.js";
import {
  clearContextRecordingSuspension,
  ContextManifestRecordingError,
  suspendContextRecording,
} from "./context-manifest-store.js";
import {
  architectLifecycleEventMatchesReason,
  buildCompletionReadiness,
  contextRecordingRetriesRemaining,
  currentAnswerReviewVerdict,
  DEFAULT_REPAIR_PLAN_LIMIT,
  deriveFinalVerificationFailure,
  isAnsweredRun,
  isPlanningState,
  latestAnswerReviewVerdict,
  latestUnresolvedContextRecordingNote,
  newPolicyStaleTasksRequireArchitect,
  nextAnswerReviewId,
  readyPlanIdentity,
  rebuildSchedulerProjection,
  repairCyclesExhausted,
} from "./scheduler-store.js";
import type { PlanningSourceReader } from "./planning-tools.js";
import {
  DEFAULT_COVERAGE_SUSPENDED_RETRY_LIMIT,
  SchedulerCoverageReviewAuthority,
  TERMINAL_COVERAGE_GATE_REASONS,
  type CoverageReviewDriver,
  type NativeCoverageReviewRequest,
  type PlanningHostCapabilitiesProvider,
} from "./planning-review.js";
import {
  DELIVERY_ACCEPTANCE_RUNNER_ID,
  beforeFailingCheckRepairCharge,
  beforeRepairDecisionDispatch,
  currentSubmissionReview,
  deliveryBoundaryAction,
  deliveryBoundaryId,
  evaluatePhaseAcceptance,
  openBlockingFindings,
  phaseAcceptanceKey,
  unverifiedClaims,
  type DeliveryBoundaryCheck,
} from "./delivery-acceptance.js";
import type { NativeDeliverableReviewResult } from "./native-deliverable-review.js";
import {
  SchedulerAnswerReviewAuthority,
  type AnswerReviewAuthority,
  type AnswerReviewDriver,
} from "./request-triage.js";
import { computePlanReadiness, coverageReviewHoldsReadiness } from "./planning-contracts.js";
import { coveragePlanReadinessInput, openBlockingCoverageFindings } from "./planning-projection.js";
import type { BuildTask } from "./task-contracts.js";
import type { EvidenceStore } from "./evidence-store.js";
import type {
  DocumentTipRelation,
  ProjectDocCommitRequest,
  ProjectDocCommitResult,
} from "./project-docs.js";
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
import { redactSensitiveText } from "./sensitive-redaction.js";
import type { FinalVerificationExecutionProfile } from "./final-verification-profile.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { ArchitectActionReason } from "./user-steering-contracts.js";
import {
  assessBuildRisk,
  type BuildRiskAssessmentInput,
} from "./risk-policy.js";
import {
  assessPlanRisk,
  planCritiqueRequired,
  type PlanCritiqueMode,
  type PlanCritiqueSkipReason,
  type PlanRiskLevel,
  type PlanRiskReason,
} from "./plan-critique-contracts.js";
export type { ArchitectActionReason } from "./user-steering-contracts.js";

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
  executionProfile: FinalVerificationExecutionProfile;
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

export interface IndependentVerifierRequest {
  runId: string;
  projection: SchedulerProjection;
  risk: BuildRiskAssessmentProjection;
  preferredRuntimeId?: string;
  signal?: AbortSignal;
}

export type IndependentVerifierResult =
  | { status: "verdict_submitted" }
  | {
      status: "unavailable";
      reason:
        | "no_independent_healthy_capability_match"
        | "runtime_unavailable";
    }
  | {
      status: "suspended";
      reason: string;
      runtimeId?: string;
      error?: string;
    };

export interface IndependentVerifierDriver {
  candidateRuntimeIds: readonly string[];
  /** Optional only for legacy/test drivers; production always supplies it. */
  alwaysRequireIndependentVerifier?: boolean;
  /** New runs default to two-pass; absent keeps a caller on single-pass. */
  twoPass?: boolean;
  assessRisk(input: {
    runId: string;
    projection: SchedulerProjection;
  }): Promise<BuildRiskAssessmentInput>;
  verify(input: IndependentVerifierRequest): Promise<IndependentVerifierResult>;
}

export type PlanCriticResult =
  | { status: "submitted"; critiqueId: string }
  | { status: "unavailable"; reason: "no_independent_healthy_capability_match" | "runtime_unavailable" }
  | { status: "suspended"; reason: string; runtimeId?: string; error?: string };

export interface PlanCriticDriver {
  candidateRuntimeIds: readonly string[];
  mode: PlanCritiqueMode;
  stricterQualification: boolean;
  architectDeclaration(projection: SchedulerProjection): PlanRiskLevel;
  critique(input: {
    runId: string;
    projection: SchedulerProjection;
    riskReasons: readonly PlanRiskReason[];
    preferredRuntimeId?: string;
    signal?: AbortSignal;
  }): Promise<PlanCriticResult>;
}

/** T6a: the mandatory deliverable reviewer (NativeDeliverableReviewRuntime in production). */
export interface DeliveryReviewDriver {
  review(input: {
    runId: string;
    taskId: string;
    signal?: AbortSignal;
    providerRetryDeadlineMs?: number;
  }): Promise<NativeDeliverableReviewResult>;
}

/**
 * T6a: runs the affected checks for an integrated task at the CURRENT
 * integration revision through the audited executor and returns the real
 * outcomes (never placeholders; a check that cannot run is `unknown`).
 */
export interface DeliveryBoundaryDriver {
  check(input: {
    runId: string;
    taskId: string;
    boundaryId: string;
    /** N-R4-3: the durably started attempt; scopes process and evidence keys. */
    attempt: number;
    integrationRevision: string;
    signal?: AbortSignal;
  }): Promise<{
    changedFiles: string[];
    selection: { rung: string; selectedTests: string[] };
    checks: DeliveryBoundaryCheck[];
  }>;
}
export interface BuildRuntimeOptions {
  runId: string;
  initialObjective?: string;
  runPolicy?: NativeBuildRunPolicy;
  store: SchedulerStore;
  workerDriver: WorkerRuntimeDriver;
  architectDriver: ArchitectRuntimeDriver;
  integrationDriver: IntegrationRuntimeDriver;
  deliveryReview?: DeliveryReviewDriver;
  deliveryBoundary?: DeliveryBoundaryDriver;
  maxConcurrency: number;
  /**
   * T4: actual resource/provider capacity when the host reports one,
   * forwarded to the scheduler. New-policy pump admission is bounded by
   * `min(MAX_WORKERS, maxConcurrency, resourceCapacity)`; legacy capacity
   * is unchanged. Absent means unknown (no further bound).
   */
  resourceCapacity?: TaskSchedulerOptions["resourceCapacity"];
  workspaceFor: TaskSchedulerOptions["workspaceFor"];
  maxTaskAttempts?: number;
  architectId?: string;
  clock?: () => string;
  renewBudgetWindow?: (idempotencyKey: string, occurredAt: string) => void;
  providerRetryDeadlineMs?: () => number | undefined;
  evidenceStore?: EvidenceStore;
  artifacts?: ArtifactStore;
  /** Commits Architect project documents on the integration branch. */
  projectDocs?: ProjectDocsPort;
  finalVerificationDriver?: FinalVerificationCheckDriver;
  finalVerificationCleanupDriver?: FinalVerificationCleanupDriver;
  finalVerificationProfileFor?: (targetRevision: string) => Promise<FinalVerificationExecutionProfile>;
  discardFinalVerificationProfile?: (profile: FinalVerificationExecutionProfile) => Promise<void>;
  independentVerifier?: IndependentVerifierDriver;
  planCritic?: PlanCriticDriver;
  repairPlanLimit?: number;
  /** Test probe applied to lifecycle tools immediately before the allow-list assert. */
  architectLifecycleProbe?: (
    tools: readonly NativeTool<unknown>[],
  ) => readonly NativeTool<unknown>[];
  /**
   * Supplies approved-source bytes for new-policy planning reads. When absent
   * the read tool falls back to the artifact store by artifact digest, and
   * errors explicitly when neither is provisioned.
   */
  planningSourceReader?: PlanningSourceReader;
  /**
   * T3b: drives the independent source-coverage review for new-policy runs.
   * When absent, a requested review records an explicit outstanding gate
   * instead of running. Legacy runs never consult it.
   */
  coverageReview?: CoverageReviewDriver;
  /**
   * T9 (OA-5): drives the opt-in independent answer review as a sibling of
   * the other reviewer drivers. Consulted only for triage-`answer` runs with
   * a recorded user opt-in and no verdict yet; every other run ignores it.
   * When set, candidateRuntimeIds must be unique and non-empty.
   */
  answerReview?: AnswerReviewDriver;
  /**
   * T3b: supplies host capabilities for the plan_ready transition. Required
   * before a bound non-blocking review can become ready.
   */
  planningHostCapabilities?: PlanningHostCapabilitiesProvider;
  /**
   * T3b repair cycle 1 (N6): bound on suspended-review retries per review.
   * Independent from repairPlanLimit (G-5). On exhaustion the runtime
   * records an explicit outstanding gate for the owner and never loops.
   */
  coverageSuspendedRetryLimit?: number;
}

export interface ProjectDocsPort {
  commit(input: ProjectDocCommitRequest): Promise<ProjectDocCommitResult>;
  relateRevision(input: { revision: string; tip: string }): Promise<DocumentTipRelation>;
}

export interface BuildStepResult {
  status: "progressed" | "paused" | "completed" | "idle" | "blocked" | "failed";
  action?: string;
}

/** Mechanical step shape of a projection after a context-recording decision turn. */
export function buildStepResultForProjection(
  projection: SchedulerProjection,
): BuildStepResult {
  if (projection.status === "completed") return { status: "completed" };
  if (projection.status === "failed") {
    return {
      status: "failed",
      action: projection.failureReason ?? "context_recording_aborted",
    };
  }
  if (projection.status === "paused" || projection.status === "stopped") {
    return projection.pauseReason?.reason
      ? { status: "paused", action: projection.pauseReason.reason }
      : { status: "paused" };
  }
  return { status: "progressed" };
}

/**
 * T9 (OA-5): the first answer-review id the pump drives per run. Repair
 * cycle 1 (B1): a re-recorded answer after a verdict drives a re-review as
 * `answer_review_{n}` (see `nextAnswerReviewId`) with the latest verdict
 * attached as the prior review (OA-10 #2).
 */
export const ANSWER_REVIEW_ID = "answer_review_1";

export class BuildRuntime {
  readonly id: string;
  private readonly runId: string;
  private readonly initialObjective?: string;
  private readonly store: SchedulerStore;
  private readonly scheduler: TaskScheduler;
  private readonly architectDriver: ArchitectRuntimeDriver;
  private readonly integrationDriver: IntegrationRuntimeDriver;
  private readonly deliveryReview?: DeliveryReviewDriver;
  private readonly deliveryBoundary?: DeliveryBoundaryDriver;
  private readonly runPolicy: NativeBuildRunPolicy;
  private readonly maxTaskAttempts: number;
  private readonly resourceCapacity?: TaskSchedulerOptions["resourceCapacity"];
  private readonly architectId: string;
  private readonly clock: () => string;
  private readonly renewBudgetWindow?: BuildRuntimeOptions["renewBudgetWindow"];
  private readonly providerRetryDeadlineMs?: BuildRuntimeOptions["providerRetryDeadlineMs"];
  private readonly evidenceStore?: EvidenceStore;
  private readonly artifacts?: ArtifactStore;
  private readonly projectDocs?: ProjectDocsPort;
  private readonly finalVerificationDriver?: FinalVerificationCheckDriver;
  private readonly finalVerificationCleanupDriver?: FinalVerificationCleanupDriver;
  private readonly finalVerificationProfileFor?: BuildRuntimeOptions["finalVerificationProfileFor"];
  private readonly discardFinalVerificationProfile?: BuildRuntimeOptions["discardFinalVerificationProfile"];
  private readonly independentVerifier?: IndependentVerifierDriver;
  private readonly planCritic?: PlanCriticDriver;
  private readonly repairPlanLimit: number;
  private readonly architectLifecycleProbe?: BuildRuntimeOptions["architectLifecycleProbe"];
  private readonly planningSourceReader?: PlanningSourceReader;
  private readonly coverageReview?: CoverageReviewDriver;
  private readonly answerReview?: AnswerReviewDriver;
  private readonly answerAuthority: AnswerReviewAuthority;
  private readonly planningHostCapabilities?: PlanningHostCapabilitiesProvider;
  private readonly coverageSuspendedRetryLimit: number;
  private lifecycleController = new AbortController();
  private stepQueue = Promise.resolve();
  private recordingFailureContext: {
    taskId?: string;
    attempt?: number;
    revision?: string;
  } = {};

  constructor(options: BuildRuntimeOptions) {
    this.id = options.runId;
    this.runId = options.runId;
    this.initialObjective = options.initialObjective;
    this.store = options.store;
    this.architectDriver = options.architectDriver;
    this.integrationDriver = options.integrationDriver;
    this.deliveryReview = options.deliveryReview;
    this.deliveryBoundary = options.deliveryBoundary;
    this.runPolicy = options.runPolicy ?? "finish";
    this.maxTaskAttempts = options.maxTaskAttempts ?? 2;
    this.resourceCapacity = options.resourceCapacity;
    this.architectId = options.architectId ?? "architect_1";
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.renewBudgetWindow = options.renewBudgetWindow;
    this.providerRetryDeadlineMs = options.providerRetryDeadlineMs;
    this.evidenceStore = options.evidenceStore;
    this.artifacts = options.artifacts;
    this.projectDocs = options.projectDocs;
    this.finalVerificationDriver = options.finalVerificationDriver;
    this.finalVerificationCleanupDriver = options.finalVerificationCleanupDriver;
    this.finalVerificationProfileFor = options.finalVerificationProfileFor;
    this.discardFinalVerificationProfile = options.discardFinalVerificationProfile;
    this.independentVerifier = options.independentVerifier;
    this.planCritic = options.planCritic;
    this.repairPlanLimit = options.repairPlanLimit ?? DEFAULT_REPAIR_PLAN_LIMIT;
    this.architectLifecycleProbe = options.architectLifecycleProbe;
    this.planningSourceReader = options.planningSourceReader;
    this.coverageReview = options.coverageReview;
    this.answerReview = options.answerReview;
    this.answerAuthority = new SchedulerAnswerReviewAuthority(options.store);
    this.planningHostCapabilities = options.planningHostCapabilities;
    this.coverageSuspendedRetryLimit = options.coverageSuspendedRetryLimit ?? DEFAULT_COVERAGE_SUSPENDED_RETRY_LIMIT;
    if (!Number.isSafeInteger(this.coverageSuspendedRetryLimit) || this.coverageSuspendedRetryLimit < 0) {
      throw new Error("coverageSuspendedRetryLimit must be a non-negative integer.");
    }
    if (
      this.coverageReview &&
      (
        this.coverageReview.candidateRuntimeIds.length === 0 ||
        new Set(this.coverageReview.candidateRuntimeIds).size !==
          this.coverageReview.candidateRuntimeIds.length ||
        this.coverageReview.candidateRuntimeIds.some((runtimeId) => !runtimeId.trim())
      )
    ) {
      throw new Error(
        "Coverage review requires unique non-empty candidate runtime IDs.",
      );
    }
    if (
      this.answerReview &&
      (
        this.answerReview.candidateRuntimeIds.length === 0 ||
        new Set(this.answerReview.candidateRuntimeIds).size !==
          this.answerReview.candidateRuntimeIds.length ||
        this.answerReview.candidateRuntimeIds.some((runtimeId) => !runtimeId.trim())
      )
    ) {
      throw new Error(
        "Answer review requires unique non-empty candidate runtime IDs.",
      );
    }
    if (
      this.independentVerifier &&
      (
        this.independentVerifier.candidateRuntimeIds.length === 0 ||
        new Set(this.independentVerifier.candidateRuntimeIds).size !==
          this.independentVerifier.candidateRuntimeIds.length ||
        this.independentVerifier.candidateRuntimeIds.some((runtimeId) => !runtimeId.trim())
      )
    ) {
      throw new Error(
        "Independent verifier requires unique non-empty candidate runtime IDs.",
      );
    }
    if (this.planCritic) {
      if (
        this.planCritic.candidateRuntimeIds.length === 0 ||
        new Set(this.planCritic.candidateRuntimeIds).size !==
          this.planCritic.candidateRuntimeIds.length ||
        this.planCritic.candidateRuntimeIds.some((runtimeId) => !runtimeId.trim())
      ) {
        throw new Error(
          "Plan critic requires unique non-empty candidate runtime IDs.",
        );
      }
      if (
        this.independentVerifier &&
        (
          this.planCritic.candidateRuntimeIds.length !==
            this.independentVerifier.candidateRuntimeIds.length ||
          this.planCritic.candidateRuntimeIds.some(
            (runtimeId, index) =>
              runtimeId !== this.independentVerifier!.candidateRuntimeIds[index],
          )
        )
      ) {
        throw new Error(
          "Plan critic candidate runtime IDs must equal the verifier policy candidates.",
        );
      }
    }
    this.configureProjectDocsPolicy();
    this.initializeRun();
    this.configureRunPolicy();
    this.configureVerifierPolicy();
    this.configureRepairPolicy();
    this.configurePlanCritiquePolicy();
    this.rederiveContextRecordingSuspension();
    this.scheduler = new TaskScheduler({
      runId: options.runId,
      store: options.store,
      driver: options.workerDriver,
      maxConcurrency: options.maxConcurrency,
      // T4: host-reported capacity further bounds new-policy admission.
      resourceCapacity: this.resourceCapacity,
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
    if (projection.status === "failed") {
      throw new Error("A failed Build cannot be resumed.");
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
    if (projection.verifierSelection?.status === "required") {
      throw new Error(
        "This Build is awaiting the user's independent verifier selection."
      );
    }
    if (projection.repairCycles?.pause) {
      throw new Error("This Build is awaiting the user's repair-cycle decision.");
    }
    // R2-1: an owner's resume clears a terminal N6 exhaustion gate durably
    // (an owner-authorized retry event) and resets the suspended-retry
    // count, so the next step runs the review again instead of re-pausing.
    // Non-terminal gates need no clearing: the next step retries them.
    const terminalGate = projection.planning?.coverageUnavailable;
    if (
      terminalGate?.reviewId !== undefined &&
      (TERMINAL_COVERAGE_GATE_REASONS as readonly string[]).includes(terminalGate.reason)
    ) {
      new SchedulerCoverageReviewAuthority(this.store).authorizeCoverageRetry({
        runId: this.runId,
        reviewId: terminalGate.reviewId,
        occurredAt: this.clock(),
      });
    }
    const occurredAt = this.clock();
    if (
      renewBudgetWindow &&
      projection.status === "paused" &&
      this.runPolicy === "budgeted"
    ) {
      this.renewBudgetWindow?.(`budget-window:${idempotencyKey}`, occurredAt);
    }
    const unresolvedRecording = projection.status === "paused" &&
      projection.pauseReason?.reason === "context_recording_failed"
      ? latestUnresolvedContextRecordingNote(projection)
      : undefined;
    if (unresolvedRecording) {
      this.store.append({
        runId: this.runId,
        type: "context_manifest.recording_resolved",
        occurredAt,
        actor: { role: "user", id: "local-user" },
        idempotencyKey: `context-recording-resolved:user:${unresolvedRecording.sequence}`,
        payload: {
          noteSequence: unresolvedRecording.sequence,
          resolution: "retry",
          rationale: "User resumed the run.",
        },
      });
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

  selectVerifierRuntime(
    runtimeId: string,
    idempotencyKey: string,
  ): SchedulerProjection {
    this.store.append({
      runId: this.runId,
      type: "verifier.selection_selected",
      occurredAt: this.clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey,
      payload: { runtimeId },
    });
    return this.projection();
  }

  extendRepairCycles(additionalRepairPlans: number, idempotencyKey: string): SchedulerProjection {
    this.store.append({
      runId: this.runId,
      type: "repair.cycle_limit_extended",
      occurredAt: this.clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey,
      payload: { additionalRepairPlans },
    });
    return this.projection();
  }

  submitUserGuidance(input: {
    guidanceId: string;
    text: string;
    version: number;
    idempotencyKey: string;
  }): SchedulerProjection {
    const submitted = this.submitManagedUserGuidance(input);
    const guidance = submitted.userGuidance[input.guidanceId];
    if (guidance?.interruptionStatus === "pending") {
      return this.completeManagedUserGuidanceInterruption(
        input.guidanceId,
        input.version,
      );
    }
    return submitted;
  }

  submitManagedUserGuidance(input: {
    guidanceId: string;
    text: string;
    version: number;
    idempotencyKey: string;
  }): SchedulerProjection {
    const sequenceBefore = this.store.readRun(this.runId).at(-1)?.sequence ?? 0;
    const appended = this.store.append({
      runId: this.runId,
      type: "user.guidance_submitted",
      occurredAt: this.clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: input.idempotencyKey,
      payload: {
        guidanceId: input.guidanceId,
        text: input.text,
        version: input.version,
        interruptionProtocolVersion: 1,
      },
    });
    if (appended.sequence > sequenceBefore) {
      this.lifecycleController.abort(
        new DOMException(`Build ${this.runId} received user guidance.`, "AbortError")
      );
    }
    return this.projection();
  }

  completeManagedUserGuidanceInterruption(
    guidanceId: string,
    expectedVersion: number,
  ): SchedulerProjection {
    this.store.append({
      runId: this.runId,
      type: "user.guidance_interruption_completed",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-manager" },
      idempotencyKey: `guidance-interruption:${guidanceId}:version:${expectedVersion}`,
      payload: { guidanceId, expectedVersion },
    });
    return this.projection();
  }

  answerArchitectQuestion(input: {
    questionId: string;
    expectedVersion: number;
    answer: string;
    idempotencyKey: string;
  }): SchedulerProjection {
    this.store.append({
      runId: this.runId,
      type: "architect.question_answered",
      occurredAt: this.clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: input.idempotencyKey,
      payload: {
        questionId: input.questionId,
        expectedVersion: input.expectedVersion,
        answer: input.answer,
      },
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
    try {
      return await this.dispatchStep();
    } catch (error) {
      if (!(error instanceof ContextManifestRecordingError)) throw error;
      try {
        this.recordContextRecordingFailure(error);
      } catch {
        throw error;
      }
      return { status: "paused", action: "context_recording_failed" };
    }
  }

  private async dispatchStep(): Promise<BuildStepResult> {
    this.recordingFailureContext = {};
    let events = this.store.readRun(this.runId);
    if (events.length === 0) {
      await this.runArchitect({ type: "plan_required" }, emptyProjection(this.runId));
      return this.afterArchitect("plan_required");
    }

    let projection = rebuildSchedulerProjection(events);
    if (projection.status === "completed") return { status: "completed" };
    if (projection.status === "failed") {
      return { status: "failed", action: "context_recording_aborted" };
    }
    if (projection.status === "paused") {
      return { status: "paused", action: projection.pauseReason?.reason };
    }
    await this.recoverPendingProjectDocs();
    events = this.store.readRun(this.runId);
    projection = events.length === 0
      ? emptyProjection(this.runId)
      : rebuildSchedulerProjection(events);
    const pendingInterruption = Object.values(projection.userGuidance)
      .filter((guidance) => guidance.interruptionStatus !== "completed")
      .sort((left, right) => left.version - right.version)[0];
    if (pendingInterruption) {
      return { status: "blocked", action: "user_guidance_interruption_pending" };
    }
    if (projection.blockingArchitectQuestionId) {
      return { status: "blocked", action: "architect_question_pending" };
    }
    const pendingQuestionResume = Object.values(projection.architectQuestions)
      .filter((question) =>
        question.status === "answered" &&
        question.checkpoint !== undefined &&
        (question.resumeStatus === "pending" || question.resumeStatus === "started")
      )
      .sort((left, right) => left.version - right.version)[0];
    // T9 repair cycle 1 (B3): pending user guidance routes to the Architect
    // whenever the run is new-policy and non-terminal — regardless of
    // planRevision, which stays 0 on new-policy runs until tasks exist (and
    // answered runs never get tasks). The T3 seam this closes predates T9.
    // Legacy routing is unchanged.
    const guidanceRoutes = projection.planRevision > 0 ||
      (projection.planningPolicyVersion === 1 && projection.status !== "stopped");
    if (guidanceRoutes) {
      const pendingGuidance = firstPendingUserGuidance(projection);
      if (pendingGuidance) {
        const resumeReason = pendingQuestionResume?.checkpoint?.reason;
        if (
          resumeReason?.type === "user_guidance_required" &&
          resumeReason.guidanceId === pendingGuidance.guidanceId &&
          resumeReason.version === pendingGuidance.version
        ) {
          return await this.resumeArchitectQuestion(pendingQuestionResume.questionId);
        }
        await this.runArchitect({
          type: "user_guidance_required",
          guidanceId: pendingGuidance.guidanceId,
          version: pendingGuidance.version,
        }, projection);
        return this.afterArchitect("user_guidance_required");
      }
    }
    if (pendingQuestionResume?.checkpoint) {
      return await this.resumeArchitectQuestion(pendingQuestionResume.questionId);
    }
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
    // T9 (EP39/OA-5): the answer path owns triage-`answer` runs outright —
    // before planning, critique, workers, integration, and final
    // verification. Answered runs complete with no plan, no critic, no
    // coverage review, and no verifier except the opted-in answer review.
    if (projection.planningPolicyVersion === 1 && isAnsweredRun(projection)) {
      return this.advanceAnswerPath(projection);
    }
    if (projection.planningPolicyVersion === 1) {
      // T3a/T3b: new-policy runs plan through the planning tools, not
      // plan_tasks, so legacy planRevision stays 0; planning continues until
      // the ready plan identity exists. A requested coverage review is driven
      // here; otherwise the Architect plans. (T9: triage precedes all of
      // this — the planning tools and events refuse until triage is `build`.)
      if (!readyPlanIdentity(projection)) {
        const coverage = await this.advanceCoverageReview(projection);
        if (coverage) return coverage;
        await this.runArchitect({ type: "plan_required" }, projection);
        return this.afterArchitect("plan_required");
      }
    } else if (projection.planRevision === 0) {
      await this.runArchitect({ type: "plan_required" }, projection);
      return this.afterArchitect("plan_required");
    }

    const critique = await this.advancePlanCritique(projection);
    if (critique) return critique;

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
      // T6a: a new-policy submission reaches the Architect only after its
      // mandatory deliverable review completed.
      if (
        projection.planningPolicyVersion === 1 &&
        currentSubmissionReview(projection.delivery, submitted)?.stage !== "completed"
      ) {
        return await this.advanceDeliveryReview(submitted);
      }
      await this.runArchitect(this.reviewRequiredReason(submitted, projection), projection);
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
      let integrationRevision = result.integrationRevision;
      if (result.status === "integrated") {
        const tip = projection.projectDocs?.documentTip;
        if (tip) {
          if (!this.projectDocs) {
            throw new Error("Document tip classification requires the project document port.");
          }
          const relation = await this.projectDocs.relateRevision({
            revision: result.integrationRevision,
            tip,
          });
          if (relation === "equal_to_tip" || relation === "ancestor") {
            if (!projection.integrationRevision) {
              throw new Error("Document tip has no canonical integration revision.");
            }
            integrationRevision = projection.integrationRevision;
          }
        }
      }
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
            integrationRevision,
            ...(result.status === "conflict"
              ? { conflictPaths: result.conflictPaths }
              : {}),
          },
        },
      });
      return { status: "progressed", action: `integration_${result.status}` };
    }

    const acceptance = await this.advanceDeliveryAcceptance(projection);
    if (acceptance) return acceptance;
    const phaseAcceptance = this.recordPhaseAcceptancesIfReady(projection);
    if (phaseAcceptance) return phaseAcceptance;
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
      return {
        status: "paused",
        action: afterWorkers.pauseReason?.reason === "context_recording_failed"
          ? "context_recording_failed"
          : "worker_paused",
      };
    }
    if (afterWorkers.status === "completed") {
      return { status: "completed", action: "worker_completed" };
    }
    if (afterWorkers.lastSequence > sequenceBeforeWorkers) {
      return { status: "progressed", action: "workers_advanced" };
    }
    // T3a repair cycle 2 (B2): never idle forever when pending work exists
    // but admission blocks all of it — wake the Architect to reconcile
    // instead of returning idle with zero Architect calls.
    if (newPolicyStaleTasksRequireArchitect(afterWorkers)) {
      await this.runArchitect({ type: "plan_required" }, afterWorkers);
      return this.afterArchitect("plan_required");
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
        const verifierResult = await this.advanceIndependentVerification();
        if (verifierResult) return verifierResult;
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
        const pausedForRepair = this.pauseIfRepairCyclesExhausted(
          this.projection(),
          "final_verification",
          generation.targetRevision,
        );
        if (pausedForRepair) return pausedForRepair;
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
          failedCategories: [...beforeRepairDecisionDispatch(decision.failedCategories)],
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
      const pausedForRepair = this.pauseIfRepairCyclesExhausted(
        this.projection(),
        "final_verification",
        generation.targetRevision,
      );
      if (pausedForRepair) return pausedForRepair;
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
      const signal = this.activeLifecycleSignal();
      try {
        result = await this.finalVerificationDriver.executeCheck({
          runId: this.runId,
          taskId: generation.taskId,
          generationId: generation.generationId,
          targetRevision: generation.targetRevision,
          attempt: 1,
          plan: generation.plan,
          category: pending.category,
          executionProfile: generation.executionProfile,
          signal,
        });
        if (signal.aborted) {
          return {
            status: this.projection().status === "paused" ? "paused" : "progressed",
            action: "final_verification_interrupted",
          };
        }
      } catch (error) {
        if (signal.aborted) {
          return {
            status: this.projection().status === "paused" ? "paused" : "progressed",
            action: "final_verification_interrupted",
          };
        }
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
        action: beforeFailingCheckRepairCharge(result.check).green
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
      executionProfile: generation.executionProfile,
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
        artifacts: this.artifacts,
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

  private async advanceIndependentVerification(): Promise<BuildStepResult | undefined> {
    const driver = this.independentVerifier;
    if (!driver) return undefined;
    let projection = this.projection();
    const targetRevision = projection.integrationRevision;
    const finalVerification = projection.finalVerification?.current;
    if (!targetRevision || !finalVerification) {
      throw new Error("Independent verification requires a current integrated revision.");
    }
    const risk = projection.buildRisk?.current;
    if (
      !risk || risk.state !== "current" ||
      risk.targetRevision !== targetRevision
    ) {
      const assessed = await driver.assessRisk({ runId: this.runId, projection });
      const input: BuildRiskAssessmentInput = {
        ...assessed,
        stricterQualification:
          driver.alwaysRequireIndependentVerifier === true,
      };
      projection = this.projection();
      if (
        projection.integrationRevision !== targetRevision ||
        projection.finalVerification?.current?.generationId !==
          finalVerification.generationId
      ) {
        return { status: "progressed", action: "build_risk_assessment_invalidated" };
      }
      this.store.append({
        runId: this.runId,
        type: "build.risk_assessed",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `build-risk:${targetRevision}`,
        payload: {
          targetRevision,
          input,
          assessment: assessBuildRisk(input),
        },
      });
      return { status: "progressed", action: "build_risk_assessed" };
    }
    if (risk.assessment.risk === "low") return undefined;

    const currentReview = projection.verifier?.current;
    if (
      currentReview?.status === "submitted" &&
      currentReview.verdict?.satisfied === true
    ) {
      return undefined;
    }
    if (
      currentReview?.status === "submitted" &&
      currentReview.verdict?.satisfied === false
    ) {
      if (currentReview.repairTaskIds?.length) return undefined;
      const pausedForRepair = this.pauseIfRepairCyclesExhausted(
        projection,
        "verifier",
        currentReview.targetRevision,
      );
      if (pausedForRepair) return pausedForRepair;
      const unsatisfiedCriteria = currentReview.verdict.criterionVerdicts
        .filter((criterion) => criterion.verdict === "unsatisfied")
        .map((criterion) => ({
          taskId: criterion.taskId,
          criterionId: criterion.criterionId,
          rationale: criterion.rationale,
          evidenceIds: [...criterion.evidenceIds],
        }));
      await this.runArchitect({
        type: "verifier_repair_plan_required",
        reviewId: currentReview.reviewId,
        targetRevision: currentReview.targetRevision,
        unsatisfiedCriteria,
      }, projection);
      const repaired = this.projection().verifier?.current;
      if (
        repaired?.reviewId !== currentReview.reviewId ||
        !repaired.repairTaskIds?.length
      ) {
        throw new Error(
          "Architect returned from verifier_repair_plan_required without a typed action.",
        );
      }
      return this.afterArchitect("verifier_repair_plan_required");
    }

    this.recordingFailureContext = {
      ...(targetRevision ? { revision: targetRevision } : {}),
    };
    const result = await driver.verify({
      runId: this.runId,
      projection,
      risk,
      ...(projection.verifierSelection?.status === "selected" &&
          projection.verifierSelection.selectedRuntimeId
        ? { preferredRuntimeId: projection.verifierSelection.selectedRuntimeId }
        : {}),
      signal: this.activeLifecycleSignal(),
    });
    const afterVerification = this.projection();
    if (
      afterVerification.integrationRevision !== targetRevision ||
      afterVerification.finalVerification?.current?.generationId !==
        finalVerification.generationId ||
      afterVerification.buildRisk?.current?.targetRevision !== targetRevision ||
      Object.values(afterVerification.userGuidance).some(
        (guidance) => guidance.status === "submitted",
      )
    ) {
      return { status: "progressed", action: "verifier_invalidated" };
    }
    if (result.status === "verdict_submitted") {
      const durable = this.projection().verifier?.current;
      if (
        durable?.status !== "submitted" || !durable.verdict ||
        durable.targetRevision !== targetRevision
      ) {
        throw new Error(
          "Verifier returned before its revision-bound verdict was durable.",
        );
      }
      return { status: "progressed", action: "verifier_verdict_submitted" };
    }
    if (result.status === "suspended" && result.reason === "provider_error") {
      return { status: "progressed", action: "verifier_provider_failed" };
    }
    if (
      result.status === "suspended" && result.reason === "cancelled" &&
      this.projection().status === "paused"
    ) {
      return { status: "paused", action: "verifier_interrupted" };
    }
    const reason = result.status === "unavailable"
      ? result.reason
      : result.reason || "verifier_suspended";
    this.store.append({
      runId: this.runId,
      type: "verifier.selection_required",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `verifier-selection:${targetRevision}:${reason}`,
      payload: {
        reason,
        requiredCapabilities: ["code"],
        candidateRuntimeIds: [...driver.candidateRuntimeIds],
      },
    });
    return { status: "paused", action: "verifier_selection_required" };
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
      return { status: "idle", action: "final_verification_cleanup_failed" };
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

  private initializeRun(): void {
    const events = this.store.readRun(this.runId);
    const durable = events.filter((event) => event.type !== "project_docs.policy_configured");
    if (durable.length > 0) {
      const durableObjective = rebuildSchedulerProjection(events).initialObjective;
      if (
        durableObjective !== undefined &&
        this.initialObjective !== undefined &&
        durableObjective !== this.initialObjective
      ) {
        throw new Error(
          "The durable initial objective does not match the Build specification."
        );
      }
      return;
    }
    this.store.append({
      runId: this.runId,
      type: "run.initialized",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "run-initialized",
      payload: {
        ...(this.initialObjective !== undefined
          ? { objective: this.initialObjective }
          : {}),
      },
    });
  }

  private configureProjectDocsPolicy(): void {
    const events = this.store.readRun(this.runId);
    if (events.length > 0) return;
    this.store.append({
      runId: this.runId,
      type: "project_docs.policy_configured",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "project-docs-policy",
      payload: { version: 1 },
    });
  }

  private bindProjectDocCommit(
    tools: readonly NativeTool<unknown>[],
  ): NativeTool<unknown>[] {
    if (!this.projectDocs) return [...tools];
    return tools.map((tool) => {
      if (tool.definition.name !== "write_project_doc") return tool;
      return {
        definition: tool.definition,
        validate: (input: unknown) => tool.validate(input),
        ...(tool.assessAccess
          ? { assessAccess: (input: unknown, context: ToolExecutionContext) => tool.assessAccess!(input, context) }
          : {}),
        execute: async (input: unknown, context: ToolExecutionContext) => {
          const output = await tool.execute(input, context);
          if (output.isError) return output;
          await this.commitRequestedProjectDoc(input);
          return output;
        },
      };
    });
  }

  private async commitRequestedProjectDoc(input: unknown): Promise<void> {
    if (!this.projectDocs) return;
    if (!isProjectDocToolInput(input)) {
      throw new Error("Project document commit input is invalid.");
    }
    const events = this.store.readRun(this.runId);
    const requested = [...events].reverse().find((event) =>
      event.type === "project_doc.requested" && event.payload.path === input.path
    );
    const requestId = requested?.payload.requestId;
    if (!requested || typeof requestId !== "string") {
      throw new Error("Project document request was not recorded.");
    }
    if (events.some((event) =>
      event.type === "project_doc.committed" && event.payload.requestId === requestId
    )) {
      return;
    }
    const result = await this.projectDocs.commit({
      writes: [{ path: input.path, content: input.content }],
      summary: input.summary,
      runId: this.runId,
      requestId,
    });
    this.appendProjectDocCommitted(requestId, input.path, result);
  }

  private async recoverPendingProjectDocs(): Promise<void> {
    if (!this.projectDocs || !this.artifacts) return;
    const events = this.store.readRun(this.runId);
    const settled = new Set(
      events.flatMap((event) =>
        (event.type === "project_doc.committed" || event.type === "project_doc.abandoned") &&
        typeof event.payload.requestId === "string"
          ? [event.payload.requestId]
          : []
      ),
    );
    const pending = events.filter((event) =>
      event.type === "project_doc.requested" &&
      typeof event.payload.requestId === "string" &&
      !settled.has(event.payload.requestId)
    );
    for (const event of pending) {
      const requestId = event.payload.requestId;
      const path = event.payload.path;
      const summary = event.payload.summary;
      const hash = event.payload.contentArtifactHash;
      if (
        typeof requestId !== "string" ||
        typeof path !== "string" ||
        typeof summary !== "string" ||
        typeof hash !== "string"
      ) {
        throw new Error("Project document request is incomplete.");
      }
      if (projectDocSummaryRejected(summary)) {
        this.recordAbandonedProjectDoc(requestId, path);
        continue;
      }
      const bytes = await this.artifacts.get(hash);
      if (createHash("sha256").update(bytes).digest("hex") !== hash) {
        throw new Error(`Project document artifact ${hash} does not match its request.`);
      }
      try {
        const result = await this.projectDocs.commit({
          writes: [{ path, content: bytes.toString("utf8") }],
          summary,
          runId: this.runId,
          requestId,
        });
        this.appendProjectDocCommitted(requestId, path, result);
      } catch (error) {
        if (error instanceof Error && error.message === "Project document summary is invalid.") {
          this.recordAbandonedProjectDoc(requestId, path);
          continue;
        }
        throw error;
      }
    }
  }

  private recordAbandonedProjectDoc(requestId: string, path: string): void {
    this.store.append({
      runId: this.runId,
      type: "project_doc.abandoned",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `project-doc-abandoned:${requestId}`,
      payload: {
        requestId,
        path,
        reason: "Project document summary is invalid.",
      },
    });
  }

  private appendProjectDocCommitted(
    requestId: string,
    path: string,
    result: ProjectDocCommitResult,
  ): void {
    this.store.append({
      runId: this.runId,
      type: "project_doc.committed",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `project-doc-committed:${requestId}`,
      payload: {
        requestId,
        path,
        commit: result.commit,
        parent: result.parent,
        head: result.head,
        readme: result.entryPoint.readme,
        agentsMarkedSection: result.entryPoint.agentsMarkedSection,
        claudePointer: result.entryPoint.claudePointer,
      },
    });
  }

  private ensureInitialized(): void {
    this.initializeRun();
  }

  private rederiveContextRecordingSuspension(): void {
    const events = this.store.readRun(this.runId);
    if (events.length === 0) return;
    const waiver = rebuildSchedulerProjection(events).contextRecording?.waiver;
    if (waiver) suspendContextRecording(this.runId, waiver.rationale);
  }

  async resolveContextRecordingFailure(): Promise<"resumed" | "aborted" | "unresolved"> {
    const projection = this.projection();
    if (projection.status === "failed") return "aborted";
    const note = latestUnresolvedContextRecordingNote(projection);
    if (
      projection.status !== "paused" ||
      projection.pauseReason?.reason !== "context_recording_failed" ||
      !note
    ) {
      return "unresolved";
    }
    suspendContextRecording(this.runId, "context_recording_decision_turn");
    try {
      await this.runArchitect({
        type: "context_recording_decision_required",
        purpose: note.purpose,
        attempts: note.attempts,
        reason: note.reason,
        noteSequence: note.sequence,
        ...(note.taskId ? { taskId: note.taskId } : {}),
        ...(note.attempt !== undefined ? { attempt: note.attempt } : {}),
        ...(note.revision ? { revision: note.revision } : {}),
        retriesRemaining: contextRecordingRetriesRemaining(projection),
      }, projection);
    } catch (error) {
      if (!(error instanceof ContextManifestRecordingError)) throw error;
      if (this.projection().status === "failed") return "aborted";
      if (latestUnresolvedContextRecordingNote(this.projection())) return "unresolved";
    } finally {
      if (!this.projection().contextRecording?.waiver) {
        clearContextRecordingSuspension(this.runId);
      }
    }
    return this.finishContextRecordingResolution();
  }

  private finishContextRecordingResolution(): "resumed" | "aborted" | "unresolved" {
    const projection = this.projection();
    if (projection.status === "failed") return "aborted";
    const note = projection.contextRecording?.notes.at(-1);
    const resolution = note?.resolution;
    if (!resolution) return "unresolved";
    if (resolution.resolution === "abort") return "aborted";
    if (projection.status === "running") return "resumed";
    if (resolution.resolution === "proceed_without_manifest") {
      suspendContextRecording(this.runId, resolution.rationale ?? projection.contextRecording?.waiver?.rationale ?? "");
    }
    this.store.append({
      runId: this.runId,
      type: "run.resumed",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `context-recording-resumed:${note?.sequence ?? projection.lastSequence}`,
      payload: {},
    });
    return "resumed";
  }

  private recordContextRecordingFailure(error: ContextManifestRecordingError): void {
    const projection = this.projection();
    const details = this.recordingFailureContext;
    this.store.append({
      runId: this.runId,
      type: "context_manifest.recording_failed",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `context-recording-failed:${error.purpose}:${projection.lastSequence}`,
      payload: {
        purpose: error.purpose,
        attempts: error.attempts,
        reason: error.message,
        ...(details.taskId ? { taskId: details.taskId } : {}),
        ...(details.attempt !== undefined ? { attempt: details.attempt } : {}),
        ...(details.revision ? { revision: details.revision } : {}),
      },
    });
    const noted = this.projection();
    this.store.append({
      runId: this.runId,
      type: "run.paused",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `context-recording-paused:${noted.lastSequence}`,
      payload: {
        reason: "context_recording_failed",
        ...(details.taskId ? { taskId: details.taskId } : {}),
      },
    });
  }

  private async runArchitect(
    reason: ArchitectActionReason,
    projection: SchedulerProjection
  ): Promise<void> {
    this.recordingFailureContext = {
      ...("taskId" in reason && reason.taskId ? { taskId: reason.taskId } : {}),
      ...("attempt" in reason && typeof reason.attempt === "number" ? { attempt: reason.attempt } : {}),
      ...(projection.integrationRevision ? { revision: projection.integrationRevision } : {}),
    };
    const sequenceBefore = this.store.readRun(this.runId).at(-1)?.sequence ?? 0;
    const providerRetryDeadlineMs = this.providerRetryDeadlineMs?.();
    const tools = new ToolRegistry();
    const created = this.bindProjectDocCommit(createArchitectTools({
      store: this.store,
      clock: this.clock,
      runPolicy: this.runPolicy,
      planOnlyCompletionAvailable:
        this.runPolicy === "plan_only" &&
        reason.type === "completion_decision_required" &&
        (projection.planningPolicyVersion === 1
          // T9 (EP39): a plan_only run given a pure question is answered —
          // complete_run is offered on the answer path too. The tool still
          // enforces full completion readiness (answer plus the STATE.md gate).
          ? readyPlanIdentity(projection) !== undefined || isAnsweredRun(projection)
          : projection.planRevision > 0),
      finalVerificationPlanAvailable:
        reason.type === "final_verification_plan_required",
      finalVerificationReviewAvailable:
        reason.type === "final_verification_review_required",
      finalVerificationRepairPlanAvailable:
        reason.type === "final_verification_repair_plan_required",
      verifierRepairPlanAvailable:
        reason.type === "verifier_repair_plan_required",
      deliveryBoundaryResolutionAvailable:
        reason.type === "delivery_boundary_failed",
      planCritiqueResolutionAvailable:
        projection.planCritique?.current?.status === "submitted",
      architectAction: {
        reason,
        sequence: projection.lastSequence,
      },
      ...(projection.planningPolicyVersion === 1
        ? {
            planningTools: {
              ...(this.planningSourceReader
                ? { readSource: this.planningSourceReader }
                : {}),
            },
            // T9 (EP39): triage tools ride every new-policy turn; each tool
            // refuses when its decision does not apply.
            triageTools: true,
          }
        : {}),
      // T3a repair (B1b): in planning state the legacy plan/task tools are
      // not offered. False for legacy runs and once a plan is ready.
      ...(isPlanningState(projection) ? { planningState: true as const } : {}),
      // T9 (EP39): on the answer path no mutation lifecycle tool is offered.
      ...(isAnsweredRun(projection) ? { answerPath: true as const } : {}),
      // T9 repair cycle 1 (B3): a new-policy triage/answer/planning turn with
      // guidance pending also offers the acknowledgement, so the gate's
      // refusal is actionable in the same turn. Legacy turns are untouched.
      ...(reason.type === "plan_required" &&
        projection.planningPolicyVersion === 1 &&
        firstPendingUserGuidance(projection)
        ? { acknowledgeGuidanceAvailable: true as const }
        : {}),
      ...(this.finalVerificationProfileFor
        ? { finalVerificationProfileFor: this.finalVerificationProfileFor }
        : {}),
      ...(this.discardFinalVerificationProfile
        ? { discardFinalVerificationProfile: this.discardFinalVerificationProfile }
        : {}),
      ...(this.evidenceStore ? { evidenceStore: this.evidenceStore } : {}),
      ...(this.artifacts ? { artifacts: this.artifacts } : {}),
    }));
    const registered = this.architectLifecycleProbe
      ? this.architectLifecycleProbe(created)
      : created;
    // T9 (EP39): answer turns omit the mutation lifecycle tools by design,
    // so they require the answer-path core instead of the standard core.
    const standardTurn = this.runPolicy !== "plan_only" &&
      reason.type !== "context_recording_decision_required" &&
      !isAnsweredRun(projection);
    const answerTurn = this.runPolicy !== "plan_only" &&
      reason.type !== "context_recording_decision_required" &&
      isAnsweredRun(projection);
    assertArchitectLifecycleRegistration(
      registered.map((tool) => tool.definition.name),
      standardTurn,
      this.store,
      this.clock,
      answerTurn ? ANSWER_PATH_LIFECYCLE_TOOLS : undefined,
    );
    for (const tool of registered) {
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
        signal: this.activeLifecycleSignal(true),
      },
    });
    const sequenceAfter = this.store.readRun(this.runId).at(-1)?.sequence ?? 0;
    if (sequenceAfter <= sequenceBefore) {
      throw new Error(
        `Architect returned from ${reason.type} without a typed action.`
      );
    }
  }

  private async resumeArchitectQuestion(questionId: string): Promise<BuildStepResult> {
    let events = this.store.readRun(this.runId);
    let projection = rebuildSchedulerProjection(events);
    let question = projection.architectQuestions[questionId];
    if (
      !question ||
      question.status !== "answered" ||
      !question.checkpoint ||
      (question.resumeStatus !== "pending" && question.resumeStatus !== "started")
    ) {
      return { status: "idle" };
    }
    const checkpoint = question.checkpoint;
    let actionEvent = question.resumeStartedSequence === undefined
      ? undefined
      : firstMatchingArchitectActionEvent(
          events,
          question.resumeStartedSequence,
          checkpoint.reason
        );
    if (!actionEvent) {
      if (question.resumeStatus === "pending") {
        this.store.append({
          runId: this.runId,
          type: "architect.question_resume_started",
          occurredAt: this.clock(),
          actor: { role: "runner", id: "build-runtime" },
          idempotencyKey: `architect-question-resume-started:${question.questionId}:${question.version}`,
          payload: { questionId: question.questionId, expectedVersion: question.version },
        });
        events = this.store.readRun(this.runId);
        projection = rebuildSchedulerProjection(events);
        question = projection.architectQuestions[questionId];
      }
      const startedSequence = question.resumeStartedSequence;
      if (startedSequence === undefined) {
        throw new Error(`Architect question ${questionId} has no durable resume start.`);
      }
      await this.runArchitect(checkpoint.reason, projection);
      events = this.store.readRun(this.runId);
      actionEvent = firstMatchingArchitectActionEvent(
        events,
        startedSequence,
        checkpoint.reason
      );
      if (!actionEvent) {
        return { status: "progressed", action: "architect_question_interrupted" };
      }
    }
    this.store.append({
      runId: this.runId,
      type: "architect.question_resume_consumed",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `architect-question-resume-consumed:${question.questionId}:${question.version}`,
      payload: {
        questionId: question.questionId,
        expectedVersion: question.version,
        actionEventSequence: actionEvent.sequence,
      },
    });
    return this.afterArchitect("architect_question_resumed");
  }

  private activeLifecycleSignal(allowPendingGuidanceReset = false): AbortSignal {
    const projection = this.projection();
    if (
      this.lifecycleController.signal.aborted &&
      projection.status === "running" &&
      (allowPendingGuidanceReset || !firstPendingUserGuidance(projection))
    ) {
      this.lifecycleController = new AbortController();
    }
    return this.lifecycleController.signal;
  }

  /**
   * T6a: drive the mandatory deliverable review of the current submission.
   * The reviewer runtime writes every stage durably; a pass that cannot
   * finish pauses the run with a delivery-specific, owner-visible reason and
   * owner resume starts a new durable generation (no controller self-review).
   */
  private async advanceDeliveryReview(task: BuildTask): Promise<BuildStepResult> {
    if (!this.deliveryReview) {
      throw new Error("New-policy task review requires the mandatory deliverable reviewer.");
    }
    const providerRetryDeadlineMs = this.providerRetryDeadlineMs?.();
    let result: Awaited<ReturnType<DeliveryReviewDriver["review"]>>;
    try {
      result = await this.deliveryReview.review({
        runId: this.runId,
        taskId: task.id,
        signal: this.activeLifecycleSignal(),
        ...(providerRetryDeadlineMs !== undefined ? { providerRetryDeadlineMs } : {}),
      });
    } catch (error) {
      return this.pauseForDeliveryGate(task.id, "delivery_review_failed", error instanceof Error ? error.message : String(error));
    }
    if (result.status === "reviewed") {
      return { status: "progressed", action: "deliverable_review_recorded" };
    }
    return this.pauseForDeliveryGate(
      task.id,
      result.status === "suspended" ? `delivery_review_suspended:${result.reason}` : result.reason,
      result.status === "suspended" ? result.error : result.detail,
    );
  }

  /** The review_required reason carries what the deliverable review left open. */
  private reviewRequiredReason(task: BuildTask, projection: SchedulerProjection): ArchitectActionReason {
    const review = projection.planningPolicyVersion === 1
      ? currentSubmissionReview(projection.delivery, task)
      : undefined;
    return {
      type: "review_required",
      taskId: task.id,
      changeSetId: task.changeSetId!,
      ...(review
        ? {
            delivery: {
              reviewId: review.reviewId,
              openFindingIds: openBlockingFindings(review).map((finding) => finding.id),
              unverifiedClaimIds: unverifiedClaims(review).map((claim) => claim.claimId),
            },
          }
        : {}),
    };
  }

  /**
   * T6a (B3/B4): post-integration boundary checks and task acceptance.
   * A failed/unknown boundary keeps the task `integrated` (no illegal
   * transition), routes to the Architect once, and is never re-run on the same
   * revision without a state change. Returns undefined when nothing applies.
   */
  private async advanceDeliveryAcceptance(projection: SchedulerProjection): Promise<BuildStepResult | undefined> {
    if (projection.planningPolicyVersion !== 1) return undefined;
    const integrationRevision = projection.integrationRevision;
    if (!integrationRevision) return undefined;
    const pending = Object.values(projection.tasks)
      .filter((task) => task.kind !== "final_verification" && task.status === "integrated" && !projection.delivery?.taskAcceptances[task.id])
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const task of pending) {
      const action = deliveryBoundaryAction(
        projection.delivery,
        task.id,
        integrationRevision,
        (id) => projection.tasks[id]?.status,
      );
      if (action.type === "wait") continue;
      if (action.type === "accept") {
        const review = projection.delivery!.reviews[task.id]!;
        this.store.append({
          runId: this.runId,
          type: "task.acceptance_recorded",
          occurredAt: this.clock(),
          actor: { role: "runner", id: DELIVERY_ACCEPTANCE_RUNNER_ID },
          idempotencyKey: `delivery-acceptance:${task.id}:${action.boundary.boundaryId}`,
          payload: { taskId: task.id, reviewId: review.reviewId, boundaryId: action.boundary.boundaryId },
        });
        return { status: "progressed", action: "task_acceptance_recorded" };
      }
      if (action.type === "architect") {
        await this.runArchitect({
          type: "delivery_boundary_failed",
          taskId: task.id,
          boundaryId: action.boundary.boundaryId,
          integrationRevision,
          resolutionGeneration: action.resolutionGeneration,
        }, projection);
        return this.afterArchitect("delivery_boundary_failed");
      }
      if (!this.deliveryBoundary) {
        throw new Error("New-policy task acceptance requires the integrated-boundary check driver.");
      }
      const generation = (projection.delivery?.boundaries[task.id]?.length ?? 0) + 1;
      const boundaryId = deliveryBoundaryId(task.id, generation);
      // N-R4-3: durably start the attempt before any command runs.
      const attempt = (projection.delivery?.boundaryStarts?.[boundaryId] ?? 0) + 1;
      this.store.append({
        runId: this.runId,
        type: "delivery.boundary_started",
        occurredAt: this.clock(),
        actor: { role: "runner", id: DELIVERY_ACCEPTANCE_RUNNER_ID },
        idempotencyKey: `delivery-boundary-start:${boundaryId}:${attempt}`,
        payload: { taskId: task.id, boundaryId, attempt, integrationRevision },
      });
      let outcome: Awaited<ReturnType<DeliveryBoundaryDriver["check"]>>;
      try {
        outcome = await this.deliveryBoundary.check({
          runId: this.runId,
          taskId: task.id,
          boundaryId,
          attempt,
          integrationRevision,
          signal: this.activeLifecycleSignal(),
        });
      } catch (error) {
        return this.pauseForDeliveryGate(task.id, "delivery_boundary_unavailable", error instanceof Error ? error.message : String(error));
      }
      this.store.append({
        runId: this.runId,
        type: "delivery.boundary_checked",
        occurredAt: this.clock(),
        actor: { role: "runner", id: DELIVERY_ACCEPTANCE_RUNNER_ID },
        idempotencyKey: `delivery-boundary:${boundaryId}`,
        payload: {
          taskId: task.id,
          boundaryId,
          generation,
          attempt,
          integrationRevision,
          executedScope: "full_test_script",
          changedFiles: [...outcome.changedFiles],
          selection: { rung: outcome.selection.rung, selectedTests: [...outcome.selection.selectedTests] },
          checks: outcome.checks.map((check) => ({ ...check, evidenceIds: [...check.evidenceIds] })),
          passed: outcome.checks.every((check) => check.outcome === "passed"),
        },
      });
      return { status: "progressed", action: "delivery_boundary_checked" };
    }
    return undefined;
  }

  /**
   * T6a (N4): phase acceptance is bound to the current plan revision and
   * re-evaluated on every pump step, so any relevant input change (a task
   * acceptance, a new boundary run, a new revision) is picked up.
   */
  private recordPhaseAcceptancesIfReady(projection: SchedulerProjection): BuildStepResult | undefined {
    if (projection.planningPolicyVersion !== 1) return undefined;
    const plan = projection.planning?.plan;
    const revision = plan?.revisionsById[plan.currentRevisionId];
    if (!revision || !readyPlanIdentity(projection)) return undefined;
    const taskStatuses = new Map(Object.entries(projection.tasks).map(([id, task]) => [id, task.status]));
    for (const phase of revision.phases) {
      if (projection.delivery?.phaseAcceptances[phaseAcceptanceKey(revision.revisionId, phase.id)]) continue;
      const evaluation = evaluatePhaseAcceptance({
        phase,
        requirements: revision.requirements,
        taskStatuses,
        state: projection.delivery,
        integrationRevision: projection.integrationRevision,
      });
      if (!evaluation.ready) continue;
      this.store.append({
        runId: this.runId,
        type: "phase.acceptance_recorded",
        occurredAt: this.clock(),
        actor: { role: "runner", id: DELIVERY_ACCEPTANCE_RUNNER_ID },
        idempotencyKey: `phase-acceptance:${revision.revisionId}:${phase.id}`,
        payload: {
          phaseId: phase.id,
          planRevisionId: revision.revisionId,
          taskAcceptanceRefs: evaluation.taskAcceptanceRefs,
          exitChecks: evaluation.exitChecks,
        },
      });
      return { status: "progressed", action: "phase_acceptance_recorded" };
    }
    return undefined;
  }

  private pauseForDeliveryGate(taskId: string, reason: string, detail?: string): BuildStepResult {
    this.store.append({
      runId: this.runId,
      type: "run.paused",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `delivery-paused:${taskId}:${reason}:${this.projection().lastSequence}`,
      payload: {
        reason: reason.startsWith("delivery_") ? reason : `delivery_${reason}`,
        taskId,
        ...(detail ? { detail } : {}),
      },
    });
    return { status: "paused", action: reason.startsWith("delivery_") ? reason : `delivery_${reason}` };
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

  private configureVerifierPolicy(): void {
    if (!this.independentVerifier || this.runPolicy === "plan_only") return;
    const expected = {
      mode: "risk_based" as const,
      candidateRuntimeIds: [...this.independentVerifier.candidateRuntimeIds],
      alwaysRequireIndependentVerifier:
        this.independentVerifier.alwaysRequireIndependentVerifier === true,
    };
    const recovered = this.projection().verifierPolicy;
    if (recovered) {
      if (
        recovered.mode !== expected.mode ||
        recovered.alwaysRequireIndependentVerifier !==
          expected.alwaysRequireIndependentVerifier ||
        recovered.candidateRuntimeIds.length !==
          expected.candidateRuntimeIds.length ||
        recovered.candidateRuntimeIds.some(
          (runtimeId, index) =>
            runtimeId !== expected.candidateRuntimeIds[index],
        )
      ) {
        throw new Error(
          "Scheduler independent verifier policy is already configured differently.",
        );
      }
      return;
    }
    this.store.append({
      runId: this.runId,
      type: "verifier.policy_configured",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "verifier-policy-configured",
      payload: {
        ...expected,
        twoPass: this.independentVerifier.twoPass === true,
      },
    });
  }

  private configureRepairPolicy(): void {
    const events = this.store.readRun(this.runId);
    if (events.some((event) => event.type === "repair.policy_configured")) return;
    if (events.some((event) => event.type === "plan.created")) return; // in-flight pre-P6.5 runs stay uncapped
    this.store.append({
      runId: this.runId,
      type: "repair.policy_configured",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "repair-policy",
      payload: { repairPlanLimit: this.repairPlanLimit },
    });
  }

  private configurePlanCritiquePolicy(): void {
    const events = this.store.readRun(this.runId);
    if (events.some((event) => event.type === "plan_critique.policy_configured")) return;
    if (events.some((event) => event.type === "plan.created")) return;
    this.store.append({
      runId: this.runId,
      type: "plan_critique.policy_configured",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "plan-critique-policy",
      payload: { mode: this.planCritic?.mode ?? "off" },
    });
  }

  /**
   * T3b: drives an outstanding coverage review toward plan_ready. Returns a
   * step result when the coverage path owns this step, or undefined when the
   * Architect must act (nothing drafted, nothing requested, or blocking
   * findings/unread sections/readiness blockers to resolve — all visible in
   * planning-status). Legacy runs never reach here (planningPolicyVersion 1
   * only).
   *
   * Repair cycle 1 (B1): an unavailable gate for the current revision is
   * outstanding but retryable, never permanent. Each step re-attempts the
   * still-current review (selection re-checks provider cooldown timing, so a
   * cooled-down provider is picked up; one attempt per step, no busy loop).
   * When a reviewer is available the review proceeds and the gate clears
   * durably via the recorded derivation, delivery, own view, or verdict.
   * Repair cycle 2 (R2-1): a gate pauses the run with a durable,
   * owner-visible reason (the verifier selection_required mechanism) — never
   * a silent blocked while the run shows running. The owner's normal resume
   * re-drives the retry; resume also clears a terminal N6 exhaustion gate
   * and resets its count. A non-terminal suspension is transient progress
   * (the pump retries immediately); only exhaustion pauses.
   */
  private async advanceCoverageReview(projection: SchedulerProjection): Promise<BuildStepResult | undefined> {
    const planning = projection.planning;
    if (!planning?.plan || !planning.ledger) return undefined;
    const revisionId = planning.plan.currentRevisionId;
    const digest = planning.plan.currentDigest;
    const manifest = planning.source.manifestsById[planning.source.currentManifestId];
    const review = planning.coverageReview;
    const bound = review &&
        review.planRevisionId === revisionId &&
        review.planRevisionDigest === digest &&
        review.sourceReadManifestId === manifest.manifestId
      ? review
      : undefined;
    const unavailable = planning.coverageUnavailable;
    const gateForCurrent = unavailable &&
        unavailable.planRevisionId === revisionId &&
        unavailable.sourceManifestId === manifest.manifestId
      ? unavailable
      : undefined;
    // Terminal gates (N6 exhaustion) pause for the owner and never retry
    // on their own; the owner's resume clears them (see resumeInternal).
    // Every other gate for the current revision falls through to the retry
    // attempt below.
    if (gateForCurrent && (TERMINAL_COVERAGE_GATE_REASONS as readonly string[]).includes(gateForCurrent.reason)) {
      return this.pauseForCoverageGate(gateForCurrent.reviewId ?? "none", gateForCurrent.reason);
    }
    if (bound) {
      // T9 repair cycle 3 (B4-r3): a bound review requested at or before the
      // latest folded acknowledgement never saw the folded guidance. It goes
      // back to the Architect as plan_required — with the guidance in context
      // — instead of making the plan ready. The kernel refuses plan_ready on
      // the same condition; this is the pump mirror so the run visibly waits
      // for a planning turn and a new review instead of stalling or throwing.
      const folded = projection.latestFoldedIntoPlanningAck;
      if (folded) {
        const requestedSequence = planning.coverageRequests[bound.id]?.requestedSequence ?? 0;
        if (requestedSequence <= folded.sequence) return undefined;
      }
      // Blocking verdicts, blocking findings, or cumulative outstanding
      // blocking prior findings: the Architect resolves by revising
      // (planning-status shows them with text and rationale).
      if (coverageReviewHoldsReadiness(bound)) return undefined;
      if (
        bound.findings.some(
          (finding) => finding.severity === "blocking" && finding.disposition?.resolution !== "plan_reconciled",
        )
      ) {
        return undefined;
      }
      // Cumulative open blocking findings from earlier reviews (the same
      // shared helper as the reducer and status; retired excluded). The
      // bound review's own blocking findings were handled just above.
      {
        const outstanding = openBlockingCoverageFindings(planning).filter(
          (entry) => entry.reviewId !== bound.id,
        );
        if (outstanding.length > 0) return undefined;
      }
      // Full durable reads, mirroring the reducer pre-check (Architect fixes gaps).
      const reads = planning.sourceReadIndex[manifest.manifestId] ?? {};
      if (manifest.sections.some((section) => reads[section.id] !== section.digest)) return undefined;
      // N2: readiness blockers the runtime did not pre-check (revision
      // validation, requirement removal, host capabilities) hand control to
      // the Architect with the blocker text recorded as an explicit
      // outstanding gate (visible in planning-status) — never throw out of
      // the step. A later revision/request clears the gate.
      const readyAuthority = new SchedulerCoverageReviewAuthority(this.store);
      if (!this.planningHostCapabilities) {
        readyAuthority.recordUnavailable({
          runId: this.runId,
          reviewId: bound.id,
          reason: "plan_ready_blocked",
          detail: "No host capabilities provider is configured.",
          occurredAt: this.clock(),
        });
        return undefined;
      }
      const history = planning.plan.revisionHistoryIds;
      const priorRevisionId = history.length > 1 ? history[history.length - 2] : undefined;
      const hostCapabilities = this.planningHostCapabilities();
      // N-R2-1: the readiness pre-check builds from the ONE shared helper —
      // the same input (including amendment history) the reducer decides on.
      const readinessInput = coveragePlanReadinessInput(planning, priorRevisionId);
      const readiness = readinessInput
        ? computePlanReadiness({ ...readinessInput, hostCapabilities })
        : { ready: false, blockers: ["Plan readiness requires a plan, coverage review, and host capabilities."] };
      if (!readiness.ready) {
        readyAuthority.recordUnavailable({
          runId: this.runId,
          reviewId: bound.id,
          reason: "plan_ready_blocked",
          detail: readiness.blockers.join(" "),
          occurredAt: this.clock(),
        });
        return undefined;
      }
      try {
        readyAuthority.appendPlanReady({
          runId: this.runId,
          hostCapabilities,
          ...(priorRevisionId !== undefined ? { priorRevisionId } : {}),
          occurredAt: this.clock(),
        });
      } catch (error) {
        readyAuthority.recordUnavailable({
          runId: this.runId,
          reviewId: bound.id,
          reason: "plan_ready_blocked",
          detail: error instanceof Error ? error.message : String(error),
          occurredAt: this.clock(),
        });
        return undefined;
      }
      return { status: "progressed", action: "plan_ready" };
    }
    const request = Object.values(planning.coverageRequests).find(
      (candidate) =>
        candidate.planRevisionId === revisionId &&
        candidate.planRevisionDigest === digest &&
        candidate.sourceManifestId === manifest.manifestId,
    );
    if (!request) return undefined;
    const authority = new SchedulerCoverageReviewAuthority(this.store);
    if (!this.coverageReview) {
      authority.recordUnavailable({
        runId: this.runId,
        reviewId: request.reviewId,
        reason: "no_coverage_review_driver",
        occurredAt: this.clock(),
      });
      return this.pauseForCoverageGate(request.reviewId, "no_coverage_review_driver");
    }
    const revision = planning.plan.revisionsById[revisionId];
    const priorReview = request.priorReviewId === undefined
      ? undefined
      : [planning.coverageReview, ...planning.coverageReviewHistory]
        .find((candidate) => candidate?.id === request.priorReviewId);
    // N2: an unknown prior review hands control to the Architect (whose next
    // request clears the stale binding) instead of throwing out of the step.
    if (request.priorReviewId !== undefined && !priorReview) return undefined;
    const input: NativeCoverageReviewRequest = {
      runId: this.runId,
      reviewId: request.reviewId,
      architectRuntimeId: projection.runtime.architect.runtimeId ?? this.architectId,
      manifest,
      planRevision: revision,
      ledger: {
        id: planning.ledger.id,
        requirements: planning.ledger.requirements,
        phases: planning.ledger.phases,
      },
      objective: this.initialObjective ?? projection.initialObjective ?? "",
      guidance: Object.values(projection.userGuidance).map((guidance) => ({
        id: `${guidance.guidanceId}:v${guidance.version}`,
        text: guidance.text,
      })),
      ...(priorReview !== undefined ? { priorReview } : {}),
      signal: this.activeLifecycleSignal(),
    };
    const result = await this.coverageReview.review(input);
    if (result.status === "reviewed") return { status: "progressed", action: "coverage_review_recorded" };
    if (result.status === "unavailable") return this.pauseForCoverageGate(request.reviewId, result.reason);
    // A suspension is transient progress: the pump retries with a fresh
    // attempt on the next step. On N6 exhaustion record an explicit
    // outstanding gate for the owner and pause instead of looping.
    if (result.status === "suspended" && result.reason === "cancelled" && this.projection().status === "paused") {
      return { status: "paused", action: "coverage_review_suspended" };
    }
    const suspended = authority.recordSuspended({
      runId: this.runId,
      reviewId: request.reviewId,
      reason: result.reason,
      runtimeId: result.runtimeId,
      occurredAt: this.clock(),
    });
    if (suspended.attempts >= this.coverageSuspendedRetryLimit) {
      authority.recordUnavailable({
        runId: this.runId,
        reviewId: request.reviewId,
        reason: "coverage_review_suspended_exhausted",
        detail: `Suspended ${suspended.attempts} time(s); last reason ${suspended.lastReason}.`,
        occurredAt: this.clock(),
      });
      return this.pauseForCoverageGate(request.reviewId, "coverage_review_suspended_exhausted");
    }
    return { status: "progressed", action: "coverage_review_suspended" };
  }

  /**
   * R2-1: a coverage gate pauses the run with a durable, owner-visible
   * reason — the same runner-initiated pause mechanism as the verifier's
   * selection_required path (a durable event flips the run to paused; the
   * step returns paused). The verifier/manager path has no timed wake, so
   * the owner's normal resume re-drives the retry (and clears a terminal
   * N6 gate — see resumeInternal).
   */
  private pauseForCoverageGate(reviewId: string, reason: string): BuildStepResult {
    this.store.append({
      runId: this.runId,
      type: "run.paused",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `coverage-paused:${reviewId}:${reason}:${this.projection().lastSequence}`,
      payload: { reason: "coverage_reviewer_unavailable" },
    });
    return { status: "paused", action: "coverage_reviewer_unavailable" };
  }

  /**
   * T9 (EP39/OA-5): advance a triage-`answer` run. The answer turn records the
   * answer; the opted-in review runs via the answer review driver until a
   * verdict covers the CURRENT answer (repair cycle 1 B1: a re-recorded
   * answer after a verdict drives a re-review with the prior review attached,
   * OA-10 #2); anything else missing (normally the STATE.md docs gate) gets an
   * Architect turn to fix; then the normal completion decision completes the
   * run through the explicit handoff. No critic, coverage, worker,
   * integration, or final-verification step is reachable from here.
   */
  private async advanceAnswerPath(projection: SchedulerProjection): Promise<BuildStepResult> {
    const answer = projection.requestAnswer;
    if (!answer) {
      await this.runArchitect({ type: "plan_required" }, projection);
      return this.afterArchitect("plan_required");
    }
    // Repair cycle 1 (B1): readiness binds the verdict to the current answer,
    // so the pump re-reviews while no verdict covers it — with the latest
    // verdict attached as the prior review when one exists.
    if (projection.answerReviewOptIn && !currentAnswerReviewVerdict(projection)) {
      const review = this.answerReview;
      const reviewId = nextAnswerReviewId(projection);
      const priorReview = latestAnswerReviewVerdict(projection);
      if (!review) {
        // No review driver configured: record the explicit gate and pause
        // for the owner — never silently skip an opted-in review.
        this.answerAuthority.recordUnavailable({
          runId: this.runId,
          reviewId,
          reason: "no_answer_review_driver",
          occurredAt: this.clock(),
        });
        return this.pauseForAnswerReviewGate(reviewId, "no_answer_review_driver");
      }
      const result = await review.review({
        runId: this.runId,
        reviewId,
        architectRuntimeId: projection.runtime.architect.runtimeId ?? this.architectId,
        question: this.initialObjective?.trim()
          ? this.initialObjective
          : (projection.requestTriage?.rationale ?? this.runId),
        answerText: answer.answerText,
        addressedParts: answer.addressedParts,
        answerSequence: answer.sequence,
        // T9 repair cycle 3 (N-C): the answer review sees every acknowledged
        // guidance text — including guidance folded after the answer — so a
        // re-answer driven by folded guidance is reviewed against it.
        guidance: acknowledgedUserGuidanceSnapshots(projection),
        ...(priorReview ? { priorReview } : {}),
        signal: this.activeLifecycleSignal(),
      });
      if (result.status === "reviewed") return { status: "progressed", action: "answer_review_recorded" };
      if (result.status === "suspended") {
        // A suspension is transient: record the visible gate and pause for
        // the owner; the owner's normal resume re-drives the retry.
        this.answerAuthority.recordUnavailable({
          runId: this.runId,
          reviewId,
          reason: "answer_review_suspended",
          detail: result.reason,
          occurredAt: this.clock(),
        });
        return this.pauseForAnswerReviewGate(reviewId, "answer_review_suspended");
      }
      return this.pauseForAnswerReviewGate(reviewId, result.reason);
    }
    const readiness = buildCompletionReadiness(this.projection());
    if (!readiness.ready) {
      await this.runArchitect({ type: "plan_required" }, projection);
      return this.afterArchitect("plan_required");
    }
    // Repair cycle 1 (B2): the handoff is already requested (the opt-in
    // arrived at the handoff pause and the review has since run): the request
    // is durable, so wait for the owner's selection instead of driving a
    // second completion turn whose complete_run would dedup to a no-op and
    // throw. Idempotent: no event is appended; repeatable until selected.
    if (this.projection().projectHandoff?.status === "requested") {
      return { status: "paused", action: "project_handoff_requested" };
    }
    const completionReason = projection.runPolicy === "plan_only"
      ? { type: "completion_decision_required", runPolicy: "plan_only" } as const
      : { type: "completion_decision_required" } as const;
    await this.runArchitect(completionReason, projection);
    return this.afterArchitect("completion_decision_required");
  }

  private pauseForAnswerReviewGate(reviewId: string, reason: string): BuildStepResult {
    this.store.append({
      runId: this.runId,
      type: "run.paused",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `answer-paused:${reviewId}:${reason}:${this.projection().lastSequence}`,
      payload: { reason: "answer_reviewer_unavailable" },
    });
    return { status: "paused", action: "answer_reviewer_unavailable" };
  }

  private async advancePlanCritique(projection: SchedulerProjection): Promise<BuildStepResult | undefined> {
    const driver = this.planCritic;
    const state = projection.planCritique;
    if (!driver || !state?.policy || state.policy.mode === "off" || state.skipped) return undefined;
    if (state.current?.status === "resolved") return undefined;
    const skip = (reason: PlanCritiqueSkipReason): BuildStepResult => {
      this.store.append({
        runId: this.runId, type: "plan_critique.skipped", occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `plan-critique:skip:${projection.planRevision}:${reason}`,
        payload: { planRevision: projection.planRevision, reason },
      });
      return { status: "progressed", action: "plan_critique_skipped" };
    };
    if (this.runPolicy === "plan_only") return skip("plan_only");
    if (!state.risk) {
      const input = {
        architectDeclaration: driver.architectDeclaration(projection),
        stricterQualification: driver.stricterQualification,
        tasks: Object.values(projection.tasks),
      };
      this.store.append({
        runId: this.runId, type: "plan_critique.risk_assessed", occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `plan-critique:risk:${projection.planRevision}`,
        payload: {
          planRevision: projection.planRevision,
          architectDeclaration: input.architectDeclaration,
          stricterQualification: input.stricterQualification,
          assessment: assessPlanRisk(input),
        },
      });
      return { status: "progressed", action: "plan_risk_assessed" };
    }
    if (!planCritiqueRequired(state.policy.mode, state.risk.assessment)) return skip("low_plan_risk");
    const current = state.current;
    if (current?.status === "submitted") {
      if ((current.blockingFindingIds ?? []).length === 0) {
        this.store.append({
          runId: this.runId, type: "plan_critique.resolved", occurredAt: this.clock(),
          actor: { role: "runner", id: "build-runtime" },
          idempotencyKey: `plan-critique:resolve:${current.critiqueId}`,
          payload: { critiqueId: current.critiqueId, planRevision: current.planRevision, resolutions: [] },
        });
        return { status: "progressed", action: "plan_critique_resolved_by_runner" };
      }
      await this.runArchitect({
        type: "plan_critique_resolution_required",
        critiqueId: current.critiqueId,
        planRevision: current.planRevision,
        blockingFindingIds: [...current.blockingFindingIds!],
      }, projection);
      if (this.projection().planCritique?.current?.status !== "resolved") {
        throw new Error("Architect returned from plan_critique_resolution_required without a typed action.");
      }
      return this.afterArchitect("plan_critique_resolution_required");
    }
    this.recordingFailureContext = {
      ...(projection.integrationRevision ? { revision: projection.integrationRevision } : {}),
    };
    const result = await driver.critique({
      runId: this.runId,
      projection,
      riskReasons: state.risk.assessment.reasons,
      ...(projection.verifierSelection?.status === "selected" && projection.verifierSelection.selectedRuntimeId
        ? { preferredRuntimeId: projection.verifierSelection.selectedRuntimeId }
        : {}),
      signal: this.activeLifecycleSignal(),
    });
    if (result.status === "submitted") return { status: "progressed", action: "plan_critique_submitted" };
    if (result.status === "suspended" && result.reason === "cancelled" && this.projection().status === "paused") {
      return { status: "paused", action: "plan_critic_interrupted" };
    }
    const failures = this.projection().planCritique?.history.length ?? 0;
    if (result.status === "suspended" && result.reason === "provider_error" && failures < 2) {
      return { status: "progressed", action: "plan_critic_provider_failed" };
    }
    if (!driver.stricterQualification && result.status === "suspended") return skip("critic_failed");
    this.store.append({
      runId: this.runId, type: "verifier.selection_required", occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `verifier-selection:plan-critique:${projection.planRevision}:${result.status === "unavailable" ? result.reason : result.reason}`,
      payload: {
        reason: "plan_critique_no_independent_runtime",
        requiredCapabilities: ["code"],
        candidateRuntimeIds: [...driver.candidateRuntimeIds],
      },
    });
    return { status: "paused", action: "verifier_selection_required" };
  }

  private pauseIfRepairCyclesExhausted(
    projection: SchedulerProjection,
    source: "final_verification" | "verifier",
    targetRevision: string,
  ): BuildStepResult | undefined {
    if (!repairCyclesExhausted(projection)) return undefined;
    const cycles = projection.repairCycles!;
    this.store.append({
      runId: this.runId,
      type: "repair.cycle_limit_reached",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `repair-cycle-limit:${targetRevision}:${cycles.used}:${cycles.extensions}`,
      payload: { source, targetRevision, used: cycles.used, limit: cycles.limit },
    });
    return { status: "paused", action: "repair_cycle_limit_reached" };
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

function firstMatchingArchitectActionEvent(
  events: readonly SchedulerEvent[],
  afterSequence: number,
  reason: ArchitectActionReason,
): SchedulerEvent | undefined {
  return events.find((event) =>
    event.sequence > afterSequence && architectLifecycleEventMatchesReason(event, reason)
  );
}

function firstPendingUserGuidance(projection: SchedulerProjection) {
  return Object.values(projection.userGuidance)
    .filter((guidance) => guidance.status === "submitted")
    .sort((left, right) => left.version - right.version)[0];
}

/**
 * T9 repair cycle 3 (N-C): every acknowledged user guidance as an
 * id-and-text snapshot for reviewer inputs. The reviewer that re-checks an
 * answer after folded guidance must see the guidance text.
 */
function acknowledgedUserGuidanceSnapshots(
  projection: SchedulerProjection,
): { id: string; text: string }[] {
  return Object.values(projection.userGuidance)
    .filter((guidance) => guidance.status === "acknowledged")
    .sort((left, right) => left.version - right.version)
    .map((guidance) => ({
      id: `${guidance.guidanceId}:v${guidance.version}`,
      text: guidance.text,
    }));
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
    userGuidance: {},
    userGuidanceVersion: 0,
    architectQuestions: {},
    architectQuestionVersion: 0,
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
  return redactSensitiveText(message, 4_096) || "Final verification cleanup failed.";
}

function projectDocSummaryRejected(summary: string): boolean {
  return !summary.trim() || summary.includes("\n") || summary.includes("\0");
}

function isProjectDocToolInput(input: unknown): input is {
  path: string;
  content: string;
  summary: string;
} {
  if (typeof input !== "object" || input === null) return false;
  const value = input as Record<string, unknown>;
  return typeof value.path === "string" &&
    typeof value.content === "string" &&
    typeof value.summary === "string";
}

/**
 * Exact sorted names `createArchitectTools` can register from an Architect turn.
 * One turn registers a subset: reason gates and `plan_only` omit tools. A4 may
 * move this list into role-capabilities. It is not a broker.
 */
export const ARCHITECT_LIFECYCLE_SURFACE: readonly string[] = Object.freeze([
  "acknowledge_user_guidance",
  "answer_guidance",
  "ask_user",
  "complete_run",
  "convert_to_build",
  "draft_planning_plan",
  "persist_planning_ledger",
  "plan_final_verification",
  "plan_tasks",
  "plan_verification_repairs",
  "plan_verifier_repairs",
  "read_planning_source_section",
  "reconcile_plan",
  "record_answer",
  "record_planning_checkpoint",
  "record_triage",
  "request_coverage_review",
  "request_integration",
  "resolve_context_recording",
  "resolve_delivery_boundary_failure",
  "resolve_plan_critique",
  "review_final_verification",
  "review_task",
  "revise_planning_plan",
  "revise_task",
  "upgrade_acceptance_contract",
  "write_project_doc",
]);

const ARCHITECT_LIFECYCLE_UNIVERSE: readonly Omit<ArchitectToolsOptions, "store" | "clock">[] = [
  {
    runPolicy: "finish",
    architectAction: { reason: { type: "plan_required" }, sequence: 0 },
  },
  {
    runPolicy: "budgeted",
    architectAction: { reason: { type: "plan_required" }, sequence: 0 },
  },
  {
    runPolicy: "plan_only",
    architectAction: { reason: { type: "plan_required" }, sequence: 0 },
  },
  {
    runPolicy: "plan_only",
    planOnlyCompletionAvailable: true,
    architectAction: {
      reason: { type: "completion_decision_required", runPolicy: "plan_only" },
      sequence: 0,
    },
  },
  {
    runPolicy: "finish",
    architectAction: {
      reason: {
        type: "context_recording_decision_required",
        purpose: "record",
        attempts: 1,
        reason: "failed",
        noteSequence: 1,
      },
      sequence: 0,
    },
  },
  {
    runPolicy: "finish",
    architectAction: {
      reason: { type: "user_guidance_required", guidanceId: "guidance", version: 1 },
      sequence: 0,
    },
  },
  {
    runPolicy: "finish",
    finalVerificationPlanAvailable: true,
    architectAction: {
      reason: { type: "final_verification_plan_required", integrationRevision: "rev" },
      sequence: 0,
    },
  },
  {
    runPolicy: "finish",
    finalVerificationReviewAvailable: true,
    architectAction: {
      reason: {
        type: "final_verification_review_required",
        taskId: "task",
        generationId: "generation",
        submissionId: "submission",
        targetRevision: "rev",
      },
      sequence: 0,
    },
  },
  {
    runPolicy: "finish",
    finalVerificationRepairPlanAvailable: true,
    architectAction: {
      reason: {
        type: "final_verification_repair_plan_required",
        finalVerificationTaskId: "task",
        generationId: "generation",
        targetRevision: "rev",
        source: { type: "semantic_review", submissionId: "submission", reviewId: "review" },
        failedCategories: [],
        evidenceIds: [],
      },
      sequence: 0,
    },
  },
  {
    runPolicy: "finish",
    verifierRepairPlanAvailable: true,
    architectAction: {
      reason: {
        type: "verifier_repair_plan_required",
        reviewId: "review",
        targetRevision: "rev",
        unsatisfiedCriteria: [],
      },
      sequence: 0,
    },
  },
  {
    // T6a: the failed integrated-boundary turn.
    runPolicy: "finish",
    deliveryBoundaryResolutionAvailable: true,
    architectAction: {
      reason: { type: "delivery_boundary_failed", taskId: "task", boundaryId: "boundary", integrationRevision: "rev", resolutionGeneration: 1 },
      sequence: 0,
    },
  },
  {
    runPolicy: "finish",
    planCritiqueResolutionAvailable: true,
    architectAction: { reason: { type: "plan_required" }, sequence: 0 },
  },
  {
    runPolicy: "finish",
    planningTools: {},
    architectAction: { reason: { type: "plan_required" }, sequence: 0 },
  },
  {
    // T3a repair (B1b): the planning-state registration shape. It registers
    // a subset of the universe (no legacy plan/task tools), so the surface
    // assert still holds; the entry keeps future shapes inside the surface.
    runPolicy: "finish",
    planningTools: {},
    planningState: true,
    architectAction: { reason: { type: "plan_required" }, sequence: 0 },
  },
  {
    // T9: the new-policy triage turn registers the triage tools alongside
    // the planning tools.
    runPolicy: "finish",
    planningTools: {},
    triageTools: true,
    architectAction: { reason: { type: "plan_required" }, sequence: 0 },
  },
  {
    // T9: the answer-path registration shape. It registers a subset of the
    // universe (no mutation lifecycle tools), so the surface assert still
    // holds; the entry keeps future shapes inside the surface.
    runPolicy: "finish",
    planningTools: {},
    triageTools: true,
    answerPath: true,
    architectAction: { reason: { type: "plan_required" }, sequence: 0 },
  },
];

/** Names produced by calling `createArchitectTools` across every registration shape. */
export function architectLifecycleUniverseNames(
  store: SchedulerStore,
  clock: () => string,
): readonly string[] {
  const names = new Set<string>();
  for (const options of ARCHITECT_LIFECYCLE_UNIVERSE) {
    for (const tool of createArchitectTools({
      store,
      clock,
      ...options,
      artifacts: ARCHITECT_LIFECYCLE_UNIVERSE_ARTIFACTS,
    })) {
      names.add(tool.definition.name);
    }
  }
  return Object.freeze([...names].sort(compareToolNames));
}

function assertArchitectLifecycleRegistration(
  registeredNames: readonly string[],
  requireLifecycleTools: boolean,
  store: SchedulerStore,
  clock: () => string,
  answerPathRequired?: readonly string[],
): void {
  const universe = architectLifecycleUniverseNames(store, clock);
  const surface = ARCHITECT_LIFECYCLE_SURFACE;
  if (!sortedNamesEqual(universe, surface)) {
    const allowed = new Set<string>(surface);
    const extra = universe.find((name) => !allowed.has(name));
    if (extra) {
      throw new Error(`Architect lifecycle registered tool ${extra} is not on the allow-list.`);
    }
    const present = new Set<string>(universe);
    const missing = surface.find((name) => !present.has(name));
    throw new Error(`Architect lifecycle surface omitted ${missing ?? "a required tool"}.`);
  }
  if (requireLifecycleTools) {
    for (const name of ARCHITECT_LIFECYCLE_TOOLS) {
      if (!registeredNames.includes(name)) {
        throw new Error(`Architect lifecycle required tool ${name} is missing.`);
      }
    }
  }
  if (answerPathRequired) {
    for (const name of answerPathRequired) {
      if (!registeredNames.includes(name)) {
        throw new Error(`Answer path required tool ${name} is missing.`);
      }
    }
  }
  const allowed = new Set<string>(surface);
  for (const name of registeredNames) {
    if (!allowed.has(name)) {
      throw new Error(`Architect lifecycle registered tool ${name} is not on the allow-list.`);
    }
  }
}

function sortedNamesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function compareToolNames(left: string, right: string): number {
  return left.localeCompare(right);
}

/** Present only so universe derivation lists write_project_doc. Never executed. */
const ARCHITECT_LIFECYCLE_UNIVERSE_ARTIFACTS = {} as ArtifactStore;
