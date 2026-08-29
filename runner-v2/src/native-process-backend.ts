import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

export interface NativeOwnedProcessBackendOptions {
  readonly stateDirectory?: string;
  readonly pollIntervalMs?: number;
  readonly platform: "posix" | "windows";
  readonly backendId: string;
  readonly capabilities: ExecutionSafetyCapabilities;
  readonly operations?: NativeProcessOperations;
}
export interface NativeProcessOperations {
  processBirth(pid: number, platform: "posix" | "windows"): string | undefined;
  listPosixGroup(groupId: number): readonly number[] | undefined;
  signal(pid: number, signal: NodeJS.Signals): void;
}

interface Identity {
  readonly version: 1;
  readonly backendId: string;
  readonly nonce: string;
  readonly directory: string;
  readonly supervisorPid: number;
  readonly supervisorBirth: string;
}
interface SupervisorState {
  readonly protocol: "aiboard-portable-process/v1";
  readonly nonce: string;
  readonly supervisorPid: number;
  readonly childPid: number;
  readonly revision: number;
  readonly handledControl: number;
  readonly status: "running" | "stopped" | "outcome_unknown";
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
  private readonly outputOffsets = new Map<string, { stdout: number; stderr: number }>();
  constructor(private readonly options: NativeOwnedProcessBackendOptions) {
    this.stateDirectory = resolve(options.stateDirectory ?? join(tmpdir(), "aiboard-portable-processes"));
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
    this.operations = options.operations ?? DEFAULT_OPERATIONS;
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
    const nonce = randomBytes(24).toString("hex");
    const directory = join(this.stateDirectory, `owned-${randomUUID()}`);
    mkdirSync(directory, { recursive: false, mode: 0o700 });
    writeFileSync(join(directory, "stdout.log"), "", { mode: 0o600 });
    writeFileSync(join(directory, "stderr.log"), "", { mode: 0o600 });
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
    })).toString("base64url");
    const child = spawn(process.execPath, [supervisor, encoded], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    if (!child.pid) throw new Error("Portable process supervisor has no PID.");
    child.unref();
    let identity: Identity | undefined;
    try {
      const supervisorBirth = await this.waitForBirth(child.pid, 1_000);
      if (!supervisorBirth) throw new Error("Portable supervisor birth identity is unavailable.");
      identity = {
        version: 1,
        backendId: this.options.backendId,
        nonce,
        directory,
        supervisorPid: child.pid,
        supervisorBirth,
      };
      const state = await this.waitForState(directory, nonce, child.pid, 5_000);
      if (state.status !== "running") throw new Error(state.error ?? "Portable process launch failed.");
      const startedAt = state.updatedAt;
      return {
        opaqueIdentity: Buffer.from(JSON.stringify(identity)).toString("base64url"),
        birthFingerprint: {
          observedAt: startedAt,
          discriminator: createHash("sha256").update(`${nonce}\0${supervisorBirth}`).digest("hex"),
        },
        rootPid: child.pid,
        startedAt,
      };
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
          rmSync(directory, { recursive: true, force: true });
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
        throw new AggregateError(
          [error, cleanupError],
          `Portable process launch failed and owned cleanup could not be verified; evidence retained at ${directory}.`,
        );
      }
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async observe(
    binding: ProcessBackendBinding,
    output: (stream: ProcessOutputStream, bytes: Uint8Array) => Promise<void>,
    _fence: ProcessEffectFence,
  ): Promise<unknown> {
    const identity = this.identity(binding);
    for (;;) {
      await this.flushOutput(identity, output);
      const reconciled = await this.reconcile(binding, _fence) as { state: string; exitCode?: number; signal?: string };
      if (reconciled.state === "exited") {
        await this.flushOutput(identity, output);
        return reconciled;
      }
      if (reconciled.state !== "running") throw new Error(`Owned process observation failed: ${reconciled.state}.`);
      await delay(this.pollIntervalMs);
    }
  }

  async signal(binding: ProcessBackendBinding, action: ProcessEscalationAction, _fence?: ProcessEffectFence): Promise<unknown> {
    const identity = this.identity(binding);
    const validation = this.validate(identity);
    if (validation === "mismatch") throw new Error("Owned process identity mismatch.");
    if (validation === "exited") return this.signalState(await this.emptiness(identity));
    if (this.options.platform === "posix") {
      const signal = action === "force_terminate" ? "SIGKILL" : action === "interrupt" ? "SIGINT" : "SIGTERM";
      this.operations.signal(-identity.supervisorPid, signal);
    } else {
      const beforeSignal = await this.emptiness(identity);
      if (beforeSignal === "identity_mismatch") throw new Error("Owned descendant identity mismatch.");
      if (beforeSignal === "outcome_unknown") throw new Error("Owned descendant identity is unavailable.");
      const state = readState(identity.directory);
      const sequence = (state?.handledControl ?? 0) + 1;
      writeFileSync(join(identity.directory, "control.json"), JSON.stringify({ nonce: identity.nonce, sequence, action }), { mode: 0o600 });
    }
    await delay(action === "force_terminate" ? 250 : 75);
    return this.signalState(await this.emptiness(identity));
  }

  async verifyEmpty(binding: ProcessBackendBinding, _fence?: ProcessEffectFence): Promise<unknown> {
    const identity = this.identity(binding);
    if (this.validate(identity) === "mismatch")
      return { empty: false, detail: "Owned process identity changed before quiescence verification." };
    const emptiness = await this.emptiness(identity);
    if (emptiness === "empty") return { empty: true, proofArtifactId: `native-empty:${identity.nonce}` };
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
    const validation = this.validate(identity);
    if (validation === "mismatch") return { state: "identity_mismatch" };
    const state = readState(identity.directory);
    if (!state) return { state: "outcome_unknown" };
    if (state.nonce !== identity.nonce || state.supervisorPid !== identity.supervisorPid)
      return { state: "identity_mismatch" };
    if (state.status === "outcome_unknown") return { state: "outcome_unknown" };
    const emptiness = await this.emptiness(identity);
    if (emptiness === "identity_mismatch") return { state: "identity_mismatch" };
    if (emptiness === "outcome_unknown") return { state: "outcome_unknown" };
    if (validation === "live" || emptiness === "nonempty") return { state: "running" };
    return {
      state: "exited",
      ...(state.exitCode === null ? {} : { exitCode: state.exitCode }),
      ...(state.signal ? { signal: state.signal } : {}),
    };
  }

  async release(binding: ProcessBackendBinding, _fence?: ProcessEffectFence): Promise<unknown> {
    const identity = this.identity(binding);
    const emptiness = await this.emptiness(identity);
    if (emptiness !== "empty")
      throw new Error(emptiness === "outcome_unknown" ? "Cannot release ownership with unknown empty verification." : "Cannot release non-empty owned process identity.");
    this.outputOffsets.delete(identity.nonce);
    rmSync(identity.directory, { recursive: true, force: true });
    return { released: true };
  }

  private assertPlatform(): void {
    if (this.options.platform === "windows" ? process.platform !== "win32" : process.platform === "win32")
      throw new Error(`${this.options.platform} native process backend is unavailable on ${process.platform}.`);
  }
  private identity(binding: ProcessBackendBinding): Identity {
    const value = JSON.parse(Buffer.from(binding.opaqueIdentity, "base64url").toString("utf8")) as Identity;
    if (value.version !== 1 || value.backendId !== this.options.backendId || !value.nonce || !value.directory || !Number.isSafeInteger(value.supervisorPid) || !value.supervisorBirth)
      throw new Error("Owned process opaque identity is invalid.");
    const expected = createHash("sha256").update(`${value.nonce}\0${value.supervisorBirth}`).digest("hex");
    if (binding.birthFingerprint.discriminator !== expected || binding.rootPid !== value.supervisorPid)
      throw new OwnedProcessIdentityMismatchError("Owned process birth fingerprint is invalid.");
    return value;
  }
  private validate(identity: Identity): "live" | "exited" | "mismatch" {
    const current = this.operations.processBirth(identity.supervisorPid, this.options.platform);
    if (!current) return "exited";
    return current === identity.supervisorBirth ? "live" : "mismatch";
  }
  private async emptiness(identity: Identity): Promise<"empty" | "nonempty" | "identity_mismatch" | "outcome_unknown"> {
    if (this.options.platform === "posix") {
      const members = this.operations.listPosixGroup(identity.supervisorPid);
      return members === undefined ? "outcome_unknown" : members.length === 0 ? "empty" : "nonempty";
    }
    const state = readState(identity.directory);
    if (!state || !Array.isArray(state.knownProcesses)) return "outcome_unknown";
    let live = false;
    for (const process of state.knownProcesses) {
      if (!Number.isSafeInteger(process.pid) || !process.birth) return "outcome_unknown";
      const current = this.operations.processBirth(process.pid, "windows");
      if (!current) continue;
      if (current !== process.birth) return "identity_mismatch";
      live = true;
    }
    return live ? "nonempty" : "empty";
  }
  private signalState(emptiness: "empty" | "nonempty" | "identity_mismatch" | "outcome_unknown"): { state: "running" | "exited" } {
    if (emptiness === "identity_mismatch") throw new Error("Owned descendant identity mismatch.");
    if (emptiness === "outcome_unknown") throw new Error("Owned process membership could not be verified after signal.");
    return { state: emptiness === "empty" ? "exited" : "running" };
  }
  private async cleanupFailedLaunch(identity: Identity): Promise<void> {
    const validation = this.validate(identity);
    if (validation === "mismatch") throw new Error("Launch cleanup refused a recycled supervisor identity.");
    if (validation === "live") {
      if (this.options.platform === "posix") {
        const members = this.operations.listPosixGroup(identity.supervisorPid);
        if (members === undefined) throw new Error("Launch cleanup could not enumerate the owned POSIX group.");
        this.operations.signal(-identity.supervisorPid, "SIGKILL");
      } else {
        await delay(Math.max(250, this.pollIntervalMs * 2));
        const before = await this.emptiness(identity);
        if (before === "identity_mismatch") throw new Error("Launch cleanup refused a recycled Windows descendant.");
        if (before === "outcome_unknown") throw new Error("Launch cleanup could not validate Windows descendants.");
        const state = readState(identity.directory);
        const sequence = (state?.handledControl ?? 0) + 1;
        writeFileSync(join(identity.directory, "control.json"), JSON.stringify({ nonce: identity.nonce, sequence, action: "force_terminate" }), { mode: 0o600 });
      }
    }
    const deadline = Date.now() + 3_000;
    const requiredStableMs = this.options.platform === "windows" ? 500 : 100;
    let emptySince: number | undefined;
    while (Date.now() < deadline) {
      const emptiness = await this.emptiness(identity);
      if (emptiness === "identity_mismatch") throw new Error("Launch cleanup observed a recycled owned identity.");
      if (emptiness === "outcome_unknown") throw new Error("Launch cleanup lost ownership verification.");
      if (emptiness === "empty") {
        emptySince ??= Date.now();
        if (Date.now() - emptySince >= requiredStableMs) return;
      } else emptySince = undefined;
      await delay(this.pollIntervalMs);
    }
    throw new Error("Launch cleanup did not produce verified emptiness before its deadline.");
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
  private async waitForState(directory: string, nonce: string, pid: number, timeoutMs: number): Promise<SupervisorState> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = readState(directory);
      if (state && state.nonce === nonce && state.supervisorPid === pid) return state;
      if (!pidAlive(pid)) throw new Error("Portable process supervisor exited before proving launch.");
      await delay(this.pollIntervalMs);
    }
    throw new Error("Portable process supervisor startup timed out.");
  }
  private async waitForBirth(pid: number, timeoutMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const birth = this.operations.processBirth(pid, this.options.platform);
      if (birth) return birth;
      if (!pidAlive(pid)) return undefined;
      await delay(this.pollIntervalMs);
    }
    return undefined;
  }
}

function readState(directory: string): SupervisorState | undefined {
  try { return JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as SupervisorState; } catch { return undefined; }
}
function osProcessBirth(pid: number, platform: "posix" | "windows"): string | undefined {
  try {
    if (platform === "windows") {
      return execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$p=Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction SilentlyContinue;if($p){$p.CreationDate.ToUniversalTime().ToString('o')}`], { encoding: "utf8", windowsHide: true }).trim() || undefined;
    }
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).split(" ");
      return fields[19] ? `proc-start:${fields[19]}` : undefined;
    } catch {
      return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim() || undefined;
    }
  } catch { return undefined; }
}
function osPosixGroupMembers(groupId: number): number[] | undefined {
  try {
    return execFileSync("ps", ["-e", "-o", "pid=,pgid="], { encoding: "utf8" })
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
  processBirth: osProcessBirth,
  listPosixGroup: osPosixGroupMembers,
  signal: (pid, signal) => process.kill(pid, signal),
};
