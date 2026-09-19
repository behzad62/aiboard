import type { BuildRunPolicy } from "@/lib/db/schema";
import type { NormalizedBuildSettings } from "@/lib/orchestrator/build-policy";
import {
  NODE_RUNTIME_POLICY_DESCRIPTION,
  SUPPORTED_NODE_LTS_LINES,
  supportsNodeVersion,
} from "@/runner-v2/src/node-version";
export {
  nativeBuildBudgetEnforceabilityError,
  type NativeBudgetRuntime,
  type NativeBudgetRuntimeCostBasis,
} from "@/runner-v2/src/budget-enforceability";

export const NATIVE_RUNNER_NODE_POLICY_DESCRIPTION = NODE_RUNTIME_POLICY_DESCRIPTION;
export const NATIVE_RUNNER_NODE_LTS_LINES = SUPPORTED_NODE_LTS_LINES;
export const MINIMUM_NATIVE_RUNNER_NODE_VERSION = "24.0.0";

export function nativeProviderBillingBasis(input: {
  hasApiPricing: boolean;
  accountSubscription: boolean;
}): "account_not_metered" | "api_priced" | "unknown" {
  if (input.accountSubscription) return "account_not_metered";
  return input.hasApiPricing ? "api_priced" : "unknown";
}

export interface NativeBuildBudgetLimits {
  maxEstimatedCostMicros?: number;
  maxActiveMs?: number;
}

export interface EffectiveNativeBuildPolicy {
  runPolicy: BuildRunPolicy;
  budgetLimits: NativeBuildBudgetLimits;
  alwaysRequireIndependentVerifier: boolean;
}

export function usesBuildBudgetControls(policy: BuildRunPolicy): boolean {
  return policy === "budgeted";
}

export function supportsNativeRunnerNodeVersion(version: string): boolean {
  return supportsNodeVersion(version);
}

export function effectiveNativeBuildPolicy(
  settings: NormalizedBuildSettings
): EffectiveNativeBuildPolicy {
  if (!usesBuildBudgetControls(settings.runPolicy)) {
    return {
      runPolicy: settings.runPolicy,
      budgetLimits: {},
      alwaysRequireIndependentVerifier:
        settings.alwaysRequireIndependentVerifier,
    };
  }
  const budgetLimits: NativeBuildBudgetLimits = {};
  if (settings.budgetUsd > 0) {
    budgetLimits.maxEstimatedCostMicros = Math.round(
      settings.budgetUsd * 1_000_000
    );
  }
  if (settings.timeLimitMinutes > 0) {
    budgetLimits.maxActiveMs = Math.round(
      settings.timeLimitMinutes * 60_000
    );
  }
  if (Object.keys(budgetLimits).length === 0) {
    throw new Error("Budgeted runs require a USD or time limit.");
  }
  return {
    runPolicy: settings.runPolicy,
    budgetLimits,
    alwaysRequireIndependentVerifier:
      settings.alwaysRequireIndependentVerifier,
  };
}
