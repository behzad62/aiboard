import { createHash } from "node:crypto";

import type { BoundedProtocolQueue } from "./bounded-protocol-queue.js";
import type { OperationAuthorizationAssertion, SessionOperationAuthorization } from "./session-authority.js";
import { getStreamingSessionKernelWriter, type StreamingSessionStoreKernel } from "./streaming-session-store.js";

export const BACKPRESSURED_PROCESS_OUTPUT_VERSION = 2 as const;
export type StreamingOutputStream = "stdout" | "stderr";
export interface StreamingOutputMetadata { readonly stream: StreamingOutputStream; readonly sequence: number; readonly startOffset: number; readonly endOffset: number; readonly byteLength: number; readonly digest: string }
export type StreamingOutputErrorCode = "invalid_chunk" | "sequence_mismatch" | "offset_mismatch" | "digest_mismatch" | "authorization_required" | "capacity_exceeded" | "outcome_unknown";
export class StreamingOutputError extends Error { constructor(readonly code: StreamingOutputErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.name = "StreamingOutputError"; } }

interface PendingProtocolChunk {
  ready: boolean;
  readonly metadata: StreamingOutputMetadata;
  readonly acknowledgement: Promise<StreamingOutputMetadata>;
  resolve(acknowledgement: StreamingOutputMetadata): void;
  reject(error: unknown): void;
}

/** Intake is private and may run before adoption. Family delivery is a separate authorized pull. */
export function createStreamingOutputController(options: {
  readonly maxAcceptedChunks: number;
  readonly kernel: StreamingSessionStoreKernel;
  readonly sessionId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly queue: BoundedProtocolQueue;
  readonly protocolStreams: readonly StreamingOutputStream[];
  /** Live takeover has already durably spooled every accepted replay. */
  readonly acceptedReplayEvidenceAlreadyRecorded?: boolean;
  readonly writeEvidence: (stream: StreamingOutputStream, bytes: Uint8Array, metadata: StreamingOutputMetadata) => Promise<Readonly<{ evidenceLossy: boolean; reason?: string }>>;
  readonly assertAuthorization: (authorization: SessionOperationAuthorization, expected: OperationAuthorizationAssertion) => void;
  readonly deliver: (stream: StreamingOutputStream, bytes: Uint8Array) => Promise<void>;
}) {
  if (!Number.isSafeInteger(options.maxAcceptedChunks) || options.maxAcceptedChunks < 1 || !options.sessionId || !options.ownerId || !Number.isSafeInteger(options.fencingToken) || options.fencingToken < 1) throw new StreamingOutputError("invalid_chunk", "Durable output controller configuration is invalid.");
  const configuredCheckpoint = options.kernel.store.readOutputCheckpoint(options.sessionId);
  if (!configuredCheckpoint || configuredCheckpoint.capacity !== options.maxAcceptedChunks || configuredCheckpoint.ownerId !== options.ownerId || configuredCheckpoint.fencingToken !== options.fencingToken) throw new StreamingOutputError("capacity_exceeded", "Output controller capacity and ownership must exactly match the durable provider window.");
  const durable = getStreamingSessionKernelWriter(options.kernel);
  const pending: PendingProtocolChunk[] = [];
  const pendingWaiters = new Set<(available: boolean) => void>();
  let held: Buffer | undefined;
  let outcome: "active" | "outcome_unknown" = "active";
  let evidenceLossy = false;
  let cleanupRelinquished = false;

  const settlePendingWaiters = (available: boolean) => {
    for (const resolve of pendingWaiters) resolve(available);
    pendingWaiters.clear();
  };

  const markUnknown = (metadata: StreamingOutputMetadata, cause?: unknown): never => {
    let persistenceFailure: unknown;
    try {
      const current = options.kernel.store.readOutputCheckpoint(options.sessionId);
      if (current?.outcome === "active") durable.applyOutputCheckpoint({ type: "mark_outcome_unknown", sessionId: options.sessionId, ownerId: options.ownerId, fencingToken: options.fencingToken, expectedRevision: current.revision, metadata });
    } catch (error) { persistenceFailure = error; }
    outcome = "outcome_unknown";
    const error = persistenceFailure ? new AggregateError([cause, persistenceFailure].filter((entry) => entry !== undefined), "Output outcome could not be durably settled by this owner.") : cause instanceof StreamingOutputError ? cause : new StreamingOutputError("outcome_unknown", "Output delivery outcome is unknown.", { cause });
    for (const item of pending.splice(0)) item.reject(error);
    held?.fill(0); held = undefined;
    options.queue.cancel("Output delivery outcome is unknown.");
    settlePendingWaiters(false);
    throw error;
  };

  const accept = async (metadataInput: StreamingOutputMetadata, input: Uint8Array): Promise<StreamingOutputMetadata> => {
    if (outcome !== "active") throw new StreamingOutputError("outcome_unknown", "Output delivery outcome is unknown.");
    const owned = Buffer.from(input);
    try {
    const metadata = parseMetadata(metadataInput, owned);
    const record = options.kernel.store.readOutputCheckpoint(options.sessionId);
    if (!record || record.outcome !== "active") { owned.fill(0); throw new StreamingOutputError("outcome_unknown", "Durable output checkpoint is unavailable."); }
    const stream = record.streams.find((entry) => entry.stream === metadata.stream);
    if (!stream) { owned.fill(0); throw new StreamingOutputError("invalid_chunk", "Output stream is not configured."); }
    if (stream.lastConsumed && metadata.sequence <= stream.lastConsumed.sequence) {
      const exact = stream.consumed.some((entry) => sameMetadata(entry, metadata));
      owned.fill(0);
      if (!exact) throw new StreamingOutputError("digest_mismatch", "Consumed replay is outside or mismatches the authenticated window.");
      return metadata;
    }
    const alreadyAccepted = stream.accepted.some((entry) => sameMetadata(entry, metadata));
    const liveReplay = alreadyAccepted ? pending.find((entry) => sameMetadata(entry.metadata, metadata)) : undefined;
    if (liveReplay) return await liveReplay.acknowledgement;
    if (alreadyAccepted && stream.consumingIntent) { owned.fill(0); return markUnknown(metadata); }
    if (!alreadyAccepted) {
      const prior = stream.accepted.at(-1) ?? stream.lastConsumed;
      if (metadata.sequence !== (prior?.sequence ?? 0) + 1) { owned.fill(0); throw new StreamingOutputError("sequence_mismatch", "Output sequence is not continuous."); }
      if (metadata.startOffset !== (prior?.endOffset ?? 0)) { owned.fill(0); throw new StreamingOutputError("offset_mismatch", "Output offset is not continuous."); }
      if (options.protocolStreams.includes(metadata.stream)) durable.applyOutputCheckpoint({ type: "accept", sessionId: options.sessionId, ownerId: options.ownerId, fencingToken: options.fencingToken, expectedRevision: record.revision, metadata });
    }
    if (!options.protocolStreams.includes(metadata.stream)) {
      if (!(alreadyAccepted && options.acceptedReplayEvidenceAlreadyRecorded)) {
        const evidence = await options.writeEvidence(metadata.stream, owned, metadata);
        evidenceLossy ||= evidence.evidenceLossy;
      }
      const current = options.kernel.store.readOutputCheckpoint(options.sessionId)!;
      durable.applyOutputCheckpoint({ type: "commit_evidence_consumed", sessionId: options.sessionId, ownerId: options.ownerId, fencingToken: options.fencingToken, expectedRevision: current.revision, metadata });
      owned.fill(0);
      return metadata;
    }
    let resolveDelivery!: (acknowledgement: StreamingOutputMetadata) => void; let rejectDelivery!: (error: unknown) => void;
    const delivery = new Promise<StreamingOutputMetadata>((resolve, reject) => { resolveDelivery = resolve; rejectDelivery = reject; });
    // Queue admission may reject before accept reaches its await of delivery.
    // Mark the internal promise observed; the original rejection still propagates
    // through accept and every duplicate acknowledgement waiter.
    void delivery.catch(() => undefined);
    const item = { ready: false, metadata, acknowledgement: delivery, resolve: resolveDelivery, reject: rejectDelivery }; pending.push(item);
    try {
      await options.queue.push(owned);
      const evidence = await options.writeEvidence(metadata.stream, owned, metadata); evidenceLossy ||= evidence.evidenceLossy;
      item.ready = true;
      settlePendingWaiters(true);
      owned.fill(0);
      return await delivery;
    } catch (error) {
      owned.fill(0); const index = pending.indexOf(item); if (index >= 0) pending.splice(index, 1);
      if (cleanupRelinquished) throw error;
      try { return markUnknown(metadata, error); } catch (failure) { rejectDelivery(failure); throw failure; }
    }
    } catch (error) {
      if (cleanupRelinquished) throw error;
      const current = options.kernel.store.readOutputCheckpoint(options.sessionId);
      if (current?.outcome === "active") return markUnknown(fallbackMetadata(current.streams[0]!.stream), error);
      throw error;
    } finally { owned.fill(0); }
  };

  const deliverNext = async (
    deliver: (stream: StreamingOutputStream, bytes: Uint8Array) => Promise<void>,
    authorize?: () => void,
  ): Promise<boolean> => {
    if (outcome !== "active") throw new StreamingOutputError("outcome_unknown", "Output delivery outcome is unknown.");
    const item = pending[0]; if (!item?.ready) return false;
    try { authorize?.(); }
    catch (error) { throw new StreamingOutputError("authorization_required", "Current exact family-delivery authorization is required.", { cause: error }); }
    let current = options.kernel.store.readOutputCheckpoint(options.sessionId);
    if (!current || current.outcome !== "active") return markUnknown(item.metadata);
    durable.applyOutputCheckpoint({ type: "begin_consume", sessionId: options.sessionId, ownerId: options.ownerId, fencingToken: options.fencingToken, expectedRevision: current.revision, metadata: item.metadata });
    try { authorize?.(); }
    catch (error) {
      current = options.kernel.store.readOutputCheckpoint(options.sessionId)!;
      durable.applyOutputCheckpoint({ type: "cancel_consume", sessionId: options.sessionId, ownerId: options.ownerId, fencingToken: options.fencingToken, expectedRevision: current.revision, metadata: item.metadata });
      throw new StreamingOutputError("authorization_required", "Family-delivery authorization became stale before effect.", { cause: error });
    }
    try { held ??= await options.queue.read(); } catch (error) { return markUnknown(item.metadata, error); }
    if (!held) return markUnknown(item.metadata);
    try { authorize?.(); }
    catch (error) {
      current = options.kernel.store.readOutputCheckpoint(options.sessionId)!;
      durable.applyOutputCheckpoint({ type: "cancel_consume", sessionId: options.sessionId, ownerId: options.ownerId, fencingToken: options.fencingToken, expectedRevision: current.revision, metadata: item.metadata });
      throw new StreamingOutputError("authorization_required", "Family-delivery authorization became stale before effect.", { cause: error });
    }
    try {
      await deliver(item.metadata.stream, held);
      current = options.kernel.store.readOutputCheckpoint(options.sessionId)!;
      durable.applyOutputCheckpoint({ type: "commit_consumed", sessionId: options.sessionId, ownerId: options.ownerId, fencingToken: options.fencingToken, expectedRevision: current.revision, metadata: item.metadata });
      pending.shift(); item.resolve(item.metadata);
      held.fill(0); held = undefined;
      return true;
    } catch (error) { return markUnknown(item.metadata, error); }
  };

  return Object.freeze({
    accept,
    async deliverNext(
      authorization: SessionOperationAuthorization,
      assertion: OperationAuthorizationAssertion,
      deliver: (stream: StreamingOutputStream, bytes: Uint8Array) => Promise<void> = options.deliver,
    ): Promise<boolean> {
      const expected = Object.freeze({ ...assertion, sessionId: options.sessionId, operation: "family_delivery" as const });
      return await deliverNext(deliver, () => options.assertAuthorization(authorization, expected));
    },
    async deliverNextPrivately(
      deliver: (stream: StreamingOutputStream, bytes: Uint8Array) => Promise<void>,
    ): Promise<boolean> {
      return await deliverNext(deliver);
    },
    waitForPending(signal?: AbortSignal): Promise<boolean> {
      if (pending[0]?.ready) return Promise.resolve(true);
      if (outcome !== "active") return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (available: boolean) => {
          if (settled) return;
          settled = true;
          pendingWaiters.delete(waiter);
          signal?.removeEventListener("abort", abort);
          resolve(available);
        };
        const waiter = (available: boolean) => finish(available);
        const abort = () => finish(false);
        pendingWaiters.add(waiter);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        else if (pending[0]?.ready) finish(true);
        else if (outcome !== "active") finish(false);
      });
    },
    attestRetainedWindow(
      retained: readonly StreamingOutputMetadata[],
      attestationOptions: { readonly allowUnacceptedSuffix?: boolean } = {},
    ) {
      const record = options.kernel.store.readOutputCheckpoint(options.sessionId);
      if (!record || record.outcome !== "active") throw new StreamingOutputError("outcome_unknown", "Durable output checkpoint is unavailable.");
      const accepted = sortMetadata(record.streams.flatMap((stream) => stream.accepted));
      const consumed = record.streams.flatMap((stream) => stream.consumed);
      const actual = sortMetadata(retained);
      const allowed = new Map([...consumed, ...accepted].map((metadata) => [metadataKey(metadata), metadata]));
      const actualKeys = new Set<string>();
      const suffix = new Map(record.streams.map((stream) => {
        const latest = stream.accepted.at(-1) ?? stream.lastConsumed;
        return [stream.stream, {
          sequence: latest?.sequence ?? 0,
          endOffset: latest?.endOffset ?? 0,
        }] as const;
      }));
      const invalidActual = actual.find((metadata) => {
        const key = metadataKey(metadata);
        const exact = allowed.get(key);
        if (actualKeys.has(key)) return true;
        actualKeys.add(key);
        if (exact) return !sameMetadata(exact, metadata);
        const prior = suffix.get(metadata.stream);
        if (!attestationOptions.allowUnacceptedSuffix || !prior ||
            !validMetadataShape(metadata) ||
            metadata.sequence !== prior.sequence + 1 ||
            metadata.startOffset !== prior.endOffset) return true;
        suffix.set(metadata.stream, {
          sequence: metadata.sequence,
          endOffset: metadata.endOffset,
        });
        return false;
      });
      const missingAccepted = accepted.find((metadata) => !actualKeys.has(metadataKey(metadata)));
      // The provider may still retain an exact already-consumed frame when the
      // Runner crashed after its durable consume commit but before the channel
      // acknowledgement became visible. All unconsumed accepted frames remain
      // mandatory; only an exact bounded consumed replay is optional.
      if (record.streams.some((stream) => stream.consumingIntent) || invalidActual || missingAccepted)
        return markUnknown(invalidActual ?? missingAccepted ?? actual[0] ?? accepted[0] ?? fallbackMetadata());
      return true;
    },
    snapshot() { return Object.freeze({ outcome, pending: pending.length, evidenceLossy, heldBytes: held?.byteLength ?? 0 }); },
    cancel(reason = "Output controller cancelled.") {
      const error = new StreamingOutputError("outcome_unknown", reason);
      for (const item of pending.splice(0)) item.reject(error);
      held?.fill(0); held = undefined; options.queue.cancel(reason); outcome = "outcome_unknown";
      settlePendingWaiters(false);
    },
    relinquishForCleanupTakeover() {
      cleanupRelinquished = true;
      const error = new StreamingOutputError(
        "outcome_unknown",
        "Output delivery moved to exact cleanup authority.",
      );
      for (const item of pending.splice(0)) item.reject(error);
      held?.fill(0);
      held = undefined;
      options.queue.cancel("Output delivery moved to exact cleanup authority.");
      outcome = "outcome_unknown";
      settlePendingWaiters(false);
    },
  });
}

function parseMetadata(input: StreamingOutputMetadata, bytes: Buffer): StreamingOutputMetadata {
  if ((input.stream !== "stdout" && input.stream !== "stderr") || !Number.isSafeInteger(input.sequence) || input.sequence < 1 || !Number.isSafeInteger(input.startOffset) || input.startOffset < 0 || !Number.isSafeInteger(input.endOffset) || input.endOffset <= input.startOffset || !Number.isSafeInteger(input.byteLength) || input.byteLength < 1 || input.endOffset - input.startOffset !== input.byteLength || input.byteLength !== bytes.byteLength) throw new StreamingOutputError("invalid_chunk", "Output metadata is invalid.");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (!/^[a-f0-9]{64}$/i.test(input.digest) || digest !== input.digest.toLowerCase()) throw new StreamingOutputError("digest_mismatch", "Output digest does not match bytes.");
  return Object.freeze({ ...input, digest });
}

function sameMetadata(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function metadataKey(metadata: StreamingOutputMetadata): string { return `${metadata.stream}\0${metadata.sequence}`; }
function sortMetadata(values: readonly StreamingOutputMetadata[]): StreamingOutputMetadata[] { return [...values].sort((left, right) => left.stream.localeCompare(right.stream) || left.sequence - right.sequence); }
function validMetadataShape(metadata: StreamingOutputMetadata): boolean {
  return (metadata.stream === "stdout" || metadata.stream === "stderr") &&
    Number.isSafeInteger(metadata.sequence) && metadata.sequence > 0 &&
    Number.isSafeInteger(metadata.startOffset) && metadata.startOffset >= 0 &&
    Number.isSafeInteger(metadata.endOffset) && metadata.endOffset > metadata.startOffset &&
    Number.isSafeInteger(metadata.byteLength) && metadata.byteLength > 0 &&
    metadata.endOffset - metadata.startOffset === metadata.byteLength &&
    typeof metadata.digest === "string" && /^[a-f0-9]{64}$/i.test(metadata.digest);
}
function fallbackMetadata(stream: StreamingOutputStream = "stdout"): StreamingOutputMetadata { return Object.freeze({ stream, sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1, digest: "0".repeat(64) }); }
