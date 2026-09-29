import type { AttachmentPayload } from "../attachments/types";
import { buildAttachmentPromptSection } from "../attachments/prompt-text";
import type { ChatParams, NativeToolCall, StreamChunk } from "./base";
import { safeProviderErrorMetadata } from "./base";
import { getModelCapabilities } from "./capabilities";
import type {
  ClientExecutionEnvironmentKind,
  ClientExecutionToolCall,
} from "./client-execution";
import { formatModelId } from "./base";
import {
  normalizeProviderToolEvent,
  type ProviderToolEvent,
} from "./provider-events";
import { geminiThinkingConfig } from "./reasoning";
import type { ToolCapabilityId } from "./tool-capabilities";

interface GoogleInteractionsClient {
  interactions: {
    create(
      request: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<AsyncIterable<unknown>>;
  };
}

function toolEnabled(params: ChatParams, id: ToolCapabilityId): boolean {
  return params.callPlan?.enabledTools.some((tool) => tool.intent.id === id) === true;
}

function toolParameters(
  params: ChatParams,
  id: ToolCapabilityId,
): Record<string, unknown> {
  return (
    params.callPlan?.enabledTools.find((tool) => tool.intent.id === id)?.intent
      .parameters ?? {}
  );
}

function stringParam(
  parameters: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = parameters[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function numberParam(
  parameters: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = parameters[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function booleanParam(
  parameters: Record<string, unknown>,
  ...keys: string[]
): boolean | undefined {
  for (const key of keys) {
    const value = parameters[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function stringArrayParam(
  parameters: Record<string, unknown>,
  ...keys: string[]
): string[] | undefined {
  for (const key of keys) {
    const value = parameters[key];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return [...value];
    }
  }
  return undefined;
}

function recordParam(
  parameters: Record<string, unknown>,
  ...keys: string[]
): Record<string, string> | undefined {
  for (const key of keys) {
    const value = parameters[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value as Record<string, unknown>).every(
        (item) => typeof item === "string",
      )
    ) {
      return { ...(value as Record<string, string>) };
    }
  }
  return undefined;
}

function googleInteractionToolChoice(params: ChatParams): unknown {
  const plan = params.callPlan;
  if (!plan) return "auto";
  if (typeof plan.toolChoice === "object") {
    return {
      allowed_tools: {
        mode: "any",
        tools: [plan.toolChoice.name],
      },
    };
  }
  if (plan.toolChoice === "required") return "any";
  if (plan.toolChoice === "none") return "none";

  const hasClientFunctions = toolEnabled(params, "function_calling");
  const hasBuiltInTools =
    plan.enabledTools.some(
      (tool) => tool.descriptor.execution === "provider",
    ) || toolEnabled(params, "computer_use");
  return hasClientFunctions && hasBuiltInTools ? "validated" : "auto";
}

export function googleInteractionsToolField(params: ChatParams): {
  tools: Array<Record<string, unknown>>;
  toolChoice: unknown;
} {
  const tools: Array<Record<string, unknown>> = [];

  if (toolEnabled(params, "function_calling")) {
    for (const tool of params.nativeTools ?? []) {
      tools.push({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      });
    }
  }

  if (toolEnabled(params, "web_search")) {
    const parameters = toolParameters(params, "web_search");
    const searchTypes = stringArrayParam(parameters, "searchTypes", "search_types");
    tools.push({
      type: "google_search",
      ...(searchTypes ? { search_types: searchTypes } : {}),
    });
  }

  if (toolEnabled(params, "url_context")) {
    tools.push({ type: "url_context" });
  }

  if (toolEnabled(params, "file_search")) {
    const parameters = toolParameters(params, "file_search");
    const storeNames = stringArrayParam(
      parameters,
      "fileSearchStoreNames",
      "file_search_store_names",
      "storeNames",
    );
    const topK = numberParam(parameters, "topK", "top_k");
    const metadataFilter = stringParam(
      parameters,
      "metadataFilter",
      "metadata_filter",
    );
    tools.push({
      type: "file_search",
      ...(storeNames ? { file_search_store_names: storeNames } : {}),
      ...(topK !== undefined ? { top_k: topK } : {}),
      ...(metadataFilter ? { metadata_filter: metadataFilter } : {}),
    });
  }

  if (toolEnabled(params, "maps")) {
    const parameters = toolParameters(params, "maps");
    const latitude = numberParam(parameters, "latitude");
    const longitude = numberParam(parameters, "longitude");
    const enableWidget = booleanParam(parameters, "enableWidget", "enable_widget");
    tools.push({
      type: "google_maps",
      ...(latitude !== undefined ? { latitude } : {}),
      ...(longitude !== undefined ? { longitude } : {}),
      ...(enableWidget !== undefined ? { enable_widget: enableWidget } : {}),
    });
  }

  if (toolEnabled(params, "code_execution")) {
    tools.push({ type: "code_execution" });
  }

  if (toolEnabled(params, "remote_mcp")) {
    const parameters = toolParameters(params, "remote_mcp");
    const name = stringParam(parameters, "serverName", "server_name", "name");
    const url = stringParam(parameters, "serverUrl", "server_url", "url");
    if (!name || !url) {
      throw new Error("Gemini Remote MCP requires serverName and serverUrl.");
    }
    const headers = recordParam(parameters, "headers");
    tools.push({
      type: "mcp_server",
      name,
      url,
      ...(headers ? { headers } : {}),
    });
  }

  if (toolEnabled(params, "computer_use")) {
    const parameters = toolParameters(params, "computer_use");
    const environment =
      stringParam(parameters, "environment") ?? "browser";
    const enablePromptInjectionDetection = booleanParam(
      parameters,
      "enablePromptInjectionDetection",
      "enable_prompt_injection_detection",
    );
    tools.push({
      type: "computer_use",
      environment,
      ...(enablePromptInjectionDetection !== undefined
        ? { enable_prompt_injection_detection: enablePromptInjectionDetection }
        : {}),
    });
  }

  return {
    tools,
    toolChoice: googleInteractionToolChoice(params),
  };
}

function interactionContentForAttachment(
  file: AttachmentPayload,
  caps: ReturnType<typeof getModelCapabilities>,
): Record<string, unknown> | undefined {
  if (!file.base64Data) return undefined;
  if (file.category === "image" && caps.image) {
    return { type: "image", data: file.base64Data, mime_type: file.mimeType };
  }
  if (file.category === "document" && caps.document) {
    return { type: "document", data: file.base64Data, mime_type: file.mimeType };
  }
  if (file.category === "audio" && caps.audio) {
    return { type: "audio", data: file.base64Data, mime_type: file.mimeType };
  }
  if (file.category === "video" && caps.video) {
    return { type: "video", data: file.base64Data, mime_type: file.mimeType };
  }
  return undefined;
}

function googleInteractionsInput(params: ChatParams): Array<Record<string, unknown>> {
  const caps =
    params.capabilities ??
    getModelCapabilities(formatModelId("google", params.model));
  const messages = params.messages.filter((message) => message.role !== "system");
  const lastUserIndex = messages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0)
    .at(-1);

  return messages.map((message, index) => {
    const content: Array<Record<string, unknown>> = [
      {
        type: "text",
        text:
          message.content +
          (message.role === "user" && index === lastUserIndex
            ? buildAttachmentPromptSection(params.attachments ?? [])
            : ""),
      },
    ];
    if (message.role === "user" && index === lastUserIndex) {
      for (const attachment of params.attachments ?? []) {
        const block = interactionContentForAttachment(attachment, caps);
        if (block) content.unshift(block);
      }
    }
    return {
      role: message.role === "assistant" ? "model" : "user",
      content,
    };
  });
}

function interactionGenerationConfig(params: ChatParams, toolChoice: unknown) {
  const thinking = geminiThinkingConfig(
    params.model,
    params.reasoningEffort ?? "default",
    params.maxTokens ?? 1500,
  ) as Record<string, unknown> | null;
  const thinkingLevel =
    typeof thinking?.thinkingLevel === "string"
      ? thinking.thinkingLevel.toLowerCase()
      : undefined;
  return {
    max_output_tokens: params.maxTokens ?? 1500,
    ...(!["gemini-3.6-flash", "gemini-3.8-flash"].includes(
      params.model.trim().toLowerCase(),
    ) && params.temperature !== undefined
      ? { temperature: params.temperature }
      : {}),
    ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
    tool_choice: toolChoice,
  };
}

const HOSTED_CALL_STEPS: Record<string, ToolCapabilityId> = {
  google_search_call: "web_search",
  url_context_call: "url_context",
  file_search_call: "file_search",
  google_maps_call: "maps",
  code_execution_call: "code_execution",
  mcp_server_tool_call: "remote_mcp",
};

const HOSTED_RESULT_STEPS: Record<string, ToolCapabilityId> = {
  google_search_result: "web_search",
  url_context_result: "url_context",
  file_search_result: "file_search",
  google_maps_result: "maps",
  code_execution_result: "code_execution",
  mcp_server_tool_result: "remote_mcp",
};

async function googleHostedStepEvent(
  step: Record<string, unknown>,
): Promise<ProviderToolEvent | undefined> {
  const type = typeof step.type === "string" ? step.type : undefined;
  if (!type) return undefined;
  const callCapability = HOSTED_CALL_STEPS[type];
  if (callCapability) {
    return normalizeProviderToolEvent({
      id: typeof step.id === "string" ? step.id : undefined,
      tool: callCapability,
      phase: "started",
      providerManaged: true,
      rawType: type,
    });
  }
  const resultCapability = HOSTED_RESULT_STEPS[type];
  if (resultCapability) {
    return normalizeProviderToolEvent({
      id:
        typeof step.call_id === "string"
          ? step.call_id
          : typeof step.id === "string"
            ? step.id
            : undefined,
      tool: resultCapability,
      phase: step.is_error === true ? "failed" : "completed",
      providerManaged: true,
      rawType: type,
    });
  }
  return undefined;
}

function computerEnvironment(params: ChatParams): ClientExecutionEnvironmentKind {
  const value = stringParam(toolParameters(params, "computer_use"), "environment");
  return value === "desktop" || value === "mobile" || value === "browser"
    ? value
    : "browser";
}

function interactionFunctionCall(
  step: Record<string, unknown>,
  params: ChatParams,
): NativeToolCall | ClientExecutionToolCall | undefined {
  if (step.type !== "function_call" || typeof step.name !== "string") {
    return undefined;
  }
  const args =
    step.arguments && typeof step.arguments === "object"
      ? ({ ...(step.arguments as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  const nativeNames = new Set((params.nativeTools ?? []).map((tool) => tool.name));
  if (toolEnabled(params, "computer_use") && !nativeNames.has(step.name)) {
    const intent = typeof args.intent === "string" ? args.intent : undefined;
    return {
      id: typeof step.id === "string" ? step.id : undefined,
      name: step.name,
      arguments: args,
      argumentsJson: JSON.stringify(args),
      clientExecution: {
        capabilityId: "computer_use",
        environment: computerEnvironment(params),
        action: {
          name: step.name,
          arguments: args,
          ...(intent ? { intent } : {}),
        },
        requiresNextScreenshot: true,
      },
    };
  }
  return {
    id: typeof step.id === "string" ? step.id : undefined,
    name: step.name,
    arguments: args,
    argumentsJson: JSON.stringify(args),
  };
}

function captureUsage(usage: unknown): StreamChunk["usage"] | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const inputTokens =
    typeof record.total_input_tokens === "number"
      ? record.total_input_tokens
      : undefined;
  const outputTokens =
    typeof record.total_output_tokens === "number"
      ? record.total_output_tokens
      : undefined;
  const cachedInputTokens =
    typeof record.total_cached_tokens === "number"
      ? record.total_cached_tokens
      : undefined;
  const reasoningTokens =
    typeof record.total_thought_tokens === "number"
      ? record.total_thought_tokens
      : undefined;
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens !== undefined && outputTokens !== undefined
        ? inputTokens + outputTokens
        : undefined,
    cachedInputTokens,
    reasoningTokens,
  };
}

export async function* streamGoogleInteractions(
  client: GoogleInteractionsClient,
  params: ChatParams,
): AsyncIterable<StreamChunk> {
  try {
    const toolField = googleInteractionsToolField(params);
    const systemInstruction = params.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const stream = await client.interactions.create(
      {
        model: params.model,
        input: googleInteractionsInput(params),
        stream: true,
        store: false,
        ...(systemInstruction ? { system_instruction: systemInstruction } : {}),
        ...(toolField.tools.length > 0 ? { tools: toolField.tools } : {}),
        generation_config: interactionGenerationConfig(
          params,
          toolField.toolChoice,
        ),
        ...(params.structuredOutput
          ? {
              response_format: {
                type: "text",
                mime_type: "application/json",
                schema: params.structuredOutput.schema,
              },
            }
          : {}),
      },
      params.signal ? { fetchOptions: { signal: params.signal } } : undefined,
    );

    let completed = false;
    for await (const rawEvent of stream) {
      const event = rawEvent as Record<string, unknown>;
      const eventType = event.event_type;
      if (eventType === "step.start") {
        const step =
          event.step && typeof event.step === "object"
            ? (event.step as Record<string, unknown>)
            : undefined;
        if (!step) continue;
        const providerEvent = await googleHostedStepEvent(step);
        if (providerEvent) {
          yield { type: "provider_tool_event", providerToolEvent: providerEvent };
          continue;
        }
        const toolCall = interactionFunctionCall(step, params);
        if (toolCall) yield { type: "tool_call", toolCall };
      } else if (eventType === "step.delta") {
        const delta =
          event.delta && typeof event.delta === "object"
            ? (event.delta as Record<string, unknown>)
            : undefined;
        if (delta?.type === "text" && typeof delta.text === "string") {
          yield { type: "token", content: delta.text };
        }
      } else if (eventType === "interaction.completed") {
        const interaction =
          event.interaction && typeof event.interaction === "object"
            ? (event.interaction as Record<string, unknown>)
            : undefined;
        const usage = captureUsage(interaction?.usage);
        if (usage) yield { type: "usage", usage };
        completed = true;
        yield { type: "done" };
      } else if (eventType === "error") {
        const error =
          event.error && typeof event.error === "object"
            ? (event.error as Record<string, unknown>)
            : undefined;
        yield {
          type: "error",
          error:
            typeof error?.message === "string"
              ? error.message
              : "Google Interactions request failed",
        };
        return;
      }
    }
    if (!completed) yield { type: "done" };
  } catch (error) {
    yield {
      type: "error",
      error:
        error instanceof Error
          ? error.message
          : "Google Interactions request failed",
      errorMetadata: safeProviderErrorMetadata(error),
    };
  }
}
