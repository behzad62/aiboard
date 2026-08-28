import { isSensitiveKey } from "./sensitive-redaction.js";

export interface RunnerOwnedChildEnvironmentCredentialGrant {
  readonly grantId: string;
  readonly runId: string;
  readonly invocationId: string;
  readonly expiresAt?: string;
  readonly names: readonly string[];
  /** Runner-private values; never present in a caller-facing type. */
  readonly values: Readonly<Record<string, string>>;
}

/** Runner-owned storage must atomically mark an id consumed before returning it. */
export interface RunnerOwnedChildEnvironmentCredentialResolver {
  consume(grantId: string): RunnerOwnedChildEnvironmentCredentialGrant;
}

export type ChildEnvironmentDecision =
  | { readonly kind: "removed_ambient"; readonly name: string }
  | { readonly kind: "applied_explicit"; readonly name: string }
  | { readonly kind: "rejected_explicit"; readonly name: string }
  | { readonly kind: "granted_credential"; readonly name: string };

export interface ChildEnvironmentAudit {
  readonly inheritedNames: readonly string[];
  readonly removedNames: readonly string[];
  readonly explicitSafeNames: readonly string[];
  readonly grantedNames: readonly string[];
  readonly decisions: readonly ChildEnvironmentDecision[];
}

export interface PrepareChildEnvironmentInput {
  readonly ambient: Readonly<Record<string, string | undefined>>;
  readonly explicitOverrides?: Readonly<Record<string, string | undefined>>;
  readonly runId?: string;
  readonly invocationId?: string;
  /** Caller-visible opaque id only; all authority is loaded from Runner storage. */
  readonly credentialGrantId?: string;
}

/** Opaque capability valid only in the factory closure that issued it. */
export interface ChildEnvironmentCapability { readonly _opaque?: never }

export interface PreparedChildEnvironment {
  readonly capability: ChildEnvironmentCapability;
  readonly audit: ChildEnvironmentAudit;
}

export interface ChildEnvironmentFactory {
  prepare(input: PrepareChildEnvironmentInput): PreparedChildEnvironment;
  withChildEnvironment<T>(
    capability: ChildEnvironmentCapability,
    trustedSpawn: (environment: Readonly<Record<string, string>>) => T,
  ): T;
}

export interface CreateChildEnvironmentFactoryOptions {
  readonly credentialResolver: RunnerOwnedChildEnvironmentCredentialResolver;
  readonly now?: () => Date;
}

interface EnvironmentEntry { readonly name: string; readonly value: string }
interface PrepareChildEnvironmentSnapshot {
  readonly ambient: Readonly<Record<string, string | undefined>>;
  readonly explicitOverrides?: Readonly<Record<string, string | undefined>>;
  readonly runId?: string;
  readonly invocationId?: string;
  readonly credentialGrantId?: string;
}

/**
 * Runner wires this factory once with private, atomically-consuming grant
 * storage. Per-call input can name a grant but cannot supply its authority.
 */
export function createChildEnvironmentFactory(
  options: CreateChildEnvironmentFactoryOptions,
): ChildEnvironmentFactory {
  const environments = new WeakMap<object, Readonly<Record<string, string>>>();
  const redeemedGrantIds = new Set<string>();
  const now = options.now ?? (() => new Date());

  return Object.freeze({
    prepare(input: PrepareChildEnvironmentInput): PreparedChildEnvironment {
      const request = snapshotPrepareChildEnvironmentInput(input);
      const environment = new Map<string, EnvironmentEntry>();
      const removedNames: string[] = [];
      const explicitSafeNames: string[] = [];
      const grantedNames: string[] = [];
      const decisions: ChildEnvironmentDecision[] = [];

      for (const [name, value] of sortedEntries(request.ambient)) {
        if (value === undefined) continue;
        assertEnvironmentEntry(name, value);
        if (isForbiddenChildEnvironmentName(name)) {
          removedNames.push(name);
          decisions.push({ kind: "removed_ambient", name });
        } else setEnvironment(environment, name, value);
      }
      const inheritedNames = names(environment);

      for (const [name, value] of sortedEntries(request.explicitOverrides ?? {})) {
        if (value === undefined) continue;
        assertEnvironmentEntry(name, value);
        if (isForbiddenChildEnvironmentName(name)) decisions.push({ kind: "rejected_explicit", name });
        else {
          setEnvironment(environment, name, value);
          explicitSafeNames.push(name);
          decisions.push({ kind: "applied_explicit", name });
        }
      }

      if (request.credentialGrantId !== undefined) {
        reserveCredentialGrantId(request.credentialGrantId, redeemedGrantIds);
        const grant = consumeAndValidateGrant(options.credentialResolver, request, now);
        for (const name of grant.names) {
          setEnvironment(environment, name, grant.values.get(canonicalName(name))!);
          grantedNames.push(name);
          decisions.push({ kind: "granted_credential", name });
        }
      }

      const capability = Object.freeze({}) as ChildEnvironmentCapability;
      environments.set(capability, createRawEnvironment(environment));
      return Object.freeze({
        capability,
        audit: freezeAudit(inheritedNames, removedNames, explicitSafeNames, grantedNames, decisions),
      });
    },

    withChildEnvironment<T>(
      capability: ChildEnvironmentCapability,
      trustedSpawn: (environment: Readonly<Record<string, string>>) => T,
    ): T {
      if (!capability || typeof capability !== "object") throw invalidGrant();
      const environment = environments.get(capability);
      if (!environment) throw invalidGrant();
      environments.delete(capability);
      return trustedSpawn(environment);
    },
  });
}

function snapshotPrepareChildEnvironmentInput(
  input: PrepareChildEnvironmentInput,
): PrepareChildEnvironmentSnapshot {
  return Object.freeze({
    ambient: input.ambient,
    explicitOverrides: input.explicitOverrides,
    runId: input.runId,
    invocationId: input.invocationId,
    credentialGrantId: input.credentialGrantId,
  });
}

function reserveCredentialGrantId(grantId: string, redeemedGrantIds: Set<string>): void {
  if (!nonEmpty(grantId)) throw invalidGrant();
  const canonical = grantId.trim().toUpperCase();
  if (redeemedGrantIds.has(canonical)) throw consumedGrant();
  redeemedGrantIds.add(canonical);
}

function consumeAndValidateGrant(
  resolver: RunnerOwnedChildEnvironmentCredentialResolver,
  input: PrepareChildEnvironmentSnapshot,
  now: () => Date,
): { names: readonly string[]; values: ReadonlyMap<string, string> } {
  if (!nonEmpty(input.credentialGrantId)) throw invalidGrant();
  let grant: RunnerOwnedChildEnvironmentCredentialGrant;
  try { grant = resolver.consume(input.credentialGrantId); }
  catch { throw consumedGrant(); }
  try {
    if (!grant || typeof grant !== "object" || grant.grantId !== input.credentialGrantId) throw invalidGrant();
    if (!nonEmpty(input.runId) || grant.runId !== input.runId) throw invalidGrant();
    if (!nonEmpty(input.invocationId) || grant.invocationId !== input.invocationId) throw invalidGrant();
    if (grant.expiresAt !== undefined && (!nonEmpty(grant.expiresAt) || Number.isNaN(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now().getTime())) throw invalidGrant();
    if (!Array.isArray(grant.names) || grant.names.length === 0 || !grant.values || typeof grant.values !== "object") throw invalidGrant();
    const names = new Set<string>();
    for (const name of grant.names) {
      if (!isCredentialGrantName(name) || names.has(canonicalName(name))) throw invalidGrant();
      names.add(canonicalName(name));
    }
    const values = new Map<string, string>();
    for (const [name, value] of Object.entries(grant.values)) {
      if (!isEnvironmentName(name) || typeof value !== "string" || values.has(canonicalName(name))) throw invalidGrant();
      values.set(canonicalName(name), value);
    }
    if (values.size !== names.size || [...names].some((name) => !values.has(name))) throw invalidGrant();
    return { names: Object.freeze([...grant.names]), values };
  } catch (error) {
    if (error instanceof Error && error.message === "Child environment credential grant is invalid.") throw error;
    throw invalidGrant();
  }
}

function createRawEnvironment(environment: Map<string, EnvironmentEntry>): Readonly<Record<string, string>> {
  const raw = Object.create(null) as Record<string, string>;
  for (const { name, value } of environment.values()) raw[name] = value;
  return Object.freeze(raw);
}

function freezeAudit(
  inheritedNames: readonly string[], removedNames: readonly string[], explicitSafeNames: readonly string[],
  grantedNames: readonly string[], decisions: readonly ChildEnvironmentDecision[],
): ChildEnvironmentAudit {
  return Object.freeze({
    inheritedNames: Object.freeze(sortNames(inheritedNames)),
    removedNames: Object.freeze(sortNames(removedNames)),
    explicitSafeNames: Object.freeze(sortNames(explicitSafeNames)),
    grantedNames: Object.freeze(sortNames(grantedNames)),
    decisions: Object.freeze(decisions.map((decision) => Object.freeze({ ...decision }))),
  });
}

function isCredentialGrantName(name: string): boolean {
  return isEnvironmentName(name) && isSensitiveKey(name) && !isRunnerName(name);
}

function isForbiddenChildEnvironmentName(name: string): boolean {
  return isSensitiveKey(name) || isRunnerName(name);
}

function isRunnerName(name: string): boolean {
  const canonical = canonicalName(name);
  return canonical.startsWith("RUNNER_") || canonical.startsWith("AIBOARD_RUNNER_");
}

function sortedEntries(source: Readonly<Record<string, string | undefined>>): Array<[string, string | undefined]> {
  return Object.entries(source).sort(([left], [right]) => canonicalName(left).localeCompare(canonicalName(right)) || left.localeCompare(right));
}

function setEnvironment(target: Map<string, EnvironmentEntry>, name: string, value: string): void {
  target.set(canonicalName(name), { name, value });
}

function names(target: Map<string, EnvironmentEntry>): string[] {
  return [...target.values()].map(({ name }) => name);
}

function assertEnvironmentEntry(name: string, value: string): void {
  if (!isEnvironmentName(name) || typeof value !== "string") throw new Error("Child environment input is invalid.");
}

function isEnvironmentName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function canonicalName(name: string): string { return name.toUpperCase(); }

function sortNames(values: readonly string[]): string[] {
  return [...values].sort((left, right) => canonicalName(left).localeCompare(canonicalName(right)) || left.localeCompare(right));
}

function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function invalidGrant(): Error { return new Error("Child environment credential grant is invalid."); }
function consumedGrant(): Error { return new Error("Child environment credential grant could not be consumed."); }
