import type { AIProvider, ChatParams, ModelInfo, StreamChunk } from "./base";
import { providerSupportsMaxTokensFeature } from "./provider-registry";

export const ACCOUNT_RUNNER_TEXT_ONLY = {
  image: false,
  document: false,
  audio: false,
  video: false,
} as const;

export const ACCOUNT_RUNNER_TEXT_AND_IMAGE_ATTACHMENTS = {
  image: true,
  document: true,
  audio: false,
  video: false,
} as const;

interface AccountRunnerProviderOptions {
  id: string;
  name: string;
  runnerPath: string;
  models: ModelInfo[];
}

interface AccountRunnerResponse {
  ok?: boolean;
  content?: string;
  error?: string;
}

type AccountRunnerEvent =
  | { type: "token"; content?: string }
  | { type: "tool_call"; toolCall?: StreamChunk["toolCall"] }
  | { type: "error"; error?: string }
  | { type: "done" };

function joinRunnerUrl(baseURL: string, path: string): string {
  const trimmed = baseURL.trim().replace(/\/$/, "");
  return `${trimmed}${path.startsWith("/") ? path : `/${path}`}`;
}

async function parseRunnerResponse(response: Response): Promise<AccountRunnerResponse> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as AccountRunnerResponse;
  } catch {
    return { content: text };
  }
}

function unsupportedAttachmentReason(params: ChatParams): string | undefined {
  for (const attachment of params.attachments ?? []) {
    if (attachment.category === "image") {
      if (attachment.mimeType.startsWith("image/") && attachment.base64Data) continue;
      return `${attachment.filename} is missing image data`;
    }
    if (attachment.category === "text_inline" || attachment.category === "document") {
      if (typeof attachment.textContent === "string" || attachment.base64Data) continue;
      return `${attachment.filename} is missing document data`;
    }
    return `${attachment.category} attachments are not supported by ${params.model}`;
  }
  return undefined;
}

function buildAccountRunnerRequestBody(
  params: ChatParams,
  supportsMaxTokens: boolean
): Record<string, unknown> {
  return {
    model: params.model,
    messages: params.messages,
    ...(supportsMaxTokens ? { maxTokens: params.maxTokens } : {}),
    temperature: params.temperature,
    reasoningEffort: params.reasoningEffort,
    structuredOutput: params.structuredOutput,
    nativeTools: params.nativeTools,
    hostedBuildTools: params.hostedBuildTools,
    webSearch: params.webSearch,
    attachments: params.attachments ?? [],
    stream: true,
  };
}

function parseSseBlock(block: string): AccountRunnerEvent | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data) as AccountRunnerEvent;
  } catch {
    return { type: "token", content: data };
  }
}

async function* streamRunnerEvents(response: Response): AsyncIterable<StreamChunk> {
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
      const end = index + match[0].length;
      const block = buffer.slice(0, index);
      buffer = buffer.slice(end);
      const event = parseSseBlock(block);
      if (!event) continue;
      if (event.type === "token" && event.content) {
        yield { type: "token", content: event.content };
      } else if (event.type === "tool_call" && event.toolCall) {
        yield { type: "tool_call", toolCall: event.toolCall };
      } else if (event.type === "error") {
        yield { type: "error", error: event.error ?? "Account runner stream failed" };
        return;
      } else if (event.type === "done") {
        yield { type: "done" };
        return;
      }
    }
  }
  const tail = parseSseBlock(buffer);
  if (tail?.type === "token" && tail.content) {
    yield { type: "token", content: tail.content };
  } else if (tail?.type === "tool_call" && tail.toolCall) {
    yield { type: "tool_call", toolCall: tail.toolCall };
  } else if (tail?.type === "error") {
    yield { type: "error", error: tail.error ?? "Account runner stream failed" };
    return;
  }
  yield { type: "done" };
}

export function createAccountRunnerProvider(
  options: AccountRunnerProviderOptions
): AIProvider {
  return {
    id: options.id,
    name: options.name,

    listModels() {
      return options.models;
    },

    async validateApiKey(apiKey: string) {
      // The key is the local runner token, not a provider API key. Full validation
      // needs the runner base URL, so Settings uses streamChat via validateProvider.
      return apiKey.trim().length > 0;
    },

    async *streamChat(params: ChatParams): AsyncIterable<StreamChunk> {
      const baseURL = params.baseURL?.trim();
      if (!baseURL) {
        yield {
          type: "error",
          error: `${options.name} needs the account-provider runner URL`,
        };
        return;
      }
      if (!params.apiKey.trim()) {
        yield {
          type: "error",
          error: `${options.name} needs the account-provider runner token`,
        };
        return;
      }
      const unsupported = unsupportedAttachmentReason(params);
      if (unsupported) {
        yield {
          type: "error",
          error: `${options.name} account-provider runner cannot send this attachment yet: ${unsupported}`,
        };
        return;
      }

      try {
        const supportsMaxTokens = providerSupportsMaxTokensFeature(
          options.id,
          params.model
        );
        const response = await fetch(
          joinRunnerUrl(baseURL, `/providers/${options.runnerPath}/chat`),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-runner-token": params.apiKey,
            },
            body: JSON.stringify(
              buildAccountRunnerRequestBody(params, supportsMaxTokens)
            ),
          }
        );
        if (
          response.ok &&
          response.headers.get("content-type")?.includes("text/event-stream")
        ) {
          yield* streamRunnerEvents(response);
          return;
        }
        const data = await parseRunnerResponse(response);
        if (!response.ok || data.error) {
          yield {
            type: "error",
            error: data.error ?? `${options.name} runner request failed (${response.status})`,
          };
          return;
        }

        const content = data.content ?? "";
        if (content) yield { type: "token", content };
        yield { type: "done" };
      } catch (err) {
        yield {
          type: "error",
          error: err instanceof Error ? err.message : `${options.name} runner request failed`,
        };
      }
    },
  };
}
