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
import { withVisualMedia } from "./provider-visual-input.js";
import { anthropicReasoningFields } from "./reasoning-effort.js";
import { collectAnthropicStream } from "./native-provider-streaming.js";

export interface AnthropicModelOptions {
  baseUrl?: string;
  apiKey: string;
  modelId: string;
  maxTokens?: number;
  reasoningEffort?: string;
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
    const maxTokens = this.options.maxTokens ?? anthropicDefaultMaxTokens(this.options.modelId, Boolean(request.onTextDelta));
    const system = request.messages
      .filter((message) => message.role === "system")
      .map(messageText)
      .filter(Boolean)
      .join("\n\n");
    const body = JSON.stringify({
      model: this.options.modelId,
      max_tokens: maxTokens,
      ...anthropicReasoningFields(
        this.options.modelId,
        this.options.reasoningEffort,
        maxTokens
      ),
      cache_control: { type: "ephemeral" },
      ...(system ? { system } : {}),
      messages: withVisualMedia(request.messages
        .filter((message) => message.role !== "system")
        .map((message) => toAnthropicMessage(message, toolNames)), request.attachments, "anthropic"),
      ...(request.tools.length > 0
        ? { tools: request.tools.map((tool) => toAnthropicTool(tool, toolNames)) }
        : {}),
      ...(request.onTextDelta ? { stream: true } : {}),
    });
    const endpoint = joinEndpoint(this.options.baseUrl ?? "https://api.anthropic.com", "v1/messages");
    const init: RequestInit = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body,
        signal: request.signal,
      };
    const response = request.onTextDelta
      ? await collectAnthropicStream(this.fetchImpl, endpoint, init, request.onTextDelta)
      : await fetchProviderJson<AnthropicResponse>(this.fetchImpl, endpoint, init);
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

/**
 * The default per-response output cap. A fixed 16,384 cut off whole-plan tool calls (21-34k output
 * tokens, more with thinking sharing the cap) mid-call, and every retry hit the same wall. Streaming
 * requests get 64k on Claude 4.x/5 models (Opus 4.0/4.1 allow 32k); non-streamed ones keep ~16k so
 * the request stays under HTTP timeouts.
 */
export function anthropicDefaultMaxTokens(modelId: string, streaming: boolean): number {
  if (!streaming) return 16_384;
  if (/^claude-opus-4(-[01])?(-\d{8})?$/.test(modelId)) return 32_000;
  return /^claude-(fable|mythos|opus|sonnet|haiku)-[45]/.test(modelId) ? 64_000 : 16_384;
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
    // Anthropic thinking needs its signed blocks, which are not captured yet; plain reasoning is not sent.
    content: content.filter((block) => block.type !== "reasoning").map((block) =>
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
