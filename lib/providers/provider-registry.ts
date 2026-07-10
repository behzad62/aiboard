export const PROVIDER_IDS = [
  "openai",
  "anthropic",
  "foundry",
  "google",
  "openrouter",
  "xai",
  "chatgpt",
  "github-copilot",
  "nvidia",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderSetupField {
  label: string;
  placeholder: string;
  hint: string;
}

export interface AccountRunnerProviderSetup {
  path: string;
  loginLabel: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  tokenHint: string;
  command: string;
  downloadHref: string;
}

export interface ModelRuntimeBehavior {
  temperatureLabel: string;
  temperatureNote: string;
  promptCachingLabel: string;
  promptCachingNote: string;
  concurrencyNote?: string;
}

export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  modelSource: "catalog" | "user-defined";
  credentialLabel?: string;
  credentialPlaceholder?: string;
  savedCredentialPlaceholder?: string;
  missingCredentialMessage?: string;
  baseURLField?: ProviderSetupField;
  baseURLRequiredMessage?: string;
  runnerTokenField?: ProviderSetupField;
  runnerTokenRequiredMessage?: string;
  modelIdsField?: ProviderSetupField;
  accountRunner?: AccountRunnerProviderSetup;
  nativeWebSearch: boolean | ((modelId: string) => boolean);
  reasoningEffort: boolean | ((modelId: string) => boolean);
  maxTokens: boolean | ((modelId: string) => boolean);
  runtimeBehavior: ModelRuntimeBehavior;
}

type ModelToolFeature =
  | "nativeWebSearch"
  | "nativeBuildTools"
  | "hostedBuildTools";

type ModelToolRule = boolean | readonly string[] | ((modelId: string) => boolean);

const ACCOUNT_RUNNER_DOWNLOAD_HREF = "/account-provider-runner.mjs";

function normalizedModelId(modelId = ""): string {
  return modelId.trim().toLowerCase();
}

function gptFamilyVersion(modelId: string): { major: number; minor: number } | null {
  const match = /^gpt-(\d+)(?:\.(\d+))?/i.exec(modelId.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: match[2] ? Number(match[2]) : 0,
  };
}

function gptAtLeast(modelId: string, major: number, minor = 0): boolean {
  const version = gptFamilyVersion(modelId);
  if (!version) return false;
  return (
    version.major > major ||
    (version.major === major && version.minor >= minor)
  );
}

function isCodexLine(modelId: string): boolean {
  return /\bcodex\b/i.test(modelId);
}

function isClaudeLike(modelId: string): boolean {
  return /^claude-/i.test(modelId.trim());
}

function isXAINonReasoningModel(modelId: string): boolean {
  return normalizedModelId(modelId).includes("non-reasoning");
}

function isGrokLike(modelId: string): boolean {
  return /^grok-/i.test(modelId.trim());
}

function isGemini25OrNewer(modelId: string): boolean {
  const match = /^gemini-(\d+)(?:\.(\d+))?/i.exec(modelId.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = match[2] ? Number(match[2]) : 0;
  return major > 2 || (major === 2 && minor >= 5);
}

// Verified 2026-07-06 from OpenRouter's Models API `supported_parameters`.
// Models missing from that API are fail-closed until we can verify them.
const OPENROUTER_MODELS_WITH_FUNCTION_TOOLS = [
  "qwen/qwen3.7-max",
  "qwen/qwen3.7-plus",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "minimax/minimax-m3",
  "z-ai/glm-5.2",
  "moonshotai/kimi-k2.7-code",
] as const;

// NVIDIA model ids are user-defined in Settings, so fail closed for unknown ids
// instead of assuming every NIM chat endpoint accepts tools.
const NVIDIA_MODELS_WITH_FUNCTION_TOOLS = [
  "z-ai/glm-5.2",
  "minimaxai/minimax-m3",
  "deepseek-ai/deepseek-v4-pro",
  "nvidia/nemotron-3-ultra-550b-a55b",
] as const;

function listedModel(list: readonly string[]): (modelId: string) => boolean {
  const set = new Set(list.map(normalizedModelId));
  return (modelId: string) => set.has(normalizedModelId(modelId));
}

/**
 * Model-level tool support, intentionally separate from the provider transport
 * metadata below. Provider-wide support only means "the SDK path knows how to
 * send the tool"; these rules decide whether this specific model should receive
 * that tool at all.
 */
const MODEL_TOOL_SUPPORT: Partial<
  Record<ProviderId | "custom", Partial<Record<ModelToolFeature, ModelToolRule>>>
> = {
  openai: {
    // OpenAI docs show hosted web search on current GPT-5.4+ / GPT-5.6 models.
    // Codex 5.3 is kept off: the account-backed Spark sibling rejected
    // web_search_preview in the stopped build, and Codex-specific docs do not
    // advertise web search for that line.
    nativeWebSearch: (modelId) => gptAtLeast(modelId, 5, 4) && !isCodexLine(modelId),
    nativeBuildTools: (modelId) => gptAtLeast(modelId, 5, 1),
  },
  anthropic: {
    // Claude docs describe client tools broadly for current Claude models, and
    // the basic web_search_20250305 server tool remains the one this app sends.
    nativeWebSearch: isClaudeLike,
    nativeBuildTools: isClaudeLike,
  },
  foundry: {
    // Foundry model ids are user-defined Anthropic deployments. Client tools
    // work on current Claude deployments; hosted web search remains disabled
    // because Foundry availability varies by deployment/provider.
    nativeBuildTools: isClaudeLike,
    nativeWebSearch: false,
  },
  google: {
    nativeWebSearch: isGemini25OrNewer,
    nativeBuildTools: isGemini25OrNewer,
    hostedBuildTools: isGemini25OrNewer,
  },
  openrouter: {
    nativeWebSearch: listedModel(OPENROUTER_MODELS_WITH_FUNCTION_TOOLS),
    nativeBuildTools: listedModel(OPENROUTER_MODELS_WITH_FUNCTION_TOOLS),
  },
  xai: {
    // xAI docs list function calling and the web_search server tool on current Grok models.
    nativeWebSearch: isGrokLike,
    nativeBuildTools: isGrokLike,
  },
  chatgpt: {
    // The ChatGPT/Codex account backend accepts the current Responses hosted
    // web_search tool on GPT-5.4+ account models (including GPT-5.6 family);
    // Codex Spark remains off.
    nativeWebSearch: (modelId) => gptAtLeast(modelId, 5, 4) && !isCodexLine(modelId),
    nativeBuildTools: false,
    hostedBuildTools: false,
  },
  "github-copilot": {
    nativeWebSearch: false,
    nativeBuildTools: false,
    hostedBuildTools: false,
  },
  nvidia: {
    nativeWebSearch: false,
    nativeBuildTools: listedModel(NVIDIA_MODELS_WITH_FUNCTION_TOOLS),
    hostedBuildTools: false,
  },
  custom: {
    // User-defined OpenAI-compatible models keep the previous behavior; the
    // model owner controls whether their endpoint accepts function tools.
    nativeBuildTools: true,
    nativeWebSearch: false,
    hostedBuildTools: false,
  },
};

export const PROVIDER_DEFINITIONS = {
  openai: {
    id: "openai",
    name: "OpenAI",
    modelSource: "catalog",
    nativeWebSearch: true,
    reasoningEffort: true,
    maxTokens: true,
    runtimeBehavior: {
      temperatureLabel: "Temperature is not sent",
      temperatureNote:
        "This app omits temperature on the OpenAI chat-completions path because GPT-5.5 enforces stricter parameter support.",
      promptCachingLabel: "Prompt caching enabled",
      promptCachingNote:
        "The app requests OpenAI prompt caching with 24h retention and a cache key derived from the stable prompt prefix. Cache hits still require exact shared prefixes and typically begin once prompts reach 1024+ tokens.",
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    modelSource: "catalog",
    nativeWebSearch: true,
    reasoningEffort: (modelId: string) =>
      modelId !== "claude-haiku-4-5-20251001",
    maxTokens: true,
    runtimeBehavior: {
      temperatureLabel: "Temperature is not sent",
      temperatureNote:
        "This app omits temperature for Anthropic because newer Claude models reject the deprecated parameter.",
      promptCachingLabel: "Prompt caching enabled",
      promptCachingNote:
        "The stable Anthropic prompt prefix is marked as ephemeral cacheable content so repeated rounds can reuse it.",
    },
  },
  foundry: {
    id: "foundry",
    name: "Anthropic (Azure Foundry)",
    modelSource: "user-defined",
    baseURLField: {
      label: "Foundry endpoint (base URL)",
      placeholder: "https://<resource>.services.ai.azure.com/anthropic/",
      hint: "From your Azure AI Foundry resource - the Anthropic-compatible endpoint ending in /anthropic/.",
    },
    baseURLRequiredMessage: "This provider needs its endpoint base URL",
    modelIdsField: {
      label: "Model ids (one per line)",
      placeholder: "claude-opus-4-5",
      hint: "The Anthropic model ids your Foundry deployment exposes - enter exactly what your resource calls them.",
    },
    nativeWebSearch: false,
    reasoningEffort: true,
    maxTokens: true,
    runtimeBehavior: {
      temperatureLabel: "Temperature is not sent",
      temperatureNote:
        "Azure Foundry exposes the native Anthropic API; newer Claude models reject the deprecated temperature parameter.",
      promptCachingLabel: "Prompt caching enabled",
      promptCachingNote:
        "The stable prompt prefix is marked as ephemeral cacheable content, same as the native Anthropic provider; cache billing follows your Foundry deployment.",
    },
  },
  google: {
    id: "google",
    name: "Google Gemini",
    modelSource: "catalog",
    nativeWebSearch: true,
    reasoningEffort: true,
    maxTokens: true,
    runtimeBehavior: {
      temperatureLabel: "Temperature is sent",
      temperatureNote:
        "The app passes the effort-level temperature to Gemini generationConfig.",
      promptCachingLabel: "Implicit prompt caching enabled",
      promptCachingNote:
        "Gemini 2.5 and newer models cache repeated prefixes automatically. Cache hits still depend on matching large shared prefixes and model-specific minimum token thresholds.",
    },
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    modelSource: "catalog",
    nativeWebSearch: true,
    reasoningEffort: true,
    maxTokens: true,
    runtimeBehavior: {
      temperatureLabel: "Temperature is sent",
      temperatureNote:
        "The effort-level temperature is forwarded; OpenRouter silently drops it for models that don't support it (e.g. OpenAI reasoning models).",
      promptCachingLabel: "Prompt caching enabled",
      promptCachingNote:
        "OpenAI, DeepSeek, and Grok models cache automatically through OpenRouter. For Anthropic, Gemini, and Qwen models the app marks the stable prompt prefix as an ephemeral cache_control breakpoint.",
      concurrencyNote:
        "OpenRouter may queue concurrent requests server-side per account, so parallel Build tasks on OpenRouter models can appear to stream one at a time - especially on free models or with low account credit. This is account-side throttling, not an app limitation.",
    },
  },
  xai: {
    id: "xai",
    name: "xAI",
    modelSource: "catalog",
    nativeWebSearch: true,
    reasoningEffort: (modelId: string) => !isXAINonReasoningModel(modelId),
    maxTokens: true,
    runtimeBehavior: {
      temperatureLabel: "Temperature is sent",
      temperatureNote:
        "The effort-level temperature is forwarded to xAI's Responses API.",
      promptCachingLabel: "Prompt caching enabled",
      promptCachingNote:
        "xAI's Responses API automatically caches repeated prefixes; usage reports cached input tokens when a cache hit occurs.",
    },
  },
  chatgpt: {
    id: "chatgpt",
    name: "ChatGPT Plus/Pro",
    modelSource: "catalog",
    credentialLabel: "Runner session token",
    credentialPlaceholder: "Paste the current token printed by the account runner",
    savedCredentialPlaceholder: "Leave blank to keep existing runner token",
    missingCredentialMessage:
      "Save the runner URL and token before enabling this provider",
    baseURLField: {
      label: "Account runner URL",
      placeholder: "http://127.0.0.1:1455",
      hint: "Run account-provider-runner.mjs with Node, then paste its printed local URL here. ChatGPT OAuth uses port 1455, or 1457 if 1455 is busy.",
    },
    baseURLRequiredMessage: "This provider needs the account runner URL",
    accountRunner: {
      path: "chatgpt",
      loginLabel: "Log in with OpenAI",
      tokenLabel: "Runner session token",
      tokenPlaceholder: "Paste the current token printed by the account runner",
      tokenHint:
        "This is the local runner session token printed in the terminal. Restarting the runner prints a new token, but your saved ChatGPT login stays in the auth file.",
      command: "node account-provider-runner.mjs",
      downloadHref: ACCOUNT_RUNNER_DOWNLOAD_HREF,
    },
    nativeWebSearch: true,
    reasoningEffort: true,
    maxTokens: false,
    runtimeBehavior: {
      temperatureLabel: "Temperature is not sent",
      temperatureNote:
        "ChatGPT account mode sends prompts through the local account runner. Image attachments, text-readable documents, raw document files, Responses streaming, structured output, reasoning effort, function tool calls, and the current hosted web search tool are forwarded through the runner. Provider-hosted local shell tools are not sent because the ChatGPT Codex account backend rejects that hosted tool type. Max-token caps are intentionally omitted because that backend rejects max_output_tokens.",
      promptCachingLabel: "Account-provider dependent",
      promptCachingNote:
        "Caching and rate limits are controlled by the ChatGPT/Codex account backend, not by AI Board.",
      concurrencyNote:
        "This uses the user's ChatGPT account entitlement. Expect behavior and limits to differ from OpenAI API billing.",
    },
  },
  "github-copilot": {
    id: "github-copilot",
    name: "GitHub Copilot",
    modelSource: "catalog",
    credentialLabel: "Runner session token",
    credentialPlaceholder: "Paste the current token printed by the account runner",
    savedCredentialPlaceholder: "Leave blank to keep existing runner token",
    missingCredentialMessage:
      "Save the runner URL and token before enabling this provider",
    baseURLField: {
      label: "Account runner URL",
      placeholder: "http://127.0.0.1:1455",
      hint: "Run account-provider-runner.mjs with Node, then paste its printed local URL here.",
    },
    baseURLRequiredMessage: "This provider needs the account runner URL",
    accountRunner: {
      path: "github-copilot",
      loginLabel: "Log in with GitHub",
      tokenLabel: "Runner session token",
      tokenPlaceholder: "Paste the current token printed by the account runner",
      tokenHint:
        "This is the local runner session token printed in the terminal. Restarting the runner prints a new token, but your saved GitHub login stays in the auth file.",
      command: "node account-provider-runner.mjs",
      downloadHref: ACCOUNT_RUNNER_DOWNLOAD_HREF,
    },
    nativeWebSearch: false,
    reasoningEffort: (modelId: string) =>
      modelId === "auto" || /^gpt-\d+/i.test(modelId),
    maxTokens: true,
    runtimeBehavior: {
      temperatureLabel: "Route-dependent",
      temperatureNote:
        "GitHub Copilot account mode sends prompts through the local account runner. GPT-class Responses routes omit temperature; chat-completions routes forward temperature when accepted by Copilot.",
      promptCachingLabel: "Account-provider dependent",
      promptCachingNote:
        "Caching and rate limits are controlled by GitHub Copilot, not by AI Board.",
      concurrencyNote:
        "Copilot model access depends on the signed-in account and may be throttled or limited by GitHub account policy.",
    },
  },
  nvidia: {
    id: "nvidia",
    name: "NVIDIA NIM",
    modelSource: "user-defined",
    credentialLabel: "NVIDIA API key",
    credentialPlaceholder: "nvapi-...",
    savedCredentialPlaceholder: "Leave blank to keep existing NVIDIA API key",
    missingCredentialMessage:
      "Save the NVIDIA API key, local provider runner URL/token, and at least one model id before enabling this provider",
    baseURLField: {
      label: "Local provider runner URL",
      placeholder: "http://127.0.0.1:1455",
      hint: "Run account-provider-runner.mjs locally, then paste its printed URL here. NVIDIA requests are proxied through the runner because the browser cannot call the NVIDIA API directly.",
    },
    baseURLRequiredMessage: "This provider needs the local provider runner URL",
    runnerTokenField: {
      label: "Local runner token",
      placeholder: "Paste the current token printed by the account runner",
      hint: "This authorizes calls to your local runner only. It is separate from the NVIDIA API key.",
    },
    runnerTokenRequiredMessage: "This provider needs the local runner token",
    modelIdsField: {
      label: "NVIDIA model ids (one per line)",
      placeholder:
        "z-ai/glm-5.2\nminimaxai/minimax-m3\ndeepseek-ai/deepseek-v4-flash\ndeepseek-ai/deepseek-v4-pro\nnvidia/nemotron-3-ultra-550b-a55b",
      hint: "Enter OpenAI-compatible NVIDIA NIM model ids from build.nvidia.com/models. Mistral models are intentionally omitted from this preset.",
    },
    nativeWebSearch: false,
    reasoningEffort: false,
    maxTokens: true,
    runtimeBehavior: {
      temperatureLabel: "Temperature is sent",
      temperatureNote:
        "The effort-level temperature is forwarded through the local provider runner to NVIDIA's OpenAI-compatible chat-completions endpoint.",
      promptCachingLabel: "Provider-dependent",
      promptCachingNote:
        "Prompt caching, rate limits, and context behavior are controlled by NVIDIA NIM for the selected model.",
      concurrencyNote:
        "The app sends NVIDIA requests through the local provider runner to avoid browser CORS limits; NVIDIA account and endpoint limits still apply.",
    },
  },
} satisfies Record<ProviderId, ProviderDefinition>;

export function getProviderDefinition(
  providerId: string
): ProviderDefinition | undefined {
  return PROVIDER_DEFINITIONS[providerId as ProviderId];
}

export function providerUsesCatalogModels(providerId: string): boolean {
  return getProviderDefinition(providerId)?.modelSource === "catalog";
}

function evaluateModelToolRule(rule: ModelToolRule | undefined, modelId: string): boolean {
  if (typeof rule === "function") return rule(modelId);
  if (Array.isArray(rule)) {
    const model = normalizedModelId(modelId);
    return rule.some((candidate) => normalizedModelId(candidate) === model);
  }
  return rule === true;
}

function modelSupportsToolFeature(
  providerId: string,
  modelId: string,
  feature: ModelToolFeature
): boolean {
  const support =
    MODEL_TOOL_SUPPORT[providerId as ProviderId | "custom"]?.[feature];
  return evaluateModelToolRule(support, modelId);
}

export function providerSupportsNativeWebSearchFeature(
  providerId: string,
  modelId = ""
): boolean {
  return modelSupportsToolFeature(providerId, modelId, "nativeWebSearch");
}

export function providerSupportsReasoningEffortFeature(
  providerId: string,
  modelId = ""
): boolean {
  const support = getProviderDefinition(providerId)?.reasoningEffort;
  return typeof support === "function" ? support(modelId) : support === true;
}

export function providerSupportsMaxTokensFeature(
  providerId: string,
  modelId = ""
): boolean {
  const support = getProviderDefinition(providerId)?.maxTokens;
  return typeof support === "function" ? support(modelId) : support === true;
}

export function providerSupportsNativeBuildToolsFeature(
  providerId: string,
  modelId = ""
): boolean {
  return modelSupportsToolFeature(providerId, modelId, "nativeBuildTools");
}

export function providerSupportsHostedBuildToolsFeature(
  providerId: string,
  modelId = ""
): boolean {
  return modelSupportsToolFeature(providerId, modelId, "hostedBuildTools");
}
