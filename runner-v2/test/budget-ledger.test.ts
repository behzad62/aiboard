import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BudgetExceededError } from "../src/budget-ledger.js";
import { SqliteBudgetLedger } from "../src/sqlite-budget-ledger.js";

const limits = {
  maxModelCalls: 2,
  maxToolCalls: 1,
  maxInputTokens: 100,
  maxOutputTokens: 50,
  maxEstimatedCostMicros: 1_000,
  maxActiveMs: 1_000,
  maxArtifactBytes: 200,
};

test("budget reservations stop excess calls before execution and recover after restart", () => {
  const fixture = budgetFixture();
  try {
    let ledger = new SqliteBudgetLedger(fixture.database, { limitsFor: () => limits });
    ledger.reserve({
      scopeId: "run_1",
      reservationId: "model_1",
      kind: "model",
      estimate: { inputTokens: 40, outputTokens: 20, estimatedCostMicros: 300 },
      occurredAt: "2026-07-12T00:00:00.000Z",
      idempotencyKey: "reserve:model_1",
    });
    ledger.settle({
      scopeId: "run_1",
      reservationId: "model_1",
      actual: { inputTokens: 30, outputTokens: 10, estimatedCostMicros: 250 },
      occurredAt: "2026-07-12T00:00:01.000Z",
      idempotencyKey: "settle:model_1",
    });
    ledger.reserve({
      scopeId: "run_1",
      reservationId: "model_2",
      kind: "model",
      estimate: { inputTokens: 60, outputTokens: 40, estimatedCostMicros: 700 },
      occurredAt: "2026-07-12T00:00:02.000Z",
      idempotencyKey: "reserve:model_2",
    });
    assert.throws(
      () => ledger.reserve({
        scopeId: "run_1",
        reservationId: "model_3",
        kind: "model",
        estimate: { inputTokens: 1, outputTokens: 1 },
        occurredAt: "2026-07-12T00:00:03.000Z",
        idempotencyKey: "reserve:model_3",
      }),
      (error: unknown) =>
        error instanceof BudgetExceededError && error.dimension === "modelCalls"
    );
    assert.equal(ledger.events("run_1").length, 3, "rejected call is not persisted");
    ledger.close();

    ledger = new SqliteBudgetLedger(fixture.database, { limitsFor: () => limits });
    const snapshot = ledger.snapshot("run_1");
    assert.equal(snapshot.effective.modelCalls, 2);
    assert.equal(snapshot.effective.inputTokens, 90);
    assert.equal(snapshot.effective.outputTokens, 50);
    assert.equal(snapshot.effective.estimatedCostMicros, 950);
    ledger.close();
  } finally {
    fixture.cleanup();
  }
});

test("idempotent reservations replay while conflicting reuse is rejected", () => {
  const fixture = budgetFixture();
  const ledger = new SqliteBudgetLedger(fixture.database, { limitsFor: () => limits });
  try {
    const reservation = {
      scopeId: "run_1",
      reservationId: "tool_1",
      kind: "tool" as const,
      estimate: { artifactBytes: 100 },
      occurredAt: "2026-07-12T00:00:00.000Z",
      idempotencyKey: "reserve:tool_1",
    };
    const first = ledger.reserve(reservation);
    const replay = ledger.reserve(reservation);
    assert.equal(replay.eventId, first.eventId);
    assert.throws(
      () => ledger.reserve({ ...reservation, estimate: { artifactBytes: 101 } }),
      /idempotency conflict/i
    );
    assert.equal(ledger.snapshot("run_1").effective.toolCalls, 1);
  } finally {
    ledger.close();
    fixture.cleanup();
  }
});

test("active-time accounting excludes waiting intervals", () => {
  const fixture = budgetFixture();
  const ledger = new SqliteBudgetLedger(fixture.database, { limitsFor: () => limits });
  try {
    ledger.startActive({
      scopeId: "run_1",
      segmentId: "active_1",
      occurredAt: "2026-07-12T00:00:00.000Z",
      idempotencyKey: "active:start:1",
    });
    ledger.stopActive({
      scopeId: "run_1",
      segmentId: "active_1",
      occurredAt: "2026-07-12T00:00:00.400Z",
      idempotencyKey: "active:stop:1",
    });
    // Ten seconds of provider/guidance waiting passes with no active segment.
    ledger.startActive({
      scopeId: "run_1",
      segmentId: "active_2",
      occurredAt: "2026-07-12T00:00:10.400Z",
      idempotencyKey: "active:start:2",
    });
    ledger.stopActive({
      scopeId: "run_1",
      segmentId: "active_2",
      occurredAt: "2026-07-12T00:00:10.900Z",
      idempotencyKey: "active:stop:2",
    });
    assert.equal(ledger.snapshot("run_1").effective.activeMs, 900);
    assert.throws(
      () => ledger.startActive({
        scopeId: "run_1",
        segmentId: "active_3",
        reserveMs: 101,
        occurredAt: "2026-07-12T00:00:11.000Z",
        idempotencyKey: "active:start:3",
      }),
      (error: unknown) =>
        error instanceof BudgetExceededError && error.dimension === "activeMs"
    );
  } finally {
    ledger.close();
    fixture.cleanup();
  }
});

function budgetFixture() {
  const root = mkdtempSync(join(tmpdir(), "aiboard-budget-ledger-"));
  return {
    database: join(root, "budget.sqlite"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
