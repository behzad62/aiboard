import type { AIProvider, ChatParams } from "./base";
import { getCatalogModelsForProvider } from "./catalog";
import { streamOpenAICompatibleChat } from "./openai-compat";
import { streamOpenAIResponses } from "./openai";
import { createOpenAIClient, providerFetch, type ConnectionParams } from "./connection";

/** OpenRouter's attribution headers; the model proxy forwards exactly these two. */
export const OPENROUTER_ATTRIBUTION_HEADERS: Readonly<Record<string, string>> = {
  "HTTP-Referer": process.env.APP_URL ?? "http://localhost:3000",
  "X-Title": "AI Board",
};

function createOpenRouterClient(connection: ConnectionParams, disableAutomaticRetries = false) {
  return createOpenAIClient(connection, "OpenRouter", {
    disableAutomaticRetries,
    defaultHeaders: { ...OPENROUTER_ATTRIBUTION_HEADERS },
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

  async validateConnection(connection) {
    try {
      const res = await providerFetch(connection, "OpenRouter", "models");
      return res.ok;
    } catch {
      return false;
    }
  },

  async *streamChat(params: ChatParams) {
    const client = createOpenRouterClient(params, params.disableAutomaticRetries);
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
