import type {
  PermissionProfile,
  RunEvent,
  RunEventType,
  RunProjection,
  RunState,
} from "./contracts.js";

const TRANSITIONS: Partial<Record<RunState, Partial<Record<RunEventType, RunState>>>> = {
  created: {
    "run.started": "running",
    "run.stop_requested": "stopping",
    "run.failed": "failed",
  },
  running: {
    "run.paused": "paused",
    "run.stop_requested": "stopping",
    "run.completed": "completed",
    "run.failed": "failed",
  },
  paused: {
    "run.resumed": "running",
    "run.stop_requested": "stopping",
    "run.completed": "completed",
    "run.failed": "failed",
  },
  stopping: {
    "run.stopped": "stopped",
    "run.failed": "failed",
  },
};

function requiredString(
  payload: Record<string, unknown>,
  key: string,
  eventId: string
): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Event ${eventId} requires payload.${key}.`);
  }
  return value;
}

function permissionProfile(
  payload: Record<string, unknown>,
  eventId: string
): PermissionProfile {
  const value = requiredString(payload, "permissionProfile", eventId);
  if (value !== "guarded" && value !== "project" && value !== "full") {
    throw new Error(`Event ${eventId} has invalid permissionProfile ${value}.`);
  }
  return value;
}

export function reduceRunEvent(
  current: RunProjection | undefined,
  event: RunEvent
): RunProjection {
  if (!current) {
    if (event.sequence !== 1 || event.type !== "run.created") {
      throw new Error(
        `Run ${event.runId} must begin with sequence 1 run.created.`
      );
    }
    return {
      runId: event.runId,
      state: "created",
      projectPath: requiredString(event.payload, "projectPath", event.eventId),
      permissionProfile: permissionProfile(event.payload, event.eventId),
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
      lastSequence: event.sequence,
    };
  }

  if (event.runId !== current.runId) {
    throw new Error(`Event ${event.eventId} belongs to a different run.`);
  }
  if (event.sequence !== current.lastSequence + 1) {
    throw new Error(
      `Run ${event.runId} expected sequence ${current.lastSequence + 1}, received ${event.sequence}.`
    );
  }
  if (event.type === "run.baseline_captured") {
    if (current.state !== "created") {
      throw new Error(
        `Run ${event.runId} cannot capture its baseline in state ${current.state}.`
      );
    }
    if (current.baselineRevision) {
      throw new Error(`Run ${event.runId} already has a baseline.`);
    }
    return {
      ...current,
      baselineRevision: requiredString(
        event.payload,
        "baselineRevision",
        event.eventId
      ),
      baselineRef: requiredString(event.payload, "baselineRef", event.eventId),
      updatedAt: event.occurredAt,
      lastSequence: event.sequence,
    };
  }
  if (event.type === "run.started" && !current.baselineRevision) {
    throw new Error(`Run ${event.runId} cannot start before its Git baseline exists.`);
  }
  const nextState = TRANSITIONS[current.state]?.[event.type];
  if (!nextState) {
    throw new Error(
      `Run ${event.runId} in state ${current.state} cannot accept ${event.type}.`
    );
  }
  const recordsStopReason =
    event.type === "run.stop_requested" ||
    event.type === "run.stopped" ||
    event.type === "run.failed";
  const reason =
    recordsStopReason &&
    typeof event.payload.reason === "string" &&
    event.payload.reason.trim()
      ? event.payload.reason
      : undefined;
  return {
    ...current,
    state: nextState,
    updatedAt: event.occurredAt,
    lastSequence: event.sequence,
    ...(reason ? { stopReason: reason } : {}),
  };
}

export function rebuildRunProjection(
  events: readonly RunEvent[]
): RunProjection {
  if (events.length === 0) throw new Error("Cannot project an empty run.");
  let projection: RunProjection | undefined;
  for (const event of events) projection = reduceRunEvent(projection, event);
  return projection!;
}
