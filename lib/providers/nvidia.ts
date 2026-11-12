import type { AIProvider, ChatParams } from "./base";
import { createOpenAIClient, type ConnectionParams } from "./connection";
import { streamOpenAICompatibleChat } from "./openai-compat";

/**
 * NVIDIA NIM as an OpenAI-compatible provider behind the model proxy (OD-32,
 * HM4a). The proxy adds the NVIDIA key from the AIBoard home, so the browser
 * holds no key and the account peer is no longer involved.
 */
function createNvidiaClient(connection: ConnectionParams, disableAutomaticRetries = false) {
  return createOpenAIClient(connection, "NVIDIA NIM", { disableAutomaticRetries });
}

export const nvidiaProvider: AIProvider = {
  id: "nvidia",
  name: "NVIDIA NIM",

  listModels() {
    return [];
  },

  async validateConnection(connection) {
    try {
      await createNvidiaClient(connection).models.list();
      return true;
    } catch {
      return false;
    }
  },

  async *streamChat(params: ChatParams) {
    const client = createNvidiaClient(params, params.disableAutomaticRetries);
    yield* streamOpenAICompatibleChat(client, params, "nvidia", "NVIDIA NIM", "max_tokens");
  },
};
