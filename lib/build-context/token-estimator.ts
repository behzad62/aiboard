export const ESTIMATED_CHARS_PER_TOKEN = 3.6;
export const MESSAGE_FRAME_TOKENS = 4;
export const MESSAGE_REPLY_PRIMER_TOKENS = 3;

export interface TokenMessage {
  role?: string;
  name?: string;
  content: string;
}

export interface TokenTruncationOptions {
  marker?: string;
  preserveEndTokens?: number;
}

export interface TokenTruncationResult {
  text: string;
  budgetTokens: number;
  estimatedTokens: number;
  originalEstimatedTokens: number;
  truncated: boolean;
}

function cjkCharCount(text: string): number {
  const matches = text.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g);
  return matches?.length ?? 0;
}

function lineBreakCount(text: string): number {
  const matches = text.match(/\n/g);
  return matches?.length ?? 0;
}

/**
 * Conservative tokenizer-free estimate for browser-only prompt planning.
 *
 * English/code commonly averages close to 4 chars per token. We use 3.6
 * chars/token, add a small newline overhead, and add extra weight for CJK
 * characters so budget checks fail closed without pulling in a tokenizer.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const baseTokens = Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);
  const newlineOverhead = Math.ceil(lineBreakCount(text) * 0.25);
  const cjkOverhead = Math.ceil(cjkCharCount(text) * 0.5);
  return Math.max(1, baseTokens + newlineOverhead + cjkOverhead);
}

export function estimateMessageTokens(messages: TokenMessage[]): number {
  if (messages.length === 0) return 0;

  const messagesTokens = messages.reduce((total, message) => {
    const roleTokens = message.role ? estimateTokens(message.role) : 0;
    const nameTokens = message.name ? estimateTokens(message.name) : 0;
    return (
      total +
      MESSAGE_FRAME_TOKENS +
      roleTokens +
      nameTokens +
      estimateTokens(message.content)
    );
  }, 0);

  return messagesTokens + MESSAGE_REPLY_PRIMER_TOKENS;
}

function takePrefixWithinBudget(text: string, budgetTokens: number): string {
  if (budgetTokens <= 0 || text.length === 0) return "";
  if (estimateTokens(text) <= budgetTokens) return text;

  let low = 0;
  let high = text.length;
  let best = "";

  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = text.slice(0, midpoint);
    if (estimateTokens(candidate) <= budgetTokens) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function takeSuffixWithinBudget(text: string, budgetTokens: number): string {
  if (budgetTokens <= 0 || text.length === 0) return "";
  if (estimateTokens(text) <= budgetTokens) return text;

  let low = 0;
  let high = text.length;
  let best = "";

  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = text.slice(text.length - midpoint);
    if (estimateTokens(candidate) <= budgetTokens) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function takePrefixWithAffixes(
  text: string,
  budgetTokens: number,
  marker: string,
  suffix: string
): string {
  const maxPrefixLength = Math.max(0, text.length - suffix.length);
  let low = 0;
  let high = maxPrefixLength;
  let best = "";

  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = `${text.slice(0, midpoint)}${marker}${suffix}`;
    if (estimateTokens(candidate) <= budgetTokens) {
      best = text.slice(0, midpoint);
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

export function truncateToTokenBudget(
  text: string,
  budgetTokens: number,
  options: TokenTruncationOptions = {}
): TokenTruncationResult {
  const normalizedBudget = Math.max(0, Math.floor(budgetTokens));
  const originalEstimatedTokens = estimateTokens(text);

  if (originalEstimatedTokens <= normalizedBudget) {
    return {
      text,
      budgetTokens: normalizedBudget,
      estimatedTokens: originalEstimatedTokens,
      originalEstimatedTokens,
      truncated: false,
    };
  }

  if (normalizedBudget <= 0) {
    return {
      text: "",
      budgetTokens: normalizedBudget,
      estimatedTokens: 0,
      originalEstimatedTokens,
      truncated: true,
    };
  }

  const marker = options.marker ?? "\n...[truncated]\n";
  if (estimateTokens(marker) > normalizedBudget) {
    const prefixOnly = takePrefixWithinBudget(text, normalizedBudget);
    return {
      text: prefixOnly,
      budgetTokens: normalizedBudget,
      estimatedTokens: estimateTokens(prefixOnly),
      originalEstimatedTokens,
      truncated: true,
    };
  }

  const preserveEndTokens = Math.max(
    0,
    Math.min(options.preserveEndTokens ?? 0, normalizedBudget)
  );
  let suffix = takeSuffixWithinBudget(text, preserveEndTokens);

  if (estimateTokens(`${marker}${suffix}`) > normalizedBudget) {
    suffix = "";
  }

  const prefix = takePrefixWithAffixes(
    text,
    normalizedBudget,
    marker,
    suffix
  );
  let truncatedText = `${prefix}${marker}${suffix}`;

  if (estimateTokens(truncatedText) > normalizedBudget) {
    suffix = "";
    truncatedText = `${takePrefixWithAffixes(
      text,
      normalizedBudget,
      marker,
      ""
    )}${marker}`;
  }

  return {
    text: truncatedText,
    budgetTokens: normalizedBudget,
    estimatedTokens: estimateTokens(truncatedText),
    originalEstimatedTokens,
    truncated: true,
  };
}
