import type {
  NewRunEvent,
  PermissionProfile,
  RunActor,
  RunEvent,
  RunEventType,
  RunProjection,
} from "./contracts.js";
import { RUNNER_V2_SCHEMA_VERSION } from "./contracts.js";
import type { EventStore } from "./event-store.js";
import { rebuildRunProjection, reduceRunEvent } from "./reducer.js";

export interface RunSupervisorOptions {
  clock?: () => string;
}

export interface CreateRunInput {
  runId: string;
  projectPath: string;
  permissionProfile: PermissionProfile;
  idempotencyKey: string;
}

export type RunEventListener = (event: RunEvent) => void;

export class RunSupervisor {
  private readonly clock: () => string;
  private readonly projections = new Map<string, RunProjection>();
  private readonly listeners = new Set<RunEventListener>();

  constructor(
    private readonly store: EventStore,
    options: RunSupervisorOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    for (const runId of store.listRunIds()) {
      this.projections.set(runId, rebuildRunProjection(store.readRun(runId)));
    }
  }

  createRun(input: CreateRunInput): RunProjection {
    this.append({
      runId: input.runId,
      type: "run.created",
      occurredAt: this.clock(),
      actor: { kind: "user", id: "local-user" },
      idempotencyKey: input.idempotencyKey,
      payload: {
        projectPath: input.projectPath,
        permissionProfile: input.permissionProfile,
      },
    });
    return this.getRun(input.runId);
  }

  start(runId: string, idempotencyKey: string): RunProjection {
    return this.command(runId, "run.started", idempotencyKey);
  }

  captureBaseline(
    runId: string,
    idempotencyKey: string,
    baselineRevision: string,
    baselineRef: string
  ): RunProjection {
    return this.command(runId, "run.baseline_captured", idempotencyKey, {
      baselineRevision,
      baselineRef,
    });
  }

  pause(runId: string, idempotencyKey: string, reason: string): RunProjection {
    return this.command(runId, "run.paused", idempotencyKey, { reason });
  }

  resume(runId: string, idempotencyKey: string): RunProjection {
    return this.command(runId, "run.resumed", idempotencyKey);
  }

  requestStop(
    runId: string,
    idempotencyKey: string,
    reason: string
  ): RunProjection {
    return this.command(runId, "run.stop_requested", idempotencyKey, {
      reason,
    });
  }

  confirmStopped(
    runId: string,
    idempotencyKey: string,
    reason: string
  ): RunProjection {
    return this.command(runId, "run.stopped", idempotencyKey, { reason });
  }

  complete(runId: string, idempotencyKey: string): RunProjection {
    return this.command(runId, "run.completed", idempotencyKey);
  }

  fail(runId: string, idempotencyKey: string, reason: string): RunProjection {
    return this.command(runId, "run.failed", idempotencyKey, { reason });
  }

  getRun(runId: string): RunProjection {
    const projection = this.projections.get(runId);
    if (!projection) throw new Error(`Unknown run ${runId}.`);
    return { ...projection };
  }

  listRuns(): RunProjection[] {
    return [...this.projections.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((projection) => ({ ...projection }));
  }

  events(runId: string, afterSequence = 0): RunEvent[] {
    return this.store.readRun(runId, afterSequence);
  }

  subscribe(listener: RunEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
    this.store.close();
  }

  private command(
    runId: string,
    type: Exclude<RunEventType, "run.created">,
    idempotencyKey: string,
    payload: Record<string, unknown> = {},
    actor: RunActor = { kind: "runner", id: "runner-v2" }
  ): RunProjection {
    this.getRun(runId);
    this.append({
      runId,
      type,
      occurredAt: this.clock(),
      actor,
      idempotencyKey,
      payload,
    });
    return this.getRun(runId);
  }

  private append(input: NewRunEvent): RunEvent {
    const existing = this.store
      .readRun(input.runId)
      .find((event) => event.idempotencyKey === input.idempotencyKey);
    if (existing) return existing;

    const current = this.projections.get(input.runId);
    reduceRunEvent(current, {
      ...input,
      schemaVersion: RUNNER_V2_SCHEMA_VERSION,
      eventId: "evt_preflight",
      sequence: (current?.lastSequence ?? 0) + 1,
    });
    const event = this.store.append(input);
    const projection = rebuildRunProjection(this.store.readRun(input.runId));
    this.projections.set(input.runId, projection);
    for (const listener of this.listeners) listener(event);
    return event;
  }
}
