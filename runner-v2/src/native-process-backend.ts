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
  readonly knownPids: number[];
  readonly error: string | null;
  readonly updatedAt: string;
}
class OwnedProcessIdentityMismatchError extends Error {}

export class NativeOwnedProcessBackend implements ProcessBackend {
  private readonly stateDirectory: string;
  private readonly pollIntervalMs: number;
  private readonly outputOffsets = new Map<string, { stdout: number; stderr: number }>();
  constructor(private readonly options: NativeOwnedProcessBackendOptions) {
    this.stateDirectory = resolve(options.stateDirectory ?? join(tmpdir(), "aiboard-portable-processes"));
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
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
    try {
      const state = await this.waitForState(directory, nonce, child.pid, 5_000);
      if (state.status !== "running") throw new Error(state.error ?? "Portable process launch failed.");
      const supervisorBirth = processBirth(child.pid, this.options.platform);
      if (!supervisorBirth) throw new Error("Portable supervisor birth identity is unavailable.");
      const startedAt = state.updatedAt;
      const identity: Identity = {
        version: 1,
        backendId: this.options.backendId,
        nonce,
        directory,
        supervisorPid: child.pid,
        supervisorBirth,
      };
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
      try { process.kill(child.pid, "SIGKILL"); } catch {}
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
    if (validation === "exited")
      return (await this.isEmpty(identity)) ? { state: "exited" } : { state: "running" };
    if (this.options.platform === "posix") {
      const signal = action === "force_terminate" ? "SIGKILL" : action === "interrupt" ? "SIGINT" : "SIGTERM";
      process.kill(-identity.supervisorPid, signal);
    } else {
      const state = readState(identity.directory);
      const sequence = (state?.handledControl ?? 0) + 1;
      writeFileSync(join(identity.directory, "control.json"), JSON.stringify({ nonce: identity.nonce, sequence, action }), { mode: 0o600 });
    }
    await delay(action === "force_terminate" ? 250 : 75);
    return (await this.isEmpty(identity)) ? { state: "exited" } : { state: "running" };
  }

  async verifyEmpty(binding: ProcessBackendBinding, _fence?: ProcessEffectFence): Promise<unknown> {
    const identity = this.identity(binding);
    if (this.validate(identity) === "mismatch")
      return { empty: false, detail: "Owned process identity changed before quiescence verification." };
    return (await this.isEmpty(identity))
      ? { empty: true, proofArtifactId: `native-empty:${identity.nonce}` }
      : { empty: false, detail: "Owned process group/tree still has live members." };
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
    if (validation === "live" || !(await this.isEmpty(identity))) return { state: "running" };
    return {
      state: "exited",
      ...(state.exitCode === null ? {} : { exitCode: state.exitCode }),
      ...(state.signal ? { signal: state.signal } : {}),
    };
  }

  async release(binding: ProcessBackendBinding, _fence?: ProcessEffectFence): Promise<unknown> {
    const identity = this.identity(binding);
    if (!(await this.isEmpty(identity))) throw new Error("Cannot release non-empty owned process identity.");
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
    const current = processBirth(identity.supervisorPid, this.options.platform);
    if (!current) return "exited";
    return current === identity.supervisorBirth ? "live" : "mismatch";
  }
  private async isEmpty(identity: Identity): Promise<boolean> {
    if (this.options.platform === "posix") return posixGroupMembers(identity.supervisorPid).length === 0;
    const state = readState(identity.directory);
    return !state || state.knownPids.every((pid) => !pidAlive(pid));
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
}

function readState(directory: string): SupervisorState | undefined {
  try { return JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as SupervisorState; } catch { return undefined; }
}
function processBirth(pid: number, platform: "posix" | "windows"): string | undefined {
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
function posixGroupMembers(groupId: number): number[] {
  try {
    return execFileSync("ps", ["-o", "pid=", "-g", String(groupId)], { encoding: "utf8" }).split(/\s+/).map(Number).filter((pid) => pid > 0);
  } catch { return []; }
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
