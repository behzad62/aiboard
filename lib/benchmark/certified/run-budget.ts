import type { BenchmarkCaseV2 } from "@/lib/benchmark/types";
import type { CertifiedRunBudget } from "./run-context";

export function certifiedRunBudgetForCase(
  caseRecord: BenchmarkCaseV2,
  defaults: CertifiedRunBudget = {}
): CertifiedRunBudget {
  return {
    ...defaults,
    maxUsd: caseRecord.budget.maxUsd ?? defaults.maxUsd,
    maxModelCalls: caseRecord.budget.maxModelCalls ?? defaults.maxModelCalls,
    maxInputTokens: caseRecord.budget.maxInputTokens ?? defaults.maxInputTokens,
    maxOutputTokens: caseRecord.budget.maxOutputTokens ?? defaults.maxOutputTokens,
    maxWallClockMs:
      typeof caseRecord.budget.maxWallClockSeconds === "number"
        ? Math.max(0, Math.round(caseRecord.budget.maxWallClockSeconds * 1000))
        : defaults.maxWallClockMs,
  };
}
