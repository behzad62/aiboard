import { randomUUID } from "node:crypto";

import type { BoundedOutputSpool, BoundedOutputSpoolResult } from "./bounded-output-spool.js";
import type { ChildEnvironmentFactory } from "./child-environment.js";
import {
  parseExecutionInvocationIntent,
  type ExecutionInvocationIntent,
  type GenericProcessResult,
  type OpaqueOneCallExecutionGrant,
  type ProcessCleanupStatus,
  type ProcessOutputDisposition,
} from "./execution-safety-contracts.js";
import type { DurableProcessStore, DurableSubprocessRecord } from "./durable-process-store.js";
import { selectProcessBackend, type ProcessBackend, type ProcessBackendBinding } from "./process-backend.js";

export type SubprocessRuntimeErrorCode = "launch_not_proven" | "orphaned" | "identity_mismatch" | "backend_unavailable" | "outcome_unknown" | "cleanup_blocked";

export class SubprocessRuntimeError extends Error {
  constructor(readonly code: SubprocessRuntimeErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.name = "SubprocessRuntimeError"; }
}

export interface SubprocessRuntimeClock { now(): string }
export interface SubprocessRuntimeOptions {
  readonly backends: readonly ProcessBackend[];
  readonly store: DurableProcessStore;
  readonly clock: SubprocessRuntimeClock;
  readonly environments: ChildEnvironmentFactory;
  readonly createSpool: (logicalProcessId: string) => BoundedOutputSpool;
  readonly createLogicalProcessId?: () => string;
}
export interface SubprocessInvocation {
  readonly intent: ExecutionInvocationIntent;
  readonly grant: OpaqueOneCallExecutionGrant;
  readonly ambientEnvironment: Readonly<Record<string, string | undefined>>;
  readonly explicitEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly credentialGrantId?: string;
  readonly stopReason?: "timed_out" | "cancelled";
}

export class SubprocessRuntime {
  private readonly createId: () => string;
  constructor(private readonly options: SubprocessRuntimeOptions) { this.createId = options.createLogicalProcessId ?? (() => `proc_${randomUUID()}`); }

  async invoke(input: SubprocessInvocation): Promise<GenericProcessResult> {
    const intent = parseExecutionInvocationIntent(input.intent);
    assertGrant(input.grant, intent.invocationId);
    const existing = this.options.store.readByInvocation(intent.invocationId);
    if (existing?.result) return resultFromRecord(existing);
    if (existing) throw new SubprocessRuntimeError("outcome_unknown", "Invocation already has incomplete durable state.");
    const preparedEnvironment = this.options.environments.prepare({ ambient: input.ambientEnvironment, explicitOverrides: input.explicitEnvironment, runId: intent.runId, invocationId: intent.invocationId, credentialGrantId: input.credentialGrantId });
    const logicalProcessId = this.createId();
    this.options.store.createPrepared({
      schemaVersion: 1, logicalProcessId, invocationId: intent.invocationId, runId: intent.runId,
      ...(intent.taskId ? { taskId: intent.taskId } : {}), ...(intent.sessionId ? { sessionId: intent.sessionId } : {}),
      state: "prepared", history: [{ state: "prepared", at: this.options.clock.now() }],
      requiredCapabilities: [...intent.requestedCapabilities],
      environmentAudit: { inheritedNames: [...preparedEnvironment.audit.inheritedNames], removedNames: [...preparedEnvironment.audit.removedNames], explicitSafeNames: [...preparedEnvironment.audit.explicitSafeNames], grantedNames: [...preparedEnvironment.audit.grantedNames] },
      output: [], cleanup: { state: "pending" },
    });
    this.options.store.transition(intent.invocationId, "launching", this.options.clock.now());
    let backend: ProcessBackend;
    try { backend = await selectProcessBackend(this.options.backends, intent.requestedCapabilities); }
    catch (error) { this.options.store.transition(intent.invocationId, "backend_unavailable", this.options.clock.now(), "No verified backend satisfies the invocation."); throw new SubprocessRuntimeError("backend_unavailable", "No verified process backend is available.", { cause: error }); }
    let launch;
    try {
      launch = await this.options.environments.withChildEnvironment(preparedEnvironment.capability, (environment) => backend.launch({ intent, grant: input.grant, environment }));
    } catch (error) {
      this.options.store.transition(intent.invocationId, "launch_not_proven", this.options.clock.now(), "Launch did not return durable identity.", { result: { outcome: "launch_failed", finishedAt: this.options.clock.now() } });
      throw new SubprocessRuntimeError("launch_not_proven", "Process launch was not proven.", { cause: error });
    }
    if (launch.backend.backendId !== backend.backendId || !launch.backend.opaqueIdentity.trim() || !launch.birthFingerprint.discriminator.trim()) {
      this.options.store.transition(intent.invocationId, "identity_mismatch", this.options.clock.now(), "Backend returned invalid launch identity.");
      throw new SubprocessRuntimeError("identity_mismatch", "Process launch identity is invalid.");
    }
    this.options.store.bindLaunch(intent.invocationId, launch, this.options.clock.now());
    const spool = this.options.createSpool(logicalProcessId);
    if (input.stopReason) {
      this.options.store.transition(intent.invocationId, "stopping", this.options.clock.now(), input.stopReason);
      await this.signalBound(backend, launch, intent.invocationId);
    }
    let observed;
    try { observed = await backend.observe(launch, (stream, bytes) => spool.write(stream, bytes)); }
    catch (error) { await spool.cleanup().catch(() => undefined); this.options.store.transition(intent.invocationId, "backend_unavailable", this.options.clock.now(), "Backend disappeared during observation."); throw new SubprocessRuntimeError("backend_unavailable", "Process backend disappeared.", { cause: error }); }
    this.options.store.transition(intent.invocationId, "exited", this.options.clock.now());
    const output = outputDisposition(await spool.finalize());
    this.options.store.transition(intent.invocationId, "verifying_empty", this.options.clock.now(), undefined, { output });
    let verification;
    try { verification = await backend.verifyEmpty(launch); }
    catch (error) { this.options.store.transition(intent.invocationId, "backend_unavailable", this.options.clock.now(), "Backend disappeared during empty verification.", { output }); throw new SubprocessRuntimeError("backend_unavailable", "Process backend disappeared.", { cause: error }); }
    const finishedAt = this.options.clock.now();
    if (!verification.empty) {
      const cleanup: ProcessCleanupStatus = { state: "failed", failedAt: finishedAt, code: "verified_empty_failed", detail: verification.detail };
      const outcome = input.stopReason ?? "cleanup_failed";
      const result = { outcome, exitCode: observed.exitCode, ...(observed.signal ? { signal: observed.signal } : {}), startedAt: launch.startedAt, finishedAt } as const;
      const record = this.options.store.transition(intent.invocationId, "cleanup_blocked", finishedAt, verification.detail, { output, cleanup, result });
      return resultFromRecord(record);
    }
    const cleanup: ProcessCleanupStatus = { state: "verified_empty", verifiedAt: finishedAt, ...(verification.proofArtifactId ? { proofArtifactId: verification.proofArtifactId } : {}) };
    const result = { outcome: input.stopReason ?? "exited", exitCode: observed.exitCode, ...(observed.signal ? { signal: observed.signal } : {}), startedAt: launch.startedAt, finishedAt } as const;
    try { await backend.release(launch); }
    catch {
      const failedCleanup: ProcessCleanupStatus = { state: "failed", failedAt: finishedAt, code: "backend_release_failed", detail: "Verified-empty backend resources could not be released." };
      const failedResult = { ...result, outcome: input.stopReason ?? "cleanup_failed" } as const;
      const blocked = this.options.store.transition(intent.invocationId, "cleanup_blocked", finishedAt, "Backend release failed after verified emptiness.", { output, cleanup: failedCleanup, result: failedResult });
      return resultFromRecord(blocked);
    }
    const record = this.options.store.transition(intent.invocationId, "cleaned", finishedAt, undefined, { output, cleanup, result });
    return resultFromRecord(record);
  }

  async cancel(invocationId: string, evidence: { readonly observedBirthDiscriminator?: string } = {}): Promise<void> {
    const record = this.options.store.readByInvocation(invocationId);
    const binding = bindingFromRecord(record);
    if (!binding || (evidence.observedBirthDiscriminator !== undefined && evidence.observedBirthDiscriminator !== binding.birthFingerprint.discriminator)) {
      if (record && ["launching", "running", "stopping"].includes(record.state)) this.options.store.transition(invocationId, "identity_mismatch", this.options.clock.now(), "Opaque identity or birth fingerprint mismatch.");
      throw new SubprocessRuntimeError("identity_mismatch", "Opaque identity and matching birth fingerprint are required; PID alone is insufficient.");
    }
    const backend = this.options.backends.find((candidate) => candidate.backendId === binding.backend.backendId);
    if (!backend) throw new SubprocessRuntimeError("backend_unavailable", "Bound process backend is unavailable.");
    if (record?.state === "running") this.options.store.transition(invocationId, "stopping", this.options.clock.now(), "cancelled");
    await this.signalBound(backend, binding, invocationId);
  }

  async reconcileStartup(): Promise<void> {
    for (const record of this.options.store.listRecoverable()) await this.reconcileRecord(record);
  }

  private async reconcileRecord(record: DurableSubprocessRecord): Promise<void> {
    if (record.state === "prepared") { this.options.store.transition(record.invocationId, "launch_not_proven", this.options.clock.now(), "Restart found pre-launch intent."); return; }
    const binding = bindingFromRecord(record);
    if (!binding) {
      if (record.state !== "backend_unavailable") this.options.store.transition(record.invocationId, record.state === "launching" ? "orphaned" : "identity_mismatch", this.options.clock.now(), "Restart found no identity-bound process.");
      return;
    }
    const backend = this.options.backends.find((candidate) => candidate.backendId === binding.backend.backendId);
    if (!backend) {
      if (record.state !== "backend_unavailable") this.options.store.transition(record.invocationId, "backend_unavailable", this.options.clock.now());
      return;
    }
    let reconciliation;
    try { reconciliation = await backend.reconcile(binding); }
    catch (error) {
      if (record.state !== "backend_unavailable") this.options.store.transition(record.invocationId, "backend_unavailable", this.options.clock.now());
      throw new SubprocessRuntimeError("backend_unavailable", "Process backend disappeared during reconciliation.", { cause: error });
    }
    if (reconciliation.state === "running") {
      if (record.state === "backend_unavailable") this.options.store.transition(record.invocationId, "running", this.options.clock.now(), "Backend reconciliation observed the bound process.");
      return;
    }
    if (reconciliation.state === "identity_mismatch" || reconciliation.state === "outcome_unknown") { this.options.store.transition(record.invocationId, reconciliation.state, this.options.clock.now()); return; }
    if (record.state === "running" || record.state === "stopping" || record.state === "backend_unavailable") this.options.store.transition(record.invocationId, "exited", this.options.clock.now(), "Restart observed exit.");
    if (record.state === "exited" || record.state === "running" || record.state === "stopping" || record.state === "backend_unavailable") this.options.store.transition(record.invocationId, "verifying_empty", this.options.clock.now());
    const verification = await backend.verifyEmpty(binding);
    const finishedAt = this.options.clock.now();
    if (!verification.empty) { this.options.store.transition(record.invocationId, "cleanup_blocked", finishedAt, verification.detail, { cleanup: { state: "failed", failedAt: finishedAt, code: "verified_empty_failed", detail: verification.detail } }); return; }
    try { await backend.release(binding); }
    catch {
      this.options.store.transition(record.invocationId, "cleanup_blocked", finishedAt, "Backend release failed after restart verification.", { cleanup: { state: "failed", failedAt: finishedAt, code: "backend_release_failed", detail: "Verified-empty backend resources could not be released." }, result: { outcome: "cleanup_failed", exitCode: reconciliation.exitCode, ...(reconciliation.signal ? { signal: reconciliation.signal } : {}), finishedAt } });
      return;
    }
    this.options.store.transition(record.invocationId, "cleaned", finishedAt, "Restart reconciliation verified empty.", { cleanup: { state: "verified_empty", verifiedAt: finishedAt, ...(verification.proofArtifactId ? { proofArtifactId: verification.proofArtifactId } : {}) }, result: { outcome: "exited", exitCode: reconciliation.exitCode, ...(reconciliation.signal ? { signal: reconciliation.signal } : {}), finishedAt } });
  }

  private async signalBound(backend: ProcessBackend, binding: ProcessBackendBinding, invocationId: string): Promise<void> {
    if (!binding.backend.opaqueIdentity.trim() || !binding.birthFingerprint.discriminator.trim()) throw new SubprocessRuntimeError("identity_mismatch", "PID alone cannot authorize a signal.");
    try { await backend.signal(binding, "terminate"); }
    catch (error) { this.options.store.transition(invocationId, "backend_unavailable", this.options.clock.now(), "Backend disappeared during signal."); throw new SubprocessRuntimeError("backend_unavailable", "Process backend disappeared.", { cause: error }); }
  }
}

function assertGrant(grant: OpaqueOneCallExecutionGrant, invocationId: string): void { if (!grant || grant.state !== "issued" || grant.invocationId !== invocationId) throw new Error("Execution grant is invalid for this invocation."); }
function bindingFromRecord(record: DurableSubprocessRecord | undefined): ProcessBackendBinding | undefined { return record?.backend && record.birthFingerprint ? { backend: record.backend, birthFingerprint: record.birthFingerprint, ...(record.rootPid ? { rootPid: record.rootPid } : {}) } : undefined; }
function outputDisposition(result: BoundedOutputSpoolResult): ProcessOutputDisposition[] { return result.streams.map((stream) => ({ stream: stream.stream, tail: stream.tail, totalBytes: stream.totalBytes, truncated: stream.truncated, ...(stream.spillArtifactId ? { spillArtifactId: stream.spillArtifactId } : {}), spillBytes: stream.spillBytes, lossyBytes: stream.lossyBytes })); }
function resultFromRecord(record: DurableSubprocessRecord): GenericProcessResult { if (!record.result) throw new SubprocessRuntimeError("outcome_unknown", "Durable process result is unavailable."); return { logicalProcessId: record.logicalProcessId, ...record.result, output: [...record.output], cleanup: record.cleanup }; }
