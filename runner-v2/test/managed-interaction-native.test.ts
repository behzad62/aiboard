import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost, type ExecutionHostRunBinding } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { ToolBroker } from "../src/tool-broker.js";
import { createManagedProcessTools } from "../src/managed-process-tools.js";
import type { ManagedProcessService } from "../src/managed-process.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import type { ToolExecutionOutput } from "../src/agent-contracts.js";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";

// T1 acceptance (docs/plans/2026-11-03-remote-t1-interaction-ux.md §5) on real processes.
// CPU evidence comes from Windows Job accounting; elsewhere input_wait degrades to the idle heuristic.
const windows = process.platform === "win32";
const python = ["python", "python3"].map(name => spawnSync(name, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8", windowsHide: true }))
  .find(probe => probe.status === 0)?.stdout.trim();

const fixtures: Record<string, string> = {
  // A2/A3: an unterminated progress line, then 5 s of CPU work or of sleep.
  "busy.mjs": `process.stdout.write('progress 45% ');
const end = Date.now() + 5000; let x = 0; while (Date.now() < end) x += Math.sqrt(x + 1);
process.stdout.write('\\ndone\\n', () => process.exit(0));`,
  "sleepy.mjs": `process.stdout.write('progress 45% '); setTimeout(() => process.stdout.write('\\ndone\\n', () => process.exit(0)), 5000);`,
  // A4: listens on argv[2] after 2 s.
  "server.mjs": `import http from 'node:http';
setTimeout(() => http.createServer((_q, s) => s.end('ok')).listen(Number(process.argv[2]), '127.0.0.1', () => process.stdout.write('listening\\n')), 2000);`,
  "idle.mjs": `setInterval(() => {}, 1000);`,
  // A5: 20 s of streaming output, one line every 100 ms.
  "stream.mjs": `let i = 0; const t = setInterval(() => { process.stdout.write('tick ' + (++i) + '\\n'); if (i === 200) { clearInterval(t); process.exit(0); } }, 100);`,
  // A12: 100 carriage-return progress updates and ANSI-colored lines.
  "progress.mjs": `let out = '';
for (let i = 1; i <= 100; i++) out += '\\r[' + '#'.repeat(Math.floor(i / 10)).padEnd(10) + '] ' + i + '%';
out += '\\n';
for (let i = 1; i <= 5; i++) out += '\\u001b[3' + i + 'mcolor line ' + i + '\\u001b[0m\\n';
process.stdout.write(out, () => process.exit(0));`,
};

type Invoke = (name: string, input: Record<string, unknown>) => Promise<ToolExecutionOutput>;
async function withHost(t: TestContext, body: (f: { project: string; run: ExecutionHostRunBinding; invoke: Invoke }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "managed-interaction-native-"));
  const project = join(root, "project"), state = join(root, "state");
  await mkdir(project); await mkdir(state);
  for (const [name, source] of Object.entries(fixtures)) await writeFile(join(project, name), source);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  let run: ExecutionHostRunBinding | undefined, failed = false, primary: unknown;
  try {
    run = await host.bindRun({ runId: "managed-interaction", permissionProfile: "full", capabilityContract: { digest: "d".repeat(64) } as RunnerCapabilityContract, capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
    const broker = new ToolBroker({ permissionProfile: "full", workspacePath: project, executionGrants: run.executionGrants, artifacts, maxInlineOutputBytes: 512 * 1024 });
    for (const tool of createManagedProcessTools(run.managedProcesses)) broker.register(tool);
    let sequence = 0;
    const invoke: Invoke = (name, input) => broker.invoke({ type: "tool_call", callId: `call-${++sequence}`, name, arguments: input },
      { runId: run!.runId, sessionId: "agent", actor: { role: "worker", id: "worker" }, workspacePath: project });
    await body({ project, run, invoke });
  } catch (error) { failed = true; primary = error; }
  finally {
    await finalizeCertifiedFixture({ fixtureName: "managed interaction native", root, hasPrimaryFailure: failed, primaryFailure: primary,
      cleanup: async () => { const errors: unknown[] = []; for (const close of [() => run?.close(), () => host.close()]) { try { await close(); } catch (error) { errors.push(error); } } if (errors.length) throw new AggregateError(errors, "managed interaction cleanup failed"); },
      certify: async () => { assert.deepEqual(host.activeRunIds(), []); },
      removeRoot: async () => { await rm(root, { recursive: true }); } });
  }
}

function blocks(output: ToolExecutionOutput): Record<string, unknown>[] {
  assert.equal(output.isError, false, JSON.stringify(output));
  return output.content.filter(item => item.type === "json").map(item => (item as { value: Record<string, unknown> }).value);
}
type Completion = { source: string; confidence: string | null; quietMs?: number; cpuDeltaMs?: number; preexistingPort?: true; matched?: string };
type Slice = { stream: string; text?: string; lines?: string[]; startLine?: number; totalLines?: number; hasMore: boolean; render?: string };
type Read = { status: string; exitCode: number | null; cursor: string; slices: Slice[]; completion?: Completion; state?: string };
/** process.start with until: [snapshot, { read }]. */
async function startAndWait(f: { invoke: Invoke }, input: Record<string, unknown>): Promise<{ processId: string; read: Read; elapsedMs: number }> {
  const began = Date.now();
  const [snapshot, wait] = blocks(await f.invoke("process.start", input));
  const elapsedMs = Date.now() - began;
  assert.ok(wait && "read" in wait, JSON.stringify(wait));
  return { processId: snapshot!.processId as string, read: wait.read as Read, elapsedMs };
}
const text = (read: Read) => read.slices.map(slice => slice.text ?? "").join("");
async function stop(f: { invoke: Invoke }, processId: string) { await f.invoke("process.signal", { processId, signal: "SIGTERM" }); }

test("A1: a question without a newline is input_wait, then the answer turn ends with exited", { timeout: 120_000, skip: python ? false : "python not on PATH" }, async t => withHost(t, async f => {
  const { processId, read, elapsedMs } = await startAndWait(f, { command: python!, args: ["-u", "-c", "x = input('Proceed with deploy? [y/N] '); print('answer:' + x)"],
    interactive: true, until: { idleMs: 1500 }, waitMs: 15_000 });
  assert.match(text(read), /Proceed with deploy\? \[y\/N\] $/);
  if (windows) {
    assert.deepEqual([read.completion?.source, read.completion?.confidence], ["input_wait", "likely"], JSON.stringify(read.completion));
    assert.ok(elapsedMs < 6_000, `input_wait took ${elapsedMs} ms`);
  } else assert.ok(["input_wait", "idle"].includes(read.completion!.source), JSON.stringify(read.completion));
  assert.equal(read.state, windows ? "awaiting_input" : read.completion!.source === "idle" ? "idle" : "awaiting_input");
  const [turn] = blocks(await f.invoke("process.interact", { processId, data: "y" }));
  const answer = turn!.read as Read;
  assert.equal((turn!.write as { status: string }).status, "acknowledged");
  assert.deepEqual([answer.completion?.source, answer.completion?.confidence], ["exited", "certain"]);
  assert.match(text(answer), /answer:y/);
  assert.doesNotMatch(text(answer), /Proceed with deploy/, "only this turn's output is returned");
}));

test("A2: an unterminated progress line followed by CPU work is not cut short", { timeout: 120_000, skip: windows ? false : "CPU evidence is Windows-only in T1" }, async t => withHost(t, async f => {
  const { read, elapsedMs } = await startAndWait(f, { command: process.execPath, args: ["busy.mjs"], until: { idleMs: 1500 }, waitMs: 20_000 });
  assert.deepEqual([read.completion?.source, read.completion?.confidence], ["exited", "certain"], JSON.stringify(read.completion));
  assert.ok(elapsedMs >= 4_500, `returned after ${elapsedMs} ms, before the busy loop ended`);
  assert.match(text(read), /done/);
}));

test("A3: an unterminated progress line followed by sleep is input_wait likely, never before idleMs", { timeout: 120_000, skip: windows ? false : "CPU evidence is Windows-only in T1" }, async t => withHost(t, async f => {
  const { processId, read, elapsedMs } = await startAndWait(f, { command: process.execPath, args: ["sleepy.mjs"], until: { idleMs: 1500 }, waitMs: 20_000 });
  assert.deepEqual([read.completion?.source, read.completion?.confidence], ["input_wait", "likely"], JSON.stringify(read.completion));
  assert.ok(elapsedMs >= 1_500 && elapsedMs < 5_000, `elapsed ${elapsedMs} ms`);
  assert.ok((read.completion!.quietMs ?? 0) >= 1_500);
  assert.equal(read.status, "running");
  await stop(f, processId);
}));

test("A4: until.port returns certain readiness in one call; a pre-existing listener is only a heuristic", { timeout: 120_000 }, async t => withHost(t, async f => {
  const free = await new Promise<number>(resolve => { const s = createServer().listen(0, "127.0.0.1", () => { const port = (s.address() as AddressInfo).port; s.close(() => resolve(port)); }); });
  const { processId, read, elapsedMs } = await startAndWait(f, { command: process.execPath, args: ["server.mjs", String(free)], until: { port: free }, waitMs: 20_000 });
  assert.deepEqual([read.completion?.source, read.completion?.confidence], ["port", "certain"], JSON.stringify(read.completion));
  assert.equal(read.completion!.preexistingPort, undefined);
  assert.ok(elapsedMs >= 1_900, `port reported after ${elapsedMs} ms, before the server listened`);
  await stop(f, processId);
  const squatter = createServer().listen(0, "127.0.0.1");
  await new Promise(resolve => squatter.once("listening", resolve));
  try {
    const port = (squatter.address() as AddressInfo).port;
    const other = await startAndWait(f, { command: process.execPath, args: ["idle.mjs"], until: { port }, waitMs: 5_000 });
    assert.deepEqual([other.read.completion?.source, other.read.completion?.confidence, other.read.completion?.preexistingPort], ["port", "heuristic", true]);
    await stop(f, other.processId);
  } finally { await new Promise(resolve => squatter.close(resolve)); }
}));

test("A5: 20 s of streaming output is one call with until.exit", { timeout: 120_000 }, async t => withHost(t, async f => {
  const { read, elapsedMs } = await startAndWait(f, { command: process.execPath, args: ["stream.mjs"], until: { exit: true }, waitMs: 30_000 });
  assert.deepEqual([read.completion?.source, read.completion?.confidence], ["exited", "certain"], JSON.stringify(read.completion));
  const lines = text(read).split("\n").filter(Boolean);
  assert.equal(lines.length, 200);
  assert.equal(lines.at(-1), "tick 200");
  assert.ok(elapsedMs >= 19_000, `elapsed ${elapsedMs} ms`);
}));

test("A6: python -i takes one call per turn, including a turn that raises", { timeout: 120_000, skip: python ? false : "python not on PATH" }, async t => withHost(t, async f => {
  const promptEvidence = (read: Read) => ["input_wait", "known_prompt"].includes(read.completion!.source);
  const { processId, read } = await startAndWait(f, { command: python!, args: ["-i", "-u"], interactive: true, until: { idleMs: 1500 }, waitMs: 15_000 });
  assert.match(text(read), /Python 3[\s\S]*>>> $/, "the banner and the first prompt are returned");
  assert.ok(promptEvidence(read), JSON.stringify(read.completion));
  const turn = async (data: string) => { const [value] = blocks(await f.invoke("process.interact", { processId, data })); return value!.read as Read; };
  const sum = await turn("1 + 1");
  assert.match(text(sum), /^2\r?\n>>> $/m); assert.ok(promptEvidence(sum), JSON.stringify(sum.completion));
  const raised = await turn("raise ValueError('boom')");
  assert.match(text(raised), /Traceback[\s\S]*ValueError: boom[\s\S]*>>> $/); assert.ok(promptEvidence(raised), JSON.stringify(raised.completion));
  const printed = await turn("print('ok')");
  assert.match(text(printed), /^ok\r?\n>>> $/m); assert.doesNotMatch(text(printed), /boom/, "earlier turns are not repeated");
  await stop(f, processId);
}));

test("A9: unsafe or oversized patterns are rejected at validation and nothing runs", async () => {
  const service = new Proxy({}, { get: () => () => { throw new Error("must not be reached"); } }) as unknown as ManagedProcessService;
  const tools = createManagedProcessTools(service);
  const read = tools.find(tool => tool.definition.name === "process.read_output")!;
  const interact = tools.find(tool => tool.definition.name === "process.interact")!;
  const start = tools.find(tool => tool.definition.name === "process.start")!;
  for (const pattern of ["(a+)+$", "(a)\\1", "(?=a)b", "x".repeat(257)]) {
    for (const [tool, input] of [[read, { processId: "p" }], [interact, { processId: "p", data: "x" }], [start, { command: "node" }]] as const) {
      assert.equal(tool.validate({ ...input, until: { pattern } }).ok, false, `${tool.definition.name} ${pattern.slice(0, 20)}`);
    }
  }
  assert.equal(read.validate({ processId: "p", until: { pattern: "ready on port \\d+" } }).ok, true);
});

test("A7/A8: an unacknowledged turn carries no output; a failed read after delivery stays successful", async () => {
  let reply: unknown;
  const service = { interact: async () => reply } as unknown as ManagedProcessService;
  const interact = createManagedProcessTools(service).find(tool => tool.definition.name === "process.interact")!;
  const context = { callId: "call-1" } as Parameters<typeof interact.execute>[1];
  reply = { processId: "p", write: { processId: "p", writeId: "w", status: "outcome_unknown", errorCode: "process_input_outcome_unknown", message: "Input not acknowledged." } };
  const unknown = await interact.execute({ processId: "p", data: "x" }, context);
  assert.equal(unknown.isError, true);
  assert.equal(unknown.error?.code, "process_input_outcome_unknown");
  assert.doesNotMatch(JSON.stringify(unknown.content), /"read"|completion/);
  reply = { processId: "p", write: { processId: "p", writeId: "w", status: "acknowledged" }, readError: { code: "process_cancelled", message: "cancelled" } };
  const delivered = await interact.execute({ processId: "p", data: "x" }, context);
  assert.equal(delivered.isError, false);
  assert.match(JSON.stringify(delivered.content), /"readError"/);
});

test("A12: plain render collapses a carriage-return progress bar and strips ANSI; lines paging is consistent", { timeout: 120_000 }, async t => withHost(t, async f => {
  const { processId, read } = await startAndWait(f, { command: process.execPath, args: ["progress.mjs"], until: { exit: true }, waitMs: 20_000, render: "plain" });
  const plain = text(read);
  assert.doesNotMatch(plain, /[\u001b\r]/);
  assert.equal(plain, "[##########] 100%\n" + [1, 2, 3, 4, 5].map(i => `color line ${i}\n`).join(""));
  const page = async (start: number, count: number) => {
    const [value] = blocks(await f.invoke("process.read_output", { processId, stream: "stdout", lines: { start, count } }));
    return (value as unknown as Read).slices[0]!;
  };
  const first = await page(0, 4), second = await page(4, 4), last = await page(-2, 2);
  assert.deepEqual(first.lines, ["[##########] 100%", "color line 1", "color line 2", "color line 3"]);
  assert.deepEqual(second.lines, ["color line 4", "color line 5"]);
  assert.deepEqual(last.lines, ["color line 4", "color line 5"]);
  assert.equal(first.totalLines, 6); assert.equal(second.totalLines, 6);
  assert.equal(first.hasMore, true); assert.equal(second.hasMore, false);
}));
