import { createLinkedTestOutputSpillStorage } from "./support/linked-output-spill-storage.js";
import { BoundedProtocolQueue } from "../src/bounded-protocol-queue.js";
import { StreamingOutputError } from "../src/streaming-output-controller.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, createHmac } from "node:crypto";
import { lstat, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import type { BoundedOutputSpoolResult, OutputSpillStorage } from "../src/bounded-output-spool.js";
import { BoundedOutputSpool, createNodeOutputSpillStorage } from "../src/bounded-output-spool.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { ArtifactReachabilityGuard } from "../src/artifact-reachability.js";
import { createEvidenceContinuation } from "../src/evidence-continuation.js";
import { waitForRealStreamingOutputReadiness } from "./support/real-streaming-output-readiness.js";

import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import { createSessionAuthority } from "../src/session-authority.js";
import { createStreamingProcessSessionRuntime, StreamingProcessSessionError, type StreamingRuntimeOptions } from "../src/streaming-process-session-runtime.js";
import { createInMemoryStreamingSessionStore, getStreamingSessionKernelWriter, getStreamingSessionStoreWriter, HOST_LAUNCH_RECORD_VERSION, openSqliteStreamingSessionStore, StreamingSessionStoreError, type StreamingSessionBackendBinding } from "../src/streaming-session-store.js";

const now = "2026-08-30T00:00:00.000Z";

const adoptedResources = ["workload_quiescence", "retained_output_settlement", "evidence", "channel_detach", "backend_release", "isolation_release"] as const;

for (const [store, channelState, crash] of [
  ["memory", "failed", "none"], ["memory", "pending", "none"],
  ["sqlite", "failed", "none"], ["sqlite", "pending", "none"],
  ["sqlite", "failed", "before_delete"], ["sqlite", "failed", "after_delete"],
] as const) test(`C3 repair1 partial host evidence survives ${store} ${channelState} ${crash}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "c3-partial-host-")); t.diagnostic(`created exact fixture root: ${root}`);
  const path = join(root, "sessions.sqlite"); const key = Buffer.alloc(32, 31);
  let kernel = store === "sqlite" ? openSqliteStreamingSessionStore(path, key) : createInMemoryStreamingSessionStore();
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const spool = new BoundedOutputSpool({ spillRoot: join(root, "spool"), projectRoot: process.cwd(), ownershipId: "partial-fixture", artifactStore: artifacts });
  try {
    const f = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { kernel });
    let writer = getStreamingSessionKernelWriter(kernel);
    writer.prepareLaunch(f.preparedRecord());
    const transition = (type: string, fields: Record<string, unknown> = {}) => {
      const host = kernel.store.readHostLaunch("launch-1")!;
      return getStreamingSessionKernelWriter(kernel).transitionLaunch({ type, launchId: host.launchId, ownerId: host.ownerId,
        fencingToken: host.fencingToken, expectedRevision: host.revision, at: now, ...fields });
    };
    transition("bind_isolation", { lease: leaseRecord() }); transition("begin_launch"); transition("bind_backend", { backendBinding: f.backendBinding }); transition("begin_channel");
    writer.claimHostOutputCheckpoint({ launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 4, at: now,
      record: { recordKind: "runner.output-checkpoint", schemaVersion: 1, revision: 0, sessionId: "stream-1", ownerId: "output-owner", fencingToken: 1,
        capacity: 4, outcome: "active", streams: ["stdout", "stderr"].map((stream) => ({ stream, lastConsumed: null, consumed: [], accepted: [], consumingIntent: null })) } });
    const evidence = createEvidenceContinuation({ kernel, sessionId: "stream-1", ownerId: "output-owner", fencingToken: 1, artifacts, spool });
    const bytes = Buffer.from("durable"); const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 7, byteLength: 7, digest: createHash("sha256").update(bytes).digest("hex") };
    await evidence.writeChunk(metadata, bytes);
    writer.applyOutputCheckpoint({ type: "commit_evidence_consumed", sessionId: "stream-1", ownerId: "output-owner", fencingToken: 1,
      expectedRevision: kernel.store.readOutputCheckpoint("stream-1")!.revision, metadata });
    await evidence.finalize(); const source = kernel.store.readOutputCheckpoint("stream-1")!;
    const final = source.continuation!.finalized!;
    const reference = { kind: "bounded_output_manifest" as const, digest: final.manifestHash, lossy: final.lossy,
      ...(final.lossy ? { lossReason: "bounded_output_loss" as const } : {}) };
    const begun = transition("begin_cleanup");
    const resources = begun.effects.find((effect) => effect.kind === "cleanup")!.resources!;
    const failure = { code: "channel_detach_failed", message: "Streaming channel detach failed." };
    const results = resources.map((fact) => ({ resource: fact.resource, identity: fact.identity, ownerId: fact.ownerId, fencingToken: fact.fencingToken,
      ...(fact.resource === "channel" ? { status: "failed", failure } : { status: "succeeded", ...(fact.resource === "output_checkpoint" ? { evidence: reference } : {}) }) }));
    transition("settle_cleanup_blocked", { blocker: failure, results });
    if (channelState === "pending") transition("begin_cleanup");
    const partial = kernel.store.readHostLaunch("launch-1")!;
    const facts = partial.effects.find((effect) => effect.kind === "cleanup")!.resources!;
    assert.equal(facts.find((fact) => fact.resource === "channel")!.status, channelState);
    assert.deepEqual(facts.find((fact) => fact.resource === "output_checkpoint")!.evidence, reference);
    assert.deepEqual(kernel.store.readOutputCheckpoint("stream-1"), source, "partial success retains its source and exact progress");
    if (store === "sqlite") { kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key); writer = getStreamingSessionKernelWriter(kernel); }
    assert.deepEqual(kernel.store.readHostLaunch("launch-1"), partial);
    assert.throws(() => writer.deleteOutputCheckpoint({ sessionId: "stream-1", launchId: "launch-1", ownerId: source.ownerId,
      fencingToken: source.fencingToken, expectedRevision: source.revision, evidence: reference }), "direct deletion must keep the unsettled reader's source");
    const guard = new ArtifactReachabilityGuard(root, artifacts);
    if (store === "sqlite") await guard.runQuiescent(async () => { await guard.prepareReachabilityIndex(); assert.equal(await guard.removeIfGloballyUnreachable(metadata.digest), false); });
    if (channelState === "failed") transition("begin_cleanup");
    const retry = kernel.store.readHostLaunch("launch-1")!;
    const unsettled = retry.effects.find((effect) => effect.kind === "cleanup")!.resources!.filter((fact) => fact.status !== "succeeded");
    assert.deepEqual(unsettled.map((fact) => fact.resource), ["channel"]);
    const settle = () => transition("settle_cleanup_cleaned", { results: unsettled.map((fact) => ({ resource: fact.resource, identity: fact.identity,
      ownerId: fact.ownerId, fencingToken: fact.fencingToken, status: "succeeded" })) });
    if (crash !== "none") {
      const db = new DatabaseSync(path); try { db.exec(`CREATE TRIGGER c3_partial_abort ${crash === "before_delete" ? "BEFORE" : "AFTER"} DELETE ON streaming_output_checkpoints BEGIN SELECT RAISE(ABORT, 'synthetic partial transfer crash'); END`); } finally { db.close(); }
      assert.throws(settle); assert.deepEqual(kernel.store.readHostLaunch("launch-1"), retry); assert.deepEqual(kernel.store.readOutputCheckpoint("stream-1"), source);
      kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key); writer = getStreamingSessionKernelWriter(kernel);
      const reopened = new DatabaseSync(path); try { reopened.exec("DROP TRIGGER c3_partial_abort"); } finally { reopened.close(); }
    }
    settle(); assert.equal(kernel.store.readOutputCheckpoint("stream-1"), undefined);
    assert.equal(kernel.store.readHostLaunch("launch-1")!.state, "released");
    if (store === "sqlite") { kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key); writer = getStreamingSessionKernelWriter(kernel); }
    writer.deleteOutputCheckpoint({ sessionId: "stream-1", launchId: "launch-1", evidence: reference });
    assert.throws(() => writer.deleteOutputCheckpoint({ sessionId: "stream-1", launchId: "launch-1", evidence: { ...reference, digest: "a".repeat(64) } }));
    await artifacts.verify(reference.digest);
    if (store === "sqlite") await guard.runQuiescent(async () => { await guard.prepareReachabilityIndex(); assert.equal(await guard.removeIfGloballyUnreachable(metadata.digest), false); });
  } finally { await spool.cleanup(); kernel.store.close(); await rm(root, { recursive: true, force: true }); t.diagnostic(`removed exact fixture root: ${root}`); }
});

for (const [store, sourceState] of [
  ["memory", "foreign_manifest"], ["memory", "loss_identity"], ["memory", "unfinalized"], ["memory", "accepted"], ["memory", "consuming_intent"],
  ["sqlite", "foreign_manifest"], ["sqlite", "loss_identity"], ["sqlite", "unfinalized"], ["sqlite", "accepted"], ["sqlite", "consuming_intent"],
] as const) test(`C3 repair2 invalid partial host evidence rejects ${store} ${sourceState}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "c3-partial-invalid-")); t.diagnostic(`created exact fixture root: ${root}`);
  const path = join(root, "sessions.sqlite"); const key = Buffer.alloc(32, 32);
  let kernel = store === "sqlite" ? openSqliteStreamingSessionStore(path, key) : createInMemoryStreamingSessionStore();
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const spool = new BoundedOutputSpool({ spillRoot: join(root, "spool"), projectRoot: process.cwd(), ownershipId: "partial-invalid-fixture", artifactStore: artifacts });
  try {
    const f = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { kernel });
    let writer = getStreamingSessionKernelWriter(kernel);
    writer.prepareLaunch(f.preparedRecord());
    const transition = (type: string, fields: Record<string, unknown> = {}) => {
      const host = kernel.store.readHostLaunch("launch-1")!;
      return getStreamingSessionKernelWriter(kernel).transitionLaunch({ type, launchId: host.launchId, ownerId: host.ownerId,
        fencingToken: host.fencingToken, expectedRevision: host.revision, at: now, ...fields });
    };
    transition("bind_isolation", { lease: leaseRecord() }); transition("begin_launch"); transition("bind_backend", { backendBinding: f.backendBinding }); transition("begin_channel");
    writer.claimHostOutputCheckpoint({ launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 4, at: now,
      record: { recordKind: "runner.output-checkpoint", schemaVersion: 1, revision: 0, sessionId: "stream-1", ownerId: "output-owner", fencingToken: 1,
        capacity: 4, outcome: "active", streams: ["stdout", "stderr"].map((stream) => ({ stream, lastConsumed: null, consumed: [], accepted: [], consumingIntent: null })) } });
    const evidence = createEvidenceContinuation({ kernel, sessionId: "stream-1", ownerId: "output-owner", fencingToken: 1, artifacts, spool });
    const bytes = Buffer.from("durable"); const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 7, byteLength: 7, digest: createHash("sha256").update(bytes).digest("hex") };
    await evidence.writeChunk(metadata, bytes);
    writer.applyOutputCheckpoint({ type: "commit_evidence_consumed", sessionId: "stream-1", ownerId: "output-owner", fencingToken: 1,
      expectedRevision: kernel.store.readOutputCheckpoint("stream-1")!.revision, metadata });
    const accepted = { stream: "stdout" as const, sequence: 2, startOffset: 7, endOffset: 11, byteLength: 4, digest: createHash("sha256").update("next").digest("hex") };
    if (sourceState === "accepted" || sourceState === "consuming_intent") {
      if (sourceState === "consuming_intent") await evidence.writeChunk(accepted, Buffer.from("next"));
      writer.applyOutputCheckpoint({ type: "accept", sessionId: "stream-1", ownerId: "output-owner", fencingToken: 1,
        expectedRevision: kernel.store.readOutputCheckpoint("stream-1")!.revision, metadata: accepted });
      if (sourceState === "consuming_intent") writer.applyOutputCheckpoint({ type: "begin_consume", sessionId: "stream-1", ownerId: "output-owner", fencingToken: 1,
        expectedRevision: kernel.store.readOutputCheckpoint("stream-1")!.revision, metadata: accepted });
    }
    if (sourceState !== "unfinalized") await evidence.finalize();
    const source = kernel.store.readOutputCheckpoint("stream-1")!;
    const finalized = source.continuation!.finalized;
    const validReference = finalized ? { kind: "bounded_output_manifest" as const, digest: finalized.manifestHash, lossy: finalized.lossy,
      ...(finalized.lossy ? { lossReason: "bounded_output_loss" as const } : {}) } : undefined;
    const reference = sourceState === "foreign_manifest"
      ? { ...validReference!, digest: "b".repeat(64) }
      : sourceState === "loss_identity"
        ? validReference!.lossy
          ? { kind: "bounded_output_manifest" as const, digest: validReference!.digest, lossy: false }
          : { ...validReference!, lossy: true, lossReason: "bounded_output_loss" as const }
        : sourceState === "unfinalized"
          ? { kind: "bounded_output_manifest" as const, digest: source.continuation!.head!, lossy: false }
          : validReference!;
    if (sourceState === "unfinalized") assert.equal(finalized, null);
    if (sourceState === "accepted") assert.equal(source.streams.find((stream) => stream.stream === "stdout")!.accepted.length, 1);
    if (sourceState === "consuming_intent") assert.notEqual(source.streams.find((stream) => stream.stream === "stdout")!.consumingIntent, null);
    const begun = transition("begin_cleanup");
    const resources = begun.effects.find((effect) => effect.kind === "cleanup")!.resources!;
    const failure = { code: "channel_detach_failed", message: "Streaming channel detach failed." };
    const results = (evidenceReference: typeof reference) => resources.map((fact) => ({ resource: fact.resource, identity: fact.identity, ownerId: fact.ownerId, fencingToken: fact.fencingToken,
      ...(fact.resource === "channel" ? { status: "failed", failure } : { status: "succeeded", ...(fact.resource === "output_checkpoint" ? { evidence: evidenceReference } : {}) }) }));
    const before = kernel.store.readHostLaunch("launch-1")!;
    assert.throws(() => transition("settle_cleanup_blocked", { blocker: failure, results: results(reference) }),
      (error: unknown) => error instanceof StreamingSessionStoreError && error.message === "Evidence source is not exactly finalized and settled.");
    assert.deepEqual(kernel.store.readHostLaunch("launch-1"), before, "invalid evidence must not persist a partial host success");
    assert.deepEqual(kernel.store.readOutputCheckpoint("stream-1"), source, "invalid evidence must not alter the source checkpoint");
    if (store === "sqlite") {
      kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key); writer = getStreamingSessionKernelWriter(kernel);
      assert.deepEqual(kernel.store.readHostLaunch("launch-1"), before, "SQLite rollback must reopen with the exact host state");
      assert.deepEqual(kernel.store.readOutputCheckpoint("stream-1"), source, "SQLite rollback must reopen with the exact source checkpoint");
    }
    if (sourceState === "foreign_manifest" || sourceState === "loss_identity") {
      const retried = transition("settle_cleanup_blocked", { blocker: failure, results: results(validReference!) });
      assert.deepEqual(retried.effects.find((effect) => effect.kind === "cleanup")!.resources!.find((fact) => fact.resource === "output_checkpoint")!.evidence, validReference);
      assert.deepEqual(kernel.store.readOutputCheckpoint("stream-1"), source, "a valid retry retains exact partial source progress");
      if (sourceState === "foreign_manifest") {
        const unsettledSource = writer.applyOutputCheckpoint({ type: "accept", sessionId: "stream-1", ownerId: "output-owner", fencingToken: 1,
          expectedRevision: kernel.store.readOutputCheckpoint("stream-1")!.revision, metadata: accepted });
        assert.throws(() => transition("begin_cleanup"),
          (error: unknown) => error instanceof StreamingSessionStoreError && error.message === "Evidence source is not exactly finalized and settled.");
        assert.deepEqual(kernel.store.readHostLaunch("launch-1"), retried, "a prospective pending channel cannot bypass source validation");
        assert.deepEqual(kernel.store.readOutputCheckpoint("stream-1"), unsettledSource, "a rejected pending transition retains the exact source checkpoint");
        if (store === "sqlite") {
          kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key); writer = getStreamingSessionKernelWriter(kernel);
          assert.deepEqual(kernel.store.readHostLaunch("launch-1"), retried, "SQLite reopens the exact rejected pending host state");
          assert.deepEqual(kernel.store.readOutputCheckpoint("stream-1"), unsettledSource, "SQLite reopens the exact rejected pending source state");
        }
      } else {
        const pending = transition("begin_cleanup");
        assert.equal(pending.effects.find((effect) => effect.kind === "cleanup")!.resources!.find((fact) => fact.resource === "channel")!.status, "pending");
        assert.deepEqual(pending.effects.find((effect) => effect.kind === "cleanup")!.resources!.find((fact) => fact.resource === "output_checkpoint")!.evidence, validReference);
        assert.deepEqual(kernel.store.readOutputCheckpoint("stream-1"), source, "a pending channel never rolls back valid partial progress");
        if (store === "sqlite") {
          kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key); writer = getStreamingSessionKernelWriter(kernel);
          assert.deepEqual(kernel.store.readOutputCheckpoint("stream-1"), source, "SQLite retains valid partial progress after pending retry");
        }
      }
    }
  } finally { await spool.cleanup(); kernel.store.close(); await rm(root, { recursive: true, force: true }); t.diagnostic(`removed exact fixture root: ${root}`); }
});

for (const store of ["memory", "sqlite"] as const) test(`C3 repair2 pending channel validates source before retaining ${store}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "c3-partial-pending-")); t.diagnostic(`created exact fixture root: ${root}`);
  const path = join(root, "sessions.sqlite"); const key = Buffer.alloc(32, 33);
  let kernel = store === "sqlite" ? openSqliteStreamingSessionStore(path, key) : createInMemoryStreamingSessionStore();
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const spool = new BoundedOutputSpool({ spillRoot: join(root, "spool"), projectRoot: process.cwd(), ownershipId: "partial-pending-fixture", artifactStore: artifacts });
  try {
    const f = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { kernel });
    let writer = getStreamingSessionKernelWriter(kernel);
    writer.prepareLaunch(f.preparedRecord());
    const transition = (type: string, fields: Record<string, unknown> = {}) => {
      const host = kernel.store.readHostLaunch("launch-1")!;
      return getStreamingSessionKernelWriter(kernel).transitionLaunch({ type, launchId: host.launchId, ownerId: host.ownerId,
        fencingToken: host.fencingToken, expectedRevision: host.revision, at: now, ...fields });
    };
    transition("bind_isolation", { lease: leaseRecord() }); transition("begin_launch"); transition("bind_backend", { backendBinding: f.backendBinding }); transition("begin_channel");
    writer.claimHostOutputCheckpoint({ launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 4, at: now,
      record: { recordKind: "runner.output-checkpoint", schemaVersion: 1, revision: 0, sessionId: "stream-1", ownerId: "output-owner", fencingToken: 1,
        capacity: 4, outcome: "active", streams: ["stdout", "stderr"].map((stream) => ({ stream, lastConsumed: null, consumed: [], accepted: [], consumingIntent: null })) } });
    const evidence = createEvidenceContinuation({ kernel, sessionId: "stream-1", ownerId: "output-owner", fencingToken: 1, artifacts, spool });
    const bytes = Buffer.from("durable"); const consumed = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 7, byteLength: 7, digest: createHash("sha256").update(bytes).digest("hex") };
    await evidence.writeChunk(consumed, bytes);
    writer.applyOutputCheckpoint({ type: "commit_evidence_consumed", sessionId: "stream-1", ownerId: "output-owner", fencingToken: 1,
      expectedRevision: kernel.store.readOutputCheckpoint("stream-1")!.revision, metadata: consumed });
    await evidence.finalize();
    const finalized = kernel.store.readOutputCheckpoint("stream-1")!.continuation!.finalized!;
    const reference = { kind: "bounded_output_manifest" as const, digest: finalized.manifestHash, lossy: finalized.lossy,
      ...(finalized.lossy ? { lossReason: "bounded_output_loss" as const } : {}) };
    const failure = { code: "channel_detach_failed", message: "Streaming channel detach failed." };
    const begun = transition("begin_cleanup");
    const results = begun.effects.find((effect) => effect.kind === "cleanup")!.resources!.map((fact) => ({ resource: fact.resource, identity: fact.identity, ownerId: fact.ownerId, fencingToken: fact.fencingToken,
      ...(fact.resource === "channel" ? { status: "failed" as const, failure } : { status: "succeeded" as const, ...(fact.resource === "output_checkpoint" ? { evidence: reference } : {}) }) }));
    const blocked = transition("settle_cleanup_blocked", { blocker: failure, results });
    const accepted = { stream: "stdout" as const, sequence: 2, startOffset: 7, endOffset: 11, byteLength: 4, digest: createHash("sha256").update("next").digest("hex") };
    const unsettledSource = writer.applyOutputCheckpoint({ type: "accept", sessionId: "stream-1", ownerId: "output-owner", fencingToken: 1,
      expectedRevision: kernel.store.readOutputCheckpoint("stream-1")!.revision, metadata: accepted });
    assert.throws(() => transition("begin_cleanup"),
      (error: unknown) => error instanceof StreamingSessionStoreError && error.message === "Evidence source is not exactly finalized and settled.");
    assert.deepEqual(kernel.store.readHostLaunch("launch-1"), blocked, "a prospective pending channel cannot retain an unsettled source");
    assert.deepEqual(kernel.store.readOutputCheckpoint("stream-1"), unsettledSource, "a rejected pending transition retains the exact source checkpoint");
    if (store === "sqlite") {
      kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key); writer = getStreamingSessionKernelWriter(kernel);
      assert.deepEqual(kernel.store.readHostLaunch("launch-1"), blocked, "SQLite reopens the exact rejected pending host state");
      assert.deepEqual(kernel.store.readOutputCheckpoint("stream-1"), unsettledSource, "SQLite reopens the exact rejected pending source state");
    }
  } finally { await spool.cleanup(); kernel.store.close(); await rm(root, { recursive: true, force: true }); t.diagnostic(`removed exact fixture root: ${root}`); }
});

test("C2 round7 live cleanup takes over accepted output before ACK-gated quiescence", async () => {
  const bytes = Buffer.from("late");
  const metadata = {
    stream: "stdout" as const,
    sequence: 1,
    startOffset: 0,
    endOffset: bytes.byteLength,
    byteLength: bytes.byteLength,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
  const events: string[] = [];
  let cleanupSink: Parameters<import("../src/streaming-process-session-runtime.js").FakeStreamingChannel["subscribeBackpressuredOutput"]>[0] | undefined;
  let cleanupAcknowledged = false;
  const fixture = await makeFixture(2, "cleaned");
  fixture.setReattach(async (binding) => ({
    version: 2,
    binding,
    replayCapacityChunks: 4,
    replayCapacityBytes: 16,
    retainedWindow: [metadata],
    channel: {
      subscribeBackpressuredOutput: (sink) => {
        cleanupSink = sink;
        events.push("cleanup-subscribe");
        return () => { cleanupSink = undefined; events.push("cleanup-unsubscribe"); };
      },
      settleBackpressuredOutput: async () => {
        assert.equal(cleanupAcknowledged, true, "terminal settlement follows cleanup replay acknowledgement");
        events.push("output-settlement");
        return { status: "settled" as const };
      },
      detach: async () => { events.push("cleanup-detach"); },
    },
  }));
  const runtime = createStreamingProcessSessionRuntime({
    ...fixture.runtimeOptions,
    host: {
      ...fixture.runtimeOptions.host,
      quiesce: async () => {
        events.push("quiesce-start");
        assert.equal(fixture.detachCalls, 1, "the stopped family pump relinquishes its channel before quiescence");
        if (!cleanupSink) return "blocked";
        const acknowledgement = await cleanupSink(metadata, new Uint8Array(bytes));
        assert.deepEqual(acknowledgement, metadata);
        cleanupAcknowledged = true;
        events.push("cleanup-ack");
        return "verified";
      },
      release: async () => { events.push("backend-release"); return "verified"; },
    },
    isolation: {
      ...fixture.runtimeOptions.isolation,
      release: async () => { events.push("isolation-release"); await fixture.runtimeOptions.isolation.release(); },
    },
  });

  await runtime.open(fixture.request);
  const familyPump = fixture.emit({ metadata, bytes: new Uint8Array(bytes), acknowledge: async () => undefined })
    .then(() => "acknowledged" as const, () => { events.push("family-pump-stopped"); return "stopped" as const; });
  await waitUntil(() => fixture.kernel.store.readOutputCheckpoint("stream-1")?.streams[0]?.accepted.length === 1);
  assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1")?.streams[0]?.accepted.length, 1,
    "the protocol frame is durably accepted while family delivery is stopped");

  const cleanupError = await runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 2_000 })
    .then(() => undefined, (error: unknown) => error);
  assert.equal(cleanupSink === undefined && events.includes("cleanup-subscribe"), true,
    "cleanup installs and later removes its evidence-only subscription");
  assert.equal(await familyPump, "stopped");
  assert.equal(cleanupError, undefined);
  assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "released");
  assert.equal(fixture.deliveries, 0, "cleanup replay never reaches family delivery");
  assert.equal(fixture.evidenceWrites, 1, "accepted replay is not written to evidence twice");
  assert.deepEqual(events.filter((event) => event !== "family-pump-stopped"), [
    "cleanup-subscribe",
    "quiesce-start",
    "cleanup-ack",
    "output-settlement",
    "cleanup-unsubscribe",
    "cleanup-detach",
    "backend-release",
    "isolation-release",
  ]);
  const settledCheckpoint = fixture.kernel.store.readOutputCheckpoint("stream-1");
  assert.deepEqual(settledCheckpoint?.streams[0]?.accepted, []);
  assert.deepEqual(settledCheckpoint?.streams[0]?.lastConsumed, metadata);
});

for (const phase of ["adopted", "pre-adoption", "retained-attempt"] as const) for (const accepted of [false, true]) {
  test(`C2 round6 terminal barrier retains exact late bytes ${phase} accepted=${accepted}`, async (t) => {
    const f = await round6Fixture(t, phase === "retained-attempt" ? "adopted" : phase, accepted);
    try {
      if (phase === "retained-attempt") {
        await f.runtime.open(f.fixture.request);
        seedAdoptedCleanup(f.fixture, 1, true);
        const fresh = createStreamingProcessSessionRuntime(f.runtimeOptions);
        f.events.push("quiesce"); // the persisted predecessor fact already proves quiescence
        await fresh.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 2000 });
        assert.equal(f.kernel.store.readBySession("stream-1")!.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[1]!.attempts, 1);
      } else await f.run();
      const record = phase !== "pre-adoption" ? f.kernel.store.readBySession("stream-1") : f.kernel.store.readHostLaunch("launch-1");
      assert.equal(record?.state, "released");
      assert.equal(f.events.includes("ack"), true, "late output must be admitted before terminal success");
      assert.ok(f.events.indexOf("quiesce") < f.events.indexOf("barrier"));
      assert.ok(f.events.indexOf("ack") < f.events.indexOf("release"), "backend release must retain the final frame until its evidence ACK");
      assert.ok(f.events.indexOf("ack") < f.events.indexOf("finalize"));
      assert.ok(f.events.indexOf("ack") < f.events.lastIndexOf("terminal-detach"));
      if (phase === "pre-adoption") assert.equal(f.events.filter((event) => event === "cleanup-0").length, 1, "the original evidence spool retires after the replacement finalizes");
      assert.equal(f.fixture.deliveries, 0);
      const result = await f.spools.at(-1)!.finalize();
      const stdout = result.streams.find((stream) => stream.stream === "stdout")!;
      assert.equal(Buffer.from(stdout.tailBytesBase64, "base64").toString(), "last-frame");
      assert.equal(stdout.totalBytes, 10); assert.equal(stdout.lossyBytes, 0);
      assert.equal(f.kernel.store.readOutputCheckpoint("stream-1"), undefined);
    } finally { await f.close(); }
  });
}

test("C2 round6 caller timeout retains underlying barrier and durable attempt", async (t) => {
  const f = await round6Fixture(t, "adopted");
  let finish!: () => void; let expire!: () => void; let entered = false;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  const expired = new Promise<void>((resolve) => { expire = resolve; });
  try {
    f.controls.waitDeadline = async () => await expired;
    f.controls.barrier = async () => { entered = true; await held; return { status: "settled" }; };
    const first = f.run().catch(() => undefined);
    await waitUntil(() => entered); assert.equal(entered, true);
    f.controls.at = Date.parse(now) + 2000; expire(); await first;
    const before = f.kernel.store.readBySession("stream-1")!.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[1]!;
    assert.equal(before.blocker?.code, "cleanup_deadline_expired"); assert.ok(before.attempt);
    await f.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 5000 }).catch(() => undefined);
    assert.equal(f.events.filter((event) => event === "barrier").length, 1);
    assert.deepEqual(f.kernel.store.readBySession("stream-1")!.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[1], before);
    assert.equal(f.events.includes("finalize"), false); assert.equal(f.events.includes("release"), false);
    finish(); await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.kernel.store.readBySession("stream-1")!.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[1], before);
    assert.equal(f.events.filter((event) => event.endsWith("detach")).length, 1);
  } finally { finish(); expire(); await new Promise((resolve) => setImmediate(resolve)); await f.close(); }
});

test("C2 round6 fresh host cleanup joins a held channel acquisition after caller timeout", async (t) => {
  const f = await round6Fixture(t, "pre-adoption"); let resume!: () => void;
  const held = new Promise<void>((resolve) => { resume = resolve; }); let acquisitions = 0;
  let retry: Promise<unknown> | undefined;
  let fresh: ReturnType<typeof createStreamingProcessSessionRuntime> | undefined;
  try {
    f.controls.missing = true; await f.run(); f.controls.missing = false;
    fresh = createStreamingProcessSessionRuntime({ ...f.runtimeOptions, channel: { ...f.runtimeOptions.channel, reattach: async (binding, fence) => {
      acquisitions++; await held; return await f.runtimeOptions.channel.reattach!(binding, fence);
    } } });
    const first = await fresh.reconcileStartup({ maxRecords: 4, timeoutMs: 10 });
    assert.equal(first.outcomes[0]?.disposition, "blocked"); assert.equal(acquisitions, 1);
    retry = fresh.reconcileStartup({ maxRecords: 4, timeoutMs: 2000 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(acquisitions, 1, "an unresolved exact recovery acquisition cannot be duplicated");
    resume(); await retry;
    await fresh.reconcileStartup({ maxRecords: 4, timeoutMs: 2000 });
    assert.equal(acquisitions, 1);
    assert.equal(f.kernel.store.readHostLaunch("launch-1")?.state, "released", JSON.stringify({ events: f.events, facts: f.kernel.store.readHostLaunch("launch-1")?.effects.find((effect) => effect.kind === "cleanup")?.resources?.map((fact) => ({ resource: fact.resource, status: fact.status, code: fact.failure?.code })) }));
  } finally { resume(); await retry; await fresh?.reconcileStartup({ maxRecords: 4, timeoutMs: 2000 }); await f.close(); }
});

test("C2 round6 late host acquisition cannot install a reader after owner takeover", async (t) => {
  const f = await round6Fixture(t, "pre-adoption"); let resume!: () => void; let acquired = false;
  const held = new Promise<void>((resolve) => { resume = resolve; }); let cleanup: Promise<unknown> | undefined;
  try {
    f.controls.missing = true; await f.run(); f.controls.missing = false;
    const count = f.spools.length;
    const fresh = createStreamingProcessSessionRuntime({ ...f.runtimeOptions, channel: { ...f.runtimeOptions.channel, reattach: async (binding, fence) => {
      acquired = true; await held; return await f.runtimeOptions.channel.reattach!(binding, fence);
    } } });
    cleanup = fresh.reconcileStartup({ maxRecords: 4, timeoutMs: 2000 }).catch(() => undefined);
    await waitUntil(() => acquired); assert.equal(acquired, true);
    f.controls.at = Date.parse(now) + 61_000;
    const before = f.kernel.store.readHostLaunch("launch-1")!;
    const taken = getStreamingSessionKernelWriter(f.kernel).transitionLaunch({ type: "takeover_cleanup", launchId: "launch-1", ownerId: before.ownerId, fencingToken: before.fencingToken, expectedRevision: before.revision,
      newOwnerId: "round6-successor", newFencingToken: 2, ownerExpiresAt: new Date(f.controls.at + 60_000).toISOString(), at: new Date(f.controls.at).toISOString() });
    resume(); await cleanup;
    assert.equal(f.spools.length, count, "a late old-owner acquisition cannot create a replacement output reader");
    assert.equal(f.kernel.store.readHostLaunch("launch-1")!.revision, taken.revision);
    assert.equal(f.events.includes("release"), false);
  } finally { resume(); await cleanup; await f.close(); }
});

async function round6Fixture(t: { diagnostic(message: string): void }, phase: "adopted" | "pre-adoption", accepted = false) {
  const root = await mkdtemp(join(tmpdir(), "c2-round6-terminal-")); t.diagnostic(`created exact fixture root: ${root}`);
  const kernel = openSqliteStreamingSessionStore(join(root, "sessions.sqlite"), Buffer.alloc(32, 36));
  const controls: { at: number; barrier?: (deadlineAt: number) => Promise<import("../src/interactive-process-channel.js").BackpressuredOutputSettlement>; missing?: boolean; waitDeadline?: (deadlineAt: number) => Promise<void> } = { at: Date.parse(now) };
  const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { kernel, clock: () => new Date(controls.at) });
  const artifacts = new ArtifactStore(join(root, "artifacts")); const spools: BoundedOutputSpool[] = [];
  const events: string[] = []; let released = false; let emitted = false;
  const bytes = Buffer.from("last-frame"); const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 10, byteLength: 10, digest: createHash("sha256").update(bytes).digest("hex") };
  const channel = (): import("../src/streaming-process-session-runtime.js").FakeStreamingChannel => {
    let sink: Parameters<import("../src/streaming-process-session-runtime.js").FakeStreamingChannel["subscribeBackpressuredOutput"]>[0] | undefined;
    return {
      subscribeBackpressuredOutput: (next) => { sink = next; return () => { sink = undefined; events.push("unsubscribe"); }; },
      ...(controls.missing ? {} : { settleBackpressuredOutput: async (deadlineAt: number) => {
        events.push("barrier");
        if (controls.barrier) return await controls.barrier(deadlineAt);
        assert.equal(released, false, "terminal settlement must precede physical backend release");
        assert.ok(sink, "terminal settlement retains the reader");
        if (!emitted) {
          emitted = true;
          if (accepted) {
            const checkpoint = kernel.store.readOutputCheckpoint("stream-1")!;
            getStreamingSessionKernelWriter(kernel).applyOutputCheckpoint({ type: "accept", sessionId: "stream-1", ownerId: checkpoint.ownerId, fencingToken: checkpoint.fencingToken, expectedRevision: checkpoint.revision, metadata });
          }
          await sink(metadata, new Uint8Array(bytes)); events.push("ack");
        }
        return { status: "settled" as const };
      } }),
      detach: async () => { sink = undefined; events.push(events.includes("quiesce") ? "terminal-detach" : "initial-detach"); },
    };
  };
  const runtimeOptions: StreamingRuntimeOptions = { ...fixture.runtimeOptions,
    waitUntilDeadline: async (deadlineAt) => { if (controls.waitDeadline) await controls.waitDeadline(deadlineAt); else await new Promise<void>(() => undefined); },
    channel: { ...fixture.runtimeOptions.channel, acquire: async () => channel(), reattach: async (binding) => ({ ...emptyReattachment(binding), channel: channel() }) },
    host: { ...fixture.runtimeOptions.host, quiesce: async () => { events.push("quiesce"); return "verified"; }, release: async () => { released = true; events.push("release"); return "verified"; } },
    handshake: { verify: async () => { if (phase === "pre-adoption") throw new Error("synthetic handshake refusal"); return "b".repeat(64); } },
    output: { ...fixture.runtimeOptions.output, artifacts, createEvidenceSpool: () => {
      const index = spools.length;
      const spool = new BoundedOutputSpool({ spillRoot: join(root, `spool-${spools.length}`), projectRoot: process.cwd(), ownershipId: "round6", artifactStore: artifacts,
        storage: { ...createLinkedTestOutputSpillStorage(), attest: async () => ({ currentPrincipalPrivacy: true, identityStableDeletion: true, unlinkedEntries: false }),
          removeIdentityStable: async (path, identity) => { const entry = await lstat(path); assert.equal(`${entry.dev.toString()}:${entry.ino.toString()}`, identity); await unlink(path); } } }); spools.push(spool);
      return { write: spool.write.bind(spool), cleanup: async () => { events.push(`cleanup-${index}`); await spool.cleanup(); }, finalize: async () => { events.push("finalize"); return await spool.finalize(); } };
    } },
  };
  const runtime = createStreamingProcessSessionRuntime(runtimeOptions);
  return { kernel, fixture, events, controls, spools, runtime, runtimeOptions,
    run: async () => { if (phase === "pre-adoption") await assert.rejects(runtime.open(fixture.request)); else { await runtime.open(fixture.request); await runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 2000 }); } },
    close: async () => { for (const spool of spools) await spool.cleanup(); kernel.store.close(); await rm(root, { recursive: true, force: true }); t.diagnostic(`removed exact fixture root: ${root}`); },
  };
}

for (const phase of ["adopted", "pre-adoption"] as const) for (const fault of ["missing", "blocked", "throw", "accepted-undelivered"] as const) {
  test(`C2 round6 terminal refusal retains reader ${phase} ${fault}`, async (t) => {
    const f = await round6Fixture(t, phase);
    try {
      f.controls.missing = fault === "missing";
      f.controls.barrier = async () => {
        if (fault === "throw") throw new Error("synthetic barrier failure");
        if (fault === "accepted-undelivered") {
          const checkpoint = f.kernel.store.readOutputCheckpoint("stream-1")!;
          getStreamingSessionKernelWriter(f.kernel).applyOutputCheckpoint({ type: "accept", sessionId: "stream-1", ownerId: checkpoint.ownerId, fencingToken: checkpoint.fencingToken, expectedRevision: checkpoint.revision,
            metadata: { stream: "stdout", sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1, digest: createHash("sha256").update("x").digest("hex") } });
          return { status: "settled" };
        }
        return { status: "blocked", reason: "output_unaccounted" };
      };
      await f.run().catch(() => undefined);
      const after = phase === "adopted" ? f.kernel.store.readBySession("stream-1") : f.kernel.store.readHostLaunch("launch-1");
      assert.equal(after?.state, "cleanup_blocked");
      assert.equal(f.events.includes("finalize"), false, "unsettled output cannot finalize evidence");
      assert.equal(f.events.includes("release"), false, "unsettled output cannot release backend retention");
      assert.equal(f.events.filter((event) => event.endsWith("detach")).length, 1, "only the initial reader transfers; the terminal reader remains attached");
      assert.ok(f.kernel.store.readOutputCheckpoint("stream-1"));
      const attempts = f.events.filter((event) => event === "barrier").length;
      if (phase === "adopted") await f.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 3000 }).catch(() => undefined);
      else await f.runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 3000 });
      assert.equal(f.events.filter((event) => event === "barrier").length, attempts, "retry retains the exact failed or blocked terminal operation");
      assert.equal(f.events.includes("finalize"), false);
    } finally { await f.close(); }
  });
}

for (const phase of ["adopted", "pre-adoption"] as const) for (const outcome of ["success", "deadline", "owner"] as const) {
  test(`C2 round6 held barrier joins and fences late result ${phase} ${outcome}`, async (t) => {
    const f = await round6Fixture(t, phase);
    let finish!: () => void; const held = new Promise<void>((resolve) => { finish = resolve; });
    let deadline = 0;
    let first: Promise<unknown> | undefined; let duplicate: Promise<unknown> | undefined;
    try {
      f.controls.barrier = async (deadlineAt) => { deadline = deadlineAt; await held; return { status: "settled" }; };
      first = f.run().catch(() => undefined);
      await waitUntil(() => deadline !== 0); assert.notEqual(deadline, 0);
      duplicate = (phase === "adopted" ? f.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 5000 })
        : f.runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 5000 })).catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(f.events.filter((event) => event === "barrier").length, 1);
      assert.equal(f.events.includes("finalize"), false); assert.equal(f.events.includes("release"), false);
      assert.equal(deadline, Date.parse(now) + (phase === "adopted" ? 2000 : 1000), "nested settlement preserves the original absolute deadline");
      if (outcome === "deadline") f.controls.at = deadline;
      if (outcome === "owner") {
        f.controls.at = Date.parse(now) + 61_000;
        if (phase === "adopted") {
          const before = f.kernel.store.readBySession("stream-1")!;
          getStreamingSessionKernelWriter(f.kernel).takeoverAdoptedWithOutput({ sessionId: "stream-1", ownerId: before.ownerId, fencingToken: before.fencingToken, expectedRevision: before.revision,
            outputExpectedRevision: f.kernel.store.readOutputCheckpoint("stream-1")!.revision, newOwnerId: "round6-successor", newFencingToken: 2,
            leaseExpiresAt: new Date(f.controls.at + 60_000).toISOString(), at: new Date(f.controls.at).toISOString() });
        } else {
          const before = f.kernel.store.readHostLaunch("launch-1")!;
          getStreamingSessionKernelWriter(f.kernel).transitionLaunch({ type: "takeover_cleanup", launchId: "launch-1", ownerId: before.ownerId, fencingToken: before.fencingToken, expectedRevision: before.revision,
            newOwnerId: "round6-successor", newFencingToken: 2, ownerExpiresAt: new Date(f.controls.at + 60_000).toISOString(), at: new Date(f.controls.at).toISOString() });
        }
      }
      const revision = phase === "adopted" ? f.kernel.store.readBySession("stream-1")!.revision : f.kernel.store.readHostLaunch("launch-1")!.revision;
      finish(); await Promise.all([first, duplicate]);
      const after = phase === "adopted" ? f.kernel.store.readBySession("stream-1")! : f.kernel.store.readHostLaunch("launch-1")!;
      assert.equal(f.events.filter((event) => event === "barrier").length, 1);
      if (outcome === "success") assert.equal(after.state, "released");
      else {
        assert.notEqual(after.state, "released");
        assert.equal(f.events.includes("finalize"), false); assert.equal(f.events.includes("release"), false);
        assert.ok(f.kernel.store.readOutputCheckpoint("stream-1"));
        if (outcome === "owner") assert.equal(after.revision, revision, "late predecessor results cannot advance successor progress");
        if (phase === "adopted" && outcome === "deadline") {
          const fact = f.kernel.store.readBySession("stream-1")!.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[1]!;
          assert.equal(fact.blocker?.code, "cleanup_deadline_expired"); assert.equal(fact.attempts, 1); assert.ok(fact.attempt);
        }
      }
    } finally { finish(); await Promise.allSettled([first, duplicate]); await f.close(); }
  });
}

for (const store of ["memory", "sqlite"] as const) for (const state of ["outcome", "finalized", "intent"] as const) test(`C3 repair1 adoption refuses ${state} in ${store}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "c3-adoption-state-")); t.diagnostic(`created exact fixture root: ${root}`);
  const kernel = store === "sqlite" ? openSqliteStreamingSessionStore(join(root, "sessions.sqlite"), Buffer.alloc(32, 33)) : createInMemoryStreamingSessionStore();
  const spool = new BoundedOutputSpool({ spillRoot: join(root, "spool"), projectRoot: process.cwd(), ownershipId: "adoption-state" });
  try {
    const f = await makeFixture(2, "blocked", undefined, [], 4, undefined, undefined, undefined, { kernel }); let prepared = false;
    f.setHandshake(async () => {
      const cp = kernel.store.readOutputCheckpoint("stream-1")!; const writer = getStreamingSessionKernelWriter(kernel);
      if (state === "finalized") {
        await createEvidenceContinuation({ kernel, sessionId: cp.sessionId, ownerId: cp.ownerId, fencingToken: cp.fencingToken,
          artifacts: new ArtifactStore(join(root, "artifacts")), spool }).finalize();
      } else {
        const metadata = { stream: "stdout", sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1, digest: "a".repeat(64) };
        if (state === "intent") writer.applyOutputCheckpoint({ type: "accept", sessionId: cp.sessionId, ownerId: cp.ownerId, fencingToken: cp.fencingToken, expectedRevision: cp.revision, metadata });
        writer.applyOutputCheckpoint({ type: state === "intent" ? "begin_consume" : "mark_outcome_unknown", sessionId: cp.sessionId,
          ownerId: cp.ownerId, fencingToken: cp.fencingToken, expectedRevision: kernel.store.readOutputCheckpoint(cp.sessionId)!.revision, metadata });
      }
      prepared = true; return "b".repeat(64);
    });
    await assert.rejects(f.runtime.open(f.request)); assert.equal(prepared, true);
    assert.equal(kernel.store.readBySession("stream-1"), undefined, "forbidden output state must never be adopted");
    assert.ok(kernel.store.readOutputCheckpoint("stream-1"), "failed adoption retains source authority");
  } finally { await spool.cleanup(); kernel.store.close(); await rm(root, { recursive: true, force: true }); t.diagnostic(`removed exact fixture root: ${root}`); }
});

for (const changed of ["owner", "fence", "outcome"] as const) test(`C3 adoption refuses a checkpoint with changed ${changed}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "c3-adoption-")); t.diagnostic(`created exact fixture root: ${root}`);
  const path = join(root, "sessions.sqlite"); const key = Buffer.alloc(32, 21);
  const kernel = openSqliteStreamingSessionStore(path, key);
  try {
  const f = await makeFixture(2, "blocked", undefined, [], 4, undefined, undefined, undefined, { kernel });
  let mutated = false;
  f.setHandshake(async () => {
    const checkpoint = f.kernel.store.readOutputCheckpoint("stream-1")!;
    const db = new DatabaseSync(path);
    try {
      const json = JSON.stringify({ ...checkpoint, ...(changed === "owner" ? { ownerId: "foreign" } : changed === "fence" ? { fencingToken: 2 } : { outcome: "outcome_unknown" }) });
      db.prepare("UPDATE streaming_output_checkpoints SET record_json = ?, integrity = ? WHERE session_id = ?").run(json, createHmac("sha256", key).update(json).digest("hex"), checkpoint.sessionId);
    } finally { db.close(); }
    mutated = true;
    return "b".repeat(64);
  });
  await assert.rejects(f.runtime.open(f.request));
  assert.equal(mutated, true);
  assert.equal(f.kernel.store.readBySession("stream-1"), undefined);
  } finally { kernel.store.close(); await rm(root, { recursive: true, force: true }); t.diagnostic(`removed exact fixture root: ${root}`); }
});

for (const boundary of ["normal", "retained_attempt", "before_delete", "after_delete", "after_release", "legacy_gap", "live"] as const) test(`C3 fresh SQLite runtime and real spool preserve original plus new evidence bytes ${boundary}`, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "c3-continuation-"));
  t.diagnostic(`created exact fixture root: ${directory}`);
  const path = join(directory, "sessions.sqlite");
  const key = Buffer.alloc(32, 13);
  let kernel = openSqliteStreamingSessionStore(path, key);
  const spools: BoundedOutputSpool[] = [];
  try {
    const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { kernel });
    const newOutput = () => ({ ...fixture.runtimeOptions.output,
      artifacts: new ArtifactStore(join(directory, "artifacts")),
      createEvidenceSpool: () => {
        const spool = new BoundedOutputSpool({ spillRoot: join(directory, `diagnostic-${spools.length}`),
          projectRoot: process.cwd(), ownershipId: "c3-test", tailBytes: 1024, spillBytes: 1024,
          storage: { ...createLinkedTestOutputSpillStorage(),
            attest: async () => ({ currentPrincipalPrivacy: true, identityStableDeletion: true, unlinkedEntries: false }),
            removeIdentityStable: async (path, identity) => {
              const entry = await lstat(path);
              assert.equal(`${entry.dev.toString()}:${entry.ino.toString()}`, identity);
              await unlink(path);
            } },
          artifactStore: new ArtifactStore(join(directory, "artifacts")) });
        spools.push(spool); return spool;
      } });
    const first = createStreamingProcessSessionRuntime({ ...fixture.runtimeOptions, output: { ...newOutput(), ...(boundary === "legacy_gap" ? { artifacts: undefined } : {}) } });
    const facade = await first.open(fixture.request);
    const old = Buffer.from("original");
    const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 8, byteLength: 8,
      digest: createHash("sha256").update(old).digest("hex") };
    const emitted = fixture.emit({ metadata, bytes: old, acknowledge: async () => undefined });
    await facade.waitForOutput(AbortSignal.timeout(2000));
    const operation = { sessionId: "stream-1", operation: "family_delivery" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
    await facade.deliverOutput(facade.authorizeFirstOperation(operation), { ...operation, binding: fixture.request.binding });
    await emitted;
    assert.equal(fixture.deliveries, 1);
    if (boundary === "legacy_gap") await spools[0]!.finalize();
    else if (boundary !== "live") await spools[0]!.cleanup();
    if (boundary !== "live") { kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key); }
    const next = Buffer.from("+new");
    const suffix = { ...metadata, sequence: 2, startOffset: 8, endOffset: 12, byteLength: 4,
      digest: createHash("sha256").update(next).digest("hex") };
    let replay = Promise.resolve();
    let acknowledgements = 0;
    if (boundary === "before_delete" || boundary === "after_delete") {
      const db = new DatabaseSync(path);
      try { db.exec(`CREATE TRIGGER c3_abort ${boundary === "before_delete" ? "BEFORE" : "AFTER"} DELETE ON streaming_output_checkpoints BEGIN SELECT RAISE(ABORT, 'synthetic terminal crash'); END`); }
      finally { db.close(); }
    }
    const interruptedKernel = { store: kernel.store };
    for (const symbol of Object.getOwnPropertySymbols(kernel)) {
      const descriptor = Object.getOwnPropertyDescriptor(kernel, symbol)!;
      const value = descriptor.value as ReturnType<typeof getStreamingSessionKernelWriter>;
      Object.defineProperty(interruptedKernel, symbol, (boundary === "retained_attempt" || boundary === "after_release") && typeof value?.apply === "function"
        ? { ...descriptor, value: { ...value, apply: (command: unknown) => {
          const c = command as { type: string; resource?: string; result?: string };
          if (boundary === "retained_attempt" && c.type === "settle_cleanup_resource" && c.resource === "evidence" && c.result === "verified") {
            return value.apply({ ...c, result: "blocked", evidence: undefined, blocker: { code: "evidence_continuation_unavailable", message: "Durable evidence continuation is unavailable." } });
          }
          const result = value.apply(command);
          if (boundary === "after_release" && c.type === "acknowledge_cleanup") throw new Error("synthetic crash after terminal commit");
          return result;
        } } } : descriptor);
    }
    const reattach = async (binding: StreamingSessionBackendBinding): ReturnType<NonNullable<StreamingRuntimeOptions["channel"]["reattach"]>> => ({
        ...emptyReattachment(binding), retainedWindow: [metadata, suffix], channel: {
          subscribeBackpressuredOutput: (sink) => {
            replay = (async () => { await sink(metadata, old); acknowledgements++; await sink(suffix, next); acknowledgements++; })();
            void replay.catch(() => undefined); return () => undefined;
          }, settleBackpressuredOutput: async () => { await replay; return { status: "settled" as const }; },
          detach: async () => undefined,
        },
      });
    fixture.setReattach(reattach);
    const createFresh = (runtimeKernel = kernel) => createStreamingProcessSessionRuntime({ ...fixture.runtimeOptions, kernel: runtimeKernel,
      sessions: createSessionAuthority({ grants: fixture.grants, sessions: runtimeKernel, clock: () => new Date(now) }),
      output: newOutput(), channel: { ...fixture.runtimeOptions.channel, reattach } });
    let fresh = boundary === "live" ? first : createFresh(interruptedKernel as typeof kernel);
    let outcome = await fresh.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 2000 }).catch((error) => error);
    if (boundary === "before_delete" || boundary === "after_delete" || boundary === "after_release") {
      assert.ok(outcome instanceof Error);
      assert.equal(kernel.store.readBySession("stream-1")!.state, boundary === "after_release" ? "released" : "cleanup_pending");
      assert.equal(Boolean(kernel.store.readOutputCheckpoint("stream-1")), boundary !== "after_release");
      kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key);
      if (boundary !== "after_release") { const db = new DatabaseSync(path); try { db.exec("DROP TRIGGER c3_abort"); } finally { db.close(); } }
      fresh = createFresh(); outcome = await fresh.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 2000 }).catch((error) => error);
    }
    if (boundary === "retained_attempt") {
      const before = kernel.store.readBySession("stream-1")!.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[2]!;
      assert.equal(before.blocker?.code, "evidence_continuation_unavailable"); assert.ok(before.attempt);
      const finalized = kernel.store.readOutputCheckpoint("stream-1")!.continuation!.finalized;
      assert.ok(finalized);
      kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key);
      fresh = createFresh();
      outcome = await fresh.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 2000 }).catch((error) => error);
      const after = kernel.store.readBySession("stream-1")!.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[2]!;
      assert.equal(after.status, "verified", String(outcome)); assert.equal(after.attempts, before.attempts);
      assert.equal(after.evidence?.digest, finalized.manifestHash);
    }
    assert.equal(kernel.store.readBySession("stream-1")!.state, "released", String(outcome));
    assert.equal(kernel.store.readOutputCheckpoint("stream-1"), undefined, "final manifest ownership transfers before active checkpoint capacity is reclaimed");
    assert.equal(acknowledgements, boundary === "retained_attempt" ? 4 : 2);
    assert.equal(fixture.deliveries, 1, "already consumed replay never redelivers to the family");
    const finalized = await spools.at(-1)!.finalize();
    const stdout = finalized.streams.find((stream) => stream.stream === "stdout")!;
    assert.equal(Buffer.from(stdout.tailBytesBase64, "base64").toString(), boundary === "legacy_gap" ? "+new" : "original+new");
    assert.equal(stdout.totalBytes, boundary === "legacy_gap" ? 4 : 12);
    assert.equal(stdout.lossyBytes, 0);
    kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key);
    const reference = kernel.store.readBySession("stream-1")!.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[2]!.evidence!;
    assert.equal(reference.kind, "bounded_output_manifest");
    const artifacts = new ArtifactStore(join(directory, "artifacts"));
    const manifest = JSON.parse((await artifacts.get(reference.digest)).toString()) as { previousHash: string; resultHash: string };
    if (boundary === "legacy_gap") {
      const result = JSON.parse((await artifacts.get(manifest.resultHash)).toString()) as BoundedOutputSpoolResult;
      assert.equal(result.streams[0]!.totalBytes, 12); assert.equal(result.streams[0]!.lossyBytes, 8);
    }
    const guard = new ArtifactReachabilityGuard(directory, artifacts);
    await guard.runQuiescent(async () => {
      await guard.prepareReachabilityIndex();
      for (const hash of [reference.digest, manifest.previousHash, manifest.resultHash, metadata.digest, suffix.digest]) {
        assert.equal(await guard.removeIfGloballyUnreachable(hash), false, "released record retains transitive evidence artifacts");
        await artifacts.verify(hash);
      }
    });
  } finally {
    for (const spool of spools) await spool.cleanup();
    kernel.store.close();
    await rm(directory, { recursive: true, force: true });
    t.diagnostic(`removed exact fixture root: ${directory}`);
  }
});

for (const boundary of ["normal", "before_delete", "after_delete"] as const) test(`C3 pre-adoption failure transfers final evidence to authenticated host fact and reclaims checkpoint ${boundary}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "c3-host-evidence-")); t.diagnostic(`created exact fixture root: ${root}`);
  const path = join(root, "sessions.sqlite"); const key = Buffer.alloc(32, 15);
  let kernel = openSqliteStreamingSessionStore(path, key); const artifacts = new ArtifactStore(join(root, "artifacts"));
  const spools: BoundedOutputSpool[] = [];
  try {
    const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { kernel });
    const bytes = Buffer.from("handshake"); const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 9, byteLength: 9, digest: createHash("sha256").update(bytes).digest("hex") };
    if (boundary !== "normal") { const db = new DatabaseSync(path); try { db.exec(`CREATE TRIGGER c3_abort ${boundary === "before_delete" ? "BEFORE" : "AFTER"} DELETE ON streaming_output_checkpoints BEGIN SELECT RAISE(ABORT, 'synthetic host terminal crash'); END`); } finally { db.close(); } }
    const runtimeOptions = { ...fixture.runtimeOptions,
      output: { ...fixture.runtimeOptions.output, artifacts, createEvidenceSpool: () => {
        const spool = new BoundedOutputSpool({ spillRoot: join(root, "spool"), projectRoot: process.cwd(), ownershipId: "host-fixture", artifactStore: artifacts });
        spools.push(spool); return spool;
      } },
      handshake: { verify: async (_channel, control) => {
        const emitted = fixture.emit({ metadata, bytes, acknowledge: async () => undefined });
        await control.waitForOutput(AbortSignal.timeout(2000));
        await control.deliverOutput(async (_stream, input) => { assert.deepEqual(Buffer.from(input), bytes); });
        await emitted; throw new Error("synthetic failed handshake");
      } },
    } satisfies StreamingRuntimeOptions;
    let runtime = createStreamingProcessSessionRuntime(runtimeOptions);
    await assert.rejects(runtime.open(fixture.request));
    if (boundary !== "normal") {
      assert.notEqual(kernel.store.readHostLaunch("launch-1")!.state, "released"); assert.ok(kernel.store.readOutputCheckpoint("stream-1")?.continuation?.finalized);
      kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key);
      const db = new DatabaseSync(path); try { db.exec("DROP TRIGGER c3_abort"); } finally { db.close(); }
      runtime = createStreamingProcessSessionRuntime({ ...runtimeOptions, kernel,
        sessions: createSessionAuthority({ grants: fixture.grants, sessions: kernel, clock: () => new Date(now) }) });
      await runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 2000 });
    }
    assert.equal(kernel.store.readBySession("stream-1"), undefined); assert.equal(fixture.deliveries, 0);
    assert.equal(kernel.store.readOutputCheckpoint("stream-1"), undefined);
    kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key);
    const host = kernel.store.readHostLaunch("launch-1")!; assert.equal(host.state, "released");
    const reference = host.effects.find((effect) => effect.kind === "cleanup")!.resources!.find((fact) => fact.resource === "output_checkpoint")!.evidence!;
    assert.equal(reference.kind, "bounded_output_manifest"); await artifacts.verify(reference.digest);
    const guard = new ArtifactReachabilityGuard(root, artifacts);
    await guard.runQuiescent(async () => { await guard.prepareReachabilityIndex(); assert.equal(await guard.removeIfGloballyUnreachable(metadata.digest), false); });
    getStreamingSessionKernelWriter(kernel).deleteOutputCheckpoint({ sessionId: "stream-1", launchId: "launch-1", evidence: reference });
    assert.throws(() => getStreamingSessionKernelWriter(kernel).deleteOutputCheckpoint({ sessionId: "stream-1", launchId: "launch-1", evidence: { ...reference, digest: "a".repeat(64) } }));
  } finally { for (const spool of spools) await spool.cleanup(); kernel.store.close(); await rm(root, { recursive: true, force: true }); t.diagnostic(`removed exact fixture root: ${root}`); }
});

for (const store of ["memory", "sqlite"] as const) test(`C3 direct adopted checkpoint deletion waits for terminal channel settlement in ${store}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "c3-direct-delete-")); t.diagnostic(`created exact fixture root: ${root}`);
  const kernel = store === "sqlite" ? openSqliteStreamingSessionStore(join(root, "sessions.sqlite"), Buffer.alloc(32, 27)) : createInMemoryStreamingSessionStore();
  const spools: BoundedOutputSpool[] = [];
  try {
    const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { kernel });
    const observing = { store: kernel.store }; let attempted = false; let refused = false;
    for (const symbol of Object.getOwnPropertySymbols(kernel)) {
      const descriptor = Object.getOwnPropertyDescriptor(kernel, symbol)!; const writer = descriptor.value as ReturnType<typeof getStreamingSessionKernelWriter>;
      Object.defineProperty(observing, symbol, typeof writer?.apply === "function" ? { ...descriptor, value: { ...writer,
        apply: (command: unknown) => {
          const record = writer.apply(command); const c = command as { type: string; resource?: string; result?: string };
          if (c.type === "settle_cleanup_resource" && c.resource === "evidence" && c.result === "verified") {
            attempted = true; const cp = kernel.store.readOutputCheckpoint("stream-1")!;
            const evidence = record.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[2]!.evidence;
            try { getStreamingSessionKernelWriter(kernel).deleteOutputCheckpoint({ sessionId: cp.sessionId, ownerId: cp.ownerId, fencingToken: cp.fencingToken, expectedRevision: cp.revision, evidence }); }
            catch { refused = true; }
          }
          return record;
        },
      } } : descriptor);
    }
    const runtime = createStreamingProcessSessionRuntime({ ...fixture.runtimeOptions, kernel: observing as typeof kernel,
      output: { ...fixture.runtimeOptions.output, artifacts: new ArtifactStore(join(root, "artifacts")), createEvidenceSpool: () => {
        const spool = new BoundedOutputSpool({ spillRoot: join(root, `spool-${spools.length}`), projectRoot: process.cwd(), ownershipId: "delete-fixture" });
        spools.push(spool); return spool;
      } } });
    await runtime.open(fixture.request);
    await runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 2000 }).catch(() => undefined);
    assert.equal(attempted, true); assert.equal(refused, true, "verified evidence alone must not retire the last channel reader's checkpoint");
    assert.equal(kernel.store.readBySession("stream-1")!.state, "released"); assert.equal(kernel.store.readOutputCheckpoint("stream-1"), undefined);
  } finally { for (const spool of spools) await spool.cleanup(); kernel.store.close(); await rm(root, { recursive: true, force: true }); t.diagnostic(`removed exact fixture root: ${root}`); }
});

for (const boundary of ["consumed_replay", "unaccepted_suffix", "accepted_suffix", "accepted_during_reattach", "late_suffix", "corrupt_replay", "missing_barrier", "barrier_blocked", "deadline_before_barrier", "deadline_after_barrier"] as const) {
  test(`round5 post-evidence restart handles ${boundary} without refinalization`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cleanup-evidence-replay-"));
    const path = join(directory, "sessions.sqlite");
    const key = Buffer.alloc(32, 8);
    let kernel = openSqliteStreamingSessionStore(path, key);
    let current = new Date(now);
    const crashingKernel = { store: kernel.store };
    for (const symbol of Object.getOwnPropertySymbols(kernel)) {
      const descriptor = Object.getOwnPropertyDescriptor(kernel, symbol)!;
      const value = descriptor.value as ReturnType<typeof getStreamingSessionKernelWriter>;
      Object.defineProperty(crashingKernel, symbol, typeof value?.apply === "function"
        ? { ...descriptor, value: { ...value, apply: (command: Parameters<typeof value.apply>[0]) => {
          const record = value.apply(command);
          const event = command as { type: string; resource?: string; result?: string };
          if (event.type === "settle_cleanup_resource" && event.resource === "evidence" && event.result === "verified") {
            throw new Error("simulated crash after authenticated evidence commit");
          }
          return record;
        } } } : descriptor);
    }
    const bytes = Buffer.from([0]);
    const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1,
      digest: createHash("sha256").update(bytes).digest("hex") };
    const suffix = { ...metadata, sequence: 2, startOffset: 1, endOffset: 2 };
    const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined,
      { kernel: crashingKernel as typeof kernel, clock: () => current });
    let initialSinkReturned = false;
    let initialOutput = Promise.resolve();
    fixture.setReattach(async (binding) => ({ ...emptyReattachment(binding), retainedWindow: [metadata], channel: {
      subscribeBackpressuredOutput: (sink) => {
        initialOutput = sink(metadata, bytes).then(() => { initialSinkReturned = true; });
        return () => undefined;
      }, settleBackpressuredOutput: async () => { await initialOutput; return { status: "settled" }; }, detach: async () => undefined,
    } }));
    await fixture.runtime.open(fixture.request);
    await assert.rejects(fixture.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 500 }));
    assert.equal(initialSinkReturned, true, "crash is after the cleanup sink returns but before channel ACK publication");
    assert.equal(fixture.evidenceWrites, 1);
    assert.equal(fixture.finalizeCalls, 1);
    const proven = kernel.store.readBySession("stream-1")!.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources;
    assert.equal(proven[2]!.status, "verified");
    assert.equal(proven[3]!.status, "pending");
    kernel.store.close();
    kernel = openSqliteStreamingSessionStore(path, key);
    if (boundary === "accepted_suffix") {
      const checkpoint = kernel.store.readOutputCheckpoint("stream-1")!;
      getStreamingSessionKernelWriter(kernel).applyOutputCheckpoint({ type: "accept", sessionId: "stream-1",
        ownerId: checkpoint.ownerId, fencingToken: checkpoint.fencingToken, expectedRevision: checkpoint.revision, metadata: suffix });
    }
    let acknowledgements = 0;
    let detaches = 0;
    let backendReleases = 0;
    let spools = 0;
    let barriers = 0;
    let delivery: Promise<unknown> = Promise.resolve();
    const refused: unknown[] = [];
    const runtime = createStreamingProcessSessionRuntime({ ...fixture.runtimeOptions, kernel,
      sessions: createSessionAuthority({ grants: fixture.grants, sessions: kernel, clock: () => current }),
      output: { ...fixture.runtimeOptions.output, createEvidenceSpool: () => { spools++; throw new Error("restart must not open evidence"); } },
      host: { ...fixture.runtimeOptions.host, release: async () => { backendReleases++; return "verified"; } },
      channel: { ...fixture.runtimeOptions.channel, reattach: async (binding) => {
        if (boundary === "deadline_before_barrier") current = new Date(Date.parse(now) + 500);
        if (boundary === "accepted_during_reattach") {
          const checkpoint = kernel.store.readOutputCheckpoint("stream-1")!;
          getStreamingSessionKernelWriter(kernel).applyOutputCheckpoint({ type: "accept", sessionId: "stream-1",
            ownerId: checkpoint.ownerId, fencingToken: checkpoint.fencingToken, expectedRevision: checkpoint.revision, metadata: suffix });
        }
        return { ...emptyReattachment(binding),
        retainedWindow: ["unaccepted_suffix", "accepted_suffix", "accepted_during_reattach"].includes(boundary) ? [metadata, suffix] : [metadata],
        channel: {
          subscribeBackpressuredOutput: (sink) => {
            delivery = (async () => {
              try {
                await sink(metadata, boundary === "corrupt_replay" ? Buffer.from([1]) : bytes);
                acknowledgements++;
                if (boundary === "late_suffix") { await sink(suffix, bytes); acknowledgements++; }
              } catch (error) { refused.push(error); }
            })();
            return () => undefined;
          },
          ...(boundary === "missing_barrier" ? {} : { settleBackpressuredOutput: async () => {
            barriers++;
            await delivery;
            if (boundary === "deadline_after_barrier") current = new Date(Date.parse(now) + 500);
            return refused.length || boundary === "barrier_blocked" ? { status: "blocked" as const, reason: "output_unaccounted" as const } : { status: "settled" as const };
          } }),
          detach: async () => { detaches++; },
        },
      }; } },
    });
    try {
      const outcome = await runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 500 }).catch((error) => error);
      const after = kernel.store.readBySession("stream-1")!;
      const facts = after.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources;
      assert.deepEqual(facts.slice(0, 3), proven.slice(0, 3));
      assert.equal(spools, 0);
      assert.equal(fixture.finalizeCalls, 1);
      assert.equal(fixture.deliveries, 0);
      if (boundary === "consumed_replay") {
        assert.equal(acknowledgements, 1, "exact consumed/evidenced replay must receive one safe channel ACK");
        assert.equal(after.state, "released");
        assert.equal(detaches, 1);
        assert.equal(backendReleases, 1);
      } else {
        assert.ok(outcome instanceof Error);
        assert.equal(after.state, "cleanup_blocked");
        assert.equal(facts[3]!.status, "blocked");
        assert.equal(acknowledgements, ["late_suffix", "barrier_blocked", "deadline_after_barrier"].includes(boundary) ? 1 : 0);
        if (boundary === "deadline_before_barrier") assert.equal(barriers, 0, "an exhausted nested call must not start channel settlement");
        assert.equal(detaches, 0, "unproved retained data must keep its exact channel attached");
        assert.equal(backendReleases, 0);
      }
    } finally {
      kernel.store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const entry of ["direct", "startup"] as const) {
  for (const [leaseRemainingMs, timeoutMs] of [[25_000, 30_000], [30_000, 30_000], [60_000, 90_000]]) {
    test(`round5 ${entry} cleanup covers a ${timeoutMs}ms deadline with ${leaseRemainingMs}ms lease remaining`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "cleanup-horizon-"));
      const path = join(directory, "sessions.sqlite");
      const key = Buffer.alloc(32, 5);
      let kernel = openSqliteStreamingSessionStore(path, key);
      let current = new Date(now);
      const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined,
        { kernel, clock: () => current });
      await fixture.runtime.open(fixture.request);
      if (entry === "startup") seedAdoptedCleanup(fixture, 0);
      kernel.store.close();
      kernel = openSqliteStreamingSessionStore(path, key);
      current = new Date(Date.parse(now) + 60_000 - leaseRemainingMs);
      const deadline = current.getTime() + timeoutMs!;
      let expire!: () => void;
      let finish!: () => void;
      const held = new Promise<void>((resolve) => { finish = resolve; });
      const effects: Array<{ deadlineAt: number; leaseExpiresAt: number }> = [];
      const runtime = createStreamingProcessSessionRuntime({ ...fixture.runtimeOptions, kernel,
        sessions: createSessionAuthority({ grants: fixture.grants, sessions: kernel, clock: () => current }),
        waitUntilDeadline: async () => await new Promise<void>((resolve) => { expire = resolve; }),
        host: { ...fixture.runtimeOptions.host, quiesce: async ({ deadlineAt }) => {
          effects.push({ deadlineAt, leaseExpiresAt: Date.parse(kernel.store.readBySession("stream-1")!.leaseExpiresAt) });
          await held;
          return "verified";
        } } });
      try {
        const call = entry === "direct"
          ? runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: timeoutMs! })
          : runtime.reconcileStartup({ maxRecords: 4, timeoutMs: timeoutMs! });
        let completed = false;
        const outcome = call.catch((error) => error).finally(() => { completed = true; });
        await waitUntil(() => effects.length === 1 || completed);
        current = new Date(deadline);
        expire();
        await outcome;
        const after = kernel.store.readBySession("stream-1")!;
        const fact = after.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[0]!;
        assert.equal(after.state, "cleanup_blocked", "the exact deadline must be durably categorized while the lease is valid");
        assert.equal(fact.blocker?.code, "cleanup_deadline_expired");
        assert.equal(effects.length, 1, "the original budget must be admitted without rebasing or dropping its effect");
        assert.equal(effects[0]!.deadlineAt, deadline);
        assert.ok(effects[0]!.leaseExpiresAt > deadline, "ownership must strictly cover the cleanup boundary");
        assert.ok(effects[0]!.leaseExpiresAt <= deadline + 60_000, "settlement reserve must be bounded");
        finish();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(kernel.store.readBySession("stream-1")!.revision, after.revision);
      } finally {
        finish();
        await new Promise((resolve) => setImmediate(resolve));
        kernel.store.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}

for (const state of ["active", "stopping", "input_unavailable", "backend_unavailable", "outcome_unknown", "cleanup_pending", "cleanup_blocked"] as const) {
  test(`round5 fresh SQLite runtime gives adopted ${state} one disposition and never relaunches`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cleanup-state-matrix-"));
    const path = join(directory, "sessions.sqlite");
    const key = Buffer.alloc(32, 7);
    let kernel = openSqliteStreamingSessionStore(path, key);
    const fixture = await makeFixture(2, "blocked", undefined, [], 4, undefined, undefined, undefined, { kernel });
    await fixture.runtime.open(fixture.request);
    const initial = kernel.store.readBySession("stream-1")!;
    if (state === "cleanup_pending") seedAdoptedCleanup(fixture, 0);
    else if (state === "cleanup_blocked") await fixture.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 100 }).catch(() => undefined);
    else if (state === "stopping") fixture.kernelWriter.apply({ type: "begin_stopping", sessionId: initial.sessionId,
      ownerId: initial.ownerId, fencingToken: initial.fencingToken, expectedRevision: initial.revision, at: now });
    else if (state !== "active") fixture.authority.recordDisposition({ sessionId: initial.sessionId,
      ownerId: initial.ownerId, fencingToken: initial.fencingToken, expectedRevision: initial.revision, disposition: state });
    assert.equal(kernel.store.readBySession("stream-1")!.state, state);
    kernel.store.close();
    kernel = openSqliteStreamingSessionStore(path, key);
    const runtime = createStreamingProcessSessionRuntime({ ...fixture.runtimeOptions, kernel,
      sessions: createSessionAuthority({ grants: fixture.grants, sessions: kernel, clock: () => new Date(now) }) });
    const launches = fixture.launchCalls;
    try {
      const recovery = await runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 100 });
      assert.deepEqual(recovery.sessionOutcomes, state === "active"
        ? [{ sessionId: "stream-1", disposition: "reattached" }]
        : [{ sessionId: "stream-1", disposition: "cleanup_blocked", cleanupBlocked: true }]);
      assert.equal(kernel.store.readBySession("stream-1")!.state, state === "active" ? "active" : "cleanup_blocked");
      await assert.rejects(runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 100 }));
      assert.equal(kernel.store.readBySession("stream-1")!.state, "cleanup_blocked");
      assert.equal(fixture.launchCalls, launches);
      assert.equal(fixture.deliveries, 0);
    } finally {
      kernel.store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

function seedAdoptedCleanup(fixture: Awaited<ReturnType<typeof makeFixture>>, verifiedCount: number, intent = false) {
  const writer = getStreamingSessionStoreWriter(fixture.kernel);
  let record = fixture.kernel.store.readBySession("stream-1")!;
  record = writer.apply({ type: "begin_cleanup", sessionId: record.sessionId, ownerId: record.ownerId,
    fencingToken: record.fencingToken, expectedRevision: record.revision, effectId: "cleanup:stream-1:1", at: now });
  for (let index = 0; index < verifiedCount + Number(intent); index++) {
    const resource = adoptedResources[index]!;
    record = writer.apply({ type: "begin_cleanup_resource", sessionId: record.sessionId, ownerId: record.ownerId,
      fencingToken: record.fencingToken, expectedRevision: record.revision, effectId: "cleanup:stream-1:1", resource,
      startedAt: now, deadlineAt: "2026-08-30T00:00:30.000Z", at: now });
    if (index === verifiedCount) break;
    const attempt = record.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[index]!.attempt!;
    record = writer.apply({ type: "settle_cleanup_resource", sessionId: record.sessionId, ownerId: record.ownerId,
      fencingToken: record.fencingToken, expectedRevision: record.revision, effectId: "cleanup:stream-1:1", resource,
      attemptId: attempt.attemptId, attemptOwnerId: attempt.ownerId, attemptFencingToken: attempt.fencingToken,
      result: "verified", ...(resource === "evidence" ? { evidence: {
        kind: "same_runtime_finalization", digest: "e".repeat(64), lossy: false,
      } } : {}), at: now });
  }
  return record;
}

for (const resource of ["workload_quiescence", "isolation_release"] as const) {
  test(`round4 completion at the exact deadline blocks ${resource} even before its watcher runs`, async () => {
    let current = new Date(now);
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { clock: () => current });
    const runtime = createStreamingProcessSessionRuntime({
      ...fixture.runtimeOptions,
      waitUntilDeadline: async () => await new Promise<void>(() => undefined),
      host: { ...fixture.runtimeOptions.host, quiesce: async () => { await held; return "verified"; } },
      isolation: { ...fixture.runtimeOptions.isolation, release: async () => { await held; } },
    });
    await runtime.open(fixture.request);
    if (resource === "isolation_release") seedAdoptedCleanup(fixture, 5);
    const stopping = runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 20 });
    await waitUntil(() => fixture.kernel.store.readBySession("stream-1")!.effects.find((effect) => effect.kind === "cleanup")
      ?.progress?.resources.find((fact) => fact.resource === resource)?.status === "in_flight");
    current = new Date(Date.parse(now) + 20);
    finish();
    await stopping.catch(() => undefined);
    const after = fixture.kernel.store.readBySession("stream-1")!;
    const fact = after.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources.find((entry) => entry.resource === resource)!;
    assert.equal(after.state, "cleanup_blocked");
    assert.equal(fact.status, "blocked");
    assert.equal(fact.blocker?.code, "cleanup_deadline_expired");
    assert.ok(fact.attempt, "late completion must retain the exact issued operation");
  });
}

test("round4 deadline between verified facts durably blocks the first unissued resource", async () => {
  let current = new Date(now);
  let armBoundary = false;
  const semanticClock = () => {
    if (armBoundary && fixture.kernel.store.readBySession("stream-1")?.effects.find((effect) => effect.kind === "cleanup")
      ?.progress?.resources[0]?.status === "verified") current = new Date(Date.parse(now) + 20);
    return current;
  };
  const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { clock: semanticClock });
  const reattachments: Array<{ at: number; workload: string | undefined; quiesces: number }> = [];
  let outputSettlements = 0;
  const runtime = createStreamingProcessSessionRuntime({ ...fixture.runtimeOptions,
    channel: { ...fixture.runtimeOptions.channel, reattach: async (binding) => {
      reattachments.push({ at: semanticClock().getTime(), workload: fixture.kernel.store.readBySession("stream-1")?.effects
        .find((effect) => effect.kind === "cleanup")?.progress?.resources[0]?.status,
        quiesces: fixture.calls.filter((call) => call === "reconcile").length });
      const recovered = await fixture.runtimeOptions.channel.reattach(binding);
      return { ...recovered, channel: { ...recovered.channel, settleBackpressuredOutput: async (deadlineAt) => {
        outputSettlements++; return recovered.channel.settleBackpressuredOutput!(deadlineAt);
      } } };
    } },
    waitUntilDeadline: async () => await new Promise<void>(() => undefined) });
  await runtime.open(fixture.request);
  armBoundary = true;
  await assert.rejects(runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 20 }));
  const after = fixture.kernel.store.readBySession("stream-1")!;
  const facts = after.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources;
  assert.equal(after.state, "cleanup_blocked");
  assert.equal(facts[0]!.status, "verified");
  assert.equal(facts[1]!.blocker?.code, "cleanup_deadline_before_effect");
  assert.equal(facts[1]!.attempts, 0);
  assert.equal(facts[1]!.attempt, undefined);
  assert.equal(fixture.reattachCalls, 1, "cleanup takes output ownership before workload quiescence");
  assert.deepEqual(reattachments, [{ at: Date.parse(now), workload: "in_flight", quiesces: 0 }],
    "the only reattachment occurred before quiescence and before the deadline");
  assert.equal(outputSettlements, 0, "the next resource has no effect at the expired deadline");
  armBoundary = false;
  await runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 100 });
  assert.equal(fixture.kernel.store.readBySession("stream-1")!.state, "released");
  assert.equal(fixture.calls.filter((call) => call === "reconcile").length, 1);
});

test("round4 stale deadline watcher cannot borrow the successor fence", async () => {
  let current = new Date(now);
  let finish!: () => void;
  let expire!: () => void;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { clock: () => current });
  const runtime = createStreamingProcessSessionRuntime({ ...fixture.runtimeOptions,
    waitUntilDeadline: async () => await new Promise<void>((resolve) => { expire = resolve; }),
    host: { ...fixture.runtimeOptions.host, quiesce: async () => { await held; return "verified"; } } });
  await runtime.open(fixture.request);
  const stopping = runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 20 });
  const observedFailure = stopping.catch(() => undefined);
  await waitUntil(() => Boolean(expire));
  current = new Date("2026-08-30T00:01:01.000Z");
  const before = fixture.kernel.store.readBySession("stream-1")!;
  fixture.kernelWriter.takeoverAdoptedWithOutput({ sessionId: "stream-1", ownerId: before.ownerId,
    fencingToken: before.fencingToken, expectedRevision: before.revision,
    outputExpectedRevision: fixture.kernel.store.readOutputCheckpoint("stream-1")!.revision,
    newOwnerId: "successor", newFencingToken: 2, leaseExpiresAt: "2026-08-30T00:02:01.000Z", at: current.toISOString() });
  const taken = fixture.kernel.store.readBySession("stream-1")!;
  expire();
  await observedFailure;
  assert.equal(fixture.kernel.store.readBySession("stream-1")!.revision, taken.revision);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.kernel.store.readBySession("stream-1")!.revision, taken.revision);
});

test("round4 current owner observes a held predecessor after takeover without joining stale work", async () => {
  let current = new Date(now);
  let finish!: () => void;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  let signals = 0;
  const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { clock: () => current });
  const runtime = createStreamingProcessSessionRuntime({ ...fixture.runtimeOptions,
    waitUntilDeadline: async () => await new Promise<void>(() => undefined),
    host: { ...fixture.runtimeOptions.host, quiesce: async () => { signals++; await held; return "verified"; } } });
  await runtime.open(fixture.request);
  const oldRun = runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 20 }).catch(() => undefined);
  await waitUntil(() => signals === 1);
  current = new Date("2026-08-30T00:01:01.000Z");
  const before = fixture.kernel.store.readBySession("stream-1")!;
  fixture.kernelWriter.takeoverAdoptedWithOutput({ sessionId: "stream-1", ownerId: before.ownerId,
    fencingToken: before.fencingToken, expectedRevision: before.revision,
    outputExpectedRevision: fixture.kernel.store.readOutputCheckpoint("stream-1")!.revision,
    newOwnerId: "successor", newFencingToken: 2, leaseExpiresAt: "2026-08-30T00:02:01.000Z", at: current.toISOString() });
  const currentRun = runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 100 });
  const currentOutcome = currentRun.catch((error) => error);
  await waitUntil(() => fixture.observeQuiescenceCalls === 1);
  assert.equal(fixture.observeQuiescenceCalls, 1, "new owner must observe while old effect remains held");
  assert.deepEqual(fixture.observedQuiescenceFences, [{ ownerId: "successor", fencingToken: 3 }]);
  await currentOutcome;
  assert.equal(fixture.kernel.store.readBySession("stream-1")!.state, "released");
  const released = fixture.kernel.store.readBySession("stream-1")!;
  finish();
  await oldRun;
  assert.equal(fixture.kernel.store.readBySession("stream-1")!.revision, released.revision);
  assert.equal(signals, 1);
});

for (let verifiedCount = 1; verifiedCount <= 6; verifiedCount++) {
  test(`round4 fresh runtime resumes after verified ${adoptedResources[verifiedCount - 1]}`, async () => {
    const fixture = await makeFixture(2, "cleaned");
    await fixture.runtime.open(fixture.request);
    const seeded = seedAdoptedCleanup(fixture, verifiedCount);
    let backendReleases = 0;
    const runtime = createStreamingProcessSessionRuntime({ ...fixture.runtimeOptions,
      host: { ...fixture.runtimeOptions.host, release: async () => { backendReleases++; return "verified"; } } });
    const outcome = await runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 100 }).catch((error) => error);
    const after = fixture.kernel.store.readBySession("stream-1")!;
    const facts = after.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources;
    const beforeFacts = seeded.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources;
    assert.deepEqual(facts.slice(0, verifiedCount), beforeFacts.slice(0, verifiedCount), "verified facts cannot replay or change provenance");
    assert.equal(fixture.calls.filter((call) => call === "reconcile").length, 0);
    assert.equal(fixture.deliveries, 0);
    if (verifiedCount < 3) {
      assert.ok(outcome instanceof Error);
      assert.equal(facts[2]!.blocker?.code, "evidence_continuation_unavailable");
    } else {
      assert.equal(after.state, "released");
      assert.equal(fixture.finalizeCalls, 0, "restart must never refinalize verified evidence");
      assert.equal(fixture.reattachCalls, verifiedCount === 3 ? 1 : 0);
      assert.equal(fixture.detachCalls, verifiedCount === 3 ? 1 : 0);
      assert.equal(backendReleases, verifiedCount < 5 ? 1 : 0);
      assert.equal(fixture.releaseCalls, verifiedCount < 6 ? 1 : 0);
    }
  });
}

test("round4 failed one-shot evidence finalization rejects retry without changing progress", async () => {
  const fixture = await makeFixture(2, "cleaned");
  let finalizes = 0;
  fixture.setEvidenceSpool(() => ({ write: async () => undefined,
    finalize: async () => { finalizes++; throw new Error("no durable finalization"); }, cleanup: async () => undefined }));
  await fixture.runtime.open(fixture.request);
  await assert.rejects(fixture.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 100 }));
  const before = fixture.kernel.store.readBySession("stream-1")!;
  await assert.rejects(fixture.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 100 }));
  assert.equal(fixture.kernel.store.readBySession("stream-1")!.revision, before.revision);
  assert.equal(finalizes, 1);
});

for (let index = 0; index < adoptedResources.length; index++) {
  test(`round4 restart after intent ${adoptedResources[index]} observes or blocks without replay`, async () => {
    const fixture = await makeFixture(2, "cleaned");
    await fixture.runtime.open(fixture.request);
    const seeded = seedAdoptedCleanup(fixture, index, true);
    let effects = 0;
    const forbiddenEffect = async (): Promise<"verified"> => { effects++; return "verified"; };
    const runtime = createStreamingProcessSessionRuntime({ ...fixture.runtimeOptions,
      host: { ...fixture.runtimeOptions.host, quiesce: forbiddenEffect, release: forbiddenEffect },
      isolation: { ...fixture.runtimeOptions.isolation, release: async () => { effects++; } } });
    await assert.rejects(runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 100 }));
    const after = fixture.kernel.store.readBySession("stream-1")!;
    const facts = after.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources;
    const priorFacts = seeded.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources;
    assert.deepEqual(facts.slice(0, index), priorFacts.slice(0, index));
    assert.equal(effects, 0);
    assert.equal(fixture.deliveries, 0);
    if (index <= 1) {
      assert.equal(fixture.observeQuiescenceCalls, index === 0 ? 1 : 0);
      assert.equal(facts[index]!.status, "verified");
      assert.equal(fixture.reattachCalls, 1);
      assert.equal(facts[2]!.blocker?.code, "evidence_continuation_unavailable");
    } else {
      assert.equal(fixture.reattachCalls, 0);
      assert.equal(fixture.detachCalls, 0);
      assert.equal(fixture.finalizeCalls, 0);
      assert.equal(facts[index]!.blocker?.code, index === 2 ? "evidence_continuation_unavailable"
        : index === 4 ? "backend_release_reconciliation_required" : "cleanup_effect_outcome_unknown");
      assert.deepEqual(facts[index]!.attempt, priorFacts[index]!.attempt);
      const blockedRevision = after.revision;
      await assert.rejects(runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 100 }));
      assert.equal(fixture.kernel.store.readBySession("stream-1")!.revision, blockedRevision);
    }
  });
}

test("round4 nested channel preparation consumes the same deadline before quiescence", async () => {
  let current = new Date(now);
  const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { clock: () => current });
  await fixture.runtime.open(fixture.request);
  seedAdoptedCleanup(fixture, 0);
  fixture.setReattach(async (binding) => {
    current = new Date(Date.parse(now) + 20);
    return emptyReattachment(binding);
  });
  const runtime = createStreamingProcessSessionRuntime({ ...fixture.runtimeOptions,
    waitUntilDeadline: async () => await new Promise<void>(() => undefined) });
  await assert.rejects(runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 20 }));
  assert.equal(fixture.calls.filter((call) => call === "reconcile").length, 0, "nested preparation cannot issue signals after the absolute bound");
  const fact = fixture.kernel.store.readBySession("stream-1")!.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[0]!;
  assert.equal(fact.blocker?.code, "cleanup_deadline_expired");
  assert.ok(fact.attempt);
});

for (const index of [2, 4]) {
  test(`round4 expired ${adoptedResources[index]} intent retains its specific reconciliation requirement`, async () => {
    let current = new Date(now);
    const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { clock: () => current });
    await fixture.runtime.open(fixture.request);
    const seeded = seedAdoptedCleanup(fixture, index, true);
    current = new Date(Date.parse(now) + 31_000);
    const runtime = fixture.createRecoveryRuntime();
    await assert.rejects(runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 100 }));
    const fact = fixture.kernel.store.readBySession("stream-1")!.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[index]!;
    assert.equal(fact.blocker?.code, index === 2 ? "evidence_continuation_unavailable" : "backend_release_reconciliation_required");
    assert.deepEqual(fact.attempt, seeded.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[index]!.attempt);
  });
}

test("round4 nested channel preparation cannot signal using a superseded owner", async () => {
  let current = new Date(now);
  const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { clock: () => current });
  await fixture.runtime.open(fixture.request);
  seedAdoptedCleanup(fixture, 0);
  fixture.setReattach(async (binding) => {
    current = new Date("2026-08-30T00:01:01.000Z");
    const before = fixture.kernel.store.readBySession("stream-1")!;
    fixture.kernelWriter.takeoverAdoptedWithOutput({ sessionId: "stream-1", ownerId: before.ownerId,
      fencingToken: before.fencingToken, expectedRevision: before.revision,
      outputExpectedRevision: fixture.kernel.store.readOutputCheckpoint("stream-1")!.revision,
      newOwnerId: "successor", newFencingToken: 2, leaseExpiresAt: "2026-08-30T00:02:01.000Z", at: current.toISOString() });
    return emptyReattachment(binding);
  });
  const runtime = createStreamingProcessSessionRuntime({ ...fixture.runtimeOptions,
    waitUntilDeadline: async () => await new Promise<void>(() => undefined) });
  await assert.rejects(runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 20 }));
  assert.equal(fixture.calls.filter((call) => call === "reconcile").length, 0);
});

for (const resource of ["evidence", "channel_detach"] as const) {
  test(`round4 nested ${resource} checks remaining time before the external effect`, async () => {
    let armed = false;
    let current = new Date(now);
    const fixture: Awaited<ReturnType<typeof makeFixture>> = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { clock: () => {
      if (armed && fixture.kernel.store.readBySession("stream-1")?.effects.find((effect) => effect.kind === "cleanup")
        ?.progress?.resources.find((fact) => fact.resource === resource)?.status === "in_flight") current = new Date(Date.parse(now) + 20);
      return current;
    } });
    const runtime = createStreamingProcessSessionRuntime({ ...fixture.runtimeOptions,
      waitUntilDeadline: async () => await new Promise<void>(() => undefined) });
    await runtime.open(fixture.request);
    armed = true;
    await assert.rejects(runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 20 }));
    assert.equal(fixture.finalizeCalls, resource === "evidence" ? 0 : 1);
    assert.equal(fixture.detachCalls, 1, "only the earlier live attachment relinquishment may detach");
    const fact = fixture.kernel.store.readBySession("stream-1")!.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources.find((candidate) => candidate.resource === resource)!;
    assert.equal(fact.blocker?.code, "cleanup_deadline_expired");
  });
}

for (const consumedMs of [10, 20]) {
  test(`round4 startup retains its original semantic deadline after ${consumedMs}ms of prior cleanup`, async () => {
    let current = new Date(now);
    const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { clock: () => current });
    await fixture.runtime.open(fixture.request);
    seedAdoptedCleanup(fixture, 0);
    fixture.kernelWriter.prepareLaunch(fixture.preparedRecord("precleanup", "pre-session"));
    const observedDeadlines: number[] = [];
    const runtime = createStreamingProcessSessionRuntime({ ...fixture.runtimeOptions,
      waitUntilDeadline: async () => await new Promise<void>(() => undefined),
      host: { ...fixture.runtimeOptions.host, quiesce: async ({ launchId, deadlineAt }) => {
        if (launchId === "precleanup") current = new Date(Date.parse(now) + consumedMs);
        else observedDeadlines.push(deadlineAt);
        return "verified";
      } } });
    await runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 20 });
    if (consumedMs === 10) assert.deepEqual(observedDeadlines, [Date.parse(now) + 20]);
    else {
      assert.deepEqual(observedDeadlines, []);
      const workload = fixture.kernel.store.readBySession("stream-1")!.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[0]!;
      assert.equal(workload.blocker?.code, "cleanup_deadline_before_effect");
      assert.equal(workload.attempts, 0);
    }
  });
}

test("open returns after adoption while a long-lived fake child remains active and never waits terminal", async () => {
  const fixture = await makeFixture();
  const facade = await fixture.runtime.open(fixture.request);
  assert.equal(facade.sessionId, "stream-1");
  assert.deepEqual(fixture.calls, ["isolate", "launch", "channel", "output", "handshake"]);
  assert.equal(fixture.waitTerminalCalls, 0);
  assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "active");
  assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "handed_off");
  assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1")?.capacity, 4);
  assert.equal("channel" in facade, false);
  const operation = { sessionId: "stream-1", operation: "request" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
  assert.ok(facade.authorizeFirstOperation(operation));
  assert.throws(() => facade.authorizeFirstOperation(operation), /launching ToolBroker call/i);
});

test("open fails typed before channel use when only v1 output is available", async () => {
  const fixture = await makeFixture(1);
  await assert.rejects(fixture.runtime.open(fixture.request), (error) => error instanceof StreamingProcessSessionError && error.code === "lossless_output_unavailable");
  assert.equal(fixture.kernel.store.readBySession("stream-1"), undefined);
  assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "cleanup_blocked");
});

test("open refuses a partial v2 replay window before private channel acquisition", async () => {
  const fixture = await makeFixture(2, "cleaned", undefined, [], 3);
  await assert.rejects(fixture.runtime.open(fixture.request), (error) => error instanceof StreamingProcessSessionError && error.code === "lossless_output_unavailable");
  assert.equal(fixture.calls.includes("channel"), false);
  assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "released");
});

test("active-phase cancellation settles the exact journal cleanup and never adopts", async () => {
  const abort = new AbortController();
  const fixture = await makeFixture(2, "cleaned", async () => { abort.abort(); await new Promise((resolve) => setImmediate(resolve)); return "b".repeat(64); });
  await assert.rejects(fixture.runtime.open({ ...fixture.request, signal: abort.signal }), (error) => error instanceof StreamingProcessSessionError && error.code === "cancelled");
  await waitUntil(() => fixture.kernel.store.readHostLaunch("launch-1")?.state === "released");
  assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "released");
  assert.equal(fixture.kernel.store.readBySession("stream-1"), undefined);
  assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1"), undefined);
});

test("startup reconciliation is bounded, never launches, and reports an unknown unbound launch", async () => {
  const fixture = await makeFixture();
  const writer = fixture.kernelWriter;
  writer.prepareLaunch(fixture.preparedRecord("orphan-launch", "orphan-session"));
  const before = fixture.launchCalls;
  const result = await fixture.runtime.reconcileStartup({ maxRecords: 1 });
  assert.equal(fixture.launchCalls, before);
  assert.equal(result.processed, 1);
  assert.deepEqual(result.outcomes, [{ launchId: "orphan-launch", disposition: "outcome_unknown" }]);
});

test("startup reconciliation is time bounded when fake host reconciliation hangs", { timeout: 1_000 }, async () => {
  const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, async () => await new Promise<"cleaned">(() => undefined));
  fixture.kernelWriter.prepareLaunch(fixture.preparedRecord("hung-launch", "hung-session"));
  const started = Date.now();
  const result = await fixture.runtime.reconcileStartup({ maxRecords: 1, timeoutMs: 20 });
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(result.outcomes, [{ launchId: "hung-launch", disposition: "blocked" }]);
  assert.equal(fixture.launchCalls, 0);
});

test("pre-adoption recovery drains retained protocol bytes to evidence without family delivery", { timeout: 1_000 }, async () => {
  const bytes = Buffer.alloc(1);
  const trailingBytes = Buffer.alloc(1, 1);
  const metadata = {
    stream: "stdout" as const,
    sequence: 1,
    startOffset: 0,
    endOffset: 1,
    byteLength: 1,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
  const trailingMetadata = {
    stream: "stdout" as const,
    sequence: 2,
    startOffset: 1,
    endOffset: 2,
    byteLength: 1,
    digest: createHash("sha256").update(trailingBytes).digest("hex"),
  };
  let acknowledge!: () => void;
  const acknowledged = new Promise<void>((resolve) => { acknowledge = resolve; });
  const fixture = await makeFixture(
    2,
    "cleaned",
    undefined,
    [],
    4,
    undefined,
    async () => { await acknowledged; return "cleaned"; },
  );
  let detachCalls = 0;
  fixture.setReattach(async (binding) => ({
    version: 2,
    binding,
    replayCapacityChunks: 4,
    replayCapacityBytes: 16,
    retainedWindow: [metadata, trailingMetadata],
    channel: {
      subscribeBackpressuredOutput: (sink) => {
        queueMicrotask(async () => {
          const exact = await sink(metadata, bytes);
          assert.deepEqual(exact, metadata);
          const exactTrailing = await sink(trailingMetadata, trailingBytes);
          assert.deepEqual(exactTrailing, trailingMetadata);
          acknowledge();
        });
        return () => undefined;
      },
      observeTerminal: () => () => undefined,
      settleBackpressuredOutput: async () => { await acknowledged; return { status: "settled" }; },
      detach: async () => { detachCalls++; },
    },
  }));

  const writer = fixture.kernelWriter;
  writer.prepareLaunch(fixture.preparedRecord());
  writer.transitionLaunch({ type: "bind_isolation", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 0, lease: leaseRecord(), at: now });
  writer.transitionLaunch({ type: "begin_launch", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 1, at: now });
  writer.transitionLaunch({ type: "bind_backend", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 2, backendBinding: fixture.backendBinding, at: now });
  writer.transitionLaunch({ type: "begin_channel", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 3, at: now });
  writer.claimHostOutputCheckpoint({
    launchId: "launch-1",
    ownerId: "host:run-1",
    fencingToken: 1,
    expectedRevision: 4,
    at: now,
    record: {
      recordKind: "runner.output-checkpoint",
      schemaVersion: 1,
      revision: 0,
      sessionId: "stream-1",
      ownerId: "pre-adoption-output",
      fencingToken: 1,
      capacity: 4,
      outcome: "active",
      streams: [
        { stream: "stdout", lastConsumed: null, consumed: [], accepted: [], consumingIntent: null },
        { stream: "stderr", lastConsumed: null, consumed: [], accepted: [], consumingIntent: null },
      ],
    },
  });
  writer.applyOutputCheckpoint({ type: "accept", sessionId: "stream-1", ownerId: "pre-adoption-output", fencingToken: 1, expectedRevision: 0, metadata });
  writer.transitionLaunch({ type: "verify_handshake", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 5, handshakeDigest: "b".repeat(64), at: now });

  const result = await fixture.createRecoveryRuntime().reconcileStartup({ maxRecords: 4, timeoutMs: 200 });
  assert.deepEqual(result.outcomes, [{ launchId: "launch-1", disposition: "cleaned" }]);
  assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "released");
  assert.equal(fixture.kernel.store.readBySession("stream-1"), undefined);
  assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1"), undefined);
  assert.equal(fixture.deliveries, 0, "cleanup must not fabricate family-delivery authority");
  assert.equal(fixture.evidenceWrites, 2);
  assert.equal(fixture.releaseCalls, 1);
  assert.equal(detachCalls, 1);
});

test("adopted recovery reattaches nonblockingly and marks missing retained accepted bytes outcome unknown", async () => {
  const fixture = await makeFixture(2, "cleaned", undefined, []);
  await fixture.runtime.open(fixture.request);
  const writer = fixture.kernelWriter;
  const metadata = { stream: "stdout", sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1, digest: "e".repeat(64) };
  writer.applyOutputCheckpoint({ type: "accept", sessionId: "stream-1", ownerId: fixture.kernel.store.readBySession("stream-1")!.ownerId, fencingToken: 1, expectedRevision: 0, metadata });
  const before = fixture.launchCalls;
  const result = await fixture.createRecoveryRuntime().reconcileStartup({ maxRecords: 4 });
  assert.equal(fixture.launchCalls, before);
  assert.equal(fixture.waitTerminalCalls, 0);
  assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "outcome_unknown");
  assert.equal(result.sessionOutcomes[0]?.disposition, "outcome_unknown");
});

test("adopted recovery exactly attests and privately restarts retained-byte replay", async () => {
  const bytes = Buffer.alloc(1); const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1, digest: createHash("sha256").update(bytes).digest("hex") };
  const fixture = await makeFixture(2, "cleaned", undefined, [metadata]); await fixture.runtime.open(fixture.request);
  fixture.kernelWriter.applyOutputCheckpoint({ type: "accept", sessionId: "stream-1", ownerId: fixture.kernel.store.readBySession("stream-1")!.ownerId, fencingToken: 1, expectedRevision: 0, metadata });
  const recovered = fixture.createRecoveryRuntime(); const result = await recovered.reconcileStartup({ maxRecords: 4, timeoutMs: 100 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(result.sessionOutcomes, [{ sessionId: "stream-1", disposition: "reattached" }]);
  assert.equal(fixture.deliveries, 0); assert.equal(fixture.evidenceWrites, 1);
  assert.deepEqual(fixture.kernel.store.readOutputCheckpoint("stream-1")?.streams[0]?.accepted, [metadata]);
});

test("adopted recovery re-acknowledges an exact consumed frame retained across the acknowledgement crash window", async () => {
  const bytes = Buffer.alloc(1);
  const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1, digest: createHash("sha256").update(bytes).digest("hex") };
  const fixture = await makeFixture();
  const facade = await fixture.runtime.open(fixture.request);
  const emitted = fixture.emit({ metadata, bytes, acknowledge: async () => undefined });
  await new Promise((resolve) => setImmediate(resolve));
  const operation = { sessionId: "stream-1", operation: "family_delivery" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
  await facade.deliverOutput(facade.authorizeFirstOperation(operation), { ...operation, binding: fixture.request.binding });
  await emitted;
  assert.deepEqual(fixture.kernel.store.readOutputCheckpoint("stream-1")?.streams[0]?.lastConsumed, metadata);

  let replayAcknowledged!: () => void;
  const acknowledged = new Promise<void>((resolve) => { replayAcknowledged = resolve; });
  fixture.setReattach(async (binding) => ({
    version: 2,
    binding,
    replayCapacityChunks: 4,
    replayCapacityBytes: 16,
    retainedWindow: [metadata],
    channel: {
      subscribeBackpressuredOutput: (sink) => {
        queueMicrotask(async () => {
          assert.deepEqual(await sink(metadata, bytes), metadata);
          replayAcknowledged();
        });
        return () => undefined;
      },
      observeTerminal: () => () => undefined,
      detach: async () => undefined,
    },
  }));
  const result = await fixture.createRecoveryRuntime().reconcileStartup({ maxRecords: 4, timeoutMs: 100 });
  assert.deepEqual(result.sessionOutcomes, [{ sessionId: "stream-1", disposition: "reattached" }]);
  await acknowledged;
  assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "active");
  assert.equal(fixture.evidenceWrites, 1, "a consumed replay must not duplicate evidence");
  assert.equal(fixture.deliveries, 1, "a consumed replay must not redeliver to the family");
});

test("runtime-owned v2 sink tees evidence, checkpoints protocol bytes, and acknowledges exactly", async () => {
  const fixture = await makeFixture(); const facade = await fixture.runtime.open(fixture.request);
  const bytes = Buffer.from("x"); const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1, digest: createHash("sha256").update(bytes).digest("hex") }; let ack = 0;
  const emitted = fixture.emit({ metadata, bytes, acknowledge: async () => { ack++; } });
  await new Promise((resolve) => setImmediate(resolve));
  const operation = { sessionId: "stream-1", operation: "family_delivery" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
  const authorization = facade.authorizeFirstOperation(operation);
  await facade.deliverOutput(authorization, { ...operation, binding: fixture.request.binding });
  await emitted;
  assert.equal(ack, 1); assert.equal(fixture.evidenceWrites, 1); assert.equal(fixture.deliveries, 1);
  assert.deepEqual(fixture.kernel.store.readOutputCheckpoint("stream-1")?.streams.find((stream) => stream.stream === "stdout")?.lastConsumed, metadata);
});

test("real fixture readiness waits for held evidence before authorized family delivery", { timeout: 2_000 }, async () => {
  const fixture = await makeFixture(2, "cleaned");
  let releaseEvidence!: () => void;
  const evidenceGate = new Promise<void>((resolve) => { releaseEvidence = resolve; });
  fixture.setEvidenceSpool(() => ({
    write: async () => await evidenceGate,
    finalize: async () => ({ streams: [] }),
    cleanup: async () => undefined,
  }));
  const facade = await fixture.runtime.open(fixture.request);
  const bytes = Buffer.from("held-evidence");
  const metadata = {
    stream: "stdout" as const,
    sequence: 1,
    startOffset: 0,
    endOffset: bytes.byteLength,
    byteLength: bytes.byteLength,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
  let readinessSettled = false;
  let emitted: Promise<void> | undefined;
  try {
    emitted = fixture.emit({ metadata, bytes, acknowledge: async () => undefined });
    void emitted.catch(() => undefined);
    await waitUntil(() => fixture.kernel.store.readOutputCheckpoint("stream-1")?.streams[0]?.accepted.length === 1);
    const readiness = waitForRealStreamingOutputReadiness(facade, 500).then(() => { readinessSettled = true; });
    const delivery = { sessionId: "stream-1", operation: "family_delivery" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
    const authorization = facade.authorizeFirstOperation(delivery);
    assert.equal(await facade.deliverOutput(authorization, { ...delivery, binding: fixture.request.binding }), false,
      "durable acceptance does not make public family delivery ready while evidence is held");
    await Promise.resolve();
    assert.equal(readinessSettled, false, "the fixture readiness policy must remain pending with real delivery");

    releaseEvidence();
    assert.equal(await readiness, undefined);
    const delivered: Buffer[] = [];
    assert.equal(await facade.deliverOutput(
      authorization,
      { ...delivery, binding: fixture.request.binding },
      async (_stream, input) => { delivered.push(Buffer.from(input)); },
    ), true);
    await emitted;
    assert.deepEqual(delivered, [bytes]);

    const stopBinding = { ...fixture.request.binding, callId: "call-2" };
    const stopGrant = await fixture.grants.issue({
      ...stopBinding,
      workspacePath: process.cwd(),
      access: [],
      externalApproved: false,
      destructiveApproved: false,
      networkApproved: false,
    });
    const stop = { sessionId: "stream-1", operation: "stop" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
    await facade.stop(
      facade.authorizeOperation({ ...stop, grant: stopGrant, binding: stopBinding }),
      { ...stop, binding: stopBinding },
    );
    assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "released");
  } finally {
    releaseEvidence();
  }
});

test("private pre-authorized output never reaches family delivery", async () => {
  const fixture = await makeFixture();
  const facade = await fixture.runtime.open(fixture.request);
  const bytes = Buffer.from("private");
  const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: bytes.byteLength, byteLength: bytes.byteLength, digest: createHash("sha256").update(bytes).digest("hex") };
  const emitted = fixture.emit({ metadata, bytes, acknowledge: async () => undefined });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.deliveries, 0, "family delivery must wait for an exact current authorization");
  const operation = { sessionId: "stream-1", operation: "family_delivery" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
  const authorization = facade.authorizeFirstOperation(operation);
  await facade.deliverOutput(authorization, { ...operation, binding: fixture.request.binding });
  await emitted;
});

test("output authorization invalidated by durable session disposition retains bytes without family delivery", async () => {
  const fixture = await makeFixture(); const facade = await fixture.runtime.open(fixture.request);
  const bytes = Buffer.from("retained"); const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: bytes.byteLength, byteLength: bytes.byteLength, digest: createHash("sha256").update(bytes).digest("hex") };
  const emitted = fixture.emit({ metadata, bytes, acknowledge: async () => undefined }); emitted.catch(() => undefined); await new Promise((resolve) => setImmediate(resolve));
  const operation = { sessionId: "stream-1", operation: "family_delivery" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
  const authorization = facade.authorizeFirstOperation(operation); const record = fixture.kernel.store.readBySession("stream-1")!;
  fixture.authority.recordDisposition({ sessionId: "stream-1", ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, disposition: "input_unavailable" });
  await assert.rejects(facade.deliverOutput(authorization, { ...operation, binding: fixture.request.binding }), /authorization/i);
  assert.equal(fixture.deliveries, 0); assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1")?.outcome, "active");
});

test("authorized stop finalizes evidence, detaches, and durably releases adopted cleanup", async () => {
  const fixture = await makeFixture(2, "cleaned"); const facade = await fixture.runtime.open(fixture.request);
  const operation = { sessionId: "stream-1", operation: "stop" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
  const authorization = facade.authorizeFirstOperation(operation);
  await facade.stop(authorization, { ...operation, binding: fixture.request.binding });
  const released = fixture.kernel.store.readBySession("stream-1")!;
  assert.equal(released.state, "released");
  const evidence = released.effects.find((effect) => effect.kind === "cleanup")?.progress?.resources
    .find((resource) => resource.resource === "evidence")?.evidence;
  assert.equal(evidence?.kind, "same_runtime_finalization");
  assert.notEqual(evidence?.digest, createHash("sha256").update("null").digest("hex"));
  assert.equal(fixture.finalizeCalls, 1); assert.equal(fixture.detachCalls, 2);
  assert.equal(fixture.reattachCalls, 1, "cleanup reattaches one evidence-only channel at the adopted fence");
  assert.equal(fixture.releaseCalls, 1, "adopted cleanup releases the exact isolation lease");
  assert.ok(fixture.calls.includes("reconcile"), "adopted cleanup verifies the exact host");
});

test("undefined evidence finalization cannot become a lossless durable proof", async () => {
  const fixture = await makeFixture(2, "cleaned");
  fixture.setEvidenceSpool(() => ({
    write: async () => undefined,
    finalize: async () => undefined,
    cleanup: async () => undefined,
  }));
  const facade = await fixture.runtime.open(fixture.request);
  const operation = { sessionId: "stream-1", operation: "stop" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
  await assert.rejects(
    facade.stop(facade.authorizeFirstOperation(operation), { ...operation, binding: fixture.request.binding }),
    (error) => error instanceof StreamingProcessSessionError && error.code === "cleanup_blocked",
  );
  const evidence = fixture.kernel.store.readBySession("stream-1")!.effects
    .find((effect) => effect.kind === "cleanup")!.progress!.resources
    .find((resource) => resource.resource === "evidence")!;
  assert.equal(evidence.status, "blocked");
  assert.equal(evidence.blocker?.code, "evidence_finalization_failed");
  assert.equal(evidence.evidence, undefined);
});

test("restart observes an exact in-flight workload attempt without repeating its external effect", async () => {
  const fixture = await makeFixture(2, "cleaned");
  await fixture.runtime.open(fixture.request);
  const writer = getStreamingSessionStoreWriter(fixture.kernel);
  let record = fixture.kernel.store.readBySession("stream-1")!;
  record = fixture.authority.recordDisposition({
    sessionId: record.sessionId,
    ownerId: record.ownerId,
    fencingToken: record.fencingToken,
    expectedRevision: record.revision,
    disposition: "outcome_unknown",
  }).record;
  record = writer.apply({
    type: "begin_cleanup",
    sessionId: record.sessionId,
    ownerId: record.ownerId,
    fencingToken: record.fencingToken,
    expectedRevision: record.revision,
    effectId: "cleanup:stream-1:1",
    at: now,
  });
  const cleanup = record.effects.find((effect) => effect.kind === "cleanup")!;
  record = writer.apply({
    type: "begin_cleanup_resource",
    sessionId: record.sessionId,
    ownerId: record.ownerId,
    fencingToken: record.fencingToken,
    expectedRevision: record.revision,
    effectId: cleanup.effectId,
    resource: "workload_quiescence",
    startedAt: now,
    deadlineAt: "2026-08-30T00:00:30.000Z",
    at: now,
  });

  let repeatedQuiescenceEffects = 0;
  let exactObservations = 0;
  const restarted = createStreamingProcessSessionRuntime({
    ...fixture.runtimeOptions,
    host: {
      ...fixture.runtimeOptions.host,
      quiesce: async () => { repeatedQuiescenceEffects += 1; return "verified"; },
      observeQuiescence: async () => { exactObservations += 1; return "verified"; },
    },
  });
  await assert.rejects(
    restarted.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 100 }),
    (error) => error instanceof StreamingProcessSessionError && error.code === "cleanup_blocked",
  );

  const retained = fixture.kernel.store.readBySession("stream-1")!;
  const resources = retained.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources;
  assert.equal(resources.find((fact) => fact.resource === "workload_quiescence")?.status, "verified");
  assert.equal(resources.find((fact) => fact.resource === "workload_quiescence")?.attempt, undefined);
  assert.equal(resources.find((fact) => fact.resource === "evidence")?.blocker?.code, "evidence_continuation_unavailable");
  assert.equal(repeatedQuiescenceEffects, 0, "restart must not repeat a durably in-flight signal effect");
  assert.equal(exactObservations, 1);
});

test("restart after backend retirement intent without a durable receipt preserves a reconciliation blocker", async () => {
  const fixture = await makeFixture(2, "cleaned");
  await fixture.runtime.open(fixture.request);
  const writer = getStreamingSessionStoreWriter(fixture.kernel);
  let record = fixture.kernel.store.readBySession("stream-1")!;
  record = fixture.authority.recordDisposition({
    sessionId: record.sessionId,
    ownerId: record.ownerId,
    fencingToken: record.fencingToken,
    expectedRevision: record.revision,
    disposition: "outcome_unknown",
  }).record;
  record = writer.apply({
    type: "begin_cleanup",
    sessionId: record.sessionId,
    ownerId: record.ownerId,
    fencingToken: record.fencingToken,
    expectedRevision: record.revision,
    effectId: "cleanup:stream-1:1",
    at: now,
  });
  for (const resource of ["workload_quiescence", "retained_output_settlement", "evidence", "channel_detach"] as const) {
    let cleanup = record.effects.find((effect) => effect.kind === "cleanup")!;
    record = writer.apply({
      type: "begin_cleanup_resource",
      sessionId: record.sessionId,
      ownerId: record.ownerId,
      fencingToken: record.fencingToken,
      expectedRevision: record.revision,
      effectId: cleanup.effectId,
      resource,
      startedAt: now,
      deadlineAt: "2026-08-30T00:00:30.000Z",
      at: now,
    });
    cleanup = record.effects.find((effect) => effect.kind === "cleanup")!;
    const fact = cleanup.progress!.resources.find((candidate) => candidate.resource === resource)!;
    record = writer.apply({
      type: "settle_cleanup_resource",
      sessionId: record.sessionId,
      ownerId: record.ownerId,
      fencingToken: record.fencingToken,
      expectedRevision: record.revision,
      effectId: cleanup.effectId,
      resource,
      attemptId: fact.attempt!.attemptId,
      attemptOwnerId: fact.attempt!.ownerId,
      attemptFencingToken: fact.attempt!.fencingToken,
      result: "verified",
      ...(resource === "evidence" ? { evidence: {
        kind: "same_runtime_finalization" as const,
        digest: "e".repeat(64),
        lossy: false,
      } } : {}),
      at: now,
    });
  }
  const cleanup = record.effects.find((effect) => effect.kind === "cleanup")!;
  record = writer.apply({
    type: "begin_cleanup_resource",
    sessionId: record.sessionId,
    ownerId: record.ownerId,
    fencingToken: record.fencingToken,
    expectedRevision: record.revision,
    effectId: cleanup.effectId,
    resource: "backend_release",
    startedAt: now,
    deadlineAt: "2026-08-30T00:00:30.000Z",
    at: now,
  });
  const issued = record.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources
    .find((fact) => fact.resource === "backend_release")!;

  let repeatedReleaseEffects = 0;
  const restarted = createStreamingProcessSessionRuntime({
    ...fixture.runtimeOptions,
    host: {
      ...fixture.runtimeOptions.host,
      release: async () => { repeatedReleaseEffects += 1; return "verified"; },
    },
  });
  await assert.rejects(
    restarted.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 100 }),
    (error) => error instanceof StreamingProcessSessionError && error.code === "cleanup_blocked",
  );

  const retained = fixture.kernel.store.readBySession("stream-1")!;
  const backend = retained.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources
    .find((fact) => fact.resource === "backend_release")!;
  assert.equal(retained.state, "cleanup_blocked");
  assert.equal(backend.status, "blocked");
  assert.equal(backend.blocker?.code, "backend_release_reconciliation_required");
  assert.deepEqual(backend.attempt, issued.attempt);
  assert.equal(repeatedReleaseEffects, 0, "missing backend state without a receipt cannot authorize another release or success");
});

test("a held cleanup effect survives caller timeout and duplicate cleanup joins the exact attempt", async () => {
  let current = new Date(now);
  let releaseHeld!: (outcome: "cleaned") => void;
  const held = new Promise<"cleaned">((resolve) => { releaseHeld = resolve; });
  const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, async () => await held, undefined, { clock: () => current });
  const deadlines: Array<{ at: number; expire: () => void }> = [];
  const runtime = createStreamingProcessSessionRuntime({ ...fixture.runtimeOptions,
    waitUntilDeadline: async (at) => await new Promise<void>((expire) => { deadlines.push({ at, expire }); }) });
  await runtime.open(fixture.request);
  const first = runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 20 });
  const firstFailure = assert.rejects(first, (error) => error instanceof StreamingProcessSessionError && error.code === "launch_failed");
  const joined = runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 100 });
  const joinedFailure = assert.rejects(joined, (error) => error instanceof StreamingProcessSessionError && error.code === "launch_failed");
  try {
  await waitUntil(() => fixture.calls.filter((call) => call === "reconcile").length === 1 && deadlines.length === 2 &&
    fixture.kernel.store.readBySession("stream-1")!.effects.find((effect) => effect.kind === "cleanup")?.progress?.resources[0]?.status === "in_flight");
  assert.equal(fixture.kernel.store.readBySession("stream-1")!.effects.find((effect) => effect.kind === "cleanup")?.progress?.resources[0]?.status, "in_flight");
  assert.equal(fixture.calls.filter((call) => call === "reconcile").length, 1);
  assert.equal(fixture.observeQuiescenceCalls, 0, "a same-runtime duplicate joins the tracked effect instead of reconciling it as crashed");
  assert.deepEqual(deadlines.map((entry) => entry.at), [Date.parse(now) + 20, Date.parse(now) + 20]);
  current = new Date(Date.parse(now) + 20);
  for (const deadline of deadlines) deadline.expire();
  await Promise.all([firstFailure, joinedFailure]);
  const timedOut = fixture.kernel.store.readBySession("stream-1")!;
  const workload = timedOut.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[0]!;
  assert.equal(workload.status, "blocked");
  assert.equal(workload.blocker?.code, "cleanup_deadline_expired");
  assert.ok(workload.attempt, "the timed-out callers must not erase the durable effect identity");
  releaseHeld("cleaned");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.kernel.store.readBySession("stream-1")!.revision, timedOut.revision);
  await runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 100 });
  assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "released");
  assert.equal(fixture.observeQuiescenceCalls, 1, "a new current-owner run observes the retained late result");
  assert.equal(fixture.calls.filter((call) => call === "reconcile").length, 1,
    "the duplicate request must join rather than issue a second effect");
  } finally {
    current = new Date(Date.parse(now) + 20);
    for (const deadline of deadlines) deadline.expire();
    releaseHeld("cleaned");
    await Promise.allSettled([firstFailure, joinedFailure]);
  }
});
test("semantic deadline expiry durably blocks the exact attempt before its late result can advance cleanup", async () => {
  let current = new Date(now);
  let releaseHeld!: (outcome: "cleaned") => void;
  const held = new Promise<"cleaned">((resolve) => { releaseHeld = resolve; });
  const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, async () => await held, undefined, {
    clock: () => new Date(current),
  });
  let expireDeadline!: () => void;
  const deadlines: number[] = [];
  const runtime = createStreamingProcessSessionRuntime({
    ...fixture.runtimeOptions,
    waitUntilDeadline: async (deadlineAt) => {
      deadlines.push(deadlineAt);
      await new Promise<void>((resolve) => { expireDeadline = resolve; });
    },
  });
  await runtime.open(fixture.request);

  const cleanup = runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 20 });
  await waitUntil(() => fixture.calls.filter((call) => call === "reconcile").length === 1 && deadlines.length === 1);
  current = new Date(deadlines[0]! + 1);
  expireDeadline();
  await assert.rejects(
    cleanup,
    (error) => error instanceof StreamingProcessSessionError && error.code === "launch_failed",
  );

  const expired = fixture.kernel.store.readBySession("stream-1")!;
  const expiredWorkload = expired.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[0]!;
  assert.equal(expired.state, "cleanup_blocked");
  assert.equal(expiredWorkload.status, "blocked");
  assert.equal(expiredWorkload.blocker?.code, "cleanup_deadline_expired");
  assert.ok(expiredWorkload.attempt, "deadline expiry retains the exact late effect identity");

  releaseHeld("cleaned");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "cleanup_blocked",
    "the late result cannot advance the expired coordinator run");

  current = new Date("2026-08-30T00:01:01.000Z");
  const beforeTakeover = fixture.kernel.store.readBySession("stream-1")!;
  const checkpoint = fixture.kernel.store.readOutputCheckpoint("stream-1")!;
  fixture.kernelWriter.takeoverAdoptedWithOutput({
    sessionId: "stream-1",
    ownerId: beforeTakeover.ownerId,
    fencingToken: beforeTakeover.fencingToken,
    expectedRevision: beforeTakeover.revision,
    outputExpectedRevision: checkpoint.revision,
    newOwnerId: "deadline-recovery-owner",
    newFencingToken: beforeTakeover.fencingToken + 1,
    leaseExpiresAt: "2026-08-30T00:02:01.000Z",
    at: current.toISOString(),
  });
  await runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 100 });
  assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "released");
  assert.equal(fixture.calls.filter((call) => call === "reconcile").length, 1);
  assert.equal(fixture.observeQuiescenceCalls, 1,
    "a distinct current-owner retry consumes the exact late outcome through observation");
  assert.deepEqual(fixture.observedQuiescenceFences, [{ ownerId: "deadline-recovery-owner", fencingToken: 3 }]);
});

test("an exactly owned active session renews its safety lease after a long idle interval", async () => {
  let current = new Date(now);
  const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, {
    clock: () => new Date(current),
  });
  const facade = await fixture.runtime.open(fixture.request);
  const before = fixture.kernel.store.readBySession("stream-1")!;
  current = new Date("2026-08-30T00:01:01.000Z");
  const operation = { sessionId: "stream-1", operation: "request" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };

  assert.ok(facade.authorizeFirstOperation(operation));

  const renewed = fixture.kernel.store.readBySession("stream-1")!;
  assert.equal(renewed.ownerId, before.ownerId);
  assert.equal(renewed.fencingToken, before.fencingToken);
  assert.ok(renewed.revision > before.revision);
  assert.ok(Date.parse(renewed.leaseExpiresAt) > current.getTime());
  await fixture.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 100 });
  assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "released");
});

test("owned cleanup retries a one-shot blocked attempt without relaunching or double-detaching", async () => {
  let cleanupOutcome: "blocked" | "cleaned" = "blocked";
  const fixture = await makeFixture(
    2,
    "cleaned",
    undefined,
    [],
    4,
    undefined,
    async () => cleanupOutcome,
  );
  await fixture.runtime.open(fixture.request);

  await assert.rejects(
    fixture.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 100 }),
    (error) => error instanceof StreamingProcessSessionError && error.code === "cleanup_blocked",
  );
  assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "cleanup_blocked");
  cleanupOutcome = "cleaned";

  await fixture.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 100 });

  assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "released");
  assert.equal(fixture.detachCalls, 2, "the live and one retained cleanup channel each detach once");
  assert.equal(fixture.reattachCalls, 1, "verified output setup is retained and never replayed on resource retry");
  assert.equal(fixture.launchCalls, 1, "cleanup retry must never relaunch the process");
});

test("cleanup takeover preserves one evidence spool across a nonempty suffix and blocked retry", async () => {
  let cleanupOutcome: "blocked" | "cleaned" = "blocked";
  let currentDrain: Promise<void> = Promise.resolve();
  const originalBytes = Buffer.from("original");
  const suffixBytes = Buffer.from("suffix");
  const original = {
    stream: "stdout" as const,
    sequence: 1,
    startOffset: 0,
    endOffset: originalBytes.byteLength,
    byteLength: originalBytes.byteLength,
    digest: createHash("sha256").update(originalBytes).digest("hex"),
  };
  const suffix = {
    stream: "stdout" as const,
    sequence: 2,
    startOffset: original.endOffset,
    endOffset: original.endOffset + suffixBytes.byteLength,
    byteLength: suffixBytes.byteLength,
    digest: createHash("sha256").update(suffixBytes).digest("hex"),
  };
  const writes: Buffer[] = [];
  let spoolCreations = 0;
  let finalizations = 0;
  let finalizedTotal = -1;
  let finalizedLossReasons: readonly { code: string }[] = [];
  const fixture = await makeFixture(
    2,
    "cleaned",
    undefined,
    [],
    4,
    undefined,
    async () => {
      await currentDrain;
      return cleanupOutcome;
    },
  );
  fixture.setEvidenceSpool(() => {
    spoolCreations++;
    return {
      write: async (_stream, bytes) => { writes.push(Buffer.from(bytes)); },
      finalize: async () => {
        finalizations++;
        finalizedTotal = Buffer.concat(writes).byteLength;
        finalizedLossReasons = [{ code: "spill_open_failed" }];
        return {
          streams: [{
            stream: "stdout",
            totalBytes: finalizedTotal,
            lossyOutput: true,
            lossReasons: finalizedLossReasons,
          }],
        };
      },
      cleanup: async () => undefined,
    };
  });
  fixture.setReattach(async (binding) => ({
    version: 2,
    binding,
    replayCapacityChunks: 4,
    replayCapacityBytes: 16,
    retainedWindow: [original, suffix],
    channel: {
      subscribeBackpressuredOutput: (sink) => {
        currentDrain = (async () => {
          await sink(original, originalBytes);
          await sink(suffix, suffixBytes);
        })();
        void currentDrain.catch(() => undefined);
        return () => undefined;
      },
      observeTerminal: () => () => undefined,
      settleBackpressuredOutput: async () => { await currentDrain; return { status: "settled" }; },
      detach: async () => { await currentDrain; },
    },
  }));
  const facade = await fixture.runtime.open(fixture.request);
  const emitted = fixture.emit({ metadata: original, bytes: originalBytes, acknowledge: async () => undefined });
  void emitted.catch(() => undefined);
  await waitUntil(() => writes.length === 1);
  const operation = { sessionId: "stream-1", operation: "stop" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };

  await assert.rejects(
    facade.stop(facade.authorizeFirstOperation(operation), { ...operation, binding: fixture.request.binding }),
    (error) => error instanceof StreamingProcessSessionError && error.code === "cleanup_blocked",
  );
  await assert.rejects(emitted);
  assert.equal(finalizations, 0, "a blocked cleanup keeps the evidence continuation open for exact retry");
  cleanupOutcome = "cleaned";

  await fixture.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 100 });

  assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "released");
  assert.equal(spoolCreations, 1, "takeover transfers the original evidence spool rather than replacing it");
  assert.equal(finalizations, 1, "continuous evidence is finalized exactly once after verified cleanup");
  assert.deepEqual(Buffer.concat(writes), Buffer.concat([originalBytes, suffixBytes]), "accepted replay is not counted twice");
  assert.equal(finalizedTotal, originalBytes.byteLength + suffixBytes.byteLength);
  assert.deepEqual(finalizedLossReasons, [{ code: "spill_open_failed" }]);
});

test("C3 real shared-spool spill failure finalizes lossy evidence and releases after cleanup takeover", async (t) => {
  let stage = "fixture setup";
  const root = await mkdtemp(join(tmpdir(), "c3-round3-shared-spool-"));
  t.diagnostic(`created exact fixture root: ${root}`);
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const nodeStorage = createNodeOutputSpillStorage();
  const spools: BoundedOutputSpool[] = [];
  let spillOpenAttempts = 0;
  let currentDrain: Promise<void> = Promise.resolve();
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    attest: async () => ({
      currentPrincipalPrivacy: true,
      identityStableDeletion: true,
      unlinkedEntries: false,
    }),
    openExclusive: async () => {
      spillOpenAttempts += 1;
      throw new Error("deliberate spill-open failure");
    },
  };
  const createSpool = () => {
    const spool = new BoundedOutputSpool({
      spillRoot: join(root, "spool"),
      projectRoot: process.cwd(),
      ownershipId: "c3-round3-shared-owner",
      tailBytes: 64,
      spillBytes: 64,
      artifactStore: artifacts,
      storage,
    });
    spools.push(spool);
    return spool;
  };
  t.after(async () => {
    t.diagnostic(`last fixture stage: ${stage}`);
    for (const spool of spools) await spool.cleanup().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    t.diagnostic(`removed exact fixture root: ${root}`);
  });

  const bytes = Buffer.from("private-output");
  const metadata = {
    stream: "stdout" as const,
    sequence: 1,
    startOffset: 0,
    endOffset: bytes.byteLength,
    byteLength: bytes.byteLength,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
  const fixture = await makeFixture(2, "cleaned");
  fixture.setReattach(async (binding) => ({
    version: 2,
    binding,
    replayCapacityChunks: 4,
    replayCapacityBytes: 16,
    retainedWindow: [metadata],
    channel: {
      subscribeBackpressuredOutput: (sink) => {
        currentDrain = sink(metadata, bytes).then(() => undefined);
        void currentDrain.catch(() => undefined);
        return () => undefined;
      },
      observeTerminal: () => () => undefined,
      settleBackpressuredOutput: async () => { await currentDrain; return { status: "settled" }; },
      detach: async () => { await currentDrain; },
    },
  }));
  const runtime = createStreamingProcessSessionRuntime({
    ...fixture.runtimeOptions,
    output: {
      ...fixture.runtimeOptions.output,
      artifacts,
      createEvidenceSpool: createSpool,
    },
  });
  stage = "runtime open";
  const facade = await runtime.open(fixture.request);
  stage = "live output acceptance";
  const emitted = fixture.emit({ metadata, bytes, acknowledge: async () => undefined });
  assert.equal(await facade.waitForOutput(), true);
  const delivered: Array<{ stream: string; bytes: Buffer }> = [];
  const delivery = { sessionId: "stream-1", operation: "family_delivery" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
  stage = "authorized family delivery";
  await facade.deliverOutput(
    facade.authorizeFirstOperation(delivery),
    { ...delivery, binding: fixture.request.binding },
    async (stream, input) => { delivered.push({ stream, bytes: Buffer.from(input) }); },
  );
  stage = "live output acknowledgement";
  await emitted;
  const stop = { sessionId: "stream-1", operation: "stop" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
  const stopBinding = { ...fixture.request.binding, callId: "call-2" };
  const stopGrant = await fixture.grants.issue({
    ...stopBinding,
    workspacePath: process.cwd(),
    access: [],
    externalApproved: false,
    destructiveApproved: false,
    networkApproved: false,
  });

  stage = "adopted stop cleanup";
  const stopError = await facade.stop(
    facade.authorizeOperation({ ...stop, grant: stopGrant, binding: stopBinding }),
    { ...stop, binding: stopBinding },
  ).then(() => undefined, (error: unknown) => error);
  const afterStop = fixture.kernel.store.readBySession("stream-1")!;
  const afterEvidence = afterStop.effects.find((effect) => effect.kind === "cleanup")?.progress?.resources
    .find((resource) => resource.resource === "evidence");
  t.diagnostic(`stop outcome: ${JSON.stringify({
    state: afterStop.state,
    evidenceStatus: afterEvidence?.status,
    evidenceBlocker: afterEvidence?.blocker?.code,
    evidenceLossy: afterEvidence?.evidence?.lossy,
    spoolCount: spools.length,
    spillOpenAttempts,
  })}`);
  assert.equal(stopError, undefined, JSON.stringify(errorGraph(stopError)));
  stage = "final assertions";

  const released = afterStop;
  const evidence = released.effects.find((effect) => effect.kind === "cleanup")?.progress?.resources
    .find((resource) => resource.resource === "evidence");
  assert.equal(released.state, "released");
  assert.equal(evidence?.status, "verified");
  assert.equal(evidence?.evidence?.lossy, true, "the deliberate spill-open fault is explicit durable loss");
  assert.deepEqual(delivered, [{ stream: "stdout", bytes }], "cleanup replay never reaches family delivery");
  assert.equal(spools.length, 2, "live and cleanup continuations use two real shared-root spools");
  assert.equal(spillOpenAttempts, 2, "both real spools reach the nonfatal spill-open fault");
  await assert.rejects(lstat(join(root, "spool")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

for (const observationCase of ["current", "takeover", "unsettled_before", "async_revision", "async_checkpoint", "async_takeover", "async_deadline", "missing_manifest", "corrupt_manifest", "missing_result", "corrupt_result", "missing_page", "corrupt_page", "missing_segment", "corrupt_segment"] as const)
test(`C3 round4 observes finalized lossy manifest after later cleanup exception on fresh SQLite runtime ${observationCase}`, async (t) => {
  let stage = "fixture setup";
  const root = await mkdtemp(join(tmpdir(), "c3-round4-observation-"));
  t.diagnostic(`created exact fixture root: ${root}`);
  const databasePath = join(root, "sessions.sqlite");
  const integrityKey = Buffer.alloc(32, 24);
  let kernel = openSqliteStreamingSessionStore(databasePath, integrityKey);
  let postManifestFailures = 0;
  let finalizationCalls = 0;
  let cleanupCalls = 0;
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const nodeStorage = createNodeOutputSpillStorage();
  const spools: BoundedOutputSpool[] = [];
  let spillOpenAttempts = 0;
  let currentDrain: Promise<void> = Promise.resolve();
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    attest: async () => ({
      currentPrincipalPrivacy: true,
      identityStableDeletion: true,
      unlinkedEntries: false,
    }),
    openExclusive: async () => {
      spillOpenAttempts += 1;
      throw new Error("deliberate spill-open failure");
    },
  };
  const createSpool = () => {
    const spool = new BoundedOutputSpool({
      spillRoot: join(root, "spool"),
      projectRoot: process.cwd(),
      ownershipId: "c3-round3-shared-owner",
      tailBytes: 64,
      spillBytes: 64,
      artifactStore: artifacts,
      storage,
    });
    const finalize = spool.finalize.bind(spool);
    spool.finalize = async () => { finalizationCalls++; return finalize(); };
    const cleanup = spool.cleanup.bind(spool);
    const isLive = spools.length === 0;
    spool.cleanup = async () => {
      cleanupCalls++;
      if (isLive && postManifestFailures === 0 && kernel.store.readOutputCheckpoint("stream-1")?.continuation?.finalized) {
        postManifestFailures++;
        throw new Error("injected cleanup exception after authenticated manifest commit");
      }
      await cleanup();
    };
    spools.push(spool);
    return spool;
  };
  t.after(async () => {
    t.diagnostic(`last fixture stage: ${stage}`);
    for (const spool of spools) await spool.cleanup().catch(() => undefined);
    kernel.store.close();
    await rm(root, { recursive: true, force: true });
    t.diagnostic(`removed exact fixture root: ${root}`);
  });

  const bytes = Buffer.from("private-output");
  const metadata = {
    stream: "stdout" as const,
    sequence: 1,
    startOffset: 0,
    endOffset: bytes.byteLength,
    byteLength: bytes.byteLength,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
  const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { kernel });
  fixture.setReattach(async (binding) => ({
    version: 2,
    binding,
    replayCapacityChunks: 4,
    replayCapacityBytes: 16,
    retainedWindow: [metadata],
    channel: {
      subscribeBackpressuredOutput: (sink) => {
        currentDrain = sink(metadata, bytes).then(() => undefined);
        void currentDrain.catch(() => undefined);
        return () => undefined;
      },
      observeTerminal: () => () => undefined,
      settleBackpressuredOutput: async () => { await currentDrain; return { status: "settled" }; },
      detach: async () => { await currentDrain; },
    },
  }));
  const runtime = createStreamingProcessSessionRuntime({
    ...fixture.runtimeOptions,
    output: {
      ...fixture.runtimeOptions.output,
      artifacts,
      createEvidenceSpool: createSpool,
    },
  });
  stage = "runtime open";
  const facade = await runtime.open(fixture.request);
  stage = "live output acceptance";
  const emitted = fixture.emit({ metadata, bytes, acknowledge: async () => undefined });
  assert.equal(await facade.waitForOutput(), true);
  const delivered: Array<{ stream: string; bytes: Buffer }> = [];
  const delivery = { sessionId: "stream-1", operation: "family_delivery" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
  stage = "authorized family delivery";
  await facade.deliverOutput(
    facade.authorizeFirstOperation(delivery),
    { ...delivery, binding: fixture.request.binding },
    async (stream, input) => { delivered.push({ stream, bytes: Buffer.from(input) }); },
  );
  stage = "live output acknowledgement";
  await emitted;
  const stop = { sessionId: "stream-1", operation: "stop" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
  const stopBinding = { ...fixture.request.binding, callId: "call-2" };
  const stopGrant = await fixture.grants.issue({
    ...stopBinding,
    workspacePath: process.cwd(),
    access: [],
    externalApproved: false,
    destructiveApproved: false,
    networkApproved: false,
  });

  stage = "adopted stop cleanup";
  const stopError = await facade.stop(
    facade.authorizeOperation({ ...stop, grant: stopGrant, binding: stopBinding }),
    { ...stop, binding: stopBinding },
  ).then(() => undefined, (error: unknown) => error);
  const afterStop = fixture.kernel.store.readBySession("stream-1")!;
  const afterEvidence = afterStop.effects.find((effect) => effect.kind === "cleanup")?.progress?.resources
    .find((resource) => resource.resource === "evidence");
  t.diagnostic(`stop outcome: ${JSON.stringify({
    state: afterStop.state,
    evidenceStatus: afterEvidence?.status,
    evidenceBlocker: afterEvidence?.blocker?.code,
    evidenceLossy: afterEvidence?.evidence?.lossy,
    spoolCount: spools.length,
    spillOpenAttempts,
  })}`);
  assert.ok(stopError instanceof Error);
  assert.equal(postManifestFailures, 1);
  assert.equal(afterStop.state, "cleanup_blocked");
  assert.equal(afterEvidence?.blocker?.code, "evidence_finalization_failed");
  assert.equal(afterEvidence?.attempt, undefined);
  const checkpoint = kernel.store.readOutputCheckpoint("stream-1")!;
  const finalized = checkpoint.continuation!.finalized!;
  assert.equal(finalized.lossy, true);
  assert.ok(checkpoint.streams.every((stream) => stream.accepted.length === 0 && !stream.consumingIntent));
  assert.deepEqual(afterStop.effects.find((e) => e.kind === "cleanup")!.progress!.resources.map((r) => r.status),
    ["verified", "verified", "blocked", "pending", "pending", "pending"]);
  kernel.store.close(); kernel = openSqliteStreamingSessionStore(databasePath, integrityKey);
  let recoveryNow = Date.parse(now);
  if (observationCase === "takeover") {
    recoveryNow = Date.parse(afterStop.leaseExpiresAt) + 1;
    getStreamingSessionKernelWriter(kernel).takeoverAdoptedWithOutput({ sessionId: "stream-1", ownerId: afterStop.ownerId,
      fencingToken: afterStop.fencingToken, expectedRevision: afterStop.revision, outputExpectedRevision: checkpoint.revision,
      newOwnerId: "round4-recovery", newFencingToken: afterStop.fencingToken + 1,
      leaseExpiresAt: new Date(recoveryNow + 60000).toISOString(), at: new Date(recoveryNow).toISOString() });
  }
  const effects: string[] = [];
  const assertEvidence = (effect: string) => {
    assert.equal(kernel.store.readBySession("stream-1")!.effects.find((e) => e.kind === "cleanup")!.progress!.resources[2]!.status,
      "verified", `${effect} must follow durable observation`);
    effects.push(effect);
  };
  const originalGet = artifacts.get.bind(artifacts);
  const originalPut = artifacts.put.bind(artifacts);
  artifacts.put = async () => { effects.push("artifact put"); throw new Error("observation cannot write artifacts"); };
  const page = JSON.parse((await originalGet(checkpoint.continuation!.head!)).toString()) as { segmentHash: string };
  const faultHash = observationCase.endsWith("manifest") ? finalized.manifestHash : observationCase.endsWith("result") ? finalized.resultHash :
    observationCase.endsWith("page") ? checkpoint.continuation!.head : page.segmentHash;
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  };
  const entered = deferred();
  const resume = deferred();
  let firstRead = true;
  artifacts.get = async (digest) => {
    const bytes = await originalGet(digest);
    if (firstRead) { firstRead = false; entered.resolve(); await resume.promise; }
    if (digest === faultHash && observationCase.startsWith("missing_")) throw new Error("private artifact path must not escape");
    if (digest === faultHash && observationCase.startsWith("corrupt_")) return Buffer.alloc(bytes.length, 0);
    return bytes;
  };
  if (observationCase === "unsettled_before") {
    const cp = kernel.store.readOutputCheckpoint("stream-1")!;
    getStreamingSessionKernelWriter(kernel).applyOutputCheckpoint({ type: "accept", sessionId: "stream-1", ownerId: cp.ownerId,
      fencingToken: cp.fencingToken, expectedRevision: cp.revision, metadata: { ...metadata, sequence: 2, startOffset: metadata.endOffset, endOffset: metadata.endOffset * 2 } });
  }
  const spoolEffectsBefore = [finalizationCalls, cleanupCalls];
  const recoveryBefore = kernel.store.readBySession("stream-1")!;
  const reattach: NonNullable<StreamingRuntimeOptions["channel"]["reattach"]> = fixture.runtimeOptions.channel.reattach!;
  const fresh = createStreamingProcessSessionRuntime({ ...fixture.runtimeOptions, kernel,
    clock: () => new Date(recoveryNow),
    channel: { ...fixture.runtimeOptions.channel, reattach: async (...args) => { assertEvidence("channel reattach"); return reattach(...args); } },
    host: { ...fixture.runtimeOptions.host, release: async (input) => { assertEvidence("backend release"); assert.equal(input.deadlineAt, recoveryNow + 2000); return fixture.runtimeOptions.host.release(); } },
    isolation: { ...fixture.runtimeOptions.isolation, release: async () => { assertEvidence("isolation release"); return fixture.runtimeOptions.isolation.release(); } },
    sessions: createSessionAuthority({ grants: fixture.grants, sessions: kernel, clock: () => new Date(recoveryNow) }),
    output: { ...fixture.runtimeOptions.output, artifacts, createEvidenceSpool: () => { throw new Error("observation must not create a spool"); } },
  });
  const recovery = fresh.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 2000 }).then(() => undefined, (error: unknown) => error);
  if (observationCase === "unsettled_before") {
    try {
      const event = await Promise.race([recovery.then(() => "refused"), entered.promise.then(() => "artifact read")]);
      assert.equal(event, "refused", "unsettled checkpoint must be refused before artifact reads");
      assert.ok(await recovery instanceof Error);
      assert.deepEqual(kernel.store.readBySession("stream-1"), recoveryBefore);
      assert.deepEqual(effects, []);
    } finally { resume.resolve(); await recovery; }
    return;
  }
  let expected = recoveryBefore;
  try {
    await Promise.race([entered.promise, recovery.then(() => { throw new Error("observation did not reach artifact verification"); })]);
    assert.deepEqual(effects, [], "observation boundary has no external effects while reads are pending");
    assert.deepEqual(kernel.store.readBySession("stream-1"), recoveryBefore, "observation does not issue an attempt");
    const writer = getStreamingSessionKernelWriter(kernel);
    const cp = kernel.store.readOutputCheckpoint("stream-1")!;
    if (observationCase === "async_revision") expected = writer.apply({ type: "renew_lease", sessionId: "stream-1", ownerId: expected.ownerId,
      fencingToken: expected.fencingToken, expectedRevision: expected.revision, leaseExpiresAt: new Date(recoveryNow + 120000).toISOString(), at: new Date(recoveryNow).toISOString() });
    if (observationCase === "async_checkpoint") writer.applyOutputCheckpoint({ type: "accept", sessionId: "stream-1", ownerId: cp.ownerId,
      fencingToken: cp.fencingToken, expectedRevision: cp.revision, metadata: { ...metadata, sequence: 2, startOffset: metadata.endOffset, endOffset: metadata.endOffset * 2 } });
    if (observationCase === "async_takeover") {
      const takeoverAt = Date.parse(expected.leaseExpiresAt) + 1;
      expected = writer.takeoverAdoptedWithOutput({ sessionId: "stream-1", ownerId: expected.ownerId, fencingToken: expected.fencingToken,
        expectedRevision: expected.revision, outputExpectedRevision: cp.revision, newOwnerId: "replacement", newFencingToken: expected.fencingToken + 1,
        leaseExpiresAt: new Date(takeoverAt + 60000).toISOString(), at: new Date(takeoverAt).toISOString() }).session;
    }
    if (observationCase === "async_deadline") recoveryNow += 2000;
  } finally { resume.resolve(); await recovery; }
  const recoveryError = await recovery;
  artifacts.put = originalPut;
  assert.deepEqual([finalizationCalls, cleanupCalls], spoolEffectsBefore, "observation does not finalize or clean any spool");
  if (observationCase !== "current" && observationCase !== "takeover") {
    assert.ok(recoveryError instanceof Error, observationCase);
    assert.deepEqual(kernel.store.readBySession("stream-1"), expected, "refused observation leaves the blocked record unchanged");
    assert.deepEqual(effects, [], "refused observation creates no downstream effects");
    return;
  }
  assert.deepEqual(effects, ["channel reattach", "backend release", "isolation release"]);
  assert.equal(recoveryError, undefined, JSON.stringify(errorGraph(recoveryError)));
  stage = "final assertions";

  const released = kernel.store.readBySession("stream-1")!;
  const evidence = released.effects.find((effect) => effect.kind === "cleanup")?.progress?.resources
    .find((resource) => resource.resource === "evidence");
  assert.equal(released.state, "released");
  assert.equal(evidence?.status, "verified");
  assert.equal(evidence?.attempts, afterEvidence?.attempts);
  assert.equal(evidence?.evidence?.digest, finalized.manifestHash);
  assert.equal(evidence?.evidence?.lossy, true, "the deliberate spill-open fault is explicit durable loss");
  assert.deepEqual(delivered, [{ stream: "stdout", bytes }], "cleanup replay never reaches family delivery");
  assert.equal(spools.length, 2, "live and cleanup continuations use two real shared-root spools");
  assert.equal(spillOpenAttempts, 2, "both real spools reach the nonfatal spill-open fault");
  await assert.rejects(lstat(join(root, "spool")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("cleanup subscription failure keeps active-checkpoint evidence open for exact retry", async () => {
  let currentDrain: Promise<void> = Promise.resolve();
  let subscriptionAttempts = 0;
  let cleanupChannelDetaches = 0;
  const originalBytes = Buffer.from("original");
  const suffixBytes = Buffer.from("suffix");
  const original = {
    stream: "stdout" as const,
    sequence: 1,
    startOffset: 0,
    endOffset: originalBytes.byteLength,
    byteLength: originalBytes.byteLength,
    digest: createHash("sha256").update(originalBytes).digest("hex"),
  };
  const suffix = {
    stream: "stdout" as const,
    sequence: 2,
    startOffset: original.endOffset,
    endOffset: original.endOffset + suffixBytes.byteLength,
    byteLength: suffixBytes.byteLength,
    digest: createHash("sha256").update(suffixBytes).digest("hex"),
  };
  const writes: Buffer[] = [];
  let spoolCreations = 0;
  let finalizations = 0;
  const fixture = await makeFixture(
    2,
    "cleaned",
    undefined,
    [],
    4,
    undefined,
    async () => {
      await currentDrain;
      return "cleaned";
    },
  );
  fixture.setEvidenceSpool(() => {
    spoolCreations++;
    return {
      write: async (_stream, bytes) => { writes.push(Buffer.from(bytes)); },
      finalize: async () => {
        finalizations++;
        return { streams: [{ stream: "stdout", totalBytes: Buffer.concat(writes).byteLength }] };
      },
      cleanup: async () => undefined,
    };
  });
  fixture.setReattach(async (binding) => ({
    version: 2,
    binding,
    replayCapacityChunks: 4,
    replayCapacityBytes: 16,
    retainedWindow: [original, suffix],
    channel: {
      subscribeBackpressuredOutput: (sink) => {
        subscriptionAttempts++;
        if (subscriptionAttempts === 1) throw new Error("injected cleanup subscription failure");
        currentDrain = (async () => {
          await sink(original, originalBytes);
          await sink(suffix, suffixBytes);
        })();
        void currentDrain.catch(() => undefined);
        return () => undefined;
      },
      observeTerminal: () => () => undefined,
      settleBackpressuredOutput: async () => { await currentDrain; return { status: "settled" }; },
      detach: async () => { cleanupChannelDetaches++; await currentDrain; },
    },
  }));
  const facade = await fixture.runtime.open(fixture.request);
  const emitted = fixture.emit({ metadata: original, bytes: originalBytes, acknowledge: async () => undefined });
  void emitted.catch(() => undefined);
  await waitUntil(() => writes.length === 1);
  const operation = { sessionId: "stream-1", operation: "stop" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };

  await assert.rejects(
    facade.stop(facade.authorizeFirstOperation(operation), { ...operation, binding: fixture.request.binding }),
    (error) => error instanceof StreamingProcessSessionError && error.code === "cleanup_blocked",
  );
  await assert.rejects(emitted);
  assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "cleanup_blocked");
  assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1")?.outcome, "active");
  assert.equal(cleanupChannelDetaches, 1, "failed setup detaches its exact temporary channel");
  assert.equal(finalizations, 0, "active retry authority keeps the shared evidence continuation open");

  await fixture.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 100 });

  assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "released");
  assert.equal(subscriptionAttempts, 2);
  assert.equal(spoolCreations, 1);
  assert.equal(finalizations, 1);
  assert.deepEqual(Buffer.concat(writes), Buffer.concat([originalBytes, suffixBytes]));
});

test("an intake failure unwinds while unknown output retains the channel and evidence", async () => {
  const fixture = await makeFixture(2, "cleaned");
  let backendReleases = 0;
  fixture.runtimeOptions.host.release = async () => { backendReleases++; return "verified"; };
  let detaches = 0;
  let outputTail: Promise<void> = Promise.resolve();
  let releaseEmergency!: () => void;
  const emergency = new Promise<void>((resolve) => { releaseEmergency = resolve; });
  let emit!: (
    metadata: import("../src/streaming-output-controller.js").StreamingOutputMetadata,
    bytes: Uint8Array,
  ) => Promise<import("../src/streaming-output-controller.js").StreamingOutputMetadata>;
  fixture.setChannelAcquire(async () => ({
    subscribeBackpressuredOutput: (sink) => {
      emit = (metadata, bytes) => {
        const current = Promise.resolve().then(() => sink(metadata, bytes));
        outputTail = current.then(() => undefined, () => undefined);
        return current;
      };
      return () => undefined;
    },
    observeTerminal: () => () => undefined,
    detach: async () => { detaches++; await Promise.race([outputTail, emergency]); },
  }));
  await fixture.runtime.open(fixture.request);
  const bytes = Buffer.alloc(17);
  const metadata = {
    stream: "stdout" as const,
    sequence: 1,
    startOffset: 0,
    endOffset: bytes.byteLength,
    byteLength: bytes.byteLength,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
  const intake = emit(metadata, bytes);
  let primaryFailure: unknown;
  try {
    const outcome = await Promise.race([
      intake.then(
        () => ({ kind: "resolved" as const }),
        (error) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), 100)),
    ]);
    assert.notEqual(outcome.kind, "timeout", "the failing sink must unwind before channel detach awaits its output tail");
    assert.equal(outcome.kind, "rejected");
    assert.equal((outcome.error as { name?: unknown }).name, "StreamingOutputError");
    assert.equal((outcome.error as { code?: unknown }).code, "outcome_unknown");
  } catch (error) {
    primaryFailure = error;
  } finally {
    // RED teardown releases only the synthetic tail barrier so the in-memory
    // cleanup can finish without suppressing the original bounded assertion.
    releaseEmergency();
    await intake.catch(() => undefined);
    await waitUntil(() => fixture.kernel.store.readBySession("stream-1")?.state === "cleanup_blocked");
  }
  assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "cleanup_blocked", "unknown intake cannot manufacture a released session");
  if (primaryFailure) throw primaryFailure;
  const checkpoint = fixture.kernel.store.readOutputCheckpoint("stream-1")!;
  assert.equal(checkpoint.outcome, "outcome_unknown");
  assert.deepEqual(checkpoint.streams.find((stream) => stream.stream === "stdout")!.accepted, [metadata],
    "checkpoint metadata survives queue rejection without claiming consumption");
  assert.ok(checkpoint.streams.every((stream) => stream.consumed.length === 0 && stream.consumingIntent === null));
  const facts = fixture.kernel.store.readBySession("stream-1")!.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources;
  assert.equal(facts[0]!.status, "blocked");
  assert.equal(facts[0]!.blocker?.code, "output_settlement_unavailable");
  assert.ok(facts.slice(1).every((fact) => fact.status === "pending" && fact.attempts === 0));
  assert.equal(fixture.finalizeCalls, 0, "unknown unaccepted output retains evidence authority");
  assert.equal(detaches, 0, "unverified output retains the channel");
  assert.equal(fixture.releaseCalls, 0, "unverified output retains isolation");
  assert.equal(backendReleases, 0, "unverified output retains backend authority");
});

test("a pre-adoption intake failure unwinds before launch cleanup awaits the active handshake", async () => {
  const fixture = await makeFixture(2, "cleaned");
  const bytes = Buffer.alloc(17);
  const metadata = {
    stream: "stdout" as const,
    sequence: 1,
    startOffset: 0,
    endOffset: bytes.byteLength,
    byteLength: bytes.byteLength,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
  fixture.setHandshake(async () => {
    await fixture.emit({ metadata, bytes, acknowledge: async () => undefined });
    return "b".repeat(64);
  });

  const outcome = await Promise.race([
    fixture.runtime.open(fixture.request).then(
      () => ({ kind: "resolved" as const }),
      (error) => ({ kind: "rejected" as const, error }),
    ),
    new Promise<{ kind: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout" }), 100)),
  ]);

  assert.notEqual(outcome.kind, "timeout", "the failing sink must unwind before pre-adoption cleanup awaits the handshake effect");
  assert.equal(outcome.kind, "rejected");
  assert.ok(outcome.error instanceof StreamingProcessSessionError);
  assert.equal(outcome.error.code, "handshake_refused");
  assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "cleanup_blocked", "a corrupted output checkpoint cannot certify terminal settlement");
  assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1")?.outcome, "outcome_unknown");
});

test("oversized asynchronous output settles into blocked cleanup without finalization", async () => {
  const fixture = await makeFixture(2, "cleaned");
  let backendReleases = 0;
  fixture.runtimeOptions.host.release = async () => { backendReleases++; return "verified"; }; await fixture.runtime.open(fixture.request);
  const bytes = Buffer.alloc(17); const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 17, byteLength: 17, digest: createHash("sha256").update(bytes).digest("hex") };
  await assert.rejects(fixture.emit({ metadata, bytes, acknowledge: async () => assert.fail("no ack") }));
  await waitUntil(() => fixture.kernel.store.readBySession("stream-1")?.state === "cleanup_blocked");
  assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "cleanup_blocked");
  assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1")?.outcome, "outcome_unknown");
  const checkpoint = fixture.kernel.store.readOutputCheckpoint("stream-1")!;
  assert.deepEqual(checkpoint.streams.find((stream) => stream.stream === "stdout")!.accepted, [metadata],
    "checkpoint metadata survives queue rejection without claiming consumption");
  assert.ok(checkpoint.streams.every((stream) => stream.consumed.length === 0 && stream.consumingIntent === null));
  const facts = fixture.kernel.store.readBySession("stream-1")!.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources;
  assert.equal(facts[0]!.status, "blocked");
  assert.equal(facts[0]!.blocker?.code, "output_settlement_unavailable");
  assert.ok(facts.slice(1).every((fact) => fact.status === "pending" && fact.attempts === 0));
  assert.equal(fixture.detachCalls, 0); assert.equal(fixture.finalizeCalls, 0); assert.equal(fixture.releaseCalls, 0); assert.equal(backendReleases, 0);
});

test("unverified adopted host cleanup preserves blocked disposition instead of claiming release", async () => {
  const fixture = await makeFixture(2, "blocked"); const facade = await fixture.runtime.open(fixture.request);
  const operation = { sessionId: "stream-1", operation: "stop" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
  await assert.rejects(facade.stop(facade.authorizeFirstOperation(operation), { ...operation, binding: fixture.request.binding }), (error) => error instanceof StreamingProcessSessionError && error.code === "cleanup_blocked");
  const blocked = fixture.kernel.store.readBySession("stream-1")!;
  assert.equal(blocked.state, "cleanup_blocked");
  assert.equal(blocked.effects.find((effect) => effect.kind === "cleanup")?.progress?.resources[0]?.blocker?.code, "cleanup_authority_unavailable");
  assert.equal(fixture.releaseCalls, 0, "backend release cannot run before workload quiescence is verified");
});

test("adopted cleanup never exposes provider error graphs to its caller", async () => {
  const sentinel = "credential=R6_ADOPTED_CALLER_SENTINEL"; const fixture = await makeFixture(2, "cleaned");
  fixture.setChannelAcquire(async () => ({ subscribeBackpressuredOutput: () => () => undefined, observeTerminal: () => () => undefined, detach: async () => { throw new AggregateError([new Error(sentinel)], `payload=${sentinel}`, { cause: new Error(`argv=${sentinel}`) }); } }));
  const facade = await fixture.runtime.open(fixture.request);
  const operation = { sessionId: "stream-1", operation: "stop" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
  const thrown = await facade.stop(facade.authorizeFirstOperation(operation), { ...operation, binding: fixture.request.binding }).then(() => assert.fail("cleanup must fail"), (error: unknown) => error);
  const inspect = (error: unknown): unknown => error instanceof AggregateError ? { message: error.message, cause: inspect(error.cause), errors: error.errors.map(inspect) } : error instanceof Error ? { message: error.message, cause: inspect(error.cause) } : error;
  assert.doesNotMatch(JSON.stringify(inspect(thrown)), /R6_ADOPTED_CALLER_SENTINEL|credential=|payload=|argv=/);
  assert.equal(thrown instanceof StreamingProcessSessionError && thrown.code, "cleanup_blocked");
});

test("provider-created exported runtime errors are foreign and cannot cross the launch boundary", async () => {
  const sentinel = "credential=B1_R7_TYPED_PROVIDER_SENTINEL"; const fixture = await makeFixture(2, "cleaned");
  fixture.setHostLaunch(async () => { throw new StreamingProcessSessionError("launch_failed", sentinel, { cause: new Error(`payload=${sentinel}`) }); });
  const thrown = await fixture.runtime.open(fixture.request).then(() => assert.fail("provider launch must fail"), (error: unknown) => error);
  assert.equal(thrown instanceof StreamingProcessSessionError && thrown.code, "launch_failed");
  assert.equal(thrown instanceof Error && thrown.message, "Streaming provider launch phase failed.");
  assert.equal(thrown instanceof Error && thrown.cause, undefined);
  assert.doesNotMatch(JSON.stringify(errorGraph(thrown)), /B1_R7_TYPED_PROVIDER_SENTINEL|credential=|payload=|cause/);
});

test("replayed Runner errors are reminted from immutable private claims at every boundary", { timeout: 5_000 }, async (t) => withSyntheticFixtureEvidence(t, async (evidence) => {
  const sentinel = "credential=B1_R7_REPLAY";
  const mintRecoveryBoundError = async () => {
    const source = await makeFixture(2, "cleaned");
    const error = await source.runtime.reconcileStartup({ maxRecords: 0 }).then(() => assert.fail("recovery bound must fail"), (failure: unknown) => failure);
    assert.deepEqual(runtimeErrorFact(error), { code: "launch_failed", message: "Recovery count bound is invalid." });
    return error as StreamingProcessSessionError;
  };
  const mutate = (error: StreamingProcessSessionError) => {
    Object.defineProperties(error, {
      code: { configurable: true, value: "cleanup_blocked", writable: true },
      message: { configurable: true, value: sentinel, writable: true },
      cause: { configurable: true, value: { payload: sentinel }, writable: true },
    });
  };
  const assertSafeRemint = (actual: unknown, replayed: StreamingProcessSessionError, expected: { readonly code: string; readonly message: string }, label: string) => {
    assert.notEqual(actual, replayed, `${label} must not return the replayed object`);
    assert.deepEqual(runtimeErrorFact(actual), expected, label);
    assert.doesNotMatch(JSON.stringify(errorGraph(actual)), /B1_R7_REPLAY|credential=|payload=/, label);
  };

  const replayedLaunch = await mintRecoveryBoundError(); mutate(replayedLaunch);
  const normal = await makeFixture(2, "cleaned"); normal.setHostLaunch(async () => { throw replayedLaunch; });
  const normalError = await normal.runtime.open(normal.request).then(() => assert.fail("replayed launch must fail"), (error: unknown) => error);
  assertSafeRemint(normalError, replayedLaunch, { code: "launch_failed", message: "Recovery count bound is invalid." }, "normal");

  const replayedCancellation = await mintRecoveryBoundError(); mutate(replayedCancellation); let providerCancelled = false;
  const cancellationSignal = {
    get aborted() { return providerCancelled; }, reason: undefined, onabort: null,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, throwIfAborted() { if (providerCancelled) throw new Error("cancelled"); },
  } as AbortSignal;
  const cancellation = await makeFixture(2, "cleaned"); cancellation.setHostLaunch(async () => { providerCancelled = true; throw replayedCancellation; });
  const cancellationError = await cancellation.runtime.open({ ...cancellation.request, signal: cancellationSignal }).then(() => assert.fail("replayed cancellation must fail"), (error: unknown) => error);
  assertSafeRemint(cancellationError, replayedCancellation, { code: "launch_failed", message: "Recovery count bound is invalid." }, "cancellation");

  const replayedDelivery = await mintRecoveryBoundError(); mutate(replayedDelivery);
  const delivery = await makeFixture(2, "cleaned"); delivery.setDeliver(async () => { throw replayedDelivery; });
  const facade = await delivery.runtime.open(delivery.request); const bytes = Buffer.from("x");
  const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1, digest: createHash("sha256").update(bytes).digest("hex") };
  const emitted = delivery.emit({ metadata, bytes, acknowledge: async () => undefined }); emitted.catch(() => undefined); await new Promise((resolve) => setImmediate(resolve));
  const operation = { sessionId: "stream-1", operation: "family_delivery" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
  const deliveryError = await facade.deliverOutput(facade.authorizeFirstOperation(operation), { ...operation, binding: delivery.request.binding }).then(() => assert.fail("replayed delivery must fail"), (error: unknown) => error);
  await assert.rejects(emitted);
  assertSafeRemint(deliveryError, replayedDelivery, { code: "launch_failed", message: "Streaming output delivery failed." }, "delivery");

  const replayedCleanup = await mintRecoveryBoundError(); mutate(replayedCleanup);
  let replayedCleanupCalls = 0;
  const cleanup = await makeFixture(2, "cleaned", undefined, [], 4, undefined, async () => { replayedCleanupCalls++; throw replayedCleanup; }, undefined, { evidence });
  cleanup.setChannelAcquire(async () => { throw new Error("force cleanup"); });
  const cleanupError = await cleanup.runtime.open(cleanup.request).then(() => assert.fail("cleanup classification must fail"), (error: unknown) => error);
  assert.equal(replayedCleanupCalls, 1, "authenticated bootstrap must reach the intended cleanup error boundary");
  const cleanupFacts = cleanup.kernel.store.readHostLaunch("launch-1")?.effects.find((effect) => effect.kind === "cleanup")?.resources ?? [];
  assert.deepEqual(cleanupFacts.find((fact) => fact.resource === "host")?.failure, { code: "cleanup_timeout_or_cancelled", message: "Cleanup timed out or was cancelled." });
  assert.deepEqual(runtimeErrorFact(cleanupError), { code: "launch_failed", message: "Streaming provider launch phase failed." });
  assert.doesNotMatch(JSON.stringify({ caller: errorGraph(cleanupError), durable: durableGraph(cleanup) }), /B1_R7_REPLAY|credential=|payload=/);
}));

test("foreign error shapes are sanitized at every launch provider boundary", { timeout: 5_000 }, async () => {
  const phases = ["isolation", "host", "channel", "handshake", "output_start"] as const;
  for (const phase of phases) for (const [shape, makeForeign] of foreignErrorFactories()) {
    const fixture = await makeFixture(2, "cleaned");
    if (phase === "isolation") fixture.setIsolationAcquire(async () => { throw makeForeign(); });
    if (phase === "host") fixture.setHostLaunch(async () => { throw makeForeign(); });
    if (phase === "channel") fixture.setChannelAcquire(async () => { throw makeForeign(); });
    if (phase === "handshake") fixture.setHandshake(async () => { throw makeForeign(); });
    if (phase === "output_start") fixture.setEvidenceSpool(() => { throw makeForeign(); });
    const thrown = await fixture.runtime.open(fixture.request).then(() => assert.fail(`${phase}/${shape} must fail`), (error: unknown) => error);
    const expectedCode = phase === "handshake" ? "handshake_refused" : "launch_failed";
    const expectedMessage = phase === "handshake" ? "Streaming handshake was refused." : "Streaming provider launch phase failed.";
    assert.equal(thrown instanceof StreamingProcessSessionError && thrown.code, expectedCode, `${phase}/${shape}`);
    assert.equal(thrown instanceof Error && thrown.message, expectedMessage, `${phase}/${shape}`);
    assert.equal(thrown instanceof Error && thrown.cause, undefined, `${phase}/${shape}`);
    assertNoForeignSentinel({ caller: errorGraph(thrown), durable: durableGraph(fixture) }, `${phase}/${shape}`);
  }
});

test("foreign error shapes are sanitized at output delivery, cleanup, and cancellation boundaries", { timeout: 5_000 }, async () => {
  for (const [shape, makeForeign] of foreignErrorFactories()) {
    const delivery = await makeFixture(2, "cleaned"); delivery.setDeliver(async () => { throw makeForeign(); });
    const facade = await delivery.runtime.open(delivery.request); const bytes = Buffer.from("x");
    const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1, digest: createHash("sha256").update(bytes).digest("hex") };
    const emitted = delivery.emit({ metadata, bytes, acknowledge: async () => undefined }); emitted.catch(() => undefined); await new Promise((resolve) => setImmediate(resolve));
    const operation = { sessionId: "stream-1", operation: "family_delivery" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
    const deliveryError = await facade.deliverOutput(facade.authorizeFirstOperation(operation), { ...operation, binding: delivery.request.binding }).then(() => assert.fail(`delivery/${shape} must fail`), (error: unknown) => error);
    assert.deepEqual(runtimeErrorFact(deliveryError), { code: "launch_failed", message: "Streaming output delivery failed." }, `delivery/${shape}`);
    assertNoForeignSentinel({ caller: errorGraph(deliveryError), durable: durableGraph(delivery) }, `delivery/${shape}`);

    const cleanup = await makeFixture(2, "cleaned");
    cleanup.setChannelAcquire(async () => ({ subscribeBackpressuredOutput: () => () => undefined, observeTerminal: () => () => undefined, detach: async () => { throw makeForeign(); } }));
    const cleanupFacade = await cleanup.runtime.open(cleanup.request); const stop = { sessionId: "stream-1", operation: "stop" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
    const cleanupError = await cleanupFacade.stop(cleanupFacade.authorizeFirstOperation(stop), { ...stop, binding: cleanup.request.binding }).then(() => assert.fail(`cleanup/${shape} must fail`), (error: unknown) => error);
    assert.equal(cleanupError instanceof StreamingProcessSessionError && cleanupError.code, "cleanup_blocked", `cleanup/${shape}`);
    assertNoForeignSentinel({ caller: errorGraph(cleanupError), durable: durableGraph(cleanup) }, `cleanup/${shape}`);

    const cancellation = await makeFixture(2, "cleaned"); let providerCancelled = false;
    const cancellationSignal = {
      get aborted() { return providerCancelled; }, reason: undefined, onabort: null,
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, throwIfAborted() { if (providerCancelled) throw new Error("cancelled"); },
    } as AbortSignal;
    cancellation.setHostLaunch(async () => { providerCancelled = true; throw makeForeign(); });
    const cancelled = await cancellation.runtime.open({ ...cancellation.request, signal: cancellationSignal }).then(() => assert.fail(`cancellation/${shape} must fail`), (error: unknown) => error);
    assert.equal(cancelled instanceof StreamingProcessSessionError && cancelled.code, "cancelled", `cancellation/${shape}`);
    assert.equal(cancelled instanceof Error && cancelled.message, "Streaming launch was cancelled.", `cancellation/${shape}`);
    assert.equal(cancelled instanceof Error && cancelled.cause, undefined, `cancellation/${shape}`);
    assertNoForeignSentinel({ caller: errorGraph(cancelled), durable: durableGraph(cancellation) }, `cancellation/${shape}`);
  }
});

test("internally minted runtime errors retain their fixed safe distinctions", async () => {
  const lossless = await makeFixture(1, "cleaned");
  const losslessError = await lossless.runtime.open(lossless.request).then(() => assert.fail("lossless refusal expected"), (error: unknown) => error);
  assert.deepEqual(runtimeErrorFact(losslessError), { code: "lossless_output_unavailable", message: "Selected channel does not attest the exact aggregate lossless output v2 window." });
  const aborted = await makeFixture(2, "cleaned"); const abort = new AbortController(); abort.abort();
  const cancelled = await aborted.runtime.open({ ...aborted.request, signal: abort.signal }).then(() => assert.fail("cancellation expected"), (error: unknown) => error);
  assert.deepEqual(runtimeErrorFact(cancelled), { code: "cancelled", message: "Streaming operation was cancelled." });
  const handshake = await makeFixture(2, "cleaned"); handshake.setHandshake(async () => { throw new Error("foreign handshake"); });
  const handshakeError = await handshake.runtime.open(handshake.request).then(() => assert.fail("handshake refusal expected"), (error: unknown) => error);
  assert.deepEqual(runtimeErrorFact(handshakeError), { code: "handshake_refused", message: "Streaming handshake was refused." });
  const cleanup = await makeFixture(2, "blocked"); const cleanupFacade = await cleanup.runtime.open(cleanup.request); const stop = { sessionId: "stream-1", operation: "stop" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
  const cleanupError = await cleanupFacade.stop(cleanupFacade.authorizeFirstOperation(stop), { ...stop, binding: cleanup.request.binding }).then(() => assert.fail("cleanup refusal expected"), (error: unknown) => error);
  assert.deepEqual(runtimeErrorFact(cleanupError), { code: "cleanup_blocked", message: "Adopted streaming session cleanup failed." });
});

test("live grant revocation at every pre-adoption phase settles one exact cleanup", async (t) => withSyntheticFixtureEvidence(t, async (evidence) => {
  for (const phase of ["isolate", "launch", "channel", "output", "handshake"] as const) {
    const fixture = await makeFixture(2, "cleaned", undefined, [], 4, phase, undefined, undefined, { evidence });
    await assert.rejects(fixture.runtime.open(fixture.request), (error) => error instanceof StreamingProcessSessionError && ["launch_failed", "handshake_refused"].includes(error.code));
    assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "released", phase);
    assert.equal(fixture.releaseCalls, 1, phase);
  }
}));

test("active cancellation at every provider boundary releases late-returned resources", async (t) => withSyntheticFixtureEvidence(t, async (evidence) => {
  for (const phase of ["isolate", "launch", "channel", "output", "handshake"]) {
    const abort = new AbortController();
    const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, (current) => { if (current === phase) abort.abort(); }, { evidence });
    await assert.rejects(fixture.runtime.open({ ...fixture.request, signal: abort.signal }));
    await waitUntil(() => fixture.kernel.store.readHostLaunch("launch-1")?.state === "released");
    assert.equal(fixture.releaseCalls, 1, phase);
    assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "released", phase);
    assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1"), undefined, phase);
    if (["channel", "output", "handshake"].includes(phase)) assert.equal(fixture.detachCalls, 2, "the original capability and evidence-only terminal reader each detach exactly once");
  }
}));

test("startup recovery spends one total deadline and every inspected terminal row consumes the count bound", async () => {
  let current = new Date(now);
  let cleanupCalls = 0;
  const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, async () => {
    cleanupCalls++; current = new Date(current.getTime() + 15); return "cleaned";
  }, undefined, { clock: () => current });
  fixture.kernelWriter.prepareLaunch(fixture.preparedRecord("aaa-terminal", "terminal-session"));
  let terminal = fixture.kernel.store.readHostLaunch("aaa-terminal")!;
  terminal = fixture.kernelWriter.transitionLaunch({ type: "begin_cleanup", launchId: "aaa-terminal", ownerId: terminal.ownerId, fencingToken: 1, expectedRevision: terminal.revision, at: now });
  fixture.kernelWriter.transitionLaunch({ type: "settle_cleanup_cleaned", launchId: "aaa-terminal", ownerId: terminal.ownerId, fencingToken: 1, expectedRevision: terminal.revision, results: [{ resource: "host", identity: "host:aaa-terminal", ownerId: terminal.ownerId, fencingToken: 1, status: "succeeded" }], at: now });
  fixture.kernelWriter.prepareLaunch(fixture.preparedRecord("zzz-pending-a", "pending-a-session")); fixture.kernelWriter.prepareLaunch(fixture.preparedRecord("zzz-pending-b", "pending-b-session")); fixture.kernelWriter.prepareLaunch(fixture.preparedRecord("zzz-pending-c", "pending-c-session"));
  const onlyTerminal = await fixture.runtime.reconcileStartup({ maxRecords: 1, timeoutMs: 20 });
  assert.equal(onlyTerminal.processed, 1); assert.deepEqual(onlyTerminal.outcomes, []);
  const result = await fixture.runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 20 });
  assert.equal(cleanupCalls, 2, "the third pending row cannot start after the first two consume the single deadline");
  assert.equal(result.processed, 4);
});

test("late reattach channel after recovery timeout is deterministically detached", async () => {
  const fixture = await makeFixture(); await fixture.runtime.open(fixture.request);
  let resolveLate!: () => void; let lateDetach = 0;
  fixture.setReattach(async (binding) => await new Promise((resolve) => { resolveLate = () => resolve({ version: 2, binding, replayCapacityChunks: 4, replayCapacityBytes: 16, retainedWindow: [], channel: { subscribeBackpressuredOutput: () => () => undefined, observeTerminal: () => () => undefined, detach: async () => { lateDetach++; } } }); }));
  const recovery = fixture.createRecoveryRuntime(); const result = await recovery.reconcileStartup({ maxRecords: 4, timeoutMs: 10 });
  assert.equal(result.sessionOutcomes[0]?.disposition, "input_unavailable");
  resolveLate(); await waitUntil(() => lateDetach === 1); assert.equal(lateDetach, 1);
  assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "input_unavailable");
  fixture.setReattach(async (binding) => emptyReattachment(binding));
  const next = await recovery.reconcileStartup({ maxRecords: 4, timeoutMs: 100 });
  assert.deepEqual(next.sessionOutcomes, [{ sessionId: "stream-1", disposition: "cleanup_blocked", cleanupBlocked: true }]);
  await waitUntil(() => fixture.kernel.store.readBySession("stream-1")?.state === "cleanup_blocked");
  assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "cleanup_blocked");
  assert.equal(lateDetach, 1, "the already detached late channel is not replayed as adopted cleanup proof");
});

test("late reattach racing durable blocked and released states always detaches exactly once", async () => {
  for (const durableOutcome of ["blocked", "cleaned"] as const) {
    const fixture = await makeFixture(2, durableOutcome); await fixture.runtime.open(fixture.request);
    let resolveLate!: () => void; let lateDetach = 0;
    fixture.setReattach(async (binding) => await new Promise((resolve) => { resolveLate = () => resolve({ version: 2, binding, replayCapacityChunks: 4, replayCapacityBytes: 16, retainedWindow: [], channel: { subscribeBackpressuredOutput: () => () => undefined, observeTerminal: () => () => undefined, detach: async () => { lateDetach++; } } }); }));
    const recovery = fixture.createRecoveryRuntime();
    const result = await recovery.reconcileStartup({ maxRecords: 4, timeoutMs: 10 });
    assert.equal(result.sessionOutcomes[0]?.disposition, "input_unavailable");
    fixture.setReattach(async (binding) => emptyReattachment(binding));
    const exactCleanup = fixture.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 100 });
    if (durableOutcome === "blocked") await assert.rejects(exactCleanup, /cleanup/i);
    else await exactCleanup;
    resolveLate(); await waitUntil(() => lateDetach === 1);
    assert.equal(lateDetach, 1, durableOutcome);
    assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, durableOutcome === "cleaned" ? "released" : "cleanup_blocked");
    const subsequent = await recovery.reconcileStartup({ maxRecords: 4, timeoutMs: 100 });
    assert.equal(lateDetach, 1, `${durableOutcome}: successful detach must not enter retry cleanup`);
    assert.deepEqual(subsequent.lateCleanupFailures, []);
  }
});

test("failed late reattach cleanup is retained, surfaced, and retried without double successful detach", async () => {
  const fixture = await makeFixture(); await fixture.runtime.open(fixture.request);
  let resolveLate!: () => void; let lateDetach = 0;
  fixture.setReattach(async (binding) => await new Promise((resolve) => { resolveLate = () => resolve({ version: 2, binding, replayCapacityChunks: 4, replayCapacityBytes: 16, retainedWindow: [], channel: { subscribeBackpressuredOutput: () => () => undefined, observeTerminal: () => () => undefined, detach: async () => { lateDetach++; if (lateDetach === 1) throw new Error("late detach failed"); } } }); }));
  const recovery = fixture.createRecoveryRuntime(); await recovery.reconcileStartup({ maxRecords: 4, timeoutMs: 10 });
  resolveLate(); await waitUntil(() => lateDetach === 1); await new Promise((resolve) => setImmediate(resolve));
  fixture.setReattach(async (binding) => emptyReattachment(binding));
  const retried = await recovery.reconcileStartup({ maxRecords: 4, timeoutMs: 100 });
  assert.equal(retried.lateCleanupFailures.length, 1);
  assert.equal(retried.lateCleanupFailures[0]?.sessionId, "stream-1");
  assert.equal(retried.lateCleanupFailures[0]?.message, "Streaming channel detach failed.");
  assert.equal(lateDetach, 2, "one failed detach and one successful retry");
});

test("recovery creates an attachment with the exact current non-one owner fence", async () => {
  const fixture = await makeFixture(); const opened = await fixture.runtime.open(fixture.request); void opened;
  const source = fixture.kernel.store.readBySession("stream-1")!; const checkpoint = fixture.kernel.store.readOutputCheckpoint("stream-1")!;
  fixture.kernelWriter.takeoverAdoptedWithOutput({ sessionId: "stream-1", ownerId: source.ownerId, fencingToken: source.fencingToken, expectedRevision: source.revision, outputExpectedRevision: checkpoint.revision, newOwnerId: "recovery-owner", newFencingToken: 2, leaseExpiresAt: "2026-08-30T00:03:00.000Z", at: "2026-08-30T00:02:00.000Z" });
  const authority = createSessionAuthority({ grants: fixture.grants, sessions: fixture.kernel, clock: () => new Date("2026-08-30T00:02:00.000Z") });
  const runtime = createStreamingProcessSessionRuntime({ ...fixture.runtimeOptions, sessions: authority, kernel: fixture.kernel, clock: () => new Date("2026-08-30T00:02:00.000Z") });
  const result = await runtime.reconcileStartup({ maxRecords: 2, timeoutMs: 100 });
  assert.deepEqual(result.sessionOutcomes, [{ sessionId: "stream-1", disposition: "reattached" }]);
  assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1")?.fencingToken, 2);
});

test("adopted recovery advances the private backend fence from handed-off host provenance", async () => {
  const fixture = await makeFixture();
  const facade = await fixture.runtime.open(fixture.request);
  let observedFence: Readonly<{ ownerId: string; fencingToken: number }> | undefined;
  const originalReattach = fixture.runtimeOptions.channel.reattach!;
  const recovery = createStreamingProcessSessionRuntime({
    ...fixture.runtimeOptions,
    channel: {
      ...fixture.runtimeOptions.channel,
      reattach: async (binding, fence) => {
        observedFence = fence;
        return await originalReattach(binding);
      },
    },
  });

  const result = await recovery.reconcileStartup({ maxRecords: 4, timeoutMs: 100 });

  assert.deepEqual(result.sessionOutcomes, [{ sessionId: "stream-1", disposition: "reattached" }]);
  assert.deepEqual(observedFence, { ownerId: facade.record.ownerId, fencingToken: 2 });
  assert.equal(fixture.kernel.store.readBySession("stream-1")?.ownerId.startsWith("session-authority:"), true);
});

test("adopted stop reconciles the private backend with its handed-off host record and advanced fence", async () => {
  const fixture = await makeFixture();
  let reconciledInput: unknown;
  const runtime = createStreamingProcessSessionRuntime({
    ...fixture.runtimeOptions,
    host: {
      ...fixture.runtimeOptions.host,
      quiesce: async (input) => {
        reconciledInput = input;
        return "verified";
      },
    },
  });
  const facade = await runtime.open(fixture.request);
  const operation = { sessionId: "stream-1", operation: "stop" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };

  await facade.stop(facade.authorizeFirstOperation(operation), { ...operation, binding: fixture.request.binding });

  assert.deepEqual(
    pickHostControl(reconciledInput),
    {
      state: "handed_off",
      ownerId: "none",
      fencingToken: 1,
      launchId: "launch-1",
      sessionId: "stream-1",
      backendOwnerId: facade.record.ownerId,
      backendFencingToken: 2,
    },
  );
});

test("expired adopted recovery atomically takes over session and output fences before reattach", async () => {
  const fixture = await makeFixture(); await fixture.runtime.open(fixture.request);
  const authority = createSessionAuthority({ grants: fixture.grants, sessions: fixture.kernel, clock: () => new Date("2026-08-30T00:02:00.000Z") });
  const runtime = createStreamingProcessSessionRuntime({ ...fixture.runtimeOptions, sessions: authority, kernel: fixture.kernel, clock: () => new Date("2026-08-30T00:02:00.000Z") });
  const result = await runtime.reconcileStartup({ maxRecords: 2, timeoutMs: 100 });
  assert.equal(result.sessionOutcomes[0]?.disposition, "reattached"); assert.equal(fixture.kernel.store.readBySession("stream-1")?.fencingToken, 2); assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1")?.fencingToken, 2);
});

test("authorized stop surfaces complete finalized spool evidence and finalize error blocks cleanup", async () => {
  const fixture = await makeFixture(2, "cleaned");
  const finalized: BoundedOutputSpoolResult = { streams: [{ stream: "stdout", tail: "tail", tailBytesBase64: "dGFpbA==", tailByteLength: 4, tailDisplayTruncated: false, totalBytes: 9, truncated: true, spillState: "artifact_ingested", spillArtifactId: "artifact-1", spillBytes: 5, lossyBytes: 1, lossyOutput: true, lossReasons: [{ code: "spill_cap_exceeded", stream: "stdout", lostBytes: 1 }] }] };
  fixture.setEvidenceSpool(() => ({ write: async () => undefined, finalize: async () => finalized, cleanup: async () => undefined }));
  const facade = await fixture.runtime.open(fixture.request); const operation = { sessionId: "stream-1", operation: "stop" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
  const stopped = await facade.stop(facade.authorizeFirstOperation(operation), { ...operation, binding: fixture.request.binding });
  assert.ok(stopped.evidence && "result" in stopped.evidence); assert.deepEqual(stopped.evidence.result, finalized); assert.equal(stopped.evidence.evidenceLossy, true);
  const failed = await makeFixture(2, "cleaned"); failed.setEvidenceSpool(() => ({ write: async () => undefined, finalize: async () => { throw new Error("finalize proof lost"); }, cleanup: async () => undefined }));
  const failedFacade = await failed.runtime.open(failed.request);
  await assert.rejects(failedFacade.stop(failedFacade.authorizeFirstOperation(operation), { ...operation, binding: failed.request.binding }), (error) => error instanceof StreamingProcessSessionError && error.code === "cleanup_blocked");
  assert.equal(failed.kernel.store.readBySession("stream-1")?.state, "cleanup_blocked");
});

test("abort returns promptly for a never-settling provider and supervises a late resource", { timeout: 1_000 }, async () => {
  const fixture = await makeFixture(2, "cleaned"); let resolveIsolation!: (lease: ReturnType<typeof leaseRecord>) => void;
  fixture.setIsolationAcquire(async () => await new Promise((resolve) => { resolveIsolation = resolve; }));
  const abort = new AbortController(); const opening = fixture.runtime.open({ ...fixture.request, signal: abort.signal }); setTimeout(() => abort.abort(), 10);
  const started = Date.now(); await assert.rejects(opening); assert.ok(Date.now() - started < 200); assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "cleanup_blocked");
  resolveIsolation({ leaseId: "lease-1", providerId: "fake", invocationId: "invoke-1", providerIdentity: "a".repeat(64), acquiredAt: now, access: [] });
  await waitUntil(() => fixture.releaseCalls === 1); assert.equal(fixture.releaseCalls, 1);
});

test("abort is caller-bounded when every provider phase is permanently noncooperative", { timeout: 2_000 }, async (t) => withSyntheticFixtureEvidence(t, async (evidence) => {
  for (const phase of ["isolate", "launch", "channel", "handshake"] as const) {
    const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { evidence }); const never = async () => await new Promise<never>(() => undefined);
    if (phase === "isolate") fixture.setIsolationAcquire(never);
    if (phase === "launch") fixture.setHostLaunch(never);
    if (phase === "channel") fixture.setChannelAcquire(never);
    if (phase === "handshake") fixture.setHandshake(never);
    const abort = new AbortController(); const opening = fixture.runtime.open({ ...fixture.request, signal: abort.signal }); setTimeout(() => abort.abort(), 10);
    const started = Date.now(); await assert.rejects(opening); assert.ok(Date.now() - started < 200, phase); assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "cleanup_blocked", phase);
    if (phase !== "isolate") assert.equal(fixture.releaseCalls, 1, `${phase}: already-known lease must be released immediately`);
    assert.equal(fixture.calls.filter((call) => call === "reconcile").length, phase === "channel" ? 0 : 1, `${phase}: host cleanup must not compete with unresolved channel acquisition`);
    if (phase === "channel") assert.equal(fixture.reattachCalls, 0, "the pending original acquire owns the only channel capability");
    if (phase === "handshake") {
      assert.equal(fixture.detachCalls, 2, "handshake: initial and terminal readers detach after terminal settlement");
      assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1"), undefined, "handshake: pre-adoption checkpoint must settle immediately");
    }
  }
}));

test("late channel after immediate cancellation cleanup is detached without repeating known cleanup", { timeout: 1_000 }, async (t) => withSyntheticFixtureEvidence(t, async (evidence) => {
  const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { evidence }); let resolveChannel!: (channel: import("../src/streaming-process-session-runtime.js").FakeStreamingChannel) => void;
  fixture.setChannelAcquire(async () => await new Promise((resolve) => { resolveChannel = resolve; }));
  const abort = new AbortController(); const opening = fixture.runtime.open({ ...fixture.request, signal: abort.signal }); setTimeout(() => abort.abort(), 10);
  await assert.rejects(opening);
  assert.equal(fixture.releaseCalls, 1); assert.equal(fixture.calls.filter((call) => call === "reconcile").length, 0);
  assert.equal(fixture.reattachCalls, 0, "host/channel cleanup waits for the original acquisition");
  resolveChannel({ subscribeBackpressuredOutput: () => () => undefined, observeTerminal: () => () => undefined, detach: async () => { fixture.calls.push("late-detach"); } });
  await waitUntil(() => fixture.calls.includes("late-detach"));
  await waitUntil(() => fixture.kernel.store.readHostLaunch("launch-1")?.state === "released");
  assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "released");
  assert.equal(fixture.reattachCalls, 1); assert.equal(fixture.detachCalls, 1, "the terminal evidence reader also detaches");
  assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1"), undefined);
  assert.equal(fixture.calls.filter((call) => call === "late-detach").length, 1);
  assert.equal(fixture.releaseCalls, 1); assert.equal(fixture.calls.filter((call) => call === "reconcile").length, 1);
}));

test("noncooperative host reconciliation cannot delay cleanup of a late cancelled channel", { timeout: 1_000 }, async () => {
  const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, async () => await new Promise<"cleaned">(() => undefined));
  let resolveChannel!: (channel: import("../src/streaming-process-session-runtime.js").FakeStreamingChannel) => void; let lateDetach = 0;
  fixture.setChannelAcquire(async () => await new Promise((resolve) => { resolveChannel = resolve; }));
  const abort = new AbortController(); const opening = fixture.runtime.open({ ...fixture.request, signal: abort.signal }); setTimeout(() => abort.abort(), 10);
  const started = Date.now(); await assert.rejects(opening); assert.ok(Date.now() - started < 200);
  resolveChannel({ subscribeBackpressuredOutput: () => () => undefined, observeTerminal: () => () => undefined, detach: async () => { lateDetach++; } });
  await waitUntil(() => lateDetach === 1);
  assert.equal(lateDetach, 1); assert.equal(fixture.releaseCalls, 1);
  assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "cleanup_blocked");
});

test("failed late channel detach blocks host cleanup and remains inspectable across retry", { timeout: 1_000 }, async (t) => withSyntheticFixtureEvidence(t, async (evidence) => {
  const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { evidence }); let resolveChannel!: (channel: import("../src/streaming-process-session-runtime.js").FakeStreamingChannel) => void; let lateDetach = 0;
  fixture.setChannelAcquire(async () => await new Promise((resolve) => { resolveChannel = resolve; }));
  const abort = new AbortController(); const opening = fixture.runtime.open({ ...fixture.request, signal: abort.signal }); setTimeout(() => abort.abort(), 10);
  await assert.rejects(opening);
  resolveChannel({ subscribeBackpressuredOutput: () => () => undefined, observeTerminal: () => () => undefined, detach: async () => { lateDetach++; throw new Error("cancel late detach failed"); } });
  await waitUntil(() => lateDetach === 1); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "cleanup_blocked");
  const retry = await fixture.runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 100 });
  assert.equal(lateDetach, 2, "one failed retry per bounded recovery");
  assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "cleanup_blocked");
  const facts = fixture.kernel.store.readHostLaunch("launch-1")!.effects.find((effect) => effect.kind === "cleanup")!.resources!;
  assert.equal(facts.find((fact) => fact.resource === "channel")?.failure?.code, "channel_detach_failed");
  assert.equal(facts.find((fact) => fact.resource === "host")?.status, "failed");
  assert.equal(fixture.calls.filter((call) => call === "reconcile").length, 0, "an uncertain channel cannot certify host cleanup");
  assert.equal(fixture.releaseCalls, 1, "the independent known lease is not released twice");
  assert.equal(retry.lateCleanupFailures[0]?.message, "Host reconciliation failed.", "summary priority does not erase the exact durable channel blocker");
}));

test("successful retry of failed cancelled late detach releases once and never double-cleans", { timeout: 1_000 }, async (t) => withSyntheticFixtureEvidence(t, async (evidence) => {
  const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { evidence }); let resolveChannel!: (channel: import("../src/streaming-process-session-runtime.js").FakeStreamingChannel) => void; let lateDetach = 0;
  fixture.setChannelAcquire(async () => await new Promise((resolve) => { resolveChannel = resolve; }));
  const abort = new AbortController(); const opening = fixture.runtime.open({ ...fixture.request, signal: abort.signal }); setTimeout(() => abort.abort(), 10);
  await assert.rejects(opening);
  resolveChannel({ subscribeBackpressuredOutput: () => () => undefined, observeTerminal: () => () => undefined, detach: async () => { lateDetach++; if (lateDetach === 1) throw new Error("cancel late detach failed once"); } });
  await waitUntil(() => lateDetach === 1); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "cleanup_blocked");
  const retry = await fixture.runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 100 });
  assert.equal(lateDetach, 2); assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "released");
  assert.equal(retry.lateCleanupFailures[0]?.message, "Cleanup timed out or was cancelled.", "the preceding unresolved-acquisition summary remains inspectable on successful retry");
  assert.equal(fixture.releaseCalls, 1); assert.equal(fixture.reattachCalls, 1);
  assert.equal(fixture.calls.filter((call) => call === "reconcile").length, 1);
  assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1"), undefined);
  const after = await fixture.runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 100 });
  assert.equal(lateDetach, 2); assert.deepEqual(after.lateCleanupFailures, []);
}));

test("checkpoint-only cleanup failure stays durably blocked and retries the checkpoint before release", { timeout: 1_000 }, async () => {
  let checkpointDeletes = 0; let resolveHandshake!: (digest: string) => void;
  const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, {
    deleteOutputCheckpoint: () => { checkpointDeletes++; if (checkpointDeletes === 1) throw new Error("checkpoint cleanup failed once"); },
  });
  fixture.setHandshake(async () => await new Promise<string>((resolve) => { resolveHandshake = resolve; }));
  const abort = new AbortController(); const opening = fixture.runtime.open({ ...fixture.request, signal: abort.signal }); setTimeout(() => abort.abort(), 10);
  await assert.rejects(opening); await waitUntil(() => fixture.kernel.store.readHostLaunch("launch-1")?.state === "cleanup_blocked");
  assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1") !== undefined, true);
  const initiallyBlocked = fixture.kernel.store.readHostLaunch("launch-1")!; const initialFacts = initiallyBlocked.effects.find((effect) => effect.kind === "cleanup")?.resources ?? [];
  assert.equal(initialFacts.find((fact) => fact.resource === "output_checkpoint")?.status, "failed");
  assert.ok(initialFacts.every((fact) => fact.ownerId === initiallyBlocked.ownerId && fact.fencingToken === initiallyBlocked.fencingToken));
  resolveHandshake("b".repeat(64)); await new Promise((resolve) => setImmediate(resolve));
  const retry = await fixture.runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 100 });
  assert.equal(checkpointDeletes, 2, "recovery must retry the unresolved checkpoint cleanup");
  assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1"), undefined);
  assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "released");
  assert.equal(retry.lateCleanupFailures[0]?.message, "Cleanup timed out or was cancelled.");
});

test("cleanup failure persistence discards provider-controlled credential text", { timeout: 1_000 }, async () => {
  const sentinel = "credential=B1_R6_PRIVATE_SENTINEL"; let resolveHandshake!: (digest: string) => void;
  const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, {
    deleteOutputCheckpoint: () => { throw new AggregateError([new Error(sentinel)], `payload=${sentinel}`, { cause: new Error(`argv=${sentinel}`) }); },
  });
  fixture.setHandshake(async () => await new Promise<string>((resolve) => { resolveHandshake = resolve; }));
  const abort = new AbortController(); const opening = fixture.runtime.open({ ...fixture.request, signal: abort.signal }); setTimeout(() => abort.abort(), 10);
  await assert.rejects(opening); await waitUntil(() => fixture.kernel.store.readHostLaunch("launch-1")?.state === "cleanup_blocked");
  const serialized = JSON.stringify({
    hosts: fixture.kernel.store.listHostLaunchIds().map((id) => fixture.kernel.store.readHostLaunch(id)),
    sessions: fixture.kernel.store.listSessionIds().map((id) => fixture.kernel.store.readBySession(id)),
    output: fixture.kernel.store.readOutputCheckpoint("stream-1"),
  });
  assert.doesNotMatch(serialized, /B1_R6_PRIVATE_SENTINEL|credential=|payload=|argv=/);
  assert.match(serialized, /output_checkpoint_delete_failed/);
  resolveHandshake("b".repeat(64));
});

test("every cleanup resource family classifies aggregate, cause, path, environment, argv, payload, and arbitrary sentinels", { timeout: 2_000 }, async () => {
  const cases = [
    { family: "host", code: "host_reconciliation_failed", make: () => makeFixture(2, "cleaned", undefined, [], 4, undefined, async () => { throw new AggregateError([new Error("credential=R6_HOST")], "payload=R6_HOST", { cause: new Error("C:\\secret\\R6_HOST") }); }) },
    { family: "isolation_lease", code: "isolation_lease_release_failed", make: () => makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { releaseLease: async () => { throw new Error("env=R6_LEASE argv=--token=R6_LEASE"); } }) },
    { family: "output_checkpoint", code: "output_checkpoint_delete_failed", make: () => makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { deleteOutputCheckpoint: () => { throw { arbitrary: "R6_CHECKPOINT", payload: ["R6_CHECKPOINT"] }; } }) },
    { family: "channel", code: "channel_detach_failed", make: () => makeFixture(2, "cleaned") },
  ] as const;
  for (const entry of cases) {
    let resolveHandshake!: (digest: string) => void; const fixture = await entry.make();
    if (entry.family === "channel") fixture.setChannelAcquire(async () => ({ subscribeBackpressuredOutput: () => () => undefined, observeTerminal: () => () => undefined, detach: async () => { throw new AggregateError([new Error("token=R6_CHANNEL")], "endpoint=R6_CHANNEL", { cause: "R6_CHANNEL" }); } }));
    fixture.setHandshake(async () => await new Promise<string>((resolve) => { resolveHandshake = resolve; }));
    const abort = new AbortController(); const opening = fixture.runtime.open({ ...fixture.request, signal: abort.signal }); setTimeout(() => abort.abort(), 10);
    await assert.rejects(opening); await waitUntil(() => fixture.kernel.store.readHostLaunch("launch-1")?.state === "cleanup_blocked");
    const serialized = JSON.stringify({ host: fixture.kernel.store.readHostLaunch("launch-1"), sessions: fixture.kernel.store.listSessionIds().map((id) => fixture.kernel.store.readBySession(id)), output: fixture.kernel.store.readOutputCheckpoint("stream-1") });
    assert.doesNotMatch(serialized, /R6_HOST|R6_LEASE|R6_CHECKPOINT|R6_CHANNEL|credential=|token=|env=|argv=|payload|endpoint=|C:\\secret/);
    assert.match(serialized, new RegExp(entry.code)); resolveHandshake("b".repeat(64));
  }
});

test("SQLite cleanup failure rows and reopened records contain only fixed Runner-owned failure data", { timeout: 1_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-cleanup-sentinel-")); const path = join(root, "sessions.sqlite"); const key = Buffer.alloc(32, 17);
  let sqliteKernel = openSqliteStreamingSessionStore(path, key); let closed = false;
  try {
    const sentinel = "token=B1_R6_SQL_SENTINEL"; let resolveHandshake!: (digest: string) => void;
    const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, {
      kernel: sqliteKernel,
      deleteOutputCheckpoint: () => { throw new AggregateError([new Error(sentinel)], `env=${sentinel}`, { cause: { payload: sentinel } }); },
    });
    fixture.setHandshake(async () => await new Promise<string>((resolve) => { resolveHandshake = resolve; }));
    const abort = new AbortController(); const opening = fixture.runtime.open({ ...fixture.request, signal: abort.signal }); setTimeout(() => abort.abort(), 10);
    await assert.rejects(opening); await waitUntil(() => fixture.kernel.store.readHostLaunch("launch-1")?.state === "cleanup_blocked"); resolveHandshake("b".repeat(64));
    fixture.kernel.store.close(); closed = true;
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'streaming_%'").all() as Array<{ name: string }>;
      const cells = JSON.stringify(tables.flatMap(({ name }) => database.prepare(`SELECT * FROM ${name}`).all()));
      assert.doesNotMatch(cells, /B1_R6_SQL_SENTINEL|token=|env=|payload/); assert.match(cells, /output_checkpoint_delete_failed/);
    } finally { database.close(); }
    sqliteKernel = openSqliteStreamingSessionStore(path, key); closed = false;
    const reopened = JSON.stringify({ host: sqliteKernel.store.readHostLaunch("launch-1"), session: sqliteKernel.store.readBySession("stream-1"), output: sqliteKernel.store.readOutputCheckpoint("stream-1") });
    assert.doesNotMatch(reopened, /B1_R6_SQL_SENTINEL|token=|env=|payload/); assert.match(reopened, /Output checkpoint deletion failed\./);
    sqliteKernel.store.close(); closed = true;
    const tamper = new DatabaseSync(path); const row = tamper.prepare("SELECT record_json FROM streaming_host_launches WHERE launch_id = ?").get("launch-1") as { record_json: string };
    const unsafe = JSON.parse(row.record_json) as { effects: Array<{ kind: string; blocker?: { code: string; message: string } }> };
    unsafe.effects.find((effect) => effect.kind === "cleanup")!.blocker!.message = "provider token=B1_R6_SQL_SENTINEL";
    const unsafeJson = JSON.stringify(unsafe); const validHmac = createHmac("sha256", key).update(unsafeJson).digest("hex");
    tamper.prepare("UPDATE streaming_host_launches SET record_json = ?, integrity = ? WHERE launch_id = ?").run(unsafeJson, validHmac, "launch-1"); tamper.close();
    sqliteKernel = openSqliteStreamingSessionStore(path, key); closed = false;
    assert.throws(() => sqliteKernel.store.readHostLaunch("launch-1"), StreamingSessionStoreError);
  } finally { if (!closed) try { sqliteKernel.store.close(); } catch {} await rm(root, { recursive: true, force: true }); }
});

test("lease-only cleanup failure stays durably blocked and never releases without a successful lease retry", { timeout: 1_000 }, async () => {
  let leaseReleases = 0; let resolveHandshake!: (digest: string) => void;
  const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, {
    releaseLease: async () => { leaseReleases++; if (leaseReleases === 1) throw new Error("lease cleanup failed once"); },
  });
  fixture.setHandshake(async () => await new Promise<string>((resolve) => { resolveHandshake = resolve; }));
  const abort = new AbortController(); const opening = fixture.runtime.open({ ...fixture.request, signal: abort.signal }); setTimeout(() => abort.abort(), 10);
  await assert.rejects(opening); await waitUntil(() => fixture.kernel.store.readHostLaunch("launch-1")?.state === "cleanup_blocked");
  resolveHandshake("b".repeat(64)); await new Promise((resolve) => setImmediate(resolve));
  const retry = await fixture.runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 100 });
  assert.equal(leaseReleases, 2, "recovery must retry the exact durable lease");
  assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "released");
  assert.equal(retry.lateCleanupFailures[0]?.message, "Cleanup timed out or was cancelled.");
});

test("combined cleanup retries only unresolved resources, remains blocked after a partial retry, and survives owner expiry", { timeout: 2_000 }, async () => {
  let checkpointDeletes = 0; let leaseReleases = 0; let channelDetaches = 0; let nowValue = new Date(now); let resolveHandshake!: (digest: string) => void;
  const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, {
    clock: () => new Date(nowValue),
    deleteOutputCheckpoint: () => { checkpointDeletes++; if (checkpointDeletes < 3) throw new Error(`checkpoint cleanup failed ${checkpointDeletes}`); },
    releaseLease: async () => { leaseReleases++; if (leaseReleases === 1) throw new Error("lease cleanup failed once"); },
  });
  fixture.setChannelAcquire(async () => ({ subscribeBackpressuredOutput: () => () => undefined, observeTerminal: () => () => undefined, detach: async () => { channelDetaches++; if (channelDetaches === 1) throw new Error("channel cleanup failed once"); } }));
  fixture.setHandshake(async () => await new Promise<string>((resolve) => { resolveHandshake = resolve; }));
  const abort = new AbortController(); const opening = fixture.runtime.open({ ...fixture.request, signal: abort.signal }); setTimeout(() => abort.abort(), 10);
  await assert.rejects(opening); await waitUntil(() => fixture.kernel.store.readHostLaunch("launch-1")?.state === "cleanup_blocked");
  resolveHandshake("b".repeat(64)); await new Promise((resolve) => setImmediate(resolve));

  const partial = await fixture.runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 100 });
  assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "cleanup_blocked", "checkpoint failure must prevent false release");
  assert.equal(channelDetaches, 2); assert.equal(leaseReleases, 2); assert.equal(checkpointDeletes, 2);
  assert.equal(partial.lateCleanupFailures[0]?.message, "Output checkpoint deletion failed.");
  const partialFacts = fixture.kernel.store.readHostLaunch("launch-1")!.effects.find((effect) => effect.kind === "cleanup")?.resources ?? [];
  assert.equal(partialFacts.find((fact) => fact.resource === "output_checkpoint")?.status, "failed");
  assert.equal(partialFacts.find((fact) => fact.resource === "channel")?.status, "succeeded");
  assert.equal(partialFacts.find((fact) => fact.resource === "isolation_lease")?.status, "succeeded");

  nowValue = new Date("2026-08-30T00:02:00.000Z");
  const restarted = fixture.createRecoveryRuntime();
  const complete = await restarted.reconcileStartup({ maxRecords: 4, timeoutMs: 100 });
  assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "released");
  assert.equal(checkpointDeletes, 3);
  assert.equal(channelDetaches, 2, "succeeded channel cleanup must not repeat after restart");
  assert.equal(leaseReleases, 2, "succeeded lease cleanup must not repeat after restart");
  assert.ok(fixture.kernel.store.readHostLaunch("launch-1")!.effects.find((effect) => effect.kind === "cleanup")?.resources?.every((fact) => fact.status === "succeeded"));
  assert.equal(complete.lateCleanupFailures[0]?.message, "Output checkpoint deletion failed.");
  await restarted.reconcileStartup({ maxRecords: 4, timeoutMs: 100 });
  assert.equal(checkpointDeletes, 3); assert.equal(channelDetaches, 2); assert.equal(leaseReleases, 2);
});


interface SyntheticFixtureEvidence {
  readonly artifacts: ArtifactStore;
  createSpool(): BoundedOutputSpool;
}
async function withSyntheticFixtureEvidence(t: TestContext, body: (evidence: SyntheticFixtureEvidence) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "c2r12-alignment-"));
  t.diagnostic(`new synthetic evidence fixture acquired: ${root}`);
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const spools: BoundedOutputSpool[] = [];
  let failed = false; let primary: unknown;
  try {
    await body({ artifacts, createSpool: () => {
      const spool = new BoundedOutputSpool({ spillRoot: join(root, `spool-${spools.length}`), projectRoot: process.cwd(), ownershipId: "c2-round12-synthetic", artifactStore: artifacts });
      spools.push(spool); return spool;
    } });
  } catch (error) { failed = true; primary = error; }
  const cleanupFailures: unknown[] = [];
  for (const spool of spools) { try { await spool.cleanup(); } catch (error) { cleanupFailures.push(error); } }
  if (!failed && cleanupFailures.length === 0) {
    await rm(root, { recursive: true });
    t.diagnostic(`closed ${spools.length} synthetic spools; exact successful evidence root removed: ${root}`);
  } else t.diagnostic(`closed ${spools.length} synthetic spools; exact failed evidence root retained: ${root}`);
  if (cleanupFailures.length) throw new AggregateError(failed ? [primary, ...cleanupFailures] : cleanupFailures, "Synthetic evidence finalization failed");
  if (failed) throw primary;
}

async function makeFixture(outputVersion = 2, reconcileOutcome: "cleaned" | "blocked" | "outcome_unknown" = "outcome_unknown", handshakeVerify?: () => Promise<string>, retainedWindow: readonly import("../src/streaming-output-controller.js").StreamingOutputMetadata[] = [], replayCapacityChunks = 4, revokeAt?: "isolate" | "launch" | "channel" | "output" | "handshake", reconcileOverride?: () => Promise<"cleaned" | "blocked" | "outcome_unknown">, onPhase?: (phase: string) => void, cleanupFaults?: { readonly kernel?: ReturnType<typeof createInMemoryStreamingSessionStore>; readonly clock?: () => Date; readonly releaseLease?: () => Promise<void>; readonly deleteOutputCheckpoint?: () => void; readonly evidence?: SyntheticFixtureEvidence }) {
  const grants = createExecutionGrantAuthority({ clock: () => new Date(now) });
  const baseKernel = cleanupFaults?.kernel ?? createInMemoryStreamingSessionStore();
  const kernelWriterSymbol = Object.getOwnPropertySymbols(baseKernel).find((symbol) => typeof Object.getOwnPropertyDescriptor(baseKernel, symbol)?.value?.deleteOutputCheckpoint === "function");
  assert.ok(kernelWriterSymbol);
  const baseKernelWriter = Object.getOwnPropertyDescriptor(baseKernel, kernelWriterSymbol)?.value as ReturnType<typeof getStreamingSessionKernelWriter>;
  const faultingKernel = { store: baseKernel.store };
  for (const symbol of Object.getOwnPropertySymbols(baseKernel)) {
    const descriptor = Object.getOwnPropertyDescriptor(baseKernel, symbol)!;
    Object.defineProperty(faultingKernel, symbol, symbol === kernelWriterSymbol
      ? { ...descriptor, value: Object.freeze({ ...baseKernelWriter, deleteOutputCheckpoint: (command: unknown) => { cleanupFaults?.deleteOutputCheckpoint?.(); baseKernelWriter.deleteOutputCheckpoint(command); } }) }
      : descriptor);
  }
  const kernel = faultingKernel as ReturnType<typeof createInMemoryStreamingSessionStore>;
  const authority = createSessionAuthority({
    grants,
    sessions: kernel,
    clock: cleanupFaults?.clock ?? (() => new Date(now)),
  });
  const binding = { runId: "run-1", sessionId: "agent-1", actor: { role: "worker" as const, id: "worker-1" }, toolName: "process.start", callId: "call-1", permissionProfile: "full" as const };
  const grant = await grants.issue({ ...binding, workspacePath: process.cwd(), access: [], externalApproved: false, destructiveApproved: false, networkApproved: false });
  const calls: string[] = [];
  let launchCalls = 0;
  const waitTerminalCalls = 0;
  let outputSink: ((metadata: import("../src/streaming-output-controller.js").StreamingOutputMetadata, bytes: Uint8Array) => Promise<import("../src/streaming-output-controller.js").StreamingOutputMetadata>) | undefined;
  let evidenceWrites = 0; let deliveries = 0;
  let releaseCalls = 0;
  let observeQuiescenceCalls = 0;
  const observedQuiescenceFences: Array<Readonly<{ ownerId: string; fencingToken: number }>> = [];
  let finalizeCalls = 0; let detachCalls = 0; let reattachCalls = 0;
  let isolationAcquireOverride: (() => Promise<ReturnType<typeof leaseRecord>>) | undefined;
  let hostLaunchOverride: (() => Promise<typeof backendBinding>) | undefined;
  let channelAcquireOverride: (() => Promise<import("../src/streaming-process-session-runtime.js").FakeStreamingChannel>) | undefined;
  let handshakeOverride: (() => Promise<string>) | undefined;
  let deliverOverride: (() => Promise<void>) | undefined;
  let reattachOverride: ((binding: StreamingSessionBackendBinding) => ReturnType<NonNullable<StreamingRuntimeOptions["channel"]["reattach"]>>) | undefined;
  let evidenceSpoolOverride: (() => { write(stream: "stdout" | "stderr", bytes: Uint8Array): Promise<void>; finalize(): Promise<unknown>; cleanup(): Promise<void> }) | undefined;
  const maybeRevoke = (phase: typeof revokeAt) => { if (phase) onPhase?.(phase); if (revokeAt === phase) void grants.revoke(grant, "cancelled"); };
  const backendBinding = { registryId: "registry-1", backendId: "fake", implementationGeneration: "g1", implementationDigest: "c".repeat(64), attestationVersion: 1, attestationDigest: "d".repeat(64), opaqueIdentity: "opaque-1", birthFingerprint: { observedAt: now, discriminator: "birth-1" }, rootPid: 42, startedAt: now };
  const runtimeOptions = {
    sessions: authority, kernel, clock: cleanupFaults?.clock ?? (() => new Date(now)),
    isolation: { acquire: async () => { calls.push("isolate"); maybeRevoke("isolate"); return isolationAcquireOverride ? await isolationAcquireOverride() : leaseRecord(); }, release: async () => { releaseCalls++; await cleanupFaults?.releaseLease?.(); } },
    host: {
      launch: async () => { calls.push("launch"); launchCalls++; maybeRevoke("launch"); return hostLaunchOverride ? await hostLaunchOverride() : backendBinding; },
      quiesce: async () => {
        calls.push("reconcile");
        const outcome = reconcileOverride ? await reconcileOverride() : reconcileOutcome;
        return outcome === "cleaned" ? "verified" as const : outcome;
      },
      observeQuiescence: async (input) => {
        observeQuiescenceCalls++;
        observedQuiescenceFences.push(input.fence);
        const outcome = reconcileOverride ? await reconcileOverride() : reconcileOutcome;
        return outcome === "cleaned" ? "verified" as const : outcome;
      },
      release: async () => "verified" as const,
    },
channel: { version: outputVersion, replayCapacityChunks: outputVersion === 2 ? replayCapacityChunks : undefined, replayCapacityBytes: outputVersion === 2 ? 16 : undefined, acquire: async () => { calls.push("channel"); maybeRevoke("channel"); return channelAcquireOverride ? await channelAcquireOverride() : { subscribeBackpressuredOutput: (sink) => { outputSink = sink; calls.push("output"); maybeRevoke("output"); return () => { outputSink = undefined; }; }, observeTerminal: () => () => undefined, detach: async () => { detachCalls++; } }; }, reattach: async (binding) => { reattachCalls++; return reattachOverride ? await reattachOverride(binding) : ({ version: 2 as const, binding, replayCapacityChunks: 4, replayCapacityBytes: 16, ...(cleanupFaults?.evidence && retainedWindow.length === 0 && !kernel.store.readOutputCheckpoint("stream-1") ? { cleanupBootstrap: { version: 1 as const, consumed: { stdout: { sequence: 0, endOffset: 0 }, stderr: { sequence: 0, endOffset: 0 } }, pendingAcknowledgements: 0 } } : {}), channel: { subscribeBackpressuredOutput: (sink) => { outputSink = sink; for (const metadata of retainedWindow) queueMicrotask(() => { void sink(metadata, Buffer.alloc(metadata.byteLength)).catch(() => undefined); }); return () => { outputSink = undefined; }; }, observeTerminal: () => () => undefined, settleBackpressuredOutput: async () => ({ status: "settled" as const }), detach: async () => { detachCalls++; } }, retainedWindow }); } },
    handshake: { verify: async () => { calls.push("handshake"); maybeRevoke("handshake"); return handshakeOverride ? await handshakeOverride() : handshakeVerify ? handshakeVerify() : "b".repeat(64); } },
    output: { artifacts: cleanupFaults?.evidence?.artifacts, maxQueueBytes: 16, maxQueueChunks: 4, maxFrameBytes: 16, maxAcceptedChunks: 4, protocolStreams: ["stdout"], createEvidenceSpool: () => evidenceSpoolOverride ? evidenceSpoolOverride() : cleanupFaults?.evidence ? cleanupFaults.evidence.createSpool() : ({ write: async () => { evidenceWrites++; }, finalize: async () => { finalizeCalls++; return { streams: [] }; }, cleanup: async () => undefined }), deliver: async () => { deliveries++; await deliverOverride?.(); } },
  } satisfies Parameters<typeof createStreamingProcessSessionRuntime>[0];
  const runtime = createStreamingProcessSessionRuntime(runtimeOptions);
  const preparedRecord = (launchId = "launch-1", sessionId = "stream-1") => ({ recordKind: "runner.host-launch" as const, schemaVersion: HOST_LAUNCH_RECORD_VERSION, revision: 0, launchId, sessionId, runId: "run-1", agentSessionId: "agent-1", actor: { role: "worker" as const, id: "worker-1" }, toolName: "process.start", callId: "call-1", ownerId: "host:run-1", fencingToken: 1, ownerExpiresAt: "2026-08-30T00:01:00.000Z", state: "prepared" as const, cleanupOwner: "host_control" as const, history: [{ state: "prepared" as const, at: now }], effects: [{ effectId: `isolate:${launchId}`, kind: "isolate" as const, status: "pending" as const, ownerId: "host:run-1", fencingToken: 1, createdAt: now }] });
  const request = { sessionId: "stream-1", launchId: "launch-1", grant, binding, envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false }, preparedRecord: preparedRecord() };
  return { runtimeOptions, grants, runtime, backendBinding, createRecoveryRuntime: () => createStreamingProcessSessionRuntime(runtimeOptions), setIsolationAcquire: (value: typeof isolationAcquireOverride) => { isolationAcquireOverride = value; }, setHostLaunch: (value: typeof hostLaunchOverride) => { hostLaunchOverride = value; }, setChannelAcquire: (value: typeof channelAcquireOverride) => { channelAcquireOverride = value; }, setHandshake: (value: typeof handshakeOverride) => { handshakeOverride = value; }, setDeliver: (value: typeof deliverOverride) => { deliverOverride = value; }, setReattach: (value: typeof reattachOverride) => { reattachOverride = value; }, setEvidenceSpool: (value: typeof evidenceSpoolOverride) => { evidenceSpoolOverride = value; }, request, calls, kernel, authority, kernelWriter: (await import("../src/streaming-session-store.js")).getStreamingSessionKernelWriter(kernel), preparedRecord, emit: async (chunk: { metadata: import("../src/streaming-output-controller.js").StreamingOutputMetadata; bytes: Uint8Array; acknowledge: (metadata: import("../src/streaming-output-controller.js").StreamingOutputMetadata) => Promise<void> }) => { assert.ok(outputSink); const acknowledgement = await outputSink(chunk.metadata, chunk.bytes); await chunk.acknowledge(acknowledgement); }, observedQuiescenceFences, get launchCalls() { return launchCalls; }, get waitTerminalCalls() { return waitTerminalCalls; }, get evidenceWrites() { return evidenceWrites; }, get deliveries() { return deliveries; }, get releaseCalls() { return releaseCalls; }, get observeQuiescenceCalls() { return observeQuiescenceCalls; }, get finalizeCalls() { return finalizeCalls; }, get detachCalls() { return detachCalls; }, get reattachCalls() { return reattachCalls; } };
}

function leaseRecord() { return { leaseId: "lease-1", providerId: "fake", invocationId: "invoke-1", providerIdentity: "a".repeat(64), acquiredAt: now, access: [] }; }
function emptyReattachment(binding: StreamingSessionBackendBinding) {
  return {
    version: 2 as const,
    binding,
    replayCapacityChunks: 4,
    replayCapacityBytes: 16,
    retainedWindow: [],
    channel: {
      subscribeBackpressuredOutput: () => () => undefined,
      observeTerminal: () => () => undefined,
      settleBackpressuredOutput: async () => ({ status: "settled" as const }),
      detach: async () => undefined,
    },
  };
}
async function waitUntil(predicate: () => boolean) { for (let index = 0; index < 20 && !predicate(); index++) await new Promise((resolve) => setTimeout(resolve, 5)); }
function errorGraph(error: unknown): unknown {
  if (error instanceof AggregateError) return { name: error.name, message: error.message, cause: error.cause === undefined ? undefined : errorGraph(error.cause), errors: error.errors.map(errorGraph) };
  if (error instanceof Error) return { name: error.name, message: error.message, cause: error.cause === undefined ? undefined : errorGraph(error.cause), ...(error instanceof StreamingProcessSessionError ? { code: error.code } : {}) };
  if (Object.prototype.toString.call(error) === "[object Error]") {
    const foreign = error as { name?: unknown; message?: unknown; cause?: unknown };
    return { name: foreign.name, message: foreign.message, cause: foreign.cause === undefined ? undefined : errorGraph(foreign.cause) };
  }
  return error;
}

function foreignErrorFactories(): ReadonlyArray<readonly [string, () => unknown]> {
  const sentinel = "credential=B1_R7_FOREIGN_SENTINEL";
  class ForeignStreamingSubclass extends StreamingProcessSessionError {}
  return [
    ["exported", () => new StreamingProcessSessionError("launch_failed", sentinel, { cause: new Error(`payload=${sentinel}`) })],
    ["subclass", () => new ForeignStreamingSubclass("launch_failed", sentinel, { cause: { token: sentinel } })],
    ["lookalike", () => ({ name: "StreamingProcessSessionError", code: "launch_failed", message: sentinel, cause: { env: sentinel } })],
    ["aggregate", () => new AggregateError([new Error(`argv=${sentinel}`)], sentinel, { cause: new Error(`path=C:\\secret\\${sentinel}`) })],
    ["arbitrary", () => ({ arbitrary: sentinel, payload: [sentinel] })],
    ["cross_realm", () => runInNewContext(`new Error(${JSON.stringify(sentinel)})`)],
  ];
}

function durableGraph(fixture: Awaited<ReturnType<typeof makeFixture>>) {
  return {
    hosts: fixture.kernel.store.listHostLaunchIds().map((id) => fixture.kernel.store.readHostLaunch(id)),
    sessions: fixture.kernel.store.listSessionIds().map((id) => fixture.kernel.store.readBySession(id)),
    output: fixture.kernel.store.readOutputCheckpoint("stream-1"),
  };
}

function assertNoForeignSentinel(value: unknown, label: string) {
  assert.doesNotMatch(JSON.stringify(value), /B1_R7_FOREIGN_SENTINEL|credential=|payload=|token=|env=|argv=|C:\\secret/, label);
}

function runtimeErrorFact(error: unknown) {
  assert.ok(error instanceof StreamingProcessSessionError);
  assert.equal(error.cause, undefined);
  return { code: error.code, message: error.message };
}

function pickHostControl(value: unknown) {
  const input = value as { record?: { state?: unknown; ownerId?: unknown; fencingToken?: unknown; launchId?: unknown; sessionId?: unknown }; fence?: { ownerId?: unknown; fencingToken?: unknown } };
  const record = input?.record;
  return {
    state: record?.state,
    ownerId: record?.ownerId,
    fencingToken: record?.fencingToken,
    launchId: record?.launchId,
    sessionId: record?.sessionId,
    backendOwnerId: input?.fence?.ownerId,
    backendFencingToken: input?.fence?.fencingToken,
  };
}


for (const kind of ["memory", "sqlite"] as const) test(`MCP request scope ${kind} uses one launch authorization for bounded write and delivery`, async (t) => withSyntheticFixtureEvidence(t, async (evidence) => {
  const root = await mkdtemp(join(tmpdir(), "p682-request-store-"));
  t.diagnostic(`exact synthetic request store acquired: ${root}`);
  const path = join(root, "sessions.sqlite"); const key = Buffer.alloc(32, 71);
  const kernel = kind === "sqlite" ? openSqliteStreamingSessionStore(path, key) : createInMemoryStreamingSessionStore();
  const f = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { kernel, evidence });
  const originalAcquire = f.runtimeOptions.channel.acquire;
  const writes: Buffer[] = [];
  f.setChannelAcquire(async () => { const original = await originalAcquireWithoutOverride(); return { ...original,
    write: async (_metadata: unknown, bytes: Uint8Array) => { writes.push(Buffer.from(bytes)); } }; });
  async function originalAcquireWithoutOverride() {
    f.setChannelAcquire(undefined); const value = await originalAcquire();
    return value;
  }
  let passed = false;
  try {
    const facade = await f.runtime.open(f.request);
    assert.equal(typeof facade.request, "function", "the adopted facade must support one exact request authorization");
    const operation = { sessionId: facade.sessionId, operation: "request" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
    const assertion = { ...operation, binding: f.request.binding };
    const auth = facade.authorizeFirstOperation(operation);
    let escaped: Parameters<Parameters<typeof facade.request>[2]>[0] | undefined;
    const result = await facade.request(auth, assertion, async (io) => {
      escaped = io; await io.write(Buffer.from("one"), 100);
      await assert.rejects(io.write(Buffer.from("second"), 100), /one|single|request/i);
      const bytes = Buffer.from("reply");
      const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: bytes.length, byteLength: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") };
      const emitted = f.emit({ metadata, bytes, acknowledge: async () => undefined });
      try { assert.equal(await io.waitForOutput(), true); let text = "";
        assert.equal(await io.deliverOutput(async (_stream, payload) => { text = Buffer.from(payload).toString(); }), true);
        return text;
      } finally { await emitted; }
    }, 1_000);
    assert.equal(result, "reply"); assert.deepEqual(writes, [Buffer.from("one")]);
    await assert.rejects(escaped!.write(Buffer.from("escaped"), 100), /closed|request/i);
    await assert.rejects(facade.request(auth, assertion, async () => undefined, 1_000), /used|replay|request/i);
    await assert.rejects(facade.write(auth, assertion, Buffer.from("wrong operation"), 100), /operation/i);
    assert.throws(() => facade.authorizeFirstOperation(operation), /second|consumed/i);
    const binding = { ...f.request.binding, callId: "fresh-exact-call" };
    const grant = await f.grants.issue({ ...binding, workspacePath: process.cwd(), access: [], networkApproved: false, externalApproved: false, destructiveApproved: false });
    const next = facade.authorizeOperation({ ...operation, binding, grant });
    await facade.request(next, { ...operation, binding }, async (io) => { await io.write(Buffer.from("fresh"), 100); }, 1_000);
    assert.equal(writes.length, 2);
    await f.grants.revoke(grant, "completed");
    passed = true;
  } finally {
    await f.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 1_000 });
    assert.equal(kernel.store.readBySession("stream-1")?.state, "released");
    kernel.store.close();
    if (passed) { await rm(root, { recursive: true }); t.diagnostic(`closed synthetic request store removed: ${root}`); }
    else t.diagnostic(`closed synthetic request store retained: ${root}`);
  }
}));

test("MCP request scope rechecks revoked authority at the queued byte effect and rejects escaped channels", async (t) => withSyntheticFixtureEvidence(t, async (evidence) => {
  const f = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { evidence });
  let writes = 0;
  f.setChannelAcquire(async () => ({ subscribeBackpressuredOutput: () => () => undefined, observeTerminal: () => () => undefined,
    detach: async () => undefined, write: async () => { writes++; } }));
  const facade = await f.runtime.open(f.request);
  try {
    assert.equal(typeof facade.request, "function");
    const operation = { sessionId: facade.sessionId, operation: "request" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
    const auth = facade.authorizeFirstOperation(operation);
    await assert.rejects(facade.request(auth, { ...operation, binding: f.request.binding }, async (io) => {
      const pending = io.write(Buffer.from("must-not-be-sent"), 100);
      await f.grants.revoke(f.request.grant, "cancelled");
      await pending;
    }, 1_000), /revoked|current|authorization/i);
    assert.equal(writes, 0, "a grant revoked between queueing and effect cannot write");
  } finally { await f.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 1_000 }); f.kernel.store.close(); }
}));


test("MCP fixed envelope is refused before isolation and process launch when the real call lacks rights", async (t) => withSyntheticFixtureEvidence(t, async (evidence) => {
  const f = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { evidence });
  try {
    await assert.rejects(f.runtime.open({ ...f.request, envelope: { ...f.request.envelope, networkApproved: true } }));
    assert.equal(f.launchCalls, 0, "a final adoption refusal is too late to prevent an unauthorized process");
    assert.equal(f.calls.includes("isolate"), false);
  } finally { await f.grants.revokeAll("cleanup"); f.kernel.store.close(); }
}));

test("MCP owned shutdown closes stdin before shared cleanup escalation without minting a new call", async (t) => withSyntheticFixtureEvidence(t, async (evidence) => {
  const events: string[] = [];
  const f = await makeFixture(2, "cleaned", undefined, [], 4, undefined, async () => { events.push("shared-quiesce"); return "cleaned"; }, undefined, { evidence });
  f.setChannelAcquire(async () => ({ subscribeBackpressuredOutput: () => () => undefined, observeTerminal: () => () => undefined,
    closeInput: async () => { events.push("stdin-close"); }, waitForTerminal: async () => { events.push("terminal-observe"); }, detach: async () => undefined }));
  await f.runtime.open(f.request);
  await f.grants.revoke(f.request.grant, "completed");
  try {
    await f.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 1000, gracefulShutdownMs: 50 });
    assert.deepEqual(events.slice(0, 2), ["stdin-close", "terminal-observe"]);
    assert.ok(events.indexOf("shared-quiesce") > events.indexOf("stdin-close"));
    assert.equal(f.kernel.store.readBySession("stream-1")!.state, "released");
    assert.deepEqual(f.grants.activeSnapshots(), []);
  } finally { await f.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 1000 }); f.kernel.store.close(); }
}));


for (const mode of ["durable-transfer", "no-transfer", "forged-proof", "wrong-lease", "revoked-before-transfer"] as const)
test(`MCP isolation cleanup ownership ${mode} never outlives an unowned original call`, async (t) => withSyntheticFixtureEvidence(t, async (evidence) => {
  const isolation = await import("../src/execution-isolation-provider.js");
  const session = await import("../src/session-authority.js");
  const f = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { evidence });
  const binding = { ...f.request.binding, permissionProfile: "project" as const, callId: "strict-parent" };
  const grant = await f.grants.issue({ ...binding, workspacePath: process.cwd(), access: [], externalApproved: false, destructiveApproved: false, networkApproved: false });
  let releases = 0;
  const provider: import("../src/execution-isolation-provider.js").ExecutionIsolationProvider = {
    attest: async () => ({ attestationVersion: 1, providerId: "strict-fixture", verified: true, mechanism: "synthetic-exact",
      exactGrantWriteConfinement: true, interactiveAttach: true,
      capabilities: { tree_termination: "enforced", crash_cleanup: "enforced", verified_emptiness: "enforced", write_confinement: "enforced" } }),
    attestExecution: async () => undefined,
    acquire: async (input) => ({ leaseId: "strict-real-lease", providerId: input.providerId, invocationId: input.intent.invocationId,
      grantId: input.grant.grantId, grantedAccess: input.grant.access, acquiredAt: now, state: "active", providerIdentity: input.implementationDigest }),
    release: async () => { releases++; }, recoverOwned: async () => ({ cleaned: 0, blockers: [] }), acknowledgeRecovery: async () => undefined,
  };
  const selector = isolation.createExecutionIsolationSelector(isolation.createExecutionIsolationRegistry([
    isolation.createExecutionIsolationProviderRegistration({ stableProviderId: "strict-fixture", codeDigest: "a".repeat(64), configDigest: "b".repeat(64), provider }),
  ]), { clock: () => new Date(now) });
  let selected: import("../src/execution-isolation-provider.js").ExecutionIsolationSelection | undefined;
  const runtime = createStreamingProcessSessionRuntime({ ...f.runtimeOptions, isolation: {
    acquire: async ({ claims, launchId }) => {
      selected = await selector.acquire({ permissionProfile: "project", grant: claims, intent: { invocationId: launchId,
        runId: claims.runId, sessionId: claims.sessionId, kind: "mcp_server", executable: "fixture", arguments: [], workingDirectory: process.cwd(), requestedCapabilities: ["write_confinement"] } });
      assert.equal(selected.enforcement, "write_confinement_exact_grant");
      if (selected.enforcement !== "write_confinement_exact_grant") assert.fail("strict selection required");
      return { leaseId: selected.lease.leaseId, providerId: selected.providerId, invocationId: selected.lease.invocationId,
        providerIdentity: selected.lease.providerIdentity, acquiredAt: selected.lease.acquiredAt, access: selected.lease.grantedAccess };
    },
    release: async () => { if (selected) await selector.release(selected); },
  } });
  try {
    const facade = await runtime.open({ ...f.request, binding, grant });
    if (mode !== "no-transfer") {
      if (mode === "revoked-before-transfer") await f.grants.revoke(grant, "cancelled");
      if (mode === "forged-proof") assert.throws(() => isolation.transferExecutionIsolationLeaseToSession(selector, selected!, {} as never), /authority|proof|forged/i);
      else if (mode === "revoked-before-transfer") assert.throws(() => session.authorizeSessionLeaseOwnership(f.authority, facade.sessionId), /revoked|current/i);
      else {
        const proof = session.authorizeSessionLeaseOwnership(f.authority, facade.sessionId);
        if (mode === "wrong-lease") {
          assert.throws(() => isolation.transferExecutionIsolationLeaseToSession(selector, { ...selected! } as never, proof), /owned|lease|authority/i);
        } else {
          isolation.transferExecutionIsolationLeaseToSession(selector, selected!, proof);
          assert.throws(() => isolation.transferExecutionIsolationLeaseToSession(selector, selected!, proof), /used|transferred|proof/i);
        }
      }
    }
    await f.grants.revoke(grant, "completed");
    assert.equal(releases, mode === "durable-transfer" ? 0 : 1, "only a verified durable owner may retain strict isolation after original-call completion");
    if (mode === "durable-transfer") {
      const nextBinding = { ...binding, callId: "fresh-after-transfer" };
      const next = await f.grants.issue({ ...nextBinding, workspacePath: process.cwd(), access: [], externalApproved: false, destructiveApproved: false, networkApproved: false });
      const operation = { sessionId: facade.sessionId, operation: "request" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
      const auth = facade.authorizeOperation({ ...operation, binding: nextBinding, grant: next });
      await facade.request(auth, { ...operation, binding: nextBinding }, async () => undefined, 1000);
      await f.grants.revoke(next, "completed"); assert.equal(releases, 0);
    }
  } finally {
    await runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 1000 });
    assert.equal(releases, 1, "the same exact retained lease is physically released once");
    assert.deepEqual(selector.activeLeases(), []); await f.grants.revokeAll("cleanup"); f.kernel.store.close();
  }
}));


for (const role of ["subagent", "verifier"] as const) test(`MCP session preserves the actual ${role} identity rather than fabricating a worker`, async (t) => withSyntheticFixtureEvidence(t, async (evidence) => {
  const f = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { evidence });
  const binding = { ...f.request.binding, actor: { role, id: `actual-${role}` }, callId: `actual-${role}-call` };
  const grant = await f.grants.issue({ ...binding, workspacePath: process.cwd(), access: [], externalApproved: false, networkApproved: false, destructiveApproved: false });
  try {
    const facade = await f.runtime.open({ ...f.request, binding, grant });
    assert.deepEqual(facade.record.actor, binding.actor);
    assert.deepEqual(f.kernel.store.readHostLaunch(f.request.launchId)!.actor, binding.actor);
  } finally { await f.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 1000 }); await f.grants.revokeAll("cleanup"); f.kernel.store.close(); }
}));


test("MCP request retains its owner through the authorized response deadline without extending a grant", async (t) => withSyntheticFixtureEvidence(t, async (evidence) => {
  const f = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { evidence });
  let current = Date.parse(now);
  const clock = () => new Date(current);
  const authority = createSessionAuthority({ grants: f.grants, sessions: f.kernel, clock });
  const runtime = createStreamingProcessSessionRuntime({ ...f.runtimeOptions, sessions: authority, clock });
  f.setChannelAcquire(async () => ({ subscribeBackpressuredOutput: () => () => undefined, observeTerminal: () => () => undefined,
    write: async () => undefined, detach: async () => undefined }));
  try {
    const facade = await runtime.open(f.request);
    const operation = { sessionId: "stream-1", operation: "request" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
    const authorization = facade.authorizeFirstOperation(operation);
    const originalExpiresAt = f.grants.activeSnapshots()[0]!.expiresAt;
    await facade.request(authorization, { ...operation, binding: f.request.binding }, async (io) => {
      current += 90_000;
      await io.write(Buffer.from("bounded-long-request"), 1000);
    }, 100_000);
    assert.equal(f.grants.activeSnapshots()[0]!.expiresAt, originalExpiresAt);
    assert.ok(Date.parse(f.kernel.store.readBySession("stream-1")!.leaseExpiresAt) > current);
  } finally { await runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 1000 }); await f.grants.revokeAll("cleanup"); f.kernel.store.close(); }
}));


test("MCP graceful shutdown joins stdin-close acknowledgement before changing cleanup ownership", async (t) => withSyntheticFixtureEvidence(t, async (evidence) => {
  let releaseClose!: () => void; const held = new Promise<void>((resolve) => { releaseClose = resolve; });
  const events: string[] = [];
  const f = await makeFixture(2, "cleaned", undefined, [], 4, undefined, async () => { events.push("shared-quiesce"); return "cleaned"; }, undefined, { evidence });
  f.setChannelAcquire(async () => ({ subscribeBackpressuredOutput: () => () => undefined, observeTerminal: () => () => undefined,
    closeInput: async () => { events.push("stdin-close-start"); await held; events.push("stdin-close-acknowledged"); },
    waitForTerminal: async () => { events.push("terminal-observe"); }, detach: async () => undefined }));
  await f.runtime.open(f.request);
  const closing = f.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 1000, gracefulShutdownMs: 10 });
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    assert.deepEqual(events, ["stdin-close-start"], "the grace timer cannot orphan a late input acknowledgement under an old fence");
  } finally { releaseClose(); await closing; f.kernel.store.close(); }
  assert.ok(events.indexOf("shared-quiesce") > events.indexOf("stdin-close-acknowledged"));
}));


test("LSP owned protocol shutdown precedes shared escalation and cannot escape its cleanup scope", async (t) => withSyntheticFixtureEvidence(t, async (evidence) => {
  const events: string[] = [];
  const f = await makeFixture(2, "cleaned", undefined, [], 4, undefined, async () => { events.push("quiesce"); return "cleaned"; }, undefined, { evidence });
  f.setChannelAcquire(async () => ({ subscribeBackpressuredOutput: () => () => undefined, observeTerminal: () => () => undefined,
    write: async (_metadata: unknown, bytes: Uint8Array) => { events.push(Buffer.from(bytes).toString()); }, detach: async () => undefined }));
  await f.runtime.open(f.request);
  let escaped: { write(payload: Uint8Array, timeoutMs: number): Promise<void> } | undefined;
  try {
    await f.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 1000, gracefulShutdownMs: 100,
      gracefulProtocol: async (io: { write(payload: Uint8Array, timeoutMs: number): Promise<void> }) => { escaped = io; await io.write(Buffer.from("shutdown"), 100); await io.write(Buffer.from("exit"), 100); },
    } as Parameters<typeof f.runtime.cleanupOwnedSession>[0]);
    assert.ok(escaped, "family shutdown must run under the retained shared cleanup owner");
    assert.deepEqual(events, ["shutdown", "exit", "quiesce"]);
    await assert.rejects(escaped.write(Buffer.from("late effect"), 100), /closed|deadline|scope/);
    assert.equal(f.kernel.store.readBySession("stream-1")!.state, "released");
  } finally { await f.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 1000 }); f.kernel.store.close(); }
}));


test("LSP failed startup uses exact shared pre-adoption cleanup and cannot clean an adopted launch as unstarted", async (t) => withSyntheticFixtureEvidence(t, async (evidence) => {
  // The original fixture defaults to outcome_unknown: that must block release.
  // This positive case supplies real evidence support and verified fake host
  // cleanup explicitly, as the corresponding C2/C3 cleanup contract requires.
  const f = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { evidence });
  try {
    f.kernelWriter.prepareLaunch(f.preparedRecord("lsp-failed-open", "lsp-not-adopted"));
    const cleanup = f.runtime.cleanupOwnedLaunch;
    await cleanup({ launchId: "lsp-failed-open", timeoutMs: 1000 });
    assert.equal(f.kernel.store.readHostLaunch("lsp-failed-open")!.state, "released");
    assert.equal(f.kernel.store.readBySession("lsp-not-adopted"), undefined);
    const effects = f.calls.length;
    await cleanup({ launchId: "lsp-failed-open", timeoutMs: 1000 });
    assert.equal(f.calls.length, effects, "terminal cleanup never repeats resource effects");
    await f.runtime.open(f.request);
    const adopted = f.kernel.store.readBySession("stream-1")!;
    await assert.rejects(cleanup({ launchId: f.request.launchId, timeoutMs: 1000 }), /adopted/);
    assert.deepEqual(f.kernel.store.readBySession("stream-1"), adopted);
  } finally { await f.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 1000 }); f.kernel.store.close(); }
}));

for (const outcome of ["blocked", "outcome_unknown"] as const) test(`LSP failed startup retains exact ${outcome} cleanup rather than certifying release`, async () => {
  const f = await makeFixture(2, outcome);
  try {
    f.kernelWriter.prepareLaunch(f.preparedRecord("lsp-uncertain-open", "lsp-not-adopted"));
    await assert.rejects(f.runtime.cleanupOwnedLaunch({ launchId: "lsp-uncertain-open", timeoutMs: 1000 }),
      (error: unknown) => error instanceof StreamingProcessSessionError && error.code === "cleanup_blocked");
    const record = f.kernel.store.readHostLaunch("lsp-uncertain-open")!;
    assert.equal(record.state, "cleanup_blocked");
    assert.equal(record.cleanupOwner, "host_control");
    assert.equal(record.effects.find((effect) => effect.kind === "cleanup")!.resources![0]!.status, "failed");
    assert.equal(f.kernel.store.readBySession("lsp-not-adopted"), undefined);
  } finally { f.kernel.store.close(); }
});


for (const milliseconds of [1000, 30000]) test(`LSP failed-launch cleanup binds its ${milliseconds}ms lifecycle budget before terminal output starts`, async (t) => withSyntheticFixtureEvidence(t, async (evidence) => {
  let current = Date.parse(now); const deadlines: number[] = [];
  const f = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { evidence, clock: () => new Date(current) });
  const runtime = createStreamingProcessSessionRuntime({ ...f.runtimeOptions,
    host: { ...f.runtimeOptions.host, quiesce: async ({ deadlineAt }) => {
      deadlines.push(deadlineAt); current += 1500; return "verified";
    } },
    handshake: { verify: async () => { throw new Error("exact initialization refusal"); } },
  });
  try {
    const request = { ...f.request, failedLaunchCleanupTimeoutMs: milliseconds };
    await assert.rejects(runtime.open(request));
    assert.deepEqual(deadlines, [Date.parse(now) + milliseconds]);
    const record = f.kernel.store.readHostLaunch(f.request.launchId)!;
    assert.equal(record.state, milliseconds === 1000 ? "cleanup_blocked" : "released");
    assert.equal(f.kernel.store.readBySession("stream-1"), undefined);
    if (milliseconds === 30000) assert.equal(f.kernel.store.readOutputCheckpoint("stream-1"), undefined);
  } finally { f.kernel.store.close(); }
}));


test("LSP grace expiry joins an already admitted parser delivery before cleanup changes ownership", async (t) => withSyntheticFixtureEvidence(t, async (evidence) => {
  const payload = Buffer.alloc(4);
  const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 4, byteLength: 4, digest: createHash("sha256").update(payload).digest("hex") };
  const f = await makeFixture(2, "cleaned", undefined, [metadata], 4, undefined, undefined, undefined, { evidence });
  let releaseRead!: () => void; let enteredRead!: () => void;
  const held = new Promise<void>((resolve) => { releaseRead = resolve; });
  const entered = new Promise<void>((resolve) => { enteredRead = resolve; });
  const original = BoundedProtocolQueue.prototype.read; let armed = true; let deliveries = 0;
  t.mock.method(BoundedProtocolQueue.prototype, "read", async function(this: BoundedProtocolQueue) {
    const bytes = await original.call(this);
    if (armed) { armed = false; enteredRead(); await held; }
    return bytes;
  });
  const facade = await f.runtime.open(f.request);
  const emission = f.emit({ metadata, bytes: payload, acknowledge: async () => undefined }).catch(() => undefined);
  assert.equal(await facade.waitForOutput(), true, "the frame is durably admitted before the graceful timer starts");
  const closing = f.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 1000, gracefulShutdownMs: 10,
    gracefulProtocol: async (io) => { await io.waitForOutput(); await io.deliverOutput(async () => { deliveries++; }); } });
  void closing.catch(() => undefined);
  try {
    await entered; await new Promise<void>((resolve) => setTimeout(resolve, 35));
    assert.equal(deliveries, 0);
    releaseRead(); await closing; await emission;
    assert.equal(deliveries, 1, "the admitted delivery remains within the same owned cleanup deadline even after its grace interval");
    assert.equal(f.kernel.store.readBySession("stream-1")!.state, "released");
    assert.equal(f.kernel.store.readOutputCheckpoint("stream-1"), undefined);
  } finally { releaseRead(); await closing.catch(() => undefined); await emission; f.kernel.store.close(); }
}));

test("LSP graceful callback failure after a real effect cannot masquerade as a refused output delivery", async (t) => withSyntheticFixtureEvidence(t, async (evidence) => {
  const payload = Buffer.alloc(4);
  const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 4, byteLength: 4, digest: createHash("sha256").update(payload).digest("hex") };
  const f = await makeFixture(2, "cleaned", undefined, [metadata], 4, undefined, undefined, undefined, { evidence });
  let deliveries = 0; await f.runtime.open(f.request);
  const emission = f.emit({ metadata, bytes: payload, acknowledge: async () => undefined }).catch(() => undefined);
  try {
    await assert.rejects(f.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 1000, gracefulShutdownMs: 100,
      gracefulProtocol: async (io) => { await io.waitForOutput(); await io.deliverOutput(async () => {
        deliveries++; throw new StreamingOutputError("authorization_required", "untrusted callback claiming definite refusal");
      }); } }));
    assert.equal(deliveries, 1);
    assert.equal(f.kernel.store.readOutputCheckpoint("stream-1")!.outcome, "outcome_unknown");
    assert.notEqual(f.kernel.store.readBySession("stream-1")!.state, "released");
  } finally { await emission; f.kernel.store.close(); }
}));


test("managed shared evidence observation never consumes protocol output and rechecks the original read authority", async t => withSyntheticFixtureEvidence(t, async evidence => {
  const f = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { evidence });
  const opened = await f.runtime.open({ ...f.request, protocolStreams: [] });
  try {
    const bytes = Buffer.from("managed"); const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: bytes.length, byteLength: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") };
    await f.emit({ metadata, bytes, acknowledge: async () => undefined }); assert.equal(f.deliveries, 0);
    const operation = { sessionId: opened.sessionId, operation: "observe" as const, binding: f.request.binding, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
    const authorization = opened.authorizeFirstOperation(operation);
    const runtime = f.runtime as unknown as { observeOutput(input: { authorization: typeof authorization; assertion: typeof operation }): Promise<{ output: { streams: readonly { tail: string }[] } }> };
    assert.equal(typeof runtime.observeOutput, "function", "observation must use the shared evidence owner, not private process log files");
    assert.match((await runtime.observeOutput({ authorization, assertion: operation })).output.streams[0]!.tail, /managed$/);
    await f.grants.revoke(f.request.grant, "completed");
    await assert.rejects(runtime.observeOutput({ authorization, assertion: operation }), /current|revok|authority/i);
  } finally { await f.runtime.cleanupOwnedSession({ sessionId: opened.sessionId, timeoutMs: 1000 }); f.kernel.store.close(); }
}));

test("managed shared observation refuses delivery when its original grant is revoked during the evidence wait", async t => withSyntheticFixtureEvidence(t, async evidence => {
  const f = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { evidence });
  let release!: () => void, entered!: () => void; const held = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  f.setEvidenceSpool(() => { const spool = evidence.createSpool(); return { write: spool.write.bind(spool), finalize: spool.finalize.bind(spool), cleanup: spool.cleanup.bind(spool),
    observe: async () => { entered(); await held; return await spool.observe(); } }; });
  const opened = await f.runtime.open({ ...f.request, protocolStreams: [] });
  try {
    const operation = { sessionId: opened.sessionId, operation: "observe" as const, binding: f.request.binding, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
    const authorization = opened.authorizeFirstOperation(operation);
    const runtime = f.runtime as unknown as { observeOutput(input: { authorization: typeof authorization; assertion: typeof operation }): Promise<unknown> };
    assert.equal(typeof runtime.observeOutput, "function");
    const reading = runtime.observeOutput({ authorization, assertion: operation }); void reading.catch(() => undefined);
    await started; await f.grants.revoke(f.request.grant, "completed"); release();
    await assert.rejects(reading, /current|revok|authority/i); assert.equal(f.kernel.store.readBySession(opened.sessionId)!.state, "active", "cancelled reads must not stop the child");
  } finally { release(); await f.runtime.cleanupOwnedSession({ sessionId: opened.sessionId, timeoutMs: 1000 }); f.kernel.store.close(); }
}));

test("managed shared terminal observation recorded before adoption is delivered only after exact ownership transfer", async t => withSyntheticFixtureEvidence(t, async evidence => {
  const f = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { evidence });
  let notify: ((result: unknown) => void) | undefined; const seen: unknown[] = [];
  f.setChannelAcquire(async () => ({ subscribeBackpressuredOutput: () => () => undefined, observeTerminal: sink => { notify = sink; return () => undefined; }, settleBackpressuredOutput: async () => ({ status: "settled" as const }), detach: async () => undefined }));
  f.setHandshake(async () => { notify!({ state: "exited", exitCode: 7 }); return "b".repeat(64); });
  const request = { ...f.request, protocolStreams: [], onTerminal: (value: unknown) => { assert.equal(f.kernel.store.readBySession("stream-1")!.cleanupOwner, "session_authority"); seen.push(value); } };
  try { await f.runtime.open(request); assert.deepEqual(seen, [{ state: "exited", exitCode: 7, signal: null }]); }
  finally { await f.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 1000 }); f.kernel.store.close(); }
}));

test("managed shared stop commits durable stopping before waiting and survives caller grant revocation", async t => withSyntheticFixtureEvidence(t, async evidence => {
  let release!: () => void; const held = new Promise<void>(r => { release = r; });
  const f = await makeFixture(2, "cleaned", undefined, [], 4, undefined, async () => { await held; return "cleaned"; }, undefined, { evidence });
  const opened = await f.runtime.open({ ...f.request, protocolStreams: [] });
  const binding = { ...f.request.binding, callId: "exact-stop", toolName: "process.signal" };
  const grant = await f.grants.issue({ ...binding, workspacePath: process.cwd(), access: [], externalApproved: false, destructiveApproved: true, networkApproved: false });
  const operation = { sessionId: opened.sessionId, operation: "stop" as const, binding, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
  let stopping: Promise<unknown> | undefined;
  try {
    const authorization = opened.authorizeOperation({ ...operation, grant });
    stopping = opened.stop(authorization, operation); void stopping.catch(() => undefined);
    assert.ok(f.kernel.store.readBySession(opened.sessionId)!.history.some(entry => entry.state === "stopping"), "stop acceptance must be durable before any asynchronous cleanup wait");
    await f.grants.revoke(grant, "cancelled"); release(); await stopping;
    assert.equal(f.kernel.store.readBySession(opened.sessionId)!.state, "released");
  } finally { release(); await stopping?.catch(() => undefined); await f.runtime.cleanupOwnedSession({ sessionId: opened.sessionId, timeoutMs: 1000 }); f.kernel.store.close(); }
}));

test("managed shared trusted observation binds the exact owner and reads finalized output without a model grant", async t => withSyntheticFixtureEvidence(t, async evidence => {
  const f = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { evidence });
  const opened = await f.runtime.open({ ...f.request, protocolStreams: [] });
  const runtime = f.runtime as unknown as { observeOwnedOutput(input: { sessionId: string; owner: typeof f.request.binding }): Promise<{ output: { streams: readonly { tail: string }[] } }> };
  try {
    assert.equal(typeof runtime.observeOwnedOutput, "function");
    const bytes = Buffer.from("managed"); const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: bytes.length, byteLength: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") };
    await f.emit({ metadata, bytes, acknowledge: async () => undefined });
    await assert.rejects(runtime.observeOwnedOutput({ sessionId: opened.sessionId, owner: { ...f.request.binding, runId: "foreign" } }), /owner|identity/i);
    await f.grants.revoke(f.request.grant, "completed");
    const view = await runtime.observeOwnedOutput({ sessionId: opened.sessionId, owner: f.request.binding });
    assert.match(view.output.streams[0]!.tail, /managed$/); assert.equal(f.deliveries, 0);
    await f.runtime.cleanupOwnedSession({ sessionId: opened.sessionId, timeoutMs: 1000 });
    const final = await runtime.observeOwnedOutput({ sessionId: opened.sessionId, owner: f.request.binding });
    assert.match(final.output.streams[0]!.tail, /managed$/);
  } finally { await f.runtime.cleanupOwnedSession({ sessionId: opened.sessionId, timeoutMs: 1000 }); f.kernel.store.close(); }
}));

test("managed shared runtime observes the concrete waitForTerminal channel without a private observer API", async t => withSyntheticFixtureEvidence(t, async evidence => {
  const f = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { evidence });
  let finish!: (value: unknown) => void; const ending = new Promise<unknown>(resolve => { finish = resolve; });
  let observed!: (value: unknown) => void; const observation = new Promise<unknown>(resolve => { observed = resolve; });
  f.setChannelAcquire(async () => ({ subscribeBackpressuredOutput: () => () => undefined, waitForTerminal: () => ending,
    settleBackpressuredOutput: async () => ({ status: "settled" as const }), detach: async () => { finish({ state: "exited", exitCode: 7 }); } }));
  await f.runtime.open({ ...f.request, protocolStreams: [], onTerminal: value => observed(value) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    finish({ state: "exited", exitCode: 7 });
    assert.deepEqual(await Promise.race([observation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Concrete channel terminal result was not observed")), 200); })]), { state: "exited", exitCode: 7, signal: null });
  } finally { if (timer) clearTimeout(timer); finish({ state: "exited", exitCode: 7 }); await f.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 1000 }); f.kernel.store.close(); }
}));

test("managed recovery reconnects exact evidence intake before observing a retained quiescence attempt without reissuing stop", async t => withSyntheticFixtureEvidence(t, async evidence => {
  const f = await makeFixture(2, "outcome_unknown", undefined, [], 4, undefined, undefined, undefined, { evidence });
  await f.runtime.open({ ...f.request, protocolStreams: [] });
  seedAdoptedCleanup(f, 0, true); // persisted predecessor attempt; observation must join it, never rerun its stop
  const originalStopEffects = f.calls.filter(call => call === "reconcile").length, initialReattachments = f.reattachCalls;
  f.runtimeOptions.host.observeQuiescence = async () => f.reattachCalls > initialReattachments ? "verified" : "blocked";
  const recovery = f.createRecoveryRuntime();
  try {
    await recovery.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 1000 });
    assert.equal(f.kernel.store.readBySession("stream-1")!.state, "released");
    assert.ok(f.reattachCalls > initialReattachments, "a terminal output-dependent backend cannot prove emptiness without its exact evidence reader");
    assert.equal(f.calls.filter(call => call === "reconcile").length, originalStopEffects, "an unknown stop effect must not be repeated");
  } finally { f.kernel.store.close(); }
}));

test("managed fresh host reads authenticated finalized evidence after the live checkpoint has been retired", async t => withSyntheticFixtureEvidence(t, async evidence => {
  const f = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, undefined, { evidence });
  await f.runtime.open({ ...f.request, protocolStreams: [] });
  const bytes = Buffer.from("final-output"), metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: bytes.length, byteLength: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") };
  await f.emit({ metadata, bytes, acknowledge: async () => undefined });
  await f.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 1000 });
  assert.equal(f.kernel.store.readOutputCheckpoint("stream-1"), undefined);
  const launches = f.launchCalls, reattachments = f.reattachCalls;
  const recovery = f.createRecoveryRuntime();
  try {
    await assert.rejects(recovery.observeOwnedOutput({ sessionId: "stream-1", owner: { ...f.request.binding, runId: "foreign" } }), /owner|identity/i);
    const observed = await recovery.observeOwnedOutput({ sessionId: "stream-1", owner: f.request.binding });
    assert.equal(observed.record.state, "released"); assert.match(observed.output.streams[0]!.tail, /final-output$/);
    assert.equal(f.launchCalls, launches); assert.equal(f.reattachCalls, reattachments, "terminal evidence reads do not reacquire native resources");
    assert.equal(f.deliveries, 0);
  } finally { f.kernel.store.close(); }
}));


test("Task11 exceptional authority is rechecked between streaming cleanup resources", async () => {
  const f = await makeFixture(2, "cleaned");
  await f.runtime.open(f.request);
  let checks = 0;
  const error = await f.runtime.cleanupOwnedSession({
    sessionId: "stream-1",
    timeoutMs: 2_000,
    assertAuthority: () => {
      checks += 1;
      if (checks === 6) throw new Error("recovery grant revoked");
    },
  }).then(() => undefined, (value: unknown) => value);
  assert.ok(error instanceof Error);
  assert.match(error.message, /recovery grant revoked/);
  assert.ok(checks >= 6);
  assert.equal(f.calls.includes("reconcile"), true, "one exact cleanup resource executed before revocation");
  assert.notEqual(f.kernel.store.readBySession("stream-1")?.state, "released",
    "revocation blocks later cleanup resources and terminal release");
  await f.runtime.cleanupOwnedSession({ sessionId: "stream-1", timeoutMs: 2_000 });
  assert.equal(f.kernel.store.readBySession("stream-1")?.state, "released");
  await f.grants.revokeAll("cleanup");
});
