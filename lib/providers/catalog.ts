import type { ModelCapabilities } from "./base";
import { formatModelId } from "./base";
import type { ProviderId } from "./constants";

export interface CatalogModel {
  id: string;
  name: string;
  providerId: ProviderId;
  description: string;
  capabilities: ModelCapabilities;
  /** Cheap model used for API key validation */
  validationCandidate?: boolean;
  /**
   * Which OpenAI endpoint the model accepts. Codex models reject
   * v1/chat/completions ("not a chat model") and must use v1/responses.
   */
  api?: "chat" | "responses";
}

/** Single source of truth — API IDs from provider docs. */
export const MODEL_CATALOG: CatalogModel[] = [
  // OpenAI — https://developers.openai.com/api/docs/models
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    providerId: "openai",
    description: "Newest frontier model for coding and professional work",
    capabilities: { image: true, document: false, audio: false, video: false },
  },
  {
    id: "gpt-5.5-pro",
    name: "GPT-5.5 Pro",
    providerId: "openai",
    description: "Highest-intelligence GPT-5.5 variant for complex tasks",
    capabilities: { image: true, document: false, audio: false, video: false },
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    providerId: "openai",
    description: "Frontier model with coding, reasoning, and computer-use",
    capabilities: { image: true, document: false, audio: false, video: false },
  },
  {
    id: "gpt-5.4-pro",
    name: "GPT-5.4 Pro",
    providerId: "openai",
    description: "Maximum-performance GPT-5.4 for complex professional work",
    capabilities: { image: true, document: false, audio: false, video: false },
  },
  {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    providerId: "openai",
    description: "Agentic coding model optimized for Codex-style tasks",
    capabilities: { image: false, document: false, audio: false, video: false },
    api: "responses",
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    providerId: "openai",
    description: "Cost-optimized model for fast responses",
    capabilities: { image: true, document: false, audio: false, video: false },
    validationCandidate: true,
  },

  // Anthropic — https://platform.claude.com/docs/en/about-claude/models/overview
  {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    providerId: "anthropic",
    description:
      "Anthropic's most capable model for demanding reasoning and long-horizon agentic work (1M context)",
    capabilities: { image: true, document: true, audio: false, video: false },
  },
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    providerId: "anthropic",
    description: "Most capable Opus model for complex reasoning and agents",
    capabilities: { image: true, document: true, audio: false, video: false },
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    providerId: "anthropic",
    description: "Best balance of speed and intelligence (1M context)",
    capabilities: { image: true, document: true, audio: false, video: false },
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    providerId: "anthropic",
    description: "Fastest Claude with near-frontier intelligence",
    capabilities: { image: true, document: false, audio: false, video: false },
    validationCandidate: true,
  },

  // Google — https://ai.google.dev/gemini-api/docs/models
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    providerId: "google",
    description: "Latest fast multimodal model",
    capabilities: { image: true, document: true, audio: true, video: true },
    validationCandidate: true,
  },
  {
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    providerId: "google",
    description: "Latest advanced Pro model for complex reasoning",
    capabilities: { image: true, document: true, audio: true, video: true },
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    providerId: "google",
    description: "Stable fast model (supported through Oct 2026)",
    capabilities: { image: true, document: true, audio: true, video: true },
  },

  // OpenRouter — https://openrouter.ai/models (Qwen, DeepSeek, etc.)
  {
    id: "qwen/qwen3.7-max",
    name: "Qwen 3.7 Max",
    providerId: "openrouter",
    description: "Alibaba flagship for coding, agents, and long-horizon tasks",
    capabilities: { image: false, document: false, audio: false, video: false },
  },
  {
    id: "qwen/qwen3.7-plus",
    name: "Qwen 3.7 Plus",
    providerId: "openrouter",
    description: "Balanced Qwen 3.7 with vision and reasoning",
    capabilities: { image: true, document: false, audio: false, video: false },
  },
  {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    providerId: "openrouter",
    description: "DeepSeek flagship MoE for reasoning, coding, and agents",
    capabilities: { image: false, document: false, audio: false, video: false },
    validationCandidate: true,
  },
];

export function getCatalogModelsForProvider(providerId: ProviderId): CatalogModel[] {
  return MODEL_CATALOG.filter((m) => m.providerId === providerId);
}

export function getValidationModelId(providerId: ProviderId): string {
  const models = getCatalogModelsForProvider(providerId);
  return (
    models.find((m) => m.validationCandidate)?.id ??
    models[models.length - 1]?.id ??
    models[0].id
  );
}

export function getCapabilitiesMap(): Record<string, ModelCapabilities> {
  return Object.fromEntries(
    MODEL_CATALOG.map((m) => [formatModelId(m.providerId, m.id), m.capabilities])
  );
}

export function getModelDisplayName(fullModelId: string): string {
  const entry = MODEL_CATALOG.find(
    (m) => formatModelId(m.providerId, m.id) === fullModelId
  );
  return entry?.name ?? fullModelId.split(":").slice(1).join(":") ?? fullModelId;
}
