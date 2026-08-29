import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

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
  assert.throws(() => parseOutputCheckpointRecord({ ...record, streams: [{ stream: "stdout", accepted: [metadata, { ...metadata, sequence: 2, startOffset: 5, endOffset: 10 }], lastConsumed: null, consumingIntent: null }] }),
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

function checkpointRecord() {
  return { recordKind: "runner.output-checkpoint" as const, schemaVersion: 1 as const, revision: 0, sessionId: "stream-1", ownerId: "session-owner", fencingToken: 1, capacity: 1, outcome: "active" as const, streams: [{ stream: "stdout" as const, lastConsumed: null, accepted: [], consumingIntent: null }] };
}
