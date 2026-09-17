/** On-demand proposal controller. Ordinary process lifecycle never imports this module. */
import { randomUUID } from "node:crypto";
import { AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS } from "./cleanup-timeouts.js";
import type { AgentModel } from "./agent-contracts.js";
import {
  reserveExecutionGrantForProcessRecovery,
  type ExecutionGrantAuthority,
} from "./execution-grants.js";
import type { PermissionProfile } from "./contracts.js";
import { rebuildSchedulerProjection, type SchedulerStore } from "./scheduler-store.js";
import { durableRecoveryIdentity, type DurableProcessStore, type DurableSubprocessRecord } from "./durable-process-store.js";
import {
  durableBackendIdentityFingerprint,
  durableBirthFingerprint,
  exceptionalRecoveryCallId,
  type SubprocessRuntime,
} from "./subprocess-runtime.js";
import type { ExecutionSafetyCapabilities, ProcessCleanupStatus } from "./execution-safety-contracts.js";
import type { StreamingSessionRecord, StreamingSessionStore } from "./streaming-session-store.js";
import { isExceptionalProcessState, makeRecoveryAudit, parseRecoveryProposal, ProcessRecoveryError,
  recoveryScope, sameRecoveryIdentity, sameRecoveryScope, type RecoveryAuditRecord, type RecoveryProposal,
  type RecoveryReason, type RecoveryScope, type RecoveryState, type RecoveryTarget } from "./process-recovery-contracts.js";
export * from "./process-recovery-contracts.js";

export interface RecoveryExecutionAuthority {
  readonly userApproved: boolean;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
export interface RecoveryExecutionResult {
  observation: "running" | "exited" | "identity_mismatch" | "outcome_unknown";
  cleanup: ProcessCleanupStatus;
}
class RecoveryEffectNotDispatchedError extends Error {
  constructor(cause: unknown) { super("Recovery effect was not dispatched.", { cause }); this.name = "RecoveryEffectNotDispatchedError"; }
}
export interface ProcessRecoveryRuntime {
  inspect(invocationId: string): RecoveryTarget | undefined;
  list?(): readonly RecoveryTarget[];
  execute(request: RecoveryAuditRecord, authority: RecoveryExecutionAuthority): Promise<RecoveryExecutionResult>;
}
/**
 * Production recovery runtime. It is backed by the shared SubprocessRuntime and
 * its read-only durable store; there is no raw kill, shell string or ambient
 * spawn anywhere on this path, and no new unconfined subprocess is created.
 */
export function createSubprocessProcessRecoveryRuntime(options: {
  readonly runtime: Pick<SubprocessRuntime, "recoverExceptional">;
  /** Shared kernel authority for current-owner or safely reclaimable exceptional records. */
  readonly canRecoverExceptional: (invocationId: string) => boolean;
  readonly store: Pick<DurableProcessStore, "readByInvocation"> & Partial<Pick<DurableProcessStore, "listRowIds">>;
  readonly kind?: "subprocess" | "streaming";
  readonly capabilities?: (record: DurableSubprocessRecord) => ExecutionSafetyCapabilities;
  readonly executionGrants: ExecutionGrantAuthority;
  readonly permissionProfile: PermissionProfile;
  readonly workspacePath: string;
  /** Last-mile native grant expiry/revocation check, evaluated at the effect boundary. */
  readonly assertGrant?: (record: DurableSubprocessRecord) => void;
}): ProcessRecoveryRuntime {
  const kind = options.kind ?? "subprocess";
  const inspect = (invocationId: string): RecoveryTarget | undefined => {
    const record = options.store.readByInvocation(invocationId);
    if (!record) return undefined;
    const binding = record.backendBinding;
    return Object.freeze({
      scope: Object.freeze({
        kind,
        runId: record.runId,
        invocationId: record.invocationId,
        logicalProcessId: record.logicalProcessId,
        ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
        ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
        revision: record.revision,
        ownerId: record.ownerId,
        fencingToken: record.fencingToken,
        ...(binding?.rootPid === undefined ? {} : { rootPid: binding.rootPid }),
        state: record.state,
        // A process with no durable backend binding has no provable identity;
        // the empty fingerprints make the controller refuse rather than guess.
        backendIdentity: binding ? durableBackendIdentityFingerprint(binding) : "",
        birthFingerprint: binding ? durableBirthFingerprint(binding) : "",
      }),
      owned: options.canRecoverExceptional(record.invocationId),
      pendingEffects: record.pendingEffects.length > 0,
      capabilities: options.capabilities?.(record) ?? binding?.capabilities ?? {
        tree_termination: "unverified", crash_cleanup: "unverified",
        verified_emptiness: "unverified", write_confinement: "unverified",
      },
      cleanup: structuredClone(record.cleanup),
      ...(binding ? { backend: Object.freeze({ backendId: binding.backendId, implementationDigest: binding.implementationDigest }) } : {}),
      leaseExpiresAt: record.leaseExpiresAt,
      requiredCapabilities: Object.freeze([...record.requiredCapabilities]),
      ...(record.output ? { output: Object.freeze({
        totalBytes: record.output.reduce((sum, stream) => sum + stream.totalBytes, 0),
        truncated: record.output.some(stream => stream.truncated),
        lossyBytes: record.output.reduce((sum, stream) => sum + stream.lossyBytes, 0),
      }) } : {}),
    }) as RecoveryTarget;
  };
  return Object.freeze({
    inspect,
    list: () => Object.freeze((options.store.listRowIds?.() ?? []).flatMap(invocationId => {
      const value = inspect(invocationId); return value ? [value] : [];
    })),
    async execute(
      request: RecoveryAuditRecord,
      authority: RecoveryExecutionAuthority,
    ): Promise<RecoveryExecutionResult> {
      authority.assertCurrent();
      if (request.requestedAction === "remove_owned_artifact")
        throw new ProcessRecoveryError("recovery_action_unsupported");
      const record = options.store.readByInvocation(request.scope.invocationId);
      if (!record) throw new ProcessRecoveryError("recovery_identity_unavailable");
      const nativeRequest = Object.freeze({
        invocationId: request.scope.invocationId,
        runId: request.scope.runId,
        logicalProcessId: request.scope.logicalProcessId,
        ...(request.scope.taskId === undefined ? {} : { taskId: request.scope.taskId }),
        ...(request.scope.sessionId === undefined ? {} : { sessionId: request.scope.sessionId }),
        expectedRevision: request.scope.revision,
        ownerId: request.scope.ownerId,
        fencingToken: request.scope.fencingToken,
        backendIdentityFingerprint: request.scope.backendIdentity,
        birthFingerprint: request.scope.birthFingerprint,
        action: request.requestedAction,
        expiresAt: request.expiresAt,
      });
      const binding = Object.freeze({ runId: request.scope.runId, sessionId: request.scope.sessionId ?? "process-recovery",
        actor: Object.freeze({ role: "runner_internal" as const, id: "process-recovery" }), toolName: "process.recovery",
        callId: exceptionalRecoveryCallId(nativeRequest), permissionProfile: options.permissionProfile });
      let grant: Awaited<ReturnType<ExecutionGrantAuthority["issue"]>>;
      try {
        grant = await options.executionGrants.issue({ ...binding, workspacePath: options.workspacePath, access: [],
          externalApproved: false, destructiveApproved: request.requestedAction === "terminate" && authority.userApproved,
          networkApproved: false, signal: authority.signal });
      } catch (error) {
        throw new RecoveryEffectNotDispatchedError(error);
      }
      try {
        const observation = await options.runtime.recoverExceptional({ ...nativeRequest, userApproved: authority.userApproved,
          authorization: { authority: options.executionGrants, grant, binding }, assertGrant: () => {
            authority.assertCurrent(); options.assertGrant?.(record);
          } });
        return Object.freeze({ observation: observation.observation, cleanup: observation.cleanup });
      } finally {
        await options.executionGrants.revoke(grant, authority.signal.aborted ? "cancelled" : "completed");
      }
    },
  });
}

export function createStreamingProcessRecoveryRuntime(options: {
  readonly runtime: Readonly<{
    canRecoverExceptional(sessionId: string): boolean;
    cleanupOwnedSession(input: Readonly<{
      sessionId: string; timeoutMs: number; signal?: AbortSignal; assertAuthority?: () => void;
    }>): Promise<Readonly<{ released: true }>>;
  }>;
  readonly store: Pick<StreamingSessionStore, "readBySession" | "listSessionIds">;
  readonly executionGrants: ExecutionGrantAuthority;
  readonly permissionProfile: PermissionProfile;
  readonly workspacePath: string;
  readonly clock?: () => Date;
}): ProcessRecoveryRuntime {
  const clock = options.clock ?? (() => new Date());
  const findRecord = (invocationId: string): Readonly<StreamingSessionRecord> | undefined => {
    const matches = options.store.listSessionIds()
      .map(sessionId => options.store.readBySession(sessionId))
      .filter((record): record is Readonly<StreamingSessionRecord> => record?.lease.invocationId === invocationId);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const inspect = (invocationId: string): RecoveryTarget | undefined => {
    const record = findRecord(invocationId);
    if (!record) return undefined;
    const binding = record.backendBinding;
    const pendingEffects = record.effects.some(effect => effect.status === "pending" ||
      effect.progress?.resources.some(resource => resource.status === "in_flight"));
    const cleanup: ProcessCleanupStatus = record.state === "released"
      ? { state: "verified_empty", verifiedAt: record.history.at(-1)?.at ?? clock().toISOString() }
      : record.state === "cleanup_blocked"
        ? { state: "failed", failedAt: record.history.at(-1)?.at ?? clock().toISOString(),
            code: "streaming_cleanup_blocked", detail: "Streaming cleanup is blocked." }
        : { state: "pending" };
    return Object.freeze({
      scope: Object.freeze({
        kind: "streaming" as const,
        runId: record.runId,
        invocationId: record.lease.invocationId,
        logicalProcessId: record.sessionId,
        sessionId: record.agentSessionId,
        revision: record.revision,
        ownerId: record.ownerId,
        fencingToken: record.fencingToken,
        ...(binding.rootPid === undefined ? {} : { rootPid: binding.rootPid }),
        state: record.state,
        backendIdentity: durableRecoveryIdentity(binding),
        birthFingerprint: durableBirthFingerprint(binding),
      }),
      owned: options.runtime.canRecoverExceptional(record.sessionId),
      pendingEffects,
      capabilities: binding.capabilities ?? ({
        tree_termination: "unverified", crash_cleanup: "unverified",
        verified_emptiness: "unverified", write_confinement: "unverified",
      } satisfies ExecutionSafetyCapabilities),
      cleanup,
      backend: Object.freeze({
        backendId: binding.backendId,
        implementationDigest: binding.implementationDigest,
        providerId: record.lease.providerId,
      }),
      leaseExpiresAt: record.leaseExpiresAt,
      requiredCapabilities: Object.freeze(["tree_termination", "verified_emptiness"] as const),
    });
  };
  return Object.freeze({
    inspect,
    list: () => Object.freeze(options.store.listSessionIds().flatMap(sessionId => {
      const record = options.store.readBySession(sessionId);
      if (!record) return [];
      const target = inspect(record.lease.invocationId);
      return target ? [target] : [];
    })),
    async execute(request: RecoveryAuditRecord, authority: RecoveryExecutionAuthority) {
      authority.assertCurrent();
      const target = inspect(request.scope.invocationId);
      if (!target || !sameRecoveryScope(target.scope, request.scope))
        throw new ProcessRecoveryError("recovery_scope_mismatch");
      if (request.requestedAction === "remove_owned_artifact")
        throw new ProcessRecoveryError("recovery_action_unsupported");
      if (request.requestedAction === "inspect") {
        return Object.freeze({ observation: "outcome_unknown" as const, cleanup: target.cleanup });
      }
      if (!authority.userApproved) throw new ProcessRecoveryError("recovery_approval_required");
      const record = findRecord(request.scope.invocationId)!;
      const nativeRequest = Object.freeze({
        invocationId: request.scope.invocationId, runId: request.scope.runId,
        logicalProcessId: request.scope.logicalProcessId,
        ...(request.scope.taskId === undefined ? {} : { taskId: request.scope.taskId }),
        ...(request.scope.sessionId === undefined ? {} : { sessionId: request.scope.sessionId }),
        expectedRevision: request.scope.revision, ownerId: request.scope.ownerId,
        fencingToken: request.scope.fencingToken, backendIdentityFingerprint: request.scope.backendIdentity,
        birthFingerprint: request.scope.birthFingerprint, action: request.requestedAction,
        expiresAt: request.expiresAt,
      });
      const binding = Object.freeze({
        runId: request.scope.runId, sessionId: request.scope.sessionId ?? "process-recovery",
        actor: Object.freeze({ role: "runner_internal" as const, id: "process-recovery" }),
        toolName: "process.recovery", callId: exceptionalRecoveryCallId(nativeRequest),
        permissionProfile: options.permissionProfile,
      });
      let grant: Awaited<ReturnType<ExecutionGrantAuthority["issue"]>>;
      try {
        grant = await options.executionGrants.issue({
          ...binding, workspacePath: options.workspacePath, access: [], externalApproved: false,
          destructiveApproved: true, networkApproved: false, signal: authority.signal,
        });
      } catch (error) { throw new RecoveryEffectNotDispatchedError(error); }
      try {
        const reservation = reserveExecutionGrantForProcessRecovery(options.executionGrants, grant, binding, true);
        const assertAuthority = () => {
          authority.assertCurrent(); reservation.assertCurrent();
          if (clock().getTime() >= Date.parse(request.expiresAt) || clock().getTime() >= Date.parse(reservation.expiresAt))
            throw new ProcessRecoveryError("recovery_expired");
        };
        assertAuthority();
        const timeoutMs = Math.min(AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS, Date.parse(request.expiresAt) - clock().getTime(),
          Date.parse(reservation.expiresAt) - clock().getTime());
        if (timeoutMs < 1) throw new ProcessRecoveryError("recovery_expired");
        await options.runtime.cleanupOwnedSession({
          sessionId: record.sessionId, timeoutMs, signal: authority.signal, assertAuthority,
        });
        assertAuthority();
        const settled = inspect(request.scope.invocationId);
        if (settled?.cleanup.state !== "verified_empty")
          return Object.freeze({ observation: "outcome_unknown" as const, cleanup: settled?.cleanup ?? { state: "pending" as const } });
        return Object.freeze({ observation: "exited" as const, cleanup: settled.cleanup });
      } finally {
        await options.executionGrants.revoke(grant, authority.signal.aborted ? "cancelled" : "completed");
      }
    },
  });
}

export function combineProcessRecoveryRuntimes(
  subprocess: ProcessRecoveryRuntime,
  streaming: ProcessRecoveryRuntime,
): ProcessRecoveryRuntime {
  const inspect = (invocationId: string) => {
    const matches = [subprocess.inspect(invocationId), streaming.inspect(invocationId)].filter(
      (target): target is RecoveryTarget => target !== undefined,
    );
    return matches.length === 1 ? matches[0] : undefined;
  };
  return Object.freeze({
    inspect,
    list: () => Object.freeze([...(subprocess.list?.() ?? []), ...(streaming.list?.() ?? [])]),
    execute: async (request: RecoveryAuditRecord, authority: RecoveryExecutionAuthority) => {
      const target = inspect(request.scope.invocationId);
      if (!target || !sameRecoveryScope(target.scope, request.scope))
        throw new ProcessRecoveryError("recovery_scope_mismatch");
      return await (request.scope.kind === "streaming" ? streaming : subprocess).execute(request, authority);
    },
  });
}

export function createAgentProcessRecoveryGenerator(options: {
  readonly model: AgentModel;
  readonly clock?: () => Date;
  readonly ttlMs?: number;
}) {
  const clock = options.clock ?? (() => new Date());
  const ttlMs = options.ttlMs ?? 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000)
    throw new ProcessRecoveryError("invalid_recovery_proposal");
  return async (scope: RecoveryScope, proposalId: string, signal: AbortSignal): Promise<RecoveryProposal> => {
    const expiresAt = new Date(clock().getTime() + ttlMs).toISOString();
    const turn = await options.model.complete({
      sessionId: `process-recovery:${scope.runId}:${proposalId}`,
      signal,
      tools: [],
      messages: [
        { id: "recovery-system", role: "system", content:
          "Propose one exceptional process-recovery action. Return exactly one JSON object with only requestedAction, requestedCapabilities, and rationale. Never invent scope, targets, shell commands, credentials, approval, or expiry." },
        { id: "recovery-target", role: "user", content: JSON.stringify({
          exceptionalState: scope.state,
          kind: scope.kind,
          logicalProcessId: scope.logicalProcessId,
          allowedActions: ["inspect", "terminate"],
          allowedCapabilities: ["tree_termination", "crash_cleanup", "verified_emptiness", "write_confinement"],
        }) },
      ],
    });
    if (turn.stopReason !== "end_turn" || turn.blocks.length !== 1 || turn.blocks[0]?.type !== "text")
      throw new ProcessRecoveryError("invalid_recovery_proposal");
    let fragment: unknown;
    try { fragment = JSON.parse(turn.blocks[0].text); }
    catch { throw new ProcessRecoveryError("invalid_recovery_proposal"); }
    if (!fragment || typeof fragment !== "object" || Array.isArray(fragment))
      throw new ProcessRecoveryError("invalid_recovery_proposal");
    const keys = Object.keys(fragment);
    if (keys.length !== 3 || keys.some(key => !["requestedAction", "requestedCapabilities", "rationale"].includes(key)))
      throw new ProcessRecoveryError("invalid_recovery_proposal");
    if (!["inspect", "terminate"].includes(String((fragment as Record<string, unknown>).requestedAction)))
      throw new ProcessRecoveryError("invalid_recovery_proposal");
    return parseRecoveryProposal({
      version: 1, proposalId, callId: `recovery:${proposalId}`, scope,
      requestedAction: (fragment as Record<string, unknown>).requestedAction,
      targetScope: [scope.logicalProcessId],
      requestedCapabilities: (fragment as Record<string, unknown>).requestedCapabilities,
      expiresAt, rationale: (fragment as Record<string, unknown>).rationale,
    });
  };
}

export interface ProcessRecoveryCoordinator {
  records(): Readonly<Record<string, RecoveryAuditRecord>>;
  generate(invocationId: string, proposalId: string): Promise<RecoveryAuditRecord>;
  decide(proposalId: string, fingerprint: string, decision: "approve" | "reject"): Promise<RecoveryAuditRecord>;
  execute(proposalId: string, fingerprint: string): Promise<RecoveryAuditRecord>;
}
export interface ProcessRecoveryControlPlane {
  processRecoveryRecords(runId: string): Readonly<Record<string, RecoveryAuditRecord>>;
  generateProcessRecovery(runId: string, invocationId: string, proposalId: string): Promise<RecoveryAuditRecord>;
  decideProcessRecovery(runId: string, proposalId: string, fingerprint: string, decision: "approve" | "reject"): Promise<RecoveryAuditRecord>;
  executeProcessRecovery(runId: string, proposalId: string, fingerprint: string): Promise<RecoveryAuditRecord>;
}
export interface ProcessRecoveryControllerOptions {
  runId: string; store: SchedulerStore; runtime: ProcessRecoveryRuntime; clock?: () => Date;
  generate?: (scope: RecoveryScope, proposalId: string, signal: AbortSignal) => Promise<unknown>;
  timeoutMs?: number;
}
export class ProcessRecoveryController {
  private readonly pending = new Map<string, Promise<RecoveryAuditRecord>>();
  private readonly generating = new Map<string, Promise<RecoveryAuditRecord>>();
  constructor(private readonly options: ProcessRecoveryControllerOptions) {}
  records(): Readonly<Record<string, RecoveryAuditRecord>> {
    return rebuildSchedulerProjection(this.options.store.readRun(this.options.runId)).processRecovery ?? {};
  }
  async submit(value: unknown): Promise<RecoveryAuditRecord> {
    const proposal = parseRecoveryProposal(value);
    const record = makeRecoveryAudit(proposal, this.now().toISOString());
    const prior = this.find(proposal.proposalId);
    if (prior) {
      if (prior.proposalFingerprint !== record.proposalFingerprint) throw new ProcessRecoveryError("recovery_scope_mismatch");
      return prior;
    }
    this.validate(proposal);
    this.append(record);
    return proposal.requestedAction === "inspect"
      ? this.update(record, "authorized", "validated")
      : this.update(record, "user_decision_required", "destructive_requires_user");
  }
  async decide(proposalId: string, fingerprint: string, decision: "approve" | "reject"): Promise<RecoveryAuditRecord> {
    const record = this.require(proposalId, fingerprint);
    if (!["approve", "reject"].includes(decision)) throw new ProcessRecoveryError("invalid_recovery_proposal");
    if ((record.state === "authorized" && record.reason === "user_approved" && decision === "approve") ||
        (record.state === "rejected" && record.reason === "user_denied" && decision === "reject")) return record;
    if (record.state !== "user_decision_required") throw new ProcessRecoveryError("recovery_scope_mismatch");
    if (decision === "approve") this.validate(record);
    return this.update(record, decision === "approve" ? "authorized" : "rejected",
      decision === "approve" ? "user_approved" : "user_denied", {}, true);
  }
  async execute(proposalId: string, fingerprint: string): Promise<RecoveryAuditRecord> {
    this.require(proposalId, fingerprint);
    const existing = this.pending.get(proposalId);
    if (existing) return existing;
    const pending = this.executeOnce(proposalId, fingerprint).finally(() => this.pending.delete(proposalId));
    this.pending.set(proposalId, pending); return pending;
  }
  private async executeOnce(proposalId: string, fingerprint: string): Promise<RecoveryAuditRecord> {
    let record = this.require(proposalId, fingerprint);
    if (["executed", "rejected", "failed"].includes(record.state)) return record;
    if (record.state === "outcome_unknown") return this.resolveUnknownFromDurableProof(record);
    if (record.state === "executing") return record.requestedAction === "inspect"
      ? this.update(record, "failed", "effect_failed")
      : this.update(record, "outcome_unknown", "effect_outcome_unknown");
    if (record.state !== "authorized") throw new ProcessRecoveryError("recovery_approval_required");
    try { this.validate(record); }
    catch (error) { return this.update(record, "rejected", error instanceof ProcessRecoveryError && error.code === "recovery_expired" ? "expired" : "scope_changed"); }
    const userApproved = record.requestedAction === "inspect" || record.reason === "user_approved";
    if (!userApproved) throw new ProcessRecoveryError("recovery_approval_required");
    // A fresh attempt ID plus the SQLite transition/idempotency guard is the durable execution claim.
    record = this.update(record, "executing", "execution_started", { attemptId: randomUUID() });
    const abort = new AbortController();
    const authority: RecoveryExecutionAuthority = Object.freeze({ userApproved, signal: abort.signal,
      assertCurrent: () => {
        const current = this.require(proposalId, fingerprint);
        if (abort.signal.aborted || Date.parse(record.expiresAt) <= this.now().getTime()) throw new ProcessRecoveryError("recovery_expired");
        if (current.state !== "executing" || current.attemptId !== record.attemptId) throw new ProcessRecoveryError("recovery_outcome_unknown");
      } });
    try {
      authority.assertCurrent();
      const result = await this.bounded(() => this.options.runtime.execute(record, authority), abort,
        Math.min(this.timeoutMs(), Date.parse(record.expiresAt) - this.now().getTime()));
      authority.assertCurrent();
      const facts = { observation: result.observation, cleanupState: result.cleanup.state };
      if (result.observation === "identity_mismatch") return this.update(record, "rejected", "scope_changed", facts);
      if (record.requestedAction !== "inspect" &&
          (result.observation === "outcome_unknown" || result.cleanup.state !== "verified_empty"))
        return this.update(record, "outcome_unknown", "effect_outcome_unknown", facts);
      const completed = this.update(record, "executed",
        record.requestedAction === "inspect" ? "inspection_completed" : "cleanup_verified", facts);
      if (record.requestedAction !== "inspect" && result.cleanup.state === "verified_empty") {
        this.resolveOutstandingUnknowns(record.scope.invocationId, record.proposalId);
      }
      return completed;
    } catch (error) {
      if (error instanceof RecoveryEffectNotDispatchedError || record.requestedAction === "inspect") {
        return this.update(record, "failed", "effect_failed");
      }
      // After a destructive dispatch, silence/rejection is not proof that no effect occurred.
      return this.update(record, "outcome_unknown", "effect_outcome_unknown");
    } finally { abort.abort(); }
  }
  private resolveUnknownFromDurableProof(record: RecoveryAuditRecord): RecoveryAuditRecord {
    const target = this.options.runtime.inspect(record.scope.invocationId);
    if (!target || target.scope.runId !== this.options.runId || !sameRecoveryIdentity(record.scope, recoveryScope(target))) return record;
    if (target.cleanup.state !== "verified_empty") return record;
    return this.update(record, "rejected", "resolved_by_verified_cleanup", {
      observation: "exited", cleanupState: "verified_empty",
    });
  }
  private resolveOutstandingUnknowns(invocationId: string, exceptProposalId: string): void {
    const target = this.options.runtime.inspect(invocationId);
    if (!target || target.scope.runId !== this.options.runId || target.cleanup.state !== "verified_empty") return;
    const scope = recoveryScope(target);
    for (const prior of Object.values(this.records())) {
      if (prior.proposalId === exceptProposalId || prior.state !== "outcome_unknown" ||
          prior.scope.invocationId !== invocationId || !sameRecoveryIdentity(prior.scope, scope)) continue;
      this.update(prior, "rejected", "resolved_by_verified_cleanup", {
        observation: "exited", cleanupState: "verified_empty",
      });
    }
  }
  async generate(invocationId: string, proposalId: string): Promise<RecoveryAuditRecord> {
    const target = this.target(invocationId); // Gate before touching a model, even when no generator is configured.
    const prior = this.find(proposalId);
    if (prior) {
      if (prior.scope.invocationId !== invocationId) throw new ProcessRecoveryError("recovery_scope_mismatch");
      return prior;
    }
    const key = JSON.stringify([invocationId, proposalId]);
    const existing = this.generating.get(key); if (existing) return existing;
    const pending = this.generateOnce(target, proposalId).finally(() => this.generating.delete(key));
    this.generating.set(key, pending); return pending;
  }
  private async generateOnce(target: RecoveryTarget, proposalId: string): Promise<RecoveryAuditRecord> {
    const scope = recoveryScope(target), abort = new AbortController();
    let value: unknown;
    try {
      if (!this.options.generate) throw new ProcessRecoveryError("recovery_model_failed");
      value = await this.bounded(() => this.options.generate!(scope, proposalId, abort.signal), abort, this.timeoutMs());
    } catch { throw new ProcessRecoveryError("recovery_model_failed"); }
    finally { abort.abort(); }
    const proposal = parseRecoveryProposal(value);
    if (proposal.proposalId !== proposalId || !sameRecoveryScope(proposal.scope, scope) ||
        !sameRecoveryScope(recoveryScope(this.target(scope.invocationId)), scope)) throw new ProcessRecoveryError("recovery_scope_mismatch");
    return this.submit(proposal);
  }
  private target(invocationId: string): RecoveryTarget {
    const target = this.options.runtime.inspect(invocationId);
    if (!target || target.scope.runId !== this.options.runId) throw new ProcessRecoveryError("recovery_scope_mismatch");
    if (!isExceptionalProcessState(target.scope.state)) throw new ProcessRecoveryError("routine_recovery_forbidden");
    if (!target.owned) throw new ProcessRecoveryError("recovery_ownership_unavailable");
    if (target.pendingEffects) throw new ProcessRecoveryError("recovery_outcome_unknown");
    if (![target.scope.backendIdentity, target.scope.birthFingerprint].every(v => /^[a-f0-9]{64}$/.test(v))) throw new ProcessRecoveryError("recovery_identity_unavailable");
    return target;
  }
  private validate(proposal: Omit<RecoveryProposal, "rationale">): void {
    const target = this.target(proposal.scope.invocationId);
    if (!sameRecoveryScope(proposal.scope, recoveryScope(target)) || proposal.callId !== `recovery:${proposal.proposalId}` ||
        proposal.targetScope.length !== 1 || proposal.targetScope[0] !== target.scope.logicalProcessId) throw new ProcessRecoveryError("recovery_scope_mismatch");
    const remaining = Date.parse(proposal.expiresAt) - this.now().getTime();
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 300_000) throw new ProcessRecoveryError("recovery_expired");
    if (proposal.requestedAction === "remove_owned_artifact") throw new ProcessRecoveryError("recovery_action_unsupported");
    const required = new Set([...proposal.requestedCapabilities,
      ...(proposal.requestedAction === "terminate" ? ["tree_termination", "verified_emptiness"] as const : [])]);
    for (const capability of required) if (target.capabilities[capability] !== "enforced") throw new ProcessRecoveryError("recovery_capability_unavailable");
  }
  private now(): Date { return this.options.clock?.() ?? new Date(); }
  private timeoutMs(): number {
    const value = this.options.timeoutMs ?? AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS;
    if (!Number.isSafeInteger(value) || value < 1 || value > AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS) throw new ProcessRecoveryError("invalid_recovery_proposal");
    return value;
  }
  private find(proposalId: string): RecoveryAuditRecord | undefined {
    const records = this.records(); return Object.hasOwn(records, proposalId) ? records[proposalId] : undefined;
  }
  private require(proposalId: string, fingerprint: string): RecoveryAuditRecord {
    const record = this.find(proposalId); if (!record) throw new ProcessRecoveryError("recovery_not_found");
    if (record.proposalFingerprint !== fingerprint) throw new ProcessRecoveryError("recovery_scope_mismatch");
    return record;
  }
  private append(record: RecoveryAuditRecord, user = false): RecoveryAuditRecord {
    this.options.store.append({ runId: this.options.runId, type: "process.recovery_updated", occurredAt: record.updatedAt,
      actor: user ? { role: "user", id: "local-user" } : { role: "runner", id: "process-recovery" },
      idempotencyKey: `process-recovery:${record.proposalId}:${record.state}`, payload: { record } });
    return this.require(record.proposalId, record.proposalFingerprint);
  }
  private update(record: RecoveryAuditRecord, state: RecoveryState, reason: RecoveryReason,
    facts: Partial<Pick<RecoveryAuditRecord, "attemptId" | "observation" | "cleanupState">> = {}, user = false): RecoveryAuditRecord {
    return this.append({ ...record, ...facts, state, reason, updatedAt: this.now().toISOString() }, user);
  }
  private async bounded<T>(operation: () => Promise<T>, abort: AbortController, milliseconds: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(new ProcessRecoveryError("recovery_outcome_unknown")); }, Math.max(1, milliseconds));
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
