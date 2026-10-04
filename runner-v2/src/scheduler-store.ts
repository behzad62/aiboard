import {
  DELIVERY_ACCEPTANCE_RUNNER_ID,
  DELIVERY_REVIEW_RUNNER_ID,
  assertContractTaskRevisionAllowed,
  assertTestsOutcome,
  assessDeliveryRisk,
  taskAcceptedFailuresUsed,
  boundaryNeedsArchitect,
  boundaryResolutionGeneration,
  deliveryBoundaryAction,
  deliveryBoundaryId,
  deliveryReviewApprovalIssues,
  deliveryReviewDepthForTier,
  deliveryReviewId,
  emptyDeliveryState,
  evaluatePhaseAcceptance,
  finalReadyCoverageIssues,
  finalReadyRequirementIssues,
  latestBoundary,
  latestCompletedReview,
  openBlockingFindings,
  phaseAcceptanceKey,
  unverifiedClaims,
  validateDeliveryFindings,
  validateDeliveryObligations,
  type DeliveryAffectedTestsRecord,
  type DeliveryBoundaryCheck,
  type DeliveryBoundaryRecord,
  type DeliveryClaim,
  type DeliveryClaimVerdict,
  type DeliveryDepthRecord,
  type DeliveryPriorFindingCheck,
  type DeliveryProbeRecord,
  type DeliveryReviewRecord,
  type DeliveryState,
  type DeliveryTestReport,
} from "./delivery-acceptance.js";
import { parseRecoveryAuditRecord, recoveryBlocksRun, validateRecoveryTransition, type RecoveryAuditRecord } from "./process-recovery-contracts.js";
import { createHash } from "node:crypto";
import { PROJECT_DOC_MAX_BYTES, validateProjectDocPath } from "./project-docs.js";
import { isDiagnosticRepairCycle } from "./repair-budget-contracts.js";
import { testIntegrityBaselineFindings, assertNoConfiguredTestSuite, executedTestCount, testIntegrityPinDigest, unresolvedTestIntegrityFindings, type TestIntegrityPin, type TestIntegrityException } from "./test-integrity.js";
import type { TestIntegrityState, TestIntegrityBoundary, TestConsolidationDisposition } from "./test-integrity-contracts.js";

import {
  isFinalVerificationTask,
  REPLAN_REASONS,
  type BuildTask,
  type TaskContractRef,
  type PlanNewTask,
  type PlanReconciliation,
  type PlanTaskUpdate,
  type ReplanReason,
  type ReplanRequest,
} from "./task-contracts.js";
import { applyTaskTransition, validateTaskGraph } from "./task-graph.js";
import { validateSubmissionScopeRecord } from "./submission-scope-capture.js";
import { validateReviewSignals } from "./review-integrity.js";
import { validateEncodingSubmission, encodingFindingFacts } from "./encoding-safety.js";
import type { ExecutionPlanRevision, ExecutionTaskContract } from "./planning-contracts.js";
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
  type UserGuidanceFoldedIntoPlanningResolution,
  type UserGuidanceItem,
} from "./user-steering-contracts.js";
import {
  isSteeringReassignedWorkerId,
  steeringReassignedWorkerId,
  workerSessionId,
} from "./worker-identity.js";
import {
  assertExactVerifierCriteria,
  canonicalModelIdentity,
  cloneVerifierProjection,
  cloneVerifierReview,
  expectedVerifierCriteria,
  parseExcludedModels,
  parseReviewerIndependence,
  parseRuntimeBinding,
  parseVerifierExpectations,
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
import {
  isPlanningEventType,
  reducePlanningProjection,
  type PlanningEventType,
  type PlanningProjection,
} from "./planning-projection.js";

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
  | "verifier.expectations_recorded"
  | "verifier.verdict_submitted"
  | "verifier.repairs_planned"
  | "repair.policy_configured"
  | "repair.issue_recorded"
  | "repair.approach_decided"
  | "repair.cycle_recorded"
  | "repair.approach_failed"
  | "repair.external_blocker_recorded"
  | "repair.flaky_isolated"
  | "repair.issue_budget_extended"
  | "repair.issue_paused"
  | "repair.external_blocker_cleared"
  | "temp.creation_recorded"
  | "temp.record_cleared"
  | "cleanup.checked"
  | "repair.cycle_limit_reached"
  | "repair.cycle_limit_extended"
  | "plan_critique.policy_configured"
  | "plan_critique.risk_assessed"
  | "plan_critique.requested"
  | "plan_critique.submitted"
  | "plan_critique.resolved"
  | "plan_critique.skipped"
  | "context_manifest.recording_failed"
  | "context_manifest.recording_resolved"
  | "project_doc.requested"
  | "project_doc.committed"
  | "project_doc.abandoned"
  | "project_docs.policy_configured"
  | "project_docs.handoff_snapshot_committed"
  | "project_docs.stop_snapshot_skipped"
  | "handoff.notes_recorded"
  | "handoff.notes_attempted"
  | "handoff.notes_failed"
  | "delivery.review_started"
  | "delivery.review_requested"
  | "delivery.obligations_recorded"
  | "delivery.criteria_and_diff_delivered"
  | "delivery.findings_recorded"
  | "delivery.report_delivered"
  | "delivery.review_recorded"
  | "delivery.boundary_started"
  | "delivery.boundary_checked"
  | "delivery.boundary_failure_resolved"
  | "delivery.test_integrity_initialized"
  | "delivery.test_integrity_baseline_recorded"
  | "delivery.test_integrity_exception_recorded"
  | "task.acceptance_recorded"
  | "phase.acceptance_recorded"
  | "planning.policy_configured"
  | "request.triaged"
  | "request.answered"
  | "request.converted_to_build"
  | "answer.review_opted_in"
  | "answer.review_opted_out"
  | "answer.review_findings_recorded"
  | "answer.review_prior_findings_released"
  | "answer.review_recorded"
  | "answer.review_unavailable"
  | PlanningEventType;

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
  modelIdentity?: string;
  taskId: string;
  attempt: number;
  runtimeId: string;
  sessionId: string;
}

export interface ArchitectHandoffProjection {
  /**
   * T7b (FX-2 review r2 F1): the scheduler event sequence of the pending
   * handoff requirement. Stamped by the reducer on every
   * `architect.handoff_required`; absent only pre-T7b (legacy answer path).
   */
  requiredSequence?: number;
  reason: string;
  requiredCapabilities: string[];
  candidateRuntimeIds: string[];
}

export interface RuntimeProjection {
  workerAssignmentHistory?: Record<string, WorkerRuntimeAssignmentProjection[]>;
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

export interface ProjectDocRequestProjection {
  requestId: string;
  path: string;
  contentArtifactHash: string;
  contentBytes: number;
  summary: string;
  sequence: number;
}

export interface ProjectDocAbandonmentProjection {
  requestId: string;
  path: string;
  reason: string;
  sequence: number;
}

/** Pending Architect document requests and commits on the integration branch. */
export interface ProjectDocsProjection {
  pending: ProjectDocRequestProjection[];
  committed?: ProjectDocCommitProjection[];
  /** Document-only commits ahead of the canonical integration revision. */
  documentTip?: string;
  abandoned?: ProjectDocAbandonmentProjection[];
  /** Kernel handoff snapshots (docs policy v2) in append order. */
  snapshots?: HandoffSnapshotRecord[];
  /** C3a (AR-R08): stops with no snapshot commit and why, in append order. */
  stopSnapshotSkips?: StopSnapshotSkipRecord[];
  /** C3b (AR-R09): Architect stop notes per stop sequence, in append order. */
  stopNotes?: StopNotesRecord[];
  /** C3b repair cycle 1 (R1-2): durable per-stop attempt markers, in append order. */
  stopNoteAttempts?: StopNoteAttemptRecord[];
  /** C3b repair cycle 1 (R1-2): durable per-stop failed-attempt outcomes, in append order. */
  stopNoteFailures?: StopNoteFailureRecord[];
}

/**
 * A kernel-committed handoff snapshot (docs policy v2; C2a: STATE.md only,
 * C2b: plus the v2 entry lines and the optional spec copy).
 */
export interface HandoffSnapshotRecord {
  stopSequence: number;
  stopKind: string;
  revision: string;
  commit: string;
  parent: string;
  head: string;
  /**
   * The committed STATE.md body digest (C2c repair CD-17: "" when
   * stateSkippedReason carries the skip instead -- no STATE.md was
   * committed, so there is no digest to record).
   */
  bodyDigest: string;
  paths: string[];
  /**
   * C2c repair CD-17: why no STATE.md was committed (a linked directory
   * above it). The AR-R05 gate accepts the recorded reason the way it
   * accepts export_only. Absent means STATE.md committed.
   */
  stateSkippedReason?: string;
  sequence: number;
  /**
   * The tip STATE.md was hand-edited before this snapshot (AR-R07): the new
   * snapshot names it. False for the first snapshot and for clean chains.
   */
  previousSnapshotEdited: boolean;
  /**
   * Read back from the commit's own tree (never the checkout): the commit
   * holds the marked v2 AGENTS.md section and the marked `@AGENTS.md` line.
   * The AR-R05 gate requires both.
   */
  agentsSectionCommitted: boolean;
  claudeLineCommitted: boolean;
  /** Spec-copy outcome (CD-5): the committed copy path, or the repo path of the approved source when it was already a repository file. Absent when no copy was written. */
  specPath?: string;
  /** True when this snapshot committed a verbatim spec copy. Absent means none was written. */
  specCopied?: boolean;
  /** C2b repair m4: bounded reason the spec copy was skipped. Absent means not skipped. */
  specCopySkipped?: string;
  /** C2b repair m5: why the CLAUDE.md line counts as satisfied although the blob holds none. Absent means the blob holds it. */
  claudeLineViaLink?: string;
  /**
   * C2c (NF-2/CD-15): why the AGENTS.md section counts as satisfied although
   * the blob holds none -- the runner wrote it into the link target path
   * directly (redirect), or skipped the link to a missing or outside target
   * with a recorded reason. Absent means the blob holds it. The AR-R05 gate
   * accepts the recorded reason for that file; STATE.md stays required.
   */
  agentsSectionViaLink?: string;
}

export interface ProjectDocCommitProjection {
  requestId: string;
  path: string;
  commit: string;
  parent: string;
  head: string;
  readme: boolean;
  agentsMarkedSection: boolean;
  claudePointer: boolean;
  sequence: number;
}

export interface ProjectHandoffProjection {
  status: "requested" | "selected";
  summary: string;
  /** Log sequence of the `project.handoff_requested` event (C2a repair: binds the v2 gate to the latest stop). Absent only on hand-built projections; the reducer always records it. */
  requestedSequence?: number;
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
  twoPass: boolean;
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
  /**
   * T7b (FX-2 review r2 F1): the scheduler event sequence of the pending
   * requirement this selection answers. Stamped by the reducer on every
   * `verifier.selection_required` (including replayed history, whose events
   * already carry sequences); absent only on projections reduced before T7b
   * without a requirement event, which keep the legacy answer path.
   */
  requiredSequence?: number;
  reason: string;
  requiredCapabilities: string[];
  candidateRuntimeIds: string[];
  selectedRuntimeId?: string;
}

export const DEFAULT_REPAIR_PLAN_LIMIT = 3;
export const MAX_REPAIR_CYCLE_EXTENSION = 10;

/** Retry resolution events allowed for one run before the reducer refuses another retry. */
export const CONTEXT_RECORDING_RETRY_LIMIT = 3;

export type ContextRecordingResolutionKind =
  | "retry"
  | "proceed_without_manifest"
  | "abort";

export interface ContextRecordingNoteProjection {
  sequence: number;
  purpose: string;
  attempts: number;
  reason: string;
  taskId?: string;
  attempt?: number;
  revision?: string;
  resolution?: {
    sequence: number;
    resolution: ContextRecordingResolutionKind;
    rationale?: string;
    actor: SchedulerActor;
  };
}

export interface ContextRecordingProjection {
  notes: ContextRecordingNoteProjection[];
  waiver?: {
    sequence: number;
    rationale: string;
  };
}

export function latestUnresolvedContextRecordingNote(
  projection: SchedulerProjection,
): ContextRecordingNoteProjection | undefined {
  const notes = projection.contextRecording?.notes ?? [];
  for (let index = notes.length - 1; index >= 0; index -= 1) {
    const note = notes[index];
    if (note && !note.resolution) return note;
  }
  return undefined;
}

/** Retry resolutions still allowed for this run. Matches the reducer budget. */
export function contextRecordingRetriesRemaining(projection: SchedulerProjection): number {
  const used = new Set(
    (projection.contextRecording?.notes ?? []).flatMap((note) =>
      note.resolution?.resolution === "retry" ? [note.resolution.sequence] : [],
    ),
  ).size;
  return Math.max(0, CONTEXT_RECORDING_RETRY_LIMIT - used);
}

function rejectCompletionWhileContextRecordingUnresolved(
  projection: SchedulerProjection,
): void {
  if (latestUnresolvedContextRecordingNote(projection)) {
    throw new Error(
      "Context recording failure must be resolved before completion or handoff.",
    );
  }
}

export interface RepairCyclesProjection {
  limit: number;
  used: number;
  extensions: number;
  /**
   * Owner decision 2026-09-26 ("Scale with tasks"): true when the run cap
   * came from an explicit `repairPlanLimit` option / project policy and must
   * not scale with the ready plan. Absent on rows written before the flag
   * existed; the effective-limit helper infers explicitness there (a stored
   * limit other than the flat default had to be chosen explicitly).
   */
  explicitLimit?: boolean;
  pause?: {
    source: "final_verification" | "verifier";
    targetRevision: string;
    used: number;
    limit: number;
  };
}

export interface RepairIssueProjection {
  issueId: string;
  rootCause: string;
  limit: number;
  used: number;
  hypotheses: string[];
  outcomes: string[];
  approaches: Array<{
    approachId: string;
    repeat: boolean;
    failed: boolean;
    /** T6b repair (R3-B2): true once this decision authorized a dispatch. */
    dispatched: boolean;
    hypothesis: string;
    diagnosticSet: string[];
    evidenceIds: string[];
    failureEvidenceIds: string[];
  }>;
  externalBlocker?: {
    acceptanceCondition: string;
    evidence: string[];
    attemptedResolutions: string[];
    requiredOwnerAction: string;
  };
}

/**
 * T6b (OA-14): durable outcome of the single failing-test rerun for one
 * final-verification check. Keyed `${generationId}:${category}`; the rerun
 * executes at most once per key and the original failing check still blocks
 * acceptance until it passes on its own run.
 */
export interface RepairFlakyProjection {
  category: string;
  generationId: string;
  taskId: string;
  targetRevision: string;
  failingTestIds: string[];
  rerunGreen: boolean;
  rerunEvidenceIds: string[];
  finding: string;
}

/**
 * T6b repair (OA-17): Runner-private durable creation record for one
 * directory or file the runner created outside the workspace. Stored as
 * scheduler events in the Runner-private SQLite store under the runner
 * state directory — never in a shared or worker-writable file — so an
 * executed workload cannot forge ownership (probe F).
 */
export interface TempRecordProjection {
  path: string;
  ownerRunId: string;
  ownerProjectId: string;
  createdAt: string;
  kind: "directory" | "file";
  retained: boolean;
}

/**
 * Durable request-triage decision. T9 owns the triage events that set this;
 * T3a defines the field and the planning-state predicate that reads it.
 * Until T9 lands this is always undefined ("no decision yet"), which counts
 * as planning state.
 */
export type PlanningTriageDecision = "answer" | "build" | "clarify";

/** T9 (EP39): the durable request-triage record for a new-policy run. */
export interface RequestTriageRecord {
  decision: PlanningTriageDecision;
  rationale: string;
  decidedAt: string;
  sequence: number;
  conversions: { from: PlanningTriageDecision; to: PlanningTriageDecision; reason: string; sequence: number }[];
}

/** T9 (EP39): the recorded answer for a triage-`answer` run (latest wins). */
export interface RequestAnswerRecord {
  answerText: string;
  /** Question parts the answer addresses, listed in the same turn. */
  addressedParts: string[];
  evidenceIds: string[];
  recordedAt: string;
  sequence: number;
}

/** T9 (OA-5): per-run user opt-in for the independent answer review. */
export interface AnswerReviewOptInRecord {
  optedInAt: string;
  sequence: number;
}

/** T9 (OA-10 #2): one answer-review finding recorded before any verdict. */
export interface AnswerReviewFinding {
  id: string;
  statement: string;
  severity: "blocking" | "non_blocking";
}

/** T9: the reviewer's own findings, recorded before it may see prior findings. */
export interface AnswerReviewFindingsRecord {
  reviewId: string;
  findings: AnswerReviewFinding[];
  /**
   * T9 repair cycle 2 (N-A): the answer sequence the findings were formed
   * on. Findings are bound to the answer the reviewer saw — a verdict for a
   * later answer needs fresh findings, never a reused record.
   */
  answerSequence: number;
  priorReviewId?: string;
  recordedAt: string;
  sequence: number;
}

/** T9: release of prior findings after the own findings are durable. */
export interface AnswerReviewReleaseRecord {
  reviewId: string;
  priorReviewId: string;
  sequence: number;
}

/** T9: one prior-finding resolution check by a re-review. */
export interface AnswerReviewFindingCheck {
  findingId: string;
  resolution: "resolved" | "outstanding";
  rationale: string;
}

/** T9: a recorded opt-in answer review verdict (advisory evidence). */
export interface AnswerReviewRecord {
  id: string;
  reviewerRuntimeId: string;
  independence: "distinct_model" | "fresh_context";
  answerSequence: number;
  findings: AnswerReviewFinding[];
  summary: string;
  answerAccurate: boolean;
  priorReviewId?: string;
  priorFindingChecks?: AnswerReviewFindingCheck[];
  recordedAt: string;
  sequence: number;
}

/** T9: latest answer-review unavailability gate (owner-visible, retryable). */
export interface AnswerReviewUnavailableRecord {
  reviewId?: string;
  reason: string;
  detail?: string;
  recordedAt: string;
  sequence: number;
}

export interface SchedulerProjection {
  processRecovery?: Record<string, RecoveryAuditRecord>;
  runId: string;
  /** Optional for event-log compatibility with runs created before P3.1. */
  initialObjective?: string;
  runPolicy?: NativeBuildRunPolicy;
  /**
   * C2b run options (CD-5), recorded durably by `run.policy_configured`.
   * Absent on every log written before C2b (and on legacy runs): the
   * accessors below apply the defaults, so old logs replay unchanged.
   */
  specCopy?: boolean;
  handoffFiles?: HandoffFilesOption;
  /**
   * Live scheduler events use running/paused/completed. Terminal historical
   * readers additionally project the authoritative RunSupervisor failed or
   * stopped state without recreating mutable scheduler authority.
   */
  status: "running" | "paused" | "completed" | "failed" | "stopped";
  /** Set when an abort resolution fails the scheduler run. */
  failureReason?: string;
  contextRecording?: ContextRecordingProjection;
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
    detail?: string;
  };
  planRevision: number;
  tasks: Record<string, BuildTask>;
  /** E2 activation is stamped only on fresh runs; old logs retain absent shape. */
  submissionScopePolicyVersion?: 1;
  reviewIntegrityPolicyVersion?: 1;
  encodingSafetyPolicyVersion?: 1;
  guidance: Record<string, GuidanceProjection>;
  userGuidance: Record<string, UserGuidanceItem>;
  userGuidanceVersion: number;
  architectQuestions: Record<string, ArchitectQuestionItem>;
  architectQuestionVersion: number;
  blockingArchitectQuestionId?: string;
  /**
   * T9 repair cycle 1 (N1): sequence of the latest `architect.question_answered`
   * event. Bounds the clarify loop: re-triaging clarify without a user reply
   * after the last triage is refused.
   */
  lastAnsweredArchitectQuestionSequence?: number;
  /**
   * T9 repair cycle 3 (B4-r3/N-C): the latest acknowledgement with resolution
   * `folded_into_planning`, stamped at its event sequence. `plan_ready` is
   * refused while the bound coverage review was requested at or before this
   * sequence, or while no Architect planning turn postdates it; answered-run
   * completion requires an answer recorded after it. Monotonic: only a newer
   * folded acknowledgement replaces it. Copied by the `...current` spread;
   * only the acknowledgement case sets it.
   */
  latestFoldedIntoPlanningAck?: {
    guidanceId: string;
    version: number;
    sequence: number;
  };
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
  repairIssues?: Record<string, RepairIssueProjection>;
  repairFlaky?: Record<string, RepairFlakyProjection>;
  tempRecords?: Record<string, TempRecordProjection>;
  verifier?: VerifierProjection;
  planRiskDeclaration?: {
    risk: PlanRiskLevel;
    rationale?: string;
    source: "architect" | "legacy_default";
  };
  planCritique?: PlanCritiqueState;
  projectHandoff?: ProjectHandoffProjection;
  projectHandoffHistory?: WithdrawnProjectHandoffProjection[];
  projectDocs?: ProjectDocsProjection;
  /**
   * C3b repair cycle 1 (R1-3): every stopped transition in append order,
   * with its stop-time facts. The reducer records one entry per pause-typed
   * event that leaves the run stopped; stop-notes events must link to one
   * of these sequences (validated from these authority facts, never from
   * model-supplied labels). Absent on logs that never stopped.
   */
  stopTransitions?: StopTransitionRecord[];
  /** Set when this run was stamped `project_docs.policy_configured`. Legacy runs omit it. */
  projectDocsPolicyVersion?: number;
  planningPolicyVersion?: 1;
  /**
   * T6a: mandatory deliverable review, integrated-boundary checks, and
   * task/phase acceptance. New-policy runs only; legacy runs omit it.
   */
  delivery?: DeliveryState;
  testIntegrity?: TestIntegrityState;
  planning?: PlanningProjection;
  /** Durable triage decision (T9 `request.triaged`); undefined ("no decision yet") until then. */
  planningTriageDecision?: PlanningTriageDecision;
  /** T9 (EP39): durable triage rationale plus the conversion history. */
  requestTriage?: RequestTriageRecord;
  /** T9 (EP39): the recorded answer for a triage-`answer` run. */
  requestAnswer?: RequestAnswerRecord;
  /** T9 (OA-5): per-run user opt-in for the independent answer review. */
  answerReviewOptIn?: AnswerReviewOptInRecord;
  /** T9: own-findings records by answer review id. */
  answerReviewFindings?: Record<string, AnswerReviewFindingsRecord>;
  /** T9 (OA-10 #2): prior-findings releases by answer review id. */
  answerReviewReleases?: Record<string, AnswerReviewReleaseRecord>;
  /** T9: recorded answer review verdicts by review id. */
  answerReviews?: Record<string, AnswerReviewRecord>;
  /** T9: latest answer-review unavailability gate. */
  answerReviewUnavailable?: AnswerReviewUnavailableRecord;
  /**
   * T3a repair (B1/C): ready-plan binding per scheduler task id, new-policy
   * runs only. Stamped by the reducer when tasks are created (plan.created /
   * plan.reconciled newTasks) with the then-current ready plan identity;
   * admission requires the binding to equal the current ready identity.
   * Legacy runs omit it. Derived from the event log on rebuild.
   */
  readyPlanTaskBindings?: Record<string, ReadyPlanTaskBinding>;
  /** Sequence of the latest integration that advanced the canonical revision. */
  latestIntegratedTaskSequence?: number;
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

/**
 * Owner decision 2026-09-26 ("Scale with tasks"): tasks in the current ready
 * plan revision. Zero when the run has no ready plan (legacy runs never do).
 */
export function readyPlanTaskCount(projection: SchedulerProjection): number {
  const plan = projection.planning?.plan;
  if (projection.planningPolicyVersion !== 1 || !plan) return 0;
  return plan.revisionsById[plan.currentRevisionId]?.tasks.length ?? 0;
}

/**
 * Owner decision 2026-09-26 ("Scale with tasks"): true when the run-level
 * repair-plan limit scales with the ready plan (new-policy runs without an
 * explicit cap). An explicit `repairPlanLimit` wins; legacy runs never scale.
 */
export function repairPlanLimitScales(projection: SchedulerProjection): boolean {
  const cycles = projection.repairCycles;
  if (!cycles || projection.planningPolicyVersion !== 1) return false;
  // Scale only when the runtime recorded the default as non-explicit. Policy
  // rows without the flag were written before the scaled limit existed; they
  // keep their stored flat limit so old logs replay unchanged and an owner
  // extension never shrinks the effective limit (review T6b r5 B-1/B-2).
  return cycles.explicitLimit === false;
}

/**
 * Owner decision 2026-09-26 ("Scale with tasks"): the effective run-level
 * repair-plan limit, derived from durable state at every read so replay is
 * deterministic. New-policy runs without an explicit cap run with
 * 3 + (tasks in the current ready plan) instead of the flat 3: a later plan
 * revision that adds tasks grows the limit, and the stored base already
 * covers extensions and everything consumed, so the value never drops below
 * `used`. Undefined while the run has no repair policy (in-flight pre-P6.5
 * runs stay uncapped).
 */
export function effectiveRepairPlanLimit(projection: SchedulerProjection): number | undefined {
  const cycles = projection.repairCycles;
  if (!cycles) return undefined;
  if (!repairPlanLimitScales(projection)) return cycles.limit;
  return Math.max(cycles.used, cycles.limit + readyPlanTaskCount(projection));
}

export function repairCyclesExhausted(projection: SchedulerProjection): boolean {
  const cycles = projection.repairCycles;
  if (cycles === undefined) return false;
  const effective = effectiveRepairPlanLimit(projection);
  return effective !== undefined && cycles.used >= effective;
}

export function planCritiquePending(projection: SchedulerProjection): boolean {
  const state = projection.planCritique;
  if (!state?.policy || state.policy.mode === "off") return false;
  if (state.skipped) return false;
  if (!state.risk) return true;
  if (!planCritiqueRequired(state.policy.mode, state.risk.assessment)) return false;
  return state.current?.status !== "resolved";
}

/**
 * T3a (OA-7/EP41): kernel predicate over the durable projection. A new-policy
 * run is in planning state while it has no ready plan and its durable triage
 * decision is anything other than `answer` (no decision yet, `build`, or
 * `clarify`). Legacy runs are never in planning state. T9 populates the
 * triage decision and reuses this predicate for the answer path.
 */
export function isPlanningState(projection: SchedulerProjection): boolean {
  if (projection.planningPolicyVersion !== 1) return false;
  if (projection.planning?.readiness === "ready") return false;
  return projection.planningTriageDecision !== "answer";
}

/**
 * T9 (EP39/OA-5): a new-policy run on the answer path. Answered runs complete
 * without a plan, workers, integration, or final verification; the kernel
 * refuses every task, dispatch, integration, and plan-progressing event while
 * this holds. Conversion (`request.converted_to_build`) flips the decision to
 * `build`, which clears this predicate and returns the run to planning state.
 */
export function isAnsweredRun(projection: SchedulerProjection): boolean {
  return projection.planningPolicyVersion === 1 && projection.planningTriageDecision === "answer";
}

/**
 * T9 triage-first ordering: planning events that make plan progress require a
 * durable triage decision of `build`. Source registration/amendment and
 * durable section reads are exempt (provisioning plus read-only inspection
 * the triage and answer turns may use). Everything else — ledger,
 * checkpoints, drafts, revisions, coverage, readiness, assignments,
 * validation, references, acceptance — is refused before triage, under
 * `clarify`, and on the answer path.
 */
const TRIAGE_GATED_PLANNING_EVENTS: ReadonlySet<string> = new Set([
  "planning.ledger_persisted",
  "planning.checkpoint_recorded",
  "planning.plan_drafted",
  "planning.plan_revised",
  "planning.coverage_review_requested",
  "planning.coverage_obligations_recorded",
  "planning.coverage_plan_delivered",
  "planning.coverage_correction_view_recorded",
  "planning.coverage_prior_findings_released",
  "planning.coverage_review_recorded",
  "planning.coverage_review_unavailable",
  "planning.coverage_review_suspended",
  "planning.coverage_review_retry_authorized",
  "planning.plan_ready",
  "planning.assignment_claimed",
  "planning.assignment_released",
  "planning.validation_intent_recorded",
  "planning.validation_observed",
  "planning.validation_interrupted",
  "planning.validation_reconciled",
  "planning.recovery_reconciled",
  "planning.reference_recorded",
  "planning.acceptance_recorded",
  "planning.acceptance_reopened",
  "planning.execution_authorized",
]);

export function hasAnswerReviewVerdict(projection: SchedulerProjection): boolean {
  return projection.answerReviews !== undefined && Object.keys(projection.answerReviews).length > 0;
}

/**
 * T9 repair cycle 1 (B1): the latest recorded answer-review verdict by
 * sequence, regardless of which answer it covers. The pump attaches it as
 * the prior review when a re-review is driven (OA-10 #2 / EP42).
 */
export function latestAnswerReviewVerdict(
  projection: SchedulerProjection,
): AnswerReviewRecord | undefined {
  return Object.values(projection.answerReviews ?? {})
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1);
}

/**
 * T9 repair cycle 1 (B1): the verdict bound to the CURRENT answer — the one
 * the user receives. A verdict for a superseded answer stays durable
 * evidence but never satisfies the opt-in; the pump must re-review the new
 * answer with the prior review attached.
 */
export function currentAnswerReviewVerdict(
  projection: SchedulerProjection,
): AnswerReviewRecord | undefined {
  const answer = projection.requestAnswer;
  if (!answer) return undefined;
  return Object.values(projection.answerReviews ?? {})
    .filter((verdict) => verdict.answerSequence === answer.sequence)
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1);
}

/**
 * T9 repair cycle 1 (B1): the next answer-review id the pump drives —
 * `answer_review_{n}` past every recorded verdict. A findings record without
 * a verdict (crash between passes) keeps its id, so the retry resumes into
 * the verdict pass instead of orphaning the durable own view.
 */
export function nextAnswerReviewId(projection: SchedulerProjection): string {
  let ordinal = Object.keys(projection.answerReviews ?? {}).length + 1;
  while (projection.answerReviews?.[`answer_review_${ordinal}`]) {
    ordinal += 1;
  }
  // T9 repair cycle 2 (N-A): skip an id whose recorded findings were bound
  // to a superseded answer. Findings without a verdict keep their id only
  // while they still describe the current answer (a crash between passes
  // resumes into the verdict pass); once the answer moved on, the next
  // review starts fresh instead of inheriting a stale own view.
  const answerSequence = projection.requestAnswer?.sequence;
  while (
    answerSequence !== undefined &&
    (projection.answerReviewFindings?.[`answer_review_${ordinal}`]?.answerSequence ??
      answerSequence) !== answerSequence
  ) {
    ordinal += 1;
  }
  return `answer_review_${ordinal}`;
}

/**
 * T9 (EP39): completion issues for an answered run, beside (never bypassing)
 * `projectDocumentationReadiness` (G-3). A pure answer still needs the
 * STATE.md docs gate: the capability program's AC-25 requires it even of
 * `plan_only` runs, whose whole product changes nothing in the project.
 */
function answeredRunReadiness(projection: SchedulerProjection): string[] {
  const issues: string[] = [];
  if (!projection.requestAnswer) {
    issues.push("The run answer has not been recorded.");
  }
  const taskCount = Object.keys(projection.tasks).length;
  if (taskCount > 0) {
    issues.push(`Answered runs must not create tasks (found ${taskCount}).`);
  }
  if (projection.integrationRevision?.trim()) {
    issues.push("Answered runs must not advance integration.");
  }
  if (projection.finalVerification) {
    issues.push("Answered runs have no final verification.");
  }
  // T9 repair cycle 3 (N-C): guidance acknowledged as folded_into_planning
  // after the recorded answer is not reflected in that answer. Completion
  // requires a new answer recorded after the acknowledgement, so the folded
  // guidance must be folded into answer text the user actually receives.
  const foldedAnswer = projection.latestFoldedIntoPlanningAck;
  if (
    foldedAnswer &&
    (projection.requestAnswer === undefined ||
      projection.requestAnswer.sequence <= foldedAnswer.sequence)
  ) {
    issues.push(
      `User guidance ${foldedAnswer.guidanceId} acknowledged as folded_into_planning ` +
        "after the recorded answer requires a new answer recorded after the acknowledgement.",
    );
  }
  // T9 repair cycle 1 (B1): the opt-in is satisfied only by a verdict bound
  // to the CURRENT answer. A re-recorded answer after a verdict is not
  // covered by it — the pump must drive a re-review.
  if (projection.answerReviewOptIn && !currentAnswerReviewVerdict(projection)) {
    if (hasAnswerReviewVerdict(projection)) {
      issues.push("The opted-in answer review does not cover the current answer.");
    } else {
      issues.push("The opted-in answer review has not been recorded.");
    }
    const gate = projection.answerReviewUnavailable;
    if (gate) {
      issues.push(`Answer review is unavailable: ${gate.reason}${gate.detail ? ` (${gate.detail})` : ""}.`);
    }
  }
  return issues;
}

/**
 * T9 repair cycle 3 (B4-r3): the folded-guidance readiness block. Guidance
 * acknowledged as `folded_into_planning` must be SEEN by the plan and by the
 * coverage review that makes it ready — otherwise a passing review recorded
 * before the guidance, plus an evidence-free ack, would ready an unchanged
 * plan that never reflects it. Returns the refusal reason, or undefined when
 * no folded acknowledgement exists (legacy and pre-T9 runs are untouched) or
 * when the bound review was requested after the acknowledgement and a new
 * plan revision postdates it too. C4 (AR-R13): the checkpoint tool is gone,
 * so every tool-driven post-fold turn is a plan draft or revision; recorded
 * checkpoint turns still reduce (replay) without a tool behind them.
 * The same gate covers the re-planning window after a ready plan drops back
 * to not-ready: any stale binding or missing post-fold turn refuses again.
 */
function foldedGuidancePlanReadyBlocked(current: SchedulerProjection): string | undefined {
  const folded = current.latestFoldedIntoPlanningAck;
  if (!folded || current.planningPolicyVersion !== 1) return undefined;
  const planning = current.planning;
  const review = planning?.coverageReview;
  if (!review) return undefined;
  const requestedSequence = planning?.coverageRequests[review.id]?.requestedSequence ?? 0;
  if (requestedSequence <= folded.sequence) {
    return `Plan readiness is refused: coverage review ${review.id} was requested before ` +
      `user guidance ${folded.guidanceId} was acknowledged as folded_into_planning; ` +
      "the Architect must request a new coverage review after the acknowledgement " +
      "so the review snapshot contains the guidance.";
  }
  const turnSequence = planning?.lastPlanningTurnSequence ?? 0;
  if (turnSequence <= folded.sequence) {
    // C4 (AR-R13): a new plan revision is the planning-turn proof. The
    // checkpoint tool is gone, so the refusal no longer offers a checkpoint.
    return "Plan readiness is refused: no Architect planning turn (a new plan revision) " +
      `was recorded after user guidance ${folded.guidanceId} ` +
      "was acknowledged as folded_into_planning; draft or revise the plan against " +
      "the guidance, then request a new coverage review.";
  }
  return undefined;
}

export interface ReadyPlanIdentity {
  readonly revisionId: string;
  readonly digest: string;
}

/**
 * T3a (EP32/EP23): the READY plan identity — the ready plan revision digest —
 * or undefined when this run has no ready plan. Worker admission (scheduler
 * and reducer) and plan-only completion both require this identity; a changed
 * source or plan flips the durable readiness back (T2 reducer), which removes
 * the identity until re-readiness. T3b produces the coverage verdict that
 * makes readiness possible; until then this is always undefined.
 */
export function readyPlanIdentity(
  projection: SchedulerProjection,
): ReadyPlanIdentity | undefined {
  if (projection.planningPolicyVersion !== 1) return undefined;
  const planning = projection.planning;
  if (planning?.readiness !== "ready" || !planning.plan) return undefined;
  if (!planning.plan.currentRevisionId || !planning.plan.currentDigest) return undefined;
  return {
    revisionId: planning.plan.currentRevisionId,
    digest: planning.plan.currentDigest,
  };
}

/**
 * T3a repair (B1c): the ready plan identity stamped on a scheduler task at
 * creation time. A task is admitted only while its binding equals the run's
 * current ready plan identity.
 */
export interface ReadyPlanTaskBinding {
  readonly revisionId: string;
  readonly digest: string;
  /**
   * T4 (N-A true membership): the ready-plan contract this scheduler task
   * was bridged from, or the parent contract for kernel-created repair
   * tasks. Absent on bindings stamped before T4 (membership then falls
   * back to the scheduler task id) and on rogue tasks that map to no
   * ready contract.
   */
  readonly contractId?: string;
}

/**
 * T7b (FX-2 review r2 F1): the kernel refuses a stale selection answer. An
 * answer naming a requirement sequence that is not the current pending one
 * never rebinds to the newer offer. A missing sequence keeps the legacy
 * answer path so pre-T7b answers and replays stay readable; the versioned
 * API and the runtime control path always name the requirement.
 */
function assertSelectionAnswerSequence(
  payload: Record<string, unknown>,
  current: number | undefined,
  label: string,
): void {
  const named = payload.requiredSequence;
  if (named === undefined) return;
  if (!Number.isSafeInteger(named) || (named as number) < 1) {
    throw new Error(`${label} answer requiredSequence must be a positive integer event sequence.`);
  }
  if (current !== undefined && named !== current) {
    throw new Error(
      `${label} answer is stale: it names requirement sequence ${named as number}, ` +
      `but the current requirement is sequence ${current}.`,
    );
  }
}

/**
 * T7b: the canonical current-plan authorization identity â€” the ready plan
 * revision and digest, the current source manifest and digest, and the
 * planning and docs policy versions. Undefined when no ready plan (legacy
 * runs and not-ready runs never carry a start identity).
 */
export interface ExplicitStartIdentity {
  readonly planRevisionId: string;
  readonly planDigest: string;
  readonly sourceManifestId: string;
  readonly sourceArtifactDigest: string;
  readonly planningPolicyVersion: 1;
  readonly projectDocsPolicyVersion: number;
}

export function currentExplicitStartIdentity(
  projection: SchedulerProjection,
): ExplicitStartIdentity | undefined {
  if (projection.planningPolicyVersion !== 1) return undefined;
  const planning = projection.planning;
  if (planning?.readiness !== "ready" || !planning.plan) return undefined;
  if (!planning.plan.currentRevisionId || !planning.plan.currentDigest) return undefined;
  if (projection.projectDocsPolicyVersion === undefined) return undefined;
  return {
    planRevisionId: planning.plan.currentRevisionId,
    planDigest: planning.plan.currentDigest,
    sourceManifestId: planning.source.currentManifestId,
    sourceArtifactDigest: planning.source.artifactDigest,
    planningPolicyVersion: 1,
    projectDocsPolicyVersion: projection.projectDocsPolicyVersion,
  };
}

export function explicitStartAuthorizationCovers(
  identity: ExplicitStartIdentity,
  authorization: {
    readonly planRevisionId: string;
    readonly planDigest: string;
    readonly sourceManifestId: string;
    readonly sourceArtifactDigest: string;
    readonly planningPolicyVersion: 1;
    readonly projectDocsPolicyVersion: number;
  },
): boolean {
  return (
    identity.planRevisionId === authorization.planRevisionId &&
    identity.planDigest === authorization.planDigest &&
    identity.sourceManifestId === authorization.sourceManifestId &&
    identity.sourceArtifactDigest === authorization.sourceArtifactDigest &&
    identity.planningPolicyVersion === authorization.planningPolicyVersion &&
    identity.projectDocsPolicyVersion === authorization.projectDocsPolicyVersion
  );
}

/**
 * T7b: the explicit-start block for worker admission. A ready plan alone
 * never authorizes execution: the owner must have authorized THIS current
 * identity. A recorded authorization for a superseded revision, an amended
 * source, or changed policy versions stays durable but covers nothing, so
 * drift while ready refuses dispatch until the owner re-authorizes.
 */
export function explicitStartBlocked(
  projection: SchedulerProjection,
): string | undefined {
  const ready = readyPlanIdentity(projection);
  if (!ready) return undefined;
  const identity = currentExplicitStartIdentity(projection);
  if (!identity) {
    return "Worker admission requires an explicit owner start authorization: the current ready plan has no complete start identity.";
  }
  const authorization = projection.planning?.executionAuthorization;
  if (!authorization || authorization.ownerChoice !== "execute" || authorization.authorizedBy !== "user:local-user") {
    return `Worker admission requires an explicit owner start authorization for the current ready plan revision ${ready.revisionId}.`;
  }
  if (!explicitStartAuthorizationCovers(identity, authorization)) {
    return (
      `The recorded plan start authorization binds plan revision ${authorization.planRevisionId} ` +
      `and source manifest ${authorization.sourceManifestId}; the current ready plan is revision ` +
      `${identity.planRevisionId} with source manifest ${identity.sourceManifestId}. Re-authorize the current plan.`
    );
  }
  return undefined;
}

/**
 * T3a repair (B1c): single source of truth for new-policy worker admission.
 * Returns the blocking reason, or undefined when the task may be admitted.
 * Legacy runs are never blocked here. The `task.transitioned` reducer gate
 * and `TaskScheduler.tick` both use this predicate.
 */
export function newPolicyTaskAdmissionBlocked(
  projection: SchedulerProjection,
  taskId: string,
): string | undefined {
  if (projection.planningPolicyVersion !== 1) return undefined;
  // T9 (EP39/OA-5): answered runs admit no workers, even if a ready plan
  // identity were somehow present — the zero-mutation guarantee is enforced
  // here as well as at task creation, not only in the prompt.
  if (projection.planningTriageDecision === "answer") {
    return "Answered runs admit no workers.";
  }
  if (projection.runPolicy === "plan_only") {
    return "Plan-only runs never admit workers.";
  }
  const ready = readyPlanIdentity(projection);
  if (!ready) {
    return "Worker admission requires a ready plan revision.";
  }
  const binding = projection.readyPlanTaskBindings?.[taskId];
  if (
    !binding ||
    binding.revisionId !== ready.revisionId ||
    binding.digest !== ready.digest
  ) {
    return `Task ${taskId} is not bound to the current ready plan revision ${ready.revisionId}.`;
  }
  // T4 (N-A true membership): kernel-created repair tasks stay admissible
  // while bound to the ready identity (their parent contract is recorded
  // when resolvable); every other task must map to a contract in the
  // CURRENT ready revision. A dropped contract is surfaced to the
  // Architect, never silently lost; a rogue post-ready task is never
  // admitted. Legacy runs never reach here.
  const membership = taskPlanMembership(projection, taskId);
  if (
    projection.tasks[taskId]?.kind === "verification_repair" &&
    binding.contractId === undefined
  ) {
    return undefined;
  }
  if (membership.status === "dropped") {
    return (
      `Task ${taskId} is not admissible: its contract ${membership.contractId} ` +
      `is not in the current ready plan revision ${ready.revisionId}; ` +
      `surfaced to the Architect, never silently lost.`
    );
  }
  if (membership.status === "unmapped") {
    return (
      `Task ${taskId} is not admissible: it does not map to a contract in ` +
      `the current ready plan revision ${ready.revisionId}.`
    );
  }
  return undefined;
}

/**
 * T4 (N-A true membership): where a new-policy scheduler task stands
 * relative to the CURRENT ready plan revision.
 * - `member`: its contract is in the current revision (or, for bindings
 *   stamped before T4 that carry no contract id, its scheduler id is).
 * - `dropped`: its contract was removed by a later revision — the task is
 *   non-admissible and surfaced to the Architect, never silently lost.
 * - `unmapped`: no ready contract (for example a post-ready rogue
 *   `plan_tasks` task) — never admissible.
 * Kernel-created repair tasks carry no revision contract of their own and
 * classify `unmapped` here; admission exempts them explicitly while they
 * stay bound to the ready identity.
 */
export type TaskPlanMembershipStatus = "member" | "dropped" | "unmapped";

export interface TaskPlanMembership {
  readonly status: TaskPlanMembershipStatus;
  readonly contractId?: string;
}

export function taskPlanMembership(
  projection: SchedulerProjection,
  taskId: string,
): TaskPlanMembership {
  const plan = projection.planning?.plan;
  const revision = plan?.revisionsById[plan.currentRevisionId];
  const revisionContractIds = new Set(
    (revision?.tasks ?? []).map((contract) => contract.id),
  );
  const contractId = projection.readyPlanTaskBindings?.[taskId]?.contractId;
  if (contractId !== undefined) {
    return revisionContractIds.has(contractId)
      ? { status: "member", contractId }
      : { status: "dropped", contractId };
  }
  if (
    projection.readyPlanTaskBindings?.[taskId] !== undefined &&
    revisionContractIds.has(taskId)
  ) {
    return { status: "member", contractId: taskId };
  }
  return { status: "unmapped" };
}

/**
 * T4: non-terminal tasks whose contract left the current ready revision.
 * Non-admissible; the pump surfaces them to the Architect through the
 * stale-task wake instead of idling.
 */
export function droppedReadyContractTasks(
  projection: SchedulerProjection,
): string[] {
  return Object.values(projection.tasks)
    .filter(
      (task) =>
        task.kind !== "final_verification" &&
        task.status !== "integrated" &&
        task.status !== "cancelled" &&
        taskPlanMembership(projection, task.id).status === "dropped",
    )
    .map((task) => task.id)
    .sort();
}

/**
 * T4: the ready-plan contract a kernel-created repair task is bound to.
 * Verifier repairs cite their parent task directly; final-verification
 * repairs resolve through their first dependency that maps to a ready
 * contract (repair-of-repair resolves transitively). Undefined when the
 * parent has no contract (legacy-seeded parents) — the repair then stays
 * identity-bound and admissible.
 */
export function repairParentContractId(
  projection: SchedulerProjection,
  task: BuildTask,
): string | undefined {
  const retainedContractId = projection.readyPlanTaskBindings?.[task.id]?.contractId;
  if (retainedContractId !== undefined) return retainedContractId;
  // T6a: a boundary-failure repair cites the integrated task it repairs.
  const verifierParent = task.verifierRepair?.criteria[0]?.taskId ??
    task.deliveryRepair?.sourceTaskId;
  const candidates = verifierParent !== undefined
    ? [verifierParent]
    : task.dependencies;
  for (const parentId of candidates) {
    const parent = projection.tasks[parentId];
    if (!parent) continue;
    if (parent.kind === "verification_repair") {
      const nested = repairParentContractId(projection, parent);
      if (nested !== undefined) return nested;
      continue;
    }
    const membership = taskPlanMembership(projection, parentId);
    if (membership.contractId !== undefined) {
      return membership.contractId;
    }
  }
  return undefined;
}

function schedulerTaskFromContract(
  contract: ExecutionTaskContract,
  ready: ReadyPlanIdentity,
): BuildTask {
  return {
    id: contract.id,
    objective: contract.outcome.user,
    dependencies: [...contract.dependencies],
    status: "planned",
    requiredCapabilities: [],
    acceptanceCriteria: contract.acceptance.criteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
    })),
    acceptanceCriteriaVersion: 1,
    // C5: the authoritative accepted contract reference, stamped by the
    // kernel bridge — never model-authored.
    contractRef: { revisionId: ready.revisionId, digest: ready.digest, taskId: contract.id },
    attempt: 0,
  };
}

/**
 * T4 bridge (carry-forward): when a new-policy plan becomes ready, its
 * task contracts become scheduler tasks through the kernel — one
 * authority, deterministic ids derived from contract ids (the scheduler
 * id IS the contract id), replay-safe (rebuilding the same log
 * materializes the same tasks; pre-existing tasks win and are adopted
 * into membership). Each task carries its contract id in its ready-plan
 * binding. Legacy runs are untouched.
 */
function materializeReadyPlanTasks(projection: SchedulerProjection): void {
  if (projection.planningPolicyVersion !== 1) return;
  const ready = readyPlanIdentity(projection);
  const plan = projection.planning?.plan;
  const revision = plan?.revisionsById[plan.currentRevisionId];
  if (!ready || !revision) return;
  const bindings = { ...(projection.readyPlanTaskBindings ?? {}) };
  const knownIds = new Set(Object.keys(projection.tasks));
  for (const contract of revision.tasks) {
    const missing = contract.dependencies.filter(
      (dependency) =>
        !knownIds.has(dependency) &&
        !revision.tasks.some((candidate) => candidate.id === dependency),
    );
    if (missing.length > 0) {
      throw new Error(
        `Ready plan contract ${contract.id} depends on unknown tasks: ${missing.join(", ")}.`,
      );
    }
    const existing = projection.tasks[contract.id];
    if (existing && existing.kind === "verification_repair") {
      throw new Error(`Ready plan contract ${contract.id} collides with a kernel repair task.`);
    }
    if (!existing) {
      projection.tasks[contract.id] = schedulerTaskFromContract(contract, ready);
      knownIds.add(contract.id);
    } else if (
      existing.status !== "assigned" &&
      existing.status !== "running" &&
      existing.status !== "waiting_guidance" &&
      existing.status !== "integrated" &&
      existing.status !== "cancelled"
    ) {
      projection.tasks[contract.id] = {
        ...existing,
        dependencies: [...contract.dependencies],
      };
    }
    bindings[contract.id] = {
      revisionId: ready.revisionId,
      digest: ready.digest,
      contractId: contract.id,
    };
    // C5: mirror the binding on the task itself, so the authoritative
    // accepted contract reference resolves from durable state —
    // including across re-readiness (bindings are rewritten above).
    projection.tasks[contract.id] = {
      ...projection.tasks[contract.id]!,
      contractRef: { revisionId: ready.revisionId, digest: ready.digest, taskId: contract.id },
    };
  }
  projection.readyPlanTaskBindings = bindings;
  projection.planRevision = Math.max(projection.planRevision, 1);
  if (projection.acceptanceContractStatus !== "legacy_completed") {
    projection.acceptanceContractStatus = acceptanceContractStatusForTasks(
      Object.values(projection.tasks),
    );
  }
}

/**
 * T4: replaces T3a rebind-all rule with true membership. At re-readiness,
 * only tasks whose contract is STILL in the current revision are rebound;
 * a revision that drops a contract leaves that task on its stale binding
 * — non-admissible and surfaced, never silently re-admitted. Repair tasks
 * keep their ready-identity binding (parent contract recorded when
 * resolvable). Pure function of the post-event projection: deterministic
 * and replay-safe.
 */
function rebindMemberTasksToReadyPlan(projection: SchedulerProjection): void {
  if (projection.planningPolicyVersion !== 1) return;
  const ready = readyPlanIdentity(projection);
  if (!ready) return;
  const current = projection.readyPlanTaskBindings;
  if (!current) return;
  let rebound: Record<string, ReadyPlanTaskBinding> | undefined;
  for (const [taskId, task] of Object.entries(projection.tasks)) {
    if (task.status === "integrated" || task.status === "cancelled") continue;
    const binding = current[taskId];
    if (!binding) continue;
    const membershipBeforeRebind = taskPlanMembership(projection, taskId);
    if (binding.revisionId === ready.revisionId && binding.digest === ready.digest) {
      if (binding.contractId !== undefined) continue;
      if (membershipBeforeRebind.status === "unmapped") continue;
      rebound ??= { ...current };
      rebound[taskId] = {
        revisionId: ready.revisionId,
        digest: ready.digest,
        ...(membershipBeforeRebind.contractId !== undefined
          ? { contractId: membershipBeforeRebind.contractId }
          : {}),
      };
      continue;
    }
    if (task.kind === "verification_repair") {
      rebound ??= { ...current };
      const parent = repairParentContractId(projection, task);
      rebound[taskId] = parent !== undefined
        ? { revisionId: ready.revisionId, digest: ready.digest, contractId: parent }
        : { revisionId: ready.revisionId, digest: ready.digest };
      continue;
    }
    if (membershipBeforeRebind.status === "unmapped") continue;
    rebound ??= { ...current };
    rebound[taskId] = {
      revisionId: ready.revisionId,
      digest: ready.digest,
      ...(membershipBeforeRebind.contractId !== undefined
        ? { contractId: membershipBeforeRebind.contractId }
        : {}),
    };
  }
  // C5: mirror refreshed bindings on the tasks so the authoritative
  // contract reference stays current across re-readiness and restart.
  if (rebound) {
    for (const [taskId, binding] of Object.entries(rebound)) {
      const task = projection.tasks[taskId];
      if (!task || binding.contractId === undefined) continue;
      if (
        task.contractRef?.revisionId !== binding.revisionId ||
        task.contractRef?.digest !== binding.digest ||
        task.contractRef?.taskId !== binding.contractId
      ) {
        projection.tasks[taskId] = {
          ...task,
          contractRef: { revisionId: binding.revisionId, digest: binding.digest, taskId: binding.contractId },
        };
      }
    }
    projection.readyPlanTaskBindings = rebound;
  }
}

// ---------------------------------------------------------------------------
// C5 (AR-R15/AR-R16): authoritative task contract reference resolution
// ---------------------------------------------------------------------------

/**
 * C5: where a scheduler task's contract reference stands against the
 * CURRENT authoritative accepted plan revision from durable state.
 * - `current`: the reference resolves to a contract in the current ready revision.
 * - `stale`: the reference names an older ready identity than the current one.
 * - `dropped`: the contract left the current revision — non-admissible, surfaced.
 * - `mismatched`: the task's contractRef contradicts its ready-plan binding.
 * - `unmapped`: no binding and no reference (rogue tasks; repair tasks
 *   without a resolvable parent contract).
 * - `not_ready`: the run has no ready plan identity.
 * - `legacy`: pre-P1 runs carry no plan contracts.
 * Pure function of the projection: deterministic across restart and replay.
 */
export type TaskContractResolution =
  | { readonly status: "current"; readonly ref: TaskContractRef; readonly contract: ExecutionTaskContract }
  | { readonly status: "stale"; readonly ref: TaskContractRef; readonly currentRevisionId: string; readonly currentDigest: string; readonly contract?: ExecutionTaskContract }
  | { readonly status: "dropped"; readonly ref: TaskContractRef }
  | { readonly status: "mismatched"; readonly taskId: string; readonly detail: string }
  | { readonly status: "unmapped"; readonly taskId: string }
  | { readonly status: "not_ready"; readonly taskId: string }
  | { readonly status: "legacy"; readonly taskId: string };

/**
 * C5 bridge: resolves the current authoritative accepted contract
 * revision, digest and task id for a scheduler task from durable state.
 * Direct for bridged tasks; through the parent contract for kernel-created
 * repair tasks. Never invents a contract — every failure mode is explicit.
 * An explicitly supplied ref.taskId that names no current contract fails
 * closed (dropped): parent derivation applies only when the bridge holds
 * no explicit identity, and the returned ref then names the resolved
 * contract.
 */
export function resolveTaskContractReference(
  projection: SchedulerProjection,
  taskId: string,
): TaskContractResolution {
  if (projection.planningPolicyVersion !== 1) return { status: "legacy", taskId };
  const task = projection.tasks[taskId];
  if (!task) return { status: "unmapped", taskId };
  const ready = readyPlanIdentity(projection);
  const plan = projection.planning?.plan;
  const revision = ready ? plan?.revisionsById[ready.revisionId] : undefined;
  if (!ready || !revision) return { status: "not_ready", taskId };
  const binding = projection.readyPlanTaskBindings?.[taskId];
  const ref = task.contractRef;
  if (!binding && !ref) {
    if (task.kind === "verification_repair") {
      const parent = repairParentContractId(projection, task);
      const parentContract = parent !== undefined
        ? revision.tasks.find((contract) => contract.id === parent)
        : undefined;
      if (parent !== undefined && parentContract) {
        return {
          status: "current",
          ref: { revisionId: ready.revisionId, digest: ready.digest, taskId: parent },
          contract: parentContract,
        };
      }
    }
    return { status: "unmapped", taskId };
  }
  if (binding && ref) {
    if (binding.revisionId !== ref.revisionId || binding.digest !== ref.digest) {
      return {
        status: "mismatched",
        taskId,
        detail: `Task ${taskId}'s contractRef (${ref.revisionId}/${ref.digest}) contradicts its ready-plan binding (${binding.revisionId}/${binding.digest}).`,
      };
    }
    if (binding.contractId !== undefined && binding.contractId !== ref.taskId) {
      return {
        status: "mismatched",
        taskId,
        detail: `Task ${taskId}'s contractRef names contract ${ref.taskId} but its ready-plan binding names ${binding.contractId}.`,
      };
    }
  }
  const effective: TaskContractRef = ref ?? {
    revisionId: binding!.revisionId,
    digest: binding!.digest,
    taskId: binding!.contractId ?? taskId,
  };
  if (effective.revisionId !== ready.revisionId || effective.digest !== ready.digest) {
    const survived = revision.tasks.find((contract) => contract.id === effective.taskId);
    return {
      status: "stale",
      ref: effective,
      currentRevisionId: ready.revisionId,
      currentDigest: ready.digest,
      ...(survived ? { contract: survived } : {}),
    };
  }
  // F5: an explicitly supplied ref.taskId names the contract. When it is
  // missing from the current revision the reference fails closed
  // (dropped) — the repair-parent derivation below is legitimate ONLY
  // when the bridge holds no explicit identity, and the returned ref
  // then names the actual resolved contract.
  if (ref) {
    const contract = revision.tasks.find((item) => item.id === effective.taskId);
    if (!contract) return { status: "dropped", ref: effective };
    return { status: "current", ref: effective, contract };
  }
  const direct = revision.tasks.find((item) => item.id === effective.taskId);
  if (direct) return { status: "current", ref: effective, contract: direct };
  if (task.kind === "verification_repair") {
    const parent = repairParentContractOf(projection, revision, task);
    if (parent) {
      return { status: "current", ref: { ...effective, taskId: parent.id }, contract: parent };
    }
  }
  return { status: "dropped", ref: effective };
}

function repairParentContractOf(
  projection: SchedulerProjection,
  revision: ExecutionPlanRevision,
  task: BuildTask,
): ExecutionTaskContract | undefined {
  const parent = repairParentContractId(projection, task);
  return parent !== undefined
    ? revision.tasks.find((contract) => contract.id === parent)
    : undefined;
}

/**
 * C5: pins a contract reference to its exact stored revision — the
 * reviewer's submitted-provenance path. Undefined unless the stored
 * revision's own digest still matches (unchanged historical record).
 */
export function resolveTaskContractAtRef(
  projection: SchedulerProjection,
  ref: TaskContractRef,
): { readonly revision: ExecutionPlanRevision; readonly contract: ExecutionTaskContract } | undefined {
  if (projection.planningPolicyVersion !== 1) return undefined;
  const revision = projection.planning?.plan?.revisionsById[ref.revisionId];
  if (!revision || revision.digest !== ref.digest) return undefined;
  const contract = revision.tasks.find((item) => item.id === ref.taskId);
  if (!contract) return undefined;
  return { revision, contract };
}

/**
 * T3a repair cycle 2 (B2): true when a new-policy run has pending
 * non-terminal work but admission blocks every piece of it — the run would
 * otherwise idle forever with zero Architect calls. The kernel final
 * verification task is never worker-dispatched (the tick skips it), so it
 * never counts as pending here. Legacy runs are never stalled.
 * BuildRuntime.step wakes the Architect (plan_required) instead of idling
 * when this holds after a tick made no progress.
 */
export function newPolicyStaleTasksRequireArchitect(projection: SchedulerProjection): boolean {
  if (projection.planningPolicyVersion !== 1) return false;
  const pending = Object.values(projection.tasks).filter(
    (task) => task.kind !== "final_verification" && task.status !== "integrated" && task.status !== "cancelled",
  );
  if (pending.length === 0) return false;
  return droppedReadyContractTasks(projection).length > 0 ||
    pending.every(
      (task) => newPolicyTaskAdmissionBlocked(projection, task.id) !== undefined,
    );
}

export function consumeRepairCycle(projection: SchedulerProjection): void {
  const cycles = projection.repairCycles;
  if (!cycles) return;
  const effective = effectiveRepairPlanLimit(projection) ?? cycles.limit;
  if (cycles.used >= effective) {
    throw new Error(
      `Repair plan limit reached: ${cycles.used} of ${effective} repair plans used; the user must extend the repair-cycle budget.`,
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
    event.type === "planning.assignment_released" ||
    event.type === "final_verification.cleanup_started" ||
    event.type === "final_verification.cleanup_succeeded" ||
    event.type === "final_verification.cleanup_failed" ||
    (event.type === "project_doc.committed" && event.actor.role === "runner") ||
    (event.type === "project_docs.handoff_snapshot_committed" && event.actor.role === "runner") ||
    (event.type === "project_doc.abandoned" && event.actor.role === "runner") ||
    (event.type === "plan.created" && current.planRevision === 0) ||
    (event.type === "handoff.notes_recorded" && event.actor.role === "architect") ||
    // C3b repair cycle 2: the runner-owned attempt marker and failure
    // outcome link to the same eligible stop as the notes themselves, so
    // they pass this gate under the exact runner actor the runtime uses.
    ((event.type === "handoff.notes_attempted" || event.type === "handoff.notes_failed") &&
      event.actor.role === "runner" &&
      event.actor.id === "build-runtime") ||
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
    event.type === "architect.handoff_selected" ||
    (event.type === "project_doc.committed" && event.actor.role === "runner") ||
    (event.type === "project_docs.handoff_snapshot_committed" && event.actor.role === "runner") ||
    (event.type === "project_doc.abandoned" && event.actor.role === "runner") ||
    event.type === "planning.assignment_released" ||
    (event.type === "handoff.notes_recorded" && event.actor.role === "architect") ||
    // C3b repair cycle 2: the runner-owned attempt marker and failure
    // outcome link to the same eligible stop as the notes themselves, so
    // they pass this gate under the exact runner actor the runtime uses.
    ((event.type === "handoff.notes_attempted" || event.type === "handoff.notes_failed") &&
      event.actor.role === "runner" &&
      event.actor.id === "build-runtime");
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
      // T9 (clarify resume + new-policy question resume, the T3a seam):
      // `plan_required` on a new-policy run is satisfied by the Architect's
      // triage progress or planning progress, not only by the legacy
      // `plan.created` (which never fires there — planRevision stays 0).
      // Legacy runs emit none of the added types, so matching is unchanged
      // for them.
      return event.actor.role === "architect" && (
        event.type === "plan.created" ||
        event.type === "request.triaged" ||
        event.type === "request.answered" ||
        event.type === "request.converted_to_build" ||
        event.type === "planning.source_section_read" ||
        event.type === "planning.ledger_persisted" ||
        event.type === "planning.checkpoint_recorded" ||
        event.type === "planning.plan_drafted" ||
        event.type === "planning.plan_revised" ||
        event.type === "planning.coverage_review_requested"
      );
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
    case "context_recording_decision_required":
      return event.type === "context_manifest.recording_resolved" &&
        (event.actor.role === "architect" || event.actor.role === "user") &&
        event.payload.noteSequence === reason.noteSequence;
    case "delivery_boundary_failed":
      return event.actor.role === "architect" &&
        event.type === "delivery.boundary_failure_resolved" &&
        event.payload.taskId === reason.taskId &&
        event.payload.boundaryId === reason.boundaryId &&
        event.payload.resolutionGeneration === reason.resolutionGeneration;
  }
}

function isArchitectLifecycleEvent(event: SchedulerEvent): boolean {
  return [
    "architect.question_requested",
    "plan.created",
    "request.triaged",
    "request.answered",
    "request.converted_to_build",
    "planning.source_section_read",
    "planning.ledger_persisted",
    "planning.checkpoint_recorded",
    "planning.plan_drafted",
    "planning.plan_revised",
    "planning.coverage_review_requested",
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
    "context_manifest.recording_resolved",
    "delivery.boundary_failure_resolved",
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
    case "context_recording_decision_required":
      return projection.status === "paused" &&
        projection.pauseReason?.reason === "context_recording_failed" &&
        latestUnresolvedContextRecordingNote(projection)?.sequence === reason.noteSequence;
    case "delivery_boundary_failed": {
      const boundary = latestBoundary(projection.delivery, reason.taskId);
      return projection.tasks[reason.taskId]?.status === "integrated" &&
        projection.delivery?.taskAcceptances[reason.taskId] === undefined &&
        boundary?.boundaryId === reason.boundaryId &&
        boundaryNeedsArchitect(boundary, (id) => projection.tasks[id]?.status) &&
        boundaryResolutionGeneration(boundary) === reason.resolutionGeneration &&
        boundary.integrationRevision === reason.integrationRevision &&
        projection.integrationRevision === reason.integrationRevision;
    }
  }
}

/**
 * T6a: a new-policy submission is approved or integrated only after its
 * mandatory deliverable review completed with no open blocking finding and
 * no unverified worker claim (the Architect may dispose of either).
 */
function assertDeliveryReviewAllowsTask(projection: SchedulerProjection, task: BuildTask): void {
  if (projection.planningPolicyVersion !== 1 || task.kind === "final_verification") return;
  const issues = deliveryReviewApprovalIssues(projection.delivery, task);
  if (issues.length > 0) {
    throw new Error(`Deliverable review blocks approval or integration: ${issues.join(" ")}`);
  }
}

/** T6a: completion issues for new-policy delivery acceptance. */
function deliveryCompletionIssues(projection: SchedulerProjection): string[] {
  const issues: string[] = [];
  const plan = projection.planning?.plan;
  const currentRevision = plan?.revisionsById[plan.currentRevisionId];
  if (!currentRevision) {
    issues.push("Delivery acceptance requires the current plan revision.");
    return issues;
  }
  const statuses = new Map(Object.entries(projection.tasks).map(([taskId, task]) => [taskId, task.status]));
  for (const phase of currentRevision.phases) {
    const acceptance = projection.delivery?.phaseAcceptances[
      phaseAcceptanceKey(currentRevision.revisionId, phase.id)
    ];
    if (acceptance) continue;
    issues.push(`Phase ${phase.id} lacks durable acceptance for plan revision ${currentRevision.revisionId}.`);
    // R4-B2: say why, with the exact blocking words.
    issues.push(...evaluatePhaseAcceptance({
      phase,
      requirements: currentRevision.requirements,
      taskStatuses: statuses,
      state: projection.delivery,
      integrationRevision: projection.integrationRevision,
    }).issues);
  }
  const taskStatuses = new Map(Object.entries(projection.tasks).map(([taskId, task]) => [taskId, task.status]));
  issues.push(...finalReadyRequirementIssues(currentRevision.requirements));
  issues.push(...finalReadyCoverageIssues(currentRevision.requirements, taskStatuses));
  for (const task of Object.values(projection.tasks).sort((left, right) => left.id.localeCompare(right.id))) {
    if (task.kind === "final_verification" || task.status === "cancelled") continue;
    if (!projection.delivery?.taskAcceptances[task.id]) {
      issues.push(`Task ${task.id} lacks durable post-integration acceptance.`);
    }
  }
  return issues;
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
    issues.push(...projectDocumentationReadiness(projection));
    if (projection.planningPolicyVersion === 1) {
      // T3a (EP32): a new-policy plan-only run completes only with the READY
      // plan identity. T9 (EP39): a plan_only run given a pure question is
      // answered instead — the answer path completes without a plan. The
      // documentation gate above is unchanged (G-3).
      if (isAnsweredRun(projection)) {
        issues.push(...answeredRunReadiness(projection));
      } else if (!readyPlanIdentity(projection)) {
        issues.push("Plan-only completion requires a ready plan revision (evidence-gated planning is not ready).");
      }
    } else if (projection.planRevision <= 0) {
      issues.push("Plan-only completion requires a valid plan.");
    }
    return { ready: issues.length === 0, issues };
  }

  // T9 (EP39/OA-5): an answered run completes with no plan, no workers, no
  // integration, and no final verification. The documentation gate still
  // applies beside the answer checks (G-3) — see answeredRunReadiness.
  if (isAnsweredRun(projection)) {
    issues.push(...answeredRunReadiness(projection));
    issues.push(...projectDocumentationReadiness(projection));
    return { ready: issues.length === 0, issues };
  }

  // T6a: new-policy final-ready needs every phase accepted for the current
  // plan revision, every ordinary task accepted after its integrated
  // boundary, and no pending/unauthorized requirement.
  if (projection.planningPolicyVersion === 1) {
    issues.push(...deliveryCompletionIssues(projection));
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
    issues.push(...projectDocumentationReadiness(projection));
    return { ready: false, issues };
  }
  if (projection.finalVerification?.history.some((generation) => generation.state === "current")) {
    issues.push("Final-verification history contains a second current generation.");
  }
  if (!revisionMatchesIntegrationOrDocumentTip(projection, current.targetRevision)) {
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
  issues.push(...projectDocumentationReadiness(projection));
  return { ready: issues.length === 0, issues };
}

export function assertBuildCompletionReady(projection: SchedulerProjection): void {
  const readiness = buildCompletionReadiness(projection);
  if (!readiness.ready) {
    throw new Error(`Build completion is not ready: ${readiness.issues.join(" ")}`);
  }
}

function revisionMatchesIntegrationOrDocumentTip(
  projection: SchedulerProjection,
  revision: string,
): boolean {
  return revision === projection.integrationRevision ||
    (projection.projectDocs?.documentTip !== undefined &&
      revision === projection.projectDocs.documentTip);
}

function projectDocumentationReadiness(projection: SchedulerProjection): string[] {
  // Docs v2 (C2a): the kernel snapshot replaces the model-written docs gate.
  if (projection.projectDocsPolicyVersion !== 1) return [];
  const issues: string[] = [];
  const stateCommit = latestProjectStateCommit(projection);
  if (!stateCommit) {
    issues.push("docs/project/STATE.md has not been committed.");
    return issues;
  }
  if (
    projection.runPolicy !== "plan_only" &&
    projection.latestIntegratedTaskSequence !== undefined &&
    stateCommit.sequence <= projection.latestIntegratedTaskSequence
  ) {
    issues.push("docs/project/STATE.md is older than the latest integrated change.");
  }
  if (!stateCommit.readme) {
    issues.push("Project documentation entry point is missing docs/project/README.md.");
  }
  if (!stateCommit.agentsMarkedSection) {
    issues.push("Project documentation entry point is missing the marked AGENTS.md section.");
  }
  if (!stateCommit.claudePointer) {
    issues.push("Project documentation entry point is missing the marked CLAUDE.md pointer.");
  }
  return issues;
}

function latestProjectStateCommit(
  projection: SchedulerProjection,
): ProjectDocCommitProjection | undefined {
  let latest: ProjectDocCommitProjection | undefined;
  for (const commit of projection.projectDocs?.committed ?? []) {
    if (commit.path !== "docs/project/STATE.md") continue;
    if (!latest || commit.sequence > latest.sequence) latest = commit;
  }
  return latest;
}

/**
 * T6a: every command outcome a deliverable review or boundary check records
 * must resolve to durable command evidence in this run, and the last cited
 * command's exit code must be the recorded exit code (exit code governs).
 */
function validateDeliveryCommandEvidence(
  event: SchedulerEvent,
  evidenceStore: EvidenceStore,
): void {
  const commandOutcomes: Array<{ label: string; evidenceIds: string[]; exitCode: unknown }> = [];
  if (event.type === "delivery.findings_recorded") {
    const depth = event.payload.depth;
    if (!isRecord(depth)) return;
    if (isRecord(depth.affectedTests)) {
      commandOutcomes.push({
        label: "affected-test command",
        evidenceIds: stringArray(depth.affectedTests, "evidenceIds"),
        exitCode: depth.affectedTests.exitCode,
      });
    }
    if (isRecord(depth.probe)) {
      commandOutcomes.push({
        label: "OA-11 probe",
        evidenceIds: stringArray(depth.probe, "evidenceIds"),
        exitCode: undefined,
      });
    }
  } else if (Array.isArray(event.payload.checks)) {
    for (const check of event.payload.checks) {
      if (!isRecord(check)) continue;
      commandOutcomes.push({
        label: `boundary check ${String(check.checkId)}`,
        evidenceIds: stringArray(check, "evidenceIds"),
        exitCode: check.checkId === "test_integrity" ? undefined : check.exitCode,
      });
    }
  }
  for (const outcome of commandOutcomes) {
    if (outcome.evidenceIds.length === 0) continue;
    const unique = [...new Set(outcome.evidenceIds)];
    const records = evidenceStore.getByIds({ runId: event.runId, ids: unique });
    if (records.length !== unique.length) {
      throw new Error(`The ${outcome.label} cites missing or foreign evidence.`);
    }
    const byId = new Map(records.map((record) => [record.id, record]));
    for (const id of unique) {
      if (byId.get(id)?.fact.kind !== "command") {
        throw new Error(`The ${outcome.label} evidence ${id} is not command evidence.`);
      }
    }
    if (outcome.exitCode !== undefined) {
      const last = byId.get(outcome.evidenceIds.at(-1)!)!.fact as { exitCode: number | null };
      if (last.exitCode !== outcome.exitCode) {
        throw new Error(`The ${outcome.label} exit code does not match its command evidence.`);
      }
    }
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
  if (event.type === "delivery.test_integrity_baseline_recorded") {
    const evidenceIds = stringArray(event.payload, "evidenceIds");
    const records = evidenceStore.getByIds({ runId: event.runId, ids: evidenceIds });
    const taskId = requiredString(event.payload, "taskId");
    const revision = projection.testIntegrity?.initialRevision;
    const pin = parseTestIntegrityPin(event.payload.pin);
    if (!revision || pin.revision !== revision || evidenceIds.length === 0 || records.length !== evidenceIds.length || records.some((record) =>
      record.fact.kind !== "command" || record.fact.repositoryRevision !== revision ||
      record.fact.exitCode === null || record.fact.timedOut || record.fact.cancelled ||
      record.actor.role !== "verifier" || record.actor.id !== "delivery-check-runtime" ||
      record.taskId !== `delivery:${taskId}` || record.status !== "observed" || !record.idempotencyKey.includes(":initial-tests:"))) {
      throw new Error("Initial test baseline requires its own completed verifier command evidence at the immutable baseline revision.");
    }
    if (event.payload.kind === "no_configured_test_suite") {
      const record = records[0]!;
      if (records.length !== 1 || record.fact.kind !== "command" || record.fact.command !== "git" ||
        !sameValue(record.fact.args, ["ls-tree", "-r", "-z", revision]) || record.fact.exitCode !== 0 ||
        record.fact.outputTruncated || record.fact.outputLossy || record.fact.stdoutArtifactHash !== event.payload.inventoryDigest) {
        throw new Error("Unconfigured baseline requires exact complete Git inventory evidence.");
      }
    }
    return;
  }
  if (event.type === "delivery.findings_recorded" || event.type === "delivery.boundary_checked") {
    validateDeliveryCommandEvidence(event, evidenceStore);
    return;
  }
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
  if (event.type === "delivery.test_integrity_baseline_recorded") {
    if (event.payload.kind === "no_configured_test_suite") return [requiredString(event.payload, "inventoryDigest")];
    const report = event.payload.report;
    return isRecord(report) && typeof report.artifactHash === "string" ? [report.artifactHash] : [];
  }
  // T6a (real counts): the test report a delivery record read must exist as
  // a durable artifact.
  if (event.type === "delivery.findings_recorded" || event.type === "delivery.boundary_checked") {
    const reports: unknown[] = event.type === "delivery.findings_recorded"
      ? [isRecord(event.payload.depth) && isRecord(event.payload.depth.affectedTests) ? event.payload.depth.affectedTests.report : undefined]
      : (Array.isArray(event.payload.checks) ? event.payload.checks : []).map((check) => isRecord(check) ? check.report : undefined);
    return reports.flatMap((report) => isRecord(report) && typeof report.artifactHash === "string" ? [report.artifactHash] : []);
  }
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
      if (event.payload.testIntegrityPolicyVersion !== undefined && (event.actor.role !== "runner" || event.payload.testIntegrityPolicyVersion !== 1)) throw new Error("Invalid test-integrity initialization authority or version.");
      if (event.payload.submissionScopePolicyVersion !== undefined && (event.actor.role !== "runner" || event.payload.submissionScopePolicyVersion !== 1)) throw new Error("Invalid submission-scope initialization authority or version.");
      if (event.payload.reviewIntegrityPolicyVersion !== undefined && (event.actor.role !== "runner" || event.payload.reviewIntegrityPolicyVersion !== 1)) throw new Error("Invalid review-integrity initialization authority or version.");
      if (event.payload.encodingSafetyPolicyVersion !== undefined && (event.actor.role !== "runner" || event.payload.encodingSafetyPolicyVersion !== 1)) throw new Error("Invalid encoding-safety initialization authority or version.");
      return { ...emptySchedulerProjection(event), ...(event.payload.encodingSafetyPolicyVersion === 1 ? { encodingSafetyPolicyVersion: 1 as const } : {}), ...(event.payload.reviewIntegrityPolicyVersion === 1 ? { reviewIntegrityPolicyVersion: 1 as const } : {}), ...(event.payload.submissionScopePolicyVersion === 1 ? { submissionScopePolicyVersion: 1 as const } : {}), ...(event.payload.testIntegrityPolicyVersion === 1 ? { testIntegrity: { version: 1 as const, exceptions: {} } } : {}) };
    }
    if (event.type === "run.policy_configured") {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may configure a scheduler run policy.");
      }
      return {
        ...emptySchedulerProjection(event),
        runPolicy: requiredRunPolicy(event.payload),
        ...parseRunPolicyOptions(event.payload),
      };
    }
    if (event.type === "project_docs.policy_configured") {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may configure project document policy.");
      }
      if (event.payload.version !== 1 && event.payload.version !== 2) {
        throw new Error("Project document policy version is invalid.");
      }
      return {
        ...emptySchedulerProjection(event),
        projectDocsPolicyVersion: event.payload.version === 2 ? 2 : 1,
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
    event.type !== "verifier.expectations_recorded" &&
    event.type !== "plan_critique.submitted" &&
    event.type !== "planning.coverage_obligations_recorded" &&
    event.type !== "planning.coverage_correction_view_recorded" &&
    event.type !== "planning.coverage_review_recorded" &&
    event.type !== "answer.review_findings_recorded" &&
    event.type !== "answer.review_recorded" &&
    event.type !== "delivery.obligations_recorded" &&
    event.type !== "delivery.findings_recorded" &&
    event.type !== "delivery.review_recorded"
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
    ...(current.repairIssues
      ? { repairIssues: cloneRepairIssuesProjection(current.repairIssues) }
      : {}),
    ...(current.repairFlaky
      ? { repairFlaky: Object.fromEntries(Object.entries(current.repairFlaky).map(([key, record]) => [key, { ...record, failingTestIds: [...record.failingTestIds], rerunEvidenceIds: [...record.rerunEvidenceIds] }])) }
      : {}),
    ...(current.tempRecords
      ? { tempRecords: Object.fromEntries(Object.entries(current.tempRecords).map(([key, record]) => [key, { ...record }])) }
      : {}),
    ...(current.contextRecording
      ? { contextRecording: cloneContextRecording(current.contextRecording) }
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
    ...(current.projectDocs
      ? {
          projectDocs: cloneProjectDocs(current.projectDocs),
        }
      : {}),
    ...(current.planning
      ? {
          planning: structuredClone(current.planning),
        }
      : {}),
    // T9: triage/answer single records are always replaced wholesale by
    // their cases; the per-review maps are copied here and extended by copy.
    ...(current.answerReviewFindings
      ? { answerReviewFindings: { ...current.answerReviewFindings } }
      : {}),
    ...(current.answerReviewReleases
      ? { answerReviewReleases: { ...current.answerReviewReleases } }
      : {}),
    ...(current.answerReviews ? { answerReviews: { ...current.answerReviews } } : {}),
    ...(current.delivery ? { delivery: structuredClone(current.delivery) } : {}),
    ...(current.testIntegrity ? { testIntegrity: structuredClone(current.testIntegrity) } : {}),
    runtime: {
      providerHealth: { ...current.runtime.providerHealth },
      workerAssignments: { ...current.runtime.workerAssignments },
      ...(current.runtime.workerAssignmentHistory ? { workerAssignmentHistory: structuredClone(current.runtime.workerAssignmentHistory) } : {}),
      architect: { ...current.runtime.architect },
    },
    lastSequence: event.sequence,
  };
  if (
    current.status === "failed" &&
    (
      event.type === "run.resumed" ||
      event.type === "task.transitioned" ||
      event.type === "worker.runtime_assigned"
    )
  ) {
    throw new Error("A failed Build cannot be resumed or dispatched.");
  }
  if (isPlanningEventType(event.type)) {
    if (["completed", "failed", "stopped"].includes(current.status)) {
      throw new Error("A terminal Build cannot accept planning events.");
    }
    if (next.planningPolicyVersion !== 1) {
      throw new Error("Planning events require a durable planning policy stamp.");
    }
    // T9 triage-first ordering: plan-progressing planning events require a
    // durable triage decision of `build`. Source registration/amendment and
    // durable reads stay available (provisioning plus answer-path inspection).
    if (
      TRIAGE_GATED_PLANNING_EVENTS.has(event.type) &&
      current.planningTriageDecision !== "build"
    ) {
      throw new Error(
        `Planning progress (${event.type}) requires a durable triage decision of build; ` +
          `the current triage decision is ${current.planningTriageDecision ?? "none"}.`
      );
    }
    if (event.type === "planning.plan_ready") {
      // T9 repair cycle 3 (B4-r3): a bound review — or a plan — that predates
      // the latest folded acknowledgement never readies. Checked pre-event on
      // the current projection; the reducer below then decides readiness on
      // the merits.
      const foldedBlocker = foldedGuidancePlanReadyBlocked(current);
      if (foldedBlocker) throw new Error(foldedBlocker);
    }
    if (event.type === "planning.execution_authorized") {
      const authorization = event.payload.authorization as Record<string, unknown> | undefined;
      if (event.actor.role !== "user" || event.actor.id !== "local-user" || current.runPolicy === "plan_only" ||
          authorization?.planningPolicyVersion !== current.planningPolicyVersion || authorization?.projectDocsPolicyVersion !== current.projectDocsPolicyVersion) {
        throw new Error("Plan start refused: owner and current execution policies must match exactly.");
      }
    }
    next.planning = reducePlanningProjection(current.planning, {
      runId: event.runId,
      type: event.type,
      occurredAt: event.occurredAt,
      actor: event.actor,
      idempotencyKey: event.idempotencyKey,
      payload: event.payload,
      sequence: event.sequence,
    }, {
      taskStatuses: new Map(Object.entries(current.tasks).map(([taskId, task]) => [taskId, task.status])),
    });
    if (event.type === "planning.plan_ready") {
      // T4: the bridge materializes the ready revision contracts as
      // scheduler tasks, then true membership rebinds only current
      // members (EP23 still holds for members: blocked only "until
      // re-readiness"; dropped contracts stay non-admissible, surfaced).
      materializeReadyPlanTasks(next);
      rebindMemberTasksToReadyPlan(next);
    }
    return next;
  }
  if (event.type === "planning.policy_configured") {
    if (["completed", "failed", "stopped"].includes(current.status)) {
      throw new Error("A terminal Build cannot configure planning policy.");
    }
    if (event.actor.role !== "runner") {
      throw new Error("Only the runner may configure planning policy.");
    }
    if (
      current.lastSequence > 3 ||
      current.planRevision !== 0 ||
      Object.keys(current.tasks).length > 0 ||
      current.lastArchitectActionEvent !== undefined ||
      Object.keys(current.guidance).length > 0 ||
      Object.keys(current.userGuidance).length > 0 ||
      Object.keys(current.architectQuestions).length > 0 ||
      Object.keys(current.reviews).length > 0 ||
      Object.keys(current.runtime.providerHealth).length > 0 ||
      Object.keys(current.runtime.workerAssignments).length > 0 ||
      current.runtime.architect.runtimeId !== undefined ||
      current.integrationRevision !== undefined ||
      current.finalVerification !== undefined ||
      current.processRecovery !== undefined ||
      current.contextRecording !== undefined
    ) {
      throw new Error("Planning policy can only be configured during run creation.");
    }
    if (event.payload.version !== 1 || Object.keys(event.payload).length !== 1) {
      throw new Error("Planning policy version is invalid.");
    }
    if (next.planningPolicyVersion !== undefined) {
      throw new Error("Planning policy is already configured.");
    }
    next.planningPolicyVersion = 1;
    return next;
  }
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
        next.pauseReason = { reason: EXCEPTIONAL_RECOVERY_PAUSE_REASON };
      }
      break;
    }
    case "run.initialized": {
      if (event.actor.role !== "runner" && event.actor.role !== "user") {
        throw new Error("Only the runner or user may initialize a scheduler run.");
      }
      // The new-run document stamp is sequence 1. run.initialized follows it once.
      if (
        (current.projectDocsPolicyVersion === 1 || current.projectDocsPolicyVersion === 2) &&
        current.lastSequence === 1 &&
        current.planRevision === 0 &&
        current.runPolicy === undefined
      ) {
        const initialObjective = event.payload.objective;
        if (event.payload.encodingSafetyPolicyVersion !== undefined) {
          if (event.actor.role !== "runner" || event.payload.encodingSafetyPolicyVersion !== 1) throw new Error("Invalid encoding-safety initialization authority or version.");
          next.encodingSafetyPolicyVersion = 1;
        }
        if (event.payload.reviewIntegrityPolicyVersion !== undefined) {
          if (event.actor.role !== "runner" || event.payload.reviewIntegrityPolicyVersion !== 1) throw new Error("Invalid review-integrity initialization authority or version.");
          next.reviewIntegrityPolicyVersion = 1;
        }
        if (event.payload.submissionScopePolicyVersion !== undefined) {
          if (event.actor.role !== "runner" || event.payload.submissionScopePolicyVersion !== 1) throw new Error("Invalid submission-scope initialization authority or version.");
          next.submissionScopePolicyVersion = 1;
        }
        if (event.payload.testIntegrityPolicyVersion !== undefined) {
          if (event.actor.role !== "runner" || event.payload.testIntegrityPolicyVersion !== 1) throw new Error("Invalid test-integrity initialization authority or version.");
          next.testIntegrity = { version: 1, exceptions: {} };
        }
        if (typeof initialObjective === "string") next.initialObjective = initialObjective;
        break;
      }
      throw new Error("A scheduler run cannot be initialized twice.");
    }
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
      // C2b (CD-5): the run options ride the run policy additively. A
      // conflicting restamp is refused like a conflicting run policy; logs
      // written before C2b carry neither field and keep the defaults.
      const runOptions = parseRunPolicyOptions(event.payload);
      if (
        runOptions.specCopy !== undefined &&
        next.specCopy !== undefined &&
        next.specCopy !== runOptions.specCopy
      ) {
        throw new Error(
          `Scheduler run specCopy is already configured as ${next.specCopy}.`
        );
      }
      if (
        runOptions.handoffFiles !== undefined &&
        next.handoffFiles !== undefined &&
        next.handoffFiles !== runOptions.handoffFiles
      ) {
        throw new Error(
          `Scheduler run handoffFiles is already configured as ${next.handoffFiles}.`
        );
      }
      if (runOptions.specCopy !== undefined) next.specCopy = runOptions.specCopy;
      if (runOptions.handoffFiles !== undefined) next.handoffFiles = runOptions.handoffFiles;
      break;
    }
    case "request.triaged": {
      if (["completed", "failed", "stopped"].includes(current.status)) {
        throw new Error("A terminal Build cannot record triage.");
      }
      if (current.planningPolicyVersion !== 1) {
        throw new Error("Request triage requires a durable planning policy stamp.");
      }
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may record triage.");
      }
      const triage = parseRequestTriage(event.payload);
      const prior = current.planningTriageDecision;
      // T9 (EP39): triage runs once; only `clarify` re-triages (after the
      // ask_user resume). An answered run converts explicitly to build; a
      // build run never flips back (tasks may already exist — fail closed).
      if (prior === "answer") {
        throw new Error("An answered run cannot be re-triaged; convert to build first.");
      }
      if (prior === "build") {
        throw new Error("A run already triaged to build cannot be re-triaged.");
      }
      // T9 repair cycle 1 (N1): a `clarify` triage must ask the user —
      // re-triaging clarify to clarify without a user reply after the last
      // triage is refused, so the loop is bounded by real user replies.
      if (prior === "clarify" && triage.decision === "clarify") {
        const lastTriage = current.requestTriage?.sequence ?? 0;
        const answeredAfterTriage = (current.lastAnsweredArchitectQuestionSequence ?? 0) > lastTriage;
        if (!answeredAfterTriage) {
          throw new Error(
            "A clarify triage must ask the user: re-triaging clarify without an answered user reply is refused."
          );
        }
      }
      next.planningTriageDecision = triage.decision;
      next.requestTriage = {
        decision: triage.decision,
        rationale: triage.rationale,
        decidedAt: event.occurredAt,
        sequence: event.sequence,
        conversions: current.requestTriage ? [...current.requestTriage.conversions] : [],
      };
      break;
    }
    case "request.answered": {
      if (["completed", "failed", "stopped"].includes(current.status)) {
        throw new Error("A terminal Build cannot record an answer.");
      }
      if (current.planningPolicyVersion !== 1) {
        throw new Error("Request answers require a durable planning policy stamp.");
      }
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may record an answer.");
      }
      if (current.planningTriageDecision !== "answer") {
        throw new Error("An answer requires a durable triage decision of answer.");
      }
      const answer = parseRequestAnswer(event.payload);
      next.requestAnswer = {
        answerText: answer.answerText,
        addressedParts: answer.addressedParts,
        evidenceIds: answer.evidenceIds,
        recordedAt: event.occurredAt,
        sequence: event.sequence,
      };
      break;
    }
    case "request.converted_to_build": {
      if (["completed", "failed", "stopped"].includes(current.status)) {
        throw new Error("A terminal Build cannot convert to build.");
      }
      if (current.planningPolicyVersion !== 1) {
        throw new Error("Conversion to build requires a durable planning policy stamp.");
      }
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may convert to build.");
      }
      // T9 (EP39): explicit durable conversion when answering discovers a
      // needed change. Afterwards the run follows the normal planning flow:
      // the decision flips to `build`, so the run is in planning state again.
      if (current.planningTriageDecision !== "answer") {
        throw new Error("Only an answered run converts to build.");
      }
      assertExactTriageKeys(event.payload, ["reason"]);
      const reason = requiredNonBlank(event.payload, "reason");
      const priorRecord = current.requestTriage;
      next.planningTriageDecision = "build";
      next.requestTriage = {
        decision: "build",
        rationale: priorRecord?.rationale ?? "",
        decidedAt: priorRecord?.decidedAt ?? event.occurredAt,
        sequence: priorRecord?.sequence ?? event.sequence,
        conversions: [
          ...(priorRecord?.conversions ?? []),
          { from: "answer", to: "build", reason, sequence: event.sequence },
        ],
      };
      break;
    }
    case "answer.review_opted_in": {
      if (["completed", "failed", "stopped"].includes(current.status)) {
        throw new Error("A terminal Build cannot opt in to answer review.");
      }
      if (current.planningPolicyVersion !== 1) {
        throw new Error("Answer review opt-in requires a durable planning policy stamp.");
      }
      if (event.actor.role !== "user") {
        throw new Error("Only the user may opt in to answer review.");
      }
      // T9 repair cycle 1 (B2): the opt-in is accepted on any non-terminal
      // new-policy run — including at creation, before triage exists. The
      // review runs only if and when the run is answered; on build runs the
      // opt-in stays inert. A terminal run and a duplicate opt-in stay refused.
      if (current.answerReviewOptIn) {
        throw new Error("Answer review is already opted in for this run.");
      }
      assertExactTriageKeys(event.payload, []);
      next.answerReviewOptIn = { optedInAt: event.occurredAt, sequence: event.sequence };
      break;
    }
    case "answer.review_opted_out": {
      if (["completed", "failed", "stopped"].includes(current.status)) {
        throw new Error("A terminal Build cannot opt out of answer review.");
      }
      if (current.planningPolicyVersion !== 1) {
        throw new Error("Answer review opt-out requires a durable planning policy stamp.");
      }
      if (event.actor.role !== "user") {
        throw new Error("Only the user may opt out of answer review.");
      }
      // T9 repair cycle 1 (N2): the owner can withdraw the opt-in, so an
      // unavailable reviewer never traps the run. Withdrawing clears the
      // pending unavailability gate (the owner resolved it); the events stay
      // durable history. A later opt-in starts clean, never stale-gated.
      if (!current.answerReviewOptIn) {
        throw new Error("Answer review is not opted in for this run.");
      }
      assertExactTriageKeys(event.payload, []);
      next.answerReviewOptIn = undefined;
      next.answerReviewUnavailable = undefined;
      break;
    }
    case "answer.review_findings_recorded": {
      if (["completed", "failed", "stopped"].includes(current.status)) {
        throw new Error("A terminal Build cannot record answer review findings.");
      }
      if (current.planningPolicyVersion !== 1) {
        throw new Error("Answer review findings require a durable planning policy stamp.");
      }
      if (event.actor.role !== "verifier") {
        throw new Error("Only the answer reviewer may record findings.");
      }
      if (current.planningTriageDecision !== "answer") {
        throw new Error("Answer review findings require a triage decision of answer.");
      }
      // T9 opt-in-only (OA-5): no opt-in, no review — refused here, not only
      // by the runtime driver.
      if (!current.answerReviewOptIn) {
        throw new Error("Answer review findings require the user's opt-in for this run.");
      }
      if (!current.requestAnswer) {
        throw new Error("Answer review findings require a recorded answer.");
      }
      const findings = parseAnswerReviewFindings(event.payload);
      if (current.answerReviewFindings?.[findings.reviewId]) {
        throw new Error(`Answer review ${findings.reviewId} already recorded findings.`);
      }
      if (
        findings.priorReviewId !== undefined &&
        !current.answerReviews?.[findings.priorReviewId]
      ) {
        throw new Error(
          `Answer review ${findings.reviewId} references an unknown prior review ${findings.priorReviewId}.`
        );
      }
      next.answerReviewFindings = {
        ...(current.answerReviewFindings ?? {}),
        [findings.reviewId]: {
          reviewId: findings.reviewId,
          findings: findings.findings,
          // T9 repair cycle 2 (N-A): bind the findings to the answer the
          // reviewer saw. Stamped by the kernel from the current answer, not
          // the payload, so it cannot be forged.
          answerSequence: current.requestAnswer!.sequence,
          ...(findings.priorReviewId !== undefined ? { priorReviewId: findings.priorReviewId } : {}),
          recordedAt: event.occurredAt,
          sequence: event.sequence,
        },
      };
      next.answerReviewUnavailable = undefined;
      break;
    }
    case "answer.review_prior_findings_released": {
      if (["completed", "failed", "stopped"].includes(current.status)) {
        throw new Error("A terminal Build cannot release prior answer findings.");
      }
      if (current.planningPolicyVersion !== 1) {
        throw new Error("Answer review releases require a durable planning policy stamp.");
      }
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may release prior answer findings.");
      }
      assertExactTriageKeys(event.payload, ["reviewId", "priorReviewId"]);
      const reviewId = requiredNonBlank(event.payload, "reviewId");
      const priorReviewId = requiredNonBlank(event.payload, "priorReviewId");
      // T9 (OA-10 #2): a re-review records its own view of the answer before
      // it may see another reviewer's findings on it.
      const recorded = current.answerReviewFindings?.[reviewId];
      if (!recorded || recorded.priorReviewId !== priorReviewId) {
        throw new Error(
          `Answer review ${reviewId} must record its own findings before prior findings are released.`
        );
      }
      if (current.answerReviewReleases?.[reviewId]) {
        throw new Error(`Answer review ${reviewId} already released prior findings.`);
      }
      next.answerReviewReleases = {
        ...(current.answerReviewReleases ?? {}),
        [reviewId]: { reviewId, priorReviewId, sequence: event.sequence },
      };
      break;
    }
    case "answer.review_recorded": {
      if (["completed", "failed", "stopped"].includes(current.status)) {
        throw new Error("A terminal Build cannot record an answer review.");
      }
      if (current.planningPolicyVersion !== 1) {
        throw new Error("Answer reviews require a durable planning policy stamp.");
      }
      if (event.actor.role !== "verifier") {
        throw new Error("Only the answer reviewer may record a verdict.");
      }
      if (current.planningTriageDecision !== "answer") {
        throw new Error("Answer reviews require a triage decision of answer.");
      }
      if (!current.answerReviewOptIn) {
        throw new Error("Answer reviews require the user's opt-in for this run.");
      }
      if (!current.requestAnswer) {
        throw new Error("Answer reviews require a recorded answer.");
      }
      const review = parseAnswerReview(event.payload);
      if (current.answerReviews?.[review.id]) {
        throw new Error(`Answer review ${review.id} is already recorded.`);
      }
      // Record-before-verdict (the RG-6 device, reused): the verdict's
      // findings must equal the durably recorded own findings — no swap
      // between the findings pass and the verdict pass.
      const recorded = current.answerReviewFindings?.[review.id];
      if (!recorded) {
        throw new Error(`Answer review ${review.id} has no durably recorded findings.`);
      }
      if (!sameValue(recorded.findings, review.findings)) {
        throw new Error(`Answer review ${review.id} verdict findings differ from its recorded findings.`);
      }
      // T9 repair cycle 2 (N-A): the verdict judges the CURRENT answer, and
      // the findings behind it were formed on that same answer. A verdict
      // stamped with another answer's sequence, or findings reused across a
      // re-answer, are refused here — not only by the review driver.
      if (review.answerSequence !== current.requestAnswer!.sequence) {
        throw new Error(
          `Answer review ${review.id} verdict binds answer sequence ${review.answerSequence}, not the current answer ${current.requestAnswer!.sequence}.`
        );
      }
      if (recorded.answerSequence !== current.requestAnswer!.sequence) {
        throw new Error(
          `Answer review ${review.id} findings were recorded for superseded answer sequence ${recorded.answerSequence}, not the current answer ${current.requestAnswer!.sequence}.`
        );
      }
      if ((recorded.priorReviewId ?? undefined) !== (review.priorReviewId ?? undefined)) {
        throw new Error(`Answer review ${review.id} verdict drops or changes its prior review binding.`);
      }
      if (review.priorReviewId !== undefined) {
        const release = current.answerReviewReleases?.[review.id];
        if (!release || release.priorReviewId !== review.priorReviewId) {
          throw new Error(
            `Answer review ${review.id} must release prior findings before its verdict.`
          );
        }
        const prior = current.answerReviews?.[review.priorReviewId];
        if (!prior) {
          throw new Error(
            `Answer review ${review.id} references an unknown prior review ${review.priorReviewId}.`
          );
        }
        // OA-10 #2: the re-review checks each prior finding exactly once.
        const checks = review.priorFindingChecks ?? [];
        const priorIds = prior.findings.map((finding) => finding.id).sort();
        const checkIds = checks.map((check) => check.findingId).sort();
        if (!sameValue(priorIds, checkIds) || new Set(checkIds).size !== checkIds.length) {
          throw new Error(
            `Answer review ${review.id} must check each prior finding exactly once.`
          );
        }
      } else if (review.priorFindingChecks !== undefined && review.priorFindingChecks.length > 0) {
        throw new Error(`Answer review ${review.id} checks findings without a prior review.`);
      }
      next.answerReviews = {
        ...(current.answerReviews ?? {}),
        [review.id]: {
          id: review.id,
          reviewerRuntimeId: review.reviewerRuntimeId,
          independence: review.independence,
          answerSequence: review.answerSequence,
          findings: review.findings,
          summary: review.summary,
          answerAccurate: review.answerAccurate,
          ...(review.priorReviewId !== undefined ? { priorReviewId: review.priorReviewId } : {}),
          ...(review.priorFindingChecks !== undefined ? { priorFindingChecks: review.priorFindingChecks } : {}),
          recordedAt: event.occurredAt,
          sequence: event.sequence,
        },
      };
      next.answerReviewUnavailable = undefined;
      break;
    }
    case "answer.review_unavailable": {
      if (["completed", "failed", "stopped"].includes(current.status)) {
        throw new Error("A terminal Build cannot record answer review unavailability.");
      }
      if (current.planningPolicyVersion !== 1) {
        throw new Error("Answer review unavailability requires a durable planning policy stamp.");
      }
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may record answer review unavailability.");
      }
      if (current.planningTriageDecision !== "answer") {
        throw new Error("Answer review unavailability requires a triage decision of answer.");
      }
      if (!current.answerReviewOptIn) {
        throw new Error("Answer review unavailability requires the user's opt-in for this run.");
      }
      assertExactTriageKeys(event.payload, ["reviewId", "reason", "detail"]);
      const detail = event.payload.detail;
      if (detail !== undefined && (typeof detail !== "string" || !detail.trim())) {
        throw new Error("Answer review unavailability detail is invalid.");
      }
      const reviewId = event.payload.reviewId;
      if (reviewId !== undefined && (typeof reviewId !== "string" || !reviewId.trim())) {
        throw new Error("Answer review unavailability reviewId is invalid.");
      }
      next.answerReviewUnavailable = {
        ...(typeof reviewId === "string" ? { reviewId } : {}),
        reason: requiredNonBlank(event.payload, "reason"),
        ...(typeof detail === "string" ? { detail } : {}),
        recordedAt: event.occurredAt,
        sequence: event.sequence,
      };
      break;
    }
    case "plan.created": {
      const readyForLegacyOverlay = current.planningPolicyVersion === 1
        ? readyPlanIdentity(current)
        : undefined;
      if (
        !readyForLegacyOverlay &&
        (current.planRevision !== 0 || Object.keys(current.tasks).length > 0)
      ) {
        throw new Error("A scheduler run cannot create a second initial plan.");
      }
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may create a plan.");
      }
      // T9 (EP39/OA-5): answered runs create no tasks — refused here even
      // before the readiness gate, so the zero-mutation guarantee never
      // depends on planning state. Legacy runs are untouched.
      if (current.planningPolicyVersion === 1 && current.planningTriageDecision === "answer") {
        throw new Error(
          "Answered runs cannot create tasks; convert to build first."
        );
      }
      // T3a repair (B1a): on a new-policy run, scheduler tasks materialise
      // only from a ready plan — which is necessarily after the ledger — so a
      // legacy plan_tasks call before readiness is refused. Legacy runs are
      // untouched.
      const planReady = readyForLegacyOverlay;
      if (current.planningPolicyVersion === 1 && !planReady) {
        throw new Error(
          "Scheduler tasks on a new-policy run require a ready plan revision."
        );
      }
      const tasks = event.payload.tasks as BuildTask[];
      if (planReady) {
        const currentContractIds = new Set(
          current.planning!.plan!.revisionsById[
            current.planning!.plan!.currentRevisionId
          ].tasks.map((contract) => contract.id),
        );
        const reusedContract = tasks.find((task) => currentContractIds.has(task.id));
        if (reusedContract) {
          throw new Error(
            `Plan task ${reusedContract.id} reuses a bridged ready-plan contract id.`,
          );
        }
        if (tasks.some((task) => task.status === "integrated")) {
          throw new Error(
            "A direct plan event cannot set a task to integrated.",
          );
        }
      }
      const validation = validateTaskGraph(tasks);
      if (!validation.valid) {
        throw new Error(
          `Plan has mechanical issues: ${validation.issues.map((issue) => issue.code).join(", ")}.`
        );
      }
      next.planRevision = requiredNumber(event.payload, "revision");
      if (!planReady) {
        next.tasks = Object.fromEntries(tasks.map((task) => [task.id, cloneBuildTask(task)]));
      } else {
        const bridged = { ...current.tasks };
        for (const task of tasks) {
          if (!bridged[task.id]) bridged[task.id] = cloneBuildTask(task);
        }
        next.tasks = bridged;
      }
      if (planReady) {
        // T3a repair (B1c): bind every created task to the ready plan that
        // authorised it. Admission compares this stamp to the current ready
        // identity, so tasks from a superseded revision are never admitted.
        // T4: tasks mapping to a ready contract carry it; rogue tasks stay
        // identity-bound and non-admissible (true membership).
        const plan = current.planning?.plan;
        const revision = plan?.revisionsById[plan.currentRevisionId];
        const memberIds = new Set(
          (revision?.tasks ?? []).map((contract) => contract.id),
        );
        const bindings = { ...current.readyPlanTaskBindings };
        for (const task of tasks) {
          bindings[task.id] = {
            revisionId: planReady.revisionId,
            digest: planReady.digest,
            ...(memberIds.has(task.id) ? { contractId: task.id } : {}),
          };
        }
        next.readyPlanTaskBindings = bindings;
      }
      next.acceptanceContractStatus = acceptanceContractStatusForTasks(
        Object.values(next.tasks),
      );
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
      // T9 (EP39/OA-5): answered runs revise nothing.
      if (current.planningPolicyVersion === 1 && current.planningTriageDecision === "answer") {
        throw new Error(
          "Answered runs cannot upgrade the acceptance contract; convert to build first."
        );
      }
      // T3a repair (B1a): task-revising events on a new-policy run require a
      // ready plan. Legacy runs are untouched.
      if (current.planningPolicyVersion === 1 && !readyPlanIdentity(current)) {
        throw new Error(
          "Acceptance-contract upgrade on a new-policy run requires a ready plan revision."
        );
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
      // T9 (EP39/OA-5): answered runs never integrate. This is the only gate
      // on this event, so it is load-bearing for the zero-mutation proof.
      if (current.planningPolicyVersion === 1 && current.planningTriageDecision === "answer") {
        throw new Error(
          "Answered runs cannot advance integration; convert to build first."
        );
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
      // T9 (EP39/OA-5): answered runs have no final verification.
      if (current.planningPolicyVersion === 1 && current.planningTriageDecision === "answer") {
        throw new Error(
          "Answered runs have no final verification; convert to build first."
        );
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
      assertSelectionAnswerSequence(event.payload, selection.requiredSequence, "Verifier selection");
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
    case "verifier.expectations_recorded": {
      if (event.actor.role !== "verifier") {
        throw new Error("Only the selected verifier may record expectations.");
      }
      recordVerifierExpectations(next, event);
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
      const explicit = event.payload.explicit;
      if (explicit !== undefined && typeof explicit !== "boolean") {
        throw new Error("repairPlanLimit explicit flag must be a boolean.");
      }
      const explicitLimit = explicit === true ? true : explicit === false ? false : undefined;
      if (current.repairCycles &&
        (current.repairCycles.limit !== limit ||
          (current.repairCycles.explicitLimit ?? false) !== (explicitLimit ?? false))) {
        throw new Error("Repair policy is already configured differently.");
      }
      next.repairCycles = current.repairCycles ?? {
        limit: limit as number,
        used: 0,
        extensions: 0,
        ...(explicitLimit !== undefined ? { explicitLimit } : {}),
      };
      break;
    }
    case "repair.issue_recorded": {
      if (event.actor.role !== "runner") throw new Error("Only the runner may record a repair issue.");
      const issueId = requiredString(event.payload, "issueId");
      const rootCause = requiredString(event.payload, "rootCause");
      const limit = requiredPositiveInteger(event.payload, "limit");
      const issues = { ...(next.repairIssues ?? {}) };
      const existing = issues[issueId];
      if (existing && (existing.rootCause !== rootCause || existing.limit !== limit)) {
        throw new Error("Repair issue identity or allowance conflicts with its durable record.");
      }
      issues[issueId] ??= { issueId, rootCause, limit, used: 0, hypotheses: [], outcomes: [], approaches: [] };
      next.repairIssues = issues;
      break;
    }
    case "repair.approach_decided": {
      if (event.actor.role !== "architect") throw new Error("Only the Architect may decide a repair approach.");
      const issueId = requiredString(event.payload, "issueId");
      const issue = next.repairIssues?.[issueId];
      if (!issue) throw new Error("Repair approach requires its durable issue.");
      const approachId = requiredString(event.payload, "approachId");
      const repeat = event.payload.repeat === true;
      const hypothesis = requiredString(event.payload, "hypothesis");
      const diagnosticSet = stringArray(event.payload, "diagnosticSet");
      const evidenceIds = stringArray(event.payload, "evidenceIds");
      const prior = issue.approaches.find((entry) => entry.approachId === approachId);
      const known = new Set(issue.approaches.flatMap((entry) => entry.diagnosticSet));
      const decided = new Set(issue.approaches.flatMap((entry) => entry.evidenceIds));
      const failedEvidence = new Set(issue.approaches.flatMap((entry) => entry.failureEvidenceIds ?? []));
      const excluded = new Set([...known, ...decided, ...failedEvidence]);
      const superseded = issue.approaches.at(-1);
      if (superseded && !superseded.failed) superseded.failed = true;
      if (!repeat && prior?.failed) {
        throw new Error("A failed repair approach cannot be relabelled or resubmitted without an explicit repeat and new evidence.");
      }
      if (prior?.failed || repeat) {
        if (evidenceIds.some((id) => failedEvidence.has(id))) {
          throw new Error("A repeated repair approach must not cite the failure's own evidence.");
        }
        if (!evidenceIds.some((id) => !excluded.has(id))) {
          throw new Error("A repeated failed repair approach requires evidence NEW to its diagnostic set.");
        }
      }
      if (prior && !sameValue(prior.diagnosticSet, diagnosticSet) && !prior.failed) {
        throw new Error("A prior repair approach's diagnostic set is immutable.");
      }
      if (prior && repeat && sameValue(prior.evidenceIds, evidenceIds)) {
        throw new Error("Replaying reused evidence cannot authorize a repeated failed approach.");
      }
      // T6b repair (R2-B3): with prior approaches a new decision needs NON-EMPTY evidence outside every prior excluded set.
      if (issue.approaches.length > 0 && !evidenceIds.some((id) => !excluded.has(id))) {
        throw new Error("A renamed repair approach with identical evidence cannot pass as a new approach; empty evidence never passes.");
      }
      // T6b repair (R2-B3): a new id with a failed approach's hypothesis and diagnostic set is a relabel.
      if (issue.approaches.length > 0 && issue.approaches.some((entry) =>
        entry.failed &&
        entry.hypothesis === hypothesis &&
        entry.diagnosticSet.length === diagnosticSet.length &&
        entry.diagnosticSet.every((id) => diagnosticSet.includes(id)))) {
        throw new Error("A new repair approach id with a failed approach's hypothesis and diagnostic set is a relabel, not a new approach.");
      }
      issue.approaches.push({ approachId, repeat, failed: false, dispatched: false, hypothesis, diagnosticSet, evidenceIds, failureEvidenceIds: [] });
      break;
    }
    case "repair.cycle_recorded": {
      if (event.actor.role !== "runner") throw new Error("Only the runner may record a charged repair cycle.");
      const issueId = requiredString(event.payload, "issueId");
      const issue = next.repairIssues?.[issueId];
      if (!issue) throw new Error("Repair cycle requires its durable issue.");
      const hypothesis = requiredString(event.payload, "hypothesis");
      const outcome = requiredString(event.payload, "outcome");
      const evidenceIds = stringArray(event.payload, "evidenceIds");
      if (evidenceIds.length === 0) throw new Error("A repair cycle requires evidence.");
      if (issue.externalBlocker) throw new Error("A proven external blocker does not consume futile attempts.");
      // T6b repair (B5): an approach-bound cycle dispatched repair tasks,
      // so it is always substantive no matter the hypothesis label.
      // The diagnostic exemption covers approach-free investigations only.
      if (event.payload.approachId === undefined && isDiagnosticRepairCycle(hypothesis, outcome)) {
        issue.hypotheses.push(hypothesis);
        issue.outcomes.push(outcome);
        break;
      }
      if (outcome === "resolved" && event.payload.approachId !== undefined) {
        const resolvedId = requiredString(event.payload, "approachId");
        const resolved = issue.approaches.at(-1);
        if (!resolved || resolved.approachId !== resolvedId) throw new Error("Repair cycle must follow its recorded approach decision.");
        resolved.failed = false;
        issue.hypotheses.push(hypothesis);
        issue.outcomes.push(outcome);
        break;
      }
      if (issue.used >= issue.limit) throw new Error("Issue repair budget is exhausted.");
      issue.used += 1;
      issue.hypotheses.push(hypothesis);
      issue.outcomes.push(outcome);
      if (event.payload.approachId === undefined) break;
      const approachId = requiredString(event.payload, "approachId");
      const approach = issue.approaches.at(-1);
      if (!approach || approach.approachId !== approachId) throw new Error("Repair cycle must follow its recorded approach decision.");
      // T6b repair (R3-B2): a decision authorizes exactly one dispatch;
      // the consumption is marked here in the kernel, durably.
      if (outcome === "dispatched") approach.dispatched = true;
      approach.failed = outcome !== "resolved" && outcome !== "dispatched";
      if (approach.failed) {
        const knownFailure = new Set(approach.failureEvidenceIds ?? []);
        for (const id of evidenceIds) {
          if (!knownFailure.has(id)) {
            approach.failureEvidenceIds.push(id);
            knownFailure.add(id);
          }
        }
      }
      break;
    }
    case "repair.approach_failed": {
      if (event.actor.role !== "runner") throw new Error("Only the runner may record a failed repair approach.");
      const issueId = requiredString(event.payload, "issueId");
      const issue = next.repairIssues?.[issueId];
      if (!issue) throw new Error("Failed repair approach requires its durable issue.");
      const approachId = requiredString(event.payload, "approachId");
      const approach = issue.approaches.at(-1);
      if (!approach || approach.approachId !== approachId) throw new Error("Failed repair approach must follow its recorded approach decision.");
      // T6b repair (R3-B2): a dispatched repair whose next validation
      // failed is durably failed here. No cycle is charged (an
      // observation is not an attempt) and no failure evidence is
      // absorbed, so the next decision still cites fresh evidence; a
      // repeat of the same approach still needs evidence NEW to its sets.
      if (approach.failed) break;
      if (!approach.dispatched) throw new Error("Only a dispatched repair approach fails on its next validation.");
      approach.failed = true;
      break;
    }
    case "repair.flaky_isolated": {
      if (event.actor.role !== "runner") throw new Error("Only the runner may record flaky isolation.");
      const category = requiredString(event.payload, "category");
      const generationId = requiredString(event.payload, "generationId");
      const taskId = requiredString(event.payload, "taskId");
      const targetRevision = requiredString(event.payload, "targetRevision");
      const failingTestIds = stringArray(event.payload, "failingTestIds");
      if (failingTestIds.length === 0 && !(event.payload.rerunGreen === false && typeof event.payload.finding === "string" && (event.payload.finding as string).startsWith("not_performed"))) throw new Error("Flaky isolation requires the first run's failing test ids, or a not_performed finding when no test ids exist to narrow.");
      if (typeof event.payload.rerunGreen !== "boolean") throw new Error("Flaky isolation requires the rerun result.");
      const rerunEvidenceIds = stringArray(event.payload, "rerunEvidenceIds");
      const finding = requiredString(event.payload, "finding");
      const key = `${generationId}:${category}`;
      const record = { category, generationId, taskId, targetRevision, failingTestIds: [...failingTestIds], rerunGreen: event.payload.rerunGreen as boolean, rerunEvidenceIds: [...rerunEvidenceIds], finding };
      const existing = next.repairFlaky?.[key];
      if (existing) {
        if (!sameValue(existing, record)) throw new Error(`Flaky isolation for ${key} conflicts with its durable record.`);
        break;
      }
      next.repairFlaky = { ...(next.repairFlaky ?? {}), [key]: record };
      break;
    }
    case "repair.external_blocker_recorded": {
      if (event.actor.role !== "architect") throw new Error("Only the Architect may record an external blocker.");
      const issueId = requiredString(event.payload, "issueId");
      const issue = next.repairIssues?.[issueId];
      if (!issue) throw new Error("External blocker requires its durable issue.");
      const acceptanceCondition = requiredString(event.payload, "acceptanceCondition");
      const evidence = stringArray(event.payload, "evidence");
      const attemptedResolutions = stringArray(event.payload, "attemptedResolutions");
      const requiredOwnerAction = requiredString(event.payload, "requiredOwnerAction");
      if (evidence.length === 0 || attemptedResolutions.length === 0) {
        throw new Error("A blocker record requires evidence and attempted resolutions.");
      }
      if (issue.externalBlocker) throw new Error("This repair issue already has an external blocker.");
      issue.externalBlocker = { acceptanceCondition, evidence, attemptedResolutions, requiredOwnerAction };
      break;
    }
    case "repair.issue_budget_extended": {
      if (event.actor.role !== "user") throw new Error("Issue-budget extension requires the owner.");
      const issueId = requiredString(event.payload, "issueId");
      const issue = next.repairIssues?.[issueId];
      if (!issue) throw new Error("Issue-budget extension requires its durable issue.");
      const additional = event.payload.additionalCycles;
      if (!Number.isSafeInteger(additional) || (additional as number) < 1 || (additional as number) > MAX_REPAIR_CYCLE_EXTENSION) {
        throw new Error(`additionalCycles must be an integer between 1 and ${MAX_REPAIR_CYCLE_EXTENSION}.`);
      }
      issue.limit += additional as number;
      if (current.pauseReason?.reason === `repair_issue_paused:${issueId}`) {
        next.status = "running";
        delete next.pauseReason;
      }
      break;
    }
    case "repair.issue_paused": {
      if (event.actor.role !== "runner") throw new Error("Only the runner may pause on a repair issue.");
      const issueId = requiredString(event.payload, "issueId");
      const issue = next.repairIssues?.[issueId];
      if (!issue) throw new Error("Repair-issue pause requires its durable issue.");
      const cause = requiredString(event.payload, "cause");
      if (cause !== "budget_exhausted" && cause !== "external_blocker" && cause !== "approach_failed") {
        throw new Error("Repair-issue pause cause is invalid.");
      }
      const detail = requiredString(event.payload, "detail");
      next.status = "paused";
      next.pauseReason = { reason: `repair_issue_paused:${issueId}`, detail: `repair:${cause}:${detail}` };
      break;
    }
    case "repair.external_blocker_cleared": {
      if (event.actor.role !== "user") throw new Error("External-blocker clearance requires the owner.");
      const issueId = requiredString(event.payload, "issueId");
      const issue = next.repairIssues?.[issueId];
      if (!issue) throw new Error("External-blocker clearance requires its durable issue.");
      if (!issue.externalBlocker) throw new Error("This repair issue has no external blocker to clear.");
      delete issue.externalBlocker;
      if (current.pauseReason?.reason === `repair_issue_paused:${issueId}`) {
        next.status = "running";
        delete next.pauseReason;
      }
      break;
    }
    case "temp.creation_recorded": {
      if (event.actor.role !== "runner") throw new Error("Only the runner may record temp creation.");
      const path = requiredString(event.payload, "path");
      const ownerRunId = requiredString(event.payload, "ownerRunId");
      const ownerProjectId = requiredString(event.payload, "ownerProjectId");
      const createdAt = requiredString(event.payload, "createdAt");
      const kind: "directory" | "file" | undefined = event.payload.kind === "directory" ? "directory" : event.payload.kind === "file" ? "file" : undefined;
      if (!kind) throw new Error("Temp creation kind is invalid.");
      const retained = event.payload.retained === true;
      const key = createHash("sha256").update(path).digest("hex").slice(0, 24);
      const records = { ...(next.tempRecords ?? {}) };
      const existing = records[key];
      const record = { path, ownerRunId, ownerProjectId, createdAt, kind, retained: (existing?.retained ?? false) || retained };
      if (existing && (existing.path !== path || existing.ownerRunId !== ownerRunId || existing.ownerProjectId !== ownerProjectId || existing.kind !== kind)) {
        throw new Error("Temp creation record conflicts with its durable record.");
      }
      records[key] = existing ?? record;
      if (existing && retained && !existing.retained) records[key] = record;
      next.tempRecords = records;
      break;
    }
    case "temp.record_cleared": {
      if (event.actor.role !== "runner") throw new Error("Only the runner may clear temp records.");
      const path = requiredString(event.payload, "path");
      const key = createHash("sha256").update(path).digest("hex").slice(0, 24);
      if (next.tempRecords?.[key]) {
        const records = { ...next.tempRecords };
        delete records[key];
        next.tempRecords = records;
      }
      break;
    }
    case "cleanup.checked": {
      if (event.actor.role !== "runner") throw new Error("Only the runner may record cleanup searches.");
      const trigger = requiredString(event.payload, "trigger");
      if (trigger !== "task_attempt" && trigger !== "verification") {
        throw new Error("Cleanup search trigger is invalid.");
      }
      if (!Array.isArray(event.payload.findings)) {
        throw new Error("Cleanup search requires findings.");
      }
      for (const finding of event.payload.findings as Record<string, unknown>[]) {
        const ownership = finding.ownership;
        const action = finding.action;
        if (ownership !== "proven" && ownership !== "unproven") throw new Error("Cleanup ownership must be proven or unproven.");
        if (ownership === "unproven" && action !== "retained") throw new Error("Unproven cleanup ownership must retain the resource.");
        if (action !== "cleaned" && action !== "retained") throw new Error("Cleanup action is invalid.");
      }
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
      const effective = effectiveRepairPlanLimit(current) ?? cycles.limit;
      if (used !== cycles.used || limit !== effective || used < effective) {
        throw new Error("Repair-cycle limit event does not match the kernel repair-cycle count.");
      }
      next.repairCycles = {
        ...cycles,
        pause: { source, targetRevision: requiredString(event.payload, "targetRevision"), used, limit },
      };
      next.status = "paused";
      next.pauseReason = {
        reason: "repair_cycle_limit",
        ...(current.planningPolicyVersion === 1
          ? { detail: `Run-level repair-plan budget exhausted: used ${used} of ${effective} repair plans${repairPlanLimitScales(current) ? ` (scales as 3 + ${readyPlanTaskCount(current)} ready-plan tasks)` : " (explicit cap)"}; the user must extend the repair-cycle budget.` }
          : {}),
      };
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
        ...(cycles.explicitLimit !== undefined ? { explicitLimit: cycles.explicitLimit } : {}),
      };
      next.status = "running";
      delete next.pauseReason;
      break;
    }
    case "task.revised": {
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may revise a task.");
      }
      // T3a repair (B1a): task-revising events on a new-policy run require a
      // ready plan. The task keeps its original ready-plan binding (fail
      // closed): a revision is not a re-review. Legacy runs are untouched.
      // T9 (EP39/OA-5): answered runs revise nothing.
      if (current.planningPolicyVersion === 1 && current.planningTriageDecision === "answer") {
        throw new Error(
          "Answered runs cannot revise tasks; convert to build first."
        );
      }
      if (current.planningPolicyVersion === 1 && !readyPlanIdentity(current)) {
        throw new Error(
          "Task revision on a new-policy run requires a ready plan revision."
        );
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
      const revisionMembership = taskPlanMembership(current, taskId);
      const revisionContract = revisionMembership.contractId
        ? current.planning?.plan?.revisionsById[current.planning.plan.currentRevisionId]?.tasks.find((candidate) => candidate.id === revisionMembership.contractId)
        : undefined;
      assertContractTaskRevisionAllowed({
        taskId,
        patch: {
          ...(Object.hasOwn(patch, "dependencies") ? { dependencies: patch.dependencies } : {}),
          ...(Object.hasOwn(patch, "acceptanceCriteria") ? { acceptanceCriteria: patch.acceptanceCriteria } : {}),
          ...(Object.hasOwn(patch, "requiredCapabilities") ? { requiredCapabilities: patch.requiredCapabilities } : {}),
        },
        ...(revisionContract ? { contract: revisionContract } : {}),
      });
      if (
        task.kind === "verification_repair" &&
        (
          Object.hasOwn(patch, "verificationRepair") ||
          Object.hasOwn(patch, "verifierRepair") ||
          Object.hasOwn(patch, "deliveryRepair") ||
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
      assertTransitionAuthority(status, event.actor);
      if (status === "integrating") assertDeliveryReviewAllowsTask(current, task);
      if (
        current.planningPolicyVersion === 1 &&
        (status === "assigned" || status === "running")
      ) {
        // T3a (EP32/EP23) + repair (B1c): direct-event worker admission for a
        // new-policy run requires the READY plan identity AND that the task
        // be bound to that exact ready revision; plan-only runs never admit
        // workers. Legacy runs are untouched.
        const blocked = newPolicyTaskAdmissionBlocked(current, taskId);
        if (blocked) {
          throw new Error(blocked);
        }
      }
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
        { ...((event.payload.patch as Partial<BuildTask> | undefined) ?? {}) };
      if (transitionPatch.submissionScope !== undefined && (status !== "submitted" || current.submissionScopePolicyVersion !== 1)) throw new Error("Submission scope records apply only to activated submissions.");
      if (status === "submitted" && current.submissionScopePolicyVersion === 1) {
        if (event.actor.role !== "runner" || event.actor.id !== "scheduler") throw new Error("Activated submission requires the trusted scheduler actor.");
        transitionPatch.submissionScope = validateSubmissionScopeRecord(current, taskId, requiredString(transitionPatch as Record<string, unknown>, "changeSetId"), transitionPatch.submissionScope);
      }
      if (transitionPatch.reviewSignals !== undefined && (status !== "submitted" || current.reviewIntegrityPolicyVersion !== 1)) throw new Error("Review signals apply only to activated submissions.");
      if (transitionPatch.encodingSubmission !== undefined && (status !== "submitted" || current.encodingSafetyPolicyVersion !== 1)) throw new Error("Encoding facts apply only to activated submissions.");
      if (status === "submitted" && current.encodingSafetyPolicyVersion === 1) {
        if (event.actor.role !== "runner" || event.actor.id !== "scheduler" || !task.workspaceBaselineRevision) throw new Error("Encoding submission requires the trusted scheduler and baseline.");
        transitionPatch.encodingSubmission = validateEncodingSubmission(transitionPatch.encodingSubmission, { runId: current.runId, taskId, baselineRevision: task.workspaceBaselineRevision, changeSetId: requiredString(transitionPatch as Record<string, unknown>, "changeSetId") });
        if (transitionPatch.reviewSignals && transitionPatch.encodingSubmission.taskRevision !== transitionPatch.reviewSignals.taskRevision || transitionPatch.submissionScope && transitionPatch.encodingSubmission.taskRevision !== transitionPatch.submissionScope.taskRevision) throw new Error("Encoding and other submission revisions differ.");
      }
      if (status === "submitted" && current.reviewIntegrityPolicyVersion === 1) {
        if (event.actor.role !== "runner" || event.actor.id !== "scheduler" || !task.workspaceBaselineRevision) throw new Error("Review-integrity submission requires the trusted scheduler and baseline.");
        transitionPatch.reviewSignals = validateReviewSignals(transitionPatch.reviewSignals, { runId: current.runId, taskId, baselineRevision: task.workspaceBaselineRevision, changeSetId: requiredString(transitionPatch as Record<string, unknown>, "changeSetId") });
        if (transitionPatch.submissionScope && transitionPatch.reviewSignals.taskRevision !== transitionPatch.submissionScope.taskRevision) throw new Error("Submission guard revisions differ.");
      }
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
          const before = next.integrationRevision;
          advanceIntegrationRevision(next, integrationRevision);
          if (next.integrationRevision !== before) {
            if (next.projectDocs?.documentTip) {
              const { documentTip: _tip, ...remaining } = next.projectDocs;
              next.projectDocs = remaining;
            }
            if (next.projectDocsPolicyVersion === 1 || next.projectDocsPolicyVersion === 2) {
              next.latestIntegratedTaskSequence = event.sequence;
            }
          }
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
          : acknowledgement.resolution.type === "folded_into_planning"
            ? acceptFoldedIntoPlanningAcknowledgement(current, acknowledgement.resolution)
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
      if (resolution.type === "folded_into_planning") {
        // T9 repair cycle 3 (B4-r3/N-C): stamp the latest fold durably. The
        // readiness gates (plan_ready, answered completion) compare against
        // this sequence.
        next.latestFoldedIntoPlanningAck = {
          guidanceId: acknowledgement.guidanceId,
          version: guidance.version,
          sequence: event.sequence,
        };
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
      // T9 repair cycle 1 (N1): the clarify-loop bound reads this.
      next.lastAnsweredArchitectQuestionSequence = event.sequence;
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
      // T6a (B7): the Architect disposes of open blocking findings and
      // unverified claims independently; approval then needs neither left.
      applyDeliveryDispositions(next, task, event);
      if (decision === "approved") assertDeliveryReviewAllowsTask(next, task);
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
          ...(typeof event.payload.detail === "string" && event.payload.detail
            ? { detail: event.payload.detail }
            : {}),
        };
      } else {
        delete next.pauseReason;
      }
      break;
    case "run.resumed":
      if (recoveryBlocksRun(current.processRecovery)) throw new Error("Unresolved exceptional recovery prevents resume.");
      if (
        current.pauseReason?.reason === "context_recording_failed" &&
        latestUnresolvedContextRecordingNote(current)
      ) {
        throw new Error("Context recording failure must be resolved before the run can resume.");
      }
      next.status = "running";
      delete next.pauseReason;
      break;
    case "run.completed":
      rejectCompletionWhileContextRecordingUnresolved(current);
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
      assertHandoffSnapshotGate(current, current.integrationRevision);
      next.status = "completed";
      if (current.acceptanceContractStatus === "acceptance_contract_upgrade_required") {
        next.acceptanceContractStatus = "legacy_completed";
      }
      delete next.pauseReason;
      break;
    case "project.handoff_requested": {
      rejectCompletionWhileContextRecordingUnresolved(current);
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may request final project handoff.");
      }
      if (current.projectHandoff) {
        throw new Error("Final project handoff was already requested.");
      }
      if (current.runPolicy === "plan_only") {
        if (current.planningPolicyVersion === 1) {
          // T9 (EP39): a plan_only run given a pure question is answered —
          // the answer path completes without the ready plan identity.
          if (!readyPlanIdentity(current) && !isAnsweredRun(current)) {
            throw new Error("Plan-only final project handoff requires a ready plan revision.");
          }
        } else if (current.planRevision <= 0) {
          throw new Error("Plan-only final project handoff requires a valid plan.");
        }
        assertBuildCompletionReady(current);
      } else {
        assertBuildCompletionReady(current);
      }
      next.projectHandoff = {
        status: "requested",
        summary: requiredString(event.payload, "summary"),
        requestedSequence: event.sequence,
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
      if (current.projectHandoff?.status !== "requested") {
        throw new Error("Final project handoff is not awaiting user selection.");
      }
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
      // C2b repair m6: the kernel acceptance for a selection is the one
      // shared predicate -- the whole rule, same as the manager pre-check
      // applies before any project mutation.
      assertProjectHandoffSelectionAccepted(current, selectedIntegrationRevision);
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
        ...(current.reviewIntegrityPolicyVersion === 1 ? { modelIdentity: canonicalIdentity(event.payload, "modelIdentity") } : {}),
      };
      if (current.reviewIntegrityPolicyVersion === 1) {
        if (event.actor.id !== "runtime-router" || task.status !== "running") throw new Error("Review-integrity assignments require the trusted runtime router and running attempt.");
        const history = next.runtime.workerAssignmentHistory ?? {};
        const key = `${taskId}:${attempt}`;
        const assignment = next.runtime.workerAssignments[key]!;
        const existing = history[key] ?? [];
        if (existing.some((entry) => entry.runtimeId === assignment.runtimeId && entry.modelIdentity !== assignment.modelIdentity)) throw new Error("An attempt runtime model identity cannot change.");
        history[key] = [...existing, { ...assignment }];
        next.runtime.workerAssignmentHistory = history;
      }
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
      assertSelectionAnswerSequence(event.payload, handoff.requiredSequence, "Architect handoff selection");
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
    case "context_manifest.recording_failed": {
      applyContextRecordingFailed(next, event);
      break;
    }
    case "context_manifest.recording_resolved": {
      applyContextRecordingResolved(next, event);
      break;
    }
    case "project_doc.requested": {
      applyProjectDocRequested(next, event);
      break;
    }
    case "project_doc.committed": {
      applyProjectDocCommitted(next, event);
      break;
    }
    case "project_docs.handoff_snapshot_committed": {
      applyHandoffSnapshotCommitted(next, event);
      break;
    }
    case "handoff.notes_recorded": {
      applyHandoffNotesRecorded(next, event);
      break;
    }
    case "handoff.notes_attempted": {
      applyHandoffNotesAttempted(next, event);
      break;
    }
    case "handoff.notes_failed": {
      applyHandoffNotesFailed(next, event);
      break;
    }
    case "project_docs.stop_snapshot_skipped": {
      applyStopSnapshotSkipped(next, event);
      break;
    }
    case "project_doc.abandoned": {
      applyProjectDocAbandoned(next, event);
      break;
    }
    case "delivery.test_integrity_initialized":
    case "delivery.test_integrity_baseline_recorded":
    case "delivery.test_integrity_exception_recorded":
      reduceTestIntegrityEvent(current, next, event);
      break;
    case "delivery.review_started":
    case "delivery.review_requested":
    case "delivery.obligations_recorded":
    case "delivery.criteria_and_diff_delivered":
    case "delivery.findings_recorded":
    case "delivery.report_delivered":
    case "delivery.review_recorded":
    case "delivery.boundary_started":
    case "delivery.boundary_checked":
    case "delivery.boundary_failure_resolved":
    case "task.acceptance_recorded":
    case "phase.acceptance_recorded":
      reduceDeliveryEvent(current, next, event);
      break;
    case "project_docs.policy_configured": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may configure project document policy.");
      }
      if (event.payload.version !== 1 && event.payload.version !== 2) {
        throw new Error("Project document policy version is invalid.");
      }
      if (
        next.projectDocsPolicyVersion !== undefined &&
        next.projectDocsPolicyVersion !== event.payload.version
      ) {
        throw new Error("Project document policy is already configured differently.");
      }
      // C2b repair CD-14: the reducer does NOT enforce the docs-v2 /
      // planning-v1 pairing -- T7a remains the only owner of production
      // stamping and stamps both together at creation (CD-1). A docs-v2 run
      // without a plan revision hands off the integration revision (or the
      // recorded baseline) instead of pausing forever (N6, closed in the
      // runtime, not here). Legacy-planning runs keep docs v1 unchanged.
      next.projectDocsPolicyVersion = event.payload.version === 2 ? 2 : 1;
      break;
    }
  }
  // C3b repair cycle 1 (R1-3): record every stopped transition with its
  // stop-time facts, so stop-notes events link to an existing actual stop.
  // Additive and replay-deterministic: derived purely from the event log,
  // so old logs replay unchanged and no stored branch changes meaning.
  if (
    isStopTransitionEventType(event.type) &&
    (next.status === "paused" || next.status === "failed" || next.status === "stopped")
  ) {
    next.stopTransitions = [
      ...(current.stopTransitions ?? []),
      {
        sequence: event.sequence,
        type: event.type,
        status: next.status,
        ...(next.pauseReason?.reason !== undefined ? { reason: next.pauseReason.reason } : {}),
        ...(next.pauseReason?.detail !== undefined ? { detail: next.pauseReason.detail } : {}),
        ownerInitiated: event.actor.role === "user",
        ...(next.planningTriageDecision !== undefined ? { triage: next.planningTriageDecision } : {}),
        ...(next.handoffFiles !== undefined ? { handoffFiles: next.handoffFiles } : {}),
      },
    ];
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
  const twoPass = payload.twoPass;
  if (twoPass !== undefined && typeof twoPass !== "boolean") {
    throw new Error("Independent verifier two-pass policy must be a boolean.");
  }
  return {
    mode: "risk_based",
    candidateRuntimeIds,
    // Events written before P4.6 had only risk-based candidate selection.
    alwaysRequireIndependentVerifier: strict === true,
    // Events written before P6.5 had no two-pass field and stay single-pass.
    twoPass: twoPass === true,
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

function recordVerifierExpectations(
  projection: SchedulerProjection,
  event: SchedulerEvent,
): void {
  const current = projection.verifier?.current;
  if (!current || current.status !== "requested" || current.state !== "current") {
    throw new Error("Verifier expectations require a current requested review.");
  }
  if (current.twoPass !== true) {
    throw new Error("Verifier expectations require a two-pass review.");
  }
  if (event.actor.id !== current.runtime.runtimeId) {
    throw new Error(
      "Verifier expectations actor does not match the selected runtime identity.",
    );
  }
  const reviewId = requiredString(event.payload, "reviewId");
  const targetRevision = requiredString(event.payload, "targetRevision");
  const baselineRevision = requiredString(event.payload, "baselineRevision");
  const sessionId = requiredString(event.payload, "sessionId");
  if (reviewId !== current.reviewId) {
    throw new Error("Verifier expectations are stale or foreign to the current review.");
  }
  if (targetRevision !== current.targetRevision) {
    throw new Error("Verifier expectations are stale or foreign to the current review.");
  }
  if (baselineRevision !== current.baselineRevision) {
    throw new Error("Verifier expectations are stale or foreign to the current review.");
  }
  const expectations = parseVerifierExpectations(
    event.payload.expectations,
    current.criteria,
  );
  if (current.expectations) {
    if (
      current.expectationsSessionId === sessionId &&
      sameValue(current.expectations, expectations)
    ) {
      return;
    }
    throw new Error("Verifier expectations conflict with the recorded expectations.");
  }
  current.expectations = expectations;
  current.expectationsSessionId = sessionId;
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
  if (current.twoPass === true && !current.expectations) {
    throw new Error("Two-pass verifier verdict requires recorded expectations.");
  }
  const verdict = parseVerifierVerdict(event.payload, current, occurredAt);
  if (current.twoPass === true) {
    for (const criterionVerdict of verdict.criterionVerdicts) {
      if (
        criterionVerdict.verdict === "unsatisfied" &&
        !(criterionVerdict.reproduction && criterionVerdict.reproduction.length > 0)
      ) {
        throw new Error("Two-pass unsatisfied verdicts require reproduction steps.");
      }
    }
  }
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
  // T3a repair cycle 2 (B3): repair tasks are ordinary worker tasks, so on
  // a new-policy run they are planned only under a ready plan (like every
  // other task-adding path) and stamped with its identity below. Checked
  // before the repair cycle is consumed so a refusal spends nothing.
  // T9 (EP39/OA-5): answered runs plan no repairs. Checked before the
  // budget is consumed, like the readiness refusal below.
  if (projection.planningPolicyVersion === 1 && projection.planningTriageDecision === "answer") {
    throw new Error(
      "Answered runs cannot plan repairs; convert to build first."
    );
  }
  // Legacy runs are untouched.
  const repairReady = projection.planningPolicyVersion === 1
    ? readyPlanIdentity(projection)
    : undefined;
  if (projection.planningPolicyVersion === 1 && !repairReady) {
    throw new Error(
      "Verifier repairs on a new-policy run require a ready plan revision."
    );
  }
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
  if (repairReady) {
    // T4: kernel-created repairs stay admissible under the ready plan;
    // the parent contract is recorded when resolvable, otherwise the
    // repair stays identity-bound (legacy-seeded parents).
    const bindings = { ...projection.readyPlanTaskBindings };
    for (const task of tasks) {
      const parent = repairParentContractId(projection, task);
      bindings[task.id] = parent !== undefined
        ? { revisionId: repairReady.revisionId, digest: repairReady.digest, contractId: parent }
        : { revisionId: repairReady.revisionId, digest: repairReady.digest };
    }
    projection.readyPlanTaskBindings = bindings;
  }
  current.repairTaskIds = tasks.map((task) => task.id);
  projection.planRevision = revision;
}

// ---------------------------------------------------------------------------
// T6a: mandatory deliverable review and post-integration acceptance kernel.
// The pure record shapes and shared rules live in delivery-acceptance.ts.
// ---------------------------------------------------------------------------

function parseTestIntegrityPin(value: unknown): TestIntegrityPin {
  if (!isRecord(value) || !Array.isArray(value.commands) || !/^[a-f0-9]{64}$/.test(requiredString(value, "configDigest"))) throw new Error("Test-integrity pin is invalid.");
  return { revision: requiredString(value, "revision"), configDigest: requiredString(value, "configDigest"),
    ...(typeof value.script === "string" ? { script: value.script } : {}),
    ...(typeof value.hasTestSignals === "boolean" ? { hasTestSignals: value.hasTestSignals } : {}),
    commands: value.commands.map((command) => {
      if (!isRecord(command)) throw new Error("Test-integrity command is invalid.");
      return { executable: requiredString(command, "executable"), args: stringArray(command, "args") };
    }) };
}

function parseTestConsolidation(value: unknown): TestConsolidationDisposition {
  if (!isRecord(value) || (value.disposition !== "obsolete" && value.disposition !== "merged")) throw new Error("Test consolidation requires an obsolete or merged disposition.");
  const allowedChanges = stringArray(value, "allowedChanges");
  if (allowedChanges.length === 0 || allowedChanges.some((code) => !["test_command_changed", "test_config_changed", "suite_shrank"].includes(code))) throw new Error("Test consolidation must specify permitted changes.");
  const affectedTestIds = stringArray(value, "affectedTestIds");
  if (affectedTestIds.length === 0) throw new Error("Test consolidation must identify affected tests.");
  const planDigest = requiredString(value, "planDigest"); const baselinePinDigest = requiredString(value, "baselinePinDigest"); const candidatePinDigest = requiredString(value, "candidatePinDigest");
  if (![planDigest, baselinePinDigest, candidatePinDigest].every((digest) => /^[a-f0-9]{64}$/.test(digest))) throw new Error("Test consolidation fingerprints are invalid.");
  return { id: requiredString(value, "id"), disposition: value.disposition, affectedTestIds,
    behaviorProof: requiredString(value, "behaviorProof"), reason: requiredString(value, "reason"),
    planRevisionId: requiredString(value, "planRevisionId"), planDigest, baselinePinDigest, candidatePinDigest,
    allowedChanges: allowedChanges as TestConsolidationDisposition["allowedChanges"], minimumExecuted: requiredPositiveInteger(value, "minimumExecuted") };
}

export function effectiveTestIntegrityException(current: SchedulerProjection, binding: TestIntegrityBoundary): TestIntegrityException | undefined {
  const explicit = binding.exceptionId && current.testIntegrity?.exceptions[binding.exceptionId];
  if (explicit) return explicit;
  const review = current.delivery?.reviews[binding.taskId];
  const disposition = review?.testConsolidation;
  if (!review || review.stage !== "completed" || !review.satisfied || review.changeSetId !== binding.changeSetId ||
    review.submissionAttempt !== binding.submissionAttempt || !disposition || !review.completedSequence) return undefined;
  return { ...binding, id: disposition.id, kind: "reviewed_consolidation", reason: disposition.reason,
    behaviorProof: disposition.behaviorProof, authoritySequence: review.completedSequence,
    planRevisionId: disposition.planRevisionId, planDigest: disposition.planDigest,
    baselinePinDigest: disposition.baselinePinDigest, candidatePinDigest: disposition.candidatePinDigest,
    allowedChanges: disposition.allowedChanges, minimumExecuted: disposition.minimumExecuted };
}

/** Exact acceptance binding; a changed ready plan or baseline requires fresh boundary evidence. */
export function testIntegrityBoundaryIsCurrent(current: SchedulerProjection, boundary: DeliveryBoundaryRecord): boolean {
  if (!current.testIntegrity) return true;
  const integrity = boundary.testIntegrity;
  const baseline = current.testIntegrity.baseline;
  const ready = readyPlanIdentity(current);
  const review = current.delivery?.reviews[boundary.taskId];
  if (!integrity || !baseline || !ready || !review ||
    integrity.taskId !== boundary.taskId || integrity.integrationRevision !== current.integrationRevision ||
    integrity.planRevisionId !== ready.revisionId || integrity.planDigest !== ready.digest ||
    integrity.baselineRevision !== baseline.pin.revision || integrity.baselinePinDigest !== baseline.pinDigest ||
    integrity.changeSetId !== review.changeSetId || integrity.submissionAttempt !== review.submissionAttempt ||
    integrity.candidatePinDigest !== testIntegrityPinDigest(integrity.candidatePin)) return false;
  return true;
}

function reduceTestIntegrityEvent(current: SchedulerProjection, next: SchedulerProjection, event: SchedulerEvent): void {
  const state = next.testIntegrity;
  if (!state || current.planningPolicyVersion !== 1) throw new Error("Test-integrity records require activated planning policy.");
  if (event.type === "delivery.test_integrity_initialized") {
    requireDeliveryRunner(event, DELIVERY_ACCEPTANCE_RUNNER_ID);
    const revision = requiredString(event.payload, "revision");
    if (state.initialRevision !== undefined) throw new Error("Test-integrity initial baseline is immutable.");
    state.initialRevision = revision;
    state.architectActorId = requiredString(event.payload, "architectActorId");
    return;
  }
  if (event.type === "delivery.test_integrity_baseline_recorded") {
    requireDeliveryRunner(event, DELIVERY_ACCEPTANCE_RUNNER_ID);
    const pin = parseTestIntegrityPin(event.payload.pin);
    if (!state.initialRevision || pin.revision !== state.initialRevision || state.baseline) throw new Error("Initial test baseline must reference the immutable run baseline once.");
    const evidenceIds = stringArray(event.payload, "evidenceIds");
    if (evidenceIds.length === 0) throw new Error("Initial test baseline requires command evidence.");
    if (event.payload.kind === "no_configured_test_suite") {
      const inventory = typeof event.payload.inventory === "string" ? event.payload.inventory : undefined;
      const inventoryDigest = requiredString(event.payload, "inventoryDigest");
      if (inventory === undefined || event.payload.report !== undefined || event.payload.executed !== undefined) throw new Error("Unconfigured baseline cannot invent test counts or a report.");
      assertNoConfiguredTestSuite(pin, inventory, inventoryDigest);
      state.baseline = { kind: "no_configured_test_suite", pin, pinDigest: testIntegrityPinDigest(pin), inventory, inventoryDigest, evidenceIds, sequence: event.sequence };
      return;
    }
    if (event.payload.kind !== "executed_report") throw new Error("Initial test baseline kind is invalid.");
    const report = parseDeliveryTestReport(event.payload.report, "Initial test-integrity baseline report");
    const executed = executedTestCount(report.counts);
    if (executed === undefined || report.status === "unknown" || !report.path || !report.artifactHash) throw new Error("Initial test baseline requires an actual fresh machine report with executed tests.");
    state.baseline = { kind: "executed_report", pin, pinDigest: testIntegrityPinDigest(pin), report, executed, evidenceIds, sequence: event.sequence };
    return;
  }
  if (event.type === "delivery.test_integrity_exception_recorded") {
    if (event.actor.role !== "architect" || event.actor.id !== state.architectActorId) throw new Error("Only the current bound Architect may authorize a test change reason.");
    const taskId = requiredString(event.payload, "taskId");
    const boundary = latestBoundary(current.delivery, taskId);
    const integrity = boundary?.testIntegrity;
    const ready = readyPlanIdentity(current);
    if (!boundary || boundary.passed || boundary.integrationRevision !== current.integrationRevision || !integrity ||
      !ready || integrity.planRevisionId !== ready.revisionId || integrity.planDigest !== ready.digest) throw new Error("Test change reason requires the current failed identity-bound boundary and plan.");
    const allowedChanges = stringArray(event.payload, "allowedChanges");
    if (allowedChanges.length === 0 || allowedChanges.some((code) => !["test_command_changed", "test_config_changed", "suite_shrank"].includes(code))) throw new Error("Test change reason must specify permitted changes.");
    const id = requiredString(event.payload, "id");
    if (state.exceptions[id]) throw new Error("Test change reason id is already recorded.");
    state.exceptions[id] = { ...integrity, id, kind: "plan_revision_reason", reason: requiredString(event.payload, "reason"),
      authoritySequence: event.sequence, allowedChanges: allowedChanges as TestIntegrityException["allowedChanges"],
      minimumExecuted: requiredPositiveInteger(event.payload, "minimumExecuted") };
  }
}

function reduceDeliveryEvent(
  current: SchedulerProjection,
  next: SchedulerProjection,
  event: SchedulerEvent,
): void {
  if (current.planningPolicyVersion !== 1) {
    throw new Error("Deliverable review and acceptance events apply only to new-policy runs.");
  }
  const state = next.delivery ?? emptyDeliveryState();
  next.delivery = state;
  switch (event.type) {
    case "delivery.review_started":
      deliveryReviewStarted(current, state, event);
      return;
    case "delivery.review_requested":
      deliveryReviewRequested(current, state, event);
      return;
    case "delivery.obligations_recorded":
      deliveryObligationsRecorded(state, event);
      return;
    case "delivery.criteria_and_diff_delivered":
      deliveryDiffDelivered(state, event);
      return;
    case "delivery.findings_recorded":
      deliveryFindingsRecorded(state, event);
      return;
    case "delivery.report_delivered":
      deliveryReportDelivered(state, event);
      return;
    case "delivery.review_recorded":
      deliveryReviewRecorded(current, state, event);
      return;
    case "delivery.boundary_started":
      deliveryBoundaryStarted(current, state, event);
      return;
    case "delivery.boundary_checked":
      deliveryBoundaryChecked(current, state, event);
      return;
    case "delivery.boundary_failure_resolved":
      deliveryBoundaryFailureResolved(current, next, state, event);
      return;
    case "task.acceptance_recorded":
      deliveryTaskAccepted(current, state, event);
      if (next.testIntegrity) {
        const boundary = latestBoundary(state, requiredString(event.payload, "taskId"))!;
        const integrity = boundary.testIntegrity;
        const tests = boundary.checks.find((check) => check.checkId === "tests");
        if (!integrity || !tests?.report || integrity.candidateExecuted === undefined) throw new Error("Accepted task must carry complete test-integrity evidence.");
        next.testIntegrity.baseline = { kind: "executed_report", pin: integrity.candidatePin, pinDigest: integrity.candidatePinDigest,
          executed: integrity.candidateExecuted, report: tests.report, evidenceIds: tests.evidenceIds,
          sequence: event.sequence, acceptedTaskId: boundary.taskId };
      }
      return;
    case "phase.acceptance_recorded":
      deliveryPhaseAccepted(current, state, event);
      return;
    default:
      throw new Error(`Unhandled delivery event ${event.type}.`);
  }
}

function requireDeliveryRunner(event: SchedulerEvent, runnerId: string): void {
  if (event.actor.role !== "runner" || event.actor.id !== runnerId) {
    throw new Error(`Only the ${runnerId} authority may record ${event.type}.`);
  }
}

function requireDeliveryReview(
  state: DeliveryState,
  event: SchedulerEvent,
  stages: readonly DeliveryReviewRecord["stage"][],
): DeliveryReviewRecord {
  const taskId = requiredString(event.payload, "taskId");
  const reviewId = requiredString(event.payload, "reviewId");
  const review = state.reviews[taskId];
  if (!review || review.reviewId !== reviewId) {
    throw new Error(`Deliverable review ${reviewId} is not the current review of task ${taskId}.`);
  }
  if (!stages.includes(review.stage)) {
    throw new Error(
      `Deliverable review ${reviewId} is at stage ${review.stage}; ${event.type} is out of order.`,
    );
  }
  return review;
}

function requireDeliveryReviewer(event: SchedulerEvent, review: DeliveryReviewRecord): void {
  if (event.actor.role !== "verifier" || event.actor.id !== review.reviewerRuntimeId) {
    throw new Error(`Only the bound reviewer runtime may record ${event.type}.`);
  }
}

/**
 * Every reviewer pass runs in its own new session (fresh-context device).
 * A session id may never serve two passes or two reviews.
 */
function requireFreshDeliverySession(state: DeliveryState, event: SchedulerEvent): string {
  const sessionId = requiredString(event.payload, "sessionId");
  const used = [
    ...Object.values(state.reviews),
    ...Object.values(state.reviewHistory).flat(),
  ].some((review) => review.sessionIds.includes(sessionId));
  if (used) throw new Error(`Reviewer session ${sessionId} was already used; each pass needs a fresh session.`);
  return sessionId;
}

function canonicalIdentity(payload: Record<string, unknown>, key: string): string {
  const value = requiredString(payload, key);
  if (canonicalModelIdentity(value) !== value) {
    throw new Error(`${key} must be a canonical model identity.`);
  }
  return value;
}

function deliveryReviewStarted(
  current: SchedulerProjection,
  state: DeliveryState,
  event: SchedulerEvent,
): void {
  requireDeliveryRunner(event, DELIVERY_REVIEW_RUNNER_ID);
  const taskId = requiredString(event.payload, "taskId");
  const task = current.tasks[taskId];
  if (!task || task.kind === "final_verification" || task.status !== "submitted" || !task.changeSetId) {
    throw new Error(`Deliverable review requires submitted task ${taskId}.`);
  }
  if (current.submissionScopePolicyVersion === 1 && (!task.submissionScope || task.submissionScope.changeSetId !== task.changeSetId || task.submissionScope.attempt !== task.attempt)) throw new Error("Deliverable review requires the exact guarded submission scope record.");
  if (current.encodingSafetyPolicyVersion === 1) {
    if (!task.workspaceBaselineRevision) throw new Error("Deliverable review requires its encoding baseline.");
    validateEncodingSubmission(task.encodingSubmission, { runId: current.runId, taskId, baselineRevision: task.workspaceBaselineRevision, changeSetId: task.changeSetId });
  }
  const attempt = requiredPositiveInteger(event.payload, "attempt");
  const changeSetId = requiredString(event.payload, "changeSetId");
  if (attempt !== task.attempt || changeSetId !== task.changeSetId) {
    throw new Error("Deliverable review must bind the current submission.");
  }
  const criteriaIds = stringArray(event.payload, "criteriaIds");
  const expectedCriteria = (task.acceptanceCriteria ?? []).map((criterion) => criterion.id).sort();
  if (expectedCriteria.length === 0 || !sameValue([...criteriaIds].sort(), expectedCriteria)) {
    throw new Error("Deliverable review must bind the task's exact acceptance criteria.");
  }
  const diffArtifactHash = requiredString(event.payload, "diffArtifactHash");
  if (!/^[a-f0-9]{64}$/.test(diffArtifactHash)) {
    throw new Error("Deliverable review requires the submitted diff artifact hash.");
  }
  const authorRuntimeId = requiredString(event.payload, "authorRuntimeId");
  const assignment = current.runtime.workerAssignments[`${taskId}:${attempt}`];
  if (!assignment || assignment.runtimeId !== authorRuntimeId) {
    throw new Error("Deliverable review must record the submission's recorded author runtime.");
  }
  const architectRuntimeId = requiredString(event.payload, "architectRuntimeId");
  if (
    current.runtime.architect.runtimeId !== undefined &&
    current.runtime.architect.runtimeId !== architectRuntimeId
  ) {
    throw new Error("Deliverable review must record the current Architect runtime.");
  }
  const authorModelIdentity = canonicalIdentity(event.payload, "authorModelIdentity");
  const architectModelIdentity = canonicalIdentity(event.payload, "architectModelIdentity");
  const existing = state.reviews[taskId];
  if (
    existing?.stage === "completed" &&
    existing.submissionAttempt === attempt &&
    existing.changeSetId === changeSetId
  ) {
    throw new Error(`Task ${taskId} submission already has a completed deliverable review.`);
  }
  const history = state.reviewHistory[taskId] ?? [];
  const expectedGeneration = Math.max(
    0,
    ...history.map((review) => review.generation),
    existing?.generation ?? 0,
  ) + 1;
  const generation = requiredPositiveInteger(event.payload, "generation");
  if (generation !== expectedGeneration) {
    throw new Error(`Deliverable review generation must be ${expectedGeneration}.`);
  }
  const reviewId = requiredString(event.payload, "reviewId");
  if (reviewId !== deliveryReviewId(taskId, attempt, generation)) {
    throw new Error("Deliverable review id does not match its task, attempt, and generation.");
  }
  if (existing) {
    // An unfinished generation is abandoned, never resumed: its sessions
    // stay recorded as used, so a fresh-context retry opens new sessions.
    state.reviewHistory[taskId] = [
      ...history,
      existing.stage === "completed" ? existing : { ...existing, stage: "abandoned" },
    ];
  }
  if (current.reviewIntegrityPolicyVersion === 1) {
    const assignments = current.runtime.workerAssignmentHistory?.[`${taskId}:${attempt}`];
    if (!assignments?.length || assignments.at(-1)?.runtimeId !== authorRuntimeId || assignments.at(-1)?.modelIdentity !== authorModelIdentity) throw new Error("Review requires the exact captured attempt author history.");
    for (const coauthor of assignments) {
      if (!coauthor.modelIdentity) throw new Error("Review author history has no model identity.");
      if (state.authorModelIdentities[coauthor.runtimeId] && state.authorModelIdentities[coauthor.runtimeId] !== coauthor.modelIdentity) throw new Error("Review author model identity changed during the run.");
      state.authorModelIdentities[coauthor.runtimeId] = coauthor.modelIdentity;
    }
  }
  state.authorModelIdentities[authorRuntimeId] = authorModelIdentity;
  state.reviews[taskId] = {
    taskId,
    reviewId,
    generation,
    submissionAttempt: attempt,
    changeSetId,
    diffArtifactHash,
    criteriaIds: [...criteriaIds],
    authorRuntimeId,
    authorModelIdentity,
    architectRuntimeId,
    architectModelIdentity,
    ...(current.reviewIntegrityPolicyVersion === 1 ? { reviewIntegrityPolicyVersion: 1 } : {}),
    ...(current.submissionScopePolicyVersion === 1 ? { runnerScope: structuredClone(task.submissionScope!) } : {}),
    ...(current.encodingSafetyPolicyVersion === 1 ? { runnerEncoding: structuredClone(task.encodingSubmission!) } : {}),
    stage: "started",
    startedSequence: event.sequence,
    sessionIds: [],
  };
}

function reviewsOfTask(projection: SchedulerProjection, taskId: string): ReviewProjection[] {
  return [
    ...(projection.reviewHistory?.[taskId] ?? []),
    ...(projection.reviews[taskId] ? [projection.reviews[taskId]!] : []),
  ];
}

function deliveryReviewRequested(current: SchedulerProjection, state: DeliveryState, event: SchedulerEvent): void {
  requireDeliveryRunner(event, DELIVERY_REVIEW_RUNNER_ID);
  const review = requireDeliveryReview(state, event, ["started"]);
  const reviewerRuntimeId = requiredString(event.payload, "reviewerRuntimeId");
  const reviewerModelIdentity = canonicalIdentity(event.payload, "reviewerModelIdentity");
  const independence = event.payload.independence;
  if (independence !== "distinct_model" && independence !== "fresh_context") {
    throw new Error("Deliverable review independence must be distinct_model or fresh_context.");
  }
  // B6: distinct_model must not match any recorded change-author runtime or
  // model identity, nor the Architect's. fresh_context may reuse the author
  // or Architect model, but only in new sessions (requireFreshDeliverySession).
  if (independence === "distinct_model") {
    const authorRuntimeIds = new Set(Object.keys(state.authorModelIdentities));
    const excludedIdentities = new Set([
      ...Object.values(state.authorModelIdentities),
      review.architectModelIdentity,
    ]);
    if (
      authorRuntimeIds.has(reviewerRuntimeId) ||
      reviewerRuntimeId === review.architectRuntimeId ||
      excludedIdentities.has(reviewerModelIdentity)
    ) {
      throw new Error(
        "Self-review is impossible: a distinct_model reviewer must differ from every change author and the Architect.",
      );
    }
  }
  const tier = event.payload.reviewTier;
  if (tier !== "low" && tier !== "medium" && tier !== "high") {
    throw new Error("Deliverable review tier is invalid.");
  }
  // B8: the tier is recorded on the request and recomputed here from the
  // recorded T5 risk inputs of the real change.
  const riskInput = event.payload.riskInput;
  if (!isRecord(riskInput)) throw new Error("Deliverable review requires its T5 risk input.");
  const changedFiles = stringArray(riskInput, "changedFiles");
  const linesAdded = requiredNumber(riskInput, "linesAdded");
  const linesRemoved = requiredNumber(riskInput, "linesRemoved");
  const attempts = requiredPositiveInteger(riskInput, "attempts");
  const authorModelId = requiredString(riskInput, "authorModelId");
  if (typeof riskInput.acceptedFailuresUsed !== "boolean") {
    throw new Error("Deliverable review risk input requires acceptedFailuresUsed.");
  }
  if (attempts !== review.submissionAttempt || authorModelId !== review.authorModelIdentity) {
    throw new Error("Deliverable review risk input must describe the recorded submission.");
  }
  if (riskInput.acceptedFailuresUsed !== taskAcceptedFailuresUsed(reviewsOfTask(current, review.taskId))) {
    throw new Error("Deliverable review risk input must state whether an accepted evidence failure was used.");
  }
  if (
    changedFiles.length === 0 ||
    !Number.isSafeInteger(linesAdded) || !Number.isSafeInteger(linesRemoved) ||
    linesAdded < 0 || linesRemoved < 0
  ) {
    throw new Error("Deliverable review risk input requires the real changed files and line counts.");
  }
  // T6b repair (EP50): the recorded OA-16 track-record snapshot replays
  // here so the deterministic recompute matches the request-time tier.
  const risk = assessDeliveryRisk({
    authorModelId,
    changedFiles,
    linesAdded,
    linesRemoved,
    attempts,
    acceptedFailuresUsed: riskInput.acceptedFailuresUsed,
    ...(current.reviewIntegrityPolicyVersion === 1 ? { runnerSignals: (() => {
      const record = current.tasks[review.taskId]?.reviewSignals;
      if (!record || record.changeSetId !== review.changeSetId || JSON.stringify(riskInput.runnerSignals) !== JSON.stringify(record.signals)) throw new Error("Review risk must use the exact submitted runner signals.");
      return structuredClone(record.signals);
    })() } : {}),
    ...(riskInput.trackRecord !== undefined ? { trackRecord: readTrackRecordSnapshot(riskInput.trackRecord) } : {}),
  });
  if (risk.tier !== tier || risk.digest !== requiredString(event.payload, "riskDigest")) {
    throw new Error("Deliverable review tier must equal the deterministic T5 risk tier of the recorded change.");
  }
  const prior = latestCompletedReview(state, review.taskId);
  const priorReviewId = event.payload.priorReviewId;
  if (prior ? priorReviewId !== prior.reviewId : priorReviewId !== undefined) {
    throw new Error("A fix re-review must name exactly the latest completed review of the task.");
  }
  review.reviewerRuntimeId = reviewerRuntimeId;
  review.reviewerModelIdentity = reviewerModelIdentity;
  review.independence = independence;
  review.risk = risk;
  if (prior) review.priorReviewId = prior.reviewId;
  review.stage = "requested";
}

function deliveryObligationsRecorded(state: DeliveryState, event: SchedulerEvent): void {
  const review = requireDeliveryReview(state, event, ["requested"]);
  requireDeliveryReviewer(event, review);
  if (review.risk?.tier !== "high") {
    throw new Error("Only a high-tier review records obligations before the diff.");
  }
  const sessionId = requireFreshDeliverySession(state, event);
  review.obligations = validateDeliveryObligations(event.payload.obligations, event.occurredAt);
  review.sessionIds.push(sessionId);
  review.stage = "obligations_recorded";
}

function deliveryDiffDelivered(state: DeliveryState, event: SchedulerEvent): void {
  requireDeliveryRunner(event, DELIVERY_REVIEW_RUNNER_ID);
  const review = requireDeliveryReview(state, event, ["requested", "obligations_recorded"]);
  const depth = deliveryReviewDepthForTier(review.risk!.tier);
  if (depth.obligationsFirst && review.stage !== "obligations_recorded") {
    throw new Error("High-tier obligations must be recorded before the diff is delivered.");
  }
  if (!depth.obligationsFirst && review.stage !== "requested") {
    throw new Error("Criteria and diff delivery is out of order.");
  }
  if (requiredString(event.payload, "diffArtifactHash") !== review.diffArtifactHash) {
    throw new Error("The delivered diff must be the submitted change's diff artifact.");
  }
  review.stage = "diff_delivered";
}

function deliveryFindingsRecorded(state: DeliveryState, event: SchedulerEvent): void {
  const review = requireDeliveryReview(state, event, ["diff_delivered"]);
  requireDeliveryReviewer(event, review);
  const sessionId = requireFreshDeliverySession(state, event);
  const findings = validateDeliveryFindings(event.payload.findings);
  if (review.runnerScope && findings.some((finding) => finding.id.startsWith("submission-scope:"))) throw new Error("Reviewer findings cannot use reserved runner scope identities.");
  for (const fact of review.runnerScope?.findings ?? []) findings.push({ id: fact.id, category: "scope_creep", severity: "blocking", location: fact.path, claim: fact.message, evidenceRefs: [review.runnerScope!.changeSetId] });
  if (review.runnerEncoding && findings.some((finding) => finding.id.startsWith("submission-encoding:"))) throw new Error("Reviewer findings cannot use reserved runner encoding identities.");
  for (const fact of review.runnerEncoding ? encodingFindingFacts(review.runnerEncoding) : []) findings.push({ id: fact.id, category: "weakened_obligation", severity: "blocking", location: fact.path, claim: fact.message, evidenceRefs: [review.runnerEncoding!.changeSetId] });
  const depth = parseDeliveryDepth(event.payload.depth);
  const required = deliveryReviewDepthForTier(review.risk!.tier, review.reviewIntegrityPolicyVersion);
  if (required.repositoryInspection && depth.inspectionToolCalls < 1) {
    throw new Error("This deliverable review requires at least one real inspection tool call.");
  }
  if (required.affectedTests && !depth.affectedTests) {
    throw new Error("A high-tier deliverable review requires the affected-test run.");
  }
  if (required.probe && !depth.probe) {
    throw new Error("A high-tier deliverable review requires the OA-11 probe result.");
  }
  review.findings = findings;
  review.depth = depth;
  review.sessionIds.push(sessionId);
  review.stage = "findings_recorded";
}

function deliveryReportDelivered(state: DeliveryState, event: SchedulerEvent): void {
  requireDeliveryRunner(event, DELIVERY_REVIEW_RUNNER_ID);
  const review = requireDeliveryReview(state, event, ["findings_recorded"]);
  if (!Array.isArray(event.payload.claims) || event.payload.claims.length === 0) {
    throw new Error("The worker report must carry the worker's claims.");
  }
  const seen = new Set<string>();
  const claims: DeliveryClaim[] = event.payload.claims.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Worker claim is invalid.");
    const id = requiredString(candidate, "id");
    if (seen.has(id)) throw new Error(`Duplicate worker claim ${id}.`);
    seen.add(id);
    return { id, text: requiredString(candidate, "text"), evidenceIds: stringArray(candidate, "evidenceIds") };
  });
  for (const criterionId of review.criteriaIds) {
    if (!seen.has(`claim:${criterionId}`)) {
      throw new Error(`The worker report must carry the claim for criterion ${criterionId}.`);
    }
  }
  review.claims = claims;
  review.stage = "report_delivered";
}

function deliveryReviewRecorded(current: SchedulerProjection, state: DeliveryState, event: SchedulerEvent): void {
  const review = requireDeliveryReview(state, event, ["report_delivered"]);
  requireDeliveryReviewer(event, review);
  const sessionId = requireFreshDeliverySession(state, event);
  const summary = requiredString(event.payload, "summary");
  if (typeof event.payload.satisfied !== "boolean") {
    throw new Error("Deliverable review verdict requires satisfied.");
  }
  const claims = review.claims ?? [];
  if (!Array.isArray(event.payload.claimVerdicts)) {
    throw new Error("Deliverable review verdict requires a verdict per worker claim.");
  }
  const verdicts: DeliveryClaimVerdict[] = event.payload.claimVerdicts.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Worker claim verdict is invalid.");
    const claimId = requiredString(candidate, "claimId");
    const claim = claims.find((item) => item.id === claimId);
    if (!claim) throw new Error(`Unknown worker claim ${claimId}.`);
    if (candidate.status !== "verified" && candidate.status !== "unverified") {
      throw new Error(`Worker claim ${claimId} verdict status is invalid.`);
    }
    return { claimId, claim: claim.text, status: candidate.status, rationale: requiredString(candidate, "rationale") };
  });
  if (!sameValue(verdicts.map((verdict) => verdict.claimId).sort(), claims.map((claim) => claim.id).sort())) {
    throw new Error("Deliverable review verdict must judge every worker claim exactly once.");
  }
  const findings = [...(review.findings ?? [])];
  if (review.priorReviewId !== undefined) {
    const prior = (state.reviewHistory[review.taskId] ?? []).find((item) => item.reviewId === review.priorReviewId);
    if (!prior) throw new Error("A fix re-review requires its durable prior review.");
    if (!Array.isArray(event.payload.priorFindingChecks)) {
      throw new Error("A fix re-review must check every prior finding.");
    }
    const checks: DeliveryPriorFindingCheck[] = event.payload.priorFindingChecks.map((candidate) => {
      if (!isRecord(candidate)) throw new Error("Prior finding check is invalid.");
      if (candidate.resolution !== "resolved" && candidate.resolution !== "outstanding") {
        throw new Error("Prior finding check resolution is invalid.");
      }
      return {
        findingId: requiredString(candidate, "findingId"),
        resolution: candidate.resolution,
        rationale: requiredString(candidate, "rationale"),
      };
    });
    if (!sameValue(checks.map((check) => check.findingId).sort(), (prior.findings ?? []).map((finding) => finding.id).sort())) {
      throw new Error("A fix re-review must check every prior finding exactly once.");
    }
    // An outstanding prior blocking finding that nobody disposed carries
    // forward as an open blocking finding of this review.
    for (const check of checks) {
      if (check.resolution !== "outstanding") continue;
      const priorFinding = prior.findings?.find((finding) => finding.id === check.findingId);
      if (!priorFinding || priorFinding.severity !== "blocking" || priorFinding.disposition) continue;
      findings.push({
        id: `carried:${priorFinding.id}`,
        category: priorFinding.category,
        severity: "blocking",
        ...(priorFinding.requirementId ? { requirementId: priorFinding.requirementId } : {}),
        ...(priorFinding.location ? { location: priorFinding.location } : {}),
        claim: `Outstanding from ${prior.reviewId}: ${priorFinding.claim}`,
        evidenceRefs: [...priorFinding.evidenceRefs],
      });
    }
    review.priorFindingChecks = checks;
  } else if (event.payload.priorFindingChecks !== undefined) {
    throw new Error("Only a fix re-review checks prior findings.");
  }
  const blocked = findings.some((finding) => finding.severity === "blocking") ||
    verdicts.some((verdict) => verdict.status === "unverified");
  if (event.payload.satisfied === blocked) {
    throw new Error(
      "Deliverable review verdict must be unsatisfied exactly when a blocking finding or unverified claim exists.",
    );
  }
  review.findings = findings;
  review.claimVerdicts = verdicts;
  review.summary = summary;
  review.satisfied = event.payload.satisfied;
  review.sessionIds.push(sessionId);
  review.stage = "completed";
  review.completedSequence = event.sequence;
  if (event.payload.testConsolidation !== undefined) {
    if (!current.testIntegrity || !review.satisfied) throw new Error("Test consolidation requires an activated, satisfied independent review.");
    const disposition = parseTestConsolidation(event.payload.testConsolidation);
    const ready = readyPlanIdentity(current);
    if (!ready || disposition.planRevisionId !== ready.revisionId || disposition.planDigest !== ready.digest) throw new Error("Test consolidation must bind the exact current ready plan.");
    review.testConsolidation = disposition;
  }
}

function parseDeliveryTestReport(value: unknown, label: string): DeliveryTestReport {
  if (!isRecord(value) || (value.status !== "passed" && value.status !== "failed" && value.status !== "unknown")) {
    throw new Error(`${label} is invalid.`);
  }
  const counts = value.counts;
  if (counts !== undefined && (!isRecord(counts) || !["selected", "passed", "failed", "skipped"].every((key) => Number.isSafeInteger(counts[key]) && (counts[key] as number) >= 0))) {
    throw new Error(`${label} counts are invalid.`);
  }
  return {
    status: value.status,
    runner: requiredString(value, "runner"),
    ...(value.format === "junit" || value.format === "trx" ? { format: value.format } : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(typeof value.artifactHash === "string" ? { artifactHash: value.artifactHash } : {}),
    ...(isRecord(counts) ? { counts: { selected: counts.selected as number, passed: counts.passed as number, failed: counts.failed as number, skipped: counts.skipped as number } } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(value.reporterUnsupported === true ? { reporterUnsupported: true } : {}),
  };
}

function parseDeliveryDepth(value: unknown): DeliveryDepthRecord {
  if (!isRecord(value)) throw new Error("Deliverable findings require the review depth record.");
  const inspectionToolCalls = value.inspectionToolCalls;
  if (!Number.isSafeInteger(inspectionToolCalls) || (inspectionToolCalls as number) < 0) {
    throw new Error("Deliverable review depth requires the inspection tool call count.");
  }
  const depth: DeliveryDepthRecord = { inspectionToolCalls: inspectionToolCalls as number };
  if (value.affectedTests !== undefined) {
    const record = value.affectedTests;
    if (!isRecord(record)) throw new Error("Affected-test record is invalid.");
    const exitCode = record.exitCode;
    if (exitCode !== null && !Number.isSafeInteger(exitCode)) {
      throw new Error("Affected-test exit code is invalid.");
    }
    const outcome = record.outcome;
    const evidenceIds = stringArray(record, "evidenceIds");
    if (exitCode !== null && evidenceIds.length === 0) {
      throw new Error("An executed affected-test command requires its evidence.");
    }
    const report = parseDeliveryTestReport(record.report, "Affected-test report");
    assertTestsOutcome("Affected-test", exitCode as number | null, outcome, report);
    if (record.executedScope !== "full_test_script") {
      throw new Error("Affected-test record must state that the whole project test script ran.");
    }
    const affectedTests: DeliveryAffectedTestsRecord = {
      executedScope: "full_test_script",
      selectionRung: requiredString(record, "selectionRung"),
      changedFiles: stringArray(record, "changedFiles"),
      selectedTests: stringArray(record, "selectedTests"),
      fullSuiteCount: requiredNumber(record, "fullSuiteCount"),
      command: requiredString(record, "command"),
      args: stringArray(record, "args"),
      evidenceIds,
      exitCode: exitCode as number | null,
      outcome: outcome as DeliveryAffectedTestsRecord["outcome"],
      report,
    };
    if (affectedTests.changedFiles.length === 0) {
      throw new Error("Affected-test selection requires the real changed files.");
    }
    depth.affectedTests = affectedTests;
  }
  if (value.probe !== undefined) {
    const record = value.probe;
    if (!isRecord(record)) throw new Error("Probe record is invalid.");
    const probe: DeliveryProbeRecord = {
      rung: requiredString(record, "rung"),
      mutantsGenerated: requiredNumber(record, "mutantsGenerated"),
      mutantsExecuted: requiredNumber(record, "mutantsExecuted"),
      mutantsCaught: requiredNumber(record, "mutantsCaught"),
      survivors: stringArray(record, "survivors"),
      partial: record.partial === true,
      evidenceIds: stringArray(record, "evidenceIds"),
      notes: stringArray(record, "notes"),
    };
    if (probe.mutantsExecuted > 0 && probe.evidenceIds.length === 0) {
      throw new Error("An executed OA-11 probe requires its command evidence.");
    }
    depth.probe = probe;
  }
  return depth;
}

/**
 * T6a (B7): `review.decided` may carry the Architect's dispositions of
 * blocking deliverable findings and of unverified worker claims. Each list
 * is applied on its own; an unknown or already-disposed id is refused.
 */
function applyDeliveryDispositions(
  next: SchedulerProjection,
  task: BuildTask,
  event: SchedulerEvent,
): void {
  const findingDispositions = event.payload.findingDispositions;
  const claimDispositions = event.payload.claimDispositions;
  if (findingDispositions === undefined && claimDispositions === undefined) return;
  if (next.planningPolicyVersion !== 1) {
    throw new Error("Deliverable dispositions apply only to new-policy runs.");
  }
  const review = next.delivery?.reviews[task.id];
  if (
    !review || review.stage !== "completed" ||
    review.submissionAttempt !== task.attempt || review.changeSetId !== task.changeSetId
  ) {
    throw new Error("Dispositions require the completed deliverable review of the current submission.");
  }
  if (findingDispositions !== undefined) {
    if (!Array.isArray(findingDispositions)) throw new Error("findingDispositions must be an array.");
    const open = new Set(openBlockingFindings(review).map((finding) => finding.id));
    for (const raw of findingDispositions) {
      if (!isRecord(raw)) throw new Error("Deliverable finding disposition is invalid.");
      const findingId = requiredString(raw, "findingId");
      if (!open.has(findingId)) {
        throw new Error(`Deliverable finding ${findingId} is not an open blocking finding.`);
      }
      open.delete(findingId);
      const resolution = raw.resolution;
      if (resolution !== "plan_reconciled" && resolution !== "rejected" && resolution !== "deferred") {
        throw new Error("Deliverable finding disposition resolution is invalid.");
      }
      const rationale = requiredString(raw, "rationale");
      let scopeResolutionDigest: string | undefined;
      if (review.runnerScope?.findings.some((fact) => fact.id === findingId)) {
        const ready = readyPlanIdentity(next);
        if (resolution !== "plan_reconciled" || !ready || raw.planRevisionId !== ready.revisionId || raw.planDigest !== ready.digest) throw new Error("Submission scope findings require an explicit current-plan reconciliation.");
        scopeResolutionDigest = ready.digest;
      }
      review.findings = (review.findings ?? []).map((finding) => finding.id === findingId
        ? {
            ...finding,
            disposition: {
              resolution,
              rationale,
              resolvedAt: event.occurredAt,
              resolvedByReviewId: review.reviewId,
              ...(scopeResolutionDigest ? { resolvedInRevisionDigest: scopeResolutionDigest } : {}),
            },
          }
        : finding);
    }
  }
  if (claimDispositions !== undefined) {
    if (!Array.isArray(claimDispositions)) throw new Error("claimDispositions must be an array.");
    const open = new Set(unverifiedClaims(review).map((claim) => claim.claimId));
    for (const raw of claimDispositions) {
      if (!isRecord(raw)) throw new Error("Worker claim disposition is invalid.");
      const claimId = requiredString(raw, "claimId");
      if (!open.has(claimId)) throw new Error(`Worker claim ${claimId} is not an unverified claim.`);
      open.delete(claimId);
      if (raw.status !== "verified") {
        throw new Error("The Architect disposes of an unverified claim only by verifying it.");
      }
      const rationale = requiredString(raw, "rationale");
      review.claimVerdicts = (review.claimVerdicts ?? []).map((verdict) => verdict.claimId === claimId
        ? { ...verdict, disposition: { status: "verified" as const, rationale, resolvedAt: event.occurredAt } }
        : verdict);
    }
  }
}

/**
 * N-R4-3: every boundary run is durably started before any command runs, so
 * a retry after an interruption gets a fresh attempt id (fresh process and
 * evidence keys) instead of colliding with the interrupted run.
 */
function deliveryBoundaryStarted(
  current: SchedulerProjection,
  state: DeliveryState,
  event: SchedulerEvent,
): void {
  requireDeliveryRunner(event, DELIVERY_ACCEPTANCE_RUNNER_ID);
  const taskId = requiredString(event.payload, "taskId");
  const task = current.tasks[taskId];
  if (!task || task.kind === "final_verification" || task.status !== "integrated" || state.taskAcceptances[taskId]) {
    throw new Error(`Boundary runs require integrated, unaccepted task ${taskId}.`);
  }
  const integrationRevision = requiredString(event.payload, "integrationRevision");
  if (integrationRevision !== current.integrationRevision) {
    throw new Error("Boundary runs must target the current integration revision.");
  }
  if (deliveryBoundaryAction(state, taskId, integrationRevision, (id) => current.tasks[id]?.status, (boundary) => testIntegrityBoundaryIsCurrent(current, boundary)).type !== "run") {
    throw new Error(`Task ${taskId} boundary on ${integrationRevision} may not run again.`);
  }
  const boundaryId = requiredString(event.payload, "boundaryId");
  if (boundaryId !== deliveryBoundaryId(taskId, (state.boundaries[taskId]?.length ?? 0) + 1)) {
    throw new Error("Boundary run id does not match the next boundary generation.");
  }
  const starts = state.boundaryStarts ?? {};
  const attempt = requiredPositiveInteger(event.payload, "attempt");
  if (attempt !== (starts[boundaryId] ?? 0) + 1) {
    throw new Error(`Boundary run attempt must be ${(starts[boundaryId] ?? 0) + 1}.`);
  }
  state.boundaryStarts = { ...starts, [boundaryId]: attempt };
}

function deliveryBoundaryChecked(
  current: SchedulerProjection,
  state: DeliveryState,
  event: SchedulerEvent,
): void {
  requireDeliveryRunner(event, DELIVERY_ACCEPTANCE_RUNNER_ID);
  const taskId = requiredString(event.payload, "taskId");
  const task = current.tasks[taskId];
  if (!task || task.kind === "final_verification" || task.status !== "integrated") {
    throw new Error(`Boundary checks require integrated task ${taskId}.`);
  }
  if (state.taskAcceptances[taskId]) throw new Error(`Task ${taskId} is already accepted.`);
  const integrationRevision = requiredString(event.payload, "integrationRevision");
  if (integrationRevision !== current.integrationRevision) {
    throw new Error("Boundary checks must run on the current integration revision.");
  }
  // B4: a failed boundary is never re-run on the same revision without a
  // state change (a new revision, or one Architect recheck grant).
  const action = deliveryBoundaryAction(state, taskId, integrationRevision, (id) => current.tasks[id]?.status, (boundary) => testIntegrityBoundaryIsCurrent(current, boundary));
  if (action.type !== "run") {
    throw new Error(`Task ${taskId} boundary on ${integrationRevision} may not run again (${action.type}).`);
  }
  const previous = state.boundaries[taskId] ?? [];
  const generation = requiredPositiveInteger(event.payload, "generation");
  const attempt = requiredPositiveInteger(event.payload, "attempt");
  if (attempt !== state.boundaryStarts?.[deliveryBoundaryId(taskId, generation)]) {
    throw new Error("Boundary checks must record the latest durably started attempt.");
  }
  if (event.payload.executedScope !== "full_test_script") {
    throw new Error("Boundary checks must state that the whole project scripts ran.");
  }
  if (generation !== previous.length + 1) {
    throw new Error(`Boundary generation must be ${previous.length + 1}.`);
  }
  const boundaryId = requiredString(event.payload, "boundaryId");
  if (boundaryId !== deliveryBoundaryId(taskId, generation)) {
    throw new Error("Boundary id does not match its task and generation.");
  }
  if (!Array.isArray(event.payload.checks) || event.payload.checks.length === 0) {
    throw new Error("Boundary checks require real check outcomes.");
  }
  const checkIds = new Set<string>();
  const checks: DeliveryBoundaryCheck[] = event.payload.checks.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Boundary check is invalid.");
    const checkId = requiredString(candidate, "checkId");
    if (checkIds.has(checkId)) throw new Error(`Duplicate boundary check ${checkId}.`);
    checkIds.add(checkId);
    const exitCode = candidate.exitCode;
    if (exitCode !== null && !Number.isSafeInteger(exitCode)) throw new Error("Boundary check exit code is invalid.");
    const outcome = candidate.outcome;
    if (outcome !== "passed" && outcome !== "failed" && outcome !== "unknown") {
      throw new Error("Boundary check outcome is invalid.");
    }
    const evidenceIds = stringArray(candidate, "evidenceIds");
    if (outcome === "passed" && (exitCode !== 0 || evidenceIds.length === 0)) {
      throw new Error("A passed boundary check requires exit code 0 and its evidence.");
    }
    const report = candidate.report === undefined ? undefined : parseDeliveryTestReport(candidate.report, "Boundary test report");
    if (checkId === "tests") {
      // Owner decision "real counts": tests pass only on this run's report.
      if (!report) throw new Error("The boundary tests check requires this run's test report reading.");
      assertTestsOutcome("Boundary tests", exitCode as number | null, outcome, report);
    }
    if (outcome === "failed" && evidenceIds.length === 0 && typeof candidate.reason !== "string") {
      throw new Error("A failed boundary check requires its evidence or reason.");
    }
    return {
      checkId,
      ...(typeof candidate.command === "string" ? { command: candidate.command } : {}),
      ...(Array.isArray(candidate.args) ? { args: stringArray(candidate, "args") } : {}),
      evidenceIds,
      exitCode: exitCode as number | null,
      outcome,
      ...(typeof candidate.reason === "string" ? { reason: candidate.reason } : {}),
      ...(report ? { report } : {}),
    };
  });
  const passed = event.payload.passed;
  if (typeof passed !== "boolean" || passed !== checks.every((check) => check.outcome === "passed")) {
    throw new Error("Boundary passed must equal every check passing.");
  }
  const selection = event.payload.selection;
  if (!isRecord(selection)) throw new Error("Boundary checks require the affected-test selection.");
  let testIntegrity: TestIntegrityBoundary | undefined;
  if (current.testIntegrity) {
    const recorded = event.payload.testIntegrity;
    const baseline = current.testIntegrity.baseline;
    const ready = readyPlanIdentity(current);
    const review = current.delivery?.reviews[taskId];
    if (!baseline || !ready || !review || !isRecord(recorded) || recorded.version !== 1) throw new Error("Guarded boundary requires trusted baseline and current test-integrity evidence.");
    const candidatePin = parseTestIntegrityPin(recorded.candidatePin);
    const tests = checks.find((check) => check.checkId === "tests");
    const candidateExecuted = executedTestCount(tests?.report?.counts);
    testIntegrity = { version: 1, taskId, integrationRevision, planRevisionId: ready.revisionId, planDigest: ready.digest,
      baselineRevision: baseline.pin.revision, baselinePinDigest: baseline.pinDigest, candidatePinDigest: testIntegrityPinDigest(candidatePin),
      submissionAttempt: review.submissionAttempt, changeSetId: review.changeSetId, candidatePin,
      ...(candidateExecuted !== undefined ? { candidateExecuted } : {}),
      ...(typeof recorded.exceptionId === "string" ? { exceptionId: recorded.exceptionId } : {}) };
    if (candidatePin.revision !== integrationRevision || !sameValue(recorded, testIntegrity)) throw new Error("Test-integrity record must bind exact current projection and measured counts.");
    const findings = testIntegrityBaselineFindings(baseline, candidatePin, candidateExecuted);
    const unresolved = unresolvedTestIntegrityFindings({ findings, binding: testIntegrity,
      exception: effectiveTestIntegrityException(current, testIntegrity), candidateExecuted });
    const guard = checks.find((check) => check.checkId === "test_integrity");
    if (!guard || guard.outcome !== (unresolved.length ? "failed" : "passed") ||
      (unresolved.length === 0 && guard.exitCode !== 0) || (unresolved.length > 0 && guard.exitCode !== 1)) throw new Error("Test-integrity outcome must match kernel recomputation.");
  } else if (event.payload.testIntegrity !== undefined || checks.some((check) => check.checkId === "test_integrity")) {
    throw new Error("Historical delivery policy cannot invent test-integrity records.");
  }
  const last = previous.at(-1);
  if (last?.resolution?.resolution === "recheck" && last.integrationRevision === integrationRevision) {
    last.resolution = { ...last.resolution, consumed: true };
  }
  state.boundaries[taskId] = [...previous, {
    taskId,
    boundaryId,
    generation,
    attempt,
    integrationRevision,
    changedFiles: stringArray(event.payload, "changedFiles"),
    executedScope: "full_test_script",
    selection: { rung: requiredString(selection, "rung"), selectedTests: stringArray(selection, "selectedTests") },
    checks,
    passed,
    sequence: event.sequence,
    ...(testIntegrity ? { testIntegrity } : {}),
  }];
}

function deliveryBoundaryFailureResolved(
  current: SchedulerProjection,
  next: SchedulerProjection,
  state: DeliveryState,
  event: SchedulerEvent,
): void {
  if (event.actor.role !== "architect") {
    throw new Error("Only the Architect may resolve a failed boundary check.");
  }
  const taskId = requiredString(event.payload, "taskId");
  const boundaryId = requiredString(event.payload, "boundaryId");
  const boundary = latestBoundary(state, taskId);
  if (
    !boundary || boundary.boundaryId !== boundaryId ||
    !boundaryNeedsArchitect(boundary, (id) => current.tasks[id]?.status) ||
    boundary.integrationRevision !== current.integrationRevision ||
    current.tasks[taskId]?.status !== "integrated" || state.taskAcceptances[taskId]
  ) {
    throw new Error("Only the current failed boundary awaiting the Architect can be resolved.");
  }
  if (requiredPositiveInteger(event.payload, "resolutionGeneration") !== boundaryResolutionGeneration(boundary)) {
    throw new Error(`Boundary resolution generation must be ${boundaryResolutionGeneration(boundary)}.`);
  }
  const rationale = requiredString(event.payload, "rationale");
  const resolution = event.payload.resolution;
  // N-R4-2: repairs that ended without re-running the boundary are
  // superseded by this new resolution, kept durably in the history.
  const supersede = () => {
    if (boundary.resolution) {
      boundary.resolutionHistory = [...(boundary.resolutionHistory ?? []), boundary.resolution];
    }
  };
  if (resolution === "recheck") {
    const rechecked = (state.boundaries[taskId] ?? []).some((candidate) =>
      candidate.integrationRevision === boundary.integrationRevision &&
      [candidate.resolution, ...(candidate.resolutionHistory ?? [])].some((item) => item?.resolution === "recheck"));
    if (rechecked) {
      throw new Error("A failed boundary may be rechecked once per integration revision; plan a repair instead.");
    }
    supersede();
    boundary.resolution = { resolution, rationale, sequence: event.sequence };
    return;
  }
  if (resolution !== "repair_planned") {
    throw new Error("Boundary failure resolution must be recheck or repair_planned.");
  }
  const repairTaskIds = createDeliveryRepairTasks(next, event.payload, taskId, boundary);
  supersede();
  boundary.resolution = { resolution, rationale, repairTaskIds, sequence: event.sequence };
}

/**
 * T6a: repairs for a failed boundary are ordinary worker tasks bound to the
 * failed task's parent contract, created like verifier repairs (ready plan,
 * one repair cycle, validated graph). T6b adds the repair-approach decision
 * and budget at the repair-approach decision tool and issue budget gate.
 */
function createDeliveryRepairTasks(
  projection: SchedulerProjection,
  payload: Record<string, unknown>,
  sourceTaskId: string,
  boundary: DeliveryBoundaryRecord,
): string[] {
  const ready = readyPlanIdentity(projection);
  if (!ready) throw new Error("Boundary repairs on a new-policy run require a ready plan revision.");
  const revision = requiredNumber(payload, "revision");
  if (revision !== projection.planRevision + 1) throw new Error("Boundary repair plan revision is stale.");
  if (!Array.isArray(payload.tasks) || payload.tasks.length === 0) {
    throw new Error("Boundary repairs require at least one task.");
  }
  consumeRepairCycle(projection);
  const evidenceIds = [...new Set(boundary.checks
    .filter((check) => check.outcome !== "passed")
    .flatMap((check) => check.evidenceIds))].sort();
  const tasks = payload.tasks.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Boundary repair task is invalid.");
    if (!Array.isArray(candidate.acceptanceCriteria)) {
      throw new Error("Boundary repair task requires acceptance criteria.");
    }
    const acceptanceCriteria = candidate.acceptanceCriteria as AcceptanceCriterion[];
    const criteriaValidation = validateAcceptanceCriteria(acceptanceCriteria);
    if (!criteriaValidation.valid) {
      throw new Error(`Boundary repair acceptance criteria are invalid: ${criteriaValidation.issues.join(" ")}`);
    }
    const requiredCapabilities = stringArray(candidate, "requiredCapabilities");
    if (requiredCapabilities.length === 0 || requiredCapabilities.some((capability) => !capability.trim())) {
      throw new Error("Boundary repair task requires non-empty capabilities.");
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
      deliveryRepair: {
        sourceTaskId,
        boundaryId: boundary.boundaryId,
        integrationRevision: boundary.integrationRevision,
        evidenceIds,
      },
    } satisfies BuildTask;
  });
  for (const task of tasks) {
    if (projection.tasks[task.id]) throw new Error(`Duplicate task ${task.id}.`);
  }
  const validation = validateTaskGraph(
    [...Object.values(projection.tasks), ...tasks],
    { requireAcceptanceCriteria: true },
  );
  if (!validation.valid) {
    throw new Error(`Boundary repair plan is invalid: ${validation.issues.map((issue) => issue.message).join(" ")}`);
  }
  for (const task of tasks) projection.tasks[task.id] = task;
  const bindings = { ...projection.readyPlanTaskBindings };
  for (const task of tasks) {
    const parent = repairParentContractId(projection, task);
    bindings[task.id] = parent !== undefined
      ? { revisionId: ready.revisionId, digest: ready.digest, contractId: parent }
      : { revisionId: ready.revisionId, digest: ready.digest };
  }
  projection.readyPlanTaskBindings = bindings;
  projection.planRevision = revision;
  return tasks.map((task) => task.id);
}

function deliveryTaskAccepted(
  current: SchedulerProjection,
  state: DeliveryState,
  event: SchedulerEvent,
): void {
  requireDeliveryRunner(event, DELIVERY_ACCEPTANCE_RUNNER_ID);
  const taskId = requiredString(event.payload, "taskId");
  const task = current.tasks[taskId];
  if (!task || task.kind === "final_verification" || task.status !== "integrated") {
    throw new Error(`Task acceptance requires integrated task ${taskId}.`);
  }
  if (state.taskAcceptances[taskId]) throw new Error(`Task ${taskId} is already accepted.`);
  const issues = deliveryReviewApprovalIssues(state, task);
  if (issues.length > 0) throw new Error(`Task acceptance is blocked: ${issues.join(" ")}`);
  const review = state.reviews[taskId]!;
  if (requiredString(event.payload, "reviewId") !== review.reviewId) {
    throw new Error("Task acceptance must cite the completed review of the current submission.");
  }
  const boundary = latestBoundary(state, taskId);
  if (
    !boundary || !boundary.passed ||
    boundary.boundaryId !== requiredString(event.payload, "boundaryId") ||
    boundary.integrationRevision !== current.integrationRevision ||
    !testIntegrityBoundaryIsCurrent(current, boundary)
  ) {
    throw new Error("Task acceptance requires a passed boundary check on the current integration revision.");
  }
  const requiredChecks = [
    ...review.criteriaIds.map((criterionId) => {
      const verdict = review.claimVerdicts?.find((candidate) => candidate.claimId === `claim:${criterionId}`);
      if (!verdict || (verdict.status !== "verified" && verdict.disposition?.status !== "verified")) {
        throw new Error(`Criterion ${criterionId} has no verified claim.`);
      }
      return { kind: "criterion", refId: criterionId, outcome: "passed" as const };
    }),
    ...boundary.checks.map((check) => ({ kind: "integration_check", refId: check.checkId, outcome: "passed" as const })),
  ];
  state.taskAcceptances[taskId] = {
    taskId,
    reviewId: review.reviewId,
    submissionAttempt: review.submissionAttempt,
    changeSetId: review.changeSetId,
    boundaryId: boundary.boundaryId,
    integrationRevision: boundary.integrationRevision,
    requiredChecks,
    acceptedAt: event.occurredAt,
    sequence: event.sequence,
  };
}

function deliveryPhaseAccepted(
  current: SchedulerProjection,
  state: DeliveryState,
  event: SchedulerEvent,
): void {
  requireDeliveryRunner(event, DELIVERY_ACCEPTANCE_RUNNER_ID);
  const plan = current.planning?.plan;
  const revision = plan?.revisionsById[plan.currentRevisionId];
  const planRevisionId = requiredString(event.payload, "planRevisionId");
  if (!revision || revision.revisionId !== planRevisionId || !readyPlanIdentity(current)) {
    throw new Error("Phase acceptance must bind the current ready plan revision.");
  }
  const phaseId = requiredString(event.payload, "phaseId");
  const phase = revision.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) throw new Error(`Unknown phase ${phaseId}.`);
  const key = phaseAcceptanceKey(planRevisionId, phaseId);
  if (state.phaseAcceptances[key]) throw new Error(`Phase ${phaseId} is already accepted for ${planRevisionId}.`);
  const evaluation = evaluatePhaseAcceptance({
    phase,
    requirements: revision.requirements,
    taskStatuses: new Map(Object.entries(current.tasks).map(([id, task]) => [id, task.status])),
    state,
    integrationRevision: current.integrationRevision,
  });
  if (!evaluation.ready) {
    throw new Error(`Phase ${phaseId} is not acceptable: ${evaluation.issues.join(" ")}`);
  }
  if (
    !sameValue(stringArray(event.payload, "taskAcceptanceRefs"), evaluation.taskAcceptanceRefs) ||
    !sameValue(event.payload.exitChecks, evaluation.exitChecks)
  ) {
    throw new Error("Phase acceptance must record exactly the kernel-evaluated task acceptances and exit checks.");
  }
  state.phaseAcceptances[key] = {
    phaseId,
    planRevisionId,
    integrationRevision: current.integrationRevision!,
    requirementIds: [...phase.requirementIds],
    taskAcceptanceRefs: evaluation.taskAcceptanceRefs,
    exitChecks: evaluation.exitChecks,
    acceptedAt: event.occurredAt,
    sequence: event.sequence,
  };
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
  // T3a repair cycle 2 (B3): repair tasks are ordinary worker tasks, so on
  // a new-policy run they are planned only under a ready plan (like every
  // other task-adding path) and stamped with its identity below. Checked
  // before the repair cycle is consumed so a refusal spends nothing.
  // T9 (EP39/OA-5): answered runs plan no repairs. Checked before the
  // budget is consumed, like the readiness refusal below.
  if (projection.planningPolicyVersion === 1 && projection.planningTriageDecision === "answer") {
    throw new Error(
      "Answered runs cannot plan repairs; convert to build first."
    );
  }
  // Legacy runs are untouched.
  const repairReady = projection.planningPolicyVersion === 1
    ? readyPlanIdentity(projection)
    : undefined;
  if (projection.planningPolicyVersion === 1 && !repairReady) {
    throw new Error(
      "Final verification repairs on a new-policy run require a ready plan revision."
    );
  }
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
  if (repairReady) {
    // T4: kernel-created repairs stay admissible under the ready plan;
    // the parent contract is recorded when resolvable, otherwise the
    // repair stays identity-bound (legacy-seeded parents).
    const bindings = { ...projection.readyPlanTaskBindings };
    for (const task of tasks) {
      const parent = repairParentContractId(projection, task);
      bindings[task.id] = parent !== undefined
        ? { revisionId: repairReady.revisionId, digest: repairReady.digest, contractId: parent }
        : { revisionId: repairReady.revisionId, digest: repairReady.digest };
    }
    projection.readyPlanTaskBindings = bindings;
  }
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
  const independence = parseReviewerIndependence(event.payload.independence);
  if (
    independence !== "fresh_context" &&
    excludedModels.some((excluded) => excluded.modelIdentity === runtime.modelIdentity)
  ) {
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
    ...(event.payload.independence === undefined ? {} : { independence }),
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

/**
 * T9 repair cycle 2 (B3-r2): the planning-state acknowledgement. A
 * new-policy run with no ready plan has no plan to prove unchanged and no
 * ready plan to reconcile, so the guidance folds into the plan or answer
 * still being drafted — no evidence, no mutation. Accepted only while the
 * run has no ready plan (planning state, or an answered/pre-triage
 * new-policy run): once a ready plan exists, `no_plan_change` (with
 * evidence) and `plan_reconciled` apply unchanged. Legacy runs are refused.
 */
function acceptFoldedIntoPlanningAcknowledgement(
  current: SchedulerProjection,
  resolution: UserGuidanceFoldedIntoPlanningResolution,
): UserGuidanceFoldedIntoPlanningResolution {
  if (current.planningPolicyVersion !== 1) {
    throw new Error(
      "Folded-into-planning acknowledgement requires a new-policy run."
    );
  }
  if (readyPlanIdentity(current)) {
    throw new Error(
      "Folded-into-planning acknowledgement requires no ready plan; cite evidence with no_plan_change or reconcile the plan."
    );
  }
  return { ...resolution };
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
  // T3a repair (B1a): every reconciliation path (plan.reconciled, review or
  // guidance or critique resolutions carrying one) adds or revises tasks, so
  // on a new-policy run each requires a ready plan. This single choke point
  // covers all four callers; none of them mutates planning first, so the
  // identity read here is the pre-event one. Legacy runs are untouched.
  // T9 (EP39/OA-5): answered runs reconcile nothing.
  if (projection.planningPolicyVersion === 1 && projection.planningTriageDecision === "answer") {
    throw new Error(
      "Answered runs cannot reconcile the plan; convert to build first."
    );
  }
  if (projection.planningPolicyVersion === 1 && !readyPlanIdentity(projection)) {
    throw new Error(
      "Plan reconciliation on a new-policy run requires a ready plan revision."
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
    const membership = taskPlanMembership(projection, update.taskId);
    const contract = membership.contractId
      ? projection.planning?.plan?.revisionsById[
          projection.planning.plan.currentRevisionId
        ]?.tasks.find((candidate) => candidate.id === membership.contractId)
      : undefined;
    if (contract) {
      if (
        update.dependencies !== undefined &&
        (
          update.dependencies.length !== contract.dependencies.length ||
          update.dependencies.some(
            (dependency, index) => dependency !== contract.dependencies[index],
          )
        )
      ) {
        throw new Error(
          `Task ${update.taskId} contract dependencies change only through a new ready plan revision.`,
        );
      }
      if (
        update.requiredCapabilities !== undefined ||
        update.acceptanceCriteria !== undefined
      ) {
        throw new Error(
          `Task ${update.taskId} contract fields change only through a new ready plan revision.`,
        );
      }
    }
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
  if (projection.planningPolicyVersion === 1) {
    // T3a repair (B1c): bind tasks added by this reconciliation to the ready
    // plan that authorised it (the entry gate guarantees one exists). Revised
    // tasks keep their original binding: a revision is not a re-review.
    // T4: tasks mapping to a ready contract carry it; the rest stay
    // identity-bound and non-admissible (true membership).
    const ready = readyPlanIdentity(projection);
    const added = reconciliation.newTasks ?? [];
    if (ready && added.length > 0) {
      const plan = projection.planning?.plan;
      const revision = plan?.revisionsById[plan.currentRevisionId];
      const memberIds = new Set(
        (revision?.tasks ?? []).map((contract) => contract.id),
      );
      const bindings = { ...projection.readyPlanTaskBindings };
      for (const task of added) {
        bindings[task.id] = memberIds.has(task.id)
          ? {
              revisionId: ready.revisionId,
              digest: ready.digest,
              contractId: task.id,
            }
          : { revisionId: ready.revisionId, digest: ready.digest };
      }
      projection.readyPlanTaskBindings = bindings;
    }
  }
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

function cloneContextRecording(
  state: ContextRecordingProjection,
): ContextRecordingProjection {
  return {
    notes: state.notes.map((note) => ({
      ...note,
      ...(note.resolution
        ? { resolution: { ...note.resolution, actor: { ...note.resolution.actor } } }
        : {}),
    })),
    ...(state.waiver ? { waiver: { ...state.waiver } } : {}),
  };
}

function applyContextRecordingFailed(
  projection: SchedulerProjection,
  event: SchedulerEvent,
): void {
  if (event.actor.role !== "runner") {
    throw new Error("Only the runner may record a context-manifest failure.");
  }
  const purpose = requiredString(event.payload, "purpose");
  const attempts = requiredPositiveInteger(event.payload, "attempts");
  const reason = requiredString(event.payload, "reason");
  const taskId = optionalContextText(event.payload, "taskId");
  const attempt = optionalContextAttempt(event.payload, "attempt");
  const revision = optionalContextText(event.payload, "revision");
  const notes = projection.contextRecording?.notes ?? [];
  projection.contextRecording = {
    ...(projection.contextRecording?.waiver
      ? { waiver: { ...projection.contextRecording.waiver } }
      : {}),
    notes: [
      ...notes,
      {
        sequence: event.sequence,
        purpose,
        attempts,
        reason,
        ...(taskId ? { taskId } : {}),
        ...(attempt !== undefined ? { attempt } : {}),
        ...(revision ? { revision } : {}),
      },
    ],
  };
}

const PROJECT_DOC_ARTIFACT_HASH = /^[a-f0-9]{64}$/;

function applyProjectDocRequested(
  projection: SchedulerProjection,
  event: SchedulerEvent,
): void {
  if (event.actor.role !== "architect") {
    throw new Error("Only the Architect may request a project document write.");
  }
  const path = requiredString(event.payload, "path");
  const checked = validateProjectDocPath(path);
  if (!checked.ok) {
    throw new Error(`Project document path is refused: ${checked.reason}.`);
  }
  const requestId = requiredString(event.payload, "requestId");
  const contentArtifactHash = requiredString(event.payload, "contentArtifactHash");
  if (!PROJECT_DOC_ARTIFACT_HASH.test(contentArtifactHash)) {
    throw new Error("Project document content hash is invalid.");
  }
  const summary = requiredString(event.payload, "summary");
  if (summary.trim().length === 0) {
    throw new Error("Project document summary is required.");
  }
  const contentBytes = event.payload.contentBytes;
  if (!Number.isSafeInteger(contentBytes) || (contentBytes as number) < 0) {
    throw new Error("Project document content size is invalid.");
  }
  if ((contentBytes as number) > PROJECT_DOC_MAX_BYTES) {
    throw new Error(`Project document content exceeds ${PROJECT_DOC_MAX_BYTES} bytes.`);
  }
  const pending = projection.projectDocs?.pending ?? [];
  if (pending.some((request) => request.requestId === requestId)) {
    throw new Error(`Project document request ${requestId} is already recorded.`);
  }
  projection.projectDocs = {
    pending: [
      ...pending,
      {
        requestId,
        path: checked.path,
        contentArtifactHash,
        contentBytes: contentBytes as number,
        summary,
        sequence: event.sequence,
      },
    ],
    ...carriedProjectDocs(projection.projectDocs),
  };
}

function applyProjectDocCommitted(
  projection: SchedulerProjection,
  event: SchedulerEvent,
): void {
  if (event.actor.role !== "runner") {
    throw new Error("Only the runner may commit a project document.");
  }
  const requestId = requiredString(event.payload, "requestId");
  const path = requiredString(event.payload, "path");
  const checked = validateProjectDocPath(path);
  if (!checked.ok) {
    throw new Error(`Project document path is refused: ${checked.reason}.`);
  }
  const pending = projection.projectDocs?.pending ?? [];
  const request = pending.find((item) => item.requestId === requestId);
  if (!request) {
    throw new Error(`Project document request ${requestId} is not pending.`);
  }
  if (request.path !== checked.path) {
    throw new Error(`Project document commit path does not match request ${requestId}.`);
  }
  const committed = projection.projectDocs?.committed ?? [];
  if (committed.some((item) => item.requestId === requestId)) {
    throw new Error(`Project document request ${requestId} is already committed.`);
  }
  const record: ProjectDocCommitProjection = {
    requestId,
    path: checked.path,
    commit: requiredString(event.payload, "commit"),
    parent: requiredString(event.payload, "parent"),
    head: requiredString(event.payload, "head"),
    readme: requiredBoolean(event.payload, "readme"),
    agentsMarkedSection: requiredBoolean(event.payload, "agentsMarkedSection"),
    claudePointer: requiredBoolean(event.payload, "claudePointer"),
    sequence: event.sequence,
  };
  const canonical = projection.integrationRevision;
  const currentTip = projection.projectDocs?.documentTip;
  const continuesDocuments =
    (typeof canonical === "string" && record.parent === canonical) ||
    (typeof currentTip === "string" && record.parent === currentTip);
  projection.projectDocs = {
    pending: pending.filter((item) => item.requestId !== requestId),
    committed: [...committed, record],
    ...(continuesDocuments
      ? { documentTip: record.commit }
      : currentTip
        ? { documentTip: currentTip }
        : {}),
    ...(projection.projectDocs?.abandoned
      ? { abandoned: projection.projectDocs.abandoned.map((item) => ({ ...item })) }
      : {}),
  };
}

/**
 * C2a: the v2 handoff gate. A docs-v2 run that is not answered cannot record
 * `project.handoff_selected` or `run.completed` until the kernel committed
 * docs/project/STATE.md for the handed-off revision. The writer guarantees
 * the tree holds STATE.md; the reducer checks the recorded paths.
 *
 * C2a repair (M1): the gate binds to the latest `project.handoff_requested`
 * stop (`projectHandoff.requestedSequence`), never to an earlier snapshot:
 * after a withdrawal and re-request, only a snapshot for the current stop
 * satisfies it.
 *
 * C2b (AR-R05): the current-stop record must also carry the commit-tree
 * proof that the commit holds the marked v2 AGENTS.md section and the
 * marked `@AGENTS.md` line (read back from the commit by the writer, never
 * the checkout). README is not required under v2.
 */
/**
 * C3a (AR-R08; packet C3 steps 1, 2 and 4): the stop table. Every
 * transition into `paused`, every cancel and every terminal failure, with
 * the snapshot stop kind C3a renders and whether the stop reason allows
 * model calls. C3b reads this table for the Architect stop notes; C3a
 * always renders "no notes". Unknown runner-recorded reasons are
 * notes-denied by default (fail closed). The handoff request is C2's
 * stop, not this one's: while a handoff is requested the runner stands
 * down and C2's kernel commit owns the stop.
 */
export type StopSnapshotStopKind = "paused" | "cancelled" | "failed";

export type StopSnapshotNotesPolicy = "allowed" | "denied";

export interface StopSnapshotTableEntry {
  /** Pause reason, failure reason, or stop event, as recorded in the log. */
  readonly stop: string;
  /** Where the stop is recorded. */
  readonly site: string;
  /** The stop kind the snapshot renders. */
  readonly stopKind: StopSnapshotStopKind;
  /** Whether the stop reason allows the stop-notes model call. */
  readonly notes: StopSnapshotNotesPolicy;
  /** Why this classification. */
  readonly note: string;
}

export const STOP_SNAPSHOT_TABLE: readonly StopSnapshotTableEntry[] = [
  { stop: "repair_cycle_limit", site: "scheduler-store.ts repair.cycle_limit_reached (build-runtime.ts pauseIfRepairCyclesExhausted)", stopKind: "paused", notes: "allowed", note: "Repair limit: the owner decides, model calls still work." },
  { stop: "repair_issue_paused:<issueId> (repair:budget_exhausted:<detail>)", site: "scheduler-store.ts repair.issue_paused (build-runtime.ts pauseOnRepairIssue)", stopKind: "paused", notes: "allowed", note: "Repair limit: the owner decides, model calls still work." },
  { stop: "repair_issue_paused:<issueId> (repair:external_blocker:<detail>)", site: "scheduler-store.ts repair.issue_paused (build-runtime.ts pauseOnRepairIssue)", stopKind: "paused", notes: "allowed", note: "External blocker: the owner/Architect decide, model calls still work." },
  { stop: "repair_issue_paused:<issueId> (repair:approach_failed:<detail>)", site: "scheduler-store.ts repair.issue_paused (build-runtime.ts pauseOnRepairIssue)", stopKind: "paused", notes: "allowed", note: "A failed repair approach still leaves model calls working." },
  { stop: "context_recording_failed", site: "build-runtime.ts recordContextRecordingFailure (run.paused)", stopKind: "paused", notes: "allowed", note: "Recording machinery failed; a notes call does not depend on it." },
  { stop: "delivery_review_failed", site: "build-runtime.ts pauseForDeliveryGate", stopKind: "paused", notes: "allowed", note: "Failed verification/review: the Architect decides next, model calls still work." },
  { stop: "delivery_boundary_unavailable", site: "build-runtime.ts pauseForDeliveryGate", stopKind: "paused", notes: "denied", note: "The boundary environment is unavailable: a model call cannot help." },
  { stop: "delivery_<other>", site: "build-runtime.ts pauseForDeliveryGate", stopKind: "paused", notes: "denied", note: "Unrecognized delivery reason: denied by default." },
  { stop: "coverage_reviewer_unavailable", site: "build-runtime.ts pauseForCoverageGate (run.paused)", stopKind: "paused", notes: "denied", note: "Provider failure: no reviewer runtime could be reached." },
  { stop: "answer_reviewer_unavailable", site: "build-runtime.ts pauseForAnswerReviewGate (run.paused)", stopKind: "paused", notes: "denied", note: "Provider failure: no reviewer runtime could be reached." },
  { stop: "owner pause (run.paused, actor user, any other reason)", site: "build-runtime.ts pause", stopKind: "paused", notes: "allowed", note: "Owner pause: the owner is present, model calls still work." },
  { stop: "owner_cancelled (run.paused)", site: "build-runtime.ts pause", stopKind: "cancelled", notes: "denied", note: "Cancel: the run is over, notes are pointless." },
  { stop: "verifier.selection_required", site: "scheduler-store.ts verifier.selection_required (build-runtime.ts driveIndependentVerifier)", stopKind: "paused", notes: "denied", note: "No verifier runtime is selected; fail closed until the owner selects one." },
  { stop: "architect.handoff_required", site: "scheduler-store.ts architect.handoff_required (native-architect-runtime.ts requireArchitectHandoff)", stopKind: "paused", notes: "denied", note: "No Architect runtime is active; a notes call cannot run." },
  { stop: "no_mechanical_progress", site: "native-build-manager.ts pump (run.paused, actor user)", stopKind: "paused", notes: "denied", note: "Runner-originated idle pause: a notes call cannot help." },
  { stop: "autonomous_pump_error", site: "native-build-manager.ts pump (run.paused, actor user)", stopKind: "paused", notes: "denied", note: "Runner-originated pump error: fail closed." },
  { stop: "budget_exhausted:<scope> (run.paused)", site: "build-runtime.ts pause", stopKind: "paused", notes: "denied", note: "Budget window exhausted: no budget remains for a notes call." },
  { stop: "<reason mentioning a provider or credit failure>", site: "any run.paused", stopKind: "paused", notes: "denied", note: "Provider or credit failure: a notes call cannot run." },
  { stop: "Exceptional process recovery requires an exact decision or cleanup proof.", site: "scheduler-store.ts process.recovery_updated", stopKind: "paused", notes: "allowed", note: "Recovery needs an exact decision; model calls still work." },
  { stop: "context_recording_aborted", site: "scheduler-store.ts context_manifest.recording_resolved (abort)", stopKind: "failed", notes: "denied", note: "Terminal failure: the run is over, notes are pointless." },
  { stop: "handoff_snapshot_failed", site: "build-runtime.ts pauseForHandoffSnapshotFailure (run.paused)", stopKind: "paused", notes: "denied", note: "Not snapshotted here at all: C2 retries that commit itself (skip rule)." },
  { stop: "<unknown runner-recorded reason>", site: "any stop event", stopKind: "paused", notes: "denied", note: "Unknown reasons are denied by default (fail closed)." },
];

/** C3a: the owner-cancel pause reason. `BuildRuntime.pause` takes any reason; this one renders stop kind `cancelled`. */
export const STOP_SNAPSHOT_OWNER_CANCEL_REASON = "owner_cancelled";

/** C3a: the exceptional-recovery pause reason (scheduler-store.ts `process.recovery_updated`). */
export const EXCEPTIONAL_RECOVERY_PAUSE_REASON = "Exceptional process recovery requires an exact decision or cleanup proof.";

/**
 * C3a: classify a stop for the snapshot (stop kind) and the C3b stop
 * notes (allowed/denied). Provenance comes from the stop event's actor:
 * an owner-recorded pause (`user`) is allowed unless the reason names a
 * cancel, an exhausted budget, or a provider/credit failure; a
 * runner-recorded stop must match an allowed entry, else denied.
 */
export function classifyStopSnapshot(options: {
  status: "paused" | "failed" | "stopped";
  reason?: string;
  detail?: string;
  ownerInitiated: boolean;
}): { stopKind: StopSnapshotStopKind; notes: StopSnapshotNotesPolicy } {
  if (options.status === "failed") return { stopKind: "failed", notes: "denied" };
  if (options.status === "stopped") return { stopKind: "cancelled", notes: "denied" };
  const reason = options.reason;
  if (reason === STOP_SNAPSHOT_OWNER_CANCEL_REASON) return { stopKind: "cancelled", notes: "denied" };
  if (reason !== undefined && reason.startsWith("budget_exhausted")) return { stopKind: "paused", notes: "denied" };
  if (reason !== undefined) {
    const lowered = reason.toLowerCase();
    if (lowered.includes("provider") || lowered.includes("credit")) return { stopKind: "paused", notes: "denied" };
  }
  if (reason === "repair_cycle_limit") return { stopKind: "paused", notes: "allowed" };
  if (reason !== undefined && reason.startsWith("repair_issue_paused:")) {
    const cause = /^repair:(budget_exhausted|external_blocker|approach_failed):/.exec(options.detail ?? "")?.[1];
    return cause === undefined
      ? { stopKind: "paused", notes: "denied" }
      : { stopKind: "paused", notes: "allowed" };
  }
  if (reason === "context_recording_failed") return { stopKind: "paused", notes: "allowed" };
  if (reason === "delivery_review_failed") return { stopKind: "paused", notes: "allowed" };
  if (reason === "delivery_boundary_unavailable") return { stopKind: "paused", notes: "denied" };
  if (reason !== undefined && reason.startsWith("delivery_")) return { stopKind: "paused", notes: "denied" };
  if (reason === "coverage_reviewer_unavailable" || reason === "answer_reviewer_unavailable") {
    return { stopKind: "paused", notes: "denied" };
  }
  if (reason === EXCEPTIONAL_RECOVERY_PAUSE_REASON) return { stopKind: "paused", notes: "allowed" };
  if (reason === "handoff_snapshot_failed") return { stopKind: "paused", notes: "denied" };
  // C3a repair cycle 1 (M-2, M-3): reason first. The selection/handoff
  // gates and the pump's own pauses are denied even when the stop event
  // carries the owner actor (the pump records through pause(), actor
  // `user`); the owner actor makes an unknown reason allowed only when it
  // is not one of these known runner reasons.
  if (reason === "verifier.selection_required") return { stopKind: "paused", notes: "denied" };
  if (reason === "architect.handoff_required") return { stopKind: "paused", notes: "denied" };
  if (reason === "no_mechanical_progress") return { stopKind: "paused", notes: "denied" };
  if (reason === "autonomous_pump_error") return { stopKind: "paused", notes: "denied" };
  if (options.ownerInitiated) return { stopKind: "paused", notes: "allowed" };
  return { stopKind: "paused", notes: "denied" };
}

/**
 * C3b repair cycle 1 (R1-3): the pause-typed events that can record a
 * stopped transition. Mirrors the runtime's `findCurrentStopEvent` set
 * (build-runtime.ts): C2's `project.handoff_requested` is never a stop
 * here, and only events that actually leave the run stopped are recorded.
 */
const STOP_TRANSITION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "run.paused",
  "repair.issue_paused",
  "repair.cycle_limit_reached",
  "context_manifest.recording_failed",
  "context_manifest.recording_resolved",
  "verifier.selection_required",
  "architect.handoff_required",
  "process.recovery_updated",
]);

/** C3b repair cycle 1 (R1-3): whether an event type can record a stopped transition. */
function isStopTransitionEventType(type: string): boolean {
  return STOP_TRANSITION_EVENT_TYPES.has(type);
}

/** C3a: whether a stopKind value is a stop-snapshot kind (paused/cancelled/failed) rather than a handoff kind. */
export function isStopSnapshotStopKind(value: string): value is StopSnapshotStopKind {
  return value === "paused" || value === "cancelled" || value === "failed";
}

/**
 * C3a: the stop-sequence rule for `project_docs.handoff_snapshot_committed`,
 * shared by handoff and stop snapshots. Handoff kinds keep the C2 rule (the
 * current request's stop or a withdrawn stop); stop kinds require a genuine
 * stop -- the run is paused, failed or stopped at this point in the log.
 * History-only either way: a stop sequence never equals a handoff
 * requestedSequence, so a stop record never satisfies the AR-R05 gate.
 */
export function isAcceptedSnapshotStopSequence(
  projection: SchedulerProjection,
  event: SchedulerEvent,
  stopSequence: number,
  requestedSequence: number | undefined,
  withdrawnStop: boolean,
): boolean {
  const stopKind = event.payload.stopKind;
  if (typeof stopKind === "string" && isStopSnapshotStopKind(stopKind)) {
    return projection.status === "paused" || projection.status === "failed" || projection.status === "stopped";
  }
  return stopSequence === requestedSequence || withdrawnStop;
}

/**
 * C3a (AR-R08 skip rule, CD-9/CD-5): why a stop has no snapshot commit.
 * A commit failure is recorded here too, as `commit_failed: <cause>` --
 * the finding that lets the stop proceed -- and a landed-but-unrecorded
 * commit as `record_failed: <commit>: <cause>` -- so one record per stop
 * sequence covers every no-commit outcome and no stop is ever retried.
 */
export type StopSnapshotSkipReason =
  | "pre_triage"
  | "clarify_pending"
  | "answered_run"
  | "export_only"
  | "handoff_snapshot_failed";

/** C3a: the skip-rule reasons (commit failures travel as `commit_failed: <cause>`, landed-but-unrecorded commits as `record_failed: <commit>: <cause>`). */
export function isStopSnapshotSkipReason(value: unknown): value is StopSnapshotSkipReason {
  return value === "pre_triage" ||
    value === "clarify_pending" ||
    value === "answered_run" ||
    value === "export_only" ||
    value === "handoff_snapshot_failed";
}

/** C3a: one no-commit record per stop sequence, in append order. */
export interface StopSnapshotSkipRecord {
  stopSequence: number;
  stopKind: StopSnapshotStopKind;
  reason: string;
  sequence: number;
}

/** C3a: the maximum stored skip-reason length (the CD-9/CD-5 reasons are short; commit causes are pre-bounded). */
export const STOP_SNAPSHOT_SKIP_REASON_MAX_LENGTH = 500;

function applyStopSnapshotSkipped(
  projection: SchedulerProjection,
  event: SchedulerEvent,
): void {
  if (event.actor.role !== "runner") {
    throw new Error("Only the runner may record a stop snapshot skip.");
  }
  if (projection.projectDocsPolicyVersion !== 2) {
    throw new Error("Stop snapshot skips require project document policy version 2.");
  }
  const stopSequence = requiredPositiveInteger(event.payload, "stopSequence");
  const stopKind = requiredString(event.payload, "stopKind");
  if (!isStopSnapshotStopKind(stopKind)) {
    throw new Error(`Stop snapshot skip stop kind ${stopKind} is invalid.`);
  }
  const reason = requiredString(event.payload, "reason");
  if (!reason.trim() || reason.length > STOP_SNAPSHOT_SKIP_REASON_MAX_LENGTH) {
    throw new Error("Stop snapshot skip reason is invalid.");
  }
  if (!isStopSnapshotSkipReason(reason) && !reason.startsWith("commit_failed") && !reason.startsWith("record_failed")) {
    throw new Error(`Stop snapshot skip reason ${reason} is invalid.`);
  }
  const skips = projection.projectDocs?.stopSnapshotSkips ?? [];
  if (skips.some((record) => record.stopSequence === stopSequence)) {
    throw new Error(`Stop snapshot skip for stop ${stopSequence} is already recorded.`);
  }
  if ((projection.projectDocs?.snapshots ?? []).some((record) => record.stopSequence === stopSequence)) {
    throw new Error(`Stop ${stopSequence} already has a snapshot commit.`);
  }
  projection.projectDocs = {
    pending: projection.projectDocs?.pending ?? [],
    ...carriedProjectDocs(projection.projectDocs),
    stopSnapshotSkips: [...skips, { stopSequence, stopKind, reason, sequence: event.sequence }],
  };
}

/**
 * C3b repair cycle 1 (R1-3): one stopped transition with the stop-time
 * facts stop-notes validation needs. `status` is the run status the stop
 * left; `reason`/`detail` mirror the stop's `pauseReason` when it has one;
 * `ownerInitiated` mirrors the stop event's actor; `triage` and
 * `handoffFiles` are the skip-rule inputs at the stop.
 */
export interface StopTransitionRecord {
  sequence: number;
  type: string;
  status: "paused" | "failed" | "stopped";
  reason?: string;
  detail?: string;
  ownerInitiated: boolean;
  triage?: PlanningTriageDecision;
  handoffFiles?: HandoffFilesOption;
}

/** C3b repair cycle 1 (R1-2): one durable stop-notes attempt marker per stop sequence, in append order. */
export interface StopNoteAttemptRecord {
  stopSequence: number;
  stopKind: StopSnapshotStopKind;
  sequence: number;
}

/** C3b repair cycle 1 (R1-2): one durable failed stop-notes attempt outcome per stop sequence, in append order. */
export interface StopNoteFailureRecord {
  stopSequence: number;
  reason: string;
  sequence: number;
}

/**
 * C3b repair cycle 1 (R1-2): the maximum stored stop-notes failure-reason
 * length. Failure reasons render as the snapshot's no-notes line, so they
 * stay short like the skip reasons.
 */
export const STOP_NOTES_FAILED_REASON_MAX_LENGTH = 500;

/** C3b repair cycle 1 (R1-2): the attempt marker recorded for a stop, if any. */
export function stopNotesAttemptForStop(
  projection: SchedulerProjection,
  stopSequence: number,
): StopNoteAttemptRecord | undefined {
  return (projection.projectDocs?.stopNoteAttempts ?? []).find(
    (record) => record.stopSequence === stopSequence,
  );
}

/** C3b repair cycle 1 (R1-2): the failed-attempt outcome recorded for a stop, if any. */
export function stopNotesFailureForStop(
  projection: SchedulerProjection,
  stopSequence: number,
): StopNoteFailureRecord | undefined {
  return (projection.projectDocs?.stopNoteFailures ?? []).find(
    (record) => record.stopSequence === stopSequence,
  );
}

/**
 * C3b repair cycle 1 (R1-3): link a stop-notes reference to an EXISTING
 * actual stopped transition of this run and validate eligibility at that
 * stop. Rejects arbitrary, future and non-stop sequences (no such
 * transition exists), skipped stops (the C3a triage/answered/export_only
 * skip rules, decided from the stop-time facts) and denied stops (the C3a
 * classification at the stop). Authority facts only: the tracked stop
 * record, never model-supplied labels.
 */
function requireEligibleNotesStop(
  projection: SchedulerProjection,
  stopSequence: number,
): StopTransitionRecord {
  const stop = (projection.stopTransitions ?? []).find((record) => record.sequence === stopSequence);
  if (!stop) {
    throw new Error(`Stop notes require an existing stopped transition (stop ${stopSequence} is not a stop).`);
  }
  const skip = stop.triage !== "build"
    ? stop.triage === "clarify" ? "clarify_pending" : stop.triage === "answer" ? "answered_run" : "pre_triage"
    : stop.handoffFiles !== undefined && stop.handoffFiles !== "commit"
      ? "export_only"
      : stop.reason === "handoff_snapshot_failed"
        ? "handoff_snapshot_failed"
        : undefined;
  if (skip !== undefined) {
    throw new Error(`Stop ${stopSequence} cannot record stop notes (${skip}).`);
  }
  const classified = classifyStopSnapshot({
    status: stop.status,
    ...(stop.reason !== undefined ? { reason: stop.reason } : {}),
    ...(stop.detail !== undefined ? { detail: stop.detail } : {}),
    ownerInitiated: stop.ownerInitiated,
  });
  if (classified.notes !== "allowed") {
    throw new Error(`Stop ${stopSequence} does not allow stop notes.`);
  }
  return stop;
}

/** C3b: one Architect stop-notes record per stop sequence, in append order. */
export interface StopNotesRecord {
  stopSequence: number;
  notes: string;
  sequence: number;
}

/**
 * C3b (AR-R09): the maximum stored stop-notes length. Matches the C1 notes
 * cap (HANDOFF_SNAPSHOT_NOTES_MAX_LENGTH) so a recorded note always renders
 * in full; the notes call truncates to this bound before recording.
 */
export const STOP_NOTES_MAX_LENGTH = 2000;

/** C3b: the Architect stop notes recorded for a stop, if any. */
export function stopNotesForStop(projection: SchedulerProjection, stopSequence: number): StopNotesRecord | undefined {
  return (projection.projectDocs?.stopNotes ?? []).find((record) => record.stopSequence === stopSequence);
}

function applyHandoffNotesRecorded(
  projection: SchedulerProjection,
  event: SchedulerEvent,
): void {
  if (event.actor.role !== "architect") {
    throw new Error("Only the Architect may record stop notes.");
  }
  if (typeof event.actor.id !== "string" || !event.actor.id.trim()) {
    throw new Error("Stop notes require an Architect runtime actor.");
  }
  if (projection.projectDocsPolicyVersion !== 2) {
    throw new Error("Stop notes require project document policy version 2.");
  }
  const stopSequence = requiredPositiveInteger(event.payload, "stopSequence");
  // C3b repair cycle 1 (R1-3): the notes must link to an existing eligible
  // stop of this run -- arbitrary, future, non-stop, skipped and
  // denied-stop references are refused here.
  requireEligibleNotesStop(projection, stopSequence);
  const notes = requiredString(event.payload, "notes");
  if (!notes.trim() || notes.length > STOP_NOTES_MAX_LENGTH) {
    throw new Error("Stop notes text is invalid.");
  }
  const existing = projection.projectDocs?.stopNotes ?? [];
  if (existing.some((record) => record.stopSequence === stopSequence)) {
    throw new Error(`Stop notes for stop ${stopSequence} are already recorded.`);
  }
  if ((projection.projectDocs?.stopNoteFailures ?? []).some((record) => record.stopSequence === stopSequence)) {
    throw new Error(`Stop ${stopSequence} already has a failed stop notes attempt.`);
  }
  if ((projection.projectDocs?.snapshots ?? []).some((record) => record.stopSequence === stopSequence)) {
    throw new Error(`Stop ${stopSequence} already has a snapshot commit.`);
  }
  if ((projection.projectDocs?.stopSnapshotSkips ?? []).some((record) => record.stopSequence === stopSequence)) {
    throw new Error(`Stop ${stopSequence} already has a stop snapshot skip.`);
  }
  projection.projectDocs = {
    pending: projection.projectDocs?.pending ?? [],
    ...carriedProjectDocs(projection.projectDocs),
    stopNotes: [...existing, { stopSequence, notes, sequence: event.sequence }],
  };
}

/**
 * C3b repair cycle 1 (R1-2): the durable per-stop attempt marker, recorded
 * by the runner BEFORE the model call. The stop link and eligibility are
 * validated exactly like the notes themselves, and the recorded stop kind
 * must match the stop's classification, so the marker binds to the actual
 * stop identity. A recorded marker (with or without a terminal outcome)
 * means no second external call for the stop, ever.
 */
function applyHandoffNotesAttempted(
  projection: SchedulerProjection,
  event: SchedulerEvent,
): void {
  if (event.actor.role !== "runner") {
    throw new Error("Only the runner may record a stop notes attempt.");
  }
  if (projection.projectDocsPolicyVersion !== 2) {
    throw new Error("Stop notes attempts require project document policy version 2.");
  }
  const stopSequence = requiredPositiveInteger(event.payload, "stopSequence");
  const stop = requireEligibleNotesStop(projection, stopSequence);
  const stopKind = requiredString(event.payload, "stopKind");
  if (!isStopSnapshotStopKind(stopKind)) {
    throw new Error(`Stop notes attempt stop kind ${stopKind} is invalid.`);
  }
  const classified = classifyStopSnapshot({
    status: stop.status,
    ...(stop.reason !== undefined ? { reason: stop.reason } : {}),
    ...(stop.detail !== undefined ? { detail: stop.detail } : {}),
    ownerInitiated: stop.ownerInitiated,
  });
  if (classified.stopKind !== stopKind) {
    throw new Error(`Stop notes attempt stop kind ${stopKind} does not match stop ${stopSequence}.`);
  }
  const existing = projection.projectDocs?.stopNoteAttempts ?? [];
  if (existing.some((record) => record.stopSequence === stopSequence)) {
    throw new Error(`Stop notes attempt for stop ${stopSequence} is already recorded.`);
  }
  if ((projection.projectDocs?.stopNotes ?? []).some((record) => record.stopSequence === stopSequence)) {
    throw new Error(`Stop ${stopSequence} already has stop notes recorded.`);
  }
  if ((projection.projectDocs?.stopNoteFailures ?? []).some((record) => record.stopSequence === stopSequence)) {
    throw new Error(`Stop ${stopSequence} already has a failed stop notes attempt.`);
  }
  if ((projection.projectDocs?.snapshots ?? []).some((record) => record.stopSequence === stopSequence)) {
    throw new Error(`Stop ${stopSequence} already has a snapshot commit.`);
  }
  if ((projection.projectDocs?.stopSnapshotSkips ?? []).some((record) => record.stopSequence === stopSequence)) {
    throw new Error(`Stop ${stopSequence} already has a stop snapshot skip.`);
  }
  projection.projectDocs = {
    pending: projection.projectDocs?.pending ?? [],
    ...carriedProjectDocs(projection.projectDocs),
    stopNoteAttempts: [...existing, { stopSequence, stopKind, sequence: event.sequence }],
  };
}

/**
 * C3b repair cycle 1 (R1-2): the durable failed-attempt outcome. Recorded
 * by the runner after a failed call (or an unusable empty result) so the
 * failure reason survives a crash before snapshot persistence and replay
 * renders it without ever issuing a second call. Requires the prior
 * attempt marker: outcomes never precede attempts.
 */
function applyHandoffNotesFailed(
  projection: SchedulerProjection,
  event: SchedulerEvent,
): void {
  if (event.actor.role !== "runner") {
    throw new Error("Only the runner may record a failed stop notes attempt.");
  }
  if (projection.projectDocsPolicyVersion !== 2) {
    throw new Error("Failed stop notes attempts require project document policy version 2.");
  }
  const stopSequence = requiredPositiveInteger(event.payload, "stopSequence");
  requireEligibleNotesStop(projection, stopSequence);
  const reason = requiredString(event.payload, "reason");
  if (!reason.trim() || reason.length > STOP_NOTES_FAILED_REASON_MAX_LENGTH) {
    throw new Error("Stop notes failure reason is invalid.");
  }
  if (!(projection.projectDocs?.stopNoteAttempts ?? []).some((record) => record.stopSequence === stopSequence)) {
    throw new Error(`Stop ${stopSequence} has no stop notes attempt to fail.`);
  }
  const existing = projection.projectDocs?.stopNoteFailures ?? [];
  if (existing.some((record) => record.stopSequence === stopSequence)) {
    throw new Error(`Stop notes failure for stop ${stopSequence} is already recorded.`);
  }
  if ((projection.projectDocs?.stopNotes ?? []).some((record) => record.stopSequence === stopSequence)) {
    throw new Error(`Stop ${stopSequence} already has stop notes recorded.`);
  }
  if ((projection.projectDocs?.snapshots ?? []).some((record) => record.stopSequence === stopSequence)) {
    throw new Error(`Stop ${stopSequence} already has a snapshot commit.`);
  }
  if ((projection.projectDocs?.stopSnapshotSkips ?? []).some((record) => record.stopSequence === stopSequence)) {
    throw new Error(`Stop ${stopSequence} already has a stop snapshot skip.`);
  }
  projection.projectDocs = {
    pending: projection.projectDocs?.pending ?? [],
    ...carriedProjectDocs(projection.projectDocs),
    stopNoteFailures: [...existing, { stopSequence, reason, sequence: event.sequence }],
  };
}

export function handoffSnapshotAtCurrentStop(
  projection: SchedulerProjection,
): HandoffSnapshotRecord | undefined {
  const snapshots = projection.projectDocs?.snapshots ?? [];
  const latestRequest = projection.projectHandoff?.requestedSequence;
  // C2b repair N-7: without a request there is no current stop, so the
  // fallback never selects a record -- not even a history one.
  if (latestRequest === undefined) return undefined;
  const current = snapshots.filter((record) => record.stopSequence === latestRequest).reverse();
  // C2c (NF-2/CD-15): each entry file counts as satisfied by its committed
  // flag or by its recorded link reason; STATE.md stays required.
  // C2c repair CD-17: a recorded STATE.md link reason satisfies STATE.md
  // the way export_only satisfies the whole gate.
  return current.find((record) =>
    (record.paths.includes("docs/project/STATE.md") || typeof record.stateSkippedReason === "string") &&
    (record.agentsSectionCommitted === true || typeof record.agentsSectionViaLink === "string") &&
    (record.claudeLineCommitted === true || typeof record.claudeLineViaLink === "string"),
  );
}

export function handoffSnapshotCoversRevision(
  projection: SchedulerProjection,
  revision: string,
): boolean {
  const record = handoffSnapshotAtCurrentStop(projection);
  if (!record) return false;
  // Production selects the post-snapshot head (CD-11): it matches the
  // snapshot commit/head, while the described revision matches revision.
  return record.revision === revision || record.commit === revision || record.head === revision;
}

export function handoffSnapshotRecorded(projection: SchedulerProjection): boolean {
  return handoffSnapshotAtCurrentStop(projection) !== undefined;
}

export function assertHandoffSnapshotGate(
  projection: SchedulerProjection,
  revision: string | undefined,
): void {
  if (isAnsweredRun(projection) || projection.projectDocsPolicyVersion !== 2) return;
  // C2b (CD-5): an `export_only` run writes no handoff file at any stop; the
  // gate is satisfied by the recorded run option itself.
  if (handoffFilesOf(projection) === "export_only") return;
  const covered = projection.runPolicy === "plan_only" || revision === undefined
    ? handoffSnapshotRecorded(projection)
    : handoffSnapshotCoversRevision(projection, revision);
  if (!covered) {
    throw new Error("The kernel handoff snapshot is required for the handed-off revision.");
  }
}

/**
 * C2b (N1): the ONE kernel acceptance rule for a handoff selection. The
 * `project.handoff_selected` reducer and the manager pre-check call this
 * same predicate with the same revision, so a selection the manager lets
 * through can never be refused after the project was mutated: the revision
 * must still be the verified integration revision or the document tip
 * (continuing the chain), and the v2 snapshot gate must hold for it.
 */
export function assertProjectHandoffSelectionAccepted(
  projection: SchedulerProjection,
  selectedIntegrationRevision: string | undefined,
): void {
  // C2b repair m6: the pre-check IS the whole acceptance rule, so the
  // context-recording and acceptance-contract refusals live here -- not
  // beside the reducer case -- and the manager refuses them before any
  // project mutation too.
  rejectCompletionWhileContextRecordingUnresolved(projection);
  if (
    projection.acceptanceContractStatus === "acceptance_contract_upgrade_required" &&
    projection.acceptanceUpgradeRequiredEventRecorded
  ) {
    throw new Error(
      "Final project handoff is blocked until the Architect upgrades acceptance criteria for every non-cancelled task."
    );
  }
  assertBuildCompletionReady(projection);
  // T9 (EP39): answered runs have no integration revision to match —
  // exempt like plan_only (the field stays required, the match is off).
  if (
    projection.runPolicy !== "plan_only" &&
    !isAnsweredRun(projection) &&
    (typeof selectedIntegrationRevision !== "string" ||
      !revisionMatchesIntegrationOrDocumentTip(projection, selectedIntegrationRevision))
  ) {
    throw new Error(
      "Final project handoff selection does not match the verified integration revision.",
    );
  }
  assertHandoffSnapshotGate(projection, selectedIntegrationRevision);
}

function applyHandoffSnapshotCommitted(
  projection: SchedulerProjection,
  event: SchedulerEvent,
): void {
  if (event.actor.role !== "runner") {
    throw new Error("Only the runner may commit a handoff snapshot.");
  }
  if (projection.projectDocsPolicyVersion !== 2) {
    throw new Error("Handoff snapshots require project document policy version 2.");
  }
  const stopSequence = requiredPositiveInteger(event.payload, "stopSequence");
  // C2b (N1 probe F): a kernel snapshot commit that landed is always
  // recorded -- it moves the document tip -- even when user guidance
  // withdrew the handoff while the commit was in flight. The withdrawn
  // stop is recognized through the handoff history; such a record never
  // satisfies a later gate (the gate binds to the latest request), but the
  // chain stays continuous.
  // C2b repair N-3: a record is accepted only for the current request's
  // stop or a withdrawn stop's requestedSequence. A sequence that is no
  // stop at all (probe R) is refused even while a handoff is requested.
  const requestedSequence = projection.projectHandoff?.status === "requested"
    ? projection.projectHandoff.requestedSequence
    : undefined;
  const withdrawnStop = (projection.projectHandoffHistory ?? []).some(
    (handoff) => handoff.requestedSequence === stopSequence,
  );
  if (!isAcceptedSnapshotStopSequence(projection, event, stopSequence, requestedSequence, withdrawnStop)) {
    throw new Error("Handoff snapshots require a requested project handoff.");
  }
  const stopKind = requiredString(event.payload, "stopKind");
  if (stopKind !== "completed" && stopKind !== "plan_only" && !isStopSnapshotStopKind(stopKind)) {
    throw new Error(`Handoff snapshot stop kind ${stopKind} is invalid.`);
  }
  const revision = requiredString(event.payload, "revision");
  const commit = requiredString(event.payload, "commit");
  const parent = requiredString(event.payload, "parent");
  const head = requiredString(event.payload, "head");
  if (!revision.trim() || !commit.trim() || !parent.trim() || !head.trim()) {
    throw new Error("Handoff snapshot revision and commit references are required.");
  }
  // C2c repair CD-17: a linked directory above STATE.md skips the file
  // with a recorded reason; the gate accepts it the way it accepts
  // export_only. With the reason present the paths may omit STATE.md and
  // there is no body digest to record ("").
  const stateSkipped = event.payload.stateSkippedReason;
  if (stateSkipped !== undefined && (typeof stateSkipped !== "string" || !stateSkipped.trim())) {
    throw new Error("Handoff snapshot stateSkippedReason is invalid.");
  }
  let bodyDigest: string;
  if (typeof stateSkipped === "string") {
    const rawDigest = event.payload.bodyDigest;
    if (rawDigest !== undefined && rawDigest !== "" && (typeof rawDigest !== "string" || !/^[a-f0-9]{64}$/.test(rawDigest))) {
      throw new Error("Handoff snapshot body digest is invalid.");
    }
    bodyDigest = typeof rawDigest === "string" ? rawDigest : "";
  } else {
    bodyDigest = requiredString(event.payload, "bodyDigest");
    if (!/^[a-f0-9]{64}$/.test(bodyDigest)) {
      throw new Error("Handoff snapshot body digest is invalid.");
    }
  }
  const paths = stringArray(event.payload, "paths");
  // C2c round 3 (NB-4): with STATE.md skipped for a recorded reason and the
  // entry files already holding their sections, the kernel commit is empty
  // and records no paths; that is valid. Without a skip reason STATE.md must
  // be among the committed paths.
  if (typeof stateSkipped !== "string" && !paths.includes("docs/project/STATE.md")) {
    throw new Error("Handoff snapshots must include docs/project/STATE.md.");
  }
  // C2b (AR-R05): the writer proves the commit's tree holds the v2 entry
  // lines (read back from the commit, never the checkout); the reducer
  // requires that proof. Fail closed: no proof, no record.
  // C2c (NF-2/CD-15): each entry file proves itself by its committed flag
  // or by its recorded link reason (a redirect into the target path, or a
  // skip of a missing or outside link target). STATE.md stays required.
  const agentsViaLink = event.payload.agentsSectionViaLink;
  if (agentsViaLink !== undefined && (typeof agentsViaLink !== "string" || !agentsViaLink.trim())) {
    throw new Error("Handoff snapshot agentsSectionViaLink is invalid.");
  }
  if (
    (event.payload.agentsSectionCommitted !== true && agentsViaLink === undefined) ||
    (event.payload.claudeLineCommitted !== true && event.payload.claudeLineViaLink === undefined)
  ) {
    throw new Error("Handoff snapshots must prove the committed tree holds the v2 AGENTS.md section and the CLAUDE.md line.");
  }
  const specPath = event.payload.specPath;
  if (specPath !== undefined && (typeof specPath !== "string" || !specPath.trim())) {
    throw new Error("Handoff snapshot specPath is invalid.");
  }
  const specCopySkipped = event.payload.specCopySkipped;
  if (specCopySkipped !== undefined && (typeof specCopySkipped !== "string" || !specCopySkipped.trim())) {
    throw new Error("Handoff snapshot specCopySkipped is invalid.");
  }
  const claudeLineViaLink = event.payload.claudeLineViaLink;
  if (claudeLineViaLink !== undefined && (typeof claudeLineViaLink !== "string" || !claudeLineViaLink.trim())) {
    throw new Error("Handoff snapshot claudeLineViaLink is invalid.");
  }
  const snapshots = projection.projectDocs?.snapshots ?? [];
  if (snapshots.some((record) => record.stopSequence === stopSequence)) {
    throw new Error(`Handoff snapshot for stop ${stopSequence} is already recorded.`);
  }
  const record: HandoffSnapshotRecord = {
    stopSequence,
    stopKind,
    revision,
    commit,
    parent,
    head,
    bodyDigest,
    paths: [...paths],
    sequence: event.sequence,
    ...(typeof stateSkipped === "string" ? { stateSkippedReason: stateSkipped } : {}),
    previousSnapshotEdited: event.payload.previousSnapshotEdited === true,
    agentsSectionCommitted: event.payload.agentsSectionCommitted !== false,
    claudeLineCommitted: event.payload.claudeLineCommitted !== false,
    ...(typeof specPath === "string" ? { specPath } : {}),
    ...(event.payload.specCopied === true ? { specCopied: true as const } : {}),
    ...(typeof specCopySkipped === "string" ? { specCopySkipped } : {}),
    ...(typeof claudeLineViaLink === "string" ? { claudeLineViaLink } : {}),
    ...(typeof agentsViaLink === "string" ? { agentsSectionViaLink: agentsViaLink } : {}),
  };
  const canonical = projection.integrationRevision;
  const currentTip = projection.projectDocs?.documentTip;
  const continuesDocuments =
    (typeof canonical === "string" && parent === canonical) ||
    (typeof currentTip === "string" && parent === currentTip);
  projection.projectDocs = {
    pending: projection.projectDocs?.pending ?? [],
    ...carriedProjectDocs(projection.projectDocs),
    snapshots: [...snapshots, record],
    ...(continuesDocuments
      ? { documentTip: commit }
      : currentTip
        ? { documentTip: currentTip }
        : {}),
  };
  // A non-current stop's record is pure history: it moves the tip above
  // but never touches the run state. Only the current stop's snapshot
  // clears its failure pause and returns the run to the handoff wait. In
  // particular a withdrawn stop reconciled after a later stop was
  // requested (C2b repair B1, probe G2) stays history while requested --
  // an old stop's late record can never disturb the current one.
  const isCurrentStop = requestedSequence !== undefined && stopSequence === requestedSequence;
  if (!isCurrentStop) {
    return;
  }
  if (projection.pauseReason?.reason === "handoff_snapshot_failed") {
    delete projection.pauseReason;
  }
  // C2a repair (B2): a resume retried the snapshot while `running`; the
  // committed snapshot returns the run to the handoff wait, never
  // `running`, so no Architect call follows until the owner selects.
  if (projection.status === "running") {
    projection.status = "paused";
  }
}

function applyProjectDocAbandoned(
  projection: SchedulerProjection,
  event: SchedulerEvent,
): void {
  if (event.actor.role !== "runner") {
    throw new Error("Only the runner may abandon a project document request.");
  }
  const requestId = requiredString(event.payload, "requestId");
  const path = requiredString(event.payload, "path");
  const checked = validateProjectDocPath(path);
  if (!checked.ok) {
    throw new Error(`Project document path is refused: ${checked.reason}.`);
  }
  const reason = requiredString(event.payload, "reason");
  if (!reason.trim()) {
    throw new Error("Project document abandonment reason is required.");
  }
  const pending = projection.projectDocs?.pending ?? [];
  const request = pending.find((item) => item.requestId === requestId);
  if (!request) {
    throw new Error(`Project document request ${requestId} is not pending.`);
  }
  if (request.path !== checked.path) {
    throw new Error(`Project document abandonment path does not match request ${requestId}.`);
  }
  const abandoned = projection.projectDocs?.abandoned ?? [];
  if (abandoned.some((item) => item.requestId === requestId)) {
    throw new Error(`Project document request ${requestId} is already abandoned.`);
  }
  projection.projectDocs = {
    pending: pending.filter((item) => item.requestId !== requestId),
    ...carriedProjectDocs(projection.projectDocs),
    abandoned: [
      ...abandoned.map((item) => ({ ...item })),
      {
        requestId,
        path: checked.path,
        reason,
        sequence: event.sequence,
      },
    ],
  };
}

function cloneProjectDocs(docs: ProjectDocsProjection): ProjectDocsProjection {
  return {
    pending: docs.pending.map((request) => ({ ...request })),
    ...carriedProjectDocs(docs),
  };
}

function carriedProjectDocs(
  docs: ProjectDocsProjection | undefined,
): Pick<ProjectDocsProjection, "committed" | "documentTip" | "abandoned" | "snapshots" | "stopSnapshotSkips" | "stopNotes" | "stopNoteAttempts" | "stopNoteFailures"> {
  if (!docs) return {};
  return {
    ...(docs.committed
      ? { committed: docs.committed.map((commit) => ({ ...commit })) }
      : {}),
    ...(docs.documentTip ? { documentTip: docs.documentTip } : {}),
    ...(docs.abandoned
      ? { abandoned: docs.abandoned.map((item) => ({ ...item })) }
      : {}),
    ...((docs.snapshots ?? docs.stopSnapshotSkips ?? docs.stopNotes ?? docs.stopNoteAttempts ?? docs.stopNoteFailures)
      ? { ...(docs.snapshots ? { snapshots: docs.snapshots.map((record) => ({ ...record, paths: [...record.paths] })) } : {}), ...(docs.stopSnapshotSkips ? { stopSnapshotSkips: docs.stopSnapshotSkips.map((record) => ({ ...record })) } : {}), ...(docs.stopNotes ? { stopNotes: docs.stopNotes.map((record) => ({ ...record })) } : {}), ...(docs.stopNoteAttempts ? { stopNoteAttempts: docs.stopNoteAttempts.map((record) => ({ ...record })) } : {}), ...(docs.stopNoteFailures ? { stopNoteFailures: docs.stopNoteFailures.map((record) => ({ ...record })) } : {}) }
      : {}),
  };
}

function requiredBoolean(payload: Record<string, unknown>, key: string): boolean {
  const value = payload[key];
  if (typeof value !== "boolean") {
    throw new Error(`Project document commit ${key} must be a boolean.`);
  }
  return value;
}

function applyContextRecordingResolved(
  projection: SchedulerProjection,
  event: SchedulerEvent,
): void {
  const resolution = event.payload.resolution;
  if (
    resolution !== "retry" &&
    resolution !== "proceed_without_manifest" &&
    resolution !== "abort"
  ) {
    throw new Error("Context recording resolution is invalid.");
  }
  if (resolution === "retry") {
    if (event.actor.role !== "architect" && event.actor.role !== "user") {
      throw new Error("Only the Architect or the user may retry context recording.");
    }
  } else if (event.actor.role !== "architect") {
    throw new Error("Only the Architect may resolve context recording.");
  }
  if (projection.status !== "paused" || projection.pauseReason?.reason !== "context_recording_failed") {
    throw new Error("Context recording can only be resolved while that failure pauses the run.");
  }
  const noteSequence = requiredPositiveInteger(event.payload, "noteSequence");
  const notes = projection.contextRecording?.notes ?? [];
  const named = notes.find((item) => item.sequence === noteSequence);
  if (!named) throw new Error(`Context recording note ${noteSequence} does not exist.`);
  if (named.resolution) {
    throw new Error(`Context recording note ${noteSequence} is already resolved.`);
  }
  const latestUnresolved = [...notes].reverse().find((item) => !item.resolution);
  if (!latestUnresolved || noteSequence !== latestUnresolved.sequence) {
    throw new Error(
      `Context recording resolution must name the latest unresolved note ${latestUnresolved?.sequence ?? "none"}.`,
    );
  }
  const rationale = event.payload.rationale;
  if (rationale !== undefined && (typeof rationale !== "string" || !rationale.trim())) {
    throw new Error("Context recording rationale must be non-empty.");
  }
  if (
    resolution === "proceed_without_manifest" &&
    (typeof rationale !== "string" || !rationale.trim())
  ) {
    throw new Error("proceed_without_manifest requires a non-empty rationale.");
  }
  if (resolution === "retry" && contextRecordingRetriesRemaining(projection) === 0) {
    throw new Error(
      `Context recording retry budget of ${CONTEXT_RECORDING_RETRY_LIMIT} is exhausted.`,
    );
  }
  const sharedResolution: {
    sequence: number;
    resolution: ContextRecordingResolutionKind;
    rationale?: string;
  } = {
    sequence: event.sequence,
    resolution,
    ...(typeof rationale === "string" ? { rationale } : {}),
  };
  projection.contextRecording = {
    ...(projection.contextRecording?.waiver
      ? { waiver: { ...projection.contextRecording.waiver } }
      : {}),
    notes: notes.map((item) =>
      item.resolution || item.sequence > noteSequence
        ? item
        : {
            ...item,
            resolution: {
              ...sharedResolution,
              actor: { ...event.actor },
            },
          },
    ),
    ...(resolution === "proceed_without_manifest"
      ? { waiver: { sequence: event.sequence, rationale: (rationale as string).trim() } }
      : {}),
  };
  if (resolution === "abort") {
    projection.status = "failed";
    projection.failureReason = "context_recording_aborted";
    delete projection.pauseReason;
  }
}

function optionalContextText(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  if (!Object.hasOwn(payload, key) || payload[key] === undefined) return undefined;
  return requiredString(payload, key);
}

function optionalContextAttempt(
  payload: Record<string, unknown>,
  key: string,
): number | undefined {
  if (!Object.hasOwn(payload, key) || payload[key] === undefined) return undefined;
  return requiredPositiveInteger(payload, key);
}

function cloneRepairCyclesProjection(
  cycles: RepairCyclesProjection,
): RepairCyclesProjection {
  return {
    limit: cycles.limit,
    used: cycles.used,
    extensions: cycles.extensions,
    ...(cycles.explicitLimit !== undefined ? { explicitLimit: cycles.explicitLimit } : {}),
    ...(cycles.pause ? { pause: { ...cycles.pause } } : {}),
  };
}

function cloneRepairIssuesProjection(issues: Record<string, RepairIssueProjection>): Record<string, RepairIssueProjection> {
  return Object.fromEntries(Object.entries(issues).map(([issueId, issue]) => [issueId, {
    ...issue,
    hypotheses: [...issue.hypotheses],
    outcomes: [...issue.outcomes],
    approaches: issue.approaches.map((approach) => ({
      ...approach,
      diagnosticSet: [...approach.diagnosticSet],
      evidenceIds: [...approach.evidenceIds],
      failureEvidenceIds: [...(approach.failureEvidenceIds ?? [])],
    })),
    ...(issue.externalBlocker
      ? {
          externalBlocker: {
            ...issue.externalBlocker,
            evidence: [...issue.externalBlocker.evidence],
            attemptedResolutions: [...issue.externalBlocker.attemptedResolutions],
          },
        }
      : {}),
  }]));
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
  if (resolution.type === "folded_into_planning") {
    return { ...resolution };
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
  actor: SchedulerActor,
): void {
  const role = actor.role;
  const architectStatuses: BuildTask["status"][] = [
    "architect_review",
    "approved",
    "rejected",
    "integrating",
  ];
  if (architectStatuses.includes(status) && role !== "architect") {
    throw new Error(`Only the Architect may transition a task to ${status}.`);
  }
  if (status === "integrated" || status === "integration_resolution") {
    if (
      role !== "runner" ||
      !["integration-manager", "integration_manager"].includes(actor.id)
    ) {
      throw new Error(
        `Only the integration authority may transition a task to ${status}.`,
      );
    }
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
    ...(task.submissionScope ? { submissionScope: structuredClone(task.submissionScope) } : {}),
    ...(task.reviewSignals ? { reviewSignals: structuredClone(task.reviewSignals) } : {}),
    ...(task.encodingSubmission ? { encodingSubmission: structuredClone(task.encodingSubmission) } : {}),
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
    ...(task.deliveryRepair
      ? { deliveryRepair: { ...task.deliveryRepair, evidenceIds: [...task.deliveryRepair.evidenceIds] } }
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

/** T6b repair (EP50): the recorded OA-16 track-record snapshot, validated for deterministic recompute. */
function readTrackRecordSnapshot(value: unknown): { records: Record<string, { tasksReviewed: number; defectsFound: number }>; snapshotId: string } {
  if (!isRecord(value) || !isRecord(value.records) || typeof value.snapshotId !== "string") {
    throw new Error("Deliverable review track record requires model records and a snapshot id.");
  }
  const records: Record<string, { tasksReviewed: number; defectsFound: number }> = {};
  for (const [modelId, entry] of Object.entries(value.records)) {
    if (!isRecord(entry) || !Number.isSafeInteger(entry.tasksReviewed) || !Number.isSafeInteger(entry.defectsFound)) {
      throw new Error("Deliverable review track record requires integer task and defect counts.");
    }
    records[modelId] = { tasksReviewed: entry.tasksReviewed as number, defectsFound: entry.defectsFound as number };
  }
  return { records, snapshotId: value.snapshotId };
}

// ---------------------------------------------------------------------------
// T9 (EP39/OA-5/OA-10 #2): request-triage and answer-review payload parsers.
// Payloads are closed: unknown fields are refused, never ignored.
// ---------------------------------------------------------------------------

function assertExactTriageKeys(payload: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown triage payload field(s): ${unknown.join(", ")}.`);
  }
}

function requiredNonBlank(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be nonblank.`);
  return value;
}

function parseRequestTriage(payload: Record<string, unknown>): {
  decision: PlanningTriageDecision;
  rationale: string;
} {
  assertExactTriageKeys(payload, ["decision", "rationale"]);
  const decision = payload.decision;
  if (decision !== "answer" && decision !== "build" && decision !== "clarify") {
    throw new Error("Triage decision must be answer, build, or clarify.");
  }
  return { decision, rationale: requiredNonBlank(payload, "rationale") };
}

function parseRequestAnswer(payload: Record<string, unknown>): {
  answerText: string;
  addressedParts: string[];
  evidenceIds: string[];
} {
  assertExactTriageKeys(payload, ["answerText", "addressedParts", "evidenceIds"]);
  const answerText = requiredNonBlank(payload, "answerText");
  const addressedParts = payload.addressedParts;
  if (
    !Array.isArray(addressedParts) ||
    addressedParts.length === 0 ||
    !addressedParts.every((part): part is string => typeof part === "string" && part.trim().length > 0)
  ) {
    throw new Error("The answer must list at least one addressed question part.");
  }
  const evidenceIds = payload.evidenceIds ?? [];
  if (!Array.isArray(evidenceIds) || !evidenceIds.every((id): id is string => typeof id === "string" && id.length > 0)) {
    throw new Error("Answer evidenceIds must be a string array.");
  }
  return { answerText, addressedParts: [...addressedParts], evidenceIds: [...evidenceIds] };
}

function parseAnswerReviewFinding(value: unknown): AnswerReviewFinding {
  if (!isRecord(value)) throw new Error("Answer review finding is invalid.");
  assertExactTriageKeys(value, ["id", "statement", "severity"]);
  const severity = value.severity;
  if (severity !== "blocking" && severity !== "non_blocking") {
    throw new Error("Answer review finding severity must be blocking or non_blocking.");
  }
  return {
    id: requiredNonBlank(value, "id"),
    statement: requiredNonBlank(value, "statement"),
    severity,
  };
}

function parseAnswerReviewFindings(payload: Record<string, unknown>): {
  reviewId: string;
  findings: AnswerReviewFinding[];
  priorReviewId?: string;
} {
  assertExactTriageKeys(payload, ["reviewId", "findings", "priorReviewId"]);
  const reviewId = requiredNonBlank(payload, "reviewId");
  const raw = payload.findings;
  if (!Array.isArray(raw)) throw new Error("Answer review findings must be an array.");
  const findings = raw.map(parseAnswerReviewFinding);
  if (new Set(findings.map((finding) => finding.id)).size !== findings.length) {
    throw new Error("Answer review finding ids must be unique.");
  }
  const priorReviewId = payload.priorReviewId;
  if (priorReviewId !== undefined && (typeof priorReviewId !== "string" || !priorReviewId.trim())) {
    throw new Error("Answer review priorReviewId is invalid.");
  }
  return {
    reviewId,
    findings,
    ...(priorReviewId !== undefined ? { priorReviewId: priorReviewId as string } : {}),
  };
}

function parseAnswerReviewFindingCheck(value: unknown): AnswerReviewFindingCheck {
  if (!isRecord(value)) throw new Error("Answer review finding check is invalid.");
  assertExactTriageKeys(value, ["findingId", "resolution", "rationale"]);
  const resolution = value.resolution;
  if (resolution !== "resolved" && resolution !== "outstanding") {
    throw new Error("Answer review finding check resolution must be resolved or outstanding.");
  }
  return {
    findingId: requiredNonBlank(value, "findingId"),
    resolution,
    rationale: requiredNonBlank(value, "rationale"),
  };
}

function parseAnswerReview(payload: Record<string, unknown>): {
  id: string;
  reviewerRuntimeId: string;
  independence: "distinct_model" | "fresh_context";
  answerSequence: number;
  findings: AnswerReviewFinding[];
  summary: string;
  answerAccurate: boolean;
  priorReviewId?: string;
  priorFindingChecks?: AnswerReviewFindingCheck[];
} {
  assertExactTriageKeys(payload, [
    "id",
    "reviewerRuntimeId",
    "independence",
    "answerSequence",
    "findings",
    "summary",
    "answerAccurate",
    "priorReviewId",
    "priorFindingChecks",
  ]);
  const rawFindings = payload.findings;
  if (!Array.isArray(rawFindings)) throw new Error("Answer review findings must be an array.");
  const findings = rawFindings.map(parseAnswerReviewFinding);
  if (new Set(findings.map((finding) => finding.id)).size !== findings.length) {
    throw new Error("Answer review finding ids must be unique.");
  }
  const priorReviewId = payload.priorReviewId;
  if (priorReviewId !== undefined && (typeof priorReviewId !== "string" || !priorReviewId.trim())) {
    throw new Error("Answer review priorReviewId is invalid.");
  }
  const rawChecks = payload.priorFindingChecks;
  const priorFindingChecks = rawChecks === undefined
    ? undefined
    : (() => {
      if (!Array.isArray(rawChecks)) throw new Error("Answer review priorFindingChecks must be an array.");
      return rawChecks.map(parseAnswerReviewFindingCheck);
    })();
  const answerAccurate = payload.answerAccurate;
  if (typeof answerAccurate !== "boolean") throw new Error("Answer review answerAccurate must be a boolean.");
  return {
    id: requiredNonBlank(payload, "id"),
    reviewerRuntimeId: requiredNonBlank(payload, "reviewerRuntimeId"),
    independence: parseReviewerIndependence(payload.independence),
    answerSequence: requiredPositiveInteger(payload, "answerSequence"),
    findings,
    summary: requiredNonBlank(payload, "summary"),
    answerAccurate,
    ...(priorReviewId !== undefined ? { priorReviewId: priorReviewId as string } : {}),
    ...(priorFindingChecks !== undefined ? { priorFindingChecks } : {}),
  };
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

/** C2b run option (CD-5): commit the handoff files, or write nothing. */
export type HandoffFilesOption = "commit" | "export_only";

/**
 * Additive C2b run options on `run.policy_configured`. Only present fields
 * are returned, so logs written before C2b (which carry none) replay with
 * the defaults from the accessors below.
 */
export function parseRunPolicyOptions(
  payload: Record<string, unknown>
): { specCopy?: boolean; handoffFiles?: HandoffFilesOption } {
  const options: { specCopy?: boolean; handoffFiles?: HandoffFilesOption } = {};
  if (payload.specCopy !== undefined) {
    if (typeof payload.specCopy !== "boolean") {
      throw new Error("Run policy specCopy must be a boolean.");
    }
    options.specCopy = payload.specCopy;
  }
  if (payload.handoffFiles !== undefined) {
    if (payload.handoffFiles !== "commit" && payload.handoffFiles !== "export_only") {
      throw new Error("Run policy handoffFiles must be commit or export_only.");
    }
    options.handoffFiles = payload.handoffFiles;
  }
  return options;
}

/** Recorded `specCopy` run option (CD-5); absent means the default true. */
export function specCopyOf(projection: SchedulerProjection): boolean {
  return projection.specCopy ?? true;
}

/** Recorded `handoffFiles` run option (CD-5); absent means the default commit. */
export function handoffFilesOf(projection: SchedulerProjection): HandoffFilesOption {
  return projection.handoffFiles ?? "commit";
}

/**
 * C2b (N2): a kernel snapshot retry is pending -- docs v2, handoff
 * requested, `export_only` off, and no snapshot recorded for the current
 * stop. Resume is allowed exactly then (not by the current pause reason
 * alone, so an owner pause stacked on a snapshot failure still retries).
 */
export function handoffSnapshotRetryPending(projection: SchedulerProjection): boolean {
  if (projection.projectDocsPolicyVersion !== 2) return false;
  if (isAnsweredRun(projection)) return false;
  if (projection.projectHandoff?.status !== "requested") return false;
  if (handoffFilesOf(projection) !== "commit") return false;
  const stopSequence = projection.projectHandoff.requestedSequence;
  if (stopSequence === undefined) return false;
  return !(projection.projectDocs?.snapshots ?? []).some(
    (record) => record.stopSequence === stopSequence,
  );
}
