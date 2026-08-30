import { createHash } from "node:crypto";
import { registerConsumedExecutionGrantRevoker, type ConsumedExecutionGrantClaims, type ExecutionGrantBinding, type OpaqueExecutionGrant } from "./execution-grants.js";
import type { LaunchOperationAuthorizationRequest, OperationAuthorizationAssertion, SessionAuthority, SessionOperationAuthorization, SessionOperationRequest } from "./session-authority.js";
import type { HostCleanupFailure, HostCleanupFailureCode, HostCleanupResourceFact, HostLaunchRecord, StreamingSessionBackendBinding, StreamingSessionEnvelope, StreamingSessionLease, StreamingSessionStoreKernel } from "./streaming-session-store.js";
import { HOST_CLEANUP_FAILURE_MESSAGES, HOST_LAUNCH_RECORD_VERSION, getStreamingSessionKernelWriter } from "./streaming-session-store.js";
import { BoundedProtocolQueue } from "./bounded-protocol-queue.js";
import { createProtocolEvidenceTee, type EvidenceSpoolSink } from "./protocol-evidence-tee.js";
import { createStreamingOutputController, type StreamingOutputMetadata, type StreamingOutputStream } from "./streaming-output-controller.js";
import { BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION, type BackpressuredOutputAcknowledgement, type BackpressuredOutputMetadata } from "./interactive-process-channel.js";

export type StreamingProcessSessionErrorCode = "lossless_output_unavailable" | "launch_failed" | "handshake_refused" | "cleanup_blocked" | "cancelled";
export class StreamingProcessSessionError extends Error { constructor(readonly code: StreamingProcessSessionErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.name = "StreamingProcessSessionError"; } }
type RunnerSessionErrorClaims = Readonly<{ code: StreamingProcessSessionErrorCode; message: string }>;
const RUNNER_SESSION_ERROR_CLAIMS = new WeakMap<StreamingProcessSessionError, RunnerSessionErrorClaims>();
function runnerSessionError(code: StreamingProcessSessionErrorCode, message: string): StreamingProcessSessionError {
  const error = new StreamingProcessSessionError(code, message); RUNNER_SESSION_ERROR_CLAIMS.set(error, Object.freeze({ code, message })); return error;
}
function runnerSessionErrorClaims(error: unknown): RunnerSessionErrorClaims | undefined {
  return typeof error === "object" && error !== null ? RUNNER_SESSION_ERROR_CLAIMS.get(error as StreamingProcessSessionError) : undefined;
}
function remintRunnerSessionError(error: unknown): StreamingProcessSessionError | undefined {
  const claims = runnerSessionErrorClaims(error); return claims ? runnerSessionError(claims.code, claims.message) : undefined;
}
class CleanupClassificationError extends Error { constructor(readonly failureCode: HostCleanupFailureCode) { super(HOST_CLEANUP_FAILURE_MESSAGES[failureCode]); } }

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
interface PendingLateCleanup { readonly channel: FakeStreamingChannel; failure: unknown; detaching?: Promise<void>; detached: boolean }
interface HostCleanupChannelCapability { readonly sessionId: string; readonly identity: string; readonly channel: FakeStreamingChannel; cleanup?: () => Promise<unknown>; detached: boolean; failed?: boolean; detaching?: Promise<void> }

export function createStreamingProcessSessionRuntime(options: StreamingRuntimeOptions) {
  const clock = options.clock ?? (() => new Date());
  const writer = getStreamingSessionKernelWriter(options.kernel);
  const attachments = new Map<string, PrivateAttachment>();
  const lateCleanupChannels = new Map<string, PendingLateCleanup>();
  const hostCleanupChannels = new Map<string, HostCleanupChannelCapability>();
  const hostCleanupFailures = new Map<string, Readonly<{ sessionId: string; failure: HostCleanupFailure }>>();
  const unresolvedProviderEffects = new Set<string>();
  const hostCleanupRuns = new Map<string, Promise<"cleaned" | "blocked" | "outcome_unknown">>();
  const cleanupResourceRuns = new Map<string, Promise<void>>();

  const cleanupEffect = (record: Readonly<HostLaunchRecord>) => record.effects.find((effect) => effect.kind === "cleanup");
  const beginHostCleanup = (record: Readonly<HostLaunchRecord>) => {
    if (record.state === "released" || record.state === "handed_off") return record;
    if (record.state === "cleanup_pending") return record;
    return writer.transitionLaunch({ type: "begin_cleanup", launchId: record.launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, at: clock().toISOString() });
  };
  const performHostCleanup = async (launchId: string, timeoutMs = 1_000, signal?: AbortSignal) => {
    let record = options.kernel.store.readHostLaunch(launchId);
    if (!record || record.state === "released" || record.state === "handed_off") return "cleaned" as const;
    if (record.state === "cleanup_blocked" && Date.parse(record.ownerExpiresAt) <= clock().getTime()) record = writer.transitionLaunch({ type: "takeover_cleanup", launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, newOwnerId: `recovery:${launchId}`, newFencingToken: record.fencingToken + 1, ownerExpiresAt: new Date(clock().getTime() + timeoutMs + 60_000).toISOString(), at: clock().toISOString() });
    else if (record.state !== "cleanup_blocked") record = beginHostCleanup(record);
    const effect = cleanupEffect(record);
    const resourceFacts = [...(effect?.resources ?? [])];
    const pending = resourceFacts.filter((resource) => resource.status !== "succeeded");
    if (!pending.length) {
      const released = writer.transitionLaunch({ type: "settle_cleanup_cleaned", launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, results: [], at: clock().toISOString() });
      hostCleanupFailures.delete(launchId); return released.state === "released" ? "cleaned" as const : "blocked" as const;
    }
    const results = await Promise.all(pending.map(async (resource) => {
      try {
        await bounded(runCleanupResource(record!, resource), timeoutMs, signal);
        if (resource.resource === "host" && unresolvedProviderEffects.has(record!.launchId)) throw new CleanupClassificationError("cleanup_timeout_or_cancelled");
        return Object.freeze({ resource: resource.resource, identity: resource.identity, ownerId: resource.ownerId, fencingToken: resource.fencingToken, status: "succeeded" as const });
      } catch (error) {
        return Object.freeze({ resource: resource.resource, identity: resource.identity, ownerId: resource.ownerId, fencingToken: resource.fencingToken, status: "failed" as const, failure: classifyCleanupFailure(resource.resource, error) });
      }
    }));
    record = options.kernel.store.readHostLaunch(launchId)!;
    if (record.state === "cleanup_blocked") record = beginHostCleanup(record);
    const failures = results.filter((result) => result.status === "failed");
    if (failures.length) {
      writer.transitionLaunch({ type: "settle_cleanup_blocked", launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, blocker: failures[0]!.failure, results, at: clock().toISOString() });
      hostCleanupFailures.set(launchId, Object.freeze({ sessionId: record.sessionId, failure: failures[0]!.failure }));
      return failures.some((failure) => failure.failure.code === "host_outcome_unknown") ? "outcome_unknown" as const : "blocked" as const;
    }
    writer.transitionLaunch({ type: "settle_cleanup_cleaned", launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, results, at: clock().toISOString() });
    hostCleanupChannels.delete(launchId);
    return "cleaned" as const;
  };
  const runHostCleanup = (launchId: string, timeoutMs = 1_000, signal?: AbortSignal) => {
    const existing = hostCleanupRuns.get(launchId); if (existing) return existing;
    const running = performHostCleanup(launchId, timeoutMs, signal).finally(() => { if (hostCleanupRuns.get(launchId) === running) hostCleanupRuns.delete(launchId); });
    hostCleanupRuns.set(launchId, running); return running;
  };
  const cleanupResource = async (record: Readonly<HostLaunchRecord>, resource: Readonly<HostCleanupResourceFact>) => {
    if (resource.resource === "host") {
      if (resource.identity !== `host:${record.launchId}`) throw runnerSessionError("cleanup_blocked", "Exact host cleanup identity is unavailable.");
      const disposition = await options.host.reconcile({ launchId: record.launchId, record });
      if (disposition === "outcome_unknown") throw new CleanupClassificationError("host_outcome_unknown");
      if (disposition !== "cleaned") throw runnerSessionError("cleanup_blocked", "Exact host cleanup was not verified.");
      return;
    }
    if (resource.resource === "isolation_lease") {
      if (!record.leaseBinding || resource.identity !== leaseCleanupIdentity(record.leaseBinding)) throw runnerSessionError("cleanup_blocked", "Exact isolation lease cleanup identity is unavailable.");
      await options.isolation.release(record.leaseBinding); return;
    }
    if (resource.resource === "output_checkpoint") {
      if (resource.identity !== `checkpoint:${record.sessionId}`) throw runnerSessionError("cleanup_blocked", "Exact output checkpoint cleanup identity is unavailable.");
      const checkpoint = options.kernel.store.readOutputCheckpoint(record.sessionId);
      if (checkpoint) writer.deleteOutputCheckpoint({ sessionId: record.sessionId, ownerId: checkpoint.ownerId, fencingToken: checkpoint.fencingToken, expectedRevision: checkpoint.revision });
      return;
    }
    const capability = hostCleanupChannels.get(record.launchId);
    if (!record.backendBinding || resource.identity !== channelCleanupIdentity(record.sessionId, record.backendBinding) || !capability || capability.identity !== resource.identity) throw runnerSessionError("cleanup_blocked", "Exact channel cleanup capability is unavailable.");
    if (capability.detached) return;
    if (resource.status === "failed" && capability.failed) { capability.detaching = undefined; capability.failed = false; }
    capability.detaching ??= Promise.resolve(capability.cleanup ? capability.cleanup() : capability.channel.detach()).then(() => { capability.detached = true; }, (error) => { capability.failed = true; throw remintRunnerSessionError(error) ?? error; });
    await capability.detaching;
  };
  const runCleanupResource = (record: Readonly<HostLaunchRecord>, resource: Readonly<HostCleanupResourceFact>) => {
    const key = `${record.launchId}\0${resource.resource}\0${resource.identity}`; const existing = cleanupResourceRuns.get(key); if (existing) return existing;
    const running = cleanupResource(record, resource).catch((error) => { if (cleanupResourceRuns.get(key) === running) cleanupResourceRuns.delete(key); throw remintRunnerSessionError(error) ?? error; });
    cleanupResourceRuns.set(key, running); return running;
  };

  const assertV2 = (chunks = options.channel.replayCapacityChunks, bytes = options.channel.replayCapacityBytes) => {
    if (options.channel.version !== BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION || chunks !== options.output.maxAcceptedChunks || !Number.isSafeInteger(bytes) || bytes! < options.output.maxQueueBytes) throw runnerSessionError("lossless_output_unavailable", "Selected channel does not attest the exact aggregate lossless output v2 window.");
  };
  const finalizedEvidence = new Map<string, FinalizedEvidence>();
  const createAttachment = (sessionId: string, ownerId: string, fencingToken: number, channel: FakeStreamingChannel, onPreAdoptionFailure?: (error: unknown) => Promise<void>): PrivateAttachment => {
    const queue = new BoundedProtocolQueue({ maxBytes: options.output.maxQueueBytes, maxChunks: options.output.maxQueueChunks, maxFrameBytes: options.output.maxFrameBytes });
    const tee = createProtocolEvidenceTee({ queue, spool: options.output.createEvidenceSpool(sessionId) });
    const output = createStreamingOutputController({
      kernel: options.kernel, sessionId, ownerId, fencingToken, maxAcceptedChunks: options.output.maxAcceptedChunks,
      queue, protocolStreams: options.output.protocolStreams, writeEvidence: tee.writeEvidence,
      assertAuthorization: (authorization, expected) => options.sessions.assertOperationAuthorization(authorization, expected),
      deliver: async (stream, bytes) => {
        try { await options.output.deliver(stream, bytes); }
        catch { throw runnerSessionError("launch_failed", "Streaming output delivery failed."); }
      },
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
        throw remintRunnerSessionError(error) ?? error;
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
    if (!record) throw runnerSessionError("launch_failed", "Adopted session record disappeared during cleanup.");
    if (record.state === "active") record = options.sessions.recordDisposition({ sessionId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, disposition }).record;
    const ownerId = record.ownerId; const fencingToken = record.fencingToken;
    if (record.state !== "cleanup_pending" && record.state !== "cleanup_blocked") record = writer.apply({ type: "begin_cleanup", sessionId, ownerId, fencingToken, expectedRevision: record.revision, effectId: `cleanup:${sessionId}:${fencingToken}`, at: clock().toISOString() });
    const assertCleanupOwner = () => {
      const current = options.kernel.store.readBySession(sessionId);
      if (!current || current.state !== "cleanup_pending" || current.ownerId !== ownerId || current.fencingToken !== fencingToken || Date.parse(current.leaseExpiresAt) <= clock().getTime()) throw runnerSessionError("cleanup_blocked", "Adopted cleanup authority became stale.");
    };
    const cleanupErrors: unknown[] = [];
    try { assertCleanupOwner(); await closeAttachment(sessionId, attachment); } catch (error) { cleanupErrors.push(error); }
    try {
      assertCleanupOwner();
      const launchId = options.kernel.store.listHostLaunchIds().find((id) => options.kernel.store.readHostLaunch(id)?.sessionId === sessionId);
      if (!launchId || await options.host.reconcile({ launchId, record }) !== "cleaned") throw runnerSessionError("cleanup_blocked", "Exact adopted host cleanup was not verified.");
    } catch (error) { cleanupErrors.push(error); }
    try { assertCleanupOwner(); await options.isolation.release(record.lease); } catch (error) { cleanupErrors.push(error); }
    options.sessions.recoverAdopted({ sessionId, ownerId, fencingToken, replay: () => cleanupErrors.length ? "blocked" : "cleaned" });
    if (cleanupErrors.length || originalError) throw runnerSessionError("cleanup_blocked", "Adopted streaming session cleanup failed.");
    })();
    return await attachment.settling;
  };

  return Object.freeze({
    async open(request: StreamingOpenRequest) {
      throwIfAborted(request.signal);
      const staged = options.sessions.stageLaunch({ sessionId: request.sessionId, launchId: request.launchId, grant: request.grant, binding: request.binding });
      const claims = options.sessions.validateStagedLaunch(staged, request);
      const at = clock().toISOString(); const ownerId = `host:${claims.runId}`;
      writer.prepareLaunch({ recordKind: "runner.host-launch", schemaVersion: HOST_LAUNCH_RECORD_VERSION, revision: 0, launchId: request.launchId, sessionId: request.sessionId, runId: claims.runId, agentSessionId: claims.sessionId, actor: { role: claims.actor.role, id: claims.actor.id }, toolName: claims.toolName, callId: claims.callId, ownerId, fencingToken: 1, ownerExpiresAt: new Date(clock().getTime() + 60_000).toISOString(), state: "prepared", cleanupOwner: "host_control", history: [{ state: "prepared", at }], effects: [{ effectId: `isolate:${request.launchId}`, kind: "isolate", status: "pending", ownerId, fencingToken: 1, createdAt: at }] });
      let lease: StreamingSessionLease | undefined; let backendBinding: StreamingSessionBackendBinding | undefined; let channel: FakeStreamingChannel | undefined; let attachment: PrivateAttachment | undefined; let activeEffect: Promise<void> = Promise.resolve(); let effectPending = false; let activeEffectKind: "isolate" | "launch" | "channel" | "handshake" | undefined; let cleanupPromise: Promise<void> | undefined;
      const bindKnownResults = () => {
        let durable = options.kernel.store.readHostLaunch(request.launchId);
        if (!durable || durable.state === "released" || durable.state === "handed_off") return;
        if (durable.state === "cleanup_blocked" && lease && !durable.leaseBinding) {
          durable = writer.transitionLaunch({ type: "bind_cleanup_isolation", launchId: request.launchId, ownerId: durable.ownerId, fencingToken: durable.fencingToken, expectedRevision: durable.revision, lease, at: clock().toISOString() });
        }
        if (durable.state === "cleanup_pending" || durable.state === "cleanup_blocked") return;
        if (durable.state === "prepared" && lease) durable = writer.transitionLaunch({ type: "bind_isolation", launchId: request.launchId, ownerId: durable.ownerId, fencingToken: durable.fencingToken, expectedRevision: durable.revision, lease, at: clock().toISOString() });
        if (durable.state === "isolated" && backendBinding) durable = writer.transitionLaunch({ type: "begin_launch", launchId: request.launchId, ownerId: durable.ownerId, fencingToken: durable.fencingToken, expectedRevision: durable.revision, at: clock().toISOString() });
        if (durable.state === "launching" && backendBinding) writer.transitionLaunch({ type: "bind_backend", launchId: request.launchId, ownerId: durable.ownerId, fencingToken: durable.fencingToken, expectedRevision: durable.revision, backendBinding, at: clock().toISOString() });
      };
      const settleCleanup = () => cleanupPromise ??= activeEffect.then(async () => { bindKnownResults(); await runHostCleanup(request.launchId, 1_000); });
      const revoker = await registerConsumedExecutionGrantRevoker(claims, settleCleanup);
      const effect = <T>(kind: NonNullable<typeof activeEffectKind>, operation: () => Promise<T>) => { effectPending = true; activeEffectKind = kind; const promise = Promise.resolve().then(() => { options.sessions.validateStagedLaunch(staged, request); throwIfAborted(request.signal); return operation(); }); activeEffect = promise.then(() => { effectPending = false; }, () => { effectPending = false; }); return abortable(promise, request.signal); };
      const cleanupOpenResources = async () => {
        await activeEffect; bindKnownResults(); await runHostCleanup(request.launchId, 1_000);
      };
      const blockUnresolvedEffect = () => {
        let record = options.kernel.store.readHostLaunch(request.launchId);
        if (!record || record.state === "released" || record.state === "handed_off") return;
        if (Date.parse(record.ownerExpiresAt) <= clock().getTime()) record = writer.transitionLaunch({ type: "takeover_cleanup", launchId: request.launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, newOwnerId: `cancel-cleanup:${request.launchId}`, newFencingToken: record.fencingToken + 1, ownerExpiresAt: new Date(clock().getTime() + 60_000).toISOString(), at: clock().toISOString() });
        record = beginHostCleanup(record);
        if (record.state === "cleanup_pending") {
          const resources = cleanupEffect(record)?.resources ?? [];
          const failure = cleanupFailure("cleanup_timeout_or_cancelled");
          const results = resources.filter((resource) => resource.status !== "succeeded").map((resource) => ({ resource: resource.resource, identity: resource.identity, ownerId: resource.ownerId, fencingToken: resource.fencingToken, status: "failed" as const, failure }));
          writer.transitionLaunch({ type: "settle_cleanup_blocked", launchId: request.launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, blocker: failure, results, at: clock().toISOString() });
        }
      };
      try {
        lease = await effect("isolate", async () => {
          const acquired = await options.isolation.acquire({ launchId: request.launchId, claims }); lease = acquired;
          if (request.signal?.aborted) bindKnownResults();
          return acquired;
        });
        options.sessions.validateStagedLaunch(staged, request); throwIfAborted(request.signal);
        let host = writer.transitionLaunch({ type: "bind_isolation", launchId: request.launchId, ownerId, fencingToken: 1, expectedRevision: 0, lease, at: clock().toISOString() });
        host = writer.transitionLaunch({ type: "begin_launch", launchId: request.launchId, ownerId, fencingToken: 1, expectedRevision: host.revision, at: clock().toISOString() });
        backendBinding = await effect("launch", async () => backendBinding = await options.host.launch({ launchId: request.launchId, claims, lease: lease! }));
        if (!backendBinding) throw runnerSessionError("launch_failed", "Streaming backend binding is unavailable after launch.");
        const exactBackendBinding = backendBinding;
        options.sessions.validateStagedLaunch(staged, request); throwIfAborted(request.signal);
        host = writer.transitionLaunch({ type: "bind_backend", launchId: request.launchId, ownerId, fencingToken: 1, expectedRevision: host.revision, backendBinding: exactBackendBinding, at: clock().toISOString() });
        assertV2(); host = writer.transitionLaunch({ type: "begin_channel", launchId: request.launchId, ownerId, fencingToken: 1, expectedRevision: host.revision, at: clock().toISOString() });
        channel = await effect("channel", async () => {
          const acquired = await options.channel.acquire(exactBackendBinding);
          channel = acquired;
          const cleanupCapability: HostCleanupChannelCapability = { sessionId: request.sessionId, identity: channelCleanupIdentity(request.sessionId, exactBackendBinding), channel: acquired, detached: false };
          hostCleanupChannels.set(request.launchId, cleanupCapability);
          if (request.signal?.aborted) { cleanupCapability.detaching = acquired.detach().then(() => { cleanupCapability.detached = true; }, (error) => { cleanupCapability.failed = true; throw remintRunnerSessionError(error) ?? error; }); void cleanupCapability.detaching.catch(() => undefined); }
          return acquired;
        }); options.sessions.validateStagedLaunch(staged, request);
        const sessionOwnerId = `session-authority:${claims.runId}:${claims.grantId}`;
        host = writer.claimHostOutputCheckpoint({ launchId: request.launchId, ownerId, fencingToken: 1, expectedRevision: host.revision, at: clock().toISOString(), record: { recordKind: "runner.output-checkpoint", schemaVersion: 1, revision: 0, sessionId: request.sessionId, ownerId: sessionOwnerId, fencingToken: 1, capacity: options.output.maxAcceptedChunks, outcome: "active", streams: [{ stream: "stdout", lastConsumed: null, consumed: [], accepted: [], consumingIntent: null }, { stream: "stderr", lastConsumed: null, consumed: [], accepted: [], consumingIntent: null }] } }).host;
        attachment = createAttachment(request.sessionId, sessionOwnerId, 1, channel, async () => await settleCleanup());
        const cleanupCapability = hostCleanupChannels.get(request.launchId); if (cleanupCapability) cleanupCapability.cleanup = async () => await closeAttachment(request.sessionId, attachment!);
        startAttachment(request.sessionId, attachment);
        options.sessions.validateStagedLaunch(staged, request);
        const handshakeDigest = await effect("handshake", () => options.handshake.verify(channel!)); options.sessions.validateStagedLaunch(staged, request); throwIfAborted(request.signal);
        host = writer.transitionLaunch({ type: "verify_handshake", launchId: request.launchId, ownerId, fencingToken: 1, expectedRevision: host.revision, handshakeDigest, at: clock().toISOString() });
        const adopted = options.sessions.finalizeLaunch({ staged, launchId: request.launchId, sessionId: request.sessionId, ownerId, fencingToken: 1, expectedRevision: host.revision, lease, backendBinding, handshakeDigest, envelope: request.envelope });
        attachments.set(request.sessionId, attachment); revoker.dispose();
        return Object.freeze({
          sessionId: request.sessionId, record: adopted.record,
          authorizeFirstOperation: (operation: LaunchOperationAuthorizationRequest) => options.sessions.authorizeLaunchOperation(operation),
          authorizeOperation: (operation: SessionOperationRequest) => options.sessions.authorizeOperation(operation),
          deliverOutput: async (authorization: SessionOperationAuthorization, assertion: OperationAuthorizationAssertion) => {
            try { return await attachment!.output.deliverNext(authorization, assertion); }
            catch (error) { if (error instanceof Error) { const reminted = remintRunnerSessionError(error.cause); if (reminted) throw reminted; } throw remintRunnerSessionError(error) ?? error; }
          },
          stop: async (authorization: SessionOperationAuthorization, assertion: OperationAuthorizationAssertion) => { options.sessions.assertOperationAuthorization(authorization, { ...assertion, sessionId: request.sessionId, operation: "stop" }); await settleAdoptedAttachment(request.sessionId, attachment!, "backend_unavailable"); return Object.freeze({ record: options.kernel.store.readBySession(request.sessionId), evidence: finalizedEvidence.get(request.sessionId) }); },
        });
      } catch (error) {
        if (request.signal?.aborted && effectPending) {
          unresolvedProviderEffects.add(request.launchId);
          blockUnresolvedEffect();
          const immediateCleanup = runHostCleanup(request.launchId, 25);
          void activeEffect.then(async () => { unresolvedProviderEffects.delete(request.launchId); try { await immediateCleanup; } catch {} bindKnownResults(); cleanupPromise = undefined; if (hostCleanupChannels.get(request.launchId)?.failed) return; await runHostCleanup(request.launchId, 25); }).catch((failure) => { if (attachment) attachment.failure = failure; });
          try { await bounded(immediateCleanup, 75); } catch (failure) { if (attachment) attachment.failure = failure; }
          revoker.dispose();
          throw remintRunnerSessionError(error) ?? runnerSessionError("cancelled", "Streaming launch was cancelled.");
        }
        await activeEffect;
        let cleanupError: unknown; try { await cleanupOpenResources(); } catch (failure) { cleanupError = failure; }
        revoker.dispose();
        if (cleanupError) throw runnerSessionError("cleanup_blocked", "Streaming launch cleanup failed.");
        if (request.signal?.aborted && !runnerSessionErrorClaims(error)) throw runnerSessionError("cancelled", "Streaming launch was cancelled.");
        const reminted = remintRunnerSessionError(error); if (reminted) throw reminted;
        throw runnerSessionError(activeEffectKind === "handshake" ? "handshake_refused" : "launch_failed", activeEffectKind === "handshake" ? "Streaming handshake was refused." : "Streaming provider launch phase failed.");
      }
    },
    async reconcileStartup(input: { readonly maxRecords: number; readonly timeoutMs?: number; readonly signal?: AbortSignal }) {
      if (!Number.isSafeInteger(input.maxRecords) || input.maxRecords < 1) throw runnerSessionError("launch_failed", "Recovery count bound is invalid.");
      const timeoutMs = input.timeoutMs ?? 1_000; if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw runnerSessionError("launch_failed", "Recovery time bound is invalid.");
      throwIfAborted(input.signal);
      const deadline = Date.now() + timeoutMs;
      const remainingTime = () => { const remaining = deadline - Date.now(); if (remaining <= 0) throw runnerSessionError("launch_failed", "Streaming recovery exhausted its total deadline."); return remaining; };
      let inspected = 0;
      const surfacedLateCleanupFailures = new Map([...lateCleanupChannels].map(([sessionId]) => [sessionId, cleanupFailure("channel_detach_failed")]));
      for (const failure of hostCleanupFailures.values()) surfacedLateCleanupFailures.set(failure.sessionId, failure.failure);
      for (const launchId of options.kernel.store.listHostLaunchIds()) {
        const durable = options.kernel.store.readHostLaunch(launchId); const failures = durable && cleanupEffect(durable)?.resources?.filter((resource) => resource.status === "failed").map((resource) => resource.failure).filter((failure): failure is HostCleanupFailure => Boolean(failure));
        if (durable && failures?.length) surfacedLateCleanupFailures.set(durable.sessionId, failures[0]!);
      }
      for (const [sessionId, pending] of lateCleanupChannels) {
        throwIfAborted(input.signal); if (inspected >= input.maxRecords) break; inspected++;
        try {
          if (pending.detached) { lateCleanupChannels.delete(sessionId); continue; }
          if (!pending.detaching) pending.detaching = pending.channel.detach().then(() => { pending.detached = true; }, (error) => { pending.detaching = undefined; throw remintRunnerSessionError(error) ?? error; });
          await bounded(pending.detaching, remainingTime(), input.signal); lateCleanupChannels.delete(sessionId);
        }
        catch (failure) { pending.failure = failure; lateCleanupChannels.set(sessionId, pending); }
      }
      const outcomes: Array<{ launchId: string; disposition: "cleaned" | "blocked" | "outcome_unknown" }> = [];
      for (const launchId of options.kernel.store.listHostLaunchIds()) {
        throwIfAborted(input.signal);
        if (inspected >= input.maxRecords) break; inspected++;
        const record = options.kernel.store.readHostLaunch(launchId)!; if (record.state === "handed_off" || record.state === "released") continue;
        let disposition: "cleaned" | "blocked" | "outcome_unknown" = "blocked";
        try { const waitMs = remainingTime(); disposition = await bounded(runHostCleanup(launchId, waitMs, input.signal), waitMs, input.signal); } catch { disposition = "blocked"; }
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
      for (const [sessionId] of lateCleanupChannels) surfacedLateCleanupFailures.set(sessionId, cleanupFailure("channel_detach_failed"));
      for (const failure of hostCleanupFailures.values()) surfacedLateCleanupFailures.set(failure.sessionId, failure.failure);
      const lateCleanupFailures = Object.freeze([...surfacedLateCleanupFailures].map(([sessionId, failure]) => Object.freeze({ sessionId, code: failure.code, message: failure.message })));
      for (const [launchId] of hostCleanupFailures) if (options.kernel.store.readHostLaunch(launchId)?.state === "released") hostCleanupFailures.delete(launchId);
      return Object.freeze({ processed: inspected, outcomes: Object.freeze(outcomes), sessionOutcomes: Object.freeze(sessionOutcomes), lateCleanupFailures });
    },
  });
}

function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw runnerSessionError("cancelled", "Streaming operation was cancelled."); }
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> { return bounded(promise, undefined, signal); }
function bounded<T>(promise: Promise<T>, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal); return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort); callback(); };
    const abort = () => finish(() => reject(runnerSessionError("cancelled", "Streaming operation was cancelled.")));
    signal?.addEventListener("abort", abort, { once: true });
    if (timeoutMs !== undefined) timer = setTimeout(() => finish(() => reject(runnerSessionError("launch_failed", "Streaming operation exceeded its recovery bound."))), timeoutMs);
    promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(remintRunnerSessionError(error) ?? error)));
  });
}
function boundedLateResource<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined, cleanup: (late: T) => Promise<void>, onCleanupFailure: (late: T, error: unknown) => void): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => finish(() => reject(runnerSessionError("launch_failed", "Streaming operation exceeded its recovery bound."))), timeoutMs);
    const abort = () => finish(() => reject(runnerSessionError("cancelled", "Streaming operation was cancelled.")));
    const finish = (complete: () => void) => { if (finished) return false; finished = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); complete(); return true; };
    signal?.addEventListener("abort", abort, { once: true });
    promise.then((value) => { if (!finish(() => resolve(value))) void cleanup(value).catch((error) => onCleanupFailure(value, remintRunnerSessionError(error) ?? error)); }, (error) => { finish(() => reject(remintRunnerSessionError(error) ?? error)); });
  });
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function cleanupFailure(code: HostCleanupFailureCode): HostCleanupFailure { return Object.freeze({ code, message: HOST_CLEANUP_FAILURE_MESSAGES[code] }); }
function classifyCleanupFailure(resource: HostCleanupResourceFact["resource"], error: unknown): HostCleanupFailure {
  if (error instanceof CleanupClassificationError) return cleanupFailure(error.failureCode);
  const claims = runnerSessionErrorClaims(error);
  if (claims?.code === "cancelled" || claims?.code === "launch_failed") return cleanupFailure("cleanup_timeout_or_cancelled");
  const code: Record<HostCleanupResourceFact["resource"], HostCleanupFailureCode> = {
    channel: "channel_detach_failed", output_checkpoint: "output_checkpoint_delete_failed",
    host: "host_reconciliation_failed", isolation_lease: "isolation_lease_release_failed",
  };
  return cleanupFailure(code[resource] ?? "unknown_internal_cleanup_failure");
}
function leaseCleanupIdentity(lease: StreamingSessionLease): string { return `lease:${createHash("sha256").update(JSON.stringify(lease)).digest("hex")}`; }
function channelCleanupIdentity(sessionId: string, binding: StreamingSessionBackendBinding): string { return `channel:${createHash("sha256").update(JSON.stringify({ sessionId, binding })).digest("hex")}`; }
