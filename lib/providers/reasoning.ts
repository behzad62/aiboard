import { parseModelId } from "./base";
import { providerSupportsReasoningEffortFeature } from "./provider-registry";
import type { ReasoningEffort } from "../db/schema";

/**
 * Maps the app's unified reasoning-effort level to each provider's native
 * parameter. Sources (verified 2026-06-10):
 *  - OpenAI GPT-5.5 `reasoning_effort`: none|low|medium|high|xhigh (default medium)
 *  - Anthropic `output_config.effort`: low|medium|high|xhigh|max (default high);
 *    Haiku 4.5 does NOT support it; xhigh is Fable 5 / Opus-tier only.
 *  - OpenRouter `reasoning.effort` / `reasoning_effort`: maps to nearest supported.
 *  - Gemini 3+: `thinkingLevel` (low|medium|high); Gemini 2.5: `thinkingBudget`
 *    (int). Sending both is a 400, so we pick one by model generation.
 * "default" always means: send nothing, use the model's built-in behavior.
 */

/** OpenAI / OpenRouter `reasoning_effort` string, or null to omit. */
export function openAIReasoningEffort(effort: ReasoningEffort): string | null {
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "max":
      return "xhigh";
    default:
      return null;
  }
}

// Anthropic models that reject `output_config.effort` (would 400).
const ANTHROPIC_EFFORT_UNSUPPORTED = new Set<string>([
  "claude-haiku-4-5-20251001",
]);

/** Anthropic `output_config.effort`, gated by model support, or null to omit. */
export function anthropicEffort(
  model: string,
  effort: ReasoningEffort
): string | null {
  if (effort === "default") return null;
  if (ANTHROPIC_EFFORT_UNSUPPORTED.has(model)) return null;
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "max":
      return "max";
    default:
      return null;
  }
}

function geminiMajorVersion(model: string): number {
  const match = /gemini-(\d+)/i.exec(model);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * A `thinkingConfig` object to merge into Gemini's generationConfig, or null to
 * omit. Gemini 3+ uses `thinkingLevel`; 2.5 and earlier use `thinkingBudget`.
 * For Gemini 2.5 at "default" we keep a bounded budget so hidden thinking can't
 * starve the visible answer (the original short-answer fix).
 */
export function geminiThinkingConfig(
  model: string,
  effort: ReasoningEffort,
  maxTokens: number
): Record<string, unknown> | null {
  if (geminiMajorVersion(model) >= 3) {
    switch (effort) {
      case "low":
        return { thinkingLevel: "low" };
      case "medium":
        return { thinkingLevel: "medium" };
      case "high":
        return { thinkingLevel: "high" };
      case "max":
        return { thinkingLevel: "high" };
      default:
        return null; // let Gemini 3 manage thinking
    }
  }

  switch (effort) {
    case "low":
      return { thinkingBudget: 512 };
    case "medium":
      return { thinkingBudget: 2048 };
    case "high":
      return { thinkingBudget: 8192 };
    case "max":
      return { thinkingBudget: -1 }; // dynamic
    default:
      return {
        thinkingBudget: Math.min(4096, Math.max(0, Math.floor(maxTokens / 2))),
      };
  }
}

/** Whether this provider path should attempt to send a reasoning param at all. */
export function providerSupportsReasoning(fullModelId: string): boolean {
  const { providerId, model } = parseModelId(fullModelId);
  return providerSupportsReasoningEffortFeature(providerId, model);
}
