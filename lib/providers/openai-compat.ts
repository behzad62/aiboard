import OpenAI from "openai";
import type { AttachmentPayload } from "../attachments/types";
import { buildAttachmentPromptSection } from "../attachments/prompt-text";
import type { ChatParams } from "./base";
import type { ModelCapabilities } from "./base";
import { getModelCapabilities } from "./capabilities";
import { formatModelId } from "./base";
import type { StreamChunk } from "./base";
import { openAIReasoningEffort } from "./reasoning";
import { DISCUSSION_TRANSCRIPT_MARKER } from "../orchestrator/prompts";

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
  attachments?: AttachmentPayload[]
) {
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    { type: "text", text },
  ];

  for (const file of attachments ?? []) {
    if (file.category === "image" && file.base64Data) {
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${file.mimeType};base64,${file.base64Data}`,
        },
      });
    }
  }

  return parts.length === 1 && parts[0].type === "text" ? text : parts;
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
        (a) => a.category === "image" && caps.image
      );
      return {
        role: "user",
        content: multimodal
          ? buildOpenAIUserContent(text, params.attachments)
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
    providerId === "openai" || providerId === "openrouter"
      ? openAIReasoningEffort(params.reasoningEffort ?? "default")
      : null;
  const reasoningField: Record<string, string> = reasoningValue
    ? { reasoning_effort: reasoningValue }
    : {};

  // Temperature: omitted for OpenAI (newer models reject the parameter), but
  // OpenRouter forwards it and silently drops it for models that don't
  // support it, and local OpenAI-compatible servers (Ollama, LM Studio)
  // honor it.
  const temperatureField =
    providerId !== "openai" && params.temperature != null
      ? { temperature: params.temperature }
      : {};

  const baseMessages = buildOpenAIMessages(params, caps);
  const messages = needsExplicitCacheControl(providerId, params.model)
    ? applyOpenRouterCacheControl(baseMessages)
    : baseMessages;

  try {
    const stream = await client.chat.completions.create({
      model: params.model,
      messages,
      ...tokenField,
      ...temperatureField,
      ...openAIPromptCaching,
      ...(reasoningField as Record<string, never>),
      stream: true,
    });

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content;
      if (token) {
        yield { type: "token", content: token };
      }
    }
    yield { type: "done" };
  } catch (err) {
    yield {
      type: "error",
      error: err instanceof Error ? err.message : `${errorLabel} request failed`,
    };
  }
}
