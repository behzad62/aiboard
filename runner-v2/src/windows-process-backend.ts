import { NativeOwnedProcessBackend } from "./native-process-backend.js";
import type { NativeProcessOperations } from "./native-process-backend.js";
import { createHash } from "node:crypto";

import type { ProcessBackend, ProcessBackendBinding, ProcessEffectFence, ProcessLaunchRequest } from "./process-backend.js";
import type { ProcessEscalationAction, ProcessOutputStream } from "./execution-safety-contracts.js";
import type { WindowsJobProcessHost } from "./windows-job-process-host.js";

export interface WindowsProcessBackendOptions {
  readonly stateDirectory?: string;
  readonly pollIntervalMs?: number;
  readonly operations?: NativeProcessOperations;
  readonly replayCapacityChunks?: number;
  readonly replayCapacityBytes?: number;
  /** A caller may supply the existing authenticated Job supervisor as an optional enhancement. */
  readonly jobObjects?: "unavailable" | { readonly service: WindowsJobProcessHost };
}
export type WindowsJobProcessService = WindowsJobProcessHost;

export class WindowsProcessBackend extends NativeOwnedProcessBackend {
  constructor(options: WindowsProcessBackendOptions = {}) {
    super({
      stateDirectory: options.stateDirectory,
      pollIntervalMs: options.pollIntervalMs,
      operations: options.operations,
      replayCapacityChunks: options.replayCapacityChunks,
      replayCapacityBytes: options.replayCapacityBytes,
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
  private readonly controls = new Map<string, JobControlLane>();
  private readonly activations = new Map<string, Promise<JobControlLane>>();
  constructor(private readonly service: WindowsJobProcessService) {}
  async probe(): Promise<unknown> {
    if (!(await this.service.probeActiveJobCreateClose()))
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
    const snapshot = await this.service.launchOwned({
      runId: request.intent.runId,
      sessionId,
      command: request.intent.executable,
      args: [...request.intent.arguments],
      workingDirectory: request.intent.workingDirectory,
      environment: { ...request.environment },
    });
    const opaqueIdentity: JobOpaqueIdentity = { processId: snapshot.processId, runId: request.intent.runId, sessionId, startedAt: snapshot.startedAt, fence: { ...request.fence } };
    const birthDiscriminator = jobBirthDiscriminator(opaqueIdentity);
    const identity: JobIdentity = { ...opaqueIdentity, birthDiscriminator };
    this.registerLane(identity);
    return {
      opaqueIdentity: Buffer.from(JSON.stringify(opaqueIdentity)).toString("base64url"),
      birthFingerprint: {
        observedAt: snapshot.startedAt,
        discriminator: birthDiscriminator,
      },
      rootPid: snapshot.pid,
      startedAt: snapshot.startedAt,
    };
  }
  async observe(binding: ProcessBackendBinding, output: (stream: ProcessOutputStream, bytes: Uint8Array) => Promise<void>, _fence: ProcessEffectFence): Promise<unknown> {
    const identity = jobIdentity(binding);
    assertJobFence(identity, _fence);
    for (;;) {
      const { snapshot, deliveredOutput } = await this.control(identity, async () => {
        const offsets = this.offsets.get(identity.processId) ?? { stdout: 0, stderr: 0 };
        const unread = this.service.readOwnedOutput(identity.processId, jobOwner(identity), offsets);
        for (const stream of ["stdout", "stderr"] as const) {
          if (unread[stream].byteLength > 0) await output(stream, unread[stream]);
        }
        this.offsets.set(identity.processId, { ...unread.next });
        return {
          snapshot: await this.service.reconcileOwned(identity.processId, jobOwner(identity)),
          deliveredOutput: unread.stdout.byteLength > 0 || unread.stderr.byteLength > 0,
        };
      });
      if (snapshot.status === "stopped" && !deliveredOutput)
        return { state: "exited", ...(snapshot.exitCode === null ? {} : { exitCode: snapshot.exitCode }), ...(snapshot.signal ? { signal: snapshot.signal } : {}) };
      if (snapshot.status === "exited_unknown" && snapshot.ownershipReleased)
        throw new Error("Windows Job supervisor outcome is unknown.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  async signal(binding: ProcessBackendBinding, action: ProcessEscalationAction, fence?: ProcessEffectFence): Promise<unknown> {
    const identity = jobIdentity(binding);
    assertJobFence(identity, fence);
    const snapshot = await this.control(identity, async () =>
      await this.service.signalOwned(identity.processId, action === "force_terminate" ? "SIGKILL" : action === "interrupt" ? "SIGINT" : "SIGTERM", jobOwner(identity)));
    return { state: snapshot.status === "stopped" ? "exited" : "running" };
  }
  async verifyEmpty(binding: ProcessBackendBinding, fence?: ProcessEffectFence): Promise<unknown> {
    const identity = jobIdentity(binding);
    assertJobFence(identity, fence);
    const snapshot = await this.control(identity, async () =>
      await this.service.reconcileOwned(identity.processId, jobOwner(identity)));
    return snapshot.status === "stopped" && snapshot.ownershipReleased ? { empty: true, proofArtifactId: `windows-job-empty:${identity.processId}` } : { empty: false, detail: "Windows Job Object still contains active processes." };
  }
  async reconcile(binding: ProcessBackendBinding, fence?: ProcessEffectFence): Promise<unknown> {
    let identity: JobIdentity;
    try { identity = jobIdentity(binding); } catch (error) {
      return { state: error instanceof JobIdentityMismatchError ? "identity_mismatch" : "outcome_unknown" };
    }
    try { assertJobFence(identity, fence); } catch { return { state: "identity_mismatch" }; }
    try {
      const snapshot = await this.control(identity, async () =>
        await this.service.reconcileOwned(identity.processId, jobOwner(identity)));
      if (snapshot.startedAt !== identity.startedAt) return { state: "identity_mismatch" };
      if (snapshot.status === "running") return { state: "running" };
      if (snapshot.status === "exited_unknown")
        return snapshot.ownershipReleased ? { state: "outcome_unknown" } : { state: "running" };
      return { state: "exited", ...(snapshot.exitCode === null ? {} : { exitCode: snapshot.exitCode }), ...(snapshot.signal ? { signal: snapshot.signal } : {}) };
    } catch { return { state: "outcome_unknown" }; }
  }
  async release(binding: ProcessBackendBinding, fence?: ProcessEffectFence): Promise<unknown> {
    const identity = jobIdentity(binding);
    assertJobFence(identity, fence);
    const processId = identity.processId;
    let lane = this.controls.get(processId);
    const activation = this.activations.get(processId);
    if (!lane && activation) lane = await activation;
    if (!lane) lane = this.registerLane(identity);
    this.assertLaneIdentity(lane, identity);
    if (!lane.release) {
      lane.releaseRequested = true;
      const release = lane.tail.catch(() => undefined)
        .then(async () => {
          await this.service.releaseOwned(processId, jobOwner(identity), identity.startedAt);
          this.offsets.delete(processId);
          if (this.controls.get(processId) === lane) this.controls.delete(processId);
        });
      lane.release = release;
    }
    const release = lane.release;
    try {
      await release;
    } catch (error) {
      if (lane.release === release) lane.release = undefined;
      throw error;
    }
    return { released: true };
  }

  private async control<T>(identity: JobIdentity, action: () => Promise<T>): Promise<T> {
    const lane = await this.ensureLane(identity);
    if (lane.releaseRequested) throw new Error("Windows Job control was requested while release is pending.");
    const result = lane.tail.catch(() => undefined).then(action);
    lane.tail = result.then(() => undefined, () => undefined);
    return await result;
  }

  private async ensureLane(identity: JobIdentity): Promise<JobControlLane> {
    const existing = this.controls.get(identity.processId);
    if (existing) {
      this.assertLaneIdentity(existing, identity);
      return existing;
    }
    let activation = this.activations.get(identity.processId);
    if (!activation) {
      activation = (async () => {
        const snapshot = await this.service.reconcileOwned(identity.processId, jobOwner(identity));
        if (snapshot.startedAt !== identity.startedAt) throw new JobIdentityMismatchError("Windows Job startedAt identity mismatch.");
        return this.registerLane(identity);
      })();
      this.activations.set(identity.processId, activation);
      void activation.finally(() => {
        if (this.activations.get(identity.processId) === activation) this.activations.delete(identity.processId);
      }).catch(() => undefined);
    }
    const lane = await activation;
    this.assertLaneIdentity(lane, identity);
    return lane;
  }

  private registerLane(identity: JobIdentity): JobControlLane {
    const existing = this.controls.get(identity.processId);
    if (existing) {
      this.assertLaneIdentity(existing, identity);
      return existing;
    }
    const lane: JobControlLane = {
      tail: Promise.resolve(),
      releaseRequested: false,
      identity: { ...identity },
    };
    this.controls.set(identity.processId, lane);
    return lane;
  }

  private assertLaneIdentity(lane: JobControlLane, identity: JobIdentity): void {
    const owned = lane.identity;
    if (
      owned.processId !== identity.processId ||
      owned.runId !== identity.runId ||
      owned.sessionId !== identity.sessionId ||
      owned.startedAt !== identity.startedAt ||
      owned.birthDiscriminator !== identity.birthDiscriminator
    ) throw new JobIdentityMismatchError("Windows Job exact identity mismatch.");
  }
}

interface JobControlLane {
  tail: Promise<void>;
  releaseRequested: boolean;
  identity: JobIdentity;
  release?: Promise<void>;
}

interface JobOpaqueIdentity { processId: string; runId: string; sessionId: string; startedAt: string; fence?: ProcessEffectFence }
interface JobIdentity extends JobOpaqueIdentity { birthDiscriminator: string }
class JobIdentityMismatchError extends Error {}
function jobIdentity(binding: ProcessBackendBinding): JobIdentity {
  const value = JSON.parse(Buffer.from(binding.opaqueIdentity, "base64url").toString("utf8")) as JobOpaqueIdentity;
  if (!value.processId || !value.runId || !value.sessionId || !value.startedAt) throw new Error("Windows Job identity is invalid.");
  const discriminator = jobBirthDiscriminator(value);
  if (binding.birthFingerprint.discriminator !== discriminator) throw new JobIdentityMismatchError("Windows Job birth fingerprint is invalid.");
  return { ...value, birthDiscriminator: discriminator };
}
function jobBirthDiscriminator(identity: JobOpaqueIdentity): string {
  const fence = identity.fence ? `\0${identity.fence.ownerId}\0${identity.fence.fencingToken}` : "";
  return createHash("sha256").update(`${identity.processId}\0${identity.startedAt}${fence}`).digest("hex");
}
function assertJobFence(identity: JobIdentity, fence: ProcessEffectFence | undefined): void {
  if (!identity.fence) return;
  if (!fence || identity.fence.ownerId !== fence.ownerId || identity.fence.fencingToken !== fence.fencingToken)
    throw new JobIdentityMismatchError("Windows Job writer fence is stale.");
}
function jobOwner(identity: JobIdentity) {
  return { runId: identity.runId, sessionId: identity.sessionId };
}
