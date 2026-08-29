import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createExecutionGrantAuthority, ExecutionGrantError } from "../src/execution-grants.js";
import { createSessionAuthority, SessionAuthorityError } from "../src/session-authority.js";
import {
  HOST_LAUNCH_RECORD_VERSION,
  StreamingSessionStoreError,
  createInMemoryStreamingSessionStore,
  getStreamingSessionKernelWriter,
  parseHostLaunchRecord,
  openSqliteStreamingSessionStore,
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

test("staged authorization rejects forgery, identity mismatch, revocation, and expiry", async () => {
  let time = Date.parse(now); const grants = createExecutionGrantAuthority({ clock: () => new Date(time), ttlMs: 1_000 });
  const binding = { runId: "run-1", sessionId: "agent-1", actor: { role: "worker" as const, id: "worker-1" }, toolName: "process.start", callId: "call-1", permissionProfile: "full" as const };
  const grant = await grants.issue({ ...binding, workspacePath: process.cwd(), access: [], externalApproved: false, destructiveApproved: false, networkApproved: false });
  const authority = createSessionAuthority({ grants, sessions: createInMemoryStreamingSessionStore(), clock: () => new Date(time) });
  const staged = authority.stageLaunch({ sessionId: "stream-1", launchId: "launch-1", grant, binding });
  assert.throws(() => authority.validateStagedLaunch({} as typeof staged, { sessionId: "stream-1", launchId: "launch-1" }), (error) => error instanceof SessionAuthorityError && error.code === "launch_call_consumed");
  assert.throws(() => authority.validateStagedLaunch(staged, { sessionId: "stream-1", launchId: "wrong" }), (error) => error instanceof SessionAuthorityError && error.code === "binding_mismatch");
  await grants.revoke(grant, "cancelled");
  assert.throws(() => authority.validateStagedLaunch(staged, { sessionId: "stream-1", launchId: "launch-1" }), /grant_revoked/);
  const binding2 = { ...binding, callId: "call-2" }; const grant2 = await grants.issue({ ...binding2, workspacePath: process.cwd(), access: [], externalApproved: false, destructiveApproved: false, networkApproved: false });
  const staged2 = authority.stageLaunch({ sessionId: "stream-2", launchId: "launch-2", grant: grant2, binding: binding2 }); time += 2_000;
  assert.throws(() => authority.validateStagedLaunch(staged2, { sessionId: "stream-2", launchId: "launch-2" }), /grant_expired/);
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
  const finalize = { staged, launchId: "launch-1", sessionId: "stream-1", ownerId: verified.ownerId, fencingToken: verified.fencingToken, expectedRevision: verified.revision, lease: { leaseId: "lease-1", providerId: "fake", invocationId: "invoke-1", providerIdentity: "a".repeat(64), acquiredAt: now, access: [] }, backendBinding: backendBinding(), handshakeDigest: "b".repeat(64), envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false } };
  for (const mismatch of [
    { ...finalize, launchId: "wrong-launch" },
    { ...finalize, lease: { ...finalize.lease, leaseId: "wrong-lease" } },
    { ...finalize, backendBinding: { ...finalize.backendBinding, opaqueIdentity: "wrong-backend" } },
    { ...finalize, handshakeDigest: "e".repeat(64) },
  ]) assert.throws(() => authority.finalizeLaunch(mismatch), (error) => error instanceof SessionAuthorityError && error.code === "binding_mismatch");
  const result = authority.finalizeLaunch(finalize);
  assert.equal(result.record.state, "active");
  assert.equal(kernel.store.readHostLaunch("launch-1")?.state, "handed_off");
  assert.throws(() => authority.finalizeLaunch({ staged, launchId: "launch-1", sessionId: "stream-1", ownerId: verified.ownerId, fencingToken: verified.fencingToken, expectedRevision: verified.revision, lease: result.record.lease, backendBinding: backendBinding(), handshakeDigest: "b".repeat(64), envelope: result.record.envelope }), (error) => error instanceof SessionAuthorityError && error.code === "launch_call_consumed");
});

test("host cleanup is fenced through pending, blocked, expired-owner takeover, and released", () => {
  const kernel = createInMemoryStreamingSessionStore(); const writer = getStreamingSessionKernelWriter(kernel);
  writer.prepareLaunch(hostRecord());
  let record = writer.transitionLaunch({ type: "begin_cleanup", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 0, at: now });
  assert.equal(record.state, "cleanup_pending");
  record = writer.transitionLaunch({ type: "settle_cleanup_blocked", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 1, blocker: "fake refusal", at: now });
  assert.equal(record.state, "cleanup_blocked");
  assert.throws(() => writer.transitionLaunch({ type: "takeover_cleanup", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 2, newOwnerId: "recovery:1", newFencingToken: 2, ownerExpiresAt: "2026-08-30T00:02:00.000Z", at: "2026-08-30T00:00:30.000Z" }), (error) => error instanceof StreamingSessionStoreError && error.code === "lease_not_expired");
  record = writer.transitionLaunch({ type: "takeover_cleanup", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 2, newOwnerId: "recovery:1", newFencingToken: 2, ownerExpiresAt: "2026-08-30T00:03:00.000Z", at: "2026-08-30T00:02:00.000Z" });
  const cleanup = record.effects.find((effect) => effect.kind === "cleanup")!;
  assert.throws(() => parseHostLaunchRecord({ ...record, effects: record.effects.map((effect) => effect.kind === "cleanup" ? { ...cleanup, takeovers: [{ ...cleanup.takeovers![0]!, fromOwnerId: "forged" }] } : effect) }), (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_effect");
  record = writer.transitionLaunch({ type: "settle_cleanup_cleaned", launchId: "launch-1", ownerId: "recovery:1", fencingToken: 2, expectedRevision: record.revision, at: "2026-08-30T00:02:01.000Z" });
  assert.equal(record.state, "released"); assert.equal(record.cleanupOwner, "none");
});

test("impossible adoption pair leaves host ownership unchanged", () => {
  const kernel = createInMemoryStreamingSessionStore(); const writer = getStreamingSessionKernelWriter(kernel);
  writer.prepareLaunch(hostRecord());
  writer.transitionLaunch({ type: "bind_isolation", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 0, leaseId: "lease-1", providerId: "fake", providerIdentity: "a".repeat(64), at: now });
  writer.transitionLaunch({ type: "begin_launch", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 1, at: now });
  writer.transitionLaunch({ type: "bind_backend", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 2, backendBinding: backendBinding(), at: now });
  const host = writer.transitionLaunch({ type: "verify_handshake", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 3, handshakeDigest: "b".repeat(64), at: now });
  assert.throws(() => writer.commitAdoption({ launchId: "launch-1", ownerId: host.ownerId, fencingToken: host.fencingToken, expectedRevision: host.revision, at: now, sessionRecord: activeSessionRecord("wrong-session") }), (error) => error instanceof StreamingSessionStoreError && error.code === "identity_conflict");
  assert.equal(kernel.store.readHostLaunch("launch-1")?.state, "handshake_verified");
  assert.equal(kernel.store.readBySession("wrong-session"), undefined);
});

test("SQLite host journal reopens with HMAC integrity and tamper fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-host-launch-")); const path = join(root, "sessions.sqlite"); const key = Buffer.alloc(32, 4);
  try {
    let kernel = openSqliteStreamingSessionStore(path, key); getStreamingSessionKernelWriter(kernel).prepareLaunch(hostRecord()); kernel.store.close();
    kernel = openSqliteStreamingSessionStore(path, key); assert.equal(kernel.store.readHostLaunch("launch-1")?.state, "prepared"); kernel.store.close();
    const db = new DatabaseSync(path); db.prepare("UPDATE streaming_host_launches SET integrity = ? WHERE launch_id = ?").run("00", "launch-1"); db.close();
    kernel = openSqliteStreamingSessionStore(path, key); assert.throws(() => kernel.store.readHostLaunch("launch-1"), (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_record"); kernel.store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SQLite adoption faults expose only wholly pre- or post-adoption state", async () => {
  for (const point of ["after_session_insert", "after_commit"] as const) {
    const root = await mkdtemp(join(tmpdir(), `runner-v2-adoption-${point}-`)); const path = join(root, "sessions.sqlite"); const key = Buffer.alloc(32, 9);
    let kernel: ReturnType<typeof openSqliteStreamingSessionStore> | undefined;
    try {
      let fired = false;
      kernel = openSqliteStreamingSessionStore(path, key, { adoptionFault: (actual) => { if (!fired && actual === point) { fired = true; throw new Error(`fault:${point}`); } } }); const writer = getStreamingSessionKernelWriter(kernel);
      writer.prepareLaunch(hostRecord()); writer.transitionLaunch({ type: "bind_isolation", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 0, leaseId: "lease-1", providerId: "fake", providerIdentity: "a".repeat(64), at: now }); writer.transitionLaunch({ type: "begin_launch", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 1, at: now }); writer.transitionLaunch({ type: "bind_backend", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 2, backendBinding: backendBinding(), at: now }); const host = writer.transitionLaunch({ type: "verify_handshake", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 3, handshakeDigest: "b".repeat(64), at: now });
      const adoption = { launchId: "launch-1", ownerId: host.ownerId, fencingToken: 1, expectedRevision: host.revision, at: now, sessionRecord: activeSessionRecord("stream-1") };
      assert.throws(() => writer.commitAdoption(adoption), new RegExp(`fault:${point}`));
      assert.equal(kernel.store.readBySession("stream-1") !== undefined, point === "after_commit"); assert.equal(kernel.store.readHostLaunch("launch-1")?.state, point === "after_commit" ? "handed_off" : "handshake_verified");
      if (point === "after_commit") assert.equal(writer.commitAdoption(adoption).launch.state, "handed_off");
    } finally { try { kernel?.store.close(); } catch {} await rm(root, { recursive: true, force: true }); }
  }
});

test("SQLite reopen after every host boundary retains one exact owner and state", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-host-boundaries-")); const path = join(root, "sessions.sqlite"); const key = Buffer.alloc(32, 6);
  let kernel: ReturnType<typeof openSqliteStreamingSessionStore> | undefined;
  try {
    kernel = openSqliteStreamingSessionStore(path, key); getStreamingSessionKernelWriter(kernel).prepareLaunch(hostRecord()); kernel.store.close();
    const commands = [
      { type: "bind_isolation", expectedRevision: 0, leaseId: "lease-1", providerId: "fake", providerIdentity: "a".repeat(64) },
      { type: "begin_launch", expectedRevision: 1 },
      { type: "bind_backend", expectedRevision: 2, backendBinding: backendBinding() },
      { type: "verify_handshake", expectedRevision: 3, handshakeDigest: "b".repeat(64) },
    ];
    for (const command of commands) {
      kernel = openSqliteStreamingSessionStore(path, key); getStreamingSessionKernelWriter(kernel).transitionLaunch({ ...command, launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, at: now }); kernel.store.close();
      kernel = openSqliteStreamingSessionStore(path, key); const record = kernel.store.readHostLaunch("launch-1")!; assert.equal(record.ownerId, "host:run-1"); assert.equal(record.fencingToken, 1); kernel.store.close();
    }
  } finally { try { kernel?.store.close(); } catch {} await rm(root, { recursive: true, force: true }); }
});

function hostRecord() {
  return {
    recordKind: "runner.host-launch" as const, schemaVersion: HOST_LAUNCH_RECORD_VERSION,
    revision: 0, launchId: "launch-1", sessionId: "stream-1", runId: "run-1",
    agentSessionId: "agent-1", actor: { role: "worker" as const, id: "worker-1" },
    toolName: "process.start", callId: "call-1", ownerId: "host:run-1", fencingToken: 1, ownerExpiresAt: "2026-08-30T00:01:00.000Z",
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

function activeSessionRecord(sessionId: string) {
  return { recordKind: "runner.streaming-session", schemaVersion: 3, revision: 1, sessionId, ownerId: "session-owner", fencingToken: 1, leaseExpiresAt: "2026-08-30T00:01:00.000Z", runId: "run-1", agentSessionId: "agent-1", actor: { role: "worker", id: "worker-1" }, toolName: "process.start", callId: "call-1", envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false }, lease: { leaseId: "lease-1", providerId: "fake", invocationId: "invoke-1", providerIdentity: "a".repeat(64), acquiredAt: now, access: [] }, backendBinding: backendBinding(), cleanupCreationAuthority: null, cleanupOwner: "session_authority", state: "active", history: [{ state: "pending_transfer", at: now }, { state: "active", at: now }], effects: [{ effectId: "transfer:g", kind: "transfer", status: "acknowledged", owner: "tool_broker", fencingToken: 1, createdAt: now, acknowledgedAt: now }] };
}
