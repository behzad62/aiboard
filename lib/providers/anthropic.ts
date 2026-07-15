import Anthropic from "@anthropic-ai/sdk";
import type { AttachmentPayload } from "../attachments/types";
import { buildAttachmentPromptSection } from "../attachments/prompt-text";
import type {
  AIProvider,
  ChatParams,
  NativeToolCall,
  NativeToolDefinition,
  StreamChunk,
} from "./base";
import { getModelCapabilities } from "./capabilities";
import { formatModelId } from "./base";
import { anthropicReasoningFields } from "./reasoning";
import { getCatalogModelsForProvider, getValidationModelId } from "./catalog";
import { anthropicStructuredToolConfig } from "./structured-output";

type AnthropicImageMedia =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

type AnthropicCacheControl = { type: "ephemeral" };

type AnthropicContentBlock =
  | { type: "text"; text: string; cache_control?: AnthropicCacheControl }
  | {
      type: "image";
      source: { type: "base64"; media_type: AnthropicImageMedia; data: string };
    }
  | {
      type: "document";
      source: { type: "base64"; media_type: "application/pdf"; data: string };
    };

function toAnthropicImageMedia(mimeType: string): AnthropicImageMedia {
  if (
    mimeType === "image/jpeg" ||
    mimeType === "image/png" ||
    mimeType === "image/gif" ||
    mimeType === "image/webp"
  ) {
    return mimeType;
  }
  return "image/png";
}

function buildAnthropicUserContent(
  text: string,
  attachments: AttachmentPayload[] | undefined,
  caps: ReturnType<typeof getModelCapabilities>,
  cache = true
): string | AnthropicContentBlock[] {
  if (!attachments?.length) {
    return buildCacheableAnthropicTextBlocks(text, cache);
  }

  const blocks: AnthropicContentBlock[] = [];

  for (const file of attachments) {
    if (file.category === "image" && caps.image && file.base64Data) {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: toAnthropicImageMedia(file.mimeType),
          data: file.base64Data,
        },
      });
    } else if (
      file.category === "document" &&
      caps.document &&
      file.mimeType === "application/pdf" &&
      file.base64Data
    ) {
      blocks.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: file.base64Data,
        },
      });
    }
  }

  blocks.push(
    ...buildCacheableAnthropicTextBlocks(
      text + buildAttachmentPromptSection(attachments),
      cache
    )
  );
  return blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks;
}

function buildCacheableAnthropicTextBlocks(
  text: string,
  cache = true
): AnthropicContentBlock[] {
  const transcriptMarker = "\n\n--- Discussion so far ---\n\n";
  const ephemeral = cache
    ? { cache_control: { type: "ephemeral" as const } }
    : {};
  if (!text.includes(transcriptMarker)) {
    return [{ type: "text", text, ...ephemeral }];
  }

  const [prefix, ...rest] = text.split(transcriptMarker);
  const transcript = rest.join(transcriptMarker);

  return [
    { type: "text", text: `${prefix}${transcriptMarker}`, ...ephemeral },
    { type: "text", text: transcript },
  ];
}

/**
 * Anthropic allows at most 4 `cache_control` breakpoints per request. With the
 * Build engine's multi-turn tool conversations a one-breakpoint-per-message
 * scheme blows that cap (it hit "Found 5" once a review loop ran a few turns).
 * Mark only the FIRST user message (the large, stable instruction prefix — a
 * cache hit on every turn of a loop) and the LAST message (incremental caching
 * as the conversation grows). Returns indices into the non-system message list.
 */
export function anthropicCacheBreakpointIndices(
  roles: Array<"user" | "assistant">
): Set<number> {
  const indices = new Set<number>();
  if (roles.length === 0) return indices;
  const firstUser = roles.findIndex((r) => r === "user");
  if (firstUser >= 0) indices.add(firstUser);
  indices.add(roles.length - 1); // last message (always sent as a user turn)
  return indices;
}

export function anthropicWebSearchField(
  enabled?: boolean
): Record<string, unknown> {
  if (!enabled) return {};
  return {
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    tool_choice: { type: "auto" },
  };
}

export function anthropicNativeToolField(
  tools: NativeToolDefinition[] | undefined
): Record<string, unknown> {
  if (!tools?.length) return {};
  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
    tool_choice: { type: "auto" },
  };
}

function isAnthropicThinkingEnabled(field: Record<string, unknown>): boolean {
  const thinking = field.thinking as { type?: string } | undefined;
  return thinking?.type === "enabled" || thinking?.type === "adaptive";
}

function isAnthropicManualThinkingEnabled(
  field: Record<string, unknown>
): boolean {
  const thinking = field.thinking as { type?: string } | undefined;
  return thinking?.type === "enabled";
}

/**
 * Shared Anthropic-API streaming — used by the native Anthropic provider and
 * by gateways exposing the same API (Azure AI Foundry via params.baseURL).
 * `providerId` namespaces the capability lookup and error labels.
 */
export async function* streamAnthropicChat(
  params: ChatParams,
  providerId: string,
  errorLabel: string
): AsyncIterable<StreamChunk> {
  {
    const client = new Anthropic({
      apiKey: params.apiKey,
      ...(params.baseURL ? { baseURL: params.baseURL } : {}),
      dangerouslyAllowBrowser: true,
    });
    // Gateway providers (Foundry) pass capabilities explicitly — their model
    // ids aren't in the static catalog registry.
    const caps =
      params.capabilities ??
      getModelCapabilities(formatModelId(providerId, params.model));
    const systemMessage = params.messages.find((m) => m.role === "system");
    const userMessages = params.messages.filter((m) => m.role !== "system");
    const lastUserIndex = userMessages
      .map((m, i) => (m.role === "user" ? i : -1))
      .filter((i) => i >= 0)
      .at(-1);
    // Bound cache_control to ≤4 breakpoints (Anthropic's hard cap) so a long
    // multi-turn tool conversation no longer 400s with "Found 5".
    const cacheIndices = anthropicCacheBreakpointIndices(
      userMessages.map((m) => m.role as "user" | "assistant")
    );

    const chatMessages = userMessages.map((m, index) => {
      const cache = cacheIndices.has(index);
      const content =
        m.role === "user" && index === lastUserIndex
          ? buildAnthropicUserContent(m.content, params.attachments, caps, cache)
          : buildCacheableAnthropicTextBlocks(m.content, cache);

      return {
        role: m.role as "user" | "assistant",
        content,
      };
    });

    // Adaptive thinking + output_config.effort are newer than the pinned SDK's
    // types; the cast lets them pass through. Omitted by default/off and
    // skipped for unsupported models.
    const maxTokens = params.maxTokens ?? 1500;
    const reasoningField = anthropicReasoningFields(
      params.model,
      params.reasoningEffort ?? "default",
      maxTokens
    );
    const thinkingEnabled = isAnthropicThinkingEnabled(reasoningField);
    const structuredToolConfig = anthropicStructuredToolConfig(
      params.structuredOutput
    );
    const webSearchField = anthropicWebSearchField(
      providerId === "anthropic" && params.webSearch && !params.structuredOutput
    );
    const nativeToolField = anthropicNativeToolField(
      params.structuredOutput ? undefined : params.nativeTools
    );
    const combinedTools = params.structuredOutput
      ? ((structuredToolConfig.tools as unknown[] | undefined) ?? [])
      : [
          ...((webSearchField.tools as unknown[] | undefined) ?? []),
          ...((nativeToolField.tools as unknown[] | undefined) ?? []),
        ];
    const combinedToolChoice = params.structuredOutput
      ? thinkingEnabled && combinedTools.length > 0
        ? { type: "auto" }
        : structuredToolConfig.tool_choice
      : nativeToolField.tool_choice ?? webSearchField.tool_choice;
    const combinedToolField =
      combinedTools.length > 0
        ? {
            tools: combinedTools,
            ...(combinedToolChoice ? { tool_choice: combinedToolChoice } : {}),
          }
        : {};
    const requestOptions =
      isAnthropicManualThinkingEnabled(reasoningField) && combinedTools.length > 0
        ? {
            headers: {
              "anthropic-beta": "interleaved-thinking-2025-05-14",
            },
          }
        : undefined;

    try {
      const pendingToolCalls = new Map<
        number,
        NativeToolCall & { argumentsJson: string }
      >();
      const stream = await client.messages.stream(
        {
          model: params.model,
          max_tokens: maxTokens,
          system: systemMessage?.content,
          messages: chatMessages,
          ...(reasoningField as Record<string, never>),
          ...(combinedToolField as Record<string, never>),
        },
        requestOptions
      );

      // Anthropic reports input tokens on message_start and the running output
      // token total on message_delta; capture the last-seen values and emit one
      // usage chunk before `done`.
      let reportedInputTokens: number | undefined;
      let reportedOutputTokens: number | undefined;
      let reportedCachedInputTokens: number | undefined;
      let reportedCacheWriteInputTokens: number | undefined;
      let finishReason: string | undefined;
      for await (const event of stream) {
        if (event.type === "message_start") {
          const usage = (
            event as unknown as {
              message?: {
                usage?: {
                  input_tokens?: number;
                  output_tokens?: number;
                  cache_read_input_tokens?: number;
                  cache_creation_input_tokens?: number;
                };
              };
            }
          ).message?.usage;
          if (typeof usage?.input_tokens === "number") {
            reportedInputTokens = usage.input_tokens;
          }
          if (typeof usage?.output_tokens === "number") {
            reportedOutputTokens = usage.output_tokens;
          }
          if (typeof usage?.cache_read_input_tokens === "number") {
            reportedCachedInputTokens = usage.cache_read_input_tokens;
          }
          if (typeof usage?.cache_creation_input_tokens === "number") {
            reportedCacheWriteInputTokens = usage.cache_creation_input_tokens;
          }
        } else if (event.type === "message_delta") {
          const usage = (
            event as unknown as {
              delta?: {
                stop_reason?: string | null;
              };
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              };
            }
          ).usage;
          const stopReason = (
            event as unknown as {
              delta?: { stop_reason?: string | null };
            }
          ).delta?.stop_reason;
          if (typeof stopReason === "string") {
            finishReason = stopReason;
          }
          if (typeof usage?.input_tokens === "number") {
            reportedInputTokens = usage.input_tokens;
          }
          if (typeof usage?.output_tokens === "number") {
            reportedOutputTokens = usage.output_tokens;
          }
          if (typeof usage?.cache_read_input_tokens === "number") {
            reportedCachedInputTokens = usage.cache_read_input_tokens;
          }
          if (typeof usage?.cache_creation_input_tokens === "number") {
            reportedCacheWriteInputTokens = usage.cache_creation_input_tokens;
          }
        }
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield { type: "token", content: event.delta.text };
        } else if (
          event.type === "content_block_delta" &&
          event.delta.type === "input_json_delta"
        ) {
          if (params.structuredOutput) {
            yield { type: "token", content: event.delta.partial_json };
          } else {
            const index = event.index;
            const current =
              pendingToolCalls.get(index) ??
              ({
                name: "",
                argumentsJson: "",
              } satisfies NativeToolCall & { argumentsJson: string });
            current.argumentsJson += event.delta.partial_json;
            pendingToolCalls.set(index, current);
          }
        } else if (event.type === "content_block_start") {
          const block = event.content_block as unknown as {
            type?: string;
            id?: string;
            name?: string;
            input?: Record<string, unknown>;
          };
          if (!params.structuredOutput && block.type === "tool_use") {
            const initialInput =
              block.input && Object.keys(block.input).length > 0
                ? block.input
                : undefined;
            pendingToolCalls.set(event.index, {
              id: block.id,
              name: block.name ?? "",
              arguments: initialInput,
              argumentsJson: initialInput ? JSON.stringify(initialInput) : "",
            });
          }
        }
      }
      if (!params.structuredOutput) {
        for (const toolCall of [...pendingToolCalls.values()].filter(
          (call) => call.name
        )) {
          yield { type: "tool_call", toolCall };
        }
      }
      if (
        reportedInputTokens != null ||
        reportedOutputTokens != null ||
        reportedCachedInputTokens != null ||
        reportedCacheWriteInputTokens != null
      ) {
        yield {
          type: "usage",
          usage: {
            inputTokens: reportedInputTokens,
            outputTokens: reportedOutputTokens,
            totalTokens:
              reportedInputTokens != null && reportedOutputTokens != null
                ? reportedInputTokens + reportedOutputTokens
                : undefined,
            cachedInputTokens: reportedCachedInputTokens,
            cacheWriteInputTokens: reportedCacheWriteInputTokens,
          },
        };
      }
      yield {
        type: "done",
        ...(finishReason ? { finishReason } : {}),
      };
    } catch (err) {
      yield {
        type: "error",
        error: err instanceof Error ? err.message : `${errorLabel} request failed`,
      };
    }
  }
}

export const anthropicProvider: AIProvider = {
  id: "anthropic",
  name: "Anthropic",

  listModels() {
    return getCatalogModelsForProvider("anthropic").map(
      ({ validationCandidate, ...model }) => model
    );
  },

  async validateApiKey(apiKey: string) {
    try {
      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
      await client.messages.create({
        model: getValidationModelId("anthropic"),
        max_tokens: 16,
        messages: [{ role: "user", content: "Hi" }],
      });
      return true;
    } catch (err) {
      if (err instanceof Anthropic.APIError && err.status === 401) {
        return false;
      }
      return true;
    }
  },

  async *streamChat(params: ChatParams): AsyncIterable<StreamChunk> {
    yield* streamAnthropicChat(params, "anthropic", "Anthropic");
  },
};
