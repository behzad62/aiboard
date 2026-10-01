import type {
  AIProvider,
  CertifiedProviderErrorMetadata,
  ChatParams,
  ModelInfo,
  StreamChunk,
} from "./base";
import { providerSupportsMaxTokensFeature } from "./provider-registry";
import {
  fetchRunnerCapabilityHandshake,
  type RunnerCapabilityProviderId,
  type RunnerCapabilityValidationResult,
} from "./runner-capabilities";

export const ACCOUNT_RUNNER_CAPABILITY_MINIMUM_VERSION = 21;

export async function fetchAccountRunnerCapabilities(input: {
  baseURL: string;
  runnerToken: string;
  providerId: RunnerCapabilityProviderId;
  apiKey?: string;
  signal?: AbortSignal;
  minimumRunnerVersion?: number;
}): Promise<RunnerCapabilityValidationResult> {
  return fetchRunnerCapabilityHandshake(input);
}
interface CachedRunnerCapabilityEntry {
  result: Extract<RunnerCapabilityValidationResult, { status: "valid" }>;
  cachedAt: number;
}

const runnerCapabilityCache = new Map<string, CachedRunnerCapabilityEntry>();

function runnerCapabilityCacheKey(input: {
  baseURL: string;
  runnerToken: string;
  providerId: RunnerCapabilityProviderId;
  apiKey?: string;
  minimumRunnerVersion?: number;
}): string {
  return JSON.stringify([
    input.providerId,
    input.baseURL.trim().replace(/\/$/, ""),
    input.runnerToken,
    input.apiKey ?? "",
    input.minimumRunnerVersion ?? 0,
  ]);
}

async function fetchRunnerHealthVersion(input: {
  baseURL: string;
  runnerToken: string;
  signal?: AbortSignal;
}): Promise<number | undefined> {
  try {
    const response = await fetch(joinRunnerUrl(input.baseURL, "/health"), {
      headers: { "x-runner-token": input.runnerToken.trim() },
      signal: input.signal,
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { version?: unknown };
    return Number.isInteger(payload.version) ? Number(payload.version) : undefined;
  } catch {
    return undefined;
  }
}

export function clearAccountRunnerCapabilityCache(providerId?: RunnerCapabilityProviderId): void {
  if (!providerId) {
    runnerCapabilityCache.clear();
    return;
  }
  for (const [key, entry] of runnerCapabilityCache) {
    if (entry.result.handshake.providerId === providerId) runnerCapabilityCache.delete(key);
  }
}

export async function getCachedAccountRunnerCapabilities(
  input: {
    baseURL: string;
    runnerToken: string;
    providerId: RunnerCapabilityProviderId;
    apiKey?: string;
    signal?: AbortSignal;
    minimumRunnerVersion?: number;
  },
  options: { forceRefresh?: boolean; maxStaleMs?: number; nowMs?: number } = {},
): Promise<RunnerCapabilityValidationResult> {
  const key = runnerCapabilityCacheKey(input);
  const cached = runnerCapabilityCache.get(key);
  const nowMs = options.nowMs ?? Date.now();
  if (cached && options.forceRefresh !== true) {
    const healthVersion = await fetchRunnerHealthVersion(input);
    if (healthVersion === cached.result.handshake.runnerVersion) return cached.result;
    if (
      healthVersion === undefined &&
      nowMs - cached.cachedAt <= (options.maxStaleMs ?? 30_000)
    ) {
      return cached.result;
    }
  }

  const result = await fetchAccountRunnerCapabilities(input);
  if (result.status === "valid") {
    runnerCapabilityCache.set(key, { result, cachedAt: nowMs });
  } else {
    runnerCapabilityCache.delete(key);
  }
  return result;
}
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
  credentialMode?: "runner-token" | "provider-api-key-with-runner-token";
  /**
   * Unwrap a whole-reply markdown fence when structuredOutput was requested.
   * Copilot-served non-OpenAI models (observed live: gemini) can ignore
   * response_format and fence the JSON reply; strict JSON.parse consumers
   * (the certified scorer) would score that failed_tool_use. Runner v16+
   * strips bridge-side too — this heals responses from older runners.
   */
  stripStructuredOutputFences?: boolean;
}

interface AccountRunnerResponse {
  ok?: boolean;
  content?: string;
  error?: string;
  errorMetadata?: CertifiedProviderErrorMetadata;
}

type AccountRunnerEvent =
  | { type: "token"; content?: string }
  | { type: "tool_call"; toolCall?: StreamChunk["toolCall"] }
  | { type: "provider_tool_event"; providerToolEvent?: StreamChunk["providerToolEvent"] }
  | { type: "usage"; usage?: StreamChunk["usage"] }
  | { type: "error"; error?: string; errorMetadata?: CertifiedProviderErrorMetadata }
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
  supportsMaxTokens: boolean,
  includeProviderApiKey = false
): Record<string, unknown> {
  return {
    ...(includeProviderApiKey ? { apiKey: params.apiKey } : {}),
    model: params.model,
    messages: params.messages,
    ...(supportsMaxTokens ? { maxTokens: params.maxTokens } : {}),
    temperature: params.temperature,
    reasoningEffort: params.reasoningEffort,
    structuredOutput: params.structuredOutput,
    functionTools: params.functionTools,
    toolIntents: params.callPlan?.enabledTools.map((tool) => tool.intent) ?? [],
    toolChoice: params.callPlan?.toolChoice ?? params.toolChoice,
    attachments: params.attachments ?? [],
    runtimeMode: "discussion",
    stream: true,
  };
}

/** Keep in sync with stripStructuredOutputFence in lib/account-provider-runner.mjs. */
function stripStructuredOutputFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return match ? match[1].trim() : text;
}

/**
 * Buffers token chunks and re-emits them as one fence-stripped token before
 * done. Only used for structured-output requests, whose replies are parsed
 * whole — losing token-by-token streaming there is harmless.
 */
async function* stripFencesFromTokenStream(
  chunks: AsyncIterable<StreamChunk>
): AsyncIterable<StreamChunk> {
  let buffered = "";
  for await (const chunk of chunks) {
    if (chunk.type === "token" && chunk.content) {
      buffered += chunk.content;
      continue;
    }
    if (chunk.type === "done" || chunk.type === "error") {
      // Only a complete reply can be a whole-reply fence; flush a partial
      // (errored) reply untouched.
      const content = chunk.type === "done" ? stripStructuredOutputFence(buffered) : buffered;
      if (content) yield { type: "token", content };
      buffered = "";
    }
    yield chunk;
  }
  if (buffered) yield { type: "token", content: buffered };
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
  try {
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
        } else if (event.type === "provider_tool_event" && event.providerToolEvent) {
          yield { type: "provider_tool_event", providerToolEvent: event.providerToolEvent };
        } else if (event.type === "usage" && event.usage) {
          yield { type: "usage", usage: event.usage };
        } else if (event.type === "error") {
          yield {
            type: "error",
            error: event.error ?? "Account runner stream failed",
            errorMetadata: event.errorMetadata,
          };
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
    } else if (tail?.type === "provider_tool_event" && tail.providerToolEvent) {
      yield { type: "provider_tool_event", providerToolEvent: tail.providerToolEvent };
    } else if (tail?.type === "usage" && tail.usage) {
      yield { type: "usage", usage: tail.usage };
    } else if (tail?.type === "error") {
      yield {
        type: "error",
        error: tail.error ?? "Account runner stream failed",
        errorMetadata: tail.errorMetadata,
      };
      return;
    }
    yield { type: "done" };
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createAccountRunnerProvider(
  options: AccountRunnerProviderOptions
): AIProvider {
  const credentialMode = options.credentialMode ?? "runner-token";
  return {
    id: options.id,
    name: options.name,

    listModels() {
      return options.models;
    },

    async validateApiKey(apiKey: string) {
      // In runner-token mode the key is the local runner token; in provider-key
      // mode this checks the upstream API key only. Full validation still needs
      // the runner base URL/token, so Settings uses streamChat via validateProvider.
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
      const runnerToken =
        credentialMode === "provider-api-key-with-runner-token"
          ? params.runnerToken?.trim()
          : params.apiKey.trim();
      if (!runnerToken) {
        yield {
          type: "error",
          error: `${options.name} needs the account-provider runner token`,
        };
        return;
      }
      if (
        credentialMode === "provider-api-key-with-runner-token" &&
        !params.apiKey.trim()
      ) {
        yield {
          type: "error",
          error: `${options.name} needs a provider API key`,
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
              "x-runner-token": runnerToken,
            },
            body: JSON.stringify(
              buildAccountRunnerRequestBody(
                params,
                supportsMaxTokens,
                credentialMode === "provider-api-key-with-runner-token"
              )
            ),
            signal: params.signal,
          }
        );
        const normalizeFences =
          options.stripStructuredOutputFences === true && !!params.structuredOutput;
        if (
          response.ok &&
          response.headers.get("content-type")?.includes("text/event-stream")
        ) {
          if (normalizeFences) yield* stripFencesFromTokenStream(streamRunnerEvents(response));
          else yield* streamRunnerEvents(response);
          return;
        }
        const data = await parseRunnerResponse(response);
        if (!response.ok || data.error) {
          yield {
            type: "error",
            error: data.error ?? `${options.name} runner request failed (${response.status})`,
            errorMetadata: data.errorMetadata ?? {
              statusCode: response.status,
              retryAfterMs: parseRetryAfter(
                response.headers.get("retry-after"),
                Date.now()
              ),
            },
          };
          return;
        }

        const raw = data.content ?? "";
        const content = normalizeFences ? stripStructuredOutputFence(raw) : raw;
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

export function parseRetryAfter(
  value: string | null,
  nowMs: number
): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.round(seconds * 1_000);
  }
  const dateMs = Date.parse(text);
  if (!Number.isFinite(dateMs)) return undefined;
  const delayMs = dateMs - nowMs;
  return delayMs >= 0 ? delayMs : undefined;
}
