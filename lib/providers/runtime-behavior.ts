import { parseModelId } from "./base";

export interface ModelRuntimeBehavior {
  temperatureLabel: string;
  temperatureNote: string;
  promptCachingLabel: string;
  promptCachingNote: string;
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
    case "openai":
      return {
        temperatureLabel: "Temperature is not sent",
        temperatureNote:
          "This app omits temperature on the OpenAI chat-completions path because GPT-5.5 enforces stricter parameter support.",
        promptCachingLabel: "Prompt caching enabled",
        promptCachingNote:
          "The app requests OpenAI prompt caching with 24h retention and a cache key derived from the stable prompt prefix. Cache hits still require exact shared prefixes and typically begin once prompts reach 1024+ tokens.",
      };
    case "openrouter":
      return {
        temperatureLabel: "Temperature is not sent",
        temperatureNote:
          "OpenRouter uses the same OpenAI-compatible request path in this app, without an explicit temperature field.",
        promptCachingLabel: "Prompt caching not enabled",
        promptCachingNote:
          "This app does not currently send provider-specific cache controls through OpenRouter.",
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
