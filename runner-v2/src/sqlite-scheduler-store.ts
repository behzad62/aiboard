import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  NewSchedulerEvent,
  SchedulerActor,
  SchedulerEvent,
  SchedulerEventType,
  SchedulerProjection,
  SchedulerStore,
} from "./scheduler-store.js";
import {
  reduceSchedulerEvent,
  validateSchedulerEvidenceEvent,
} from "./scheduler-store.js";
import type { EvidenceStore } from "./evidence-store.js";

interface EventRow {
  event_id: string;
  run_id: string;
  sequence: number;
  event_type: SchedulerEventType;
  occurred_at: string;
  actor_json: string;
  idempotency_key: string;
  payload_json: string;
}

export interface SqliteSchedulerStoreOptions {
  /**
   * Required whenever a run carries acceptance-evidence events. It may be
   * omitted only for deterministic legacy runs that contain no such events;
   * those events fail closed if this store is absent.
   */
  evidenceStore?: EvidenceStore;
}

export class SqliteSchedulerStore implements SchedulerStore {
  private readonly database: DatabaseSync;
  private readonly evidenceStore?: EvidenceStore;

  constructor(databasePath: string, options: SqliteSchedulerStoreOptions = {}) {
    this.evidenceStore = options.evidenceStore;
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS scheduler_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(run_id, sequence),
        UNIQUE(run_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_scheduler_events
      ON scheduler_events(run_id, sequence);
    `);
  }

  append(input: NewSchedulerEvent): SchedulerEvent {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const priorRows = this.database
        .prepare(
          "SELECT * FROM scheduler_events WHERE run_id = ? ORDER BY sequence"
        )
        .all(input.runId) as unknown as EventRow[];
      const priorEvents = priorRows.map(decode);
      const priorProjection = replaySchedulerEvents(
        priorEvents,
        this.evidenceStore,
      );
      const existing = this.database
        .prepare(
          "SELECT * FROM scheduler_events WHERE run_id = ? AND idempotency_key = ?"
        )
        .get(input.runId, input.idempotencyKey) as EventRow | undefined;
      if (existing) {
        const event = decode(existing);
        if (
          event.type !== input.type ||
          JSON.stringify(event.payload) !== JSON.stringify(input.payload) ||
          JSON.stringify(event.actor) !== JSON.stringify(input.actor)
        ) {
          throw new Error(
            `Scheduler idempotency conflict for ${input.idempotencyKey}.`
          );
        }
        this.database.exec("COMMIT");
        return event;
      }
      const row = this.database
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM scheduler_events WHERE run_id = ?"
        )
        .get(input.runId) as { sequence: number };
      const event: SchedulerEvent = {
        ...input,
        eventId: `sched_${randomUUID()}`,
        sequence: row.sequence,
      };
      validateSchedulerEvent(priorProjection, event, this.evidenceStore);
      reduceSchedulerEvent(priorProjection, event);
      this.database
        .prepare(
          `INSERT INTO scheduler_events (
            event_id, run_id, sequence, event_type, occurred_at,
            actor_json, idempotency_key, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          event.eventId,
          event.runId,
          event.sequence,
          event.type,
          event.occurredAt,
          JSON.stringify(event.actor),
          event.idempotencyKey,
          JSON.stringify(event.payload)
        );
      this.database.exec("COMMIT");
      return event;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  readRun(runId: string, afterSequence = 0): SchedulerEvent[] {
    const events = (
      this.database
        .prepare(
          "SELECT * FROM scheduler_events WHERE run_id = ? ORDER BY sequence"
        )
        .all(runId) as unknown as EventRow[]
    ).map(decode);
    replaySchedulerEvents(events, this.evidenceStore);
    return events.filter((event) => event.sequence > afterSequence);
  }

  close(): void {
    this.database.close();
  }
}

function replaySchedulerEvents(
  events: readonly SchedulerEvent[],
  evidenceStore?: EvidenceStore,
): SchedulerProjection | undefined {
  let projection: SchedulerProjection | undefined;
  for (const event of events) {
    validateSchedulerEvent(projection, event, evidenceStore);
    projection = reduceSchedulerEvent(projection, event);
  }
  return projection;
}

function validateSchedulerEvent(
  projection: SchedulerProjection | undefined,
  event: SchedulerEvent,
  evidenceStore?: EvidenceStore,
): void {
  if (requiresAuthoritativeEvidenceStore(projection, event) && !evidenceStore) {
    throw new Error(
      "An authoritative evidence store is required for acceptance evidence events.",
    );
  }
  if (evidenceStore) {
    validateSchedulerEvidenceEvent(projection, event, evidenceStore);
  }
}

function requiresAuthoritativeEvidenceStore(
  projection: SchedulerProjection | undefined,
  event: SchedulerEvent,
): boolean {
  if (!projection) return false;
  if (
    event.type !== "task.transitioned" &&
    event.type !== "review.requested" &&
    event.type !== "review.decided"
  ) {
    return false;
  }
  if (event.type === "task.transitioned" && event.payload.status !== "submitted") {
    return false;
  }
  const taskId = event.payload.taskId;
  return (
    typeof taskId === "string" &&
    taskId.length > 0 &&
    projection.tasks[taskId]?.acceptanceCriteria !== undefined
  );
}

function decode(row: EventRow): SchedulerEvent {
  try {
    return {
      eventId: row.event_id,
      runId: row.run_id,
      sequence: row.sequence,
      type: row.event_type,
      occurredAt: row.occurred_at,
      actor: JSON.parse(row.actor_json) as SchedulerActor,
      idempotencyKey: row.idempotency_key,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    };
  } catch (error) {
    throw new Error(`Scheduler event ${row.event_id} contains invalid JSON.`, {
      cause: error,
    });
  }
}
