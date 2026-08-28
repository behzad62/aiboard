import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  assertDurableExecutionSafetyValue,
  type ExecutionBackendIdentity,
  type ExecutionSafetyCapabilityName,
  type ProcessBirthFingerprint,
  type ProcessCleanupStatus,
  type ProcessOutputDisposition,
} from "./execution-safety-contracts.js";

export const DURABLE_SUBPROCESS_SCHEMA_VERSION = 1 as const;

export type DurableSubprocessState =
  | "prepared" | "launching" | "running" | "stopping" | "exited"
  | "verifying_empty" | "cleaned" | "launch_not_proven" | "orphaned"
  | "identity_mismatch" | "backend_unavailable" | "outcome_unknown" | "cleanup_blocked";

export interface DurableSubprocessHistoryEntry {
  readonly state: DurableSubprocessState;
  readonly at: string;
  readonly reason?: string;
}

export interface DurableEnvironmentAudit {
  readonly inheritedNames: readonly string[];
  readonly removedNames: readonly string[];
  readonly explicitSafeNames: readonly string[];
  readonly grantedNames: readonly string[];
}

export interface DurableSubprocessResult {
  readonly outcome: "exited" | "timed_out" | "cancelled" | "launch_failed" | "cleanup_failed";
  readonly exitCode?: number;
  readonly signal?: string;
  readonly startedAt?: string;
  readonly finishedAt: string;
}

export interface DurableSubprocessRecord {
  readonly schemaVersion: typeof DURABLE_SUBPROCESS_SCHEMA_VERSION;
  readonly logicalProcessId: string;
  readonly invocationId: string;
  readonly runId: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly state: DurableSubprocessState;
  readonly history: readonly DurableSubprocessHistoryEntry[];
  readonly requiredCapabilities: readonly ExecutionSafetyCapabilityName[];
  readonly environmentAudit: DurableEnvironmentAudit;
  readonly backend?: ExecutionBackendIdentity;
  readonly birthFingerprint?: ProcessBirthFingerprint;
  readonly rootPid?: number;
  readonly output: readonly ProcessOutputDisposition[];
  readonly cleanup: ProcessCleanupStatus;
  readonly result?: DurableSubprocessResult;
}

export type DurableSubprocessPatch = Partial<Pick<
  DurableSubprocessRecord,
  "output" | "cleanup" | "result"
>>;

export interface DurableProcessStore {
  createPrepared(record: DurableSubprocessRecord): DurableSubprocessRecord;
  transition(invocationId: string, state: DurableSubprocessState, at: string, reason?: string, patch?: DurableSubprocessPatch): DurableSubprocessRecord;
  bindLaunch(invocationId: string, binding: ProcessBackendBindingRecord, at: string): DurableSubprocessRecord;
  readByInvocation(invocationId: string): DurableSubprocessRecord | undefined;
  listRecoverable(): DurableSubprocessRecord[];
  close(): void;
}

export interface ProcessBackendBindingRecord {
  readonly backend: ExecutionBackendIdentity;
  readonly birthFingerprint: ProcessBirthFingerprint;
  readonly rootPid?: number;
}

const LEGAL: Readonly<Record<DurableSubprocessState, readonly DurableSubprocessState[]>> = {
  prepared: ["launching", "launch_not_proven"],
  launching: ["running", "launch_not_proven", "orphaned", "identity_mismatch", "backend_unavailable"],
  running: ["stopping", "exited", "identity_mismatch", "backend_unavailable", "outcome_unknown"],
  stopping: ["exited", "identity_mismatch", "backend_unavailable", "outcome_unknown"],
  exited: ["verifying_empty"],
  verifying_empty: ["cleaned", "cleanup_blocked", "backend_unavailable", "outcome_unknown"],
  cleaned: [], launch_not_proven: [], orphaned: [], identity_mismatch: [],
  backend_unavailable: ["running", "exited", "identity_mismatch"],
  outcome_unknown: [], cleanup_blocked: [],
};

export class InMemoryDurableProcessStore implements DurableProcessStore {
  protected readonly records = new Map<string, DurableSubprocessRecord>();
  constructor(initial: readonly DurableSubprocessRecord[] = []) {
    for (const record of initial) this.records.set(record.invocationId, cloneRecord(record));
  }
  createPrepared(record: DurableSubprocessRecord): DurableSubprocessRecord {
    validatePrepared(record);
    const existing = this.records.get(record.invocationId);
    if (existing) {
      if (existing.logicalProcessId !== record.logicalProcessId || existing.runId !== record.runId) throw new Error(`Process idempotency conflict for ${record.invocationId}.`);
      return cloneRecord(existing);
    }
    const saved = cloneRecord(record); this.records.set(record.invocationId, saved); return cloneRecord(saved);
  }
  transition(invocationId: string, state: DurableSubprocessState, at: string, reason?: string, patch: DurableSubprocessPatch = {}): DurableSubprocessRecord {
    const current = requiredRecord(this.records, invocationId);
    const next = transitionRecord(current, state, at, reason, patch);
    this.records.set(invocationId, next); return cloneRecord(next);
  }
  bindLaunch(invocationId: string, binding: ProcessBackendBindingRecord, at: string): DurableSubprocessRecord {
    assertBinding(binding);
    const current = requiredRecord(this.records, invocationId);
    const next = transitionRecord({ ...current, ...cloneBinding(binding) }, "running", at);
    this.records.set(invocationId, next); return cloneRecord(next);
  }
  readByInvocation(invocationId: string): DurableSubprocessRecord | undefined {
    const value = this.records.get(invocationId); return value ? cloneRecord(value) : undefined;
  }
  listRecoverable(): DurableSubprocessRecord[] {
    return [...this.records.values()].filter((record) => !isTerminal(record.state)).map(cloneRecord);
  }
  close(): void {}
}

interface ProcessRow { invocation_id: string; record_json: string }

export class SqliteDurableProcessStore implements DurableProcessStore {
  private readonly database: DatabaseSync;
  private readonly readOnly: boolean;
  constructor(path: string, options: { readonly readOnly?: boolean } = {}) {
    this.readOnly = options.readOnly ?? false;
    if (!this.readOnly) mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path, { readOnly: this.readOnly });
    if (!this.readOnly) this.database.exec(`PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS durable_processes (invocation_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);`);
  }
  createPrepared(record: DurableSubprocessRecord): DurableSubprocessRecord {
    this.assertWritable(); validatePrepared(record);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.readByInvocation(record.invocationId);
      if (existing) {
        if (existing.logicalProcessId !== record.logicalProcessId || existing.runId !== record.runId) throw new Error(`Process idempotency conflict for ${record.invocationId}.`);
        this.database.exec("COMMIT"); return existing;
      }
      const saved = cloneRecord(record);
      this.database.prepare("INSERT INTO durable_processes (invocation_id, record_json) VALUES (?, ?)").run(saved.invocationId, JSON.stringify(saved));
      this.database.exec("COMMIT"); return cloneRecord(saved);
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  transition(invocationId: string, state: DurableSubprocessState, at: string, reason?: string, patch: DurableSubprocessPatch = {}): DurableSubprocessRecord {
    return this.mutate(invocationId, (current) => transitionRecord(current, state, at, reason, patch));
  }
  bindLaunch(invocationId: string, binding: ProcessBackendBindingRecord, at: string): DurableSubprocessRecord {
    assertBinding(binding);
    return this.mutate(invocationId, (current) => transitionRecord({ ...current, ...cloneBinding(binding) }, "running", at));
  }
  readByInvocation(invocationId: string): DurableSubprocessRecord | undefined {
    const row = this.database.prepare("SELECT * FROM durable_processes WHERE invocation_id = ?").get(invocationId) as ProcessRow | undefined;
    return row ? decode(row.record_json) : undefined;
  }
  listRecoverable(): DurableSubprocessRecord[] {
    return (this.database.prepare("SELECT * FROM durable_processes ORDER BY invocation_id").all() as unknown as ProcessRow[]).map((row) => decode(row.record_json)).filter((record) => !isTerminal(record.state));
  }
  close(): void { this.database.close(); }
  private mutate(invocationId: string, change: (record: DurableSubprocessRecord) => DurableSubprocessRecord): DurableSubprocessRecord {
    this.assertWritable(); this.database.exec("BEGIN IMMEDIATE");
    try {
      const next = change(this.readByInvocation(invocationId) ?? (() => { throw new Error(`Unknown process invocation ${invocationId}.`); })());
      this.database.prepare("UPDATE durable_processes SET record_json = ? WHERE invocation_id = ?").run(JSON.stringify(next), invocationId);
      this.database.exec("COMMIT"); return cloneRecord(next);
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  private assertWritable(): void { if (this.readOnly) throw new Error("Durable process store is read-only."); }
}

function validatePrepared(record: DurableSubprocessRecord): void {
  if (record.schemaVersion !== 1 || record.state !== "prepared" || record.history.length !== 1 || record.history[0]?.state !== "prepared") throw new Error("A new durable process record must be prepared.");
  assertDurableExecutionSafetyValue(record);
}
function transitionRecord(current: DurableSubprocessRecord, state: DurableSubprocessState, at: string, reason?: string, patch: DurableSubprocessPatch = {}): DurableSubprocessRecord {
  if (!LEGAL[current.state].includes(state)) throw new Error(`Illegal process transition ${current.state} -> ${state}.`);
  const next = cloneRecord({ ...current, ...patch, state, history: [...current.history, { state, at, ...(reason ? { reason } : {}) }] });
  assertDurableExecutionSafetyValue(next); return next;
}
function assertBinding(binding: ProcessBackendBindingRecord): void {
  if (!binding.backend.backendId.trim() || !binding.backend.opaqueIdentity.trim() || !binding.birthFingerprint.discriminator.trim()) throw new Error("Process backend identity and birth fingerprint are required.");
}
function cloneBinding(binding: ProcessBackendBindingRecord): ProcessBackendBindingRecord { return structuredClone(binding); }
function cloneRecord(record: DurableSubprocessRecord): DurableSubprocessRecord { assertDurableExecutionSafetyValue(record); return structuredClone(record); }
function decode(json: string): DurableSubprocessRecord { const value = JSON.parse(json) as DurableSubprocessRecord; if (value.schemaVersion !== 1 || !LEGAL[value.state]) throw new Error("Stored durable process record is invalid."); return cloneRecord(value); }
function requiredRecord(records: Map<string, DurableSubprocessRecord>, id: string): DurableSubprocessRecord { const record = records.get(id); if (!record) throw new Error(`Unknown process invocation ${id}.`); return record; }
function isTerminal(state: DurableSubprocessState): boolean { return LEGAL[state].length === 0; }
