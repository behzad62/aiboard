import OpenAI from "openai";
import type {
  AIProvider,
  ChatParams,
  NativeToolCall,
  StreamChunk,
} from "./base";
import { getCatalogModelsForProvider, MODEL_CATALOG } from "./catalog";
import {
  buildOpenAIResponsesInput,
  openAIResponsesNativeToolField,
} from "./openai";
import { xAIReasoningEffort } from "./reasoning";
import { openAIResponsesTextFormatField } from "./structured-output";

const XAI_BASE_URL = "https://api.x.ai/v1";

function createXAIClient(apiKey: string) {
  return new OpenAI({
    apiKey,
    baseURL: XAI_BASE_URL,
    dangerouslyAllowBrowser: true,
    timeout: 360_000,
  });
}

function xAIResponsesWebSearchField(enabled?: boolean): Record<string, unknown> {
  if (!enabled) return {};
  return {
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
  };
}

async function* streamXAIResponses(
  client: OpenAI,
  params: ChatParams
): AsyncIterable<StreamChunk> {
  const instructions = params.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const caps =
    params.capabilities ??
    MODEL_CATALOG.find((m) => m.providerId === "xai" && m.id === params.model)
      ?.capabilities ?? {
      image: false,
      document: false,
      audio: false,
      video: false,
    };
  const input = buildOpenAIResponsesInput(params, caps);

  const reasoningValue = xAIReasoningEffort(
    params.model,
    params.reasoningEffort ?? "default"
  );
  const structuredOutputField = openAIResponsesTextFormatField(
    params.structuredOutput
  );
  const webSearchField = xAIResponsesWebSearchField(
    params.webSearch && !params.structuredOutput
  );
  const nativeToolField = openAIResponsesNativeToolField(
    params.structuredOutput ? undefined : params.nativeTools
  );
  const combinedTools = [
    ...((webSearchField.tools as unknown[] | undefined) ?? []),
    ...((nativeToolField.tools as unknown[] | undefined) ?? []),
  ];
  const combinedToolField =
    combinedTools.length > 0
      ? {
          tools: combinedTools,
          tool_choice: "auto",
          ...(nativeToolField.parallel_tool_calls
            ? { parallel_tool_calls: nativeToolField.parallel_tool_calls }
            : {}),
        }
      : {};

  try {
    const pendingToolCalls = new Map<
      string,
      NativeToolCall & { argumentsJson: string }
    >();
    let reportedInputTokens: number | undefined;
    let reportedOutputTokens: number | undefined;
    let reportedTotalTokens: number | undefined;
    let reportedReasoningTokens: number | undefined;
    let reportedCachedInputTokens: number | undefined;
    const stream = await client.responses.create({
      model: params.model,
      ...(instructions ? { instructions } : {}),
      input: input as never,
      store: false,
      ...(params.maxTokens != null ? { max_output_tokens: params.maxTokens } : {}),
      ...(params.temperature != null ? { temperature: params.temperature } : {}),
      ...(reasoningValue
        ? {
            reasoning: {
              effort: reasoningValue,
            } as never,
          }
        : {}),
      ...(structuredOutputField as Record<string, never>),
      ...(combinedToolField as Record<string, never>),
      stream: true,
    });

    for await (const event of stream) {
      const rawEvent = event as unknown as {
        type?: string;
        delta?: string;
        item_id?: string;
        output_index?: number;
        item?: {
          id?: string;
          call_id?: string;
          type?: string;
          name?: string;
          arguments?: string;
        };
        name?: string;
        arguments?: string;
      };
      const responseUsage = (
        event as unknown as {
          response?: {
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              total_tokens?: number;
              input_tokens_details?: { cached_tokens?: number };
              output_tokens_details?: { reasoning_tokens?: number };
            } | null;
          };
        }
      ).response?.usage;
      if (responseUsage) {
        if (typeof responseUsage.input_tokens === "number") {
          reportedInputTokens = responseUsage.input_tokens;
        }
        if (typeof responseUsage.output_tokens === "number") {
          reportedOutputTokens = responseUsage.output_tokens;
        }
        if (typeof responseUsage.total_tokens === "number") {
          reportedTotalTokens = responseUsage.total_tokens;
        }
        if (typeof responseUsage.input_tokens_details?.cached_tokens === "number") {
          reportedCachedInputTokens =
            responseUsage.input_tokens_details.cached_tokens;
        }
        if (
          typeof responseUsage.output_tokens_details?.reasoning_tokens ===
          "number"
        ) {
          reportedReasoningTokens =
            responseUsage.output_tokens_details.reasoning_tokens;
        }
      }
      if (event.type === "response.output_text.delta" && event.delta) {
        yield { type: "token", content: event.delta };
      } else if (event.type === "response.failed") {
        yield {
          type: "error",
          error: event.response?.error?.message ?? "xAI responses request failed",
        };
        return;
      } else if (
        rawEvent.type === "response.output_item.added" ||
        rawEvent.type === "response.output_item.done"
      ) {
        const item = rawEvent.item;
        if (item?.type === "function_call") {
          const id =
            item.call_id ??
            item.id ??
            rawEvent.item_id ??
            String(rawEvent.output_index ?? pendingToolCalls.size);
          const current =
            pendingToolCalls.get(id) ??
            ({
              id,
              name: "",
              argumentsJson: "",
            } satisfies NativeToolCall & { argumentsJson: string });
          current.name = item.name ?? current.name;
          if (item.arguments != null) current.argumentsJson = item.arguments;
          pendingToolCalls.set(id, current);
        }
      } else if (
        rawEvent.type === "response.function_call_arguments.delta" &&
        rawEvent.delta != null
      ) {
        const id =
          rawEvent.item_id ?? String(rawEvent.output_index ?? pendingToolCalls.size);
        const current =
          pendingToolCalls.get(id) ??
          ({
            id,
            name: "",
            argumentsJson: "",
          } satisfies NativeToolCall & { argumentsJson: string });
        current.argumentsJson += rawEvent.delta;
        pendingToolCalls.set(id, current);
      } else if (
        rawEvent.type === "response.function_call_arguments.done" &&
        rawEvent.arguments != null
      ) {
        const id =
          rawEvent.item_id ?? String(rawEvent.output_index ?? pendingToolCalls.size);
        const current =
          pendingToolCalls.get(id) ??
          ({
            id,
            name: "",
            argumentsJson: "",
          } satisfies NativeToolCall & { argumentsJson: string });
        current.argumentsJson = rawEvent.arguments;
        pendingToolCalls.set(id, current);
      }
    }
    for (const toolCall of [...pendingToolCalls.values()].filter(
      (call) => call.name
    )) {
      yield { type: "tool_call", toolCall };
    }
    if (
      reportedInputTokens != null ||
      reportedOutputTokens != null ||
      reportedTotalTokens != null ||
      reportedReasoningTokens != null ||
      reportedCachedInputTokens != null
    ) {
      yield {
        type: "usage",
        usage: {
          inputTokens: reportedInputTokens,
          outputTokens: reportedOutputTokens,
          totalTokens: reportedTotalTokens,
          reasoningTokens: reportedReasoningTokens,
          cachedInputTokens: reportedCachedInputTokens,
        },
      };
    }
    yield { type: "done" };
  } catch (err) {
    yield {
      type: "error",
      error: err instanceof Error ? err.message : "xAI request failed",
    };
  }
}

export const xaiProvider: AIProvider = {
  id: "xai",
  name: "xAI",

  listModels() {
    return getCatalogModelsForProvider("xai").map(
      ({ validationCandidate, ...model }) => model
    );
  },

  async validateApiKey(apiKey: string) {
    try {
      const client = createXAIClient(apiKey);
      await client.models.list();
      return true;
    } catch {
      return false;
    }
  },

  async *streamChat(params: ChatParams) {
    const client = createXAIClient(params.apiKey);
    yield* streamXAIResponses(client, params);
  },
};
