import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ToolExecutionContext } from "../src/agent-contracts.js";
import type { OpaqueExecutionGrant } from "../src/execution-grants.js";
import { ManagedProcessError, ManagedProcessService, type ManagedOutputEvidence, type ManagedProcessSnapshot } from "../src/managed-process.js";
import { decodeOutputCursor, encodeOutputCursor, sliceOutput, utf8CompleteLength } from "../src/managed-process-output.js";
import { createManagedProcessTools } from "../src/managed-process-tools.js";

type Write = { bytes: string; closeInput: boolean };
interface Hooks { write?: (request: Write) => Promise<void> }

async function fixture(t: TestContext, hooks: Hooks = {}, root?: string) {
  root ??= await mkdtemp(join(tmpdir(), "managed-io-"));
  const delivered: Write[] = []; let call = 0; let ids = 0;
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), status: ManagedProcessSnapshot["status"] = "running";
  const snapshot = (processId: string): ManagedProcessSnapshot => ({ processId, pid: 42, status, exitCode: status === "running" ? null : 0, signal: null,
    startedAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z", stdout: "", stderr: "" });
  const runtime = {
    runId: "run",
    async start(request: { identity: { processId: string } }) { return snapshot(request.identity.processId); },
    async observe(target: { processId: string }) { return snapshot(target.processId); },
    async stop(target: { processId: string }) { status = "stopped"; return snapshot(target.processId); },
    async writeInput(_target: unknown, _context: unknown, request: { bytes: Uint8Array; closeInput: boolean }) {
      const value = { bytes: Buffer.from(request.bytes).toString("utf8"), closeInput: request.closeInput };
      await hooks.write?.(value);
      delivered.push(value); return { inputClosed: request.closeInput };
    },
    async readOutput(target: { processId: string }): Promise<ManagedOutputEvidence> {
      return { snapshot: snapshot(target.processId), source: status === "running" ? "live" : "final", streams: [
        { stream: "stdout", totalBytes: stdout.byteLength, tail: new Uint8Array(stdout), lossyBytes: 0, lossReasons: [] },
        { stream: "stderr", totalBytes: stderr.byteLength, tail: new Uint8Array(stderr), lossyBytes: 0, lossReasons: [] },
      ] };
    },
  };
  const service = new ManagedProcessService({ stateDirectory: join(root, "state"), runtime, idFactory: () => `p${++ids}` } as unknown as ConstructorParameters<typeof ManagedProcessService>[0]);
  const context = (toolName: string, actorId = "worker"): ToolExecutionContext => ({ runId: "run", sessionId: "agent", actor: { role: "worker", id: actorId },
    workspacePath: root!, callId: `call-${++call}`, toolName, executionGrant: Object.freeze({}) as OpaqueExecutionGrant });
  return { root, service, delivered, context, emit(stream: "stdout" | "stderr", text: string | Buffer) {
    const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
    if (stream === "stdout") stdout = Buffer.concat([stdout, bytes]); else stderr = Buffer.concat([stderr, bytes]);
  }, exit() { status = "stopped"; }, async close() { await service.close().catch(() => undefined); } };
}

test("write_stdin is ordered, acknowledged, idempotent per writeId and conflicts on changed input", async t => {
  const f = await fixture(t);
  try {
    const started = await f.service.start({ command: "repl", interactive: true }, f.context("process.start"), f.root);
    const first = await f.service.writeInput(started.processId, { writeId: "w1", data: "alpha", appendNewline: true }, f.context("process.write_stdin"));
    assert.equal(first.status, "acknowledged"); assert.equal(first.deduplicated, false); assert.equal(first.byteLength, 6);
    await f.service.writeInput(started.processId, { writeId: "w2", data: "beta", appendNewline: true }, f.context("process.write_stdin"));
    const retry = await f.service.writeInput(started.processId, { writeId: "w1", data: "alpha", appendNewline: true }, f.context("process.write_stdin"));
    assert.equal(retry.status, "acknowledged"); assert.equal(retry.deduplicated, true);
    await assert.rejects(f.service.writeInput(started.processId, { writeId: "w1", data: "ALPHA", appendNewline: true }, f.context("process.write_stdin")), (error: unknown) => error instanceof ManagedProcessError && error.code === "process_input_conflict");
    const eof = await f.service.writeInput(started.processId, { writeId: "w3", closeInput: true }, f.context("process.write_stdin"));
    assert.equal(eof.inputClosed, true);
    assert.deepEqual(f.delivered, [{ bytes: "alpha\n", closeInput: false }, { bytes: "beta\n", closeInput: false }, { bytes: "", closeInput: true }]);
    await assert.rejects(f.service.writeInput(started.processId, { writeId: "w4", data: "late" }, f.context("process.write_stdin")), /closed/);
    const record = await readFile(join(f.root, "state", `${started.processId}.json`), "utf8");
    assert.doesNotMatch(record, /alpha|beta/, "the durable journal holds digests and lengths, never input bytes");
    assert.match(record, /"writeId":"w1"/);
  } finally { await f.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("write_stdin refuses non-interactive processes, foreign owners and invalid input before delivery", async t => {
  const f = await fixture(t);
  try {
    const plain = await f.service.start({ command: "server" }, f.context("process.start"), f.root);
    await assert.rejects(f.service.writeInput(plain.processId, { writeId: "w1", data: "x" }, f.context("process.write_stdin")), (error: unknown) => (error as ManagedProcessError).code === "process_input_not_enabled");
    const repl = await f.service.start({ command: "repl", interactive: true }, f.context("process.start"), f.root);
    await assert.rejects(f.service.writeInput(repl.processId, { writeId: "w1", data: "x" }, f.context("process.write_stdin", "intruder")), /another exact owner/);
    await assert.rejects(f.service.writeInput(repl.processId, { writeId: "w1", data: "x" }, f.context("process.poll")), /exact original ToolBroker grant/);
    await assert.rejects(f.service.writeInput(repl.processId, { writeId: "bad id!", data: "x" }, f.context("process.write_stdin")), /writeId/);
    await assert.rejects(f.service.writeInput(repl.processId, { writeId: "w2", data: "x".repeat(70_000) }, f.context("process.write_stdin")), /exceeds/);
    await assert.rejects(f.service.writeInput(repl.processId, { writeId: "w3" }, f.context("process.write_stdin")), /Provide data/);
    assert.deepEqual(f.delivered, []);
  } finally { await f.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("an unacknowledged write is outcome_unknown, blocks nothing silently and is never resent on retry", async t => {
  let fail = true;
  const f = await fixture(t, { write: async () => { if (fail) throw new Error("channel lost after send"); } });
  try {
    const repl = await f.service.start({ command: "repl", interactive: true }, f.context("process.start"), f.root);
    const uncertain = await f.service.writeInput(repl.processId, { writeId: "w1", data: "pay" }, f.context("process.write_stdin"));
    assert.equal(uncertain.status, "outcome_unknown"); assert.match(uncertain.message!, /not be resent/);
    fail = false;
    const retried = await f.service.writeInput(repl.processId, { writeId: "w1", data: "pay" }, f.context("process.write_stdin"));
    assert.equal(retried.status, "outcome_unknown"); assert.equal(retried.deduplicated, true);
    assert.deepEqual(f.delivered, [], "the uncertain write is not replayed");
  } finally { await f.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a write pending at a crash becomes outcome_unknown after restart and is not replayed", async t => {
  const root = await mkdtemp(join(tmpdir(), "managed-io-restart-"));
  const first = await fixture(t, {}, root);
  const repl = await first.service.start({ command: "repl", interactive: true }, first.context("process.start"), root);
  // Simulate a crash between the durable pending entry and the acknowledgement.
  const path = join(root, "state", `${repl.processId}.json`);
  const record = JSON.parse(await readFile(path, "utf8"));
  record.input.writes.push({ writeId: "w-crash", digest: createHash("sha256").update("x").digest("hex"), byteLength: 1, closeInput: false, status: "pending", requestedAt: "2026-10-26T00:00:00.000Z" });
  await writeFile(path, JSON.stringify(record));
  const second = await fixture(t, {}, root);
  try {
    const reloaded = JSON.parse(await readFile(path, "utf8"));
    assert.equal(reloaded.input.writes[0].status, "outcome_unknown");
    assert.equal(reloaded.input.writes[0].errorCode, "process_input_interrupted");
    assert.deepEqual(second.delivered, []);
  } finally { await second.close(); await rm(root, { recursive: true, force: true }); }
});

test("read_output pages new-only output with caller-held cursors that do not interfere", async t => {
  const f = await fixture(t);
  try {
    const p = await f.service.start({ command: "server" }, f.context("process.start"), f.root);
    f.emit("stdout", "one\ntwo\n");
    const a1 = await f.service.readOutput(p.processId, { stream: "stdout" }, f.context("process.read_output"));
    assert.equal(a1.slices[0]!.text, "one\ntwo\n"); assert.equal(a1.slices[0]!.endOffset, 8); assert.equal(a1.complete, false);
    f.emit("stdout", "three\n");
    const a2 = await f.service.readOutput(p.processId, { cursor: a1.cursor, stream: "stdout" }, f.context("process.read_output"));
    assert.equal(a2.slices[0]!.text, "three\n"); assert.equal(a2.slices[0]!.startOffset, 8);
    // An independent reader starting fresh still sees everything; the first reader's view is unaffected.
    const b1 = await f.service.readOutput(p.processId, { stream: "stdout" }, f.context("process.read_output"));
    assert.equal(b1.slices[0]!.text, "one\ntwo\nthree\n");
    const a3 = await f.service.readOutput(p.processId, { cursor: a2.cursor, stream: "stdout" }, f.context("process.read_output"));
    assert.equal(a3.slices[0]!.text, ""); assert.equal(a3.slices[0]!.hasMore, false);
    const tail = await f.service.readOutput(p.processId, { tailBytes: 6, stream: "stdout" }, f.context("process.read_output"));
    assert.equal(tail.slices[0]!.text, "three\n");
    const range = await f.service.readOutput(p.processId, { range: { stream: "stdout", startOffset: 4 }, maxBytes: 4 }, f.context("process.read_output"));
    assert.equal(range.slices[0]!.text, "two\n");
    f.exit();
    const done = await f.service.readOutput(p.processId, { cursor: a3.cursor }, f.context("process.read_output"));
    assert.equal(done.complete, true, "terminal, read to the end and lossless");
  } finally { await f.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("read_output rejects foreign, altered and stale cursors without reading", async t => {
  const f = await fixture(t);
  try {
    const one = await f.service.start({ command: "a" }, f.context("process.start"), f.root);
    const two = await f.service.start({ command: "b" }, f.context("process.start"), f.root);
    f.emit("stdout", "data");
    const read = await f.service.readOutput(one.processId, {}, f.context("process.read_output"));
    await assert.rejects(f.service.readOutput(two.processId, { cursor: read.cursor }, f.context("process.read_output")), (error: unknown) => (error as ManagedProcessError).code === "process_output_cursor_foreign");
    const [body, mac] = read.cursor.split(".");
    const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), o: [0, 0] })).toString("base64url");
    await assert.rejects(f.service.readOutput(one.processId, { cursor: `${altered}.${mac}` }, f.context("process.read_output")), (error: unknown) => (error as ManagedProcessError).code === "process_output_cursor_invalid");
    await assert.rejects(f.service.readOutput(one.processId, { cursor: read.cursor }, f.context("process.read_output", "intruder")), /another exact owner/);
    const key = new Uint8Array(32);
    const stale = encodeOutputCursor(key, { processId: "p", launchId: "l", generation: "g1" }, { stdout: 1, stderr: 0 });
    assert.throws(() => decodeOutputCursor(key, { processId: "p", launchId: "l", generation: "g2" }, stale), /earlier output generation/);
  } finally { await f.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("output slices never split UTF-8 characters and report retention gaps explicitly", async () => {
  const text = "a€b€c€d"; // € is three bytes
  const bytes = Buffer.from(text);
  const evidence = (tailFrom: number, lossyBytes = 0): ManagedOutputEvidence => ({
    snapshot: { processId: "p", pid: 1, status: "running", exitCode: null, signal: null, startedAt: "", updatedAt: "", stdout: "", stderr: "" },
    source: "live", streams: [{ stream: "stdout", totalBytes: bytes.byteLength, tail: new Uint8Array(bytes.subarray(tailFrom)), lossyBytes, lossReasons: lossyBytes ? ["private_spill_unavailable"] : [] }],
  });
  let offset = 0, joined = "";
  while (offset < bytes.byteLength) {
    const slice = await sliceOutput({ evidence: evidence(0), stream: "stdout", startOffset: offset, maxBytes: 4 });
    assert.ok(!slice.text.includes("�"), `no replacement characters at ${offset}`);
    assert.ok(slice.endOffset > offset, "progress is guaranteed with maxBytes >= 4");
    joined += slice.text; offset = slice.endOffset;
  }
  assert.equal(joined, text);
  // The retained tail begins inside "€": the gap is explicit, and the slice resumes at a boundary.
  const gapped = await sliceOutput({ evidence: evidence(2, 2), stream: "stdout", startOffset: 0, maxBytes: 64 });
  assert.deepEqual(gapped.gap, { fromOffset: 0, toOffset: 4, reason: "evidence_lossy" });
  assert.equal(gapped.text, "b€c€d");
  await assert.rejects(sliceOutput({ evidence: evidence(0), stream: "stdout", startOffset: bytes.byteLength + 1, maxBytes: 8 }), /beyond/);
  assert.equal(utf8CompleteLength(Buffer.from([0x61, 0xe2, 0x82]), true), 1);
  assert.equal(utf8CompleteLength(Buffer.from([0x61, 0xe2, 0x82]), false), 3);
});

test("finalized spill serves earlier ranges exactly; without it the earlier range is a gap", async () => {
  const whole = Buffer.from("0123456789abcdef");
  const base = { snapshot: { processId: "p", pid: 1, status: "stopped" as const, exitCode: 0, signal: null, startedAt: "", updatedAt: "", stdout: "", stderr: "" }, source: "final" as const };
  const withSpill: ManagedOutputEvidence = { ...base, streams: [{ stream: "stdout", totalBytes: 16, tail: new Uint8Array(whole.subarray(12)), lossyBytes: 0, lossReasons: [], spill: { artifactId: "a".repeat(64), bytes: 16 } }] };
  const read = await sliceOutput({ evidence: withSpill, stream: "stdout", startOffset: 2, maxBytes: 5, readSpill: async () => new Uint8Array(whole) });
  assert.equal(read.text, "23456"); assert.equal(read.gap, undefined);
  const withoutSpill: ManagedOutputEvidence = { ...base, streams: [{ stream: "stdout", totalBytes: 16, tail: new Uint8Array(whole.subarray(12)), lossyBytes: 12, lossReasons: ["private_spill_unavailable"] }] };
  const lost = await sliceOutput({ evidence: withoutSpill, stream: "stdout", startOffset: 2, maxBytes: 5 });
  assert.deepEqual(lost.gap, { fromOffset: 2, toOffset: 12, reason: "evidence_lossy" }); assert.equal(lost.text, "cdef");
});

test("process tool schemas expose interactive start, write_stdin and read_output without approval flags", () => {
  const tools = createManagedProcessTools({} as ManagedProcessService);
  const names = tools.map(tool => tool.definition.name);
  assert.deepEqual(names, ["process.start", "process.poll", "process.write_stdin", "process.read_output", "process.list", "process.signal"]);
  const write = tools.find(tool => tool.definition.name === "process.write_stdin")!;
  assert.equal(write.validate({ processId: "p", writeId: "w", data: "x", userApproved: true }).ok, false);
  assert.equal(write.validate({ processId: "p", writeId: "w", closeInput: true }).ok, true);
  const read = tools.find(tool => tool.definition.name === "process.read_output")!;
  assert.equal(read.definition.readOnly, true);
  assert.equal(read.validate({ processId: "p", cursor: "c", waitMs: 100 }).ok, true);
});
