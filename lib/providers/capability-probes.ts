import type { CertifiedProviderErrorMetadata, ChatMessage, JsonSchemaObject, ModelInfo, StructuredOutputFormat } from "./base";
import type { ResolvedCapabilityProfile } from "./capability-resolution";
import {
  isToolCapabilityId,
  type CapabilityEvidence,
  type ProviderTransportId,
  type ToolCapabilityId,
  type ToolExecutionLocation,
  type ToolReadinessStatus,
} from "./tool-capabilities";
import type { AttachmentPayload } from "@/lib/attachments/types";

export type StaticCapabilityProbeId =
  | "text"
  | "structuredOutput"
  | "streaming"
  | "imageInput"
  | "documentInput"
  | "buildProtocol"
  | "temperature"
  | "maxTokens"
  | "concurrency";

export type ToolCapabilityProbeId = `tool:${ToolCapabilityId}`;
export type CapabilityProbeId = StaticCapabilityProbeId | ToolCapabilityProbeId;
export type StoredCapabilityProbeId = CapabilityProbeId | "toolCalls";

export type CapabilityProbeStatus =
  | "pass"
  | "fail"
  | "skipped"
  | "setup_required"
  | "conditional"
  | "unsupported";

export interface CapabilityProbeResult {
  id: StoredCapabilityProbeId;
  status: CapabilityProbeStatus;
  detail: string;
  preview?: string;
  failureKind?: "protocol_unsupported" | "transient" | "behavior";
  errorMetadata?: CertifiedProviderErrorMetadata;
  capabilityId?: ToolCapabilityId;
  transport?: ProviderTransportId;
  execution?: ToolExecutionLocation;
}


export function capabilityEvidenceFromToolProbe(input: {
  providerId: string;
  modelId: string;
  transport: ProviderTransportId;
  execution?: ToolExecutionLocation;
  testedAt: string;
  expiresAt: string;
  result: CapabilityProbeResult;
}): CapabilityEvidence | undefined {
  const capabilityId =
    input.result.id === "toolCalls"
      ? "function_calling"
      : parseToolCapabilityProbeId(input.result.id);
  if (!capabilityId) return undefined;
  const support =
    input.result.status === "pass"
      ? "supported"
      : input.result.failureKind === "protocol_unsupported"
        ? "unsupported"
        : undefined;
  if (!support) return undefined;
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    capabilityId,
    transport: input.transport,
    support,
    ...(input.execution ?? input.result.execution ? { execution: input.execution ?? input.result.execution } : {}),
    source: "probed",
    verifiedAt: input.testedAt,
    expiresAt: input.expiresAt,
    detail: input.result.detail,
  };
}
export interface ModelCapabilityProbeProfile {
  fullModelId: string;
  providerId: string;
  modelId: string;
  modelName: string;
  testedAt: string;
  expiresAt: string;
  source: "probed";
  results: CapabilityProbeResult[];
  capabilities: {
    text: boolean;
    streaming: boolean;
    structuredOutput: boolean;
    imageInput: boolean;
    documentInput: boolean;
    /** @deprecated Legacy function-call probe field retained for stored-profile compatibility. */
    toolCalls: boolean;
    functionCalling?: boolean;
    buildProtocol?: boolean;
    toolCapabilities?: Partial<Record<ToolCapabilityId, CapabilityProbeStatus>>;
    temperature: boolean;
    reasoningEffort: string[];
    maxTokens: boolean;
    parallelRequests: number;
  };
}

export interface CapabilityProbeDefinition {
  id: CapabilityProbeId;
  label: string;
  description: string;
  defaultSelected: boolean;
  advanced?: boolean;
}

export const CAPABILITY_PROBES: CapabilityProbeDefinition[] = [
  {
    id: "text",
    label: "Basic text",
    description: "Checks that the model can answer a tiny deterministic prompt.",
    defaultSelected: true,
  },
  {
    id: "structuredOutput",
    label: "Structured JSON",
    description: "Checks whether strict JSON schema-style output works.",
    defaultSelected: true,
  },
  {
    id: "streaming",
    label: "Streaming path",
    description: "Checks whether the app can request the model through the streaming path.",
    defaultSelected: false,
    advanced: true,
  },
  {
    id: "imageInput",
    label: "Image input",
    description: "Sends a generated tiny red-square image and verifies the model can read it.",
    defaultSelected: false,
    advanced: true,
  },
  {
    id: "documentInput",
    label: "Document/text attachment",
    description: "Sends a tiny generated text attachment and verifies the model can read it.",
    defaultSelected: false,
    advanced: true,
  },
  {
    id: "buildProtocol",
    label: "AI Board Build Protocol",
    description: "Checks whether the model can call a real AI Board Build tool and whether AI Board can convert that call into the canonical Build action stream.",
    defaultSelected: false,
    advanced: true,
  },
  {
    id: "temperature",
    label: "Temperature parameter",
    description: "Checks whether the provider accepts the temperature parameter for this model.",
    defaultSelected: false,
    advanced: true,
  },
  {
    id: "maxTokens",
    label: "Max-token parameter",
    description: "Checks whether a small output cap is accepted for this model.",
    defaultSelected: false,
    advanced: true,
  },
  {
    id: "concurrency",
    label: "Parallel requests",
    description: "Runs two tiny prompts at once to detect whether this account/model tolerates basic parallelism.",
    defaultSelected: false,
    advanced: true,
  },
];

const TOOL_PROBE_LABELS: Record<ToolCapabilityId, string> = {
  function_calling: "Function Calling",
  web_search: "Web Search",
  web_fetch: "Web Fetch",
  file_search: "File Search",
  url_context: "URL Context",
  maps: "Maps",
  x_search: "X Search",
  code_execution: "Code Execution",
  shell: "Shell",
  apply_patch: "Apply Patch",
  computer_use: "Computer Use",
  browser_use: "Browser Use",
  image_generation: "Image Generation",
  remote_mcp: "Remote MCP",
  tool_search: "Tool Search",
  advisor: "Advisor",
  subagent: "Subagent",
  fusion: "Fusion",
  datetime: "Date/Time",
  memory: "Memory",
};

export interface ToolCapabilityProbeDefinition {
  id: ToolCapabilityProbeId;
  capabilityId: ToolCapabilityId;
  label: string;
  description: string;
  readiness: ToolReadinessStatus;
  execution: ToolExecutionLocation;
  transports: ProviderTransportId[];
  missingPrerequisiteIds: string[];
  supportSource: string;
  reason?: string;
}

export function toolCapabilityProbeId(capabilityId: ToolCapabilityId): ToolCapabilityProbeId {
  return `tool:${capabilityId}`;
}

export function parseToolCapabilityProbeId(id: StoredCapabilityProbeId | string): ToolCapabilityId | undefined {
  if (!id.startsWith("tool:")) return undefined;
  const capabilityId = id.slice("tool:".length);
  return isToolCapabilityId(capabilityId) ? capabilityId : undefined;
}

export function buildToolCapabilityProbeDefinitions(
  profile: ResolvedCapabilityProfile,
): ToolCapabilityProbeDefinition[] {
  return Object.values(profile.capabilities).map(({ descriptor, readiness }) => {
    const missingLabels = readiness.missingPrerequisiteIds.map((id) =>
      descriptor.prerequisites?.find((item) => item.id === id)?.label ?? id,
    );
    const runtimeReasons = readiness.missingPrerequisiteIds
      .map((id) => profile.resourceState?.prerequisites[id]?.reason)
      .filter((reason): reason is string => Boolean(reason));
    const reason = runtimeReasons.length > 0
      ? runtimeReasons.join(" ")
      : missingLabels.length > 0
        ? `Missing: ${missingLabels.join(", ")}.`
        : undefined;
    return {
      id: toolCapabilityProbeId(descriptor.id),
      capabilityId: descriptor.id,
      label: TOOL_PROBE_LABELS[descriptor.id],
      description: `Live-test the observable ${TOOL_PROBE_LABELS[descriptor.id]} invocation through the resolved ${descriptor.execution} route. Provider-managed tools require a completed provider event; client tools require a concrete emitted call plus ready executor preflight.`,
      readiness: readiness.status,
      execution: descriptor.execution,
      transports: [...descriptor.transports],
      missingPrerequisiteIds: [...readiness.missingPrerequisiteIds],
      supportSource: descriptor.supportSource,
      ...(reason ? { reason } : {}),
    };
  });
}

export const CAPABILITY_PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const TEST_SYSTEM = "You are running a short AI Board provider capability test. Follow the instruction exactly.";

export const TEXT_PROBE_MESSAGES: ChatMessage[] = [
  { role: "system", content: TEST_SYSTEM },
  { role: "user", content: "Reply with exactly: AIBOARD_TEXT_OK" },
];

export const STRUCTURED_PROBE_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    label: { type: "string" },
  },
  required: ["ok", "label"],
  additionalProperties: false,
};

export const STRUCTURED_PROBE_FORMAT: StructuredOutputFormat = {
  name: "aiboard_capability_probe",
  schema: STRUCTURED_PROBE_SCHEMA,
  strict: true,
};

export const STRUCTURED_PROBE_MESSAGES: ChatMessage[] = [
  { role: "system", content: TEST_SYSTEM },
  {
    role: "user",
    content:
      'Return JSON matching the schema. Use ok=true and label="aiboard". Do not include prose.',
  },
];

export const STREAMING_PROBE_MESSAGES: ChatMessage[] = [
  { role: "system", content: TEST_SYSTEM },
  { role: "user", content: "Reply with the numbers 1, 2, and 3, one per line." },
];

export const IMAGE_PROBE_MESSAGES: ChatMessage[] = [
  { role: "system", content: TEST_SYSTEM },
  { role: "user", content: "What color is the square in the attached image? Reply with one word." },
];

export const DOCUMENT_PROBE_MESSAGES: ChatMessage[] = [
  { role: "system", content: TEST_SYSTEM },
  {
    role: "user",
    content: "Read the attached text document. What is AIBOARD_DOCUMENT_SECRET? Reply with only the value.",
  },
];

export const TOOL_CALL_PROBE_MESSAGES: ChatMessage[] = [
  { role: "system", content: TEST_SYSTEM },
  { role: "user", content: "Call the aiboard_sum function with a=2 and b=3. Do not answer directly." },
];

export const CONCURRENCY_A_MESSAGES: ChatMessage[] = [
  { role: "system", content: TEST_SYSTEM },
  { role: "user", content: "Reply with exactly: AIBOARD_CONCURRENCY_A" },
];

export const CONCURRENCY_B_MESSAGES: ChatMessage[] = [
  { role: "system", content: TEST_SYSTEM },
  { role: "user", content: "Reply with exactly: AIBOARD_CONCURRENCY_B" },
];

export const TEMPERATURE_PROBE_MESSAGES: ChatMessage[] = [
  { role: "system", content: TEST_SYSTEM },
  { role: "user", content: "Reply with exactly: AIBOARD_TEMPERATURE_OK" },
];

export const MAX_TOKENS_PROBE_MESSAGES: ChatMessage[] = [
  { role: "system", content: TEST_SYSTEM },
  { role: "user", content: "Reply with exactly: OK" },
];

export const PROBE_TEXT_ATTACHMENT: AttachmentPayload = {
  id: "aiboard-capability-text-document",
  filename: "aiboard-capability-test.txt",
  mimeType: "text/plain",
  category: "document",
  textContent: "AIBOARD_DOCUMENT_SECRET=blue-river",
};

export const PROBE_IMAGE_ATTACHMENT: AttachmentPayload = {
  id: "aiboard-capability-red-square",
  filename: "aiboard-capability-image.png",
  mimeType: "image/png",
  category: "image",
  base64Data:
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAcSURBVDhPY7ijpvafEjxqwKgBIDxqwDAwQO0/AEkhJx9IQd3PAAAAAElFTkSuQmCC",
};

export function defaultCapabilityProfile(
  fullModelId: string,
  providerId: string,
  model: ModelInfo
): ModelCapabilityProbeProfile {
  const now = Date.now();
  return {
    fullModelId,
    providerId,
    modelId: model.id,
    modelName: model.name,
    testedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CAPABILITY_PROFILE_TTL_MS).toISOString(),
    source: "probed",
    results: [],
    capabilities: {
      text: false,
      streaming: false,
      structuredOutput: false,
      imageInput: false,
      documentInput: false,
      toolCalls: false,
      functionCalling: false,
      buildProtocol: false,
      toolCapabilities: {},
      temperature: false,
      reasoningEffort: [],
      maxTokens: false,
      parallelRequests: 1,
    },
  };
}

export function summarizeCapabilityResults(results: CapabilityProbeResult[]): string {
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const setup = results.filter((r) => r.status === "setup_required").length;
  const conditional = results.filter((r) => r.status === "conditional").length;
  const unsupported = results.filter((r) => r.status === "unsupported").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const extras = [
    setup ? `${setup} setup required` : "",
    conditional ? `${conditional} conditional` : "",
    unsupported ? `${unsupported} unsupported` : "",
    skipped ? `${skipped} skipped` : "",
  ].filter(Boolean);
  return `${passed} passed, ${failed} failed${extras.length ? `, ${extras.join(", ")}` : ""}`;
}
