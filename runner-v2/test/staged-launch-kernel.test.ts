import assert from "node:assert/strict";
import test from "node:test";

import { createExecutionGrantAuthority, ExecutionGrantError } from "../src/execution-grants.js";
import { createSessionAuthority, SessionAuthorityError } from "../src/session-authority.js";
import {
  HOST_LAUNCH_RECORD_VERSION,
  StreamingSessionStoreError,
  createInMemoryStreamingSessionStore,
  getStreamingSessionKernelWriter,
  parseHostLaunchRecord,
} from "../src/streaming-session-store.js";

const now = "2026-08-30T00:00:00.000Z";

test("stageLaunch consumes the grant before an isolation effect and is alias-safe", async () => {
  const grants = createExecutionGrantAuthority({ clock: () => new Date(now) });
  const binding = {
    runId: "run-1", sessionId: "agent-1", actor: { role: "worker" as const, id: "worker-1" },
    toolName: "process.start", callId: "call-1", permissionProfile: "full" as const,
  };
  const grant = await grants.issue({
    ...binding, workspacePath: process.cwd(), access: [], externalApproved: false,
    destructiveApproved: false, networkApproved: false,
  });
  const authority = createSessionAuthority({
    grants, sessions: createInMemoryStreamingSessionStore(), clock: () => new Date(now),
  });
  const staged = authority.stageLaunch({ sessionId: "stream-1", launchId: "launch-1", grant, binding });
  assert.throws(() => grants.consume(grant, binding),
    (error) => error instanceof ExecutionGrantError && error.code === "grant_consumed");
  assert.throws(
    () => authority.stageLaunch({ sessionId: "stream-2", launchId: "launch-2", grant, binding }),
    (error) => error instanceof SessionAuthorityError && error.code === "launch_call_consumed",
  );
  assert.equal(JSON.stringify(staged), "{}");
});

test("host launch parser rejects forbidden recursive durable values", () => {
  const base = hostRecord();
  assert.equal(parseHostLaunchRecord(base).schemaVersion, HOST_LAUNCH_RECORD_VERSION);
  assert.throws(
    () => parseHostLaunchRecord({ ...base, command: { nested: { argv: ["secret"] } } }),
    (error) => error instanceof StreamingSessionStoreError &&
      ["unknown_field", "forbidden_durable_value"].includes(error.code),
  );
});

test("host launch effects are fenced, monotonic, idempotent, and capacity bounded", () => {
  const kernel = createInMemoryStreamingSessionStore({ maxHostLaunchRecords: 1 });
  const writer = getStreamingSessionKernelWriter(kernel);
  assert.equal(writer.prepareLaunch(hostRecord()).won, true);
  const isolated = writer.transitionLaunch({
    type: "bind_isolation", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1,
    expectedRevision: 0, leaseId: "lease-1", providerId: "fake", providerIdentity: "a".repeat(64), at: now,
  });
  assert.equal(isolated.state, "isolated");
  assert.deepEqual(writer.transitionLaunch({
    type: "bind_isolation", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1,
    expectedRevision: 0, leaseId: "lease-1", providerId: "fake", providerIdentity: "a".repeat(64), at: now,
  }), isolated);
  assert.throws(() => writer.transitionLaunch({
    type: "begin_launch", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 2,
    expectedRevision: 1, at: now,
  }), (error) => error instanceof StreamingSessionStoreError && error.code === "stale_fence");
  assert.throws(() => writer.prepareLaunch({ ...hostRecord(), launchId: "launch-2" }),
    (error) => error instanceof StreamingSessionStoreError && error.code === "capacity_exceeded");
});

test("finalizeLaunch atomically hands host ownership to one active session and consumes its alias once", async () => {
  const grants = createExecutionGrantAuthority({ clock: () => new Date(now) });
  const binding = { runId: "run-1", sessionId: "agent-1", actor: { role: "worker" as const, id: "worker-1" }, toolName: "process.start", callId: "call-1", permissionProfile: "full" as const };
  const grant = await grants.issue({ ...binding, workspacePath: process.cwd(), access: [], externalApproved: false, destructiveApproved: false, networkApproved: false });
  const kernel = createInMemoryStreamingSessionStore();
  const authority = createSessionAuthority({ grants, sessions: kernel, clock: () => new Date(now) });
  const staged = authority.stageLaunch({ sessionId: "stream-1", launchId: "launch-1", grant, binding });
  const writer = getStreamingSessionKernelWriter(kernel);
  writer.prepareLaunch(hostRecord());
  writer.transitionLaunch({ type: "bind_isolation", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 0, leaseId: "lease-1", providerId: "fake", providerIdentity: "a".repeat(64), at: now });
  writer.transitionLaunch({ type: "begin_launch", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 1, at: now });
  writer.transitionLaunch({ type: "bind_backend", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 2, backendBinding: backendBinding(), at: now });
  const verified = writer.transitionLaunch({ type: "verify_handshake", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 3, handshakeDigest: "b".repeat(64), at: now });
  const result = authority.finalizeLaunch({ staged, launchId: "launch-1", sessionId: "stream-1", ownerId: verified.ownerId, fencingToken: verified.fencingToken, expectedRevision: verified.revision, lease: { leaseId: "lease-1", providerId: "fake", invocationId: "invoke-1", providerIdentity: "a".repeat(64), acquiredAt: now, access: [] }, backendBinding: backendBinding(), handshakeDigest: "b".repeat(64), envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false } });
  assert.equal(result.record.state, "active");
  assert.equal(kernel.store.readHostLaunch("launch-1")?.state, "handed_off");
  assert.throws(() => authority.finalizeLaunch({ staged, launchId: "launch-1", sessionId: "stream-1", ownerId: verified.ownerId, fencingToken: verified.fencingToken, expectedRevision: verified.revision, lease: result.record.lease, backendBinding: backendBinding(), handshakeDigest: "b".repeat(64), envelope: result.record.envelope }), (error) => error instanceof SessionAuthorityError && error.code === "launch_call_consumed");
});

function hostRecord() {
  return {
    recordKind: "runner.host-launch" as const, schemaVersion: HOST_LAUNCH_RECORD_VERSION,
    revision: 0, launchId: "launch-1", sessionId: "stream-1", runId: "run-1",
    agentSessionId: "agent-1", actor: { role: "worker" as const, id: "worker-1" },
    toolName: "process.start", callId: "call-1", ownerId: "host:run-1", fencingToken: 1,
    state: "prepared" as const, cleanupOwner: "host_control" as const,
    history: [{ state: "prepared" as const, at: now }], effects: [{
      effectId: "isolate:launch-1", kind: "isolate" as const, status: "pending" as const,
      ownerId: "host:run-1", fencingToken: 1, createdAt: now,
    }],
  };
}

function backendBinding() {
  return { registryId: "registry-1", backendId: "fake", implementationGeneration: "g1", implementationDigest: "c".repeat(64), attestationVersion: 1, attestationDigest: "d".repeat(64), opaqueIdentity: "opaque-1", birthFingerprint: { observedAt: now, discriminator: "birth-1" }, rootPid: 42, startedAt: now };
}
