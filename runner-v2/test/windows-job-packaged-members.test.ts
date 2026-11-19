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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

import {
  failedLaunchIdentity,
  parseProcessEmptyVerification,
  parseProcessLaunchResult,
  type ProcessBackend,
  type ProcessBackendBinding,
  type ProcessEffectFence,
  type ProcessLaunchResult,
} from "../src/process-backend.js";
import { createWindowsJobProcessHost, WindowsJobStartFailedError, type WindowsJobInjectedLaunchFault } from "../src/windows-job-process-host.js";
import { createWindowsProcessBackend } from "../src/windows-process-backend.js";
import { checkNoWindowsJobProcessesLeft } from "./support/windows-job-leftover-guard.js";
import { CONTAINED_STOP_CONFIRMATION } from "../src/managed-process-tools.js";
import { pwshExecutable } from "../src/shell-inventory.js";
import { processRunRefused, runStorePwshEndToEnd, type StorePwshEndToEnd } from "./support/packaged-member-e2e.js";

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
    // Every terminal status of the refused start carries the refusal's code, the one written at the host's exit
    // included: a launcher that acts on the first terminal status it reads keeps the code, not a generic start failure.
    const terminal = supervisorStatusLines(join(root, "job-host")).filter((line) => line.status === "exited_unknown" || line.status === "stopped");
    assert.ok(terminal.some((line) => line.status === "exited_unknown"), `the host's exit was recorded: ${JSON.stringify(terminal)}`);
    assert.ok(terminal.every((line) => line.errorCode === code), `every terminal status keeps ${code}: ${JSON.stringify(terminal)}`);
    // The refused start was released on its proven stop: its record is the released tombstone, nothing left to clean up.
    const records = jobHostRecords(join(root, "job-host"));
    assert.equal(records.length, 1, JSON.stringify(records));
    assert.equal(typeof records[0]!.backendOwnershipReleasedAt, "string", `the refused record is released: ${JSON.stringify(records[0])}`);
  });
}

// A refusal whose stop is not proven (the stricter-only seam leaves the supervisor's ownership unreleased) is never
// released: the launch fails with its exact record, as any other failed start, and the record stays held.
test("R2/R4: a refused launch whose stop is not proven fails with its exact record and stays held", { skip: !WINDOWS && "Windows Job host", timeout: 60_000 }, async () => {
  const root = join(ownRoot, "refuse-unproven");
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const service = createWindowsJobProcessHost({ stateDirectory: join(root, "job-host"), injectedLaunchFault: "membership_watch", injectedRefusedStopUnproven: true });
  const owner = { runId: "run-refuse-unproven", sessionId: "session-refuse-unproven" };
  const failure = await (service as unknown as { launchOwned(input: Record<string, unknown>): Promise<unknown> }).launchOwned({
    ...owner, command: process.execPath, args: ["-e", "0"], workingDirectory: workspace, environment: allowedEnv(), interactive: true, fence,
  }).then(() => assert.fail("the launch was refused"), (error: unknown) => error);
  assert.ok(failure instanceof WindowsJobStartFailedError, String(failure));
  assert.equal(failure.code, "windows_job_membership_watch_unavailable", failure.message);
  const records = jobHostRecords(join(root, "job-host"));
  assert.equal(records.length, 1, JSON.stringify(records));
  assert.equal(failure.startRecord.processId, records[0]!.processId);
  assert.equal(failure.startRecord.startedAt, records[0]!.startedAt);
  assert.equal(records[0]!.backendOwnershipReleasedAt, undefined, "an unproven refused start is never released");
  await assert.rejects(service.releaseOwned(failure.startRecord.processId, owner, failure.startRecord.startedAt, fence));
});

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
    // The claimed spare's refused start was released on its proven stop.
    const released = jobHostRecords(join(root, "job-host")).filter((record) => typeof record.backendOwnershipReleasedAt === "string");
    assert.equal(released.length, 1, `the claimed record is released: ${JSON.stringify(jobHostRecords(join(root, "job-host")))}`);
  } finally {
    await service.retireSpare?.().catch(() => undefined);
  }
});

// Through the tool a worker calls: a refused process.run reports the refusal's own code and words, never a generic
// launch failure, and nothing ran.
test("R4: process.run reports the Job host's coded refusal to its caller", { skip: (!WINDOWS && "Windows Job host") || (!DESKTOP_POLICY_HOST && "the desktop app policy exists from Windows 10 1703 (build 15063)"), timeout: 90_000 }, async () => {
  const refused = await processRunRefused(join(ownRoot, "run-refused"), "desktop_policy_initialize");
  assert.equal(refused.isError, true, refused.text);
  assert.equal(refused.code, "windows_job_desktop_policy_unavailable", refused.text);
  assert.match(refused.text, /refused the launch/);
  assert.doesNotMatch(refused.text, /ran/u);
  assert.equal(refused.closeError, null, "a launch refused before anything started leaves nothing to clean up");
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
    for (let round = 0; round < 3; round += 1) {
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
  // Never cleared: the supervisor's last durable status line, written when it recorded the stop, still carries it.
  const statusLines = supervisorStatusLines(join(root, "job-host"));
  const last = statusLines.at(-1)!;
  assert.equal(last.status, "stopped", JSON.stringify(last));
  assert.ok((last.memberEvidence as { count?: number } | undefined)?.count, `the final status keeps the evidence: ${JSON.stringify(last)}`);
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

// Member writes that fail (stricter-only faults; both treat the root as unpackaged so its members are reported):
// - member_emit_retry fails each line's first write: the watch retries it at its next wake, so the evidence still
//   reaches the supervisor before the stop and the Job is unverified and unreleased.
// - member_emit_lost fails every write: on the workload's natural end the watch settles with the line still pending,
//   the host fails with windows_job_membership_evidence_lost, and the supervisor keeps that as evidence.
// (An interactive stop ends the host without settling, so a write lost for good before such a stop is not seen: §6.)
test("R2: a member write that fails once is retried and still blocks verify-empty and release", { skip: STORE_SKIP, timeout: 90_000 }, async () => {
  const { backend, binding, empty } = await storePwshRootRun("store-retry", "member_emit_retry");
  assert.equal(empty.empty, false, "the retried member evidence must reach the supervisor");
  assert.match(empty.empty ? "" : empty.detail, /packaged \(MSIX or Microsoft Store\) program \(Microsoft\.PowerShell_[^)]+\) ran in the Windows Job/);
  await assert.rejects(backend.release(binding, fence),
    (error: unknown) => (error as { code?: unknown }).code === "process_stop_unproven_packaged_descendant");
});

test("R2: a member write lost for good fails the natural stop and blocks verify-empty and release", { skip: STORE_SKIP, timeout: 90_000 }, async () => {
  const { backend, launch } = setup("store-lost", "member_emit_lost");
  const binding = bind(await launch(storePwsh, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `& '${process.execPath}' -e "setTimeout(() => {}, 300)"`]));
  await observeExit(backend, binding);
  const empty = parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence));
  assert.equal(empty.empty, false, "a Job whose member evidence was lost is never verified empty");
  assert.match(empty.empty ? "" : empty.detail, /could not record its membership evidence/);
  await assert.rejects(backend.release(binding, fence),
    (error: unknown) => (error as { code?: unknown }).code === "process_stop_unproven_packaged_descendant");
});

// The event file stays unwritable for the host's coded error line too (member_emit_unwritable, stricter only): the
// host ends after its workload started with no natural stop and no stop request, so its watch never settled, and the
// supervisor keeps that as evidence.
test("R2: a host that ends without settling its watch leaves the Job unverified and unreleased", { skip: STORE_SKIP, timeout: 90_000 }, async () => {
  const { root, backend, launch } = setup("store-unwritable", "member_emit_unwritable");
  const binding = bind(await launch(storePwsh, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `& '${process.execPath}' -e "setTimeout(() => {}, 300)"`]));
  await observeExit(backend, binding);
  const empty = parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence));
  assert.equal(empty.empty, false, "a host that never settled its watch never proves the Job empty");
  assert.match(empty.empty ? "" : empty.detail, /ended without settling its membership watch/);
  assert.doesNotMatch(readJobEvents(join(root, "job-host")), /windows_job_membership_evidence_lost/, "the coded line was never written");
  await assert.rejects(backend.release(binding, fence),
    (error: unknown) => (error as { code?: unknown }).code === "process_stop_unproven_packaged_descendant");
});

// The started line cannot be written either (started_emit_unwritable, stricter only): the host resumes the workload,
// fails to write started for the write's retry window, and ends with no line at all. It ended before reporting that its
// workload started, with no stop request and no report that it created no process, so the launch fails and the
// supervisor keeps the unsettled watch as evidence; never a clean, releasable stop. The failure is a failed start with
// its exact record (no root pid): the record is never verified empty or released while its evidence stands, so the
// durable runtimes keep it cleanup-blocked.
const blockedStart = (message: RegExp) => (error: unknown) => {
  const identity = failedLaunchIdentity(error);
  return (error as { code?: unknown }).code === "process_launch_failed_with_identity" && typeof identity?.opaqueIdentity === "string" &&
    identity.rootPid === undefined && message.test((error as Error).message);
};
test("R2: a host that ends before its started line fails the launch and keeps evidence", { skip: !WINDOWS && "Windows Job host", timeout: 60_000 }, async () => {
  const { root, launch } = setup("started-unwritable", "started_emit_unwritable");
  const marker = join(root, "ran.txt");
  await assert.rejects(
    launch(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran"); setTimeout(() => {}, 60000)`]),
    // The launcher fails on the first terminal status it reads: the one written at the host's exit ("exited before"), or
    // the failed start recorded after it ("ended before").
    blockedStart(/(?:ended|exited) before it reported that its workload started/),
  );
  assert.equal(existsSync(marker), true, "the workload ran before the host ended");
  assert.doesNotMatch(readJobEvents(join(root, "job-host")), /"type":"(started|error|natural_stopped)"/, "the host wrote no lifecycle line");
  const last = await lastStatusWithEvidence(join(root, "job-host"));
  assert.equal(last.status, "stopped", JSON.stringify(last));
  assert.equal((last.memberEvidence as { count?: number } | undefined)?.count, 1, `the unsettled watch is evidence: ${JSON.stringify(last)}`);
  assert.match(JSON.stringify(last.memberEvidence), /ended without settling its membership watch/);
});

// The same host failure after the workload wrote output that nobody has read: the retained output keeps the stop
// unsettled (exited_unknown, no pid), and that is still a failed start with the unsettled watch as evidence.
test("R2: a workload that wrote output before its host ended before the started line is a blocked failed start", { skip: !WINDOWS && "Windows Job host", timeout: 60_000 }, async () => {
  const { root, launch } = setup("started-unwritable-output", "started_emit_unwritable");
  await assert.rejects(launch(process.execPath, ["-e", `process.stdout.write("x".repeat(4096)); setTimeout(() => {}, 60000)`]),
    // The launcher fails on the first terminal status it reads: the one written at the host's exit ("exited before"), or
    // the unsettled output recorded after it.
    blockedStart(/output remains unsettled|exited before it reported that its workload started/));
  const last = await lastStatusWithEvidence(join(root, "job-host"));
  assert.equal(last.childPid, 0, JSON.stringify(last));
  assert.equal((last.memberEvidence as { count?: number } | undefined)?.count, 1, `the unsettled watch is evidence: ${JSON.stringify(last)}`);
});

// Through the tool a worker calls: the blocked failed start is never closed as "nothing was launched"; the run's
// close refuses while the evidence stands.
test("R2: process.run whose Job host ends before its started line is cleanup-blocked and its run close refuses", { skip: !WINDOWS && "Windows Job host", timeout: 90_000 }, async () => {
  // Its own folder, removed best effort: the refused run keeps its stores open by design.
  const folder = mkdtempSync(join(tmpdir(), `${OWN_MARKER}run-blocked-`));
  const refused = await processRunRefused(folder, "started_emit_unwritable").finally(() => { try { rmSync(folder, { recursive: true, force: true }); } catch { /* see above */ } });
  assert.equal(refused.isError, true, refused.text);
  assert.notEqual(refused.closeError, null, "the run's close refuses a failed start that keeps evidence");
  assert.match(refused.closeError!, /cleanup|unverified|blocked/iu, refused.closeError!);
});

/** Each Job record's supervisor status lines (supervisor.jsonl), oldest first, for this test's single record. */
/** The Job host's durable records (one JSON file per process), as written. */
function jobHostRecords(jobHostDirectory: string): Record<string, unknown>[] {
  return readdirSync(jobHostDirectory).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(jobHostDirectory, name), "utf8")) as Record<string, unknown>);
}

function supervisorStatusLines(jobHostDirectory: string): Record<string, unknown>[] {
  const records = readdirSync(jobHostDirectory).filter((name) => name.endsWith(".json"));
  assert.equal(records.length, 1, `one Job record: ${records.join(", ")}`);
  const record = JSON.parse(readFileSync(join(jobHostDirectory, records[0]!), "utf8")) as { supervisor: { statusPath: string } };
  return readFileSync(record.supervisor.statusPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * The supervisor's last status line once it carries member evidence. A launch that failed on the host's exit-time status
 * returns before the supervisor writes the status that records the unsettled watch, so the test waits for that line.
 * The exit-time status is exited_unknown, which nothing verifies empty or releases, so the start stays held meanwhile.
 * If the evidence is never recorded, the wait fails the test.
 */
async function lastStatusWithEvidence(jobHostDirectory: string): Promise<Record<string, unknown>> {
  await waitFor(() => supervisorStatusLines(jobHostDirectory).at(-1)?.memberEvidence !== undefined, 30_000, "the supervisor's status with member evidence");
  return supervisorStatusLines(jobHostDirectory).at(-1)!;
}

/** Every Job event file under a job-host directory, concatenated. */
function readJobEvents(jobHostDirectory: string): string {
  return readdirSync(jobHostDirectory, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith("job-events.jsonl"))
    .map((name) => readFileSync(join(jobHostDirectory, name), "utf8")).join("");
}

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
