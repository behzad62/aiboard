import type { AIProvider, ChatParams } from "./base";
import { getCatalogModelsForProvider } from "./catalog";
import { streamOpenAICompatibleChat } from "./openai-compat";
import { createOpenAIClient, type ConnectionParams } from "./connection";

function createDeepSeekClient(
  connection: ConnectionParams,
  disableAutomaticRetries = false,
) {
  return createOpenAIClient(connection, "DeepSeek", { disableAutomaticRetries });
}

export const deepseekProvider: AIProvider = {
  id: "deepseek",
  name: "DeepSeek",

  listModels() {
    return getCatalogModelsForProvider("deepseek").map(
      ({ validationCandidate, ...model }) => model,
    );
  },

  async validateConnection(connection) {
    try {
      const client = createDeepSeekClient(connection);
      await client.models.list();
      return true;
    } catch {
      return false;
    }
  },

  async *streamChat(params: ChatParams) {
    const client = createDeepSeekClient(params, params.disableAutomaticRetries);
    yield* streamOpenAICompatibleChat(
      client,
      params,
      "deepseek",
      "DeepSeek",
      "max_tokens",
    );
  },
};
