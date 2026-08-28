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
export interface OpaqueOneCallExecutionGrant {
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

export function cloneExecutionSafetyValue<T>(value: T): T {
  assertDurableExecutionSafetyValue(value);
  return structuredClone(value);
}

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

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Execution backend attestation ${label} must be a non-empty string.`);
  }
  return value;
}
