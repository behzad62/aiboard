
export const PROVIDER_IDS = [
  "openai",
  "deepseek",
  "anthropic",
  "foundry",
  "google",
  "openrouter",
  "xai",
  "meta",
  "chatgpt",
  "github-copilot",
  "nvidia",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderSetupField {
  label: string;
  placeholder: string;
  suggestedValue?: string;
  hint: string;
}

export interface AccountRunnerProviderSetup {
  path: string;
  loginLabel: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  tokenHint: string;
  /** What to run: `aiboard` starts the account runner with Runner V2 and pairs this tab. */
  command: string;
  downloadHref: string;
  setupHint: string;
  /** The standalone account-runner ZIP: how to start it, for users who run it on its own. */
  standaloneCommand: string;
  standaloneHint: string;
}

export interface ProviderRunnerDownload {
  command: string;
  downloadHref: string;
  hint: string;
  standaloneCommand: string;
  standaloneHint: string;
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
  modelDiscovery?: {
    source: "provider-api" | "public-api" | "runner";
  };
  accountRunner?: AccountRunnerProviderSetup;
  runnerDownload?: ProviderRunnerDownload;
  reasoningEffort: boolean | ((modelId: string) => boolean);
  maxTokens: boolean | ((modelId: string) => boolean);
  runtimeBehavior: ModelRuntimeBehavior;
}

export const ACCOUNT_RUNNER_VERSION = 29;
const ACCOUNT_RUNNER_DOWNLOAD_HREF = "/aiboard-account-provider-runner.zip";
const ACCOUNT_RUNNER_COMMAND = "aiboard";
const ACCOUNT_RUNNER_SETUP_HINT = "Run aiboard in a project folder (install it first with the one-line installer from the Runner guide). It starts the account runner together with Runner V2 and connects this tab, so there is no URL or token to paste. One account runner serves ChatGPT, GitHub Copilot, and NVIDIA.";
const ACCOUNT_RUNNER_STANDALONE_COMMAND = "npm install\nnpm start";
const ACCOUNT_RUNNER_STANDALONE_HINT = "Prefer to run it on its own? Download the standalone account runner ZIP, extract every file into its own folder, run npm install, then npm start, and paste the URL and session token it prints into each provider's settings.";
const ACCOUNT_RUNNER_URL_HINT = "Filled in for you when aiboard connects this tab. With the standalone account runner, paste the URL it prints (port 1455, or 1457 if busy); one runner serves ChatGPT, GitHub Copilot, and NVIDIA.";

function normalizedModelId(modelId = ""): string {
  return modelId.trim().toLowerCase();
}

function isXAINonReasoningModel(modelId: string): boolean {
  return normalizedModelId(modelId).includes("non-reasoning");
}

export const PROVIDER_DEFINITIONS = {
  openai: {
    id: "openai",
    name: "OpenAI",
    modelSource: "catalog",
    modelDiscovery: { source: "provider-api" },
    modelIdsField: {
      label: "Additional model ids (optional)",
      placeholder: "gpt-5.7",
      suggestedValue: "gpt-5.7",
      hint: "Browse the live provider catalog or add a model id manually when the built-in catalog has not caught up yet.",
    },
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
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    modelSource: "catalog",
    modelDiscovery: { source: "provider-api" },
    modelIdsField: {
      label: "Additional model ids (optional)",
      placeholder: "deepseek-v4",
      suggestedValue: "deepseek-v4",
      hint: "Browse the live DeepSeek model catalog or add a model id manually.",
    },
    reasoningEffort: true,
    maxTokens: true,
    runtimeBehavior: {
      temperatureLabel: "Temperature is sent",
      temperatureNote:
        "The effort-level temperature is forwarded to DeepSeek's OpenAI-compatible chat-completions API.",
      promptCachingLabel: "Provider-dependent",
      promptCachingNote:
        "Prompt caching, rate limits, and context behavior are controlled by DeepSeek for the selected model.",
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    modelSource: "catalog",
    modelDiscovery: { source: "provider-api" },
    modelIdsField: {
      label: "Additional model ids (optional)",
      placeholder: "claude-opus-5",
      suggestedValue: "claude-opus-5",
      hint: "Browse the live Anthropic model catalog or add a model id manually.",
    },
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
      suggestedValue: "claude-opus-4-5",
      hint: "The Anthropic model ids your Foundry deployment exposes - enter exactly what your resource calls them.",
    },
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
    modelDiscovery: { source: "provider-api" },
    modelIdsField: {
      label: "Additional model ids (optional)",
      placeholder: "gemini-3.8-flash",
      suggestedValue: "gemini-3.8-flash",
      hint: "Browse the live Gemini model catalog or add a model id manually.",
    },
    reasoningEffort: true,
    maxTokens: true,
    runtimeBehavior: {
      temperatureLabel: "Model-dependent",
      temperatureNote:
        "Gemini 3.6/3.8 Flash omit deprecated sampling parameters; older Gemini models receive the effort-level temperature in generationConfig.",
      promptCachingLabel: "Implicit prompt caching enabled",
      promptCachingNote:
        "Gemini 2.5 and newer models cache repeated prefixes automatically. Cache hits still depend on matching large shared prefixes and model-specific minimum token thresholds.",
    },
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    modelSource: "catalog",
    modelDiscovery: { source: "public-api" },
    modelIdsField: {
      label: "Additional model ids (optional)",
      placeholder: "qwen/qwen3-coder",
      suggestedValue: "qwen/qwen3-coder",
      hint: "Built-in OpenRouter models stay available automatically. Add any newer OpenRouter model ids here, one per line, when the catalog has not caught up yet.",
    },
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
    modelDiscovery: { source: "provider-api" },
    modelIdsField: {
      label: "Additional model ids (optional)",
      placeholder: "grok-4.7",
      suggestedValue: "grok-4.7",
      hint: "Browse the live xAI language-model catalog or add a model id manually.",
    },
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
  meta: {
    id: "meta",
    name: "Meta Model API",
    modelSource: "catalog",
    modelDiscovery: { source: "provider-api" },
    modelIdsField: {
      label: "Additional model ids (optional)",
      placeholder: "muse-spark-1.3",
      suggestedValue: "muse-spark-1.3",
      hint: "Browse Meta's live Model API catalog or add a model id manually.",
    },
    reasoningEffort: (modelId: string) => /^muse-spark-/i.test(modelId.trim()),
    maxTokens: true,
    runtimeBehavior: {
      temperatureLabel: "Temperature is sent",
      temperatureNote: "Temperature and supported reasoning effort are forwarded through Meta's OpenAI-compatible Model API.",
      promptCachingLabel: "Provider-dependent",
      promptCachingNote: "Caching and rate limits are controlled by Meta Model API.",
    },
  },
  chatgpt: {
    id: "chatgpt",
    name: "ChatGPT Plus/Pro",
    modelSource: "catalog",
    modelDiscovery: { source: "runner" },
    modelIdsField: {
      label: "Additional model ids (optional)",
      placeholder: "gpt-6.1-sol",
      suggestedValue: "gpt-6.1-sol",
      hint: "Browse the models listed for your signed-in ChatGPT account or add a model id manually. Adding an id does not grant access; OpenAI checks access when you use the model.",
    },
    credentialLabel: "Runner session token",
    credentialPlaceholder: "Paste the current token printed by the account runner",
    savedCredentialPlaceholder: "Leave blank to keep existing runner token",
    missingCredentialMessage:
      "Save the runner URL and token before enabling this provider",
    baseURLField: {
      label: "Account runner URL",
      placeholder: "http://127.0.0.1:1455",
      suggestedValue: "http://127.0.0.1:1455",
      hint: ACCOUNT_RUNNER_URL_HINT,
    },
    baseURLRequiredMessage: "This provider needs the account runner URL",
    accountRunner: {
      path: "chatgpt",
      loginLabel: "Continue with ChatGPT",
      tokenLabel: "Runner session token",
      tokenPlaceholder: "Paste the current token printed by the account runner",
      tokenHint:
        "Only for the standalone account runner: the session token it prints in the terminal (aiboard connects without one). Restarting the runner prints a new token, but your saved ChatGPT login stays in the auth file.",
      command: ACCOUNT_RUNNER_COMMAND,
      downloadHref: ACCOUNT_RUNNER_DOWNLOAD_HREF,
      setupHint:
        `${ACCOUNT_RUNNER_SETUP_HINT} Continue with ChatGPT to authorize plan usage. No OpenAI API key is needed.`,
      standaloneCommand: ACCOUNT_RUNNER_STANDALONE_COMMAND,
      standaloneHint: ACCOUNT_RUNNER_STANDALONE_HINT,
    },
    reasoningEffort: true,
    maxTokens: false,
    runtimeBehavior: {
      temperatureLabel: "Temperature is not sent",
      temperatureNote:
        "ChatGPT plan mode uses the public OpenAI Responses API through the local runner. It supports text, images and files when accepted by the selected model, structured output, reasoning effort, and client function tools. Web search depends on model and account policy. Hosted shell, image generation, file search, Code Interpreter, audio/video input, temperature, and max-token caps are not supported by this connection.",
      promptCachingLabel: "Account-provider dependent",
      promptCachingNote:
        "Caching and rate limits are controlled by OpenAI's ChatGPT plan usage service. Manage app usage and access in ChatGPT Settings → Usage.",
      concurrencyNote:
        "This uses the user's ChatGPT account entitlement. Expect behavior and limits to differ from OpenAI API billing.",
    },
  },
  "github-copilot": {
    id: "github-copilot",
    name: "GitHub Copilot",
    modelSource: "catalog",
    modelDiscovery: { source: "runner" },
    modelIdsField: {
      label: "Additional model ids (optional)",
      placeholder: "gemini-3.8-flash",
      suggestedValue: "gemini-3.8-flash",
      hint: "Browse the models available to the signed-in Copilot account or add a model id manually.",
    },
    credentialLabel: "Runner session token",
    credentialPlaceholder: "Paste the current token printed by the account runner",
    savedCredentialPlaceholder: "Leave blank to keep existing runner token",
    missingCredentialMessage:
      "Save the runner URL and token before enabling this provider",
    baseURLField: {
      label: "Account runner URL",
      placeholder: "http://127.0.0.1:1455",
      suggestedValue: "http://127.0.0.1:1455",
      hint: ACCOUNT_RUNNER_URL_HINT,
    },
    baseURLRequiredMessage: "This provider needs the account runner URL",
    accountRunner: {
      path: "github-copilot",
      loginLabel: "Log in with GitHub",
      tokenLabel: "Runner session token",
      tokenPlaceholder: "Paste the current token printed by the account runner",
      tokenHint:
        "Only for the standalone account runner: the session token it prints in the terminal (aiboard connects without one). Restarting the runner prints a new token, but your saved GitHub login stays in the auth file.",
      command: ACCOUNT_RUNNER_COMMAND,
      downloadHref: ACCOUNT_RUNNER_DOWNLOAD_HREF,
      setupHint:
        `${ACCOUNT_RUNNER_SETUP_HINT} Log in with GitHub if it is not already connected; the Copilot runtime downloads once on first use.`,
      standaloneCommand: ACCOUNT_RUNNER_STANDALONE_COMMAND,
      standaloneHint: ACCOUNT_RUNNER_STANDALONE_HINT,
    },
    reasoningEffort: (modelId: string) =>
      normalizedModelId(modelId) === "auto" ||
      /^gpt-\d+/i.test(modelId) ||
      normalizedModelId(modelId) === "gemini-3.5-flash",
    maxTokens: true,
    runtimeBehavior: {
      temperatureLabel: "Route-dependent",
      temperatureNote:
        "Discussion calls use the Copilot SDK; structured-output, attachment, and Build calls use the compatible raw account route. The SDK owns model defaults and does not expose a temperature control.",
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
    modelDiscovery: { source: "runner" },
    credentialLabel: "NVIDIA API key",
    credentialPlaceholder: "nvapi-...",
    savedCredentialPlaceholder: "Leave blank to keep existing NVIDIA API key",
    missingCredentialMessage:
      "Save the NVIDIA API key, local provider runner URL/token, and at least one model id before enabling this provider",
    baseURLField: {
      label: "Local provider runner URL",
      placeholder: "http://127.0.0.1:1455",
      suggestedValue: "http://127.0.0.1:1455",
      hint: `${ACCOUNT_RUNNER_URL_HINT} NVIDIA requests are proxied through the runner because browsers cannot call its API directly.`,
    },
    baseURLRequiredMessage: "This provider needs the local provider runner URL",
    runnerDownload: {
      command: ACCOUNT_RUNNER_COMMAND,
      downloadHref: ACCOUNT_RUNNER_DOWNLOAD_HREF,
      hint:
        ACCOUNT_RUNNER_SETUP_HINT,
      standaloneCommand: ACCOUNT_RUNNER_STANDALONE_COMMAND,
      standaloneHint: ACCOUNT_RUNNER_STANDALONE_HINT,
    },
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
      suggestedValue:
        "z-ai/glm-5.2\nminimaxai/minimax-m3\ndeepseek-ai/deepseek-v4-flash\ndeepseek-ai/deepseek-v4-pro\nnvidia/nemotron-3-ultra-550b-a55b",
      hint: "Enter OpenAI-compatible NVIDIA NIM model ids from build.nvidia.com/models. Mistral models are intentionally omitted from this preset.",
    },
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
