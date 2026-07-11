export const RUNNER_V2_SCHEMA_VERSION = 1 as const;

export type PermissionProfile = "guarded" | "project" | "full";

export type RunState =
  | "created"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed";

export interface RunActor {
  kind: "user" | "runner" | "architect" | "worker" | "subagent";
  id: string;
}

export type RunEventType =
  | "run.created"
  | "run.baseline_captured"
  | "run.started"
  | "run.paused"
  | "run.resumed"
  | "run.stop_requested"
  | "run.stopped"
  | "run.completed"
  | "run.failed";

export interface RunEvent {
  schemaVersion: typeof RUNNER_V2_SCHEMA_VERSION;
  eventId: string;
  runId: string;
  sequence: number;
  type: RunEventType;
  occurredAt: string;
  actor: RunActor;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export type NewRunEvent = Omit<
  RunEvent,
  "schemaVersion" | "eventId" | "sequence"
>;

export interface RunProjection {
  runId: string;
  state: RunState;
  projectPath: string;
  permissionProfile: PermissionProfile;
  createdAt: string;
  updatedAt: string;
  lastSequence: number;
  baselineRevision?: string;
  baselineRef?: string;
  stopReason?: string;
}

export type RunCommand = "start" | "pause" | "resume" | "stop";

export function assertRunEvent(value: RunEvent): void {
  if (!value.eventId) throw new Error("eventId is required");
  if (!value.runId) throw new Error("runId is required");
  if (!Number.isInteger(value.sequence) || value.sequence < 1) {
    throw new Error("sequence must be a positive integer");
  }
  if (!value.idempotencyKey) throw new Error("idempotencyKey is required");
  if (!value.occurredAt || Number.isNaN(Date.parse(value.occurredAt))) {
    throw new Error("occurredAt must be an ISO timestamp");
  }
}
