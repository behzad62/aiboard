import { NativeOwnedProcessBackend } from "./native-process-backend.js";
import type { NativeProcessOperations } from "./native-process-backend.js";
import { createHash } from "node:crypto";

import type { ProcessBackend, ProcessBackendBinding, ProcessEffectFence, ProcessLaunchRequest } from "./process-backend.js";
import type { ProcessEscalationAction, ProcessOutputStream } from "./execution-safety-contracts.js";
import type { ManagedProcessService } from "./managed-process.js";

export interface WindowsProcessBackendOptions {
  readonly stateDirectory?: string;
  readonly pollIntervalMs?: number;
  readonly operations?: NativeProcessOperations;
  /** A caller may supply the existing authenticated Job supervisor as an optional enhancement. */
  readonly jobObjects?: "unavailable" | { readonly service: ManagedProcessService };
}
export type WindowsJobProcessService = Pick<
  ManagedProcessService,
  "start" | "signal" | "reconcileOwnership" | "readOutputSince" | "probeJobObjectAvailability"
>;

export class WindowsProcessBackend extends NativeOwnedProcessBackend {
  constructor(options: WindowsProcessBackendOptions = {}) {
    super({
      stateDirectory: options.stateDirectory,
      pollIntervalMs: options.pollIntervalMs,
      operations: options.operations,
      platform: "windows",
      backendId: "runner-windows-supervisor-v1",
      capabilities: {
        tree_termination: "partial",
        crash_cleanup: "unavailable",
        verified_emptiness: "partial",
        write_confinement: "unavailable",
      },
    });
  }
}

export function createWindowsProcessBackend(options: WindowsProcessBackendOptions = {}): ProcessBackend {
  return options.jobObjects && options.jobObjects !== "unavailable"
    ? new WindowsJobObjectProcessBackend(options.jobObjects.service)
    : new WindowsProcessBackend(options);
}

/** Adapts the existing authenticated Windows Job supervisor to the durable SPI. */
export class WindowsJobObjectProcessBackend implements ProcessBackend {
  private readonly offsets = new Map<string, { stdout: number; stderr: number }>();
  constructor(private readonly service: WindowsJobProcessService) {}
  async probe(): Promise<unknown> {
    if (!(await this.service.probeJobObjectAvailability()))
      throw new Error("Authenticated Windows Job Object enhancement is unavailable.");
    return {
      attestationVersion: 1,
      backendId: "runner-windows-job-v1",
      verified: true,
      platformLabel: "windows",
      capabilities: {
        tree_termination: "enforced",
        crash_cleanup: "enforced",
        verified_emptiness: "enforced",
        write_confinement: "unavailable",
      },
    };
  }
  async launch(request: ProcessLaunchRequest): Promise<unknown> {
    const sessionId = request.intent.sessionId ?? request.intent.invocationId;
    const snapshot = await this.service.start({
      command: request.intent.executable,
      args: [...request.intent.arguments],
      cwd: ".",
      env: { ...request.environment },
    }, {
      runId: request.intent.runId,
      sessionId,
      actor: { role: "worker", id: sessionId },
    }, request.intent.workingDirectory);
    const identity = { processId: snapshot.processId, runId: request.intent.runId, sessionId, startedAt: snapshot.startedAt };
    return {
      opaqueIdentity: Buffer.from(JSON.stringify(identity)).toString("base64url"),
      birthFingerprint: {
        observedAt: snapshot.startedAt,
        discriminator: createHash("sha256").update(`${snapshot.processId}\0${snapshot.startedAt}`).digest("hex"),
      },
      rootPid: snapshot.pid,
      startedAt: snapshot.startedAt,
    };
  }
  async observe(binding: ProcessBackendBinding, output: (stream: ProcessOutputStream, bytes: Uint8Array) => Promise<void>, _fence: ProcessEffectFence): Promise<unknown> {
    const identity = jobIdentity(binding);
    for (;;) {
      const offsets = this.offsets.get(identity.processId) ?? { stdout: 0, stderr: 0 };
      const unread = this.service.readOutputSince(identity.processId, jobContext(identity), offsets);
      for (const stream of ["stdout", "stderr"] as const) {
        if (unread[stream].byteLength > 0) await output(stream, unread[stream]);
      }
      this.offsets.set(identity.processId, { ...unread.next });
      const snapshot = await this.service.reconcileOwnership(identity.processId, jobContext(identity));
      const deliveredOutput = unread.stdout.byteLength > 0 || unread.stderr.byteLength > 0;
      if (snapshot.status === "stopped" && !deliveredOutput)
        return { state: "exited", ...(snapshot.exitCode === null ? {} : { exitCode: snapshot.exitCode }), ...(snapshot.signal ? { signal: snapshot.signal } : {}) };
      if (snapshot.status === "exited_unknown" && snapshot.ownershipReleased)
        throw new Error("Windows Job supervisor outcome is unknown.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  async signal(binding: ProcessBackendBinding, action: ProcessEscalationAction): Promise<unknown> {
    const identity = jobIdentity(binding);
    const snapshot = await this.service.signal(identity.processId, action === "force_terminate" ? "SIGKILL" : action === "interrupt" ? "SIGINT" : "SIGTERM", jobContext(identity));
    return { state: snapshot.status === "stopped" ? "exited" : "running" };
  }
  async verifyEmpty(binding: ProcessBackendBinding): Promise<unknown> {
    const identity = jobIdentity(binding);
    const snapshot = await this.service.reconcileOwnership(identity.processId, jobContext(identity));
    return snapshot.status === "stopped" && snapshot.ownershipReleased ? { empty: true, proofArtifactId: `windows-job-empty:${identity.processId}` } : { empty: false, detail: "Windows Job Object still contains active processes." };
  }
  async reconcile(binding: ProcessBackendBinding): Promise<unknown> {
    let identity: JobIdentity;
    try { identity = jobIdentity(binding); } catch (error) {
      return { state: error instanceof JobIdentityMismatchError ? "identity_mismatch" : "outcome_unknown" };
    }
    try {
      const snapshot = await this.service.reconcileOwnership(identity.processId, jobContext(identity));
      if (snapshot.startedAt !== identity.startedAt) return { state: "identity_mismatch" };
      if (snapshot.status === "running") return { state: "running" };
      if (snapshot.status === "exited_unknown")
        return snapshot.ownershipReleased ? { state: "outcome_unknown" } : { state: "running" };
      return { state: "exited", ...(snapshot.exitCode === null ? {} : { exitCode: snapshot.exitCode }), ...(snapshot.signal ? { signal: snapshot.signal } : {}) };
    } catch { return { state: "outcome_unknown" }; }
  }
  async release(binding: ProcessBackendBinding): Promise<unknown> {
    this.offsets.delete(jobIdentity(binding).processId);
    return { released: true };
  }
}

interface JobIdentity { processId: string; runId: string; sessionId: string; startedAt: string }
class JobIdentityMismatchError extends Error {}
function jobIdentity(binding: ProcessBackendBinding): JobIdentity {
  const value = JSON.parse(Buffer.from(binding.opaqueIdentity, "base64url").toString("utf8")) as JobIdentity;
  if (!value.processId || !value.runId || !value.sessionId || !value.startedAt) throw new Error("Windows Job identity is invalid.");
  const discriminator = createHash("sha256").update(`${value.processId}\0${value.startedAt}`).digest("hex");
  if (binding.birthFingerprint.discriminator !== discriminator) throw new JobIdentityMismatchError("Windows Job birth fingerprint is invalid.");
  return value;
}
function jobContext(identity: JobIdentity) {
  return { runId: identity.runId, sessionId: identity.sessionId, actor: { role: "worker" as const, id: identity.sessionId } };
}
