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
  reportedInputTokens?: number
): { inputTokens: number; inputTokenSource: "reported" | "estimated" } {
  return reportedInputTokens !== undefined
    ? { inputTokens: reportedInputTokens, inputTokenSource: "reported" }
    : {
        inputTokens: Math.ceil(Buffer.byteLength(serializedBody) / 4),
        inputTokenSource: "estimated",
      };
}

export async function fetchProviderJson<T>(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit
): Promise<T> {
  const response = await fetchImpl(url, init);
  const data = await response.json().catch(() => ({})) as unknown;
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
      ...(typeof error.code === "string" ? { code: error.code } : {}),
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
