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
const JOB_HOST_SCRIPT_FILENAME = "managed-process-job-host.ps1";
const JOB_HOST_HELPER_DIRNAME = "job-host-assemblies";
const JOB_HOST_HELPER_DLL_FILENAME = "ManagedProcessJobHost.dll";
const JOB_HOST_HELPER_DIGEST_FILENAME = "ManagedProcessJobHost.dll.sha256";
const JOB_HOST_SOURCE_MARKER_START = "$jobHostCsSource = @'";
const JOB_HOST_COMPILE_TIMEOUT_MS = 120_000;

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
  retireSpare?(): Promise<void>;
  spareStats?(): WindowsJobSpareStats;
  /**
   * PX-2b: event-driven settlement wait. Returns after the supervisor
   * durably persists a newer status or after timeoutMs (bounded server
   * side). Read-only: it takes no fence lock and changes no state; every
   * caller re-polls and re-attests afterwards, and every existing deadline
   * stays armed. Throws on transport/auth failure so callers fall back to
   * a timed delay.
   */
  waitOwnedStatusChange?(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence, timeoutMs: number): Promise<void>;
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

/** Digest-pin record for one compiled Job-host helper assembly. */
export interface WindowsJobHostHelperAssembly { readonly path: string; readonly sha256: string }

/** Assembly directories whose compile already failed in this process: never retry per call. */
const helperAssemblyCompileFailures = new Set<string>();

function jobHostScriptPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), JOB_HOST_SCRIPT_FILENAME);
}

/** Extract the embedded C# helper source from the Job-host script. Null when the markers are absent. */
export function extractJobHostHelperSource(scriptText: string): string | null {
  const start = scriptText.indexOf(JOB_HOST_SOURCE_MARKER_START);
  if (start < 0) return null;
  const bodyStart = start + JOB_HOST_SOURCE_MARKER_START.length;
  // The here-string closes on a line holding exactly `'@`.
  const end = scriptText.indexOf("\n'@", bodyStart);
  if (end < 0) return null;
  return scriptText.slice(bodyStart, end).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

/**
 * PX-2a: resolve the precompiled, digest-pinned Job-host helper assembly for
 * this state directory, compiling it once (into a runner-owned directory
 * under the state directory, keyed by source digest) when absent. The host
 * records the assembly sha256 at compile time and passes that digest to each
 * Job host over the private stdin channel; the Job host re-hashes the bytes
 * before loading from them. Returns null when unavailable: calls then omit
 * the helper fields and each Job host falls back to in-process Add-Type
 * compile of the same source.
 */
export function ensureJobHostHelperAssembly(stateDirectory: string): WindowsJobHostHelperAssembly | null {
  if (process.platform !== "win32") return null;
  let scriptText: string;
  try {
    scriptText = readFileSync(jobHostScriptPath(), "utf8");
  } catch {
    return null;
  }
  const source = extractJobHostHelperSource(scriptText);
  if (source === null) return null;
  const sourceDigest = createHash("sha256").update(source, "utf8").digest("hex");
  const directory = join(resolve(stateDirectory), JOB_HOST_HELPER_DIRNAME, sourceDigest);
  const dllPath = join(directory, JOB_HOST_HELPER_DLL_FILENAME);
  const digestPath = join(directory, JOB_HOST_HELPER_DIGEST_FILENAME);
  if (helperAssemblyCompileFailures.has(directory)) return null;
  try {
    const recorded = existsSync(dllPath) && existsSync(digestPath)
      ? readFileSync(digestPath, "utf8").trim().toLowerCase()
      : null;
    if (recorded !== null && /^[a-f0-9]{64}$/.test(recorded)) {
      // Pass-through on purpose: the Job host re-hashes the file bytes
      // against this digest on every call and falls back on any mismatch, so
      // a tampered assembly file or a tampered digest record is never loaded.
      // No recompile here: the mismatch itself is the observed signal.
      return { path: dllPath, sha256: recorded };
    }
  } catch {
    // Fall through to compile.
  }
  const compiled = compileJobHostHelperAssembly(source, dllPath, digestPath);
  if (compiled === null) helperAssemblyCompileFailures.add(directory);
  return compiled;
}

function compileJobHostHelperAssembly(source: string, dllPath: string, digestPath: string): WindowsJobHostHelperAssembly | null {
  const scratch = mkdtempSync(join(tmpdir(), "aiboard-job-host-assembly-"));
  try {
    mkdirSync(dirname(dllPath), { recursive: true });
    rmSync(dllPath, { force: true });
    const sourcePath = join(scratch, "ManagedProcessJobHost.cs");
    writeFileSync(sourcePath, source, "utf8");
    const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
    const command = `Add-Type -TypeDefinition (Get-Content -LiteralPath ${quote(sourcePath)} -Raw -Encoding UTF8) -OutputAssembly ${quote(dllPath)} -OutputType Library`;
    const result = spawnSync("powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, stdio: "ignore", timeout: JOB_HOST_COMPILE_TIMEOUT_MS, killSignal: "SIGKILL" });
    if (result.status !== 0 || result.error) return null;
    let bytes: Buffer;
    try {
      bytes = readFileSync(dllPath);
    } catch {
      return null;
    }
    if (bytes.byteLength === 0) return null;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(digestPath, `${sha256}\n`, "utf8");
    return { path: dllPath, sha256 };
  } catch {
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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
    // PX-2c: crash recovery. An unclaimed spare is owned durably (its record
    // survives a runner crash) but must never be adopted as a call: a new
    // runner on this state directory kills the previous runner's spare
    // processes and drops their records instead of relaunching anything.
    for (const [processId, value] of [...this.records]) {
      if (value.spare === true && value.spareClaimed !== true) {
        try {
          process.kill(value.supervisor.supervisorPid, "SIGKILL");
        } catch {}
        try {
          rmSync(this.containedProcessPath(processId, ".json"), { force: true });
        } catch {}
        try {
          rmSync(this.containedProcessPath(processId, ""), { recursive: true, force: true });
        } catch {}
        this.records.delete(processId);
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
    const processId = this.validatedProcessId(this.idFactory());
    if (this.readRecord(processId)) throw new WindowsJobHostError("process_id_conflict", `Process ${processId} already exists.`);
    const processDirectory = this.containedProcessPath(processId, "");
    mkdirSync(processDirectory, { recursive: true });
    const token = randomBytes(32).toString("hex");
    const statusPath = join(processDirectory, "supervisor.jsonl");
    const launcher = spawn(process.execPath, [this.supervisorScriptPath, processId, statusPath], {
      detached: true, windowsHide: true, stdio: ["pipe", "ignore", "ignore", "ipc"],
    });
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
    // PX-2a: resolve the precompiled helper once per state directory (compiled
    // on first use). The digest travels over the private stdin channel, never
    // argv, env, or HTTP; a null here omits the fields and the Job host falls
    // back to in-process Add-Type compile.
    const helperAssembly = ensureJobHostHelperAssembly(this.stateDirectory);
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
  async retireSpare(): Promise<void> {
    const flight = this.sparePrestartFlight;
    if (flight) await flight.catch(() => undefined);
    const entry = this.spareEntry;
    this.spareEntry = undefined;
    if (entry) {
      await abortStartingSupervisor(entry.launcher, entry.token, this.stopDeadlineMs).catch(() => undefined);
      if (entry.launcher.exitCode === null && entry.launcher.signalCode === null) {
        try {
          entry.launcher.kill("SIGKILL");
        } catch {}
      }
      this.removeSpareFiles(entry.processId);
      this.records.delete(entry.processId);
    }
    this.sweepRetiredSpareRecords();
  }

  /** PX-2c: spare counters for measurement and tests. */
  spareStats(): WindowsJobSpareStats {
    return { ...this.spareCounts };
  }

  private async startSpare(owner: WindowsJobOwnershipKey): Promise<WindowsJobSpareInfo> {
    const processId = this.validatedProcessId(this.idFactory());
    if (this.readRecord(processId)) throw new WindowsJobHostError("process_id_conflict", `Process ${processId} already exists.`);
    const processDirectory = this.containedProcessPath(processId, "");
    mkdirSync(processDirectory, { recursive: true });
    const token = randomBytes(32).toString("hex");
    const statusPath = join(processDirectory, "supervisor.jsonl");
    const launcher = spawn(process.execPath, [this.supervisorScriptPath, processId, statusPath], {
      detached: true, windowsHide: true, stdio: ["pipe", "ignore", "ignore", "ipc"],
    });
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
    // PX-2a's helper compile happens here, off the call's critical path: the
    // digest still travels over the private stdin channel per call site.
    const helperAssembly = ensureJobHostHelperAssembly(this.stateDirectory);
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
      const acknowledged = await this.sendSpareClaim(launcher, entry.token, input);
      if (!acknowledged) return fail();
      // The claim landed: adopt the reservation for this call. The spare mark
      // stays (spareClaimed) so a second claim of this pair is impossible.
      const now = this.clock();
      const claimed: HostRecord = {
        ...record, command: input.command, args: [...input.args], cwd: resolve(input.workingDirectory),
        environmentKeys: Object.keys(input.environment).sort(), updatedAt: now,
        ...(input.fence ? { currentFence: { ...input.fence } } : {}),
        spare: true, spareClaimed: true,
      };
      this.records.set(processId, claimed); this.persist(claimed);
      if (launcher.connected) launcher.disconnect(); launcher.unref(); this.launchers.delete(launcher);
      try {
        const live = await waitForSupervisor(claimed.supervisor, processId, this.startDeadlineMs);
        this.applyStatus(claimed, live);
        if (live.status === "stopped" && live.error) throw new WindowsJobHostError("process_start_failed", live.error);
        if (live.status === "starting") throw new WindowsJobHostError("process_start_failed", "Windows Job supervisor did not confirm startup.");
      } catch {
        await abortStartingSupervisor(launcher, entry.token, this.stopDeadlineMs).catch(() => undefined);
        this.removeSpareFiles(processId);
        this.records.delete(processId);
        this.spareCounts.fallbacks += 1;
        // The call never launched: the normal path runs it exactly once.
        return null;
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
  private sweepRetiredSpareRecords(): void {
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
        try {
          process.kill(value.supervisor.supervisorPid, "SIGKILL");
        } catch {}
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
    if (status.status !== "stopped" || !status.ownershipReleased)
      throw new WindowsJobHostError("process_control_unavailable", `Windows Job process ${processId} is not verified terminal.`);
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

  async waitOwnedStatusChange(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence, timeoutMs: number): Promise<void> {
    // PX-2b: read-only event wait, deliberately outside the fence lock (a
    // parked wait must never block retained-output acknowledgements, which
    // need the lock to drain). Preconditions match every other effect; the
    // caller re-polls and re-attests under the fence afterwards.
    const record = this.ownedRecord(processId, owner); this.assertActive(record); this.assertCurrentFence(record, fence);
    await waitForSupervisorStatusChange(record.supervisor, timeoutMs);
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
    await waitForFileActivity(dirname(supervisor.statusPath), basename(supervisor.statusPath), remaining);
  }
  throw new WindowsJobHostError("process_start_failed", "Windows Job spare supervisor did not become ready before the deadline.");
}

export async function waitForSupervisor(supervisor: SupervisorRecord, processId: string, deadlineMs: number): Promise<SupervisorStatus> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const status = readSupervisorStatus(supervisor.statusPath);
    if (status && status.protocol === PROTOCOL && status.processId === processId && status.supervisorPid === supervisor.supervisorPid && status.port > 0) {
      supervisor.port = status.port;
      if (status.status === "stopped" || status.status === "exited_unknown") return status;
      if (status.status === "running")
        return await supervisorRequest(supervisor, "/status", "GET", undefined, Math.max(250, deadline - Date.now()));
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await waitForFileActivity(dirname(supervisor.statusPath), basename(supervisor.statusPath), remaining);
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
    const timer = setTimeout(finish, Math.max(1, timeoutMs));
    try {
      watcher = watch(directory);
    } catch {
      return;
    }
    watcher.once("error", () => finish());
    watcher.on("change", (_event, name) => { if (name === filename) finish(); });
  });
}

/**
 * PX-2b: event-driven settlement wait over the existing authenticated
 * supervisor channel. The supervisor answers immediately when already
 * terminal (no lost wakeup: terminal state is final) and otherwise parks
 * the request until its next durable persist or the bounded timeout.
 * Throws on transport/auth failure so the caller falls back to a timed
 * delay; every existing deadline stays armed. Exported for tests.
 */
export async function waitForSupervisorStatusChange(supervisor: SupervisorRecord, timeoutMs: number): Promise<SupervisorStatus> {
  const bounded = Number.isSafeInteger(timeoutMs) ? Math.min(5_000, Math.max(1, timeoutMs)) : 1_000;
  return await supervisorRequest<SupervisorStatus>(supervisor, `/wait-status?timeoutMs=${bounded}`, "GET", undefined, bounded + 250);
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
