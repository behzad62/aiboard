/** Usage resolver checks (run: npx tsx scripts/test-token-usage-resolution.mts) */

import type { ChatMessage, StreamUsage } from "../lib/providers/base";
import {
  estimateModelCallUsage,
  resolveModelCallUsage,
} from "../lib/client/token-usage";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const messages: ChatMessage[] = [
  { role: "system", content: "You are concise." },
  { role: "user", content: "Return a short answer." },
];
const output = "Provider output text.";
const estimate = estimateModelCallUsage({ messages, output, maxTokens: 256 });

const reported: StreamUsage = {
  inputTokens: estimate.inputTokens + 10,
  outputTokens: estimate.outputTokens + 5,
  totalTokens: estimate.totalTokens + 15,
  reasoningTokens: 3,
  cachedInputTokens: 7,
  cacheWriteInputTokens: 11,
  providerCost: 0.0012,
  providerCostUnit: "credits",
};
const resolvedReported = resolveModelCallUsage({
  messages,
  output,
  maxTokens: 256,
  reportedUsage: reported,
});
check(
  "reported provider usage replaces local estimates",
  resolvedReported.inputTokens === reported.inputTokens &&
    resolvedReported.outputTokens === reported.outputTokens &&
    resolvedReported.totalTokens === reported.totalTokens &&
    resolvedReported.estimated === false &&
    resolvedReported.usageSource === "reported",
  resolvedReported
);
check(
  "provider usage metadata is preserved",
  resolvedReported.reasoningTokens === 3 &&
    resolvedReported.cachedInputTokens === 7 &&
    resolvedReported.cacheWriteInputTokens === 11 &&
    resolvedReported.providerCost === 0.0012 &&
    resolvedReported.providerCostUnit === "credits",
  resolvedReported
);

const partial = resolveModelCallUsage({
  messages,
  output,
  maxTokens: 256,
  reportedUsage: { outputTokens: 99, reasoningTokens: 12 },
});
check(
  "partial provider usage fills missing fields from the estimator",
  partial.inputTokens === estimate.inputTokens &&
    partial.outputTokens === 99 &&
    partial.totalTokens === estimate.inputTokens + 99 &&
    partial.estimated === true &&
    partial.usageSource === "partial",
  partial
);
check(
  "partial provider metadata is still preserved",
  partial.reasoningTokens === 12,
  partial
);

const fallback = resolveModelCallUsage({
  messages,
  output,
  maxTokens: 256,
});
check(
  "missing provider usage falls back to local estimate",
  fallback.inputTokens === estimate.inputTokens &&
    fallback.outputTokens === estimate.outputTokens &&
    fallback.totalTokens === estimate.totalTokens &&
    fallback.estimated === true &&
    fallback.usageSource === "estimated",
  fallback
);

const invalid = resolveModelCallUsage({
  messages,
  output,
  maxTokens: 256,
  reportedUsage: { inputTokens: Number.NaN, outputTokens: -1 },
});
check(
  "invalid provider usage is ignored",
  invalid.inputTokens === estimate.inputTokens &&
    invalid.outputTokens === estimate.outputTokens &&
    invalid.usageSource === "estimated",
  invalid
);

process.exit(failed === 0 ? 0 : 1);