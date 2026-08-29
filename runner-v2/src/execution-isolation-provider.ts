import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import type { PermissionProfile } from "./contracts.js";
import type {
  ExecutionInvocationIntent,
  ExecutionSafetyCapabilities,
} from "./execution-safety-contracts.js";
import {
  assertRunnerConsumedExecutionGrantClaims,
  registerConsumedExecutionGrantRevoker,
  reserveConsumedExecutionGrantForIsolation,
  type ConsumedExecutionGrantClaims,
} from "./execution-grants.js";

export type ExecutionIsolationErrorCode =
  | "isolation_capability_unavailable"
  | "isolation_attestation_invalid"
  | "isolation_grant_mismatch"
  | "isolation_lease_invalid"
  | "isolation_revocation_failed"
  | "isolation_recovery_blocked";

export class ExecutionIsolationError extends Error {
  constructor(
    readonly code: ExecutionIsolationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExecutionIsolationError";
  }
}

export interface ExecutionIsolationAttestation {
  readonly attestationVersion: 1;
  readonly providerId: string;
  readonly verified: boolean;
  readonly mechanism: string;
  readonly implementationDigest?: string;
  readonly exactGrantWriteConfinement: boolean;
  readonly expiresAt?: string;
  readonly executableIdentity?: Readonly<{ path: string; digest: string }>;
  readonly imageIdentity?: Readonly<{
    configuredReference: string;
    immutableId: string;
  }>;
  readonly capabilities: ExecutionSafetyCapabilities;
}

export interface ExecutionIsolationLease {
  readonly leaseId: string;
  readonly providerId: string;
  readonly invocationId: string;
  readonly grantId: string;
  readonly grantedAccess: ConsumedExecutionGrantClaims["access"];
  readonly acquiredAt: string;
  readonly expiresAt?: string;
  readonly state: "active" | "released" | "revocation_failed";
  readonly providerIdentity: string;
  readonly immutableImageId?: string;
}

export interface ExecutionIsolationAcquireRequest {
  readonly providerId: string;
  readonly implementationDigest: string;
  readonly intent: ExecutionInvocationIntent;
  readonly grant: ConsumedExecutionGrantClaims;
}

export interface ExecutionIsolationRecoveryResult {
  readonly cleaned: number;
  readonly blockers: readonly string[];
  readonly transitions?: readonly ExecutionIsolationCleanupTransition[];
}

export interface ExecutionIsolationCleanupTransition {
  readonly status: "cleaned" | "blocked";
  readonly runId: string;
  readonly invocationId: string;
  readonly grantId: string;
  readonly leaseId: string;
  readonly providerId: string;
  readonly implementationDigest: string;
  readonly immutableImageId?: string;
  readonly access: ConsumedExecutionGrantClaims["access"];
  readonly blocker?: string;
  readonly cleanupToken?: string;
  readonly cleanedAt?: string;
}

export interface ExecutionIsolationProvider {
  attest(): Promise<unknown>;
  acquire(request: ExecutionIsolationAcquireRequest): Promise<unknown>;
  release(lease: ExecutionIsolationLease): Promise<void>;
  recoverOwned(): Promise<ExecutionIsolationRecoveryResult>;
  acknowledgeRecovery(transitions: readonly ExecutionIsolationCleanupTransition[]): Promise<void>;
}

export interface ExecutionIsolationProviderRegistrationInput {
  readonly stableProviderId: string;
  readonly codeDigest: string;
  readonly configDigest: string;
  readonly provider: ExecutionIsolationProvider;
}

export interface ExecutionIsolationProviderRegistration {
  readonly kind: "runner-execution-isolation-provider-registration";
}

export interface ExecutionIsolationRegistry {
  readonly kind: "runner-execution-isolation-registry";
}

export type ExecutionIsolationSelection =
  | {
      readonly enforcement: "unconfined_explicit_full";
      readonly disclosure: "unconfined_explicit_full";
    }
  | {
      readonly enforcement: "write_confinement_exact_grant";
      readonly disclosure: "provider_specific_not_universal_boundary";
      readonly providerId: string;
      readonly implementationDigest: string;
      readonly attestation: ExecutionIsolationAttestation;
      readonly lease: ExecutionIsolationLease;
    };

export interface ExecutionIsolationSelector {
  acquire(input: {
    permissionProfile: PermissionProfile;
    intent: ExecutionInvocationIntent;
    grant: ConsumedExecutionGrantClaims;
  }): Promise<ExecutionIsolationSelection>;
  release(selection: ExecutionIsolationSelection): Promise<void>;
  recoverOwnedLeases(): Promise<readonly {
    providerId: string;
    cleaned: number;
    blockers: readonly string[];
  }[]>;
  activeLeases(): readonly ExecutionIsolationLease[];
  enforcementState(): Promise<ExecutionEnforcementState>;
}

export interface ExecutionEnforcementRecord {
  readonly occurredAt: string;
  readonly runId: string;
  readonly invocationId: string;
  readonly grantId: string;
  readonly status: "active" | "revoked" | "blocked" | "selection_blocked" | "unconfined_explicit_full" | "cleaned";
  readonly enforcement: "unconfined_explicit_full" | "write_confinement_exact_grant";
  readonly disclosure: "unconfined_explicit_full" | "provider_specific_not_universal_boundary";
  readonly providerId?: string;
  readonly implementationDigest?: string;
  readonly immutableImageId?: string;
  readonly leaseId?: string;
  readonly access: ConsumedExecutionGrantClaims["access"];
  readonly blocker?: string;
  readonly recoveryOperationId?: string;
}

export interface ExecutionEnforcementState {
  readonly version: 1;
  readonly boundary: "provider_specific_not_universal_security_boundary";
  readonly records: readonly ExecutionEnforcementRecord[];
  readonly recoverySummaries?: readonly Readonly<{
    occurredAt: string; providerId: string; cleanedCount: number; blockerCount: number;
    blockers: readonly string[]; operationId?: string; leaseIds?: readonly string[];
  }>[];
}

const MAX_ENFORCEMENT_STATE_BYTES = 1024 * 1024;
const MAX_ENFORCEMENT_RECORDS = 1_000;
const MAX_ENFORCEMENT_ACCESS = 256;
const MAX_RECOVERY_SUMMARIES = 256;

interface TrustedProvider {
  readonly providerId: string;
  readonly implementationDigest: string;
  readonly provider: ExecutionIsolationProvider;
}

const REGISTRATIONS = new WeakSet<object>();
const REGISTRATION_VALUES = new WeakMap<object, TrustedProvider>();
const REGISTRIES = new WeakSet<object>();
const REGISTRY_VALUES = new WeakMap<object, readonly TrustedProvider[]>();

export function createExecutionIsolationProviderRegistration(
  input: ExecutionIsolationProviderRegistrationInput,
): ExecutionIsolationProviderRegistration {
  const providerId = safeId(input.stableProviderId);
  const codeDigest = safeDigest(input.codeDigest);
  const configDigest = safeDigest(input.configDigest);
  if (!input.provider || typeof input.provider !== "object") throw unavailable();
  const implementationDigest = createHash("sha256")
    .update(`${providerId}\0${codeDigest}\0${configDigest}`)
    .digest("hex");
  const source = input.provider;
  const provider = Object.freeze({
    attest: source.attest.bind(source),
    acquire: source.acquire.bind(source),
    release: source.release.bind(source),
    recoverOwned: source.recoverOwned.bind(source),
    acknowledgeRecovery: source.acknowledgeRecovery.bind(source),
  });
  const registration = Object.freeze({
    kind: "runner-execution-isolation-provider-registration" as const,
  });
  REGISTRATIONS.add(registration);
  REGISTRATION_VALUES.set(registration, { providerId, implementationDigest, provider });
  return registration;
}

export function createExecutionIsolationRegistry(
  registrations: readonly ExecutionIsolationProviderRegistration[],
): ExecutionIsolationRegistry {
  const ids = new Set<string>();
  const values = registrations.map((registration) => {
    if (!registration || !REGISTRATIONS.has(registration)) {
      throw new Error("Execution isolation provider registration authority is invalid.");
    }
    const value = REGISTRATION_VALUES.get(registration)!;
    if (ids.has(value.providerId)) throw new Error(`Duplicate isolation provider ${value.providerId}.`);
    ids.add(value.providerId);
    return value;
  });
  const registry = Object.freeze({ kind: "runner-execution-isolation-registry" as const });
  REGISTRIES.add(registry);
  REGISTRY_VALUES.set(registry, Object.freeze(values));
  return registry;
}

export function createExecutionIsolationSelector(
  registry: ExecutionIsolationRegistry,
  options: { readonly clock?: () => Date; readonly statePath?: string } = {},
): ExecutionIsolationSelector {
  if (!registry || !REGISTRIES.has(registry)) {
    throw new Error("Execution isolation registry authority is invalid.");
  }
  const providers = REGISTRY_VALUES.get(registry)!;
  const clock = options.clock ?? (() => new Date());
  if (options.statePath && !isAbsolute(options.statePath)) throw new Error("Enforcement state path must be absolute.");
  const persist = async (record: ExecutionEnforcementRecord) => {
    if (!options.statePath) return;
    await appendEnforcementRecord(options.statePath, record);
  };
  const active = new Map<string, {
    provider: TrustedProvider;
    selection: Extract<ExecutionIsolationSelection, { lease: unknown }>;
    runId: string;
    disposeRevoker?: () => void;
    visibleLease?: ExecutionIsolationLease;
    providerCleaned?: Readonly<{ status: "revoked" | "blocked"; blocker: string }>;
  }>();
  const terminalOperations = new WeakMap<object, Promise<void>>();

  const cleanupLease = (
    selection: Extract<ExecutionIsolationSelection, { lease: unknown }>,
    terminalStatus: "revoked" | "blocked",
    blocker: string,
  ): Promise<void> => {
    const existing = terminalOperations.get(selection as object);
    if (existing) return existing;
    const owned = active.get(selection.lease.leaseId);
    if (!owned || owned.selection !== selection) return Promise.reject(new ExecutionIsolationError(
      "isolation_lease_invalid", "Isolation lease is not owned by this Runner selector."));
    const operation = (async () => {
      if (!owned.providerCleaned) {
        try {
          await owned.provider.provider.release(selection.lease);
          owned.providerCleaned = Object.freeze({ status: terminalStatus, blocker });
          owned.visibleLease = deepFreeze({ ...selection.lease, state: "released" as const });
        } catch (error) {
          owned.visibleLease = deepFreeze({ ...selection.lease, state: "revocation_failed" as const });
          await persist({ ...enforcementRecord({ ...selection, lease: owned.visibleLease }, owned.runId, "blocked", clock()), blocker });
          throw new ExecutionIsolationError("isolation_revocation_failed", "Isolation lease revocation failed.", { cause: error });
        }
      }
      try {
        await persist(enforcementRecord(selection, owned.runId, owned.providerCleaned.status, clock()));
      } catch (error) {
        throw new ExecutionIsolationError("isolation_recovery_blocked", "Released isolation lease terminal evidence could not be persisted.", { cause: error });
      }
      active.delete(selection.lease.leaseId);
      owned.disposeRevoker?.();
    })();
    terminalOperations.set(selection as object, operation);
    void operation.catch(() => {
      if (terminalOperations.get(selection as object) === operation) terminalOperations.delete(selection as object);
    });
    return operation;
  };

  return Object.freeze({
    async acquire(input: {
      permissionProfile: PermissionProfile;
      intent: ExecutionInvocationIntent;
      grant: ConsumedExecutionGrantClaims;
    }): Promise<ExecutionIsolationSelection> {
      assertRunnerConsumedExecutionGrantClaims(input.grant);
      assertGrantMatches(input.intent, input.grant, input.permissionProfile, clock());
      if (input.permissionProfile === "full") {
        reserveGrant(input.grant);
        await persist({
          occurredAt: clock().toISOString(), runId: input.intent.runId,
          invocationId: input.intent.invocationId, grantId: input.grant.grantId,
          status: "unconfined_explicit_full", enforcement: "unconfined_explicit_full",
          disclosure: "unconfined_explicit_full", access: input.grant.access,
        });
        return Object.freeze({
          enforcement: "unconfined_explicit_full" as const,
          disclosure: "unconfined_explicit_full" as const,
        });
      }
      for (const provider of providers) {
        let attestation: ExecutionIsolationAttestation;
        try {
          attestation = parseAttestation(await provider.provider.attest());
        } catch {
          continue;
        }
        if (!qualifies(attestation, provider, clock())) continue;
        reserveGrant(input.grant);
        let lease: ExecutionIsolationLease;
        try {
          lease = parseAndValidateLease(
            await provider.provider.acquire({
              providerId: provider.providerId,
              implementationDigest: provider.implementationDigest,
              intent: input.intent,
              grant: input.grant,
            }),
            provider,
            input.intent,
            input.grant,
          );
        } catch (error) {
          throw new ExecutionIsolationError(
            "isolation_lease_invalid",
            "Isolation provider did not return an exact owned lease.",
            { cause: error },
          );
        }
        const selection = deepFreeze({
          enforcement: "write_confinement_exact_grant" as const,
          disclosure: "provider_specific_not_universal_boundary" as const,
          providerId: provider.providerId,
          implementationDigest: provider.implementationDigest,
          attestation: { ...attestation, providerId: provider.providerId },
          lease,
        });
        active.set(lease.leaseId, { provider, selection, runId: input.intent.runId });
        const registration = await registerConsumedExecutionGrantRevoker(input.grant, async () =>
          cleanupLease(selection, "revoked", "Authority revocation could not release the isolation lease."));
        const owned = active.get(lease.leaseId);
        if (owned) owned.disposeRevoker = registration.dispose;
        if (!registration.registered) {
          throw new ExecutionIsolationError("isolation_grant_mismatch", "Isolation grant was revoked during provider acquisition.");
        }
        try {
          await persist({
            occurredAt: clock().toISOString(), runId: input.intent.runId,
            invocationId: input.intent.invocationId, grantId: input.grant.grantId,
            status: "active", enforcement: "write_confinement_exact_grant",
            disclosure: "provider_specific_not_universal_boundary", providerId: provider.providerId,
            implementationDigest: provider.implementationDigest,
            ...(lease.immutableImageId ? { immutableImageId: lease.immutableImageId } : {}),
            leaseId: lease.leaseId, access: input.grant.access,
          });
        } catch (error) {
          await cleanupLease(selection, "blocked", "Isolation lease cleanup after projection failure failed.");
          throw error;
        }
        return selection;
      }
      await persist({
        occurredAt: clock().toISOString(), runId: input.intent.runId, invocationId: input.intent.invocationId,
        grantId: input.grant.grantId, status: "selection_blocked", enforcement: "write_confinement_exact_grant",
        disclosure: "provider_specific_not_universal_boundary", access: input.grant.access,
        blocker: "No verified provider enforces exact-grant write confinement.",
      });
      throw unavailable();
    },

    async release(selection: ExecutionIsolationSelection): Promise<void> {
      if (selection.enforcement === "unconfined_explicit_full") return;
      await cleanupLease(selection, "revoked", "Isolation lease revocation failed.");
    },

    async recoverOwnedLeases() {
      const results: { providerId: string; cleaned: number; blockers: readonly string[] }[] = [];
      for (const provider of providers) {
        try {
          const result = validateRecoveryResult(await provider.provider.recoverOwned(), provider);
          const blockers = Object.freeze([...result.blockers]);
          await persistRecovery(options.statePath, provider.providerId, result, clock());
          const cleanedTransitions = (result.transitions ?? []).filter((transition) => transition.status === "cleaned");
          await provider.provider.acknowledgeRecovery(cleanedTransitions);
          for (const transition of cleanedTransitions) {
            const owned = active.get(transition.leaseId);
            if (owned?.provider.providerId === provider.providerId) {
              owned.disposeRevoker?.();
              active.delete(transition.leaseId);
            }
          }
          results.push(Object.freeze({ providerId: provider.providerId, cleaned: result.cleaned, blockers }));
        } catch (error) {
          results.push(Object.freeze({
            providerId: provider.providerId,
            cleaned: 0,
            blockers: Object.freeze([boundedError(error)]),
          }));
        }
      }
      return Object.freeze(results);
    },

    activeLeases(): readonly ExecutionIsolationLease[] {
      return Object.freeze([...active.values()].map(({ selection, visibleLease }) => {
        const lease = visibleLease ?? selection.lease;
        return deepFreeze({ ...lease, grantedAccess: lease.grantedAccess.map((x) => ({ ...x })) });
      }));
    },

    async enforcementState(): Promise<ExecutionEnforcementState> {
      return options.statePath ? await readExecutionEnforcementState(options.statePath) : emptyEnforcementState();
    },
  });
}

function validateRecoveryResult(
  value: ExecutionIsolationRecoveryResult,
  provider: TrustedProvider,
): ExecutionIsolationRecoveryResult {
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.cleaned) || value.cleaned < 0 ||
      value.cleaned > MAX_ENFORCEMENT_RECORDS || !Array.isArray(value.blockers) || value.blockers.length > 64 ||
      !Array.isArray(value.transitions) || value.transitions.length > MAX_ENFORCEMENT_RECORDS) {
    throw new ExecutionIsolationError("isolation_recovery_blocked", "Isolation provider returned an invalid recovery contract.");
  }
  const blockers = value.blockers.map(safeText);
  const seen = new Set<string>();
  const transitions = value.transitions.map((transition) => {
    if (!transition || typeof transition !== "object" || !["cleaned", "blocked"].includes(transition.status) ||
        transition.providerId !== provider.providerId || transition.implementationDigest !== provider.implementationDigest ||
        seen.has(transition.leaseId) || !Array.isArray(transition.access) || transition.access.length > MAX_ENFORCEMENT_ACCESS) {
      throw new ExecutionIsolationError("isolation_recovery_blocked", "Isolation provider returned contradictory recovery identities.");
    }
    seen.add(transition.leaseId);
    const record = parseEnforcementState({ version: 1, boundary: "provider_specific_not_universal_security_boundary", records: [{
      occurredAt: new Date(0).toISOString(), runId: transition.runId, invocationId: transition.invocationId,
      grantId: transition.grantId, status: transition.status, enforcement: "write_confinement_exact_grant",
      disclosure: "provider_specific_not_universal_boundary", providerId: transition.providerId,
      implementationDigest: transition.implementationDigest, ...(transition.immutableImageId ? { immutableImageId: transition.immutableImageId } : {}),
      leaseId: transition.leaseId, access: transition.access, ...(transition.blocker ? { blocker: transition.blocker } : {}),
    }] }).records[0]!;
    if ((transition.status === "blocked") !== Boolean(transition.blocker)) {
      throw new ExecutionIsolationError("isolation_recovery_blocked", "Isolation recovery blocker status is inconsistent.");
    }
    if (transition.status === "cleaned") {
      if (!transition.cleanupToken || !transition.cleanedAt || !Number.isFinite(Date.parse(transition.cleanedAt)) ||
          new Date(transition.cleanedAt).toISOString() !== transition.cleanedAt) throw new ExecutionIsolationError(
        "isolation_recovery_blocked", "Cleaned recovery descriptor lacks its durable acknowledgement identity.");
      safeText(transition.cleanupToken);
    } else if (transition.cleanupToken !== undefined || transition.cleanedAt !== undefined) throw new ExecutionIsolationError(
      "isolation_recovery_blocked", "Blocked recovery descriptor cannot carry cleanup acknowledgement identity.");
    return deepFreeze({ ...transition, access: record.access });
  });
  if (transitions.filter((item) => item.status === "cleaned").length !== value.cleaned) {
    throw new ExecutionIsolationError("isolation_recovery_blocked", "Isolation recovery cleaned count lacks exact descriptors.");
  }
  const transitionBlockers = transitions.filter((item) => item.status === "blocked").map((item) => item.blocker!).sort();
  if (transitionBlockers.length !== blockers.length || transitionBlockers.some((item, index) => item !== [...blockers].sort()[index])) {
    throw new ExecutionIsolationError("isolation_recovery_blocked", "Isolation recovery blockers lack exact blocked descriptors.");
  }
  return deepFreeze({ cleaned: value.cleaned, blockers, transitions });
}

const STATE_WRITES = new Map<string, Promise<void>>();

export async function readExecutionEnforcementState(path: string): Promise<ExecutionEnforcementState> {
  try {
    const value = JSON.parse(await readBoundedState(path)) as unknown;
    return parseEnforcementState(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyEnforcementState();
    throw new ExecutionIsolationError("isolation_recovery_blocked", "Durable enforcement state is unreadable.", { cause: error });
  }
}

function parseEnforcementState(value: unknown): ExecutionEnforcementState {
  const object = exactObject(value, new Set(["version", "boundary", "records", "recoverySummaries"]));
  if (object.version !== 1 || object.boundary !== "provider_specific_not_universal_security_boundary" || !Array.isArray(object.records)) throw new Error();
  if (object.records.length > MAX_ENFORCEMENT_RECORDS) throw new Error();
  const statuses = new Set(["active", "revoked", "blocked", "selection_blocked", "unconfined_explicit_full", "cleaned"]);
  const enforcement = new Set(["unconfined_explicit_full", "write_confinement_exact_grant"]);
  const disclosure = new Set(["unconfined_explicit_full", "provider_specific_not_universal_boundary"]);
  const records = object.records.map((entry) => {
    const record = exactObject(entry, new Set([
      "occurredAt", "runId", "invocationId", "grantId", "status", "enforcement", "disclosure",
      "providerId", "implementationDigest", "immutableImageId", "leaseId", "access", "blocker", "recoveryOperationId",
    ]));
    if (!statuses.has(record.status as string) || !enforcement.has(record.enforcement as string) ||
        !disclosure.has(record.disclosure as string) || !Array.isArray(record.access) ||
        record.access.length > MAX_ENFORCEMENT_ACCESS) throw new Error();
    for (const key of ["occurredAt", "runId", "invocationId", "grantId"] as const) safeText(record[key]);
    if (!Number.isFinite(Date.parse(record.occurredAt as string))) throw new Error();
    for (const key of ["providerId", "implementationDigest", "immutableImageId", "leaseId", "blocker", "recoveryOperationId"] as const) {
      if (record[key] !== undefined) safeText(record[key]);
    }
    if (record.implementationDigest !== undefined) safeDigest(record.implementationDigest);
    if (record.immutableImageId !== undefined) parseImmutableImageId(record.immutableImageId);
    if (record.recoveryOperationId !== undefined) safeDigest(record.recoveryOperationId);
    const accessKeys = new Set<string>();
    const access = record.access.map((item) => {
      const accessEntry = exactObject(item, new Set(["canonicalPath", "mode"]));
      if (!["read", "write", "create"].includes(accessEntry.mode as string)) throw new Error();
      const canonicalPath = boundedProjectionText(accessEntry.canonicalPath, 4_096);
      if (!isAbsolute(canonicalPath) || resolve(canonicalPath) !== canonicalPath) throw new Error();
      const pathKey = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
      if (accessKeys.has(pathKey)) throw new Error();
      accessKeys.add(pathKey);
      return { canonicalPath, mode: accessEntry.mode as "read" | "write" | "create" };
    });
    const full = record.status === "unconfined_explicit_full";
    const historicalSelectionBlocked = record.status === "blocked" &&
      [record.providerId, record.implementationDigest, record.immutableImageId, record.leaseId].every((field) => field === undefined);
    const normalizedStatus = historicalSelectionBlocked ? "selection_blocked" : record.status;
    if (full !== (record.enforcement === "unconfined_explicit_full" && record.disclosure === "unconfined_explicit_full") ||
        (full && [record.providerId, record.implementationDigest, record.immutableImageId, record.leaseId, record.blocker, record.recoveryOperationId].some((field) => field !== undefined)) ||
        (!full && (record.enforcement !== "write_confinement_exact_grant" || record.disclosure !== "provider_specific_not_universal_boundary")) ||
        ((normalizedStatus === "blocked" || normalizedStatus === "selection_blocked") !== Boolean(record.blocker)) ||
        (["active", "revoked", "blocked", "cleaned"].includes(normalizedStatus as string) &&
          (!record.providerId || !record.implementationDigest || !record.leaseId)) ||
        (record.recoveryOperationId !== undefined && !["cleaned", "blocked"].includes(normalizedStatus as string))) throw new Error();
    if (normalizedStatus === "selection_blocked" && [record.providerId, record.implementationDigest, record.immutableImageId, record.leaseId].some((field) => field !== undefined)) throw new Error();
    return { ...record, status: normalizedStatus, access } as unknown as ExecutionEnforcementRecord;
  });
  const recoverySummaries = object.recoverySummaries === undefined ? undefined : parseRecoverySummaries(object.recoverySummaries);
  const terminalKeys = new Set<string>();
  const activeByLease = new Map(records.filter((record) => record.status === "active" && record.leaseId).map((record) => [record.leaseId!, record]));
  for (const record of records.filter((item) => item.status === "cleaned" || item.status === "blocked")) {
    if (!record.leaseId) continue;
    const key = `${record.occurredAt}\0${record.providerId ?? ""}\0${record.leaseId}\0${record.status}`;
    if (terminalKeys.has(key)) throw new Error();
    terminalKeys.add(key);
    const original = activeByLease.get(record.leaseId);
    if (original && (record.providerId !== original.providerId || record.implementationDigest !== original.implementationDigest ||
        record.grantId !== original.grantId || record.immutableImageId !== original.immutableImageId ||
        JSON.stringify(record.access) !== JSON.stringify(original.access))) throw new Error();
  }
  for (const summary of recoverySummaries ?? []) {
    const related = records.filter((record) => record.occurredAt === summary.occurredAt && record.providerId === summary.providerId &&
      (record.status === "cleaned" || record.status === "blocked") &&
      (summary.operationId ? record.recoveryOperationId === summary.operationId : record.recoveryOperationId === undefined));
    if (related.filter((record) => record.status === "cleaned").length !== summary.cleanedCount ||
        summary.blockers.length !== summary.blockerCount ||
        related.filter((record) => record.status === "blocked" && record.leaseId).length !== summary.blockerCount ||
        (summary.leaseIds && (summary.leaseIds.length !== related.filter((record) => record.leaseId).length ||
          summary.leaseIds.some((leaseId) => !related.some((record) => record.leaseId === leaseId)))) ||
        (summary.operationId && summary.operationId !== recoveryOperationId(summary.providerId, summary.occurredAt,
          summary.leaseIds ?? [], summary.cleanedCount, summary.blockerCount))) throw new Error();
  }
  return deepFreeze({ version: 1, boundary: "provider_specific_not_universal_security_boundary", records,
    ...(recoverySummaries ? { recoverySummaries } : {}) });
}

async function readBoundedState(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (stat.size > MAX_ENFORCEMENT_STATE_BYTES) throw new Error("enforcement state exceeds byte bound");
    // Always probe through the byte limit so a file that grows after stat cannot
    // be accepted from a valid-looking prefix.
    const buffer = Buffer.alloc(MAX_ENFORCEMENT_STATE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_ENFORCEMENT_STATE_BYTES) throw new Error("enforcement state exceeds byte bound");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

function parseRecoverySummaries(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_RECOVERY_SUMMARIES) throw new Error();
  return value.map((entry) => {
    const summary = exactObject(entry, new Set(["occurredAt", "providerId", "cleanedCount", "blockerCount", "blockers", "operationId", "leaseIds"]));
    if (!Number.isSafeInteger(summary.cleanedCount) || (summary.cleanedCount as number) < 0 ||
        !Number.isSafeInteger(summary.blockerCount) || (summary.blockerCount as number) < 0 ||
        (summary.cleanedCount as number) > MAX_ENFORCEMENT_RECORDS || (summary.blockerCount as number) > 64 ||
        !Array.isArray(summary.blockers) || summary.blockers.length > 64 ||
        (summary.operationId === undefined) !== (summary.leaseIds === undefined) ||
        (summary.leaseIds !== undefined && (!Array.isArray(summary.leaseIds) || summary.leaseIds.length > MAX_ENFORCEMENT_RECORDS))) throw new Error();
    const occurredAt = safeText(summary.occurredAt); if (!Number.isFinite(Date.parse(occurredAt))) throw new Error();
    const leaseIds = summary.leaseIds === undefined ? undefined : (summary.leaseIds as unknown[]).map(safeText);
    if (leaseIds && new Set(leaseIds).size !== leaseIds.length) throw new Error();
    return { occurredAt, providerId: safeText(summary.providerId), cleanedCount: summary.cleanedCount as number,
      blockerCount: summary.blockerCount as number, blockers: summary.blockers.map(safeText),
      ...(summary.operationId === undefined ? {} : { operationId: safeDigest(summary.operationId),
        leaseIds }) };
  });
}

function boundedProjectionText(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > maxLength) throw new Error();
  return value;
}

function emptyEnforcementState(): ExecutionEnforcementState {
  return deepFreeze({ version: 1 as const, boundary: "provider_specific_not_universal_security_boundary" as const, records: [] });
}

async function appendEnforcementRecord(path: string, record: ExecutionEnforcementRecord): Promise<void> {
  const validated = parseEnforcementState({
    version: 1, boundary: "provider_specific_not_universal_security_boundary", records: [record],
  }).records[0]!;
  const previous = STATE_WRITES.get(path) ?? Promise.resolve();
  const next = previous.then(async () => {
    await withProjectionLock(path, async () => {
      const state = await readExecutionEnforcementState(path);
      const updated = { ...state, records: [...state.records, structuredClone(validated)] };
      await mkdir(dirname(path), { recursive: true });
      await writeBoundedEnforcementState(path, updated);
    });
  });
  STATE_WRITES.set(path, next.catch(() => undefined));
  await next;
}

async function withProjectionLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 10_000;
  while (true) {
    try { await mkdir(lockPath); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) {
        throw new ExecutionIsolationError("isolation_recovery_blocked", "Enforcement state lock is unavailable.", { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try { return await action(); }
  finally { await rm(lockPath, { recursive: true, force: true }); }
}

function enforcementRecord(
  selection: Extract<ExecutionIsolationSelection, { lease: unknown }>,
  runId: string,
  status: ExecutionEnforcementRecord["status"],
  now: Date,
): ExecutionEnforcementRecord {
  return {
    occurredAt: now.toISOString(), runId,
    invocationId: selection.lease.invocationId, grantId: selection.lease.grantId,
    status, enforcement: selection.enforcement, disclosure: selection.disclosure,
    providerId: selection.providerId, implementationDigest: selection.implementationDigest,
    ...(selection.lease.immutableImageId ? { immutableImageId: selection.lease.immutableImageId } : {}),
    leaseId: selection.lease.leaseId, access: selection.lease.grantedAccess,
  };
}

async function persistRecovery(
  statePath: string | undefined, providerId: string, result: ExecutionIsolationRecoveryResult, now: Date,
): Promise<void> {
  if (!statePath) {
    if (result.cleaned > 0) throw new ExecutionIsolationError("isolation_recovery_blocked", "Cleaned isolation evidence requires durable projection state.");
    return;
  }
  if (result.blockers.length === 0 && result.cleaned === 0) return;
  if ((result.transitions?.length ?? 0) > MAX_ENFORCEMENT_RECORDS || result.blockers.length > 64) {
    throw new ExecutionIsolationError("isolation_recovery_blocked", "Recovery projection exceeds its bounded shape.");
  }
  const occurredAt = (result.transitions ?? []).filter((item) => item.status === "cleaned")
    .map((item) => item.cleanedAt!).sort()[0] ?? now.toISOString();
  const operationId = recoveryOperationId(providerId, occurredAt, (result.transitions ?? []).map((item) => item.leaseId), result.cleaned, result.blockers.length);
  const records = (result.transitions ?? []).map((transition): ExecutionEnforcementRecord => {
    if (transition.providerId !== providerId) throw new ExecutionIsolationError(
      "isolation_recovery_blocked", "Recovery transition provider identity is invalid.");
    return {
      occurredAt, runId: transition.runId,
      invocationId: transition.invocationId, grantId: transition.grantId,
      status: transition.status, enforcement: "write_confinement_exact_grant",
      disclosure: "provider_specific_not_universal_boundary", providerId,
      implementationDigest: transition.implementationDigest,
      ...(transition.immutableImageId ? { immutableImageId: transition.immutableImageId } : {}),
      leaseId: transition.leaseId, access: transition.access,
      recoveryOperationId: operationId,
      ...(transition.blocker ? { blocker: transition.blocker } : {}),
    };
  });
  await appendRecoveryOperation(statePath, records, {
    occurredAt, providerId, cleanedCount: result.cleaned,
    blockerCount: result.blockers.length, blockers: result.blockers.slice(0, 64).map((value) => value.slice(0, 512)),
    operationId,
    leaseIds: (result.transitions ?? []).map((item) => item.leaseId),
  });
}

function recoveryOperationId(providerId: string, occurredAt: string, leaseIds: readonly string[], cleaned: number, blockers: number): string {
  return createHash("sha256").update(JSON.stringify({ providerId, occurredAt, leaseIds: [...leaseIds].sort(), cleaned, blockers })).digest("hex");
}

async function appendRecoveryOperation(
  path: string,
  records: readonly ExecutionEnforcementRecord[],
  summary: NonNullable<ExecutionEnforcementState["recoverySummaries"]>[number],
): Promise<void> {
  const validated = parseRecoverySummaries([summary])[0]!;
  const previous = STATE_WRITES.get(path) ?? Promise.resolve();
  const next = previous.then(async () => {
    await withProjectionLock(path, async () => {
      const state = await readExecutionEnforcementState(path);
      if (state.recoverySummaries?.some((entry) => entry.operationId === validated.operationId)) return;
      const updated = { ...state, records: [...state.records, ...records.map((record) => structuredClone(record))],
        recoverySummaries: [...(state.recoverySummaries ?? []), structuredClone(validated)] };
      await writeBoundedEnforcementState(path, updated, validated.operationId);
    });
  });
  STATE_WRITES.set(path, next.catch(() => undefined));
  await next;
}

async function writeBoundedEnforcementState(
  path: string,
  state: ExecutionEnforcementState,
  protectedRecoveryOperationId?: string,
): Promise<void> {
  const records = [...state.records];
  const summaries = [...(state.recoverySummaries ?? [])];
  let serialized = "";
  while (true) {
    serialized = JSON.stringify({ ...state, records,
      ...(summaries.length > 0 ? { recoverySummaries: summaries } : { recoverySummaries: undefined }) });
    if (records.length <= MAX_ENFORCEMENT_RECORDS && summaries.length <= MAX_RECOVERY_SUMMARIES &&
        Buffer.byteLength(serialized) <= MAX_ENFORCEMENT_STATE_BYTES) break;
    if (protectedRecoveryOperationId) {
      if (!evictSafeIndependentEnforcementRecord(records, summaries, protectedRecoveryOperationId)) {
        throw new ExecutionIsolationError(
          "isolation_recovery_blocked",
          "The complete newly recovered isolation operation exceeds the durable projection capacity.",
        );
      }
      continue;
    }
    const oldest = records[0];
    const group = oldest?.leaseId ? summaries.find((summary) => summary.occurredAt === oldest.occurredAt &&
      summary.providerId === oldest.providerId && summary.leaseIds?.includes(oldest.leaseId!) &&
      (oldest.recoveryOperationId ? summary.operationId === oldest.recoveryOperationId : summary.operationId === undefined)) : undefined;
    if (group) {
      const leaseIds = new Set(group.leaseIds);
      summaries.splice(summaries.indexOf(group), 1);
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index]!;
        if (record.occurredAt === group.occurredAt && record.providerId === group.providerId && record.leaseId && leaseIds.has(record.leaseId) &&
            (group.operationId ? record.recoveryOperationId === group.operationId : record.recoveryOperationId === undefined)) records.splice(index, 1);
      }
    } else if (records.length > 1) records.shift();
    else if (summaries.length > 0) {
      const summary = summaries.shift()!;
      const leaseIds = new Set(summary.leaseIds ?? []);
      for (let index = records.length - 1; index >= 0; index -= 1) if (records[index]!.leaseId && leaseIds.has(records[index]!.leaseId!)) records.splice(index, 1);
    }
    else throw new ExecutionIsolationError("isolation_recovery_blocked", "One enforcement record exceeds the durable projection bound.");
  }
  parseEnforcementState(JSON.parse(serialized));
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try { await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

function evictSafeIndependentEnforcementRecord(
  records: ExecutionEnforcementRecord[],
  summaries: NonNullable<ExecutionEnforcementState["recoverySummaries"]>[number][],
  protectedRecoveryOperationId: string,
): boolean {
  const groupedLeaseIds = new Set<string>();
  for (const summary of summaries) {
    for (const leaseId of summary.leaseIds ?? []) groupedLeaseIds.add(leaseId);
  }
  const independent = records.findIndex((record) =>
    record.recoveryOperationId !== protectedRecoveryOperationId &&
    !groupedLeaseIds.has(record.leaseId ?? "") &&
    record.status !== "active",
  );
  if (independent < 0) return false;
  records.splice(independent, 1);
  return true;
}

function parseAttestation(value: unknown): ExecutionIsolationAttestation {
  const input = exactObject(value, new Set([
    "attestationVersion", "providerId", "verified", "mechanism",
    "implementationDigest", "exactGrantWriteConfinement", "expiresAt", "capabilities",
    "executableIdentity", "imageIdentity",
  ]));
  if (input.attestationVersion !== 1 || typeof input.verified !== "boolean" ||
      typeof input.exactGrantWriteConfinement !== "boolean") throw new Error();
  const capabilities = exactObject(input.capabilities, new Set([
    "tree_termination", "crash_cleanup", "verified_emptiness", "write_confinement",
  ]));
  const states = new Set(["enforced", "partial", "unavailable", "unverified"]);
  for (const state of Object.values(capabilities)) if (!states.has(state as string)) throw new Error();
  return deepFreeze({
    attestationVersion: 1 as const,
    providerId: safeId(input.providerId),
    verified: input.verified,
    mechanism: safeText(input.mechanism),
    ...(input.implementationDigest === undefined
      ? {} : { implementationDigest: safeDigest(input.implementationDigest) }),
    exactGrantWriteConfinement: input.exactGrantWriteConfinement,
    ...(input.expiresAt === undefined ? {} : { expiresAt: dateText(input.expiresAt) }),
    ...(input.executableIdentity === undefined ? {} : {
      executableIdentity: parseExecutableIdentity(input.executableIdentity),
    }),
    ...(input.imageIdentity === undefined ? {} : {
      imageIdentity: parseImageIdentity(input.imageIdentity),
    }),
    capabilities: capabilities as unknown as ExecutionSafetyCapabilities,
  });
}

function qualifies(
  attestation: ExecutionIsolationAttestation,
  provider: TrustedProvider,
  now: Date,
): boolean {
  if (/^(?:local-)?native(?:-execution)?$/i.test(attestation.mechanism)) return false;
  const ociIdentity = attestation.mechanism !== "docker-compatible-oci" ||
    (attestation.executableIdentity !== undefined && attestation.imageIdentity !== undefined);
  return attestation.verified === true &&
    ociIdentity &&
    attestation.providerId === provider.providerId &&
    attestation.exactGrantWriteConfinement === true &&
    attestation.capabilities.write_confinement === "enforced" &&
    (!attestation.implementationDigest ||
      attestation.implementationDigest === provider.implementationDigest) &&
    (!attestation.expiresAt || Date.parse(attestation.expiresAt) > now.getTime());
}

function parseExecutableIdentity(value: unknown): { path: string; digest: string } {
  const input = exactObject(value, new Set(["path", "digest"]));
  return { path: safeText(input.path), digest: safeDigest(input.digest) };
}

function parseImageIdentity(value: unknown): { configuredReference: string; immutableId: string } {
  const input = exactObject(value, new Set(["configuredReference", "immutableId"]));
  const immutableId = safeText(input.immutableId);
  if (!/^sha256:[a-f0-9]{64}$/.test(immutableId)) throw new Error();
  return { configuredReference: safeText(input.configuredReference), immutableId };
}

function parseImmutableImageId(value: unknown): string {
  const immutableId = safeText(value);
  if (!/^sha256:[a-f0-9]{64}$/.test(immutableId)) throw new Error();
  return immutableId;
}

function assertGrantMatches(
  intent: ExecutionInvocationIntent,
  grant: ConsumedExecutionGrantClaims,
  profile: PermissionProfile,
  now: Date,
): void {
  if (grant.runId !== intent.runId || grant.sessionId !== intent.sessionId ||
      grant.permissionProfile !== profile || Date.parse(grant.expiresAt) <= now.getTime()) {
    throw new ExecutionIsolationError("isolation_grant_mismatch", "Isolation grant does not match invocation.");
  }
}

function parseAndValidateLease(
  value: unknown,
  provider: TrustedProvider,
  intent: ExecutionInvocationIntent,
  grant: ConsumedExecutionGrantClaims,
): ExecutionIsolationLease {
  const input = exactObject(value, new Set([
    "leaseId", "providerId", "invocationId", "grantId", "grantedAccess",
    "acquiredAt", "expiresAt", "state", "providerIdentity", "immutableImageId",
  ]));
  if (!Array.isArray(input.grantedAccess) || input.state !== "active") throw new Error();
  const access = input.grantedAccess.map((entry) => {
    const item = exactObject(entry, new Set(["canonicalPath", "mode"]));
    if (!["read", "write", "create"].includes(item.mode as string)) throw new Error();
    return { canonicalPath: safeText(item.canonicalPath), mode: item.mode as "read" | "write" | "create" };
  });
  if (JSON.stringify(access) !== JSON.stringify(grant.access)) throw new Error();
  const lease: ExecutionIsolationLease = {
    leaseId: safeId(input.leaseId),
    providerId: safeId(input.providerId),
    invocationId: safeId(input.invocationId),
    grantId: safeId(input.grantId),
    grantedAccess: access,
    acquiredAt: dateText(input.acquiredAt),
    ...(input.expiresAt === undefined ? {} : { expiresAt: dateText(input.expiresAt) }),
    state: "active",
    providerIdentity: safeDigest(input.providerIdentity),
    ...(input.immutableImageId === undefined ? {} : { immutableImageId: parseImmutableImageId(input.immutableImageId) }),
  };
  if (lease.providerId !== provider.providerId ||
      lease.invocationId !== intent.invocationId ||
      lease.grantId !== grant.grantId ||
      lease.providerIdentity !== provider.implementationDigest) throw new Error();
  return deepFreeze(lease);
}

function exactObject(value: unknown, keys: ReadonlySet<string>): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !keys.has(key))) throw new Error();
  return input;
}

function safeId(value: unknown): string {
  const text = safeText(value);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(text)) throw new Error();
  return text;
}

function safeText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > 512) throw new Error();
  return value;
}

function safeDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error();
  return value;
}

function dateText(value: unknown): string {
  const text = safeText(value);
  if (!Number.isFinite(Date.parse(text))) throw new Error();
  return text;
}

function unavailable(): ExecutionIsolationError {
  return new ExecutionIsolationError(
    "isolation_capability_unavailable",
    "No verified isolation provider enforces exact-grant write confinement; execution is paused before launch.",
  );
}

function reserveGrant(grant: ConsumedExecutionGrantClaims): void {
  try {
    reserveConsumedExecutionGrantForIsolation(grant);
  } catch (error) {
    throw new ExecutionIsolationError(
      "isolation_grant_mismatch",
      "Isolation grant is unavailable or already used.",
      { cause: error },
    );
  }
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.length <= 512 ? value : `${value.slice(0, 512)}…`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
