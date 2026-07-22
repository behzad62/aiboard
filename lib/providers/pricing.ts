import { formatModelId } from "./base";
import type { ModelPricingOverride } from "../db/schema";

// Re-export so the pricing UI can import the override type from the pricing
// module (its natural home) rather than reaching into the db schema.
export type { ModelPricingOverride } from "../db/schema";

export interface ModelPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cachedInputUsdPer1M?: number;
  notes?: string;
  sourceLabel: string;
  sourceUrl: string;
  verifiedAt: string;
  isOverride?: boolean;
}

const VERIFIED_AT = "2026-06-10";

const MODEL_PRICING: Record<string, ModelPricing> = {
  [formatModelId("openai", "gpt-5.6-sol")]: {
    inputUsdPer1M: 5,
    cachedInputUsdPer1M: 0.5,
    outputUsdPer1M: 30,
    sourceLabel: "OpenAI pricing",
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
    verifiedAt: "2026-07-22",
  },
  [formatModelId("openai", "gpt-5.6-terra")]: {
    inputUsdPer1M: 2.5,
    cachedInputUsdPer1M: 0.25,
    outputUsdPer1M: 15,
    sourceLabel: "OpenAI pricing",
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
    verifiedAt: "2026-07-22",
  },
  [formatModelId("openai", "gpt-5.6-luna")]: {
    inputUsdPer1M: 1,
    cachedInputUsdPer1M: 0.1,
    outputUsdPer1M: 6,
    sourceLabel: "OpenAI pricing",
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
    verifiedAt: "2026-07-22",
  },
  [formatModelId("openai", "gpt-5.5")]: {
    inputUsdPer1M: 5,
    cachedInputUsdPer1M: 0.5,
    outputUsdPer1M: 30,
    sourceLabel: "OpenAI pricing",
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
    verifiedAt: VERIFIED_AT,
  },
  [formatModelId("openai", "gpt-5.5-pro")]: {
    inputUsdPer1M: 30,
    outputUsdPer1M: 180,
    notes: "Standard rate. Batch and priority tiers are listed separately by OpenAI.",
    sourceLabel: "OpenAI pricing",
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
    verifiedAt: VERIFIED_AT,
  },
  [formatModelId("openai", "gpt-5.4")]: {
    inputUsdPer1M: 2.5,
    cachedInputUsdPer1M: 0.25,
    outputUsdPer1M: 15,
    sourceLabel: "OpenAI pricing",
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
    verifiedAt: VERIFIED_AT,
  },
  [formatModelId("openai", "gpt-5.4-pro")]: {
    inputUsdPer1M: 30,
    outputUsdPer1M: 180,
    notes: "Standard rate. Batch and priority tiers are listed separately by OpenAI.",
    sourceLabel: "OpenAI pricing",
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
    verifiedAt: VERIFIED_AT,
  },
  [formatModelId("openai", "gpt-5.3-codex")]: {
    inputUsdPer1M: 1.75,
    cachedInputUsdPer1M: 0.175,
    outputUsdPer1M: 14,
    sourceLabel: "OpenAI pricing",
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
    verifiedAt: VERIFIED_AT,
  },
  [formatModelId("openai", "gpt-5.4-mini")]: {
    inputUsdPer1M: 0.75,
    cachedInputUsdPer1M: 0.075,
    outputUsdPer1M: 4.5,
    sourceLabel: "OpenAI pricing",
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
    verifiedAt: VERIFIED_AT,
  },

  [formatModelId("chatgpt", "gpt-5.6-sol")]: {
    inputUsdPer1M: 5,
    cachedInputUsdPer1M: 0.5,
    outputUsdPer1M: 30,
    notes:
      "Equivalent OpenAI API reference pricing for comparison; this is not ChatGPT billing.",
    sourceLabel: "OpenAI pricing reference",
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
    verifiedAt: "2026-07-22",
  },
  [formatModelId("chatgpt", "gpt-5.6-terra")]: {
    inputUsdPer1M: 2.5,
    cachedInputUsdPer1M: 0.25,
    outputUsdPer1M: 15,
    notes:
      "Equivalent OpenAI API reference pricing for comparison; this is not ChatGPT billing.",
    sourceLabel: "OpenAI pricing reference",
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
    verifiedAt: "2026-07-22",
  },
  [formatModelId("chatgpt", "gpt-5.6-luna")]: {
    inputUsdPer1M: 1,
    cachedInputUsdPer1M: 0.1,
    outputUsdPer1M: 6,
    notes:
      "Equivalent OpenAI API reference pricing for comparison; this is not ChatGPT billing.",
    sourceLabel: "OpenAI pricing reference",
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
    verifiedAt: "2026-07-22",
  },

  [formatModelId("anthropic", "claude-fable-5")]: {
    inputUsdPer1M: 10,
    cachedInputUsdPer1M: 1,
    outputUsdPer1M: 50,
    notes:
      "Prompt caching write is $12.50/M (5-minute) or $20/M (1-hour) tokens. Full 1M context at standard pricing.",
    sourceLabel: "Anthropic pricing",
    sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
    verifiedAt: VERIFIED_AT,
  },
  [formatModelId("anthropic", "claude-opus-4-8")]: {
    inputUsdPer1M: 5,
    cachedInputUsdPer1M: 0.5,
    outputUsdPer1M: 25,
    notes: "Prompt caching write is $6.25/M tokens on Anthropic's pricing page.",
    sourceLabel: "Anthropic pricing",
    sourceUrl: "https://claude.com/pricing#api",
    verifiedAt: VERIFIED_AT,
  },
  [formatModelId("anthropic", "claude-sonnet-4-6")]: {
    inputUsdPer1M: 3,
    cachedInputUsdPer1M: 0.3,
    outputUsdPer1M: 15,
    notes: "Prompt caching write is $3.75/M tokens on Anthropic's pricing page.",
    sourceLabel: "Anthropic pricing",
    sourceUrl: "https://claude.com/pricing#api",
    verifiedAt: VERIFIED_AT,
  },
  [formatModelId("anthropic", "claude-haiku-4-5-20251001")]: {
    inputUsdPer1M: 1,
    cachedInputUsdPer1M: 0.1,
    outputUsdPer1M: 5,
    notes: "Prompt caching write is $1.25/M tokens on Anthropic's pricing page.",
    sourceLabel: "Anthropic pricing",
    sourceUrl: "https://claude.com/pricing#api",
    verifiedAt: VERIFIED_AT,
  },

  [formatModelId("google", "gemini-3.5-flash")]: {
    inputUsdPer1M: 1.5,
    cachedInputUsdPer1M: 0.15,
    outputUsdPer1M: 9,
    notes: "Google lists standard paid text pricing. Search grounding and other tools are charged separately.",
    sourceLabel: "Google Gemini API pricing",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    verifiedAt: VERIFIED_AT,
  },
  [formatModelId("google", "gemini-3.1-pro-preview")]: {
    inputUsdPer1M: 2,
    cachedInputUsdPer1M: 0.2,
    outputUsdPer1M: 12,
    notes: ">200k prompt tier is $4.00/M input and $18.00/M output.",
    sourceLabel: "Google Gemini API pricing",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    verifiedAt: VERIFIED_AT,
  },
  [formatModelId("google", "gemini-2.5-flash")]: {
    inputUsdPer1M: 0.3,
    cachedInputUsdPer1M: 0.03,
    outputUsdPer1M: 2.5,
    notes: "Audio input is billed higher than text/image/video on Google's pricing page.",
    sourceLabel: "Google Gemini API pricing",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    verifiedAt: VERIFIED_AT,
  },

  [formatModelId("openrouter", "qwen/qwen3.7-max")]: {
    inputUsdPer1M: 1.25,
    cachedInputUsdPer1M: 0.25,
    outputUsdPer1M: 3.75,
    notes: "OpenRouter currently shows a 50% off effective rate for this model.",
    sourceLabel: "OpenRouter model pricing",
    sourceUrl: "https://openrouter.ai/qwen/qwen3.7-max",
    verifiedAt: VERIFIED_AT,
  },
  [formatModelId("openrouter", "qwen/qwen3.7-plus")]: {
    inputUsdPer1M: 0.4,
    cachedInputUsdPer1M: 0.08,
    outputUsdPer1M: 1.6,
    notes: ">256k prompt tier rises to $1.20/M input and $4.80/M output.",
    sourceLabel: "OpenRouter model pricing",
    sourceUrl: "https://openrouter.ai/qwen/qwen3.7-plus",
    verifiedAt: VERIFIED_AT,
  },
  [formatModelId("openrouter", "deepseek/deepseek-v4-pro")]: {
    inputUsdPer1M: 0.435,
    cachedInputUsdPer1M: 0.003625,
    outputUsdPer1M: 0.87,
    notes: "Provider-specific OpenRouter routes vary; this is the model page's listed base rate.",
    sourceLabel: "OpenRouter model pricing",
    sourceUrl: "https://openrouter.ai/deepseek/deepseek-v4-pro",
    verifiedAt: VERIFIED_AT,
  },
  [formatModelId("openrouter", "deepseek/deepseek-v4-flash")]: {
    inputUsdPer1M: 0.0983,
    outputUsdPer1M: 0.1966,
    sourceLabel: "OpenRouter model pricing",
    sourceUrl: "https://openrouter.ai/deepseek/deepseek-v4-flash",
    verifiedAt: "2026-06-12",
  },
  [formatModelId("openrouter", "minimax/minimax-m3")]: {
    inputUsdPer1M: 0.3,
    outputUsdPer1M: 1.2,
    sourceLabel: "OpenRouter model pricing",
    sourceUrl: "https://openrouter.ai/minimax/minimax-m3",
    verifiedAt: "2026-06-12",
  },
  [formatModelId("openrouter", "nex-agi/nex-n2-pro:free")]: {
    inputUsdPer1M: 0,
    outputUsdPer1M: 0,
    notes: "Free OpenRouter route; rate limits apply.",
    sourceLabel: "OpenRouter model pricing",
    sourceUrl: "https://openrouter.ai/nex-agi/nex-n2-pro:free",
    verifiedAt: "2026-06-12",
  },
  [formatModelId("openrouter", "z-ai/glm-5.2")]: {
    inputUsdPer1M: 1.4,
    outputUsdPer1M: 4.4,
    sourceLabel: "OpenRouter model pricing",
    sourceUrl: "https://openrouter.ai/z-ai/glm-5.2",
    verifiedAt: "2026-06-17",
  },
  [formatModelId("openrouter", "moonshotai/kimi-k2.7-code")]: {
    inputUsdPer1M: 0.74,
    cachedInputUsdPer1M: 0.15,
    outputUsdPer1M: 3.5,
    notes: "OpenRouter marks reasoning as enabled by default for this model.",
    sourceLabel: "OpenRouter model pricing",
    sourceUrl: "https://openrouter.ai/moonshotai/kimi-k2.7-code",
    verifiedAt: "2026-06-29",
  },
  [formatModelId("openrouter", "moonshotai/kimi-k3")]: {
    inputUsdPer1M: 3,
    cachedInputUsdPer1M: 0.3,
    outputUsdPer1M: 15,
    sourceLabel: "OpenRouter model pricing",
    sourceUrl: "https://openrouter.ai/moonshotai/kimi-k3",
    verifiedAt: "2026-07-17",
  },

  [formatModelId("xai", "grok-4.5")]: {
    inputUsdPer1M: 2,
    cachedInputUsdPer1M: 0.5,
    outputUsdPer1M: 6,
    sourceLabel: "xAI model pricing",
    sourceUrl: "https://docs.x.ai/developers/models/grok-4.5",
    verifiedAt: "2026-07-09",
  },
  [formatModelId("xai", "grok-4.3")]: {
    inputUsdPer1M: 1.25,
    cachedInputUsdPer1M: 0.2,
    outputUsdPer1M: 2.5,
    sourceLabel: "xAI model pricing",
    sourceUrl: "https://docs.x.ai/developers/models/grok-4.3",
    verifiedAt: "2026-07-09",
  },
  [formatModelId("xai", "grok-4.20-0309-reasoning")]: {
    inputUsdPer1M: 1.25,
    outputUsdPer1M: 2.5,
    sourceLabel: "xAI model pricing",
    sourceUrl: "https://docs.x.ai/docs/models",
    verifiedAt: "2026-07-09",
  },
  [formatModelId("xai", "grok-4.20-0309-non-reasoning")]: {
    inputUsdPer1M: 1.25,
    outputUsdPer1M: 2.5,
    sourceLabel: "xAI model pricing",
    sourceUrl: "https://docs.x.ai/docs/models",
    verifiedAt: "2026-07-09",
  },
  [formatModelId("xai", "grok-4.20-multi-agent-0309")]: {
    inputUsdPer1M: 1.25,
    outputUsdPer1M: 2.5,
    sourceLabel: "xAI model pricing",
    sourceUrl: "https://docs.x.ai/docs/models",
    verifiedAt: "2026-07-09",
  },
  [formatModelId("xai", "grok-build-0.1")]: {
    inputUsdPer1M: 1,
    cachedInputUsdPer1M: 0.2,
    outputUsdPer1M: 2,
    sourceLabel: "xAI model pricing",
    sourceUrl: "https://docs.x.ai/developers/models/grok-build-0.1",
    verifiedAt: "2026-07-09",
  },
};

export function getModelPricing(
  fullModelId: string,
  overrides?: Record<string, ModelPricingOverride>
): ModelPricing | null {
  const base = MODEL_PRICING[fullModelId] ?? null;
  const override = overrides?.[fullModelId];

  if (!override && !base) {
    return null;
  }

  if (!override && base) {
    return base;
  }

  return {
    inputUsdPer1M: override!.inputUsdPer1M,
    outputUsdPer1M: override!.outputUsdPer1M,
    cachedInputUsdPer1M:
      override!.cachedInputUsdPer1M === null || override!.cachedInputUsdPer1M === undefined
        ? undefined
        : override!.cachedInputUsdPer1M,
    notes: base
      ? `Using your local override. Built-in reference source remains ${base.sourceLabel}.`
      : "Using your local override.",
    sourceLabel: "Local pricing override",
    sourceUrl: base?.sourceUrl ?? "",
    verifiedAt: override!.updatedAt.split("T")[0],
    isOverride: true,
  };
}

export function formatUsdPerMillion(value: number): string {
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  if (value < 1) {
    return `$${value.toFixed(3)}`;
  }
  return `$${value.toFixed(2)}`;
}
