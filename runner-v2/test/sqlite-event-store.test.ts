import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { NewRunEvent, RunEventType } from "../src/contracts.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";

function newEvent(
  runId: string,
  idempotencyKey: string,
  type: RunEventType = "run.created"
): NewRunEvent {
  return {
    runId,
    type,
    occurredAt: "2026-07-11T00:00:00.000Z",
    actor: { kind: "runner", id: "runner-v2-test" },
    idempotencyKey,
    payload: {},
  };
}

test("append assigns monotonic sequences and deduplicates idempotency keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-runner-v2-events-"));
  const databasePath = join(directory, "events.sqlite");
  const store = new SqliteEventStore(databasePath);

  try {
    const first = store.append(newEvent("run_1", "create:run_1"));
    const duplicate = store.append(newEvent("run_1", "create:run_1"));
    const second = store.append(
      newEvent("run_1", "start:run_1", "run.started")
    );

    assert.equal(first.sequence, 1);
    assert.equal(duplicate.eventId, first.eventId);
    assert.equal(second.sequence, 2);
    assert.deepEqual(
      store.readRun("run_1").map((event) => event.sequence),
      [1, 2]
    );
    assert.deepEqual(
      store.readRun("run_1", 1).map((event) => event.sequence),
      [2]
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("corrupt persisted JSON identifies the affected event", () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-runner-v2-corrupt-"));
  const databasePath = join(directory, "events.sqlite");
  const store = new SqliteEventStore(databasePath);
  const event = store.append(newEvent("run_1", "create:run_1"));
  store.close();

  const database = new DatabaseSync(databasePath);
  database
    .prepare("UPDATE run_events SET actor_json = ? WHERE event_id = ?")
    .run("{", event.eventId);
  database.close();

  const reopened = new SqliteEventStore(databasePath);
  try {
    assert.throws(() => reopened.readRun("run_1"), new RegExp(event.eventId));
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reopen preserves events and each run has an independent sequence", () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-runner-v2-reopen-"));
  const databasePath = join(directory, "events.sqlite");
  const firstStore = new SqliteEventStore(databasePath);
  firstStore.append(newEvent("run_1", "create:run_1"));
  firstStore.append(newEvent("run_2", "create:run_2"));
  firstStore.close();

  const reopened = new SqliteEventStore(databasePath);
  try {
    assert.equal(reopened.readRun("run_1")[0]?.sequence, 1);
    assert.equal(reopened.readRun("run_2")[0]?.sequence, 1);
    assert.deepEqual(reopened.listRunIds(), ["run_1", "run_2"]);
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
