import {
  computeDigest,
  computePlanReadiness,
  coverageReviewHoldsReadiness,
  validateAssignmentClaim,
  validateCoverageReview,
  validateCoverageReviewBinding,
  validateExecutionPlanRevision,
  validateHostPlanningCapabilities,
  validatePhaseAcceptance,
  validatePlanningCheckpoint,
  validateRequirementLedger,
  validateRequirementTaskCoverage,
  validateTaskAcceptance,
  validateValidationIntent,
  validateValidationObservation,
  type AssignmentClaim,
  type CoverageReview,
  type DerivedObligation,
  type ExecutionPlanPhase,
  type ExecutionPlanRevision,
  type HostPlanningCapabilities,
  type PhaseAcceptance,
  type PlanningCheckpoint,
  type PlanningValidation,
  type SourceRequirement,
  type TaskAcceptance,
  type ValidationIntent,
  type ValidationObservation,
} from "./planning-contracts.js";
import {
  assertExecutionAuthorizationPayload,
} from "./planning-controls.js";
import {
  assertClaimSuccessor,
  assignmentContractId,
  assignmentIsKernelRepair,
  findClaimConflict,
  taskWriteClaimFromAssignment,
} from "./task-resource-claims.js";
import {
  validateApprovedSourceManifest,
  verifyAmendmentReferencesPredecessor,
  type ApprovedSourceManifest,
  type SourceManifestAmendment,
  type SourceManifestAmendmentRecordedImpact,
} from "./source-manifest.js";

export const PLANNING_EVENT_TYPES = [
  "planning.source_registered",
  "planning.source_amended",
  "planning.source_section_read",
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
] as const;

export type PlanningEventType = (typeof PLANNING_EVENT_TYPES)[number];
export type PlanningActorRole = "architect" | "worker" | "verifier" | "runner" | "user";

export function isPlanningEventType(type: string): type is PlanningEventType {
  return (PLANNING_EVENT_TYPES as readonly string[]).includes(type);
}

export interface PlanningEventInput {
  readonly runId: string;
  readonly type: PlanningEventType;
  readonly occurredAt: string;
  readonly actor: { readonly role: PlanningActorRole; readonly id: string };
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
  /**
   * T9 repair cycle 3 (B4-r3): the durable scheduler event sequence, supplied
   * by the scheduler store when it delegates planning events. Direct
   * planning-projection callers omit it; sequence-gated rules treat a missing
   * sequence as the beginning of the run (fail closed once a folded
   * acknowledgement exists).
   */
  readonly sequence?: number;
}

export const PLANNING_EVENT_ACTOR_ROLES: Readonly<Record<PlanningEventType, readonly PlanningActorRole[]>> = {
  "planning.source_registered": ["user"],
  "planning.source_amended": ["user"],
  "planning.source_section_read": ["architect"],
  "planning.ledger_persisted": ["architect"],
  "planning.checkpoint_recorded": ["architect"],
  "planning.plan_drafted": ["architect"],
  "planning.plan_revised": ["architect"],
  "planning.coverage_review_requested": ["architect"],
  "planning.coverage_obligations_recorded": ["verifier"],
  "planning.coverage_plan_delivered": ["runner"],
  "planning.coverage_correction_view_recorded": ["verifier"],
  "planning.coverage_prior_findings_released": ["runner"],
  "planning.coverage_review_recorded": ["verifier"],
  "planning.coverage_review_unavailable": ["runner"],
  "planning.coverage_review_suspended": ["runner"],
  "planning.coverage_review_retry_authorized": ["user"],
  "planning.plan_ready": ["runner"],
  "planning.assignment_claimed": ["runner"],
  "planning.assignment_released": ["runner"],
  "planning.validation_intent_recorded": ["architect"],
  "planning.validation_observed": ["worker", "runner"],
  "planning.validation_interrupted": ["runner"],
  "planning.validation_reconciled": ["runner"],
  "planning.recovery_reconciled": ["runner"],
  "planning.reference_recorded": ["runner"],
  "planning.acceptance_recorded": ["architect", "runner"],
  "planning.acceptance_reopened": ["architect"],
  "planning.execution_authorized": ["user"],
};

export const PLANNING_EVENT_TRANSITIONS: Readonly<Record<PlanningEventType, string>> = {
  "planning.source_registered": "none -> source_registered",
  "planning.source_amended": "source_registered -> source_amended",
  "planning.source_section_read": "source_registered|source_amended -> durable read index+",
  "planning.ledger_persisted": "source_registered|source_amended -> ledger_persisted",
  "planning.checkpoint_recorded": "ledger_persisted -> checkpoint_recorded+",
  "planning.plan_drafted": "ledger_persisted -> plan_drafted",
  "planning.plan_revised": "plan_drafted -> plan_revised+",
  "planning.coverage_review_requested": "plan_drafted -> coverage_review_requested+",
  "planning.coverage_obligations_recorded": "coverage_review_requested -> blind obligations (before plan delivery)",
  "planning.coverage_plan_delivered": "obligations|request -> plan delivered to reviewer",
  "planning.coverage_correction_view_recorded": "request (re-review) + reused blind obligations -> own view",
  "planning.coverage_prior_findings_released": "correction own view -> prior findings released",
  "planning.coverage_review_recorded": "obligations + plan binding [+ own view + release + prior checks] -> coverage_review_recorded+",
  "planning.coverage_review_unavailable": "coverage_review_requested -> explicit outstanding gate",
  "planning.coverage_review_suspended": "coverage_review_requested -> suspended attempt counted",
  "planning.coverage_review_retry_authorized": "coverage_review_suspended_exhausted -> owner retry authorized (gate cleared, attempts reset)",
  "planning.plan_ready": "plan_drafted + bound passing coverage_review + full durable reads -> plan_ready",
  "planning.assignment_claimed": "plan_ready -> assignment_claimed",
  "planning.assignment_released": "assignment_claimed -> assignment_released|stopped_fenced",
  "planning.validation_intent_recorded": "assignment_claimed -> validation_intent_recorded+",
  "planning.validation_observed": "validation_intent_recorded -> passed|failed|unknown",
  "planning.validation_interrupted": "validation_intent_recorded -> interrupted",
  "planning.validation_reconciled": "interrupted -> passed|failed|unknown",
  "planning.recovery_reconciled": "assignment_claimed -> verified|mismatch|unknown",
  "planning.reference_recorded": "plan_drafted -> immutable reference+",
  "planning.acceptance_recorded": "plan_ready + verified assignment + terminal validations -> accepted",
  "planning.acceptance_reopened": "accepted -> reopened",
  "planning.execution_authorized": "plan_ready -> execution_authorized",
};

/**
 * C4 (AR-R14): unproduced T2 planning event types, frozen. No `src/`
 * producer may append one without removing its name here first — the static
 * guard test enforces that. Declarations, actor/transition tables, reducer
 * branches and gate sets keep naming them so old logs replay; the live
 * assignment events and `task`/`phase.acceptance_recorded` are NOT reserved.
 */
export const PLANNING_RESERVED_EVENT_TYPES: readonly string[] = Object.freeze([
  "planning.validation_intent_recorded",
  "planning.validation_observed",
  "planning.validation_interrupted",
  "planning.validation_reconciled",
  "planning.recovery_reconciled",
  "planning.reference_recorded",
  "planning.acceptance_recorded",
  "planning.acceptance_reopened",
]);

export interface PlanningReferenceRecord {
  readonly kind: "gate" | "evidence" | "review" | "integration" | "worktree" | "commit" | "repair";
  readonly id: string;
  readonly digest?: string;
}

export type PlanningValidationStatus = "planned" | "passed" | "failed" | "unknown" | "interrupted";

export interface PlanningValidationState {
  readonly taskId: string;
  readonly intent: ValidationIntent;
  readonly planRevisionId: string;
  readonly planRevisionDigest: string;
  readonly status: PlanningValidationStatus;
  readonly observations: readonly ValidationObservation[];
  readonly interruptedCommandId?: string;
}

export interface PlanningAssignmentState {
  readonly claim: AssignmentClaim;
  readonly status: "claimed" | "released" | "stopped_fenced";
  readonly recoveryStatus: "unchecked" | "verified" | "mismatch" | "unknown";
}

export interface PlanningAcceptanceState {
  readonly kind: "task" | "phase";
  readonly taskId?: string;
  readonly phaseId?: string;
  readonly record: TaskAcceptance | PhaseAcceptance;
  readonly planRevisionId: string;
  readonly planRevisionDigest: string;
  readonly status: "accepted" | "reopened";
  readonly reopenedByPlanRevisionId?: string;
  readonly reopenedAtObservationOrder?: number;
  readonly history?: readonly PlanningAcceptanceState[];
}

export interface PlanningCheckpointRecord {
  readonly checkpoint: PlanningCheckpoint;
  readonly sourceManifestId: string;
  readonly sourceManifestDigest: string;
  readonly sectionDigests: Readonly<Record<string, string>>;
}

/**
 * T3b (N2): one durable full verified source-section read, bound to the exact
 * manifest revision and section digest it was verified against. A later
 * amendment starts a new manifest revision whose sections need their own
 * reads; old reads never satisfy a new revision.
 */
export interface PlanningSourceReadRecord {
  readonly manifestId: string;
  readonly manifestDigest: string;
  readonly sectionId: string;
  readonly sectionDigest: string;
  readonly readAt: string;
}

/** T3b: the Architect's durable request for a coverage review of one plan revision. */
export interface CoverageReviewRequestRecord {
  readonly reviewId: string;
  readonly planRevisionId: string;
  readonly planRevisionDigest: string;
  readonly sourceManifestId: string;
  readonly priorReviewId?: string;
  readonly requestedAt: string;
  /**
   * T9 repair cycle 3 (B4-r3): the durable scheduler event sequence that
   * requested this review. `planning.plan_ready` is refused while the latest
   * folded-into-planning acknowledgement postdates it — the bound review's
   * snapshot must contain the folded guidance. Stamped by the scheduler
   * store; absent on older projections and direct-constructed records, which
   * read as the beginning of the run. Excluded from the idempotency
   * comparison below: a re-appended identical request keeps its first
   * sequence.
   */
  readonly requestedSequence?: number;
}

/**
 * T3b repair cycle 1 (N4): how one source section is accounted for by the
 * blind obligation set. Either at least one obligation id, or an explicit
 * reviewer reason why the section imposes no obligation.
 */
export interface CoverageSectionCoverage {
  readonly sectionId: string;
  readonly obligationIds: readonly string[];
  readonly noObligationReason?: string;
}

/**
 * T3b (OA-1) repair cycle 1 (B2): obligations the coverage reviewer derived
 * from the source alone BEFORE any plan was delivered for this review. Blind
 * only: no prior review, no correction view. A re-review after a plan
 * revision reuses the current blind set (see CoverageCorrectionViewRecord)
 * instead of re-deriving with the plan in context. The verdict is refused
 * without an applicable blind record (record-before-verdict).
 */
export interface CoverageObligationsRecord {
  readonly reviewId: string;
  readonly sourceManifestId: string;
  readonly sourceManifestDigest: string;
  readonly obligations: readonly DerivedObligation[];
  readonly sectionCoverage: readonly CoverageSectionCoverage[];
  readonly recordedAt: string;
}

/**
 * T3b repair cycle 1 (B2): durable proof that the plan was delivered to a
 * review session. Obligations recorded after this event for the same review
 * are refused: a `recordedBeforePlanOrDiffProvided: true` stamp is only
 * valid when no plan delivery precedes it.
 */
export interface CoveragePlanDeliveredRecord {
  readonly reviewId: string;
  readonly planRevisionId: string;
  readonly planRevisionDigest: string;
  readonly sourceManifestId: string;
  readonly sessionId?: string;
  readonly deliveredAt: string;
}

/**
 * T3b repair cycle 1 (B2/EP42): a re-review's own recorded view of the
 * corrected plan against the reused blind obligations, written BEFORE any
 * prior findings are released. `reusedFromReviewId` names the blind
 * obligations record (same manifest id/digest); it may be the review's own
 * fresh blind record (source changed) or a prior review's blind record
 * (plan-only revision).
 */
export interface CoverageCorrectionViewRecord {
  readonly reviewId: string;
  readonly priorReviewId: string;
  readonly correctionView: string;
  readonly reusedFromReviewId: string;
  readonly sourceManifestId: string;
  readonly sourceManifestDigest: string;
  readonly recordedAt: string;
}

/** T3b (OA-10#2): the re-reviewer's check of one prior finding. */
export interface CoveragePriorFindingCheck {
  readonly priorFindingId: string;
  readonly status: "resolved" | "outstanding";
  readonly rationale: string;
}

/**
 * T3b: an explicit outstanding gate — no eligible reviewer, an overflowing
 * source pack, suspended-retry exhaustion, or another recorded reason.
 * Readiness stays blocked while set. A new review request, a recorded blind
 * derivation, a delivered plan, a recorded own view, or a recorded review
 * clears it (B1: the gate is outstanding but retryable, never permanent).
 */
export interface CoverageUnavailableRecord {
  readonly reviewId?: string;
  readonly planRevisionId?: string;
  readonly sourceManifestId?: string;
  readonly reason: string;
  readonly detail?: string;
  readonly recordedAt: string;
}

/** Terminal coverage gate reasons: recorded for the owner; only an owner-authorized retry clears them (N6/R2-1). */
export const TERMINAL_COVERAGE_GATE_REASONS: readonly string[] = Object.freeze([
  "coverage_review_suspended_exhausted",
]);

/**
 * T3b repair cycle 2 (N-R2-2): an open finding whose obligation was retired
 * by a source amendment, closed as retired. Recorded ONLY by the
 * owner-authorized planning.source_amended reducer case, never silently:
 * a finding on a still-existing obligation stays open.
 */
export interface CoverageRetiredFinding {
  readonly findingId: string;
  readonly reviewId: string;
  readonly retiredByAmendmentId: string;
  readonly retiredAt: string;
}

/** T3b repair cycle 1 (N6): durable count of suspended attempts per review. */
export interface CoverageSuspendedRecord {
  readonly reviewId: string;
  readonly attempts: number;
  readonly lastReason: string;
  readonly lastRuntimeId?: string;
  readonly updatedAt: string;
}

export interface PlanningResumeIndex {
  readonly coveredSourceSectionIds: readonly string[];
  readonly remainingSourceSectionIds: readonly string[];
  readonly nextSourceSectionId?: string;
  readonly completedPlanningContractIds: readonly string[];
  readonly outstandingWork: readonly string[];
  readonly nextAction: string;
}

/**
 * T7b: the owner's explicit current-plan execution authorization. Validity
 * is derived, never stored as a boolean: an authorization covers execution
 * only while every bound identity still equals the current ready identity.
 * A plan revision, source amendment, or policy change leaves the record in
 * place but uncovered until the owner authorizes the new current plan.
 */
export interface PlanningExecutionAuthorization {
  readonly version: 1;
  readonly planRevisionId: string;
  readonly planDigest: string;
  readonly sourceManifestId: string;
  readonly sourceArtifactDigest: string;
  readonly planningPolicyVersion: 1;
  readonly projectDocsPolicyVersion: number;
  readonly ownerChoice: string;
  readonly authorizedAt: string;
}

export interface PlanningProjection {
  readonly source: {
    readonly currentManifestId: string;
    readonly sourceId: string;
    readonly artifactDigest: string;
    readonly manifestHistoryIds: readonly string[];
    readonly manifestsById: Readonly<Record<string, ApprovedSourceManifest>>;
  };
  readonly ledger?: {
    readonly id: string;
    readonly requirements: readonly SourceRequirement[];
    readonly phases: readonly ExecutionPlanPhase[];
  };
  readonly plan?: {
    readonly currentRevisionId: string;
    readonly currentDigest: string;
    readonly revisionHistoryIds: readonly string[];
    readonly revisionsById: Readonly<Record<string, ExecutionPlanRevision>>;
  };
  readonly checkpoints: readonly PlanningCheckpointRecord[];
  /** T3b (N2): durable read index, manifest revision -> section id -> verified section digest. */
  readonly sourceReadIndex: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly assignments: Readonly<Record<string, PlanningAssignmentState>>;
  readonly validations: Readonly<Record<string, PlanningValidationState>>;
  readonly observationSequence: number;
  readonly observationOrderByObservationId: Readonly<Record<string, number>>;
  readonly acceptances: Readonly<Record<string, PlanningAcceptanceState>>;
  readonly readiness: "not_ready" | "ready";
  readonly coverageReview?: CoverageReview;
  /** T3b: prior coverage reviews, oldest first; the current review is `coverageReview`. */
  readonly coverageReviewHistory: readonly CoverageReview[];
  /** T3b: coverage review requests by review id. */
  readonly coverageRequests: Readonly<Record<string, CoverageReviewRequestRecord>>;
  /**
   * T9 repair cycle 3 (B4-r3): sequence of the latest Architect planning
   * turn — a plan draft, plan revision, or planning checkpoint. `plan_ready`
   * is refused while the latest folded-into-planning acknowledgement
   * postdates every such turn. C4 (AR-R13): the checkpoint tool is gone, so
   * on new-policy runs the proof is always a plan draft or revision;
   * checkpoint turns persist only in replayed history.
   */
  readonly lastPlanningTurnSequence?: number;
  /** T3b: recorded blind obligations (record-before-verdict) by review id. */
  readonly coverageObligations: Readonly<Record<string, CoverageObligationsRecord>>;
  /** T3b repair cycle 1 (B2): plan-delivery record by review id. */
  readonly coveragePlanDelivered: Readonly<Record<string, CoveragePlanDeliveredRecord>>;
  /** T3b repair cycle 1 (B2/EP42): re-review own views by review id. */
  readonly coverageCorrectionViews: Readonly<Record<string, CoverageCorrectionViewRecord>>;
  /** T3b (OA-10#2): review id -> prior review id whose findings were released after the own view. */
  readonly coveragePriorFindingsReleased: Readonly<Record<string, string>>;
  /** T3b (OA-10#2): review id -> per-prior-finding checks supplied with the verdict. */
  readonly coveragePriorFindingChecks: Readonly<Record<string, readonly CoveragePriorFindingCheck[]>>;
  /** T3b: set while coverage review is explicitly unavailable; blocks plan_ready. */
  readonly coverageUnavailable?: CoverageUnavailableRecord;
  /** T3b repair cycle 1 (N6): suspended attempts by review id. */
  readonly coverageSuspended: Readonly<Record<string, CoverageSuspendedRecord>>;
  /** T3b repair cycle 2 (N-R2-2): findings retired by a source amendment, by finding id. */
  readonly coverageRetiredFindings: Readonly<Record<string, CoverageRetiredFinding>>;
  readonly hostCapabilities?: HostPlanningCapabilities;
  readonly executionAuthorization?: PlanningExecutionAuthorization;
  readonly resume: PlanningResumeIndex;
  readonly references: Readonly<Record<string, PlanningReferenceRecord>>;
}

export interface PlanningRecoveryAssignment {
  readonly assignmentId: string;
  readonly workspaceExists: boolean;
  readonly branchOrWorktree: string;
  readonly baseRevision: string;
  readonly headRevision: string;
}

export interface PlanningRecoveryEvidence {
  readonly id: string;
  readonly digest: string;
}

export interface PlanningRecoveryInput {
  readonly assignments: readonly PlanningRecoveryAssignment[];
  readonly evidence: readonly PlanningRecoveryEvidence[];
}

export interface PlanningReconciliationResult {
  readonly status: "verified" | "mismatch" | "unknown";
  readonly blockers: readonly string[];
}

export interface PlanningReductionContext {
  readonly taskStatuses?: ReadonlyMap<string, string>;
  readonly recovery?: PlanningRecoveryInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const candidate = value[key];
  if (!isRecord(candidate)) throw new Error(`${key} must be an object.`);
  return candidate;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim().length === 0) throw new Error(`${key} is required.`);
  return candidate;
}

function assertValidation(validation: PlanningValidation, label: string): void {
  if (!validation.valid) {
    throw new Error(`${label}: ${validation.issues.map((issue) => issue.message).join(" ")}`);
  }
}

function assertPlanningActor(event: PlanningEventInput): void {
  const allowed = PLANNING_EVENT_ACTOR_ROLES[event.type];
  if (!allowed.includes(event.actor.role)) {
    if (event.type === "planning.acceptance_recorded" && event.actor.role === "worker") {
      throw new Error("Workers cannot self-accept planning work.");
    }
    if (event.type === "planning.ledger_persisted" && event.actor.role === "worker") {
      throw new Error("Workers cannot rewrite the planning ledger.");
    }
    throw new Error(`Role ${event.actor.role} cannot append ${event.type}.`);
  }
  if (event.actor.id.trim().length === 0) throw new Error("Planning actor id is required.");
}

function amendmentById(projection: PlanningProjection, amendmentRef: string): SourceManifestAmendment | undefined {
  for (const manifestId of projection.source.manifestHistoryIds) {
    const amendment = projection.source.manifestsById[manifestId]?.amendment;
    if (amendment?.id === amendmentRef) return amendment;
  }
  return undefined;
}

function assertRecordedImpact(amendment: SourceManifestAmendment | undefined, label: string): SourceManifestAmendmentRecordedImpact {
  if (!amendment?.recordedImpact) {
    throw new Error(`${label} cites an amendment without recorded section and requirement impact.`);
  }
  const impact = amendment.recordedImpact;
  for (const list of [
    impact.addsSectionIds,
    impact.retiresSectionIds,
    impact.addsRequirementIds,
    impact.retiresRequirementIds,
  ]) {
    if (!Array.isArray(list) || list.some((id) => typeof id !== "string" || id.trim().length === 0)) {
      throw new Error(`${label} cites an amendment with malformed recorded impact.`);
    }
  }
  return impact;
}

function assertRetirementScope(
  projection: PlanningProjection,
  amendmentRef: unknown,
  requirement: SourceRequirement,
): void {
  if (typeof amendmentRef !== "string") throw new Error("Retirement requires amendmentRef.");
  const impact = assertRecordedImpact(amendmentById(projection, amendmentRef), `Retirement of ${requirement.id}`);
  if (!impact.retiresRequirementIds.includes(requirement.id)) {
    throw new Error(`Amendment ${amendmentRef} does not retire requirement ${requirement.id}.`);
  }
  for (const sectionId of requirement.reference.sectionIds) {
    if (!impact.retiresSectionIds.includes(sectionId) && !impact.addsSectionIds.includes(sectionId)) {
      throw new Error(`Amendment ${amendmentRef} does not cover source section ${sectionId}.`);
    }
  }
}

function assertSectionRetirementScope(
  projection: PlanningProjection,
  amendmentRef: unknown,
  sectionId: string,
): void {
  if (typeof amendmentRef !== "string") throw new Error("Section retirement requires amendmentRef.");
  const impact = assertRecordedImpact(amendmentById(projection, amendmentRef), `Retirement of ${sectionId}`);
  if (!impact.retiresSectionIds.includes(sectionId)) {
    throw new Error(`Amendment ${amendmentRef} does not retire source section ${sectionId}.`);
  }
}

function assertRevisionAmendmentScope(
  projection: PlanningProjection,
  revision: ExecutionPlanRevision,
): void {
  for (const requirement of revision.requirements) {
    if (requirement.applicability.status === "not_applicable") {
      const amendmentRef = requirement.applicability.disposition?.amendmentRef;
      if (amendmentRef !== undefined) assertRetirementScope(projection, amendmentRef, requirement);
    }
  }
  for (const section of revision.nonNormativeSections ?? []) {
    assertSectionRetirementScope(projection, section.amendmentRef, section.sectionId);
  }
  const priorIds = Object.keys(projection.plan?.revisionsById ?? {});
  const prior = priorIds.length > 0 ? projection.plan?.revisionsById[projection.plan.currentRevisionId] : undefined;
  if (prior) {
    const currentIds = new Set(revision.requirements.map((requirement) => requirement.id));
    for (const requirement of prior.requirements) {
      if (currentIds.has(requirement.id)) continue;
      const record = revision.retiredRequirementIds?.find((candidate) => candidate.requirementId === requirement.id);
      if (!record) throw new Error(`Requirement ${requirement.id} disappeared without retirement history.`);
      assertRetirementScope(projection, record.amendmentRef, requirement);
    }
  }
}

function assertLedgerBaselineRetained(
  projection: PlanningProjection,
  revision: ExecutionPlanRevision,
): void {
  const currentIds = new Set(revision.requirements.map((requirement) => requirement.id));
  const retired = new Map(
    (revision.retiredRequirementIds ?? []).map((record) => [record.requirementId, record]),
  );
  for (const requirement of projection.ledger?.requirements ?? []) {
    if (currentIds.has(requirement.id)) continue;
    const record = retired.get(requirement.id);
    if (!record) {
      throw new Error(`Plan revision drops ledger requirement ${requirement.id} without retirement history.`);
    }
    assertRetirementScope(projection, record.amendmentRef, requirement);
  }
}

function reopenedAcceptances(
  projection: PlanningProjection,
  priorRevision: ExecutionPlanRevision,
  revision: ExecutionPlanRevision,
): Record<string, PlanningAcceptanceState> {
  const priorTasks = new Map(priorRevision.tasks.map((task) => [task.id, task]));
  const nextTasks = new Map(revision.tasks.map((task) => [task.id, task]));
  const acceptances = { ...projection.acceptances };
  for (const [key, acceptance] of Object.entries(acceptances)) {
    if (acceptance.kind !== "task" || acceptance.status !== "accepted" || acceptance.taskId === undefined) continue;
    const priorTask = priorTasks.get(acceptance.taskId);
    const nextTask = nextTasks.get(acceptance.taskId);
    if (
      priorTask !== undefined &&
      nextTask !== undefined &&
      computeDigest(priorTask) === computeDigest(nextTask)
    ) continue;
    acceptances[key] = reopenAcceptance(acceptance, revision.revisionId, projection.observationSequence);
  }
  return acceptances;
}

function reopenAcceptance(
  acceptance: PlanningAcceptanceState,
  reopenedByPlanRevisionId: string,
  reopenedAtObservationOrder: number,
): PlanningAcceptanceState {
  const { history, ...current } = acceptance;
  return {
    ...current,
    status: "reopened",
    reopenedByPlanRevisionId,
    reopenedAtObservationOrder,
    history: [...(history ?? []), current],
  };
}

function acceptedWithHistory(
  acceptance: TaskAcceptance | PhaseAcceptance,
  kind: "task" | "phase",
  taskId: string | undefined,
  phaseId: string | undefined,
  planRevisionId: string,
  planRevisionDigest: string,
  prior: PlanningAcceptanceState | undefined,
  priorReopenOrder?: number,
): PlanningAcceptanceState {
  const base: PlanningAcceptanceState = {
    kind,
    ...(taskId === undefined ? {} : { taskId }),
    ...(phaseId === undefined ? {} : { phaseId }),
    record: acceptance,
    planRevisionId,
    planRevisionDigest,
    status: "accepted",
  };
  if (!prior) return base;
  const { history, ...current } = prior;
  return {
    ...base,
    ...(priorReopenOrder === undefined ? {} : { reopenedAtObservationOrder: priorReopenOrder }),
    history: [...(history ?? []), current],
  };
}

function assertTaskAcceptanceBindings(
  projection: PlanningProjection,
  revision: ExecutionPlanRevision,
  acceptance: TaskAcceptance,
  references: Readonly<Record<string, PlanningReferenceRecord>>,
  priorAcceptance?: PlanningAcceptanceState,
): void {
  if (!revision.tasks.some((task) => task.id === acceptance.taskId)) {
    throw new Error(`Task ${acceptance.taskId} is not in the current plan revision.`);
  }
  const taskValidations = Object.values(projection.validations).filter((state) => state.taskId === acceptance.taskId);
  if (taskValidations.length === 0) {
    throw new Error("Planning acceptance requires at least one validation observation.");
  }
  const observations = taskValidations.flatMap((state) =>
    state.planRevisionId === revision.revisionId && state.planRevisionDigest === revision.digest
      ? state.observations.map((observation) => ({
          state,
          observation,
          order: projection.observationOrderByObservationId[observation.id] ?? 0,
        }))
      : [],
  ).sort((left, right) => left.order - right.order);
  const checkIdentity = (
    kind: string,
    acceptanceConditionIds: readonly string[],
  ): string => `${kind}:${[...acceptanceConditionIds].sort().join(",")}`;
  const identities = new Set(observations.map((entry) =>
    checkIdentity("validation", entry.state.intent.acceptanceConditionIds)
  ));
  for (const identity of identities) {
    const latest = observations.filter((entry) =>
      checkIdentity("validation", entry.state.intent.acceptanceConditionIds) === identity
    ).at(-1);
    if (latest?.observation.outcome === "failed" || latest?.state.status === "failed") {
      throw new Error(`Current failed validation for check ${identity} prevents planning acceptance.`);
    }
  }
  const citedOrders: number[] = [];
  for (const check of acceptance.requiredChecks) {
    if (check.outcome !== "passed") {
      throw new Error("Every required check must have a passed validation observation.");
    }
    const cited = observations.find((entry) => entry.observation.id === check.refId);
    if (!cited || cited.observation.outcome !== "passed" || cited.state.status !== "passed") {
      throw new Error(`Required check ${check.refId} does not resolve to a current passed validation observation.`);
    }
    citedOrders.push(cited.order);
    const identity = checkIdentity(check.kind, cited.state.intent.acceptanceConditionIds);
    const relevant = observations.filter((entry) =>
      checkIdentity(check.kind, entry.state.intent.acceptanceConditionIds) === identity
    );
    const latest = relevant.at(-1);
    if (
      !latest ||
      latest.observation.id !== cited.observation.id ||
      latest.observation.outcome !== "passed" ||
      latest.state.status !== "passed"
    ) {
      throw new Error(`Required check ${check.refId} is not the latest passed observation for its check at the current task revision.`);
    }
  }
  if (
    priorAcceptance?.status === "reopened" &&
    priorAcceptance.reopenedAtObservationOrder !== undefined &&
    !citedOrders.some((order) => order > priorAcceptance.reopenedAtObservationOrder!)
  ) {
    throw new Error("Re-acceptance after reopen must cite an observation recorded after the reopen.");
  }
  if (projection.coverageReview?.id !== acceptance.reviewId) {
    throw new Error(`Review ${acceptance.reviewId} does not resolve to the current recorded coverage review.`);
  }
  if (
    projection.coverageReview.planRevisionId !== revision.revisionId ||
    projection.coverageReview.planRevisionDigest !== revision.digest
  ) {
    throw new Error("The recorded coverage review is stale for this plan revision.");
  }
  for (const integrationCheckId of acceptance.integrationCheckIds) {
    if (references[integrationCheckId]?.kind !== "integration") {
      throw new Error(`Integration check ${integrationCheckId} does not resolve to a recorded reference.`);
    }
  }
}

function cloneManifest(manifest: ApprovedSourceManifest): ApprovedSourceManifest {
  return structuredClone(manifest);
}

function cloneRevision(revision: ExecutionPlanRevision): ExecutionPlanRevision {
  return structuredClone(revision);
}

function cloneProjection(projection: PlanningProjection): PlanningProjection {
  return structuredClone(projection);
}

/**
 * C4 (AR-R13): the derived resume/inventory index. Covered and remaining
 * sections come from verified read receipts at the CURRENT manifest
 * revision — never from model prose. Completed contracts, outstanding work
 * and the next action come from the actual ledger, plan and review state:
 * the persisted ledger completes the ledger contract, each durable plan
 * revision bound to the CURRENT manifest completes a planning contract (a new
 * revision is the planning-turn proof; manifest-stale revisions never present
 * as current completion), and the current request lifecycle, readiness and
 * the authoritative open blocking findings drive outstanding work. Old
 * checkpoint records stay stored and replayable but no longer feed this index.
 */
function resumeIndex(projection: PlanningProjection): PlanningResumeIndex {
  const manifest = projection.source.manifestsById[projection.source.currentManifestId];
  const reads = projection.sourceReadIndex[manifest.manifestId] ?? {};
  const coveredIds = manifest.sections
    .filter((section) => reads[section.id] === section.digest)
    .map((section) => section.id);
  const remaining = manifest.sections
    .filter((section) => reads[section.id] !== section.digest)
    .map((section) => section.id);
  const completedPlanningContractIds = [
    ...(projection.ledger ? ["requirement-ledger"] : []),
    ...currentBoundRevisionIds(projection, manifest),
  ];
  const outstandingWork = derivedOutstandingWork(projection, manifest, remaining);
  return {
    coveredSourceSectionIds: coveredIds,
    remainingSourceSectionIds: remaining,
    ...(remaining[0] === undefined ? {} : { nextSourceSectionId: remaining[0] }),
    completedPlanningContractIds,
    outstandingWork,
    nextAction: outstandingWork[0] ??
      (projection.readiness === "ready" ? "The plan is ready." : "Request a coverage review."),
  };
}

/**
 * C4 (AR-R13): plan revision ids bound to the CURRENT manifest revision — a
 * source amendment invalidates older bindings, so only current-bound
 * revisions count as completed planning contracts.
 */
function currentBoundRevisionIds(
  projection: PlanningProjection,
  manifest: ApprovedSourceManifest,
): string[] {
  if (!projection.plan) return [];
  return projection.plan.revisionHistoryIds.filter((id) => {
    const revision = projection.plan!.revisionsById[id];
    return revision !== undefined &&
      revision.sourceManifestId === manifest.manifestId &&
      revision.sourceManifestDigest === manifest.artifactDigest;
  });
}

/**
 * C4 (AR-R13): outstanding planning work from the CURRENT bindings, the
 * current request lifecycle, readiness/gates and the authoritative open
 * blocking findings. Missing ledger, unread source, no plan, a manifest-stale
 * plan (revise before any review), review required, a bound review pending
 * its verdict, unavailable/suspended coverage, a passing bound review
 * awaiting the ready event, and the ready state each read distinctly — an
 * in-flight or passing review never asks for another review, and
 * resolved/retired findings never resurface while unresolved historical
 * findings never disappear. Reuses the existing projection helpers; no new
 * semantic authority.
 */
function derivedOutstandingWork(
  projection: PlanningProjection,
  manifest: ApprovedSourceManifest,
  remaining: readonly string[],
): string[] {
  if (!projection.ledger) return ["Persist the requirement ledger."];
  const outstanding = remaining.map((sectionId) => `Cover source section ${sectionId}.`);
  if (!projection.plan) {
    outstanding.push("Draft the execution plan.");
    return outstanding;
  }
  const revision = projection.plan.revisionsById[projection.plan.currentRevisionId];
  // Authoritative open blocking findings across recorded history: resolved
  // and retired findings never resurface, while unresolved historical
  // findings persist across revisions and amendments until resolved.
  const findingById = new Map<string, { category: string }>();
  const recordedReviews = projection.coverageReview
    ? [...projection.coverageReviewHistory, projection.coverageReview]
    : [...projection.coverageReviewHistory];
  for (const review of recordedReviews) {
    for (const finding of review.findings) {
      if (!findingById.has(finding.id)) findingById.set(finding.id, { category: finding.category });
    }
  }
  const openFindingItems = openBlockingCoverageFindings(projection).map((entry) =>
    `Resolve blocking coverage finding ${entry.findingId} (${findingById.get(entry.findingId)?.category ?? "blocking"}).`,
  );
  if (
    revision === undefined ||
    revision.sourceManifestId !== manifest.manifestId ||
    revision.sourceManifestDigest !== manifest.artifactDigest
  ) {
    outstanding.push(...openFindingItems);
    outstanding.push("Revise the execution plan against the current source manifest.");
    return outstanding;
  }
  if (projection.readiness === "ready") return outstanding;
  const recordedReviewIds = new Set<string>();
  if (projection.coverageReview) recordedReviewIds.add(projection.coverageReview.id);
  for (const review of projection.coverageReviewHistory) recordedReviewIds.add(review.id);
  const boundReview = projection.coverageReview !== undefined &&
    projection.coverageReview.planRevisionId === projection.plan.currentRevisionId &&
    projection.coverageReview.planRevisionDigest === projection.plan.currentDigest &&
    projection.coverageReview.sourceReadManifestId === manifest.manifestId
    ? projection.coverageReview
    : undefined;
  const currentRevisionId = projection.plan.currentRevisionId;
  const currentDigest = projection.plan.currentDigest;
  // C4 R1: a gate is stale only when proven bound to an older revision or
  // manifest — directly, or via its review request. Unbound gates stay
  // visible; staleness is never assumed. This mirrors the pump's
  // gateForCurrent binding check in reverse; no new reducer authority.
  const unavailableIsStale = (): boolean => {
    const gate = projection.coverageUnavailable;
    if (gate === undefined) return true;
    if (
      (gate.planRevisionId !== undefined && gate.planRevisionId !== currentRevisionId) ||
      (gate.sourceManifestId !== undefined && gate.sourceManifestId !== manifest.manifestId)
    ) {
      return true;
    }
    if (gate.reviewId !== undefined && !recordedReviewIds.has(gate.reviewId)) {
      const request = projection.coverageRequests[gate.reviewId];
      if (
        request !== undefined &&
        (request.planRevisionId !== currentRevisionId ||
          request.planRevisionDigest !== currentDigest ||
          request.sourceManifestId !== manifest.manifestId)
      ) {
        return true;
      }
    }
    return false;
  };
  const suspendedIsCurrent = (reviewId: string): boolean => {
    if (recordedReviewIds.has(reviewId)) return false;
    const request = projection.coverageRequests[reviewId];
    if (request === undefined) return true;
    return request.planRevisionId === currentRevisionId &&
      request.planRevisionDigest === currentDigest &&
      request.sourceManifestId === manifest.manifestId;
  };
  const gate = unavailableIsStale() ? undefined : projection.coverageUnavailable;
  const terminalGate = gate !== undefined &&
      (TERMINAL_COVERAGE_GATE_REASONS as readonly string[]).includes(gate.reason)
    ? gate
    : undefined;
  const pushBoundBlockingVerdicts = (): void => {
    if (boundReview === undefined) return;
    for (const verdict of boundReview.obligationVerdicts) {
      if (verdict.severity === "blocking" && (verdict.verdict === "missing" || verdict.verdict === "weakened")) {
        outstanding.push(`Resolve blocking coverage verdict for obligation ${verdict.obligationId} (${verdict.verdict}).`);
      }
    }
  };
  // Terminal exhaustion (N6) pauses for the owner: only an owner-authorized
  // resume or retry clears it, so the owner instruction stays the next
  // action while the known bound blocking verdicts and the authoritative
  // open findings ride as parallel facts. No wait/request/readiness follows.
  if (terminalGate !== undefined) {
    outstanding.push(
      `Coverage review ${terminalGate.reviewId ?? "coverage"} exhausted (${terminalGate.reason}): resume or retry with owner authorization.`,
    );
    pushBoundBlockingVerdicts();
    outstanding.push(...openFindingItems);
    return outstanding;
  }
  pushBoundBlockingVerdicts();
  outstanding.push(...openFindingItems);
  if (gate !== undefined) {
    outstanding.push(`Resolve unavailable coverage review (${gate.reason}).`);
  }
  // The plan_ready reducer refuses readiness under any other outstanding
  // gate, with one narrow retry exception: a plan_ready_blocked gate bound
  // to this same revision, manifest and review is a cached re-evaluation
  // signal that clears when readiness lands. While any other current gate
  // blocks, readiness is withheld, never recommended alongside it.
  const readinessBlockedByGate = gate !== undefined &&
    !(
      gate.reason === "plan_ready_blocked" &&
      gate.planRevisionId === currentRevisionId &&
      gate.sourceManifestId === manifest.manifestId &&
      (gate.reviewId === undefined || (boundReview !== undefined && gate.reviewId === boundReview.id))
    );
  if (boundReview !== undefined) {
    if (!coverageReviewHoldsReadiness(boundReview) && openFindingItems.length === 0 && !readinessBlockedByGate) {
      outstanding.push(`Record plan readiness for passing review ${boundReview.id}.`);
    }
  } else {
    const pending = Object.values(projection.coverageRequests).find((request) =>
      request.planRevisionId === currentRevisionId &&
      request.planRevisionDigest === currentDigest &&
      request.sourceManifestId === manifest.manifestId &&
      !recordedReviewIds.has(request.reviewId)
    );
    if (pending !== undefined) {
      outstanding.push(`Await coverage review ${pending.reviewId} verdict.`);
    } else {
      outstanding.push("Request a coverage review.");
    }
  }
  // Ordinary suspension is transient: the pump retries, so the live wait
  // above stays the action and the suspension rides as a parallel fact.
  // Stale history (an old binding, or a landed verdict) is not a current
  // blocked request and stays out.
  for (const suspended of Object.values(projection.coverageSuspended)) {
    if (suspendedIsCurrent(suspended.reviewId)) {
      outstanding.push(
        `Resolve suspended coverage review ${suspended.reviewId} (${suspended.attempts} suspended attempts: ${suspended.lastReason}).`,
      );
    }
  }
  return outstanding;
}

function withResume(projection: PlanningProjection): PlanningProjection {
  return { ...projection, resume: resumeIndex(projection) };
}

export function derivePlanningOwnershipView(projection: PlanningProjection): {
  readonly requirementOwners: Readonly<Record<string, string>>;
  readonly phaseOwners: Readonly<Record<string, readonly string[]>>;
} {
  const requirementOwners: Record<string, string> = {};
  const phaseOwners: Record<string, readonly string[]> = {};
  const revision = projection.plan
    ? projection.plan.revisionsById[projection.plan.currentRevisionId]
    : undefined;
  for (const requirement of revision?.requirements ?? projection.ledger?.requirements ?? []) {
    requirementOwners[requirement.id] = requirement.accountablePhaseId;
  }
  for (const phase of revision?.phases ?? projection.ledger?.phases ?? []) {
    phaseOwners[phase.id] = phase.requirementIds;
  }
  return { requirementOwners, phaseOwners };
}

export function reconcilePlanningProjection(
  projection: PlanningProjection,
  actual: PlanningRecoveryInput,
): PlanningReconciliationResult {
  const blockers: string[] = [];
  let uncertain = false;
  const assignments = new Map(actual.assignments.map((assignment) => [assignment.assignmentId, assignment]));
  for (const [assignmentId, state] of Object.entries(projection.assignments)) {
    if (state.status !== "claimed") continue;
    const observed = assignments.get(assignmentId);
    if (!observed) {
      uncertain = true;
      continue;
    }
    if (!observed.workspaceExists) blockers.push(`Assignment ${assignmentId} lost its owned workspace.`);
    if (observed.branchOrWorktree !== state.claim.branchOrWorktree) blockers.push(`Assignment ${assignmentId} worktree identity drifted.`);
    if (observed.baseRevision !== state.claim.acceptedBaseRevision) blockers.push(`Assignment ${assignmentId} base revision drifted.`);
    if (observed.headRevision.trim().length === 0) {
      uncertain = true;
      blockers.push(`Assignment ${assignmentId} commit identity is unknown.`);
    }
  }
  const evidence = new Map(actual.evidence.map((record) => [record.id, record.digest]));
  for (const reference of Object.values(projection.references)) {
    if (reference.kind !== "evidence") continue;
    const digest = evidence.get(reference.id);
    if (digest === undefined) {
      uncertain = true;
    } else if (reference.digest !== undefined && digest !== reference.digest) {
      blockers.push(`Evidence ${reference.id} identity drifted.`);
    }
  }
  return { status: blockers.length > 0 ? "mismatch" : uncertain ? "unknown" : "verified", blockers };
}

function amendmentHistory(projection: PlanningProjection): SourceManifestAmendment[] {
  return projection.source.manifestHistoryIds.flatMap((manifestId) => {
    const amendment = projection.source.manifestsById[manifestId]?.amendment;
    return amendment ? [amendment] : [];
  });
}

export interface CoveragePlanReadinessInput {
  readonly manifest: ApprovedSourceManifest;
  readonly revision: ExecutionPlanRevision;
  readonly coverageReview: CoverageReview;
  readonly priorRevision?: ExecutionPlanRevision;
  readonly amendmentHistory: readonly SourceManifestAmendment[];
}

/**
 * T3b repair cycle 2 (N-R2-1): the ONE shared plan-readiness input builder.
 * The plan_ready reducer, the runtime pre-check, and renderPlanningStatus
 * all build from here, so the amendment history (and prior revision) can
 * never diverge again. Returns undefined when no plan or review exists yet.
 */
export function coveragePlanReadinessInput(
  planning: PlanningProjection,
  priorRevisionId: string | undefined,
): CoveragePlanReadinessInput | undefined {
  if (!planning.plan || !planning.coverageReview) return undefined;
  const manifest = planning.source.manifestsById[planning.source.currentManifestId];
  const revision = planning.plan.revisionsById[planning.plan.currentRevisionId];
  if (!manifest || !revision) return undefined;
  const priorRevision = priorRevisionId ? planning.plan.revisionsById[priorRevisionId] : undefined;
  return {
    manifest,
    revision,
    coverageReview: planning.coverageReview,
    ...(priorRevision ? { priorRevision } : {}),
    amendmentHistory: amendmentHistory(planning),
  };
}

/**
 * T3b repair cycle 2 (N-R2-2): findings retired by an owner-authorized
 * source amendment. A finding cites its obligation's ledger requirement
 * (finding.requirementId); the obligation is retired when EVERY section of
 * that requirement is structurally absent from the new manifest — the N6
 * rule (no trust in the amendment's recorded impact). Findings without a
 * requirement id, on unknown requirements, on requirements with a surviving
 * section, or already resolved stay open. Only open findings close here.
 */
function retireFindingsForAmendment(
  projection: PlanningProjection,
  manifest: ApprovedSourceManifest,
  retiredAt: string,
): Record<string, CoverageRetiredFinding> {
  const retired: Record<string, CoverageRetiredFinding> = {};
  if (!projection.ledger) return retired;
  const surviving = new Set(manifest.sections.map((section) => section.id));
  const retiredRequirements = new Set<string>();
  for (const requirement of projection.ledger.requirements) {
    if (
      requirement.reference?.sourceId === manifest.sourceId &&
      requirement.reference.sectionIds.length > 0 &&
      requirement.reference.sectionIds.every((sectionId) => !surviving.has(sectionId))
    ) {
      retiredRequirements.add(requirement.id);
    }
  }
  if (retiredRequirements.size === 0) return retired;
  const resolved = new Set<string>();
  for (const checks of Object.values(projection.coveragePriorFindingChecks)) {
    for (const check of checks) {
      if (check.status === "resolved") resolved.add(check.priorFindingId);
    }
  }
  const amendmentId = manifest.amendment?.id ?? manifest.manifestId;
  const reviews = projection.coverageReview
    ? [...projection.coverageReviewHistory, projection.coverageReview]
    : [...projection.coverageReviewHistory];
  for (const review of reviews) {
    for (const finding of review.findings) {
      if (
        finding.requirementId !== undefined &&
        retiredRequirements.has(finding.requirementId) &&
        !resolved.has(finding.id) &&
        projection.coverageRetiredFindings[finding.id] === undefined
      ) {
        retired[finding.id] = {
          findingId: finding.id,
          reviewId: review.id,
          retiredByAmendmentId: amendmentId,
          retiredAt,
        };
      }
    }
  }
  return retired;
}

/**
 * T3b (N6 rule): checkpoints are monotonic over source sections that STILL
 * EXIST in the current manifest revision. A section retired by an amendment is
 * dropped from coverage (it no longer exists to cover); every other
 * previously covered section must be retained. Histories without a retiring
 * amendment behave exactly as before, so old logs replay identically.
 */
function assertMonotonicCheckpoint(
  previous: PlanningCheckpoint | undefined,
  next: PlanningCheckpoint,
  stillExists: ReadonlySet<string>,
): void {
  if (!previous) return;
  if (
    previous.coveredSourceSectionIds
      .filter((id) => stillExists.has(id))
      .some((id) => !next.coveredSourceSectionIds.includes(id))
  ) {
    throw new Error("Planning checkpoints cannot drop covered source sections.");
  }
  if (previous.completedPlanningContractIds.some((id) => !next.completedPlanningContractIds.includes(id))) {
    throw new Error("Planning checkpoints cannot drop completed planning contracts.");
  }
}

/**
 * T3b: sections of the current manifest without a durable full verified read
 * at this exact manifest revision (N2). Old reads never satisfy a new
 * revision; a digest mismatch means the section changed and needs a re-read.
 */
function unreadSectionIdsAtCurrentManifest(projection: PlanningProjection): string[] {
  const manifest = projection.source.manifestsById[projection.source.currentManifestId];
  const reads = projection.sourceReadIndex[manifest.manifestId] ?? {};
  return manifest.sections
    .filter((section) => reads[section.id] !== section.digest)
    .map((section) => section.id);
}

function assertDurableSectionReads(
  projection: PlanningProjection,
  sectionIds: readonly string[],
  label: string,
): void {
  const manifest = projection.source.manifestsById[projection.source.currentManifestId];
  const reads = projection.sourceReadIndex[manifest.manifestId] ?? {};
  const missing = sectionIds.filter((id) => {
    const section = manifest.sections.find((candidate) => candidate.id === id);
    return !section || reads[id] !== section.digest;
  });
  if (missing.length > 0) {
    throw new Error(
      `${label} counts source section(s) without a durable full read at the current manifest revision: ${missing.join(", ")}.`,
    );
  }
}

/**
 * T9 repair cycle 3 (B4-r3): the idempotency comparison for a re-appended
 * coverage review request. Compares the request payload, never the
 * `requestedSequence` stamp, so an identical re-append keeps its first
 * sequence instead of conflicting with itself.
 */
function sameCoverageReviewRequest(
  left: CoverageReviewRequestRecord,
  right: CoverageReviewRequestRecord,
): boolean {
  return left.reviewId === right.reviewId &&
    left.planRevisionId === right.planRevisionId &&
    left.planRevisionDigest === right.planRevisionDigest &&
    left.sourceManifestId === right.sourceManifestId &&
    left.priorReviewId === right.priorReviewId &&
    left.requestedAt === right.requestedAt;
}

/** T3b: resolve a prior coverage review from the current review or its history. */
function recordedCoverageReview(
  projection: PlanningProjection,
  reviewId: string,
): CoverageReview | undefined {
  if (projection.coverageReview?.id === reviewId) return projection.coverageReview;
  return projection.coverageReviewHistory.find((review) => review.id === reviewId);
}

/**
 * T3b: validate recorded obligations at the reducer gate. Mirrors T1's
 * derived-obligation rules (planning-contracts.ts is read-only here): every
 * obligation must be stamped as recorded before the plan/diff was provided —
 * a direct event with a false stamp is a forged record-before-verdict claim
 * and is refused.
 */
function parseRecordedObligations(value: unknown): DerivedObligation[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Coverage review requires durably recorded derived obligations.");
  }
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`Derived obligation ${index} is invalid.`);
    const id = candidate.id;
    const description = candidate.description;
    const recordedAt = candidate.recordedAt;
    if (
      typeof id !== "string" || id.trim().length === 0 ||
      typeof description !== "string" || description.trim().length === 0 ||
      typeof recordedAt !== "string" || recordedAt.trim().length === 0
    ) {
      throw new Error("Derived obligation requires id, description, and a valid recordedAt timestamp.");
    }
    if (seen.has(id)) throw new Error(`Duplicate derived obligation id ${id}.`);
    seen.add(id);
    if (candidate.recordedBeforePlanOrDiffProvided !== true) {
      throw new Error(
        `Derived obligation ${id} was not recorded before the plan/diff was provided (record-before-verdict gate).`,
      );
    }
    const requirementId = candidate.requirementId;
    if (requirementId !== undefined && (typeof requirementId !== "string" || requirementId.trim().length === 0)) {
      throw new Error(`Derived obligation ${id} has an invalid requirementId.`);
    }
    return {
      id,
      ...(requirementId === undefined ? {} : { requirementId: requirementId as string }),
      description: description as string,
      recordedBeforePlanOrDiffProvided: true as const,
      recordedAt: recordedAt as string,
    };
  });
}

function assertObligationSetsMatch(recorded: readonly DerivedObligation[], review: CoverageReview): void {
  const recordedIds = new Set(recorded.map((obligation) => obligation.id));
  const verdictIds = new Set(
    (Array.isArray(review.obligationVerdicts) ? review.obligationVerdicts : [])
      .filter(isRecord)
      .map((verdict) => (verdict as { obligationId?: unknown }).obligationId)
      .filter((id): id is string => typeof id === "string"),
  );
  const derivedIds = new Set(
    (Array.isArray(review.derivedObligations) ? review.derivedObligations : [])
      .filter(isRecord)
      .map((obligation) => (obligation as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string"),
  );
  for (const id of recordedIds) {
    if (!derivedIds.has(id) || !verdictIds.has(id)) {
      throw new Error(
        `Coverage review ${review.id} has no verdict for recorded obligation ${id} (record-before-verdict gate).`,
      );
    }
  }
  for (const id of derivedIds) {
    if (!recordedIds.has(id)) {
      throw new Error(
        `Coverage review ${review.id} cites obligation ${id}, which was never durably recorded before the verdict.`,
      );
    }
  }
}

/**
 * T3b repair cycle 1 (N4): every manifest section is accounted for exactly
 * once — either by at least one recorded obligation id, or by an explicit
 * reviewer reason why the section imposes no obligation. Every recorded
 * obligation must be cited by at least one section (no orphan obligations).
 */
function parseSectionCoverage(
  value: unknown,
  manifest: ApprovedSourceManifest,
  obligationIds: ReadonlySet<string>,
): CoverageSectionCoverage[] {
  if (!Array.isArray(value)) {
    throw new Error("Coverage obligations require section coverage for every source section (N4).");
  }
  const manifestIds = new Set(manifest.sections.map((section) => section.id));
  const seen = new Set<string>();
  const cited = new Set<string>();
  const coverage = value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`Coverage section entry ${index} is invalid.`);
    const sectionId = candidate.sectionId;
    const ids = candidate.obligationIds;
    const reason = candidate.noObligationReason;
    if (typeof sectionId !== "string" || !manifestIds.has(sectionId)) {
      throw new Error(`Coverage section entry ${index} cites an unknown source section.`);
    }
    if (seen.has(sectionId)) throw new Error(`Duplicate coverage entry for source section ${sectionId}.`);
    seen.add(sectionId);
    if (!Array.isArray(ids)) throw new Error(`Coverage for section ${sectionId} requires obligationIds.`);
    for (const id of ids) {
      if (typeof id !== "string" || !obligationIds.has(id)) {
        throw new Error(`Coverage for section ${sectionId} cites unknown obligation ${String(id)}.`);
      }
      cited.add(id);
    }
    if (ids.length === 0) {
      if (typeof reason !== "string" || reason.trim().length === 0) {
        throw new Error(
          `Source section ${sectionId} has no covering obligation and no explicit no-obligation reason (N4).`,
        );
      }
      return { sectionId, obligationIds: [] as readonly string[], noObligationReason: reason };
    }
    if (reason !== undefined) {
      throw new Error(`Source section ${sectionId} cannot name both obligations and a no-obligation reason.`);
    }
    return { sectionId, obligationIds: [...ids] as readonly string[] };
  });
  for (const id of manifestIds) {
    if (!seen.has(id)) {
      throw new Error(`Source section ${id} is unaccounted: no covering obligation or no-obligation reason (N4).`);
    }
  }
  for (const id of obligationIds) {
    if (!cited.has(id)) {
      throw new Error(`Derived obligation ${id} is cited by no source section (N4).`);
    }
  }
  return coverage;
}

/**
 * T3b repair cycle 1 (B3): cumulative open blocking findings — every blocking
 * finding in any recorded review that no re-review verdict has explicitly
 * checked `resolved`. Resolved findings stay resolved; outstanding or never
 * checked findings stay open across further revisions until resolved.
 * Repair cycle 2: finding ids are unique across all reviews of the run (R2-2
 * refusal), so keying by id names exactly one finding; findings retired by a
 * source amendment (N-R2-2) are closed and never open.
 */
export function openBlockingCoverageFindings(
  projection: Pick<PlanningProjection, "coverageReview" | "coverageReviewHistory" | "coveragePriorFindingChecks" | "coverageRetiredFindings">,
): { readonly reviewId: string; readonly findingId: string }[] {
  const resolved = new Set<string>();
  for (const checks of Object.values(projection.coveragePriorFindingChecks)) {
    for (const check of checks) {
      if (check.status === "resolved") resolved.add(check.priorFindingId);
    }
  }
  const retired = projection.coverageRetiredFindings ?? {};
  const open: { reviewId: string; findingId: string }[] = [];
  const reviews = projection.coverageReview
    ? [...projection.coverageReviewHistory, projection.coverageReview]
    : [...projection.coverageReviewHistory];
  for (const review of reviews) {
    for (const finding of review.findings) {
      if (finding.severity === "blocking" && !resolved.has(finding.id) && retired[finding.id] === undefined) {
        open.push({ reviewId: review.id, findingId: finding.id });
      }
    }
  }
  return open;
}

/**
 * T3b repair cycle 2 (R2-2): a finding id already used by any earlier review
 * of the same run is refused — a reused id would let one finding's
 * resolution close a different finding (B3/EP44 laundering).
 */
function assertFindingIdsUnused(projection: PlanningProjection, review: CoverageReview): void {
  const usedByReviewId = new Map<string, string>();
  const known = projection.coverageReview
    ? [...projection.coverageReviewHistory, projection.coverageReview]
    : [...projection.coverageReviewHistory];
  for (const recorded of known) {
    for (const finding of recorded.findings) {
      if (!usedByReviewId.has(finding.id)) usedByReviewId.set(finding.id, recorded.id);
    }
  }
  for (const finding of review.findings) {
    const earlier = usedByReviewId.get(finding.id);
    if (earlier !== undefined) {
      throw new Error(
        `Coverage review ${review.id} reuses finding id ${finding.id} from earlier review ${earlier}; finding ids must be unique across all reviews of the run.`,
      );
    }
  }
}

/**
 * T3b repair cycle 1 (B3): finding ids a re-review verdict must check — the
 * immediate prior review's every finding (blocking and advisory, as before)
 * plus every cumulative open blocking finding from older reviews.
 */
function requiredPriorFindingIds(
  projection: PlanningProjection,
  prior: CoverageReview,
): ReadonlySet<string> {
  const retired = projection.coverageRetiredFindings ?? {};
  const required = new Set<string>(
    prior.findings.filter((finding) => retired[finding.id] === undefined).map((finding) => finding.id),
  );
  for (const entry of openBlockingCoverageFindings(projection)) {
    required.add(entry.findingId);
  }
  return required;
}

/** T3b (OA-10#2) repair cycle 1 (B3): every required prior finding is checked exactly once. */
function parsePriorFindingChecks(
  value: unknown,
  prior: CoverageReview,
  requiredIds: ReadonlySet<string>,
): CoveragePriorFindingCheck[] {
  if (!Array.isArray(value)) {
    throw new Error(`Re-review ${prior.id} requires a prior-finding check for every prior finding.`);
  }
  const priorIds = new Set(requiredIds);
  const seen = new Set<string>();
  const checks = value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`Prior-finding check ${index} is invalid.`);
    const priorFindingId = candidate.priorFindingId;
    const status = candidate.status;
    const rationale = candidate.rationale;
    if (typeof priorFindingId !== "string" || !priorIds.has(priorFindingId)) {
      throw new Error(`Prior-finding check ${index} cites an unknown prior finding.`);
    }
    if (seen.has(priorFindingId)) throw new Error(`Duplicate prior-finding check for ${priorFindingId}.`);
    seen.add(priorFindingId);
    if (status !== "resolved" && status !== "outstanding") {
      throw new Error(`Prior-finding check for ${priorFindingId} has an invalid status.`);
    }
    if (typeof rationale !== "string" || rationale.trim().length === 0) {
      throw new Error(`Prior-finding check for ${priorFindingId} requires a rationale.`);
    }
    return {
      priorFindingId: priorFindingId as string,
      status: status as "resolved" | "outstanding",
      rationale: rationale as string,
    };
  });
  for (const id of priorIds) {
    if (!seen.has(id)) {
      throw new Error(`Re-review leaves prior finding ${id} unchecked (every prior finding must be checked).`);
    }
  }
  return checks;
}

const PLANNING_REFERENCE_KINDS: ReadonlySet<PlanningReferenceRecord["kind"]> = new Set([
  "gate",
  "evidence",
  "review",
  "integration",
  "worktree",
  "commit",
  "repair",
]);

function validateEventReferences(
  event: PlanningEventInput,
  existing: Readonly<Record<string, PlanningReferenceRecord>>,
): Record<string, PlanningReferenceRecord> {
  const input = event.payload.references;
  if (input === undefined) {
    if (event.type === "planning.reference_recorded") {
      throw new Error("planning.reference_recorded requires at least one reference.");
    }
    return {};
  }
  if (event.type !== "planning.reference_recorded") {
    throw new Error("Only planning.reference_recorded may write planning references.");
  }
  if (!isRecord(input)) throw new Error("Planning references must be an object.");
  if (Object.keys(input).length === 0) throw new Error("planning.reference_recorded requires at least one reference.");
  const additions: Record<string, PlanningReferenceRecord> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      !isRecord(value) ||
      key !== value.id ||
      typeof value.id !== "string" ||
      value.id.trim().length === 0 ||
      !PLANNING_REFERENCE_KINDS.has(value.kind as PlanningReferenceRecord["kind"]) ||
      (value.digest !== undefined && (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)))
    ) {
      throw new Error(`Planning reference ${key} is malformed.`);
    }
    const reference = structuredClone(value) as unknown as PlanningReferenceRecord;
    if (reference.kind === "evidence") {
      throw new Error("Evidence references can only be recorded by validation observations.");
    }
    const prior = existing[key];
    if (prior && JSON.stringify(prior) !== JSON.stringify(reference)) {
      throw new Error(`Planning reference ${key} already exists with a different identity.`);
    }
    additions[key] = reference;
  }
  return additions;
}

function boundRevision(projection: PlanningProjection, payload: Record<string, unknown>): {
  readonly revision: ExecutionPlanRevision;
  readonly expectedRevisionId?: string;
  readonly expectedDigest?: string;
} {
  const revision = structuredClone(payload.revision) as ExecutionPlanRevision;
  const expectedRevisionId = typeof payload.expectedRevisionId === "string" ? payload.expectedRevisionId : undefined;
  const expectedDigest = typeof payload.expectedDigest === "string" ? payload.expectedDigest : undefined;
  if (projection.plan) {
    if (expectedRevisionId !== projection.plan.currentRevisionId || expectedDigest !== projection.plan.currentDigest) {
      throw new Error("Planning event uses a stale plan revision.");
    }
  } else if (expectedRevisionId !== undefined || expectedDigest !== undefined) {
    throw new Error("Planning event uses a stale plan revision.");
  }
  return { revision, ...(expectedRevisionId === undefined ? {} : { expectedRevisionId }), ...(expectedDigest === undefined ? {} : { expectedDigest }) };
}

function assertPlanBinding(projection: PlanningProjection, payload: Record<string, unknown>): void {
  if (!projection.plan) throw new Error("Planning event requires a current plan revision.");
  if (
    payload.expectedRevisionId !== projection.plan.currentRevisionId ||
    payload.expectedDigest !== projection.plan.currentDigest
  ) {
    throw new Error("Planning event uses a stale plan revision.");
  }
}

export function createPlanningProjection(event: PlanningEventInput): PlanningProjection {
  if (event.type !== "planning.source_registered") {
    throw new Error("Planning state must begin with planning.source_registered.");
  }
  assertPlanningActor(event);
  const manifest = structuredClone(event.payload.manifest) as ApprovedSourceManifest;
  assertValidation(validateApprovedSourceManifest(manifest), "Source manifest");
  if (manifest.amendment) throw new Error("The first source registration cannot be an amendment.");
  const projection: PlanningProjection = {
    source: {
      currentManifestId: manifest.manifestId,
      sourceId: manifest.sourceId,
      artifactDigest: manifest.artifactDigest,
      manifestHistoryIds: [manifest.manifestId],
      manifestsById: { [manifest.manifestId]: cloneManifest(manifest) },
    },
    checkpoints: [],
    sourceReadIndex: {},
    assignments: {},
    validations: {},
    observationSequence: 0,
    observationOrderByObservationId: {},
    acceptances: {},
    readiness: "not_ready",
    coverageReviewHistory: [],
    coverageRequests: {},
    coverageObligations: {},
    coveragePlanDelivered: {},
    coverageCorrectionViews: {},
    coveragePriorFindingsReleased: {},
    coveragePriorFindingChecks: {},
    coverageSuspended: {},
    coverageRetiredFindings: {},
    resume: {
      coveredSourceSectionIds: [],
      remainingSourceSectionIds: manifest.sections.map((section) => section.id),
      ...(manifest.sections[0] === undefined ? {} : { nextSourceSectionId: manifest.sections[0].id }),
      completedPlanningContractIds: [],
      outstandingWork: ["Persist the requirement ledger."],
      nextAction: "Persist the requirement ledger.",
    },
    references: {},
  };
  // C4 (AR-R13): the initial index shares the event-derived policy — derive
  // it through the same helper instead of hardcoding a second listing.
  return withResume(projection);
}

export function reducePlanningProjection(
  current: PlanningProjection | undefined,
  event: PlanningEventInput,
  context: PlanningReductionContext = {},
): PlanningProjection {
  if (!current) return createPlanningProjection(event);
  assertPlanningActor(event);
  const eventReferences = validateEventReferences(event, current.references);
  let next: PlanningProjection = {
    ...cloneProjection(current),
    references: { ...current.references, ...eventReferences },
  };
  switch (event.type) {
    case "planning.source_registered":
      throw new Error("Planning source cannot be registered twice.");
    case "planning.source_amended": {
      const prior = next.source.manifestsById[next.source.currentManifestId];
      const manifest = structuredClone(event.payload.manifest) as ApprovedSourceManifest;
      assertValidation(validateApprovedSourceManifest(manifest), "Source amendment");
      if (manifest.sourceId !== next.source.sourceId) throw new Error("Source amendment changed source identity.");
      verifyAmendmentReferencesPredecessor(manifest, prior);
      assertRecordedImpact(manifest.amendment, "Source amendment");
      // N-R2-2: open findings on retired obligations close as retired here —
      // the only place retirement happens (owner-authorized amendment event).
      const retiredFindings = retireFindingsForAmendment(next, manifest, event.occurredAt);
      next = {
        ...next,
        source: {
          ...next.source,
          currentManifestId: manifest.manifestId,
          artifactDigest: manifest.artifactDigest,
          manifestHistoryIds: [...next.source.manifestHistoryIds, manifest.manifestId],
          manifestsById: { ...next.source.manifestsById, [manifest.manifestId]: cloneManifest(manifest) },
        },
        coverageRetiredFindings: { ...next.coverageRetiredFindings, ...retiredFindings },
        readiness: "not_ready",
      };
      break;
    }
    case "planning.ledger_persisted": {
      if (next.ledger) throw new Error("The initial planning ledger is already persisted.");
      const requirements = structuredClone(event.payload.requirements) as SourceRequirement[];
      const phases = structuredClone(event.payload.phases) as ExecutionPlanPhase[];
      const nonNormativeSections = structuredClone(event.payload.nonNormativeSections ?? []) as ExecutionPlanRevision["nonNormativeSections"];
      assertValidation(validateRequirementLedger(
        requirements,
        next.source.manifestsById[next.source.currentManifestId],
        phases.map((phase) => phase.id),
        nonNormativeSections ?? [],
        amendmentHistory(next),
      ), "Planning ledger");
      next = {
        ...next,
        ledger: {
          id: requiredString(event.payload, "id"),
          requirements,
          phases,
        },
      };
      break;
    }
    case "planning.source_section_read": {
      const manifest = next.source.manifestsById[next.source.currentManifestId];
      const manifestId = requiredString(event.payload, "manifestId");
      const manifestDigest = requiredString(event.payload, "manifestDigest");
      const sectionId = requiredString(event.payload, "sectionId");
      const sectionDigest = requiredString(event.payload, "sectionDigest");
      requiredString(event.payload, "readAt");
      if (manifestId !== manifest.manifestId || manifestDigest !== manifest.artifactDigest) {
        throw new Error("Source section read cites a stale manifest revision; re-read at the current manifest.");
      }
      const section = manifest.sections.find((candidate) => candidate.id === sectionId);
      if (!section) throw new Error(`Source section read references unknown source section ${sectionId}.`);
      if (sectionDigest !== section.digest) {
        throw new Error(`Source section read for ${sectionId} does not match its recorded digest (source drift).`);
      }
      const priorReads = next.sourceReadIndex[manifest.manifestId] ?? {};
      if (priorReads[sectionId] === section.digest) break;
      next = {
        ...next,
        sourceReadIndex: {
          ...next.sourceReadIndex,
          [manifest.manifestId]: { ...priorReads, [sectionId]: section.digest },
        },
      };
      break;
    }
    case "planning.checkpoint_recorded": {
      if (!next.ledger) throw new Error("Planning checkpoint requires a persisted ledger.");
      if (next.readiness === "ready") {
        throw new Error("Planning checkpoints cannot be recorded after plan_ready without a new readiness transition.");
      }
      const checkpoint = structuredClone(event.payload.checkpoint) as PlanningCheckpoint;
      assertValidation(validatePlanningCheckpoint(checkpoint), "Planning checkpoint");
      const sectionIds = new Set(next.source.manifestsById[next.source.currentManifestId].sections.map((section) => section.id));
      assertMonotonicCheckpoint(next.checkpoints.at(-1)?.checkpoint, checkpoint, sectionIds);
      if (checkpoint.coveredSourceSectionIds.some((id) => !sectionIds.has(id))) throw new Error("Planning checkpoint references an unknown source section.");
      assertDurableSectionReads(next, checkpoint.coveredSourceSectionIds, "Planning checkpoint");
      const manifest = next.source.manifestsById[next.source.currentManifestId];
      next = {
        ...next,
        checkpoints: [
          ...next.checkpoints,
          {
            checkpoint,
            sourceManifestId: manifest.manifestId,
            sourceManifestDigest: manifest.artifactDigest,
            sectionDigests: Object.fromEntries(manifest.sections.map((section) => [section.id, section.digest])),
          },
        ],
        readiness: "not_ready",
        // T9 repair cycle 3 (B4-r3): a checkpoint is an Architect planning
        // turn — it can carry the "reviewed against folded guidance" proof.
        ...(event.sequence === undefined ? {} : { lastPlanningTurnSequence: event.sequence }),
      };
      break;
    }
    case "planning.plan_drafted":
    case "planning.plan_revised": {
      if (!next.ledger) throw new Error("Planning requires the skeleton ledger first.");
      const bound = boundRevision(next, event.payload);
      if (event.type === "planning.plan_drafted" && next.plan) throw new Error("An initial planning revision already exists.");
      if (event.type === "planning.plan_revised" && !next.plan) throw new Error("Planning revision requires an initial draft.");
      assertValidation(validateExecutionPlanRevision(
        bound.revision,
        next.source.manifestsById[next.source.currentManifestId],
        amendmentHistory(next),
      ), "Execution plan revision");
      assertRevisionAmendmentScope(next, bound.revision);
      assertLedgerBaselineRetained(next, bound.revision);
      if (next.plan && next.plan.revisionHistoryIds.includes(bound.revision.revisionId)) {
        throw new Error("Planning revision ids must be new across revision history.");
      }
      const priorRevision = next.plan ? next.plan.revisionsById[next.plan.currentRevisionId] : undefined;
      const acceptances = priorRevision
        ? reopenedAcceptances(next, priorRevision, bound.revision)
        : next.acceptances;
      next = {
        ...next,
        acceptances,
        plan: {
          currentRevisionId: bound.revision.revisionId,
          currentDigest: bound.revision.digest,
          revisionHistoryIds: [...(next.plan?.revisionHistoryIds ?? []), bound.revision.revisionId],
          revisionsById: { ...(next.plan?.revisionsById ?? {}), [bound.revision.revisionId]: cloneRevision(bound.revision) },
        },
        readiness: "not_ready",
        // T9 repair cycle 3 (B4-r3): a draft or revision is an Architect
        // planning turn — the new plan content postdates the folded guidance.
        ...(event.sequence === undefined ? {} : { lastPlanningTurnSequence: event.sequence }),
      };
      break;
    }
    case "planning.coverage_review_requested": {
      if (!next.plan) throw new Error("Coverage review requires a drafted plan.");
      const reviewId = requiredString(event.payload, "reviewId");
      const planRevisionId = requiredString(event.payload, "planRevisionId");
      const planRevisionDigest = requiredString(event.payload, "planRevisionDigest");
      const sourceManifestId = requiredString(event.payload, "sourceManifestId");
      const requestedAt = requiredString(event.payload, "requestedAt");
      const priorReviewId = event.payload.priorReviewId === undefined
        ? undefined
        : requiredString(event.payload, "priorReviewId");
      if (
        planRevisionId !== next.plan.currentRevisionId ||
        planRevisionDigest !== next.plan.currentDigest ||
        sourceManifestId !== next.source.currentManifestId
      ) {
        throw new Error("Coverage review request cites a stale plan revision or source manifest.");
      }
      if (priorReviewId !== undefined && !recordedCoverageReview(next, priorReviewId)) {
        throw new Error(`Coverage re-review cites unknown prior review ${priorReviewId}.`);
      }
      const prior = next.coverageRequests[reviewId];
      const record: CoverageReviewRequestRecord = {
        reviewId,
        planRevisionId,
        planRevisionDigest,
        sourceManifestId,
        ...(priorReviewId === undefined ? {} : { priorReviewId }),
        requestedAt,
        // T9 repair cycle 3 (B4-r3): stamp the requesting event's sequence so
        // plan_ready can refuse a review that predates a folded acknowledgement.
        ...(event.sequence === undefined ? {} : { requestedSequence: event.sequence }),
      };
      if (prior) {
        // The stamp is excluded: an idempotent re-append of the same request
        // keeps its first sequence instead of conflicting with itself.
        if (!sameCoverageReviewRequest(prior, record)) {
          throw new Error(`Coverage review request ${reviewId} conflicts with the recorded request.`);
        }
        break;
      }
      next = {
        ...next,
        coverageRequests: { ...next.coverageRequests, [reviewId]: record },
        coverageUnavailable: undefined,
      };
      break;
    }
    case "planning.coverage_obligations_recorded": {
      if (!next.plan) throw new Error("Coverage obligations require a drafted plan.");
      const reviewId = requiredString(event.payload, "reviewId");
      const request = next.coverageRequests[reviewId];
      if (!request) {
        throw new Error(`Coverage obligations cite unrequested review ${reviewId}; request the review first.`);
      }
      if (
        request.planRevisionId !== next.plan.currentRevisionId ||
        request.planRevisionDigest !== next.plan.currentDigest ||
        request.sourceManifestId !== next.source.currentManifestId
      ) {
        throw new Error("Coverage obligations cite a stale plan revision or source manifest; request the review again.");
      }
      // B2: a true stamp is only valid before any plan delivery for this
      // review. The deriving turn's context contained no plan; once the plan
      // is delivered, fresh derivation with a true stamp is refused (reuse
      // the blind set via the correction view instead).
      if (next.coveragePlanDelivered[reviewId]) {
        throw new Error(
          `Coverage obligations for ${reviewId} were recorded after the plan was delivered (true stamp refused; reuse the blind set).`,
        );
      }
      const manifest = next.source.manifestsById[next.source.currentManifestId];
      const sourceManifestId = requiredString(event.payload, "sourceManifestId");
      const sourceManifestDigest = requiredString(event.payload, "sourceManifestDigest");
      if (sourceManifestId !== manifest.manifestId || sourceManifestDigest !== manifest.artifactDigest) {
        throw new Error("Coverage obligations cite a stale source manifest; derive them from the current source.");
      }
      const obligations = parseRecordedObligations(event.payload.obligations);
      const sectionCoverage = parseSectionCoverage(
        event.payload.sectionCoverage,
        manifest,
        new Set(obligations.map((obligation) => obligation.id)),
      );
      const recordedAt = requiredString(event.payload, "recordedAt");
      const prior = next.coverageObligations[reviewId];
      const record: CoverageObligationsRecord = {
        reviewId,
        sourceManifestId,
        sourceManifestDigest,
        obligations,
        sectionCoverage,
        recordedAt,
      };
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(record)) {
          throw new Error(`Coverage obligations for ${reviewId} conflict with the recorded obligations.`);
        }
        break;
      }
      next = {
        ...next,
        coverageObligations: { ...next.coverageObligations, [reviewId]: record },
        coverageUnavailable: undefined,
      };
      break;
    }
    case "planning.coverage_plan_delivered": {
      if (!next.plan) throw new Error("Coverage plan delivery requires a drafted plan.");
      const reviewId = requiredString(event.payload, "reviewId");
      const request = next.coverageRequests[reviewId];
      if (!request) {
        throw new Error(`Coverage plan delivery cites unrequested review ${reviewId}.`);
      }
      const planRevisionId = requiredString(event.payload, "planRevisionId");
      const planRevisionDigest = requiredString(event.payload, "planRevisionDigest");
      const sourceManifestId = requiredString(event.payload, "sourceManifestId");
      const deliveredAt = requiredString(event.payload, "deliveredAt");
      const sessionId = event.payload.sessionId === undefined
        ? undefined
        : requiredString(event.payload, "sessionId");
      if (
        planRevisionId !== request.planRevisionId ||
        planRevisionDigest !== request.planRevisionDigest ||
        sourceManifestId !== request.sourceManifestId ||
        planRevisionId !== next.plan.currentRevisionId ||
        planRevisionDigest !== next.plan.currentDigest ||
        sourceManifestId !== next.source.currentManifestId
      ) {
        throw new Error("Coverage plan delivery cites a stale plan revision or source manifest.");
      }
      const prior = next.coveragePlanDelivered[reviewId];
      const record: CoveragePlanDeliveredRecord = {
        reviewId,
        planRevisionId,
        planRevisionDigest,
        sourceManifestId,
        ...(sessionId === undefined ? {} : { sessionId }),
        deliveredAt,
      };
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(record)) {
          throw new Error(`Coverage plan delivery for ${reviewId} conflicts with the recorded delivery.`);
        }
        break;
      }
      next = {
        ...next,
        coveragePlanDelivered: { ...next.coveragePlanDelivered, [reviewId]: record },
        coverageUnavailable: undefined,
      };
      break;
    }
    case "planning.coverage_correction_view_recorded": {
      if (!next.plan) throw new Error("Coverage correction view requires a drafted plan.");
      const reviewId = requiredString(event.payload, "reviewId");
      const request = next.coverageRequests[reviewId];
      if (!request) {
        throw new Error(`Coverage correction view cites unrequested review ${reviewId}.`);
      }
      if (
        request.planRevisionId !== next.plan.currentRevisionId ||
        request.planRevisionDigest !== next.plan.currentDigest ||
        request.sourceManifestId !== next.source.currentManifestId
      ) {
        throw new Error("Coverage correction view cites a stale plan revision or source; request the review again.");
      }
      const priorReviewId = requiredString(event.payload, "priorReviewId");
      if (request.priorReviewId !== priorReviewId) {
        throw new Error("Coverage correction view disagrees with the recorded request about the prior review.");
      }
      if (!recordedCoverageReview(next, priorReviewId)) {
        throw new Error(`Coverage re-review cites unknown prior review ${priorReviewId}.`);
      }
      const reusedFromReviewId = requiredString(event.payload, "reusedFromReviewId");
      const reused = next.coverageObligations[reusedFromReviewId];
      if (!reused) {
        throw new Error(`Coverage re-review reuses unknown blind obligations ${reusedFromReviewId}.`);
      }
      const manifest = next.source.manifestsById[next.source.currentManifestId];
      const sourceManifestId = requiredString(event.payload, "sourceManifestId");
      const sourceManifestDigest = requiredString(event.payload, "sourceManifestDigest");
      if (
        sourceManifestId !== manifest.manifestId ||
        sourceManifestDigest !== manifest.artifactDigest ||
        reused.sourceManifestId !== manifest.manifestId ||
        reused.sourceManifestDigest !== manifest.artifactDigest
      ) {
        throw new Error("Coverage re-review reuses blind obligations bound to a stale source manifest.");
      }
      const correctionView = requiredString(event.payload, "correctionView");
      const recordedAt = requiredString(event.payload, "recordedAt");
      const prior = next.coverageCorrectionViews[reviewId];
      const record: CoverageCorrectionViewRecord = {
        reviewId,
        priorReviewId,
        correctionView,
        reusedFromReviewId,
        sourceManifestId,
        sourceManifestDigest,
        recordedAt,
      };
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(record)) {
          throw new Error(`Coverage correction view for ${reviewId} conflicts with the recorded view.`);
        }
        break;
      }
      next = {
        ...next,
        coverageCorrectionViews: { ...next.coverageCorrectionViews, [reviewId]: record },
        coverageUnavailable: undefined,
      };
      break;
    }
    case "planning.coverage_prior_findings_released": {
      const reviewId = requiredString(event.payload, "reviewId");
      const priorReviewId = requiredString(event.payload, "priorReviewId");
      const view = next.coverageCorrectionViews[reviewId];
      if (!view || view.priorReviewId !== priorReviewId) {
        throw new Error(
          "Prior findings cannot be released before the re-review records its own view of the correction (OA-10 #2).",
        );
      }
      if (!recordedCoverageReview(next, priorReviewId)) {
        throw new Error(`Coverage re-review cites unknown prior review ${priorReviewId}.`);
      }
      const prior = next.coveragePriorFindingsReleased[reviewId];
      if (prior !== undefined && prior !== priorReviewId) {
        throw new Error(`Prior findings for ${reviewId} were already released for another review.`);
      }
      next = {
        ...next,
        coveragePriorFindingsReleased: { ...next.coveragePriorFindingsReleased, [reviewId]: priorReviewId },
      };
      break;
    }
    case "planning.coverage_review_recorded": {
      if (!next.plan) throw new Error("Coverage review requires a drafted plan.");
      const review = structuredClone(event.payload.review) as CoverageReview;
      assertValidation(validateCoverageReview(review), "Coverage review");
      const revision = next.plan.revisionsById[next.plan.currentRevisionId];
      assertValidation(validateCoverageReviewBinding(review, revision, next.source.manifestsById[next.source.currentManifestId]), "Coverage review binding");
      assertFindingIdsUnused(next, review);
      const request = next.coverageRequests[review.id];
      if (!request) {
        throw new Error(`Coverage review ${review.id} was never requested; request the review first.`);
      }
      if (
        request.planRevisionId !== next.plan.currentRevisionId ||
        request.planRevisionDigest !== next.plan.currentDigest ||
        request.sourceManifestId !== next.source.currentManifestId
      ) {
        throw new Error(
          `Coverage review ${review.id} was requested for a stale plan revision or source; request the review again.`,
        );
      }
      // Effective blind obligations: own record for an initial review, the
      // reused blind record named by the correction view for a re-review.
      // A re-review never re-derives with the plan in context (B2).
      let effective: CoverageObligationsRecord | undefined;
      if (review.priorReviewId === undefined) {
        effective = next.coverageObligations[review.id];
        if (!effective) {
          throw new Error(
            `Coverage verdict ${review.id} has no durably recorded obligations (record-before-verdict gate).`,
          );
        }
      } else {
        const view = next.coverageCorrectionViews[review.id];
        if (!view || view.priorReviewId !== review.priorReviewId) {
          throw new Error(
            `Coverage re-review ${review.id} has no durably recorded own view of the correction (OA-10 #2).`,
          );
        }
        effective = next.coverageObligations[view.reusedFromReviewId];
        if (!effective) {
          throw new Error(`Coverage re-review ${review.id} reuses unknown blind obligations ${view.reusedFromReviewId}.`);
        }
      }
      if (
        effective.sourceManifestId !== review.sourceReadManifestId ||
        effective.sourceManifestId !== next.source.currentManifestId
      ) {
        throw new Error(`Coverage verdict ${review.id} is bound to a stale source manifest.`);
      }
      assertObligationSetsMatch(effective.obligations, review);
      let priorChecks: Record<string, readonly CoveragePriorFindingCheck[]> = {};
      if (review.priorReviewId !== undefined) {
        if (next.coveragePriorFindingsReleased[review.id] !== review.priorReviewId) {
          throw new Error(
            `Coverage re-review ${review.id} verdict requires the prior findings to be released after its recorded own view (OA-10 #2).`,
          );
        }
        const prior = recordedCoverageReview(next, review.priorReviewId);
        if (!prior) throw new Error(`Coverage re-review cites unknown prior review ${review.priorReviewId}.`);
        const checks = parsePriorFindingChecks(
          event.payload.priorFindingChecks,
          prior,
          requiredPriorFindingIds(next, prior),
        );
        priorChecks = { [review.id]: checks };
      }
      next = {
        ...next,
        coverageReview: review,
        coverageReviewHistory: next.coverageReview
          ? [...next.coverageReviewHistory, next.coverageReview]
          : next.coverageReviewHistory,
        coveragePriorFindingChecks: { ...next.coveragePriorFindingChecks, ...priorChecks },
        coverageUnavailable: undefined,
        readiness: "not_ready",
        references: {
          ...next.references,
          [review.id]: { kind: "review", id: review.id },
        },
      };
      break;
    }
    case "planning.coverage_review_suspended": {
      const reviewId = requiredString(event.payload, "reviewId");
      if (!next.coverageRequests[reviewId]) {
        throw new Error(`Coverage suspension cites unrequested review ${reviewId}.`);
      }
      const reason = requiredString(event.payload, "reason");
      // R2-3: the idempotent payload carries no timestamp; fall back to the
      // event time (old events with updatedAt replay identically).
      const updatedAt = typeof event.payload.updatedAt === "string" && event.payload.updatedAt.trim().length > 0
        ? event.payload.updatedAt
        : event.occurredAt;
      const runtimeId = event.payload.runtimeId === undefined
        ? undefined
        : requiredString(event.payload, "runtimeId");
      const prior = next.coverageSuspended[reviewId];
      const attempts = (prior?.attempts ?? 0) + 1;
      next = {
        ...next,
        coverageSuspended: {
          ...next.coverageSuspended,
          [reviewId]: {
            reviewId,
            attempts,
            lastReason: reason,
            ...(runtimeId === undefined ? {} : { lastRuntimeId: runtimeId }),
            updatedAt,
          },
        },
        coverageUnavailable: undefined,
      };
      break;
    }
    case "planning.coverage_review_retry_authorized": {
      const reviewId = requiredString(event.payload, "reviewId");
      const gate = next.coverageUnavailable;
      if (
        !gate ||
        gate.reviewId !== reviewId ||
        !(TERMINAL_COVERAGE_GATE_REASONS as readonly string[]).includes(gate.reason)
      ) {
        throw new Error(
          `Coverage retry for ${reviewId} requires the owner's terminal suspended-exhaustion gate for that review.`,
        );
      }
      const suspended = { ...next.coverageSuspended };
      delete suspended[reviewId];
      next = {
        ...next,
        coverageUnavailable: undefined,
        coverageSuspended: suspended,
      };
      break;
    }
    case "planning.coverage_review_unavailable": {
      const reason = requiredString(event.payload, "reason");
      // R2-3: the idempotent payload carries no timestamp; fall back to the
      // event time (old events with recordedAt replay identically).
      const recordedAt = typeof event.payload.recordedAt === "string" && event.payload.recordedAt.trim().length > 0
        ? event.payload.recordedAt
        : event.occurredAt;
      const reviewId = typeof event.payload.reviewId === "string" && event.payload.reviewId.trim().length > 0
        ? event.payload.reviewId
        : undefined;
      const detail = typeof event.payload.detail === "string" && event.payload.detail.trim().length > 0
        ? event.payload.detail
        : undefined;
      next = {
        ...next,
        coverageUnavailable: {
          ...(reviewId === undefined ? {} : { reviewId }),
          ...(next.plan
            ? {
                planRevisionId: next.plan.currentRevisionId,
                sourceManifestId: next.source.currentManifestId,
              }
            : {}),
          reason,
          ...(detail === undefined ? {} : { detail }),
          recordedAt,
        },
        readiness: "not_ready",
      };
      break;
    }
    case "planning.plan_ready": {
      if (!next.plan || !next.coverageReview || !isRecord(event.payload.hostCapabilities)) {
        throw new Error("Plan readiness requires a plan, coverage review, and host capabilities.");
      }
      // N-R3-1: a recorded plan_ready_blocked gate is a cached signal, not
      // a refusal — readiness re-evaluates the actual blockers below, and
      // the gate clears durably when they are gone. Without this exemption
      // the gate refuses its own resolution for the same review, and the
      // runtime overwrites the original detail with the self-referential
      // refusal text. Every other outstanding gate still refuses.
      const gate = next.coverageUnavailable;
      const staleReadyGate = gate !== undefined &&
        gate.reason === "plan_ready_blocked" &&
        gate.planRevisionId === next.plan.currentRevisionId &&
        gate.sourceManifestId === next.source.currentManifestId &&
        (gate.reviewId === undefined || gate.reviewId === next.coverageReview.id);
      if (gate && !staleReadyGate) {
        throw new Error(
          `Plan readiness is blocked by an explicit outstanding coverage gate: ${gate.reason}.`,
        );
      }
      const unreadSections = unreadSectionIdsAtCurrentManifest(next);
      if (unreadSections.length > 0) {
        throw new Error(
          `Plan readiness requires a durable full read of every source section at the current manifest revision; unread: ${unreadSections.join(", ")}.`,
        );
      }
      // B3: cumulative open blocking findings from every prior review
      // (not one review back) must be explicitly resolved. The current
      // review's own blocking findings are covered by computePlanReadiness
      // below; priors are covered here. Repair cycle 2: the same shared
      // helper as the runtime mirror and status (retired findings excluded).
      {
        const currentReviewId = next.coverageReview.id;
        const outstandingBlocking = openBlockingCoverageFindings(next)
          .filter((entry) => entry.reviewId !== currentReviewId)
          .map((entry) => entry.findingId);
        if (outstandingBlocking.length > 0) {
          throw new Error(
            `Plan readiness requires every blocking prior finding to be resolved by the re-review; outstanding: ${outstandingBlocking.join(", ")}.`,
          );
        }
      }
      const hostCapabilities = structuredClone(event.payload.hostCapabilities) as unknown as HostPlanningCapabilities;
      assertValidation(validateHostPlanningCapabilities(hostCapabilities), "Host planning capabilities");
      const priorRevisionId = typeof event.payload.priorRevisionId === "string" ? event.payload.priorRevisionId : undefined;
      const priorRevision = priorRevisionId ? next.plan.revisionsById[priorRevisionId] : undefined;
      if (priorRevisionId && !priorRevision) throw new Error("Plan readiness references an unknown prior revision.");
      const readinessInput = coveragePlanReadinessInput(next, priorRevisionId);
      if (!readinessInput) throw new Error("Plan readiness requires a plan, coverage review, and host capabilities.");
      const readiness = computePlanReadiness({ ...readinessInput, hostCapabilities });
      if (!readiness.ready) throw new Error(`Plan is not ready: ${readiness.blockers.join(" ")}`);
      // N-R3-1: reaching here means no non-exempt gate is set, so the
      // exempted plan_ready_blocked gate (if any) clears durably now that
      // readiness re-evaluated the actual blockers and found none.
      next = { ...next, hostCapabilities, readiness: "ready", coverageUnavailable: undefined };
      break;
    }
    case "planning.execution_authorized": {
      if (next.readiness !== "ready" || !next.plan) {
        throw new Error("Plan start refused: no ready plan revision is recorded.");
      }
      const authorization = assertExecutionAuthorizationPayload(event.payload);
      if (
        authorization.planRevisionId !== next.plan.currentRevisionId ||
        authorization.planDigest !== next.plan.currentDigest
      ) {
        throw new Error(
          `Plan start refused: the authorization binds plan revision ${authorization.planRevisionId}, ` +
          `but the current ready revision is ${next.plan.currentRevisionId}.`,
        );
      }
      const manifest = next.source.manifestsById[next.source.currentManifestId];
      if (
        authorization.sourceManifestId !== manifest.manifestId ||
        authorization.sourceArtifactDigest !== manifest.artifactDigest
      ) {
        throw new Error(
          `Plan start refused: the authorization binds source manifest ${authorization.sourceManifestId}, ` +
          `but the current source manifest is ${manifest.manifestId}.`,
        );
      }
      next = {
        ...next,
        executionAuthorization: { ...authorization, authorizedAt: event.occurredAt },
      };
      break;
    }
    case "planning.assignment_claimed": {
      if (next.readiness !== "ready") throw new Error("Planning assignment requires a ready plan.");
      const claim = structuredClone(event.payload.claim) as AssignmentClaim;
      assertValidation(validateAssignmentClaim(claim), "Assignment claim");
      if (claim.state !== "claimed") throw new Error("assignment_claimed must record a claimed state.");
      const revision = next.plan!.revisionsById[next.plan!.currentRevisionId];
      const kernelRepair = assignmentIsKernelRepair(claim.packetId);
      const contractId = assignmentContractId(claim.packetId);
      const contract = revision.tasks.find((candidate) => candidate.id === contractId);
      if (!kernelRepair && !contract) {
        throw new Error(`Assignment packet ${claim.packetId} is not in the current plan revision.`);
      }
      const priorClaims = Object.values(next.assignments)
        .filter((state) => state.claim.packetId === claim.packetId)
        .sort((left, right) => left.claim.ownershipGeneration - right.claim.ownershipGeneration);
      const prior = priorClaims.at(-1);
      if (prior) assertClaimSuccessor(prior.claim, claim);
      const candidateClaim = taskWriteClaimFromAssignment(claim, claim.packetId);
      const activeClaims = Object.values(next.assignments)
        .filter((state) => state.status === "claimed")
        .map((state) => taskWriteClaimFromAssignment(state.claim, state.claim.packetId));
      const conflict = findClaimConflict(candidateClaim, activeClaims);
      if (conflict) {
        throw new Error(`Planning assignment claim conflict: ${conflict.detail}`);
      }
      next = {
        ...next,
        assignments: {
          ...next.assignments,
          [claim.id]: { claim, status: "claimed", recoveryStatus: "unchecked" },
        },
        references: {
          ...next.references,
          [claim.branchOrWorktree]: { kind: "worktree", id: claim.branchOrWorktree },
          [claim.acceptedBaseRevision]: { kind: "commit", id: claim.acceptedBaseRevision },
        },
      };
      break;
    }
    case "planning.assignment_released": {
      const claim = structuredClone(event.payload.claim) as AssignmentClaim;
      assertValidation(validateAssignmentClaim(claim), "Assignment release");
      const prior = next.assignments[claim.id];
      if (!prior || prior.status !== "claimed") throw new Error("Only a claimed assignment can be released.");
      if (
        claim.packetId !== prior.claim.packetId ||
        claim.laneId !== prior.claim.laneId ||
        claim.workerOrSessionId !== prior.claim.workerOrSessionId ||
        claim.acceptedBaseRevision !== prior.claim.acceptedBaseRevision ||
        claim.branchOrWorktree !== prior.claim.branchOrWorktree ||
        claim.ownershipGeneration !== prior.claim.ownershipGeneration
      ) {
        throw new Error("Assignment release cannot rewrite owned claim identity.");
      }
      if (claim.state === "claimed") throw new Error("assignment_released must record released or stopped_fenced.");
      if (claim.state === "stopped_fenced" && claim.writerStopEvidence?.trim().length === 0) throw new Error("Lost owned workspace requires writerStopEvidence.");
      next = {
        ...next,
        assignments: {
          ...next.assignments,
          [claim.id]: { claim, status: claim.state, recoveryStatus: prior.recoveryStatus },
        },
      };
      break;
    }
    case "planning.recovery_reconciled": {
      const assignmentId = requiredString(event.payload, "assignmentId");
      if (!next.assignments[assignmentId]) throw new Error("Recovery references an unknown assignment.");
      const recovery = structuredClone(event.payload.recovery) as PlanningRecoveryInput;
      const result = reconcilePlanningProjection(next, recovery);
      next = {
        ...next,
        assignments: {
          ...next.assignments,
          [assignmentId]: {
            ...next.assignments[assignmentId],
            recoveryStatus: result.status,
          },
        },
      };
      break;
    }
    case "planning.validation_intent_recorded": {
      assertPlanBinding(next, event.payload);
      const taskId = requiredString(event.payload, "taskId");
      const intent = structuredClone(event.payload.intent) as ValidationIntent;
      assertValidation(validateValidationIntent(intent), "Validation intent");
      const key = `${taskId}:${intent.id}`;
      if (next.validations[key]) throw new Error("Validation intent already exists.");
      const assignment = Object.values(next.assignments).find((state) => state.status === "claimed" && state.claim.packetId === taskId);
      if (!assignment) throw new Error("Validation intent requires a claimed assignment.");
      next = {
        ...next,
        validations: {
          ...next.validations,
          [key]: {
            taskId,
            intent,
            planRevisionId: next.plan!.currentRevisionId,
            planRevisionDigest: next.plan!.currentDigest,
            status: "planned",
            observations: [],
          },
        },
      };
      break;
    }
    case "planning.validation_observed":
    case "planning.validation_reconciled": {
      assertPlanBinding(next, event.payload);
      const taskId = requiredString(event.payload, "taskId");
      if (event.actor.role === "worker") {
        const assignment = Object.values(next.assignments).find((state) =>
          state.status === "claimed" && state.claim.packetId === taskId
        );
        if (!assignment || assignment.claim.workerOrSessionId !== event.actor.id) {
          throw new Error("Only the claim owner or runner may record a validation observation.");
        }
      }
      const key = `${taskId}:${requiredString(event.payload, "intentId")}`;
      const prior = next.validations[key];
      if (!prior) throw new Error("Validation observation references an unknown intent.");
      const observation = structuredClone(event.payload.observation) as ValidationObservation;
      assertValidation(validateValidationObservation(observation), "Validation observation");
      if (next.observationOrderByObservationId[observation.id] !== undefined) {
        throw new Error(`Observation ${observation.id} is already recorded.`);
      }
      if (observation.intentId !== prior.intent.id) throw new Error("Validation observation is bound to another intent.");
      if (event.type === "planning.validation_observed" && prior.status !== "planned") {
        throw new Error("Only a planned validation can record its first observation.");
      }
      if (event.type === "planning.validation_reconciled") {
        if (prior.status !== "interrupted") throw new Error("Only an interrupted validation can be reconciled.");
        if (requiredString(event.payload, "interruptedCommandId") !== prior.interruptedCommandId) {
          throw new Error("Validation reconciliation does not match the interrupted command.");
        }
      }
      const evidenceIdentity = requiredRecord(event.payload, "evidenceIdentity");
      if (requiredString(evidenceIdentity, "evidenceId") !== observation.evidenceId) {
        throw new Error("Validation evidence identity does not match its observation.");
      }
      const evidenceDigest = requiredString(evidenceIdentity, "digest");
      if (!/^[a-f0-9]{64}$/.test(evidenceDigest)) {
        throw new Error("Validation evidence digest must be a sha256 hex digest.");
      }
      const priorEvidence = next.references[observation.evidenceId];
      if (
        priorEvidence &&
        (priorEvidence.kind !== "evidence" || priorEvidence.digest !== evidenceDigest)
      ) {
        throw new Error(`Evidence ${observation.evidenceId} already exists with a different identity.`);
      }
      const observationOrder = next.observationSequence + 1;
      next = {
        ...next,
        observationSequence: observationOrder,
        observationOrderByObservationId: {
          ...next.observationOrderByObservationId,
          [observation.id]: observationOrder,
        },
        validations: {
          ...next.validations,
          [key]: {
            ...prior,
            status: observation.outcome,
            observations: [...prior.observations, observation],
          },
        },
        references: priorEvidence
          ? next.references
          : {
              ...next.references,
              [observation.evidenceId]: {
                kind: "evidence",
                id: observation.evidenceId,
                digest: evidenceDigest,
              },
            },
      };
      break;
    }
    case "planning.validation_interrupted": {
      assertPlanBinding(next, event.payload);
      const taskId = requiredString(event.payload, "taskId");
      const key = `${taskId}:${requiredString(event.payload, "intentId")}`;
      const prior = next.validations[key];
      if (!prior || prior.status !== "planned") throw new Error("Only a planned validation can be interrupted.");
      next = {
        ...next,
        validations: {
          ...next.validations,
          [key]: {
            ...prior,
            status: "interrupted",
            interruptedCommandId: requiredString(event.payload, "interruptedCommandId"),
          },
        },
      };
      break;
    }
    case "planning.reference_recorded":
      if (!next.plan) throw new Error("Planning references require a drafted plan.");
      break;
    case "planning.acceptance_recorded":
    case "planning.acceptance_reopened": {
      assertPlanBinding(next, event.payload);
      if (next.readiness !== "ready") throw new Error("Planning acceptance requires a ready plan.");
      const kind = event.payload.kind;
      if (kind !== "task" && kind !== "phase") throw new Error("Planning acceptance kind must be task or phase.");
      const recordId = kind === "task"
        ? requiredString(event.payload, "taskId")
        : requiredString(event.payload, "phaseId");
      const key = `${kind}:${recordId}`;
      const existing = next.acceptances[key];
      if (event.type === "planning.acceptance_recorded") {
        if (existing?.status === "accepted") throw new Error("Planning acceptance is already recorded.");
        const revision = next.plan!.revisionsById[next.plan!.currentRevisionId];
        const taskStatuses = context.taskStatuses ?? new Map(revision.tasks.map((task) => [task.id, "planned"]));
        assertValidation(validateRequirementTaskCoverage(revision.requirements, revision.tasks, taskStatuses), "Planning task coverage");
        if (kind === "task") {
          const taskValidations = Object.values(next.validations).filter((state) => state.taskId === recordId);
          if (taskValidations.some((state) => state.status === "planned" || state.status === "interrupted" || state.status === "unknown")) {
            throw new Error("Interrupted or unknown validation prevents planning advancement.");
          }
          const assignment = Object.values(next.assignments).find((state) => state.status === "claimed" && state.claim.packetId === recordId);
          if (!assignment || assignment.recoveryStatus !== "verified") {
            throw new Error("Planning acceptance requires verified exclusive workspace ownership.");
          }
          const acceptance = structuredClone(event.payload.acceptance) as TaskAcceptance;
          assertValidation(validateTaskAcceptance(acceptance), "Task acceptance");
          if (acceptance.status !== "accepted" || acceptance.taskId !== recordId) throw new Error("Task acceptance record is invalid.");
          assertTaskAcceptanceBindings(next, revision, acceptance, current.references, existing);
          next = {
            ...next,
            acceptances: {
              ...next.acceptances,
              [key]: acceptedWithHistory(
                acceptance,
                kind,
                recordId,
                undefined,
                next.plan!.currentRevisionId,
                next.plan!.currentDigest,
                existing,
              ),
            },
          };
        } else {
          const acceptance = structuredClone(event.payload.acceptance) as PhaseAcceptance;
          const taskAcceptances = new Map<string, TaskAcceptance>(
            Object.values(next.acceptances)
              .filter((state) =>
                state.kind === "task" &&
                state.status === "accepted" &&
                state.planRevisionId === revision.revisionId &&
                state.planRevisionDigest === revision.digest
              )
              .map((state) => [state.taskId!, state.record as TaskAcceptance]),
          );
          assertValidation(validatePhaseAcceptance(
            acceptance,
            revision.requirements,
            taskAcceptances,
            next.source.manifestsById[next.source.currentManifestId],
            amendmentHistory(next),
          ), "Phase acceptance");
          if (acceptance.status !== "accepted" || acceptance.phaseId !== recordId) throw new Error("Phase acceptance record is invalid.");
          next = {
            ...next,
            acceptances: {
            ...next.acceptances,
              [key]: acceptedWithHistory(
                acceptance,
                kind,
                undefined,
                recordId,
                next.plan!.currentRevisionId,
                next.plan!.currentDigest,
                existing,
              ),
            },
          };
        }
      } else {
        if (!existing || existing.status !== "accepted") throw new Error("Only accepted planning work can be reopened.");
        next = {
          ...next,
          acceptances: {
            ...next.acceptances,
            [key]: reopenAcceptance(existing, next.plan!.currentRevisionId, next.observationSequence),
          },
        };
      }
      break;
    }
  }
  return withResume(next);
}
