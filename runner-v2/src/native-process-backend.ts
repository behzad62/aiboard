// RUNNER_RAW_PROCESS_BOUNDARY: portable/native backend process creation and host probes are confined here.
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ProcessLaunchFailedWithIdentityError,
  ProcessReleasePendingError,
  type ProcessBackend,
  type ProcessBackendBinding,
  type ProcessEffectFence,
  type ProcessLaunchRequest,
  type ProcessSignalOptions,
} from "./process-backend.js";
import type { ExecutionLifecycleScope, ExecutionSafetyCapabilities, ProcessEscalationAction, ProcessOutputStream } from "./execution-safety-contracts.js";
import { createPortableProcessChannelProvider, validatePortableAcknowledgementEvidence } from "./portable-process-channel.js";
import { parsePosixGroupMembers } from "./portable-process-posix-control.mjs";
import { PortableOutputRetirementBlockedError, runPortableFenceSnapshot } from "./portable-process-protocol.mjs";
import { WINDOWS_JOB_START_CEILING_MS } from "./cleanup-timeouts.js";
import { assertUsableWorkingDirectory } from "./windows-path-limits.mjs";
import { withOwnedFenceLock } from "./owned-fence-lock.mjs";
import { WindowsBirthInspectionOwner } from "./windows-birth-inspection.mjs";
import { provideWindowsBirthHelperAssembly } from "./windows-job-process-host.js";

// One POSIX birth probe (`ps -o lstart=`): measured 4-173 ms idle and up to 104 ms loaded in a 2-CPU Linux container;
// CI `ps -e` p99 61-201 ms (PR #205). 2 s is about 10x the slowest. Windows probes use the bound below instead.
const PROCESS_BIRTH_INITIAL_INSPECTION_DEADLINE_MS = 2_000;
// One Windows birth probe (cold powershell.exe Get-Process): 155-413 ms idle; 4.9-9.1 s with 2x as many busy
// processes as CPUs (5.3-7.4 s in T8). 15 s is 1.6x the slowest at 2x load. A probe gets all of the time left.
const WINDOWS_SUPERVISOR_BIRTH_INSPECTION_DEADLINE_MS = 15_000;
const PROCESS_MEMBERSHIP_INSPECTION_DEADLINE_MS = 15_000;
// Windows birth probes per discovery, as before. Each gets all of the time left, so the cap matters only for a probe
// that fails at once (it stops a powershell.exe spawn every poll).
const WINDOWS_BIRTH_INSPECTION_MAX_ATTEMPTS = 3;
// A Windows portable launch's ceiling: for a supervisor that stays alive and silent, never the expected time. The launch
// ends at once when the supervisor publishes its state, when it exits, or when the call is cancelled (request.signal),
// and the supervisor bounds each of its own phases. Measured 2026-11-19 on a 16-core Windows 10 host, from launch() to
// its accepted result (cold: a fresh Runner process):
//   - idle: cold 0.37 s, sequential 0.20-0.24 s, four at once 0.5-0.9 s;
//   - 20 busy loops: cold 3.7-5.3 s, sequential 3.0-4.1 s, four at once 2.7-5.3 s;
//   - 40 busy loops: cold 12.1-15.2 s, sequential 7.3-7.9 s, four at once 7.8-18.1 s.
// The PR 240 review's host started about 1.8 times slower at the same load (windows-job-process-host.ts), so about 27 s
// cold and 33 s four at once at 40 busy loops there: the former fixed 30 s cut real starts. 120 s, the Job host's start
// ceiling, is about 6.6 times this host's worst and 3.7 times the slower host's extrapolated worst. It is not raised
// further, since a supervisor that exits or a call that is cancelled no longer waits for it.
const WINDOWS_PORTABLE_START_CEILING_MS = WINDOWS_JOB_START_CEILING_MS;
const PORTABLE_STARTUP_DEADLINE_MS = 6_000;
const POSIX_FORCE_SETTLEMENT_DEADLINE_MS = 5_000;
/** A healthy supervisor refreshes CPU evidence every 500 ms at most; much older means it can no longer read it. */
const POSIX_USAGE_MAX_AGE_MS = 5_000;

export interface NativeOwnedProcessBackendOptions {
  readonly stateDirectory?: string;
  readonly pollIntervalMs?: number;
  readonly platform: "posix" | "windows";
  readonly backendId: string;
  readonly lifecycleScope: ExecutionLifecycleScope;
  readonly capabilities: ExecutionSafetyCapabilities;
  readonly operations?: NativeProcessOperations;
  readonly replayCapacityChunks?: number;
  readonly replayCapacityBytes?: number;
  /** Optional absolute startup deadline shared with semantic probes and tests. */
  readonly startupDeadlineAt?: number;
  readonly beforeFenceEffect?: (kind: "attach" | "write" | "close" | "signal" | "output_ack" | "ack_consume" | "verify_empty" | "release") => void | Promise<void>;
  /** Test seam for a bounded post-retirement authority-directory removal fault. */
  readonly removeRetiredAuthority?: (directory: string) => void;
  /**
   * Windows: the Runner's own birth helper directory in the per-user AIBoard home (`<state>/windows-birth-helper`),
   * trusted as the installation is. The helper compiled there is reused across Runner starts and backends until its
   * source or recipe changes. Never a shared directory such as one under TEMP.
   */
  readonly windowsBirthHelperDirectory?: string;
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
  private readonly inspectionOwner: WindowsBirthInspectionOwner | undefined;
  private readonly startupDeadlineAt: number | undefined;
  private readonly outputOffsets = new Map<string, { stdout: number; stderr: number }>();
  constructor(private readonly options: NativeOwnedProcessBackendOptions) {
    this.stateDirectory = resolve(options.stateDirectory ?? join(tmpdir(), "aiboard-portable-processes"));
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
    // The birth helper is compiled on this machine (no binary ships). In the Runner's own helper directory it is kept
    // for later starts and every backend until its source or recipe changes; without one, this backend's state
    // directory gets its own copy and never reuses a recorded one. Either outlives the Runner, as supervisors may.
    const helperDirectory = options.windowsBirthHelperDirectory === undefined ? undefined : resolve(options.windowsBirthHelperDirectory);
    this.inspectionOwner = !options.operations && options.platform === "windows"
      ? new WindowsBirthInspectionOwner(undefined, {
        assembly: (source, sourceSha256) => provideWindowsBirthHelperAssembly(helperDirectory ?? this.stateDirectory, source, sourceSha256,
          { reuseRecorded: helperDirectory !== undefined }),
      }) : undefined;
    const owner = this.inspectionOwner;
    this.operations = options.operations ?? (owner ? {
      ...DEFAULT_OPERATIONS,
      inspectProcessBirth: (...args) => {
        try { return owner.operations().inspectProcessBirth(...args); } catch { return { state: "unknown" }; }
      },
      inspectProcessBirthAsync: async (...args) => {
        try { return await owner.operations().inspectProcessBirthAsync!(...args); } catch { return { state: "unknown" }; }
      },
      inspectProcessBirths: (...args) => {
        try { return owner.operations().inspectProcessBirths!(...args); } catch { return undefined; }
      },
    } : DEFAULT_OPERATIONS);
    this.startupDeadlineAt = options.startupDeadlineAt;
    if (this.startupDeadlineAt !== undefined && (!Number.isSafeInteger(this.startupDeadlineAt) || this.startupDeadlineAt < 1))
      throw new Error("Portable process absolute startup deadline must be a positive integer.");
    mkdirSync(this.stateDirectory, { recursive: true });
  }

  async probe(): Promise<unknown> {
    return Object.freeze({
      attestationVersion: 2,
      backendId: this.options.backendId,
      verified: true,
      platformLabel: this.options.platform,
      lifecycle: Object.freeze({
        scope: this.options.lifecycleScope,
        termination: this.options.capabilities.tree_termination,
        emptiness: this.options.capabilities.verified_emptiness,
      }),
      capabilities: Object.freeze({ ...this.options.capabilities }),
    });
  }

  registerInspectionCleanup(register: (cleanup: (absoluteDeadline?: number) => Promise<void>) => void): void {
    this.inspectionOwner?.registerCleanup(register);
  }
  async prepareInspection(absoluteDeadline: number): Promise<void> {
    await this.inspectionOwner?.prepareInspection(absoluteDeadline);
  }
  async closeInspection(absoluteDeadline = Date.now() + 5_000): Promise<void> {
    await this.inspectionOwner?.closeInspection(absoluteDeadline);
  }

  async launch(request: ProcessLaunchRequest): Promise<unknown> {
    this.assertPlatform();
    if (this.options.platform === "windows") assertUsableWorkingDirectory(request.intent.workingDirectory, "win32");
    const startupDeadline = Math.min(
      Date.now() + (this.options.platform === "windows" ? WINDOWS_PORTABLE_START_CEILING_MS : PORTABLE_STARTUP_DEADLINE_MS),
      this.startupDeadlineAt ?? Number.MAX_SAFE_INTEGER,
    );
    if (Date.now() >= startupDeadline) throw new Error("Portable process startup deadline is exhausted.");
    // A call cancelled before its supervisor starts never starts one (nothing is created).
    assertLaunchNotCancelled(request.signal);
    await this.prepareInspection(startupDeadline);
    const nonce = randomBytes(24).toString("hex");
    const directory = join(this.stateDirectory, `owned-${randomUUID()}`);
    mkdirSync(directory, { recursive: false, mode: 0o700 });
    writeFileSync(join(directory, "stdout.log"), "", { mode: 0o600 });
    writeFileSync(join(directory, "stderr.log"), "", { mode: 0o600 });
    writeFileSync(join(directory, "fence.json"), JSON.stringify({ nonce, ...request.fence }), { mode: 0o600 });
    const supervisor = join(dirname(fileURLToPath(import.meta.url)), "portable-process-supervisor.mjs");
    const windowsHelpers = this.options.platform === "windows"
      ? {
          ...windowsPortableSupervisorHelpers(request.environment, this.inspectionOwner === undefined),
          // The supervisor runs this Runner's compiled helper exe (its session re-checks the digest) instead of compiling one.
          ...(this.inspectionOwner ? { windowsBirthAssembly: this.inspectionOwner.assembly() } : {}),
        }
      : {};
    const encoded = Buffer.from(JSON.stringify({
      nonce,
      directory,
      executable: request.intent.executable,
      arguments: [...request.intent.arguments],
      workingDirectory: request.intent.workingDirectory,
      environment: { ...request.environment },
      platform: this.options.platform,
      startupDeadlineAt: startupDeadline,
      pollIntervalMs: this.pollIntervalMs,
      replayCapacityChunks: this.options.replayCapacityChunks ?? 16,
      replayCapacityBytes: this.options.replayCapacityBytes ?? 256 * 1024,
      fence: { ...request.fence },
      ...windowsHelpers,
    })).toString("base64url");
    if (Date.now() >= startupDeadline || request.signal?.aborted) {
      rmSync(directory, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
      assertLaunchNotCancelled(request.signal);
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
        writeJsonAtomic(join(directory, "lock-holder.json"), {
          nonce, holderPid: child.pid, holderBirth: supervisorBirth.fingerprint,
        });
      }
      if (Date.now() >= startupDeadline) throw new Error("Portable process startup deadline is exhausted.");
      if (supervisorBirth.deadlineExpired) throw new Error("Portable supervisor birth discovery deadline is exhausted.");
      if (!supervisorBirthFingerprint) throw new Error("Portable supervisor birth identity is unavailable.");
      const state = await this.waitForState(directory, nonce, child.pid, startupDeadline, request.signal);
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
      if (!this.launchStateProvesAccepted(state)) throw new Error(state.error ?? "Portable process launch failed.");
      const startedAt = state.updatedAt;
      return launchResult(identity, startedAt);
    } catch (error) {
      // A call cancelled after its supervisor started: the exact identity goes back with the failure and nothing is
      // cleaned up here, so the caller stops it, verifies it empty and releases it on the supervisor's own proof, as any
      // binding (the supervisor is still starting, and may already have started the workload).
      if (identity && error instanceof PortableLaunchCancelledError)
        throw new ProcessLaunchFailedWithIdentityError(error.message,
          launchResult(identity, readState(directory)?.updatedAt ?? new Date().toISOString()), { cause: error });
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

  private launchStateProvesAccepted(state: SupervisorState): boolean {
    if (state.status === "running") return true;
    return this.options.platform === "posix" && state.protocol === "aiboard-portable-process/v2" &&
      state.status === "stopped" && state.launchEffect === "started" &&
      state.workloadGroupRetirement.state === "retired";
  }

  backpressuredChannelProvider() {
    return createPortableProcessChannelProvider({
      replayCapacityChunks: this.options.replayCapacityChunks ?? 16,
      replayCapacityBytes: this.options.replayCapacityBytes ?? 256 * 1024,
      pollIntervalMs: this.pollIntervalMs,
      authority: async (binding, fence) => {
        const identity = this.identity(binding);
        await this.assertFence(identity, fence);
        return {
          directory: identity.directory,
          nonce: identity.nonce,
          fence,
          supervisorPid: identity.supervisorPid,
          reattestFence: () => this.assertDurableFence(identity, fence),
          reattest: () => {
            this.assertDurableFence(identity, fence);
            const state = this.validate(identity);
            if (state === "mismatch" || state === "unknown") throw new Error("Portable channel identity re-attestation failed.");
            return state === "live" ? "live" : "exited";
          },
          reattestObservation: async (signal) => {
            for (;;) {
              this.assertDurableFence(identity, fence);
              const inspection = this.operations.inspectProcessBirthAsync
                ? await this.operations.inspectProcessBirthAsync(identity.supervisorPid, this.options.platform, signal)
                : this.operations.inspectProcessBirth(identity.supervisorPid, this.options.platform);
              // Never reuse pre-wait ownership or POSIX identity as current authority.
              if (signal.aborted) throw new Error("Portable channel observation cancelled.");
              this.assertDurableFence(identity, fence);
              if (identity.version === 2 && this.posixWorkloadSnapshot(identity).state !== "ready")
                throw new Error("Portable channel workload identity re-attestation failed.");
              if (inspection.state === "present" && !sameProcessBirth(inspection.fingerprint, identity.supervisorBirth))
                throw new Error("Portable channel identity re-attestation failed.");
              if (inspection.state === "unknown") {
                if (this.options.platform !== "posix")
                  throw new Error("Portable channel identity re-attestation failed.");
                // Passive POSIX observation cannot promote missing birth evidence
                // into a terminal process result. Exact control and cleanup paths
                // still fail closed independently; this watcher keeps re-attesting
                // the durable fence and workload identity until evidence returns or
                // its consumer cancels/detaches it.
                await delay(this.pollIntervalMs);
                continue;
              }
              return inspection.state === "present" ? "live" : "exited";
            }
          },
          effect: (kind, effect) => {
            const preparation = this.options.beforeFenceEffect?.(kind);
            return preparation
              ? Promise.resolve(preparation).then(() => commitOwnedFenceEffectAsync(identity, fence, effect))
              : commitOwnedFenceEffectAsync(identity, fence, effect);
          },
          snapshot: (read) => runPortableFenceSnapshot({
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
    await this.assertFence(identity, _fence);
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

  async signal(binding: ProcessBackendBinding, action: ProcessEscalationAction, _fence?: ProcessEffectFence, options?: ProcessSignalOptions): Promise<unknown> {
    const identity = this.identity(binding);
    await this.assertFence(identity, _fence);
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
        : await this.waitForWindowsSignalReadiness(identity, options);
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
    const awaitPosixForceSettlement = this.options.platform === "posix" && action === "force_terminate";
    return this.signalState(await this.waitForKnownEmptiness(
      identity,
      awaitPosixForceSettlement,
      awaitPosixForceSettlement ? POSIX_FORCE_SETTLEMENT_DEADLINE_MS : undefined,
    ));
  }

  async verifyEmpty(binding: ProcessBackendBinding, _fence?: ProcessEffectFence): Promise<unknown> {
    const identity = this.identity(binding);
    await this.assertFence(identity, _fence);
    const validation = this.validate(identity);
    if (validation === "mismatch")
      return { empty: false, detail: "Owned process identity changed before quiescence verification." };
    if (validation === "unknown")
      return { empty: false, detail: "Owned process identity inspection is unavailable." };
    const emptiness = await this.emptiness(identity);
    if (emptiness === "empty") {
      const stableValidation = this.validate(identity);
      if ((stableValidation === "live" || stableValidation === "exited") && this.hasTerminalStoppedProof(identity)) {
        try { await assertPortableOutputSettledAtFence(identity, _fence); } catch { return { empty: false, detail: "Owned output evidence is unsettled or unavailable." }; }
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
    try { await this.assertObservationFence(identity, _fence); } catch { return { state: "identity_mismatch" }; }
    const validation = this.validate(identity);
    if (validation === "mismatch") return { state: "identity_mismatch" };
    if (validation === "unknown") return { state: "outcome_unknown" };
    const state = readState(identity.directory);
    if (!state) return { state: "outcome_unknown" };
    if (state.nonce !== identity.nonce || state.supervisorPid !== identity.supervisorPid)
      return { state: "identity_mismatch" };
    const posixRetired = this.options.platform === "posix" && identity.version === 2 &&
      isValidPosixSupervisorStateV2(state) && state.workloadGroupRetirement.state === "retired";
    // Durable retirement is workload quiescence even if a prior uncertain status
    // publication has not yet been overwritten by the retired tick.
    if (posixRetired) {
      return {
        state: "exited",
        ...(state.exitCode === null ? {} : { exitCode: state.exitCode }),
        ...(state.signal ? { signal: state.signal } : {}),
      };
    }
    if (state.status === "outcome_unknown") return { state: "outcome_unknown" };
    const emptiness = await this.emptiness(identity);
    if (emptiness === "identity_mismatch") return { state: "identity_mismatch" };
    if (emptiness === "outcome_unknown") return { state: "outcome_unknown" };
    if (emptiness === "nonempty") return { state: "running" };
    if (validation === "live") {
      return { state: "running" };
    }
    try { await assertPortableOutputSettledAtFence(identity, _fence); }
    catch { return { state: "outcome_unknown" }; }
    try { await this.assertObservationFence(identity, _fence); } catch { return { state: "identity_mismatch" }; }
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

  /**
   * T1 read-only CPU evidence the POSIX supervisor samples: no fence claim, no effect. Undefined
   * when missing, foreign or stale, so a wait falls back to its labeled heuristic instead of
   * reading a frozen total as flat CPU.
   */
  async usage(binding: ProcessBackendBinding): Promise<unknown> {
    if (this.options.platform !== "posix") return undefined;
    let identity: Identity, sample: { nonce?: unknown; cpuTimeMs?: unknown; sampledAt?: unknown } | null;
    try {
      identity = this.identity(binding);
      sample = JSON.parse(await readFile(join(identity.directory, "usage.json"), "utf8")) as typeof sample;
    } catch { return undefined; }
    if (sample?.nonce !== identity.nonce || typeof sample.sampledAt !== "string" || !(Date.now() - Date.parse(sample.sampledAt) <= POSIX_USAGE_MAX_AGE_MS))
      return undefined;
    return { cpuTimeMs: sample.cpuTimeMs, sampledAt: sample.sampledAt, steady: true };
  }

  async release(binding: ProcessBackendBinding, _fence?: ProcessEffectFence): Promise<unknown> {
    const identity = this.identity(binding);
    // A released tombstone in fence.json means an earlier release already passed its final checks under the lock and
    // only its cleanup is left. This release re-runs those checks without a claim, which the tombstone would refuse.
    const finishing = hasReleasedFence(identity);
    if (finishing) this.assertReleaseFence(identity, _fence);
    else await this.assertFence(identity, _fence);
    const assertOutputSettled = finishing
      ? async () => assertPortableOutputSettled(identity)
      : () => assertPortableOutputSettledAtFence(identity, _fence);
    const validation = this.validate(identity);
    if (validation === "mismatch" || validation === "unknown") throw new Error("Cannot release ownership without exact supervisor birth re-attestation.");
    if (this.options.platform === "posix" && identity.version === 2 && validation !== "exited")
      throw new ProcessReleasePendingError("Cannot release POSIX workload authority while its terminal supervisor witness is still alive.");
    const emptiness = await this.emptiness(identity);
    if (emptiness !== "empty")
      throw new Error(emptiness === "outcome_unknown" ? "Cannot release ownership with unknown empty verification." : "Cannot release non-empty owned process identity.");
    await assertOutputSettled();
    if (!this.hasTerminalStoppedProof(identity)) throw new Error("Cannot release ownership without durable terminal state proof.");
    const stableValidation = this.validate(identity);
    if (stableValidation === "mismatch" || stableValidation === "unknown") throw new Error("Cannot release ownership after supervisor birth changed.");
    const stableEmptiness = await this.emptiness(identity);
    if (stableEmptiness !== "empty") throw new Error("Cannot release ownership without stable verified emptiness.");
    await assertOutputSettled();
    if (!this.hasTerminalStoppedProof(identity)) throw new Error("Cannot release ownership after durable terminal state changed.");
    const validateFinalRelease = () => {
      const releasing = this.assertReleaseFence(identity, _fence);
      const finalValidation = this.validate(identity);
      if ((finalValidation !== "live" && finalValidation !== "exited") || !this.hasTerminalStoppedProof(identity) || this.emptiness(identity) !== "empty")
        throw new Error("Cannot release ownership without final terminal empty re-attestation.");
      assertPortableOutputSettled(identity);
      // The authority's own tombstone, written before the lock retires: from here every claim, effect and snapshot
      // refuses this authority whatever the lock holds.
      writeReleasedFence(identity, releasing);
    };
    await this.fencedEffect(identity, _fence, "release", validateFinalRelease);
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
      ? {
          retireAuthority: () => {
            (this.options.removeRetiredAuthority ?? removeRetiredAuthorityDirectory)(identity.directory);
            this.outputOffsets.delete(identity.nonce);
          },
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
  private async assertFence(identity: Identity, fence: ProcessEffectFence | undefined): Promise<void> {
    if (!fence) {
      if (!identity.fence) return;
      throw new OwnedProcessIdentityMismatchError("Owned process writer fence is unavailable.");
    }
    await claimOwnedFence(identity, fence);
  }
  private assertDurableFence(identity: Identity, fence: ProcessEffectFence | undefined): void {
    if (!fence) throw new OwnedProcessIdentityMismatchError("Owned process writer fence is unavailable.");
    const current = readOwnedFence(join(identity.directory, "fence.json"), identity);
    if (fence.ownerId !== current.ownerId || fence.fencingToken !== current.fencingToken)
      throw new OwnedProcessIdentityMismatchError("Owned process writer fence is stale at the effect boundary.");
  }
  /** The fence a release may finish with: the current one, or one at or above a released tombstone's (same owner if equal). */
  private assertReleaseFence(identity: Identity, fence: ProcessEffectFence | undefined): ProcessEffectFence {
    if (!fence) throw new OwnedProcessIdentityMismatchError("Owned process writer fence is unavailable.");
    if (!releaseFenceAccepted(readOwnedFenceRecord(join(identity.directory, "fence.json"), identity), fence))
      throw new OwnedProcessIdentityMismatchError("Owned process writer fence is stale at the effect boundary.");
    return fence;
  }
  private async assertObservationFence(identity: Identity, fence: ProcessEffectFence | undefined): Promise<void> {
    if (!fence) {
      if (!identity.fence) return;
      throw new OwnedProcessIdentityMismatchError("Owned process writer fence is unavailable.");
    }
    try {
      const current = readOwnedFence(join(identity.directory, "fence.json"), identity);
      if (current.ownerId === fence.ownerId && current.fencingToken === fence.fencingToken) return;
    } catch {
      // Preserve the existing claim path for missing/corrupt evidence so it
      // retains its fail-closed behavior and legacy initialization rules.
    }
    await this.assertFence(identity, fence);
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
  private async waitForKnownEmptiness(
    identity: Identity,
    waitForNonempty = false,
    deadlineMs = Math.max(500, this.pollIntervalMs * 100),
  ): Promise<"empty" | "nonempty" | "identity_mismatch" | "outcome_unknown"> {
    const deadline = Date.now() + deadlineMs;
    let result = await this.emptiness(identity);
    while (
      (result === "outcome_unknown" || (waitForNonempty && result === "nonempty")) &&
      Date.now() < deadline
    ) {
      await delay(this.pollIntervalMs);
      result = await this.emptiness(identity);
    }
    return result;
  }
  // Windows, before a signal: a supervisor that is alive and still preparing (no state published yet, or its own
  // "preparing" state) is on its way to the final state a signal needs; a launch cancelled after spawn hands its
  // identity to cleanup at exactly that point. The supervisor's own startup deadline ends that phase (a cold start
  // under load took 12-18 s on 16 cores), so the wait follows its progress up to the shared start ceiling instead of a
  // fixed 2.5 s. Any other unknown keeps the short settle wait. The caller's deadline and abort end it sooner, and its
  // timer never holds the process open. Waiting decides nothing: the fenced effect re-attests the exact identity
  // before any control is written.
  private async waitForWindowsSignalReadiness(identity: Identity, options?: ProcessSignalOptions): Promise<"empty" | "nonempty" | "identity_mismatch" | "outcome_unknown"> {
    const started = Date.now();
    const settleDeadline = started + Math.max(500, this.pollIntervalMs * 100);
    const stopAt = Math.min(started + WINDOWS_PORTABLE_START_CEILING_MS, options?.deadlineAt ?? Number.POSITIVE_INFINITY);
    // The per-poll liveness probe is a PID check only. Once the wait outlasts the settle window, one asynchronous
    // exact birth check (cancelled when the wait ends) catches a supervisor whose PID was reused: it ends the wait.
    const inspection = new AbortController();
    let birth: "pending" | "same" | "other" | "unknown" | undefined;
    try {
      let result = await this.emptiness(identity);
      while (result === "outcome_unknown" && !options?.signal?.aborted) {
        const now = Date.now();
        if (now >= stopAt) break;
        if (now >= settleDeadline) {
          if (birth === "other" || !this.windowsSupervisorPreparing(identity)) break;
          if (birth === undefined) {
            birth = "pending";
            void this.supervisorBirth(identity, inspection.signal).then((value) => { birth = value; }, () => { birth = "unknown"; });
          }
        }
        await unrefDelay(Math.min(this.pollIntervalMs, Math.max(0, stopAt - now)), options?.signal);
        result = await this.emptiness(identity);
      }
      return result;
    } finally { inspection.abort(); }
  }
  private async supervisorBirth(identity: Identity, signal: AbortSignal): Promise<"same" | "other" | "unknown"> {
    const inspection = this.operations.inspectProcessBirthAsync
      ? await this.operations.inspectProcessBirthAsync(identity.supervisorPid, this.options.platform, signal)
      : this.operations.inspectProcessBirth(identity.supervisorPid, this.options.platform);
    if (inspection.state === "unknown") return "unknown";
    return inspection.state === "present" && sameProcessBirth(inspection.fingerprint, identity.supervisorBirth) ? "same" : "other";
  }
  private windowsSupervisorPreparing(identity: Identity): boolean {
    const state = readState(identity.directory);
    if (state !== undefined && (state.nonce !== identity.nonce || state.supervisorPid !== identity.supervisorPid || state.status !== "preparing")) return false;
    return pidAlive(identity.supervisorPid);
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
      let awaitingQueuedForceRetirement = false;
      if (initial.value.workloadGroupRetirement.state === "active") {
        if (validation !== "live") throw launchBlocker(identity, "Launch cleanup preserved POSIX authority because its supervisor exited before workload retirement proof.");
        await this.cleanupFenceEffect(identity, () => {
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
        awaitingQueuedForceRetirement = true;
      }
      let emptySince: number | undefined;
      while (Date.now() < deadline) {
        const snapshot = this.posixWorkloadSnapshot(identity);
        if (snapshot.state === "identity_mismatch") throw new Error("Launch cleanup observed a changed POSIX workload identity.");
        if (snapshot.state === "outcome_unknown") throw launchBlocker(identity, "Launch cleanup lost durable POSIX workload retirement evidence.");
        const emptiness = await this.emptiness(identity);
        if (emptiness === "identity_mismatch") throw new Error("Launch cleanup observed a recycled owned identity.");
        if (emptiness === "outcome_unknown") {
          if (awaitingQueuedForceRetirement && snapshot.value.workloadGroupRetirement.state === "active") {
            await delay(this.pollIntervalMs);
            continue;
          }
          throw launchBlocker(identity, "Launch cleanup lost POSIX workload membership verification.");
        }
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
      await this.cleanupFenceEffect(identity, () => writeFileSync(join(identity.directory, "control.json"), JSON.stringify({
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
  private async cleanupFenceEffect<T>(identity: Identity, effect: () => T): Promise<T> {
    if (!identity.fence) return effect(); // Explicit legacy fixture compatibility; all current launches persist a fence.
    return await commitOwnedFenceEffectAsync(identity, identity.fence, effect);
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
  private async waitForState(directory: string, nonce: string, pid: number, deadline: number, signal?: AbortSignal): Promise<SupervisorState> {
    while (Date.now() < deadline) {
      // Windows: a cancellation after the supervisor started (during its birth probe or this wait) fails the launch with
      // its exact identity, which exists from the supervisor's birth. A POSIX identity exists only once the supervisor
      // publishes, so a POSIX launch finishes this short wait and the caller's stop then stops the accepted launch.
      if (this.options.platform === "windows") assertLaunchNotCancelled(signal);
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
    // Windows: one probe gets all of the time left, never a 2 s slice that is killed and started cold again (a cold
    // powershell.exe start took 4.9-9.1 s on a loaded host). It is retried only when it ended early without an answer.
    // POSIX keeps its short polled probes inside the 1 s discovery window.
    const windows = this.options.platform === "windows";
    const maximumAttempts = windows ? WINDOWS_BIRTH_INSPECTION_MAX_ATTEMPTS : Number.MAX_SAFE_INTEGER;
    let attemptDeadlineMs = Math.min(discoveryLimitMs, PROCESS_BIRTH_INITIAL_INSPECTION_DEADLINE_MS, Math.max(1, deadline - Date.now()));
    for (let attempts = 1; Date.now() < deadline && attempts <= maximumAttempts; attempts += 1) {
      attemptDeadlineMs = Math.max(1, windows ? deadline - Date.now() : Math.min(attemptDeadlineMs, deadline - Date.now()));
      const inspection = this.operations.inspectProcessBirth(pid, this.options.platform, attemptDeadlineMs);
      const deadlineExpired = Date.now() >= deadline;
      if (inspection.state === "present") return { ...inspection, deadlineExpired };
      if (inspection.state === "absent") return { state: "absent", deadlineExpired };
      if (deadlineExpired) return { state: "unknown", deadlineExpired: true };
      attemptDeadlineMs = Math.min(discoveryLimitMs, attemptDeadlineMs * 2);
      if (attempts < maximumAttempts) await delay(this.pollIntervalMs);
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
      encoding: "utf8", windowsHide: true,
      timeout: platform === "windows" ? WINDOWS_SUPERVISOR_BIRTH_INSPECTION_DEADLINE_MS : PROCESS_BIRTH_INITIAL_INSPECTION_DEADLINE_MS,
      maxBuffer: 64 * 1024, signal,
    }, (error, stdout) => {
      if (signal.aborted) return;
      if (!error) {
        const result = stdout.trim();
        inspection = platform === "posix" && result.length === 0 && pidAlive(pid)
          ? { state: "unknown" }
          : parseBirthInspection(result, platform);
      } else if (platform === "posix" && !pidAlive(pid)) inspection = { state: "absent" };
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
    if (result) return { state: "present", fingerprint: result };
    return pidAlive(pid) ? { state: "unknown" } : { state: "absent" };
  } catch {
    return platform === "posix" && !pidAlive(pid) ? { state: "absent" } : { state: "unknown" };
  }
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
function osPosixGroupMembers(groupId: number): readonly number[] | undefined {
  try {
    return parsePosixGroupMembers(execFileSync("ps", ["-e", "-o", "pid=,pgid=,stat="], {
      encoding: "utf8",
      timeout: PROCESS_MEMBERSHIP_INSPECTION_DEADLINE_MS,
    }), groupId);
  } catch { return undefined; }
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
/** A poll delay that never holds the process open and ends early on the caller's abort. */
function unrefDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, milliseconds); timer.unref?.();
    signal?.addEventListener("abort", done, { once: true });
  });
}
class PortableLaunchCancelledError extends Error {}
function assertLaunchNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PortableLaunchCancelledError("Portable process launch was cancelled before its supervisor proved the launch.");
}
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
  includeBirthInspector: boolean,
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
    ...(includeBirthInspector ? { windowsBirthInspector: Object.freeze({ command: powershell }) } : {}),
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

/** Async (FL3): a Runner claim waits for the lock with timers, so a held lock never blocks the Runner's event loop. */
async function claimOwnedFence(identity: Identity, candidate: ProcessEffectFence): Promise<void> {
  if (!candidate.ownerId || !Number.isSafeInteger(candidate.fencingToken) || candidate.fencingToken < 1)
    throw new OwnedProcessIdentityMismatchError("Owned process writer fence is invalid.");
  const path = join(identity.directory, "fence.json");
  const lock = join(identity.directory, ".fence.lock");
  try {
    await withOwnedFenceLock(lock, () => {
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
/** `release` (the release effect only) retires the authority after the effect and may finish over its own tombstone. */
async function commitOwnedFenceEffectAsync<T>(identity: Identity, candidate: ProcessEffectFence, effect: () => T | Promise<T>, release?: { readonly retireAuthority: () => void }): Promise<T> {
  const path = join(identity.directory, "fence.json");
  const lock = join(identity.directory, ".fence.lock");
  try {
    return await withOwnedFenceLock(lock, () => {
      if (release) {
        if (!releaseFenceAccepted(readOwnedFenceRecord(path, identity), candidate))
          throw new OwnedProcessIdentityMismatchError("Owned process writer fence is stale at the effect boundary.");
      } else {
        const current = readOwnedFence(path, identity);
        if (candidate.ownerId !== current.ownerId || candidate.fencingToken !== current.fencingToken)
          throw new OwnedProcessIdentityMismatchError("Owned process writer fence is stale at the effect boundary.");
      }
      return effect();
    }, { retireAfterEffect: release !== undefined, ...(release ? { retireAuthority: release.retireAuthority } : {}) });
  } catch (error) {
    if (error instanceof OwnedProcessIdentityMismatchError) throw error;
    throw new OwnedProcessIdentityMismatchError("Owned process writer fence effect boundary is unavailable.", { cause: error });
  }
}
// What a retried release re-checks: its terminal state and its output evidence.
const RELEASED_AUTHORITY_EVIDENCE = Object.freeze(["state.json", "channel", "stdout.log", "stderr.log"]);
// A released authority's directory goes in this order. First the lock: if it is busy (a Windows handle), nothing else
// is gone yet, and a retried release finishes through the tombstone. Then everything a retried release does not
// re-check, then what it does, then fence.json, the released tombstone, with the directory. While anything of the
// authority is left, the tombstone still refuses every claim and effect on it, a recreated lock included.
function removeRetiredAuthorityDirectory(directory: string): void {
  let entries: string[];
  try { entries = readdirSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  rmSync(join(directory, ".fence.lock"), { force: true });
  for (const entry of entries) {
    if (entry !== ".fence.lock" && entry !== "fence.json" && !RELEASED_AUTHORITY_EVIDENCE.includes(entry))
      rmSync(join(directory, entry), { recursive: true, force: true });
  }
  for (const entry of RELEASED_AUTHORITY_EVIDENCE) rmSync(join(directory, entry), { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
}
/**
 * fence.json holds the current writer fence, `{ nonce, ownerId, fencingToken }`, or, once a release passed its final
 * checks under the lock, the released tombstone `{ nonce, released: { ownerId, fencingToken } }`. The tombstone has no
 * top-level fence, so a reader of an earlier version finds no valid fence in it and refuses as well. A tombstone is
 * final: nothing but release accepts it, and nothing rewrites it as a live fence.
 */
interface OwnedFenceRecord extends ProcessEffectFence { readonly released: boolean }
function readOwnedFenceRecord(path: string, identity: Identity): OwnedFenceRecord {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value.nonce !== identity.nonce) throw new Error();
    if (value.released === undefined) {
      if (typeof value.ownerId !== "string" || !Number.isSafeInteger(value.fencingToken)) throw new Error();
      return { ownerId: value.ownerId, fencingToken: value.fencingToken, released: false };
    }
    const released = value.released;
    if (value.ownerId !== undefined || value.fencingToken !== undefined || typeof released !== "object" || released === null ||
        typeof released.ownerId !== "string" || !Number.isSafeInteger(released.fencingToken)) throw new Error();
    return { ownerId: released.ownerId, fencingToken: released.fencingToken, released: true };
  } catch {
    throw new OwnedProcessIdentityMismatchError("Owned process writer fence evidence is invalid.");
  }
}
/** The current live writer fence. A released tombstone refuses every claim, effect and snapshot. */
function readOwnedFence(path: string, identity: Identity): ProcessEffectFence {
  const record = readOwnedFenceRecord(path, identity);
  if (record.released) throw new OwnedProcessIdentityMismatchError("Owned process writer fence is released with its authority.");
  return { ownerId: record.ownerId, fencingToken: record.fencingToken };
}
function hasReleasedFence(identity: Identity): boolean {
  try { return readOwnedFenceRecord(join(identity.directory, "fence.json"), identity).released; }
  catch { return false; }
}
/**
 * A release may run at the current fence, or finish over a tombstone at or above its fence (the same owner if equal).
 * Above it, any owner: the backend raises no token after a release (every claim refuses the tombstone), but the
 * durable process store does. A lease takeover (`takeover_lease`, durable-process-store.ts) gives the next owner the
 * token + 1 without a backend claim, and that owner is the only one that can finish a release whose Runner died after
 * the tombstone. These are the candidates a live fence at that token would accept for a claim, and over a tombstone
 * they get only what a release does: its terminal, empty and settled-output checks run again under the lock first,
 * and then it writes the tombstone again at its own fence and removes the authority. A stale owner (lower, or another
 * owner at the same token) is refused.
 */
function releaseFenceAccepted(current: OwnedFenceRecord, candidate: ProcessEffectFence): boolean {
  if (!current.released) return candidate.ownerId === current.ownerId && candidate.fencingToken === current.fencingToken;
  return candidate.fencingToken > current.fencingToken ||
    (candidate.fencingToken === current.fencingToken && candidate.ownerId === current.ownerId);
}
/**
 * The tombstone is the only record that an authority is released (the lock file holds nothing), so it is durable
 * before the lock is given back and before anything of the authority is removed: the data is flushed before the
 * rename, and the rename after it. POSIX flushes the directory. Node cannot open a directory on Windows, so there the
 * renamed file itself is flushed (FlushFileBuffers), which is as far as Node reaches.
 */
function writeReleasedFence(identity: Identity, fence: ProcessEffectFence): void {
  const path = join(identity.directory, "fence.json");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const content = Buffer.from(JSON.stringify({ nonce: identity.nonce, released: { ownerId: fence.ownerId, fencingToken: fence.fencingToken } }));
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    for (let written = 0; written < content.length;) written += writeSync(descriptor, content, written);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  renameSync(temporary, path);
  flushRenamedFence(identity.directory, path);
}
/**
 * Some file systems (some FUSE, CIFS and 9p mounts) refuse fsync on a directory: they give no directory durability
 * at all, so a refusal there is not an error to retry forever. A rename lost to a crash leaves the live fence and its
 * evidence, and the release runs again (fail closed).
 */
function flushRenamedFence(directory: string, path: string): void {
  const windows = process.platform === "win32";
  const descriptor = openSync(windows ? path : directory, windows ? "r+" : "r");
  try { fsyncSync(descriptor); }
  catch (error) {
    if (windows || !["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
  } finally { closeSync(descriptor); }
}
async function assertPortableOutputSettledAtFence(identity: Identity, fence: ProcessEffectFence | undefined): Promise<void> {
  if (!fence) throw new OwnedProcessIdentityMismatchError("Owned process writer fence is unavailable.");
  const snapshot = await runPortableFenceSnapshot({
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
