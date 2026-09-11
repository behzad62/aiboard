/** Portable, model-visible execution-safety contracts. No live OS resource belongs here. */
export const EXECUTION_SAFETY_CONTRACT_VERSION = 1 as const;

export const EXECUTION_SAFETY_CAPABILITY_NAMES = Object.freeze([
  "tree_termination",
  "crash_cleanup",
  "verified_emptiness",
  "write_confinement",
] as const);

export const EXECUTION_SAFETY_CAPABILITY_STATES = Object.freeze([
  "enforced",
  "partial",
  "unavailable",
  "unverified",
] as const);

export type ExecutionSafetyCapabilityName =
  (typeof EXECUTION_SAFETY_CAPABILITY_NAMES)[number];
export type ExecutionSafetyCapabilityState =
  (typeof EXECUTION_SAFETY_CAPABILITY_STATES)[number];
export type ExecutionSafetyCapabilities = Readonly<
  Record<ExecutionSafetyCapabilityName, ExecutionSafetyCapabilityState>
>;

export interface ExecutionBackendAttestation {
  readonly backendId: string;
  /** Human-readable implementation mechanism; never used for capability selection. */
  readonly mechanism: string;
  /** Informational host/platform label; never used for capability selection. */
  readonly platformLabel: string;
  readonly capabilities: ExecutionSafetyCapabilities;
}

export interface IsolationProviderAttestation {
  readonly providerId: string;
  readonly mechanism: string;
  readonly platformLabel: string;
  readonly capabilities: ExecutionSafetyCapabilities;
}

export type ExecutionInvocationKind =
  | "command"
  | "language_server"
  | "mcp_server"
  | "configured_provider";

export interface ExecutionInvocationIntent {
  readonly invocationId: string;
  readonly runId: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly kind: ExecutionInvocationKind;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly requestedCapabilities: readonly ExecutionSafetyCapabilityName[];
}

export type ExactPathAccessMode = "read" | "write" | "create";

export interface ExactPathAccess {
  readonly canonicalPath: string;
  readonly mode: ExactPathAccessMode;
}

/** Runner-created, call-bound durable metadata. No bearer token or native handle is persisted. */
const RUNNER_CREATED_GRANT: unique symbol = Symbol("runner-created-execution-grant");

export interface OpaqueOneCallExecutionGrant {
  readonly [RUNNER_CREATED_GRANT]: true;
  readonly grantId: string;
  readonly invocationId: string;
  readonly issuedAt: string;
  readonly expiresAt?: string;
  readonly access: readonly ExactPathAccess[];
  readonly state: "issued" | "consumed" | "revoked";
}

export interface ProcessBirthFingerprint {
  readonly observedAt: string;
  readonly discriminator: string;
}

export interface ExecutionBackendIdentity {
  readonly backendId: string;
  /** Opaque durable identity understood only by the selected Runner backend. */
  readonly opaqueIdentity: string;
}

export type ProcessLifecycleState =
  | "prepared"
  | "running"
  | "terminating"
  | "exited"
  | "cleanup_pending"
  | "cleaned"
  | "cleanup_failed";

export interface ProcessLifecycleHistoryEntry {
  readonly state: ProcessLifecycleState;
  readonly at: string;
  readonly reason?: string;
}

export type ProcessEscalationAction = "interrupt" | "terminate" | "force_terminate";

export interface ProcessEscalationHistoryEntry {
  readonly action: ProcessEscalationAction;
  readonly at: string;
  readonly outcome: "requested" | "observed_exited" | "failed";
  readonly detail?: string;
}

export type ProcessCleanupStatus =
  | { readonly state: "not_required" }
  | { readonly state: "pending" }
  | {
      readonly state: "verified_empty";
      readonly verifiedAt: string;
      readonly proofArtifactId?: string;
    }
  | {
      readonly state: "failed";
      readonly failedAt: string;
      readonly code: string;
      readonly detail: string;
    };

export interface DurableProcessRecord {
  readonly logicalProcessId: string;
  readonly runId: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly invocationId: string;
  readonly rootPid?: number;
  readonly birthFingerprint: ProcessBirthFingerprint;
  readonly backend: ExecutionBackendIdentity;
  readonly attestedCapabilities: ExecutionSafetyCapabilities;
  readonly lifecycle: readonly ProcessLifecycleHistoryEntry[];
  readonly escalation: readonly ProcessEscalationHistoryEntry[];
  readonly logArtifactIds: readonly string[];
  readonly spillArtifactIds: readonly string[];
  readonly cleanup: ProcessCleanupStatus;
}

export type ProcessOutputStream = "stdout" | "stderr";

export interface ProcessOutputDisposition {
  readonly stream: ProcessOutputStream;
  readonly tail: string;
  /** Exact bounded bytes, distinct from the UTF8/loss-marked display. Legacy
   * records omit both fields; missing raw bytes are never reconstructed. */
  readonly tailBytesBase64?: string;
  readonly tailByteLength?: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly spillArtifactId?: string;
  readonly spillBytes: number;
  readonly lossyBytes: number;
}

export interface GenericProcessResult {
  readonly logicalProcessId: string;
  readonly outcome: "exited" | "timed_out" | "cancelled" | "launch_failed" | "cleanup_failed";
  readonly exitCode?: number;
  readonly signal?: string;
  readonly startedAt?: string;
  readonly finishedAt: string;
  readonly output: readonly ProcessOutputDisposition[];
  readonly cleanup: ProcessCleanupStatus;
}

export interface IsolationLease {
  readonly leaseId: string;
  readonly providerId: string;
  readonly invocationId: string;
  readonly grantedAccess: readonly ExactPathAccess[];
  readonly acquiredAt: string;
  readonly expiresAt?: string;
  readonly state: "active" | "released" | "revocation_failed";
}

export interface ExceptionalRecoveryProposal {
  readonly proposalId: string;
  readonly logicalProcessId: string;
  readonly birthFingerprint: ProcessBirthFingerprint;
  readonly requestedAction: "inspect" | "terminate" | "remove_owned_artifact";
  readonly targetScope: readonly string[];
  readonly rationale: string;
  readonly requiresUserAuthority: boolean;
}

export interface ExceptionalRecoveryOutcome {
  readonly proposalId: string;
  readonly state: "rejected" | "authorized" | "executed" | "failed";
  readonly decidedAt: string;
  readonly detail: string;
  readonly evidenceArtifactIds: readonly string[];
}

/** Runner-owned portable lifecycle seam. Implementations keep live resources private. */
export interface ExecutionBackend {
  attest(): Promise<ExecutionBackendAttestation>;
  launch(
    intent: ExecutionInvocationIntent,
    grant?: OpaqueOneCallExecutionGrant,
  ): Promise<DurableProcessRecord>;
  terminate(process: DurableProcessRecord): Promise<ProcessCleanupStatus>;
  inspectCleanup(process: DurableProcessRecord): Promise<ProcessCleanupStatus>;
}

/** Runner-owned confinement-provider seam. Availability is read from its attestation. */
export interface IsolationProvider {
  attest(): Promise<IsolationProviderAttestation>;
  acquire(
    intent: ExecutionInvocationIntent,
    grant: OpaqueOneCallExecutionGrant,
  ): Promise<IsolationLease>;
  release(lease: IsolationLease): Promise<IsolationLease>;
}

const CAPABILITY_NAMES = new Set<string>(EXECUTION_SAFETY_CAPABILITY_NAMES);
const CAPABILITY_STATES = new Set<string>(EXECUTION_SAFETY_CAPABILITY_STATES);
const BACKEND_ATTESTATION_KEYS = new Set([
  "backendId",
  "mechanism",
  "platformLabel",
  "capabilities",
]);
const PROVIDER_ATTESTATION_KEYS = new Set([
  "providerId",
  "mechanism",
  "platformLabel",
  "capabilities",
]);
const FORBIDDEN_DURABLE_KEYS = new Set([
  "handle",
  "nativehandle",
  "processhandle",
  "token",
  "accesstoken",
  "refreshtoken",
  "credential",
  "credentialvalue",
  "secret",
  "secretvalue",
  "password",
  "apikey",
  "privatekey",
  "liveprocess",
  "childprocess",
]);

export function parseExecutionBackendAttestation(value: unknown): ExecutionBackendAttestation {
  const object = requiredObject(value, "execution backend attestation");
  assertClosedKeys(object, BACKEND_ATTESTATION_KEYS, "execution backend attestation");
  const capabilities = parseExecutionSafetyCapabilities(object.capabilities);
  return {
    backendId: requiredString(object.backendId, "backendId"),
    mechanism: requiredString(object.mechanism, "mechanism"),
    platformLabel: requiredString(object.platformLabel, "platformLabel"),
    capabilities,
  };
}

export function parseExecutionSafetyCapabilities(value: unknown): ExecutionSafetyCapabilities {
  const object = requiredObject(value, "execution-safety capabilities");
  for (const key of Object.keys(object)) {
    if (!CAPABILITY_NAMES.has(key)) {
      throw new Error(`Execution-safety capabilities contain unknown capability ${key}.`);
    }
  }
  const capabilities = {} as Record<ExecutionSafetyCapabilityName, ExecutionSafetyCapabilityState>;
  for (const name of EXECUTION_SAFETY_CAPABILITY_NAMES) {
    const state = object[name];
    if (typeof state !== "string" || !CAPABILITY_STATES.has(state)) {
      throw new Error(`Execution-safety capability ${name} has an invalid state.`);
    }
    capabilities[name] = state as ExecutionSafetyCapabilityState;
  }
  return capabilities;
}

export function parseIsolationProviderAttestation(value: unknown): IsolationProviderAttestation {
  const object = requiredObject(value, "isolation provider attestation");
  assertClosedKeys(object, PROVIDER_ATTESTATION_KEYS, "isolation provider attestation");
  return {
    providerId: requiredString(object.providerId, "providerId"),
    mechanism: requiredString(object.mechanism, "mechanism"),
    platformLabel: requiredString(object.platformLabel, "platformLabel"),
    capabilities: parseExecutionSafetyCapabilities(object.capabilities),
  };
}

export function parseExecutionInvocationIntent(value: unknown): ExecutionInvocationIntent {
  const object = closedObject(value, [
    "invocationId", "runId", "taskId", "sessionId", "kind", "executable",
    "arguments", "workingDirectory", "requestedCapabilities",
  ], "execution invocation intent");
  return {
    invocationId: requiredString(object.invocationId, "invocationId"),
    runId: requiredString(object.runId, "runId"),
    ...optionalStringProperty(object, "taskId"),
    ...optionalStringProperty(object, "sessionId"),
    kind: requiredEnum(object.kind, [
      "command", "language_server", "mcp_server", "configured_provider",
    ], "invocation kind"),
    executable: requiredString(object.executable, "executable"),
    arguments: stringArray(object.arguments, "arguments"),
    workingDirectory: requiredString(object.workingDirectory, "workingDirectory"),
    requestedCapabilities: capabilityNameArray(object.requestedCapabilities),
  };
}

/** The only model-input invocation decoder. Grant fields are intentionally not in its closed shape. */
export function parseModelExecutionInvocationIntent(value: unknown): ExecutionInvocationIntent {
  return parseExecutionInvocationIntent(value);
}

export function parseExactPathAccess(value: unknown): ExactPathAccess {
  const object = closedObject(value, ["canonicalPath", "mode"], "exact path access");
  return {
    canonicalPath: requiredString(object.canonicalPath, "canonicalPath"),
    mode: requiredEnum(object.mode, ["read", "write", "create"], "path access mode"),
  };
}

/** Trusted Runner restore seam; model input must use parseModelExecutionInvocationIntent. */
export function parseOpaqueOneCallExecutionGrant(value: unknown): OpaqueOneCallExecutionGrant {
  const object = closedObject(value, [
    "grantId", "invocationId", "issuedAt", "expiresAt", "access", "state",
  ], "opaque one-call execution grant");
  const grant = {
    grantId: requiredString(object.grantId, "grantId"),
    invocationId: requiredString(object.invocationId, "invocationId"),
    issuedAt: requiredString(object.issuedAt, "issuedAt"),
    ...optionalStringProperty(object, "expiresAt"),
    access: objectArray(object.access, "access", parseExactPathAccess),
    state: requiredEnum(object.state, ["issued", "consumed", "revoked"], "grant state"),
  };
  Object.defineProperty(grant, RUNNER_CREATED_GRANT, { value: true });
  return grant as unknown as OpaqueOneCallExecutionGrant;
}

export function createOpaqueOneCallExecutionGrant(value: unknown): OpaqueOneCallExecutionGrant {
  return parseOpaqueOneCallExecutionGrant(value);
}

export function parseProcessBirthFingerprint(value: unknown): ProcessBirthFingerprint {
  const object = closedObject(value, ["observedAt", "discriminator"], "process birth fingerprint");
  return {
    observedAt: requiredString(object.observedAt, "observedAt"),
    discriminator: requiredString(object.discriminator, "discriminator"),
  };
}

export function parseExecutionBackendIdentity(value: unknown): ExecutionBackendIdentity {
  const object = closedObject(value, ["backendId", "opaqueIdentity"], "execution backend identity");
  return {
    backendId: requiredString(object.backendId, "backendId"),
    opaqueIdentity: requiredString(object.opaqueIdentity, "opaqueIdentity"),
  };
}

export function parseProcessLifecycleHistoryEntry(value: unknown): ProcessLifecycleHistoryEntry {
  const object = closedObject(value, ["state", "at", "reason"], "process lifecycle history entry");
  return {
    state: requiredEnum(object.state, [
      "prepared", "running", "terminating", "exited", "cleanup_pending",
      "cleaned", "cleanup_failed",
    ], "process lifecycle state"),
    at: requiredString(object.at, "at"),
    ...optionalStringProperty(object, "reason"),
  };
}

export function parseProcessEscalationHistoryEntry(value: unknown): ProcessEscalationHistoryEntry {
  const object = closedObject(value, ["action", "at", "outcome", "detail"], "process escalation history entry");
  return {
    action: requiredEnum(object.action, [
      "interrupt", "terminate", "force_terminate",
    ], "process escalation action"),
    at: requiredString(object.at, "at"),
    outcome: requiredEnum(object.outcome, [
      "requested", "observed_exited", "failed",
    ], "process escalation outcome"),
    ...optionalStringProperty(object, "detail"),
  };
}

export function parseProcessCleanupStatus(value: unknown): ProcessCleanupStatus {
  const object = requiredObject(value, "process cleanup status");
  const state = requiredEnum(object.state, [
    "not_required", "pending", "verified_empty", "failed",
  ], "process cleanup state");
  if (state === "not_required" || state === "pending") {
    assertClosedKeys(object, new Set(["state"]), "process cleanup status");
    return { state };
  }
  if (state === "verified_empty") {
    assertClosedKeys(object, new Set(["state", "verifiedAt", "proofArtifactId"]), "process cleanup status");
    return {
      state,
      verifiedAt: requiredString(object.verifiedAt, "verifiedAt"),
      ...optionalStringProperty(object, "proofArtifactId"),
    };
  }
  assertClosedKeys(object, new Set(["state", "failedAt", "code", "detail"]), "process cleanup status");
  return {
    state,
    failedAt: requiredString(object.failedAt, "failedAt"),
    code: requiredString(object.code, "code"),
    detail: requiredString(object.detail, "detail"),
  };
}

export function parseProcessOutputDisposition(value: unknown): ProcessOutputDisposition {
  const object = closedObject(value, [
    "stream", "tail", "totalBytes", "truncated", "spillArtifactId",
    "spillBytes", "lossyBytes", "tailBytesBase64", "tailByteLength",
  ], "process output disposition");
  const totalBytes = nonNegativeInteger(object.totalBytes, "totalBytes");
  const truncated = requiredBoolean(object.truncated, "truncated");
  let exactTail: { tailBytesBase64: string; tailByteLength: number } | undefined;
  if (object.tailBytesBase64 !== undefined || object.tailByteLength !== undefined) {
    const encoded = object.tailBytesBase64;
    const length = nonNegativeInteger(object.tailByteLength, "tailByteLength");
    // Bound before decoding. These are the shared 128KiB raw tail, not another
    // unbounded output buffer and not a claim that private spill succeeded.
    if (typeof encoded !== "string" || length > 128 * 1024 ||
        encoded.length > 4 * Math.ceil(128 * 1024 / 3) || length > totalBytes ||
        truncated !== (length < totalBytes)) throw new Error("Exact output tail bounds are invalid.");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length !== length || bytes.toString("base64") !== encoded)
      throw new Error("Exact output tail encoding is invalid.");
    exactTail = { tailBytesBase64: encoded, tailByteLength: length };
  }
  return {
    stream: requiredEnum(object.stream, ["stdout", "stderr"], "process output stream"),
    tail: requiredString(object.tail, "tail", true),
    ...exactTail,
    totalBytes,
    truncated,
    ...optionalStringProperty(object, "spillArtifactId"),
    spillBytes: nonNegativeInteger(object.spillBytes, "spillBytes"),
    lossyBytes: nonNegativeInteger(object.lossyBytes, "lossyBytes"),
  };
}

export function parseDurableProcessRecord(value: unknown): DurableProcessRecord {
  const object = closedObject(value, [
    "logicalProcessId", "runId", "taskId", "sessionId", "invocationId",
    "rootPid", "birthFingerprint", "backend", "attestedCapabilities",
    "lifecycle", "escalation", "logArtifactIds", "spillArtifactIds", "cleanup",
  ], "durable process record");
  return {
    logicalProcessId: requiredString(object.logicalProcessId, "logicalProcessId"),
    runId: requiredString(object.runId, "runId"),
    ...optionalStringProperty(object, "taskId"),
    ...optionalStringProperty(object, "sessionId"),
    invocationId: requiredString(object.invocationId, "invocationId"),
    ...optionalPositiveIntegerProperty(object, "rootPid"),
    birthFingerprint: parseProcessBirthFingerprint(object.birthFingerprint),
    backend: parseExecutionBackendIdentity(object.backend),
    attestedCapabilities: parseExecutionSafetyCapabilities(object.attestedCapabilities),
    lifecycle: objectArray(object.lifecycle, "lifecycle", parseProcessLifecycleHistoryEntry),
    escalation: objectArray(object.escalation, "escalation", parseProcessEscalationHistoryEntry),
    logArtifactIds: stringArray(object.logArtifactIds, "logArtifactIds"),
    spillArtifactIds: stringArray(object.spillArtifactIds, "spillArtifactIds"),
    cleanup: parseProcessCleanupStatus(object.cleanup),
  };
}

export function parseGenericProcessResult(value: unknown): GenericProcessResult {
  const object = closedObject(value, [
    "logicalProcessId", "outcome", "exitCode", "signal", "startedAt",
    "finishedAt", "output", "cleanup",
  ], "generic process result");
  return {
    logicalProcessId: requiredString(object.logicalProcessId, "logicalProcessId"),
    outcome: requiredEnum(object.outcome, [
      "exited", "timed_out", "cancelled", "launch_failed", "cleanup_failed",
    ], "process result outcome"),
    ...optionalIntegerProperty(object, "exitCode"),
    ...optionalStringProperty(object, "signal"),
    ...optionalStringProperty(object, "startedAt"),
    finishedAt: requiredString(object.finishedAt, "finishedAt"),
    output: objectArray(object.output, "output", parseProcessOutputDisposition),
    cleanup: parseProcessCleanupStatus(object.cleanup),
  };
}

export function parseIsolationLease(value: unknown): IsolationLease {
  const object = closedObject(value, [
    "leaseId", "providerId", "invocationId", "grantedAccess", "acquiredAt",
    "expiresAt", "state",
  ], "isolation lease");
  return {
    leaseId: requiredString(object.leaseId, "leaseId"),
    providerId: requiredString(object.providerId, "providerId"),
    invocationId: requiredString(object.invocationId, "invocationId"),
    grantedAccess: objectArray(object.grantedAccess, "grantedAccess", parseExactPathAccess),
    acquiredAt: requiredString(object.acquiredAt, "acquiredAt"),
    ...optionalStringProperty(object, "expiresAt"),
    state: requiredEnum(object.state, [
      "active", "released", "revocation_failed",
    ], "isolation lease state"),
  };
}

export function parseExceptionalRecoveryProposal(value: unknown): ExceptionalRecoveryProposal {
  const object = closedObject(value, [
    "proposalId", "logicalProcessId", "birthFingerprint", "requestedAction",
    "targetScope", "rationale", "requiresUserAuthority",
  ], "exceptional recovery proposal");
  return {
    proposalId: requiredString(object.proposalId, "proposalId"),
    logicalProcessId: requiredString(object.logicalProcessId, "logicalProcessId"),
    birthFingerprint: parseProcessBirthFingerprint(object.birthFingerprint),
    requestedAction: requiredEnum(object.requestedAction, [
      "inspect", "terminate", "remove_owned_artifact",
    ], "exceptional recovery action"),
    targetScope: stringArray(object.targetScope, "targetScope"),
    rationale: requiredString(object.rationale, "rationale"),
    requiresUserAuthority: requiredBoolean(object.requiresUserAuthority, "requiresUserAuthority"),
  };
}

export function parseExceptionalRecoveryOutcome(value: unknown): ExceptionalRecoveryOutcome {
  const object = closedObject(value, [
    "proposalId", "state", "decidedAt", "detail", "evidenceArtifactIds",
  ], "exceptional recovery outcome");
  return {
    proposalId: requiredString(object.proposalId, "proposalId"),
    state: requiredEnum(object.state, [
      "rejected", "authorized", "executed", "failed",
    ], "exceptional recovery outcome state"),
    decidedAt: requiredString(object.decidedAt, "decidedAt"),
    detail: requiredString(object.detail, "detail"),
    evidenceArtifactIds: stringArray(object.evidenceArtifactIds, "evidenceArtifactIds"),
  };
}

export function cloneExecutionBackendAttestation(
  value: ExecutionBackendAttestation,
): ExecutionBackendAttestation {
  return parseExecutionBackendAttestation(value);
}

export function cloneIsolationProviderAttestation(
  value: IsolationProviderAttestation,
): IsolationProviderAttestation {
  return parseIsolationProviderAttestation(value);
}

export const cloneExecutionInvocationIntent = parseExecutionInvocationIntent;
export const cloneExactPathAccess = parseExactPathAccess;
export const cloneOpaqueOneCallExecutionGrant = parseOpaqueOneCallExecutionGrant;
export const cloneProcessBirthFingerprint = parseProcessBirthFingerprint;
export const cloneExecutionBackendIdentity = parseExecutionBackendIdentity;
export const cloneProcessLifecycleHistoryEntry = parseProcessLifecycleHistoryEntry;
export const cloneProcessEscalationHistoryEntry = parseProcessEscalationHistoryEntry;
export const cloneProcessCleanupStatus = parseProcessCleanupStatus;
export const cloneProcessOutputDisposition = parseProcessOutputDisposition;
export const cloneDurableProcessRecord = parseDurableProcessRecord;
export const cloneGenericProcessResult = parseGenericProcessResult;
export const cloneIsolationLease = parseIsolationLease;
export const cloneExceptionalRecoveryProposal = parseExceptionalRecoveryProposal;
export const cloneExceptionalRecoveryOutcome = parseExceptionalRecoveryOutcome;

export function executionSafetyCapabilitiesSatisfy(
  available: ExecutionSafetyCapabilities,
  required: readonly ExecutionSafetyCapabilityName[],
): boolean {
  return required.every((name) => available[name] === "enforced");
}

/** Rejects values that cannot cross the durable/model-visible JSON boundary. */
export function assertDurableExecutionSafetyValue(value: unknown): void {
  visitDurableValue(value, "$", new Set<object>());
}

function visitDurableValue(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error(`Execution-safety durable value at ${path} is cyclic.`);
    ancestors.add(value);
    value.forEach((entry, index) => visitDurableValue(entry, `${path}[${index}]`, ancestors));
    ancestors.delete(value);
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error(`Execution-safety value at ${path} is not a durable JSON value.`);
  }
  if (ancestors.has(value)) throw new Error(`Execution-safety durable value at ${path} is cyclic.`);
  ancestors.add(value);
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (
      FORBIDDEN_DURABLE_KEYS.has(normalizedKey) ||
      normalizedKey.includes("token") ||
      normalizedKey.includes("credential") ||
      normalizedKey === "fd" ||
      normalizedKey.includes("descriptor") ||
      normalizedKey.includes("nativefd") ||
      (normalizedKey.includes("native") && normalizedKey.includes("handle"))
    ) {
      throw new Error(`Execution-safety durable value contains forbidden field ${key}.`);
    }
    if (entry === undefined) {
      throw new Error(`Execution-safety value at ${path}.${key} is not a durable JSON value.`);
    }
    visitDurableValue(entry, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function closedObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const object = requiredObject(value, label);
  assertClosedKeys(object, new Set(keys), label);
  return object;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertClosedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label} contains unknown field ${unknown}.`);
}

function requiredString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`Execution backend attestation ${label} must be a non-empty string.`);
  }
  return value;
}

function optionalStringProperty<K extends string>(
  object: Record<string, unknown>,
  key: K,
): { [P in K]?: string } {
  if (object[key] === undefined) return {};
  return { [key]: requiredString(object[key], key) } as { [P in K]?: string };
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function requiredEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as T[number];
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return [...value] as string[];
}

function capabilityNameArray(value: unknown): ExecutionSafetyCapabilityName[] {
  const names = stringArray(value, "requestedCapabilities");
  if (names.some((name) => !CAPABILITY_NAMES.has(name))) {
    throw new Error("requestedCapabilities contains an unknown capability.");
  }
  return names as ExecutionSafetyCapabilityName[];
}

function objectArray<T>(
  value: unknown,
  label: string,
  parse: (entry: unknown) => T,
): T[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map(parse);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value as number;
}

function optionalIntegerProperty<K extends string>(
  object: Record<string, unknown>,
  key: K,
): { [P in K]?: number } {
  if (object[key] === undefined) return {};
  if (!Number.isSafeInteger(object[key])) throw new Error(`${key} must be an integer.`);
  return { [key]: object[key] } as { [P in K]?: number };
}

function optionalPositiveIntegerProperty<K extends string>(
  object: Record<string, unknown>,
  key: K,
): { [P in K]?: number } {
  if (object[key] === undefined) return {};
  if (!Number.isSafeInteger(object[key]) || (object[key] as number) < 1) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return { [key]: object[key] } as { [P in K]?: number };
}
