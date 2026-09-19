import { createHash, randomUUID } from "node:crypto";
import { types as nodeTypes } from "node:util";
import {
  EXECUTION_SAFETY_CAPABILITY_NAMES,
  parseExecutionSafetyCapabilities,
  type ExactPathAccess,
  type ExecutionInvocationIntent,
  type ExecutionSafetyCapabilities,
  type ExecutionSafetyCapabilityName,
  type ProcessEscalationAction,
  type ProcessOutputStream,
} from "./execution-safety-contracts.js";

export const PROCESS_BACKEND_ATTESTATION_VERSION = 1 as const;
export interface ProcessBackendProbe {
  readonly attestationVersion: 1;
  readonly backendId: string;
  readonly verified: true;
  readonly platformLabel: string;
  readonly capabilities: ExecutionSafetyCapabilities;
}
export interface ProcessBackendRegistration {
  readonly kind: "runner-process-backend-registration";
}
export interface ProcessBackendRegistrationInput {
  readonly stableAdapterId: string;
  readonly backendId: string;
  readonly codeDigest: string;
  readonly configDigest: string;
  readonly backend: ProcessBackend;
}
export interface ProcessBackendRegistry {
  readonly kind: "runner-process-backend-registry";
}
export interface SelectedProcessBackend {
  readonly registryId: string;
  readonly stableAdapterId: string;
  readonly codeDigest: string;
  readonly configDigest: string;
  readonly backend: ProcessBackend;
  readonly implementationGeneration: string;
  readonly implementationDigest: string;
  readonly attestation: ProcessBackendProbe;
  readonly attestationDigest: string;
}
export interface ConsumedExecutionGrant {
  readonly grantId: string;
  readonly runId: string;
  readonly invocationId: string;
  readonly issuedAt: string;
  readonly expiresAt?: string;
  readonly access: readonly ExactPathAccess[];
}
export interface ProcessBackendBinding {
  readonly registryId: string;
  readonly backendId: string;
  readonly implementationGeneration: string;
  readonly implementationDigest: string;
  readonly attestationVersion: number;
  readonly attestationDigest: string;
  readonly opaqueIdentity: string;
  readonly birthFingerprint: {
    readonly observedAt: string;
    readonly discriminator: string;
  };
  readonly rootPid?: number;
  readonly startedAt: string;
}
export interface ProcessEffectFence {
  readonly ownerId: string;
  readonly fencingToken: number;
}
export interface ProcessLaunchResult {
  readonly opaqueIdentity: string;
  readonly birthFingerprint: {
    readonly observedAt: string;
    readonly discriminator: string;
  };
  readonly rootPid?: number;
  readonly startedAt: string;
}
export type ProcessObservation = {
  readonly state: "exited";
  readonly exitCode?: number;
  readonly signal?: string;
};
export type ProcessSignalResult = { readonly state: "running" | "exited" };
export type ProcessEmptyVerification =
  | { readonly empty: true; readonly proofArtifactId?: string }
  | { readonly empty: false; readonly detail: string };
export type ProcessReconciliation =
  | { readonly state: "running" }
  | {
      readonly state: "exited";
      readonly exitCode?: number;
      readonly signal?: string;
    }
  | { readonly state: "identity_mismatch" }
  | { readonly state: "outcome_unknown" };
export type ProcessReleaseResult = { readonly released: true };
export class ProcessReleasePendingError extends Error {
  readonly code = "process_release_pending";
  constructor(message: string) {
    super(message);
    this.name = "ProcessReleasePendingError";
  }
}
export interface ProcessLaunchRequest {
  readonly intent: ExecutionInvocationIntent;
  readonly grant: ConsumedExecutionGrant;
  readonly environment: Readonly<Record<string, string>>;
  readonly outputOwnerId: string;
  readonly fence: ProcessEffectFence;
}
export interface ProcessBackend {
  probe(fence?: ProcessEffectFence): Promise<unknown>;
  launch(request: ProcessLaunchRequest): Promise<unknown>;
  observe(
    binding: ProcessBackendBinding,
    output: (stream: ProcessOutputStream, bytes: Uint8Array) => Promise<void>,
    fence: ProcessEffectFence,
  ): Promise<unknown>;
  signal(
    binding: ProcessBackendBinding,
    action: ProcessEscalationAction,
    fence: ProcessEffectFence,
  ): Promise<unknown>;
  verifyEmpty(
    binding: ProcessBackendBinding,
    fence: ProcessEffectFence,
  ): Promise<unknown>;
  reconcile(
    binding: ProcessBackendBinding,
    fence: ProcessEffectFence,
  ): Promise<unknown>;
  release(
    binding: ProcessBackendBinding,
    fence: ProcessEffectFence,
  ): Promise<unknown>;
}

interface TrustedEntry {
  readonly registryId: string;
  readonly stableAdapterId: string;
  readonly backendId: string;
  readonly codeDigest: string;
  readonly configDigest: string;
  readonly implementationGeneration: string;
  readonly implementationDigest: string;
  readonly backend: ProcessBackend;
}
const REGISTRATIONS = new WeakSet<object>();
const REGISTRATION_VALUES = new WeakMap<
  object,
  Omit<
    TrustedEntry,
    "registryId" | "implementationGeneration" | "implementationDigest"
  >
>();
const REGISTRIES = new WeakSet<object>();
const REGISTRY_ENTRIES = new WeakMap<object, readonly TrustedEntry[]>();

export function createProcessBackendRegistration(
  input: ProcessBackendRegistrationInput,
): ProcessBackendRegistration {
  const stableAdapterId = safeId(input.stableAdapterId);
  const backendId = safeId(input.backendId);
  const codeDigest = digestText(input.codeDigest);
  const configDigest = digestText(input.configDigest);
  if (!input.backend || typeof input.backend !== "object") throw unavailable();
  const source = input.backend;
  const backend = Object.freeze({
    probe: source.probe.bind(source),
    launch: source.launch.bind(source),
    observe: source.observe.bind(source),
    signal: source.signal.bind(source),
    verifyEmpty: source.verifyEmpty.bind(source),
    reconcile: source.reconcile.bind(source),
    release: source.release.bind(source),
  });
  const registration = Object.freeze({
    kind: "runner-process-backend-registration" as const,
  });
  REGISTRATIONS.add(registration);
  REGISTRATION_VALUES.set(
    registration,
    Object.freeze({
      stableAdapterId,
      backendId,
      codeDigest,
      configDigest,
      backend,
    }),
  );
  return registration;
}
export function createProcessBackendRegistry(
  registrations: readonly ProcessBackendRegistration[],
): ProcessBackendRegistry {
  const registryGeneration = safeId(`registry-${randomUUID()}`);
  const seen = new Set<string>();
  const trusted = registrations.map((registration) => {
    if (
      !registration ||
      typeof registration !== "object" ||
      !REGISTRATIONS.has(registration)
    )
      throw new Error("Process backend registration authority is invalid.");
    const value = REGISTRATION_VALUES.get(registration)!;
    if (seen.has(value.stableAdapterId))
      throw new Error(
        `Duplicate process backend registry identity ${value.stableAdapterId}.`,
      );
    seen.add(value.stableAdapterId);
    const implementationGeneration = safeId(`implementation-${randomUUID()}`);
    const implementationDigest = createHash("sha256")
      .update(
        `${value.stableAdapterId}\0${value.backendId}\0${value.codeDigest}\0${value.configDigest}`,
      )
      .digest("hex");
    return Object.freeze({
      ...value,
      registryId: registryGeneration,
      implementationGeneration,
      implementationDigest,
    });
  });
  const registry = Object.freeze({
    kind: "runner-process-backend-registry" as const,
  });
  REGISTRIES.add(registry);
  REGISTRY_ENTRIES.set(registry, Object.freeze(trusted));
  return registry;
}
export function assertProcessBackendRegistryAuthority(
  registry: ProcessBackendRegistry,
): ProcessBackendRegistry {
  trustedEntries(registry);
  return registry;
}

export function parseProcessBackendProbe(value: unknown): ProcessBackendProbe {
  const o = record(value);
  keys(o, [
    "attestationVersion",
    "backendId",
    "verified",
    "platformLabel",
    "capabilities",
  ]);
  if (o.attestationVersion !== 1 || o.verified !== true) bad();
  const caps = record(o.capabilities);
  const parsed = Object.freeze(parseExecutionSafetyCapabilities(caps));
  return freeze({
    attestationVersion: 1,
    backendId: text(o.backendId),
    verified: true,
    platformLabel: text(o.platformLabel),
    capabilities: parsed,
  });
}
export function parseProcessLaunchResult(value: unknown): ProcessLaunchResult {
  const o = record(value);
  keys(o, ["opaqueIdentity", "birthFingerprint", "rootPid", "startedAt"]);
  const birth = record(o.birthFingerprint);
  keys(birth, ["observedAt", "discriminator"]);
  return freeze({
    opaqueIdentity: text(o.opaqueIdentity),
    birthFingerprint: freeze({
      observedAt: text(birth.observedAt),
      discriminator: text(birth.discriminator),
    }),
    ...(o.rootPid === undefined ? {} : { rootPid: integer(o.rootPid, 1) }),
    startedAt: text(o.startedAt),
  });
}
export function parseProcessObservation(value: unknown): ProcessObservation {
  const o = record(value);
  keys(o, ["state", "exitCode", "signal"]);
  if (o.state !== "exited") bad();
  return freeze({
    state: "exited",
    ...(o.exitCode === undefined
      ? {}
      : { exitCode: integer(o.exitCode, -2147483648, 2147483647) }),
    ...optionalText(o, "signal"),
  });
}
export function parseProcessSignalResult(value: unknown): ProcessSignalResult {
  const o = record(value);
  keys(o, ["state"]);
  if (o.state !== "running" && o.state !== "exited") bad();
  return freeze({ state: o.state });
}
export function parseProcessEmptyVerification(
  value: unknown,
): ProcessEmptyVerification {
  const o = record(value);
  if (o.empty === true) {
    keys(o, ["empty", "proofArtifactId"]);
    return freeze({ empty: true, ...optionalText(o, "proofArtifactId") });
  }
  if (o.empty === false) {
    keys(o, ["empty", "detail"]);
    return freeze({ empty: false, detail: text(o.detail) });
  }
  bad();
}
export function parseProcessReconciliation(
  value: unknown,
): ProcessReconciliation {
  const o = record(value);
  if (
    o.state === "running" ||
    o.state === "identity_mismatch" ||
    o.state === "outcome_unknown"
  ) {
    keys(o, ["state"]);
    return freeze({ state: o.state });
  }
  if (o.state === "exited") {
    keys(o, ["state", "exitCode", "signal"]);
    return freeze({
      state: "exited",
      ...(o.exitCode === undefined
        ? {}
        : { exitCode: integer(o.exitCode, -2147483648, 2147483647) }),
      ...optionalText(o, "signal"),
    });
  }
  bad();
}
export function parseProcessReleaseResult(
  value: unknown,
): ProcessReleaseResult {
  const o = record(value);
  keys(o, ["released"]);
  if (o.released !== true) bad();
  return freeze({ released: true });
}

export async function selectProcessBackend(
  registry: ProcessBackendRegistry,
  required: readonly ExecutionSafetyCapabilityName[],
  fence?: ProcessEffectFence,
): Promise<SelectedProcessBackend> {
  const entries = trustedEntries(registry);
  if (
    required.some((name) => !EXECUTION_SAFETY_CAPABILITY_NAMES.includes(name))
  )
    throw unavailable();
  for (const entry of entries) {
    try {
      const attestation = parseProcessBackendProbe(
        await entry.backend.probe(fence),
      );
      if (
        attestation.backendId === entry.backendId &&
        required.every((name) => attestation.capabilities[name] === "enforced")
      )
        return freeze({
          ...entry,
          attestation,
          attestationDigest: digestAttestation(attestation),
        });
    } catch {}
  }
  throw unavailable();
}
export async function reattestProcessBackend(
  registry: ProcessBackendRegistry,
  binding: Pick<
    ProcessBackendBinding,
    | "registryId"
    | "backendId"
    | "implementationGeneration"
    | "implementationDigest"
    | "attestationVersion"
    | "attestationDigest"
  >,
  fence?: ProcessEffectFence,
): Promise<SelectedProcessBackend> {
  const entry = trustedEntries(registry).find(
    (candidate) => candidate.registryId === binding.registryId,
  );
  if (
    !entry ||
    entry.backendId !== binding.backendId ||
    entry.implementationGeneration !== binding.implementationGeneration ||
    entry.implementationDigest !== binding.implementationDigest
  )
    throw new Error("Process backend attestation mismatch.");
  return attest(entry, binding, fence);
}
export async function adoptProcessBackendAfterRestart(
  registry: ProcessBackendRegistry,
  binding: Pick<
    ProcessBackendBinding,
    | "backendId"
    | "implementationDigest"
    | "attestationVersion"
    | "attestationDigest"
  >,
  fence?: ProcessEffectFence,
): Promise<SelectedProcessBackend> {
  const matches = trustedEntries(registry).filter(
    (entry) =>
      entry.backendId === binding.backendId &&
      entry.implementationDigest === binding.implementationDigest,
  );
  if (matches.length !== 1)
    throw new Error("Process backend restart adoption mismatch.");
  return attest(matches[0]!, binding, fence);
}
export function digestProcessBackendAttestation(
  attestation: ProcessBackendProbe,
): string {
  return digestAttestation(parseProcessBackendProbe(attestation));
}

function digestAttestation(value: ProcessBackendProbe): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
async function attest(
  entry: TrustedEntry,
  binding: Pick<
    ProcessBackendBinding,
    "backendId" | "attestationVersion" | "attestationDigest"
  >,
  fence?: ProcessEffectFence,
): Promise<SelectedProcessBackend> {
  let attestation: ProcessBackendProbe;
  try {
    attestation = parseProcessBackendProbe(await entry.backend.probe(fence));
  } catch (error) {
    throw new Error("Process backend attestation mismatch.", { cause: error });
  }
  const attestationDigest = digestAttestation(attestation);
  if (
    attestation.backendId !== binding.backendId ||
    attestation.attestationVersion !== binding.attestationVersion ||
    attestationDigest !== binding.attestationDigest
  )
    throw new Error("Process backend attestation mismatch.");
  return freeze({ ...entry, attestation, attestationDigest });
}
function trustedEntries(
  registry: ProcessBackendRegistry,
): readonly TrustedEntry[] {
  if (!registry || typeof registry !== "object" || !REGISTRIES.has(registry))
    throw new Error("Process backend registry authority is invalid.");
  return REGISTRY_ENTRIES.get(registry)!;
}
function record(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    bad();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) bad();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const rawKey of Reflect.ownKeys(descriptors)) {
    if (typeof rawKey !== "string") bad();
    const descriptor = descriptors[rawKey]!;
    if (!("value" in descriptor)) bad();
    result[rawKey] = descriptor.value;
  }
  return result;
}
function keys(o: Record<string, unknown>, allowed: readonly string[]): void {
  const set = new Set(allowed);
  const unexpected = Object.keys(o).find((key) => !set.has(key));
  if (unexpected)
    throw new Error(`Backend response contains unknown field ${unexpected}.`);
  for (const key of allowed) {
    if (
      !Object.hasOwn(o, key) &&
      !["rootPid", "exitCode", "signal", "proofArtifactId"].includes(key)
    )
      throw new Error(`Backend response is missing ${key}.`);
  }
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) bad();
  return value;
}
function safeId(value: unknown): string {
  const result = text(value);
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(result)) bad();
  return result;
}
function digestText(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) bad();
  return value;
}
function integer(
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    bad();
  return value as number;
}
function optionalText<K extends string>(
  o: Record<string, unknown>,
  key: K,
): { [P in K]?: string } {
  return o[key] === undefined
    ? {}
    : ({ [key]: text(o[key]) } as { [P in K]?: string });
}
function bad(): never {
  throw new Error("Backend response is invalid.");
}
function unavailable(): Error {
  return new Error(
    "A verified process backend with required semantic capabilities is unavailable.",
  );
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") Object.freeze(value);
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
