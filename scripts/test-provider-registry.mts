/* Provider registry drift checks (run: npx tsx scripts/test-provider-registry.mts) */
import { getAllProviders } from "../lib/client/providers";
import { MODEL_CATALOG } from "../lib/providers/catalog";
import { PROVIDER_IDS } from "../lib/providers/constants";
import {
  getProviderDefinition,
  providerSupportsHostedBuildToolsFeature,
  providerSupportsMaxTokensFeature,
  providerSupportsNativeBuildToolsFeature,
} from "../lib/providers/provider-registry";
import {
  openAIReasoningEffort,
  providerSupportsReasoning,
} from "../lib/providers/reasoning";
import type { ReasoningEffort } from "../lib/db/schema";
import { getModelRuntimeBehavior } from "../lib/providers/runtime-behavior";
import { shouldEnableProviderNativeWebSearch } from "../lib/providers/web-search";
import { MODEL_CONTEXT_PROFILES } from "../lib/providers/model-context";

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

check(
  "NVIDIA provider is registered for user-defined NIM models",
  providerIds.has("nvidia") &&
    providers.some(
      (provider) => provider.id === "nvidia" && provider.listModels().length === 0
    ),
  { providerIds: [...providerIds], providers: providers.map((provider) => provider.id) }
);

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

const chatGptAccountModelIds = MODEL_CATALOG.filter(
  (model) => model.providerId === "chatgpt"
).map((model) => model.id);
check(
  "ChatGPT catalog exposes the live-verified GPT-5.6 family",
  JSON.stringify(chatGptAccountModelIds.filter((modelId) => modelId.startsWith("gpt-5.6"))) ===
    JSON.stringify(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]),
  chatGptAccountModelIds
);
const chatGptCodexSpark = MODEL_CATALOG.find(
  (model) =>
    model.providerId === "chatgpt" && model.id === "gpt-5.3-codex-spark"
);
check(
  "ChatGPT GPT-5.3 Codex Spark claims image input support",
  chatGptCodexSpark?.capabilities.image === true,
  chatGptCodexSpark?.capabilities
);
check(
  "model context includes every live-verified ChatGPT 5.6 model",
  JSON.stringify(
    Object.keys(MODEL_CONTEXT_PROFILES).filter((modelId) =>
      modelId.startsWith("chatgpt:gpt-5.6")
    )
  ) ===
    JSON.stringify([
      "chatgpt:gpt-5.6-sol",
      "chatgpt:gpt-5.6-terra",
      "chatgpt:gpt-5.6-luna",
    ]),
  Object.keys(MODEL_CONTEXT_PROFILES).filter((modelId) => modelId.startsWith("chatgpt:gpt-5.6"))
);

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
  "GitHub Copilot Gemini 3.5 Flash supports reasoning effort",
  providerSupportsReasoning("github-copilot:gemini-3.5-flash"),
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
  "ChatGPT Codex Spark does not claim provider-native web search",
  !shouldEnableProviderNativeWebSearch({
    providerId: "chatgpt",
    model: "gpt-5.3-codex-spark",
  }),
  null
);
check(
  "GitHub Copilot GPT uses the SDK-backed provider-native web search",
  shouldEnableProviderNativeWebSearch({
    providerId: "github-copilot",
    model: "gpt-5.4",
  }),
  null
);
check(
  "GitHub Copilot Gemini uses the SDK-backed provider-native web search",
  shouldEnableProviderNativeWebSearch({
    providerId: "github-copilot",
    model: "gemini-3.5-flash",
  }),
  null
);
check(
  "ChatGPT account runner does not claim max-token request support",
  !providerSupportsMaxTokensFeature("chatgpt", "gpt-5.4"),
  null
);
const chatGptDefinition = getProviderDefinition("chatgpt");
check(
  "ChatGPT downloads the standalone account runner script",
  chatGptDefinition?.accountRunner?.downloadHref === "/account-provider-runner.mjs" &&
    chatGptDefinition.accountRunner.command === "node account-provider-runner.mjs",
  chatGptDefinition?.accountRunner
);
check(
  "GitHub Copilot account runner keeps max-token request support",
  providerSupportsMaxTokensFeature("github-copilot", "gpt-5.4"),
  null
);
const copilotDefinition = getProviderDefinition("github-copilot");
check(
  "GitHub Copilot downloads the SDK runner package",
  copilotDefinition?.accountRunner?.downloadHref === "/aiboard-account-provider-runner.zip" &&
    copilotDefinition.accountRunner.command === "npm install; npm start",
  copilotDefinition?.accountRunner
);
const nvidiaDefinition = getProviderDefinition("nvidia");
check(
  "NVIDIA exposes a standalone account runner download",
  nvidiaDefinition?.runnerDownload?.downloadHref === "/account-provider-runner.mjs" &&
    nvidiaDefinition.runnerDownload.command === "node account-provider-runner.mjs",
  nvidiaDefinition?.runnerDownload
);
check(
  "NVIDIA NIM provider supports max-token request caps",
  providerSupportsMaxTokensFeature("nvidia", "z-ai/glm-5.2"),
  null
);
check(
  "OpenAI Codex keeps native function-tool support",
  providerSupportsNativeBuildToolsFeature("openai", "gpt-5.3-codex"),
  null
);
check(
  "ChatGPT account runner does not expose native Build tools",
  !providerSupportsNativeBuildToolsFeature("chatgpt", "gpt-5.4"),
  null
);
check(
  "OpenRouter catalog models with verified tools expose native Build tools",
  providerSupportsNativeBuildToolsFeature("openrouter", "qwen/qwen3.7-max"),
  null
);
check(
  "NVIDIA GLM NIM model exposes native Build tools",
  providerSupportsNativeBuildToolsFeature("nvidia", "z-ai/glm-5.2"),
  null
);
check(
  "NVIDIA MiniMax and Nemotron NIM models expose verified native Build tools",
  providerSupportsNativeBuildToolsFeature("nvidia", "minimaxai/minimax-m3") &&
    providerSupportsNativeBuildToolsFeature(
      "nvidia",
      "nvidia/nemotron-3-ultra-550b-a55b"
    ),
  null
);
check(
  "NVIDIA DeepSeek Pro exposes verified native Build tools",
  providerSupportsNativeBuildToolsFeature(
    "nvidia",
    "deepseek-ai/deepseek-v4-pro"
  ),
  null
);
check(
  "NVIDIA DeepSeek Flash fails closed for native Build tools until verified",
  !providerSupportsNativeBuildToolsFeature("nvidia", "deepseek-ai/deepseek-v4-flash"),
  null
);
check(
  "Unverified NVIDIA NIM models fail closed for native Build tools",
  !providerSupportsNativeBuildToolsFeature("nvidia", "unknown/model"),
  null
);
check(
  "Unverified OpenRouter catalog models fail closed for native Build tools",
  !providerSupportsNativeBuildToolsFeature("openrouter", "nex-agi/nex-n2-pro:free"),
  null
);
check(
  "Gemini models expose provider-hosted Build tools",
  providerSupportsHostedBuildToolsFeature("google", "gemini-3.5-flash"),
  null
);
check(
  "Non-Gemini models do not expose provider-hosted Build tools",
  !providerSupportsHostedBuildToolsFeature("openai", "gpt-5.5"),
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
