import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { BoundedProtocolQueue, ProtocolQueueError } from "../src/bounded-protocol-queue.js";
import { createProtocolEvidenceTee } from "../src/protocol-evidence-tee.js";
import { createStreamingOutputController, StreamingOutputError } from "../src/streaming-output-controller.js";

test("bounded protocol queue owns mutable bytes, preserves order, and releases blocked producers", async () => {
  const queue = new BoundedProtocolQueue({ maxBytes: 4, maxChunks: 2, maxFrameBytes: 4 });
  const first = Buffer.from("ab");
  await queue.push(first);
  first.fill(0);
  await queue.push(Buffer.from("cd"));
  let released = false;
  const pending = queue.push(Buffer.from("e")).then(() => { released = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, false);
  assert.equal((await queue.read())?.toString(), "ab");
  await pending;
  assert.deepEqual([(await queue.read())?.toString(), (await queue.read())?.toString()], ["cd", "e"]);
});

test("bounded queue cancellation rejects waiters and an oversized frame clears owned bytes", async () => {
  const queue = new BoundedProtocolQueue({ maxBytes: 8, maxChunks: 2, maxFrameBytes: 3 });
  await assert.rejects(queue.push(Buffer.from("four")), (error) => error instanceof ProtocolQueueError && error.code === "frame_too_large");
  const waiting = queue.read();
  queue.cancel("stopped");
  await assert.rejects(waiting, (error) => error instanceof ProtocolQueueError && error.code === "cancelled");
  assert.deepEqual(queue.snapshot(), { byteCount: 0, chunkCount: 0, producerWaiters: 0, consumerWaiters: 0, cancelled: true });
});

test("protocol/evidence tee preserves protocol bytes when the evidence spool fails", async () => {
  const queue = new BoundedProtocolQueue({ maxBytes: 32, maxChunks: 4, maxFrameBytes: 32 });
  const tee = createProtocolEvidenceTee({ queue, spool: { write: async () => { throw new Error("spill failed"); } } });
  const result = await tee.write("stdout", Buffer.from("protocol"), true);
  assert.equal((await queue.read())?.toString(), "protocol");
  assert.deepEqual(result, { evidenceLossy: true, reason: "evidence_write_failed" });
});

test("output controller checks exact sequence/offset/digest and acknowledges only after consumption", async () => {
  const delivered: string[] = [];
  const acknowledgements: unknown[] = [];
  const controller = createStreamingOutputController({
    maxAcceptedChunks: 2,
    authorize: () => true,
    deliver: async (_stream, bytes) => { delivered.push(Buffer.from(bytes).toString()); },
  });
  const bytes = Buffer.from("hello");
  const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 5, byteLength: 5, digest: createHash("sha256").update(bytes).digest("hex") };
  await controller.accept({ metadata, bytes, acknowledge: async (ack) => { acknowledgements.push(ack); } });
  assert.deepEqual(delivered, ["hello"]);
  assert.deepEqual(acknowledgements, [metadata]);
  await assert.rejects(controller.accept({ metadata: { ...metadata, sequence: 3, startOffset: 5, endOffset: 10 }, bytes, acknowledge: async () => undefined }), (error) => error instanceof StreamingOutputError && error.code === "sequence_mismatch");
});

test("output controller refuses family delivery when current authorization is revoked", async () => {
  const bytes = Buffer.from("x");
  const controller = createStreamingOutputController({ maxAcceptedChunks: 1, authorize: () => false, deliver: async () => assert.fail("must not deliver") });
  await assert.rejects(controller.accept({ metadata: { stream: "stdout", sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1, digest: createHash("sha256").update(bytes).digest("hex") }, bytes, acknowledge: async () => assert.fail("must not ack") }), (error) => error instanceof StreamingOutputError && error.code === "authorization_required");
  assert.equal(controller.snapshot().outcome, "outcome_unknown");
});
