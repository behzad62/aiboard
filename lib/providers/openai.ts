import OpenAI from "openai";
import type { AIProvider, ChatParams } from "./base";
import { getCatalogModelsForProvider } from "./catalog";
import { streamOpenAICompatibleChat } from "./openai-compat";

export const openaiProvider: AIProvider = {
  id: "openai",
  name: "OpenAI",

  listModels() {
    return getCatalogModelsForProvider("openai").map(
      ({ validationCandidate, ...model }) => model
    );
  },

  async validateApiKey(apiKey: string) {
    try {
      const client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
      await client.models.list();
      return true;
    } catch {
      return false;
    }
  },

  async *streamChat(params: ChatParams) {
    const client = new OpenAI({
      apiKey: params.apiKey,
      dangerouslyAllowBrowser: true,
    });
    yield* streamOpenAICompatibleChat(client, params, "openai", "OpenAI");
  },
};
