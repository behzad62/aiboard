import type { NativeBuildRunPolicy } from "./build-spec.js";

export type NativeBudgetRuntimeCostBasis =
  | "priced_api"
  | "account_not_metered"
  | "unknown";

export interface NativeBudgetRuntime {
  runtimeId: string;
  costBasis: NativeBudgetRuntimeCostBasis;
}

export interface NativeBudgetPolicyInput {
  runPolicy: NativeBuildRunPolicy;
  budgetLimits: {
    maxEstimatedCostMicros?: number;
    maxActiveMs?: number;
  };
}

export function nativeBuildBudgetEnforceabilityError(
  policy: NativeBudgetPolicyInput,
  runtimes: readonly NativeBudgetRuntime[]
): string | null {
  if (
    policy.runPolicy !== "budgeted" ||
    (policy.budgetLimits.maxEstimatedCostMicros ?? 0) <= 0 ||
    (policy.budgetLimits.maxActiveMs ?? 0) > 0
  ) return null;
  const unenforceable = runtimes.filter((runtime) => runtime.costBasis !== "priced_api");
  if (unenforceable.length === 0) return null;
  const account = unenforceable.filter(
    (runtime) => runtime.costBasis === "account_not_metered"
  );
  const unknown = unenforceable.filter((runtime) => runtime.costBasis === "unknown");
  const reasons = [
    ...(account.length > 0
      ? [`${account.map((item) => item.runtimeId).join(", ")} (${account.length === 1 ? "account-backed runtime" : "account-backed runtimes"})`]
      : []),
    ...(unknown.length > 0
      ? [`${unknown.map((item) => item.runtimeId).join(", ")} (${unknown.length === 1 ? "runtime" : "runtimes"} missing API pricing)`]
      : []),
  ];
  return `A USD-only Budgeted run cannot be enforced for ${reasons.join(" and ")}. Add a time limit or choose only API runtimes with input and output pricing.`;
}
