import OpenAI from "openai";
import type {
  AIProvider,
  ChatParams,
  NativeToolCall,
  StreamChunk,
} from "./base";
import { safeProviderErrorMetadata } from "./base";
import { getCatalogModelsForProvider, MODEL_CATALOG } from "./catalog";
import { buildOpenAIResponsesInput } from "./openai";
import {
  normalizeProviderToolEvent,
  type CitationRef,
  type ProviderArtifactSink,
  type ProviderToolEvent,
} from "./provider-events";
import { xAIReasoningEffort } from "./reasoning";
import { openAIResponsesTextFormatField } from "./structured-output";
import type { ToolCapabilityId } from "./tool-capabilities";

const XAI_BASE_URL = "https://api.x.ai/v1";

function createXAIClient(apiKey: string, disableAutomaticRetries = false) {
  return new OpenAI({
    apiKey,
    baseURL: XAI_BASE_URL,
    dangerouslyAllowBrowser: true,
    timeout: 360_000,
    ...(disableAutomaticRetries ? { maxRetries: 0 } : {}),
  });
}

function enabledPlanTool(params: ChatParams, id: ToolCapabilityId): boolean {
  return params.callPlan?.enabledTools.some((tool) => tool.intent.id === id) === true;
}

function intentParameters(
  params: ChatParams,
  id: ToolCapabilityId,
): Record<string, unknown> {
  return (
    params.callPlan?.enabledTools.find((tool) => tool.intent.id === id)?.intent
      .parameters ?? {}
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return Object.values(record).every((item) => typeof item === "string")
    ? ({ ...record } as Record<string, string>)
    : undefined;
}

function normalizedToolChoice(params: ChatParams): string | Record<string, unknown> {
  const choice = params.callPlan?.toolChoice ?? "auto";
  return typeof choice === "object"
    ? { type: "function", name: choice.name }
    : choice;
}

export function xAIResponsesToolField(params: ChatParams): {
  tools?: Array<Record<string, unknown>>;
  tool_choice?: string | Record<string, unknown>;
  parallel_tool_calls?: boolean;
  include?: string[];
} {
  const plan = params.callPlan;
  if (!plan || plan.transport !== "responses") return {};

  const tools: Array<Record<string, unknown>> = [];
  const include: string[] = [];

  if (enabledPlanTool(params, "function_calling")) {
    for (const tool of params.nativeTools ?? []) {
      tools.push({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: tool.strict ?? false,
      });
    }
  }

  if (enabledPlanTool(params, "web_search")) {
    const p = intentParameters(params, "web_search");
    const allowedDomains = stringArray(p.allowedDomains ?? p.allowed_domains);
    const excludedDomains = stringArray(p.excludedDomains ?? p.excluded_domains);
    const enableImageUnderstanding = booleanValue(
      p.enableImageUnderstanding ?? p.enable_image_understanding,
    );
    tools.push({
      type: "web_search",
      ...(allowedDomains ? { allowed_domains: allowedDomains } : {}),
      ...(excludedDomains ? { excluded_domains: excludedDomains } : {}),
      ...(enableImageUnderstanding !== undefined
        ? { enable_image_understanding: enableImageUnderstanding }
        : {}),
    });
    include.push("web_search_call.action.sources");
  }

  if (enabledPlanTool(params, "x_search")) {
    const p = intentParameters(params, "x_search");
    const fromDate = stringValue(p.fromDate ?? p.from_date);
    const toDate = stringValue(p.toDate ?? p.to_date);
    const xHandles = stringArray(p.xHandles ?? p.x_handles);
    const excludedXHandles = stringArray(
      p.excludedXHandles ?? p.excluded_x_handles,
    );
    tools.push({
      type: "x_search",
      ...(fromDate ? { from_date: fromDate } : {}),
      ...(toDate ? { to_date: toDate } : {}),
      ...(xHandles ? { x_handles: xHandles } : {}),
      ...(excludedXHandles ? { excluded_x_handles: excludedXHandles } : {}),
    });
  }

  if (enabledPlanTool(params, "code_execution")) {
    tools.push({ type: "code_interpreter" });
    include.push("code_interpreter_call.outputs");
  }

  if (enabledPlanTool(params, "file_search")) {
    const p = intentParameters(params, "file_search");
    const vectorStoreIds = stringArray(p.vectorStoreIds ?? p.vector_store_ids);
    if (!vectorStoreIds?.length) {
      throw new Error("xAI file_search requires configured collection/vector-store ids.");
    }
    const maxNumResults = numberValue(p.maxNumResults ?? p.max_num_results);
    tools.push({
      type: "file_search",
      vector_store_ids: vectorStoreIds,
      ...(maxNumResults !== undefined ? { max_num_results: maxNumResults } : {}),
    });
    include.push("file_search_call.results");
  }

  if (enabledPlanTool(params, "remote_mcp")) {
    const p = intentParameters(params, "remote_mcp");
    const serverUrl = stringValue(p.serverUrl ?? p.server_url);
    const serverLabel = stringValue(p.serverLabel ?? p.server_label);
    if (!serverUrl || !serverLabel) {
      throw new Error("xAI remote MCP requires serverUrl and serverLabel.");
    }
    const authorization = stringValue(p.authorization);
    const allowedTools = stringArray(p.allowedTools ?? p.allowed_tools);
    const headers = stringRecord(p.headers);
    tools.push({
      type: "mcp",
      server_url: serverUrl,
      server_label: serverLabel,
      ...(authorization ? { authorization } : {}),
      ...(allowedTools ? { allowed_tools: allowedTools } : {}),
      ...(headers ? { headers } : {}),
    });
  }

  if (enabledPlanTool(params, "image_generation")) {
    tools.push({
      type: "image_generation",
      ...intentParameters(params, "image_generation"),
    });
  }

  if (!tools.length) return {};
  return {
    tools,
    tool_choice: normalizedToolChoice(params),
    parallel_tool_calls: plan.parallelToolCalls,
    ...(include.length ? { include } : {}),
  };
}

const XAI_HOSTED_ITEM_TO_CAPABILITY: Record<string, ToolCapabilityId> = {
  web_search_call: "web_search",
  x_search_call: "x_search",
  code_interpreter_call: "code_execution",
  file_search_call: "file_search",
  mcp_call: "remote_mcp",
  image_generation_call: "image_generation",
};

function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function annotationCitations(annotations: unknown): CitationRef[] {
  if (!Array.isArray(annotations)) return [];
  return annotations.flatMap((annotation) => {
    if (!annotation || typeof annotation !== "object") return [];
    const item = annotation as Record<string, unknown>;
    const url = stringValue(item.url);
    if (!url) return [];
    const title = stringValue(item.title);
    return [
      {
        url,
        ...(title ? { title } : {}),
        ...(typeof item.start_index === "number" ||
        typeof item.end_index === "number"
          ? {
              sourceSpan: {
                ...(typeof item.start_index === "number"
                  ? { start: item.start_index }
                  : {}),
                ...(typeof item.end_index === "number"
                  ? { end: item.end_index }
                  : {}),
              },
            }
          : {}),
        providerData: {
          ...(stringValue(item.type) ? { type: item.type } : {}),
        },
      },
    ];
  });
}

function sourceCitations(item: Record<string, unknown> | undefined): CitationRef[] {
  const action =
    item?.action && typeof item.action === "object"
      ? (item.action as Record<string, unknown>)
      : undefined;
  const sources = Array.isArray(action?.sources) ? action.sources : [];
  return sources.flatMap((source) => {
    if (!source || typeof source !== "object") return [];
    const record = source as Record<string, unknown>;
    const url = stringValue(record.url);
    if (!url) return [];
    return [
      {
        url,
        ...(stringValue(record.title)
          ? { title: stringValue(record.title) }
          : {}),
        providerData: { ...record },
      },
    ];
  });
}

async function normalizeXAIHostedEvent(
  raw: Record<string, unknown>,
  artifactSink?: ProviderArtifactSink,
): Promise<ProviderToolEvent | undefined> {
  const rawType = stringValue(raw.type);
  const item =
    raw.item && typeof raw.item === "object"
      ? (raw.item as Record<string, unknown>)
      : undefined;
  const itemType = item ? stringValue(item.type) : undefined;
  const capability = itemType
    ? XAI_HOSTED_ITEM_TO_CAPABILITY[itemType]
    : undefined;

  if (capability && rawType === "response.output_item.added") {
    return normalizeProviderToolEvent({
      id: stringValue(item?.id) ?? stringValue(raw.item_id),
      tool: capability,
      phase: "started",
      providerManaged: true,
      rawType,
    });
  }

  if (capability && rawType === "response.output_item.done") {
    const imageResult =
      capability === "image_generation" ? stringValue(item?.result) : undefined;
    const citations = sourceCitations(item);
    return normalizeProviderToolEvent(
      {
        id: stringValue(item?.id) ?? stringValue(raw.item_id),
        tool: capability,
        phase: item?.status === "failed" ? "failed" : "completed",
        providerManaged: true,
        rawType,
        ...(citations.length ? { citations } : {}),
        ...(imageResult
          ? {
              artifactPayloads: [
                {
                  id: stringValue(item?.id),
                  bytes: decodeBase64Bytes(imageResult),
                  mimeType: "image/png",
                  filename: `${stringValue(item?.id) ?? "xai-image"}.png`,
                },
              ],
            }
          : {}),
      },
      artifactSink,
    );
  }

  if (rawType === "response.output_text.done") {
    const citations = annotationCitations(raw.annotations);
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

export async function* streamXAIResponses(
  client: OpenAI,
  params: ChatParams,
): AsyncIterable<StreamChunk> {
  const instructions = params.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const caps =
    params.capabilities ??
    MODEL_CATALOG.find(
      (model) => model.providerId === "xai" && model.id === params.model,
    )?.capabilities ?? {
      image: false,
      document: false,
      audio: false,
      video: false,
    };
  const input = buildOpenAIResponsesInput(params, caps);
  const reasoningValue = xAIReasoningEffort(
    params.model,
    params.reasoningEffort ?? "default",
  );
  const structuredOutputField = openAIResponsesTextFormatField(
    params.structuredOutput,
  );
  const toolField = xAIResponsesToolField(params);

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

    const stream = (await client.responses.create(
      {
        model: params.model,
        ...(instructions ? { instructions } : {}),
        input: input as never,
        store: false,
        ...(params.maxTokens != null
          ? { max_output_tokens: params.maxTokens }
          : {}),
        ...(params.temperature != null
          ? { temperature: params.temperature }
          : {}),
        ...(reasoningValue
          ? { reasoning: { effort: reasoningValue } as never }
          : {}),
        ...(structuredOutputField as Record<string, never>),
        ...(toolField as Record<string, never>),
        stream: true,
      } as never,
      { signal: params.signal },
    )) as unknown as AsyncIterable<unknown>;

    for await (const event of stream) {
      const raw = event as Record<string, unknown>;
      const rawType = stringValue(raw.type);
      const item =
        raw.item && typeof raw.item === "object"
          ? (raw.item as Record<string, unknown>)
          : undefined;

      const providerToolEvent = await normalizeXAIHostedEvent(
        raw,
        params.artifactSink,
      );
      if (providerToolEvent) {
        yield { type: "provider_tool_event", providerToolEvent };
      }

      const response =
        raw.response && typeof raw.response === "object"
          ? (raw.response as Record<string, unknown>)
          : undefined;
      const usage =
        response?.usage && typeof response.usage === "object"
          ? (response.usage as Record<string, unknown>)
          : undefined;
      if (usage) {
        if (typeof usage.input_tokens === "number") {
          reportedInputTokens = usage.input_tokens;
        }
        if (typeof usage.output_tokens === "number") {
          reportedOutputTokens = usage.output_tokens;
        }
        if (typeof usage.total_tokens === "number") {
          reportedTotalTokens = usage.total_tokens;
        }
        const inputDetails =
          usage.input_tokens_details && typeof usage.input_tokens_details === "object"
            ? (usage.input_tokens_details as Record<string, unknown>)
            : undefined;
        const outputDetails =
          usage.output_tokens_details && typeof usage.output_tokens_details === "object"
            ? (usage.output_tokens_details as Record<string, unknown>)
            : undefined;
        if (typeof inputDetails?.cached_tokens === "number") {
          reportedCachedInputTokens = inputDetails.cached_tokens;
        }
        if (typeof outputDetails?.reasoning_tokens === "number") {
          reportedReasoningTokens = outputDetails.reasoning_tokens;
        }
      }

      if (rawType === "response.output_text.delta") {
        const delta = stringValue(raw.delta);
        if (delta) yield { type: "token", content: delta };
      } else if (rawType === "response.failed") {
        const error =
          response?.error && typeof response.error === "object"
            ? (response.error as Record<string, unknown>)
            : undefined;
        yield {
          type: "error",
          error: stringValue(error?.message) ?? "xAI responses request failed",
        };
        return;
      } else if (
        (rawType === "response.output_item.added" ||
          rawType === "response.output_item.done") &&
        item?.type === "function_call"
      ) {
        const id =
          stringValue(item.call_id) ??
          stringValue(item.id) ??
          stringValue(raw.item_id) ??
          String(raw.output_index ?? pendingToolCalls.size);
        const current =
          pendingToolCalls.get(id) ??
          ({ id, name: "", argumentsJson: "" } satisfies NativeToolCall & {
            argumentsJson: string;
          });
        current.name = stringValue(item.name) ?? current.name;
        if (typeof item.arguments === "string") {
          current.argumentsJson = item.arguments;
        }
        pendingToolCalls.set(id, current);
      } else if (
        rawType === "response.function_call_arguments.delta" &&
        typeof raw.delta === "string"
      ) {
        const id =
          stringValue(raw.item_id) ??
          String(raw.output_index ?? pendingToolCalls.size);
        const current =
          pendingToolCalls.get(id) ??
          ({ id, name: "", argumentsJson: "" } satisfies NativeToolCall & {
            argumentsJson: string;
          });
        current.argumentsJson += raw.delta;
        pendingToolCalls.set(id, current);
      } else if (
        rawType === "response.function_call_arguments.done" &&
        typeof raw.arguments === "string"
      ) {
        const id =
          stringValue(raw.item_id) ??
          String(raw.output_index ?? pendingToolCalls.size);
        const current =
          pendingToolCalls.get(id) ??
          ({ id, name: "", argumentsJson: "" } satisfies NativeToolCall & {
            argumentsJson: string;
          });
        current.argumentsJson = raw.arguments;
        pendingToolCalls.set(id, current);
      }
    }

    for (const toolCall of pendingToolCalls.values()) {
      if (toolCall.name) yield { type: "tool_call", toolCall };
    }
    if (
      reportedInputTokens != null ||
      reportedOutputTokens != null ||
      reportedTotalTokens != null ||
      reportedReasoningTokens != null ||
      reportedCachedInputTokens != null
    ) {
      yield {
        type: "usage",
        usage: {
          inputTokens: reportedInputTokens,
          outputTokens: reportedOutputTokens,
          totalTokens: reportedTotalTokens,
          reasoningTokens: reportedReasoningTokens,
          cachedInputTokens: reportedCachedInputTokens,
        },
      };
    }
    yield { type: "done" };
  } catch (error) {
    yield {
      type: "error",
      error: error instanceof Error ? error.message : "xAI request failed",
      errorMetadata: safeProviderErrorMetadata(error),
    };
  }
}

export const xaiProvider: AIProvider = {
  id: "xai",
  name: "xAI",

  listModels() {
    return getCatalogModelsForProvider("xai").map(
      ({ validationCandidate, ...model }) => model,
    );
  },

  async validateApiKey(apiKey: string) {
    try {
      const client = createXAIClient(apiKey);
      await client.models.list();
      return true;
    } catch {
      return false;
    }
  },

  async *streamChat(params: ChatParams) {
    const client = createXAIClient(
      params.apiKey,
      params.disableAutomaticRetries,
    );
    yield* streamXAIResponses(client, params);
  },
};
