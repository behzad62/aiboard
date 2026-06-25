import type {
  BuildRunPolicy,
  BuildSkillMode,
  BuildStopReason,
  Discussion,
} from "@/lib/db/schema";

export const DEFAULT_BUILD_RUN_POLICY: BuildRunPolicy = "finish";
export const DEFAULT_BUILD_SKILL_MODE: BuildSkillMode = "balanced";
export const DEFAULT_BUILD_BUDGET_USD = 0;
export const DEFAULT_BUILD_TIME_LIMIT_MINUTES = 120;

export interface NormalizedBuildSettings {
  runPolicy: BuildRunPolicy;
  skillMode: BuildSkillMode;
  budgetUsd: number;
  timeLimitMinutes: number;
}

const RUN_POLICIES = new Set<BuildRunPolicy>(["finish", "budgeted", "plan_only"]);
const SKILL_MODES = new Set<BuildSkillMode>(["fast", "balanced", "strict", "safe"]);

function coerceNonNegativeNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

export function normalizeBuildSettings(
  input: Partial<
    Pick<
      Discussion,
      | "buildRunPolicy"
      | "buildSkillMode"
      | "buildBudgetUsd"
      | "buildTimeLimitMinutes"
    >
  >
): NormalizedBuildSettings {
  const requested = input.buildRunPolicy;
  const runPolicy =
    requested && RUN_POLICIES.has(requested) ? requested : DEFAULT_BUILD_RUN_POLICY;
  const requestedSkillMode = input.buildSkillMode;
  const skillMode =
    requestedSkillMode && SKILL_MODES.has(requestedSkillMode)
      ? requestedSkillMode
      : DEFAULT_BUILD_SKILL_MODE;
  return {
    runPolicy,
    skillMode,
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

export function buildSkillModeLabel(
  mode: BuildSkillMode | string | null | undefined
): string {
  const skillMode = normalizeBuildSettings({
    buildSkillMode: mode as BuildSkillMode,
  }).skillMode;
  switch (skillMode) {
    case "fast":
      return "Fast skills";
    case "balanced":
      return "Balanced skills";
    case "strict":
      return "Strict skills";
    case "safe":
      return "Safe skills";
  }
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

export function buildRunPolicyLabel(
  policy: BuildRunPolicy | string | null | undefined
): string {
  const runPolicy = normalizeBuildSettings({
    buildRunPolicy: policy as BuildRunPolicy,
  }).runPolicy;
  switch (runPolicy) {
    case "finish":
      return "Finish job";
    case "budgeted":
      return "Budgeted run";
    case "plan_only":
      return "Plan only";
  }
}
