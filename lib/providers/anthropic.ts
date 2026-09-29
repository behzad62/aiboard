import Anthropic from "@anthropic-ai/sdk";
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
import { anthropicReasoningFields } from "./reasoning";
import { getCatalogModelsForProvider, getValidationModelId } from "./catalog";
import { anthropicStructuredToolConfig } from "./structured-output";
import { safeProviderErrorMetadata } from "./base";
import {
  normalizeProviderToolEvent,
  type CitationRef,
  type ProviderToolEvent,
} from "./provider-events";
import type { ToolCapabilityId } from "./tool-capabilities";

type AnthropicImageMedia =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

type AnthropicCacheControl = { type: "ephemeral" };

type AnthropicContentBlock =
  | { type: "text"; text: string; cache_control?: AnthropicCacheControl }
  | {
      type: "image";
      source: { type: "base64"; media_type: AnthropicImageMedia; data: string };
    }
  | {
      type: "document";
      source: { type: "base64"; media_type: "application/pdf"; data: string };
    };

function toAnthropicImageMedia(mimeType: string): AnthropicImageMedia {
  if (
    mimeType === "image/jpeg" ||
    mimeType === "image/png" ||
    mimeType === "image/gif" ||
    mimeType === "image/webp"
  ) {
    return mimeType;
  }
  return "image/png";
}

function buildAnthropicUserContent(
  text: string,
  attachments: AttachmentPayload[] | undefined,
  caps: ReturnType<typeof getModelCapabilities>,
  cache = true
): string | AnthropicContentBlock[] {
  if (!attachments?.length) {
    return buildCacheableAnthropicTextBlocks(text, cache);
  }

  const blocks: AnthropicContentBlock[] = [];

  for (const file of attachments) {
    if (file.category === "image" && caps.image && file.base64Data) {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: toAnthropicImageMedia(file.mimeType),
          data: file.base64Data,
        },
      });
    } else if (
      file.category === "document" &&
      caps.document &&
      file.mimeType === "application/pdf" &&
      file.base64Data
    ) {
      blocks.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: file.base64Data,
        },
      });
    }
  }

  blocks.push(
    ...buildCacheableAnthropicTextBlocks(
      text + buildAttachmentPromptSection(attachments),
      cache
    )
  );
  return blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks;
}

function buildCacheableAnthropicTextBlocks(
  text: string,
  cache = true
): AnthropicContentBlock[] {
  const transcriptMarker = "\n\n--- Discussion so far ---\n\n";
  const ephemeral = cache
    ? { cache_control: { type: "ephemeral" as const } }
    : {};
  if (!text.includes(transcriptMarker)) {
    return [{ type: "text", text, ...ephemeral }];
  }

  const [prefix, ...rest] = text.split(transcriptMarker);
  const transcript = rest.join(transcriptMarker);

  return [
    { type: "text", text: `${prefix}${transcriptMarker}`, ...ephemeral },
    { type: "text", text: transcript },
  ];
}

/**
 * Anthropic allows at most 4 `cache_control` breakpoints per request. With the
 * Build engine's multi-turn tool conversations a one-breakpoint-per-message
 * scheme blows that cap (it hit "Found 5" once a review loop ran a few turns).
 * Mark only the FIRST user message (the large, stable instruction prefix — a
 * cache hit on every turn of a loop) and the LAST message (incremental caching
 * as the conversation grows). Returns indices into the non-system message list.
 */
export function anthropicCacheBreakpointIndices(
  roles: Array<"user" | "assistant">
): Set<number> {
  const indices = new Set<number>();
  if (roles.length === 0) return indices;
  const firstUser = roles.findIndex((r) => r === "user");
  if (firstUser >= 0) indices.add(firstUser);
  indices.add(roles.length - 1); // last message (always sent as a user turn)
  return indices;
}

export function anthropicWebSearchField(
  enabled?: boolean
): Record<string, unknown> {
  if (!enabled) return {};
  return {
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    tool_choice: { type: "auto" },
  };
}

export function anthropicNativeToolField(
  tools: NativeToolDefinition[] | undefined
): Record<string, unknown> {
  if (!tools?.length) return {};
  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
    tool_choice: { type: "auto" },
  };
}

function isAnthropicThinkingEnabled(field: Record<string, unknown>): boolean {
  const thinking = field.thinking as { type?: string } | undefined;
  return thinking?.type === "enabled" || thinking?.type === "adaptive";
}

function isAnthropicManualThinkingEnabled(
  field: Record<string, unknown>
): boolean {
  const thinking = field.thinking as { type?: string } | undefined;
  return thinking?.type === "enabled";
}

function planToolEnabled(params: ChatParams, id: ToolCapabilityId): boolean {
  return params.callPlan?.enabledTools.some((tool) => tool.intent.id === id) === true;
}

function planToolParameters(
  params: ChatParams,
  id: ToolCapabilityId,
): Record<string, unknown> {
  return (
    params.callPlan?.enabledTools.find((tool) => tool.intent.id === id)?.intent
      .parameters ?? {}
  );
}

function stringParam(
  params: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function numberParam(
  params: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function anthropicToolChoiceForPlan(
  params: ChatParams,
): Record<string, unknown> | undefined {
  const plan = params.callPlan;
  if (!plan || plan.toolChoice === "none") return undefined;
  const disableParallel = !plan.parallelToolCalls;
  const parallelField = disableParallel
    ? { disable_parallel_tool_use: true }
    : {};
  if (plan.toolChoice === "auto") {
    return { type: "auto", ...parallelField };
  }
  if (plan.toolChoice === "required") {
    return { type: "any", ...parallelField };
  }
  return { type: "tool", name: plan.toolChoice.name, ...parallelField };
}

export interface AnthropicPlanToolConfig {
  tools: Array<Record<string, unknown>>;
  tool_choice?: Record<string, unknown>;
  mcp_servers?: Array<Record<string, unknown>>;
  betas: string[];
}

export function anthropicToolConfigForPlan(
  params: ChatParams,
  providerId: string,
): AnthropicPlanToolConfig {
  const tools: Array<Record<string, unknown>> = [];
  const betas = new Set<string>();
  const mcpServers: Array<Record<string, unknown>> = [];

  if (params.structuredOutput) {
    tools.push(...((anthropicStructuredToolConfig(params.structuredOutput).tools as Array<Record<string, unknown>> | undefined) ?? []));
  }

  if (planToolEnabled(params, "function_calling")) {
    for (const tool of params.functionTools ?? []) {
      tools.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
        ...(tool.deferLoading ? { defer_loading: true } : {}),
      });
    }
  }

  if (planToolEnabled(params, "web_search")) {
    const parameters = planToolParameters(params, "web_search");
    const maxUses = numberParam(parameters, "maxUses", "max_uses");
    tools.push({
      type: "web_search_20250305",
      name: "web_search",
      ...(maxUses !== undefined ? { max_uses: maxUses } : {}),
    });
  }

  if (planToolEnabled(params, "web_fetch")) {
    const parameters = planToolParameters(params, "web_fetch");
    const maxUses = numberParam(parameters, "maxUses", "max_uses");
    tools.push({
      type: "web_fetch_20250910",
      name: "web_fetch",
      ...(maxUses !== undefined ? { max_uses: maxUses } : {}),
    });
  }

  if (planToolEnabled(params, "code_execution")) {
    tools.push({ type: "code_execution_20260521", name: "code_execution" });
  }

  if (planToolEnabled(params, "advisor")) {
    const parameters = planToolParameters(params, "advisor");
    const model = stringParam(parameters, "model");
    if (!model) throw new Error("Anthropic advisor requires a model parameter.");
    tools.push({ type: "advisor_20260301", name: "advisor", model });
    betas.add("advisor-tool-2026-03-01");
  }

  if (planToolEnabled(params, "tool_search")) {
    const parameters = planToolParameters(params, "tool_search");
    const variant = stringParam(parameters, "variant") ?? "regex";
    tools.push({
      type:
        variant === "bm25"
          ? "tool_search_tool_bm25_20251119"
          : "tool_search_tool_regex_20251119",
      name: "tool_search",
    });
  }

  if (planToolEnabled(params, "remote_mcp")) {
    const parameters = planToolParameters(params, "remote_mcp");
    const serverName = stringParam(parameters, "serverName", "server_name");
    const serverUrl = stringParam(parameters, "serverUrl", "server_url");
    if (!serverName || !serverUrl) {
      throw new Error("Anthropic MCP connector requires serverName and serverUrl.");
    }
    const authorizationToken = stringParam(
      parameters,
      "authorizationToken",
      "authorization_token",
    );
    mcpServers.push({
      type: "url",
      url: serverUrl,
      name: serverName,
      ...(authorizationToken
        ? { authorization_token: authorizationToken }
        : {}),
    });
    tools.push({ type: "mcp_toolset", mcp_server_name: serverName });
    betas.add("mcp-client-2025-11-20");
  }

  if (planToolEnabled(params, "shell")) {
    tools.push({ type: "bash_20250124", name: "bash" });
  }
  if (planToolEnabled(params, "apply_patch")) {
    const parameters = planToolParameters(params, "apply_patch");
    const maxCharacters = numberParam(
      parameters,
      "maxCharacters",
      "max_characters",
    );
    tools.push({
      type: "text_editor_20250728",
      name: "str_replace_based_edit_tool",
      ...(maxCharacters !== undefined
        ? { max_characters: maxCharacters }
        : {}),
    });
  }
  if (planToolEnabled(params, "computer_use")) {
    tools.push({ type: "computer_toolset_20260801" });
  }
  if (planToolEnabled(params, "browser_use")) {
    tools.push({ type: "browser_toolset_20260801" });
  }

  const structuredConfig = params.structuredOutput
    ? anthropicStructuredToolConfig(params.structuredOutput)
    : undefined;
  const structuredReasoningField = anthropicReasoningFields(
    params.model,
    params.reasoningEffort ?? "default",
    params.maxTokens ?? 1500,
  );
  const structuredChoice = params.structuredOutput
    ? isAnthropicThinkingEnabled(structuredReasoningField) && tools.length > 0
      ? { type: "auto" as const }
      : structuredConfig?.tool_choice
    : undefined;
  const normalizedChoice = anthropicToolChoiceForPlan(params);
  const toolChoice = structuredChoice ?? normalizedChoice;

  return {
    tools,
    ...(tools.length > 0 && toolChoice ? { tool_choice: toolChoice } : {}),
    ...(mcpServers.length > 0 ? { mcp_servers: mcpServers } : {}),
    betas: [...betas],
  };
}

const ANTHROPIC_SERVER_TOOL_NAMES: Record<string, ToolCapabilityId> = {
  web_search: "web_search",
  web_fetch: "web_fetch",
  code_execution: "code_execution",
  advisor: "advisor",
  tool_search: "tool_search",
};

const ANTHROPIC_SERVER_RESULT_TYPES: Record<string, ToolCapabilityId> = {
  web_search_tool_result: "web_search",
  web_fetch_tool_result: "web_fetch",
  code_execution_tool_result: "code_execution",
  advisor_tool_result: "advisor",
  tool_search_tool_result: "tool_search",
  mcp_tool_result: "remote_mcp",
};

function serverToolCapability(block: Record<string, unknown>): ToolCapabilityId | undefined {
  if (block.type === "mcp_tool_use") return "remote_mcp";
  if (block.type !== "server_tool_use") return undefined;
  return typeof block.name === "string"
    ? ANTHROPIC_SERVER_TOOL_NAMES[block.name]
    : undefined;
}

function serverResultCapability(block: Record<string, unknown>): ToolCapabilityId | undefined {
  return typeof block.type === "string"
    ? ANTHROPIC_SERVER_RESULT_TYPES[block.type]
    : undefined;
}

function serverResultCitations(block: Record<string, unknown>): CitationRef[] {
  const content = Array.isArray(block.content) ? block.content : [];
  return content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url : undefined;
    if (!url) return [];
    return [
      {
        url,
        ...(typeof record.title === "string" ? { title: record.title } : {}),
        providerData: {
          ...(typeof record.type === "string" ? { type: record.type } : {}),
        },
      },
    ];
  });
}

async function normalizeAnthropicServerBlock(
  block: Record<string, unknown>,
  phase: "started" | "completed",
): Promise<ProviderToolEvent | undefined> {
  const capability =
    phase === "started"
      ? serverToolCapability(block)
      : serverResultCapability(block);
  if (!capability) return undefined;
  return normalizeProviderToolEvent({
    id:
      typeof block.id === "string"
        ? block.id
        : typeof block.tool_use_id === "string"
          ? block.tool_use_id
          : undefined,
    tool: capability,
    phase,
    providerManaged: true,
    ...(phase === "completed"
      ? { citations: serverResultCitations(block) }
      : {}),
    rawType: typeof block.type === "string" ? block.type : undefined,
  });
}

function cloneContentBlock(block: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(block)) as Record<string, unknown>;
}

interface AnthropicStreamingClient {
  messages: {
    stream(
      request: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<AsyncIterable<unknown>>;
  };
}

const MAX_ANTHROPIC_PAUSE_CONTINUATIONS = 4;

export async function* streamAnthropicWithClient(
  client: AnthropicStreamingClient,
  params: ChatParams,
  providerId: string,
  errorLabel: string,
): AsyncIterable<StreamChunk> {
  const caps =
    params.capabilities ??
    getModelCapabilities(formatModelId(providerId, params.model));
  const systemMessage = params.messages.find((message) => message.role === "system");
  const userMessages = params.messages.filter((message) => message.role !== "system");
  const lastUserIndex = userMessages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0)
    .at(-1);
  const cacheIndices = anthropicCacheBreakpointIndices(
    userMessages.map((message) => message.role as "user" | "assistant"),
  );
  let messages: Array<Record<string, unknown>> = userMessages.map((message, index) => {
    const cache = cacheIndices.has(index);
    const content =
      message.role === "user" && index === lastUserIndex
        ? buildAnthropicUserContent(message.content, params.attachments, caps, cache)
        : buildCacheableAnthropicTextBlocks(message.content, cache);
    return { role: message.role, content };
  });

  const maxTokens = params.maxTokens ?? 1500;
  const reasoningField = anthropicReasoningFields(
    params.model,
    params.reasoningEffort ?? "default",
    maxTokens,
  );
  const toolConfig = anthropicToolConfigForPlan(params, providerId);
  const betas = new Set(toolConfig.betas);
  if (isAnthropicManualThinkingEnabled(reasoningField) && toolConfig.tools.length > 0) {
    betas.add("interleaved-thinking-2025-05-14");
  }
  const requestOptions: Record<string, unknown> = {
    ...(betas.size > 0
      ? { headers: { "anthropic-beta": [...betas].join(",") } }
      : {}),
    signal: params.signal,
  };

  let pauseCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedInputTokens = 0;
  let totalCacheWriteInputTokens = 0;
  let sawInputUsage = false;
  let sawOutputUsage = false;
  let sawCachedUsage = false;
  let sawCacheWriteUsage = false;

  try {
    while (true) {
      const pendingToolCalls = new Map<
        number,
        NativeToolCall & { argumentsJson: string }
      >();
      const assistantBlocks = new Map<number, Record<string, unknown>>();
      const assistantBlockInputJson = new Map<number, string>();
      let finishReason: string | undefined;
      let requestInputTokens: number | undefined;
      let requestOutputTokens: number | undefined;
      let requestCachedTokens: number | undefined;
      let requestCacheWriteTokens: number | undefined;

      const stream = await client.messages.stream(
        {
          model: params.model,
          max_tokens: maxTokens,
          system: systemMessage?.content,
          messages,
          ...(reasoningField as Record<string, unknown>),
          ...(toolConfig.tools.length > 0 ? { tools: toolConfig.tools } : {}),
          ...(toolConfig.tool_choice ? { tool_choice: toolConfig.tool_choice } : {}),
          ...(toolConfig.mcp_servers ? { mcp_servers: toolConfig.mcp_servers } : {}),
        },
        requestOptions,
      );

      for await (const rawEvent of stream) {
        const event = rawEvent as Record<string, unknown>;
        const type = event.type;
        if (type === "message_start") {
          const message =
            event.message && typeof event.message === "object"
              ? (event.message as Record<string, unknown>)
              : undefined;
          const usage =
            message?.usage && typeof message.usage === "object"
              ? (message.usage as Record<string, unknown>)
              : undefined;
          if (typeof usage?.input_tokens === "number") requestInputTokens = usage.input_tokens;
          if (typeof usage?.output_tokens === "number") requestOutputTokens = usage.output_tokens;
          if (typeof usage?.cache_read_input_tokens === "number") requestCachedTokens = usage.cache_read_input_tokens;
          if (typeof usage?.cache_creation_input_tokens === "number") requestCacheWriteTokens = usage.cache_creation_input_tokens;
          continue;
        }

        if (type === "message_delta") {
          const delta =
            event.delta && typeof event.delta === "object"
              ? (event.delta as Record<string, unknown>)
              : undefined;
          const usage =
            event.usage && typeof event.usage === "object"
              ? (event.usage as Record<string, unknown>)
              : undefined;
          if (typeof delta?.stop_reason === "string") finishReason = delta.stop_reason;
          if (typeof usage?.input_tokens === "number") requestInputTokens = usage.input_tokens;
          if (typeof usage?.output_tokens === "number") requestOutputTokens = usage.output_tokens;
          if (typeof usage?.cache_read_input_tokens === "number") requestCachedTokens = usage.cache_read_input_tokens;
          if (typeof usage?.cache_creation_input_tokens === "number") requestCacheWriteTokens = usage.cache_creation_input_tokens;
          continue;
        }

        if (type === "content_block_start") {
          const index = typeof event.index === "number" ? event.index : assistantBlocks.size;
          const block =
            event.content_block && typeof event.content_block === "object"
              ? (event.content_block as Record<string, unknown>)
              : undefined;
          if (!block) continue;
          assistantBlocks.set(index, cloneContentBlock(block));

          const serverEvent = await normalizeAnthropicServerBlock(block, "started");
          if (serverEvent) {
            yield { type: "provider_tool_event", providerToolEvent: serverEvent };
            continue;
          }
          const resultEvent = await normalizeAnthropicServerBlock(block, "completed");
          if (resultEvent) {
            yield { type: "provider_tool_event", providerToolEvent: resultEvent };
            continue;
          }

          if (block.type === "tool_use") {
            const name = typeof block.name === "string" ? block.name : "";
            if (params.structuredOutput && name === params.structuredOutput.name) continue;
            const input =
              block.input && typeof block.input === "object"
                ? (block.input as Record<string, unknown>)
                : undefined;
            pendingToolCalls.set(index, {
              id: typeof block.id === "string" ? block.id : undefined,
              name,
              arguments: input && Object.keys(input).length > 0 ? input : undefined,
              argumentsJson:
                input && Object.keys(input).length > 0 ? JSON.stringify(input) : "",
            });
          }
          continue;
        }

        if (type === "content_block_delta") {
          const index = typeof event.index === "number" ? event.index : 0;
          const delta =
            event.delta && typeof event.delta === "object"
              ? (event.delta as Record<string, unknown>)
              : undefined;
          if (!delta) continue;
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            yield { type: "token", content: delta.text };
            const block = assistantBlocks.get(index) ?? { type: "text", text: "" };
            block.text = `${typeof block.text === "string" ? block.text : ""}${delta.text}`;
            assistantBlocks.set(index, block);
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const block = assistantBlocks.get(index);
            if (block) {
              const combinedJson =
                (assistantBlockInputJson.get(index) ?? "") + delta.partial_json;
              assistantBlockInputJson.set(index, combinedJson);
              try {
                block.input = JSON.parse(combinedJson) as Record<string, unknown>;
              } catch {
                // Keep accumulating until the streamed JSON becomes complete.
              }
              assistantBlocks.set(index, block);
            }
            const pending = pendingToolCalls.get(index);
            if (params.structuredOutput && !pending) {
              yield { type: "token", content: delta.partial_json };
            } else if (pending) {
              pending.argumentsJson += delta.partial_json;
              pendingToolCalls.set(index, pending);
            }
          }
        }
      }

      if (requestInputTokens !== undefined) {
        totalInputTokens += requestInputTokens;
        sawInputUsage = true;
      }
      if (requestOutputTokens !== undefined) {
        totalOutputTokens += requestOutputTokens;
        sawOutputUsage = true;
      }
      if (requestCachedTokens !== undefined) {
        totalCachedInputTokens += requestCachedTokens;
        sawCachedUsage = true;
      }
      if (requestCacheWriteTokens !== undefined) {
        totalCacheWriteInputTokens += requestCacheWriteTokens;
        sawCacheWriteUsage = true;
      }

      if (finishReason === "pause_turn") {
        pauseCount++;
        if (pauseCount > MAX_ANTHROPIC_PAUSE_CONTINUATIONS) {
          yield {
            type: "error",
            error: `Anthropic server-tool continuation exceeded ${MAX_ANTHROPIC_PAUSE_CONTINUATIONS} pause_turn rounds.`,
          };
          return;
        }
        const pausedContent = [...assistantBlocks.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, block]) => block);
        messages = [...messages, { role: "assistant", content: pausedContent }];
        continue;
      }

      if (!params.structuredOutput) {
        for (const toolCall of pendingToolCalls.values()) {
          if (toolCall.name) yield { type: "tool_call", toolCall };
        }
      }
      if (sawInputUsage || sawOutputUsage || sawCachedUsage || sawCacheWriteUsage) {
        yield {
          type: "usage",
          usage: {
            inputTokens: sawInputUsage ? totalInputTokens : undefined,
            outputTokens: sawOutputUsage ? totalOutputTokens : undefined,
            totalTokens:
              sawInputUsage && sawOutputUsage
                ? totalInputTokens + totalOutputTokens
                : undefined,
            cachedInputTokens: sawCachedUsage ? totalCachedInputTokens : undefined,
            cacheWriteInputTokens: sawCacheWriteUsage
              ? totalCacheWriteInputTokens
              : undefined,
          },
        };
      }
      yield {
        type: "done",
        ...(finishReason ? { finishReason } : {}),
      };
      return;
    }
  } catch (error) {
    yield {
      type: "error",
      error: error instanceof Error ? error.message : `${errorLabel} request failed`,
      errorMetadata: safeProviderErrorMetadata(error),
    };
  }
}

/**
 * Shared Anthropic-API streaming — used by Anthropic and compatible Foundry
 * deployments. Capability planning happens before this adapter; conditional
 * Foundry hosted tools therefore arrive here only after deployment evidence.
 */
export async function* streamAnthropicChat(
  params: ChatParams,
  providerId: string,
  errorLabel: string,
): AsyncIterable<StreamChunk> {
  const client = new Anthropic({
    apiKey: params.apiKey,
    ...(params.baseURL ? { baseURL: params.baseURL } : {}),
    dangerouslyAllowBrowser: true,
    ...(params.disableAutomaticRetries ? { maxRetries: 0 } : {}),
  });
  yield* streamAnthropicWithClient(
    client as unknown as AnthropicStreamingClient,
    params,
    providerId,
    errorLabel,
  );
}

export const anthropicProvider: AIProvider = {
  id: "anthropic",
  name: "Anthropic",

  listModels() {
    return getCatalogModelsForProvider("anthropic").map(
      ({ validationCandidate, ...model }) => model
    );
  },

  async validateApiKey(apiKey: string) {
    try {
      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
      await client.messages.create({
        model: getValidationModelId("anthropic"),
        max_tokens: 16,
        messages: [{ role: "user", content: "Hi" }],
      });
      return true;
    } catch (err) {
      if (err instanceof Anthropic.APIError && err.status === 401) {
        return false;
      }
      return true;
    }
  },

  async *streamChat(params: ChatParams): AsyncIterable<StreamChunk> {
    yield* streamAnthropicChat(params, "anthropic", "Anthropic");
  },
};
