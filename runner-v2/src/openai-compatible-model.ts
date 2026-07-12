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
  safeToolArguments,
  toolResultText,
} from "./provider-model-utils.js";

export interface OpenAICompatibleModelOptions {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  protocol?: "chat-completions" | "responses";
  promptCaching?: boolean;
  fetch?: typeof globalThis.fetch;
}

interface OpenAIResponse {
  id?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens?: number;
  };
}

interface OpenAIResponsesResponse {
  id?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  output?: Array<
    | { type: "message"; content?: Array<{ type?: string; text?: string }> }
    | {
        type: "function_call";
        call_id?: string;
        name?: string;
        arguments?: string;
      }
  >;
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens?: number;
  };
}

export class OpenAICompatibleModel implements AgentModel {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: OpenAICompatibleModelOptions) {
    if (!options.baseUrl || !options.apiKey || !options.modelId) {
      throw new Error("OpenAI-compatible model configuration is incomplete.");
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    const toolNames = createToolNameCodec(request.tools);
    if (this.options.protocol === "responses") {
      return await this.completeResponses(request, toolNames);
    }
    const response = await fetchProviderJson<OpenAIResponse>(
      this.fetchImpl,
      joinEndpoint(this.options.baseUrl, "chat/completions"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.modelId,
          ...(this.options.promptCaching
            ? {
                prompt_cache_key: request.sessionId,
                prompt_cache_retention: "24h",
              }
            : {}),
          messages: request.messages.map((message) => toOpenAIMessage(message, toolNames)),
          ...(request.tools.length > 0
            ? { tools: request.tools.map((tool) => toOpenAITool(tool, toolNames)), tool_choice: "auto" }
            : {}),
        }),
        signal: request.signal,
      }
    );
    const choice = response.choices?.[0];
    const blocks: AssistantBlock[] = [];
    if (choice?.message?.content) {
      blocks.push({ type: "text", text: choice.message.content });
    }
    for (const [index, call] of (choice?.message?.tool_calls ?? []).entries()) {
      if (!call.function?.name) continue;
      blocks.push({
        type: "tool_call",
        callId: call.id ?? `tool_${index + 1}`,
        name: toolNames.nativeFor(call.function.name),
        arguments: safeToolArguments(call.function.arguments),
      });
    }
    return {
      blocks,
      stopReason: blocks.some((block) => block.type === "tool_call")
        ? "tool_calls"
        : choice?.finish_reason === "length"
          ? "max_tokens"
          : "end_turn",
      ...(response.id ? { providerRequestId: response.id } : {}),
      ...(response.usage
        ? {
            usage: {
              ...(response.usage.prompt_tokens !== undefined
                ? { inputTokens: response.usage.prompt_tokens }
                : {}),
              ...(response.usage.prompt_tokens_details?.cached_tokens !== undefined
                ? { cachedInputTokens: response.usage.prompt_tokens_details.cached_tokens }
                : {}),
              ...(response.usage.completion_tokens !== undefined
                ? { outputTokens: response.usage.completion_tokens }
                : {}),
            },
          }
        : {}),
    };
  }

  private async completeResponses(
    request: AgentModelRequest,
    toolNames: import("./provider-model-utils.js").ToolNameCodec
  ): Promise<ModelTurn> {
    const response = await fetchProviderJson<OpenAIResponsesResponse>(
      this.fetchImpl,
      joinEndpoint(this.options.baseUrl, "responses"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.modelId,
          ...(this.options.promptCaching
            ? {
                prompt_cache_key: request.sessionId,
                prompt_cache_retention: "24h",
              }
            : {}),
          input: request.messages.flatMap((message) =>
            toResponsesInput(message, toolNames)
          ),
          ...(request.tools.length > 0
            ? { tools: request.tools.map((tool) => toResponsesTool(tool, toolNames)) }
            : {}),
        }),
        signal: request.signal,
      }
    );
    const blocks: AssistantBlock[] = [];
    for (const [index, output] of (response.output ?? []).entries()) {
      if (output.type === "message") {
        for (const part of output.content ?? []) {
          if (part.type === "output_text" && part.text) {
            blocks.push({ type: "text", text: part.text });
          }
        }
      } else if (output.name) {
        blocks.push({
          type: "tool_call",
          callId: output.call_id ?? `tool_${index + 1}`,
          name: toolNames.nativeFor(output.name),
          arguments: safeToolArguments(output.arguments),
        });
      }
    }
    return {
      blocks,
      stopReason: blocks.some((block) => block.type === "tool_call")
        ? "tool_calls"
        : response.incomplete_details?.reason === "max_output_tokens"
          ? "max_tokens"
          : "end_turn",
      ...(response.id ? { providerRequestId: response.id } : {}),
      ...(response.usage
        ? {
            usage: {
              ...(response.usage.input_tokens !== undefined
                ? { inputTokens: response.usage.input_tokens }
                : {}),
              ...(response.usage.input_tokens_details?.cached_tokens !== undefined
                ? { cachedInputTokens: response.usage.input_tokens_details.cached_tokens }
                : {}),
              ...(response.usage.output_tokens !== undefined
                ? { outputTokens: response.usage.output_tokens }
                : {}),
            },
          }
        : {}),
    };
  }
}

function toOpenAIMessage(
  message: AgentMessage,
  toolNames: import("./provider-model-utils.js").ToolNameCodec
): Record<string, unknown> {
  if (message.role === "tool") {
    const result = message.content as ToolResult;
    return {
      role: "tool",
      tool_call_id: result.callId,
      content: toolResultText(result),
    };
  }
  if (typeof message.content === "string") {
    return { role: message.role, content: message.content };
  }
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const calls = content
    .filter((block) => block.type === "tool_call")
    .map((block) => ({
      id: block.callId,
      type: "function",
      function: { name: toolNames.wireFor(block.name), arguments: JSON.stringify(block.arguments) },
    }));
  return {
    role: message.role,
    content: text || null,
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
  };
}

function toOpenAITool(
  tool: ToolDefinition,
  toolNames: import("./provider-model-utils.js").ToolNameCodec
): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: toolNames.wireFor(tool.name),
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function toResponsesInput(
  message: AgentMessage,
  toolNames: import("./provider-model-utils.js").ToolNameCodec
): Array<Record<string, unknown>> {
  if (message.role === "tool") {
    const result = message.content as ToolResult;
    return [{
      type: "function_call_output",
      call_id: result.callId,
      output: toolResultText(result),
    }];
  }
  if (typeof message.content === "string") {
    return [{ role: message.role, content: message.content }];
  }
  const content = Array.isArray(message.content) ? message.content : [];
  const result: Array<Record<string, unknown>> = [];
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (text) result.push({ role: message.role, content: text });
  for (const block of content) {
    if (block.type !== "tool_call") continue;
    result.push({
      type: "function_call",
      call_id: block.callId,
      name: toolNames.wireFor(block.name),
      arguments: JSON.stringify(block.arguments),
    });
  }
  return result;
}

function toResponsesTool(
  tool: ToolDefinition,
  toolNames: import("./provider-model-utils.js").ToolNameCodec
): Record<string, unknown> {
  return {
    type: "function",
    name: toolNames.wireFor(tool.name),
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  };
}
