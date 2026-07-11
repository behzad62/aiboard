import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  RUNNER_V2_SCHEMA_VERSION,
  assertRunEvent,
  type NewRunEvent,
  type RunActor,
  type RunEvent,
  type RunEventType,
} from "./contracts.js";
import type { EventStore } from "./event-store.js";

interface EventRow {
  event_id: string;
  run_id: string;
  sequence: number;
  event_type: string;
  occurred_at: string;
  actor_json: string;
  idempotency_key: string;
  payload_json: string;
  schema_version: number;
}

function decodeEvent(row: EventRow): RunEvent {
  let actor: RunActor;
  let payload: Record<string, unknown>;
  try {
    actor = JSON.parse(row.actor_json) as RunActor;
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Stored event ${row.event_id} contains invalid JSON.`, {
      cause: error,
    });
  }
  const event: RunEvent = {
    schemaVersion: row.schema_version as typeof RUNNER_V2_SCHEMA_VERSION,
    eventId: row.event_id,
    runId: row.run_id,
    sequence: row.sequence,
    type: row.event_type as RunEventType,
    occurredAt: row.occurred_at,
    actor,
    idempotencyKey: row.idempotency_key,
    payload,
  };
  if (event.schemaVersion !== RUNNER_V2_SCHEMA_VERSION) {
    throw new Error(
      `Stored event ${event.eventId} uses unsupported schema ${event.schemaVersion}.`
    );
  }
  assertRunEvent(event);
  return event;
}

export class SqliteEventStore implements EventStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS run_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        UNIQUE(run_id, sequence),
        UNIQUE(run_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_run_events_order
      ON run_events(run_id, sequence);
    `);
  }

  append(input: NewRunEvent): RunEvent {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare(
          `SELECT * FROM run_events
           WHERE run_id = ? AND idempotency_key = ?`
        )
        .get(input.runId, input.idempotencyKey) as EventRow | undefined;
      if (existing) {
        this.database.exec("COMMIT");
        return decodeEvent(existing);
      }

      const nextRow = this.database
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
           FROM run_events WHERE run_id = ?`
        )
        .get(input.runId) as { sequence: number };
      const event: RunEvent = {
        ...input,
        schemaVersion: RUNNER_V2_SCHEMA_VERSION,
        eventId: `evt_${randomUUID()}`,
        sequence: nextRow.sequence,
      };
      assertRunEvent(event);
      this.database
        .prepare(
          `INSERT INTO run_events (
            event_id, run_id, sequence, event_type, occurred_at,
            actor_json, idempotency_key, payload_json, schema_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          event.eventId,
          event.runId,
          event.sequence,
          event.type,
          event.occurredAt,
          JSON.stringify(event.actor),
          event.idempotencyKey,
          JSON.stringify(event.payload),
          event.schemaVersion
        );
      this.database.exec("COMMIT");
      return event;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  readRun(runId: string, afterSequence = 0): RunEvent[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM run_events
         WHERE run_id = ? AND sequence > ?
         ORDER BY sequence ASC`
      )
      .all(runId, afterSequence) as unknown as EventRow[];
    return rows.map(decodeEvent);
  }

  listRunIds(): string[] {
    const rows = this.database
      .prepare("SELECT DISTINCT run_id FROM run_events ORDER BY run_id ASC")
      .all() as unknown as Array<{ run_id: string }>;
    return rows.map((row) => row.run_id);
  }

  close(): void {
    this.database.close();
  }
}
