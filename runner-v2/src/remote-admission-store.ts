import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ToolResult } from "./agent-contracts.js";
import { initializeRemoteAdmissionSchema } from "./remote-admission-schema.js";
import type { VerifiedRemoteIdentity } from "./remote-principal.js";
import type { RemoteEffectRequest, RemoteToolRuntimeOptions } from "./remote-tool-runtime.js";

export type RemoteJobState = "queued" | "awaiting_approval" | "running" | "completed" | "failed" |
  "cancelled" | "outcome_unknown" | "blocked_policy" | "blocked_quota";

export type RemoteTerminalState = Extract<RemoteJobState, "completed" | "failed" | "cancelled" | "outcome_unknown" | "blocked_policy" | "blocked_quota">;
export interface RemoteCancellation {
  requestedAt: string;
  stop: "pending" | "stopped" | "unverified" | "not_applicable";
  effect: "pending" | "no_effect" | "known" | "effect_outcome_unknown";
}

export interface RemoteCancelReceipt {
  jobId: string;
  cancelRequestId: string;
  traceId: string;
  delivery: "recorded";
  cancellation: RemoteCancellation;
}

export interface RemoteJobResult { outputRef?: string; inline?: Uint8Array }
export interface RemoteAdmissionStoreOptions { clock?: () => Date; resultTtlMs?: number; maxTombstones?: number }

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
  resultExpiresAt?: string;
  cancellation?: RemoteCancellation;
  outputRef?: string;
}

export interface RemoteJobView { authoritative: true; job: RemoteJob }

export interface RemoteJobEvent {
  protocolVersion: string;
  jobId: string;
  sequence: string;
  occurredAt: string;
  kind: "state_changed" | "cancel_requested" | "stopped" | "effect_outcome_unknown" | "result_expired" | "reconciled";
  state: RemoteJobState;
  cancellation?: RemoteCancellation;
  traceId: string;
}

export interface RemoteEventPage {
  jobId: string;
  events: RemoteJobEvent[];
  nextCursor: string;
  gap?: { earliestSequence: string };
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
  "device_epoch_mismatch" | "idempotency_conflict" | "unauthorized" | "not_found" |
  "result_expired" | "result_withheld_by_policy" | "storage_exhausted" | "schema_migration_failed" | "blocked_quota";

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
  result_expires_at: string | null; result_expired: number; output_ref: string | null;
  result_iv: Uint8Array | null; result_tag: Uint8Array | null; result_ciphertext: Uint8Array | null;
  reconciliation_evidence: string | null;
};
type EventRow = { sequence: number; occurred_at: string; kind: RemoteJobEvent["kind"]; state: RemoteJobState;
  trace_id: string; cancellation_json: string | null };
type CancellationRow = { job_id: string; cancel_request_id: string; trace_id: string; requested_at: string;
  stop: RemoteCancellation["stop"]; effect: RemoteCancellation["effect"];
  receipt_stop: RemoteCancellation["stop"]; receipt_effect: RemoteCancellation["effect"] };
type TombstoneRow = { job_id: string; payload_digest: string; outcome: RemoteTerminalState; created_at: string;
  updated_at: string; result_expires_at: string | null };

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
  private readonly clock: () => Date;
  private readonly resultTtlMs: number;
  private readonly maxTombstones: number;
  private reconciled = false;

  constructor(databasePath: string, storageKey: Uint8Array,
    clockOrOptions: (() => Date) | RemoteAdmissionStoreOptions = {}, extraOptions: RemoteAdmissionStoreOptions = {}) {
    if (!isAbsolute(databasePath)) throw new Error("Remote admission state path must be absolute.");
    if (!ArrayBuffer.isView(storageKey) || Object.prototype.toString.call(storageKey) !== "[object Uint8Array]" || storageKey.byteLength !== 32) {
      throw new Error("Remote admission requires a 32-byte storage key.");
    }
    const options = typeof clockOrOptions === "function" ? { ...extraOptions, clock: clockOrOptions } : clockOrOptions;
    this.clock = options.clock ?? (() => new Date());
    this.resultTtlMs = options.resultTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.maxTombstones = options.maxTombstones ?? 1_000_000;
    if (!Number.isSafeInteger(this.resultTtlMs) || this.resultTtlMs < 0 ||
      !Number.isSafeInteger(this.maxTombstones) || this.maxTombstones < 0) throw new Error("Invalid remote store retention options.");
    this.key = Buffer.from(storageKey);
    this.cursorKey = createHmac("sha256", this.key).update("remote-admission-cursor-v1").digest();
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    try {
      this.database.exec("PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
      initializeRemoteAdmissionSchema(this.database, this.key, this.resultTtlMs);
    } catch (error) {
      this.database.close(); this.key.fill(0); this.cursorKey.fill(0);
      if (error instanceof Error && error.message === "Remote admission storage key does not match.") throw error;
      throw new RemoteAdmissionError("schema_migration_failed", "Remote admission schema initialization failed.");
    }
    try {
      const mode = this.database.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode: string } | undefined;
      if (mode?.journal_mode.toLowerCase() !== "wal") throw new Error("WAL journal mode is unavailable.");
    }
    catch (error) {
      this.database.close(); this.key.fill(0); this.cursorKey.fill(0);
      throw new Error("Remote admission WAL initialization failed.", { cause: error });
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

  admit(identity: VerifiedRemoteIdentity, rawRequest: string, options: { rejectNew?: boolean; policyNarrowing?: string | null } = {}): AdmissionDecision {
    this.requireReconciled();
    const principal = checkedPrincipal(identity);
    const request = parseRemoteRequest(rawRequest);
    if (request.accountId !== principal.accountId || request.clientId !== principal.clientId || request.deviceId !== principal.deviceId) {
      throw new RemoteAdmissionError("unauthorized", "Request principal does not match the verified principal.");
    }
    if (Date.parse(request.expiresAt) <= this.clock().getTime()) throw new RemoteAdmissionError("expired_request", "Request has expired.");
    if (request.payloadDigest !== remotePayloadDigest(request)) throw new RemoteAdmissionError("invalid_request", "Request digest is invalid.");
    if (options.policyNarrowing != null && !Number.isFinite(Date.parse(options.policyNarrowing))) throw new RemoteAdmissionError("invalid_request", "Invalid policy fence.");
    return this.transaction(() => {
      this.requireEpoch(principal, request.deviceEpoch);
      const existing = this.database.prepare(`SELECT * FROM remote_jobs WHERE account_id = ? AND client_id = ?
        AND device_id = ? AND idempotency_key = ?`).get(principal.accountId, principal.clientId, principal.deviceId,
        request.idempotencyKey) as unknown as JobRow | undefined;
      if (existing) {
        if (existing.payload_digest !== request.payloadDigest) {
          throw new RemoteAdmissionError("idempotency_conflict", "Idempotency key was reused with different content.");
        }
        return { created: false, job: this.toJob(existing), request };
      }
      const tombstone = this.database.prepare(`SELECT * FROM remote_job_tombstones WHERE account_id = ? AND client_id = ?
        AND device_id = ? AND idempotency_key = ?`).get(principal.accountId, principal.clientId, principal.deviceId,
        request.idempotencyKey) as unknown as TombstoneRow | undefined;
      if (tombstone) {
        if (tombstone.payload_digest !== request.payloadDigest) {
          throw new RemoteAdmissionError("idempotency_conflict", "Idempotency key was reused with different content.");
        }
        return { created: false, request, job: { protocolVersion: request.protocolVersion, jobId: tombstone.job_id,
          principal, idempotencyKey: request.idempotencyKey, payloadDigest: tombstone.payload_digest,
          toolId: request.toolId, operationClass: request.operationClass, scopeRef: request.scopeRef,
          state: tombstone.outcome, createdAt: tombstone.created_at, updatedAt: tombstone.updated_at,
          ...(tombstone.result_expires_at ? { resultExpiresAt: tombstone.result_expires_at } : {}) } };
      }
      if (options.rejectNew) throw new RemoteAdmissionError("blocked_quota", "Remote job queue is full.");
      // Reserve the future tombstone before admitting work, so settlement can never exhaust the bound.
      const capacity = this.database.prepare(`SELECT
        (SELECT COUNT(*) FROM remote_job_tombstones) +
        (SELECT COUNT(*) FROM remote_jobs WHERE state IN ('queued', 'awaiting_approval', 'running')) AS used`).get() as { used: number };
      if (capacity.used >= this.maxTombstones) throw new RemoteAdmissionError("storage_exhausted", "Remote job retention capacity is exhausted.");
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
      if (Object.hasOwn(options, "policyNarrowing")) {
        this.database.prepare("INSERT INTO remote_job_policy_fences (job_id, narrowed_at) VALUES (?, ?)").run(jobId, options.policyNarrowing ?? null);
      }
      return { created: true, job: this.toJob(this.ownedRow(principal, jobId)), request };
    });
  }

  getJob(identity: VerifiedRemoteIdentity, jobId: string): RemoteJob | undefined {
    const principal = checkedPrincipal(identity);
    const row = this.findOwnedRow(principal, jobId);
    return row ? this.toJob(row) : undefined;
  }

  /** Undefined means the job predates policy fencing; null means it was admitted before any narrowing. */
  policyNarrowingAtAdmission(identity: VerifiedRemoteIdentity, jobId: string): string | null | undefined {
    const principal = checkedPrincipal(identity);
    this.ownedRow(principal, jobId);
    const row = this.database.prepare("SELECT narrowed_at FROM remote_job_policy_fences WHERE job_id = ?").get(jobId) as
      { narrowed_at: string | null } | undefined;
    if (!row) return undefined;
    if (row.narrowed_at !== null && (typeof row.narrowed_at !== "string" || !Number.isFinite(Date.parse(row.narrowed_at)))) {
      throw new RemoteAdmissionError("schema_migration_failed", "Invalid stored policy fence.");
    }
    return row.narrowed_at;
  }

  view(identity: VerifiedRemoteIdentity, jobId: string): RemoteJobView {
    const principal = checkedPrincipal(identity);
    return { authoritative: true, job: this.toJob(this.ownedRow(principal, jobId)) };
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

  /** Replace only an undispatched request after the connector reauthorizes a retry. */
  refreshQueuedRequest(identity: VerifiedRemoteIdentity, jobId: string, rawRequest: string): void {
    this.requireReconciled();
    const principal = checkedPrincipal(identity);
    const request = parseRemoteRequest(rawRequest);
    if (request.accountId !== principal.accountId || request.clientId !== principal.clientId ||
      request.deviceId !== principal.deviceId || request.payloadDigest !== remotePayloadDigest(request) ||
      Date.parse(request.expiresAt) <= this.clock().getTime()) {
      throw new RemoteAdmissionError("invalid_request", "Queued request refresh is invalid.");
    }
    this.transaction(() => {
      const row = this.ownedRow(principal, jobId);
      this.requireEpoch(principal, request.deviceEpoch);
      if (row.state !== "queued" || row.dispatching !== 0 || row.idempotency_key !== request.idempotencyKey ||
        row.payload_digest !== request.payloadDigest || row.tool_id !== request.toolId ||
        row.operation_class !== request.operationClass || row.scope_ref !== request.scopeRef) {
        throw new RemoteAdmissionError("invalid_request", "Queued request no longer matches the admitted job.");
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key, iv);
      cipher.setAAD(requestAad(principal, jobId, request.payloadDigest));
      const ciphertext = Buffer.concat([cipher.update(rawRequest, "utf8"), cipher.final()]);
      this.database.prepare("UPDATE remote_jobs SET request_iv = ?, request_tag = ?, request_ciphertext = ? WHERE job_id = ?")
        .run(iv, cipher.getAuthTag(), ciphertext, jobId);
    });
  }

  /** Commit this marker immediately before the broker call, with no intervening await. */
  markDispatching(identity: VerifiedRemoteIdentity, jobId: string, epoch: string): RemoteJob {
    this.requireReconciled();
    const principal = checkedPrincipal(identity);
    return this.transaction(() => {
      const row = this.ownedRow(principal, jobId);
      this.requireEpoch(principal, epoch);
      if (row.state !== "queued" || row.dispatching !== 0) throw new Error("Remote job cannot be dispatched from its current state.");
      const request = this.decryptRequest(principal, row);
      if (request.payloadDigest !== row.payload_digest || remotePayloadDigest(request) !== row.payload_digest) {
        throw new RemoteAdmissionError("invalid_request", "Stored request digest is invalid.");
      }
      if (request.deviceEpoch !== epoch) throw new RemoteAdmissionError("device_epoch_mismatch", "Queued request requires fresh authorization.");
      if (Date.parse(request.expiresAt) <= this.clock().getTime()) throw new RemoteAdmissionError("expired_request", "Request has expired.");
      return this.transition(row, "running", "state_changed");
    });
  }

  markAwaitingApproval(identity: VerifiedRemoteIdentity, jobId: string): RemoteJob {
    return this.simpleTransition(identity, jobId, "queued", "awaiting_approval");
  }

  approve(identity: VerifiedRemoteIdentity, jobId: string): RemoteJob {
    return this.simpleTransition(identity, jobId, "awaiting_approval", "queued");
  }

  denyApproval(identity: VerifiedRemoteIdentity, jobId: string, reason?: "approval_denied" | "approval_expired"): RemoteJob {
    const result = reason ? { inline: Buffer.from(JSON.stringify({ reason }), "utf8") } : undefined;
    return this.simpleTransition(identity, jobId, "awaiting_approval", "blocked_policy", result);
  }

  blockQuota(identity: VerifiedRemoteIdentity, jobId: string): RemoteJob {
    return this.simpleTransition(identity, jobId, "queued", "blocked_quota");
  }

  /** Bind a process returned by the governed start tool to its admitted job. */
  bindStartedProcess(identity: VerifiedRemoteIdentity, jobId: string, processId: string): void {
    this.requireReconciled();
    const principal = checkedPrincipal(identity);
    checkedId(processId);
    this.transaction(() => {
      const row = this.ownedRow(principal, jobId);
      if (row.tool_id !== "process_start" || !((row.state === "running" && row.dispatching === 1) ||
        (row.state === "outcome_unknown" && this.cancellation(jobId)))) {
        throw new Error("A managed process can only bind to its owned start attempt.");
      }
      const previous = this.database.prepare("SELECT process_id FROM remote_job_processes WHERE job_id = ?")
        .get(jobId) as { process_id: string } | undefined;
      if (previous && previous.process_id !== processId) throw new Error("Remote job process identity changed.");
      if (!previous) this.database.prepare("INSERT INTO remote_job_processes (job_id, process_id) VALUES (?, ?)").run(jobId, processId);
    });
  }

  startedProcess(identity: VerifiedRemoteIdentity, jobId: string): string | undefined {
    const principal = checkedPrincipal(identity);
    const row = this.ownedRow(principal, jobId);
    if (row.tool_id !== "process_start") return undefined;
    const link = this.database.prepare("SELECT process_id FROM remote_job_processes WHERE job_id = ?")
      .get(jobId) as { process_id: string } | undefined;
    return link?.process_id;
  }

  settle(identity: VerifiedRemoteIdentity, jobId: string, state: "completed" | "failed" | "outcome_unknown", result?: RemoteJobResult): RemoteJob {
    this.requireReconciled();
    const principal = checkedPrincipal(identity);
    if (!["completed", "failed", "outcome_unknown"].includes(state)) throw new RemoteAdmissionError("invalid_request", "Invalid settlement state.");
    return this.transaction(() => {
      const row = this.ownedRow(principal, jobId);
      if (row.state !== "running" || row.dispatching !== 1) throw new Error("Remote job has no active dispatch marker.");
      const cancellation = this.cancellation(jobId);
      if (cancellation) {
        this.updateCancellation(cancellation, cancellation.stop, state === "outcome_unknown" ? "effect_outcome_unknown" : "known");
      }
      this.transition(row, state, "state_changed", result);
      if (cancellation && state === "outcome_unknown") this.appendEvent(jobId, "effect_outcome_unknown", row.trace_id);
      return this.toJob(this.ownedRow(principal, jobId));
    });
  }

  blockPolicy(identity: VerifiedRemoteIdentity, jobId: string, reason?: string): RemoteJob {
    const result = reason === undefined ? undefined : { inline: Buffer.from(JSON.stringify({ reason }), "utf8") };
    return this.simpleTransition(identity, jobId, "queued", "blocked_policy", result);
  }

  private simpleTransition(identity: VerifiedRemoteIdentity, jobId: string, from: RemoteJobState, to: RemoteJobState, result?: RemoteJobResult): RemoteJob {
    this.requireReconciled();
    const principal = checkedPrincipal(identity);
    return this.transaction(() => {
      const row = this.ownedRow(principal, jobId);
      if (row.state !== from) throw new Error("Remote job cannot transition from its current state.");
      return this.transition(row, to, "state_changed", result);
    });
  }

  requestCancel(identity: VerifiedRemoteIdentity, jobId: string, cancelRequestId: string, traceId: string): RemoteCancelReceipt {
    this.requireReconciled();
    const principal = checkedPrincipal(identity);
    checkedId(cancelRequestId); checkedId(traceId);
    return this.transaction(() => {
      const row = this.findOwnedRow(principal, jobId);
      if (!row) {
        const tombstone = this.database.prepare(`SELECT job_id FROM remote_job_tombstones WHERE job_id = ?
          AND account_id = ? AND client_id = ? AND device_id = ?`).get(jobId, principal.accountId, principal.clientId, principal.deviceId);
        const retained = tombstone ? this.cancellation(jobId) : undefined;
        if (retained) return cancellationReceipt(retained);
        throw new RemoteAdmissionError("not_found", "Remote job is unavailable.");
      }
      const existing = this.cancellation(jobId);
      if (existing) return cancellationReceipt(existing);
      const now = this.clock().toISOString();
      const beforeDispatch = row.state === "queued" || row.state === "awaiting_approval";
      const completedProcess = row.tool_id === "process_start" && row.state === "completed";
      const processLink = completedProcess ? this.database.prepare("SELECT process_id FROM remote_job_processes WHERE job_id = ?").get(jobId) : undefined;
      const stop: RemoteCancellation["stop"] = beforeDispatch ? "stopped" : row.state === "running" || processLink ? "pending" :
        row.state === "outcome_unknown" || completedProcess ? "unverified" : "not_applicable";
      const effect: RemoteCancellation["effect"] = beforeDispatch || row.state === "blocked_policy" || row.state === "blocked_quota" ? "no_effect" :
        row.state === "running" ? "pending" : row.state === "outcome_unknown" ? "effect_outcome_unknown" : "known";
      this.database.prepare(`INSERT INTO remote_job_cancellations (job_id, cancel_request_id, trace_id, requested_at, stop, effect, receipt_stop, receipt_effect)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(jobId, cancelRequestId, traceId, now, stop, effect, stop, effect);
      this.appendEvent(jobId, "cancel_requested", traceId, now);
      if (beforeDispatch) this.transition(this.ownedRow(principal, jobId), "cancelled", "state_changed");
      return cancellationReceipt(this.cancellation(jobId)!);
    });
  }

  recordStop(identity: VerifiedRemoteIdentity, jobId: string, evidence: "verified" | "unverified"): RemoteJob {
    this.requireReconciled();
    const principal = checkedPrincipal(identity);
    if (evidence !== "verified" && evidence !== "unverified") throw new RemoteAdmissionError("invalid_request", "Invalid stop evidence.");
    return this.transaction(() => {
      const row = this.ownedRow(principal, jobId);
      const cancellation = this.cancellation(jobId);
      if (!cancellation || cancellation.stop === "not_applicable") throw new Error("Remote job has no applicable cancellation.");
      const stop = evidence === "verified" ? "stopped" : "unverified";
      if (cancellation.stop === "stopped" && stop !== "stopped") throw new Error("Verified stop evidence cannot be downgraded.");
      if (cancellation.stop !== stop) {
        this.updateCancellation(cancellation, stop, cancellation.effect);
        this.appendEvent(jobId, "stopped", cancellation.trace_id);
      }
      return this.toJob(this.ownedRow(principal, row.job_id));
    });
  }

  settleCancelled(identity: VerifiedRemoteIdentity, jobId: string,
    effect: "no_effect" | "known" | "effect_outcome_unknown", result?: RemoteJobResult): RemoteJob {
    this.requireReconciled();
    const principal = checkedPrincipal(identity);
    if (!["no_effect", "known", "effect_outcome_unknown"].includes(effect) || (result && effect !== "known")) {
      throw new RemoteAdmissionError("invalid_request", "Invalid cancellation settlement.");
    }
    return this.transaction(() => {
      const row = this.ownedRow(principal, jobId);
      const cancellation = this.cancellation(jobId);
      if (row.state !== "running" || !cancellation) throw new Error("Remote job has no active cancellation.");
      if (effect !== "effect_outcome_unknown" && cancellation.stop !== "stopped") {
        throw new Error("Cancellation requires verified stop evidence.");
      }
      const stop = cancellation.stop === "pending" && effect === "effect_outcome_unknown" ? "unverified" : cancellation.stop;
      this.updateCancellation(cancellation, stop, effect);
      if (stop !== cancellation.stop) this.appendEvent(jobId, "stopped", cancellation.trace_id);
      this.transition(this.ownedRow(principal, jobId), effect === "effect_outcome_unknown" ? "outcome_unknown" : "cancelled", "state_changed", result);
      if (effect === "effect_outcome_unknown") this.appendEvent(jobId, "effect_outcome_unknown", cancellation.trace_id);
      return this.toJob(this.ownedRow(principal, jobId));
    });
  }

  /** Call at startup under exclusive database ownership and the device owner lock, before readiness. */
  reconcileStartup(): RemoteJob[] {
    if (this.reconciled) return [];
    const jobs = this.transaction(() => {
      const rows = this.database.prepare("SELECT * FROM remote_jobs WHERE state = 'running' AND dispatching = 1").all() as unknown as JobRow[];
      const reconciled = rows.map((row) => {
        const cancellation = this.cancellation(row.job_id);
        if (cancellation) {
          // A prior stop observation is not automatically fresh proof after an interrupted dispatch.
          this.updateCancellation(cancellation, "unverified", "effect_outcome_unknown");
          this.appendEvent(row.job_id, "stopped", cancellation.trace_id);
          this.appendEvent(row.job_id, "effect_outcome_unknown", cancellation.trace_id);
        }
        return this.transition(this.ownedRow(rowIdentity(row), row.job_id), "outcome_unknown", "reconciled");
      });
      // An interrupted terminal approval has lost its nonce and must never be replayed.
      const awaiting = this.database.prepare("SELECT * FROM remote_jobs WHERE state = 'awaiting_approval'").all() as unknown as JobRow[];
      for (const row of awaiting) reconciled.push(this.transition(row, "blocked_policy", "reconciled",
        { inline: Buffer.from(JSON.stringify({ reason: "approval_expired" }), "utf8") }));
      const pending = this.database.prepare(`SELECT j.job_id FROM remote_jobs j JOIN remote_job_cancellations c ON c.job_id = j.job_id
        WHERE j.state != 'running' AND c.stop = 'pending'`).all() as { job_id: string }[];
      for (const row of pending) {
        const cancellation = this.cancellation(row.job_id)!;
        this.updateCancellation(cancellation, "unverified", cancellation.effect);
        this.appendEvent(row.job_id, "stopped", cancellation.trace_id);
      }
      return reconciled;
    });
    this.reconciled = true;
    return jobs;
  }

  reconcileUnknown(identity: VerifiedRemoteIdentity, jobId: string, resolution: "completed" | "failed", evidence: string): RemoteJob {
    this.requireReconciled();
    const principal = checkedPrincipal(identity);
    if ((resolution !== "completed" && resolution !== "failed") || typeof evidence !== "string" ||
      !evidence.trim() || evidence.length > 16_384) throw new RemoteAdmissionError("invalid_request", "Reconciliation requires evidence and a known outcome.");
    return this.transaction(() => {
      const row = this.ownedRow(principal, jobId);
      if (row.state !== "outcome_unknown") throw new Error("Remote job outcome is not unknown.");
      const cancellation = this.cancellation(jobId);
      if (cancellation) this.updateCancellation(cancellation, cancellation.stop, "known");
      return this.transition(row, resolution, "reconciled", undefined, evidence);
    });
  }

  events(identity: VerifiedRemoteIdentity, jobId: string, cursor?: string, limit = 100): RemoteEventPage {
    const principal = checkedPrincipal(identity);
    const job = this.ownedRow(principal, jobId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new RemoteAdmissionError("invalid_request", "Invalid event page size.");
    const after = cursor === undefined ? 0 : this.decodeCursor(principal, jobId, cursor);
    if (after > job.last_sequence) throw new RemoteAdmissionError("invalid_request", "Event cursor is ahead of the journal.");
    const first = this.database.prepare("SELECT MIN(sequence) AS sequence FROM remote_job_events WHERE job_id = ?").get(jobId) as { sequence: number | null };
    const earliest = first.sequence === null ? BigInt(job.last_sequence) + 1n : BigInt(first.sequence);
    const hasGap = earliest > 1n && BigInt(after) < earliest;
    const rows = this.database.prepare(`SELECT sequence, occurred_at, kind, state, trace_id, cancellation_json FROM remote_job_events
      WHERE job_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`).all(jobId, after, limit) as unknown as EventRow[];
    const events = rows.map((row): RemoteJobEvent => ({ protocolVersion: job.protocol_version,
      jobId, sequence: String(row.sequence), occurredAt: row.occurred_at, kind: row.kind, state: row.state, traceId: row.trace_id,
      ...(row.cancellation_json ? { cancellation: JSON.parse(row.cancellation_json) as RemoteCancellation } : {}) }));
    const next = rows.length ? rows[rows.length - 1].sequence : hasGap ? job.last_sequence : after;
    const earliestSequence = earliest.toString();
    return { jobId, events, nextCursor: this.encodeCursor(principal, jobId, next), ...(hasGap ? { gap: { earliestSequence } } : {}) };
  }

  result(identity: VerifiedRemoteIdentity, jobId: string): { state: RemoteJobState; outputRef?: string; inline?: Uint8Array } {
    const principal = checkedPrincipal(identity);
    const row = this.findOwnedRow(principal, jobId);
    if (!row) {
      const tombstone = this.database.prepare(`SELECT result_expired FROM remote_job_tombstones WHERE job_id = ?
        AND account_id = ? AND client_id = ? AND device_id = ?`).get(jobId, principal.accountId, principal.clientId, principal.deviceId) as { result_expired: number } | undefined;
      if (tombstone?.result_expired) throw new RemoteAdmissionError("result_expired", "Remote job result has expired.");
      throw new RemoteAdmissionError("not_found", "Remote job is unavailable.");
    }
    if (!isTerminal(row.state)) throw new RemoteAdmissionError("invalid_request", "Remote job has not settled.");
    const expiry = row.result_expires_at ? Date.parse(row.result_expires_at) : NaN;
    if (row.result_expired || !Number.isFinite(expiry) || expiry <= this.clock().getTime()) {
      throw new RemoteAdmissionError("result_expired", "Remote job result has expired.");
    }
    let inline: Buffer | undefined;
    if (row.result_iv && row.result_tag && row.result_ciphertext) {
      const decipher = createDecipheriv("aes-256-gcm", this.key, row.result_iv);
      decipher.setAAD(resultAad(principal, jobId, row.payload_digest));
      decipher.setAuthTag(row.result_tag);
      inline = Buffer.concat([decipher.update(row.result_ciphertext), decipher.final()]);
    }
    return { state: row.state, ...(row.output_ref ? { outputRef: row.output_ref } : {}), ...(inline ? { inline } : {}) };
  }

  expireResults(identity?: VerifiedRemoteIdentity): number {
    this.requireReconciled();
    const principal = identity === undefined ? undefined : checkedPrincipal(identity);
    return this.transaction(() => {
      const now = this.clock().toISOString();
      const query = `SELECT * FROM remote_jobs WHERE result_expired = 0 AND result_expires_at IS NOT NULL AND result_expires_at <= ?` +
        (principal ? " AND account_id = ? AND client_id = ? AND device_id = ?" : "");
      const statement = this.database.prepare(query);
      const rows = (principal ? statement.all(now, principal.accountId, principal.clientId, principal.deviceId) : statement.all(now)) as unknown as JobRow[];
      for (const row of rows) {
        const tombstone = this.database.prepare(`UPDATE remote_job_tombstones SET result_expired = 1
          WHERE job_id = ? AND account_id = ? AND client_id = ? AND device_id = ? AND payload_digest = ? AND outcome = ?`)
          .run(row.job_id, row.account_id, row.client_id, row.device_id, row.payload_digest, row.state);
        if (Number(tombstone.changes) !== 1) throw new Error("Remote job tombstone is missing or inconsistent.");
        this.database.prepare(`UPDATE remote_jobs SET result_expired = 1, output_ref = NULL,
          result_iv = NULL, result_tag = NULL, result_ciphertext = NULL WHERE job_id = ?`).run(row.job_id);
        this.appendEvent(row.job_id, "result_expired", row.trace_id, now);
      }
      return rows.length;
    });
  }

  pruneEvents(olderThan: Date | string): number;
  pruneEvents(identity: VerifiedRemoteIdentity | undefined, olderThan: Date | string): number;
  pruneEvents(identityOrTime: VerifiedRemoteIdentity | Date | string | undefined, olderThan?: Date | string): number {
    this.requireReconciled();
    const principal = typeof identityOrTime === "string" || identityOrTime instanceof Date || identityOrTime === undefined ?
      undefined : checkedPrincipal(identityOrTime);
    const cutoff = checkedTime(olderThan ?? (identityOrTime as Date | string));
    return this.transaction(() => {
      const query = `SELECT job_id FROM remote_jobs WHERE state NOT IN ('running', 'outcome_unknown') AND NOT EXISTS
        (SELECT 1 FROM remote_job_cancellations c WHERE c.job_id = remote_jobs.job_id AND c.stop IN ('pending', 'unverified'))
        AND NOT EXISTS (SELECT 1 FROM remote_job_processes p WHERE p.job_id = remote_jobs.job_id)` +
        (principal ? " AND account_id = ? AND client_id = ? AND device_id = ?" : "");
      const statement = this.database.prepare(query);
      const jobs = (principal ? statement.all(principal.accountId, principal.clientId, principal.deviceId) : statement.all()) as { job_id: string }[];
      let deleted = 0;
      for (const job of jobs) {
        const events = this.database.prepare("SELECT sequence, occurred_at FROM remote_job_events WHERE job_id = ? ORDER BY sequence").all(job.job_id) as { sequence: number; occurred_at: string }[];
        let last = 0;
        for (const event of events) {
          if (!(Date.parse(event.occurred_at) < cutoff)) break;
          last = event.sequence;
        }
        if (last) deleted += Number(this.database.prepare("DELETE FROM remote_job_events WHERE job_id = ? AND sequence <= ?").run(job.job_id, last).changes);
      }
      return deleted;
    });
  }

  pruneJobs(olderThan: Date | string): number;
  pruneJobs(identity: VerifiedRemoteIdentity | undefined, olderThan: Date | string): number;
  pruneJobs(identityOrTime: VerifiedRemoteIdentity | Date | string | undefined, olderThan?: Date | string): number {
    this.requireReconciled();
    const principal = typeof identityOrTime === "string" || identityOrTime instanceof Date || identityOrTime === undefined ?
      undefined : checkedPrincipal(identityOrTime);
    const cutoff = new Date(checkedTime(olderThan ?? (identityOrTime as Date | string))).toISOString();
    return this.transaction(() => {
      const sql = `DELETE FROM remote_jobs WHERE state IN ('completed', 'failed', 'cancelled', 'blocked_policy', 'blocked_quota')
        AND result_expired = 1 AND updated_at < ? AND EXISTS
        (SELECT 1 FROM remote_job_tombstones t WHERE t.job_id = remote_jobs.job_id AND t.account_id = remote_jobs.account_id
          AND t.client_id = remote_jobs.client_id AND t.device_id = remote_jobs.device_id AND t.idempotency_key = remote_jobs.idempotency_key
          AND t.payload_digest = remote_jobs.payload_digest AND t.outcome = remote_jobs.state AND t.result_expired = 1) AND NOT EXISTS
        (SELECT 1 FROM remote_job_cancellations c WHERE c.job_id = remote_jobs.job_id AND c.stop IN ('pending', 'unverified'))` +
        (principal ? " AND account_id = ? AND client_id = ? AND device_id = ?" : "");
      const statement = this.database.prepare(sql);
      return Number((principal ? statement.run(cutoff, principal.accountId, principal.clientId, principal.deviceId) : statement.run(cutoff)).changes);
    });
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
    if (!row) throw new RemoteAdmissionError("not_found", "Remote job is unavailable.");
    return row;
  }

  private transition(row: JobRow, state: RemoteJobState, kind: RemoteJobEvent["kind"], result?: RemoteJobResult, evidence?: string): RemoteJob {
    const allowed: Readonly<Record<RemoteJobState, readonly RemoteJobState[]>> = {
      queued: ["awaiting_approval", "running", "cancelled", "blocked_policy", "blocked_quota"],
      awaiting_approval: ["queued", "cancelled", "blocked_policy"], running: ["completed", "failed", "cancelled", "outcome_unknown"],
      completed: [], failed: [], cancelled: [], outcome_unknown: ["completed", "failed"], blocked_policy: [], blocked_quota: [],
    };
    if (!allowed[row.state].includes(state) || (row.state === "outcome_unknown" && !evidence?.trim())) {
      throw new Error("Invalid remote job transition.");
    }
    if (result && !isTerminal(state)) throw new RemoteAdmissionError("invalid_request", "Result requires terminal settlement.");
    if (result?.outputRef !== undefined && (typeof result.outputRef !== "string" || !/^[0-9a-f]{64}$/.test(result.outputRef))) {
      throw new RemoteAdmissionError("invalid_request", "Result reference must be an ArtifactStore hash.");
    }
    if (result?.inline !== undefined && (!(result.inline instanceof Uint8Array) || result.inline.byteLength > 256 * 1024)) {
      throw new RemoteAdmissionError("invalid_request", "Inline result exceeds the size limit or is invalid.");
    }
    const now = this.clock().toISOString();
    const terminal = isTerminal(state);
    const expiresAt = terminal ? new Date(Date.parse(now) + this.resultTtlMs).toISOString() : null;
    const keepResult = row.state === "outcome_unknown" && result === undefined && !row.result_expired &&
      row.result_expires_at !== null && Date.parse(row.result_expires_at) > Date.parse(now);
    const outputRef = result?.outputRef ?? (keepResult ? row.output_ref : null);
    let iv: Uint8Array | null = keepResult ? row.result_iv : null;
    let tag: Uint8Array | null = keepResult ? row.result_tag : null;
    let ciphertext: Uint8Array | null = keepResult ? row.result_ciphertext : null;
    if (result?.inline !== undefined) {
      iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key, iv);
      cipher.setAAD(resultAad(rowIdentity(row), row.job_id, row.payload_digest));
      ciphertext = Buffer.concat([cipher.update(result.inline), cipher.final()]);
      tag = cipher.getAuthTag();
    }
    const clearRequest = state === "running" || terminal;
    this.database.prepare(`UPDATE remote_jobs SET state = ?, updated_at = ?, dispatching = ?,
      request_iv = CASE WHEN ? THEN NULL ELSE request_iv END,
      request_tag = CASE WHEN ? THEN NULL ELSE request_tag END,
      request_ciphertext = CASE WHEN ? THEN NULL ELSE request_ciphertext END,
      result_expires_at = ?, result_expired = 0, output_ref = ?, result_iv = ?, result_tag = ?, result_ciphertext = ?,
      reconciliation_evidence = ? WHERE job_id = ?`)
      .run(state, now, Number(state === "running"), Number(clearRequest), Number(clearRequest), Number(clearRequest),
        expiresAt, outputRef, iv, tag, ciphertext, evidence ?? row.reconciliation_evidence, row.job_id);
    this.appendEvent(row.job_id, kind, row.trace_id, now);
    if (terminal) {
      const previous = this.database.prepare(`SELECT job_id, payload_digest, outcome FROM remote_job_tombstones
        WHERE account_id = ? AND client_id = ? AND device_id = ? AND idempotency_key = ?`)
        .get(row.account_id, row.client_id, row.device_id, row.idempotency_key) as { job_id: string; payload_digest: string; outcome: RemoteTerminalState } | undefined;
      if (previous) {
        if (previous.job_id !== row.job_id || previous.payload_digest !== row.payload_digest ||
          row.state !== "outcome_unknown" || previous.outcome !== "outcome_unknown") {
          throw new Error("Remote job tombstone does not match the admitted job.");
        }
        this.database.prepare(`UPDATE remote_job_tombstones SET outcome = ?, updated_at = ?, result_expires_at = ?, result_expired = 0
          WHERE job_id = ?`).run(state, now, expiresAt, row.job_id);
      } else {
        this.database.prepare(`INSERT INTO remote_job_tombstones (account_id, client_id, device_id, idempotency_key,
          payload_digest, job_id, outcome, created_at, updated_at, result_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(row.account_id, row.client_id, row.device_id, row.idempotency_key, row.payload_digest, row.job_id,
            state, row.created_at, now, expiresAt);
      }
    }
    return this.toJob(this.ownedRow(rowIdentity(row), row.job_id));
  }

  private cancellation(jobId: string): CancellationRow | undefined {
    return this.database.prepare("SELECT * FROM remote_job_cancellations WHERE job_id = ?").get(jobId) as unknown as CancellationRow | undefined;
  }

  private updateCancellation(row: CancellationRow, stop: RemoteCancellation["stop"], effect: RemoteCancellation["effect"]): void {
    this.database.prepare("UPDATE remote_job_cancellations SET stop = ?, effect = ? WHERE job_id = ? AND cancel_request_id = ?")
      .run(stop, effect, row.job_id, row.cancel_request_id);
  }

  private appendEvent(jobId: string, kind: RemoteJobEvent["kind"], traceId: string, now = this.clock().toISOString()): void {
    const row = this.database.prepare("SELECT * FROM remote_jobs WHERE job_id = ?").get(jobId) as unknown as JobRow;
    if (!Number.isSafeInteger(row.last_sequence) || row.last_sequence >= Number.MAX_SAFE_INTEGER) throw new Error("Remote job event sequence exhausted.");
    const sequence = row.last_sequence + 1;
    const cancellation = this.cancellation(jobId);
    this.database.prepare("UPDATE remote_jobs SET last_sequence = ?, updated_at = ? WHERE job_id = ?").run(sequence, now, jobId);
    this.database.prepare(`INSERT INTO remote_job_events (job_id, sequence, occurred_at, kind, state, trace_id, cancellation_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(jobId, sequence, now, kind, row.state, traceId,
      cancellation ? JSON.stringify(cancellationValue(cancellation)) : null);
  }

  private toJob(row: JobRow): RemoteJob {
    const cancellation = this.cancellation(row.job_id);
    return { protocolVersion: row.protocol_version, jobId: row.job_id, principal: rowIdentity(row),
      idempotencyKey: row.idempotency_key, payloadDigest: row.payload_digest, toolId: row.tool_id,
      operationClass: row.operation_class, scopeRef: row.scope_ref, state: row.state,
      createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.result_expires_at ? { resultExpiresAt: row.result_expires_at } : {}),
      ...(cancellation ? { cancellation: cancellationValue(cancellation) } : {}),
      ...(row.output_ref && !row.result_expired && row.result_expires_at && Date.parse(row.result_expires_at) > this.clock().getTime() ?
        { outputRef: row.output_ref } : {}) };
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

function rowIdentity(row: JobRow): VerifiedRemoteIdentity {
  return { accountId: row.account_id, clientId: row.client_id, deviceId: row.device_id };
}

function cancellationValue(row: CancellationRow): RemoteCancellation {
  return { requestedAt: row.requested_at, stop: row.stop, effect: row.effect };
}

function cancellationReceipt(row: CancellationRow): RemoteCancelReceipt {
  return { jobId: row.job_id, cancelRequestId: row.cancel_request_id, traceId: row.trace_id,
    delivery: "recorded", cancellation: { requestedAt: row.requested_at, stop: row.receipt_stop, effect: row.receipt_effect } };
}

function isTerminal(state: RemoteJobState): state is RemoteTerminalState {
  return ["completed", "failed", "cancelled", "outcome_unknown", "blocked_policy", "blocked_quota"].includes(state);
}

function checkedTime(value: Date | string): number {
  const time = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) throw new RemoteAdmissionError("invalid_request", "Invalid retention cutoff.");
  return time;
}

function requestAad(identity: VerifiedRemoteIdentity, jobId: string, digest: string): Buffer {
  return Buffer.from(JSON.stringify([identity.accountId, identity.clientId, identity.deviceId, jobId, digest]), "utf8");
}

function resultAad(identity: VerifiedRemoteIdentity, jobId: string, digest: string): Buffer {
  return Buffer.from(JSON.stringify([identity.accountId, identity.clientId, identity.deviceId, jobId, digest, "result"]), "utf8");
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
export function rejectDuplicateKeys(raw: string): void {
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
  // Each durable dispatch marker can enter the broker only once in this Runner.
  const claimedJobs = new Set<string>();
  return async (effect: Readonly<RemoteEffectRequest>, dispatch: () => Promise<ToolResult>): Promise<ToolResult> => {
    let parsed: RemoteRequest | undefined;
    // The v1 wire error enum does not yet contain the local storage exhaustion code.
    const failure = (code: string, message: string): ToolResult => ({ callId: effect.callId, toolName: effect.toolName,
      content: parsed && code !== "effect_admission_required" ? [
        { type: "json", value: { requestId: parsed.requestId, traceId: parsed.traceId, admitted: false, status: "rejected",
          errorCode: code === "storage_exhausted" ? "internal_error" : code } },
        { type: "json", value: { protocolVersion: parsed.protocolVersion, code: code === "storage_exhausted" ? "internal_error" : code,
          message, requestId: parsed.requestId, traceId: parsed.traceId } },
      ] : [{ type: "text", text: message }], isError: true, error: { code, message } });
    if (effect.rawRequest === undefined) return failure("effect_admission_required", "A verified remote request is required.");
    let decision: AdmissionDecision;
    try {
      parsed = parseRemoteRequest(effect.rawRequest);
      if (REMOTE_EFFECT_NAMES[parsed.toolId] !== effect.toolName || canonicalJson(parsed.payload) !== canonicalJson(effect.arguments)) {
        throw new RemoteAdmissionError("invalid_request", "Request does not match the broker invocation.");
      }
      if (effect.admittedJobId !== undefined) {
        const job = store.getJob(effect.principal.identity, effect.admittedJobId);
        if (!job || job.state !== "running" || job.idempotencyKey !== parsed.idempotencyKey ||
          job.payloadDigest !== parsed.payloadDigest || remotePayloadDigest(parsed) !== parsed.payloadDigest ||
          job.toolId !== parsed.toolId || job.operationClass !== parsed.operationClass || job.scopeRef !== parsed.scopeRef ||
          parsed.accountId !== effect.principal.identity.accountId || parsed.clientId !== effect.principal.identity.clientId ||
          parsed.deviceId !== effect.principal.identity.deviceId) {
          throw new RemoteAdmissionError("unauthorized", "The scheduled job does not authorize this invocation.");
        }
        if (claimedJobs.has(job.jobId) || claimedJobs.size >= 1_000_000) {
          throw new RemoteAdmissionError("storage_exhausted", "Scheduled dispatch is unavailable.");
        }
        claimedJobs.add(job.jobId);
        const denied = effect.authorize();
        return denied ?? await dispatch();
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
