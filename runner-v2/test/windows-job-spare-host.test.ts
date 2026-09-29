// PX-2c — pre-started spare Job-host pair, real-host tests (`runner-windows-job-v1`).
//
// One supervisor plus one PowerShell Job host wait idle with NO Job and NO
// child; the next call claims the pair over the private stdin/IPC channel and
// then runs its OWN Job (suspended-create, assign, resume, kill-on-close)
// exactly as today. The spare serves exactly one call and is never reused.
//
// Skip policy: clean `t.skip` when not on Windows or when the Job backend is
// not selected (same empirical probe as PX-2t). Every test leaves no process
// behind; per-test timeouts are <= 55 s; tree tests self-exit after 90 s and
// kill only identified PIDs in a `finally`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { after, before, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost, type ExecutionHost, type ExecutionHostRunBinding } from "../src/execution-host.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { createWindowsJobProcessHost, type WindowsJobProcessHost } from "../src/windows-job-process-host.js";

const here = dirname(fileURLToPath(import.meta.url));
const tsxPath = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));

const WINDOWS_SKIP = "PX-2c spare pin requires a Windows host.";
const BACKEND_SKIP = "PX-2c spare pin requires the runner-windows-job-v1 backend to be selected.";

interface Px2cHarness {
  readonly host: ExecutionHost;
  readonly service: WindowsJobProcessHost;
  readonly binding: ExecutionHostRunBinding;
  readonly root: string;
  readonly project: string;
  readonly stateDir: string;
  readonly jobHostDir: string;
  readonly runId: string;
  readonly sessionId: string;
}

let harness: Px2cHarness | undefined;
let jobBackendSelected = false;
let callSeq = 0;
let preExistingSupervisorPids = new Set<number>();

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`px2c: ${what} did not settle within ${timeoutMs}ms`);
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
  execFileSync("git", ["-C", directory, "config", "user.email", "px2c@example.test"]);
  execFileSync("git", ["-C", directory, "config", "user.name", "px2c"]);
  writeFileSync(join(directory, "f.txt"), "px2c\n");
  execFileSync("git", ["-C", directory, "add", "."]);
  execFileSync("git", ["-C", directory, "commit", "-qm", "px2c"]);
}

interface SpareRecordView {
  readonly file: string;
  readonly processId: string;
  readonly pid: number;
  readonly supervisorPid: number;
  readonly args: readonly string[];
  readonly command: string;
  readonly spare: boolean;
  readonly spareClaimed: boolean;
}

function readSpareRecords(jobHostDir: string): SpareRecordView[] {
  let entries: string[];
  try {
    entries = readdirSync(jobHostDir).filter((entry) => entry.endsWith(".json"));
  } catch {
    return [];
  }
  const records: SpareRecordView[] = [];
  for (const file of entries) {
    try {
      const raw = JSON.parse(readFileSync(join(jobHostDir, file), "utf8")) as {
        processId?: unknown;
        pid?: unknown;
        args?: unknown;
        command?: unknown;
        spare?: unknown;
        spareClaimed?: unknown;
        supervisor?: { supervisorPid?: unknown };
      };
      if (typeof raw.processId !== "string") continue;
      records.push({
        file,
        processId: raw.processId,
        pid: typeof raw.pid === "number" ? raw.pid : 0,
        supervisorPid:
          typeof raw.supervisor?.supervisorPid === "number" ? (raw.supervisor.supervisorPid as number) : 0,
        args: Array.isArray(raw.args) ? raw.args.filter((entry): entry is string => typeof entry === "string") : [],
        command: typeof raw.command === "string" ? raw.command : "",
        spare: raw.spare === true,
        spareClaimed: raw.spareClaimed === true,
      });
    } catch {
      continue;
    }
  }
  return records;
}

function findRecordByToken(jobHostDir: string, token: string): SpareRecordView | undefined {
  return readSpareRecords(jobHostDir).find((record) => record.args.some((arg) => arg.includes(token)));
}

function readStatusLines(jobHostDir: string, processId: string): Array<Record<string, unknown>> {
  const path = join(jobHostDir, processId, "supervisor.jsonl");
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** Zero-leftover gate: every supervisor THIS run started must be gone. */
async function assertNoLiveSupervisors(jobHostDir: string, timeoutMs = 20_000): Promise<void> {
  await waitFor(
    () =>
      readSpareRecords(jobHostDir).every(
        (record) =>
          record.supervisorPid < 1 ||
          preExistingSupervisorPids.has(record.supervisorPid) ||
          !processAlive(record.supervisorPid),
      ),
    timeoutMs,
    "Job supervisors of this run",
  );
}

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

async function cleanupOwnTree(jobHostDir: string, marker: string): Promise<void> {
  const pids: number[] = [];
  try {
    const grandchild = Number(readFileSync(marker, "utf8").trim());
    if (Number.isSafeInteger(grandchild) && grandchild > 0) pids.push(grandchild);
  } catch {
    // Marker never written (launch itself failed): nothing tree-shaped to kill.
  }
  const record = readSpareRecords(jobHostDir).find((entry) =>
    entry.args.some((arg) => arg.includes(basename(marker))),
  );
  if (record) {
    if (record.pid > 0) pids.push(record.pid);
    if (record.supervisorPid > 0) {
      const hostPid = childPowershellOf(record.supervisorPid);
      if (hostPid !== undefined) pids.push(hostPid);
      pids.push(record.supervisorPid);
    }
  }
  await killIdentifiedPids(pids);
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

function needsJob(t: TestContext): Px2cHarness | undefined {
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

function spareOwner(h: { runId: string; sessionId: string }): { runId: string; sessionId: string } {
  return { runId: h.runId, sessionId: h.sessionId };
}

async function prestartSpareOrFail(
  service: WindowsJobProcessHost,
  owner: { runId: string; sessionId: string },
): Promise<{ processId: string; supervisorPid: number }> {
  assert.equal(typeof service.prestartSpare, "function", "host must offer prestartSpare");
  const spare = await service.prestartSpare!(owner);
  assert.ok(spare.processId.length > 0, "spare must have a processId");
  assert.ok(spare.supervisorPid > 0, "spare must have a supervisorPid");
  return spare;
}

/** One production-shaped node call carrying a unique argv token. */
async function runTokenCall(
  binding: ExecutionHostRunBinding,
  h: { project: string; runId: string; sessionId: string; jobHostDir: string },
  token: string,
  timeoutMs = 30_000,
): Promise<{ stdout: string; processId: string }> {
  callSeq += 1;
  const callId = `px2c-${callSeq}-${randomUUID().slice(0, 8)}`;
  const script = `console.log(${JSON.stringify(`px2c-token:${token}`)});`;
  const result = await binding.commandExecution.execute({
    executable: process.execPath,
    arguments: ["-e", script],
    workingDirectory: h.project,
    timeoutMs,
    captureOutputBytes: 1024 * 1024,
    context: {
      runId: h.runId,
      sessionId: h.sessionId,
      actor: { role: "worker" as const, id: "worker-px2c" },
      callId,
      toolName: "process.run",
      runnerInternal: true as const,
    },
  });
  const record = findRecordByToken(h.jobHostDir, token);
  assert.ok(record, "token call must leave a findable Job record");
  const proc = (result as { process?: { outcome?: unknown; exitCode?: unknown; cleanup?: { state?: unknown } } }).process;
  assert.equal(proc?.outcome, "exited", "token call must exit");
  assert.equal(proc?.exitCode, 0, "token call must exit 0");
  assert.equal(proc?.cleanup?.state, "verified_empty", "token call must verify empty");
  const captured = (result as { capturedOutput?: { stdout?: Uint8Array } }).capturedOutput;
  const stdout = captured?.stdout ? Buffer.from(captured.stdout).toString("utf8") : "";
  assert.equal(stdout, `px2c-token:${token}\n`, "token call stdout must be byte-exact");
  return { stdout, processId: record.processId };
}

/** A TERM-ignoring parent plus a detached TERM-ignoring grandchild (PX-2t shape). */
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

before(async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-px2c-"));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  initGitRepo(project);
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const jobHostDir = join(stateDir, "managed-processes-job-host");
  const service = createWindowsJobProcessHost({ stateDirectory: jobHostDir });
  const host = createExecutionHost({
    projectRoot: project,
    stateDirectory: stateDir,
    artifacts: new ArtifactStore(join(stateDir, "artifacts")),
    ambientEnvironment: { ...process.env },
    windowsJobHost: service,
  });
  const runId = `px2c-${randomUUID()}`;
  const sessionId = `session-${runId}`;
  const binding = await host.bindRun({
    runId,
    permissionProfile: "full",
    capabilityContract: { digest: "c".repeat(64) } as RunnerCapabilityContract,
    capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
  });
  harness = { host, service, binding, root, project, stateDir, jobHostDir, runId, sessionId };
  // Selection probe: one production git call must leave Job-host records,
  // which only the runner-windows-job-v1 backend writes.
  await binding.git.lifecycle("integration").run({ cwd: project, args: ["rev-parse", "HEAD"] });
  jobBackendSelected = readdirSync(jobHostDir).filter((entry) => entry.endsWith(".json")).length > 0;
  preExistingSupervisorPids = new Set(
    readSpareRecords(jobHostDir)
      .map((record) => record.supervisorPid)
      .filter((pid) => pid > 0 && processAlive(pid)),
  );
}, { timeout: 90_000 });

after(async () => {
  if (!harness) return;
  const h = harness;
  harness = undefined;
  try {
    await h.service.retireSpare?.();
  } catch {
    // Cleanup best-effort; the leftover assertions already ran per test.
  }
  try {
    await h.binding.close();
  } catch {
    // Same as above.
  }
  try {
    await h.host.close();
  } catch {
    // Same as above.
  }
  rmSync(h.root, { recursive: true, force: true });
});

// S1 — a call claims the spare and keeps all its own proofs: the call runs on
// the spare's processId with its own Job, exits 0, verifies empty, and keeps
// byte-exact output. The spare record flips to claimed.
test("spare pin: a call claims the spare and keeps its own proofs", { timeout: 55_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  const spare = await prestartSpareOrFail(h.service, spareOwner(h));
  assert.ok(processAlive(spare.supervisorPid), "spare supervisor must be alive while waiting");
  // The spare holds NO Job and NO child: nothing has been handed to the Job
  // host yet (no event file), its record carries no command, and the durable
  // supervisor status is still starting with no child.
  const recordBefore = readSpareRecords(h.jobHostDir).find((entry) => entry.processId === spare.processId);
  assert.ok(recordBefore, "spare must be recorded durably like a launch");
  assert.equal(recordBefore!.spare, true, "spare record must carry the spare mark");
  assert.equal(recordBefore!.spareClaimed, false, "spare record must start unclaimed");
  assert.equal(recordBefore!.command, "", "spare record must carry no command before its call");
  assert.ok(!existsSync(join(h.jobHostDir, spare.processId, "job-events.jsonl")), "no Job event may exist before the claim");
  const statusBefore = readStatusLines(h.jobHostDir, spare.processId).at(-1);
  assert.equal(statusBefore?.["status"], "starting", "spare supervisor must still be starting");
  assert.equal(statusBefore?.["childPid"], 0, "spare must have no child");
  assert.equal(statusBefore?.["spare"], true, "spare status must carry the spare mark");
  assert.equal(statusBefore?.["claimed"], false, "spare status must start unclaimed");
  const token = `s1-${randomUUID().slice(0, 8)}`;
  const { processId } = await runTokenCall(h.binding, h, token);
  assert.equal(processId, spare.processId, "the call must run on the claimed spare pair");
  const recordAfter = readSpareRecords(h.jobHostDir).find((entry) => entry.processId === spare.processId);
  assert.equal(recordAfter?.spareClaimed, true, "the spare record must flip to claimed");
  const stats = h.service.spareStats?.();
  assert.equal(stats?.claims, 1, "one claim must be counted");
  await assertNoLiveSupervisors(h.jobHostDir);
});

// S2 — the claimed spare still kills exactly its own call's tree: a
// TERM-ignoring tree claimed through the spare times out verified-empty with
// its grandchild dead, while the spare's boot is not paid again.
test("spare pin: a claimed spare kills its own call tree on timeout", { timeout: 55_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  const spare = await prestartSpareOrFail(h.service, spareOwner(h));
  const marker = join(h.root, `px2c-tree-${randomUUID().slice(0, 8)}.pid`);
  try {
    callSeq += 1;
    const callId = `px2c-tree-${callSeq}-${randomUUID().slice(0, 8)}`;
    const pending = h.binding.commandExecution.execute({
      executable: process.execPath,
      arguments: ["-e", treeScript(marker)],
      workingDirectory: h.project,
      timeoutMs: 5_000,
      context: {
        runId: h.runId,
        sessionId: h.sessionId,
        actor: { role: "worker" as const, id: "worker-px2c" },
        callId,
        toolName: "process.run",
        runnerInternal: true as const,
      },
    });
    await waitFor(
      () => existsSync(marker) && findRecordByToken(h.jobHostDir, basename(marker)) !== undefined,
      15_000,
      "tree call Job record and marker",
    );
    const record = findRecordByToken(h.jobHostDir, basename(marker))!;
    assert.equal(record.processId, spare.processId, "the tree call must run on the claimed spare pair");
    const result = (await pending) as { process: { outcome: unknown; cleanup: { state?: unknown } } };
    assert.equal(result.process.outcome, "timed_out", JSON.stringify(result.process.cleanup));
    assert.equal(result.process.cleanup.state, "verified_empty");
    const grandchildPid = Number(readFileSync(marker, "utf8").trim());
    assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0, "marker must hold the grandchild PID");
    await waitForDeath([grandchildPid], 2_000, "spare-claimed grandchild");
    rmSync(marker, { force: true });
    await assertNoLiveSupervisors(h.jobHostDir);
  } finally {
    await cleanupOwnTree(h.jobHostDir, marker);
  }
});

// S3 — a spare serves exactly one call and is never reused: two sequential
// claims land on two different pairs, and the first record stays claimed.
test("spare pin: a spare serves exactly one call and is never reused", { timeout: 55_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  const first = await prestartSpareOrFail(h.service, spareOwner(h));
  const tokenA = `s3a-${randomUUID().slice(0, 8)}`;
  const callA = await runTokenCall(h.binding, h, tokenA);
  assert.equal(callA.processId, first.processId, "first call must claim the first spare");
  const second = await prestartSpareOrFail(h.service, spareOwner(h));
  assert.notEqual(second.processId, first.processId, "replacement spare must be a new pair");
  const tokenB = `s3b-${randomUUID().slice(0, 8)}`;
  const callB = await runTokenCall(h.binding, h, tokenB);
  assert.equal(callB.processId, second.processId, "second call must claim the replacement spare");
  assert.notEqual(callB.processId, callA.processId, "the two calls must run on different pairs");
  const firstRecord = readSpareRecords(h.jobHostDir).find((entry) => entry.processId === first.processId);
  assert.equal(firstRecord?.spareClaimed, true, "the first spare must stay claimed, never reusable");
  const firstStatuses = readStatusLines(h.jobHostDir, first.processId);
  assert.ok(firstStatuses.some((line) => line["claimed"] === true), "the first pair must record its claim");
  await assertNoLiveSupervisors(h.jobHostDir);
});

/** A private host+binding on its own root, for tests that close or kill it. */
async function createPrivateSpareWorld(tag: string): Promise<{
  service: WindowsJobProcessHost;
  host: ExecutionHost;
  binding: ExecutionHostRunBinding;
  root: string;
  jobHostDir: string;
  runId: string;
  sessionId: string;
}> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-px2c-${tag}-`));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  initGitRepo(project);
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const jobHostDir = join(stateDir, "managed-processes-job-host");
  const service = createWindowsJobProcessHost({ stateDirectory: jobHostDir });
  const host = createExecutionHost({
    projectRoot: project,
    stateDirectory: stateDir,
    artifacts: new ArtifactStore(join(stateDir, "artifacts")),
    ambientEnvironment: { ...process.env },
    windowsJobHost: service,
  });
  const runId = `px2c-${tag}-${randomUUID()}`;
  const sessionId = `session-${runId}`;
  const binding = await host.bindRun({
    runId,
    permissionProfile: "full",
    capabilityContract: { digest: "c".repeat(64) } as RunnerCapabilityContract,
    capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
  });
  return { service, host, binding, root, jobHostDir, runId, sessionId };
}

// S4 — run end leaves zero processes: closing the run with an unclaimed spare
// waiting retires the pair (supervisor plus Job host die) and drops its files.
test("spare pin: run end leaves zero spare processes", { timeout: 55_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  const world = await createPrivateSpareWorld("runend");
  try {
    const spare = await prestartSpareOrFail(world.service, { runId: world.runId, sessionId: world.sessionId });
    assert.ok(processAlive(spare.supervisorPid), "spare supervisor must be alive before close");
    const jobHostPid = childPowershellOf(spare.supervisorPid);
    await world.binding.close();
    await world.host.close();
    await waitForDeath([spare.supervisorPid], 15_000, "retired spare supervisor");
    if (jobHostPid !== undefined) await waitForDeath([jobHostPid], 10_000, "retired spare Job host");
    assert.ok(!existsSync(join(world.jobHostDir, `${spare.processId}.json`)), "retired spare record must be dropped");
    await assertNoLiveSupervisors(world.jobHostDir);
  } finally {
    try {
      await world.service.retireSpare?.();
    } catch {}
    try {
      await world.binding.close();
    } catch {}
    try {
      await world.host.close();
    } catch {}
    rmSync(world.root, { recursive: true, force: true });
  }
});

// S5 — parent death kills an idle spare: a short-lived parent prestarts a
// spare and dies without retiring it; the orphaned supervisor must retire
// itself (recorded reason, no call ever launched) instead of leaking.
test("spare pin: parent death kills an idle spare", { timeout: 55_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  assert.ok(existsSync(tsxPath), "tsx CLI must exist to spawn the parent-death fixture");
  const root = mkdtempSync(join(tmpdir(), "aiboard-px2c-parent-"));
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const jobHostDir = join(stateDir, "managed-processes-job-host");
    mkdirSync(jobHostDir, { recursive: true });
    const runId = `px2c-parent-${randomUUID()}`;
    const sessionId = `session-${runId}`;
    const outPath = join(root, "spare.json");
    const child = spawn(
      process.execPath,
      [tsxPath, join(here, "fixtures", "px2c-spare-parent.mts"), jobHostDir, runId, sessionId, outPath],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += Buffer.from(chunk).toString("utf8");
    });
    const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(exitCode, 0, `parent fixture must exit 0 after prestarting (stderr: ${stderr.slice(-500)})`);
    const spare = JSON.parse(readFileSync(outPath, "utf8")) as { processId: string; supervisorPid: number };
    assert.ok(spare.processId.length > 0 && spare.supervisorPid > 0, "fixture must report the spare");
    // The parent is dead; the orphaned supervisor must retire its unclaimed spare.
    await waitForDeath([spare.supervisorPid], 15_000, "orphaned spare supervisor");
    const statuses = readStatusLines(jobHostDir, spare.processId);
    const retired = statuses.find((line) => line["spareRetired"] === "parent-dead");
    assert.ok(retired, "orphaned spare must record its parent-dead retirement");
    assert.ok(
      statuses.every((line) => line["childPid"] === 0),
      "an unclaimed spare must never have had a child",
    );
    // A restarted runner sweeps the leftover record instead of adopting it.
    const sweeper = createWindowsJobProcessHost({ stateDirectory: jobHostDir });
    assert.ok(!existsSync(join(jobHostDir, `${spare.processId}.json`)), "restarted runner must drop the retired spare record");
    assert.deepEqual(sweeper.spareStats?.(), { prestarts: 0, claims: 0, fallbacks: 0 }, "restarted runner must adopt nothing");
    await sweeper.retireSpare?.();
    await assertNoLiveSupervisors(jobHostDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// S6 — runner-crash recovery kills an unclaimed spare and never relaunches a
// call: a second host on the same state directory reaps the previous
// runner's spare processes and records, then serves a fresh call of its own.
test("spare pin: crash recovery kills an unclaimed spare and never relaunches", { timeout: 55_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  const world = await createPrivateSpareWorld("crash");
  try {
    const spare = await prestartSpareOrFail(world.service, { runId: world.runId, sessionId: world.sessionId });
    assert.ok(processAlive(spare.supervisorPid), "spare supervisor must be alive before the simulated crash");
    // Simulated crash: the first runner is abandoned (its handles stay open,
    // as after a real crash where the pipe break is missed) and a restarted
    // runner constructs a host on the same state directory.
    const service2 = createWindowsJobProcessHost({ stateDirectory: world.jobHostDir });
    await waitForDeath([spare.supervisorPid], 15_000, "reaped spare supervisor");
    assert.ok(!existsSync(join(world.jobHostDir, `${spare.processId}.json`)), "recovery must drop the unclaimed spare record");
    assert.deepEqual(service2.spareStats?.(), { prestarts: 0, claims: 0, fallbacks: 0 }, "recovery must adopt nothing");
    // The restarted runner serves a fresh call: it never relaunches the spare.
    const host2 = createExecutionHost({
      projectRoot: join(world.root, "project"),
      stateDirectory: join(world.root, "state"),
      artifacts: new ArtifactStore(join(world.root, "state", "artifacts2")),
      ambientEnvironment: { ...process.env },
      windowsJobHost: service2,
    });
    const runId2 = `px2c-crash2-${randomUUID()}`;
    const binding2 = await host2.bindRun({
      runId: runId2,
      permissionProfile: "full",
      capabilityContract: { digest: "c".repeat(64) } as RunnerCapabilityContract,
      capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
    });
    try {
      const token = `s6-${randomUUID().slice(0, 8)}`;
      const { processId } = await runTokenCall(binding2, {
        project: join(world.root, "project"),
        runId: runId2,
        sessionId: `session-${runId2}`,
        jobHostDir: world.jobHostDir,
      }, token);
      assert.notEqual(processId, spare.processId, "the fresh call must not adopt the reaped spare");
    } finally {
      try {
        await binding2.close();
      } catch {}
      try {
        await host2.close();
      } catch {}
    }
    await assertNoLiveSupervisors(world.jobHostDir);
  } finally {
    try {
      await world.service.retireSpare?.();
    } catch {}
    try {
      await world.binding.close();
    } catch {}
    try {
      await world.host.close();
    } catch {}
    rmSync(world.root, { recursive: true, force: true });
  }
});

// S7a — a dead spare falls back to the normal path: the call still succeeds
// on a fresh pair and the fallback is counted.
test("spare pin: a dead spare falls back to the normal path", { timeout: 55_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  const fallbacksBefore = h.service.spareStats?.().fallbacks ?? 0;
  const spare = await prestartSpareOrFail(h.service, spareOwner(h));
  const jobHostPid = childPowershellOf(spare.supervisorPid);
  await killIdentifiedPids(jobHostPid !== undefined ? [spare.supervisorPid, jobHostPid] : [spare.supervisorPid]);
  await waitForDeath([spare.supervisorPid], 10_000, "killed spare supervisor");
  if (jobHostPid !== undefined) await waitForDeath([jobHostPid], 10_000, "killed spare Job host");
  const token = `s7a-${randomUUID().slice(0, 8)}`;
  const { processId } = await runTokenCall(h.binding, h, token);
  assert.notEqual(processId, spare.processId, "a dead spare must not serve the call");
  const stats = h.service.spareStats?.();
  assert.ok((stats?.fallbacks ?? 0) > fallbacksBefore, "the dead spare must count a fallback");
  await assertNoLiveSupervisors(h.jobHostDir);
});

// S7b — a spare that fails its identity check falls back: a tampered
// supervisor identity in the status file is rejected and the call launches
// fresh, while the live spare pair is retired without ever serving.
test("spare pin: a mismatched spare fails its identity check and falls back", { timeout: 55_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  const fallbacksBefore = h.service.spareStats?.().fallbacks ?? 0;
  const spare = await prestartSpareOrFail(h.service, spareOwner(h));
  const statusPath = join(h.jobHostDir, spare.processId, "supervisor.jsonl");
  const lines = readFileSync(statusPath, "utf8").split(/\r?\n/);
  let lastIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.trim().length > 0) {
      lastIndex = index;
      break;
    }
  }
  assert.ok(lastIndex >= 0, "spare status file must hold a status line");
  const tampered = { ...(JSON.parse(lines[lastIndex]!) as Record<string, unknown>), supervisorPid: 1 };
  lines[lastIndex] = JSON.stringify(tampered);
  writeFileSync(statusPath, lines.join("\n"));
  try {
    const token = `s7b-${randomUUID().slice(0, 8)}`;
    const { processId } = await runTokenCall(h.binding, h, token);
    assert.notEqual(processId, spare.processId, "a mismatched spare must not serve the call");
    const stats = h.service.spareStats?.();
    assert.ok((stats?.fallbacks ?? 0) > fallbacksBefore, "the mismatched spare must count a fallback");
    await assertNoLiveSupervisors(h.jobHostDir);
  } finally {
    await h.service.retireSpare?.().catch(() => undefined);
  }
});

// S7c — another run's spare is left for its owner: a call from a different
// run falls back to its own fresh pair, and the spare stays reserved.
test("spare pin: another run's spare stays reserved for its owner", { timeout: 55_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  const spare = await prestartSpareOrFail(h.service, spareOwner(h));
  const otherRunId = `px2c-other-${randomUUID()}`;
  const otherBinding = await h.host.bindRun({
    runId: otherRunId,
    permissionProfile: "full",
    capabilityContract: { digest: "c".repeat(64) } as RunnerCapabilityContract,
    capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
  });
  try {
    const token = `s7c-${randomUUID().slice(0, 8)}`;
    const { processId } = await runTokenCall(otherBinding, {
      project: h.project,
      runId: otherRunId,
      sessionId: `session-${otherRunId}`,
      jobHostDir: h.jobHostDir,
    }, token);
    assert.notEqual(processId, spare.processId, "another run must not consume this run's spare");
    const same = await prestartSpareOrFail(h.service, spareOwner(h));
    assert.equal(same.processId, spare.processId, "the spare must stay reserved for its owner");
    const record = readSpareRecords(h.jobHostDir).find((entry) => entry.processId === spare.processId);
    assert.equal(record?.spareClaimed, false, "the reserved spare must stay unclaimed");
  } finally {
    try {
      await otherBinding.close();
    } catch {}
    await h.service.retireSpare?.().catch(() => undefined);
  }
  await assertNoLiveSupervisors(h.jobHostDir);
});
