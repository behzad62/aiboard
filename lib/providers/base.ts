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
  /** Provider-native Build tools gated by the user's full-access runner choice. */
  hostedBuildTools?: boolean;
  /** Explicit capabilities — used for custom models not in the static catalog. */
  capabilities?: ModelCapabilities;
  /** Endpoint override — used by gateway providers (e.g. Azure AI Foundry). */
  baseURL?: string;
  /** Build-mode context metadata resolved from the static registry + overrides. */
  contextProfile?: ModelContextProfile;
}

export interface StreamChunk {
  type: "token" | "done" | "error" | "tool_call";
  content?: string;
  error?: string;
  toolCall?: NativeToolCall;
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
