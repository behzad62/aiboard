import { createHash } from "node:crypto";

import type { PermissionProfile } from "./contracts.js";
import type {
  ExecutionInvocationIntent,
  ExecutionSafetyCapabilities,
} from "./execution-safety-contracts.js";
import {
  assertRunnerConsumedExecutionGrantClaims,
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
  options: { readonly clock?: () => Date } = {},
): ExecutionIsolationSelector {
  if (!registry || !REGISTRIES.has(registry)) {
    throw new Error("Execution isolation registry authority is invalid.");
  }
  const providers = REGISTRY_VALUES.get(registry)!;
  const clock = options.clock ?? (() => new Date());
  const active = new Map<string, {
    provider: TrustedProvider;
    selection: Extract<ExecutionIsolationSelection, { lease: unknown }>;
  }>();
  const usedGrantIds = new Set<string>();

  return Object.freeze({
    async acquire(input: {
      permissionProfile: PermissionProfile;
      intent: ExecutionInvocationIntent;
      grant: ConsumedExecutionGrantClaims;
    }): Promise<ExecutionIsolationSelection> {
      assertRunnerConsumedExecutionGrantClaims(input.grant);
      if (usedGrantIds.has(input.grant.grantId)) {
        throw new ExecutionIsolationError(
          "isolation_grant_mismatch",
          "Isolation grant has already been used for one provider selection.",
        );
      }
      usedGrantIds.add(input.grant.grantId);
      assertGrantMatches(input.intent, input.grant, input.permissionProfile, clock());
      if (input.permissionProfile === "full") {
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
        active.set(lease.leaseId, { provider, selection });
        return selection;
      }
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
      } catch (error) {
        const failed = deepFreeze({ ...selection.lease, state: "revocation_failed" as const });
        owned.selection = deepFreeze({ ...selection, lease: failed });
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
