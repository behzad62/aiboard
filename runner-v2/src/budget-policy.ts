import {
  BudgetExceededError,
  type BudgetDimension,
  type BudgetLimits,
  type BudgetUsage,
} from "./budget-ledger.js";

const LIMITS: Array<{
  dimension: BudgetDimension;
  limit: keyof BudgetLimits;
}> = [
  { dimension: "modelCalls", limit: "maxModelCalls" },
  { dimension: "toolCalls", limit: "maxToolCalls" },
  { dimension: "inputTokens", limit: "maxInputTokens" },
  { dimension: "outputTokens", limit: "maxOutputTokens" },
  { dimension: "estimatedCostMicros", limit: "maxEstimatedCostMicros" },
  { dimension: "activeMs", limit: "maxActiveMs" },
  { dimension: "artifactBytes", limit: "maxArtifactBytes" },
];

export function assertBudgetLimits(limits: BudgetLimits): void {
  for (const { limit } of LIMITS) {
    const value = limits[limit];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`${limit} must be a non-negative integer.`);
    }
  }
}

export function assertWithinBudget(
  scopeId: string,
  current: BudgetUsage,
  delta: Partial<BudgetUsage>,
  limits: BudgetLimits
): void {
  assertBudgetLimits(limits);
  for (const { dimension, limit } of LIMITS) {
    const maximum = limits[limit];
    if (maximum === undefined) continue;
    const attempted = current[dimension] + (delta[dimension] ?? 0);
    if (attempted > maximum) {
      throw new BudgetExceededError(scopeId, dimension, attempted, maximum);
    }
  }
}
