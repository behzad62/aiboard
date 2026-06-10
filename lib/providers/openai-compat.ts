import OpenAI from "openai";
import crypto from "crypto";
import type { AttachmentPayload } from "../attachments/types";
import { buildAttachmentPromptSection } from "../attachments/prompt-text";
import type { ChatParams } from "./base";
import type { ModelCapabilities } from "./base";
import { getModelCapabilities } from "./capabilities";
import { formatModelId } from "./base";
import type { StreamChunk } from "./base";
import { openAIReasoningEffort } from "./reasoning";
import { DISCUSSION_TRANSCRIPT_MARKER } from "../orchestrator/prompts";

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
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify({
      providerId,
      model: params.model,
      stableMessages,
      attachmentSignature,
    }))
    .digest("hex")
    .slice(0, 24);

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
  // while OpenAI's newer models require `max_completion_tokens`.
  const tokenField =
    tokenParam === "max_tokens"
      ? { max_tokens: params.maxTokens ?? 1500 }
      : { max_completion_tokens: params.maxTokens ?? 1500 };

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

  try {
    const stream = await client.chat.completions.create({
      model: params.model,
      messages: buildOpenAIMessages(params, caps),
      ...tokenField,
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
