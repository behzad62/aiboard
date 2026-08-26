import type {
  BuildTask,
  PlanReconciliation,
  PlanTaskUpdate,
} from "./task-contracts.js";
import { applyTaskTransition, validateTaskGraph } from "./task-graph.js";
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
  | "acceptance_contract.upgraded";

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
  projectHandoff?: ProjectHandoffProjection;
  lastSequence: number;
}

export interface SchedulerStore {
  append(input: NewSchedulerEvent): SchedulerEvent;
  readRun(runId: string, afterSequence?: number): SchedulerEvent[];
  close(): void;
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
    case "task.revised": {
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may revise a task.");
      }
      const taskId = requiredString(event.payload, "taskId");
      const task = next.tasks[taskId];
      if (!task) throw new Error(`Unknown task ${taskId}.`);
      if (
        task.status !== "planned" &&
        task.status !== "failed" &&
        task.status !== "rejected"
      ) {
        throw new Error(`Task ${taskId} must be planned, failed, or rejected before revision.`);
      }
      const patch = (event.payload.patch as Partial<BuildTask> | undefined) ?? {};
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
        if (integrationRevision) next.integrationRevision = integrationRevision;
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
        const nonterminal = Object.values(next.tasks).find(
          (task) => task.status !== "integrated" && task.status !== "cancelled"
        );
        if (nonterminal) {
          throw new Error(
            `Final project handoff requires terminal task states; ${nonterminal.id} is ${nonterminal.status}.`
          );
        }
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
      const choice = requiredString(event.payload, "choice");
      if (choice !== "keep_integration_branch" && choice !== "apply_to_project") {
        throw new Error(`Final project handoff choice ${choice} is invalid.`);
      }
      if (event.actor.role === "runner" && choice !== "apply_to_project") {
        throw new Error("Automatic project handoff must apply to the project.");
      }
      const projectRevision = event.payload.projectRevision;
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
        integrationRevision: requiredString(event.payload, "integrationRevision"),
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
    (task) => task.status !== "cancelled"
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
    if (task.status === "cancelled") candidateTasks[task.id] = cloneBuildTask(task);
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
    .filter((task) => task.status !== "cancelled" && task.acceptanceCriteria === undefined)
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
