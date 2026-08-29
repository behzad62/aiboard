import { registerConsumedExecutionGrantRevoker, type ExecutionGrantBinding, type OpaqueExecutionGrant, type ConsumedExecutionGrantClaims } from "./execution-grants.js";
import type { SessionAuthority } from "./session-authority.js";
import type { StreamingSessionBackendBinding, StreamingSessionEnvelope, StreamingSessionLease, StreamingSessionStoreKernel } from "./streaming-session-store.js";
import { getStreamingSessionKernelWriter } from "./streaming-session-store.js";
import { BoundedProtocolQueue } from "./bounded-protocol-queue.js";
import { createProtocolEvidenceTee, type EvidenceSpoolSink } from "./protocol-evidence-tee.js";
import { createStreamingOutputController, type StreamingOutputChunk, type StreamingOutputStream } from "./streaming-output-controller.js";
import type { LaunchOperationAuthorizationRequest } from "./session-authority.js";

export type StreamingProcessSessionErrorCode = "lossless_output_unavailable" | "launch_failed" | "handshake_refused" | "cleanup_blocked" | "cancelled";
export class StreamingProcessSessionError extends Error { constructor(readonly code: StreamingProcessSessionErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.name = "StreamingProcessSessionError"; } }

export interface FakeStreamingChannel {
  startOutput(sink: (chunk: StreamingOutputChunk) => Promise<void>): Promise<void>;
  waitTerminal(): Promise<unknown>;
  detach(): Promise<void>;
}
export interface StreamingRuntimeOptions {
  readonly sessions: SessionAuthority;
  readonly kernel: StreamingSessionStoreKernel;
  readonly clock?: () => Date;
  readonly isolation: { acquire(input: { launchId: string; claims: ConsumedExecutionGrantClaims }): Promise<StreamingSessionLease>; release(lease: StreamingSessionLease): Promise<void> };
  readonly host: { launch(input: { launchId: string; claims: ConsumedExecutionGrantClaims; lease: StreamingSessionLease }): Promise<StreamingSessionBackendBinding>; reconcile(input: { launchId: string; record: unknown }): Promise<"cleaned" | "blocked" | "outcome_unknown"> };
  readonly channel: {
    readonly version: number;
    readonly replayCapacityChunks?: number;
    readonly replayCapacityBytes?: number;
    acquire(binding: StreamingSessionBackendBinding): Promise<FakeStreamingChannel>;
    reattach?(binding: StreamingSessionBackendBinding): Promise<Readonly<{ channel: FakeStreamingChannel; retainedWindow: readonly unknown[] }>>;
  };
  readonly handshake: { verify(channel: FakeStreamingChannel): Promise<string> };
  readonly output: {
    readonly maxQueueBytes: number; readonly maxQueueChunks: number; readonly maxFrameBytes: number; readonly maxAcceptedChunks: number;
    readonly protocolStreams: readonly StreamingOutputStream[];
    createEvidenceSpool(sessionId: string): EvidenceSpoolSink;
    authorize(stream: StreamingOutputStream): boolean;
    deliver(stream: StreamingOutputStream, bytes: Uint8Array): Promise<void>;
  };
}
export interface StreamingOpenRequest {
  readonly sessionId: string;
  readonly launchId: string;
  readonly grant: OpaqueExecutionGrant;
  readonly binding: ExecutionGrantBinding;
  readonly envelope: StreamingSessionEnvelope;
  readonly signal?: AbortSignal;
}

export function createStreamingProcessSessionRuntime(options: StreamingRuntimeOptions) {
  const clock = options.clock ?? (() => new Date());
  const writer = getStreamingSessionKernelWriter(options.kernel);
  return Object.freeze({
    async open(request: StreamingOpenRequest) {
      if (request.signal?.aborted) throw new StreamingProcessSessionError("cancelled", "Streaming launch was cancelled.");
      const staged = options.sessions.stageLaunch({ sessionId: request.sessionId, launchId: request.launchId, grant: request.grant, binding: request.binding });
      const claims = options.sessions.validateStagedLaunch(staged, request);
      const at = clock().toISOString();
      const ownerId = `host:${claims.runId}`;
      writer.prepareLaunch({
        recordKind: "runner.host-launch", schemaVersion: 1, revision: 0, launchId: request.launchId,
        sessionId: request.sessionId, runId: claims.runId, agentSessionId: claims.sessionId,
        actor: { role: claims.actor.role, id: claims.actor.id }, toolName: claims.toolName, callId: claims.callId,
        ownerId, fencingToken: 1, ownerExpiresAt: new Date(clock().getTime() + 60_000).toISOString(), state: "prepared", cleanupOwner: "host_control",
        history: [{ state: "prepared", at }], effects: [{ effectId: `isolate:${request.launchId}`, kind: "isolate", status: "pending", ownerId, fencingToken: 1, createdAt: at }],
      });
      let lease: StreamingSessionLease | undefined;
      let channel: FakeStreamingChannel | undefined;
      let protocolQueue: BoundedProtocolQueue | undefined;
      let leaseReleased = false;
      let activeEffect: Promise<void> = Promise.resolve();
      let cleanupPromise: Promise<void> | undefined;
      const settleCleanup = () => cleanupPromise ??= (async () => {
        await activeEffect;
        const record = options.kernel.store.readHostLaunch(request.launchId);
        if (!record || record.state === "handed_off" || record.state === "released" || record.state === "cleanup_blocked") return;
        let pending = record.state === "cleanup_pending" ? record : writer.transitionLaunch({ type: "begin_cleanup", launchId: request.launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, at: clock().toISOString() });
        let disposition: "cleaned" | "blocked" | "outcome_unknown" = "blocked";
        try { disposition = await options.host.reconcile({ launchId: request.launchId, record: pending }); } catch { disposition = "blocked"; }
        if (lease && !leaseReleased) { try { await options.isolation.release(lease); leaseReleased = true; } catch { disposition = "blocked"; } }
        pending = options.kernel.store.readHostLaunch(request.launchId)!;
        if (disposition === "cleaned") writer.transitionLaunch({ type: "settle_cleanup_cleaned", launchId: request.launchId, ownerId: pending.ownerId, fencingToken: pending.fencingToken, expectedRevision: pending.revision, at: clock().toISOString() });
        else writer.transitionLaunch({ type: "settle_cleanup_blocked", launchId: request.launchId, ownerId: pending.ownerId, fencingToken: pending.fencingToken, expectedRevision: pending.revision, blocker: disposition === "outcome_unknown" ? "host launch outcome unknown" : "host cleanup blocked", at: clock().toISOString() });
      })();
      const revoker = await registerConsumedExecutionGrantRevoker(claims, settleCleanup);
      const effect = <T>(operation: () => Promise<T>) => {
        const promise = Promise.resolve().then(operation);
        activeEffect = promise.then(() => undefined, () => undefined);
        return abortable(promise, request.signal);
      };
      try {
        lease = await effect(async () => {
          const acquired = await options.isolation.acquire({ launchId: request.launchId, claims });
          lease = acquired;
          return acquired;
        });
        options.sessions.validateStagedLaunch(staged, request);
        throwIfAborted(request.signal);
        let host = writer.transitionLaunch({ type: "bind_isolation", launchId: request.launchId, ownerId, fencingToken: 1, expectedRevision: 0, leaseId: lease.leaseId, providerId: lease.providerId, providerIdentity: lease.providerIdentity, at: clock().toISOString() });
        host = writer.transitionLaunch({ type: "begin_launch", launchId: request.launchId, ownerId, fencingToken: 1, expectedRevision: host.revision, at: clock().toISOString() });
        const backendBinding = await effect(() => options.host.launch({ launchId: request.launchId, claims, lease: lease! }));
        options.sessions.validateStagedLaunch(staged, request);
        throwIfAborted(request.signal);
        host = writer.transitionLaunch({ type: "bind_backend", launchId: request.launchId, ownerId, fencingToken: 1, expectedRevision: host.revision, backendBinding, at: clock().toISOString() });
        if (options.channel.version !== 2 || options.channel.replayCapacityChunks !== options.output.maxAcceptedChunks || !Number.isSafeInteger(options.channel.replayCapacityBytes) || options.channel.replayCapacityBytes! < options.output.maxQueueBytes) throw new StreamingProcessSessionError("lossless_output_unavailable", "Selected channel does not attest the exact lossless backpressured output v2 window.");
        channel = await effect(() => options.channel.acquire(backendBinding));
        options.sessions.validateStagedLaunch(staged, request);
        const sessionOwnerId = `session-authority:${claims.runId}:${claims.grantId}`;
        writer.claimOutputCheckpoint({ recordKind: "runner.output-checkpoint", schemaVersion: 1, revision: 0, sessionId: request.sessionId, ownerId: sessionOwnerId, fencingToken: 1, capacity: options.output.maxAcceptedChunks, outcome: "active", streams: [
          { stream: "stdout", lastConsumed: null, accepted: [], consumingIntent: null },
          { stream: "stderr", lastConsumed: null, accepted: [], consumingIntent: null },
        ] });
        const queue = new BoundedProtocolQueue({ maxBytes: options.output.maxQueueBytes, maxChunks: options.output.maxQueueChunks, maxFrameBytes: options.output.maxFrameBytes });
        protocolQueue = queue;
        const tee = createProtocolEvidenceTee({ queue, spool: options.output.createEvidenceSpool(request.sessionId) });
        const output = createStreamingOutputController({ kernel: options.kernel, sessionId: request.sessionId, ownerId: sessionOwnerId, fencingToken: 1, maxAcceptedChunks: options.output.maxAcceptedChunks, authorize: options.output.authorize, deliver: async (stream, _bytes) => {
          if (options.output.protocolStreams.includes(stream)) {
            const queued = await queue.read();
            if (!queued) throw new StreamingProcessSessionError("launch_failed", "Protocol queue closed unexpectedly.");
            try { await options.output.deliver(stream, queued); } finally { queued.fill(0); }
          }
        } });
        await effect(() => channel!.startOutput(async (chunk) => {
          const protocolBearing = options.output.protocolStreams.includes(chunk.metadata.stream);
          await tee.write(chunk.metadata.stream, chunk.bytes, protocolBearing);
          if (protocolBearing) await output.accept(chunk);
          else await output.acceptEvidenceOnly(chunk);
        }));
        options.sessions.validateStagedLaunch(staged, request);
        const handshakeDigest = await effect(() => options.handshake.verify(channel!));
        options.sessions.validateStagedLaunch(staged, request);
        throwIfAborted(request.signal);
        host = writer.transitionLaunch({ type: "verify_handshake", launchId: request.launchId, ownerId, fencingToken: 1, expectedRevision: host.revision, handshakeDigest, at: clock().toISOString() });
        const adopted = options.sessions.finalizeLaunch({ staged, launchId: request.launchId, sessionId: request.sessionId, ownerId, fencingToken: 1, expectedRevision: host.revision, lease, backendBinding, handshakeDigest, envelope: request.envelope });
        revoker.dispose();
        return Object.freeze({
          sessionId: request.sessionId,
          record: adopted.record,
          authorizeFirstOperation: (operation: LaunchOperationAuthorizationRequest) => options.sessions.authorizeLaunchOperation(operation),
        });
      } catch (error) {
        protocolQueue?.cancel("Streaming launch failed before adoption.");
        await channel?.detach().catch(() => undefined);
        await settleCleanup();
        revoker.dispose();
        if (request.signal?.aborted && !(error instanceof StreamingProcessSessionError)) throw new StreamingProcessSessionError("cancelled", "Streaming launch was cancelled.", { cause: error });
        throw error;
      }
    },
    async reconcileStartup(input: { readonly maxRecords: number }) {
      if (!Number.isSafeInteger(input.maxRecords) || input.maxRecords < 1) throw new StreamingProcessSessionError("launch_failed", "Recovery bound is invalid.");
      const outcomes: Array<{ launchId: string; disposition: "cleaned" | "blocked" | "outcome_unknown" }> = [];
      for (const launchId of options.kernel.store.listHostLaunchIds().slice(0, input.maxRecords)) {
        let record = options.kernel.store.readHostLaunch(launchId)!;
        if (record.state === "handed_off" || record.state === "released") continue;
        if (record.state === "cleanup_blocked") { outcomes.push({ launchId, disposition: "blocked" }); continue; }
        if (record.state !== "cleanup_pending") record = writer.transitionLaunch({ type: "begin_cleanup", launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, at: clock().toISOString() });
        const disposition = await options.host.reconcile({ launchId, record });
        const current = options.kernel.store.readHostLaunch(launchId)!;
        if (disposition === "cleaned") writer.transitionLaunch({ type: "settle_cleanup_cleaned", launchId, ownerId: current.ownerId, fencingToken: current.fencingToken, expectedRevision: current.revision, at: clock().toISOString() });
        else writer.transitionLaunch({ type: "settle_cleanup_blocked", launchId, ownerId: current.ownerId, fencingToken: current.fencingToken, expectedRevision: current.revision, blocker: disposition === "outcome_unknown" ? "host launch outcome unknown" : "host cleanup blocked", at: clock().toISOString() });
        outcomes.push({ launchId, disposition });
      }
      const sessionOutcomes: Array<{ sessionId: string; disposition: "reattached" | "input_unavailable" | "outcome_unknown" }> = [];
      let remaining = Math.max(0, input.maxRecords - outcomes.length);
      for (const sessionId of options.kernel.store.listSessionIds()) {
        if (remaining-- <= 0) break;
        const session = options.kernel.store.readBySession(sessionId)!;
        if (session.state !== "active") continue;
        if (!options.channel.reattach) {
          options.sessions.recordDisposition({ sessionId, ownerId: session.ownerId, fencingToken: session.fencingToken, expectedRevision: session.revision, disposition: "input_unavailable" });
          sessionOutcomes.push({ sessionId, disposition: "input_unavailable" }); continue;
        }
        let reattached: Awaited<ReturnType<NonNullable<typeof options.channel.reattach>>>;
        try { reattached = await options.channel.reattach(session.backendBinding); }
        catch {
          options.sessions.recordDisposition({ sessionId, ownerId: session.ownerId, fencingToken: session.fencingToken, expectedRevision: session.revision, disposition: "input_unavailable" });
          sessionOutcomes.push({ sessionId, disposition: "input_unavailable" }); continue;
        }
        const checkpoint = options.kernel.store.readOutputCheckpoint(sessionId);
        if (checkpoint) {
          const expected = checkpoint.streams.flatMap((stream) => stream.accepted);
          const retained = reattached.retainedWindow;
          const matches = !checkpoint.streams.some((stream) => stream.consumingIntent) && expected.length === retained.length && expected.every((entry, index) => JSON.stringify(entry) === JSON.stringify(retained[index]));
          if (!matches) {
            if (checkpoint.outcome === "active") writer.applyOutputCheckpoint({ type: "mark_outcome_unknown", sessionId, ownerId: checkpoint.ownerId, fencingToken: checkpoint.fencingToken, expectedRevision: checkpoint.revision, metadata: retained[0] ?? { stream: "stdout", sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1, digest: "0".repeat(64) } });
            options.sessions.recordDisposition({ sessionId, ownerId: session.ownerId, fencingToken: session.fencingToken, expectedRevision: session.revision, disposition: "outcome_unknown" });
            await reattached.channel.detach(); sessionOutcomes.push({ sessionId, disposition: "outcome_unknown" }); continue;
          }
        }
        sessionOutcomes.push({ sessionId, disposition: "reattached" });
      }
      return Object.freeze({ processed: outcomes.length + sessionOutcomes.length, outcomes: Object.freeze(outcomes.map((entry) => Object.freeze(entry))), sessionOutcomes: Object.freeze(sessionOutcomes.map((entry) => Object.freeze(entry))) });
    },
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StreamingProcessSessionError("cancelled", "Streaming launch was cancelled.");
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new StreamingProcessSessionError("cancelled", "Streaming launch was cancelled."));
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}
