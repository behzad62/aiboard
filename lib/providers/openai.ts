import OpenAI from "openai";
import type {
  AIProvider,
  ChatParams,
  ModelCapabilities,
  NativeToolCall,
  NativeToolDefinition,
  StreamChunk,
} from "./base";
import { getCatalogModelsForProvider, MODEL_CATALOG } from "./catalog";
import { streamOpenAICompatibleChat } from "./openai-compat";
import { openAIReasoningEffort } from "./reasoning";
import { openAIResponsesTextFormatField } from "./structured-output";
import { buildAttachmentPromptSection } from "../attachments/prompt-text";

type OpenAIResponseInputMessage = {
  role: "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "input_text"; text: string }
        | { type: "input_image"; image_url: string }
        | { type: "input_file"; filename: string; file_data: string }
      >;
};

/** Codex models reject v1/chat/completions and must use v1/responses. */
function usesResponsesApi(model: string): boolean {
  return (
    MODEL_CATALOG.find((m) => m.providerId === "openai" && m.id === model)
      ?.api === "responses"
  );
}

export function buildOpenAIResponsesInput(
  params: ChatParams,
  caps: ModelCapabilities
): OpenAIResponseInputMessage[] {
  const messages = params.messages.filter((m) => m.role !== "system");
  const lastUserIndex = messages
    .map((m, i) => (m.role === "user" ? i : -1))
    .filter((i) => i >= 0)
    .at(-1);

  return messages.map((m, index) => {
    const role = m.role as "user" | "assistant";
    if (role !== "user" || index !== lastUserIndex || !params.attachments?.length) {
      return { role, content: m.content };
    }

    const text = m.content + buildAttachmentPromptSection(params.attachments);
    const content: OpenAIResponseInputMessage["content"] = [
      ...params.attachments
        .filter(
          (file) =>
            file.category === "document" && caps.document && !!file.base64Data
        )
        .map((file) => ({
          type: "input_file" as const,
          filename: file.filename,
          file_data: `data:${file.mimeType};base64,${file.base64Data}`,
        })),
      ...(text ? [{ type: "input_text" as const, text }] : []),
      ...params.attachments
        .filter(
          (file) => file.category === "image" && caps.image && !!file.base64Data
        )
        .map((file) => ({
          type: "input_image" as const,
          image_url: `data:${file.mimeType};base64,${file.base64Data}`,
        })),
    ];

    return {
      role,
      content:
        content.length === 1 && content[0].type === "input_text" ? text : content,
    };
  });
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
  const caps =
    params.capabilities ??
    MODEL_CATALOG.find((m) => m.providerId === "openai" && m.id === params.model)
      ?.capabilities ?? {
      image: false,
      document: false,
      audio: false,
      video: false,
    };
  const input = buildOpenAIResponsesInput(params, caps);

  const reasoningValue = openAIReasoningEffort(
    params.reasoningEffort ?? "default",
    params.model
  );
  const structuredOutputField = openAIResponsesTextFormatField(
    params.structuredOutput
  );
  const webSearchField = openAIResponsesWebSearchField(
    params.webSearch && !params.structuredOutput
  );
  const nativeToolField = openAIResponsesNativeToolField(
    params.structuredOutput ? undefined : params.nativeTools
  );
  const hostedBuildToolsField = openAIResponsesHostedBuildToolsField(
    params.hostedBuildTools && !params.structuredOutput
  );
  const combinedTools = [
    ...((webSearchField.tools as unknown[] | undefined) ?? []),
    ...((nativeToolField.tools as unknown[] | undefined) ?? []),
    ...((hostedBuildToolsField.tools as unknown[] | undefined) ?? []),
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
      ...(params.maxTokens != null ? { max_output_tokens: params.maxTokens } : {}),
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
          action?: {
            type?: string;
            command?: unknown;
          };
        };
        name?: string;
        arguments?: string;
      };
      // Responses reports usage on the terminal response.completed event.
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
          error:
            event.response?.error?.message ?? "OpenAI responses request failed",
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
      error: err instanceof Error ? err.message : "OpenAI request failed",
    };
  }
}

export function openAIResponsesWebSearchField(
  enabled?: boolean
): Record<string, unknown> {
  if (!enabled) return {};
  return {
    tools: [{ type: "web_search_preview" }],
    tool_choice: "auto",
  };
}

export function openAIResponsesNativeToolField(
  tools: NativeToolDefinition[] | undefined
): Record<string, unknown> {
  if (!tools?.length) return {};
  return {
    tools: tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict ?? false,
    })),
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
}

export function openAIResponsesHostedBuildToolsField(
  enabled?: boolean
): Record<string, unknown> {
  void enabled;
  return {};
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
