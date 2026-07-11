import type { BuildTask } from "./task-contracts.js";
import { applyTaskTransition, validateTaskGraph } from "./task-graph.js";

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
  | "plan.created"
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

export interface SchedulerProjection {
  runId: string;
  status: "running" | "paused" | "completed";
  planRevision: number;
  tasks: Record<string, BuildTask>;
  guidance: Record<string, GuidanceProjection>;
  reviews: Record<string, ReviewProjection>;
  runtime: RuntimeProjection;
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
    if (event.sequence !== 1 || event.type !== "plan.created") {
      throw new Error(`Scheduler run ${event.runId} must begin with plan.created.`);
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
    return {
      runId: event.runId,
      status: "running",
      planRevision: requiredNumber(event.payload, "revision"),
      tasks: Object.fromEntries(tasks.map((task) => [task.id, { ...task }])),
      guidance: {},
      reviews: {},
      runtime: {
        providerHealth: {},
        workerAssignments: {},
        architect: {},
      },
      lastSequence: event.sequence,
    };
  }
  if (event.runId !== current.runId || event.sequence !== current.lastSequence + 1) {
    throw new Error(`Scheduler event ${event.eventId} has invalid run ordering.`);
  }
  const next: SchedulerProjection = {
    ...current,
    tasks: { ...current.tasks },
    guidance: { ...current.guidance },
    reviews: { ...current.reviews },
    runtime: {
      providerHealth: { ...current.runtime.providerHealth },
      workerAssignments: { ...current.runtime.workerAssignments },
      architect: { ...current.runtime.architect },
    },
    lastSequence: event.sequence,
  };
  switch (event.type) {
    case "task.revised": {
      if (event.actor.role !== "architect") {
        throw new Error("Only the Architect may revise a task.");
      }
      const taskId = requiredString(event.payload, "taskId");
      const task = next.tasks[taskId];
      if (!task) throw new Error(`Unknown task ${taskId}.`);
      if (task.status !== "planned") {
        throw new Error(`Task ${taskId} must be planned before revision.`);
      }
      const patch = (event.payload.patch as Partial<BuildTask> | undefined) ?? {};
      const revised = { ...task, ...patch, id: task.id, status: task.status };
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
      next.runtime.architect = {
        ...next.runtime.architect,
        handoff: {
          reason: requiredString(event.payload, "reason"),
          requiredCapabilities: stringArray(event.payload, "requiredCapabilities"),
          candidateRuntimeIds: stringArray(event.payload, "candidateRuntimeIds"),
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
    case "plan.created":
      throw new Error("A scheduler run cannot create a second initial plan.");
  }
  return next;
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
