import OpenAI from "openai";
import type { AIProvider, ChatParams } from "./base";
import { getCatalogModelsForProvider } from "./catalog";
import { streamOpenAICompatibleChat } from "./openai-compat";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

function createDeepSeekClient(
  apiKey: string,
  disableAutomaticRetries = false,
) {
  return new OpenAI({
    apiKey,
    baseURL: DEEPSEEK_BASE_URL,
    dangerouslyAllowBrowser: true,
    ...(disableAutomaticRetries ? { maxRetries: 0 } : {}),
  });
}

export const deepseekProvider: AIProvider = {
  id: "deepseek",
  name: "DeepSeek",

  listModels() {
    return getCatalogModelsForProvider("deepseek").map(
      ({ validationCandidate, ...model }) => model,
    );
  },

  async validateApiKey(apiKey: string) {
    try {
      const client = createDeepSeekClient(apiKey);
      await client.models.list();
      return true;
    } catch {
      return false;
    }
  },

  async *streamChat(params: ChatParams) {
    const client = createDeepSeekClient(
      params.apiKey,
      params.disableAutomaticRetries,
    );
    yield* streamOpenAICompatibleChat(
      client,
      params,
      "deepseek",
      "DeepSeek",
      "max_tokens",
    );
  },
};
