import type {
  AgentHostedToolDefinition,
  AgentMessage,
  AgentModel,
  AgentModelRequest,
  AgentToolChoice,
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
  serializedInputUsage,
  toolResultText,
} from "./provider-model-utils.js";
import { openAICompatibleReasoningFields } from "./reasoning-effort.js";
import { ProviderTransportError } from "./account-runner-model.js";

export interface OpenAICompatibleModelOptions {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  providerId?: string;
  reasoningEffort?: string;
  protocol?: "chat-completions" | "responses";
  promptCaching?: boolean;
  supportsTools?: boolean;
  hostedTools?: readonly AgentHostedToolDefinition[];
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
    | {
        type: "apply_patch_call";
        id?: string;
        call_id?: string;
        [key: string]: unknown;
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
      try {
        return await this.completeResponses(request, toolNames);
      } catch (error) {
        if (!shouldFallbackFromResponses(this.options.providerId, error)) throw error;
        return await this.completeChatCompletions(request, toolNames);
      }
    }
    return await this.completeChatCompletions(request, toolNames);
  }

  private async completeChatCompletions(
    request: AgentModelRequest,
    toolNames: import("./provider-model-utils.js").ToolNameCodec
  ): Promise<ModelTurn> {
    const localTools = this.options.supportsTools === false ? [] : [...request.tools];
    const hostedTools = openRouterHostedToolsForRunner(
      [...(this.options.hostedTools ?? []), ...(request.hostedTools ?? [])],
      "chat-completions"
    );
    const toolChoice = runnerToolChoiceForChat(request.toolChoice, toolNames);
    const toolPayload = dedupeRunnerTools([
      ...hostedTools,
      ...localTools.map((tool) => toOpenAITool(tool, toolNames)),
    ]);
    const body = JSON.stringify({
      model: this.options.modelId,
      ...(this.options.providerId === "openrouter"
        ? {
            session_id: request.sessionId,
            cache_control: { type: "ephemeral" },
          }
        : {}),
      ...openAICompatibleReasoningFields({
        providerId: this.options.providerId ?? "openai-compatible",
        modelId: this.options.modelId,
        protocol: "chat-completions",
        effort: this.options.reasoningEffort,
      }),
      ...(this.options.promptCaching
        ? {
            prompt_cache_key: request.sessionId,
            prompt_cache_retention: "24h",
          }
        : {}),
      messages: request.messages.map((message) => toOpenAIMessage(message, toolNames)),
      ...(toolPayload.length > 0
        ? { tools: toolPayload, tool_choice: toolChoice }
        : {}),
    });
    const response = await fetchProviderJson<OpenAIResponse>(
      this.fetchImpl,
      joinEndpoint(this.options.baseUrl, "chat/completions"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body,
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
      usage: {
        ...serializedInputUsage(body, response.usage?.prompt_tokens),
        ...(response.usage?.prompt_tokens_details?.cached_tokens !== undefined
          ? { cachedInputTokens: response.usage.prompt_tokens_details.cached_tokens }
          : {}),
        ...(response.usage?.completion_tokens !== undefined
          ? { outputTokens: response.usage.completion_tokens }
          : {}),
      },
    };
  }

  private async completeResponses(
    request: AgentModelRequest,
    toolNames: import("./provider-model-utils.js").ToolNameCodec
  ): Promise<ModelTurn> {
    const localTools = this.options.supportsTools === false ? [] : [...request.tools];
    const toolSearchEnabled =
      this.options.providerId === "openrouter" && localTools.length > 16;
    const hostedTools = openRouterHostedToolsForRunner(
      [...(this.options.hostedTools ?? []), ...(request.hostedTools ?? [])],
      "responses"
    );
    const responseTools = dedupeRunnerTools([
      ...hostedTools,
      ...(toolSearchEnabled ? [{ type: "openrouter:tool_search" }] : []),
      ...localTools.map((tool) =>
        toResponsesTool(tool, toolNames, {
          deferLoading:
            toolSearchEnabled &&
            (tool.deferLoading ?? (!tool.readOnly && !tool.lifecycle)),
        })
      ),
    ]);
    const body = JSON.stringify({
      model: this.options.modelId,
      ...(this.options.providerId === "openrouter"
        ? {
            session_id: request.sessionId,
            cache_control: { type: "ephemeral" },
          }
        : {}),
      ...openAICompatibleReasoningFields({
        providerId: this.options.providerId ?? "openai-compatible",
        modelId: this.options.modelId,
        protocol: "responses",
        effort: this.options.reasoningEffort,
      }),
      ...(this.options.promptCaching
        ? {
            prompt_cache_key: request.sessionId,
            prompt_cache_retention: "24h",
          }
        : {}),
      input: request.messages.flatMap((message) =>
        toResponsesInput(message, toolNames)
      ),
      ...(responseTools.length > 0
        ? {
            tools: responseTools,
            tool_choice: runnerToolChoiceForResponses(request.toolChoice, toolNames),
          }
        : {}),
    });
    const response = await fetchProviderJson<OpenAIResponsesResponse>(
      this.fetchImpl,
      joinEndpoint(this.options.baseUrl, "responses"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body,
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
      } else if (output.type === "function_call" && output.name) {
        blocks.push({
          type: "tool_call",
          callId: output.call_id ?? `tool_${index + 1}`,
          name: toolNames.nativeFor(output.name),
          arguments: safeToolArguments(output.arguments),
        });
      } else if (output.type === "apply_patch_call") {
        const { type: _type, id: _id, call_id: _callId, ...argumentsValue } = output;
        blocks.push({
          type: "tool_call",
          callId: output.call_id ?? output.id ?? `patch_${index + 1}`,
          name: "openrouter.apply_patch",
          arguments: argumentsValue,
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
      usage: {
        ...serializedInputUsage(body, response.usage?.input_tokens),
        ...(response.usage?.input_tokens_details?.cached_tokens !== undefined
          ? { cachedInputTokens: response.usage.input_tokens_details.cached_tokens }
          : {}),
        ...(response.usage?.output_tokens !== undefined
          ? { outputTokens: response.usage.output_tokens }
          : {}),
      },
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shouldFallbackFromResponses(providerId: string | undefined, error: unknown): boolean {
  if (providerId !== "openrouter" || !(error instanceof ProviderTransportError)) return false;
  return [400, 404, 405, 415, 422, 501].includes(error.status ?? 0);
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
      strict: tool.strict ?? false,
    },
  };
}

function toResponsesInput(
  message: AgentMessage,
  toolNames: import("./provider-model-utils.js").ToolNameCodec
): Array<Record<string, unknown>> {
  if (message.role === "tool") {
    const result = message.content as ToolResult;
    if (result.toolName === "openrouter.apply_patch") {
      return [{
        type: "apply_patch_call_output",
        call_id: result.callId,
        status: result.isError ? "failed" : "completed",
        output: toolResultText(result),
      }];
    }
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
    if (block.name === "openrouter.apply_patch") {
      const args = isRecord(block.arguments) ? block.arguments : {};
      result.push({
        type: "apply_patch_call",
        call_id: block.callId,
        status: args.status === "failed" ? "failed" : "completed",
        ...(isRecord(args.operation) ? { operation: args.operation } : {}),
      });
      continue;
    }
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
  toolNames: import("./provider-model-utils.js").ToolNameCodec,
  options: { deferLoading?: boolean } = {}
): Record<string, unknown> {
  return {
    type: "function",
    name: toolNames.wireFor(tool.name),
    description: tool.description,
    parameters: tool.inputSchema,
    strict: tool.strict ?? false,
    ...(options.deferLoading ? { defer_loading: true } : {}),
  };
}

function runnerToolChoiceForResponses(
  choice: AgentToolChoice | undefined,
  toolNames: import("./provider-model-utils.js").ToolNameCodec
): string | Record<string, unknown> {
  if (!choice || typeof choice === "string") return choice ?? "auto";
  return { type: "function", name: toolNames.wireFor(choice.name) };
}

function runnerToolChoiceForChat(
  choice: AgentToolChoice | undefined,
  toolNames: import("./provider-model-utils.js").ToolNameCodec
): string | Record<string, unknown> {
  if (!choice || typeof choice === "string") return choice ?? "auto";
  return { type: "function", function: { name: toolNames.wireFor(choice.name) } };
}

function openRouterHostedToolsForRunner(
  tools: readonly AgentHostedToolDefinition[],
  api: "chat-completions" | "responses"
): Array<Record<string, unknown>> {
  if (!tools.length) return [];
  const chatSupported = new Set([
    "web_search",
    "web_fetch",
    "datetime",
    "image_generation",
    "advisor",
    "subagent",
    "fusion",
  ]);
  return tools
    .filter((tool) => api === "responses" || chatSupported.has(tool.type))
    .map((tool) => ({
      type: `openrouter:${tool.type}`,
      ...(tool.parameters ? { parameters: tool.parameters } : {}),
    }));
}

function dedupeRunnerTools(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return tools.filter((tool, index) => {
    const type = String(tool.type ?? "unknown");
    const key = type.startsWith("openrouter:")
      ? type
      : `${type}:${String(tool.name ?? index)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
