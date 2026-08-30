import { registerConsumedExecutionGrantRevoker, type ConsumedExecutionGrantClaims, type ExecutionGrantBinding, type OpaqueExecutionGrant } from "./execution-grants.js";
import type { LaunchOperationAuthorizationRequest, OperationAuthorizationAssertion, SessionAuthority, SessionOperationAuthorization, SessionOperationRequest } from "./session-authority.js";
import type { StreamingSessionBackendBinding, StreamingSessionEnvelope, StreamingSessionLease, StreamingSessionStoreKernel } from "./streaming-session-store.js";
import { getStreamingSessionKernelWriter } from "./streaming-session-store.js";
import { BoundedProtocolQueue } from "./bounded-protocol-queue.js";
import { createProtocolEvidenceTee, type EvidenceSpoolSink } from "./protocol-evidence-tee.js";
import { createStreamingOutputController, type StreamingOutputMetadata, type StreamingOutputStream } from "./streaming-output-controller.js";
import { BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION, type BackpressuredOutputAcknowledgement, type BackpressuredOutputMetadata } from "./interactive-process-channel.js";

export type StreamingProcessSessionErrorCode = "lossless_output_unavailable" | "launch_failed" | "handshake_refused" | "cleanup_blocked" | "cancelled";
export class StreamingProcessSessionError extends Error { constructor(readonly code: StreamingProcessSessionErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.name = "StreamingProcessSessionError"; } }

export interface FakeStreamingChannel {
  subscribeBackpressuredOutput(sink: (metadata: BackpressuredOutputMetadata, ownedBytes: Uint8Array) => Promise<BackpressuredOutputAcknowledgement>): () => void;
  observeTerminal?(sink: (result: unknown) => void): () => void;
  detach(): Promise<void>;
}
interface ReattachedFakeChannel {
  readonly version: typeof BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION;
  readonly binding: StreamingSessionBackendBinding;
  readonly channel: FakeStreamingChannel;
  readonly retainedWindow: readonly StreamingOutputMetadata[];
  readonly replayCapacityChunks: number;
  readonly replayCapacityBytes: number;
}
export interface StreamingRuntimeOptions {
  readonly sessions: SessionAuthority;
  readonly kernel: StreamingSessionStoreKernel;
  readonly clock?: () => Date;
  readonly isolation: { acquire(input: { launchId: string; claims: ConsumedExecutionGrantClaims }): Promise<StreamingSessionLease>; release(lease: StreamingSessionLease): Promise<void> };
  readonly host: { launch(input: { launchId: string; claims: ConsumedExecutionGrantClaims; lease: StreamingSessionLease }): Promise<StreamingSessionBackendBinding>; reconcile(input: { launchId: string; record: unknown }): Promise<"cleaned" | "blocked" | "outcome_unknown"> };
  readonly channel: {
    readonly version: number; readonly replayCapacityChunks?: number; readonly replayCapacityBytes?: number;
    acquire(binding: StreamingSessionBackendBinding): Promise<FakeStreamingChannel>;
    reattach?(binding: StreamingSessionBackendBinding): Promise<ReattachedFakeChannel>;
  };
  readonly handshake: { verify(channel: FakeStreamingChannel): Promise<string> };
  readonly output: {
    readonly maxQueueBytes: number; readonly maxQueueChunks: number; readonly maxFrameBytes: number; readonly maxAcceptedChunks: number;
    readonly protocolStreams: readonly StreamingOutputStream[];
    createEvidenceSpool(sessionId: string): EvidenceSpoolSink & Required<Pick<EvidenceSpoolSink, "finalize" | "cleanup">>;
    deliver(stream: StreamingOutputStream, bytes: Uint8Array): Promise<void>;
  };
}
export interface StreamingOpenRequest { readonly sessionId: string; readonly launchId: string; readonly grant: OpaqueExecutionGrant; readonly binding: ExecutionGrantBinding; readonly envelope: StreamingSessionEnvelope; readonly signal?: AbortSignal }

type OutputController = ReturnType<typeof createStreamingOutputController>;
type FinalizedEvidence = Awaited<ReturnType<ReturnType<typeof createProtocolEvidenceTee>["finalize"]>>;
interface PrivateAttachment { readonly channel: FakeStreamingChannel; readonly output: OutputController; readonly tee: ReturnType<typeof createProtocolEvidenceTee>; readonly onPreAdoptionFailure?: (error: unknown) => Promise<void>; unsubscribe: () => void; unobserve: () => void; closed: boolean; detached: boolean; closing?: Promise<FinalizedEvidence>; settling?: Promise<void>; finalizedEvidence?: FinalizedEvidence; failure?: unknown }
interface PendingLateCleanup { readonly channel: FakeStreamingChannel; readonly launchId?: string; failure: unknown; detaching?: Promise<void>; detached: boolean }

export function createStreamingProcessSessionRuntime(options: StreamingRuntimeOptions) {
  const clock = options.clock ?? (() => new Date());
  const writer = getStreamingSessionKernelWriter(options.kernel);
  const attachments = new Map<string, PrivateAttachment>();
  const lateCleanupChannels = new Map<string, PendingLateCleanup>();

  const assertV2 = (chunks = options.channel.replayCapacityChunks, bytes = options.channel.replayCapacityBytes) => {
    if (options.channel.version !== BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION || chunks !== options.output.maxAcceptedChunks || !Number.isSafeInteger(bytes) || bytes! < options.output.maxQueueBytes) throw new StreamingProcessSessionError("lossless_output_unavailable", "Selected channel does not attest the exact aggregate lossless output v2 window.");
  };
  const finalizedEvidence = new Map<string, FinalizedEvidence>();
  const createAttachment = (sessionId: string, ownerId: string, fencingToken: number, channel: FakeStreamingChannel, onPreAdoptionFailure?: (error: unknown) => Promise<void>): PrivateAttachment => {
    const queue = new BoundedProtocolQueue({ maxBytes: options.output.maxQueueBytes, maxChunks: options.output.maxQueueChunks, maxFrameBytes: options.output.maxFrameBytes });
    const tee = createProtocolEvidenceTee({ queue, spool: options.output.createEvidenceSpool(sessionId) });
    const output = createStreamingOutputController({
      kernel: options.kernel, sessionId, ownerId, fencingToken, maxAcceptedChunks: options.output.maxAcceptedChunks,
      queue, protocolStreams: options.output.protocolStreams, writeEvidence: tee.writeEvidence,
      assertAuthorization: (authorization, expected) => options.sessions.assertOperationAuthorization(authorization, expected),
      deliver: options.output.deliver,
    });
    const attachment: PrivateAttachment = { channel, output, tee, onPreAdoptionFailure, unsubscribe: () => undefined, unobserve: () => undefined, closed: false, detached: false };
    return attachment;
  };
  const startAttachment = (sessionId: string, attachment: PrivateAttachment) => {
    const { channel, output } = attachment;
    attachment.unsubscribe = channel.subscribeBackpressuredOutput(async (metadata, ownedBytes) => {
      try { return await output.accept(metadata, ownedBytes); }
      catch (error) {
        const session = options.kernel.store.readBySession(sessionId);
        if (session?.state === "active") await settleAdoptedAttachment(sessionId, attachment, "outcome_unknown", error);
        else await attachment.onPreAdoptionFailure?.(error);
        throw error;
      }
    });
    attachment.unobserve = channel.observeTerminal?.(() => {
      const session = options.kernel.store.readBySession(sessionId);
      if (session?.state === "active") void settleAdoptedAttachment(sessionId, attachment, "backend_unavailable").catch((error) => { attachment.failure = error; });
    }) ?? (() => undefined);
  };
  const closeAttachment = async (sessionId: string, attachment: PrivateAttachment) => {
    if (attachment.closed) return attachment.finalizedEvidence!;
    if (attachment.closing) return await attachment.closing;
    attachment.closing = (async () => {
    const errors: unknown[] = [];
    try { attachment.unsubscribe(); } catch (error) { errors.push(error); }
    try { attachment.unobserve(); } catch (error) { errors.push(error); }
    attachment.output.cancel("Streaming session attachment closed.");
    try {
      const evidence = await attachment.tee.finalize(); attachment.finalizedEvidence = evidence; finalizedEvidence.set(sessionId, evidence);
      if ("error" in evidence) { errors.push(evidence.error); try { await attachment.tee.cleanup(); } catch (error) { errors.push(error); } }
    } catch (error) { errors.push(error); }
    if (!attachment.detached) try { await attachment.channel.detach(); attachment.detached = true; } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Streaming attachment cleanup failed.");
    attachment.closed = true; attachments.delete(sessionId);
    return attachment.finalizedEvidence!;
    })();
    try { return await attachment.closing; } finally { if (!attachment.closed) attachment.closing = undefined; }
  };
  const settleAdoptedAttachment = async (sessionId: string, attachment: PrivateAttachment, disposition: "backend_unavailable" | "outcome_unknown", originalError?: unknown) => {
    if (attachment.settling) return await attachment.settling;
    attachment.settling = (async () => {
    let record = options.kernel.store.readBySession(sessionId);
    if (!record) throw new StreamingProcessSessionError("launch_failed", "Adopted session record disappeared during cleanup.");
    if (record.state === "active") record = options.sessions.recordDisposition({ sessionId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, disposition }).record;
    const ownerId = record.ownerId; const fencingToken = record.fencingToken;
    if (record.state !== "cleanup_pending" && record.state !== "cleanup_blocked") record = writer.apply({ type: "begin_cleanup", sessionId, ownerId, fencingToken, expectedRevision: record.revision, effectId: `cleanup:${sessionId}:${fencingToken}`, at: clock().toISOString() });
    const assertCleanupOwner = () => {
      const current = options.kernel.store.readBySession(sessionId);
      if (!current || current.state !== "cleanup_pending" || current.ownerId !== ownerId || current.fencingToken !== fencingToken || Date.parse(current.leaseExpiresAt) <= clock().getTime()) throw new StreamingProcessSessionError("cleanup_blocked", "Adopted cleanup authority became stale.");
    };
    const cleanupErrors: unknown[] = [];
    try { assertCleanupOwner(); await closeAttachment(sessionId, attachment); } catch (error) { cleanupErrors.push(error); }
    try {
      assertCleanupOwner();
      const launchId = options.kernel.store.listHostLaunchIds().find((id) => options.kernel.store.readHostLaunch(id)?.sessionId === sessionId);
      if (!launchId || await options.host.reconcile({ launchId, record }) !== "cleaned") throw new StreamingProcessSessionError("cleanup_blocked", "Exact adopted host cleanup was not verified.");
    } catch (error) { cleanupErrors.push(error); }
    try { assertCleanupOwner(); await options.isolation.release(record.lease); } catch (error) { cleanupErrors.push(error); }
    options.sessions.recoverAdopted({ sessionId, ownerId, fencingToken, replay: () => cleanupErrors.length ? "blocked" : "cleaned" });
    if (cleanupErrors.length || originalError) throw new AggregateError([originalError, ...cleanupErrors].filter((error) => error !== undefined), "Adopted streaming session failed and was durably settled.");
    })();
    return await attachment.settling;
  };

  return Object.freeze({
    async open(request: StreamingOpenRequest) {
      throwIfAborted(request.signal);
      const staged = options.sessions.stageLaunch({ sessionId: request.sessionId, launchId: request.launchId, grant: request.grant, binding: request.binding });
      const claims = options.sessions.validateStagedLaunch(staged, request);
      const at = clock().toISOString(); const ownerId = `host:${claims.runId}`;
      writer.prepareLaunch({ recordKind: "runner.host-launch", schemaVersion: 1, revision: 0, launchId: request.launchId, sessionId: request.sessionId, runId: claims.runId, agentSessionId: claims.sessionId, actor: { role: claims.actor.role, id: claims.actor.id }, toolName: claims.toolName, callId: claims.callId, ownerId, fencingToken: 1, ownerExpiresAt: new Date(clock().getTime() + 60_000).toISOString(), state: "prepared", cleanupOwner: "host_control", history: [{ state: "prepared", at }], effects: [{ effectId: `isolate:${request.launchId}`, kind: "isolate", status: "pending", ownerId, fencingToken: 1, createdAt: at }] });
      let lease: StreamingSessionLease | undefined; let channel: FakeStreamingChannel | undefined; let attachment: PrivateAttachment | undefined; let leaseReleased = false; let activeEffect: Promise<void> = Promise.resolve(); let effectPending = false; let activeEffectKind: "isolate" | "launch" | "channel" | "handshake" | undefined; let cancelledEffectKind: typeof activeEffectKind; let cleanupPromise: Promise<void> | undefined; let hostDisposition: "cleaned" | "blocked" | "outcome_unknown" | undefined; let hostReconcile: Promise<void> | undefined; let leaseRelease: Promise<void> | undefined; let resourceCleanupFailed = false; let cancellationCleanupBarrier: Promise<void> | undefined;
      const channelDetaches = new WeakMap<FakeStreamingChannel, Promise<void>>();
      const releaseKnownLease = () => {
        if (!lease || leaseReleased) return undefined;
        return leaseRelease ??= (async () => { await options.isolation.release(lease!); leaseReleased = true; })();
      };
      const settleCleanup = () => cleanupPromise ??= (async () => {
        await activeEffect;
        if (cancellationCleanupBarrier) try { await cancellationCleanupBarrier; } catch { resourceCleanupFailed = true; }
        let record = options.kernel.store.readHostLaunch(request.launchId);
        if (!record || record.state === "handed_off" || record.state === "released") return;
        if (Date.parse(record.ownerExpiresAt) <= clock().getTime()) record = writer.transitionLaunch({ type: "takeover_cleanup", launchId: request.launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, newOwnerId: `late-cleanup:${request.launchId}`, newFencingToken: record.fencingToken + 1, ownerExpiresAt: new Date(clock().getTime() + 60_000).toISOString(), at: clock().toISOString() });
        if (record.state !== "cleanup_pending") record = writer.transitionLaunch({ type: "begin_cleanup", launchId: request.launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, at: clock().toISOString() });
        let disposition = hostDisposition ?? "blocked";
        if (hostDisposition === undefined || cancelledEffectKind === "launch") try { disposition = await options.host.reconcile({ launchId: request.launchId, record }); } catch { disposition = "blocked"; }
        try { await releaseKnownLease(); } catch { disposition = "blocked"; }
        if (resourceCleanupFailed) disposition = "blocked";
        record = options.kernel.store.readHostLaunch(request.launchId)!;
        if (disposition === "cleaned") writer.transitionLaunch({ type: "settle_cleanup_cleaned", launchId: request.launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, at: clock().toISOString() });
        else writer.transitionLaunch({ type: "settle_cleanup_blocked", launchId: request.launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, blocker: disposition === "outcome_unknown" ? "host launch outcome unknown" : "host cleanup blocked", at: clock().toISOString() });
      })();
      const revoker = await registerConsumedExecutionGrantRevoker(claims, settleCleanup);
      const effect = <T>(kind: NonNullable<typeof activeEffectKind>, operation: () => Promise<T>) => { effectPending = true; activeEffectKind = kind; const promise = Promise.resolve().then(() => { options.sessions.validateStagedLaunch(staged, request); throwIfAborted(request.signal); return operation(); }); activeEffect = promise.then(() => { effectPending = false; }, () => { effectPending = false; }); return abortable(promise, request.signal); };
      const cleanupKnownResources = async () => {
          const currentAttachment = attachment; const currentChannel = channel;
          const detachCleanup = (async () => {
            if (currentAttachment) await closeAttachment(request.sessionId, currentAttachment);
            else if (currentChannel) {
              let detaching = channelDetaches.get(currentChannel);
              if (!detaching) { detaching = currentChannel.detach(); channelDetaches.set(currentChannel, detaching); }
              await detaching;
            }
          })();
          const checkpointCleanup = detachCleanup.then(() => {
            if (!options.kernel.store.readBySession(request.sessionId)) {
              const checkpoint = options.kernel.store.readOutputCheckpoint(request.sessionId);
              if (checkpoint) writer.deleteOutputCheckpoint({ sessionId: request.sessionId, ownerId: checkpoint.ownerId, fencingToken: checkpoint.fencingToken, expectedRevision: checkpoint.revision });
            }
          });
          if (!hostReconcile) hostReconcile = (async () => { try { hostDisposition = await options.host.reconcile({ launchId: request.launchId, record: options.kernel.store.readHostLaunch(request.launchId) }); } catch (error) { hostDisposition = "blocked"; throw error; } })();
          releaseKnownLease();
          const results = await Promise.allSettled([detachCleanup, checkpointCleanup, hostReconcile, ...(leaseRelease ? [leaseRelease] : [])]);
          if (results[0]?.status === "rejected" && currentChannel && !currentAttachment?.detached) lateCleanupChannels.set(request.sessionId, { channel: currentChannel, launchId: request.launchId, failure: results[0].reason, detached: false });
          const cleanupErrors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
          if (cleanupErrors.length) { resourceCleanupFailed = true; throw new AggregateError(cleanupErrors, "Known streaming launch cleanup failed."); }
      };
      const cleanupOpenResources = async () => {
        const cleanupErrors: unknown[] = [];
        try { await cleanupKnownResources(); } catch (failure) { cleanupErrors.push(failure); }
        try { await settleCleanup(); } catch (failure) { cleanupErrors.push(failure); }
        if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Late streaming launch cleanup failed.");
      };
      const blockUnresolvedEffect = () => {
        let record = options.kernel.store.readHostLaunch(request.launchId);
        if (!record || record.state === "released" || record.state === "handed_off") return;
        if (Date.parse(record.ownerExpiresAt) <= clock().getTime()) record = writer.transitionLaunch({ type: "takeover_cleanup", launchId: request.launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, newOwnerId: `cancel-cleanup:${request.launchId}`, newFencingToken: record.fencingToken + 1, ownerExpiresAt: new Date(clock().getTime() + 60_000).toISOString(), at: clock().toISOString() });
        if (record.state !== "cleanup_pending" && record.state !== "cleanup_blocked") record = writer.transitionLaunch({ type: "begin_cleanup", launchId: request.launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, at: clock().toISOString() });
        if (record.state === "cleanup_pending") writer.transitionLaunch({ type: "settle_cleanup_blocked", launchId: request.launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, blocker: "provider effect unresolved after cancellation", at: clock().toISOString() });
      };
      try {
        lease = await effect("isolate", async () => lease = await options.isolation.acquire({ launchId: request.launchId, claims }));
        options.sessions.validateStagedLaunch(staged, request); throwIfAborted(request.signal);
        let host = writer.transitionLaunch({ type: "bind_isolation", launchId: request.launchId, ownerId, fencingToken: 1, expectedRevision: 0, lease, at: clock().toISOString() });
        host = writer.transitionLaunch({ type: "begin_launch", launchId: request.launchId, ownerId, fencingToken: 1, expectedRevision: host.revision, at: clock().toISOString() });
        const backendBinding = await effect("launch", () => options.host.launch({ launchId: request.launchId, claims, lease: lease! }));
        options.sessions.validateStagedLaunch(staged, request); throwIfAborted(request.signal);
        host = writer.transitionLaunch({ type: "bind_backend", launchId: request.launchId, ownerId, fencingToken: 1, expectedRevision: host.revision, backendBinding, at: clock().toISOString() });
        assertV2(); channel = await effect("channel", async () => channel = await options.channel.acquire(backendBinding)); options.sessions.validateStagedLaunch(staged, request);
        const sessionOwnerId = `session-authority:${claims.runId}:${claims.grantId}`;
        writer.claimOutputCheckpoint({ recordKind: "runner.output-checkpoint", schemaVersion: 1, revision: 0, sessionId: request.sessionId, ownerId: sessionOwnerId, fencingToken: 1, capacity: options.output.maxAcceptedChunks, outcome: "active", streams: [{ stream: "stdout", lastConsumed: null, consumed: [], accepted: [], consumingIntent: null }, { stream: "stderr", lastConsumed: null, consumed: [], accepted: [], consumingIntent: null }] });
        attachment = createAttachment(request.sessionId, sessionOwnerId, 1, channel, async () => await settleCleanup()); startAttachment(request.sessionId, attachment);
        options.sessions.validateStagedLaunch(staged, request);
        const handshakeDigest = await effect("handshake", () => options.handshake.verify(channel!)); options.sessions.validateStagedLaunch(staged, request); throwIfAborted(request.signal);
        host = writer.transitionLaunch({ type: "verify_handshake", launchId: request.launchId, ownerId, fencingToken: 1, expectedRevision: host.revision, handshakeDigest, at: clock().toISOString() });
        const adopted = options.sessions.finalizeLaunch({ staged, launchId: request.launchId, sessionId: request.sessionId, ownerId, fencingToken: 1, expectedRevision: host.revision, lease, backendBinding, handshakeDigest, envelope: request.envelope });
        attachments.set(request.sessionId, attachment); revoker.dispose();
        return Object.freeze({
          sessionId: request.sessionId, record: adopted.record,
          authorizeFirstOperation: (operation: LaunchOperationAuthorizationRequest) => options.sessions.authorizeLaunchOperation(operation),
          authorizeOperation: (operation: SessionOperationRequest) => options.sessions.authorizeOperation(operation),
          deliverOutput: (authorization: SessionOperationAuthorization, assertion: OperationAuthorizationAssertion) => attachment!.output.deliverNext(authorization, assertion),
          stop: async (authorization: SessionOperationAuthorization, assertion: OperationAuthorizationAssertion) => { options.sessions.assertOperationAuthorization(authorization, { ...assertion, sessionId: request.sessionId, operation: "stop" }); await settleAdoptedAttachment(request.sessionId, attachment!, "backend_unavailable"); return Object.freeze({ record: options.kernel.store.readBySession(request.sessionId), evidence: finalizedEvidence.get(request.sessionId) }); },
        });
      } catch (error) {
        if (request.signal?.aborted && effectPending) {
          cancelledEffectKind = activeEffectKind;
          blockUnresolvedEffect();
          const immediateCleanup = cleanupKnownResources();
          cancellationCleanupBarrier = activeEffect.then(async () => {
            const lateCleanup = cleanupKnownResources();
            const results = await Promise.allSettled([immediateCleanup, lateCleanup]);
            const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
            if (failures.length) throw new AggregateError(failures, "Cancelled streaming launch cleanup failed.");
          });
          void cancellationCleanupBarrier.then(settleCleanup, settleCleanup).catch((failure) => { if (attachment) attachment.failure = failure; });
          try { await bounded(immediateCleanup, 100); } catch (failure) { if (attachment) attachment.failure = failure; }
          revoker.dispose();
          throw error instanceof StreamingProcessSessionError ? error : new StreamingProcessSessionError("cancelled", "Streaming launch was cancelled.", { cause: error });
        }
        await activeEffect;
        let cleanupError: unknown; try { await cleanupOpenResources(); } catch (failure) { cleanupError = failure; }
        revoker.dispose();
        if (cleanupError) throw new AggregateError([error, cleanupError], "Streaming launch and cleanup failed.");
        if (request.signal?.aborted && !(error instanceof StreamingProcessSessionError)) throw new StreamingProcessSessionError("cancelled", "Streaming launch was cancelled.", { cause: error });
        throw error;
      }
    },
    async reconcileStartup(input: { readonly maxRecords: number; readonly timeoutMs?: number; readonly signal?: AbortSignal }) {
      if (!Number.isSafeInteger(input.maxRecords) || input.maxRecords < 1) throw new StreamingProcessSessionError("launch_failed", "Recovery count bound is invalid.");
      const timeoutMs = input.timeoutMs ?? 1_000; if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new StreamingProcessSessionError("launch_failed", "Recovery time bound is invalid.");
      throwIfAborted(input.signal);
      const deadline = Date.now() + timeoutMs;
      const remainingTime = () => { const remaining = deadline - Date.now(); if (remaining <= 0) throw new StreamingProcessSessionError("launch_failed", "Streaming recovery exhausted its total deadline."); return remaining; };
      let inspected = 0;
      const surfacedLateCleanupFailures = new Map([...lateCleanupChannels].map(([sessionId, pending]) => [sessionId, failureMessage(pending.failure)]));
      const resolvedLateLaunches = new Set<string>();
      for (const [sessionId, pending] of lateCleanupChannels) {
        throwIfAborted(input.signal); if (inspected >= input.maxRecords) break; inspected++;
        try {
          if (pending.detached) { lateCleanupChannels.delete(sessionId); if (pending.launchId) resolvedLateLaunches.add(pending.launchId); continue; }
          if (!pending.detaching) pending.detaching = pending.channel.detach().then(() => { pending.detached = true; }, (error) => { pending.detaching = undefined; throw error; });
          await bounded(pending.detaching, remainingTime(), input.signal); lateCleanupChannels.delete(sessionId); if (pending.launchId) resolvedLateLaunches.add(pending.launchId);
        }
        catch (failure) { pending.failure = failure; lateCleanupChannels.set(sessionId, pending); }
      }
      const outcomes: Array<{ launchId: string; disposition: "cleaned" | "blocked" | "outcome_unknown" }> = [];
      for (const launchId of options.kernel.store.listHostLaunchIds()) {
        throwIfAborted(input.signal);
        if (inspected >= input.maxRecords) break; inspected++;
        let record = options.kernel.store.readHostLaunch(launchId)!; if (record.state === "handed_off" || record.state === "released") continue;
        if (record.state === "cleanup_blocked" && Date.parse(record.ownerExpiresAt) > clock().getTime() && !resolvedLateLaunches.has(launchId)) { outcomes.push({ launchId, disposition: "blocked" }); continue; }
        if (Date.parse(record.ownerExpiresAt) <= clock().getTime()) record = writer.transitionLaunch({ type: "takeover_cleanup", launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, newOwnerId: `recovery:${launchId}`, newFencingToken: record.fencingToken + 1, ownerExpiresAt: new Date(clock().getTime() + timeoutMs + 60_000).toISOString(), at: clock().toISOString() });
        else if (record.state !== "cleanup_pending") record = writer.transitionLaunch({ type: "begin_cleanup", launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, at: clock().toISOString() });
        let disposition: "cleaned" | "blocked" | "outcome_unknown";
        try { const waitMs = remainingTime(); disposition = await bounded(options.host.reconcile({ launchId, record }), waitMs, input.signal); } catch { disposition = "blocked"; }
        const current = options.kernel.store.readHostLaunch(launchId)!;
        writer.transitionLaunch({ type: disposition === "cleaned" ? "settle_cleanup_cleaned" : "settle_cleanup_blocked", launchId, ownerId: current.ownerId, fencingToken: current.fencingToken, expectedRevision: current.revision, ...(disposition === "cleaned" ? {} : { blocker: disposition === "outcome_unknown" ? "host launch outcome unknown" : "host cleanup blocked" }), at: clock().toISOString() });
        outcomes.push({ launchId, disposition });
      }
      const sessionOutcomes: Array<{ sessionId: string; disposition: "reattached" | "input_unavailable" | "outcome_unknown"; cleanupBlocked?: boolean }> = [];
      for (const sessionId of options.kernel.store.listSessionIds()) {
        throwIfAborted(input.signal);
        if (inspected >= input.maxRecords) break; inspected++; let session = options.kernel.store.readBySession(sessionId)!; if (session.state !== "active") continue;
        let checkpoint = options.kernel.store.readOutputCheckpoint(sessionId);
        if (Date.parse(session.leaseExpiresAt) <= clock().getTime()) {
          if (!checkpoint) { sessionOutcomes.push({ sessionId, disposition: "outcome_unknown", cleanupBlocked: true }); continue; }
          try {
            const taken = writer.takeoverAdoptedWithOutput({ sessionId, ownerId: session.ownerId, fencingToken: session.fencingToken, expectedRevision: session.revision, outputExpectedRevision: checkpoint.revision, newOwnerId: `recovery-session:${sessionId}`, newFencingToken: session.fencingToken + 1, leaseExpiresAt: new Date(clock().getTime() + timeoutMs + 60_000).toISOString(), at: clock().toISOString() });
            session = taken.session; checkpoint = taken.output;
          } catch { sessionOutcomes.push({ sessionId, disposition: "outcome_unknown", cleanupBlocked: true }); continue; }
        }
        if (!checkpoint || checkpoint.ownerId !== session.ownerId || checkpoint.fencingToken !== session.fencingToken || !options.channel.reattach) { const disposition = !checkpoint || (checkpoint && (checkpoint.ownerId !== session.ownerId || checkpoint.fencingToken !== session.fencingToken)) ? "outcome_unknown" : "input_unavailable"; options.sessions.recordDisposition({ sessionId, ownerId: session.ownerId, fencingToken: session.fencingToken, expectedRevision: session.revision, disposition }); sessionOutcomes.push({ sessionId, disposition }); continue; }
        let reattached: ReattachedFakeChannel;
        try {
          const waitMs = remainingTime();
          const provider = Promise.resolve().then(() => options.channel.reattach!(session.backendBinding));
          reattached = await boundedLateResource(provider, waitMs, input.signal, async (late) => {
            let lateAttachment: PrivateAttachment | undefined;
            let settlementFailure: unknown; let cleanupFailure: unknown;
            try { lateAttachment = createAttachment(sessionId, checkpoint.ownerId, checkpoint.fencingToken, late.channel); await settleAdoptedAttachment(sessionId, lateAttachment, "backend_unavailable"); }
            catch (error) { settlementFailure = error; }
            finally { try { if (lateAttachment) await closeAttachment(sessionId, lateAttachment); else await late.channel.detach(); } catch (error) { cleanupFailure = error; } }
            if (settlementFailure) {
              const current = options.kernel.store.readBySession(sessionId);
              if (current && current.state !== "released" && current.state !== "cleanup_blocked") try { options.sessions.recoverAdopted({ sessionId, ownerId: current.ownerId, fencingToken: current.fencingToken, replay: () => "blocked" }); } catch {}
            }
            if (cleanupFailure) throw new AggregateError([cleanupFailure], "Late reattach resource cleanup failed.");
          }, (late, failure) => {
            lateCleanupChannels.set(sessionId, { channel: late.channel, failure, detached: false });
            const current = options.kernel.store.readBySession(sessionId);
            if (current && current.state !== "released" && current.state !== "cleanup_blocked") try { options.sessions.recoverAdopted({ sessionId, ownerId: current.ownerId, fencingToken: current.fencingToken, replay: () => "blocked" }); } catch {}
          });
        }
        catch { options.sessions.recordDisposition({ sessionId, ownerId: session.ownerId, fencingToken: session.fencingToken, expectedRevision: session.revision, disposition: "input_unavailable" }); sessionOutcomes.push({ sessionId, disposition: "input_unavailable" }); continue; }
        if (reattached.version !== BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION || !same(reattached.binding, session.backendBinding) || reattached.replayCapacityChunks !== checkpoint.capacity || reattached.replayCapacityBytes < options.output.maxQueueBytes) {
          options.sessions.recordDisposition({ sessionId, ownerId: session.ownerId, fencingToken: session.fencingToken, expectedRevision: session.revision, disposition: "outcome_unknown" });
          let cleanupBlocked = false; try { await bounded(reattached.channel.detach(), remainingTime(), input.signal); } catch { cleanupBlocked = true; options.sessions.recoverAdopted({ sessionId, ownerId: session.ownerId, fencingToken: session.fencingToken, replay: () => "blocked" }); }
          sessionOutcomes.push({ sessionId, disposition: "outcome_unknown", ...(cleanupBlocked ? { cleanupBlocked } : {}) }); continue;
        }
        const attachment = createAttachment(sessionId, checkpoint.ownerId, checkpoint.fencingToken, reattached.channel);
        try { attachment.output.attestRetainedWindow(reattached.retainedWindow); }
        catch (error) {
          options.sessions.recordDisposition({ sessionId, ownerId: session.ownerId, fencingToken: session.fencingToken, expectedRevision: session.revision, disposition: "outcome_unknown" });
          let cleanupBlocked = false;
          try { await bounded(closeAttachment(sessionId, attachment), remainingTime(), input.signal); }
          catch (cleanupError) { cleanupBlocked = true; attachment.failure = new AggregateError([error, cleanupError], "Recovered output cleanup blocked."); attachments.set(sessionId, attachment); options.sessions.recoverAdopted({ sessionId, ownerId: session.ownerId, fencingToken: session.fencingToken, replay: () => "blocked" }); }
          sessionOutcomes.push({ sessionId, disposition: "outcome_unknown", ...(cleanupBlocked ? { cleanupBlocked } : {}) }); continue;
        }
        startAttachment(sessionId, attachment);
        attachments.set(sessionId, attachment); sessionOutcomes.push({ sessionId, disposition: "reattached" });
      }
      for (const [sessionId, pending] of lateCleanupChannels) surfacedLateCleanupFailures.set(sessionId, failureMessage(pending.failure));
      const lateCleanupFailures = Object.freeze([...surfacedLateCleanupFailures].map(([sessionId, message]) => Object.freeze({ sessionId, message })));
      return Object.freeze({ processed: inspected, outcomes: Object.freeze(outcomes), sessionOutcomes: Object.freeze(sessionOutcomes), lateCleanupFailures });
    },
  });
}

function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw new StreamingProcessSessionError("cancelled", "Streaming operation was cancelled."); }
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> { return bounded(promise, undefined, signal); }
function bounded<T>(promise: Promise<T>, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal); return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort); callback(); };
    const abort = () => finish(() => reject(new StreamingProcessSessionError("cancelled", "Streaming operation was cancelled.")));
    signal?.addEventListener("abort", abort, { once: true });
    if (timeoutMs !== undefined) timer = setTimeout(() => finish(() => reject(new StreamingProcessSessionError("launch_failed", "Streaming operation exceeded its recovery bound."))), timeoutMs);
    promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
  });
}
function boundedLateResource<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined, cleanup: (late: T) => Promise<void>, onCleanupFailure: (late: T, error: unknown) => void): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => finish(() => reject(new StreamingProcessSessionError("launch_failed", "Streaming operation exceeded its recovery bound."))), timeoutMs);
    const abort = () => finish(() => reject(new StreamingProcessSessionError("cancelled", "Streaming operation was cancelled.")));
    const finish = (complete: () => void) => { if (finished) return false; finished = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); complete(); return true; };
    signal?.addEventListener("abort", abort, { once: true });
    promise.then((value) => { if (!finish(() => resolve(value))) void cleanup(value).catch((error) => onCleanupFailure(value, error)); }, (error) => { finish(() => reject(error)); });
  });
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function failureMessage(error: unknown): string {
  if (error instanceof AggregateError) return [error.message, ...error.errors.map(failureMessage)].join(": ");
  return error instanceof Error ? error.message : "Late cleanup failed.";
}
