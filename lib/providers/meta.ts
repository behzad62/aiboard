import OpenAI from "openai";
import type {
  AIProvider,
  ChatParams,
  NativeToolCall,
  StreamChunk,
} from "./base";
import { safeProviderErrorMetadata } from "./base";
import { getCatalogModelsForProvider } from "./catalog";
import { buildOpenAIResponsesInput } from "./openai";
import { streamOpenAICompatibleChat } from "./openai-compat";
import { openAIResponsesTextFormatField } from "./structured-output";
import {
  normalizeProviderToolEvent,
  type CitationRef,
  type ProviderToolEvent,
} from "./provider-events";
import type { ToolCapabilityId } from "./tool-capabilities";

export const META_MODEL_API_BASE_URL = "https://api.meta.ai/v1";

function createMetaClient(apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: META_MODEL_API_BASE_URL,
    dangerouslyAllowBrowser: true,
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

function metaReasoningEffort(
  effort: ChatParams["reasoningEffort"],
): string | undefined {
  if (!effort || effort === "default") return undefined;
  return effort;
}

export function metaResponsesToolField(params: ChatParams): {
  tools?: Array<Record<string, unknown>>;
  tool_choice?: "auto";
  parallel_tool_calls?: boolean;
} {
  const plan = params.callPlan;
  if (!plan || plan.transport !== "responses") return {};

  const tools: Array<Record<string, unknown>> = [];
  const toolSearchEnabled = enabledPlanTool(params, "tool_search");
  let deferredFunctionCount = 0;

  if (enabledPlanTool(params, "function_calling")) {
    for (const tool of params.nativeTools ?? []) {
      const deferred = toolSearchEnabled && tool.deferLoading === true;
      if (deferred) deferredFunctionCount++;
      tools.push({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: tool.strict ?? false,
        ...(deferred ? { defer_loading: true } : {}),
      });
    }
  }

  if (enabledPlanTool(params, "web_search")) {
    const parameters = intentParameters(params, "web_search");
    const contextSize = stringValue(
      parameters.searchContextSize ?? parameters.search_context_size,
    );
    tools.push({
      type: "web_search",
      ...(contextSize ? { search_context_size: contextSize } : {}),
    });
  }

  if (toolSearchEnabled) {
    if (deferredFunctionCount === 0) {
      throw new Error(
        "Meta tool_search requires at least one function tool with deferLoading enabled.",
      );
    }
    tools.push({ type: "tool_search" });
  }

  if (!tools.length) return {};
  if (plan.toolChoice !== "auto") {
    throw new Error("Meta Model API supports only tool_choice=auto.");
  }
  return {
    tools,
    tool_choice: "auto",
    parallel_tool_calls: plan.parallelToolCalls,
  };
}

const META_HOSTED_ITEM_TO_CAPABILITY: Record<string, ToolCapabilityId> = {
  web_search_call: "web_search",
  tool_search_call: "tool_search",
  tool_search_output: "tool_search",
};

function citationRefs(annotations: unknown): CitationRef[] {
  if (!Array.isArray(annotations)) return [];
  return annotations.flatMap((annotation) => {
    if (!annotation || typeof annotation !== "object") return [];
    const item = annotation as Record<string, unknown>;
    const url = stringValue(item.url);
    if (!url) return [];
    const title = stringValue(item.title);
    const hasSpan =
      typeof item.start_index === "number" || typeof item.end_index === "number";
    return [
      {
        url,
        ...(title ? { title } : {}),
        ...(hasSpan
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

async function normalizeMetaHostedEvent(
  raw: Record<string, unknown>,
): Promise<ProviderToolEvent | undefined> {
  const rawType = stringValue(raw.type);
  const item =
    raw.item && typeof raw.item === "object"
      ? (raw.item as Record<string, unknown>)
      : undefined;
  const itemType = item ? stringValue(item.type) : undefined;
  const capability = itemType
    ? META_HOSTED_ITEM_TO_CAPABILITY[itemType]
    : undefined;

  if (
    capability &&
    (rawType === "response.output_item.added" ||
      rawType === "response.output_item.done")
  ) {
    return normalizeProviderToolEvent({
      id: stringValue(item?.id) ?? stringValue(raw.item_id),
      tool: capability,
      phase:
        rawType === "response.output_item.added"
          ? "started"
          : item?.status === "failed"
            ? "failed"
            : "completed",
      providerManaged: true,
      rawType,
    });
  }

  if (rawType === "response.output_text.done") {
    const citations = citationRefs(raw.annotations);
    if (citations.length) {
      return normalizeProviderToolEvent({
        tool: "web_search",
        phase: "completed",
        providerManaged: true,
        citations,
        rawType,
      });
    }
  }

  return undefined;
}

export async function* streamMetaResponses(
  client: OpenAI,
  params: ChatParams,
): AsyncIterable<StreamChunk> {
  const caps =
    params.capabilities ??
    getCatalogModelsForProvider("meta").find((model) => model.id === params.model)
      ?.capabilities ?? {
      image: false,
      document: false,
      audio: false,
      video: false,
    };
  const instructions = params.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const input = buildOpenAIResponsesInput(params, caps);
  const toolField = metaResponsesToolField(params);
  const structuredOutputField = openAIResponsesTextFormatField(
    params.structuredOutput,
  );
  const reasoningEffort = metaReasoningEffort(params.reasoningEffort);

  try {
    const stream = (await client.responses.create(
      {
        model: params.model,
        ...(instructions ? { instructions } : {}),
        input: input as never,
        ...(params.maxTokens != null
          ? { max_output_tokens: params.maxTokens }
          : {}),
        ...(params.temperature != null ? { temperature: params.temperature } : {}),
        ...(reasoningEffort
          ? { reasoning: { effort: reasoningEffort } as never }
          : {}),
        ...(structuredOutputField as Record<string, never>),
        ...(toolField as Record<string, never>),
        stream: true,
      } as never,
      { signal: params.signal },
    )) as unknown as AsyncIterable<unknown>;

    const pendingToolCalls = new Map<
      string,
      NativeToolCall & { argumentsJson: string }
    >();
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let totalTokens: number | undefined;
    let reasoningTokens: number | undefined;

    for await (const event of stream) {
      const raw = event as Record<string, unknown>;
      const rawType = stringValue(raw.type);
      const item =
        raw.item && typeof raw.item === "object"
          ? (raw.item as Record<string, unknown>)
          : undefined;

      const providerToolEvent = await normalizeMetaHostedEvent(raw);
      if (providerToolEvent) {
        yield { type: "provider_tool_event", providerToolEvent };
      }

      if (rawType === "response.output_text.delta") {
        const delta = stringValue(raw.delta);
        if (delta) yield { type: "token", content: delta };
      } else if (rawType === "response.failed") {
        const response =
          raw.response && typeof raw.response === "object"
            ? (raw.response as Record<string, unknown>)
            : undefined;
        const failure =
          response?.error && typeof response.error === "object"
            ? (response.error as Record<string, unknown>)
            : undefined;
        yield {
          type: "error",
          error:
            stringValue(failure?.message) ??
            "Meta Model API Responses request failed",
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
          ({
            id,
            name: "",
            argumentsJson: "",
          } satisfies NativeToolCall & { argumentsJson: string });
        current.name = stringValue(item.name) ?? current.name;
        if (typeof item.arguments === "string") {
          current.argumentsJson = item.arguments;
        }
        pendingToolCalls.set(id, current);
      } else if (rawType === "response.function_call_arguments.delta") {
        const id =
          stringValue(raw.item_id) ??
          String(raw.output_index ?? pendingToolCalls.size);
        const current =
          pendingToolCalls.get(id) ??
          ({
            id,
            name: stringValue(raw.name) ?? "",
            argumentsJson: "",
          } satisfies NativeToolCall & { argumentsJson: string });
        if (typeof raw.delta === "string") current.argumentsJson += raw.delta;
        pendingToolCalls.set(id, current);
      } else if (rawType === "response.function_call_arguments.done") {
        const id =
          stringValue(raw.item_id) ??
          String(raw.output_index ?? pendingToolCalls.size);
        const current =
          pendingToolCalls.get(id) ??
          ({
            id,
            name: stringValue(raw.name) ?? "",
            argumentsJson: "",
          } satisfies NativeToolCall & { argumentsJson: string });
        if (typeof raw.arguments === "string") {
          current.argumentsJson = raw.arguments;
        }
        pendingToolCalls.set(id, current);
      }

      if (rawType === "response.completed") {
        const response =
          raw.response && typeof raw.response === "object"
            ? (raw.response as Record<string, unknown>)
            : undefined;
        const usage =
          response?.usage && typeof response.usage === "object"
            ? (response.usage as Record<string, unknown>)
            : undefined;
        if (usage) {
          inputTokens =
            typeof usage.input_tokens === "number" ? usage.input_tokens : inputTokens;
          outputTokens =
            typeof usage.output_tokens === "number" ? usage.output_tokens : outputTokens;
          totalTokens =
            typeof usage.total_tokens === "number" ? usage.total_tokens : totalTokens;
          const details =
            usage.output_tokens_details &&
            typeof usage.output_tokens_details === "object"
              ? (usage.output_tokens_details as Record<string, unknown>)
              : undefined;
          reasoningTokens =
            typeof details?.reasoning_tokens === "number"
              ? details.reasoning_tokens
              : reasoningTokens;
        }
      }
    }

    for (const toolCall of pendingToolCalls.values()) {
      if (toolCall.name) yield { type: "tool_call", toolCall };
    }
    if (
      inputTokens != null ||
      outputTokens != null ||
      totalTokens != null ||
      reasoningTokens != null
    ) {
      yield {
        type: "usage",
        usage: {
          inputTokens,
          outputTokens,
          totalTokens,
          reasoningTokens,
        },
      };
    }
    yield { type: "done" };
  } catch (error) {
    yield {
      type: "error",
      error:
        error instanceof Error
          ? error.message
          : "Meta Model API Responses request failed",
      errorMetadata: safeProviderErrorMetadata(error),
    };
  }
}

export async function* streamMetaByPlan(
  client: OpenAI,
  params: ChatParams,
): AsyncIterable<StreamChunk> {
  const transport = params.callPlan?.transport ?? "responses";
  if (transport === "responses") {
    yield* streamMetaResponses(client, params);
    return;
  }
  if (transport === "chat_completions") {
    yield* streamOpenAICompatibleChat(
      client,
      params,
      "custom",
      "Meta Model API",
      "max_completion_tokens",
    );
    return;
  }
  yield {
    type: "error",
    error: `Meta Model API transport ${transport} is not supported by this adapter.`,
  };
}

export const metaProvider: AIProvider = {
  id: "meta",
  name: "Meta Model API",

  listModels() {
    return getCatalogModelsForProvider("meta").map(
      ({ validationCandidate, ...model }) => model,
    );
  },

  async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      const response = await fetch(`${META_MODEL_API_BASE_URL}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  },

  async *streamChat(params: ChatParams): AsyncIterable<StreamChunk> {
    yield* streamMetaByPlan(createMetaClient(params.apiKey), params);
  },
};
