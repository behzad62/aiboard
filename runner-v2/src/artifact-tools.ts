import type {
  NativeTool,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import {
  ArtifactNotFoundError,
  type ArtifactStore,
} from "./artifact-store.js";

interface ReadArtifactInput {
  hash: string;
  offset: number;
  maxBytes: number;
}

const MAX_RANGE_BYTES = 6 * 1024;

export function createArtifactTools(
  store: ArtifactStore
): NativeTool<unknown>[] {
  const read: NativeTool<ReadArtifactInput> = {
    definition: {
      name: "artifact.read",
      description:
        "Reopen a bounded byte range from a content-addressed artifact referenced by prior tool, evidence, context, or history output",
      inputSchema: {
        type: "object",
        properties: {
          hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          offset: { type: "integer", minimum: 0 },
          maxBytes: {
            type: "integer",
            minimum: 1,
            maximum: MAX_RANGE_BYTES,
          },
        },
        required: ["hash"],
        additionalProperties: false,
      },
      readOnly: true,
      effect: "none",
    },
    validate: validateRead,
    execute: async (input) => {
      try {
        const [metadata, bytes] = await Promise.all([
          store.verify(input.hash),
          store.get(input.hash),
        ]);
        const range = bytes.subarray(
          Math.min(input.offset, bytes.byteLength),
          Math.min(input.offset + input.maxBytes, bytes.byteLength)
        );
        const text = isTextMediaType(metadata.mediaType)
          ? range.toString("utf8")
          : range.toString("base64");
        const encoding = isTextMediaType(metadata.mediaType) ? "utf8" : "base64";
        return {
          content: [
            {
              type: "json",
              value: {
                hash: metadata.hash,
                mediaType: metadata.mediaType,
                ...(metadata.label ? { label: metadata.label } : {}),
                byteLength: metadata.byteLength,
                offset: input.offset,
                returnedBytes: range.byteLength,
                truncated: input.offset + range.byteLength < metadata.byteLength,
                encoding,
              },
            },
            { type: "text", text },
          ],
          isError: false,
        };
      } catch (error) {
        return artifactFailure(error);
      }
    },
  };
  return [read as NativeTool<unknown>];
}

function validateRead(input: unknown): ValidationResult<ReadArtifactInput> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return invalid("arguments must be an object");
  }
  const value = input as Record<string, unknown>;
  if (typeof value.hash !== "string" || !/^[a-f0-9]{64}$/.test(value.hash)) {
    return invalid("hash must be a SHA-256 artifact address");
  }
  const offset = value.offset ?? 0;
  const maxBytes = value.maxBytes ?? MAX_RANGE_BYTES;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) {
    return invalid("offset must be a non-negative integer");
  }
  if (
    !Number.isSafeInteger(maxBytes) ||
    (maxBytes as number) < 1 ||
    (maxBytes as number) > MAX_RANGE_BYTES
  ) return invalid(`maxBytes must be from 1 to ${MAX_RANGE_BYTES}`);
  return {
    ok: true,
    value: {
      hash: value.hash,
      offset: offset as number,
      maxBytes: maxBytes as number,
    },
  };
}

function isTextMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType === "application/javascript" ||
    mediaType === "application/xml"
  );
}

function artifactFailure(error: unknown): ToolExecutionOutput {
  const missing = error instanceof ArtifactNotFoundError;
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code: missing ? "artifact_not_found" : "artifact_read_failed", message },
  };
}

function invalid<T>(issue: string): ValidationResult<T> {
  return { ok: false, issues: [issue] };
}
