import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  parseContextManifestPayload,
  toContextManifest,
  type ContextManifest,
  type ContextManifestInput,
  type ContextManifestStore,
} from "./context-manifest-store.js";

export interface SqliteContextManifestStoreOptions {
  /** Opens an existing durable ledger without schema or journal mutations. */
  readOnly?: boolean;
}

export class SqliteContextManifestStore implements ContextManifestStore {
  private readonly database: DatabaseSync;
  private readonly readOnly: boolean;

  constructor(databasePath: string, options: SqliteContextManifestStoreOptions = {}) {
    this.readOnly = options.readOnly ?? false;
    if (!this.readOnly) mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath, { readOnly: this.readOnly });
    if (this.readOnly) return;
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS context_manifests (
        manifest_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_context_manifests_run ON context_manifests(run_id, recorded_at, manifest_id);
    `);
  }

  record(input: ContextManifestInput): ContextManifest {
    if (this.readOnly) {
      throw new Error("Context manifest store is read-only.");
    }
    const manifest = toContextManifest(input);
    this.database
      .prepare(
        `INSERT OR IGNORE INTO context_manifests (
          manifest_id, run_id, session_id, recorded_at, payload_json
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        manifest.manifestId,
        manifest.runId,
        manifest.sessionId,
        manifest.recordedAt,
        JSON.stringify(manifest)
      );
    const stored = this.get(manifest.manifestId);
    if (!stored) {
      throw new Error(`Context manifest ${manifest.manifestId} was not stored.`);
    }
    return stored;
  }

  get(manifestId: string): ContextManifest | undefined {
    const row = this.database
      .prepare(
        `SELECT payload_json FROM context_manifests WHERE manifest_id = ?`
      )
      .get(manifestId) as { payload_json: string } | undefined;
    if (!row) return undefined;
    return parseContextManifestPayload(row.payload_json, manifestId);
  }

  listRun(runId: string): ContextManifest[] {
    const rows = this.database
      .prepare(
        `SELECT manifest_id, payload_json FROM context_manifests
         WHERE run_id = ? ORDER BY recorded_at ASC, manifest_id ASC`
      )
      .all(runId) as { manifest_id: string; payload_json: string }[];
    return rows.map((row) => parseContextManifestPayload(row.payload_json, row.manifest_id));
  }

  close(): void {
    this.database.close();
  }
}
