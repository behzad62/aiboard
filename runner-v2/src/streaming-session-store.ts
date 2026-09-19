import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseEvidenceContinuation, type EvidenceContinuation } from "./evidence-continuation.js";
import { parseExecutionSafetyCapabilities, type ExecutionSafetyCapabilities } from "./execution-safety-contracts.js";

export type StreamingSessionStoreErrorCode =
  | "invalid_record"
  | "unknown_field"
  | "invalid_state"
  | "unsafe_downgrade"
  | "unsupported_active_version"
  | "unsupported_version"
  | "forbidden_durable_value"
  | "capacity_exceeded"
  | "identity_conflict"
  | "revision_conflict"
  | "stale_fence"
  | "lease_expired"
  | "lease_not_expired"
  | "invalid_effect";

export class StreamingSessionStoreError extends Error {
  constructor(readonly code: StreamingSessionStoreErrorCode, message: string) {
    super(message);
    this.name = "StreamingSessionStoreError";
  }
}

export const STREAMING_SESSION_RECORD_KIND = "runner.streaming-session" as const;
export const STREAMING_SESSION_RECORD_VERSION = 4 as const;

export type StreamingSessionState =
  | "pending_transfer"
  | "transfer_ambiguous"
  | "active"
  | "stopping"
  | "cleanup_pending"
  | "cleanup_blocked"
  | "released"
  | "input_unavailable"
  | "backend_unavailable"
  | "outcome_unknown";

export type StreamingSessionCleanupOwner =
  | "tool_broker"
  | "provider_lease"
  | "session_authority"
  | "none";

export interface StreamingSessionAccess {
  readonly canonicalPath: string;
  readonly mode: "read" | "write" | "create";
}

export interface StreamingSessionEnvelope {
  readonly access: readonly StreamingSessionAccess[];
  readonly credentialNames: readonly string[];
  readonly networkApproved: boolean;
  readonly externalApproved: boolean;
  readonly destructiveApproved: boolean;
}

export interface StreamingSessionLease {
  readonly leaseId: string;
  readonly providerId: string;
  readonly invocationId: string;
  readonly providerIdentity: string;
  readonly acquiredAt: string;
  readonly expiresAt?: string;
  readonly access: readonly StreamingSessionAccess[];
}

export interface StreamingSessionBackendBinding {
  readonly registryId: string;
  readonly backendId: string;
  readonly implementationGeneration: string;
  readonly implementationDigest: string;
  readonly attestationVersion: number;
  readonly attestationDigest: string;
  /** Exact semantic states reported by the selected backend attestation. */
  readonly capabilities?: ExecutionSafetyCapabilities;
  readonly opaqueIdentity: string;
  readonly birthFingerprint: Readonly<{
    observedAt: string;
    discriminator: string;
  }>;
  readonly rootPid?: number;
  readonly startedAt: string;
}

export interface StreamingSessionEffect {
  readonly effectId: string;
  readonly kind: "transfer" | "cleanup";
  readonly status: "pending" | "acknowledged" | "blocked";
  readonly owner: StreamingSessionCleanupOwner;
  readonly fencingToken: number;
  readonly createdAt: string;
  readonly acknowledgedAt?: string;
  readonly blockedAt?: string;
  readonly cleanupProvenance?: StreamingSessionCleanupProvenance;
  readonly progress?: AdoptedCleanupProgress;
}

export type AdoptedCleanupResourceKind =
  | "workload_quiescence"
  | "retained_output_settlement"
  | "evidence"
  | "channel_detach"
  | "backend_release"
  | "isolation_release";
export type AdoptedCleanupResourceStatus = "pending" | "in_flight" | "verified" | "blocked";
export type AdoptedCleanupBlockerCode =
  | "workload_outcome_unknown"
  | "output_settlement_unavailable"
  | "evidence_continuation_unavailable"
  | "evidence_finalization_failed"
  | "channel_detach_failed"
  | "backend_release_reconciliation_required"
  | "isolation_release_failed"
  | "cleanup_deadline_expired"
  | "cleanup_deadline_before_effect"
  | "cleanup_effect_outcome_unknown"
  | "cleanup_authority_unavailable";
export interface AdoptedCleanupBlocker {
  readonly code: AdoptedCleanupBlockerCode;
  readonly message: string;
}
export interface AdoptedCleanupAttempt {
  readonly attemptId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly startedAt: string;
  readonly deadlineAt: string;
}
export interface AdoptedCleanupEvidenceReference {
  readonly kind: "same_runtime_finalization" | "bounded_output_manifest";
  readonly digest: string;
  readonly lossy: boolean;
  readonly lossReason?: "evidence_write_failed" | "bounded_output_loss";
}
export interface AdoptedCleanupResourceFact {
  readonly resource: AdoptedCleanupResourceKind;
  readonly identity: string;
  readonly status: AdoptedCleanupResourceStatus;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly attempts: number;
  readonly attempt?: AdoptedCleanupAttempt;
  readonly blocker?: AdoptedCleanupBlocker;
  readonly verifiedAt?: string;
  readonly evidence?: AdoptedCleanupEvidenceReference;
}
export interface AdoptedCleanupProgress {
  readonly resources: readonly AdoptedCleanupResourceFact[];
}

export function deriveAdoptedCleanupAttemptId(input: Readonly<{
  effectId: string;
  resource: AdoptedCleanupResourceKind;
  ordinal: number;
  ownerId: string;
  fencingToken: number;
}>): string {
  const digest = createHash("sha256").update(JSON.stringify([
    "runner.adopted-cleanup-attempt.v1",
    input.effectId,
    input.resource,
    input.ordinal,
    input.ownerId,
    input.fencingToken,
  ])).digest("hex");
  return `cleanup-attempt:${digest}`;
}

export const ADOPTED_CLEANUP_BLOCKER_MESSAGES: Readonly<Record<AdoptedCleanupBlockerCode, string>> = Object.freeze({
  workload_outcome_unknown: "Workload quiescence could not be verified.",
  output_settlement_unavailable: "Retained output settlement could not be verified.",
  evidence_continuation_unavailable: "Durable evidence continuation is unavailable.",
  evidence_finalization_failed: "Evidence finalization failed.",
  channel_detach_failed: "Streaming channel detach failed.",
  backend_release_reconciliation_required: "Backend release requires reconciliation.",
  isolation_release_failed: "Isolation release failed.",
  cleanup_deadline_expired: "Cleanup deadline expired.",
  cleanup_deadline_before_effect: "Cleanup deadline expired before effect issuance.",
  cleanup_effect_outcome_unknown: "Cleanup effect outcome is unknown.",
  cleanup_authority_unavailable: "Cleanup authority is unavailable.",
});

/** Immutable origin plus every one-step durable re-fence of a cleanup effect. */
export interface StreamingSessionCleanupProvenance {
  readonly effectId: string;
  readonly originOwnerId: string;
  readonly originFencingToken: number;
  readonly takeovers: readonly StreamingSessionCleanupTakeover[];
}

export interface StreamingSessionCleanupTakeover {
  readonly fromOwnerId: string;
  readonly fromFencingToken: number;
  readonly toOwnerId: string;
  readonly toFencingToken: number;
  readonly at: string;
}

/** Durable authority fact written when cleanup is created and never re-fenced. */
export interface StreamingSessionCleanupCreationAuthority {
  readonly effectId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly createdAt: string;
}

export interface StreamingSessionHistoryEntry {
  readonly state: StreamingSessionState;
  readonly at: string;
}

export interface StreamingSessionRecord {
  readonly recordKind: typeof STREAMING_SESSION_RECORD_KIND;
  readonly schemaVersion: 0 | 1 | 2 | 3 | typeof STREAMING_SESSION_RECORD_VERSION;
  readonly revision: number;
  readonly sessionId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: string;
  readonly runId: string;
  readonly agentSessionId: string;
  readonly actor: Readonly<{ role: "architect" | "worker" | "subagent" | "verifier" | "system" | "user" | "runner_internal"; id: string }>;
  readonly toolName: string;
  readonly callId: string;
  readonly envelope: StreamingSessionEnvelope;
  readonly lease: StreamingSessionLease;
  readonly backendBinding: StreamingSessionBackendBinding;
  readonly cleanupCreationAuthority?: StreamingSessionCleanupCreationAuthority | null;
  readonly cleanupOwner: StreamingSessionCleanupOwner;
  readonly state: StreamingSessionState;
  readonly history: readonly StreamingSessionHistoryEntry[];
  readonly effects: readonly StreamingSessionEffect[];
}

const PENDING_TRANSFER_KEYS = new Set([
  "recordKind",
  "schemaVersion",
  "revision",
  "sessionId",
  "ownerId",
  "fencingToken",
  "leaseExpiresAt",
  "runId",
  "agentSessionId",
  "actor",
  "toolName",
  "callId",
  "envelope",
  "lease",
  "backendBinding",
  "cleanupCreationAuthority",
  "cleanupOwner",
  "state",
  "history",
  "effects",
]);

const LEGACY_STREAMING_SESSION_KEYS = new Set(
  [...PENDING_TRANSFER_KEYS].filter((key) => key !== "cleanupCreationAuthority"),
);

const STREAMING_SESSION_STATES = new Set([
  "pending_transfer",
  "transfer_ambiguous",
  "active",
  "stopping",
  "cleanup_pending",
  "cleanup_blocked",
  "released",
  "input_unavailable",
  "backend_unavailable",
  "outcome_unknown",
]);

export interface StreamingSessionStore {
  readBySession(sessionId: string): Readonly<StreamingSessionRecord> | undefined;
  listSessionIds(): readonly string[];
  readHostLaunch(launchId: string): Readonly<HostLaunchRecord> | undefined;
  listHostLaunchIds(): readonly string[];
  readOutputCheckpoint(sessionId: string): Readonly<OutputCheckpointRecord> | undefined;
  close(): void;
}

export interface StreamingSessionStoreWriter {
  claim(record: unknown): Readonly<{ record: Readonly<StreamingSessionRecord>; won: boolean }>;
  apply(command: unknown): Readonly<StreamingSessionRecord>;
}

export interface StreamingSessionStoreKernel {
  readonly store: StreamingSessionStore;
}

export interface StreamingSessionStoreOptions {
  readonly maxRecords?: number;
  readonly maxEffectsPerRecord?: number;
  readonly maxHostLaunchRecords?: number;
  readonly maxOutputCheckpointRecords?: number;
}

export const HOST_LAUNCH_RECORD_KIND = "runner.host-launch" as const;
export const HOST_LAUNCH_RECORD_VERSION = 2 as const;
export type HostLaunchState = "prepared" | "isolated" | "launching" | "bound" |
  "handshake_verified" | "handed_off" | "cleanup_pending" | "cleanup_blocked" | "released";
export type HostCleanupResourceKind = "channel" | "output_checkpoint" | "host" | "isolation_lease";
export type HostCleanupFailureCode = "channel_detach_failed" | "output_checkpoint_delete_failed" |
  "host_reconciliation_failed" | "host_outcome_unknown" | "isolation_lease_release_failed" |
  "cleanup_timeout_or_cancelled" | "unknown_internal_cleanup_failure";
export interface HostCleanupFailure { readonly code: HostCleanupFailureCode; readonly message: string }
export const HOST_CLEANUP_FAILURE_MESSAGES: Readonly<Record<HostCleanupFailureCode, string>> = Object.freeze({
  channel_detach_failed: "Streaming channel detach failed.",
  output_checkpoint_delete_failed: "Output checkpoint deletion failed.",
  host_reconciliation_failed: "Host reconciliation failed.",
  host_outcome_unknown: "Host outcome is unknown.",
  isolation_lease_release_failed: "Isolation lease release failed.",
  cleanup_timeout_or_cancelled: "Cleanup timed out or was cancelled.",
  unknown_internal_cleanup_failure: "Internal cleanup failed.",
});
export interface HostCleanupResourceFact {
  readonly resource: HostCleanupResourceKind;
  readonly identity: string;
  readonly status: "pending" | "succeeded" | "failed";
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly attempts: number;
  readonly failure?: HostCleanupFailure;
  readonly evidence?: AdoptedCleanupEvidenceReference;
}
export interface HostLaunchEffect {
  readonly effectId: string;
  readonly kind: "isolate" | "launch" | "handoff" | "cleanup";
  readonly status: "pending" | "acknowledged" | "blocked";
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly createdAt: string;
  readonly acknowledgedAt?: string;
  readonly blockedAt?: string;
  readonly blocker?: HostCleanupFailure;
  readonly originOwnerId?: string;
  readonly originFencingToken?: number;
  readonly takeovers?: readonly Readonly<{ fromOwnerId: string; fromFencingToken: number; toOwnerId: string; toFencingToken: number; at: string }>[];
  readonly resources?: readonly HostCleanupResourceFact[];
}
export interface HostLaunchRecord {
  readonly recordKind: typeof HOST_LAUNCH_RECORD_KIND;
  readonly schemaVersion: typeof HOST_LAUNCH_RECORD_VERSION;
  readonly revision: number;
  readonly launchId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly agentSessionId: string;
  readonly actor: Readonly<{ role: "architect" | "worker" | "subagent" | "verifier" | "system" | "user" | "runner_internal"; id: string }>;
  readonly toolName: string;
  readonly callId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly ownerExpiresAt: string;
  readonly state: HostLaunchState;
  readonly cleanupOwner: "host_control" | "none";
  readonly leaseBinding?: StreamingSessionLease;
  readonly backendBinding?: StreamingSessionBackendBinding;
  readonly handshakeDigest?: string;
  readonly channelAcquisitionStartedAt?: string;
  readonly outputCheckpointCreatedAt?: string;
  readonly history: readonly Readonly<{ state: HostLaunchState; at: string }>[];
  readonly effects: readonly HostLaunchEffect[];
}

export interface StreamingSessionKernelWriter extends StreamingSessionStoreWriter {
  prepareLaunch(record: unknown): Readonly<{ record: Readonly<HostLaunchRecord>; won: boolean }>;
  transitionLaunch(command: unknown): Readonly<HostLaunchRecord>;
  commitAdoption(input: StreamingSessionAdoptionInput): Readonly<{ launch: Readonly<HostLaunchRecord>; session: Readonly<StreamingSessionRecord> }>;
  claimOutputCheckpoint(record: unknown): Readonly<{ record: Readonly<OutputCheckpointRecord>; won: boolean }>;
  claimHostOutputCheckpoint(command: unknown): Readonly<{ host: Readonly<HostLaunchRecord>; record: Readonly<OutputCheckpointRecord>; won: boolean }>;
  bootstrapHostCleanupOutputCheckpoint(command: unknown): Readonly<{ host: Readonly<HostLaunchRecord>; record: Readonly<OutputCheckpointRecord>; won: boolean }>;
  applyOutputCheckpoint(command: unknown): Readonly<OutputCheckpointRecord>;
  deleteOutputCheckpoint(command: unknown): void;
  takeoverAdoptedWithOutput(command: unknown): Readonly<{ session: Readonly<StreamingSessionRecord>; output: Readonly<OutputCheckpointRecord> }>;
}
export interface StreamingSessionAdoptionInput {
  readonly launchId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly expectedRevision: number;
  readonly at: string;
  readonly sessionRecord: unknown;
}
export const OUTPUT_CHECKPOINT_RECORD_KIND = "runner.output-checkpoint" as const;
export const OUTPUT_CHECKPOINT_RECORD_VERSION = 1 as const;
export interface OutputChunkMetadata {
  readonly stream: "stdout" | "stderr"; readonly sequence: number; readonly startOffset: number;
  readonly endOffset: number; readonly byteLength: number; readonly digest: string;
}
export interface OutputStreamCheckpoint {
  readonly stream: "stdout" | "stderr";
  readonly lastConsumed: OutputChunkMetadata | null;
  /** Bounded exact replay authentication window, oldest to newest. */
  readonly consumed: readonly OutputChunkMetadata[];
  readonly accepted: readonly OutputChunkMetadata[];
  readonly consumingIntent: OutputChunkMetadata | null;
}
export interface OutputCheckpointRecord {
  readonly recordKind: typeof OUTPUT_CHECKPOINT_RECORD_KIND;
  readonly schemaVersion: 1 | 2;
  readonly revision: number; readonly sessionId: string; readonly ownerId: string; readonly fencingToken: number;
  readonly capacity: number; readonly outcome: "active" | "outcome_unknown";
  readonly streams: readonly OutputStreamCheckpoint[];
  readonly continuation?: EvidenceContinuation;
}

export interface SqliteStreamingSessionStoreOptions extends StreamingSessionStoreOptions {
  readonly readOnly?: boolean;
  /** Deterministic transaction-boundary test seam; production leaves this unset. */
  readonly adoptionFault?: (point: "before_session_insert" | "after_session_insert" | "before_launch_handoff_update" | "after_launch_handoff_update" | "before_commit" | "after_commit") => void;
}

const STORE_WRITER = Symbol("streaming-session-store-writer");
const KERNEL_WRITER = Symbol("streaming-session-kernel-writer");

export function createInMemoryStreamingSessionStore(
  options: StreamingSessionStoreOptions = {},
): StreamingSessionStoreKernel {
  const maxRecords = options.maxRecords ?? 256;
  const maxEffectsPerRecord = options.maxEffectsPerRecord ?? 32;
  const maxHostLaunchRecords = positiveCapacity(options.maxHostLaunchRecords ?? 256, "maxHostLaunchRecords");
  const maxOutputCheckpointRecords = positiveCapacity(options.maxOutputCheckpointRecords ?? 256, "maxOutputCheckpointRecords");
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session maxRecords must be a positive integer.");
  }
  if (!Number.isSafeInteger(maxEffectsPerRecord) || maxEffectsPerRecord < 1) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session maxEffectsPerRecord must be a positive integer.");
  }
  const records = new Map<string, Readonly<StreamingSessionRecord>>();
  const hostLaunches = new Map<string, Readonly<HostLaunchRecord>>();
  const outputCheckpoints = new Map<string, Readonly<OutputCheckpointRecord>>();
  const writer: StreamingSessionStoreWriter = Object.freeze({
    claim(record: unknown) {
      const parsed = parseStreamingSessionRecord(record);
      const sessionId = requiredText(parsed.sessionId, "sessionId");
      if (parsed.effects.length > maxEffectsPerRecord) {
        throw new StreamingSessionStoreError(
          "capacity_exceeded",
          "Streaming session effect capacity is full; existing cleanup evidence was retained.",
        );
      }
      const existing = records.get(sessionId);
      if (existing) {
        if (!sameStreamingSessionIdentity(existing, parsed)) {
          throw new StreamingSessionStoreError(
            "identity_conflict",
            "Streaming session id belongs to a different immutable authority.",
          );
        }
        return Object.freeze({ record: cloneRecord(existing), won: false });
      }
      if (records.size >= maxRecords) {
        throw new StreamingSessionStoreError(
          "capacity_exceeded",
          "Streaming session capacity is full; active ownership was retained.",
        );
      }
      records.set(sessionId, parsed);
      return Object.freeze({ record: cloneRecord(parsed), won: true });
    },
    apply(command: unknown) {
      const input = commandRecord(command, "streaming session command");
      const sessionId = requiredText(input.sessionId, "sessionId");
      const current = records.get(sessionId);
      if (!current) throw new StreamingSessionStoreError("invalid_record", "Streaming session is unknown.");
      const next = applyStreamingSessionCommand(current, input, maxEffectsPerRecord, outputCheckpoints.get(sessionId));
      const deleteOutput = settledSessionEvidenceCheckpoint(next, outputCheckpoints.get(sessionId));
      records.set(sessionId, next);
      if (deleteOutput) outputCheckpoints.delete(sessionId);
      return cloneRecord(next);
    },
  });
  const store: StreamingSessionStore = Object.freeze({
    readBySession(sessionId: string) {
      const record = records.get(sessionId);
      return record ? cloneRecord(record) : undefined;
    },
    listSessionIds() {
      return Object.freeze([...records.keys()].sort());
    },
    readHostLaunch(launchId: string) {
      const record = hostLaunches.get(launchId);
      if (record?.state === "handed_off") assertHostSessionIdentity(record, records.get(record.sessionId));
      if (record) assertHostOutputCheckpointLink(record, outputCheckpoints.get(record.sessionId));
      return record ? cloneHostLaunchRecord(record) : undefined;
    },
    listHostLaunchIds() {
      return Object.freeze([...hostLaunches.keys()].sort());
    },
    readOutputCheckpoint(sessionId: string) {
      const record = outputCheckpoints.get(sessionId);
      return record ? deepFreeze(structuredClone(record)) : undefined;
    },
    close() {},
  });
  const kernel = { store } as StreamingSessionStoreKernel;
  Object.defineProperty(kernel, STORE_WRITER, { value: writer });
  Object.defineProperty(kernel, KERNEL_WRITER, {
    value: createHostLaunchWriter(writer, records, hostLaunches, outputCheckpoints, maxHostLaunchRecords, maxRecords, maxOutputCheckpointRecords),
  });
  return Object.freeze(kernel);
}

export function openSqliteStreamingSessionStore(
  path: string,
  integrityKey: Uint8Array,
  options: SqliteStreamingSessionStoreOptions = {},
): StreamingSessionStoreKernel {
  if (!(integrityKey instanceof Uint8Array) || integrityKey.byteLength < 16) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session integrity key is invalid.");
  }
  const maxRecords = options.maxRecords ?? 256;
  const maxEffectsPerRecord = options.maxEffectsPerRecord ?? 32;
  const maxHostLaunchRecords = positiveCapacity(options.maxHostLaunchRecords ?? 256, "maxHostLaunchRecords");
  const maxOutputCheckpointRecords = positiveCapacity(options.maxOutputCheckpointRecords ?? 256, "maxOutputCheckpointRecords");
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session maxRecords must be a positive integer.");
  }
  if (!Number.isSafeInteger(maxEffectsPerRecord) || maxEffectsPerRecord < 1) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session maxEffectsPerRecord must be a positive integer.");
  }
  const readOnly = options.readOnly === true;
  if (!readOnly) mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path, { readOnly });
  if (!readOnly) {
    database.exec(
      "CREATE TABLE IF NOT EXISTS streaming_sessions (" +
      "session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, integrity TEXT NOT NULL, revision INTEGER NOT NULL)",
    );
    database.exec(
      "CREATE TABLE IF NOT EXISTS streaming_host_launches (" +
      "launch_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, integrity TEXT NOT NULL, revision INTEGER NOT NULL)",
    );
    database.exec(
      "CREATE TABLE IF NOT EXISTS streaming_output_checkpoints (" +
      "session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, integrity TEXT NOT NULL, revision INTEGER NOT NULL)",
    );
    const columns = database.prepare("PRAGMA table_info(streaming_sessions)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "revision")) {
      database.exec("ALTER TABLE streaming_sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
    }
  }
  const read = (sessionId: string): Readonly<StreamingSessionRecord> | undefined => {
    const row = database.prepare(
      "SELECT record_json, integrity, revision FROM streaming_sessions WHERE session_id = ?",
    ).get(sessionId) as { record_json: string; integrity: string; revision: number } | undefined;
    if (!row) return undefined;
    const actual = createHmac("sha256", integrityKey).update(row.record_json).digest();
    const expected = Buffer.from(row.integrity, "hex");
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      throw new StreamingSessionStoreError("invalid_record", "Streaming session durable record integrity failed.");
    }
    try {
      const parsed = parseStreamingSessionRecord(JSON.parse(row.record_json));
      if (parsed.revision !== row.revision) {
        throw new StreamingSessionStoreError("invalid_record", "Streaming session durable record revision is corrupt.");
      }
      return parsed;
    } catch (error) {
      if (error instanceof StreamingSessionStoreError) throw error;
      throw new StreamingSessionStoreError("invalid_record", "Streaming session durable record is corrupt.");
    }
  };
  const writer: StreamingSessionStoreWriter = Object.freeze({
    claim(record: unknown) {
      if (readOnly) throw new StreamingSessionStoreError("invalid_record", "Streaming session store is read-only.");
      const parsed = parseStreamingSessionRecord(record);
      const sessionId = requiredText(parsed.sessionId, "sessionId");
      if (parsed.effects.length > maxEffectsPerRecord) {
        throw new StreamingSessionStoreError(
          "capacity_exceeded",
          "Streaming session effect capacity is full; existing cleanup evidence was retained.",
        );
      }
      const recordJson = JSON.stringify(parsed);
      const integrity = createHmac("sha256", integrityKey).update(recordJson).digest("hex");
      const result = database.prepare(
        "INSERT OR IGNORE INTO streaming_sessions (session_id, record_json, integrity, revision) " +
        "SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM streaming_sessions) < ?",
      ).run(sessionId, recordJson, integrity, parsed.revision, maxRecords) as { changes?: number };
      if (result.changes === 1) return Object.freeze({ record: cloneRecord(parsed), won: true });
      const existing = read(sessionId);
      if (existing) {
        if (!sameStreamingSessionIdentity(existing, parsed)) {
          throw new StreamingSessionStoreError(
            "identity_conflict",
            "Streaming session id belongs to a different immutable authority.",
          );
        }
        return Object.freeze({ record: cloneRecord(existing), won: false });
      }
      throw new StreamingSessionStoreError("capacity_exceeded", "Streaming session capacity is full; active ownership was retained.");
    },
    apply(command: unknown) {
      if (readOnly) throw new StreamingSessionStoreError("invalid_record", "Streaming session store is read-only.");
      const input = commandRecord(command, "streaming session command");
      const sessionId = requiredText(input.sessionId, "sessionId");
      const terminalTransaction = input.type === "acknowledge_cleanup" || input.type === "observe_finalized_evidence";
      if (terminalTransaction) database.exec("BEGIN IMMEDIATE");
      try {
      const current = read(sessionId);
      if (!current) throw new StreamingSessionStoreError("invalid_record", "Streaming session is unknown.");
      const checkpoint = terminalTransaction ? readSqliteOutputCheckpoint(database, integrityKey, sessionId) : undefined;
      const next = applyStreamingSessionCommand(current, input, maxEffectsPerRecord, checkpoint);
      const deleteOutput = settledSessionEvidenceCheckpoint(next, checkpoint);
      const recordJson = JSON.stringify(next);
      const integrity = createHmac("sha256", integrityKey).update(recordJson).digest("hex");
      const result = database.prepare(
        "UPDATE streaming_sessions SET record_json = ?, integrity = ?, revision = ? WHERE session_id = ? AND revision = ?",
      ).run(recordJson, integrity, next.revision, sessionId, current.revision) as { changes?: number };
      if (result.changes !== 1) {
        throw new StreamingSessionStoreError("revision_conflict", "Streaming session revision is stale.");
      }
      if (deleteOutput) database.prepare("DELETE FROM streaming_output_checkpoints WHERE session_id = ? AND revision = ?").run(sessionId, checkpoint!.revision);
      if (terminalTransaction) database.exec("COMMIT");
      return cloneRecord(next);
      } catch (error) { if (terminalTransaction) database.exec("ROLLBACK"); throw error; }
    },
  });
  const store: StreamingSessionStore = Object.freeze({
    readBySession: read,
    listSessionIds() {
      return Object.freeze(
        (database.prepare("SELECT session_id FROM streaming_sessions ORDER BY session_id").all() as Array<{ session_id: string }>)
          .map((row) => row.session_id),
      );
    },
    readHostLaunch(launchId: string) {
      const record = readSqliteHostLaunch(database, integrityKey, launchId);
      if (record?.state === "handed_off") assertHostSessionIdentity(record, read(record.sessionId));
      if (record) assertHostOutputCheckpointLink(record, readSqliteOutputCheckpoint(database, integrityKey, record.sessionId));
      return record;
    },
    listHostLaunchIds() {
      const launchIds = (database.prepare(
        "SELECT launch_id FROM streaming_host_launches ORDER BY launch_id",
      ).all() as Array<{ launch_id: string }>).map((row) => row.launch_id);
      for (const launchId of launchIds) readSqliteHostLaunch(database, integrityKey, launchId);
      return Object.freeze(launchIds);
    },
    readOutputCheckpoint(sessionId: string) {
      return readSqliteOutputCheckpoint(database, integrityKey, sessionId);
    },
    close() {
      database.close();
    },
  });
  const kernel = { store } as StreamingSessionStoreKernel;
  Object.defineProperty(kernel, STORE_WRITER, { value: writer });
  Object.defineProperty(kernel, KERNEL_WRITER, {
    value: createSqliteHostLaunchWriter(database, integrityKey, writer, maxHostLaunchRecords, maxRecords, maxOutputCheckpointRecords, readOnly, options.adoptionFault, read),
  });
  return Object.freeze(kernel);
}

export function getStreamingSessionStoreWriter(
  kernel: StreamingSessionStoreKernel,
): StreamingSessionStoreWriter {
  const writer = Object.getOwnPropertyDescriptor(kernel, STORE_WRITER)?.value;
  if (!writer || typeof writer.claim !== "function") {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session store writer is unavailable.");
  }
  return writer as StreamingSessionStoreWriter;
}

export function getStreamingSessionKernelWriter(
  kernel: StreamingSessionStoreKernel,
): StreamingSessionKernelWriter {
  const writer = Object.getOwnPropertyDescriptor(kernel, KERNEL_WRITER)?.value;
  if (!writer || typeof writer.prepareLaunch !== "function" || typeof writer.transitionLaunch !== "function") {
    throw new StreamingSessionStoreError("invalid_record", "Atomic streaming-session kernel writer is unavailable.");
  }
  return writer as StreamingSessionKernelWriter;
}

export function parseStreamingSessionRecord(value: unknown): Readonly<StreamingSessionRecord> {
  if (!isObjectRecord(value)) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session record must be an object.");
  }
  const record = value;
  assertNoForbiddenDurableValues(record);
  const recordKeys = record.schemaVersion === 0 || record.schemaVersion === 1 || record.schemaVersion === 2
    ? LEGACY_STREAMING_SESSION_KEYS
    : PENDING_TRANSFER_KEYS;
  assertExactKeys(record, recordKeys, "streaming session record");
  assertRequiredKeys(record, recordKeys, "streaming session record");
  if (record.recordKind !== STREAMING_SESSION_RECORD_KIND) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session record kind is invalid.");
  }
  if (record.schemaVersion === 0 && record.state !== "released") {
    throw new StreamingSessionStoreError(
      "unsafe_downgrade",
      "An active streaming-session record cannot be downgraded to the historical schema.",
    );
  }
  if (record.schemaVersion !== STREAMING_SESSION_RECORD_VERSION &&
      record.schemaVersion !== 3 && record.schemaVersion !== 2 && record.schemaVersion !== 1 && record.schemaVersion !== 0) {
    throw new StreamingSessionStoreError(
      record.state === "released" ? "unsupported_version" : "unsupported_active_version",
      "Streaming session schema version is unsupported.",
    );
  }
  if (!STREAMING_SESSION_STATES.has(record.state as string)) {
    throw new StreamingSessionStoreError("invalid_state", "Streaming session state is invalid.");
  }
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session revision is invalid.");
  }
  for (const name of ["sessionId", "ownerId", "runId", "agentSessionId", "toolName", "callId"] as const) {
    requiredText(record[name], name);
  }
  if (!Number.isSafeInteger(record.fencingToken) || (record.fencingToken as number) < 1) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session fencing token is invalid.");
  }
  assertTimestamp(record.leaseExpiresAt, "leaseExpiresAt");
  parseActor(record.actor);
  parseEnvelope(record.envelope);
  parseLease(record.lease);
  parseBackendBinding(record.backendBinding);
  const cleanupCreationAuthority = (record.schemaVersion as number) >= 3
    ? parseCleanupCreationAuthority(record.cleanupCreationAuthority)
    : undefined;
  const history = parseHistory(record.history);
  const effects = parseEffects(record.effects, record.schemaVersion as StreamingSessionRecord["schemaVersion"]);
  if (record.schemaVersion === 2 && record.state !== "released" &&
      effects.some((effect) => effect.kind === "cleanup")) {
    throw new StreamingSessionStoreError(
      "unsupported_active_version",
      "Active version-2 cleanup evidence has no independently verifiable creation authority.",
    );
  }
  if (record.schemaVersion === 3 && record.state !== "released" &&
      effects.some((effect) => effect.kind === "cleanup" && effect.owner === "session_authority")) {
    return parseStreamingSessionRecord({
      ...record,
      schemaVersion: STREAMING_SESSION_RECORD_VERSION,
      effects: effects.map((effect) => effect.kind === "cleanup"
        ? { ...effect, progress: { resources: beginAdoptedCleanupResources(record as unknown as StreamingSessionRecord) } }
        : effect),
    });
  }
  assertAdoptedCleanupProgress(record as unknown as StreamingSessionRecord, effects);
  assertStateCombination(record as Partial<StreamingSessionRecord>, effects, cleanupCreationAuthority);
  assertHistoryForState(history, record.state as StreamingSessionState, record.revision as number);
  return deepFreeze(structuredClone(record)) as Readonly<StreamingSessionRecord>;
}

export function digestStreamingSessionRecord(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

const FORBIDDEN_DURABLE_KEYS = new Set([
  "opaqueGrant",
  "grant",
  "bearerToken",
  "token",
  "controlPort",
  "inputPayload",
  "payload",
  "writer",
  "nativeHandle",
  "channel",
  "endpoint",
  "liveEndpoint",
  "liveCapability",
]);

function assertNoForbiddenDurableValues(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) assertNoForbiddenDurableValues(entry);
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_DURABLE_KEYS.has(key)) {
      throw new StreamingSessionStoreError(
        "forbidden_durable_value",
        `Streaming session record cannot persist ${key}.`,
      );
    }
    assertNoForbiddenDurableValues(nested);
  }
}

function assertExactKeys(value: unknown, allowed: ReadonlySet<string>, label: string): void {
  if (!isObjectRecord(value)) {
    throw new StreamingSessionStoreError("invalid_record", `${label} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new StreamingSessionStoreError("unknown_field", `${label} has unknown field ${key}.`);
    }
  }
}

function assertRequiredKeys(value: Record<string, unknown>, required: ReadonlySet<string>, label: string): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new StreamingSessionStoreError("invalid_record", `${label} is missing required field ${key}.`);
    }
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseActor(value: unknown): void {
  assertExactKeys(value, new Set(["role", "id"]), "streaming session actor");
  const actor = value as Record<string, unknown>;
  assertRequiredKeys(actor, new Set(["role", "id"]), "streaming session actor");
  if (!isActorRole(actor.role) || !isValidText(actor.id)) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session actor is invalid.");
  }
}

function parseEnvelope(value: unknown): void {
  assertExactKeys(
    value,
    new Set(["access", "credentialNames", "networkApproved", "externalApproved", "destructiveApproved"]),
    "streaming session access envelope",
  );
  const envelope = value as Record<string, unknown>;
  assertRequiredKeys(
    envelope,
    new Set(["access", "credentialNames", "networkApproved", "externalApproved", "destructiveApproved"]),
    "streaming session access envelope",
  );
  parseAccessArray(envelope.access, "streaming session envelope access");
  parseCredentialNames(envelope.credentialNames, "streaming session envelope credential names");
  for (const field of ["networkApproved", "externalApproved", "destructiveApproved"] as const) {
    if (typeof envelope[field] !== "boolean") {
      throw new StreamingSessionStoreError("invalid_record", `Streaming session envelope ${field} is invalid.`);
    }
  }
}

function parseLease(value: unknown): void {
  const allowed = new Set([
    "leaseId", "providerId", "invocationId", "providerIdentity", "acquiredAt", "expiresAt", "access",
  ]);
  assertExactKeys(value, allowed, "streaming session isolation lease");
  const lease = value as Record<string, unknown>;
  assertRequiredKeys(
    lease,
    new Set(["leaseId", "providerId", "invocationId", "providerIdentity", "acquiredAt", "access"]),
    "streaming session isolation lease",
  );
  for (const field of ["leaseId", "providerId", "invocationId"] as const) requiredText(lease[field], field);
  if (typeof lease.providerIdentity !== "string" || !/^[a-f0-9]{64}$/i.test(lease.providerIdentity)) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session provider identity is invalid.");
  }
  assertTimestamp(lease.acquiredAt, "lease.acquiredAt");
  if (lease.expiresAt !== undefined) assertTimestamp(lease.expiresAt, "lease.expiresAt");
  parseAccessArray(lease.access, "streaming session lease access");
}

function parseBackendBinding(value: unknown): void {
  const allowed = new Set([
    "registryId", "backendId", "implementationGeneration", "implementationDigest", "attestationVersion",
    "attestationDigest", "capabilities", "opaqueIdentity", "birthFingerprint", "rootPid", "startedAt",
  ]);
  assertExactKeys(value, allowed, "streaming session backend binding");
  const binding = value as Record<string, unknown>;
  assertRequiredKeys(
    binding,
    new Set([
      "registryId", "backendId", "implementationGeneration", "implementationDigest", "attestationVersion",
      "attestationDigest", "opaqueIdentity", "birthFingerprint", "startedAt",
    ]),
    "streaming session backend binding",
  );
  for (const field of ["registryId", "backendId", "implementationGeneration"] as const) {
    requiredText(binding[field], `backendBinding.${field}`);
  }
  requiredOpaqueBackendIdentity(binding.opaqueIdentity);
  for (const field of ["implementationDigest", "attestationDigest"] as const) {
    if (typeof binding[field] !== "string" || !/^[a-f0-9]{64}$/i.test(binding[field])) {
      throw new StreamingSessionStoreError("invalid_record", `Streaming session backend ${field} is invalid.`);
    }
  }
  if (!Number.isSafeInteger(binding.attestationVersion) || (binding.attestationVersion as number) < 1) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session backend attestation version is invalid.");
  }
  if (binding.capabilities !== undefined) parseExecutionSafetyCapabilities(binding.capabilities);
  if (binding.rootPid !== undefined &&
      (!Number.isSafeInteger(binding.rootPid) || (binding.rootPid as number) < 1)) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session backend root pid is invalid.");
  }
  assertTimestamp(binding.startedAt, "backendBinding.startedAt");
  assertExactKeys(
    binding.birthFingerprint,
    new Set(["observedAt", "discriminator"]),
    "streaming session backend birth fingerprint",
  );
  const birth = binding.birthFingerprint as Record<string, unknown>;
  assertRequiredKeys(birth, new Set(["observedAt", "discriminator"]), "streaming session backend birth fingerprint");
  assertTimestamp(birth.observedAt, "backendBinding.birthFingerprint.observedAt");
  requiredText(birth.discriminator, "backendBinding.birthFingerprint.discriminator");
}

function parseAccessArray(value: unknown, label: string): readonly StreamingSessionAccess[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new StreamingSessionStoreError("invalid_record", label + " is invalid.");
  }
  const result: StreamingSessionAccess[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    assertExactKeys(entry, new Set(["canonicalPath", "mode"]), label + " entry");
    const access = entry as Record<string, unknown>;
    assertRequiredKeys(access, new Set(["canonicalPath", "mode"]), label + " entry");
    if (!isValidText(access.canonicalPath) ||
        (access.mode !== "read" && access.mode !== "write" && access.mode !== "create")) {
      throw new StreamingSessionStoreError("invalid_record", label + " entry is invalid.");
    }
    const key = access.canonicalPath + "\0" + access.mode;
    if (seen.has(key)) throw new StreamingSessionStoreError("invalid_record", label + " has duplicate access.");
    seen.add(key);
    result.push({ canonicalPath: access.canonicalPath, mode: access.mode });
  }
  return result;
}

function parseCredentialNames(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new StreamingSessionStoreError("invalid_record", label + " is invalid.");
  }
  const seen = new Set<string>();
  for (const name of value) {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || seen.has(name)) {
      throw new StreamingSessionStoreError("invalid_record", label + " is invalid.");
    }
    seen.add(name);
  }
  return value;
}

function parseHistory(value: unknown): readonly StreamingSessionHistoryEntry[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session history is invalid.");
  }
  let previous = -Infinity;
  for (const entry of value) {
    assertExactKeys(entry, new Set(["state", "at"]), "streaming session history entry");
    const history = entry as Record<string, unknown>;
    assertRequiredKeys(history, new Set(["state", "at"]), "streaming session history entry");
    if (!STREAMING_SESSION_STATES.has(history.state as string)) {
      throw new StreamingSessionStoreError("invalid_state", "Streaming session history state is invalid.");
    }
    const timestamp = assertTimestamp(history.at, "history.at");
    if (timestamp < previous) {
      throw new StreamingSessionStoreError("invalid_record", "Streaming session history must be ordered.");
    }
    previous = timestamp;
  }
  return value as readonly StreamingSessionHistoryEntry[];
}

function parseEffects(
  value: unknown,
  schemaVersion: StreamingSessionRecord["schemaVersion"],
): readonly StreamingSessionEffect[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session effects are invalid.");
  }
  const effectIds = new Set<string>();
  const effectKinds = new Set<string>();
  for (const entry of value) {
    const allowed = new Set([
      "effectId", "kind", "status", "owner", "fencingToken", "createdAt", "acknowledgedAt", "blockedAt",
      "cleanupProvenance", "progress",
    ]);
    assertExactKeys(entry, allowed, "streaming session effect");
    const effect = entry as Record<string, unknown>;
    assertRequiredKeys(
      effect,
      new Set(["effectId", "kind", "status", "owner", "fencingToken", "createdAt"]),
      "streaming session effect",
    );
    requiredText(effect.effectId, "effectId");
    if ((effect.kind !== "transfer" && effect.kind !== "cleanup") || effectKinds.has(effect.kind)) {
      throw new StreamingSessionStoreError("invalid_effect", "Streaming session effect kind is invalid or duplicated.");
    }
    if (effect.status !== "pending" && effect.status !== "acknowledged" && effect.status !== "blocked") {
      throw new StreamingSessionStoreError("invalid_effect", "Streaming session effect status is invalid.");
    }
    if (!isCleanupOwner(effect.owner) || effect.owner === "none") {
      throw new StreamingSessionStoreError("invalid_effect", "Streaming session effect owner is invalid.");
    }
    if (!Number.isSafeInteger(effect.fencingToken) || (effect.fencingToken as number) < 1) {
      throw new StreamingSessionStoreError("invalid_effect", "Streaming session effect fence is invalid.");
    }
    assertTimestamp(effect.createdAt, "effect.createdAt");
    if (effect.status === "acknowledged") {
      assertTimestamp(effect.acknowledgedAt, "effect.acknowledgedAt");
      if (effect.blockedAt !== undefined) throw new StreamingSessionStoreError("invalid_effect", "Acknowledged effect is blocked.");
    } else if (effect.status === "blocked") {
      assertTimestamp(effect.blockedAt, "effect.blockedAt");
      if (effect.acknowledgedAt !== undefined) throw new StreamingSessionStoreError("invalid_effect", "Blocked effect is acknowledged.");
    } else if (effect.acknowledgedAt !== undefined || effect.blockedAt !== undefined) {
      throw new StreamingSessionStoreError("invalid_effect", "Pending effect has a terminal acknowledgement.");
    }
    if (effect.cleanupProvenance !== undefined) parseCleanupProvenance(effect.cleanupProvenance);
    if (schemaVersion < 2 && effect.cleanupProvenance !== undefined) {
      throw new StreamingSessionStoreError("invalid_state", "Legacy streaming-session effects cannot carry cleanup provenance.");
    }
    if (effect.progress !== undefined) {
      if (schemaVersion !== STREAMING_SESSION_RECORD_VERSION || effect.kind !== "cleanup") {
        throw new StreamingSessionStoreError("invalid_effect", "Only current cleanup effects can carry durable progress.");
      }
      parseAdoptedCleanupProgress(effect.progress);
    }
    if (effectIds.has(effect.effectId as string)) {
      throw new StreamingSessionStoreError("invalid_effect", "Streaming session effect id is duplicated.");
    }
    effectIds.add(effect.effectId as string);
    effectKinds.add(effect.kind as string);
  }
  return value as readonly StreamingSessionEffect[];
}

function parseCleanupCreationAuthority(
  value: unknown,
): StreamingSessionCleanupCreationAuthority | null {
  if (value === null) return null;
  assertExactKeys(
    value,
    new Set(["effectId", "ownerId", "fencingToken", "createdAt"]),
    "streaming session cleanup creation authority",
  );
  const authority = value as Record<string, unknown>;
  assertRequiredKeys(
    authority,
    new Set(["effectId", "ownerId", "fencingToken", "createdAt"]),
    "streaming session cleanup creation authority",
  );
  requiredText(authority.effectId, "cleanupCreationAuthority.effectId");
  requiredText(authority.ownerId, "cleanupCreationAuthority.ownerId");
  if (!Number.isSafeInteger(authority.fencingToken) || (authority.fencingToken as number) < 1) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session cleanup creation authority fence is invalid.");
  }
  assertTimestamp(authority.createdAt, "cleanupCreationAuthority.createdAt");
  return value as StreamingSessionCleanupCreationAuthority;
}

function parseCleanupProvenance(value: unknown): StreamingSessionCleanupProvenance {
  assertExactKeys(
    value,
    new Set(["effectId", "originOwnerId", "originFencingToken", "takeovers"]),
    "streaming session cleanup provenance",
  );
  const provenance = value as Record<string, unknown>;
  assertRequiredKeys(
    provenance,
    new Set(["effectId", "originOwnerId", "originFencingToken", "takeovers"]),
    "streaming session cleanup provenance",
  );
  requiredText(provenance.effectId, "cleanupProvenance.effectId");
  requiredText(provenance.originOwnerId, "cleanupProvenance.originOwnerId");
  if (!Number.isSafeInteger(provenance.originFencingToken) ||
      (provenance.originFencingToken as number) < 1) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session cleanup provenance origin fence is invalid.");
  }
  if (!Array.isArray(provenance.takeovers) || provenance.takeovers.length > 128) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session cleanup provenance takeovers are invalid.");
  }
  for (const entry of provenance.takeovers) {
    assertExactKeys(
      entry,
      new Set(["fromOwnerId", "fromFencingToken", "toOwnerId", "toFencingToken", "at"]),
      "streaming session cleanup takeover provenance",
    );
    const takeover = entry as Record<string, unknown>;
    assertRequiredKeys(
      takeover,
      new Set(["fromOwnerId", "fromFencingToken", "toOwnerId", "toFencingToken", "at"]),
      "streaming session cleanup takeover provenance",
    );
    requiredText(takeover.fromOwnerId, "cleanupProvenance.fromOwnerId");
    requiredText(takeover.toOwnerId, "cleanupProvenance.toOwnerId");
    for (const field of ["fromFencingToken", "toFencingToken"] as const) {
      if (!Number.isSafeInteger(takeover[field]) || (takeover[field] as number) < 1) {
        throw new StreamingSessionStoreError("invalid_record", "Streaming session cleanup takeover fence is invalid.");
      }
    }
    assertTimestamp(takeover.at, "cleanupProvenance.takeover.at");
  }
  return value as StreamingSessionCleanupProvenance;
}

const ADOPTED_CLEANUP_RESOURCE_ORDER: readonly AdoptedCleanupResourceKind[] = Object.freeze([
  "workload_quiescence",
  "retained_output_settlement",
  "evidence",
  "channel_detach",
  "backend_release",
  "isolation_release",
]);

function parseAdoptedCleanupProgress(value: unknown): AdoptedCleanupProgress {
  assertExactKeys(value, new Set(["resources"]), "adopted cleanup progress");
  const progress = value as Record<string, unknown>;
  assertRequiredKeys(progress, new Set(["resources"]), "adopted cleanup progress");
  if (!Array.isArray(progress.resources) || progress.resources.length !== ADOPTED_CLEANUP_RESOURCE_ORDER.length) {
    throw new StreamingSessionStoreError("invalid_effect", "Adopted cleanup progress must contain the exact resource set.");
  }
  const resources = progress.resources.map((entry, index) => parseAdoptedCleanupResource(entry, ADOPTED_CLEANUP_RESOURCE_ORDER[index]!));
  return Object.freeze({ resources: Object.freeze(resources) });
}

function parseAdoptedCleanupResource(
  value: unknown,
  expectedResource: AdoptedCleanupResourceKind,
): AdoptedCleanupResourceFact {
  assertExactKeys(value, new Set([
    "resource", "identity", "status", "ownerId", "fencingToken", "attempts", "attempt", "blocker",
    "verifiedAt", "evidence",
  ]), "adopted cleanup resource fact");
  const fact = value as Record<string, unknown>;
  assertRequiredKeys(fact, new Set(["resource", "identity", "status", "ownerId", "fencingToken", "attempts"]), "adopted cleanup resource fact");
  if (fact.resource !== expectedResource || !ADOPTED_CLEANUP_RESOURCE_ORDER.includes(fact.resource as AdoptedCleanupResourceKind)) {
    throw new StreamingSessionStoreError("invalid_effect", "Adopted cleanup resource is missing, duplicated, extra, or out of order.");
  }
  cleanupIdentity(fact.identity);
  if (!["pending", "in_flight", "verified", "blocked"].includes(fact.status as string)) {
    throw new StreamingSessionStoreError("invalid_effect", "Adopted cleanup resource status is invalid.");
  }
  const ownerId = requiredText(fact.ownerId, "cleanup resource ownerId");
  const fencingToken = requiredPositiveInteger(fact.fencingToken, "cleanup resource fencingToken");
  const attempts = requiredNonNegativeInteger(fact.attempts, "cleanup resource attempts");
  const attempt = fact.attempt === undefined ? undefined : parseAdoptedCleanupAttempt(fact.attempt);
  const blocker = fact.blocker === undefined ? undefined : parseAdoptedCleanupBlocker(fact.blocker);
  const verifiedAt = fact.verifiedAt === undefined ? undefined : requiredTimestamp(fact.verifiedAt, "cleanup verifiedAt");
  const evidence = fact.evidence === undefined ? undefined : parseAdoptedCleanupEvidenceReference(fact.evidence);
  if (fact.status === "pending" && (attempt || blocker || verifiedAt || evidence || attempts !== 0 && attempts < 1)) {
    throw new StreamingSessionStoreError("invalid_effect", "Pending cleanup resource carries terminal or in-flight evidence.");
  }
  if (fact.status === "in_flight" && (!attempt || blocker || verifiedAt || evidence || attempts < 1 ||
      attempt.ownerId !== ownerId || attempt.fencingToken !== fencingToken)) {
    throw new StreamingSessionStoreError("invalid_effect", "In-flight cleanup resource attempt is invalid.");
  }
  const retainsReconciliationAttempt = blocker !== undefined && retainsCleanupAttempt(blocker.code);
  if (fact.status === "blocked" && (!blocker || verifiedAt || evidence ||
      (attempts < 1 && blocker.code !== "cleanup_deadline_before_effect") ||
      (attempt !== undefined) !== retainsReconciliationAttempt)) {
    throw new StreamingSessionStoreError("invalid_effect", "Blocked cleanup resource evidence is invalid.");
  }
  if (fact.status === "verified" && (attempt || blocker || !verifiedAt || attempts < 1 ||
      (fact.resource === "evidence" ? !evidence : Boolean(evidence)))) {
    throw new StreamingSessionStoreError("invalid_effect", "Verified cleanup resource proof is invalid.");
  }
  return Object.freeze({
    resource: fact.resource as AdoptedCleanupResourceKind,
    identity: fact.identity as string,
    status: fact.status as AdoptedCleanupResourceStatus,
    ownerId,
    fencingToken,
    attempts,
    ...(attempt ? { attempt } : {}),
    ...(blocker ? { blocker } : {}),
    ...(verifiedAt ? { verifiedAt } : {}),
    ...(evidence ? { evidence } : {}),
  });
}

function parseAdoptedCleanupAttempt(value: unknown): AdoptedCleanupAttempt {
  assertExactKeys(value, new Set(["attemptId", "ownerId", "fencingToken", "startedAt", "deadlineAt"]), "adopted cleanup attempt");
  const attempt = value as Record<string, unknown>;
  assertRequiredKeys(attempt, new Set(["attemptId", "ownerId", "fencingToken", "startedAt", "deadlineAt"]), "adopted cleanup attempt");
  const startedAt = requiredTimestamp(attempt.startedAt, "cleanup attempt startedAt");
  const deadlineAt = requiredTimestamp(attempt.deadlineAt, "cleanup attempt deadlineAt");
  if (Date.parse(deadlineAt) < Date.parse(startedAt)) throw new StreamingSessionStoreError("invalid_effect", "Cleanup attempt deadline precedes its start.");
  return Object.freeze({
    attemptId: requiredText(attempt.attemptId, "cleanup attemptId"),
    ownerId: requiredText(attempt.ownerId, "cleanup attempt ownerId"),
    fencingToken: requiredPositiveInteger(attempt.fencingToken, "cleanup attempt fencingToken"),
    startedAt,
    deadlineAt,
  });
}

function parseAdoptedCleanupBlocker(value: unknown): AdoptedCleanupBlocker {
  assertExactKeys(value, new Set(["code", "message"]), "adopted cleanup blocker");
  const blocker = value as Record<string, unknown>;
  assertRequiredKeys(blocker, new Set(["code", "message"]), "adopted cleanup blocker");
  if (!Object.hasOwn(ADOPTED_CLEANUP_BLOCKER_MESSAGES, blocker.code as PropertyKey) ||
      blocker.message !== ADOPTED_CLEANUP_BLOCKER_MESSAGES[blocker.code as AdoptedCleanupBlockerCode]) {
    throw new StreamingSessionStoreError("invalid_effect", "Adopted cleanup blocker is not a bounded Runner category.");
  }
  return Object.freeze({ code: blocker.code as AdoptedCleanupBlockerCode, message: blocker.message as string });
}

function isRetryableCleanupBlocker(code: AdoptedCleanupBlockerCode): boolean {
  return code !== "workload_outcome_unknown" &&
    code !== "evidence_continuation_unavailable" &&
    code !== "evidence_finalization_failed" &&
    code !== "cleanup_effect_outcome_unknown" &&
    code !== "backend_release_reconciliation_required" &&
    code !== "cleanup_deadline_expired";
}

function retainsCleanupAttempt(code: AdoptedCleanupBlockerCode): boolean {
  return code === "cleanup_deadline_expired" || code === "cleanup_effect_outcome_unknown" ||
    code === "evidence_continuation_unavailable" || code === "backend_release_reconciliation_required";
}

function parseAdoptedCleanupEvidenceReference(value: unknown): AdoptedCleanupEvidenceReference {
  assertExactKeys(value, new Set(["kind", "digest", "lossy", "lossReason"]), "adopted cleanup evidence reference");
  const evidence = value as Record<string, unknown>;
  assertRequiredKeys(evidence, new Set(["kind", "digest", "lossy"]), "adopted cleanup evidence reference");
  if ((evidence.kind !== "same_runtime_finalization" && evidence.kind !== "bounded_output_manifest") ||
      typeof evidence.digest !== "string" || !/^[a-f0-9]{64}$/i.test(evidence.digest) ||
      typeof evidence.lossy !== "boolean" ||
      (evidence.lossReason !== undefined && evidence.lossReason !== "evidence_write_failed" && evidence.lossReason !== "bounded_output_loss") ||
      (evidence.lossy !== (evidence.lossReason !== undefined))) {
    throw new StreamingSessionStoreError("invalid_effect", "Adopted cleanup evidence reference is invalid.");
  }
  return Object.freeze({
    kind: evidence.kind as AdoptedCleanupEvidenceReference["kind"],
    digest: evidence.digest.toLowerCase(),
    lossy: evidence.lossy,
    ...(evidence.lossReason ? { lossReason: evidence.lossReason as AdoptedCleanupEvidenceReference["lossReason"] } : {}),
  });
}

function assertAdoptedCleanupProgress(
  record: Readonly<StreamingSessionRecord>,
  effects: readonly StreamingSessionEffect[],
): void {
  const cleanup = effects.find((effect) => effect.kind === "cleanup");
  if (record.schemaVersion !== STREAMING_SESSION_RECORD_VERSION) {
    if (effects.some((effect) => effect.progress !== undefined)) throw new StreamingSessionStoreError("invalid_effect", "Legacy cleanup cannot carry current progress.");
    return;
  }
  if (!cleanup) return;
  if (cleanup.owner !== "session_authority") {
    if (cleanup.progress) throw new StreamingSessionStoreError("invalid_effect", "Provider cleanup cannot carry adopted cleanup progress.");
    return;
  }
  if (!cleanup.progress) throw new StreamingSessionStoreError("invalid_effect", "Current cleanup is missing durable progress.");
  const progress = parseAdoptedCleanupProgress(cleanup.progress);
  const expected = deriveAdoptedCleanupResourceDefinitions(record);
  const validProofOwners = cleanupProofOwners(cleanup);
  const authorityAtByProofOwner = new Map<string, number>();
  const provenance = cleanup.cleanupProvenance;
  if (provenance) {
    authorityAtByProofOwner.set(
      `${provenance.originOwnerId}\0${provenance.originFencingToken}`,
      assertTimestamp(cleanup.createdAt, "cleanup.createdAt"),
    );
    for (const takeover of provenance.takeovers) {
      authorityAtByProofOwner.set(
        `${takeover.toOwnerId}\0${takeover.toFencingToken}`,
        assertTimestamp(takeover.at, "cleanupProvenance.takeover.at"),
      );
    }
  }
  const currentAuthorityAt = authorityAtByProofOwner.get(`${record.ownerId}\0${record.fencingToken}`);
  if (cleanup.blockedAt !== undefined && (currentAuthorityAt === undefined ||
      assertTimestamp(cleanup.blockedAt, "cleanup.blockedAt") < currentAuthorityAt)) {
    throw new StreamingSessionStoreError("invalid_effect", "Adopted cleanup blocker predates its current authority.");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const fact = progress.resources[index]!;
    const definition = expected[index]!;
    if ((fact.status !== "pending" || fact.attempts > 0) &&
        progress.resources.slice(0, index).some((previous) => previous.status !== "verified")) {
      throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource progress precedes prerequisite verification.");
    }
    if (fact.blocker?.code === "cleanup_deadline_before_effect" &&
        (fact.attempt || record.state !== "cleanup_blocked" || cleanup.status !== "blocked" || !cleanup.blockedAt)) {
      throw new StreamingSessionStoreError("invalid_effect", "Unissued cleanup expiry is not an exact blocked disposition.");
    }
    if (fact.resource !== definition.resource || fact.identity !== definition.identity) {
      throw new StreamingSessionStoreError("invalid_effect", "Adopted cleanup resource identity differs from immutable session authority.");
    }
    const proofOwner = `${fact.ownerId}\0${fact.fencingToken}`;
    if (!validProofOwners.has(proofOwner)) throw new StreamingSessionStoreError("invalid_effect", "Adopted cleanup fact has foreign proof ownership.");
    const factAuthorityAt = authorityAtByProofOwner.get(proofOwner);
    if (factAuthorityAt === undefined) throw new StreamingSessionStoreError("invalid_effect", "Adopted cleanup fact has no authority chronology.");
    if ((fact.status === "pending" || fact.status === "blocked") &&
        (fact.ownerId !== record.ownerId || fact.fencingToken !== record.fencingToken)) {
      throw new StreamingSessionStoreError("invalid_effect", "Unresolved cleanup resource is not fenced to the current owner.");
    }
    if (fact.attempt && (
      !validProofOwners.has(`${fact.attempt.ownerId}\0${fact.attempt.fencingToken}`) ||
      Date.parse(fact.attempt.startedAt) < (authorityAtByProofOwner.get(`${fact.attempt.ownerId}\0${fact.attempt.fencingToken}`) ?? Infinity) ||
      fact.attempt.attemptId !== deriveAdoptedCleanupAttemptId({
        effectId: cleanup.effectId,
        resource: fact.resource,
        ordinal: fact.attempts,
        ownerId: fact.attempt.ownerId,
        fencingToken: fact.attempt.fencingToken,
      })
    )) {
      throw new StreamingSessionStoreError("invalid_effect", "Adopted cleanup attempt is not bound to its durable authority and ordinal.");
    }
    if (fact.verifiedAt !== undefined && Date.parse(fact.verifiedAt) < factAuthorityAt) {
      throw new StreamingSessionStoreError("invalid_effect", "Adopted cleanup verification predates its current authority.");
    }
  }
  if (record.state === "released" && progress.resources.some((resource) => resource.status !== "verified")) {
    throw new StreamingSessionStoreError("invalid_effect", "Released cleanup contains an unverified resource.");
  }
}

function cleanupProofOwners(effect: Readonly<StreamingSessionEffect>): ReadonlySet<string> {
  const owners = new Set<string>();
  const provenance = effect.cleanupProvenance;
  if (!provenance) return owners;
  owners.add(`${provenance.originOwnerId}\0${provenance.originFencingToken}`);
  for (const takeover of provenance.takeovers) owners.add(`${takeover.toOwnerId}\0${takeover.toFencingToken}`);
  return owners;
}

export function deriveAdoptedCleanupResourceDefinitions(
  record: Pick<StreamingSessionRecord, "sessionId" | "backendBinding" | "lease">,
): readonly Readonly<{ resource: AdoptedCleanupResourceKind; identity: string }>[] {
  const backendIdentity = record.backendBinding.opaqueIdentity;
  return Object.freeze([
    Object.freeze({ resource: "workload_quiescence", identity: `workload:${backendIdentity}` }),
    Object.freeze({ resource: "retained_output_settlement", identity: `output:${record.sessionId}:${backendIdentity}` }),
    Object.freeze({ resource: "evidence", identity: `evidence:${record.sessionId}` }),
    Object.freeze({ resource: "channel_detach", identity: `channel:${record.sessionId}:${backendIdentity}` }),
    Object.freeze({ resource: "backend_release", identity: `backend:${record.backendBinding.registryId}:${record.backendBinding.backendId}:${backendIdentity}` }),
    Object.freeze({ resource: "isolation_release", identity: `isolation:${record.lease.providerId}:${record.lease.leaseId}:${record.lease.invocationId}:${record.lease.providerIdentity}` }),
  ]);
}

function beginAdoptedCleanupResources(
  record: Pick<StreamingSessionRecord, "sessionId" | "backendBinding" | "lease" | "ownerId" | "fencingToken">,
): readonly AdoptedCleanupResourceFact[] {
  return Object.freeze(deriveAdoptedCleanupResourceDefinitions(record).map((definition) => Object.freeze({
    ...definition,
    status: "pending" as const,
    ownerId: record.ownerId,
    fencingToken: record.fencingToken,
    attempts: 0,
  })));
}

function cleanupIdentity(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > 128 * 1_024) {
    throw new StreamingSessionStoreError("invalid_record", "Adopted cleanup resource identity is invalid.");
  }
  return value;
}

function assertStateCombination(
  record: Partial<StreamingSessionRecord>,
  effects: readonly StreamingSessionEffect[],
  cleanupCreationAuthority: StreamingSessionCleanupCreationAuthority | null | undefined,
): void {
  const transfer = effects.find((effect) => effect.kind === "transfer");
  const cleanup = effects.find((effect) => effect.kind === "cleanup");
  const state = record.state;
  if (!transfer || !state || !isCleanupOwner(record.cleanupOwner)) {
    throw new StreamingSessionStoreError("invalid_state", "Streaming session state is incomplete.");
  }
  const requiresAcknowledgedTransfer = () => {
    if (transfer.status !== "acknowledged") {
      throw new StreamingSessionStoreError("invalid_state", "Streaming session state requires acknowledged transfer.");
    }
  };
  const requiresTransferOwner = () => {
    if (transfer.owner !== "tool_broker") {
      throw new StreamingSessionStoreError("invalid_state", "Streaming session transfer effect owner is invalid.");
    }
  };
  const requiresTransferFenceAtOrBeforeCurrent = () => {
    if (transfer.fencingToken > (record.fencingToken as number)) {
      throw new StreamingSessionStoreError("invalid_state", "Streaming session transfer effect fence is invalid.");
    }
  };
  const requiresExactCurrentCleanupEffect = () => {
    if (!cleanup || cleanup.owner !== record.cleanupOwner || cleanup.fencingToken !== record.fencingToken) {
      throw new StreamingSessionStoreError("invalid_state", "Streaming session cleanup effect ownership evidence is invalid.");
    }
  };
  const requiresCleanupProvenance = () => {
    if (!cleanup) {
      if (cleanupCreationAuthority !== null && cleanupCreationAuthority !== undefined) {
        throw new StreamingSessionStoreError("invalid_state", "Streaming session has cleanup authority without an effect.");
      }
      return;
    }
    if ((record.schemaVersion as number) < 2) {
      if (cleanup.cleanupProvenance !== undefined) {
        throw new StreamingSessionStoreError("invalid_state", "Legacy cleanup evidence cannot carry takeover provenance.");
      }
      return;
    }
    const provenance = cleanup.cleanupProvenance;
    if (!provenance || transfer.cleanupProvenance !== undefined ||
        provenance.effectId !== cleanup.effectId ||
        provenance.originFencingToken < transfer.fencingToken) {
      throw new StreamingSessionStoreError("invalid_state", "Streaming session cleanup provenance is invalid.");
    }
    if ((record.schemaVersion as number) >= STREAMING_SESSION_RECORD_VERSION &&
        (!cleanupCreationAuthority ||
         cleanupCreationAuthority.effectId !== cleanup.effectId ||
         cleanupCreationAuthority.createdAt !== cleanup.createdAt ||
         cleanupCreationAuthority.ownerId !== provenance.originOwnerId ||
         cleanupCreationAuthority.fencingToken !== provenance.originFencingToken)) {
      throw new StreamingSessionStoreError("invalid_state", "Streaming session cleanup creation authority is invalid.");
    }
    let ownerId = provenance.originOwnerId;
    let fencingToken = provenance.originFencingToken;
    let priorAt = assertTimestamp(cleanup.createdAt, "cleanup.createdAt");
    for (const takeover of provenance.takeovers) {
      const takeoverAt = assertTimestamp(takeover.at, "cleanupProvenance.takeover.at");
      if (takeover.fromOwnerId !== ownerId || takeover.fromFencingToken !== fencingToken ||
          takeover.toFencingToken !== takeover.fromFencingToken + 1 || takeoverAt < priorAt) {
        throw new StreamingSessionStoreError("invalid_state", "Streaming session cleanup takeover provenance is invalid.");
      }
      ownerId = takeover.toOwnerId;
      fencingToken = takeover.toFencingToken;
      priorAt = takeoverAt;
    }
    if (cleanup.fencingToken !== fencingToken || record.ownerId !== ownerId ||
        record.fencingToken !== fencingToken ||
        (provenance.takeovers.length > 0 && cleanup.owner !== "session_authority")) {
      throw new StreamingSessionStoreError("invalid_state", "Streaming session cleanup takeover provenance is invalid.");
    }
  };
  const requiresNoCleanup = () => {
    if (cleanup) throw new StreamingSessionStoreError("invalid_state", "Streaming session state has premature cleanup evidence.");
  };
  if (transfer.cleanupProvenance !== undefined) {
    throw new StreamingSessionStoreError("invalid_state", "Streaming session transfer effect cannot carry cleanup provenance.");
  }
  requiresCleanupProvenance();
  switch (state) {
    case "pending_transfer":
      if (record.cleanupOwner !== "tool_broker" || transfer.status !== "pending" ||
          transfer.owner !== "tool_broker" || transfer.fencingToken !== record.fencingToken || cleanup) {
        throw new StreamingSessionStoreError("invalid_state", "Pending transfer must retain one ToolBroker-owned transfer effect.");
      }
      return;
    case "transfer_ambiguous":
      if (record.cleanupOwner !== "provider_lease" || transfer.status === "blocked" ||
          transfer.owner !== "tool_broker" || transfer.fencingToken !== record.fencingToken || cleanup) {
        throw new StreamingSessionStoreError("invalid_state", "Ambiguous transfer must retain provider-lease ownership.");
      }
      return;
    case "active":
    case "stopping":
    case "input_unavailable":
    case "backend_unavailable":
    case "outcome_unknown":
      if (record.cleanupOwner !== "session_authority") {
        throw new StreamingSessionStoreError("invalid_state", "Adopted streaming session has invalid cleanup ownership.");
      }
      requiresAcknowledgedTransfer();
      requiresTransferOwner();
      requiresTransferFenceAtOrBeforeCurrent();
      requiresNoCleanup();
      return;
    case "cleanup_pending":
      if ((record.cleanupOwner !== "provider_lease" && record.cleanupOwner !== "session_authority") ||
          !cleanup || cleanup.status !== "pending" || cleanup.owner !== record.cleanupOwner) {
        throw new StreamingSessionStoreError("invalid_state", "Cleanup pending requires exact current-owner cleanup evidence.");
      }
      requiresAcknowledgedTransfer();
      requiresTransferOwner();
      requiresTransferFenceAtOrBeforeCurrent();
      requiresExactCurrentCleanupEffect();
      return;
    case "cleanup_blocked":
      if ((record.cleanupOwner !== "provider_lease" && record.cleanupOwner !== "session_authority") ||
          !cleanup || cleanup.status !== "blocked" || cleanup.owner !== record.cleanupOwner) {
        throw new StreamingSessionStoreError("invalid_state", "Cleanup blocked requires exact blocked cleanup evidence.");
      }
      requiresAcknowledgedTransfer();
      requiresTransferOwner();
      requiresTransferFenceAtOrBeforeCurrent();
      requiresExactCurrentCleanupEffect();
      return;
    case "released":
      if (record.cleanupOwner !== "none" || !cleanup || cleanup.status !== "acknowledged") {
        throw new StreamingSessionStoreError("invalid_state", "Released session requires acknowledged cleanup evidence.");
      }
      requiresAcknowledgedTransfer();
      requiresTransferOwner();
      requiresTransferFenceAtOrBeforeCurrent();
      if (cleanup.owner !== cleanupOwnerBeforeRelease(record) ||
          cleanup.fencingToken !== record.fencingToken) {
        throw new StreamingSessionStoreError("invalid_state", "Released streaming session cleanup evidence is invalid.");
      }
      return;
  }
}

function assertHistoryForState(
  history: readonly StreamingSessionHistoryEntry[],
  state: StreamingSessionState,
  revision: number,
): void {
  if (history[0]?.state !== "pending_transfer" || history.at(-1)?.state !== state || history.length > revision + 1) {
    throw new StreamingSessionStoreError("invalid_state", "Streaming session history does not match the current state.");
  }
  const transitions: Readonly<Record<StreamingSessionState, readonly StreamingSessionState[]>> = {
    pending_transfer: ["transfer_ambiguous", "active"],
    transfer_ambiguous: ["cleanup_pending"],
    active: ["stopping", "cleanup_pending", "input_unavailable", "backend_unavailable", "outcome_unknown"],
    stopping: ["cleanup_pending", "backend_unavailable", "outcome_unknown"],
    input_unavailable: ["cleanup_pending", "outcome_unknown"],
    backend_unavailable: ["cleanup_pending", "outcome_unknown"],
    outcome_unknown: ["cleanup_pending"],
    cleanup_pending: ["cleanup_blocked", "released"],
    cleanup_blocked: ["cleanup_pending"],
    released: [],
  };
  for (let index = 1; index < history.length; index += 1) {
    const previous = history[index - 1]!.state;
    const current = history[index]!.state;
    if (!transitions[previous].includes(current)) {
      throw new StreamingSessionStoreError("invalid_state", "Streaming session state transition is invalid.");
    }
  }
}

function assertTimestamp(value: unknown, name: string): number {
  if (typeof value !== "string" || !isValidText(value)) {
    throw new StreamingSessionStoreError("invalid_record", `Streaming session ${name} is invalid.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new StreamingSessionStoreError("invalid_record", `Streaming session ${name} is invalid.`);
  }
  return timestamp;
}

function isCleanupOwner(value: unknown): value is StreamingSessionCleanupOwner {
  return value === "tool_broker" || value === "provider_lease" ||
    value === "session_authority" || value === "none";
}

function cleanupOwnerBeforeRelease(record: Partial<StreamingSessionRecord>): "provider_lease" | "session_authority" {
  return record.history?.at(-3)?.state === "transfer_ambiguous" ? "provider_lease" : "session_authority";
}

function cleanupProvenanceFor(
  effect: Readonly<StreamingSessionEffect>,
  ownerId: string,
  fencingToken: number,
): StreamingSessionCleanupProvenance {
  if (effect.kind !== "cleanup") {
    throw new StreamingSessionStoreError("invalid_effect", "Streaming session cleanup provenance requires a cleanup effect.");
  }
  return effect.cleanupProvenance ?? {
    effectId: effect.effectId,
    originOwnerId: ownerId,
    originFencingToken: fencingToken,
    takeovers: [],
  };
}

function cleanupCreationAuthorityFor(
  effect: Readonly<StreamingSessionEffect>,
  ownerId: string,
  fencingToken: number,
): StreamingSessionCleanupCreationAuthority {
  if (effect.kind !== "cleanup") {
    throw new StreamingSessionStoreError("invalid_effect", "Streaming session cleanup authority requires a cleanup effect.");
  }
  return {
    effectId: effect.effectId,
    ownerId: effect.cleanupProvenance?.originOwnerId ?? ownerId,
    fencingToken: effect.cleanupProvenance?.originFencingToken ?? fencingToken,
    createdAt: effect.createdAt,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function cloneRecord(value: Readonly<StreamingSessionRecord>): Readonly<StreamingSessionRecord> {
  return parseStreamingSessionRecord(value);
}

/** Shared preflight and transactional guard for observing immutable evidence. */
export function validateFinalizedEvidenceObservation(
  current: Readonly<StreamingSessionRecord>, checkpoint: Readonly<OutputCheckpointRecord> | undefined,
  input: Record<string, unknown>,
): AdoptedCleanupEvidenceReference {
  assertExactKeys(input, new Set(["type", "sessionId", "ownerId", "fencingToken", "expectedRevision", "effectId", "resourceIdentity", "checkpoint", "at", "deadlineAt"]), "finalized evidence observation");
  const at = assertTimestamp(input.at, "at");
  if (input.type !== "observe_finalized_evidence" || input.sessionId !== current.sessionId ||
      input.ownerId !== current.ownerId || input.fencingToken !== current.fencingToken || input.expectedRevision !== current.revision ||
      at >= Date.parse(current.leaseExpiresAt) || at >= assertTimestamp(input.deadlineAt, "deadlineAt")) {
    throw new StreamingSessionStoreError("invalid_effect", "Finalized evidence observation authority is stale.");
  }
  const cleanup = current.effects.find((effect) => effect.kind === "cleanup");
  const facts = cleanup?.progress?.resources;
  const fact = facts?.find((candidate) => candidate.resource === "evidence");
  if (current.state !== "cleanup_blocked" || current.cleanupOwner !== "session_authority" ||
      cleanup?.status !== "blocked" || cleanup.effectId !== input.effectId ||
      !fact || fact.identity !== input.resourceIdentity || fact.ownerId !== current.ownerId || fact.fencingToken !== current.fencingToken ||
      fact.status !== "blocked" || fact.blocker?.code !== "evidence_finalization_failed" || fact.attempt ||
      facts!.slice(0, 2).some((candidate) => candidate.status !== "verified")) {
    throw new StreamingSessionStoreError("invalid_effect", "Finalized evidence observation requires exact terminal evidence and verified predecessors.");
  }
  if (!checkpoint || checkpoint.sessionId !== current.sessionId || checkpoint.ownerId !== current.ownerId ||
      checkpoint.fencingToken !== current.fencingToken || checkpoint.outcome !== "active" ||
      canonicalJson(checkpoint) !== canonicalJson(input.checkpoint) || !checkpoint.continuation?.finalized ||
      checkpoint.streams.some((stream) => stream.accepted.length > 0 || stream.consumingIntent) ||
      checkpoint.continuation.positions.some((position) => canonicalJson(position.last) !==
        canonicalJson(checkpoint.streams.find((stream) => stream.stream === position.stream)?.lastConsumed ?? null))) {
    throw new StreamingSessionStoreError("invalid_effect", "Finalized evidence observation requires the exact settled checkpoint.");
  }
  const final = checkpoint.continuation.finalized;
  return { kind: "bounded_output_manifest", digest: final.manifestHash, lossy: final.lossy,
    ...(final.lossy ? { lossReason: "bounded_output_loss" as const } : {}) };
}

/** Both backends apply this exact reducer under their authenticated writer. */
function applyStreamingSessionCommand(
  current: Readonly<StreamingSessionRecord>,
  input: Record<string, unknown>,
  maxEffectsPerRecord: number,
  checkpoint?: Readonly<OutputCheckpointRecord>,
): Readonly<StreamingSessionRecord> {
  if (![
    "acknowledge_transfer",
    "mark_transfer_ambiguous",
    "acknowledge_ambiguous_transfer",
    "begin_cleanup",
    "mark_cleanup_blocked",
    "mark_disposition",
    "begin_stopping",
    "renew_lease",
    "retry_cleanup",
    "begin_cleanup_resource",
    "expire_cleanup_resource",
    "settle_cleanup_resource",
    "observe_finalized_evidence",
    "retry_cleanup_resource",
    "takeover",
    "acknowledge_cleanup",
  ].includes(input.type as string)) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session command is invalid.");
  }
  if (input.expectedRevision !== current.revision) {
    throw new StreamingSessionStoreError("revision_conflict", "Streaming session revision is stale.");
  }
  if (input.ownerId !== current.ownerId || input.fencingToken !== current.fencingToken) {
    throw new StreamingSessionStoreError("stale_fence", "Streaming session ownership fence is stale.");
  }
  const at = requiredText(input.at, "at");
  const atTimestamp = assertTimestamp(at, "at");
  const ownershipLeaseExpiresAt = assertTimestamp(current.leaseExpiresAt, "leaseExpiresAt");
  const hasSessionAuthorityLease = current.cleanupOwner === "session_authority";
  if (input.type === "takeover") {
    if (!hasSessionAuthorityLease || ![
      "active",
      "stopping",
      "input_unavailable",
      "backend_unavailable",
      "outcome_unknown",
      "cleanup_pending",
      "cleanup_blocked",
    ].includes(current.state)) {
      throw new StreamingSessionStoreError("invalid_state", "Only an adopted streaming session can be taken over.");
    }
    if (atTimestamp < ownershipLeaseExpiresAt) {
      throw new StreamingSessionStoreError("lease_not_expired", "Streaming session ownership lease has not expired.");
    }
  } else if (input.type !== "renew_lease" &&
      (hasSessionAuthorityLease || input.type === "acknowledge_transfer") &&
      atTimestamp >= ownershipLeaseExpiresAt) {
    throw new StreamingSessionStoreError("lease_expired", "Streaming session ownership lease has expired.");
  }
  const currentEffects = current.effects;
  const currentCleanup = currentEffects.find((effect) => effect.kind === "cleanup");
  const durableCleanupCreationAuthority = current.cleanupCreationAuthority ??
    (current.schemaVersion < 2 && currentCleanup
      ? cleanupCreationAuthorityFor(currentCleanup, current.ownerId, current.fencingToken)
      : null);
  const nextRevision = (current.revision as number) + 1;
  const acknowledge = (effectId: string, kind: "transfer" | "cleanup") => {
    const effect = currentEffects.find((candidate) => candidate.effectId === effectId);
    if (!effect || effect.kind !== kind || effect.status !== "pending") {
      throw new StreamingSessionStoreError("invalid_effect", `Streaming session ${kind} effect is not pending.`);
    }
    const cleanupProvenance = kind === "cleanup"
      ? cleanupProvenanceFor(effect, current.ownerId, current.fencingToken)
      : undefined;
    return currentEffects.map((candidate) => candidate.effectId === effectId
      ? {
        ...candidate,
        status: "acknowledged",
        acknowledgedAt: at,
        ...(cleanupProvenance === undefined ? {} : { cleanupProvenance }),
      }
      : candidate);
  };

  if (input.type === "takeover") {
    if (current.state === "released") {
      throw new StreamingSessionStoreError("invalid_state", "Released streaming sessions cannot be taken over.");
    }
    const newOwnerId = requiredText(input.newOwnerId, "newOwnerId");
    if (!Number.isSafeInteger(input.newFencingToken) ||
        (input.newFencingToken as number) <= current.fencingToken) {
      throw new StreamingSessionStoreError("stale_fence", "Streaming session takeover fence is invalid.");
    }
    const leaseExpiresAt = requiredText(input.leaseExpiresAt, "leaseExpiresAt");
    if (assertTimestamp(leaseExpiresAt, "leaseExpiresAt") <= atTimestamp) {
      throw new StreamingSessionStoreError("invalid_state", "Streaming session takeover lease must extend beyond takeover time.");
    }
    const cleanup = currentCleanup;
    if (current.state === "cleanup_pending" || current.state === "cleanup_blocked") {
      if (!cleanup || (current.state === "cleanup_pending" ? cleanup.status !== "pending" : cleanup.status !== "blocked") || cleanup.owner !== "session_authority" ||
          (input.newFencingToken as number) !== (current.fencingToken as number) + 1) {
        throw new StreamingSessionStoreError("stale_fence", "Streaming session cleanup takeover fence is invalid.");
      }
    }
    const effects = (current.state === "cleanup_pending" || current.state === "cleanup_blocked") && cleanup
      ? currentEffects.map((effect) => effect.effectId === cleanup.effectId
        ? {
          ...effect,
          fencingToken: input.newFencingToken as number,
          ...(effect.status === "blocked" ? { blockedAt: at } : {}),
          cleanupProvenance: {
            ...cleanupProvenanceFor(effect, current.ownerId, current.fencingToken),
            takeovers: [
              ...cleanupProvenanceFor(effect, current.ownerId, current.fencingToken).takeovers,
              {
                fromOwnerId: current.ownerId,
                fromFencingToken: current.fencingToken,
                toOwnerId: newOwnerId,
                toFencingToken: input.newFencingToken as number,
                at,
              },
            ],
          },
          progress: effect.progress ? {
            resources: effect.progress.resources.map((resource) =>
              resource.status === "pending" || resource.status === "blocked"
                ? { ...resource, ownerId: newOwnerId, fencingToken: input.newFencingToken as number }
                : resource),
          } : undefined,
        }
        : effect)
      : currentEffects;
    return parseStreamingSessionRecord({
      ...current,
      cleanupCreationAuthority: durableCleanupCreationAuthority,
      schemaVersion: STREAMING_SESSION_RECORD_VERSION,
      revision: nextRevision,
      ownerId: newOwnerId,
      fencingToken: input.newFencingToken,
      leaseExpiresAt,
      effects,
    });
  }

  if (input.type === "renew_lease") {
    if (!hasSessionAuthorityLease || ![
      "active",
      "stopping",
      "input_unavailable",
      "backend_unavailable",
      "outcome_unknown",
      "cleanup_pending",
      "cleanup_blocked",
    ].includes(current.state)) {
      throw new StreamingSessionStoreError("invalid_state", "Only an adopted streaming session can renew its ownership lease.");
    }
    const leaseExpiresAt = requiredText(input.leaseExpiresAt, "leaseExpiresAt");
    const renewedExpiry = assertTimestamp(leaseExpiresAt, "leaseExpiresAt");
    if (renewedExpiry <= atTimestamp || renewedExpiry <= ownershipLeaseExpiresAt) {
      throw new StreamingSessionStoreError("invalid_state", "Streaming session lease renewal must extend the current lease.");
    }
    return parseStreamingSessionRecord({
      ...current,
      cleanupCreationAuthority: durableCleanupCreationAuthority,
      schemaVersion: STREAMING_SESSION_RECORD_VERSION,
      revision: nextRevision,
      leaseExpiresAt,
    });
  }

  if (input.type === "retry_cleanup") {
    if (current.state !== "cleanup_blocked" || current.cleanupOwner !== "session_authority" ||
        !currentCleanup || currentCleanup.status !== "blocked" ||
        input.effectId !== currentCleanup.effectId) {
      throw new StreamingSessionStoreError("invalid_state", "Only exact retained SessionAuthority cleanup can be retried.");
    }
    const isConservativeLegacyRetry = currentCleanup.progress?.resources.every((resource) =>
      resource.status === "pending" && resource.attempts === 0 && resource.attempt === undefined &&
      resource.blocker === undefined && resource.verifiedAt === undefined && resource.evidence === undefined);
    if (!isConservativeLegacyRetry) {
      throw new StreamingSessionStoreError("invalid_effect", "Categorical adopted cleanup blockers require an exact resource retry.");
    }
    return parseStreamingSessionRecord({
      ...current,
      cleanupCreationAuthority: durableCleanupCreationAuthority,
      schemaVersion: STREAMING_SESSION_RECORD_VERSION,
      revision: nextRevision,
      state: "cleanup_pending",
      history: [...current.history, { state: "cleanup_pending", at }],
      effects: currentEffects.map((effect) => effect.effectId === currentCleanup.effectId
        ? { ...effect, status: "pending" as const, blockedAt: undefined }
        : effect),
    });
  }

  if (input.type === "begin_cleanup_resource" || input.type === "expire_cleanup_resource") {
    if (current.state !== "cleanup_pending" || current.cleanupOwner !== "session_authority" ||
        !currentCleanup || currentCleanup.status !== "pending" ||
        input.effectId !== currentCleanup.effectId || !currentCleanup.progress) {
      throw new StreamingSessionStoreError("invalid_state", "Only exact pending adopted cleanup can begin a resource attempt.");
    }
    const resource = input.resource as AdoptedCleanupResourceKind;
    if (!ADOPTED_CLEANUP_RESOURCE_ORDER.includes(resource)) {
      throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource kind is invalid.");
    }
    const fact = currentCleanup.progress.resources.find((candidate) => candidate.resource === resource);
    if (!fact || fact.status !== "pending" || fact.attempt) {
      throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource is not pending.");
    }
    if (currentCleanup.progress.resources.slice(0, ADOPTED_CLEANUP_RESOURCE_ORDER.indexOf(resource))
      .some((previous) => previous.status !== "verified")) {
      throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource prerequisites are not verified.");
    }
    const deadlineAt = requiredTimestamp(input.deadlineAt, "cleanup attempt deadlineAt");
    const latestAuthorityAt = Math.max(
      Date.parse(currentCleanup.createdAt),
      ...((currentCleanup.cleanupProvenance?.takeovers ?? []).map((takeover) => Date.parse(takeover.at))),
    );
    if (input.type === "expire_cleanup_resource") {
      if (atTimestamp < Date.parse(deadlineAt) || atTimestamp < latestAuthorityAt) {
        throw new StreamingSessionStoreError("invalid_effect", "Unissued cleanup deadline is outside current authority chronology.");
      }
      return parseStreamingSessionRecord({
        ...current, schemaVersion: STREAMING_SESSION_RECORD_VERSION, revision: nextRevision,
        state: "cleanup_blocked", history: [...current.history, { state: "cleanup_blocked", at }],
        effects: currentEffects.map((effect) => effect.effectId === currentCleanup.effectId ? {
          ...effect, status: "blocked", blockedAt: at,
          progress: { resources: effect.progress!.resources.map((candidate) => candidate.resource === resource ? {
            ...candidate, status: "blocked", blocker: {
              code: "cleanup_deadline_before_effect", message: ADOPTED_CLEANUP_BLOCKER_MESSAGES.cleanup_deadline_before_effect,
            },
          } : candidate) },
        } : effect),
      });
    }
    const startedAt = requiredTimestamp(input.startedAt, "cleanup attempt startedAt");
    const attemptId = deriveAdoptedCleanupAttemptId({
      effectId: currentCleanup.effectId,
      resource,
      ordinal: fact.attempts + 1,
      ownerId: current.ownerId,
      fencingToken: current.fencingToken,
    });
    if ((input.attemptId !== undefined && input.attemptId !== attemptId) ||
        startedAt !== at || Date.parse(startedAt) < latestAuthorityAt ||
        Date.parse(deadlineAt) < Date.parse(startedAt) ||
        Date.parse(deadlineAt) > Date.parse(current.leaseExpiresAt)) {
      throw new StreamingSessionStoreError("invalid_effect", "Cleanup attempt identity or chronology is outside exact ownership authority.");
    }
    const attempt: AdoptedCleanupAttempt = Object.freeze({
      attemptId,
      ownerId: current.ownerId,
      fencingToken: current.fencingToken,
      startedAt,
      deadlineAt,
    });
    return parseStreamingSessionRecord({
      ...current,
      schemaVersion: STREAMING_SESSION_RECORD_VERSION,
      revision: nextRevision,
      effects: currentEffects.map((effect) => effect.effectId === currentCleanup.effectId
        ? {
          ...effect,
          progress: {
            resources: effect.progress!.resources.map((candidate) => candidate.resource === resource
              ? { ...candidate, status: "in_flight" as const, attempts: candidate.attempts + 1, attempt }
              : candidate),
          },
        }
        : effect),
    });
  }

  if (input.type === "observe_finalized_evidence") {
    const evidence = validateFinalizedEvidenceObservation(current, checkpoint, input);
    return parseStreamingSessionRecord({
      ...current, schemaVersion: STREAMING_SESSION_RECORD_VERSION, revision: nextRevision,
      state: "cleanup_pending", history: [...current.history, { state: "cleanup_pending", at }],
      effects: currentEffects.map((effect) => effect.effectId === currentCleanup!.effectId ? {
        ...effect, status: "pending", blockedAt: undefined,
        progress: { resources: effect.progress!.resources.map((fact) => fact.resource === "evidence" ? {
          ...fact, status: "verified", blocker: undefined, verifiedAt: at, evidence,
        } : fact) },
      } : effect),
    });
  }
  if (input.type === "settle_cleanup_resource") {
    const observedBlockedResolution = current.state === "cleanup_blocked" && currentCleanup?.status === "blocked";
    if ((current.state !== "cleanup_pending" && !observedBlockedResolution) || current.cleanupOwner !== "session_authority" ||
        !currentCleanup || (currentCleanup.status !== "pending" && !observedBlockedResolution) ||
        input.effectId !== currentCleanup.effectId || !currentCleanup.progress) {
      throw new StreamingSessionStoreError("invalid_state", "Only exact pending adopted cleanup can settle a resource attempt.");
    }
    const resource = input.resource as AdoptedCleanupResourceKind;
    const fact = currentCleanup.progress.resources.find((candidate) => candidate.resource === resource);
    if (!fact || (fact.status !== "in_flight" && !(observedBlockedResolution && fact.status === "blocked")) || !fact.attempt ||
        input.attemptId !== fact.attempt.attemptId ||
        input.attemptOwnerId !== fact.attempt.ownerId ||
        input.attemptFencingToken !== fact.attempt.fencingToken) {
      throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource settlement does not match the exact issued attempt.");
    }
    if (atTimestamp < Date.parse(fact.attempt.startedAt)) {
      throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource settlement predates its issued attempt.");
    }
    if (input.result !== "verified" && input.result !== "blocked") {
      throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource settlement result is invalid.");
    }
    if (observedBlockedResolution && input.result !== "verified") {
      throw new StreamingSessionStoreError("invalid_effect", "Blocked cleanup reconciliation may only record an observed verification.");
    }
    const blocker = input.result === "blocked" ? parseAdoptedCleanupBlocker(input.blocker) : undefined;
    if (blocker?.code === "cleanup_deadline_before_effect") {
      throw new StreamingSessionStoreError("invalid_effect", "An issued effect cannot claim an unissued deadline blocker.");
    }
    const evidence = input.result === "verified" && resource === "evidence"
      ? parseAdoptedCleanupEvidenceReference(input.evidence)
      : undefined;
    if ((input.result === "verified" && resource !== "evidence" && input.evidence !== undefined) ||
        (input.result === "verified" && input.blocker !== undefined) ||
        (input.result === "blocked" && input.evidence !== undefined)) {
      throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource settlement carries incompatible proof.");
    }
    const blocked = input.result === "blocked";
    const retainAttempt = blocked && blocker !== undefined && retainsCleanupAttempt(blocker.code);
    return parseStreamingSessionRecord({
      ...current,
      schemaVersion: STREAMING_SESSION_RECORD_VERSION,
      revision: nextRevision,
      state: blocked ? "cleanup_blocked" : observedBlockedResolution ? "cleanup_pending" : current.state,
      history: blocked
        ? [...current.history, { state: "cleanup_blocked", at }]
        : observedBlockedResolution ? [...current.history, { state: "cleanup_pending", at }] : current.history,
      effects: currentEffects.map((effect) => effect.effectId === currentCleanup.effectId
        ? {
          ...effect,
          status: blocked ? "blocked" as const : observedBlockedResolution ? "pending" as const : effect.status,
          ...(blocked ? { blockedAt: at } : observedBlockedResolution ? { blockedAt: undefined } : {}),
          progress: {
            resources: effect.progress!.resources.map((candidate) => candidate.resource === resource
              ? blocked
                ? {
                  ...candidate,
                  status: "blocked" as const,
                  ownerId: current.ownerId,
                  fencingToken: current.fencingToken,
                  attempt: retainAttempt ? candidate.attempt : undefined,
                  blocker,
                }
                : {
                  ...candidate,
                  status: "verified" as const,
                  attempt: undefined,
                  blocker: undefined,
                  verifiedAt: at,
                  ...(evidence ? { evidence } : {}),
                }
              : candidate),
          },
        }
        : effect),
    });
  }

  if (input.type === "retry_cleanup_resource") {
    if (current.state !== "cleanup_blocked" || current.cleanupOwner !== "session_authority" ||
        !currentCleanup || currentCleanup.status !== "blocked" ||
        input.effectId !== currentCleanup.effectId || !currentCleanup.progress) {
      throw new StreamingSessionStoreError("invalid_state", "Only exact blocked adopted cleanup can retry a resource.");
    }
    const resource = input.resource as AdoptedCleanupResourceKind;
    const fact = currentCleanup.progress.resources.find((candidate) => candidate.resource === resource);
    if (!fact || fact.status !== "blocked" || fact.attempt || !fact.blocker || !isRetryableCleanupBlocker(fact.blocker.code)) {
      throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource is not provably retryable.");
    }
    return parseStreamingSessionRecord({
      ...current,
      schemaVersion: STREAMING_SESSION_RECORD_VERSION,
      revision: nextRevision,
      state: "cleanup_pending",
      history: [...current.history, { state: "cleanup_pending", at }],
      effects: currentEffects.map((effect) => effect.effectId === currentCleanup.effectId
        ? {
          ...effect,
          status: "pending" as const,
          blockedAt: undefined,
          progress: {
            resources: effect.progress!.resources.map((candidate) => candidate.resource === resource
              ? { ...candidate, status: "pending" as const, blocker: undefined }
              : candidate),
          },
        }
        : effect),
    });
  }

  if (input.type === "begin_stopping") {
    if (current.state !== "active" || current.cleanupOwner !== "session_authority") {
      throw new StreamingSessionStoreError("invalid_state", "Only an adopted active streaming session can begin stopping.");
    }
    return parseStreamingSessionRecord({
      ...current,
      cleanupCreationAuthority: durableCleanupCreationAuthority,
      schemaVersion: STREAMING_SESSION_RECORD_VERSION,
      revision: nextRevision,
      state: "stopping",
      history: [...current.history, { state: "stopping", at }],
    });
  }

  if (input.type === "acknowledge_ambiguous_transfer") {
    if (current.state !== "transfer_ambiguous") {
      throw new StreamingSessionStoreError("invalid_state", "Only an ambiguous transfer can be acknowledged.");
    }
    const effectId = requiredText(input.effectId, "effectId");
    return parseStreamingSessionRecord({
      ...current,
      cleanupCreationAuthority: durableCleanupCreationAuthority,
      schemaVersion: STREAMING_SESSION_RECORD_VERSION,
      revision: nextRevision,
      effects: acknowledge(effectId, "transfer"),
    });
  }
  if (input.type === "begin_cleanup") {
    if (!["transfer_ambiguous", "active", "stopping", "input_unavailable", "backend_unavailable", "outcome_unknown", "cleanup_blocked"].includes(current.state as string)) {
      throw new StreamingSessionStoreError("invalid_state", "Streaming session cannot begin cleanup from this state.");
    }
    const effectId = requiredText(input.effectId, "effectId");
    if (currentEffects.length >= maxEffectsPerRecord) {
      throw new StreamingSessionStoreError(
        "capacity_exceeded",
        "Streaming session effect capacity is full; existing cleanup evidence was retained.",
      );
    }
    if (currentEffects.some((candidate) => candidate.effectId === effectId)) {
      throw new StreamingSessionStoreError("invalid_effect", "Streaming session cleanup effect already exists.");
    }
    return parseStreamingSessionRecord({
      ...current,
      schemaVersion: STREAMING_SESSION_RECORD_VERSION,
      revision: nextRevision,
      state: "cleanup_pending",
      cleanupCreationAuthority: {
        effectId,
        ownerId: current.ownerId,
        fencingToken: current.fencingToken,
        createdAt: at,
      },
      history: [...(current.history as readonly unknown[]), { state: "cleanup_pending", at }],
      effects: [...currentEffects, {
        effectId,
        kind: "cleanup",
        status: "pending",
        owner: current.cleanupOwner,
        fencingToken: current.fencingToken,
        createdAt: at,
        cleanupProvenance: {
          effectId,
          originOwnerId: current.ownerId,
          originFencingToken: current.fencingToken,
          takeovers: [],
        },
        ...(current.cleanupOwner === "session_authority"
          ? { progress: { resources: beginAdoptedCleanupResources(current) } }
          : {}),
      }],
    });
  }
  if (input.type === "acknowledge_cleanup") {
    if (current.state !== "cleanup_pending") {
      throw new StreamingSessionStoreError("invalid_state", "Only pending cleanup can be acknowledged.");
    }
    const effectId = requiredText(input.effectId, "effectId");
    const cleanup = currentEffects.find((effect) => effect.effectId === effectId && effect.kind === "cleanup");
    if (current.schemaVersion === STREAMING_SESSION_RECORD_VERSION && cleanup?.owner === "session_authority" &&
        (!cleanup?.progress || cleanup.progress.resources.some((resource) =>
          resource.status !== "verified" || resource.attempt !== undefined))) {
      throw new StreamingSessionStoreError("invalid_effect", "Adopted cleanup cannot release before all six resources are verified.");
    }
    return parseStreamingSessionRecord({
      ...current,
      cleanupCreationAuthority: durableCleanupCreationAuthority,
      schemaVersion: STREAMING_SESSION_RECORD_VERSION,
      revision: nextRevision,
      state: "released",
      cleanupOwner: "none",
      history: [...(current.history as readonly unknown[]), { state: "released", at }],
      effects: acknowledge(effectId, "cleanup"),
    });
  }
  if (input.type === "mark_cleanup_blocked") {
    if (current.state !== "cleanup_pending") {
      throw new StreamingSessionStoreError("invalid_state", "Only pending cleanup can be durably blocked.");
    }
    const effectId = requiredText(input.effectId, "effectId");
    const effect = currentEffects.find((candidate) => candidate.effectId === effectId);
    if (!effect || effect.kind !== "cleanup" || effect.status !== "pending") {
      throw new StreamingSessionStoreError("invalid_effect", "Streaming session cleanup effect is not pending.");
    }
    if (effect.owner === "session_authority" && effect.progress) {
      throw new StreamingSessionStoreError("invalid_effect", "Adopted cleanup must record an exact categorical resource blocker.");
    }
    return parseStreamingSessionRecord({
      ...current,
      cleanupCreationAuthority: durableCleanupCreationAuthority,
      schemaVersion: STREAMING_SESSION_RECORD_VERSION,
      revision: nextRevision,
      state: "cleanup_blocked",
      history: [...current.history, { state: "cleanup_blocked", at }],
      effects: currentEffects.map((candidate) => candidate.effectId === effectId
        ? {
          ...candidate,
          status: "blocked",
          blockedAt: at,
          cleanupProvenance: cleanupProvenanceFor(candidate, current.ownerId, current.fencingToken),
        }
        : candidate),
    });
  }
  if (input.type === "mark_disposition") {
    const disposition = input.disposition;
    if (disposition !== "input_unavailable" && disposition !== "backend_unavailable" &&
        disposition !== "outcome_unknown") {
      throw new StreamingSessionStoreError("invalid_state", "Streaming session disposition is invalid.");
    }
    if (![
      "active",
      "stopping",
      "input_unavailable",
      "backend_unavailable",
    ].includes(current.state)) {
      throw new StreamingSessionStoreError("invalid_state", "Streaming session cannot receive this disposition.");
    }
    if (current.cleanupOwner !== "session_authority") {
      throw new StreamingSessionStoreError("invalid_state", "Only adopted SessionAuthority ownership can receive a disposition.");
    }
    return parseStreamingSessionRecord({
      ...current,
      cleanupCreationAuthority: durableCleanupCreationAuthority,
      schemaVersion: STREAMING_SESSION_RECORD_VERSION,
      revision: nextRevision,
      state: disposition,
      history: [...current.history, { state: disposition, at }],
    });
  }
  if (current.state !== "pending_transfer") {
    throw new StreamingSessionStoreError("invalid_state", "Only a pending transfer can be acknowledged.");
  }
  const effectId = requiredText(input.effectId, "effectId");
  if (input.type === "mark_transfer_ambiguous") {
    acknowledge(effectId, "transfer");
    return parseStreamingSessionRecord({
      ...current,
      cleanupCreationAuthority: durableCleanupCreationAuthority,
      schemaVersion: STREAMING_SESSION_RECORD_VERSION,
      revision: nextRevision,
      state: "transfer_ambiguous",
      cleanupOwner: "provider_lease",
      history: [...(current.history as readonly unknown[]), { state: "transfer_ambiguous", at }],
    });
  }
  return parseStreamingSessionRecord({
    ...current,
    cleanupCreationAuthority: durableCleanupCreationAuthority,
    schemaVersion: STREAMING_SESSION_RECORD_VERSION,
    revision: nextRevision,
    state: "active",
    cleanupOwner: "session_authority",
    history: [...(current.history as readonly unknown[]), { state: "active", at }],
    effects: acknowledge(effectId, "transfer"),
  });
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || value.includes("\0")) {
    throw new StreamingSessionStoreError("invalid_record", `Streaming session ${name} is invalid.`);
  }
  return value;
}

function requiredOpaqueBackendIdentity(value: unknown): string {
  // Portable backend identities may encode a canonical platform path plus
  // process/fence facts. Windows extended paths alone can approach 32 KiB, so
  // this closed field has a purpose-specific bound instead of the label bound.
  if (typeof value !== "string" || !value.trim() || value.length > 64 * 1_024 || value.includes("\0")) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session backendBinding.opaqueIdentity is invalid.");
  }
  return value;
}

const HOST_LAUNCH_REQUIRED_KEYS = new Set([
  "recordKind", "schemaVersion", "revision", "launchId", "sessionId", "runId", "agentSessionId",
  "actor", "toolName", "callId", "ownerId", "fencingToken", "ownerExpiresAt", "state", "cleanupOwner", "history", "effects",
]);
const HOST_LAUNCH_ALLOWED_KEYS = new Set([
  ...HOST_LAUNCH_REQUIRED_KEYS, "leaseBinding", "backendBinding", "handshakeDigest", "channelAcquisitionStartedAt", "outputCheckpointCreatedAt",
]);

export function parseHostLaunchRecord(value: unknown): Readonly<HostLaunchRecord> {
  if (!isObjectRecord(value)) throw new StreamingSessionStoreError("invalid_record", "Host launch record must be an object.");
  if (value.recordKind !== HOST_LAUNCH_RECORD_KIND || value.schemaVersion !== HOST_LAUNCH_RECORD_VERSION) {
    throw new StreamingSessionStoreError(
      value.state === "released" ? "unsupported_version" : "unsupported_active_version",
      "Host launch record version is unsupported.",
    );
  }
  assertNoForbiddenDurableValues(value);
  assertExactKeys(value, HOST_LAUNCH_ALLOWED_KEYS, "host launch record");
  assertRequiredKeys(value, HOST_LAUNCH_REQUIRED_KEYS, "host launch record");
  const revision = requiredNonNegativeInteger(value.revision, "host launch revision");
  const fencingToken = requiredPositiveInteger(value.fencingToken, "host launch fence");
  const ownerExpiresAt = requiredTimestamp(value.ownerExpiresAt, "ownerExpiresAt");
  for (const key of ["launchId", "sessionId", "runId", "agentSessionId", "toolName", "callId", "ownerId"] as const) {
    requiredText(value[key], key);
  }
  parseActor(value.actor);
  if (!isHostLaunchState(value.state)) throw new StreamingSessionStoreError("invalid_state", "Host launch state is invalid.");
  if (value.cleanupOwner !== (value.state === "handed_off" || value.state === "released" ? "none" : "host_control")) {
    throw new StreamingSessionStoreError("invalid_state", "Host launch cleanup owner is invalid for state.");
  }
  if (!Array.isArray(value.history) || value.history.length < 1 || value.history.length > 64) {
    throw new StreamingSessionStoreError("invalid_record", "Host launch history is invalid.");
  }
  const history = value.history.map((entry) => {
    assertExactKeys(entry, new Set(["state", "at"]), "host launch history entry");
    const item = entry as Record<string, unknown>;
    if (!isHostLaunchState(item.state)) throw new StreamingSessionStoreError("invalid_state", "Host launch history state is invalid.");
    return Object.freeze({ state: item.state, at: requiredTimestamp(item.at, "history at") });
  });
  if (history.at(-1)?.state !== value.state || history.length !== revision + 1) {
    throw new StreamingSessionStoreError("invalid_state", "Host launch history does not match revision/state.");
  }
  if (!Array.isArray(value.effects) || value.effects.length < 1 || value.effects.length > 32) {
    throw new StreamingSessionStoreError("invalid_effect", "Host launch effects are invalid.");
  }
  const effects = value.effects.map(parseHostLaunchEffect);
  const leaseBinding = value.leaseBinding === undefined ? undefined : parseHostLeaseBinding(value.leaseBinding);
  const backendBinding = value.backendBinding === undefined ? undefined : parseBackendBindingValue(value.backendBinding);
  const handshakeDigest = value.handshakeDigest === undefined ? undefined : requiredDigest(value.handshakeDigest, "handshakeDigest");
  const channelAcquisitionStartedAt = value.channelAcquisitionStartedAt === undefined ? undefined : requiredTimestamp(value.channelAcquisitionStartedAt, "channelAcquisitionStartedAt");
  const outputCheckpointCreatedAt = value.outputCheckpointCreatedAt === undefined ? undefined : requiredTimestamp(value.outputCheckpointCreatedAt, "outputCheckpointCreatedAt");
  if ((value.state === "isolated" || value.state === "launching" || value.state === "bound" || value.state === "handshake_verified" || value.state === "handed_off") && !leaseBinding) {
    throw new StreamingSessionStoreError("invalid_state", "Host launch lease binding is required.");
  }
  if ((value.state === "bound" || value.state === "handshake_verified" || value.state === "handed_off") && !backendBinding) {
    throw new StreamingSessionStoreError("invalid_state", "Host launch backend binding is required.");
  }
  if ((value.state === "handshake_verified" || value.state === "handed_off") && !handshakeDigest) {
    throw new StreamingSessionStoreError("invalid_state", "Host launch handshake digest is required.");
  }
  if (channelAcquisitionStartedAt && !backendBinding) throw new StreamingSessionStoreError("invalid_state", "Channel acquisition marker requires an exact backend binding.");
  if (outputCheckpointCreatedAt && !channelAcquisitionStartedAt) throw new StreamingSessionStoreError("invalid_state", "Output checkpoint marker requires a channel acquisition marker.");
  const parsed = deepFreeze(structuredClone({ ...value, revision, fencingToken, ownerExpiresAt, history, effects, ...(leaseBinding ? { leaseBinding } : {}), ...(backendBinding ? { backendBinding } : {}), ...(handshakeDigest ? { handshakeDigest } : {}), ...(channelAcquisitionStartedAt ? { channelAcquisitionStartedAt } : {}), ...(outputCheckpointCreatedAt ? { outputCheckpointCreatedAt } : {}) })) as unknown as Readonly<HostLaunchRecord>;
  assertHostLaunchLifecycle(parsed);
  return parsed;
}

function assertHostLaunchLifecycle(record: Readonly<HostLaunchRecord>): void {
  const allowed = new Map<HostLaunchState, readonly HostLaunchState[]>([
    ["prepared", ["isolated", "cleanup_pending"]], ["isolated", ["launching", "cleanup_pending"]],
    ["launching", ["bound", "cleanup_pending"]], ["bound", ["handshake_verified", "cleanup_pending"]],
    ["handshake_verified", ["handed_off", "cleanup_pending"]], ["cleanup_pending", ["cleanup_blocked", "released"]],
    ["cleanup_blocked", ["cleanup_pending"]], ["handed_off", []], ["released", []],
  ]);
  if (record.history[0]?.state !== "prepared") throw new StreamingSessionStoreError("invalid_state", "Host launch history must begin prepared.");
  const pendingTakeovers = [...(record.effects.find((effect) => effect.kind === "cleanup")?.takeovers ?? [])];
  const markerRepeatIndexes: number[] = [];
  for (let index = 1; index < record.history.length; index++) {
    const prior = record.history[index - 1]!; const entry = record.history[index]!;
    // A takeover enters cleanup from any nonterminal source, not just pending.
    // Consume provenance in order before a same-time checkpoint marker repeats it.
    const takeover = entry.state === "cleanup_pending" &&
      (prior.state === "cleanup_pending" || (allowed.get(prior.state) ?? []).includes("cleanup_pending")) &&
      pendingTakeovers[0]?.at === entry.at;
    const markerRepeat = (prior.state === "bound" && entry.state === "bound" &&
      (entry.at === record.channelAcquisitionStartedAt || entry.at === record.outputCheckpointCreatedAt)) ||
      (!takeover && prior.state === "cleanup_pending" && entry.state === "cleanup_pending" &&
        entry.at === record.outputCheckpointCreatedAt);
    if (markerRepeat) markerRepeatIndexes.push(index);
    if ((!takeover && !markerRepeat && !(allowed.get(prior.state) ?? []).includes(entry.state)) || Date.parse(entry.at) < Date.parse(prior.at)) throw new StreamingSessionStoreError("invalid_state", "Host launch history transition is impossible.");
    if (takeover) pendingTakeovers.shift();
  }
  if (pendingTakeovers.length) throw new StreamingSessionStoreError("invalid_effect", "Host cleanup takeover history is incomplete or out of order.");
  const expectedMarkerTimes = [record.channelAcquisitionStartedAt, record.outputCheckpointCreatedAt].filter((value): value is string => Boolean(value));
  if (markerRepeatIndexes.length !== expectedMarkerTimes.length || markerRepeatIndexes.some((historyIndex, markerIndex) => record.history[historyIndex]?.at !== expectedMarkerTimes[markerIndex])) throw new StreamingSessionStoreError("invalid_state", "Host launch durable marker history is incomplete or out of order.");
  const byId = new Map<string, HostLaunchEffect>();
  for (const effect of record.effects) {
    if (byId.has(effect.effectId)) throw new StreamingSessionStoreError("invalid_effect", "Host launch effect ids must be unique.");
    byId.set(effect.effectId, effect);
    const expectedId = `${effect.kind}:${record.launchId}`;
    if (effect.effectId !== expectedId) throw new StreamingSessionStoreError("invalid_effect", "Host launch effect id is not normative.");
    if (effect.status === "pending" && (effect.acknowledgedAt || effect.blockedAt || effect.blocker)) throw new StreamingSessionStoreError("invalid_effect", "Pending host effect carries terminal evidence.");
    if (effect.status === "acknowledged" && (!effect.acknowledgedAt || effect.blockedAt || effect.blocker)) throw new StreamingSessionStoreError("invalid_effect", "Acknowledged host effect evidence is invalid.");
    if (effect.status === "blocked" && (effect.kind !== "cleanup" || !effect.blockedAt || !effect.blocker || effect.acknowledgedAt)) throw new StreamingSessionStoreError("invalid_effect", "Blocked host effect evidence is invalid.");
  }
  const visited = new Set(record.history.map((entry) => entry.state));
  if (visited.has("handshake_verified") && (!record.channelAcquisitionStartedAt || !record.outputCheckpointCreatedAt)) throw new StreamingSessionStoreError("invalid_state", "Later host launch progress requires exact channel and checkpoint markers.");
  const isolate = byId.get(`isolate:${record.launchId}`);
  if (!isolate || isolate.kind !== "isolate") throw new StreamingSessionStoreError("invalid_effect", "Normative isolation effect is missing.");
  if (isolate.fencingToken > record.fencingToken) throw new StreamingSessionStoreError("invalid_effect", "Isolation effect fence exceeds current ownership.");
  const hasLateIsolationTransition = record.history.some((entry, index) => entry.state === "cleanup_pending" && record.history[index - 1]?.state === "cleanup_blocked" && entry.at === isolate.acknowledgedAt);
  if (isolate.status !== (record.leaseBinding ? "acknowledged" : "pending") || isolate.createdAt !== record.history[0]!.at || (visited.has("isolated") && isolate.acknowledgedAt !== record.history.find((entry) => entry.state === "isolated")!.at) || (!visited.has("isolated") && record.leaseBinding && !hasLateIsolationTransition)) throw new StreamingSessionStoreError("invalid_effect", "Isolation effect state or timing does not match history.");
  const launch = byId.get(`launch:${record.launchId}`);
  if (visited.has("launching") !== Boolean(launch) || (launch && launch.kind !== "launch")) throw new StreamingSessionStoreError("invalid_effect", "Normative launch effect does not match history.");
  if (launch && (launch.status !== (visited.has("bound") ? "acknowledged" : "pending") || launch.createdAt !== record.history.find((entry) => entry.state === "launching")!.at || (visited.has("bound") && launch.acknowledgedAt !== record.history.find((entry) => entry.state === "bound")!.at))) throw new StreamingSessionStoreError("invalid_effect", "Launch effect state or timing does not match history.");
  if (launch && (launch.ownerId !== isolate.ownerId || launch.fencingToken !== isolate.fencingToken)) throw new StreamingSessionStoreError("invalid_effect", "Launch effect provenance differs from isolation ownership.");
  const handoff = byId.get(`handoff:${record.launchId}`);
  if (visited.has("handshake_verified") !== Boolean(handoff) || (handoff && handoff.kind !== "handoff")) throw new StreamingSessionStoreError("invalid_effect", "Normative handoff effect does not match history.");
  if (handoff && (handoff.status !== (visited.has("handed_off") ? "acknowledged" : "pending") || handoff.createdAt !== record.history.find((entry) => entry.state === "handshake_verified")!.at || (visited.has("handed_off") && handoff.acknowledgedAt !== record.history.find((entry) => entry.state === "handed_off")!.at))) throw new StreamingSessionStoreError("invalid_effect", "Handoff effect state or timing does not match history.");
  if (handoff && (handoff.ownerId !== isolate.ownerId || handoff.fencingToken !== isolate.fencingToken)) throw new StreamingSessionStoreError("invalid_effect", "Handoff effect provenance differs from launch ownership.");
  const cleanup = byId.get(`cleanup:${record.launchId}`);
  const cleanupVisited = visited.has("cleanup_pending") || visited.has("cleanup_blocked") || visited.has("released");
  if (cleanupVisited !== Boolean(cleanup) || (cleanup && cleanup.kind !== "cleanup")) throw new StreamingSessionStoreError("invalid_effect", "Normative cleanup effect does not match history.");
  if (cleanup && record.state === "cleanup_pending" && cleanup.status !== "pending") throw new StreamingSessionStoreError("invalid_effect", "Cleanup pending state/effect mismatch.");
  if (cleanup && record.state === "cleanup_blocked" && cleanup.status !== "blocked") throw new StreamingSessionStoreError("invalid_effect", "Cleanup blocked state/effect mismatch.");
  if (cleanup && record.state === "released" && cleanup.status !== "acknowledged") throw new StreamingSessionStoreError("invalid_effect", "Released cleanup state/effect mismatch.");
  if (cleanup && !sameCleanupDefinitions(cleanup.resources ?? [], derivedHostCleanupDefinitions(record))) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource facts do not equal the kernel-derived obligation set.");
  if (cleanup?.resources?.some((resource) => resource.status === "pending") && record.state !== "cleanup_pending") throw new StreamingSessionStoreError("invalid_effect", "Pending cleanup resources require pending cleanup ownership.");
  if (record.state === "cleanup_blocked" && cleanup?.resources?.every((resource) => resource.status === "succeeded")) throw new StreamingSessionStoreError("invalid_effect", "Blocked cleanup must retain an unresolved resource.");
  if (record.state === "released" && cleanup?.resources?.some((resource) => resource.status !== "succeeded")) throw new StreamingSessionStoreError("invalid_effect", "Released cleanup contains an unresolved resource.");
  if (cleanup && (cleanup.originOwnerId !== isolate.ownerId || cleanup.originFencingToken !== isolate.fencingToken)) throw new StreamingSessionStoreError("invalid_effect", "Cleanup effect origin differs from launch ownership.");
  if (!cleanup && record.state !== "handed_off" && (record.ownerId !== isolate.ownerId || record.fencingToken !== isolate.fencingToken)) throw new StreamingSessionStoreError("invalid_effect", "Host ownership differs from normative effect provenance.");
  if ((visited.has("isolated") && !record.leaseBinding) || visited.has("bound") !== Boolean(record.backendBinding) || visited.has("handshake_verified") !== Boolean(record.handshakeDigest)) throw new StreamingSessionStoreError("invalid_state", "Host attested bindings do not match lifecycle history.");
  if ((record.state === "handed_off" || record.state === "released") !== (record.ownerId === "none")) throw new StreamingSessionStoreError("invalid_state", "Host launch terminal ownership is invalid.");
}

export function parseOutputCheckpointRecord(value: unknown): Readonly<OutputCheckpointRecord> {
  if (!isObjectRecord(value)) throw new StreamingSessionStoreError("invalid_record", "Output checkpoint must be an object.");
  assertNoForbiddenDurableValues(value);
  const keys = new Set(["recordKind", "schemaVersion", "revision", "sessionId", "ownerId", "fencingToken", "capacity", "outcome", "streams"]);
  assertExactKeys(value, new Set([...keys, ...(value.schemaVersion === 2 ? ["continuation"] : [])]), "output checkpoint"); assertRequiredKeys(value, keys, "output checkpoint");
  if (value.recordKind !== OUTPUT_CHECKPOINT_RECORD_KIND || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) throw new StreamingSessionStoreError("unsupported_active_version", "Output checkpoint version is unsupported.");
  const continuation = value.schemaVersion === 2 ? parseEvidenceContinuation(value.continuation) : undefined;
  const revision = requiredNonNegativeInteger(value.revision, "checkpoint revision");
  const sessionId = requiredText(value.sessionId, "sessionId"); const ownerId = requiredText(value.ownerId, "ownerId");
  const fencingToken = requiredPositiveInteger(value.fencingToken, "checkpoint fence");
  const capacity = requiredPositiveInteger(value.capacity, "checkpoint capacity");
  if (capacity > 4096) throw new StreamingSessionStoreError("capacity_exceeded", "Output checkpoint capacity is unsafe.");
  if (value.outcome !== "active" && value.outcome !== "outcome_unknown") throw new StreamingSessionStoreError("invalid_state", "Output checkpoint outcome is invalid.");
  if (!Array.isArray(value.streams) || value.streams.length < 1 || value.streams.length > 2) throw new StreamingSessionStoreError("invalid_record", "Output checkpoint streams are invalid.");
  const seen = new Set<string>();
  const streams = value.streams.map((raw) => {
    const streamKeys = new Set(["stream", "lastConsumed", "consumed", "accepted", "consumingIntent"]);
    assertExactKeys(raw, streamKeys, "output stream checkpoint"); assertRequiredKeys(raw as Record<string, unknown>, streamKeys, "output stream checkpoint");
    const item = raw as Record<string, unknown>;
    if ((item.stream !== "stdout" && item.stream !== "stderr") || seen.has(item.stream)) throw new StreamingSessionStoreError("invalid_record", "Output checkpoint stream is invalid or duplicated.");
    seen.add(item.stream);
    const lastConsumed = item.lastConsumed === null ? null : parseOutputMetadata(item.lastConsumed, item.stream);
    if (!Array.isArray(item.consumed) || item.consumed.length > capacity) throw new StreamingSessionStoreError("capacity_exceeded", "Consumed replay metadata window exceeds capacity.");
    const consumed = item.consumed.map((entry) => parseOutputMetadata(entry, item.stream));
    for (let consumedIndex = 1; consumedIndex < consumed.length; consumedIndex++) {
      const prior = consumed[consumedIndex - 1]!; const entry = consumed[consumedIndex]!;
      if (entry.sequence !== prior.sequence + 1 || entry.startOffset !== prior.endOffset) throw new StreamingSessionStoreError("invalid_effect", "Consumed replay metadata is not continuous.");
    }
    if ((lastConsumed === null) !== (consumed.length === 0) || (lastConsumed && canonicalJson(lastConsumed) !== canonicalJson(consumed.at(-1)))) throw new StreamingSessionStoreError("invalid_effect", "Last consumed metadata does not match the replay window.");
    if (!Array.isArray(item.accepted) || item.accepted.length > capacity) throw new StreamingSessionStoreError("capacity_exceeded", "Accepted output metadata window exceeds capacity.");
    const accepted = item.accepted.map((entry) => parseOutputMetadata(entry, item.stream));
    let sequence = lastConsumed?.sequence ?? 0; let offset = lastConsumed?.endOffset ?? 0;
    for (const entry of accepted) { if (entry.sequence !== sequence + 1 || entry.startOffset !== offset) throw new StreamingSessionStoreError("invalid_effect", "Accepted output metadata is not continuous."); sequence = entry.sequence; offset = entry.endOffset; }
    const consumingIntent = item.consumingIntent === null ? null : parseOutputMetadata(item.consumingIntent, item.stream);
    if (consumingIntent && canonicalJson(consumingIntent) !== canonicalJson(accepted[0])) throw new StreamingSessionStoreError("invalid_effect", "Consuming intent must name the first accepted chunk.");
    return Object.freeze({ stream: item.stream, lastConsumed, consumed: Object.freeze(consumed), accepted: Object.freeze(accepted), consumingIntent });
  });
  if (streams.reduce((total, stream) => total + stream.accepted.length, 0) > capacity) throw new StreamingSessionStoreError("capacity_exceeded", "Aggregate accepted output metadata exceeds provider capacity.");
  return deepFreeze({ recordKind: OUTPUT_CHECKPOINT_RECORD_KIND, schemaVersion: value.schemaVersion, revision, sessionId, ownerId, fencingToken, capacity, outcome: value.outcome, streams, ...(continuation ? { continuation } : {}) } as OutputCheckpointRecord);
}

function parseOutputMetadata(value: unknown, expectedStream?: unknown): OutputChunkMetadata {
  const keys = new Set(["stream", "sequence", "startOffset", "endOffset", "byteLength", "digest"]);
  assertExactKeys(value, keys, "output chunk metadata"); assertRequiredKeys(value as Record<string, unknown>, keys, "output chunk metadata");
  const item = value as Record<string, unknown>;
  if ((item.stream !== "stdout" && item.stream !== "stderr") || (expectedStream !== undefined && item.stream !== expectedStream)) throw new StreamingSessionStoreError("invalid_record", "Output stream mismatch.");
  const sequence = requiredPositiveInteger(item.sequence, "output sequence"); const startOffset = requiredNonNegativeInteger(item.startOffset, "output start offset");
  const endOffset = requiredPositiveInteger(item.endOffset, "output end offset"); const byteLength = requiredPositiveInteger(item.byteLength, "output byte length");
  if (endOffset - startOffset !== byteLength) throw new StreamingSessionStoreError("invalid_effect", "Output offsets do not match length.");
  return Object.freeze({ stream: item.stream, sequence, startOffset, endOffset, byteLength, digest: requiredDigest(item.digest, "output digest") });
}

function applyOutputCheckpointCommand(current: Readonly<OutputCheckpointRecord>, input: Record<string, unknown>): Readonly<OutputCheckpointRecord> {
  assertNoForbiddenDurableValues(input);
  assertExactKeys(input, new Set(["type", "sessionId", "ownerId", "fencingToken", "expectedRevision", "metadata", "at", "continuation"]), "output checkpoint command");
  if (requiredText(input.ownerId, "ownerId") !== current.ownerId || requiredPositiveInteger(input.fencingToken, "fencingToken") !== current.fencingToken) throw new StreamingSessionStoreError("stale_fence", "Output checkpoint owner/fence is stale.");
  const expectedRevision = requiredNonNegativeInteger(input.expectedRevision, "expectedRevision");
  if (current.outcome !== "active") {
    if (input.type === "mark_outcome_unknown" && expectedRevision === current.revision) return current;
    throw new StreamingSessionStoreError("invalid_state", "Output checkpoint is terminal outcome_unknown.");
  }
  if (input.type === "commit_continuation") {
    if (expectedRevision !== current.revision) throw new StreamingSessionStoreError("revision_conflict", "Output checkpoint revision is stale.");
    const next = parseEvidenceContinuation(input.continuation);
    const prior = current.continuation;
    if (prior) {
      if (prior.finalized || prior.evidenceId !== next.evidenceId || canonicalJson(prior.legacyHashes) !== canonicalJson(next.legacyHashes) ||
          (prior.loss !== "none" && next.loss !== prior.loss && !(prior.loss === "legacy_gap" && next.loss.startsWith("legacy_gap_"))) ||
          next.pages < prior.pages || next.pages > prior.pages + 1 || next.retainedBytes < prior.retainedBytes)
        throw new StreamingSessionStoreError("invalid_effect", "Evidence continuation cannot be rewritten.");
      const advanced = next.positions.filter((p, i) => canonicalJson(p) !== canonicalJson(prior.positions[i]));
      if (next.finalized) {
        if (advanced.length || prior.head !== next.head || prior.pages !== next.pages || prior.retainedBytes !== next.retainedBytes || prior.loss !== next.loss)
          throw new StreamingSessionStoreError("invalid_effect", "Evidence finalization cannot change committed positions.");
      } else {
        if (advanced.length !== 1) throw new StreamingSessionStoreError("invalid_effect", "Evidence commit must advance exactly one stream.");
        const p = advanced[0]!; const old = prior.positions.find((s) => s.stream === p.stream)!;
        if (!p.last || p.last.sequence !== (old.last?.sequence ?? 0) + 1 || p.last.startOffset !== (old.last?.endOffset ?? 0) ||
            (next.pages === prior.pages ? next.head !== prior.head || p.lostBytes - old.lostBytes !== p.last.byteLength :
              next.head === prior.head || p.lostBytes !== old.lostBytes || next.retainedBytes - prior.retainedBytes !== p.last.byteLength))
          throw new StreamingSessionStoreError("invalid_effect", "Evidence commit does not match its exact position.");
      }
    } else if (next.pages !== 0 || next.head !== null || next.finalized ||
        canonicalJson(next.legacyHashes) !== canonicalJson([...new Set(current.streams.flatMap((s) => [...s.consumed, ...s.accepted].map((m) => m.digest)))]) || next.positions.some((p) => {
      const last = current.streams.find((s) => s.stream === p.stream)?.lastConsumed ?? null;
      return canonicalJson(last) !== canonicalJson(p.last) || p.lostBytes !== (last?.endOffset ?? 0);
    })) throw new StreamingSessionStoreError("invalid_effect", "Legacy evidence upgrade must retain an explicit consumed gap.");
    return parseOutputCheckpointRecord({ ...current, schemaVersion: 2, revision: current.revision + 1, continuation: next });
  }
  const metadata = parseOutputMetadata(input.metadata);
  const index = current.streams.findIndex((stream) => stream.stream === metadata.stream);
  if (index < 0) throw new StreamingSessionStoreError("invalid_record", "Output stream is not configured.");
  const stream = current.streams[index]!;
  if (input.type === "accept" && stream.lastConsumed && metadata.sequence <= stream.lastConsumed.sequence) {
    if (stream.consumed.some((entry) => canonicalJson(entry) === canonicalJson(metadata))) return current;
    throw new StreamingSessionStoreError("invalid_effect", "Consumed output replay metadata mismatches.");
  }
  if (expectedRevision !== current.revision) throw new StreamingSessionStoreError("revision_conflict", "Output checkpoint revision is stale.");
  let nextStream: OutputStreamCheckpoint;
  if (input.type === "accept") {
    if (current.streams.reduce((total, item) => total + item.accepted.length, 0) >= current.capacity) throw new StreamingSessionStoreError("capacity_exceeded", "Aggregate accepted output metadata window is full.");
    const prior = stream.accepted.at(-1) ?? stream.lastConsumed;
    if (metadata.sequence !== (prior?.sequence ?? 0) + 1 || metadata.startOffset !== (prior?.endOffset ?? 0)) throw new StreamingSessionStoreError("invalid_effect", "Output metadata is not continuous.");
    nextStream = { ...stream, accepted: [...stream.accepted, metadata] };
  } else if (input.type === "begin_consume") {
    if (current.continuation && (current.continuation.positions.find((p) => p.stream === metadata.stream)?.last?.sequence ?? 0) < metadata.sequence) throw new StreamingSessionStoreError("invalid_effect", "Evidence must be committed before family consumption.");
    if (stream.consumingIntent || canonicalJson(stream.accepted[0]) !== canonicalJson(metadata)) throw new StreamingSessionStoreError("invalid_effect", "Output consuming intent is invalid.");
    nextStream = { ...stream, consumingIntent: metadata };
  } else if (input.type === "commit_consumed") {
    if (canonicalJson(stream.consumingIntent) !== canonicalJson(metadata) || canonicalJson(stream.accepted[0]) !== canonicalJson(metadata)) throw new StreamingSessionStoreError("invalid_effect", "Output consumed commit is invalid.");
    nextStream = { ...stream, lastConsumed: metadata, consumed: [...stream.consumed, metadata].slice(-current.capacity), accepted: stream.accepted.slice(1), consumingIntent: null };
  } else if (input.type === "cancel_consume") {
    if (canonicalJson(stream.consumingIntent) !== canonicalJson(metadata) || canonicalJson(stream.accepted[0]) !== canonicalJson(metadata)) throw new StreamingSessionStoreError("invalid_effect", "Output consuming intent cancellation is invalid.");
    nextStream = { ...stream, consumingIntent: null };
  } else if (input.type === "commit_evidence_consumed") {
    if (current.continuation && (current.continuation.positions.find((p) => p.stream === metadata.stream)?.last?.sequence ?? 0) < metadata.sequence) throw new StreamingSessionStoreError("invalid_effect", "Evidence must be committed before acknowledgement.");
    const accepted = stream.accepted.length > 0;
    if (stream.consumingIntent || (accepted ? canonicalJson(stream.accepted[0]) !== canonicalJson(metadata) : metadata.sequence !== (stream.lastConsumed?.sequence ?? 0) + 1 || metadata.startOffset !== (stream.lastConsumed?.endOffset ?? 0))) throw new StreamingSessionStoreError("invalid_effect", "Evidence-only consumed commit is invalid.");
    // Evidence acceptance and consumption are one atomic metadata update after
    // spool acceptance/loss, so stderr never occupies a retained protocol slot.
    nextStream = { ...stream, lastConsumed: metadata, consumed: [...stream.consumed, metadata].slice(-current.capacity), accepted: stream.accepted.slice(1), consumingIntent: null };
  } else if (input.type === "mark_outcome_unknown") {
    return parseOutputCheckpointRecord({ ...current, revision: current.revision + 1, outcome: "outcome_unknown" });
  } else throw new StreamingSessionStoreError("invalid_effect", "Output checkpoint command is unsupported.");
  const streams = [...current.streams]; streams[index] = nextStream;
  return parseOutputCheckpointRecord({ ...current, revision: current.revision + 1, streams });
}

function cloneOutputCheckpoint(record: Readonly<OutputCheckpointRecord>): Readonly<OutputCheckpointRecord> { return deepFreeze(structuredClone(record)); }

function outputEvidenceDestination(
  checkpoint: Readonly<OutputCheckpointRecord> | undefined,
  input: Record<string, unknown>,
  session: Readonly<StreamingSessionRecord> | undefined,
  host: Readonly<HostLaunchRecord> | undefined,
): Readonly<AdoptedCleanupEvidenceReference> | undefined {
  if (checkpoint && !checkpoint.continuation) return undefined;
  const reference = parseAdoptedCleanupEvidenceReference(input.evidence);
  if (reference.kind !== "bounded_output_manifest") throw new StreamingSessionStoreError("invalid_effect", "Durable evidence continuation is unavailable.");
  const finalized = checkpoint?.continuation?.finalized;
  if (checkpoint && (!finalized || finalized.manifestHash !== reference.digest || finalized.lossy !== reference.lossy ||
      checkpoint.streams.some((stream) => stream.accepted.length || stream.consumingIntent)))
    throw new StreamingSessionStoreError("invalid_effect", "Evidence source is not exactly finalized and settled.");
  if (session) {
    const fact = session.effects.find((effect) => effect.kind === "cleanup")?.progress?.resources.find((resource) => resource.resource === "evidence");
    if (session.state !== "released" || session.sessionId !== input.sessionId || fact?.status !== "verified" || canonicalJson(fact.evidence) !== canonicalJson(reference))
      throw new StreamingSessionStoreError("invalid_effect", "Authenticated evidence destination does not match.");
    return reference;
  }
  const cleanup = host?.effects.find((effect) => effect.kind === "cleanup");
  const fact = cleanup?.resources?.find((resource) => resource.resource === "output_checkpoint");
  if (!host || host.sessionId !== input.sessionId || !cleanup || !fact)
    throw new StreamingSessionStoreError("invalid_effect", "Durable evidence continuation is unavailable.");
  if (fact.status === "succeeded") {
    if (canonicalJson(fact.evidence) !== canonicalJson(reference)) throw new StreamingSessionStoreError("invalid_effect", "Authenticated evidence destination does not match.");
    return reference;
  }
  throw new StreamingSessionStoreError("invalid_effect", "Host evidence transfer requires a successful authenticated cleanup fact.");
}

function outputDeletionDestination(
  checkpoint: Readonly<OutputCheckpointRecord> | undefined,
  input: Record<string, unknown>,
  session: Readonly<StreamingSessionRecord> | undefined,
  host: Readonly<HostLaunchRecord> | undefined,
  evidence = outputEvidenceDestination(checkpoint, input, session, host),
): Readonly<HostLaunchRecord> | undefined {
  if (!evidence) return undefined;
  if (host && !hostOutputChannelSettled(host))
    throw new StreamingSessionStoreError("invalid_effect", "The channel still owns its output checkpoint.");
  return undefined;
}

function hostOutputChannelSettled(host: Readonly<HostLaunchRecord>): boolean {
  return host.effects.find((effect) => effect.kind === "cleanup")?.resources?.find((resource) => resource.resource === "channel")?.status === "succeeded";
}

function settledHostEvidenceCheckpoint(host: Readonly<HostLaunchRecord>, checkpoint: Readonly<OutputCheckpointRecord> | undefined): boolean {
  const resources = host.effects.find((effect) => effect.kind === "cleanup")?.resources;
  const fact = resources?.find((resource) => resource.resource === "output_checkpoint");
  if (!checkpoint?.continuation || fact?.status !== "succeeded") return false;
  const evidence = outputEvidenceDestination(checkpoint, { sessionId: host.sessionId, evidence: fact.evidence }, undefined, host);
  // Valid evidence success is durable partial progress, not permission to retire a reader.
  if (!hostOutputChannelSettled(host)) return false;
  outputDeletionDestination(checkpoint, { sessionId: host.sessionId, evidence: fact.evidence }, undefined, host, evidence);
  return true;
}

function settledSessionEvidenceCheckpoint(session: Readonly<StreamingSessionRecord>, checkpoint: Readonly<OutputCheckpointRecord> | undefined): boolean {
  if (session.state !== "released" || !checkpoint?.continuation) return false;
  const evidence = session.effects.find((effect) => effect.kind === "cleanup")?.progress?.resources.find((fact) => fact.resource === "evidence")?.evidence;
  outputDeletionDestination(checkpoint, { sessionId: session.sessionId, evidence }, session, undefined);
  return true;
}

function assertAdoptionOutput(session: Readonly<StreamingSessionRecord>, checkpoint: Readonly<OutputCheckpointRecord> | undefined): void {
  if (!checkpoint || checkpoint.sessionId !== session.sessionId || checkpoint.ownerId !== session.ownerId ||
      checkpoint.fencingToken !== session.fencingToken || checkpoint.outcome !== "active" ||
      checkpoint.streams.some((stream) => stream.consumingIntent) || checkpoint.continuation?.finalized)
    throw new StreamingSessionStoreError("invalid_effect", "Adoption requires exact active checkpoint authority.");
}

function refencedOutputCheckpoint(current: Readonly<OutputCheckpointRecord>, input: Record<string, unknown>): Readonly<OutputCheckpointRecord> {
  if (current.sessionId !== requiredText(input.sessionId, "sessionId") || current.ownerId !== requiredText(input.ownerId, "ownerId") || current.fencingToken !== requiredPositiveInteger(input.fencingToken, "fencingToken")) throw new StreamingSessionStoreError("stale_fence", "Output checkpoint owner/fence is stale.");
  if (current.revision !== requiredNonNegativeInteger(input.outputExpectedRevision, "outputExpectedRevision")) throw new StreamingSessionStoreError("revision_conflict", "Output checkpoint revision is stale.");
  if (current.outcome !== "active" || current.streams.some((stream) => stream.consumingIntent)) throw new StreamingSessionStoreError("invalid_state", "Ambiguous or terminal output cannot be re-fenced.");
  return parseOutputCheckpointRecord({ ...current, revision: current.revision + 1, ownerId: requiredText(input.newOwnerId, "newOwnerId"), fencingToken: requiredPositiveInteger(input.newFencingToken, "newFencingToken") });
}

function adoptedTakeoverCommand(command: unknown): Record<string, unknown> {
  const input = commandRecord(command, "adopted output takeover");
  assertExactKeys(input, new Set(["sessionId", "ownerId", "fencingToken", "expectedRevision", "outputExpectedRevision", "newOwnerId", "newFencingToken", "leaseExpiresAt", "at"]), "adopted output takeover");
  return input;
}

function readSqliteOutputCheckpoint(database: DatabaseSync, integrityKey: Uint8Array, sessionId: string): Readonly<OutputCheckpointRecord> | undefined {
  const row = database.prepare("SELECT record_json, integrity, revision FROM streaming_output_checkpoints WHERE session_id = ?").get(sessionId) as { record_json: string; integrity: string; revision: number } | undefined;
  if (!row) return undefined;
  const actual = createHmac("sha256", integrityKey).update(row.record_json).digest(); const expected = Buffer.from(row.integrity, "hex");
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) throw new StreamingSessionStoreError("invalid_record", "Output checkpoint integrity failed.");
  const parsed = parseOutputCheckpointRecord(JSON.parse(row.record_json)); if (parsed.revision !== row.revision) throw new StreamingSessionStoreError("invalid_record", "Output checkpoint revision is corrupt."); return parsed;
}

function createHostLaunchWriter(
  sessionWriter: StreamingSessionStoreWriter,
  sessions: Map<string, Readonly<StreamingSessionRecord>>,
  records: Map<string, Readonly<HostLaunchRecord>>,
  outputCheckpoints: Map<string, Readonly<OutputCheckpointRecord>>,
  capacity: number,
  sessionCapacity: number,
  outputCapacity: number,
): StreamingSessionKernelWriter {
  return Object.freeze({
    ...sessionWriter,
    prepareLaunch(record: unknown) {
      const parsed = parseHostLaunchRecord(record);
      if (parsed.state !== "prepared" || parsed.revision !== 0) throw new StreamingSessionStoreError("invalid_state", "New host launches must begin prepared.");
      const existing = records.get(parsed.launchId);
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(parsed)) throw new StreamingSessionStoreError("identity_conflict", "Host launch identity conflicts.");
        return Object.freeze({ record: cloneHostLaunchRecord(existing), won: false });
      }
      if (records.size >= capacity) throw new StreamingSessionStoreError("capacity_exceeded", "Host launch capacity is full.");
      records.set(parsed.launchId, parsed);
      return Object.freeze({ record: cloneHostLaunchRecord(parsed), won: true });
    },
    transitionLaunch(command: unknown) {
      const input = commandRecord(command, "host launch command");
      const launchId = requiredText(input.launchId, "launchId");
      const current = records.get(launchId);
      if (!current) throw new StreamingSessionStoreError("invalid_record", "Host launch is unknown.");
      assertHostOutputCheckpointLink(current, outputCheckpoints.get(current.sessionId));
      const next = applyHostLaunchCommand(current, input);
      const deleteOutput = settledHostEvidenceCheckpoint(next, outputCheckpoints.get(current.sessionId));
      if (next !== current) records.set(launchId, next);
      if (deleteOutput) outputCheckpoints.delete(current.sessionId);
      return cloneHostLaunchRecord(next);
    },
    commitAdoption(input: StreamingSessionAdoptionInput) {
      const session = parseStreamingSessionRecord(input.sessionRecord);
      const durableLaunch = records.get(input.launchId);
      if (durableLaunch?.state === "handed_off") {
        const existing = sessions.get(session.sessionId);
        assertAdoptionPair(durableLaunch, session);
        if (!existing || canonicalJson(existing) !== canonicalJson(session)) throw new StreamingSessionStoreError("identity_conflict", "Handed-off adoption pair is corrupt.");
        return Object.freeze({ launch: cloneHostLaunchRecord(durableLaunch), session: cloneRecord(existing) });
      }
      const launch = requiredAdoptionLaunch(durableLaunch, input);
      assertAdoptionPair(launch, session);
      assertAdoptionOutput(session, outputCheckpoints.get(session.sessionId));
      const existing = sessions.get(session.sessionId);
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(session)) throw new StreamingSessionStoreError("identity_conflict", "Session collision retained host ownership.");
        const handed = records.get(launch.launchId)!;
        if (handed.state !== "handed_off") throw new StreamingSessionStoreError("invalid_state", "Adoption pair is impossible.");
        return Object.freeze({ launch: cloneHostLaunchRecord(handed), session: cloneRecord(existing) });
      }
      if (sessions.size >= sessionCapacity) throw new StreamingSessionStoreError("capacity_exceeded", "Streaming session capacity is full; host ownership was retained.");
      const handed = handoffHostLaunch(launch, input.at);
      sessions.set(session.sessionId, session);
      records.set(launch.launchId, handed);
      return Object.freeze({ launch: cloneHostLaunchRecord(handed), session: cloneRecord(session) });
    },
    claimOutputCheckpoint(record: unknown) {
      const parsed = parseOutputCheckpointRecord(record);
      if ([...records.values()].some((launch) => launch.sessionId === parsed.sessionId && launch.state !== "handed_off" && launch.state !== "released")) throw new StreamingSessionStoreError("invalid_state", "A pre-adoption output checkpoint must be claimed atomically with its host obligation marker.");
      const existing = outputCheckpoints.get(parsed.sessionId);
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(parsed)) throw new StreamingSessionStoreError("identity_conflict", "Output checkpoint identity conflicts.");
        return Object.freeze({ record: cloneOutputCheckpoint(existing), won: false });
      }
      if (outputCheckpoints.size >= outputCapacity) throw new StreamingSessionStoreError("capacity_exceeded", "Output checkpoint record capacity is full.");
      outputCheckpoints.set(parsed.sessionId, parsed);
      return Object.freeze({ record: cloneOutputCheckpoint(parsed), won: true });
    },
    claimHostOutputCheckpoint(command: unknown) {
      const input = commandRecord(command, "host output checkpoint claim");
      assertExactKeys(input, new Set(["record", "launchId", "ownerId", "fencingToken", "expectedRevision", "at"]), "host output checkpoint claim");
      const parsed = parseOutputCheckpointRecord(input.record); const launchId = requiredText(input.launchId, "launchId");
      const current = records.get(launchId); if (!current) throw new StreamingSessionStoreError("invalid_record", "Host launch is unknown.");
      const existing = outputCheckpoints.get(parsed.sessionId);
      if (existing || current.outputCheckpointCreatedAt) {
        if (!existing || !current.outputCheckpointCreatedAt || canonicalJson(existing) !== canonicalJson(parsed)) throw new StreamingSessionStoreError("identity_conflict", "Host output checkpoint identity conflicts.");
        return Object.freeze({ host: cloneHostLaunchRecord(current), record: cloneOutputCheckpoint(existing), won: false });
      }
      if (outputCheckpoints.size >= outputCapacity) throw new StreamingSessionStoreError("capacity_exceeded", "Output checkpoint record capacity is full.");
      const host = markHostOutputCheckpoint(current, input, parsed);
      outputCheckpoints.set(parsed.sessionId, parsed); records.set(launchId, host);
      return Object.freeze({ host: cloneHostLaunchRecord(host), record: cloneOutputCheckpoint(parsed), won: true });
    },
    bootstrapHostCleanupOutputCheckpoint(command: unknown) {
      const input = hostCleanupBootstrapCommand(command);
      const parsed = parseOutputCheckpointRecord(input.record);
      const current = records.get(requiredText(input.launchId, "launchId"));
      const existing = outputCheckpoints.get(parsed.sessionId);
      const host = bootstrapHostCleanupCheckpoint(current, input, parsed, existing, sessions.has(parsed.sessionId));
      if (existing) return Object.freeze({ host: cloneHostLaunchRecord(host), record: cloneOutputCheckpoint(existing), won: false });
      if (outputCheckpoints.size >= outputCapacity) throw new StreamingSessionStoreError("capacity_exceeded", "Output checkpoint record capacity is full.");
      outputCheckpoints.set(parsed.sessionId, parsed); records.set(host.launchId, host);
      return Object.freeze({ host: cloneHostLaunchRecord(host), record: cloneOutputCheckpoint(parsed), won: true });
    },
    applyOutputCheckpoint(command: unknown) {
      const input = commandRecord(command, "output checkpoint command");
      const sessionId = requiredText(input.sessionId, "sessionId");
      const current = outputCheckpoints.get(sessionId);
      if (!current) throw new StreamingSessionStoreError("invalid_record", "Output checkpoint is unknown.");
      const next = applyOutputCheckpointCommand(current, input);
      if (next !== current) outputCheckpoints.set(sessionId, next);
      return cloneOutputCheckpoint(next);
    },
    deleteOutputCheckpoint(command: unknown) {
      const input = commandRecord(command, "output checkpoint delete"); const sessionId = requiredText(input.sessionId, "sessionId");
      const current = outputCheckpoints.get(sessionId);
      const host = typeof input.launchId === "string" ? records.get(input.launchId) : undefined;
      const nextHost = outputDeletionDestination(current, input, sessions.get(sessionId), host);
      if (!current) return;
      if (requiredText(input.ownerId, "ownerId") !== current.ownerId || requiredPositiveInteger(input.fencingToken, "fencingToken") !== current.fencingToken) throw new StreamingSessionStoreError("stale_fence", "Output checkpoint owner/fence is stale.");
      if (requiredNonNegativeInteger(input.expectedRevision, "expectedRevision") !== current.revision) throw new StreamingSessionStoreError("revision_conflict", "Output checkpoint revision is stale.");
      if (nextHost) records.set(nextHost.launchId, nextHost);
      outputCheckpoints.delete(sessionId);
    },
    takeoverAdoptedWithOutput(command: unknown) {
      const input = adoptedTakeoverCommand(command); const sessionId = requiredText(input.sessionId, "sessionId");
      const currentOutput = outputCheckpoints.get(sessionId); if (!currentOutput) throw new StreamingSessionStoreError("invalid_record", "Output checkpoint is missing.");
      const output = refencedOutputCheckpoint(currentOutput, input);
      const session = sessionWriter.apply({ type: "takeover", sessionId, ownerId: input.ownerId, fencingToken: input.fencingToken, expectedRevision: input.expectedRevision, newOwnerId: input.newOwnerId, newFencingToken: input.newFencingToken, leaseExpiresAt: input.leaseExpiresAt, at: input.at });
      outputCheckpoints.set(sessionId, output);
      return Object.freeze({ session, output: cloneOutputCheckpoint(output) });
    },
  });
}

function createSqliteHostLaunchWriter(
  database: DatabaseSync,
  integrityKey: Uint8Array,
  sessionWriter: StreamingSessionStoreWriter,
  capacity: number,
  sessionCapacity: number,
  outputCapacity: number,
  readOnly: boolean,
  adoptionFault?: SqliteStreamingSessionStoreOptions["adoptionFault"],
  readSession?: (sessionId: string) => Readonly<StreamingSessionRecord> | undefined,
): StreamingSessionKernelWriter {
  return Object.freeze({
    ...sessionWriter,
    prepareLaunch(record: unknown) {
      if (readOnly) throw new StreamingSessionStoreError("invalid_record", "Streaming session store is read-only.");
      const parsed = parseHostLaunchRecord(record);
      if (parsed.state !== "prepared" || parsed.revision !== 0) throw new StreamingSessionStoreError("invalid_state", "New host launches must begin prepared.");
      const json = JSON.stringify(parsed);
      const integrity = createHmac("sha256", integrityKey).update(json).digest("hex");
      const result = database.prepare("INSERT OR IGNORE INTO streaming_host_launches (launch_id, record_json, integrity, revision) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM streaming_host_launches) < ?")
        .run(parsed.launchId, json, integrity, parsed.revision, capacity) as { changes?: number };
      if (result.changes === 1) return Object.freeze({ record: cloneHostLaunchRecord(parsed), won: true });
      const existing = readSqliteHostLaunch(database, integrityKey, parsed.launchId);
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(parsed)) throw new StreamingSessionStoreError("identity_conflict", "Host launch identity conflicts.");
        return Object.freeze({ record: cloneHostLaunchRecord(existing), won: false });
      }
      throw new StreamingSessionStoreError("capacity_exceeded", "Host launch capacity is full.");
    },
    transitionLaunch(command: unknown) {
      if (readOnly) throw new StreamingSessionStoreError("invalid_record", "Streaming session store is read-only.");
      const input = commandRecord(command, "host launch command");
      const launchId = requiredText(input.launchId, "launchId");
      database.exec("BEGIN IMMEDIATE");
      try {
      const current = readSqliteHostLaunch(database, integrityKey, launchId);
      if (!current) throw new StreamingSessionStoreError("invalid_record", "Host launch is unknown.");
      assertHostOutputCheckpointLink(current, readSqliteOutputCheckpoint(database, integrityKey, current.sessionId));
      const next = applyHostLaunchCommand(current, input);
      if (next === current) { database.exec("COMMIT"); return cloneHostLaunchRecord(current); }
      const checkpoint = readSqliteOutputCheckpoint(database, integrityKey, current.sessionId);
      const deleteOutput = settledHostEvidenceCheckpoint(next, checkpoint);
      const json = JSON.stringify(next);
      const integrity = createHmac("sha256", integrityKey).update(json).digest("hex");
      const result = database.prepare("UPDATE streaming_host_launches SET record_json = ?, integrity = ?, revision = ? WHERE launch_id = ? AND revision = ?")
        .run(json, integrity, next.revision, launchId, current.revision) as { changes?: number };
      if (result.changes !== 1) throw new StreamingSessionStoreError("revision_conflict", "Host launch revision is stale.");
      if (deleteOutput) database.prepare("DELETE FROM streaming_output_checkpoints WHERE session_id = ? AND revision = ?").run(current.sessionId, checkpoint!.revision);
      database.exec("COMMIT");
      return cloneHostLaunchRecord(next);
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
    commitAdoption(input: StreamingSessionAdoptionInput) {
      if (readOnly) throw new StreamingSessionStoreError("invalid_record", "Streaming session store is read-only.");
      database.exec("BEGIN IMMEDIATE");
      let committed = false;
      try {
        const session = parseStreamingSessionRecord(input.sessionRecord);
        const durableLaunch = readSqliteHostLaunch(database, integrityKey, input.launchId);
        if (durableLaunch?.state === "handed_off") {
          assertAdoptionPair(durableLaunch, session);
          const row = database.prepare("SELECT record_json FROM streaming_sessions WHERE session_id = ?").get(session.sessionId) as { record_json: string } | undefined;
          if (!row || canonicalJson(parseStreamingSessionRecord(JSON.parse(row.record_json))) !== canonicalJson(session)) throw new StreamingSessionStoreError("identity_conflict", "Handed-off adoption pair is corrupt.");
          database.exec("COMMIT"); committed = true;
          return Object.freeze({ launch: cloneHostLaunchRecord(durableLaunch), session: cloneRecord(session) });
        }
        const launch = requiredAdoptionLaunch(durableLaunch, input);
        assertAdoptionPair(launch, session);
        assertAdoptionOutput(session, readSqliteOutputCheckpoint(database, integrityKey, session.sessionId));
        const sessionJson = JSON.stringify(session);
        const sessionIntegrity = createHmac("sha256", integrityKey).update(sessionJson).digest("hex");
        adoptionFault?.("before_session_insert");
        const inserted = database.prepare("INSERT OR IGNORE INTO streaming_sessions (session_id, record_json, integrity, revision) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM streaming_sessions) < ?")
          .run(session.sessionId, sessionJson, sessionIntegrity, session.revision, sessionCapacity) as { changes?: number };
        adoptionFault?.("after_session_insert");
        if (inserted.changes !== 1) {
          const row = database.prepare("SELECT record_json FROM streaming_sessions WHERE session_id = ?").get(session.sessionId) as { record_json: string } | undefined;
          if (!row || canonicalJson(parseStreamingSessionRecord(JSON.parse(row.record_json))) !== canonicalJson(session)) throw new StreamingSessionStoreError("identity_conflict", "Session collision retained host ownership.");
        }
        const handed = handoffHostLaunch(launch, input.at);
        const launchJson = JSON.stringify(handed);
        const launchIntegrity = createHmac("sha256", integrityKey).update(launchJson).digest("hex");
        adoptionFault?.("before_launch_handoff_update");
        const updated = database.prepare("UPDATE streaming_host_launches SET record_json = ?, integrity = ?, revision = ? WHERE launch_id = ? AND revision = ?")
          .run(launchJson, launchIntegrity, handed.revision, launch.launchId, launch.revision) as { changes?: number };
        if (updated.changes !== 1) throw new StreamingSessionStoreError("revision_conflict", "Host launch adoption revision is stale.");
        adoptionFault?.("after_launch_handoff_update");
        adoptionFault?.("before_commit");
        database.exec("COMMIT");
        committed = true;
        adoptionFault?.("after_commit");
        return Object.freeze({ launch: cloneHostLaunchRecord(handed), session: cloneRecord(session) });
      } catch (error) {
        if (!committed) database.exec("ROLLBACK");
        throw error;
      }
    },
    claimOutputCheckpoint(record: unknown) {
      if (readOnly) throw new StreamingSessionStoreError("invalid_record", "Streaming session store is read-only.");
      const parsed = parseOutputCheckpointRecord(record);
      const activeHostRows = database.prepare("SELECT launch_id FROM streaming_host_launches").all() as Array<{ launch_id: string }>;
      if (activeHostRows.map((row) => readSqliteHostLaunch(database, integrityKey, row.launch_id)!).some((launch) => launch.sessionId === parsed.sessionId && launch.state !== "handed_off" && launch.state !== "released")) throw new StreamingSessionStoreError("invalid_state", "A pre-adoption output checkpoint must be claimed atomically with its host obligation marker.");
      const json = JSON.stringify(parsed);
      const integrity = createHmac("sha256", integrityKey).update(json).digest("hex");
      const result = database.prepare("INSERT OR IGNORE INTO streaming_output_checkpoints (session_id, record_json, integrity, revision) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM streaming_output_checkpoints) < ?").run(parsed.sessionId, json, integrity, parsed.revision, outputCapacity) as { changes?: number };
      if (result.changes === 1) return Object.freeze({ record: cloneOutputCheckpoint(parsed), won: true });
      const existing = readSqliteOutputCheckpoint(database, integrityKey, parsed.sessionId);
      if (!existing) throw new StreamingSessionStoreError("capacity_exceeded", "Output checkpoint record capacity is full.");
      if (canonicalJson(existing) !== canonicalJson(parsed)) throw new StreamingSessionStoreError("identity_conflict", "Output checkpoint identity conflicts.");
      return Object.freeze({ record: cloneOutputCheckpoint(existing), won: false });
    },
    claimHostOutputCheckpoint(command: unknown) {
      if (readOnly) throw new StreamingSessionStoreError("invalid_record", "Streaming session store is read-only.");
      const input = commandRecord(command, "host output checkpoint claim");
      assertExactKeys(input, new Set(["record", "launchId", "ownerId", "fencingToken", "expectedRevision", "at"]), "host output checkpoint claim");
      const parsed = parseOutputCheckpointRecord(input.record); const launchId = requiredText(input.launchId, "launchId");
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = readSqliteHostLaunch(database, integrityKey, launchId); if (!current) throw new StreamingSessionStoreError("invalid_record", "Host launch is unknown.");
        const existing = readSqliteOutputCheckpoint(database, integrityKey, parsed.sessionId);
        if (existing || current.outputCheckpointCreatedAt) {
          if (!existing || !current.outputCheckpointCreatedAt || canonicalJson(existing) !== canonicalJson(parsed)) throw new StreamingSessionStoreError("identity_conflict", "Host output checkpoint identity conflicts.");
          database.exec("COMMIT"); return Object.freeze({ host: cloneHostLaunchRecord(current), record: cloneOutputCheckpoint(existing), won: false });
        }
        const host = markHostOutputCheckpoint(current, input, parsed);
        const outputJson = JSON.stringify(parsed); const outputIntegrity = createHmac("sha256", integrityKey).update(outputJson).digest("hex");
        const inserted = database.prepare("INSERT INTO streaming_output_checkpoints (session_id, record_json, integrity, revision) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM streaming_output_checkpoints) < ?").run(parsed.sessionId, outputJson, outputIntegrity, parsed.revision, outputCapacity) as { changes?: number };
        if (inserted.changes !== 1) throw new StreamingSessionStoreError("capacity_exceeded", "Output checkpoint record capacity is full.");
        const hostJson = JSON.stringify(host); const hostIntegrity = createHmac("sha256", integrityKey).update(hostJson).digest("hex");
        const updated = database.prepare("UPDATE streaming_host_launches SET record_json = ?, integrity = ?, revision = ? WHERE launch_id = ? AND revision = ?").run(hostJson, hostIntegrity, host.revision, launchId, current.revision) as { changes?: number };
        if (updated.changes !== 1) throw new StreamingSessionStoreError("revision_conflict", "Host launch revision is stale.");
        database.exec("COMMIT"); return Object.freeze({ host: cloneHostLaunchRecord(host), record: cloneOutputCheckpoint(parsed), won: true });
      } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
    },
    bootstrapHostCleanupOutputCheckpoint(command: unknown) {
      if (readOnly) throw new StreamingSessionStoreError("invalid_record", "Streaming session store is read-only.");
      const input = hostCleanupBootstrapCommand(command);
      const parsed = parseOutputCheckpointRecord(input.record);
      const launchId = requiredText(input.launchId, "launchId");
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = readSqliteHostLaunch(database, integrityKey, launchId);
        const existing = readSqliteOutputCheckpoint(database, integrityKey, parsed.sessionId);
        const host = bootstrapHostCleanupCheckpoint(current, input, parsed, existing, Boolean(readSession?.(parsed.sessionId)));
        if (existing) { database.exec("COMMIT"); return Object.freeze({ host: cloneHostLaunchRecord(host), record: cloneOutputCheckpoint(existing), won: false }); }
        const outputJson = JSON.stringify(parsed); const outputIntegrity = createHmac("sha256", integrityKey).update(outputJson).digest("hex");
        const inserted = database.prepare("INSERT INTO streaming_output_checkpoints (session_id, record_json, integrity, revision) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM streaming_output_checkpoints) < ?").run(parsed.sessionId, outputJson, outputIntegrity, parsed.revision, outputCapacity) as { changes?: number };
        if (inserted.changes !== 1) throw new StreamingSessionStoreError("capacity_exceeded", "Output checkpoint record capacity is full.");
        const hostJson = JSON.stringify(host); const hostIntegrity = createHmac("sha256", integrityKey).update(hostJson).digest("hex");
        const updated = database.prepare("UPDATE streaming_host_launches SET record_json = ?, integrity = ?, revision = ? WHERE launch_id = ? AND revision = ?").run(hostJson, hostIntegrity, host.revision, launchId, current!.revision) as { changes?: number };
        if (updated.changes !== 1) throw new StreamingSessionStoreError("revision_conflict", "Host launch revision is stale.");
        database.exec("COMMIT"); return Object.freeze({ host: cloneHostLaunchRecord(host), record: cloneOutputCheckpoint(parsed), won: true });
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
    applyOutputCheckpoint(command: unknown) {
      if (readOnly) throw new StreamingSessionStoreError("invalid_record", "Streaming session store is read-only.");
      const input = commandRecord(command, "output checkpoint command");
      const sessionId = requiredText(input.sessionId, "sessionId");
      const current = readSqliteOutputCheckpoint(database, integrityKey, sessionId);
      if (!current) throw new StreamingSessionStoreError("invalid_record", "Output checkpoint is unknown.");
      const next = applyOutputCheckpointCommand(current, input);
      if (next === current) return cloneOutputCheckpoint(current);
      const json = JSON.stringify(next);
      const integrity = createHmac("sha256", integrityKey).update(json).digest("hex");
      const result = database.prepare("UPDATE streaming_output_checkpoints SET record_json = ?, integrity = ?, revision = ? WHERE session_id = ? AND revision = ?").run(json, integrity, next.revision, sessionId, current.revision) as { changes?: number };
      if (result.changes !== 1) throw new StreamingSessionStoreError("revision_conflict", "Output checkpoint revision is stale.");
      return cloneOutputCheckpoint(next);
    },
    deleteOutputCheckpoint(command: unknown) {
      if (readOnly) throw new StreamingSessionStoreError("invalid_record", "Streaming session store is read-only.");
      const input = commandRecord(command, "output checkpoint delete"); const sessionId = requiredText(input.sessionId, "sessionId");
      database.exec("BEGIN IMMEDIATE");
      try {
      const current = readSqliteOutputCheckpoint(database, integrityKey, sessionId);
      const session = readSession?.(sessionId);
      const host = typeof input.launchId === "string" ? readSqliteHostLaunch(database, integrityKey, input.launchId) : undefined;
      const nextHost = outputDeletionDestination(current, input, session, host);
      if (!current) { database.exec("COMMIT"); return; }
      if (requiredText(input.ownerId, "ownerId") !== current.ownerId || requiredPositiveInteger(input.fencingToken, "fencingToken") !== current.fencingToken) throw new StreamingSessionStoreError("stale_fence", "Output checkpoint owner/fence is stale.");
      const expectedRevision = requiredNonNegativeInteger(input.expectedRevision, "expectedRevision");
      if (nextHost) {
        const json = JSON.stringify(nextHost); const integrity = createHmac("sha256", integrityKey).update(json).digest("hex");
        const changed = database.prepare("UPDATE streaming_host_launches SET record_json = ?, integrity = ?, revision = ? WHERE launch_id = ? AND revision = ?").run(json, integrity, nextHost.revision, nextHost.launchId, host!.revision) as { changes?: number };
        if (changed.changes !== 1) throw new StreamingSessionStoreError("revision_conflict", "Host evidence transfer revision is stale.");
      }
      const result = database.prepare("DELETE FROM streaming_output_checkpoints WHERE session_id = ? AND revision = ?").run(sessionId, expectedRevision) as { changes?: number };
      if (result.changes !== 1) throw new StreamingSessionStoreError("revision_conflict", "Output checkpoint revision is stale.");
      database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
    takeoverAdoptedWithOutput(command: unknown) {
      if (readOnly) throw new StreamingSessionStoreError("invalid_record", "Streaming session store is read-only.");
      const input = adoptedTakeoverCommand(command); const sessionId = requiredText(input.sessionId, "sessionId");
      database.exec("BEGIN IMMEDIATE");
      try {
        const currentOutput = readSqliteOutputCheckpoint(database, integrityKey, sessionId); if (!currentOutput) throw new StreamingSessionStoreError("invalid_record", "Output checkpoint is missing.");
        const output = refencedOutputCheckpoint(currentOutput, input);
        const session = sessionWriter.apply({ type: "takeover", sessionId, ownerId: input.ownerId, fencingToken: input.fencingToken, expectedRevision: input.expectedRevision, newOwnerId: input.newOwnerId, newFencingToken: input.newFencingToken, leaseExpiresAt: input.leaseExpiresAt, at: input.at });
        const json = JSON.stringify(output); const integrity = createHmac("sha256", integrityKey).update(json).digest("hex");
        const result = database.prepare("UPDATE streaming_output_checkpoints SET record_json = ?, integrity = ?, revision = ? WHERE session_id = ? AND revision = ?").run(json, integrity, output.revision, sessionId, currentOutput.revision) as { changes?: number };
        if (result.changes !== 1) throw new StreamingSessionStoreError("revision_conflict", "Output checkpoint revision is stale.");
        database.exec("COMMIT"); return Object.freeze({ session, output: cloneOutputCheckpoint(output) });
      } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
    },
  });
}

function readSqliteHostLaunch(database: DatabaseSync, integrityKey: Uint8Array, launchId: string): Readonly<HostLaunchRecord> | undefined {
  const row = database.prepare("SELECT record_json, integrity, revision FROM streaming_host_launches WHERE launch_id = ?")
    .get(launchId) as { record_json: string; integrity: string; revision: number } | undefined;
  if (!row) return undefined;
  const actual = createHmac("sha256", integrityKey).update(row.record_json).digest();
  const expected = Buffer.from(row.integrity, "hex");
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) throw new StreamingSessionStoreError("invalid_record", "Host launch integrity failed.");
  const parsed = parseHostLaunchRecord(JSON.parse(row.record_json));
  if (parsed.revision !== row.revision) throw new StreamingSessionStoreError("invalid_record", "Host launch revision is corrupt.");
  return parsed;
}

function hostCleanupBootstrapCommand(command: unknown): Record<string, unknown> {
  const input = commandRecord(command, "host cleanup output bootstrap");
  assertExactKeys(input, new Set(["record", "launchId", "ownerId", "fencingToken", "expectedRevision", "at"]), "host cleanup output bootstrap");
  return input;
}

function bootstrapHostCleanupCheckpoint(current: Readonly<HostLaunchRecord> | undefined, input: Record<string, unknown>, checkpoint: Readonly<OutputCheckpointRecord>, existing: Readonly<OutputCheckpointRecord> | undefined, adopted: boolean): Readonly<HostLaunchRecord> {
  if (!current) throw new StreamingSessionStoreError("invalid_record", "Host launch is unknown.");
  if (requiredText(input.ownerId, "ownerId") !== current.ownerId || requiredPositiveInteger(input.fencingToken, "fencingToken") !== current.fencingToken) throw new StreamingSessionStoreError("stale_fence", "Host cleanup output owner/fence is stale.");
  if (requiredNonNegativeInteger(input.expectedRevision, "expectedRevision") !== current.revision) throw new StreamingSessionStoreError("revision_conflict", "Host cleanup output revision is stale.");
  const at = requiredTimestamp(input.at, "at");
  if (Date.parse(at) >= Date.parse(current.ownerExpiresAt)) throw new StreamingSessionStoreError("lease_expired", "Host cleanup output owner lease is expired.");
  if (current.state !== "cleanup_pending" || current.cleanupOwner !== "host_control" || !current.channelAcquisitionStartedAt || !current.backendBinding || !current.leaseBinding || adopted || current.handshakeDigest || current.effects.some((effect) => effect.kind === "handoff")) throw new StreamingSessionStoreError("invalid_state", "Output bootstrap requires exact never-adopted channel cleanup.");
  if (checkpoint.sessionId !== current.sessionId || checkpoint.ownerId !== current.ownerId || checkpoint.fencingToken !== current.fencingToken) throw new StreamingSessionStoreError("identity_conflict", "Cleanup checkpoint identity differs from its host.");
  const continuation = checkpoint.continuation;
  if (checkpoint.schemaVersion !== 2 || checkpoint.revision !== 0 || checkpoint.outcome !== "active" || checkpoint.streams.length !== 2 || checkpoint.streams.some((stream) => stream.lastConsumed || stream.consumingIntent || stream.consumed.length) ||
      !continuation || continuation.head || continuation.pages || continuation.retainedBytes || continuation.loss !== "none" || continuation.legacyHashes.length || continuation.finalized || continuation.positions.some((position) => position.last || position.lostBytes)) throw new StreamingSessionStoreError("invalid_record", "Cleanup bootstrap cannot invent prior output or evidence.");
  if (existing || current.outputCheckpointCreatedAt) {
    if (!existing || !current.outputCheckpointCreatedAt || canonicalJson(existing) !== canonicalJson(checkpoint)) throw new StreamingSessionStoreError("identity_conflict", "Cleanup bootstrap conflicts with prior checkpoint evidence.");
    return current;
  }
  if (current.effects.find((effect) => effect.kind === "cleanup")?.resources?.some((resource) =>
    (resource.resource === "host" || resource.resource === "channel") && resource.status === "succeeded")) throw new StreamingSessionStoreError("invalid_state", "Output bootstrap cannot reconstruct a retired backend or channel.");
  const marked = { ...current, outputCheckpointCreatedAt: at };
  const effects = current.effects.map((effect) => effect.kind === "cleanup" ? {
    ...effect, resources: [...(effect.resources ?? []), { resource: "output_checkpoint" as const, identity: `checkpoint:${current.sessionId}`, status: "pending" as const, ownerId: current.ownerId, fencingToken: current.fencingToken, attempts: 1 }],
  } : effect);
  return parseHostLaunchRecord({ ...marked, revision: current.revision + 1, history: [...current.history, { state: "cleanup_pending", at }], effects });
}

function markHostOutputCheckpoint(current: Readonly<HostLaunchRecord>, input: Record<string, unknown>, checkpoint: Readonly<OutputCheckpointRecord>): Readonly<HostLaunchRecord> {
  if (requiredText(input.ownerId, "ownerId") !== current.ownerId || requiredPositiveInteger(input.fencingToken, "fencingToken") !== current.fencingToken) throw new StreamingSessionStoreError("stale_fence", "Host launch owner/fence is stale.");
  if (requiredNonNegativeInteger(input.expectedRevision, "expectedRevision") !== current.revision) throw new StreamingSessionStoreError("revision_conflict", "Host launch revision is stale.");
  const at = requiredTimestamp(input.at, "at");
  if (Date.parse(at) >= Date.parse(current.ownerExpiresAt)) throw new StreamingSessionStoreError("lease_expired", "Host launch owner lease is expired.");
  if (current.state !== "bound" || !current.channelAcquisitionStartedAt || current.outputCheckpointCreatedAt) throw new StreamingSessionStoreError("invalid_state", "Host output checkpoint requires an exact channel acquisition marker.");
  if (checkpoint.sessionId !== current.sessionId) throw new StreamingSessionStoreError("identity_conflict", "Output checkpoint session differs from host launch.");
  return parseHostLaunchRecord({ ...current, revision: current.revision + 1, outputCheckpointCreatedAt: at, history: [...current.history, { state: "bound", at }] });
}

function assertHostOutputCheckpointLink(record: Readonly<HostLaunchRecord>, checkpoint: Readonly<OutputCheckpointRecord> | undefined): void {
  if (checkpoint && !record.outputCheckpointCreatedAt) throw new StreamingSessionStoreError("invalid_effect", "Output checkpoint exists without its authenticated host obligation marker.");
  if (record.outputCheckpointCreatedAt && !checkpoint && !["cleanup_pending", "cleanup_blocked", "released", "handed_off"].includes(record.state)) throw new StreamingSessionStoreError("invalid_effect", "Authenticated host output obligation is missing its checkpoint before cleanup.");
}

function applyHostLaunchCommand(current: Readonly<HostLaunchRecord>, input: Record<string, unknown>): Readonly<HostLaunchRecord> {
  assertNoForbiddenDurableValues(input);
  const extraKeys: Record<string, readonly string[]> = { bind_isolation: ["lease"], bind_cleanup_isolation: ["lease", "resources"], begin_launch: [], bind_backend: ["backendBinding"], begin_channel: [], verify_handshake: ["handshakeDigest"], begin_cleanup: ["resources"], settle_cleanup_blocked: ["blocker", "results"], settle_cleanup_cleaned: ["results"], takeover_cleanup: ["newOwnerId", "newFencingToken", "ownerExpiresAt"] };
  assertExactKeys(input, new Set(["type", "launchId", "ownerId", "fencingToken", "expectedRevision", "at", ...(extraKeys[String(input.type)] ?? [])]), "host launch command");
  const ownerId = requiredText(input.ownerId, "ownerId");
  const fence = requiredPositiveInteger(input.fencingToken, "fencingToken");
  const expectedRevision = requiredNonNegativeInteger(input.expectedRevision, "expectedRevision");
  if (ownerId !== current.ownerId || fence !== current.fencingToken) throw new StreamingSessionStoreError("stale_fence", "Host launch owner/fence is stale.");
  const at = requiredTimestamp(input.at, "at");
  if (input.type !== "takeover_cleanup" && Date.parse(at) >= Date.parse(current.ownerExpiresAt)) throw new StreamingSessionStoreError("lease_expired", "Host launch owner lease is expired.");
  let state: HostLaunchState;
  const additions: {
    leaseBinding?: HostLaunchRecord["leaseBinding"];
    backendBinding?: StreamingSessionBackendBinding;
    handshakeDigest?: string;
    ownerId?: string;
    fencingToken?: number;
    ownerExpiresAt?: string;
    cleanupOwner?: HostLaunchRecord["cleanupOwner"];
    channelAcquisitionStartedAt?: string;
    outputCheckpointCreatedAt?: string;
  } = {};
  const effects = current.effects.map((effect) => ({ ...effect }));
  if (input.type === "bind_isolation") {
    state = "isolated";
    additions.leaseBinding = parseHostLeaseBinding(input.lease);
    acknowledgeHostEffect(effects, `isolate:${current.launchId}`, at);
    ensureTransition(current.state, "prepared", input, current, additions);
  } else if (input.type === "bind_cleanup_isolation") {
    if (current.state !== "cleanup_blocked") throw new StreamingSessionStoreError("invalid_state", "Late cleanup isolation binding requires blocked ownership.");
    state = "cleanup_pending"; additions.leaseBinding = parseHostLeaseBinding(input.lease);
    acknowledgeHostEffect(effects, `isolate:${current.launchId}`, at);
    const index = effects.findIndex((effect) => effect.kind === "cleanup"); if (index < 0) throw new StreamingSessionStoreError("invalid_effect", "Exact cleanup effect is missing.");
    const effect = effects[index]!; const derived = derivedHostCleanupDefinitions({ ...current, leaseBinding: additions.leaseBinding });
    if (input.resources !== undefined && !sameCleanupDefinitions(parseHostCleanupResourceDefinitions(input.resources), derived)) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource assertion does not equal kernel-derived obligations.");
    effects[index] = { ...effect, status: "pending", ownerId, fencingToken: fence, blocker: undefined, blockedAt: undefined, resources: beginCleanupResources(effect.resources ?? [], derived, ownerId, fence) };
  } else if (input.type === "begin_launch") {
    state = "launching";
    ensureTransition(current.state, "isolated", input, current, additions);
    effects.push({ effectId: `launch:${current.launchId}`, kind: "launch", status: "pending", ownerId, fencingToken: fence, createdAt: at });
  } else if (input.type === "bind_backend") {
    state = "bound";
    additions.backendBinding = parseBackendBindingValue(input.backendBinding);
    ensureTransition(current.state, "launching", input, current, additions);
    acknowledgeHostEffect(effects, `launch:${current.launchId}`, at);
  } else if (input.type === "begin_channel") {
    if (current.state !== "bound" || current.channelAcquisitionStartedAt) throw new StreamingSessionStoreError("invalid_state", "Channel acquisition may be marked exactly once from a bound launch.");
    state = "bound"; additions.channelAcquisitionStartedAt = at;
  } else if (input.type === "verify_handshake") {
    if (!current.channelAcquisitionStartedAt || !current.outputCheckpointCreatedAt) throw new StreamingSessionStoreError("invalid_state", "Handshake verification requires exact channel and checkpoint markers.");
    state = "handshake_verified";
    additions.handshakeDigest = requiredDigest(input.handshakeDigest, "handshakeDigest");
    ensureTransition(current.state, "bound", input, current, additions);
    effects.push({ effectId: `handoff:${current.launchId}`, kind: "handoff", status: "pending", ownerId, fencingToken: fence, createdAt: at });
  } else if (input.type === "begin_cleanup") {
    if (current.state === "handed_off" || current.state === "released") throw new StreamingSessionStoreError("invalid_state", "Inert host launch cannot begin cleanup.");
    state = "cleanup_pending";
    const existing = effects.findIndex((effect) => effect.kind === "cleanup");
    const definitions = derivedHostCleanupDefinitions(current);
    if (input.resources !== undefined && !sameCleanupDefinitions(parseHostCleanupResourceDefinitions(input.resources), definitions)) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource assertion does not equal kernel-derived obligations.");
    if (existing >= 0) {
      const effect = effects[existing]!;
      effects[existing] = { ...effect, status: "pending", ownerId, fencingToken: fence, blocker: undefined, blockedAt: undefined, resources: beginCleanupResources(effect.resources ?? [], definitions, ownerId, fence) };
    } else effects.push({ effectId: `cleanup:${current.launchId}`, kind: "cleanup", status: "pending", ownerId, fencingToken: fence, originOwnerId: ownerId, originFencingToken: fence, createdAt: at, takeovers: [], resources: beginCleanupResources([], definitions, ownerId, fence) });
  } else if (input.type === "settle_cleanup_blocked") {
    if (current.state !== "cleanup_pending") throw new StreamingSessionStoreError("invalid_state", "Cleanup is not pending.");
    state = "cleanup_blocked";
    const index = effects.findIndex((effect) => effect.kind === "cleanup" && effect.status === "pending" && effect.ownerId === ownerId && effect.fencingToken === fence);
    if (index < 0) throw new StreamingSessionStoreError("invalid_effect", "Exact cleanup effect is missing.");
    const effect = effects[index]!;
    const resources = settleCleanupResources(effect.resources ?? [], input.results);
    if (resources.length && resources.every((resource) => resource.status === "succeeded")) throw new StreamingSessionStoreError("invalid_effect", "Blocked cleanup has no unresolved resource.");
    effects[index] = { ...effect, status: "blocked", blockedAt: at, blocker: parseHostCleanupFailure(input.blocker), resources };
  } else if (input.type === "settle_cleanup_cleaned") {
    if (current.state !== "cleanup_pending") throw new StreamingSessionStoreError("invalid_state", "Cleanup is not pending.");
    state = "released"; additions.ownerId = "none"; additions.cleanupOwner = "none";
    const index = effects.findIndex((effect) => effect.kind === "cleanup" && effect.status === "pending" && effect.ownerId === ownerId && effect.fencingToken === fence);
    if (index < 0) throw new StreamingSessionStoreError("invalid_effect", "Exact cleanup effect is missing.");
    const effect = effects[index]!;
    const resources = settleCleanupResources(effect.resources ?? [], input.results);
    if (resources.some((resource) => resource.status !== "succeeded")) throw new StreamingSessionStoreError("invalid_effect", "Cleanup cannot release with unresolved resources.");
    effects[index] = { ...effect, status: "acknowledged", acknowledgedAt: at, resources };
  } else if (input.type === "takeover_cleanup") {
    if (current.state === "handed_off" || current.state === "released") throw new StreamingSessionStoreError("invalid_state", "Inert host ownership cannot be taken over.");
    if (Date.parse(at) < Date.parse(current.ownerExpiresAt)) throw new StreamingSessionStoreError("lease_not_expired", "Host cleanup owner has not expired.");
    const newFence = requiredPositiveInteger(input.newFencingToken, "newFencingToken");
    if (newFence !== fence + 1) throw new StreamingSessionStoreError("stale_fence", "Host cleanup takeover fence is not consecutive.");
    const newOwnerId = requiredText(input.newOwnerId, "newOwnerId");
    state = "cleanup_pending"; additions.ownerId = newOwnerId; additions.fencingToken = newFence; additions.ownerExpiresAt = requiredTimestamp(input.ownerExpiresAt, "ownerExpiresAt");
    if (Date.parse(additions.ownerExpiresAt) <= Date.parse(at)) throw new StreamingSessionStoreError("lease_expired", "New host cleanup ownership lease is expired.");
    const index = effects.findIndex((effect) => effect.kind === "cleanup");
    if (index < 0) effects.push({ effectId: `cleanup:${current.launchId}`, kind: "cleanup", status: "pending", ownerId: newOwnerId, fencingToken: newFence, originOwnerId: ownerId, originFencingToken: fence, createdAt: at, takeovers: [{ fromOwnerId: ownerId, fromFencingToken: fence, toOwnerId: newOwnerId, toFencingToken: newFence, at }], resources: beginCleanupResources([], derivedHostCleanupDefinitions(current), newOwnerId, newFence) });
    else {
      const effect = effects[index]!;
      effects[index] = { ...effect, status: "pending", ownerId: newOwnerId, fencingToken: newFence, blocker: undefined, blockedAt: undefined, takeovers: [...(effect.takeovers ?? []), { fromOwnerId: ownerId, fromFencingToken: fence, toOwnerId: newOwnerId, toFencingToken: newFence, at }], ...(effect.resources ? { resources: effect.resources.map((resource) => resource.status === "succeeded" ? resource : { ...resource, status: "pending" as const, ownerId: newOwnerId, fencingToken: newFence, attempts: resource.attempts + 1, failure: undefined }) } : {}) };
    }
  } else {
    throw new StreamingSessionStoreError("invalid_effect", "Host launch transition is unsupported.");
  }
  if (expectedRevision !== current.revision) {
    const candidate = { ...current, ...additions, state };
    if (current.state === state && identitySubsetMatches(current, candidate)) return current;
    throw new StreamingSessionStoreError("revision_conflict", "Host launch revision is stale.");
  }
  return parseHostLaunchRecord({ ...current, ...additions, revision: current.revision + 1, state, history: [...current.history, { state, at }], effects });
}

function requiredAdoptionLaunch(
  launch: Readonly<HostLaunchRecord> | undefined,
  input: { launchId: string; ownerId: string; fencingToken: number; expectedRevision: number },
): Readonly<HostLaunchRecord> {
  if (!launch) throw new StreamingSessionStoreError("invalid_record", "Host launch is unknown.");
  if (launch.ownerId !== input.ownerId || launch.fencingToken !== input.fencingToken) throw new StreamingSessionStoreError("stale_fence", "Host launch owner/fence is stale.");
  if (launch.revision !== input.expectedRevision) throw new StreamingSessionStoreError("revision_conflict", "Host launch adoption revision is stale.");
  if (launch.state !== "handshake_verified") throw new StreamingSessionStoreError("invalid_state", "Host launch is not handshake verified.");
  return launch;
}

function assertAdoptionPair(launch: Readonly<HostLaunchRecord>, session: Readonly<StreamingSessionRecord>): void {
  assertHostSessionIdentity(launch, session);
  if (session.state !== "active" || session.cleanupOwner !== "session_authority") {
    throw new StreamingSessionStoreError("identity_conflict", "Host/session adoption identities do not match.");
  }
}

function assertHostSessionIdentity(launch: Readonly<HostLaunchRecord>, session: Readonly<StreamingSessionRecord> | undefined): void {
  if (!session || session.sessionId !== launch.sessionId || session.runId !== launch.runId || session.agentSessionId !== launch.agentSessionId || canonicalJson(session.actor) !== canonicalJson(launch.actor) || session.toolName !== launch.toolName || session.callId !== launch.callId || canonicalJson(session.backendBinding) !== canonicalJson(launch.backendBinding) || canonicalJson(session.lease) !== canonicalJson(launch.leaseBinding)) throw new StreamingSessionStoreError("identity_conflict", "Host/session adoption pair is missing or corrupt.");
}

function handoffHostLaunch(launch: Readonly<HostLaunchRecord>, atInput: unknown): Readonly<HostLaunchRecord> {
  const at = requiredTimestamp(atInput, "adoption at");
  const effects = launch.effects.map((effect) => effect.effectId === `handoff:${launch.launchId}`
    ? { ...effect, status: "acknowledged" as const, acknowledgedAt: at }
    : effect);
  return parseHostLaunchRecord({ ...launch, revision: launch.revision + 1, ownerId: "none", cleanupOwner: "none", state: "handed_off", history: [...launch.history, { state: "handed_off", at }], effects });
}

function ensureTransition(actual: HostLaunchState, expected: HostLaunchState, input: Record<string, unknown>, current: HostLaunchRecord, additions: Partial<HostLaunchRecord>): void {
  if (actual === expected) return;
  const target = input.type === "bind_isolation" ? "isolated" : input.type === "begin_launch" ? "launching" : input.type === "bind_backend" ? "bound" : "handshake_verified";
  if (actual === target && identitySubsetMatches(current, { ...current, ...additions })) return;
  throw new StreamingSessionStoreError("invalid_state", `Host launch cannot transition from ${actual}.`);
}

function acknowledgeHostEffect(effects: HostLaunchEffect[], effectId: string, at: string): void {
  const index = effects.findIndex((effect) => effect.effectId === effectId);
  if (index < 0) throw new StreamingSessionStoreError("invalid_effect", "Host launch effect is missing.");
  const effect = effects[index]!;
  effects[index] = { ...effect, status: "acknowledged", acknowledgedAt: at };
}

function parseHostLaunchEffect(value: unknown): HostLaunchEffect {
  assertExactKeys(value, new Set(["effectId", "kind", "status", "ownerId", "fencingToken", "createdAt", "acknowledgedAt", "blockedAt", "blocker", "originOwnerId", "originFencingToken", "takeovers", "resources"]), "host launch effect");
  const entry = value as Record<string, unknown>;
  for (const key of ["effectId", "ownerId"] as const) requiredText(entry[key], key);
  if (!["isolate", "launch", "handoff", "cleanup"].includes(entry.kind as string) || !["pending", "acknowledged", "blocked"].includes(entry.status as string)) throw new StreamingSessionStoreError("invalid_effect", "Host launch effect is invalid.");
  let parsed = { ...entry, fencingToken: requiredPositiveInteger(entry.fencingToken, "effect fence"), createdAt: requiredTimestamp(entry.createdAt, "effect createdAt") } as unknown as HostLaunchEffect;
  if (entry.acknowledgedAt !== undefined) requiredTimestamp(entry.acknowledgedAt, "acknowledgedAt");
  if (entry.blockedAt !== undefined) requiredTimestamp(entry.blockedAt, "blockedAt");
  if (entry.blocker !== undefined) parseHostCleanupFailure(entry.blocker);
  if (entry.kind === "cleanup") {
    let priorOwner = requiredText(entry.originOwnerId, "originOwnerId"); let priorFence = requiredPositiveInteger(entry.originFencingToken, "originFencingToken");
    if (!Array.isArray(entry.takeovers) || entry.takeovers.length > 32) throw new StreamingSessionStoreError("invalid_effect", "Cleanup takeover provenance is invalid.");
    for (const raw of entry.takeovers as unknown[]) {
      assertExactKeys(raw, new Set(["fromOwnerId", "fromFencingToken", "toOwnerId", "toFencingToken", "at"]), "host cleanup takeover");
      const takeover = raw as Record<string, unknown>; requiredText(takeover.fromOwnerId, "fromOwnerId"); requiredText(takeover.toOwnerId, "toOwnerId");
      const fromFence = requiredPositiveInteger(takeover.fromFencingToken, "fromFencingToken"); const toFence = requiredPositiveInteger(takeover.toFencingToken, "toFencingToken");
      if (takeover.fromOwnerId !== priorOwner || fromFence !== priorFence || toFence !== fromFence + 1) throw new StreamingSessionStoreError("invalid_effect", "Cleanup takeover fence is invalid."); requiredTimestamp(takeover.at, "takeover at");
      priorOwner = takeover.toOwnerId as string; priorFence = toFence;
    }
    if (priorOwner !== entry.ownerId || priorFence !== entry.fencingToken) throw new StreamingSessionStoreError("invalid_effect", "Cleanup takeover endpoint is invalid.");
    if (entry.resources !== undefined) parsed = { ...parsed, resources: parseHostCleanupResourceFacts(entry.resources, parsed) };
  } else if (entry.originOwnerId !== undefined || entry.originFencingToken !== undefined || entry.takeovers !== undefined || entry.resources !== undefined) {
    throw new StreamingSessionStoreError("invalid_effect", "Only cleanup effects carry takeover provenance.");
  }
  return Object.freeze(parsed);
}

function parseHostCleanupResourceDefinitions(value: unknown): ReadonlyArray<Readonly<{ resource: HostCleanupResourceKind; identity: string }>> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource definitions are invalid.");
  const seen = new Set<HostCleanupResourceKind>();
  return value.map((raw) => {
    assertExactKeys(raw, new Set(["resource", "identity"]), "cleanup resource definition");
    const item = raw as Record<string, unknown>;
    if (!isHostCleanupResourceKind(item.resource) || seen.has(item.resource)) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource definition is duplicate or invalid.");
    seen.add(item.resource);
    return Object.freeze({ resource: item.resource, identity: requiredText(item.identity, "cleanup resource identity") });
  });
}

function parseHostCleanupResourceFacts(value: unknown, effect: HostLaunchEffect): readonly HostCleanupResourceFact[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource facts are invalid.");
  const ownership = new Set([`${effect.originOwnerId}\0${effect.originFencingToken}`, ...(effect.takeovers ?? []).map((takeover) => `${takeover.toOwnerId}\0${takeover.toFencingToken}`)]);
  const seen = new Set<HostCleanupResourceKind>();
  return Object.freeze(value.map((raw) => {
    assertExactKeys(raw, new Set(["resource", "identity", "status", "ownerId", "fencingToken", "attempts", "failure", "evidence"]), "cleanup resource fact");
    const item = raw as Record<string, unknown>;
    if (!isHostCleanupResourceKind(item.resource) || seen.has(item.resource)) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource fact is duplicate or invalid.");
    seen.add(item.resource);
    const status = item.status;
    if (!(["pending", "succeeded", "failed"] as const).includes(status as "pending")) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource status is invalid.");
    const ownerId = requiredText(item.ownerId, "cleanup resource owner"); const fencingToken = requiredPositiveInteger(item.fencingToken, "cleanup resource fence");
    if (!ownership.has(`${ownerId}\0${fencingToken}`)) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource fact has unauthenticated ownership.");
    const failure = item.failure === undefined ? undefined : parseHostCleanupFailure(item.failure);
    const evidence = item.evidence === undefined ? undefined : parseAdoptedCleanupEvidenceReference(item.evidence);
    if (evidence && (item.resource !== "output_checkpoint" || status !== "succeeded" || evidence.kind !== "bounded_output_manifest")) throw new StreamingSessionStoreError("invalid_effect", "Only successful output cleanup may retain its manifest root.");
    if ((status === "failed") !== Boolean(failure)) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource failure evidence is invalid.");
    if (status !== "succeeded" && (ownerId !== effect.ownerId || fencingToken !== effect.fencingToken)) throw new StreamingSessionStoreError("invalid_effect", "Unresolved cleanup resource is not fenced to the current cleanup owner.");
    return Object.freeze({ resource: item.resource, identity: requiredText(item.identity, "cleanup resource identity"), status: status as HostCleanupResourceFact["status"], ownerId, fencingToken, attempts: requiredPositiveInteger(item.attempts, "cleanup resource attempts"), ...(failure ? { failure } : {}), ...(evidence ? { evidence } : {}) });
  }));
}

function parseHostCleanupFailure(value: unknown): HostCleanupFailure {
  assertExactKeys(value, new Set(["code", "message"]), "cleanup failure");
  const item = value as Record<string, unknown>; const code = item.code as HostCleanupFailureCode;
  if (!(code in HOST_CLEANUP_FAILURE_MESSAGES) || item.message !== HOST_CLEANUP_FAILURE_MESSAGES[code]) throw new StreamingSessionStoreError("invalid_effect", "Cleanup failure code/message is invalid.");
  return Object.freeze({ code, message: HOST_CLEANUP_FAILURE_MESSAGES[code] });
}

function derivedHostCleanupDefinitions(record: Pick<HostLaunchRecord, "launchId" | "sessionId" | "leaseBinding" | "backendBinding" | "channelAcquisitionStartedAt" | "outputCheckpointCreatedAt">): ReadonlyArray<Readonly<{ resource: HostCleanupResourceKind; identity: string }>> {
  const definitions: Array<Readonly<{ resource: HostCleanupResourceKind; identity: string }>> = [{ resource: "host", identity: `host:${record.launchId}` }];
  if (record.leaseBinding) definitions.push({ resource: "isolation_lease", identity: `lease:${createHash("sha256").update(JSON.stringify(record.leaseBinding)).digest("hex")}` });
  if (record.channelAcquisitionStartedAt && record.backendBinding) definitions.push({ resource: "channel", identity: `channel:${createHash("sha256").update(JSON.stringify({ sessionId: record.sessionId, binding: record.backendBinding })).digest("hex")}` });
  if (record.outputCheckpointCreatedAt) definitions.push({ resource: "output_checkpoint", identity: `checkpoint:${record.sessionId}` });
  return Object.freeze(definitions);
}

function sameCleanupDefinitions(actual: readonly Pick<HostCleanupResourceFact, "resource" | "identity">[], expected: ReadonlyArray<Readonly<{ resource: HostCleanupResourceKind; identity: string }>>): boolean {
  if (actual.length !== expected.length) return false;
  const byKind = new Map(actual.map((entry) => [entry.resource, entry.identity]));
  return byKind.size === expected.length && expected.every((entry) => byKind.get(entry.resource) === entry.identity);
}

function beginCleanupResources(existing: readonly HostCleanupResourceFact[], definitions: ReadonlyArray<Readonly<{ resource: HostCleanupResourceKind; identity: string }>>, ownerId: string, fencingToken: number): readonly HostCleanupResourceFact[] {
  const requested = new Map(definitions.map((definition) => [definition.resource, definition]));
  for (const fact of existing) {
    const definition = requested.get(fact.resource);
    if (definition && definition.identity !== fact.identity) throw new StreamingSessionStoreError("identity_conflict", "Cleanup resource identity conflicts with durable evidence.");
    requested.delete(fact.resource);
  }
  return Object.freeze([
    ...existing.map((fact) => fact.status === "succeeded" ? fact : Object.freeze({ ...fact, status: "pending" as const, ownerId, fencingToken, attempts: fact.attempts + 1, failure: undefined })),
    ...[...requested.values()].map((definition) => Object.freeze({ ...definition, status: "pending" as const, ownerId, fencingToken, attempts: 1 })),
  ]);
}

function settleCleanupResources(existing: readonly HostCleanupResourceFact[], input: unknown): readonly HostCleanupResourceFact[] {
  if (!Array.isArray(input)) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource results are required.");
  const results = new Map<HostCleanupResourceKind, Readonly<{ resource: HostCleanupResourceKind; identity: string; ownerId: string; fencingToken: number; status: "succeeded" | "failed"; failure?: HostCleanupFailure; evidence?: AdoptedCleanupEvidenceReference }>>();
  for (const raw of input) {
    assertExactKeys(raw, new Set(["resource", "identity", "ownerId", "fencingToken", "status", "failure", "evidence"]), "cleanup resource result");
    const item = raw as Record<string, unknown>;
    if (!isHostCleanupResourceKind(item.resource) || results.has(item.resource) || !["succeeded", "failed"].includes(item.status as string)) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource result is duplicate or invalid.");
    const failure = item.failure === undefined ? undefined : parseHostCleanupFailure(item.failure);
    const evidence = item.evidence === undefined ? undefined : parseAdoptedCleanupEvidenceReference(item.evidence);
    if (evidence && (item.resource !== "output_checkpoint" || item.status !== "succeeded" || evidence.kind !== "bounded_output_manifest")) throw new StreamingSessionStoreError("invalid_effect", "Host evidence transfer must accompany successful checkpoint cleanup.");
    if ((item.status === "failed") !== Boolean(failure)) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource result failure evidence is invalid.");
    results.set(item.resource, Object.freeze({ resource: item.resource, identity: requiredText(item.identity, "cleanup resource identity"), ownerId: requiredText(item.ownerId, "cleanup result owner"), fencingToken: requiredPositiveInteger(item.fencingToken, "cleanup result fence"), status: item.status, ...(failure ? { failure } : {}), ...(evidence ? { evidence } : {}) }) as Readonly<{ resource: HostCleanupResourceKind; identity: string; ownerId: string; fencingToken: number; status: "succeeded" | "failed"; failure?: HostCleanupFailure }>);
  }
  const settled = existing.map((fact) => {
    if (fact.status === "succeeded") return fact;
    const result = results.get(fact.resource);
    if (!result || result.identity !== fact.identity || result.ownerId !== fact.ownerId || result.fencingToken !== fact.fencingToken) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource result is missing, mismatched, or stale.");
    results.delete(fact.resource);
    return Object.freeze({ ...fact, status: result.status, ...(result.failure ? { failure: result.failure } : { failure: undefined }), ...(result.evidence ? { evidence: result.evidence } : {}) });
  });
  if (results.size) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource result does not own a pending resource.");
  return Object.freeze(settled);
}

function isHostCleanupResourceKind(value: unknown): value is HostCleanupResourceKind {
  return ["channel", "output_checkpoint", "host", "isolation_lease"].includes(value as string);
}

function parseHostLeaseBinding(value: unknown): HostLaunchRecord["leaseBinding"] {
  parseLease(value);
  return deepFreeze(structuredClone(value)) as StreamingSessionLease;
}

function parseBackendBindingValue(value: unknown): StreamingSessionBackendBinding {
  // Reuse the approved streaming-session parser rather than introducing a looser binding shape.
  const probe = parseStreamingSessionRecord({
    recordKind: STREAMING_SESSION_RECORD_KIND, schemaVersion: STREAMING_SESSION_RECORD_VERSION, revision: 0,
    sessionId: "binding-probe", ownerId: "binding-probe", fencingToken: 1, leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    runId: "binding-probe", agentSessionId: "binding-probe", actor: { role: "system", id: "binding-probe" },
    toolName: "binding-probe", callId: "binding-probe", envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false },
    lease: { leaseId: "binding-probe", providerId: "binding-probe", invocationId: "binding-probe", providerIdentity: "a".repeat(64), acquiredAt: "2026-01-01T00:00:00.000Z", access: [] },
    backendBinding: value, cleanupCreationAuthority: null, cleanupOwner: "tool_broker", state: "pending_transfer",
    history: [{ state: "pending_transfer", at: "2026-01-01T00:00:00.000Z" }], effects: [{ effectId: "transfer:binding-probe", kind: "transfer", status: "pending", owner: "tool_broker", fencingToken: 1, createdAt: "2026-01-01T00:00:00.000Z" }],
  });
  return probe.backendBinding;
}

function cloneHostLaunchRecord(record: Readonly<HostLaunchRecord>): Readonly<HostLaunchRecord> { return deepFreeze(structuredClone(record)); }
function identitySubsetMatches(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
function isHostLaunchState(value: unknown): value is HostLaunchState { return ["prepared", "isolated", "launching", "bound", "handshake_verified", "handed_off", "cleanup_pending", "cleanup_blocked", "released"].includes(value as string); }
function requiredPositiveInteger(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new StreamingSessionStoreError("invalid_record", `${name} is invalid.`); return value as number; }
function requiredNonNegativeInteger(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new StreamingSessionStoreError("invalid_record", `${name} is invalid.`); return value as number; }
function requiredTimestamp(value: unknown, name: string): string { const text = requiredText(value, name); if (!Number.isFinite(Date.parse(text))) throw new StreamingSessionStoreError("invalid_record", `${name} is invalid.`); return text; }
function requiredDigest(value: unknown, name: string): string { const text = requiredText(value, name); if (!/^[a-f0-9]{64}$/i.test(text)) throw new StreamingSessionStoreError("invalid_record", `${name} is invalid.`); return text.toLowerCase(); }
function positiveCapacity(value: number, name: string): number { if (!Number.isSafeInteger(value) || value < 1) throw new StreamingSessionStoreError("invalid_record", `${name} must be a positive integer.`); return value; }

function commandRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StreamingSessionStoreError("invalid_record", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function isActorRole(value: unknown): boolean {
  return value === "architect" || value === "worker" || value === "subagent" || value === "verifier" || value === "system" || value === "user" || value === "runner_internal";
}

function isValidText(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 512 && !value.includes("\0");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => JSON.stringify(key) + ":" + canonicalJson(nested));
  return "{" + entries.join(",") + "}";
}

function sameStreamingSessionIdentity(
  left: Readonly<StreamingSessionRecord>,
  right: Readonly<StreamingSessionRecord>,
): boolean {
  return canonicalJson({
    recordKind: left.recordKind,
    schemaVersion: left.schemaVersion,
    sessionId: left.sessionId,
    runId: left.runId,
    agentSessionId: left.agentSessionId,
    actor: left.actor,
    toolName: left.toolName,
    callId: left.callId,
    envelope: left.envelope,
    lease: left.lease,
    backendBinding: left.backendBinding,
  }) === canonicalJson({
    recordKind: right.recordKind,
    schemaVersion: right.schemaVersion,
    sessionId: right.sessionId,
    runId: right.runId,
    agentSessionId: right.agentSessionId,
    actor: right.actor,
    toolName: right.toolName,
    callId: right.callId,
    envelope: right.envelope,
    lease: right.lease,
    backendBinding: right.backendBinding,
  });
}
