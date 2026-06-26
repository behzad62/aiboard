import type { ChatMessage, JsonSchemaObject, ModelInfo, StructuredOutputFormat } from "./base";
import type { AttachmentPayload } from "@/lib/attachments/types";

export type CapabilityProbeId =
  | "text"
  | "structuredOutput"
  | "streaming"
  | "imageInput"
  | "documentInput"
  | "toolCalls"
  | "temperature"
  | "maxTokens"
  | "concurrency";

export type CapabilityProbeStatus = "pass" | "fail" | "skipped";

export interface CapabilityProbeResult {
  id: CapabilityProbeId;
  status: CapabilityProbeStatus;
  detail: string;
  preview?: string;
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
    toolCalls: boolean;
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
    id: "toolCalls",
    label: "Build action protocol",
    description: "Checks whether the model can emit and use AI Board's safe JSON build-action protocol.",
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
  {
    role: "user",
    content:
      'Return only JSON with fields action="use_helper", helper="sum", and input containing a=2 and b=3.',
  },
];

export const toolResultProbeMessages = (helperJson: string): ChatMessage[] => [
  { role: "system", content: TEST_SYSTEM },
  {
    role: "user",
    content:
      'You requested this safe test helper: ' +
      helperJson +
      '\nThe helper returned 5. Reply with exactly: AIBOARD_TOOL_OK=5',
  },
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
  const skipped = results.filter((r) => r.status === "skipped").length;
  return `${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`;
}
