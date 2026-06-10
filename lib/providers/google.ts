import {
  GoogleGenerativeAI,
  type GenerationConfig,
  type Part,
} from "@google/generative-ai";
import type { AttachmentPayload } from "../attachments/types";
import { buildAttachmentPromptSection } from "../attachments/prompt-text";
import type { AIProvider, ChatParams, StreamChunk } from "./base";
import { getModelCapabilities } from "./capabilities";
import { formatModelId } from "./base";
import { geminiThinkingConfig } from "./reasoning";
import { getCatalogModelsForProvider, getValidationModelId } from "./catalog";

function attachmentToPart(
  file: AttachmentPayload,
  caps: ReturnType<typeof getModelCapabilities>
): Part | null {
  if (!file.base64Data) return null;

  if (file.category === "image" && caps.image) {
    return { inlineData: { mimeType: file.mimeType, data: file.base64Data } };
  }
  if (file.category === "document" && caps.document) {
    return { inlineData: { mimeType: file.mimeType, data: file.base64Data } };
  }
  if (file.category === "audio" && caps.audio) {
    return { inlineData: { mimeType: file.mimeType, data: file.base64Data } };
  }
  if (file.category === "video" && caps.video) {
    return { inlineData: { mimeType: file.mimeType, data: file.base64Data } };
  }
  return null;
}

function buildGeminiParts(
  text: string,
  attachments: AttachmentPayload[] | undefined,
  caps: ReturnType<typeof getModelCapabilities>
): Part[] {
  const parts: Part[] = [
    { text: text + buildAttachmentPromptSection(attachments ?? []) },
  ];

  for (const file of attachments ?? []) {
    const part = attachmentToPart(file, caps);
    if (part) parts.unshift(part);
  }

  return parts;
}

export const googleProvider: AIProvider = {
  id: "google",
  name: "Google Gemini",

  listModels() {
    return getCatalogModelsForProvider("google").map(
      ({ validationCandidate, ...model }) => model
    );
  },

  async validateApiKey(apiKey: string) {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: getValidationModelId("google"),
      });
      await model.generateContent("Hi");
      return true;
    } catch {
      return false;
    }
  },

  async *streamChat(params: ChatParams): AsyncIterable<StreamChunk> {
    try {
      const genAI = new GoogleGenerativeAI(params.apiKey);
      const model = genAI.getGenerativeModel({ model: params.model });
      const caps = getModelCapabilities(formatModelId("google", params.model));

      const systemMessage = params.messages.find((m) => m.role === "system");
      const history = params.messages.filter((m) => m.role !== "system");
      const lastMessage = history[history.length - 1];
      const prior = history.slice(0, -1);

      // Gemini reasoning control: Gemini 3+ uses thinkingLevel, Gemini 2.5 uses
      // thinkingBudget (sending both is a 400). At "default", 2.5 still gets a
      // bounded budget so hidden thinking can't truncate the visible answer.
      // (thinkingConfig is newer than this SDK's GenerationConfig type.)
      const thinking = geminiThinkingConfig(
        params.model,
        params.reasoningEffort ?? "default",
        params.maxTokens ?? 1500
      );
      const generationConfig = {
        maxOutputTokens: params.maxTokens ?? 1500,
        temperature: params.temperature ?? 0.7,
        ...(thinking ? { thinkingConfig: thinking } : {}),
      } as GenerationConfig;

      const chat = model.startChat({
        history: prior.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        generationConfig,
        systemInstruction: systemMessage
          ? {
              role: "system",
              parts: [{ text: systemMessage.content }],
            }
          : undefined,
      });

      const parts = buildGeminiParts(
        lastMessage.content,
        params.attachments,
        caps
      );
      const result = await chat.sendMessageStream(parts);

      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) {
          yield { type: "token", content: text };
        }
      }
      yield { type: "done" };
    } catch (err) {
      yield {
        type: "error",
        error: err instanceof Error ? err.message : "Google request failed",
      };
    }
  },
};
