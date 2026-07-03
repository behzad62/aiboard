import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  type Content,
  type GenerateContentConfig,
  type Part,
  type Tool,
} from "@google/genai";
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
import { geminiThinkingConfig } from "./reasoning";
import { getCatalogModelsForProvider, getValidationModelId } from "./catalog";
import { googleStructuredOutputConfig } from "./structured-output";

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

export function googleWebSearchTools(
  model: string,
  enabled?: boolean
): Tool[] | undefined {
  if (!enabled) return undefined;
  if (model.startsWith("gemini-2.")) {
    return [{ googleSearchRetrieval: {} }];
  }
  return [{ googleSearch: {} } as unknown as Tool];
}

export function googleNativeToolConfig(
  tools: NativeToolDefinition[] | undefined
): { tools?: Tool[]; toolConfig?: GenerateContentConfig["toolConfig"] } {
  if (!tools?.length) return {};
  return {
    tools: [
      {
        functionDeclarations: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: tool.parameters,
        })),
      },
    ],
    toolConfig: {
      functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
    },
  };
}

export function googleHostedBuildToolConfig(
  enabled?: boolean
): { tools?: Tool[] } {
  if (!enabled) return {};
  return {
    tools: [{ codeExecution: {} }],
  };
}

function chatRoleToGeminiRole(role: "system" | "user" | "assistant"): string {
  return role === "assistant" ? "model" : "user";
}

function messageToGeminiContent(message: {
  role: "system" | "user" | "assistant";
  content: string;
}): Content {
  return {
    role: chatRoleToGeminiRole(message.role),
    parts: [{ text: message.content }],
  };
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
      const genAI = new GoogleGenAI({ apiKey });
      await genAI.models.generateContent({
        model: getValidationModelId("google"),
        contents: "Hi",
      });
      return true;
    } catch {
      return false;
    }
  },

  async *streamChat(params: ChatParams): AsyncIterable<StreamChunk> {
    try {
      const genAI = new GoogleGenAI({ apiKey: params.apiKey });
      const webSearchTools = googleWebSearchTools(
        params.model,
        params.webSearch && !params.structuredOutput
      );
      const nativeToolConfig = googleNativeToolConfig(
        params.structuredOutput ? undefined : params.nativeTools
      );
      const hostedBuildToolConfig = googleHostedBuildToolConfig(
        params.hostedBuildTools && !params.structuredOutput
      );
      const tools = [
        ...(webSearchTools ?? []),
        ...(nativeToolConfig.tools ?? []),
        ...(hostedBuildToolConfig.tools ?? []),
      ];
      const caps = getModelCapabilities(formatModelId("google", params.model));

      const systemMessage = params.messages.find((m) => m.role === "system");
      const history = params.messages.filter((m) => m.role !== "system");
      const lastMessage = history[history.length - 1];
      const prior = history.slice(0, -1);
      if (!lastMessage) {
        throw new Error("Google request requires at least one user message.");
      }

      // Gemini reasoning control: Gemini 3+ uses thinkingLevel, Gemini 2.5 uses
      // thinkingBudget (sending both is a 400). At "default", 2.5 still gets a
      // bounded budget so hidden thinking can't truncate the visible answer.
      const thinking = geminiThinkingConfig(
        params.model,
        params.reasoningEffort ?? "default",
        params.maxTokens ?? 1500
      );
      const generationConfig: GenerateContentConfig = {
        maxOutputTokens: params.maxTokens ?? 1500,
        temperature: params.temperature ?? 0.7,
        ...(thinking
          ? {
              thinkingConfig:
                thinking as GenerateContentConfig["thinkingConfig"],
            }
          : {}),
        ...(tools.length > 0 ? { tools } : {}),
        ...(nativeToolConfig.toolConfig
          ? { toolConfig: nativeToolConfig.toolConfig }
          : {}),
        ...(systemMessage ? { systemInstruction: systemMessage.content } : {}),
        ...googleStructuredOutputConfig(params.structuredOutput),
      };

      const contents: Content[] = [
        ...prior.map(messageToGeminiContent),
        {
          role: chatRoleToGeminiRole(lastMessage.role),
          parts: buildGeminiParts(lastMessage.content, params.attachments, caps),
        },
      ];
      const stream = await genAI.models.generateContentStream({
        model: params.model,
        contents,
        config: generationConfig,
      });
      const pendingToolCalls: NativeToolCall[] = [];
      let reportedInputTokens: number | undefined;
      let reportedOutputTokens: number | undefined;
      const captureGeminiUsage = (metadata: unknown): void => {
        const usage = metadata as
          | {
              promptTokenCount?: number;
              candidatesTokenCount?: number;
              thoughtsTokenCount?: number;
            }
          | undefined;
        if (typeof usage?.promptTokenCount === "number") {
          reportedInputTokens = usage.promptTokenCount;
        }
        const candidateTokens =
          typeof usage?.candidatesTokenCount === "number"
            ? usage.candidatesTokenCount
            : undefined;
        const thoughtTokens =
          typeof usage?.thoughtsTokenCount === "number"
            ? usage.thoughtsTokenCount
            : undefined;
        if (candidateTokens != null || thoughtTokens != null) {
          reportedOutputTokens = (candidateTokens ?? 0) + (thoughtTokens ?? 0);
        }
      };

      for await (const chunk of stream) {
        captureGeminiUsage(
          (chunk as unknown as { usageMetadata?: unknown }).usageMetadata
        );
        const chunkWithCalls = chunk as unknown as {
          functionCalls?: Array<{ name?: string; args?: Record<string, unknown> }>;
          candidates?: Array<{
            content?: {
              parts?: Array<{
                functionCall?: {
                  name?: string;
                  args?: Record<string, unknown>;
                };
              }>;
            };
          }>;
        };
        const functionCalls =
          chunkWithCalls.functionCalls ??
          chunkWithCalls.candidates
            ?.flatMap((candidate) => candidate.content?.parts ?? [])
            .map((part) => part.functionCall)
            .filter(
              (call): call is { name?: string; args?: Record<string, unknown> } =>
                !!call
            ) ??
          [];
        for (const call of functionCalls) {
          if (call.name) {
            pendingToolCalls.push({
              name: call.name,
              arguments: call.args,
              argumentsJson: call.args ? JSON.stringify(call.args) : undefined,
            });
          }
        }
        let text = "";
        if (typeof chunk.text === "string") text = chunk.text;
        if (text) {
          yield { type: "token", content: text };
        }
      }
      for (const toolCall of pendingToolCalls) {
        yield { type: "tool_call", toolCall };
      }
      if (reportedInputTokens != null || reportedOutputTokens != null) {
        yield {
          type: "usage",
          usage: {
            inputTokens: reportedInputTokens,
            outputTokens: reportedOutputTokens,
          },
        };
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
