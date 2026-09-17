import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BoundedOutputSpool } from "../src/bounded-output-spool.js";
import { createLinkedTestOutputSpillStorage } from "./support/linked-output-spill-storage.js";

test("shared output observation is bounded, immutable and never seals a live spool", async t => {
  const root = await mkdtemp(join(tmpdir(), "p684-spool-observe-")); t.diagnostic(`exact observation fixture: ${root}`); let passed = false;
  const spool = new BoundedOutputSpool({ spillRoot: join(root, "spill"), projectRoot: process.cwd(), ownershipId: "managed-observation", tailBytes: 8, spillBytes: 64, storage: createLinkedTestOutputSpillStorage() });
  try {
    await spool.write("stdout", Buffer.from("first"));
    assert.equal(typeof (spool as unknown as { observe?: unknown }).observe, "function", "the shared spool must provide non-finalizing observation");
    const first = await (spool as unknown as { observe(): Promise<{ streams: readonly { stream: string; tail: string; tailBytesBase64: string; totalBytes: number }[] }> }).observe();
    assert.equal(first.streams[0]!.tail, "first"); assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.streams[0]));
    await spool.write("stdout", Buffer.from("-second"));
    const second = await (spool as unknown as { observe(): Promise<{ streams: readonly { tail: string; totalBytes: number }[] }> }).observe();
    assert.equal(second.streams[0]!.tail, "t-second"); assert.equal(second.streams[0]!.totalBytes, 12); assert.equal(first.streams[0]!.tail, "first");
    const final = await spool.finalize(); assert.equal(final.streams[0]!.totalBytes, 12); passed = true;
  } finally { await spool.cleanup(); if (passed) await rm(root, { recursive: true }); else t.diagnostic(`closed observation failure retained: ${root}`); }
});

test("shared output observation joins accepted writes without consuming or finalizing them", async t => {
  const root = await mkdtemp(join(tmpdir(), "p684-spool-observe-held-")); t.diagnostic(`exact held observation fixture: ${root}`); let passed = false;
  let release!: () => void, entered!: () => void; const held = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  const storage = createLinkedTestOutputSpillStorage();
  const spool = new BoundedOutputSpool({ spillRoot: join(root, "spill"), projectRoot: process.cwd(), ownershipId: "held-observation", tailBytes: 16, spillBytes: 64,
    storage: { ...storage, openExclusive: async path => { const file = await storage.openExclusive(path); return { ...file, write: async bytes => { entered(); await held; return await file.write(bytes); } }; } } });
  try {
    const writing = spool.write("stdout", Buffer.from("held")); await started;
    assert.equal(typeof (spool as unknown as { observe?: unknown }).observe, "function");
    let settled = false;
    const reading = (spool as unknown as { observe(): Promise<{ streams: readonly { totalBytes: number }[] }> }).observe().then(value => { settled = true; return value; });
    await Promise.resolve(); assert.equal(settled, false); release(); await writing;
    assert.equal((await reading).streams[0]!.totalBytes, 4); await spool.write("stdout", Buffer.from("-later")); await spool.finalize(); passed = true;
  } finally { release(); await spool.cleanup(); if (passed) await rm(root, { recursive: true }); else t.diagnostic(`closed held observation failure retained: ${root}`); }
});
