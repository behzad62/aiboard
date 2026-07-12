import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  rebuildBudgetProjection,
  reduceBudgetEvent,
  usageAmount,
  type BudgetEvent,
  type BudgetEventType,
  type BudgetLedger,
  type BudgetLimits,
  type BudgetProjection,
  type ReserveBudgetInput,
  type SettleBudgetInput,
  type StartActiveInput,
  type StartBudgetWindowInput,
  type StopActiveInput,
} from "./budget-ledger.js";
import { assertBudgetLimits, assertWithinBudget } from "./budget-policy.js";

interface BudgetRow {
  sequence: number;
  event_id: string;
  scope_id: string;
  event_type: BudgetEventType;
  occurred_at: string;
  idempotency_key: string;
  payload_json: string;
}

export interface SqliteBudgetLedgerOptions {
  limitsFor: (scopeId: string) => BudgetLimits;
}

export class SqliteBudgetLedger implements BudgetLedger {
  private readonly database: DatabaseSync;
  private readonly limitsFor: SqliteBudgetLedgerOptions["limitsFor"];

  constructor(databasePath: string, options: SqliteBudgetLedgerOptions) {
    this.limitsFor = options.limitsFor;
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS budget_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        scope_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(scope_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_budget_events
      ON budget_events(scope_id, sequence);
    `);
  }

  reserve(input: ReserveBudgetInput): BudgetEvent {
    const estimate = usageAmount(input.estimate);
    return this.append(
      input.scopeId,
      "budget.reserved",
      input.occurredAt,
      input.idempotencyKey,
      { reservationId: input.reservationId, kind: input.kind, estimate },
      (projection) => {
        const delta = {
          ...(input.kind === "model" ? { modelCalls: 1 } : { toolCalls: 1 }),
          ...estimate,
        };
        assertWithinBudget(
          input.scopeId,
          projection.effective,
          delta,
          this.limits(input.scopeId)
        );
      }
    );
  }

  settle(input: SettleBudgetInput): BudgetEvent {
    const actual = usageAmount(input.actual);
    return this.append(
      input.scopeId,
      "budget.settled",
      input.occurredAt,
      input.idempotencyKey,
      { reservationId: input.reservationId, actual }
    );
  }

  startActive(input: StartActiveInput): BudgetEvent {
    const reserveMs = input.reserveMs ?? 0;
    if (!Number.isSafeInteger(reserveMs) || reserveMs < 0) {
      throw new Error("reserveMs must be a non-negative integer.");
    }
    return this.append(
      input.scopeId,
      "active.started",
      input.occurredAt,
      input.idempotencyKey,
      { segmentId: input.segmentId, reserveMs },
      (projection) =>
        assertWithinBudget(
          input.scopeId,
          projection.effective,
          { activeMs: reserveMs },
          this.limits(input.scopeId)
        )
    );
  }

  stopActive(input: StopActiveInput): BudgetEvent {
    const projection = this.snapshot(input.scopeId);
    const segment = projection.activeSegments[input.segmentId];
    if (segment?.durationMs !== undefined) {
      const existing = this.events(input.scopeId).findLast(
        (event) =>
          event.type === "active.stopped" &&
          event.payload.segmentId === input.segmentId,
      );
      if (existing) return existing;
    }
    if (!segment) {
      throw new Error(`Active segment ${input.segmentId} is not open.`);
    }
    const durationMs = Date.parse(input.occurredAt) - Date.parse(segment.startedAt);
    if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
      throw new Error("Active segment stop time precedes its start.");
    }
    return this.append(
      input.scopeId,
      "active.stopped",
      input.occurredAt,
      input.idempotencyKey,
      { segmentId: input.segmentId, durationMs }
    );
  }

  recoverInterruptedActive(scopeId: string, idempotencyPrefix: string): BudgetEvent[] {
    const open = Object.values(this.snapshot(scopeId).activeSegments).filter(
      (segment) => segment.durationMs === undefined,
    );
    return open.map((segment) =>
      this.stopActive({
        scopeId,
        segmentId: segment.segmentId,
        occurredAt: segment.startedAt,
        idempotencyKey: `${idempotencyPrefix}:${segment.segmentId}`,
      }),
    );
  }

  startWindow(input: StartBudgetWindowInput): BudgetEvent {
    return this.append(
      input.scopeId,
      "budget.window_started",
      input.occurredAt,
      input.idempotencyKey,
      {},
      (projection) => {
        if (
          Object.values(projection.activeSegments).some(
            (segment) => segment.durationMs === undefined
          )
        ) {
          throw new Error("A budget window cannot start while active work is running.");
        }
      }
    );
  }

  snapshot(scopeId: string): BudgetProjection {
    return rebuildBudgetProjection(scopeId, this.events(scopeId));
  }

  events(scopeId: string): BudgetEvent[] {
    return (
      this.database
        .prepare(
          `SELECT sequence, event_id, scope_id, event_type, occurred_at,
                  idempotency_key, payload_json
           FROM budget_events WHERE scope_id = ? ORDER BY sequence`
        )
        .all(scopeId) as unknown as BudgetRow[]
    ).map(decode);
  }

  close(): void {
    this.database.close();
  }

  private limits(scopeId: string): BudgetLimits {
    const limits = this.limitsFor(scopeId);
    assertBudgetLimits(limits);
    return limits;
  }

  private append(
    scopeId: string,
    type: BudgetEventType,
    occurredAt: string,
    idempotencyKey: string,
    payload: Record<string, unknown>,
    preflight?: (projection: BudgetProjection) => void
  ): BudgetEvent {
    if (!scopeId || !idempotencyKey) throw new Error("Budget scope and idempotency key are required.");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare(
          `SELECT sequence, event_id, scope_id, event_type, occurred_at,
                  idempotency_key, payload_json
           FROM budget_events WHERE scope_id = ? AND idempotency_key = ?`
        )
        .get(scopeId, idempotencyKey) as BudgetRow | undefined;
      if (existing) {
        const event = decode(existing);
        if (event.type !== type || JSON.stringify(event.payload) !== JSON.stringify(payload)) {
          throw new Error(`Budget idempotency conflict for ${idempotencyKey}.`);
        }
        this.database.exec("COMMIT");
        return event;
      }
      const rows = this.database
        .prepare(
          `SELECT sequence, event_id, scope_id, event_type, occurred_at,
                  idempotency_key, payload_json
           FROM budget_events WHERE scope_id = ? ORDER BY sequence`
        )
        .all(scopeId) as unknown as BudgetRow[];
      const prior = rows.map(decode);
      const projection = rebuildBudgetProjection(scopeId, prior);
      preflight?.(projection);
      const event: BudgetEvent = {
        sequence: Number(
          (
            this.database
              .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM budget_events")
              .get() as { sequence: number }
          ).sequence
        ),
        eventId: `budget_${randomUUID()}`,
        scopeId,
        type,
        occurredAt,
        idempotencyKey,
        payload,
      };
      reduceBudgetEvent(projection, event);
      this.database
        .prepare(
          `INSERT INTO budget_events (
            event_id, scope_id, event_type, occurred_at, idempotency_key, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(event.eventId, scopeId, type, occurredAt, idempotencyKey, JSON.stringify(payload));
      this.database.exec("COMMIT");
      return event;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function decode(row: BudgetRow): BudgetEvent {
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    scopeId: row.scope_id,
    type: row.event_type,
    occurredAt: row.occurred_at,
    idempotencyKey: row.idempotency_key,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  };
}
