import type {
  BuildTask,
  PlanReconciliation,
  PlanTaskUpdate,
} from "./task-contracts.js";
import { applyTaskTransition, validateTaskGraph } from "./task-graph.js";
import type { NativeBuildRunPolicy } from "./build-spec.js";

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
  | "provider.health_changed"
  | "worker.runtime_assigned"
  | "architect.runtime_assigned"
  | "architect.handoff_required"
  | "architect.handoff_selected";

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

export interface ReviewProjection {
  taskId: string;
  status: "requested" | "approved" | "rejected";
  summary?: string;
  evidenceArtifactHashes: string[];
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
}

export interface SchedulerProjection {
  runId: string;
  runPolicy?: NativeBuildRunPolicy;
  status: "running" | "paused" | "completed";
  planRevision: number;
  tasks: Record<string, BuildTask>;
  guidance: Record<string, GuidanceProjection>;
  reviews: Record<string, ReviewProjection>;
  runtime: RuntimeProjection;
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
      next.tasks = Object.fromEntries(tasks.map((task) => [task.id, { ...task }]));
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
      const revised: BuildTask = grantsFreshAttempt
        ? {
            ...task,
            ...patch,
            id: task.id,
            status: "planned",
            attemptLimit: Math.max(task.attemptLimit ?? 0, task.attempt + 1),
            assignedWorkerId: undefined,
            changeSetId: undefined,
            failureReason: undefined,
          }
        : { ...task, ...patch, id: task.id, status: task.status };
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
      next.tasks[taskId] = applyTaskTransition(
        task,
        status,
        (event.payload.patch as Partial<BuildTask> | undefined) ?? {}
      );
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
      const taskId = requiredString(event.payload, "taskId");
      const task = next.tasks[taskId];
      if (!task) throw new Error(`Unknown task ${taskId}.`);
      next.tasks[taskId] = applyTaskTransition(task, "architect_review");
      next.reviews[taskId] = {
        taskId,
        status: "requested",
        evidenceArtifactHashes: stringArray(event.payload, "evidenceArtifactHashes"),
      };
      break;
    }
    case "review.decided": {
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
      next.tasks[taskId] = applyTaskTransition(task, decision);
      next.reviews[taskId] = {
        taskId,
        status: decision,
        summary: requiredString(event.payload, "summary"),
        evidenceArtifactHashes: stringArray(event.payload, "evidenceArtifactHashes"),
      };
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
      break;
    case "run.resumed":
      next.status = "running";
      break;
    case "run.completed":
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may complete a scheduler run.");
      }
      next.status = "completed";
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
      break;
    }
    case "project.handoff_selected": {
      if (event.actor.role !== "user") {
        throw new Error("Final project handoff selection requires the user.");
      }
      if (current.projectHandoff?.status !== "requested") {
        throw new Error("Final project handoff is not awaiting user selection.");
      }
      const choice = requiredString(event.payload, "choice");
      if (choice !== "keep_integration_branch" && choice !== "apply_to_project") {
        throw new Error(`Final project handoff choice ${choice} is invalid.`);
      }
      next.projectHandoff = {
        ...current.projectHandoff,
        status: "selected",
        choice,
        integrationRevision: requiredString(event.payload, "integrationRevision"),
        integrationBranch: requiredString(event.payload, "integrationBranch"),
        appliedToProject: event.payload.appliedToProject === true,
      };
      next.status = "completed";
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
  };
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
    Object.entries(projection.tasks).map(([taskId, task]) => [taskId, { ...task }])
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
    };
    const grantsFreshAttempt =
      task.status === "failed" ||
      task.status === "rejected" ||
      (task.status === "planned" && task.attempt > 0);
    candidateTasks[update.taskId] = grantsFreshAttempt
      ? {
          ...task,
          ...patch,
          status: "planned",
          attemptLimit: Math.max(task.attemptLimit ?? 0, task.attempt + 1),
          assignedWorkerId: undefined,
          changeSetId: undefined,
          failureReason: undefined,
        }
      : { ...task, ...patch };
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
}

function emptySchedulerProjection(event: SchedulerEvent): SchedulerProjection {
  return {
    runId: event.runId,
    status: "running",
    planRevision: 0,
    tasks: {},
    guidance: {},
    reviews: {},
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
    tasks: Object.fromEntries(tasks.map((task) => [task.id, { ...task }])),
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

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) throw new Error(`Missing ${key}.`);
  return value;
}

function requiredNumber(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (!Number.isSafeInteger(value)) throw new Error(`Missing ${key}.`);
  return value as number;
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
