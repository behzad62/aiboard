/* Kimi K3 OpenRouter support checks (run: npx tsx scripts/test-kimi-k3-support.mts) */
import OpenAI from "openai";
import type { ReasoningEffort } from "../lib/db/schema";
import { MODEL_CATALOG } from "../lib/providers/catalog";
import { formatModelId } from "../lib/providers/base";
import { getModelPricing } from "../lib/providers/pricing";
import {
  providerSupportsNativeBuildToolsFeature,
  providerSupportsNativeWebSearchFeature,
} from "../lib/providers/provider-registry";
import {
  openRouterReasoningEffort,
} from "../lib/providers/reasoning";
import { resolveModelContextProfile } from "../lib/providers/model-context";
import { streamOpenAICompatibleChat } from "../lib/providers/openai-compat";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const kimi = MODEL_CATALOG.find(
  (model) =>
    model.providerId === "openrouter" && model.id === "moonshotai/kimi-k3"
);
check("Kimi K3 is in the catalog", kimi !== undefined, kimi);
check(
  "Kimi K3 has the expected display metadata",
  kimi?.name === "Kimi K3" && kimi.description.includes("1M context"),
  kimi
);
check(
  "Kimi K3 advertises text and image input only",
  kimi?.capabilities.image === true &&
    kimi.capabilities.document === false &&
    kimi.capabilities.audio === false &&
    kimi.capabilities.video === false,
  kimi?.capabilities
);

const context = resolveModelContextProfile("moonshotai/kimi-k3", "openrouter");
check(
  "Kimi K3 uses a 1M context profile",
  context.contextWindowTokens === 1_048_576 &&
    context.maxOutputTokens === 32_768 &&
    context.buildOutputReserveTokens === 32_768 &&
    context.longContextQuality === "excellent" &&
    context.promptCaching === true &&
    context.recommendedBuildRoles?.length === 4,
  context
);

const pricing = getModelPricing(
  formatModelId("openrouter", "moonshotai/kimi-k3")
);
check(
  "Kimi K3 pricing is registered",
  pricing?.inputUsdPer1M === 3 &&
    pricing.outputUsdPer1M === 15 &&
    pricing.cachedInputUsdPer1M === 0.3,
  pricing
);

check(
  "Kimi K3 exposes native web search",
  providerSupportsNativeWebSearchFeature("openrouter", "moonshotai/kimi-k3")
);
check(
  "Kimi K3 exposes native Build tools",
  providerSupportsNativeBuildToolsFeature("openrouter", "moonshotai/kimi-k3")
);
check(
  "Unknown OpenRouter models remain fail-closed for native Build tools",
  !providerSupportsNativeBuildToolsFeature("openrouter", "unknown/model")
);

const mapOpenRouterReasoning = openRouterReasoningEffort as unknown as (
  effort: ReasoningEffort,
  model?: string
) => string | null;
for (const effort of ["low", "medium", "high", "max"] as const) {
  check(
    `Kimi K3 maps ${effort} to max`,
    mapOpenRouterReasoning(effort, "moonshotai/kimi-k3") === "max",
    mapOpenRouterReasoning(effort, "moonshotai/kimi-k3")
  );
}
check(
  "Kimi K3 omits unsupported off and default reasoning controls",
  mapOpenRouterReasoning("none", "moonshotai/kimi-k3") === null &&
    mapOpenRouterReasoning("default", "moonshotai/kimi-k3") === null,
  {
    none: mapOpenRouterReasoning("none", "moonshotai/kimi-k3"),
    default: mapOpenRouterReasoning("default", "moonshotai/kimi-k3"),
  }
);
check(
  "Other OpenRouter reasoning mappings are unchanged",
  mapOpenRouterReasoning("low", "qwen/qwen3.7-max") === "low" &&
    mapOpenRouterReasoning("max", "qwen/qwen3.7-max") === "max"
);

let captured: Record<string, unknown> | undefined;
const fakeClient = {
  chat: {
    completions: {
      create: async (request: Record<string, unknown>) => {
        captured = request;
        return (async function* () {})();
      },
    },
  },
} as unknown as OpenAI;

for await (const _chunk of streamOpenAICompatibleChat(
  fakeClient,
  {
    apiKey: "test-key",
    model: "moonshotai/kimi-k3",
    messages: [{ role: "user", content: "hello" }],
    reasoningEffort: "high",
    temperature: 0.2,
  },
  "openrouter",
  "OpenRouter",
  "max_tokens"
)) {
  // Exhaust the stream so the request is made and the generator completes.
}

check(
  "Kimi K3 transport sends max reasoning",
  captured?.reasoning_effort === "max",
  captured
);
check(
  "Kimi K3 transport omits temperature",
  captured !== undefined && !("temperature" in captured),
  captured
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
