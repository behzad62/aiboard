import {
  assertClaimReassignable,
  computeDigest,
  computePlanReadiness,
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
  validateApprovedSourceManifest,
  verifyAmendmentReferencesPredecessor,
  type ApprovedSourceManifest,
  type SourceManifestAmendment,
  type SourceManifestAmendmentRecordedImpact,
} from "./source-manifest.js";

export const PLANNING_EVENT_TYPES = [
  "planning.source_registered",
  "planning.source_amended",
  "planning.ledger_persisted",
  "planning.checkpoint_recorded",
  "planning.plan_drafted",
  "planning.plan_revised",
  "planning.coverage_review_recorded",
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
}

export const PLANNING_EVENT_ACTOR_ROLES: Readonly<Record<PlanningEventType, readonly PlanningActorRole[]>> = {
  "planning.source_registered": ["user"],
  "planning.source_amended": ["user"],
  "planning.ledger_persisted": ["architect"],
  "planning.checkpoint_recorded": ["architect"],
  "planning.plan_drafted": ["architect"],
  "planning.plan_revised": ["architect"],
  "planning.coverage_review_recorded": ["verifier"],
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
};

export const PLANNING_EVENT_TRANSITIONS: Readonly<Record<PlanningEventType, string>> = {
  "planning.source_registered": "none -> source_registered",
  "planning.source_amended": "source_registered -> source_amended",
  "planning.ledger_persisted": "source_registered|source_amended -> ledger_persisted",
  "planning.checkpoint_recorded": "ledger_persisted -> checkpoint_recorded+",
  "planning.plan_drafted": "ledger_persisted -> plan_drafted",
  "planning.plan_revised": "plan_drafted -> plan_revised+",
  "planning.coverage_review_recorded": "plan_drafted -> coverage_review_recorded+",
  "planning.plan_ready": "plan_drafted + bound passing coverage_review -> plan_ready",
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
};

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

export interface PlanningResumeIndex {
  readonly coveredSourceSectionIds: readonly string[];
  readonly remainingSourceSectionIds: readonly string[];
  readonly nextSourceSectionId?: string;
  readonly completedPlanningContractIds: readonly string[];
  readonly outstandingWork: readonly string[];
  readonly nextAction: string;
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
  readonly assignments: Readonly<Record<string, PlanningAssignmentState>>;
  readonly validations: Readonly<Record<string, PlanningValidationState>>;
  readonly observationSequence: number;
  readonly observationOrderByObservationId: Readonly<Record<string, number>>;
  readonly acceptances: Readonly<Record<string, PlanningAcceptanceState>>;
  readonly readiness: "not_ready" | "ready";
  readonly coverageReview?: CoverageReview;
  readonly hostCapabilities?: HostPlanningCapabilities;
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

function resumeIndex(projection: PlanningProjection): PlanningResumeIndex {
  const manifest = projection.source.manifestsById[projection.source.currentManifestId];
  const latest = projection.checkpoints.at(-1);
  const currentSectionDigests = new Map(manifest.sections.map((section) => [section.id, section.digest]));
  const covered = new Set<string>();
  for (const record of projection.checkpoints) {
    for (const sectionId of record.checkpoint.coveredSourceSectionIds) {
      if (record.sectionDigests[sectionId] === currentSectionDigests.get(sectionId)) covered.add(sectionId);
    }
  }
  const remaining = manifest.sections.map((section) => section.id).filter((id) => !covered.has(id));
  const coveredIds = [...covered];
  const outstandingWork = latest?.checkpoint.remainingWork.length
    ? [...latest.checkpoint.remainingWork]
    : remaining.map((sectionId) => `Cover source section ${sectionId}.`);
  return {
    coveredSourceSectionIds: coveredIds,
    remainingSourceSectionIds: remaining,
    ...(remaining[0] === undefined ? {} : { nextSourceSectionId: remaining[0] }),
    completedPlanningContractIds: [...(latest?.checkpoint.completedPlanningContractIds ?? [])],
    outstandingWork,
    nextAction: latest?.checkpoint.nextAction ??
      (!projection.ledger
        ? "Persist the requirement ledger."
        : remaining[0] === undefined
          ? "Draft the execution plan."
          : `Cover source section ${remaining[0]}.`),
  };
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

function assertMonotonicCheckpoint(previous: PlanningCheckpoint | undefined, next: PlanningCheckpoint): void {
  if (!previous) return;
  if (previous.coveredSourceSectionIds.some((id) => !next.coveredSourceSectionIds.includes(id))) {
    throw new Error("Planning checkpoints cannot drop covered source sections.");
  }
  if (previous.completedPlanningContractIds.some((id) => !next.completedPlanningContractIds.includes(id))) {
    throw new Error("Planning checkpoints cannot drop completed planning contracts.");
  }
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
    assignments: {},
    validations: {},
    observationSequence: 0,
    observationOrderByObservationId: {},
    acceptances: {},
    readiness: "not_ready",
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
  return projection;
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
      next = {
        ...next,
        source: {
          ...next.source,
          currentManifestId: manifest.manifestId,
          artifactDigest: manifest.artifactDigest,
          manifestHistoryIds: [...next.source.manifestHistoryIds, manifest.manifestId],
          manifestsById: { ...next.source.manifestsById, [manifest.manifestId]: cloneManifest(manifest) },
        },
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
    case "planning.checkpoint_recorded": {
      if (!next.ledger) throw new Error("Planning checkpoint requires a persisted ledger.");
      if (next.readiness === "ready") {
        throw new Error("Planning checkpoints cannot be recorded after plan_ready without a new readiness transition.");
      }
      const checkpoint = structuredClone(event.payload.checkpoint) as PlanningCheckpoint;
      assertValidation(validatePlanningCheckpoint(checkpoint), "Planning checkpoint");
      assertMonotonicCheckpoint(next.checkpoints.at(-1)?.checkpoint, checkpoint);
      const sectionIds = new Set(next.source.manifestsById[next.source.currentManifestId].sections.map((section) => section.id));
      if (checkpoint.coveredSourceSectionIds.some((id) => !sectionIds.has(id))) throw new Error("Planning checkpoint references an unknown source section.");
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
      };
      break;
    }
    case "planning.coverage_review_recorded": {
      if (!next.plan) throw new Error("Coverage review requires a drafted plan.");
      const review = structuredClone(event.payload.review) as CoverageReview;
      assertValidation(validateCoverageReview(review), "Coverage review");
      const revision = next.plan.revisionsById[next.plan.currentRevisionId];
      assertValidation(validateCoverageReviewBinding(review, revision, next.source.manifestsById[next.source.currentManifestId]), "Coverage review binding");
      next = {
        ...next,
        coverageReview: review,
        readiness: "not_ready",
        references: {
          ...next.references,
          [review.id]: { kind: "review", id: review.id },
        },
      };
      break;
    }
    case "planning.plan_ready": {
      if (!next.plan || !next.coverageReview || !isRecord(event.payload.hostCapabilities)) {
        throw new Error("Plan readiness requires a plan, coverage review, and host capabilities.");
      }
      const hostCapabilities = structuredClone(event.payload.hostCapabilities) as unknown as HostPlanningCapabilities;
      assertValidation(validateHostPlanningCapabilities(hostCapabilities), "Host planning capabilities");
      const revision = next.plan.revisionsById[next.plan.currentRevisionId];
      const priorRevisionId = typeof event.payload.priorRevisionId === "string" ? event.payload.priorRevisionId : undefined;
      const priorRevision = priorRevisionId ? next.plan.revisionsById[priorRevisionId] : undefined;
      if (priorRevisionId && !priorRevision) throw new Error("Plan readiness references an unknown prior revision.");
      const readiness = computePlanReadiness({
        manifest: next.source.manifestsById[next.source.currentManifestId],
        revision,
        coverageReview: next.coverageReview,
        hostCapabilities,
        ...(priorRevision ? { priorRevision } : {}),
        amendmentHistory: amendmentHistory(next),
      });
      if (!readiness.ready) throw new Error(`Plan is not ready: ${readiness.blockers.join(" ")}`);
      next = { ...next, hostCapabilities, readiness: "ready" };
      break;
    }
    case "planning.assignment_claimed": {
      if (next.readiness !== "ready") throw new Error("Planning assignment requires a ready plan.");
      const claim = structuredClone(event.payload.claim) as AssignmentClaim;
      assertValidation(validateAssignmentClaim(claim), "Assignment claim");
      if (claim.state !== "claimed") throw new Error("assignment_claimed must record a claimed state.");
      const revision = next.plan!.revisionsById[next.plan!.currentRevisionId];
      if (!revision.tasks.some((task) => task.id === claim.packetId)) {
        throw new Error(`Assignment packet ${claim.packetId} is not in the current plan revision.`);
      }
      const priorClaims = Object.values(next.assignments).filter((state) => state.claim.packetId === claim.packetId);
      const prior = priorClaims.at(-1);
      if (prior && prior.status !== "stopped_fenced") throw new Error("Planning packet still has an owned assignment.");
      if (prior) assertClaimReassignable(prior.claim, claim);
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
