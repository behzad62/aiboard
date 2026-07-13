import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  cloneBuildSpec,
  recoverLegacyBuildSpec,
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
    this.migrateLegacySpecs();
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

  private migrateLegacySpecs(): void {
    const rows = this.database
      .prepare("SELECT run_id, idempotency_key, spec_json FROM build_specs ORDER BY rowid")
      .all() as unknown as SpecRow[];
    const legacy = rows.filter((row) => {
      const parsed = JSON.parse(row.spec_json) as { runPolicy?: unknown };
      return parsed.runPolicy === undefined;
    });
    if (legacy.length === 0) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const update = this.database.prepare(
        "UPDATE build_specs SET spec_json = ? WHERE run_id = ? AND spec_json = ?"
      );
      for (const row of legacy) {
        const stored = JSON.parse(row.spec_json) as Omit<NativeBuildSpec, "runPolicy">;
        const migrated = recoverLegacyBuildSpec(stored);
        const result = update.run(JSON.stringify(migrated), row.run_id, row.spec_json);
        if (result.changes !== 1) {
          throw new Error(`Build spec migration conflict for ${row.run_id}.`);
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function decode(row: SpecRow): NativeBuildSpec {
  const stored = JSON.parse(row.spec_json) as Omit<
    NativeBuildSpec,
    "runPolicy"
  > & { runPolicy?: NativeBuildSpec["runPolicy"] };
  if (stored.runPolicy === undefined) {
    return cloneBuildSpec(recoverLegacyBuildSpec(stored));
  }
  const spec = stored as NativeBuildSpec;
  validateBuildSpec(spec);
  return cloneBuildSpec(spec);
}
