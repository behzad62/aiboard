import assert from "node:assert/strict";

import {
  effectiveNativeBuildPolicy,
  MINIMUM_NATIVE_RUNNER_NODE_VERSION,
  NATIVE_RUNNER_NODE_LTS_LINES,
  NATIVE_RUNNER_NODE_POLICY_DESCRIPTION,
  nativeBuildBudgetEnforceabilityError,
  nativeProviderBillingBasis,
  supportsNativeRunnerNodeVersion,
  usesBuildBudgetControls,
} from "../lib/client/native-build-policy";
import { normalizeBuildSettings } from "../lib/orchestrator/build-policy";

const finish = effectiveNativeBuildPolicy(
  normalizeBuildSettings({
    buildRunPolicy: "finish",
    buildBudgetUsd: 25,
    buildTimeLimitMinutes: 120,
  })
);
assert.deepEqual(finish, {
  runPolicy: "finish",
  budgetLimits: {},
  alwaysRequireIndependentVerifier: false,
});
assert.equal(usesBuildBudgetControls("finish"), false);

const planOnly = effectiveNativeBuildPolicy(
  normalizeBuildSettings({
    buildRunPolicy: "plan_only",
    buildBudgetUsd: 25,
    buildTimeLimitMinutes: 120,
  })
);
assert.deepEqual(planOnly, {
  runPolicy: "plan_only",
  budgetLimits: {},
  alwaysRequireIndependentVerifier: false,
});
assert.equal(usesBuildBudgetControls("plan_only"), false);

const budgeted = effectiveNativeBuildPolicy(
  normalizeBuildSettings({
    buildRunPolicy: "budgeted",
    buildBudgetUsd: 2.75,
    buildTimeLimitMinutes: 45,
  })
);
assert.deepEqual(budgeted, {
  runPolicy: "budgeted",
  alwaysRequireIndependentVerifier: false,
  budgetLimits: {
    maxEstimatedCostMicros: 2_750_000,
    maxActiveMs: 2_700_000,
  },
});
assert.equal(usesBuildBudgetControls("budgeted"), true);

assert.throws(
  () =>
    effectiveNativeBuildPolicy(
      normalizeBuildSettings({
        buildRunPolicy: "budgeted",
        buildBudgetUsd: 0,
        buildTimeLimitMinutes: 0,
      })
    ),
  /USD or time limit/i
);

const usdOnly = {
  runPolicy: "budgeted" as const,
  budgetLimits: { maxEstimatedCostMicros: 1_000_000 },
};
const timeOnly = {
  runPolicy: "budgeted" as const,
  budgetLimits: { maxActiveMs: 60_000 },
};
const usdAndTime = {
  runPolicy: "budgeted" as const,
  budgetLimits: { maxEstimatedCostMicros: 1_000_000, maxActiveMs: 60_000 },
};
const priced = {
  runtimeId: "api:priced",
  costBasis: "priced_api" as const,
};
const account = { runtimeId: "account:model", costBasis: "account_not_metered" as const };
const unknown = { runtimeId: "api:unknown", costBasis: "unknown" as const };

assert.match(
  nativeBuildBudgetEnforceabilityError(usdOnly, [account]) ?? "",
  /account:model.*time limit/i,
);
assert.match(
  nativeBuildBudgetEnforceabilityError(usdOnly, [unknown]) ?? "",
  /api:unknown.*pricing.*time limit/i,
);
assert.match(
  nativeBuildBudgetEnforceabilityError(usdOnly, [priced, account]) ?? "",
  /account:model/i,
);
assert.equal(nativeBuildBudgetEnforceabilityError(usdOnly, [priced]), null);
assert.equal(nativeBuildBudgetEnforceabilityError(timeOnly, [account, unknown]), null);
assert.equal(nativeBuildBudgetEnforceabilityError(usdAndTime, [account, unknown]), null);

assert.equal(
  nativeProviderBillingBasis({ hasApiPricing: true, accountSubscription: false }),
  "api_priced",
  "a priced NVIDIA-like local proxy is API billed despite its transport",
);
assert.equal(
  nativeProviderBillingBasis({ hasApiPricing: false, accountSubscription: true }),
  "account_not_metered",
);
assert.equal(
  nativeProviderBillingBasis({ hasApiPricing: true, accountSubscription: true }),
  "account_not_metered",
  "pricing overrides never turn a true account subscription into metered API billing",
);
assert.equal(
  nativeProviderBillingBasis({ hasApiPricing: false, accountSubscription: false }),
  "unknown",
);

assert.equal(NATIVE_RUNNER_NODE_POLICY_DESCRIPTION, "Node.js 24.x");
assert.deepEqual(NATIVE_RUNNER_NODE_LTS_LINES, [24]);
assert.equal(MINIMUM_NATIVE_RUNNER_NODE_VERSION, "24.0.0");
assert.equal(supportsNativeRunnerNodeVersion("22.13.0"), false);
assert.equal(supportsNativeRunnerNodeVersion("22.18.0"), false);
assert.equal(supportsNativeRunnerNodeVersion("24.0.0"), true);
assert.equal(supportsNativeRunnerNodeVersion("24.20.0"), true);
assert.equal(supportsNativeRunnerNodeVersion("22.12.9"), false);
assert.equal(supportsNativeRunnerNodeVersion("23.0.0"), false);
assert.equal(supportsNativeRunnerNodeVersion("25.0.0"), false);
assert.equal(supportsNativeRunnerNodeVersion("26.0.0"), false);
assert.equal(supportsNativeRunnerNodeVersion("invalid"), false);

console.log("PASS native Build policy");
