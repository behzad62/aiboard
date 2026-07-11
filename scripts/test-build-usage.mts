/** Build usage resume checks (run: npx tsx scripts/test-build-usage.mts) */
import {
  addBuildUsageCall,
  resumeBuildUsageWindow,
} from "../lib/client/build-usage";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const previous = {
  startedAt: "2026-07-11T07:00:00.000Z",
  elapsedMs: 60_000,
  estimatedUsd: 1.25,
  unknownPricedModelIds: [],
  models: [{
    modelId: "chatgpt:gpt-5.4",
    modelName: "GPT-5.4",
    providerId: "chatgpt",
    calls: 3,
    inputTokens: 1_000,
    outputTokens: 500,
    totalTokens: 1_500,
    estimatedUsd: 1.25,
    priced: true,
  }],
};

const resumed = resumeBuildUsageWindow(
  previous,
  "2026-07-11T08:00:00.000Z"
);
check(
  "resume preserves cumulative calls, tokens, cost, elapsed time, and original start",
  resumed.startedAt === previous.startedAt &&
    resumed.elapsedMs === 60_000 &&
    resumed.estimatedUsd === 1.25 &&
    resumed.models[0]?.calls === 3 &&
    resumed.models[0]?.totalTokens === 1_500,
  resumed
);
resumed.models[0]!.calls += 1;
check(
  "resume clones durable usage instead of mutating checkpoint input",
  previous.models[0]?.calls === 3,
  previous
);

const continued = addBuildUsageCall(
  resumeBuildUsageWindow(previous, "2026-07-11T08:00:00.000Z"),
  {
    modelId: "chatgpt:gpt-5.4",
    modelName: "GPT-5.4",
    providerId: "chatgpt",
    inputTokens: 200,
    outputTokens: 100,
    pricing: { inputUsdPer1M: 1, outputUsdPer1M: 2 },
    elapsedSinceWindowStartMs: 65_000,
  }
);
check(
  "new calls accumulate on restored usage",
  continued.models[0]?.calls === 4 &&
    continued.models[0]?.totalTokens === 1_800 &&
    continued.elapsedMs === 65_000 &&
    continued.estimatedUsd > previous.estimatedUsd,
  continued
);

process.exit(failed === 0 ? 0 : 1);
