import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  BudgetExceededError,
  rebuildBudgetProjection,
  type ReserveBudgetInput,
} from "../src/budget-ledger.js";
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
      attribution: modelAttribution("session_1"),
      estimate: { inputTokens: 40, outputTokens: 20, estimatedCostMicros: 300 },
      occurredAt: "2026-07-12T00:00:00.000Z",
      idempotencyKey: "reserve:model_1",
    });
    ledger.settle({
      scopeId: "run_1",
      reservationId: "model_1",
      actual: { inputTokens: 30, outputTokens: 10, estimatedCostMicros: 250 },
      tokenSources: { inputTokens: "reported", outputTokens: "reported" },
      occurredAt: "2026-07-12T00:00:01.000Z",
      idempotencyKey: "settle:model_1",
    });
    ledger.reserve({
      scopeId: "run_1",
      reservationId: "model_2",
      kind: "model",
      attribution: modelAttribution("session_1"),
      estimate: { inputTokens: 60, outputTokens: 40, estimatedCostMicros: 700 },
      occurredAt: "2026-07-12T00:00:02.000Z",
      idempotencyKey: "reserve:model_2",
    });
    assert.throws(
      () => ledger.reserve({
        scopeId: "run_1",
        reservationId: "model_3",
        kind: "model",
        attribution: modelAttribution("session_1"),
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

test("a durable budget window renews limits while preserving lifetime usage", () => {
  const fixture = budgetFixture();
  try {
    let ledger = new SqliteBudgetLedger(fixture.database, { limitsFor: () => limits });
    for (const reservationId of ["model_1", "model_2"]) {
      ledger.reserve({
        scopeId: "run_1",
        reservationId,
        kind: "model",
        attribution: modelAttribution("session_1"),
        estimate: { inputTokens: 10, outputTokens: 5 },
        occurredAt: "2026-07-12T00:00:00.000Z",
        idempotencyKey: `reserve:${reservationId}`,
      });
    }
    const started = ledger.startWindow({
      scopeId: "run_1",
      occurredAt: "2026-07-12T00:01:00.000Z",
      idempotencyKey: "resume:budget:1",
    });
    const replay = ledger.startWindow({
      scopeId: "run_1",
      occurredAt: "2026-07-12T00:01:00.000Z",
      idempotencyKey: "resume:budget:1",
    });
    assert.equal(replay.eventId, started.eventId);
    ledger.reserve({
      scopeId: "run_1",
      reservationId: "model_3",
      kind: "model",
      attribution: modelAttribution("session_1"),
      estimate: { inputTokens: 8, outputTokens: 4 },
      occurredAt: "2026-07-12T00:01:01.000Z",
      idempotencyKey: "reserve:model_3",
    });
    ledger.close();

    ledger = new SqliteBudgetLedger(fixture.database, { limitsFor: () => limits });
    const snapshot = ledger.snapshot("run_1");
    assert.equal(snapshot.window.index, 2);
    assert.equal(snapshot.effective.modelCalls, 1);
    assert.equal(snapshot.effective.inputTokens, 8);
    assert.equal(snapshot.lifetime.modelCalls, 3);
    assert.equal(snapshot.lifetime.inputTokens, 28);
    ledger.close();
  } finally {
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

test("startup recovery closes orphaned active segments before a new window", () => {
  const fixture = budgetFixture();
  let ledger = new SqliteBudgetLedger(fixture.database, { limitsFor: () => limits });
  try {
    ledger.startActive({
      scopeId: "run_1",
      segmentId: "active_interrupted",
      occurredAt: "2026-07-12T00:00:00.000Z",
      idempotencyKey: "active:start:interrupted",
    });
    ledger.close();

    ledger = new SqliteBudgetLedger(fixture.database, { limitsFor: () => limits });
    assert.equal(
      ledger.recoverInterruptedActive("run_1", "startup:run_1").length,
      1,
    );
    assert.equal(
      ledger.recoverInterruptedActive("run_1", "startup:run_1").length,
      0,
    );
    assert.equal(
      ledger.stopActive({
        scopeId: "run_1",
        segmentId: "active_interrupted",
        occurredAt: "2026-07-12T00:10:00.000Z",
        idempotencyKey: "active:stop:replayed-after-recovery",
      }).type,
      "active.stopped",
    );
    ledger.startWindow({
      scopeId: "run_1",
      occurredAt: "2026-07-12T00:10:00.000Z",
      idempotencyKey: "window:after-recovery",
    });
    const snapshot = ledger.snapshot("run_1");
    assert.equal(snapshot.activeSegments.active_interrupted.durationMs, 0);
    assert.equal(snapshot.window.index, 2);
  } finally {
    ledger.close();
    fixture.cleanup();
  }
});

test("model attribution and token provenance rebuild durably while legacy events remain valid", () => {
  const fixture = budgetFixture();
  let ledger = new SqliteBudgetLedger(fixture.database, { limitsFor: () => limits });
  try {
    const attribution = {
      runtimeId: "runtime_worker",
      providerId: "provider_api",
      modelId: "model_code",
      role: "worker" as const,
      sessionId: "session_worker",
      taskId: "task_1",
    };
    ledger.reserve({
      scopeId: "run_1",
      reservationId: "model_attributed",
      kind: "model",
      attribution,
      estimate: { inputTokens: 20, outputTokens: 10 },
      occurredAt: "2026-07-12T00:00:00.000Z",
      idempotencyKey: "reserve:model_attributed",
    });
    const settled = ledger.settle({
      scopeId: "run_1",
      reservationId: "model_attributed",
      actual: { inputTokens: 12, outputTokens: 4 },
      tokenSources: { inputTokens: "reported", outputTokens: "estimated" },
      occurredAt: "2026-07-12T00:00:01.000Z",
      idempotencyKey: "settle:model_attributed",
    });
    const replayedSettlement = ledger.settle({
      scopeId: "run_1",
      reservationId: "model_attributed",
      actual: { inputTokens: 12, outputTokens: 4 },
      tokenSources: { inputTokens: "reported", outputTokens: "estimated" },
      occurredAt: "2026-07-12T00:00:02.000Z",
      idempotencyKey: "settle:model_attributed",
    });
    assert.equal(replayedSettlement.eventId, settled.eventId);
    ledger.close();

    ledger = new SqliteBudgetLedger(fixture.database, { limitsFor: () => limits });
    assert.deepEqual(ledger.snapshot("run_1").reservations.model_attributed, {
      reservationId: "model_attributed",
      kind: "model",
      attribution,
      estimate: { inputTokens: 20, outputTokens: 10 },
      actual: { inputTokens: 12, outputTokens: 4 },
      tokenSources: { inputTokens: "reported", outputTokens: "estimated" },
      settledAt: "2026-07-12T00:00:01.000Z",
      status: "settled",
      windowIndex: 1,
    });

    const legacy = rebuildBudgetProjection("legacy", [
      {
        sequence: 1,
        eventId: "legacy_reserved",
        scopeId: "legacy",
        type: "budget.reserved",
        occurredAt: "2026-01-01T00:00:00.000Z",
        idempotencyKey: "legacy:reserve",
        payload: {
          reservationId: "legacy_model",
          kind: "model",
          estimate: { inputTokens: 5, outputTokens: 3 },
        },
      },
      {
        sequence: 2,
        eventId: "legacy_settled",
        scopeId: "legacy",
        type: "budget.settled",
        occurredAt: "2026-01-01T00:00:01.000Z",
        idempotencyKey: "legacy:settle",
        payload: {
          reservationId: "legacy_model",
          actual: { inputTokens: 4, outputTokens: 2 },
        },
      },
    ]);
    assert.deepEqual(legacy.reservations.legacy_model, {
      reservationId: "legacy_model",
      kind: "model",
      estimate: { inputTokens: 5, outputTokens: 3 },
      actual: { inputTokens: 4, outputTokens: 2 },
      status: "settled",
      windowIndex: 1,
    });
  } finally {
    ledger.close();
    fixture.cleanup();
  }
});

test("new model reservations require attribution while tool reservations do not", () => {
  const fixture = budgetFixture();
  const ledger = new SqliteBudgetLedger(fixture.database, { limitsFor: () => limits });
  try {
    assert.throws(
      () => ledger.reserve({
        scopeId: "run_1",
        reservationId: "model_unattributed",
        kind: "model",
        estimate: { inputTokens: 1, outputTokens: 1 },
        occurredAt: "2026-07-12T00:00:00.000Z",
        idempotencyKey: "reserve:model_unattributed",
      } as unknown as ReserveBudgetInput),
      /attribution/i,
    );
    ledger.reserve({
      scopeId: "run_1",
      reservationId: "tool_unattributed",
      kind: "tool",
      estimate: { artifactBytes: 1 },
      occurredAt: "2026-07-12T00:00:00.000Z",
      idempotencyKey: "reserve:tool_unattributed",
    });
    assert.equal(ledger.snapshot("run_1").effective.toolCalls, 1);
  } finally {
    ledger.close();
    fixture.cleanup();
  }
});

test("large durable histories keep projection reads and appends bounded", () => {
  const fixture = budgetFixture();
  const historySize = 7_000;
  let ledger: SqliteBudgetLedger | undefined;
  try {
    const initialized = new SqliteBudgetLedger(fixture.database, {
      limitsFor: () => ({}),
    });
    initialized.close();

    const database = new DatabaseSync(fixture.database);
    database.exec("BEGIN IMMEDIATE");
    const insert = database.prepare(`
      INSERT INTO budget_events (
        event_id, scope_id, event_type, occurred_at, idempotency_key, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < historySize; index += 1) {
      insert.run(
        `event_${index}`,
        "run_large",
        "budget.reserved",
        "2026-07-12T00:00:00.000Z",
        `seed:${index}`,
        JSON.stringify({
          reservationId: `tool_${index}`,
          kind: "tool",
          estimate: {},
        })
      );
    }
    database.exec("COMMIT");
    database.close();

    ledger = new SqliteBudgetLedger(fixture.database, {
      limitsFor: () => ({}),
    });
    const snapshotStartedAt = performance.now();
    const snapshot = ledger.snapshot("run_large");
    const snapshotDurationMs = performance.now() - snapshotStartedAt;
    assert.equal(snapshot.effective.toolCalls, historySize);

    const appendStartedAt = performance.now();
    ledger.reserve({
      scopeId: "run_large",
      reservationId: "tool_after_history",
      kind: "tool",
      estimate: {},
      occurredAt: "2026-07-12T00:00:01.000Z",
      idempotencyKey: "reserve:after-history",
    });
    const appendDurationMs = performance.now() - appendStartedAt;
    assert.equal(ledger.snapshot("run_large").effective.toolCalls, historySize + 1);
    assert.ok(
      snapshotDurationMs < 1_500,
      `replaying ${historySize} budget events took ${snapshotDurationMs.toFixed(1)} ms`
    );
    assert.ok(
      appendDurationMs < 250,
      `appending after ${historySize} budget events took ${appendDurationMs.toFixed(1)} ms`
    );
  } finally {
    ledger?.close();
    fixture.cleanup();
  }
});

test("cached projections catch up with another ledger and snapshots stay isolated", () => {
  const fixture = budgetFixture();
  const sharedLimits = { maxToolCalls: 2 };
  const first = new SqliteBudgetLedger(fixture.database, {
    limitsFor: () => sharedLimits,
  });
  const second = new SqliteBudgetLedger(fixture.database, {
    limitsFor: () => sharedLimits,
  });
  try {
    assert.equal(first.snapshot("run_shared").effective.toolCalls, 0);
    second.reserve({
      scopeId: "run_shared",
      reservationId: "tool_external",
      kind: "tool",
      estimate: { artifactBytes: 3 },
      occurredAt: "2026-07-12T00:00:00.000Z",
      idempotencyKey: "reserve:external",
    });
    const local = first.reserve({
      scopeId: "run_shared",
      reservationId: "tool_local",
      kind: "tool",
      estimate: { artifactBytes: 4 },
      occurredAt: "2026-07-12T00:00:01.000Z",
      idempotencyKey: "reserve:local",
    });
    assert.equal(
      first.events("run_shared").find((event) => event.eventId === local.eventId)?.sequence,
      local.sequence,
    );
    assert.throws(
      () => first.reserve({
        scopeId: "run_shared",
        reservationId: "tool_over_limit",
        kind: "tool",
        estimate: {},
        occurredAt: "2026-07-12T00:00:02.000Z",
        idempotencyKey: "reserve:over-limit",
      }),
      (error: unknown) =>
        error instanceof BudgetExceededError && error.dimension === "toolCalls",
    );

    const exposed = first.snapshot("run_shared");
    exposed.effective.toolCalls = 999;
    exposed.reservations.tool_external.estimate.artifactBytes = 999;
    const fresh = first.snapshot("run_shared");
    assert.equal(fresh.effective.toolCalls, 2);
    assert.equal(fresh.effective.artifactBytes, 7);
    assert.equal(fresh.reservations.tool_external.estimate.artifactBytes, 3);
  } finally {
    first.close();
    second.close();
    fixture.cleanup();
  }
});

test("a rolled-back projection mutation is discarded before the next append", () => {
  const fixture = budgetFixture();
  let ledger = new SqliteBudgetLedger(fixture.database, {
    limitsFor: () => ({}),
  });
  try {
    ledger.reserve({
      scopeId: "run_rollback",
      reservationId: "tool_1",
      kind: "tool",
      estimate: { artifactBytes: 1 },
      occurredAt: "2026-07-12T00:00:00.000Z",
      idempotencyKey: "reserve:tool-1",
    });
    assert.throws(
      () => ledger.reserve({
        scopeId: "run_rollback",
        reservationId: "tool_1",
        kind: "tool",
        estimate: { artifactBytes: 2 },
        occurredAt: "2026-07-12T00:00:01.000Z",
        idempotencyKey: "reserve:duplicate-reservation",
      }),
      /duplicate budget reservation/i,
    );
    ledger.reserve({
      scopeId: "run_rollback",
      reservationId: "tool_2",
      kind: "tool",
      estimate: { artifactBytes: 3 },
      occurredAt: "2026-07-12T00:00:02.000Z",
      idempotencyKey: "reserve:tool-2",
    });
    const beforeRestart = ledger.snapshot("run_rollback");
    ledger.close();

    ledger = new SqliteBudgetLedger(fixture.database, {
      limitsFor: () => ({}),
    });
    assert.deepEqual(ledger.snapshot("run_rollback"), beforeRestart);
    assert.equal(ledger.events("run_rollback").length, 2);
  } finally {
    ledger.close();
    fixture.cleanup();
  }
});

function modelAttribution(sessionId: string) {
  return {
    runtimeId: "runtime_test",
    providerId: "provider_test",
    modelId: "model_test",
    role: "worker" as const,
    sessionId,
    taskId: "task_test",
  };
}

function budgetFixture() {
  const root = mkdtempSync(join(tmpdir(), "aiboard-budget-ledger-"));
  return {
    database: join(root, "budget.sqlite"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
