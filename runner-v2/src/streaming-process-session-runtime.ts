import { assertSessionEnvelopeSubset } from "./session-authority.js";
import { createStreamingRequestOperation } from "./streaming-request-operation.js";
import { createHash } from "node:crypto";
import type { ArtifactStore } from "./artifact-store.js";
import { verifyFinalizedEvidence, createEvidenceContinuation, initialEvidenceContinuation } from "./evidence-continuation.js";
import { registerConsumedExecutionGrantRevoker, type ConsumedExecutionGrantClaims, type ExecutionGrantBinding, type OpaqueExecutionGrant } from "./execution-grants.js";
import type { LaunchOperationAuthorizationRequest, OperationAuthorizationAssertion, SessionAuthority, SessionOperationAuthorization, SessionOperationRequest } from "./session-authority.js";
import type { AdoptedCleanupBlockerCode, AdoptedCleanupEvidenceReference, AdoptedCleanupResourceFact, AdoptedCleanupResourceKind, HostCleanupFailure, HostCleanupFailureCode, HostCleanupResourceFact, HostLaunchRecord, StreamingSessionBackendBinding, StreamingSessionEnvelope, StreamingSessionLease, StreamingSessionRecord, StreamingSessionStoreKernel } from "./streaming-session-store.js";
import { ADOPTED_CLEANUP_BLOCKER_MESSAGES, HOST_CLEANUP_FAILURE_MESSAGES, HOST_LAUNCH_RECORD_VERSION, getStreamingSessionKernelWriter, validateFinalizedEvidenceObservation } from "./streaming-session-store.js";
import { BoundedProtocolQueue } from "./bounded-protocol-queue.js";
import { createProtocolEvidenceTee, type EvidenceSpoolSink } from "./protocol-evidence-tee.js";
import { createStreamingOutputController, type StreamingOutputMetadata, type StreamingOutputStream } from "./streaming-output-controller.js";
import { BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION, type BackpressuredOutputAcknowledgement, type BackpressuredOutputMetadata, type BackpressuredOutputSettlement, type InteractiveProcessChannel } from "./interactive-process-channel.js";

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

const SESSION_OWNERSHIP_LEASE_MS = 60_000;
const SESSION_OWNERSHIP_RENEW_WINDOW_MS = 20_000;
const CLEANUP_SETTLEMENT_RESERVE_MS = 1_000;

export interface FakeStreamingChannel {
  settleBackpressuredOutput?(deadlineAt: number): Promise<BackpressuredOutputSettlement>;
  subscribeBackpressuredOutput(sink: (metadata: BackpressuredOutputMetadata, ownedBytes: Uint8Array) => Promise<BackpressuredOutputAcknowledgement>): () => void;
  observeTerminal?(sink: (result: unknown) => void): () => void;
  detach(): Promise<unknown>;
}
interface ReattachedFakeChannel {
  readonly version: typeof BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION;
  readonly binding: StreamingSessionBackendBinding;
  readonly channel: FakeStreamingChannel;
  readonly retainedWindow: readonly StreamingOutputMetadata[];
  readonly cleanupBootstrap?: Readonly<{
    version: 1;
    consumed: Readonly<Record<StreamingOutputStream, Readonly<{ sequence: number; endOffset: number }>>>;
    pendingAcknowledgements: number;
  }>;
  readonly replayCapacityChunks: number;
  readonly replayCapacityBytes: number;
}
export interface StreamingRuntimeOptions {
  readonly sessions: SessionAuthority;
  readonly kernel: StreamingSessionStoreKernel;
  readonly clock?: () => Date;
  readonly isolation: { acquire(input: { launchId: string; claims: ConsumedExecutionGrantClaims }): Promise<StreamingSessionLease>; release(lease: StreamingSessionLease): Promise<void> };
  readonly host: {
    launch(input: { launchId: string; claims: ConsumedExecutionGrantClaims; lease: StreamingSessionLease }): Promise<StreamingSessionBackendBinding>;
    quiesce(input: { launchId: string; record: unknown; fence: Readonly<{ ownerId: string; fencingToken: number }>; deadlineAt: number }): Promise<"verified" | "blocked" | "outcome_unknown">;
    observeQuiescence(input: { launchId: string; record: unknown; fence: Readonly<{ ownerId: string; fencingToken: number }>; deadlineAt: number }): Promise<"verified" | "blocked" | "outcome_unknown">;
    release(input: { launchId: string; record: unknown; fence: Readonly<{ ownerId: string; fencingToken: number }>; deadlineAt: number }): Promise<"verified" | "blocked" | "outcome_unknown">;
  };
  readonly channel: {
    readonly version: number; readonly replayCapacityChunks?: number; readonly replayCapacityBytes?: number;
    acquire(binding: StreamingSessionBackendBinding, fence: Readonly<{ ownerId: string; fencingToken: number }>): Promise<FakeStreamingChannel>;
    reattach?(binding: StreamingSessionBackendBinding, fence: Readonly<{ ownerId: string; fencingToken: number }>): Promise<ReattachedFakeChannel>;
  };
  readonly handshake: {
    verify(channel: FakeStreamingChannel, control: StreamingHandshakeControl): Promise<string>;
  };
  readonly output: {
    readonly artifacts?: ArtifactStore;
    readonly maxQueueBytes: number; readonly maxQueueChunks: number; readonly maxFrameBytes: number; readonly maxAcceptedChunks: number;
    readonly protocolStreams: readonly StreamingOutputStream[];
    createEvidenceSpool(sessionId: string): EvidenceSpoolSink & Required<Pick<EvidenceSpoolSink, "finalize" | "cleanup">>;
    deliver(stream: StreamingOutputStream, bytes: Uint8Array): Promise<void>;
  };
  readonly waitUntilDeadline?: (deadlineAt: number) => Promise<void>;
}
export interface StreamingOpenRequest { readonly sessionId: string; readonly launchId: string; readonly grant: OpaqueExecutionGrant; readonly binding: ExecutionGrantBinding; readonly envelope: StreamingSessionEnvelope; readonly protocolStreams?: readonly StreamingOutputStream[]; readonly signal?: AbortSignal }

export interface StreamingHandshakeControl {
  write(payload: Uint8Array, timeoutMs: number): Promise<void>;
  waitForOutput(signal?: AbortSignal): Promise<boolean>;
  deliverOutput(deliver: (stream: StreamingOutputStream, bytes: Uint8Array) => Promise<void>): Promise<boolean>;
}

type OutputController = ReturnType<typeof createStreamingOutputController>;
type FinalizedEvidence = Awaited<ReturnType<ReturnType<typeof createProtocolEvidenceTee>["finalize"]>>;
interface AttachmentEvidence { readonly tee: ReturnType<typeof createProtocolEvidenceTee>; finalizing?: Promise<FinalizedEvidence>; finalizedEvidence?: FinalizedEvidence; cleanup?: Promise<void> }
interface PrivateAttachment { gracefulInputClose?: Promise<"acknowledged" | "failed">; readonly channel: FakeStreamingChannel; readonly output: OutputController; readonly evidence: AttachmentEvidence; readonly outputOwnerId: string; readonly outputFencingToken: number; readonly onPreAdoptionFailure?: (error: unknown) => Promise<void>; unsubscribe: () => void; unobserve: () => void; closed: boolean; detached: boolean; cleanupRelinquished: boolean; nextWriteSequence: number; writeTail: Promise<void>; intakeTail: Promise<void>; intakeCount: number; closing?: Promise<FinalizedEvidence>; takeover?: Promise<void>; settling?: Promise<void>; outputSettlement?: { deadlineAt: number; promise: Promise<BackpressuredOutputSettlement> }; finalizedEvidence?: FinalizedEvidence; failure?: unknown }
interface AdoptedCleanupContext { ownerId: string; fencingToken: number; live?: PrivateAttachment; cleanup?: PrivateAttachment; detachChannel?: FakeStreamingChannel; detachSettlement?: Promise<BackpressuredOutputSettlement>; detachOutputFailed?: boolean; control?: AdoptedBackendControl; evidenceContinuable: boolean; retainedCount: number }
interface AdoptedCleanupRun {
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly deadlineAt: number;
  promise: Promise<void>;
  issued?: Readonly<{ effectId: string; resource: AdoptedCleanupResourceKind; attempt: NonNullable<AdoptedCleanupResourceFact["attempt"]> }>;
}
interface AdoptedBackendControl { readonly launch: Readonly<HostLaunchRecord>; readonly fence: Readonly<{ ownerId: string; fencingToken: number }> }
interface PendingLateCleanup { readonly channel: FakeStreamingChannel; failure: unknown; detaching?: Promise<void>; detached: boolean }
interface HostCleanupChannelCapability { readonly sessionId: string; readonly identity: string; readonly channel: FakeStreamingChannel; readonly ownerId: string; readonly fencingToken: number; attachment?: PrivateAttachment; evidenceOnly?: boolean; outputSettled?: boolean; cleanup?: () => Promise<unknown>; detached: boolean; failed?: boolean; detaching?: Promise<void> }
type HostCleanupResult = Readonly<{
  resource: HostCleanupResourceFact["resource"];
  identity: string;
  ownerId: string;
  fencingToken: number;
}> & (
  | Readonly<{ status: "succeeded"; evidence?: AdoptedCleanupEvidenceReference }>
  | Readonly<{ status: "failed"; failure: HostCleanupFailure }>
);

export function createStreamingProcessSessionRuntime(options: StreamingRuntimeOptions) {
  const clock = options.clock ?? (() => new Date());
  const writer = getStreamingSessionKernelWriter(options.kernel);
  const attachments = new Map<string, PrivateAttachment>();
  const lateCleanupChannels = new Map<string, PendingLateCleanup>();
  const hostCleanupChannels = new Map<string, HostCleanupChannelCapability>();
  const hostCleanupPreparations = new Map<string, Promise<HostCleanupChannelCapability>>();
  const originalChannelAcquisitions = new Map<string, Promise<void>>();
  const hostCleanupFailures = new Map<string, Readonly<{ sessionId: string; failure: HostCleanupFailure }>>();
  const unresolvedProviderEffects = new Set<string>();
  const hostCleanupRuns = new Map<string, Promise<"cleaned" | "blocked" | "outcome_unknown">>();
  const cleanupResourceRuns = new Map<string, Promise<void>>();
  const adoptedCleanupRuns = new Map<string, AdoptedCleanupRun>();
  const adoptedEffectRuns = new Map<string, Readonly<{ ownerId: string; fencingToken: number; promise: Promise<Readonly<{ status: "verified"; evidence?: AdoptedCleanupEvidenceReference } | { status: "blocked"; code: AdoptedCleanupBlockerCode }>> }>>();
  const adoptedCleanupContexts = new Map<string, AdoptedCleanupContext>();

  const cleanupEffect = (record: Readonly<HostLaunchRecord>) => record.effects.find((effect) => effect.kind === "cleanup");
  const renewOwnedSessionLease = (sessionId: string, cleanupDeadlineAt?: number) => {
    const record = options.kernel.store.readBySession(sessionId);
    if (!record || record.state === "released" || record.cleanupOwner !== "session_authority") return record;
    const at = clock();
    const requiredThrough = cleanupDeadlineAt === undefined ? 0 : cleanupDeadlineAt + CLEANUP_SETTLEMENT_RESERVE_MS;
    if (Date.parse(record.leaseExpiresAt) - at.getTime() > SESSION_OWNERSHIP_RENEW_WINDOW_MS &&
        Date.parse(record.leaseExpiresAt) >= requiredThrough) return record;
    return writer.apply({
      type: "renew_lease",
      sessionId,
      ownerId: record.ownerId,
      fencingToken: record.fencingToken,
      expectedRevision: record.revision,
      leaseExpiresAt: new Date(Math.max(at.getTime() + SESSION_OWNERSHIP_LEASE_MS, requiredThrough)).toISOString(),
      at: at.toISOString(),
    });
  };
  const adoptedBackendControl = (session: Readonly<StreamingSessionRecord>) => {
    const matches = options.kernel.store.listHostLaunchIds()
      .map((launchId) => options.kernel.store.readHostLaunch(launchId))
      .filter((record): record is Readonly<HostLaunchRecord> => record?.sessionId === session.sessionId);
    if (matches.length !== 1) throw runnerSessionError("cleanup_blocked", "Exact adopted backend control provenance is unavailable.");
    const host = matches[0]!;
    const handoff = host.effects.find((effect) => effect.kind === "handoff");
    if (
      host.state !== "handed_off" || host.ownerId !== "none" || host.cleanupOwner !== "none" ||
      handoff?.status !== "acknowledged" || handoff.fencingToken !== host.fencingToken ||
      host.runId !== session.runId || host.agentSessionId !== session.agentSessionId ||
      host.toolName !== session.toolName || host.callId !== session.callId ||
      !same(host.actor, session.actor) || !same(host.backendBinding, session.backendBinding) ||
      !same(host.leaseBinding, session.lease)
    ) throw runnerSessionError("cleanup_blocked", "Adopted backend control provenance does not match the durable session.");
    // The live pre-adoption channel owns the original host fence. Every adopted
    // owner advances beyond that immutable fence, and each SessionAuthority
    // takeover advances it again, so a prior runner cannot retain backend
    // control after recovery.
    const fencingToken = handoff.fencingToken + session.fencingToken;
    if (!Number.isSafeInteger(fencingToken)) throw runnerSessionError("cleanup_blocked", "Adopted backend control fence is exhausted.");
    return Object.freeze({
      launch: host,
      fence: Object.freeze({ ownerId: session.ownerId, fencingToken }),
    });
  };
  const beginHostCleanup = (record: Readonly<HostLaunchRecord>) => {
    if (record.state === "released" || record.state === "handed_off") return record;
    if (record.state === "cleanup_pending") return record;
    return writer.transitionLaunch({ type: "begin_cleanup", launchId: record.launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, at: clock().toISOString() });
  };
  const performHostCleanup = async (launchId: string, timeoutMs = 1_000, signal?: AbortSignal) => {
    let record = options.kernel.store.readHostLaunch(launchId);
    if (!record || record.state === "released" || record.state === "handed_off") return "cleaned" as const;
    // A crash can leave any pre-adoption state with expired authority, not only
    // cleanup_blocked. The store atomically fences takeover and derives every
    // known cleanup obligation before effects; old writers remain rejected.
    if (Date.parse(record.ownerExpiresAt) <= clock().getTime()) record = writer.transitionLaunch({ type: "takeover_cleanup", launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, newOwnerId: `recovery:${launchId}`, newFencingToken: record.fencingToken + 1, ownerExpiresAt: new Date(clock().getTime() + timeoutMs + 60_000).toISOString(), at: clock().toISOString() });
    else if (record.state !== "cleanup_blocked" || !record.outputCheckpointCreatedAt) record = beginHostCleanup(record);
    const effect = cleanupEffect(record);
    let resourceFacts = [...(effect?.resources ?? [])];
    let pending = resourceFacts.filter((resource) => resource.status !== "succeeded");
    if (!pending.length) {
      const released = writer.transitionLaunch({ type: "settle_cleanup_cleaned", launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, results: [], at: clock().toISOString() });
      hostCleanupFailures.delete(launchId); return released.state === "released" ? "cleaned" as const : "blocked" as const;
    }
    const cleanupDeadline = clock().getTime() + timeoutMs;
    const preserveOutputUntilHostQuiescence = Boolean(record.outputCheckpointCreatedAt || record.channelAcquisitionStartedAt);
    const results: HostCleanupResult[] = [];
    const cleanOne = async (
      resource: Readonly<HostCleanupResourceFact>,
      channelPreparationFailure?: unknown,
    ): Promise<void> => {
      try {
        const remaining = cleanupDeadline - clock().getTime();
        if (remaining <= 0) throw new CleanupClassificationError("cleanup_timeout_or_cancelled");
        if ((resource.resource === "host" || resource.resource === "channel") && channelPreparationFailure) throw channelPreparationFailure;
        if (preserveOutputUntilHostQuiescence && resource.resource === "output_checkpoint" &&
            results.some((result) => result.resource === "channel" && result.status === "failed")) {
          throw runnerSessionError("cleanup_blocked", "The terminal output reader remains required.");
        }
        await bounded(runCleanupResource(record!, resource, cleanupDeadline), remaining, signal);
        if (resource.resource === "host" && unresolvedProviderEffects.has(record!.launchId)) throw new CleanupClassificationError("cleanup_timeout_or_cancelled");
        const final = resource.resource === "output_checkpoint" ? options.kernel.store.readOutputCheckpoint(record!.sessionId)?.continuation?.finalized : undefined;
        results.push(Object.freeze({ resource: resource.resource, identity: resource.identity, ownerId: resource.ownerId, fencingToken: resource.fencingToken, status: "succeeded" as const,
          ...(final ? { evidence: { kind: "bounded_output_manifest" as const, digest: final.manifestHash, lossy: final.lossy, ...(final.lossy ? { lossReason: "bounded_output_loss" as const } : {}) } } : {}),
        }));
      } catch (error) {
        results.push(Object.freeze({ resource: resource.resource, identity: resource.identity, ownerId: resource.ownerId, fencingToken: resource.fencingToken, status: "failed" as const, failure: classifyCleanupFailure(resource.resource, error) }));
      }
    };
    const independentCleanup = pending
      .filter((resource) => resource.resource === "isolation_lease")
      .map(async (resource) => await cleanOne(resource));
    const durableChannel = resourceFacts.find((resource) => resource.resource === "channel");
    let channelPreparationFailure: unknown;
    if (
      pending.some((resource) => resource.resource === "host") &&
      durableChannel &&
      preserveOutputUntilHostQuiescence
    ) {
      try {
        const remaining = cleanupDeadline - clock().getTime();
        if (remaining <= 0) throw new CleanupClassificationError("cleanup_timeout_or_cancelled");
        await bounded(prepareHostCleanupChannel(record, durableChannel, cleanupDeadline), remaining, signal);
        const prepared = options.kernel.store.readHostLaunch(launchId)!;
        if (prepared.ownerId !== record.ownerId || prepared.fencingToken !== record.fencingToken) throw runnerSessionError("cleanup_blocked", "Host cleanup authority became stale.");
        record = prepared;
        resourceFacts = [...(cleanupEffect(record)?.resources ?? [])];
        pending = resourceFacts.filter((resource) => resource.status !== "succeeded");
      } catch (error) {
        channelPreparationFailure = error;
      }
    }
    for (const resource of pending.filter((entry) => entry.resource !== "isolation_lease").sort(
      (left, right) => cleanupResourceOrder(left.resource, preserveOutputUntilHostQuiescence) -
        cleanupResourceOrder(right.resource, preserveOutputUntilHostQuiescence),
    )) {
      await cleanOne(resource, channelPreparationFailure);
    }
    await Promise.all(independentCleanup);
    record = options.kernel.store.readHostLaunch(launchId)!;
    if (record.state === "cleanup_blocked") record = beginHostCleanup(record);
    const durableResultOrder = new Map(
      resourceFacts.map((resource, index) => [`${resource.resource}\0${resource.identity}`, index]),
    );
    const orderedResults = results.filter((result) => cleanupEffect(record!)?.resources?.find((fact) => fact.resource === result.resource)?.status !== "succeeded").sort((left, right) =>
      durableResultOrder.get(`${left.resource}\0${left.identity}`)! -
      durableResultOrder.get(`${right.resource}\0${right.identity}`)!,
    );
    const failures = orderedResults.filter(
      (result): result is Extract<HostCleanupResult, { status: "failed" }> => result.status === "failed",
    );
    if (failures.length) {
      writer.transitionLaunch({ type: "settle_cleanup_blocked", launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, blocker: failures[0]!.failure, results: orderedResults, at: clock().toISOString() });
      hostCleanupFailures.set(launchId, Object.freeze({ sessionId: record.sessionId, failure: failures[0]!.failure }));
      return failures.some((failure) => failure.failure.code === "host_outcome_unknown") ? "outcome_unknown" as const : "blocked" as const;
    }
    writer.transitionLaunch({ type: "settle_cleanup_cleaned", launchId, ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, results: orderedResults, at: clock().toISOString() });
    hostCleanupChannels.delete(launchId);
    return "cleaned" as const;
  };
  const runHostCleanup = (launchId: string, timeoutMs = 1_000, signal?: AbortSignal) => {
    const existing = hostCleanupRuns.get(launchId); if (existing) return existing;
    const running = performHostCleanup(launchId, timeoutMs, signal).finally(() => { if (hostCleanupRuns.get(launchId) === running) hostCleanupRuns.delete(launchId); });
    hostCleanupRuns.set(launchId, running); return running;
  };
  const cleanupResource = async (record: Readonly<HostLaunchRecord>, resource: Readonly<HostCleanupResourceFact>, deadlineAt: number) => {
    if (resource.resource === "host") {
      if (resource.identity !== `host:${record.launchId}`) throw runnerSessionError("cleanup_blocked", "Exact host cleanup identity is unavailable.");
      const quiescence = await options.host.quiesce({
        launchId: record.launchId,
        record,
        fence: { ownerId: record.ownerId, fencingToken: record.fencingToken },
        deadlineAt,
      });
      if (quiescence === "outcome_unknown") throw new CleanupClassificationError("host_outcome_unknown");
      if (quiescence !== "verified") throw runnerSessionError("cleanup_blocked", "Exact host quiescence was not verified.");
      const assertHostOwner = () => {
        const current = options.kernel.store.readHostLaunch(record.launchId);
        if (!current || current.ownerId !== record.ownerId || current.fencingToken !== record.fencingToken ||
            current.cleanupOwner !== "host_control" || Date.parse(current.ownerExpiresAt) <= clock().getTime()) {
          throw runnerSessionError("cleanup_blocked", "Host cleanup authority became stale.");
        }
      };
      assertHostOwner();
      if (record.outputCheckpointCreatedAt) {
        const channelFact = cleanupEffect(record)?.resources?.find((fact) => fact.resource === "channel");
        if (!channelFact) throw runnerSessionError("cleanup_blocked", "Exact terminal output channel is unavailable.");
        const capability = await prepareHostCleanupChannel(record, channelFact);
        if (!capability.attachment) throw runnerSessionError("cleanup_blocked", "Exact terminal output attachment is unavailable.");
        await settleAttachmentOutput(record.sessionId, capability.attachment, deadlineAt, assertHostOwner);
        capability.outputSettled = true;
      }
      assertHostOwner();
      if (clock().getTime() >= deadlineAt) throw new CleanupClassificationError("cleanup_timeout_or_cancelled");
      const release = await options.host.release({
        launchId: record.launchId,
        record,
        fence: { ownerId: record.ownerId, fencingToken: record.fencingToken },
        deadlineAt,
      });
      if (release === "outcome_unknown") throw new CleanupClassificationError("host_outcome_unknown");
      if (release !== "verified") throw runnerSessionError("cleanup_blocked", "Exact host release was not verified.");
      return;
    }
    if (resource.resource === "isolation_lease") {
      if (!record.leaseBinding || resource.identity !== leaseCleanupIdentity(record.leaseBinding)) throw runnerSessionError("cleanup_blocked", "Exact isolation lease cleanup identity is unavailable.");
      await options.isolation.release(record.leaseBinding); return;
    }
    if (resource.resource === "output_checkpoint") {
      if (resource.identity !== `checkpoint:${record.sessionId}`) throw runnerSessionError("cleanup_blocked", "Exact output checkpoint cleanup identity is unavailable.");
      const checkpoint = options.kernel.store.readOutputCheckpoint(record.sessionId);
      const final = checkpoint?.continuation?.finalized;
      if (checkpoint?.continuation) {
        if (!final || checkpoint.streams.some((stream) => stream.accepted.length || stream.consumingIntent)) throw runnerSessionError("cleanup_blocked", "Durable evidence continuation is unavailable.");
        return; // Cleanup settlement atomically transfers the root and deletes.
      }
      const host = options.kernel.store.readHostLaunch(record.launchId)!;
      const existing = cleanupEffect(host)?.resources?.find((fact) => fact.resource === "output_checkpoint")?.evidence;
      writer.deleteOutputCheckpoint({ sessionId: record.sessionId, ownerId: checkpoint?.ownerId, fencingToken: checkpoint?.fencingToken, expectedRevision: checkpoint?.revision,
        launchId: host.launchId, hostOwnerId: host.ownerId, hostFencingToken: host.fencingToken, hostRevision: host.revision,
        ...(final ? { evidence: { kind: "bounded_output_manifest", digest: final.manifestHash, lossy: final.lossy, ...(final.lossy ? { lossReason: "bounded_output_loss" } : {}) } } : existing ? { evidence: existing } : {}),
      });
      return;
    }
    if (!record.backendBinding || resource.identity !== channelCleanupIdentity(record.sessionId, record.backendBinding)) throw runnerSessionError("cleanup_blocked", "Exact channel cleanup capability is unavailable.");
    const capability = await prepareHostCleanupChannel(record, resource);
    if (!capability || capability.identity !== resource.identity) throw runnerSessionError("cleanup_blocked", "Exact channel cleanup capability is unavailable.");
    if (capability.detached) return;
    if (record.outputCheckpointCreatedAt && !capability.outputSettled) throw runnerSessionError("cleanup_blocked", "Terminal output must settle before channel cleanup.");
    if (resource.status === "failed" && capability.failed) { capability.detaching = undefined; capability.failed = false; }
    capability.detaching ??= Promise.resolve(capability.cleanup ? capability.cleanup() : capability.channel.detach()).then(() => { capability.detached = true; }, (error) => { capability.failed = true; throw remintRunnerSessionError(error) ?? error; });
    await capability.detaching;
  };
  const prepareHostCleanupChannel = async (
    record: Readonly<HostLaunchRecord>,
    resource: Readonly<HostCleanupResourceFact>,
    deadlineAt = Number.POSITIVE_INFINITY,
  ): Promise<HostCleanupChannelCapability> => {
    // Cancellation can enter cleanup before open's original acquire returns.
    // Its late callback still owns installation of the exact bare capability.
    if (originalChannelAcquisitions.has(record.launchId)) throw new CleanupClassificationError("cleanup_timeout_or_cancelled");
    const cached = hostCleanupChannels.get(record.launchId);
    const existing = cached?.ownerId === record.ownerId && cached.fencingToken === record.fencingToken ? cached : undefined;
    if (existing && (existing.evidenceOnly || !existing.attachment && record.outputCheckpointCreatedAt)) return existing;
    const key = `${record.launchId}\0${resource.identity}`;
    const retained = hostCleanupPreparations.get(key);
    if (retained) {
      const capability = await retained;
      if (capability.ownerId !== record.ownerId || capability.fencingToken !== record.fencingToken) throw runnerSessionError("cleanup_blocked", "Retained channel preparation belongs to an earlier owner.");
      return capability;
    }
    const preparing = (async () => {
    const assertPreparationOwner = () => {
      const current = options.kernel.store.readHostLaunch(record.launchId);
      if (!current || current.ownerId !== record.ownerId || current.fencingToken !== record.fencingToken ||
          current.cleanupOwner !== "host_control" || Date.parse(current.ownerExpiresAt) <= clock().getTime()) {
        throw runnerSessionError("cleanup_blocked", "Host channel preparation authority became stale.");
      }
    };
    assertPreparationOwner();
    if (!record.backendBinding || resource.identity !== channelCleanupIdentity(record.sessionId, record.backendBinding) || !options.channel.reattach)
      throw runnerSessionError("cleanup_blocked", "Exact channel cleanup capability is unavailable.");
    let checkpoint = options.kernel.store.readOutputCheckpoint(record.sessionId);
    const bootstrap = !checkpoint;
    if (bootstrap && (record.outputCheckpointCreatedAt || !record.channelAcquisitionStartedAt || !record.leaseBinding ||
        record.state !== "cleanup_pending" || record.handshakeDigest || options.kernel.store.readBySession(record.sessionId) ||
        cleanupEffect(record)?.resources?.some((fact) => (fact.resource === "host" || fact.resource === "channel") && fact.status === "succeeded")))
      throw runnerSessionError("cleanup_blocked", "Never-initialized output authority cannot be proved.");
    if (checkpoint && !record.outputCheckpointCreatedAt) throw runnerSessionError("cleanup_blocked", "Output checkpoint lacks its host obligation.");
    if (cached && !cached.attachment && !record.outputCheckpointCreatedAt && !cached.detached) {
      // Keep the original capability even across takeover. Its exact detach is
      // relinquishment, not replacement authority; a pending promise stays joined.
      if (cached.failed) { cached.detaching = undefined; cached.failed = false; }
      cached.detaching ??= Promise.resolve().then(() => cached.channel.detach()).then(
        () => { cached.detached = true; },
        (error) => { cached.failed = true; throw remintRunnerSessionError(error) ?? error; },
      );
      await cached.detaching;
      if (options.kernel.store.readHostLaunch(record.launchId)!.revision !== record.revision)
        throw runnerSessionError("cleanup_blocked", "Host channel preparation revision became stale.");
    }
    if (existing?.attachment) await relinquishAttachmentForCleanupTakeover(existing.attachment);
    assertPreparationOwner();
    if (lateCleanupChannels.has(record.sessionId)) throw runnerSessionError("cleanup_blocked", "A prior exact rejected channel still requires cleanup.");
    if (clock().getTime() >= deadlineAt) throw new CleanupClassificationError("cleanup_timeout_or_cancelled");
    const recovered = await options.channel.reattach(
      record.backendBinding,
      { ownerId: record.ownerId, fencingToken: record.fencingToken },
    );
    const discardRecovered = async () => {
      try { await recovered.channel.detach(); }
      catch (failure) {
        lateCleanupChannels.set(record.sessionId, { channel: recovered.channel, failure, detached: false });
        throw failure;
      }
    };
    try { assertPreparationOwner(); }
    catch (error) { await discardRecovered(); throw error; }
    if (
      recovered.version !== BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION ||
      !same(recovered.binding, record.backendBinding)
    ) {
      await discardRecovered();
      throw runnerSessionError("cleanup_blocked", "Exact channel cleanup reattachment was refused.");
    }
    if (bootstrap) {
      try {
        assertPreparationOwner();
        if (clock().getTime() >= deadlineAt) throw new CleanupClassificationError("cleanup_timeout_or_cancelled");
        const proof = recovered.cleanupBootstrap;
        if (!proof || proof.version !== 1 || proof.pendingAcknowledgements !== 0 ||
            ["stdout", "stderr"].some((stream) => {
              const position = proof.consumed?.[stream as StreamingOutputStream];
              return !position || position.sequence !== 0 || position.endOffset !== 0;
            })) throw runnerSessionError("cleanup_blocked", "Backend output has unexplained prior consumption.");
        assertV2(recovered.replayCapacityChunks, recovered.replayCapacityBytes);
        const current = options.kernel.store.readHostLaunch(record.launchId)!;
        if (current.revision !== record.revision) throw runnerSessionError("cleanup_blocked", "Host output bootstrap revision became stale.");
        checkpoint = writer.bootstrapHostCleanupOutputCheckpoint({ launchId: record.launchId, ownerId: record.ownerId,
          fencingToken: record.fencingToken, expectedRevision: record.revision, at: clock().toISOString(), record: {
            recordKind: "runner.output-checkpoint", schemaVersion: 2, revision: 0, sessionId: record.sessionId,
            ownerId: record.ownerId, fencingToken: record.fencingToken, capacity: options.output.maxAcceptedChunks, outcome: "active",
            // Preserve the coherent replay obligation in the same transaction.
            // A backend claiming terminal settlement without replaying these
            // bytes must still leave an authenticated accepted-byte blocker.
            streams: ["stdout", "stderr"].map((stream) => ({ stream, lastConsumed: null, consumed: [],
              accepted: recovered.retainedWindow.filter((metadata) => metadata.stream === stream), consumingIntent: null })),
            continuation: initialEvidenceContinuation(),
          } }).record;
      } catch (error) {
        // This await remains inside the retained preparation: a timeout or
        // takeover cannot overlap a late capability's still-running detach.
        await discardRecovered();
        throw error;
      }
    }
    let attachment: PrivateAttachment;
    try { attachment = createAttachment(
      record.sessionId,
      checkpoint!.ownerId,
      checkpoint!.fencingToken,
      recovered.channel,
      undefined,
      "cleanup_evidence_only",
      options.output.protocolStreams,
      existing?.attachment?.evidence,
      Boolean(existing?.attachment),
    ); } catch (error) { await discardRecovered(); throw error; }
    const capability: HostCleanupChannelCapability = {
      sessionId: record.sessionId,
      identity: resource.identity,
      channel: recovered.channel,
      ownerId: record.ownerId,
      fencingToken: record.fencingToken,
      attachment,
      evidenceOnly: true,
      cleanup: async () => {
        const final = await closeAttachment(record.sessionId, attachment);
        const prior = existing?.attachment?.evidence;
        if (prior && prior !== attachment.evidence) {
          prior.cleanup ??= prior.tee.cleanup();
          await prior.cleanup;
        }
        return final;
      },
      detached: false,
    };
    hostCleanupChannels.set(record.launchId, capability);
    try {
      attachment.output.attestRetainedWindow(recovered.retainedWindow, {
        // No family principal exists before adoption. Exact contiguous bytes
        // produced after the prior Runner crashed can therefore be admitted
        // only into the evidence-only cleanup path, never family delivery.
        allowUnacceptedSuffix: true,
      });
      startAttachment(record.sessionId, attachment);
      return capability;
    } catch (error) {
      hostCleanupChannels.delete(record.launchId);
      try { await closeAttachment(record.sessionId, attachment); } catch {}
      throw error;
    }
    })();
    hostCleanupPreparations.set(key, preparing);
    try { return await preparing; }
    finally { if (hostCleanupPreparations.get(key) === preparing) hostCleanupPreparations.delete(key); }
  };
  const runCleanupResource = (record: Readonly<HostLaunchRecord>, resource: Readonly<HostCleanupResourceFact>, deadlineAt: number) => {
    const key = `${record.launchId}\0${resource.resource}\0${resource.identity}`; const existing = cleanupResourceRuns.get(key); if (existing) return existing;
    const running = cleanupResource(record, resource, deadlineAt).catch((error) => { if (cleanupResourceRuns.get(key) === running) cleanupResourceRuns.delete(key); throw remintRunnerSessionError(error) ?? error; });
    cleanupResourceRuns.set(key, running); return running;
  };

  const assertV2 = (chunks = options.channel.replayCapacityChunks, bytes = options.channel.replayCapacityBytes) => {
    if (options.channel.version !== BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION || chunks !== options.output.maxAcceptedChunks || !Number.isSafeInteger(bytes) || bytes! < options.output.maxQueueBytes) throw runnerSessionError("lossless_output_unavailable", "Selected channel does not attest the exact aggregate lossless output v2 window.");
  };
  const finalizedEvidence = new Map<string, FinalizedEvidence>();
  const createAttachment = (
    sessionId: string,
    ownerId: string,
    fencingToken: number,
    channel: FakeStreamingChannel,
    onPreAdoptionFailure?: (error: unknown) => Promise<void>,
    deliveryMode: "authorized_family" | "cleanup_evidence_only" = "authorized_family",
    protocolStreams: readonly StreamingOutputStream[] = options.output.protocolStreams,
    inheritedEvidence?: AttachmentEvidence,
    acceptedReplayEvidenceAlreadyRecorded = false,
  ): PrivateAttachment => {
    const queue = new BoundedProtocolQueue({ maxBytes: options.output.maxQueueBytes, maxChunks: options.output.maxQueueChunks, maxFrameBytes: options.output.maxFrameBytes });
    // Durable continuation reopens under this exact checkpoint fence. Legacy
    // same-runtime evidence keeps C2's original shared one-shot spool contract.
    const inherited = options.output.artifacts ? undefined : inheritedEvidence;
    const spool = inherited ? undefined : options.output.createEvidenceSpool(sessionId);
    const continuation = spool && options.output.artifacts ? createEvidenceContinuation({
      kernel: options.kernel, sessionId, ownerId, fencingToken, artifacts: options.output.artifacts, spool,
    }) : undefined;
    const evidence = inherited ?? {
      tee: createProtocolEvidenceTee({ queue, spool: spool!, continuation }),
    };
    const output = createStreamingOutputController({
      kernel: options.kernel, sessionId, ownerId, fencingToken, maxAcceptedChunks: options.output.maxAcceptedChunks,
      // A host-owned pre-adoption cleanup has no family-delivery principal.
      // It may acknowledge only after the exact bytes are durably accepted and
      // written to evidence, using the controller's evidence-only commit path.
      queue,
      protocolStreams: deliveryMode === "cleanup_evidence_only" ? [] : protocolStreams,
      acceptedReplayEvidenceAlreadyRecorded: options.output.artifacts ? false : acceptedReplayEvidenceAlreadyRecorded,
      writeEvidence: evidence.tee.writeEvidence,
      assertAuthorization: (authorization, expected) => options.sessions.assertOperationAuthorization(authorization, expected),
      deliver: async (stream, bytes) => {
        try { await options.output.deliver(stream, bytes); }
        catch { throw runnerSessionError("launch_failed", "Streaming output delivery failed."); }
      },
    });
    const attachment: PrivateAttachment = { channel, output, evidence, outputOwnerId: ownerId, outputFencingToken: fencingToken, onPreAdoptionFailure, unsubscribe: () => undefined, unobserve: () => undefined, closed: false, detached: false, cleanupRelinquished: false, nextWriteSequence: 1, writeTail: Promise.resolve(), intakeTail: Promise.resolve(), intakeCount: 0 };
    return attachment;
  };
  const writeAttachment = async (
    attachment: PrivateAttachment,
    payload: Uint8Array,
    timeoutMs: number,
    assertCurrent?: () => void,
  ): Promise<void> => {
    const channel = attachment.channel as Partial<InteractiveProcessChannel>;
    if (typeof channel.write !== "function") throw runnerSessionError("launch_failed", "Streaming channel input is unavailable.");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
      throw runnerSessionError("launch_failed", "Streaming write timeout is invalid.");
    }
    const bytes = new Uint8Array(payload);
    const sequence = attachment.nextWriteSequence++;
    const operation = attachment.writeTail.then(async () => {
      assertCurrent?.();
      await channel.write!({
        sequence,
        byteLength: bytes.byteLength,
        digest: createHash("sha256").update(bytes).digest("hex"),
        timeoutMs,
      }, bytes);
    });
    attachment.writeTail = operation.catch(() => undefined);
    await operation;
  };
  const startAttachment = (
    sessionId: string,
    attachment: PrivateAttachment,
    settleOnTerminal = true,
  ) => {
    const { channel, output } = attachment;
    attachment.unsubscribe = channel.subscribeBackpressuredOutput(async (metadata, ownedBytes) => {
      attachment.intakeCount += 1;
      const intake = attachment.intakeTail.then(async () => await output.accept(metadata, ownedBytes));
      attachment.intakeTail = intake.then(() => undefined, () => undefined);
      try { return await intake; }
      catch (error) {
        const session = options.kernel.store.readBySession(sessionId);
        if (session?.state === "active") {
          // The real channel's output tail awaits this sink. Cleanup detaches
          // that channel and therefore must begin only after this rejection
          // unwinds; retaining the settlement promise on the attachment keeps
          // exact retry/diagnostic authority without a self-await cycle.
          void Promise.resolve()
            .then(async () => await settleAdoptedAttachment(sessionId, attachment, "outcome_unknown"))
            .catch((failure) => { attachment.failure = failure; });
        } else if (attachment.onPreAdoptionFailure) {
          // Pre-adoption cleanup waits the currently active launch effect. A
          // handshake effect can itself be awaiting this sink rejection, so
          // retain cleanup outside the sink unwind just as for adopted
          // cleanup. The open path also awaits the exact cleanup operation.
          void Promise.resolve()
            .then(async () => await attachment.onPreAdoptionFailure!(error))
            .catch((failure) => { attachment.failure = failure; });
        }
        throw remintRunnerSessionError(error) ?? error;
      }
      finally { attachment.intakeCount -= 1; }
    });
    attachment.unobserve = settleOnTerminal ? channel.observeTerminal?.(() => {
      const session = options.kernel.store.readBySession(sessionId);
      if (session?.state === "active") void settleAdoptedAttachment(sessionId, attachment, "backend_unavailable").catch((error) => { attachment.failure = error; });
    }) ?? (() => undefined) : () => undefined;
  };
  const finalizeAttachmentEvidence = async (sessionId: string, attachment: PrivateAttachment) => {
    const shared = attachment.evidence;
    shared.finalizing ??= shared.tee.finalize().then((evidence) => {
      shared.finalizedEvidence = evidence;
      finalizedEvidence.set(sessionId, evidence);
      return evidence;
    });
    const evidence = await shared.finalizing;
    attachment.finalizedEvidence = evidence;
    if ("error" in evidence) {
      const errors: unknown[] = [evidence.error];
      try {
        shared.cleanup ??= shared.tee.cleanup();
        await shared.cleanup;
      } catch (error) { errors.push(error); }
      throw new AggregateError(errors, "Streaming evidence finalization failed.");
    }
    return evidence;
  };
  const settleAttachmentOutput = async (
    sessionId: string, attachment: PrivateAttachment, deadlineAt: number, assertOwner: () => void,
  ): Promise<void> => {
    const assertCurrent = () => {
      assertOwner();
      if (clock().getTime() >= Math.min(deadlineAt, attachment.outputSettlement?.deadlineAt ?? deadlineAt)) {
        throw runnerSessionError("cleanup_blocked", "Terminal output settlement deadline expired.");
      }
      const checkpoint = options.kernel.store.readOutputCheckpoint(sessionId);
      if (!checkpoint || checkpoint.outcome !== "active" || checkpoint.ownerId !== attachment.outputOwnerId ||
          checkpoint.fencingToken !== attachment.outputFencingToken) {
        throw runnerSessionError("cleanup_blocked", "Exact terminal output checkpoint is unavailable.");
      }
      return checkpoint;
    };
    assertCurrent();
    if (!attachment.channel.settleBackpressuredOutput) throw runnerSessionError("cleanup_blocked", "Terminal output settlement is unavailable.");
    // Retain the underlying operation, including rejection or a blocked result.
    // A caller timeout cannot grant permission for another terminal effect.
    attachment.outputSettlement ??= { deadlineAt, promise: Promise.resolve().then(() => attachment.channel.settleBackpressuredOutput!(deadlineAt)) };
    const settled = await attachment.outputSettlement.promise;
    await attachment.intakeTail;
    const checkpoint = assertCurrent();
    const snapshot = attachment.output.snapshot();
    if (settled.status !== "settled" || checkpoint.streams.some((stream) => stream.accepted.length || stream.consumingIntent) ||
        snapshot.outcome !== "active" || snapshot.pending !== 0 || snapshot.heldBytes !== 0 || attachment.intakeCount !== 0) {
      throw runnerSessionError("cleanup_blocked", "Terminal output settlement remains unverified.");
    }
  };
  const closeAttachment = async (sessionId: string, attachment: PrivateAttachment) => {
    if (attachment.closed) return attachment.finalizedEvidence!;
    if (attachment.closing) return await attachment.closing;
    attachment.closing = (async () => {
    const errors: unknown[] = [];
    try { await attachment.writeTail; } catch (error) { errors.push(error); }
    try { attachment.unsubscribe(); } catch (error) { errors.push(error); }
    try { attachment.unobserve(); } catch (error) { errors.push(error); }
    attachment.output.cancel("Streaming session attachment closed.");
    try { await finalizeAttachmentEvidence(sessionId, attachment); }
    catch (error) { errors.push(error); }
    if (!attachment.detached) try { await attachment.channel.detach(); attachment.detached = true; } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Streaming attachment cleanup failed.");
    attachment.closed = true;
    return attachment.finalizedEvidence!;
    })();
    try { return await attachment.closing; } finally { if (!attachment.closed) attachment.closing = undefined; }
  };
  const relinquishAttachmentForCleanupTakeover = async (
    attachment: PrivateAttachment,
  ): Promise<void> => {
    if (attachment.takeover) return await attachment.takeover;
    const takeover = (async () => {
      const errors: unknown[] = [];
      if (!attachment.cleanupRelinquished) {
        try { await attachment.writeTail; } catch (error) { errors.push(error); }
        attachment.output.relinquishForCleanupTakeover();
        try { attachment.unsubscribe(); } catch (error) { errors.push(error); }
        try { attachment.unobserve(); } catch (error) { errors.push(error); }
        attachment.cleanupRelinquished = true;
      }
      if (!attachment.detached) {
        try { await attachment.channel.detach(); attachment.detached = true; }
        catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Streaming attachment cleanup takeover failed.");
    })();
    attachment.takeover = takeover;
    try { await takeover; }
    finally { if (!attachment.detached) attachment.takeover = undefined; }
  };
  const cleanupBlocker = (code: AdoptedCleanupBlockerCode) => Object.freeze({
    code,
    message: ADOPTED_CLEANUP_BLOCKER_MESSAGES[code],
  });
  const currentCleanup = (record: Readonly<StreamingSessionRecord>) =>
    record.effects.find((effect) => effect.kind === "cleanup");
  const expireAdoptedCleanupAttempt = (sessionId: string, run: AdoptedCleanupRun): void => {
    const at = clock();
    if (at.getTime() < run.deadlineAt || !run.issued) return;
    const record = options.kernel.store.readBySession(sessionId);
    if (!record || record.state !== "cleanup_pending" || record.cleanupOwner !== "session_authority" ||
        record.ownerId !== run.ownerId || record.fencingToken !== run.fencingToken ||
        Date.parse(record.leaseExpiresAt) <= at.getTime()) return;
    const cleanup = currentCleanup(record);
    const fact = cleanup?.progress?.resources.find((candidate) => candidate.resource === run.issued!.resource);
    if (cleanup?.effectId !== run.issued.effectId || fact?.status !== "in_flight" ||
        fact.attempt?.attemptId !== run.issued.attempt.attemptId ||
        fact.attempt.ownerId !== run.issued.attempt.ownerId ||
        fact.attempt.fencingToken !== run.issued.attempt.fencingToken) return;
    writer.apply({
      type: "settle_cleanup_resource",
      sessionId,
      ownerId: record.ownerId,
      fencingToken: record.fencingToken,
      expectedRevision: record.revision,
      effectId: cleanup.effectId,
      resource: fact.resource,
      attemptId: fact.attempt.attemptId,
      attemptOwnerId: fact.attempt.ownerId,
      attemptFencingToken: fact.attempt.fencingToken,
      result: "blocked",
      blocker: cleanupBlocker("cleanup_deadline_expired"),
      at: at.toISOString(),
    });
  };
  const awaitAdoptedCleanup = async (
    sessionId: string,
    run: AdoptedCleanupRun,
    deadlineAt: number,
    signal?: AbortSignal,
  ): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = Math.min(deadlineAt, run.deadlineAt);
    const deadline = (async () => {
      if (options.waitUntilDeadline) await options.waitUntilDeadline(bound);
      else await new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, bound - clock().getTime())); });
      expireAdoptedCleanupAttempt(sessionId, run);
      throw runnerSessionError("launch_failed", "Streaming operation exceeded its recovery bound.");
    })();
    try { await abortable(Promise.race([run.promise, deadline]), signal); }
    finally { if (timer) clearTimeout(timer); }
  };
  const contextFor = (
    record: Readonly<StreamingSessionRecord>,
    live?: PrivateAttachment,
  ): AdoptedCleanupContext => {
    let context = adoptedCleanupContexts.get(record.sessionId);
    if (!context || context.ownerId !== record.ownerId || context.fencingToken !== record.fencingToken) {
      const retained = live ?? context?.live ?? attachments.get(record.sessionId);
      context = {
        ownerId: record.ownerId,
        fencingToken: record.fencingToken,
        ...(retained ? { live: retained } : {}),
        evidenceContinuable: Boolean(retained) || Boolean(options.output.artifacts && options.kernel.store.readOutputCheckpoint(record.sessionId)?.continuation),
        retainedCount: 0,
      };
      adoptedCleanupContexts.set(record.sessionId, context);
    } else if (live && !context.live) {
      context.live = live;
      context.evidenceContinuable = true;
    }
    return context;
  };
  const exactCleanupOwner = (sessionId: string, ownerId: string, fencingToken: number) => {
    const current = options.kernel.store.readBySession(sessionId);
    if (!current || (current.state !== "cleanup_pending" && current.state !== "cleanup_blocked") || current.ownerId !== ownerId ||
        current.fencingToken !== fencingToken || Date.parse(current.leaseExpiresAt) <= clock().getTime()) {
      throw runnerSessionError("cleanup_blocked", "Adopted cleanup authority became stale.");
    }
    return current;
  };
  const prepareAdoptedCleanupOutput = async (
    record: Readonly<StreamingSessionRecord>,
    context: AdoptedCleanupContext,
  ): Promise<PrivateAttachment> => {
    if (context.cleanup) return context.cleanup;
    context.control = adoptedBackendControl(record);
    const checkpoint = options.kernel.store.readOutputCheckpoint(record.sessionId);
    if (!checkpoint || checkpoint.outcome !== "active" || checkpoint.ownerId !== record.ownerId ||
        checkpoint.fencingToken !== record.fencingToken || !options.channel.reattach) {
      throw runnerSessionError("cleanup_blocked", "Exact output cleanup authority is unavailable.");
    }
    if (context.live) await relinquishAttachmentForCleanupTakeover(context.live);
    const recovered = await options.channel.reattach(record.backendBinding, context.control.fence);
    if (recovered.version !== BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION ||
        !same(recovered.binding, record.backendBinding) ||
        recovered.replayCapacityChunks !== checkpoint.capacity ||
        recovered.replayCapacityBytes < options.output.maxQueueBytes) {
      try { await recovered.channel.detach(); } catch {}
      throw runnerSessionError("cleanup_blocked", "Exact output cleanup reattachment was refused.");
    }
    const cleanup = createAttachment(
      record.sessionId,
      checkpoint.ownerId,
      checkpoint.fencingToken,
      recovered.channel,
      undefined,
      "cleanup_evidence_only",
      options.output.protocolStreams,
      context.live?.evidence,
      Boolean(context.live),
    );
    try {
      cleanup.output.attestRetainedWindow(recovered.retainedWindow, { allowUnacceptedSuffix: true });
      startAttachment(record.sessionId, cleanup, false);
    } catch (error) {
      try { await recovered.channel.detach(); cleanup.detached = true; } catch {}
      throw error;
    }
    context.cleanup = cleanup;
    if (options.output.artifacts && options.kernel.store.readOutputCheckpoint(record.sessionId)?.continuation) context.evidenceContinuable = true;
    context.retainedCount = recovered.retainedWindow.length;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await cleanup.intakeTail;
    return cleanup;
  };
  const performAdoptedCleanupEffect = async (
    record: Readonly<StreamingSessionRecord>,
    resource: AdoptedCleanupResourceKind,
    context: AdoptedCleanupContext,
    deadlineAt: number,
  ): Promise<Readonly<{ status: "verified"; evidence?: AdoptedCleanupEvidenceReference } | { status: "blocked"; code: AdoptedCleanupBlockerCode }>> => {
    context.control = adoptedBackendControl(record);
    if (resource === "workload_quiescence") {
      try { await prepareAdoptedCleanupOutput(record, context); }
      catch { return { status: "blocked", code: "output_settlement_unavailable" }; }
      exactCleanupOwner(record.sessionId, record.ownerId, record.fencingToken);
      if (clock().getTime() >= deadlineAt) return { status: "blocked", code: "cleanup_deadline_expired" };
      const outcome = await options.host.quiesce({
        launchId: context.control.launch.launchId,
        record: context.control.launch,
        fence: context.control.fence,
        deadlineAt,
      });
      if (outcome === "verified") return { status: "verified" };
      if (context.live) {
        try { await relinquishAttachmentForCleanupTakeover(context.live); } catch {}
      }
      return {
        status: "blocked",
        code: outcome === "outcome_unknown" ? "workload_outcome_unknown" : "cleanup_authority_unavailable",
      };
    }
    if (resource === "retained_output_settlement") {
      let cleanup: PrivateAttachment;
      try { cleanup = await prepareAdoptedCleanupOutput(record, context); }
      catch {
        if (context.live && options.kernel.store.readOutputCheckpoint(record.sessionId)?.outcome !== "active") {
          try {
            await relinquishAttachmentForCleanupTakeover(context.live);
            await finalizeAttachmentEvidence(record.sessionId, context.live);
          } catch {}
        }
        return { status: "blocked", code: "output_settlement_unavailable" };
      }
      try { await settleAttachmentOutput(record.sessionId, cleanup, deadlineAt, () => { exactCleanupOwner(record.sessionId, record.ownerId, record.fencingToken); }); }
      catch { return { status: "blocked", code: "output_settlement_unavailable" }; }
      const checkpoint = options.kernel.store.readOutputCheckpoint(record.sessionId);
      const snapshot = cleanup.output.snapshot();
      return checkpoint?.outcome === "active" && snapshot.outcome === "active" && snapshot.pending === 0 &&
        snapshot.heldBytes === 0 && cleanup.intakeCount === 0
        ? { status: "verified" }
        : { status: "blocked", code: "output_settlement_unavailable" };
    }
    if (resource === "evidence") {
      const cleanup = context.cleanup;
      if (!cleanup) return { status: "blocked", code: "evidence_continuation_unavailable" };
      try {
        await cleanup.intakeTail;
        exactCleanupOwner(record.sessionId, record.ownerId, record.fencingToken);
        if (clock().getTime() >= deadlineAt) return { status: "blocked", code: "cleanup_deadline_expired" };
        cleanup.unsubscribe();
        cleanup.unobserve();
        const finalized = await finalizeAttachmentEvidence(record.sessionId, cleanup);
        if (options.output.artifacts && context.live && context.live.evidence !== cleanup.evidence) await context.live.evidence.tee.cleanup();
        if (!context.evidenceContinuable) return { status: "blocked", code: "evidence_continuation_unavailable" };
        const durableFinal = options.kernel.store.readOutputCheckpoint(record.sessionId)?.continuation?.finalized;
        if (durableFinal) return { status: "verified", evidence: {
          kind: "bounded_output_manifest", digest: durableFinal.manifestHash, lossy: durableFinal.lossy,
          ...(durableFinal.lossy ? { lossReason: "bounded_output_loss" as const } : {}),
        } };
        const result = "result" in finalized ? finalized.result : undefined;
        if (result === undefined) return { status: "blocked", code: "evidence_finalization_failed" };
        const lossy = finalized.evidenceLossy === true;
        const boundedLoss = lossy && typeof result === "object" && result !== null && "streams" in result &&
          Array.isArray(result.streams) && result.streams.some((stream) =>
            Boolean(stream && typeof stream === "object" && "lossyOutput" in stream && stream.lossyOutput === true));
        return {
          status: "verified",
          evidence: {
            kind: "same_runtime_finalization",
            digest: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
            lossy,
            ...(lossy ? { lossReason: boundedLoss ? "bounded_output_loss" as const : "evidence_write_failed" as const } : {}),
          },
        };
      } catch {
        return { status: "blocked", code: "evidence_finalization_failed" };
      }
    }
    if (resource === "channel_detach") {
      const cleanup = context.cleanup;
      try {
        if (cleanup) {
          await cleanup.intakeTail;
          exactCleanupOwner(record.sessionId, record.ownerId, record.fencingToken);
          if (clock().getTime() >= deadlineAt) return { status: "blocked", code: "cleanup_deadline_expired" };
          if (!cleanup.detached) await cleanup.channel.detach();
          cleanup.detached = true;
          cleanup.closed = true;
        } else {
          // Evidence is already durable. Reconstruct only the exact channel
          // capability; creating an output attachment would refinalize evidence.
          const checkpoint = options.kernel.store.readOutputCheckpoint(record.sessionId);
          if (!checkpoint || checkpoint.ownerId !== record.ownerId || checkpoint.fencingToken !== record.fencingToken ||
              checkpoint.outcome !== "active" || !options.channel.reattach) return { status: "blocked", code: "channel_detach_failed" };
          if (!context.detachChannel) {
            const recovered = await options.channel.reattach(record.backendBinding, context.control.fence);
            if (recovered.version !== BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION || !same(recovered.binding, record.backendBinding) ||
                recovered.replayCapacityChunks !== checkpoint.capacity || recovered.replayCapacityBytes < options.output.maxQueueBytes) {
              try { await recovered.channel.detach(); } catch {}
              return { status: "blocked", code: "channel_detach_failed" };
            }
            context.detachChannel = recovered.channel;
            exactCleanupOwner(record.sessionId, record.ownerId, record.fencingToken);
            if (clock().getTime() >= deadlineAt) return { status: "blocked", code: "cleanup_deadline_expired" };
            if (!recovered.channel.settleBackpressuredOutput) return { status: "blocked", code: "channel_detach_failed" };
            const currentCheckpoint = options.kernel.store.readOutputCheckpoint(record.sessionId);
            if (!currentCheckpoint || currentCheckpoint.outcome !== "active" ||
                currentCheckpoint.ownerId !== record.ownerId || currentCheckpoint.fencingToken !== record.fencingToken ||
                currentCheckpoint.streams.some((stream) => stream.accepted.length > 0 || stream.consumingIntent)) {
              return { status: "blocked", code: "evidence_continuation_unavailable" };
            }
            const unavailable = () => { throw runnerSessionError("cleanup_blocked", "Finalized evidence only permits exact consumed output replay."); };
            const output = createStreamingOutputController({
              kernel: options.kernel, sessionId: record.sessionId, ownerId: record.ownerId, fencingToken: record.fencingToken,
              maxAcceptedChunks: checkpoint.capacity,
              queue: new BoundedProtocolQueue({ maxBytes: options.output.maxQueueBytes, maxChunks: options.output.maxQueueChunks, maxFrameBytes: options.output.maxFrameBytes }),
              protocolStreams: [], writeEvidence: async () => unavailable(), assertAuthorization: unavailable, deliver: async () => unavailable(),
            });
            try { output.attestRetainedWindow(recovered.retainedWindow); }
            catch { return { status: "blocked", code: "evidence_continuation_unavailable" }; }
            recovered.channel.subscribeBackpressuredOutput(async (metadata, bytes) => {
              try {
                exactCleanupOwner(record.sessionId, record.ownerId, record.fencingToken);
                const current = options.kernel.store.readOutputCheckpoint(record.sessionId);
                if (clock().getTime() >= deadlineAt || current?.outcome !== "active" ||
                    current.ownerId !== record.ownerId || current.fencingToken !== record.fencingToken ||
                    !current.streams.some((stream) => stream.consumed.some((entry) => same(entry, metadata)))) unavailable();
                return await output.accept(metadata, bytes);
              } catch (error) { context.detachOutputFailed = true; throw error; }
            });
            context.detachSettlement = recovered.channel.settleBackpressuredOutput(deadlineAt);
          }
          const settlement = await context.detachSettlement;
          exactCleanupOwner(record.sessionId, record.ownerId, record.fencingToken);
          if (clock().getTime() >= deadlineAt) return { status: "blocked", code: "cleanup_deadline_expired" };
          if (context.detachOutputFailed) return { status: "blocked", code: "evidence_continuation_unavailable" };
          if (settlement?.status !== "settled") return { status: "blocked", code: "cleanup_effect_outcome_unknown" };
          await context.detachChannel.detach();
        }
        return { status: "verified" };
      } catch { return { status: "blocked", code: "channel_detach_failed" }; }
    }
    if (resource === "backend_release") {
      const outcome = await options.host.release({
        launchId: context.control.launch.launchId,
        record: context.control.launch,
        fence: context.control.fence,
        deadlineAt,
      });
      return outcome === "verified" ? { status: "verified" } : {
        status: "blocked",
        code: "backend_release_reconciliation_required",
      };
    }
    try {
      await options.isolation.release(record.lease);
      return { status: "verified" };
    } catch { return { status: "blocked", code: "isolation_release_failed" }; }
  };
  const settleAdoptedResource = async (
    sessionId: string,
    resource: AdoptedCleanupResourceKind,
    context: AdoptedCleanupContext,
    run: AdoptedCleanupRun,
  ): Promise<void> => {
    const deadlineAt = run.deadlineAt;
    let record = options.kernel.store.readBySession(sessionId);
    if (!record) throw runnerSessionError("cleanup_blocked", "Adopted cleanup record is unavailable.");
    const cleanup = currentCleanup(record);
    let fact = cleanup?.progress?.resources.find((candidate) => candidate.resource === resource);
    if (!cleanup || !fact) throw runnerSessionError("cleanup_blocked", "Adopted cleanup resource authority is unavailable.");
    if (fact.status === "verified") return;
    const requireVerified = () => {
      const current = exactCleanupOwner(sessionId, run.ownerId, run.fencingToken);
      if (currentCleanup(current)?.progress?.resources.find((candidate) => candidate.resource === resource)?.status !== "verified") {
        throw runnerSessionError("cleanup_blocked", "Cleanup prerequisite was not durably verified by the joined operation.");
      }
    };
    if (fact.attempt) run.issued = { effectId: cleanup.effectId, resource, attempt: fact.attempt };
    let observedEvidence: AdoptedCleanupEvidenceReference | undefined;
    const observeRetainedAttempt = async () => {
      if (!fact?.attempt) return "outcome_unknown" as const;
      if (resource === "evidence") {
        try {
          const checkpoint = options.kernel.store.readOutputCheckpoint(sessionId);
          if (!options.output.artifacts || !checkpoint?.continuation?.finalized) return "outcome_unknown" as const;
          await prepareAdoptedCleanupOutput(record!, context);
          const result = await performAdoptedCleanupEffect(record!, "evidence", context, deadlineAt);
          if (result.status !== "verified" || result.evidence?.kind !== "bounded_output_manifest") return "outcome_unknown" as const;
          observedEvidence = result.evidence;
          return "verified" as const;
        } catch { return "outcome_unknown" as const; }
      }
      if (resource === "retained_output_settlement") {
        try {
          const cleanup = await prepareAdoptedCleanupOutput(record!, context);
          await settleAttachmentOutput(sessionId, cleanup, deadlineAt, () => { exactCleanupOwner(sessionId, record!.ownerId, record!.fencingToken); });
          const checkpoint = options.kernel.store.readOutputCheckpoint(sessionId);
          const snapshot = cleanup.output.snapshot();
          return checkpoint?.outcome === "active" && checkpoint.ownerId === record!.ownerId &&
            checkpoint.fencingToken === record!.fencingToken && snapshot.outcome === "active" &&
            snapshot.pending === 0 && snapshot.heldBytes === 0 && cleanup.intakeCount === 0
            ? "verified" as const : "outcome_unknown" as const;
        } catch { return "outcome_unknown" as const; }
      }
      if (resource !== "workload_quiescence") return "outcome_unknown" as const;
      context.control = adoptedBackendControl(record!);
      return await options.host.observeQuiescence({
        launchId: context.control.launch.launchId,
        record: context.control.launch,
        fence: context.control.fence,
        deadlineAt,
      });
    };
    if (fact.status === "blocked" && fact.attempt) {
      const observed = await observeRetainedAttempt();
      if (observed !== "verified" || clock().getTime() >= deadlineAt) {
        throw runnerSessionError("cleanup_blocked", "Adopted cleanup reconciliation remains unresolved.");
      }
      writer.apply({
        type: "settle_cleanup_resource", sessionId, ownerId: record.ownerId, fencingToken: record.fencingToken,
        expectedRevision: record.revision, effectId: cleanup.effectId, resource,
        attemptId: fact.attempt.attemptId, attemptOwnerId: fact.attempt.ownerId,
        attemptFencingToken: fact.attempt.fencingToken, result: "verified", at: clock().toISOString(),
        ...(observedEvidence ? { evidence: observedEvidence } : {}),
      });
      return;
    }
    if (fact.status === "blocked") {
      record = writer.apply({
        type: "retry_cleanup_resource", sessionId, ownerId: record.ownerId, fencingToken: record.fencingToken,
        expectedRevision: record.revision, effectId: cleanup.effectId, resource, at: clock().toISOString(),
      });
      fact = currentCleanup(record)!.progress!.resources.find((candidate) => candidate.resource === resource)!;
    }
    if (fact.status === "in_flight") {
      const tracked = fact.attempt && adoptedEffectRuns.get(fact.attempt.attemptId);
      if (tracked && tracked.ownerId === record.ownerId && tracked.fencingToken === record.fencingToken) {
        await tracked.promise;
        requireVerified();
        return;
      }
      const observed = await observeRetainedAttempt();
      if (observed === "verified" && clock().getTime() < deadlineAt) {
        writer.apply({
          type: "settle_cleanup_resource", sessionId, ownerId: record.ownerId, fencingToken: record.fencingToken,
          expectedRevision: record.revision, effectId: cleanup.effectId, resource,
          attemptId: fact.attempt!.attemptId, attemptOwnerId: fact.attempt!.ownerId,
          attemptFencingToken: fact.attempt!.fencingToken, result: "verified", at: clock().toISOString(),
          ...(observedEvidence ? { evidence: observedEvidence } : {}),
        });
        return;
      }
      const blockerCode = resource === "evidence" ? "evidence_continuation_unavailable" as const
        : resource === "backend_release" ? "backend_release_reconciliation_required" as const
        : clock().getTime() >= Date.parse(fact.attempt!.deadlineAt) ? "cleanup_deadline_expired" as const
        : "cleanup_effect_outcome_unknown" as const;
      writer.apply({
        type: "settle_cleanup_resource", sessionId, ownerId: record.ownerId, fencingToken: record.fencingToken,
        expectedRevision: record.revision, effectId: cleanup.effectId, resource,
        attemptId: fact.attempt!.attemptId, attemptOwnerId: fact.attempt!.ownerId,
        attemptFencingToken: fact.attempt!.fencingToken, result: "blocked",
        blocker: cleanupBlocker(blockerCode), at: clock().toISOString(),
      });
      throw runnerSessionError("cleanup_blocked", "Adopted cleanup effect requires exact observed reconciliation after restart.");
    }
    const startedAt = clock().toISOString();
    if (Date.parse(startedAt) >= deadlineAt) {
      writer.apply({ type: "expire_cleanup_resource", sessionId, ownerId: record.ownerId, fencingToken: record.fencingToken,
        expectedRevision: record.revision, effectId: cleanup.effectId, resource,
        deadlineAt: new Date(deadlineAt).toISOString(), at: startedAt });
      throw runnerSessionError("cleanup_blocked", "Adopted cleanup deadline expired before the next effect.");
    }
    record = writer.apply({
      type: "begin_cleanup_resource", sessionId, ownerId: record.ownerId, fencingToken: record.fencingToken,
      expectedRevision: record.revision, effectId: cleanup.effectId, resource,
      startedAt, deadlineAt: new Date(deadlineAt).toISOString(), at: startedAt,
    });
    const issuedCleanup = currentCleanup(record)!;
    const issued = issuedCleanup.progress!.resources.find((candidate) => candidate.resource === resource)!;
    const attempt = issued.attempt!;
    run.issued = { effectId: issuedCleanup.effectId, resource, attempt };
    const effect = (async () => {
      let outcome: Awaited<ReturnType<typeof performAdoptedCleanupEffect>>;
      try { outcome = await performAdoptedCleanupEffect(record!, resource, context, deadlineAt); }
      catch { outcome = { status: "blocked", code: "cleanup_effect_outcome_unknown" }; }
      const current = options.kernel.store.readBySession(sessionId);
      if (!current || current.state !== "cleanup_pending" || current.ownerId !== record!.ownerId ||
          current.fencingToken !== record!.fencingToken) return outcome;
      const settledAt = clock().toISOString();
      if (Date.parse(settledAt) >= Date.parse(attempt.deadlineAt)) {
        outcome = { status: "blocked", code: "cleanup_deadline_expired" };
      }
      writer.apply({
        type: "settle_cleanup_resource", sessionId, ownerId: current.ownerId, fencingToken: current.fencingToken,
        expectedRevision: current.revision, effectId: issuedCleanup.effectId, resource,
        attemptId: attempt.attemptId, attemptOwnerId: attempt.ownerId,
        attemptFencingToken: attempt.fencingToken, result: outcome.status,
        ...(outcome.status === "blocked" ? { blocker: cleanupBlocker(outcome.code) } : {}),
        ...(outcome.status === "verified" && outcome.evidence ? { evidence: outcome.evidence } : {}),
        at: settledAt,
      });
      return outcome;
    })();
    adoptedEffectRuns.set(attempt.attemptId, { ownerId: run.ownerId, fencingToken: run.fencingToken, promise: effect });
    try {
      const outcome = await effect;
      if (outcome.status === "blocked") throw runnerSessionError("cleanup_blocked", "Adopted streaming session cleanup failed.");
      requireVerified();
    } finally {
      if (adoptedEffectRuns.get(attempt.attemptId)?.promise === effect) adoptedEffectRuns.delete(attempt.attemptId);
    }
  };
  const performAdoptedCleanup = async (
    sessionId: string,
    run: AdoptedCleanupRun,
    disposition: "backend_unavailable" | "outcome_unknown",
    live?: PrivateAttachment,
  ): Promise<void> => {
    const closingInput = (live ?? attachments.get(sessionId))?.gracefulInputClose;
    if (closingInput) await bounded(closingInput, Math.max(1, run.deadlineAt - clock().getTime()));
    if (closingInput && clock().getTime() >= run.deadlineAt) throw runnerSessionError("cleanup_blocked", "Graceful input acknowledgement exceeded the cleanup ownership deadline.");
    let record = renewOwnedSessionLease(sessionId);
    if (!record) throw runnerSessionError("launch_failed", "Adopted session record disappeared during cleanup.");
    if (record.state === "active") record = options.sessions.recordDisposition({
      sessionId, ownerId: record.ownerId, fencingToken: record.fencingToken,
      expectedRevision: record.revision, disposition,
    }).record;
    if (record.state === "cleanup_blocked") {
      const cleanup = currentCleanup(record);
      const blocked = cleanup?.progress?.resources.filter((resource) => resource.status === "blocked") ?? [];
      if (!cleanup) throw runnerSessionError("cleanup_blocked", "Adopted cleanup authority is unavailable.");
      if (blocked.length === 0) {
        record = writer.apply({
          type: "retry_cleanup", sessionId, ownerId: record.ownerId, fencingToken: record.fencingToken,
          expectedRevision: record.revision, effectId: cleanup.effectId, at: clock().toISOString(),
        });
      } else if (blocked.length === 1 && !blocked[0]!.attempt && blocked[0]!.resource === "evidence" &&
          blocked[0]!.blocker?.code === "evidence_finalization_failed" && options.output.artifacts) {
        const checkpoint = options.kernel.store.readOutputCheckpoint(sessionId);
        const observation = { type: "observe_finalized_evidence", sessionId, ownerId: run.ownerId, fencingToken: run.fencingToken,
          expectedRevision: record.revision, effectId: cleanup.effectId, resourceIdentity: blocked[0]!.identity,
          checkpoint, at: clock().toISOString(), deadlineAt: new Date(run.deadlineAt).toISOString() };
        validateFinalizedEvidenceObservation(record, checkpoint, observation);
        await verifyFinalizedEvidence(options.output.artifacts, checkpoint!.continuation!);
        // The store rechecks the entire checkpoint and exact session authority in
        // one transaction. Observation never issues or retains an effect attempt.
        record = writer.apply({ ...observation, at: clock().toISOString() });
      } else if (blocked.length === 1 && !blocked[0]!.attempt) {
        record = writer.apply({
          type: "retry_cleanup_resource", sessionId, ownerId: record.ownerId, fencingToken: record.fencingToken,
          expectedRevision: record.revision, effectId: cleanup.effectId, resource: blocked[0]!.resource,
          at: clock().toISOString(),
        });
      } else if (blocked.length !== 1) {
        throw runnerSessionError("cleanup_blocked", "Adopted cleanup has no exact retryable blocker.");
      }
    } else if (record.state !== "cleanup_pending") {
      record = writer.apply({
        type: "begin_cleanup", sessionId, ownerId: record.ownerId, fencingToken: record.fencingToken,
        expectedRevision: record.revision, effectId: `cleanup:${sessionId}:${record.fencingToken}`,
        at: clock().toISOString(),
      });
    }
    const ownerId = record.ownerId;
    const fencingToken = record.fencingToken;
    const cleanup = currentCleanup(record);
    if (!cleanup?.progress) throw runnerSessionError("cleanup_blocked", "Adopted cleanup progress is unavailable.");
    const context = contextFor(record, live);
    for (const resource of cleanup.progress.resources.map((fact) => fact.resource)) {
      exactCleanupOwner(sessionId, ownerId, fencingToken);
      await settleAdoptedResource(sessionId, resource, context, run);
    }
    const ready = exactCleanupOwner(sessionId, ownerId, fencingToken);
    const completed = options.sessions.completeAdoptedCleanup({
      sessionId, ownerId, fencingToken, expectedRevision: ready.revision, effectId: cleanup.effectId,
    });
    if (completed.record.state !== "released") throw runnerSessionError("cleanup_blocked", "Adopted cleanup did not reach release.");
    const checkpoint = options.kernel.store.readOutputCheckpoint(sessionId);
    if (checkpoint?.continuation) writer.deleteOutputCheckpoint({ sessionId, ownerId: checkpoint.ownerId, fencingToken: checkpoint.fencingToken, expectedRevision: checkpoint.revision,
      evidence: currentCleanup(completed.record)?.progress?.resources.find((fact) => fact.resource === "evidence")?.evidence });
    attachments.delete(sessionId);
    adoptedCleanupContexts.delete(sessionId);
  };
  const runAdoptedCleanup = (
    sessionId: string,
    deadlineAt: number,
    disposition: "backend_unavailable" | "outcome_unknown",
    live?: PrivateAttachment,
    signal?: AbortSignal,
  ) => {
    const record = options.kernel.store.readBySession(sessionId);
    if (!record) return Promise.reject(runnerSessionError("cleanup_blocked", "Adopted cleanup record is unavailable."));
    const existing = adoptedCleanupRuns.get(sessionId);
    if (existing && existing.ownerId === record.ownerId && existing.fencingToken === record.fencingToken &&
        clock().getTime() < existing.deadlineAt) return awaitAdoptedCleanup(sessionId, existing, deadlineAt, signal);
    renewOwnedSessionLease(sessionId, deadlineAt);
    const run: AdoptedCleanupRun = { ownerId: record.ownerId, fencingToken: record.fencingToken, deadlineAt, promise: Promise.resolve() };
    run.promise = performAdoptedCleanup(sessionId, run, disposition, live)
      .finally(() => { if (adoptedCleanupRuns.get(sessionId) === run) adoptedCleanupRuns.delete(sessionId); });
    adoptedCleanupRuns.set(sessionId, run);
    return awaitAdoptedCleanup(sessionId, run, deadlineAt, signal);
  };
  const settleAdoptedAttachment = async (
    sessionId: string,
    attachment: PrivateAttachment,
    disposition: "backend_unavailable" | "outcome_unknown",
  ) => {
    const deadlineAt = clock().getTime() + 30_000;
    return await runAdoptedCleanup(sessionId, deadlineAt, disposition, attachment);
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
      const effect = <T>(kind: NonNullable<typeof activeEffectKind>, operation: () => Promise<T>) => {
        effectPending = true; activeEffectKind = kind;
        const promise = Promise.resolve().then(() => { options.sessions.validateStagedLaunch(staged, request); throwIfAborted(request.signal); return operation(); });
        activeEffect = promise.then(() => { effectPending = false; }, () => { effectPending = false; });
        if (kind === "channel") {
          const acquisition = activeEffect;
          originalChannelAcquisitions.set(request.launchId, acquisition);
          void acquisition.then(() => { if (originalChannelAcquisitions.get(request.launchId) === acquisition) originalChannelAcquisitions.delete(request.launchId); });
        }
        return abortable(promise, request.signal);
      };
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
        assertSessionEnvelopeSubset(request.envelope, claims);
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
          const acquired = await options.channel.acquire(exactBackendBinding, { ownerId: host.ownerId, fencingToken: host.fencingToken });
          channel = acquired;
          const cleanupCapability: HostCleanupChannelCapability = { sessionId: request.sessionId, identity: channelCleanupIdentity(request.sessionId, exactBackendBinding), channel: acquired, ownerId: host.ownerId, fencingToken: host.fencingToken, detached: false };
          hostCleanupChannels.set(request.launchId, cleanupCapability);
          if (request.signal?.aborted) { cleanupCapability.detaching = acquired.detach().then(() => { cleanupCapability.detached = true; }, (error) => { cleanupCapability.failed = true; throw remintRunnerSessionError(error) ?? error; }); void cleanupCapability.detaching.catch(() => undefined); }
          return acquired;
        }); options.sessions.validateStagedLaunch(staged, request);
        const sessionOwnerId = `session-authority:${claims.runId}:${claims.grantId}`;
        host = writer.claimHostOutputCheckpoint({ launchId: request.launchId, ownerId, fencingToken: 1, expectedRevision: host.revision, at: clock().toISOString(), record: { recordKind: "runner.output-checkpoint", schemaVersion: 1, revision: 0, sessionId: request.sessionId, ownerId: sessionOwnerId, fencingToken: 1, capacity: options.output.maxAcceptedChunks, outcome: "active", streams: [{ stream: "stdout", lastConsumed: null, consumed: [], accepted: [], consumingIntent: null }, { stream: "stderr", lastConsumed: null, consumed: [], accepted: [], consumingIntent: null }] } }).host;
        attachment = createAttachment(
          request.sessionId,
          sessionOwnerId,
          1,
          channel,
          async () => await settleCleanup(),
          "authorized_family",
          request.protocolStreams ?? options.output.protocolStreams,
        );
        const cleanupCapability = hostCleanupChannels.get(request.launchId); if (cleanupCapability) { cleanupCapability.attachment = attachment; cleanupCapability.cleanup = async () => await closeAttachment(request.sessionId, attachment!); }
        startAttachment(request.sessionId, attachment);
        options.sessions.validateStagedLaunch(staged, request);
        const handshakeDigest = await effect("handshake", () => options.handshake.verify(channel!, Object.freeze({
          write: async (payload: Uint8Array, timeoutMs: number) => await writeAttachment(attachment!, payload, timeoutMs),
          waitForOutput: async (signal?: AbortSignal) => await attachment!.output.waitForPending(signal),
          deliverOutput: async (deliver: (stream: StreamingOutputStream, bytes: Uint8Array) => Promise<void>) =>
            await attachment!.output.deliverNextPrivately(deliver),
        }))); options.sessions.validateStagedLaunch(staged, request); throwIfAborted(request.signal);
        host = writer.transitionLaunch({ type: "verify_handshake", launchId: request.launchId, ownerId, fencingToken: 1, expectedRevision: host.revision, handshakeDigest, at: clock().toISOString() });
        const adopted = options.sessions.finalizeLaunch({ staged, launchId: request.launchId, sessionId: request.sessionId, ownerId, fencingToken: 1, expectedRevision: host.revision, lease, backendBinding, handshakeDigest, envelope: request.envelope });
        attachments.set(request.sessionId, attachment); revoker.dispose();
        return Object.freeze({
          sessionId: request.sessionId, record: adopted.record,
          request: createStreamingRequestOperation({
            sessionId: request.sessionId,
            retainOwnership: (timeoutMs) => { renewOwnedSessionLease(request.sessionId, clock().getTime() + timeoutMs); },
            assert: (authorization, expected) => options.sessions.assertOperationAuthorization(authorization, expected),
            write: (payload, timeoutMs, assertCurrent) => writeAttachment(attachment!, payload, timeoutMs, assertCurrent),
            waitForOutput: (signal) => attachment!.output.waitForPending(signal),
            deliver: (authorization, expected, deliver, assertCurrent) => attachment!.output.deliverForRequest(authorization, expected, deliver, assertCurrent),
          }),
          authorizeFirstOperation: (operation: LaunchOperationAuthorizationRequest) => {
            renewOwnedSessionLease(request.sessionId);
            return options.sessions.authorizeLaunchOperation(operation);
          },
          authorizeOperation: (operation: SessionOperationRequest) => {
            renewOwnedSessionLease(request.sessionId);
            return options.sessions.authorizeOperation(operation);
          },
          write: async (
            authorization: SessionOperationAuthorization,
            assertion: OperationAuthorizationAssertion,
            payload: Uint8Array,
            timeoutMs: number,
          ) => {
            options.sessions.assertOperationAuthorization(authorization, { ...assertion, sessionId: request.sessionId, operation: "write" });
            await writeAttachment(attachment!, payload, timeoutMs);
          },
          waitForOutput: async (signal?: AbortSignal) => await attachment!.output.waitForPending(signal),
          deliverOutput: async (
            authorization: SessionOperationAuthorization,
            assertion: OperationAuthorizationAssertion,
            deliver?: (stream: StreamingOutputStream, bytes: Uint8Array) => Promise<void>,
          ) => {
            try { return await attachment!.output.deliverNext(authorization, assertion, deliver); }
            catch (error) { if (error instanceof Error) { const reminted = remintRunnerSessionError(error.cause); if (reminted) throw reminted; } throw remintRunnerSessionError(error) ?? error; }
          },
          stop: async (authorization: SessionOperationAuthorization, assertion: OperationAuthorizationAssertion) => { options.sessions.assertOperationAuthorization(authorization, { ...assertion, sessionId: request.sessionId, operation: "stop" }); await settleAdoptedAttachment(request.sessionId, attachment!, "backend_unavailable"); return Object.freeze({ record: options.kernel.store.readBySession(request.sessionId), evidence: finalizedEvidence.get(request.sessionId) }); },
        });
      } catch (error) {
        if (request.signal?.aborted && effectPending) {
          unresolvedProviderEffects.add(request.launchId);
          blockUnresolvedEffect();
          const immediateCleanup = runHostCleanup(request.launchId, 25);
          void activeEffect.then(async () => {
            // A late acquisition may return while the immediate cleanup still
            // holds only its earlier host obligation. Keep that cleanup blocked
            // until it settles, then durably bind every newly known resource
            // before allowing a retry to certify final release.
            try { await immediateCleanup; } catch {}
            bindKnownResults();
            unresolvedProviderEffects.delete(request.launchId);
            cleanupPromise = undefined;
            if (hostCleanupChannels.get(request.launchId)?.failed) return;
            await runHostCleanup(request.launchId, 25);
          }).catch((failure) => { if (attachment) attachment.failure = failure; });
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
    async cleanupOwnedSession(input: {
      readonly gracefulShutdownMs?: number;
      readonly sessionId: string;
      readonly timeoutMs: number;
      readonly signal?: AbortSignal;
    }) {
      if (!input.sessionId || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) {
        throw runnerSessionError("cleanup_blocked", "Streaming cleanup request is invalid.");
      }
      throwIfAborted(input.signal);
      const record = options.kernel.store.readBySession(input.sessionId);
      if (!record || record.state === "released") return Object.freeze({ released: true as const });
      const attachment = attachments.get(input.sessionId);
      const deadlineAt = clock().getTime() + input.timeoutMs;
      if (input.gracefulShutdownMs !== undefined) {
        if (!Number.isSafeInteger(input.gracefulShutdownMs) || input.gracefulShutdownMs < 1 || input.gracefulShutdownMs > input.timeoutMs)
          throw runnerSessionError("cleanup_blocked", "Graceful shutdown bound is invalid.");
        if (attachment && record.state === "active" && record.ownerId === attachment.outputOwnerId && record.fencingToken === attachment.outputFencingToken) {
          const channel = attachment.channel as Partial<InteractiveProcessChannel>;
          if (channel.closeInput && channel.waitForTerminal) {
            renewOwnedSessionLease(input.sessionId, deadlineAt);
            attachment.gracefulInputClose ??= (async () => {
              await attachment.writeTail;
              try { await channel.closeInput!(); return "acknowledged" as const; }
              catch { return "failed" as const; }
            })();
            // Sending EOF is a retained effect, not the grace interval itself.
            // Join its acknowledgement before changing fences; only the later
            // terminal wait may expire into normal owned escalation.
            const closedInput = await bounded(attachment.gracefulInputClose, Math.max(1, deadlineAt - clock().getTime()), input.signal);
            if (closedInput === "acknowledged") {
              try { await bounded(channel.waitForTerminal(), Math.min(input.gracefulShutdownMs, Math.max(1, deadlineAt - clock().getTime())), input.signal); } catch {}
            }
          }
        }
      }
      await runAdoptedCleanup(input.sessionId, deadlineAt, "backend_unavailable", attachment, input.signal);
      const settled = options.kernel.store.readBySession(input.sessionId);
      if (settled?.state !== "released") {
        throw runnerSessionError("cleanup_blocked", "Owned streaming cleanup did not reach verified release.");
      }
      return Object.freeze({ released: true as const });
    },
    async reconcileStartup(input: { readonly maxRecords: number; readonly timeoutMs?: number; readonly signal?: AbortSignal }) {
      if (!Number.isSafeInteger(input.maxRecords) || input.maxRecords < 1) throw runnerSessionError("launch_failed", "Recovery count bound is invalid.");
      const timeoutMs = input.timeoutMs ?? 1_000; if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw runnerSessionError("launch_failed", "Recovery time bound is invalid.");
      throwIfAborted(input.signal);
      const deadline = clock().getTime() + timeoutMs;
      const remainingTime = () => { const remaining = deadline - clock().getTime(); if (remaining <= 0) throw runnerSessionError("launch_failed", "Streaming recovery exhausted its total deadline."); return remaining; };
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
      const sessionOutcomes: Array<{ sessionId: string; disposition: "reattached" | "input_unavailable" | "outcome_unknown" | "cleanup_released" | "cleanup_blocked"; cleanupBlocked?: boolean }> = [];
      for (const sessionId of options.kernel.store.listSessionIds()) {
        throwIfAborted(input.signal);
        if (inspected >= input.maxRecords) break;
        inspected++;
        let session = options.kernel.store.readBySession(sessionId)!;
        if (session.state === "released") continue;
        let checkpoint = options.kernel.store.readOutputCheckpoint(sessionId);
        if (Date.parse(session.leaseExpiresAt) <= clock().getTime()) {
          try {
            if (checkpoint) {
              const taken = writer.takeoverAdoptedWithOutput({
                sessionId, ownerId: session.ownerId, fencingToken: session.fencingToken,
                expectedRevision: session.revision, outputExpectedRevision: checkpoint.revision,
                newOwnerId: `recovery-session:${sessionId}`, newFencingToken: session.fencingToken + 1,
                leaseExpiresAt: new Date(clock().getTime() + timeoutMs + 60_000).toISOString(),
                at: clock().toISOString(),
              });
              session = taken.session;
              checkpoint = taken.output;
            } else {
              session = options.sessions.takeover({
                sessionId, ownerId: session.ownerId, fencingToken: session.fencingToken,
                expectedRevision: session.revision, newOwnerId: `recovery-session:${sessionId}`,
                newFencingToken: session.fencingToken + 1,
                leaseExpiresAt: new Date(clock().getTime() + timeoutMs + 60_000).toISOString(),
              }).record;
            }
          } catch {
            sessionOutcomes.push({ sessionId, disposition: "outcome_unknown", cleanupBlocked: true });
            continue;
          }
        }
        if (session.state !== "active") {
          try {
            // Enter even after budget exhaustion so the first unissued fact
            // receives a durable expiry blocker under the original deadline.
            await runAdoptedCleanup(sessionId, deadline, "backend_unavailable", attachments.get(sessionId), input.signal);
            sessionOutcomes.push({ sessionId, disposition: "cleanup_released" });
          } catch {
            sessionOutcomes.push({ sessionId, disposition: "cleanup_blocked", cleanupBlocked: true });
          }
          continue;
        }
        if (attachments.has(sessionId)) {
          sessionOutcomes.push({ sessionId, disposition: "reattached" });
          continue;
        }
        if (!checkpoint || checkpoint.ownerId !== session.ownerId || checkpoint.fencingToken !== session.fencingToken || !options.channel.reattach) { const disposition = !checkpoint || (checkpoint && (checkpoint.ownerId !== session.ownerId || checkpoint.fencingToken !== session.fencingToken)) ? "outcome_unknown" : "input_unavailable"; options.sessions.recordDisposition({ sessionId, ownerId: session.ownerId, fencingToken: session.fencingToken, expectedRevision: session.revision, disposition }); sessionOutcomes.push({ sessionId, disposition }); continue; }
        let backendControl: ReturnType<typeof adoptedBackendControl>;
        try { backendControl = adoptedBackendControl(session); }
        catch {
          options.sessions.recordDisposition({ sessionId, ownerId: session.ownerId, fencingToken: session.fencingToken, expectedRevision: session.revision, disposition: "outcome_unknown" });
          sessionOutcomes.push({ sessionId, disposition: "outcome_unknown" });
          continue;
        }
        let reattached: ReattachedFakeChannel;
        try {
          const waitMs = remainingTime();
          const provider = Promise.resolve().then(() => options.channel.reattach!(session.backendBinding, backendControl.fence));
          reattached = await boundedLateResource(provider, waitMs, input.signal, async (late) => {
            let cleanupFailure: unknown;
            try { await late.channel.detach(); }
            catch (error) { cleanupFailure = error; }
            if (cleanupFailure) throw new AggregateError([cleanupFailure], "Late reattach resource cleanup failed.");
          }, (late, failure) => {
            lateCleanupChannels.set(sessionId, { channel: late.channel, failure, detached: false });
          });
        }
        catch { options.sessions.recordDisposition({ sessionId, ownerId: session.ownerId, fencingToken: session.fencingToken, expectedRevision: session.revision, disposition: "input_unavailable" }); sessionOutcomes.push({ sessionId, disposition: "input_unavailable" }); continue; }
        if (reattached.version !== BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION || !same(reattached.binding, session.backendBinding) || reattached.replayCapacityChunks !== checkpoint.capacity || reattached.replayCapacityBytes < options.output.maxQueueBytes) {
          options.sessions.recordDisposition({ sessionId, ownerId: session.ownerId, fencingToken: session.fencingToken, expectedRevision: session.revision, disposition: "outcome_unknown" });
          let cleanupBlocked = false;
          try { await bounded(reattached.channel.detach(), remainingTime(), input.signal); }
          catch (failure) {
            cleanupBlocked = true;
            lateCleanupChannels.set(sessionId, { channel: reattached.channel, failure, detached: false });
          }
          sessionOutcomes.push({ sessionId, disposition: "outcome_unknown", ...(cleanupBlocked ? { cleanupBlocked } : {}) }); continue;
        }
        const attachment = createAttachment(sessionId, checkpoint.ownerId, checkpoint.fencingToken, reattached.channel);
        try { attachment.output.attestRetainedWindow(reattached.retainedWindow); }
        catch (error) {
          options.sessions.recordDisposition({ sessionId, ownerId: session.ownerId, fencingToken: session.fencingToken, expectedRevision: session.revision, disposition: "outcome_unknown" });
          let cleanupBlocked = false;
          try { await bounded(closeAttachment(sessionId, attachment), remainingTime(), input.signal); }
          catch (cleanupError) { cleanupBlocked = true; attachment.failure = new AggregateError([error, cleanupError], "Recovered output cleanup blocked."); attachments.set(sessionId, attachment); }
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
function cleanupResourceOrder(
  resource: HostCleanupResourceFact["resource"],
  preserveOutputUntilHostQuiescence: boolean,
): number {
  return (preserveOutputUntilHostQuiescence
    ? { host: 0, channel: 1, output_checkpoint: 2, isolation_lease: 3 }
    : { channel: 0, output_checkpoint: 1, host: 2, isolation_lease: 3 }
  )[resource];
}
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
