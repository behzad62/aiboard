import type {
  AgentMessage,
  AgentModel,
  AgentModelRequest,
  AssistantBlock,
  ModelTurn,
  ToolDefinition,
  ToolResult,
} from "./agent-contracts.js";

export interface AccountRunnerModelOptions {
  baseUrl: string;
  runnerPath: string;
  runnerToken: string;
  modelId: string;
  providerApiKey?: string;
  reasoningEffort?: string;
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
        body: JSON.stringify({
          ...(this.options.providerApiKey
            ? { apiKey: this.options.providerApiKey }
            : {}),
          model: this.options.modelId,
          messages: request.messages.map(toRunnerMessage),
          nativeTools: request.tools.map(toRunnerTool),
          reasoningEffort: this.options.reasoningEffort,
          attachments: [],
          sessionId: request.sessionId,
          stream: true,
        }),
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
      return {
        blocks: data.content ? [{ type: "text", text: data.content }] : [],
        stopReason: "end_turn",
      };
    }

    const blocks: AssistantBlock[] = [];
    let text = "";
    let usage: ModelTurn["usage"];
    let toolIndex = 0;
    for await (const event of readSse(response)) {
      if (event.type === "token" && event.content) {
        text += event.content;
      } else if (event.type === "tool_call" && event.toolCall?.name) {
        if (text) {
          blocks.push({ type: "text", text });
          text = "";
        }
        toolIndex += 1;
        blocks.push({
          type: "tool_call",
          callId: event.toolCall.id ?? `tool_${toolIndex}`,
          name: event.toolCall.name,
          arguments: toolArguments(event.toolCall),
        });
      } else if (event.type === "usage" && event.usage) {
        usage = {
          ...(event.usage.inputTokens !== undefined
            ? { inputTokens: event.usage.inputTokens }
            : {}),
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
    if (text) blocks.push({ type: "text", text });
    return {
      blocks,
      stopReason: blocks.some((block) => block.type === "tool_call")
        ? "tool_calls"
        : "end_turn",
      ...(usage ? { usage } : {}),
    };
  }
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

function toRunnerTool(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  };
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
