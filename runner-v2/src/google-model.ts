import type {
  AgentMessage,
  AgentModel,
  AgentModelRequest,
  AssistantBlock,
  ModelTurn,
  ToolDefinition,
  ToolResult,
} from "./agent-contracts.js";
import {
  createToolNameCodec,
  fetchProviderJson,
  joinEndpoint,
  toolResultText,
  type ToolNameCodec,
} from "./provider-model-utils.js";

export interface GoogleModelOptions {
  baseUrl?: string;
  apiKey: string;
  modelId: string;
  fetch?: typeof globalThis.fetch;
}

interface GoogleResponse {
  responseId?: string;
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<
        | { text?: string }
        | { functionCall?: { id?: string; name?: string; args?: unknown } }
      >;
    };
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export class GoogleModel implements AgentModel {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: GoogleModelOptions) {
    if (!options.apiKey || !options.modelId) {
      throw new Error("Google model configuration is incomplete.");
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    const toolNames = createToolNameCodec(request.tools);
    const system = request.messages
      .filter((message) => message.role === "system")
      .map(messageText)
      .filter(Boolean)
      .join("\n\n");
    const endpoint = joinEndpoint(
      this.options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta",
      `models/${encodeURIComponent(this.options.modelId)}:generateContent`
    );
    const response = await fetchProviderJson<GoogleResponse>(
      this.fetchImpl,
      `${endpoint}?key=${encodeURIComponent(this.options.apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents: request.messages
            .filter((message) => message.role !== "system")
            .map((message) => toGoogleContent(message, toolNames)),
          ...(request.tools.length > 0
            ? { tools: [{ functionDeclarations: request.tools.map((tool) => toGoogleTool(tool, toolNames)) }] }
            : {}),
        }),
        signal: request.signal,
      }
    );
    const candidate = response.candidates?.[0];
    const blocks: AssistantBlock[] = [];
    for (const [index, part] of (candidate?.content?.parts ?? []).entries()) {
      if ("text" in part && part.text) {
        blocks.push({ type: "text", text: part.text });
      } else if ("functionCall" in part && part.functionCall?.name) {
        blocks.push({
          type: "tool_call",
          callId: part.functionCall.id ?? `tool_${index + 1}`,
          name: toolNames.nativeFor(part.functionCall.name),
          arguments: part.functionCall.args ?? {},
        });
      }
    }
    return {
      blocks,
      stopReason: blocks.some((block) => block.type === "tool_call")
        ? "tool_calls"
        : candidate?.finishReason === "MAX_TOKENS"
          ? "max_tokens"
          : "end_turn",
      ...(response.responseId ? { providerRequestId: response.responseId } : {}),
      ...(response.usageMetadata
        ? {
            usage: {
              ...(response.usageMetadata.promptTokenCount !== undefined
                ? { inputTokens: response.usageMetadata.promptTokenCount }
                : {}),
              ...(response.usageMetadata.candidatesTokenCount !== undefined
                ? { outputTokens: response.usageMetadata.candidatesTokenCount }
                : {}),
            },
          }
        : {}),
    };
  }
}

function messageText(message: AgentMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return toolResultText(message.content);
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function toGoogleContent(
  message: AgentMessage,
  toolNames: ToolNameCodec
): Record<string, unknown> {
  if (message.role === "tool") {
    const result = message.content as ToolResult;
    return {
      role: "user",
      parts: [{
        functionResponse: {
          id: result.callId,
          name: toolNames.wireFor(result.toolName),
          response: result.isError
            ? { error: result.error, content: toolResultText(result) }
            : { content: toolResultText(result) },
        },
      }],
    };
  }
  if (typeof message.content === "string") {
    return { role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] };
  }
  const content = Array.isArray(message.content) ? message.content : [];
  return {
    role: message.role === "assistant" ? "model" : "user",
    parts: content.map((block) =>
      block.type === "text"
        ? { text: block.text }
        : {
            functionCall: {
              id: block.callId,
              name: toolNames.wireFor(block.name),
              args: block.arguments,
            },
          }
    ),
  };
}

function toGoogleTool(
  tool: ToolDefinition,
  toolNames: ToolNameCodec
): Record<string, unknown> {
  return {
    name: toolNames.wireFor(tool.name),
    description: tool.description,
    parameters: tool.inputSchema,
  };
}
