import OpenAI from "openai";
import type { AttachmentPayload } from "../attachments/types";
import { buildAttachmentPromptSection } from "../attachments/prompt-text";
import type { ChatParams } from "./base";
import type { ModelCapabilities } from "./base";
import { getModelCapabilities } from "./capabilities";
import { formatModelId } from "./base";
import type { StreamChunk } from "./base";

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
  errorLabel: string
): AsyncIterable<StreamChunk> {
  const caps = getModelCapabilities(formatModelId(providerId, params.model));

  try {
    const stream = await client.chat.completions.create({
      model: params.model,
      messages: buildOpenAIMessages(params, caps),
      max_tokens: params.maxTokens ?? 1500,
      temperature: params.temperature ?? 0.7,
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
