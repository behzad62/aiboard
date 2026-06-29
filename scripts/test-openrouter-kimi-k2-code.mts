/** OpenRouter Kimi K2.7 Code registry check (run: npx tsx scripts/test-openrouter-kimi-k2-code.mts) */
import { formatModelId } from "../lib/providers/base";
import { MODEL_CATALOG, getModelDisplayName } from "../lib/providers/catalog";
import { resolveModelContextProfile } from "../lib/providers/model-context";
import { getModelPricing } from "../lib/providers/pricing";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const modelId = "moonshotai/kimi-k2.7-code";
const fullModelId = formatModelId("openrouter", modelId);
const catalogEntry = MODEL_CATALOG.find(
  (model) => model.providerId === "openrouter" && model.id === modelId
);

check(
  "Kimi K2.7 Code is listed as a built-in OpenRouter model",
  catalogEntry?.name === "Kimi K2.7 Code" &&
    catalogEntry.capabilities.image === true &&
    catalogEntry.capabilities.document === false &&
    catalogEntry.capabilities.audio === false &&
    catalogEntry.capabilities.video === false,
  catalogEntry
);

check(
  "Kimi K2.7 Code display name resolves from the catalog",
  getModelDisplayName(fullModelId) === "Kimi K2.7 Code",
  getModelDisplayName(fullModelId)
);

const pricing = getModelPricing(fullModelId);
check(
  "Kimi K2.7 Code has OpenRouter reference pricing",
  pricing?.inputUsdPer1M === 0.74 &&
    pricing.outputUsdPer1M === 3.5 &&
    pricing.sourceUrl === "https://openrouter.ai/moonshotai/kimi-k2.7-code",
  pricing
);

const context = resolveModelContextProfile(modelId, "openrouter");
check(
  "Kimi K2.7 Code has a 262K OpenRouter context profile",
  context.contextWindowTokens === 262_144 &&
    context.maxOutputTokens === 16_384 &&
    context.buildOutputReserveTokens === 16_384 &&
    context.longContextQuality === "good" &&
    context.promptCaching === true &&
    context.recommendedBuildRoles?.join(",") === "architect,worker,reviewer" &&
    context.source === "registry",
  context
);

process.exit(failed === 0 ? 0 : 1);
