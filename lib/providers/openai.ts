import OpenAI from "openai";
import type {
  AIProvider,
  ChatParams,
  NativeToolCall,
  NativeToolDefinition,
  StreamChunk,
} from "./base";
import { getCatalogModelsForProvider, MODEL_CATALOG } from "./catalog";
import { streamOpenAICompatibleChat } from "./openai-compat";
import { openAIReasoningEffort } from "./reasoning";
import { openAIResponsesTextFormatField } from "./structured-output";

function shellCommandPartsToString(parts: unknown): string {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => String(part))
    .map((part) =>
      /^[A-Za-z0-9_./:=@+-]+$/.test(part)
        ? part
        : JSON.stringify(part)
    )
    .join(" ");
}

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
    const stream = await client.responses.create({
      model: params.model,
      ...(instructions ? { instructions } : {}),
      input,
      ...(params.maxTokens != null ? { max_output_tokens: params.maxTokens } : {}),
      ...(reasoningValue
        ? { reasoning: { effort: reasoningValue as "low" | "medium" | "high" } }
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
        } else if (
          params.hostedBuildTools &&
          item?.type === "local_shell_call" &&
          item.action?.type === "exec"
        ) {
          const command = shellCommandPartsToString(item.action.command);
          if (command) {
            const id =
              item.call_id ??
              item.id ??
              rawEvent.item_id ??
              String(rawEvent.output_index ?? pendingToolCalls.size);
            pendingToolCalls.set(id, {
              id,
              name: "run",
              arguments: {
                command,
                reason: "OpenAI local_shell native tool call",
              },
              argumentsJson: JSON.stringify({
                command,
                reason: "OpenAI local_shell native tool call",
              }),
            });
          }
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
  if (!enabled) return {};
  return {
    tools: [{ type: "local_shell" }],
  };
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
