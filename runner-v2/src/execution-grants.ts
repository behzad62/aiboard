import { randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import type { AgentActor } from "./agent-contracts.js";
import type { PermissionProfile } from "./contracts.js";
import type { ExactPathAccessMode } from "./execution-safety-contracts.js";

export type ExecutionGrantErrorCode =
  | "grant_forged"
  | "grant_consumed"
  | "grant_revoked"
  | "grant_expired"
  | "grant_mismatch"
  | "grant_escalation"
  | "grant_invalid_path";

export class ExecutionGrantError extends Error {
  constructor(readonly code: ExecutionGrantErrorCode, message: string) {
    super(message);
    this.name = "ExecutionGrantError";
  }
}

const RUNNER_OPAQUE_GRANT: unique symbol = Symbol("runner-opaque-execution-grant");

/** Empty, non-serializable authority reference. Claims are held only by Runner. */
export interface OpaqueExecutionGrant {
  readonly [RUNNER_OPAQUE_GRANT]: true;
}

export interface ExecutionGrantBinding {
  readonly runId: string;
  readonly sessionId: string;
  readonly actor: AgentActor;
  readonly toolName: string;
  readonly callId: string;
  readonly permissionProfile: PermissionProfile;
}

const RUNNER_CONSUMED_GRANT: unique symbol = Symbol("runner-consumed-execution-grant");

export interface ExecutionGrantAccessRequest {
  readonly path: string;
  readonly mode: ExactPathAccessMode;
}

export interface ExecutionGrantIssueRequest extends ExecutionGrantBinding {
  readonly workspacePath: string;
  readonly access: readonly ExecutionGrantAccessRequest[];
  /** Names only; credential values never enter an execution grant. */
  readonly credentialNames?: readonly string[];
  readonly externalApproved: boolean;
  readonly destructiveApproved: boolean;
  readonly networkApproved: boolean;
  readonly signal?: AbortSignal;
}

export interface ConsumedExecutionGrantClaims extends ExecutionGrantBinding {
  readonly [RUNNER_CONSUMED_GRANT]: true;
  readonly grantId: string;
  readonly workspacePath: string;
  readonly access: readonly Readonly<{
    canonicalPath: string;
    mode: ExactPathAccessMode;
  }>[];
  readonly credentialNames: readonly string[];
  readonly externalApproved: boolean;
  readonly destructiveApproved: boolean;
  readonly networkApproved: boolean;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
}

export type ExecutionGrantRevocationReason =
  | "completed"
  | "cancelled"
  | "timed_out"
  | "restart"
  | "mismatch"
  | "expired"
  | "cleanup";

export interface ExecutionGrantSnapshot extends ConsumedExecutionGrantClaims {
  readonly state: "issued" | "consumed" | "revoked";
  readonly revocationReason?: ExecutionGrantRevocationReason;
}

export interface ExecutionGrantAuthorityOptions {
  readonly clock?: () => Date;
  readonly ttlMs?: number;
  /** Deterministic scheduling seam; production leaves this unset. */
  readonly beforeIssueCommit?: () => Promise<void>;
}

export interface ExecutionGrantAuthority {
  issue(request: ExecutionGrantIssueRequest): Promise<OpaqueExecutionGrant>;
  consume(
    grant: OpaqueExecutionGrant,
    expected: ExecutionGrantBinding,
  ): ConsumedExecutionGrantClaims;
  revoke(grant: OpaqueExecutionGrant, reason: ExecutionGrantRevocationReason): Promise<boolean>;
  revokeAll(reason: ExecutionGrantRevocationReason): Promise<void>;
  activeSnapshots(): readonly ExecutionGrantSnapshot[];
}

interface GrantRecord {
  readonly authority: object;
  readonly claims: ConsumedExecutionGrantClaims;
  readonly clock: () => Date;
  state: "issued" | "consumed" | "revoked";
  revocationReason?: ExecutionGrantRevocationReason;
  isolationReserved: boolean;
  readonly revokers: Set<() => Promise<void>>;
}

const GRANTS = new WeakMap<object, GrantRecord>();
const CONSUMED_CLAIMS = new WeakMap<object, GrantRecord>();

export function createExecutionGrantAuthority(
  options: ExecutionGrantAuthorityOptions = {},
): ExecutionGrantAuthority {
  const clock = options.clock ?? (() => new Date());
  const ttlMs = options.ttlMs ?? 120_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 3_600_000) {
    throw new Error("Execution grant ttlMs must be an integer from 1 to 3600000.");
  }
  const owned = new Set<object>();
  const authorityIdentity = Object.freeze({});
  let issuanceEpoch = 0;

  return Object.freeze({
    async issue(request: ExecutionGrantIssueRequest): Promise<OpaqueExecutionGrant> {
      const epoch = issuanceEpoch;
      if (request.signal?.aborted) throw grantError("grant_revoked");
      const binding = cloneBinding(request);
      const workspacePath = await canonicalExistingDirectory(request.workspacePath);
      const access = await canonicalizeAccess(
        workspacePath,
        request.access,
        request.externalApproved,
      );
      await options.beforeIssueCommit?.();
      if (request.signal?.aborted || epoch !== issuanceEpoch) throw grantError("grant_revoked");
      const issued = clock();
      const expires = new Date(issued.getTime() + ttlMs);
      const claims = deepFreeze({
        ...binding,
        grantId: `execution-grant-${randomUUID()}`,
        workspacePath,
        access,
        credentialNames: canonicalCredentialNames(request.credentialNames),
        externalApproved: request.externalApproved === true,
        destructiveApproved: request.destructiveApproved === true,
        networkApproved: request.networkApproved === true,
        issuedAt: issued.toISOString(),
        expiresAt: expires.toISOString(),
        nonce: randomBytes(16).toString("hex"),
      }) as unknown as ConsumedExecutionGrantClaims;
      const grant = {} as OpaqueExecutionGrant;
      Object.defineProperty(grant, RUNNER_OPAQUE_GRANT, { value: true });
      Object.freeze(grant);
      GRANTS.set(grant, {
        authority: authorityIdentity,
        claims,
        clock,
        state: "issued",
        isolationReserved: false,
        revokers: new Set(),
      });
      owned.add(grant);
      return grant;
    },

    consume(
      grant: OpaqueExecutionGrant,
      expected: ExecutionGrantBinding,
    ): ConsumedExecutionGrantClaims {
      const record = trustedRecord(grant, authorityIdentity)!;
      if (record.state === "consumed") throw grantError("grant_consumed");
      if (record.state === "revoked") throw grantError("grant_revoked");
      if (Date.parse(record.claims.expiresAt) <= clock().getTime()) {
        record.state = "revoked";
        record.revocationReason = "expired";
        owned.delete(grant as object);
        throw grantError("grant_expired");
      }
      if (!sameBinding(record.claims, expected)) {
        record.state = "revoked";
        record.revocationReason = "mismatch";
        owned.delete(grant as object);
        throw grantError("grant_mismatch");
      }
      record.state = "consumed";
      const consumed = cloneClaims(record.claims, true);
      CONSUMED_CLAIMS.set(consumed, record);
      return consumed;
    },

    async revoke(grant: OpaqueExecutionGrant, reason: ExecutionGrantRevocationReason): Promise<boolean> {
      const record = trustedRecord(grant, authorityIdentity);
      if (!record || record.state === "revoked") return false;
      record.state = "revoked";
      record.revocationReason = reason;
      owned.delete(grant as object);
      await runRevokers(record.revokers);
      return true;
    },

    async revokeAll(reason: ExecutionGrantRevocationReason): Promise<void> {
      issuanceEpoch += 1;
      const revokers: (() => Promise<void>)[] = [];
      for (const grant of owned) {
        const record = GRANTS.get(grant);
        if (record && record.state !== "revoked") {
          record.state = "revoked";
          record.revocationReason = reason;
          revokers.push(...record.revokers);
        }
      }
      owned.clear();
      await runRevokers(revokers);
    },

    activeSnapshots(): readonly ExecutionGrantSnapshot[] {
      return [...owned]
        .map((grant) => GRANTS.get(grant))
        .filter((record): record is GrantRecord => record !== undefined && record.state !== "revoked")
        .map((record) => deepFreeze({ ...cloneClaims(record.claims), state: record.state }));
    },
  });
}

function canonicalCredentialNames(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 128) {
    throw new ExecutionGrantError("grant_mismatch", "Execution grant credential names are invalid.");
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const name of value) {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || seen.has(name)) {
      throw new ExecutionGrantError("grant_mismatch", "Execution grant credential names are invalid.");
    }
    seen.add(name);
    names.push(name);
  }
  return Object.freeze(names);
}

async function runRevokers(revokers: Iterable<() => Promise<void>>): Promise<void> {
  const settled = await Promise.allSettled([...revokers].map((revoke) => revoke()));
  const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Execution grant revocation failed closed with an active cleanup blocker.");
  }
}

/** Reserves the globally consumed grant for exactly one isolation acquisition. */
export function reserveConsumedExecutionGrantForIsolation(
  claims: ConsumedExecutionGrantClaims,
): void {
  assertRunnerConsumedExecutionGrantClaims(claims);
  const record = CONSUMED_CLAIMS.get(claims as object)!;
  if (record.state === "revoked" || record.isolationReserved) throw grantError("grant_consumed");
  record.isolationReserved = true;
}

/** Registers provider cleanup with the issuing authority, closing revoke/acquire races. */
export async function registerConsumedExecutionGrantRevoker(
  claims: ConsumedExecutionGrantClaims,
  revoker: () => Promise<void>,
): Promise<Readonly<{ registered: boolean; dispose: () => void }>> {
  assertRunnerConsumedExecutionGrantClaims(claims);
  const record = CONSUMED_CLAIMS.get(claims as object)!;
  if (record.state === "revoked") {
    await revoker();
    return Object.freeze({ registered: false, dispose: () => undefined });
  }
  record.revokers.add(revoker);
  let disposed = false;
  return Object.freeze({
    registered: true,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      record.revokers.delete(revoker);
    },
  });
}

export function assertRunnerConsumedExecutionGrantClaims(
  value: ConsumedExecutionGrantClaims,
): ConsumedExecutionGrantClaims {
  if (!value || typeof value !== "object" || value[RUNNER_CONSUMED_GRANT] !== true ||
      !CONSUMED_CLAIMS.has(value as object)) {
    throw grantError("grant_forged");
  }
  return value;
}

/** Rejects a consumed claim as soon as its ToolBroker-owned grant is revoked or expires. */
export function assertCurrentConsumedExecutionGrantClaims(
  value: ConsumedExecutionGrantClaims,
): ConsumedExecutionGrantClaims {
  assertRunnerConsumedExecutionGrantClaims(value);
  const record = CONSUMED_CLAIMS.get(value as object)!;
  if (record.state === "revoked") throw grantError("grant_revoked");
  if (Date.parse(record.claims.expiresAt) <= record.clock().getTime()) {
    record.state = "revoked";
    record.revocationReason = "expired";
    throw grantError("grant_expired");
  }
  return value;
}

async function canonicalizeAccess(
  workspace: string,
  requests: readonly ExecutionGrantAccessRequest[],
  externalApproved: boolean,
): Promise<readonly { canonicalPath: string; mode: ExactPathAccessMode }[]> {
  if (!Array.isArray(requests) || requests.length > 256) {
    throw new ExecutionGrantError("grant_invalid_path", "Execution grant access is invalid.");
  }
  const result: { canonicalPath: string; mode: ExactPathAccessMode }[] = [];
  const seen = new Set<string>();
  const modes = new Map<string, ExactPathAccessMode>();
  for (const request of requests) {
    if (!request || !["read", "write", "create"].includes(request.mode)) {
      throw new ExecutionGrantError("grant_invalid_path", "Execution grant access is invalid.");
    }
    const requested = isAbsolute(request.path)
      ? resolve(request.path)
      : resolve(workspace, request.path);
    const canonicalPath = await canonicalTarget(requested);
    if (!contained(workspace, canonicalPath) && !externalApproved) {
      throw new ExecutionGrantError(
        "grant_escalation",
        "Execution grant cannot authorize an unapproved external path.",
      );
    }
    const key = `${normalizePath(canonicalPath)}\0${request.mode}`;
    const destination = normalizePath(canonicalPath);
    const previous = modes.get(destination);
    if (previous && previous !== request.mode) {
      throw new ExecutionGrantError("grant_escalation", "Execution grant has conflicting access modes for one canonical root.");
    }
    modes.set(destination, request.mode);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(Object.freeze({ canonicalPath, mode: request.mode }));
    }
  }
  return Object.freeze(result);
}

async function canonicalExistingDirectory(input: string): Promise<string> {
  if (typeof input !== "string" || !input || !isAbsolute(input) || input.includes("\0")) {
    throw new ExecutionGrantError("grant_invalid_path", "Workspace path must be absolute.");
  }
  const candidate = resolve(input);
  const metadata = await lstat(candidate);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ExecutionGrantError("grant_invalid_path", "Workspace path must be a real directory.");
  }
  return resolve(await realpath(candidate));
}

async function canonicalTarget(target: string): Promise<string> {
  if (!target || target.includes("\0")) throw grantError("grant_invalid_path");
  let current = target;
  const missing: string[] = [];
  while (true) {
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new ExecutionGrantError("grant_invalid_path", "Grant roots cannot be symbolic links.");
      }
      return resolve(await realpath(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw grantError("grant_invalid_path");
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function cloneBinding(value: ExecutionGrantBinding): ExecutionGrantBinding {
  if (!["guarded", "project", "full"].includes(value.permissionProfile)) {
    throw grantError("grant_mismatch");
  }
  return deepFreeze({
    runId: safeText(value.runId),
    sessionId: safeText(value.sessionId),
    actor: { role: value.actor.role, id: safeText(value.actor.id) },
    toolName: safeText(value.toolName),
    callId: safeText(value.callId),
    permissionProfile: value.permissionProfile,
  });
}

function sameBinding(
  actual: ExecutionGrantBinding,
  expected: ExecutionGrantBinding,
): boolean {
  return actual.runId === expected.runId &&
    actual.sessionId === expected.sessionId &&
    actual.actor.role === expected.actor.role &&
    actual.actor.id === expected.actor.id &&
    actual.toolName === expected.toolName &&
    actual.callId === expected.callId &&
    actual.permissionProfile === expected.permissionProfile;
}

function trustedRecord(
  grant: OpaqueExecutionGrant,
  authority: object,
  required = true,
): GrantRecord | undefined {
  if (!grant || typeof grant !== "object") {
    if (required) throw grantError("grant_forged");
    return undefined;
  }
  const record = GRANTS.get(grant as object);
  if (!record || record.authority !== authority) {
    if (required) throw grantError("grant_forged");
    return undefined;
  }
  return record;
}

function cloneClaims(
  value: ConsumedExecutionGrantClaims,
  brand = false,
): ConsumedExecutionGrantClaims {
  const clone = {
    ...value,
    actor: { ...value.actor },
    access: value.access.map((entry) => ({ ...entry })),
    credentialNames: [...value.credentialNames],
  } as ConsumedExecutionGrantClaims;
  if (brand) {
    Object.defineProperty(clone, RUNNER_CONSUMED_GRANT, { value: true });
  }
  return deepFreeze(clone);
}

function safeText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > 512) {
    throw grantError("grant_mismatch");
  }
  return value;
}

function contained(root: string, candidate: string): boolean {
  const traversal = relative(root, candidate);
  return traversal === "" || (!traversal.startsWith("..") && !isAbsolute(traversal));
}

function normalizePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function grantError(code: ExecutionGrantErrorCode): ExecutionGrantError {
  return new ExecutionGrantError(code, `Execution grant rejected: ${code}.`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
