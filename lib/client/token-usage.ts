import type { ChatMessage, StreamUsage } from "@/lib/providers/base";

export interface EstimatedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimated: true;
  maxTokens: number;
}

export type TokenUsageSource = "reported" | "partial" | "estimated";

export interface ResolvedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  maxTokens: number;
  estimated: boolean;
  usageSource: TokenUsageSource;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  inputAudioTokens?: number;
  outputAudioTokens?: number;
  providerCost?: number;
  providerCostUnit?: "usd" | "credits" | "unknown";
}

/**
 * Provider streams currently expose content chunks but not billing usage. This
 * estimate is intentionally conservative and stable enough for UI accounting.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => {
    // A small per-message overhead approximates chat role framing.
    return (
      total +
      4 +
      estimateTextTokens(message.role) +
      estimateTextTokens(message.content)
    );
  }, 0);
}

export function estimateModelCallUsage(input: {
  messages: ChatMessage[];
  output: string;
  maxTokens: number;
}): EstimatedTokenUsage {
  const inputTokens = estimateMessagesTokens(input.messages);
  const outputTokens = estimateTextTokens(input.output);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
    maxTokens: input.maxTokens,
  };
}

export function mergeStreamUsage(
  current: StreamUsage | undefined,
  next: StreamUsage | undefined
): StreamUsage | undefined {
  if (!next) return current;
  const merged: StreamUsage = { ...(current ?? {}) };
  for (const key of Object.keys(next) as Array<keyof StreamUsage>) {
    const value = next[key];
    if (value !== undefined) {
      (merged as Record<keyof StreamUsage, StreamUsage[keyof StreamUsage]>)[key] =
        value;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function resolveModelCallUsage(input: {
  messages: ChatMessage[];
  output: string;
  maxTokens: number;
  reportedUsage?: StreamUsage;
}): ResolvedTokenUsage {
  const estimate = estimateModelCallUsage({
    messages: input.messages,
    output: input.output,
    maxTokens: input.maxTokens,
  });
  const inputTokens = finiteNonNegative(input.reportedUsage?.inputTokens);
  const outputTokens = finiteNonNegative(input.reportedUsage?.outputTokens);
  const totalTokens = finiteNonNegative(input.reportedUsage?.totalTokens);
  const hasReportedInput = inputTokens !== undefined;
  const hasReportedOutput = outputTokens !== undefined;
  const reportedAny = hasReportedInput || hasReportedOutput || totalTokens !== undefined;
  const resolvedInputTokens = inputTokens ?? estimate.inputTokens;
  const resolvedOutputTokens = outputTokens ?? estimate.outputTokens;
  const resolvedTotalTokens =
    totalTokens ?? resolvedInputTokens + resolvedOutputTokens;
  const usageSource: TokenUsageSource =
    hasReportedInput && hasReportedOutput
      ? "reported"
      : reportedAny
        ? "partial"
        : "estimated";

  return {
    inputTokens: resolvedInputTokens,
    outputTokens: resolvedOutputTokens,
    totalTokens: resolvedTotalTokens,
    maxTokens: estimate.maxTokens,
    estimated: usageSource !== "reported",
    usageSource,
    ...optionalNumber("reasoningTokens", input.reportedUsage?.reasoningTokens),
    ...optionalNumber("cachedInputTokens", input.reportedUsage?.cachedInputTokens),
    ...optionalNumber(
      "cacheWriteInputTokens",
      input.reportedUsage?.cacheWriteInputTokens
    ),
    ...optionalNumber("inputAudioTokens", input.reportedUsage?.inputAudioTokens),
    ...optionalNumber("outputAudioTokens", input.reportedUsage?.outputAudioTokens),
    ...optionalNumber("providerCost", input.reportedUsage?.providerCost),
    ...(input.reportedUsage?.providerCostUnit
      ? { providerCostUnit: input.reportedUsage.providerCostUnit }
      : {}),
  };
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function optionalNumber<K extends string>(
  key: K,
  value: unknown
): Partial<Record<K, number>> {
  const finite = finiteNonNegative(value);
  return finite === undefined ? {} : { [key]: finite } as Record<K, number>;
}
