import type { ChatMessage } from "@/lib/providers/base";

export interface EstimatedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimated: true;
  maxTokens: number;
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

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}
