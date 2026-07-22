import OpenAI from "openai";
import type { AttachmentPayload } from "../attachments/types";
import { buildAttachmentPromptSection } from "../attachments/prompt-text";
import type { ChatParams } from "./base";
import type { ModelCapabilities } from "./base";
import type { NativeToolCall, NativeToolDefinition } from "./base";
import { getModelCapabilities } from "./capabilities";
import { formatModelId } from "./base";
import type { StreamChunk } from "./base";
import { openAIReasoningEffort, openRouterReasoningEffort } from "./reasoning";
import { DISCUSSION_TRANSCRIPT_MARKER } from "../orchestrator/prompts";
import { openAICompatibleStructuredOutputField } from "./structured-output";

// Non-cryptographic stable hash (browser-safe — avoids Node's crypto module).
// Only used to derive a stable OpenAI prompt_cache_key string.
function stableHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return (
    h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")
  ).slice(0, 24);
}

function extractCacheableTextPrefix(text: string): string {
  const markerIndex = text.indexOf(DISCUSSION_TRANSCRIPT_MARKER);
  if (markerIndex === -1) {
    return text;
  }

  return text.slice(0, markerIndex + DISCUSSION_TRANSCRIPT_MARKER.length);
}

function buildOpenAIPromptCacheKey(
  providerId: string,
  params: ChatParams
): string {
  const stableMessages = params.messages.map((message, index) => {
    if (message.role !== "user") {
      return `${message.role}:${message.content}`;
    }

    const isLastUser =
      index ===
      params.messages
        .map((entry, entryIndex) => (entry.role === "user" ? entryIndex : -1))
        .filter((entryIndex) => entryIndex >= 0)
        .at(-1);

    return isLastUser
      ? `user:${extractCacheableTextPrefix(message.content)}`
      : `user:${message.content}`;
  });

  const attachmentSignature = (params.attachments ?? [])
    .map((attachment) => `${attachment.id}:${attachment.mimeType}:${attachment.category}`)
    .join("|");
  const hash = stableHash(
    JSON.stringify({
      providerId,
      model: params.model,
      stableMessages,
      attachmentSignature,
    })
  );

  return `aidb:${providerId}:${params.model}:${hash}`;
}

export function buildOpenAIUserContent(
  text: string,
  attachments?: AttachmentPayload[],
  caps?: ModelCapabilities
) {
  const parts: Array<Record<string, unknown>> = [
    { type: "text", text },
  ];

  for (const file of attachments ?? []) {
    if (file.category === "image" && (!caps || caps.image) && file.base64Data) {
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${file.mimeType};base64,${file.base64Data}`,
        },
      });
    } else if (file.category === "document" && caps?.document && file.base64Data) {
      parts.push({
        type: "file",
        file: {
          filename: file.filename,
          file_data: `data:${file.mimeType};base64,${file.base64Data}`,
        },
      });
    }
  }

  return parts.length === 1 && parts[0].type === "text"
    ? text
    : (parts as unknown as OpenAI.Chat.Completions.ChatCompletionContentPart[]);
}

// OpenRouter caches OpenAI/DeepSeek/Grok-style models automatically, but
// Anthropic, Gemini, and Qwen models routed through it only cache when the
// request marks explicit cache_control breakpoints.
const OPENROUTER_EXPLICIT_CACHE_PREFIXES = ["anthropic/", "google/", "qwen/"];

function needsExplicitCacheControl(providerId: string, model: string): boolean {
  return (
    providerId === "openrouter" &&
    OPENROUTER_EXPLICIT_CACHE_PREFIXES.some((p) => model.startsWith(p))
  );
}

export function openAICompatibleWebSearchField(
  providerId: string,
  enabled?: boolean
): Record<string, unknown> {
  if (!enabled) return {};
  if (providerId === "openai") {
    return { web_search_options: { search_context_size: "medium" } };
  }
  if (providerId === "openrouter") {
    return {
      tools: [
        {
          type: "openrouter:web_search",
          parameters: { search_context_size: "medium" },
        },
      ],
    };
  }
  return {};
}

export function openAICompatibleNativeToolField(
  providerId: string,
  tools: NativeToolDefinition[] | undefined
): Record<string, unknown> {
  if (
    !tools?.length ||
    !["openai", "openrouter", "custom", "nvidia"].includes(providerId)
  ) {
    return {};
  }
  return {
    tools: tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: tool.strict ?? false,
      },
    })),
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
}

export function openAICompatibleStreamOptionsField(
  providerId: string,
  structuredOutput?: ChatParams["structuredOutput"]
): {
  stream_options?: { include_usage: true };
} {
  if (providerId !== "openai" && providerId !== "openrouter") return {};
  // OpenRouter's provider.require_parameters applies to every extra request
  // parameter. Structured-output calls use that routing guard, while
  // stream_options is not listed on OpenRouter endpoint parameter manifests.
  if (providerId === "openrouter" && structuredOutput) return {};
  return { stream_options: { include_usage: true } };
}

function isKimiK3Model(model: string): boolean {
  return model.trim().toLowerCase() === "moonshotai/kimi-k3";
}

/**
 * Mark the stable prompt prefix of the last user message as ephemeral
 * cacheable content (mirrors the native Anthropic provider's split at the
 * transcript marker). Only string contents are transformed — multipart
 * (image) contents are left untouched.
 */
function applyOpenRouterCacheControl(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const lastUserIndex = messages
    .map((m, i) => (m.role === "user" ? i : -1))
    .filter((i) => i >= 0)
    .at(-1);

  return messages.map((m, index) => {
    if (index !== lastUserIndex || m.role !== "user" || typeof m.content !== "string") {
      return m;
    }
    const prefix = extractCacheableTextPrefix(m.content);
    const transcript = m.content.slice(prefix.length);
    const parts = [
      { type: "text" as const, text: prefix, cache_control: { type: "ephemeral" } },
      ...(transcript ? [{ type: "text" as const, text: transcript }] : []),
    ];
    // cache_control is an OpenRouter extension the pinned OpenAI SDK types
    // don't know about.
    return {
      ...m,
      content: parts as OpenAI.Chat.Completions.ChatCompletionContentPartText[],
    };
  });
}

export function buildOpenAIMessages(
  params: ChatParams,
  caps: ModelCapabilities
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const lastUserIndex = params.messages
    .map((m, i) => (m.role === "user" ? i : -1))
    .filter((i) => i >= 0)
    .at(-1);

  return params.messages.map((m, index) => {
    if (m.role === "system") {
      return { role: "system", content: m.content };
    }

    if (m.role === "assistant") {
      return { role: "assistant", content: m.content };
    }

    const isLastUser = index === lastUserIndex;
    if (isLastUser && params.attachments?.length) {
      const text = m.content + buildAttachmentPromptSection(params.attachments);
      const multimodal = params.attachments.some(
        (a) =>
          (a.category === "image" && caps.image && !!a.base64Data) ||
          (a.category === "document" && caps.document && !!a.base64Data)
      );
      return {
        role: "user",
        content: multimodal
          ? buildOpenAIUserContent(text, params.attachments, caps)
          : text,
      };
    }

    return { role: "user", content: m.content };
  });
}

export async function* streamOpenAICompatibleChat(
  client: OpenAI,
  params: ChatParams,
  providerId: string,
  errorLabel: string,
  tokenParam: "max_completion_tokens" | "max_tokens" = "max_completion_tokens"
): AsyncIterable<StreamChunk> {
  // Custom models pass their capabilities explicitly (they aren't in the static
  // catalog registry); built-in providers fall back to the catalog.
  const caps =
    params.capabilities ??
    getModelCapabilities(formatModelId(providerId, params.model));
  const openAIPromptCaching =
    providerId === "openai"
      ? {
          prompt_cache_retention: "24h" as const,
          prompt_cache_key: buildOpenAIPromptCacheKey(providerId, params),
        }
      : {};

  // Local OpenAI-compatible servers (Ollama, LM Studio) expect `max_tokens`,
  // while OpenAI's newer models require `max_completion_tokens`. When no budget
  // is given (e.g. a free local model), omit the cap entirely.
  const tokenField =
    params.maxTokens == null
      ? {}
      : tokenParam === "max_tokens"
        ? { max_tokens: params.maxTokens }
        : { max_completion_tokens: params.maxTokens };

  // reasoning_effort only for OpenAI / OpenRouter — custom local endpoints
  // tend to reject unknown params. Cast keeps newer values (e.g. "xhigh") past
  // the pinned SDK's narrower enum type.
  const reasoningValue =
    providerId === "openai"
      ? openAIReasoningEffort(params.reasoningEffort ?? "default", params.model)
      : providerId === "openrouter"
        ? openRouterReasoningEffort(
            params.reasoningEffort ?? "default",
            params.model
          )
        : null;
  const reasoningField: Record<string, string> = reasoningValue
    ? { reasoning_effort: reasoningValue }
    : {};

  // Temperature: omitted for OpenAI (newer models reject the parameter), but
  // OpenRouter forwards it and silently drops it for models that don't
  // support it, and local OpenAI-compatible servers (Ollama, LM Studio)
  // honor it.
  const temperatureField =
    providerId !== "openai" &&
    !isKimiK3Model(params.model) &&
    params.temperature != null
      ? { temperature: params.temperature }
      : {};

  const baseMessages = buildOpenAIMessages(params, caps);
  const messages = needsExplicitCacheControl(providerId, params.model)
    ? applyOpenRouterCacheControl(baseMessages)
    : baseMessages;
  const structuredOutputField = openAICompatibleStructuredOutputField(
    providerId,
    params.structuredOutput
  );
  const webSearchField = openAICompatibleWebSearchField(
    providerId,
    params.webSearch && !params.structuredOutput
  );
  const nativeToolField = openAICompatibleNativeToolField(
    providerId,
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
          ...(nativeToolField.tool_choice
            ? { tool_choice: nativeToolField.tool_choice }
            : {}),
          ...(nativeToolField.parallel_tool_calls
            ? { parallel_tool_calls: nativeToolField.parallel_tool_calls }
            : {}),
        }
      : {};

  // Ask OpenAI/OpenRouter to append a final usage-only chunk where that does not
  // conflict with OpenRouter strict provider-parameter routing.
  const streamOptionsField = openAICompatibleStreamOptionsField(
    providerId,
    params.structuredOutput
  );

  try {
    const pendingToolCalls = new Map<
      number,
      NativeToolCall & { argumentsJson: string }
    >();
    let reportedInputTokens: number | undefined;
    let reportedOutputTokens: number | undefined;
    let reportedTotalTokens: number | undefined;
    let reportedReasoningTokens: number | undefined;
    let reportedCachedInputTokens: number | undefined;
    let reportedCacheWriteInputTokens: number | undefined;
    let reportedInputAudioTokens: number | undefined;
    let reportedOutputAudioTokens: number | undefined;
    let reportedProviderCost: number | undefined;
    const stream = await client.chat.completions.create({
      model: params.model,
      messages,
      ...tokenField,
      ...temperatureField,
      ...openAIPromptCaching,
      ...(reasoningField as Record<string, never>),
      ...(structuredOutputField as Record<string, never>),
      ...(combinedToolField as Record<string, never>),
      ...(streamOptionsField as Record<string, never>),
      stream: true,
    });

    for await (const chunk of stream) {
      const usage = (
        chunk as unknown as {
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
            prompt_tokens_details?: {
              cached_tokens?: number;
              cache_write_tokens?: number;
              audio_tokens?: number;
            };
            completion_tokens_details?: {
              reasoning_tokens?: number;
              audio_tokens?: number;
            };
            cost?: number;
          } | null;
        }
      ).usage;
      if (usage) {
        if (typeof usage.prompt_tokens === "number") {
          reportedInputTokens = usage.prompt_tokens;
        }
        if (typeof usage.completion_tokens === "number") {
          reportedOutputTokens = usage.completion_tokens;
        }
        if (typeof usage.total_tokens === "number") {
          reportedTotalTokens = usage.total_tokens;
        }
        if (typeof usage.completion_tokens_details?.reasoning_tokens === "number") {
          reportedReasoningTokens =
            usage.completion_tokens_details.reasoning_tokens;
        }
        if (typeof usage.prompt_tokens_details?.cached_tokens === "number") {
          reportedCachedInputTokens = usage.prompt_tokens_details.cached_tokens;
        }
        if (typeof usage.prompt_tokens_details?.cache_write_tokens === "number") {
          reportedCacheWriteInputTokens =
            usage.prompt_tokens_details.cache_write_tokens;
        }
        if (typeof usage.prompt_tokens_details?.audio_tokens === "number") {
          reportedInputAudioTokens = usage.prompt_tokens_details.audio_tokens;
        }
        if (typeof usage.completion_tokens_details?.audio_tokens === "number") {
          reportedOutputAudioTokens =
            usage.completion_tokens_details.audio_tokens;
        }
        if (typeof usage.cost === "number") {
          reportedProviderCost = usage.cost;
        }
      }
      const delta = chunk.choices[0]?.delta;
      const token = delta?.content;
      if (token) {
        yield { type: "token", content: token };
      }
      for (const toolCall of delta?.tool_calls ?? []) {
        const index = toolCall.index;
        const current =
          pendingToolCalls.get(index) ??
          ({
            id: toolCall.id,
            name: toolCall.function?.name ?? "",
            argumentsJson: "",
          } satisfies NativeToolCall & { argumentsJson: string });
        current.id = current.id ?? toolCall.id;
        current.name = current.name || toolCall.function?.name || "";
        current.argumentsJson += toolCall.function?.arguments ?? "";
        pendingToolCalls.set(index, current);
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
      reportedCachedInputTokens != null ||
      reportedCacheWriteInputTokens != null ||
      reportedInputAudioTokens != null ||
      reportedOutputAudioTokens != null ||
      reportedProviderCost != null
    ) {
      yield {
        type: "usage",
        usage: {
          inputTokens: reportedInputTokens,
          outputTokens: reportedOutputTokens,
          totalTokens: reportedTotalTokens,
          reasoningTokens: reportedReasoningTokens,
          cachedInputTokens: reportedCachedInputTokens,
          cacheWriteInputTokens: reportedCacheWriteInputTokens,
          inputAudioTokens: reportedInputAudioTokens,
          outputAudioTokens: reportedOutputAudioTokens,
          providerCost: reportedProviderCost,
          ...(reportedProviderCost != null && providerId === "openrouter"
            ? { providerCostUnit: "credits" as const }
            : {}),
        },
      };
    }
    yield { type: "done" };
  } catch (err) {
    yield {
      type: "error",
      error: err instanceof Error ? err.message : `${errorLabel} request failed`,
    };
  }
}
