import assert from "node:assert/strict";

import {
  effectiveNativeBuildPolicy,
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
assert.deepEqual(finish, { runPolicy: "finish", budgetLimits: {} });
assert.equal(usesBuildBudgetControls("finish"), false);

const planOnly = effectiveNativeBuildPolicy(
  normalizeBuildSettings({
    buildRunPolicy: "plan_only",
    buildBudgetUsd: 25,
    buildTimeLimitMinutes: 120,
  })
);
assert.deepEqual(planOnly, { runPolicy: "plan_only", budgetLimits: {} });
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

assert.equal(supportsNativeRunnerNodeVersion("24.18.0"), true);
assert.equal(supportsNativeRunnerNodeVersion("24.20.0"), true);
assert.equal(supportsNativeRunnerNodeVersion("25.0.0"), true);
assert.equal(supportsNativeRunnerNodeVersion("24.17.9"), false);
assert.equal(supportsNativeRunnerNodeVersion("invalid"), false);

console.log("PASS native Build policy");
