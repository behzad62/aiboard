// The Start-Process gap (docs/runner-v2/codex-windows-job-escape-2026-11-18.md §7). `Start-Process pwsh` in a worker's
// command finds the Store pwsh through ShellExecuteEx (App Paths) although R3 took WindowsApps off the child's PATH, and
// Windows creates that packaged program outside the Runner's Job. Before the escape sweep it outlived the owner's
// proven stop. Now every process of an owner carries the owner's mark, and the owner's stop ends the marked processes
// left outside the Job, through the handle the mark was read from. Real host only: it needs a pwsh that exists here
// only as a Store app, so that Start-Process starts the packaged one.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test, { after } from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { isWindowsAppsPathEntry, RUNNER_PROCESS_MARK_NAME } from "../src/child-environment.js";
import { createExecutionHost, type ExecutionHostOptions } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { isProcessStopUnprovenError } from "../src/process-stop-proof.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { createManagedProcessTools } from "../src/managed-process-tools.js";
import { ToolBroker } from "../src/tool-broker.js";
import { createWindowsJobProcessHost, sweepMarkedWindowsProcesses } from "../src/windows-job-process-host.js";
import { checkNoWindowsJobProcessesLeft } from "./support/windows-job-leftover-guard.js";

const WINDOWS = process.platform === "win32";
const OWN_MARKER = `aiboard-start-process-escape-${randomUUID().slice(0, 8)}-`;
const ownRoot = WINDOWS ? mkdtempSync(join(tmpdir(), OWN_MARKER)) : "";

/** Every pwsh.exe on this host's PATH, by lstat (an app execution alias cannot be followed by stat). */
function pwshOnPath(): string[] {
  const path = Object.entries(process.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  return path.split(delimiter).map((entry) => entry.trim().replace(/^"|"$/gu, "")).filter(Boolean).flatMap((folder) => {
    const candidate = join(folder, "pwsh.exe");
    try { lstatSync(candidate); return [candidate]; } catch { return []; }
  });
}
const found = WINDOWS ? pwshOnPath() : [];
const SKIP = (!WINDOWS && "Windows Job host") ||
  (found.length === 0 && "needs pwsh on this host's PATH") ||
  (found.some((entry) => !isWindowsAppsPathEntry(dirname(entry))) && `needs pwsh to exist here only as a Microsoft Store app (PATH has ${found.join(", ")})`) ||
  (existsSync("C:\\Program Files\\PowerShell\\7\\pwsh.exe") && "needs no MSI pwsh in Program Files");

/** A process's creation time (FILETIME, decimal), or "" when no process has this pid. */
function creationTime(pid: number): string {
  return execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `try { [System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToFileTimeUtc() } catch { '' }`], { encoding: "utf8" }).trim();
}

/** The test's own leftovers, ended only by exact identity (pid and creation time), never by pid alone. */
const leftovers: { pid: number; created: string }[] = [];
function track(pid: number): { pid: number; created: string } {
  const entry = { pid, created: creationTime(pid) };
  assert.ok(entry.created, `pid ${pid} runs`);
  leftovers.push(entry);
  return entry;
}
function sameAlive(entry: { pid: number; created: string }): boolean {
  return creationTime(entry.pid) === entry.created;
}

after(async () => {
  if (!WINDOWS) return;
  for (const entry of leftovers) {
    execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `try { $p = [System.Diagnostics.Process]::GetProcessById(${entry.pid}); if ($p.StartTime.ToFileTimeUtc() -eq [long]'${entry.created}') { $p.Kill(); [void]$p.WaitForExit(30000) } } catch { }; exit 0`]);
  }
  await checkNoWindowsJobProcessesLeft([OWN_MARKER]);
  rmSync(ownRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
});

async function waitFor<T>(read: () => T | undefined, what: string, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function readPid(file: string): number | undefined {
  try { const pid = Number(readFileSync(file, "utf8").trim()); return pid > 0 ? pid : undefined; } catch { return undefined; }
}

/**
 * The Codex shape: a worker's one-shot Windows PowerShell command starts a server with `Start-Process pwsh` and
 * returns. The server (the Store pwsh) starts node as its own child, and both write their pids.
 */
async function startEscape(run: Awaited<ReturnType<ReturnType<typeof createExecutionHost>["bindRun"]>>, project: string, sessionId: string, tag: string) {
  const escapeePidFile = join(ownRoot, `${tag}-escapee.pid`), childPidFile = join(ownRoot, `${tag}-child.pid`);
  const inner = `$n = [System.Diagnostics.Process]::Start('${process.execPath}', '-e "setTimeout(()=>{},120000)" ${OWN_MARKER}${tag}'); ` +
    `Set-Content -LiteralPath '${childPidFile}' -Value $n.Id; Start-Sleep 120`;
  const encoded = Buffer.from(inner, "utf16le").toString("base64");
  const script = `$p = Start-Process pwsh -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' -WindowStyle Hidden -PassThru; ` +
    `Set-Content -LiteralPath '${escapeePidFile}' -Value $p.Id`;
  const result = await run.commandExecution.execute({
    executable: "powershell.exe", arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], workingDirectory: project,
    timeoutMs: 60_000, captureOutputBytes: 64 * 1024,
    context: { runId: run.runId, sessionId, actor: { role: "worker", id: `worker-${tag}` }, callId: `escape-${tag}`, toolName: "process.run", runnerInternal: true },
  });
  const settled = (result as { process?: { outcome?: unknown; exitCode?: unknown; cleanup?: { state?: unknown } } }).process;
  assert.equal(settled?.outcome, "exited", JSON.stringify(result).slice(0, 600));
  assert.equal(settled?.exitCode, 0);
  // The command's own Job is empty and proven so: what follows runs outside it.
  assert.equal(settled?.cleanup?.state, "verified_empty");
  const escapee = track(await waitFor(() => readPid(escapeePidFile), `${tag}'s escapee pid`));
  const child = track(await waitFor(() => readPid(childPidFile), `${tag}'s escapee's child pid`));
  return { escapee, child, owner: { runId: run.runId, sessionId, actor: { role: "worker" as const, id: `worker-${tag}` } } };
}

async function bind(name: string, options: Partial<ExecutionHostOptions> = {}) {
  const root = join(ownRoot, name), project = join(root, "project"), state = join(root, "state");
  mkdirSync(project, { recursive: true }); mkdirSync(state, { recursive: true });
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment: snapshotNativeBuildAmbientEnvironment(), windowsJobHost: createWindowsJobProcessHost({ stateDirectory: join(state, "job-host") }), ...options });
  const run = await host.bindRun({ runId: `escape-${name}`, permissionProfile: "full", capabilityContract: { digest: "e".repeat(64) } as RunnerCapabilityContract, capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
  return { host, run, project };
}

test("a Store pwsh a worker starts with Start-Process is ended by the owner's stop; other owners' and unmarked processes are not", { skip: SKIP, timeout: 300_000 }, async () => {
  const { host, run, project } = await bind("sweep");
  // A process created after the marks, without one: never the Runner's to end.
  let unmarked: ReturnType<typeof spawn> | undefined;
  try {
    const a = await startEscape(run, project, "agent-a", "a");
    const b = await startEscape(run, project, "agent-b", "b");
    unmarked = spawn(process.execPath, ["-e", "setTimeout(()=>{},120000)", `${OWN_MARKER}unmarked`], { stdio: "ignore", windowsHide: true });
    const plain = track(unmarked.pid!);
    // Before the stop both escapees live outside every Runner Job: the Job's own stop never saw them.
    for (const entry of [a.escapee, a.child, b.escapee, b.child]) assert.ok(sameAlive(entry), `escapee ${entry.pid} runs before the stop`);
    // The owner also has a managed process in its Job: its stop comes first, and the sweep then finds it released.
    const managed = track((await startManaged(run, project, "agent-a", "worker-a", ["-e", "setTimeout(()=>{},120000)", `${OWN_MARKER}managed`])).pid);

    await run.managedProcesses.closeAgent(a.owner);
    assert.equal(sameAlive(a.escapee), false, `the Store pwsh (pid ${a.escapee.pid}) is ended by its owner's stop`);
    assert.equal(sameAlive(a.child), false, `its own child (pid ${a.child.pid}) too: it carries the same mark`);
    assert.equal(sameAlive(managed), false, "the owner's managed process ended with its Job");
    assert.ok(sameAlive(b.escapee) && sameAlive(b.child), "another owner's escapees are not this owner's");
    assert.ok(sameAlive(plain), "an unmarked process created after the mark is never ended");

    // The sweep is recorded in the run's state, with what it ended.
    const log = readFileSync(join(run.runRoot, "process-marks", "sweeps.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { sessionId: string; settled: boolean; ended: { pid: number; packaged: boolean }[] });
    const swept = log.find((entry) => entry.sessionId === "agent-a");
    assert.ok(swept?.settled, JSON.stringify(log));
    assert.ok(swept.ended.some((entry) => entry.pid === a.escapee.pid && entry.packaged), `the packaged escapee is recorded as ended: ${JSON.stringify(swept)}`);
    assert.ok(swept.ended.some((entry) => entry.pid === a.child.pid && !entry.packaged), `its unpackaged child too: ${JSON.stringify(swept)}`);

    await run.managedProcesses.closeAgent(b.owner);
    assert.equal(sameAlive(b.escapee), false, "the second owner's escapee is ended by its own stop");
    assert.equal(sameAlive(b.child), false);
    assert.ok(sameAlive(plain), "the unmarked process still runs");
  } finally {
    unmarked?.kill();
    await run.close();
    await host.close();
  }
});

test("a marked escapee the sweep cannot end leaves the owner's stop unproven; the retried stop ends it", { skip: SKIP, timeout: 300_000 }, async () => {
  let failNext = true;
  const { host, run, project } = await bind("unproven", {
    // Stricter only: the first sweep finds the escapee and does not end it, as a TerminateProcess that fails would.
    escapeSweep: async (request) => await sweepMarkedWindowsProcesses({ ...request, ...(failNext ? { injectedFault: "terminate_fails" as const } : {}) }),
  });
  try {
    const a = await startEscape(run, project, "agent-u", "u");
    const refused = await run.managedProcesses.closeAgent(a.owner).then(() => undefined, (error: unknown) => error);
    assert.ok(refused instanceof Error, "the stop is not proven");
    assert.ok(isProcessStopUnprovenError(refused), `the scheduler reads it as an unproven stop (claim kept): ${(refused as Error).message}`);
    assert.match((refused as Error).message, /not proven ended/u);
    assert.ok(sameAlive(a.escapee), "nothing was ended");
    failNext = false;
    await run.managedProcesses.closeAgent(a.owner);
    assert.equal(sameAlive(a.escapee), false, "the retried stop ends it");
    assert.equal(sameAlive(a.child), false);
  } finally {
    failNext = false;
    await run.close();
    await host.close();
  }
});

test("the run's close sweeps every mark launched since its last sweep", { skip: SKIP, timeout: 300_000 }, async () => {
  const { host, run, project } = await bind("close");
  let closed = false;
  try {
    const a = await startEscape(run, project, "agent-c", "c");
    // No owner stop: the run's close is the last sweep.
    await run.close();
    closed = true;
    assert.equal(sameAlive(a.escapee), false, "the run's close ends the escapee");
    assert.equal(sameAlive(a.child), false);
  } finally {
    if (!closed) await run.close();
    await host.close();
  }
});

test("the mark the sweep matches is the one each child of the owner carries", { skip: WINDOWS ? false : "Windows only", timeout: 120_000 }, async () => {
  const { host, run, project } = await bind("mark");
  try {
    const result = await run.commandExecution.execute({
      executable: process.execPath, arguments: ["-e", `process.stdout.write(process.env.${RUNNER_PROCESS_MARK_NAME} ?? "none")`], workingDirectory: project,
      timeoutMs: 60_000, captureOutputBytes: 64 * 1024,
      context: { runId: run.runId, sessionId: "agent-m", actor: { role: "worker", id: "worker-m" }, callId: "mark-1", toolName: "process.run", runnerInternal: true },
    });
    const stdout = Buffer.from((result as { capturedOutput?: { stdout?: Uint8Array } }).capturedOutput?.stdout ?? new Uint8Array()).toString("utf8");
    assert.match(stdout, /^[0-9a-f]{32}$/u, `the child carries a mark: ${stdout}`);
    assert.equal(sessionMark(run, "agent-m").value, stdout, "the persisted mark is the child's");
  } finally {
    await run.close();
    await host.close();
  }
});

/** A managed `process.start` through the ToolBroker, as a worker's tool call makes it. */
async function startManaged(run: Awaited<ReturnType<typeof bind>>["run"], project: string, sessionId: string, actor: string, args: string[]) {
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: project, executionGrants: run.executionGrants,
    artifacts: new ArtifactStore(join(project, "..", `broker-artifacts-${randomUUID().slice(0, 8)}`)), maxInlineOutputBytes: 512 * 1024 });
  for (const tool of createManagedProcessTools(run.managedProcesses)) broker.register(tool);
  const started = await broker.invoke({ type: "tool_call", callId: `start-${randomUUID()}`, name: "process.start", arguments: { command: process.execPath, args } },
    { runId: run.runId, sessionId, actor: { role: "worker", id: actor }, workspacePath: project });
  assert.equal(started.isError, false, JSON.stringify(started.content));
  const value = (started.content[0] as { value: { pid?: unknown } }).value;
  assert.ok(typeof value.pid === "number" && value.pid > 0, JSON.stringify(value));
  return { pid: value.pid };
}

function sessionMark(run: Awaited<ReturnType<typeof bind>>["run"], sessionId: string): { value: string; issuedAt: string } {
  const folder = join(run.runRoot, "process-marks");
  for (const name of readdirSync(folder).filter((entry) => entry.endsWith(".json"))) {
    const mark = JSON.parse(readFileSync(join(folder, name), "utf8")) as { sessionId: string; value: string; issuedAt: string };
    if (mark.sessionId === sessionId) return mark;
  }
  throw new Error(`no mark for ${sessionId}`);
}

function errorText(error: unknown): string {
  if (error instanceof AggregateError) return [error.message, ...error.errors.map(errorText)].join(" ");
  return error instanceof Error ? `${error.message} ${error.cause ? errorText(error.cause) : ""}` : String(error);
}

test("a marked process alive in a live Runner Job is never ended: the sweep refuses, and the stop is unproven", { skip: WINDOWS ? false : "Windows only", timeout: 300_000 }, async () => {
  const { host, run, project } = await bind("live-member");
  try {
    const member = track((await startManaged(run, project, "agent-l", "worker-other", ["-e", "setTimeout(()=>{},120000)", `${OWN_MARKER}live`])).pid);
    // Another actor of the same session stops: they share the mark, and the other actor's process still runs.
    const refused = await run.managedProcesses.closeAgent({ runId: run.runId, sessionId: "agent-l", actor: { role: "worker", id: "worker-self" } })
      .then(() => undefined, (error: unknown) => error);
    assert.ok(isProcessStopUnprovenError(refused), `unproven, not swept: ${String(refused)}`);
    assert.ok(sameAlive(member), "the other actor's process is untouched");
    // The sweep itself, asked directly for that mark: the member is marked, unpackaged and in a job, so it is reported
    // and left alone. This part needs no Store app, so it runs on every Windows host.
    const mark = sessionMark(run, "agent-l");
    const report = await sweepMarkedWindowsProcesses({ markName: RUNNER_PROCESS_MARK_NAME, markValue: mark.value, since: new Date(mark.issuedAt) });
    assert.equal(report.settled, false);
    assert.deepEqual(report.ended, []);
    assert.ok(report.unended.some((entry) => entry.pid === member.pid && entry.reason === "in_job_not_packaged" && entry.inJob && !entry.packaged), JSON.stringify(report));
    assert.ok(sameAlive(member), "still alive after the sweep");
    // A mark nobody carries, and a start time after every process: nothing is looked at, nothing is ended.
    const other = await sweepMarkedWindowsProcesses({ markName: RUNNER_PROCESS_MARK_NAME, markValue: "0".repeat(32), since: new Date(mark.issuedAt) });
    assert.deepEqual([other.settled, other.ended.length, other.unended.length], [true, 0, 0]);
    const later = await sweepMarkedWindowsProcesses({ markName: RUNNER_PROCESS_MARK_NAME, markValue: mark.value, since: new Date(Date.now() + 60_000) });
    assert.deepEqual([later.settled, later.ended.length, later.unended.length], [true, 0, 0]);
    assert.ok(sameAlive(member));
    // Once the other actor stops, the session's stop is proven.
    await run.managedProcesses.closeAgent({ runId: run.runId, sessionId: "agent-l", actor: { role: "worker", id: "worker-other" } });
    assert.equal(sameAlive(member), false, "its own stop ended it, through its Job");
    await run.managedProcesses.closeAgent({ runId: run.runId, sessionId: "agent-l", actor: { role: "worker", id: "worker-self" } });
  } finally {
    await run.close();
    await host.close();
  }
});

test("a sweep that fails at the run's close leaves the close failed; a retried close proves it", { skip: WINDOWS ? false : "Windows only", timeout: 300_000 }, async () => {
  let fail = true;
  const { host, run, project } = await bind("close-fails", {
    escapeSweep: async (request) => {
      if (fail) throw new Error("injected sweep failure");
      return await sweepMarkedWindowsProcesses(request);
    },
  });
  try {
    // A one-shot command marks its session; no owner stop sweeps it, so the close does.
    const result = await run.commandExecution.execute({
      executable: process.execPath, arguments: ["-e", "0"], workingDirectory: project, timeoutMs: 60_000, captureOutputBytes: 1024,
      context: { runId: run.runId, sessionId: "agent-f", actor: { role: "worker", id: "worker-f" }, callId: "close-1", toolName: "process.run", runnerInternal: true },
    });
    assert.equal((result as { process?: { exitCode?: unknown } }).process?.exitCode, 0);
    const refused = await run.close().then(() => undefined, (error: unknown) => error);
    assert.ok(refused instanceof Error && errorText(refused).includes("injected sweep failure"), `the close fails: ${String(refused)}`);
    fail = false;
    await run.close();
  } finally {
    fail = false;
    await run.close().catch(() => undefined);
    await host.close();
  }
});
