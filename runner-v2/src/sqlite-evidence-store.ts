import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AgentActor } from "./agent-contracts.js";
import {
  evidenceFactArtifactHashes,
  type EvidenceFact,
  type EvidenceRecord,
  type EvidenceStore,
  type GetEvidenceByIdsInput,
  type ListEvidenceInput,
  type RecordEvidenceInput,
} from "./evidence-store.js";

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

export class SqliteEvidenceStore implements EvidenceStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
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
    `);
    const columns = this.database
      .prepare("PRAGMA table_info(evidence_records)")
      .all() as Array<{ name?: unknown }>;
    if (!columns.some((column) => column.name === "attempt")) {
      this.database.exec("ALTER TABLE evidence_records ADD COLUMN attempt INTEGER");
    }
  }

  record(input: RecordEvidenceInput): EvidenceRecord {
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
          `SELECT evidence_id, run_id, task_id, actor_json, fact_json,
                  created_at, idempotency_key, attempt
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
            `SELECT evidence_id, run_id, task_id, actor_json, fact_json,
                    created_at, idempotency_key, attempt
             FROM evidence_records WHERE run_id = ? AND task_id = ?
             ORDER BY sequence LIMIT ?`
          )
          .all(input.runId, input.taskId, limit)
      : this.database
          .prepare(
            `SELECT evidence_id, run_id, task_id, actor_json, fact_json,
                    created_at, idempotency_key, attempt
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
          `SELECT evidence_id, run_id, task_id, actor_json, fact_json,
                  created_at, idempotency_key, attempt
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

  close(): void {
    this.database.close();
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
