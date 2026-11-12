import type { AIProvider, ChatParams, StreamChunk } from "./base";
import { getCatalogModelsForProvider } from "./catalog";
import { streamAnthropicChat } from "./anthropic";

/**
 * Anthropic models served from the user's Azure AI Foundry resource. Foundry
 * exposes the native Anthropic Messages API under
 * `https://<resource>.services.ai.azure.com/anthropic/`, so this provider is
 * the Anthropic implementation behind the model proxy, which sends each call
 * to the endpoint saved in the AIBoard home (HM4a).
 */
export const foundryProvider: AIProvider = {
  id: "foundry",
  name: "Anthropic (Azure Foundry)",

  listModels() {
    return getCatalogModelsForProvider("foundry").map(
      ({ validationCandidate, ...model }) => model
    );
  },

  // The Settings page validates Foundry with a real model test (streamChat),
  // like every other provider; the home holds the deployment's endpoint.
  async validateConnection() {
    return true;
  },

  async *streamChat(params: ChatParams): AsyncIterable<StreamChunk> {
    // The model proxy sends Foundry calls to the endpoint saved in the AIBoard
    // home, and answers 422 `base_url_required` when there is none.
    yield* streamAnthropicChat(params, "foundry", "Azure Foundry");
  },
};
