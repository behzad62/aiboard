import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ToolExecutionContext, ToolExecutionOutput } from "../src/agent-contracts.js";
import type { OpaqueExecutionGrant } from "../src/execution-grants.js";
import { ManagedProcessService, type ManagedOutputEvidence, type ManagedProcessSnapshot } from "../src/managed-process.js";
import { readManagedRecordValue } from "../src/managed-process-record.js";
import { createManagedProcessTools } from "../src/managed-process-tools.js";

type Facts = Pick<ManagedProcessSnapshot, "status" | "exitCode" | "signal">;
const RUNNING: Facts = { status: "running", exitCode: null, signal: null };

/** A real service and real tools over a scripted runtime: only the observed process facts are fake. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "managed-reported-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let facts = RUNNING, call = 0;
  const snapshot = (processId: string): ManagedProcessSnapshot => ({ processId, pid: 42, ...facts,
    startedAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z", stdout: "", stderr: "" });
  const runtime = {
    runId: "run",
    async start(request: { identity: { processId: string } }) { return snapshot(request.identity.processId); },
    async observe(target: { processId: string }) { return snapshot(target.processId); },
    async stop(target: { processId: string }) { facts = { status: "stopped", exitCode: null, signal: null }; return snapshot(target.processId); },
    async writeInput(_target: unknown, _context: unknown, request: { closeInput: boolean }) { return { inputClosed: request.closeInput }; },
    async readOutput(target: { processId: string }): Promise<ManagedOutputEvidence> {
      return { snapshot: snapshot(target.processId), source: facts.status === "running" ? "live" : "final", streams: [
        { stream: "stdout", totalBytes: 0, tail: new Uint8Array(), lossyBytes: 0, lossReasons: [] },
        { stream: "stderr", totalBytes: 0, tail: new Uint8Array(), lossyBytes: 0, lossReasons: [] },
      ] };
    },
  };
  const service = new ManagedProcessService({ stateDirectory: join(root, "state"), runtime, idFactory: () => "p1" } as unknown as ConstructorParameters<typeof ManagedProcessService>[0]);
  t.after(() => service.close().catch(() => undefined));
  const tools = createManagedProcessTools(service);
  const invoke = async (name: string, input: Record<string, unknown>): Promise<Record<string, unknown>[]> => {
    const tool = tools.find(entry => entry.definition.name === name)!;
    const context: ToolExecutionContext = { runId: "run", sessionId: "agent", actor: { role: "worker", id: "worker" }, workspacePath: root,
      callId: `call-${++call}`, toolName: name, executionGrant: Object.freeze({}) as OpaqueExecutionGrant };
    const output: ToolExecutionOutput = await tool.execute(input, context);
    assert.equal(output.isError, false, JSON.stringify(output));
    return output.content.filter(block => block.type === "json").map(block => (block as { value: Record<string, unknown> }).value);
  };
  /** Every tool path that reports a process status, as [path, status]. */
  const everyStatus = async (processId: string): Promise<[string, unknown][]> => {
    const list = (await invoke("process.list", {}))[0]!.processes as { status: string }[];
    const interact = (await invoke("process.interact", { processId, data: "y", until: { exit: true }, waitMs: 0 }))[0]!;
    return [
      ["poll", (await invoke("process.poll", { processId }))[0]!.status],
      ["list", list[0]!.status],
      ["read raw", (await invoke("process.read_output", { processId, until: { exit: true } }))[0]!.status],
      ["read plain", (await invoke("process.read_output", { processId, render: "plain" }))[0]!.status],
      ["read lines", (await invoke("process.read_output", { processId, lines: { start: 0, count: 5 } }))[0]!.status],
      ["interact", (interact.read as { status: string }).status],
    ];
  };
  const started = async () => (await invoke("process.start", { command: "repl", interactive: true }))[0]!.processId as string;
  const record = () => readFile(join(root, "state", "p1.json"), "utf8");
  return { invoke, everyStatus, started, record, recordPath: join(root, "state", "p1.json"), setFacts(next: Facts) { facts = next; } };
}

const allAre = (status: string, seen: [string, unknown][]) => assert.deepEqual(seen, seen.map(([path]) => [path, status]));

test("a proven exit reads exited on every tool path, beside exited/certain, while the record keeps exited_unknown", async t => {
  const f = await fixture(t);
  const processId = await f.started();
  f.setFacts({ status: "exited_unknown", exitCode: 0, signal: null });
  allAre("exited", await f.everyStatus(processId));
  const read = (await f.invoke("process.read_output", { processId, until: { exit: true } }))[0]!;
  assert.deepEqual(read.completion, { source: "exited", confidence: "certain" });
  assert.equal(read.state, "exited");
  assert.equal(read.exitCode, 0);
  // Rollback: the stored enum is untouched and the unchanged record reader still accepts it.
  const stored = JSON.parse(await f.record()) as { status: string; exitCode: number };
  assert.deepEqual([stored.status, stored.exitCode], ["exited_unknown", 0]);
  assert.doesNotMatch(await f.record(), /"status":\s*"exited"/);
  assert.equal((readManagedRecordValue(f.recordPath) as { status: string }).status, "exited_unknown");
});

test("a signal is also proof of exit", async t => {
  const f = await fixture(t);
  const processId = await f.started();
  f.setFacts({ status: "exited_unknown", exitCode: null, signal: "SIGTERM" });
  allAre("exited", await f.everyStatus(processId));
});

test("process.start reports a proven exit in both its snapshot and its same-call read", async t => {
  const f = await fixture(t);
  f.setFacts({ status: "exited_unknown", exitCode: 3, signal: null });
  const [snapshot, wait] = await f.invoke("process.start", { command: "fast", until: { exit: true } });
  assert.equal(snapshot!.status, "exited");
  assert.equal((wait!.read as { status: string }).status, "exited");
  assert.equal(snapshot!.exitCode, 3, "a failed exit still reads exited; exitCode carries the result");
});

test("fail closed: an unproven exit never reads exited and stays unavailable/unknown", async t => {
  const f = await fixture(t);
  const processId = await f.started();
  f.setFacts({ status: "exited_unknown", exitCode: null, signal: null });
  allAre("exited_unknown", await f.everyStatus(processId));
  const read = (await f.invoke("process.read_output", { processId, until: { exit: true } }))[0]!;
  // No confidence at all, so none is named.
  assert.deepEqual(read.completion, { source: "unavailable" });
  assert.equal(read.state, "unknown");
});

test("running and stopped pass through unchanged, even with an exit code beside running", async t => {
  const f = await fixture(t);
  const processId = await f.started();
  // Launcher exited while Job descendants remain: the session is still live, so it must not read as exited.
  f.setFacts({ status: "running", exitCode: 0, signal: null });
  assert.equal((await f.invoke("process.poll", { processId }))[0]!.status, "running");
  assert.equal((await f.invoke("process.read_output", { processId }))[0]!.status, "running");
  f.setFacts({ status: "stopped", exitCode: null, signal: null });
  assert.equal((await f.invoke("process.poll", { processId }))[0]!.status, "stopped");
  assert.equal((await f.invoke("process.read_output", { processId }))[0]!.status, "stopped");
});
