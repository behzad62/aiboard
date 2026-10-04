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

export interface NativePlanningProvisioningOptions {
  planningPolicy?: { version: 1 };
  approvedSource?: import("./runner-v2").ApprovedSourceInputV1;
  specCopy?: boolean;
  answerReview?: boolean;
  handoffFiles?: "commit" | "export_only";
}

/** Fresh run choice only. Attachment/reconnect never infers a policy or approval. */
export function explicitNativePlanningOptions(input: NativePlanningProvisioningOptions = {}): NativePlanningProvisioningOptions {
  if (input.planningPolicy === undefined) {
    if (input.approvedSource !== undefined) throw new Error("Approving a source requires an explicit evidence-gated planning opt-in.");
    return {};
  }
  if (input.planningPolicy.version !== 1) throw new Error("Unsupported planning policy.");
  return { planningPolicy: { version: 1 }, ...(input.approvedSource !== undefined ? { approvedSource: input.approvedSource } : {}),
    ...(input.answerReview !== undefined ? { answerReview: input.answerReview } : {}),
    ...(input.specCopy !== undefined ? { specCopy: input.specCopy } : {}),
    ...(input.handoffFiles !== undefined ? { handoffFiles: input.handoffFiles } : {}) };
}
