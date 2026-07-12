import type {
  NativeTool,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";

interface FetchInput {
  url: string;
  maxBytes: number;
  timeoutMs: number;
}

export interface ResearchToolsOptions {
  artifacts: ArtifactStore;
  fetch?: typeof globalThis.fetch;
  defaultMaxBytes?: number;
  maximumBytes?: number;
  defaultTimeoutMs?: number;
  maximumTimeoutMs?: number;
}

export function createResearchTools(
  options: ResearchToolsOptions
): NativeTool<FetchInput>[] {
  const defaultMaxBytes = options.defaultMaxBytes ?? 4 * 1024 * 1024;
  const maximumBytes = options.maximumBytes ?? 32 * 1024 * 1024;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
  const maximumTimeoutMs = options.maximumTimeoutMs ?? 5 * 60_000;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return [{
    definition: {
      name: "research.fetch",
      description:
        "Fetch one HTTP(S) resource, storing bounded raw bytes as an artifact and returning mechanical response facts",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", minLength: 1 },
          maxBytes: { type: "integer", minimum: 1, maximum: maximumBytes },
          timeoutMs: { type: "integer", minimum: 1, maximum: maximumTimeoutMs },
        },
        required: ["url"],
        additionalProperties: false,
      },
      readOnly: true,
      effect: "external",
    },
    validate: (input) => validateFetch(
      input,
      defaultMaxBytes,
      maximumBytes,
      defaultTimeoutMs,
      maximumTimeoutMs
    ),
    assessAccess: () => ({ capability: "research.fetch", external: true }),
    execute: async (input, context) => {
      const timeoutController = new AbortController();
      const signal = context.signal
        ? AbortSignal.any([context.signal, timeoutController.signal])
        : timeoutController.signal;
      const timeout = setTimeout(() => timeoutController.abort(), input.timeoutMs);
      try {
        const response = await fetchImpl(input.url, {
          method: "GET",
          redirect: "follow",
          signal,
          headers: { accept: "*/*", "user-agent": "AIBoard-Runner-V2/1" },
        });
        const bytes = await boundedBody(response, input.maxBytes);
        const mediaType = response.headers.get("content-type") ?? "application/octet-stream";
        const artifact = await options.artifacts.put(
          bytes,
          mediaType,
          `Research fetch ${response.url || input.url}`
        );
        return {
          content: [{
            type: "json",
            value: {
              requestedUrl: input.url,
              finalUrl: response.url || input.url,
              status: response.status,
              statusText: response.statusText,
              mediaType,
              byteLength: bytes.byteLength,
              artifactHash: artifact.hash,
              headers: safeHeaders(response.headers),
              ...(isText(mediaType)
                ? { excerpt: bytes.toString("utf8", 0, Math.min(bytes.length, 4_096)) }
                : {}),
            },
          }],
          isError: false,
        };
      } catch (error) {
        const message = signal.aborted
          ? "Research fetch was cancelled or timed out."
          : error instanceof Error ? error.message : String(error);
        return failure(signal.aborted ? "fetch_cancelled" : "fetch_failed", message);
      } finally {
        clearTimeout(timeout);
      }
    },
  }];
}

async function boundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new Error(`Response declares ${length} bytes, above the ${maxBytes}-byte limit.`);
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeded the ${maxBytes}-byte limit.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function validateFetch(
  input: unknown,
  defaultMaxBytes: number,
  maximumBytes: number,
  defaultTimeoutMs: number,
  maximumTimeoutMs: number
): ValidationResult<FetchInput> {
  if (!record(input) || typeof input.url !== "string") {
    return invalid("url must be an HTTP(S) URL");
  }
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return invalid("url must be an HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return invalid("url must use HTTP or HTTPS");
  }
  const maxBytes = input.maxBytes ?? defaultMaxBytes;
  const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
  if (!positiveBound(maxBytes, maximumBytes)) {
    return invalid(`maxBytes must be from 1 to ${maximumBytes}`);
  }
  if (!positiveBound(timeoutMs, maximumTimeoutMs)) {
    return invalid(`timeoutMs must be from 1 to ${maximumTimeoutMs}`);
  }
  return {
    ok: true,
    value: { url: url.toString(), maxBytes, timeoutMs },
  };
}

function safeHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ["content-type", "content-length", "etag", "last-modified"]) {
    const value = headers.get(name);
    if (value !== null) result[name] = value;
  }
  return result;
}

function isText(mediaType: string): boolean {
  return /^text\//i.test(mediaType) || /json|xml|javascript|yaml/i.test(mediaType);
}

function failure(code: string, message: string): ToolExecutionOutput {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message },
  };
}

function invalid<T>(issue: string): ValidationResult<T> {
  return { ok: false, issues: [issue] };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveBound(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maximum;
}
