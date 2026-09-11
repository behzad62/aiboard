import type {
  ExecutionGrantAuthority,
  ExecutionGrantBinding,
  OpaqueExecutionGrant,
  ConsumedExecutionGrantClaims,
} from "./execution-grants.js";
import { assertCurrentConsumedExecutionGrantClaims } from "./execution-grants.js";
import {
  STREAMING_SESSION_RECORD_VERSION,
  getStreamingSessionKernelWriter,
  getStreamingSessionStoreWriter,
  type StreamingSessionAccess,
  type StreamingSessionBackendBinding,
  type StreamingSessionEnvelope,
  type StreamingSessionLease,
  type StreamingSessionRecord,
  type StreamingSessionStoreKernel,
} from "./streaming-session-store.js";

export type SessionAuthorityErrorCode =
  | "envelope_escalation"
  | "authorization_forged"
  | "authorization_stale"
  | "authorization_revoked"
  | "operation_mismatch"
  | "session_unavailable"
  | "launch_call_consumed"
  | "recovery_refused"
  | "binding_mismatch"
  | "second_grant_for_call"
  | "session_collision";

const RUNNER_STAGED_LAUNCH_AUTHORIZATION: unique symbol = Symbol("runner-staged-launch-authorization");
export interface StagedLaunchAuthorization { readonly [RUNNER_STAGED_LAUNCH_AUTHORIZATION]: true }
export interface StageLaunchRequest {
  readonly sessionId: string;
  readonly launchId: string;
  readonly grant: OpaqueExecutionGrant;
  readonly binding: ExecutionGrantBinding;
}
export interface FinalizeLaunchRequest {
  readonly staged: StagedLaunchAuthorization;
  readonly launchId: string;
  readonly sessionId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly expectedRevision: number;
  readonly lease: StreamingSessionLease;
  readonly backendBinding: StreamingSessionBackendBinding;
  readonly handshakeDigest: string;
  readonly envelope: StreamingSessionEnvelope;
}
interface StagedLaunchRecord {
  readonly sessionId: string;
  readonly launchId: string;
  readonly callKey: string;
  readonly claims: ConsumedExecutionGrantClaims;
  used: boolean;
}
const KERNEL_STAGE_RESERVATIONS = new WeakMap<object, { sessionIds: Set<string>; launchIds: Set<string> }>();

export class SessionAuthorityError extends Error {
  constructor(readonly code: SessionAuthorityErrorCode, message: string) {
    super(message);
    this.name = "SessionAuthorityError";
  }
}

export interface SessionAuthorityOptions {
  readonly grants: ExecutionGrantAuthority;
  readonly sessions: StreamingSessionStoreKernel;
  readonly clock?: () => Date;
}

export interface SessionAuthorityTransferRequest {
  readonly sessionId: string;
  readonly grant: OpaqueExecutionGrant;
  readonly binding: ExecutionGrantBinding;
  readonly lease: StreamingSessionLease;
  readonly backendBinding: StreamingSessionBackendBinding;
  readonly envelope: StreamingSessionEnvelope;
}

export interface SessionAuthorityTransferAcknowledgement {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly expectedRevision: number;
  readonly effectId: string;
}

/** Runner recovery only: replaces a live owner with a strictly newer fence. */
export interface SessionAuthorityTakeoverRequest {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly expectedRevision: number;
  readonly newOwnerId: string;
  readonly newFencingToken: number;
  readonly leaseExpiresAt: string;
}

export type SessionUnavailableDisposition =
  | "input_unavailable"
  | "backend_unavailable"
  | "outcome_unknown";

/** Runner lifecycle only: durable proof that this child must not be relaunched. */
export interface SessionDispositionRequest {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly expectedRevision: number;
  readonly disposition: SessionUnavailableDisposition;
}

export type SessionOperation =
  | "write"
  | "close_input"
  | "request"
  | "stop"
  | "graceful_shutdown"
  | "subscribe"
  | "parse_delivery"
  | "input_control"
  | "protocol_response"
  | "family_delivery";

const RUNNER_SESSION_OPERATION_AUTHORIZATION: unique symbol = Symbol(
  "runner-session-operation-authorization",
);

/** Opaque Runner-private capability; it cannot be reconstructed from durable data. */
export interface SessionOperationAuthorization {
  readonly [RUNNER_SESSION_OPERATION_AUTHORIZATION]: true;
}

export interface LaunchOperationAuthorizationRequest {
  readonly sessionId: string;
  readonly operation: SessionOperation;
  readonly requestAccess: readonly StreamingSessionAccess[];
  readonly credentialNames: readonly string[];
  readonly networkApproved: boolean;
  readonly externalApproved: boolean;
  readonly destructiveApproved: boolean;
}

export interface SessionOperationRequest extends LaunchOperationAuthorizationRequest {
  readonly grant: OpaqueExecutionGrant;
  readonly binding: ExecutionGrantBinding;
}

export interface OperationAuthorizationAssertion {
  readonly sessionId: string;
  readonly operation: SessionOperation;
  readonly binding: ExecutionGrantBinding;
  readonly requestAccess: readonly StreamingSessionAccess[];
  readonly credentialNames: readonly string[];
  readonly networkApproved: boolean;
  readonly externalApproved: boolean;
  readonly destructiveApproved: boolean;
}

export interface SessionRecoveryEffect {
  readonly effectId: string;
  readonly kind: "transfer" | "cleanup";
  readonly fencingToken: number;
}

export interface UnadoptedSessionRecoveryRequest {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly replay: (effect: SessionRecoveryEffect) => "ambiguous" | "cleaned" | "blocked";
}

/** Runner lifecycle recovery only after durable transfer acknowledgement. */
export interface AdoptedSessionRecoveryRequest {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly replay: (effect: SessionRecoveryEffect) => "cleaned" | "blocked";
}

export interface CompleteAdoptedCleanupRequest {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly expectedRevision: number;
  readonly effectId: string;
}

interface AuthorizationRecord {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly operation: SessionOperation;
  readonly binding: ExecutionGrantBinding;
  readonly requestAccess: readonly StreamingSessionAccess[];
  readonly credentialNames: readonly string[];
  readonly networkApproved: boolean;
  readonly externalApproved: boolean;
  readonly destructiveApproved: boolean;
  readonly claims: ConsumedExecutionGrantClaims;
}


export interface SessionAuthority {
  stageLaunch(input: StageLaunchRequest): StagedLaunchAuthorization;
  validateStagedLaunch(
    staged: StagedLaunchAuthorization,
    expected: Readonly<{ sessionId: string; launchId: string }>,
  ): ConsumedExecutionGrantClaims;
  finalizeLaunch(input: FinalizeLaunchRequest): Readonly<{ record: Readonly<StreamingSessionRecord> }>;
  beginTransfer(input: SessionAuthorityTransferRequest): Readonly<{
    record: Readonly<StreamingSessionRecord>;
  }>;
  acknowledgeTransfer(input: SessionAuthorityTransferAcknowledgement): Readonly<{
    record: Readonly<StreamingSessionRecord>;
  }>;
  takeover(input: SessionAuthorityTakeoverRequest): Readonly<{
    record: Readonly<StreamingSessionRecord>;
  }>;
  recordDisposition(input: SessionDispositionRequest): Readonly<{
    record: Readonly<StreamingSessionRecord>;
  }>;
  authorizeLaunchOperation(input: LaunchOperationAuthorizationRequest): SessionOperationAuthorization;
  authorizeOperation(input: SessionOperationRequest): SessionOperationAuthorization;
  assertOperationAuthorization(
    authorization: SessionOperationAuthorization,
    expected: OperationAuthorizationAssertion,
  ): void;
  recoverUnadopted(input: UnadoptedSessionRecoveryRequest): Readonly<{
    record: Readonly<StreamingSessionRecord>;
  }>;
  recoverAdopted(input: AdoptedSessionRecoveryRequest): Readonly<{
    record: Readonly<StreamingSessionRecord>;
  }>;
  completeAdoptedCleanup(input: CompleteAdoptedCleanupRequest): Readonly<{
    record: Readonly<StreamingSessionRecord>;
  }>;
}

export function createSessionAuthority(options: SessionAuthorityOptions): SessionAuthority {
  const writer = getStreamingSessionStoreWriter(options.sessions);
  const kernelWriter = getStreamingSessionKernelWriter(options.sessions);
  const clock = options.clock ?? (() => new Date());
  const retainedClaims = new Map<string, ConsumedExecutionGrantClaims>();
  const authorizations = new WeakMap<object, AuthorizationRecord>();
  const launchAuthorizationUsed = new Set<string>();
  const grantIdsByCall = new Map<string, string>();
  const stagedLaunches = new WeakMap<object, StagedLaunchRecord>();
  let reservations = KERNEL_STAGE_RESERVATIONS.get(options.sessions);
  if (!reservations) { reservations = { sessionIds: new Set<string>(), launchIds: new Set<string>() }; KERNEL_STAGE_RESERVATIONS.set(options.sessions, reservations); }
  const reservedSessionIds = reservations.sessionIds;
  const reservedLaunchIds = reservations.launchIds;
  const consumeLaunchGrant = (grant: OpaqueExecutionGrant, binding: ExecutionGrantBinding): ConsumedExecutionGrantClaims => {
    const callKey = executionGrantCallKey(binding);
    if (grantIdsByCall.has(callKey)) throw new SessionAuthorityError("second_grant_for_call", "A ToolBroker call cannot mint, stage, or reuse a second session grant.");
    const claims = options.grants.consume(grant, binding);
    grantIdsByCall.set(callKey, claims.grantId);
    return claims;
  };
  const stageLaunchInternal = (input: StageLaunchRequest, repeatedCallCode: "launch_call_consumed" | "second_grant_for_call" = "launch_call_consumed"): StagedLaunchAuthorization => {
    const sessionId = requiredText(input.sessionId, "sessionId");
    const launchId = requiredText(input.launchId, "launchId");
    if (options.sessions.store.readBySession(sessionId) || reservedSessionIds.has(sessionId)) throw new SessionAuthorityError("session_collision", "Streaming session id is already reserved.");
    if (reservedLaunchIds.has(launchId) || options.sessions.store.readHostLaunch(launchId)) throw new SessionAuthorityError("session_collision", "Streaming launch id is already reserved.");
    const callKey = executionGrantCallKey(input.binding);
    let claims: ConsumedExecutionGrantClaims;
    try { claims = consumeLaunchGrant(input.grant, input.binding); }
    catch (error) {
      if (error instanceof SessionAuthorityError && error.code === "second_grant_for_call") throw new SessionAuthorityError(repeatedCallCode, "The launching ToolBroker call is already staged.");
      throw error;
    }
    assertCurrentConsumedExecutionGrantClaims(claims);
    const authorization = Object.freeze({ [RUNNER_STAGED_LAUNCH_AUTHORIZATION]: true }) as StagedLaunchAuthorization;
    stagedLaunches.set(authorization as object, { sessionId, launchId, callKey, claims, used: false });
    reservedSessionIds.add(sessionId);
    reservedLaunchIds.add(launchId);
    return authorization;
  };
  return Object.freeze({
    stageLaunch(input: StageLaunchRequest): StagedLaunchAuthorization {
      return stageLaunchInternal(input);
    },
    validateStagedLaunch(stagedAuthorization: StagedLaunchAuthorization, expected: Readonly<{ sessionId: string; launchId: string }>) {
      const staged = stagedLaunches.get(stagedAuthorization as object);
      if (!staged || staged.used) throw new SessionAuthorityError("launch_call_consumed", "Staged launch authorization is unavailable or consumed.");
      if (staged.sessionId !== expected.sessionId || staged.launchId !== expected.launchId) throw new SessionAuthorityError("binding_mismatch", "Staged launch identity does not match.");
      return assertCurrentConsumedExecutionGrantClaims(staged.claims);
    },
    finalizeLaunch(input: FinalizeLaunchRequest) {
      const staged = stagedLaunches.get(input.staged as object);
      if (!staged || staged.used) throw new SessionAuthorityError("launch_call_consumed", "Staged launch authorization is unavailable or consumed.");
      const sessionId = requiredText(input.sessionId, "sessionId");
      const launchId = requiredText(input.launchId, "launchId");
      if (staged.sessionId !== sessionId || staged.launchId !== launchId) throw new SessionAuthorityError("binding_mismatch", "Staged launch identity does not match finalization.");
      assertCurrentConsumedExecutionGrantClaims(staged.claims);
      assertSessionEnvelopeSubset(input.envelope, staged.claims);
      assertLeaseAccessSubset(input.lease, staged.claims);
      assertEnvelopeWithinLease(input.envelope, input.lease);
      if (!/^[a-f0-9]{64}$/i.test(input.handshakeDigest)) throw new SessionAuthorityError("binding_mismatch", "Handshake attestation digest is invalid.");
      const host = options.sessions.store.readHostLaunch(launchId);
      if (!host || host.sessionId !== sessionId || host.runId !== staged.claims.runId || host.agentSessionId !== staged.claims.sessionId || host.callId !== staged.claims.callId || host.toolName !== staged.claims.toolName || canonicalJson(host.actor) !== canonicalJson(staged.claims.actor) || canonicalJson(host.leaseBinding) !== canonicalJson(input.lease) || canonicalJson(host.backendBinding) !== canonicalJson(input.backendBinding) || host.handshakeDigest !== input.handshakeDigest.toLowerCase()) {
        throw new SessionAuthorityError("binding_mismatch", "Final launch bindings do not match the staged host record.");
      }
      const at = clock().toISOString();
      const ownerId = `session-authority:${staged.claims.runId}:${staged.claims.grantId}`;
      const record = {
        recordKind: "runner.streaming-session",
        schemaVersion: STREAMING_SESSION_RECORD_VERSION,
        revision: 1,
        sessionId,
        ownerId,
        fencingToken: 1,
        leaseExpiresAt: new Date(clock().getTime() + 60_000).toISOString(),
        runId: staged.claims.runId,
        agentSessionId: staged.claims.sessionId,
        actor: { role: staged.claims.actor.role, id: staged.claims.actor.id },
        toolName: staged.claims.toolName,
        callId: staged.claims.callId,
        envelope: structuredClone(input.envelope),
        lease: structuredClone(input.lease),
        backendBinding: structuredClone(input.backendBinding),
        cleanupCreationAuthority: null,
        cleanupOwner: "session_authority",
        state: "active",
        history: [{ state: "pending_transfer", at }, { state: "active", at }],
        effects: [{ effectId: `transfer:${staged.claims.grantId}`, kind: "transfer", status: "acknowledged", owner: "tool_broker", fencingToken: 1, createdAt: at, acknowledgedAt: at }],
      };
      const adopted = kernelWriter.commitAdoption({ launchId, ownerId: input.ownerId, fencingToken: input.fencingToken, expectedRevision: input.expectedRevision, at, sessionRecord: record });
      staged.used = true;
      retainedClaims.set(sessionId, staged.claims);
      return Object.freeze({ record: adopted.session });
    },
    beginTransfer(input: SessionAuthorityTransferRequest) {
      const sessionId = requiredText(input.sessionId, "sessionId");
      const existing = options.sessions.store.readBySession(sessionId);
      if (existing) {
        if (!sameSessionTransferIdentity(existing, input)) {
          throw new SessionAuthorityError(
            "session_collision",
            "Streaming session id belongs to a different immutable authority.",
          );
        }
        return Object.freeze({ record: existing });
      }
      const compatibilityLaunchId = `compat:${sessionId}:${input.binding.callId}`;
      const stagedAuthorization = stageLaunchInternal({ sessionId, launchId: compatibilityLaunchId, grant: input.grant, binding: input.binding }, "second_grant_for_call");
      const staged = stagedLaunches.get(stagedAuthorization as object)!;
      const claims = assertCurrentConsumedExecutionGrantClaims(staged.claims);
      assertSessionEnvelopeSubset(input.envelope, claims);
      assertLeaseAccessSubset(input.lease, claims);
      assertEnvelopeWithinLease(input.envelope, input.lease);
      const at = clock().toISOString();
      const record = {
        recordKind: "runner.streaming-session",
        schemaVersion: STREAMING_SESSION_RECORD_VERSION,
        revision: 0,
        sessionId,
        ownerId: `session-authority:${claims.runId}:${claims.grantId}`,
        fencingToken: 1,
        leaseExpiresAt: new Date(clock().getTime() + 60_000).toISOString(),
        runId: claims.runId,
        agentSessionId: claims.sessionId,
        actor: { role: claims.actor.role, id: claims.actor.id },
        toolName: claims.toolName,
        callId: claims.callId,
        envelope: structuredClone(input.envelope),
        lease: structuredClone(input.lease),
        backendBinding: structuredClone(input.backendBinding),
        cleanupCreationAuthority: null,
        cleanupOwner: "tool_broker",
        state: "pending_transfer",
        history: [{ state: "pending_transfer", at }],
        effects: [{
          effectId: `transfer:${claims.grantId}`,
          kind: "transfer",
          status: "pending",
          owner: "tool_broker",
          fencingToken: 1,
          createdAt: at,
        }],
      };
      const claimed = writer.claim(record);
      staged.used = true;
      if (claimed.won) {
        retainedClaims.set(record.sessionId, claims);
      }
      return Object.freeze({ record: claimed.record });
    },
    acknowledgeTransfer(input: SessionAuthorityTransferAcknowledgement) {
      const record = writer.apply({
        type: "acknowledge_transfer",
        sessionId: input.sessionId,
        ownerId: input.ownerId,
        fencingToken: input.fencingToken,
        expectedRevision: input.expectedRevision,
        effectId: input.effectId,
        at: clock().toISOString(),
      });
      return Object.freeze({ record });
    },
    takeover(input: SessionAuthorityTakeoverRequest) {
      const record = writer.apply({
        type: "takeover",
        sessionId: input.sessionId,
        ownerId: input.ownerId,
        fencingToken: input.fencingToken,
        expectedRevision: input.expectedRevision,
        newOwnerId: input.newOwnerId,
        newFencingToken: input.newFencingToken,
        leaseExpiresAt: input.leaseExpiresAt,
        at: clock().toISOString(),
      });
      return Object.freeze({ record });
    },
    recordDisposition(input: SessionDispositionRequest) {
      const record = writer.apply({
        type: "mark_disposition",
        sessionId: input.sessionId,
        ownerId: input.ownerId,
        fencingToken: input.fencingToken,
        expectedRevision: input.expectedRevision,
        disposition: input.disposition,
        at: clock().toISOString(),
      });
      return Object.freeze({ record });
    },
    authorizeLaunchOperation(input: LaunchOperationAuthorizationRequest): SessionOperationAuthorization {
      const record = options.sessions.store.readBySession(input.sessionId);
      if (!record || record.state !== "active") {
        throw new SessionAuthorityError("session_unavailable", "Streaming session is not active.");
      }
      assertCurrentSessionLease(record, clock);
      const claims = retainedClaims.get(input.sessionId);
      if (!claims) {
        throw new SessionAuthorityError("session_unavailable", "Launching call claims are unavailable.");
      }
      assertCurrentClaims(claims);
      assertOperationAccessWithinEnvelope(input, record.envelope);
      if (launchAuthorizationUsed.has(input.sessionId)) {
        throw new SessionAuthorityError(
          "launch_call_consumed",
          "The launching ToolBroker call cannot authorize a second session operation.",
        );
      }
      assertOperationAccessWithinClaims(input, claims);
      const authorization = issueAuthorization(authorizations, record, input, claims);
      launchAuthorizationUsed.add(input.sessionId);
      return authorization;
    },
    authorizeOperation(input: SessionOperationRequest): SessionOperationAuthorization {
      const record = options.sessions.store.readBySession(input.sessionId);
      if (!record || record.state !== "active") {
        throw new SessionAuthorityError("session_unavailable", "Streaming session is not active.");
      }
      assertCurrentSessionLease(record, clock);
      const callKey = executionGrantCallKey(input.binding);
      if (grantIdsByCall.has(callKey)) {
        throw new SessionAuthorityError(
          "second_grant_for_call",
          "A ToolBroker call cannot mint or reuse a second session grant.",
        );
      }
      const claims = options.grants.consume(input.grant, input.binding);
      grantIdsByCall.set(callKey, claims.grantId);
      if (claims.runId !== record.runId ||
          claims.sessionId !== record.agentSessionId ||
          claims.actor.role !== (record.actor as { role: string }).role ||
          claims.actor.id !== (record.actor as { id: string }).id) {
        throw new SessionAuthorityError("binding_mismatch", "Current grant does not match the streaming session owner.");
      }
      assertCurrentClaims(claims);
      assertOperationAccessWithinEnvelope(input, record.envelope);
      assertOperationAccessWithinClaims(input, claims);
      const authorization = issueAuthorization(authorizations, record, input, claims);
      return authorization;
    },
    assertOperationAuthorization(
      authorization: SessionOperationAuthorization,
      expected: OperationAuthorizationAssertion,
    ): void {
      const details = authorizations.get(authorization as object);
      if (!details) {
        throw new SessionAuthorityError("authorization_forged", "Session operation authorization is not Runner-issued.");
      }
      if (details.sessionId !== expected.sessionId || details.operation !== expected.operation) {
        throw new SessionAuthorityError("operation_mismatch", "Session operation authorization does not match this operation.");
      }
      if (!sameExecutionGrantBinding(details.binding, expected.binding)) {
        throw new SessionAuthorityError("binding_mismatch", "Session operation authorization has a different call binding.");
      }
      if (!sameAccess(details.requestAccess, expected.requestAccess) ||
          !sameTextSet(details.credentialNames, expected.credentialNames) ||
          details.networkApproved !== expected.networkApproved ||
          details.externalApproved !== expected.externalApproved ||
          details.destructiveApproved !== expected.destructiveApproved) {
        throw new SessionAuthorityError("operation_mismatch", "Session operation authorization has a different access check.");
      }
      const record = options.sessions.store.readBySession(details.sessionId);
      if (!record || record.state !== "active") {
        throw new SessionAuthorityError("session_unavailable", "Streaming session is no longer active.");
      }
      assertCurrentSessionLease(record, clock);
      if (record.ownerId !== details.ownerId || record.fencingToken !== details.fencingToken) {
        throw new SessionAuthorityError("authorization_stale", "Session operation authorization has a stale owner fence.");
      }
      if (record.runId !== details.binding.runId ||
          record.agentSessionId !== details.binding.sessionId ||
          record.actor.role !== details.binding.actor.role ||
          record.actor.id !== details.binding.actor.id) {
        throw new SessionAuthorityError("authorization_stale", "Session operation authorization no longer matches this session identity.");
      }
      assertCurrentClaims(details.claims);
    },
    recoverUnadopted(input: UnadoptedSessionRecoveryRequest) {
      let record = options.sessions.store.readBySession(input.sessionId);
      if (!record || !["pending_transfer", "transfer_ambiguous"].includes(record.state as string)) {
        throw new SessionAuthorityError(
          "recovery_refused",
          "Only an unadopted streaming session can use provider-lease recovery.",
        );
      }
      const transfer = pendingEffect(record, "transfer");
      if (record.state === "pending_transfer") {
        if (!transfer) throw new SessionAuthorityError("recovery_refused", "Unadopted transfer effect is missing.");
        record = writer.apply({
          type: "mark_transfer_ambiguous",
          sessionId: input.sessionId,
          ownerId: input.ownerId,
          fencingToken: input.fencingToken,
          expectedRevision: record.revision,
          effectId: transfer.effectId,
          at: clock().toISOString(),
        });
      }
      const pendingTransfer = pendingEffect(record, "transfer");
      if (pendingTransfer) {
        if (input.replay(effectFor(pendingTransfer)) !== "ambiguous") {
          throw new SessionAuthorityError("recovery_refused", "Ambiguous transfer recovery cannot adopt a session.");
        }
        record = writer.apply({
          type: "acknowledge_ambiguous_transfer",
          sessionId: input.sessionId,
          ownerId: input.ownerId,
          fencingToken: input.fencingToken,
          expectedRevision: record.revision,
          effectId: pendingTransfer.effectId,
          at: clock().toISOString(),
        });
      }
      const cleanupId = "cleanup:" + input.sessionId + ":" + input.fencingToken;
      let cleanup = pendingEffect(record, "cleanup");
      if (!cleanup) {
        record = writer.apply({
          type: "begin_cleanup",
          sessionId: input.sessionId,
          ownerId: input.ownerId,
          fencingToken: input.fencingToken,
          expectedRevision: record.revision,
          effectId: cleanupId,
          at: clock().toISOString(),
        });
        cleanup = pendingEffect(record, "cleanup");
      }
      if (!cleanup) {
        throw new SessionAuthorityError("recovery_refused", "Provider cleanup was not proven.");
      }
      const cleanupOutcome = input.replay(effectFor(cleanup));
      if (cleanupOutcome === "blocked") {
        const blocked = writer.apply({
          type: "mark_cleanup_blocked",
          sessionId: input.sessionId,
          ownerId: input.ownerId,
          fencingToken: input.fencingToken,
          expectedRevision: record.revision,
          effectId: cleanup.effectId,
          at: clock().toISOString(),
        });
        return Object.freeze({ record: blocked });
      }
      if (cleanupOutcome !== "cleaned") {
        throw new SessionAuthorityError("recovery_refused", "Provider cleanup was not proven.");
      }
      const released = writer.apply({
        type: "acknowledge_cleanup",
        sessionId: input.sessionId,
        ownerId: input.ownerId,
        fencingToken: input.fencingToken,
        expectedRevision: record.revision,
        effectId: cleanup.effectId,
        at: clock().toISOString(),
      });
      return Object.freeze({ record: released });
    },
    recoverAdopted(input: AdoptedSessionRecoveryRequest) {
      let record = options.sessions.store.readBySession(input.sessionId);
      if (!record || ![
        "active",
        "stopping",
        "input_unavailable",
        "backend_unavailable",
        "outcome_unknown",
        "cleanup_pending",
        "cleanup_blocked",
      ].includes(record.state)) {
        throw new SessionAuthorityError("recovery_refused", "Only an adopted streaming session can use SessionAuthority recovery.");
      }
      if (record.cleanupOwner !== "session_authority") {
        throw new SessionAuthorityError("recovery_refused", "Adopted recovery requires SessionAuthority cleanup ownership.");
      }
      if (record.ownerId !== input.ownerId || record.fencingToken !== input.fencingToken) {
        throw new SessionAuthorityError("authorization_stale", "Adopted recovery has a stale owner fence.");
      }
      assertCurrentSessionLease(record, clock);
      const retainedCleanup = record.effects.find((effect) => effect.kind === "cleanup");
      if (retainedCleanup?.progress) {
        throw new SessionAuthorityError(
          "recovery_refused",
          "Compatibility recovery cannot replace categorical adopted cleanup resource proofs.",
        );
      }
      if (record.state === "cleanup_blocked") return Object.freeze({ record });
      let cleanup = pendingEffect(record, "cleanup");
      if (!cleanup) {
        record = writer.apply({
          type: "begin_cleanup",
          sessionId: input.sessionId,
          ownerId: input.ownerId,
          fencingToken: input.fencingToken,
          expectedRevision: record.revision,
          effectId: "cleanup:" + input.sessionId + ":" + input.fencingToken,
          at: clock().toISOString(),
        });
        cleanup = pendingEffect(record, "cleanup");
      }
      if (!cleanup) {
        throw new SessionAuthorityError("recovery_refused", "Adopted cleanup effect is missing.");
      }
      if (cleanup.progress) {
        throw new SessionAuthorityError(
          "recovery_refused",
          "Compatibility recovery cannot replace categorical adopted cleanup resource proofs.",
        );
      }
      const cleanupOutcome = input.replay(effectFor(cleanup));
      if (cleanupOutcome === "blocked") {
        const blocked = writer.apply({
          type: "mark_cleanup_blocked",
          sessionId: input.sessionId,
          ownerId: input.ownerId,
          fencingToken: input.fencingToken,
          expectedRevision: record.revision,
          effectId: cleanup.effectId,
          at: clock().toISOString(),
        });
        return Object.freeze({ record: blocked });
      }
      const released = writer.apply({
        type: "acknowledge_cleanup",
        sessionId: input.sessionId,
        ownerId: input.ownerId,
        fencingToken: input.fencingToken,
        expectedRevision: record.revision,
        effectId: cleanup.effectId,
        at: clock().toISOString(),
      });
      return Object.freeze({ record: released });
    },
    completeAdoptedCleanup(input: CompleteAdoptedCleanupRequest) {
      const record = options.sessions.store.readBySession(input.sessionId);
      if (!record || record.cleanupOwner !== "session_authority" || record.state !== "cleanup_pending" ||
          record.ownerId !== input.ownerId || record.fencingToken !== input.fencingToken) {
        throw new SessionAuthorityError("recovery_refused", "Adopted cleanup completion authority is unavailable.");
      }
      const cleanup = record.effects.find((effect) => effect.kind === "cleanup" && effect.effectId === input.effectId);
      if (!cleanup?.progress || cleanup.progress.resources.some((resource) =>
        resource.status !== "verified" || resource.attempt !== undefined)) {
        throw new SessionAuthorityError("recovery_refused", "Adopted cleanup resource proof conjunction is incomplete.");
      }
      const released = writer.apply({
        type: "acknowledge_cleanup",
        sessionId: input.sessionId,
        ownerId: input.ownerId,
        fencingToken: input.fencingToken,
        expectedRevision: input.expectedRevision,
        effectId: input.effectId,
        at: clock().toISOString(),
      });
      return Object.freeze({ record: released });
    },
  });
}

export function assertSessionEnvelopeSubset(
  envelope: StreamingSessionEnvelope,
  launchClaims: Pick<
    ConsumedExecutionGrantClaims,
    "access" | "credentialNames" | "networkApproved" | "externalApproved" | "destructiveApproved"
  >,
): void {
  const access = envelope.access;
  if (!Array.isArray(access) ||
      !access.every((entry) => isExactAccess(entry)) ||
      !access.every((entry) => launchClaims.access.some((granted) =>
        granted.canonicalPath === entry.canonicalPath && granted.mode === entry.mode))) {
    throw new SessionAuthorityError(
      "envelope_escalation",
      "Session access envelope is not a subset of the launch grant.",
    );
  }
  for (const [field, granted] of [
    ["networkApproved", launchClaims.networkApproved],
    ["externalApproved", launchClaims.externalApproved],
    ["destructiveApproved", launchClaims.destructiveApproved],
  ] as const) {
    if (envelope[field] !== false && envelope[field] !== true) {
      throw new SessionAuthorityError("envelope_escalation", `Session envelope ${field} is invalid.`);
    }
    if (envelope[field] === true && granted !== true) {
      throw new SessionAuthorityError(
        "envelope_escalation",
        `Session envelope cannot broaden ${field}.`,
      );
    }
  }
  const credentialNames = envelope.credentialNames;
  const launchCredentialNames = (launchClaims as { credentialNames?: unknown }).credentialNames;
  if (!Array.isArray(credentialNames) || !credentialNames.every((name) =>
    typeof name === "string" && Array.isArray(launchCredentialNames) && launchCredentialNames.includes(name))) {
    throw new SessionAuthorityError(
      "envelope_escalation",
      "Session envelope credential names are not a subset of the launch grant.",
    );
  }
}

function assertLeaseAccessSubset(
  lease: StreamingSessionLease,
  launchClaims: Pick<ConsumedExecutionGrantClaims, "access">,
): void {
  if (!Array.isArray(lease.access) || !lease.access.every(isExactAccess) ||
      !lease.access.every((entry) => launchClaims.access.some((granted) =>
        granted.canonicalPath === entry.canonicalPath && granted.mode === entry.mode))) {
    throw new SessionAuthorityError(
      "envelope_escalation",
      "Isolation lease access is not a subset of the launch grant.",
    );
  }
}

function assertEnvelopeWithinLease(
  envelope: StreamingSessionEnvelope,
  lease: StreamingSessionLease,
): void {
  if (!Array.isArray(envelope.access) || !Array.isArray(lease.access) ||
      !envelope.access.every((entry) => isExactAccess(entry) && lease.access.some((allowed) =>
        allowed.canonicalPath === entry.canonicalPath && allowed.mode === entry.mode))) {
    throw new SessionAuthorityError(
      "envelope_escalation",
      "Session access envelope is not covered by the immutable isolation lease.",
    );
  }
}

function isExactAccess(value: unknown): value is { canonicalPath: string; mode: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const access = value as Record<string, unknown>;
  return typeof access.canonicalPath === "string" &&
    (access.mode === "read" || access.mode === "write" || access.mode === "create");
}

function assertOperationAccessWithinEnvelope(
  request: LaunchOperationAuthorizationRequest,
  envelope: StreamingSessionEnvelope,
): void {
  assertOperationRequestShape(request);
  const envelopeAccess = envelope.access;
  if (!Array.isArray(envelopeAccess) ||
      !request.requestAccess.every((entry) => envelopeAccess.some((allowed) =>
        isExactAccess(allowed) &&
        allowed.canonicalPath === entry.canonicalPath &&
        allowed.mode === entry.mode))) {
    throw new SessionAuthorityError("envelope_escalation", "Operation access is outside the adopted session envelope.");
  }
  const allowedCredentialNames = envelope.credentialNames;
  if (!Array.isArray(allowedCredentialNames) ||
      !request.credentialNames.every((name) => allowedCredentialNames.includes(name))) {
    throw new SessionAuthorityError("envelope_escalation", "Operation credentials are outside the adopted session envelope.");
  }
  for (const field of ["networkApproved", "externalApproved", "destructiveApproved"] as const) {
    if (request[field] === true && envelope[field] !== true) {
      throw new SessionAuthorityError("envelope_escalation", "Operation cannot broaden " + field + ".");
    }
  }
}

function assertOperationAccessWithinClaims(
  request: LaunchOperationAuthorizationRequest,
  claims: ConsumedExecutionGrantClaims,
): void {
  assertOperationRequestShape(request);
  if (!request.requestAccess.every((entry) => claims.access.some((allowed) =>
    allowed.canonicalPath === entry.canonicalPath && allowed.mode === entry.mode))) {
    throw new SessionAuthorityError("envelope_escalation", "Operation access is outside the current grant.");
  }
  if (!request.credentialNames.every((name) => claims.credentialNames.includes(name))) {
    throw new SessionAuthorityError("envelope_escalation", "Operation credentials are outside the current grant.");
  }
  if ((request.networkApproved && !claims.networkApproved) ||
      (request.externalApproved && !claims.externalApproved) ||
      (request.destructiveApproved && !claims.destructiveApproved)) {
    throw new SessionAuthorityError("envelope_escalation", "Operation authority is outside the current grant.");
  }
}

function issueAuthorization(
  authorizations: WeakMap<object, AuthorizationRecord>,
  record: Readonly<StreamingSessionRecord>,
  request: LaunchOperationAuthorizationRequest,
  claims: ConsumedExecutionGrantClaims,
): SessionOperationAuthorization {
  if (!isSessionOperation(request.operation)) {
    throw new SessionAuthorityError("operation_mismatch", "Session operation is invalid.");
  }
  const authorization = {} as SessionOperationAuthorization;
  Object.defineProperty(authorization, RUNNER_SESSION_OPERATION_AUTHORIZATION, { value: true });
  Object.freeze(authorization);
  authorizations.set(authorization as object, {
    sessionId: record.sessionId as string,
    ownerId: record.ownerId as string,
    fencingToken: record.fencingToken as number,
    operation: request.operation,
    binding: cloneExecutionGrantBinding(claims),
    requestAccess: Object.freeze(request.requestAccess.map((entry) => Object.freeze({ ...entry }))),
    credentialNames: Object.freeze([...request.credentialNames]),
    networkApproved: request.networkApproved === true,
    externalApproved: request.externalApproved === true,
    destructiveApproved: request.destructiveApproved === true,
    claims,
  });
  return authorization;
}

function assertCurrentClaims(claims: ConsumedExecutionGrantClaims): void {
  try {
    assertCurrentConsumedExecutionGrantClaims(claims);
  } catch {
    throw new SessionAuthorityError("authorization_revoked", "Session operation authorization is no longer current.");
  }
}

function assertCurrentSessionLease(
  record: Readonly<StreamingSessionRecord>,
  clock: () => Date,
): void {
  if (Date.parse(record.leaseExpiresAt) <= clock().getTime()) {
    throw new SessionAuthorityError("authorization_stale", "Streaming session ownership lease has expired.");
  }
}

function pendingEffect(
  record: Readonly<StreamingSessionRecord>,
  kind: "transfer" | "cleanup",
): Readonly<StreamingSessionRecord["effects"][number]> | undefined {
  return record.effects.find((effect) => effect.kind === kind && effect.status === "pending");
}

function effectFor(effect: Readonly<StreamingSessionRecord["effects"][number]>): SessionRecoveryEffect {
  return Object.freeze({
    effectId: effect.effectId,
    kind: effect.kind,
    fencingToken: effect.fencingToken,
  });
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > 512) {
    throw new Error(`Session authority ${name} is invalid.`);
  }
  return value;
}

function assertOperationRequestShape(request: LaunchOperationAuthorizationRequest): void {
  if (!isSessionOperation(request.operation) || !Array.isArray(request.requestAccess) ||
      !Array.isArray(request.credentialNames) ||
      typeof request.networkApproved !== "boolean" || typeof request.externalApproved !== "boolean" ||
      typeof request.destructiveApproved !== "boolean") {
    throw new SessionAuthorityError("operation_mismatch", "Session operation request is invalid.");
  }
  const access = new Set<string>();
  for (const entry of request.requestAccess) {
    if (!isExactAccess(entry)) {
      throw new SessionAuthorityError("operation_mismatch", "Session operation access is invalid.");
    }
    const key = entry.canonicalPath + "\0" + entry.mode;
    if (access.has(key)) throw new SessionAuthorityError("operation_mismatch", "Session operation access is duplicated.");
    access.add(key);
  }
  const credentials = new Set<string>();
  for (const name of request.credentialNames) {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || credentials.has(name)) {
      throw new SessionAuthorityError("operation_mismatch", "Session operation credentials are invalid.");
    }
    credentials.add(name);
  }
}

function isSessionOperation(value: unknown): value is SessionOperation {
  return value === "write" || value === "close_input" || value === "request" || value === "stop" ||
    value === "graceful_shutdown" || value === "subscribe" || value === "parse_delivery" ||
    value === "input_control" || value === "protocol_response" || value === "family_delivery";
}

function cloneExecutionGrantBinding(value: ExecutionGrantBinding): ExecutionGrantBinding {
  return Object.freeze({
    runId: value.runId,
    sessionId: value.sessionId,
    actor: Object.freeze({ role: value.actor.role, id: value.actor.id }),
    toolName: value.toolName,
    callId: value.callId,
    permissionProfile: value.permissionProfile,
  });
}

function sameExecutionGrantBinding(left: ExecutionGrantBinding, right: ExecutionGrantBinding): boolean {
  return left.runId === right.runId && left.sessionId === right.sessionId &&
    left.actor.role === right.actor.role && left.actor.id === right.actor.id &&
    left.toolName === right.toolName && left.callId === right.callId &&
    left.permissionProfile === right.permissionProfile;
}

function sameAccess(left: readonly StreamingSessionAccess[], right: readonly StreamingSessionAccess[]): boolean {
  if (!Array.isArray(right) || left.length !== right.length) return false;
  const keys = new Set(left.map((entry) => entry.canonicalPath + "\0" + entry.mode));
  return keys.size === left.length && right.every((entry) =>
    isExactAccess(entry) && keys.has(entry.canonicalPath + "\0" + entry.mode));
}

function sameTextSet(left: readonly string[], right: readonly string[]): boolean {
  if (!Array.isArray(right) || left.length !== right.length) return false;
  const names = new Set(left);
  return names.size === left.length && right.every((name) => typeof name === "string" && names.has(name));
}

function executionGrantCallKey(binding: ExecutionGrantBinding): string {
  return [
    binding.runId,
    binding.sessionId,
    binding.actor.role,
    binding.actor.id,
    binding.toolName,
    binding.callId,
    binding.permissionProfile,
  ].join("\0");
}

function sameSessionTransferIdentity(
  record: Readonly<StreamingSessionRecord>,
  input: SessionAuthorityTransferRequest,
): boolean {
  return record.sessionId === input.sessionId &&
    record.runId === input.binding.runId &&
    record.agentSessionId === input.binding.sessionId &&
    record.actor.role === input.binding.actor.role &&
    record.actor.id === input.binding.actor.id &&
    record.toolName === input.binding.toolName &&
    record.callId === input.binding.callId &&
    canonicalJson(record.envelope) === canonicalJson(input.envelope) &&
    canonicalJson(record.lease) === canonicalJson(input.lease) &&
    canonicalJson(record.backendBinding) === canonicalJson(input.backendBinding);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => JSON.stringify(key) + ":" + canonicalJson(nested));
  return "{" + entries.join(",") + "}";
}
