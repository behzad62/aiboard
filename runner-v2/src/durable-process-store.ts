import { createHash } from "node:crypto";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { types as nodeTypes } from "node:util";

import {
  assertDurableExecutionSafetyValue,
  parseExecutionLifecycleAttestation,
  parseExecutionSafetyCapabilities,
  parseProcessOutputDisposition,
  type ExecutionLifecycleAttestation,
  type ExecutionLifecycleScope,
  type ExecutionSafetyCapabilities,
  type ExecutionSafetyCapabilityName,
  type ProcessCleanupStatus,
  type ProcessEscalationAction,
  type ProcessOutputDisposition,
} from "./execution-safety-contracts.js";

export const DURABLE_SUBPROCESS_SCHEMA_VERSION = 2 as const;
export type DurableSubprocessState =
  | "prepared"
  | "launching"
  | "running"
  | "stopping"
  | "exited"
  | "verifying_empty"
  | "cleaned"
  | "launch_not_proven"
  | "orphaned"
  | "identity_mismatch"
  | "backend_unavailable"
  | "outcome_unknown"
  | "cleanup_blocked";
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
export interface DurableBackendBinding {
  readonly registryId: string;
  readonly backendId: string;
  readonly implementationGeneration: string;
  readonly implementationDigest: string;
  readonly attestationVersion: number;
  readonly attestationDigest: string;
  /** Exact semantic states reported by the selected backend attestation. */
  readonly capabilities?: ExecutionSafetyCapabilities;
  /** Lifecycle scope is governed by the nested backend attestation version. */
  readonly lifecycle?: ExecutionLifecycleAttestation;
  readonly opaqueIdentity: string;
  readonly birthFingerprint: {
    readonly observedAt: string;
    readonly discriminator: string;
  };
  readonly rootPid?: number;
  readonly startedAt: string;
}
export interface DurableStopIntent {
  readonly reason: "cancelled" | "timed_out";
  readonly requestedAt: string;
}
export interface DurableEscalationEntry {
  readonly action: ProcessEscalationAction;
  readonly requestedAt: string;
  readonly completedAt?: string;
  readonly outcome: "requested" | "running" | "exited" | "failed";
  readonly detail?: string;
}
export interface DurableChildObservation {
  readonly exitCode?: number;
  readonly signal?: string;
  readonly observedAt: string;
}
export interface DurableOutputPrepareFailure {
  readonly failedAt: string;
  readonly detail: string;
}
export type DurableProcessEffectFamily =
  | "output_reopen"
  | "backend_reconcile"
  | "backend_observe"
  | "backend_signal"
  | "output_finalize"
  | "backend_verify_empty"
  | "backend_release";
export interface DurablePendingEffect {
  readonly effectId: string;
  readonly family: DurableProcessEffectFamily;
  readonly phase: "started" | "completed";
  readonly resolution: "settle" | "commit";
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly startedAt: string;
  readonly completedAt?: string;
}
export type DurableEmptyVerification =
  | { readonly empty: true; readonly proofArtifactId?: string }
  | { readonly empty: false; readonly detail: string };
export interface DurableSubprocessResult {
  readonly outcome:
    "exited" | "timed_out" | "cancelled" | "launch_failed" | "cleanup_failed";
  readonly exitCode?: number;
  readonly signal?: string;
  readonly startedAt?: string;
  readonly finishedAt: string;
}
export type DurableProcessMutationKind =
  | "prepared"
  | "renew_lease"
  | "takeover_lease"
  | "orphan_unbound_launch"
  | "mark_launching"
  | "mark_output_prepared"
  | "record_environment"
  | "record_output_prepare_failure"
  | "bind_launch"
  | "adopt_backend"
  | "request_stop"
  | "start_escalation"
  | "finish_escalation"
  | "record_exit"
  | "resume_blocked_exit"
  | "begin_verify"
  | "complete"
  | "fail_launch"
  | "fail"
  | "settle_output_cleanup"
  | "record_output_reopen"
  | "record_reconciliation"
  | "record_empty_verification"
  | "begin_effect"
  | "settle_effect"
  | "complete_effect"
  | "record_exceptional_observation"
  | "resume_exceptional_exit";
export interface DurableProcessMutation {
  readonly kind: DurableProcessMutationKind;
  readonly revision: number;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly at: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface DurableSubprocessRecord {
  readonly schemaVersion: typeof DURABLE_SUBPROCESS_SCHEMA_VERSION;
  readonly revision: number;
  readonly logicalProcessId: string;
  readonly invocationId: string;
  readonly runId: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly requestFingerprint: string;
  readonly retryKey: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: string;
  readonly outputOwnerId: string;
  readonly outputPrepared: boolean;
  readonly state: DurableSubprocessState;
  readonly history: readonly DurableSubprocessHistoryEntry[];
  /** Missing only on legacy records created before lifecycle-scope versioning. */
  readonly requiredLifecycleScope?: ExecutionLifecycleScope;
  readonly requiredCapabilities: readonly ExecutionSafetyCapabilityName[];
  readonly environmentAudit: DurableEnvironmentAudit;
  readonly escalation: readonly DurableEscalationEntry[];
  readonly cleanup: ProcessCleanupStatus;
  readonly backendBinding?: DurableBackendBinding;
  readonly stopIntent?: DurableStopIntent;
  readonly observation?: DurableChildObservation;
  readonly outputPrepareFailure?: DurableOutputPrepareFailure;
  readonly pendingEffects: readonly DurablePendingEffect[];
  readonly emptyVerification?: DurableEmptyVerification;
  readonly output?: readonly ProcessOutputDisposition[];
  readonly result?: DurableSubprocessResult;
  readonly mutations: readonly DurableProcessMutation[];
}
export type PreparedSubprocessRecord = DurableSubprocessRecord & {
  readonly state: "prepared";
  readonly revision: 0;
};
export type PreparedSubprocessClaim = Omit<
  PreparedSubprocessRecord,
  "fencingToken" | "mutations" | "pendingEffects" | "emptyVerification" | "requiredLifecycleScope"
> & { readonly requiredLifecycleScope: ExecutionLifecycleScope };
export interface DurableClaimResult {
  readonly record: DurableSubprocessRecord;
  readonly won: boolean;
}

export type DurableProcessCommand =
  | {
      readonly type: "begin_effect";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly effectId: string;
      readonly family: DurableProcessEffectFamily;
      readonly resolution: "settle" | "commit";
    }
  | {
      readonly type: "settle_effect" | "complete_effect";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly effectId: string;
      readonly leaseExpiresAt: string;
    }
  | {
      readonly type: "record_output_reopen";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly effectId: string;
    }
  | {
      readonly type: "record_reconciliation";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly effectId: string;
      readonly outcome: "running" | "exited" | "identity_mismatch" | "outcome_unknown";
      readonly exitCode?: number;
      readonly signal?: string;
    }
  | {
      readonly type: "record_empty_verification";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly effectId: string;
      readonly verification: DurableEmptyVerification;
    }
  | {
      readonly type: "renew_lease";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly leaseExpiresAt: string;
    }
  | {
      readonly type: "takeover_lease";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly leaseExpiresAt: string;
    }
  | {
      readonly type: "orphan_unbound_launch";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly detail: string;
    }
  | {
      readonly type: "mark_launching";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
    }
  | {
      readonly type: "mark_output_prepared";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
    }
  | {
      readonly type: "record_environment";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly environmentAudit: DurableEnvironmentAudit;
    }
  | {
      readonly type: "record_output_prepare_failure";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly detail: string;
    }
  | {
      readonly type: "bind_launch";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly binding: DurableBackendBinding;
    }
  | {
      readonly type: "adopt_backend";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly binding: DurableBackendBinding;
    }
  | {
      readonly type: "request_stop";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly reason: "cancelled" | "timed_out";
    }
  | {
      readonly type: "start_escalation";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly action: ProcessEscalationAction;
      readonly requestedAt: string;
    }
  | {
      readonly type: "finish_escalation";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly action: ProcessEscalationAction;
      readonly completedAt: string;
      readonly outcome: "running" | "exited" | "failed";
      readonly detail?: string;
      readonly effectId?: string;
    }
  | {
      readonly type: "record_exit";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly observation: DurableChildObservation;
      readonly effectId?: string;
    }
  | {
      readonly type: "resume_blocked_exit";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly observation: DurableChildObservation;
    }
  | {
      readonly type: "begin_verify";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly output: readonly ProcessOutputDisposition[];
      readonly effectId?: string;
    }
  | {
      readonly type: "complete";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly cleanup: ProcessCleanupStatus;
      readonly result: DurableSubprocessResult;
      readonly effectId?: string;
    }
  | {
      readonly type: "fail_launch";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly detail: string;
    }
  | {
      readonly type: "fail";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly state:
        | "orphaned"
        | "identity_mismatch"
        | "backend_unavailable"
        | "outcome_unknown"
        | "cleanup_blocked";
      readonly detail: string;
      readonly cleanup?: ProcessCleanupStatus;
      readonly result?: DurableSubprocessResult;
      readonly output?: readonly ProcessOutputDisposition[];
    }
  | {
      readonly type: "settle_output_cleanup";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
    }
  /**
   * Exceptional-recovery observation. Legal only from an exceptional terminal
   * state, only while the caller holds the lease fence, and only once the
   * caller has re-proved the live backend identity (`identityProof`) against
   * the recorded binding. It never changes lifecycle state and never certifies
   * cleanup.
   */
  | {
      readonly type: "record_exceptional_observation";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly effectId: string;
      readonly identityProof: string;
      readonly outcome: "running" | "exited" | "identity_mismatch" | "outcome_unknown";
    }
  /**
   * Exceptional-recovery cleanup proof. Legal only from an exceptional terminal
   * state after a proven-empty backend verification under the same identity
   * proof. It records `verified_empty` cleanup without inventing an exit
   * observation, an output disposition or a synthetic terminal result.
   */
  | {
      readonly type: "resume_exceptional_exit";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly effectId: string;
      readonly identityProof: string;
      readonly observation: DurableChildObservation;
    };

type OwnedDurableProcessCommand = DurableProcessCommand & {
  readonly ownerId: string;
  readonly fencingToken: number;
};

export interface DurableProcessRuntimeWriter {
  claim(record: PreparedSubprocessClaim): DurableClaimResult;
  apply(command: OwnedDurableProcessCommand): DurableSubprocessRecord;
}
export interface DurableProcessStore {
  readonly coordinationId: string;
  readByInvocation(invocationId: string): DurableSubprocessRecord | undefined;
  listRowIds(): string[];
  close(): void;
}
export interface DurableProcessStoreKernel {
  readonly store: DurableProcessStore;
}

export interface SemanticRequestFingerprintInput {
  readonly intent: unknown;
  readonly ambientEnvironment: unknown;
  readonly explicitEnvironment?: unknown;
  readonly credentialGrantId?: string;
  readonly grantId: string;
  readonly grantBindingDigest: string;
  readonly deadline?: string;
  readonly signalPresent: boolean;
  readonly signalInitiallyAborted: boolean;
}
export function semanticRequestFingerprint(
  key: Uint8Array,
  input: SemanticRequestFingerprintInput,
): string {
  return hmac(snapshotKey(key), canonicalJson(input));
}

const RUNTIME_WRITER = Symbol("runtime-writer");

abstract class AuthorityStore implements DurableProcessStore {
  abstract readonly coordinationId: string;
  constructor(protected readonly integrityKey: Uint8Array) {
    this.integrityKey = snapshotKey(integrityKey);
  }
  runtimeWriter(): DurableProcessRuntimeWriter {
    return Object.freeze({
      claim: (record: PreparedSubprocessClaim) => this.claim(record),
      apply: (command: OwnedDurableProcessCommand) => this.apply(command),
    });
  }
  protected abstract claim(record: PreparedSubprocessClaim): DurableClaimResult;
  protected abstract apply(
    command: OwnedDurableProcessCommand,
  ): DurableSubprocessRecord;
  abstract readByInvocation(
    invocationId: string,
  ): DurableSubprocessRecord | undefined;
  abstract listRowIds(): string[];
  abstract close(): void;
}

class InMemoryDurableProcessStore extends AuthorityStore {
  readonly coordinationId = `memory-${randomUUID()}`;
  private readonly records = new Map<string, DurableSubprocessRecord>();
  constructor(key: Uint8Array, initial: readonly unknown[] = []) {
    super(key);
    for (const value of initial) {
      const record = parseDurableSubprocessRecord(value);
      this.records.set(record.invocationId, record);
    }
  }
  protected claim(record: PreparedSubprocessClaim): DurableClaimResult {
    const parsed = initializePreparedRecord(record);
    const existing = this.records.get(parsed.invocationId);
    if (existing) {
      const claim = claimRetry(existing, parsed);
      if (claim.won) this.records.set(parsed.invocationId, claim.record);
      return claim;
    }
    this.records.set(parsed.invocationId, parsed);
    return Object.freeze({ record: cloneRecord(parsed), won: true });
  }
  protected apply(
    command: OwnedDurableProcessCommand,
  ): DurableSubprocessRecord {
    const current = requiredRecord(
      this.records.get(command.invocationId),
      command.invocationId,
    );
    const next = applyCommand(current, command);
    this.records.set(command.invocationId, next);
    return cloneRecord(next);
  }
  readByInvocation(id: string): DurableSubprocessRecord | undefined {
    const value = this.records.get(id);
    return value ? cloneRecord(value) : undefined;
  }
  listRowIds(): string[] {
    return [...this.records.keys()].sort();
  }
  close(): void {}
}

interface ProcessRow {
  invocation_id: string;
  revision: number;
  record_json: string;
  integrity?: string | null;
}
class SqliteDurableProcessStore extends AuthorityStore {
  readonly coordinationId: string;
  private readonly database: DatabaseSync;
  private readonly readOnly: boolean;
  constructor(
    path: string,
    key: Uint8Array,
    options: { readonly readOnly?: boolean } = {},
  ) {
    const readOnly = options.readOnly ?? false;
    super(key);
    this.coordinationId = `sqlite-${resolve(path).toLowerCase()}`;
    this.readOnly = readOnly;
    if (!readOnly) mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path, { readOnly });
    this.database.exec("PRAGMA busy_timeout = 5000");
    if (!readOnly) {
      try {
        this.migrateSchema();
      } catch (error) {
        this.database.close();
        throw error;
      }
    }
  }
  protected claim(record: PreparedSubprocessClaim): DurableClaimResult {
    this.assertWritable();
    const parsed = initializePreparedRecord(record);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.readByInvocation(parsed.invocationId);
      if (existing) {
        const claim = claimRetry(existing, parsed);
        if (claim.won) {
          const json = JSON.stringify(claim.record);
          this.database
            .prepare(
              "UPDATE durable_processes SET revision=?, record_json=?, integrity=? WHERE invocation_id=? AND revision=?",
            )
            .run(
              claim.record.revision,
              json,
              this.sign(claim.record.invocationId, claim.record.revision, json),
              claim.record.invocationId,
              existing.revision,
            );
        }
        this.database.exec("COMMIT");
        return claim;
      }
      const json = JSON.stringify(parsed);
      this.database
        .prepare(
          "INSERT INTO durable_processes (invocation_id, revision, record_json, integrity) VALUES (?, ?, ?, ?)",
        )
        .run(
          parsed.invocationId,
          parsed.revision,
          json,
          this.sign(parsed.invocationId, parsed.revision, json),
        );
      this.database.exec("COMMIT");
      return Object.freeze({ record: cloneRecord(parsed), won: true });
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  protected apply(
    command: OwnedDurableProcessCommand,
  ): DurableSubprocessRecord {
    this.assertWritable();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.readByInvocation(command.invocationId);
      if (!current)
        throw new Error(`Unknown process invocation ${command.invocationId}.`);
      const next = applyCommand(current, command);
      const json = JSON.stringify(next);
      const result = this.database
        .prepare(
          "UPDATE durable_processes SET revision = ?, record_json = ?, integrity = ? WHERE invocation_id = ? AND revision = ?",
        )
        .run(
          next.revision,
          json,
          this.sign(next.invocationId, next.revision, json),
          next.invocationId,
          current.revision,
        );
      if (result.changes !== 1)
        throw new Error(
          `Process revision conflict for ${command.invocationId}.`,
        );
      this.database.exec("COMMIT");
      return cloneRecord(next);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  readByInvocation(id: string): DurableSubprocessRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM durable_processes WHERE invocation_id = ?")
      .get(id) as ProcessRow | undefined;
    if (!row) return undefined;
    try {
      const expected = this.sign(
        row.invocation_id,
        row.revision,
        row.record_json,
      );
      if (!safeEqual(expected, row.integrity))
        throw new Error("integrity mismatch");
      return parseDurableSubprocessRecord(JSON.parse(row.record_json));
    } catch (error) {
      throw new Error(`Stored durable process record ${id} is corrupt.`, {
        cause: error,
      });
    }
  }
  listRowIds(): string[] {
    return (
      this.database
        .prepare(
          "SELECT invocation_id FROM durable_processes ORDER BY invocation_id",
        )
        .all() as unknown as Array<{ invocation_id: string }>
    ).map((row) => row.invocation_id);
  }
  close(): void {
    this.database.close();
  }
  private assertWritable(): void {
    if (this.readOnly) throw new Error("Durable process store is read-only.");
  }
  private sign(id: string, revision: number, json: string): string {
    return hmac(this.integrityKey, `${id}\0${revision}\0${json}`);
  }
  private migrateSchema(): void {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let began = false;
      try {
        this.database.exec("PRAGMA journal_mode = WAL");
        this.database.exec("BEGIN IMMEDIATE");
        began = true;
        this.database.exec(
          "CREATE TABLE IF NOT EXISTS durable_processes (invocation_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, record_json TEXT NOT NULL, integrity TEXT NOT NULL)",
        );
        const columns = new Set(
          (
            this.database
              .prepare("PRAGMA table_info(durable_processes)")
              .all() as unknown as Array<{ name: string }>
          ).map(({ name }) => name),
        );
        if (!columns.has("revision"))
          this.database.exec(
            "ALTER TABLE durable_processes ADD COLUMN revision INTEGER",
          );
        if (!columns.has("integrity"))
          this.database.exec(
            "ALTER TABLE durable_processes ADD COLUMN integrity TEXT",
          );
        this.database.exec("COMMIT");
        return;
      } catch (error) {
        if (began) {
          try {
            this.database.exec("ROLLBACK");
          } catch {}
        }
        if (!isSqliteBusy(error) || attempt === 7) throw error;
        synchronousBackoff(25 * (attempt + 1));
      }
    }
  }
}

function kernelFor(store: AuthorityStore): DurableProcessStoreKernel {
  const publicStore = Object.freeze({
    coordinationId: store.coordinationId,
    readByInvocation: store.readByInvocation.bind(store),
    listRowIds: store.listRowIds.bind(store),
    close: store.close.bind(store),
  });
  const kernel = { store: publicStore };
  Object.defineProperty(kernel, RUNTIME_WRITER, {
    value: store.runtimeWriter(),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(kernel);
}
export function createInMemoryDurableProcessKernel(
  key: Uint8Array,
  initial: readonly unknown[] = [],
): DurableProcessStoreKernel {
  return kernelFor(new InMemoryDurableProcessStore(key, initial));
}
export function openSqliteDurableProcessKernel(
  path: string,
  key: Uint8Array,
  options: { readonly readOnly?: boolean } = {},
): DurableProcessStoreKernel {
  return kernelFor(new SqliteDurableProcessStore(path, key, options));
}

const STATES = new Set<DurableSubprocessState>([
  "prepared",
  "launching",
  "running",
  "stopping",
  "exited",
  "verifying_empty",
  "cleaned",
  "launch_not_proven",
  "orphaned",
  "identity_mismatch",
  "backend_unavailable",
  "outcome_unknown",
  "cleanup_blocked",
]);
const EFFECT_FAMILIES = new Set<DurableProcessEffectFamily>([
  "output_reopen",
  "backend_reconcile",
  "backend_observe",
  "backend_signal",
  "output_finalize",
  "backend_verify_empty",
  "backend_release",
]);
const EFFECT_CONSUMERS: Readonly<
  Record<DurableProcessEffectFamily, readonly DurableProcessMutationKind[]>
> = Object.freeze({
  output_reopen: Object.freeze(["record_output_reopen"] as const),
  backend_reconcile: Object.freeze([
    "record_reconciliation",
    "record_exceptional_observation",
    "resume_exceptional_exit",
  ] as const),
  backend_observe: Object.freeze(["record_exit"] as const),
  backend_signal: Object.freeze([
    "finish_escalation",
    "record_exceptional_observation",
  ] as const),
  output_finalize: Object.freeze(["begin_verify"] as const),
  backend_verify_empty: Object.freeze([
    "record_empty_verification",
  ] as const),
  backend_release: Object.freeze(["complete"] as const),
});

/** Terminal classifications that ordinary lifecycle commands may never leave. */
const EXCEPTIONAL_STATES: ReadonlySet<DurableSubprocessState> = new Set([
  "orphaned",
  "identity_mismatch",
  "backend_unavailable",
  "outcome_unknown",
]);

/** Exceptional states that were completely frozen before Task 11. */
const FROZEN_EXCEPTIONAL_STATES: ReadonlySet<DurableSubprocessState> = new Set([
  "orphaned",
  "identity_mismatch",
  "outcome_unknown",
]);

/**
 * The closed set of commands an exceptional-recovery caller may apply. Every
 * other lifecycle command stays illegal from these states, so no routine path
 * gains new authority. `backend_unavailable` keeps its pre-existing ordinary
 * transitions in addition to these.
 */
const EXCEPTIONAL_RECOVERY_COMMANDS: ReadonlySet<DurableProcessMutationKind> =
  new Set([
    "begin_effect",
    "settle_effect",
    "complete_effect",
    "renew_lease",
    "takeover_lease",
    "adopt_backend",
    "record_exceptional_observation",
    "resume_exceptional_exit",
  ]);

/**
 * History reasons an exceptional state may repeat with. Reasons are derived
 * from the mutation log (never stored independently), so this cannot be forged
 * by a hand-written record.
 */
const EXCEPTIONAL_SELF_HISTORY_REASONS: ReadonlySet<string> = new Set([
  "effect_backend_reconcile_started",
  "effect_backend_reconcile_completed",
  "effect_backend_reconcile_settled",
  "effect_backend_signal_started",
  "effect_backend_signal_completed",
  "effect_backend_signal_settled",
  "effect_backend_verify_empty_started",
  "effect_backend_verify_empty_completed",
  "effect_backend_verify_empty_settled",
  "lease_renewed",
  "lease_takeover",
  "exceptional_recovery_observed_running",
  "exceptional_recovery_observed_exited",
  "exceptional_recovery_observed_identity_mismatch",
  "exceptional_recovery_observed_outcome_unknown",
  "backend_restart_adopted",
]);
const LEGAL_HISTORY: Readonly<
  Record<DurableSubprocessState, readonly DurableSubprocessState[]>
> = {
  prepared: ["prepared", "launching", "launch_not_proven", "cleanup_blocked"],
  launching: [
    "launching",
    "running",
    "stopping",
    "launch_not_proven",
    "orphaned",
    "identity_mismatch",
    "backend_unavailable",
    "outcome_unknown",
  ],
  running: [
    "running",
    "stopping",
    "exited",
    "identity_mismatch",
    "backend_unavailable",
    "outcome_unknown",
    "cleanup_blocked",
  ],
  stopping: [
    "stopping",
    "exited",
    "identity_mismatch",
    "backend_unavailable",
    "outcome_unknown",
  ],
  exited: [
    "exited",
    "verifying_empty",
    "cleanup_blocked",
    "backend_unavailable",
    "outcome_unknown",
  ],
  verifying_empty: [
    "verifying_empty",
    "cleaned",
    "cleanup_blocked",
    "backend_unavailable",
    "outcome_unknown",
  ],
  backend_unavailable: [
    "exited",
    "stopping",
    "identity_mismatch",
    "outcome_unknown",
    "backend_unavailable",
  ],
  cleaned: [],
  launch_not_proven: [],
  orphaned: [],
  identity_mismatch: [],
  outcome_unknown: [],
  cleanup_blocked: ["cleanup_blocked", "exited", "launch_not_proven"],
};
const BASE_KEYS = [
  "schemaVersion",
  "revision",
  "logicalProcessId",
  "invocationId",
  "runId",
  "taskId",
  "sessionId",
  "requestFingerprint",
  "retryKey",
  "ownerId",
  "fencingToken",
  "leaseExpiresAt",
  "outputOwnerId",
  "outputPrepared",
  "state",
  "history",
  "requiredLifecycleScope",
  "requiredCapabilities",
  "environmentAudit",
  "escalation",
  "cleanup",
  "pendingEffect",
  "pendingEffects",
  "emptyVerification",
  "mutations",
];
const OPTIONAL_BY_STATE: Record<DurableSubprocessState, readonly string[]> = {
  prepared: ["stopIntent", "outputPrepareFailure"],
  launching: ["stopIntent"],
  running: ["backendBinding"],
  stopping: ["backendBinding", "stopIntent"],
  exited: ["backendBinding", "stopIntent", "observation"],
  verifying_empty: [
    "backendBinding",
    "stopIntent",
    "observation",
    "output",
    "emptyVerification",
  ],
  cleaned: ["backendBinding", "stopIntent", "observation", "output", "result"],
  launch_not_proven: ["result"],
  orphaned: ["stopIntent"],
  identity_mismatch: ["backendBinding", "stopIntent"],
  backend_unavailable: [
    "backendBinding",
    "stopIntent",
    "observation",
    "output",
  ],
  outcome_unknown: ["backendBinding", "stopIntent", "observation", "output"],
  cleanup_blocked: [
    "backendBinding",
    "stopIntent",
    "observation",
    "outputPrepareFailure",
    "output",
    "result",
    "emptyVerification",
  ],
};

export function parseDurableSubprocessRecord(
  value: unknown,
): DurableSubprocessRecord {
  const object = strictRecord(value, "durable process record");
  const record = parseRecordShape(object);
  const derived = deriveRecord(record.mutations);
  if (canonicalJson(record) !== canonicalJson(derived))
    throw new Error(
      "Durable process projection does not match its mutation log.",
    );
  assertStateInvariants(record);
  assertDurableProcessValue(record);
  return deepFreeze(structuredClone(record));
}

function parseRecordShape(
  object: Record<string, unknown>,
): DurableSubprocessRecord {
  const state = requiredEnum(object.state, STATES, "state");
  assertKeys(
    object,
    new Set([...BASE_KEYS, ...OPTIONAL_BY_STATE[state]]),
    "durable process record",
  );
  if (object.pendingEffect !== undefined && object.pendingEffects !== undefined)
    throw new Error("Durable process record has conflicting effect journals.");
  const pendingEffects =
    object.pendingEffects === undefined
      ? object.pendingEffect === undefined
        ? []
        : [parsePendingEffect(object.pendingEffect)]
      : parsePendingEffects(object.pendingEffects);
  const record: DurableSubprocessRecord = {
    schemaVersion: requiredInteger(
      object.schemaVersion,
      "schemaVersion",
      2,
      2,
    ) as 2,
    revision: requiredInteger(object.revision, "revision", 0),
    logicalProcessId: text(object.logicalProcessId, "logicalProcessId"),
    invocationId: text(object.invocationId, "invocationId"),
    runId: text(object.runId, "runId"),
    ...optionalText(object, "taskId"),
    ...optionalText(object, "sessionId"),
    requestFingerprint: digest(object.requestFingerprint, "requestFingerprint"),
    retryKey: digest(object.retryKey, "retryKey"),
    ownerId: safeId(object.ownerId, "ownerId"),
    fencingToken: requiredInteger(object.fencingToken, "fencingToken", 1),
    leaseExpiresAt: dateText(object.leaseExpiresAt, "leaseExpiresAt"),
    outputOwnerId: safeId(object.outputOwnerId, "outputOwnerId"),
    outputPrepared: requiredBoolean(object.outputPrepared, "outputPrepared"),
    state,
    history: parseHistory(object.history, state),
    ...(object.requiredLifecycleScope === undefined ? {} : { requiredLifecycleScope: parseLifecycleScope(object.requiredLifecycleScope) }),
    requiredCapabilities: parseCapabilities(object.requiredCapabilities),
    environmentAudit: parseAudit(object.environmentAudit),
    escalation: parseEscalation(object.escalation),
    cleanup: parseCleanup(object.cleanup),
    ...(object.backendBinding === undefined
      ? {}
      : { backendBinding: parseBinding(object.backendBinding) }),
    ...(object.stopIntent === undefined
      ? {}
      : { stopIntent: parseStop(object.stopIntent) }),
    ...(object.observation === undefined
      ? {}
      : { observation: parseObservation(object.observation) }),
    ...(object.outputPrepareFailure === undefined
      ? {}
      : {
          outputPrepareFailure: parseOutputPrepareFailure(
            object.outputPrepareFailure,
          ),
        }),
    pendingEffects,
    ...(object.emptyVerification === undefined
      ? {}
      : { emptyVerification: parseEmptyVerification(object.emptyVerification) }),
    ...(object.output === undefined
      ? {}
      : { output: parseOutput(object.output) }),
    ...(object.result === undefined
      ? {}
      : { result: parseResult(object.result) }),
    mutations: parseMutations(object.mutations),
  };
  return record;
}

function initializePreparedRecord(
  value: PreparedSubprocessClaim,
): PreparedSubprocessRecord {
  const o = strictRecord(value, "prepared process claim");
  const allowed = new Set([
    "schemaVersion",
    "revision",
    "logicalProcessId",
    "invocationId",
    "runId",
    "taskId",
    "sessionId",
    "requestFingerprint",
    "retryKey",
    "ownerId",
    "leaseExpiresAt",
    "outputOwnerId",
    "outputPrepared",
    "state",
    "history",
    "requiredLifecycleScope",
    "requiredCapabilities",
    "environmentAudit",
    "escalation",
    "cleanup",
  ]);
  assertKeys(o, allowed, "prepared process claim");
  const history = parseHistory(o.history, "prepared");
  const audit = parseAudit(o.environmentAudit);
  const escalation = parseEscalation(o.escalation);
  const cleanup = parseCleanup(o.cleanup);
  if (
    o.schemaVersion !== 2 ||
    o.revision !== 0 ||
    o.state !== "prepared" ||
    o.outputPrepared !== false ||
    history.length !== 1 ||
    history[0]?.state !== "prepared" ||
    history[0]?.reason !== undefined ||
    escalation.length !== 0 ||
    cleanup.state !== "pending" ||
    Object.values(audit).some((names) => names.length !== 0)
  )
    throw new Error("Prepared process claim is invalid.");
  const mutation = parseMutation({
    kind: "prepared",
    revision: 0,
    ownerId: safeId(o.ownerId, "ownerId"),
    fencingToken: 1,
    at: dateText(history[0].at, "prepared at"),
    data: {
      logicalProcessId: text(o.logicalProcessId, "logicalProcessId"),
      invocationId: text(o.invocationId, "invocationId"),
      runId: text(o.runId, "runId"),
      ...(o.taskId === undefined ? {} : { taskId: text(o.taskId, "taskId") }),
      ...(o.sessionId === undefined
        ? {}
        : { sessionId: text(o.sessionId, "sessionId") }),
      requestFingerprint: digest(o.requestFingerprint, "requestFingerprint"),
      retryKey: digest(o.retryKey, "retryKey"),
      leaseExpiresAt: dateText(o.leaseExpiresAt, "leaseExpiresAt"),
      outputOwnerId: safeId(o.outputOwnerId, "outputOwnerId"),
      requiredLifecycleScope: parseLifecycleScope(o.requiredLifecycleScope),
      requiredCapabilities: parseCapabilities(o.requiredCapabilities),
    },
  });
  const derived = deriveRecord([mutation]) as PreparedSubprocessRecord;
  const supplied = canonicalJson(o);
  const expectedObject = structuredClone(derived) as unknown as Record<
    string,
    unknown
  >;
  delete expectedObject.fencingToken;
  delete expectedObject.mutations;
  delete expectedObject.pendingEffects;
  delete expectedObject.emptyVerification;
  if (supplied !== canonicalJson(expectedObject))
    throw new Error("Prepared process claim does not match its mutation.");
  assertStateInvariants(derived);
  assertDurableProcessValue(derived);
  return deepFreeze(structuredClone(derived));
}

function parseMutations(value: unknown): DurableProcessMutation[] {
  if (!Array.isArray(value) || value.length < 1)
    throw new Error("Durable process mutation log is invalid.");
  return value.map(parseMutation);
}

function parseMutation(value: unknown): DurableProcessMutation {
  const o = strictRecord(value, "process mutation");
  assertExactKeys(
    o,
    ["kind", "revision", "ownerId", "fencingToken", "at", "data"],
    [],
    "process mutation",
  );
  const kind = requiredEnum(
    o.kind,
    new Set<DurableProcessMutationKind>([
      "prepared",
      "renew_lease",
      "takeover_lease",
      "orphan_unbound_launch",
      "mark_launching",
      "mark_output_prepared",
      "record_environment",
      "record_output_prepare_failure",
      "bind_launch",
      "adopt_backend",
      "request_stop",
      "start_escalation",
      "finish_escalation",
      "record_exit",
      "resume_blocked_exit",
      "begin_verify",
      "complete",
      "fail_launch",
      "fail",
      "settle_output_cleanup",
      "record_output_reopen",
      "record_reconciliation",
      "record_empty_verification",
      "begin_effect",
      "settle_effect",
      "complete_effect",
      "record_exceptional_observation",
      "resume_exceptional_exit",
    ]),
    "mutation kind",
  );
  const data = strictRecord(o.data, "mutation data");
  const keysByKind: Record<
    DurableProcessMutationKind,
    { required: readonly string[]; optional?: readonly string[] }
  > = {
    prepared: {
      required: [
        "logicalProcessId",
        "invocationId",
        "runId",
        "requestFingerprint",
        "retryKey",
        "leaseExpiresAt",
        "outputOwnerId",
        "requiredCapabilities",
      ],
      optional: ["taskId", "sessionId", "requiredLifecycleScope"],
    },
    renew_lease: { required: ["leaseExpiresAt"] },
    takeover_lease: { required: ["leaseExpiresAt"] },
    orphan_unbound_launch: { required: ["detail"] },
    mark_launching: { required: [] },
    mark_output_prepared: { required: [] },
    record_environment: { required: ["environmentAudit"] },
    record_output_prepare_failure: { required: ["detail"] },
    bind_launch: { required: ["binding"] },
    adopt_backend: { required: ["binding"] },
    request_stop: { required: ["reason"] },
    start_escalation: { required: ["action"] },
    finish_escalation: {
      required: ["action", "outcome"],
      optional: ["detail", "effectId"],
    },
    record_exit: { required: ["observation"], optional: ["effectId"] },
    resume_blocked_exit: { required: ["observation"] },
    begin_verify: { required: ["output"], optional: ["effectId"] },
    complete: { required: ["cleanup", "result"], optional: ["effectId"] },
    fail_launch: { required: ["detail"] },
    fail: {
      required: ["state", "detail"],
      optional: ["cleanup", "result", "output"],
    },
    settle_output_cleanup: { required: [] },
    record_output_reopen: { required: ["effectId"] },
    record_reconciliation: {
      required: ["effectId", "outcome"],
      optional: ["exitCode", "signal"],
    },
    record_empty_verification: {
      required: ["effectId", "verification"],
    },
    begin_effect: {
      required: ["effectId", "family", "resolution"],
    },
    settle_effect: { required: ["effectId", "leaseExpiresAt"] },
    complete_effect: { required: ["effectId", "leaseExpiresAt"] },
    record_exceptional_observation: {
      required: ["effectId", "identityProof", "outcome"],
    },
    resume_exceptional_exit: {
      required: ["effectId", "identityProof", "observation"],
    },
  };
  const shape = keysByKind[kind];
  assertExactKeys(
    data,
    shape.required,
    shape.optional ?? [],
    `${kind} mutation data`,
  );
  return deepFreeze({
    kind,
    revision: requiredInteger(o.revision, "mutation revision", 0),
    ownerId: safeId(o.ownerId, "mutation ownerId"),
    fencingToken: requiredInteger(o.fencingToken, "mutation fencingToken", 1),
    at: dateText(o.at, "mutation at"),
    data: deepFreeze(structuredClone(data)),
  });
}

function deriveRecord(
  mutations: readonly DurableProcessMutation[],
): DurableSubprocessRecord {
  const first = mutations[0];
  if (
    !first ||
    first.kind !== "prepared" ||
    first.revision !== 0 ||
    first.fencingToken !== 1
  )
    throw new Error("Durable process mutation origin is invalid.");
  const initial = first.data;
  let record: DurableSubprocessRecord = {
    schemaVersion: 2,
    revision: 0,
    logicalProcessId: text(initial.logicalProcessId, "logicalProcessId"),
    invocationId: text(initial.invocationId, "invocationId"),
    runId: text(initial.runId, "runId"),
    ...optionalText(initial, "taskId"),
    ...optionalText(initial, "sessionId"),
    requestFingerprint: digest(
      initial.requestFingerprint,
      "requestFingerprint",
    ),
    retryKey: digest(initial.retryKey, "retryKey"),
    ownerId: first.ownerId,
    fencingToken: first.fencingToken,
    leaseExpiresAt: dateText(initial.leaseExpiresAt, "leaseExpiresAt"),
    outputOwnerId: safeId(initial.outputOwnerId, "outputOwnerId"),
    outputPrepared: false,
    state: "prepared",
    history: [{ state: "prepared", at: first.at }],
    ...(initial.requiredLifecycleScope === undefined ? {} : { requiredLifecycleScope: parseLifecycleScope(initial.requiredLifecycleScope) }),
    requiredCapabilities: parseCapabilities(initial.requiredCapabilities),
    environmentAudit: {
      inheritedNames: [],
      removedNames: [],
      explicitSafeNames: [],
      grantedNames: [],
    },
    escalation: [],
    cleanup: { state: "pending" },
    pendingEffects: [],
    mutations: [first],
  };
  for (let index = 1; index < mutations.length; index += 1) {
    const mutation = mutations[index]!;
    if (mutation.revision !== record.revision + 1)
      throw new Error("Durable process mutation sequence is invalid.");
    if (mutation.kind === "takeover_lease") {
      if (
        record.pendingEffects.length > 0 ||
        Date.parse(record.leaseExpiresAt) > Date.parse(mutation.at) ||
        mutation.fencingToken !== record.fencingToken + 1
      )
        throw new Error("Durable process lease takeover is invalid.");
    } else if (mutation.kind === "orphan_unbound_launch") {
      if (
        record.state !== "launching" ||
        record.backendBinding ||
        Date.parse(record.leaseExpiresAt) > Date.parse(mutation.at) ||
        mutation.ownerId !== record.ownerId ||
        mutation.fencingToken !== record.fencingToken + 1
      )
        throw new Error("Durable unbound launch classification is invalid.");
    } else if (
      mutation.ownerId !== record.ownerId ||
      mutation.fencingToken !== record.fencingToken
    ) {
      throw new Error("Durable process mutation fence is invalid.");
    }
    assertEffectMutationAllowed(record, mutation.kind);
    record = reduceMutation(record, mutation);
    assertStateInvariants(record);
  }
  return record;
}

function reduceMutation(
  current: DurableSubprocessRecord,
  mutation: DurableProcessMutation,
): DurableSubprocessRecord {
  const data = mutation.data;
  const consumed = consumeEffectForMutation(current, mutation);
  const base = {
    ...consumed,
    revision: mutation.revision,
    mutations: [...current.mutations, mutation],
  };
  switch (mutation.kind) {
    case "prepared":
      throw new Error("Prepared mutation may appear only once.");
    case "begin_effect":
      if (
        current.pendingEffects.some(
          ({ effectId }) => effectId === safeId(data.effectId, "effectId"),
        )
      )
        throw new Error("A durable process effect ID is already unresolved.");
      return historyOnly(
        {
          ...base,
          pendingEffects: [
            ...current.pendingEffects,
            {
              effectId: safeId(data.effectId, "effectId"),
              family: requiredEnum(
                data.family,
                EFFECT_FAMILIES,
                "effect family",
              ),
              phase: "started",
              resolution: requiredEnum(
                data.resolution,
                new Set<"settle" | "commit">(["settle", "commit"]),
                "effect resolution",
              ),
              ownerId: mutation.ownerId,
              fencingToken: mutation.fencingToken,
              startedAt: mutation.at,
            },
          ],
        },
        mutation.at,
        `effect_${requiredEnum(data.family, EFFECT_FAMILIES, "effect family")}_started`,
      );
    case "settle_effect": {
      const effect = requiredPendingEffect(current, data.effectId, "started");
      return historyOnly(
        {
          ...current,
          revision: mutation.revision,
          mutations: [...current.mutations, mutation],
          leaseExpiresAt: dateText(data.leaseExpiresAt, "leaseExpiresAt"),
          pendingEffects: current.pendingEffects.filter(
            ({ effectId }) => effectId !== effect.effectId,
          ),
        },
        mutation.at,
        `effect_${effect.family}_settled`,
      );
    }
    case "complete_effect": {
      const effect = requiredPendingEffect(current, data.effectId, "started");
      if (effect.resolution !== "commit")
        throw new Error("A settled effect cannot await a durable commit.");
      return historyOnly(
        {
          ...base,
          leaseExpiresAt: dateText(data.leaseExpiresAt, "leaseExpiresAt"),
          pendingEffects: current.pendingEffects.map((candidate) =>
            candidate.effectId === effect.effectId
              ? { ...effect, phase: "completed" as const, completedAt: mutation.at }
              : candidate,
          ),
        },
        mutation.at,
        `effect_${effect.family}_completed`,
      );
    }
    case "renew_lease":
      return historyOnly(
        {
          ...base,
          leaseExpiresAt: dateText(data.leaseExpiresAt, "leaseExpiresAt"),
        },
        mutation.at,
        "lease_renewed",
      );
    case "takeover_lease":
      return historyOnly(
        {
          ...base,
          ownerId: mutation.ownerId,
          fencingToken: mutation.fencingToken,
          leaseExpiresAt: dateText(data.leaseExpiresAt, "leaseExpiresAt"),
        },
        mutation.at,
        "lease_takeover",
      );
    case "orphan_unbound_launch":
      requireState(current, ["launching"]);
      if (
        current.backendBinding ||
        Date.parse(current.leaseExpiresAt) > Date.parse(mutation.at)
      )
        throw new Error("Unbound launch is not eligible for classification.");
      return moveDerived(
        { ...base, fencingToken: mutation.fencingToken },
        "orphaned",
        mutation.at,
        text(data.detail, "detail"),
      );
    case "mark_output_prepared":
      requireState(current, ["prepared"]);
      {
        const { outputPrepareFailure: _failure, ...withoutFailure } = base;
        return historyOnly(
          { ...withoutFailure, outputPrepared: true },
          mutation.at,
          "output_prepared",
        );
      }
    case "record_environment":
      requireState(current, ["prepared"]);
      if (!current.outputPrepared)
        throw new Error("Output ownership is not prepared.");
      return historyOnly(
        { ...base, environmentAudit: parseAudit(data.environmentAudit) },
        mutation.at,
        "environment_prepared",
      );
    case "record_output_prepare_failure":
      requireState(current, ["prepared"]);
      return historyOnly(
        {
          ...base,
          outputPrepareFailure: {
            failedAt: mutation.at,
            detail: text(data.detail, "detail"),
          },
          leaseExpiresAt: mutation.at,
        },
        mutation.at,
        "output_prepare_failed",
      );
    case "mark_launching":
      requireState(current, ["prepared"]);
      if (!current.outputPrepared)
        throw new Error("Output ownership is not prepared.");
      return moveDerived(base, "launching", mutation.at);
    case "bind_launch": {
      requireState(current, ["launching"]);
      const binding = parseBinding(data.binding);
      return moveDerived(
        { ...base, backendBinding: binding },
        current.stopIntent ? "stopping" : "running",
        mutation.at,
      );
    }
    case "adopt_backend": {
      requireState(current, ["orphaned", "identity_mismatch", "outcome_unknown",
        "running",
        "stopping",
        "exited",
        "verifying_empty",
        "backend_unavailable",
        "cleanup_blocked",
      ]);
      const binding = parseBinding(data.binding);
      if (
        !current.backendBinding ||
        current.backendBinding.opaqueIdentity !== binding.opaqueIdentity ||
        current.backendBinding.birthFingerprint.discriminator !==
          binding.birthFingerprint.discriminator
      )
        throw new Error("Backend adoption cannot change process identity.");
      if (binding.implementationDigest !== current.backendBinding?.implementationDigest) throw new Error("Backend adoption cannot change implementation.");
      return historyOnly(
        { ...base, backendBinding: binding },
        mutation.at,
        "backend_restart_adopted",
      );
    }
    case "request_stop": {
      requireState(current, [
        "prepared",
        "launching",
        "running",
        "stopping",
        "backend_unavailable",
        "cleanup_blocked",
      ]);
      const reason = requiredEnum(
        data.reason,
        new Set<"cancelled" | "timed_out">(["cancelled", "timed_out"]),
        "stop reason",
      );
      const stopIntent = current.stopIntent ?? {
        reason,
        requestedAt: mutation.at,
      };
      const state =
        current.state === "running" || current.state === "backend_unavailable"
          ? "stopping"
          : current.state;
      return historyOnly(
        {
          ...base,
          stopIntent,
          state,
          ...(current.state === "cleanup_blocked" && current.result
            ? { result: { ...current.result, outcome: stopIntent.reason } }
            : {}),
        },
        mutation.at,
        stopIntent.reason,
      );
    }
    case "start_escalation": {
      requireState(current, ["stopping", "cleanup_blocked"]);
      if (current.escalation.some((entry) => entry.outcome === "requested"))
        throw new Error("An escalation effect is already pending.");
      const action = requiredEnum(
        data.action,
        new Set<ProcessEscalationAction>([
          "interrupt",
          "terminate",
          "force_terminate",
        ]),
        "action",
      );
      return historyOnly(
        {
          ...base,
          escalation: [
            ...current.escalation,
            { action, requestedAt: mutation.at, outcome: "requested" },
          ],
        },
        mutation.at,
        `${action}_requested`,
      );
    }
    case "finish_escalation": {
      if (current.state === "exited") {
        if (data.effectId === undefined)
          throw new Error(
            "Exited escalation completion requires its exact signal effect.",
          );
      } else requireState(current, ["stopping", "cleanup_blocked"]);
      const action = requiredEnum(
        data.action,
        new Set<ProcessEscalationAction>([
          "interrupt",
          "terminate",
          "force_terminate",
        ]),
        "action",
      );
      const outcome = requiredEnum(
        data.outcome,
        new Set<"running" | "exited" | "failed">([
          "running",
          "exited",
          "failed",
        ]),
        "outcome",
      );
      const pending = current.escalation.at(-1);
      if (
        !pending ||
        pending.outcome !== "requested" ||
        pending.action !== action
      )
        throw new Error(
          "Escalation completion has no matching durable request.",
        );
      const durableOutcome = current.state === "exited" ? "exited" : outcome;
      const completed: DurableEscalationEntry = {
        ...pending,
        completedAt: mutation.at,
        outcome: durableOutcome,
        ...optionalText(data, "detail"),
      };
      return historyOnly(
        {
          ...base,
          escalation: [...current.escalation.slice(0, -1), completed],
        },
        mutation.at,
        `${action}_${durableOutcome}`,
      );
    }
    case "record_exit":
      requireState(current, ["running", "stopping", "backend_unavailable"]);
      return moveDerived(
        { ...base, observation: parseObservation(data.observation) },
        "exited",
        mutation.at,
      );
    case "resume_blocked_exit": {
      requireState(current, ["cleanup_blocked"]);
      if (!current.backendBinding)
        throw new Error("Blocked cleanup recovery requires backend identity.");
      const {
        result: _result,
        output: _output,
        emptyVerification: _emptyVerification,
        ...withoutTerminalBlocker
      } = base;
      return moveDerived(
        {
          ...withoutTerminalBlocker,
          cleanup: { state: "pending" },
          observation: parseObservation(data.observation),
        },
        "exited",
        mutation.at,
        "blocked_identity_exited",
      );
    }
    case "begin_verify":
      requireState(current, ["exited"]);
      return moveDerived(
        { ...base, output: parseOutput(data.output) },
        "verifying_empty",
        mutation.at,
      );
    case "complete":
      requireState(current, ["verifying_empty"]);
      if (data.effectId !== undefined && current.emptyVerification?.empty !== true)
        throw new Error("Backend emptiness has not been verified.");
      return moveDerived(
        {
          ...base,
          cleanup: parseCleanup(data.cleanup),
          result: parseResult(data.result),
        },
        "cleaned",
        mutation.at,
      );
    case "fail_launch":
      requireState(current, ["prepared", "launching"]);
      return moveDerived(
        {
          ...base,
          result: { outcome: "launch_failed", finishedAt: mutation.at },
          cleanup: { state: "not_required" },
        },
        "launch_not_proven",
        mutation.at,
        text(data.detail, "detail"),
      );
    case "fail": {
      requireState(current, [
        "prepared",
        "launching",
        "running",
        "stopping",
        "exited",
        "verifying_empty",
        "backend_unavailable",
        "cleanup_blocked",
      ]);
      const state = requiredEnum(
        data.state,
        new Set<
          | "orphaned"
          | "identity_mismatch"
          | "backend_unavailable"
          | "outcome_unknown"
          | "cleanup_blocked"
        >([
          "orphaned",
          "identity_mismatch",
          "backend_unavailable",
          "outcome_unknown",
          "cleanup_blocked",
        ]),
        "failure state",
      );
      return moveDerived(
        {
          ...base,
          ...(data.cleanup === undefined
            ? {}
            : { cleanup: parseCleanup(data.cleanup) }),
          ...(data.result === undefined
            ? {}
            : { result: parseResult(data.result) }),
          ...(data.output === undefined
            ? {}
            : { output: parseOutput(data.output) }),
        },
        state,
        mutation.at,
        text(data.detail, "detail"),
      );
    }
    case "settle_output_cleanup":
      requireState(current, ["cleanup_blocked"]);
      if (current.backendBinding || current.result?.outcome !== "launch_failed")
        throw new Error("Output cleanup settlement is invalid.");
      {
        const { outputPrepareFailure: _failure, ...withoutFailure } = base;
        return moveDerived(
          { ...withoutFailure, cleanup: { state: "not_required" } },
          "launch_not_proven",
          mutation.at,
          "output_owner_cleaned",
        );
      }
    case "record_output_reopen":
      return historyOnly(base, mutation.at, "output_reopened");
    case "record_reconciliation":
      const outcome = requiredEnum(
        data.outcome,
        new Set<
          "running" | "exited" | "identity_mismatch" | "outcome_unknown"
        >([
          "running",
          "exited",
          "identity_mismatch",
          "outcome_unknown",
        ]),
        "reconciliation outcome",
      );
      if (
        outcome !== "exited" &&
        (data.exitCode !== undefined || data.signal !== undefined)
      )
        throw new Error("Non-exit reconciliation contains exit evidence.");
      if (data.exitCode !== undefined)
        requiredInteger(
          data.exitCode,
          "reconciliation exitCode",
          -2147483648,
          2147483647,
        );
      if (data.signal !== undefined)
        text(data.signal, "reconciliation signal");
      return historyOnly(
        base,
        mutation.at,
        `backend_reconciled_${outcome}`,
      );
    case "record_empty_verification":
      return historyOnly(
        current.state === "verifying_empty"
          ? {
              ...base,
              emptyVerification: parseEmptyVerification(data.verification),
            }
          : base,
        mutation.at,
        "backend_empty_verified",
      );
    case "record_exceptional_observation": {
      requireExceptionalState(current);
      identityProof(data.identityProof, current);
      const observed = requiredEnum(
        data.outcome,
        new Set<"running" | "exited" | "identity_mismatch" | "outcome_unknown">([
          "running",
          "exited",
          "identity_mismatch",
          "outcome_unknown",
        ]),
        "exceptional recovery outcome",
      );
      // Observation only: the lifecycle classification and cleanup proof are
      // deliberately left untouched.
      return historyOnly(base, mutation.at, `exceptional_recovery_observed_${observed}`);
    }
    case "resume_exceptional_exit": {
      requireExceptionalState(current);
      identityProof(data.identityProof, current);
      const { result: _result, output: _output, emptyVerification: _verification, ...recoverable } = base;
      return moveDerived({ ...recoverable, observation: parseObservation(data.observation), cleanup: { state: "pending" } },
        "exited", mutation.at, "exceptional_recovery_exited");
    }
  }
}

function requireExceptionalState(record: DurableSubprocessRecord): void {
  if (!EXCEPTIONAL_STATES.has(record.state))
    throw new Error(
      `Exceptional recovery is not legal from ${record.state}.`,
    );
}

function identityProof(value: unknown, record: DurableSubprocessRecord): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("Exceptional recovery identity proof is invalid.");
  if (!record.backendBinding || value !== durableRecoveryIdentity(record.backendBinding)) throw new Error("Recovery identity proof does not match this backend binding.");
  return value;
}

export function durableRecoveryIdentity(binding: DurableBackendBinding): string {
  // Registry/generation IDs are host-instance authority, not process identity.
  // Restart adoption is allowed only when the stable implementation and fresh
  // attestation still match, so recovery identity remains bound to those facts
  // plus the opaque native identity and birth proof.
  return createHash("sha256").update(JSON.stringify({
    backendId: binding.backendId,
    implementationDigest: binding.implementationDigest,
    attestationVersion: binding.attestationVersion,
    attestationDigest: binding.attestationDigest,
    opaqueIdentity: binding.opaqueIdentity,
    birthFingerprint: binding.birthFingerprint,
    ...(binding.rootPid === undefined ? {} : { rootPid: binding.rootPid }),
    startedAt: binding.startedAt,
  })).digest("hex");
}

function assertEffectMutationAllowed(
  record: DurableSubprocessRecord,
  kind: DurableProcessMutationKind,
): void {
  if (kind === "takeover_lease" && record.pendingEffects.length > 0)
    throw new Error("Process effect outcome is unresolved.");
  if (
    (kind === "settle_effect" || kind === "complete_effect") &&
    record.pendingEffects.length === 0
  )
    throw new Error("Durable process effect settlement has no matching start.");
}

function requiredPendingEffect(
  record: DurableSubprocessRecord,
  rawEffectId: unknown,
  phase: DurablePendingEffect["phase"],
): DurablePendingEffect {
  const effectId = safeId(rawEffectId, "effectId");
  const effect = record.pendingEffects.find(
    (candidate) => candidate.effectId === effectId,
  );
  if (
    !effect ||
    effect.effectId !== effectId ||
    effect.phase !== phase ||
    effect.ownerId !== record.ownerId ||
    effect.fencingToken !== record.fencingToken
  )
    throw new Error("Durable process effect settlement is stale or replayed.");
  return effect;
}

function consumeEffectForMutation(
  record: DurableSubprocessRecord,
  mutation: DurableProcessMutation,
): DurableSubprocessRecord {
  const rawEffectId = mutation.data.effectId;
  if (rawEffectId === undefined) {
    if (
      record.pendingEffects.some(
        (effect) =>
          effect.phase === "completed" &&
          EFFECT_CONSUMERS[effect.family].includes(mutation.kind),
      )
    )
      throw new Error("Completed process effect requires its exact effect ID.");
    return record;
  }
  if (
    mutation.kind === "begin_effect" ||
    mutation.kind === "settle_effect" ||
    mutation.kind === "complete_effect"
  )
    return record;
  const effect = requiredPendingEffect(record, rawEffectId, "completed");
  if (!EFFECT_CONSUMERS[effect.family].includes(mutation.kind))
    throw new Error("Completed process effect has the wrong semantic consumer family.");
  return {
    ...record,
    pendingEffects: record.pendingEffects.filter(
      ({ effectId }) => effectId !== effect.effectId,
    ),
  };
}

function historyOnly(
  current: DurableSubprocessRecord,
  at: string,
  reason: string,
): DurableSubprocessRecord {
  return {
    ...current,
    history: [...current.history, { state: current.state, at, reason }],
  };
}

function moveDerived(
  current: DurableSubprocessRecord,
  state: DurableSubprocessState,
  at: string,
  reason?: string,
): DurableSubprocessRecord {
  return {
    ...current,
    state,
    history: [...current.history, { state, at, ...(reason ? { reason } : {}) }],
  };
}

function commandData(
  command: OwnedDurableProcessCommand,
): Readonly<Record<string, unknown>> {
  switch (command.type) {
    case "begin_effect":
      return {
        effectId: command.effectId,
        family: command.family,
        resolution: command.resolution,
      };
    case "settle_effect":
    case "complete_effect":
      return {
        effectId: command.effectId,
        leaseExpiresAt: command.leaseExpiresAt,
      };
    case "renew_lease":
    case "takeover_lease":
      return { leaseExpiresAt: command.leaseExpiresAt };
    case "record_environment":
      return { environmentAudit: command.environmentAudit };
    case "record_output_prepare_failure":
    case "fail_launch":
    case "orphan_unbound_launch":
      return { detail: command.detail };
    case "bind_launch":
    case "adopt_backend":
      return { binding: command.binding };
    case "request_stop":
      return { reason: command.reason };
    case "start_escalation":
      return { action: command.action };
    case "finish_escalation":
      return {
        action: command.action,
        outcome: command.outcome,
        ...(command.detail === undefined ? {} : { detail: command.detail }),
        ...(command.effectId === undefined ? {} : { effectId: command.effectId }),
      };
    case "record_exit":
      return {
        observation: command.observation,
        ...(command.effectId === undefined ? {} : { effectId: command.effectId }),
      };
    case "resume_blocked_exit":
      return { observation: command.observation };
    case "begin_verify":
      return {
        output: command.output,
        ...(command.effectId === undefined ? {} : { effectId: command.effectId }),
      };
    case "complete":
      return {
        cleanup: command.cleanup,
        result: command.result,
        ...(command.effectId === undefined ? {} : { effectId: command.effectId }),
      };
    case "fail":
      return {
        state: command.state,
        detail: command.detail,
        ...(command.cleanup === undefined ? {} : { cleanup: command.cleanup }),
        ...(command.result === undefined ? {} : { result: command.result }),
        ...(command.output === undefined ? {} : { output: command.output }),
      };
    case "mark_launching":
    case "mark_output_prepared":
    case "settle_output_cleanup":
      return {};
    case "record_output_reopen":
      return { effectId: command.effectId };
    case "record_reconciliation":
      return {
        effectId: command.effectId,
        outcome: command.outcome,
        ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }),
        ...(command.signal === undefined ? {} : { signal: command.signal }),
      };
    case "record_empty_verification":
      return { effectId: command.effectId, verification: command.verification };
    case "record_exceptional_observation":
      return {
        effectId: command.effectId,
        identityProof: command.identityProof,
        outcome: command.outcome,
      };
    case "resume_exceptional_exit":
      return { effectId: command.effectId, identityProof: command.identityProof, observation: command.observation };
  }
}

function applyCommand(
  current: DurableSubprocessRecord,
  command: OwnedDurableProcessCommand,
): DurableSubprocessRecord {
  if (command.expectedRevision !== current.revision)
    throw new Error(`Process revision conflict for ${current.invocationId}.`);
  if (command.type === "takeover_lease") {
    if (current.pendingEffects.length > 0)
      throw new Error("Process effect outcome is unresolved.");
    if (Date.parse(current.leaseExpiresAt) > Date.parse(command.at))
      throw new Error("Process lease is still live.");
    if (command.fencingToken !== current.fencingToken + 1)
      throw new Error("Process fencing token is invalid.");
  } else if (command.type === "orphan_unbound_launch") {
    if (
      current.state !== "launching" ||
      current.backendBinding ||
      Date.parse(current.leaseExpiresAt) > Date.parse(command.at)
    )
      throw new Error("Unbound launch is not eligible for classification.");
    if (
      command.ownerId !== current.ownerId ||
      command.fencingToken !== current.fencingToken + 1
    )
      throw new Error("Process orphan fence is invalid.");
  } else if (
    command.ownerId !== current.ownerId ||
    command.fencingToken !== current.fencingToken
  ) {
    throw new Error("Process lease owner or fencing token is stale.");
  }
  // `orphaned`, `identity_mismatch` and `outcome_unknown` are frozen terminal
  // classifications: before exceptional recovery existed, no command at all was
  // legal from them. Only the closed recovery command set is added here, so no
  // routine lifecycle path gains authority it did not already have.
  if (
    FROZEN_EXCEPTIONAL_STATES.has(current.state) &&
    !EXCEPTIONAL_RECOVERY_COMMANDS.has(command.type)
  )
    throw new Error(
      `Illegal process transition from ${current.state}.`,
    );
  assertEffectMutationAllowed(current, command.type);
  const mutation = parseMutation({
    kind: command.type,
    revision: current.revision + 1,
    ownerId: command.ownerId,
    fencingToken: command.fencingToken,
    at:
      command.type === "start_escalation"
        ? command.requestedAt
        : command.type === "finish_escalation"
          ? command.completedAt
          : command.at,
    data: commandData(command),
  });
  const next = deriveRecord([...current.mutations, mutation]);
  assertStateInvariants(next);
  assertDurableProcessValue(next);
  return deepFreeze(structuredClone(next));
}
function compareRetry(
  existing: DurableSubprocessRecord,
  incoming: DurableSubprocessRecord,
): DurableSubprocessRecord {
  if (
    existing.requestFingerprint !== incoming.requestFingerprint ||
    existing.retryKey !== incoming.retryKey
  )
    throw new Error(
      `Process idempotency conflict for ${incoming.invocationId}.`,
    );
  return cloneRecord(existing);
}
function claimRetry(
  existing: DurableSubprocessRecord,
  incoming: DurableSubprocessRecord,
): DurableClaimResult {
  compareRetry(existing, incoming);
  const now = incoming.history[0]!.at;
  if (
    existing.state === "prepared" &&
    Date.parse(existing.leaseExpiresAt) <= Date.parse(now)
  ) {
    const record = applyCommand(existing, {
      type: "takeover_lease",
      invocationId: existing.invocationId,
      expectedRevision: existing.revision,
      ownerId: incoming.ownerId,
      fencingToken: existing.fencingToken + 1,
      at: now,
      leaseExpiresAt: incoming.leaseExpiresAt,
    });
    return Object.freeze({ record, won: true });
  }
  return Object.freeze({ record: cloneRecord(existing), won: false });
}
function assertStateInvariants(record: DurableSubprocessRecord): void {
  if (
    record.history[0]?.state !== "prepared" ||
    record.history.length !== record.revision + 1 ||
    record.mutations.length !== record.revision + 1 ||
    record.mutations.at(-1)?.revision !== record.revision
  )
    throw new Error("Durable process mutation/history/revision is invalid.");
  if (record.state !== "prepared" && !record.outputPrepared)
    throw new Error(
      "Durable process output must be prepared from launching onward.",
    );
  if (
    record.outputPrepareFailure &&
    (record.state !== "prepared" || record.outputPrepared)
  )
    throw new Error("Durable output prepare failure is inconsistent.");
  if (
    record.pendingEffects.some(
      (effect) =>
        effect.ownerId !== record.ownerId ||
        effect.fencingToken !== record.fencingToken ||
        (effect.phase === "completed" && effect.resolution !== "commit"),
    )
  )
    throw new Error("Durable pending effect authority is inconsistent.");
  const needsBinding = [
    "running",
    "stopping",
    "exited",
    "verifying_empty",
    "cleaned",
  ].includes(record.state);
  if (needsBinding && !record.backendBinding)
    throw new Error(
      `Durable process record in ${record.state} requires backend binding.`,
    );
  if (
    record.backendBinding &&
    ![
      "running",
      "stopping",
      "exited",
      "verifying_empty",
      "cleaned",
      "identity_mismatch",
      "backend_unavailable",
      "outcome_unknown",
      "cleanup_blocked",
    ].includes(record.state)
  )
    throw new Error("Durable process backend binding is inconsistent.");
  if (record.state === "stopping" && !record.stopIntent)
    throw new Error("Durable process record in stopping requires stop intent.");
  if (
    record.emptyVerification &&
    !["verifying_empty", "cleanup_blocked", "cleaned"].includes(record.state)
  )
    throw new Error("Durable empty verification is inconsistent.");
  if (
    record.stopIntent &&
    ![
      "prepared",
      "launching",
      "running",
      "stopping",
      "exited",
      "verifying_empty",
      "cleaned",
      "identity_mismatch",
      "backend_unavailable",
      "outcome_unknown",
      "cleanup_blocked",
    ].includes(record.state)
  )
    throw new Error("Durable stop intent is inconsistent.");
  if (
    ["exited", "verifying_empty", "cleaned"].includes(record.state) &&
    !record.observation
  )
    throw new Error(
      `Durable process record in ${record.state} requires observation.`,
    );
  if (
    record.observation &&
    ![
      "exited",
      "verifying_empty",
      "cleaned",
      "backend_unavailable",
      "outcome_unknown",
      "cleanup_blocked",
    ].includes(record.state)
  )
    throw new Error("Durable observation is inconsistent.");
  if (["verifying_empty", "cleaned"].includes(record.state) && !record.output)
    throw new Error(
      `Durable process record in ${record.state} requires output.`,
    );
  if (
    record.output &&
    ![
      "verifying_empty",
      "cleaned",
      "backend_unavailable",
      "outcome_unknown",
      "cleanup_blocked",
    ].includes(record.state)
  )
    throw new Error("Durable output is inconsistent.");
  if (
    record.state === "cleaned" &&
    (!record.result ||
      record.cleanup.state !== "verified_empty" ||
      !resultMatches(record))
  )
    throw new Error(
      "Durable process record in cleaned requires consistent verified cleanup and result.",
    );
  if (
    record.state === "cleanup_blocked" &&
    (!record.result ||
      record.cleanup.state !== "failed" ||
      !resultMatches(record))
  )
    throw new Error(
      "Durable process record in cleanup_blocked requires consistent failed cleanup and result.",
    );
  if (
    record.state === "launch_not_proven" &&
    (record.result?.outcome !== "launch_failed" ||
      record.cleanup.state !== "not_required" ||
      record.observation)
  )
    throw new Error("Durable process record in launch_not_proven is invalid.");
  if (
    !["cleaned", "cleanup_blocked", "launch_not_proven"].includes(
      record.state,
    ) &&
    record.result
  )
    throw new Error(
      `Durable process record in ${record.state} cannot contain a result.`,
    );
  if (
    !["cleaned", "cleanup_blocked", "launch_not_proven"].includes(
      record.state,
    ) &&
    record.cleanup.state !== "pending"
  )
    throw new Error("Nonterminal durable process cleanup must be pending.");
  if (
    record.escalation.length > 0 &&
    ![
      "stopping",
      "exited",
      "verifying_empty",
      "cleaned",
      "backend_unavailable",
      "identity_mismatch",
      "outcome_unknown",
      "cleanup_blocked",
    ].includes(record.state)
  )
    throw new Error("Durable process escalation history is invalid.");
  const pending = record.escalation.filter(
    (entry) => entry.outcome === "requested",
  );
  if (
    pending.length > 1 ||
    record.escalation.length > 3 ||
    record.escalation.some(
      (entry, index) =>
        entry.action !== ["interrupt", "terminate", "force_terminate"][index],
    ) ||
    (record.escalation.length > 0 && !record.stopIntent)
  )
    throw new Error("Durable process escalation history is invalid.");
  validateHistory(record.history);
  if (record.history.at(-1)?.state !== record.state)
    throw new Error("Durable process history does not match current state.");
}
function parseHistory(
  value: unknown,
  _state: DurableSubprocessState,
): DurableSubprocessHistoryEntry[] {
  if (!Array.isArray(value) || value.length < 1)
    throw new Error("Durable process history is invalid.");
  return value.map((entry) => {
    const object = strictRecord(entry, "history entry");
    assertKeys(object, new Set(["state", "at", "reason"]), "history entry");
    return {
      state: requiredEnum(object.state, STATES, "history state"),
      at: text(object.at, "history at"),
      ...optionalText(object, "reason"),
    };
  });
}
function parseAudit(value: unknown): DurableEnvironmentAudit {
  const o = strictRecord(value, "environment audit");
  assertKeys(
    o,
    new Set([
      "inheritedNames",
      "removedNames",
      "explicitSafeNames",
      "grantedNames",
    ]),
    "environment audit",
  );
  return {
    inheritedNames: strings(o.inheritedNames),
    removedNames: strings(o.removedNames),
    explicitSafeNames: strings(o.explicitSafeNames),
    grantedNames: strings(o.grantedNames),
  };
}
function parseBinding(value: unknown): DurableBackendBinding {
  const o = strictRecord(value, "backend binding");
  assertKeys(
    o,
    new Set([
      "registryId",
      "backendId",
      "implementationGeneration",
      "implementationDigest",
      "attestationVersion",
      "attestationDigest",
      "capabilities",
      "lifecycle",
      "opaqueIdentity",
      "birthFingerprint",
      "rootPid",
      "startedAt",
    ]),
    "backend binding",
  );
  const birth = strictRecord(o.birthFingerprint, "birth fingerprint");
  assertKeys(
    birth,
    new Set(["observedAt", "discriminator"]),
    "birth fingerprint",
  );
  const attestationVersion = requiredInteger(o.attestationVersion, "attestationVersion", 1);
  if (attestationVersion !== 1 && attestationVersion !== 2) throw new Error("Backend binding attestation version is unsupported.");
  const lifecycle = o.lifecycle === undefined ? undefined : parseExecutionLifecycleAttestation(o.lifecycle);
  if (attestationVersion === 1 && lifecycle !== undefined) throw new Error("Legacy backend binding cannot claim v2 lifecycle scope.");
  if (attestationVersion === 2 && lifecycle === undefined) throw new Error("V2 backend binding is missing lifecycle scope.");
  return {
    registryId: safeId(o.registryId, "registryId"),
    backendId: text(o.backendId, "backendId"),
    implementationGeneration: safeId(
      o.implementationGeneration,
      "implementationGeneration",
    ),
    implementationDigest: digest(
      o.implementationDigest,
      "implementationDigest",
    ),
    attestationVersion,
    attestationDigest: digest(o.attestationDigest, "attestationDigest"),
    ...(o.capabilities === undefined ? {} : { capabilities: parseExecutionSafetyCapabilities(o.capabilities) }),
    ...(lifecycle === undefined ? {} : { lifecycle }),
    opaqueIdentity: text(o.opaqueIdentity, "opaqueIdentity"),
    birthFingerprint: {
      observedAt: text(birth.observedAt, "observedAt"),
      discriminator: text(birth.discriminator, "discriminator"),
    },
    ...(o.rootPid === undefined
      ? {}
      : { rootPid: requiredInteger(o.rootPid, "rootPid", 1) }),
    startedAt: text(o.startedAt, "startedAt"),
  };
}
function parseStop(value: unknown): DurableStopIntent {
  const o = strictRecord(value, "stop intent");
  assertKeys(o, new Set(["reason", "requestedAt"]), "stop intent");
  return {
    reason: requiredEnum(
      o.reason,
      new Set(["cancelled", "timed_out"]),
      "stop reason",
    ),
    requestedAt: text(o.requestedAt, "requestedAt"),
  };
}
function parseEscalation(value: unknown): DurableEscalationEntry[] {
  if (!Array.isArray(value)) throw new Error("Escalation history is invalid.");
  return value.map((entry) => {
    const o = strictRecord(entry, "escalation entry");
    assertKeys(
      o,
      new Set(["action", "requestedAt", "completedAt", "outcome", "detail"]),
      "escalation entry",
    );
    const outcome = requiredEnum(
      o.outcome,
      new Set<"requested" | "running" | "exited" | "failed">([
        "requested",
        "running",
        "exited",
        "failed",
      ]),
      "outcome",
    );
    if (outcome === "requested" && o.completedAt !== undefined)
      throw new Error("Requested escalation cannot already be completed.");
    if (outcome !== "requested" && o.completedAt === undefined)
      throw new Error("Completed escalation requires completion time.");
    return {
      action: requiredEnum(
        o.action,
        new Set(["interrupt", "terminate", "force_terminate"]),
        "action",
      ),
      requestedAt: text(o.requestedAt, "requestedAt"),
      ...(o.completedAt === undefined
        ? {}
        : { completedAt: text(o.completedAt, "completedAt") }),
      outcome,
      ...optionalText(o, "detail"),
    };
  });
}
function parseObservation(value: unknown): DurableChildObservation {
  const o = strictRecord(value, "observation");
  assertKeys(o, new Set(["exitCode", "signal", "observedAt"]), "observation");
  return {
    ...(o.exitCode === undefined
      ? {}
      : {
          exitCode: requiredInteger(
            o.exitCode,
            "exitCode",
            -2147483648,
            2147483647,
          ),
        }),
    ...optionalText(o, "signal"),
    observedAt: text(o.observedAt, "observedAt"),
  };
}
function parseOutputPrepareFailure(
  value: unknown,
): DurableOutputPrepareFailure {
  const o = strictRecord(value, "output prepare failure");
  assertKeys(o, new Set(["failedAt", "detail"]), "output prepare failure");
  return {
    failedAt: dateText(o.failedAt, "failedAt"),
    detail: text(o.detail, "detail"),
  };
}
function parsePendingEffect(value: unknown): DurablePendingEffect {
  const o = strictRecord(value, "pending effect");
  assertKeys(
    o,
    new Set([
      "effectId",
      "family",
      "phase",
      "resolution",
      "ownerId",
      "fencingToken",
      "startedAt",
      "completedAt",
    ]),
    "pending effect",
  );
  const phase = requiredEnum(
    o.phase,
    new Set<"started" | "completed">(["started", "completed"]),
    "effect phase",
  );
  if ((phase === "completed") !== (o.completedAt !== undefined))
    throw new Error("Pending effect completion evidence is invalid.");
  return {
    effectId: safeId(o.effectId, "effectId"),
    family: requiredEnum(o.family, EFFECT_FAMILIES, "effect family"),
    phase,
    resolution: requiredEnum(
      o.resolution,
      new Set<"settle" | "commit">(["settle", "commit"]),
      "effect resolution",
    ),
    ownerId: safeId(o.ownerId, "effect ownerId"),
    fencingToken: requiredInteger(o.fencingToken, "effect fencingToken", 1),
    startedAt: dateText(o.startedAt, "effect startedAt"),
    ...(o.completedAt === undefined
      ? {}
      : { completedAt: dateText(o.completedAt, "effect completedAt") }),
  };
}
function parsePendingEffects(value: unknown): DurablePendingEffect[] {
  if (!Array.isArray(value)) throw new Error("Pending effect journal is invalid.");
  const effects = value.map(parsePendingEffect);
  if (new Set(effects.map(({ effectId }) => effectId)).size !== effects.length)
    throw new Error("Pending effect journal contains a duplicate effect ID.");
  return effects;
}
function parseEmptyVerification(value: unknown): DurableEmptyVerification {
  const o = strictRecord(value, "empty verification");
  if (o.empty === true) {
    assertKeys(o, new Set(["empty", "proofArtifactId"]), "empty verification");
    return { empty: true, ...optionalText(o, "proofArtifactId") };
  }
  if (o.empty === false) {
    assertKeys(o, new Set(["empty", "detail"]), "empty verification");
    return { empty: false, detail: text(o.detail, "detail") };
  }
  throw new Error("Empty verification is invalid.");
}
function parseOutput(value: unknown): ProcessOutputDisposition[] {
  if (!Array.isArray(value)) throw new Error("Output is invalid.");
  return value.map((entry) => {
    const o = strictRecord(entry, "output disposition");
    assertKeys(
      o,
      new Set([
        "stream",
        "tail",
        "tailBytesBase64",
        "tailByteLength",
        "totalBytes",
        "truncated",
        "spillArtifactId",
        "spillBytes",
        "lossyBytes",
      ]),
      "output disposition",
    );
    return parseProcessOutputDisposition(o);
  });
}
function parseResult(value: unknown): DurableSubprocessResult {
  const o = strictRecord(value, "result");
  assertKeys(
    o,
    new Set(["outcome", "exitCode", "signal", "startedAt", "finishedAt"]),
    "result",
  );
  return {
    outcome: requiredEnum(
      o.outcome,
      new Set([
        "exited",
        "timed_out",
        "cancelled",
        "launch_failed",
        "cleanup_failed",
      ]),
      "result outcome",
    ),
    ...(o.exitCode === undefined
      ? {}
      : {
          exitCode: requiredInteger(
            o.exitCode,
            "exitCode",
            -2147483648,
            2147483647,
          ),
        }),
    ...optionalText(o, "signal"),
    ...optionalText(o, "startedAt"),
    finishedAt: text(o.finishedAt, "finishedAt"),
  };
}
function parseCleanup(value: unknown): ProcessCleanupStatus {
  const o = strictRecord(value, "cleanup");
  const state = requiredEnum(
    o.state,
    new Set<"not_required" | "pending" | "verified_empty" | "failed">([
      "not_required",
      "pending",
      "verified_empty",
      "failed",
    ]),
    "cleanup state",
  );
  if (state === "not_required") {
    assertKeys(o, new Set(["state"]), "cleanup");
    return { state: "not_required" };
  }
  if (state === "pending") {
    assertKeys(o, new Set(["state"]), "cleanup");
    return { state: "pending" };
  }
  if (state === "verified_empty") {
    assertKeys(
      o,
      new Set(["state", "verifiedAt", "proofArtifactId"]),
      "cleanup",
    );
    return {
      state: "verified_empty",
      verifiedAt: text(o.verifiedAt, "verifiedAt"),
      ...optionalText(o, "proofArtifactId"),
    };
  }
  assertKeys(o, new Set(["state", "failedAt", "code", "detail"]), "cleanup");
  return {
    state: "failed",
    failedAt: text(o.failedAt, "failedAt"),
    code: text(o.code, "code"),
    detail: text(o.detail, "detail"),
  };
}
function parseLifecycleScope(value: unknown): ExecutionLifecycleScope {
  return requiredEnum(
    value,
    new Set<ExecutionLifecycleScope>(["process_group", "contained_workload"]),
    "requiredLifecycleScope",
  );
}
function parseCapabilities(value: unknown): ExecutionSafetyCapabilityName[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    throw new Error("Capabilities are invalid.");
  const all = {
    tree_termination: "enforced",
    crash_cleanup: "enforced",
    verified_emptiness: "enforced",
    write_confinement: "enforced",
  };
  parseExecutionSafetyCapabilities(all);
  const allowed = new Set(Object.keys(all));
  if (value.some((v) => !allowed.has(v as string)))
    throw new Error("Capabilities are invalid.");
  return [...value] as ExecutionSafetyCapabilityName[];
}
function strictRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    throw new Error(`${label} is invalid.`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new Error(`${label} is invalid.`);
  const desc = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(desc)) {
    if (typeof key !== "string" || !("value" in desc[key]!))
      throw new Error(`${label} is invalid.`);
    out[key] = desc[key]!.value;
  }
  return out;
}
function assertKeys(
  object: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  const key = Object.keys(object).find((candidate) => !allowed.has(candidate));
  if (key) throw new Error(`${label} contains unknown field ${key}.`);
}
function assertExactKeys(
  object: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  assertKeys(object, new Set([...required, ...optional]), label);
  const missing = required.find((key) => !Object.hasOwn(object, key));
  if (missing) throw new Error(`${label} is missing ${missing}.`);
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} is invalid.`);
  return value;
}
function safeId(value: unknown, label: string): string {
  const v = text(value, label);
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(v))
    throw new Error(`${label} is invalid.`);
  return v;
}
function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error(`${label} is invalid.`);
  return value;
}
function requiredInteger(
  value: unknown,
  label: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    throw new Error(`${label} is invalid.`);
  return value as number;
}
function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid.`);
  return value;
}
function dateText(value: unknown, label: string): string {
  const valueText = text(value, label);
  if (Number.isNaN(Date.parse(valueText)))
    throw new Error(`${label} is invalid.`);
  return valueText;
}
function requiredEnum<T extends string>(
  value: unknown,
  allowed: Set<T>,
  label: string,
): T {
  if (typeof value !== "string" || !allowed.has(value as T))
    throw new Error(`${label} is invalid.`);
  return value as T;
}
function optionalText<K extends string>(
  o: Record<string, unknown>,
  key: K,
): { [P in K]?: string } {
  return o[key] === undefined
    ? {}
    : ({ [key]: text(o[key], key) } as { [P in K]?: string });
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    throw new Error("String list is invalid.");
  return [...value] as string[];
}
function requireState(
  record: DurableSubprocessRecord,
  states: readonly DurableSubprocessState[],
): void {
  if (!states.includes(record.state))
    throw new Error(`Illegal process transition from ${record.state}.`);
}
function validateHistory(
  history: readonly DurableSubprocessHistoryEntry[],
): void {
  for (let index = 1; index < history.length; index += 1) {
    const prior = history[index - 1]!.state;
    const entry = history[index]!;
    const next = entry.state;
    if (LEGAL_HISTORY[prior].includes(next)) continue;
    if (EXCEPTIONAL_STATES.has(prior) && next === "exited" && entry.reason === "exceptional_recovery_exited") continue;
    // The only additional legal edges are exceptional-recovery self-entries,
    // whose reasons are derived from the closed exceptional mutation kinds and
    // from the lease/journal mutations those kinds require.
    if (
      prior === next &&
      EXCEPTIONAL_STATES.has(prior) &&
      entry.reason !== undefined &&
      EXCEPTIONAL_SELF_HISTORY_REASONS.has(entry.reason)
    )
      continue;
    throw new Error(
      `Durable process history contains illegal transition ${prior} -> ${next}.`,
    );
  }
}
function requiredRecord(
  record: DurableSubprocessRecord | undefined,
  id: string,
): DurableSubprocessRecord {
  if (!record) throw new Error(`Unknown process invocation ${id}.`);
  return record;
}
function cloneRecord(record: DurableSubprocessRecord): DurableSubprocessRecord {
  return parseDurableSubprocessRecord(record);
}
function assertDurableProcessValue(record: DurableSubprocessRecord): void {
  const snapshot = structuredClone(record) as unknown as Record<
    string,
    unknown
  >;
  delete snapshot.fencingToken;
  if (Array.isArray(snapshot.pendingEffects))
    snapshot.pendingEffects = snapshot.pendingEffects.map((entry) => {
      const effect = { ...(entry as Record<string, unknown>) };
      delete effect.fencingToken;
      return effect;
    });
  if (Array.isArray(snapshot.mutations)) {
    snapshot.mutations = snapshot.mutations.map((entry) => {
      const mutation = { ...(entry as Record<string, unknown>) };
      delete mutation.fencingToken;
      return mutation;
    });
  }
  assertDurableExecutionSafetyValue(snapshot);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
  }
  return value;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function snapshotKey(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.byteLength < 32)
    throw new Error("Runner state integrity key is invalid.");
  return new Uint8Array(key);
}
function hmac(key: Uint8Array, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}
function safeEqual(left: string, right: unknown): boolean {
  if (typeof right !== "string" || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { errcode?: unknown; message?: unknown };
  return (
    value.errcode === 5 ||
    value.errcode === 6 ||
    (typeof value.message === "string" &&
      /database (?:is )?(?:locked|busy)/i.test(value.message))
  );
}
function synchronousBackoff(milliseconds: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, milliseconds);
}
function resultMatches(record: DurableSubprocessRecord): boolean {
  const result = record.result!;
  if (record.stopIntent && result.outcome !== record.stopIntent.reason)
    return false;
  if (
    !record.stopIntent &&
    record.state === "cleaned" &&
    result.outcome !== "exited"
  )
    return false;
  if (
    record.observation?.exitCode !== result.exitCode ||
    record.observation?.signal !== result.signal
  )
    return false;
  if (record.backendBinding?.startedAt !== result.startedAt) return false;
  return true;
}
