import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  cloneBuildSpec,
  validateBuildSpec,
  type BuildSpecStore,
  type NativeBuildSpec,
} from "./build-spec.js";

interface SpecRow {
  run_id: string;
  idempotency_key: string;
  spec_json: string;
}

export class SqliteBuildSpecStore implements BuildSpecStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS build_specs (
        run_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        spec_json TEXT NOT NULL
      );
    `);
  }

  save(spec: NativeBuildSpec): NativeBuildSpec {
    validateBuildSpec(spec);
    const normalized = cloneBuildSpec(spec);
    const specJson = JSON.stringify(normalized);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare("SELECT run_id, idempotency_key, spec_json FROM build_specs WHERE run_id = ?")
        .get(spec.runId) as SpecRow | undefined;
      if (existing) {
        if (
          existing.idempotency_key !== spec.idempotencyKey ||
          existing.spec_json !== specJson
        ) throw new Error(`Build spec idempotency conflict for ${spec.runId}.`);
        this.database.exec("COMMIT");
        return decode(existing);
      }
      this.database
        .prepare("INSERT INTO build_specs (run_id, idempotency_key, spec_json) VALUES (?, ?, ?)")
        .run(spec.runId, spec.idempotencyKey, specJson);
      this.database.exec("COMMIT");
      return normalized;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  get(runId: string): NativeBuildSpec {
    const row = this.database
      .prepare("SELECT run_id, idempotency_key, spec_json FROM build_specs WHERE run_id = ?")
      .get(runId) as SpecRow | undefined;
    if (!row) throw new Error(`Unknown Build spec ${runId}.`);
    return decode(row);
  }

  list(): NativeBuildSpec[] {
    return (
      this.database
        .prepare("SELECT run_id, idempotency_key, spec_json FROM build_specs ORDER BY rowid")
        .all() as unknown as SpecRow[]
    ).map(decode);
  }

  close(): void {
    this.database.close();
  }
}

function decode(row: SpecRow): NativeBuildSpec {
  const spec = JSON.parse(row.spec_json) as NativeBuildSpec;
  validateBuildSpec(spec);
  return cloneBuildSpec(spec);
}
