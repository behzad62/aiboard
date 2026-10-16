import { ProviderTransportError } from "./account-runner-model.js";
import type { ToolContentBlock, ToolDefinition, ToolResult } from "./agent-contracts.js";

export interface ToolNameCodec {
  wireFor(nativeName: string): string;
  nativeFor(wireName: string): string;
}

export function createToolNameCodec(
  tools: readonly ToolDefinition[]
): ToolNameCodec {
  const nativeToWire = new Map<string, string>();
  const wireToNative = new Map<string, string>();
  for (const tool of tools) {
    const normalized = tool.name
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "tool";
    let wire = normalized.slice(0, 64);
    let suffix = 2;
    while (wireToNative.has(wire)) {
      const marker = `_${suffix}`;
      wire = `${normalized.slice(0, 64 - marker.length)}${marker}`;
      suffix += 1;
    }
    nativeToWire.set(tool.name, wire);
    wireToNative.set(wire, tool.name);
  }
  return {
    wireFor: (nativeName) => nativeToWire.get(nativeName) ?? nativeName,
    nativeFor: (wireName) => wireToNative.get(wireName) ?? wireName,
  };
}

export function joinEndpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function serializedInputUsage(
  serializedBody: string,
  reportedInputTokens?: unknown
): { inputTokens: number; inputTokenSource: "reported" | "estimated" } {
  const reported = providerReportedTokenCount(reportedInputTokens);
  return reported !== undefined
    ? { inputTokens: reported, inputTokenSource: "reported" }
    : {
        inputTokens: Math.ceil(Buffer.byteLength(serializedBody) / 4),
        inputTokenSource: "estimated",
      };
}

export function providerReportedTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Upper bound for one provider HTTP request. Long max-effort turns legitimately take ~10 minutes, but
 * a stalled connection must not hang a run forever (P7: an OpenRouter call sat open for 33 minutes).
 * A timeout surfaces as a transient provider failure, so the normal retry policy applies.
 */
export const PROVIDER_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

export async function fetchProviderJson<T>(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS
): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal;
  let response: Response;
  let data: unknown;
  try {
    response = await fetchImpl(url, { ...init, signal });
    data = await response.json().catch((error: unknown) => {
      if (timeout.signal.aborted && !init.signal?.aborted) throw error;
      return {};
    }) as unknown;
  } catch (error) {
    if (timeout.signal.aborted && !init.signal?.aborted) {
      throw new ProviderTransportError(
        `Provider request timed out after ${Math.round(timeoutMs / 1000)}s without a response.`,
        undefined,
        "timeout"
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const error = providerError(data);
    throw new ProviderTransportError(
      error.message ?? `Provider request failed (${response.status}).`,
      response.status,
      error.code,
      retryAfter(response.headers.get("retry-after"))
    );
  }
  return data as T;
}

export function toolResultText(result: ToolResult): string {
  const content = result.content.map(contentBlockText).join("\n");
  return result.isError
    ? JSON.stringify({
        error: result.error ?? { code: "tool_error", message: content || "Tool failed." },
        content,
      })
    : content;
}

export function safeToolArguments(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { _malformedArgumentsJson: value };
  }
}

function contentBlockText(block: ToolContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "json") return JSON.stringify(block.value);
  return JSON.stringify({
    artifact: block.hash,
    mediaType: block.mediaType,
    ...(block.label ? { label: block.label } : {}),
  });
}

function providerError(data: unknown): { message?: string; code?: string } {
  if (!data || typeof data !== "object") return {};
  const record = data as Record<string, unknown>;
  const nested = record.error;
  if (nested && typeof nested === "object") {
    const error = nested as Record<string, unknown>;
    return {
      ...(typeof error.message === "string" ? { message: error.message } : {}),
      // OpenAI reports "insufficient_quota" (no credits) in `type` with a null `code`; without it the
      // 429 classified as a retryable rate limit and was retried 5 times.
      ...(typeof error.code === "string"
        ? { code: error.code }
        : typeof error.type === "string"
          ? { code: error.type }
          : {}),
    };
  }
  return {
    ...(typeof record.error === "string" ? { message: record.error } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(typeof record.code === "string" ? { code: record.code } : {}),
  };
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
