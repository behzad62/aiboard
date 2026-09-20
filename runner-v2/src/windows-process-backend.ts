import { NativeOwnedProcessBackend } from "./native-process-backend.js";
import type { NativeProcessOperations } from "./native-process-backend.js";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, resolve } from "node:path";

import type { ProcessBackend, ProcessBackendBinding, ProcessEffectFence, ProcessLaunchRequest } from "./process-backend.js";
import type { ProcessEscalationAction, ProcessOutputStream } from "./execution-safety-contracts.js";
import type { WindowsJobProcessHost } from "./windows-job-process-host.js";
import { createWindowsJobProcessChannelProvider } from "./windows-job-process-channel.js";
import type { ProcessHostSemanticFact, ProcessHostSemanticFacts } from "./process-host-semantic-probes.js";

export interface WindowsProcessBackendOptions {
  readonly stateDirectory?: string;
  readonly pollIntervalMs?: number;
  readonly operations?: NativeProcessOperations;
  readonly replayCapacityChunks?: number;
  readonly replayCapacityBytes?: number;
  /** Internal absolute startup deadline shared by semantic probes and tests. */
  readonly startupDeadlineAt?: number;
  readonly beforeFenceEffect?: (kind: "attach" | "read" | "write" | "close" | "signal" | "output_ack" | "ack_consume" | "verify_empty" | "reconcile" | "release") => void | Promise<void>;
  /** Test seam forwarded to the portable owner for post-retirement cleanup faults. */
  readonly removeRetiredAuthority?: (directory: string) => void;
  /** A caller may supply the existing authenticated Job supervisor as an optional enhancement. */
  readonly jobObjects?: "unavailable" | { readonly service: WindowsJobProcessHost };
  readonly semanticFacts?: ProcessHostSemanticFacts;
}
export type WindowsJobProcessService = WindowsJobProcessHost;

export class WindowsBatchLaunchUnavailableError extends Error {
  readonly code = "windows_batch_argv_unverified";
  constructor() {
    super("Windows batch launch is unavailable because argv-boundary semantics were not verified.");
    this.name = "WindowsBatchLaunchUnavailableError";
  }
}

export class WindowsProcessBackend extends NativeOwnedProcessBackend {
  private readonly windowsBatchArgv: ProcessHostSemanticFact;
  constructor(options: WindowsProcessBackendOptions = {}) {
    const exactTreeBirth = options.semanticFacts?.exactTreeBirth ?? "unavailable";
    super({
      stateDirectory: options.stateDirectory,
      pollIntervalMs: options.pollIntervalMs,
      operations: options.operations,
      replayCapacityChunks: options.replayCapacityChunks,
      replayCapacityBytes: options.replayCapacityBytes,
      startupDeadlineAt: options.startupDeadlineAt,
      beforeFenceEffect: options.beforeFenceEffect,
      removeRetiredAuthority: options.removeRetiredAuthority,
      platform: "windows",
      backendId: "runner-windows-supervisor-v1",
      lifecycleScope: "process_group",
      capabilities: {
        tree_termination: exactTreeBirth === "verified" ? "enforced" : exactTreeBirth === "partial" ? "partial" : "unavailable",
        crash_cleanup: "unavailable",
        verified_emptiness: exactTreeBirth === "verified" ? "enforced" : exactTreeBirth === "partial" ? "partial" : "unavailable",
        write_confinement: "unavailable",
      },
    });
    this.windowsBatchArgv = options.semanticFacts?.windowsBatchArgv ?? "unavailable";
  }
  override async launch(request: ProcessLaunchRequest): Promise<unknown> {
    const pinned = assertWindowsBatchSemantics(request, this.windowsBatchArgv);
    return await super.launch(pinned);
  }
}

export function createWindowsProcessBackend(options: WindowsProcessBackendOptions = {}): ProcessBackend {
  return options.jobObjects && options.jobObjects !== "unavailable" && options.semanticFacts?.jobContainment === "verified"
    ? new WindowsJobObjectProcessBackend(
        options.jobObjects.service,
        options.semanticFacts?.windowsBatchArgv,
        options.semanticFacts.jobContainment,
      )
    : new WindowsProcessBackend(options);
}

/** Adapts the existing authenticated Windows Job supervisor to the durable SPI. */
export class WindowsJobObjectProcessBackend implements ProcessBackend {
  private readonly offsets = new Map<string, { stdout: number; stderr: number }>();
  private readonly controls = new Map<string, JobControlLane>();
  private readonly activations = new Map<string, Promise<JobControlLane>>();
  private readonly writerFences = new Map<string, ProcessEffectFence>();
  constructor(
    private readonly service: WindowsJobProcessService,
    private readonly windowsBatchArgv: ProcessHostSemanticFact = "unavailable",
    private readonly jobContainment: ProcessHostSemanticFact = "unavailable",
  ) {}
  async probe(): Promise<unknown> {
    if (this.jobContainment !== "verified" && !(await this.service.probeActiveJobCreateClose()))
      throw new Error("Authenticated Windows Job Object enhancement is unavailable.");
    return {
      attestationVersion: 2,
      backendId: "runner-windows-job-v1",
      verified: true,
      platformLabel: "windows",
      lifecycle: { scope: "contained_workload", termination: "enforced", emptiness: "enforced" },
      capabilities: {
        tree_termination: "enforced",
        crash_cleanup: "enforced",
        verified_emptiness: "enforced",
        write_confinement: "unavailable",
      },
    };
  }
  async launch(request: ProcessLaunchRequest): Promise<unknown> {
    request = assertWindowsBatchSemantics(request, this.windowsBatchArgv);
    const sessionId = request.intent.sessionId ?? request.intent.invocationId;
    const snapshot = await this.service.launchOwned({
      runId: request.intent.runId,
      sessionId,
      command: request.intent.executable,
      args: [...request.intent.arguments],
      workingDirectory: request.intent.workingDirectory,
      environment: { ...request.environment },
      interactive: true,
      fence: { ...request.fence },
    });
    const opaqueIdentity: JobOpaqueIdentity = { processId: snapshot.processId, runId: request.intent.runId, sessionId, startedAt: snapshot.startedAt, fence: { ...request.fence } };
    const birthDiscriminator = jobBirthDiscriminator(opaqueIdentity);
    const identity: JobIdentity = { ...opaqueIdentity, birthDiscriminator };
    this.writerFences.set(identity.processId, { ...request.fence });
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
    await this.claimFence(identity, _fence);
    if (!this.service.attachOwnedChannel || !this.service.writeOwnedInput || !this.service.closeOwnedInput || !this.service.acknowledgeOwnedOutput || !this.service.claimOwnedFence) {
      for (;;) {
        const { snapshot, deliveredOutput } = await this.control(identity, _fence, async () => {
          await this.claimFence(identity, _fence);
          const offsets = this.offsets.get(identity.processId) ?? { stdout: 0, stderr: 0 };
          const unread = await this.service.readOwnedOutput(identity.processId, jobOwner(identity), offsets, _fence);
          for (const stream of ["stdout", "stderr"] as const) {
            if (unread[stream].byteLength > 0) await output(stream, unread[stream]);
          }
          this.offsets.set(identity.processId, { ...unread.next });
          return {
            snapshot: await this.service.reconcileOwned(identity.processId, jobOwner(identity), _fence),
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
    const channel = await this.backpressuredChannelProvider().acquire(binding, _fence);
    const unsubscribe = channel.subscribeBackpressuredOutput(async (metadata, bytes) => {
      await output(metadata.stream, bytes);
      return metadata;
    });
    try {
      await channel.waitForTerminal();
      await this.claimFence(identity, _fence);
      const terminal = await this.service.reconcileOwned(identity.processId, jobOwner(identity), _fence);
      if (terminal.startedAt !== identity.startedAt || terminal.status !== "stopped" || !terminal.ownershipReleased)
        throw new Error("Windows Job terminal state could not be re-attested.");
      return {
        state: "exited",
        ...(terminal.exitCode === null ? {} : { exitCode: terminal.exitCode }),
        ...(terminal.signal ? { signal: terminal.signal } : {}),
      };
    } finally {
      unsubscribe();
      await channel.detach();
    }
  }
  async signal(binding: ProcessBackendBinding, action: ProcessEscalationAction, fence?: ProcessEffectFence): Promise<unknown> {
    const identity = jobIdentity(binding);
    await this.claimFence(identity, fence);
    let snapshot;
    try {
      snapshot = await this.control(identity, fence, async () =>
        await this.service.signalOwned(identity.processId, action === "force_terminate" ? "SIGKILL" : action === "interrupt" ? "SIGINT" : "SIGTERM", jobOwner(identity), fence));
    } catch (error) {
      if ((error as { code?: unknown })?.code === "process_output_unsettled_terminal") return { state: "exited" };
      throw error;
    }
    return { state: snapshot.status === "stopped" ? "exited" : "running" };
  }
  async verifyEmpty(binding: ProcessBackendBinding, fence?: ProcessEffectFence): Promise<unknown> {
    const identity = jobIdentity(binding);
    await this.claimFence(identity, fence);
    const snapshot = await this.control(identity, fence, async () =>
      await this.service.reconcileOwned(identity.processId, jobOwner(identity), fence));
    return snapshot.status === "stopped" && snapshot.ownershipReleased ? { empty: true, proofArtifactId: `windows-job-empty:${identity.processId}` } : { empty: false, detail: "Windows Job Object still contains active processes." };
  }
  async reconcile(binding: ProcessBackendBinding, fence?: ProcessEffectFence): Promise<unknown> {
    let identity: JobIdentity;
    try { identity = jobIdentity(binding); } catch (error) {
      return { state: error instanceof JobIdentityMismatchError ? "identity_mismatch" : "outcome_unknown" };
    }
    try { await this.claimFence(identity, fence); } catch { return { state: "identity_mismatch" }; }
    try {
      const snapshot = await this.control(identity, fence, async () =>
        await this.service.reconcileOwned(identity.processId, jobOwner(identity), fence));
      if (snapshot.startedAt !== identity.startedAt) return { state: "identity_mismatch" };
      if (snapshot.status === "running") return { state: "running" };
      if (snapshot.status === "exited_unknown")
        return snapshot.ownershipReleased ? { state: "outcome_unknown" } : { state: "running" };
      return { state: "exited", ...(snapshot.exitCode === null ? {} : { exitCode: snapshot.exitCode }), ...(snapshot.signal ? { signal: snapshot.signal } : {}) };
    } catch { return { state: "outcome_unknown" }; }
  }
  async release(binding: ProcessBackendBinding, fence?: ProcessEffectFence): Promise<unknown> {
    const identity = jobIdentity(binding);
    await this.claimFence(identity, fence);
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
          await this.service.releaseOwned(processId, jobOwner(identity), identity.startedAt, fence);
          this.offsets.delete(processId);
          if (this.controls.get(processId) === lane) this.controls.delete(processId);
        });
      lane.release = release;
    }
    const release = lane.release;
    try {
      await release;
    } catch (error) {
      if (lane.release === release) {
        lane.release = undefined;
        const currentFence = this.writerFences.get(processId);
        // An exactly empty job with retained output refused release before any
        // release effect. Allow the acknowledgements needed to finish draining;
        // uncertain release failures must keep the control lane closed.
        if ((error as { code?: unknown })?.code === "process_output_unsettled_terminal" ||
            (error as { code?: unknown })?.code === "process_identity_mismatch" ||
            (fence && currentFence && (currentFence.ownerId !== fence.ownerId || currentFence.fencingToken !== fence.fencingToken)))
          lane.releaseRequested = false;
      }
      throw error;
    }
    return { released: true };
  }

  backpressuredChannelProvider() {
    if (!this.service.attachOwnedChannel || !this.service.writeOwnedInput || !this.service.closeOwnedInput || !this.service.acknowledgeOwnedOutput || !this.service.claimOwnedFence) {
      throw new Error("Windows Job duplex channel is unavailable.");
    }
    const duplexService = this.service as WindowsJobProcessService & Required<Pick<WindowsJobProcessService, "attachOwnedChannel" | "writeOwnedInput" | "closeOwnedInput" | "acknowledgeOwnedOutput" | "claimOwnedFence">>;
    return createWindowsJobProcessChannelProvider({
      replayCapacityChunks: 16,
      replayCapacityBytes: 256 * 1024,
      pollIntervalMs: 25,
      authority: (binding, fence) => {
        const identity = jobIdentity(binding);
        assertJobFence(identity, fence);
        return {
          processId: identity.processId,
          owner: jobOwner(identity),
          fence,
          service: duplexService,
          control: async <T>(effect: () => Promise<T>) => await this.control(identity, fence, effect),
          reattest: async () => {
            await this.claimFence(identity, fence);
            const snapshot = await this.service.reconcileOwned(identity.processId, jobOwner(identity), fence);
            if (snapshot.startedAt !== identity.startedAt) throw new JobIdentityMismatchError("Windows Job startedAt identity mismatch.");
            if (snapshot.status === "stopped") return "exited" as const;
            if (snapshot.status === "exited_unknown" && snapshot.ownershipReleased)
              throw new Error("Windows Job supervisor outcome is unknown.");
            return "live" as const;
          },
        };
      },
    });
  }

  private async claimFence(identity: JobIdentity, fence: ProcessEffectFence | undefined): Promise<void> {
    assertJobFence(identity, fence);
    if (!fence) return;
    const exact = fence!;
    const current = this.writerFences.get(identity.processId);
    if (current && (exact.fencingToken < current.fencingToken || (exact.fencingToken === current.fencingToken && exact.ownerId !== current.ownerId))) throw new JobIdentityMismatchError("Windows Job writer fence is stale.");
    // Every host effect still reloads and compares the durable fence. Repeating
    // the external claim for an already-current writer adds no authority.
    if (current && exact.fencingToken === current.fencingToken && exact.ownerId === current.ownerId) return;
    await this.service.claimOwnedFence?.(identity.processId, jobOwner(identity), exact);
    this.writerFences.set(identity.processId, { ...exact });
  }

  private async control<T>(identity: JobIdentity, fence: ProcessEffectFence | undefined, action: () => Promise<T>): Promise<T> {
    const lane = await this.ensureLane(identity, fence);
    if (lane.releaseRequested) throw new Error("Windows Job control was requested while release is pending.");
    const result = lane.tail.catch(() => undefined).then(action);
    lane.tail = result.then(() => undefined, () => undefined);
    return await result;
  }

  private async ensureLane(identity: JobIdentity, fence: ProcessEffectFence | undefined): Promise<JobControlLane> {
    const existing = this.controls.get(identity.processId);
    if (existing) {
      this.assertLaneIdentity(existing, identity);
      return existing;
    }
    let activation = this.activations.get(identity.processId);
    if (!activation) {
      activation = (async () => {
        const snapshot = await this.service.reconcileOwned(identity.processId, jobOwner(identity), fence);
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

function assertWindowsBatchSemantics(request: ProcessLaunchRequest, fact: ProcessHostSemanticFact): ProcessLaunchRequest {
  request = canonicalizeWindowsResolutionEnvironment(request);
  const lexicalExtension = extname(request.intent.executable).toLowerCase();
  if ((lexicalExtension === ".cmd" || lexicalExtension === ".bat") && fact !== "verified")
    throw new WindowsBatchLaunchUnavailableError();
  if (lexicalExtension) return request;
  const resolved = resolveWindowsExecutable(request);
  if (!resolved) return request;
  const resolvedExtension = extname(resolved).toLowerCase();
  if ((resolvedExtension === ".cmd" || resolvedExtension === ".bat") && fact !== "verified")
    throw new WindowsBatchLaunchUnavailableError();
  return { ...request, intent: { ...request.intent, executable: resolved } };
}

function resolveWindowsExecutable(request: ProcessLaunchRequest): string | undefined {
  const executable = request.intent.executable;
  const hasDirectory = isAbsolute(executable) || dirname(executable) !== ".";
  const directories = hasDirectory
    ? [request.intent.workingDirectory]
    : [request.intent.workingDirectory, ...(request.environment.PATH ?? "").split(delimiter)
      .map((entry) => entry.trim().replace(/^"|"$/g, "")).filter(Boolean)];
  const extensions = (request.environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    .map((entry) => entry.trim()).filter(Boolean).map((entry) => entry.startsWith(".") ? entry : `.${entry}`);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = resolve(directory, `${executable}${extension}`);
      try { if (existsSync(candidate) && statSync(candidate).isFile()) return candidate; } catch {}
    }
  }
  return undefined;
}

function canonicalizeWindowsResolutionEnvironment(request: ProcessLaunchRequest): ProcessLaunchRequest {
  const environment = { ...request.environment };
  for (const canonical of ["PATH", "PATHEXT"] as const) {
    const keys = Object.keys(environment).filter((key) => key.toLowerCase() === canonical.toLowerCase());
    const values = new Set(keys.map((key) => environment[key]));
    if (values.size > 1) throw new Error(`Windows launch environment has ambiguous ${canonical} entries.`);
    for (const key of keys) delete environment[key];
    const value = values.values().next().value as string | undefined;
    if (value !== undefined) environment[canonical] = value;
  }
  return { ...request, environment };
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
  return createHash("sha256").update(`${identity.processId}\0${identity.startedAt}`).digest("hex");
}
function assertJobFence(identity: JobIdentity, fence: ProcessEffectFence | undefined): void {
  if (!identity.fence && !fence) return;
  if (!fence || !fence.ownerId || !Number.isSafeInteger(fence.fencingToken) || fence.fencingToken < 1)
    throw new JobIdentityMismatchError("Windows Job writer fence is invalid.");
}
function jobOwner(identity: JobIdentity) {
  return { runId: identity.runId, sessionId: identity.sessionId };
}
