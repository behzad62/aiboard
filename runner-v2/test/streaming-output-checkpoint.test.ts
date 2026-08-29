import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BoundedProtocolQueue } from "../src/bounded-protocol-queue.js";
import { createStreamingOutputController } from "../src/streaming-output-controller.js";
import type { OperationAuthorizationAssertion, SessionOperationAuthorization } from "../src/session-authority.js";

import {
  StreamingSessionStoreError,
  createInMemoryStreamingSessionStore,
  getStreamingSessionKernelWriter,
  openSqliteStreamingSessionStore,
  parseOutputCheckpointRecord,
} from "../src/streaming-session-store.js";

const now = "2026-08-30T00:00:00.000Z";
const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 5, byteLength: 5, digest: "a".repeat(64) };

test("checkpoint parser rejects payloads and bounds accepted metadata", () => {
  const record = checkpointRecord();
  assert.equal(parseOutputCheckpointRecord(record).schemaVersion, 1);
  assert.throws(() => parseOutputCheckpointRecord({ ...record, payload: "secret" }),
    (error) => error instanceof StreamingSessionStoreError && error.code === "forbidden_durable_value");
  assert.throws(() => parseOutputCheckpointRecord({ ...record, streams: [{ stream: "stdout", accepted: [metadata, { ...metadata, sequence: 2, startOffset: 5, endOffset: 10 }], lastConsumed: null, consumed: [], consumingIntent: null }] }),
    (error) => error instanceof StreamingSessionStoreError && error.code === "capacity_exceeded");
});

test("checkpoint commits accepted then one intent then consumed and exact replay is suppressible", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionKernelWriter(kernel);
  writer.claimOutputCheckpoint(checkpointRecord());
  let record = writer.applyOutputCheckpoint({ type: "accept", sessionId: "stream-1", ownerId: "session-owner", fencingToken: 1, expectedRevision: 0, metadata, at: now });
  assert.equal(record.streams[0]!.accepted.length, 1);
  record = writer.applyOutputCheckpoint({ type: "begin_consume", sessionId: "stream-1", ownerId: "session-owner", fencingToken: 1, expectedRevision: 1, metadata, at: now });
  assert.deepEqual(record.streams[0]!.consumingIntent, metadata);
  assert.throws(() => writer.applyOutputCheckpoint({ type: "begin_consume", sessionId: "stream-1", ownerId: "session-owner", fencingToken: 1, expectedRevision: 2, metadata: { ...metadata, sequence: 2 }, at: now }), (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_effect");
  record = writer.applyOutputCheckpoint({ type: "commit_consumed", sessionId: "stream-1", ownerId: "session-owner", fencingToken: 1, expectedRevision: 2, metadata, at: now });
  assert.deepEqual(record.streams[0]!.lastConsumed, metadata);
  assert.equal(record.streams[0]!.accepted.length, 0);
  assert.equal(record.streams[0]!.consumingIntent, null);
  const replay = writer.applyOutputCheckpoint({ type: "accept", sessionId: "stream-1", ownerId: "session-owner", fencingToken: 1, expectedRevision: 3, metadata, at: now });
  assert.equal(replay.revision, 3);
});

test("output checkpoint is terminal fail-closed after outcome_unknown", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionKernelWriter(kernel);
  writer.claimOutputCheckpoint(checkpointRecord());
  writer.applyOutputCheckpoint({ type: "mark_outcome_unknown", sessionId: "stream-1", ownerId: "session-owner", fencingToken: 1, expectedRevision: 0, metadata, at: now });
  assert.throws(
    () => writer.applyOutputCheckpoint({ type: "accept", sessionId: "stream-1", ownerId: "session-owner", fencingToken: 1, expectedRevision: 1, metadata, at: now }),
    (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_state",
  );
});

test("accepted output capacity is aggregate across stdout and stderr", () => {
  const kernel = createInMemoryStreamingSessionStore(); const writer = getStreamingSessionKernelWriter(kernel);
  writer.claimOutputCheckpoint({ ...checkpointRecord(), streams: [{ stream: "stdout", lastConsumed: null, consumed: [], accepted: [], consumingIntent: null }, { stream: "stderr", lastConsumed: null, consumed: [], accepted: [], consumingIntent: null }] });
  writer.applyOutputCheckpoint({ type: "accept", sessionId: "stream-1", ownerId: "session-owner", fencingToken: 1, expectedRevision: 0, metadata, at: now });
  const stderr = { ...metadata, stream: "stderr" as const };
  assert.throws(() => writer.applyOutputCheckpoint({ type: "accept", sessionId: "stream-1", ownerId: "session-owner", fencingToken: 1, expectedRevision: 1, metadata: stderr, at: now }),
    (error) => error instanceof StreamingSessionStoreError && error.code === "capacity_exceeded");
});

test("checkpoint record capacity refuses eviction of existing metadata", () => {
  const kernel = createInMemoryStreamingSessionStore({ maxOutputCheckpointRecords: 1 }); const writer = getStreamingSessionKernelWriter(kernel);
  writer.claimOutputCheckpoint(checkpointRecord());
  assert.throws(() => writer.claimOutputCheckpoint({ ...checkpointRecord(), sessionId: "stream-2" }), (error) => error instanceof StreamingSessionStoreError && error.code === "capacity_exceeded");
  assert.equal(kernel.store.readOutputCheckpoint("stream-1")?.sessionId, "stream-1");
});

test("SQLite checkpoint HMAC survives reopen and tampering fails closed without mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-output-checkpoint-"));
  const path = join(root, "sessions.sqlite");
  const key = Buffer.alloc(32, 7);
  try {
    let kernel = openSqliteStreamingSessionStore(path, key);
    getStreamingSessionKernelWriter(kernel).claimOutputCheckpoint(checkpointRecord());
    kernel.store.close();
    kernel = openSqliteStreamingSessionStore(path, key);
    assert.equal(kernel.store.readOutputCheckpoint("stream-1")?.sessionId, "stream-1");
    kernel.store.close();
    kernel = openSqliteStreamingSessionStore(path, key, { readOnly: true });
    assert.throws(() => getStreamingSessionKernelWriter(kernel).claimOutputCheckpoint({ ...checkpointRecord(), sessionId: "stream-2" }), /read-only/i);
    kernel.store.close();
    const db = new DatabaseSync(path);
    const row = db.prepare("SELECT record_json FROM streaming_output_checkpoints WHERE session_id = ?").get("stream-1") as { record_json: string };
    db.prepare("UPDATE streaming_output_checkpoints SET integrity = ? WHERE session_id = ?").run(createHmac("sha256", Buffer.alloc(32, 8)).update(row.record_json).digest("hex"), "stream-1");
    db.close();
    kernel = openSqliteStreamingSessionStore(path, key);
    assert.throws(() => kernel.store.readOutputCheckpoint("stream-1"), (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_record");
    kernel.store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SQLite crash matrix preserves accepted intent consumed and acknowledgement boundaries", async () => {
  for (const boundary of ["before_accept", "after_accept", "after_queue", "after_intent", "before_delivery", "after_delivery", "after_consumed", "after_ack"] as const) {
    const root = await mkdtemp(join(tmpdir(), "runner-v2-output-crash-")); const path = join(root, "sessions.sqlite"); const key = Buffer.alloc(32, 2);
    let kernel = openSqliteStreamingSessionStore(path, key); let closed = false;
    try {
      const bytes = Buffer.from("chunk"); const exact = { ...metadata, digest: createHash("sha256").update(bytes).digest("hex") }; let writer = getStreamingSessionKernelWriter(kernel);
      let record = writer.claimOutputCheckpoint(checkpointRecord()).record;
      const command = (type: string) => record = writer.applyOutputCheckpoint({ type, sessionId: "stream-1", ownerId: "session-owner", fencingToken: 1, expectedRevision: record.revision, metadata: exact });
      if (boundary !== "before_accept") command("accept");
      if (["after_intent", "before_delivery", "after_delivery", "after_consumed", "after_ack"].includes(boundary)) command("begin_consume");
      if (["after_consumed", "after_ack"].includes(boundary)) command("commit_consumed");
      kernel.store.close(); closed = true; kernel = openSqliteStreamingSessionStore(path, key); closed = false; writer = getStreamingSessionKernelWriter(kernel);
      assert.deepEqual(kernel.store.readOutputCheckpoint("stream-1"), record, boundary);
      const queue = new BoundedProtocolQueue({ maxBytes: 5, maxChunks: 1, maxFrameBytes: 5 }); let deliveries = 0;
      const controller = createStreamingOutputController({ kernel, sessionId: "stream-1", ownerId: "session-owner", fencingToken: 1, maxAcceptedChunks: 1, queue, protocolStreams: ["stdout"], writeEvidence: async () => ({ evidenceLossy: false }), assertAuthorization: () => undefined, deliver: async () => { deliveries++; } });
      if (["after_intent", "before_delivery", "after_delivery"].includes(boundary)) {
        assert.throws(() => controller.attestRetainedWindow([exact]), /unknown/); assert.equal(kernel.store.readOutputCheckpoint("stream-1")!.outcome, "outcome_unknown");
      } else {
        controller.attestRetainedWindow(record.streams[0]!.accepted);
        if (["after_consumed", "after_ack"].includes(boundary)) { assert.deepEqual(await controller.accept(exact, bytes), exact); assert.equal(deliveries, 0); }
        else if (boundary !== "before_accept") {
          const acknowledgement = controller.accept(exact, bytes); await new Promise((resolve) => setImmediate(resolve));
          await controller.deliverNext({} as SessionOperationAuthorization, { sessionId: "stream-1", operation: "family_delivery" } as OperationAuthorizationAssertion);
          assert.deepEqual(await acknowledgement, exact); assert.equal(deliveries, 1);
        }
      }
      controller.cancel(); assert.equal(queue.snapshot().byteCount, 0);
    } finally { if (!closed) kernel.store.close(); await rm(root, { recursive: true, force: true }); }
  }
});

function checkpointRecord() {
  return { recordKind: "runner.output-checkpoint" as const, schemaVersion: 1 as const, revision: 0, sessionId: "stream-1", ownerId: "session-owner", fencingToken: 1, capacity: 1, outcome: "active" as const, streams: [{ stream: "stdout" as const, lastConsumed: null, consumed: [], accepted: [], consumingIntent: null }] };
}
