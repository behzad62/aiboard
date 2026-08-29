import { createHash } from "node:crypto";
import { getStreamingSessionKernelWriter, type StreamingSessionStoreKernel } from "./streaming-session-store.js";

export const BACKPRESSURED_PROCESS_OUTPUT_VERSION = 2 as const;
export type StreamingOutputStream = "stdout" | "stderr";
export interface StreamingOutputMetadata { readonly stream: StreamingOutputStream; readonly sequence: number; readonly startOffset: number; readonly endOffset: number; readonly byteLength: number; readonly digest: string }
export interface StreamingOutputChunk { readonly metadata: StreamingOutputMetadata; readonly bytes: Uint8Array; readonly acknowledge: (metadata: StreamingOutputMetadata) => Promise<void> }
export type StreamingOutputErrorCode = "invalid_chunk" | "sequence_mismatch" | "offset_mismatch" | "digest_mismatch" | "authorization_required" | "capacity_exceeded" | "outcome_unknown";
export class StreamingOutputError extends Error { constructor(readonly code: StreamingOutputErrorCode, message: string) { super(message); this.name = "StreamingOutputError"; } }

export function createStreamingOutputController(options: {
  readonly maxAcceptedChunks: number;
  readonly kernel?: StreamingSessionStoreKernel;
  readonly sessionId?: string;
  readonly ownerId?: string;
  readonly fencingToken?: number;
  readonly authorize: (stream: StreamingOutputStream) => boolean;
  readonly deliver: (stream: StreamingOutputStream, bytes: Uint8Array) => Promise<void>;
}) {
  if (!Number.isSafeInteger(options.maxAcceptedChunks) || options.maxAcceptedChunks < 1) throw new StreamingOutputError("invalid_chunk", "Output capacity must be positive.");
  const checkpoints = new Map<StreamingOutputStream, { sequence: number; endOffset: number; digest?: string }>();
  const durable = options.kernel ? getStreamingSessionKernelWriter(options.kernel) : undefined;
  if (durable && (!options.sessionId || !options.ownerId || !Number.isSafeInteger(options.fencingToken) || options.fencingToken! < 1)) throw new StreamingOutputError("invalid_chunk", "Durable output controller identity is invalid.");
  let outcome: "active" | "outcome_unknown" = "active";
  return Object.freeze({
    async accept(chunk: StreamingOutputChunk) {
      if (outcome !== "active") throw new StreamingOutputError("outcome_unknown", "Output delivery outcome is unknown.");
      const owned = Buffer.from(chunk.bytes);
      const metadata = parseMetadata(chunk.metadata, owned);
      const durableRecord = options.kernel?.store.readOutputCheckpoint(options.sessionId!);
      const durableStream = durableRecord?.streams.find((stream) => stream.stream === metadata.stream);
      if (durableStream?.lastConsumed && metadata.sequence <= durableStream.lastConsumed.sequence) {
        if (JSON.stringify(metadata) !== JSON.stringify(durableStream.lastConsumed)) { owned.fill(0); throw new StreamingOutputError("digest_mismatch", "Consumed output replay metadata mismatches."); }
        try { await chunk.acknowledge(metadata); } finally { owned.fill(0); }
        return;
      }
      const checkpoint = checkpoints.get(metadata.stream) ?? (durableStream?.lastConsumed
        ? { sequence: durableStream.lastConsumed.sequence, endOffset: durableStream.lastConsumed.endOffset, digest: durableStream.lastConsumed.digest }
        : { sequence: 0, endOffset: 0 });
      if (metadata.sequence !== checkpoint.sequence + 1) throw new StreamingOutputError("sequence_mismatch", "Output sequence is not continuous.");
      if (metadata.startOffset !== checkpoint.endOffset) throw new StreamingOutputError("offset_mismatch", "Output offset is not continuous.");
      let revision = options.kernel?.store.readOutputCheckpoint(options.sessionId!)?.revision;
      if (durable) {
        if (revision === undefined) throw new StreamingOutputError("invalid_chunk", "Durable output checkpoint is missing.");
        durable.applyOutputCheckpoint({ type: "accept", sessionId: options.sessionId, ownerId: options.ownerId, fencingToken: options.fencingToken, expectedRevision: revision++, metadata });
        durable.applyOutputCheckpoint({ type: "begin_consume", sessionId: options.sessionId, ownerId: options.ownerId, fencingToken: options.fencingToken, expectedRevision: revision++, metadata });
      }
      if (!options.authorize(metadata.stream)) {
        outcome = "outcome_unknown";
        if (durable) durable.applyOutputCheckpoint({ type: "mark_outcome_unknown", sessionId: options.sessionId, ownerId: options.ownerId, fencingToken: options.fencingToken, expectedRevision: revision, metadata });
        owned.fill(0); throw new StreamingOutputError("authorization_required", "Current exact output authorization is required.");
      }
      try {
        await options.deliver(metadata.stream, owned);
        if (durable) durable.applyOutputCheckpoint({ type: "commit_consumed", sessionId: options.sessionId, ownerId: options.ownerId, fencingToken: options.fencingToken, expectedRevision: revision, metadata });
        checkpoints.set(metadata.stream, { sequence: metadata.sequence, endOffset: metadata.endOffset, digest: metadata.digest });
        await chunk.acknowledge(metadata);
      } catch (error) {
        outcome = "outcome_unknown";
        const current = options.kernel?.store.readOutputCheckpoint(options.sessionId!);
        if (durable && current?.outcome === "active") durable.applyOutputCheckpoint({ type: "mark_outcome_unknown", sessionId: options.sessionId, ownerId: options.ownerId, fencingToken: options.fencingToken, expectedRevision: current.revision, metadata });
        throw error;
      } finally { owned.fill(0); }
    },
    async acceptEvidenceOnly(chunk: StreamingOutputChunk) {
      if (!durable || !options.kernel || !options.sessionId) throw new StreamingOutputError("invalid_chunk", "Evidence-only output requires a durable checkpoint.");
      const owned = Buffer.from(chunk.bytes); const metadata = parseMetadata(chunk.metadata, owned);
      try {
        const record = options.kernel.store.readOutputCheckpoint(options.sessionId);
        if (!record || record.outcome !== "active") throw new StreamingOutputError("outcome_unknown", "Evidence-only checkpoint is unavailable.");
        durable.applyOutputCheckpoint({ type: "accept", sessionId: options.sessionId, ownerId: options.ownerId, fencingToken: options.fencingToken, expectedRevision: record.revision, metadata });
        durable.applyOutputCheckpoint({ type: "commit_evidence_consumed", sessionId: options.sessionId, ownerId: options.ownerId, fencingToken: options.fencingToken, expectedRevision: record.revision + 1, metadata });
        await chunk.acknowledge(metadata);
      } catch (error) {
        const current = options.kernel.store.readOutputCheckpoint(options.sessionId);
        if (current?.outcome === "active") durable.applyOutputCheckpoint({ type: "mark_outcome_unknown", sessionId: options.sessionId, ownerId: options.ownerId, fencingToken: options.fencingToken, expectedRevision: current.revision, metadata });
        throw error;
      } finally { owned.fill(0); }
    },
    attestRetainedWindow(retained: readonly StreamingOutputMetadata[]) {
      if (!durable || !options.kernel || !options.sessionId) return true;
      const record = options.kernel.store.readOutputCheckpoint(options.sessionId);
      if (!record) throw new StreamingOutputError("outcome_unknown", "Durable output checkpoint is missing.");
      const expected = record.streams.flatMap((stream) => stream.accepted);
      const exact = !record.streams.some((stream) => stream.consumingIntent) && expected.length === retained.length && expected.every((entry, index) => JSON.stringify(entry) === JSON.stringify(retained[index]));
      if (!exact) {
        if (record.outcome === "active") durable.applyOutputCheckpoint({ type: "mark_outcome_unknown", sessionId: options.sessionId, ownerId: options.ownerId, fencingToken: options.fencingToken, expectedRevision: record.revision, metadata: retained[0] ?? { stream: "stdout", sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1, digest: "0".repeat(64) } });
        outcome = "outcome_unknown";
        throw new StreamingOutputError("outcome_unknown", "Provider cannot attest every retained accepted output chunk.");
      }
      return true;
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
