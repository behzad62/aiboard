export const PROVIDER_IDS = [
  "openai",
  "anthropic",
  "foundry",
  "google",
  "openrouter",
  "chatgpt",
  "github-copilot",
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
  modelIdsField?: ProviderSetupField;
  accountRunner?: AccountRunnerProviderSetup;
  nativeWebSearch: boolean | ((modelId: string) => boolean);
  reasoningEffort: boolean | ((modelId: string) => boolean);
  runtimeBehavior: ModelRuntimeBehavior;
}

const ACCOUNT_RUNNER_DOWNLOAD_HREF = "/account-provider-runner.mjs";

export const PROVIDER_DEFINITIONS = {
  openai: {
    id: "openai",
    name: "OpenAI",
    modelSource: "catalog",
    nativeWebSearch: true,
    reasoningEffort: true,
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
    reasoningEffort: true,
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
    runtimeBehavior: {
      temperatureLabel: "Temperature is not sent",
      temperatureNote:
        "ChatGPT account mode sends prompts through the local account runner. Image attachments, text-readable documents, raw document files, Responses streaming, structured output, reasoning effort, and native Build tool calls are forwarded through the runner.",
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
} satisfies Record<ProviderId, ProviderDefinition>;

export function getProviderDefinition(
  providerId: string
): ProviderDefinition | undefined {
  return PROVIDER_DEFINITIONS[providerId as ProviderId];
}

export function providerUsesCatalogModels(providerId: string): boolean {
  return getProviderDefinition(providerId)?.modelSource === "catalog";
}

export function providerSupportsNativeWebSearchFeature(
  providerId: string,
  modelId = ""
): boolean {
  const support = getProviderDefinition(providerId)?.nativeWebSearch;
  return typeof support === "function" ? support(modelId) : support === true;
}

export function providerSupportsReasoningEffortFeature(
  providerId: string,
  modelId = ""
): boolean {
  const support = getProviderDefinition(providerId)?.reasoningEffort;
  return typeof support === "function" ? support(modelId) : support === true;
}
