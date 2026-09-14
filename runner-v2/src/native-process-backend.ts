import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ProcessBackend,
  ProcessBackendBinding,
  ProcessEffectFence,
  ProcessLaunchRequest,
} from "./process-backend.js";
import type { ExecutionSafetyCapabilities, ProcessEscalationAction, ProcessOutputStream } from "./execution-safety-contracts.js";
import { createPortableProcessChannelProvider, validatePortableAcknowledgementEvidence } from "./portable-process-channel.js";
import { PortableOutputRetirementBlockedError, runPortableFenceSnapshotSync } from "./portable-process-protocol.mjs";
import { OwnedFenceAuthorityRetirementError, retiredOwnedFenceCleanupAvailable, retryRetiredOwnedFenceCleanup, withOwnedFenceLock, withOwnedFenceLockSync } from "./owned-fence-lock.mjs";

const PROCESS_BIRTH_INITIAL_INSPECTION_DEADLINE_MS = 2_000;
const WINDOWS_SUPERVISOR_BIRTH_INSPECTION_DEADLINE_MS = 15_000;
const PROCESS_MEMBERSHIP_INSPECTION_DEADLINE_MS = 15_000;
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
  /** Bounded, cancellable observation; completion includes inspection-child close. */
  inspectProcessBirthAsync?(pid: number, platform: "posix" | "windows", signal: AbortSignal): Promise<ProcessBirthInspection>;
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

interface LegacyIdentity {
  readonly version: 1;
  readonly backendId: string;
  readonly nonce: string;
  readonly directory: string;
  readonly supervisorPid: number;
  readonly supervisorBirth: string;
  readonly fence?: ProcessEffectFence;
}
interface PosixWorkloadGroup {
  readonly groupId: number;
  readonly leaderPid: number;
  readonly leaderBirth: string;
}
interface PosixIdentity {
  readonly version: 2;
  readonly backendId: string;
  readonly nonce: string;
  readonly directory: string;
  /** The retained control/output witness; this remains binding.rootPid. */
  readonly supervisorPid: number;
  readonly supervisorBirth: string;
  readonly workloadGroup: PosixWorkloadGroup;
  readonly fence?: ProcessEffectFence;
}
type Identity = LegacyIdentity | PosixIdentity;
type ProcessBirthDiscovery =
  | { readonly state: "present"; readonly fingerprint: string; readonly deadlineExpired: boolean }
  | { readonly state: "absent" | "unknown"; readonly deadlineExpired: boolean };
interface SupervisorStateBase {
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
interface LegacySupervisorState extends SupervisorStateBase {
  readonly protocol: "aiboard-portable-process/v1";
}
interface PosixSupervisorStateV2 extends Omit<SupervisorStateBase, "protocol"> {
  readonly protocol: "aiboard-portable-process/v2";
  readonly supervisorBirth: string;
  readonly workloadGroup: PosixWorkloadGroup;
  readonly workloadGroupRetirement:
    | { readonly state: "active" }
    | { readonly state: "retired"; readonly cause: "anchor_release" | "force_terminate"; readonly at: string };
}
type SupervisorState = LegacySupervisorState | PosixSupervisorStateV2;
type WindowsMembershipSnapshot =
  | { readonly state: "ready"; readonly emptiness: "empty" | "nonempty"; readonly handledControl: number }
  | { readonly state: "identity_mismatch" }
  | { readonly state: "outcome_unknown" };
type PosixWorkloadSnapshot =
  | { readonly state: "ready"; readonly value: PosixSupervisorStateV2 }
  | { readonly state: "identity_mismatch" }
  | { readonly state: "outcome_unknown" };
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
    const windowsHelpers = this.options.platform === "windows"
      ? windowsPortableSupervisorHelpers(request.environment)
      : {};
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
      ...windowsHelpers,
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
    let supervisorBirthFingerprint: string | undefined;
    try {
      if (Date.now() >= startupDeadline) throw new Error("Portable process startup deadline is exhausted.");
      const supervisorBirth = await this.waitForBirth(child.pid, startupDeadline);
      if (supervisorBirth.state === "present") {
        supervisorBirthFingerprint = supervisorBirth.fingerprint;
        if (this.options.platform === "windows") {
          identity = {
            version: 1,
            backendId: this.options.backendId,
            nonce,
            directory,
            supervisorPid: child.pid,
            supervisorBirth: supervisorBirth.fingerprint,
            fence: Object.freeze({ ...request.fence }),
          };
        }
        // A late exact birth is not launch success authority. It is retained
        // only so a matching supervisor can bind the child barrier to its
        // durable birth before this caller accepts any launch state.
        writeFileSync(join(directory, "lock-holder.json"), JSON.stringify({
          nonce, holderPid: child.pid, holderBirth: supervisorBirth.fingerprint,
        }), { mode: 0o600 });
      }
      if (Date.now() >= startupDeadline) throw new Error("Portable process startup deadline is exhausted.");
      if (supervisorBirth.deadlineExpired) throw new Error("Portable supervisor birth discovery deadline is exhausted.");
      if (!supervisorBirthFingerprint) throw new Error("Portable supervisor birth identity is unavailable.");
      const state = await this.waitForState(directory, nonce, child.pid, startupDeadline);
      if (this.options.platform === "posix") {
        if (!isValidPosixSupervisorStateV2(state) || state.supervisorBirth !== supervisorBirthFingerprint)
          throw new Error("Portable POSIX workload identity was not durably published before launch acceptance.");
        identity = {
          version: 2,
          backendId: this.options.backendId,
          nonce,
          directory,
          supervisorPid: child.pid,
          supervisorBirth: supervisorBirthFingerprint,
          workloadGroup: state.workloadGroup,
          fence: Object.freeze({ ...request.fence }),
        };
      }
      if (!identity) throw new Error("Portable supervisor identity is unavailable.");
      if (state.status !== "running") throw new Error(state.error ?? "Portable process launch failed.");
      const startedAt = state.updatedAt;
      return launchResult(identity, startedAt);
    } catch (error) {
      if (!identity) {
        const failedState = readState(directory);
        if (this.options.platform === "windows" &&
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
          reattestObservation: async (signal) => {
            this.assertDurableFence(identity, fence);
            const inspection = this.operations.inspectProcessBirthAsync
              ? await this.operations.inspectProcessBirthAsync(identity.supervisorPid, this.options.platform, signal)
              : this.operations.inspectProcessBirth(identity.supervisorPid, this.options.platform);
            // Never reuse pre-wait ownership or POSIX identity as current authority.
            if (signal.aborted) throw new Error("Portable channel observation cancelled.");
            this.assertDurableFence(identity, fence);
            if (identity.version === 2 && this.posixWorkloadSnapshot(identity).state !== "ready")
              throw new Error("Portable channel workload identity re-attestation failed.");
            if (inspection.state === "unknown" || inspection.state === "present" && !sameProcessBirth(inspection.fingerprint, identity.supervisorBirth))
              throw new Error("Portable channel identity re-attestation failed.");
            return inspection.state === "present" ? "live" : "exited";
          },
          effect: (kind, effect) => {
            const preparation = this.options.beforeFenceEffect?.(kind);
            return preparation
              ? Promise.resolve(preparation).then(() => commitOwnedFenceEffectAsync(identity, fence, effect))
              : commitOwnedFenceEffectAsync(identity, fence, effect);
          },
          snapshot: (read) => runPortableFenceSnapshotSync({
            lockPath: join(identity.directory, ".fence.lock"),
            expectedFence: fence,
            readCurrentFence: () => readOwnedFence(join(identity.directory, "fence.json"), identity),
            read,
          }),
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
      throw new Error("Owned POSIX supervisor exited before durable workload-group retirement was proven.");
    }
    if (this.options.platform === "posix") {
      if (identity.version !== 2)
        throw new Error("Active legacy POSIX ownership cannot be safely reinterpreted as a workload group.");
      const control = this.posixWorkloadSnapshot(identity);
      if (control.state === "identity_mismatch") throw new Error("Owned POSIX workload identity mismatch.");
      if (control.state === "outcome_unknown") throw new Error("Owned POSIX workload anchor is unavailable.");
      if (control.value.workloadGroupRetirement.state === "retired") return { state: "exited" };
      await this.fencedEffect(identity, _fence, "signal", () => {
        const exact = this.posixWorkloadSnapshot(identity);
        if (exact.state === "identity_mismatch") throw new OwnedProcessIdentityMismatchError("Owned POSIX workload identity changed before control.");
        if (exact.state === "outcome_unknown" || exact.value.workloadGroupRetirement.state === "retired")
          throw new Error("Owned POSIX workload anchor is unavailable before control.");
        writeJsonAtomic(join(identity.directory, "control.json"), {
          nonce: identity.nonce,
          ownerId: _fence!.ownerId,
          fencingToken: _fence!.fencingToken,
          sequence: exact.value.handledControl + 1,
          action,
        });
      });
    } else {
      const observedState = readState(identity.directory);
      let beforeSignal = observedState?.status === "outcome_unknown"
        ? this.windowsMembershipSnapshot(identity, true)
        : await this.waitForKnownEmptiness(identity);
      if (typeof beforeSignal !== "string")
        beforeSignal = beforeSignal.state === "ready" ? beforeSignal.emptiness : beforeSignal.state;
      if (beforeSignal === "identity_mismatch") throw new Error("Owned descendant identity mismatch.");
      if (beforeSignal === "outcome_unknown") throw new Error("Owned descendant identity is unavailable.");
      await this.fencedEffect(identity, _fence, "signal", () => {
        // A failed Windows tree operation is intentionally durable as
        // outcome_unknown. A higher-sequence retry is safe only after a fresh
        // exact PID+birth snapshot at the fenced effect boundary. The
        // supervisor independently inventories the tree again before acting.
        const control = this.windowsMembershipSnapshot(identity, true);
        if (control.state === "identity_mismatch") throw new OwnedProcessIdentityMismatchError("Owned descendant identity mismatch.");
        if (control.state === "outcome_unknown") throw new Error("Owned descendant identity is unavailable.");
        writeJsonAtomic(join(identity.directory, "control.json"), {
          nonce: identity.nonce,
          ownerId: _fence!.ownerId,
          fencingToken: _fence!.fencingToken,
          sequence: control.handledControl + 1,
          action,
        });
      });
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
        try { assertPortableOutputSettledAtFence(identity, _fence); } catch { return { empty: false, detail: "Owned output evidence is unsettled or unavailable." }; }
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
    try { assertPortableOutputSettledAtFence(identity, _fence); }
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
    const authorityRetired = retiredOwnedFenceCleanupAvailable(lockPath);
    if (authorityRetired) this.assertDurableFence(identity, _fence);
    else this.assertFence(identity, _fence);
    const assertOutputSettled = authorityRetired
      ? () => assertPortableOutputSettled(identity)
      : () => assertPortableOutputSettledAtFence(identity, _fence);
    const validation = this.validate(identity);
    if (validation === "mismatch" || validation === "unknown") throw new Error("Cannot release ownership without exact supervisor birth re-attestation.");
    if (this.options.platform === "posix" && identity.version === 2 && validation !== "exited")
      throw new Error("Cannot release POSIX workload authority while its terminal supervisor witness is still alive.");
    const emptiness = await this.emptiness(identity);
    if (emptiness !== "empty")
      throw new Error(emptiness === "outcome_unknown" ? "Cannot release ownership with unknown empty verification." : "Cannot release non-empty owned process identity.");
    assertOutputSettled();
    if (!this.hasTerminalStoppedProof(identity)) throw new Error("Cannot release ownership without durable terminal state proof.");
    const stableValidation = this.validate(identity);
    if (stableValidation === "mismatch" || stableValidation === "unknown") throw new Error("Cannot release ownership after supervisor birth changed.");
    const stableEmptiness = await this.emptiness(identity);
    if (stableEmptiness !== "empty") throw new Error("Cannot release ownership without stable verified emptiness.");
    assertOutputSettled();
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
    const value = JSON.parse(Buffer.from(binding.opaqueIdentity, "base64url").toString("utf8")) as OpaqueIdentityInput;
    if (!validIdentityBase(value) || value.backendId !== this.options.backendId)
      throw new Error("Owned process opaque identity is invalid.");
    if (value.version === 1) {
      const identity = value as LegacyIdentity;
      const expected = birthDiscriminator(identity);
      if (binding.birthFingerprint.discriminator !== expected || binding.rootPid !== identity.supervisorPid)
        throw new OwnedProcessIdentityMismatchError("Owned process birth fingerprint is invalid.");
      return identity;
    }
    if (this.options.platform !== "posix" || value.version !== 2 || !validPosixWorkloadGroup(value.workloadGroup))
      throw new Error("Owned process opaque identity is invalid.");
    const identity = value as PosixIdentity;
    if (identity.workloadGroup.groupId !== identity.workloadGroup.leaderPid)
      throw new Error("Owned POSIX workload group identity is invalid.");
    const expected = birthDiscriminator(identity);
    if (binding.birthFingerprint.discriminator !== expected || binding.rootPid !== identity.supervisorPid)
      throw new OwnedProcessIdentityMismatchError("Owned process birth fingerprint is invalid.");
    return identity;
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
    if (identity.version === 2) {
      const state = this.posixWorkloadSnapshot(identity);
      if (state.state === "identity_mismatch") return "mismatch";
      if (state.state === "outcome_unknown") return "unknown";
    }
    const inspection = this.operations.inspectProcessBirth(identity.supervisorPid, this.options.platform);
    if (inspection.state === "unknown") return "unknown";
    if (inspection.state === "absent") return "exited";
    return sameProcessBirth(inspection.fingerprint, identity.supervisorBirth) ? "live" : "mismatch";
  }
  private emptiness(identity: Identity): "empty" | "nonempty" | "identity_mismatch" | "outcome_unknown" {
    if (this.options.platform === "posix") {
      if (identity.version === 1) {
        const members = this.operations.listPosixGroup(identity.supervisorPid);
        return members === undefined ? "outcome_unknown" : members.length === 0 ? "empty" : "nonempty";
      }
      const snapshot = this.posixWorkloadSnapshot(identity);
      if (snapshot.state !== "ready") return snapshot.state;
      if (snapshot.value.workloadGroupRetirement.state === "retired") return "empty";
      const inspection = this.operations.inspectProcessBirth(identity.workloadGroup.leaderPid, "posix");
      if (inspection.state === "unknown") return "outcome_unknown";
      if (inspection.state === "absent") return "outcome_unknown";
      if (!sameProcessBirth(inspection.fingerprint, identity.workloadGroup.leaderBirth)) return "identity_mismatch";
      const members = this.operations.listPosixGroup(identity.workloadGroup.groupId);
      if (members === undefined || !members.includes(identity.workloadGroup.leaderPid)) return "outcome_unknown";
      return "nonempty";
    }
    const snapshot = this.windowsMembershipSnapshot(identity, false);
    return snapshot.state === "ready" ? snapshot.emptiness : snapshot.state;
  }
  private posixWorkloadSnapshot(identity: PosixIdentity): PosixWorkloadSnapshot {
    const state = readState(identity.directory);
    if (!state) return { state: "outcome_unknown" };
    if (!isValidPosixSupervisorStateV2(state) || !samePosixWorkloadIdentity(state, identity))
      return { state: "identity_mismatch" };
    return { state: "ready", value: state };
  }
  private windowsMembershipSnapshot(identity: Identity, allowOutcomeUnknownStatus: boolean): WindowsMembershipSnapshot {
    const state = readState(identity.directory);
    if (!state || state.protocol !== "aiboard-portable-process/v1" || !Array.isArray(state.knownProcesses))
      return { state: "outcome_unknown" };
    if (state.nonce !== identity.nonce || state.supervisorPid !== identity.supervisorPid)
      return { state: "identity_mismatch" };
    if (!Number.isSafeInteger(state.handledControl) || state.handledControl < 0)
      return { state: "outcome_unknown" };
    if ((state.status === "outcome_unknown" && !allowOutcomeUnknownStatus) || state.launchEffect === "unknown")
      return { state: "outcome_unknown" };
    if (state.launchEffect === "not_started")
      return state.knownProcesses.length === 0
        ? { state: "ready", emptiness: "empty", handledControl: state.handledControl }
        : { state: "outcome_unknown" };
    if (
      state.launchEffect !== "started" ||
      !validKnownProcess(state.rootProcess) ||
      !state.knownProcesses.some((process) => process.pid === state.rootProcess!.pid && process.birth === state.rootProcess!.birth)
    ) return { state: "outcome_unknown" };
    const seen = new Set<number>();
    for (const process of state.knownProcesses) {
      if (!validKnownProcess(process) || seen.has(process.pid)) return { state: "outcome_unknown" };
      seen.add(process.pid);
    }
    const pids = state.knownProcesses.map(({ pid }) => pid);
    const inspections = this.operations.inspectProcessBirths
      ? this.operations.inspectProcessBirths(pids, "windows")
      : undefined;
    if (this.operations.inspectProcessBirths && !inspections) return { state: "outcome_unknown" };
    let live = false;
    for (const process of state.knownProcesses) {
      const inspection = inspections?.get(process.pid) ?? (
        this.operations.inspectProcessBirths ? { state: "unknown" } : this.operations.inspectProcessBirth(process.pid, "windows")
      );
      if (inspection.state === "unknown") return { state: "outcome_unknown" };
      if (inspection.state === "absent") continue;
      // PID plus birth is the owned identity. A different exact birth proves
      // the historical identity is absent; the live replacement is unrelated.
      if (!sameProcessBirth(inspection.fingerprint, process.birth)) continue;
      live = true;
    }
    return {
      state: "ready",
      emptiness: live ? "nonempty" : "empty",
      handledControl: state.handledControl,
    };
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
    if (this.options.platform === "posix") {
      if (identity.version !== 2) {
        if (validation === "exited" && this.hasTerminalStoppedProof(identity)) return;
        throw launchBlocker(identity, "Launch cleanup retained active legacy POSIX authority because it cannot be safely reinterpreted as a workload group.");
      }
      const initial = this.posixWorkloadSnapshot(identity);
      if (initial.state === "identity_mismatch") throw new Error("Launch cleanup refused a changed POSIX workload identity.");
      if (initial.state === "outcome_unknown") throw launchBlocker(identity, "Launch cleanup could not read the durable POSIX workload identity.");
      if (initial.value.workloadGroupRetirement.state === "active") {
        if (validation !== "live") throw launchBlocker(identity, "Launch cleanup preserved POSIX authority because its supervisor exited before workload retirement proof.");
        this.cleanupFenceEffect(identity, () => {
          const exact = this.posixWorkloadSnapshot(identity);
          if (exact.state !== "ready" || exact.value.workloadGroupRetirement.state !== "active" || this.validate(identity) !== "live")
            throw new OwnedProcessIdentityMismatchError("Launch cleanup lost its exact POSIX anchor before control.");
          writeJsonAtomic(join(identity.directory, "control.json"), {
            nonce: identity.nonce,
            ownerId: identity.fence!.ownerId,
            fencingToken: identity.fence!.fencingToken,
            sequence: exact.value.handledControl + 1,
            action: "force_terminate",
          });
        });
      }
      let emptySince: number | undefined;
      while (Date.now() < deadline) {
        const snapshot = this.posixWorkloadSnapshot(identity);
        if (snapshot.state === "identity_mismatch") throw new Error("Launch cleanup observed a changed POSIX workload identity.");
        if (snapshot.state === "outcome_unknown") throw launchBlocker(identity, "Launch cleanup lost durable POSIX workload retirement evidence.");
        const emptiness = await this.emptiness(identity);
        if (emptiness === "identity_mismatch") throw new Error("Launch cleanup observed a recycled owned identity.");
        if (emptiness === "outcome_unknown") throw launchBlocker(identity, "Launch cleanup lost POSIX workload membership verification.");
        validation = this.validate(identity);
        if (validation === "mismatch") throw new Error("Launch cleanup observed a recycled supervisor identity.");
        if (validation === "unknown") throw launchBlocker(identity, "Launch cleanup lost its supervisor birth inspection.");
        if (emptiness === "empty" && validation === "exited" && this.hasTerminalStoppedProof(identity)) {
          try { assertPortableOutputSettled(identity); }
          catch (error) { throw launchBlocker(identity, `Launch cleanup preserved POSIX authority because output settlement is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
          emptySince ??= Date.now();
          if (Date.now() - emptySince >= 100) return;
        } else emptySince = undefined;
        await delay(this.pollIntervalMs);
      }
      throw launchBlocker(identity, "Launch cleanup preserved POSIX authority because causal retirement and supervisor exit were not proven before its deadline.");
    }
    if (this.options.platform === "windows" && validation === "exited" && this.hasTerminalStoppedProof(identity)) {
      const proof = readState(identity.directory)!;
      await delay(Math.max(100, this.pollIntervalMs * 2));
      const stable = readState(identity.directory);
      if (stable?.nonce === proof.nonce && stable.supervisorPid === proof.supervisorPid &&
          stable.revision === proof.revision && stable.status === "stopped") return;
      throw launchBlocker(identity, "Launch cleanup lost its stable terminal Windows supervisor proof.");
    }
    if (validation === "live") {
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
    if (this.options.platform === "posix" && identity.version === 2) {
      return isValidPosixSupervisorStateV2(state) && samePosixWorkloadIdentity(state, identity) &&
        state.workloadGroupRetirement.state === "retired" &&
        (state.launchEffect === "prepared" || state.launchEffect === "started") &&
        state.rootProcess === null && state.knownProcesses.length === 0;
    }
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
  private async waitForBirth(pid: number, startupDeadline: number): Promise<ProcessBirthDiscovery> {
    const discoveryLimitMs = this.options.platform === "windows" ? WINDOWS_SUPERVISOR_BIRTH_INSPECTION_DEADLINE_MS : 1_000;
    const deadline = Math.min(startupDeadline, Date.now() + discoveryLimitMs);
    const maximumAttempts = this.options.platform === "windows" ? WINDOWS_BIRTH_INSPECTION_MAX_ATTEMPTS : Number.MAX_SAFE_INTEGER;
    let attempts = 0;
    let attemptDeadlineMs = Math.min(
      discoveryLimitMs,
      PROCESS_BIRTH_INITIAL_INSPECTION_DEADLINE_MS,
      Math.max(1, deadline - Date.now()),
    );
    while (Date.now() < deadline && attempts < maximumAttempts) {
      attemptDeadlineMs = Math.max(1, Math.min(attemptDeadlineMs, deadline - Date.now()));
      const inspection = this.operations.inspectProcessBirth(pid, this.options.platform, attemptDeadlineMs);
      attempts += 1;
      const deadlineExpired = Date.now() >= deadline;
      if (inspection.state === "present") return { ...inspection, deadlineExpired };
      if (inspection.state === "absent") return { state: "absent", deadlineExpired };
      if (deadlineExpired) return { state: "unknown", deadlineExpired: true };
      attemptDeadlineMs = Math.min(discoveryLimitMs, attemptDeadlineMs * 2);
      if (attempts >= maximumAttempts) break;
      await delay(this.pollIntervalMs);
    }
    return { state: "unknown", deadlineExpired: Date.now() >= deadline };
  }
}

function readState(directory: string): SupervisorState | undefined {
  try { return JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as SupervisorState; } catch { return undefined; }
}
interface OpaqueIdentityInput {
  readonly version?: unknown;
  readonly backendId?: unknown;
  readonly nonce?: unknown;
  readonly directory?: unknown;
  readonly supervisorPid?: unknown;
  readonly supervisorBirth?: unknown;
  readonly workloadGroup?: unknown;
  readonly fence?: unknown;
}
function validIdentityBase(value: OpaqueIdentityInput): value is OpaqueIdentityInput & {
  readonly version: 1 | 2;
  readonly backendId: string;
  readonly nonce: string;
  readonly directory: string;
  readonly supervisorPid: number;
  readonly supervisorBirth: string;
} {
  return (value.version === 1 || value.version === 2) && typeof value.backendId === "string" && value.backendId.length > 0 &&
    typeof value.nonce === "string" && value.nonce.length > 0 && typeof value.directory === "string" && value.directory.length > 0 &&
    typeof value.supervisorPid === "number" && Number.isSafeInteger(value.supervisorPid) && value.supervisorPid > 0 &&
    typeof value.supervisorBirth === "string" && value.supervisorBirth.length > 0;
}
function validPosixWorkloadGroup(value: unknown): value is PosixWorkloadGroup {
  if (!value || typeof value !== "object") return false;
  const group = value as Partial<PosixWorkloadGroup>;
  const groupId = group.groupId;
  const leaderPid = group.leaderPid;
  return typeof groupId === "number" && Number.isSafeInteger(groupId) && groupId > 0 &&
    typeof leaderPid === "number" && Number.isSafeInteger(leaderPid) && leaderPid > 0 &&
    typeof group.leaderBirth === "string" && group.leaderBirth.length > 0;
}
function isValidPosixSupervisorStateV2(value: SupervisorState): value is PosixSupervisorStateV2 {
  if (value.protocol !== "aiboard-portable-process/v2") return false;
  const state = value as Partial<PosixSupervisorStateV2>;
  const supervisorPid = state.supervisorPid;
  const workloadGroup = state.workloadGroup;
  const revision = state.revision;
  const handledControl = state.handledControl;
  if (typeof state.nonce !== "string" || state.nonce.length === 0 || typeof supervisorPid !== "number" || !Number.isSafeInteger(supervisorPid) || supervisorPid < 1 ||
      typeof state.supervisorBirth !== "string" || state.supervisorBirth.length === 0 || !validPosixWorkloadGroup(workloadGroup) ||
      workloadGroup.groupId !== workloadGroup.leaderPid || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 ||
      typeof handledControl !== "number" || !Number.isSafeInteger(handledControl) || handledControl < 0 ||
      !["prepared", "started", "not_started", "unknown"].includes(String(state.launchEffect)) ||
      !["preparing", "running", "stopped", "outcome_unknown"].includes(String(state.status)) ||
      !Array.isArray(state.knownProcesses) || !state.knownProcesses.every(validKnownProcess) ||
      !(state.rootProcess === null || state.rootProcess === undefined || validKnownProcess(state.rootProcess)) ||
      !(state.exitCode === null || Number.isSafeInteger(state.exitCode)) ||
      !(state.signal === null || typeof state.signal === "string") ||
      !(state.error === null || typeof state.error === "string") || typeof state.updatedAt !== "string" || state.updatedAt.length === 0)
    return false;
  const retirement = state.workloadGroupRetirement;
  return !!retirement && typeof retirement === "object" &&
    (retirement.state === "active" || retirement.state === "retired" &&
      (retirement.cause === "anchor_release" || retirement.cause === "force_terminate") &&
      typeof retirement.at === "string" && retirement.at.length > 0);
}
function samePosixWorkloadIdentity(state: PosixSupervisorStateV2, identity: PosixIdentity): boolean {
  return state.nonce === identity.nonce && state.supervisorPid === identity.supervisorPid &&
    state.supervisorBirth === identity.supervisorBirth && state.workloadGroup.groupId === identity.workloadGroup.groupId &&
    state.workloadGroup.leaderPid === identity.workloadGroup.leaderPid &&
    state.workloadGroup.leaderBirth === identity.workloadGroup.leaderBirth;
}
async function osProcessBirthAsync(pid: number, platform: "posix" | "windows", signal: AbortSignal): Promise<ProcessBirthInspection> {
  if (signal.aborted) return { state: "unknown" };
  if (platform === "posix" && process.platform === "linux") {
    // /proc reads are bounded local reads and do not launch an inspection tool.
    return osProcessBirth(pid, platform);
  }
  if (platform === "windows") {
    try { process.kill(pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? { state: "absent" } : { state: "unknown" }; }
  }
  const command = platform === "windows" ? "powershell.exe" : "ps";
  const args = platform === "windows"
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsBirthCommand(pid)]
    : ["-o", "lstart=", "-p", String(pid)];
  return new Promise((resolveInspection) => {
    let inspection: ProcessBirthInspection = { state: "unknown" };
    const child = execFile(command, args, {
      encoding: "utf8", windowsHide: true, timeout: PROCESS_BIRTH_INITIAL_INSPECTION_DEADLINE_MS,
      maxBuffer: 64 * 1024, signal,
    }, (error, stdout) => {
      if (!error && !signal.aborted) inspection = parseBirthInspection(stdout.trim(), platform);
    });
    // Abort emits an early error callback. Retain the owned child until close,
    // so cancellation cannot leave inspection work outside the channel task.
    child.once("close", () => resolveInspection(signal.aborted ? { state: "unknown" } : inspection));
  });
}
function windowsBirthCommand(pid: number): string {
  return `$ErrorActionPreference='Stop';try{$p=Get-Process -Id ${pid} -ErrorAction Stop;$start=$p.StartTime;if($null-eq$start){throw 'PROCESS_BIRTH_UNAVAILABLE'};'PRESENT:'+$start.ToUniversalTime().ToString('o')}catch{$current=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($null-eq$current){'ABSENT'}else{throw}}`;
}
function parseBirthInspection(result: string, platform: "posix" | "windows"): ProcessBirthInspection {
  if (platform === "posix") return result ? { state: "present", fingerprint: result } : { state: "absent" };
  if (result === "ABSENT") return { state: "absent" };
  if (result.startsWith("PRESENT:") && result.length > "PRESENT:".length)
    return { state: "present", fingerprint: normalizeProcessBirth(result.slice("PRESENT:".length)) };
  return { state: "unknown" };
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
        windowsBirthCommand(pid),
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
      `$ErrorActionPreference='Stop';$requested=@(${ids});$found=@(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop|Where-Object{$requested-contains[int]$_.ProcessId});foreach($processId in $requested){$p=$found|Where-Object{[int]$_.ProcessId-eq$processId}|Select-Object -First 1;if($null-eq$p){"VANISHED|$processId"}elseif($null-eq$p.CreationDate){throw 'PROCESS_BIRTH_UNAVAILABLE'}else{"$($p.ProcessId)|$($p.CreationDate.ToUniversalTime().ToString('o'))"}}`,
    ], { encoding: "utf8", windowsHide: true, timeout: PROCESS_MEMBERSHIP_INSPECTION_DEADLINE_MS }).trim();
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
    return execFileSync("ps", ["-e", "-o", "pid=,pgid="], {
      encoding: "utf8",
      timeout: PROCESS_MEMBERSHIP_INSPECTION_DEADLINE_MS,
    })
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
  inspectProcessBirthAsync: osProcessBirthAsync,
  inspectProcessBirths: osProcessBirths,
  listPosixGroup: osPosixGroupMembers,
  signal: (pid, signal) => process.kill(pid, signal),
};
function validKnownProcess(value: unknown): value is { readonly pid: number; readonly birth: string } {
  return !!value && typeof value === "object" &&
    Number.isSafeInteger((value as { pid?: unknown }).pid) &&
    (value as { pid: number }).pid > 0 &&
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
function windowsPortableSupervisorHelpers(
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, Readonly<{ command: string }>>> {
  const value = (name: string): string | undefined => {
    const matches = Object.entries(environment)
      .filter(([key]) => key.toLowerCase() === name.toLowerCase())
      .map(([, candidate]) => candidate);
    return new Set(matches).size === 1 ? matches[0] : undefined;
  };
  const systemRoot = value("SystemRoot") ?? value("windir");
  if (!systemRoot || !isAbsolute(systemRoot)) {
    throw new Error("Portable Windows process launch requires an injected absolute SystemRoot.");
  }
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const taskkill = join(systemRoot, "System32", "taskkill.exe");
  if (!existsSync(powershell) || !existsSync(taskkill)) {
    throw new Error("Portable Windows process launch requires exact injected Windows helper identities.");
  }
  return Object.freeze({
    windowsTreeInspector: Object.freeze({ command: powershell }),
    windowsControlInspector: Object.freeze({ command: powershell }),
    windowsBirthInspector: Object.freeze({ command: powershell }),
    windowsTaskkill: Object.freeze({ command: taskkill }),
  });
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
function birthDiscriminator(identity: Identity): string {
  const payload = identity.version === 2
    ? `${identity.nonce}\0${identity.supervisorBirth}\0${identity.workloadGroup.groupId}\0${identity.workloadGroup.leaderPid}\0${identity.workloadGroup.leaderBirth}`
    : `${identity.nonce}\0${identity.supervisorBirth}`;
  return createHash("sha256").update(payload).digest("hex");
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
function assertPortableOutputSettledAtFence(identity: Identity, fence: ProcessEffectFence | undefined): void {
  if (!fence) throw new OwnedProcessIdentityMismatchError("Owned process writer fence is unavailable.");
  const snapshot = runPortableFenceSnapshotSync({
    lockPath: join(identity.directory, ".fence.lock"),
    expectedFence: fence,
    readCurrentFence: () => readOwnedFence(join(identity.directory, "fence.json"), identity),
    read: () => assertPortableOutputSettled(identity),
  });
  if (snapshot.status === "applied") return;
  if (snapshot.status === "stale") throw new OwnedProcessIdentityMismatchError("Owned process writer fence is stale at the output snapshot boundary.");
  throw snapshot.error instanceof Error ? snapshot.error : new Error("Portable output settlement snapshot is unavailable.");
}

function assertPortableOutputSettled(identity: Identity): void {
  if (existsSync(join(identity.directory, "channel", "output-retirement.json")))
    throw new PortableOutputRetirementBlockedError("Portable output retirement intent is not finalized.");
  const checkpointPath = join(identity.directory, "channel", "output-checkpoint.json");
  let checkpoint: {
    readonly nonce: string;
    readonly stdout: { readonly sequence: number; readonly endOffset: number };
    readonly stderr: { readonly sequence: number; readonly endOffset: number };
  };
  try {
    checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
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
  for (const stream of ["stdout", "stderr"] as const) {
    let durableBytes: number;
    try { durableBytes = statSync(join(identity.directory, `${stream}.log`)).size; }
    catch (error) { throw new Error("Portable output evidence spool is missing or unreadable.", { cause: error }); }
    if (checkpoint[stream].endOffset !== durableBytes)
      throw new PortableOutputRetirementBlockedError("Portable output is missing without exact authenticated retirement progress.");
  }
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
