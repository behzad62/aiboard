import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/artifact-store.js";
import { BoundedOutputSpool, createNodeOutputSpillStorage } from "../src/bounded-output-spool.js";
import { verifyFinalizedEvidence, createEvidenceContinuation, EVIDENCE_MAX_BYTES, EVIDENCE_MAX_PAGES, initialEvidenceContinuation, parseEvidenceContinuation } from "../src/evidence-continuation.js";
import { getStreamingSessionKernelWriter, openSqliteStreamingSessionStore, parseOutputCheckpointRecord } from "../src/streaming-session-store.js";
import { createStreamingOutputController, type StreamingOutputMetadata } from "../src/streaming-output-controller.js";
import { BoundedProtocolQueue } from "../src/bounded-protocol-queue.js";

function chunk(bytes: Buffer, sequence = 1, offset = 0, stream: "stdout" | "stderr" = "stdout"): StreamingOutputMetadata {
  return { stream, sequence, startOffset: offset, endOffset: offset + bytes.length, byteLength: bytes.length,
    digest: createHash("sha256").update(bytes).digest("hex") };
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "c3-store-"));
  t.diagnostic(`created exact fixture root: ${root}`);
  const path = join(root, "sessions.sqlite"); const key = Buffer.alloc(32, 9);
  let kernel = openSqliteStreamingSessionStore(path, key);
  getStreamingSessionKernelWriter(kernel).claimOutputCheckpoint({ recordKind: "runner.output-checkpoint", schemaVersion: 1,
    sessionId: "session", ownerId: "owner", fencingToken: 1, revision: 0, capacity: 4, outcome: "active",
    streams: ["stdout", "stderr"].map((stream) => ({ stream, accepted: [], consumed: [], lastConsumed: null, consumingIntent: null })) });
  const spools: BoundedOutputSpool[] = [];
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const open = (store = artifacts) => {
    const spool = new BoundedOutputSpool({ spillRoot: join(root, `spool-${spools.length}`), ownershipId: "fixture",
      projectRoot: process.cwd(), tailBytes: 1024, spillBytes: 1024, artifactStore: store,
      storage: { ...createNodeOutputSpillStorage(), attest: async () => ({ currentPrincipalPrivacy: true, identityStableDeletion: true, unlinkedEntries: false }),
        removeIdentityStable: async (path, identity) => { const stat = await lstat(path); assert.equal(`${stat.dev}:${stat.ino}`, identity); await unlink(path); } } });
    spools.push(spool);
    return createEvidenceContinuation({ kernel, sessionId: "session", ownerId: "owner", fencingToken: 1, artifacts: store, spool });
  };
  t.after(async () => { for (const spool of spools) await spool.cleanup(); kernel.store.close(); await rm(root, { recursive: true, force: true }); t.diagnostic(`removed exact fixture root: ${root}`); });
  return { root, artifacts, spools, open, get kernel() { return kernel; }, reopen() { kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key); },
    checkpoint: () => kernel.store.readOutputCheckpoint("session")!, state: () => kernel.store.readOutputCheckpoint("session")!.continuation! };
}

test("C3 accepted replay after reopening neither duplicates evidence nor loses new stream ordering", async (t) => {
  const f = await fixture(t); const first = f.open(); const a = Buffer.from("a");
  await first.writeChunk(chunk(a), a);
  f.reopen(); const fresh = f.open();
  await fresh.writeChunk(chunk(a), a);
  const b = Buffer.from("b"); await fresh.writeChunk(chunk(b, 1, 0, "stderr"), b);
  const c = Buffer.from("c"); await fresh.writeChunk(chunk(c, 2, 1), c);
  assert.equal(f.state().pages, 3);
  const result = await fresh.finalize();
  assert.deepEqual(result.streams.map((s) => [s.stream, Buffer.from(s.tailBytesBase64, "base64").toString(), s.totalBytes]), [["stdout", "ac", 2], ["stderr", "b", 1]]);
  const finalized = f.state().finalized;
  f.reopen(); assert.deepEqual(await f.open().finalize(), result); assert.deepEqual(f.state().finalized, finalized);
});

for (const fault of ["future", "extra", "identity", "count", "lost", "position"] as const) {
  test(`C3 checkpoint rejects malformed continuation ${fault}`, () => {
    const state = initialEvidenceContinuation();
    const broken = { ...state, ...(fault === "future" ? { version: 9 } : fault === "extra" ? { rawOutput: "x" } :
      fault === "identity" ? { evidenceId: "wrong" } : fault === "count" ? { pages: 4097, head: "a".repeat(64) } :
      fault === "lost" ? { loss: "storage" } : { positions: [...state.positions].reverse() }) };
    assert.throws(() => parseEvidenceContinuation(broken));
  });
}

test("C3 HMAC checkpoint roundtrip retains v2 and rejects unsupported and foreign ownership", async (t) => {
  const f = await fixture(t); f.open(); const before = f.checkpoint();
  f.reopen(); assert.deepEqual(f.checkpoint(), before);
  assert.throws(() => parseOutputCheckpointRecord({ ...before, schemaVersion: 3 }));
  for (const [ownerId, fencingToken, expectedRevision] of [["foreign", 1, before.revision], ["owner", 2, before.revision], ["owner", 1, before.revision - 1]] as const) {
    assert.throws(() => getStreamingSessionKernelWriter(f.kernel).applyOutputCheckpoint({ type: "commit_continuation", sessionId: "session", ownerId, fencingToken, expectedRevision, continuation: before.continuation }));
    assert.deepEqual(f.checkpoint(), before);
  }
});

for (const authority of ["owner", "fence", "outcome"] as const) test(`C3 repair1 continuation entry refuses ${authority} before effects`, async (t) => {
  const f = await fixture(t); f.open();
  if (authority === "outcome") getStreamingSessionKernelWriter(f.kernel).applyOutputCheckpoint({ type: "mark_outcome_unknown", sessionId: "session", ownerId: "owner",
    fencingToken: 1, expectedRevision: f.checkpoint().revision, metadata: chunk(Buffer.from("a")) });
  const before = f.checkpoint();
  assert.throws(() => createEvidenceContinuation({ kernel: f.kernel, sessionId: "session", ownerId: authority === "owner" ? "foreign" : "owner",
    fencingToken: authority === "fence" ? 2 : 1, artifacts: f.artifacts, spool: f.spools[0]! }));
  assert.deepEqual(f.checkpoint(), before);
});

test("C3 repair1 finalized authority cannot be rewritten even with an exact current revision", async (t) => {
  const f = await fixture(t); await f.open().finalize(); const before = f.checkpoint();
  assert.throws(() => getStreamingSessionKernelWriter(f.kernel).applyOutputCheckpoint({ type: "commit_continuation", sessionId: "session", ownerId: "owner", fencingToken: 1,
    expectedRevision: before.revision, continuation: before.continuation })); assert.deepEqual(f.checkpoint(), before);
});

test("C3 repair1 final manifest must bind the exact authenticated evidence identity", async (t) => {
  const f = await fixture(t); f.open(); const state = f.state();
  const result = await f.artifacts.put(Buffer.from(JSON.stringify({ streams: [] })), "application/json");
  const manifest = await f.artifacts.put(Buffer.from(JSON.stringify({ version: 1, evidenceId: "00000000-0000-0000-0000-000000000000", previousHash: null,
    resultHash: result.hash, legacyHead: null, summary: { loss: state.loss, positions: state.positions, retainedBytes: 0, pages: 0 } })), "application/json");
  getStreamingSessionKernelWriter(f.kernel).applyOutputCheckpoint({ type: "commit_continuation", sessionId: "session", ownerId: "owner", fencingToken: 1,
    expectedRevision: f.checkpoint().revision, continuation: { ...state, finalized: { manifestHash: manifest.hash, resultHash: result.hash, legacyHead: null, lossy: false } } });
  f.reopen(); await assert.rejects(f.open().finalize());
});

test("C3 repair1 committed chain cannot omit an earlier authenticated segment", async (t) => {
  const f = await fixture(t); const first = f.open(); const a = Buffer.from("a"); const b = Buffer.from("b");
  await first.writeChunk(chunk(a), a); const state = f.state(); const metadata = chunk(b, 2, 1);
  const segment = await f.artifacts.put(b, "application/octet-stream");
  const page = await f.artifacts.put(Buffer.from(JSON.stringify({ version: 1, evidenceId: state.evidenceId, previousHash: null, segmentHash: segment.hash, metadata })), "application/json");
  getStreamingSessionKernelWriter(f.kernel).applyOutputCheckpoint({ type: "commit_continuation", sessionId: "session", ownerId: "owner", fencingToken: 1,
    expectedRevision: f.checkpoint().revision, continuation: { ...state, head: page.hash, pages: 2, retainedBytes: 2,
      positions: state.positions.map((p) => p.stream === "stdout" ? { ...p, last: metadata } : p) } });
  f.reopen(); await assert.rejects(f.open().finalize()); assert.equal(f.state().finalized, null);
});

test("C3 repair1 first chunk digest mismatch blocks rather than committing storage loss", async (t) => {
  const f = await fixture(t); const evidence = f.open(); const bytes = Buffer.from("a"); const before = f.state();
  await assert.rejects(evidence.writeChunk({ ...chunk(bytes), digest: "f".repeat(64) }, bytes)); assert.deepEqual(f.state(), before);
});

test("C3 repair1 legacy reference count is bounded before any artifact traversal", () => {
  const state = initialEvidenceContinuation();
  const legacyHashes = Array.from({ length: 12289 }, (_, index) => index.toString(16).padStart(64, "0"));
  assert.throws(() => parseEvidenceContinuation({ ...state, legacyHashes }));
});

for (const fault of ["segment", "page", "missing"] as const) {
  test(`C3 reopening blocks ${fault} corruption before finalization`, async (t) => {
    const f = await fixture(t); const bytes = Buffer.from("evidence"); await f.open().writeChunk(chunk(bytes), bytes);
    const head = f.state().head!; const segment = chunk(bytes).digest;
    const originalGet = f.artifacts.get.bind(f.artifacts);
    f.artifacts.get = async (id) => id === (fault === "page" ? head : segment) ? fault === "missing" ? Promise.reject(new Error("missing")) : Buffer.from("corrupt!") : originalGet(id);
    f.reopen(); await assert.rejects(f.open().finalize()); assert.equal(f.state().finalized, null);
  });
}

test("C3 exact identity replay rejects changed digest, offset, and stream", async (t) => {
  const f = await fixture(t); const bytes = Buffer.from("a"); const original = chunk(bytes); const evidence = f.open();
  await evidence.writeChunk(original, bytes); const before = f.state();
  for (const [metadata, input] of [[{ ...original, digest: "f".repeat(64) }, bytes], [{ ...original, startOffset: 1, endOffset: 2 }, bytes], [{ ...original, stream: "stderr", sequence: 2 }, bytes]] as const) {
    await assert.rejects(evidence.writeChunk(metadata, input)); assert.deepEqual(f.state(), before);
  }
});

for (const swap of ["page identity", "segment reference"] as const) test(`C3 valid-hash swapped ${swap} is blocked`, async (t) => {
  const f = await fixture(t); f.open(); const bytes = Buffer.from("a"); const metadata = chunk(bytes);
  const segment = await f.artifacts.put(swap === "segment reference" ? Buffer.from("b") : bytes, "application/octet-stream");
  const page = await f.artifacts.put(Buffer.from(JSON.stringify({ version: 1,
    evidenceId: swap === "page identity" ? "00000000-0000-0000-0000-000000000000" : f.state().evidenceId,
    previousHash: null, segmentHash: segment.hash, metadata })), "application/json");
  const cp = f.checkpoint(); getStreamingSessionKernelWriter(f.kernel).applyOutputCheckpoint({ type: "commit_continuation",
    sessionId: "session", ownerId: "owner", fencingToken: 1, expectedRevision: cp.revision,
    continuation: { ...f.state(), head: page.hash, pages: 1, retainedBytes: 1,
      positions: f.state().positions.map((p) => p.stream === "stdout" ? { ...p, last: metadata } : p) } });
  f.reopen(); await assert.rejects(f.open().finalize()); assert.equal(f.state().finalized, null);
});

test("C3 restart after evidence CAS but before spool effect preserves exact committed bytes", async (t) => {
  const f = await fixture(t); const evidence = f.open(); const bytes = Buffer.from("committed");
  f.spools[0]!.write = async () => { throw new Error("disposed after CAS"); };
  await assert.rejects(evidence.writeChunk(chunk(bytes), bytes));
  assert.equal(f.state().pages, 1); assert.equal(f.state().loss, "none");
  await assert.rejects(evidence.finalize());
  f.reopen(); const fresh = f.open(); await fresh.writeChunk(chunk(bytes), bytes);
  const result = await fresh.finalize(); assert.equal(result.streams[0]!.totalBytes, bytes.length);
  assert.equal(Buffer.from(result.streams[0]!.tailBytesBase64, "base64").toString(), "committed");
});

for (const boundary of ["accepted", "intent", "consumed", "ack"] as const) test(`C3 durable replay at ${boundary} retains family-effect ambiguity and evidence idempotence`, async (t) => {
  const f = await fixture(t); const bytes = Buffer.from("a"); const metadata = chunk(bytes); const first = f.open();
  const command = (type: string) => getStreamingSessionKernelWriter(f.kernel).applyOutputCheckpoint({ type, sessionId: "session", ownerId: "owner", fencingToken: 1,
    expectedRevision: f.checkpoint().revision, metadata });
  command("accept"); await first.writeChunk(metadata, bytes);
  if (boundary !== "accepted") command("begin_consume");
  if (boundary === "consumed" || boundary === "ack") command("commit_consumed");
  let oldAcks = 0; if (boundary === "ack") oldAcks++;
  f.reopen(); const evidence = f.open(); let deliveries = 0;
  const controller = createStreamingOutputController({ kernel: f.kernel, sessionId: "session", ownerId: "owner", fencingToken: 1,
    maxAcceptedChunks: 4, queue: new BoundedProtocolQueue({ maxBytes: 16, maxChunks: 4, maxFrameBytes: 16 }), protocolStreams: ["stdout"],
    writeEvidence: async (_stream, input, metadata) => { await evidence.writeChunk(metadata, input); return { evidenceLossy: false }; },
    assertAuthorization: () => undefined, deliver: async () => { deliveries++; } });
  try {
    if (boundary === "intent") {
      assert.throws(() => controller.attestRetainedWindow([metadata]), /unknown/);
      assert.equal(f.checkpoint().outcome, "outcome_unknown"); assert.equal(deliveries, 0); return;
    }
    controller.attestRetainedWindow(f.checkpoint().streams[0]!.accepted);
    const accepted = controller.accept(metadata, bytes);
    if (boundary === "accepted") { await controller.waitForPending(AbortSignal.timeout(2000)); await controller.deliverNextPrivately(async () => { deliveries++; }); }
    await accepted; assert.equal(deliveries, boundary === "accepted" ? 1 : 0); assert.equal(oldAcks, boundary === "ack" ? 1 : 0);
    const result = await evidence.finalize(); assert.equal(result.streams[0]!.totalBytes, 1); assert.equal(f.state().pages, 1);
  } finally { controller.cancel(); }
});

for (const operation of ["begin_consume", "commit_evidence_consumed"] as const) test(`C3 v2 ${operation} refuses evidence that has not committed`, async (t) => {
  const f = await fixture(t); f.open(); const metadata = chunk(Buffer.from("a")); const writer = getStreamingSessionKernelWriter(f.kernel);
  if (operation === "begin_consume") writer.applyOutputCheckpoint({ type: "accept", sessionId: "session", ownerId: "owner", fencingToken: 1,
    expectedRevision: f.checkpoint().revision, metadata });
  const before = f.checkpoint(); assert.throws(() => writer.applyOutputCheckpoint({ type: operation, sessionId: "session", ownerId: "owner", fencingToken: 1,
    expectedRevision: before.revision, metadata })); assert.deepEqual(f.checkpoint(), before);
});

test("C3 legacy consumed metadata becomes explicit gap under the exact current fence", async (t) => {
  const f = await fixture(t); const bytes = Buffer.from("old"); const metadata = chunk(bytes);
  getStreamingSessionKernelWriter(f.kernel).applyOutputCheckpoint({ type: "commit_evidence_consumed", sessionId: "session", ownerId: "owner", fencingToken: 1, expectedRevision: 0, metadata });
  const evidence = f.open(); assert.equal(f.state().loss, "legacy_gap");
  const suffix = Buffer.from("new"); await evidence.writeChunk(chunk(suffix, 2, 3), suffix);
  const result = await evidence.finalize(); assert.equal(result.streams[0]!.totalBytes, 6); assert.equal(result.streams[0]!.lossyBytes, 3);
  assert.equal(Buffer.from(result.streams[0]!.tailBytesBase64, "base64").toString(), "new");
  assert.equal(f.state().pages, 1);
});

test("C3 concurrent early delivery cannot overtake evidence commit", async (t) => {
  const f = await fixture(t); let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  let deliveries = 0; const queue = new BoundedProtocolQueue({ maxBytes: 16, maxChunks: 4, maxFrameBytes: 16 });
  const controller = createStreamingOutputController({ kernel: f.kernel, sessionId: "session", ownerId: "owner", fencingToken: 1,
    maxAcceptedChunks: 4, queue, protocolStreams: ["stdout"], writeEvidence: async () => { await held; return { evidenceLossy: false }; },
    assertAuthorization: () => undefined, deliver: async () => { deliveries++; } });
  const bytes = Buffer.from("a"); const accepted = controller.accept(chunk(bytes), bytes); void accepted.catch(() => undefined);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await controller.deliverNextPrivately(async () => { deliveries++; }), false);
    assert.equal(deliveries, 0); assert.equal(f.checkpoint().streams[0]!.consumingIntent, null);
    release(); await controller.waitForPending(AbortSignal.timeout(1000));
    await controller.deliverNextPrivately(async () => { deliveries++; }); await accepted; assert.equal(deliveries, 1);
  } finally { release(); controller.cancel(); await accepted.catch(() => undefined); }
});

for (const boundary of ["before_segment", "after_segment", "before_page", "after_page"] as const) {
  test(`C3 process restart at ${boundary} keeps pre-CAS artifacts uncommitted`, async (t) => {
    const f = await fixture(t); const put = f.artifacts.put.bind(f.artifacts);
    let release!: () => void; let reached!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { reached = resolve; }); let writes = 0;
    f.artifacts.put = async (...args) => {
      const selected = ++writes === (boundary.endsWith("segment") ? 1 : 2);
      if (selected && boundary.startsWith("before")) { reached(); await held; }
      const result = await put(...args);
      if (selected && boundary.startsWith("after")) { reached(); await held; }
      return result;
    };
    const bytes = Buffer.from("retained"); const old = f.open(); const interrupted = old.writeChunk(chunk(bytes), bytes);
    void interrupted.catch(() => undefined);
    try {
      await entered; f.reopen(); release(); await assert.rejects(interrupted);
      assert.equal(f.state().head, null); assert.equal(f.state().pages, 0);
      f.artifacts.put = put;
      const fresh = f.open(); await fresh.writeChunk(chunk(bytes), bytes);
      const result = await fresh.finalize(); assert.equal(Buffer.from(result.streams[0]!.tailBytesBase64, "base64").toString(), "retained");
      assert.equal(result.streams[0]!.lossyBytes, 0); assert.equal(f.state().pages, 1);
    } finally { release(); await interrupted.catch(() => undefined); }
  });
}

for (const write of [1, 2]) test(`C3 storage failure at artifact ${write} commits explicit loss before ACK`, async (t) => {
  const f = await fixture(t); const put = f.artifacts.put.bind(f.artifacts); let writes = 0;
  f.artifacts.put = async (...args) => { if (++writes === write) throw new Error("synthetic storage failure"); return await put(...args); };
  const evidence = f.open(); const bytes = Buffer.from("lost");
  const controller = createStreamingOutputController({ kernel: f.kernel, sessionId: "session", ownerId: "owner", fencingToken: 1,
    maxAcceptedChunks: 4, queue: new BoundedProtocolQueue({ maxBytes: 16, maxChunks: 4, maxFrameBytes: 16 }), protocolStreams: [],
    writeEvidence: async (_stream, input, metadata) => { await evidence.writeChunk(metadata, input); return { evidenceLossy: true }; },
    assertAuthorization: () => assert.fail("no family authority"), deliver: async () => assert.fail("no family delivery") });
  await controller.accept(chunk(bytes), bytes);
  assert.equal(f.state().loss, "storage"); assert.equal(f.state().positions[0]!.lostBytes, 4); assert.equal(f.state().pages, 0);
  f.reopen(); const result = await f.open().finalize(); assert.equal(result.streams[0]!.totalBytes, 4); assert.equal(result.streams[0]!.lossyBytes, 4);
});

test("C3 checkpoint CAS failure never turns storage success into loss success or ACK", async (t) => {
  const f = await fixture(t); const evidence = f.open(); const bytes = Buffer.from("held"); const metadata = chunk(bytes);
  const put = f.artifacts.put.bind(f.artifacts); let calls = 0;
  f.artifacts.put = async (...args) => {
    const result = await put(...args);
    if (++calls === 2) {
      const cp = f.checkpoint(); getStreamingSessionKernelWriter(f.kernel).applyOutputCheckpoint({ type: "accept", sessionId: "session", ownerId: "owner", fencingToken: 1, expectedRevision: cp.revision, metadata });
    }
    return result;
  };
  const controller = createStreamingOutputController({ kernel: f.kernel, sessionId: "session", ownerId: "owner", fencingToken: 1,
    maxAcceptedChunks: 4, queue: new BoundedProtocolQueue({ maxBytes: 16, maxChunks: 4, maxFrameBytes: 16 }), protocolStreams: [],
    writeEvidence: async (_stream, input, metadata) => { await evidence.writeChunk(metadata, input); return { evidenceLossy: false }; },
    assertAuthorization: () => assert.fail("no authority"), deliver: async () => assert.fail("no delivery") });
  await assert.rejects(controller.accept(metadata, bytes));
  assert.equal(f.checkpoint().streams[0]!.lastConsumed, null); assert.equal(f.state().head, null); assert.equal(f.state().loss, "none");
});

test("C3 same-instance restore retry after a later segment read failure never duplicates earlier bytes", async (t) => {
  const f = await fixture(t); const a = Buffer.from("a"); const b = Buffer.from("b"); const first = f.open();
  await first.writeChunk(chunk(a), a); await first.writeChunk(chunk(b, 2, 1), b);
  f.reopen(); const get = f.artifacts.get.bind(f.artifacts); let failed = false;
  f.artifacts.get = async (hash) => { if (hash === chunk(b).digest && !failed) { failed = true; throw new Error("transient read failure"); } return await get(hash); };
  const fresh = f.open(); await assert.rejects(fresh.finalize());
  const result = await fresh.finalize();
  assert.equal(Buffer.from(result.streams[0]!.tailBytesBase64, "base64").toString(), "ab");
  assert.equal(result.streams[0]!.totalBytes, 2);
});

test("C3 older same-fence spool cannot finalize after another continuation advances the head", async (t) => {
  const f = await fixture(t); const first = f.open(); const a = Buffer.from("a"); const b = Buffer.from("b");
  await first.writeChunk(chunk(a), a);
  const second = f.open(); await second.writeChunk(chunk(b, 2, 1), b);
  await assert.rejects(first.finalize()); assert.equal(f.state().finalized, null);
  const result = await second.finalize(); assert.equal(Buffer.from(result.streams[0]!.tailBytesBase64, "base64").toString(), "ab");
});

test("C3 head changing during restore cannot authenticate a stale spool result", async (t) => {
  const f = await fixture(t); const first = f.open(); const a = Buffer.from("a"); const b = Buffer.from("b");
  await first.writeChunk(chunk(a), a);
  const get = f.artifacts.get.bind(f.artifacts); let release!: () => void; let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; }); const reached = new Promise<void>((resolve) => { entered = resolve; });
  f.artifacts.get = async (hash) => { if (hash === chunk(a).digest) { entered(); await held; } return await get(hash); };
  const second = f.open(); const stale = second.finalize(); void stale.catch(() => undefined);
  try {
    await reached; await first.writeChunk(chunk(b, 2, 1), b); release();
    await assert.rejects(stale); assert.equal(f.state().finalized, null);
    const result = await second.finalize(); assert.equal(result.streams[0]!.totalBytes, 2);
    assert.equal(Buffer.from(result.streams[0]!.tailBytesBase64, "base64").toString(), "ab");
  } finally { release(); await stale.catch(() => undefined); }
});

test("C3 head changing during spool effects retains a nonretryable stale view", async (t) => {
  const f = await fixture(t); const first = f.open(); const a = Buffer.from("a"); const b = Buffer.from("b");
  await first.writeChunk(chunk(a), a); const second = f.open();
  const write = f.spools[1]!.write.bind(f.spools[1]); let release!: () => void; let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; }); const reached = new Promise<void>((resolve) => { entered = resolve; });
  f.spools[1]!.write = async (...args) => { entered(); await held; return await write(...args); };
  const stale = second.finalize(); void stale.catch(() => undefined);
  try {
    await reached; await first.writeChunk(chunk(b, 2, 1), b); release();
    await assert.rejects(stale); await assert.rejects(second.finalize()); assert.equal(f.state().finalized, null);
    const result = await f.open().finalize(); assert.equal(result.streams[0]!.totalBytes, 2);
    assert.equal(Buffer.from(result.streams[0]!.tailBytesBase64, "base64").toString(), "ab");
  } finally { release(); await stale.catch(() => undefined); }
});

test("C3 byte capacity commits bounded loss without writing an oversized segment", async (t) => {
  const f = await fixture(t); const evidence = f.open(); const bytes = Buffer.alloc(EVIDENCE_MAX_BYTES + 1, 1);
  const put = f.artifacts.put.bind(f.artifacts); let writes = 0;
  f.artifacts.put = async (...args) => { writes++; return await put(...args); };
  await evidence.writeChunk(chunk(bytes), bytes);
  assert.equal(writes, 0); assert.equal(f.state().loss, "capacity"); assert.equal(f.state().retainedBytes, 0);
  assert.equal(f.state().positions[0]!.lostBytes, EVIDENCE_MAX_BYTES + 1);
  const result = await evidence.finalize(); assert.equal(result.streams[0]!.totalBytes, EVIDENCE_MAX_BYTES + 1);
  assert.equal(result.streams[0]!.lossReasons[0]!.code, "evidence_continuation_loss");
});

test("C3 tiny-chunk page capacity stops artifact growth while consumed positions continue", async (t) => {
  const f = await fixture(t); const evidence = f.open(); const bytes = Buffer.from("a");
  for (let index = 0; index < EVIDENCE_MAX_PAGES; index++) await evidence.writeChunk(chunk(bytes, index + 1, index), bytes);
  const put = f.artifacts.put.bind(f.artifacts); let writes = 0;
  f.artifacts.put = async (...args) => { writes++; return await put(...args); };
  for (let index = EVIDENCE_MAX_PAGES; index < EVIDENCE_MAX_PAGES + 16; index++) await evidence.writeChunk(chunk(bytes, index + 1, index), bytes);
  assert.equal(writes, 0); assert.equal(f.state().pages, EVIDENCE_MAX_PAGES); assert.equal(f.state().retainedBytes, EVIDENCE_MAX_PAGES);
  assert.equal(f.state().loss, "capacity"); assert.equal(f.state().positions[0]!.lostBytes, 16);
});

for (const fault of ["none", "identity", "result_reference", "manifest_loss", "final_loss", "total", "loss_bytes", "loss_flag", "stream_identity", "result_shape", "legacy_reference", "lossy_positions", "lossy_offsets"] as const)
test(`C3 round4 immutable verifier ${fault}`, async (t) => {
  const f = await fixture(t);
  const evidence = f.open();
  const bytes = Buffer.from("verified output");
  await evidence.writeChunk(chunk(bytes), bytes);
  const result = await evidence.finalize();
  const state = structuredClone(f.state());
  const final = state.finalized!;
  const manifest = JSON.parse((await f.artifacts.get(final.manifestHash)).toString());
  if (fault === "identity") manifest.evidenceId = "00000000-0000-0000-0000-000000000099";
  if (fault === "result_reference") manifest.resultHash = "a".repeat(64);
  if (fault === "manifest_loss") manifest.summary.loss = "storage";
  if (fault === "final_loss") Object.assign(final, { lossy: true });
  if (["total", "loss_bytes", "loss_flag", "stream_identity", "result_shape"].includes(fault)) {
    const changed = structuredClone(result);
    if (fault === "total") Object.assign(changed.streams[0]!, { totalBytes: bytes.length + 1 });
    if (fault === "loss_bytes") Object.assign(changed.streams[0]!, { lossyBytes: -1 });
    if (fault === "loss_flag") { Object.assign(changed.streams[0]!, { lossyOutput: true }); Object.assign(final, { lossy: true }); }
    if (fault === "stream_identity") Object.assign(changed.streams[0]!, { stream: "stderr" });
    if (fault === "result_shape") Object.assign(changed, { streams: [] });
    const artifact = await f.artifacts.put(Buffer.from(JSON.stringify(changed)), "application/json");
    Object.assign(final, { resultHash: artifact.hash }); manifest.resultHash = artifact.hash;
  }
  if (fault === "lossy_positions") {
    const changed = structuredClone(result);
    Object.assign(state, { loss: "legacy_gap", positions: [
      { stream: "stdout", last: chunk(Buffer.alloc(bytes.length + 1)), lostBytes: bytes.length + 1 },
      { stream: "stderr", last: chunk(Buffer.alloc(bytes.length + 1), 1, 0, "stderr"), lostBytes: 1 },
    ] });
    Object.assign(changed.streams[0]!, { totalBytes: bytes.length + 1, lossyBytes: bytes.length + 1, lossyOutput: true });
    Object.assign(changed.streams[1]!, { totalBytes: bytes.length + 1, lossyBytes: 1, lossyOutput: true });
    const artifact = await f.artifacts.put(Buffer.from(JSON.stringify(changed)), "application/json");
    Object.assign(final, { resultHash: artifact.hash, lossy: true });
    manifest.resultHash = artifact.hash;
    manifest.summary = { loss: state.loss, positions: state.positions, retainedBytes: state.retainedBytes, pages: state.pages };
  }
  if (fault === "lossy_offsets") {
    const changed = structuredClone(result);
    const oldPage = JSON.parse((await f.artifacts.get(state.head!)).toString());
    oldPage.metadata.startOffset = 100; oldPage.metadata.endOffset = 100 + bytes.length;
    const page = await f.artifacts.put(Buffer.from(JSON.stringify(oldPage)), "application/json");
    Object.assign(state, { head: page.hash, loss: "storage", positions: [
      { stream: "stdout", last: chunk(Buffer.alloc(bytes.length + 1)), lostBytes: 1 },
      { stream: "stderr", last: null, lostBytes: 0 },
    ] });
    Object.assign(changed.streams[0]!, { totalBytes: bytes.length + 1, lossyBytes: 1, lossyOutput: true });
    const artifact = await f.artifacts.put(Buffer.from(JSON.stringify(changed)), "application/json");
    Object.assign(final, { resultHash: artifact.hash, lossy: true });
    manifest.resultHash = artifact.hash; manifest.previousHash = page.hash;
    manifest.summary = { loss: state.loss, positions: state.positions, retainedBytes: state.retainedBytes, pages: state.pages };
  }
  if (fault === "legacy_reference") {
    Object.assign(state, { legacyHashes: ["a".repeat(64)] });
    const page = await f.artifacts.put(Buffer.from(JSON.stringify({ version: 1, evidenceId: state.evidenceId, previousHash: null, artifactHashes: ["b".repeat(64)] })), "application/json");
    Object.assign(final, { legacyHead: page.hash }); manifest.legacyHead = page.hash;
  }
  const artifact = await f.artifacts.put(Buffer.from(JSON.stringify(manifest)), "application/json");
  Object.assign(final, { manifestHash: artifact.hash });
  const before = f.checkpoint();
  let effects = 0;
  f.artifacts.put = async () => { effects++; throw new Error("unexpected put"); };
  f.artifacts.remove = async () => { effects++; throw new Error("unexpected deletion"); };
  for (const spool of f.spools) {
    spool.write = async () => { effects++; throw new Error("unexpected spool write"); };
    spool.finalize = async () => { effects++; throw new Error("unexpected finalization"); };
  }
  if (fault === "none") assert.deepEqual(await verifyFinalizedEvidence(f.artifacts, state), result);
  else await assert.rejects(verifyFinalizedEvidence(f.artifacts, state), (error: unknown) => error instanceof Error && error.message === "Authenticated evidence continuation is unavailable.");
  assert.equal(effects, 0); assert.deepEqual(f.checkpoint(), before);
});
