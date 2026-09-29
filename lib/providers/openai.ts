import OpenAI from "openai";
import type {
  AIProvider,
  ChatParams,
  HostedToolDefinition,
  ModelCapabilities,
  NativeToolCall,
  NativeToolDefinition,
  StreamChunk,
} from "./base";
import { getCatalogModelsForProvider, MODEL_CATALOG } from "./catalog";
import { streamOpenAICompatibleChat } from "./openai-compat";
import { openAIReasoningEffort, openRouterReasoningEffort } from "./reasoning";
import { openAIResponsesTextFormatField } from "./structured-output";
import { buildAttachmentPromptSection } from "../attachments/prompt-text";
import { safeProviderErrorMetadata } from "./base";
import {
  normalizeProviderToolEvent,
  type CitationRef,
  type ProviderArtifactSink,
  type ProviderToolEvent,
} from "./provider-events";
import type { ToolCapabilityId } from "./tool-capabilities";
import {
  DEFAULT_OPENROUTER_BUILD_HOSTED_TOOLS,
  openRouterFunctionToolsForResponses,
  openRouterHostedToolsForApi,
  openRouterResponsesToolField,
  toolChoiceForResponses,
} from "./openrouter-tools";

type OpenAIResponseInputMessage = {
  role: "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "input_text"; text: string }
        | { type: "input_image"; image_url: string }
        | { type: "input_file"; filename: string; file_data: string }
      >;
};

export function buildOpenAIResponsesInput(
  params: ChatParams,
  caps: ModelCapabilities
): OpenAIResponseInputMessage[] {
  const messages = params.messages.filter((m) => m.role !== "system");
  const lastUserIndex = messages
    .map((m, i) => (m.role === "user" ? i : -1))
    .filter((i) => i >= 0)
    .at(-1);

  return messages.map((m, index) => {
    const role = m.role as "user" | "assistant";
    if (role !== "user" || index !== lastUserIndex || !params.attachments?.length) {
      return { role, content: m.content };
    }

    const text = m.content + buildAttachmentPromptSection(params.attachments);
    const content: OpenAIResponseInputMessage["content"] = [
      ...params.attachments
        .filter(
          (file) =>
            file.category === "document" && caps.document && !!file.base64Data
        )
        .map((file) => ({
          type: "input_file" as const,
          filename: file.filename,
          file_data: `data:${file.mimeType};base64,${file.base64Data}`,
        })),
      ...(text ? [{ type: "input_text" as const, text }] : []),
      ...params.attachments
        .filter(
          (file) => file.category === "image" && caps.image && !!file.base64Data
        )
        .map((file) => ({
          type: "input_image" as const,
          image_url: `data:${file.mimeType};base64,${file.base64Data}`,
        })),
    ];

    return {
      role,
      content:
        content.length === 1 && content[0].type === "input_text" ? text : content,
    };
  });
}

function enabledPlanTool(params: ChatParams, id: ToolCapabilityId) {
  return params.callPlan?.enabledTools.find((tool) => tool.intent.id === id);
}

function intentParameters(params: ChatParams, id: ToolCapabilityId): Record<string, unknown> {
  return enabledPlanTool(params, id)?.intent.parameters ?? {};
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
function normalizedResponsesToolChoice(params: ChatParams): string | Record<string, unknown> {
  const choice = params.callPlan?.toolChoice ?? "auto";
  return typeof choice === "object"
    ? { type: "function", name: choice.name }
    : choice;
}

export function openAIResponsesToolField(params: ChatParams): {
  tools?: Array<Record<string, unknown>>;
  tool_choice?: string | Record<string, unknown>;
  parallel_tool_calls?: boolean;
} {
  const plan = params.callPlan;
  if (!plan || plan.transport !== "responses") return {};
  const tools: Array<Record<string, unknown>> = [];

  if (enabledPlanTool(params, "function_calling")) {
    for (const tool of params.nativeTools ?? []) {
      tools.push({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: tool.strict ?? false,
        ...(tool.deferLoading ? { defer_loading: true } : {}),
      });
    }
  }
  if (enabledPlanTool(params, "web_search")) {
    const p = intentParameters(params, "web_search");
    const contextSize = stringValue(p.searchContextSize ?? p.search_context_size);
    tools.push({
      type: "web_search",
      ...(contextSize ? { search_context_size: contextSize } : {}),
    });
  }
  if (enabledPlanTool(params, "file_search")) {
    const p = intentParameters(params, "file_search");
    const vectorStoreIds = stringArray(p.vectorStoreIds ?? p.vector_store_ids);
    if (!vectorStoreIds?.length) {
      throw new Error("OpenAI file_search requires vector store ids in tool resource configuration.");
    }
    tools.push({ type: "file_search", vector_store_ids: vectorStoreIds });
  }
  if (enabledPlanTool(params, "remote_mcp")) {
    const p = intentParameters(params, "remote_mcp");
    const serverLabel = stringValue(p.serverLabel ?? p.server_label);
    const serverUrl = stringValue(p.serverUrl ?? p.server_url);
    const connectorId = stringValue(p.connectorId ?? p.connector_id);
    const tunnelId = stringValue(p.tunnelId ?? p.tunnel_id);
    if (!serverLabel || (!serverUrl && !connectorId && !tunnelId)) {
      throw new Error("OpenAI remote MCP requires serverLabel plus serverUrl, connectorId, or tunnelId.");
    }
    tools.push({
      type: "mcp",
      server_label: serverLabel,
      ...(serverUrl ? { server_url: serverUrl } : {}),
      ...(connectorId ? { connector_id: connectorId } : {}),
      ...(tunnelId ? { tunnel_id: tunnelId } : {}),
      ...(stringValue(p.authorization) ? { authorization: p.authorization } : {}),
      ...(stringArray(p.allowedTools ?? p.allowed_tools)
        ? { allowed_tools: stringArray(p.allowedTools ?? p.allowed_tools) }
        : {}),
      ...(p.headers && typeof p.headers === "object" ? { headers: p.headers } : {}),
      ...(p.deferLoading === true || p.defer_loading === true ? { defer_loading: true } : {}),
    });
  }
  if (enabledPlanTool(params, "tool_search")) {
    tools.push({ type: "tool_search", execution: "server" });
  }
  if (enabledPlanTool(params, "shell")) {
    const p = intentParameters(params, "shell");
    tools.push({
      type: "shell",
      environment:
        p.environment && typeof p.environment === "object"
          ? p.environment
          : { type: "container_auto" },
    });
  }
  if (enabledPlanTool(params, "code_execution")) {
    const p = intentParameters(params, "code_execution");
    const fileIds = stringArray(p.fileIds ?? p.file_ids);
    const memoryLimit = stringValue(p.memoryLimit ?? p.memory_limit);
    tools.push({
      type: "code_interpreter",
      container: {
        type: "auto",
        ...(fileIds?.length ? { file_ids: fileIds } : {}),
        ...(memoryLimit ? { memory_limit: memoryLimit } : {}),
      },
    });
  }
  if (enabledPlanTool(params, "computer_use")) {
    tools.push({ type: "computer" });
  }
  if (enabledPlanTool(params, "image_generation")) {
    const p = intentParameters(params, "image_generation");
    tools.push({ type: "image_generation", ...p });
  }

  if (!tools.length) return {};
  return {
    tools,
    tool_choice: normalizedResponsesToolChoice(params),
    parallel_tool_calls: plan.parallelToolCalls,
  };
}

const OPENAI_HOSTED_ITEM_TO_CAPABILITY: Record<string, ToolCapabilityId> = {
  web_search_call: "web_search",
  web_fetch_call: "web_fetch",
  apply_patch_call: "apply_patch",
  datetime_call: "datetime",
  advisor_call: "advisor",
  subagent_call: "subagent",
  fusion_call: "fusion",
  file_search_call: "file_search",
  mcp_call: "remote_mcp",
  mcp_list_tools: "remote_mcp",
  tool_search_call: "tool_search",
  shell_call: "shell",
  code_interpreter_call: "code_execution",
  computer_call: "computer_use",
  image_generation_call: "image_generation",
};

function citationRefs(annotations: unknown): CitationRef[] {
  if (!Array.isArray(annotations)) return [];
  return annotations.flatMap((annotation) => {
    if (!annotation || typeof annotation !== "object") return [];
    const a = annotation as Record<string, unknown>;
    const url = stringValue(a.url);
    if (!url) return [];
    return [{
      url,
      ...(stringValue(a.title) ? { title: stringValue(a.title) } : {}),
      ...(typeof a.start_index === "number" || typeof a.end_index === "number"
        ? {
            sourceSpan: {
              ...(typeof a.start_index === "number" ? { start: a.start_index } : {}),
              ...(typeof a.end_index === "number" ? { end: a.end_index } : {}),
            },
          }
        : {}),
      providerData: { ...(stringValue(a.type) ? { type: a.type } : {}) },
    }];
  });
}

async function normalizeOpenAIHostedEvent(
  raw: Record<string, unknown>,
  artifactSink?: ProviderArtifactSink,
): Promise<ProviderToolEvent | undefined> {
  const rawType = stringValue(raw.type);
  const item = raw.item && typeof raw.item === "object"
    ? (raw.item as Record<string, unknown>)
    : undefined;
  const itemType = item ? stringValue(item.type) : undefined;
  const capability = itemType ? OPENAI_HOSTED_ITEM_TO_CAPABILITY[itemType] : undefined;

  if (capability && rawType === "response.output_item.added") {
    return normalizeProviderToolEvent({
      id: stringValue(item?.id) ?? stringValue(raw.item_id),
      tool: capability,
      phase: "started",
      providerManaged: capability !== "computer_use",
      rawType,
    });
  }
  if (capability && rawType === "response.output_item.done") {
    const result = capability === "image_generation" ? stringValue(item?.result) : undefined;
    return normalizeProviderToolEvent(
      {
        id: stringValue(item?.id) ?? stringValue(raw.item_id),
        tool: capability,
        phase: item?.status === "failed" ? "failed" : "completed",
        providerManaged: capability !== "computer_use",
        rawType,
        ...(result
          ? {
              artifactPayloads: [
                {
                  id: stringValue(item?.id),
                  bytes: decodeBase64Bytes(result),
                  mimeType: "image/png",
                  filename: `${stringValue(item?.id) ?? "openai-image"}.png`,
                },
              ],
            }
          : {}),
      },
      artifactSink,
    );
  }
  if (rawType === "response.output_text.done") {
    const citations = citationRefs(raw.annotations);
    if (citations.length) {
      return normalizeProviderToolEvent({
        tool: "web_search",
        phase: "completed",
        providerManaged: true,
        rawType,
        citations,
      });
    }
  }
  return undefined;
}

export async function* streamOpenAIByPlan(
  client: OpenAI,
  params: ChatParams,
): AsyncIterable<StreamChunk> {
  const transport = params.callPlan?.transport ?? "responses";
  if (transport === "responses") {
    yield* streamOpenAIResponses(client, params, "openai");
    return;
  }
  if (transport === "chat_completions") {
    yield* streamOpenAICompatibleChat(client, params, "openai", "OpenAI");
    return;
  }
  yield {
    type: "error",
    error: `OpenAI transport ${transport} is not supported by this adapter.`,
  };
}

/** Stream through the OpenAI-style Responses API for OpenAI or OpenRouter. */
export async function* streamOpenAIResponses(
  client: OpenAI,
  params: ChatParams,
  providerId: "openai" | "openrouter" | "custom" = "openai"
): AsyncIterable<StreamChunk> {
  const instructions = params.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const caps =
    params.capabilities ??
    MODEL_CATALOG.find((m) => m.providerId === providerId && m.id === params.model)
      ?.capabilities ?? {
      image: false,
      document: false,
      audio: false,
      video: false,
    };
  const input = buildOpenAIResponsesInput(params, caps);

  const reasoningValue =
    providerId === "openrouter"
      ? openRouterReasoningEffort(params.reasoningEffort ?? "default", params.model)
      : providerId === "openai"
        ? openAIReasoningEffort(params.reasoningEffort ?? "default", params.model)
        : undefined;
  const structuredOutputField = openAIResponsesTextFormatField(
    params.structuredOutput
  );
  const combinedToolField =
    providerId !== "openrouter"
      ? openAIResponsesToolField(params)
      : params.callPlan
        ? openRouterResponsesToolField(params)
        : (() => {
          const webSearchField = openAIResponsesWebSearchField(
            params.webSearch && !params.structuredOutput,
            providerId
          );
          const nativeToolField = openAIResponsesNativeToolField(
            params.structuredOutput ? undefined : params.nativeTools,
            { providerId, toolChoice: params.toolChoice }
          );
          const requestedHostedTools = !params.structuredOutput
            ? [
                ...(params.hostedBuildTools ? DEFAULT_OPENROUTER_BUILD_HOSTED_TOOLS : []),
                ...(params.hostedTools ?? []),
              ]
            : [];
          const hostedToolField = openRouterHostedToolField(requestedHostedTools);
          const combinedTools = dedupeResponseTools([
            ...((webSearchField.tools as unknown[] | undefined) ?? []),
            ...((nativeToolField.tools as unknown[] | undefined) ?? []),
            ...((hostedToolField.tools as unknown[] | undefined) ?? []),
          ]);
          return combinedTools.length > 0
            ? {
                tools: combinedTools,
                tool_choice:
                  nativeToolField.tool_choice ?? toolChoiceForResponses(params.toolChoice),
                ...(nativeToolField.parallel_tool_calls
                  ? { parallel_tool_calls: nativeToolField.parallel_tool_calls }
                  : {}),
              }
            : {};
        })();

  try {
    const pendingToolCalls = new Map<
      string,
      NativeToolCall & { argumentsJson: string }
    >();
    let reportedInputTokens: number | undefined;
    let reportedOutputTokens: number | undefined;
    let reportedTotalTokens: number | undefined;
    let reportedReasoningTokens: number | undefined;
    let reportedCachedInputTokens: number | undefined;
    let reportedCacheWriteInputTokens: number | undefined;
    let reportedProviderCost: number | undefined;
    const stream = await client.responses.create(
      {
        model: params.model,
        ...(instructions ? { instructions } : {}),
        input: input as never,
        ...(providerId === "openrouter"
          ? ({ cache_control: { type: "ephemeral" } } as unknown as Record<string, never>)
          : {}),
        ...(params.maxTokens != null
          ? { max_output_tokens: params.maxTokens }
          : {}),
        ...(providerId === "openrouter" &&
          params.temperature != null &&
          params.model.trim().toLowerCase() !== "moonshotai/kimi-k3"
          ? { temperature: params.temperature }
          : {}),
        ...(reasoningValue
          ? {
              reasoning: {
                effort: reasoningValue,
              } as never,
            }
          : {}),
        ...(structuredOutputField as Record<string, never>),
        ...(providerId === "openrouter" && params.structuredOutput
          ? ({ provider: { require_parameters: true } } as unknown as Record<string, never>)
          : {}),
        ...(combinedToolField as Record<string, never>),
        stream: true,
      },
      { signal: params.signal }
    );

    for await (const event of stream) {
      const rawEvent = event as unknown as {
        type?: string;
        delta?: string;
        item_id?: string;
        output_index?: number;
        item?: {
          id?: string;
          call_id?: string;
          type?: string;
          name?: string;
          arguments?: string;
          action?: {
            type?: string;
            command?: unknown;
          };
        };
        name?: string;
        arguments?: string;
      };
      const providerToolEvent = await normalizeOpenAIHostedEvent(
        event as unknown as Record<string, unknown>,
        params.artifactSink,
      );
      if (providerToolEvent) {
        yield { type: "provider_tool_event", providerToolEvent };
      }
      // Responses reports usage on the terminal response.completed event.
      const responseUsage = (
        event as unknown as {
          response?: {
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              total_tokens?: number;
              input_tokens_details?: {
                cached_tokens?: number;
                cache_write_tokens?: number;
              };
              output_tokens_details?: { reasoning_tokens?: number };
              cost?: number;
            } | null;
          };
        }
      ).response?.usage;
      if (responseUsage) {
        if (typeof responseUsage.input_tokens === "number") {
          reportedInputTokens = responseUsage.input_tokens;
        }
        if (typeof responseUsage.output_tokens === "number") {
          reportedOutputTokens = responseUsage.output_tokens;
        }
        if (typeof responseUsage.total_tokens === "number") {
          reportedTotalTokens = responseUsage.total_tokens;
        }
        if (typeof responseUsage.input_tokens_details?.cached_tokens === "number") {
          reportedCachedInputTokens =
            responseUsage.input_tokens_details.cached_tokens;
        }
        if (
          typeof responseUsage.output_tokens_details?.reasoning_tokens ===
          "number"
        ) {
          reportedReasoningTokens =
            responseUsage.output_tokens_details.reasoning_tokens;
        }
        if (
          typeof responseUsage.input_tokens_details?.cache_write_tokens === "number"
        ) {
          reportedCacheWriteInputTokens =
            responseUsage.input_tokens_details.cache_write_tokens;
        }
        if (typeof responseUsage.cost === "number") {
          reportedProviderCost = responseUsage.cost;
        }
      }
      if (event.type === "response.output_text.delta" && event.delta) {
        yield { type: "token", content: event.delta };
      } else if (event.type === "response.failed") {
        yield {
          type: "error",
          error:
            event.response?.error?.message ?? "OpenAI responses request failed",
        };
        return;
      } else if (
        rawEvent.type === "response.output_item.added" ||
        rawEvent.type === "response.output_item.done"
      ) {
        const item = rawEvent.item;
        if (item?.type === "function_call") {
          const id =
            item.call_id ??
            item.id ??
            rawEvent.item_id ??
            String(rawEvent.output_index ?? pendingToolCalls.size);
          const current =
            pendingToolCalls.get(id) ??
            ({
              id,
              name: "",
              argumentsJson: "",
            } satisfies NativeToolCall & { argumentsJson: string });
          current.name = item.name ?? current.name;
          if (item.arguments != null) current.argumentsJson = item.arguments;
          pendingToolCalls.set(id, current);
        }
      } else if (
        rawEvent.type === "response.function_call_arguments.delta" &&
        rawEvent.delta != null
      ) {
        const id =
          rawEvent.item_id ?? String(rawEvent.output_index ?? pendingToolCalls.size);
        const current =
          pendingToolCalls.get(id) ??
          ({
            id,
            name: "",
            argumentsJson: "",
          } satisfies NativeToolCall & { argumentsJson: string });
        current.argumentsJson += rawEvent.delta;
        pendingToolCalls.set(id, current);
      } else if (
        rawEvent.type === "response.function_call_arguments.done" &&
        rawEvent.arguments != null
      ) {
        const id =
          rawEvent.item_id ?? String(rawEvent.output_index ?? pendingToolCalls.size);
        const current =
          pendingToolCalls.get(id) ??
          ({
            id,
            name: "",
            argumentsJson: "",
          } satisfies NativeToolCall & { argumentsJson: string });
        current.argumentsJson = rawEvent.arguments;
        pendingToolCalls.set(id, current);
      }
    }
    for (const toolCall of [...pendingToolCalls.values()].filter(
      (call) => call.name
    )) {
      yield { type: "tool_call", toolCall };
    }
    if (
      reportedInputTokens != null ||
      reportedOutputTokens != null ||
      reportedTotalTokens != null ||
      reportedReasoningTokens != null ||
      reportedCachedInputTokens != null ||
      reportedCacheWriteInputTokens != null ||
      reportedProviderCost != null
    ) {
      yield {
        type: "usage",
        usage: {
          inputTokens: reportedInputTokens,
          outputTokens: reportedOutputTokens,
          totalTokens: reportedTotalTokens,
          reasoningTokens: reportedReasoningTokens,
          cachedInputTokens: reportedCachedInputTokens,
          cacheWriteInputTokens: reportedCacheWriteInputTokens,
          providerCost: reportedProviderCost,
          ...(reportedProviderCost != null && providerId === "openrouter"
            ? { providerCostUnit: "credits" as const }
            : {}),
        },
      };
    }
    yield { type: "done" };
  } catch (err) {
    yield {
      type: "error",
      error:
        err instanceof Error
          ? err.message
          : `${providerId === "openrouter" ? "OpenRouter" : "OpenAI"} request failed`,
      errorMetadata: safeProviderErrorMetadata(err),
    };
  }
}

export function openAIResponsesWebSearchField(
  enabled?: boolean,
  providerId: "openai" | "openrouter" | "custom" = "openai"
): Record<string, unknown> {
  if (!enabled) return {};
  return {
    tools:
      providerId === "openrouter"
        ? [{ type: "openrouter:web_search", parameters: { search_context_size: "medium" } }]
        : [{ type: "web_search" }],
    tool_choice: "auto",
  };
}

export function openAIResponsesNativeToolField(
  tools: NativeToolDefinition[] | undefined,
  options: {
    providerId?: "openai" | "openrouter";
    toolChoice?: ChatParams["toolChoice"];
  } = {}
): Record<string, unknown> {
  if (!tools?.length) return {};
  const providerId = options.providerId ?? "openai";
  const mapped =
    providerId === "openrouter"
      ? openRouterFunctionToolsForResponses(tools).tools
      : tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: tool.strict ?? false,
        }));
  return {
    tools: mapped,
    tool_choice:
      providerId === "openrouter"
        ? toolChoiceForResponses(options.toolChoice)
        : typeof options.toolChoice === "object"
          ? { type: "function", name: options.toolChoice.name }
          : options.toolChoice ?? "auto",
    parallel_tool_calls: true,
  };
}

export function openRouterHostedToolField(
  tools: readonly HostedToolDefinition[] | undefined
): Record<string, unknown> {
  const mapped = openRouterHostedToolsForApi(tools, "responses");
  return mapped.length > 0 ? { tools: mapped } : {};
}

export function openAIResponsesHostedBuildToolsField(
  enabled?: boolean,
  providerId: "openai" | "openrouter" | "custom" = "openai"
): Record<string, unknown> {
  if (!enabled || providerId !== "openrouter") return {};
  return openRouterHostedToolField(DEFAULT_OPENROUTER_BUILD_HOSTED_TOOLS);
}

function dedupeResponseTools(tools: unknown[]): unknown[] {
  const seen = new Set<string>();
  return tools.filter((tool, index) => {
    if (!tool || typeof tool !== "object") return true;
    const record = tool as Record<string, unknown>;
    const type = String(record.type ?? "unknown");
    const key = type.startsWith("openrouter:")
      ? type
      : `${type}:${String(record.name ?? index)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const openaiProvider: AIProvider = {
  id: "openai",
  name: "OpenAI",

  listModels() {
    return getCatalogModelsForProvider("openai").map(
      ({ validationCandidate, ...model }) => model
    );
  },

  async validateApiKey(apiKey: string) {
    try {
      const client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
      await client.models.list();
      return true;
    } catch {
      return false;
    }
  },

  async *streamChat(params: ChatParams) {
    const client = new OpenAI({
      apiKey: params.apiKey,
      dangerouslyAllowBrowser: true,
      ...(params.disableAutomaticRetries ? { maxRetries: 0 } : {}),
    });
    yield* streamOpenAIByPlan(client, params);
  },
};
