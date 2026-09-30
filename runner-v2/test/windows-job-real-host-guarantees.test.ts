// PX-2t — real-host guarantee pins for the Windows Job path (`runner-windows-job-v1`).
//
// Every test drives the real execution host (`createExecutionHost` + `bindRun`)
// with the real Windows Job backend selected by production probing — no fakes,
// no stubs of the backend. The backend-level birth-identity test (G7) is the
// one exception: the executor never surfaces backend bindings, so it drives the
// real backend + real Job host directly, the same components the host wires.
//
// Skip policy: clean `t.skip` when not on Windows or when the Job backend is
// not selected (checked empirically: one git call must leave Job-host records).
// Every test leaves no process behind: marker PIDs of its own tree must be dead
// at the end, and a shared helper asserts no Job supervisor stays alive.
// Net rules (PX-2t repair cycle 1): every spawned tree self-exits after 90 s
// (longer than any 55 s test), and every tree test kills its own identified
// PIDs (marker PID + Job-record PIDs, never guessed) in a `finally` — so a red
// run cleans up after itself. Record lookups match argv (the unique marker),
// never a record-set diff, and the supervisor gate tolerates supervisors that
// were already alive before the file started (a PX-2c pre-started spare).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, before, type TestContext } from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { openSqliteDurableProcessKernel } from "../src/durable-process-store.js";
import { createExecutionHost, type ExecutionHost, type ExecutionHostRunBinding } from "../src/execution-host.js";
import {
  parseProcessEmptyVerification,
  parseProcessLaunchResult,
  parseProcessReconciliation,
  type ProcessBackendBinding,
  type ProcessEffectFence,
  type ProcessLaunchResult,
} from "../src/process-backend.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { createWindowsJobProcessHost, type WindowsJobProcessHost } from "../src/windows-job-process-host.js";
import { createWindowsProcessBackend } from "../src/windows-process-backend.js";
import { checkNoWindowsJobProcessesLeft } from "./support/windows-job-leftover-guard.js";

const WINDOWS_SKIP = "Windows Job real-host pin requires a Windows host.";
const BACKEND_SKIP = "Windows Job real-host pin requires the runner-windows-job-v1 backend to be selected.";

interface Px2tHarness {
  readonly host: ExecutionHost;
  readonly binding: ExecutionHostRunBinding;
  readonly root: string;
  readonly project: string;
  readonly outside: string;
  readonly stateDir: string;
  readonly jobHostDir: string;
  readonly runId: string;
  readonly runRoot: string;
  readonly dbPath: string;
}

let harness: Px2tHarness | undefined;
let jobBackendSelected = false;
let callSeq = 0;
// PX-2c repair 1 (N4): spare-on switch. `PX2C_SPARE_ON=1` runs this whole file
// with one auto-refreshing spare waiting: the same 12 guarantees must hold on
// the claimed path, and the spare-aware gate above must ignore the idle spare.
const SPARE_ON = process.env["PX2C_SPARE_ON"] === "1";
let spareService: WindowsJobProcessHost | undefined;

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`px2t: ${what} did not settle within ${timeoutMs}ms`);
    await sleep(25);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pids: readonly number[], timeoutMs: number, what: string): Promise<void> {
  await waitFor(() => pids.every((pid) => !processAlive(pid)), timeoutMs, `${what} to die`);
}

function initGitRepo(directory: string): void {
  execFileSync("git", ["init", "-q", directory]);
  execFileSync("git", ["-C", directory, "config", "user.email", "px2t@example.test"]);
  execFileSync("git", ["-C", directory, "config", "user.name", "px2t"]);
  writeFileSync(join(directory, "f.txt"), "px2t\n");
  execFileSync("git", ["-C", directory, "add", "."]);
  execFileSync("git", ["-C", directory, "commit", "-qm", "px2t"]);
}

interface JobRecordView {
  readonly file: string;
  readonly processId: string;
  readonly pid: number;
  readonly supervisorPid: number;
  readonly startedAt: string;
  readonly args: readonly string[];
  readonly spare: boolean;
  readonly spareClaimed: boolean;
  readonly spareClaimInFlight: boolean;
}

function readJobRecords(h: Px2tHarness): JobRecordView[] {
  return readJobRecordDir(h.jobHostDir);
}

function readJobRecordDir(jobHostDir: string): JobRecordView[] {
  let entries: string[];
  try {
    entries = readdirSync(jobHostDir).filter((entry) => entry.endsWith(".json"));
  } catch {
    return [];
  }
  const records: JobRecordView[] = [];
  for (const file of entries) {
    try {
      const raw = JSON.parse(readFileSync(join(jobHostDir, file), "utf8")) as {
        processId?: unknown;
        pid?: unknown;
        startedAt?: unknown;
        args?: unknown;
        spare?: unknown;
        spareClaimed?: unknown;
        spareClaimInFlight?: unknown;
        supervisor?: { supervisorPid?: unknown };
      };
      if (typeof raw.processId !== "string" || typeof raw.startedAt !== "string") continue;
      records.push({
        file,
        processId: raw.processId,
        pid: typeof raw.pid === "number" ? raw.pid : 0,
        supervisorPid:
          typeof raw.supervisor?.supervisorPid === "number" ? (raw.supervisor.supervisorPid as number) : 0,
        startedAt: raw.startedAt,
        args: Array.isArray(raw.args) ? raw.args.filter((entry): entry is string => typeof entry === "string") : [],
        spare: raw.spare === true,
        spareClaimed: raw.spareClaimed === true,
        spareClaimInFlight: raw.spareClaimInFlight === true,
      });
    } catch {
      continue;
    }
  }
  return records;
}

/** This call's Job record: the one whose argv carries our unique marker name.
 * argv-matching (not a record-set diff) keeps working when PX-2c adds a
 * pre-started spare whose record predates every test. Matched on the basename:
 * the record stores the `-e` script source, where the full path sits
 * JSON-escaped (doubled backslashes), so a raw-path `includes` never matches
 * on Windows — the uuid basename is still unique per test. */
function findRecordByMarker(h: Px2tHarness, marker: string): JobRecordView | undefined {
  const tag = basename(marker);
  return readJobRecords(h).find((record) => record.args.some((arg) => arg.includes(tag)));
}

function findRecordByMarkerInDir(jobHostDir: string, marker: string): JobRecordView | undefined {
  const tag = basename(marker);
  return readJobRecordDir(jobHostDir).find((record) => record.args.some((arg) => arg.includes(tag)));
}

/** Supervisors already alive before the file started (a future PX-2c spare).
 * The leftover gate asserts the guarantee — no NEW live supervisor — instead
 * of hard-coding today's zero-supervisor process model. */
let preExistingSupervisorPids = new Set<number>();

function recordCount(h: Px2tHarness): number {
  try {
    return readdirSync(h.jobHostDir).filter((entry) => entry.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/** Zero-leftover gate: every supervisor THIS run started must be gone.
 * Supervisors already alive before the file started are excluded, so a PX-2c
 * pre-started spare does not need to edit this net. PX-2c repair 2 (N5): the
 * spare-aware clause ignores exactly the one idle spare by its own durable
 * record — a single live record with `spare:true, spareClaimed:false` and no
 * claim mark. Two leaked idle spares, a claimed spare (a call, still
 * enforced), a claim-window orphan (spareClaimInFlight, still enforced), and
 * any call supervisor that outlives its call still fail this gate. */
async function assertNoLiveSupervisors(h: Px2tHarness, timeoutMs = 20_000): Promise<void> {
  await waitFor(
    () =>
      readJobRecords(h).every((record) => {
        if (
          record.supervisorPid < 1 ||
          preExistingSupervisorPids.has(record.supervisorPid) ||
          !processAlive(record.supervisorPid)
        )
          return true;
        if (!record.spare || record.spareClaimed || record.spareClaimInFlight) return false;
        return (
          readJobRecords(h).filter(
            (candidate) =>
              candidate.spare &&
              !candidate.spareClaimed &&
              !candidate.spareClaimInFlight &&
              candidate.supervisorPid > 0 &&
              !preExistingSupervisorPids.has(candidate.supervisorPid) &&
              processAlive(candidate.supervisorPid),
          ).length === 1
        );
      }),
    timeoutMs,
    "Job supervisors of this run",
  );
}

/** Best-effort kill of exact PIDs only (already-dead ones are skipped). */
async function killIdentifiedPids(pids: readonly number[]): Promise<void> {
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !processAlive(pid)) continue;
    try {
      process.kill(pid);
    } catch {
      // Already gone (or reaped between the check and the kill).
    }
  }
}

/** Red-run cleanup: kill this test's own tree, identified by its marker PID
 * plus its Job-record PIDs — never by guessing. On green every PID here is
 * already dead (the body asserts that first), so this is a no-op. The
 * Job-host powershell is included: it holds the run's cwd lock, and without
 * it the temp-root removal fails with EPERM on a red run. */
async function cleanupOwnTree(h: Px2tHarness, marker: string): Promise<void> {
  await cleanupOwnTreeInDir(h.jobHostDir, marker);
}

async function cleanupOwnTreeInDir(jobHostDir: string, marker: string): Promise<void> {
  const pids: number[] = [];
  try {
    const grandchild = Number(readFileSync(marker, "utf8").trim());
    if (Number.isSafeInteger(grandchild) && grandchild > 0) pids.push(grandchild);
  } catch {
    // Marker never written (launch itself failed): nothing tree-shaped to kill.
  }
  const record = findRecordByMarkerInDir(jobHostDir, marker);
  if (record) {
    if (record.pid > 0) pids.push(record.pid);
    if (record.supervisorPid > 0) {
      // Identified: the Job-host powershell that is this supervisor's child
      // (looked up while the supervisor is still alive).
      const hostPid = childPowershellOf(record.supervisorPid);
      if (hostPid !== undefined) pids.push(hostPid);
      pids.push(record.supervisorPid);
    }
  }
  await killIdentifiedPids(pids);
}

function needsJob(t: TestContext): Px2tHarness | undefined {
  if (process.platform !== "win32") {
    t.skip(WINDOWS_SKIP);
    return undefined;
  }
  if (!jobBackendSelected || !harness) {
    t.skip(BACKEND_SKIP);
    return undefined;
  }
  return harness;
}

function runnerCall(toolName: string, h: Px2tHarness) {
  callSeq += 1;
  const callId = `px2t-${callSeq}-${randomUUID().slice(0, 8)}`;
  return {
    callId,
    context: {
      runId: h.runId,
      sessionId: `session-${h.runId}`,
      actor: { role: "worker" as const, id: "worker-px2t" },
      callId,
      toolName,
      runnerInternal: true as const,
    },
  };
}

/** Start a node call without awaiting it: exposes the callId up front so a
 * test can correlate durable/recovery rows while the call is still live. */
function startNode(
  h: Px2tHarness,
  args: readonly string[],
  options: { timeoutMs?: number; signal?: AbortSignal; captureOutputBytes?: number; toolName?: string } = {},
) {
  const call = runnerCall(options.toolName ?? "process.run", h);
  const pending = h.binding.commandExecution.execute({
    executable: process.execPath,
    arguments: [...args],
    workingDirectory: h.project,
    timeoutMs: options.timeoutMs ?? 30_000,
    ...(options.captureOutputBytes !== undefined ? { captureOutputBytes: options.captureOutputBytes } : {}),
    ...(options.signal ? { context: { ...call.context, signal: options.signal } } : { context: call.context }),
  });
  return { callId: call.callId, pending };
}

async function runNode(
  h: Px2tHarness,
  args: readonly string[],
  options: { timeoutMs?: number; signal?: AbortSignal; captureOutputBytes?: number; toolName?: string } = {},
) {
  const started = startNode(h, args, options);
  const result = await started.pending;
  return { ...result, callId: started.callId };
}

/** A TERM-ignoring parent plus a detached TERM-ignoring grandchild. The
 * grandchild PID lands in `marker` once the tree is fully spawned. Both ends
 * self-exit after 90 s (longer than any 55 s test) so even a red run — where
 * the kill under test never lands — leaves nothing behind forever. */
function treeScript(marker: string): string {
  const grandchild =
    "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});" +
    "setTimeout(()=>process.exit(0),90000);setInterval(()=>{},250)";
  return (
    `const fs=require('node:fs');const{spawn}=require('node:child_process');` +
    `const g=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore',detached:true});` +
    `g.unref();fs.writeFileSync(${JSON.stringify(marker)},String(g.pid));` +
    `process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});` +
    `setTimeout(()=>process.exit(0),90000);setInterval(()=>{},250);`
  );
}

/** Root-exits-first variant: the root spawns the same detached TERM-ignoring
 * grandchild, records its PID, then exits on its own after `rootExitAfterMs`
 * — the descendant outlives the root by construction. */
function earlyExitTreeScript(marker: string, rootExitAfterMs: number): string {
  const grandchild =
    "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});" +
    "setTimeout(()=>process.exit(0),90000);setInterval(()=>{},250)";
  return (
    `const fs=require('node:fs');const{spawn}=require('node:child_process');` +
    `const g=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore',detached:true});` +
    `g.unref();fs.writeFileSync(${JSON.stringify(marker)},String(g.pid));` +
    `setTimeout(()=>process.exit(0),${rootExitAfterMs});`
  );
}

/** Launch a tree call; find its Job record by argv marker (PX-2c-proof). */
async function launchTreeCall(h: Px2tHarness, marker: string, timeoutMs: number, script?: string) {
  const started = startNode(h, ["-e", script ?? treeScript(marker)], { timeoutMs });
  await waitFor(
    () => existsSync(marker) && findRecordByMarker(h, marker) !== undefined,
    15_000,
    "tree call Job record and marker",
  );
  const grandchildPid = Number(readFileSync(marker, "utf8").trim());
  assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0, "marker must hold the grandchild PID");
  const record = findRecordByMarker(h, marker)!;
  return { pending: started.pending, callId: started.callId, processId: record.processId, record, grandchildPid };
}

function childPowershellOf(supervisorPid: number): number | undefined {
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${supervisorPid} AND Name='powershell.exe'" | Select-Object -ExpandProperty ProcessId`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    const pid = Number(out.split(/\s+/)[0]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

before(async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-px2t-"));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  initGitRepo(project);
  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  if (SPARE_ON) {
    spareService = createWindowsJobProcessHost({
      stateDirectory: join(stateDir, "managed-processes-job-host"),
      spare: { autoRefresh: true },
    });
  }
  const host = createExecutionHost({
    projectRoot: project,
    stateDirectory: stateDir,
    artifacts: new ArtifactStore(join(stateDir, "artifacts")),
    ambientEnvironment: { ...process.env },
    ...(spareService ? { windowsJobHost: spareService } : {}),
  });
  const runId = `px2t-${randomUUID()}`;
  const binding = await host.bindRun({
    runId,
    permissionProfile: "full",
    capabilityContract: { digest: "b".repeat(64) } as RunnerCapabilityContract,
    capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
  });
  const runRoot = binding.snapshot().runRoot;
  const jobHostDir = join(stateDir, "managed-processes-job-host");
  harness = {
    host,
    binding,
    root,
    project,
    outside,
    stateDir,
    jobHostDir,
    runId,
    runRoot,
    dbPath: binding.snapshot().subprocessStatePath,
  };
  // Selection probe: one production git call must leave Job-host records,
  // which only the runner-windows-job-v1 backend writes.
  await binding.git.lifecycle("integration").run({ cwd: project, args: ["rev-parse", "HEAD"] });
  jobBackendSelected = recordCount(harness) > 0;
  // Baseline for the leftover gate: supervisors already alive here (today:
  // none; with a PX-2c pre-started spare: one) are not this file's to reap.
  preExistingSupervisorPids = new Set(
    readJobRecords(harness)
      .map((record) => record.supervisorPid)
      .filter((pid) => pid > 0 && processAlive(pid)),
  );
  // PX-2c repair 1 (N4): prestart AFTER the baseline, so the idle spare is
  // ignored only through its durable spare record (the gate change above),
  // never through the pre-existing set.
  if (spareService) {
    assert.equal(typeof spareService.prestartSpare, "function", "host must offer prestartSpare");
    await spareService.prestartSpare!({ runId, sessionId: `session-${runId}` });
  }
}, { timeout: 90_000 });

after(async () => {
  if (!harness) return;
  const h = harness;
  harness = undefined;
  spareService = undefined;
  try {
    await h.binding.close();
  } catch {
    // Cleanup best-effort; the leftover assertions already ran per test.
  }
  try {
    await h.host.close();
  } catch {
    // Same as above.
  }
  rmSync(h.root, { recursive: true, force: true });
});

// G1 — exact grant scoping on the real host: a git call outside its grant is
// refused before launch (no new Job record), while the same call inside the
// grant succeeds through the same path.
test("real-host pin: a git call outside its exact grant fails closed without launching", { timeout: 55_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  const actor = { role: "worker" as const, id: "worker-px2t" };
  // The parent grant and its consuming call share one exact identity
  // (callId/toolName); only the working directory differs between the cases.
  const runWithGrant = async (callTag: string, cwd: string) => {
    const callId = `px2t-grant-${callTag}-${randomUUID().slice(0, 8)}`;
    const grant = await h.binding.executionGrants.issue({
      runId: h.runId,
      sessionId: `session-${h.runId}`,
      actor,
      toolName: "git.run",
      callId,
      permissionProfile: "full",
      workspacePath: h.project,
      access: [{ path: h.project, mode: "write" }],
      externalApproved: false,
      destructiveApproved: false,
      networkApproved: false,
    });
    try {
      const ctx = {
        runId: h.runId,
        sessionId: `session-${h.runId}`,
        actor,
        toolName: "git.run",
        callId,
        permissionProfile: "full" as const,
        executionGrant: grant,
      };
      return await h.binding.git.withCall(ctx, () => h.binding.git.current().run({ cwd, args: ["rev-parse", "HEAD"] }));
    } finally {
      await h.binding.executionGrants.revoke(grant, "completed").catch(() => undefined);
    }
  };
  const recordsBefore = recordCount(h);
  await assert.rejects(runWithGrant("outside", h.outside), /outside|escalat|confin|scope|authoriz/i);
  assert.equal(recordCount(h), recordsBefore, "a refused call must not launch any Job process");
  const inside = await runWithGrant("inside", h.project);
  assert.match(inside.stdout.trim(), /^[a-f0-9]{40}$/);
  await assertNoLiveSupervisors(h);
});

// G3 — host (Job-host process) death kills the whole tree: killing the
// powershell.exe that owns the Job must kill the TERM-ignoring tree, and the
// call must never report a clean success.
test(
  "real-host pin: host-process death kills the whole tree and never reports success",
  { timeout: 55_000 },
  async (t) => {
    const h = needsJob(t);
    if (!h) return;
    const marker = join(h.root, `px2t-hostdeath-${randomUUID().slice(0, 8)}.pid`);
    try {
      const launched = await launchTreeCall(h, marker, 15_000);
      let childPid = 0;
      await waitFor(() => {
        const record = readJobRecords(h).find((entry) => entry.processId === launched.processId);
        if (!record || record.pid <= 0) return false;
        childPid = record.pid;
        return true;
      }, 10_000, "child PID in the Job record");
      const supervisorPid = launched.record.supervisorPid;
      assert.ok(supervisorPid > 0, "Job record must carry its supervisor PID");
      let hostPid = 0;
      await waitFor(() => {
        const found = childPowershellOf(supervisorPid);
        if (found === undefined) return false;
        hostPid = found;
        return true;
      }, 10_000, "Job-host powershell under the supervisor");
      process.kill(hostPid);
      // Kill-propagation wait (host death → tree death), not a grace after an
      // empty proof: the tree must die for the call to settle at all.
      await waitForDeath([childPid, launched.grandchildPid], 10_000, "tree after Job-host death");
      const settled = await launched.pending;
      const outcome = settled.process.outcome;
      const clean =
        outcome === "exited" && settled.process.cleanup.state === "verified_empty" && settled.process.exitCode === 0;
      assert.equal(clean, false, `host death must never report clean success (got ${outcome})`);
      assert.equal(
        Number.isSafeInteger(settled.process.exitCode),
        false,
        `host death must report no exit code, got ${settled.process.exitCode}`,
      );
      rmSync(marker, { force: true });
      await assertNoLiveSupervisors(h);
    } finally {
      // Red-run cleanup: identified PIDs only (marker + Job record).
      await cleanupOwnTree(h, marker);
    }
  },
);

// G4 — a root that exits first still leaves no surviving descendant: the
// production path must own the orphaned grandchild and kill it before the
// call settles. The grandchild PID (not only the root) is asserted dead.
test(
  "real-host pin: a root that exits first still leaves no surviving descendant",
  { timeout: 55_000 },
  async (t) => {
    const h = needsJob(t);
    if (!h) return;
    const marker = join(h.root, `px2t-earlyexit-${randomUUID().slice(0, 8)}.pid`);
    try {
      const started = Date.now();
      const result = await runNode(h, ["-e", earlyExitTreeScript(marker, 300)], { timeoutMs: 4_000 });
      const elapsed = Date.now() - started;
      assert.equal(result.process.outcome, "timed_out", JSON.stringify(result.process.cleanup));
      assert.equal(result.process.cleanup.state, "verified_empty");
      // The deadline must be waited out (timer slop: 100 ms under is fine).
      assert.ok(elapsed >= 3_900, `root-exits-first must wait out its deadline, took ${elapsed}ms`);
      const grandchildPid = Number(readFileSync(marker, "utf8").trim());
      assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0, "marker must hold the grandchild PID");
      // Short grace: a premature verified_empty (the PX-2b event-driven-settle
      // risk) must not pass. The pristine path kills the tree before settling,
      // so the grandchild is already dead at return.
      await waitForDeath([grandchildPid], 2_000, "early-exit grandchild at return");
      rmSync(marker, { force: true });
      await assertNoLiveSupervisors(h);
    } finally {
      await cleanupOwnTree(h, marker);
    }
  },
);

// G5 — timeout kills ONE call's tree while a concurrent call in the same run
// finishes: the timed-out TERM-ignoring tree dies verified-empty, and the
// survivor — still running when the timeout kill lands — exits normally with
// its own exact output. The survivor outlives the kill by construction, so a
// kill that hits every running call of the run (the PX-2c spare-pair risk)
// turns this test red.
test(
  "real-host pin: timeout kills one call's tree while a concurrent call finishes",
  { timeout: 55_000 },
  async (t) => {
    const h = needsJob(t);
    if (!h) return;
    const marker = join(h.root, `px2t-timeout-${randomUUID().slice(0, 8)}.pid`);
    try {
      const slow = runNode(h, ["-e", treeScript(marker)], { timeoutMs: 5_000, toolName: "process.run" }).then(
        (result) => ({ ...result, returnedAt: Date.now() }),
      );
      // Survivor: prints at ~9 s, after the slow call's ~5 s timeout kill.
      const survivor = runNode(h, ["-e", "setTimeout(()=>console.log('px2t-concurrent-ok'),9000)"], {
        timeoutMs: 30_000,
        captureOutputBytes: 64 * 1024,
        toolName: "process.run",
      }).then((result) => ({ ...result, returnedAt: Date.now() }));
      const [slowResult, survivorResult] = await Promise.all([slow, survivor]);
      assert.equal(slowResult.process.outcome, "timed_out", JSON.stringify(slowResult.process.cleanup));
      assert.equal(slowResult.process.cleanup.state, "verified_empty");
      const grandchildPid = Number(readFileSync(marker, "utf8").trim());
      assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0, "marker must hold the grandchild PID");
      await waitForDeath([grandchildPid], 2_000, "timed-out grandchild");
      // Isolation: the survivor returned AFTER the killed call, normally.
      assert.ok(
        survivorResult.returnedAt > slowResult.returnedAt,
        `survivor must outlive the kill (slow ${slowResult.returnedAt}, survivor ${survivorResult.returnedAt})`,
      );
      assert.equal(survivorResult.process.outcome, "exited");
      assert.equal(survivorResult.process.exitCode, 0);
      assert.equal(survivorResult.process.cleanup.state, "verified_empty");
      assert.equal(Buffer.from(survivorResult.capturedOutput!.stdout).toString("utf8"), "px2t-concurrent-ok\n");
      rmSync(marker, { force: true });
      await assertNoLiveSupervisors(h);
    } finally {
      await cleanupOwnTree(h, marker);
    }
  },
);

// G6 — launch proof fails closed: an unlaunchable executable never reports
// success through the production path.
test(
  "real-host pin: an unlaunchable executable fails closed and never reports success",
  { timeout: 55_000 },
  async (t) => {
    const h = needsJob(t);
    if (!h) return;
    const recordsBefore = recordCount(h);
    const call = runnerCall("process.run", h);
    let outcome: string;
    try {
      const result = await h.binding.commandExecution.execute({
        executable: "aiboard-px2t-missing-executable-xyz",
        arguments: [],
        workingDirectory: h.project,
        timeoutMs: 20_000,
        context: call.context,
      });
      outcome = `${result.process.outcome}/${result.process.cleanup.state}`;
    } catch (error) {
      outcome = `threw:${error instanceof Error ? error.message : String(error)}`;
    }
    // Tight form: any unrelated throw must not pass as a launch proof refusal.
    assert.match(outcome, /launch was not proven|launch_not_proven|launch_failed/i, `launch must fail closed, got: ${outcome}`);
    assert.doesNotMatch(outcome, /\/verified_empty/, `failed launch must not prove empty: ${outcome}`);
    assert.ok(
      recordCount(h) - recordsBefore <= 1,
      "a failed launch must not accumulate live Job state",
    );
    await assertNoLiveSupervisors(h);
  },
);

// G8 — output bounds under a flood: 8 MiB of stdout completes with exact
// totals, a bounded tail, and bounded spill — nothing silently lost or kept.
test(
  "real-host pin: an 8 MiB output flood stays bounded with exact totals",
  { timeout: 55_000 },
  async (t) => {
    const h = needsJob(t);
    if (!h) return;
    const megabytes = 8;
    const script =
      `const chunk='x'.repeat(1024*1024);` +
      `for(let i=0;i<${megabytes};i++)process.stdout.write(chunk);`;
    const result = await runNode(h, ["-e", script], { timeoutMs: 30_000 });
    assert.equal(result.process.outcome, "exited");
    assert.equal(result.process.exitCode, 0);
    assert.equal(result.process.cleanup.state, "verified_empty");
    const stdout = result.process.output.find((stream) => stream.stream === "stdout")!;
    assert.equal(stdout.totalBytes, megabytes * 1024 * 1024);
    assert.equal(stdout.truncated, true);
    assert.ok(
      (stdout.tailByteLength ?? 0) <= 128 * 1024 + 1024,
      `tail must stay at the 128 KiB bound, got ${stdout.tailByteLength}`,
    );
    assert.ok((stdout.spillBytes ?? 0) <= 64 * 1024 * 1024, "spill must stay under its cap");
    let spillBytes = 0;
    for (const entry of readdirSync(h.runRoot)) {
      if (!entry.startsWith("subprocess-output-")) continue;
      const walk = (directory: string): void => {
        for (const name of readdirSync(directory)) {
          const path = join(directory, name);
          const stat = statSync(path);
          if (stat.isDirectory()) walk(path);
          else spillBytes += stat.size;
        }
      };
      walk(join(h.runRoot, entry));
    }
    assert.ok(spillBytes <= 12 * 1024 * 1024, `run spill must stay bounded, got ${spillBytes}`);
    await assertNoLiveSupervisors(h);
  },
);

// G9 — correct output attribution between two concurrent calls: interleaved
// distinct output must land byte-exact in its own call.
test(
  "real-host pin: two concurrent calls keep byte-exact output attribution",
  { timeout: 55_000 },
  async (t) => {
    const h = needsJob(t);
    if (!h) return;
    const lines = 300;
    const scriptFor = (tag: string) =>
      `for(let i=0;i<${lines};i++)console.log(${JSON.stringify(tag)}+'-'+i);`;
    const expected = (tag: string) => Array.from({ length: lines }, (_, i) => `${tag}-${i}`).join("\n") + "\n";
    const [a, b] = await Promise.all([
      runNode(h, ["-e", scriptFor("px2t-call-A")], { timeoutMs: 30_000, captureOutputBytes: 1024 * 1024 }),
      runNode(h, ["-e", scriptFor("px2t-call-B")], { timeoutMs: 30_000, captureOutputBytes: 1024 * 1024 }),
    ]);
    for (const [name, result, tag] of [
      ["A", a, "px2t-call-A"],
      ["B", b, "px2t-call-B"],
    ] as const) {
      assert.equal(result.process.outcome, "exited", name);
      assert.equal(result.process.cleanup.state, "verified_empty", name);
      assert.equal(result.capturedOutput!.complete, true, name);
      assert.equal(Buffer.from(result.capturedOutput!.stdout).toString("utf8"), expected(tag), `${name} attribution`);
    }
    await assertNoLiveSupervisors(h);
  },
);

// G10 — deadlines are mechanical: a short command deadline kills promptly,
// verified-empty, well inside its bound — it never hangs.
test(
  "real-host pin: a command deadline kills mechanically within its bound",
  { timeout: 55_000 },
  async (t) => {
    const h = needsJob(t);
    if (!h) return;
    const marker = join(h.root, `px2t-deadline-${randomUUID().slice(0, 8)}.pid`);
    try {
      const started = Date.now();
      // 3 s deadline: the tree needs ~1 s to appear, so 1.5 s left ~0.4 s of
      // margin under load; 3 s keeps the same promptness pin with headroom.
      const result = await runNode(h, ["-e", treeScript(marker)], { timeoutMs: 3_000 });
      const elapsed = Date.now() - started;
      assert.equal(result.process.outcome, "timed_out");
      assert.equal(result.process.cleanup.state, "verified_empty");
      assert.ok(elapsed < 20_000, `deadline must kill promptly, took ${elapsed}ms`);
      const grandchildPid = Number(readFileSync(marker, "utf8").trim());
      assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0, "marker must hold the grandchild PID");
      // Short grace (see T4): the pristine path kills before settling.
      await waitForDeath([grandchildPid], 2_000, "deadline-killed grandchild");
      rmSync(marker, { force: true });
      await assertNoLiveSupervisors(h);
    } finally {
      await cleanupOwnTree(h, marker);
    }
  },
);

// G7 — process-birth identity against PID reuse on the real Job backend: a
// binding whose birth no longer matches the live record is rejected as
// identity_mismatch before any service action, while the valid birth works.
// The executor never surfaces backend bindings, so this drives the real
// backend + real Job host directly — the same components the host wires.
// Scope note: this pins only the first of three identity layers (the
// jobIdentity discriminator compare); the lane-identity and startedAt
// re-attestation layers refuse the same stale binding further down, but no
// test here drives a stale *in-flight* record through the production path.
test(
  "real-host pin: process-birth identity rejects a reused birth on the real Job backend",
  { timeout: 55_000 },
  async (t) => {
    if (process.platform !== "win32") {
      t.skip(WINDOWS_SKIP);
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "aiboard-px2t-birth-"));
    t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const service = createWindowsJobProcessHost({
      stateDirectory: join(root, "job-host"),
      startDeadlineMs: 15_000,
      stopDeadlineMs: 15_000,
    });
    const backend = createWindowsProcessBackend({
      jobObjects: { service },
      semanticFacts: {
        portableDuplex: "verified",
        windowsBatchArgv: "verified",
        exactTreeBirth: "partial",
        jobContainment: "verified",
      },
    });
    const fence: ProcessEffectFence = { ownerId: "px2t-birth", fencingToken: 1 };
    const allowedEnv = ((): Record<string, string> => {
      const keep = new Set(["systemroot", "windir", "comspec", "path", "pathext", "temp", "tmp"]);
      return Object.fromEntries(
        Object.entries(process.env).filter(([key, value]) => value !== undefined && keep.has(key.toLowerCase())),
      ) as Record<string, string>;
    })();
    const launchRequest = (invocationId: string) => ({
      intent: {
        invocationId,
        runId: "px2t-birth",
        kind: "command" as const,
        executable: process.execPath,
        arguments: ["-e", "process.exit(0)"],
        workingDirectory: workspace,
        requiredLifecycleScope: "process_group" as const,
        requestedCapabilities: [] as const,
      },
      grant: { grantId: `grant-${invocationId}`, runId: "px2t-birth", invocationId, issuedAt: new Date().toISOString(), access: [] },
      environment: allowedEnv,
      outputOwnerId: "px2t-birth-output",
      fence,
    });
    const bind = (launch: ProcessLaunchResult): ProcessBackendBinding =>
      ({
        registryId: "registry",
        backendId: "runner-windows-job-v1",
        implementationGeneration: "px2t",
        implementationDigest: "1".repeat(64),
        attestationVersion: 1,
        attestationDigest: "2".repeat(64),
        ...launch,
      }) as ProcessBackendBinding;
    const settle = async (launch: ProcessLaunchResult, binding: ProcessBackendBinding): Promise<void> => {
      const observed = (await backend.observe(binding, async () => undefined, fence)) as { state: string };
      assert.equal(observed.state, "exited");
      assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, true);
      await backend.release(binding, fence);
    };
    const launchA = parseProcessLaunchResult(await backend.launch(launchRequest("px2t-birth-a")));
    const launchB = parseProcessLaunchResult(await backend.launch(launchRequest("px2t-birth-b")));
    try {
      const idA = JSON.parse(Buffer.from(launchA.opaqueIdentity, "base64url").toString("utf8")) as { processId: string };
      const idB = JSON.parse(Buffer.from(launchB.opaqueIdentity, "base64url").toString("utf8")) as { processId: string };
      assert.notEqual(idA.processId, idB.processId, "sequential calls must never reuse a process identity");
      // Present a stale birth for B's live process: same processId, a
      // startedAt that is not the live one.
      const liveB = JSON.parse(Buffer.from(launchB.opaqueIdentity, "base64url").toString("utf8")) as Record<string, unknown>;
      const staleB = {
        ...launchB,
        opaqueIdentity: Buffer.from(JSON.stringify({ ...liveB, startedAt: "2000-01-01T00:00:00.000Z" })).toString("base64url"),
      };
      assert.deepEqual(parseProcessReconciliation(await backend.reconcile(bind(staleB), fence)), {
        state: "identity_mismatch",
      });
      // The valid birth is unpoisoned and settles exactly empty. Reconcile
      // is point-in-time, so poll until the quick child has exited.
      let validState = "";
      const exitDeadline = Date.now() + 10_000;
      while (validState !== "exited") {
        validState = parseProcessReconciliation(await backend.reconcile(bind(launchB), fence)).state;
        if (validState === "exited") break;
        if (Date.now() >= exitDeadline) break;
        await sleep(100);
      }
      assert.equal(validState, "exited");
      await settle(launchB, bind(launchB));
      await settle(launchA, bind(launchA));
    } finally {
      for (const launch of [launchA, launchB]) {
        try {
          await backend.signal(bind(launch), "force_terminate", fence);
        } catch {
          // Already terminal; reconcile/release below is best-effort.
        }
        try {
          if (parseProcessReconciliation(await backend.reconcile(bind(launch), fence)).state === "exited") {
            try {
              await backend.verifyEmpty(bind(launch), fence);
            } catch {
              // Best-effort.
            }
            await backend.release(bind(launch), fence).catch(() => undefined);
          }
        } catch {
          // Best-effort cleanup only.
        }
      }
    }
    await waitFor(
      () =>
        readdirSync(join(root, "job-host"))
          .filter((entry) => entry.endsWith(".json"))
          .every((entry) => {
            const supervisorPid = (JSON.parse(readFileSync(join(root, "job-host", entry), "utf8")) as {
              supervisor?: { supervisorPid?: unknown };
            }).supervisor?.supervisorPid;
            return typeof supervisorPid !== "number" || !processAlive(supervisorPid);
          }),
      20_000,
      "birth-test supervisors",
    );
  },
);

// G2 — the empty proof is load-bearing (PX-2b changes this path): while a
// descendant lives, `verifyEmpty` reports non-empty and `release` is refused
// by the host layer (`releaseOwned`, windows-job-process-host.ts:247-253);
// once the tree is killed the same binding verifies exactly empty and
// releases. Backend-level control, same harness as T7 (the executor never
// surfaces backend bindings). Also pins the refusal without poisoning the
// main flow: the refused launch is settled through a fresh backend instance.
test(
  "real-host pin: verifyEmpty stays non-empty while a descendant lives and release is refused until empty",
  { timeout: 55_000 },
  async (t) => {
    if (process.platform !== "win32") {
      t.skip(WINDOWS_SKIP);
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "aiboard-px2t-empty-"));
    t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const jobHostDir = join(root, "job-host");
    const service = createWindowsJobProcessHost({
      stateDirectory: jobHostDir,
      startDeadlineMs: 15_000,
      stopDeadlineMs: 15_000,
    });
    const semanticFacts = {
      portableDuplex: "verified",
      windowsBatchArgv: "verified",
      exactTreeBirth: "partial",
      jobContainment: "verified",
    } as const;
    const backend = createWindowsProcessBackend({ jobObjects: { service }, semanticFacts });
    const fence: ProcessEffectFence = { ownerId: "px2t-empty", fencingToken: 1 };
    const allowedEnv = ((): Record<string, string> => {
      const keep = new Set(["systemroot", "windir", "comspec", "path", "pathext", "temp", "tmp"]);
      return Object.fromEntries(
        Object.entries(process.env).filter(([key, value]) => value !== undefined && keep.has(key.toLowerCase())),
      ) as Record<string, string>;
    })();
    const markerFor = (name: string) => join(root, `${name}.pid`);
    const launchRequest = (invocationId: string, marker: string) => ({
      intent: {
        invocationId,
        runId: "px2t-empty",
        kind: "command" as const,
        executable: process.execPath,
        arguments: ["-e", treeScript(marker)],
        workingDirectory: workspace,
        requiredLifecycleScope: "process_group" as const,
        requestedCapabilities: [] as const,
      },
      grant: { grantId: `grant-${invocationId}`, runId: "px2t-empty", invocationId, issuedAt: new Date().toISOString(), access: [] },
      environment: allowedEnv,
      outputOwnerId: "px2t-empty-output",
      fence,
    });
    const bind = (launch: ProcessLaunchResult): ProcessBackendBinding =>
      ({
        registryId: "registry",
        backendId: "runner-windows-job-v1",
        implementationGeneration: "px2t",
        implementationDigest: "1".repeat(64),
        attestationVersion: 1,
        attestationDigest: "2".repeat(64),
        ...launch,
      }) as ProcessBackendBinding;
    const readMarker = (marker: string): number | undefined => {
      try {
        const pid = Number(readFileSync(marker, "utf8").trim());
        return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
      } catch {
        return undefined;
      }
    };
    const readBackendRecords = (): Array<{ pid: number; supervisorPid: number }> => {
      let entries: string[];
      try {
        entries = readdirSync(jobHostDir).filter((entry) => entry.endsWith(".json"));
      } catch {
        return [];
      }
      const out: Array<{ pid: number; supervisorPid: number }> = [];
      for (const file of entries) {
        try {
          const raw = JSON.parse(readFileSync(join(jobHostDir, file), "utf8")) as {
            pid?: unknown;
            supervisor?: { supervisorPid?: unknown };
          };
          out.push({
            pid: typeof raw.pid === "number" ? raw.pid : 0,
            supervisorPid: typeof raw.supervisor?.supervisorPid === "number" ? raw.supervisor.supervisorPid : 0,
          });
        } catch {
          continue;
        }
      }
      return out;
    };
    const marker = markerFor("grandchild");
    const launch = parseProcessLaunchResult(await backend.launch(launchRequest("px2t-empty-main", marker)));
    const binding = bind(launch);
    let second: { binding: ProcessBackendBinding; marker: string } | undefined;
    try {
      let observedSettled = false;
      const observed = backend.observe(binding, async () => undefined, fence).then((result) => {
        observedSettled = true;
        return result;
      });
      // Tree up, then 1.5 s with the detached descendant alive.
      await waitFor(() => existsSync(marker), 15_000, "empty-control tree marker");
      await sleep(1500);
      assert.deepEqual(
        parseProcessReconciliation(await backend.reconcile(binding, fence)),
        { state: "running" },
        "tree must still be running with its descendant alive",
      );
      // The pin an always-true verifyEmpty would break.
      assert.equal(
        parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty,
        false,
        "verifyEmpty must report non-empty while the descendant lives",
      );
      assert.equal(observedSettled, false, "observe must still be pending while the descendant lives");
      // Release refusal on a second live tree: refused, never silent.
      const marker2 = markerFor("grandchild-2");
      const launch2 = parseProcessLaunchResult(await backend.launch(launchRequest("px2t-empty-refuse", marker2)));
      second = { binding: bind(launch2), marker: marker2 };
      await waitFor(() => existsSync(marker2), 15_000, "refusal tree marker");
      assert.deepEqual(parseProcessReconciliation(await backend.reconcile(second.binding, fence)), {
        state: "running",
      });
      await assert.rejects(backend.release(second.binding, fence), /not verified terminal/);
      // The refused launch is still killable: settle it through a fresh
      // backend instance (the first instance's lane for it stays closed by
      // design) and prove the same binding releases once empty.
      const backendB = createWindowsProcessBackend({ jobObjects: { service }, semanticFacts });
      assert.deepEqual(parseProcessReconciliation(await backendB.signal(second.binding, "force_terminate", fence)), {
        state: "exited",
      });
      let secondState = "";
      const secondDeadline = Date.now() + 10_000;
      while (secondState !== "exited") {
        secondState = parseProcessReconciliation(await backendB.reconcile(second.binding, fence)).state;
        if (secondState === "exited") break;
        if (Date.now() >= secondDeadline) break;
        await sleep(100);
      }
      assert.equal(secondState, "exited");
      assert.equal(parseProcessEmptyVerification(await backendB.verifyEmpty(second.binding, fence)).empty, true);
      await backendB.release(second.binding, fence);
      const grandchild2 = readMarker(marker2);
      assert.ok(grandchild2 !== undefined, "refusal marker must hold the grandchild PID");
      await waitForDeath([grandchild2], 2_000, "refused-then-killed grandchild");
      // Main flow: kill the tree, observe the exit, verify exactly empty.
      assert.deepEqual(parseProcessReconciliation(await backend.signal(binding, "force_terminate", fence)), {
        state: "exited",
      });
      assert.deepEqual(parseProcessReconciliation(await observed), { state: "exited" });
      assert.equal(observedSettled, true);
      assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, true);
      await backend.release(binding, fence);
      const grandchild = readMarker(marker);
      assert.ok(grandchild !== undefined, "marker must hold the grandchild PID");
      await waitForDeath([grandchild], 2_000, "empty-control grandchild at release");
    } finally {
      // Red-run cleanup, identified PIDs only: marker PIDs plus the PIDs in
      // this backend's own Job records. Green runs find nothing alive.
      for (const target of [binding, second?.binding]) {
        if (!target) continue;
        try {
          await backend.signal(target, "force_terminate", fence);
        } catch {
          // Lane closed or already terminal: OS-level kill below covers it.
        }
      }
      const pids: number[] = [];
      for (const markerPath of [marker, second?.marker]) {
        if (!markerPath) continue;
        const pid = readMarker(markerPath);
        if (pid !== undefined) pids.push(pid);
      }
      for (const record of readBackendRecords()) {
        if (record.pid > 0) pids.push(record.pid);
        if (record.supervisorPid > 0) pids.push(record.supervisorPid);
      }
      await killIdentifiedPids(pids);
      for (const target of [binding, second?.binding]) {
        if (!target) continue;
        try {
          if (parseProcessReconciliation(await backend.reconcile(target, fence)).state === "exited") {
            try {
              await backend.verifyEmpty(target, fence);
            } catch {
              // Best-effort.
            }
            await backend.release(target, fence).catch(() => undefined);
          }
        } catch {
          // Best-effort cleanup only.
        }
      }
    }
    await waitFor(
      () =>
        readBackendRecords().every(
          (record) => record.supervisorPid < 1 || !processAlive(record.supervisorPid),
        ),
      20_000,
      "empty-test supervisors",
    );
  },
);

// G11 — durable audit on the real host: a real call appends tamper-evident
// invocation records (HMAC integrity per revision), and editing a record in a
// copy fails the integrity check on read.
test(
  "real-host pin: a real call leaves tamper-evident durable audit records",
  { timeout: 55_000 },
  async (t) => {
    const h = needsJob(t);
    if (!h) return;
    const key = readFileSync(join(h.runRoot, "subprocess-runtime.key"));
    const openKernel = (path: string, readOnly: boolean) =>
      openSqliteDurableProcessKernel(path, new Uint8Array(key), readOnly ? { readOnly: true } : {});
    const readIds = (): string[] => {
      const kernel = openKernel(h.dbPath, true);
      try {
        return [...kernel.store.listRowIds()];
      } finally {
        kernel.store.close();
      }
    };
    const before = new Set(readIds());
    assert.ok(before.size >= 1, "the selection probe must already be journaled");
    await h.binding.git.lifecycle("integration").run({ cwd: h.project, args: ["rev-parse", "HEAD"] });
    const after = readIds();
    const fresh = after.filter((id) => !before.has(id));
    assert.ok(fresh.length >= 1, "a real call must append invocation records");
    const kernel = openKernel(h.dbPath, true);
    try {
      const record = kernel.store.readByInvocation(fresh[0]!)!;
      const json = JSON.stringify(record);
      assert.match(json, /verified_empty/, "the journal must record the empty proof");
      assert.match(json, /exited/, "the journal must record the exit");
    } finally {
      kernel.store.close();
    }
    const raw = new DatabaseSync(h.dbPath, { readOnly: true });
    try {
      const integrity = raw.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
      assert.equal(integrity.integrity_check, "ok");
      const rows = raw.prepare("SELECT invocation_id, integrity FROM durable_processes").all() as Array<{
        invocation_id: string;
        integrity: string;
      }>;
      assert.ok(rows.length >= 1);
      for (const row of rows) assert.match(row.integrity ?? "", /\S/, `row ${row.invocation_id} must carry an integrity tag`);
    } finally {
      raw.close();
    }
    // Tamper-evidence: editing a record in a COPY fails on read.
    const copyPath = join(h.root, `px2t-tampered-${randomUUID().slice(0, 8)}.sqlite`);
    copyFileSync(h.dbPath, copyPath);
    let victimId = "";
    try {
      const copy = new DatabaseSync(copyPath);
      try {
        const victim = copy.prepare("SELECT invocation_id, record_json FROM durable_processes LIMIT 1").get() as {
          invocation_id: string;
          record_json: string;
        };
        victimId = victim.invocation_id;
        copy.prepare("UPDATE durable_processes SET record_json = ? WHERE invocation_id = ?").run(
          `${victim.record_json} `,
          victim.invocation_id,
        );
      } finally {
        copy.close();
      }
      const tampered = openKernel(copyPath, false);
      try {
        assert.ok(tampered.store.listRowIds().includes(victimId), "the tampered row must still be listed");
        assert.throws(() => tampered.store.readByInvocation(victimId), /corrupt|integrity mismatch/i);
      } finally {
        tampered.store.close();
      }
    } finally {
      rmSync(copyPath, { force: true });
    }
    await assertNoLiveSupervisors(h);
  },
);

// G12 (PARTIAL) — recovery reports an in-flight launch fail-closed without
// relaunch, on the real host. Part A gives recover() real work: a launch whose
// owner stopped driving it is reported as effect_outcome_unresolved, never
// relaunched, never a success, and the launch itself is undisturbed (it still
// times out normally). No runner crash is simulated, and the launch is not
// orphaned or reconciled: takeover, lease expiry and reconcile of an orphan
// stay untested on the real host (review r2; see the evidence file). Part B
// keeps the host-death audit pins: a killed call never gains an exit code,
// live or durably.
test(
  "real-host pin: recovery reports an in-flight launch fail-closed and host death leaves no exit code",
  { timeout: 55_000 },
  async (t) => {
    const h = needsJob(t);
    if (!h) return;
    const markerA = join(h.root, `px2t-recover-${randomUUID().slice(0, 8)}.pid`);
    const markerB = join(h.root, `px2t-crash-${randomUUID().slice(0, 8)}.pid`);
    const host2Root = join(h.root, `px2t-recover-host-${randomUUID().slice(0, 8)}`);
    const host2State = join(host2Root, "state");
    mkdirSync(host2State, { recursive: true });
    const host2 = createExecutionHost({
      projectRoot: h.project,
      stateDirectory: host2State,
      artifacts: new ArtifactStore(join(host2State, "artifacts")),
      ambientEnvironment: { ...process.env },
    });
    const runId2 = `px2t-recover-${randomUUID()}`;
    const binding2 = await host2.bindRun({
      runId: runId2,
      permissionProfile: "full",
      capabilityContract: { digest: "b".repeat(64) } as RunnerCapabilityContract,
      capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
    });
    const jobHostDir2 = join(host2State, "managed-processes-job-host");
    const recordFiles2 = () => {
      try {
        return readdirSync(jobHostDir2).filter((entry) => entry.endsWith(".json")).sort();
      } catch {
        return [];
      }
    };
    const supervisors2 = () =>
      readJobRecordDir(jobHostDir2)
        .map((record) => record.supervisorPid)
        .filter((pid) => pid > 0)
        .sort((a, b) => a - b);
    // A live orphaned launch on the second host: owner stops driving it here.
    callSeq += 1;
    const callId2 = `px2t-recover-call-${callSeq}`;
    const pending2 = binding2.commandExecution.execute({
      executable: process.execPath,
      arguments: ["-e", treeScript(markerA)],
      workingDirectory: h.project,
      timeoutMs: 12_000,
      context: {
        runId: runId2,
        sessionId: `session-${runId2}`,
        actor: { role: "worker" as const, id: "worker-px2t" },
        callId: callId2,
        toolName: "process.run",
        runnerInternal: true as const,
      },
    });
    pending2.then(
      () => undefined,
      () => undefined,
    );
    try {
      await waitFor(
        () => existsSync(markerA) && findRecordByMarkerInDir(jobHostDir2, markerA) !== undefined,
        15_000,
        "orphaned launch Job record and marker",
      );
      const filesBefore = recordFiles2();
      const supervisorsBefore = supervisors2();
      // Real recovery work on a live launch: reconcile, report, do not touch.
      const recovery = await binding2.recover({ maxRecords: 256, timeoutMs: 10_000 });
      const invocationId2 = `inv-${createHash("sha256").update(`${runId2}\0session-${runId2}\0${callId2}`).digest("hex")}`;
      const mine = recovery.subprocess.find((outcome) => outcome.invocationId === invocationId2);
      assert.ok(mine, "recovery must report the orphaned live launch (it has work)");
      assert.doesNotMatch(
        String((mine as { state?: unknown }).state ?? ""),
        /exited|cleaned|success/i,
        `recovery must not report success for a live launch: ${JSON.stringify(mine)}`,
      );
      assert.deepEqual(recordFiles2(), filesBefore, "recovery must not relaunch (no new Job records)");
      assert.deepEqual(supervisors2(), supervisorsBefore, "recovery must not spawn new supervisors");
      // The launch is undisturbed: it still times out normally with its tree.
      const settled2 = await pending2;
      assert.equal(settled2.process.outcome, "timed_out", JSON.stringify(settled2.process.cleanup));
      assert.equal(settled2.process.cleanup.state, "verified_empty");
      const grandchildA = Number(readFileSync(markerA, "utf8").trim());
      assert.ok(Number.isSafeInteger(grandchildA) && grandchildA > 0, "marker must hold the grandchild PID");
      await waitForDeath([grandchildA], 2_000, "orphaned grandchild after timeout");
      rmSync(markerA, { force: true });
      const supervisor2 = supervisors2()[0];
      if (supervisor2 !== undefined) await waitForDeath([supervisor2], 20_000, "orphaned supervisor linger");

      // Part B: host death on the main binding — no exit code, live or durably.
      const launched = await launchTreeCall(h, markerB, 15_000);
      let childPid = 0;
      await waitFor(() => {
        const record = readJobRecords(h).find((entry) => entry.processId === launched.processId);
        if (!record || record.pid <= 0) return false;
        childPid = record.pid;
        return true;
      }, 10_000, "child PID in the Job record");
      const supervisorPid = launched.record.supervisorPid;
      let hostPid = 0;
      await waitFor(() => {
        const found = childPowershellOf(supervisorPid);
        if (found === undefined) return false;
        hostPid = found;
        return true;
      }, 10_000, "Job-host powershell under the supervisor");
      process.kill(hostPid);
      await waitForDeath([childPid, launched.grandchildPid], 10_000, "tree after Job-host death");
      const settled = await launched.pending;
      const clean =
        settled.process.outcome === "exited" &&
        settled.process.cleanup.state === "verified_empty" &&
        settled.process.exitCode === 0;
      assert.equal(clean, false, `crashed call must never report clean success (got ${settled.process.outcome})`);
      // The host died before reporting any exit status: the call must never
      // gain an exit code — live in the result or durably. Downstream gates
      // (the git runner requires a safe-integer exit code) fail closed on this.
      assert.equal(
        Number.isSafeInteger(settled.process.exitCode),
        false,
        `crashed call must report no exit code, got ${settled.process.exitCode}`,
      );
      const invocationId = `inv-${createHash("sha256").update(`${h.runId}\0session-${h.runId}\0${launched.callId}`).digest("hex")}`;
      const audit = openSqliteDurableProcessKernel(h.dbPath, new Uint8Array(readFileSync(join(h.runRoot, "subprocess-runtime.key"))), {
        readOnly: true,
      });
      try {
        const stored = audit.store.readByInvocation(invocationId);
        assert.ok(stored, "the crashed call must leave a durable record");
        const storedExit = (stored.result as { exitCode?: unknown } | undefined)?.exitCode;
        assert.equal(
          Number.isSafeInteger(storedExit),
          false,
          `durable record must report no exit code, got ${storedExit}`,
        );
      } finally {
        audit.store.close();
      }
      rmSync(markerB, { force: true });
      await assertNoLiveSupervisors(h);
    } finally {
      // Red-run cleanup: identified PIDs only, both markers and both Job dirs
      // (the host powershell holds the cwd lock — killing it is what lets the
      // temp-root removal succeed on a red run).
      await cleanupOwnTree(h, markerB);
      await cleanupOwnTreeInDir(jobHostDir2, markerA);
      // Let the orphaned call finish journaling before close: closing while
      // its execute is still settling leaves open handles that block the
      // temp-root removal with EPERM. Bounded: a truly hung call still falls
      // through (and its 90 s self-exit bounds the leak).
      await Promise.race([pending2.then(
        () => undefined,
        () => undefined,
      ), sleep(20_000)]);
      try {
        await binding2.close();
      } catch {
        // Best-effort: the tree may still be settling.
      }
      try {
        await host2.close();
      } catch {
        // Best-effort.
      }
      // Let killed/lingering supervisors exit before removing the root:
      // without this, removal races the normal ~4 s linger and a red run
      // reports EPERM instead of the body's assertion. A genuine leak still
      // surfaces (the wait times out and the removal below fails).
      try {
        await waitFor(
          () =>
            readJobRecordDir(jobHostDir2).every(
              (record) => record.supervisorPid < 1 || !processAlive(record.supervisorPid),
            ),
          20_000,
          "host2 supervisors before temp-root removal",
        );
      } catch {
        // Removal below reports a genuine leak.
      }
      rmSync(host2Root, { recursive: true, force: true });
    }
  },
);

// PX-2e: no supervisor or Job host started by this file (temp roots
// `aiboard-px2t-*`) may still be alive at file end. The per-test record
// gates above stay authoritative; this process-level guard additionally
// covers supervisors without a record. Leftovers are recorded, killed, and
// reported here.
after(async () => {
  await checkNoWindowsJobProcessesLeft(["aiboard-px2t-"]);
});
