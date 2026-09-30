import OpenAI from "openai";
import type { AIProvider, ChatParams } from "./base";
import { getCatalogModelsForProvider } from "./catalog";
import { streamOpenAICompatibleChat } from "./openai-compat";
import { streamOpenAIResponses } from "./openai";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function createOpenRouterClient(apiKey: string, disableAutomaticRetries = false) {
  return new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    dangerouslyAllowBrowser: true,
    ...(disableAutomaticRetries ? { maxRetries: 0 } : {}),
    defaultHeaders: {
      "HTTP-Referer": process.env.APP_URL ?? "http://localhost:3000",
      "X-Title": "AI Board",
    },
  });
}

const RESPONSES_COMPATIBILITY_STATUSES = new Set([400, 404, 405, 415, 422, 501]);

function isResponsesCompatibilityError(statusCode?: number): boolean {
  return statusCode != null && RESPONSES_COMPATIBILITY_STATUSES.has(statusCode);
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
    const client = createOpenRouterClient(
      params.apiKey,
      params.disableAutomaticRetries
    );
    const requiresChatMultimodal = (params.attachments ?? []).some(
      (attachment) =>
        !!attachment.base64Data &&
        ((attachment.category === "audio" && params.capabilities?.audio !== false) ||
          (attachment.category === "video" && params.capabilities?.video !== false))
    );
    if (requiresChatMultimodal) {
      yield* streamOpenAICompatibleChat(
        client,
        params,
        "openrouter",
        "OpenRouter",
        "max_tokens"
      );
      return;
    }
    let responseStarted = false;
    for await (const chunk of streamOpenAIResponses(client, params, "openrouter")) {
      if (
        chunk.type === "error" &&
        !responseStarted &&
        isResponsesCompatibilityError(chunk.errorMetadata?.statusCode)
      ) {
        yield* streamOpenAICompatibleChat(
          client,
          params,
          "openrouter",
          "OpenRouter",
          "max_tokens"
        );
        return;
      }
      if (chunk.type !== "error") responseStarted = true;
      yield chunk;
    }
  },
};
