import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import { createSessionAuthority } from "../src/session-authority.js";
import { createStreamingProcessSessionRuntime, StreamingProcessSessionError } from "../src/streaming-process-session-runtime.js";
import { createInMemoryStreamingSessionStore } from "../src/streaming-session-store.js";

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
  assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "released");
  assert.equal(fixture.kernel.store.readBySession("stream-1"), undefined);
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

test("runtime-owned v2 sink tees evidence, checkpoints protocol bytes, and acknowledges exactly", async () => {
  const fixture = await makeFixture(); await fixture.runtime.open(fixture.request);
  const bytes = Buffer.from("x"); const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1, digest: createHash("sha256").update(bytes).digest("hex") }; let ack = 0;
  await fixture.emit({ metadata, bytes, acknowledge: async () => { ack++; } });
  assert.equal(ack, 1); assert.equal(fixture.evidenceWrites, 1); assert.equal(fixture.deliveries, 1);
  assert.deepEqual(fixture.kernel.store.readOutputCheckpoint("stream-1")?.streams.find((stream) => stream.stream === "stdout")?.lastConsumed, metadata);
});

test("live grant revocation at every pre-adoption phase settles one exact cleanup", async () => {
  for (const phase of ["isolate", "launch", "channel", "output", "handshake"] as const) {
    const fixture = await makeFixture(2, "cleaned", undefined, [], 4, phase);
    await assert.rejects(fixture.runtime.open(fixture.request), /grant_revoked|stale|unavailable|consumed/i);
    assert.equal(fixture.kernel.store.readHostLaunch("launch-1")?.state, "released", phase);
    assert.equal(fixture.releaseCalls, 1, phase);
  }
});

async function makeFixture(outputVersion = 2, reconcileOutcome: "cleaned" | "blocked" | "outcome_unknown" = "outcome_unknown", handshakeVerify?: () => Promise<string>, retainedWindow: readonly unknown[] = [], replayCapacityChunks = 4, revokeAt?: "isolate" | "launch" | "channel" | "output" | "handshake") {
  const grants = createExecutionGrantAuthority({ clock: () => new Date(now) });
  const kernel = createInMemoryStreamingSessionStore();
  const authority = createSessionAuthority({ grants, sessions: kernel, clock: () => new Date(now) });
  const binding = { runId: "run-1", sessionId: "agent-1", actor: { role: "worker" as const, id: "worker-1" }, toolName: "process.start", callId: "call-1", permissionProfile: "full" as const };
  const grant = await grants.issue({ ...binding, workspacePath: process.cwd(), access: [], externalApproved: false, destructiveApproved: false, networkApproved: false });
  const calls: string[] = [];
  let launchCalls = 0;
  let waitTerminalCalls = 0;
  let outputSink: ((chunk: import("../src/streaming-output-controller.js").StreamingOutputChunk) => Promise<void>) | undefined;
  let evidenceWrites = 0; let deliveries = 0;
  let releaseCalls = 0;
  const maybeRevoke = (phase: typeof revokeAt) => { if (revokeAt === phase) void grants.revoke(grant, "cancelled"); };
  const backendBinding = { registryId: "registry-1", backendId: "fake", implementationGeneration: "g1", implementationDigest: "c".repeat(64), attestationVersion: 1, attestationDigest: "d".repeat(64), opaqueIdentity: "opaque-1", birthFingerprint: { observedAt: now, discriminator: "birth-1" }, rootPid: 42, startedAt: now };
  const runtime = createStreamingProcessSessionRuntime({
    sessions: authority, kernel, clock: () => new Date(now),
    isolation: { acquire: async () => { calls.push("isolate"); maybeRevoke("isolate"); return { leaseId: "lease-1", providerId: "fake", invocationId: "invoke-1", providerIdentity: "a".repeat(64), acquiredAt: now, access: [] }; }, release: async () => { releaseCalls++; } },
    host: { launch: async () => { calls.push("launch"); launchCalls++; maybeRevoke("launch"); return backendBinding; }, reconcile: async () => reconcileOutcome },
    channel: { version: outputVersion, replayCapacityChunks: outputVersion === 2 ? replayCapacityChunks : undefined, replayCapacityBytes: outputVersion === 2 ? 16 : undefined, acquire: async () => { calls.push("channel"); maybeRevoke("channel"); return { startOutput: async (sink) => { outputSink = sink; calls.push("output"); maybeRevoke("output"); }, waitTerminal: async () => { waitTerminalCalls++; await new Promise(() => undefined); }, detach: async () => undefined }; }, reattach: async () => ({ channel: { startOutput: async () => undefined, waitTerminal: async () => { waitTerminalCalls++; }, detach: async () => undefined }, retainedWindow }) },
    handshake: { verify: async () => { calls.push("handshake"); maybeRevoke("handshake"); return handshakeVerify ? handshakeVerify() : "b".repeat(64); } },
    output: { maxQueueBytes: 16, maxQueueChunks: 4, maxFrameBytes: 16, maxAcceptedChunks: 4, protocolStreams: ["stdout"], createEvidenceSpool: () => ({ write: async () => { evidenceWrites++; } }), authorize: () => true, deliver: async () => { deliveries++; } },
  });
  const preparedRecord = (launchId = "launch-1", sessionId = "stream-1") => ({ recordKind: "runner.host-launch" as const, schemaVersion: 1 as const, revision: 0, launchId, sessionId, runId: "run-1", agentSessionId: "agent-1", actor: { role: "worker" as const, id: "worker-1" }, toolName: "process.start", callId: "call-1", ownerId: "host:run-1", fencingToken: 1, ownerExpiresAt: "2026-08-30T00:01:00.000Z", state: "prepared" as const, cleanupOwner: "host_control" as const, history: [{ state: "prepared" as const, at: now }], effects: [{ effectId: `isolate:${launchId}`, kind: "isolate" as const, status: "pending" as const, ownerId: "host:run-1", fencingToken: 1, createdAt: now }] });
  const request = { sessionId: "stream-1", launchId: "launch-1", grant, binding, envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false }, preparedRecord: preparedRecord() };
  return { runtime, request, calls, kernel, kernelWriter: (await import("../src/streaming-session-store.js")).getStreamingSessionKernelWriter(kernel), preparedRecord, emit: async (chunk: import("../src/streaming-output-controller.js").StreamingOutputChunk) => { assert.ok(outputSink); await outputSink(chunk); }, get launchCalls() { return launchCalls; }, get waitTerminalCalls() { return waitTerminalCalls; }, get evidenceWrites() { return evidenceWrites; }, get deliveries() { return deliveries; }, get releaseCalls() { return releaseCalls; } };
}
