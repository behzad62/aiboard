import {
  GoogleGenerativeAI,
  type GenerationConfig,
  type Part,
  type Tool,
} from "@google/generative-ai";
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
): { tools?: Tool[]; toolConfig?: unknown } {
  if (!tools?.length) return {};
  return {
    tools: [
      {
        functionDeclarations: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      } as unknown as Tool,
    ],
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
  };
}

export function googleHostedBuildToolConfig(
  enabled?: boolean
): { tools?: Tool[] } {
  if (!enabled) return {};
  return {
    tools: [{ codeExecution: {} } as unknown as Tool],
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
      const model = genAI.getGenerativeModel({
        model: params.model,
        ...(tools.length > 0 ? { tools } : {}),
      });
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
        ...googleStructuredOutputConfig(params.structuredOutput),
      } as GenerationConfig;

      const chat = model.startChat({
        history: prior.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        generationConfig,
        ...(nativeToolConfig.toolConfig
          ? { toolConfig: nativeToolConfig.toolConfig as never }
          : {}),
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
      const pendingToolCalls: NativeToolCall[] = [];
      let reportedInputTokens: number | undefined;
      let reportedOutputTokens: number | undefined;
      const captureGeminiUsage = (metadata: unknown): void => {
        const usage = metadata as
          | { promptTokenCount?: number; candidatesTokenCount?: number }
          | undefined;
        if (typeof usage?.promptTokenCount === "number") {
          reportedInputTokens = usage.promptTokenCount;
        }
        if (typeof usage?.candidatesTokenCount === "number") {
          reportedOutputTokens = usage.candidatesTokenCount;
        }
      };

      for await (const chunk of result.stream) {
        captureGeminiUsage(
          (chunk as unknown as { usageMetadata?: unknown }).usageMetadata
        );
        const chunkWithCalls = chunk as unknown as {
          functionCalls?: () => Array<{
            name?: string;
            args?: Record<string, unknown>;
          }>;
          response?: {
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
        };
        const functionCalls =
          chunkWithCalls.functionCalls?.() ??
          chunkWithCalls.response?.candidates
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
        try {
          text = chunk.text();
        } catch {
          text = "";
        }
        if (text) {
          yield { type: "token", content: text };
        }
      }
      const responseWithCalls = (await result.response) as unknown as {
        usageMetadata?: unknown;
        functionCalls?: () => Array<{
          name?: string;
          args?: Record<string, unknown>;
        }>;
      };
      captureGeminiUsage(responseWithCalls.usageMetadata);
      for (const call of responseWithCalls.functionCalls?.() ?? []) {
        const signature = `${call.name}:${JSON.stringify(call.args ?? {})}`;
        const alreadyCaptured = pendingToolCalls.some(
          (existing) =>
            `${existing.name}:${JSON.stringify(existing.arguments ?? {})}` ===
            signature
        );
        if (call.name && !alreadyCaptured) {
          pendingToolCalls.push({
            name: call.name,
            arguments: call.args,
            argumentsJson: call.args ? JSON.stringify(call.args) : undefined,
          });
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
