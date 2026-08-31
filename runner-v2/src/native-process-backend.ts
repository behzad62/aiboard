import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ProcessBackend,
  ProcessBackendBinding,
  ProcessEffectFence,
  ProcessLaunchRequest,
} from "./process-backend.js";
import type { ExecutionSafetyCapabilities, ProcessEscalationAction, ProcessOutputStream } from "./execution-safety-contracts.js";
import { createPortableProcessChannelProvider, validatePortableAcknowledgementEvidence } from "./portable-process-channel.js";
import { OwnedFenceAuthorityRetirementError, retiredOwnedFenceCleanupAvailable, retryRetiredOwnedFenceCleanup, withOwnedFenceLock, withOwnedFenceLockSync } from "./owned-fence-lock.mjs";

const PROCESS_BIRTH_INITIAL_INSPECTION_DEADLINE_MS = 2_000;
const WINDOWS_SUPERVISOR_BIRTH_INSPECTION_DEADLINE_MS = 15_000;
const WINDOWS_PORTABLE_STARTUP_DEADLINE_MS = 30_000;
const PORTABLE_STARTUP_DEADLINE_MS = 6_000;
const WINDOWS_BIRTH_INSPECTION_MAX_ATTEMPTS = 3;

export interface NativeOwnedProcessBackendOptions {
  readonly stateDirectory?: string;
  readonly pollIntervalMs?: number;
  readonly platform: "posix" | "windows";
  readonly backendId: string;
  readonly capabilities: ExecutionSafetyCapabilities;
  readonly operations?: NativeProcessOperations;
  readonly replayCapacityChunks?: number;
  readonly replayCapacityBytes?: number;
  /** Optional absolute startup deadline shared with semantic probes and tests. */
  readonly startupDeadlineAt?: number;
  readonly beforeFenceEffect?: (kind: "attach" | "write" | "close" | "signal" | "output_ack" | "ack_consume" | "verify_empty" | "release") => void | Promise<void>;
  /** Test seam for a bounded post-retirement authority-directory removal fault. */
  readonly removeRetiredAuthority?: (directory: string) => void;
}
export interface NativeProcessOperations {
  inspectProcessBirth(pid: number, platform: "posix" | "windows", attemptDeadlineMs?: number): ProcessBirthInspection;
  /** Optional bounded snapshot used to avoid one host-tool process per recorded Windows member. */
  inspectProcessBirths?(pids: readonly number[], platform: "posix" | "windows"): ReadonlyMap<number, ProcessBirthInspection> | undefined;
  listPosixGroup(groupId: number): readonly number[] | undefined;
  signal(pid: number, signal: NodeJS.Signals): void;
}
export type ProcessBirthInspection =
  | { readonly state: "present"; readonly fingerprint: string }
  | { readonly state: "absent" }
  | { readonly state: "unknown" };
export class NativeProcessLaunchBlockedError extends AggregateError {
  readonly code = "native_process_launch_cleanup_blocked";
  constructor(
    errors: Iterable<unknown>,
    readonly evidenceDirectory: string,
    readonly launchResult: {
      readonly opaqueIdentity: string;
      readonly birthFingerprint: { readonly observedAt: string; readonly discriminator: string };
      readonly rootPid: number;
      readonly startedAt: string;
    },
    message: string,
  ) {
    super(errors, message);
    this.name = "NativeProcessLaunchBlockedError";
  }
}

interface Identity {
  readonly version: 1;
  readonly backendId: string;
  readonly nonce: string;
  readonly directory: string;
  readonly supervisorPid: number;
  readonly supervisorBirth: string;
  readonly fence?: ProcessEffectFence;
}
interface SupervisorState {
  readonly protocol: "aiboard-portable-process/v1";
  readonly nonce: string;
  readonly supervisorPid: number;
  readonly launchEffect?: "not_started" | "prepared" | "started" | "unknown";
  readonly rootProcess?: { readonly pid: number; readonly birth: string } | null;
  readonly revision: number;
  readonly handledControl: number;
  readonly status: "preparing" | "running" | "stopped" | "outcome_unknown";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly knownProcesses: readonly { readonly pid: number; readonly birth: string }[];
  readonly error: string | null;
  readonly updatedAt: string;
}
class OwnedProcessIdentityMismatchError extends Error {}

export class NativeOwnedProcessBackend implements ProcessBackend {
  private readonly stateDirectory: string;
  private readonly pollIntervalMs: number;
  private readonly operations: NativeProcessOperations;
  private readonly startupDeadlineAt: number | undefined;
  private readonly outputOffsets = new Map<string, { stdout: number; stderr: number }>();
  constructor(private readonly options: NativeOwnedProcessBackendOptions) {
    this.stateDirectory = resolve(options.stateDirectory ?? join(tmpdir(), "aiboard-portable-processes"));
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
    this.operations = options.operations ?? DEFAULT_OPERATIONS;
    this.startupDeadlineAt = options.startupDeadlineAt;
    if (this.startupDeadlineAt !== undefined && (!Number.isSafeInteger(this.startupDeadlineAt) || this.startupDeadlineAt < 1))
      throw new Error("Portable process absolute startup deadline must be a positive integer.");
    mkdirSync(this.stateDirectory, { recursive: true });
  }

  async probe(): Promise<unknown> {
    return Object.freeze({
      attestationVersion: 1,
      backendId: this.options.backendId,
      verified: true,
      platformLabel: this.options.platform,
      capabilities: Object.freeze({ ...this.options.capabilities }),
    });
  }

  async launch(request: ProcessLaunchRequest): Promise<unknown> {
    this.assertPlatform();
    const startupDeadline = Math.min(
      Date.now() + (this.options.platform === "windows" ? WINDOWS_PORTABLE_STARTUP_DEADLINE_MS : PORTABLE_STARTUP_DEADLINE_MS),
      this.startupDeadlineAt ?? Number.MAX_SAFE_INTEGER,
    );
    if (Date.now() >= startupDeadline) throw new Error("Portable process startup deadline is exhausted.");
    const nonce = randomBytes(24).toString("hex");
    const directory = join(this.stateDirectory, `owned-${randomUUID()}`);
    mkdirSync(directory, { recursive: false, mode: 0o700 });
    writeFileSync(join(directory, "stdout.log"), "", { mode: 0o600 });
    writeFileSync(join(directory, "stderr.log"), "", { mode: 0o600 });
    writeFileSync(join(directory, "fence.json"), JSON.stringify({ nonce, ...request.fence }), { mode: 0o600 });
    const supervisor = join(dirname(fileURLToPath(import.meta.url)), "portable-process-supervisor.mjs");
    const encoded = Buffer.from(JSON.stringify({
      nonce,
      directory,
      executable: request.intent.executable,
      arguments: [...request.intent.arguments],
      workingDirectory: request.intent.workingDirectory,
      environment: { ...request.environment },
      platform: this.options.platform,
      pollIntervalMs: this.pollIntervalMs,
      replayCapacityChunks: this.options.replayCapacityChunks ?? 16,
      replayCapacityBytes: this.options.replayCapacityBytes ?? 256 * 1024,
      fence: { ...request.fence },
    })).toString("base64url");
    if (Date.now() >= startupDeadline) {
      rmSync(directory, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
      throw new Error("Portable process startup deadline is exhausted.");
    }
    const child = spawn(process.execPath, [supervisor, encoded], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    if (!child.pid) throw new Error("Portable process supervisor has no PID.");
    child.unref();
    let identity: Identity | undefined;
    try {
      if (Date.now() >= startupDeadline) throw new Error("Portable process startup deadline is exhausted.");
      const supervisorBirth = await this.waitForBirth(child.pid, startupDeadline);
      if (Date.now() >= startupDeadline) throw new Error("Portable process startup deadline is exhausted.");
      if (!supervisorBirth) throw new Error("Portable supervisor birth identity is unavailable.");
      identity = {
        version: 1,
        backendId: this.options.backendId,
        nonce,
        directory,
        supervisorPid: child.pid,
        supervisorBirth,
        fence: Object.freeze({ ...request.fence }),
      };
      writeFileSync(join(directory, "lock-holder.json"), JSON.stringify({ nonce, holderPid: child.pid, holderBirth: supervisorBirth }), { mode: 0o600 });
      if (Date.now() >= startupDeadline) throw new Error("Portable process startup deadline is exhausted.");
      const state = await this.waitForState(directory, nonce, child.pid, startupDeadline);
      if (state.status !== "running") throw new Error(state.error ?? "Portable process launch failed.");
      const startedAt = state.updatedAt;
      return launchResult(identity, startedAt);
    } catch (error) {
      if (!identity) {
        const failedState = readState(directory);
        if (
          failedState?.nonce === nonce &&
          failedState.supervisorPid === child.pid &&
          failedState.status === "outcome_unknown" &&
          failedState.knownProcesses.length === 0 &&
          !pidAlive(child.pid)
        ) {
          rmSync(directory, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
          throw error;
        }
        throw new AggregateError(
          [error, new Error(`Launch cleanup identity is unavailable; evidence retained at ${directory}.`)],
          "Portable process launch failed before safe cleanup identity was established.",
        );
      }
      try {
        await this.cleanupFailedLaunch(identity);
      } catch (cleanupError) {
        if (cleanupError instanceof NativeProcessLaunchBlockedError) {
          throw new NativeProcessLaunchBlockedError(
            [error, ...cleanupError.errors],
            cleanupError.evidenceDirectory,
            cleanupError.launchResult,
            cleanupError.message,
          );
        }
        throw new AggregateError(
          [error, cleanupError],
          `Portable process launch failed and owned cleanup could not be verified; evidence retained at ${directory}.`,
        );
      }
      rmSync(directory, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
      throw error;
    }
  }

  backpressuredChannelProvider() {
    return createPortableProcessChannelProvider({
      replayCapacityChunks: this.options.replayCapacityChunks ?? 16,
      replayCapacityBytes: this.options.replayCapacityBytes ?? 256 * 1024,
      pollIntervalMs: this.pollIntervalMs,
      authority: (binding, fence) => {
        const identity = this.identity(binding);
        this.assertFence(identity, fence);
        return {
          directory: identity.directory,
          nonce: identity.nonce,
          fence,
          supervisorPid: identity.supervisorPid,
          reattest: () => {
            this.assertFence(identity, fence);
            const state = this.validate(identity);
            if (state === "mismatch" || state === "unknown") throw new Error("Portable channel identity re-attestation failed.");
            return state === "live" ? "live" : "exited";
          },
          effect: (kind, effect) => {
            const preparation = this.options.beforeFenceEffect?.(kind);
            return preparation
              ? Promise.resolve(preparation).then(() => commitOwnedFenceEffectAsync(identity, fence, effect))
              : commitOwnedFenceEffectAsync(identity, fence, effect);
          },
        };
      },
    });
  }

  async observe(
    binding: ProcessBackendBinding,
    output: (stream: ProcessOutputStream, bytes: Uint8Array) => Promise<void>,
    _fence: ProcessEffectFence,
  ): Promise<unknown> {
    const identity = this.identity(binding);
    this.assertFence(identity, _fence);
    const channel = await this.backpressuredChannelProvider().acquire(binding, _fence);
    const unsubscribe = channel.subscribeBackpressuredOutput(async (metadata, bytes) => {
      await output(metadata.stream, bytes);
      return metadata;
    });
    try {
      return await channel.waitForTerminal();
    } finally {
      unsubscribe();
      await channel.detach();
    }
  }

  async signal(binding: ProcessBackendBinding, action: ProcessEscalationAction, _fence?: ProcessEffectFence): Promise<unknown> {
    const identity = this.identity(binding);
    this.assertFence(identity, _fence);
    const validation = this.validate(identity);
    if (validation === "mismatch") throw new Error("Owned process identity mismatch.");
    if (validation === "unknown") throw new Error("Owned process identity inspection is unavailable.");
    if (validation === "exited") {
      const remaining = await this.emptiness(identity);
      if (remaining === "empty") return { state: "exited" };
      if (remaining === "identity_mismatch") throw new Error("Owned descendant identity mismatch.");
      if (remaining === "outcome_unknown") throw new Error("Owned process membership could not be verified after the supervisor exited.");
      if (this.options.platform === "windows") throw new Error("Owned Windows supervisor exited before it could control its live descendants.");
      const signal = action === "force_terminate" ? "SIGKILL" : action === "interrupt" ? "SIGINT" : "SIGTERM";
      await this.fencedEffect(identity, _fence, "signal", () => this.operations.signal(-identity.supervisorPid, signal));
      await delay(action === "force_terminate" ? 250 : 75);
      return this.signalState(await this.waitForKnownEmptiness(identity));
    }
    if (this.options.platform === "posix") {
      const signal = action === "force_terminate" ? "SIGKILL" : action === "interrupt" ? "SIGINT" : "SIGTERM";
      await this.fencedEffect(identity, _fence, "signal", () => this.operations.signal(-identity.supervisorPid, signal));
    } else {
      const beforeSignal = await this.waitForKnownEmptiness(identity);
      if (beforeSignal === "identity_mismatch") throw new Error("Owned descendant identity mismatch.");
      if (beforeSignal === "outcome_unknown") throw new Error("Owned descendant identity is unavailable.");
      const state = readState(identity.directory);
      const sequence = (state?.handledControl ?? 0) + 1;
      await this.fencedEffect(identity, _fence, "signal", () => writeJsonAtomic(join(identity.directory, "control.json"), { nonce: identity.nonce, ownerId: _fence!.ownerId, fencingToken: _fence!.fencingToken, sequence, action }));
    }
    await delay(action === "force_terminate" ? 250 : 75);
    return this.signalState(await this.waitForKnownEmptiness(identity));
  }

  async verifyEmpty(binding: ProcessBackendBinding, _fence?: ProcessEffectFence): Promise<unknown> {
    const identity = this.identity(binding);
    this.assertFence(identity, _fence);
    const validation = this.validate(identity);
    if (validation === "mismatch")
      return { empty: false, detail: "Owned process identity changed before quiescence verification." };
    if (validation === "unknown")
      return { empty: false, detail: "Owned process identity inspection is unavailable." };
    const emptiness = await this.emptiness(identity);
    if (emptiness === "empty") {
      const stableValidation = this.validate(identity);
      if ((stableValidation === "live" || stableValidation === "exited") && this.hasTerminalStoppedProof(identity)) {
        try { assertPortableOutputSettled(identity); } catch { return { empty: false, detail: "Owned output evidence is unsettled or unavailable." }; }
        try {
          return await this.fencedEffect(identity, _fence, "verify_empty", () => {
            const finalValidation = this.validate(identity);
            if ((finalValidation !== "live" && finalValidation !== "exited") || !this.hasTerminalStoppedProof(identity) || this.emptiness(identity) !== "empty")
              throw new OwnedProcessIdentityMismatchError("Owned process empty proof lost terminal identity attestation.");
            assertPortableOutputSettled(identity);
            return { empty: true, proofArtifactId: `native-empty:${identity.nonce}` };
          });
        } catch { return { empty: false, detail: "Owned process empty proof could not be fenced and re-attested." }; }
      }
      return { empty: false, detail: "Owned process lacks durable terminal proof." };
    }
    return {
      empty: false,
      detail: emptiness === "nonempty"
        ? "Owned process group/tree still has live members."
        : emptiness === "identity_mismatch"
          ? "Owned process identity changed before quiescence verification."
          : "Owned process membership could not be enumerated or verified.",
    };
  }

  async reconcile(binding: ProcessBackendBinding, _fence?: ProcessEffectFence): Promise<unknown> {
    let identity: Identity;
    try { identity = this.identity(binding); } catch (error) {
      return { state: error instanceof OwnedProcessIdentityMismatchError ? "identity_mismatch" : "outcome_unknown" };
    }
    try { this.assertFence(identity, _fence); } catch { return { state: "identity_mismatch" }; }
    const validation = this.validate(identity);
    if (validation === "mismatch") return { state: "identity_mismatch" };
    if (validation === "unknown") return { state: "outcome_unknown" };
    const state = readState(identity.directory);
    if (!state) return { state: "outcome_unknown" };
    if (state.nonce !== identity.nonce || state.supervisorPid !== identity.supervisorPid)
      return { state: "identity_mismatch" };
    if (state.status === "outcome_unknown") return { state: "outcome_unknown" };
    const emptiness = await this.emptiness(identity);
    if (emptiness === "identity_mismatch") return { state: "identity_mismatch" };
    if (emptiness === "outcome_unknown") return { state: "outcome_unknown" };
    if (validation === "live" || emptiness === "nonempty") return { state: "running" };
    try { assertPortableOutputSettled(identity); }
    catch { return { state: "outcome_unknown" }; }
    try { this.assertFence(identity, _fence); } catch { return { state: "identity_mismatch" }; }
    const finalValidation = this.validate(identity);
    const finalState = readState(identity.directory);
    if ((finalValidation !== "live" && finalValidation !== "exited") || !finalState || finalState.nonce !== identity.nonce ||
        finalState.supervisorPid !== identity.supervisorPid || finalState.status !== "stopped" || this.emptiness(identity) !== "empty")
      return { state: "outcome_unknown" };
    return {
      state: "exited",
      ...(finalState.exitCode === null ? {} : { exitCode: finalState.exitCode }),
      ...(finalState.signal ? { signal: finalState.signal } : {}),
    };
  }

  async release(binding: ProcessBackendBinding, _fence?: ProcessEffectFence): Promise<unknown> {
    const identity = this.identity(binding);
    const lockPath = join(identity.directory, ".fence.lock");
    if (retiredOwnedFenceCleanupAvailable(lockPath)) this.assertDurableFence(identity, _fence);
    else this.assertFence(identity, _fence);
    const validation = this.validate(identity);
    if (validation === "mismatch" || validation === "unknown") throw new Error("Cannot release ownership without exact supervisor birth re-attestation.");
    const emptiness = await this.emptiness(identity);
    if (emptiness !== "empty")
      throw new Error(emptiness === "outcome_unknown" ? "Cannot release ownership with unknown empty verification." : "Cannot release non-empty owned process identity.");
    assertPortableOutputSettled(identity);
    if (!this.hasTerminalStoppedProof(identity)) throw new Error("Cannot release ownership without durable terminal state proof.");
    const stableValidation = this.validate(identity);
    if (stableValidation === "mismatch" || stableValidation === "unknown") throw new Error("Cannot release ownership after supervisor birth changed.");
    const stableEmptiness = await this.emptiness(identity);
    if (stableEmptiness !== "empty") throw new Error("Cannot release ownership without stable verified emptiness.");
    assertPortableOutputSettled(identity);
    if (!this.hasTerminalStoppedProof(identity)) throw new Error("Cannot release ownership after durable terminal state changed.");
    const validateFinalRelease = () => {
      this.assertDurableFence(identity, _fence);
      const finalValidation = this.validate(identity);
      if ((finalValidation !== "live" && finalValidation !== "exited") || !this.hasTerminalStoppedProof(identity) || this.emptiness(identity) !== "empty")
        throw new Error("Cannot release ownership without final terminal empty re-attestation.");
      assertPortableOutputSettled(identity);
    };
    try {
      await this.fencedEffect(identity, _fence, "release", validateFinalRelease);
    } catch (error) {
      if (errorChainHas(error, OwnedFenceAuthorityRetirementError) || !retiredOwnedFenceCleanupAvailable(lockPath) || !errorChainMatches(error, /retired/i)) throw error;
      await retryRetiredOwnedFenceCleanup(lockPath, () => {
        validateFinalRelease();
        (this.options.removeRetiredAuthority ?? removeRetiredAuthorityDirectory)(identity.directory);
        this.outputOffsets.delete(identity.nonce);
      });
    }
    return { released: true };
  }

  private assertPlatform(): void {
    if (this.options.platform === "windows" ? process.platform !== "win32" : process.platform === "win32")
      throw new Error(`${this.options.platform} native process backend is unavailable on ${process.platform}.`);
  }
  private async fencedEffect<T>(identity: Identity, fence: ProcessEffectFence | undefined, kind: "signal" | "verify_empty" | "release", effect: () => T): Promise<T> {
    if (!fence) throw new OwnedProcessIdentityMismatchError("Owned process writer fence is unavailable.");
    await this.options.beforeFenceEffect?.(kind);
    return await commitOwnedFenceEffectAsync(identity, fence, effect, kind === "release"
      ? () => {
          (this.options.removeRetiredAuthority ?? removeRetiredAuthorityDirectory)(identity.directory);
          this.outputOffsets.delete(identity.nonce);
        }
      : undefined);
  }
  private identity(binding: ProcessBackendBinding): Identity {
    const value = JSON.parse(Buffer.from(binding.opaqueIdentity, "base64url").toString("utf8")) as Identity;
    if (value.version !== 1 || value.backendId !== this.options.backendId || !value.nonce || !value.directory || !Number.isSafeInteger(value.supervisorPid) || !value.supervisorBirth)
      throw new Error("Owned process opaque identity is invalid.");
    const expected = birthDiscriminator(value);
    if (binding.birthFingerprint.discriminator !== expected || binding.rootPid !== value.supervisorPid)
      throw new OwnedProcessIdentityMismatchError("Owned process birth fingerprint is invalid.");
    return value;
  }
  private assertFence(identity: Identity, fence: ProcessEffectFence | undefined): void {
    if (!fence) {
      if (!identity.fence) return;
      throw new OwnedProcessIdentityMismatchError("Owned process writer fence is unavailable.");
    }
    claimOwnedFence(identity, fence);
  }
  private assertDurableFence(identity: Identity, fence: ProcessEffectFence | undefined): void {
    if (!fence) throw new OwnedProcessIdentityMismatchError("Owned process writer fence is unavailable.");
    const current = readOwnedFence(join(identity.directory, "fence.json"), identity);
    if (fence.ownerId !== current.ownerId || fence.fencingToken !== current.fencingToken)
      throw new OwnedProcessIdentityMismatchError("Owned process writer fence is stale at the effect boundary.");
  }
  private validate(identity: Identity): "live" | "exited" | "mismatch" | "unknown" {
    const inspection = this.operations.inspectProcessBirth(identity.supervisorPid, this.options.platform);
    if (inspection.state === "unknown") return "unknown";
    if (inspection.state === "absent") return "exited";
    return sameProcessBirth(inspection.fingerprint, identity.supervisorBirth) ? "live" : "mismatch";
  }
  private emptiness(identity: Identity): "empty" | "nonempty" | "identity_mismatch" | "outcome_unknown" {
    if (this.options.platform === "posix") {
      const members = this.operations.listPosixGroup(identity.supervisorPid);
      return members === undefined ? "outcome_unknown" : members.length === 0 ? "empty" : "nonempty";
    }
    const state = readState(identity.directory);
    if (!state || !Array.isArray(state.knownProcesses)) return "outcome_unknown";
    if (state.nonce !== identity.nonce || state.supervisorPid !== identity.supervisorPid) return "identity_mismatch";
    if (state.status === "outcome_unknown" || state.launchEffect === "unknown") return "outcome_unknown";
    if (state.launchEffect === "not_started")
      return state.knownProcesses.length === 0 ? "empty" : "outcome_unknown";
    if (
      state.launchEffect !== "started" ||
      !validKnownProcess(state.rootProcess) ||
      !state.knownProcesses.some((process) => process.pid === state.rootProcess!.pid && process.birth === state.rootProcess!.birth)
    ) return "outcome_unknown";
    const pids = state.knownProcesses.map(({ pid }) => pid);
    const inspections = this.operations.inspectProcessBirths
      ? this.operations.inspectProcessBirths(pids, "windows")
      : undefined;
    if (this.operations.inspectProcessBirths && !inspections) return "outcome_unknown";
    let live = false;
    for (const process of state.knownProcesses) {
      if (!Number.isSafeInteger(process.pid) || !process.birth) return "outcome_unknown";
      const inspection = inspections?.get(process.pid) ?? (
        this.operations.inspectProcessBirths ? { state: "unknown" } : this.operations.inspectProcessBirth(process.pid, "windows")
      );
      if (inspection.state === "unknown") return "outcome_unknown";
      if (inspection.state === "absent") continue;
      // PID plus birth is the owned identity. A different exact birth proves
      // the historical identity is absent; the live replacement is unrelated.
      if (!sameProcessBirth(inspection.fingerprint, process.birth)) continue;
      live = true;
    }
    return live ? "nonempty" : "empty";
  }
  private signalState(emptiness: "empty" | "nonempty" | "identity_mismatch" | "outcome_unknown"): { state: "running" | "exited" } {
    if (emptiness === "identity_mismatch") throw new Error("Owned descendant identity mismatch.");
    if (emptiness === "outcome_unknown") throw new Error("Owned process membership could not be verified after signal.");
    return { state: emptiness === "empty" ? "exited" : "running" };
  }
  private async waitForKnownEmptiness(identity: Identity): Promise<"empty" | "nonempty" | "identity_mismatch" | "outcome_unknown"> {
    const deadline = Date.now() + Math.max(500, this.pollIntervalMs * 100);
    let result = await this.emptiness(identity);
    while (result === "outcome_unknown" && Date.now() < deadline) {
      await delay(this.pollIntervalMs);
      result = await this.emptiness(identity);
    }
    return result;
  }
  private async cleanupFailedLaunch(identity: Identity): Promise<void> {
    const deadline = Date.now() + 3_000;
    let validation = this.validate(identity);
    while (validation === "unknown" && Date.now() < deadline) {
      await delay(this.pollIntervalMs);
      validation = this.validate(identity);
    }
    if (validation === "mismatch") throw new Error("Launch cleanup refused a recycled supervisor identity.");
    if (validation === "unknown") throw launchBlocker(identity, "Launch cleanup could not inspect the supervisor identity.");
    if (this.options.platform === "windows" && validation === "exited" && this.hasTerminalStoppedProof(identity)) {
      const proof = readState(identity.directory)!;
      await delay(Math.max(100, this.pollIntervalMs * 2));
      const stable = readState(identity.directory);
      if (stable?.nonce === proof.nonce && stable.supervisorPid === proof.supervisorPid &&
          stable.revision === proof.revision && stable.status === "stopped") return;
      throw launchBlocker(identity, "Launch cleanup lost its stable terminal Windows supervisor proof.");
    }
    if (validation === "live") {
      if (this.options.platform === "posix") {
        const members = this.operations.listPosixGroup(identity.supervisorPid);
        if (members === undefined) throw new Error("Launch cleanup could not enumerate the owned POSIX group.");
        this.cleanupFenceEffect(identity, () => this.operations.signal(-identity.supervisorPid, "SIGKILL"));
      } else {
        await delay(Math.max(250, this.pollIntervalMs * 2));
        let before = await this.emptiness(identity);
        while (before === "outcome_unknown" && Date.now() < deadline) {
          await delay(this.pollIntervalMs);
          before = await this.emptiness(identity);
        }
        if (before === "identity_mismatch") throw new Error("Launch cleanup refused a recycled Windows descendant.");
        if (before === "outcome_unknown")
          throw launchBlocker(identity, "Launch cleanup preserved evidence because Windows descendant inspection is unknown.");
        const state = readState(identity.directory);
        const sequence = (state?.handledControl ?? 0) + 1;
        this.cleanupFenceEffect(identity, () => writeFileSync(join(identity.directory, "control.json"), JSON.stringify({
          nonce: identity.nonce,
          ownerId: identity.fence!.ownerId,
          fencingToken: identity.fence!.fencingToken,
          sequence,
          action: "force_terminate",
        }), { mode: 0o600 }));
      }
    } else if (this.options.platform === "posix") {
      const members = this.operations.listPosixGroup(identity.supervisorPid);
      if (members === undefined) throw new Error("Launch cleanup could not enumerate the owned POSIX group after its supervisor exited.");
      if (members.length > 0) this.cleanupFenceEffect(identity, () => this.operations.signal(-identity.supervisorPid, "SIGKILL"));
    } else {
      let remaining = await this.emptiness(identity);
      while (remaining === "outcome_unknown" && Date.now() < deadline) {
        await delay(this.pollIntervalMs);
        remaining = await this.emptiness(identity);
      }
      if (remaining === "identity_mismatch") throw new Error("Launch cleanup refused a recycled Windows descendant.");
      if (remaining === "outcome_unknown") throw launchBlocker(identity, "Launch cleanup preserved evidence because Windows ownership inspection is unknown after the supervisor exited.");
      if (remaining === "nonempty") throw launchBlocker(identity, "Launch cleanup preserved blocker evidence because the Windows supervisor exited with an owned descendant.");
    }
    const requiredStableMs = this.options.platform === "windows" ? 500 : 100;
    let emptySince: number | undefined;
    while (Date.now() < deadline) {
      const emptiness = await this.emptiness(identity);
      if (emptiness === "identity_mismatch") throw new Error("Launch cleanup observed a recycled owned identity.");
      if (emptiness === "outcome_unknown") {
        if (this.options.platform === "windows") {
          emptySince = undefined;
          await delay(this.pollIntervalMs);
          continue;
        }
        throw new Error("Launch cleanup lost ownership verification.");
      }
      if (emptiness === "empty") {
        emptySince ??= Date.now();
        if (Date.now() - emptySince >= requiredStableMs) return;
      } else emptySince = undefined;
      await delay(this.pollIntervalMs);
    }
    if (this.options.platform === "windows")
      throw launchBlocker(identity, "Launch cleanup preserved evidence because Windows emptiness was not proven before its deadline.");
    throw new Error("Launch cleanup did not produce verified emptiness before its deadline.");
  }
  private cleanupFenceEffect<T>(identity: Identity, effect: () => T): T {
    if (!identity.fence) return effect(); // Explicit legacy fixture compatibility; all current launches persist a fence.
    return commitOwnedFenceEffect(identity, identity.fence, effect);
  }
  private hasTerminalStoppedProof(identity: Identity): boolean {
    const state = readState(identity.directory);
    if (state?.nonce !== identity.nonce || state.supervisorPid !== identity.supervisorPid ||
        state.status !== "stopped" || !Array.isArray(state.knownProcesses) ||
        !state.knownProcesses.every(validKnownProcess)) return false;
    if (this.options.platform === "posix")
      return state.launchEffect === "started" && state.rootProcess === null && state.knownProcesses.length === 0;
    if (state.launchEffect === "not_started") {
      return state.rootProcess === null && state.knownProcesses.length === 0;
    }
    return state.launchEffect === "started" && validKnownProcess(state.rootProcess) &&
      state.knownProcesses.some((process) => process.pid === state.rootProcess!.pid &&
        process.birth === state.rootProcess!.birth);
  }
  private async flushOutput(identity: Identity, output: (stream: ProcessOutputStream, bytes: Uint8Array) => Promise<void>): Promise<void> {
    const offsets = this.outputOffsets.get(identity.nonce) ?? { stdout: 0, stderr: 0 };
    for (const stream of ["stdout", "stderr"] as const) {
      const path = join(identity.directory, `${stream}.log`);
      let bytes: Buffer;
      try { bytes = readFileSync(path); } catch { continue; }
      if (bytes.length > offsets[stream]) await output(stream, bytes.subarray(offsets[stream]));
      offsets[stream] = bytes.length;
    }
    this.outputOffsets.set(identity.nonce, offsets);
  }
  private async waitForState(directory: string, nonce: string, pid: number, deadline: number): Promise<SupervisorState> {
    while (Date.now() < deadline) {
      const state = readState(directory);
      if (Date.now() >= deadline) break;
      if (state && state.nonce === nonce && state.supervisorPid === pid && state.status !== "preparing") return state;
      if (!pidAlive(pid)) throw new Error("Portable process supervisor exited before proving launch.");
      await delay(this.pollIntervalMs);
    }
    throw new Error("Portable process startup deadline is exhausted.");
  }
  private async waitForBirth(pid: number, deadline: number): Promise<string | undefined> {
    const maximumAttempts = this.options.platform === "windows" ? WINDOWS_BIRTH_INSPECTION_MAX_ATTEMPTS : Number.MAX_SAFE_INTEGER;
    let attempts = 0;
    let attemptDeadlineMs = Math.min(
      this.options.platform === "windows" ? WINDOWS_SUPERVISOR_BIRTH_INSPECTION_DEADLINE_MS : 1_000,
      PROCESS_BIRTH_INITIAL_INSPECTION_DEADLINE_MS,
      Math.max(1, deadline - Date.now()),
    );
    while (Date.now() < deadline && attempts < maximumAttempts) {
      attemptDeadlineMs = Math.max(1, Math.min(attemptDeadlineMs, deadline - Date.now()));
      const inspection = this.operations.inspectProcessBirth(pid, this.options.platform, attemptDeadlineMs);
      attempts += 1;
      if (Date.now() >= deadline) return undefined;
      if (inspection.state === "present") return inspection.fingerprint;
      if (inspection.state === "absent") return undefined;
      attemptDeadlineMs = Math.min(WINDOWS_SUPERVISOR_BIRTH_INSPECTION_DEADLINE_MS, attemptDeadlineMs * 2);
      if (attempts >= maximumAttempts) break;
      await delay(this.pollIntervalMs);
    }
    return undefined;
  }
}

function readState(directory: string): SupervisorState | undefined {
  try { return JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as SupervisorState; } catch { return undefined; }
}
function osProcessBirth(
  pid: number,
  platform: "posix" | "windows",
  attemptDeadlineMs = PROCESS_BIRTH_INITIAL_INSPECTION_DEADLINE_MS,
): ProcessBirthInspection {
  const boundedDeadlineMs = Math.max(1, Math.min(WINDOWS_SUPERVISOR_BIRTH_INSPECTION_DEADLINE_MS, attemptDeadlineMs));
  try {
    if (platform === "windows") {
      try { process.kill(pid, 0); }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? { state: "absent" } : { state: "unknown" }; }
      const result = execFileSync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop';$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($null -eq $p){'ABSENT'}else{'PRESENT:'+$p.StartTime.ToUniversalTime().ToString('o')}`,
      ], { encoding: "utf8", windowsHide: true, timeout: boundedDeadlineMs }).trim();
      if (result === "ABSENT") return { state: "absent" };
      if (result.startsWith("PRESENT:") && result.length > "PRESENT:".length)
        return { state: "present", fingerprint: normalizeProcessBirth(result.slice("PRESENT:".length)) };
      return { state: "unknown" };
    }
    if (process.platform === "linux") {
      try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).split(" ");
        return fields[19]
          ? { state: "present", fingerprint: `proc-start:${fields[19]}` }
          : { state: "unknown" };
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "unknown" };
      }
    }
    const result = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: boundedDeadlineMs }).trim();
    return result ? { state: "present", fingerprint: result } : { state: "absent" };
  } catch { return { state: "unknown" }; }
}
function osProcessBirths(pids: readonly number[], platform: "posix" | "windows"): ReadonlyMap<number, ProcessBirthInspection> | undefined {
  if (platform !== "windows" || pids.length < 1 || pids.length > 256 || pids.some((pid) => !Number.isSafeInteger(pid) || pid < 1)) return undefined;
  try {
    const result = new Map<number, ProcessBirthInspection>();
    const live: number[] = [];
    for (const pid of pids) {
      try { process.kill(pid, 0); live.push(pid); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return undefined;
        result.set(pid, { state: "absent" });
      }
    }
    if (live.length === 0) return result;
    const ids = live.join(",");
    const output = execFileSync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop';foreach($processId in @(${ids})){try{$p=Get-Process -Id $processId -ErrorAction Stop;if($null-eq$p-or$null-eq$p.StartTime){"VANISHED|$processId"}else{"$($p.Id)|$($p.StartTime.ToUniversalTime().ToString('o'))"}}catch{if($_.FullyQualifiedErrorId.StartsWith('NoProcessFoundForGivenId,')){"VANISHED|$processId"}else{throw}}}`,
    ], { encoding: "utf8", windowsHide: true, timeout: 2_000 }).trim();
    const requested = new Set(live);
    for (const pid of live) result.set(pid, { state: "absent" });
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const separator = line.indexOf("|");
      if (line.startsWith("VANISHED|")) {
        const pid = Number(line.slice(separator + 1));
        if (!requested.has(pid)) return undefined;
        try { process.kill(pid, 0); return undefined; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return undefined; }
        continue;
      }
      const pid = Number(line.slice(0, separator));
      const birth = line.slice(separator + 1);
      if (separator < 1 || !requested.has(pid) || !birth || result.get(pid)?.state === "present") return undefined;
      result.set(pid, { state: "present", fingerprint: normalizeProcessBirth(birth) });
    }
    return result;
  } catch { return undefined; }
}
function osPosixGroupMembers(groupId: number): number[] | undefined {
  try {
    return execFileSync("ps", ["-e", "-o", "pid=,pgid="], { encoding: "utf8", timeout: 2_000 })
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([, pgid]) => pgid === groupId)
      .map(([pid]) => pid!)
      .filter((pid) => pid > 0);
  } catch { return undefined; }
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
const DEFAULT_OPERATIONS: NativeProcessOperations = {
  inspectProcessBirth: osProcessBirth,
  inspectProcessBirths: osProcessBirths,
  listPosixGroup: osPosixGroupMembers,
  signal: (pid, signal) => process.kill(pid, signal),
};
function validKnownProcess(value: unknown): value is { readonly pid: number; readonly birth: string } {
  return !!value && typeof value === "object" &&
    Number.isSafeInteger((value as { pid?: unknown }).pid) &&
    typeof (value as { birth?: unknown }).birth === "string" &&
    (value as { birth: string }).birth.length > 0;
}
function normalizeProcessBirth(value: string): string {
  return value.replace(/(\.\d{6})\d+(Z)$/, "$1$2");
}
function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
}
function sameProcessBirth(left: string, right: string): boolean {
  return normalizeProcessBirth(left) === normalizeProcessBirth(right);
}
function launchResult(identity: Identity, startedAt: string) {
  return {
    opaqueIdentity: Buffer.from(JSON.stringify(identity)).toString("base64url"),
    birthFingerprint: {
      observedAt: startedAt,
      discriminator: birthDiscriminator(identity),
    },
    rootPid: identity.supervisorPid,
    startedAt,
  };
}
function birthDiscriminator(identity: Pick<Identity, "nonce" | "supervisorBirth" | "fence">): string {
  return createHash("sha256").update(`${identity.nonce}\0${identity.supervisorBirth}`).digest("hex");
}

function claimOwnedFence(identity: Identity, candidate: ProcessEffectFence): void {
  if (!candidate.ownerId || !Number.isSafeInteger(candidate.fencingToken) || candidate.fencingToken < 1)
    throw new OwnedProcessIdentityMismatchError("Owned process writer fence is invalid.");
  const path = join(identity.directory, "fence.json");
  const lock = join(identity.directory, ".fence.lock");
  try {
    withOwnedFenceLockSync(lock, () => {
      if (!existsSync(path) && !identity.fence) {
        const temporary = `${path}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify({ nonce: identity.nonce, ...candidate }), { mode: 0o600 });
        renameSync(temporary, path);
        return;
      }
      const current = readOwnedFence(path, identity);
      if (candidate.fencingToken < current.fencingToken ||
          (candidate.fencingToken === current.fencingToken && candidate.ownerId !== current.ownerId))
        throw new OwnedProcessIdentityMismatchError("Owned process writer fence is stale.");
      if (candidate.fencingToken > current.fencingToken) {
        const temporary = `${path}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify({ nonce: identity.nonce, ...candidate }), { mode: 0o600 });
        renameSync(temporary, path);
      }
    });
  } catch (error) {
    if (error instanceof OwnedProcessIdentityMismatchError) throw error;
    throw new OwnedProcessIdentityMismatchError("Owned process writer fence claim is unavailable.", { cause: error });
  }
}
function commitOwnedFenceEffect<T>(identity: Identity, candidate: ProcessEffectFence, effect: () => T): T {
  const path = join(identity.directory, "fence.json");
  const lock = join(identity.directory, ".fence.lock");
  try {
    return withOwnedFenceLockSync(lock, () => {
      const current = readOwnedFence(path, identity);
      if (candidate.ownerId !== current.ownerId || candidate.fencingToken !== current.fencingToken)
        throw new OwnedProcessIdentityMismatchError("Owned process writer fence is stale at the effect boundary.");
      return effect();
    });
  } catch (error) {
    if (error instanceof OwnedProcessIdentityMismatchError) throw error;
    throw new OwnedProcessIdentityMismatchError("Owned process writer fence effect boundary is unavailable.", { cause: error });
  }
}
async function commitOwnedFenceEffectAsync<T>(identity: Identity, candidate: ProcessEffectFence, effect: () => T | Promise<T>, retireAuthority?: () => void): Promise<T> {
  const path = join(identity.directory, "fence.json");
  const lock = join(identity.directory, ".fence.lock");
  try {
    return await withOwnedFenceLock(lock, () => {
      const current = readOwnedFence(path, identity);
      if (candidate.ownerId !== current.ownerId || candidate.fencingToken !== current.fencingToken)
        throw new OwnedProcessIdentityMismatchError("Owned process writer fence is stale at the effect boundary.");
      return effect();
    }, { retireAfterEffect: Boolean(retireAuthority), ...(retireAuthority ? { retireAuthority } : {}) });
  } catch (error) {
    if (error instanceof OwnedProcessIdentityMismatchError) throw error;
    throw new OwnedProcessIdentityMismatchError("Owned process writer fence effect boundary is unavailable.", { cause: error });
  }
}
function removeRetiredAuthorityDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}
function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (pattern.test(current instanceof Error ? current.message : String(current))) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}
function errorChainHas(error: unknown, constructor: new (...args: never[]) => Error): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof constructor) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}
function readOwnedFence(path: string, identity: Identity): ProcessEffectFence {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value.nonce !== identity.nonce || typeof value.ownerId !== "string" || !Number.isSafeInteger(value.fencingToken)) throw new Error();
    return { ownerId: value.ownerId, fencingToken: value.fencingToken };
  } catch {
    throw new OwnedProcessIdentityMismatchError("Owned process writer fence evidence is invalid.");
  }
}
function assertPortableOutputSettled(identity: Identity): void {
  const checkpointPath = join(identity.directory, "channel", "output-checkpoint.json");
  try {
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    if (checkpoint.nonce !== identity.nonce) throw new Error();
    for (const stream of ["stdout", "stderr"] as const) {
      if (!Number.isSafeInteger(checkpoint[stream]?.sequence) || checkpoint[stream].sequence < 0 ||
          !Number.isSafeInteger(checkpoint[stream]?.endOffset) || checkpoint[stream].endOffset < 0) throw new Error();
    }
  } catch (error) {
    throw new Error("Portable output checkpoint evidence is missing or unreadable.", { cause: error });
  }
  const outputDirectory = join(identity.directory, "channel", "output");
  let outputEntries: string[];
  try { outputEntries = readdirSync(outputDirectory); } catch (error) {
    throw new Error("Portable output ownership evidence is missing or unreadable.", { cause: error });
  }
  if (outputEntries.length > 0) throw new Error("Portable output ownership is unsettled; release is refused.");
  const acknowledgements = validatePortableAcknowledgementEvidence(
    join(identity.directory, "channel", "ack"), identity.nonce, [],
  );
  if (acknowledgements.some((name) => /^(stdout|stderr)-/.test(name)))
    throw new Error("Portable output ownership is unsettled; release is refused.");
}
function launchBlocker(identity: Identity, message: string): NativeProcessLaunchBlockedError {
  const state = readState(identity.directory);
  const startedAt = state?.updatedAt ?? new Date().toISOString();
  const detail = `${message} Evidence retained at ${identity.directory}.`;
  return new NativeProcessLaunchBlockedError(
    [new Error(detail)],
    identity.directory,
    launchResult(identity, startedAt),
    detail,
  );
}
