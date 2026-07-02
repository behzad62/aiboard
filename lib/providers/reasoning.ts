import { parseModelId } from "./base";
import { providerSupportsReasoningEffortFeature } from "./provider-registry";
import type { ReasoningEffort } from "../db/schema";

/**
 * Maps the app's unified reasoning-effort level to each provider's native
 * parameter. Sources (verified 2026-07-02):
 *  - OpenAI GPT-5.5 `reasoning_effort`: none|low|medium|high|xhigh (default medium)
 *  - Anthropic `output_config.effort`: low|medium|high|xhigh|max (default high);
 *    Opus 4.5 supports effort plus manual `thinking.budget_tokens`, but not
 *    adaptive thinking or max effort; Haiku 4.5 does NOT support effort.
 *  - OpenRouter `reasoning.effort` / `reasoning_effort`: none|low|medium|high|xhigh|max.
 *  - Gemini 3+: `thinkingLevel` (minimal|low|medium|high); Gemini 2.5: `thinkingBudget`
 *    (int). Sending both is a 400, so we pick one by model generation.
 * "default" means omit provider reasoning controls except on Gemini 2.5, where
 * the existing bounded budget prevents hidden thinking from starving the answer.
 */

/** OpenAI / OpenRouter `reasoning_effort` string, or null to omit. */
export function openAIReasoningEffort(effort: ReasoningEffort): string | null {
  switch (effort) {
    case "none":
      return "none";
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

/** OpenRouter `reasoning_effort` string, or null to omit. */
export function openRouterReasoningEffort(
  effort: ReasoningEffort
): string | null {
  switch (effort) {
    case "none":
      return "none";
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

function normalizeAnthropicModel(model: string): string {
  return model.trim().toLowerCase();
}

function hasAnthropicModelPrefix(model: string, prefix: string): boolean {
  const normalized = normalizeAnthropicModel(model);
  return (
    normalized === prefix ||
    normalized.startsWith(`${prefix}-`) ||
    normalized.startsWith(`${prefix}@`)
  );
}

function anthropicThinkingAlwaysOn(model: string): boolean {
  return (
    hasAnthropicModelPrefix(model, "claude-fable-5") ||
    hasAnthropicModelPrefix(model, "claude-mythos-5")
  );
}

function anthropicUsesAdaptiveThinkingField(model: string): boolean {
  return (
    anthropicThinkingAlwaysOn(model) ||
    hasAnthropicModelPrefix(model, "claude-mythos-preview") ||
    hasAnthropicModelPrefix(model, "claude-opus-4-8") ||
    hasAnthropicModelPrefix(model, "claude-opus-4-7") ||
    hasAnthropicModelPrefix(model, "claude-opus-4-6") ||
    hasAnthropicModelPrefix(model, "claude-sonnet-5") ||
    hasAnthropicModelPrefix(model, "claude-sonnet-4-6")
  );
}

function anthropicUsesManualThinkingField(model: string): boolean {
  return hasAnthropicModelPrefix(model, "claude-opus-4-5");
}

function anthropicSupportsEffort(model: string): boolean {
  return (
    anthropicUsesAdaptiveThinkingField(model) ||
    anthropicUsesManualThinkingField(model)
  );
}

function anthropicSupportsMaxEffort(model: string): boolean {
  return (
    anthropicUsesAdaptiveThinkingField(model) &&
    !hasAnthropicModelPrefix(model, "claude-haiku-4-5")
  );
}

/** Anthropic `output_config.effort`, gated by model support, or null to omit. */
export function anthropicEffort(
  model: string,
  effort: ReasoningEffort
): string | null {
  if (effort === "default") return null;
  if (!anthropicSupportsEffort(model)) return null;
  if (effort === "none") {
    return anthropicThinkingAlwaysOn(model) ? "low" : null;
  }
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "max":
      return anthropicSupportsMaxEffort(model) ? "max" : "high";
    default:
      return null;
  }
}

function anthropicManualThinkingBudget(
  effort: ReasoningEffort,
  maxTokens: number
): number | null {
  if (effort === "default" || effort === "none") return null;

  const limit = Math.floor(maxTokens);
  if (!Number.isFinite(limit) || limit <= 1024) return null;
  const responseReserve = Math.min(
    1024,
    Math.max(256, Math.floor(limit * 0.25))
  );
  const maxThinkingBudget = limit - responseReserve;
  if (maxThinkingBudget < 1024) return null;

  const ratio =
    effort === "low"
      ? 0.25
      : effort === "medium"
        ? 0.5
        : effort === "high"
          ? 0.75
          : 0.875;
  return Math.min(maxThinkingBudget, Math.max(1024, Math.floor(limit * ratio)));
}

export function anthropicReasoningFields(
  model: string,
  effort: ReasoningEffort,
  maxTokens = 1500
): Record<string, unknown> {
  const value = anthropicEffort(model, effort);
  if (!value) return {};
  if (anthropicUsesManualThinkingField(model)) {
    const budgetTokens = anthropicManualThinkingBudget(effort, maxTokens);
    return {
      ...(budgetTokens
        ? {
            thinking: {
              type: "enabled",
              budget_tokens: budgetTokens,
              display: "omitted",
            },
          }
        : {}),
      output_config: { effort: value },
    };
  }
  return {
    ...(anthropicUsesAdaptiveThinkingField(model)
      ? { thinking: { type: "adaptive" } }
      : {}),
    output_config: { effort: value },
  };
}

function geminiMajorVersion(model: string): number {
  const match = /gemini-(\d+)/i.exec(model);
  return match ? parseInt(match[1], 10) : 0;
}

function geminiThinkingLevel(
  model: string,
  effort: ReasoningEffort
): string | null {
  const normalized = model.toLowerCase();
  const proSupportsOnlyLowHigh =
    normalized.includes("pro") && !normalized.startsWith("gemini-3.5-");

  if (proSupportsOnlyLowHigh) {
    switch (effort) {
      case "none":
      case "low":
        return "low";
      case "medium":
      case "high":
      case "max":
        return "high";
      default:
        return null;
    }
  }

  switch (effort) {
    case "none":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "max":
      return "high";
    default:
      return null;
  }
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
    const thinkingLevel = geminiThinkingLevel(model, effort);
    return thinkingLevel ? { thinkingLevel } : null;
  }

  switch (effort) {
    case "none":
      return { thinkingBudget: 0 };
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
