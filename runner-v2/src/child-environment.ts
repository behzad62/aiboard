import { isSensitiveKey } from "./sensitive-redaction.js";

export interface NamedChildEnvironmentCredentialGrant {
  readonly grantId: string;
  readonly runId: string;
  readonly invocationId: string;
  readonly expiresAt?: string;
  readonly names: readonly string[];
}

/** This interface is implemented by Runner-owned credential storage, never model input. */
export interface ChildEnvironmentCredentialGrantResolver {
  consume(grant: NamedChildEnvironmentCredentialGrant): Readonly<Record<string, string>>;
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

export interface ConstructChildEnvironmentOptions {
  readonly ambient: Readonly<Record<string, string | undefined>>;
  readonly explicitOverrides?: Readonly<Record<string, string | undefined>>;
  readonly runId?: string;
  readonly invocationId?: string;
  readonly credentialGrant?: NamedChildEnvironmentCredentialGrant;
  readonly credentialResolver?: ChildEnvironmentCredentialGrantResolver;
  readonly now?: () => Date;
}

export interface ConstructedChildEnvironment {
  /** Child-only values. It is deliberately excluded from JSON serialization. */
  readonly environment: Readonly<Record<string, string>>;
  readonly audit: ChildEnvironmentAudit;
}

const GRANT_KEYS = new Set(["grantId", "runId", "invocationId", "expiresAt", "names"]);

/**
 * Constructs the one portable child environment policy. Callers supply ambient
 * values explicitly so this pure function never reads process.env itself.
 */
export function constructChildEnvironment(
  options: ConstructChildEnvironmentOptions,
): ConstructedChildEnvironment {
  const environment = new Map<string, { name: string; value: string }>();
  const removedNames: string[] = [];
  const explicitSafeNames: string[] = [];
  const grantedNames: string[] = [];
  const decisions: ChildEnvironmentDecision[] = [];

  for (const [name, value] of sortedEntries(options.ambient)) {
    if (value === undefined) continue;
    assertEnvironmentValue(name, value, "ambient environment");
    if (isForbiddenChildEnvironmentName(name)) {
      removedNames.push(name);
      decisions.push({ kind: "removed_ambient", name });
      continue;
    }
    setEnvironment(environment, name, value);
  }
  const inheritedNames = names(environment);

  for (const [name, value] of sortedEntries(options.explicitOverrides ?? {})) {
    if (value === undefined) continue;
    assertEnvironmentValue(name, value, "explicit environment override");
    if (isForbiddenChildEnvironmentName(name)) {
      decisions.push({ kind: "rejected_explicit", name });
      continue;
    }
    setEnvironment(environment, name, value);
    explicitSafeNames.push(name);
    decisions.push({ kind: "applied_explicit", name });
  }

  if (options.credentialGrant !== undefined) {
    const grant = validateCredentialGrant(options.credentialGrant, options);
    const resolver = options.credentialResolver;
    if (!resolver) throw new Error("Credential grant requires a Runner-private resolver.");
    const values = resolver.consume(grant);
    const grantedByCanonicalName = new Map(grant.names.map((name) => [canonicalName(name), name]));
    for (const [name, value] of Object.entries(values)) {
      assertEnvironmentValue(name, value, "Runner-private credential value");
      if (!grantedByCanonicalName.has(canonicalName(name))) {
        throw new Error("Credential resolver returned a variable not named by the grant.");
      }
    }
    for (const name of grant.names) {
      const supplied = findCaseInsensitive(values, name);
      if (supplied === undefined) {
        throw new Error("Credential resolver did not return every variable named by the grant.");
      }
      setEnvironment(environment, name, supplied);
      grantedNames.push(name);
      decisions.push({ kind: "granted_credential", name });
    }
  }

  const childValues = Object.fromEntries([...environment.values()].map(({ name, value }) => [name, value]));
  Object.defineProperty(childValues, "toJSON", {
    enumerable: false,
    value: () => ({}),
  });
  return Object.freeze({
    environment: Object.freeze(childValues),
    audit: Object.freeze({
      inheritedNames: Object.freeze(inheritedNames),
      removedNames: Object.freeze(removedNames),
      explicitSafeNames: Object.freeze(sortNames(explicitSafeNames)),
      grantedNames: Object.freeze(sortNames(grantedNames)),
      decisions: Object.freeze(decisions.map((decision) => Object.freeze({ ...decision }))),
    }),
  });
}

function validateCredentialGrant(
  grant: NamedChildEnvironmentCredentialGrant,
  options: ConstructChildEnvironmentOptions,
): NamedChildEnvironmentCredentialGrant {
  if (!grant || typeof grant !== "object") throw new Error("Credential grant is invalid.");
  for (const key of Object.keys(grant)) {
    if (!GRANT_KEYS.has(key)) throw new Error(`Credential grant contains unknown field ${key}.`);
  }
  if (!nonEmpty(grant.grantId) || !nonEmpty(grant.runId) || !nonEmpty(grant.invocationId)) {
    throw new Error("Credential grant identity is invalid.");
  }
  if (!options.runId || grant.runId !== options.runId) throw new Error("Credential grant is for a different run.");
  if (!options.invocationId || grant.invocationId !== options.invocationId) {
    throw new Error("Credential grant is for a different invocation.");
  }
  if (!Array.isArray(grant.names) || grant.names.length === 0) {
    throw new Error("Credential grant must name at least one variable.");
  }
  const seen = new Set<string>();
  for (const name of grant.names) {
    if (!isEnvironmentName(name)) throw new Error("Credential grant contains an invalid variable name.");
    const canonical = canonicalName(name);
    if (seen.has(canonical)) throw new Error("Credential grant names a variable more than once.");
    seen.add(canonical);
  }
  if (grant.expiresAt !== undefined) {
    if (!nonEmpty(grant.expiresAt) || Number.isNaN(Date.parse(grant.expiresAt))) {
      throw new Error("Credential grant expiry is invalid.");
    }
    if (Date.parse(grant.expiresAt) <= (options.now?.() ?? new Date()).getTime()) {
      throw new Error("Credential grant has expired.");
    }
  }
  return Object.freeze({ ...grant, names: Object.freeze([...grant.names]) });
}

function isForbiddenChildEnvironmentName(name: string): boolean {
  return isSensitiveKey(name) || canonicalName(name).startsWith("RUNNER_") || canonicalName(name).startsWith("AIBOARD_RUNNER_");
}

function sortedEntries(source: Readonly<Record<string, string | undefined>>): Array<[string, string | undefined]> {
  return Object.entries(source).sort(([left], [right]) => canonicalName(left).localeCompare(canonicalName(right)) || left.localeCompare(right));
}

function setEnvironment(target: Map<string, { name: string; value: string }>, name: string, value: string): void {
  target.set(canonicalName(name), { name, value });
}

function names(target: Map<string, { name: string; value: string }>): string[] {
  return sortNames([...target.values()].map(({ name }) => name));
}

function findCaseInsensitive(values: Readonly<Record<string, string>>, name: string): string | undefined {
  const match = Object.entries(values).find(([candidate]) => canonicalName(candidate) === canonicalName(name));
  return match?.[1];
}

function assertEnvironmentValue(name: string, value: string, label: string): void {
  if (!isEnvironmentName(name) || typeof value !== "string") {
    throw new Error(`${label} is invalid.`);
  }
}

function isEnvironmentName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function canonicalName(name: string): string {
  return name.toUpperCase();
}

function sortNames(values: readonly string[]): string[] {
  return [...values].sort((left, right) => canonicalName(left).localeCompare(canonicalName(right)) || left.localeCompare(right));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
