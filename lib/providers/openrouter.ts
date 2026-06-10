import OpenAI from "openai";
import type { AIProvider, ChatParams } from "./base";
import { getCatalogModelsForProvider } from "./catalog";
import { streamOpenAICompatibleChat } from "./openai-compat";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function createOpenRouterClient(apiKey: string) {
  return new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    dangerouslyAllowBrowser: true,
    defaultHeaders: {
      "HTTP-Referer": process.env.APP_URL ?? "http://localhost:3000",
      "X-Title": "AI Discussion Board",
    },
  });
}

export const openrouterProvider: AIProvider = {
  id: "openrouter",
  name: "OpenRouter",

  listModels() {
    return getCatalogModelsForProvider("openrouter").map(
      ({ validationCandidate, ...model }) => model
    );
  },

  async validateApiKey(apiKey: string) {
    try {
      const res = await fetch(`${OPENROUTER_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  },

  async *streamChat(params: ChatParams) {
    const client = createOpenRouterClient(params.apiKey);
    yield* streamOpenAICompatibleChat(
      client,
      params,
      "openrouter",
      "OpenRouter"
    );
  },
};
