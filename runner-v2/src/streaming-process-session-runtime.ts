import { registerConsumedExecutionGrantRevoker, type ExecutionGrantBinding, type OpaqueExecutionGrant, type ConsumedExecutionGrantClaims } from "./execution-grants.js";
import type { SessionAuthority } from "./session-authority.js";
import type { StreamingSessionBackendBinding, StreamingSessionEnvelope, StreamingSessionLease, StreamingSessionStoreKernel } from "./streaming-session-store.js";
import { getStreamingSessionKernelWriter } from "./streaming-session-store.js";

export type StreamingProcessSessionErrorCode = "lossless_output_unavailable" | "launch_failed" | "handshake_refused" | "cleanup_blocked" | "cancelled";
export class StreamingProcessSessionError extends Error { constructor(readonly code: StreamingProcessSessionErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.name = "StreamingProcessSessionError"; } }

export interface FakeStreamingChannel {
  startOutput(): Promise<void>;
  waitTerminal(): Promise<unknown>;
  detach(): Promise<void>;
}
export interface StreamingRuntimeOptions {
  readonly sessions: SessionAuthority;
  readonly kernel: StreamingSessionStoreKernel;
  readonly clock?: () => Date;
  readonly isolation: { acquire(input: { launchId: string; claims: ConsumedExecutionGrantClaims }): Promise<StreamingSessionLease>; release(lease: StreamingSessionLease): Promise<void> };
  readonly host: { launch(input: { launchId: string; claims: ConsumedExecutionGrantClaims; lease: StreamingSessionLease }): Promise<StreamingSessionBackendBinding>; reconcile(input: { launchId: string; record: unknown }): Promise<"cleaned" | "blocked" | "outcome_unknown"> };
  readonly channel: { readonly version: number; acquire(binding: StreamingSessionBackendBinding): Promise<FakeStreamingChannel> };
  readonly handshake: { verify(channel: FakeStreamingChannel): Promise<string> };
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
        ownerId, fencingToken: 1, state: "prepared", cleanupOwner: "host_control",
        history: [{ state: "prepared", at }], effects: [{ effectId: `isolate:${request.launchId}`, kind: "isolate", status: "pending", ownerId, fencingToken: 1, createdAt: at }],
      });
      let lease: StreamingSessionLease | undefined;
      let channel: FakeStreamingChannel | undefined;
      const revoker = await registerConsumedExecutionGrantRevoker(claims, async () => {
        const record = options.kernel.store.readHostLaunch(request.launchId);
        if (record && record.state !== "handed_off" && record.state !== "released") await options.host.reconcile({ launchId: request.launchId, record });
        if (lease) await options.isolation.release(lease);
      });
      try {
        lease = await options.isolation.acquire({ launchId: request.launchId, claims });
        let host = writer.transitionLaunch({ type: "bind_isolation", launchId: request.launchId, ownerId, fencingToken: 1, expectedRevision: 0, leaseId: lease.leaseId, providerId: lease.providerId, providerIdentity: lease.providerIdentity, at: clock().toISOString() });
        host = writer.transitionLaunch({ type: "begin_launch", launchId: request.launchId, ownerId, fencingToken: 1, expectedRevision: host.revision, at: clock().toISOString() });
        const backendBinding = await options.host.launch({ launchId: request.launchId, claims, lease });
        host = writer.transitionLaunch({ type: "bind_backend", launchId: request.launchId, ownerId, fencingToken: 1, expectedRevision: host.revision, backendBinding, at: clock().toISOString() });
        if (options.channel.version !== 2) throw new StreamingProcessSessionError("lossless_output_unavailable", "Selected channel does not attest lossless backpressured output v2.");
        channel = await options.channel.acquire(backendBinding);
        await channel.startOutput();
        const handshakeDigest = await options.handshake.verify(channel);
        host = writer.transitionLaunch({ type: "verify_handshake", launchId: request.launchId, ownerId, fencingToken: 1, expectedRevision: host.revision, handshakeDigest, at: clock().toISOString() });
        const adopted = options.sessions.finalizeLaunch({ staged, launchId: request.launchId, sessionId: request.sessionId, ownerId, fencingToken: 1, expectedRevision: host.revision, lease, backendBinding, handshakeDigest, envelope: request.envelope });
        revoker.dispose();
        return Object.freeze({ sessionId: request.sessionId, record: adopted.record });
      } catch (error) {
        await channel?.detach().catch(() => undefined);
        if (lease) await options.isolation.release(lease).catch(() => undefined);
        revoker.dispose();
        throw error;
      }
    },
    async reconcileStartup(input: { readonly maxRecords: number }) {
      if (!Number.isSafeInteger(input.maxRecords) || input.maxRecords < 1) throw new StreamingProcessSessionError("launch_failed", "Recovery bound is invalid.");
      const outcomes: Array<{ launchId: string; disposition: "cleaned" | "blocked" | "outcome_unknown" }> = [];
      for (const launchId of options.kernel.store.listHostLaunchIds().slice(0, input.maxRecords)) {
        const record = options.kernel.store.readHostLaunch(launchId)!;
        if (record.state === "handed_off" || record.state === "released") continue;
        const disposition = await options.host.reconcile({ launchId, record });
        outcomes.push({ launchId, disposition });
      }
      return Object.freeze({ processed: outcomes.length, outcomes: Object.freeze(outcomes.map(Object.freeze)) });
    },
  });
}
