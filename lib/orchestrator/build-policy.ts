import type { BuildRunPolicy, BuildStopReason, Discussion } from "@/lib/db/schema";

export const DEFAULT_BUILD_RUN_POLICY: BuildRunPolicy = "finish";
export const DEFAULT_BUILD_BUDGET_USD = 0;
export const DEFAULT_BUILD_TIME_LIMIT_MINUTES = 120;

export interface NormalizedBuildSettings {
  runPolicy: BuildRunPolicy;
  budgetUsd: number;
  timeLimitMinutes: number;
}

const RUN_POLICIES = new Set<BuildRunPolicy>(["finish", "budgeted", "plan_only"]);

function coerceNonNegativeNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

export function normalizeBuildSettings(
  input: Partial<
    Pick<Discussion, "buildRunPolicy" | "buildBudgetUsd" | "buildTimeLimitMinutes">
  >
): NormalizedBuildSettings {
  const requested = input.buildRunPolicy;
  const runPolicy =
    requested && RUN_POLICIES.has(requested) ? requested : DEFAULT_BUILD_RUN_POLICY;
  return {
    runPolicy,
    budgetUsd: coerceNonNegativeNumber(
      input.buildBudgetUsd,
      DEFAULT_BUILD_BUDGET_USD
    ),
    timeLimitMinutes: coerceNonNegativeNumber(
      input.buildTimeLimitMinutes,
      DEFAULT_BUILD_TIME_LIMIT_MINUTES
    ),
  };
}

export function isBuildBudgetUnlimited(value: number): boolean {
  return value <= 0;
}

export function isBuildTimeUnlimited(minutes: number): boolean {
  return minutes <= 0;
}

export function shouldStopForBuildGuardrail(input: {
  settings: NormalizedBuildSettings;
  spentUsd: number;
  elapsedMs: number;
}): BuildStopReason | null {
  if (
    !isBuildBudgetUnlimited(input.settings.budgetUsd) &&
    input.spentUsd >= input.settings.budgetUsd
  ) {
    return "budget";
  }
  if (
    !isBuildTimeUnlimited(input.settings.timeLimitMinutes) &&
    input.elapsedMs >= input.settings.timeLimitMinutes * 60_000
  ) {
    return "time";
  }
  return null;
}

export function buildRunPolicyLabel(policy: BuildRunPolicy): string {
  switch (policy) {
    case "finish":
      return "Finish job";
    case "budgeted":
      return "Budgeted run";
    case "plan_only":
      return "Plan only";
  }
}
