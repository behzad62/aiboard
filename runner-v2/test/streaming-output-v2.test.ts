import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { BoundedProtocolQueue, ProtocolQueueError } from "../src/bounded-protocol-queue.js";
import { createProtocolEvidenceTee } from "../src/protocol-evidence-tee.js";
import { createStreamingOutputController, StreamingOutputError } from "../src/streaming-output-controller.js";
import { createInMemoryStreamingSessionStore, getStreamingSessionKernelWriter } from "../src/streaming-session-store.js";

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

test("an oversized frame terminally fails later readers and clears owned bytes", async () => {
  const queue = new BoundedProtocolQueue({ maxBytes: 8, maxChunks: 2, maxFrameBytes: 3 });
  await assert.rejects(queue.push(Buffer.from("four")), (error) => error instanceof ProtocolQueueError && error.code === "frame_too_large");
  const waiting = queue.read();
  await assert.rejects(waiting, (error) => error instanceof ProtocolQueueError && error.code === "frame_too_large");
  assert.deepEqual(queue.snapshot(), { byteCount: 0, chunkCount: 0, producerWaiters: 0, consumerWaiters: 0, cancelled: true });
});

test("oversized frame rejects and wipes queued and waiting owned buffers and settles consumers", async () => {
  const queue = new BoundedProtocolQueue({ maxBytes: 2, maxChunks: 1, maxFrameBytes: 2 });
  await queue.push(Buffer.from("aa"));
  const blocked = queue.push(Buffer.from("bb"));
  await assert.rejects(queue.push(Buffer.from("xxx")), (error) => error instanceof ProtocolQueueError && error.code === "frame_too_large");
  await assert.rejects(blocked, (error) => error instanceof ProtocolQueueError && error.code === "frame_too_large");
  await assert.rejects(queue.read(), (error) => error instanceof ProtocolQueueError && error.code === "frame_too_large");
  assert.deepEqual(queue.snapshot(), { byteCount: 0, chunkCount: 0, producerWaiters: 0, consumerWaiters: 0, cancelled: true });
});

test("explicit cancellation settles a waiting consumer", async () => {
  const queue = new BoundedProtocolQueue({ maxBytes: 2, maxChunks: 1, maxFrameBytes: 2 });
  const waiting = queue.read(); queue.cancel("stopped");
  await assert.rejects(waiting, (error) => error instanceof ProtocolQueueError && error.code === "cancelled");
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

test("output controller durably orders accepted, intent, consumed, then provider acknowledgement", async () => {
  const kernel = createInMemoryStreamingSessionStore();
  getStreamingSessionKernelWriter(kernel).claimOutputCheckpoint({ recordKind: "runner.output-checkpoint", schemaVersion: 1, revision: 0, sessionId: "stream-1", ownerId: "owner-1", fencingToken: 1, capacity: 2, outcome: "active", streams: [{ stream: "stdout", lastConsumed: null, accepted: [], consumingIntent: null }] });
  const observations: string[] = [];
  const bytes = Buffer.from("ok");
  const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 2, byteLength: 2, digest: createHash("sha256").update(bytes).digest("hex") };
  const controller = createStreamingOutputController({ kernel, sessionId: "stream-1", ownerId: "owner-1", fencingToken: 1, maxAcceptedChunks: 2, authorize: () => true, deliver: async () => { const record = kernel.store.readOutputCheckpoint("stream-1")!; observations.push(record.streams[0]!.consumingIntent ? "intent" : "missing"); } });
  await controller.accept({ metadata, bytes, acknowledge: async () => { observations.push(kernel.store.readOutputCheckpoint("stream-1")!.streams[0]!.lastConsumed ? "consumed" : "missing"); } });
  assert.deepEqual(observations, ["intent", "consumed"]);
});

test("recovery refuses missing retained accepted bytes and marks outcome unknown", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionKernelWriter(kernel);
  writer.claimOutputCheckpoint({ recordKind: "runner.output-checkpoint", schemaVersion: 1, revision: 0, sessionId: "stream-1", ownerId: "owner-1", fencingToken: 1, capacity: 2, outcome: "active", streams: [{ stream: "stdout", lastConsumed: null, accepted: [], consumingIntent: null }] });
  const bytes = Buffer.from("ok"); const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 2, byteLength: 2, digest: createHash("sha256").update(bytes).digest("hex") };
  writer.applyOutputCheckpoint({ type: "accept", sessionId: "stream-1", ownerId: "owner-1", fencingToken: 1, expectedRevision: 0, metadata, at: "2026-08-30T00:00:00.000Z" });
  const controller = createStreamingOutputController({ kernel, sessionId: "stream-1", ownerId: "owner-1", fencingToken: 1, maxAcceptedChunks: 2, authorize: () => true, deliver: async () => undefined });
  assert.throws(() => controller.attestRetainedWindow([]), (error) => error instanceof StreamingOutputError && error.code === "outcome_unknown");
  assert.equal(kernel.store.readOutputCheckpoint("stream-1")!.outcome, "outcome_unknown");
});

test("recovered exact consumed replay is suppressed and acknowledged without redelivery", async () => {
  const kernel = createInMemoryStreamingSessionStore(); const writer = getStreamingSessionKernelWriter(kernel);
  const bytes = Buffer.from("ok"); const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 2, byteLength: 2, digest: createHash("sha256").update(bytes).digest("hex") };
  writer.claimOutputCheckpoint({ recordKind: "runner.output-checkpoint", schemaVersion: 1, revision: 0, sessionId: "stream-1", ownerId: "owner-1", fencingToken: 1, capacity: 2, outcome: "active", streams: [{ stream: "stdout", lastConsumed: null, accepted: [], consumingIntent: null }] });
  writer.applyOutputCheckpoint({ type: "accept", sessionId: "stream-1", ownerId: "owner-1", fencingToken: 1, expectedRevision: 0, metadata });
  writer.applyOutputCheckpoint({ type: "begin_consume", sessionId: "stream-1", ownerId: "owner-1", fencingToken: 1, expectedRevision: 1, metadata });
  writer.applyOutputCheckpoint({ type: "commit_consumed", sessionId: "stream-1", ownerId: "owner-1", fencingToken: 1, expectedRevision: 2, metadata });
  let delivered = 0; let acknowledged = 0;
  const controller = createStreamingOutputController({ kernel, sessionId: "stream-1", ownerId: "owner-1", fencingToken: 1, maxAcceptedChunks: 2, authorize: () => true, deliver: async () => { delivered++; } });
  await controller.accept({ metadata, bytes, acknowledge: async () => { acknowledged++; } });
  assert.equal(delivered, 0); assert.equal(acknowledged, 1);
});

test("crash ambiguity before delivery and after consumed commit is durably outcome unknown", async () => {
  for (const point of ["delivery", "ack"] as const) {
    const kernel = createInMemoryStreamingSessionStore(); const writer = getStreamingSessionKernelWriter(kernel);
    writer.claimOutputCheckpoint({ recordKind: "runner.output-checkpoint", schemaVersion: 1, revision: 0, sessionId: `stream-${point}`, ownerId: "owner-1", fencingToken: 1, capacity: 2, outcome: "active", streams: [{ stream: "stdout", lastConsumed: null, accepted: [], consumingIntent: null }] });
    const bytes = Buffer.from("ok"); const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 2, byteLength: 2, digest: createHash("sha256").update(bytes).digest("hex") };
    const controller = createStreamingOutputController({ kernel, sessionId: `stream-${point}`, ownerId: "owner-1", fencingToken: 1, maxAcceptedChunks: 2, authorize: () => true, deliver: async () => { if (point === "delivery") throw new Error("crash"); } });
    await assert.rejects(controller.accept({ metadata, bytes, acknowledge: async () => { if (point === "ack") throw new Error("crash"); } }), /crash/);
    assert.equal(kernel.store.readOutputCheckpoint(`stream-${point}`)?.outcome, "outcome_unknown");
  }
});

test("evidence-only output commits and acknowledges without family authorization or delivery", async () => {
  const kernel = createInMemoryStreamingSessionStore(); const writer = getStreamingSessionKernelWriter(kernel);
  writer.claimOutputCheckpoint({ recordKind: "runner.output-checkpoint", schemaVersion: 1, revision: 0, sessionId: "stream-1", ownerId: "owner-1", fencingToken: 1, capacity: 2, outcome: "active", streams: [{ stream: "stderr", lastConsumed: null, accepted: [], consumingIntent: null }] });
  const bytes = Buffer.from("e"); const metadata = { stream: "stderr" as const, sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1, digest: createHash("sha256").update(bytes).digest("hex") }; let ack = 0;
  const controller = createStreamingOutputController({ kernel, sessionId: "stream-1", ownerId: "owner-1", fencingToken: 1, maxAcceptedChunks: 2, authorize: () => false, deliver: async () => assert.fail("no family delivery") });
  await controller.acceptEvidenceOnly({ metadata, bytes, acknowledge: async () => { ack++; } });
  assert.equal(ack, 1); assert.deepEqual(kernel.store.readOutputCheckpoint("stream-1")?.streams[0]?.lastConsumed, metadata);
});
