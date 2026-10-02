import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AgentActor } from "./agent-contracts.js";
import type { HistoricalReadProvenance } from "./historical-read-provenance.js";
import {
  evidenceFactArtifactHashes,
  type EvidenceFact,
  type EvidenceRecord,
  type ExtendedEvidenceStore,
  type GetEvidenceByIdsInput,
  type ListApplicabilityInput,
  type ListEvidenceInput,
  type ListObservationsInput,
  type RecordApplicabilityInput,
  type RecordEvidenceInput,
  type RecordObservationInput,
  type StoredApplicabilityDecision,
  type StoredValidationObservation,
} from "./evidence-store.js";
import {
  validateEvidenceApplicabilityDecision,
  validateValidationObservation,
} from "./planning-contracts.js";

interface EvidenceRow {
  evidence_id: string;
  run_id: string;
  task_id: string;
  actor_json: string;
  fact_json: string;
  created_at: string;
  idempotency_key: string;
  attempt: number | null;
}

interface ObservationRow {
  observation_id: string;
  run_id: string;
  observation_json: string;
  created_at: string;
  idempotency_key: string;
  capability_fingerprint?: string | null;
  artifact_hashes_json?: string | null;
  uncommitted_digest?: string | null;
  skip_rationale?: string | null;
}

interface ApplicabilityRow {
  decision_id: string;
  run_id: string;
  decision_json: string;
  created_at: string;
  idempotency_key: string;
}

export interface SqliteEvidenceStoreOptions {
  /** Opens an existing durable store without schema or migration writes. */
  readOnly?: boolean;
}

export class SqliteEvidenceStore implements ExtendedEvidenceStore {
  private readonly database: DatabaseSync;
  private readonly readOnly: boolean;

  constructor(databasePath: string, options: SqliteEvidenceStoreOptions = {}) {
    this.readOnly = options.readOnly ?? false;
    if (!this.readOnly) mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath, { readOnly: this.readOnly });
    if (this.readOnly) return;
    try {
      this.database.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS evidence_records (
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
        CREATE INDEX IF NOT EXISTS idx_evidence_run_task
        ON evidence_records(run_id, task_id, sequence);
        CREATE TABLE IF NOT EXISTS validation_observations (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          observation_id TEXT NOT NULL UNIQUE,
          run_id TEXT NOT NULL,
          observation_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          capability_fingerprint TEXT NOT NULL DEFAULT '',
          artifact_hashes_json TEXT NOT NULL DEFAULT '[]',
          uncommitted_digest TEXT,
          skip_rationale TEXT,
          UNIQUE(run_id, idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS idx_observations_run
        ON validation_observations(run_id, sequence);
        CREATE TABLE IF NOT EXISTS applicability_decisions (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          decision_id TEXT NOT NULL UNIQUE,
          run_id TEXT NOT NULL,
          decision_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          UNIQUE(run_id, idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS idx_applicability_run
        ON applicability_decisions(run_id, sequence);
      `);
      this.migrateAttemptColumn();
      this.migrateObservationEnvelopeColumns();
    } catch (error) {
      try {
        this.database.close();
      } catch {
        // The migration fault may already have closed the handle.
      }
      throw error;
    }
  }

  record(input: RecordEvidenceInput): EvidenceRecord {
    if (this.readOnly) {
      throw new Error("A read-only evidence store cannot record evidence.");
    }
    validate(input);
    const id = `evidence_${createHash("sha256")
      .update(`${input.runId}\0${input.taskId}\0${input.idempotencyKey}`)
      .digest("hex")}`;
    const record: EvidenceRecord = {
      id,
      runId: input.runId,
      taskId: input.taskId,
      actor: { ...input.actor },
      status: "observed",
      fact: cloneFact(input.fact),
      createdAt: input.createdAt,
      idempotencyKey: input.idempotencyKey,
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare(
          `SELECT ${this.selectColumns()}
           FROM evidence_records WHERE run_id = ? AND idempotency_key = ?`
        )
        .get(input.runId, input.idempotencyKey) as EvidenceRow | undefined;
      if (existing) {
        const decoded = decode(existing);
        if (
          decoded.taskId !== record.taskId ||
          decoded.attempt !== record.attempt ||
          JSON.stringify(decoded.actor) !== JSON.stringify(record.actor) ||
          JSON.stringify(decoded.fact) !== JSON.stringify(record.fact)
        ) throw new Error(`Evidence idempotency conflict for ${input.idempotencyKey}.`);
        this.database.exec("COMMIT");
        return decoded;
      }
      this.database
        .prepare(
          `INSERT INTO evidence_records (
            evidence_id, run_id, task_id, actor_json, fact_json,
            created_at, idempotency_key, attempt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.id,
          record.runId,
          record.taskId,
          JSON.stringify(record.actor),
          JSON.stringify(record.fact),
          record.createdAt,
          record.idempotencyKey,
          record.attempt ?? null
        );
      this.database.exec("COMMIT");
      return cloneRecord(record);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  list(input: ListEvidenceInput): EvidenceRecord[] {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Evidence limit must be from 1 to 1000.");
    }
    const rows = input.taskId
      ? this.database
          .prepare(
            `SELECT ${this.selectColumns()}
             FROM evidence_records WHERE run_id = ? AND task_id = ?
             ORDER BY sequence LIMIT ?`
          )
          .all(input.runId, input.taskId, limit)
      : this.database
          .prepare(
            `SELECT ${this.selectColumns()}
             FROM evidence_records WHERE run_id = ?
             ORDER BY sequence LIMIT ?`
          )
          .all(input.runId, limit);
    return (rows as unknown as EvidenceRow[]).map(decode);
  }

  getByIds(input: GetEvidenceByIdsInput): EvidenceRecord[] {
    if (!input.runId || !Array.isArray(input.ids)) {
      throw new Error("Evidence run and IDs are required.");
    }
    if (input.ids.some((id) => typeof id !== "string" || !id.trim())) {
      throw new Error("Evidence IDs must be non-empty strings.");
    }
    if (input.ids.length === 0) return [];
    const byId = new Map<string, EvidenceRecord>();
    const uniqueIds = [...new Set(input.ids)];
    for (let offset = 0; offset < uniqueIds.length; offset += 500) {
      const batch = uniqueIds.slice(offset, offset + 500);
      const placeholders = batch.map(() => "?").join(", ");
      const taskClause = input.taskId === undefined ? "" : " AND task_id = ?";
      const parameters = input.taskId === undefined
        ? [input.runId, ...batch]
        : [input.runId, input.taskId, ...batch];
      const rows = this.database
        .prepare(
          `SELECT ${this.selectColumns()}
           FROM evidence_records
           WHERE run_id = ?${taskClause} AND evidence_id IN (${placeholders})
           ORDER BY sequence`
        )
        .all(...parameters) as unknown as EvidenceRow[];
      for (const row of rows) byId.set(row.evidence_id, decode(row));
    }
    return input.ids.flatMap((id) => {
      const record = byId.get(id);
      return record ? [cloneRecord(record)] : [];
    });
  }

  recordObservation(input: RecordObservationInput): StoredValidationObservation {
    if (this.readOnly) {
      throw new Error("A read-only evidence store cannot record observations.");
    }
    if (!input.runId || !input.idempotencyKey || !input.createdAt) {
      throw new Error("Observation run, idempotency key, and createdAt are required.");
    }
    if (typeof input.capabilityFingerprint !== "string" || !input.capabilityFingerprint.trim()) {
      throw new Error("Observation requires a capabilityFingerprint (acceptance re-runs from durable state).");
    }
    if (!Array.isArray(input.artifactHashes) || input.artifactHashes.length === 0 ||
        input.artifactHashes.some((h) => typeof h !== "string" || !h.trim())) {
      throw new Error("Observation requires at least one artifact hash (substituted-artifact checks need them).");
    }
    const validation = validateValidationObservation(input.observation);
    if (!validation.valid) {
      throw new Error(`Invalid validation observation: ${validation.issues.map((i) => i.message).join(" ")}`);
    }
    if (!this.hasEvidence(input.observation.evidenceId)) {
      throw new Error(`Observation cites non-existent evidence ${input.observation.evidenceId}.`);
    }
    const id = `observation_${createHash("sha256")
      .update(`${input.runId}\0${input.idempotencyKey}`)
      .digest("hex")}`;
    const stored: StoredValidationObservation = {
      id,
      runId: input.runId,
      observation: JSON.parse(JSON.stringify(input.observation)) as StoredValidationObservation["observation"],
      capabilityFingerprint: input.capabilityFingerprint,
      artifactHashes: [...input.artifactHashes],
      ...(input.uncommittedContentDigest !== undefined ? { uncommittedContentDigest: input.uncommittedContentDigest } : {}),
      ...(input.skipRationale !== undefined ? { skipRationale: input.skipRationale } : {}),
      createdAt: input.createdAt,
      idempotencyKey: input.idempotencyKey,
    };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare(
          `SELECT ${this.observationColumns()}
           FROM validation_observations WHERE run_id = ? AND idempotency_key = ?`
        )
        .get(input.runId, input.idempotencyKey) as ObservationRow | undefined;
      if (existing) {
        const decoded = decodeObservation(existing);
        if (JSON.stringify(decoded.observation) !== JSON.stringify(stored.observation) ||
            envelopeJson(decoded) !== envelopeJson(stored)) {
          throw new Error(`Observation idempotency conflict for ${input.idempotencyKey}.`);
        }
        this.database.exec("COMMIT");
        return decoded;
      }
      this.database
        .prepare(
          `INSERT INTO validation_observations (
            observation_id, run_id, observation_json, created_at, idempotency_key,
            capability_fingerprint, artifact_hashes_json, uncommitted_digest, skip_rationale
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          stored.id,
          stored.runId,
          JSON.stringify(stored.observation),
          stored.createdAt,
          stored.idempotencyKey,
          stored.capabilityFingerprint ?? "",
          JSON.stringify(stored.artifactHashes ?? []),
          stored.uncommittedContentDigest ?? null,
          stored.skipRationale ?? null,
        );
      this.database.exec("COMMIT");
      return decodeObservation({
        observation_id: stored.id,
        run_id: stored.runId,
        observation_json: JSON.stringify(stored.observation),
        created_at: stored.createdAt,
        idempotency_key: stored.idempotencyKey,
        capability_fingerprint: stored.capabilityFingerprint ?? null,
        artifact_hashes_json: JSON.stringify(stored.artifactHashes ?? []),
        uncommitted_digest: stored.uncommittedContentDigest ?? null,
        skip_rationale: stored.skipRationale ?? null,
      });
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listObservations(input: ListObservationsInput): StoredValidationObservation[] {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Observation limit must be from 1 to 1000.");
    }
    if (!this.hasTable("validation_observations")) return [];
    const rows = this.database
      .prepare(
        `SELECT ${this.observationColumns()}
         FROM validation_observations WHERE run_id = ?
         ORDER BY sequence LIMIT ?`
      )
      .all(input.runId, limit) as unknown as ObservationRow[];
    return rows.map(decodeObservation);
  }

  recordApplicability(input: RecordApplicabilityInput): StoredApplicabilityDecision {
    if (this.readOnly) {
      throw new Error("A read-only evidence store cannot record applicability decisions.");
    }
    if (!input.runId || !input.idempotencyKey || !input.createdAt) {
      throw new Error("Applicability run, idempotency key, and createdAt are required.");
    }
    const validation = validateEvidenceApplicabilityDecision(input.decision);
    if (!validation.valid) {
      throw new Error(`Invalid applicability decision: ${validation.issues.map((i) => i.message).join(" ")}`);
    }
    const id = `applicability_${createHash("sha256")
      .update(`${input.runId}\0${input.idempotencyKey}`)
      .digest("hex")}`;
    const stored: StoredApplicabilityDecision = {
      id,
      runId: input.runId,
      decision: JSON.parse(JSON.stringify(input.decision)) as StoredApplicabilityDecision["decision"],
      createdAt: input.createdAt,
      idempotencyKey: input.idempotencyKey,
    };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare(
          `SELECT decision_id, run_id, decision_json, created_at, idempotency_key
           FROM applicability_decisions WHERE run_id = ? AND idempotency_key = ?`
        )
        .get(input.runId, input.idempotencyKey) as ApplicabilityRow | undefined;
      if (existing) {
        const decoded = decodeApplicability(existing);
        if (JSON.stringify(decoded.decision) !== JSON.stringify(stored.decision)) {
          throw new Error(`Applicability idempotency conflict for ${input.idempotencyKey}.`);
        }
        this.database.exec("COMMIT");
        return decoded;
      }
      this.database
        .prepare(
          `INSERT INTO applicability_decisions (
            decision_id, run_id, decision_json, created_at, idempotency_key
          ) VALUES (?, ?, ?, ?, ?)`
        )
        .run(stored.id, stored.runId, JSON.stringify(stored.decision), stored.createdAt, stored.idempotencyKey);
      this.database.exec("COMMIT");
      return decodeApplicability({
        decision_id: stored.id,
        run_id: stored.runId,
        decision_json: JSON.stringify(stored.decision),
        created_at: stored.createdAt,
        idempotency_key: stored.idempotencyKey,
      });
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listApplicability(input: ListApplicabilityInput): StoredApplicabilityDecision[] {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Applicability limit must be from 1 to 1000.");
    }
    if (!this.hasTable("applicability_decisions")) return [];
    const rows = this.database
      .prepare(
        `SELECT decision_id, run_id, decision_json, created_at, idempotency_key
         FROM applicability_decisions WHERE run_id = ?
         ORDER BY sequence LIMIT ?`
      )
      .all(input.runId, limit) as unknown as ApplicabilityRow[];
    return rows.map(decodeApplicability);
  }

  close(): void {
    this.database.close();
  }

  historicalProvenance(): HistoricalReadProvenance {
    if (!this.readOnly) return "durable";
    if (!this.hasTable("evidence_records")) return "unavailable";
    return this.hasAttemptColumn() ? "durable" : "legacy_replay";
  }

  /** Envelope columns for legacy DBs created before the T5 repair cycle. */
  private migrateObservationEnvelopeColumns(): void {
    const wanted: ReadonlyArray<readonly [string, string]> = [
      ["capability_fingerprint", "TEXT NOT NULL DEFAULT ''"],
      ["artifact_hashes_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["uncommitted_digest", "TEXT"],
      ["skip_rationale", "TEXT"],
    ];
    for (const [column, type] of wanted) {
      if (this.hasColumn("validation_observations", column)) continue;
      let transactionStarted = false;
      try {
        this.database.exec("BEGIN IMMEDIATE");
        transactionStarted = true;
        this.database.exec(`ALTER TABLE validation_observations ADD COLUMN ${column} ${type}`);
        this.database.exec("COMMIT");
        transactionStarted = false;
      } catch (error) {
        if (transactionStarted) {
          try {
            this.database.exec("ROLLBACK");
          } catch {
            // Preserve the original migration failure if the handle is closed.
          }
        }
        throw error;
      }
    }
  }

  /**
   * Observation SELECT list, tolerating legacy read-only DBs whose
   * validation_observations table predates the envelope columns.
   */
  private observationColumns(): string {
    const base = "observation_id, run_id, observation_json, created_at, idempotency_key";
    const extra = ["capability_fingerprint", "artifact_hashes_json", "uncommitted_digest", "skip_rationale"]
      .filter((column) => this.hasColumn("validation_observations", column));
    return [base, ...extra].join(", ");
  }

  private hasEvidence(evidenceId: string): boolean {
    if (!this.hasTable("evidence_records")) return false;
    return Boolean(
      this.database
        .prepare("SELECT 1 FROM evidence_records WHERE evidence_id = ? LIMIT 1")
        .get(evidenceId),
    );
  }

  private migrateAttemptColumn(): void {
    if (this.hasAttemptColumn()) return;

    let transactionStarted = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      this.database.exec("ALTER TABLE evidence_records ADD COLUMN attempt INTEGER");
      this.database.exec("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the original migration failure if the handle is closed.
        }
      }
      throw error;
    }
  }

  private selectColumns(): string {
    return `evidence_id, run_id, task_id, actor_json, fact_json,
            created_at, idempotency_key, ${
              this.hasAttemptColumn() ? "attempt" : "NULL AS attempt"
            }`;
  }

  private hasAttemptColumn(): boolean {
    return (
      this.database
        .prepare("PRAGMA table_info(evidence_records)")
        .all() as Array<{ name?: unknown }>
    ).some((column) => column.name === "attempt");
  }

  private hasColumn(tableName: string, columnName: string): boolean {
    try {
      return (
        this.database
          .prepare(`PRAGMA table_info(${tableName})`)
          .all() as Array<{ name?: unknown }>
      ).some((column) => column.name === columnName);
    } catch {
      return false;
    }
  }

  private hasTable(tableName: string): boolean {
    return Boolean(
      this.database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        )
        .get(tableName),
    );
  }
}

function decode(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.evidence_id,
    runId: row.run_id,
    taskId: row.task_id,
    actor: JSON.parse(row.actor_json) as AgentActor,
    status: "observed",
    fact: JSON.parse(row.fact_json) as EvidenceFact,
    createdAt: row.created_at,
    idempotencyKey: row.idempotency_key,
    ...(row.attempt !== null && row.attempt !== undefined
      ? { attempt: row.attempt }
      : {}),
  };
}

function decodeObservation(row: ObservationRow): StoredValidationObservation {
  const capability = row.capability_fingerprint;
  const hashes = parseStringArray(row.artifact_hashes_json);
  return {
    id: row.observation_id,
    runId: row.run_id,
    observation: JSON.parse(row.observation_json) as StoredValidationObservation["observation"],
    ...(capability !== undefined && capability !== null && capability !== "" ? { capabilityFingerprint: capability } : {}),
    ...(hashes !== undefined ? { artifactHashes: hashes } : {}),
    ...(row.uncommitted_digest !== undefined && row.uncommitted_digest !== null
      ? { uncommittedContentDigest: row.uncommitted_digest }
      : {}),
    ...(row.skip_rationale !== undefined && row.skip_rationale !== null ? { skipRationale: row.skip_rationale } : {}),
    createdAt: row.created_at,
    idempotencyKey: row.idempotency_key,
  };
}

/** Canonical envelope JSON for idempotency comparison (legacy rows: {}). */
function envelopeJson(stored: StoredValidationObservation): string {
  return JSON.stringify({
    capabilityFingerprint: stored.capabilityFingerprint ?? null,
    artifactHashes: stored.artifactHashes ?? null,
    uncommittedContentDigest: stored.uncommittedContentDigest ?? null,
    skipRationale: stored.skipRationale ?? null,
  });
}

function parseStringArray(raw: string | null | undefined): readonly string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? [...parsed] : [];
  } catch {
    return [];
  }
}

function decodeApplicability(row: ApplicabilityRow): StoredApplicabilityDecision {
  return {
    id: row.decision_id,
    runId: row.run_id,
    decision: JSON.parse(row.decision_json) as StoredApplicabilityDecision["decision"],
    createdAt: row.created_at,
    idempotencyKey: row.idempotency_key,
  };
}

function validate(input: RecordEvidenceInput): void {
  if (!input.runId || !input.taskId || !input.idempotencyKey) {
    throw new Error("Evidence run, task, and idempotency key are required.");
  }
  if (
    input.attempt !== undefined &&
    (!Number.isSafeInteger(input.attempt) || input.attempt < 1)
  ) {
    throw new Error("Evidence attempt must be a positive integer.");
  }
  const hashes = evidenceFactArtifactHashes(input.fact);
  for (const hash of hashes) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid evidence artifact ${hash}.`);
  }
}

function cloneFact(fact: EvidenceFact): EvidenceFact {
  return fact.kind === "command"
    ? { ...fact, args: [...fact.args] }
    : { ...fact };
}

function cloneRecord(record: EvidenceRecord): EvidenceRecord {
  return { ...record, actor: { ...record.actor }, fact: cloneFact(record.fact) };
}
