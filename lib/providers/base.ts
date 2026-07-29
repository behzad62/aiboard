import type { AttachmentPayload } from "../attachments/types";
import type { CapabilityInputType } from "../attachments/types";
import type { ReasoningEffort } from "../db/schema";
import type { ModelContextProfile } from "./model-context";

export type { ModelContextProfile } from "./model-context";

export type ModelCapabilities = Record<CapabilityInputType, boolean>;

export interface ModelInfo {
  id: string;
  name: string;
  providerId: string;
  description?: string;
  capabilities?: ModelCapabilities;
  contextProfile?: ModelContextProfile;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface JsonSchemaObject {
  type?: string | string[];
  description?: string;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, JsonSchemaObject>;
  items?: JsonSchemaObject;
  enum?: Array<string | number | boolean | null>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaObject;
  nullable?: boolean;
}

export interface StructuredOutputFormat {
  name: string;
  schema: JsonSchemaObject;
  strict?: boolean;
}

export interface NativeToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
  strict?: boolean;
}

export interface NativeToolCall {
  id?: string;
  name: string;
  arguments?: Record<string, unknown>;
  argumentsJson?: string;
}

export interface ChatParams {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  attachments?: AttachmentPayload[];
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  structuredOutput?: StructuredOutputFormat;
  /** Provider-native web search/grounding is available for this call. */
  webSearch?: boolean;
  /** Provider-native function/tool definitions available for this call. */
  nativeTools?: NativeToolDefinition[];
  /** Provider-hosted Build tools for providers that still support them. */
  hostedBuildTools?: boolean;
  /** Explicit capabilities — used for custom models not in the static catalog. */
  capabilities?: ModelCapabilities;
  /** Endpoint override — used by gateway providers (e.g. Azure AI Foundry). */
  baseURL?: string;
  /** Local provider-runner token, when separate from the provider API key. */
  runnerToken?: string;
  /** Optional cancellation signal for UI validation, games, and benchmark runs. */
  signal?: AbortSignal;
  /** Build-mode context metadata resolved from the static registry + overrides. */
  contextProfile?: ModelContextProfile;
  /** Internal: certified callers own retries centrally and disable SDK retries. */
  disableAutomaticRetries?: boolean;
}

export interface CertifiedProviderErrorMetadata {
  statusCode?: number;
  code?: string;
  retryAfterMs?: number;
}

export function safeProviderErrorMetadata(
  error: unknown,
  nowMs = Date.now()
): CertifiedProviderErrorMetadata | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const response =
    record.response && typeof record.response === "object"
      ? (record.response as Record<string, unknown>)
      : undefined;
  const statusCandidate = record.status ?? record.statusCode ?? response?.status;
  const codeCandidate = record.code;
  const headersCandidate = record.headers ?? response?.headers;
  const retryAfterValue = readSafeHeader(headersCandidate, "retry-after");
  const statusCode =
    typeof statusCandidate === "number" &&
    Number.isInteger(statusCandidate) &&
    statusCandidate >= 100 &&
    statusCandidate <= 599
      ? statusCandidate
      : undefined;
  const code =
    typeof codeCandidate === "string" &&
    /^[A-Za-z0-9_.-]{1,64}$/.test(codeCandidate) &&
    !/key|token|secret|authorization/i.test(codeCandidate)
      ? codeCandidate
      : undefined;
  const retryAfterMs = parseSafeRetryAfter(retryAfterValue, nowMs);
  return statusCode !== undefined || code !== undefined || retryAfterMs !== undefined
    ? {
        ...(statusCode !== undefined ? { statusCode } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      }
    : undefined;
}

function readSafeHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== "object") return null;
  if ("get" in headers && typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(name: string): unknown }).get(name);
    return typeof value === "string" ? value : null;
  }
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === "string" ? value : null;
}

function parseSafeRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp < nowMs) return undefined;
  return Math.round(timestamp - nowMs);
}

/**
 * Provider-reported token usage for a single model call. Fields are optional
 * because providers differ in what they surface (some report only output
 * tokens on a streaming delta, others report both at the end). When present
 * these are the REAL billed counts, not the chars/4 estimate.
 */
export interface StreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  inputAudioTokens?: number;
  outputAudioTokens?: number;
  providerCost?: number;
  providerCostUnit?: "usd" | "credits" | "unknown";
}

export interface StreamChunk {
  /**
   * `"usage"` is an additive, side-channel chunk carrying provider-reported
   * token counts. Existing consumers match on the specific types they care
   * about (`token`/`tool_call`/`error`/`done`) with narrow `if` guards, so an
   * unrecognized `"usage"` chunk passes through harmlessly — no consumer needs
   * to change to remain correct.
   */
  type: "token" | "done" | "error" | "tool_call" | "usage";
  content?: string;
  error?: string;
  errorMetadata?: CertifiedProviderErrorMetadata;
  toolCall?: NativeToolCall;
  /** Present on `type: "usage"` chunks (and optionally alongside `done`). */
  usage?: StreamUsage;
  /** Provider-native completion reason, e.g. `end_turn` or `max_tokens`. */
  finishReason?: string;
}

export interface AIProvider {
  id: string;
  name: string;
  listModels(): ModelInfo[];
  streamChat(params: ChatParams): AsyncIterable<StreamChunk>;
  validateApiKey(apiKey: string): Promise<boolean>;
}

export interface SelectedModel {
  modelId: string;
  providerId: string;
  displayName: string;
  contextProfile?: ModelContextProfile;
}

export function parseModelId(fullId: string): { providerId: string; model: string } {
  const [providerId, ...rest] = fullId.split(":");
  return { providerId, model: rest.join(":") };
}

export function formatModelId(providerId: string, model: string): string {
  return `${providerId}:${model}`;
}
