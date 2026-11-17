import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManagedProcessError, ManagedProcessService, readHistoricalManagedProcessObservations, type ManagedProcessSnapshot } from "../src/managed-process.js";
import type { ManagedProcessLaunchRequest, ManagedProcessRunRuntime } from "../src/managed-process-transport.js";
import type { ToolExecutionContext } from "../src/agent-contracts.js";
import type { OpaqueExecutionGrant } from "../src/execution-grants.js";
import { isProcessStopUnprovenError } from "../src/process-stop-proof.js";
import { assertWindowsBatchLaunchAvailable, WindowsBatchLaunchUnavailableError } from "../src/windows-process-backend.js";
test("historical process observation reads persisted records without reconciliation writes", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-process-historical-"));
  const state = join(root, "state");
  const processDirectory = join(state, "process_legacy");
  try {
    mkdirSync(processDirectory, { recursive: true });
    const stdoutPath = join(processDirectory, "stdout.log");
    const stderrPath = join(processDirectory, "stderr.log");
    writeFileSync(stdoutPath, "durable stdout\n");
    writeFileSync(stderrPath, "durable stderr\n");
    const recordPath = join(state, "process_legacy.json");
    writeFileSync(recordPath, JSON.stringify({
      processId: "process_legacy",
      pid: 4242,
      runId: "run_legacy",
      sessionId: "worker:run_legacy:task:1",
      actor: { role: "worker", id: "worker_1" },
      command: process.execPath,
      args: ["--version"],
      cwd: root,
      environmentKeys: ["PATH"],
      startedAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:01.000Z",
      status: "running",
      exitCode: null,
      signal: null,
      stdoutPath,
      stderrPath,
    }, null, 2));
    const beforeRecord = readFileSync(recordPath);
    const beforeMtime = statSync(recordPath).mtimeMs;

    assert.deepEqual(readHistoricalManagedProcessObservations(state, "run_legacy"), [
      {
        processId: "process_legacy",
        pid: 4242,
        status: "running",
        exitCode: null,
        signal: null,
        startedAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:01.000Z",
        stdout: "durable stdout\n",
        stderr: "durable stderr\n",
        runId: "run_legacy",
        sessionId: "worker:run_legacy:task:1",
        actor: { role: "worker", id: "worker_1" },
        command: process.execPath,
        args: ["--version"],
        cwd: root,
        environmentKeys: ["PATH"],
      },
    ]);
    assert.deepEqual(readFileSync(recordPath), beforeRecord);
    assert.equal(statSync(recordPath).mtimeMs, beforeMtime);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("historical observations read current-schema records beside legacy ones (tunnel run)", () => {
  // A live run's current-schema record made every other run's historical open throw "malformed".
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-process-mixed-"));
  const state = join(root, "state");
  try {
    mkdirSync(state, { recursive: true });
    const current = (processId: string, runId: string) => ({
      processId, pid: 105760, runId, sessionId: `worker:${runId}:task:1`, actor: { role: "worker", id: "worker_1" },
      recordKind: "runner.managed-process", schemaVersion: 2, command: "node", args: ["npm-cli.js", "install"], cwd: root,
      environmentKeys: [], configurationDigest: "f".repeat(64), streamingSessionId: `managed-stream-${processId}`,
      launchId: `managed-launch-${processId}`, status: "stopped", exitCode: 0, signal: null,
      startedAt: "2026-10-19T19:25:06.415Z", updatedAt: "2026-10-19T19:35:32.515Z", stdout: "added 10 packages\n", stderr: "",
    });
    writeFileSync(join(state, "process_other.json"), JSON.stringify(current("process_other", "run_other")));
    writeFileSync(join(state, "process_mine.json"), JSON.stringify(current("process_mine", "run_mine")));
    assert.deepEqual(readHistoricalManagedProcessObservations(state, "run_old"), []);
    const [mine, ...rest] = readHistoricalManagedProcessObservations(state, "run_mine");
    assert.equal(rest.length, 0);
    assert.equal(mine?.processId, "process_mine");
    assert.equal(mine?.stdout, "added 10 packages\n");
    assert.equal(mine?.status, "stopped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// CW5a: a launch refused before any spawn is never started. In-memory runtimes only; the real Windows refusal
// through the ExecutionHost is in managed-refused-launch-windows.test.ts.
type FakeStart = (request: ManagedProcessLaunchRequest, live: Set<string>) => Promise<ManagedProcessSnapshot>;
function refusedLaunchFixture(start: FakeStart, options: { proveStop?: () => boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-refused-launch-"));
  const live = new Set<string>(); const stops: string[] = [];
  const runtime: ManagedProcessRunRuntime = {
    runId: "run",
    start: async (request) => await start(request, live),
    async observe(target) { return { ...target, status: live.has(target.processId) ? "running" : "stopped" }; },
    async stop(target) {
      stops.push(target.processId);
      if (options.proveStop?.() ?? true) live.delete(target.processId);
      return { ...target, status: live.has(target.processId) ? "running" : "stopped", updatedAt: new Date().toISOString() };
    },
  };
  const service = new ManagedProcessService({ stateDirectory: join(root, "state"), idFactory: () => "refused" });
  const detach = service.registerRuntime(runtime);
  const context: ToolExecutionContext = { runId: "run", sessionId: "agent", actor: { role: "worker", id: "worker" }, workspacePath: root,
    callId: "call-1", toolName: "process.start", executionGrant: Object.freeze({}) as OpaqueExecutionGrant };
  const record = () => {
    const files = readdirSync(join(root, "state")).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 1, files.join(", "));
    return JSON.parse(readFileSync(join(root, "state", files[0]!), "utf8")) as { status: string; processId: string };
  };
  return { root, live, stops, service, detach, context, record };
}
const running = (request: ManagedProcessLaunchRequest): ManagedProcessSnapshot => ({ processId: request.identity.processId, pid: 7, status: "running",
  exitCode: null, signal: null, startedAt: "2026-11-17T00:00:00.000Z", updatedAt: "2026-11-17T00:00:00.000Z", stdout: "", stderr: "" });

test("a runtime that refuses after creating state keeps the exact stop and its unverified-cleanup aggregate", async () => {
  const refusal = new WindowsBatchLaunchUnavailableError(); let prove = false;
  const f = refusedLaunchFixture(async (request, live) => { live.add(request.identity.processId); throw refusal; }, { proveStop: () => prove });
  try {
    let error: unknown;
    try { await f.service.start({ command: "tool.cmd" }, f.context, f.root); } catch (caught) { error = caught; }
    assert.ok(error instanceof AggregateError, String(error));
    assert.equal(error.message, "Managed failed start retains unverified exact cleanup.");
    assert.equal(error.errors[0], refusal);
    assert.equal((error.errors[1] as ManagedProcessError).code, "process_cleanup_unverified");
    assert.equal(isProcessStopUnprovenError(error), true, "an unproven stop still pauses the scheduler");
    assert.deepEqual(f.stops, [f.record().processId]);
    assert.notEqual(f.record().status, "stopped");
    assert.throws(() => f.detach(), (caught: unknown) => (caught as ManagedProcessError).code === "process_cleanup_unverified");
    prove = true; await f.service.close();
    assert.equal(f.record().status, "stopped");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a failed start whose stop is proven throws the failure alone, with a stopped record and a free detach", async () => {
  // A coded refusal raised before any spawn (nothing live) and an ordinary failure after a spawn both take the same exact stop.
  for (const [failure, spawned] of [[new WindowsBatchLaunchUnavailableError(), false], [new Error("spawn failed"), true]] as const) {
    const f = refusedLaunchFixture(async (request, live) => { if (spawned) live.add(request.identity.processId); throw failure; });
    try {
      let error: unknown;
      try { await f.service.start({ command: "tool" }, f.context, f.root); } catch (caught) { error = caught; }
      assert.equal(error, failure, "the service throws the failure itself, not an aggregate");
      assert.equal(isProcessStopUnprovenError(error), false);
      assert.deepEqual(f.stops, [f.record().processId], "the record reaches stopped only through the proven stop");
      assert.equal(f.record().status, "stopped");
      assert.doesNotThrow(() => f.detach(), "the runtime detaches: no record of its run is left unstopped");
    } finally { await f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
  }
  const g = refusedLaunchFixture(async (request) => running(request));
  try { assert.equal((await g.service.start({ command: "tool" }, g.context, g.root)).status, "running"); }
  finally { await g.service.close(); rmSync(g.root, { recursive: true, force: true }); }
});

test("CW5a: the managed runtime's early batch check is the backends' own rule, by extension and fact only", () => {
  for (const executable of [String.raw`C:\tools\a.cmd`, String.raw`C:\tools\a.BAT`, String.raw`relative\b.Cmd`]) {
    for (const fact of ["unavailable", "partial"] as const) {
      assert.throws(() => assertWindowsBatchLaunchAvailable(executable, fact),
        (error: unknown) => error instanceof WindowsBatchLaunchUnavailableError && error.code === "windows_batch_argv_unverified");
    }
    assert.doesNotThrow(() => assertWindowsBatchLaunchAvailable(executable, "verified"));
  }
  for (const executable of [String.raw`C:\tools\a.exe`, String.raw`C:\tools\a.cmd.exe`, String.raw`C:\tools\cmd`, "node"])
    assert.doesNotThrow(() => assertWindowsBatchLaunchAvailable(executable, "unavailable"));
});
