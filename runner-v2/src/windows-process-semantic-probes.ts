import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  inherited: Readonly<Record<string, string | undefined>> = {},
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
export function createWindowsProcessSemanticProbeSource(options: { readonly deadlineMs?: number; readonly cleanupDeadlineMs?: number; readonly ambientEnvironment?: Readonly<Record<string, string | undefined>> } = {}): Pick<ProcessHostSemanticProbeSource,
  "portableDuplex" | "windowsBatchArgv" | "exactTreeBirth"> {
  // Each portable fixture performs Windows process inventory. Serialize the
  // one-time probes so capability discovery cannot create an inventory storm.
  let tail = Promise.resolve();
  const serialize = <T>(probe: () => Promise<T>): Promise<T> => {
    const result = tail.then(probe);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const cleanupDeadlineMs = options.cleanupDeadlineMs ?? PROBE_DEADLINE_MS;
  const ambientEnvironment = options.ambientEnvironment ?? {};
  return Object.freeze({
    portableDuplex: async () => await serialize(async () => await probePortableDuplex(options.deadlineMs ?? PROBE_DEADLINE_MS, cleanupDeadlineMs, ambientEnvironment)),
    windowsBatchArgv: async () => await serialize(async () => await probeWindowsBatchArgv(options.deadlineMs ?? PROBE_DEADLINE_MS, cleanupDeadlineMs, ambientEnvironment)),
    exactTreeBirth: async () => await serialize(async () => await probeExactTreeBirth(options.deadlineMs ?? PROBE_DEADLINE_MS, cleanupDeadlineMs, ambientEnvironment)),
  });
}

function remainingProbeDeadlineMs(deadline: number): number {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining < 1) throw new Error("Windows semantic probe timed out.");
  return remaining;
}

async function probePortableDuplex(deadlineMs: number, cleanupDeadlineMs: number, ambientEnvironment: Readonly<Record<string, string | undefined>>): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  remainingProbeDeadlineMs(deadline);
  return await withPortableProbe("duplex", deadline, cleanupDeadlineMs, async ({ backend, workspace, own }) => {
    const launch = parseProcessLaunchResult(await backend.launch(request(
      workspace,
      process.execPath,
      ["-e", "process.stdin.on('data',b=>process.stdout.write(Buffer.concat([Buffer.from('probe:'),b])));process.stdin.on('end',()=>process.exit(0))"],
      ambientEnvironment,
    )));
    const binding = own(bindingFor(launch));
    remainingProbeDeadlineMs(deadline);
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
        timeoutMs: remainingProbeDeadlineMs(deadline),
      }, payload);
      await channel.closeInput();
      remainingProbeDeadlineMs(deadline);
      await waitForPortableTerminal(backend, binding, () =>
        Buffer.concat(received).equals(Buffer.from("probe:duplex-boundary")), remainingProbeDeadlineMs(deadline));
      await channel.detach(); attached = undefined;
      await requireEmptyAndRelease(backend, binding, remainingProbeDeadlineMs(deadline));
      return Buffer.concat(received).equals(Buffer.from("probe:duplex-boundary"));
    } finally {
      await attached?.detach().catch(() => undefined);
    }
  });
}

async function probeWindowsBatchArgv(deadlineMs: number, cleanupDeadlineMs: number, ambientEnvironment: Readonly<Record<string, string | undefined>>): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  remainingProbeDeadlineMs(deadline);
  return await withPortableProbe("batch", deadline, cleanupDeadlineMs, async ({ backend, workspace, own }) => {
    const script = join(workspace, "capture-argv.mjs");
    const shim = join(workspace, "capture-argv.cmd");
    writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n", { mode: 0o600 });
    writeFileSync(shim, "@echo off\r\n\"%NODE_EXE%\" \"%PROBE_SCRIPT%\" %*\r\n", { mode: 0o600 });
    const expected = ["space value", "literal-value"];
    const launch = parseProcessLaunchResult(await backend.launch(request(workspace, shim, expected, ambientEnvironment, {
      NODE_EXE: process.execPath,
      PROBE_SCRIPT: script,
    })));
    const binding = own(bindingFor(launch));
    remainingProbeDeadlineMs(deadline);
    const channel = await backend.backpressuredChannelProvider().acquire(binding, FENCE);
    let attached: InteractiveProcessChannel | undefined = channel;
    const stdout: Buffer[] = [];
    try {
      channel.subscribeBackpressuredOutput(async (metadata, bytes) => {
        if (metadata.stream === "stdout") stdout.push(Buffer.from(bytes));
        return metadata;
      });
      await waitForPortableTerminal(backend, binding, () => stdout.length > 0, remainingProbeDeadlineMs(deadline));
      await channel.detach(); attached = undefined;
      await requireEmptyAndRelease(backend, binding, remainingProbeDeadlineMs(deadline));
      return JSON.stringify(JSON.parse(Buffer.concat(stdout).toString("utf8"))) === JSON.stringify(expected);
    } finally {
      await attached?.detach().catch(() => undefined);
    }
  });
}

async function probeExactTreeBirth(deadlineMs: number, cleanupDeadlineMs: number, ambientEnvironment: Readonly<Record<string, string | undefined>>): Promise<"partial" | false> {
  const deadline = Date.now() + deadlineMs;
  remainingProbeDeadlineMs(deadline);
  return await withPortableProbe<"partial" | false>("tree", deadline, cleanupDeadlineMs, async ({ backend, workspace, own }) => {
    const child = "setTimeout(()=>process.exit(0),4000)";
    const parent = `const{spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});setTimeout(()=>process.exit(0),4000)`;
    const launch = parseProcessLaunchResult(await backend.launch(request(workspace, process.execPath, ["-e", parent], ambientEnvironment)));
    const binding = own(bindingFor(launch));
    remainingProbeDeadlineMs(deadline);
    const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { directory: string };
    await waitForWindowsSemanticProbe(() => {
      try {
        const state = JSON.parse(readFileSync(join(identity.directory, "state.json"), "utf8")) as {
          rootProcess?: { pid: number; birth: string } | null;
          knownProcesses?: Array<{ pid: number; birth: string }>;
        };
        return Boolean(state.rootProcess?.birth) && (state.knownProcesses?.length ?? 0) >= 2 && state.knownProcesses!.every((entry) => entry.pid > 0 && entry.birth.length > 0);
      } catch { return false; }
    }, { deadlineMs: remainingProbeDeadlineMs(deadline) });
    // This fact attests birth-tagged ownership, not destructive-control
    // throughput. Let the bounded fixture exit normally so the probe measures
    // the independent tree/re-attestation contract without contending on a
    // second synchronous Windows inventory during capability discovery.
    await waitForPortableTerminal(backend, binding, () => true, remainingProbeDeadlineMs(deadline));
    await requireEmptyAndRelease(backend, binding, remainingProbeDeadlineMs(deadline));
    // The portable supervisor proves birth-tagged known members, but not global
    // OS containment, so the honest semantic level remains partial.
    return "partial";
  });
}

async function withPortableProbe<T>(name: string, operationDeadline: number, cleanupDeadlineMs: number, action: (context: {
  backend: WindowsProcessBackend;
  workspace: string;
  own(binding: ProcessBackendBinding): ProcessBackendBinding;
}) => Promise<T>): Promise<T> {
  // Initialize and validate the Windows inventory provider before the random
  // root exists. Protected provider helpers created by this query then have an
  // immutable birth strictly before the root rather than becoming an
  // unresolvable post-root process during cleanup.
  try { probeGlobalProcessInventory(remainingProbeDeadlineMs(operationDeadline)); }
  catch (error) {
    if (Date.now() >= operationDeadline || (error as NodeJS.ErrnoException).code === "ETIMEDOUT" ||
        (error as NodeJS.ErrnoException & { signal?: unknown }).signal)
      throw new Error("Windows semantic probe timed out.", { cause: error });
    throw error;
  }
  remainingProbeDeadlineMs(operationDeadline);
  const root = mkdtempSync(join(tmpdir(), `aiboard-windows-semantic-${name}-`));
  const stateDirectory = join(root, "state");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  // This backend exists only to measure the semantics themselves. The batch
  // probe is allowed through this private fixture path, and the resulting fact
  // is trusted by product construction only after exact argv output matches.
  const backend = new WindowsProcessBackend({
    stateDirectory,
    startupDeadlineAt: operationDeadline,
    semanticFacts: {
      portableDuplex: "verified",
      windowsBatchArgv: "verified",
      exactTreeBirth: "partial",
      jobContainment: "unavailable",
    },
  });
  let binding: ProcessBackendBinding | undefined;
  let released = false;
  let primaryError: unknown;
  try {
    const value = await action({ backend, workspace, own: (owned) => (binding = owned) });
    released = true;
    return value;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (binding && !released) {
      try { await backend.signal(binding, "force_terminate", FENCE); }
      catch (error) { cleanupErrors.push(error); }
      try {
        // The portable supervisor intentionally retains ownership until every
        // durable output chunk is acknowledged.  Settle that output before
        // waiting for terminal emptiness; reversing these two operations can
        // consume the entire cleanup budget in a dependency deadlock.
        await settleProbeOutput(backend, binding, cleanupDeadlineMs);
        await requireEmptyAndRelease(backend, binding, cleanupDeadlineMs);
        released = true;
      } catch (error) {
        cleanupErrors.push(error);
        try {
          await requireEmptyAndRelease(backend, binding, cleanupDeadlineMs);
          released = true;
        } catch (settleError) { cleanupErrors.push(settleError); }
      }
    }
    if (released) rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
    else if (!binding) {
      if (!removeUnboundSemanticProbeRoot(root)) {
        const blocker = new Error(`Windows semantic probe cleanup preserved unbound launch evidence at ${root}.`);
        throw new AggregateError(
          [...(primaryError === undefined ? [] : [primaryError]), blocker],
          `Windows semantic probe failed before binding and exact cleanup could not be verified${primaryError === undefined ? "." : `: ${String(primaryError)}`}`,
          { ...(primaryError === undefined ? {} : { cause: primaryError }) },
        );
      }
    } else if (!removeInactiveSemanticProbeRoot(root, binding, { deadlineMs: cleanupDeadlineMs })) {
      const blocker = new Error(`Windows semantic probe cleanup preserved uncertain evidence at ${root}.`);
      throw new AggregateError(
        [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors, blocker],
        `Windows semantic probe failed and exact cleanup could not be verified${primaryError === undefined ? "." : `: ${String(primaryError)}`}`,
        { ...(primaryError === undefined ? {} : { cause: primaryError }) },
      );
    }
  }
}

export interface SemanticProbeCleanupOperations {
  readonly deadlineMs?: number;
  readonly now?: () => number;
  readonly globalInventory?: (remainingMs: number) => readonly GlobalProbeProcess[];
  readonly processInventory?: (pids: readonly number[], remainingMs: number) => readonly ProbeProcess[];
  readonly taskkill?: (pid: number, remainingMs: number) => void;
  readonly wait?: (milliseconds: number) => void;
}

export function removeInactiveSemanticProbeRoot(root: string, binding: ProcessBackendBinding, operations: SemanticProbeCleanupOperations = {}): boolean {
  const resolvedRoot = resolve(root);
  if (!validGeneratedProbeRoot(resolvedRoot)) return false;
  const now = operations.now ?? Date.now;
  const deadlineMs = operations.deadlineMs ?? PROBE_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) return false;
  const budget: CleanupBudget = { deadline: now() + deadlineMs, now };
  const ownership = inspectProbeOwnership(resolvedRoot, binding, operations, budget);
  if (!ownership) {
    const exactSupervisor = inspectAuthenticatedProbeSupervisor(resolvedRoot, binding);
    if (exactSupervisor)
      stopExactProbeSupervisor(resolvedRoot, { identity: exactSupervisor, supervisorLive: true, foreignReference: true }, operations, budget);
    // Invalid descendant/closure evidence can authorize stopping only the
    // independently authenticated Runner supervisor. It can never authorize
    // deleting the evidence root.
    return false;
  }
  if (ownership.supervisorLive) {
    if (!stopExactProbeSupervisor(resolvedRoot, ownership, operations, budget)) return false;
  }
  if (!probeEvidenceHasNoLiveOwners(resolvedRoot, binding, operations, budget)) return false;
  try { remainingCleanupMs(budget); } catch { return false; }
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

interface CleanupBudget { readonly deadline: number; readonly now: () => number }
interface ProbeProcess { readonly pid: number; readonly birth: string; readonly commandLine: string }
const MAX_ENCODED_REFERENCE_CANDIDATES = 256;
const MAX_ENCODED_REFERENCE_CHARS = 64 * 1024;
const MAX_DECODED_REFERENCE_BYTES = 64 * 1024;

function remainingCleanupMs(budget: CleanupBudget): number {
  const remaining = Math.floor(budget.deadline - budget.now());
  if (remaining < 1) throw new Error("Windows semantic cleanup exhausted its absolute deadline.");
  return remaining;
}

function probeEvidenceHasNoLiveOwners(root: string, binding: ProcessBackendBinding, operations: SemanticProbeCleanupOperations, budget: CleanupBudget): boolean {
  const ownership = inspectProbeOwnership(root, binding, operations, budget);
  return Boolean(ownership && !ownership.supervisorLive && !ownership.foreignReference);
}

interface ProbeSupervisorIdentity {
  readonly directory: string;
  readonly nonce: string;
  readonly supervisorPid: number;
  readonly supervisorBirth: string;
}

interface ProbeOwnershipInspection {
  readonly identity: ProbeSupervisorIdentity;
  readonly supervisorLive: boolean;
  readonly foreignReference: boolean;
}

function inspectAuthenticatedProbeSupervisor(root: string, binding: ProcessBackendBinding): ProbeSupervisorIdentity | undefined {
  try {
    const identity = JSON.parse(Buffer.from(binding.opaqueIdentity, "base64url").toString("utf8")) as ProbeSupervisorIdentity & {
      version?: number;
      backendId?: string;
      fence?: ProcessEffectFence;
    };
    const directory = resolve(identity.directory);
    if (identity.version !== 1 || identity.backendId !== "runner-windows-supervisor-v1" ||
        binding.backendId !== identity.backendId || binding.rootPid !== identity.supervisorPid ||
        dirname(directory) !== resolve(root, "state") || !basename(directory).startsWith("owned-") ||
        !identity.nonce || !validProbeOwner(identity.supervisorPid, identity.supervisorBirth) ||
        !identity.fence?.ownerId || !Number.isSafeInteger(identity.fence.fencingToken) || identity.fence.fencingToken < 1)
      return undefined;
    const expectedDiscriminator = createHash("sha256").update(`${identity.nonce}\0${identity.supervisorBirth}`).digest("hex");
    if (binding.birthFingerprint.discriminator !== expectedDiscriminator) return undefined;
    const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as {
      protocol?: string; nonce?: string; supervisorPid?: number;
    };
    const holder = JSON.parse(readFileSync(join(directory, "lock-holder.json"), "utf8")) as {
      nonce?: string; holderPid?: number; holderBirth?: string;
    };
    const fence = JSON.parse(readFileSync(join(directory, "fence.json"), "utf8")) as {
      nonce?: string; ownerId?: string; fencingToken?: number;
    };
    if (state.protocol !== "aiboard-portable-process/v1" || state.nonce !== identity.nonce || state.supervisorPid !== identity.supervisorPid ||
        holder.nonce !== identity.nonce || holder.holderPid !== identity.supervisorPid ||
        !sameProbeBirth(holder.holderBirth ?? "", identity.supervisorBirth) ||
        fence.nonce !== identity.nonce || fence.ownerId !== identity.fence.ownerId ||
        fence.fencingToken !== identity.fence.fencingToken)
      return undefined;
    return { directory, nonce: identity.nonce, supervisorPid: identity.supervisorPid, supervisorBirth: identity.supervisorBirth };
  } catch { return undefined; }
}

function inspectProbeOwnership(root: string, binding: ProcessBackendBinding, operations: SemanticProbeCleanupOperations, budget: CleanupBudget): ProbeOwnershipInspection | undefined {
  try {
    const rootCreatedAt = exactProbeRootCreationTime(root);
    const identity = JSON.parse(Buffer.from(binding.opaqueIdentity, "base64url").toString("utf8")) as {
      directory: string;
      nonce: string;
      supervisorPid: number;
      supervisorBirth: string;
    };
    const directory = resolve(identity.directory);
    if (dirname(directory) !== resolve(root, "state") || !basename(directory).startsWith("owned-")) return undefined;
    if (!identity.nonce || !validProbeOwner(identity.supervisorPid, identity.supervisorBirth)) return undefined;
    const state = JSON.parse(readFileSync(join(identity.directory, "state.json"), "utf8")) as {
      nonce?: string;
      supervisorPid?: number;
      launchEffect?: string;
      rootProcess?: { pid: number; birth: string } | null;
      knownProcesses?: Array<{ pid: number; birth: string }>;
    };
    if (state.nonce !== identity.nonce || state.supervisorPid !== identity.supervisorPid ||
        !Array.isArray(state.knownProcesses) || state.knownProcesses.length > 256 ||
        !state.knownProcesses.every((process) => validProbeOwner(process.pid, process.birth))) return undefined;
    if (state.launchEffect === "not_started") {
      if (state.rootProcess !== null || state.knownProcesses.length !== 0) return undefined;
    } else if (state.launchEffect === "started") {
      if (!state.rootProcess || !validProbeOwner(state.rootProcess.pid, state.rootProcess.birth) ||
          !state.knownProcesses.some((process) => process.pid === state.rootProcess!.pid && sameProbeBirth(process.birth, state.rootProcess!.birth))) return undefined;
    } else return undefined;
    const exactKnownProcesses = state.knownProcesses.filter((process) =>
      !state.rootProcess || probeBirthTime(process.birth) >= probeBirthTime(state.rootProcess.birth));
    const expected = [
      { pid: identity.supervisorPid, birth: identity.supervisorBirth, supervisor: true },
      ...(state.rootProcess ? [{ ...state.rootProcess, supervisor: false }] : []),
      ...exactKnownProcesses.map((process) => ({ ...process, supervisor: false })),
    ];
    const remainingMs = remainingCleanupMs(budget);
    const current = validateGlobalProbeProcessInventory(operations.globalInventory?.(remainingMs) ?? probeGlobalProcessInventory(remainingMs));
    remainingCleanupMs(budget);
    let supervisorLive = false;
    let foreignReference = false;
    for (const process of current) {
      const executableReferencesRoot = process.executableAccessible && probeTextReferencesRoot(process.executable, root);
      const commandReferencesRoot = process.commandLineAccessible && probeTextReferencesRoot(process.commandLine, root);
      if (executableReferencesRoot || commandReferencesRoot) foreignReference = true;
      const matches = expected.filter((candidate) => candidate.pid === process.pid && sameProbeBirth(candidate.birth, process.birth));
      if ((!process.executableAccessible || !process.commandLineAccessible) && !(probeBirthTime(process.birth) < rootCreatedAt)) {
        // Unreadable post-root metadata makes global deletion closure unknown,
        // but it does not invalidate independent proof for a different exact
        // supervisor. Preserve the root while still allowing only that
        // birth-and-command-authenticated supervisor to be stopped.
        if (matches.some((candidate) => candidate.supervisor)) return undefined;
        foreignReference = true;
      }
      if (matches.some((candidate) => candidate.supervisor)) {
        if (!process.commandLineAccessible || !probeTextReferencesRoot(process.commandLine, root)) return undefined;
        supervisorLive = true;
        continue;
      }
      if (matches.length > 0) foreignReference = true;
    }
    return { identity, supervisorLive, foreignReference };
  } catch { return undefined; }
}

function stopExactProbeSupervisor(root: string, ownership: ProbeOwnershipInspection, operations: SemanticProbeCleanupOperations, budget: CleanupBudget): boolean {
  try {
    const inventory = operations.processInventory ?? probeProcessInventory;
    const current = inventory([ownership.identity.supervisorPid], remainingCleanupMs(budget));
    remainingCleanupMs(budget);
    if (current.length !== 1 || !sameProbeBirth(current[0]!.birth, ownership.identity.supervisorBirth) ||
        !probeCommandReferencesRoot(current[0]!.commandLine, root)) return false;
    const remainingMs = remainingCleanupMs(budget);
    if (operations.taskkill) operations.taskkill(ownership.identity.supervisorPid, remainingMs);
    else execFileSync("taskkill.exe", ["/PID", String(ownership.identity.supervisorPid), "/T", "/F"], {
      windowsHide: true, stdio: "ignore", timeout: remainingMs,
    });
    remainingCleanupMs(budget);
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      const after = inventory([ownership.identity.supervisorPid], remainingCleanupMs(budget));
      remainingCleanupMs(budget);
      if (after.every((process) => !sameProbeBirth(process.birth, ownership.identity.supervisorBirth))) return true;
      const waitMs = Math.min(25, remainingCleanupMs(budget));
      if (operations.wait) operations.wait(waitMs); else Atomics.wait(waiter, 0, 0, waitMs);
    }
  } catch { return false; }
}

function probeProcessInventory(pids: readonly number[], timeoutMs: number): ProbeProcess[] {
  if (pids.length === 0 || pids.length > 258 || pids.some((pid) => !Number.isSafeInteger(pid) || pid < 1)) throw new Error("Invalid probe process inventory.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid probe process inventory deadline.");
  const filter = pids.map((pid) => `ProcessId = ${pid}`).join(" OR ");
  const output = execFileSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop';Get-CimInstance Win32_Process -Filter '${filter}'|ForEach-Object{if($null-eq$_.CreationDate){throw 'missing birth'};$c=if($null-eq$_.CommandLine){''}else{$_.CommandLine};$j=@{pid=[int]$_.ProcessId;birth=$_.CreationDate.ToUniversalTime().ToString('o');commandLine=$c}|ConvertTo-Json -Compress;[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))}`,
  ], { encoding: "utf8", windowsHide: true, timeout: timeoutMs }).trim();
  return output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(Buffer.from(line, "base64").toString("utf8")));
}

export interface GlobalProbeProcess {
  readonly pid: number;
  readonly birth: string;
  readonly parentPid: number;
  readonly executableAccessible: boolean;
  readonly commandLineAccessible: boolean;
  readonly executable: string;
  readonly commandLine: string;
}

function probeGlobalProcessInventory(timeoutMs: number): GlobalProbeProcess[] {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid global process inventory deadline.");
  const output = execFileSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop';$p=@(Get-CimInstance Win32_Process);if($p.Count -lt 1 -or $p.Count -gt 4096){throw 'invalid process count'};$tab=[char]9;foreach($x in $p){if($null-eq$x.CreationDate){throw 'missing birth'};$ea=if($null-eq$x.ExecutablePath){0}else{1};$e=if($ea-eq0){''}else{[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$x.ExecutablePath))};$ca=if($null-eq$x.CommandLine){0}else{1};$c=if($ca-eq0){''}else{[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$x.CommandLine))};"$([int]$x.ProcessId)$tab$($x.CreationDate.ToUniversalTime().ToString('o'))$tab$([int]$x.ParentProcessId)$tab$ea$tab$e$tab$ca$tab$c"};"COMPLETE:$($p.Count)"`,
  ], { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }).trim();
  const lines = output.split(/\r?\n/).filter(Boolean);
  const completion = /^COMPLETE:(\d+)$/.exec(lines.pop() ?? "");
  if (!completion) throw new Error("Global probe process inventory is truncated or incomplete.");
  const processes = lines.map((line): Partial<GlobalProbeProcess> => {
    const [pid, birth, parentPid, executableAccessible, executable, commandLineAccessible, commandLine, ...extra] = line.split("\t");
    if (extra.length > 0 || executable === undefined || commandLine === undefined) throw new Error("Global probe process inventory row is malformed.");
    if (!["0", "1"].includes(executableAccessible ?? "") || !["0", "1"].includes(commandLineAccessible ?? ""))
      throw new Error("Global probe process inventory accessibility is malformed.");
    return {
      pid: Number(pid), birth, parentPid: Number(parentPid),
      executableAccessible: executableAccessible === "1",
      commandLineAccessible: commandLineAccessible === "1",
      executable: Buffer.from(executable, "base64").toString("utf8"),
      commandLine: Buffer.from(commandLine, "base64").toString("utf8"),
    };
  });
  if (processes.length !== Number(completion[1]))
    throw new Error("Global probe process inventory count is invalid.");
  return validateGlobalProbeProcessInventory(processes);
}

function validateGlobalProbeProcessInventory(processes: readonly Partial<GlobalProbeProcess>[]): GlobalProbeProcess[] {
  if (processes.length < 1 || processes.length > 4096 || processes.some((process) => !Number.isSafeInteger(process.pid) || Number(process.pid) < 0 ||
      !Number.isSafeInteger(process.parentPid) || Number(process.parentPid) < 0 ||
      typeof process.birth !== "string" || !Number.isFinite(probeBirthTime(process.birth)) ||
      typeof process.executableAccessible !== "boolean" || typeof process.commandLineAccessible !== "boolean" ||
      typeof process.executable !== "string" || typeof process.commandLine !== "string" ||
      (!process.executableAccessible && process.executable !== "") || (!process.commandLineAccessible && process.commandLine !== "")))
    throw new Error("Global probe process inventory contains malformed entries.");
  return processes as GlobalProbeProcess[];
}

function probeCommandReferencesRoot(commandLine: string, root: string): boolean {
  return probeTextReferencesRoot(commandLine, root);
}

function probeTextReferencesRoot(value: string, root: string): boolean {
  if (value.length > MAX_ENCODED_REFERENCE_CHARS) throw new Error("Probe process reference evidence exceeds its bound.");
  const normalized = resolve(root).toLowerCase();
  const jsonEscaped = JSON.stringify(resolve(root)).slice(1, -1).toLowerCase();
  if (value.toLowerCase().includes(normalized)) return true;
  const candidates = [...value.matchAll(/[A-Za-z0-9+\/_-]{40,}={0,2}/g)].map((match) => match[0]);
  if (candidates.length > MAX_ENCODED_REFERENCE_CANDIDATES) throw new Error("Probe process encoded-reference count exceeds its bound.");
  for (const encoded of candidates) {
    if (encoded.length > MAX_ENCODED_REFERENCE_CHARS) throw new Error("Probe process encoded reference exceeds its bound.");
    for (const decodedBytes of decodeProbeBase64Phases(encoded)) {
      if (decodedBytes.byteLength > MAX_DECODED_REFERENCE_BYTES) throw new Error("Probe process decoded reference exceeds its bound.");
      const decoded = decodedBytes.toString("utf8");
      const normalizedDecoded = decoded.toLowerCase();
      if (normalizedDecoded.includes(normalized) || normalizedDecoded.includes(jsonEscaped)) return true;
      try { if (decodedProbePayloadReferencesRoot(JSON.parse(decoded), normalized)) return true; }
      catch {}
    }
  }
  return false;
}

function decodeProbeBase64Phases(encoded: string): readonly Buffer[] {
  const unpadded = encoded.replace(/=+$/, "");
  if (unpadded.length < 40) return [];
  const encodings: BufferEncoding[] = ["base64url", "base64"];
  const decoded: Buffer[] = [];
  const seen = new Set<string>();
  for (const encoding of encodings) {
    for (let offset = 0; offset < 4; offset += 1) {
      for (let trim = 0; trim < 4; trim += 1) {
        const phase = unpadded.slice(offset, trim === 0 ? undefined : -trim);
        if (phase.length < 40 || phase.length % 4 === 1) continue;
        const bytes = Buffer.from(phase, encoding);
        const key = bytes.toString("base64");
        if (!seen.has(key)) { seen.add(key); decoded.push(bytes); }
      }
    }
  }
  return decoded;
}

function decodedProbePayloadReferencesRoot(value: unknown, normalizedRoot: string, depth = 0): boolean {
  if (depth > 6) return false;
  if (typeof value === "string") {
    try { return resolve(value).toLowerCase().startsWith(normalizedRoot); }
    catch { return false; }
  }
  if (Array.isArray(value)) return value.length <= 256 && value.some((item) => decodedProbePayloadReferencesRoot(item, normalizedRoot, depth + 1));
  if (!value || typeof value !== "object") return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 256 && entries.some(([, item]) => decodedProbePayloadReferencesRoot(item, normalizedRoot, depth + 1));
}

function validProbeOwner(pid: unknown, birth: unknown): birth is string {
  return Number.isSafeInteger(pid) && Number(pid) > 0 && typeof birth === "string" && Number.isFinite(probeBirthTime(birth));
}

function probeBirthTime(birth: string): number { return Date.parse(birth); }

function exactProbeRootCreationTime(root: string): number {
  const createdAt = statSync(root).birthtimeMs;
  if (!Number.isFinite(createdAt) || createdAt <= 0) throw new Error("Exact probe root creation time is unavailable.");
  // JavaScript process-birth parsing resolves to whole milliseconds. Flooring
  // the filesystem time makes same-millisecond ordering ambiguous and therefore
  // fail-closed instead of treating a rounded timestamp as strictly older.
  return Math.floor(createdAt);
}

function sameProbeBirth(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/(\.\d{6})\d+(Z)$/, "$1$2");
  return normalize(left) === normalize(right);
}

async function settleProbeOutput(backend: WindowsProcessBackend, binding: ProcessBackendBinding, deadlineMs: number): Promise<void> {
  const channel = await backend.backpressuredChannelProvider().acquire(binding, FENCE);
  try {
    channel.subscribeBackpressuredOutput(async (metadata) => metadata);
    await waitForPortableTerminal(backend, binding, () => true, deadlineMs);
  } finally {
    await channel.detach().catch(() => undefined);
  }
}

export async function requireEmptyAndRelease(backend: WindowsProcessBackend, binding: ProcessBackendBinding, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let lastReleaseError: unknown;
  for (;;) {
    const empty = parseProcessEmptyVerification(await backend.verifyEmpty(binding, FENCE));
    if (empty.empty) {
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

function request(
  workspace: string,
  executable: string,
  args: readonly string[],
  ambientEnvironment: Readonly<Record<string, string | undefined>>,
  extraEnvironment: Readonly<Record<string, string>> = {},
): ProcessLaunchRequest {
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
    environment: minimalWindowsSemanticProbeEnvironment(ambientEnvironment, extraEnvironment),
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
