// The Start-Process gap's portable parts (process-escape-marks.ts): the per-owner mark, its persistence, what a sweep
// report means for the owner's stop, and where the managed stop runs the sweep. The real Windows sweep is in
// windows-start-process-escape.test.ts.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolExecutionContext } from "../src/agent-contracts.js";
import { createChildEnvironmentFactory, RUNNER_PROCESS_MARK_NAME } from "../src/child-environment.js";
import type { OpaqueExecutionGrant } from "../src/execution-grants.js";
import { ManagedProcessService, type ManagedProcessSnapshot } from "../src/managed-process.js";
import type { ManagedProcessRunRuntime } from "../src/managed-process-transport.js";
import { ProcessEscapeMarks, sweepEscapedProcesses, type ProcessEscapeSweeper } from "../src/process-escape-marks.js";
import { isProcessStopUnprovenError } from "../src/process-stop-proof.js";
import type { WindowsEscapeSweepReport } from "../src/windows-job-process-host.js";

function temporary(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "aiboard-escape-marks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const clean: WindowsEscapeSweepReport = Object.freeze({ settled: true, rounds: 1, ended: [], unended: [], unreadable: [], unqueried: 0 });
const process1 = { pid: 41, created: "134396496797227956", image: "C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe\\pwsh.exe", packaged: true, inJob: true };

test("a mark is issued once per owner session, persisted, and found again after a restart", (t) => {
  const root = temporary(t);
  const issuedAt = new Date("2026-11-20T10:00:00.000Z");
  const marks = new ProcessEscapeMarks(root, "run-1", () => issuedAt);
  const a = marks.markFor({ runId: "run-1", sessionId: "agent-a" });
  assert.match(a, /^[0-9a-f]{32}$/u);
  assert.equal(marks.markFor({ runId: "run-1", sessionId: "agent-a" }), a, "the same session keeps its mark");
  const b = marks.markFor({ runId: "run-1", sessionId: "agent-b" });
  assert.notEqual(b, a, "each session has its own mark");
  assert.throws(() => marks.markFor({ runId: "run-2", sessionId: "agent-a" }), /another run/u);

  const restarted = new ProcessEscapeMarks(root, "run-1");
  assert.deepEqual(restarted.pending("agent-a").map(({ launch: _launch, ...mark }) => mark), [{ runId: "run-1", sessionId: "agent-a", value: a, issuedAt: issuedAt.toISOString() }]);
  assert.deepEqual(restarted.pending().map((mark) => mark.sessionId).sort(), ["agent-a", "agent-b"], "after a restart every mark is swept again");
  assert.deepEqual(restarted.pending("agent-c"), [], "a session that never launched has nothing to sweep");
});

test("a malformed persisted mark fails closed", (t) => {
  const root = temporary(t);
  new ProcessEscapeMarks(root, "run-1").markFor({ runId: "run-1", sessionId: "agent-a" });
  const file = readdirSync(root).find((name) => name.endsWith(".json"))!;
  writeFileSync(join(root, file), JSON.stringify({ runId: "run-1", sessionId: "agent-a", value: "not-a-mark", issuedAt: "2026-11-20T10:00:00.000Z" }));
  assert.throws(() => new ProcessEscapeMarks(root, "run-1").pending("agent-a"), (error: unknown) => (error as { code?: string }).code === "process_cleanup_unverified");
});

test("the sweep asks for the owner's mark since its issue, and a settled sweep stops it being pending for the run", async (t) => {
  const root = temporary(t);
  const marks = new ProcessEscapeMarks(root, "run-1", () => new Date("2026-11-20T10:00:00.000Z"));
  const value = marks.markFor({ runId: "run-1", sessionId: "agent-a" });
  const asked: unknown[] = [];
  const sweep: ProcessEscapeSweeper = async (request) => { asked.push(request); return { ...clean, ended: [process1] }; };
  await sweepEscapedProcesses(marks, sweep, { sessionId: "agent-a" });
  assert.deepEqual(asked, [{ markName: RUNNER_PROCESS_MARK_NAME, markValue: value, since: new Date("2026-11-20T10:00:00.000Z") }]);
  assert.deepEqual(marks.pending(), [], "nothing is pending for the run's close after a settled sweep");
  assert.deepEqual(marks.pending("agent-a"), [], "nor for the session's next stop, until it launches again");
  marks.markFor({ runId: "run-1", sessionId: "agent-a" });
  assert.equal(marks.pending().length, 1, "a later launch makes it pending again");
  const log = readFileSync(join(root, "sweeps.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { sessionId: string; ended: unknown[] });
  assert.equal(log[0]?.sessionId, "agent-a");
  assert.equal(log[0]?.ended.length, 1, "what the sweep ended is recorded");
});

test("a marked process the sweep could not end, a sweep that kept finding new ones, or a failed sweep is an unproven stop", async (t) => {
  for (const [label, sweep] of [
    ["unended", async () => ({ ...clean, settled: false, unended: [{ ...process1, reason: "terminate_failed_5" }] })],
    ["unsettled", async () => ({ ...clean, settled: false, rounds: 8, ended: [process1] })],
    ["failed", async () => { throw new Error("The escape sweep did not finish: no report within 60000 ms"); }],
  ] as const satisfies readonly (readonly [string, ProcessEscapeSweeper])[]) {
    const root = temporary(t);
    const marks = new ProcessEscapeMarks(root, "run-1");
    marks.markFor({ runId: "run-1", sessionId: "agent-a" });
    const error = await sweepEscapedProcesses(marks, sweep, { sessionId: "agent-a" }).then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof Error, label);
    assert.equal((error as { code?: string }).code, "process_cleanup_unverified", label);
    assert.ok(isProcessStopUnprovenError(error), `${label}: the scheduler keeps the claim`);
    assert.equal(marks.pending().length, 1, `${label}: still pending, so the run's close sweeps it again`);
    assert.ok(readFileSync(join(root, "sweeps.jsonl"), "utf8").includes("agent-a"), `${label}: recorded`);
  }
});

test("an unreadable process is recorded, never ended, and does not by itself leave the stop unproven", async (t) => {
  const root = temporary(t);
  const marks = new ProcessEscapeMarks(root, "run-1");
  marks.markFor({ runId: "run-1", sessionId: "agent-a" });
  await sweepEscapedProcesses(marks, async () => ({ ...clean, unreadable: [{ ...process1, packaged: false, inJob: false, reason: "open_denied" }] }), { sessionId: "agent-a" });
  const [entry] = readFileSync(join(root, "sweeps.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { unreadable: { reason: string }[] });
  assert.equal(entry?.unreadable[0]?.reason, "open_denied");
});

test("the child environment carries the owner's mark; a caller cannot set it; an inherited one is kept only when unmarked", () => {
  const factory = createChildEnvironmentFactory({
    credentialResolver: { consume() { throw new Error("none"); } },
    processMark: (owner) => owner.sessionId === "agent-a" ? "a".repeat(32) : undefined,
  });
  const read = (input: Parameters<typeof factory.prepare>[0]) => factory.withChildEnvironment(factory.prepare(input).capability, (environment) => environment);
  const ambient = { PATH: process.env.PATH ?? "", [RUNNER_PROCESS_MARK_NAME]: "b".repeat(32) };
  assert.equal(read({ ambient, runId: "run-1", sessionId: "agent-a" })[RUNNER_PROCESS_MARK_NAME], "a".repeat(32), "the owner's mark wins over an inherited one");
  assert.equal(read({ ambient, runId: "run-1", sessionId: "agent-a", explicitOverrides: { [RUNNER_PROCESS_MARK_NAME]: "c".repeat(32) } })[RUNNER_PROCESS_MARK_NAME], "a".repeat(32), "a caller's override is rejected");
  const unmarked = read({ ambient, runId: "run-1", sessionId: "agent-z", explicitOverrides: { [RUNNER_PROCESS_MARK_NAME.toLowerCase()]: "c".repeat(32) } });
  assert.equal(unmarked[RUNNER_PROCESS_MARK_NAME], "b".repeat(32), "an inherited mark (a Runner nested in a worker) is kept when this Runner sets none");
  assert.ok(!Object.values(unmarked).includes("c".repeat(32)), "and a caller still cannot set one");
  assert.throws(() => createChildEnvironmentFactory({ credentialResolver: { consume() { throw new Error("none"); } }, processMark: () => "short" })
    .prepare({ ambient: {}, runId: "run-1", sessionId: "agent-a" }), /mark is invalid/u);
  assert.throws(() => createChildEnvironmentFactory({ credentialResolver: { consume() { throw new Error("none"); } },
    processEnvironment: () => ({ values: { [RUNNER_PROCESS_MARK_NAME]: "a".repeat(32) }, pathPrepend: [] }) })
    .prepare({ ambient: {}, runId: "run-1", sessionId: "agent-a" }), /Runner process environment is invalid/u);
});

function serviceWithSweep(t: { after(fn: () => void): void }, sweepEscapes: ManagedProcessRunRuntime["sweepEscapes"]) {
  const root = temporary(t);
  const live = new Set<string>();
  const order: string[] = [];
  let next = 0;
  const runtime: ManagedProcessRunRuntime = {
    runId: "run",
    async start(request) {
      live.add(request.identity.processId);
      return { processId: request.identity.processId, pid: 7, status: "running", exitCode: null, signal: null,
        startedAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-20T00:00:00.000Z", stdout: "", stderr: "" } as ManagedProcessSnapshot;
    },
    async observe(target) { return { ...target, status: live.has(target.processId) ? "running" : "stopped" } as ManagedProcessSnapshot; },
    async stop(target) {
      order.push(`stop ${target.processId}`);
      live.delete(target.processId);
      return { ...target, status: "stopped", updatedAt: new Date().toISOString() } as ManagedProcessSnapshot;
    },
    ...(sweepEscapes ? { sweepEscapes: async (scope: { readonly sessionId?: string }) => { order.push(`sweep ${scope.sessionId}`); await sweepEscapes(scope); } } : {}),
  };
  const service = new ManagedProcessService({ stateDirectory: join(root, "state"), idFactory: () => `process-${++next}` });
  service.registerRuntime(runtime);
  const context = (sessionId: string, actor: string): ToolExecutionContext => ({ runId: "run", sessionId, actor: { role: "worker", id: actor }, workspacePath: root,
    callId: `call-${++next}`, toolName: "process.start", executionGrant: Object.freeze({}) as OpaqueExecutionGrant });
  return { service, context, order, root };
}

test("the owner's managed stop sweeps the owner's session after its processes are stopped", async (t) => {
  const f = serviceWithSweep(t, async () => {});
  await f.service.start({ command: "node" }, f.context("agent-a", "worker-a"), f.root);
  await f.service.closeAgent({ runId: "run", sessionId: "agent-a", actor: { role: "worker", id: "worker-a" } });
  assert.equal(f.order.length, 2, f.order.join(", "));
  assert.match(f.order[0]!, /^stop process-/u);
  assert.equal(f.order[1], "sweep agent-a", "the sweep runs after the stop");
});

test("while another actor of the same session still runs, the stop is unproven and nothing is swept", async (t) => {
  const f = serviceWithSweep(t, async () => {});
  await f.service.start({ command: "node" }, f.context("agent-a", "worker-a"), f.root);
  await f.service.start({ command: "node" }, f.context("agent-a", "worker-b"), f.root);
  const error = await f.service.closeAgent({ runId: "run", sessionId: "agent-a", actor: { role: "worker", id: "worker-a" } }).then(() => undefined, (caught: unknown) => caught);
  assert.ok(isProcessStopUnprovenError(error), "they share the mark: sweeping now could end worker-b's processes");
  assert.ok(!f.order.includes("sweep agent-a"), `no sweep while worker-b's process runs: ${f.order.join(", ")}`);
  await f.service.closeAgent({ runId: "run", sessionId: "agent-a", actor: { role: "worker", id: "worker-b" } });
  assert.equal(f.order.at(-1), "sweep agent-a", "the last actor's stop sweeps");
  await f.service.closeAgent({ runId: "run", sessionId: "agent-a", actor: { role: "worker", id: "worker-a" } });
});

test("a session's sweep covers its subagents' sessions, and a launch during a sweep keeps the session pending", async (t) => {
  const root = temporary(t);
  const marks = new ProcessEscapeMarks(root, "run-1");
  marks.markFor({ runId: "run-1", sessionId: "agent-a" });
  marks.markFor({ runId: "run-1", sessionId: "agent-a:subagent:1" });
  marks.markFor({ runId: "run-1", sessionId: "agent-ab" });
  assert.deepEqual(marks.pending("agent-a").map((mark) => mark.sessionId), ["agent-a", "agent-a:subagent:1"], "not a session that only shares the prefix");
  const swept: string[] = [];
  await sweepEscapedProcesses(marks, async (request) => {
    swept.push(request.markValue);
    // A launch of the session while its sweep runs: its process may have started after the snapshot.
    marks.markFor({ runId: "run-1", sessionId: "agent-a" });
    return clean;
  }, { sessionId: "agent-a" });
  assert.equal(swept.length, 2);
  assert.deepEqual(marks.pending("agent-a").map((mark) => mark.sessionId), ["agent-a"], "the session launched during its sweep and stays pending");
  await sweepEscapedProcesses(marks, async () => clean, { sessionId: "agent-a" });
  assert.deepEqual(marks.pending("agent-a"), []);
});

test("a sweep failure makes the owner's managed stop unproven, whatever its error", async (t) => {
  const f = serviceWithSweep(t, async () => { throw new Error("powershell.exe could not start"); });
  await f.service.start({ command: "node" }, f.context("agent-a", "worker-a"), f.root);
  const error = await f.service.closeAgent({ runId: "run", sessionId: "agent-a", actor: { role: "worker", id: "worker-a" } }).then(() => undefined, (caught: unknown) => caught);
  assert.equal((error as { code?: string }).code, "process_cleanup_unverified");
  assert.match((error as Error).message, /could not start/u);
  assert.ok(isProcessStopUnprovenError(error));
});
