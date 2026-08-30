import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
export const STREAMING_SESSION_RECORD_VERSION = 3 as const;

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
}

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
  readonly schemaVersion: 0 | 1 | 2 | typeof STREAMING_SESSION_RECORD_VERSION;
  readonly revision: number;
  readonly sessionId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: string;
  readonly runId: string;
  readonly agentSessionId: string;
  readonly actor: Readonly<{ role: "architect" | "worker" | "system" | "user"; id: string }>;
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
export const HOST_LAUNCH_RECORD_VERSION = 1 as const;
export type HostLaunchState = "prepared" | "isolated" | "launching" | "bound" |
  "handshake_verified" | "handed_off" | "cleanup_pending" | "cleanup_blocked" | "released";
export type HostCleanupResourceKind = "channel" | "output_checkpoint" | "host" | "isolation_lease";
export interface HostCleanupResourceFact {
  readonly resource: HostCleanupResourceKind;
  readonly identity: string;
  readonly status: "pending" | "succeeded" | "failed";
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly attempts: number;
  readonly failure?: string;
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
  readonly blocker?: string;
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
  readonly actor: Readonly<{ role: "architect" | "worker" | "system" | "user"; id: string }>;
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
  readonly history: readonly Readonly<{ state: HostLaunchState; at: string }>[];
  readonly effects: readonly HostLaunchEffect[];
}

export interface StreamingSessionKernelWriter extends StreamingSessionStoreWriter {
  prepareLaunch(record: unknown): Readonly<{ record: Readonly<HostLaunchRecord>; won: boolean }>;
  transitionLaunch(command: unknown): Readonly<HostLaunchRecord>;
  commitAdoption(input: StreamingSessionAdoptionInput): Readonly<{ launch: Readonly<HostLaunchRecord>; session: Readonly<StreamingSessionRecord> }>;
  claimOutputCheckpoint(record: unknown): Readonly<{ record: Readonly<OutputCheckpointRecord>; won: boolean }>;
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
  readonly schemaVersion: typeof OUTPUT_CHECKPOINT_RECORD_VERSION;
  readonly revision: number; readonly sessionId: string; readonly ownerId: string; readonly fencingToken: number;
  readonly capacity: number; readonly outcome: "active" | "outcome_unknown";
  readonly streams: readonly OutputStreamCheckpoint[];
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
      const next = applyStreamingSessionCommand(current, input, maxEffectsPerRecord);
      records.set(sessionId, next);
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
      const current = read(sessionId);
      if (!current) throw new StreamingSessionStoreError("invalid_record", "Streaming session is unknown.");
      const next = applyStreamingSessionCommand(current, input, maxEffectsPerRecord);
      const recordJson = JSON.stringify(next);
      const integrity = createHmac("sha256", integrityKey).update(recordJson).digest("hex");
      const result = database.prepare(
        "UPDATE streaming_sessions SET record_json = ?, integrity = ?, revision = ? WHERE session_id = ? AND revision = ?",
      ).run(recordJson, integrity, next.revision, sessionId, current.revision) as { changes?: number };
      if (result.changes !== 1) {
        throw new StreamingSessionStoreError("revision_conflict", "Streaming session revision is stale.");
      }
      return cloneRecord(next);
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
      return record;
    },
    listHostLaunchIds() {
      return Object.freeze((database.prepare(
        "SELECT launch_id FROM streaming_host_launches ORDER BY launch_id",
      ).all() as Array<{ launch_id: string }>).map((row) => row.launch_id));
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
    value: createSqliteHostLaunchWriter(database, integrityKey, writer, maxHostLaunchRecords, maxRecords, maxOutputCheckpointRecords, readOnly, options.adoptionFault),
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
      record.schemaVersion !== 2 && record.schemaVersion !== 1 && record.schemaVersion !== 0) {
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
  const cleanupCreationAuthority = record.schemaVersion === STREAMING_SESSION_RECORD_VERSION
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
    "attestationDigest", "opaqueIdentity", "birthFingerprint", "rootPid", "startedAt",
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
  for (const field of ["registryId", "backendId", "implementationGeneration", "opaqueIdentity"] as const) {
    requiredText(binding[field], `backendBinding.${field}`);
  }
  for (const field of ["implementationDigest", "attestationDigest"] as const) {
    if (typeof binding[field] !== "string" || !/^[a-f0-9]{64}$/i.test(binding[field])) {
      throw new StreamingSessionStoreError("invalid_record", `Streaming session backend ${field} is invalid.`);
    }
  }
  if (!Number.isSafeInteger(binding.attestationVersion) || (binding.attestationVersion as number) < 1) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session backend attestation version is invalid.");
  }
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
      "cleanupProvenance",
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
    cleanup_blocked: [],
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

/**
 * Applies a single fenced state transition. Both storage backends call this
 * exact reducer so durability cannot change the authority state machine.
 */
function applyStreamingSessionCommand(
  current: Readonly<StreamingSessionRecord>,
  input: Record<string, unknown>,
  maxEffectsPerRecord: number,
): Readonly<StreamingSessionRecord> {
  if (![
    "acknowledge_transfer",
    "mark_transfer_ambiguous",
    "acknowledge_ambiguous_transfer",
    "begin_cleanup",
    "mark_cleanup_blocked",
    "mark_disposition",
    "begin_stopping",
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
    ].includes(current.state)) {
      throw new StreamingSessionStoreError("invalid_state", "Only an adopted streaming session can be taken over.");
    }
    if (atTimestamp < ownershipLeaseExpiresAt) {
      throw new StreamingSessionStoreError("lease_not_expired", "Streaming session ownership lease has not expired.");
    }
  } else if ((hasSessionAuthorityLease || input.type === "acknowledge_transfer") &&
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
    if (current.state === "cleanup_pending") {
      if (!cleanup || cleanup.status !== "pending" || cleanup.owner !== "session_authority" ||
          (input.newFencingToken as number) !== (current.fencingToken as number) + 1) {
        throw new StreamingSessionStoreError("stale_fence", "Streaming session cleanup takeover fence is invalid.");
      }
    }
    const effects = current.state === "cleanup_pending" && cleanup
      ? currentEffects.map((effect) => effect.effectId === cleanup.effectId
        ? {
          ...effect,
          fencingToken: input.newFencingToken as number,
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
      }],
    });
  }
  if (input.type === "acknowledge_cleanup") {
    if (current.state !== "cleanup_pending") {
      throw new StreamingSessionStoreError("invalid_state", "Only pending cleanup can be acknowledged.");
    }
    const effectId = requiredText(input.effectId, "effectId");
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

const HOST_LAUNCH_REQUIRED_KEYS = new Set([
  "recordKind", "schemaVersion", "revision", "launchId", "sessionId", "runId", "agentSessionId",
  "actor", "toolName", "callId", "ownerId", "fencingToken", "ownerExpiresAt", "state", "cleanupOwner", "history", "effects",
]);
const HOST_LAUNCH_ALLOWED_KEYS = new Set([
  ...HOST_LAUNCH_REQUIRED_KEYS, "leaseBinding", "backendBinding", "handshakeDigest",
]);

export function parseHostLaunchRecord(value: unknown): Readonly<HostLaunchRecord> {
  if (!isObjectRecord(value)) throw new StreamingSessionStoreError("invalid_record", "Host launch record must be an object.");
  assertNoForbiddenDurableValues(value);
  assertExactKeys(value, HOST_LAUNCH_ALLOWED_KEYS, "host launch record");
  assertRequiredKeys(value, HOST_LAUNCH_REQUIRED_KEYS, "host launch record");
  if (value.recordKind !== HOST_LAUNCH_RECORD_KIND || value.schemaVersion !== HOST_LAUNCH_RECORD_VERSION) {
    throw new StreamingSessionStoreError(
      value.state === "released" ? "unsupported_version" : "unsupported_active_version",
      "Host launch record version is unsupported.",
    );
  }
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
  if ((value.state === "isolated" || value.state === "launching" || value.state === "bound" || value.state === "handshake_verified" || value.state === "handed_off") && !leaseBinding) {
    throw new StreamingSessionStoreError("invalid_state", "Host launch lease binding is required.");
  }
  if ((value.state === "bound" || value.state === "handshake_verified" || value.state === "handed_off") && !backendBinding) {
    throw new StreamingSessionStoreError("invalid_state", "Host launch backend binding is required.");
  }
  if ((value.state === "handshake_verified" || value.state === "handed_off") && !handshakeDigest) {
    throw new StreamingSessionStoreError("invalid_state", "Host launch handshake digest is required.");
  }
  const parsed = deepFreeze(structuredClone({ ...value, revision, fencingToken, ownerExpiresAt, history, effects, ...(leaseBinding ? { leaseBinding } : {}), ...(backendBinding ? { backendBinding } : {}), ...(handshakeDigest ? { handshakeDigest } : {}) })) as unknown as Readonly<HostLaunchRecord>;
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
  for (let index = 1; index < record.history.length; index++) {
    const prior = record.history[index - 1]!; const entry = record.history[index]!;
    const takeoverIndex = prior.state === "cleanup_pending" && entry.state === "cleanup_pending" ? pendingTakeovers.findIndex((takeover) => takeover.at === entry.at) : -1;
    if ((takeoverIndex < 0 && !(allowed.get(prior.state) ?? []).includes(entry.state)) || Date.parse(entry.at) < Date.parse(prior.at)) throw new StreamingSessionStoreError("invalid_state", "Host launch history transition is impossible.");
    if (takeoverIndex >= 0) pendingTakeovers.splice(takeoverIndex, 1);
  }
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
  assertExactKeys(value, keys, "output checkpoint"); assertRequiredKeys(value, keys, "output checkpoint");
  if (value.recordKind !== OUTPUT_CHECKPOINT_RECORD_KIND || value.schemaVersion !== OUTPUT_CHECKPOINT_RECORD_VERSION) throw new StreamingSessionStoreError("unsupported_active_version", "Output checkpoint version is unsupported.");
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
  return deepFreeze({ recordKind: OUTPUT_CHECKPOINT_RECORD_KIND, schemaVersion: OUTPUT_CHECKPOINT_RECORD_VERSION, revision, sessionId, ownerId, fencingToken, capacity, outcome: value.outcome, streams } as OutputCheckpointRecord);
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
  assertExactKeys(input, new Set(["type", "sessionId", "ownerId", "fencingToken", "expectedRevision", "metadata", "at"]), "output checkpoint command");
  if (requiredText(input.ownerId, "ownerId") !== current.ownerId || requiredPositiveInteger(input.fencingToken, "fencingToken") !== current.fencingToken) throw new StreamingSessionStoreError("stale_fence", "Output checkpoint owner/fence is stale.");
  const expectedRevision = requiredNonNegativeInteger(input.expectedRevision, "expectedRevision");
  if (current.outcome !== "active") {
    if (input.type === "mark_outcome_unknown" && expectedRevision === current.revision) return current;
    throw new StreamingSessionStoreError("invalid_state", "Output checkpoint is terminal outcome_unknown.");
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
    if (stream.consumingIntent || canonicalJson(stream.accepted[0]) !== canonicalJson(metadata)) throw new StreamingSessionStoreError("invalid_effect", "Output consuming intent is invalid.");
    nextStream = { ...stream, consumingIntent: metadata };
  } else if (input.type === "commit_consumed") {
    if (canonicalJson(stream.consumingIntent) !== canonicalJson(metadata) || canonicalJson(stream.accepted[0]) !== canonicalJson(metadata)) throw new StreamingSessionStoreError("invalid_effect", "Output consumed commit is invalid.");
    nextStream = { ...stream, lastConsumed: metadata, consumed: [...stream.consumed, metadata].slice(-current.capacity), accepted: stream.accepted.slice(1), consumingIntent: null };
  } else if (input.type === "cancel_consume") {
    if (canonicalJson(stream.consumingIntent) !== canonicalJson(metadata) || canonicalJson(stream.accepted[0]) !== canonicalJson(metadata)) throw new StreamingSessionStoreError("invalid_effect", "Output consuming intent cancellation is invalid.");
    nextStream = { ...stream, consumingIntent: null };
  } else if (input.type === "commit_evidence_consumed") {
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
      const next = applyHostLaunchCommand(current, input);
      if (next !== current) records.set(launchId, next);
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
      const existing = outputCheckpoints.get(parsed.sessionId);
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(parsed)) throw new StreamingSessionStoreError("identity_conflict", "Output checkpoint identity conflicts.");
        return Object.freeze({ record: cloneOutputCheckpoint(existing), won: false });
      }
      if (outputCheckpoints.size >= outputCapacity) throw new StreamingSessionStoreError("capacity_exceeded", "Output checkpoint record capacity is full.");
      outputCheckpoints.set(parsed.sessionId, parsed);
      return Object.freeze({ record: cloneOutputCheckpoint(parsed), won: true });
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
      const current = outputCheckpoints.get(sessionId); if (!current) return;
      if (requiredText(input.ownerId, "ownerId") !== current.ownerId || requiredPositiveInteger(input.fencingToken, "fencingToken") !== current.fencingToken) throw new StreamingSessionStoreError("stale_fence", "Output checkpoint owner/fence is stale.");
      if (requiredNonNegativeInteger(input.expectedRevision, "expectedRevision") !== current.revision) throw new StreamingSessionStoreError("revision_conflict", "Output checkpoint revision is stale.");
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
      const current = readSqliteHostLaunch(database, integrityKey, launchId);
      if (!current) throw new StreamingSessionStoreError("invalid_record", "Host launch is unknown.");
      const next = applyHostLaunchCommand(current, input);
      if (next === current) return cloneHostLaunchRecord(current);
      const json = JSON.stringify(next);
      const integrity = createHmac("sha256", integrityKey).update(json).digest("hex");
      const result = database.prepare("UPDATE streaming_host_launches SET record_json = ?, integrity = ?, revision = ? WHERE launch_id = ? AND revision = ?")
        .run(json, integrity, next.revision, launchId, current.revision) as { changes?: number };
      if (result.changes !== 1) throw new StreamingSessionStoreError("revision_conflict", "Host launch revision is stale.");
      return cloneHostLaunchRecord(next);
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
      const json = JSON.stringify(parsed);
      const integrity = createHmac("sha256", integrityKey).update(json).digest("hex");
      const result = database.prepare("INSERT OR IGNORE INTO streaming_output_checkpoints (session_id, record_json, integrity, revision) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM streaming_output_checkpoints) < ?").run(parsed.sessionId, json, integrity, parsed.revision, outputCapacity) as { changes?: number };
      if (result.changes === 1) return Object.freeze({ record: cloneOutputCheckpoint(parsed), won: true });
      const existing = readSqliteOutputCheckpoint(database, integrityKey, parsed.sessionId);
      if (!existing) throw new StreamingSessionStoreError("capacity_exceeded", "Output checkpoint record capacity is full.");
      if (canonicalJson(existing) !== canonicalJson(parsed)) throw new StreamingSessionStoreError("identity_conflict", "Output checkpoint identity conflicts.");
      return Object.freeze({ record: cloneOutputCheckpoint(existing), won: false });
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
      const current = readSqliteOutputCheckpoint(database, integrityKey, sessionId); if (!current) return;
      if (requiredText(input.ownerId, "ownerId") !== current.ownerId || requiredPositiveInteger(input.fencingToken, "fencingToken") !== current.fencingToken) throw new StreamingSessionStoreError("stale_fence", "Output checkpoint owner/fence is stale.");
      const expectedRevision = requiredNonNegativeInteger(input.expectedRevision, "expectedRevision");
      const result = database.prepare("DELETE FROM streaming_output_checkpoints WHERE session_id = ? AND revision = ?").run(sessionId, expectedRevision) as { changes?: number };
      if (result.changes !== 1) throw new StreamingSessionStoreError("revision_conflict", "Output checkpoint revision is stale.");
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

function applyHostLaunchCommand(current: Readonly<HostLaunchRecord>, input: Record<string, unknown>): Readonly<HostLaunchRecord> {
  assertNoForbiddenDurableValues(input);
  const extraKeys: Record<string, readonly string[]> = { bind_isolation: ["lease"], bind_cleanup_isolation: ["lease", "resources"], begin_launch: [], bind_backend: ["backendBinding"], verify_handshake: ["handshakeDigest"], begin_cleanup: ["resources"], settle_cleanup_blocked: ["blocker", "results"], settle_cleanup_cleaned: ["results"], takeover_cleanup: ["newOwnerId", "newFencingToken", "ownerExpiresAt"] };
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
    const effect = effects[index]!; const definitions = parseHostCleanupResourceDefinitions(input.resources);
    effects[index] = { ...effect, status: "pending", ownerId, fencingToken: fence, blocker: undefined, blockedAt: undefined, resources: beginCleanupResources(effect.resources ?? [], definitions, ownerId, fence) };
  } else if (input.type === "begin_launch") {
    state = "launching";
    ensureTransition(current.state, "isolated", input, current, additions);
    effects.push({ effectId: `launch:${current.launchId}`, kind: "launch", status: "pending", ownerId, fencingToken: fence, createdAt: at });
  } else if (input.type === "bind_backend") {
    state = "bound";
    additions.backendBinding = parseBackendBindingValue(input.backendBinding);
    ensureTransition(current.state, "launching", input, current, additions);
    acknowledgeHostEffect(effects, `launch:${current.launchId}`, at);
  } else if (input.type === "verify_handshake") {
    state = "handshake_verified";
    additions.handshakeDigest = requiredDigest(input.handshakeDigest, "handshakeDigest");
    ensureTransition(current.state, "bound", input, current, additions);
    effects.push({ effectId: `handoff:${current.launchId}`, kind: "handoff", status: "pending", ownerId, fencingToken: fence, createdAt: at });
  } else if (input.type === "begin_cleanup") {
    if (current.state === "handed_off" || current.state === "released") throw new StreamingSessionStoreError("invalid_state", "Inert host launch cannot begin cleanup.");
    state = "cleanup_pending";
    const existing = effects.findIndex((effect) => effect.kind === "cleanup");
    const definitions = input.resources === undefined ? [] : parseHostCleanupResourceDefinitions(input.resources);
    if (existing >= 0) {
      const effect = effects[existing]!;
      effects[existing] = { ...effect, status: "pending", ownerId, fencingToken: fence, blocker: undefined, blockedAt: undefined, resources: beginCleanupResources(effect.resources ?? [], definitions, ownerId, fence) };
    } else effects.push({ effectId: `cleanup:${current.launchId}`, kind: "cleanup", status: "pending", ownerId, fencingToken: fence, originOwnerId: ownerId, originFencingToken: fence, createdAt: at, takeovers: [], ...(definitions.length ? { resources: beginCleanupResources([], definitions, ownerId, fence) } : {}) });
  } else if (input.type === "settle_cleanup_blocked") {
    if (current.state !== "cleanup_pending") throw new StreamingSessionStoreError("invalid_state", "Cleanup is not pending.");
    state = "cleanup_blocked";
    const index = effects.findIndex((effect) => effect.kind === "cleanup" && effect.status === "pending" && effect.ownerId === ownerId && effect.fencingToken === fence);
    if (index < 0) throw new StreamingSessionStoreError("invalid_effect", "Exact cleanup effect is missing.");
    const effect = effects[index]!;
    const resources = settleCleanupResources(effect.resources ?? [], input.results);
    if (resources.length && resources.every((resource) => resource.status === "succeeded")) throw new StreamingSessionStoreError("invalid_effect", "Blocked cleanup has no unresolved resource.");
    effects[index] = { ...effect, status: "blocked", blockedAt: at, blocker: requiredText(input.blocker, "cleanup blocker"), ...(resources.length ? { resources } : {}) };
  } else if (input.type === "settle_cleanup_cleaned") {
    if (current.state !== "cleanup_pending") throw new StreamingSessionStoreError("invalid_state", "Cleanup is not pending.");
    state = "released"; additions.ownerId = "none"; additions.cleanupOwner = "none";
    const index = effects.findIndex((effect) => effect.kind === "cleanup" && effect.status === "pending" && effect.ownerId === ownerId && effect.fencingToken === fence);
    if (index < 0) throw new StreamingSessionStoreError("invalid_effect", "Exact cleanup effect is missing.");
    const effect = effects[index]!;
    const resources = settleCleanupResources(effect.resources ?? [], input.results);
    if (resources.some((resource) => resource.status !== "succeeded")) throw new StreamingSessionStoreError("invalid_effect", "Cleanup cannot release with unresolved resources.");
    effects[index] = { ...effect, status: "acknowledged", acknowledgedAt: at, ...(resources.length ? { resources } : {}) };
  } else if (input.type === "takeover_cleanup") {
    if (current.state === "handed_off" || current.state === "released") throw new StreamingSessionStoreError("invalid_state", "Inert host ownership cannot be taken over.");
    if (Date.parse(at) < Date.parse(current.ownerExpiresAt)) throw new StreamingSessionStoreError("lease_not_expired", "Host cleanup owner has not expired.");
    const newFence = requiredPositiveInteger(input.newFencingToken, "newFencingToken");
    if (newFence !== fence + 1) throw new StreamingSessionStoreError("stale_fence", "Host cleanup takeover fence is not consecutive.");
    const newOwnerId = requiredText(input.newOwnerId, "newOwnerId");
    state = "cleanup_pending"; additions.ownerId = newOwnerId; additions.fencingToken = newFence; additions.ownerExpiresAt = requiredTimestamp(input.ownerExpiresAt, "ownerExpiresAt");
    if (Date.parse(additions.ownerExpiresAt) <= Date.parse(at)) throw new StreamingSessionStoreError("lease_expired", "New host cleanup ownership lease is expired.");
    const index = effects.findIndex((effect) => effect.kind === "cleanup");
    if (index < 0) effects.push({ effectId: `cleanup:${current.launchId}`, kind: "cleanup", status: "pending", ownerId: newOwnerId, fencingToken: newFence, originOwnerId: ownerId, originFencingToken: fence, createdAt: at, takeovers: [{ fromOwnerId: ownerId, fromFencingToken: fence, toOwnerId: newOwnerId, toFencingToken: newFence, at }] });
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
  if (entry.blocker !== undefined) requiredText(entry.blocker, "blocker");
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
    assertExactKeys(raw, new Set(["resource", "identity", "status", "ownerId", "fencingToken", "attempts", "failure"]), "cleanup resource fact");
    const item = raw as Record<string, unknown>;
    if (!isHostCleanupResourceKind(item.resource) || seen.has(item.resource)) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource fact is duplicate or invalid.");
    seen.add(item.resource);
    const status = item.status;
    if (!(["pending", "succeeded", "failed"] as const).includes(status as "pending")) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource status is invalid.");
    const ownerId = requiredText(item.ownerId, "cleanup resource owner"); const fencingToken = requiredPositiveInteger(item.fencingToken, "cleanup resource fence");
    if (!ownership.has(`${ownerId}\0${fencingToken}`)) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource fact has unauthenticated ownership.");
    const failure = item.failure === undefined ? undefined : requiredText(item.failure, "cleanup resource failure");
    if ((status === "failed") !== Boolean(failure)) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource failure evidence is invalid.");
    return Object.freeze({ resource: item.resource, identity: requiredText(item.identity, "cleanup resource identity"), status: status as HostCleanupResourceFact["status"], ownerId, fencingToken, attempts: requiredPositiveInteger(item.attempts, "cleanup resource attempts"), ...(failure ? { failure } : {}) });
  }));
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
  if (!existing.length) {
    if (input !== undefined && (!Array.isArray(input) || input.length)) throw new StreamingSessionStoreError("invalid_effect", "Legacy cleanup cannot accept resource results.");
    return existing;
  }
  if (!Array.isArray(input)) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource results are required.");
  const results = new Map<HostCleanupResourceKind, Readonly<{ resource: HostCleanupResourceKind; identity: string; status: "succeeded" | "failed"; failure?: string }>>();
  for (const raw of input) {
    assertExactKeys(raw, new Set(["resource", "identity", "status", "failure"]), "cleanup resource result");
    const item = raw as Record<string, unknown>;
    if (!isHostCleanupResourceKind(item.resource) || results.has(item.resource) || !["succeeded", "failed"].includes(item.status as string)) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource result is duplicate or invalid.");
    const failure = item.failure === undefined ? undefined : requiredText(item.failure, "cleanup resource failure");
    if ((item.status === "failed") !== Boolean(failure)) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource result failure evidence is invalid.");
    results.set(item.resource, Object.freeze({ resource: item.resource, identity: requiredText(item.identity, "cleanup resource identity"), status: item.status, ...(failure ? { failure } : {}) }) as Readonly<{ resource: HostCleanupResourceKind; identity: string; status: "succeeded" | "failed"; failure?: string }>);
  }
  const settled = existing.map((fact) => {
    if (fact.status === "succeeded") return fact;
    const result = results.get(fact.resource);
    if (!result || result.identity !== fact.identity) throw new StreamingSessionStoreError("invalid_effect", "Cleanup resource result is missing or mismatched.");
    results.delete(fact.resource);
    return Object.freeze({ ...fact, status: result.status, ...(result.failure ? { failure: result.failure } : { failure: undefined }) });
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
  return value === "architect" || value === "worker" || value === "system" || value === "user";
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
