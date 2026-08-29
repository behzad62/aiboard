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
  | "revision_conflict"
  | "stale_fence"
  | "invalid_effect";

export class StreamingSessionStoreError extends Error {
  constructor(readonly code: StreamingSessionStoreErrorCode, message: string) {
    super(message);
    this.name = "StreamingSessionStoreError";
  }
}

export const STREAMING_SESSION_RECORD_KIND = "runner.streaming-session" as const;
export const STREAMING_SESSION_RECORD_VERSION = 1 as const;

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
}

export interface StreamingSessionHistoryEntry {
  readonly state: StreamingSessionState;
  readonly at: string;
}

export interface StreamingSessionRecord {
  readonly recordKind: typeof STREAMING_SESSION_RECORD_KIND;
  readonly schemaVersion: 0 | typeof STREAMING_SESSION_RECORD_VERSION;
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
  "cleanupOwner",
  "state",
  "history",
  "effects",
]);

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
}

export interface SqliteStreamingSessionStoreOptions extends StreamingSessionStoreOptions {
  readonly readOnly?: boolean;
}

const STORE_WRITER = Symbol("streaming-session-store-writer");

export function createInMemoryStreamingSessionStore(
  options: StreamingSessionStoreOptions = {},
): StreamingSessionStoreKernel {
  const maxRecords = options.maxRecords ?? 256;
  const maxEffectsPerRecord = options.maxEffectsPerRecord ?? 32;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session maxRecords must be a positive integer.");
  }
  if (!Number.isSafeInteger(maxEffectsPerRecord) || maxEffectsPerRecord < 1) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session maxEffectsPerRecord must be a positive integer.");
  }
  const records = new Map<string, Readonly<StreamingSessionRecord>>();
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
      if (existing) return Object.freeze({ record: cloneRecord(existing), won: false });
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
    close() {},
  });
  const kernel = { store } as StreamingSessionStoreKernel;
  Object.defineProperty(kernel, STORE_WRITER, { value: writer });
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
      if (existing) return Object.freeze({ record: cloneRecord(existing), won: false });
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
    close() {
      database.close();
    },
  });
  const kernel = { store } as StreamingSessionStoreKernel;
  Object.defineProperty(kernel, STORE_WRITER, { value: writer });
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

export function parseStreamingSessionRecord(value: unknown): Readonly<StreamingSessionRecord> {
  if (!isObjectRecord(value)) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session record must be an object.");
  }
  const record = value;
  assertNoForbiddenDurableValues(record);
  assertExactKeys(record, PENDING_TRANSFER_KEYS, "streaming session record");
  assertRequiredKeys(record, PENDING_TRANSFER_KEYS, "streaming session record");
  if (record.recordKind !== STREAMING_SESSION_RECORD_KIND) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session record kind is invalid.");
  }
  if (record.schemaVersion === 0 && record.state !== "released") {
    throw new StreamingSessionStoreError(
      "unsafe_downgrade",
      "An active streaming-session record cannot be downgraded to the historical schema.",
    );
  }
  if (record.schemaVersion !== STREAMING_SESSION_RECORD_VERSION && record.schemaVersion !== 0) {
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
  const history = parseHistory(record.history);
  const effects = parseEffects(record.effects);
  assertStateCombination(record as Partial<StreamingSessionRecord>, effects);
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

function parseEffects(value: unknown): readonly StreamingSessionEffect[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new StreamingSessionStoreError("invalid_record", "Streaming session effects are invalid.");
  }
  const effectIds = new Set<string>();
  const effectKinds = new Set<string>();
  for (const entry of value) {
    const allowed = new Set([
      "effectId", "kind", "status", "owner", "fencingToken", "createdAt", "acknowledgedAt", "blockedAt",
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
    if (effectIds.has(effect.effectId as string)) {
      throw new StreamingSessionStoreError("invalid_effect", "Streaming session effect id is duplicated.");
    }
    effectIds.add(effect.effectId as string);
    effectKinds.add(effect.kind as string);
  }
  return value as readonly StreamingSessionEffect[];
}

function assertStateCombination(
  record: Partial<StreamingSessionRecord>,
  effects: readonly StreamingSessionEffect[],
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
  const requiresNoCleanup = () => {
    if (cleanup) throw new StreamingSessionStoreError("invalid_state", "Streaming session state has premature cleanup evidence.");
  };
  switch (state) {
    case "pending_transfer":
      if (record.cleanupOwner !== "tool_broker" || transfer.status !== "pending" || cleanup) {
        throw new StreamingSessionStoreError("invalid_state", "Pending transfer must retain one ToolBroker-owned transfer effect.");
      }
      return;
    case "transfer_ambiguous":
      if (record.cleanupOwner !== "provider_lease" || transfer.status === "blocked" || cleanup) {
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
      requiresNoCleanup();
      return;
    case "cleanup_pending":
      if ((record.cleanupOwner !== "provider_lease" && record.cleanupOwner !== "session_authority") ||
          !cleanup || cleanup.status !== "pending" || cleanup.owner !== record.cleanupOwner) {
        throw new StreamingSessionStoreError("invalid_state", "Cleanup pending requires exact current-owner cleanup evidence.");
      }
      requiresAcknowledgedTransfer();
      return;
    case "cleanup_blocked":
      if ((record.cleanupOwner !== "provider_lease" && record.cleanupOwner !== "session_authority") ||
          !cleanup || cleanup.status !== "blocked" || cleanup.owner !== record.cleanupOwner) {
        throw new StreamingSessionStoreError("invalid_state", "Cleanup blocked requires exact blocked cleanup evidence.");
      }
      requiresAcknowledgedTransfer();
      return;
    case "released":
      if (record.cleanupOwner !== "none" || !cleanup || cleanup.status !== "acknowledged") {
        throw new StreamingSessionStoreError("invalid_state", "Released session requires acknowledged cleanup evidence.");
      }
      requiresAcknowledgedTransfer();
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
  const currentEffects = current.effects;
  const nextRevision = (current.revision as number) + 1;
  const acknowledge = (effectId: string, kind: "transfer" | "cleanup") => {
    const effect = currentEffects.find((candidate) => candidate.effectId === effectId);
    if (!effect || effect.kind !== kind || effect.status !== "pending") {
      throw new StreamingSessionStoreError("invalid_effect", `Streaming session ${kind} effect is not pending.`);
    }
    return currentEffects.map((candidate) => candidate.effectId === effectId
      ? { ...candidate, status: "acknowledged", acknowledgedAt: at }
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
    assertTimestamp(leaseExpiresAt, "leaseExpiresAt");
    return parseStreamingSessionRecord({
      ...current,
      revision: nextRevision,
      ownerId: newOwnerId,
      fencingToken: input.newFencingToken,
      leaseExpiresAt,
    });
  }

  if (input.type === "begin_stopping") {
    if (current.state !== "active" || current.cleanupOwner !== "session_authority") {
      throw new StreamingSessionStoreError("invalid_state", "Only an adopted active streaming session can begin stopping.");
    }
    return parseStreamingSessionRecord({
      ...current,
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
      revision: nextRevision,
      state: "cleanup_pending",
      history: [...(current.history as readonly unknown[]), { state: "cleanup_pending", at }],
      effects: [...currentEffects, {
        effectId,
        kind: "cleanup",
        status: "pending",
        owner: current.cleanupOwner,
        fencingToken: current.fencingToken,
        createdAt: at,
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
      revision: nextRevision,
      state: "cleanup_blocked",
      history: [...current.history, { state: "cleanup_blocked", at }],
      effects: currentEffects.map((candidate) => candidate.effectId === effectId
        ? { ...candidate, status: "blocked", blockedAt: at }
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
      revision: nextRevision,
      state: "transfer_ambiguous",
      cleanupOwner: "provider_lease",
      history: [...(current.history as readonly unknown[]), { state: "transfer_ambiguous", at }],
    });
  }
  return parseStreamingSessionRecord({
    ...current,
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
