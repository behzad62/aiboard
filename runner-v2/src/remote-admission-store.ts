import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ToolResult } from "./agent-contracts.js";
import type { VerifiedRemoteIdentity } from "./remote-principal.js";
import type { RemoteEffectRequest, RemoteToolRuntimeOptions } from "./remote-tool-runtime.js";

export type RemoteJobState = "queued" | "running" | "completed" | "failed" | "outcome_unknown" | "blocked_policy";

export interface RemoteJob {
  protocolVersion: string;
  jobId: string;
  principal: VerifiedRemoteIdentity;
  idempotencyKey: string;
  payloadDigest: string;
  toolId: string;
  operationClass: string;
  scopeRef: string;
  state: RemoteJobState;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteJobEvent {
  protocolVersion: string;
  jobId: string;
  sequence: string;
  occurredAt: string;
  kind: "state_changed" | "reconciled";
  state: RemoteJobState;
  traceId: string;
}

export interface RemoteEventPage {
  jobId: string;
  events: RemoteJobEvent[];
  nextCursor: string;
}

export interface RemoteRequest {
  protocolVersion: string;
  requestId: string;
  accountId: string;
  clientId: string;
  deviceId: string;
  deviceEpoch: string;
  toolId: string;
  operationClass: string;
  scopeRef: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  idempotencyKey: string;
  payloadDigest: string;
  traceId: string;
  payload: unknown;
}

type AdmissionCode = "invalid_request" | "unsupported_version" | "expired_request" |
  "device_epoch_mismatch" | "idempotency_conflict" | "unauthorized";

export class RemoteAdmissionError extends Error {
  constructor(readonly code: AdmissionCode, message: string) {
    super(message);
  }
}

type JobRow = {
  job_id: string; account_id: string; client_id: string; device_id: string;
  idempotency_key: string; payload_digest: string; protocol_version: string;
  tool_id: string; operation_class: string; scope_ref: string; state: RemoteJobState;
  created_at: string; updated_at: string; trace_id: string; dispatching: number;
  last_sequence: number; request_iv: Uint8Array | null; request_tag: Uint8Array | null; request_ciphertext: Uint8Array | null;
};
type EventRow = { sequence: number; occurred_at: string; kind: RemoteJobEvent["kind"]; state: RemoteJobState; trace_id: string };

export type AdmissionDecision =
  | { created: true; job: RemoteJob; request: RemoteRequest }
  | { created: false; job: RemoteJob; request: RemoteRequest };

/**
 * Runner composition supplies a stable, secret 32-byte storage key and one database
 * shared by the device's principals. It must hold the device owner lock and exclusive
 * ownership of this database, register authenticated epochs, and reconcile before
 * accepting requests. This class neither authenticates the transport nor enables
 * effects before S1/R2.
 */
export class RemoteAdmissionStore {
  private readonly database: DatabaseSync;
  private readonly key: Buffer;
  private readonly cursorKey: Buffer;
  private reconciled = false;

  constructor(databasePath: string, storageKey: Uint8Array, private readonly clock: () => Date = () => new Date()) {
    if (!isAbsolute(databasePath)) throw new Error("Remote admission state path must be absolute.");
    if (!ArrayBuffer.isView(storageKey) || Object.prototype.toString.call(storageKey) !== "[object Uint8Array]" || storageKey.byteLength !== 32) {
      throw new Error("Remote admission requires a 32-byte storage key.");
    }
    this.key = Buffer.from(storageKey);
    this.cursorKey = createHmac("sha256", this.key).update("remote-admission-cursor-v1").digest();
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS remote_device_epochs (
        account_id TEXT NOT NULL, device_id TEXT NOT NULL, epoch TEXT NOT NULL,
        PRIMARY KEY (account_id, device_id)
      );
      CREATE TABLE IF NOT EXISTS remote_store_metadata (
        name TEXT PRIMARY KEY, value BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS remote_jobs (
        job_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, client_id TEXT NOT NULL, device_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, payload_digest TEXT NOT NULL, protocol_version TEXT NOT NULL,
        tool_id TEXT NOT NULL, operation_class TEXT NOT NULL, scope_ref TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'outcome_unknown', 'blocked_policy')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, trace_id TEXT NOT NULL,
        dispatching INTEGER NOT NULL CHECK (dispatching IN (0, 1)), last_sequence INTEGER NOT NULL CHECK (last_sequence > 0),
        request_iv BLOB, request_tag BLOB, request_ciphertext BLOB,
        CHECK ((state = 'running' AND dispatching = 1) OR (state != 'running' AND dispatching = 0)),
        CHECK ((request_iv IS NULL AND request_tag IS NULL AND request_ciphertext IS NULL) OR
               (request_iv IS NOT NULL AND request_tag IS NOT NULL AND request_ciphertext IS NOT NULL)),
        UNIQUE (account_id, client_id, device_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS remote_job_events (
        job_id TEXT NOT NULL REFERENCES remote_jobs(job_id), sequence INTEGER NOT NULL,
        occurred_at TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('state_changed', 'reconciled')),
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'outcome_unknown', 'blocked_policy')),
        trace_id TEXT NOT NULL,
        PRIMARY KEY (job_id, sequence)
      );
    `);
    try {
      this.transaction(() => {
        const check = createHmac("sha256", this.key).update("remote-admission-key-check-v1").digest();
        this.database.prepare("INSERT OR IGNORE INTO remote_store_metadata (name, value) VALUES ('key_check', ?)").run(check);
        const stored = this.database.prepare("SELECT value FROM remote_store_metadata WHERE name = 'key_check'").get() as { value: Uint8Array };
        if (stored.value.byteLength !== check.byteLength || !timingSafeEqual(stored.value, check)) throw new Error("Remote admission storage key does not match.");
      });
    } catch (error) {
      this.database.close(); this.key.fill(0); this.cursorKey.fill(0);
      throw error;
    }
  }

  /** Only the owner of an authenticated device connection may advance this fence. */
  registerAuthenticatedEpoch(identity: Pick<VerifiedRemoteIdentity, "accountId" | "deviceId">, epoch: string): void {
    checkedId(identity.accountId); checkedId(identity.deviceId); checkedEpoch(epoch);
    this.transaction(() => {
      const current = this.currentEpoch(identity);
      if (current && BigInt(epoch) < BigInt(current)) throw new RemoteAdmissionError("device_epoch_mismatch", "Device epoch is stale.");
      this.database.prepare(`INSERT INTO remote_device_epochs (account_id, device_id, epoch) VALUES (?, ?, ?)
        ON CONFLICT(account_id, device_id) DO UPDATE SET epoch = excluded.epoch`).run(identity.accountId, identity.deviceId, epoch);
    });
  }

  admit(identity: VerifiedRemoteIdentity, rawRequest: string): AdmissionDecision {
    this.requireReconciled();
    const principal = checkedPrincipal(identity);
    const request = parseRemoteRequest(rawRequest);
    if (request.accountId !== principal.accountId || request.clientId !== principal.clientId || request.deviceId !== principal.deviceId) {
      throw new RemoteAdmissionError("unauthorized", "Request principal does not match the verified principal.");
    }
    if (Date.parse(request.expiresAt) <= this.clock().getTime()) throw new RemoteAdmissionError("expired_request", "Request has expired.");
    if (request.payloadDigest !== remotePayloadDigest(request)) throw new RemoteAdmissionError("invalid_request", "Request digest is invalid.");
    return this.transaction(() => {
      this.requireEpoch(principal, request.deviceEpoch);
      const existing = this.database.prepare(`SELECT * FROM remote_jobs WHERE account_id = ? AND client_id = ?
        AND device_id = ? AND idempotency_key = ?`).get(principal.accountId, principal.clientId, principal.deviceId,
        request.idempotencyKey) as unknown as JobRow | undefined;
      if (existing) {
        if (existing.payload_digest !== request.payloadDigest) {
          throw new RemoteAdmissionError("idempotency_conflict", "Idempotency key was reused with different content.");
        }
        return { created: false, job: toJob(existing), request };
      }
      const jobId = "job-" + randomUUID();
      const now = this.clock().toISOString();
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key, iv);
      cipher.setAAD(requestAad(principal, jobId, request.payloadDigest));
      const ciphertext = Buffer.concat([cipher.update(rawRequest, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      this.database.prepare(`INSERT INTO remote_jobs (job_id, account_id, client_id, device_id,
        idempotency_key, payload_digest, protocol_version, tool_id, operation_class, scope_ref,
        state, created_at, updated_at, trace_id, dispatching, last_sequence, request_iv, request_tag, request_ciphertext)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0, 1, ?, ?, ?)`).run(
        jobId, principal.accountId, principal.clientId, principal.deviceId, request.idempotencyKey,
        request.payloadDigest, request.protocolVersion, request.toolId, request.operationClass, request.scopeRef,
        now, now, request.traceId, iv, tag, ciphertext,
      );
      this.database.prepare(`INSERT INTO remote_job_events (job_id, sequence, occurred_at, kind, state, trace_id)
        VALUES (?, 1, ?, 'state_changed', 'queued', ?)`).run(jobId, now, request.traceId);
      return { created: true, job: toJob(this.ownedRow(principal, jobId)), request };
    });
  }

  getJob(identity: VerifiedRemoteIdentity, jobId: string): RemoteJob | undefined {
    const principal = checkedPrincipal(identity);
    const row = this.findOwnedRow(principal, jobId);
    return row ? toJob(row) : undefined;
  }

  /** Decryption is principal-scoped and intended only for freshly authorized queued recovery. */
  readRequest(identity: VerifiedRemoteIdentity, jobId: string): RemoteRequest {
    const principal = checkedPrincipal(identity);
    const row = this.ownedRow(principal, jobId);
    return this.decryptRequest(principal, row);
  }

  private decryptRequest(principal: VerifiedRemoteIdentity, row: JobRow): RemoteRequest {
    if (!row.request_iv || !row.request_tag || !row.request_ciphertext) {
      throw new RemoteAdmissionError("invalid_request", "Remote request is no longer retained.");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, row.request_iv);
    decipher.setAAD(requestAad(principal, row.job_id, row.payload_digest));
    decipher.setAuthTag(row.request_tag);
    const raw = Buffer.concat([decipher.update(row.request_ciphertext), decipher.final()]).toString("utf8");
    return parseRemoteRequest(raw);
  }

  /** Commit this marker immediately before the broker call, with no intervening await. */
  markDispatching(identity: VerifiedRemoteIdentity, jobId: string, epoch: string): RemoteJob {
    this.requireReconciled();
    const principal = checkedPrincipal(identity);
    return this.transaction(() => {
      this.requireEpoch(principal, epoch);
      const row = this.ownedRow(principal, jobId);
      if (row.state !== "queued" || row.dispatching !== 0) throw new Error("Remote job cannot be dispatched from its current state.");
      const request = this.decryptRequest(principal, row);
      if (request.payloadDigest !== row.payload_digest || remotePayloadDigest(request) !== row.payload_digest) {
        throw new RemoteAdmissionError("invalid_request", "Stored request digest is invalid.");
      }
      if (request.deviceEpoch !== epoch) throw new RemoteAdmissionError("device_epoch_mismatch", "Queued request requires fresh authorization.");
      if (Date.parse(request.expiresAt) <= this.clock().getTime()) throw new RemoteAdmissionError("expired_request", "Request has expired.");
      return this.transition(row, "running", "state_changed", 1);
    });
  }

  settle(identity: VerifiedRemoteIdentity, jobId: string, state: "completed" | "failed" | "outcome_unknown"): RemoteJob {
    this.requireReconciled();
    const principal = checkedPrincipal(identity);
    return this.transaction(() => {
      const row = this.ownedRow(principal, jobId);
      if (row.state !== "running" || row.dispatching !== 1) throw new Error("Remote job has no active dispatch marker.");
      return this.transition(row, state, "state_changed", 0);
    });
  }

  blockPolicy(identity: VerifiedRemoteIdentity, jobId: string): RemoteJob {
    this.requireReconciled();
    const principal = checkedPrincipal(identity);
    return this.transaction(() => {
      const row = this.ownedRow(principal, jobId);
      if (row.state !== "queued" || row.dispatching !== 0) throw new Error("Remote job cannot be blocked from its current state.");
      return this.transition(row, "blocked_policy", "state_changed", 0);
    });
  }

  /** Call at startup under exclusive database ownership and the device owner lock, before readiness. */
  reconcileStartup(): RemoteJob[] {
    if (this.reconciled) return [];
    const jobs = this.transaction(() => {
      const rows = this.database.prepare("SELECT * FROM remote_jobs WHERE state = 'running' AND dispatching = 1").all() as unknown as JobRow[];
      return rows.map((row) => this.transition(row, "outcome_unknown", "reconciled", 0));
    });
    this.reconciled = true;
    return jobs;
  }

  events(identity: VerifiedRemoteIdentity, jobId: string, cursor?: string, limit = 100): RemoteEventPage {
    const principal = checkedPrincipal(identity);
    const job = this.ownedRow(principal, jobId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new RemoteAdmissionError("invalid_request", "Invalid event page size.");
    const after = cursor === undefined ? 0 : this.decodeCursor(principal, jobId, cursor);
    const rows = this.database.prepare(`SELECT sequence, occurred_at, kind, state, trace_id FROM remote_job_events
      WHERE job_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`).all(jobId, after, limit) as unknown as EventRow[];
    const events = rows.map((row): RemoteJobEvent => ({ protocolVersion: job.protocol_version,
      jobId, sequence: String(row.sequence), occurredAt: row.occurred_at, kind: row.kind, state: row.state, traceId: row.trace_id }));
    const next = rows.length ? rows[rows.length - 1].sequence : after;
    return { jobId, events, nextCursor: this.encodeCursor(principal, jobId, next) };
  }

  close(): void { this.database.close(); this.key.fill(0); this.cursorKey.fill(0); }

  private requireReconciled(): void {
    if (!this.reconciled) throw new Error("Remote admission startup reconciliation is required.");
  }

  private currentEpoch(identity: Pick<VerifiedRemoteIdentity, "accountId" | "deviceId">): string | undefined {
    const row = this.database.prepare("SELECT epoch FROM remote_device_epochs WHERE account_id = ? AND device_id = ?")
      .get(identity.accountId, identity.deviceId) as { epoch: string } | undefined;
    return row?.epoch;
  }

  private requireEpoch(identity: VerifiedRemoteIdentity, epoch: string): void {
    checkedEpoch(epoch);
    if (this.currentEpoch(identity) !== epoch) throw new RemoteAdmissionError("device_epoch_mismatch", "Device epoch is not current.");
  }

  private findOwnedRow(identity: VerifiedRemoteIdentity, jobId: string): JobRow | undefined {
    return this.database.prepare(`SELECT * FROM remote_jobs WHERE job_id = ? AND account_id = ? AND client_id = ? AND device_id = ?`)
      .get(jobId, identity.accountId, identity.clientId, identity.deviceId) as unknown as JobRow | undefined;
  }

  private ownedRow(identity: VerifiedRemoteIdentity, jobId: string): JobRow {
    const row = this.findOwnedRow(identity, jobId);
    if (!row) throw new RemoteAdmissionError("unauthorized", "Remote job is unavailable.");
    return row;
  }

  private transition(row: JobRow, state: RemoteJobState, kind: RemoteJobEvent["kind"], dispatching: number): RemoteJob {
    if (!Number.isSafeInteger(row.last_sequence) || row.last_sequence >= Number.MAX_SAFE_INTEGER) throw new Error("Remote job event sequence exhausted.");
    const sequence = row.last_sequence + 1;
    const now = this.clock().toISOString();
    const clearRequest = state === "completed" || state === "failed" || state === "blocked_policy";
    this.database.prepare(`UPDATE remote_jobs SET state = ?, updated_at = ?, dispatching = ?, last_sequence = ?,
      request_iv = CASE WHEN ? THEN NULL ELSE request_iv END,
      request_tag = CASE WHEN ? THEN NULL ELSE request_tag END,
      request_ciphertext = CASE WHEN ? THEN NULL ELSE request_ciphertext END WHERE job_id = ?`)
      .run(state, now, dispatching, sequence, Number(clearRequest), Number(clearRequest), Number(clearRequest), row.job_id);
    this.database.prepare("INSERT INTO remote_job_events (job_id, sequence, occurred_at, kind, state, trace_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.job_id, sequence, now, kind, state, row.trace_id);
    return toJob({ ...row, state, updated_at: now, dispatching, last_sequence: sequence });
  }

  private transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private encodeCursor(identity: VerifiedRemoteIdentity, jobId: string, sequence: number): string {
    const body = String(sequence);
    const mac = createHmac("sha256", this.cursorKey).update(JSON.stringify([identity.accountId, identity.clientId, identity.deviceId, jobId, body])).digest("base64url");
    return body + "." + mac;
  }

  private decodeCursor(identity: VerifiedRemoteIdentity, jobId: string, cursor: string): number {
    const match = /^(0|[1-9][0-9]{0,15})\.([A-Za-z0-9_-]{43})$/.exec(cursor);
    if (!match) throw new RemoteAdmissionError("invalid_request", "Invalid event cursor.");
    const sequence = Number(match[1]);
    if (!Number.isSafeInteger(sequence)) throw new RemoteAdmissionError("invalid_request", "Invalid event cursor.");
    const expected = this.encodeCursor(identity, jobId, sequence).split(".")[1];
    if (!timingSafeEqual(Buffer.from(match[2]), Buffer.from(expected))) throw new RemoteAdmissionError("invalid_request", "Invalid event cursor.");
    return sequence;
  }
}

function toJob(row: JobRow): RemoteJob {
  return { protocolVersion: row.protocol_version, jobId: row.job_id,
    principal: { accountId: row.account_id, clientId: row.client_id, deviceId: row.device_id },
    idempotencyKey: row.idempotency_key, payloadDigest: row.payload_digest, toolId: row.tool_id,
    operationClass: row.operation_class, scopeRef: row.scope_ref, state: row.state,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

function requestAad(identity: VerifiedRemoteIdentity, jobId: string, digest: string): Buffer {
  return Buffer.from(JSON.stringify([identity.accountId, identity.clientId, identity.deviceId, jobId, digest]), "utf8");
}

function checkedId(value: unknown, maxLength = 256): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || [...value].length > maxLength || value.includes("\0")) {
    throw new RemoteAdmissionError("invalid_request", "Invalid remote request identifier.");
  }
  checkUnicode(value);
}

function checkedPrincipal(value: VerifiedRemoteIdentity): VerifiedRemoteIdentity {
  if (!value || typeof value !== "object") throw new RemoteAdmissionError("unauthorized", "Invalid verified principal.");
  checkedId(value.accountId); checkedId(value.clientId); checkedId(value.deviceId);
  return { accountId: value.accountId, clientId: value.clientId, deviceId: value.deviceId };
}

function checkedEpoch(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) throw new RemoteAdmissionError("device_epoch_mismatch", "Invalid device epoch.");
}

function checkUnicode(value: string): void {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new RemoteAdmissionError("invalid_request", "JSON contains invalid Unicode.");
  }
}

/** RFC 8785: JSON primitives use ECMAScript serialization and object keys use UTF-16 order. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 128) throw new RemoteAdmissionError("invalid_request", "JSON nesting is too deep.");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RemoteAdmissionError("invalid_request", "JSON numbers must be finite.");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if ([...value].length > 1_048_576) throw new RemoteAdmissionError("invalid_request", "JSON string is too long.");
    checkUnicode(value); return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > 1024 || Object.keys(value).length !== value.length) throw new RemoteAdmissionError("invalid_request", "Invalid JSON array.");
    return "[" + value.map((entry) => canonicalJson(entry, depth + 1)).join(",") + "]";
  }
  if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length > 256 || Object.getOwnPropertySymbols(value).length > 0) throw new RemoteAdmissionError("invalid_request", "Invalid JSON object.");
    return "{" + keys.map((key) => {
      checkUnicode(key);
      if ([...key].length > 256 || !Object.getOwnPropertyDescriptor(record, key)?.enumerable ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(record, key)!, "value")) throw new RemoteAdmissionError("invalid_request", "Invalid JSON property.");
      return JSON.stringify(key) + ":" + canonicalJson(record[key], depth + 1);
    }).join(",") + "}";
  }
  throw new RemoteAdmissionError("invalid_request", "Unsupported JSON value.");
}

/** The operation fields match ADR-C and the remote-request.valid.{read,write}.json fixtures. */
export function remotePayloadDigest(request: Pick<RemoteRequest, "protocolVersion" | "deviceId" | "toolId" | "operationClass" | "scopeRef" | "payload">): string {
  return createHash("sha256").update(canonicalJson({ protocolVersion: request.protocolVersion, deviceId: request.deviceId,
    toolId: request.toolId, operationClass: request.operationClass, scopeRef: request.scopeRef, payload: request.payload }), "utf8").digest("hex");
}

/** Validate raw JSON before JSON.parse can discard duplicate object members. */
function rejectDuplicateKeys(raw: string): void {
  let position = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(raw[position] ?? "#")) position++; };
  const string = (): string => {
    if (raw[position] !== '"') throw new Error("Expected JSON string.");
    const start = position++;
    while (position < raw.length) {
      const char = raw[position++];
      if (char === "\\") { position++; continue; }
      if (char === '"') return JSON.parse(raw.slice(start, position)) as string;
    }
    throw new Error("Unterminated JSON string.");
  };
  const value = (depth: number): void => {
    if (depth > 128) throw new Error("JSON nesting too deep.");
    whitespace();
    if (raw[position] === "{") {
      position++; whitespace(); const names = new Set<string>();
      if (raw[position] === "}") { position++; return; }
      while (true) {
        whitespace(); const name = string();
        if (names.has(name)) throw new Error("Duplicate JSON key.");
        names.add(name); whitespace();
        if (raw[position++] !== ":") throw new Error("Expected JSON colon.");
        value(depth + 1); whitespace();
        if (raw[position] === "}") { position++; return; }
        if (raw[position++] !== ",") throw new Error("Expected JSON comma.");
      }
    }
    if (raw[position] === "[") {
      position++; whitespace();
      if (raw[position] === "]") { position++; return; }
      while (true) {
        value(depth + 1); whitespace();
        if (raw[position] === "]") { position++; return; }
        if (raw[position++] !== ",") throw new Error("Expected JSON comma.");
      }
    }
    if (raw[position] === '"') { string(); return; }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(raw.slice(position));
    if (!match) throw new Error("Invalid JSON value.");
    position += match[0].length;
  };
  value(0); whitespace();
  if (position !== raw.length) throw new Error("Trailing JSON data.");
}

export function parseRemoteRequest(raw: string): RemoteRequest {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 4 * 1024 * 1024) throw new RemoteAdmissionError("invalid_request", "Invalid request JSON.");
  let input: unknown;
  try { rejectDuplicateKeys(raw); input = JSON.parse(raw) as unknown; }
  catch { throw new RemoteAdmissionError("invalid_request", "Invalid request JSON or duplicate key."); }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RemoteAdmissionError("invalid_request", "Invalid request envelope.");
  const record = input as Record<string, unknown>;
  const fields = ["protocolVersion", "requestId", "accountId", "clientId", "deviceId", "deviceEpoch", "toolId", "operationClass",
    "scopeRef", "issuedAt", "expiresAt", "nonce", "idempotencyKey", "payloadDigest", "traceId", "payload"];
  if (Object.keys(record).length !== fields.length || fields.some((field) => !Object.hasOwn(record, field))) {
    throw new RemoteAdmissionError("invalid_request", "Invalid request fields.");
  }
  // R1 has no negotiated-version authority yet; other v1 releases need explicit composition support.
  if (record.protocolVersion !== "1.0.0") {
    throw new RemoteAdmissionError("unsupported_version", "Unsupported protocol version.");
  }
  for (const field of ["requestId", "accountId", "clientId", "deviceId", "toolId", "operationClass", "scopeRef", "idempotencyKey", "traceId"]) checkedId(record[field]);
  checkedId(record.nonce, 512); checkedEpoch(record.deviceEpoch);
  if (typeof record.payloadDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.payloadDigest)) throw new RemoteAdmissionError("invalid_request", "Invalid request digest.");
  for (const field of ["issuedAt", "expiresAt"]) {
    const timestamp = record[field];
    if (typeof timestamp !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/.test(timestamp) ||
      !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString().slice(0, 19) !== timestamp.slice(0, 19)) {
      throw new RemoteAdmissionError("invalid_request", "Invalid request timestamp.");
    }
  }
  if (Date.parse(record.issuedAt as string) > Date.parse(record.expiresAt as string)) throw new RemoteAdmissionError("invalid_request", "Invalid request lifetime.");
  canonicalJson(record.payload);
  return record as unknown as RemoteRequest;
}

const REMOTE_EFFECT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  files_write: "fs.write", files_patch: "fs.patch", files_move: "fs.move", files_delete: "fs.delete",
  files_search: "fs.search", process_start: "process.start", process_run: "process.run",
  process_write_stdin: "process.write_stdin", process_signal: "process.signal",
});

/** Adapter for RemoteToolRuntime; installation is deliberately left to trusted R1d composition. */
export function createRemoteAdmissionAdapter(store: RemoteAdmissionStore): NonNullable<RemoteToolRuntimeOptions["admitEffect"]> {
  return async (effect: Readonly<RemoteEffectRequest>, dispatch: () => Promise<ToolResult>): Promise<ToolResult> => {
    let parsed: RemoteRequest | undefined;
    const failure = (code: string, message: string): ToolResult => ({ callId: effect.callId, toolName: effect.toolName,
      content: parsed && code !== "effect_admission_required" ? [
        { type: "json", value: { requestId: parsed.requestId, traceId: parsed.traceId, admitted: false, status: "rejected", errorCode: code } },
        { type: "json", value: { protocolVersion: parsed.protocolVersion, code, message, requestId: parsed.requestId, traceId: parsed.traceId } },
      ] : [{ type: "text", text: message }], isError: true, error: { code, message } });
    if (effect.rawRequest === undefined) return failure("effect_admission_required", "A verified remote request is required.");
    let decision: AdmissionDecision;
    try {
      parsed = parseRemoteRequest(effect.rawRequest);
      if (REMOTE_EFFECT_NAMES[parsed.toolId] !== effect.toolName || canonicalJson(parsed.payload) !== canonicalJson(effect.arguments)) {
        throw new RemoteAdmissionError("invalid_request", "Request does not match the broker invocation.");
      }
      decision = store.admit(effect.principal.identity, effect.rawRequest);
    } catch (error) {
      if (error instanceof RemoteAdmissionError) return failure(error.code, error.message);
      throw error;
    }
    const response = (job: RemoteJob) => ({ requestId: decision.request.requestId, traceId: decision.request.traceId,
      admitted: true as const, jobId: job.jobId, status: job.state });
    const jobResult = (job: RemoteJob): ToolResult => ({ callId: effect.callId, toolName: effect.toolName,
      content: [{ type: "json", value: response(job) }], isError: ["outcome_unknown", "failed", "blocked_policy"].includes(job.state),
      ...(job.state === "outcome_unknown" ? { error: { code: "outcome_unknown", message: "The effect outcome is unknown." } } : {}) });
    if (!decision.created) return jobResult(decision.job);
    const denied = effect.authorize();
    if (denied) {
      const job = denied.error?.code === "tool_cancelled" ? decision.job : store.blockPolicy(effect.principal.identity, decision.job.jobId);
      return { ...denied, content: [{ type: "json", value: response(job) }, ...denied.content] };
    }
    try { store.markDispatching(effect.principal.identity, decision.job.jobId, decision.request.deviceEpoch); }
    catch (error) {
      if (error instanceof RemoteAdmissionError) return failure(error.code, error.message);
      throw error;
    }
    let result: ToolResult;
    try { result = await dispatch(); }
    catch {
      return jobResult(store.settle(effect.principal.identity, decision.job.jobId, "outcome_unknown"));
    }
    const unknown = ["tool_timeout", "tool_cancelled", "process_timeout", "process_cancelled", "reconciliation_required",
      "process_input_outcome_unknown", "process_input_interrupted"].includes(result.error?.code ?? "") ||
      (effect.toolName === "process.write_stdin" && result.content.some((block) => block.type === "json" &&
        !!block.value && typeof block.value === "object" && "status" in block.value && block.value.status === "outcome_unknown"));
    const job = store.settle(effect.principal.identity, decision.job.jobId, unknown ? "outcome_unknown" : result.isError ? "failed" : "completed");
    if (unknown) return jobResult(job);
    return { ...result, content: [{ type: "json", value: response(job) }, ...result.content] };
  };
}
