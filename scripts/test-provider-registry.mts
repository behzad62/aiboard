/* Provider registry drift checks (run: npx tsx scripts/test-provider-registry.mts) */
import { getAllProviders } from "../lib/client/providers";
import { MODEL_CATALOG } from "../lib/providers/catalog";
import { PROVIDER_IDS } from "../lib/providers/constants";
import { providerSupportsMaxTokensFeature } from "../lib/providers/provider-registry";
import {
  openAIReasoningEffort,
  providerSupportsReasoning,
} from "../lib/providers/reasoning";
import type { ReasoningEffort } from "../lib/db/schema";
import { getModelRuntimeBehavior } from "../lib/providers/runtime-behavior";
import { shouldEnableProviderNativeWebSearch } from "../lib/providers/web-search";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const providerIds = new Set<string>(PROVIDER_IDS);
const providers = getAllProviders();

for (const provider of providers) {
  check(
    `${provider.id} provider implementation is listed in PROVIDER_IDS`,
    providerIds.has(provider.id),
    { providerIds: [...providerIds], implementation: provider.id }
  );
}

for (const providerId of ["chatgpt", "github-copilot"]) {
  const provider = providers.find((candidate) => candidate.id === providerId);
  const catalogIds = MODEL_CATALOG.filter((model) => model.providerId === providerId)
    .map((model) => model.id);
  const implementationIds = provider?.listModels().map((model) => model.id) ?? [];
  check(
    `${providerId} models are sourced from MODEL_CATALOG`,
    catalogIds.length > 0 &&
      JSON.stringify(implementationIds) === JSON.stringify(catalogIds),
    { catalogIds, implementationIds }
  );
}

check(
  "ChatGPT account-backed GPT models support reasoning effort",
  providerSupportsReasoning("chatgpt:gpt-5.4"),
  null
);
check(
  "GitHub Copilot GPT models support reasoning effort",
  providerSupportsReasoning("github-copilot:gpt-5.4"),
  null
);
check(
  "GitHub Copilot Claude chat-completions models do not claim reasoning effort",
  !providerSupportsReasoning("github-copilot:claude-sonnet-4.5"),
  null
);
check(
  "Anthropic Opus models claim reasoning effort",
  providerSupportsReasoning("anthropic:claude-opus-4-8"),
  null
);
check(
  "Anthropic Haiku 4.5 does not claim reasoning effort",
  !providerSupportsReasoning("anthropic:claude-haiku-4-5-20251001"),
  null
);
check(
  "OpenAI none reasoning effort is forwarded explicitly",
  openAIReasoningEffort("none" as ReasoningEffort) === "none",
  openAIReasoningEffort("none" as ReasoningEffort)
);
check(
  "ChatGPT account runner exposes provider-native web search",
  shouldEnableProviderNativeWebSearch({
    providerId: "chatgpt",
    model: "gpt-5.4",
  }),
  null
);
check(
  "GitHub Copilot account runner does not claim provider-native web search",
  !shouldEnableProviderNativeWebSearch({
    providerId: "github-copilot",
    model: "gpt-5.4",
  }),
  null
);
check(
  "ChatGPT account runner does not claim max-token request support",
  !providerSupportsMaxTokensFeature("chatgpt", "gpt-5.4"),
  null
);
check(
  "GitHub Copilot account runner keeps max-token request support",
  providerSupportsMaxTokensFeature("github-copilot", "gpt-5.4"),
  null
);

for (const providerId of providerIds) {
  const behavior = getModelRuntimeBehavior(`${providerId}:registry-test-model`);
  check(
    `${providerId} has explicit runtime behavior metadata`,
    behavior.temperatureLabel !== "Temperature handling unknown" &&
      behavior.promptCachingLabel !== "Prompt caching unknown",
    behavior
  );
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
