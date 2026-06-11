import type { AIProvider, ChatParams, StreamChunk } from "./base";
import { getCatalogModelsForProvider } from "./catalog";
import { streamAnthropicChat } from "./anthropic";

/**
 * Anthropic models served from the user's Azure AI Foundry resource. Foundry
 * exposes the native Anthropic Messages API under
 * `https://<resource>.services.ai.azure.com/anthropic/`, so this provider is
 * the Anthropic implementation pointed at the user-configured base URL
 * (stored with the provider key; threaded in via ChatParams.baseURL).
 */
export const foundryProvider: AIProvider = {
  id: "foundry",
  name: "Anthropic (Azure Foundry)",

  listModels() {
    return getCatalogModelsForProvider("foundry").map(
      ({ validationCandidate, ...model }) => model
    );
  },

  // Key validation needs the per-user base URL, which this signature doesn't
  // carry — the Settings page validates via a real model test (streamChat)
  // instead, like every other provider.
  async validateApiKey() {
    return true;
  },

  async *streamChat(params: ChatParams): AsyncIterable<StreamChunk> {
    if (!params.baseURL) {
      yield {
        type: "error",
        error:
          "Azure Foundry needs a base URL (e.g. https://<resource>.services.ai.azure.com/anthropic/) — set it on the Settings page.",
      };
      return;
    }
    yield* streamAnthropicChat(params, "foundry", "Azure Foundry");
  },
};
