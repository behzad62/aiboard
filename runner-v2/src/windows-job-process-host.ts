import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { recoverRevokedOwnedFenceLock, withOwnedFenceLock } from "./owned-fence-lock.mjs";

const PROTOCOL = "aiboard-managed-process/v1";
const DEFAULT_DEADLINE_MS = 5_000;
const DEFAULT_ACTIVE_JOB_PROBE_DEADLINE_MS = 2_000;
const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024;

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
  readOwnedOutput(processId: string, owner: WindowsJobOwnershipKey, offsets: { readonly stdout: number; readonly stderr: number }, fence?: WindowsJobWriterFence): WindowsJobOutputRead | Promise<WindowsJobOutputRead>;
  probeActiveJobCreateClose(): Promise<boolean>;
  attachOwnedChannel?(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence): Promise<WindowsJobChannelState>;
  writeOwnedInput?(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence, sequence: number, payload: Uint8Array): Promise<{ readonly acknowledged: true; readonly sequence: number }>;
  closeOwnedInput?(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence): Promise<void>;
  acknowledgeOwnedOutput?(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence, stream: "stdout" | "stderr", endOffset: number): Promise<void>;
  claimOwnedFence?(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence): Promise<void>;
}
export interface WindowsJobChannelState {
  readonly nextSequence: number; readonly inputClosed: boolean;
  readonly outputOffsets: { readonly stdout: number; readonly stderr: number };
  readonly outputSequences: { readonly stdout: number; readonly stderr: number };
  readonly snapshot: WindowsJobProcessSnapshot & { readonly ownershipReleased: boolean };
}
export interface WindowsJobProcessHostOptions {
  readonly stateDirectory: string; readonly platform?: NodeJS.Platform;
  readonly idFactory?: () => string; readonly clock?: () => string;
  readonly maxPollBytes?: number; readonly startDeadlineMs?: number; readonly stopDeadlineMs?: number;
  readonly maxRetainedOutputChunks?: number; readonly maxRetainedOutputBytes?: number;
  readonly maxRetainedOutputChunkBytes?: number;
  readonly maxInputBytes?: number;
  readonly supervisorScriptPath?: string;
  /** Test seam for the optional active Job probe; product uses the real PowerShell create/close command. */
  readonly activeJobProbe?: { readonly executable: string; readonly arguments: readonly string[]; readonly deadlineMs?: number };
  readonly beforeFenceEffect?: (kind: "attach" | "read" | "write" | "close" | "signal" | "output_ack" | "reconcile" | "release") => void | Promise<void>;
}

interface SupervisorRecord { protocol: typeof PROTOCOL; token: string; statusPath: string; supervisorPid: number; port: number }
interface HostRecord extends WindowsJobOwnershipKey {
  processId: string; pid: number; command: string; args: string[]; cwd: string; environmentKeys: string[];
  startedAt: string; updatedAt: string; status: "running" | "stopped" | "exited_unknown";
  exitCode: number | null; signal: NodeJS.Signals | null; stdoutPath: string; stderrPath: string;
  supervisor: SupervisorRecord; backendOwnershipReleasedAt?: string;
  interactive?: boolean; nextInputSequence?: number; inputClosed?: boolean;
  outputOffsets?: { stdout: number; stderr: number };
  outputSequences?: { stdout: number; stderr: number };
  currentFence?: WindowsJobWriterFence;
}
interface SupervisorStatus {
  protocol: typeof PROTOCOL; processId: string; supervisorPid: number; childPid: number; port: number;
  status: "starting" | "running" | "stopped" | "exited_unknown"; exitCode: number | null;
  signal: NodeJS.Signals | null; error: string | null; ownershipReleased: boolean; updatedAt: string;
  retainedOutputChunks: number; retainedOutputBytes: number;
  jobEmptyProof?: boolean;
  terminationRequested?: boolean;
}

export class WindowsJobHostError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "WindowsJobHostError"; }
}

/** Concrete authenticated owner of Job records, supervisors, control and output. */
export class AuthenticatedWindowsJobProcessHost implements WindowsJobProcessHost {
  private readonly stateDirectory: string;
  private readonly platform: NodeJS.Platform;
  private readonly idFactory: () => string;
  private readonly clock: () => string;
  private readonly maxPollBytes: number;
  private readonly startDeadlineMs: number;
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

  constructor(options: WindowsJobProcessHostOptions) {
    this.stateDirectory = resolve(options.stateDirectory);
    this.platform = options.platform ?? process.platform;
    this.idFactory = options.idFactory ?? (() => `process_${randomUUID()}`);
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.maxPollBytes = options.maxPollBytes ?? 256 * 1024;
    this.startDeadlineMs = options.startDeadlineMs ?? DEFAULT_DEADLINE_MS;
    this.stopDeadlineMs = options.stopDeadlineMs ?? DEFAULT_DEADLINE_MS;
    this.maxRetainedOutputChunks = options.maxRetainedOutputChunks ?? 16;
    this.maxRetainedOutputBytes = options.maxRetainedOutputBytes ?? 256 * 1024;
    this.maxRetainedOutputChunkBytes = options.maxRetainedOutputChunkBytes ?? 16 * 1024;
    this.maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
    if (!Number.isSafeInteger(this.maxInputBytes) || this.maxInputBytes < 1) throw new Error("Windows Job max input bytes must be positive.");
    this.supervisorScriptPath = options.supervisorScriptPath ?? join(dirname(fileURLToPath(import.meta.url)), "managed-process-supervisor.mjs");
    this.activeJobProbe = options.activeJobProbe;
    this.beforeFenceEffect = options.beforeFenceEffect;
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
  }

  async launchOwned(input: WindowsJobLaunchRequest): Promise<WindowsJobProcessSnapshot> {
    if (this.platform !== "win32" || process.platform !== "win32")
      throw new WindowsJobHostError("process_containment_unavailable", "Windows Job containment is unavailable on this platform.");
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
    const confirmed = await this.authenticatedStatus(record);
    if (confirmed.status !== "stopped" || !confirmed.ownershipReleased)
      throw new WindowsJobHostError("process_control_unavailable", `Windows Job process ${processId} terminal ownership changed before release.`);
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

  async readOwnedOutput(processId: string, owner: WindowsJobOwnershipKey, offsets: { readonly stdout: number; readonly stderr: number }, fence?: WindowsJobWriterFence): Promise<WindowsJobOutputRead> {
    const record = this.ownedRecord(processId, owner); this.assertActive(record);
    return await this.withFenceEffect(record, fence, "read", async (current) => {
      this.assertActive(current);
      // Keep status re-attestation and the evidence read in one durable fence
      // turn so high-volume output does not pay for two equivalent lock commits.
      await this.authenticatedStatus(current);
      const stdout = unreadBytes(current.stdoutPath, offsets.stdout, this.maxPollBytes);
      const stderr = unreadBytes(current.stderrPath, offsets.stderr, this.maxPollBytes);
      return { stdout, stderr, next: { stdout: offsets.stdout + stdout.byteLength, stderr: offsets.stderr + stderr.byteLength } };
    });
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
        snapshot: { ...this.snapshot(current), ownershipReleased: status.ownershipReleased },
      };
    });
  }

  async writeOwnedInput(processId: string, owner: WindowsJobOwnershipKey, fence: WindowsJobWriterFence, sequence: number, payload: Uint8Array): Promise<{ readonly acknowledged: true; readonly sequence: number }> {
    if (payload.byteLength > this.maxInputBytes) throw new WindowsJobHostError("process_control_unavailable", `Windows Job input exceeds the ${this.maxInputBytes}-byte limit.`);
    const record = this.ownedRecord(processId, owner); this.assertActive(record);
    const acknowledged = await this.withFenceEffect(record, fence, "write", async (current) => {
      this.assertActive(current);
      await this.authenticatedStatus(current);
      if (!current.interactive || current.inputClosed) throw new WindowsJobHostError("process_control_unavailable", "Windows Job input is unavailable.");
      if (sequence !== (current.nextInputSequence ?? 1)) throw new WindowsJobHostError("process_control_unavailable", "Windows Job input sequence is stale.");
      const result = await supervisorRequest<{ acknowledged: true; sequence: number }>(current.supervisor, "/write", "POST", { sequence, payload: Buffer.from(payload).toString("base64"), fence }, this.stopDeadlineMs + 250);
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
      await supervisorRequest<{ acknowledged: true }>(current.supervisor, "/close-input", "POST", { fence }, this.stopDeadlineMs + 250);
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
      const acknowledged = await supervisorRequest<{ acknowledged: true; stream: "stdout" | "stderr"; endOffset: number; status: SupervisorStatus }>(current.supervisor, "/ack-output", "POST", { stream, endOffset, fence }, this.stopDeadlineMs + 250);
      if (acknowledged.acknowledged !== true || acknowledged.stream !== stream || acknowledged.endOffset !== endOffset)
        throw new WindowsJobHostError("process_control_unavailable", "Windows Job supervisor output acknowledgement is invalid.");
      this.assertStatusIdentity(current, acknowledged.status);
      this.assertOutputEvidence(current, acknowledged.status);
      this.applyStatus(current, acknowledged.status, false);
      current.outputOffsets = { ...offsets, [stream]: endOffset };
      const sequences = current.outputSequences ?? { stdout: 0, stderr: 0 };
      current.outputSequences = { ...sequences, [stream]: sequences[stream] + 1 };
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
        status = await supervisorRequest<SupervisorStatus>(record.supervisor, "/status", "GET", undefined, this.stopDeadlineMs + 250);
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
  private async withFenceEffect<T>(record: HostRecord, fence: WindowsJobWriterFence | undefined, kind: "attach" | "read" | "write" | "close" | "signal" | "output_ack" | "reconcile" | "release", effect: (current: HostRecord) => Promise<T>): Promise<T> {
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
        this.assertCurrentFence(current, fence);
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
async function waitForSupervisor(supervisor: SupervisorRecord, processId: string, deadlineMs: number): Promise<SupervisorStatus> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const status = readSupervisorStatus(supervisor.statusPath);
    if (status && status.protocol === PROTOCOL && status.processId === processId && status.supervisorPid === supervisor.supervisorPid && status.port > 0) {
      supervisor.port = status.port;
      if (status.status === "stopped" || status.status === "exited_unknown") return status;
      if (status.status === "running")
        return await supervisorRequest(supervisor, "/status", "GET", undefined, Math.max(250, deadline - Date.now()));
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new WindowsJobHostError("process_start_failed", "Windows Job supervisor did not become ready before the deadline.");
}
async function supervisorRequest<T = SupervisorStatus>(supervisor: SupervisorRecord, path: string, method: "GET" | "POST", body?: Record<string, unknown>, timeoutMs = DEFAULT_DEADLINE_MS + 250): Promise<T> {
  const payload = body ? Buffer.from(JSON.stringify(body)) : undefined;
  return await new Promise<T>((resolvePromise, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const call = request({ hostname: "127.0.0.1", port: supervisor.port, path, method, headers: { authorization: `Bearer ${supervisor.token}`, ...(payload ? { "content-type": "application/json", "content-length": String(payload.byteLength) } : {}) }, timeout: timeoutMs }, (response) => {
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
