import { createHmac, randomUUID } from "node:crypto";
import { types as nodeTypes } from "node:util";
import type {
  BoundedOutputSpoolResult,
  OutputStream,
} from "./bounded-output-spool.js";
import type { ChildEnvironmentFactory } from "./child-environment.js";
import {
  parseExecutionInvocationIntent,
  parseProcessOutputDisposition,
  type ExactPathAccess,
  type ExecutionInvocationIntent,
  type GenericProcessResult,
  type ProcessCleanupStatus,
  type ProcessOutputDisposition,
} from "./execution-safety-contracts.js";
import {
  createInMemoryDurableProcessKernel,
  openSqliteDurableProcessKernel,
  semanticRequestFingerprint,
  type DurableBackendBinding,
  type DurableEnvironmentAudit,
  type DurableProcessCommand,
  type DurableProcessRuntimeWriter,
  type DurableProcessStore,
  type DurableProcessStoreKernel,
  type DurableSubprocessRecord,
  type DurableSubprocessResult,
} from "./durable-process-store.js";
import {
  adoptProcessBackendAfterRestart,
  assertProcessBackendRegistryAuthority,
  parseProcessEmptyVerification,
  parseProcessLaunchResult,
  parseProcessObservation,
  parseProcessReconciliation,
  parseProcessReleaseResult,
  parseProcessSignalResult,
  reattestProcessBackend,
  selectProcessBackend,
  type ConsumedExecutionGrant,
  type ProcessBackendBinding,
  type ProcessBackendRegistry,
  type ProcessEffectFence,
  type SelectedProcessBackend,
} from "./process-backend.js";

export type SubprocessRuntimeErrorCode =
  | "launch_not_proven"
  | "orphaned"
  | "identity_mismatch"
  | "backend_unavailable"
  | "outcome_unknown"
  | "cleanup_blocked";
export class SubprocessRuntimeError extends Error {
  constructor(
    readonly code: SubprocessRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SubprocessRuntimeError";
  }
}
export interface ExecutionGrantController {
  issue(value: unknown): void;
  revoke(grantId: string): boolean;
}
export interface SubprocessRuntimeClock {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}
export interface ProcessOutputSession {
  readonly ownerId: string;
  write(
    stream: OutputStream,
    bytes: Uint8Array,
    fence: ProcessEffectFence,
  ): Promise<void>;
  finalize(fence: ProcessEffectFence): Promise<BoundedOutputSpoolResult>;
  cleanup(fence: ProcessEffectFence): Promise<void>;
}
export interface ProcessOutputFactory {
  prepare(
    ownerId: string,
    fence: ProcessEffectFence,
  ): Promise<ProcessOutputSession>;
  reopen(
    ownerId: string,
    fence: ProcessEffectFence,
  ): Promise<ProcessOutputSession>;
}
export interface SubprocessRuntimeKernelOptions {
  readonly registry: ProcessBackendRegistry;
  readonly state:
    | { readonly kind: "memory" }
    | { readonly kind: "sqlite"; readonly path: string };
  readonly stateKey: Uint8Array;
  readonly clock: SubprocessRuntimeClock;
  readonly environments: ChildEnvironmentFactory;
  readonly outputs: ProcessOutputFactory;
  readonly createLogicalProcessId?: (invocationId: string) => string;
  readonly escalationGraceMs?: readonly [number, number];
  readonly leaseDurationMs?: number;
  readonly leaseHeartbeatMs?: number;
}
export interface SubprocessRuntimeKernel {
  readonly runtime: SubprocessRuntime;
  readonly grantsController: ExecutionGrantController;
  readonly readOnlyStore: DurableProcessStore;
}
class GrantVault {
  private readonly values = new Map<string, ConsumedExecutionGrant>();
  private readonly digests = new Map<string, string>();
  constructor(private readonly key: Uint8Array) {}
  issue(value: unknown): void {
    const grant = parseGrant(value);
    if (this.values.has(grant.grantId))
      throw new Error("Execution grant already exists.");
    this.values.set(grant.grantId, grant);
    this.digests.set(
      grant.grantId,
      createHmac("sha256", this.key).update(canonicalJson(grant)).digest("hex"),
    );
  }
  revoke(id: string): boolean {
    const safe = safeText(id, "grantId");
    const active = this.values.delete(safe);
    if (active) this.digests.delete(safe);
    return active;
  }
  bindingDigest(id: string): string {
    const digest = this.digests.get(id);
    if (!digest) throw new Error("Execution grant is invalid.");
    return digest;
  }
  consume(id: string): unknown {
    const value = this.values.get(id);
    if (!value) throw new Error("Execution grant is invalid.");
    this.values.delete(id);
    return value;
  }
}
export interface SubprocessInvocation {
  readonly intent: ExecutionInvocationIntent;
  readonly grantId: string;
  readonly ambientEnvironment: Readonly<Record<string, string | undefined>>;
  readonly explicitEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly credentialGrantId?: string;
  readonly signal?: AbortSignal;
  readonly deadline?: Date;
}
export interface ReconciliationOutcome {
  readonly invocationId: string;
  readonly state: string;
}

type SnapshotInvocation = SubprocessInvocation;
interface StopTrigger {
  readonly reason: "cancelled" | "timed_out";
}
export interface SubprocessRuntime {
  invoke(value: SubprocessInvocation): Promise<GenericProcessResult>;
  cancel(invocationId: string): Promise<boolean>;
  reconcileStartup(): Promise<ReconciliationOutcome[]>;
}
interface InternalRuntimeOptions {
  readonly registry: ProcessBackendRegistry;
  readonly writer: DurableProcessRuntimeWriter;
  readonly store: DurableProcessStore;
  readonly stateKey: Uint8Array;
  readonly grants: GrantVault;
  readonly clock: SubprocessRuntimeClock;
  readonly environments: ChildEnvironmentFactory;
  readonly outputs: ProcessOutputFactory;
  readonly createLogicalProcessId?: (id: string) => string;
  readonly escalationGraceMs?: readonly [number, number];
  readonly leaseDurationMs?: number;
  readonly leaseHeartbeatMs?: number;
}

class RunnerSubprocessRuntime implements SubprocessRuntime {
  private readonly writer: DurableProcessRuntimeWriter;
  private readonly termination = new Map<string, Promise<void>>();
  private readonly fences = new Map<string, number>();
  private readonly createId: (invocationId: string) => string;
  private readonly grace: readonly [number, number];
  private readonly ownerId = safeOwnerId(`owner-${randomUUID()}`);
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  constructor(private readonly options: InternalRuntimeOptions) {
    this.writer = options.writer;
    this.createId =
      options.createLogicalProcessId ?? ((id) => `proc_${id}_${randomUUID()}`);
    this.grace = options.escalationGraceMs ?? [250, 1000];
    this.leaseMs = options.leaseDurationMs ?? 300_000;
    this.heartbeatMs = options.leaseHeartbeatMs ?? 100_000;
  }

  invoke(value: SubprocessInvocation): Promise<GenericProcessResult> {
    let request: SnapshotInvocation;
    try {
      request = snapshotInvocation(value);
    } catch (error) {
      return Promise.reject(error);
    }
    let grantBindingDigest: string;
    try {
      grantBindingDigest = digestText(
        this.options.grants.bindingDigest(request.grantId),
      );
    } catch {
      return Promise.reject(new Error("Execution grant is invalid."));
    }
    const requestFingerprint = semanticRequestFingerprint(
      this.options.stateKey,
      {
        intent: request.intent,
        ambientEnvironment: request.ambientEnvironment,
        ...(request.explicitEnvironment
          ? { explicitEnvironment: request.explicitEnvironment }
          : {}),
        ...(request.credentialGrantId
          ? { credentialGrantId: request.credentialGrantId }
          : {}),
        grantId: request.grantId,
        grantBindingDigest,
        ...(request.deadline
          ? { deadline: request.deadline.toISOString() }
          : {}),
        signalPresent: request.signal !== undefined,
        signalInitiallyAborted: request.signal?.aborted ?? false,
      },
    );
    const logicalProcessId = this.createId(request.intent.invocationId);
    const outputOwnerId = safeOwnerId(`output-${logicalProcessId}`);
    const ownerId = this.ownerId;
    let claim;
    try {
      claim = this.writer.claim({
        schemaVersion: 2,
        revision: 0,
        logicalProcessId,
        invocationId: request.intent.invocationId,
        runId: request.intent.runId,
        ...(request.intent.taskId ? { taskId: request.intent.taskId } : {}),
        ...(request.intent.sessionId
          ? { sessionId: request.intent.sessionId }
          : {}),
        requestFingerprint,
        retryKey: requestFingerprint,
        ownerId,
        leaseExpiresAt: this.leaseExpiry(),
        outputOwnerId,
        outputPrepared: false,
        state: "prepared",
        history: [{ state: "prepared", at: this.now() }],
        requiredCapabilities: [...request.intent.requestedCapabilities],
        environmentAudit: {
          inheritedNames: [],
          removedNames: [],
          explicitSafeNames: [],
          grantedNames: [],
        },
        escalation: [],
        cleanup: { state: "pending" },
      });
    } catch (error) {
      return Promise.reject(error);
    }
    if (!claim.won) {
      if (claim.record.state === "cleanup_blocked" && claim.record.backendBinding)
        return this.recoverBlockedRetry(claim.record);
      if (claim.record.result)
        return Promise.resolve(resultFromRecord(claim.record));
      return this.observeExisting(claim.record.invocationId);
    }
    this.fences.set(claim.record.invocationId, claim.record.fencingToken);
    return this.runClaimed(request, claim.record);
  }

  async cancel(invocationId: string): Promise<boolean> {
    let record = this.options.store.readByInvocation(invocationId);
    if (
      !record ||
      ![
        "prepared",
        "launching",
        "running",
        "stopping",
        "backend_unavailable",
        "cleanup_blocked",
      ].includes(record.state)
    )
      return false;
    const owned = this.takeRecoveryOwnership(record);
    if (!owned) return false;
    record = owned;
    if (!record.stopIntent)
      record = this.applyCurrent(record, (revision) => ({
        type: "request_stop",
        invocationId,
        expectedRevision: revision,
        at: this.now(),
        reason: "cancelled",
      }));
    if (record.state === "prepared" || record.state === "launching")
      return true;
    if (!record.backendBinding) return false;
    try {
      if (record.state === "cleanup_blocked") await this.reconcileRecord(record);
      else await this.escalate(record);
    } catch {
      return false;
    }
    return true;
  }

  async reconcileStartup(): Promise<ReconciliationOutcome[]> {
    const outcomes: ReconciliationOutcome[] = [];
    for (const invocationId of this.options.store.listRowIds()) {
      let snapshot: DurableSubprocessRecord;
      try {
        const decoded = this.options.store.readByInvocation(invocationId);
        if (!decoded) continue;
        snapshot = decoded;
      } catch {
        outcomes.push({ invocationId, state: "corrupt" });
        continue;
      }
      if (
        ![
          "prepared",
          "launching",
          "running",
          "stopping",
          "exited",
          "verifying_empty",
          "backend_unavailable",
          "cleanup_blocked",
        ].includes(snapshot.state)
      )
        continue;
      if (snapshot.pendingEffect) {
        outcomes.push({
          invocationId,
          state: "effect_outcome_unresolved",
        });
        continue;
      }
      if (
        snapshot.state === "cleanup_blocked" &&
        !snapshot.backendBinding &&
        snapshot.result?.outcome !== "launch_failed"
      )
        continue;
      const leaseIsLive =
        Date.parse(snapshot.leaseExpiresAt) >
        this.options.clock.now().getTime();
      if (snapshot.state === "launching" && !snapshot.backendBinding) {
        if (leaseIsLive) {
          outcomes.push({ invocationId, state: "leased" });
          continue;
        }
        try {
          snapshot = this.writer.apply({
            type: "orphan_unbound_launch",
            invocationId,
            expectedRevision: snapshot.revision,
            ownerId: snapshot.ownerId,
            fencingToken: snapshot.fencingToken + 1,
            at: this.now(),
            detail: "Restart found launch without durable identity.",
          });
        } catch {}
        let current: DurableSubprocessRecord | undefined;
        try {
          current = this.options.store.readByInvocation(invocationId);
        } catch {}
        outcomes.push({
          invocationId,
          state: current?.state ?? "corrupt",
        });
        continue;
      }
      try {
        const owned = this.takeRecoveryOwnership(snapshot);
        if (!owned) {
          outcomes.push({ invocationId, state: "leased" });
          continue;
        }
        snapshot = owned;
        await this.reconcileRecord(snapshot);
      } catch (error) {
        await this.classifyReconciliationFailure(snapshot, error);
      }
      let current: DurableSubprocessRecord | undefined;
      try {
        current = this.options.store.readByInvocation(snapshot.invocationId);
      } catch {}
      outcomes.push({
        invocationId: snapshot.invocationId,
        state: current?.state ?? "corrupt",
      });
    }
    return outcomes;
  }

  private async runClaimed(
    request: SnapshotInvocation,
    record: DurableSubprocessRecord,
  ): Promise<GenericProcessResult> {
    record = this.renew(record);
    let output: ProcessOutputSession;
    try {
      output = await this.fencedEffect(record.invocationId, (fence) =>
        this.options.outputs.prepare(record.outputOwnerId, fence),
      );
      record = this.current(record.invocationId);
      record = this.mutate({
        type: "mark_output_prepared",
        invocationId: record.invocationId,
        expectedRevision: record.revision,
        at: this.now(),
      });
    } catch (error) {
      record = this.current(record.invocationId);
      this.mutate({
        type: "record_output_prepare_failure",
        invocationId: record.invocationId,
        expectedRevision: record.revision,
        at: this.now(),
        detail: "Recoverable output ownership could not be prepared.",
      });
      throw new SubprocessRuntimeError(
        "launch_not_proven",
        "Recoverable output ownership could not be prepared.",
        { cause: error },
      );
    }
    let grant: ConsumedExecutionGrant;
    try {
      grant = consumeGrant(
        this.options.grants,
        request.grantId,
        request.intent,
        this.options.clock.now(),
      );
    } catch (error) {
      await this.failBeforeLaunch(
        record,
        output,
        "Execution grant was invalid.",
      );
      throw error;
    }
    let preparedEnvironment;
    try {
      preparedEnvironment = this.options.environments.prepare({
        ambient: request.ambientEnvironment,
        explicitOverrides: request.explicitEnvironment,
        runId: request.intent.runId,
        invocationId: request.intent.invocationId,
        credentialGrantId: request.credentialGrantId,
      });
    } catch (error) {
      await this.failBeforeLaunch(
        record,
        output,
        "Child environment preparation failed.",
      );
      throw error;
    }
    const audit: DurableEnvironmentAudit = {
      inheritedNames: [...preparedEnvironment.audit.inheritedNames],
      removedNames: [...preparedEnvironment.audit.removedNames],
      explicitSafeNames: [...preparedEnvironment.audit.explicitSafeNames],
      grantedNames: [...preparedEnvironment.audit.grantedNames],
    };
    record = this.current(record.invocationId);
    record = this.mutate({
      type: "record_environment",
      invocationId: record.invocationId,
      expectedRevision: record.revision,
      at: this.now(),
      environmentAudit: audit,
    });
    record = this.applyCurrent(record, (revision) => ({
      type: "mark_launching",
      invocationId: record.invocationId,
      expectedRevision: revision,
      at: this.now(),
    }));
    let selected: SelectedProcessBackend;
    try {
      selected = await this.fencedEffect(record.invocationId, (fence) =>
        selectProcessBackend(
          this.options.registry,
          request.intent.requestedCapabilities,
          fence,
        ),
      );
    } catch (error) {
      await this.failBeforeLaunch(
        record,
        output,
        "No verified backend satisfies invocation.",
      );
      throw new SubprocessRuntimeError(
        "backend_unavailable",
        "No verified backend satisfies invocation.",
        { cause: error },
      );
    }
    const stopPromise = this.stopTrigger(request);
    const launchPromise = this.fencedEffect(record.invocationId, (fence) =>
      this.options.environments.withChildEnvironment(
        preparedEnvironment.capability,
        (environment) =>
          selected.backend.launch(
            deepFreeze({
              intent: request.intent,
              grant,
              environment: snapshotChildEnvironment(environment),
              outputOwnerId: record.outputOwnerId,
              fence,
            }),
          ),
      ),
    );
    let rawLaunch: unknown;
    let first:
      { kind: "launch"; value: unknown } | { kind: "stop"; stop: StopTrigger };
    try {
      first = await Promise.race([
        Promise.resolve(launchPromise).then((value) => ({
          kind: "launch" as const,
          value,
        })),
        stopPromise.then((stop) => ({ kind: "stop" as const, stop })),
      ]);
    } catch (error) {
      const blocked = recoverableLaunchBlocker(error);
      if (blocked)
        return await this.persistLaunchCleanupBlocker(record, output, selected, blocked);
      await this.failBeforeLaunch(
        record,
        output,
        "Launch failed before identity was proven.",
      );
      throw new SubprocessRuntimeError(
        "launch_not_proven",
        "Process launch was not proven.",
        { cause: error },
      );
    }
    if (first.kind === "stop") {
      record = this.requestStopLatest(record.invocationId, first.stop.reason);
      try {
        rawLaunch = await launchPromise;
      } catch (error) {
        const blocked = recoverableLaunchBlocker(error);
        if (blocked)
          return await this.persistLaunchCleanupBlocker(record, output, selected, blocked);
        await this.failBeforeLaunch(
          record,
          output,
          "Launch did not return identity.",
        );
        throw new SubprocessRuntimeError(
          "launch_not_proven",
          "Process launch was not proven.",
          { cause: error },
        );
      }
    } else rawLaunch = first.value;
    let launch;
    try {
      launch = parseProcessLaunchResult(rawLaunch);
    } catch (error) {
      await this.failBeforeLaunch(record, output, "Malformed launch result.");
      throw new SubprocessRuntimeError(
        "launch_not_proven",
        "Process launch was not proven.",
        { cause: error },
      );
    }
    const binding: DurableBackendBinding = {
      registryId: selected.registryId,
      backendId: selected.attestation.backendId,
      implementationGeneration: selected.implementationGeneration,
      implementationDigest: selected.implementationDigest,
      attestationVersion: selected.attestation.attestationVersion,
      attestationDigest: selected.attestationDigest,
      ...launch,
    };
    record = this.current(record.invocationId);
    record = this.mutate({
      type: "bind_launch",
      invocationId: record.invocationId,
      expectedRevision: record.revision,
      at: this.now(),
      binding,
    });
    const observePromise = this.fencedEffect(record.invocationId, (fence) =>
      selected.backend.observe(
        binding,
        (stream, bytes) => output.write(stream, bytes, fence),
        fence,
      ),
    );
    try {
      if (record.stopIntent) {
        await this.escalate(record);
        rawLaunch = await observePromise;
      } else {
        const race = await Promise.race([
          Promise.resolve(observePromise).then((value) => ({
            kind: "observed" as const,
            value,
          })),
          stopPromise.then((stop) => ({ kind: "stop" as const, stop })),
        ]);
        if (race.kind === "stop") {
          record = this.requestStopLatest(
            record.invocationId,
            race.stop.reason,
          );
          await this.escalate(record);
          rawLaunch = await observePromise;
        } else rawLaunch = race.value;
      }
    } catch (error) {
      const current = this.current(record.invocationId);
      if (
        [
          "launching",
          "running",
          "stopping",
          "exited",
          "verifying_empty",
          "backend_unavailable",
        ].includes(current.state)
      )
        this.applyFailure(
          current,
          "backend_unavailable",
          "Process observation or termination failed.",
        );
      throw new SubprocessRuntimeError(
        "backend_unavailable",
        "Process observation or termination failed.",
        { cause: error },
      );
    }
    let observation;
    try {
      observation = parseProcessObservation(rawLaunch);
    } catch (error) {
      this.applyFailure(
        this.current(record.invocationId),
        "backend_unavailable",
        "Malformed process observation.",
      );
      throw new SubprocessRuntimeError(
        "outcome_unknown",
        "Process observation was malformed.",
        { cause: error },
      );
    }
    record = this.current(record.invocationId);
    record = this.mutate({
      type: "record_exit",
      invocationId: record.invocationId,
      expectedRevision: record.revision,
      at: this.now(),
      observation: {
        ...(observation.exitCode === undefined
          ? {}
          : { exitCode: observation.exitCode }),
        ...(observation.signal ? { signal: observation.signal } : {}),
        observedAt: this.now(),
      },
    });
    return await this.finish(record, output, selected);
  }

  private async persistLaunchCleanupBlocker(
    record: DurableSubprocessRecord,
    _output: ProcessOutputSession,
    selected: SelectedProcessBackend,
    blocked: { readonly launch: ReturnType<typeof parseProcessLaunchResult>; readonly detail: string },
  ): Promise<GenericProcessResult> {
    const binding: DurableBackendBinding = {
      registryId: selected.registryId,
      backendId: selected.attestation.backendId,
      implementationGeneration: selected.implementationGeneration,
      implementationDigest: selected.implementationDigest,
      attestationVersion: selected.attestation.attestationVersion,
      attestationDigest: selected.attestationDigest,
      ...blocked.launch,
    };
    record = this.current(record.invocationId);
    record = this.mutate({
      type: "bind_launch",
      invocationId: record.invocationId,
      expectedRevision: record.revision,
      at: this.now(),
      binding,
    });
    let detail = blocked.detail;
    try {
      const reconciliation = parseProcessReconciliation(
        await this.fencedEffect(
          record.invocationId,
          (fence) => selected.backend.reconcile(binding, fence),
          { family: "backend_reconcile", resolution: "settle" },
        ),
      );
      const verification = parseProcessEmptyVerification(
        await this.fencedEffect(record.invocationId, (fence) =>
          selected.backend.verifyEmpty(binding, fence),
        ),
      );
      detail = verification.empty
        ? `${detail} Backend reconciliation reported ${reconciliation.state}; retained binding requires explicit recovery.`
        : verification.detail === detail
          ? detail
          : `${detail} Backend verification: ${verification.detail}`;
    } catch (error) {
      detail = `${detail} Blocker reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}`;
    }
    const at = this.now();
    const failed = this.applyFailure(record, "cleanup_blocked", detail, {
      state: "failed",
      failedAt: at,
      code: "launch_cleanup_blocked",
      detail,
    });
    return resultFromFailure(failed);
  }

  private async finish(
    record: DurableSubprocessRecord,
    output: ProcessOutputSession,
    selected?: SelectedProcessBackend,
  ): Promise<GenericProcessResult> {
    if (record.state === "exited") {
      let disposition: ProcessOutputDisposition[];
      try {
        disposition = outputDisposition(
          await this.fencedEffect(
            record.invocationId,
            (fence) => output.finalize(fence),
            { family: "output_finalize", resolution: "commit" },
          ),
        );
      } catch {
        const failed = this.applyFailure(
          record,
          "cleanup_blocked",
          "Output finalization failed.",
          {
            state: "failed",
            failedAt: this.now(),
            code: "output_finalize_failed",
            detail: "Recoverable output could not be finalized.",
          },
        );
        return resultFromFailure(failed);
      }
      record = this.current(record.invocationId);
      record = this.mutate({
        type: "begin_verify",
        invocationId: record.invocationId,
        expectedRevision: record.revision,
        at: this.now(),
        output: disposition,
      });
    }
    if (record.state !== "verifying_empty") return resultFromFailure(record);
    let binding = requiredBinding(record);
    let backend = selected;
    try {
      if (!backend) {
        try {
          backend = await this.fencedEffect(record.invocationId, (fence) =>
            reattestProcessBackend(this.options.registry, binding, fence),
          );
        } catch {
          backend = await this.fencedEffect(record.invocationId, (fence) =>
            adoptProcessBackendAfterRestart(
              this.options.registry,
              binding,
              fence,
            ),
          );
          record = this.mutate({
            type: "adopt_backend",
            invocationId: record.invocationId,
            expectedRevision: record.revision,
            at: this.now(),
            binding: {
              ...binding,
              registryId: backend.registryId,
              implementationGeneration: backend.implementationGeneration,
              implementationDigest: backend.implementationDigest,
              attestationVersion: backend.attestation.attestationVersion,
              attestationDigest: backend.attestationDigest,
            },
          });
          binding = requiredBinding(record);
        }
      }
    } catch (error) {
      this.applyFailure(
        record,
        "backend_unavailable",
        "Backend attestation changed before empty verification.",
      );
      throw new SubprocessRuntimeError(
        "backend_unavailable",
        "Backend attestation changed.",
        { cause: error },
      );
    }
    let verification;
    try {
      verification = parseProcessEmptyVerification(
        await this.fencedEffect(record.invocationId, (fence) =>
          backend.backend.verifyEmpty(binding, fence),
        ),
      );
    } catch {
      const failed = this.applyFailure(
        record,
        "cleanup_blocked",
        "Malformed empty verification.",
        {
          state: "failed",
          failedAt: this.now(),
          code: "empty_verification_invalid",
          detail: "Backend empty verification was invalid.",
        },
      );
      return resultFromFailure(failed);
    }
    const finishedAt = this.now();
    if (!verification.empty) {
      const failed = this.applyFailure(
        record,
        "cleanup_blocked",
        verification.detail,
        {
          state: "failed",
          failedAt: finishedAt,
          code: "verified_empty_failed",
          detail: verification.detail,
        },
      );
      return resultFromFailure(failed);
    }
    try {
      const fresh = await this.fencedEffect(record.invocationId, (fence) =>
        reattestProcessBackend(this.options.registry, binding, fence),
      );
      parseProcessReleaseResult(
        await this.fencedEffect(
          record.invocationId,
          (fence) => fresh.backend.release(binding, fence),
          { family: "backend_release", resolution: "commit" },
        ),
      );
    } catch {
      const failed = this.applyFailure(
        record,
        "cleanup_blocked",
        "Backend release failed.",
        {
          state: "failed",
          failedAt: finishedAt,
          code: "backend_release_failed",
          detail: "Backend release was invalid or failed.",
        },
      );
      return resultFromFailure(failed);
    }
    const result = terminalResult(record, finishedAt);
    const cleanup: ProcessCleanupStatus = {
      state: "verified_empty",
      verifiedAt: finishedAt,
      ...(verification.proofArtifactId
        ? { proofArtifactId: verification.proofArtifactId }
        : {}),
    };
    record = this.current(record.invocationId);
    record = this.mutate({
      type: "complete",
      invocationId: record.invocationId,
      expectedRevision: record.revision,
      at: finishedAt,
      cleanup,
      result,
    });
    return resultFromRecord(record);
  }

  private async escalate(snapshot: DurableSubprocessRecord): Promise<void> {
    const existing = this.termination.get(snapshot.invocationId);
    if (existing) return existing;
    const work = this.runEscalation(snapshot).finally(() =>
      this.termination.delete(snapshot.invocationId),
    );
    this.termination.set(snapshot.invocationId, work);
    return work;
  }
  private async runEscalation(
    snapshot: DurableSubprocessRecord,
  ): Promise<void> {
    let record = this.current(snapshot.invocationId);
    if (record.state === "backend_unavailable" && record.stopIntent)
      record = this.applyCurrent(record, (revision) => ({
        type: "request_stop",
        invocationId: record.invocationId,
        expectedRevision: revision,
        at: this.now(),
        reason: record.stopIntent!.reason,
      }));
    else if (
      record.state === "running" ||
      record.state === "backend_unavailable"
    )
      record = this.requestStopLatest(
        record.invocationId,
        record.stopIntent?.reason ?? "cancelled",
      );
    if (
      (record.state !== "stopping" && record.state !== "cleanup_blocked") ||
      !record.backendBinding
    ) return;
    const actions = ["interrupt", "terminate", "force_terminate"] as const;
    for (let index = 0; index < actions.length; index += 1) {
      record = this.current(record.invocationId);
      if (record.state !== "stopping" && record.state !== "cleanup_blocked") return;
      const action = actions[index]!;
      const prior = record.escalation.find((entry) => entry.action === action);
      if (prior && prior.outcome !== "requested") {
        if (prior.outcome === "exited") return;
        if (index < this.grace.length)
          await this.fencedEffect(record.invocationId, () =>
            this.options.clock.sleep(this.grace[index]!),
          );
        continue;
      }
      if (!prior) {
        record = this.mutate({
          type: "start_escalation",
          invocationId: record.invocationId,
          expectedRevision: record.revision,
          action,
          requestedAt: this.now(),
        });
      }
      let outcome: "running" | "exited" | "failed" = "failed";
      let detail: string | undefined;
      try {
        const selected = await this.fencedEffect(record.invocationId, (fence) =>
          reattestProcessBackend(
            this.options.registry,
            record.backendBinding!,
            fence,
          ),
        );
        outcome = parseProcessSignalResult(
          await this.fencedEffect(
            record.invocationId,
            (fence) =>
              selected.backend.signal(record.backendBinding!, action, fence),
            { family: "backend_signal", resolution: "commit" },
          ),
        ).state;
      } catch (error) {
        detail = error instanceof Error ? error.message : "Signal failed";
      }
      record = this.current(record.invocationId);
      record = this.mutate({
        type: "finish_escalation",
        invocationId: record.invocationId,
        expectedRevision: record.revision,
        action,
        completedAt: this.now(),
        outcome,
        ...(detail ? { detail } : {}),
      });
      if (outcome === "failed") {
        if (record.state === "cleanup_blocked")
          throw new SubprocessRuntimeError(
            "identity_mismatch",
            "Blocked backend authority could not be freshly revalidated.",
          );
        this.applyFailure(
          record,
          "identity_mismatch",
          "Backend authority could not be freshly revalidated before signal.",
        );
        throw new SubprocessRuntimeError(
          "identity_mismatch",
          "Backend authority could not be freshly revalidated.",
        );
      }
      if (outcome === "exited") return;
      if (index < this.grace.length)
        await this.fencedEffect(record.invocationId, () =>
          this.options.clock.sleep(this.grace[index]!),
        );
    }
  }

  private async reconcileRecord(
    snapshot: DurableSubprocessRecord,
  ): Promise<void> {
    let record = this.current(snapshot.invocationId);
    let output: ProcessOutputSession;
    try {
      output = await this.fencedEffect(record.invocationId, (fence) =>
        record.outputPrepared
          ? this.options.outputs.reopen(record.outputOwnerId, fence)
          : this.options.outputs.prepare(record.outputOwnerId, fence),
      );
      if (!record.outputPrepared) {
        record = this.mutate({
          type: "mark_output_prepared",
          invocationId: record.invocationId,
          expectedRevision: record.revision,
          at: this.now(),
        });
      }
    } catch (error) {
      throw new SubprocessRuntimeError(
        "outcome_unknown",
        "Output ownership could not be reopened.",
        { cause: error },
      );
    }
    if (
      record.state === "cleanup_blocked" &&
      !record.backendBinding &&
      record.result?.outcome === "launch_failed"
    ) {
      try {
        await this.cleanupOutput(record, output);
      } catch {
        this.blockPrelaunchCleanup(record);
        return;
      }
      record = this.current(record.invocationId);
      this.mutate({
        type: "settle_output_cleanup",
        invocationId: record.invocationId,
        expectedRevision: record.revision,
        at: this.now(),
      });
      return;
    }
    if (record.state === "cleanup_blocked" && record.backendBinding) {
      await this.recoverBoundCleanup(record, output);
      return;
    }
    if (record.state === "prepared") {
      try {
        await this.cleanupOutput(record, output);
      } catch {
        this.blockPrelaunchCleanup(record);
        return;
      }
      record = this.current(record.invocationId);
      this.mutate({
        type: "fail_launch",
        invocationId: record.invocationId,
        expectedRevision: record.revision,
        at: this.now(),
        detail: "Restart found prepared intent.",
      });
      return;
    }
    if (record.state === "launching") {
      this.applyFailure(
        record,
        "orphaned",
        "Restart found launch without durable identity.",
      );
      return;
    }
    if (record.state === "exited" || record.state === "verifying_empty") {
      await this.finish(record, output);
      return;
    }
    if (!record.backendBinding)
      throw new SubprocessRuntimeError(
        "identity_mismatch",
        "Recoverable process lacks durable identity.",
      );
    let selected: SelectedProcessBackend;
    try {
      selected = await this.fencedEffect(record.invocationId, (fence) =>
        reattestProcessBackend(
          this.options.registry,
          record.backendBinding!,
          fence,
        ),
      );
    } catch {
      selected = await this.fencedEffect(record.invocationId, (fence) =>
        adoptProcessBackendAfterRestart(
          this.options.registry,
          record.backendBinding!,
          fence,
        ),
      );
      const prior = record.backendBinding;
      record = this.mutate({
        type: "adopt_backend",
        invocationId: record.invocationId,
        expectedRevision: record.revision,
        at: this.now(),
        binding: {
          ...prior,
          registryId: selected.registryId,
          implementationGeneration: selected.implementationGeneration,
          implementationDigest: selected.implementationDigest,
          attestationVersion: selected.attestation.attestationVersion,
          attestationDigest: selected.attestationDigest,
        },
      });
    }
    const activeBinding = record.backendBinding!;
    const reconciliation = parseProcessReconciliation(
      await this.fencedEffect(
        record.invocationId,
        (fence) => selected.backend.reconcile(activeBinding, fence),
        { family: "backend_reconcile", resolution: "settle" },
      ),
    );
    if (reconciliation.state === "identity_mismatch") {
      this.applyFailure(
        record,
        "identity_mismatch",
        "Backend reconciliation rejected identity.",
      );
      return;
    }
    if (reconciliation.state === "outcome_unknown") {
      this.applyFailure(
        record,
        "outcome_unknown",
        "Backend reconciliation outcome is unknown.",
      );
      return;
    }
    if (reconciliation.state === "running") {
      if (record.stopIntent) await this.escalate(record);
      let observation;
      try {
        observation = parseProcessObservation(
          await this.fencedEffect(record.invocationId, (fence) =>
            selected.backend.observe(
              activeBinding,
              (stream, bytes) => output.write(stream, bytes, fence),
              fence,
            ),
          ),
        );
      } catch (error) {
        throw new SubprocessRuntimeError(
          "outcome_unknown",
          "Recovered observation failed.",
          { cause: error },
        );
      }
      record = this.current(record.invocationId);
      record = this.mutate({
        type: "record_exit",
        invocationId: record.invocationId,
        expectedRevision: record.revision,
        at: this.now(),
        observation: {
          ...(observation.exitCode === undefined
            ? {}
            : { exitCode: observation.exitCode }),
          ...(observation.signal ? { signal: observation.signal } : {}),
          observedAt: this.now(),
        },
      });
    } else {
      record = this.current(record.invocationId);
      record = this.mutate({
        type: "record_exit",
        invocationId: record.invocationId,
        expectedRevision: record.revision,
        at: this.now(),
        observation: {
          ...(reconciliation.exitCode === undefined
            ? {}
            : { exitCode: reconciliation.exitCode }),
          ...(reconciliation.signal ? { signal: reconciliation.signal } : {}),
          observedAt: this.now(),
        },
      });
    }
    await this.finish(record, output, selected);
  }

  private async recoverBoundCleanup(
    snapshot: DurableSubprocessRecord,
    output: ProcessOutputSession,
  ): Promise<void> {
    let record = this.current(snapshot.invocationId);
    let binding = requiredBinding(record);
    let selected: SelectedProcessBackend;
    try {
      selected = await this.fencedEffect(record.invocationId, (fence) =>
        reattestProcessBackend(this.options.registry, binding, fence),
      );
    } catch {
      selected = await this.fencedEffect(record.invocationId, (fence) =>
        adoptProcessBackendAfterRestart(this.options.registry, binding, fence),
      );
      record = this.mutate({
        type: "adopt_backend",
        invocationId: record.invocationId,
        expectedRevision: record.revision,
        at: this.now(),
        binding: {
          ...binding,
          registryId: selected.registryId,
          implementationGeneration: selected.implementationGeneration,
          implementationDigest: selected.implementationDigest,
          attestationVersion: selected.attestation.attestationVersion,
          attestationDigest: selected.attestationDigest,
        },
      });
      binding = requiredBinding(record);
    }
    let reconciliation = parseProcessReconciliation(
      await this.fencedEffect(
        record.invocationId,
        (fence) => selected.backend.reconcile(binding, fence),
        { family: "backend_reconcile", resolution: "settle" },
      ),
    );
    if (reconciliation.state === "running" && record.stopIntent) {
      await this.escalate(record);
      record = this.current(record.invocationId);
      if (record.state !== "cleanup_blocked") return;
      binding = requiredBinding(record);
      selected = await this.fencedEffect(record.invocationId, (fence) =>
        reattestProcessBackend(this.options.registry, binding, fence),
      );
      reconciliation = parseProcessReconciliation(
        await this.fencedEffect(
          record.invocationId,
          (fence) => selected.backend.reconcile(binding, fence),
          { family: "backend_reconcile", resolution: "settle" },
        ),
      );
    }
    if (reconciliation.state !== "exited") return;
    record = this.current(record.invocationId);
    record = this.mutate({
      type: "resume_blocked_exit",
      invocationId: record.invocationId,
      expectedRevision: record.revision,
      at: this.now(),
      observation: {
        ...(reconciliation.exitCode === undefined
          ? {}
          : { exitCode: reconciliation.exitCode }),
        ...(reconciliation.signal ? { signal: reconciliation.signal } : {}),
        observedAt: this.now(),
      },
    });
    await this.finish(record, output, selected);
  }

  private async classifyReconciliationFailure(
    snapshot: DurableSubprocessRecord,
    error: unknown,
  ): Promise<void> {
    const record = this.options.store.readByInvocation(snapshot.invocationId);
    if (
      !record ||
      ![
        "prepared",
        "launching",
        "running",
        "stopping",
        "exited",
        "verifying_empty",
        "backend_unavailable",
      ].includes(record.state)
    )
      return;
    try {
      if (record.state === "prepared")
        this.mutate({
          type: "fail_launch",
          invocationId: record.invocationId,
          expectedRevision: record.revision,
          at: this.now(),
          detail: "Reconciliation failed before launch.",
        });
      else
        this.applyFailure(
          record,
          "outcome_unknown",
          error instanceof Error ? error.message : "Reconciliation failed.",
        );
    } catch {}
  }
  private async recoverBlockedRetry(
    snapshot: DurableSubprocessRecord,
  ): Promise<GenericProcessResult> {
    const owned = this.takeRecoveryOwnership(snapshot);
    if (!owned) return resultFromRecord(snapshot);
    try {
      await this.reconcileRecord(owned);
    } catch (error) {
      await this.classifyReconciliationFailure(owned, error);
    }
    return resultFromRecord(this.current(snapshot.invocationId));
  }
  private takeRecoveryOwnership(
    snapshot: DurableSubprocessRecord,
  ): DurableSubprocessRecord | undefined {
    let record = this.current(snapshot.invocationId);
    if (record.pendingEffect) return undefined;
    const leaseIsLive =
      Date.parse(record.leaseExpiresAt) > this.options.clock.now().getTime();
    if (leaseIsLive && record.ownerId !== this.ownerId) return undefined;
    if (leaseIsLive) {
      this.fences.set(record.invocationId, record.fencingToken);
      record = this.applyCurrent(record, (revision) => ({
        type: "renew_lease",
        invocationId: record.invocationId,
        expectedRevision: revision,
        at: this.now(),
        leaseExpiresAt: this.leaseExpiry(),
      }));
    } else {
      record = this.writer.apply({
        type: "takeover_lease",
        invocationId: record.invocationId,
        expectedRevision: record.revision,
        ownerId: this.ownerId,
        fencingToken: record.fencingToken + 1,
        at: this.now(),
        leaseExpiresAt: this.leaseExpiry(),
      });
    }
    this.fences.set(record.invocationId, record.fencingToken);
    return record;
  }
  private requestStopLatest(
    invocationId: string,
    reason: "cancelled" | "timed_out",
  ): DurableSubprocessRecord {
    const record = this.current(invocationId);
    if (record.stopIntent) return record;
    return this.applyCurrent(record, (revision) => ({
      type: "request_stop",
      invocationId,
      expectedRevision: revision,
      at: this.now(),
      reason,
    }));
  }
  private applyCurrent(
    record: DurableSubprocessRecord,
    make: (revision: number) => DurableProcessCommand,
  ): DurableSubprocessRecord {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return this.mutate(make(record.revision));
      } catch (error) {
        if (
          !/revision conflict/i.test(
            error instanceof Error ? error.message : "",
          ) ||
          attempt === 2
        )
          throw error;
        record = this.current(record.invocationId);
      }
    }
    throw new Error("unreachable");
  }
  private mutate(command: DurableProcessCommand): DurableSubprocessRecord {
    const fencingToken = this.fences.get(command.invocationId);
    if (fencingToken === undefined)
      throw new Error("Process owner fencing authority is unavailable.");
    return this.writer.apply({
      ...command,
      ownerId: this.ownerId,
      fencingToken,
    });
  }
  private applyFailure(
    record: DurableSubprocessRecord,
    state:
      | "orphaned"
      | "identity_mismatch"
      | "backend_unavailable"
      | "outcome_unknown"
      | "cleanup_blocked",
    detail: string,
    cleanup?: ProcessCleanupStatus,
  ): DurableSubprocessRecord {
    record = this.current(record.invocationId);
    const result =
      state === "cleanup_blocked"
        ? terminalResult(record, this.now(), "cleanup_failed")
        : undefined;
    return this.mutate({
      type: "fail",
      invocationId: record.invocationId,
      expectedRevision: record.revision,
      at: this.now(),
      state,
      detail,
      ...(cleanup ? { cleanup } : {}),
      ...(result ? { result } : {}),
    });
  }
  private async cleanupOutput(
    record: DurableSubprocessRecord,
    output: ProcessOutputSession,
  ): Promise<void> {
    await this.fencedEffect(record.invocationId, (fence) =>
      output.cleanup(fence),
    );
  }
  private async failBeforeLaunch(
    record: DurableSubprocessRecord,
    output: ProcessOutputSession,
    detail: string,
  ): Promise<void> {
    try {
      await this.cleanupOutput(record, output);
    } catch {
      this.blockPrelaunchCleanup(record);
      return;
    }
    record = this.current(record.invocationId);
    this.mutate({
      type: "fail_launch",
      invocationId: record.invocationId,
      expectedRevision: record.revision,
      at: this.now(),
      detail,
    });
  }
  private blockPrelaunchCleanup(
    record: DurableSubprocessRecord,
  ): DurableSubprocessRecord {
    record = this.current(record.invocationId);
    const at = this.now();
    return this.mutate({
      type: "fail",
      invocationId: record.invocationId,
      expectedRevision: record.revision,
      at,
      state: "cleanup_blocked",
      detail: "Recoverable output owner cleanup failed.",
      cleanup: {
        state: "failed",
        failedAt: at,
        code: "output_cleanup_failed",
        detail: "Recoverable output owner cleanup failed.",
      },
      result: { outcome: "launch_failed", finishedAt: at },
    });
  }
  private current(id: string): DurableSubprocessRecord {
    const record = this.options.store.readByInvocation(id);
    if (!record) throw new Error(`Unknown process invocation ${id}.`);
    return record;
  }
  private async observeExisting(
    invocationId: string,
  ): Promise<GenericProcessResult> {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const record = this.options.store.readByInvocation(invocationId);
      if (!record)
        throw new SubprocessRuntimeError(
          "outcome_unknown",
          "Durable invocation disappeared.",
        );
      if (record.result) return resultFromRecord(record);
      if (
        ![
          "prepared",
          "launching",
          "running",
          "stopping",
          "exited",
          "verifying_empty",
          "backend_unavailable",
        ].includes(record.state)
      )
        throw new SubprocessRuntimeError(
          "outcome_unknown",
          `Durable invocation ended in ${record.state}.`,
        );
      await this.options.clock.sleep(1);
    }
    throw new SubprocessRuntimeError(
      "outcome_unknown",
      "Timed out observing the existing durable invocation.",
    );
  }
  private now(): string {
    return this.options.clock.now().toISOString();
  }
  private leaseExpiry(): string {
    return new Date(
      this.options.clock.now().getTime() + this.leaseMs,
    ).toISOString();
  }
  private renew(record: DurableSubprocessRecord): DurableSubprocessRecord {
    return this.mutate({
      type: "renew_lease",
      invocationId: record.invocationId,
      expectedRevision: record.revision,
      at: this.now(),
      leaseExpiresAt: this.leaseExpiry(),
    });
  }
  private fence(invocationId: string): ProcessEffectFence {
    const fencingToken = this.fences.get(invocationId);
    if (fencingToken === undefined)
      throw new Error("Process owner fencing authority is unavailable.");
    return Object.freeze({ ownerId: this.ownerId, fencingToken });
  }
  private assertFence(invocationId: string, fence: ProcessEffectFence): void {
    const record = this.current(invocationId);
    if (
      record.ownerId !== fence.ownerId ||
      record.fencingToken !== fence.fencingToken ||
      this.fences.get(invocationId) !== fence.fencingToken
    )
      throw new Error("Process owner fencing token is stale.");
  }
  private async fencedEffect<T>(
    invocationId: string,
    effect: (fence: ProcessEffectFence) => Promise<T>,
    durable?: {
      readonly family: string;
      readonly resolution: "settle" | "commit";
    },
  ): Promise<T> {
    const fence = this.fence(invocationId);
    this.assertFence(invocationId, fence);
    const effectId = durable ? safeOwnerId(`effect-${randomUUID()}`) : undefined;
    if (durable && effectId) {
      const current = this.current(invocationId);
      this.mutate({
        type: "begin_effect",
        invocationId,
        expectedRevision: current.revision,
        at: this.now(),
        effectId,
        family: durable.family,
        resolution: durable.resolution,
      });
    }
    const heartbeat = this.startHeartbeat(invocationId, fence);
    let result: T | undefined;
    let failure: unknown;
    try {
      result = await effect(fence);
    } catch (error) {
      failure = error;
    }
    const heartbeatFailure = await heartbeat.stop();
    if (durable && effectId) {
      const current = this.current(invocationId);
      this.mutate({
        type: durable.resolution === "commit" ? "complete_effect" : "settle_effect",
        invocationId,
        expectedRevision: current.revision,
        at: this.now(),
        effectId,
        leaseExpiresAt: this.leaseExpiry(),
      });
    }
    this.assertFence(invocationId, fence);
    if (heartbeatFailure && !durable) throw heartbeatFailure;
    if (failure) throw failure;
    return result as T;
  }
  private startHeartbeat(
    invocationId: string,
    fence: ProcessEffectFence,
  ): { stop(): Promise<unknown> } {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = Promise.resolve();
    let failure: unknown;
    const schedule = () => {
      if (stopped || failure) return;
      timer = setTimeout(() => {
        pending = Promise.resolve()
          .then(() => {
            this.assertFence(invocationId, fence);
            const current = this.current(invocationId);
            this.renew(current);
          })
          .catch((error) => {
            failure = error;
          })
          .finally(schedule);
      }, this.heartbeatMs);
      timer.unref?.();
    };
    schedule();
    return {
      stop: async () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        await pending;
        return failure;
      },
    };
  }
  private stopTrigger(request: SnapshotInvocation): Promise<StopTrigger> {
    const candidates: Promise<StopTrigger>[] = [];
    if (request.signal) {
      if (request.signal.aborted)
        candidates.push(Promise.resolve({ reason: "cancelled" }));
      else
        candidates.push(
          new Promise((resolve) =>
            request.signal!.addEventListener(
              "abort",
              () => resolve({ reason: "cancelled" }),
              { once: true },
            ),
          ),
        );
    }
    if (request.deadline) {
      const delay = Math.max(
        0,
        request.deadline.getTime() - this.options.clock.now().getTime(),
      );
      candidates.push(
        this.options.clock.sleep(delay).then(() => ({ reason: "timed_out" })),
      );
    }
    return candidates.length
      ? Promise.race(candidates)
      : new Promise(() => undefined);
  }
}

export function createSubprocessRuntimeKernel(
  options: SubprocessRuntimeKernelOptions,
): SubprocessRuntimeKernel {
  const safeOptions = strictRecord(
    options,
    "runtime kernel options",
  ) as unknown as SubprocessRuntimeKernelOptions;
  assertKeys(
    safeOptions as unknown as Record<string, unknown>,
    new Set([
      "registry",
      "state",
      "stateKey",
      "clock",
      "environments",
      "outputs",
      "createLogicalProcessId",
      "escalationGraceMs",
      "leaseDurationMs",
      "leaseHeartbeatMs",
    ]),
    "runtime kernel options",
  );
  options = safeOptions;
  const registry = assertProcessBackendRegistryAuthority(options.registry);
  const stateKey = new Uint8Array(options.stateKey);
  const stateObject = strictRecord(options.state, "runtime state");
  assertKeys(stateObject, new Set(["kind", "path"]), "runtime state");
  if (stateObject.kind !== "memory" && stateObject.kind !== "sqlite")
    throw new Error("Runtime state is invalid.");
  if (stateObject.kind === "memory" && stateObject.path !== undefined)
    throw new Error("Runtime state is invalid.");
  if (stateObject.kind === "sqlite" && typeof stateObject.path !== "string")
    throw new Error("Runtime state is invalid.");
  const storeKernel =
    stateObject.kind === "memory"
      ? createInMemoryDurableProcessKernel(stateKey)
      : openSqliteDurableProcessKernel(stateObject.path as string, stateKey);
  const writer = runtimeWriterFromOwnedKernel(storeKernel);
  void writer;
  if (
    !(options.stateKey instanceof Uint8Array) ||
    options.stateKey.byteLength < 32
  )
    throw new Error("Runner state key is invalid.");
  const grants = new GrantVault(stateKey);
  const leaseDurationMs = positiveInteger(
    options.leaseDurationMs ?? 300_000,
    "leaseDurationMs",
  );
  const leaseHeartbeatMs = positiveInteger(
    options.leaseHeartbeatMs ?? Math.max(1, Math.floor(leaseDurationMs / 3)),
    "leaseHeartbeatMs",
  );
  if (leaseHeartbeatMs >= leaseDurationMs)
    throw new Error("Lease heartbeat must be shorter than the lease duration.");
  const clock = Object.freeze({
    now: options.clock.now.bind(options.clock),
    sleep: options.clock.sleep.bind(options.clock),
  });
  const environments = Object.freeze({
    prepare: options.environments.prepare.bind(options.environments),
    withChildEnvironment: options.environments.withChildEnvironment.bind(
      options.environments,
    ),
  });
  const outputs = Object.freeze({
    prepare: options.outputs.prepare.bind(options.outputs),
    reopen: options.outputs.reopen.bind(options.outputs),
  });
  const internal: InternalRuntimeOptions = Object.freeze({
    registry,
    writer,
    store: storeKernel.store,
    stateKey: new Uint8Array(options.stateKey),
    grants,
    clock,
    environments,
    outputs,
    leaseDurationMs,
    leaseHeartbeatMs,
    ...(options.createLogicalProcessId
      ? { createLogicalProcessId: options.createLogicalProcessId }
      : {}),
    ...(options.escalationGraceMs
      ? {
          escalationGraceMs: Object.freeze([
            ...options.escalationGraceMs,
          ]) as readonly [number, number],
        }
      : {}),
  });
  const core = new RunnerSubprocessRuntime(internal);
  const runtimeObject = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(runtimeObject, {
    invoke: {
      value: core.invoke.bind(core),
      enumerable: true,
      writable: false,
      configurable: false,
    },
    cancel: {
      value: core.cancel.bind(core),
      enumerable: true,
      writable: false,
      configurable: false,
    },
    reconcileStartup: {
      value: core.reconcileStartup.bind(core),
      enumerable: true,
      writable: false,
      configurable: false,
    },
  });
  const runtime = Object.freeze(runtimeObject) as unknown as SubprocessRuntime;
  const grantsController = Object.freeze({
    issue: (value: unknown) => grants.issue(value),
    revoke: (id: string) => grants.revoke(id),
  });
  return Object.freeze({
    runtime,
    grantsController,
    readOnlyStore: storeKernel.store,
  });
}

function snapshotInvocation(value: unknown): SnapshotInvocation {
  const o = strictRecord(value, "invocation");
  assertKeys(
    o,
    new Set([
      "intent",
      "grantId",
      "ambientEnvironment",
      "explicitEnvironment",
      "credentialGrantId",
      "signal",
      "deadline",
    ]),
    "invocation",
  );
  const intentObject = strictRecord(o.intent, "intent");
  const intent = deepFreeze(
    parseExecutionInvocationIntent({
      ...intentObject,
      arguments: snapshotStrings(intentObject.arguments, "arguments"),
      requestedCapabilities: snapshotStrings(
        intentObject.requestedCapabilities,
        "requestedCapabilities",
      ),
    }),
  );
  const grantId = safeText(o.grantId, "grantId");
  const ambientEnvironment = snapshotEnvironment(o.ambientEnvironment);
  const explicitEnvironment =
    o.explicitEnvironment === undefined
      ? undefined
      : snapshotEnvironment(o.explicitEnvironment);
  const credentialGrantId =
    o.credentialGrantId === undefined
      ? undefined
      : safeText(o.credentialGrantId, "credentialGrantId");
  const signal = o.signal === undefined ? undefined : o.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new Error("Invocation signal is invalid.");
  const deadline = o.deadline === undefined ? undefined : o.deadline;
  if (
    deadline !== undefined &&
    (!(deadline instanceof Date) || Number.isNaN(deadline.getTime()))
  )
    throw new Error("Invocation deadline is invalid.");
  return Object.freeze({
    intent,
    grantId,
    ambientEnvironment,
    ...(explicitEnvironment ? { explicitEnvironment } : {}),
    ...(credentialGrantId ? { credentialGrantId } : {}),
    ...(signal ? { signal } : {}),
    ...(deadline ? { deadline: new Date(deadline) } : {}),
  });
}
function consumeGrant(
  authority: GrantVault,
  id: string,
  intent: ExecutionInvocationIntent,
  now: Date,
): ConsumedExecutionGrant {
  let raw: unknown;
  try {
    raw = authority.consume(id);
  } catch {
    throw new Error("Execution grant is invalid.");
  }
  try {
    const grant = parseGrant(raw);
    if (
      grant.grantId !== id ||
      grant.runId !== intent.runId ||
      grant.invocationId !== intent.invocationId ||
      Date.parse(grant.issuedAt) > now.getTime() ||
      (grant.expiresAt && Date.parse(grant.expiresAt) <= now.getTime())
    )
      throw new Error();
    return grant;
  } catch {
    throw new Error("Execution grant is invalid.");
  }
}
function parseGrant(raw: unknown): ConsumedExecutionGrant {
  const o = strictRecord(raw, "execution grant");
  assertKeys(
    o,
    new Set([
      "grantId",
      "runId",
      "invocationId",
      "issuedAt",
      "expiresAt",
      "access",
    ]),
    "execution grant",
  );
  const access = parseAccess(o.access);
  const grant: ConsumedExecutionGrant = {
    grantId: safeText(o.grantId, "grantId"),
    runId: safeText(o.runId, "runId"),
    invocationId: safeText(o.invocationId, "invocationId"),
    issuedAt: dateText(o.issuedAt, "issuedAt"),
    ...(o.expiresAt === undefined
      ? {}
      : { expiresAt: dateText(o.expiresAt, "expiresAt") }),
    access,
  };
  return deepFreeze(grant);
}
function parseAccess(value: unknown): ExactPathAccess[] {
  if (!Array.isArray(value)) throw new Error();
  return value.map((entry) => {
    const o = strictRecord(entry, "access");
    assertKeys(o, new Set(["canonicalPath", "mode"]), "access");
    const mode = o.mode;
    if (mode !== "read" && mode !== "write" && mode !== "create")
      throw new Error();
    return Object.freeze({
      canonicalPath: safeText(o.canonicalPath, "canonicalPath"),
      mode,
    });
  });
}
function outputDisposition(
  result: BoundedOutputSpoolResult,
): ProcessOutputDisposition[] {
  const root = strictRecord(result, "output result");
  assertKeys(root, new Set(["streams"]), "output result");
  if (!Array.isArray(root.streams) || root.streams.length !== 2)
    throw new Error("Output result is invalid.");
  return root.streams.map((stream) => {
    const plain = strictRecord(stream, "output stream");
    assertKeys(
      plain,
      new Set([
        "stream",
        "tail",
        "tailBytesBase64",
        "tailByteLength",
        "tailDisplayTruncated",
        "totalBytes",
        "truncated",
        "spillBytes",
        "lossyBytes",
        "lossyOutput",
        "lossReason",
        "lossReasons",
        "spillState",
        "spillArtifactId",
      ]),
      "output stream",
    );
    if (
      (plain.stream !== "stdout" && plain.stream !== "stderr") ||
      typeof plain.tail !== "string" ||
      !nonNegative(plain.totalBytes) ||
      typeof plain.truncated !== "boolean" ||
      !nonNegative(plain.spillBytes) ||
      !nonNegative(plain.lossyBytes) ||
      typeof plain.lossyOutput !== "boolean" ||
      !Array.isArray(plain.lossReasons) ||
      typeof plain.spillState !== "string"
    )
      throw new Error("Output result is invalid.");
    return parseProcessOutputDisposition({
      stream: plain.stream,
      tail: plain.tail,
      totalBytes: plain.totalBytes,
      truncated: plain.truncated,
      ...(plain.spillArtifactId === undefined
        ? {}
        : { spillArtifactId: plain.spillArtifactId }),
      spillBytes: plain.spillBytes,
      lossyBytes: plain.lossyBytes,
    });
  });
}
function terminalResult(
  record: DurableSubprocessRecord,
  finishedAt: string,
  forced?: DurableSubprocessResult["outcome"],
): DurableSubprocessResult {
  const outcome = record.stopIntent?.reason ?? forced ?? "exited";
  return {
    outcome,
    ...(record.observation?.exitCode === undefined
      ? {}
      : { exitCode: record.observation.exitCode }),
    ...(record.observation?.signal
      ? { signal: record.observation.signal }
      : {}),
    ...(record.backendBinding
      ? { startedAt: record.backendBinding.startedAt }
      : {}),
    finishedAt,
  };
}
function resultFromFailure(
  record: DurableSubprocessRecord,
): GenericProcessResult {
  if (!record.result)
    throw new SubprocessRuntimeError(
      "outcome_unknown",
      `Durable invocation ended in ${record.state} without a result.`,
    );
  return {
    logicalProcessId: record.logicalProcessId,
    ...record.result,
    output: record.output ?? [],
    cleanup: record.cleanup,
  };
}
function resultFromRecord(
  record: DurableSubprocessRecord,
): GenericProcessResult {
  if (!record.result)
    throw new SubprocessRuntimeError(
      "outcome_unknown",
      "Durable process result is unavailable.",
    );
  return {
    logicalProcessId: record.logicalProcessId,
    ...record.result,
    output: record.output ?? [],
    cleanup: record.cleanup,
  };
}
function requiredBinding(
  record: DurableSubprocessRecord,
): ProcessBackendBinding {
  if (!record.backendBinding)
    throw new SubprocessRuntimeError(
      "identity_mismatch",
      "Durable backend identity is missing.",
    );
  return record.backendBinding;
}
function recoverableLaunchBlocker(error: unknown): {
  readonly launch: ReturnType<typeof parseProcessLaunchResult>;
  readonly detail: string;
} | undefined {
  if (typeof error !== "object" || error === null || nodeTypes.isProxy(error)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(error);
  const code = descriptors.code;
  const launchResult = descriptors.launchResult;
  const message = descriptors.message;
  if (
    !code || !("value" in code) || code.value !== "native_process_launch_cleanup_blocked" ||
    !launchResult || !("value" in launchResult)
  ) return undefined;
  const launch = parseProcessLaunchResult(launchResult.value);
  const detail = message && "value" in message && typeof message.value === "string" && message.value.trim()
    ? message.value
    : "Native process launch cleanup is blocked.";
  return { launch, detail };
}
function strictRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    throw new Error(`${label} is invalid.`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new Error(`${label} is invalid.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !("value" in descriptors[key]!))
      throw new Error(`${label} is invalid.`);
    result[key] = descriptors[key]!.value;
  }
  return result;
}
function assertKeys(
  object: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  const unknown = Object.keys(object).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Unknown ${label} field ${unknown}.`);
}
function snapshotStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new Error(`${label} is invalid.`);
  return Object.freeze([...value]) as unknown as string[];
}
function snapshotEnvironment(
  value: unknown,
): Readonly<Record<string, string | undefined>> {
  const o = strictRecord(value, "environment");
  const result = Object.create(null) as Record<string, string | undefined>;
  for (const [key, entry] of Object.entries(o)) {
    if (typeof entry !== "string" && entry !== undefined)
      throw new Error("Environment is invalid.");
    result[key] = entry as string | undefined;
  }
  return Object.freeze(result);
}
function snapshotChildEnvironment(
  value: unknown,
): Readonly<Record<string, string>> {
  const snapshot = snapshotEnvironment(value);
  for (const entry of Object.values(snapshot))
    if (entry === undefined) throw new Error("Child environment is invalid.");
  return snapshot as Readonly<Record<string, string>>;
}
function safeText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} is invalid.`);
  return value;
}
function dateText(value: unknown, label: string): string {
  const text = safeText(value, label);
  if (Number.isNaN(Date.parse(text))) throw new Error(`${label} is invalid.`);
  return text;
}
function safeOwnerId(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(value))
    throw new Error("Output owner id is invalid.");
  return value;
}
function nonNegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new Error(`${label} is invalid.`);
  return value as number;
}
function digestText(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("Digest is invalid.");
  return value;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((key) => o[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(o[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function runtimeWriterFromOwnedKernel(
  kernel: DurableProcessStoreKernel,
): DurableProcessRuntimeWriter {
  for (const key of Object.getOwnPropertySymbols(kernel)) {
    const value = Object.getOwnPropertyDescriptor(kernel, key)?.value as
      Partial<DurableProcessRuntimeWriter> | undefined;
    if (
      value &&
      typeof value.claim === "function" &&
      typeof value.apply === "function"
    )
      return value as DurableProcessRuntimeWriter;
  }
  throw new Error("Durable process kernel authority is invalid.");
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
  }
  return value;
}
