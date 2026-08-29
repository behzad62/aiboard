import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

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
}

export interface ExecutionIsolationProvider {
  attest(): Promise<unknown>;
  acquire(request: ExecutionIsolationAcquireRequest): Promise<unknown>;
  release(lease: ExecutionIsolationLease): Promise<void>;
  recoverOwned(): Promise<ExecutionIsolationRecoveryResult>;
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
  readonly status: "active" | "revoked" | "blocked" | "unconfined_explicit_full" | "cleaned";
  readonly enforcement: "unconfined_explicit_full" | "write_confinement_exact_grant";
  readonly disclosure: "unconfined_explicit_full" | "provider_specific_not_universal_boundary";
  readonly providerId?: string;
  readonly implementationDigest?: string;
  readonly immutableImageId?: string;
  readonly leaseId?: string;
  readonly access: ConsumedExecutionGrantClaims["access"];
  readonly blocker?: string;
}

export interface ExecutionEnforcementState {
  readonly version: 1;
  readonly boundary: "provider_specific_not_universal_security_boundary";
  readonly records: readonly ExecutionEnforcementRecord[];
}

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
  }>();

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
        const registered = await registerConsumedExecutionGrantRevoker(input.grant, async () => {
          const owned = active.get(lease.leaseId);
          if (!owned) return;
          try {
            await owned.provider.provider.release(owned.selection.lease);
            active.delete(lease.leaseId);
            await persist(enforcementRecord(owned.selection, owned.runId, "revoked", clock()));
          } catch (error) {
            const failed = deepFreeze({ ...owned.selection.lease, state: "revocation_failed" as const });
            owned.selection = deepFreeze({ ...owned.selection, lease: failed });
            await persist({ ...enforcementRecord(owned.selection, owned.runId, "blocked", clock()), blocker: "Authority revocation could not release the isolation lease." });
            throw error;
          }
        });
        if (!registered) {
          throw new ExecutionIsolationError("isolation_grant_mismatch", "Isolation grant was revoked during provider acquisition.");
        }
        try {
          await persist({
            occurredAt: clock().toISOString(), runId: input.intent.runId,
            invocationId: input.intent.invocationId, grantId: input.grant.grantId,
            status: "active", enforcement: "write_confinement_exact_grant",
            disclosure: "provider_specific_not_universal_boundary", providerId: provider.providerId,
            implementationDigest: provider.implementationDigest,
            ...(attestation.imageIdentity ? { immutableImageId: attestation.imageIdentity.immutableId } : {}),
            leaseId: lease.leaseId, access: input.grant.access,
          });
        } catch (error) {
          await provider.provider.release(lease);
          active.delete(lease.leaseId);
          throw error;
        }
        return selection;
      }
      await persist({
        occurredAt: clock().toISOString(), runId: input.intent.runId, invocationId: input.intent.invocationId,
        grantId: input.grant.grantId, status: "blocked", enforcement: "write_confinement_exact_grant",
        disclosure: "provider_specific_not_universal_boundary", access: input.grant.access,
        blocker: "No verified provider enforces exact-grant write confinement.",
      });
      throw unavailable();
    },

    async release(selection: ExecutionIsolationSelection): Promise<void> {
      if (selection.enforcement === "unconfined_explicit_full") return;
      const owned = active.get(selection.lease.leaseId);
      if (!owned || owned.selection !== selection) {
        throw new ExecutionIsolationError(
          "isolation_lease_invalid",
          "Isolation lease is not owned by this Runner selector.",
        );
      }
      try {
        await owned.provider.provider.release(selection.lease);
        active.delete(selection.lease.leaseId);
        await persist(enforcementRecord(selection, owned.runId, "revoked", clock()));
      } catch (error) {
        const failed = deepFreeze({ ...selection.lease, state: "revocation_failed" as const });
        owned.selection = deepFreeze({ ...selection, lease: failed });
        await persist({ ...enforcementRecord(owned.selection, owned.runId, "blocked", clock()), blocker: "Isolation lease revocation failed." });
        throw new ExecutionIsolationError(
          "isolation_revocation_failed",
          "Isolation lease revocation failed.",
          { cause: error },
        );
      }
    },

    async recoverOwnedLeases() {
      const results: { providerId: string; cleaned: number; blockers: readonly string[] }[] = [];
      for (const provider of providers) {
        try {
          const result = await provider.provider.recoverOwned();
          const blockers = Object.freeze([...result.blockers]);
          results.push(Object.freeze({ providerId: provider.providerId, cleaned: result.cleaned, blockers }));
          await persistRecovery(options.statePath, provider.providerId, result.cleaned, blockers, clock());
          if (blockers.length === 0) {
            for (const [leaseId, value] of active) {
              if (value.provider.providerId === provider.providerId) active.delete(leaseId);
            }
          }
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
      return Object.freeze([...active.values()].map(({ selection }) =>
        deepFreeze({ ...selection.lease, grantedAccess: selection.lease.grantedAccess.map((x) => ({ ...x })) })));
    },

    async enforcementState(): Promise<ExecutionEnforcementState> {
      return options.statePath ? await readExecutionEnforcementState(options.statePath) : emptyEnforcementState();
    },
  });
}

const STATE_WRITES = new Map<string, Promise<void>>();

export async function readExecutionEnforcementState(path: string): Promise<ExecutionEnforcementState> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parseEnforcementState(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyEnforcementState();
    throw new ExecutionIsolationError("isolation_recovery_blocked", "Durable enforcement state is unreadable.", { cause: error });
  }
}

function parseEnforcementState(value: unknown): ExecutionEnforcementState {
  const object = exactObject(value, new Set(["version", "boundary", "records"]));
  if (object.version !== 1 || object.boundary !== "provider_specific_not_universal_security_boundary" || !Array.isArray(object.records)) throw new Error();
  const statuses = new Set(["active", "revoked", "blocked", "unconfined_explicit_full", "cleaned"]);
  const enforcement = new Set(["unconfined_explicit_full", "write_confinement_exact_grant"]);
  const disclosure = new Set(["unconfined_explicit_full", "provider_specific_not_universal_boundary"]);
  const records = object.records.map((entry) => {
    const record = exactObject(entry, new Set([
      "occurredAt", "runId", "invocationId", "grantId", "status", "enforcement", "disclosure",
      "providerId", "implementationDigest", "immutableImageId", "leaseId", "access", "blocker",
    ]));
    if (!statuses.has(record.status as string) || !enforcement.has(record.enforcement as string) ||
        !disclosure.has(record.disclosure as string) || !Array.isArray(record.access)) throw new Error();
    for (const key of ["occurredAt", "runId", "invocationId", "grantId"] as const) safeText(record[key]);
    if (!Number.isFinite(Date.parse(record.occurredAt as string))) throw new Error();
    for (const key of ["providerId", "implementationDigest", "immutableImageId", "leaseId", "blocker"] as const) {
      if (record[key] !== undefined) safeText(record[key]);
    }
    const access = record.access.map((item) => {
      const accessEntry = exactObject(item, new Set(["canonicalPath", "mode"]));
      if (!["read", "write", "create"].includes(accessEntry.mode as string)) throw new Error();
      return { canonicalPath: safeText(accessEntry.canonicalPath), mode: accessEntry.mode as "read" | "write" | "create" };
    });
    return { ...record, access } as unknown as ExecutionEnforcementRecord;
  });
  return deepFreeze({ version: 1, boundary: "provider_specific_not_universal_security_boundary", records });
}

function emptyEnforcementState(): ExecutionEnforcementState {
  return deepFreeze({ version: 1 as const, boundary: "provider_specific_not_universal_security_boundary" as const, records: [] });
}

async function appendEnforcementRecord(path: string, record: ExecutionEnforcementRecord): Promise<void> {
  const previous = STATE_WRITES.get(path) ?? Promise.resolve();
  const next = previous.then(async () => {
    await withProjectionLock(path, async () => {
      const state = await readExecutionEnforcementState(path);
      const updated = { ...state, records: [...state.records, structuredClone(record)].slice(-1_000) };
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(updated), { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
      finally { await rm(temporary, { force: true }); }
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
    ...(selection.attestation.imageIdentity ? { immutableImageId: selection.attestation.imageIdentity.immutableId } : {}),
    leaseId: selection.lease.leaseId, access: selection.lease.grantedAccess,
  };
}

async function persistRecovery(
  statePath: string | undefined, providerId: string, cleaned: number, blockers: readonly string[], now: Date,
): Promise<void> {
  if (!statePath || (blockers.length === 0 && cleaned === 0)) return;
  await appendEnforcementRecord(statePath, {
    occurredAt: now.toISOString(), runId: "recovery", invocationId: "recovery", grantId: "recovery",
    status: blockers.length > 0 ? "blocked" : "cleaned", enforcement: "write_confinement_exact_grant",
    disclosure: "provider_specific_not_universal_boundary", providerId, access: [],
    ...(blockers.length > 0 ? { blocker: blockers.join("; ").slice(0, 512) } : {}),
  });
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
    "acquiredAt", "expiresAt", "state", "providerIdentity",
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
