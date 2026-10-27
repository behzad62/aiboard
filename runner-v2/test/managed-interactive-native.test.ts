import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost, type ExecutionHostRunBinding } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { ToolBroker } from "../src/tool-broker.js";
import { createManagedProcessTools } from "../src/managed-process-tools.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import type { ToolExecutionOutput } from "../src/agent-contracts.js";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";

// Line-oriented REPL: echoes each line, reports the count at EOF and exits 0.
const repl = `import readline from 'node:readline';
let count = 0; const rl = readline.createInterface({ input: process.stdin });
process.stdout.write('ready\\n');
rl.on('line', line => { count++; process.stdout.write('got:' + line + '\\n'); });
rl.on('close', () => process.stdout.write('eof:' + count + '\\n', () => process.exit(0)));`;
// Large mixed output: 300 KiB of numbered stdout lines and multi-byte stderr, then waits for quit.
const chatty = `import fs from 'node:fs';
let out = ''; for (let i = 0; i < 6000; i++) out += 'line-' + String(i).padStart(5, '0') + ' ' + 'x'.repeat(38) + '\\n';
process.stdout.write(out);
process.stderr.write('€'.repeat(3000));
const timer = setInterval(() => { if (fs.existsSync(process.argv[2])) { clearInterval(timer); process.stdout.write('done\\n', () => process.exit(3)); } }, 20);`;

type Invoke = (name: string, input: Record<string, unknown>, agent?: string) => Promise<ToolExecutionOutput>;
async function withHost(t: TestContext, body: (f: { project: string; run: ExecutionHostRunBinding; invoke: Invoke }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "managed-interactive-native-"));
  const project = join(root, "project"), state = join(root, "state");
  await mkdir(project); await mkdir(state);
  await writeFile(join(project, "repl.mjs"), repl); await writeFile(join(project, "chatty.mjs"), chatty);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  let run: ExecutionHostRunBinding | undefined, failed = false, primary: unknown;
  try {
    run = await host.bindRun({ runId: "managed-interactive", permissionProfile: "full", capabilityContract: { digest: "d".repeat(64) } as RunnerCapabilityContract, capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
    const broker = new ToolBroker({ permissionProfile: "full", workspacePath: project, executionGrants: run.executionGrants, artifacts, maxInlineOutputBytes: 512 * 1024 });
    for (const tool of createManagedProcessTools(run.managedProcesses)) broker.register(tool);
    let sequence = 0;
    const invoke: Invoke = (name, input, agent = "agent") => broker.invoke({ type: "tool_call", callId: `call-${++sequence}`, name, arguments: input },
      { runId: run!.runId, sessionId: agent, actor: { role: "worker", id: "worker" }, workspacePath: project });
    await body({ project, run, invoke });
  } catch (error) { failed = true; primary = error; }
  finally {
    await finalizeCertifiedFixture({ fixtureName: "managed interactive native", root, hasPrimaryFailure: failed, primaryFailure: primary,
      cleanup: async () => { const errors: unknown[] = []; for (const close of [() => run?.close(), () => host.close()]) { try { await close(); } catch (error) { errors.push(error); } } if (errors.length) throw new AggregateError(errors, "managed interactive cleanup failed"); },
      certify: async () => { assert.deepEqual(host.activeRunIds(), []); },
      removeRoot: async () => { await rm(root, { recursive: true }); } });
  }
}
function json(output: ToolExecutionOutput): Record<string, unknown> {
  assert.equal(output.isError, false, JSON.stringify(output));
  const block = output.content.find(item => item.type === "json"); assert.ok(block?.type === "json"); return block.value as Record<string, unknown>;
}
type Slice = { stream: string; text: string; startOffset: number; endOffset: number; hasMore: boolean; gap?: { fromOffset: number; toOffset: number; reason: string }; totalBytes: number };
type Read = { status: string; exitCode: number | null; cursor: string; slices: Slice[]; complete: boolean; source: string; waited?: string };

test("a real interactive process receives ordered acknowledged writes and EOF exactly once", { timeout: 120_000 }, async t => withHost(t, async f => {
  const started = json(await f.invoke("process.start", { command: process.execPath, args: ["repl.mjs"], interactive: true }));
  const id = started.processId as string;
  let read = json(await f.invoke("process.read_output", { processId: id, stream: "stdout", waitMs: 10_000 })) as unknown as Read;
  let transcript = read.slices[0]!.text;
  assert.match(transcript, /ready/);
  const first = json(await f.invoke("process.write_stdin", { processId: id, writeId: "w1", data: "alpha", appendNewline: true }));
  assert.equal(first.status, "acknowledged");
  const duplicate = json(await f.invoke("process.write_stdin", { processId: id, writeId: "w1", data: "alpha", appendNewline: true }));
  assert.equal(duplicate.deduplicated, true);
  const conflict = await f.invoke("process.write_stdin", { processId: id, writeId: "w1", data: "other", appendNewline: true });
  assert.equal(conflict.isError, true); assert.equal(conflict.error?.code, "process_input_conflict");
  const foreign = await f.invoke("process.write_stdin", { processId: id, writeId: "w9", data: "intrusion\n" }, "foreign-agent");
  assert.equal(foreign.isError, true);
  assert.equal(json(await f.invoke("process.write_stdin", { processId: id, writeId: "w2", data: "beta", appendNewline: true })).status, "acknowledged");
  assert.equal(json(await f.invoke("process.write_stdin", { processId: id, writeId: "w3", closeInput: true })).inputClosed, true);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    read = json(await f.invoke("process.read_output", { processId: id, stream: "stdout", cursor: read.cursor, waitMs: 5_000 })) as unknown as Read;
    transcript += read.slices[0]!.text;
    if (read.status === "stopped" && !read.slices[0]!.hasMore) break;
  }
  assert.equal(transcript, "ready\ngot:alpha\ngot:beta\neof:2\n", "each acknowledged line arrives once, in order, then EOF");
  assert.equal(read.exitCode, 0);
  const late = await f.invoke("process.write_stdin", { processId: id, writeId: "w4", data: "late\n" });
  assert.equal(late.isError, true);
  const plain = json(await f.invoke("process.start", { command: process.execPath, args: ["chatty.mjs", join(f.project, "quit")] }));
  const refused = await f.invoke("process.write_stdin", { processId: plain.processId as string, writeId: "w1", data: "x" });
  assert.equal(refused.error?.code, "process_input_not_enabled");
  await writeFile(join(f.project, "quit"), "stop");
  await f.invoke("process.signal", { processId: plain.processId as string, signal: "SIGTERM" });
  for (const sessionId of f.run.streamingState.listSessionIds()) assert.equal(f.run.streamingState.readSession(sessionId)!.state, "released");
}));

test("large real output supports new-only cursors, independent readers, retained ranges, UTF-8 and honest gaps", { timeout: 120_000 }, async t => withHost(t, async f => {
  const quit = join(f.project, "quit");
  const started = json(await f.invoke("process.start", { command: process.execPath, args: ["chatty.mjs", quit] }));
  const id = started.processId as string;
  // Wait until all 300 000 stdout bytes and 9 000 stderr bytes are spooled.
  let probe: Read;
  const deadline = Date.now() + 30_000;
  do {
    probe = json(await f.invoke("process.read_output", { processId: id, tailBytes: 16, waitMs: 2_000 })) as unknown as Read;
  } while (Date.now() < deadline && !(probe.slices[0]!.totalBytes >= 300_000 && probe.slices[1]!.totalBytes >= 9_000));
  assert.equal(probe.slices[0]!.totalBytes, 300_000); assert.equal(probe.slices[1]!.totalBytes, 9_000);
  // A fresh reader starting at 0 is told explicitly that bytes before the retained live tail are gone.
  const fresh = json(await f.invoke("process.read_output", { processId: id, stream: "stdout", maxBytes: 4096 })) as unknown as Read;
  const first = fresh.slices[0]!;
  assert.ok(first.gap, "300 KiB exceeds the 128 KiB live tail");
  assert.equal(first.gap!.fromOffset, 0); assert.equal(first.startOffset, first.gap!.toOffset);
  assert.equal(first.text.length, first.endOffset - first.startOffset);
  // Retained content is exact: line numbers are recomputed from the absolute offset.
  const lineStart = Math.ceil(first.startOffset / 50) * 50;
  const index = lineStart / 50;
  assert.ok(first.text.includes(`line-${String(index).padStart(5, "0")} `), "absolute offsets map to the exact bytes");
  // Reader A pages forward; reader B's cursor is unaffected by A's progress.
  let a = fresh, pages = 0;
  while (a.slices[0]!.hasMore && pages < 64) { a = json(await f.invoke("process.read_output", { processId: id, stream: "stdout", cursor: a.cursor, maxBytes: 65_536 })) as unknown as Read; pages++; }
  assert.equal(a.slices[0]!.endOffset, 300_000);
  const b = json(await f.invoke("process.read_output", { processId: id, stream: "stdout", cursor: fresh.cursor, maxBytes: 100 })) as unknown as Read;
  assert.equal(b.slices[0]!.startOffset, first.endOffset);
  // Multi-byte stderr in tiny pages never splits a character.
  let errCursor: string | undefined, joined = "";
  for (let i = 0; i < 4; i++) {
    const page = json(await f.invoke("process.read_output", { processId: id, stream: "stderr", maxBytes: 5, ...(errCursor ? { cursor: errCursor } : {}) })) as unknown as Read;
    assert.ok(!page.slices[0]!.text.includes("�")); joined += page.slices[0]!.text; errCursor = page.cursor;
  }
  assert.equal(joined, "€".repeat(4));
  // New-only read with a bounded wait returns at termination with unread data still reported.
  await writeFile(quit, "stop");
  const waited = json(await f.invoke("process.read_output", { processId: id, stream: "stdout", cursor: a.cursor, waitMs: 20_000 })) as unknown as Read;
  assert.ok(["changed", "terminal"].includes(waited.waited ?? "changed"));
  let tailRead = waited;
  const exitDeadline = Date.now() + 30_000;
  while (tailRead.status !== "stopped" && Date.now() < exitDeadline) tailRead = json(await f.invoke("process.read_output", { processId: id, stream: "stdout", cursor: a.cursor, waitMs: 5_000 })) as unknown as Read;
  assert.equal(tailRead.status, "stopped"); assert.equal(tailRead.exitCode, 3); assert.equal(tailRead.slices[0]!.text, "done\n");
  // Historical read of the earliest range after completion: exact from the spill, or an explicit gap — never silent.
  const early = json(await f.invoke("process.read_output", { processId: id, range: { stream: "stdout", startOffset: 0 }, maxBytes: 100 })) as unknown as Read;
  const slice = early.slices[0]!;
  if (slice.gap) assert.equal(slice.gap.fromOffset, 0);
  else assert.equal(slice.text, `line-00000 ${"x".repeat(38)}\nline-00001 ${"x".repeat(38)}\n`);
  t.diagnostic(`completed earliest-range source: ${slice.gap ? `gap ${slice.gap.reason}` : "finalized spill"}`);
  assert.equal(early.complete, false, "a range read never claims completeness");
}));
