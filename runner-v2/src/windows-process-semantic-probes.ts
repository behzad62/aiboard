import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import type { InteractiveProcessChannel } from "./interactive-process-channel.js";
import {
  parseProcessEmptyVerification,
  parseProcessLaunchResult,
  parseProcessReconciliation,
  type ProcessBackendBinding,
  type ProcessEffectFence,
  type ProcessLaunchRequest,
} from "./process-backend.js";
import type { ProcessHostSemanticProbeSource } from "./process-host-semantic-probes.js";
import { WindowsProcessBackend } from "./windows-process-backend.js";

const PROBE_DEADLINE_MS = 15_000;
const FENCE: ProcessEffectFence = Object.freeze({ ownerId: "windows-semantic-probe", fencingToken: 1 });
const WINDOWS_PROBE_ENVIRONMENT_KEYS = Object.freeze([
  "SystemRoot",
  "windir",
  "ComSpec",
  "Path",
  "PATHEXT",
  "TEMP",
  "TMP",
] as const);

/** Build the complete environment encoded into a semantic-probe supervisor request. */
export function minimalWindowsSemanticProbeEnvironment(
  inherited: Readonly<Record<string, string | undefined>> = process.env,
  explicit: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const environment: Record<string, string> = {};
  const inheritedEntries = Object.entries(inherited);
  for (const canonicalName of WINDOWS_PROBE_ENVIRONMENT_KEYS) {
    const entry = inheritedEntries.find(([name, value]) =>
      name.toLowerCase() === canonicalName.toLowerCase() && typeof value === "string" && value.length > 0);
    if (entry) environment[canonicalName] = entry[1]!;
  }
  return { ...environment, ...explicit };
}

/** Live, independently callable Windows probes. Callers should cache their settled facts. */
export function createWindowsProcessSemanticProbeSource(options: { readonly deadlineMs?: number } = {}): Pick<ProcessHostSemanticProbeSource,
  "portableDuplex" | "windowsBatchArgv" | "exactTreeBirth"> {
  // Each portable fixture performs Windows process inventory. Serialize the
  // one-time probes so capability discovery cannot create an inventory storm.
  let tail = Promise.resolve();
  const serialize = <T>(probe: () => Promise<T>): Promise<T> => {
    const result = tail.then(probe);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  return Object.freeze({
    portableDuplex: async () => await serialize(async () => await probePortableDuplex(options.deadlineMs ?? PROBE_DEADLINE_MS)),
    windowsBatchArgv: async () => await serialize(async () => await probeWindowsBatchArgv(options.deadlineMs ?? PROBE_DEADLINE_MS)),
    exactTreeBirth: async () => await serialize(async () => await probeExactTreeBirth(options.deadlineMs ?? PROBE_DEADLINE_MS)),
  });
}

async function probePortableDuplex(deadlineMs: number): Promise<boolean> {
  return await withPortableProbe("duplex", deadlineMs, async ({ backend, workspace, own }) => {
    const launch = parseProcessLaunchResult(await backend.launch(request(
      workspace,
      process.execPath,
      ["-e", "process.stdin.on('data',b=>process.stdout.write(Buffer.concat([Buffer.from('probe:'),b])));process.stdin.on('end',()=>process.exit(0))"],
    )));
    const binding = own(bindingFor(launch));
    const channel = await backend.backpressuredChannelProvider().acquire(binding, FENCE);
    let attached: InteractiveProcessChannel | undefined = channel;
    const received: Buffer[] = [];
    try {
      channel.subscribeBackpressuredOutput(async (metadata, bytes) => {
        if (metadata.stream === "stdout") received.push(Buffer.from(bytes));
        return metadata;
      });
      const payload = Buffer.from("duplex-boundary");
      await channel.write({
        sequence: 1,
        byteLength: payload.byteLength,
        digest: (await import("node:crypto")).createHash("sha256").update(payload).digest("hex"),
        timeoutMs: PROBE_DEADLINE_MS,
      }, payload);
      await channel.closeInput();
      await waitForPortableTerminal(backend, binding, () =>
        Buffer.concat(received).equals(Buffer.from("probe:duplex-boundary")), deadlineMs);
      await channel.detach(); attached = undefined;
      await requireEmptyAndRelease(backend, binding, deadlineMs);
      return Buffer.concat(received).equals(Buffer.from("probe:duplex-boundary"));
    } finally {
      await attached?.detach().catch(() => undefined);
    }
  });
}

async function probeWindowsBatchArgv(deadlineMs: number): Promise<boolean> {
  return await withPortableProbe("batch", deadlineMs, async ({ backend, workspace, own }) => {
    const script = join(workspace, "capture-argv.mjs");
    const shim = join(workspace, "capture-argv.cmd");
    writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n", { mode: 0o600 });
    writeFileSync(shim, "@echo off\r\n\"%NODE_EXE%\" \"%PROBE_SCRIPT%\" %*\r\n", { mode: 0o600 });
    const expected = ["space value", "literal-value"];
    const launch = parseProcessLaunchResult(await backend.launch(request(workspace, shim, expected, {
      NODE_EXE: process.execPath,
      PROBE_SCRIPT: script,
    })));
    const binding = own(bindingFor(launch));
    const channel = await backend.backpressuredChannelProvider().acquire(binding, FENCE);
    let attached: InteractiveProcessChannel | undefined = channel;
    const stdout: Buffer[] = [];
    try {
      channel.subscribeBackpressuredOutput(async (metadata, bytes) => {
        if (metadata.stream === "stdout") stdout.push(Buffer.from(bytes));
        return metadata;
      });
      await waitForPortableTerminal(backend, binding, () => stdout.length > 0, deadlineMs);
      await channel.detach(); attached = undefined;
      await requireEmptyAndRelease(backend, binding, deadlineMs);
      return JSON.stringify(JSON.parse(Buffer.concat(stdout).toString("utf8"))) === JSON.stringify(expected);
    } finally {
      await attached?.detach().catch(() => undefined);
    }
  });
}

async function probeExactTreeBirth(deadlineMs: number): Promise<"partial" | false> {
  return await withPortableProbe<"partial" | false>("tree", deadlineMs, async ({ backend, workspace, own }) => {
    const child = "setTimeout(()=>process.exit(0),4000)";
    const parent = `const{spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});setTimeout(()=>process.exit(0),4000)`;
    const launch = parseProcessLaunchResult(await backend.launch(request(workspace, process.execPath, ["-e", parent])));
    const binding = own(bindingFor(launch));
    const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { directory: string };
    await waitForWindowsSemanticProbe(() => {
      try {
        const state = JSON.parse(readFileSync(join(identity.directory, "state.json"), "utf8")) as {
          rootProcess?: { pid: number; birth: string } | null;
          knownProcesses?: Array<{ pid: number; birth: string }>;
        };
        return Boolean(state.rootProcess?.birth) && (state.knownProcesses?.length ?? 0) >= 2 && state.knownProcesses!.every((entry) => entry.pid > 0 && entry.birth.length > 0);
      } catch { return false; }
    }, { deadlineMs });
    await backend.signal(binding, "force_terminate", FENCE);
    await requireEmptyAndRelease(backend, binding, deadlineMs);
    // The portable supervisor proves birth-tagged known members, but not global
    // OS containment, so the honest semantic level remains partial.
    return "partial";
  });
}

async function withPortableProbe<T>(name: string, cleanupDeadlineMs: number, action: (context: {
  backend: WindowsProcessBackend;
  workspace: string;
  own(binding: ProcessBackendBinding): ProcessBackendBinding;
}) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-windows-semantic-${name}-`));
  const stateDirectory = join(root, "state");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  // This backend exists only to measure the semantics themselves. The batch
  // probe is allowed through this private fixture path, and the resulting fact
  // is trusted by product construction only after exact argv output matches.
  const backend = new WindowsProcessBackend({
    stateDirectory,
    semanticFacts: {
      portableDuplex: "verified",
      windowsBatchArgv: "verified",
      exactTreeBirth: "partial",
      jobContainment: "unavailable",
    },
  });
  let binding: ProcessBackendBinding | undefined;
  let released = false;
  try {
    const value = await action({ backend, workspace, own: (owned) => (binding = owned) });
    released = true;
    return value;
  } finally {
    if (binding && !released) {
      await backend.signal(binding, "force_terminate", FENCE).catch(() => undefined);
      try {
        await requireEmptyAndRelease(backend, binding, cleanupDeadlineMs);
        released = true;
      } catch {
        try {
          await settleProbeOutput(backend, binding);
          await requireEmptyAndRelease(backend, binding, cleanupDeadlineMs);
          released = true;
        } catch {}
      }
    }
    if (released) rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
    else if (!binding) removeUnboundSemanticProbeRoot(root);
    else removeInactiveSemanticProbeRoot(root, binding);
  }
}

export function removeInactiveSemanticProbeRoot(root: string, binding: ProcessBackendBinding): boolean {
  const resolvedRoot = resolve(root);
  if (!validGeneratedProbeRoot(resolvedRoot)) return false;
  if (!probeEvidenceHasNoLiveOwners(resolvedRoot, binding)) return false;
  rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  return true;
}

export function removeUnboundSemanticProbeRoot(root: string): boolean {
  const resolvedRoot = resolve(root);
  if (!validGeneratedProbeRoot(resolvedRoot)) return false;
  try {
    if (readdirSync(join(resolvedRoot, "state"), { withFileTypes: true }).length !== 0) return false;
    rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
    return true;
  } catch { return false; }
}

function validGeneratedProbeRoot(root: string): boolean {
  try {
    const status = lstatSync(root);
    return dirname(root) === resolve(tmpdir()) && basename(root).startsWith("aiboard-windows-semantic-") &&
      status.isDirectory() && !status.isSymbolicLink();
  } catch { return false; }
}

function probeEvidenceHasNoLiveOwners(root: string, binding: ProcessBackendBinding): boolean {
  try {
    const identity = JSON.parse(Buffer.from(binding.opaqueIdentity, "base64url").toString("utf8")) as {
      directory: string;
      nonce: string;
      supervisorPid: number;
      supervisorBirth: string;
    };
    const directory = resolve(identity.directory);
    if (dirname(directory) !== resolve(root, "state") || !basename(directory).startsWith("owned-")) return false;
    if (!identity.nonce || !validProbeOwner(identity.supervisorPid, identity.supervisorBirth)) return false;
    const state = JSON.parse(readFileSync(join(identity.directory, "state.json"), "utf8")) as {
      nonce?: string;
      supervisorPid?: number;
      launchEffect?: string;
      rootProcess?: { pid: number; birth: string } | null;
      knownProcesses?: Array<{ pid: number; birth: string }>;
    };
    if (state.nonce !== identity.nonce || state.supervisorPid !== identity.supervisorPid ||
        !Array.isArray(state.knownProcesses) || state.knownProcesses.length > 256 ||
        !state.knownProcesses.every((process) => validProbeOwner(process.pid, process.birth))) return false;
    if (state.launchEffect === "not_started") {
      if (state.rootProcess !== null || state.knownProcesses.length !== 0) return false;
    } else if (state.launchEffect === "started") {
      if (!state.rootProcess || !validProbeOwner(state.rootProcess.pid, state.rootProcess.birth) ||
          !state.knownProcesses.some((process) => process.pid === state.rootProcess!.pid && sameProbeBirth(process.birth, state.rootProcess!.birth))) return false;
    } else return false;
    const expected = new Map<number, string>([[identity.supervisorPid, identity.supervisorBirth]]);
    const addExpected = (pid: number, birth: string): boolean => {
      const prior = expected.get(pid);
      if (prior && !sameProbeBirth(prior, birth)) return false;
      expected.set(pid, birth);
      return true;
    };
    if (state.rootProcess && !addExpected(state.rootProcess.pid, state.rootProcess.birth)) return false;
    for (const process of state.knownProcesses) if (!addExpected(process.pid, process.birth)) return false;
    const filter = [...expected.keys()].map((pid) => `ProcessId = ${pid}`).join(" OR ");
    const output = execFileSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference='Stop';Get-CimInstance Win32_Process -Filter '${filter}'|ForEach-Object{if($null -eq $_.CreationDate){throw 'missing birth'};\"$($_.ProcessId),$($_.CreationDate.ToUniversalTime().ToString('o'))\"};'OK'`,
    ], { encoding: "utf8", windowsHide: true, timeout: 2_000 }).trim();
    const lines = output.split(/\r?\n/);
    if (lines.pop()?.trim() !== "OK") return false;
    const current = new Map<number, string>();
    for (const line of lines) {
      const [pidText, birth, ...extra] = line.trim().split(",");
      const pid = Number(pidText);
      if (extra.length || !validProbeOwner(pid, birth)) return false;
      current.set(pid, birth!);
    }
    for (const [pid, birth] of expected) {
      const observed = current.get(pid);
      if (observed && sameProbeBirth(observed, birth)) return false;
    }
    return true;
  } catch { return false; }
}

function validProbeOwner(pid: unknown, birth: unknown): birth is string {
  return Number.isSafeInteger(pid) && Number(pid) > 0 && typeof birth === "string" && birth.length > 0;
}

function sameProbeBirth(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/(\.\d{6})\d+(Z)$/, "$1$2");
  return normalize(left) === normalize(right);
}

async function settleProbeOutput(backend: WindowsProcessBackend, binding: ProcessBackendBinding): Promise<void> {
  const channel = await backend.backpressuredChannelProvider().acquire(binding, FENCE);
  try {
    channel.subscribeBackpressuredOutput(async (metadata) => metadata);
    await waitForPortableTerminal(backend, binding, () => true, PROBE_DEADLINE_MS);
  } finally {
    await channel.detach().catch(() => undefined);
  }
}

export async function requireEmptyAndRelease(backend: WindowsProcessBackend, binding: ProcessBackendBinding, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let lastReleaseError: unknown;
  for (;;) {
    if (parseProcessEmptyVerification(await backend.verifyEmpty(binding, FENCE)).empty) {
      try { await backend.release(binding, FENCE); return; }
      catch (error) {
        if (/stale|identity|fence/i.test(String(error))) throw error;
        lastReleaseError = error;
      }
    }
    if (Date.now() >= deadline)
      throw new Error(`Windows semantic probe timed out waiting for stable empty release${lastReleaseError ? `: ${String(lastReleaseError)}` : "."}`);
    await delayProbePoll();
  }
}

async function waitForPortableTerminal(
  backend: WindowsProcessBackend,
  binding: ProcessBackendBinding,
  outputSettled: () => boolean,
  deadlineMs: number,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const terminal = parseProcessReconciliation(await backend.reconcile(binding, FENCE));
    if (terminal.state === "exited" && outputSettled()) return;
    if (terminal.state === "identity_mismatch" || terminal.state === "outcome_unknown")
      throw new Error(`Windows semantic probe reached ${terminal.state}.`);
    if (Date.now() >= deadline) throw new Error("Windows semantic probe timed out waiting for terminal output.");
    await delayProbePoll();
  }
}

function request(workspace: string, executable: string, args: readonly string[], extraEnvironment: Readonly<Record<string, string>> = {}): ProcessLaunchRequest {
  const invocationId = `windows-semantic-${randomUUID()}`;
  return {
    intent: {
      invocationId,
      runId: "windows-semantic-probe",
      kind: "command",
      executable,
      arguments: [...args],
      workingDirectory: workspace,
      requestedCapabilities: ["tree_termination", "verified_emptiness"],
    },
    grant: { grantId: randomUUID(), runId: "windows-semantic-probe", invocationId, issuedAt: new Date().toISOString(), access: [] },
    environment: minimalWindowsSemanticProbeEnvironment(process.env, extraEnvironment),
    outputOwnerId: "windows-semantic-probe",
    fence: FENCE,
  };
}

function bindingFor(launch: ReturnType<typeof parseProcessLaunchResult>): ProcessBackendBinding {
  return {
    registryId: "windows-semantic-probe",
    backendId: "runner-windows-supervisor-v1",
    implementationGeneration: "probe",
    implementationDigest: "1".repeat(64),
    attestationVersion: 1,
    attestationDigest: "2".repeat(64),
    ...launch,
  };
}

export async function waitForWindowsSemanticProbe(
  predicate: () => boolean,
  options: { readonly deadlineMs?: number; readonly signal?: AbortSignal } = {},
): Promise<void> {
  const deadline = Date.now() + (options.deadlineMs ?? PROBE_DEADLINE_MS);
  while (!predicate()) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Windows semantic probe was aborted.");
    if (Date.now() >= deadline) throw new Error("Windows semantic probe timed out.");
    await new Promise<void>((resolve, reject) => {
      const finish = () => { options.signal?.removeEventListener("abort", abort); resolve(); };
      const timer = setTimeout(finish, 25);
      const abort = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); reject(options.signal?.reason ?? new Error("Windows semantic probe was aborted.")); };
      options.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

async function delayProbePoll(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
}
