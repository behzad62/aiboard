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
import { createHash } from "node:crypto";
import { withVisualMedia } from "./provider-visual-input.js";
import { openAICompatibleReasoningFields } from "./reasoning-effort.js";
import { providerProtocolProfile } from "./provider-protocol-profiles.js";
import { NATIVE_PATCH_EXECUTOR, mergeNativePatchResults, nativePatchCallId, nativePatchPartId, parseCodexPatch, type CodexPatchOperation } from "./codex-apply-patch.js";
import { ProviderTransportError } from "./account-runner-model.js";
import { streamOpenAIChat, streamOpenAIResponses } from "./openai-streaming.js";

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
      reasoning_content?: string | null;
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
    | { type: "custom_tool_call"; id?: string; call_id?: string; name?: string; input?: string }
    | { type: "reasoning"; content?: Array<{ type?: string; text?: string }>; summary?: Array<{ type?: string; text?: string }> }
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
      messages: withVisualMedia(request.messages.map((message) => toOpenAIMessage(message, toolNames, {
        reasoningContent: providerProtocolProfile(this.options.providerId)?.chatReasoningContent === true,
      })), request.attachments, "openai-chat"),
      ...(toolPayload.length > 0
        ? { tools: toolPayload, tool_choice: toolChoice }
        : {}),
      ...(request.onTextDelta ? { stream: true, stream_options: { include_usage: true } } : {}),
    });
    const endpoint = joinEndpoint(this.options.baseUrl, "chat/completions");
    const init: RequestInit = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body,
        signal: request.signal,
      };
    const response = request.onTextDelta
      ? await streamOpenAIChat(this.fetchImpl, endpoint, init, request.onTextDelta)
      : await fetchProviderJson<OpenAIResponse>(this.fetchImpl, endpoint, init);
    const choice = response.choices?.[0];
    const blocks: AssistantBlock[] = [];
    if (choice?.message?.reasoning_content) {
      blocks.push({ type: "reasoning", text: choice.message.reasoning_content });
    }
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
    const profile = providerProtocolProfile(this.options.providerId);
    const canEdit = request.tools.some((tool) => tool.name === "fs.patch");
    const nativeTools = this.options.supportsTools === false || !canEdit ? [] : profile?.responses?.nativeTools ?? [];
    const replaced = new Set(nativeTools.flatMap((tool) => tool.replaces));
    const localTools = this.options.supportsTools === false ? [] : request.tools.filter((tool) => !replaced.has(tool.name));
    const toolSearchEnabled =
      this.options.providerId === "openrouter" && localTools.length > 16;
    const hostedTools = openRouterHostedToolsForRunner(
      [...(this.options.hostedTools ?? []), ...(request.hostedTools ?? [])],
      "responses"
    );
    const responseTools = dedupeRunnerTools([
      ...nativeTools.map((tool) => ({ ...tool.wire })),
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
      input: withVisualMedia(responsesInput(request.messages, toolNames, {
        reasoningItems: profile?.responses?.reasoningItems === true,
      }), request.attachments, "openai-responses"),
      ...(responseTools.length > 0
        ? {
            tools: responseTools,
            tool_choice: runnerToolChoiceForResponses(request.toolChoice, toolNames),
          }
        : {}),
      ...(request.onTextDelta ? { stream: true } : {}),
    });
    if (process.env.AIBOARD_DEBUG_PROMPT_CACHE === "1") logPromptCacheShape(request.sessionId, body);
    const endpoint = joinEndpoint(this.options.baseUrl, "responses");
    const init: RequestInit = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body,
        signal: request.signal,
      };
    const response = request.onTextDelta
      ? await streamOpenAIResponses<OpenAIResponsesResponse>(this.fetchImpl, endpoint, init, request.onTextDelta)
      : await fetchProviderJson<OpenAIResponsesResponse>(this.fetchImpl, endpoint, init);
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
      } else if (output.type === "reasoning") {
        const text = (output.content ?? []).map((part) => part.text ?? "").join("");
        if (text) blocks.push({ type: "reasoning", text });
      } else if (output.type === "custom_tool_call" && output.name === "apply_patch") {
        blocks.push(...nativePatchBlocks(output.call_id ?? output.id ?? `patch_${index + 1}`, output.input ?? ""));
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
  const preferred = providerProtocolProfile(providerId)?.preferredProtocol === "responses";
  if ((providerId !== "openrouter" && !preferred) || !(error instanceof ProviderTransportError)) return false;
  return [400, 404, 405, 415, 422, 501].includes(error.status ?? 0);
}

/**
 * A Codex patch becomes one trusted single-file operation per file (the fence binds one call to one
 * mutation); each part keeps the original call so it can be sent back and its results merged.
 */
function nativePatchBlocks(callId: string, input: string): AssistantBlock[] {
  const nativeCall = (part: number, parts: number) => ({ callId, name: "apply_patch", input, part, parts });
  let operations;
  try {
    operations = parseCodexPatch(input);
  } catch (error) {
    return [{
      type: "tool_call", callId: nativePatchPartId(callId, 1), name: NATIVE_PATCH_EXECUTOR,
      arguments: { _nativePatchError: error instanceof Error ? error.message : "The patch could not be parsed." },
      nativeCall: nativeCall(1, 1),
    }];
  }
  return operations.map((operation, index) => ({
    type: "tool_call" as const, callId: nativePatchPartId(callId, index + 1), name: NATIVE_PATCH_EXECUTOR,
    arguments: { operation }, nativeCall: nativeCall(index + 1, operations.length),
  }));
}

/** Responses input, with each native patch's per-file results merged into the call's single output. */
function responsesInput(
  messages: readonly AgentMessage[],
  toolNames: import("./provider-model-utils.js").ToolNameCodec,
  options: { reasoningItems?: boolean }
): Array<Record<string, unknown>> {
  const parts = new Map<string, { callId: string; parts: number; operation?: CodexPatchOperation }>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "tool_call" || !block.nativeCall) continue;
      const args = isRecord(block.arguments) ? block.arguments : {};
      parts.set(block.callId, {
        callId: block.nativeCall.callId, parts: block.nativeCall.parts,
        ...(isRecord(args.operation) ? { operation: args.operation as CodexPatchOperation } : {}),
      });
    }
  }
  const pending = new Map<string, Array<{ operation?: CodexPatchOperation; isError: boolean; text: string }>>();
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "tool") {
      const result = message.content as ToolResult;
      const part = parts.get(result.callId);
      if (part && nativePatchCallId(result.callId) === part.callId) {
        const collected = pending.get(part.callId) ?? [];
        collected.push({
          ...(part.operation ? { operation: part.operation } : {}),
          isError: result.isError,
          text: result.isError ? (result.error?.message ?? toolResultText(result)) : toolResultText(result),
        });
        pending.set(part.callId, collected);
        if (collected.length === part.parts) {
          input.push({ type: "custom_tool_call_output", call_id: part.callId, output: mergeNativePatchResults(collected) });
          pending.delete(part.callId);
        }
        continue;
      }
    }
    input.push(...toResponsesInput(message, toolNames, options));
  }
  return input;
}
function toOpenAIMessage(
  message: AgentMessage,
  toolNames: import("./provider-model-utils.js").ToolNameCodec,
  options: { reasoningContent?: boolean } = {}
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
  const reasoning = options.reasoningContent && message.role === "assistant"
    ? content.filter((block) => block.type === "reasoning").map((block) => block.text).join("")
    : "";
  return {
    role: message.role,
    content: text || null,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
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
  toolNames: import("./provider-model-utils.js").ToolNameCodec,
  options: { reasoningItems?: boolean } = {}
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
  if (options.reasoningItems && message.role === "assistant") {
    const reasoning = content.filter((block) => block.type === "reasoning").map((block) => block.text).join("");
    if (reasoning) result.push({ type: "reasoning", content: [{ type: "reasoning_text", text: reasoning }] });
  }
  if (text) result.push({ role: message.role, content: text });
  for (const block of content) {
    if (block.type !== "tool_call") continue;
    if (block.nativeCall) {
      // Sent back once, as the provider's own call; its parts are runner bookkeeping.
      if (block.nativeCall.part === 1) {
        result.push({ type: "custom_tool_call", call_id: block.nativeCall.callId, name: block.nativeCall.name, input: block.nativeCall.input });
      }
      continue;
    }
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

/**
 * Opt-in prompt-cache diagnostics (AIBOARD_DEBUG_PROMPT_CACHE=1): per request, short hashes of the
 * tool list and of every input item, never their content. Consecutive lines for one session show
 * where the cacheable prefix first diverges.
 */
function logPromptCacheShape(sessionId: string, serializedBody: string): void {
  try {
    const parsed = JSON.parse(serializedBody) as { tools?: unknown; input?: unknown[]; reasoning?: unknown };
    const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 8);
    console.error(`[prompt-cache] ${JSON.stringify({
      sessionId,
      tools: short(parsed.tools),
      toolCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
      reasoning: short(parsed.reasoning),
      input: (parsed.input ?? []).map(short),
    })}`);
  } catch { /* diagnostics never affect the request */ }
}
