import { createHmac, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const STATES = "'queued', 'awaiting_approval', 'running', 'completed', 'failed', 'cancelled', 'outcome_unknown', 'blocked_policy', 'blocked_quota'";
const TERMINAL = "'completed', 'failed', 'cancelled', 'outcome_unknown', 'blocked_policy', 'blocked_quota'";

function jobsTable(name: "remote_jobs" | "remote_jobs_v2"): string {
  return `CREATE TABLE ${name} (
    job_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, client_id TEXT NOT NULL, device_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, payload_digest TEXT NOT NULL, protocol_version TEXT NOT NULL,
    tool_id TEXT NOT NULL, operation_class TEXT NOT NULL, scope_ref TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (${STATES})),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, trace_id TEXT NOT NULL,
    dispatching INTEGER NOT NULL CHECK (dispatching IN (0, 1)),
    last_sequence INTEGER NOT NULL CHECK (last_sequence > 0),
    request_iv BLOB, request_tag BLOB, request_ciphertext BLOB,
    result_expires_at TEXT, result_expired INTEGER NOT NULL DEFAULT 0 CHECK (result_expired IN (0, 1)),
    output_ref TEXT, result_iv BLOB, result_tag BLOB, result_ciphertext BLOB,
    reconciliation_evidence TEXT,
    CHECK ((state = 'running' AND dispatching = 1) OR (state != 'running' AND dispatching = 0)),
    CHECK ((request_iv IS NULL AND request_tag IS NULL AND request_ciphertext IS NULL) OR
           (state IN ('queued', 'awaiting_approval') AND request_iv IS NOT NULL AND request_tag IS NOT NULL AND request_ciphertext IS NOT NULL)),
    CHECK ((result_iv IS NULL AND result_tag IS NULL AND result_ciphertext IS NULL) OR
           (result_iv IS NOT NULL AND result_tag IS NOT NULL AND result_ciphertext IS NOT NULL)),
    CHECK (result_expired = 0 OR (output_ref IS NULL AND result_iv IS NULL AND result_tag IS NULL AND result_ciphertext IS NULL)),
    UNIQUE (account_id, client_id, device_id, idempotency_key)
  )`;
}

function eventsTable(name: "remote_job_events" | "remote_job_events_v2", jobs: "remote_jobs" | "remote_jobs_v2"): string {
  return `CREATE TABLE ${name} (
    job_id TEXT NOT NULL REFERENCES ${jobs}(job_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0), occurred_at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('state_changed', 'cancel_requested', 'stopped', 'effect_outcome_unknown', 'result_expired', 'reconciled')),
    state TEXT NOT NULL CHECK (state IN (${STATES})), trace_id TEXT NOT NULL, cancellation_json TEXT,
    PRIMARY KEY (job_id, sequence)
  )`;
}

function auxiliaryTables(database: DatabaseSync): void {
  // Receipts survive job pruning; the store authorizes them through the retained tombstone.
  database.exec(`
    CREATE TABLE remote_job_cancellations (
      job_id TEXT NOT NULL,
      cancel_request_id TEXT NOT NULL, trace_id TEXT NOT NULL, requested_at TEXT NOT NULL,
      stop TEXT NOT NULL CHECK (stop IN ('pending', 'stopped', 'unverified', 'not_applicable')),
      effect TEXT NOT NULL CHECK (effect IN ('pending', 'no_effect', 'known', 'effect_outcome_unknown')),
      receipt_stop TEXT NOT NULL CHECK (receipt_stop IN ('pending', 'stopped', 'unverified', 'not_applicable')),
      receipt_effect TEXT NOT NULL CHECK (receipt_effect IN ('pending', 'no_effect', 'known', 'effect_outcome_unknown')),
      PRIMARY KEY (job_id, cancel_request_id), UNIQUE (job_id)
    );
    CREATE TABLE remote_job_tombstones (
      account_id TEXT NOT NULL, client_id TEXT NOT NULL, device_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, payload_digest TEXT NOT NULL, job_id TEXT NOT NULL UNIQUE,
      outcome TEXT NOT NULL CHECK (outcome IN (${TERMINAL})),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, result_expires_at TEXT,
      result_expired INTEGER NOT NULL DEFAULT 0 CHECK (result_expired IN (0, 1)),
      PRIMARY KEY (account_id, client_id, device_id, idempotency_key)
    );
    CREATE TRIGGER remote_job_transition_guard BEFORE UPDATE OF state ON remote_jobs
    WHEN OLD.state != NEW.state AND NOT (
      (OLD.state = 'queued' AND NEW.state IN ('awaiting_approval', 'running', 'cancelled', 'blocked_policy', 'blocked_quota')) OR
      (OLD.state = 'awaiting_approval' AND NEW.state IN ('queued', 'cancelled', 'blocked_policy')) OR
      (OLD.state = 'running' AND NEW.state IN ('completed', 'failed', 'cancelled', 'outcome_unknown')) OR
      (OLD.state = 'outcome_unknown' AND NEW.state IN ('completed', 'failed') AND
       NEW.reconciliation_evidence IS NOT NULL AND length(trim(NEW.reconciliation_evidence)) > 0)
    ) BEGIN SELECT RAISE(ABORT, 'invalid remote job transition'); END;
  `);
}

/** The old tables, their events, the key check and the version change commit together. */
export function initializeRemoteAdmissionSchema(database: DatabaseSync, key: Uint8Array, resultTtlMs: number): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const hasTable = (name: string) => !!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    const hasJobs = hasTable("remote_jobs");
    const hasMetadata = hasTable("remote_store_metadata");
    if (!hasMetadata && hasJobs) throw new Error("Missing remote store metadata.");
    if (!hasMetadata) database.exec("CREATE TABLE remote_store_metadata (name TEXT PRIMARY KEY, value BLOB NOT NULL)");
    const check = createHmac("sha256", key).update("remote-admission-key-check-v1").digest();
    const stored = database.prepare("SELECT value FROM remote_store_metadata WHERE name = 'key_check'").get() as { value: Uint8Array } | undefined;
    if (stored && (!(stored.value instanceof Uint8Array) || stored.value.byteLength !== check.byteLength || !timingSafeEqual(stored.value, check))) {
      throw new Error("Remote admission storage key does not match.");
    }
    if (!stored) {
      if (hasJobs) throw new Error("Missing remote admission storage key check.");
      database.prepare("INSERT INTO remote_store_metadata (name, value) VALUES ('key_check', ?)").run(check);
    }
    const versionRow = database.prepare("SELECT CAST(value AS TEXT) AS value FROM remote_store_metadata WHERE name = 'schema_version'").get() as { value: string } | undefined;
    const version = versionRow?.value ?? (hasJobs ? "1" : "0");
    if (version === "0") {
      if (hasJobs) throw new Error("Invalid fresh remote store.");
      database.exec(`CREATE TABLE remote_device_epochs (
        account_id TEXT NOT NULL, device_id TEXT NOT NULL, epoch TEXT NOT NULL, PRIMARY KEY (account_id, device_id)
      )`);
      database.exec(jobsTable("remote_jobs"));
      database.exec(eventsTable("remote_job_events", "remote_jobs"));
      auxiliaryTables(database);
    } else if (version === "1") {
      if (!hasJobs || !hasTable("remote_job_events") || !hasTable("remote_device_epochs")) throw new Error("Incomplete v1 remote store.");
      const invalidJournal = database.prepare(`SELECT j.job_id FROM remote_jobs j LEFT JOIN remote_job_events e ON e.job_id = j.job_id
        GROUP BY j.job_id HAVING COUNT(e.sequence) != j.last_sequence OR MIN(e.sequence) != 1 OR MAX(e.sequence) != j.last_sequence LIMIT 1`).get();
      if (invalidJournal) throw new Error("Invalid v1 remote job journal.");
      database.exec(jobsTable("remote_jobs_v2"));
      database.exec(eventsTable("remote_job_events_v2", "remote_jobs_v2"));
      database.exec(`INSERT INTO remote_jobs_v2 (job_id, account_id, client_id, device_id, idempotency_key,
        payload_digest, protocol_version, tool_id, operation_class, scope_ref, state, created_at, updated_at,
        trace_id, dispatching, last_sequence, request_iv, request_tag, request_ciphertext)
        SELECT job_id, account_id, client_id, device_id, idempotency_key, payload_digest, protocol_version,
          tool_id, operation_class, scope_ref, state, created_at, updated_at, trace_id, dispatching, last_sequence,
          CASE WHEN state = 'queued' THEN request_iv END, CASE WHEN state = 'queued' THEN request_tag END,
          CASE WHEN state = 'queued' THEN request_ciphertext END FROM remote_jobs;
        INSERT INTO remote_job_events_v2 (job_id, sequence, occurred_at, kind, state, trace_id)
        SELECT job_id, sequence, occurred_at, kind, state, trace_id FROM remote_job_events;
        DROP TABLE remote_job_events;
        DROP TABLE remote_jobs;
        ALTER TABLE remote_jobs_v2 RENAME TO remote_jobs;
        ALTER TABLE remote_job_events_v2 RENAME TO remote_job_events;`);
      auxiliaryTables(database);
      const terminals = database.prepare(`SELECT job_id, updated_at FROM remote_jobs WHERE state IN (${TERMINAL})`).all() as unknown as { job_id: string; updated_at: string }[];
      const update = database.prepare("UPDATE remote_jobs SET result_expires_at = ? WHERE job_id = ?");
      for (const row of terminals) update.run(new Date(Date.parse(row.updated_at) + resultTtlMs).toISOString(), row.job_id);
      database.exec(`INSERT INTO remote_job_tombstones (account_id, client_id, device_id, idempotency_key,
        payload_digest, job_id, outcome, created_at, updated_at, result_expires_at)
        SELECT account_id, client_id, device_id, idempotency_key, payload_digest, job_id, state,
          created_at, updated_at, result_expires_at FROM remote_jobs WHERE state IN (${TERMINAL})`);
    } else if (version === "2") {
      for (const name of ["remote_jobs", "remote_job_events", "remote_job_cancellations", "remote_job_tombstones", "remote_device_epochs"]) {
        if (!hasTable(name)) throw new Error("Incomplete v2 remote store: " + name);
      }
      if (!database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'remote_job_transition_guard'").get()) {
        throw new Error("Missing remote job transition guard.");
      }
    } else throw new Error("Unsupported remote store schema version.");
    // The exact Runner-issued process link outlives result retention.
    database.exec(`CREATE TABLE IF NOT EXISTS remote_job_processes (
      job_id TEXT PRIMARY KEY REFERENCES remote_jobs(job_id) ON DELETE RESTRICT,
      process_id TEXT NOT NULL
    )`);
    database.exec(`CREATE TABLE IF NOT EXISTS remote_job_policy_fences (
      job_id TEXT PRIMARY KEY REFERENCES remote_jobs(job_id) ON DELETE CASCADE,
      narrowed_at TEXT
    )`);
    database.prepare(`INSERT INTO remote_store_metadata (name, value) VALUES ('schema_version', '2')
      ON CONFLICT(name) DO UPDATE SET value = excluded.value`).run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
