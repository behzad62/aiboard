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
    id: "gpt-5.6",
    name: "GPT-5.6",
    providerId: "openai",
    description: "Latest frontier model for coding and professional work",
    capabilities: { image: true, document: true, audio: false, video: false },
  },
  {
    id: "gpt-5.6-pro",
    name: "GPT-5.6 Pro",
    providerId: "openai",
    description: "Highest-intelligence GPT-5.6 variant for complex tasks",
    capabilities: { image: true, document: true, audio: false, video: false },
  },
  {
    id: "gpt-5.6-mini",
    name: "GPT-5.6 Mini",
    providerId: "openai",
    description: "Cost-optimized GPT-5.6 variant for fast responses",
    capabilities: { image: true, document: true, audio: false, video: false },
    validationCandidate: true,
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    providerId: "openai",
    description: "Newest frontier model for coding and professional work",
    capabilities: { image: true, document: true, audio: false, video: false },
  },
  {
    id: "gpt-5.5-pro",
    name: "GPT-5.5 Pro",
    providerId: "openai",
    description: "Highest-intelligence GPT-5.5 variant for complex tasks",
    capabilities: { image: true, document: true, audio: false, video: false },
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    providerId: "openai",
    description: "Frontier model with coding, reasoning, and computer-use",
    capabilities: { image: true, document: true, audio: false, video: false },
  },
  {
    id: "gpt-5.4-pro",
    name: "GPT-5.4 Pro",
    providerId: "openai",
    description: "Maximum-performance GPT-5.4 for complex professional work",
    capabilities: { image: true, document: true, audio: false, video: false },
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
    capabilities: { image: true, document: true, audio: false, video: false },
  },

  // ChatGPT account-backed models - served through the local account-provider
  // runner, but represented as normal provider catalog entries in the app.
  {
    id: "gpt-5.6",
    name: "GPT-5.6 (ChatGPT)",
    providerId: "chatgpt",
    description:
      "ChatGPT Plus/Pro account model through the local account-provider runner",
    capabilities: { image: true, document: true, audio: false, video: false },
  },
  {
    id: "gpt-5.6-pro",
    name: "GPT-5.6 Pro (ChatGPT)",
    providerId: "chatgpt",
    description:
      "Highest-intelligence ChatGPT account model through the local account-provider runner",
    capabilities: { image: true, document: true, audio: false, video: false },
  },
  {
    id: "gpt-5.6-mini",
    name: "GPT-5.6 Mini (ChatGPT)",
    providerId: "chatgpt",
    description:
      "Fast ChatGPT account model through the local account-provider runner",
    capabilities: { image: true, document: true, audio: false, video: false },
    validationCandidate: true,
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5 (ChatGPT)",
    providerId: "chatgpt",
    description:
      "ChatGPT Plus/Pro account model through the local account-provider runner",
    capabilities: { image: true, document: true, audio: false, video: false },
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4 (ChatGPT)",
    providerId: "chatgpt",
    description:
      "ChatGPT account model through the local account-provider runner",
    capabilities: { image: true, document: true, audio: false, video: false },
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini (ChatGPT)",
    providerId: "chatgpt",
    description:
      "Fast ChatGPT account model through the local account-provider runner",
    capabilities: { image: true, document: true, audio: false, video: false },
  },
  {
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark (ChatGPT)",
    providerId: "chatgpt",
    description:
      "Codex-style ChatGPT account model through the local account-provider runner",
    capabilities: { image: true, document: true, audio: false, video: false },
  },

  // GitHub Copilot account-backed models - served through the local
  // account-provider runner.
  {
    id: "auto",
    name: "Copilot Auto",
    providerId: "github-copilot",
    description: "Let GitHub Copilot choose the best account-backed model",
    capabilities: { image: true, document: true, audio: false, video: false },
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4 (Copilot)",
    providerId: "github-copilot",
    description:
      "GitHub Copilot account model through the local account-provider runner",
    capabilities: { image: true, document: true, audio: false, video: false },
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini (Copilot)",
    providerId: "github-copilot",
    description:
      "Fast GitHub Copilot account model through the local account-provider runner",
    capabilities: { image: true, document: true, audio: false, video: false },
    validationCandidate: true,
  },
  {
    id: "claude-sonnet-4.5",
    name: "Claude Sonnet 4.5 (Copilot)",
    providerId: "github-copilot",
    description:
      "Claude model exposed through GitHub Copilot when available on the account",
    capabilities: { image: true, document: true, audio: false, video: false },
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

  // Azure AI Foundry — Anthropic models served from the user's own Foundry
  // resource. Available model ids depend entirely on the user's deployment
  // (e.g. claude-opus-4-5), so they are user-defined on the Settings page
  // (ProviderKey.models) rather than listed here.

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
  {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    providerId: "openrouter",
    description: "Efficiency-optimized DeepSeek MoE for fast, cheap inference (1M context)",
    capabilities: { image: true, document: false, audio: false, video: false },
  },
  {
    id: "minimax/minimax-m3",
    name: "MiniMax M3",
    providerId: "openrouter",
    description: "Multimodal MoE for long-horizon agentic work, coding, and tool use (1M context)",
    capabilities: { image: true, document: false, audio: false, video: true },
  },
  {
    id: "z-ai/glm-5.2",
    name: "GLM 5.2",
    providerId: "openrouter",
    description: "Z.ai flagship for coding and tool use across long-running agentic tasks (1M context)",
    capabilities: { image: false, document: false, audio: false, video: false },
  },
  {
    id: "moonshotai/kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    providerId: "openrouter",
    description:
      "MoonshotAI coding-focused Kimi K2 model for reliable long-context programming tasks (262K context)",
    capabilities: { image: true, document: false, audio: false, video: false },
  },
  {
    id: "nex-agi/nex-n2-pro:free",
    name: "Nex-N2-Pro (free)",
    providerId: "openrouter",
    description: "Free agentic MoE for coding, tool use, and deep research (262K context)",
    capabilities: { image: true, document: false, audio: false, video: false },
  },

  // xAI — https://docs.x.ai/docs/models
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    providerId: "xai",
    description: "xAI flagship for coding, reasoning, and agentic tool use (500K context)",
    capabilities: { image: true, document: false, audio: false, video: false },
  },
  {
    id: "grok-4.3",
    name: "Grok 4.3",
    providerId: "xai",
    description: "Advanced flagship with strong tool calling and instruction following (1M context)",
    capabilities: { image: true, document: false, audio: false, video: false },
  },
  {
    id: "grok-4.20-0309-reasoning",
    name: "Grok 4.20 Reasoning",
    providerId: "xai",
    description: "Reasoning-focused Grok 4.20 release for complex analysis (1M context)",
    capabilities: { image: true, document: false, audio: false, video: false },
  },
  {
    id: "grok-4.20-0309-non-reasoning",
    name: "Grok 4.20",
    providerId: "xai",
    description: "Fast non-reasoning Grok 4.20 release for lower-latency chat (1M context)",
    capabilities: { image: true, document: false, audio: false, video: false },
    validationCandidate: true,
  },
  {
    id: "grok-4.20-multi-agent-0309",
    name: "Grok 4.20 Multi-Agent",
    providerId: "xai",
    description: "Multi-agent Grok 4.20 release for collaborative agentic workflows (1M context)",
    capabilities: { image: true, document: false, audio: false, video: false },
  },
  {
    id: "grok-build-0.1",
    name: "Grok Build 0.1",
    providerId: "xai",
    description: "Agentic coding model for software engineering and workflow tasks (256K context)",
    capabilities: { image: true, document: false, audio: false, video: false },
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
