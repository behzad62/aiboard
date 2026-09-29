export const TOOL_CAPABILITY_IDS = [
  "function_calling",
  "web_search",
  "web_fetch",
  "file_search",
  "url_context",
  "maps",
  "x_search",
  "code_execution",
  "shell",
  "apply_patch",
  "computer_use",
  "browser_use",
  "image_generation",
  "remote_mcp",
  "tool_search",
  "advisor",
  "subagent",
  "fusion",
  "datetime",
  "memory",
] as const;

export type ToolCapabilityId = (typeof TOOL_CAPABILITY_IDS)[number];

export const PROVIDER_TRANSPORT_IDS = [
  "responses",
  "chat_completions",
  "messages",
  "gemini_interactions",
  "gemini_generate_content",
  "copilot_sdk",
  "runner_proxy",
] as const;

export type ProviderTransportId = (typeof PROVIDER_TRANSPORT_IDS)[number];

export const TOOL_SUPPORT_STATUSES = [
  "supported",
  "conditional",
  "unsupported",
  "unknown",
] as const;
export type ToolSupportStatus = (typeof TOOL_SUPPORT_STATUSES)[number];

export const TOOL_EXECUTION_LOCATIONS = [
  "provider",
  "client",
  "runner",
  "orchestrator",
] as const;
export type ToolExecutionLocation = (typeof TOOL_EXECUTION_LOCATIONS)[number];

export const CAPABILITY_SUPPORT_SOURCES = [
  "provider-docs",
  "provider-catalog",
  "runner",
  "user-override",
] as const;
export type CapabilitySupportSource = (typeof CAPABILITY_SUPPORT_SOURCES)[number];

export type CapabilityPrerequisiteKind =
  | "resource"
  | "configuration"
  | "account"
  | "runtime";

export interface CapabilityPrerequisite {
  id: string;
  label: string;
  kind: CapabilityPrerequisiteKind;
  description?: string;
  configurationPath?: string;
}

export type ToolCombinationWhen =
  | "structured_output"
  | "reasoning"
  | "attachments"
  | "parallel_tools"
  | "tool_choice";

export type ToolCombinationEffect =
  | "forbid"
  | "requires_transport"
  | "requires_tool_choice";

export interface ToolCombinationConstraint {
  when: ToolCombinationWhen;
  effect: ToolCombinationEffect;
  value?: string;
  reason: string;
}

export interface ToolCapabilityDescriptor {
  id: ToolCapabilityId;
  support: ToolSupportStatus;
  execution: ToolExecutionLocation;
  transports: ProviderTransportId[];
  prerequisites?: CapabilityPrerequisite[];
  constraints?: ToolCombinationConstraint[];
  supportSource: CapabilitySupportSource;
  verifiedAt?: string;
}

export interface ToolIntent {
  id: ToolCapabilityId;
  requirement: "optional" | "required";
  parameters?: Record<string, unknown>;
}

export interface CapabilityEvidence {
  providerId: string;
  modelId?: string;
  capabilityId: ToolCapabilityId;
  transport?: ProviderTransportId;
  support: ToolSupportStatus;
  execution?: ToolExecutionLocation;
  source: CapabilitySupportSource;
  verifiedAt?: string;
  expiresAt?: string;
  detail?: string;
}

export interface ToolResourceConfigEntry {
  configured: boolean;
  referenceIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface ToolResourceConfig {
  prerequisites: Record<string, ToolResourceConfigEntry>;
}

export interface ToolResourceStateEntry {
  ready: boolean;
  reason?: string;
}

export interface ToolResourceState {
  prerequisites: Record<string, ToolResourceStateEntry>;
}

export type NormalizedToolChoice = "auto" | "none" | "required" | { name: string };

export interface ProviderCallFeatures {
  structuredOutput?: boolean;
  reasoning?: boolean;
  attachments?: boolean;
  parallelTools?: boolean;
  toolChoice?: NormalizedToolChoice;
  mode?: "discussion" | "build" | "benchmark" | "test";
}

export type CapabilityDecisionCode =
  | "unsupported"
  | "unknown"
  | "conditional_unverified"
  | "missing_prerequisite"
  | "transport_incompatible"
  | "combination_forbidden"
  | "duplicate_mcp_path"
  | "invalid_evidence"
  | "invalid_runner_handshake";

export interface CapabilityDecision {
  capabilityId: ToolCapabilityId;
  code: CapabilityDecisionCode;
  reason: string;
  transport?: ProviderTransportId;
  prerequisiteId?: string;
  evidence?: CapabilityEvidence;
}

export type ToolReadinessStatus =
  | "available"
  | "setup_required"
  | "conditional"
  | "unsupported"
  | "unknown";

export interface ToolReadinessResult {
  status: ToolReadinessStatus;
  missingPrerequisiteIds: string[];
}

export interface ResolvedTool {
  intent: ToolIntent;
  descriptor: ToolCapabilityDescriptor;
  transport: ProviderTransportId;
  readiness: ToolReadinessStatus;
}

export interface ToolPolicyTrace {
  requestedTools: ToolIntent[];
  enabledTools: ToolCapabilityId[];
  omittedTools: CapabilityDecision[];
  transport: ProviderTransportId;
  decisions: CapabilityDecision[];
}

export interface ProviderCallPlan {
  transport: ProviderTransportId;
  enabledTools: ResolvedTool[];
  omittedOptionalTools: CapabilityDecision[];
  toolPolicyTrace: ToolPolicyTrace;
  toolChoice: NormalizedToolChoice;
  parallelToolCalls: boolean;
}

export interface ProviderModelCapabilityRule {
  modelId?: string;
  modelPattern?: RegExp;
  capabilities: Partial<Record<ToolCapabilityId, Partial<ToolCapabilityDescriptor>>>;
}

export interface ProviderCapabilityManifest {
  providerId: string;
  transports: ProviderTransportId[];
  capabilities: ToolCapabilityDescriptor[];
  modelRules?: ProviderModelCapabilityRule[];
  transportConstraints?: ToolCombinationConstraint[];
}

export interface ProviderRuntimeContext {
  providerId: string;
  modelId: string;
  evidence?: CapabilityEvidence[];
  runnerHandshake?: unknown;
  customOverrides?: ToolCapabilityDescriptor[];
  resourceConfig?: ToolResourceConfig;
  resourceState?: ToolResourceState;
  features: ProviderCallFeatures;
}

export class ProviderCallPlanError extends Error {
  readonly decisions: CapabilityDecision[];

  constructor(
    decisions: CapabilityDecision[],
    message = "Required provider tools are unavailable",
  ) {
    super(message);
    this.name = "ProviderCallPlanError";
    this.decisions = decisions;
  }
}

const TOOL_CAPABILITY_ID_SET = new Set<string>(TOOL_CAPABILITY_IDS);
const PROVIDER_TRANSPORT_ID_SET = new Set<string>(PROVIDER_TRANSPORT_IDS);
const TOOL_SUPPORT_STATUS_SET = new Set<string>(TOOL_SUPPORT_STATUSES);
const TOOL_EXECUTION_LOCATION_SET = new Set<string>(TOOL_EXECUTION_LOCATIONS);
const CAPABILITY_SUPPORT_SOURCE_SET = new Set<string>(CAPABILITY_SUPPORT_SOURCES);
const PREREQUISITE_KIND_SET = new Set<CapabilityPrerequisiteKind>([
  "resource",
  "configuration",
  "account",
  "runtime",
]);
const CONSTRAINT_WHEN_SET = new Set<ToolCombinationWhen>([
  "structured_output",
  "reasoning",
  "attachments",
  "parallel_tools",
  "tool_choice",
]);
const CONSTRAINT_EFFECT_SET = new Set<ToolCombinationEffect>([
  "forbid",
  "requires_transport",
  "requires_tool_choice",
]);

export function isToolCapabilityId(value: unknown): value is ToolCapabilityId {
  return typeof value === "string" && TOOL_CAPABILITY_ID_SET.has(value);
}

export function isProviderTransportId(value: unknown): value is ProviderTransportId {
  return typeof value === "string" && PROVIDER_TRANSPORT_ID_SET.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isCapabilityPrerequisite(value: unknown): value is CapabilityPrerequisite {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    typeof value.kind === "string" &&
    PREREQUISITE_KIND_SET.has(value.kind as CapabilityPrerequisiteKind) &&
    (value.description === undefined || typeof value.description === "string") &&
    (value.configurationPath === undefined || typeof value.configurationPath === "string")
  );
}

function isToolCombinationConstraint(value: unknown): value is ToolCombinationConstraint {
  if (!isRecord(value)) return false;
  return (
    typeof value.when === "string" &&
    CONSTRAINT_WHEN_SET.has(value.when as ToolCombinationWhen) &&
    typeof value.effect === "string" &&
    CONSTRAINT_EFFECT_SET.has(value.effect as ToolCombinationEffect) &&
    (value.value === undefined || typeof value.value === "string") &&
    typeof value.reason === "string" &&
    value.reason.length > 0
  );
}

export function isToolCapabilityDescriptor(value: unknown): value is ToolCapabilityDescriptor {
  if (!isRecord(value)) return false;
  if (
    !isToolCapabilityId(value.id) ||
    typeof value.support !== "string" ||
    !TOOL_SUPPORT_STATUS_SET.has(value.support) ||
    typeof value.execution !== "string" ||
    !TOOL_EXECUTION_LOCATION_SET.has(value.execution) ||
    !Array.isArray(value.transports) ||
    value.transports.some((transport) => !isProviderTransportId(transport)) ||
    typeof value.supportSource !== "string" ||
    !CAPABILITY_SUPPORT_SOURCE_SET.has(value.supportSource)
  ) {
    return false;
  }
  if (
    value.prerequisites !== undefined &&
    (!Array.isArray(value.prerequisites) ||
      value.prerequisites.some((item) => !isCapabilityPrerequisite(item)))
  ) {
    return false;
  }
  if (
    value.constraints !== undefined &&
    (!Array.isArray(value.constraints) ||
      value.constraints.some((item) => !isToolCombinationConstraint(item)))
  ) {
    return false;
  }
  return value.verifiedAt === undefined || !Number.isNaN(Date.parse(String(value.verifiedAt)));
}

export function resolveToolReadiness(
  descriptor: ToolCapabilityDescriptor,
  resourceState?: ToolResourceState,
): ToolReadinessResult {
  if (descriptor.support === "unsupported") {
    return { status: "unsupported", missingPrerequisiteIds: [] };
  }
  if (descriptor.support === "unknown") {
    return { status: "unknown", missingPrerequisiteIds: [] };
  }
  if (descriptor.support === "conditional") {
    return { status: "conditional", missingPrerequisiteIds: [] };
  }

  const missingPrerequisiteIds = (descriptor.prerequisites ?? [])
    .map((prerequisite) => prerequisite.id)
    .filter((id) => resourceState?.prerequisites[id]?.ready !== true);

  return missingPrerequisiteIds.length > 0
    ? { status: "setup_required", missingPrerequisiteIds }
    : { status: "available", missingPrerequisiteIds: [] };
}
