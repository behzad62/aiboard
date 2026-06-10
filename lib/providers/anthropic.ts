import Anthropic from "@anthropic-ai/sdk";
import type { AttachmentPayload } from "../attachments/types";
import { buildAttachmentPromptSection } from "../attachments/prompt-text";
import type { AIProvider, ChatParams, StreamChunk } from "./base";
import { getModelCapabilities } from "./capabilities";
import { formatModelId } from "./base";
import { anthropicEffort } from "./reasoning";
import { getCatalogModelsForProvider, getValidationModelId } from "./catalog";

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
  caps: ReturnType<typeof getModelCapabilities>
): string | AnthropicContentBlock[] {
  if (!attachments?.length) {
    return buildCacheableAnthropicTextBlocks(text);
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
      text + buildAttachmentPromptSection(attachments)
    )
  );
  return blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks;
}

function buildCacheableAnthropicTextBlocks(text: string): AnthropicContentBlock[] {
  const transcriptMarker = "\n\n--- Discussion so far ---\n\n";
  if (!text.includes(transcriptMarker)) {
    return [
      {
        type: "text",
        text,
        cache_control: { type: "ephemeral" },
      },
    ];
  }

  const [prefix, ...rest] = text.split(transcriptMarker);
  const transcript = rest.join(transcriptMarker);

  return [
    {
      type: "text",
      text: `${prefix}${transcriptMarker}`,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: transcript,
    },
  ];
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
      const client = new Anthropic({ apiKey });
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
    const client = new Anthropic({ apiKey: params.apiKey });
    const caps = getModelCapabilities(formatModelId("anthropic", params.model));
    const systemMessage = params.messages.find((m) => m.role === "system");
    const userMessages = params.messages.filter((m) => m.role !== "system");
    const lastUserIndex = userMessages
      .map((m, i) => (m.role === "user" ? i : -1))
      .filter((i) => i >= 0)
      .at(-1);

    const chatMessages = userMessages.map((m, index) => {
      const content =
        m.role === "user" && index === lastUserIndex
          ? buildAnthropicUserContent(m.content, params.attachments, caps)
          : buildCacheableAnthropicTextBlocks(m.content);

      return {
        role: m.role as "user" | "assistant",
        content,
      };
    });

    // output_config.effort is newer than the pinned SDK's types; the cast lets
    // it pass through. Omitted (and skipped for unsupported models) by default.
    const effort = anthropicEffort(params.model, params.reasoningEffort ?? "default");
    const effortField = effort ? { output_config: { effort } } : {};

    try {
      const stream = await client.messages.stream({
        model: params.model,
        max_tokens: params.maxTokens ?? 1500,
        system: systemMessage?.content,
        messages: chatMessages,
        ...(effortField as Record<string, never>),
      });

      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield { type: "token", content: event.delta.text };
        }
      }
      yield { type: "done" };
    } catch (err) {
      yield {
        type: "error",
        error: err instanceof Error ? err.message : "Anthropic request failed",
      };
    }
  },
};
