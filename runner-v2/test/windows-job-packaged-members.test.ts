// Windows Job host, packaged descendants and the desktop app policy (docs/runner-v2/codex-windows-job-escape-2026-11-18.md
// §4.2, R2 and R4). Each case drives the real Job host (supervisor + PowerShell host + Job) through the backend, as the
// Runner does, and is guarded per host fact: Windows, and for the packaged case a Microsoft Store pwsh alias.
//
// - R4: an injected failure to build or update the attribute list refuses the launch with a coded refusal before
//   CreateProcess: the workload never runs and the supervisor proves its own stop.
// - R2: a failure to watch the Job's membership messages refuses the same way.
// - R2: a workload of many short-lived plain processes leaves no member evidence, so its Job is verified empty.
// - R2: under a Store pwsh root (the policy), members with the root's own package are contained and verified empty;
//   a packaged member that is not explained that way leaves the Job unverified and unreleased, never the contained stop.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

import {
  parseProcessEmptyVerification,
  parseProcessLaunchResult,
  type ProcessBackend,
  type ProcessBackendBinding,
  type ProcessEffectFence,
  type ProcessLaunchResult,
} from "../src/process-backend.js";
import { createWindowsJobProcessHost, type WindowsJobInjectedLaunchFault } from "../src/windows-job-process-host.js";
import { createWindowsProcessBackend } from "../src/windows-process-backend.js";
import { checkNoWindowsJobProcessesLeft } from "./support/windows-job-leftover-guard.js";
import { CONTAINED_STOP_CONFIRMATION } from "../src/managed-process-tools.js";
import { pwshExecutable } from "../src/shell-inventory.js";
import { runStorePwshEndToEnd, type StorePwshEndToEnd } from "./support/packaged-member-e2e.js";

const WINDOWS = process.platform === "win32";
/** Windows 10 1703 (build 15063) or newer, where the Job host must give every root the desktop app policy (R4). */
const DESKTOP_POLICY_HOST = WINDOWS && Number(release().split(".")[2] ?? 0) >= 15063;
const OWN_MARKER = `aiboard-packaged-${randomUUID().slice(0, 8)}-`;
const ownRoot = WINDOWS ? mkdtempSync(join(tmpdir(), OWN_MARKER)) : "";
const fence: ProcessEffectFence = { ownerId: "packaged-members", fencingToken: 1 };
const storePwsh = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "pwsh.exe") : "";

after(async () => {
  if (!WINDOWS) return;
  await checkNoWindowsJobProcessesLeft([OWN_MARKER]);
  rmSync(ownRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
});

function allowedEnv(): Record<string, string> {
  const keep = new Set(["systemroot", "windir", "comspec", "path", "pathext", "temp", "tmp", "localappdata", "userprofile"]);
  return Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => value !== undefined && keep.has(key.toLowerCase())),
  ) as Record<string, string>;
}

function setup(name: string, injectedLaunchFault?: WindowsJobInjectedLaunchFault) {
  const root = join(ownRoot, name);
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const service = createWindowsJobProcessHost({
    stateDirectory: join(root, "job-host"),
    ...(injectedLaunchFault ? { injectedLaunchFault } : {}),
  });
  const backend = createWindowsProcessBackend({
    jobObjects: { service },
    semanticFacts: { portableDuplex: "verified", windowsBatchArgv: "verified", exactTreeBirth: "partial", jobContainment: "verified" },
  });
  let sequence = 0;
  const launch = async (executable: string, args: readonly string[]): Promise<ProcessLaunchResult> => {
    const invocationId = `${name}-${++sequence}`;
    return parseProcessLaunchResult(await backend.launch({
      intent: {
        invocationId, runId: `run-${name}`, kind: "command", executable, arguments: [...args],
        workingDirectory: workspace, requiredLifecycleScope: "process_group", requestedCapabilities: [],
      },
      grant: { grantId: `grant-${invocationId}`, runId: `run-${name}`, invocationId, issuedAt: new Date().toISOString(), access: [] },
      environment: allowedEnv(),
      outputOwnerId: `${name}-output`,
      fence,
    }));
  };
  return { root, workspace, service, backend, launch };
}

function bind(launch: ProcessLaunchResult): ProcessBackendBinding {
  return {
    registryId: "registry", backendId: "runner-windows-job-v1", implementationGeneration: "packaged-members",
    implementationDigest: "1".repeat(64), attestationVersion: 1, attestationDigest: "2".repeat(64), ...launch,
  } as ProcessBackendBinding;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${what} did not happen within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function observeExit(backend: ProcessBackend, binding: ProcessBackendBinding): Promise<void> {
  const observed = (await backend.observe(binding, async () => undefined, fence)) as { state: string };
  assert.equal(observed.state, "exited");
}

for (const fault of ["desktop_policy_initialize", "desktop_policy_update", "membership_watch"] as const) {
  const code = fault === "membership_watch" ? "windows_job_membership_watch_unavailable" : "windows_job_desktop_policy_unavailable";
  test(`R2/R4: an injected ${fault} failure refuses the launch with ${code} before any spawn`, { skip: (!WINDOWS && "Windows Job host") || (fault !== "membership_watch" && !DESKTOP_POLICY_HOST && "the desktop app policy exists from Windows 10 1703 (build 15063)"), timeout: 60_000 }, async () => {
    const { root, launch } = setup(`refuse-${fault}`, fault);
    const marker = join(root, "ran.txt");
    await assert.rejects(
      launch(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`]),
      (error: unknown) => (error as { code?: unknown }).code === code && /refused the launch/.test((error as Error).message),
    );
    // CreateProcess never ran: the workload left no trace, and the leftover guard (after) finds no live host or child.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(existsSync(marker), false, "the refused workload must never have started");
  });
}

// A spare host refuses the same way when it is claimed (the policy and the watch start only with the claimed call), and
// the claim keeps the refusal's code rather than a generic start failure.
test("R2/R4: a claimed spare refuses with the coded refusal before any spawn", { skip: !WINDOWS && "Windows Job host", timeout: 60_000 }, async () => {
  const root = join(ownRoot, "refuse-spare");
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const service = createWindowsJobProcessHost({ stateDirectory: join(root, "job-host"), spare: { idleTimeoutMs: 120_000 }, injectedLaunchFault: "desktop_policy_initialize" });
  const owner = { runId: "run-refuse-spare", sessionId: "session-refuse-spare" };
  try {
    await service.prestartSpare!(owner);
    const marker = join(root, "ran.txt");
    await assert.rejects(
      (service as unknown as { launchOwned(input: Record<string, unknown>): Promise<unknown> }).launchOwned({
        ...owner, command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
        workingDirectory: workspace, environment: allowedEnv(), interactive: true, fence,
      }),
      (error: unknown) => (error as { code?: unknown }).code === "windows_job_desktop_policy_unavailable",
    );
    assert.equal(service.spareStats!().fallbacks, 0, "the call was the spare's claim, not a fresh launch");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(existsSync(marker), false, "the refused workload must never have started");
  } finally {
    await service.retireSpare?.().catch(() => undefined);
  }
});

// False positives would make every stop unproven. Many processes that exit at once are the race the watch must win:
// each is opened from its membership message while its parent still holds it, and the Job's own process count matches
// the messages received.
test("R2: a workload of many short-lived plain processes leaves no member evidence and is verified empty", { skip: !WINDOWS && "Windows Job host", timeout: 60_000 }, async () => {
  const { backend, launch } = setup("plain");
  const script = Array.from({ length: 30 }, () => "cmd /d /c exit 0").join(" & ") +
    ` & "${process.execPath}" -e "require('child_process').execFileSync(process.execPath, ['-e', ''])"`;
  const started = await launch("cmd.exe", ["/d", "/s", "/c", script]);
  const binding = bind(started);
  await observeExit(backend, binding);
  const empty = parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence));
  assert.deepEqual(empty, { empty: true, proofArtifactId: empty.empty ? empty.proofArtifactId : "" });
  await backend.release(binding, fence);
});

// The harder race: detached members (start /b) whose parent drops its handle at once, so a member that exits before
// its message is handled cannot be opened any more. Run under CPU load from this test's own busy processes (outside the
// Job), several times, so a slow watch would show up as unidentified evidence.
test("R2: detached short-lived members under CPU load leave no member evidence", { skip: !WINDOWS && "Windows Job host", timeout: 120_000 }, async () => {
  const busy = Array.from({ length: 4 }, () => spawn(process.execPath, ["-e", "for(;;){}", OWN_MARKER], { stdio: "ignore", windowsHide: true }));
  try {
    for (let round = 0; round < 5; round += 1) {
      const { backend, launch } = setup(`detached-${round}`);
      const started = await launch("cmd.exe", ["/d", "/s", "/c", `for /l %i in (1,1,40) do @start "" /b cmd /d /c exit 0`]);
      const binding = bind(started);
      await observeExit(backend, binding);
      const empty = parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence));
      assert.equal(empty.empty, true, empty.empty ? "" : `round ${round}: ${empty.detail}`);
      await backend.release(binding, fence);
    }
  } finally {
    for (const child of busy) child.kill();
  }
});

// A Store pwsh root (started by the Job host with the desktop app policy) that starts node. Its descendants carry the
// root's own package identity and stay in the Job (measured 2026-11-18, Store pwsh 7.7), so they are not evidence.
async function storePwshRootRun(name: string, fault: WindowsJobInjectedLaunchFault | undefined) {
  const { root, backend, launch } = setup(name, fault);
  const marker = join(root, `child-${randomUUID().slice(0, 8)}.pid`);
  const child = join(root, "child.cjs");
  writeFileSync(child, "require('fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 60000);");
  let childPid = 0;
  try {
    const started = await launch(storePwsh, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `& '${process.execPath}' '${child}' '${marker}'`]);
    const binding = bind(started);
    await waitFor(() => existsSync(marker) && readFileSync(marker, "utf8").trim().length > 0, 30_000, "the node child's marker");
    childPid = Number(readFileSync(marker, "utf8").trim());
    await backend.signal(binding, "force_terminate", fence);
    await observeExit(backend, binding);
    // Either way node was in the Job and died with it.
    await waitFor(() => !alive(childPid), 5_000, "the node child's death with its Job");
    return { root, backend, binding, empty: parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)) };
  } finally {
    // This test's own fixture, by the PID it wrote, on a red run only: the Runner never signals outside its Job.
    if (Number.isSafeInteger(childPid) && childPid > 0 && alive(childPid)) {
      try { process.kill(childPid); } catch {}
    }
  }
}

const STORE_SKIP = (!WINDOWS && "Windows Job host") ||
  (!aliasPresent(storePwsh) && "needs the Microsoft Store pwsh alias in %LOCALAPPDATA%\\Microsoft\\WindowsApps");

test("R2: under a Store pwsh root, descendants with the root's own package are contained: verified empty and released", { skip: STORE_SKIP, timeout: 90_000 }, async () => {
  const { backend, binding, empty } = await storePwshRootRun("store-root", undefined);
  assert.equal(empty.empty, true, empty.empty ? "" : empty.detail);
  await backend.release(binding, fence);
});

// The full evidence chain with a real packaged member in the Job: the Job host's watch, its "member" event, the
// supervisor's durable status, the TS host's record and the backend. membership_ignore_root_package (a stricter-only
// test fault) treats the root as unpackaged, so the node child, which carries the root's package, is reported.
test("R2: a packaged non-root member leaves the Job unverified and unreleased, with the packaged text", { skip: STORE_SKIP, timeout: 90_000 }, async () => {
  const { root, backend, binding, empty } = await storePwshRootRun("store-member", "membership_ignore_root_package");
  assert.equal(empty.empty, false, "a Job that held a packaged descendant is never verified empty");
  assert.match(empty.empty ? "" : empty.detail, /packaged \(MSIX or Microsoft Store\) program \(Microsoft\.PowerShell_[^)]+\) ran in the Windows Job as a descendant/);
  assert.match(empty.empty ? "" : empty.detail, /the stop is not proven/);
  await assert.rejects(backend.release(binding, fence),
    (error: unknown) => (error as { code?: unknown }).code === "process_stop_unproven_packaged_descendant");
  // Durable: after a restart, a new host and backend over the same state read the evidence from the record and the
  // supervisor's last status, and refuse the same way.
  const restarted = createWindowsProcessBackend({
    jobObjects: { service: createWindowsJobProcessHost({ stateDirectory: join(root, "job-host") }) },
    semanticFacts: { portableDuplex: "verified", windowsBatchArgv: "verified", exactTreeBirth: "partial", jobContainment: "verified" },
  });
  assert.equal(parseProcessEmptyVerification(await restarted.verifyEmpty(binding, fence)).empty, false);
  await assert.rejects(restarted.release(binding, fence));
});

/** An app execution alias cannot be followed by stat, so existsSync reports false; lstat sees the link itself. */
function aliasPresent(path: string): boolean {
  if (!path) return false;
  try { lstatSync(path); return true; } catch { return false; }
}

// End to end through the tools a worker calls: with a packaged member in the Job (the stricter-only fault again), the
// managed stop is not proven, so process.signal never reports CONTAINED_STOP_CONFIRMATION, and a process.run's cleanup
// is not verified_empty. Without the fault the same Store pwsh root keeps the contained stop (R1/R2 no false positive).
// The faulted run's records end cleanup_blocked, so its run and host refuse to close and keep the run's internal helper:
// that case runs in a child process (support/packaged-member-e2e-child.mts) whose tree the test retires by its own PID.
// process.run's shell: "pwsh" is whatever pwsh the Runner resolves, so the end-to-end legs need that to be the Store's.
const E2E_SKIP = STORE_SKIP || (!/[\\/]windowsapps[\\/]/iu.test(pwshExecutable() ?? "") && "needs the Microsoft Store's pwsh first on PATH");

function assertEndToEnd(observed: StorePwshEndToEnd, faulted: boolean): void {
  assert.equal(observed.startIsError, false, observed.start);
  if (faulted) {
    assert.equal(observed.signalIsError, true, observed.signal);
    assert.doesNotMatch(observed.signal, new RegExp(CONTAINED_STOP_CONFIRMATION.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    // process.run's own pwsh is the Store package here (E2E_SKIP), so its Job holds the same packaged member.
    assert.equal(observed.runCleanupState, "failed", observed.run);
    assert.match(observed.run, /"code":"verified_empty_failed","detail":"A packaged \(MSIX or Microsoft Store\) program/);
    assert.match(observed.closeError ?? "", /packaged \(MSIX or Microsoft Store\) program/, "the run must refuse to close as contained");
  } else {
    assert.equal(observed.signalIsError, false, observed.signal);
    assert.match(observed.signal, /every process it started have exited/);
    assert.equal(observed.runIsError, false, observed.run);
    // process.run reports cleanup only when it failed.
    assert.equal(observed.runCleanupState, null, observed.run);
    assert.doesNotMatch(observed.run, /"error":/);
    assert.equal(observed.closeError, null);
  }
}

test("R2 end to end: a Store pwsh process.start and process.run keep the contained stop", { skip: E2E_SKIP, timeout: 180_000 }, async () => {
  assertEndToEnd(await runStorePwshEndToEnd(join(ownRoot, "e2e-none"), storePwsh, undefined), false);
});

test("R2 end to end: a Store pwsh process.start and process.run with a packaged member are not proven stopped", { skip: E2E_SKIP, timeout: 180_000 }, async () => {
  const root = join(ownRoot, "e2e-member");
  mkdirSync(root, { recursive: true });
  const resultFile = join(root, "result.json");
  const entry = fileURLToPath(new URL("./support/packaged-member-e2e-child.mts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", entry, root, storePwsh, "membership_ignore_root_package", resultFile],
    { cwd: process.cwd(), stdio: ["ignore", "ignore", "inherit"], windowsHide: true });
  let exited = false;
  child.once("exit", () => { exited = true; });
  try {
    await waitFor(() => existsSync(resultFile) || exited, 150_000, "the end-to-end child's result");
    assert.ok(existsSync(resultFile), "the end-to-end child exited without a result");
    assertEndToEnd(JSON.parse(readFileSync(resultFile, "utf8")) as StorePwshEndToEnd, true);
  } finally {
    // This test's own child and its tree (the run's kept helper), by the child's own PID: never a census.
    if (!exited && child.pid) spawnSync("taskkill.exe", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
    await waitFor(() => exited, 30_000, "the end-to-end child's exit");
  }
});
