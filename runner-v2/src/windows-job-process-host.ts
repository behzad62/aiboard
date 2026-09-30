// RUNNER_RAW_PROCESS_BOUNDARY: Windows Job containment host and helper probes require direct OS process APIs.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS } from "./cleanup-timeouts.js";
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { recoverRevokedOwnedFenceLock, withOwnedFenceLock } from "./owned-fence-lock.mjs";

import type { BackpressuredOutputMetadata } from "./interactive-process-channel.js";

const PROTOCOL = "aiboard-managed-process/v1";
const DEFAULT_START_DEADLINE_MS = 5_000;
const DEFAULT_CONTROL_DEADLINE_MS = 5_000;
const DEFAULT_ACTIVE_JOB_PROBE_DEADLINE_MS = 2_000;
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
  attachOwnedChannel?(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence): Promise<WindowsJobChannelState>;
  writeOwnedInput?(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence, sequence: number, payload: Uint8Array): Promise<{ readonly acknowledged: true; readonly sequence: number }>;
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
   * PX-2b: event-driven settlement wait. Returns after the supervisor
   * durably persists a newer status or after timeoutMs (bounded server
   * side). Read-only: it takes no fence lock and changes no state; every
   * caller re-polls and re-attests afterwards, and every existing deadline
   * stays armed. Throws on transport/auth failure so callers fall back to
   * a timed delay.
   */
  waitOwnedStatusChange?(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence, timeoutMs: number, sinceUpdatedAt?: string): Promise<void>;
}
export interface WindowsJobChannelState {
  readonly nextSequence: number; readonly inputClosed: boolean;
  readonly outputOffsets: { readonly stdout: number; readonly stderr: number };
  readonly outputSequences: { readonly stdout: number; readonly stderr: number };
  /** Exact persisted read frames, verified against retained bytes under the attachment fence. */
  readonly retainedOutput?: readonly BackpressuredOutputMetadata[];
  readonly snapshot: WindowsJobProcessSnapshot & { readonly ownershipReleased: boolean };
}
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
}

export interface SupervisorRecord { protocol: typeof PROTOCOL; token: string; statusPath: string; supervisorPid: number; port: number }
/** PX-2c: options for the pre-started spare pair. */
export interface WindowsJobSpareOptions {
  /** Idle budget for an unclaimed spare before its supervisor retires it. The supervisor clamps to 1-300 s; default 60 s. */
  readonly idleTimeoutMs?: number;
  /** Start a replacement spare in the background after a claim. Default false. */
  readonly autoRefresh?: boolean;
}
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
}
interface SupervisorStatus {
  protocol: typeof PROTOCOL; processId: string; supervisorPid: number; childPid: number; port: number;
  status: "starting" | "running" | "stopped" | "exited_unknown"; exitCode: number | null;
  signal: NodeJS.Signals | null; error: string | null; ownershipReleased: boolean; updatedAt: string;
  retainedOutputChunks: number; retainedOutputBytes: number;
  jobEmptyProof?: boolean;
  terminationRequested?: boolean;
  /** PX-2c: spare lifecycle marks persisted by the supervisor. */
  spare?: boolean;
  claimed?: boolean;
  spareReady?: boolean;
  spareRetired?: string;
}

export class WindowsJobHostError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "WindowsJobHostError"; }
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
 * Add-Type compile of the same source. A compile failure is NOT cached: the
 * next call retries (shared in-flight), so a transient failure before the
 * first pin heals. After the pin, nothing on disk is ever trusted again.
 */
export async function ensureJobHostHelperAssembly(): Promise<WindowsJobHostHelperAssembly | null> {
  try {
    if (process.platform !== "win32") return null;
    // R2-B1: once this runner process has compiled and pinned its helper,
    // the pin is never refreshed from disk. A missing, emptied or changed
    // file makes the call fall back to in-process Add-Type (the Job host
    // re-hashes the bytes and reports missing-file / digest-mismatch); the
    // runner never recompiles into the same place during its lifetime, so
    // a contained command that deletes the DLL cannot choose the moment of
    // a recompile and get its own bytes blessed.
    if (jobHostHelperReady) return jobHostHelperReady;
    if (jobHostHelperFlight) return await jobHostHelperFlight;
    const flight = compileJobHostHelperAssembly();
    jobHostHelperFlight = flight;
    try {
      const assembly = await flight;
      if (assembly) jobHostHelperReady = assembly;
      return assembly;
    } finally {
      if (jobHostHelperFlight === flight) jobHostHelperFlight = undefined;
    }
  } catch {
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
  private readonly platform: NodeJS.Platform;
  private readonly idFactory: () => string;
  private readonly clock: () => string;
  private readonly maxPollBytes: number;
  private readonly startDeadlineMs: number;
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
  /** PX-2c: at most one pre-started spare pair per host instance. */
  private readonly spareOptions: WindowsJobSpareOptions;
  private spareEntry?: { launcher: ChildProcess; token: string; processId: string; owner: WindowsJobOwnershipKey };
  private sparePrestartFlight?: Promise<WindowsJobSpareInfo>;
  private readonly spareCounts = { prestarts: 0, claims: 0, fallbacks: 0 };

  constructor(options: WindowsJobProcessHostOptions) {
    this.stateDirectory = resolve(options.stateDirectory);
    this.platform = options.platform ?? process.platform;
    this.idFactory = options.idFactory ?? (() => `process_${randomUUID()}`);
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.maxPollBytes = options.maxPollBytes ?? 256 * 1024;
    this.startDeadlineMs = options.startDeadlineMs ?? DEFAULT_START_DEADLINE_MS;
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
    mkdirSync(this.stateDirectory, { recursive: true });
    for (const name of readdirSync(this.stateDirectory)) {
      if (!name.endsWith(".json")) continue;
      const requestedProcessId = name.slice(0, -".json".length);
      this.assertProcessId(requestedProcessId);
      const value = JSON.parse(readFileSync(join(this.stateDirectory, name), "utf8")) as Partial<HostRecord>;
      if (isHostRecord(value)) {
        this.assertEmbeddedProcessId(requestedProcessId, value);
        this.records.set(requestedProcessId, value);
      }
    }
    // PX-2c repair 1 (B1/L3): crash recovery. An unclaimed spare is owned
    // durably (its record survives a runner crash) but must never be adopted
    // as a call. A new runner on this state directory drops the previous
    // runner's spare records instead of relaunching anything, and kills a
    // previous spare's processes only through killVerifiedSpareSupervisor:
    // never by a recorded PID alone, only after an authenticated live-status
    // proof with the record's token. A pair marked inside its claim window
    // (spareClaimInFlight) keeps its record as the audit trail: the tree is
    // still retired on proof, but the record is kept, never deleted.
    for (const [processId, value] of [...this.records]) {
      if (value.spare === true && value.spareClaimed !== true) {
        // Snapshot the durable status BEFORE the files below are dropped: the
        // async identity proof still needs it, and the record must be gone
        // synchronously (S5/S6 pin the synchronous drop).
        const durable = readSupervisorStatus(value.supervisor.statusPath);
        this.records.delete(processId);
        if (value.spareClaimInFlight === true) {
          try {
            this.persist({ ...value, spareReapedAt: this.clock() });
          } catch {}
        } else {
          this.removeSpareFiles(processId);
        }
        void killVerifiedSpareSupervisor(value, durable, SPARE_REAP_VERIFY_TIMEOUT_MS).catch(() => undefined);
      }
    }
  }

  async launchOwned(input: WindowsJobLaunchRequest): Promise<WindowsJobProcessSnapshot> {
    if (this.platform !== "win32" || process.platform !== "win32")
      throw new WindowsJobHostError("process_containment_unavailable", "Windows Job containment is unavailable on this platform.");
    // PX-2c: claim the pre-started spare when one is waiting. Any miss, death,
    // staleness, or identity failure returns null and the call starts the
    // normal way below, exactly as today.
    const spareSnapshot = await this.tryClaimSpareCall(input).catch(() => null);
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
    if (!helperAssembly) logJobHostHelperFallbackOnce(this.stateDirectory, "no-helper-config");
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
    this.records.set(processId, record); this.persist(record);
    // PX-2a repair 1: the digest is this runner process's in-memory pin and
    // travels over the private stdin channel, never argv, env, or HTTP; a
    // null here omits the fields and the Job host falls back to in-process
    // Add-Type compile.
    try {
      await writeSupervisorConfig(launcher, JSON.stringify({
        processId, token, statusPath, stdoutPath: record.stdoutPath, stderrPath: record.stderrPath,
        eventPath: join(processDirectory, "job-events.jsonl"),
        recordPath: this.containedProcessPath(processId, ".json"),
        command: input.command, args: [...input.args], cwd: record.cwd,
        env: { ...input.environment }, stopDeadlineMs: this.stopDeadlineMs, interactive: input.interactive === true,
        maxPollBytes: this.maxPollBytes,
        maxRetainedOutputChunks: this.maxRetainedOutputChunks,
        maxRetainedOutputBytes: this.maxRetainedOutputBytes,
        maxRetainedOutputChunkBytes: this.maxRetainedOutputChunkBytes,
        maxInputBytes: this.maxInputBytes,
        ...(helperAssembly ? { helperAssemblyPath: helperAssembly.path, helperAssemblySha256: helperAssembly.sha256 } : {}),
      }));
      const status = await waitForSupervisor(record.supervisor, processId, this.startDeadlineMs);
      this.applyStatus(record, status);
      if (status.status === "stopped" && status.error) throw new WindowsJobHostError("process_start_failed", status.error);
      if (status.status === "starting") throw new WindowsJobHostError("process_start_failed", "Windows Job supervisor did not confirm startup.");
    } catch (error) {
      await abortStartingSupervisor(launcher, token, this.stopDeadlineMs).catch(() => undefined);
      throw error;
    }
    if (launcher.connected) launcher.disconnect(); launcher.unref(); this.launchers.delete(launcher);
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
    const live = this.liveSpareEntry();
    if (live) {
      const supervisorPid = live.launcher.pid;
      return { processId: live.processId, supervisorPid: supervisorPid ?? 0 };
    }
    if (this.sparePrestartFlight) return await this.sparePrestartFlight;
    const flight = this.startSpare(owner);
    this.sparePrestartFlight = flight;
    try {
      return await flight;
    } finally {
      if (this.sparePrestartFlight === flight) this.sparePrestartFlight = undefined;
    }
  }

  /**
   * PX-2c: run-end cleanup. Retire the tracked spare (if any) plus any spare
   * records left behind on disk, without ever launching a call. Best-effort
   * and never throws: calls never depend on the spare.
   */
  async retireSpare(closingRun?: { readonly runId: string }): Promise<void> {
    const flight = this.sparePrestartFlight;
    if (flight) await flight.catch(() => undefined);
    const entry = this.spareEntry;
    // PX-2c repair 1 (M3): a run end retires only its own spare. Another
    // run's waiting spare (and its disk record) is left for its owner.
    // PX-2c repair 1 (B2): the redundant launcher kill is gone:
    // abortStartingSupervisor already SIGKILLs when no ack arrives.
    if (entry && (!closingRun || entry.owner.runId === closingRun.runId)) {
      this.spareEntry = undefined;
      await abortStartingSupervisor(entry.launcher, entry.token, this.stopDeadlineMs).catch(() => undefined);
      this.removeSpareFiles(entry.processId);
      this.records.delete(entry.processId);
    }
    await this.sweepRetiredSpareRecords(closingRun);
  }

  /** PX-2c: spare counters for measurement and tests. */
  spareStats(): WindowsJobSpareStats {
    return { ...this.spareCounts };
  }

  private async startSpare(owner: WindowsJobOwnershipKey): Promise<WindowsJobSpareInfo> {
    // PX-2a repair 1 (N2): resolve the precompiled helper BEFORE spawning the
    // supervisor. ensureJobHostHelperAssembly never throws, so a helper-side
    // failure (unusable TEMP, missing compiler) can no longer strand a
    // spawned supervisor behind a persisted `running` record: the call simply
    // omits the helper fields and falls back.
    const helperAssembly = await ensureJobHostHelperAssembly().catch(() => null);
    if (!helperAssembly) logJobHostHelperFallbackOnce(this.stateDirectory, "no-helper-config");
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
    this.records.set(processId, record); this.persist(record);
    // PX-2a repair 1: the digest is this runner process's in-memory pin and
    // still travels over the private stdin channel per call site.
    const idleTimeoutMs = this.spareOptions.idleTimeoutMs;
    try {
      await writeSupervisorConfig(launcher, JSON.stringify({
        processId, token, statusPath, stdoutPath: record.stdoutPath, stderrPath: record.stderrPath,
        eventPath: join(processDirectory, "job-events.jsonl"),
        recordPath: this.containedProcessPath(processId, ".json"),
        stopDeadlineMs: this.stopDeadlineMs, interactive: true,
        maxPollBytes: this.maxPollBytes,
        maxRetainedOutputChunks: this.maxRetainedOutputChunks,
        maxRetainedOutputBytes: this.maxRetainedOutputBytes,
        maxRetainedOutputChunkBytes: this.maxRetainedOutputChunkBytes,
        maxInputBytes: this.maxInputBytes,
        ...(helperAssembly ? { helperAssemblyPath: helperAssembly.path, helperAssemblySha256: helperAssembly.sha256 } : {}),
        spare: true,
        ...(typeof idleTimeoutMs === "number" && Number.isSafeInteger(idleTimeoutMs) ? { spareIdleTimeoutMs: idleTimeoutMs } : {}),
      }));
      await waitForSpareReadyStatus(record.supervisor, processId, this.startDeadlineMs);
    } catch (error) {
      await abortStartingSupervisor(launcher, token, this.stopDeadlineMs).catch(() => undefined);
      this.removeSpareFiles(processId);
      this.records.delete(processId);
      throw error;
    }
    // No disconnect/unref: the IPC channel stays open for the single claim,
    // and its break retires the spare when the owning runner dies.
    this.spareEntry = { launcher, token, processId, owner: { runId: owner.runId, sessionId: owner.sessionId } };
    this.spareCounts.prestarts += 1;
    return { processId, supervisorPid };
  }

  /** Synchronous liveness check for the spare slot; stale slots are cleaned so a fresh prestart never blocks on them. */
  private liveSpareEntry(): { launcher: ChildProcess; token: string; processId: string; owner: WindowsJobOwnershipKey } | undefined {
    const entry = this.spareEntry;
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
    this.spareEntry = undefined;
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
    const entry = this.spareEntry;
    this.spareEntry = undefined;
    if (!entry) return null;
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
        // Another run's spare: leave it for its owner; this call is no fallback of ours.
        if (!this.spareEntry) this.spareEntry = entry;
        else void abortStartingSupervisor(launcher, entry.token, this.stopDeadlineMs).catch(() => undefined);
        return null;
      }
      if (input.interactive !== true) {
        // The spare always runs the interactive backend (the production path).
        if (!this.spareEntry) this.spareEntry = entry;
        return null;
      }
      const status = readSupervisorStatus(record.supervisor.statusPath);
      if (!status || status.processId !== processId || status.supervisorPid !== record.supervisor.supervisorPid
        || status.spare !== true || status.claimed === true || status.spareReady !== true || status.port <= 0
        || status.status !== "starting") return fail();
      // PX-2c repair 1 (M3/L3): mark the claim window durably BEFORE the IPC
      // claim lands, so a concurrent run-end sweep skips this pair instead of
      // killing a call mid-claim, and a crash here keeps an audit trail.
      const claiming: HostRecord = { ...record, spareClaimInFlight: true, updatedAt: this.clock() };
      this.records.set(processId, claiming); this.persist(claiming);
      const acknowledged = await this.sendSpareClaim(launcher, entry.token, input);
      if (!acknowledged) return fail();
      // The claim landed: adopt the reservation for this call. The spare mark
      // stays (spareClaimed) so a second claim of this pair is impossible.
      const now = this.clock();
      const claimed: HostRecord = {
        ...record, command: input.command, args: [...input.args], cwd: resolve(input.workingDirectory),
        environmentKeys: Object.keys(input.environment).sort(), updatedAt: now,
        ...(input.fence ? { currentFence: { ...input.fence } } : {}),
        spare: true, spareClaimed: true, spareClaimInFlight: false,
      };
      this.records.set(processId, claimed); this.persist(claimed);
      if (launcher.connected) launcher.disconnect(); launcher.unref(); this.launchers.delete(launcher);
      try {
        const live = await waitForSupervisor(claimed.supervisor, processId, this.startDeadlineMs);
        this.applyStatus(claimed, live);
        if (live.status === "stopped" && live.error) throw new WindowsJobHostError("process_start_failed", live.error);
        if (live.status === "starting") throw new WindowsJobHostError("process_start_failed", "Windows Job supervisor did not confirm startup.");
      } catch (error) {
        // PX-2c repair 1 (M2): the claim was acked, so the call may already
        // have launched — a silent re-run is possible, not just a fallback.
        // Fall back only on positive proof no child ever started; otherwise
        // fail the call exactly like the normal path, keeping the record.
        const proof = readSupervisorStatus(claimed.supervisor.statusPath);
        if (proof && proof.childPid === 0) {
          await abortStartingSupervisor(launcher, entry.token, this.stopDeadlineMs).catch(() => undefined);
          this.removeSpareFiles(processId);
          this.records.delete(processId);
          this.spareCounts.fallbacks += 1;
          // Proven: the call never launched, so the normal path runs it exactly once.
          return null;
        }
        await abortStartingSupervisor(launcher, entry.token, this.stopDeadlineMs).catch(() => undefined);
        throw new WindowsJobHostError("process_start_failed", `Windows Job spare claim did not settle: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.spareCounts.claims += 1;
      return this.snapshot(claimed);
    } catch {
      return fail();
    }
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

  /** After a successful claim, start one replacement spare when autoRefresh is on. Fire-and-forget: the call never waits for it. */
  private refreshSpareInBackground(input: WindowsJobLaunchRequest): void {
    if (this.spareOptions.autoRefresh !== true) return;
    void this.prestartSpare({ runId: input.runId, sessionId: input.sessionId }).catch(() => undefined);
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

  /** Best-effort sweep of spare records left on disk (retired or crashed). Never launches; never throws. */
  private async sweepRetiredSpareRecords(closingRun?: { readonly runId: string }): Promise<void> {
    let names: string[] = [];
    try {
      names = readdirSync(this.stateDirectory).filter((name) => name.endsWith(".json"));
    } catch {
      return;
    }
    for (const name of names) {
      try {
        const processId = name.slice(0, -".json".length);
        this.assertProcessId(processId);
        const value = JSON.parse(readFileSync(join(this.stateDirectory, name), "utf8")) as Partial<HostRecord>;
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
      } catch {}
    }
  }

  async signalOwned(processId: string, signal: "SIGTERM" | "SIGINT" | "SIGKILL", owner: WindowsJobOwnershipKey, fence?: WindowsJobWriterFence): Promise<WindowsJobProcessSnapshot> {
    const record = this.ownedRecord(processId, owner); this.assertActive(record); this.assertCurrentFence(record, fence);
    let stoppedRecord = record;
    let status = await this.authenticatedStatus(record);
    this.throwIfTerminalOutputPending(status);
    if (status.status !== "stopped") {
      try {
        status = await this.withFenceEffect(record, fence, "signal", async (current) => {
          const result = await supervisorRequest<SupervisorStatus>(current.supervisor, "/signal", "POST", { signal, deadlineMs: this.stopDeadlineMs, fence }, this.stopDeadlineMs + 250);
          this.assertStatusIdentity(current, result); this.applyStatus(current, result); this.throwIfTerminalOutputPending(result); stoppedRecord = current; return result;
        });
      } catch (error) {
        const terminal = await this.authenticatedStatus(this.ownedRecord(processId, owner));
        this.throwIfTerminalOutputPending(terminal);
        throw error;
      }
    }
    if (status.status !== "stopped" && status.terminationRequested !== true)
      throw new WindowsJobHostError("process_stop_timeout", `Windows Job process ${processId} did not stop.`);
    return this.snapshot(stoppedRecord);
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
    const status = await this.authenticatedStatus(record);
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
        this.persist(candidate); this.records.set(processId, candidate);
        releaseEffectPersisted = true;
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
      if (changed) { current.outputFrames = frames; this.persist(current); this.records.set(processId, current); }
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
    const command = "$ErrorActionPreference='Stop';$s='using System;using System.Runtime.InteropServices;public static class P{[DllImport(\"kernel32.dll\",CharSet=CharSet.Unicode,SetLastError=true)]public static extern IntPtr CreateJobObject(IntPtr a,string n);[DllImport(\"kernel32.dll\",SetLastError=true)]public static extern bool CloseHandle(IntPtr h);}';Add-Type -TypeDefinition $s;$h=[P]::CreateJobObject([IntPtr]::Zero,$null);if($h -eq [IntPtr]::Zero){exit 1};if(-not [P]::CloseHandle($h)){exit 1}";
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
      if (!fenced || fence.fencingToken > fenced.fencingToken) { current.currentFence = { ...fence }; current.updatedAt = this.clock(); this.persist(current); this.records.set(processId, current); }
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

  async writeOwnedInput(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence, sequence: number, payload: Uint8Array): Promise<{ readonly acknowledged: true; readonly sequence: number }> {
    if (payload.byteLength > this.maxInputBytes) throw new WindowsJobHostError("process_control_unavailable", `Windows Job input exceeds the ${this.maxInputBytes}-byte limit.`);
    const record = this.ownedRecord(processId, owner); this.assertActive(record);
    const acknowledged = await this.withFenceEffect(record, fence, "write", async (current) => {
      this.assertActive(current);
      await this.authenticatedStatus(current);
      if (!current.interactive || current.inputClosed) throw new WindowsJobHostError("process_control_unavailable", "Windows Job input is unavailable.");
      if (sequence !== (current.nextInputSequence ?? 1)) throw new WindowsJobHostError("process_control_unavailable", "Windows Job input sequence is stale.");
      const result = await supervisorRequest<{ acknowledged: true; sequence: number }>(current.supervisor, "/write", "POST", { sequence, payload: Buffer.from(payload).toString("base64"), fence }, this.controlDeadlineMs + 250);
      if (result.acknowledged !== true || result.sequence !== sequence) throw new WindowsJobHostError("process_control_unavailable", "Windows Job input acknowledgement is invalid.");
      current.nextInputSequence = sequence + 1; current.updatedAt = this.clock(); this.persist(current); this.records.set(processId, current); return result;
    });
    return acknowledged;
  }

  async closeOwnedInput(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence): Promise<void> {
    const record = this.ownedRecord(processId, owner); this.assertActive(record);
    await this.withFenceEffect(record, fence, "close", async (current) => {
      this.assertActive(current);
      await this.authenticatedStatus(current);
      if (current.inputClosed) return;
      await supervisorRequest<{ acknowledged: true }>(current.supervisor, "/close-input", "POST", { fence }, this.controlDeadlineMs + 250);
      current.inputClosed = true; current.updatedAt = this.clock(); this.persist(current); this.records.set(processId, current);
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
      this.applyStatus(current, acknowledged.status, false);
      current.outputOffsets = { ...offsets, [stream]: endOffset };
      const sequences = current.outputSequences ?? { stdout: 0, stderr: 0 };
      current.outputSequences = { ...sequences, [stream]: sequences[stream] + 1 };
      if (frame) { const frames = { ...current.outputFrames }; delete frames[stream]; current.outputFrames = frames; }
      if (acknowledged.status.status === "stopped") this.assertJobOutputSettled(current, acknowledged.status);
      current.updatedAt = this.clock(); this.persist(current); this.records.set(processId, current);
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
        if (!current || fence.fencingToken > current.fencingToken) { record.currentFence = { ...fence }; record.updatedAt = this.clock(); this.persist(record); this.records.set(processId, record); }
      }, { assertAuthority: () => this.assertActive(this.ownedRecord(processId, owner)) });
    } catch (error) {
      if (error instanceof WindowsJobHostError) throw error;
      throw new WindowsJobHostError("process_control_unavailable", `Windows Job writer fence lock is unavailable: ${String(error)}`);
    }
  }

  private async authenticatedStatus(record: HostRecord): Promise<SupervisorStatus> {
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
    if (status.status === "stopped") this.assertJobOutputSettled(record, status);
    this.applyStatus(record, status); return status;
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
  private persist(record: HostRecord): void {
    const destination = this.containedProcessPath(record.processId, ".json"); const temporary = `${destination}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 }); renameSync(temporary, destination);
  }
  private applyStatus(record: HostRecord, status: SupervisorStatus, persistRecord = true): void {
    this.assertStatusIdentity(record, status); record.pid = status.childPid; record.supervisor.port = status.port;
    record.status = status.status === "stopped" ? "stopped" : status.status === "exited_unknown" ? "exited_unknown" : "running";
    record.exitCode = status.exitCode; record.signal = status.signal; record.updatedAt = status.updatedAt; if (persistRecord) this.persist(record);
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
      throw new WindowsJobHostError("process_control_unavailable", `Windows Job writer fence effect lock is unavailable: ${String(error)}`);
    } finally {
      finishTurn();
      if (this.effectTails.get(record.processId) === tail) this.effectTails.delete(record.processId);
    }
  }
  private async recoverReleasedFence(requestedProcessId: string, record: HostRecord, owner: WindowsJobOwnershipKey, expectedStartedAt: string, fence: WindowsJobWriterFence | undefined): Promise<void> {
    this.assertEmbeddedProcessId(requestedProcessId, record);
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
 */
export async function waitForSpareReadyStatus(supervisor: SupervisorRecord, processId: string, deadlineMs: number): Promise<SupervisorStatus> {
  const deadline = Date.now() + deadlineMs;
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
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await Promise.race([woke, new Promise((resolve) => setTimeout(resolve, Math.min(remaining, STARTUP_WATCH_TICK_MS)))]);
    } finally {
      try { watcher?.close(); } catch {}
    }
  }
  throw new WindowsJobHostError("process_start_failed", "Windows Job spare supervisor did not become ready before the deadline.");
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

export async function waitForSupervisor(supervisor: SupervisorRecord, processId: string, deadlineMs: number): Promise<SupervisorStatus> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    let wake!: () => void;
    const woke = new Promise<void>((resolve) => { wake = resolve; });
    const watcher = armFileWatch(dirname(supervisor.statusPath), basename(supervisor.statusPath), wake);
    try {
      const status = readSupervisorStatus(supervisor.statusPath);
      if (status && status.protocol === PROTOCOL && status.processId === processId && status.supervisorPid === supervisor.supervisorPid && status.port > 0) {
        supervisor.port = status.port;
        if (status.status === "stopped" || status.status === "exited_unknown") return status;
        if (status.status === "running")
          return await supervisorRequest(supervisor, "/status", "GET", undefined, Math.max(250, deadline - Date.now()));
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await Promise.race([woke, new Promise((resolve) => setTimeout(resolve, Math.min(remaining, STARTUP_WATCH_TICK_MS)))]);
    } finally {
      try { watcher?.close(); } catch {}
    }
  }
  throw new WindowsJobHostError("process_start_failed", "Windows Job supervisor did not become ready before the deadline.");
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

async function supervisorRequest<T = SupervisorStatus>(supervisor: SupervisorRecord, path: string, method: "GET" | "POST", body?: Record<string, unknown>, timeoutMs = DEFAULT_START_DEADLINE_MS + 250): Promise<T> {
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
    const call = request({ hostname: "127.0.0.1", port: supervisor.port, path, method, agent: false, headers: { authorization: `Bearer ${supervisor.token}`, connection: "close", ...(payload ? { "content-type": "application/json", "content-length": String(payload.byteLength) } : {}) }, timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = []; response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("error", fail);
      response.once("aborted", () => fail(new Error("Supervisor response was aborted.")));
      response.once("end", () => {
        if (settled) return;
        const text = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode !== 200) { fail(new Error(`Supervisor returned HTTP ${String(response.statusCode)}: ${text}`)); return; }
        try { const parsed = JSON.parse(text) as T; settled = true; resolvePromise(parsed); } catch (error) { fail(error); }
      });
    });
    call.once("timeout", () => call.destroy(new Error("Supervisor request timed out.")));
    call.once("error", fail);
    if (payload) call.write(payload);
    call.end();
  });
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
 * else — no file, a mismatch, silence, a wrong token — returns "skipped" and
 * the caller only drops the record. Never throws.
 */
async function killVerifiedSpareSupervisor(record: HostRecord, durable: SupervisorStatus | null, timeoutMs: number): Promise<"killed" | "skipped"> {
  try {
    if (!durable || durable.protocol !== PROTOCOL || durable.processId !== record.processId
      || durable.supervisorPid !== record.supervisor.supervisorPid
      || durable.spare !== true || durable.claimed === true) return "skipped";
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
      || live.spare !== true || live.claimed === true) return "skipped";
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
 * PX-2c repair 1 (B2): the single supervisor spawn shared by the normal
 * launch path and the spare prestart. One raw spawn site, allowlisted once;
 * the caller owns launcher bookkeeping (tracking set, exit wiring).
 */
function spawnSupervisorProcess(supervisorScriptPath: string, processId: string, statusPath: string): ChildProcess {
  return spawn(process.execPath, [supervisorScriptPath, processId, statusPath], {
    detached: true, windowsHide: true, stdio: ["pipe", "ignore", "ignore", "ipc"],
  });
}
async function abortStartingSupervisor(launcher: ChildProcess, token: string, deadlineMs: number): Promise<void> {
  if (launcher.exitCode !== null || launcher.signalCode !== null) return;
  const acknowledged = await new Promise<boolean>((resolvePromise) => {
    let settled = false; const finish = (value: boolean) => { if (settled) return; settled = true; clearTimeout(timer); launcher.off("message", onMessage); launcher.off("exit", onExit); resolvePromise(value); };
    const onMessage = (message: unknown) => { if (message && typeof message === "object" && (message as { type?: unknown }).type === "abort_ack" && (message as { token?: unknown }).token === token) finish(true); };
    const onExit = () => finish(true); const timer = setTimeout(() => finish(false), Math.max(250, deadlineMs));
    launcher.on("message", onMessage); launcher.once("exit", onExit); if (!launcher.connected) finish(false); else launcher.send({ type: "abort", token }, (error) => { if (error) finish(false); });
  });
  if (!acknowledged && launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
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
