import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";

interface RawEvidenceRow {
  id: string;
  fact: Record<string, unknown>;
}

test("raw pre-P1 evidence WAL fixtures migrate and preserve rows through exact lookup and reopens", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-evidence-pre-p1-wal-"));
  const database = join(root, "evidence.sqlite");
  const wal = `${database}-wal`;
  const runId = "run_raw_evidence";
  const taskId = "task_raw_evidence";
  const fixture = createRawEvidenceFixture(database, runId, taskId);
  let store: SqliteEvidenceStore | undefined;
  try {
    assert.equal(existsSync(wal), true, "raw fixture must retain its WAL sidecar");
    assert.equal(hasAttemptColumn(fixture.raw), false, "fixture must use the pre-P1 schema");

    store = new SqliteEvidenceStore(database);
    assert.equal(hasAttemptColumn(fixture.raw), true, "current store must migrate attempt");
    const legacyRows = store.list({ runId, taskId });
    assert.deepEqual(legacyRows.map((row) => row.id), fixture.rows.map((row) => row.id));
    assert.deepEqual(legacyRows.map((row) => row.fact), fixture.rows.map((row) => row.fact));
    assert.deepEqual(legacyRows.map((row) => row.attempt), [undefined, undefined]);
    assert.equal("attempt" in legacyRows[0], false, "legacy rows keep the nullable default semantics");

    assert.deepEqual(
      store.getByIds({
        runId,
        taskId,
        ids: [fixture.rows[1].id, "evidence_missing", fixture.rows[0].id, fixture.rows[1].id],
      }).map((row) => row.id),
      [fixture.rows[1].id, fixture.rows[0].id, fixture.rows[1].id],
    );

    const migratedRecord = store.record({
      runId,
      taskId,
      actor: { role: "worker", id: "worker_current" },
      fact: {
        kind: "browser_screenshot",
        label: "current evidence",
        capturedAt: "2026-08-26T00:00:02.000Z",
        screenshotArtifactHash: "c".repeat(64),
        mediaType: "image/png",
        byteLength: 3,
      },
      createdAt: "2026-08-26T00:00:02.000Z",
      idempotencyKey: "evidence-current",
      attempt: 2,
    });
    const beforeReopen = store.list({ runId, taskId });
    assert.deepEqual(beforeReopen.map((row) => row.id), [
      fixture.rows[0].id,
      fixture.rows[1].id,
      migratedRecord.id,
    ]);
    assert.equal(beforeReopen[2].attempt, 2);
    assert.equal(existsSync(wal), true, "WAL sidecar must remain through migration and append");

    store.close();
    store = undefined;
    assert.equal(existsSync(wal), true, "raw connection must keep WAL present for reopen");
    store = new SqliteEvidenceStore(database);
    assert.deepEqual(store.list({ runId, taskId }), beforeReopen);
    store.close();
    store = undefined;

    store = new SqliteEvidenceStore(database);
    assert.deepEqual(store.list({ runId, taskId }), beforeReopen);
  } finally {
    store?.close();
    fixture.raw.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("read-only legacy evidence omits a pre-attempt column without modifying durable bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-evidence-read-only-legacy-"));
  const database = join(root, "evidence.sqlite");
  const raw = new DatabaseSync(database);
  let store: SqliteEvidenceStore | undefined;
  try {
    raw.exec(`
      CREATE TABLE evidence_records (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        evidence_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        fact_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        UNIQUE(run_id, idempotency_key)
      );
    `);
    raw.prepare(`
      INSERT INTO evidence_records (
        evidence_id, run_id, task_id, actor_json, fact_json, created_at, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy_evidence",
      "run_legacy",
      "task_legacy",
      JSON.stringify({ role: "worker", id: "worker_legacy" }),
      JSON.stringify({
        kind: "browser_screenshot",
        label: "Legacy screenshot",
        capturedAt: "2026-08-28T00:00:00.000Z",
        screenshotArtifactHash: "a".repeat(64),
        mediaType: "image/png",
        byteLength: 1,
      }),
      "2026-08-28T00:00:00.000Z",
      "legacy-evidence",
    );
    raw.close();
    const beforeBytes = readFileSync(database);
    const beforeMtime = statSync(database).mtimeMs;

    store = new SqliteEvidenceStore(database, { readOnly: true });
    assert.deepEqual(store.list({ runId: "run_legacy" }), [
      {
        id: "legacy_evidence",
        runId: "run_legacy",
        taskId: "task_legacy",
        actor: { role: "worker", id: "worker_legacy" },
        status: "observed",
        fact: {
          kind: "browser_screenshot",
          label: "Legacy screenshot",
          capturedAt: "2026-08-28T00:00:00.000Z",
          screenshotArtifactHash: "a".repeat(64),
          mediaType: "image/png",
          byteLength: 1,
        },
        createdAt: "2026-08-28T00:00:00.000Z",
        idempotencyKey: "legacy-evidence",
      },
    ]);
    store.close();
    store = undefined;
    assert.deepEqual(readFileSync(database), beforeBytes);
    assert.equal(statSync(database).mtimeMs, beforeMtime);
    const check = new DatabaseSync(database, { readOnly: true });
    try {
      assert.equal(hasAttemptColumn(check), false);
    } finally {
      check.close();
    }
  } finally {
    store?.close();
    try {
      raw.close();
    } catch {
      // The fixture may already be closed before the read-only check.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw pre-P1 evidence migration rolls back after failure before commit and recovers", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-evidence-pre-p1-rollback-"));
  const database = join(root, "evidence.sqlite");
  const runId = "run_raw_rollback";
  const taskId = "task_raw_rollback";
  const fixture = createRawEvidenceFixture(database, runId, taskId);
  let rawClosed = false;
  try {
    assert.equal(existsSync(`${database}-wal`), true);
    const originalExec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string): void {
      if (sql.trim() === "ALTER TABLE evidence_records ADD COLUMN attempt INTEGER") {
        originalExec.call(this, sql);
        this.close();
        throw new Error("injected evidence migration failure");
      }
      originalExec.call(this, sql);
    };
    try {
      assert.throws(
        () => new SqliteEvidenceStore(database),
        /injected evidence migration failure/,
      );
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }

    fixture.raw.close();
    rawClosed = true;
    const afterFailure = new DatabaseSync(database);
    try {
      assert.equal(
        hasAttemptColumn(afterFailure),
        false,
        "failed migration must leave the legacy schema unchanged",
      );
      const preserved = afterFailure
        .prepare("SELECT evidence_id FROM evidence_records ORDER BY sequence")
        .all() as Array<{ evidence_id?: unknown }>;
      assert.deepEqual(preserved.map((row) => row.evidence_id), fixture.rows.map((row) => row.id));
    } finally {
      afterFailure.close();
    }

    const recovered = new SqliteEvidenceStore(database);
    try {
      assert.deepEqual(
        recovered.list({ runId, taskId }).map((row) => row.id),
        fixture.rows.map((row) => row.id),
      );
      assert.deepEqual(
        recovered.list({ runId, taskId }).map((row) => row.attempt),
        [undefined, undefined],
      );
    } finally {
      recovered.close();
    }
    const migratedSchema = new DatabaseSync(database);
    try {
      assert.equal(hasAttemptColumn(migratedSchema), true);
    } finally {
      migratedSchema.close();
    }
    const reopened = new SqliteEvidenceStore(database);
    try {
      assert.deepEqual(
        reopened.list({ runId, taskId }).map((row) => row.id),
        fixture.rows.map((row) => row.id),
      );
    } finally {
      reopened.close();
    }
  } finally {
    if (!rawClosed) fixture.raw.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function createRawEvidenceFixture(
  database: string,
  runId: string,
  taskId: string,
): { raw: DatabaseSync; rows: RawEvidenceRow[] } {
  const raw = new DatabaseSync(database);
  raw.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE evidence_records (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      evidence_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      fact_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      UNIQUE(run_id, idempotency_key)
    );
    CREATE INDEX idx_evidence_run_task
    ON evidence_records(run_id, task_id, sequence);
  `);
  const rows: RawEvidenceRow[] = [
    {
      id: "legacy_evidence_1",
      fact: {
        kind: "browser_screenshot",
        label: "legacy first",
        capturedAt: "2026-08-26T00:00:00.000Z",
        screenshotArtifactHash: "a".repeat(64),
        mediaType: "image/png",
        byteLength: 1,
      },
    },
    {
      id: "legacy_evidence_2",
      fact: {
        kind: "browser_screenshot",
        label: "legacy second",
        capturedAt: "2026-08-26T00:00:01.000Z",
        screenshotArtifactHash: "b".repeat(64),
        mediaType: "image/png",
        byteLength: 2,
      },
    },
  ];
  const insert = raw.prepare(`
    INSERT INTO evidence_records (
      evidence_id, run_id, task_id, actor_json, fact_json,
      created_at, idempotency_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  rows.forEach((row, index) => {
    insert.run(
      row.id,
      runId,
      taskId,
      JSON.stringify({ role: "worker", id: "legacy-worker" }),
      JSON.stringify(row.fact),
      `2026-08-26T00:00:0${index}.000Z`,
      `legacy-evidence-${index + 1}`,
    );
  });
  return { raw, rows };
}

function hasAttemptColumn(database: DatabaseSync): boolean {
  return (database.prepare("PRAGMA table_info(evidence_records)").all() as Array<{ name?: unknown }>)
    .some((column) => column.name === "attempt");
}
