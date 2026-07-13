import type {
  AgentMessage,
  AgentModel,
  AgentModelRequest,
  AssistantBlock,
  ModelTurn,
  ToolDefinition,
  ToolResult,
} from "./agent-contracts.js";
import { serializedInputUsage } from "./provider-model-utils.js";

export interface AccountRunnerModelOptions {
  baseUrl: string;
  runnerPath: string;
  runnerToken: string;
  modelId: string;
  providerApiKey?: string;
  reasoningEffort?: string;
  inputCapabilities?: {
    image: boolean;
    document: boolean;
    audio: boolean;
    video: boolean;
  };
  readArtifact?: (hash: string) => Promise<Buffer>;
  fetch?: typeof globalThis.fetch;
}

export class ProviderTransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "ProviderTransportError";
  }
}

type RunnerEvent =
  | { type: "token"; content?: string }
  | {
      type: "tool_call";
      toolCall?: {
        id?: string;
        name?: string;
        arguments?: Record<string, unknown>;
        argumentsJson?: string;
      };
    }
  | {
      type: "usage";
      usage?: { inputTokens?: number; outputTokens?: number };
    }
  | { type: "error"; error?: string; code?: string }
  | { type: "done" };

export class AccountRunnerModel implements AgentModel {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: AccountRunnerModelOptions) {
    if (!options.baseUrl || !options.runnerPath || !options.runnerToken || !options.modelId) {
      throw new Error("Account runner model configuration is incomplete.");
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    const wireNames = buildWireToolNames(request.tools);
    const attachments = await currentImageAttachments(
      request.messages,
      this.options
    );
    const originalNameFor = new Map(
      [...wireNames].map(([original, wire]) => [wire, original])
    );
    const body = JSON.stringify({
      ...(this.options.providerApiKey
        ? { apiKey: this.options.providerApiKey }
        : {}),
      model: this.options.modelId,
      messages: request.messages.map(toRunnerMessage),
      nativeTools: request.tools.map((tool) =>
        toRunnerTool(tool, wireNames.get(tool.name)!)
      ),
      reasoningEffort: this.options.reasoningEffort,
      attachments,
      sessionId: request.sessionId,
      stream: true,
    });
    const response = await this.fetchImpl(
      `${this.options.baseUrl.replace(/\/$/, "")}/providers/${encodeURIComponent(
        this.options.runnerPath
      )}/chat`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-runner-token": this.options.runnerToken,
        },
        body,
        signal: request.signal,
      }
    );
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as {
        error?: string;
        code?: string;
      };
      throw new ProviderTransportError(
        data.error ?? `Account runner request failed (${response.status}).`,
        response.status,
        data.code,
        retryAfter(response.headers.get("retry-after"))
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      const data = await response.json().catch(() => ({})) as {
        content?: string;
        error?: string;
      };
      if (data.error) throw new ProviderTransportError(data.error, response.status);
      const blocks = data.content
        ? normalizeTextualToolCalls(data.content, wireNames, originalNameFor)
        : [];
      return {
        blocks,
        stopReason: blocks.some((block) => block.type === "tool_call")
          ? "tool_calls"
          : "end_turn",
        usage: serializedInputUsage(body),
      };
    }

    const blocks: AssistantBlock[] = [];
    let text = "";
    let usage: ModelTurn["usage"] = serializedInputUsage(body);
    let toolIndex = 0;
    let sawNativeToolCall = false;
    for await (const event of readSse(response)) {
      if (event.type === "token" && event.content) {
        text += event.content;
      } else if (event.type === "tool_call" && event.toolCall?.name) {
        sawNativeToolCall = true;
        if (text) {
          blocks.push({ type: "text", text });
          text = "";
        }
        toolIndex += 1;
        blocks.push({
          type: "tool_call",
          callId: event.toolCall.id ?? `tool_${toolIndex}`,
          name: originalNameFor.get(event.toolCall.name) ?? event.toolCall.name,
          arguments: toolArguments(event.toolCall),
        });
      } else if (event.type === "usage" && event.usage) {
        usage = {
          ...serializedInputUsage(body, event.usage.inputTokens),
          ...(event.usage.outputTokens !== undefined
            ? { outputTokens: event.usage.outputTokens }
            : {}),
        };
      } else if (event.type === "error") {
        throw new ProviderTransportError(
          event.error ?? "Account runner stream failed.",
          response.status,
          event.code
        );
      }
    }
    if (text) {
      blocks.push(
        ...(sawNativeToolCall
          ? [{ type: "text" as const, text }]
          : normalizeTextualToolCalls(text, wireNames, originalNameFor))
      );
    }
    return {
      blocks,
      stopReason: blocks.some((block) => block.type === "tool_call")
        ? "tool_calls"
        : "end_turn",
      usage,
    };
  }
}

function normalizeTextualToolCalls(
  text: string,
  wireNames: ReadonlyMap<string, string>,
  originalNameFor: ReadonlyMap<string, string>
): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  const textLines: string[] = [];
  const flushText = () => {
    if (textLines.length === 0) return;
    const value = textLines.join("\n");
    if (value) blocks.push({ type: "text", text: value });
    textLines.length = 0;
  };

  for (const line of text.split(/\r?\n/)) {
    const match = /^TOOL_CALL\s+(\{.*\})$/.exec(line);
    if (!match) {
      textLines.push(line);
      continue;
    }
    const record = parseTextualToolCall(match[1]);
    const originalName = record
      ? originalNameFor.get(record.name) ??
        (wireNames.has(record.name) ? record.name : undefined)
      : undefined;
    if (!record || !originalName) {
      textLines.push(line);
      continue;
    }
    flushText();
    blocks.push({
      type: "tool_call",
      callId: record.id,
      name: originalName,
      arguments: record.arguments,
    });
  }
  flushText();
  return blocks;
}

function parseTextualToolCall(value: string): {
  id: string;
  name: string;
  arguments: unknown;
} | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      typeof parsed.id !== "string" ||
      parsed.id.length === 0 ||
      typeof parsed.name !== "string" ||
      parsed.name.length === 0
    ) {
      return undefined;
    }
    return {
      id: parsed.id,
      name: parsed.name,
      arguments: parsed.arguments ?? {},
    };
  } catch {
    return undefined;
  }
}

async function currentImageAttachments(
  messages: readonly AgentMessage[],
  options: Pick<
    AccountRunnerModelOptions,
    "inputCapabilities" | "readArtifact"
  >
): Promise<Array<{
  category: "image";
  filename: string;
  mimeType: string;
  base64Data: string;
}>> {
  if (options.inputCapabilities?.image !== true) return [];
  let latestAssistant = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") {
      latestAssistant = index;
      break;
    }
  }
  const images = new Map<
    string,
    { hash: string; mediaType: string; label?: string }
  >();
  for (const message of messages.slice(latestAssistant + 1)) {
    if (message.role !== "tool" || Array.isArray(message.content)) continue;
    const result = message.content as ToolResult;
    for (const block of result.content ?? []) {
      if (block.type !== "artifact" || !block.mediaType.startsWith("image/")) {
        continue;
      }
      images.set(block.hash, block);
    }
  }
  if (images.size === 0) return [];
  if (!options.readArtifact) {
    throw new Error("Image-capable account runtime has no artifact reader.");
  }
  return await Promise.all(
    [...images.values()].map(async (image) => {
      const bytes = await options.readArtifact!(image.hash);
      return {
        category: "image" as const,
        filename: imageFilename(image.label, image.mediaType, image.hash),
        mimeType: image.mediaType,
        base64Data: bytes.toString("base64"),
      };
    })
  );
}

function imageFilename(
  label: string | undefined,
  mediaType: string,
  hash: string
): string {
  const extension = mediaType === "image/jpeg"
    ? ".jpg"
    : mediaType === "image/webp"
      ? ".webp"
      : ".png";
  const base = label?.trim() || `artifact-${hash.slice(0, 12)}`;
  return base.toLowerCase().endsWith(extension) ? base : `${base}${extension}`;
}

function toRunnerMessage(message: AgentMessage): {
  role: "system" | "user" | "assistant";
  content: string;
} {
  if (message.role === "tool") {
    return {
      role: "user",
      content: `TOOL_RESULT\n${serializeToolResult(message.content as ToolResult)}`,
    };
  }
  if (typeof message.content === "string") {
    return { role: message.role, content: message.content };
  }
  if (Array.isArray(message.content)) {
    return {
      role: message.role,
      content: message.content
      .map((block) =>
        block.type === "text"
          ? block.text
          : `TOOL_CALL ${JSON.stringify({
              id: block.callId,
              name: block.name,
              arguments: block.arguments,
            })}`
      )
      .join("\n"),
    };
  }
  return {
    role: "user",
    content: `TOOL_RESULT\n${serializeToolResult(message.content)}`,
  };
}

function serializeToolResult(result: ToolResult): string {
  return JSON.stringify({
    callId: result.callId,
    toolName: result.toolName,
    isError: result.isError,
    error: result.error,
    content: result.content,
  });
}

function toRunnerTool(tool: ToolDefinition, wireName: string) {
  return {
    name: wireName,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  };
}

function buildWireToolNames(tools: readonly ToolDefinition[]): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<string>();
  for (const tool of tools) {
    const normalized = tool.name
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "tool";
    let candidate = normalized.slice(0, 64);
    let suffix = 2;
    while (used.has(candidate)) {
      const marker = `_${suffix}`;
      candidate = `${normalized.slice(0, 64 - marker.length)}${marker}`;
      suffix += 1;
    }
    used.add(candidate);
    result.set(tool.name, candidate);
  }
  return result;
}

function toolArguments(
  call: NonNullable<Extract<RunnerEvent, { type: "tool_call" }>["toolCall"]>
): unknown {
  if (call.arguments) return call.arguments;
  if (call.argumentsJson) {
    try {
      return JSON.parse(call.argumentsJson) as unknown;
    } catch {
      return { _malformedArgumentsJson: call.argumentsJson };
    }
  }
  return {};
}

async function* readSse(response: Response): AsyncIterable<RunnerEvent> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match) break;
      const index = match.index ?? 0;
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + match[0].length);
      const event = parseSseBlock(block);
      if (event) yield event;
    }
  }
  const tail = parseSseBlock(buffer);
  if (tail) yield tail;
}

function parseSseBlock(block: string): RunnerEvent | undefined {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data) as RunnerEvent;
  } catch {
    return { type: "token", content: data };
  }
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
