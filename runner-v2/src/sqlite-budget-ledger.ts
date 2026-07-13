import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  rebuildBudgetProjection,
  modelCallAttribution,
  modelCostBasisSnapshot,
  modelTokenSources,
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
  private readonly projections = new Map<string, BudgetProjection>();

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
    const attribution = input.kind === "model"
      ? modelCallAttribution(input.attribution)
      : undefined;
    const costBasis = input.kind === "model" && input.costBasis
      ? modelCostBasisSnapshot(input.costBasis)
      : undefined;
    return this.append(
      input.scopeId,
      "budget.reserved",
      input.occurredAt,
      input.idempotencyKey,
      {
        reservationId: input.reservationId,
        kind: input.kind,
        ...(attribution ? { attribution } : {}),
        ...(costBasis ? { costBasis } : {}),
        estimate,
      },
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
    const tokenSources = input.tokenSources === undefined
      ? undefined
      : modelTokenSources(input.tokenSources);
    const costBasis = input.costBasis === undefined
      ? undefined
      : modelCostBasisSnapshot(input.costBasis);
    return this.append(
      input.scopeId,
      "budget.settled",
      input.occurredAt,
      input.idempotencyKey,
      {
        reservationId: input.reservationId,
        actual,
        ...(tokenSources
          ? { tokenSources, settledAt: input.occurredAt }
          : {}),
        ...(costBasis ? { costBasis } : {}),
      },
      (projection) => {
        const reservation = projection.reservations[input.reservationId];
        if (reservation?.kind === "model" && !tokenSources) {
          throw new Error("Model budget settlements require token source provenance.");
        }
        if (reservation?.kind === "tool" && tokenSources) {
          throw new Error("Tool budget settlements cannot carry model token sources.");
        }
        if (
          reservation?.kind === "model" &&
          costBasis &&
          reservation.costBasis &&
          JSON.stringify(costBasis) !== JSON.stringify(reservation.costBasis)
        ) {
          throw new Error("Model cost basis cannot change at settlement.");
        }
      }
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
    const projection = this.mutableProjection(input.scopeId);
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
    return structuredClone(this.mutableProjection(scopeId));
  }

  events(scopeId: string): BudgetEvent[] {
    return this.rowsAfter(scopeId, 0).map(decode);
  }

  close(): void {
    this.projections.clear();
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
        if (event.type !== type || !samePayload(type, event.payload, payload)) {
          throw new Error(`Budget idempotency conflict for ${idempotencyKey}.`);
        }
        this.database.exec("COMMIT");
        return event;
      }
      const projection = this.mutableProjection(scopeId);
      preflight?.(projection);
      const event: BudgetEvent = {
        sequence: 0,
        eventId: `budget_${randomUUID()}`,
        scopeId,
        type,
        occurredAt,
        idempotencyKey,
        payload,
      };
      const inserted = this.database
        .prepare(
          `INSERT INTO budget_events (
            event_id, scope_id, event_type, occurred_at, idempotency_key, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(event.eventId, scopeId, type, occurredAt, idempotencyKey, JSON.stringify(payload));
      event.sequence = Number(inserted.lastInsertRowid);
      reduceBudgetEvent(projection, event);
      this.database.exec("COMMIT");
      return event;
    } catch (error) {
      this.projections.delete(scopeId);
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private mutableProjection(scopeId: string): BudgetProjection {
    let projection = this.projections.get(scopeId);
    if (!projection) {
      projection = rebuildBudgetProjection(scopeId, this.events(scopeId));
      this.projections.set(scopeId, projection);
      return projection;
    }
    for (const row of this.rowsAfter(scopeId, projection.lastSequence)) {
      reduceBudgetEvent(projection, decode(row));
    }
    return projection;
  }

  private rowsAfter(scopeId: string, sequence: number): BudgetRow[] {
    return this.database
      .prepare(
        `SELECT sequence, event_id, scope_id, event_type, occurred_at,
                idempotency_key, payload_json
         FROM budget_events
         WHERE scope_id = ? AND sequence > ?
         ORDER BY sequence`
      )
      .all(scopeId, sequence) as unknown as BudgetRow[];
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

function samePayload(
  type: BudgetEventType,
  left: Record<string, unknown>,
  right: Record<string, unknown>
): boolean {
  if (type !== "budget.settled") {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  const leftSemantic = { ...left };
  const rightSemantic = { ...right };
  delete leftSemantic.settledAt;
  delete rightSemantic.settledAt;
  return JSON.stringify(leftSemantic) === JSON.stringify(rightSemantic);
}
