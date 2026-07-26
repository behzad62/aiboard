export type RunnerReasoningEffort =
  | "none"
  | "default"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export function normalizeRunnerReasoningEffort(
  value: unknown
): RunnerReasoningEffort {
  return value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
    ? value
    : "default";
}

export function openAICompatibleReasoningFields(input: {
  providerId: string;
  modelId: string;
  protocol: "chat-completions" | "responses";
  effort: unknown;
}): Record<string, unknown> {
  const effort = normalizeRunnerReasoningEffort(input.effort);
  let native: string | null = null;
  if (input.providerId === "xai") {
    if (
      effort !== "default" &&
      !input.modelId.trim().toLowerCase().includes("non-reasoning")
    ) {
      const supportsXHigh = input.modelId
        .trim()
        .toLowerCase()
        .includes("multi-agent");
      native =
        effort === "none"
          ? "low"
          : effort === "xhigh" || effort === "max"
            ? supportsXHigh
              ? "xhigh"
              : "high"
            : effort;
    }
  } else if (
    input.providerId === "openrouter" &&
    ["moonshotai/kimi-k3", "kimi-k3"].includes(
      input.modelId.trim().toLowerCase()
    )
  ) {
    native =
      effort === "default" || effort === "none" ? null : "max";
  } else if (effort !== "default") {
    native =
      input.providerId === "openai" &&
      effort === "max" &&
      !input.modelId.trim().toLowerCase().startsWith("gpt-5.6")
        ? "xhigh"
        : effort;
  }
  if (!native) return {};
  return input.protocol === "responses"
    ? { reasoning: { effort: native } }
    : { reasoning_effort: native };
}

function hasModelPrefix(model: string, prefix: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    normalized === prefix ||
    normalized.startsWith(`${prefix}-`) ||
    normalized.startsWith(`${prefix}@`)
  );
}

function anthropicAlwaysOn(model: string): boolean {
  return (
    hasModelPrefix(model, "claude-fable-5") ||
    hasModelPrefix(model, "claude-mythos-5")
  );
}

function anthropicAdaptive(model: string): boolean {
  return (
    anthropicAlwaysOn(model) ||
    hasModelPrefix(model, "claude-mythos-preview") ||
    hasModelPrefix(model, "claude-opus-5") ||
    hasModelPrefix(model, "claude-opus-4-8") ||
    hasModelPrefix(model, "claude-opus-4-7") ||
    hasModelPrefix(model, "claude-opus-4-6") ||
    hasModelPrefix(model, "claude-sonnet-5") ||
    hasModelPrefix(model, "claude-sonnet-4-6")
  );
}

function anthropicManual(model: string): boolean {
  return hasModelPrefix(model, "claude-opus-4-5");
}

export function anthropicReasoningFields(
  model: string,
  rawEffort: unknown,
  maxTokens: number
): Record<string, unknown> {
  const effort = normalizeRunnerReasoningEffort(rawEffort);
  if (
    effort === "default" ||
    (!anthropicAdaptive(model) && !anthropicManual(model)) ||
    (effort === "none" && !anthropicAlwaysOn(model))
  ) {
    return {};
  }
  const supportsMax = anthropicAdaptive(model);
  const native =
    effort === "none"
      ? "low"
      : effort === "xhigh"
        ? supportsMax
          ? "xhigh"
          : "high"
        : effort === "max"
          ? supportsMax
            ? "max"
            : "high"
          : effort;
  if (anthropicManual(model)) {
    const limit = Math.floor(maxTokens);
    const reserve = Math.min(1024, Math.max(256, Math.floor(limit * 0.25)));
    const maxBudget = limit - reserve;
    const ratio =
      effort === "low"
        ? 0.25
        : effort === "medium"
          ? 0.5
          : effort === "high"
            ? 0.75
            : 0.875;
    const budget =
      limit > 1024 && maxBudget >= 1024
        ? Math.min(maxBudget, Math.max(1024, Math.floor(limit * ratio)))
        : null;
    return {
      ...(budget
        ? {
            thinking: {
              type: "enabled",
              budget_tokens: budget,
              display: "omitted",
            },
          }
        : {}),
      output_config: { effort: native },
    };
  }
  return {
    thinking: { type: "adaptive" },
    output_config: { effort: native },
  };
}

export function geminiThinkingConfig(
  model: string,
  rawEffort: unknown,
  maxTokens = 16_384
): Record<string, unknown> | null {
  const effort = normalizeRunnerReasoningEffort(rawEffort);
  const normalized = model.toLowerCase();
  const major = Number(/gemini-(\d+)/i.exec(model)?.[1] ?? 0);
  if (major >= 3) {
    if (effort === "default") return null;
    if (normalized === "gemini-3.6-flash") {
      return {
        thinkingLevel:
          effort === "high" || effort === "xhigh" || effort === "max"
            ? "HIGH"
            : "MEDIUM",
      };
    }
    if (
      normalized.includes("pro") &&
      !normalized.startsWith("gemini-3.5-")
    ) {
      return {
        thinkingLevel:
          effort === "none" || effort === "low" ? "LOW" : "HIGH",
      };
    }
    return {
      thinkingLevel:
        effort === "none"
          ? "MINIMAL"
          : effort === "low"
            ? "LOW"
            : effort === "medium"
              ? "MEDIUM"
              : "HIGH",
    };
  }
  const thinkingBudget =
    effort === "none"
      ? 0
      : effort === "low"
        ? 512
        : effort === "medium"
          ? 2048
          : effort === "high" || effort === "xhigh"
            ? 8192
            : effort === "max"
              ? -1
              : Math.min(4096, Math.max(0, Math.floor(maxTokens / 2)));
  return { thinkingBudget };
}
