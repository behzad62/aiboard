import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  BeginToolInvocation,
  ToolInvocationLedger,
  ToolLedgerDecision,
  ToolLedgerEvent,
  ToolLedgerEventType,
} from "./tool-ledger.js";
import type { ToolResult } from "./agent-contracts.js";

interface EventRow {
  sequence: number;
  invocation_key: string;
  event_type: ToolLedgerEventType;
  fingerprint: string;
  occurred_at: string;
  payload_json: string | null;
}

export class SqliteToolLedger implements ToolInvocationLedger {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tool_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        invocation_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tool_events_key
      ON tool_events(invocation_key, sequence);
    `);
  }

  begin(input: BeginToolInvocation): ToolLedgerDecision {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const events = this.readRows(input.key);
      if (events.some((event) => event.fingerprint !== input.fingerprint)) {
        this.database.exec("COMMIT");
        return { state: "conflict" };
      }
      const completed = [...events]
        .reverse()
        .find((event) => event.event_type === "tool.completed");
      if (completed) {
        const result = decodeResult(completed);
        this.database.exec("COMMIT");
        return { state: "completed", result };
      }
      if (events.length > 0 && !input.replaySafe) {
        this.database.exec("COMMIT");
        return { state: "in_doubt" };
      }
      this.insert(
        input.key,
        events.length > 0 ? "tool.retry_started" : "tool.started",
        input.fingerprint,
        input.occurredAt,
        JSON.stringify({
          runId: input.runId,
          sessionId: input.sessionId,
          callId: input.callId,
          toolName: input.toolName,
        })
      );
      this.database.exec("COMMIT");
      return { state: "new" };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  complete(
    key: string,
    fingerprint: string,
    result: ToolResult,
    occurredAt: string
  ): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const events = this.readRows(key);
      if (events.some((event) => event.fingerprint !== fingerprint)) {
        throw new Error(`Tool invocation ${key} has a conflicting fingerprint.`);
      }
      if (!events.some((event) => event.event_type === "tool.completed")) {
        this.insert(
          key,
          "tool.completed",
          fingerprint,
          occurredAt,
          JSON.stringify(result)
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  events(key: string): ToolLedgerEvent[] {
    return this.readRows(key).map(decodeEvent);
  }

  listRun(runId: string): ToolLedgerEvent[] {
    return (
      this.database
        .prepare(
          `SELECT sequence, invocation_key, event_type, fingerprint,
                  occurred_at, payload_json
           FROM tool_events ORDER BY sequence ASC`
        )
        .all() as unknown as EventRow[]
    )
      .filter((row) => row.invocation_key.startsWith(`${runId}\0`))
      .map(decodeEvent);
  }

  close(): void {
    this.database.close();
  }

  private readRows(key: string): EventRow[] {
    return this.database
      .prepare(
        `SELECT sequence, invocation_key, event_type, fingerprint,
                occurred_at, payload_json
         FROM tool_events WHERE invocation_key = ? ORDER BY sequence ASC`
      )
      .all(key) as unknown as EventRow[];
  }

  private insert(
    key: string,
    type: ToolLedgerEventType,
    fingerprint: string,
    occurredAt: string,
    payload: string | null
  ): void {
    this.database
      .prepare(
        `INSERT INTO tool_events (
          invocation_key, event_type, fingerprint, occurred_at, payload_json
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(key, type, fingerprint, occurredAt, payload);
  }
}

function decodeEvent(row: EventRow): ToolLedgerEvent {
  const [runId, sessionId, callId] = row.invocation_key.split("\0");
  let toolName: string | undefined;
  if (row.event_type === "tool.completed") {
    toolName = decodeResult(row).toolName;
  } else if (row.payload_json) {
    try {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      toolName = typeof payload.toolName === "string" ? payload.toolName : undefined;
    } catch {
      toolName = undefined;
    }
  }
  return {
    sequence: row.sequence,
    key: row.invocation_key,
    type: row.event_type,
    fingerprint: row.fingerprint,
    occurredAt: row.occurred_at,
    ...(runId ? { runId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(callId ? { callId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(row.event_type === "tool.completed"
      ? { result: decodeResult(row) }
      : {}),
  };
}

function decodeResult(row: EventRow): ToolResult {
  if (!row.payload_json) {
    throw new Error(`Completed tool event ${row.sequence} has no result.`);
  }
  try {
    return JSON.parse(row.payload_json) as ToolResult;
  } catch (error) {
    throw new Error(`Tool event ${row.sequence} contains invalid result JSON.`, {
      cause: error,
    });
  }
}
