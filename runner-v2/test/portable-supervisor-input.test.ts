import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { settlePortableSupervisorCommand } from "../src/portable-process-protocol.mjs";

async function fixture() {
  const source = await readFile(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function handleChannelInput() {");
  const end = source.indexOf("\nfunction completeControl", start);
  assert.ok(start >= 0 && end > start);
  const files = new Map<string, string>(); const writes: Uint8Array[] = [];
  const acknowledgements: { sequence: number; status: string; fencingToken: number }[] = [];
  let callback: ((error?: Error | null) => void) | undefined;
  let fence = { ownerId: "owner", fencingToken: 1 }; let busy = false, throwWrite = false;
  const context = { Buffer, createHash, join, config: { nonce: "exact-nonce" }, channelInputDirectory: "input", handledInput: 0, pendingChannelInput: undefined,
    existsSync: (path: string) => files.has(path), readFileSync: (path: string) => files.get(path)!, unlinkSync: (path: string) => files.delete(path),
    child: { stdin: { destroyed: false, writable: true, write(bytes: Uint8Array, completion?: (error?: Error | null) => void) { writes.push(bytes); if (throwWrite) throw new Error("synchronous pipe failure"); callback = completion; return false; } } },
    settlePortableSupervisorCommand, readCurrentFence: () => fence,
    withCurrentFenceEffect: (ownerId: string, fencingToken: number, effect: () => unknown) => busy ? { status: "unavailable", cause: "coordination" } : ownerId !== fence.ownerId || fencingToken !== fence.fencingToken ? { status: "stale" } : { status: "applied", value: effect() },
    publishChannelInputAck: (command: { sequence: number; fencingToken: number }, status: string) => acknowledgements.push({ sequence: command.sequence, fencingToken: command.fencingToken, status }),
    step: () => undefined,
  };
  runInNewContext(source.slice(start, end) + "\nglobalThis.step = handleChannelInput;", context);
  return { writes, acknowledgements, step: () => context.step(), complete: (error?: Error) => { assert.ok(callback, "a concrete callback must own acknowledgement"); const owned = callback; callback = undefined; owned(error); },
    queue(sequence: number) { const bytes = Buffer.from("write-" + sequence); files.set(join("input", `input-${String(sequence).padStart(12, "0")}.json`), JSON.stringify({ nonce: "exact-nonce", ...fence, sequence, type: "write", byteLength: bytes.length, digest: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.toString("base64") })); },
    takeover: () => { fence = { ownerId: "new-owner", fencingToken: 2 }; }, busy: (value: boolean) => { busy = value; }, throwWrite: () => { throwWrite = true; } };
}

test("portable supervisor acknowledges only settled callbacks and never overlaps or replays a pending write", async () => {
  const f = await fixture(); f.queue(1); f.step();
  assert.equal(f.writes.length, 1); assert.deepEqual(f.acknowledgements, [], "buffer acceptance is not a pipe acknowledgement");
  f.queue(2); f.step(); f.step(); assert.equal(f.writes.length, 1);
  f.complete(); f.step(); assert.deepEqual(f.acknowledgements, [{ sequence: 1, fencingToken: 1, status: "acknowledged" }]);
  f.step(); assert.equal(f.writes.length, 2); f.complete(new Error("EPIPE")); f.step();
  assert.deepEqual(f.acknowledgements[1], { sequence: 2, fencingToken: 1, status: "failed" });
  f.step(); assert.equal(f.writes.length, 2);
});

test("portable supervisor refuses stale completed write acknowledgement without reissuing bytes", async () => {
  const f = await fixture(); f.queue(1); f.step(); f.takeover(); f.complete(); f.step();
  assert.deepEqual(f.acknowledgements, []); assert.equal(f.writes.length, 1);
  f.queue(2); f.step(); f.complete(); f.step();
  assert.deepEqual(f.acknowledgements, [{ sequence: 2, fencingToken: 2, status: "acknowledged" }]);
});

test("portable supervisor retains settled input through temporary coordination refusal", async () => {
  const f = await fixture(); f.queue(1); f.busy(true); f.step(); assert.equal(f.writes.length, 0);
  f.busy(false); f.step(); f.complete(); f.busy(true); f.step(); f.step(); assert.deepEqual(f.acknowledgements, []);
  f.busy(false); f.step(); f.step(); assert.equal(f.writes.length, 1); assert.equal(f.acknowledgements.length, 1);
});

test("portable supervisor settles a synchronous input exception as failed without replay", async () => {
  const f = await fixture(); f.throwWrite(); f.queue(1); assert.doesNotThrow(() => f.step()); f.step();
  assert.equal(f.writes.length, 1); assert.deepEqual(f.acknowledgements, [{ sequence: 1, fencingToken: 1, status: "failed" }]);
});

test("portable supervisor observes input stream errors without fabricating terminal ownership", async () => {
  const { EventEmitter } = await import("node:events");
  const source = await readFile(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const start = source.indexOf('installOutput("stdout", child.stdout, stdoutPath);');
  const end = source.indexOf('if (config.platform === "windows")', start);
  assert.ok(start >= 0 && end > start);
  const child = Object.assign(new EventEmitter(), { stdin: new EventEmitter(), stdout: new EventEmitter(), stderr: new EventEmitter() });
  let failures = 0, anchorExits = 0;
  runInNewContext(source.slice(start, end), { child, config: { platform: "posix" }, installOutput: () => undefined, installPosixOutputLifecycle: () => undefined,
    stdoutPath: "stdout", stderrPath: "stderr", markPosixPipeClosed: () => undefined,
    fail: () => { failures++; }, handlePosixAnchorExit: () => { anchorExits++; } });
  assert.doesNotThrow(() => child.stdin.emit("error", new Error("EPIPE")));
  assert.equal(failures, 0); assert.equal(anchorExits, 0);
});
