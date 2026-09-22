import { parseRecoveryAuditRecord, recoveryBlocksRun, validateRecoveryTransition, type RecoveryAuditRecord } from "./process-recovery-contracts.js";
import { createHash } from "node:crypto";

import {
  isFinalVerificationTask,
  REPLAN_REASONS,
  type BuildTask,
  type PlanNewTask,
  type PlanReconciliation,
  type PlanTaskUpdate,
  type ReplanReason,
  type ReplanRequest,
} from "./task-contracts.js";
import { applyTaskTransition, validateTaskGraph } from "./task-graph.js";
import {
  planFinalVerification,
  validateFinalVerificationPlan,
  type FinalVerificationCategory,
  type FinalVerificationPlan,
} from "./final-verification-contracts.js";
import type { NativeBuildRunPolicy } from "./build-spec.js";
import {
  assertSatisfiedVerdictsCiteGreenEvidence,
  validateCriterionEvidenceLinks,
  validateCriterionReviewVerdicts,
  validateAcceptanceCriteria,
  type AcceptanceCriterion,
  type CriterionEvidenceLink,
  type CriterionReviewVerdict,
  type GreenEvidenceVerdict,
} from "./acceptance-contracts.js";
import {
  evidenceFactArtifactHashes,
  type EvidenceStore,
} from "./evidence-store.js";
import type {
  FinalVerificationCheckResult,
  FinalVerificationFact,
} from "./final-verification-runtime.js";
import type { FinalVerificationSubmission } from "./final-verification-submission.js";
import {
  assertFinalVerificationExecutionProfile,
  cloneFinalVerificationExecutionProfile,
  type FinalVerificationExecutionProfile,
} from "./final-verification-profile.js";
import {
  assertFinalVerificationCheckSemantics,
  assertFinalVerificationFactSchema,
} from "./final-verification-semantics.js";
import {
  parseArchitectQuestionAnswer,
  parseArchitectQuestionRequest,
  parseUserGuidanceAcknowledgement,
  parseUserGuidanceSubmission,
  type ArchitectActionReason,
  type ArchitectQuestionItem,
  type UserGuidanceAcknowledgementResolution,
  type UserGuidanceItem,
} from "./user-steering-contracts.js";
import {
  isSteeringReassignedWorkerId,
  steeringReassignedWorkerId,
  workerSessionId,
} from "./worker-identity.js";
import {
  assertExactVerifierCriteria,
  cloneVerifierProjection,
  cloneVerifierReview,
  expectedVerifierCriteria,
  parseExcludedModels,
  parseRuntimeBinding,
  parseVerifierReviewRequest,
  parseVerifierVerdict,
  sameVerifierReview,
  type VerifierCriterionReference,
  type VerifierProjection,
} from "./verifier-contracts.js";
import {
  assessPlanRisk,
  parsePlanCritiqueFindings,
  planCritiqueRequired,
  PLAN_CRITIQUE_MODES,
  type PlanCritiqueFinding,
  type PlanCritiqueMode,
  type PlanCritiqueProjection,
  type PlanCritiqueResolutionItem,
  type PlanCritiqueSkipReason,
  type PlanCritiqueState,
  type PlanRiskAssessment,
  type PlanRiskLevel,
} from "./plan-critique-contracts.js";
import {
  assessBuildRisk,
  type BuildRiskAssessment,
  type BuildRiskAssessmentInput,
} from "./risk-policy.js";

export type SchedulerActorRole =
  | "architect"
  | "worker"
  | "verifier"
  | "runner"
  | "user";

export interface SchedulerActor {
  role: SchedulerActorRole;
  id: string;
}

export type SchedulerEventType =
  | "process.recovery_updated"
  | "run.initialized"
  | "run.policy_configured"
  | "plan.created"
  | "plan.reconciled"
  | "task.revised"
  | "task.transitioned"
  | "guidance.requested"
  | "guidance.answered"
  | "guidance.challenged"
  | "user.guidance_submitted"
  | "user.guidance_interruption_completed"
  | "user.guidance_acknowledged"
  | "architect.question_requested"
  | "architect.question_answered"
  | "architect.question_resume_started"
  | "architect.question_resume_consumed"
  | "review.requested"
  | "review.decided"
  | "run.paused"
  | "run.resumed"
  | "run.completed"
  | "project.handoff_requested"
  | "project.handoff_selected"
  | "provider.retry_scheduled"
  | "provider.health_changed"
  | "worker.runtime_assigned"
  | "architect.runtime_assigned"
  | "architect.handoff_required"
  | "architect.handoff_selected"
  | "acceptance_contract.upgrade_required"
  | "acceptance_contract.upgraded"
  | "integration.revision_advanced"
  | "final_verification.generation_created"
  | "final_verification.check_completed"
  | "final_verification.failure_reported"
  | "final_verification.submitted"
  | "final_verification.cleanup_started"
  | "final_verification.cleanup_succeeded"
  | "final_verification.cleanup_failed"
  | "final_verification.review_requested"
  | "final_verification.review_decided"
  | "final_verification.repairs_planned"
  | "verifier.policy_configured"
  | "build.risk_assessed"
  | "verifier.selection_required"
  | "verifier.selection_selected"
  | "verifier.review_requested"
  | "verifier.verdict_submitted"
  | "verifier.repairs_planned"
  | "repair.policy_configured"
  | "repair.cycle_limit_reached"
  | "repair.cycle_limit_extended"
  | "plan_critique.policy_configured"
  | "plan_critique.risk_assessed"
  | "plan_critique.requested"
  | "plan_critique.submitted"
  | "plan_critique.resolved"
  | "plan_critique.skipped";

export interface SchedulerEvent {
  eventId: string;
  runId: string;
  sequence: number;
  type: SchedulerEventType;
  occurredAt: string;
  actor: SchedulerActor;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export type NewSchedulerEvent = Omit<SchedulerEvent, "eventId" | "sequence">;

export interface GuidanceProjection {
  requestId: string;
  taskId: string;
  blocking: boolean;
  question: string;
  evidenceSequence: number;
  version: number;
  status: "open" | "answered";
  answer?: string;
  challengeEvidenceSequence?: number;
  challengedVersion?: number;
  challengeReason?: string;
  kind?: "question" | "replan";
  replan?: ReplanRequest;
}

export interface CriterionSubmissionProjection {
  taskId: string;
  attempt: number;
  acceptanceCriteriaVersion?: number;
  changeSetId?: string;
  criterionEvidenceLinks?: CriterionEvidenceLink[];
}

export interface ReviewProjection {
  taskId: string;
  /** Omitted only for legacy projections that predate attempt binding. */
  attempt?: number;
  /** Omitted only for legacy projections that predate criterion versioning. */
  acceptanceCriteriaVersion?: number;
  status: "requested" | "approved" | "rejected";
  summary?: string;
  evidenceArtifactHashes: string[];
  criterionEvidenceLinks?: CriterionEvidenceLink[];
  criterionVerdicts?: CriterionReviewVerdict[];
}

export interface AcceptanceContractAuditProjection {
  status: NonNullable<SchedulerProjection["acceptanceContractStatus"]>;
  planRevision: number;
  tasks: Record<string, {
    acceptanceCriteria: AcceptanceCriterion[];
    acceptanceCriteriaVersion?: number;
    criterionEvidenceLinks: CriterionEvidenceLink[];
    criterionVerdicts: CriterionReviewVerdict[];
    reviewStatus?: ReviewProjection["status"];
    submissionHistory: CriterionSubmissionProjection[];
    reviewHistory: ReviewProjection[];
  }>;
}

export interface ProviderHealthProjection {
  providerId: string;
  status: "healthy" | "cooldown";
  consecutiveFailures: number;
  updatedAt: number;
  failureKind?: string;
  failureMessage?: string;
  cooldownUntil?: number;
}

export interface WorkerRuntimeAssignmentProjection {
  taskId: string;
  attempt: number;
  runtimeId: string;
  sessionId: string;
}

export interface ArchitectHandoffProjection {
  reason: string;
  requiredCapabilities: string[];
  candidateRuntimeIds: string[];
}

export interface RuntimeProjection {
  providerHealth: Record<string, ProviderHealthProjection>;
  workerAssignments: Record<string, WorkerRuntimeAssignmentProjection>;
  architect: {
    runtimeId?: string;
    handoff?: ArchitectHandoffProjection;
  };
}

export type ProjectHandoffChoice =
  | "keep_integration_branch"
  | "apply_to_project";

export interface ProjectHandoffProjection {
  status: "requested" | "selected";
  summary: string;
  options: ProjectHandoffChoice[];
  choice?: ProjectHandoffChoice;
  integrationRevision?: string;
  integrationBranch?: string;
  appliedToProject?: boolean;
  projectRevision?: string;
}

export interface WithdrawnProjectHandoffProjection
  extends Omit<ProjectHandoffProjection, "status"> {
  status: "withdrawn";
  withdrawnByGuidanceId: string;
}

export interface FinalVerificationSubmissionReference {
  submissionId: string;
  generationId: string;
  targetRevision: string;
  attempt: number;
}

export interface FinalVerificationReviewReference {
  reviewId: string;
  submissionId: string;
  generationId: string;
  targetRevision: string;
  attempt: number;
  status: "requested" | "approved" | "repair_required" | "rejected";
  decision?: FinalVerificationReviewDecisionProjection;
}

export interface FinalVerificationCategoryReviewProjection {
  category: FinalVerificationCategory;
  verdict: "approved" | "repair_required";
  rationale: string;
  evidenceIds: string[];
}

export interface FinalVerificationReviewDecisionProjection {
  decision: "approved" | "repair_required";
  summary: string;
  targetRevision: string;
  architectRisk: {
    risk: "low" | "high";
    rationale?: string;
    source: "architect" | "legacy_default";
  };
  categoryReviews: FinalVerificationCategoryReviewProjection[];
  failedCategories: FinalVerificationCategory[];
}

export interface FinalVerificationGenerationProjection {
  taskId: string;
  generationId: string;
  targetRevision: string;
  planVersion: number;
  plan: FinalVerificationPlan;
  executionProfile: FinalVerificationExecutionProfile;
  state: "current" | "invalidated";
  invalidatedByRevision?: string;
  invalidatedByGuidanceId?: string;
  completedChecks?: FinalVerificationCompletedCheckProjection[];
  failure?: FinalVerificationFailureProjection;
  submission?: FinalVerificationSubmissionReference;
  submissionResult?: FinalVerificationSubmission;
  cleanup?: FinalVerificationCleanupProjection;
  review?: FinalVerificationReviewReference;
  repairTaskIds?: string[];
}

export interface FinalVerificationFailureProjection {
  failureId: string;
  generationId: string;
  taskId: string;
  targetRevision: string;
  attempt: number;
  failedCategories: FinalVerificationCategory[];
  issueIds: string[];
  factIds: string[];
  evidenceIds: string[];
  reportedAt: string;
}

export function deriveFinalVerificationFailure(
  generation: FinalVerificationGenerationProjection,
  attempt: number,
): Omit<FinalVerificationFailureProjection, "reportedAt"> {
  const failed = (generation.completedChecks ?? []).filter((check) => !check.green);
  const failedCategories = failed.map((check) => check.category);
  const issueIds = failed.flatMap((check) => {
    const issues = check.issues.length > 0
      ? check.issues
      : [`${check.category} is mechanically non-green without issue detail.`];
    return issues.map(
      (issue, index) => failureReference("issue", check.category, index, issue),
    );
  });
  const factIds = failed.flatMap((check) => check.facts.map(
    (fact, index) => failureReference("fact", check.category, index, canonicalJson(fact)),
  ));
  const evidenceIds = [...new Set(failed.flatMap((check) => check.evidenceIds))].sort();
  const identity = {
    generationId: generation.generationId,
    taskId: generation.taskId,
    targetRevision: generation.targetRevision,
    attempt,
    failedCategories,
    issueIds,
    factIds,
    evidenceIds,
  };
  return {
    failureId: `final-verification-failure:${createHash("sha256").update(canonicalJson(identity)).digest("hex")}`,
    ...identity,
  };
}

export interface FinalVerificationCleanupProjection {
  generationId: string;
  taskId: string;
  targetRevision: string;
  attempt: number;
  status: "started" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  diagnosticsPath?: string;
  error?: string;
}

export interface FinalVerificationCompletedCheckProjection
  extends FinalVerificationCheckResult {
  attempt: number;
  workspacePath: string;
  startedAt: string;
  finishedAt: string;
}

export interface FinalVerificationProjection {
  current?: FinalVerificationGenerationProjection;
  history: FinalVerificationGenerationProjection[];
}

export interface VerifierPolicyProjection {
  mode: "risk_based";
  candidateRuntimeIds: string[];
  alwaysRequireIndependentVerifier: boolean;
}

export interface BuildRiskAssessmentProjection {
  targetRevision: string;
  input: BuildRiskAssessmentInput;
  assessment: BuildRiskAssessment;
  state: "current" | "invalidated" | "superseded";
  assessedAt: string;
  invalidatedByRevision?: string;
  invalidatedByGuidanceId?: string;
}

export interface BuildRiskProjection {
  current?: BuildRiskAssessmentProjection;
  history: BuildRiskAssessmentProjection[];
}

export interface VerifierSelectionProjection {
  status: "required" | "selected";
  reason: string;
  requiredCapabilities: string[];
  candidateRuntimeIds: string[];
  selectedRuntimeId?: string;
}

export const DEFAULT_REPAIR_PLAN_LIMIT = 3;
export const MAX_REPAIR_CYCLE_EXTENSION = 10;

export interface RepairCyclesProjection {
  limit: number;
  used: number;
  extensions: number;
  pause?: {
    source: "final_verification" | "verifier";
    targetRevision: string;
    used: number;
    limit: number;
  };
}

export interface SchedulerProjection {
  processRecovery?: Record<string, RecoveryAuditRecord>;
  runId: string;
  /** Optional for event-log compatibility with runs created before P3.1. */
  initialObjective?: string;
  runPolicy?: NativeBuildRunPolicy;
  /**
   * Live scheduler events use running/paused/completed. Terminal historical
   * readers additionally project the authoritative RunSupervisor failed or
   * stopped state without recreating mutable scheduler authority.
   */
  status: "running" | "paused" | "completed" | "failed" | "stopped";
  /**
   * Legacy plans remain readable, but an active plan without criteria must
   * pass through one append-only Architect upgrade before it can proceed.
   */
  acceptanceContractStatus?:
    | "current"
    | "acceptance_contract_upgrade_required"
    | "legacy_completed";
  acceptanceUpgradeRequiredEventRecorded?: boolean;
  pauseReason?: {
    reason: string;
    taskId?: string;
  };
  planRevision: number;
  tasks: Record<string, BuildTask>;
  guidance: Record<string, GuidanceProjection>;
  userGuidance: Record<string, UserGuidanceItem>;
  userGuidanceVersion: number;
  architectQuestions: Record<string, ArchitectQuestionItem>;
  architectQuestionVersion: number;
  blockingArchitectQuestionId?: string;
  reviews: Record<string, ReviewProjection>;
  /** Completed submissions retained as immutable attempt/version history. */
  submissionHistory?: Record<string, CriterionSubmissionProjection[]>;
  /** Completed Architect decisions retained as immutable attempt/version history. */
  reviewHistory?: Record<string, ReviewProjection[]>;
  runtime: RuntimeProjection;
  integrationRevision?: string;
  finalVerification?: FinalVerificationProjection;
  verifierPolicy?: VerifierPolicyProjection;
  buildRisk?: BuildRiskProjection;
  verifierSelection?: VerifierSelectionProjection;
  repairCycles?: RepairCyclesProjection;
  verifier?: VerifierProjection;
  planRiskDeclaration?: {
    risk: PlanRiskLevel;
    rationale?: string;
    source: "architect" | "legacy_default";
  };
  planCritique?: PlanCritiqueState;
  projectHandoff?: ProjectHandoffProjection;
  projectHandoffHistory?: WithdrawnProjectHandoffProjection[];
  lastArchitectActionEvent?: {
    sequence: number;
    type: SchedulerEventType;
    actor: SchedulerActor;
    payload: Record<string, unknown>;
  };
  lastSequence: number;
}

export interface SchedulerStore {
  append(input: NewSchedulerEvent): SchedulerEvent;
  readRun(runId: string, afterSequence?: number): SchedulerEvent[];
  close(): void;
}

export function repairCyclesExhausted(projection: SchedulerProjection): boolean {
  const cycles = projection.repairCycles;
  return cycles !== undefined && cycles.used >= cycles.limit;
}

export function planCritiquePending(projection: SchedulerProjection): boolean {
  const state = projection.planCritique;
  if (!state?.policy || state.policy.mode === "off") return false;
  if (state.skipped) return false;
  if (!state.risk) return true;
  if (!planCritiqueRequired(state.policy.mode, state.risk.assessment)) return false;
  return state.current?.status !== "resolved";
}

export function consumeRepairCycle(projection: SchedulerProjection): void {
  const cycles = projection.repairCycles;
  if (!cycles) return;
  if (cycles.used >= cycles.limit) {
    throw new Error(
      `Repair plan limit reached: ${cycles.used} of ${cycles.limit} repair plans used; the user must extend the repair-cycle budget.`,
    );
  }
  projection.repairCycles = { ...cycles, used: cycles.used + 1 };
}

export function assertPendingUserGuidanceAllowsEvent(
  current: SchedulerProjection,
  event: Pick<SchedulerEvent, "type" | "actor" | "payload">
): void {
  const hasPendingUserGuidance = Object.values(current.userGuidance).some(
    (guidance) => guidance.status === "submitted"
  );
  if (!hasPendingUserGuidance || event.type === "process.recovery_updated") return;

  const taskStatus = event.type === "task.transitioned"
    ? event.payload.status
    : undefined;
  const resumeQuestion =
    (event.type === "architect.question_resume_started" ||
      event.type === "architect.question_resume_consumed") &&
    typeof event.payload.questionId === "string"
      ? current.architectQuestions[event.payload.questionId]
      : undefined;
  const initialPlanQuestionResume =
    resumeQuestion?.checkpoint?.reason.type === "plan_required" &&
    ((event.type === "architect.question_resume_started" && current.planRevision === 0) ||
      (event.type === "architect.question_resume_consumed" &&
        resumeQuestion.resumeStatus === "started"));
  const oldestPendingGuidance = Object.values(current.userGuidance)
    .filter((guidance) => guidance.status === "submitted")
    .sort((left, right) => left.version - right.version)[0];
  const guidanceQuestionResume =
    event.type === "architect.question_resume_started" &&
    resumeQuestion?.checkpoint?.reason.type === "user_guidance_required" &&
    resumeQuestion.checkpoint.reason.guidanceId === oldestPendingGuidance?.guidanceId &&
    resumeQuestion.checkpoint.reason.version === oldestPendingGuidance.version;
  const allowed =
    event.type === "user.guidance_submitted" ||
    (event.type === "user.guidance_interruption_completed" &&
      event.actor.role === "runner" && event.actor.id === "build-manager") ||
    event.type === "user.guidance_acknowledged" ||
    event.type === "architect.question_requested" ||
    event.type === "architect.question_answered" ||
    event.type === "architect.question_resume_consumed" ||
    ((event.type === "run.paused" || event.type === "run.resumed") &&
      event.actor.role === "user") ||
    event.type === "provider.retry_scheduled" ||
    event.type === "provider.health_changed" ||
    event.type === "architect.runtime_assigned" ||
    event.type === "architect.handoff_required" ||
    event.type === "architect.handoff_selected" ||
    event.type === "acceptance_contract.upgrade_required" ||
    initialPlanQuestionResume ||
    guidanceQuestionResume ||
    event.type === "integration.revision_advanced" ||
    event.type === "final_verification.cleanup_started" ||
    event.type === "final_verification.cleanup_succeeded" ||
    event.type === "final_verification.cleanup_failed" ||
    (event.type === "plan.created" && current.planRevision === 0) ||
    (event.type === "task.transitioned" &&
      (taskStatus === "integrated" || taskStatus === "integration_resolution"));
  if (!allowed) {
    throw new Error(
      `Pending user guidance must be acknowledged before ${event.type} may advance the run.`
    );
  }
}

export function assertOpenArchitectQuestionAllowsEvent(
  current: SchedulerProjection,
  event: Pick<SchedulerEvent, "type" | "actor" | "payload">
): void {
  if (!current.blockingArchitectQuestionId || event.type === "process.recovery_updated") return;
  const allowed =
    event.type === "architect.question_answered" ||
    event.type === "architect.question_resume_consumed" ||
    event.type === "user.guidance_submitted" ||
    (event.type === "user.guidance_interruption_completed" &&
      event.actor.role === "runner" && event.actor.id === "build-manager") ||
    ((event.type === "run.paused" || event.type === "run.resumed") &&
      event.actor.role === "user") ||
    event.type === "provider.retry_scheduled" ||
    event.type === "provider.health_changed" ||
    event.type === "architect.runtime_assigned" ||
    event.type === "architect.handoff_required" ||
    event.type === "architect.handoff_selected";
  if (!allowed) {
    throw new Error(
      `Blocking Architect question ${current.blockingArchitectQuestionId} must be answered before ${event.type} may advance the run.`
    );
  }
}

export function architectLifecycleEventMatchesReason(
  event: Pick<SchedulerEvent, "type" | "actor" | "payload">,
  reason: ArchitectActionReason,
): boolean {
  if (event.type === "architect.question_requested") {
    if (event.actor.role !== "architect") return false;
    const checkpoint = event.payload.checkpoint;
    return typeof checkpoint === "object" && checkpoint !== null &&
      !Array.isArray(checkpoint) &&
      sameValue((checkpoint as Record<string, unknown>).reason, reason);
  }
  switch (reason.type) {
    case "plan_required":
      return event.actor.role === "architect" && event.type === "plan.created";
    case "acceptance_contract_upgrade_required":
      return event.actor.role === "architect" && event.type === "acceptance_contract.upgraded";
    case "user_guidance_required":
      return event.actor.role === "architect" && event.type === "user.guidance_acknowledged" &&
        event.payload.guidanceId === reason.guidanceId &&
        event.payload.expectedVersion === reason.version;
    case "guidance_required":
      return event.actor.role === "architect" && (
        (event.type === "guidance.answered" && event.payload.requestId === reason.requestId) ||
        (event.type === "plan.reconciled" &&
          Array.isArray(event.payload.taskUpdates) &&
          event.payload.taskUpdates.some((update) =>
            isRecord(update) && update.taskId === reason.taskId))
      );
    case "review_required":
      return event.actor.role === "architect" && event.type === "review.decided" && event.payload.taskId === reason.taskId;
    case "integration_approval_required":
    case "integration_resolution_required":
      return event.actor.role === "architect" && event.type === "task.transitioned" &&
        event.payload.taskId === reason.taskId && event.payload.status === "integrating";
    case "completion_decision_required":
      return event.actor.role === "architect" &&
        (event.type === "project.handoff_requested" || event.type === "run.completed");
    case "final_verification_plan_required":
      return event.actor.role === "runner" && event.actor.id === "build-runtime" &&
        event.type === "final_verification.generation_created" &&
        event.payload.targetRevision === reason.integrationRevision;
    case "final_verification_review_required":
      return event.actor.role === "architect" && event.type === "final_verification.review_decided" &&
        event.payload.taskId === reason.taskId &&
        event.payload.generationId === reason.generationId &&
        event.payload.submissionId === reason.submissionId &&
        event.payload.targetRevision === reason.targetRevision;
    case "final_verification_repair_plan_required":
      return event.actor.role === "architect" && event.type === "final_verification.repairs_planned" &&
        event.payload.finalVerificationTaskId === reason.finalVerificationTaskId &&
        event.payload.generationId === reason.generationId &&
        event.payload.targetRevision === reason.targetRevision;
    case "verifier_repair_plan_required":
      return event.actor.role === "architect" &&
        event.type === "verifier.repairs_planned" &&
        event.payload.reviewId === reason.reviewId &&
        event.payload.targetRevision === reason.targetRevision;
    case "task_failure_resolution_required":
      return event.actor.role === "architect" &&
        ((event.type === "task.revised" && event.payload.taskId === reason.taskId) ||
        (event.type === "plan.reconciled" &&
          Array.isArray(event.payload.taskUpdates) &&
          event.payload.taskUpdates.some((update) =>
            isRecord(update) && update.taskId === reason.taskId)));
    case "plan_critique_resolution_required":
      return event.actor.role === "architect" &&
        event.type === "plan_critique.resolved" &&
        event.payload.critiqueId === reason.critiqueId;
  }
}

function isArchitectLifecycleEvent(event: SchedulerEvent): boolean {
  return [
    "architect.question_requested",
    "plan.created",
    "plan.reconciled",
    "acceptance_contract.upgraded",
    "user.guidance_acknowledged",
    "guidance.answered",
    "review.decided",
    "project.handoff_requested",
    "run.completed",
    "final_verification.generation_created",
    "final_verification.review_decided",
    "final_verification.repairs_planned",
    "verifier.repairs_planned",
    "task.revised",
    "plan_critique.resolved",
  ].includes(event.type) ||
    (event.type === "task.transitioned" &&
      event.actor.role === "architect" && event.payload.status === "integrating");
}

function architectActionReasonIsApplicable(
  projection: SchedulerProjection,
  reason: ArchitectActionReason,
): boolean {
  switch (reason.type) {
    case "plan_required":
      return projection.planRevision === 0;
    case "acceptance_contract_upgrade_required":
      return projection.acceptanceContractStatus === "acceptance_contract_upgrade_required";
    case "user_guidance_required": {
      const guidance = projection.userGuidance[reason.guidanceId];
      return guidance?.status === "submitted" && guidance.version === reason.version;
    }
    case "guidance_required": {
      const guidance = projection.guidance[reason.requestId];
      return guidance?.status === "open" && guidance.taskId === reason.taskId;
    }
    case "review_required": {
      const task = projection.tasks[reason.taskId];
      return (task?.status === "submitted" || task?.status === "architect_review") &&
        task.changeSetId === reason.changeSetId;
    }
    case "integration_approval_required": {
      const task = projection.tasks[reason.taskId];
      return task?.status === "approved" && task.changeSetId === reason.changeSetId;
    }
    case "completion_decision_required":
      return reason.runPolicy === "plan_only"
        ? projection.runPolicy === "plan_only" && projection.planRevision > 0
        : buildCompletionReadiness(projection).ready;
    case "final_verification_plan_required":
      return Object.values(projection.tasks).every((task) =>
        task.kind === "final_verification" ||
        task.status === "integrated" ||
        task.status === "cancelled"
      ) &&
        typeof projection.integrationRevision === "string" &&
        projection.integrationRevision.trim().length > 0 &&
        projection.integrationRevision === reason.integrationRevision &&
        projection.finalVerification?.current === undefined;
    case "final_verification_review_required": {
      const current = projection.finalVerification?.current;
      return current?.taskId === reason.taskId &&
        current.generationId === reason.generationId &&
        current.targetRevision === reason.targetRevision &&
        current.submission?.submissionId === reason.submissionId;
    }
    case "final_verification_repair_plan_required": {
      const current = projection.finalVerification?.current;
      return current?.taskId === reason.finalVerificationTaskId &&
        current.generationId === reason.generationId &&
        current.targetRevision === reason.targetRevision;
    }
    case "verifier_repair_plan_required": {
      const current = projection.verifier?.current;
      if (
        current?.state !== "current" ||
        current.status !== "submitted" ||
        current.verdict?.satisfied !== false ||
        current.reviewId !== reason.reviewId ||
        current.targetRevision !== reason.targetRevision ||
        projection.integrationRevision !== reason.targetRevision
      ) return false;
      const unsatisfied = current.verdict.criterionVerdicts
        .filter((criterion) => criterion.verdict === "unsatisfied")
        .map((criterion) => ({
          taskId: criterion.taskId,
          criterionId: criterion.criterionId,
          rationale: criterion.rationale,
          evidenceIds: [...criterion.evidenceIds],
        }));
      return sameValue(unsatisfied, reason.unsatisfiedCriteria);
    }
    case "task_failure_resolution_required": {
      const task = projection.tasks[reason.taskId];
      if (!task || task.attempt !== reason.attempt) return false;
      if (task.status === "failed") {
        return (task.failureReason ?? "worker_failed") === reason.failureReason;
      }
      const attemptBudgetIsStillExhausted =
        task.attemptLimit === undefined || task.attempt >= task.attemptLimit;
      if (task.status === "rejected") {
        return attemptBudgetIsStillExhausted &&
          reason.failureReason === "architect_rejected_attempt_budget_exhausted";
      }
      return task.status === "planned" &&
        attemptBudgetIsStillExhausted &&
        reason.failureReason === "task_attempt_budget_exhausted";
    }
    case "integration_resolution_required":
      return projection.tasks[reason.taskId]?.status === "integration_resolution";
    case "plan_critique_resolution_required": {
      const current = projection.planCritique?.current;
      return current?.status === "submitted" &&
        current.critiqueId === reason.critiqueId &&
        current.planRevision === reason.planRevision &&
        sameValue(current.blockingFindingIds ?? [], reason.blockingFindingIds);
    }
  }
}

export interface BuildCompletionReadiness {
  ready: boolean;
  issues: string[];
}

/**
 * The authoritative Build completion invariant shared by every terminal path.
 * Plan-only runs intentionally retain their existing plan handoff lifecycle.
 */
export function buildCompletionReadiness(
  projection: SchedulerProjection,
): BuildCompletionReadiness {
  const issues: string[] = [];
  if (projection.runPolicy === "plan_only") {
    if (projection.planRevision <= 0) issues.push("Plan-only completion requires a valid plan.");
    return { ready: issues.length === 0, issues };
  }

  const nonterminal = Object.values(projection.tasks).find(
    (task) => task.kind !== "final_verification" &&
      task.status !== "integrated" && task.status !== "cancelled",
  );
  if (nonterminal) {
    issues.push(`Ordinary task ${nonterminal.id} is not terminal (${nonterminal.status}).`);
  }
  const integrationRevision = projection.integrationRevision;
  if (!integrationRevision?.trim()) {
    issues.push("Canonical integration revision is missing.");
  }
  const current = projection.finalVerification?.current;
  if (!current || current.state !== "current") {
    issues.push("A current final-verification generation is required.");
    return { ready: false, issues };
  }
  if (projection.finalVerification?.history.some((generation) => generation.state === "current")) {
    issues.push("Final-verification history contains a second current generation.");
  }
  if (current.targetRevision !== integrationRevision) {
    issues.push("Current final-verification target does not match the canonical integration revision.");
  }
  const task = projection.tasks[current.taskId];
  if (
    !task || task.kind !== "final_verification" ||
    task.generationId !== current.generationId ||
    task.targetRevision !== current.targetRevision ||
    task.planVersion !== current.planVersion ||
    !sameValue(task.verificationPlan, current.plan)
  ) {
    issues.push("Current final-verification task binding is invalid.");
  }
  const planValidation = validateFinalVerificationPlan(current.plan);
  if (!planValidation.valid) {
    issues.push(`Current final-verification plan is invalid: ${planValidation.issues.join(" ")}`);
  }
  const plannedCategories = current.plan.checks.map((check) => check.category);
  const completed = current.completedChecks ?? [];
  if (
    completed.length !== plannedCategories.length ||
    new Set(completed.map((check) => check.category)).size !== plannedCategories.length
  ) {
    issues.push("Completed final-verification facts must represent every planned category exactly once.");
  }
  for (const planned of current.plan.checks) {
    const check = completed.find((candidate) => candidate.category === planned.category);
    if (!check || !sameValue(projectFinalVerificationCheck(check), planned)) {
      issues.push(`Completed final-verification category ${planned.category} is missing or conflicts with the plan.`);
      continue;
    }
    if (check.green !== true || check.issues.length > 0) {
      issues.push(`Completed final-verification category ${planned.category} is not mechanically green.`);
    }
    if (planned.status === "required") {
      if (check.evidenceIds.length === 0 || check.facts.length === 0 || check.evidenceIds.length !== check.facts.length) {
        issues.push(`Required final-verification category ${planned.category} is missing evidence.`);
      }
    } else if (check.evidenceIds.length > 0 || check.facts.length > 0) {
      issues.push(`Not-applicable final-verification category ${planned.category} carries executable evidence.`);
    }
  }

  const submission = current.submission;
  const result = current.submissionResult;
  if (!submission || !result) {
    issues.push("A complete persisted final-verification submission result is required.");
  } else {
    if (
      submission.generationId !== current.generationId ||
      submission.targetRevision !== current.targetRevision ||
      result.kind !== "final_verification_submission" ||
      result.runId !== projection.runId ||
      result.taskId !== current.taskId ||
      result.generationId !== current.generationId ||
      result.targetRevision !== current.targetRevision ||
      result.attempt !== submission.attempt ||
      result.green !== true ||
      !sameValue(result.plan, current.plan)
    ) {
      issues.push("Final-verification submission is stale, foreign, incomplete, or non-green.");
    }
    if (
      result.checks.length !== plannedCategories.length ||
      new Set(result.checks.map((check) => check.category)).size !== plannedCategories.length
    ) {
      issues.push("Final-verification submission must represent every planned category exactly once.");
    }
    for (const planned of current.plan.checks) {
      const submitted = result.checks.find((check) => check.category === planned.category);
      const checkpoint = completed.find((check) => check.category === planned.category);
      if (
        !submitted || submitted.green !== true ||
        !sameValue({
          category: submitted.category,
          status: submitted.status,
          ...(submitted.rationale !== undefined ? { rationale: submitted.rationale } : {}),
          ...(submitted.repositoryInspection
            ? { repositoryInspection: submitted.repositoryInspection }
            : {}),
        }, planned) ||
        !checkpoint || checkpoint.attempt !== submission.attempt ||
        !sameValue(submitted.evidenceIds, checkpoint.evidenceIds) ||
        !sameValue(submitted.facts, checkpoint.facts)
      ) {
        issues.push(`Submitted final-verification category ${planned.category} is incomplete or conflicts with persisted facts.`);
      }
    }
  }

  const cleanup = current.cleanup;
  if (
    !cleanup || cleanup.status !== "succeeded" ||
    cleanup.generationId !== current.generationId ||
    cleanup.taskId !== current.taskId ||
    cleanup.targetRevision !== current.targetRevision ||
    !cleanup.finishedAt
  ) {
    issues.push("Current final-verification owned cleanup has not durably succeeded.");
  }

  const review = current.review;
  if (
    !review || review.status !== "approved" || !review.decision ||
    review.decision.decision !== "approved" ||
    review.generationId !== current.generationId ||
    review.targetRevision !== current.targetRevision ||
    review.submissionId !== submission?.submissionId ||
    review.attempt !== submission?.attempt ||
    review.decision.targetRevision !== current.targetRevision ||
    review.decision.failedCategories.length > 0
  ) {
    issues.push("A current structured approved final-verification review is required.");
  } else if (result) {
    const categoryReviews = review.decision.categoryReviews;
    if (
      categoryReviews.length !== plannedCategories.length ||
      new Set(categoryReviews.map((category) => category.category)).size !== plannedCategories.length
    ) {
      issues.push("Final-verification review must represent every planned category exactly once.");
    }
    for (const planned of current.plan.checks) {
      const categoryReview = categoryReviews.find((candidate) => candidate.category === planned.category);
      const submitted = result.checks.find((candidate) => candidate.category === planned.category);
      if (
        !categoryReview || categoryReview.verdict !== "approved" ||
        !categoryReview.rationale.trim() || !submitted ||
        !sameValue([...categoryReview.evidenceIds].sort(), [...submitted.evidenceIds].sort())
      ) {
        issues.push(`Approved final-verification review for ${planned.category} is missing or cites invalid evidence.`);
      }
    }
  }
  if (
    task?.verificationSubmissionId !== submission?.submissionId ||
    task?.verificationReviewId !== review?.reviewId
  ) {
    issues.push("Final-verification task submission/review references are invalid.");
  }
  if (projection.verifierPolicy?.mode === "risk_based") {
    const risk = projection.buildRisk?.current;
    if (
      !risk || risk.state !== "current" ||
      risk.targetRevision !== integrationRevision
    ) {
      issues.push("A current build-risk assessment is required.");
    } else if (risk.assessment.risk === "high") {
      const verifier = projection.verifier?.current;
      if (
        !verifier || verifier.state !== "current" ||
        verifier.status !== "submitted" ||
        verifier.verdict?.satisfied !== true ||
        verifier.targetRevision !== integrationRevision ||
        verifier.finalVerificationGenerationId !== current.generationId
      ) {
        issues.push(
          "High-risk completion requires a current positive independent verifier verdict; a missing, pending, stale, or unsatisfied verdict blocks completion.",
        );
      }
    }
  }
  return { ready: issues.length === 0, issues };
}

export function assertBuildCompletionReady(projection: SchedulerProjection): void {
  const readiness = buildCompletionReadiness(projection);
  if (!readiness.ready) {
    throw new Error(`Build completion is not ready: ${readiness.issues.join(" ")}`);
  }
}

export function rebuildSchedulerProjection(
  events: readonly SchedulerEvent[]
): SchedulerProjection {
  if (events.length === 0) throw new Error("Cannot rebuild an empty scheduler run.");
  let projection: SchedulerProjection | undefined;
  for (const event of events) projection = reduceSchedulerEvent(projection, event);
  return projection!;
}

/**
 * Validate evidence against the authoritative immutable evidence store before
 * a scheduler event is appended. The reducer remains pure; this check is the
 * durable boundary that prevents references to records that do not exist.
 */
export function validateSchedulerEvidenceEvent(
  projection: SchedulerProjection | undefined,
  event: SchedulerEvent,
  evidenceStore: EvidenceStore
): void {
  if (!projection) return;
  if (event.type === "user.guidance_acknowledged") {
    const resolution = event.payload.resolution;
    if (isRecord(resolution) && resolution.type === "no_plan_change") {
      const evidenceIds = stringArray(resolution, "evidenceIds");
      const records = evidenceStore.getByIds({ runId: event.runId, ids: evidenceIds });
      if (records.length !== evidenceIds.length) {
        throw new Error("No-plan-change acknowledgement cites missing or foreign evidence.");
      }
    }
    return;
  }
  if (event.type === "final_verification.check_completed") {
    validateFinalVerificationCheckEvidence(projection, event, evidenceStore);
    return;
  }
  if (event.type === "final_verification.submitted") {
    const result = event.payload.submissionResult;
    if (!isRecord(result) || !Array.isArray(result.checks)) {
      throw new Error("Final verification submission result is invalid.");
    }
    for (const check of result.checks) {
      validateFinalVerificationEvidenceSet({
        projection,
        event,
        evidenceStore,
        check,
        targetRevision: requiredString(event.payload, "targetRevision"),
        taskId: requiredString(event.payload, "taskId"),
        generationId: requiredString(event.payload, "generationId"),
        attempt: requiredPositiveInteger(event.payload, "attempt"),
      });
    }
    return;
  }
  if (event.type === "final_verification.repairs_planned") {
    const current = projection.finalVerification?.current;
    if (!current || !Array.isArray(event.payload.tasks)) {
      throw new Error("Final verification repair plan is invalid.");
    }
    const evidenceIds = event.payload.tasks.flatMap((candidate) => {
      if (!isRecord(candidate)) throw new Error("Final verification repair task is invalid.");
      return stringArray(candidate, "evidenceIds");
    });
    const records = evidenceStore.getByIds({
      runId: event.runId,
      taskId: current.taskId,
      ids: [...new Set(evidenceIds)],
    });
    if (records.length !== new Set(evidenceIds).size) {
      throw new Error("Final verification repair plan cites missing or foreign evidence.");
    }
    return;
  }
  if (
    event.type === "final_verification.review_decided" &&
    Array.isArray(event.payload.categoryReviews)
  ) {
    const current = projection.finalVerification?.current;
    if (!current?.submissionResult || current.submissionResult.green !== true) {
      throw new Error("Final verification review requires a durable submission result.");
    }
    const evidenceIds = event.payload.categoryReviews.flatMap((candidate) => {
      if (!isRecord(candidate)) {
        throw new Error("Final verification category review is invalid.");
      }
      const category = requiredString(candidate, "category");
      const cited = stringArray(candidate, "evidenceIds");
      const submitted = current.submissionResult!.checks.find(
        (check) => check.category === category,
      );
      if (
        !submitted ||
        !submitted.green ||
        !sameValue([...submitted.evidenceIds].sort(), [...new Set(cited)].sort())
      ) {
        throw new Error(
          `Final verification category ${category} review conflicts with submitted evidence.`,
        );
      }
      return cited;
    });
    const records = evidenceStore.getByIds({
      runId: event.runId,
      taskId: current.taskId,
      ids: [...new Set(evidenceIds)],
    });
    if (records.length !== new Set(evidenceIds).size) {
      throw new Error("Final verification review cites missing or foreign evidence.");
    }
    return;
  }
  if (event.type === "verifier.verdict_submitted") {
    if (!Array.isArray(event.payload.criterionVerdicts)) {
      throw new Error("Verifier verdict requires criterion verdicts.");
    }
    const evidenceIds = event.payload.criterionVerdicts.flatMap((candidate) => {
      if (!isRecord(candidate)) {
        throw new Error("Verifier criterion verdict is invalid.");
      }
      return stringArray(candidate, "evidenceIds");
    });
    const uniqueEvidenceIds = [...new Set(evidenceIds)];
    const records = evidenceStore.getByIds({
      runId: event.runId,
      ids: uniqueEvidenceIds,
    });
    if (records.length !== uniqueEvidenceIds.length) {
      throw new Error("Verifier verdict cites missing or foreign evidence.");
    }
    assertSatisfiedVerdictsCiteGreenEvidence(
      event.payload.criterionVerdicts as GreenEvidenceVerdict[],
      records,
      "Verifier verdict",
    );
    return;
  }
  if (event.type === "verifier.repairs_planned") {
    if (!Array.isArray(event.payload.tasks)) {
      throw new Error("Verifier repair plan is invalid.");
    }
    const evidenceIds = event.payload.tasks.flatMap((candidate) => {
      if (!isRecord(candidate)) throw new Error("Verifier repair task is invalid.");
      return stringArray(candidate, "evidenceIds");
    });
    const uniqueEvidenceIds = [...new Set(evidenceIds)];
    const records = evidenceStore.getByIds({
      runId: event.runId,
      ids: uniqueEvidenceIds,
    });
    if (records.length !== uniqueEvidenceIds.length) {
      throw new Error("Verifier repair plan cites missing or foreign evidence.");
    }
    return;
  }
  if (event.type === "task.transitioned" && event.payload.status === "submitted") {
    const taskId = requiredString(event.payload, "taskId");
    const task = projection.tasks[taskId];
    if (task?.acceptanceCriteria) {
      const assignedWorkerId = requiredAssignedWorkerId(
        task.assignedWorkerId,
        "Task submission",
      );
      const links = boundCriterionEvidenceLinks(task, event.payload.patch);
      const records = getEvidenceRecords(evidenceStore, event.runId, task.id, links);
      assertDurableEvidence(
        task.acceptanceCriteria,
        links,
        records,
        {
          runId: event.runId,
          taskId: task.id,
          attempt: task.attempt,
          assignedWorkerId,
        },
        "Task submission",
      );
    }
    return;
  }
  if (event.type === "review.requested") {
    const taskId = requiredString(event.payload, "taskId");
    const task = projection.tasks[taskId];
    if (task?.acceptanceCriteria) {
      const assignedWorkerId = requiredAssignedWorkerId(
        task.assignedWorkerId,
        "Review request",
      );
      const links = boundCriterionEvidenceLinks(task, event.payload.criterionEvidenceLinks);
      const records = getEvidenceRecords(evidenceStore, event.runId, task.id, links);
      assertDurableEvidence(
        task.acceptanceCriteria,
        links,
        records,
        {
          runId: event.runId,
          taskId: task.id,
          attempt: task.attempt,
          assignedWorkerId,
        },
        "Review request",
      );
      assertReviewArtifactHashes(
        event.payload.evidenceArtifactHashes,
        records,
        "Review request",
      );
    }
    return;
  }
  if (event.type !== "review.decided") return;
  const taskId = requiredString(event.payload, "taskId");
  const task = projection.tasks[taskId];
  if (!task?.acceptanceCriteria || !task.criterionEvidenceLinks) return;
  const assignedWorkerId = requiredAssignedWorkerId(
    task.assignedWorkerId,
    "Review decision",
  );
  const records = getEvidenceRecords(
    evidenceStore,
    event.runId,
    task.id,
    task.criterionEvidenceLinks,
  );
  const options = {
    runId: event.runId,
    taskId: task.id,
    attempt: task.attempt,
    assignedWorkerId,
  };
  assertDurableEvidence(
    task.acceptanceCriteria,
    task.criterionEvidenceLinks,
    records,
    options,
    "Review decision",
  );
  const verdicts = Array.isArray(event.payload.criterionVerdicts)
    ? event.payload.criterionVerdicts as CriterionReviewVerdict[]
    : [];
  const verdictValidation = validateCriterionReviewVerdicts(
    task.acceptanceCriteria,
    verdicts,
    task.criterionEvidenceLinks,
    { evidenceRecords: records, ...options },
  );
  if (!verdictValidation.valid) {
    throw new Error(
      `Review decision has invalid durable evidence: ${verdictValidation.issues.join(" ")}`
    );
  }
  assertReviewArtifactHashes(
    event.payload.evidenceArtifactHashes,
    records,
    "Review decision",
  );
  assertSatisfiedVerdictsCiteGreenEvidence(verdicts, records, "Review decision");
}

function validateFinalVerificationCheckEvidence(
  projection: SchedulerProjection,
  event: SchedulerEvent,
  evidenceStore: EvidenceStore,
): void {
  const result = event.payload.result;
  if (!isRecord(result)) throw new Error("Final verification check result is invalid.");
  validateFinalVerificationEvidenceSet({
    projection,
    event,
    evidenceStore,
    check: result,
    targetRevision: requiredString(event.payload, "targetRevision"),
    taskId: requiredString(event.payload, "taskId"),
    generationId: requiredString(event.payload, "generationId"),
    attempt: requiredPositiveInteger(event.payload, "attempt"),
  });
}

function validateFinalVerificationEvidenceSet(input: {
  projection: SchedulerProjection;
  event: SchedulerEvent;
  evidenceStore: EvidenceStore;
  check: unknown;
  targetRevision: string;
  taskId: string;
  generationId: string;
  attempt: number;
}): void {
  if (!isRecord(input.check)) throw new Error("Final verification check evidence is invalid.");
  const category = requiredString(input.check, "category");
  if (!["build", "tests", "runtime_smoke", "browser"].includes(category)) {
    throw new Error(`Final verification fact category ${category} is invalid.`);
  }
  const evidenceIds = stringArray(input.check, "evidenceIds");
  if (!Array.isArray(input.check.facts)) {
    throw new Error(`Final verification ${category} facts are invalid.`);
  }
  const facts = input.check.facts;
  const status = requiredString(input.check, "status");
  if (status !== "required" && status !== "not_applicable") {
    throw new Error(`Final verification ${category} status is invalid.`);
  }
  const issues = input.check.issues === undefined && input.event.type === "final_verification.submitted"
    ? []
    : input.check.issues;
  if (typeof input.check.green !== "boolean" || !Array.isArray(issues) ||
    issues.some((issue) => typeof issue !== "string")) {
    throw new Error(`Final verification ${category} outcome schema is invalid.`);
  }
  if (status === "not_applicable" && (
    input.check.green !== true || evidenceIds.length > 0 || facts.length > 0 || issues.length > 0
  )) {
    throw new Error(`Not-applicable final verification ${category} cannot carry executable evidence.`);
  }
  if (status === "required" && input.check.green === true && facts.length === 0) {
    throw new Error(`Required final verification ${category} is missing evidence.`);
  }
  if (facts.length !== evidenceIds.length) {
    throw new Error(`Final verification ${category} facts do not correspond exactly to evidence records.`);
  }
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw new Error(`Final verification ${category} evidence IDs must be unique.`);
  }
  const current = input.projection.finalVerification?.current;
  if (!current || current.generationId !== input.generationId || current.targetRevision !== input.targetRevision) {
    throw new Error("Final verification evidence is not bound to the current execution profile.");
  }
  const completedWorkspace = current.completedChecks?.find(
    (completed) => completed.category === category,
  )?.workspacePath;
  assertFinalVerificationCheckSemantics({
    check: input.check,
    profile: current.executionProfile,
    targetRevision: input.targetRevision,
    workspacePath: input.event.type === "final_verification.check_completed"
      ? requiredString(input.event.payload, "workspacePath")
      : completedWorkspace ?? "",
  });
  const records = input.evidenceStore.getByIds({
    runId: input.event.runId,
    taskId: input.taskId,
    ids: evidenceIds,
  });
  if (records.length !== evidenceIds.length) {
    throw new Error(`Final verification ${category} cites missing or foreign evidence records.`);
  }
  for (let index = 0; index < facts.length; index += 1) {
    const fact = facts[index];
    assertFinalVerificationFactSchema(fact, category, input.targetRevision);
    const record = records[index];
    if (
      record.id !== evidenceIds[index] ||
      record.runId !== input.event.runId ||
      record.taskId !== input.taskId ||
      record.attempt !== input.attempt ||
      record.status !== "observed" ||
      !record.idempotencyKey.startsWith(`${input.generationId}:`) ||
      !sameValue(record.fact, fact)
    ) {
      throw new Error(`Final verification ${category} fact does not match authoritative evidence ${evidenceIds[index]}.`);
    }
  }
}

export function finalVerificationEventArtifactHashes(event: SchedulerEvent): string[] {
  const checks: unknown[] = [];
  if (event.type === "final_verification.check_completed") checks.push(event.payload.result);
  if (event.type === "final_verification.submitted" && isRecord(event.payload.submissionResult)) {
    const submissionChecks = event.payload.submissionResult.checks;
    if (Array.isArray(submissionChecks)) checks.push(...submissionChecks);
  }
  return checks.flatMap((check) => {
    if (!isRecord(check) || !Array.isArray(check.facts)) return [];
    return check.facts.flatMap((fact) => {
      assertFinalVerificationFactSchema(fact, requiredString(check, "category"), requiredString(event.payload, "targetRevision"));
      return evidenceFactArtifactHashes(fact as FinalVerificationFact);
    });
  });
}

function assertDurableEvidence(
  criteria: readonly AcceptanceCriterion[],
  links: readonly CriterionEvidenceLink[],
  records: readonly import("./evidence-store.js").EvidenceRecord[],
  options: Parameters<typeof validateCriterionEvidenceLinks>[2],
  label: string,
): void {
  const validation = validateCriterionEvidenceLinks(criteria, links, {
    evidenceRecords: records,
    ...options,
  });
  if (!validation.valid) {
    throw new Error(`${label} has invalid durable evidence: ${validation.issues.join(" ")}`);
  }
}

function assertReviewArtifactHashes(
  value: unknown,
  records: readonly import("./evidence-store.js").EvidenceRecord[],
  label: string,
): void {
  if (!Array.isArray(value)) return;
  const available = new Set(records.flatMap((record) => {
    switch (record.fact.kind) {
      case "command":
        return [record.fact.stdoutArtifactHash, record.fact.stderrArtifactHash];
      case "browser_snapshot":
        return [record.fact.htmlArtifactHash];
      case "browser_screenshot":
        return [record.fact.screenshotArtifactHash];
      case "browser_events":
        return [record.fact.eventsArtifactHash];
    }
  }));
  const invalid = value.filter(
    (hash): hash is string => typeof hash !== "string" || !available.has(hash)
  );
  if (invalid.length > 0) {
    throw new Error(`${label} cites artifact hashes outside its durable evidence.`);
  }
}

function getEvidenceRecords(
  evidenceStore: EvidenceStore,
  runId: string,
  taskId: string,
  links: readonly CriterionEvidenceLink[],
) {
  const ids = links
    .map((link) => link.evidenceId)
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  return evidenceStore.getByIds({ runId, taskId, ids: [...new Set(ids)] });
}

function boundCriterionEvidenceLinks(
  task: BuildTask,
  payload: unknown,
): CriterionEvidenceLink[] {
  const patch = isRecord(payload) ? payload : undefined;
  const raw = Array.isArray(patch?.criterionEvidenceLinks)
    ? patch.criterionEvidenceLinks
    : Array.isArray(payload)
      ? payload
      : [];
  return raw.map((candidate) => {
    if (!isRecord(candidate)) return candidate as unknown as CriterionEvidenceLink;
    return {
      ...candidate,
      taskId: candidate.taskId ?? task.id,
      attempt: candidate.attempt ?? task.attempt,
      ...(Array.isArray(candidate.artifactHashes)
        ? { artifactHashes: [...candidate.artifactHashes] }
        : {}),
    } as unknown as CriterionEvidenceLink;
  });
}

export function acceptanceContractAuditProjection(
  projection: SchedulerProjection
): AcceptanceContractAuditProjection {
  return {
    status: projection.acceptanceContractStatus ?? "current",
    planRevision: projection.planRevision,
    tasks: Object.fromEntries(
      Object.values(projection.tasks).map((task) => {
        const review = projection.reviews[task.id];
        return [task.id, {
          acceptanceCriteria: (task.acceptanceCriteria ?? []).map((criterion) => ({
            id: criterion.id,
            text: criterion.text,
          })),
          ...(task.acceptanceCriteriaVersion !== undefined
            ? { acceptanceCriteriaVersion: task.acceptanceCriteriaVersion }
            : {}),
          criterionEvidenceLinks: (task.criterionEvidenceLinks ?? []).map((link) => ({
            criterionId: link.criterionId,
            evidenceId: link.evidenceId,
            artifactHashes: [...link.artifactHashes],
            ...(link.taskId !== undefined ? { taskId: link.taskId } : {}),
            ...(link.attempt !== undefined ? { attempt: link.attempt } : {}),
          })),
          criterionVerdicts: (review?.criterionVerdicts ?? []).map((verdict) => ({
            criterionId: verdict.criterionId,
            verdict: verdict.verdict,
            rationale: verdict.rationale,
            evidenceIds: [...verdict.evidenceIds],
            ...(verdict.artifactHashes
              ? { artifactHashes: [...verdict.artifactHashes] }
              : {}),
            ...(verdict.acceptedFailures
              ? {
                  acceptedFailures: verdict.acceptedFailures.map((failure) => ({
                    ...failure,
                  })),
                }
              : {}),
          })),
          ...(review ? { reviewStatus: review.status } : {}),
          submissionHistory: (projection.submissionHistory?.[task.id] ?? []).map(
            cloneSubmissionProjection
          ),
          reviewHistory: (projection.reviewHistory?.[task.id] ?? []).map(
            cloneReviewProjection
          ),
        }];
      })
    ),
  };
}

export function reduceSchedulerEvent(
  current: SchedulerProjection | undefined,
  event: SchedulerEvent
): SchedulerProjection {
  if (!current) {
    if (event.sequence !== 1) {
      throw new Error(`Scheduler run ${event.runId} must begin at sequence 1.`);
    }
    if (event.type === "run.initialized") {
      if (event.actor.role !== "runner" && event.actor.role !== "user") {
        throw new Error("Only the runner or user may initialize a scheduler run.");
      }
      return emptySchedulerProjection(event);
    }
    if (event.type === "run.policy_configured") {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may configure a scheduler run policy.");
      }
      return {
        ...emptySchedulerProjection(event),
        runPolicy: requiredRunPolicy(event.payload),
      };
    }
    if (event.type !== "plan.created") {
      throw new Error(
        `Scheduler run ${event.runId} must begin with run.initialized, run.policy_configured, or plan.created.`
      );
    }
    if (event.actor.role !== "architect") {
      throw new Error("Only the Architect may create a plan.");
    }
    const tasks = event.payload.tasks as BuildTask[];
    const validation = validateTaskGraph(tasks);
    if (!validation.valid) {
      throw new Error(
        `Plan has mechanical issues: ${validation.issues.map((issue) => issue.code).join(", ")}.`
      );
    }
    return planProjection(event, tasks);
  }
  if (event.runId !== current.runId || event.sequence !== current.lastSequence + 1) {
    throw new Error(`Scheduler event ${event.eventId} has invalid run ordering.`);
  }
  assertPendingUserGuidanceAllowsEvent(current, event);
  assertOpenArchitectQuestionAllowsEvent(current, event);
  if (
    event.actor.role === "verifier" &&
    event.type !== "verifier.verdict_submitted" &&
    event.type !== "plan_critique.submitted"
  ) {
    throw new Error("The verifier has no scheduler lifecycle authority.");
  }
  const next: SchedulerProjection = {
    ...current,
    tasks: { ...current.tasks },
    guidance: { ...current.guidance },
    userGuidance: Object.fromEntries(
      Object.entries(current.userGuidance).map(([guidanceId, guidance]) => [
        guidanceId,
        cloneUserGuidanceItem(guidance),
      ]),
    ),
    architectQuestions: { ...current.architectQuestions },
    reviews: { ...current.reviews },
    submissionHistory: cloneSubmissionHistory(current.submissionHistory),
    reviewHistory: cloneReviewHistory(current.reviewHistory),
    ...(current.finalVerification
      ? { finalVerification: cloneFinalVerificationProjection(current.finalVerification) }
      : {}),
    ...(current.verifier
      ? { verifier: cloneVerifierProjection(current.verifier) }
      : {}),
    ...(current.planRiskDeclaration
      ? { planRiskDeclaration: { ...current.planRiskDeclaration } }
      : {}),
    ...(current.planCritique
      ? { planCritique: clonePlanCritiqueState(current.planCritique) }
      : {}),
    ...(current.verifierPolicy
      ? {
          verifierPolicy: {
            ...current.verifierPolicy,
            candidateRuntimeIds: [...current.verifierPolicy.candidateRuntimeIds],
          },
        }
      : {}),
    ...(current.buildRisk
      ? { buildRisk: cloneBuildRiskProjection(current.buildRisk) }
      : {}),
    ...(current.verifierSelection
      ? {
          verifierSelection: {
            ...current.verifierSelection,
            requiredCapabilities: [...current.verifierSelection.requiredCapabilities],
            candidateRuntimeIds: [...current.verifierSelection.candidateRuntimeIds],
          },
        }
      : {}),
    ...(current.repairCycles
      ? { repairCycles: cloneRepairCyclesProjection(current.repairCycles) }
      : {}),
    ...(current.projectHandoff
      ? {
          projectHandoff: {
            ...current.projectHandoff,
            options: [...current.projectHandoff.options],
          },
        }
      : {}),
    ...(current.projectHandoffHistory
      ? {
          projectHandoffHistory: current.projectHandoffHistory.map((handoff) => ({
            ...handoff,
            options: [...handoff.options],
          })),
        }
      : {}),
    runtime: {
      providerHealth: { ...current.runtime.providerHealth },
      workerAssignments: { ...current.runtime.workerAssignments },
      architect: { ...current.runtime.architect },
    },
    lastSequence: event.sequence,
  };
  switch (event.type) {
    case "process.recovery_updated": {
      if (["completed", "failed", "stopped"].includes(current.status)) {
        throw new Error("A terminal Build cannot accept exceptional recovery updates.");
      }
      if (Object.keys(event.payload).length !== 1 || !Object.hasOwn(event.payload, "record")) throw new Error("Recovery event payload is not closed.");
      const record = parseRecoveryAuditRecord(event.payload.record);
      if (record.scope.runId !== event.runId) throw new Error("Recovery event belongs to a different run.");
      const prior = Object.hasOwn(current.processRecovery ?? {}, record.proposalId) ? current.processRecovery?.[record.proposalId] : undefined;
      validateRecoveryTransition(prior, record, event.actor, event.occurredAt);
      next.processRecovery = { ...current.processRecovery, [record.proposalId]: record };
      if (recoveryBlocksRun(next.processRecovery)) {
        next.status = "paused";
        next.pauseReason = { reason: "Exceptional process recovery requires an exact decision or cleanup proof." };
      }
      break;
    }
    case "run.initialized":
      throw new Error("A scheduler run cannot be initialized twice.");
    case "run.policy_configured": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may configure a scheduler run policy.");
      }
      const runPolicy = requiredRunPolicy(event.payload);
      if (current.runPolicy && current.runPolicy !== runPolicy) {
        throw new Error(
          `Scheduler run policy is already configured as ${current.runPolicy}.`
        );
      }
      next.runPolicy = runPolicy;
      break;
    }
    case "plan.created": {
      if (current.planRevision !== 0 || Object.keys(current.tasks).length > 0) {
        throw new Error("A scheduler run cannot create a second initial plan.");
      }
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may create a plan.");
      }
      const tasks = event.payload.tasks as BuildTask[];
      const validation = validateTaskGraph(tasks);
      if (!validation.valid) {
        throw new Error(
          `Plan has mechanical issues: ${validation.issues.map((issue) => issue.code).join(", ")}.`
        );
      }
      next.planRevision = requiredNumber(event.payload, "revision");
      next.tasks = Object.fromEntries(tasks.map((task) => [task.id, cloneBuildTask(task)]));
      next.acceptanceContractStatus = acceptanceContractStatusForTasks(tasks);
      next.planRiskDeclaration = parsePlanRiskDeclaration(event.payload);
      break;
    }
    case "acceptance_contract.upgrade_required": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may require an acceptance-contract upgrade.");
      }
      if (next.status === "completed" || next.acceptanceContractStatus === "legacy_completed") {
        throw new Error("A completed legacy run cannot be upgraded in place.");
      }
      if (next.acceptanceUpgradeRequiredEventRecorded) {
        throw new Error("An acceptance-contract upgrade gate was already recorded.");
      }
      const taskIds = stringArray(event.payload, "taskIds");
      const requiredTaskIds = missingAcceptanceCriteriaTaskIds(next.tasks);
      if (requiredTaskIds.length === 0) {
        throw new Error("No acceptance-contract upgrade is required for this run.");
      }
      if (
        new Set(taskIds).size !== taskIds.length ||
        !sameStringSet(taskIds, requiredTaskIds)
      ) {
        throw new Error(
          "Acceptance-contract upgrade gate must identify every non-cancelled legacy task exactly once."
        );
      }
      next.acceptanceContractStatus = "acceptance_contract_upgrade_required";
      next.acceptanceUpgradeRequiredEventRecorded = true;
      break;
    }
    case "acceptance_contract.upgraded": {
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may upgrade an acceptance contract.");
      }
      applyAcceptanceContractUpgrade(
        next,
        parseAcceptanceContractUpgrade(event.payload)
      );
      break;
    }
    case "plan.reconciled": {
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may reconcile a plan.");
      }
      applyPlanReconciliation(next, parsePlanReconciliation(event.payload));
      break;
    }
    case "integration.revision_advanced": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may advance the integration revision.");
      }
      advanceIntegrationRevision(
        next,
        requiredString(event.payload, "integrationRevision"),
        event.payload.previousIntegrationRevision,
      );
      break;
    }
    case "final_verification.generation_created": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may create a final verification generation.");
      }
      createFinalVerificationGeneration(next, event.payload);
      break;
    }
    case "final_verification.check_completed": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may complete a final verification check.");
      }
      recordFinalVerificationCheck(next, event.payload);
      break;
    }
    case "final_verification.failure_reported": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may report a final verification failure.");
      }
      recordFinalVerificationFailure(next, event.payload, event.occurredAt);
      break;
    }
    case "final_verification.submitted": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may submit final verification.");
      }
      recordFinalVerificationSubmission(next, event.payload);
      break;
    }
    case "final_verification.cleanup_started": {
      if (event.actor.role !== "runner") throw new Error("Only the runner may start final verification cleanup.");
      recordFinalVerificationCleanup(next, event.payload, "started", event.occurredAt);
      break;
    }
    case "final_verification.cleanup_succeeded": {
      if (event.actor.role !== "runner") throw new Error("Only the runner may complete final verification cleanup.");
      recordFinalVerificationCleanup(next, event.payload, "succeeded", event.occurredAt);
      break;
    }
    case "final_verification.cleanup_failed": {
      if (event.actor.role !== "runner") throw new Error("Only the runner may fail final verification cleanup.");
      recordFinalVerificationCleanup(next, event.payload, "failed", event.occurredAt);
      break;
    }
    case "final_verification.review_requested": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may request final verification review.");
      }
      recordFinalVerificationReviewRequest(next, event.payload);
      break;
    }
    case "final_verification.review_decided": {
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may decide final verification review.");
      }
      recordFinalVerificationReviewDecision(next, event.payload);
      break;
    }
    case "final_verification.repairs_planned": {
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may plan final verification repairs.");
      }
      createFinalVerificationRepairTasks(next, event.payload);
      break;
    }
    case "verifier.policy_configured": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may configure independent verifier policy.");
      }
      const policy = parseVerifierPolicy(event.payload);
      if (current.verifierPolicy && !sameValue(current.verifierPolicy, policy)) {
        throw new Error("Independent verifier policy is already configured differently.");
      }
      next.verifierPolicy = policy;
      break;
    }
    case "build.risk_assessed": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may assess build risk.");
      }
      recordBuildRiskAssessment(next, event.payload, event.occurredAt);
      break;
    }
    case "verifier.selection_required": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may require verifier selection.");
      }
      const policyCandidates = next.verifierPolicy?.candidateRuntimeIds;
      if (!policyCandidates) {
        throw new Error("Verifier selection requires configured verifier policy.");
      }
      const candidateRuntimeIds = stringArray(event.payload, "candidateRuntimeIds");
      if (!sameValue(candidateRuntimeIds, policyCandidates)) {
        throw new Error("Verifier selection candidates conflict with configured policy.");
      }
      const requiredCapabilities = stringArray(
        event.payload,
        "requiredCapabilities",
      );
      if (
        requiredCapabilities.length === 0 ||
        requiredCapabilities.some((capability) => !capability.trim())
      ) {
        throw new Error("Verifier selection requires non-empty capabilities.");
      }
      next.verifierSelection = {
        status: "required",
        reason: requiredString(event.payload, "reason"),
        requiredCapabilities,
        candidateRuntimeIds: [...candidateRuntimeIds],
      };
      next.status = "paused";
      delete next.pauseReason;
      break;
    }
    case "verifier.selection_selected": {
      if (event.actor.role !== "user") {
        throw new Error("Verifier runtime selection requires the user.");
      }
      const selection = next.verifierSelection;
      const runtimeId = requiredString(event.payload, "runtimeId");
      if (
        !selection || selection.status !== "required" ||
        !selection.candidateRuntimeIds.includes(runtimeId)
      ) {
        throw new Error(`Runtime ${runtimeId} is not an offered verifier selection.`);
      }
      next.verifierSelection = {
        ...selection,
        status: "selected",
        selectedRuntimeId: runtimeId,
      };
      next.status = "running";
      delete next.pauseReason;
      break;
    }
    case "verifier.review_requested": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may request an independent verifier review.");
      }
      recordVerifierReviewRequest(next, event.payload, event.occurredAt);
      break;
    }
    case "verifier.verdict_submitted": {
      if (event.actor.role !== "verifier") {
        throw new Error("Only the selected verifier may submit a verifier verdict.");
      }
      recordVerifierVerdict(next, event, event.occurredAt);
      break;
    }
    case "verifier.repairs_planned": {
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may plan verifier repairs.");
      }
      createVerifierRepairTasks(next, event.payload);
      break;
    }
    case "repair.policy_configured": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may configure repair policy.");
      }
      const limit = event.payload.repairPlanLimit;
      if (!Number.isSafeInteger(limit) || (limit as number) < 0) {
        throw new Error("repairPlanLimit must be a non-negative integer.");
      }
      if (current.repairCycles && current.repairCycles.limit !== limit) {
        throw new Error("Repair policy is already configured differently.");
      }
      next.repairCycles = current.repairCycles ?? { limit: limit as number, used: 0, extensions: 0 };
      break;
    }
    case "repair.cycle_limit_reached": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may report a repair-cycle limit.");
      }
      const cycles = current.repairCycles;
      if (!cycles) throw new Error("Repair-cycle limit requires configured repair policy.");
      const source = event.payload.source;
      if (source !== "final_verification" && source !== "verifier") {
        throw new Error("Repair-cycle limit source is invalid.");
      }
      const used = requiredNumber(event.payload, "used");
      const limit = requiredNumber(event.payload, "limit");
      if (used !== cycles.used || limit !== cycles.limit || used < limit) {
        throw new Error("Repair-cycle limit event does not match the kernel repair-cycle count.");
      }
      next.repairCycles = {
        ...cycles,
        pause: { source, targetRevision: requiredString(event.payload, "targetRevision"), used, limit },
      };
      next.status = "paused";
      next.pauseReason = { reason: "repair_cycle_limit" };
      break;
    }
    case "repair.cycle_limit_extended": {
      if (event.actor.role !== "user") {
        throw new Error("Repair-cycle extension requires the user.");
      }
      const cycles = current.repairCycles;
      if (!cycles?.pause) throw new Error("There is no repair-cycle pause to extend.");
      const additional = event.payload.additionalRepairPlans;
      if (
        !Number.isSafeInteger(additional) ||
        (additional as number) < 1 ||
        (additional as number) > MAX_REPAIR_CYCLE_EXTENSION
      ) {
        throw new Error(`additionalRepairPlans must be an integer between 1 and ${MAX_REPAIR_CYCLE_EXTENSION}.`);
      }
      next.repairCycles = {
        limit: cycles.limit + (additional as number),
        used: cycles.used,
        extensions: cycles.extensions + 1,
      };
      next.status = "running";
      delete next.pauseReason;
      break;
    }
    case "task.revised": {
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may revise a task.");
      }
      const taskId = requiredString(event.payload, "taskId");
      const task = next.tasks[taskId];
      if (!task) throw new Error(`Unknown task ${taskId}.`);
      if (isFinalVerificationTask(task)) {
        throw new Error("Kernel-owned final verification task metadata is immutable.");
      }
      if (
        task.status !== "planned" &&
        task.status !== "failed" &&
        task.status !== "rejected"
      ) {
        throw new Error(`Task ${taskId} must be planned, failed, or rejected before revision.`);
      }
      const patch = (event.payload.patch as Partial<BuildTask> | undefined) ?? {};
      if (
        task.kind === "verification_repair" &&
        (
          Object.hasOwn(patch, "verificationRepair") ||
          Object.hasOwn(patch, "verifierRepair") ||
          Object.hasOwn(patch, "kind")
        )
      ) {
        throw new Error("Verification repair provenance and kind are immutable.");
      }
      const grantsFreshAttempt =
        task.status === "failed" ||
        task.status === "rejected" ||
        (task.status === "planned" && task.attempt > 0);
      const criteriaChanged = Object.hasOwn(patch, "acceptanceCriteria");
      const revised: BuildTask = grantsFreshAttempt
        ? {
            ...task,
            ...patch,
            id: task.id,
            ...(criteriaChanged && Array.isArray(patch.acceptanceCriteria)
              ? {
                  acceptanceCriteria: patch.acceptanceCriteria.map((criterion) => ({ ...criterion })),
                  acceptanceCriteriaVersion: (task.acceptanceCriteriaVersion ?? 0) + 1,
                }
              : {}),
            status: "planned",
            attemptLimit: Math.max(task.attemptLimit ?? 0, task.attempt + 1),
            assignedWorkerId: undefined,
            changeSetId: undefined,
            criterionEvidenceLinks: undefined,
            failureReason: undefined,
          }
        : {
            ...task,
            ...patch,
            id: task.id,
            ...(criteriaChanged && Array.isArray(patch.acceptanceCriteria)
              ? {
                  acceptanceCriteria: patch.acceptanceCriteria.map((criterion) => ({ ...criterion })),
                  acceptanceCriteriaVersion: (task.acceptanceCriteriaVersion ?? 0) + 1,
                }
              : {}),
            status: task.status,
          };
      const candidate = Object.values({ ...next.tasks, [taskId]: revised });
      const validation = validateTaskGraph(candidate);
      if (!validation.valid) {
        throw new Error(
          `Task revision has mechanical issues: ${validation.issues
            .map((issue) => issue.code)
            .join(", ")}.`
        );
      }
      next.tasks[taskId] = revised;
      if (grantsFreshAttempt) delete next.reviews[taskId];
      if (next.acceptanceContractStatus !== "legacy_completed") {
        next.acceptanceContractStatus = acceptanceContractStatusForTasks(
          Object.values(next.tasks)
        );
      }
      const revision = requiredNumber(event.payload, "revision");
      if (revision !== current.planRevision + 1) {
        throw new Error(
          `Task revision must advance plan revision ${current.planRevision} by one.`
        );
      }
      next.planRevision = revision;
      break;
    }
    case "task.transitioned": {
      const taskId = requiredString(event.payload, "taskId");
      const task = next.tasks[taskId];
      if (!task) throw new Error(`Unknown task ${taskId}.`);
      const status = requiredString(event.payload, "status") as BuildTask["status"];
      assertTransitionAuthority(status, event.actor.role);
      if (
        status === "cancelled" &&
        task.kind === "verification_repair" &&
        (
          Boolean(
            task.verificationRepair &&
            task.verificationRepair.sourceGenerationId ===
              next.finalVerification?.current?.generationId,
          ) ||
          Boolean(
            task.verifierRepair &&
            task.verifierRepair.sourceReviewId ===
              next.verifier?.current?.reviewId,
          )
        )
      ) {
        throw new Error(
          "A current-generation verification repair cannot be cancelled; integrate or durably replace it.",
        );
      }
      if (
        status === "submitted" &&
        current.acceptanceContractStatus === "acceptance_contract_upgrade_required"
      ) {
        throw new Error(
          "Task submission is blocked until the Architect upgrades the acceptance contract."
        );
      }
      const transitionPatch =
        (event.payload.patch as Partial<BuildTask> | undefined) ?? {};
      if (status === "assigned" && task.acceptanceCriteria) {
        requiredAssignedWorkerId(transitionPatch.assignedWorkerId, "Task assignment");
      }
      const startsRetry =
        status === "planned" && (task.status === "rejected" || task.status === "failed");
      const submittedEvidenceLinks =
        status === "submitted" && task.acceptanceCriteria
          ? boundCriterionEvidenceLinks(task, transitionPatch)
          : undefined;
      if (status === "submitted" && task.acceptanceCriteria) {
        requiredAssignedWorkerId(task.assignedWorkerId, "Task submission");
        const links = submittedEvidenceLinks;
        const validation = validateCriterionEvidenceLinks(
          task.acceptanceCriteria,
          links ?? [],
          { taskId: task.id, attempt: task.attempt }
        );
        if (!validation.valid) {
          throw new Error(
            `Task submission has invalid criterion evidence: ${validation.issues.join(" ")}`
          );
        }
      }
      const transitionedTask = applyTaskTransition(
        task,
        status,
        submittedEvidenceLinks
          ? { ...transitionPatch, criterionEvidenceLinks: submittedEvidenceLinks }
          : transitionPatch,
      );
      next.tasks[taskId] = transitionedTask;
      if (startsRetry) delete next.reviews[taskId];
      if (status === "submitted") {
        appendSubmissionHistory(next, {
          taskId,
          attempt: task.attempt,
          ...(task.acceptanceCriteriaVersion !== undefined
            ? { acceptanceCriteriaVersion: task.acceptanceCriteriaVersion }
            : {}),
          ...(transitionedTask.changeSetId !== undefined
            ? { changeSetId: transitionedTask.changeSetId }
            : {}),
          ...(transitionedTask.criterionEvidenceLinks
            ? {
                criterionEvidenceLinks: cloneCriterionEvidenceLinks(
                  transitionedTask.criterionEvidenceLinks
                ),
              }
            : {}),
        });
      }
      if (status === "integrated") {
        const integrationRevision = next.tasks[taskId].integrationRevision;
        if (integrationRevision) {
          advanceIntegrationRevision(next, integrationRevision);
        }
      }
      break;
    }
    case "user.guidance_submitted": {
      if (event.actor.role !== "user") {
        throw new Error("Only the user may submit user guidance.");
      }
      if (current.status === "completed") {
        throw new Error("A completed Build cannot receive in-flight user guidance.");
      }
      const submission = parseUserGuidanceSubmission(event.payload);
      if (submission.version !== next.userGuidanceVersion + 1) {
        throw new Error(
          `User guidance version must advance from ${next.userGuidanceVersion} to ${next.userGuidanceVersion + 1}.`,
        );
      }
      if (next.userGuidance[submission.guidanceId]) {
        throw new Error(`Duplicate user guidance ${submission.guidanceId}.`);
      }
      next.userGuidance[submission.guidanceId] = {
        ...submission,
        status: "submitted",
        interruptionStatus: "pending",
      };
      next.userGuidanceVersion = submission.version;
      invalidateFinalVerificationForGuidance(next, submission.guidanceId);
      if (next.projectHandoff?.status === "requested") {
        next.projectHandoffHistory = [
          ...(next.projectHandoffHistory ?? []).map((handoff) => ({
            ...handoff,
            options: [...handoff.options],
          })),
          {
            ...next.projectHandoff,
            status: "withdrawn",
            withdrawnByGuidanceId: submission.guidanceId,
            options: [...next.projectHandoff.options],
          },
        ];
        delete next.projectHandoff;
        if (next.status === "paused") next.status = "running";
      }
      break;
    }
    case "user.guidance_interruption_completed": {
      if (event.actor.role !== "runner" || event.actor.id !== "build-manager") {
        throw new Error("Only the native Build manager may complete a user-guidance interruption.");
      }
      const guidanceId = requiredString(event.payload, "guidanceId");
      const expectedVersion = requiredPositiveInteger(event.payload, "expectedVersion");
      const guidance = next.userGuidance[guidanceId];
      if (!guidance) throw new Error(`Unknown user guidance ${guidanceId}.`);
      if (guidance.version !== expectedVersion) {
        throw new Error(`User guidance ${guidanceId} version is ${guidance.version}, not ${expectedVersion}.`);
      }
      if (guidance.interruptionStatus === "completed") {
        throw new Error(`User guidance ${guidanceId} interruption is already completed.`);
      }
      guidance.interruptionStatus = "completed";
      break;
    }
    case "user.guidance_acknowledged": {
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may acknowledge user guidance.");
      }
      const acknowledgement = parseUserGuidanceAcknowledgement(event.payload);
      const guidance = next.userGuidance[acknowledgement.guidanceId];
      if (!guidance) throw new Error(`Unknown user guidance ${acknowledgement.guidanceId}.`);
      if (
        guidance.interruptionStatus !== "completed" &&
        guidance.interruptionProtocolVersion === 1
      ) {
        throw new Error(`User guidance ${acknowledgement.guidanceId} interruption must complete before acknowledgement.`);
      }
      if (guidance.status === "acknowledged") {
        throw new Error(`User guidance ${acknowledgement.guidanceId} is already acknowledged.`);
      }
      if (acknowledgement.expectedVersion !== guidance.version) {
        throw new Error(
          `User guidance ${acknowledgement.guidanceId} version is ${guidance.version}, not ${acknowledgement.expectedVersion}.`,
        );
      }
      const resolution: UserGuidanceAcknowledgementResolution =
        acknowledgement.resolution.type === "plan_reconciled"
          ? {
              ...acknowledgement.resolution,
              planReconciliation: parsePlanReconciliation(
                acknowledgement.resolution.planReconciliation,
              ),
            }
          : {
              ...acknowledgement.resolution,
              evidenceIds: [...acknowledgement.resolution.evidenceIds],
            };
      if (resolution.type === "plan_reconciled") {
        applyPlanReconciliation(next, resolution.planReconciliation, {
          allowSteeringCheckpoints: true,
          supersedingGuidanceId: guidance.guidanceId,
        });
        for (const [questionId, question] of Object.entries(next.architectQuestions)) {
          if (
            question.status !== "answered" ||
            !question.checkpoint ||
            (question.resumeStatus !== "pending" && question.resumeStatus !== "started")
          ) continue;
          const reason = question.checkpoint.reason;
          const isAcknowledgedAction =
            reason.type === "user_guidance_required" &&
            reason.guidanceId === guidance.guidanceId &&
            reason.version === guidance.version;
          if (isAcknowledgedAction || architectActionReasonIsApplicable(next, reason)) continue;
          next.architectQuestions[questionId] = {
            ...question,
            resumeStatus: "superseded",
            resumeSupersededSequence: event.sequence,
            supersededByGuidanceId: guidance.guidanceId,
            supersededRationale: resolution.rationale,
          };
        }
      }
      next.userGuidance[guidance.guidanceId] = {
        ...guidance,
        status: "acknowledged",
        resolution: cloneUserGuidanceResolution(resolution),
      };
      break;
    }
    case "architect.question_requested": {
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may request a user question.");
      }
      const request = parseArchitectQuestionRequest(event.payload);
      if (request.checkpoint && request.checkpoint.sequence > current.lastSequence) {
        throw new Error("Architect question checkpoint sequence is not durable in the current run.");
      }
      if (next.blockingArchitectQuestionId) {
        throw new Error(`Architect question ${next.blockingArchitectQuestionId} is already open.`);
      }
      if (request.version !== next.architectQuestionVersion + 1) {
        throw new Error(
          `Architect question version must advance from ${next.architectQuestionVersion} to ${next.architectQuestionVersion + 1}.`,
        );
      }
      if (next.architectQuestions[request.questionId]) {
        throw new Error(`Duplicate Architect question ${request.questionId}.`);
      }
      next.architectQuestions[request.questionId] = { ...request, status: "open" };
      next.architectQuestionVersion = request.version;
      next.blockingArchitectQuestionId = request.questionId;
      break;
    }
    case "architect.question_answered": {
      if (event.actor.role !== "user") {
        throw new Error("Only the user may answer an Architect question.");
      }
      const answer = parseArchitectQuestionAnswer(event.payload);
      const question = next.architectQuestions[answer.questionId];
      if (!question || question.status !== "open") {
        throw new Error(`Architect question ${answer.questionId} is not open.`);
      }
      if (next.blockingArchitectQuestionId !== answer.questionId) {
        throw new Error(`Architect question ${answer.questionId} is not the active blocking question.`);
      }
      if (answer.expectedVersion !== question.version) {
        throw new Error(
          `Architect question ${answer.questionId} version is ${question.version}, not ${answer.expectedVersion}.`,
        );
      }
      next.architectQuestions[question.questionId] = {
        ...question,
        status: "answered",
        answer: answer.answer,
        ...(question.checkpoint ? { resumeStatus: "pending" } : {}),
      };
      delete next.blockingArchitectQuestionId;
      break;
    }
    case "architect.question_resume_started": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may start an Architect question resume.");
      }
      const questionId = requiredString(event.payload, "questionId");
      const expectedVersion = requiredPositiveInteger(event.payload, "expectedVersion");
      const question = next.architectQuestions[questionId];
      if (
        !question ||
        question.status !== "answered" ||
        !question.checkpoint ||
        question.version !== expectedVersion ||
        (question.resumeStatus !== "pending" && question.resumeStatus !== "started")
      ) {
        throw new Error(`Architect question ${questionId} is not pending resume.`);
      }
      next.architectQuestions[questionId] = {
        ...question,
        resumeStatus: "started",
        resumeStartedSequence: event.sequence,
      };
      break;
    }
    case "architect.question_resume_consumed": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may consume an Architect question resume.");
      }
      const questionId = requiredString(event.payload, "questionId");
      const expectedVersion = requiredPositiveInteger(event.payload, "expectedVersion");
      const actionEventSequence = requiredPositiveInteger(event.payload, "actionEventSequence");
      const question = next.architectQuestions[questionId];
      const actionEvent = current.lastArchitectActionEvent;
      const checkpoint = question?.checkpoint;
      if (
        !question ||
        question.status !== "answered" ||
        !checkpoint ||
        question.version !== expectedVersion ||
        question.resumeStatus !== "started" ||
        question.resumeStartedSequence === undefined ||
        actionEventSequence <= question.resumeStartedSequence ||
        actionEventSequence >= event.sequence ||
        actionEvent?.sequence !== actionEventSequence ||
        !architectLifecycleEventMatchesReason(
          {
            type: actionEvent.type,
            actor: actionEvent.actor,
            payload: actionEvent.payload,
          },
          checkpoint.reason
        )
      ) {
        throw new Error(`Architect question ${questionId} has no completed resumed action.`);
      }
      next.architectQuestions[questionId] = {
        ...question,
        resumeStatus: "consumed",
        resumeConsumedSequence: event.sequence,
      };
      break;
    }
    case "guidance.requested": {
      const requestId = requiredString(event.payload, "requestId");
      const taskId = requiredString(event.payload, "taskId");
      if (event.actor.role !== "worker") {
        throw new Error("Only a worker may request Architect guidance.");
      }
      const task = next.tasks[taskId];
      if (!task || task.status !== "running") {
        throw new Error(`Task ${taskId} must be running to request guidance.`);
      }
      if (next.guidance[requestId]) throw new Error(`Duplicate guidance ${requestId}.`);
      const blocking = event.payload.blocking === true;
      const kind = event.payload.kind === undefined ? "question" : event.payload.kind;
      if (kind !== "question" && kind !== "replan") {
        throw new Error(`Guidance kind ${String(kind)} is invalid.`);
      }
      let replan: ReplanRequest | undefined;
      if (kind === "replan") {
        if (!blocking) throw new Error("A replan guidance must be blocking.");
        if (!isRecord(event.payload.replan)) throw new Error("A replan guidance requires a replan record.");
        const reason = requiredString(event.payload.replan, "reason");
        if (!REPLAN_REASONS.includes(reason as ReplanReason)) {
          throw new Error(`A replan reason ${reason} is invalid.`);
        }
        replan = {
          reason: reason as ReplanReason,
          summary: requiredString(event.payload.replan, "summary"),
          proposedChange: requiredString(event.payload.replan, "proposedChange"),
        };
      }
      next.guidance[requestId] = {
        requestId,
        taskId,
        blocking,
        question: requiredString(event.payload, "question"),
        evidenceSequence: requiredNumber(event.payload, "evidenceSequence"),
        version: 1,
        status: "open",
        kind,
        ...(replan ? { replan } : {}),
      };
      if (blocking) {
        next.tasks[taskId] = applyTaskTransition(task, "waiting_guidance", {
          guidanceRequestId: requestId,
        });
      }
      break;
    }
    case "guidance.answered": {
      const requestId = requiredString(event.payload, "requestId");
      const guidance = next.guidance[requestId];
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may answer guidance.");
      }
      if (!guidance || guidance.status !== "open") {
        throw new Error(`Guidance ${requestId} is not open.`);
      }
      const expectedVersion = requiredNumber(event.payload, "expectedVersion");
      if (expectedVersion !== guidance.version) {
        throw new Error(
          `Guidance ${requestId} version is ${guidance.version}, not ${expectedVersion}.`
        );
      }
      const answeredChallenge = guidance.challengedVersion === guidance.version;
      next.guidance[requestId] = {
        ...guidance,
        status: "answered",
        answer: requiredString(event.payload, "answer"),
        version: answeredChallenge ? guidance.version + 1 : guidance.version,
      };
      if (guidance.blocking) {
        const task = next.tasks[guidance.taskId];
        next.tasks[guidance.taskId] = applyTaskTransition(task, "running", {
          guidanceRequestId: undefined,
        });
      }
      break;
    }
    case "guidance.challenged": {
      const requestId = requiredString(event.payload, "requestId");
      const guidance = next.guidance[requestId];
      if (event.actor.role !== "worker") {
        throw new Error("Only a worker may challenge guidance.");
      }
      if (!guidance) throw new Error(`Unknown guidance ${requestId}.`);
      const expectedVersion = requiredNumber(event.payload, "expectedVersion");
      if (expectedVersion !== guidance.version) {
        throw new Error(
          `Guidance ${requestId} version is ${guidance.version}, not ${expectedVersion}.`
        );
      }
      if (guidance.challengedVersion === guidance.version) {
        throw new Error(`Guidance ${requestId} version ${guidance.version} was already challenged.`);
      }
      if (guidance.status !== "answered") {
        throw new Error(`Guidance ${requestId} must be answered before challenge.`);
      }
      const evidenceSequence = requiredNumber(event.payload, "evidenceSequence");
      if (evidenceSequence <= guidance.evidenceSequence) {
        throw new Error("A guidance challenge requires newer evidence.");
      }
      next.guidance[requestId] = {
        ...guidance,
        status: "open",
        challengedVersion: guidance.version,
        challengeEvidenceSequence: evidenceSequence,
        challengeReason: requiredString(event.payload, "reason"),
      };
      if (guidance.blocking) {
        const task = next.tasks[guidance.taskId];
        next.tasks[guidance.taskId] = applyTaskTransition(task, "waiting_guidance", {
          guidanceRequestId: requestId,
        });
      }
      break;
    }
    case "review.requested": {
      if (
        current.acceptanceContractStatus === "acceptance_contract_upgrade_required"
      ) {
        throw new Error(
          "Task review is blocked until the Architect upgrades the acceptance contract."
        );
      }
      const taskId = requiredString(event.payload, "taskId");
      const task = next.tasks[taskId];
      if (!task) throw new Error(`Unknown task ${taskId}.`);
      const requestedLinks = event.payload.criterionEvidenceLinks;
      const boundRequestedLinks = task.acceptanceCriteria
        ? boundCriterionEvidenceLinks(task, requestedLinks)
        : undefined;
      if (task.acceptanceCriteria) {
        requiredAssignedWorkerId(task.assignedWorkerId, "Review request");
        const validation = validateCriterionEvidenceLinks(
          task.acceptanceCriteria,
          boundRequestedLinks ?? [],
          { taskId: task.id, attempt: task.attempt }
        );
        if (!validation.valid) {
          throw new Error(
            `Review request has invalid criterion evidence: ${validation.issues.join(" ")}`
          );
        }
      }
      next.tasks[taskId] = applyTaskTransition(task, "architect_review");
      next.reviews[taskId] = {
        taskId,
        attempt: task.attempt,
        ...(task.acceptanceCriteriaVersion !== undefined
          ? { acceptanceCriteriaVersion: task.acceptanceCriteriaVersion }
          : {}),
        status: "requested",
        evidenceArtifactHashes: stringArray(event.payload, "evidenceArtifactHashes"),
        ...(boundRequestedLinks
          ? {
              criterionEvidenceLinks: boundRequestedLinks.map((link) => ({
                ...link,
                artifactHashes: [...link.artifactHashes],
              })),
            }
          : {}),
      };
      break;
    }
    case "review.decided": {
      if (
        current.acceptanceContractStatus === "acceptance_contract_upgrade_required"
      ) {
        throw new Error(
          "Task review is blocked until the Architect upgrades the acceptance contract."
        );
      }
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may decide a review.");
      }
      const taskId = requiredString(event.payload, "taskId");
      let task = next.tasks[taskId];
      if (!task) throw new Error(`Unknown task ${taskId}.`);
      if (task.status === "submitted") {
        task = applyTaskTransition(task, "architect_review");
      }
      const decision = requiredString(event.payload, "decision");
      if (decision !== "approved" && decision !== "rejected") {
        throw new Error(`Review decision ${decision} is invalid.`);
      }
      let criterionVerdicts: CriterionReviewVerdict[] | undefined;
      if (task.acceptanceCriteria) {
        requiredAssignedWorkerId(task.assignedWorkerId, "Review decision");
        const links = task.criterionEvidenceLinks;
        if (!links) {
          throw new Error(`Task ${taskId} has no submitted criterion evidence mappings.`);
        }
        if (!Array.isArray(event.payload.criterionVerdicts)) {
          throw new Error(`Task ${taskId} review requires criterion verdicts.`);
        }
        const submittedVerdicts = event.payload.criterionVerdicts as CriterionReviewVerdict[];
        const validation = validateCriterionReviewVerdicts(
          task.acceptanceCriteria,
          submittedVerdicts,
          links
        );
        if (!validation.valid) {
          throw new Error(
            `Task review has invalid criterion verdicts: ${validation.issues.join(" ")}`
          );
        }
        if (decision === "approved" && validation.unsatisfiedCriterionIds.length > 0) {
          throw new Error(
            `Task ${taskId} cannot be approved with unsatisfied criteria: ${validation.unsatisfiedCriterionIds.join(", ")}.`
          );
        }
        if (decision === "rejected" && validation.unsatisfiedCriterionIds.length === 0) {
          throw new Error(`Rejected task ${taskId} must identify an unsatisfied criterion.`);
        }
        criterionVerdicts = submittedVerdicts.map((verdict) => ({
          ...verdict,
          evidenceIds: [...verdict.evidenceIds],
          ...(verdict.artifactHashes
            ? { artifactHashes: [...verdict.artifactHashes] }
            : {}),
          ...(verdict.acceptedFailures
            ? {
                acceptedFailures: verdict.acceptedFailures.map((failure) => ({
                  ...failure,
                })),
              }
            : {}),
        }));
      }
      next.tasks[taskId] = applyTaskTransition(task, decision);
      const review: ReviewProjection = {
        taskId,
        attempt: task.attempt,
        ...(task.acceptanceCriteriaVersion !== undefined
          ? { acceptanceCriteriaVersion: task.acceptanceCriteriaVersion }
          : {}),
        status: decision,
        summary: requiredString(event.payload, "summary"),
        evidenceArtifactHashes: stringArray(event.payload, "evidenceArtifactHashes"),
        ...(task.criterionEvidenceLinks
          ? {
              criterionEvidenceLinks: task.criterionEvidenceLinks.map((link) => ({
                ...link,
                artifactHashes: [...link.artifactHashes],
              })),
            }
          : {}),
        ...(criterionVerdicts ? { criterionVerdicts } : {}),
      };
      next.reviews[taskId] = review;
      appendReviewHistory(next, review);
      if (event.payload.planReconciliation !== undefined) {
        applyPlanReconciliation(
          next,
          parsePlanReconciliation(event.payload.planReconciliation)
        );
      }
      break;
    }
    case "run.paused":
      next.status = "paused";
      if (typeof event.payload.reason === "string" && event.payload.reason) {
        next.pauseReason = {
          reason: event.payload.reason,
          ...(typeof event.payload.taskId === "string"
            ? { taskId: event.payload.taskId }
            : {}),
        };
      } else {
        delete next.pauseReason;
      }
      break;
    case "run.resumed":
      if (recoveryBlocksRun(current.processRecovery)) throw new Error("Unresolved exceptional recovery prevents resume.");
      next.status = "running";
      delete next.pauseReason;
      break;
    case "run.completed":
      if (recoveryBlocksRun(current.processRecovery)) throw new Error("Unresolved exceptional recovery prevents completion.");
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may complete a scheduler run.");
      }
      if (
        current.acceptanceContractStatus === "acceptance_contract_upgrade_required" &&
        current.acceptanceUpgradeRequiredEventRecorded
      ) {
        throw new Error(
          "Run completion is blocked until the Architect upgrades acceptance criteria for every non-cancelled task."
        );
      }
      assertBuildCompletionReady(current);
      next.status = "completed";
      if (current.acceptanceContractStatus === "acceptance_contract_upgrade_required") {
        next.acceptanceContractStatus = "legacy_completed";
      }
      delete next.pauseReason;
      break;
    case "project.handoff_requested": {
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may request final project handoff.");
      }
      if (current.projectHandoff) {
        throw new Error("Final project handoff was already requested.");
      }
      if (current.runPolicy === "plan_only") {
        if (current.planRevision <= 0) {
          throw new Error("Plan-only final project handoff requires a valid plan.");
        }
      } else {
        assertBuildCompletionReady(current);
      }
      next.projectHandoff = {
        status: "requested",
        summary: requiredString(event.payload, "summary"),
        options: ["keep_integration_branch", "apply_to_project"],
      };
      next.status = "paused";
      delete next.pauseReason;
      break;
    }
    case "project.handoff_selected": {
      if (event.actor.role !== "user" && event.actor.role !== "runner") {
        throw new Error("Final project handoff selection requires the user or runner.");
      }
      if (
        current.acceptanceContractStatus === "acceptance_contract_upgrade_required" &&
        current.acceptanceUpgradeRequiredEventRecorded
      ) {
        throw new Error(
          "Final project handoff is blocked until the Architect upgrades acceptance criteria for every non-cancelled task."
        );
      }
      if (current.projectHandoff?.status !== "requested") {
        throw new Error("Final project handoff is not awaiting user selection.");
      }
      assertBuildCompletionReady(current);
      const choice = requiredString(event.payload, "choice");
      if (choice !== "keep_integration_branch" && choice !== "apply_to_project") {
        throw new Error(`Final project handoff choice ${choice} is invalid.`);
      }
      if (event.actor.role === "runner" && choice !== "apply_to_project") {
        throw new Error("Automatic project handoff must apply to the project.");
      }
      const projectRevision = event.payload.projectRevision;
      const selectedIntegrationRevision = requiredString(
        event.payload,
        "integrationRevision",
      );
      if (
        current.runPolicy !== "plan_only" &&
        selectedIntegrationRevision !== current.integrationRevision
      ) {
        throw new Error(
          "Final project handoff selection does not match the verified integration revision.",
        );
      }
      if (
        projectRevision !== undefined &&
        (typeof projectRevision !== "string" || !projectRevision.trim())
      ) {
        throw new Error("Final project handoff projectRevision is invalid.");
      }
      next.projectHandoff = {
        ...current.projectHandoff,
        status: "selected",
        choice,
        integrationRevision: selectedIntegrationRevision,
        integrationBranch: requiredString(event.payload, "integrationBranch"),
        appliedToProject: event.payload.appliedToProject === true,
        ...(typeof projectRevision === "string" ? { projectRevision } : {}),
      };
      next.status = "completed";
      if (current.acceptanceContractStatus === "acceptance_contract_upgrade_required") {
        next.acceptanceContractStatus = "legacy_completed";
      }
      delete next.pauseReason;
      break;
    }
    case "provider.retry_scheduled": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may schedule provider retries.");
      }
      requiredString(event.payload, "runtimeId");
      requiredString(event.payload, "providerId");
      requiredString(event.payload, "modelId");
      const retry = requiredNumber(event.payload, "retry");
      const maxRetries = requiredNumber(event.payload, "maxRetries");
      const delayMs = requiredNumber(event.payload, "delayMs");
      requiredString(event.payload, "reason");
      if (retry < 1 || retry > 5 || maxRetries !== 5 || delayMs < 0) {
        throw new Error("Provider retry schedule is invalid.");
      }
      break;
    }
    case "provider.health_changed": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may record provider health.");
      }
      const state = event.payload.state;
      if (typeof state !== "object" || state === null || Array.isArray(state)) {
        throw new Error("Provider health state is required.");
      }
      const value = state as Record<string, unknown>;
      const providerId = requiredString(value, "providerId");
      const status = requiredString(value, "status");
      if (status !== "healthy" && status !== "cooldown") {
        throw new Error(`Provider health status ${status} is invalid.`);
      }
      next.runtime.providerHealth[providerId] = {
        providerId,
        status,
        consecutiveFailures: requiredNumber(value, "consecutiveFailures"),
        updatedAt: requiredNumber(value, "updatedAt"),
        ...(typeof value.failureKind === "string"
          ? { failureKind: value.failureKind }
          : {}),
        ...(typeof value.failureMessage === "string"
          ? { failureMessage: value.failureMessage }
          : {}),
        ...(typeof value.cooldownUntil === "number"
          ? { cooldownUntil: value.cooldownUntil }
          : {}),
      };
      break;
    }
    case "worker.runtime_assigned": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may assign worker runtimes.");
      }
      const taskId = requiredString(event.payload, "taskId");
      const attempt = requiredNumber(event.payload, "attempt");
      const task = next.tasks[taskId];
      if (!task || task.attempt !== attempt) {
        throw new Error(`Worker runtime assignment does not match task ${taskId} attempt.`);
      }
      const sessionId = requiredString(event.payload, "sessionId");
      if (
        task.assignedWorkerId !== undefined &&
        isSteeringReassignedWorkerId(
          taskId,
          attempt,
          task.assignedWorkerId
        ) &&
        sessionId !== workerSessionId(
          current.runId,
          taskId,
          attempt,
          task.assignedWorkerId
        )
      ) {
        throw new Error("A reassigned worker session must match its durable worker identity.");
      }
      next.runtime.workerAssignments[`${taskId}:${attempt}`] = {
        taskId,
        attempt,
        runtimeId: requiredString(event.payload, "runtimeId"),
        sessionId,
      };
      break;
    }
    case "architect.runtime_assigned": {
      if (event.actor.role !== "user") {
        throw new Error("Architect runtime selection requires the user.");
      }
      next.runtime.architect = {
        runtimeId: requiredString(event.payload, "runtimeId"),
      };
      break;
    }
    case "architect.handoff_required": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may request Architect handoff.");
      }
      const offeredRuntimeIds = stringArray(event.payload, "candidateRuntimeIds");
      const candidateRuntimeIds = Array.from(new Set([
        ...(next.runtime.architect.runtimeId
          ? [next.runtime.architect.runtimeId]
          : []),
        ...offeredRuntimeIds,
      ]));
      next.runtime.architect = {
        ...next.runtime.architect,
        handoff: {
          reason: requiredString(event.payload, "reason"),
          requiredCapabilities: stringArray(event.payload, "requiredCapabilities"),
          candidateRuntimeIds,
        },
      };
      next.status = "paused";
      delete next.pauseReason;
      break;
    }
    case "architect.handoff_selected": {
      if (event.actor.role !== "user") {
        throw new Error("Architect handoff selection requires the user.");
      }
      const runtimeId = requiredString(event.payload, "runtimeId");
      const handoff = next.runtime.architect.handoff;
      if (!handoff || !handoff.candidateRuntimeIds.includes(runtimeId)) {
        throw new Error(`Runtime ${runtimeId} is not an offered Architect handoff.`);
      }
      next.runtime.architect = { runtimeId };
      next.status = "running";
      delete next.pauseReason;
      break;
    }
    case "plan_critique.policy_configured": {
      applyPlanCritiquePolicyConfigured(next, event);
      break;
    }
    case "plan_critique.risk_assessed": {
      applyPlanCritiqueRiskAssessed(next, event);
      break;
    }
    case "plan_critique.skipped": {
      applyPlanCritiqueSkipped(next, event);
      break;
    }
    case "plan_critique.requested": {
      applyPlanCritiqueRequested(next, event);
      break;
    }
    case "plan_critique.submitted": {
      applyPlanCritiqueSubmitted(next, event);
      break;
    }
    case "plan_critique.resolved": {
      applyPlanCritiqueResolved(next, event);
      break;
    }
  }
  if (isArchitectLifecycleEvent(event)) {
    next.lastArchitectActionEvent = {
      sequence: event.sequence,
      type: event.type,
      actor: { ...event.actor },
      payload: structuredClone(event.payload),
    };
  }
  return next;
}

function advanceIntegrationRevision(
  projection: SchedulerProjection,
  integrationRevision: string,
  previousIntegrationRevision?: unknown,
): void {
  if (!integrationRevision.trim()) {
    throw new Error("Integration revision must be non-empty.");
  }
  if (
    previousIntegrationRevision !== undefined &&
    (typeof previousIntegrationRevision !== "string" ||
      !previousIntegrationRevision.trim())
  ) {
    throw new Error("Previous integration revision is invalid.");
  }
  if (
    typeof previousIntegrationRevision === "string" &&
    projection.integrationRevision !== previousIntegrationRevision
  ) {
    throw new Error(
      `Integration revision advanced from ${projection.integrationRevision ?? "none"}, not ${previousIntegrationRevision}.`,
    );
  }
  if (projection.integrationRevision === integrationRevision) return;

  const current = projection.finalVerification?.current;
  if (current) {
    projection.finalVerification = {
      history: [
        ...(projection.finalVerification?.history ?? []),
        {
          ...cloneFinalVerificationGeneration(current),
          state: "invalidated",
          invalidatedByRevision: integrationRevision,
        },
      ],
    };
  }
  const currentRisk = projection.buildRisk?.current;
  if (currentRisk) {
    projection.buildRisk = {
      history: [
        ...(projection.buildRisk?.history ?? []).map(cloneBuildRiskAssessment),
        {
          ...cloneBuildRiskAssessment(currentRisk),
          state: "invalidated",
          invalidatedByRevision: integrationRevision,
        },
      ],
    };
  }
  const currentVerifier = projection.verifier?.current;
  if (currentVerifier) {
    projection.verifier = {
      history: [
        ...(projection.verifier?.history ?? []).map(cloneVerifierReview),
        {
          ...cloneVerifierReview(currentVerifier),
          state: "invalidated",
          invalidatedByRevision: integrationRevision,
        },
      ],
    };
  }
  projection.integrationRevision = integrationRevision;
}

function parseVerifierPolicy(
  payload: Record<string, unknown>,
): VerifierPolicyProjection {
  if (payload.mode !== "risk_based") {
    throw new Error("Independent verifier policy mode must be risk_based.");
  }
  const candidateRuntimeIds = stringArray(payload, "candidateRuntimeIds")
    .map((runtimeId) => runtimeId.trim());
  if (
    candidateRuntimeIds.length === 0 ||
    candidateRuntimeIds.some((runtimeId) => !runtimeId) ||
    new Set(candidateRuntimeIds).size !== candidateRuntimeIds.length
  ) {
    throw new Error(
      "Independent verifier policy requires unique non-empty candidate runtime IDs.",
    );
  }
  const strict = payload.alwaysRequireIndependentVerifier;
  if (strict !== undefined && typeof strict !== "boolean") {
    throw new Error(
      "Independent verifier qualification policy must be a boolean.",
    );
  }
  return {
    mode: "risk_based",
    candidateRuntimeIds,
    // Events written before P4.6 had only risk-based candidate selection.
    alwaysRequireIndependentVerifier: strict === true,
  };
}

function recordBuildRiskAssessment(
  projection: SchedulerProjection,
  payload: Record<string, unknown>,
  assessedAt: string,
): void {
  if (projection.verifierPolicy?.mode !== "risk_based") {
    throw new Error("Build risk cannot be assessed before verifier policy is configured.");
  }
  const targetRevision = requiredString(payload, "targetRevision");
  if (targetRevision !== projection.integrationRevision) {
    throw new Error("Build risk assessment targets a stale integration revision.");
  }
  const finalVerification = projection.finalVerification?.current;
  if (
    !finalVerification || finalVerification.state !== "current" ||
    finalVerification.targetRevision !== targetRevision ||
    finalVerification.submissionResult?.green !== true ||
    finalVerification.cleanup?.status !== "succeeded" ||
    finalVerification.review?.status !== "approved" ||
    finalVerification.review.decision?.decision !== "approved" ||
    finalVerification.review.decision.failedCategories.length > 0
  ) {
    throw new Error(
      "Build risk assessment requires current green final verification and structured Architect approval.",
    );
  }
  const input = parseBuildRiskAssessmentInput(payload.input);
  if (
    input.stricterQualification !==
      projection.verifierPolicy.alwaysRequireIndependentVerifier
  ) {
    throw new Error(
      "Build-risk qualification conflicts with the durable verifier policy.",
    );
  }
  const assessment = assessBuildRisk(input);
  if (!sameValue(payload.assessment, assessment)) {
    throw new Error(
      "Persisted build-risk assessment conflicts with the kernel recomputation.",
    );
  }
  const priorForRevision = [
    ...(projection.buildRisk?.current ? [projection.buildRisk.current] : []),
    ...(projection.buildRisk?.history ?? []),
  ].filter((candidate) => candidate.targetRevision === targetRevision);
  if (
    assessment.risk === "low" &&
    priorForRevision.some((candidate) => candidate.assessment.risk === "high")
  ) {
    throw new Error("A high-risk assessment cannot be lowered for the same revision.");
  }
  const next: BuildRiskAssessmentProjection = {
    targetRevision,
    input,
    assessment,
    state: "current",
    assessedAt,
  };
  const current = projection.buildRisk?.current;
  if (current && sameValue(current, next)) return;
  if (current && current.targetRevision !== targetRevision) {
    throw new Error("A current build-risk assessment exists for another revision.");
  }
  projection.buildRisk = {
    current: cloneBuildRiskAssessment(next),
    history: [
      ...(projection.buildRisk?.history ?? []).map(cloneBuildRiskAssessment),
      ...(current
        ? [{ ...cloneBuildRiskAssessment(current), state: "superseded" as const }]
        : []),
    ],
  };
}

function parseBuildRiskAssessmentInput(value: unknown): BuildRiskAssessmentInput {
  if (!isRecord(value)) throw new Error("Build-risk assessment input is invalid.");
  const architectDeclaration = value.architectDeclaration;
  if (architectDeclaration !== "low" && architectDeclaration !== "high") {
    throw new Error("Build-risk Architect declaration is invalid.");
  }
  if (typeof value.stricterQualification !== "boolean") {
    throw new Error("Build-risk stricter qualification flag is invalid.");
  }
  if (!isRecord(value.kernelFacts)) {
    throw new Error("Build-risk kernel facts are invalid.");
  }
  const kernelFacts = value.kernelFacts;
  const booleanKeys = [
    "destructiveEffects",
    "credentialEffects",
    "externalWriteEffects",
    "integrationConflict",
  ] as const;
  for (const key of booleanKeys) {
    if (typeof kernelFacts[key] !== "boolean") {
      throw new Error(`Build-risk kernel fact ${key} is invalid.`);
    }
  }
  const changedPaths = stringArray(kernelFacts, "changedPaths");
  if (changedPaths.some((path) => !path.trim())) {
    throw new Error("Build-risk changed paths must be non-empty strings.");
  }
  return {
    architectDeclaration,
    stricterQualification: value.stricterQualification,
    kernelFacts: {
      destructiveEffects: kernelFacts.destructiveEffects as boolean,
      credentialEffects: kernelFacts.credentialEffects as boolean,
      externalWriteEffects: kernelFacts.externalWriteEffects as boolean,
      integrationConflict: kernelFacts.integrationConflict as boolean,
      changedPaths: [...changedPaths],
    },
  };
}

function cloneBuildRiskProjection(
  projection: BuildRiskProjection,
): BuildRiskProjection {
  return {
    ...(projection.current
      ? { current: cloneBuildRiskAssessment(projection.current) }
      : {}),
    history: projection.history.map(cloneBuildRiskAssessment),
  };
}

function cloneBuildRiskAssessment(
  assessment: BuildRiskAssessmentProjection,
): BuildRiskAssessmentProjection {
  return {
    ...assessment,
    input: {
      ...assessment.input,
      kernelFacts: {
        ...assessment.input.kernelFacts,
        changedPaths: [...assessment.input.kernelFacts.changedPaths],
      },
    },
    assessment: {
      ...assessment.assessment,
      reasons: assessment.assessment.reasons.map((reason) => ({
        ...reason,
        evidence: [...reason.evidence],
      })),
      normalizedChangedPaths: [...assessment.assessment.normalizedChangedPaths],
    },
  };
}

function createFinalVerificationGeneration(
  projection: SchedulerProjection,
  payload: Record<string, unknown>,
): void {
  const generation = parseFinalVerificationGeneration(payload);
  if (!projection.integrationRevision) {
    throw new Error("Final verification requires a canonical integration revision.");
  }
  if (generation.targetRevision !== projection.integrationRevision) {
    throw new Error(
      `Final verification generation targets stale integration revision ${generation.targetRevision}.`,
    );
  }
  const authoritativePlan = validateFinalVerificationPlan(generation.plan, {
    detectedSignals: generation.executionProfile.detectedSignals,
  });
  if (!authoritativePlan.valid) {
    throw new Error(
      `Final verification plan conflicts with runner-detected signals: ${authoritativePlan.issues.join(" ")}`,
    );
  }
  const existing = projection.finalVerification?.current;
  if (existing) {
    if (sameFinalVerificationGeneration(existing, generation)) return;
    throw new Error("A conflicting current final verification generation already exists.");
  }
  if (
    projection.finalVerification?.history.some(
      (entry) => entry.generationId === generation.generationId,
    )
  ) {
    throw new Error("An invalidated final verification generation cannot be reactivated.");
  }
  if (projection.tasks[generation.taskId]) {
    throw new Error(`Final verification task ${generation.taskId} already exists.`);
  }

  const task: BuildTask = {
    id: generation.taskId,
    kind: "final_verification",
    objective: "Verify the canonical integrated revision.",
    dependencies: [],
    status: "planned",
    requiredCapabilities: ["verification"],
    attempt: 0,
    generationId: generation.generationId,
    targetRevision: generation.targetRevision,
    planVersion: generation.planVersion,
    verificationPlan: planFinalVerification(generation.plan),
  };
  const validation = validateTaskGraph([...Object.values(projection.tasks), task]);
  if (!validation.valid) {
    throw new Error(
      `Final verification task has mechanical issues: ${validation.issues
        .map((issue) => issue.code)
        .join(", ")}.`,
    );
  }
  projection.tasks[task.id] = cloneBuildTask(task);
  projection.finalVerification = {
    current: {
      taskId: generation.taskId,
      generationId: generation.generationId,
      targetRevision: generation.targetRevision,
      planVersion: generation.planVersion,
      plan: planFinalVerification(generation.plan),
      executionProfile: cloneFinalVerificationExecutionProfile(generation.executionProfile),
      state: "current",
    },
    history: [...(projection.finalVerification?.history ?? [])].map(
      cloneFinalVerificationGeneration,
    ),
  };
}

function recordFinalVerificationSubmission(
  projection: SchedulerProjection,
  payload: Record<string, unknown>,
): void {
  const current = requireCurrentFinalVerification(projection, payload);
  const submission = parseFinalVerificationSubmission(payload);
  assertFinalVerificationBinding(current, submission);
  if (current.submission) {
    if (sameValue(current.submission, submission)) return;
    throw new Error("Final verification submission conflicts with the current generation.");
  }
  current.submission = { ...submission };
  if (payload.submissionResult !== undefined) {
    const submissionResult = parseFinalVerificationSubmissionResult(payload);
    assertFinalVerificationSubmissionResult(current, submission, submissionResult);
    current.submissionResult = submissionResult;
  }
  projection.tasks[current.taskId] = {
    ...projection.tasks[current.taskId],
    verificationSubmissionId: submission.submissionId,
  };
}

function recordFinalVerificationCheck(
  projection: SchedulerProjection,
  payload: Record<string, unknown>,
): void {
  const current = requireCurrentFinalVerification(projection, payload);
  const completed = parseFinalVerificationCompletedCheck(payload);
  assertFinalVerificationBinding(current, completed);
  const planned = current.plan.checks.find(
    (check) => check.category === completed.category,
  );
  if (!planned) {
    throw new Error(`Final verification category ${completed.category} is not planned.`);
  }
  if (!sameValue(projectFinalVerificationCheck(completed), planned)) {
    throw new Error(
      `Final verification category ${completed.category} does not match the current plan.`,
    );
  }
  assertFinalVerificationCheckSemantics({
    check: completed,
    profile: current.executionProfile,
    targetRevision: current.targetRevision,
    workspacePath: completed.workspacePath,
  });
  const existing = current.completedChecks?.find(
    (check) => check.category === completed.category,
  );
  if (existing) {
    if (sameValue(existing, completed)) return;
    throw new Error(
      `Final verification category ${completed.category} already has a conflicting result.`,
    );
  }
  current.completedChecks = [
    ...(current.completedChecks ?? []).map(cloneFinalVerificationCompletedCheck),
    cloneFinalVerificationCompletedCheck(completed),
  ];
}

function recordFinalVerificationReviewRequest(
  projection: SchedulerProjection,
  payload: Record<string, unknown>,
): void {
  const current = requireCurrentFinalVerification(projection, payload);
  const review = parseFinalVerificationReview(payload, "requested");
  assertFinalVerificationBinding(current, review);
  if (current.cleanup?.status !== "succeeded") {
    throw new Error("Final verification review requires durable owned cleanup success.");
  }
  if (!current.submission || current.submission.submissionId !== review.submissionId) {
    throw new Error("Final verification review must reference the current submission.");
  }
  if (current.review) {
    if (sameFinalVerificationReviewIdentity(current.review, review)) return;
    throw new Error("Final verification review conflicts with the current generation.");
  }
  current.review = { ...review };
  projection.tasks[current.taskId] = {
    ...projection.tasks[current.taskId],
    verificationReviewId: review.reviewId,
  };
}

function recordFinalVerificationCleanup(
  projection: SchedulerProjection,
  payload: Record<string, unknown>,
  status: FinalVerificationCleanupProjection["status"],
  occurredAt: string,
): void {
  const current = requireCurrentFinalVerification(projection, payload);
  if ((!current.submission || !current.submissionResult) && !current.failure) {
    throw new Error("Final verification cleanup requires a validated submission or durable mechanical failure.");
  }
  const attempt = requiredNumber(payload, "attempt");
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Final verification cleanup attempt is invalid.");
  const identity = {
    generationId: requiredString(payload, "generationId"),
    taskId: requiredString(payload, "taskId"),
    targetRevision: requiredString(payload, "targetRevision"),
    attempt,
  };
  assertFinalVerificationBinding(current, identity);
  const existing = current.cleanup;
  if (status === "started") {
    if (existing?.status === "succeeded") throw new Error("Final verification cleanup already succeeded.");
    if (existing?.status === "started") {
      if (existing.attempt === attempt) return;
      throw new Error("Final verification cleanup already has an active attempt.");
    }
    if (existing && attempt !== existing.attempt + 1) {
      throw new Error("Final verification cleanup retry attempt is not sequential.");
    }
    if (!existing && attempt !== 1) throw new Error("Initial final verification cleanup attempt must be one.");
    current.cleanup = { ...identity, attempt, status, startedAt: occurredAt };
    return;
  }
  if (!existing || existing.status !== "started" || existing.attempt !== attempt) {
    if (existing?.status === status && existing.attempt === attempt) {
      const incomingDetail = status === "succeeded"
        ? (typeof payload.diagnosticsPath === "string" && payload.diagnosticsPath.trim()
            ? payload.diagnosticsPath.slice(0, 4_096) : undefined)
        : requiredString(payload, "error").slice(0, 4_096);
      const existingDetail = status === "succeeded" ? existing.diagnosticsPath : existing.error;
      if (incomingDetail === existingDetail) return;
      throw new Error(`Final verification cleanup ${status} conflicts with its durable result.`);
    }
    throw new Error(`Final verification cleanup ${status} requires its exact started attempt.`);
  }
  if (status === "succeeded") {
    if (
      current.failure &&
      (typeof payload.diagnosticsPath !== "string" || !payload.diagnosticsPath.trim())
    ) {
      throw new Error("Mechanically failed final verification cleanup requires durable diagnostics.");
    }
    current.cleanup = {
      ...existing,
      status,
      finishedAt: occurredAt,
      ...(typeof payload.diagnosticsPath === "string" && payload.diagnosticsPath.trim()
        ? { diagnosticsPath: payload.diagnosticsPath.slice(0, 4_096) }
        : {}),
    };
  } else {
    const error = requiredString(payload, "error").slice(0, 4_096);
    current.cleanup = { ...existing, status, finishedAt: occurredAt, error };
  }
}

function recordFinalVerificationFailure(
  projection: SchedulerProjection,
  payload: Record<string, unknown>,
  occurredAt: string,
): void {
  const current = requireCurrentFinalVerification(projection, payload);
  if (current.submission || current.review) {
    throw new Error("A mechanically failed final verification cannot have a submission or review.");
  }
  const attempt = requiredNumber(payload, "attempt");
  const expected = deriveFinalVerificationFailure(current, attempt);
  if (expected.failedCategories.length === 0) {
    throw new Error("Final verification failure requires a persisted non-green check.");
  }
  const incoming = {
    failureId: requiredString(payload, "failureId"),
    generationId: requiredString(payload, "generationId"),
    taskId: requiredString(payload, "taskId"),
    targetRevision: requiredString(payload, "targetRevision"),
    attempt,
    failedCategories: stringArray(payload, "failedCategories"),
    issueIds: stringArray(payload, "issueIds"),
    factIds: stringArray(payload, "factIds"),
    evidenceIds: stringArray(payload, "evidenceIds"),
  };
  if (!sameValue(incoming, expected)) {
    throw new Error("Final verification failure report conflicts with persisted mechanical facts.");
  }
  if (current.failure) {
    if (sameValue({ ...current.failure, reportedAt: undefined }, { ...expected, reportedAt: undefined })) return;
    throw new Error("Final verification generation already has a conflicting failure report.");
  }
  current.failure = { ...expected, reportedAt: occurredAt };
}

function recordFinalVerificationReviewDecision(
  projection: SchedulerProjection,
  payload: Record<string, unknown>,
): void {
  const current = requireCurrentFinalVerification(projection, payload);
  const decision = requiredString(payload, "decision");
  if (decision === "rejected") {
    throw new Error(
      "Unstructured rejected final-verification reviews are invalid; use a structured repair_required decision.",
    );
  }
  if (decision !== "approved" && decision !== "repair_required") {
    throw new Error(`Final verification review decision ${decision} is invalid.`);
  }
  const review = parseFinalVerificationReview(payload, decision);
  assertFinalVerificationBinding(current, review);
  if (!current.submission || current.submission.submissionId !== review.submissionId) {
    throw new Error("Final verification review must reference the current submission.");
  }
  if (!current.review || !sameFinalVerificationReviewIdentity(current.review, review)) {
    throw new Error("Final verification review decision is stale or foreign.");
  }
  const decisionProjection = payload.categoryReviews === undefined
    ? undefined
    : parseFinalVerificationReviewDecision(payload, current);
  if (current.review.status !== "requested" && current.review.status !== review.status) {
    throw new Error("Final verification review was already decided differently.");
  }
  if (
    current.review.status === review.status &&
    !sameValue(current.review.decision, decisionProjection)
  ) {
    throw new Error("Final verification review was already decided with different semantics.");
  }
  current.review.status = review.status;
  if (decisionProjection) current.review.decision = decisionProjection;
}

function recordVerifierReviewRequest(
  projection: SchedulerProjection,
  payload: Record<string, unknown>,
  occurredAt: string,
): void {
  if (projection.acceptanceContractStatus !== "current") {
    throw new Error(
      "Independent verifier review requires the current acceptance contract.",
    );
  }
  const ordinaryTasks = Object.values(projection.tasks).filter(
    (task) => task.status !== "cancelled" && !isFinalVerificationTask(task),
  );
  const missingCriteria = ordinaryTasks.find(
    (task) => !task.acceptanceCriteria || task.acceptanceCriteria.length === 0,
  );
  if (missingCriteria) {
    throw new Error(
      `Independent verifier review requires criteria for task ${missingCriteria.id}.`,
    );
  }
  const nonterminal = ordinaryTasks.find((task) => task.status !== "integrated");
  if (nonterminal) {
    throw new Error(
      `Independent verifier review requires integrated task ${nonterminal.id}.`,
    );
  }
  const finalVerification = projection.finalVerification?.current;
  if (
    !finalVerification ||
    finalVerification.state !== "current" ||
    finalVerification.targetRevision !== projection.integrationRevision ||
    finalVerification.submissionResult?.green !== true ||
    finalVerification.cleanup?.status !== "succeeded" ||
    finalVerification.review?.status !== "approved" ||
    finalVerification.review.decision?.decision !== "approved" ||
    finalVerification.review.decision.failedCategories.length > 0
  ) {
    throw new Error(
      "Independent verifier review requires current green final verification and structured Architect approval.",
    );
  }
  const expectedCriteria = expectedVerifierCriteria(projection.tasks);
  const review = parseVerifierReviewRequest(
    payload,
    expectedCriteria,
    occurredAt,
  );
  if (
    review.targetRevision !== projection.integrationRevision ||
    review.targetRevision !== finalVerification.targetRevision ||
    review.finalVerificationGenerationId !== finalVerification.generationId
  ) {
    throw new Error(
      "Independent verifier review targets a stale final-verification revision or generation.",
    );
  }
  const assignedArchitectRuntimeId = projection.runtime.architect.runtimeId;
  const excludedArchitect = review.excludedModels.find(
    (candidate) => candidate.source === "architect",
  );
  if (
    assignedArchitectRuntimeId &&
    excludedArchitect?.runtimeId !== assignedArchitectRuntimeId
  ) {
    throw new Error(
      "Independent verifier review excludes the wrong Architect runtime identity.",
    );
  }
  const current = projection.verifier?.current;
  if (current) {
    if (sameVerifierReview(current, review)) return;
    if (current.status !== "requested") {
      throw new Error("A submitted independent verifier review cannot be superseded.");
    }
    if (payload.supersedesReviewId !== current.reviewId) {
      throw new Error(
        "A replacement verifier review must explicitly supersede the pending review.",
      );
    }
    projection.verifier = {
      current: cloneVerifierReview(review),
      history: [
        ...(projection.verifier?.history ?? []).map(cloneVerifierReview),
        {
          ...cloneVerifierReview(current),
          state: "superseded",
          supersededByReviewId: review.reviewId,
        },
      ],
    };
    return;
  }
  projection.verifier = {
    current: cloneVerifierReview(review),
    history: (projection.verifier?.history ?? []).map(cloneVerifierReview),
  };
}

function recordVerifierVerdict(
  projection: SchedulerProjection,
  event: SchedulerEvent,
  occurredAt: string,
): void {
  const current = projection.verifier?.current;
  if (!current) {
    throw new Error("Verifier verdict requires a current requested review.");
  }
  if (current.state !== "current") {
    throw new Error("Verifier verdict requires a current revision-bound review.");
  }
  if (
    projection.integrationRevision !== current.targetRevision ||
    projection.finalVerification?.current?.generationId !==
      current.finalVerificationGenerationId ||
    projection.finalVerification.current.targetRevision !== current.targetRevision
  ) {
    throw new Error("Verifier verdict is stale for the current integration revision.");
  }
  const ordinaryTasks = Object.values(projection.tasks).filter(
    (task) => task.status !== "cancelled" && !isFinalVerificationTask(task),
  );
  const nonterminal = ordinaryTasks.find((task) => task.status !== "integrated");
  if (nonterminal) {
    throw new Error(
      `Verifier verdict is stale because task ${nonterminal.id} is not integrated.`,
    );
  }
  assertExactVerifierCriteria(
    current.criteria,
    expectedVerifierCriteria(projection.tasks),
    "Current verifier review",
  );
  if (event.actor.id !== current.runtime.runtimeId) {
    throw new Error("Verifier verdict actor does not match the selected runtime identity.");
  }
  const verdict = parseVerifierVerdict(event.payload, current, occurredAt);
  const submitted: typeof current = {
    ...cloneVerifierReview(current),
    status: "submitted",
    verdict,
  };
  if (current.status === "submitted") {
    if (sameVerifierReview(current, submitted)) return;
    throw new Error("Verifier review already has a conflicting verdict.");
  }
  projection.verifier!.current = submitted;
}

function createVerifierRepairTasks(
  projection: SchedulerProjection,
  payload: Record<string, unknown>,
): void {
  consumeRepairCycle(projection);
  const current = projection.verifier?.current;
  if (
    !current || current.state !== "current" ||
    current.status !== "submitted" || current.verdict?.satisfied !== false ||
    current.reviewId !== requiredString(payload, "reviewId") ||
    current.targetRevision !== requiredString(payload, "targetRevision") ||
    current.targetRevision !== projection.integrationRevision
  ) {
    throw new Error(
      "Verifier repairs require the current unsatisfied revision-bound verdict.",
    );
  }
  const revision = requiredNumber(payload, "revision");
  if (revision !== projection.planRevision + 1) {
    throw new Error("Verifier repair plan revision is stale.");
  }
  if (!Array.isArray(payload.tasks) || payload.tasks.length === 0) {
    throw new Error("Verifier repairs require at least one task.");
  }
  const unsatisfied = current.verdict.criterionVerdicts.filter(
    (criterion) => criterion.verdict === "unsatisfied",
  );
  const byCriterion = new Map(
    unsatisfied.map((criterion) => [verifierCriterionKey(criterion), criterion]),
  );
  const assigned = new Set<string>();
  const tasks = payload.tasks.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Verifier repair task is invalid.");
    if (!Array.isArray(candidate.criteria) || candidate.criteria.length === 0) {
      throw new Error("Verifier repair task requires rejected criteria.");
    }
    const criteria: VerifierCriterionReference[] = candidate.criteria.map(
      (value) => {
        if (!isRecord(value)) throw new Error("Verifier repair criterion is invalid.");
        return {
          taskId: requiredString(value, "taskId"),
          criterionId: requiredString(value, "criterionId"),
        };
      },
    );
    for (const criterion of criteria) {
      const key = verifierCriterionKey(criterion);
      if (!byCriterion.has(key) || assigned.has(key)) {
        throw new Error(
          `Verifier repair criterion ${criterion.taskId}:${criterion.criterionId} is satisfied, unknown, or duplicated.`,
        );
      }
      assigned.add(key);
    }
    if (!Array.isArray(candidate.acceptanceCriteria)) {
      throw new Error("Verifier repair task requires acceptance criteria.");
    }
    const acceptanceCriteria = candidate.acceptanceCriteria as AcceptanceCriterion[];
    const criteriaValidation = validateAcceptanceCriteria(acceptanceCriteria);
    if (!criteriaValidation.valid) {
      throw new Error(
        `Verifier repair acceptance criteria are invalid: ${criteriaValidation.issues.join(" ")}`,
      );
    }
    const evidenceIds = stringArray(candidate, "evidenceIds");
    const expectedEvidence = [...new Set(criteria.flatMap((criterion) =>
      byCriterion.get(verifierCriterionKey(criterion))?.evidenceIds ?? []
    ))].sort();
    if (!sameValue([...evidenceIds].sort(), expectedEvidence)) {
      throw new Error(
        "Verifier repair task must cite exactly the rejected criteria evidence.",
      );
    }
    const requiredCapabilities = stringArray(candidate, "requiredCapabilities");
    if (
      requiredCapabilities.length === 0 ||
      requiredCapabilities.some((capability) => !capability.trim())
    ) {
      throw new Error("Verifier repair task requires non-empty capabilities.");
    }
    return {
      id: requiredString(candidate, "id"),
      kind: "verification_repair" as const,
      objective: requiredString(candidate, "objective"),
      dependencies: stringArray(candidate, "dependencies"),
      status: "planned" as const,
      requiredCapabilities,
      acceptanceCriteria: acceptanceCriteria.map((criterion) => ({ ...criterion })),
      acceptanceCriteriaVersion: 1,
      attempt: 0,
      verifierRepair: {
        sourceReviewId: current.reviewId,
        targetRevision: current.targetRevision,
        criteria: criteria.map((criterion) => ({ ...criterion })),
        evidenceIds: [...expectedEvidence],
      },
    } satisfies BuildTask;
  });
  if (assigned.size !== byCriterion.size) {
    throw new Error(
      "Verifier repair tasks must cover every unsatisfied criterion exactly once.",
    );
  }
  if (current.repairTaskIds) {
    const existing = current.repairTaskIds.map((id) => projection.tasks[id]);
    if (sameValue(existing, tasks)) return;
    throw new Error("Verifier repairs already have a conflicting durable plan.");
  }
  for (const task of tasks) {
    if (projection.tasks[task.id]) throw new Error(`Duplicate task ${task.id}.`);
    if (task.dependencies.includes(projection.finalVerification?.current?.taskId ?? "")) {
      throw new Error("Verifier repairs cannot depend on the kernel verification task.");
    }
  }
  const validation = validateTaskGraph(
    [...Object.values(projection.tasks), ...tasks],
    { requireAcceptanceCriteria: true },
  );
  if (!validation.valid) {
    throw new Error(
      `Verifier repair plan is invalid: ${validation.issues.map((issue) => issue.message).join(" ")}`,
    );
  }
  for (const task of tasks) projection.tasks[task.id] = task;
  current.repairTaskIds = tasks.map((task) => task.id);
  projection.planRevision = revision;
}

function verifierCriterionKey(criterion: VerifierCriterionReference): string {
  return `${criterion.taskId}\u0000${criterion.criterionId}`;
}

function parseVerificationRepairSource(
  payload: Record<string, unknown>,
  current: FinalVerificationGenerationProjection,
): import("./task-contracts.js").VerificationRepairProvenance["source"] {
  const type = requiredString(payload, "type");
  if (type === "semantic_review") {
    const source = {
      type,
      submissionId: requiredString(payload, "submissionId"),
      reviewId: requiredString(payload, "reviewId"),
    } as const;
    if (
      current.review?.status !== "repair_required" ||
      !current.review.decision ||
      current.submission?.submissionId !== source.submissionId ||
      current.review.reviewId !== source.reviewId
    ) throw new Error("Semantic repairs require the current repair-required review.");
    return source;
  }
  if (type === "mechanical_failure") {
    const source = {
      type,
      failureId: requiredString(payload, "failureId"),
      issueIds: stringArray(payload, "issueIds"),
      factIds: stringArray(payload, "factIds"),
    } as const;
    if (
      !current.failure || current.cleanup?.status !== "succeeded" ||
      source.failureId !== current.failure.failureId ||
      !sameValue(source.issueIds, current.failure.issueIds) ||
      !sameValue(source.factIds, current.failure.factIds)
    ) throw new Error("Mechanical repairs require the current cleaned durable failure.");
    return source;
  }
  throw new Error("Final verification repair source is invalid.");
}

function createFinalVerificationRepairTasks(
  projection: SchedulerProjection,
  payload: Record<string, unknown>,
): void {
  consumeRepairCycle(projection);
  const current = requireCurrentFinalVerification(projection, {
    ...payload,
    taskId: payload.finalVerificationTaskId,
  });
  const sourcePayload = isRecord(payload.source)
    ? payload.source
    : {
        type: "semantic_review",
        submissionId: payload.submissionId,
        reviewId: payload.reviewId,
      };
  const source = parseVerificationRepairSource(sourcePayload, current);
  const revision = requiredNumber(payload, "revision");
  if (revision !== projection.planRevision + 1) {
    throw new Error("Final verification repair plan revision is stale.");
  }
  if (!Array.isArray(payload.tasks) || payload.tasks.length === 0) {
    throw new Error("Final verification repairs require at least one task.");
  }
  const failedCategories = source.type === "semantic_review"
    ? current.review!.decision!.failedCategories
    : current.failure!.failedCategories;
  const failed = new Set(failedCategories);
  const assigned = new Set<FinalVerificationCategory>();
  const tasks = payload.tasks.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Final verification repair task is invalid.");
    const categories = stringArray(candidate, "categories") as FinalVerificationCategory[];
    if (categories.length === 0) throw new Error("Repair task requires failed categories.");
    for (const category of categories) {
      if (!failed.has(category) || assigned.has(category)) {
        throw new Error(`Repair category ${category} is unrelated or duplicated.`);
      }
      assigned.add(category);
    }
    if (!Array.isArray(candidate.acceptanceCriteria)) {
      throw new Error("Repair task requires acceptance criteria.");
    }
    const acceptanceCriteria = candidate.acceptanceCriteria as AcceptanceCriterion[];
    const criteriaValidation = validateAcceptanceCriteria(acceptanceCriteria);
    if (!criteriaValidation.valid) {
      throw new Error(`Repair task acceptance criteria are invalid: ${criteriaValidation.issues.join(" ")}`);
    }
    const evidenceIds = stringArray(candidate, "evidenceIds");
    const expectedEvidence = source.type === "semantic_review"
      ? [...new Set(categories.flatMap((category) =>
          current.review!.decision!.categoryReviews.find(
            (review) => review.category === category,
          )?.evidenceIds ?? []
        ))].sort()
      : [...new Set(categories.flatMap((category) =>
          current.completedChecks?.find((check) => check.category === category)?.evidenceIds ?? []
        ))].sort();
    if (!sameValue([...evidenceIds].sort(), expectedEvidence)) {
      throw new Error("Repair task cites missing or unknown final-verification evidence.");
    }
    return {
      id: requiredString(candidate, "id"),
      kind: "verification_repair" as const,
      objective: requiredString(candidate, "objective"),
      dependencies: stringArray(candidate, "dependencies"),
      status: "planned" as const,
      requiredCapabilities: stringArray(candidate, "requiredCapabilities"),
      acceptanceCriteria: acceptanceCriteria.map((criterion) => ({ ...criterion })),
      acceptanceCriteriaVersion: 1,
      attempt: 0,
      verificationRepair: {
        sourceGenerationId: current.generationId,
        finalVerificationTaskId: current.taskId,
        targetRevision: current.targetRevision,
        categories: [...categories],
        evidenceIds: [...evidenceIds],
        source,
      },
    } satisfies BuildTask;
  });
  if (assigned.size !== failed.size) {
    throw new Error("Repair tasks must cover every failed category exactly once.");
  }
  if (current.repairTaskIds) {
    const existing = current.repairTaskIds.map((id) => projection.tasks[id]);
    if (sameValue(existing, tasks)) return;
    throw new Error("Final verification repairs already have a conflicting plan.");
  }
  for (const task of tasks) {
    if (projection.tasks[task.id]) throw new Error(`Duplicate task ${task.id}.`);
    if (task.dependencies.includes(current.taskId)) {
      throw new Error("Repair tasks cannot depend on the kernel verification task.");
    }
  }
  const validation = validateTaskGraph(
    [...Object.values(projection.tasks), ...tasks],
    { requireAcceptanceCriteria: true },
  );
  if (!validation.valid) {
    throw new Error(`Final verification repair plan is invalid: ${validation.issues.map((issue) => issue.message).join(" ")}`);
  }
  for (const task of tasks) projection.tasks[task.id] = task;
  current.repairTaskIds = tasks.map((task) => task.id);
  projection.planRevision = revision;
}

function parseFinalVerificationReviewDecision(
  payload: Record<string, unknown>,
  current: FinalVerificationGenerationProjection,
): FinalVerificationReviewDecisionProjection {
  if (!current.submissionResult || current.submissionResult.green !== true) {
    throw new Error("Structured final verification review requires a green submission result.");
  }
  const decision = requiredString(payload, "decision");
  if (decision !== "approved" && decision !== "repair_required") {
    throw new Error("Structured final verification review decision is invalid.");
  }
  const summary = requiredString(payload, "summary");
  const rawArchitectRisk = payload.architectRisk;
  const rawArchitectRiskRationale = payload.architectRiskRationale;
  const architectRisk: FinalVerificationReviewDecisionProjection["architectRisk"] =
    rawArchitectRisk === undefined && rawArchitectRiskRationale === undefined
      ? {
          risk: "low" as const,
          source: "legacy_default" as const,
        }
      : rawArchitectRisk === "low" || rawArchitectRisk === "high"
        ? {
            risk: rawArchitectRisk,
            rationale: requiredString(payload, "architectRiskRationale"),
            source: "architect" as const,
          }
        : (() => {
            throw new Error(
              "Final verification review Architect risk declaration is invalid.",
            );
          })();
  if (!Array.isArray(payload.categoryReviews)) {
    throw new Error("Final verification review requires category reviews.");
  }
  const categoryReviews = payload.categoryReviews.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new Error("Final verification category review is invalid.");
    }
    const category = requiredString(candidate, "category") as FinalVerificationCategory;
    const verdict = requiredString(candidate, "verdict");
    if (
      !current.plan.checks.some((check) => check.category === category) ||
      (verdict !== "approved" && verdict !== "repair_required")
    ) {
      throw new Error(`Final verification category review ${category} is invalid.`);
    }
    return {
      category,
      verdict,
      rationale: requiredString(candidate, "rationale"),
      evidenceIds: stringArray(candidate, "evidenceIds"),
    } as FinalVerificationCategoryReviewProjection;
  });
  if (
    categoryReviews.length !== current.plan.checks.length ||
    new Set(categoryReviews.map((review) => review.category)).size !== current.plan.checks.length
  ) {
    throw new Error("Final verification review must represent every category exactly once.");
  }
  const failedCategories = categoryReviews
    .filter((review) => review.verdict === "repair_required")
    .map((review) => review.category);
  if (
    (decision === "approved" && failedCategories.length > 0) ||
    (decision === "repair_required" && failedCategories.length === 0)
  ) {
    throw new Error("Final verification review decision conflicts with category verdicts.");
  }
  for (const review of categoryReviews) {
    const submitted = current.submissionResult.checks.find(
      (check) => check.category === review.category,
    );
    if (
      !submitted ||
      !submitted.green ||
      (submitted.status === "required" && submitted.evidenceIds.length === 0) ||
      !sameValue([...submitted.evidenceIds].sort(), [...new Set(review.evidenceIds)].sort())
    ) {
      throw new Error(
        `Final verification category ${review.category} review conflicts with submitted evidence.`,
      );
    }
  }
  return {
    decision,
    summary,
    targetRevision: current.targetRevision,
    architectRisk,
    categoryReviews: categoryReviews.map((review) => ({
      ...review,
      evidenceIds: [...review.evidenceIds],
    })),
    failedCategories,
  };
}

function requireCurrentFinalVerification(
  projection: SchedulerProjection,
  payload: Record<string, unknown>,
): FinalVerificationGenerationProjection {
  const current = projection.finalVerification?.current;
  if (!current) {
    throw new Error("Final verification event does not reference a current generation.");
  }
  if (current.targetRevision !== projection.integrationRevision) {
    throw new Error("Final verification generation is stale for the integration revision.");
  }
  const taskId = requiredString(payload, "taskId");
  const generationId = requiredString(payload, "generationId");
  const targetRevision = requiredString(payload, "targetRevision");
  if (
    current.taskId !== taskId ||
    current.generationId !== generationId ||
    current.targetRevision !== targetRevision
  ) {
    throw new Error("Final verification event is stale or foreign to the current generation.");
  }
  const task = projection.tasks[current.taskId];
  if (
    !task ||
    task.kind !== "final_verification" ||
    task.generationId !== current.generationId ||
    task.targetRevision !== current.targetRevision
  ) {
    throw new Error("Final verification task binding is invalid.");
  }
  return current;
}

function assertFinalVerificationBinding(
  current: FinalVerificationGenerationProjection,
  value: {
    generationId: string;
    targetRevision: string;
    attempt: number;
  },
): void {
  if (
    current.generationId !== value.generationId ||
    current.targetRevision !== value.targetRevision
  ) {
    throw new Error("Final verification evidence is stale or foreign to the current generation.");
  }
  if (value.attempt < 1) {
    throw new Error("Final verification evidence attempt must be positive.");
  }
}

function parseFinalVerificationGeneration(payload: Record<string, unknown>): {
  taskId: string;
  generationId: string;
  targetRevision: string;
  planVersion: number;
  plan: FinalVerificationPlan;
  executionProfile: FinalVerificationExecutionProfile;
} {
  const planVersion = requiredNumber(payload, "planVersion");
  if (planVersion < 1) throw new Error("Final verification planVersion must be positive.");
  const targetRevision = requiredString(payload, "targetRevision");
  assertFinalVerificationExecutionProfile(payload.executionProfile, targetRevision);
  return {
    taskId: requiredString(payload, "taskId"),
    generationId: requiredString(payload, "generationId"),
    targetRevision,
    planVersion,
    plan: planFinalVerification(payload.plan),
    executionProfile: cloneFinalVerificationExecutionProfile(payload.executionProfile),
  };
}

function parseFinalVerificationSubmission(
  payload: Record<string, unknown>,
): FinalVerificationSubmissionReference {
  return {
    submissionId: requiredString(payload, "submissionId"),
    generationId: requiredString(payload, "generationId"),
    targetRevision: requiredString(payload, "targetRevision"),
    attempt: requiredPositiveNumber(payload, "attempt"),
  };
}

function parseFinalVerificationCompletedCheck(
  payload: Record<string, unknown>,
): FinalVerificationCompletedCheckProjection & {
  generationId: string;
  targetRevision: string;
} {
  const result = payload.result;
  if (!isRecord(result)) {
    throw new Error("Final verification check requires a result object.");
  }
  const category = requiredString(result, "category");
  if (
    category !== "build" &&
    category !== "tests" &&
    category !== "runtime_smoke" &&
    category !== "browser"
  ) {
    throw new Error(`Final verification check category ${category} is invalid.`);
  }
  const status = requiredString(result, "status");
  if (status !== "required" && status !== "not_applicable") {
    throw new Error(`Final verification check status ${status} is invalid.`);
  }
  if (typeof result.green !== "boolean") {
    throw new Error(`Final verification check ${category} requires a green fact.`);
  }
  const evidenceIds = stringArray(result, "evidenceIds");
  const issues = stringArray(result, "issues");
  if (!Array.isArray(result.facts)) {
    throw new Error(`Final verification check ${category} requires fact records.`);
  }
  const rationale = result.rationale;
  if (rationale !== undefined && (typeof rationale !== "string" || !rationale.trim())) {
    throw new Error(`Final verification check ${category} has invalid rationale.`);
  }
  return {
    generationId: requiredString(payload, "generationId"),
    targetRevision: requiredString(payload, "targetRevision"),
    attempt: requiredPositiveNumber(payload, "attempt"),
    workspacePath: requiredString(payload, "workspacePath"),
    startedAt: requiredString(payload, "startedAt"),
    finishedAt: requiredString(payload, "finishedAt"),
    category,
    status,
    green: result.green,
    ...(typeof rationale === "string" ? { rationale } : {}),
    ...(isRecord(result.repositoryInspection)
      ? {
          repositoryInspection: result.repositoryInspection as unknown as
            FinalVerificationCompletedCheckProjection["repositoryInspection"],
        }
      : {}),
    evidenceIds,
    facts: result.facts as FinalVerificationFact[],
    issues,
  };
}

function parseFinalVerificationSubmissionResult(
  payload: Record<string, unknown>,
): FinalVerificationSubmission {
  if (!isRecord(payload.submissionResult)) {
    throw new Error("Final verification submission requires its validated result.");
  }
  return cloneJson(payload.submissionResult) as unknown as FinalVerificationSubmission;
}

function assertFinalVerificationSubmissionResult(
  current: FinalVerificationGenerationProjection,
  reference: FinalVerificationSubmissionReference,
  result: FinalVerificationSubmission,
): void {
  if (
    result.kind !== "final_verification_submission" ||
    result.green !== true ||
    result.generationId !== current.generationId ||
    result.taskId !== current.taskId ||
    result.targetRevision !== current.targetRevision ||
    result.attempt !== reference.attempt ||
    result.runId === undefined ||
    !sameValue(result.executionProfile, current.executionProfile) ||
    !Array.isArray(result.checks) ||
    result.checks.length !== current.plan.checks.length
  ) {
    throw new Error("Final verification submission result is stale or malformed.");
  }
  const completed = current.completedChecks ?? [];
  if (completed.length !== current.plan.checks.length) {
    throw new Error("Final verification submission requires every completed check.");
  }
  for (const check of result.checks) {
    const durable = completed.find((entry) => entry.category === check.category);
    if (!durable || !durable.green || durable.issues.length > 0) {
      throw new Error(`Final verification submission check ${check.category} is not durably green.`);
    }
    assertFinalVerificationCheckSemantics({
      check,
      profile: current.executionProfile,
      targetRevision: current.targetRevision,
      workspacePath: durable.workspacePath,
    });
    if (!sameValue(projectFinalVerificationSubmissionCheck(durable), check)) {
      throw new Error(`Final verification submission check ${check.category} conflicts with durable execution.`);
    }
  }
}

function parseFinalVerificationReview(
  payload: Record<string, unknown>,
  status: FinalVerificationReviewReference["status"],
): FinalVerificationReviewReference {
  return {
    reviewId: requiredString(payload, "reviewId"),
    submissionId: requiredString(payload, "submissionId"),
    generationId: requiredString(payload, "generationId"),
    targetRevision: requiredString(payload, "targetRevision"),
    attempt: requiredPositiveNumber(payload, "attempt"),
    status,
  };
}

function sameFinalVerificationGeneration(
  left: FinalVerificationGenerationProjection,
  right: {
    taskId: string;
    generationId: string;
    targetRevision: string;
    planVersion: number;
    plan: FinalVerificationPlan;
    executionProfile: FinalVerificationExecutionProfile;
  },
): boolean {
  return left.taskId === right.taskId &&
    left.generationId === right.generationId &&
    left.targetRevision === right.targetRevision &&
    left.planVersion === right.planVersion &&
    sameValue(left.plan, right.plan) &&
    sameValue(left.executionProfile, right.executionProfile);
}

function sameFinalVerificationReviewIdentity(
  left: FinalVerificationReviewReference,
  right: FinalVerificationReviewReference,
): boolean {
  return left.reviewId === right.reviewId &&
    left.submissionId === right.submissionId &&
    left.generationId === right.generationId &&
    left.targetRevision === right.targetRevision &&
    left.attempt === right.attempt;
}

function cloneFinalVerificationProjection(
  projection: FinalVerificationProjection,
): FinalVerificationProjection {
  return {
    ...(projection.current
      ? { current: cloneFinalVerificationGeneration(projection.current) }
      : {}),
    history: projection.history.map(cloneFinalVerificationGeneration),
  };
}

function cloneFinalVerificationGeneration(
  generation: FinalVerificationGenerationProjection,
): FinalVerificationGenerationProjection {
  return {
    ...generation,
    plan: planFinalVerification(generation.plan),
    executionProfile: cloneFinalVerificationExecutionProfile(generation.executionProfile),
    ...(generation.completedChecks
      ? { completedChecks: generation.completedChecks.map(cloneFinalVerificationCompletedCheck) }
      : {}),
    ...(generation.failure ? { failure: cloneJson(generation.failure) } : {}),
    ...(generation.submission
      ? { submission: { ...generation.submission } }
      : {}),
    ...(generation.submissionResult
      ? { submissionResult: cloneJson(generation.submissionResult) }
      : {}),
    ...(generation.cleanup ? { cleanup: { ...generation.cleanup } } : {}),
    ...(generation.review
      ? {
          review: {
            ...generation.review,
            ...(generation.review.decision
              ? { decision: cloneJson(generation.review.decision) }
              : {}),
          },
        }
      : {}),
    ...(generation.repairTaskIds
      ? { repairTaskIds: [...generation.repairTaskIds] }
      : {}),
  };
}

function cloneFinalVerificationCompletedCheck(
  check: FinalVerificationCompletedCheckProjection,
): FinalVerificationCompletedCheckProjection {
  return cloneJson(check) as unknown as FinalVerificationCompletedCheckProjection;
}

function projectFinalVerificationCheck(
  check: FinalVerificationCompletedCheckProjection,
): FinalVerificationPlan["checks"][number] {
  return {
    category: check.category,
    status: check.status,
    ...(check.rationale !== undefined ? { rationale: check.rationale } : {}),
    ...(check.repositoryInspection
      ? { repositoryInspection: cloneJson(check.repositoryInspection) }
      : {}),
  };
}

function projectFinalVerificationSubmissionCheck(
  check: FinalVerificationCompletedCheckProjection,
): FinalVerificationSubmission["checks"][number] {
  return {
    category: check.category,
    status: check.status,
    green: true,
    ...(check.rationale !== undefined ? { rationale: check.rationale } : {}),
    ...(check.repositoryInspection
      ? { repositoryInspection: cloneJson(check.repositoryInspection) }
      : {}),
    evidenceIds: [...check.evidenceIds],
    facts: cloneJson(check.facts),
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requiredPositiveNumber(
  payload: Record<string, unknown>,
  key: string,
): number {
  const value = requiredNumber(payload, key);
  if (value < 1) throw new Error(`${key} must be positive.`);
  return value;
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function failureReference(
  kind: "issue" | "fact",
  category: FinalVerificationCategory,
  index: number,
  value: string,
): string {
  return `${kind}:${createHash("sha256")
    .update(`${category}\0${index}\0${value}`)
    .digest("hex")}`;
}

function parsePlanRiskDeclaration(
  payload: Record<string, unknown>,
): NonNullable<SchedulerProjection["planRiskDeclaration"]> {
  if (payload.riskDeclaration === undefined) {
    return { risk: "low", source: "legacy_default" };
  }
  if (!isRecord(payload.riskDeclaration)) {
    throw new Error("Plan risk declaration is invalid.");
  }
  const risk = payload.riskDeclaration.risk;
  if (risk !== "low" && risk !== "high") {
    throw new Error("Plan risk declaration risk must be low or high.");
  }
  const rationale = payload.riskDeclaration.rationale;
  if (rationale !== undefined && (typeof rationale !== "string" || !rationale.trim())) {
    throw new Error("Plan risk declaration rationale must be a non-empty string when present.");
  }
  return {
    risk,
    ...(typeof rationale === "string" ? { rationale: rationale.trim() } : {}),
    source: "architect",
  };
}

function applyPlanCritiquePolicyConfigured(
  projection: SchedulerProjection,
  event: SchedulerEvent,
): void {
  if (event.actor.role !== "runner") {
    throw new Error("Only the runner may configure plan critique policy.");
  }
  const mode = event.payload.mode;
  if (!(PLAN_CRITIQUE_MODES as readonly string[]).includes(mode as string)) {
    throw new Error(`Plan critique mode ${String(mode)} is invalid.`);
  }
  const typedMode = mode as PlanCritiqueMode;
  if (projection.planCritique?.policy) {
    if (projection.planCritique.policy.mode !== typedMode) {
      throw new Error("Plan critique policy is already configured differently.");
    }
    return;
  }
  projection.planCritique = { policy: { mode: typedMode }, history: [] };
}

function applyPlanCritiqueRiskAssessed(
  projection: SchedulerProjection,
  event: SchedulerEvent,
): void {
  if (event.actor.role !== "runner") {
    throw new Error("Only the runner may assess plan risk.");
  }
  if (!projection.planCritique?.policy) {
    throw new Error("Plan risk cannot be assessed before plan critique policy is configured.");
  }
  const planRevision = requiredNumber(event.payload, "planRevision");
  if (planRevision !== projection.planRevision) {
    throw new Error("Plan risk assessment plan revision does not match the current plan revision.");
  }
  const architectDeclaration = event.payload.architectDeclaration;
  if (architectDeclaration !== "low" && architectDeclaration !== "high") {
    throw new Error("Plan risk architectDeclaration must be low or high.");
  }
  const expectedDeclaration = projection.planRiskDeclaration?.risk ?? "low";
  if (architectDeclaration !== expectedDeclaration) {
    throw new Error("Plan risk architectDeclaration does not match the recorded plan risk declaration.");
  }
  const stricterQualification = event.payload.stricterQualification;
  if (typeof stricterQualification !== "boolean") {
    throw new Error("Plan risk stricterQualification must be a boolean.");
  }
  const expectedStrict = projection.verifierPolicy?.alwaysRequireIndependentVerifier ?? false;
  if (stricterQualification !== expectedStrict) {
    throw new Error("Plan risk stricterQualification does not match the configured verifier qualification.");
  }
  const expected = assessPlanRisk({
    architectDeclaration,
    stricterQualification,
    tasks: Object.values(projection.tasks),
  });
  const assessment = event.payload.assessment;
  if (!sameValue(assessment, expected)) {
    throw new Error("Plan risk assessment conflicts with the kernel recomputation.");
  }
  const existing = projection.planCritique.risk;
  if (existing && existing.planRevision !== planRevision) {
    throw new Error("Plan risk has already been assessed for this run.");
  }
  if (existing && sameValue(existing.assessment, expected)
    && existing.architectDeclaration === architectDeclaration
    && existing.stricterQualification === stricterQualification) {
    return;
  }
  if (existing) {
    throw new Error("Plan risk has already been assessed for this run.");
  }
  projection.planCritique = {
    ...projection.planCritique,
    risk: {
      planRevision,
      architectDeclaration,
      stricterQualification,
      assessment: expected,
      assessedAt: event.occurredAt,
    },
  };
}

function applyPlanCritiqueSkipped(
  projection: SchedulerProjection,
  event: SchedulerEvent,
): void {
  if (event.actor.role !== "runner") {
    throw new Error("Only the runner may skip a plan critique.");
  }
  if (!projection.planCritique?.policy) {
    throw new Error("Plan critique skip requires a configured policy.");
  }
  const reason = event.payload.reason;
  if (!isPlanCritiqueSkipReason(reason)) {
    throw new Error(`Plan critique skip reason ${String(reason)} is invalid.`);
  }
  const currentStatus = projection.planCritique.current?.status;
  if (currentStatus === "submitted" || currentStatus === "resolved") {
    throw new Error("Plan critique skip is forbidden after a critique is submitted or resolved.");
  }
  const planRevision = requiredNumber(event.payload, "planRevision");
  projection.planCritique = {
    ...projection.planCritique,
    skipped: { planRevision, reason, skippedAt: event.occurredAt },
  };
}

function isPlanCritiqueSkipReason(value: unknown): value is PlanCritiqueSkipReason {
  return value === "policy_off" || value === "low_plan_risk"
    || value === "critic_failed" || value === "plan_only";
}

function applyPlanCritiqueRequested(
  projection: SchedulerProjection,
  event: SchedulerEvent,
): void {
  if (event.actor.role !== "runner") {
    throw new Error("Only the runner may request a plan critique.");
  }
  if (!projection.planCritique?.policy) {
    throw new Error("Plan critique request requires a configured policy.");
  }
  if (!projection.planCritique.risk) {
    throw new Error("Plan critique request requires a recorded plan risk.");
  }
  const planRevision = requiredNumber(event.payload, "planRevision");
  if (planRevision !== projection.planRevision) {
    throw new Error("Plan critique request plan revision does not match the current plan revision.");
  }
  const dispatched = Object.values(projection.tasks).some((task) =>
    task.status !== "cancelled"
    && !isFinalVerificationTask(task)
    && (task.status !== "planned" || task.attempt !== 0)
  );
  if (dispatched) {
    throw new Error("Plan critique cannot start after a worker was dispatched.");
  }
  const runtime = parseRuntimeBinding(event.payload.runtime);
  const excludedModels = parseExcludedModels(event.payload.excludedModels);
  if (excludedModels.some((excluded) => excluded.modelIdentity === runtime.modelIdentity)) {
    throw new Error("Plan critic model is not independent from the Architect.");
  }
  const critiqueId = requiredString(event.payload, "critiqueId");
  const state = projection.planCritique;
  if (state.current?.status === "resolved" || state.history.some((entry) => entry.status === "resolved")) {
    throw new Error("Plan critique is already resolved for this run.");
  }
  let history = [...state.history];
  if (state.current?.status === "requested") {
    const supersedes = event.payload.supersedesCritiqueId;
    if (supersedes !== state.current.critiqueId) {
      throw new Error("A pending requested plan critique must be superseded by name.");
    }
    history = [...history, { ...state.current, supersededByCritiqueId: critiqueId }];
  } else if (state.current?.status === "submitted") {
    throw new Error("A submitted plan critique cannot be replaced.");
  }
  const nextCritique: PlanCritiqueProjection = {
    critiqueId,
    planRevision,
    runtime,
    excludedModels,
    status: "requested",
    requestedAt: event.occurredAt,
  };
  projection.planCritique = {
    ...state,
    history,
    current: nextCritique,
  };
}

function applyPlanCritiqueSubmitted(
  projection: SchedulerProjection,
  event: SchedulerEvent,
): void {
  const current = projection.planCritique?.current;
  if (!current || current.status === "resolved") {
    throw new Error("Plan critique submission does not match the selected critic runtime.");
  }
  if (event.actor.role !== "verifier" || event.actor.id !== current.runtime.runtimeId) {
    throw new Error("Plan critique submission does not match the selected critic runtime.");
  }
  const critiqueId = requiredString(event.payload, "critiqueId");
  if (critiqueId !== current.critiqueId) {
    throw new Error("Plan critique submission critiqueId does not match the current critique.");
  }
  const planRevision = requiredNumber(event.payload, "planRevision");
  if (planRevision !== current.planRevision || planRevision !== projection.planRevision) {
    throw new Error("Plan critique submission plan revision is stale.");
  }
  const sessionId = requiredString(event.payload, "sessionId");
  if (sessionId !== current.runtime.sessionId) {
    throw new Error("Plan critique submission sessionId does not match the current critique session.");
  }
  const findings = parsePlanCritiqueFindings(event.payload.findings, projection.tasks);
  if (current.status === "submitted") {
    if (sameValue(current.findings, findings)) return;
    throw new Error("Plan critique submission conflicts with the already submitted findings.");
  }
  const blockingFindingIds = findings
    .filter((finding) => finding.severity === "blocking")
    .map((finding) => finding.findingId);
  projection.planCritique = {
    ...projection.planCritique!,
    current: {
      ...current,
      status: "submitted",
      findings,
      blockingFindingIds,
      submittedAt: event.occurredAt,
    },
  };
}

function applyPlanCritiqueResolved(
  projection: SchedulerProjection,
  event: SchedulerEvent,
): void {
  const current = projection.planCritique?.current;
  if (!current || current.status !== "submitted") {
    throw new Error("Plan critique resolution requires a submitted critique.");
  }
  const blockingFindingIds = current.blockingFindingIds ?? [];
  const resolvedBy = event.actor.role === "architect"
    ? "architect" as const
    : event.actor.role === "runner" && blockingFindingIds.length === 0
      ? "runner" as const
      : undefined;
  if (!resolvedBy) {
    if (event.actor.role === "runner") {
      throw new Error("Plan critique blocking findings require an Architect resolution.");
    }
    throw new Error("Plan critique blocking findings require an Architect resolution.");
  }
  const critiqueId = requiredString(event.payload, "critiqueId");
  if (critiqueId !== current.critiqueId) {
    throw new Error("Plan critique resolution critiqueId does not match the current critique.");
  }
  const planRevision = requiredNumber(event.payload, "planRevision");
  if (planRevision !== current.planRevision || planRevision !== projection.planRevision) {
    throw new Error("Plan critique resolution plan revision is stale.");
  }
  const resolutions = parsePlanCritiqueResolutions(event.payload.resolutions, blockingFindingIds);
  const reconciled = resolutions.filter((item) => item.resolution === "plan_reconciled");
  if (reconciled.length > 0) {
    if (event.payload.planReconciliation === undefined) {
      throw new Error("Plan critique plan_reconciled resolutions require a planReconciliation.");
    }
    const reconciliation = parsePlanReconciliation(event.payload.planReconciliation);
    const updatedIds = new Set(reconciliation.taskUpdates.map((update) => update.taskId));
    for (const item of reconciled) {
      const finding = current.findings?.find((candidate) => candidate.findingId === item.findingId);
      const taskIds = finding?.taskIds ?? [];
      if (taskIds.length > 0 && !taskIds.some((taskId) => updatedIds.has(taskId))) {
        throw new Error(
          `Plan critique finding ${item.findingId} plan_reconciled resolutions require a taskUpdates entry for one of its taskIds.`,
        );
      }
    }
    applyPlanReconciliation(projection, reconciliation);
  }
  projection.planCritique = {
    ...projection.planCritique!,
    current: {
      ...current,
      status: "resolved",
      resolvedAt: event.occurredAt,
      resolution: {
        planRevisionAfter: projection.planRevision,
        resolvedBy,
        resolutions,
      },
    },
  };
}

function parsePlanCritiqueResolutions(
  value: unknown,
  blockingFindingIds: readonly string[],
): PlanCritiqueResolutionItem[] {
  if (!Array.isArray(value)) {
    throw new Error("Plan critique resolutions must be an array.");
  }
  const seen = new Set<string>();
  const items = value.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`Plan critique resolution ${index} is invalid.`);
    }
    const findingId = requiredString(candidate, "findingId");
    if (seen.has(findingId)) {
      throw new Error(`Plan critique has a duplicate resolution for finding ${findingId}.`);
    }
    seen.add(findingId);
    if (!blockingFindingIds.includes(findingId)) {
      throw new Error(`Plan critique resolution references unknown finding ${findingId}.`);
    }
    const resolution = candidate.resolution;
    if (resolution !== "plan_reconciled" && resolution !== "rejected") {
      throw new Error(`Plan critique resolution ${findingId} is invalid.`);
    }
    const rationale = candidate.rationale;
    if (typeof rationale !== "string" || !rationale.trim()) {
      throw new Error(`Plan critique resolution ${findingId} rationale is required.`);
    }
    const item: PlanCritiqueResolutionItem = {
      findingId,
      resolution,
      rationale: rationale.trim(),
    };
    return item;
  });
  for (const findingId of blockingFindingIds) {
    if (!seen.has(findingId)) {
      throw new Error(`Plan critique blocking finding ${findingId} has no resolution.`);
    }
  }
  return items;
}

function clonePlanCritiqueState(state: PlanCritiqueState): PlanCritiqueState {
  return {
    ...(state.policy ? { policy: { ...state.policy } } : {}),
    ...(state.risk
      ? {
          risk: {
            ...state.risk,
            assessment: clonePlanRiskAssessment(state.risk.assessment),
          },
        }
      : {}),
    ...(state.current ? { current: clonePlanCritiqueProjection(state.current) } : {}),
    history: state.history.map(clonePlanCritiqueProjection),
    ...(state.skipped ? { skipped: { ...state.skipped } } : {}),
  };
}

function clonePlanRiskAssessment(assessment: PlanRiskAssessment): PlanRiskAssessment {
  return {
    ...assessment,
    reasons: assessment.reasons.map((reason) => ({
      ...reason,
      evidence: [...reason.evidence],
    })),
  };
}

function clonePlanCritiqueProjection(projection: PlanCritiqueProjection): PlanCritiqueProjection {
  return {
    ...projection,
    runtime: { ...projection.runtime },
    excludedModels: projection.excludedModels.map((excluded) => ({ ...excluded })),
    ...(projection.findings
      ? { findings: projection.findings.map(clonePlanCritiqueFinding) }
      : {}),
    ...(projection.blockingFindingIds
      ? { blockingFindingIds: [...projection.blockingFindingIds] }
      : {}),
    ...(projection.resolution
      ? {
          resolution: {
            ...projection.resolution,
            resolutions: projection.resolution.resolutions.map((item) => ({ ...item })),
          },
        }
      : {}),
  };
}

function clonePlanCritiqueFinding(finding: PlanCritiqueFinding): PlanCritiqueFinding {
  return {
    ...finding,
    taskIds: [...finding.taskIds],
    evidence: [...finding.evidence],
    ...(finding.criterionIds
      ? { criterionIds: finding.criterionIds.map((criterion) => ({ ...criterion })) }
      : {}),
  };
}

function parsePlanReconciliation(value: unknown): PlanReconciliation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Missing plan reconciliation.");
  }
  const payload = value as Record<string, unknown>;
  const updates = payload.taskUpdates;
  const newTasks = payload.newTasks;
  if (!Array.isArray(updates) || (newTasks !== undefined && !Array.isArray(newTasks))) {
    throw new Error("Plan reconciliation task collections are invalid.");
  }
  if (updates.length === 0 && (!Array.isArray(newTasks) || newTasks.length === 0)) {
    throw new Error("Plan reconciliation requires taskUpdates or newTasks.");
  }
  return {
    revision: requiredNumber(payload, "revision"),
    summary: requiredString(payload, "summary"),
    taskUpdates: updates.map(parsePlanTaskUpdate),
    ...(Array.isArray(newTasks)
      ? { newTasks: newTasks.map(parsePlanNewTask) }
      : {}),
  };
}

function parsePlanNewTask(value: unknown, index: number): PlanNewTask {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`New plan task ${index} is invalid.`);
  }
  const payload = value as Record<string, unknown>;
  const allowed = new Set([
    "id",
    "objective",
    "dependencies",
    "requiredCapabilities",
    "acceptanceCriteria",
  ]);
  const unknown = Object.keys(payload).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`New plan task ${index} has unknown field(s): ${unknown.join(", ")}.`);
  }
  return {
    id: requiredString(payload, "id"),
    objective: requiredString(payload, "objective"),
    dependencies: stringArray(payload, "dependencies"),
    requiredCapabilities: stringArray(payload, "requiredCapabilities"),
    acceptanceCriteria: parseAcceptanceCriteria(payload.acceptanceCriteria, `New plan task ${index}`),
  };
}

function parsePlanTaskUpdate(value: unknown, index: number): PlanTaskUpdate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Plan task update ${index} is invalid.`);
  }
  const payload = value as Record<string, unknown>;
  const action = requiredString(payload, "action");
  if (action !== "cancel" && action !== "revise") {
    throw new Error(`Plan task update ${index} action ${action} is invalid.`);
  }
  const optionalStrings = (key: "dependencies" | "requiredCapabilities") =>
    payload[key] === undefined ? undefined : stringArray(payload, key);
  const objective = payload.objective;
  if (objective !== undefined && (typeof objective !== "string" || !objective.trim())) {
    throw new Error(`Plan task update ${index} objective is invalid.`);
  }
  const acceptanceCriteria = payload.acceptanceCriteria === undefined
    ? undefined
    : parseAcceptanceCriteria(payload.acceptanceCriteria, `Plan task update ${index}`);
  return {
    taskId: requiredString(payload, "taskId"),
    action,
    ...(typeof objective === "string" ? { objective } : {}),
    ...(optionalStrings("dependencies") !== undefined
      ? { dependencies: optionalStrings("dependencies") }
      : {}),
    ...(optionalStrings("requiredCapabilities") !== undefined
      ? { requiredCapabilities: optionalStrings("requiredCapabilities") }
      : {}),
    ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
  };
}

function parseAcceptanceCriteria(
  value: unknown,
  context: string
): NonNullable<BuildTask["acceptanceCriteria"]> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} acceptanceCriteria must contain at least one criterion.`);
  }
  const criteria = value.map((candidate, index) => {
    const record = candidate as Record<string, unknown>;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      typeof record.id !== "string" ||
      !record.id.trim() ||
      typeof record.text !== "string" ||
      !record.text.trim()
    ) {
      throw new Error(`${context} acceptance criterion ${index} is invalid.`);
    }
    const criterion = candidate as { id: string; text: string };
    return { id: criterion.id, text: criterion.text };
  });
  const ids = new Set<string>();
  for (const criterion of criteria) {
    if (ids.has(criterion.id)) {
      throw new Error(`${context} acceptanceCriteria repeats criterion ${criterion.id}.`);
    }
    ids.add(criterion.id);
  }
  return criteria;
}

function applyPlanReconciliation(
  projection: SchedulerProjection,
  reconciliation: PlanReconciliation,
  options: {
    allowSteeringCheckpoints?: boolean;
    supersedingGuidanceId?: string;
  } = {}
): void {
  if (reconciliation.revision !== projection.planRevision + 1) {
    throw new Error(
      `Plan reconciliation must advance plan revision ${projection.planRevision} by one.`
    );
  }
  const duplicate = reconciliation.taskUpdates.find(
    (update, index, updates) =>
      updates.findIndex((candidate) => candidate.taskId === update.taskId) !== index
  );
  if (duplicate) {
    throw new Error(`Plan reconciliation repeats task ${duplicate.taskId}.`);
  }

  const candidateTasks = Object.fromEntries(
    Object.entries(projection.tasks).map(([taskId, task]) => [taskId, cloneBuildTask(task)])
  );
  const newTasks = reconciliation.newTasks ?? [];
  const duplicateNewTask = newTasks.find(
    (task, index, tasks) => tasks.findIndex((candidate) => candidate.id === task.id) !== index
  );
  if (duplicateNewTask) {
    throw new Error(`Plan reconciliation repeats new task ${duplicateNewTask.id}.`);
  }
  const overlappingTask = newTasks.find((task) =>
    reconciliation.taskUpdates.some((update) => update.taskId === task.id)
  );
  if (overlappingTask) {
    throw new Error(
      `Plan reconciliation task ${overlappingTask.id} must have exactly one operation.`
    );
  }
  for (const task of newTasks) {
    if (candidateTasks[task.id]) {
      throw new Error(`Plan reconciliation new task ${task.id} already exists.`);
    }
    candidateTasks[task.id] = {
      id: task.id,
      objective: task.objective,
      dependencies: [...task.dependencies],
      requiredCapabilities: [...task.requiredCapabilities],
      acceptanceCriteria: task.acceptanceCriteria.map((criterion) => ({ ...criterion })),
      acceptanceCriteriaVersion: 1,
      status: "planned",
      attempt: 0,
    };
  }
  const sameAttemptSteeringTaskIds = new Set<string>();
  const reviewsToClear = new Set<string>();
  const guidanceTaskIdsToSupersede = new Set<string>();
  const runtimeAssignmentKeysToClear = new Set<string>();
  for (const update of reconciliation.taskUpdates) {
    const task = candidateTasks[update.taskId];
    if (!task) throw new Error(`Unknown task ${update.taskId}.`);
    if (isFinalVerificationTask(task)) {
      throw new Error("Kernel-owned final verification task cannot be reconciled.");
    }
    const sameAttemptSteeringCheckpoint =
      options.allowSteeringCheckpoints === true &&
      (task.status === "running" ||
        task.status === "assigned" ||
        task.status === "waiting_guidance");
    const freshAttemptSteeringCheckpoint =
      options.allowSteeringCheckpoints === true &&
      (task.status === "submitted" ||
        task.status === "architect_review" ||
        task.status === "approved");
    const steeringCheckpoint =
      sameAttemptSteeringCheckpoint || freshAttemptSteeringCheckpoint;
    if (
      task.status !== "planned" &&
      task.status !== "failed" &&
      task.status !== "rejected" &&
      task.status !== "waiting_guidance" &&
      !steeringCheckpoint
    ) {
      throw new Error(
        `Task ${update.taskId} must be planned, failed, or rejected before reconciliation.`
      );
    }
    if (sameAttemptSteeringCheckpoint && update.acceptanceCriteria !== undefined) {
      throw new Error(
        `Task ${update.taskId} acceptance criteria are immutable during its active attempt.`
      );
    }
    if (steeringCheckpoint) {
      if (sameAttemptSteeringCheckpoint) {
        sameAttemptSteeringTaskIds.add(update.taskId);
      }
      reviewsToClear.add(update.taskId);
      guidanceTaskIdsToSupersede.add(update.taskId);
      runtimeAssignmentKeysToClear.add(`${update.taskId}:${task.attempt}`);
    }
    if (update.action === "cancel") {
      if (
        task.kind === "verification_repair" &&
        (
          Boolean(
            task.verificationRepair &&
            task.verificationRepair.sourceGenerationId ===
              projection.finalVerification?.current?.generationId,
          ) ||
          Boolean(
            task.verifierRepair &&
            task.verifierRepair.sourceReviewId ===
              projection.verifier?.current?.reviewId,
          )
        )
      ) {
        throw new Error(
          "A current-generation verification repair cannot be cancelled during reconciliation.",
        );
      }
      const cancelledTask = {
        ...task,
        status: "cancelled" as const,
        assignedWorkerId: undefined,
        changeSetId: undefined,
        guidanceRequestId: undefined,
        failureReason: undefined,
        criterionEvidenceLinks: undefined,
      };
      candidateTasks[update.taskId] = steeringCheckpoint
        ? cancelledTask
        : {
            ...applyTaskTransition(task, "cancelled", {
              assignedWorkerId: undefined,
              changeSetId: undefined,
              guidanceRequestId: undefined,
              failureReason: undefined,
            }),
            criterionEvidenceLinks: undefined,
          };
      continue;
    }
    if (
      update.objective === undefined &&
      update.dependencies === undefined &&
      update.requiredCapabilities === undefined
    ) {
      throw new Error(`Task ${update.taskId} revision has no changes.`);
    }
    const patch = {
      ...(update.objective !== undefined ? { objective: update.objective } : {}),
      ...(update.dependencies !== undefined
        ? { dependencies: [...update.dependencies] }
        : {}),
      ...(update.requiredCapabilities !== undefined
        ? { requiredCapabilities: [...update.requiredCapabilities] }
        : {}),
      ...(update.acceptanceCriteria !== undefined
        ? { acceptanceCriteria: update.acceptanceCriteria.map((criterion) => ({ ...criterion })) }
        : {}),
    };
    const criteriaChanged = update.acceptanceCriteria !== undefined;
    if (!steeringCheckpoint && task.status === "waiting_guidance") {
      candidateTasks[update.taskId] = {
        ...applyTaskTransition(task, "planned", {
          ...patch,
          guidanceRequestId: undefined,
        }),
        ...(criteriaChanged
          ? { acceptanceCriteriaVersion: (task.acceptanceCriteriaVersion ?? 0) + 1 }
          : {}),
      };
      continue;
    }
    const grantsFreshAttempt =
      task.status === "failed" ||
      task.status === "rejected" ||
      (task.status === "planned" && task.attempt > 0);
    candidateTasks[update.taskId] = sameAttemptSteeringCheckpoint
      ? {
          ...task,
          ...patch,
          status: "assigned",
          assignedWorkerId: steeringReassignedWorkerId(
            task.id,
            task.attempt,
            reconciliation.revision
          ),
          changeSetId: undefined,
          criterionEvidenceLinks: undefined,
          guidanceRequestId: undefined,
          failureReason: undefined,
        }
      : freshAttemptSteeringCheckpoint || grantsFreshAttempt
      ? {
          ...task,
          ...patch,
          ...(criteriaChanged
            ? { acceptanceCriteriaVersion: (task.acceptanceCriteriaVersion ?? 0) + 1 }
            : {}),
          status: "planned",
          attemptLimit: Math.max(task.attemptLimit ?? 0, task.attempt + 1),
          assignedWorkerId: undefined,
          changeSetId: undefined,
          criterionEvidenceLinks: undefined,
          failureReason: undefined,
        }
      : {
          ...task,
          ...patch,
          ...(criteriaChanged
            ? { acceptanceCriteriaVersion: (task.acceptanceCriteriaVersion ?? 0) + 1 }
            : {}),
        };
  }

  const tasks = Object.values(candidateTasks);
  for (const taskId of sameAttemptSteeringTaskIds) {
    const task = candidateTasks[taskId];
    if (task.status !== "assigned") continue;
    const unfinishedDependency = task.dependencies.find(
      (dependency) => candidateTasks[dependency]?.status !== "integrated"
    );
    if (unfinishedDependency) {
      throw new Error(
        `Interrupted active task ${taskId} cannot add unfinished dependency ${unfinishedDependency}.`
      );
    }
  }
  const validation = validateTaskGraph(tasks);
  if (!validation.valid) {
    throw new Error(
      `Plan reconciliation has mechanical issues: ${validation.issues
        .map((issue) => issue.code)
        .join(", ")}.`
    );
  }
  for (const task of tasks) {
    if (task.status === "cancelled") continue;
    const cancelledDependency = task.dependencies.find(
      (dependency) => candidateTasks[dependency]?.status === "cancelled"
    );
    if (cancelledDependency) {
      throw new Error(
        `Task ${task.id} depends on cancelled task ${cancelledDependency}.`
      );
    }
  }

  projection.tasks = candidateTasks;
  for (const taskId of reviewsToClear) {
    delete projection.reviews[taskId];
  }
  for (const assignmentKey of runtimeAssignmentKeysToClear) {
    delete projection.runtime.workerAssignments[assignmentKey];
  }
  if (options.supersedingGuidanceId) {
    for (const guidance of Object.values(projection.guidance)) {
      if (
        guidance.status === "open" &&
        guidanceTaskIdsToSupersede.has(guidance.taskId)
      ) {
        projection.guidance[guidance.requestId] = {
          ...guidance,
          status: "answered",
          answer: `Superseded by acknowledged user guidance ${options.supersedingGuidanceId}.`,
        };
      }
    }
  }
  const touchedTaskIds = new Set(reconciliation.taskUpdates.map((update) => update.taskId));
  for (const guidance of Object.values(projection.guidance)) {
    if (
      guidance.status === "open" &&
      touchedTaskIds.has(guidance.taskId)
    ) {
      projection.guidance[guidance.requestId] = {
        ...guidance,
        status: "answered",
        answer: `plan_reconciled:${reconciliation.revision}`,
      };
    }
  }
  projection.planRevision = reconciliation.revision;
  if (projection.acceptanceContractStatus !== "legacy_completed") {
    projection.acceptanceContractStatus = acceptanceContractStatusForTasks(tasks);
  }
}

interface AcceptanceContractUpgrade {
  revision: number;
  criteriaByTask: Array<{
    taskId: string;
    acceptanceCriteria: AcceptanceCriterion[];
  }>;
}

function parseAcceptanceContractUpgrade(
  payload: Record<string, unknown>
): AcceptanceContractUpgrade {
  const revision = requiredNumber(payload, "revision");
  const rawEntries = payload.criteriaByTask;
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    throw new Error("Acceptance-contract upgrade requires criteriaByTask.");
  }
  const criteriaByTask = rawEntries.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`Acceptance-contract upgrade entry ${index} is invalid.`);
    }
    const value = entry as Record<string, unknown>;
    return {
      taskId: requiredString(value, "taskId"),
      acceptanceCriteria: parseAcceptanceCriteria(
        value.acceptanceCriteria,
        `Acceptance-contract upgrade entry ${index}`
      ),
    };
  });
  return { revision, criteriaByTask };
}

function applyAcceptanceContractUpgrade(
  projection: SchedulerProjection,
  upgrade: AcceptanceContractUpgrade
): void {
  if (projection.status === "completed" || projection.acceptanceContractStatus === "legacy_completed") {
    throw new Error("A completed legacy run cannot be upgraded in place.");
  }
  if (projection.acceptanceContractStatus !== "acceptance_contract_upgrade_required") {
    throw new Error("An acceptance-contract upgrade is not required for this run.");
  }
  if (!projection.acceptanceUpgradeRequiredEventRecorded) {
    throw new Error("Acceptance-contract upgrade requires a recorded upgrade gate.");
  }
  if (upgrade.revision !== projection.planRevision + 1) {
    throw new Error(
      `Acceptance-contract upgrade must advance plan revision ${projection.planRevision} by one.`
    );
  }
  const activeTasks = Object.values(projection.tasks).filter(
    (task) => task.status !== "cancelled" && !isFinalVerificationTask(task)
  );
  const expectedTaskIds = activeTasks.map((task) => task.id).sort();
  const seenTaskIds = new Set<string>();
  for (const entry of upgrade.criteriaByTask) {
    if (seenTaskIds.has(entry.taskId)) {
      throw new Error(`Acceptance-contract upgrade repeats task ${entry.taskId}.`);
    }
    seenTaskIds.add(entry.taskId);
    if (!projection.tasks[entry.taskId] || projection.tasks[entry.taskId].status === "cancelled") {
      throw new Error(
        `Acceptance-contract upgrade references unknown or cancelled task ${entry.taskId}.`
      );
    }
  }
  const receivedTaskIds = [...seenTaskIds].sort();
  if (
    receivedTaskIds.length !== expectedTaskIds.length ||
    receivedTaskIds.some((taskId, index) => taskId !== expectedTaskIds[index])
  ) {
    throw new Error(
      "Acceptance-contract upgrade must provide criteria for every non-cancelled task exactly once."
    );
  }

  const candidateTasks = Object.fromEntries(
    activeTasks.map((task) => {
      const entry = upgrade.criteriaByTask.find((candidate) => candidate.taskId === task.id)!;
      const criteriaValidation = validateAcceptanceCriteria(entry.acceptanceCriteria);
      if (!criteriaValidation.valid) {
        throw new Error(
          `Acceptance-contract upgrade has invalid criteria for task ${task.id}: ${criteriaValidation.issues.join(" ")}`
        );
      }
      const wasLegacy = task.acceptanceCriteria === undefined;
      const criterionIdsChanged =
        !task.acceptanceCriteria ||
        task.acceptanceCriteria.length !== entry.acceptanceCriteria.length ||
        task.acceptanceCriteria.some(
          (criterion, index) =>
            criterion.id !== entry.acceptanceCriteria[index]?.id ||
            criterion.text !== entry.acceptanceCriteria[index]?.text
        );
      const requiresFreshAttempt =
        (wasLegacy || criterionIdsChanged) &&
        (task.status === "submitted" ||
          task.status === "architect_review" ||
          task.status === "approved" ||
          task.status === "integrating" ||
          task.status === "integration_resolution");
      return [
        task.id,
        cloneBuildTask({
          ...task,
          acceptanceCriteria: entry.acceptanceCriteria.map((criterion) => ({ ...criterion })),
          acceptanceCriteriaVersion: wasLegacy
            ? 1
            : criterionIdsChanged
              ? (task.acceptanceCriteriaVersion ?? 0) + 1
              : task.acceptanceCriteriaVersion ?? 1,
          ...(wasLegacy || criterionIdsChanged
            ? { criterionEvidenceLinks: undefined }
            : {}),
          ...(requiresFreshAttempt
            ? {
                status: "planned",
                attemptLimit: Math.max(task.attemptLimit ?? 0, task.attempt + 1),
                assignedWorkerId: undefined,
                changeSetId: undefined,
                guidanceRequestId: undefined,
                failureReason: undefined,
              }
            : {}),
        }),
      ];
    })
  );
  for (const task of Object.values(projection.tasks)) {
    if (task.status === "cancelled" || isFinalVerificationTask(task)) {
      candidateTasks[task.id] = cloneBuildTask(task);
    }
  }
  const validation = validateTaskGraph(Object.values(candidateTasks), {
    requireAcceptanceCriteria: true,
  });
  if (!validation.valid) {
    throw new Error(
      `Acceptance-contract upgrade has mechanical issues: ${validation.issues
        .map((issue) => issue.code)
        .join(", ")}.`
    );
  }
  projection.tasks = candidateTasks;
  projection.planRevision = upgrade.revision;
  projection.acceptanceContractStatus = "current";
}

function missingAcceptanceCriteriaTaskIds(
  tasks: Record<string, BuildTask>
): string[] {
  return Object.values(tasks)
    .filter(
      (task) =>
        !isFinalVerificationTask(task) &&
        task.status !== "cancelled" &&
        task.acceptanceCriteria === undefined,
    )
    .map((task) => task.id)
    .sort();
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((value) => expected.has(value));
}

function acceptanceContractStatusForTasks(
  tasks: readonly BuildTask[]
): SchedulerProjection["acceptanceContractStatus"] {
  return missingAcceptanceCriteriaTaskIds(
    Object.fromEntries(tasks.map((task) => [task.id, task]))
  ).length > 0
    ? "acceptance_contract_upgrade_required"
    : "current";
}

function cloneRepairCyclesProjection(
  cycles: RepairCyclesProjection,
): RepairCyclesProjection {
  return {
    limit: cycles.limit,
    used: cycles.used,
    extensions: cycles.extensions,
    ...(cycles.pause ? { pause: { ...cycles.pause } } : {}),
  };
}

function cloneUserGuidanceItem(guidance: UserGuidanceItem): UserGuidanceItem {
  return {
    ...guidance,
    ...(guidance.resolution
      ? { resolution: cloneUserGuidanceResolution(guidance.resolution) }
      : {}),
  };
}

function cloneUserGuidanceResolution(
  resolution: UserGuidanceAcknowledgementResolution,
): UserGuidanceAcknowledgementResolution {
  if (resolution.type === "no_plan_change") {
    return { ...resolution, evidenceIds: [...resolution.evidenceIds] };
  }
  return {
    ...resolution,
    planReconciliation: {
      ...resolution.planReconciliation,
      taskUpdates: resolution.planReconciliation.taskUpdates.map((update) => ({
        ...update,
        ...(update.dependencies ? { dependencies: [...update.dependencies] } : {}),
        ...(update.requiredCapabilities
          ? { requiredCapabilities: [...update.requiredCapabilities] }
          : {}),
        ...(update.acceptanceCriteria
          ? {
              acceptanceCriteria: update.acceptanceCriteria.map((criterion) => ({
                ...criterion,
              })),
            }
          : {}),
      })),
      ...(resolution.planReconciliation.newTasks
        ? {
            newTasks: resolution.planReconciliation.newTasks.map((task) => ({
              ...task,
              dependencies: [...task.dependencies],
              requiredCapabilities: [...task.requiredCapabilities],
              acceptanceCriteria: task.acceptanceCriteria.map((criterion) => ({ ...criterion })),
            })),
          }
        : {}),
    },
  };
}

function emptySchedulerProjection(event: SchedulerEvent): SchedulerProjection {
  const initialObjective = event.payload.objective;
  return {
    runId: event.runId,
    ...(typeof initialObjective === "string" ? { initialObjective } : {}),
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
    submissionHistory: {},
    reviewHistory: {},
    runtime: { providerHealth: {}, workerAssignments: {}, architect: {} },
    lastSequence: event.sequence,
  };
}

function planProjection(
  event: SchedulerEvent,
  tasks: BuildTask[]
): SchedulerProjection {
  return {
    ...emptySchedulerProjection(event),
    planRevision: requiredNumber(event.payload, "revision"),
    tasks: Object.fromEntries(tasks.map((task) => [task.id, cloneBuildTask(task)])),
    acceptanceContractStatus: acceptanceContractStatusForTasks(tasks),
    planRiskDeclaration: parsePlanRiskDeclaration(event.payload),
    ...(event.actor.role === "architect"
      ? {
          lastArchitectActionEvent: {
            sequence: event.sequence,
            type: event.type,
            actor: { ...event.actor },
            payload: structuredClone(event.payload),
          },
        }
      : {}),
  };
}

function assertTransitionAuthority(
  status: BuildTask["status"],
  role: SchedulerActorRole
): void {
  const architectStatuses: BuildTask["status"][] = [
    "architect_review",
    "approved",
    "rejected",
    "integrating",
  ];
  if (architectStatuses.includes(status) && role !== "architect") {
    throw new Error(`Only the Architect may transition a task to ${status}.`);
  }
  if (
    (status === "integrated" || status === "integration_resolution") &&
    role !== "runner"
  ) {
    throw new Error(`Only the runner may transition a task to ${status}.`);
  }
}

function stringArray(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Missing ${key}.`);
  }
  return [...value] as string[];
}

function appendSubmissionHistory(
  projection: SchedulerProjection,
  submission: CriterionSubmissionProjection
): void {
  const history = projection.submissionHistory ?? (projection.submissionHistory = {});
  history[submission.taskId] = [
    ...(history[submission.taskId] ?? []),
    cloneSubmissionProjection(submission),
  ];
}

function appendReviewHistory(
  projection: SchedulerProjection,
  review: ReviewProjection
): void {
  const history = projection.reviewHistory ?? (projection.reviewHistory = {});
  history[review.taskId] = [
    ...(history[review.taskId] ?? []),
    cloneReviewProjection(review),
  ];
}

function cloneSubmissionHistory(
  history: SchedulerProjection["submissionHistory"]
): Record<string, CriterionSubmissionProjection[]> {
  return Object.fromEntries(
    Object.entries(history ?? {}).map(([taskId, submissions]) => [
      taskId,
      (submissions ?? []).map(cloneSubmissionProjection),
    ])
  );
}

function cloneReviewHistory(
  history: SchedulerProjection["reviewHistory"]
): Record<string, ReviewProjection[]> {
  return Object.fromEntries(
    Object.entries(history ?? {}).map(([taskId, reviews]) => [
      taskId,
      (reviews ?? []).map(cloneReviewProjection),
    ])
  );
}

function cloneSubmissionProjection(
  submission: CriterionSubmissionProjection
): CriterionSubmissionProjection {
  return {
    ...submission,
    ...(submission.criterionEvidenceLinks
      ? { criterionEvidenceLinks: cloneCriterionEvidenceLinks(submission.criterionEvidenceLinks) }
      : {}),
  };
}

function cloneReviewProjection(review: ReviewProjection): ReviewProjection {
  return {
    ...review,
    evidenceArtifactHashes: [...review.evidenceArtifactHashes],
    ...(review.criterionEvidenceLinks
      ? { criterionEvidenceLinks: cloneCriterionEvidenceLinks(review.criterionEvidenceLinks) }
      : {}),
    ...(review.criterionVerdicts
      ? { criterionVerdicts: cloneCriterionReviewVerdicts(review.criterionVerdicts) }
      : {}),
  };
}

function cloneCriterionEvidenceLinks(
  links: readonly CriterionEvidenceLink[]
): CriterionEvidenceLink[] {
  return links.map((link) => ({
    ...link,
    artifactHashes: [...link.artifactHashes],
  }));
}

function cloneCriterionReviewVerdicts(
  verdicts: readonly CriterionReviewVerdict[]
): CriterionReviewVerdict[] {
  return verdicts.map((verdict) => ({
    ...verdict,
    evidenceIds: [...verdict.evidenceIds],
    ...(verdict.artifactHashes
      ? { artifactHashes: [...verdict.artifactHashes] }
      : {}),
    ...(verdict.acceptedFailures
      ? {
          acceptedFailures: verdict.acceptedFailures.map((failure) => ({
            ...failure,
          })),
        }
      : {}),
  }));
}

function cloneBuildTask(task: BuildTask): BuildTask {
  return {
    ...task,
    dependencies: [...task.dependencies],
    requiredCapabilities: [...task.requiredCapabilities],
    ...(task.acceptanceCriteria
      ? { acceptanceCriteria: task.acceptanceCriteria.map((criterion) => ({ ...criterion })) }
      : {}),
    ...(task.criterionEvidenceLinks
      ? {
          criterionEvidenceLinks: task.criterionEvidenceLinks.map((link) => ({
            ...link,
            artifactHashes: [...link.artifactHashes],
          })),
        }
      : {}),
    ...(task.verificationPlan
      ? { verificationPlan: planFinalVerification(task.verificationPlan) }
      : {}),
    ...(task.verifierRepair
      ? {
          verifierRepair: {
            ...task.verifierRepair,
            criteria: task.verifierRepair.criteria.map((criterion) => ({ ...criterion })),
            evidenceIds: [...task.verifierRepair.evidenceIds],
          },
        }
      : {}),
    ...(task.conflictPaths ? { conflictPaths: [...task.conflictPaths] } : {}),
  };
}

function invalidateFinalVerificationForGuidance(
  projection: SchedulerProjection,
  guidanceId: string,
): void {
  const current = projection.finalVerification?.current;
  if (!current) return;
  projection.finalVerification = {
    history: [
      ...(projection.finalVerification?.history ?? []).map(
        cloneFinalVerificationGeneration,
      ),
      {
        ...cloneFinalVerificationGeneration(current),
        state: "invalidated",
        invalidatedByGuidanceId: guidanceId,
      },
    ],
  };
  const currentRisk = projection.buildRisk?.current;
  if (currentRisk) {
    projection.buildRisk = {
      history: [
        ...(projection.buildRisk?.history ?? []).map(cloneBuildRiskAssessment),
        {
          ...cloneBuildRiskAssessment(currentRisk),
          state: "invalidated",
          invalidatedByGuidanceId: guidanceId,
        },
      ],
    };
  }
  const currentVerifier = projection.verifier?.current;
  if (currentVerifier) {
    projection.verifier = {
      history: [
        ...(projection.verifier?.history ?? []).map(cloneVerifierReview),
        {
          ...cloneVerifierReview(currentVerifier),
          state: "invalidated",
          invalidatedByGuidanceId: guidanceId,
        },
      ],
    };
  }
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) throw new Error(`Missing ${key}.`);
  return value;
}

function requiredPositiveInteger(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return value as number;
}

function requiredAssignedWorkerId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `${label} requires a non-empty assigned worker identity for criterion evidence.`
    );
  }
  return value;
}

function requiredNumber(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (!Number.isSafeInteger(value)) throw new Error(`Missing ${key}.`);
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRunPolicy(
  payload: Record<string, unknown>
): NativeBuildRunPolicy {
  const value = payload.runPolicy;
  if (value !== "finish" && value !== "budgeted" && value !== "plan_only") {
    throw new Error("Missing runPolicy.");
  }
  return value;
}
