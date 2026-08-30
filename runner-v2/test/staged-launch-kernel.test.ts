import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
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

test("staged launch capabilities are issuer-scoped and reserve session ids", async () => {
  const grants = createExecutionGrantAuthority({ clock: () => new Date(now) });
  const base = { runId: "run-1", sessionId: "agent-1", actor: { role: "worker" as const, id: "worker-1" }, toolName: "process.start", permissionProfile: "full" as const };
  const firstBinding = { ...base, callId: "call-reserve-1" };
  const secondBinding = { ...base, callId: "call-reserve-2" };
  const first = await grants.issue({ ...firstBinding, workspacePath: process.cwd(), access: [], externalApproved: false, destructiveApproved: false, networkApproved: false });
  const second = await grants.issue({ ...secondBinding, workspacePath: process.cwd(), access: [], externalApproved: false, destructiveApproved: false, networkApproved: false });
  const issuing = createSessionAuthority({ grants, sessions: createInMemoryStreamingSessionStore(), clock: () => new Date(now) });
  const foreign = createSessionAuthority({ grants, sessions: createInMemoryStreamingSessionStore(), clock: () => new Date(now) });
  const staged = issuing.stageLaunch({ sessionId: "stream-reserved", launchId: "launch-reserved-1", grant: first, binding: firstBinding });
  assert.throws(
    () => foreign.validateStagedLaunch(staged, { sessionId: "stream-reserved", launchId: "launch-reserved-1" }),
    (error) => error instanceof SessionAuthorityError && error.code === "launch_call_consumed",
  );
  assert.throws(
    () => issuing.stageLaunch({ sessionId: "stream-reserved", launchId: "launch-reserved-2", grant: second, binding: secondBinding }),
    (error) => error instanceof SessionAuthorityError && error.code === "session_collision",
  );
  assert.throws(
    () => issuing.beginTransfer({ sessionId: "stream-reserved", grant: second, binding: secondBinding, lease: leaseBinding(), backendBinding: backendBinding(), envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false } }),
    (error) => error instanceof SessionAuthorityError && error.code === "session_collision",
  );
});

test("host launch parser rejects impossible history, effects, and binding state", () => {
  const impossible = {
    ...hostRecord(), revision: 1, state: "cleanup_pending" as const,
    history: [{ state: "bound" as const, at: now }, { state: "cleanup_pending" as const, at: now }],
    effects: [{ effectId: "wrong-isolate", kind: "isolate" as const, status: "pending" as const, ownerId: "host:run-1", fencingToken: 99, createdAt: now },
      { effectId: "cleanup:launch-1", kind: "cleanup" as const, status: "pending" as const, ownerId: "host:run-1", fencingToken: 1, originOwnerId: "host:run-1", originFencingToken: 1, createdAt: now, takeovers: [] }],
  };
  assert.throws(
    () => parseHostLaunchRecord(impossible),
    (error) => error instanceof StreamingSessionStoreError && ["invalid_state", "invalid_effect"].includes(error.code),
  );
});

test("host launch effects are fenced, monotonic, idempotent, and capacity bounded", () => {
  const kernel = createInMemoryStreamingSessionStore({ maxHostLaunchRecords: 1 });
  const writer = getStreamingSessionKernelWriter(kernel);
  assert.equal(writer.prepareLaunch(hostRecord()).won, true);
  const isolated = writer.transitionLaunch({
    type: "bind_isolation", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1,
    expectedRevision: 0, lease: leaseBinding(), at: now,
  });
  assert.equal(isolated.state, "isolated");
  assert.deepEqual(writer.transitionLaunch({
    type: "bind_isolation", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1,
    expectedRevision: 0, lease: leaseBinding(), at: now,
  }), isolated);
  assert.throws(() => writer.transitionLaunch({
    type: "begin_launch", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 2,
    expectedRevision: 1, at: now,
  }), (error) => error instanceof StreamingSessionStoreError && error.code === "stale_fence");
  assert.throws(() => writer.prepareLaunch({ ...hostRecord(), launchId: "launch-2", effects: [{ ...hostRecord().effects[0], effectId: "isolate:launch-2" }] }),
    (error) => error instanceof StreamingSessionStoreError && error.code === "capacity_exceeded");
});

test("an expired host owner cannot advance a normal lifecycle effect", () => {
  const kernel = createInMemoryStreamingSessionStore(); const writer = getStreamingSessionKernelWriter(kernel);
  writer.prepareLaunch(hostRecord());
  assert.throws(() => writer.transitionLaunch({ type: "bind_isolation", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 0, lease: leaseBinding(), at: "2026-08-30T00:02:00.000Z" }),
    (error) => error instanceof StreamingSessionStoreError && error.code === "lease_expired");
  assert.equal(kernel.store.readHostLaunch("launch-1")?.state, "prepared");
});

test("in-memory atomic adoption retains host ownership when session capacity is full", () => {
  const kernel = createInMemoryStreamingSessionStore({ maxRecords: 1 }); const writer = getStreamingSessionKernelWriter(kernel);
  writer.claim(activeSessionRecord("existing-session")); writer.prepareLaunch(hostRecord());
  writer.transitionLaunch({ type: "bind_isolation", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 0, lease: leaseBinding(), at: now });
  writer.transitionLaunch({ type: "begin_launch", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 1, at: now });
  writer.transitionLaunch({ type: "bind_backend", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 2, backendBinding: backendBinding(), at: now });
  const host = writer.transitionLaunch({ type: "verify_handshake", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 3, handshakeDigest: "b".repeat(64), at: now });
  assert.throws(() => writer.commitAdoption({ launchId: "launch-1", ownerId: host.ownerId, fencingToken: host.fencingToken, expectedRevision: host.revision, at: now, sessionRecord: activeSessionRecord("stream-1") }),
    (error) => error instanceof StreamingSessionStoreError && error.code === "capacity_exceeded");
  assert.equal(kernel.store.readHostLaunch("launch-1")?.state, "handshake_verified"); assert.equal(kernel.store.readBySession("stream-1"), undefined);
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
  writer.transitionLaunch({ type: "bind_isolation", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 0, lease: leaseBinding(), at: now });
  writer.transitionLaunch({ type: "begin_launch", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 1, at: now });
  writer.transitionLaunch({ type: "bind_backend", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 2, backendBinding: backendBinding(), at: now });
  const verified = writer.transitionLaunch({ type: "verify_handshake", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 3, handshakeDigest: "b".repeat(64), at: now });
  const finalize = { staged, launchId: "launch-1", sessionId: "stream-1", ownerId: verified.ownerId, fencingToken: verified.fencingToken, expectedRevision: verified.revision, lease: { leaseId: "lease-1", providerId: "fake", invocationId: "invoke-1", providerIdentity: "a".repeat(64), acquiredAt: now, access: [] }, backendBinding: backendBinding(), handshakeDigest: "b".repeat(64), envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false } };
  for (const mismatch of [
    { ...finalize, launchId: "wrong-launch" },
    { ...finalize, lease: { ...finalize.lease, leaseId: "wrong-lease" } },
    { ...finalize, lease: { ...finalize.lease, invocationId: "wrong-invocation" } },
    { ...finalize, lease: { ...finalize.lease, acquiredAt: "2026-08-30T00:00:01.000Z" } },
    { ...finalize, backendBinding: { ...finalize.backendBinding, opaqueIdentity: "wrong-backend" } },
    { ...finalize, backendBinding: { ...finalize.backendBinding, implementationGeneration: "wrong-generation" } },
    { ...finalize, backendBinding: { ...finalize.backendBinding, attestationDigest: "e".repeat(64) } },
    { ...finalize, backendBinding: { ...finalize.backendBinding, rootPid: 43 } },
    { ...finalize, backendBinding: { ...finalize.backendBinding, birthFingerprint: { ...finalize.backendBinding.birthFingerprint, discriminator: "wrong-birth" } } },
    { ...finalize, handshakeDigest: "e".repeat(64) },
  ]) assert.throws(() => authority.finalizeLaunch(mismatch), (error) => error instanceof SessionAuthorityError && error.code === "binding_mismatch");
  const result = authority.finalizeLaunch(finalize);
  assert.equal(result.record.state, "active");
  assert.equal(kernel.store.readHostLaunch("launch-1")?.state, "handed_off");
  assert.throws(() => authority.finalizeLaunch({ staged, launchId: "launch-1", sessionId: "stream-1", ownerId: verified.ownerId, fencingToken: verified.fencingToken, expectedRevision: verified.revision, lease: result.record.lease, backendBinding: backendBinding(), handshakeDigest: "b".repeat(64), envelope: result.record.envelope }), (error) => error instanceof SessionAuthorityError && error.code === "launch_call_consumed");
  const operation = { sessionId: "stream-1", operation: "request" as const, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
  const authorization = authority.authorizeLaunchOperation(operation);
  const copiedKernel = createInMemoryStreamingSessionStore(); getStreamingSessionKernelWriter(copiedKernel).claim(result.record);
  const foreign = createSessionAuthority({ grants, sessions: copiedKernel, clock: () => new Date(now) });
  assert.throws(() => foreign.assertOperationAuthorization(authorization, { ...operation, binding }),
    (error) => error instanceof SessionAuthorityError && error.code === "authorization_forged");
});

test("host cleanup is fenced through pending, blocked, expired-owner takeover, and released", () => {
  const kernel = createInMemoryStreamingSessionStore(); const writer = getStreamingSessionKernelWriter(kernel);
  writer.prepareLaunch(hostRecord());
  let record = writer.transitionLaunch({ type: "begin_cleanup", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 0, at: now });
  assert.equal(record.state, "cleanup_pending");
  const blockedFailure = { code: "host_reconciliation_failed", message: "Host reconciliation failed." };
  record = writer.transitionLaunch({ type: "settle_cleanup_blocked", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 1, blocker: blockedFailure, results: [{ resource: "host", identity: "host:launch-1", ownerId: "host:run-1", fencingToken: 1, status: "failed", failure: blockedFailure }], at: now });
  assert.equal(record.state, "cleanup_blocked");
  assert.throws(() => writer.transitionLaunch({ type: "takeover_cleanup", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 2, newOwnerId: "recovery:1", newFencingToken: 2, ownerExpiresAt: "2026-08-30T00:02:00.000Z", at: "2026-08-30T00:00:30.000Z" }), (error) => error instanceof StreamingSessionStoreError && error.code === "lease_not_expired");
  record = writer.transitionLaunch({ type: "takeover_cleanup", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 2, newOwnerId: "recovery:1", newFencingToken: 2, ownerExpiresAt: "2026-08-30T00:03:00.000Z", at: "2026-08-30T00:02:00.000Z" });
  const cleanup = record.effects.find((effect) => effect.kind === "cleanup")!;
  assert.throws(() => parseHostLaunchRecord({ ...record, effects: record.effects.map((effect) => effect.kind === "cleanup" ? { ...cleanup, takeovers: [{ ...cleanup.takeovers![0]!, fromOwnerId: "forged" }] } : effect) }), (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_effect");
  record = writer.transitionLaunch({ type: "settle_cleanup_cleaned", launchId: "launch-1", ownerId: "recovery:1", fencingToken: 2, expectedRevision: record.revision, results: [{ resource: "host", identity: "host:launch-1", ownerId: "recovery:1", fencingToken: 2, status: "succeeded" }], at: "2026-08-30T00:02:01.000Z" });
  assert.equal(record.state, "released"); assert.equal(record.cleanupOwner, "none");
});

test("kernel rejects a channel-only cleanup assertion for a fully bound launch without releasing ownership", () => {
  const kernel = createInMemoryStreamingSessionStore(); const writer = getStreamingSessionKernelWriter(kernel);
  writer.prepareLaunch(hostRecord());
  writer.transitionLaunch({ type: "bind_isolation", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 0, lease: leaseBinding(), at: now });
  writer.transitionLaunch({ type: "begin_launch", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 1, at: now });
  writer.transitionLaunch({ type: "bind_backend", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 2, backendBinding: backendBinding(), at: now });
  writer.transitionLaunch({ type: "begin_channel", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 3, at: now });
  writer.claimHostOutputCheckpoint({ launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 4, at: now, record: { recordKind: "runner.output-checkpoint", schemaVersion: 1, revision: 0, sessionId: "stream-1", ownerId: "session-owner", fencingToken: 1, capacity: 4, outcome: "active", streams: [{ stream: "stdout", lastConsumed: null, consumed: [], accepted: [], consumingIntent: null }] } });
  assert.throws(() => writer.transitionLaunch({
    type: "begin_cleanup", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 5, at: now,
    resources: [{ resource: "channel", identity: "channel:80000af88202cc6a2970b7864ec660ac3ee64291fc00bfd0b912360c62050d39" }],
  }), (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_effect");
  const retained = kernel.store.readHostLaunch("launch-1")!;
  assert.equal(retained.state, "bound"); assert.equal(retained.ownerId, "host:run-1");
  assert.equal(retained.leaseBinding?.leaseId, "lease-1"); assert.equal(retained.backendBinding?.opaqueIdentity, "opaque-1");
});

test("parser refuses an unresolved cleanup fact authenticated only by a historical owner", () => {
  const kernel = createInMemoryStreamingSessionStore(); const writer = getStreamingSessionKernelWriter(kernel);
  writer.prepareLaunch(hostRecord());
  let record = writer.transitionLaunch({ type: "begin_cleanup", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 0, at: now, resources: [{ resource: "host", identity: "host:launch-1" }] });
  record = writer.transitionLaunch({ type: "takeover_cleanup", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: record.revision, newOwnerId: "recovery:2", newFencingToken: 2, ownerExpiresAt: "2026-08-30T00:03:00.000Z", at: "2026-08-30T00:01:00.000Z" });
  const cleanup = record.effects.find((effect) => effect.kind === "cleanup")!;
  const stale = { ...record, effects: record.effects.map((effect) => effect.kind === "cleanup" ? { ...cleanup, resources: cleanup.resources!.map((fact) => ({ ...fact, ownerId: "host:run-1", fencingToken: 1 })) } : effect) };
  assert.throws(() => parseHostLaunchRecord(stale), (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_effect");
});

test("cleanup ledger is exact, fully settled, and re-fences only unresolved duties on consecutive takeover", () => {
  const kernel = createInMemoryStreamingSessionStore(); const writer = getStreamingSessionKernelWriter(kernel);
  writer.prepareLaunch(hostRecord());
  writer.transitionLaunch({ type: "bind_isolation", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 0, lease: leaseBinding(), at: now });
  writer.transitionLaunch({ type: "begin_launch", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 1, at: now });
  writer.transitionLaunch({ type: "bind_backend", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 2, backendBinding: backendBinding(), at: now });
  writer.transitionLaunch({ type: "begin_channel", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 3, at: now });
  writer.claimHostOutputCheckpoint({ launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 4, at: now, record: { recordKind: "runner.output-checkpoint", schemaVersion: 1, revision: 0, sessionId: "stream-1", ownerId: "session-owner", fencingToken: 1, capacity: 4, outcome: "active", streams: [{ stream: "stdout", lastConsumed: null, consumed: [], accepted: [], consumingIntent: null }] } });
  let record = writer.transitionLaunch({ type: "begin_cleanup", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 5, at: now });
  const cleanup = record.effects.find((effect) => effect.kind === "cleanup")!; const facts = cleanup.resources!;
  assert.deepEqual(facts.map(({ resource, identity }) => ({ resource, identity })), [
    { resource: "host", identity: "host:launch-1" },
    { resource: "isolation_lease", identity: "lease:6e57ee9e9a077eef678d07fb49152ba73eb24dab6546330f3a297271a9121d83" },
    { resource: "channel", identity: "channel:80000af88202cc6a2970b7864ec660ac3ee64291fc00bfd0b912360c62050d39" },
    { resource: "output_checkpoint", identity: "checkpoint:stream-1" },
  ]);
  const malformed = [
    facts.slice(1),
    [...facts, { ...facts[0]!, resource: "not_a_resource" }],
    [...facts.slice(0, 3), { ...facts[0]! }],
    facts.map((fact, index) => index === 0 ? { ...fact, resource: "not_a_resource" } : fact),
    facts.map((fact, index) => index === 0 ? { ...fact, identity: "host:wrong" } : fact),
    facts.map((fact, index) => index === 0 ? { ...fact, ownerId: "wrong-owner" } : fact),
    facts.map((fact, index) => index === 0 ? { ...fact, fencingToken: 99 } : fact),
  ];
  for (const resources of malformed) assert.throws(() => parseHostLaunchRecord({ ...record, effects: record.effects.map((effect) => effect.kind === "cleanup" ? { ...effect, resources } : effect) }), (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_effect");
  const failure = { code: "host_reconciliation_failed", message: "Host reconciliation failed." };
  const firstResults = facts.map((fact) => ({ resource: fact.resource, identity: fact.identity, ownerId: fact.ownerId, fencingToken: fact.fencingToken, status: fact.resource === "host" ? "failed" : "succeeded", ...(fact.resource === "host" ? { failure } : {}) }));
  record = writer.transitionLaunch({ type: "settle_cleanup_blocked", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: record.revision, blocker: failure, results: firstResults, at: now });
  record = writer.transitionLaunch({ type: "takeover_cleanup", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: record.revision, newOwnerId: "recovery:2", newFencingToken: 2, ownerExpiresAt: "2026-08-30T00:03:00.000Z", at: "2026-08-30T00:01:00.000Z" });
  let takeoverFacts = record.effects.find((effect) => effect.kind === "cleanup")!.resources!;
  assert.deepEqual(takeoverFacts.map((fact) => [fact.resource, fact.status, fact.ownerId, fact.fencingToken]), [
    ["host", "pending", "recovery:2", 2], ["isolation_lease", "succeeded", "host:run-1", 1],
    ["channel", "succeeded", "host:run-1", 1], ["output_checkpoint", "succeeded", "host:run-1", 1],
  ]);
  record = writer.transitionLaunch({ type: "takeover_cleanup", launchId: "launch-1", ownerId: "recovery:2", fencingToken: 2, expectedRevision: record.revision, newOwnerId: "recovery:3", newFencingToken: 3, ownerExpiresAt: "2026-08-30T00:04:00.000Z", at: "2026-08-30T00:03:00.000Z" });
  takeoverFacts = record.effects.find((effect) => effect.kind === "cleanup")!.resources!;
  assert.equal(takeoverFacts[0]?.ownerId, "recovery:3"); assert.equal(takeoverFacts[0]?.fencingToken, 3);
  const current = takeoverFacts[0]!;
  assert.throws(() => writer.transitionLaunch({ type: "settle_cleanup_cleaned", launchId: "launch-1", ownerId: "recovery:3", fencingToken: 3, expectedRevision: record.revision, results: [{ resource: current.resource, identity: current.identity, ownerId: "recovery:2", fencingToken: 2, status: "succeeded" }], at: "2026-08-30T00:03:01.000Z" }), (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_effect");
  record = writer.transitionLaunch({ type: "settle_cleanup_cleaned", launchId: "launch-1", ownerId: "recovery:3", fencingToken: 3, expectedRevision: record.revision, results: [{ resource: current.resource, identity: current.identity, ownerId: "recovery:3", fencingToken: 3, status: "succeeded" }], at: "2026-08-30T00:03:01.000Z" });
  assert.equal(record.state, "released"); assert.ok(record.effects.find((effect) => effect.kind === "cleanup")!.resources!.every((fact) => fact.status === "succeeded"));
});

test("cleanup failure parser accepts only the closed code-to-message schema", () => {
  const kernel = createInMemoryStreamingSessionStore(); const writer = getStreamingSessionKernelWriter(kernel); writer.prepareLaunch(hostRecord());
  let record = writer.transitionLaunch({ type: "begin_cleanup", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 0, at: now });
  const failure = { code: "host_reconciliation_failed", message: "Host reconciliation failed." };
  record = writer.transitionLaunch({ type: "settle_cleanup_blocked", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: record.revision, blocker: failure, results: [{ resource: "host", identity: "host:launch-1", ownerId: "host:run-1", fencingToken: 1, status: "failed", failure }], at: now });
  const cleanup = record.effects.find((effect) => effect.kind === "cleanup")!;
  for (const invalidFailure of [
    { code: "unknown_code", message: "Internal cleanup failed." },
    { code: "host_reconciliation_failed", message: "provider credential=B1_R6" },
    "legacy arbitrary failure text",
    { code: "host_reconciliation_failed", message: "Host reconciliation failed.", diagnostic: "stack=B1_R6" },
  ]) assert.throws(() => parseHostLaunchRecord({ ...record, effects: record.effects.map((effect) => effect.kind === "cleanup" ? { ...cleanup, blocker: invalidFailure, resources: cleanup.resources!.map((fact) => ({ ...fact, failure: invalidFailure })) } : effect) }), StreamingSessionStoreError);
});

test("impossible adoption pair leaves host ownership unchanged", () => {
  const kernel = createInMemoryStreamingSessionStore(); const writer = getStreamingSessionKernelWriter(kernel);
  writer.prepareLaunch(hostRecord());
  writer.transitionLaunch({ type: "bind_isolation", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 0, lease: leaseBinding(), at: now });
  writer.transitionLaunch({ type: "begin_launch", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 1, at: now });
  writer.transitionLaunch({ type: "bind_backend", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 2, backendBinding: backendBinding(), at: now });
  const host = writer.transitionLaunch({ type: "verify_handshake", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 3, handshakeDigest: "b".repeat(64), at: now });
  assert.throws(() => writer.commitAdoption({ launchId: "launch-1", ownerId: host.ownerId, fencingToken: host.fencingToken, expectedRevision: host.revision, at: now, sessionRecord: activeSessionRecord("wrong-session") }), (error) => error instanceof StreamingSessionStoreError && error.code === "identity_conflict");
  assert.equal(kernel.store.readHostLaunch("launch-1")?.state, "handshake_verified");
  assert.equal(kernel.store.readBySession("wrong-session"), undefined);
});

test("expired pending cleanup supports consecutive fenced takeovers without lifecycle revival", () => {
  const kernel = createInMemoryStreamingSessionStore(); const writer = getStreamingSessionKernelWriter(kernel);
  writer.prepareLaunch(hostRecord());
  let record = writer.transitionLaunch({ type: "begin_cleanup", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 0, at: now });
  for (let fence = 2; fence <= 3; fence++) {
    record = writer.transitionLaunch({ type: "takeover_cleanup", launchId: "launch-1", ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, newOwnerId: `recovery:${fence}`, newFencingToken: fence, ownerExpiresAt: `2026-08-30T00:0${fence + 1}:00.000Z`, at: `2026-08-30T00:0${fence}:00.000Z` });
    assert.equal(record.state, "cleanup_pending"); assert.equal(record.fencingToken, fence);
  }
  assert.equal(record.effects.find((effect) => effect.kind === "cleanup")!.takeovers!.length, 2);
});

test("adopted takeover atomically re-fences the exact output checkpoint", () => {
  const kernel = createInMemoryStreamingSessionStore(); const writer = getStreamingSessionKernelWriter(kernel);
  writer.claim(activeSessionRecord("stream-1"));
  writer.claimOutputCheckpoint({ recordKind: "runner.output-checkpoint", schemaVersion: 1, revision: 0, sessionId: "stream-1", ownerId: "session-owner", fencingToken: 1, capacity: 4, outcome: "active", streams: [{ stream: "stdout", lastConsumed: null, consumed: [], accepted: [], consumingIntent: null }] });
  const taken = writer.takeoverAdoptedWithOutput({ sessionId: "stream-1", ownerId: "session-owner", fencingToken: 1, expectedRevision: 1, outputExpectedRevision: 0, newOwnerId: "recovery-owner", newFencingToken: 2, leaseExpiresAt: "2026-08-30T00:03:00.000Z", at: "2026-08-30T00:02:00.000Z" });
  assert.equal(taken.session.fencingToken, 2); assert.equal(taken.output.fencingToken, 2); assert.equal(taken.output.ownerId, "recovery-owner");
  assert.throws(() => writer.applyOutputCheckpoint({ type: "mark_outcome_unknown", sessionId: "stream-1", ownerId: "session-owner", fencingToken: 1, expectedRevision: 1, metadata: { stream: "stdout", sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1, digest: "a".repeat(64) } }), (error) => error instanceof StreamingSessionStoreError && error.code === "stale_fence");
});

test("SQLite adopted takeover commits both fences or rolls back both", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-adopted-takeover-")); const path = join(root, "sessions.sqlite");
  let kernel = openSqliteStreamingSessionStore(path, Buffer.alloc(32, 5));
  try {
    let writer = getStreamingSessionKernelWriter(kernel); writer.claim(activeSessionRecord("stream-1"));
    writer.claimOutputCheckpoint({ recordKind: "runner.output-checkpoint", schemaVersion: 1, revision: 0, sessionId: "stream-1", ownerId: "session-owner", fencingToken: 1, capacity: 4, outcome: "active", streams: [{ stream: "stdout", lastConsumed: null, consumed: [], accepted: [], consumingIntent: null }] });
    const command = { sessionId: "stream-1", ownerId: "session-owner", fencingToken: 1, expectedRevision: 1, outputExpectedRevision: 0, newOwnerId: "recovery-owner", newFencingToken: 2, leaseExpiresAt: "2026-08-30T00:03:00.000Z", at: "2026-08-30T00:02:00.000Z" };
    assert.throws(() => writer.takeoverAdoptedWithOutput({ ...command, outputExpectedRevision: 99 }), /revision/i);
    assert.equal(kernel.store.readBySession("stream-1")?.fencingToken, 1); assert.equal(kernel.store.readOutputCheckpoint("stream-1")?.fencingToken, 1);
    writer.takeoverAdoptedWithOutput(command); kernel.store.close();
    kernel = openSqliteStreamingSessionStore(path, Buffer.alloc(32, 5)); writer = getStreamingSessionKernelWriter(kernel);
    assert.equal(kernel.store.readBySession("stream-1")?.fencingToken, 2); assert.equal(kernel.store.readOutputCheckpoint("stream-1")?.fencingToken, 2); void writer;
  } finally { try { kernel.store.close(); } catch {} await rm(root, { recursive: true, force: true }); }
});

test("SQLite host journal reopens with HMAC integrity and tamper fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-host-launch-")); const path = join(root, "sessions.sqlite"); const key = Buffer.alloc(32, 4);
  try {
    let kernel = openSqliteStreamingSessionStore(path, key); getStreamingSessionKernelWriter(kernel).prepareLaunch(hostRecord()); kernel.store.close();
    kernel = openSqliteStreamingSessionStore(path, key); assert.equal(kernel.store.readHostLaunch("launch-1")?.state, "prepared"); kernel.store.close();
    kernel = openSqliteStreamingSessionStore(path, key, { readOnly: true });
    assert.throws(() => getStreamingSessionKernelWriter(kernel).prepareLaunch({ ...hostRecord(), launchId: "launch-readonly", sessionId: "stream-readonly", effects: [{ ...hostRecord().effects[0], effectId: "isolate:launch-readonly" }] }), /read-only/i);
    assert.throws(() => getStreamingSessionKernelWriter(kernel).transitionLaunch({ type: "bind_isolation", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 0, lease: leaseBinding(), at: now }), /read-only/i); kernel.store.close();
    const db = new DatabaseSync(path); db.prepare("UPDATE streaming_host_launches SET integrity = ? WHERE launch_id = ?").run("00", "launch-1"); db.close();
    kernel = openSqliteStreamingSessionStore(path, key); assert.throws(() => kernel.store.readHostLaunch("launch-1"), (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_record"); kernel.store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SQLite refuses a pre-marker output checkpoint instead of deriving an incomplete cleanup ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-legacy-output-duty-")); const path = join(root, "sessions.sqlite"); const key = Buffer.alloc(32, 19);
  let kernel = openSqliteStreamingSessionStore(path, key); let closed = false;
  try {
    const writer = getStreamingSessionKernelWriter(kernel); writer.prepareLaunch(hostRecord());
    writer.transitionLaunch({ type: "bind_isolation", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 0, lease: leaseBinding(), at: now });
    writer.transitionLaunch({ type: "begin_launch", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 1, at: now });
    writer.transitionLaunch({ type: "bind_backend", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 2, backendBinding: backendBinding(), at: now });
    kernel.store.close(); closed = true;
    const checkpoint = { recordKind: "runner.output-checkpoint", schemaVersion: 1, revision: 0, sessionId: "stream-1", ownerId: "session-owner", fencingToken: 1, capacity: 4, outcome: "active", streams: [{ stream: "stdout", lastConsumed: null, consumed: [], accepted: [], consumingIntent: null }] };
    const json = JSON.stringify(checkpoint); const integrity = createHmac("sha256", key).update(json).digest("hex"); const database = new DatabaseSync(path);
    database.prepare("INSERT INTO streaming_output_checkpoints (session_id, record_json, integrity, revision) VALUES (?, ?, ?, ?)").run("stream-1", json, integrity, 0); database.close();
    kernel = openSqliteStreamingSessionStore(path, key); closed = false;
    assert.throws(() => kernel.store.readHostLaunch("launch-1"), (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_effect");
    assert.throws(() => getStreamingSessionKernelWriter(kernel).transitionLaunch({ type: "begin_cleanup", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 3, at: now }), (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_effect");
    const inspect = new DatabaseSync(path, { readOnly: true }); try { const row = inspect.prepare("SELECT record_json FROM streaming_host_launches WHERE launch_id = ?").get("launch-1") as { record_json: string }; assert.equal(JSON.parse(row.record_json).state, "bound"); } finally { inspect.close(); }
  } finally { if (!closed) try { kernel.store.close(); } catch {} await rm(root, { recursive: true, force: true }); }
});

test("SQLite adoption faults expose only wholly pre- or post-adoption state", async () => {
  for (const point of ["before_session_insert", "after_session_insert", "before_launch_handoff_update", "after_launch_handoff_update", "before_commit", "after_commit"] as const) {
    const root = await mkdtemp(join(tmpdir(), `runner-v2-adoption-${point}-`)); const path = join(root, "sessions.sqlite"); const key = Buffer.alloc(32, 9);
    let kernel: ReturnType<typeof openSqliteStreamingSessionStore> | undefined;
    try {
      let fired = false;
      kernel = openSqliteStreamingSessionStore(path, key, { adoptionFault: (actual) => { if (!fired && actual === point) { fired = true; throw new Error(`fault:${point}`); } } }); const writer = getStreamingSessionKernelWriter(kernel);
      writer.prepareLaunch(hostRecord()); writer.transitionLaunch({ type: "bind_isolation", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 0, lease: leaseBinding(), at: now }); writer.transitionLaunch({ type: "begin_launch", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 1, at: now }); writer.transitionLaunch({ type: "bind_backend", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 2, backendBinding: backendBinding(), at: now }); const host = writer.transitionLaunch({ type: "verify_handshake", launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 3, handshakeDigest: "b".repeat(64), at: now });
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
      { type: "bind_isolation", expectedRevision: 0, lease: leaseBinding() },
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

test("durable SQL tables contain metadata only and reject every payload capability category", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-durable-scan-")); const path = join(root, "sessions.sqlite");
  const kernel = openSqliteStreamingSessionStore(path, Buffer.alloc(32, 3));
  let closed = false;
  try {
    const writer = getStreamingSessionKernelWriter(kernel);
    writer.prepareLaunch(hostRecord()); writer.claim(activeSessionRecord("scan-session"));
    writer.claimOutputCheckpoint({ recordKind: "runner.output-checkpoint", schemaVersion: 1, revision: 0, sessionId: "scan-session", ownerId: "session-owner", fencingToken: 1, capacity: 4, outcome: "active", streams: [{ stream: "stdout", lastConsumed: null, consumed: [], accepted: [], consumingIntent: null }] });
    for (const key of ["grant", "authorization", "command", "argv", "env", "secret", "credentials", "payload", "endpoint", "port", "channel", "writer", "handle", "capability"]) {
      assert.throws(() => writer.prepareLaunch({ ...hostRecord(), [key]: "B1_PRIVATE_SENTINEL" }), StreamingSessionStoreError);
    }
    kernel.store.close(); closed = true; const db = new DatabaseSync(path, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'streaming_%'").all() as Array<{ name: string }>;
      assert.ok(tables.length >= 3);
      const serialized = JSON.stringify(tables.flatMap(({ name }) => { assert.match(name, /^streaming_[a-z_]+$/); return db.prepare(`SELECT * FROM ${name}`).all(); }));
      assert.doesNotMatch(serialized, /B1_PRIVATE_SENTINEL|"(?:argv|command|env|secret|payload|endpoint|port|channel|writer|handle|capability)"/);
    } finally { db.close(); }
  } finally { if (!closed) kernel.store.close(); await rm(root, { recursive: true, force: true }); }
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

function leaseBinding() {
  return { leaseId: "lease-1", providerId: "fake", invocationId: "invoke-1", providerIdentity: "a".repeat(64), acquiredAt: now, access: [] };
}

function activeSessionRecord(sessionId: string) {
  return { recordKind: "runner.streaming-session", schemaVersion: 3, revision: 1, sessionId, ownerId: "session-owner", fencingToken: 1, leaseExpiresAt: "2026-08-30T00:01:00.000Z", runId: "run-1", agentSessionId: "agent-1", actor: { role: "worker", id: "worker-1" }, toolName: "process.start", callId: "call-1", envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false }, lease: { leaseId: "lease-1", providerId: "fake", invocationId: "invoke-1", providerIdentity: "a".repeat(64), acquiredAt: now, access: [] }, backendBinding: backendBinding(), cleanupCreationAuthority: null, cleanupOwner: "session_authority", state: "active", history: [{ state: "pending_transfer", at: now }, { state: "active", at: now }], effects: [{ effectId: "transfer:g", kind: "transfer", status: "acknowledged", owner: "tool_broker", fencingToken: 1, createdAt: now, acknowledgedAt: now }] };
}
