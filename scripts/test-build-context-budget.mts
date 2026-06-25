/** Build context budget checks (run: npx tsx scripts/test-build-context-budget.mts) */
import {
  createBuildPromptBudget,
  inferContextTier,
  type BuildPromptRole,
  type ContextTier,
} from "../lib/build-context/budgets";
import {
  estimateTokens,
  truncateToTokenBudget,
} from "../lib/build-context/token-estimator";
import type { ModelContextProfile } from "../lib/providers/model-context";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

function profileFor(
  fullModelId: string,
  contextWindowTokens: number,
  effectiveBuildInputCeilingTokens: number
): ModelContextProfile {
  const [providerId, modelId] = fullModelId.split(":");
  return {
    providerId,
    modelId,
    fullModelId,
    contextWindowTokens,
    maxOutputTokens: Math.min(16_384, Math.floor(contextWindowTokens / 2)),
    buildOutputReserveTokens: Math.min(16_384, Math.floor(contextWindowTokens / 2)),
    effectiveBuildInputCeilingTokens,
    longContextQuality: "good",
    promptCaching: false,
    recommendedBuildRoles: ["worker"],
    source: "default",
  };
}

const tokenEstimate = estimateTokens("0123456789 ".repeat(40));
check(
  "token estimator is conservative for plain ASCII text",
  tokenEstimate >= 100 && tokenEstimate <= 140,
  tokenEstimate
);

const truncated = truncateToTokenBudget("alpha beta gamma delta ".repeat(100), 40);
check(
  "truncate helper keeps text within budget",
  truncated.truncated &&
    truncated.estimatedTokens <= 40 &&
    truncated.originalEstimatedTokens > truncated.estimatedTokens,
  truncated
);

const tiers: ContextTier[] = [
  inferContextTier(profileFor("custom:tiny-local", 8_192, 6_144)),
  inferContextTier(profileFor("custom:standard-local", 64_000, 56_000)),
  inferContextTier(profileFor("anthropic:large-model", 200_000, 180_000)),
  inferContextTier(profileFor("google:huge-model", 1_048_576, 983_040)),
];
check(
  "context tier inference distinguishes tiny, standard, large, and huge",
  tiers.join(",") === "tiny,standard,large,huge",
  tiers
);

const workerBudgets = (["tiny", "standard", "large", "huge"] as ContextTier[]).map((tier) =>
  createBuildPromptBudget({ role: "worker", tier })
);
check(
  "tiny/standard/large/huge worker budgets differ and increase",
  workerBudgets.every((budget, index) => {
    if (index === 0) return true;
    return (
      budget.totalInputTokens > workerBudgets[index - 1].totalInputTokens &&
      budget.contextPackTokens > workerBudgets[index - 1].contextPackTokens
    );
  }),
  workerBudgets
);

const roleBudgets = (["architect", "worker", "reviewer", "summary"] as BuildPromptRole[]).map(
  (role) => createBuildPromptBudget({ role, tier: "standard" })
);
check(
  "role budgets expose distinct pack/history allocations",
  new Set(roleBudgets.map((budget) => `${budget.contextPackTokens}:${budget.historyTokens}`))
    .size === roleBudgets.length,
  roleBudgets
);

const cappedProfile = profileFor("custom:capped", 128_000, 20_000);
const cappedBudget = createBuildPromptBudget({ role: "architect", profile: cappedProfile });
check(
  "profile effective input ceiling caps generated prompt budget",
  cappedBudget.tier === "tiny" &&
    cappedBudget.totalInputTokens <= cappedProfile.effectiveBuildInputCeilingTokens,
  cappedBudget
);

const zeroCeilingBudget = createBuildPromptBudget({
  role: "worker",
  profile: {
    contextWindowTokens: 128_000,
    buildOutputReserveTokens: 8_192,
    effectiveBuildInputCeilingTokens: 0,
  },
});
check(
  "explicit zero effective input ceiling is preserved",
  zeroCeilingBudget.tier === "tiny" &&
    zeroCeilingBudget.totalInputTokens === 0 &&
    zeroCeilingBudget.contextPackTokens === 0 &&
    zeroCeilingBudget.modelInputCeilingTokens === 0,
  zeroCeilingBudget
);

process.exit(failed === 0 ? 0 : 1);
