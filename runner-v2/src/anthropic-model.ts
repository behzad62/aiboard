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
  providerReportedTokenCount,
  serializedInputUsage,
  toolResultText,
  type ToolNameCodec,
} from "./provider-model-utils.js";

export interface AnthropicModelOptions {
  baseUrl?: string;
  apiKey: string;
  modelId: string;
  maxTokens?: number;
  fetch?: typeof globalThis.fetch;
}

interface AnthropicResponse {
  id?: string;
  stop_reason?: string;
  content?: Array<
    | { type: "text"; text?: string }
    | { type: "tool_use"; id?: string; name?: string; input?: unknown }
  >;
  usage?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens?: number;
  };
}

export class AnthropicModel implements AgentModel {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: AnthropicModelOptions) {
    if (!options.apiKey || !options.modelId) {
      throw new Error("Anthropic model configuration is incomplete.");
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
    const body = JSON.stringify({
      model: this.options.modelId,
      max_tokens: this.options.maxTokens ?? 16_384,
      cache_control: { type: "ephemeral" },
      ...(system ? { system } : {}),
      messages: request.messages
        .filter((message) => message.role !== "system")
        .map((message) => toAnthropicMessage(message, toolNames)),
      ...(request.tools.length > 0
        ? { tools: request.tools.map((tool) => toAnthropicTool(tool, toolNames)) }
        : {}),
    });
    const response = await fetchProviderJson<AnthropicResponse>(
      this.fetchImpl,
      joinEndpoint(this.options.baseUrl ?? "https://api.anthropic.com", "v1/messages"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body,
        signal: request.signal,
      }
    );
    const blocks: AssistantBlock[] = [];
    for (const [index, block] of (response.content ?? []).entries()) {
      if (block.type === "text" && block.text) {
        blocks.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use" && block.name) {
        blocks.push({
          type: "tool_call",
          callId: block.id ?? `tool_${index + 1}`,
          name: toolNames.nativeFor(block.name),
          arguments: block.input ?? {},
        });
      }
    }
    const inputUsage = anthropicInputUsage(response.usage);
    return {
      blocks,
      stopReason: blocks.some((block) => block.type === "tool_call")
        ? "tool_calls"
        : response.stop_reason === "max_tokens"
          ? "max_tokens"
          : "end_turn",
      ...(response.id ? { providerRequestId: response.id } : {}),
      usage: {
        ...inputUsage,
        ...serializedInputUsage(body, inputUsage.inputTokens),
        ...(response.usage?.output_tokens !== undefined
          ? { outputTokens: response.usage.output_tokens }
          : {}),
      },
    };
  }
}

function anthropicInputUsage(
  usage: AnthropicResponse["usage"]
): {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
} {
  if (!usage) return {};
  const values = [
    usage.input_tokens,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens,
  ];
  if (values.some(
    (value) => value !== undefined && providerReportedTokenCount(value) === undefined
  )) return {};
  const hasInput = values.some((value) => value !== undefined);
  const input = providerReportedTokenCount(usage.input_tokens) ?? 0;
  const cacheRead = providerReportedTokenCount(usage.cache_read_input_tokens) ?? 0;
  const cacheWrite = providerReportedTokenCount(usage.cache_creation_input_tokens) ?? 0;
  return {
    ...(hasInput
      ? { inputTokens: input + cacheRead + cacheWrite }
      : {}),
    ...(usage.cache_read_input_tokens !== undefined
      ? { cachedInputTokens: usage.cache_read_input_tokens }
      : {}),
    ...(usage.cache_creation_input_tokens !== undefined
      ? { cacheWriteInputTokens: usage.cache_creation_input_tokens }
      : {}),
  };
}

function messageText(message: AgentMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return toolResultText(message.content);
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function toAnthropicMessage(
  message: AgentMessage,
  toolNames: ToolNameCodec
): Record<string, unknown> {
  if (message.role === "tool") {
    const result = message.content as ToolResult;
    return {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: result.callId,
        content: toolResultText(result),
        ...(result.isError ? { is_error: true } : {}),
      }],
    };
  }
  if (typeof message.content === "string") {
    return { role: message.role === "assistant" ? "assistant" : "user", content: message.content };
  }
  const content = Array.isArray(message.content) ? message.content : [];
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content: content.map((block) =>
      block.type === "text"
        ? { type: "text", text: block.text }
        : {
            type: "tool_use",
            id: block.callId,
            name: toolNames.wireFor(block.name),
            input: block.arguments,
          }
    ),
  };
}

function toAnthropicTool(
  tool: ToolDefinition,
  toolNames: ToolNameCodec
): Record<string, unknown> {
  return {
    name: toolNames.wireFor(tool.name),
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}
