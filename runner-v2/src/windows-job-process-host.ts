// RUNNER_RAW_PROCESS_BOUNDARY: Windows Job containment host and helper probes require direct OS process APIs.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS } from "./cleanup-timeouts.js";
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, watch, writeFileSync, writeSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { recoverRevokedOwnedFenceLock, withOwnedFenceLock } from "./owned-fence-lock.mjs";
import { replaceFileWhenFree } from "./windows-file-replace.js";
import { assertUsableWorkingDirectory, windowsNativeFilePath } from "./windows-path-limits.mjs";

import type { BackpressuredOutputMetadata } from "./interactive-process-channel.js";

const PROTOCOL = "aiboard-managed-process/v1";
/** One HTTP request to a supervisor. */
const SUPERVISOR_REQUEST_TIMEOUT_MS = 5_000;
/**
 * How long a launch waits for its supervisor and PowerShell Job host to report startup, while both stay alive and the
 * call is live: a supervisor that exits, a host that exits before its started line (the supervisor then writes a
 * terminal status at once) and the call's cancellation each end the wait at once. So this ceiling bounds only a host
 * that stays alive and silent, never the expected time. PowerShell's start scales with the CPU it gets. Measured from
 * launchOwned to the host's started line:
 *   - 2026-11-18, a 16-core Windows 10 host: idle: cold 1.2 s, sequential max 0.65 s, four at once max 0.8 s;
 *     20 busy loops: cold 6.9 s, sequential 4.0-5.1 s, four at once max 7.6 s;
 *     40 busy loops: cold 32.9 s, sequential max 19.2 s, four at once median 27.6 s, max 41.3 s.
 *   - The PR 240 review's host, 20 busy loops: cold 13.4 s, sequential 4.6-6.3 s, four at once 11.7-13.6 s: about
 *     1.8 times the first host's worst at the same load, so about 75-85 s at 40 busy loops there.
 * The former fixed 5 s failed real launches under load (PR CI, cli-worker-processes). 120 s is about three times the
 * first host's worst start and about 1.4 times the second host's extrapolated worst; it is not raised further, since a
 * host that dies or a call that is cancelled no longer waits for it.
 */
const DEFAULT_START_CEILING_MS = 120_000;
/** keepWarm stops after this many consecutive background prestart failures, so a host that cannot start spares stops trying. */
const KEEP_WARM_FAILURE_LIMIT = 3;
const DEFAULT_CONTROL_DEADLINE_MS = 5_000;
// Bounds the entire cold PowerShell process, including host startup. The
// unchanged create/close command completed in 2,369 ms on hosted Windows; a cold powershell.exe start alone took
// 4.9-9.1 s with 2x as many busy processes as CPUs (16 CPUs), and 5.3-7.4 s on two contended CPUs (T8). 15 s, the
// bound the birth probes use for the same cold start, is 1.6x the slowest. It returns the moment the probe exits.
const DEFAULT_ACTIVE_JOB_PROBE_DEADLINE_MS = 15_000;
const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024;
const JOB_HOST_HELPER_DLL_FILENAME = "ManagedProcessJobHost.dll";
const JOB_HOST_SOURCE_MARKER_START = "$jobHostCsSource = @'";
const JOB_HOST_COMPILE_TIMEOUT_MS = 120_000;
/** Fixed stdin-driven compile wrapper: source arrives base64 over the private
 * stdin pipe, the output path arrives as a plain argv string. Neither ever
 * passes through PowerShell command-line parsing, so no path content
 * (ASCII or curly quotes, `$`, backticks) is ever executable. */
const JOB_HOST_COMPILE_WRAPPER = [
  "$encoded = [Console]::In.ReadLine()",
  "$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))",
  "Add-Type -TypeDefinition $source -OutputAssembly $args[0] -OutputType Library",
  "",
].join("\r\n");

export interface WindowsJobOwnershipKey { readonly runId: string; readonly sessionId: string }
export interface WindowsJobWriterFence { readonly ownerId: string; readonly fencingToken: number }
export interface WindowsJobLaunchRequest extends WindowsJobOwnershipKey {
  readonly command: string;
  readonly args: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly interactive?: boolean;
  readonly fence?: WindowsJobWriterFence;
  /** Cancels the start wait: the start is aborted like one that failed, and its exact record goes back with the error. */
  readonly signal?: AbortSignal;
}
export interface WindowsJobProcessSnapshot {
  readonly processId: string; readonly pid: number;
  readonly status: "running" | "stopped" | "exited_unknown";
  readonly exitCode: number | null; readonly signal: NodeJS.Signals | null;
  readonly startedAt: string; readonly updatedAt: string;
  readonly stdout: string; readonly stderr: string; readonly ownershipReleased?: boolean;
}
export interface WindowsJobOutputRead {
  readonly stdout: Uint8Array; readonly stderr: Uint8Array;
  readonly next: { readonly stdout: number; readonly stderr: number };
}
export interface WindowsJobProcessHost {
  launchOwned(request: WindowsJobLaunchRequest): Promise<WindowsJobProcessSnapshot>;
  signalOwned(processId: string, signal: "SIGTERM" | "SIGINT" | "SIGKILL", owner: WindowsJobOwnershipKey, fence?: WindowsJobWriterFence): Promise<WindowsJobProcessSnapshot>;
  reconcileOwned(processId: string, owner: WindowsJobOwnershipKey, fence?: WindowsJobWriterFence): Promise<WindowsJobProcessSnapshot & { readonly ownershipReleased: boolean }>;
  releaseOwned(processId: string, owner: WindowsJobOwnershipKey, expectedStartedAt: string, fence?: WindowsJobWriterFence): Promise<WindowsJobProcessSnapshot & { readonly ownershipReleased: boolean }>;
  readOwnedOutput(processId: string, owner: WindowsJobOwnershipKey, offsets: { readonly stdout: number; readonly stderr: number }, fence?: WindowsJobWriterFence, maximumBytes?: number): WindowsJobOutputRead | Promise<WindowsJobOutputRead>;
  probeActiveJobCreateClose(): Promise<boolean>;
  /** T1 read-only CPU evidence for an owned live Job. Never a lifecycle, release or fence fact. */
  usageOwned?(processId: string, owner: WindowsJobOwnershipKey): Promise<{ readonly cpuTimeMs: number; readonly sampledAt: string } | undefined>;
  attachOwnedChannel?(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence): Promise<WindowsJobChannelState>;
  /**
   * `timeoutMs` bounds the whole write, admission and drain; without it the control deadline applies. `signal` ends
   * the drain wait early (a stopping session); admission under the fence is never cancelled.
   */
  writeOwnedInput?(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence, sequence: number, payload: Uint8Array, timeoutMs?: number, signal?: AbortSignal): Promise<{ readonly acknowledged: true; readonly sequence: number }>;
  closeOwnedInput?(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence): Promise<void>;
  acknowledgeOwnedOutput?(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence, stream: "stdout" | "stderr", endOffset: number): Promise<void>;
  claimOwnedFence?(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence): Promise<void>;
  /**
   * PX-2b: one atomic fence effect that performs the writer-fence claim
   * compare-and-set and then the channel attachment read, with exactly the
   * claimOwnedFence predicates followed by exactly the attachOwnedChannel
   * predicates in the same order. Absent callers use the two separate
   * methods; the guarantees are identical either way.
   */
  claimAndAttachOwnedChannel?(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence): Promise<WindowsJobChannelState>;
  /**
   * PX-2c: pre-started spare pair. prestartSpare boots one supervisor plus one
   * Job host that waits idle with NO Job and NO child; the next launchOwned
   * claims it for exactly one call over the private stdin/IPC channel and
   * then runs that call's own Job exactly as today. Any miss, death,
   * staleness, or identity failure falls back to a fresh launch. retireSpare
   * kills an unclaimed spare without ever launching a call (run-end cleanup).
   * All three are optional so fakes and older hosts keep working.
   */
  prestartSpare?(owner: WindowsJobOwnershipKey): Promise<WindowsJobSpareInfo>;
  retireSpare?(closingRun?: { readonly runId: string }): Promise<void>;
  spareStats?(): WindowsJobSpareStats;
  /**
   * Record retention, called once a run's close has settled. `released` names the Job processes the run's own durable
   * stores record as released for good, so no recovery of the run asks this host about them again. Each one's record
   * and folder (its raw output included) is deleted only when the record is that run's, carries the release tombstone,
   * and its supervisor's durable status still proves the stop: stopped, ownership released, output settled. Anything
   * else is kept. Also forgets the run's keepWarm retirement mark. Never throws.
   */
  retireReleasedRecords?(closedRun: { readonly runId: string; readonly released: readonly WindowsJobReleasedRecord[] }): Promise<WindowsJobRecordRetention>;
  /**
   * PX-2b: event-driven settlement wait. Returns after the supervisor
   * durably persists a newer status or after timeoutMs (bounded server
   * side). Read-only: it takes no fence lock and changes no state; every
   * caller re-polls and re-attests afterwards, and every existing deadline
   * stays armed. Throws on transport/auth failure so callers fall back to
   * a timed delay.
   */
  waitOwnedStatusChange?(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence, timeoutMs: number, sinceUpdatedAt?: string): Promise<void>;
  /**
   * CW3: waits, polling, until every supervisor process this host's records name has exited, up to `timeoutMs`.
   * Read-only: it signals nothing and changes no record. A released process's supervisor exits just after it reports
   * the stop, still holding its output logs; a caller that removes this host's state folder waits for this first.
   * Returns the supervisor PIDs still alive at the deadline.
   */
  awaitSupervisorsExited?(timeoutMs: number): Promise<readonly number[]>;
}
/** A Job process a run's owner recorded as released: the identity its backend binding names. */
export interface WindowsJobReleasedRecord { readonly processId: string; readonly sessionId: string; readonly startedAt: string }
/** What one retention pass did: records deleted, and named records kept because something was not proven. */
export interface WindowsJobRecordRetention { readonly deleted: number; readonly kept: number }
export interface WindowsJobChannelState {
  readonly nextSequence: number; readonly inputClosed: boolean;
  readonly outputOffsets: { readonly stdout: number; readonly stderr: number };
  readonly outputSequences: { readonly stdout: number; readonly stderr: number };
  /** Exact persisted read frames, verified against retained bytes under the attachment fence. */
  readonly retainedOutput?: readonly BackpressuredOutputMetadata[];
  readonly snapshot: WindowsJobProcessSnapshot & { readonly ownershipReleased: boolean };
}
/**
 * Faults a test can inject into the Job host. Each only makes it stricter: slow_start_late_close makes the host take
 * longer to start than its launcher waits and delivers the host's close to its supervisor a second late, as on a
 * loaded host; late_started_line runs the workload but writes its started line 30 s late; host_exit_after_create
 * ends the host right after it created the root inside the Job, before it resumed it, and delivers the host's close
 * to its supervisor 20 s late; assign_path_exit_after_create takes the Assign path (as an app execution alias does)
 * and ends the host after it reported the suspended root's identity, before the Assign.
 */
export type WindowsJobInjectedLaunchFault = "slow_start_late_close" | "late_started_line" | "host_exit_after_create" | "assign_path_exit_after_create";
export interface WindowsJobProcessHostOptions {
  readonly stateDirectory: string; readonly platform?: NodeJS.Platform;
  readonly idFactory?: () => string; readonly clock?: () => string;
  readonly maxPollBytes?: number; readonly startDeadlineMs?: number; readonly controlDeadlineMs?: number; readonly stopDeadlineMs?: number;
  readonly maxRetainedOutputChunks?: number; readonly maxRetainedOutputBytes?: number;
  readonly maxRetainedOutputChunkBytes?: number;
  readonly maxInputBytes?: number;
  readonly supervisorScriptPath?: string;
  /** PX-2c: pre-started spare pair. Absent (the default) disables it: no spare is ever started and every call launches fresh, exactly as today. */
  readonly spare?: WindowsJobSpareOptions;
  /** Test seam for the optional active Job probe; product uses the real PowerShell create/close command. */
  readonly activeJobProbe?: { readonly executable: string; readonly arguments: readonly string[]; readonly deadlineMs?: number };
  readonly beforeFenceEffect?: (kind: "attach" | "read" | "write" | "close" | "signal" | "output_ack" | "reconcile" | "release") => void | Promise<void>;
  /**
   * CW3: what the once-only helper-fallback warning is keyed on (default: the state directory). Short-lived private
   * hosts (transient runs) share one key, so they warn once, not once per check.
   */
  readonly helperFallbackWarningKey?: string;
  /** Record files one maintenance scan (the startup scan, each run-end spare sweep) reads at most. Default 512. */
  readonly maxRecordScan?: number;
  /** Retention: how long one pass waits, for all its held records together, for their supervisors to exit. Test seam; default 15 s. */
  readonly retentionSupervisorExitMs?: number;
  /** Test seam: a stricter-only fault the Job host injects into every launch (WindowsJobInjectedLaunchFault). */
  readonly injectedLaunchFault?: WindowsJobInjectedLaunchFault;
  /** Test seam: ends every start wait, as its ceiling would, once aborted (a test aborts it when the supervisor listens). */
  readonly startWaitSignal?: AbortSignal;
}

/**
 * Record files a maintenance scan reads at most. With retention, the directory holds live records, records of runs
 * not yet closed, and records kept because a stop was not proven; a larger directory is read across scans, each from
 * where the last stopped, so no startup or run end reads it whole. Reading one record costs well under a millisecond.
 */
const DEFAULT_RECORD_SCAN_LIMIT = 512;
/**
 * Retention: how long one pass waits, for all its records together, for their supervisors to exit. A released
 * process's supervisor reports the stop, then exits, holding its output logs until it does (the Job host opens them
 * without delete sharing). This is the measured basis of CW3's transient supervisor wait (execution-host.ts,
 * TRANSIENT_SUPERVISOR_EXIT_CEILING_MS): on an idle Windows PC every supervisor had already exited when the wait began,
 * and GitHub's Windows image was about 3 times slower. The wait polls every 25 ms and ends as soon as they are gone; a
 * record still held at the ceiling (or whose PID was reused) stays marked, and a later sweep finishes it.
 */
const DEFAULT_RETENTION_SUPERVISOR_EXIT_MS = 15_000;
const RETENTION_SUPERVISOR_POLL_MS = 25;

export interface SupervisorRecord { protocol: typeof PROTOCOL; token: string; statusPath: string; supervisorPid: number; port: number }
/** PX-2c: options for the pre-started spare pair. */
export interface WindowsJobSpareOptions {
  /** Idle budget for an unclaimed spare before its supervisor retires it. The supervisor clamps to 1-300 s; default 60 s. */
  readonly idleTimeoutMs?: number;
  /** Start a replacement spare in the background after a claim. Default false. */
  readonly autoRefresh?: boolean;
  /** Waiting spares (plus starting ones) this host keeps at once, one per run. Default 1. */
  readonly maxSpares?: number;
  /**
   * Keep a spare warm for each run that launches: after every interactive launch, claimed or fresh,
   * start a spare for that run in the background, within maxSpares. Includes autoRefresh. A run whose spare was
   * retired gets no new one until it launches again, and repeated prestart failures stop it for this
   * host. Default false.
   */
  readonly keepWarm?: boolean;
}
interface SpareEntry { launcher: ChildProcess; token: string; processId: string; owner: WindowsJobOwnershipKey }
/** PX-2c: identity of a waiting spare pair. */
export interface WindowsJobSpareInfo { readonly processId: string; readonly supervisorPid: number; }
/** PX-2c: spare counters (prestarts, successful claims, fallbacks to a fresh launch). */
export interface WindowsJobSpareStats { readonly prestarts: number; readonly claims: number; readonly fallbacks: number; }
interface HostRecord extends WindowsJobOwnershipKey {
  processId: string; pid: number; command: string; args: string[]; cwd: string; environmentKeys: string[];
  startedAt: string; updatedAt: string; status: "running" | "stopped" | "exited_unknown";
  exitCode: number | null; signal: NodeJS.Signals | null; stdoutPath: string; stderrPath: string;
  supervisor: SupervisorRecord; backendOwnershipReleasedAt?: string;
  interactive?: boolean; nextInputSequence?: number; inputClosed?: boolean;
  outputOffsets?: { stdout: number; stderr: number };
  outputSequences?: { stdout: number; stderr: number };
  outputFrames?: Partial<Record<"stdout" | "stderr", BackpressuredOutputMetadata>>;
  currentFence?: WindowsJobWriterFence;
  /** PX-2c: durable spare mark. An unclaimed spare record must never be adopted as a call. */
  spare?: boolean;
  spareClaimed?: boolean;
  spareClaimInFlight?: boolean;
  spareReapedAt?: string;
  /**
   * Retention: set once a released record passed every retention check, before anything of it is deleted. A later
   * pass that finds it finishes the deletion without the stop proof, whose status file may already be gone.
   */
  retentionRemovingAt?: string;
}
interface SupervisorStatus {
  protocol: typeof PROTOCOL; processId: string; supervisorPid: number; childPid: number; port: number;
  status: "starting" | "running" | "stopped" | "exited_unknown"; exitCode: number | null;
  signal: NodeJS.Signals | null; error: string | null; ownershipReleased: boolean; updatedAt: string;
  retainedOutputChunks: number; retainedOutputBytes: number;
  /** T1: in-memory whole-Job CPU evidence from the Job host's accounting events. */
  cpuTimeMs?: number; cpuSampledAt?: string;
  jobEmptyProof?: boolean;
  terminationRequested?: boolean;
  /** PX-2c: spare lifecycle marks persisted by the supervisor. */
  spare?: boolean;
  claimed?: boolean;
  spareReady?: boolean;
  spareRetired?: string;
  /** A start stopped before its workload reported started dropped output nobody will read (its counts are then 0). */
  outputDiscarded?: boolean;
}

export class WindowsJobHostError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "WindowsJobHostError"; }
}
/**
 * A start that failed after its record existed (the host was aborted, or reported a failed start). The record names
 * the exact Job host process, so the caller reconciles and releases it through the normal contract instead of
 * assuming the failed start left nothing behind.
 */
export class WindowsJobStartFailedError extends WindowsJobHostError {
  constructor(code: string, message: string, readonly startRecord: { readonly processId: string; readonly startedAt: string }, cause?: unknown) {
    super(code, message);
    this.name = "WindowsJobStartFailedError";
    if (cause !== undefined) Object.defineProperty(this, "cause", { value: cause, writable: true, configurable: true, enumerable: false });
  }
}
/**
 * A stdin write the supervisor admitted (its bytes went to the pipe once and its sequence is spent and persisted)
 * whose drain was not acknowledged. Its outcome is unknown; the caller's next write uses the next sequence.
 */
export class WindowsJobInputUnacknowledgedError extends WindowsJobHostError {
  constructor(message: string) { super("process_control_unavailable", message); this.name = "WindowsJobInputUnacknowledgedError"; }
}
/**
 * A stdin write the supervisor refused before admission (HTTP 409: a previous write still drains, a stale sequence,
 * input unavailable, an unclaimed spare). No byte went to the pipe and the sequence was not spent.
 */
export class WindowsJobInputRefusedError extends WindowsJobHostError {
  constructor(message: string) { super("process_control_unavailable", message); this.name = "WindowsJobInputRefusedError"; }
}
/** A supervisor reply other than 200; the status says whether the supervisor refused before any effect (409). */
class SupervisorHttpError extends Error {
  constructor(readonly statusCode: number | undefined, message: string) { super(message); this.name = "SupervisorHttpError"; }
}

/** Digest-pin record for one compiled Job-host helper assembly. The digest lives
 * in the runner process's memory only and travels to each Job host over the
 * private stdin channel; no on-disk digest record is ever written or read. */
export interface WindowsJobHostHelperAssembly { readonly path: string; readonly sha256: string }

/**
 * PX-2a repair 1: the compiled helper is per-runner-process state. It is
 * compiled once into a fresh, unpredictable per-process directory, its digest
 * is kept in memory only, and a later runner process compiles its own
 * assembly to its own fresh path. There is no on-disk digest record to move,
 * no cross-process compile race, and no temp-file swap window: the C# source
 * travels to the compiler over a private stdin pipe (never a shared file),
 * and the output path arrives as a plain argv string (never parsed as
 * PowerShell, so no path content is executable).
 */
let jobHostHelperReady: WindowsJobHostHelperAssembly | null | undefined;
let jobHostHelperFlight: Promise<WindowsJobHostHelperAssembly | null> | undefined;
let jobHostHelperProcessDir: string | undefined;
/** N10: state directories already warned once that their calls run without the helper. */
const jobHostHelperFallbackWarned = new Set<string>();

/** Extract the embedded C# helper source from the Job-host script. Null when the markers are absent. */
export function extractJobHostHelperSource(scriptText: string): string | null {
  const start = scriptText.indexOf(JOB_HOST_SOURCE_MARKER_START);
  if (start < 0) return null;
  const bodyStart = start + JOB_HOST_SOURCE_MARKER_START.length;
  // The here-string closes on a line holding exactly `'@`.
  const end = scriptText.indexOf("\n'@", bodyStart);
  if (end < 0) return null;
  // N8: on CRLF checkouts the slice ends with a stray `\r` (the match consumed
  // the `\n` but not the `\r`), so strip it: the extracted source is then
  // byte-identical to PowerShell's here-string on either line ending.
  return scriptText.slice(bodyStart, end).replace(/^\r?\n/, "").replace(/\r?\n$/, "").replace(/\r$/, "");
}

/**
 * PX-2a: resolve the precompiled, digest-pinned Job-host helper assembly for
 * this runner process, compiling it once (asynchronously, off the event loop)
 * when absent. The digest is kept in memory and passed to each Job host over
 * the private stdin channel; the Job host re-hashes the file bytes before
 * loading from those bytes. Never throws: any failure returns null and the
 * call omits the helper fields, so each Job host falls back to in-process
 * Add-Type compile of the same source. The runner compiles AT MOST ONCE per
 * process: a failed compile is remembered for the runner's lifetime (every
 * later call falls back; a runner restart restores the fast path), and after
 * a pin nothing on disk is ever trusted again.
 */
export async function ensureJobHostHelperAssembly(): Promise<WindowsJobHostHelperAssembly | null> {
  try {
    if (process.platform !== "win32") return null;
    // R2-B1 and R3-B1: the runner never recompiles into the same place during
    // its lifetime. After a pin, a missing, emptied or changed file makes the
    // call fall back to in-process Add-Type (the Job host re-hashes the bytes
    // and reports missing-file / digest-mismatch). After a failed compile,
    // every later call falls back too: a retry into the same per-process
    // directory would let a contained process that is alive during the retry
    // get its own bytes hashed and pinned.
    if (jobHostHelperReady !== undefined) return jobHostHelperReady;
    if (jobHostHelperFlight) return await jobHostHelperFlight;
    const flight = compileJobHostHelperAssembly();
    jobHostHelperFlight = flight;
    try {
      const assembly = await flight;
      jobHostHelperReady = assembly;
      return assembly;
    } finally {
      if (jobHostHelperFlight === flight) jobHostHelperFlight = undefined;
    }
  } catch {
    jobHostHelperReady = null;
    return null;
  }
}

/**
 * Runner-internal one-time compile of the Job-host helper, in the same module
 * as the Job-host launch. Reads the embedded C# from the fixed Job-host
 * script, compiles it with a throwaway PowerShell into the per-process
 * directory, hashes the bytes it reads back, and keeps the digest in memory.
 * Null on any failure; never throws.
 */
async function compileJobHostHelperAssembly(): Promise<WindowsJobHostHelperAssembly | null> {
  try {
    const scriptText = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "managed-process-job-host.ps1"), "utf8");
    const source = extractJobHostHelperSource(scriptText);
    if (source === null) return null;
    const sourceDigest = createHash("sha256").update(source, "utf8").digest("hex");
    if (!jobHostHelperProcessDir) {
      jobHostHelperProcessDir = mkdtempSync(join(tmpdir(), "aiboard-job-host-assembly-"));
      const owned = jobHostHelperProcessDir;
      process.once("exit", () => {
        try {
          rmSync(owned, { recursive: true, force: true });
        } catch {}
      });
    }
    // PX-2a repair 3: Windows PowerShell 5.1 Add-Type resolves -OutputAssembly
    // as a wildcard path (an unescaped `[`/`]` does not resolve) and passes an
    // escaped path on to csc (which then fails), so a path holding wildcard
    // characters cannot be compiled to. Do not try: this runner process uses
    // the in-process Add-Type fallback, and the failure is remembered.
    if (/[[\]*?`]/.test(jobHostHelperProcessDir)) return null;
    const generationDir = join(jobHostHelperProcessDir, sourceDigest);
    mkdirSync(generationDir, { recursive: true });
    const dllPath = join(generationDir, JOB_HOST_HELPER_DLL_FILENAME);
    const wrapperPath = join(generationDir, "compile-helper-wrapper.ps1");
    rmSync(dllPath, { force: true });
    writeFileSync(wrapperPath, JOB_HOST_COMPILE_WRAPPER, "utf8");
    const exitCode = await new Promise<number>((resolvePromise) => {
      let settled = false;
      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        resolvePromise(code);
      };
      const child = spawn("powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapperPath, dllPath],
        { windowsHide: true, stdio: ["pipe", "ignore", "ignore"], timeout: JOB_HOST_COMPILE_TIMEOUT_MS, killSignal: "SIGKILL" });
      child.once("error", () => finish(-1));
      child.once("exit", (code) => finish(code ?? -1));
      const stdin = child.stdin;
      if (!stdin) {
        finish(-1);
        return;
      }
      stdin.write(`${Buffer.from(source, "utf8").toString("base64")}\n`, (error) => {
        if (error) finish(-1);
        else stdin.end();
      });
    });
    if (exitCode !== 0) return null;
    let bytes: Buffer;
    try {
      bytes = readFileSync(dllPath);
    } catch {
      return null;
    }
    if (bytes.byteLength === 0) return null;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    // N11: one source generation per runner process; drop any other digest dir.
    try {
      for (const entry of readdirSync(jobHostHelperProcessDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== sourceDigest)
          rmSync(join(jobHostHelperProcessDir, entry.name), { recursive: true, force: true });
      }
    } catch {}
    return { path: dllPath, sha256 };
  } catch {
    return null;
  }
}

/** The Windows birth inspection helper, compiled on this machine from its hash-pinned source. */
export interface WindowsBirthHelperAssembly { readonly path: string; readonly sha256: string; readonly sourceSha256: string }
interface WindowsBirthHelperBuild { readonly bytes: Buffer; readonly sha256: string; readonly sourceSha256: string }
// The name the inspection loader and session accept (windows-birth-inspection.mjs, windows-birth/session.mjs).
const BIRTH_HELPER_FILENAME = "helper.exe";
// Windows' own C# compiler, part of the in-box .NET Framework 4.8: a fixed path, never a PATH or current-directory
// lookup. It compiles C# 5 against the CLR 4 BCL, which is what helper-live.cs targets.
const WINDOWS_CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const WINDOWS_SYSTEM32 = "C:\\Windows\\System32";
/**
 * The flags of the helper.exe that used to ship: a windowless program (never a console of its own), x64, optimized,
 * no debug file, no csc.rsp, and only these three framework references. Warnings are not errors here: this compiles
 * against the machine's own framework, which a later update may change, and a warning must not stop inspection. CI
 * keeps the source warning-free with these flags and `/warnaserror+` (windows-birth-assembly.test.ts).
 */
export const WINDOWS_BIRTH_HELPER_COMPILE_FLAGS: readonly string[] = Object.freeze([
  "/nologo", "/noconfig", "/target:winexe", "/platform:x64", "/optimize+", "/debug-", "/warn:4", "/utf8output",
  "/reference:System.dll", "/reference:System.Core.dll", "/reference:System.Security.dll",
]);
// Everything besides the source that decides the compiled program. A recorded exe is reused only for the same source
// and the same recipe, so a change to the compiler path or flags compiles again even when helper-live.cs is unchanged.
const BIRTH_HELPER_RECIPE_SHA256 = createHash("sha256")
  .update(JSON.stringify({ compiler: WINDOWS_CSC, flags: WINDOWS_BIRTH_HELPER_COMPILE_FLAGS })).digest("hex");
const BIRTH_HELPER_RECORD_MAX_BYTES = 4096;
// The kernel's own `\SystemRoot` link to the running Windows directory, read without the environment. Where Windows
// lives elsewhere, `C:\Windows` may be an ordinary folder any local user could have created, so the compiler there is
// never run.
const SYSTEM_ROOT_LINK = "\\\\?\\GLOBALROOT\\SystemRoot";
// A new exe can be held by an antivirus scan for a moment, as a new Runner bundle is (self-update.ts): about 4.5 s.
const BIRTH_HELPER_RENAME_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800, 1000, 1000, 1000];
// As the inspection loader requires of its installation: a local drive, never a share, where another writer or a
// client cache could change the helper between its digest check and its start.
function assertLocalBirthPath(path: string, label: string): void {
  if (!/^[A-Za-z]:\\/.test(path)) throw new Error(`Windows birth helper ${label} must be on a local drive: ${path}`);
}
// Measured one-time compile of helper-live.cs on Windows 10: 90-96 ms warm and 306 ms on a first run. The ceiling is
// the Job host's compile ceiling; each caller also has its own preparation deadline.
const BIRTH_HELPER_COMPILE_TIMEOUT_MS = JOB_HOST_COMPILE_TIMEOUT_MS;
const birthHelperBuilds = new Map<string, Promise<WindowsBirthHelperBuild>>();

// One record per build in the birth directory: the digest of the exe compiled from one source with one recipe.
const BIRTH_HELPER_RECORD_SCHEMA = "aiboard-windows-birth-helper-record-v1";

/** The Runner's own Windows birth helper directory under its state directory in the per-user AIBoard home. */
export function windowsBirthHelperDirectory(runnerStateDirectory: string): string {
  return join(runnerStateDirectory, "windows-birth-helper");
}

/** How a process backend places its birth helper. */
export interface WindowsBirthHelperPlacementOptions {
  /**
   * Reuse an intact recorded exe across Runner starts instead of compiling. Only for a state directory the Runner was
   * given in the per-user AIBoard home, which is trusted as the installation is. Never for a shared default such as
   * one under TEMP, where another local user could have planted a record and an exe. Off by default.
   */
  readonly reuseRecorded?: boolean;
}

/**
 * The birth helper for one process backend, in that backend's own state directory: the exe at
 * `<state>/birth/<exe digest prefix>/helper.exe`, and, with `reuseRecorded`, `<state>/birth/build-<build key>.json`,
 * which records the digest of the exe compiled from this source with this recipe (compiler path and flags). The state
 * directory outlives the Runner, as the supervisors that run this helper may.
 *
 * With `reuseRecorded`, a Runner start uses the recorded exe without compiling when it is intact. Intact means the
 * record names this exact source and recipe, and the file is a regular, singly linked, canonical file, alone in its
 * directory, with the recorded digest. The state directory is trusted as the installation is: anyone who can rewrite it
 * can rewrite the Runner's own code, whose pins main's shipped helper relied on. So the record is this helper's pin, and
 * a record and exe planted there would be used until the source or recipe changes, just as rewritten Runner code would.
 *
 * Otherwise the source, checked against its pin, is compiled (at most once per Runner process), placed in a new digest
 * directory and, with `reuseRecorded`, recorded. That happens when the source or recipe changes, or the exe is missing
 * or changed. The compiler is not deterministic, so a new compile never rewrites the exe a supervisor started by an
 * earlier Runner may still run. The inspection loader checks the directory holds only the helper; the session refuses a
 * `.config` beside it, a linked path component, and a file whose held descriptor digest differs, before it starts the
 * helper. Any mismatch or failure throws, and inspection then fails closed.
 */
export async function provideWindowsBirthHelperAssembly(
  stateDirectory: string, source: Uint8Array, sourceSha256: string, options: WindowsBirthHelperPlacementOptions = {},
): Promise<WindowsBirthHelperAssembly> {
  if (process.platform !== "win32") throw new Error("Windows birth helper compile requires Windows.");
  if (!/^[0-9a-f]{64}$/.test(sourceSha256) || createHash("sha256").update(source).digest("hex") !== sourceSha256)
    throw new Error("Windows birth helper source does not match its pin.");
  mkdirSync(join(stateDirectory, "birth"), { recursive: true, mode: 0o700 });
  // Canonical (long-name) form: the session refuses any path whose canonical form differs, an 8.3 TEMP included.
  const birth = realpathSync.native(join(stateDirectory, "birth"));
  assertLocalBirthPath(birth, "state directory");
  // A .NET Framework program is started from a long path only where long paths are enabled; never depend on that.
  // Checked before the compile, which works under this directory and whose failure is remembered for the process.
  const expectedLength = Math.max(birthHelperPath(birth, "0".repeat(64)).length, join(birth, ".compile-XXXXXX", "helper-live.cs").length);
  if (expectedLength >= 260) throw new Error(`Windows birth helper path is too long to start (${expectedLength} characters) under: ${birth}`);
  const reuse = options.reuseRecorded === true;
  const buildKey = createHash("sha256").update(`${sourceSha256}\n${BIRTH_HELPER_RECIPE_SHA256}`).digest("hex").slice(0, 16);
  const recordPath = join(birth, `build-${buildKey}.json`);
  const recorded = reuse ? readBirthHelperRecord(recordPath, sourceSha256) : undefined;
  if (recorded !== undefined && birthHelperIntact(birth, recorded))
    return Object.freeze({ path: birthHelperPath(birth, recorded), sha256: recorded, sourceSha256 });
  // The compile works inside this local directory, never TEMP, which may be on a share.
  const build = await compileWindowsBirthHelper(source, sourceSha256, birth);
  const path = await placeBirthHelper(birth, build);
  // Best effort: without its record the next start compiles again, which is slower but never unsafe.
  if (reuse && recorded !== build.sha256) {
    try { await writeBirthHelperRecord(birth, recordPath, sourceSha256, build.sha256); } catch {}
  }
  return Object.freeze({ path, sha256: build.sha256, sourceSha256 });
}

function birthHelperPath(birth: string, sha256: string): string {
  return join(birth, sha256.slice(0, 16), BIRTH_HELPER_FILENAME);
}

/** The recorded exe digest for exactly this source and recipe, or undefined for a missing, foreign or malformed record. */
function readBirthHelperRecord(recordPath: string, sourceSha256: string): string | undefined {
  try {
    const stat = lstatSync(recordPath);
    if (!stat.isFile() || stat.size > BIRTH_HELPER_RECORD_MAX_BYTES) return undefined;
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    if (!record || typeof record !== "object" || Array.isArray(record) ||
        Object.keys(record).sort().join(",") !== "recipeSha256,schema,sha256,sourceSha256" || record.schema !== BIRTH_HELPER_RECORD_SCHEMA ||
        record.sourceSha256 !== sourceSha256 || record.recipeSha256 !== BIRTH_HELPER_RECIPE_SHA256 ||
        typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.sha256)) return undefined;
    return record.sha256;
  } catch { return undefined; }
}

/** Whether the recorded exe is exactly what the loader and session accept, with the recorded digest. */
function birthHelperIntact(birth: string, sha256: string): boolean {
  const path = birthHelperPath(birth, sha256);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1) return false;
    if (JSON.stringify(readdirSync(dirname(path))) !== JSON.stringify([BIRTH_HELPER_FILENAME])) return false;
    if (realpathSync.native(path) !== path) return false;
    return createHash("sha256").update(readFileSync(path)).digest("hex") === sha256;
  } catch { return false; }
}

async function writeBirthHelperRecord(birth: string, recordPath: string, sourceSha256: string, sha256: string): Promise<void> {
  const temporary = join(birth, `.${randomUUID()}.tmp`);
  const record = { schema: BIRTH_HELPER_RECORD_SCHEMA, sourceSha256, recipeSha256: BIRTH_HELPER_RECIPE_SHA256, sha256 };
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
  try { await renameBirthHelperFile(temporary, recordPath); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
}

/** Places a build's bytes at `<birth>/<digest prefix>/helper.exe` and returns that canonical path. */
async function placeBirthHelper(birth: string, build: WindowsBirthHelperBuild): Promise<string> {
  const path = birthHelperPath(birth, build.sha256);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Each compile has its own digest, so this directory is this build's alone. Configuration, DLL probing and .local
  // redirection beside the helper are never selected: anything else here fails closed instead of being removed.
  const sidecars = readdirSync(directory).filter((name) => name.toLowerCase() !== BIRTH_HELPER_FILENAME);
  if (sidecars.length > 0) throw new Error(`Unexpected Windows birth helper sidecar: ${sidecars.slice(0, 4).join(", ")}`);
  // The session accepts only a regular, singly linked file, so anything else here is removed and written again.
  const placed = (): boolean => {
    let stat;
    try { stat = lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    if (!stat.isFile() || stat.nlink !== 1) { rmSync(path, { force: true }); return false; }
    return createHash("sha256").update(readFileSync(path)).digest("hex") === build.sha256;
  };
  if (!placed()) {
    // Written beside the digest directory, never inside it, then renamed into place.
    const temporary = join(birth, `.${randomUUID()}.tmp`);
    writeFileSync(temporary, build.bytes, { flag: "wx", mode: 0o700 });
    try { await renameBirthHelperFile(temporary, path); }
    catch (error) { rmSync(temporary, { force: true }); if (!placed()) throw error; }
    if (!placed()) throw new Error("Windows birth helper changed after it was placed.");
  }
  // The digest directory or the helper must not be a link or junction to somewhere else.
  if (realpathSync.native(path) !== path) throw new Error(`Windows birth helper path is not canonical: ${path}`);
  return path;
}

async function renameBirthHelperFile(temporary: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try { renameSync(temporary, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const wait = BIRTH_HELPER_RENAME_RETRY_DELAYS_MS[attempt];
      if (wait === undefined || !code || !["EPERM", "EACCES", "EBUSY"].includes(code)) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, wait));
    }
  }
}

/**
 * Compiles `windows-birth/helper-live.cs` into an exe with Windows' own C# compiler, at most once per Runner process
 * and source, and keeps the bytes in memory. No binary ships with AIBoard. The compile runs in System32 with a minimal
 * environment whose TEMP is its own private directory under `compileRoot` (the first caller's local, canonical birth
 * directory), and without csc.rsp (`/noconfig`), so only the three named framework references are used. The compiler
 * is not deterministic, so each compile has its own digest. As with the Job host's helper, a failed compile is
 * remembered for the process lifetime: a retry would give a process alive at that moment a second chance to have its
 * own bytes compiled and pinned.
 */
function compileWindowsBirthHelper(source: Uint8Array, sourceSha256: string, compileRoot: string): Promise<WindowsBirthHelperBuild> {
  if (process.platform !== "win32") return Promise.reject(new Error("Windows birth helper compile requires Windows."));
  if (!/^[0-9a-f]{64}$/.test(sourceSha256) || createHash("sha256").update(source).digest("hex") !== sourceSha256)
    return Promise.reject(new Error("Windows birth helper source does not match its pin."));
  const cached = birthHelperBuilds.get(sourceSha256);
  if (cached) return cached;
  const flight = compileWindowsBirthHelperExecutable(Buffer.from(source), sourceSha256, compileRoot);
  birthHelperBuilds.set(sourceSha256, flight);
  return flight;
}

/** Test-only: forget this process's birth helper builds, so the next call without an intact record compiles again. */
export function resetWindowsBirthHelperBuildsForTests(): void {
  birthHelperBuilds.clear();
}

async function compileWindowsBirthHelperExecutable(source: Buffer, sourceSha256: string, compileRoot: string): Promise<WindowsBirthHelperBuild> {
  const generationDir = realpathSync.native(mkdtempSync(join(compileRoot, ".compile-")));
  try {
    assertLocalBirthPath(generationDir, "compile directory");
    // Case-insensitive, as Windows names are: an upgraded install may be `C:\WINDOWS`.
    if (realpathSync.native(SYSTEM_ROOT_LINK).toLowerCase() !== "c:\\windows" || realpathSync.native(WINDOWS_CSC).toLowerCase() !== WINDOWS_CSC.toLowerCase())
      throw new Error("Windows' own C# compiler is not at its fixed path in the running Windows directory.");
    const sourcePath = join(generationDir, "helper-live.cs");
    const exePath = join(generationDir, BIRTH_HELPER_FILENAME);
    writeFileSync(sourcePath, source, { flag: "wx", mode: 0o600 });
    const environment = {
      SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", PATH: WINDOWS_SYSTEM32, PATHEXT: ".COM;.EXE;.BAT;.CMD",
      TEMP: generationDir, TMP: generationDir,
    };
    const outcome = await new Promise<{ code: number | null; output: string; error?: Error }>((resolvePromise) => {
      let settled = false; let output = "";
      const finish = (code: number | null, error?: Error): void => {
        if (settled) return;
        settled = true;
        resolvePromise({ code, output, ...(error ? { error } : {}) });
      };
      const child = spawn(WINDOWS_CSC, [
        ...WINDOWS_BIRTH_HELPER_COMPILE_FLAGS,
        `/out:${exePath}`, sourcePath,
      ], { cwd: WINDOWS_SYSTEM32, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: BIRTH_HELPER_COMPILE_TIMEOUT_MS, killSignal: "SIGKILL" });
      // csc reports errors on stdout.
      const collect = (chunk: Buffer): void => { if (output.length < 4096) output += chunk.toString("utf8"); };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.once("error", (error) => finish(null, error));
      child.once("close", (code) => finish(code));
    });
    if (outcome.code !== 0)
      throw new Error(`Windows birth helper compile failed (exit ${String(outcome.code)}): ${outcome.output.slice(0, 1024)}`, outcome.error ? { cause: outcome.error } : undefined);
    if (createHash("sha256").update(readFileSync(sourcePath)).digest("hex") !== sourceSha256)
      throw new Error("Windows birth helper source changed during its compile.");
    const bytes = readFileSync(exePath);
    if (bytes.byteLength < 512) throw new Error("Windows birth helper compile produced no program.");
    return Object.freeze({ bytes, sha256: createHash("sha256").update(bytes).digest("hex"), sourceSha256 });
  } finally {
    try { rmSync(generationDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Test-only reset for the per-process helper cache (prove-red and fallback
 * pins): drops the ready assembly and any in-flight compile and forgets the
 * per-process directory, so the next call recompiles from the current script
 * and environment. Never throws. Production code never calls this.
 */
export function resetJobHostHelperAssemblyForTests(): void {
  jobHostHelperReady = undefined;
  jobHostHelperFlight = undefined;
  jobHostHelperProcessDir = undefined;
}

/**
 * N10: warn once per state directory when its calls run without the precompiled
 * helper. Per-call tamper fallbacks (a replaced or damaged assembly file) keep
 * their reason in that call's `job-events.jsonl` helper event: launch resolves
 * at supervisor startup, before the Job host boots and writes its event, so
 * the runner has no later observation point without extra I/O on every call.
 */
export function logJobHostHelperFallbackOnce(stateDirectory: string, reason: string): void {
  if (jobHostHelperFallbackWarned.has(stateDirectory)) return;
  jobHostHelperFallbackWarned.add(stateDirectory);
  console.warn(`[runner-windows-job-v1] precompiled Job-host helper unavailable (${reason}); calls in ${stateDirectory} fall back to in-process compile.`);
}

/** Concrete authenticated owner of Job records, supervisors, control and output. */
export class AuthenticatedWindowsJobProcessHost implements WindowsJobProcessHost {
  private readonly stateDirectory: string;
  private readonly helperFallbackWarningKey: string;
  private readonly platform: NodeJS.Platform;
  private readonly idFactory: () => string;
  private readonly clock: () => string;
  private readonly maxPollBytes: number;
  private readonly startDeadlineMs: number;
  private readonly injectedLaunchFault: WindowsJobInjectedLaunchFault | undefined;
  private readonly startWaitSignal: AbortSignal | undefined;
  private readonly controlDeadlineMs: number;
  private readonly stopDeadlineMs: number;
  private readonly maxRetainedOutputChunks: number;
  private readonly maxRetainedOutputBytes: number;
  private readonly maxRetainedOutputChunkBytes: number;
  private readonly maxInputBytes: number;
  private readonly supervisorScriptPath: string;
  private readonly activeJobProbe?: WindowsJobProcessHostOptions["activeJobProbe"];
  private readonly beforeFenceEffect?: WindowsJobProcessHostOptions["beforeFenceEffect"];
  private readonly records = new Map<string, HostRecord>();
  private readonly effectTails = new Map<string, Promise<void>>();
  private readonly launchers = new Set<ChildProcess>();
  /** PX-2c: pre-started spare pairs, at most one per run and at most maxSpares in all. */
  private readonly spareOptions: WindowsJobSpareOptions;
  private readonly spareEntries = new Map<string, SpareEntry>();
  private readonly sparePrestartFlights = new Map<string, Promise<WindowsJobSpareInfo>>();
  private readonly spareCounts = { prestarts: 0, claims: 0, fallbacks: 0 };
  /** keepWarm: runs whose spare was retired; no new spare for them until they launch again. */
  private readonly retiredSpareRuns = new Set<string>();
  /** keepWarm: consecutive background prestart failures; at the limit this host stops keeping a spare warm. */
  private keepWarmFailures = 0;
  private readonly recordScanLimit: number;
  /** The last record file name a bounded maintenance scan read; the next scan starts after it. */
  private recordScanCursor: string | undefined;
  /** Startup crash recovery still running in the background for records past the constructor's bounded slice. */
  private startupRecovery: Promise<void> | undefined;
  private readonly retentionSupervisorExitMs: number;
  /** Retention: process ids a pass is working on now; a second pass on the same id keeps it instead of racing. */
  private readonly retentionInFlight = new Set<string>();
  /** Spare process ids this host started, by run: a run-end sweep always reaches its own, whatever its window. */
  private readonly startedSpares = new Map<string, Set<string>>();

  constructor(options: WindowsJobProcessHostOptions) {
    this.stateDirectory = resolve(options.stateDirectory);
    this.helperFallbackWarningKey = options.helperFallbackWarningKey ?? this.stateDirectory;
    this.platform = options.platform ?? process.platform;
    this.idFactory = options.idFactory ?? (() => `process_${randomUUID()}`);
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.maxPollBytes = options.maxPollBytes ?? 256 * 1024;
    this.startDeadlineMs = options.startDeadlineMs ?? DEFAULT_START_CEILING_MS;
    this.injectedLaunchFault = options.injectedLaunchFault;
    this.startWaitSignal = options.startWaitSignal;
    this.controlDeadlineMs = options.controlDeadlineMs ?? DEFAULT_CONTROL_DEADLINE_MS;
    this.stopDeadlineMs = options.stopDeadlineMs ?? AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS;
    this.maxRetainedOutputChunks = options.maxRetainedOutputChunks ?? 16;
    this.maxRetainedOutputBytes = options.maxRetainedOutputBytes ?? 256 * 1024;
    this.maxRetainedOutputChunkBytes = options.maxRetainedOutputChunkBytes ?? 16 * 1024;
    this.maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
    if (!Number.isSafeInteger(this.maxInputBytes) || this.maxInputBytes < 1) throw new Error("Windows Job max input bytes must be positive.");
    this.supervisorScriptPath = options.supervisorScriptPath ?? join(dirname(fileURLToPath(import.meta.url)), "managed-process-supervisor.mjs");
    this.activeJobProbe = options.activeJobProbe;
    this.beforeFenceEffect = options.beforeFenceEffect;
    this.spareOptions = options.spare ?? {};
    this.recordScanLimit = options.maxRecordScan ?? DEFAULT_RECORD_SCAN_LIMIT;
    if (!Number.isSafeInteger(this.recordScanLimit) || this.recordScanLimit < 1) throw new Error("Windows Job record scan limit must be positive.");
    this.retentionSupervisorExitMs = options.retentionSupervisorExitMs ?? DEFAULT_RETENTION_SUPERVISOR_EXIT_MS;
    if (!Number.isSafeInteger(this.retentionSupervisorExitMs) || this.retentionSupervisorExitMs < 0) throw new Error("Windows Job retention supervisor wait must not be negative.");
    mkdirSync(this.stateDirectory, { recursive: true });
    // Bounded startup: the constructor reads at most recordScanLimit records, as before every record of a smaller
    // directory. The rest of a larger one gets the same crash recovery in bounded background batches, so no previous
    // Runner's spare is left unrecovered; nothing in this Runner can use those records' process ids meanwhile.
    const names = listRecordNames(this.stateDirectory);
    for (const name of names.slice(0, this.recordScanLimit)) {
      const value = this.readStartupRecord(name);
      if (value) this.records.set(value.processId, value);
    }
    // PX-2c repair 1 (B1/L3): crash recovery. An unclaimed spare is owned
    // durably (its record survives a runner crash) but must never be adopted
    // as a call. A new runner on this state directory drops the previous
    // runner's spare records instead of relaunching anything, and retires a
    // previous spare's processes only through the audited helpers below:
    // previous idle spares through killVerifiedSpareSupervisor — never by a
    // never by a recorded PID alone, only after an authenticated live-status
    // proof with the record's token — and pairs lost inside their claim window
    // (spareClaimInFlight) through retireVerifiedClaimWindowTree, which accepts
    // the expected claimed proof, retires the whole tree, and keeps the record.
    for (const value of [...this.records.values()]) this.recoverPreviousSpare(value);
    // Records a retention pass marked and could not finish (its process may have been the previous Runner) are
    // finished in the background, once the supervisor has gone, with the records past the slice.
    const marked = [...this.records.values()].filter((value) => value.retentionRemovingAt !== undefined);
    const rest = names.slice(this.recordScanLimit);
    if (rest.length > 0 || marked.length > 0) this.startupRecovery = this.recoverRemainingStartupRecords(rest, marked);
  }

  /** One record file as the startup scan reads it; an invalid name or unreadable JSON throws, as it always has. */
  private readStartupRecord(name: string): HostRecord | null {
    const requestedProcessId = name.slice(0, -".json".length);
    this.assertProcessId(requestedProcessId);
    const value = JSON.parse(readFileSync(join(this.stateDirectory, name), "utf8")) as Partial<HostRecord>;
    if (!isHostRecord(value)) return null;
    this.assertEmbeddedProcessId(requestedProcessId, value);
    return value;
  }

  /** Startup crash recovery for one previous Runner's record: a no-op unless it is an unclaimed spare (see above). */
  private recoverPreviousSpare(value: HostRecord): void {
    if (value.spare !== true || value.spareClaimed === true) return;
    const processId = value.processId;
    // Snapshot the durable status BEFORE the files below are dropped: the
    // async identity proof still needs it, and the record must be gone
    // synchronously (S5/S6 pin the synchronous drop). N3: an unreadable
    // status path is no proof, never a constructor throw.
    let durable: SupervisorStatus | null = null;
    try {
      durable = readSupervisorStatus(value.supervisor.statusPath);
    } catch {
      durable = null;
    }
    this.records.delete(processId);
    if (value.spareClaimInFlight === true) {
      try {
        this.persistOnce({ ...value, spareReapedAt: this.clock() });
      } catch {}
    } else {
      this.removeSpareFiles(processId);
    }
    void killVerifiedSpareSupervisor(value, durable, SPARE_REAP_VERIFY_TIMEOUT_MS).catch(() => undefined);
    void retireVerifiedClaimWindowTree(value, durable, SPARE_REAP_VERIFY_TIMEOUT_MS, SPARE_RETIRE_TREE_TIMEOUT_MS, this.stopDeadlineMs).catch(() => undefined);
  }

  /**
   * The startup crash recovery for the records past the constructor's bounded slice, recordScanLimit at a time with
   * the event loop free between batches, and the finishing of records a retention pass marked. Records past the slice
   * are only recovered, not cached: call records are read from disk when used. A record file that cannot be read is
   * skipped, as a run-end sweep skips it (only the constructor's own slice still refuses startup on one, since a
   * background batch has no caller to refuse); the skipped ones are named once in a warning. Never throws.
   */
  private async recoverRemainingStartupRecords(names: readonly string[], marked: readonly HostRecord[]): Promise<void> {
    const skipped: string[] = [];
    for (const value of marked) await this.finishMarkedRecord(value).catch(() => undefined);
    for (let index = 0; index < names.length; index += this.recordScanLimit) {
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      for (const name of names.slice(index, index + this.recordScanLimit)) {
        let value: HostRecord | null;
        try { value = this.readStartupRecord(name); }
        catch { skipped.push(name); continue; }
        if (!value) continue;
        try { this.recoverPreviousSpare(value); } catch {}
        if (value.retentionRemovingAt !== undefined) await this.finishMarkedRecord(value).catch(() => undefined);
      }
    }
    if (skipped.length > 0)
      console.warn(`[runner-windows-job-v1] ${skipped.length} unreadable Job record file(s) in ${this.stateDirectory} were skipped at startup: ${skipped.slice(0, 8).join(", ")}${skipped.length > 8 ? ", ..." : ""}`);
  }

  /** Finishes a record a retention pass marked, only once its supervisor is gone; never waits for it. */
  private async finishMarkedRecord(value: HostRecord): Promise<void> {
    await this.retireReleasedRecord({ processId: value.processId, sessionId: value.sessionId, startedAt: value.startedAt }, value.runId);
  }

  async launchOwned(input: WindowsJobLaunchRequest): Promise<WindowsJobProcessSnapshot> {
    if (this.platform !== "win32" || process.platform !== "win32")
      throw new WindowsJobHostError("process_containment_unavailable", "Windows Job containment is unavailable on this platform.");
    assertUsableWorkingDirectory(input.workingDirectory, "win32");
    // A run that launches is active again: keepWarm may start spares for it.
    this.retiredSpareRuns.delete(input.runId);
    // PX-2c: claim the pre-started spare when one is waiting. Any miss, death,
    // staleness, or identity failure returns null and the call starts the
    // normal way below, exactly as today.
    const spareSnapshot = await this.tryClaimSpareCall(input).catch((error: unknown) => {
      if (error instanceof WindowsJobHostError) throw error;
      return null;
    });
    if (spareSnapshot) {
      this.refreshSpareInBackground(input);
      return spareSnapshot;
    }
    // PX-2a repair 1 (N2): resolve the precompiled helper BEFORE spawning the
    // supervisor. ensureJobHostHelperAssembly never throws, so a helper-side
    // failure (unusable TEMP, missing compiler) can no longer strand a
    // spawned supervisor behind a persisted `running` record: the call simply
    // omits the helper fields and falls back.
    const helperAssembly = await ensureJobHostHelperAssembly().catch(() => null);
    if (!helperAssembly) logJobHostHelperFallbackOnce(this.helperFallbackWarningKey, "no-helper-config");
    const processId = this.validatedProcessId(this.idFactory());
    if (this.readRecord(processId)) throw new WindowsJobHostError("process_id_conflict", `Process ${processId} already exists.`);
    const processDirectory = this.containedProcessPath(processId, "");
    mkdirSync(processDirectory, { recursive: true });
    const token = randomBytes(32).toString("hex");
    const statusPath = join(processDirectory, "supervisor.jsonl");
    const launcher = spawnSupervisorProcess(this.supervisorScriptPath, processId, statusPath);
    this.launchers.add(launcher);
    launcher.once("exit", () => this.launchers.delete(launcher));
    launcher.once("error", () => this.launchers.delete(launcher));
    if (!launcher.pid) throw new WindowsJobHostError("process_start_failed", "Supervisor process has no PID.");
    const now = this.clock();
    const record: HostRecord = {
      processId, pid: 0, runId: input.runId, sessionId: input.sessionId,
      command: input.command, args: [...input.args], cwd: resolve(input.workingDirectory),
      environmentKeys: Object.keys(input.environment).sort(), startedAt: now, updatedAt: now,
      status: "running", exitCode: null, signal: null,
      stdoutPath: join(processDirectory, "stdout.log"), stderrPath: join(processDirectory, "stderr.log"),
      supervisor: { protocol: PROTOCOL, token, statusPath, supervisorPid: launcher.pid, port: 0 },
      interactive: input.interactive === true,
      nextInputSequence: 1,
      inputClosed: false,
      outputOffsets: { stdout: 0, stderr: 0 },
      outputSequences: { stdout: 0, stderr: 0 },
      ...(input.fence ? { currentFence: { ...input.fence } } : {}),
    };
    this.records.set(processId, record);
    // PX-2a repair 1: the digest is this runner process's in-memory pin and
    // travels over the private stdin channel, never argv, env, or HTTP; a
    // null here omits the fields and the Job host falls back to in-process
    // Add-Type compile.
    try {
      // Inside the try: a record that cannot be written aborts the supervisor waiting for its config.
      await this.persist(record);
      await writeSupervisorConfig(launcher, JSON.stringify({
        processId, token, statusPath, stdoutPath: windowsNativeFilePath(record.stdoutPath), stderrPath: windowsNativeFilePath(record.stderrPath),
        eventPath: windowsNativeFilePath(join(processDirectory, "job-events.jsonl")),
        recordPath: this.containedProcessPath(processId, ".json"),
        command: input.command, args: [...input.args], cwd: record.cwd,
        env: { ...input.environment }, stopDeadlineMs: this.stopDeadlineMs, interactive: input.interactive === true,
        maxPollBytes: this.maxPollBytes,
        maxRetainedOutputChunks: this.maxRetainedOutputChunks,
        maxRetainedOutputBytes: this.maxRetainedOutputBytes,
        maxRetainedOutputChunkBytes: this.maxRetainedOutputChunkBytes,
        maxInputBytes: this.maxInputBytes,
        ...(helperAssembly ? { helperAssemblyPath: helperAssembly.path, helperAssemblySha256: helperAssembly.sha256 } : {}),
        ...(this.injectedLaunchFault ? { injectedFault: this.injectedLaunchFault } : {}),
      }));
      const status = await waitForSupervisor(record.supervisor, processId, this.startDeadlineMs, () => childAlive(launcher), this.startSignal(input));
      await this.applyStatus(record, status);
      throwIfStartFailed(status);
    } catch (error) {
      // The abort waits for the host's exit, which records the start's stop; the error carries the exact record, so
      // the caller settles it on that recorded proof (reconcile, verify-empty, release).
      await abortStartingSupervisor(launcher, token, this.stopDeadlineMs).catch(() => undefined);
      await this.settleDiscardedStartOutput(record).catch(() => undefined);
      throw new WindowsJobStartFailedError(error instanceof WindowsJobHostError ? error.code : "process_start_failed",
        error instanceof Error ? error.message : "Windows Job start failed.", { processId, startedAt: record.startedAt }, error);
    }
    if (launcher.connected) launcher.disconnect(); launcher.unref(); this.launchers.delete(launcher);
    if (this.spareOptions.keepWarm === true && input.interactive === true) this.refreshSpareInBackground(input);
    return this.snapshot(record);
  }

  /**
   * PX-2c: pre-start at most one spare supervisor plus Job-host pair. The pair
   * waits idle with NO Job and NO child until one launchOwned claims it; the
   * claim then creates that call's own Job (suspended-create, assign, resume,
   * kill-on-close) exactly as today. The reservation travels over the private
   * supervisor stdin channel; the claim over the private IPC channel; HTTP
   * only observes until the claim lands. The spare is recorded durably like a
   * launch, retires on idle timeout or parent death, and is never reused.
   */
  async prestartSpare(owner: WindowsJobOwnershipKey): Promise<WindowsJobSpareInfo> {
    if (this.platform !== "win32" || process.platform !== "win32")
      throw new WindowsJobHostError("process_containment_unavailable", "Windows Job containment is unavailable on this platform.");
    const spareInfo = (entry: SpareEntry): WindowsJobSpareInfo => ({ processId: entry.processId, supervisorPid: entry.launcher.pid ?? 0 });
    const live = this.liveSpareEntry(owner.runId);
    if (live) return spareInfo(live);
    const pending = this.sparePrestartFlights.get(owner.runId);
    if (pending) return await pending;
    if (this.liveSpareCount() + this.sparePrestartFlights.size >= Math.max(1, this.spareOptions.maxSpares ?? 1)) {
      // At capacity: report a waiting (or starting) spare of another run, as the single-slot host did.
      const other = [...this.spareEntries.values()][0];
      if (other) return spareInfo(other);
      const otherFlight = [...this.sparePrestartFlights.values()][0];
      if (otherFlight) return await otherFlight;
    }
    const flight = this.startSpare(owner);
    this.sparePrestartFlights.set(owner.runId, flight);
    try {
      return await flight;
    } finally {
      if (this.sparePrestartFlights.get(owner.runId) === flight) this.sparePrestartFlights.delete(owner.runId);
    }
  }

  /**
   * PX-2c: run-end cleanup. Retire the tracked spare (if any) plus any spare
   * records left behind on disk, without ever launching a call. Best-effort
   * and never throws: calls never depend on the spare.
   */
  async retireSpare(closingRun?: { readonly runId: string }): Promise<void> {
    // Mark first: a refresh racing this retirement must not start a new spare for the closing run.
    if (closingRun) this.retiredSpareRuns.add(closingRun.runId);
    const runIds = closingRun ? [closingRun.runId] : [...new Set([...this.sparePrestartFlights.keys(), ...this.spareEntries.keys()])];
    for (const runId of runIds) {
      const flight = this.sparePrestartFlights.get(runId);
      if (flight) await flight.catch(() => undefined);
      const entry = this.spareEntries.get(runId);
      // PX-2c repair 1 (M3): a run end retires only its own spare. Another
      // run's waiting spare (and its disk record) is left for its owner.
      // PX-2c repair 1 (B2): the redundant launcher kill is gone:
      // abortStartingSupervisor already SIGKILLs when no ack arrives.
      if (entry) {
        this.spareEntries.delete(runId);
        await abortStartingSupervisor(entry.launcher, entry.token, this.stopDeadlineMs).catch(() => undefined);
        this.removeSpareFiles(entry.processId);
        this.records.delete(entry.processId);
      }
    }
    await this.sweepRetiredSpareRecords(closingRun);
  }

  /** PX-2c: spare counters for measurement and tests. */
  spareStats(): WindowsJobSpareStats {
    return { ...this.spareCounts };
  }

  async awaitSupervisorsExited(timeoutMs: number): Promise<readonly number[]> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    // The records' supervisors, and any launcher still tracked (a record written before its PID was known has 0).
    const pids = [...this.records.values()].map((record) => record.supervisor.supervisorPid);
    for (const launcher of this.launchers) if (launcher.pid) pids.push(launcher.pid);
    let alive = [...new Set(pids.filter((pid) => pid > 0))];
    for (;;) {
      alive = alive.filter(processIsAlive);
      if (alive.length === 0 || Date.now() >= deadline) return alive;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }

  private async startSpare(owner: WindowsJobOwnershipKey): Promise<WindowsJobSpareInfo> {
    // PX-2a repair 1 (N2): resolve the precompiled helper BEFORE spawning the
    // supervisor. ensureJobHostHelperAssembly never throws, so a helper-side
    // failure (unusable TEMP, missing compiler) can no longer strand a
    // spawned supervisor behind a persisted `running` record: the call simply
    // omits the helper fields and falls back.
    const helperAssembly = await ensureJobHostHelperAssembly().catch(() => null);
    if (!helperAssembly) logJobHostHelperFallbackOnce(this.helperFallbackWarningKey, "no-helper-config");
    const processId = this.validatedProcessId(this.idFactory());
    if (this.readRecord(processId)) throw new WindowsJobHostError("process_id_conflict", `Process ${processId} already exists.`);
    const processDirectory = this.containedProcessPath(processId, "");
    mkdirSync(processDirectory, { recursive: true });
    const token = randomBytes(32).toString("hex");
    const statusPath = join(processDirectory, "supervisor.jsonl");
    const launcher = spawnSupervisorProcess(this.supervisorScriptPath, processId, statusPath);
    this.launchers.add(launcher);
    // The spare slot is NOT cleared here: a dead launcher must still be seen
    // by the next claim (counted fallback with best-effort cleanup) or the
    // next prestart (liveness check starts fresh), never silently dropped.
    launcher.once("exit", () => {
      this.launchers.delete(launcher);
    });
    launcher.once("error", () => {
      this.launchers.delete(launcher);
    });
    const supervisorPid = launcher.pid;
    if (!supervisorPid) throw new WindowsJobHostError("process_start_failed", "Supervisor process has no PID.");
    const now = this.clock();
    const record: HostRecord = {
      processId, pid: 0, runId: owner.runId, sessionId: owner.sessionId,
      command: "", args: [], cwd: this.stateDirectory,
      environmentKeys: [], startedAt: now, updatedAt: now,
      status: "running", exitCode: null, signal: null,
      stdoutPath: join(processDirectory, "stdout.log"), stderrPath: join(processDirectory, "stderr.log"),
      supervisor: { protocol: PROTOCOL, token, statusPath, supervisorPid, port: 0 },
      interactive: true,
      nextInputSequence: 1,
      inputClosed: false,
      outputOffsets: { stdout: 0, stderr: 0 },
      outputSequences: { stdout: 0, stderr: 0 },
      spare: true, spareClaimed: false,
    };
    this.records.set(processId, record);
    // PX-2a repair 1: the digest is this runner process's in-memory pin and
    // still travels over the private stdin channel per call site.
    const idleTimeoutMs = this.spareOptions.idleTimeoutMs;
    try {
      // Inside the try: a record that cannot be written aborts the spare and forgets it.
      await this.persist(record);
      await writeSupervisorConfig(launcher, JSON.stringify({
        processId, token, statusPath, stdoutPath: windowsNativeFilePath(record.stdoutPath), stderrPath: windowsNativeFilePath(record.stderrPath),
        eventPath: windowsNativeFilePath(join(processDirectory, "job-events.jsonl")),
        recordPath: this.containedProcessPath(processId, ".json"),
        stopDeadlineMs: this.stopDeadlineMs, interactive: true,
        maxPollBytes: this.maxPollBytes,
        maxRetainedOutputChunks: this.maxRetainedOutputChunks,
        maxRetainedOutputBytes: this.maxRetainedOutputBytes,
        maxRetainedOutputChunkBytes: this.maxRetainedOutputChunkBytes,
        maxInputBytes: this.maxInputBytes,
        ...(helperAssembly ? { helperAssemblyPath: helperAssembly.path, helperAssemblySha256: helperAssembly.sha256 } : {}),
        ...(this.injectedLaunchFault ? { injectedFault: this.injectedLaunchFault } : {}),
        spare: true,
        ...(typeof idleTimeoutMs === "number" && Number.isSafeInteger(idleTimeoutMs) ? { spareIdleTimeoutMs: idleTimeoutMs } : {}),
      }));
      await waitForSpareReadyStatus(record.supervisor, processId, this.startDeadlineMs, () => childAlive(launcher));
    } catch (error) {
      await abortStartingSupervisor(launcher, token, this.stopDeadlineMs).catch(() => undefined);
      this.removeSpareFiles(processId);
      this.records.delete(processId);
      throw error;
    }
    // No disconnect/unref: the IPC channel stays open for the single claim,
    // and its break retires the spare when the owning runner dies.
    this.spareEntries.set(owner.runId, { launcher, token, processId, owner: { runId: owner.runId, sessionId: owner.sessionId } });
    const started = this.startedSpares.get(owner.runId) ?? new Set<string>();
    started.add(processId); this.startedSpares.set(owner.runId, started);
    this.spareCounts.prestarts += 1;
    return { processId, supervisorPid };
  }

  /** Waiting spares that are still alive; dead ones are cleaned on the way. */
  private liveSpareCount(): number {
    return [...this.spareEntries.keys()].filter((runId) => this.liveSpareEntry(runId) !== undefined).length;
  }

  /** Synchronous liveness check for a run's spare slot; a stale slot is cleaned so a fresh prestart never blocks on it. */
  private liveSpareEntry(runId: string): SpareEntry | undefined {
    const entry = this.spareEntries.get(runId);
    if (!entry) return undefined;
    const { launcher, processId } = entry;
    let record: HostRecord | null = null;
    try {
      record = this.readRecord(processId);
    } catch {
      record = null;
    }
    const status = record ? readSupervisorStatus(record.supervisor.statusPath) : null;
    const alive = launcher.exitCode === null && launcher.signalCode === null && !launcher.killed && launcher.connected
      && record !== null && record.spare === true && record.spareClaimed !== true
      && status !== null && status.processId === processId
      && status.supervisorPid === record.supervisor.supervisorPid
      && status.spare === true && status.claimed !== true && status.spareReady === true && status.port > 0;
    if (alive) return entry;
    if (this.spareEntries.get(runId) === entry) this.spareEntries.delete(runId);
    void abortStartingSupervisor(launcher, entry.token, this.stopDeadlineMs).catch(() => undefined);
    this.removeSpareFiles(processId);
    this.records.delete(processId);
    return undefined;
  }

  /**
   * PX-2c: claim the waiting spare for this call, or return null when there
   * is no spare, it belongs to another run, or any liveness or identity check
   * fails. Never throws: every failure falls back to a fresh launch, and a
   * dead spare's leftovers are removed best-effort. The take is synchronous,
   * so two concurrent calls can never claim one spare.
   */
  private async tryClaimSpareCall(input: WindowsJobLaunchRequest): Promise<WindowsJobProcessSnapshot | null> {
    const entry = this.spareEntries.get(input.runId);
    this.spareEntries.delete(input.runId);
    if (!entry) return null;
    const putBack = (): boolean => {
      if (this.spareEntries.has(entry.owner.runId)) return false;
      this.spareEntries.set(entry.owner.runId, entry);
      return true;
    };
    // PX-2c repair 2 (N2): once the claim below is acked, any later failure
    // must reach the caller as a launch failure — never a silent fallback
    // that runs the command a second time.
    let claimAcked = false;
    const { launcher, processId } = entry;
    const fail = (): null => {
      this.spareCounts.fallbacks += 1;
      void (async () => {
        try {
          await abortStartingSupervisor(launcher, entry.token, this.stopDeadlineMs);
        } catch {}
        this.removeSpareFiles(processId);
        this.records.delete(processId);
      })();
      return null;
    };
    try {
      if (launcher.exitCode !== null || launcher.signalCode !== null || launcher.killed || !launcher.connected) return fail();
      let record: HostRecord | null = null;
      try {
        record = this.readRecord(processId);
      } catch {
        record = null;
      }
      if (!record || record.spare !== true || record.spareClaimed === true) return fail();
      if (record.runId !== input.runId || record.sessionId !== input.sessionId) {
        // Another owner's spare: leave it for its owner; this call is no fallback of ours.
        if (!putBack()) void abortStartingSupervisor(launcher, entry.token, this.stopDeadlineMs).catch(() => undefined);
        return null;
      }
      if (input.interactive !== true) {
        // The spare always runs the interactive backend (the production path).
        putBack();
        return null;
      }
      const status = readSupervisorStatus(record.supervisor.statusPath);
      if (!status || status.processId !== processId || status.supervisorPid !== record.supervisor.supervisorPid
        || status.spare !== true || status.claimed === true || status.spareReady !== true || status.port <= 0
        || status.status !== "starting") return fail();
      // PX-2c repair 1 (M3/L3): mark the claim window durably BEFORE the IPC
      // claim lands, so a concurrent run-end sweep skips this pair instead of
      // killing a call mid-claim, and a crash here keeps an audit trail.
      // One synchronous attempt, never a wait: the spare is already taken from `spareEntries`, and a run-end sweep
      // reading the record from disk must see this mark at once. A record held open falls back to a fresh launch.
      const claiming: HostRecord = { ...record, spareClaimInFlight: true, updatedAt: this.clock(), ...(input.fence ? { currentFence: { ...input.fence } } : {}) };
      this.records.set(processId, claiming); this.persistOnce(claiming);
      const acknowledged = await this.sendSpareClaim(launcher, entry.token, input);
      if (!acknowledged) {
        // N7: a missing acknowledgement is no proof the claim never landed (the supervisor may have
        // taken it and lost only the reply). Fall back to a fresh launch only on proof; otherwise the
        // call fails like a post-ack failure and keeps its claim-window record, never running twice.
        if (await this.spareClaimProvablyUnlanded(launcher, entry.token, record.supervisor.statusPath)) return fail();
        claimAcked = true;
        throw new WindowsJobHostError("process_start_failed", "Windows Job spare claim acknowledgement was lost and the claim may have landed; the call is not run again.");
      }
      claimAcked = true;
      // The claim landed: adopt the reservation for this call. The spare mark
      // stays (spareClaimed) so a second claim of this pair is impossible.
      const now = this.clock();
      const claimed: HostRecord = {
        ...record, command: input.command, args: [...input.args], cwd: resolve(input.workingDirectory),
        environmentKeys: Object.keys(input.environment).sort(), updatedAt: now,
        ...(input.fence ? { currentFence: { ...input.fence } } : {}),
        spare: true, spareClaimed: true, spareClaimInFlight: false,
      };
      this.records.set(processId, claimed); await this.persist(claimed);
      if (launcher.connected) launcher.disconnect(); launcher.unref(); this.launchers.delete(launcher);
      try {
        const live = await waitForSupervisor(claimed.supervisor, processId, this.startDeadlineMs, () => childAlive(launcher), this.startSignal(input));
        await this.applyStatus(claimed, live);
        throwIfStartFailed(live);
      } catch (error) {
        // PX-2c repair 1 (M2) + N7: the claim was acked, so the Job host holds
        // the call and may still start its child after any status read (a
        // slow start). The launcher is already disconnected, so the start is
        // stopped through the supervisor's authenticated /signal under the
        // call's fence, which records the host's exit as the stop, exactly as
        // the normal path's abort does; only a supervisor that cannot be
        // reached is killed. The error carries the claimed record, so the
        // caller settles it on that proof (reconcile, verify-empty, release).
        await this.stopClaimedStart(claimed, launcher, entry.token).catch(() => undefined);
        await this.settleDiscardedStartOutput(claimed).catch(() => undefined);
        throw new WindowsJobStartFailedError(error instanceof WindowsJobHostError ? error.code : "process_start_failed",
          `Windows Job spare claim did not settle: ${error instanceof Error ? error.message : String(error)}`,
          { processId, startedAt: claimed.startedAt }, error);
      }
      this.spareCounts.claims += 1;
      return this.snapshot(claimed);
    } catch (error) {
      if (claimAcked) {
        // A claimed start that failed was already stopped through its supervisor (above).
        if (error instanceof WindowsJobStartFailedError) throw error;
        await abortStartingSupervisor(launcher, entry.token, this.stopDeadlineMs).catch(() => undefined);
        if (error instanceof WindowsJobHostError) throw error;
        throw new WindowsJobHostError("process_start_failed", `Windows Job spare claim did not settle: ${error instanceof Error ? error.message : String(error)}`);
      }
      return fail();
    }
  }

  /**
   * N7: after an unacknowledged claim, prove the claim never landed. The supervisor handles IPC
   * messages in order and durably records `claimed` before it hands the waiting Job host any call,
   * so once the supervisor is aborted and has exited, a last durable status with `claimed` unset and
   * no child is proof that nothing was launched. Anything else, including an exit that cannot be
   * confirmed or an unreadable status, is no proof.
   */
  private async spareClaimProvablyUnlanded(launcher: ChildProcess, token: string, statusPath: string): Promise<boolean> {
    // abortStartingSupervisor already SIGKILLs a supervisor that does not acknowledge the abort.
    await abortStartingSupervisor(launcher, token, this.stopDeadlineMs).catch(() => undefined);
    if (!(await waitForLauncherExit(launcher, this.stopDeadlineMs))) return false;
    // Strict, unlike readSupervisorStatus: a torn line could be the `claimed` one, so every line must
    // parse and none may show a claim or a child.
    let lines: SupervisorStatus[];
    try {
      lines = readFileSync(statusPath, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as SupervisorStatus);
    } catch { return false; }
    return lines.length > 0 && lines.every((line) => line.claimed !== true && line.childPid === 0);
  }

  /** Deliver the call over the private IPC channel and await the single-claim acknowledgement. False on any transport, timeout, or identity failure. */
  private sendSpareClaim(launcher: ChildProcess, token: string, input: WindowsJobLaunchRequest): Promise<boolean> {
    return new Promise((resolvePromise) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        launcher.off("message", onMessage);
        launcher.off("exit", onExit);
        resolvePromise(value);
      };
      const onMessage = (message: unknown): void => {
        if (message && typeof message === "object"
          && (message as { type?: unknown }).type === "claim_ack"
          && (message as { token?: unknown }).token === token)
          finish((message as { ok?: unknown }).ok === true);
      };
      const onExit = (): void => finish(false);
      const timer = setTimeout(() => finish(false), Math.max(1_000, Math.min(10_000, this.controlDeadlineMs)));
      launcher.on("message", onMessage);
      launcher.once("exit", onExit);
      if (!launcher.connected) {
        finish(false);
        return;
      }
      try {
        launcher.send({
          type: "claim", token,
          job: {
            command: input.command, args: [...input.args],
            cwd: resolve(input.workingDirectory), env: { ...input.environment },
          },
        }, (error) => {
          if (error) finish(false);
        });
      } catch {
        finish(false);
      }
    });
  }

  /**
   * After a successful claim (autoRefresh or keepWarm), or after a fresh interactive launch (keepWarm),
   * start one spare for this run. Fire-and-forget: the call never waits for it.
   */
  private refreshSpareInBackground(input: WindowsJobLaunchRequest): void {
    if (this.spareOptions.autoRefresh !== true && this.spareOptions.keepWarm !== true) return;
    if (this.spareOptions.keepWarm === true && this.keepWarmFailures >= KEEP_WARM_FAILURE_LIMIT) return;
    if (this.retiredSpareRuns.has(input.runId)) return;
    void this.prestartSpare({ runId: input.runId, sessionId: input.sessionId }).then(
      () => { this.keepWarmFailures = 0; },
      () => { this.keepWarmFailures += 1; },
    );
  }

  /** Best-effort removal of a spare's record file and process directory. Never throws. */
  private removeSpareFiles(processId: string): void {
    try {
      rmSync(this.containedProcessPath(processId, ".json"), { force: true });
    } catch {}
    try {
      rmSync(this.containedProcessPath(processId, ""), { recursive: true, force: true });
    } catch {}
  }

  /** Best-effort, bounded sweep of spare records left on disk (retired or crashed). Never launches; never throws. */
  private async sweepRetiredSpareRecords(closingRun?: { readonly runId: string }): Promise<void> {
    let names: string[] = [];
    try {
      names = this.nextRecordNames();
    } catch {
      return;
    }
    // The bounded window may miss a spare this host started; the closing run's own (or, with no run, every one this
    // host started) are always swept, whatever the window.
    const ownRuns = closingRun ? [closingRun.runId] : [...this.startedSpares.keys()];
    const own = ownRuns.flatMap((runId) => [...(this.startedSpares.get(runId) ?? [])].map((processId) => `${processId}.json`));
    names = [...new Set([...names, ...own])];
    for (const name of names) {
      try {
        const processId = name.slice(0, -".json".length);
        this.assertProcessId(processId);
        let text: string;
        try { text = readFileSync(join(this.stateDirectory, name), "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") this.forgetStartedSpare(processId); throw error; }
        const value = JSON.parse(text) as Partial<HostRecord>;
        // Retention: a released record whose deletion an earlier pass began (it carries the mark) and could not
        // finish, a supervisor still holding its folder say, is finished here once that supervisor is gone. The mark
        // is written only after the stop proof, and the pass re-checks identity, tombstone and stopped status.
        if (isHostRecord(value) && value.retentionRemovingAt !== undefined) {
          this.assertEmbeddedProcessId(processId, value);
          await this.finishMarkedRecord(value);
          continue;
        }
        if (!isHostRecord(value) || value.spare !== true || value.spareClaimed === true) continue;
        this.assertEmbeddedProcessId(processId, value);
        // PX-2c repair 1 (M3): a run end sweeps only its own spare records.
        if (closingRun && value.runId !== closingRun.runId) continue;
        // PX-2c repair 1 (M3): a pair inside its claim window is being adopted
        // by a concurrent call; the sweep must skip it, never kill it.
        if (value.spareClaimInFlight === true) continue;
        // PX-2c repair 1 (B1): kill only with an authenticated live-status
        // proof; otherwise only drop the record.
        await killVerifiedSpareSupervisor(value, readSupervisorStatus(value.supervisor.statusPath), SPARE_REAP_VERIFY_TIMEOUT_MS).catch(() => undefined);
        this.removeSpareFiles(processId);
        this.records.delete(processId);
        if (!existsSync(this.containedProcessPath(processId, ".json"))) this.forgetStartedSpare(processId);
      } catch {}
    }
  }

  /** Drops a spare id this host started once its record is gone. */
  private forgetStartedSpare(processId: string): void {
    for (const [runId, ids] of this.startedSpares) {
      if (!ids.delete(processId)) continue;
      if (ids.size === 0) this.startedSpares.delete(runId);
    }
  }

  /**
   * The record files the next maintenance scan reads: at most recordScanLimit `.json` names in name order, starting
   * after the last name the previous scan read and wrapping round, so successive scans cover the whole directory. A
   * directory within the limit is read whole every time. Listing names stays proportional to the directory; the limit
   * bounds the record files read and parsed.
   */
  private nextRecordNames(): string[] {
    const names = listRecordNames(this.stateDirectory);
    if (names.length <= this.recordScanLimit) {
      this.recordScanCursor = undefined;
      return names;
    }
    const cursor = this.recordScanCursor;
    const after = cursor === undefined ? -1 : names.findIndex((name) => name > cursor);
    const start = after < 0 ? 0 : after;
    const picked = [...names.slice(start), ...names.slice(0, start)].slice(0, this.recordScanLimit);
    this.recordScanCursor = picked.at(-1);
    return picked;
  }

  async retireReleasedRecords(closedRun: { readonly runId: string; readonly released: readonly WindowsJobReleasedRecord[] }): Promise<WindowsJobRecordRetention> {
    let deleted = 0; let kept = 0;
    try {
      // keepWarm's mark keeps a refresh racing the run's retirement from starting a spare for it. The run's close has
      // settled, so no launch of it is in flight to race; a later launch of the run clears the mark itself anyway.
      this.retiredSpareRuns.delete(closedRun.runId);
      const seen = new Set<string>();
      // First every named record is proven and marked, deleting those whose supervisor is already gone; then the ones
      // still held wait together under one deadline for the pass, never one ceiling each.
      let waiting: WindowsJobReleasedRecord[] = [];
      for (const entry of closedRun.released) {
        if (seen.has(entry.processId)) continue;
        seen.add(entry.processId);
        const outcome = await this.retireReleasedRecord(entry, closedRun.runId);
        if (outcome === "deleted") deleted += 1;
        else if (outcome === "kept") kept += 1;
        else if (outcome === "supervisor_alive") waiting.push(entry);
      }
      const deadline = Date.now() + this.retentionSupervisorExitMs;
      while (waiting.length > 0 && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, RETENTION_SUPERVISOR_POLL_MS));
        const still: WindowsJobReleasedRecord[] = [];
        for (const entry of waiting) {
          const outcome = await this.retireReleasedRecord(entry, closedRun.runId);
          if (outcome === "deleted") deleted += 1;
          else if (outcome === "kept") kept += 1;
          else if (outcome === "supervisor_alive") still.push(entry);
        }
        waiting = still;
      }
      // Still held at the deadline: marked, kept for a later sweep.
      kept += waiting.length;
    } catch {}
    return { deleted, kept };
  }

  /**
   * Deletes one released record and its folder, fail closed. Before anything is deleted, the record must be the run's
   * own with the identity its owner named, carry the release tombstone, and pass the checks a release replay makes:
   * the supervisor's durable status is this supervisor's, stopped with ownership released and settled output. The
   * fence lock is removed through the revoked-lock recovery, which re-checks under the lock. Then the record is marked,
   * durably, and the folder goes before the record, so a pass that stops part way leaves a marked record that the next
   * run-end sweep reaching it finishes. Every deleted path derives from the validated process id, never from a path the record holds.
   */
  private async retireReleasedRecord(named: WindowsJobReleasedRecord, runId: string): Promise<"deleted" | "absent" | "kept" | "supervisor_alive"> {
    const processId = named.processId;
    // One pass per record at a time: a second pass (a re-bound run closing while the first still runs) keeps it.
    if (this.retentionInFlight.has(processId)) return "kept";
    this.retentionInFlight.add(processId);
    try {
      const candidate = this.readRecord(processId);
      if (!candidate) {
        // A file that is there but is no valid record is kept, as anything unproven is.
        if (existsSync(this.containedProcessPath(processId, ".json"))) return "kept";
        this.records.delete(processId);
        return "absent";
      }
      const lockPath = this.containedProcessPath(processId, ".fence.lock");
      const proven = candidate.retentionRemovingAt !== undefined;
      await recoverRevokedOwnedFenceLock(lockPath, { assertRevoked: () => this.assertRetainedRecordRetirable(named, runId, candidate, !proven) });
      if (!proven) {
        const marked: HostRecord = { ...candidate, retentionRemovingAt: this.clock() };
        await this.persist(marked, { afterRename: () => { this.records.set(processId, marked); } });
      }
      // The supervisor holds the output logs until it exits. Still alive (or a reused PID): the record stays marked,
      // and the pass's shared wait or a later sweep finishes it. No process is ever signalled; the PID only gates
      // deletion, never a stop.
      if (!supervisorGone(candidate.supervisor.supervisorPid)) return "supervisor_alive";
      removeRetiredProcessFolder(this.containedProcessPath(processId, ""));
      rmSync(this.containedProcessPath(processId, ".json"), { force: true });
      this.records.delete(processId);
      return "deleted";
    } catch {
      return "kept";
    } finally {
      this.retentionInFlight.delete(processId);
    }
  }

  private assertRetainedRecordRetirable(named: WindowsJobReleasedRecord, runId: string, candidate: HostRecord, proveStop: boolean): void {
    const current = this.readRecord(named.processId);
    if (!current) throw new WindowsJobHostError("process_not_found", `Windows Job record ${named.processId} is gone.`);
    this.assertEmbeddedProcessId(named.processId, current);
    if (current.runId !== runId || current.sessionId !== named.sessionId || current.startedAt !== named.startedAt ||
        current.startedAt !== candidate.startedAt || current.supervisor.token !== candidate.supervisor.token ||
        current.supervisor.supervisorPid !== candidate.supervisor.supervisorPid ||
        resolve(current.supervisor.statusPath) !== resolve(candidate.supervisor.statusPath))
      throw new WindowsJobHostError("process_identity_mismatch", `Windows Job record ${named.processId} is not the one its owner released.`);
    if (current.spare === true && current.spareClaimed !== true)
      throw new WindowsJobHostError("process_control_unavailable", `Windows Job record ${named.processId} is an unclaimed spare.`);
    if (!current.backendOwnershipReleasedAt || current.status !== "stopped")
      throw new WindowsJobHostError("process_control_unavailable", `Windows Job record ${named.processId} is not released.`);
    if (!proveStop) {
      if (current.retentionRemovingAt === undefined) throw new WindowsJobHostError("process_control_unavailable", `Windows Job record ${named.processId} lost its retention mark.`);
      return;
    }
    const status = readSupervisorStatus(current.supervisor.statusPath);
    if (!status) throw new WindowsJobHostError("process_control_unavailable", `Windows Job record ${named.processId} has no durable supervisor status.`);
    this.assertStatusIdentity(current, status);
    if (status.status !== "stopped" || !status.ownershipReleased)
      throw new WindowsJobHostError("process_control_unavailable", `Windows Job record ${named.processId} stop is not proven.`);
    this.assertJobOutputSettled(current, status);
  }

  async signalOwned(processId: string, signal: "SIGTERM" | "SIGINT" | "SIGKILL", owner: WindowsJobOwnershipKey, fence?: WindowsJobWriterFence): Promise<WindowsJobProcessSnapshot> {
    const record = this.ownedRecord(processId, owner); this.assertActive(record); this.assertCurrentFence(record, fence);
    let stoppedRecord = record;
    let status = await this.authenticatedStatus(record, false);
    this.assertObservedStatusAuthority(record, status, fence);
    this.throwIfTerminalOutputPending(status);
    if (status.status !== "stopped") {
      try {
        status = await this.withFenceEffect(record, fence, "signal", async (current) => {
          const result = await supervisorRequest<SupervisorStatus>(current.supervisor, "/signal", "POST", { signal, deadlineMs: this.stopDeadlineMs, fence }, this.stopDeadlineMs + 250);
          this.assertStatusIdentity(current, result); await this.applyStatus(current, result); this.throwIfTerminalOutputPending(result); stoppedRecord = current; return result;
        });
      } catch (error) {
        const terminal = await this.withFenceEffect(record, fence, "reconcile", async current => await this.authenticatedStatus(current));
        this.throwIfTerminalOutputPending(terminal);
        throw error;
      }
    } else {
      // The precheck ran outside the writer fence. A terminal observation
      // cannot publish success for an owner replaced during that await.
      return await this.withFenceEffect(record, fence, "signal", async current => {
        const terminal = await this.authenticatedStatus(current);
        if (terminal.status !== "stopped") throw new WindowsJobHostError("process_control_unavailable", "Windows Job terminal observation changed before fenced confirmation.");
        return this.snapshot(current);
      });
    }
    if (status.status !== "stopped" && status.terminationRequested !== true)
      throw new WindowsJobHostError("process_stop_timeout", `Windows Job process ${processId} did not stop.`);
    return this.snapshot(stoppedRecord);
  }

  /**
   * T1: read-only CPU evidence. An outside-fence status read that never persists
   * or applies the status, so it cannot disturb a writer's fence, cursor or proof.
   */
  async usageOwned(processId: string, owner: WindowsJobOwnershipKey): Promise<{ readonly cpuTimeMs: number; readonly sampledAt: string } | undefined> {
    const record = this.ownedRecord(processId, owner);
    if (record.backendOwnershipReleasedAt) return undefined;
    const status = await this.authenticatedStatus(record, false);
    if (status.status !== "running" || !Number.isSafeInteger(status.cpuTimeMs) || (status.cpuTimeMs as number) < 0 ||
        typeof status.cpuSampledAt !== "string" || Number.isNaN(Date.parse(status.cpuSampledAt))) return undefined;
    return Object.freeze({ cpuTimeMs: status.cpuTimeMs as number, sampledAt: status.cpuSampledAt });
  }

  async reconcileOwned(processId: string, owner: WindowsJobOwnershipKey, fence?: WindowsJobWriterFence): Promise<WindowsJobProcessSnapshot & { readonly ownershipReleased: boolean }> {
    const record = this.ownedRecord(processId, owner); this.assertActive(record);
    return await this.withFenceEffect(record, fence, "reconcile", async (current) => {
      this.assertActive(current);
      const status = await this.authenticatedStatus(current);
      return { ...this.snapshot(current), ownershipReleased: status.ownershipReleased };
    });
  }

  async releaseOwned(processId: string, owner: WindowsJobOwnershipKey, expectedStartedAt: string, fence?: WindowsJobWriterFence): Promise<WindowsJobProcessSnapshot & { readonly ownershipReleased: boolean }> {
    const record = this.ownedRecord(processId, owner);
    this.assertCurrentFence(record, fence);
    if (record.startedAt !== expectedStartedAt) throw new WindowsJobHostError("process_identity_mismatch", `Windows Job process ${processId} identity mismatch.`);
    if (record.backendOwnershipReleasedAt) {
      await this.recoverReleasedFence(processId, record, owner, expectedStartedAt, fence);
      return { ...this.snapshot(this.ownedRecord(processId, owner)), ownershipReleased: true };
    }
    const status = await this.authenticatedStatus(record, false);
    this.assertObservedStatusAuthority(record, status, fence);
    this.throwIfTerminalOutputPending(status);
    if (status.status !== "stopped" || !status.ownershipReleased) {
      // PX-2b repair 1 (B4): a release refused while retained output is still
      // draining is output-unsettled whether or not the empty proof has
      // landed yet. The backend leaves the control lane usable for
      // process_output_unsettled_terminal (no release effect ran, so a later
      // release re-verifies every predicate), which is exactly what the
      // ACK-drain recovery needs; other refusals keep the lane closed. A
      // release attempted before the empty proof therefore no longer latches
      // the lane for good. Scoped to release only: signal and observe keep
      // their exact previous behavior.
      if (status.status === "exited_unknown" && !status.ownershipReleased &&
          (status.retainedOutputChunks > 0 || status.retainedOutputBytes > 0))
        throw new WindowsJobHostError("process_output_unsettled_terminal", "Windows Job terminal outcome is pending while retained output remains unsettled.");
      throw new WindowsJobHostError("process_control_unavailable", `Windows Job process ${processId} is not verified terminal.`);
    }
    // PX-2b: the second pre-lock terminal re-read is gone. It ran back-to-back
    // with the check above with no intervening host action, and the same
    // stopped+ownershipReleased predicate is still enforced authoritatively
    // inside the release fence effect below before the tombstone write.
    let releaseEffectPersisted = false;
    try {
      return await this.withFenceEffect(record, fence, "release", async (current) => {
        if (current.startedAt !== expectedStartedAt) throw new WindowsJobHostError("process_identity_mismatch", `Windows Job process ${processId} identity mismatch.`);
        const final = await this.authenticatedStatus(current);
        if (final.status !== "stopped" || !final.ownershipReleased)
          throw new WindowsJobHostError("process_control_unavailable", `Windows Job process ${processId} terminal ownership changed before release.`);
        this.assertJobOutputSettled(current, final);
        const releasedAt = this.clock();
        const candidate = { ...current, backendOwnershipReleasedAt: releasedAt, updatedAt: releasedAt };
        // Persisted once the rename lands: a failure of the flush after it is the release's own failure, never a
        // reason to finish the release from the record (the catch below does that only for a release not persisted).
        await this.persist(candidate, { afterRename: () => { this.records.set(processId, candidate); releaseEffectPersisted = true; } });
        return { ...this.snapshot(candidate), ownershipReleased: true };
      });
    } catch (error) {
      if (releaseEffectPersisted) throw error;
      const current = this.ownedRecord(processId, owner);
      if (!current.backendOwnershipReleasedAt) throw error;
      await this.recoverReleasedFence(processId, current, owner, expectedStartedAt, fence);
      return { ...this.snapshot(this.ownedRecord(processId, owner)), ownershipReleased: true };
    }
  }

  async readOwnedOutput(processId: string, owner: WindowsJobOwnershipKey, offsets: { readonly stdout: number; readonly stderr: number }, fence?: WindowsJobWriterFence, maximumBytes = this.maxPollBytes): Promise<WindowsJobOutputRead> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new WindowsJobHostError("process_control_unavailable", "Windows Job output read bound is invalid.");
    const limit = Math.min(maximumBytes, this.maxPollBytes);
    const record = this.ownedRecord(processId, owner); this.assertActive(record);
    return await this.withFenceEffect(record, fence, "read", async (current) => {
      this.assertActive(current);
      await this.authenticatedStatus(current);
      if (!current.interactive) {
        const stdout = unreadBytes(current.stdoutPath, offsets.stdout, limit);
        const stderr = unreadBytes(current.stderrPath, offsets.stderr, limit);
        return { stdout, stderr, next: { stdout: offsets.stdout + stdout.byteLength, stderr: offsets.stderr + stderr.byteLength } };
      }
      const consumed = current.outputOffsets ?? { stdout: 0, stderr: 0 };
      if (offsets.stdout !== consumed.stdout || offsets.stderr !== consumed.stderr)
        throw new WindowsJobHostError("process_control_unavailable", "Windows Job interactive output cursor is not its exact acknowledged position.");
      const frames = { ...current.outputFrames };
      const output: { stdout: Uint8Array; stderr: Uint8Array } = { stdout: new Uint8Array(), stderr: new Uint8Array() };
      let remaining = limit; let changed = false;
      // A read fixes its frame before bytes reach a consumer. Preserve every
      // unacknowledged frame across host restart and append-only pipe growth;
      // otherwise reattachment could silently change an accepted digest/length.
      for (const stream of ["stdout", "stderr"] as const) {
        const frame = frames[stream];
        if (!frame) continue;
        output[stream] = this.readRetainedOutputFrame(current, stream, frame);
        remaining -= output[stream].byteLength;
      }
      if (remaining < 0) throw new WindowsJobHostError("process_control_unavailable", "Windows Job retained replay exceeds its aggregate byte bound.");
      for (const stream of ["stdout", "stderr"] as const) {
        if (frames[stream] || remaining === 0) continue;
        const bytes = unreadBytes(stream === "stdout" ? current.stdoutPath : current.stderrPath, consumed[stream], remaining);
        if (bytes.byteLength === 0) continue;
        frames[stream] = { stream, sequence: (current.outputSequences?.[stream] ?? 0) + 1,
          startOffset: consumed[stream], endOffset: consumed[stream] + bytes.byteLength,
          byteLength: bytes.byteLength, digest: createHash("sha256").update(bytes).digest("hex") };
        output[stream] = bytes; remaining -= bytes.byteLength; changed = true;
      }
      if (changed) { current.outputFrames = frames; await this.persist(current); this.records.set(processId, current); }
      return { ...output, next: { stdout: offsets.stdout + output.stdout.byteLength, stderr: offsets.stderr + output.stderr.byteLength } };
    });
  }

  async waitOwnedStatusChange(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence, timeoutMs: number, sinceUpdatedAt?: string): Promise<void> {
    // PX-2b: read-only event wait, deliberately outside the fence lock (a
    // parked wait must never block retained-output acknowledgements, which
    // need the lock to drain). Preconditions match every other effect; the
    // caller re-polls and re-attests under the fence afterwards.
    // PX-2b repair 1 (N2): the wait carries the caller's last seen state as a
    // `since` cursor (defaulting to the durable file state at wait start), so
    // any change after it returns at once instead of parking to the timeout.
    const record = this.ownedRecord(processId, owner); this.assertActive(record); this.assertCurrentFence(record, fence);
    const since = sinceUpdatedAt ?? readSupervisorStatus(record.supervisor.statusPath)?.updatedAt;
    await waitForSupervisorStatusChange(record.supervisor, timeoutMs, since);
  }

  async probeActiveJobCreateClose(): Promise<boolean> {
    if (this.platform !== "win32" || process.platform !== "win32") return false;
    const jobHost = join(dirname(fileURLToPath(import.meta.url)), "managed-process-job-host.ps1");
    if (!existsSync(this.supervisorScriptPath) || !existsSync(jobHost)) return false;
    // Emit only the two fixed native signatures. Runtime C# compilation is
    // unrelated to Job availability and can consume the entire active probe
    // budget before either syscall. No workload is assigned to this Job.
    const command = [
      "$ErrorActionPreference='Stop'",
      "$assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('AIBoardActiveJobProbe'),[Reflection.Emit.AssemblyBuilderAccess]::Run)",
      "$module=$assembly.DefineDynamicModule('Native')",
      "$builder=$module.DefineType('AIBoardActiveJobProbe',[Reflection.TypeAttributes]::Public -bor [Reflection.TypeAttributes]::Abstract -bor [Reflection.TypeAttributes]::Sealed)",
      "$flags=[Reflection.MethodAttributes]::Public -bor [Reflection.MethodAttributes]::Static -bor [Reflection.MethodAttributes]::PinvokeImpl",
      "foreach($definition in @(@('CreateJobObjectW',[IntPtr],[Type[]]@([IntPtr],[string])),@('CloseHandle',[bool],[Type[]]@([IntPtr])))){",
      "$method=$builder.DefinePInvokeMethod([string]$definition[0],'kernel32.dll',$flags,[Reflection.CallingConventions]::Standard,[Type]$definition[1],[Type[]]$definition[2],[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)",
      "$method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)",
      "}",
      "$native=$builder.CreateType();$job=[IntPtr]::Zero",
      "try{$job=$native.GetMethod('CreateJobObjectW').Invoke($null,[object[]]@([IntPtr]::Zero,$null));if($job -eq [IntPtr]::Zero){exit 1}}",
      "finally{if($job -ne [IntPtr]::Zero){if(-not $native.GetMethod('CloseHandle').Invoke($null,[object[]]@($job))){exit 1}}}",
    ].join("\n");
    const executable = this.activeJobProbe?.executable ?? "powershell.exe";
    const args = this.activeJobProbe?.arguments ?? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
    const deadlineMs = this.activeJobProbe?.deadlineMs ?? DEFAULT_ACTIVE_JOB_PROBE_DEADLINE_MS;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) return false;
    const result = spawnSync(executable, [...args], {
      windowsHide: true,
      stdio: "ignore",
      timeout: deadlineMs,
      killSignal: "SIGKILL",
    });
    return result.status === 0 && !result.error;
  }

  async attachOwnedChannel(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence): Promise<WindowsJobChannelState> {
    const record = this.ownedRecord(processId, owner); this.assertActive(record);
    return await this.withFenceEffect(record, fence, "attach", async (current) => {
      this.assertActive(current);
      if (!current.interactive) throw new WindowsJobHostError("process_control_unavailable", "Windows Job process has no interactive input channel.");
      const status = await this.authenticatedStatus(current);
      return {
        nextSequence: current.nextInputSequence ?? 1,
        inputClosed: current.inputClosed === true,
        outputOffsets: { ...(current.outputOffsets ?? { stdout: 0, stderr: 0 }) },
        outputSequences: { ...(current.outputSequences ?? { stdout: 0, stderr: 0 }) },
        retainedOutput: (["stdout", "stderr"] as const).flatMap((stream) => {
          const frame = current.outputFrames?.[stream];
          if (!frame) return [];
          this.readRetainedOutputFrame(current, stream, frame);
          return [{ ...frame }];
        }),
        snapshot: { ...this.snapshot(current), ownershipReleased: status.ownershipReleased },
      };
    });
  }

  async claimAndAttachOwnedChannel(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence): Promise<WindowsJobChannelState> {
    if (!fence.ownerId || !Number.isSafeInteger(fence.fencingToken) || fence.fencingToken < 1) throw new WindowsJobHostError("process_identity_mismatch", "Windows Job writer fence is invalid.");
    const record = this.ownedRecord(processId, owner); this.assertActive(record);
    // PX-2b: the claimOwnedFence compare-and-set followed by the
    // attachOwnedChannel read inside ONE fence effect. Every predicate below
    // is byte-identical to the two separate methods, in the same order: the
    // stale-writer rejection runs before any attachment observation, so a
    // stale writer can never observe channel state.
    return await this.withFenceEffect(record, fence, "attach", async (current) => {
      this.assertActive(current);
      const fenced = current.currentFence;
      if (fenced && (fence.fencingToken < fenced.fencingToken || (fence.fencingToken === fenced.fencingToken && fence.ownerId !== fenced.ownerId))) throw new WindowsJobHostError("process_identity_mismatch", "Windows Job writer fence is stale.");
      if (!fenced || fence.fencingToken > fenced.fencingToken) { current.currentFence = { ...fence }; current.updatedAt = this.clock(); await this.persist(current); this.records.set(processId, current); }
      this.assertCurrentFence(current, fence);
      if (!current.interactive) throw new WindowsJobHostError("process_control_unavailable", "Windows Job process has no interactive input channel.");
      const status = await this.authenticatedStatus(current);
      return {
        nextSequence: current.nextInputSequence ?? 1,
        inputClosed: current.inputClosed === true,
        outputOffsets: { ...(current.outputOffsets ?? { stdout: 0, stderr: 0 }) },
        outputSequences: { ...(current.outputSequences ?? { stdout: 0, stderr: 0 }) },
        retainedOutput: (["stdout", "stderr"] as const).flatMap((stream) => {
          const frame = current.outputFrames?.[stream];
          if (!frame) return [];
          this.readRetainedOutputFrame(current, stream, frame);
          return [{ ...frame }];
        }),
        snapshot: { ...this.snapshot(current), ownershipReleased: status.ownershipReleased },
      };
    }, { allowFenceUpgrade: true });
  }

  async writeOwnedInput(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence, sequence: number, payload: Uint8Array, timeoutMs = this.controlDeadlineMs, signal?: AbortSignal): Promise<{ readonly acknowledged: true; readonly sequence: number }> {
    if (payload.byteLength > this.maxInputBytes) throw new WindowsJobHostError("process_control_unavailable", `Windows Job input exceeds the ${this.maxInputBytes}-byte limit.`);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new WindowsJobHostError("process_control_unavailable", "Windows Job input timeout is invalid.");
    const record = this.ownedRecord(processId, owner); this.assertActive(record);
    const elapsed = elapsedClock(INPUT_DRAIN_POLL_MS + this.controlDeadlineMs + 500);
    // Admission under the writer fence: the supervisor hands the bytes to the pipe exactly once and replies when the
    // write settles or after a short wait. The sequence is spent from here on, whatever the drain's outcome.
    const admitted = await this.withFenceEffect(record, fence, "write", async (current) => {
      this.assertActive(current);
      await this.authenticatedStatus(current);
      if (!current.interactive || current.inputClosed) throw new WindowsJobHostError("process_control_unavailable", "Windows Job input is unavailable.");
      if (sequence !== (current.nextInputSequence ?? 1)) throw new WindowsJobHostError("process_control_unavailable", "Windows Job input sequence is stale.");
      let result: { acknowledged: boolean; pending?: boolean; failed?: boolean; error?: string; sequence: number };
      try {
        result = await supervisorRequest<{ acknowledged: boolean; pending?: boolean; failed?: boolean; error?: string; sequence: number }>(current.supervisor, "/write", "POST",
          { sequence, payload: Buffer.from(payload).toString("base64"), fence, ackWaitMs: Math.min(INPUT_ADMISSION_ACK_WAIT_MS, timeoutMs) }, this.controlDeadlineMs + 250);
      } catch (error) {
        // Every 409 the supervisor sends for /write comes before it touches the pipe: a certain refusal.
        if (error instanceof SupervisorHttpError && error.statusCode === 409) throw new WindowsJobInputRefusedError(`Windows Job input was refused before admission: ${error.message}`);
        throw error;
      }
      if (result.sequence !== sequence || !(result.acknowledged === true || (result.acknowledged === false && (result.pending === true || result.failed === true))))
        throw new WindowsJobHostError("process_control_unavailable", "Windows Job input acknowledgement is invalid.");
      current.nextInputSequence = sequence + 1; current.updatedAt = this.clock(); await this.persist(current); this.records.set(processId, current); return result;
    });
    if (admitted.acknowledged === true) return { acknowledged: true, sequence };
    // Admitted, then failed within the admission wait: the sequence is spent, as for a drain that fails later.
    if (admitted.failed === true) throw new WindowsJobInputUnacknowledgedError(`Windows Job input failed: ${admitted.error ?? "unknown"}`);
    // The drain is waited for outside the fence, so a reader still starting never holds stop, output reads or
    // output acknowledgements; each poll re-reads the owned record first.
    await waitForAdmittedInput({ sequence, timeoutMs, elapsed, ...(signal ? { signal } : {}), observe: async (sliceMs) => {
      const current = this.ownedRecord(processId, owner); this.assertActive(current);
      return await supervisorRequest<{ sequence: number; state: string; error?: string }>(current.supervisor,
        `/input-status?sequence=${sequence}&timeoutMs=${sliceMs}`, "GET", undefined, sliceMs + this.controlDeadlineMs + 250, signal);
    } });
    return { acknowledged: true, sequence };
  }

  async closeOwnedInput(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence): Promise<void> {
    const record = this.ownedRecord(processId, owner); this.assertActive(record);
    await this.withFenceEffect(record, fence, "close", async (current) => {
      this.assertActive(current);
      await this.authenticatedStatus(current);
      if (current.inputClosed) return;
      await supervisorRequest<{ acknowledged: true }>(current.supervisor, "/close-input", "POST", { fence }, this.controlDeadlineMs + 250);
      current.inputClosed = true; current.updatedAt = this.clock(); await this.persist(current); this.records.set(processId, current);
    });
  }

  async acknowledgeOwnedOutput(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence, stream: "stdout" | "stderr", endOffset: number): Promise<void> {
    const record = this.ownedRecord(processId, owner); this.assertActive(record);
    await this.withFenceEffect(record, fence, "output_ack", async (current) => {
      this.assertActive(current);
      this.assertOutputFiles(current);
      const offsets = current.outputOffsets ?? { stdout: 0, stderr: 0 };
      if (!Number.isSafeInteger(endOffset) || endOffset < offsets[stream]) throw new WindowsJobHostError("process_control_unavailable", "Windows Job output acknowledgement is invalid.");
      const frame = current.outputFrames?.[stream];
      if (frame) {
        this.readRetainedOutputFrame(current, stream, frame);
        if (endOffset !== frame.endOffset) throw new WindowsJobHostError("process_control_unavailable", "Windows Job output acknowledgement must match the exact retained frame.");
      }
      const acknowledged = await supervisorRequest<{ acknowledged: true; stream: "stdout" | "stderr"; endOffset: number; status: SupervisorStatus }>(current.supervisor, "/ack-output", "POST", { stream, endOffset, fence }, this.controlDeadlineMs + 250);
      if (acknowledged.acknowledged !== true || acknowledged.stream !== stream || acknowledged.endOffset !== endOffset)
        throw new WindowsJobHostError("process_control_unavailable", "Windows Job supervisor output acknowledgement is invalid.");
      this.assertStatusIdentity(current, acknowledged.status);
      this.assertOutputEvidence(current, acknowledged.status);
      this.setStatusFields(current, acknowledged.status);
      current.outputOffsets = { ...offsets, [stream]: endOffset };
      const sequences = current.outputSequences ?? { stdout: 0, stderr: 0 };
      current.outputSequences = { ...sequences, [stream]: sequences[stream] + 1 };
      if (frame) { const frames = { ...current.outputFrames }; delete frames[stream]; current.outputFrames = frames; }
      if (acknowledged.status.status === "stopped") this.assertJobOutputSettled(current, acknowledged.status);
      current.updatedAt = this.clock(); await this.persist(current); this.records.set(processId, current);
    });
  }

  async claimOwnedFence(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence): Promise<void> {
    if (!fence.ownerId || !Number.isSafeInteger(fence.fencingToken) || fence.fencingToken < 1) throw new WindowsJobHostError("process_identity_mismatch", "Windows Job writer fence is invalid.");
    const lockPath = this.containedProcessPath(processId, ".fence.lock");
    try {
      await withOwnedFenceLock(lockPath, async () => {
        const record = this.ownedRecord(processId, owner);
        this.assertActive(record);
        const current = record.currentFence;
        if (current && (fence.fencingToken < current.fencingToken || (fence.fencingToken === current.fencingToken && fence.ownerId !== current.ownerId))) throw new WindowsJobHostError("process_identity_mismatch", "Windows Job writer fence is stale.");
        if (!current || fence.fencingToken > current.fencingToken) { record.currentFence = { ...fence }; record.updatedAt = this.clock(); await this.persist(record); this.records.set(processId, record); }
      }, { assertAuthority: () => this.assertActive(this.ownedRecord(processId, owner)) });
    } catch (error) {
      if (error instanceof WindowsJobHostError) throw error;
      throw new WindowsJobHostError("process_control_unavailable", `Windows Job writer fence lock is unavailable: ${String(error)}`);
    }
  }

  private assertObservedStatusAuthority(record: HostRecord, status: SupervisorStatus, fence: WindowsJobWriterFence | undefined): void {
    const current = this.ownedRecord(record.processId, record);
    this.assertActive(current);
    this.assertCurrentFence(current, fence);
    if (current.startedAt !== record.startedAt)
      throw new WindowsJobHostError("process_identity_mismatch", "Windows Job birth changed during status observation.");
    this.assertStatusIdentity(current, status);
  }

  private async authenticatedStatus(record: HostRecord, persistRecord = true): Promise<SupervisorStatus> {
    this.assertSupervisor(record.supervisor);
    let status = readSupervisorStatus(record.supervisor.statusPath);
    if (!status) throw new WindowsJobHostError("process_control_unavailable", `Process ${record.processId} has no durable supervisor status.`);
    this.assertStatusIdentity(record, status);
    if (!status.ownershipReleased && record.supervisor.port > 0) {
      try {
        status = await supervisorRequest<SupervisorStatus>(record.supervisor, "/status", "GET", undefined, this.controlDeadlineMs + 250);
      } catch (error) {
        const durable = readSupervisorStatus(record.supervisor.statusPath);
        if (!durable || durable.status !== "stopped" || !durable.ownershipReleased) throw error;
        this.assertStatusIdentity(record, durable);
        status = durable;
      }
      this.assertStatusIdentity(record, status);
    }
    this.assertOutputEvidence(record, status);
    // Outside-fence prechecks may span another writer's claim or output ACK.
    // Their old record must never overwrite its fence, cursor or tombstone.
    // Only the fenced caller can validate exact current ACK offsets and
    // publish status; an outside observation alone cannot certify release.
    if (persistRecord) {
      if (status.status === "stopped") this.assertJobOutputSettled(record, status);
      await this.applyStatus(record, status);
    }
    return status;
  }

  private ownedRecord(processId: string, owner: WindowsJobOwnershipKey): HostRecord {
    this.assertProcessId(processId);
    const disk = this.readRecord(processId); if (disk) this.records.set(processId, disk);
    const record = this.records.get(processId);
    if (!record) throw new WindowsJobHostError("process_not_found", `Process ${processId} was not found.`);
    this.assertEmbeddedProcessId(processId, record);
    if (record.runId !== owner.runId || record.sessionId !== owner.sessionId)
      throw new WindowsJobHostError("process_not_owned", `Process ${processId} belongs to another session.`);
    return record;
  }
  private readRecord(processId: string): HostRecord | null {
    const path = this.containedProcessPath(processId, ".json");
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as Partial<HostRecord>;
      if (!isHostRecord(value)) return null;
      this.assertEmbeddedProcessId(processId, value);
      return value;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  /**
   * `durable` is for the release record: since FL2 the lock file holds nothing, so `backendOwnershipReleasedAt` is the
   * only record that ownership was released. Its data is flushed before the rename and the renamed file after it
   * (Node cannot open a directory on Windows, so that is as far as it reaches). `afterRename` runs once the record is
   * in place, before that last flush.
   *
   * The rename waits while another process holds the record open (the supervisor reads it to check a request's
   * fence), on timers that leave the event loop free (windows-file-replace.ts); a record that cannot be replaced
   * leaves no temporary file behind.
   */
  private async persist(record: HostRecord, durable?: { readonly afterRename: () => void }): Promise<void> {
    const destination = this.containedProcessPath(record.processId, ".json"); const temporary = `${destination}.${randomUUID()}.tmp`;
    if (!durable) writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
    else {
      const content = Buffer.from(JSON.stringify(record, null, 2));
      const written = openSync(temporary, "wx", 0o600);
      try {
        for (let offset = 0; offset < content.length;) offset += writeSync(written, content, offset);
        fsyncSync(written);
      } finally { closeSync(written); }
    }
    try { await replaceFileWhenFree(temporary, destination); }
    catch (error) {
      try { rmSync(temporary, { force: true }); } catch {}
      throw error;
    }
    if (!durable) return;
    durable.afterRename();
    this.flushRecord(record.processId);
  }
  /**
   * One synchronous attempt, for a write that must land at once or not at all: the constructor's best-effort mark on
   * a reaped spare (its caller ignores a failure), and a spare's claim-window mark (a failure falls back to a fresh
   * launch).
   */
  private persistOnce(record: HostRecord): void {
    const destination = this.containedProcessPath(record.processId, ".json"); const temporary = `${destination}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
    try { renameSync(temporary, destination); }
    catch (error) {
      try { rmSync(temporary, { force: true }); } catch {}
      throw error;
    }
  }
  /** Flushes a record file in place: the renamed release record, and again before a release is finished from it. */
  private flushRecord(processId: string): void {
    const renamed = openSync(this.containedProcessPath(processId, ".json"), "r+");
    try { fsyncSync(renamed); } finally { closeSync(renamed); }
  }
  /** Takes a supervisor status into the record and persists it. */
  /**
   * A claimed spare's failed start: SIGKILL through the supervisor's authenticated /signal (the call's fence), then a
   * bounded wait for its durable terminal status. The supervisor records the host's exit as the stop and exits; one
   * that cannot be reached is killed (no stop is then recorded, and the record stays unproven).
   */
  /** The call's cancellation and the test seam's, together. */
  private startSignal(input: WindowsJobLaunchRequest): AbortSignal | undefined {
    const signals = [input.signal, this.startWaitSignal].filter((signal): signal is AbortSignal => signal !== undefined);
    return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  }
  private async stopClaimedStart(record: HostRecord, launcher: ChildProcess, token: string): Promise<void> {
    try {
      await supervisorRequest<SupervisorStatus>(record.supervisor, "/signal", "POST",
        { signal: "SIGKILL", deadlineMs: this.stopDeadlineMs, fence: record.currentFence }, this.stopDeadlineMs + 250);
    } catch {
      await abortStartingSupervisor(launcher, token, this.stopDeadlineMs);
      return;
    }
    const deadline = Date.now() + this.stopDeadlineMs + ABORT_ACK_MARGIN_MS;
    for (;;) {
      const current = readSupervisorStatusQuiet(record.supervisor.statusPath);
      if (current?.status === "stopped" || !childAlive(launcher) || Date.now() >= deadline) break;
      await waitForFileActivity(dirname(record.supervisor.statusPath), basename(record.supervisor.statusPath), Math.min(STARTUP_WATCH_TICK_MS, Math.max(1, deadline - Date.now())));
    }
    if (childAlive(launcher)) await abortStartingSupervisor(launcher, token, this.stopDeadlineMs);
  }
  /**
   * A failed start whose supervisor dropped output nobody will read (outputDiscarded, after the Job was proven empty)
   * settles the record's own output offsets at the logs' lengths, durably, so the stop can be verified and released.
   * Anything short of that proof changes nothing.
   */
  private async settleDiscardedStartOutput(record: HostRecord): Promise<void> {
    const status = readSupervisorStatusQuiet(record.supervisor.statusPath);
    if (!status || status.processId !== record.processId || status.status !== "stopped" || status.outputDiscarded !== true ||
        status.jobEmptyProof !== true || status.retainedOutputChunks !== 0 || status.retainedOutputBytes !== 0 || !record.interactive) return;
    const sizes = { stdout: statSync(record.stdoutPath).size, stderr: statSync(record.stderrPath).size };
    record.outputOffsets = sizes;
    await this.persist(record);
  }
  private async applyStatus(record: HostRecord, status: SupervisorStatus): Promise<void> {
    this.setStatusFields(record, status);
    await this.persist(record);
  }
  /** Takes a supervisor status into the record without persisting it; the caller persists the record afterwards. */
  private setStatusFields(record: HostRecord, status: SupervisorStatus): void {
    this.assertStatusIdentity(record, status); record.pid = status.childPid; record.supervisor.port = status.port;
    record.status = status.status === "stopped" ? "stopped" : status.status === "exited_unknown" ? "exited_unknown" : "running";
    record.exitCode = status.exitCode; record.signal = status.signal; record.updatedAt = status.updatedAt;
  }
  private assertSupervisor(value: SupervisorRecord): void {
    if (value.protocol !== PROTOCOL || value.token.length < 32 || value.supervisorPid < 1 || value.port < 0 || value.port > 65_535)
      throw new WindowsJobHostError("process_control_unavailable", "Authenticated Windows Job supervisor identity is invalid.");
  }
  private assertStatusIdentity(record: HostRecord, status: SupervisorStatus): void {
    if (status.protocol !== PROTOCOL || status.processId !== record.processId || status.supervisorPid !== record.supervisor.supervisorPid || (record.supervisor.port !== 0 && status.port !== record.supervisor.port))
      throw new WindowsJobHostError("process_control_unavailable", `Supervisor identity mismatch for ${record.processId}.`);
    if (status.jobEmptyProof !== undefined && typeof status.jobEmptyProof !== "boolean" ||
        status.terminationRequested !== undefined && typeof status.terminationRequested !== "boolean")
      throw new WindowsJobHostError("process_control_unavailable", `Supervisor control status is invalid for ${record.processId}.`);
  }
  private assertOutputEvidence(record: HostRecord, status: SupervisorStatus): void {
    if (!Number.isSafeInteger(status.retainedOutputChunks) || status.retainedOutputChunks < 0 ||
        !Number.isSafeInteger(status.retainedOutputBytes) || status.retainedOutputBytes < 0)
      throw new WindowsJobHostError("process_control_unavailable", "Windows Job retained-output status is missing or invalid.");
    this.assertOutputFiles(record);
  }
  private readRetainedOutputFrame(record: HostRecord, stream: "stdout" | "stderr", frame: BackpressuredOutputMetadata): Uint8Array {
    const offset = record.outputOffsets?.[stream] ?? 0;
    const sequence = (record.outputSequences?.[stream] ?? 0) + 1;
    if (!frame || frame.stream !== stream || frame.sequence !== sequence || frame.startOffset !== offset ||
        !Number.isSafeInteger(frame.byteLength) || frame.byteLength < 1 || frame.byteLength > this.maxPollBytes ||
        !Number.isSafeInteger(frame.endOffset) || frame.endOffset !== offset + frame.byteLength || !/^[a-f0-9]{64}$/.test(frame.digest))
      throw new WindowsJobHostError("process_control_unavailable", "Windows Job retained output identity is invalid.");
    const bytes = unreadBytes(stream === "stdout" ? record.stdoutPath : record.stderrPath, offset, frame.byteLength);
    if (bytes.byteLength !== frame.byteLength || createHash("sha256").update(bytes).digest("hex") !== frame.digest)
      throw new WindowsJobHostError("process_control_unavailable", "Windows Job retained output bytes or digest changed.");
    return bytes;
  }
  private assertOutputFiles(record: HostRecord): void {
    for (const path of [record.stdoutPath, record.stderrPath]) {
      let descriptor: number | undefined;
      try { descriptor = openSync(path, "r"); fstatSync(descriptor); }
      catch (error) { throw new WindowsJobHostError("process_control_unavailable", `Windows Job output evidence is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`); }
      finally { if (descriptor !== undefined) closeSync(descriptor); }
    }
  }
  private assertJobOutputSettled(record: HostRecord, status: SupervisorStatus): void {
    this.assertOutputEvidence(record, status);
    if (status.retainedOutputChunks !== 0 || status.retainedOutputBytes !== 0)
      throw new WindowsJobHostError("process_control_unavailable", "Windows Job retained output is unsettled.");
    if (!record.interactive) return;
    const offsets = record.outputOffsets ?? { stdout: 0, stderr: 0 };
    for (const [stream, path] of [["stdout", record.stdoutPath], ["stderr", record.stderrPath]] as const) {
      const descriptor = openSync(path, "r");
      try {
        if (fstatSync(descriptor).size !== offsets[stream])
          throw new WindowsJobHostError("process_control_unavailable", "Windows Job accepted output acknowledgement is not durably recorded.");
      } finally { closeSync(descriptor); }
    }
  }
  private throwIfTerminalOutputPending(status: SupervisorStatus): void {
    if (status.status === "exited_unknown" && status.jobEmptyProof === true && !status.ownershipReleased &&
        status.retainedOutputChunks > 0 && status.retainedOutputBytes > 0)
      throw new WindowsJobHostError("process_output_unsettled_terminal", "Windows Job is exactly empty while retained output remains unsettled.");
  }
  private assertActive(record: HostRecord): void {
    if (record.backendOwnershipReleasedAt) throw new WindowsJobHostError("process_backend_ownership_released", `Windows Job process ${record.processId} ownership was released.`);
  }
  private assertCurrentFence(record: HostRecord, fence: WindowsJobWriterFence | undefined): void {
    if (!record.currentFence && !fence) return;
    if (!fence || !record.currentFence) throw new WindowsJobHostError("process_identity_mismatch", "Windows Job writer fence is unavailable.");
    if (fence.ownerId !== record.currentFence.ownerId || fence.fencingToken !== record.currentFence.fencingToken)
      throw new WindowsJobHostError("process_identity_mismatch", "Windows Job writer fence is stale.");
  }
  private async withFenceEffect<T>(record: HostRecord, fence: WindowsJobWriterFence | undefined, kind: "attach" | "read" | "write" | "close" | "signal" | "output_ack" | "reconcile" | "release", effect: (current: HostRecord) => Promise<T>, options: { allowFenceUpgrade?: boolean } = {}): Promise<T> {
    await this.beforeFenceEffect?.(kind);
    const previous = this.effectTails.get(record.processId) ?? Promise.resolve();
    let finishTurn!: () => void;
    const turn = new Promise<void>((resolvePromise) => { finishTurn = resolvePromise; });
    const tail = previous.then(() => turn);
    this.effectTails.set(record.processId, tail);
    await previous;
    const lockPath = this.containedProcessPath(record.processId, ".fence.lock");
    try {
      return await withOwnedFenceLock(lockPath, async () => {
        const current = this.ownedRecord(record.processId, record);
        this.assertActive(current);
        // PX-2b: only the fused claim+attach sets allowFenceUpgrade. It runs
        // the claim compare-and-set followed by the equality check inside
        // its own body; every other effect keeps the precondition here.
        if (options.allowFenceUpgrade !== true) this.assertCurrentFence(current, fence);
        return await effect(current);
      }, {
        retireAfterEffect: kind === "release",
        assertAuthority: () => {
          const current = this.ownedRecord(record.processId, record);
          this.assertActive(current);
        },
      });
    } catch (error) {
      if (error instanceof WindowsJobHostError) throw error;
      // The lock, or the effect's own work (a record write that ran out of time, say): the cause names which.
      throw new WindowsJobHostError("process_control_unavailable", `Windows Job writer fence effect failed: ${String(error)}`);
    } finally {
      finishTurn();
      if (this.effectTails.get(record.processId) === tail) this.effectTails.delete(record.processId);
    }
  }
  private async recoverReleasedFence(requestedProcessId: string, record: HostRecord, owner: WindowsJobOwnershipKey, expectedStartedAt: string, fence: WindowsJobWriterFence | undefined): Promise<void> {
    this.assertEmbeddedProcessId(requestedProcessId, record);
    // The release record may be one whose flush after its rename failed: flush it before the release is finished.
    try { this.flushRecord(requestedProcessId); }
    catch (error) { throw new WindowsJobHostError("process_control_unavailable", `Windows Job release record cannot be flushed: ${String(error)}`); }
    const lockPath = this.containedProcessPath(requestedProcessId, ".fence.lock");
    const assertRevoked = (): void => {
      const current = this.ownedRecord(requestedProcessId, owner);
      this.assertEmbeddedProcessId(requestedProcessId, current);
      if (!current.backendOwnershipReleasedAt || record.processId !== requestedProcessId || current.pid !== record.pid ||
          current.startedAt !== expectedStartedAt || current.runId !== owner.runId || current.sessionId !== owner.sessionId ||
          current.supervisor.protocol !== record.supervisor.protocol || current.supervisor.supervisorPid !== record.supervisor.supervisorPid ||
          current.supervisor.token !== record.supervisor.token || resolve(current.supervisor.statusPath) !== resolve(record.supervisor.statusPath))
        throw new WindowsJobHostError("process_identity_mismatch", `Windows Job process ${record.processId} released identity mismatch.`);
      this.assertCurrentFence(current, fence);
      const status = readSupervisorStatus(current.supervisor.statusPath);
      if (!status) throw new WindowsJobHostError("process_control_unavailable", `Windows Job process ${record.processId} released status is unavailable.`);
      this.assertStatusIdentity(current, status);
      if (current.status !== "stopped" || status.status !== "stopped" || !status.ownershipReleased)
        throw new WindowsJobHostError("process_control_unavailable", `Windows Job process ${record.processId} released tombstone is not terminal.`);
      this.assertJobOutputSettled(current, status);
    };
    try { await recoverRevokedOwnedFenceLock(lockPath, { assertRevoked }); }
    catch (error) {
      if (error instanceof WindowsJobHostError) throw error;
      throw new WindowsJobHostError("process_control_unavailable", `Windows Job released writer fence cleanup is unavailable: ${String(error)}`);
    }
  }
  private validatedProcessId(processId: string): string {
    this.assertProcessId(processId);
    return processId;
  }
  private assertProcessId(processId: string): void {
    if (typeof processId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(processId) || processId === "." || processId === "..")
      throw new WindowsJobHostError("process_identity_mismatch", "Windows Job process identity is invalid or path-escaping.");
  }
  private assertEmbeddedProcessId(requestedProcessId: string, record: Pick<HostRecord, "processId">): void {
    this.assertProcessId(requestedProcessId);
    if (record.processId !== requestedProcessId)
      throw new WindowsJobHostError("process_identity_mismatch", `Windows Job record identity mismatch for ${requestedProcessId}.`);
  }
  private containedProcessPath(processId: string, suffix: string): string {
    this.assertProcessId(processId);
    const candidate = resolve(this.stateDirectory, `${processId}${suffix}`);
    if (dirname(candidate) !== this.stateDirectory)
      throw new WindowsJobHostError("process_identity_mismatch", "Windows Job process path escapes host state.");
    return candidate;
  }
  private snapshot(record: HostRecord): WindowsJobProcessSnapshot {
    return { processId: record.processId, pid: record.pid, status: record.status, exitCode: record.exitCode, signal: record.signal, startedAt: record.startedAt, updatedAt: record.updatedAt, stdout: tail(record.stdoutPath, this.maxPollBytes), stderr: tail(record.stderrPath, this.maxPollBytes) };
  }
}

export function createWindowsJobProcessHost(options: WindowsJobProcessHostOptions): WindowsJobProcessHost {
  return new AuthenticatedWindowsJobProcessHost(options);
}

function isHostRecord(value: Partial<HostRecord>): value is HostRecord {
  return typeof value.processId === "string" && typeof value.runId === "string" && typeof value.sessionId === "string" && typeof value.startedAt === "string" && typeof value.stdoutPath === "string" && typeof value.stderrPath === "string" && Boolean(value.supervisor);
}
function readSupervisorStatus(path: string): SupervisorStatus | null {
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) { const line = lines[index]?.trim(); if (!line) continue; try { return JSON.parse(line) as SupervisorStatus; } catch {} }
    return null;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
/**
 * A start status that did not start its workload fails the launch: still starting, stopped with an error, or a
 * terminal status (stopped or exited_unknown) without the workload's pid, which a host that ended before its started
 * line leaves.
 */
function throwIfStartFailed(status: SupervisorStatus): void {
  if (status.status === "starting") throw new WindowsJobHostError("process_start_failed", "Windows Job supervisor did not confirm startup.");
  const terminal = status.status === "stopped" || status.status === "exited_unknown";
  if ((status.status === "stopped" && status.error) || (terminal && !status.childPid))
    throw new WindowsJobHostError("process_start_failed", status.error ?? "The Windows Job host ended before it reported that its workload started.");
}
/** A launcher (supervisor) child process that has neither exited nor been killed. */
function childAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * PX-2b: event-driven supervisor-startup wait. The status file is re-read on
 * every directory event instead of every 25 ms; the start deadline stays
 * armed as the backstop; a watcher failure resolves via the bounded timer
 * (still bounded by the same deadline). Exported for tests.
 */
/**
 * PX-2c: prestart wait for a spare reservation. Resolves when the supervisor
 * has bound its port, spawned the Job host, and persisted spareReady (the Job
 * host is then either waiting on its stdin or will drain the claim from the
 * pipe buffer: either way the claim never blocks on boot). Fails fast when
 * the supervisor already died; throws at the same start deadline otherwise.
 * Exported for tests.
 *
 * `alive`: whether the supervisor process still runs. Once it does not, the status it last wrote is read once more and
 * the wait ends: a start never waits out the ceiling for a supervisor that is already gone.
 */
export async function waitForSpareReadyStatus(supervisor: SupervisorRecord, processId: string, deadlineMs: number, alive?: () => boolean): Promise<SupervisorStatus> {
  const deadline = Date.now() + deadlineMs;
  let lastLook = false;
  for (;;) {
    let wake!: () => void;
    const woke = new Promise<void>((resolve) => { wake = resolve; });
    const watcher = armFileWatch(dirname(supervisor.statusPath), basename(supervisor.statusPath), wake);
    try {
      const status = readSupervisorStatus(supervisor.statusPath);
      if (status && status.protocol === PROTOCOL && status.processId === processId && status.supervisorPid === supervisor.supervisorPid) {
        if (status.spare === true && status.spareReady === true && status.claimed !== true && status.port > 0 && status.status === "starting") {
          supervisor.port = status.port;
          return status;
        }
        if ((status.status === "stopped" || status.status === "exited_unknown") && status.spareReady !== true)
          throw new WindowsJobHostError("process_start_failed", `Windows Job spare supervisor failed before becoming ready: ${status.error ?? status.status}.`);
      }
      if (lastLook) break;
      if (alive && !alive()) { lastLook = true; continue; }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await Promise.race([woke, new Promise((resolve) => setTimeout(resolve, Math.min(remaining, STARTUP_WATCH_TICK_MS)))]);
    } finally {
      try { watcher?.close(); } catch {}
    }
  }
  throw new WindowsJobHostError("process_start_failed", lastLook ? "Windows Job spare supervisor exited before it reported startup." : "Windows Job spare supervisor did not become ready before the deadline.");
}

/**
 * PX-2b repair 1 (B1): short park bound for the startup waits. A lost watch
 * event can stall one iteration at most; the loop re-reads and the outer
 * deadline still decides.
 */
const STARTUP_WATCH_TICK_MS = 250;

/**
 * PX-2b repair 1 (B1): arm the directory watch BEFORE the status read, so a
 * line that lands between the read and the registration still wakes this
 * iteration. Undefined when watch() itself fails: the caller then parks only
 * the short tick and re-reads. An error event wakes at once so the loop
 * re-arms with no delay.
 */
function armFileWatch(directory: string, filename: string, wake: () => void): { close(): void } | undefined {
  try {
    const watcher = watch(directory);
    watcher.once("error", wake);
    watcher.on("change", (_event, name) => { if (name === filename) wake(); });
    return watcher;
  } catch {
    return undefined;
  }
}

export async function waitForSupervisor(supervisor: SupervisorRecord, processId: string, deadlineMs: number, alive?: () => boolean, signal?: AbortSignal): Promise<SupervisorStatus> {
  const deadline = Date.now() + deadlineMs;
  let lastLook = false;
  for (;;) {
    if (signal?.aborted) throw new WindowsJobHostError("process_start_cancelled", "The launch was cancelled before its workload started.");
    let wake!: () => void;
    const woke = new Promise<void>((resolve) => { wake = resolve; });
    const watcher = armFileWatch(dirname(supervisor.statusPath), basename(supervisor.statusPath), wake);
    signal?.addEventListener("abort", wake, { once: true });
    try {
      const status = readSupervisorStatus(supervisor.statusPath);
      if (status && status.protocol === PROTOCOL && status.processId === processId && status.supervisorPid === supervisor.supervisorPid && status.port > 0) {
        supervisor.port = status.port;
        if (status.status === "stopped" || status.status === "exited_unknown") return status;
        if (status.status === "running") {
          try {
            return await supervisorRequest(supervisor, "/status", "GET", undefined, Math.max(250, deadline - Date.now()));
          } catch (error) {
            // A short workload can finish between this read and the request landing: the supervisor
            // persists its terminal status, then closes its server and resets the queued connection
            // (T8 slow-machine reproduction: `read ECONNRESET`). The same terminal predicate as above
            // accepts that durable status; anything else still fails closed with the request error.
            const durable = readSupervisorStatus(supervisor.statusPath);
            if (durable && durable.protocol === PROTOCOL && durable.processId === processId && durable.supervisorPid === supervisor.supervisorPid && durable.port > 0 &&
                (durable.status === "stopped" || durable.status === "exited_unknown")) return durable;
            throw error;
          }
        }
      }
      if (lastLook) break;
      if (alive && !alive()) { lastLook = true; continue; }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await Promise.race([woke, new Promise((resolve) => setTimeout(resolve, Math.min(remaining, STARTUP_WATCH_TICK_MS)))]);
    } finally {
      signal?.removeEventListener("abort", wake);
      try { watcher?.close(); } catch {}
    }
  }
  throw new WindowsJobHostError("process_start_failed", lastLook ? "Windows Job supervisor exited before it reported startup." : "Windows Job supervisor did not become ready before the deadline.");
}

/**
 * PX-2b: resolve on the next change notification for one file in its
 * directory, or after timeoutMs. Never rejects: the caller re-reads and the
 * outer deadline decides. Exported for tests.
 */
export function waitForFileActivity(directory: string, filename: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let watcher: ReturnType<typeof watch> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { watcher?.close(); } catch {}
      resolve();
    };
    let timer = setTimeout(finish, Math.max(1, timeoutMs));
    try {
      watcher = watch(directory);
    } catch {
      // PX-2b repair 1 (B1): an unwatchable directory falls back to the short
      // tick, never to sleeping the whole remaining deadline. The caller
      // re-reads and its own deadline still decides.
      clearTimeout(timer);
      timer = setTimeout(finish, Math.min(Math.max(1, timeoutMs), STARTUP_WATCH_TICK_MS));
      return;
    }
    watcher.once("error", () => finish());
    watcher.on("change", (_event, name) => { if (name === filename) finish(); });
  });
}

/**
 * PX-2b: event-driven settlement wait over the existing authenticated
 * supervisor channel. The supervisor answers immediately when already
 * stopped (no lost wakeup: stopped is final) or when the `since` cursor is
 * stale, and otherwise parks the request until its next durable persist or
 * the bounded timeout. Throws on transport/auth failure so the caller falls
 * back to a timed delay; every existing deadline stays armed. Exported for
 * tests.
 */
export async function waitForSupervisorStatusChange(supervisor: SupervisorRecord, timeoutMs: number, sinceUpdatedAt?: string): Promise<SupervisorStatus> {
  const bounded = Number.isSafeInteger(timeoutMs) ? Math.min(5_000, Math.max(1, timeoutMs)) : 1_000;
  const query = typeof sinceUpdatedAt === "string" && sinceUpdatedAt.length > 0
    ? `/wait-status?timeoutMs=${bounded}&since=${encodeURIComponent(sinceUpdatedAt)}`
    : `/wait-status?timeoutMs=${bounded}`;
  return await supervisorRequest<SupervisorStatus>(supervisor, query, "GET", undefined, bounded + 250);
}

async function supervisorRequest<T = SupervisorStatus>(supervisor: SupervisorRecord, path: string, method: "GET" | "POST", body?: Record<string, unknown>, timeoutMs = SUPERVISOR_REQUEST_TIMEOUT_MS + 250, signal?: AbortSignal): Promise<T> {
  const payload = body ? Buffer.from(JSON.stringify(body)) : undefined;
  return await new Promise<T>((resolvePromise, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    // PX-2a (F7): never keep the supervisor connection alive. The default HTTP
    // agent holds the idle socket, and the supervisor's server.close waits for
    // it, lingering ~4 s after the result. A non-pooled agent plus
    // `Connection: close` lets the supervisor exit with the result.
    const call = request({ hostname: "127.0.0.1", port: supervisor.port, path, method, agent: false, headers: { authorization: `Bearer ${supervisor.token}`, connection: "close", ...(payload ? { "content-type": "application/json", "content-length": String(payload.byteLength) } : {}) } }, (response) => {
      const chunks: Buffer[] = []; response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("error", fail);
      response.once("aborted", () => fail(new Error("Supervisor response was aborted.")));
      response.once("end", () => {
        if (settled) return;
        const text = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode !== 200) { fail(new SupervisorHttpError(response.statusCode, `Supervisor returned HTTP ${String(response.statusCode)}: ${text}`)); return; }
        try { const parsed = JSON.parse(text) as T; settled = true; resolvePromise(parsed); } catch (error) { fail(error); }
      });
    });
    const cancelDeadline = runnerTimeDeadline(timeoutMs, () => { if (!settled) call.destroy(new Error("Supervisor request timed out.")); });
    call.once("close", cancelDeadline);
    // Only observation requests take a signal; a fenced effect's request is never cancelled mid-flight.
    if (signal) {
      const abort = () => { if (!settled) call.destroy(new Error("Supervisor request was abandoned: the session is stopping.")); };
      if (signal.aborted) abort(); else { signal.addEventListener("abort", abort, { once: true }); call.once("close", () => signal.removeEventListener("abort", abort)); }
    }
    call.once("error", fail);
    if (payload) call.write(payload);
    call.end();
  });
}
/**
 * Staging 2026-11-03: a supervisor deadline measures supervisor silence, so it
 * counts only time this Runner was running. After a main-thread pause (0% CPU,
 * 10 s and 134 s on a Windows Remote Runner) timers run before pending I/O: a
 * plain socket timeout then fired although the reply had already arrived, and
 * every live session's in-flight /status probe failed together; the channel
 * surfaced that as terminal and each LIVE sibling was cleaned up. Each tick
 * credits at most two ticks, so a pause counts as a bounded slice; the final
 * expiry waits one I/O turn so an already-received reply settles first.
 */
const SUPERVISOR_DEADLINE_TICK_MS = 100;
/**
 * Stdin admission waits this long for the write to settle before replying `pending`. A write the pipe has room for
 * settles at once (a whole managed write, with every round trip, measured 31-260 ms on a Windows PC), so the common
 * case stays one fenced round trip. A poll setting, not a limit: a pending write is then waited for outside the fence.
 */
const INPUT_ADMISSION_ACK_WAIT_MS = 250;
/** One /input-status park: it returns the moment the write settles; between parks the record's ownership is re-read. */
const INPUT_DRAIN_POLL_MS = 1_000;
/**
 * Elapsed Runner time for a wait loop, like runnerTimeDeadline: each step credits at most `maxStepMs` (the longest
 * one step's request can legitimately take), so a suspended Runner's resume never spends a write's whole bound at once.
 */
/**
 * The drain wait for one admitted write. It observes only that write's outcome, in whole-millisecond slices of at most
 * INPUT_DRAIN_POLL_MS (the supervisor parks only for an integer wait), and ends at the first of: acknowledged; failed
 * (the reader closed its stdin or exited, or the tree was stopped); an invalid reply; `observe` throwing (the record
 * released or not owned, the supervisor gone); `timeoutMs` spent; or `signal` (the session is stopping, or the caller
 * cancelled). Every ending other than acknowledged throws WindowsJobInputUnacknowledgedError, never a guess.
 */
export async function waitForAdmittedInput(options: {
  readonly sequence: number;
  readonly timeoutMs: number;
  readonly elapsed: () => number;
  readonly signal?: AbortSignal;
  readonly observe: (sliceMs: number) => Promise<{ sequence: number; state: string; error?: string }>;
}): Promise<void> {
  const { sequence, timeoutMs, elapsed, signal, observe } = options;
  try {
    for (;;) {
      const remaining = timeoutMs - elapsed();
      if (remaining <= 0) throw new Error(`Windows Job input was not drained by the reader within ${timeoutMs} ms.`);
      if (signal?.aborted) throw new Error("Windows Job input was not drained before its wait was abandoned (stop or cancellation).");
      // A fractional remainder (the clock is performance.now()) is rounded up: the supervisor would answer it at once.
      const observed = await observe(Math.max(1, Math.ceil(Math.min(INPUT_DRAIN_POLL_MS, remaining))));
      if (observed.sequence !== sequence) throw new Error("Windows Job input acknowledgement is invalid.");
      if (observed.state === "acknowledged") return;
      if (observed.state === "failed") throw new Error(`Windows Job input failed: ${observed.error ?? "unknown"}`);
      if (observed.state !== "pending") throw new Error("Windows Job input acknowledgement is invalid.");
    }
  } catch (error) {
    throw new WindowsJobInputUnacknowledgedError(error instanceof Error ? error.message : String(error));
  }
}

function elapsedClock(maxStepMs: number): () => number {
  let elapsed = 0, last = performance.now();
  return () => {
    const now = performance.now();
    elapsed += Math.min(now - last, maxStepMs); last = now;
    return elapsed;
  };
}
function runnerTimeDeadline(timeoutMs: number, expire: () => void): () => void {
  let elapsed = 0, last = performance.now(), cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined, turn: ReturnType<typeof setImmediate> | undefined;
  const arm = () => { timer = setTimeout(tick, Math.max(1, Math.min(SUPERVISOR_DEADLINE_TICK_MS, timeoutMs - elapsed))); timer.unref?.(); };
  const tick = () => {
    const now = performance.now();
    elapsed += Math.min(now - last, SUPERVISOR_DEADLINE_TICK_MS * 2); last = now;
    if (elapsed < timeoutMs) { arm(); return; }
    turn = setImmediate(() => { if (!cancelled) expire(); });
  };
  arm();
  return () => { cancelled = true; if (timer) clearTimeout(timer); if (turn) clearImmediate(turn); };
}
async function writeSupervisorConfig(launcher: ChildProcess, serialized: string): Promise<void> {
  if (!launcher.stdin) throw new Error("Supervisor configuration pipe is unavailable.");
  await new Promise<void>((resolvePromise, reject) => launcher.stdin!.end(serialized, (error?: Error | null) => error ? reject(error) : resolvePromise()));
}
/**
 * PX-2c repair 1 (B1): bounded proof timeout for the audited spare kill.
 * Crash recovery and the run-end sweep never block a start on it.
 */
const SPARE_REAP_VERIFY_TIMEOUT_MS = 2_000;

/**
 * PX-2c repair 1 (B1): the ONLY place a spare supervisor is ever killed by a
 * recorded PID. A stale record (PID reuse) or a planted record must never
 * kill an unrelated process, so the kill fires only after an authenticated
 * live-status proof with the record's own token: the durable status file must
 * already name this pair (processId, supervisorPid, unclaimed spare), and the
 * live supervisor must answer `GET /status` with the same identity. Anything
 * else — no file, a mismatch, silence, a wrong token, or a pair inside its
 * claim window (spareClaimInFlight, unless the caller passes acceptClaimed) —
 * returns "skipped" and the caller only drops the record. Never throws.
 * acceptClaimed is true only for the claim-window retire fallback below, where
 * `claimed` is the expected proof rather than a reason to skip.
 */
async function killVerifiedSpareSupervisor(record: HostRecord, durable: SupervisorStatus | null, timeoutMs: number, acceptClaimed = false): Promise<"killed" | "skipped"> {
  try {
    if (!durable || durable.protocol !== PROTOCOL || durable.processId !== record.processId
      || durable.supervisorPid !== record.supervisor.supervisorPid
      || durable.spare !== true || (!acceptClaimed && (durable.claimed === true || record.spareClaimInFlight === true))) return "skipped";
    const port = durable.port > 0 ? durable.port : record.supervisor.port;
    if (!(port > 0)) return "skipped";
    let live: SupervisorStatus;
    try {
      live = await supervisorRequest<SupervisorStatus>(
        { ...record.supervisor, port }, "/status", "GET", undefined, timeoutMs);
    } catch {
      return "skipped";
    }
    if (live.protocol !== PROTOCOL || live.processId !== record.processId
      || live.supervisorPid !== record.supervisor.supervisorPid || live.port !== port
      || live.spare !== true || (!acceptClaimed && live.claimed === true)) return "skipped";
    try {
      process.kill(record.supervisor.supervisorPid, "SIGKILL");
    } catch {
      // Already gone between the proof and the kill: the record is still dropped.
    }
    return "killed";
  } catch {
    return "skipped";
  }
}

/**
 * PX-2c repair 2 (N1): bounded retire budget for the claim-window tree below.
 * Crash recovery never blocks a host start on it (fire-and-forget).
 */
const SPARE_RETIRE_TREE_TIMEOUT_MS = 10_000;

/** Recovery waits probe retirement through the supervisor channel below, never by PID. */
/** Non-throwing durable-status read for recovery fallbacks: unreadable means no proof. */
function readSupervisorStatusQuiet(path: string): SupervisorStatus | null {
  try {
    return readSupervisorStatus(path);
  } catch {
    return null;
  }
}/**
 * PX-2c repair 2 (N1): retire a pair the previous runner lost inside the
 * claim window (spareClaimInFlight on disk while the supervisor already acked,
 * so the durable status reads claimed:true). The B1 helper must skip claimed
 * pairs, but here `claimed` is EXPECTED: after the same authenticated
 * identity proof (the durable file names this pair plus a live token-authed
 * GET /status with the same identity), the whole tree is retired through the
 * supervisor's own authenticated POST /signal — its stopOwnedTree owns the
 * single backend-kill site. Retirement is confirmed through the supervisor
 * channel (durable stopped plus a refused port, never a PID probe); when the
 * signal cannot retire the pair, the audited kill helper above runs as the
 * fallback with acceptClaimed. The call's durable record is
 * always kept as the audit trail: this helper never deletes anything, and
 * the constructor persists spareReapedAt before calling it. Never throws.
 */
async function retireVerifiedClaimWindowTree(record: HostRecord, durable: SupervisorStatus | null, verifyTimeoutMs: number, retireTimeoutMs: number, stopDeadlineMs: number): Promise<"retired" | "skipped"> {
  try {
    if (record.spareClaimInFlight !== true) return "skipped";
    if (!durable || durable.protocol !== PROTOCOL || durable.processId !== record.processId
      || durable.supervisorPid !== record.supervisor.supervisorPid
      || durable.spare !== true || durable.claimed !== true) return "skipped";
    const port = durable.port > 0 ? durable.port : record.supervisor.port;
    if (!(port > 0)) return "skipped";
    let live: SupervisorStatus;
    try {
      live = await supervisorRequest<SupervisorStatus>(
        { ...record.supervisor, port }, "/status", "GET", undefined, verifyTimeoutMs);
    } catch {
      return "skipped";
    }
    if (live.protocol !== PROTOCOL || live.processId !== record.processId
      || live.supervisorPid !== record.supervisor.supervisorPid || live.port !== port
      || live.spare !== true || live.claimed !== true) return "skipped";
    // Identity proven with the claim accepted. Retire the whole tree through
    // the supervisor: the call's fence travels in the claim-window record
    // (persisted before the ack), satisfying the supervisor's fence check.
    // A fenceless call skips to the audited fallback kill below.
    try {
      await supervisorRequest<SupervisorStatus>(
        { ...record.supervisor, port }, "/signal", "POST",
        { signal: "SIGKILL", deadlineMs: stopDeadlineMs, fence: record.currentFence },
        verifyTimeoutMs + retireTimeoutMs);
    } catch {}
    // Wait for the supervisor to prove the tree empty (durable stopped) and
    // then exit (its port refuses): no PID is ever probed or killed here.
    // A fenceless call the signal cannot retire falls to the audited helper
    // below, the file's single PID-kill site.
    const deadline = Date.now() + retireTimeoutMs;
    for (;;) {
      let current: SupervisorStatus | null = null;
      try {
        current = readSupervisorStatus(record.supervisor.statusPath);
      } catch {
        current = null;
      }
      if (current !== null && current.status === "stopped") {
        try {
          await supervisorRequest<SupervisorStatus>(
            { ...record.supervisor, port }, "/status", "GET", undefined, Math.min(verifyTimeoutMs, 1_000));
        } catch {
          break;
        }
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await killVerifiedSpareSupervisor(record, readSupervisorStatusQuiet(record.supervisor.statusPath), verifyTimeoutMs, true).catch(() => undefined);
    return "retired";
  } catch {
    return "skipped";
  }
}

/** Retention: whether a supervisor PID is gone now. A PID never set (0) is gone. Never waits. */
function supervisorGone(pid: number): boolean {
  return !(pid > 0) || !processIsAlive(pid);
}
/** CW3: whether `pid` names a live process (EPERM: alive, not ours to signal). */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
/**
 * PX-2c repair 1 (B2): the single supervisor spawn shared by the normal
 * launch path and the spare prestart. One raw spawn site, allowlisted once;
 * the caller owns launcher bookkeeping (tracking set, exit wiring).
 */
function spawnSupervisorProcess(supervisorScriptPath: string, processId: string, statusPath: string): ChildProcess {
  return spawn(process.execPath, [supervisorScriptPath, processId, statusPath], {
    detached: true, windowsHide: true, stdio: ["pipe", "ignore", "ignore", "ipc"],
  });
}
function waitForLauncherExit(launcher: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (launcher.exitCode !== null || launcher.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const onExit = (): void => { clearTimeout(timer); resolvePromise(true); };
    const timer = setTimeout(() => { launcher.off("exit", onExit); resolvePromise(launcher.exitCode !== null || launcher.signalCode !== null); }, Math.max(250, timeoutMs));
    launcher.once("exit", onExit);
  });
}
/**
 * The supervisor bounds its own abort by the same stop deadline (it waits for the host's exit and records it, then
 * acknowledges). This margin only orders the two bounds, so a supervisor still recording its stop is not killed first;
 * a supervisor that exits ends the wait at once.
 */
const ABORT_ACK_MARGIN_MS = 5_000;
async function abortStartingSupervisor(launcher: ChildProcess, token: string, deadlineMs: number): Promise<void> {
  if (launcher.exitCode !== null || launcher.signalCode !== null) return;
  const acknowledged = await new Promise<boolean>((resolvePromise) => {
    let settled = false; const finish = (value: boolean) => { if (settled) return; settled = true; clearTimeout(timer); launcher.off("message", onMessage); launcher.off("exit", onExit); resolvePromise(value); };
    const onMessage = (message: unknown) => { if (message && typeof message === "object" && (message as { type?: unknown }).type === "abort_ack" && (message as { token?: unknown }).token === token) finish(true); };
    const onExit = () => finish(true); const timer = setTimeout(() => finish(false), Math.max(250, deadlineMs) + ABORT_ACK_MARGIN_MS);
    launcher.on("message", onMessage); launcher.once("exit", onExit); if (!launcher.connected) finish(false); else launcher.send({ type: "abort", token }, (error) => { if (error) finish(false); });
  });
  if (!acknowledged && launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
}
/** The record file names in a Job host state directory, in name order. */
function listRecordNames(stateDirectory: string): string[] {
  return readdirSync(stateDirectory).filter((name) => name.endsWith(".json")).sort();
}
/**
 * Retention: removes a released process's own folder (supervisor status, job events, raw stdout and stderr). Only a
 * plain directory is removed; a link or junction in its place, or anything else, throws and the record is kept. A
 * missing folder is already removed.
 */
function removeRetiredProcessFolder(folder: string): void {
  let stat;
  try { stat = lstatSync(folder); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Windows Job process folder is not a plain folder: ${folder}`);
  rmSync(folder, { recursive: true, force: true });
}
function unreadBytes(path: string, offset: number, maximum: number): Uint8Array {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Windows Job output offset is invalid.");
  const descriptor = openSync(path, "r");
  try { const size = fstatSync(descriptor).size; if (offset > size) throw new Error("Windows Job output offset exceeds durable length."); const buffer = Buffer.allocUnsafe(Math.min(maximum, size - offset)); const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, offset); return buffer.subarray(0, bytesRead); }
  finally { closeSync(descriptor); }
}
function tail(path: string, maximum: number): string {
  const bytes = readFileSync(path);
  return bytes.subarray(Math.max(0, bytes.byteLength - maximum)).toString("utf8");
}
