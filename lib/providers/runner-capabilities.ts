import {
  isProviderTransportId,
  isToolCapabilityDescriptor,
  type CapabilityEvidence,
  type CapabilityPrerequisite,
  type ProviderTransportId,
  type ToolCapabilityDescriptor,
} from "./tool-capabilities";

export const RUNNER_CAPABILITY_SCHEMA_VERSION = 1 as const;

export type RunnerCapabilityProviderId =
  | "chatgpt"
  | "github-copilot"
  | "nvidia";

export interface RunnerModelCapabilityRecord {
  modelId: string;
  transports?: ProviderTransportId[];
  capabilities: ToolCapabilityDescriptor[];
}

export interface RunnerExecutionCapability {
  id: string;
  available: boolean;
  transports?: ProviderTransportId[];
  detail?: string;
}

export interface RunnerCapabilityHandshake {
  schemaVersion: 1;
  runnerVersion: number;
  providerId: RunnerCapabilityProviderId;
  transports: ProviderTransportId[];
  capabilities: ToolCapabilityDescriptor[];
  models?: RunnerModelCapabilityRecord[];
  execution?: RunnerExecutionCapability[];
  prerequisites?: CapabilityPrerequisite[];
}

export type RunnerCapabilityValidationResult =
  | { status: "valid"; handshake: RunnerCapabilityHandshake }
  | { status: "unsupported_schema"; observedSchemaVersion?: number }
  | { status: "stale_runner"; runnerVersion: number; minimumRunnerVersion: number }
  | { status: "invalid"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validProviderId(value: unknown): value is RunnerCapabilityProviderId {
  return value === "chatgpt" || value === "github-copilot" || value === "nvidia";
}

function validTransports(value: unknown): value is ProviderTransportId[] {
  return Array.isArray(value) && value.every(isProviderTransportId);
}

function validPrerequisite(value: unknown): value is CapabilityPrerequisite {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" && value.id.length > 0 &&
    typeof value.label === "string" && value.label.length > 0 &&
    (value.kind === "resource" || value.kind === "configuration" ||
      value.kind === "account" || value.kind === "runtime") &&
    (value.description === undefined || typeof value.description === "string") &&
    (value.configurationPath === undefined || typeof value.configurationPath === "string")
  );
}

function validRunnerDescriptor(value: unknown): value is ToolCapabilityDescriptor {
  return isToolCapabilityDescriptor(value) && value.supportSource === "runner";
}

function validModelRecord(value: unknown): value is RunnerModelCapabilityRecord {
  if (!isRecord(value) || typeof value.modelId !== "string" || !value.modelId.trim()) return false;
  if (value.transports !== undefined && !validTransports(value.transports)) return false;
  return Array.isArray(value.capabilities) && value.capabilities.every(validRunnerDescriptor);
}

function validExecution(value: unknown): value is RunnerExecutionCapability {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) return false;
  if (typeof value.available !== "boolean") return false;
  if (value.transports !== undefined && !validTransports(value.transports)) return false;
  return value.detail === undefined || typeof value.detail === "string";
}

export function validateRunnerCapabilityHandshake(
  value: unknown,
  options: { minimumRunnerVersion?: number } = {},
): RunnerCapabilityValidationResult {
  if (!isRecord(value)) return { status: "invalid", reason: "Handshake is not an object" };
  if (value.schemaVersion !== RUNNER_CAPABILITY_SCHEMA_VERSION) {
    return {
      status: "unsupported_schema",
      ...(typeof value.schemaVersion === "number"
        ? { observedSchemaVersion: value.schemaVersion }
        : {}),
    };
  }
  if (!Number.isInteger(value.runnerVersion) || Number(value.runnerVersion) <= 0) {
    return { status: "invalid", reason: "runnerVersion must be a positive integer" };
  }
  const runnerVersion = Number(value.runnerVersion);
  if (
    options.minimumRunnerVersion !== undefined &&
    runnerVersion < options.minimumRunnerVersion
  ) {
    return {
      status: "stale_runner",
      runnerVersion,
      minimumRunnerVersion: options.minimumRunnerVersion,
    };
  }
  if (!validProviderId(value.providerId)) {
    return { status: "invalid", reason: "Unknown runner provider id" };
  }
  if (!validTransports(value.transports) || value.transports.length === 0) {
    return { status: "invalid", reason: "Runner transports are invalid" };
  }
  if (!Array.isArray(value.capabilities) || !value.capabilities.every(validRunnerDescriptor)) {
    return { status: "invalid", reason: "Runner capabilities are invalid" };
  }
  if (value.models !== undefined && (!Array.isArray(value.models) || !value.models.every(validModelRecord))) {
    return { status: "invalid", reason: "Runner model capabilities are invalid" };
  }
  if (
    value.execution !== undefined &&
    (!Array.isArray(value.execution) || !value.execution.every(validExecution))
  ) {
    return { status: "invalid", reason: "Runner execution capabilities are invalid" };
  }
  if (
    value.prerequisites !== undefined &&
    (!Array.isArray(value.prerequisites) || !value.prerequisites.every(validPrerequisite))
  ) {
    return { status: "invalid", reason: "Runner prerequisites are invalid" };
  }
  return { status: "valid", handshake: value as unknown as RunnerCapabilityHandshake };
}

export function runnerCapabilityEvidence(
  result: RunnerCapabilityValidationResult,
  modelId: string,
): CapabilityEvidence[] {
  if (result.status !== "valid") return [];
  const descriptors = new Map(
    result.handshake.capabilities.map((descriptor) => [descriptor.id, descriptor]),
  );
  const model = result.handshake.models?.find((candidate) => candidate.modelId === modelId);
  for (const descriptor of model?.capabilities ?? []) descriptors.set(descriptor.id, descriptor);
  return [...descriptors.values()].map((descriptor) => ({
    providerId: result.handshake.providerId,
    modelId,
    capabilityId: descriptor.id,
    support: descriptor.support,
    execution: descriptor.execution,
    transport:
      descriptor.transports.find((transport) =>
        (model?.transports ?? result.handshake.transports).includes(transport),
      ) ?? descriptor.transports[0],
    source: "runner" as const,
    verifiedAt: descriptor.verifiedAt,
  }));
}

export async function fetchRunnerCapabilityHandshake(input: {
  baseURL: string;
  runnerToken: string;
  providerId: RunnerCapabilityProviderId;
  apiKey?: string;
  signal?: AbortSignal;
  minimumRunnerVersion?: number;
}): Promise<RunnerCapabilityValidationResult> {
  const baseURL = input.baseURL.trim().replace(/\/$/, "");
  if (!baseURL || !input.runnerToken.trim()) {
    return { status: "invalid", reason: "Runner URL and token are required" };
  }
  try {
    const response = await fetch(`${baseURL}/providers/${input.providerId}/capabilities`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-runner-token": input.runnerToken.trim(),
      },
      body: JSON.stringify(input.apiKey ? { apiKey: input.apiKey } : {}),
      signal: input.signal,
    });
    if (!response.ok) {
      return { status: "invalid", reason: `Runner capability request failed (${response.status})` };
    }
    const parsed = validateRunnerCapabilityHandshake(await response.json(), {
      minimumRunnerVersion: input.minimumRunnerVersion,
    });
    if (parsed.status === "valid" && parsed.handshake.providerId !== input.providerId) {
      return { status: "invalid", reason: "Runner capability provider mismatch" };
    }
    return parsed;
  } catch (error) {
    return {
      status: "invalid",
      reason: error instanceof Error ? error.message : "Runner capability request failed",
    };
  }
}
