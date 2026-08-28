import {
  EXECUTION_SAFETY_CAPABILITY_NAMES,
  parseExecutionSafetyCapabilities,
  type ExecutionBackendIdentity,
  type ExecutionInvocationIntent,
  type ExecutionSafetyCapabilities,
  type ExecutionSafetyCapabilityName,
  type OpaqueOneCallExecutionGrant,
  type ProcessBirthFingerprint,
  type ProcessEscalationAction,
  type ProcessOutputStream,
} from "./execution-safety-contracts.js";
import { types as nodeTypes } from "node:util";

export interface ProcessBackendProbe {
  readonly backendId: string;
  readonly verified: true;
  readonly platformLabel: string;
  readonly capabilities: ExecutionSafetyCapabilities;
}

export interface ProcessBackendBinding {
  readonly backend: ExecutionBackendIdentity;
  readonly birthFingerprint: ProcessBirthFingerprint;
  readonly rootPid?: number;
}

export interface ProcessLaunchResult extends ProcessBackendBinding {
  readonly startedAt: string;
}

export interface ProcessObservation {
  readonly exitCode?: number;
  readonly signal?: string;
}

export type ProcessSignalResult =
  | { readonly state: "running" }
  | { readonly state: "exited" };

export type ProcessEmptyVerification =
  | { readonly empty: true; readonly proofArtifactId?: string }
  | { readonly empty: false; readonly detail: string };

export type ProcessReconciliation =
  | { readonly state: "running" }
  | { readonly state: "exited"; readonly exitCode?: number; readonly signal?: string }
  | { readonly state: "identity_mismatch" }
  | { readonly state: "outcome_unknown" };

export interface ProcessLaunchRequest {
  readonly intent: ExecutionInvocationIntent;
  readonly grant?: OpaqueOneCallExecutionGrant;
  /** Ephemeral and call-scoped. Backends must never return or persist it. */
  readonly environment: Readonly<Record<string, string>>;
}

export interface ProcessBackend {
  readonly backendId: string;
  probe(): Promise<unknown>;
  launch(request: ProcessLaunchRequest): Promise<ProcessLaunchResult>;
  observe(
    binding: ProcessBackendBinding,
    output: (stream: ProcessOutputStream, bytes: Uint8Array) => Promise<void>,
  ): Promise<ProcessObservation>;
  signal(binding: ProcessBackendBinding, action: ProcessEscalationAction): Promise<ProcessSignalResult>;
  verifyEmpty(binding: ProcessBackendBinding): Promise<ProcessEmptyVerification>;
  reconcile(binding: ProcessBackendBinding): Promise<ProcessReconciliation>;
  release(binding: ProcessBackendBinding): Promise<void>;
}

const PROBE_KEYS = new Set(["backendId", "verified", "platformLabel", "capabilities"]);

export function parseProcessBackendProbe(value: unknown): ProcessBackendProbe {
  const record = strictDataRecord(value);
  if (!record || Object.keys(record).some((key) => !PROBE_KEYS.has(key))) {
    throw new Error("A verified process backend probe is required.");
  }
  if (
    typeof record.backendId !== "string" || !record.backendId.trim() ||
    record.verified !== true ||
    typeof record.platformLabel !== "string" || !record.platformLabel.trim()
  ) {
    throw new Error("A verified process backend probe is required.");
  }
  const capabilityRecord = strictDataRecord(record.capabilities);
  if (!capabilityRecord) throw new Error("A verified process backend probe is required.");
  const capabilities = Object.freeze(parseExecutionSafetyCapabilities(capabilityRecord));
  return Object.freeze({
    backendId: record.backendId,
    verified: true,
    platformLabel: record.platformLabel,
    capabilities,
  });
}

export async function selectProcessBackend(
  backends: readonly ProcessBackend[],
  required: readonly ExecutionSafetyCapabilityName[],
): Promise<ProcessBackend> {
  if (required.some((name) => !EXECUTION_SAFETY_CAPABILITY_NAMES.includes(name))) {
    throw new Error("A verified process backend with required semantic capabilities is unavailable.");
  }
  for (const backend of backends) {
    try {
      const probe = parseProcessBackendProbe(await backend.probe());
      if (probe.backendId !== backend.backendId) continue;
      if (required.every((name) => probe.capabilities[name] === "enforced")) return backend;
    } catch {
      // A backend controls its probe value, so malformed claims are unavailable.
    }
  }
  throw new Error("A verified process backend with required semantic capabilities is unavailable.");
}

function strictDataRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || nodeTypes.isProxy(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) return undefined;
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) return undefined;
    result[key] = descriptor.value;
  }
  return result;
}
