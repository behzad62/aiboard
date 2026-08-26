import {
  isFinalVerificationTask,
  type BuildTask,
  type PlanReconciliation,
  type PlanTaskUpdate,
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
  validateCriterionEvidenceLinks,
  validateCriterionReviewVerdicts,
  validateAcceptanceCriteria,
  type AcceptanceCriterion,
  type CriterionEvidenceLink,
  type CriterionReviewVerdict,
} from "./acceptance-contracts.js";
import type { EvidenceStore } from "./evidence-store.js";
import type {
  FinalVerificationCheckResult,
  FinalVerificationFact,
} from "./final-verification-runtime.js";
import type { FinalVerificationSubmission } from "./final-verification-submission.js";

export type SchedulerActorRole =
  | "architect"
  | "worker"
  | "runner"
  | "user";

export interface SchedulerActor {
  role: SchedulerActorRole;
  id: string;
}

export type SchedulerEventType =
  | "run.initialized"
  | "run.policy_configured"
  | "plan.created"
  | "plan.reconciled"
  | "task.revised"
  | "task.transitioned"
  | "guidance.requested"
  | "guidance.answered"
  | "guidance.challenged"
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
  | "final_verification.submitted"
  | "final_verification.review_requested"
  | "final_verification.review_decided"
  | "final_verification.repairs_planned";

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
  categoryReviews: FinalVerificationCategoryReviewProjection[];
  failedCategories: FinalVerificationCategory[];
}

export interface FinalVerificationGenerationProjection {
  taskId: string;
  generationId: string;
  targetRevision: string;
  planVersion: number;
  plan: FinalVerificationPlan;
  state: "current" | "invalidated";
  invalidatedByRevision?: string;
  completedChecks?: FinalVerificationCompletedCheckProjection[];
  submission?: FinalVerificationSubmissionReference;
  submissionResult?: FinalVerificationSubmission;
  review?: FinalVerificationReviewReference;
  repairTaskIds?: string[];
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

export interface SchedulerProjection {
  runId: string;
  runPolicy?: NativeBuildRunPolicy;
  status: "running" | "paused" | "completed";
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
  reviews: Record<string, ReviewProjection>;
  /** Completed submissions retained as immutable attempt/version history. */
  submissionHistory?: Record<string, CriterionSubmissionProjection[]>;
  /** Completed Architect decisions retained as immutable attempt/version history. */
  reviewHistory?: Record<string, ReviewProjection[]>;
  runtime: RuntimeProjection;
  integrationRevision?: string;
  finalVerification?: FinalVerificationProjection;
  projectHandoff?: ProjectHandoffProjection;
  lastSequence: number;
}

export interface SchedulerStore {
  append(input: NewSchedulerEvent): SchedulerEvent;
  readRun(runId: string, afterSequence?: number): SchedulerEvent[];
  close(): void;
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
  const next: SchedulerProjection = {
    ...current,
    tasks: { ...current.tasks },
    guidance: { ...current.guidance },
    reviews: { ...current.reviews },
    submissionHistory: cloneSubmissionHistory(current.submissionHistory),
    reviewHistory: cloneReviewHistory(current.reviewHistory),
    ...(current.finalVerification
      ? { finalVerification: cloneFinalVerificationProjection(current.finalVerification) }
      : {}),
    ...(current.projectHandoff
      ? {
          projectHandoff: {
            ...current.projectHandoff,
            options: [...current.projectHandoff.options],
          },
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
    case "final_verification.submitted": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may submit final verification.");
      }
      recordFinalVerificationSubmission(next, event.payload);
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
        (Object.hasOwn(patch, "verificationRepair") || Object.hasOwn(patch, "kind"))
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
      next.guidance[requestId] = {
        requestId,
        taskId,
        blocking,
        question: requiredString(event.payload, "question"),
        evidenceSequence: requiredNumber(event.payload, "evidenceSequence"),
        version: 1,
        status: "open",
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
      next.status = "running";
      delete next.pauseReason;
      break;
    case "run.completed":
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
      next.runtime.workerAssignments[`${taskId}:${attempt}`] = {
        taskId,
        attempt,
        runtimeId: requiredString(event.payload, "runtimeId"),
        sessionId: requiredString(event.payload, "sessionId"),
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
  projection.integrationRevision = integrationRevision;
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

function recordFinalVerificationReviewDecision(
  projection: SchedulerProjection,
  payload: Record<string, unknown>,
): void {
  const current = requireCurrentFinalVerification(projection, payload);
  const decision = requiredString(payload, "decision");
  if (decision !== "approved" && decision !== "repair_required" && decision !== "rejected") {
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

function createFinalVerificationRepairTasks(
  projection: SchedulerProjection,
  payload: Record<string, unknown>,
): void {
  const current = requireCurrentFinalVerification(projection, {
    ...payload,
    taskId: payload.finalVerificationTaskId,
  });
  if (
    current.review?.status !== "repair_required" ||
    !current.review.decision ||
    !current.submission ||
    current.review.reviewId !== requiredString(payload, "reviewId") ||
    current.submission.submissionId !== requiredString(payload, "submissionId")
  ) {
    throw new Error("Final verification repairs require the current repair-required review.");
  }
  const review = current.review;
  const submission = current.submission;
  const revision = requiredNumber(payload, "revision");
  if (revision !== projection.planRevision + 1) {
    throw new Error("Final verification repair plan revision is stale.");
  }
  if (!Array.isArray(payload.tasks) || payload.tasks.length === 0) {
    throw new Error("Final verification repairs require at least one task.");
  }
  const failed = new Set(review.decision!.failedCategories);
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
    const expectedEvidence = [...new Set(categories.flatMap((category) =>
      review.decision!.categoryReviews.find(
        (review) => review.category === category,
      )?.evidenceIds ?? []
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
        submissionId: submission.submissionId,
        reviewId: review.reviewId,
        targetRevision: current.targetRevision,
        categories: [...categories],
        evidenceIds: [...evidenceIds],
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
} {
  const planVersion = requiredNumber(payload, "planVersion");
  if (planVersion < 1) throw new Error("Final verification planVersion must be positive.");
  return {
    taskId: requiredString(payload, "taskId"),
    generationId: requiredString(payload, "generationId"),
    targetRevision: requiredString(payload, "targetRevision"),
    planVersion,
    plan: planFinalVerification(payload.plan),
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
  },
): boolean {
  return left.taskId === right.taskId &&
    left.generationId === right.generationId &&
    left.targetRevision === right.targetRevision &&
    left.planVersion === right.planVersion &&
    sameValue(left.plan, right.plan);
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
    ...(generation.completedChecks
      ? { completedChecks: generation.completedChecks.map(cloneFinalVerificationCompletedCheck) }
      : {}),
    ...(generation.submission
      ? { submission: { ...generation.submission } }
      : {}),
    ...(generation.submissionResult
      ? { submissionResult: cloneJson(generation.submissionResult) }
      : {}),
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

function parsePlanReconciliation(value: unknown): PlanReconciliation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Missing plan reconciliation.");
  }
  const payload = value as Record<string, unknown>;
  const updates = payload.taskUpdates;
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error("Plan reconciliation requires taskUpdates.");
  }
  return {
    revision: requiredNumber(payload, "revision"),
    summary: requiredString(payload, "summary"),
    taskUpdates: updates.map(parsePlanTaskUpdate),
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
  reconciliation: PlanReconciliation
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
  for (const update of reconciliation.taskUpdates) {
    const task = candidateTasks[update.taskId];
    if (!task) throw new Error(`Unknown task ${update.taskId}.`);
    if (isFinalVerificationTask(task)) {
      throw new Error("Kernel-owned final verification task cannot be reconciled.");
    }
    if (
      task.status !== "planned" &&
      task.status !== "failed" &&
      task.status !== "rejected"
    ) {
      throw new Error(
        `Task ${update.taskId} must be planned, failed, or rejected before reconciliation.`
      );
    }
    if (update.action === "cancel") {
      candidateTasks[update.taskId] = applyTaskTransition(task, "cancelled", {
        assignedWorkerId: undefined,
        changeSetId: undefined,
        failureReason: undefined,
      });
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
    const grantsFreshAttempt =
      task.status === "failed" ||
      task.status === "rejected" ||
      (task.status === "planned" && task.attempt > 0);
    candidateTasks[update.taskId] = grantsFreshAttempt
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

function emptySchedulerProjection(event: SchedulerEvent): SchedulerProjection {
  return {
    runId: event.runId,
    status: "running",
    acceptanceContractStatus: "current",
    acceptanceUpgradeRequiredEventRecorded: false,
    planRevision: 0,
    tasks: {},
    guidance: {},
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
    ...(task.conflictPaths ? { conflictPaths: [...task.conflictPaths] } : {}),
  };
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) throw new Error(`Missing ${key}.`);
  return value;
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
