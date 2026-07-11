/** Build usage aggregation checks (run: npx tsx scripts/test-build-usage.mts) */
import {
  addBuildUsageCall,
  createBuildUsageWindow,
  estimatedUsdForTokens,
  resumeBuildUsageWindow,
} from "../lib/client/build-usage";
import type { BuildUsageCallInput } from "../lib/client/build-usage";
import { formatTokenCount } from "../lib/client/token-usage";
import { BuildRunStats, formatBuildRunStatusText } from "../components/BuildRunStats";
import { BuildTranscriptPanel } from "../components/BuildTranscriptPanel";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};
const closeEnough = (actual: number | null | undefined, expected: number) =>
  actual != null && Math.abs(actual - expected) < 0.000001;

check("formats thousands compactly", formatTokenCount(18_734) === "18.7k");
check("formats millions compactly", formatTokenCount(1_234_567) === "1.2M");
check("exports Build usage stats component", typeof BuildRunStats === "function");
check("exports collapsed Build transcript component", typeof BuildTranscriptPanel === "function");
check(
  "completed run label ignores stale blocked stop reason",
  formatBuildRunStatusText("completed", "blocked") === "completed"
);
check(
  "stopped run label includes stop reason",
  formatBuildRunStatusText("stopped", "blocked") === "stopped (blocked)"
);

const usd = estimatedUsdForTokens({
  inputTokens: 500_000,
  outputTokens: 100_000,
  pricing: { inputUsdPer1M: 2, outputUsdPer1M: 10 },
});
check("calculates blended token USD", closeEnough(usd, 2), usd);

let window = createBuildUsageWindow("2026-06-21T00:00:00.000Z");
check(
  "creates empty usage window",
  window.startedAt === "2026-06-21T00:00:00.000Z" &&
    window.elapsedMs === 0 &&
    window.estimatedUsd === 0 &&
    window.unknownPricedModelIds.length === 0 &&
    window.models.length === 0,
  window
);

const geminiPricing = { inputUsdPer1M: 1.5, outputUsdPer1M: 9 };
const firstGeminiUsd = estimatedUsdForTokens({
  inputTokens: 18_000,
  outputTokens: 700,
  pricing: geminiPricing,
});
const secondGeminiUsd = estimatedUsdForTokens({
  inputTokens: 2_000,
  outputTokens: 300,
  pricing: geminiPricing,
});
const expectedGeminiUsd = firstGeminiUsd + secondGeminiUsd;

const firstGeminiCall: BuildUsageCallInput = {
  modelId: "google:gemini-3.5-flash",
  modelName: "Gemini 3.5 Flash",
  providerId: "google",
  inputTokens: 18_000,
  outputTokens: 700,
  pricing: geminiPricing,
  elapsedSinceWindowStartMs: 5_000,
};
window = addBuildUsageCall(window, firstGeminiCall);

const previousWindow = window;
const previousGemini = previousWindow.models.find((m) => m.modelId === "google:gemini-3.5-flash");
const secondGeminiCall: BuildUsageCallInput = {
  modelId: "google:gemini-3.5-flash",
  modelName: "Gemini 3.5 Flash",
  providerId: "google",
  inputTokens: 2_000,
  outputTokens: 300,
  pricing: geminiPricing,
  elapsedSinceWindowStartMs: 8_000,
};
window = addBuildUsageCall(previousWindow, secondGeminiCall);
const updatedGemini = window.models.find((m) => m.modelId === "google:gemini-3.5-flash");

check(
  "does not mutate previous usage window",
  previousWindow !== window &&
    previousWindow.elapsedMs === 5_000 &&
    closeEnough(previousWindow.estimatedUsd, firstGeminiUsd) &&
    previousWindow.models.length === 1,
  { previousWindow, window }
);
check(
  "does not mutate previous model totals",
  previousGemini?.calls === 1 &&
    previousGemini.providerId === "google" &&
    previousGemini.inputTokens === 18_000 &&
    previousGemini.outputTokens === 700 &&
    previousGemini.totalTokens === 18_700 &&
    formatTokenCount(previousGemini.totalTokens) === "18.7k" &&
    closeEnough(previousGemini.estimatedUsd, firstGeminiUsd),
  previousGemini
);
check("returns cloned updated model row", updatedGemini !== previousGemini, { previousGemini, updatedGemini });

window = addBuildUsageCall(window, {
  modelId: "custom:local",
  modelName: "Local",
  providerId: "custom",
  inputTokens: 1000,
  outputTokens: 100,
  pricing: null,
  elapsedSinceWindowStartMs: 10_000,
});

const geminiRows = window.models.filter((m) => m.modelId === "google:gemini-3.5-flash");
const gemini = geminiRows[0];
const local = window.models.find((m) => m.modelId === "custom:local");

check(
  "aggregates duplicate priced calls by model",
  geminiRows.length === 1 &&
    gemini?.calls === 2 &&
    gemini.inputTokens === 20_000 &&
    gemini.outputTokens === 1_000 &&
    gemini.totalTokens === 21_000 &&
    gemini.priced === true &&
    closeEnough(gemini.estimatedUsd, expectedGeminiUsd),
  { geminiRows, expectedGeminiUsd }
);
check("window USD sums priced calls", closeEnough(window.estimatedUsd, expectedGeminiUsd), window);
check("tracks unknown priced model ids", window.unknownPricedModelIds.includes("custom:local"), window);
check("unknown priced model has null USD", local?.estimatedUsd === null, local);
check("window elapsed tracks latest event", window.elapsedMs === 10_000, window);

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
const resumed = resumeBuildUsageWindow(previous, "2026-07-11T08:00:00.000Z");
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
