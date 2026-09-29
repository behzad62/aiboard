import OpenAI from "openai";
import type { AIProvider, ChatParams, StreamChunk } from "./base";
import { getCatalogModelsForProvider } from "./catalog";
import { streamOpenAICompatibleChat } from "./openai-compat";

export const META_MODEL_API_BASE_URL = "https://api.meta.ai/v1";

function createMetaClient(apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: META_MODEL_API_BASE_URL,
    dangerouslyAllowBrowser: true,
  });
}

export const metaProvider: AIProvider = {
  id: "meta",
  name: "Meta Model API",

  listModels() {
    return getCatalogModelsForProvider("meta").map(
      ({ validationCandidate, ...model }) => model
    );
  },

  async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      const response = await fetch(`${META_MODEL_API_BASE_URL}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  },

  async *streamChat(params: ChatParams): AsyncIterable<StreamChunk> {
    yield* streamOpenAICompatibleChat(
      createMetaClient(params.apiKey),
      params,
      "meta",
      "Meta Model API",
      "max_completion_tokens"
    );
  },
};
