/** Build usage aggregation checks (run: npx tsx scripts/test-build-usage.mts) */
import {
  addBuildUsageCall,
  createBuildUsageWindow,
  estimatedUsdForTokens,
} from "../lib/client/build-usage";
import { formatTokenCount } from "../lib/client/token-usage";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

check("formats thousands compactly", formatTokenCount(18_734) === "18.7k");
check("formats millions compactly", formatTokenCount(1_234_567) === "1.2M");

const usd = estimatedUsdForTokens({
  inputTokens: 500_000,
  outputTokens: 100_000,
  pricing: { inputUsdPer1M: 2, outputUsdPer1M: 10 },
});
check("calculates blended token USD", Math.abs(usd - 2) < 0.000001, usd);

let window = createBuildUsageWindow("2026-06-21T00:00:00.000Z");
window = addBuildUsageCall(window, {
  modelId: "google:gemini-3.5-flash",
  modelName: "Gemini 3.5 Flash",
  providerId: "google",
  inputTokens: 18_000,
  outputTokens: 700,
  pricing: { inputUsdPer1M: 1.5, outputUsdPer1M: 9 },
  elapsedMs: 5_000,
});
window = addBuildUsageCall(window, {
  modelId: "custom:local",
  modelName: "Local",
  providerId: "custom",
  inputTokens: 1000,
  outputTokens: 100,
  pricing: null,
  elapsedMs: 10_000,
});

const gemini = window.models.find((m) => m.modelId === "google:gemini-3.5-flash");
const local = window.models.find((m) => m.modelId === "custom:local");

check("aggregates calls by model", gemini?.calls === 1 && gemini.totalTokens === 18_700, window);
check("tracks unknown priced model ids", window.unknownPricedModelIds.includes("custom:local"), window);
check("unknown priced model has null USD", local?.estimatedUsd === null, local);
check("window elapsed tracks latest event", window.elapsedMs === 10_000, window);

process.exit(failed === 0 ? 0 : 1);
