import OpenAI from "openai";
import type { AIProvider, ChatParams, StreamChunk } from "./base";
import { getCatalogModelsForProvider, MODEL_CATALOG } from "./catalog";
import { streamOpenAICompatibleChat } from "./openai-compat";
import { openAIReasoningEffort } from "./reasoning";

/** Codex models reject v1/chat/completions and must use v1/responses. */
function usesResponsesApi(model: string): boolean {
  return (
    MODEL_CATALOG.find((m) => m.providerId === "openai" && m.id === model)
      ?.api === "responses"
  );
}

/**
 * Stream via the Responses API. Attachments aren't mapped here — the only
 * models on this path are text-only Codex models, and the engine filters
 * attachments by capability before the provider is called.
 */
async function* streamOpenAIResponses(
  client: OpenAI,
  params: ChatParams
): AsyncIterable<StreamChunk> {
  const instructions = params.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const input = params.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const reasoningValue = openAIReasoningEffort(params.reasoningEffort ?? "default");

  try {
    const stream = await client.responses.create({
      model: params.model,
      ...(instructions ? { instructions } : {}),
      input,
      ...(params.maxTokens != null ? { max_output_tokens: params.maxTokens } : {}),
      ...(reasoningValue
        ? { reasoning: { effort: reasoningValue as "low" | "medium" | "high" } }
        : {}),
      stream: true,
    });

    for await (const event of stream) {
      if (event.type === "response.output_text.delta" && event.delta) {
        yield { type: "token", content: event.delta };
      } else if (event.type === "response.failed") {
        yield {
          type: "error",
          error:
            event.response?.error?.message ?? "OpenAI responses request failed",
        };
        return;
      }
    }
    yield { type: "done" };
  } catch (err) {
    yield {
      type: "error",
      error: err instanceof Error ? err.message : "OpenAI request failed",
    };
  }
}

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
    if (usesResponsesApi(params.model)) {
      yield* streamOpenAIResponses(client, params);
      return;
    }
    yield* streamOpenAICompatibleChat(client, params, "openai", "OpenAI");
  },
};
