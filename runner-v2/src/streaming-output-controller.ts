import { createHash } from "node:crypto";

export const BACKPRESSURED_PROCESS_OUTPUT_VERSION = 2 as const;
export type StreamingOutputStream = "stdout" | "stderr";
export interface StreamingOutputMetadata { readonly stream: StreamingOutputStream; readonly sequence: number; readonly startOffset: number; readonly endOffset: number; readonly byteLength: number; readonly digest: string }
export interface StreamingOutputChunk { readonly metadata: StreamingOutputMetadata; readonly bytes: Uint8Array; readonly acknowledge: (metadata: StreamingOutputMetadata) => Promise<void> }
export type StreamingOutputErrorCode = "invalid_chunk" | "sequence_mismatch" | "offset_mismatch" | "digest_mismatch" | "authorization_required" | "capacity_exceeded" | "outcome_unknown";
export class StreamingOutputError extends Error { constructor(readonly code: StreamingOutputErrorCode, message: string) { super(message); this.name = "StreamingOutputError"; } }

export function createStreamingOutputController(options: {
  readonly maxAcceptedChunks: number;
  readonly authorize: (stream: StreamingOutputStream) => boolean;
  readonly deliver: (stream: StreamingOutputStream, bytes: Uint8Array) => Promise<void>;
}) {
  if (!Number.isSafeInteger(options.maxAcceptedChunks) || options.maxAcceptedChunks < 1) throw new StreamingOutputError("invalid_chunk", "Output capacity must be positive.");
  const checkpoints = new Map<StreamingOutputStream, { sequence: number; endOffset: number; digest?: string }>();
  let outcome: "active" | "outcome_unknown" = "active";
  return Object.freeze({
    async accept(chunk: StreamingOutputChunk) {
      if (outcome !== "active") throw new StreamingOutputError("outcome_unknown", "Output delivery outcome is unknown.");
      const owned = Buffer.from(chunk.bytes);
      const metadata = parseMetadata(chunk.metadata, owned);
      const checkpoint = checkpoints.get(metadata.stream) ?? { sequence: 0, endOffset: 0 };
      if (metadata.sequence !== checkpoint.sequence + 1) throw new StreamingOutputError("sequence_mismatch", "Output sequence is not continuous.");
      if (metadata.startOffset !== checkpoint.endOffset) throw new StreamingOutputError("offset_mismatch", "Output offset is not continuous.");
      // accepted metadata and consuming intent are private in this fake-only packet; durable integration uses the kernel writer.
      if (!options.authorize(metadata.stream)) { outcome = "outcome_unknown"; owned.fill(0); throw new StreamingOutputError("authorization_required", "Current exact output authorization is required."); }
      try {
        await options.deliver(metadata.stream, owned);
        checkpoints.set(metadata.stream, { sequence: metadata.sequence, endOffset: metadata.endOffset, digest: metadata.digest });
        await chunk.acknowledge(metadata);
      } catch (error) {
        outcome = "outcome_unknown";
        throw error;
      } finally { owned.fill(0); }
    },
    snapshot() { return Object.freeze({ outcome, streams: Object.freeze([...checkpoints.entries()].map(([stream, value]) => Object.freeze({ stream, ...value }))) }); },
  });
}

function parseMetadata(input: StreamingOutputMetadata, bytes: Buffer): StreamingOutputMetadata {
  if ((input.stream !== "stdout" && input.stream !== "stderr") || !Number.isSafeInteger(input.sequence) || input.sequence < 1 || !Number.isSafeInteger(input.startOffset) || input.startOffset < 0 || !Number.isSafeInteger(input.endOffset) || input.endOffset <= input.startOffset || !Number.isSafeInteger(input.byteLength) || input.byteLength < 1 || input.endOffset - input.startOffset !== input.byteLength || input.byteLength !== bytes.byteLength) throw new StreamingOutputError("invalid_chunk", "Output metadata is invalid.");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (!/^[a-f0-9]{64}$/i.test(input.digest) || digest !== input.digest.toLowerCase()) throw new StreamingOutputError("digest_mismatch", "Output digest does not match bytes.");
  return Object.freeze({ ...input, digest });
}
