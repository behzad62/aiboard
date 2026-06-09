import type { AttachmentPayload } from "../attachments/types";
import type { CapabilityInputType } from "../attachments/types";

export type ModelCapabilities = Record<CapabilityInputType, boolean>;

export interface ModelInfo {
  id: string;
  name: string;
  providerId: string;
  description?: string;
  capabilities?: ModelCapabilities;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatParams {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  attachments?: AttachmentPayload[];
  maxTokens?: number;
  temperature?: number;
}

export interface StreamChunk {
  type: "token" | "done" | "error";
  content?: string;
  error?: string;
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
}

export function parseModelId(fullId: string): { providerId: string; model: string } {
  const [providerId, ...rest] = fullId.split(":");
  return { providerId, model: rest.join(":") };
}

export function formatModelId(providerId: string, model: string): string {
  return `${providerId}:${model}`;
}
