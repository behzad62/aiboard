import { parseModelId } from "./base";

export interface ModelRuntimeBehavior {
  temperatureLabel: string;
  temperatureNote: string;
  promptCachingLabel: string;
  promptCachingNote: string;
  /** Provider-side request throttling worth knowing about (optional). */
  concurrencyNote?: string;
}

export function getModelRuntimeBehavior(fullModelId: string): ModelRuntimeBehavior {
  const { providerId } = parseModelId(fullModelId);

  switch (providerId) {
    case "google":
      return {
        temperatureLabel: "Temperature is sent",
        temperatureNote:
          "The app passes the effort-level temperature to Gemini generationConfig.",
        promptCachingLabel: "Implicit prompt caching enabled",
        promptCachingNote:
          "Gemini 2.5 and newer models cache repeated prefixes automatically. Cache hits still depend on matching large shared prefixes and model-specific minimum token thresholds.",
      };
    case "anthropic":
      return {
        temperatureLabel: "Temperature is not sent",
        temperatureNote:
          "This app omits temperature for Anthropic because newer Claude models reject the deprecated parameter.",
        promptCachingLabel: "Prompt caching enabled",
        promptCachingNote:
          "The stable Anthropic prompt prefix is marked as ephemeral cacheable content so repeated rounds can reuse it.",
      };
    case "foundry":
      return {
        temperatureLabel: "Temperature is not sent",
        temperatureNote:
          "Azure Foundry exposes the native Anthropic API; newer Claude models reject the deprecated temperature parameter.",
        promptCachingLabel: "Prompt caching enabled",
        promptCachingNote:
          "The stable prompt prefix is marked as ephemeral cacheable content, same as the native Anthropic provider; cache billing follows your Foundry deployment.",
      };
    case "openai":
      return {
        temperatureLabel: "Temperature is not sent",
        temperatureNote:
          "This app omits temperature on the OpenAI chat-completions path because GPT-5.5 enforces stricter parameter support.",
        promptCachingLabel: "Prompt caching enabled",
        promptCachingNote:
          "The app requests OpenAI prompt caching with 24h retention and a cache key derived from the stable prompt prefix. Cache hits still require exact shared prefixes and typically begin once prompts reach 1024+ tokens.",
      };
    case "chatgpt":
      return {
        temperatureLabel: "Temperature is bridge-dependent",
        temperatureNote:
          "ChatGPT account mode routes through the local account-provider runner. The first release forwards model prompts but keeps parameter support conservative.",
        promptCachingLabel: "Account-provider dependent",
        promptCachingNote:
          "Caching and rate limits are controlled by the ChatGPT/Codex account backend, not by AI Board.",
        concurrencyNote:
          "This uses the user's ChatGPT account entitlement. Respect account-side limits and expect behavior to differ from OpenAI API billing.",
      };
    case "github-copilot":
      return {
        temperatureLabel: "Temperature is bridge-dependent",
        temperatureNote:
          "GitHub Copilot account mode routes through the local account-provider runner and forwards temperature only where the bridge can do so safely.",
        promptCachingLabel: "Account-provider dependent",
        promptCachingNote:
          "Caching and rate limits are controlled by GitHub Copilot, not by AI Board.",
        concurrencyNote:
          "Copilot model access depends on the signed-in account and may be throttled or limited by GitHub account policy.",
      };
    case "openrouter":
      return {
        temperatureLabel: "Temperature is sent",
        temperatureNote:
          "The effort-level temperature is forwarded; OpenRouter silently drops it for models that don't support it (e.g. OpenAI reasoning models).",
        promptCachingLabel: "Prompt caching enabled",
        promptCachingNote:
          "OpenAI, DeepSeek, and Grok models cache automatically through OpenRouter. For Anthropic, Gemini, and Qwen models the app marks the stable prompt prefix as an ephemeral cache_control breakpoint.",
        concurrencyNote:
          "OpenRouter may queue concurrent requests server-side per account, so parallel Build tasks on OpenRouter models can appear to stream one at a time — especially on free models or with low account credit. This is account-side throttling, not an app limitation.",
      };
    case "custom":
      return {
        temperatureLabel: "Temperature is sent",
        temperatureNote:
          "Local OpenAI-compatible servers (Ollama, LM Studio) honor the effort-level temperature.",
        promptCachingLabel: "Prompt caching server-dependent",
        promptCachingNote:
          "No cache controls are sent; servers like Ollama reuse their KV cache for repeated prompt prefixes automatically when they can.",
      };
    default:
      return {
        temperatureLabel: "Temperature handling unknown",
        temperatureNote:
          "This provider does not have explicit runtime-behavior metadata yet.",
        promptCachingLabel: "Prompt caching unknown",
        promptCachingNote:
          "This provider does not have explicit runtime-behavior metadata yet.",
      };
  }
}
