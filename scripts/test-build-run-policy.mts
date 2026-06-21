/** Build run policy checks (run: npx tsx scripts/test-build-run-policy.mts) */
import {
  DEFAULT_BUILD_TIME_LIMIT_MINUTES,
  buildRunPolicyLabel,
  isBuildBudgetUnlimited,
  normalizeBuildSettings,
  shouldStopForBuildGuardrail,
} from "../lib/orchestrator/build-policy";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const defaults = normalizeBuildSettings({});
check("default policy is finish", defaults.runPolicy === "finish", defaults);
check("default USD budget is unlimited", defaults.budgetUsd === 0, defaults);
check("default time limit is 2 hours", defaults.timeLimitMinutes === DEFAULT_BUILD_TIME_LIMIT_MINUTES, defaults);

const clamped = normalizeBuildSettings({
  buildRunPolicy: "not-real",
  buildBudgetUsd: -4,
  buildTimeLimitMinutes: -30,
});
check("invalid policy falls back to finish", clamped.runPolicy === "finish", clamped);
check("negative USD budget is unlimited", clamped.budgetUsd === 0, clamped);
check("negative time limit is unlimited", clamped.timeLimitMinutes === 0, clamped);
check("zero budget is unlimited", isBuildBudgetUnlimited(0), clamped);
check("finish label is user-facing", buildRunPolicyLabel("finish") === "Finish job");
check(
  "budgeted label is user-facing",
  buildRunPolicyLabel("budgeted") === "Budgeted run"
);
check(
  "plan_only label is user-facing",
  buildRunPolicyLabel("plan_only") === "Plan only"
);

const noStop = shouldStopForBuildGuardrail({
  settings: normalizeBuildSettings({ buildBudgetUsd: 0, buildTimeLimitMinutes: 0 }),
  spentUsd: 999,
  elapsedMs: 24 * 60 * 60 * 1000,
});
check("both zero limits do not stop", noStop === null, noStop);

const moneyStop = shouldStopForBuildGuardrail({
  settings: normalizeBuildSettings({ buildBudgetUsd: 2.5, buildTimeLimitMinutes: 0 }),
  spentUsd: 2.51,
  elapsedMs: 1,
});
check("USD budget stops at threshold", moneyStop === "budget", moneyStop);

const timeStop = shouldStopForBuildGuardrail({
  settings: normalizeBuildSettings({ buildBudgetUsd: 0, buildTimeLimitMinutes: 120 }),
  spentUsd: 0,
  elapsedMs: 121 * 60 * 1000,
});
check("time budget stops at threshold", timeStop === "time", timeStop);

check(
  "invalid policy label falls back to finish",
  buildRunPolicyLabel("not-real") === "Finish job"
);

process.exit(failed === 0 ? 0 : 1);
