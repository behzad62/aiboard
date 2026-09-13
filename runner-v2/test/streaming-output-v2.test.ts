import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BoundedProtocolQueue, ProtocolQueueError } from "../src/bounded-protocol-queue.js";
import { createProtocolEvidenceTee } from "../src/protocol-evidence-tee.js";
import { BoundedOutputSpool, createNodeOutputSpillStorage } from "../src/bounded-output-spool.js";
import type { OperationAuthorizationAssertion, SessionOperationAuthorization } from "../src/session-authority.js";
import { createStreamingOutputController, StreamingOutputError, type StreamingOutputMetadata } from "../src/streaming-output-controller.js";
import { createInMemoryStreamingSessionStore, getStreamingSessionKernelWriter } from "../src/streaming-session-store.js";

const binding = { runId: "run-1", sessionId: "agent-1", actor: { role: "worker" as const, id: "worker-1" }, toolName: "process.start", callId: "call-1", permissionProfile: "full" as const };
const assertion: OperationAuthorizationAssertion = { sessionId: "stream-1", operation: "family_delivery", binding, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
const authorization = Object.freeze({}) as SessionOperationAuthorization;

test("bounded protocol queue owns mutable bytes, preserves order, and releases blocked producers", async () => {
  const queue = new BoundedProtocolQueue({ maxBytes: 4, maxChunks: 2, maxFrameBytes: 4 });
  const first = Buffer.from("ab"); await queue.push(first); first.fill(0);
  const blocked = queue.push(Buffer.from("cde")); let released = false; void blocked.then(() => { released = true; });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(released, false);
  assert.equal((await queue.read())?.toString(), "ab"); await blocked; assert.equal((await queue.read())?.toString(), "cde");
});

test("queue oversize and cancellation reject and wipe every owned waiter", async () => {
  const queue = new BoundedProtocolQueue({ maxBytes: 2, maxChunks: 1, maxFrameBytes: 2 });
  await queue.push(Buffer.from("aa")); const waiting = queue.push(Buffer.from("bb"));
  await assert.rejects(queue.push(Buffer.from("large")), (error) => error instanceof ProtocolQueueError && error.code === "frame_too_large");
  await assert.rejects(waiting, (error) => error instanceof ProtocolQueueError && error.code === "frame_too_large");
  assert.deepEqual(queue.snapshot(), { byteCount: 0, chunkCount: 0, producerWaiters: 0, consumerWaiters: 0, cancelled: true });
});

test("protocol/evidence tee preserves protocol bytes and reports truthful evidence loss", async () => {
  const queue = new BoundedProtocolQueue({ maxBytes: 32, maxChunks: 4, maxFrameBytes: 32 });
  const tee = createProtocolEvidenceTee({ queue, spool: { write: async () => { throw new Error("spill failed"); }, finalize: async () => ({ streams: [] }) } });
  const result = await tee.write("stdout", Buffer.from("protocol"), true);
  assert.equal((await queue.read())?.toString(), "protocol"); assert.deepEqual(result, { evidenceLossy: true, reason: "evidence_write_failed" });
  assert.equal((await tee.finalize()).evidenceLossy, true);
});

test("tee retains truthful loss reported by the real bounded spool at finalize", async () => {
  const queue = new BoundedProtocolQueue({ maxBytes: 32, maxChunks: 4, maxFrameBytes: 32 });
  const spool = new BoundedOutputSpool({ spillRoot: join(tmpdir(), `runner-v2-tee-${randomUUID()}`), projectRoot: process.cwd(), ownershipId: "tee-test-owner", tailBytes: 1, spillBytes: 8, storage: { ...createNodeOutputSpillStorage(), attest: async () => ({ currentPrincipalPrivacy: false, identityStableDeletion: false, unlinkedEntries: false }) } });
  const tee = createProtocolEvidenceTee({ queue, spool }); const bytes = Buffer.from("protocol bytes");
  await tee.write("stdout", bytes, true); assert.deepEqual(await queue.read(), bytes);
  const evidence = await tee.finalize(); assert.equal(evidence.evidenceLossy, true);
});

test("durable accepted precedes queue insertion and exact authorization gates delivery", async () => {
  const observations: string[] = []; const fixture = outputFixture(async () => { observations.push(fixture.kernel.store.readOutputCheckpoint("stream-1")!.streams[0]!.consumingIntent ? "intent" : "missing"); });
  const push = fixture.queue.push.bind(fixture.queue);
  fixture.queue.push = async (bytes) => { assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1")!.streams[0]!.accepted.length, 1, "accepted metadata must commit before queue insertion"); await push(bytes); };
  const bytes = Buffer.from("hello"); const metadata = meta(bytes);
  const acknowledgement = fixture.controller.accept(metadata, bytes);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1")!.streams[0]!.accepted.length, 1);
  await assert.rejects(fixture.controller.deliverNext({} as SessionOperationAuthorization, assertion), (error) => error instanceof StreamingOutputError && error.code === "authorization_required");
  assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1")!.outcome, "active");
  assert.equal(await fixture.controller.deliverNext(authorization, assertion), true);
  assert.deepEqual(await acknowledgement, metadata); assert.deepEqual(observations, ["intent"]);
  assert.deepEqual(fixture.kernel.store.readOutputCheckpoint("stream-1")!.streams[0]!.consumed, [metadata]);
});

test("continuity, digest, offset, and cross-stream metadata fail closed before acceptance", async () => {
  const bytes = Buffer.from("x");
  for (const [metadata, payload, code] of [
    [{ ...meta(bytes), digest: "f".repeat(64) }, bytes, "digest_mismatch"],
    [{ ...meta(bytes), sequence: 2 }, bytes, "sequence_mismatch"],
    [{ ...meta(bytes), startOffset: 1, endOffset: 2 }, bytes, "offset_mismatch"],
    [{ ...meta(bytes), byteLength: 0, endOffset: 0 }, Buffer.alloc(0), "invalid_chunk"],
    [{ ...meta(bytes), stream: "invalid" }, bytes, "invalid_chunk"],
  ] as const) {
    const fixture = outputFixture(async () => undefined);
    await assert.rejects(fixture.controller.accept(metadata as StreamingOutputMetadata, payload), (error) => error instanceof StreamingOutputError && error.code === code);
    assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1")!.outcome, "outcome_unknown");
  }
});

test("duplicate accepted replay shares one queue entry and one family effect", async () => {
  let deliveries = 0; const fixture = outputFixture(async () => { deliveries++; }); const bytes = Buffer.from("x"); const metadata = meta(bytes);
  const first = fixture.controller.accept(metadata, bytes); const replay = fixture.controller.accept(metadata, bytes);
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(fixture.controller.snapshot().pending, 1);
  await fixture.controller.deliverNext(authorization, assertion);
  assert.deepEqual(await first, metadata); assert.deepEqual(await replay, metadata); assert.equal(deliveries, 1);
});

test("exact consumed replay is suppressed while older unauthenticated replay is refused", async () => {
  const fixture = outputFixture(async () => undefined); const bytes = Buffer.from("x"); const metadata = meta(bytes);
  const pending = fixture.controller.accept(metadata, bytes); await new Promise((resolve) => setImmediate(resolve)); await fixture.controller.deliverNext(authorization, assertion); await pending;
  assert.deepEqual(await fixture.controller.accept(metadata, bytes), metadata);
  await assert.rejects(fixture.controller.accept({ ...metadata, digest: "f".repeat(64) }, bytes), /digest/i);
});

test("delivery ambiguity is terminal and rejects all later intake", async () => {
  const fixture = outputFixture(async () => { throw new Error("family crash"); }); const bytes = Buffer.from("x"); const metadata = meta(bytes);
  const pending = fixture.controller.accept(metadata, bytes); pending.catch(() => undefined); await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(fixture.controller.deliverNext(authorization, assertion), /unknown/i);
  assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1")!.outcome, "outcome_unknown");
  await assert.rejects(fixture.controller.accept({ ...metadata, sequence: 2, startOffset: 1, endOffset: 2 }, bytes), (error) => error instanceof StreamingOutputError && error.code === "outcome_unknown");
});

test("evidence-only stream commits and acknowledges without family delivery", async () => {
  const fixture = outputFixture(async () => assert.fail("must not deliver"), async () => {
    assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1")!.streams[1]!.accepted.length, 0, "evidence metadata commits only after spool acceptance/loss");
    return { evidenceLossy: true };
  }); const bytes = Buffer.from("e"); const metadata = meta(bytes, "stderr");
  assert.deepEqual(await fixture.controller.accept(metadata, bytes), metadata);
  assert.deepEqual(fixture.kernel.store.readOutputCheckpoint("stream-1")!.streams[1]!.lastConsumed, metadata);
});

test("retained-window attestation is exact and consuming intent is ambiguous", async () => {
  const fixture = outputFixture(async () => undefined); const bytes = Buffer.from("x"); const metadata = meta(bytes);
  const pending = fixture.controller.accept(metadata, bytes); pending.catch(() => undefined); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.controller.attestRetainedWindow([metadata]), true);
  assert.throws(() => fixture.controller.attestRetainedWindow([]), (error) => error instanceof StreamingOutputError && error.code === "outcome_unknown");
});

test("stale checkpoint failure wipes private pending bytes without mutating the new owner", async () => {
  const fixture = outputFixture(async () => assert.fail("no delivery")); const bytes = Buffer.from("x"); const metadata = meta(bytes);
  const pending = fixture.controller.accept(metadata, bytes); pending.catch(() => undefined); await new Promise((resolve) => setImmediate(resolve));
  const writer = getStreamingSessionKernelWriter(fixture.kernel); const old = fixture.kernel.store.readOutputCheckpoint("stream-1")!;
  writer.deleteOutputCheckpoint({ sessionId: "stream-1", ownerId: old.ownerId, fencingToken: old.fencingToken, expectedRevision: old.revision });
  writer.claimOutputCheckpoint({ ...old, revision: 0, ownerId: "replacement-owner", fencingToken: 2 });
  await assert.rejects(fixture.controller.accept({ ...metadata, digest: "f".repeat(64) }, bytes));
  assert.equal(fixture.controller.snapshot().pending, 0);
  assert.equal(fixture.controller.snapshot().outcome, "outcome_unknown");
  assert.equal(fixture.queue.snapshot().byteCount, 0);
  assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1")!.ownerId, "replacement-owner");
  assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1")!.outcome, "active");
  await assert.rejects(pending);
});

test("persistent unauthorized protocol output stays bounded while evidence-only output drains", async () => {
  let evidenceWrites = 0; const fixture = outputFixture(async () => assert.fail("unauthorized delivery"), async () => { evidenceWrites++; return { evidenceLossy: true }; });
  const protocol: Promise<StreamingOutputMetadata>[] = [];
  for (let index = 0; index < 4; index++) {
    const bytes = Buffer.from("part"); const metadata = { ...meta(bytes), sequence: index + 1, startOffset: index * 4, endOffset: (index + 1) * 4 };
    const pending = fixture.controller.accept(metadata, bytes); pending.catch(() => undefined); protocol.push(pending);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.queue.snapshot().byteCount, 16); assert.equal(fixture.controller.snapshot().pending, 4);
  for (let index = 0; index < 8; index++) {
    const bytes = Buffer.from("e"); const metadata = { ...meta(bytes, "stderr"), sequence: index + 1, startOffset: index, endOffset: index + 1 };
    assert.deepEqual(await fixture.controller.accept(metadata, bytes), metadata);
  }
  assert.equal(evidenceWrites, 12); assert.equal(fixture.queue.snapshot().byteCount, 16);
  assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1")!.streams[1]!.consumed.length, 4);
  fixture.controller.cancel(); for (const pending of protocol) await assert.rejects(pending);
  assert.equal(fixture.queue.snapshot().byteCount, 0);
});

function outputFixture(deliver: (stream: "stdout" | "stderr", bytes: Uint8Array) => Promise<void>, writeEvidence = async () => ({ evidenceLossy: false })) {
  const kernel = createInMemoryStreamingSessionStore();
  getStreamingSessionKernelWriter(kernel).claimOutputCheckpoint({ recordKind: "runner.output-checkpoint", schemaVersion: 1, revision: 0, sessionId: "stream-1", ownerId: "owner-1", fencingToken: 1, capacity: 4, outcome: "active", streams: [{ stream: "stdout", lastConsumed: null, consumed: [], accepted: [], consumingIntent: null }, { stream: "stderr", lastConsumed: null, consumed: [], accepted: [], consumingIntent: null }] });
  const queue = new BoundedProtocolQueue({ maxBytes: 16, maxChunks: 4, maxFrameBytes: 16 });
  const controller = createStreamingOutputController({ maxAcceptedChunks: 4, kernel, sessionId: "stream-1", ownerId: "owner-1", fencingToken: 1, queue, protocolStreams: ["stdout"], writeEvidence, assertAuthorization: (actual) => { if (actual !== authorization) throw new Error("forged"); }, deliver });
  return { kernel, controller, queue };
}

function meta(bytes: Uint8Array, stream: "stdout" | "stderr" = "stdout"): StreamingOutputMetadata { return { stream, sequence: 1, startOffset: 0, endOffset: bytes.byteLength, byteLength: bytes.byteLength, digest: createHash("sha256").update(bytes).digest("hex") }; }


test("private cleanup delivery refuses stale authority before effect without poisoning replay", async () => {
  let effects = 0; let current = true;
  const f = outputFixture(async () => undefined);
  const payload = Buffer.from("late"); const metadata = meta(payload);
  const pending = f.controller.accept(metadata, payload);
  void pending.catch(() => undefined);
  const read = f.queue.read.bind(f.queue);
  f.queue.read = async () => { const bytes = await read(); current = false; return bytes; };
  const assertCurrent = () => { if (!current) throw new Error("exact cleanup authority expired before effect"); };
  const deliver = async () => { effects++; };
  try {
    assert.equal(await f.controller.waitForPending(), true);
    await assert.rejects(f.controller.deliverNextPrivately(deliver, assertCurrent),
      (error: unknown) => error instanceof StreamingOutputError && error.code === "authorization_required");
    assert.equal(effects, 0, "a refused pre-effect delivery never calls the parser");
    const checkpoint = f.kernel.store.readOutputCheckpoint("stream-1")!;
    assert.equal(checkpoint.outcome, "active");
    assert.equal(checkpoint.streams[0]!.consumingIntent, null);
    assert.deepEqual(checkpoint.streams[0]!.accepted, [metadata]);
    current = true;
    assert.equal(await f.controller.deliverNextPrivately(deliver, assertCurrent), true);
    assert.deepEqual(await pending, metadata);
    assert.equal(effects, 1, "the exactly retained bytes are delivered once after fresh authority");
  } finally { f.controller.cancel(); await pending.catch(() => undefined); f.kernel.store.close(); }
});
