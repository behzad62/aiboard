import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { BoundedOutputSpoolResult } from "../src/bounded-output-spool.js";

import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import { createSessionAuthority } from "../src/session-authority.js";
import { createStreamingProcessSessionRuntime, StreamingProcessSessionError, type StreamingRuntimeOptions } from "../src/streaming-process-session-runtime.js";
import { createInMemoryStreamingSessionStore, getStreamingSessionKernelWriter, type StreamingSessionBackendBinding } from "../src/streaming-session-store.js";

const now = "2026-08-30T00:00:00.000Z";

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

test("adopted recovery reattaches nonblockingly and marks missing retained accepted bytes outcome unknown", async () => {
  const fixture = await makeFixture(2, "cleaned", undefined, []);
  await fixture.runtime.open(fixture.request);
  const writer = fixture.kernelWriter;
  const metadata = { stream: "stdout", sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1, digest: "e".repeat(64) };
  writer.applyOutputCheckpoint({ type: "accept", sessionId: "stream-1", ownerId: fixture.kernel.store.readBySession("stream-1")!.ownerId, fencingToken: 1, expectedRevision: 0, metadata });
  const before = fixture.launchCalls;
  const result = await fixture.runtime.reconcileStartup({ maxRecords: 4 });
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
  assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "released");
  assert.equal(fixture.finalizeCalls, 1); assert.equal(fixture.detachCalls, 1);
  assert.equal(fixture.releaseCalls, 1, "adopted cleanup releases the exact isolation lease");
  assert.ok(fixture.calls.includes("reconcile"), "adopted cleanup verifies the exact host");
});

test("oversized asynchronous output settles adopted cleanup and finalizes the spool", async () => {
  const fixture = await makeFixture(2, "cleaned"); await fixture.runtime.open(fixture.request);
  const bytes = Buffer.alloc(17); const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 17, byteLength: 17, digest: createHash("sha256").update(bytes).digest("hex") };
  await assert.rejects(fixture.emit({ metadata, bytes, acknowledge: async () => assert.fail("no ack") }));
  assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "released");
  assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1")?.outcome, "outcome_unknown");
  assert.equal(fixture.detachCalls, 1); assert.equal(fixture.finalizeCalls, 1);
});

test("unverified adopted host cleanup preserves blocked disposition instead of claiming release", async () => {
  const fixture = await makeFixture(2, "blocked"); const facade = await fixture.runtime.open(fixture.request);
  const operation = { sessionId: "stream-1", operation: "stop" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
  await assert.rejects(facade.stop(facade.authorizeFirstOperation(operation), { ...operation, binding: fixture.request.binding }), AggregateError);
  assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "cleanup_blocked");
  assert.equal(fixture.releaseCalls, 1);
});

test("live grant revocation at every pre-adoption phase settles one exact cleanup", async () => {
  for (const phase of ["isolate", "launch", "channel", "output", "handshake"] as const) {
    const fixture = await makeFixture(2, "cleaned", undefined, [], 4, phase);
    await assert.rejects(fixture.runtime.open(fixture.request), /grant_revoked|stale|unavailable|consumed/i);
    assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "released", phase);
    assert.equal(fixture.releaseCalls, 1, phase);
  }
});

test("active cancellation at every provider boundary releases late-returned resources", async () => {
  for (const phase of ["isolate", "launch", "channel", "output", "handshake"]) {
    const abort = new AbortController();
    const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, undefined, (current) => { if (current === phase) abort.abort(); });
    await assert.rejects(fixture.runtime.open({ ...fixture.request, signal: abort.signal }));
    await waitUntil(() => fixture.kernel.store.readHostLaunch("launch-1")?.state === "released");
    assert.equal(fixture.releaseCalls, 1, phase);
    assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "released", phase);
    assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1"), undefined, phase);
    if (["channel", "output", "handshake"].includes(phase)) assert.equal(fixture.detachCalls, 1, phase);
  }
});

test("startup recovery spends one total deadline and every inspected terminal row consumes the count bound", async () => {
  const fixture = await makeFixture(2, "cleaned", undefined, [], 4, undefined, async () => { await new Promise((resolve) => setTimeout(resolve, 15)); return "cleaned"; });
  fixture.kernelWriter.prepareLaunch(fixture.preparedRecord("aaa-terminal", "terminal-session"));
  let terminal = fixture.kernel.store.readHostLaunch("aaa-terminal")!;
  terminal = fixture.kernelWriter.transitionLaunch({ type: "begin_cleanup", launchId: "aaa-terminal", ownerId: terminal.ownerId, fencingToken: 1, expectedRevision: terminal.revision, at: now });
  fixture.kernelWriter.transitionLaunch({ type: "settle_cleanup_cleaned", launchId: "aaa-terminal", ownerId: terminal.ownerId, fencingToken: 1, expectedRevision: terminal.revision, at: now });
  fixture.kernelWriter.prepareLaunch(fixture.preparedRecord("zzz-pending-a", "pending-a-session")); fixture.kernelWriter.prepareLaunch(fixture.preparedRecord("zzz-pending-b", "pending-b-session")); fixture.kernelWriter.prepareLaunch(fixture.preparedRecord("zzz-pending-c", "pending-c-session"));
  const onlyTerminal = await fixture.runtime.reconcileStartup({ maxRecords: 1, timeoutMs: 20 });
  assert.equal(onlyTerminal.processed, 1); assert.deepEqual(onlyTerminal.outcomes, []);
  const started = Date.now(); const result = await fixture.runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 20 });
  assert.ok(Date.now() - started < 38, "one deadline must cover all inspected records"); assert.equal(result.processed, 4);
});

test("late reattach channel after recovery timeout is deterministically detached", async () => {
  const fixture = await makeFixture(); await fixture.runtime.open(fixture.request);
  let resolveLate!: () => void; let lateDetach = 0;
  fixture.setReattach(async (binding) => await new Promise((resolve) => { resolveLate = () => resolve({ version: 2, binding, replayCapacityChunks: 4, replayCapacityBytes: 16, retainedWindow: [], channel: { subscribeBackpressuredOutput: () => () => undefined, observeTerminal: () => () => undefined, detach: async () => { lateDetach++; } } }); }));
  const recovery = fixture.createRecoveryRuntime(); const result = await recovery.reconcileStartup({ maxRecords: 4, timeoutMs: 10 });
  assert.equal(result.sessionOutcomes[0]?.disposition, "input_unavailable");
  resolveLate(); await waitUntil(() => lateDetach === 1); assert.equal(lateDetach, 1);
  await waitUntil(() => fixture.kernel.store.readBySession("stream-1")?.state === "cleanup_blocked");
  assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, "cleanup_blocked");
});

test("late reattach racing durable blocked and released states always detaches exactly once", async () => {
  for (const durableOutcome of ["blocked", "cleaned"] as const) {
    const fixture = await makeFixture(); await fixture.runtime.open(fixture.request);
    let resolveLate!: () => void; let lateDetach = 0;
    fixture.setReattach(async (binding) => await new Promise((resolve) => { resolveLate = () => resolve({ version: 2, binding, replayCapacityChunks: 4, replayCapacityBytes: 16, retainedWindow: [], channel: { subscribeBackpressuredOutput: () => () => undefined, observeTerminal: () => () => undefined, detach: async () => { lateDetach++; } } }); }));
    const recovery = fixture.createRecoveryRuntime();
    const result = await recovery.reconcileStartup({ maxRecords: 4, timeoutMs: 10 });
    assert.equal(result.sessionOutcomes[0]?.disposition, "input_unavailable");
    const current = fixture.kernel.store.readBySession("stream-1")!;
    fixture.authority.recoverAdopted({ sessionId: "stream-1", ownerId: current.ownerId, fencingToken: current.fencingToken, replay: () => durableOutcome });
    resolveLate(); await waitUntil(() => lateDetach === 1);
    assert.equal(lateDetach, 1, durableOutcome);
    assert.equal(fixture.kernel.store.readBySession("stream-1")?.state, durableOutcome === "cleaned" ? "released" : "cleanup_blocked");
  }
});

test("failed late reattach cleanup is retained, surfaced, and retried without double successful detach", async () => {
  const fixture = await makeFixture(); await fixture.runtime.open(fixture.request);
  let resolveLate!: () => void; let lateDetach = 0;
  fixture.setReattach(async (binding) => await new Promise((resolve) => { resolveLate = () => resolve({ version: 2, binding, replayCapacityChunks: 4, replayCapacityBytes: 16, retainedWindow: [], channel: { subscribeBackpressuredOutput: () => () => undefined, observeTerminal: () => () => undefined, detach: async () => { lateDetach++; if (lateDetach === 1) throw new Error("late detach failed"); } } }); }));
  const recovery = fixture.createRecoveryRuntime(); await recovery.reconcileStartup({ maxRecords: 4, timeoutMs: 10 });
  const current = fixture.kernel.store.readBySession("stream-1")!;
  fixture.authority.recoverAdopted({ sessionId: "stream-1", ownerId: current.ownerId, fencingToken: current.fencingToken, replay: () => "cleaned" });
  resolveLate(); await waitUntil(() => lateDetach === 1); await new Promise((resolve) => setImmediate(resolve));
  const retried = await recovery.reconcileStartup({ maxRecords: 4, timeoutMs: 100 });
  assert.equal(retried.lateCleanupFailures.length, 1);
  assert.equal(retried.lateCleanupFailures[0]?.sessionId, "stream-1");
  assert.match(retried.lateCleanupFailures[0]?.message ?? "", /late detach failed/);
  assert.equal(lateDetach, 2, "one failed detach and one successful retry");
});

test("recovery creates an attachment with the exact current non-one owner fence", async () => {
  const fixture = await makeFixture(); const opened = await fixture.runtime.open(fixture.request); void opened;
  const source = fixture.kernel.store.readBySession("stream-1")!; const checkpoint = fixture.kernel.store.readOutputCheckpoint("stream-1")!;
  const kernel = createInMemoryStreamingSessionStore();
  getStreamingSessionKernelWriter(kernel).claim({ ...source, ownerId: "recovery-owner", fencingToken: 2 });
  getStreamingSessionKernelWriter(kernel).claimOutputCheckpoint({ ...checkpoint, ownerId: "recovery-owner", fencingToken: 2 });
  const authority = createSessionAuthority({ grants: fixture.grants, sessions: kernel, clock: () => new Date(now) });
  const runtime = createStreamingProcessSessionRuntime({ ...fixture.runtimeOptions, sessions: authority, kernel });
  const result = await runtime.reconcileStartup({ maxRecords: 1, timeoutMs: 100 });
  assert.deepEqual(result.sessionOutcomes, [{ sessionId: "stream-1", disposition: "reattached" }]);
  assert.equal(kernel.store.readOutputCheckpoint("stream-1")?.fencingToken, 2);
});

test("expired adopted recovery atomically takes over session and output fences before reattach", async () => {
  const fixture = await makeFixture(); await fixture.runtime.open(fixture.request);
  const source = fixture.kernel.store.readBySession("stream-1")!; const checkpoint = fixture.kernel.store.readOutputCheckpoint("stream-1")!;
  const kernel = createInMemoryStreamingSessionStore(); getStreamingSessionKernelWriter(kernel).claim(source); getStreamingSessionKernelWriter(kernel).claimOutputCheckpoint(checkpoint);
  const authority = createSessionAuthority({ grants: fixture.grants, sessions: kernel, clock: () => new Date("2026-08-30T00:02:00.000Z") });
  const runtime = createStreamingProcessSessionRuntime({ ...fixture.runtimeOptions, sessions: authority, kernel, clock: () => new Date("2026-08-30T00:02:00.000Z") });
  const result = await runtime.reconcileStartup({ maxRecords: 1, timeoutMs: 100 });
  assert.equal(result.sessionOutcomes[0]?.disposition, "reattached"); assert.equal(kernel.store.readBySession("stream-1")?.fencingToken, 2); assert.equal(kernel.store.readOutputCheckpoint("stream-1")?.fencingToken, 2);
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
  await assert.rejects(failedFacade.stop(failedFacade.authorizeFirstOperation(operation), { ...operation, binding: failed.request.binding }), /finalize proof lost|durably settled/);
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

test("abort is caller-bounded when every provider phase is permanently noncooperative", { timeout: 2_000 }, async () => {
  for (const phase of ["isolate", "launch", "channel", "handshake"] as const) {
    const fixture = await makeFixture(2, "cleaned"); const never = async () => await new Promise<never>(() => undefined);
    if (phase === "isolate") fixture.setIsolationAcquire(never);
    if (phase === "launch") fixture.setHostLaunch(never);
    if (phase === "channel") fixture.setChannelAcquire(never);
    if (phase === "handshake") fixture.setHandshake(never);
    const abort = new AbortController(); const opening = fixture.runtime.open({ ...fixture.request, signal: abort.signal }); setTimeout(() => abort.abort(), 10);
    const started = Date.now(); await assert.rejects(opening); assert.ok(Date.now() - started < 200, phase); assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "cleanup_blocked", phase);
    if (phase !== "isolate") assert.equal(fixture.releaseCalls, 1, `${phase}: already-known lease must be released immediately`);
    assert.equal(fixture.calls.filter((call) => call === "reconcile").length, 1, `${phase}: known host state must be reconciled immediately`);
    if (phase === "handshake") {
      assert.equal(fixture.detachCalls, 1, "handshake: already-known channel must detach immediately");
      assert.equal(fixture.kernel.store.readOutputCheckpoint("stream-1"), undefined, "handshake: pre-adoption checkpoint must settle immediately");
    }
  }
});

test("late channel after immediate cancellation cleanup is detached without repeating known cleanup", { timeout: 1_000 }, async () => {
  const fixture = await makeFixture(2, "cleaned"); let resolveChannel!: (channel: import("../src/streaming-process-session-runtime.js").FakeStreamingChannel) => void;
  fixture.setChannelAcquire(async () => await new Promise((resolve) => { resolveChannel = resolve; }));
  const abort = new AbortController(); const opening = fixture.runtime.open({ ...fixture.request, signal: abort.signal }); setTimeout(() => abort.abort(), 10);
  await assert.rejects(opening);
  assert.equal(fixture.releaseCalls, 1); assert.equal(fixture.calls.filter((call) => call === "reconcile").length, 1);
  resolveChannel({ subscribeBackpressuredOutput: () => () => undefined, observeTerminal: () => () => undefined, detach: async () => { fixture.calls.push("late-detach"); } });
  await waitUntil(() => fixture.calls.includes("late-detach"));
  assert.equal(fixture.calls.filter((call) => call === "late-detach").length, 1);
  assert.equal(fixture.releaseCalls, 1); assert.equal(fixture.calls.filter((call) => call === "reconcile").length, 1);
});

async function makeFixture(outputVersion = 2, reconcileOutcome: "cleaned" | "blocked" | "outcome_unknown" = "outcome_unknown", handshakeVerify?: () => Promise<string>, retainedWindow: readonly import("../src/streaming-output-controller.js").StreamingOutputMetadata[] = [], replayCapacityChunks = 4, revokeAt?: "isolate" | "launch" | "channel" | "output" | "handshake", reconcileOverride?: () => Promise<"cleaned" | "blocked" | "outcome_unknown">, onPhase?: (phase: string) => void) {
  const grants = createExecutionGrantAuthority({ clock: () => new Date(now) });
  const kernel = createInMemoryStreamingSessionStore();
  const authority = createSessionAuthority({ grants, sessions: kernel, clock: () => new Date(now) });
  const binding = { runId: "run-1", sessionId: "agent-1", actor: { role: "worker" as const, id: "worker-1" }, toolName: "process.start", callId: "call-1", permissionProfile: "full" as const };
  const grant = await grants.issue({ ...binding, workspacePath: process.cwd(), access: [], externalApproved: false, destructiveApproved: false, networkApproved: false });
  const calls: string[] = [];
  let launchCalls = 0;
  const waitTerminalCalls = 0;
  let outputSink: ((metadata: import("../src/streaming-output-controller.js").StreamingOutputMetadata, bytes: Uint8Array) => Promise<import("../src/streaming-output-controller.js").StreamingOutputMetadata>) | undefined;
  let evidenceWrites = 0; let deliveries = 0;
  let releaseCalls = 0;
  let finalizeCalls = 0; let detachCalls = 0;
  let isolationAcquireOverride: (() => Promise<ReturnType<typeof leaseRecord>>) | undefined;
  let hostLaunchOverride: (() => Promise<typeof backendBinding>) | undefined;
  let channelAcquireOverride: (() => Promise<import("../src/streaming-process-session-runtime.js").FakeStreamingChannel>) | undefined;
  let handshakeOverride: (() => Promise<string>) | undefined;
  let reattachOverride: ((binding: StreamingSessionBackendBinding) => ReturnType<NonNullable<StreamingRuntimeOptions["channel"]["reattach"]>>) | undefined;
  let evidenceSpoolOverride: (() => { write(stream: "stdout" | "stderr", bytes: Uint8Array): Promise<void>; finalize(): Promise<unknown>; cleanup(): Promise<void> }) | undefined;
  const maybeRevoke = (phase: typeof revokeAt) => { if (phase) onPhase?.(phase); if (revokeAt === phase) void grants.revoke(grant, "cancelled"); };
  const backendBinding = { registryId: "registry-1", backendId: "fake", implementationGeneration: "g1", implementationDigest: "c".repeat(64), attestationVersion: 1, attestationDigest: "d".repeat(64), opaqueIdentity: "opaque-1", birthFingerprint: { observedAt: now, discriminator: "birth-1" }, rootPid: 42, startedAt: now };
  const runtimeOptions = {
    sessions: authority, kernel, clock: () => new Date(now),
    isolation: { acquire: async () => { calls.push("isolate"); maybeRevoke("isolate"); return isolationAcquireOverride ? await isolationAcquireOverride() : leaseRecord(); }, release: async () => { releaseCalls++; } },
    host: { launch: async () => { calls.push("launch"); launchCalls++; maybeRevoke("launch"); return hostLaunchOverride ? await hostLaunchOverride() : backendBinding; }, reconcile: async () => { calls.push("reconcile"); return reconcileOverride ? reconcileOverride() : reconcileOutcome; } },
    channel: { version: outputVersion, replayCapacityChunks: outputVersion === 2 ? replayCapacityChunks : undefined, replayCapacityBytes: outputVersion === 2 ? 16 : undefined, acquire: async () => { calls.push("channel"); maybeRevoke("channel"); return channelAcquireOverride ? await channelAcquireOverride() : { subscribeBackpressuredOutput: (sink) => { outputSink = sink; calls.push("output"); maybeRevoke("output"); return () => { outputSink = undefined; }; }, observeTerminal: () => () => undefined, detach: async () => { detachCalls++; } }; }, reattach: async (binding) => reattachOverride ? await reattachOverride(binding) : ({ version: 2 as const, binding, replayCapacityChunks: 4, replayCapacityBytes: 16, channel: { subscribeBackpressuredOutput: (sink) => { outputSink = sink; for (const metadata of retainedWindow) queueMicrotask(() => { void sink(metadata, Buffer.alloc(metadata.byteLength)).catch(() => undefined); }); return () => { outputSink = undefined; }; }, observeTerminal: () => () => undefined, detach: async () => { detachCalls++; } }, retainedWindow }) },
    handshake: { verify: async () => { calls.push("handshake"); maybeRevoke("handshake"); return handshakeOverride ? await handshakeOverride() : handshakeVerify ? handshakeVerify() : "b".repeat(64); } },
    output: { maxQueueBytes: 16, maxQueueChunks: 4, maxFrameBytes: 16, maxAcceptedChunks: 4, protocolStreams: ["stdout"], createEvidenceSpool: () => evidenceSpoolOverride ? evidenceSpoolOverride() : ({ write: async () => { evidenceWrites++; }, finalize: async () => { finalizeCalls++; return { streams: [] }; }, cleanup: async () => undefined }), deliver: async () => { deliveries++; } },
  } satisfies Parameters<typeof createStreamingProcessSessionRuntime>[0];
  const runtime = createStreamingProcessSessionRuntime(runtimeOptions);
  const preparedRecord = (launchId = "launch-1", sessionId = "stream-1") => ({ recordKind: "runner.host-launch" as const, schemaVersion: 1 as const, revision: 0, launchId, sessionId, runId: "run-1", agentSessionId: "agent-1", actor: { role: "worker" as const, id: "worker-1" }, toolName: "process.start", callId: "call-1", ownerId: "host:run-1", fencingToken: 1, ownerExpiresAt: "2026-08-30T00:01:00.000Z", state: "prepared" as const, cleanupOwner: "host_control" as const, history: [{ state: "prepared" as const, at: now }], effects: [{ effectId: `isolate:${launchId}`, kind: "isolate" as const, status: "pending" as const, ownerId: "host:run-1", fencingToken: 1, createdAt: now }] });
  const request = { sessionId: "stream-1", launchId: "launch-1", grant, binding, envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false }, preparedRecord: preparedRecord() };
  return { runtimeOptions, grants, runtime, createRecoveryRuntime: () => createStreamingProcessSessionRuntime(runtimeOptions), setIsolationAcquire: (value: typeof isolationAcquireOverride) => { isolationAcquireOverride = value; }, setHostLaunch: (value: typeof hostLaunchOverride) => { hostLaunchOverride = value; }, setChannelAcquire: (value: typeof channelAcquireOverride) => { channelAcquireOverride = value; }, setHandshake: (value: typeof handshakeOverride) => { handshakeOverride = value; }, setReattach: (value: typeof reattachOverride) => { reattachOverride = value; }, setEvidenceSpool: (value: typeof evidenceSpoolOverride) => { evidenceSpoolOverride = value; }, request, calls, kernel, authority, kernelWriter: (await import("../src/streaming-session-store.js")).getStreamingSessionKernelWriter(kernel), preparedRecord, emit: async (chunk: { metadata: import("../src/streaming-output-controller.js").StreamingOutputMetadata; bytes: Uint8Array; acknowledge: (metadata: import("../src/streaming-output-controller.js").StreamingOutputMetadata) => Promise<void> }) => { assert.ok(outputSink); const acknowledgement = await outputSink(chunk.metadata, chunk.bytes); await chunk.acknowledge(acknowledgement); }, get launchCalls() { return launchCalls; }, get waitTerminalCalls() { return waitTerminalCalls; }, get evidenceWrites() { return evidenceWrites; }, get deliveries() { return deliveries; }, get releaseCalls() { return releaseCalls; }, get finalizeCalls() { return finalizeCalls; }, get detachCalls() { return detachCalls; } };
}

function leaseRecord() { return { leaseId: "lease-1", providerId: "fake", invocationId: "invoke-1", providerIdentity: "a".repeat(64), acquiredAt: now, access: [] }; }
async function waitUntil(predicate: () => boolean) { for (let index = 0; index < 20 && !predicate(); index++) await new Promise((resolve) => setTimeout(resolve, 5)); }
