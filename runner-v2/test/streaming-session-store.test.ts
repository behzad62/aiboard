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
  deriveAdoptedCleanupAttemptId,
  digestStreamingSessionRecord,
  getStreamingSessionKernelWriter,
  getStreamingSessionStoreWriter,
  openSqliteStreamingSessionStore,
  parseStreamingSessionRecord,
} from "../src/streaming-session-store.js";

function pendingTransferRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    recordKind: "runner.streaming-session",
    schemaVersion: 3,
    revision: 0,
    sessionId: "stream-1",
    ownerId: "owner-1",
    fencingToken: 1,
    leaseExpiresAt: "2026-08-29T00:05:00.000Z",
    runId: "run-1",
    agentSessionId: "agent-session-1",
    actor: { role: "worker", id: "worker-1" },
    toolName: "process.start",
    callId: "call-1",
    envelope: {
      access: [{ canonicalPath: "C:\\workspace", mode: "write" }],
      credentialNames: ["SERVICE_TOKEN"],
      networkApproved: false,
      externalApproved: false,
      destructiveApproved: false,
    },
    lease: {
      leaseId: "lease-1",
      providerId: "fake-provider",
      invocationId: "invoke-1",
      providerIdentity: "a".repeat(64),
      acquiredAt: "2026-08-29T00:00:00.000Z",
      access: [{ canonicalPath: "C:\\workspace", mode: "write" }],
    },
    backendBinding: {
      registryId: "registry-1",
      backendId: "backend-1",
      implementationGeneration: "generation-1",
      implementationDigest: "b".repeat(64),
      attestationVersion: 1,
      attestationDigest: "c".repeat(64),
      opaqueIdentity: "backend-child-1",
      birthFingerprint: {
        observedAt: "2026-08-29T00:00:00.000Z",
        discriminator: "birth-1",
      },
      startedAt: "2026-08-29T00:00:00.000Z",
    },
    cleanupCreationAuthority: null,
    cleanupOwner: "tool_broker",
    state: "pending_transfer",
    history: [{ state: "pending_transfer", at: "2026-08-29T00:00:00.000Z" }],
    effects: [{
      effectId: "transfer-1",
      kind: "transfer",
      status: "pending",
      owner: "tool_broker",
      fencingToken: 1,
      createdAt: "2026-08-29T00:00:00.000Z",
    }],
    ...overrides,
  };
}

function currentCleanupRecord(): Record<string, unknown> {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  return structuredClone(claimCurrentCleanup(writer)) as unknown as Record<string, unknown>;
}

function verifyCleanupPrefix(writer: ReturnType<typeof getStreamingSessionStoreWriter>, initial: ReturnType<typeof claimCurrentCleanup>, count: number) {
  let record = initial;
  for (const resource of ["workload_quiescence", "retained_output_settlement", "evidence", "channel_detach", "backend_release", "isolation_release"].slice(0, count)) {
    record = writer.apply({ type: "begin_cleanup_resource", sessionId: "stream-1", ownerId: record.ownerId,
      fencingToken: record.fencingToken, expectedRevision: record.revision, effectId: "cleanup-1", resource,
      startedAt: "2026-08-29T00:00:02.000Z", deadlineAt: "2026-08-29T00:00:30.000Z", at: "2026-08-29T00:00:02.000Z" });
    const attempt = record.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources.find((fact) => fact.resource === resource)!.attempt!;
    record = writer.apply({ type: "settle_cleanup_resource", sessionId: "stream-1", ownerId: record.ownerId,
      fencingToken: record.fencingToken, expectedRevision: record.revision, effectId: "cleanup-1", resource,
      attemptId: attempt.attemptId, attemptOwnerId: attempt.ownerId, attemptFencingToken: attempt.fencingToken,
      result: "verified", ...(resource === "evidence" ? { evidence: {
        kind: "same_runtime_finalization", digest: "e".repeat(64), lossy: false,
      } } : {}), at: "2026-08-29T00:00:02.000Z" });
  }
  return record;
}

test("round4 resource intent cannot pass an unresolved predecessor", () => {
  for (let index = 1; index < 6; index++) {
    const kernel = createInMemoryStreamingSessionStore();
    const writer = getStreamingSessionStoreWriter(kernel);
    const record = verifyCleanupPrefix(writer, claimCurrentCleanup(writer), index - 1);
    const resource = ["workload_quiescence", "retained_output_settlement", "evidence", "channel_detach", "backend_release", "isolation_release"][index]!;
    assert.throws(() => writer.apply({ type: "begin_cleanup_resource", sessionId: "stream-1", ownerId: "owner-1",
      fencingToken: 1, expectedRevision: record.revision, effectId: "cleanup-1", resource,
      startedAt: "2026-08-29T00:00:03.000Z", deadlineAt: "2026-08-29T00:00:30.000Z", at: "2026-08-29T00:00:03.000Z" }),
    (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_effect", resource);
    assert.equal(kernel.store.readBySession("stream-1")!.revision, record.revision);
  }
});

test("round4 pending deadline blocker proves no new effect and remains exactly retryable", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  let record = claimCurrentCleanup(writer);
  const command = { type: "expire_cleanup_resource", sessionId: "stream-1", ownerId: "owner-1", fencingToken: 1,
    expectedRevision: record.revision, effectId: "cleanup-1", resource: "workload_quiescence",
    deadlineAt: "2026-08-29T00:00:03.000Z", at: "2026-08-29T00:00:03.000Z" };
  record = writer.apply(command);
  const fact = record.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[0]!;
  assert.equal(record.state, "cleanup_blocked");
  assert.equal(fact.blocker?.code, "cleanup_deadline_before_effect");
  assert.equal(fact.attempts, 0);
  assert.equal(fact.attempt, undefined);
  assert.throws(() => writer.apply({ ...command, type: "retry_cleanup", expectedRevision: record.revision }));
  const retried = writer.apply({ ...command, type: "retry_cleanup_resource", expectedRevision: record.revision });
  assert.equal(retried.state, "cleanup_pending");
  assert.equal(retried.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[0]!.attempts, 0);
});

test("round4 an exhausted outer deadline may predate cleanup creation without authorizing an effect", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  const record = claimCurrentCleanup(writer);
  const expired = writer.apply({ type: "expire_cleanup_resource", sessionId: "stream-1", ownerId: "owner-1", fencingToken: 1,
    expectedRevision: record.revision, effectId: "cleanup-1", resource: "workload_quiescence",
    deadlineAt: "2026-08-29T00:00:01.000Z", at: "2026-08-29T00:00:03.000Z" });
  assert.equal(expired.state, "cleanup_blocked");
  assert.equal(expired.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[0]!.attempts, 0);
});

test("round4 pending expiry validates chronology ownership revision identity and first unresolved resource", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  const record = claimCurrentCleanup(writer);
  const command = { type: "expire_cleanup_resource", sessionId: "stream-1", ownerId: "owner-1", fencingToken: 1,
    expectedRevision: record.revision, effectId: "cleanup-1", resource: "workload_quiescence",
    deadlineAt: "2026-08-29T00:00:03.000Z", at: "2026-08-29T00:00:03.000Z" };
  for (const mutation of [{ at: "2026-08-29T00:00:02.999Z" }, { at: "2026-08-29T00:05:00.000Z" },
    { at: "2026-08-29T00:00:01.000Z", deadlineAt: "2026-08-29T00:00:00.000Z" },
    { ownerId: "stale" }, { fencingToken: 2 }, { expectedRevision: record.revision + 1 },
    { effectId: "foreign" }, { resource: "retained_output_settlement" }]) {
    assert.throws(() => writer.apply({ ...command, ...mutation }), StreamingSessionStoreError);
    assert.equal(kernel.store.readBySession("stream-1")!.revision, record.revision);
  }
  const issued = writer.apply({ ...command, type: "begin_cleanup_resource", startedAt: command.at,
    deadlineAt: "2026-08-29T00:00:30.000Z" });
  assert.throws(() => writer.apply({ ...command, expectedRevision: issued.revision }), StreamingSessionStoreError);
  const attempt = issued.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[0]!.attempt!;
  assert.throws(() => writer.apply({ ...command, type: "settle_cleanup_resource", expectedRevision: issued.revision,
    attemptId: attempt.attemptId, attemptOwnerId: attempt.ownerId, attemptFencingToken: attempt.fencingToken,
    result: "blocked", blocker: { code: "cleanup_deadline_before_effect", message: "Cleanup deadline expired before effect issuance." } }), StreamingSessionStoreError);
});

test("round4 pending expiry parser rejects forged disposition attempt and prerequisite shapes", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  const initial = verifyCleanupPrefix(writer, claimCurrentCleanup(writer), 1);
  const expired = writer.apply({ type: "expire_cleanup_resource", sessionId: "stream-1", ownerId: "owner-1", fencingToken: 1,
    expectedRevision: initial.revision, effectId: "cleanup-1", resource: "retained_output_settlement",
    deadlineAt: "2026-08-29T00:00:03.000Z", at: "2026-08-29T00:00:03.000Z" });
  const valid = structuredClone(expired) as unknown as Record<string, unknown>;
  const resources = cleanupResources(valid);
  const attempt = { attemptId: deriveAdoptedCleanupAttemptId({ effectId: "cleanup-1", resource: "retained_output_settlement",
    ownerId: "owner-1", fencingToken: 1, ordinal: 1 }), ownerId: "owner-1", fencingToken: 1,
    startedAt: "2026-08-29T00:00:03.000Z", deadlineAt: "2026-08-29T00:00:30.000Z" };
  for (const [label, changed] of [
    ["new blocker with attempt", resources.map((fact, index) => index === 1 ? { ...fact, attempts: 1, attempt } : fact)],
    ["old blocker without attempt", resources.map((fact, index) => index === 1 ? { ...fact, attempts: 1,
      blocker: { code: "cleanup_deadline_expired", message: "Cleanup deadline expired." } } : fact)],
    ["unverified predecessor", resources.map((fact, index) => index === 0 ? { ...fact, status: "pending", attempts: 0, verifiedAt: undefined } : fact)],
  ] as const) assert.throws(() => parseStreamingSessionRecord(withCleanupResources(valid, changed)), StreamingSessionStoreError, label);
  const pending = structuredClone(valid);
  pending.state = "cleanup_pending";
  pending.history = (pending.history as unknown[]).slice(0, -1);
  const cleanup = (pending.effects as Array<Record<string, unknown>>).find((effect) => effect.kind === "cleanup")!;
  cleanup.status = "pending";
  delete cleanup.blockedAt;
  assert.throws(() => parseStreamingSessionRecord(pending), StreamingSessionStoreError);
});

test("round4 SQLite reopen retains each first-unissued blocker and refuses release for all six resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-unissued-expiry-"));
  const key = new Uint8Array(32).fill(26);
  let kernel: ReturnType<typeof openSqliteStreamingSessionStore> | undefined;
  try {
    for (let index = 0; index < 6; index++) {
      const path = join(root, `sessions-${index}.sqlite`);
      kernel = openSqliteStreamingSessionStore(path, key);
      const writer = getStreamingSessionStoreWriter(kernel);
      const initial = verifyCleanupPrefix(writer, claimCurrentCleanup(writer), index);
      const resource = initial.effects.find((effect) => effect.kind === "cleanup")!.progress!.resources[index]!.resource;
      const expired = writer.apply({ type: "expire_cleanup_resource", sessionId: "stream-1", ownerId: "owner-1", fencingToken: 1,
        expectedRevision: initial.revision, effectId: "cleanup-1", resource,
        deadlineAt: "2026-08-29T00:00:03.000Z", at: "2026-08-29T00:00:03.000Z" });
      kernel.store.close();
      kernel = openSqliteStreamingSessionStore(path, key);
      assert.deepEqual(kernel.store.readBySession("stream-1"), expired);
      assert.throws(() => getStreamingSessionStoreWriter(kernel!).apply({ type: "acknowledge_cleanup", sessionId: "stream-1",
        ownerId: "owner-1", fencingToken: 1, expectedRevision: expired.revision, effectId: "cleanup-1", at: "2026-08-29T00:00:04.000Z" }),
      StreamingSessionStoreError, `${resource} blocks final release`);
      kernel.store.close();
      kernel = undefined;
    }
  } finally {
    kernel?.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

function claimCurrentCleanup(writer: ReturnType<typeof getStreamingSessionStoreWriter>) {
  const pending = writer.claim(pendingTransferRecord()).record;
  const active = writer.apply({
    type: "acknowledge_transfer", sessionId: "stream-1", expectedRevision: pending.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:01.000Z", effectId: "transfer-1",
  });
  return writer.apply({
    type: "begin_cleanup", sessionId: "stream-1", expectedRevision: active.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:02.000Z", effectId: "cleanup-1",
  });
}

function blockedChannelCleanup(
  code: "cleanup_deadline_expired" | "cleanup_effect_outcome_unknown" | "channel_detach_failed",
  message: "Cleanup deadline expired." | "Cleanup effect outcome is unknown." | "Streaming channel detach failed.",
) {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  let record = verifyCleanupPrefix(writer, claimCurrentCleanup(writer), 3);
  record = writer.apply({
    type: "begin_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "channel_detach",
    startedAt: "2026-08-29T00:00:03.000Z",
    deadlineAt: "2026-08-29T00:00:30.000Z", at: "2026-08-29T00:00:03.000Z",
  });
  const attemptId = cleanupResources(record as unknown as Record<string, unknown>)[3]!.attempt as { attemptId: string };
  record = writer.apply({
    type: "settle_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "channel_detach",
    attemptId: attemptId.attemptId, attemptOwnerId: "owner-1", attemptFencingToken: 1,
    result: "blocked", blocker: { code, message }, at: "2026-08-29T00:00:04.000Z",
  });
  return { writer, record, attemptId: attemptId.attemptId };
}

function verifyAndReleaseCurrentCleanup(
  writer: ReturnType<typeof getStreamingSessionStoreWriter>,
  initial: ReturnType<ReturnType<typeof getStreamingSessionStoreWriter>["apply"]>,
) {
  let record = initial;
  const resources = cleanupResources(record as unknown as Record<string, unknown>)
    .map((fact) => fact.resource as string);
  for (const [index, resource] of resources.entries()) {
    const startedAt = new Date(Date.parse("2026-08-29T00:00:03.000Z") + index * 2_000).toISOString();
    record = writer.apply({
      type: "begin_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
      ownerId: record.ownerId, fencingToken: record.fencingToken, effectId: "cleanup-1", resource,
      startedAt, deadlineAt: "2026-08-29T00:00:30.000Z", at: startedAt,
    });
    const attempt = cleanupResources(record as unknown as Record<string, unknown>)[index]!.attempt as { attemptId: string };
    record = writer.apply({
      type: "settle_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
      ownerId: record.ownerId, fencingToken: record.fencingToken, effectId: "cleanup-1", resource,
      attemptId: attempt.attemptId, attemptOwnerId: record.ownerId, attemptFencingToken: record.fencingToken,
      result: "verified", at: new Date(Date.parse(startedAt) + 1_000).toISOString(),
      ...(resource === "evidence" ? { evidence: {
        kind: "bounded_output_manifest", digest: "e".repeat(64), lossy: false,
      } } : {}),
    });
  }
  return writer.apply({
    type: "acknowledge_cleanup", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: record.ownerId, fencingToken: record.fencingToken,
    at: "2026-08-29T00:00:20.000Z", effectId: "cleanup-1",
  });
}

function cleanupResources(record: Record<string, unknown>): Array<Record<string, unknown>> {
  const effects = record.effects as Array<Record<string, unknown>>;
  const cleanup = effects.find((effect) => effect.kind === "cleanup")!;
  return structuredClone((cleanup.progress as { resources: Array<Record<string, unknown>> }).resources);
}

function withCleanupResources(
  record: Record<string, unknown>,
  resources: Array<Record<string, unknown> | undefined>,
): Record<string, unknown> {
  return {
    ...record,
    effects: (record.effects as Array<Record<string, unknown>>).map((effect) => effect.kind === "cleanup"
      ? { ...effect, progress: { resources } }
      : effect),
  };
}

function writeSignedStreamingSessionRow(
  path: string,
  integrityKey: Uint8Array,
  record: Record<string, unknown>,
): Readonly<{ record_json: string; integrity: string; revision: number }> {
  const recordJson = JSON.stringify(record);
  const integrity = createHmac("sha256", integrityKey).update(recordJson).digest("hex");
  const revision = record.revision as number;
  const database = new DatabaseSync(path);
  database.exec(
    "CREATE TABLE streaming_sessions (" +
    "session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, integrity TEXT NOT NULL, revision INTEGER NOT NULL)",
  );
  database.prepare(
    "INSERT INTO streaming_sessions (session_id, record_json, integrity, revision) VALUES (?, ?, ?, ?)",
  ).run(record.sessionId as string, recordJson, integrity, revision);
  database.close();
  return Object.freeze({ record_json: recordJson, integrity, revision });
}

function readSignedStreamingSessionRow(
  path: string,
): Readonly<{ record_json: string; integrity: string; revision: number }> {
  const database = new DatabaseSync(path, { readOnly: true });
  const row = database.prepare(
    "SELECT record_json, integrity, revision FROM streaming_sessions WHERE session_id = ?",
  ).get("stream-1") as { record_json: string; integrity: string; revision: number };
  database.close();
  return Object.freeze({
    record_json: row.record_json,
    integrity: row.integrity,
    revision: row.revision,
  });
}

test("rejects unknown fields on a durable pending-transfer session record", () => {
  assert.throws(
    () => parseStreamingSessionRecord({ ...pendingTransferRecord(), unknown: true }),
    (error) => error instanceof StreamingSessionStoreError && error.code === "unknown_field",
  );
});

test("rejects a pending-transfer record without its exact pending transfer effect", () => {
  assert.throws(
    () => parseStreamingSessionRecord(pendingTransferRecord({ effects: [] })),
    (error) => error instanceof StreamingSessionStoreError &&
      (error.code === "invalid_state" || error.code === "invalid_effect"),
  );
});

test("rejects forged transfer and cleanup effect owner or fence evidence", () => {
  assert.throws(
    () => parseStreamingSessionRecord(pendingTransferRecord({
      effects: [{
        effectId: "transfer-1", kind: "transfer", status: "pending", owner: "session_authority",
        fencingToken: 99, createdAt: "2026-08-29T00:00:00.000Z",
      }],
    })),
    (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_state",
  );

  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  const pending = writer.claim(pendingTransferRecord()).record;
  const active = writer.apply({
    type: "acknowledge_transfer", sessionId: "stream-1", expectedRevision: pending.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:01.000Z", effectId: "transfer-1",
  });
  const cleaning = writer.apply({
    type: "begin_cleanup", sessionId: "stream-1", expectedRevision: active.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:02.000Z", effectId: "cleanup-1",
  });
  assert.throws(
    () => parseStreamingSessionRecord({
      ...cleaning,
      effects: cleaning.effects.map((effect) => effect.kind === "cleanup"
        ? { ...effect, owner: "provider_lease", fencingToken: 99 }
        : effect),
    }),
    (error) => error instanceof StreamingSessionStoreError &&
      (error.code === "invalid_state" || error.code === "invalid_effect"),
  );
  const released = verifyAndReleaseCurrentCleanup(writer, cleaning);
  for (const owner of ["tool_broker", "provider_lease"] as const) {
    assert.throws(
      () => parseStreamingSessionRecord({
        ...released,
        effects: released.effects.map((effect) => effect.kind === "cleanup"
          ? { ...effect, owner }
          : effect),
      }),
      (error) => error instanceof StreamingSessionStoreError &&
        (error.code === "invalid_state" || error.code === "invalid_effect"),
    );
  }

  const providerKernel = createInMemoryStreamingSessionStore();
  const providerWriter = getStreamingSessionStoreWriter(providerKernel);
  const providerPending = providerWriter.claim(pendingTransferRecord()).record;
  const providerAmbiguous = providerWriter.apply({
    type: "mark_transfer_ambiguous", sessionId: "stream-1", expectedRevision: providerPending.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:01.000Z", effectId: "transfer-1",
  });
  const providerAcknowledged = providerWriter.apply({
    type: "acknowledge_ambiguous_transfer", sessionId: "stream-1", expectedRevision: providerAmbiguous.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:02.000Z", effectId: "transfer-1",
  });
  const providerCleaning = providerWriter.apply({
    type: "begin_cleanup", sessionId: "stream-1", expectedRevision: providerAcknowledged.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:03.000Z", effectId: "cleanup-1",
  });
  const providerReleased = providerWriter.apply({
    type: "acknowledge_cleanup", sessionId: "stream-1", expectedRevision: providerCleaning.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:04.000Z", effectId: "cleanup-1",
  });
  assert.equal(providerReleased.state, "released");
});

test("returns an immutable deep clone instead of retaining caller-owned durable data", () => {
  const source = pendingTransferRecord();
  const parsed = parseStreamingSessionRecord(source);
  (source.actor as { id: string }).id = "forged-worker";
  assert.equal((parsed.actor as { id: string }).id, "worker-1");
  assert.throws(
    () => { (parsed.envelope as { networkApproved: boolean }).networkApproved = true; },
    TypeError,
  );
});

test("refuses an unsupported active streaming-session schema", () => {
  assert.throws(
    () => parseStreamingSessionRecord(pendingTransferRecord({ schemaVersion: 5 })),
    (error) => error instanceof StreamingSessionStoreError && error.code === "unsupported_active_version",
  );
});

test("begins adopted cleanup with six derived pending version-4 resource facts and reopens them", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-adopted-cleanup-v4-"));
  const path = join(root, "sessions.sqlite");
  const key = new Uint8Array(32).fill(12);
  let kernel: ReturnType<typeof openSqliteStreamingSessionStore> | undefined;
  try {
    kernel = openSqliteStreamingSessionStore(path, key);
    const writer = getStreamingSessionStoreWriter(kernel);
    const pending = writer.claim(pendingTransferRecord()).record;
    const active = writer.apply({
      type: "acknowledge_transfer", sessionId: "stream-1", expectedRevision: pending.revision,
      ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:01.000Z", effectId: "transfer-1",
    });
    const cleaning = writer.apply({
      type: "begin_cleanup", sessionId: "stream-1", expectedRevision: active.revision,
      ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:02.000Z", effectId: "cleanup-1",
    });
    const resources = cleaning.effects.find((effect) => effect.kind === "cleanup")?.progress?.resources;
    assert.equal(cleaning.schemaVersion, 4);
    assert.deepEqual(resources?.map(({ resource, status, ownerId, fencingToken, attempts }) => ({
      resource, status, ownerId, fencingToken, attempts,
    })), [
      { resource: "workload_quiescence", status: "pending", ownerId: "owner-1", fencingToken: 1, attempts: 0 },
      { resource: "retained_output_settlement", status: "pending", ownerId: "owner-1", fencingToken: 1, attempts: 0 },
      { resource: "evidence", status: "pending", ownerId: "owner-1", fencingToken: 1, attempts: 0 },
      { resource: "channel_detach", status: "pending", ownerId: "owner-1", fencingToken: 1, attempts: 0 },
      { resource: "backend_release", status: "pending", ownerId: "owner-1", fencingToken: 1, attempts: 0 },
      { resource: "isolation_release", status: "pending", ownerId: "owner-1", fencingToken: 1, attempts: 0 },
    ]);
    assert.deepEqual(resources?.map(({ resource, identity }) => ({ resource, identity })), [
      { resource: "workload_quiescence", identity: "workload:backend-child-1" },
      { resource: "retained_output_settlement", identity: "output:stream-1:backend-child-1" },
      { resource: "evidence", identity: "evidence:stream-1" },
      { resource: "channel_detach", identity: "channel:stream-1:backend-child-1" },
      { resource: "backend_release", identity: "backend:registry-1:backend-1:backend-child-1" },
      { resource: "isolation_release", identity: `isolation:fake-provider:lease-1:invoke-1:${"a".repeat(64)}` },
    ]);
    kernel.store.close();
    kernel = openSqliteStreamingSessionStore(path, key);
    assert.deepEqual(
      kernel.store.readBySession("stream-1")?.effects.find((effect) => effect.kind === "cleanup")?.progress?.resources,
      resources,
    );
  } finally {
    try { kernel?.store.close(); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed version-4 cleanup sets, identities, and forbidden evidence payloads", () => {
  const valid = currentCleanupRecord();
  const resources = cleanupResources(valid);
  const variants = [
    withCleanupResources(valid, resources.slice(0, -1)),
    withCleanupResources(valid, [...resources, resources[0]]),
    withCleanupResources(valid, [resources[0], resources[0], ...resources.slice(2)]),
    withCleanupResources(valid, resources.map((resource, index) => index === 0
      ? { ...resource, identity: "workload:foreign-backend" }
      : resource)),
    {
      ...valid,
      backendBinding: { ...(valid.backendBinding as Record<string, unknown>), opaqueIdentity: "other-backend" },
    },
  ];
  for (const variant of variants) {
    assert.throws(
      () => parseStreamingSessionRecord(variant),
      (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_effect",
    );
  }

  const forbiddenEvidence = withCleanupResources(valid, resources.map((resource, index) => index === 2
    ? {
      ...resource,
      status: "verified",
      attempts: 1,
      verifiedAt: "2026-08-29T00:00:03.000Z",
      evidence: {
        kind: "bounded_output_manifest",
        digest: "d".repeat(64),
        lossy: false,
        payload: "credential=never-durable",
      },
    }
    : resource));
  assert.throws(
    () => parseStreamingSessionRecord(forbiddenEvidence),
    (error) => error instanceof StreamingSessionStoreError && error.code === "forbidden_durable_value",
  );
});

test("SQLite rejects invalid MAC and valid-MAC malformed version-4 cleanup rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-adopted-cleanup-integrity-"));
  const key = new Uint8Array(32).fill(13);
  try {
    const invalidMacPath = join(root, "invalid-mac.sqlite");
    writeSignedStreamingSessionRow(invalidMacPath, key, currentCleanupRecord());
    const tamper = new DatabaseSync(invalidMacPath);
    tamper.prepare("UPDATE streaming_sessions SET integrity = ? WHERE session_id = ?").run("00".repeat(32), "stream-1");
    tamper.close();
    const invalidMac = openSqliteStreamingSessionStore(invalidMacPath, key);
    assert.throws(
      () => invalidMac.store.readBySession("stream-1"),
      (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_record",
    );
    invalidMac.store.close();

    const malformedPath = join(root, "valid-mac-malformed.sqlite");
    const valid = currentCleanupRecord();
    const resources = cleanupResources(valid);
    writeSignedStreamingSessionRow(
      malformedPath,
      key,
      withCleanupResources(valid, [resources[0], resources[0], ...resources.slice(2)]),
    );
    const malformed = openSqliteStreamingSessionStore(malformedPath, key);
    assert.throws(
      () => malformed.store.readBySession("stream-1"),
      (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_effect",
    );
    malformed.store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conservatively upgrades a signed version-3 current-fence cleanup without rewriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-adopted-cleanup-v3-upgrade-"));
  const path = join(root, "sessions.sqlite");
  const key = new Uint8Array(32).fill(14);
  const current = currentCleanupRecord();
  const legacy = {
    ...current,
    schemaVersion: 3,
    effects: (current.effects as Array<Record<string, unknown>>).map((effect) => {
      const { progress: _progress, ...rest } = effect;
      return rest;
    }),
  };
  const before = writeSignedStreamingSessionRow(path, key, legacy);
  const kernel = openSqliteStreamingSessionStore(path, key);
  try {
    const upgraded = kernel.store.readBySession("stream-1")!;
    assert.equal(upgraded.schemaVersion, 4);
    assert.equal(cleanupResources(upgraded as unknown as Record<string, unknown>).length, 6);
    assert.ok(cleanupResources(upgraded as unknown as Record<string, unknown>).every((resource) =>
      resource.status === "pending" && resource.attempts === 0));
    assert.deepEqual(readSignedStreamingSessionRow(path), before, "read-time upgrade must not rewrite authenticated legacy bytes");
  } finally {
    kernel.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("persists fenced cleanup attempts and releases only after all six exact facts are verified", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  let record = claimCurrentCleanup(writer);
  const resourceKinds = cleanupResources(record as unknown as Record<string, unknown>)
    .map((resource) => resource.resource as string);

  assert.throws(
    () => writer.apply({
      type: "acknowledge_cleanup", sessionId: "stream-1", expectedRevision: record.revision,
      ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", at: "2026-08-29T00:00:03.000Z",
    }),
    (error) => error instanceof StreamingSessionStoreError &&
      (error.code === "invalid_effect" || error.code === "invalid_state"),
  );

  for (const [index, resource] of resourceKinds.entries()) {
    const startedAt = new Date(Date.parse("2026-08-29T00:00:03.000Z") + index * 2_000).toISOString();
    const deadlineAt = new Date(Date.parse(startedAt) + 30_000).toISOString();
    record = writer.apply({
      type: "begin_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
      ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource,
      startedAt, deadlineAt, at: startedAt,
    });
    const inFlight = cleanupResources(record as unknown as Record<string, unknown>)[index]!;
    const attemptId = (inFlight.attempt as { attemptId: string }).attemptId;
    assert.deepEqual(inFlight.attempt, {
      attemptId, ownerId: "owner-1", fencingToken: 1, startedAt, deadlineAt,
    });
    assert.equal(inFlight.status, "in_flight");
    assert.equal(inFlight.attempts, 1);
    assert.throws(
      () => writer.apply({
        type: "acknowledge_cleanup", sessionId: "stream-1", expectedRevision: record.revision,
        ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", at: startedAt,
      }),
      (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_effect",
      `${resource} in-flight must prevent release`,
    );
    assert.throws(
      () => writer.apply({
        type: "settle_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
        ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource,
        attemptId: `wrong-${resource}`, attemptOwnerId: "owner-1", attemptFencingToken: 1,
        result: "verified", at: new Date(Date.parse(startedAt) + 1_000).toISOString(),
      }),
      (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_effect",
      `${resource} wrong attempt must be rejected`,
    );
    const settledAt = new Date(Date.parse(startedAt) + 1_000).toISOString();
    record = writer.apply({
      type: "settle_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
      ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource,
      attemptId, attemptOwnerId: "owner-1", attemptFencingToken: 1,
      result: "verified", at: settledAt,
      ...(resource === "evidence" ? { evidence: {
        kind: "bounded_output_manifest", digest: "d".repeat(64), lossy: false,
      } } : {}),
    });
    assert.equal(cleanupResources(record as unknown as Record<string, unknown>)[index]!.status, "verified");
    if (index < resourceKinds.length - 1) {
      assert.throws(
        () => writer.apply({
          type: "acknowledge_cleanup", sessionId: "stream-1", expectedRevision: record.revision,
          ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", at: settledAt,
        }),
        (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_effect",
        `${resourceKinds[index + 1]} pending must prevent release`,
      );
    }
  }

  record = writer.apply({
    type: "acknowledge_cleanup", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", at: "2026-08-29T00:00:20.000Z",
  });
  assert.equal(record.state, "released");
  assert.ok(cleanupResources(record as unknown as Record<string, unknown>).every((resource) =>
    resource.status === "verified" && resource.attempt === undefined));
});

test("blocks and retries only the exact fenced cleanup resource without losing verified facts", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  let record = verifyCleanupPrefix(writer, claimCurrentCleanup(writer), 3);
  record = writer.apply({
    type: "begin_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "channel_detach",
    startedAt: "2026-08-29T00:00:03.000Z",
    deadlineAt: "2026-08-29T00:00:30.000Z", at: "2026-08-29T00:00:03.000Z",
  });
  const attemptId = (cleanupResources(record as unknown as Record<string, unknown>)[3]!.attempt as { attemptId: string }).attemptId;
  for (const mutation of [
    { expectedRevision: record.revision + 1 },
    { ownerId: "stale-owner" },
    { fencingToken: 2 },
    { attemptOwnerId: "stale-owner" },
    { attemptFencingToken: 2 },
  ]) {
    assert.throws(() => writer.apply({
      type: "settle_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
      ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "channel_detach",
      attemptId, attemptOwnerId: "owner-1", attemptFencingToken: 1,
      result: "blocked", blocker: { code: "channel_detach_failed", message: "Streaming channel detach failed." },
      at: "2026-08-29T00:00:04.000Z", ...mutation,
    }), StreamingSessionStoreError);
  }
  record = writer.apply({
    type: "settle_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "channel_detach",
    attemptId, attemptOwnerId: "owner-1", attemptFencingToken: 1,
    result: "blocked", blocker: { code: "channel_detach_failed", message: "Streaming channel detach failed." },
    at: "2026-08-29T00:00:04.000Z",
  });
  assert.equal(record.state, "cleanup_blocked");
  assert.equal(cleanupResources(record as unknown as Record<string, unknown>)[3]!.status, "blocked");
  assert.throws(
    () => writer.apply({
      type: "acknowledge_cleanup", sessionId: "stream-1", expectedRevision: record.revision,
      ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", at: "2026-08-29T00:00:05.000Z",
    }),
    (error) => error instanceof StreamingSessionStoreError &&
      (error.code === "invalid_effect" || error.code === "invalid_state"),
  );
  record = writer.apply({
    type: "retry_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "channel_detach",
    at: "2026-08-29T00:00:05.000Z",
  });
  const retried = cleanupResources(record as unknown as Record<string, unknown>)[3]!;
  assert.equal(record.state, "cleanup_pending");
  assert.equal(retried.status, "pending");
  assert.equal(retried.attempts, 1);
});

test("refuses deadline retry, reusable attempt identity, generic v4 blocking, and invalid cleanup chronology", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  let record = verifyCleanupPrefix(writer, claimCurrentCleanup(writer), 3);
  assert.throws(() => writer.apply({
    type: "mark_cleanup_blocked", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", at: "2026-08-29T00:00:03.000Z",
  }), StreamingSessionStoreError, "generic v4 blocking cannot replace a categorical resource settlement");
  assert.throws(() => writer.apply({
    type: "begin_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "channel_detach",
    attemptId: "reusable-attempt", startedAt: "2026-08-29T00:00:01.000Z",
    deadlineAt: "2026-08-29T00:00:30.000Z", at: "2026-08-29T00:00:01.000Z",
  }), StreamingSessionStoreError, "attempt cannot predate cleanup creation");
  record = writer.apply({
    type: "begin_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "channel_detach",
    startedAt: "2026-08-29T00:00:03.000Z",
    deadlineAt: "2026-08-29T00:00:30.000Z", at: "2026-08-29T00:00:03.000Z",
  });
  const firstAttemptId = (cleanupResources(record as unknown as Record<string, unknown>)[3]!.attempt as { attemptId: string }).attemptId;
  assert.throws(() => writer.apply({
    type: "settle_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "channel_detach",
    attemptId: firstAttemptId, attemptOwnerId: "owner-1", attemptFencingToken: 1,
    result: "blocked", blocker: { code: "channel_detach_failed", message: "Streaming channel detach failed." },
    at: "2026-08-29T00:00:02.000Z",
  }), StreamingSessionStoreError, "settlement cannot predate its issued attempt");
  record = writer.apply({
    type: "settle_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "channel_detach",
    attemptId: firstAttemptId, attemptOwnerId: "owner-1", attemptFencingToken: 1,
    result: "blocked", blocker: { code: "cleanup_deadline_expired", message: "Cleanup deadline expired." },
    at: "2026-08-29T00:00:04.000Z",
  });
  assert.throws(() => writer.apply({
    type: "retry_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "channel_detach",
    at: "2026-08-29T00:00:05.000Z",
  }), StreamingSessionStoreError, "deadline expiry requires typed reconciliation before retry");

  const retryableKernel = createInMemoryStreamingSessionStore();
  const retryableWriter = getStreamingSessionStoreWriter(retryableKernel);
  let retryable = verifyCleanupPrefix(retryableWriter, claimCurrentCleanup(retryableWriter), 3);
  retryable = retryableWriter.apply({
    type: "begin_cleanup_resource", sessionId: "stream-1", expectedRevision: retryable.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "channel_detach",
    startedAt: "2026-08-29T00:00:03.000Z",
    deadlineAt: "2026-08-29T00:00:30.000Z", at: "2026-08-29T00:00:03.000Z",
  });
  const retryableAttemptId = (cleanupResources(retryable as unknown as Record<string, unknown>)[3]!.attempt as { attemptId: string }).attemptId;
  retryable = retryableWriter.apply({
    type: "settle_cleanup_resource", sessionId: "stream-1", expectedRevision: retryable.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "channel_detach",
    attemptId: retryableAttemptId, attemptOwnerId: "owner-1", attemptFencingToken: 1,
    result: "blocked", blocker: { code: "channel_detach_failed", message: "Streaming channel detach failed." },
    at: "2026-08-29T00:00:04.000Z",
  });
  assert.throws(() => retryableWriter.apply({
    type: "retry_cleanup", sessionId: "stream-1", expectedRevision: retryable.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", at: "2026-08-29T00:00:05.000Z",
  }), StreamingSessionStoreError, "generic retry cannot bypass resource classification");
  retryable = retryableWriter.apply({
    type: "retry_cleanup_resource", sessionId: "stream-1", expectedRevision: retryable.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "channel_detach",
    at: "2026-08-29T00:00:05.000Z",
  });
  assert.throws(() => retryableWriter.apply({
    type: "begin_cleanup_resource", sessionId: "stream-1", expectedRevision: retryable.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "channel_detach",
    attemptId: retryableAttemptId, startedAt: "2026-08-29T00:00:06.000Z",
    deadlineAt: "2026-08-29T00:00:30.000Z", at: "2026-08-29T00:00:06.000Z",
  }), StreamingSessionStoreError, "a late first completion must never match a reused retry identity");
});

test("rejects a signed v4 in-flight fact whose chronology predates cleanup creation", () => {
  const valid = currentCleanupRecord();
  const resources = cleanupResources(valid);
  const malformed = withCleanupResources(valid, resources.map((resource, index) => index === 0 ? {
    ...resource,
    status: "in_flight",
    attempts: 1,
    attempt: {
      attemptId: deriveAdoptedCleanupAttemptId({
        effectId: "cleanup-1", resource: "workload_quiescence", ordinal: 1,
        ownerId: "owner-1", fencingToken: 1,
      }), ownerId: "owner-1", fencingToken: 1,
      startedAt: "2026-08-29T00:00:01.000Z", deadlineAt: "2026-08-29T00:00:30.000Z",
    },
  } : resource));
  assert.throws(
    () => parseStreamingSessionRecord(malformed),
    (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_effect",
  );
});

test("deadline-expired cleanup cannot retry without typed reconciliation", () => {
  const { writer, record } = blockedChannelCleanup("cleanup_deadline_expired", "Cleanup deadline expired.");
  assert.throws(() => writer.apply({
    type: "retry_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "channel_detach",
    at: "2026-08-29T00:00:05.000Z",
  }), StreamingSessionStoreError);
});

test("deadline reconciliation retains the exact attempt until an observed resolution", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  let record = claimCurrentCleanup(writer);
  record = writer.apply({
    type: "begin_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "workload_quiescence",
    startedAt: "2026-08-29T00:00:03.000Z", deadlineAt: "2026-08-29T00:00:30.000Z",
    at: "2026-08-29T00:00:03.000Z",
  });
  const attempt = cleanupResources(record as unknown as Record<string, unknown>)[0]!.attempt as {
    attemptId: string; ownerId: string; fencingToken: number;
  };
  record = writer.apply({
    type: "settle_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "workload_quiescence",
    attemptId: attempt.attemptId, attemptOwnerId: attempt.ownerId,
    attemptFencingToken: attempt.fencingToken, result: "blocked",
    blocker: { code: "cleanup_deadline_expired", message: "Cleanup deadline expired." },
    at: "2026-08-29T00:00:31.000Z",
  });
  const retained = cleanupResources(record as unknown as Record<string, unknown>)[0]!;
  assert.equal(retained.status, "blocked");
  assert.deepEqual(retained.attempt, attempt);
  assert.throws(() => writer.apply({
    type: "retry_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "workload_quiescence",
    at: "2026-08-29T00:00:32.000Z",
  }), StreamingSessionStoreError);
  record = writer.apply({
    type: "settle_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "workload_quiescence",
    attemptId: attempt.attemptId, attemptOwnerId: attempt.ownerId,
    attemptFencingToken: attempt.fencingToken, result: "verified",
    at: "2026-08-29T00:00:33.000Z",
  });
  assert.equal(record.state, "cleanup_pending");
  assert.equal(cleanupResources(record as unknown as Record<string, unknown>)[0]!.status, "verified");
  assert.equal(cleanupResources(record as unknown as Record<string, unknown>)[0]!.attempt, undefined);
});

test("cleanup attempt identity cannot be reused after a blocked retry", () => {
  const { writer, record, attemptId } = blockedChannelCleanup("channel_detach_failed", "Streaming channel detach failed.");
  const retried = writer.apply({
    type: "retry_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "channel_detach",
    at: "2026-08-29T00:00:05.000Z",
  });
  assert.throws(() => writer.apply({
    type: "begin_cleanup_resource", sessionId: "stream-1", expectedRevision: retried.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "channel_detach",
    attemptId, startedAt: "2026-08-29T00:00:06.000Z",
    deadlineAt: "2026-08-29T00:00:30.000Z", at: "2026-08-29T00:00:06.000Z",
  }), StreamingSessionStoreError);
});

test("generic retry cannot bypass a categorical version-4 resource blocker", () => {
  const { writer, record } = blockedChannelCleanup("channel_detach_failed", "Streaming channel detach failed.");
  assert.throws(() => writer.apply({
    type: "retry_cleanup", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", at: "2026-08-29T00:00:05.000Z",
  }), StreamingSessionStoreError);
});

test("generic blocking cannot replace a categorical version-4 resource settlement", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  const record = claimCurrentCleanup(writer);
  assert.throws(() => writer.apply({
    type: "mark_cleanup_blocked", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", at: "2026-08-29T00:00:03.000Z",
  }), StreamingSessionStoreError);
});

test("cleanup attempt and settlement chronology cannot predate their durable causes", () => {
  const first = createInMemoryStreamingSessionStore();
  const firstWriter = getStreamingSessionStoreWriter(first);
  const cleaning = verifyCleanupPrefix(firstWriter, claimCurrentCleanup(firstWriter), 3);
  assert.throws(() => firstWriter.apply({
    type: "begin_cleanup_resource", sessionId: "stream-1", expectedRevision: cleaning.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "channel_detach",
    attemptId: "chronology-attempt", startedAt: "2026-08-29T00:00:01.000Z",
    deadlineAt: "2026-08-29T00:00:30.000Z", at: "2026-08-29T00:00:01.000Z",
  }), StreamingSessionStoreError);
  const inFlight = firstWriter.apply({
    type: "begin_cleanup_resource", sessionId: "stream-1", expectedRevision: cleaning.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "channel_detach",
    startedAt: "2026-08-29T00:00:03.000Z",
    deadlineAt: "2026-08-29T00:00:30.000Z", at: "2026-08-29T00:00:03.000Z",
  });
  const attemptId = (cleanupResources(inFlight as unknown as Record<string, unknown>)[3]!.attempt as { attemptId: string }).attemptId;
  assert.throws(() => firstWriter.apply({
    type: "settle_cleanup_resource", sessionId: "stream-1", expectedRevision: inFlight.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "channel_detach",
    attemptId, attemptOwnerId: "owner-1", attemptFencingToken: 1,
    result: "verified", at: "2026-08-29T00:00:02.000Z",
  }), StreamingSessionStoreError);
});

test("takeover preserves a verified cleanup fact under its historical proof owner", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  let record = claimCurrentCleanup(writer);
  record = writer.apply({
    type: "begin_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "workload_quiescence",
    startedAt: "2026-08-29T00:00:03.000Z", deadlineAt: "2026-08-29T00:00:30.000Z",
    at: "2026-08-29T00:00:03.000Z",
  });
  const attemptId = (cleanupResources(record as unknown as Record<string, unknown>)[0]!.attempt as { attemptId: string }).attemptId;
  record = writer.apply({
    type: "settle_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "workload_quiescence",
    attemptId, attemptOwnerId: "owner-1", attemptFencingToken: 1, result: "verified",
    at: "2026-08-29T00:00:04.000Z",
  });
  const taken = writer.apply({
    type: "takeover", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, newOwnerId: "owner-2", newFencingToken: 2,
    leaseExpiresAt: "2026-08-29T00:10:00.000Z", at: "2026-08-29T00:05:00.000Z",
  });
  assert.deepEqual(cleanupResources(taken as unknown as Record<string, unknown>)[0], {
    ...cleanupResources(record as unknown as Record<string, unknown>)[0],
    status: "verified",
  });
});

test("takeover retains an old in-flight attempt without permitting a repeat or late settlement", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  let record = claimCurrentCleanup(writer);
  record = writer.apply({
    type: "begin_cleanup_resource", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "workload_quiescence",
    startedAt: "2026-08-29T00:00:03.000Z", deadlineAt: "2026-08-29T00:00:30.000Z",
    at: "2026-08-29T00:00:03.000Z",
  });
  const oldAttempt = (cleanupResources(record as unknown as Record<string, unknown>)[0]!.attempt as { attemptId: string }).attemptId;
  const taken = writer.apply({
    type: "takeover", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, newOwnerId: "owner-2", newFencingToken: 2,
    leaseExpiresAt: "2026-08-29T00:10:00.000Z", at: "2026-08-29T00:05:00.000Z",
  });
  assert.equal(cleanupResources(taken as unknown as Record<string, unknown>)[0]!.status, "in_flight");
  assert.throws(() => writer.apply({
    type: "begin_cleanup_resource", sessionId: "stream-1", expectedRevision: taken.revision,
    ownerId: "owner-2", fencingToken: 2, effectId: "cleanup-1", resource: "workload_quiescence",
    startedAt: "2026-08-29T00:05:01.000Z", deadlineAt: "2026-08-29T00:06:00.000Z",
    at: "2026-08-29T00:05:01.000Z",
  }), StreamingSessionStoreError);
  assert.throws(() => writer.apply({
    type: "settle_cleanup_resource", sessionId: "stream-1", expectedRevision: taken.revision,
    ownerId: "owner-1", fencingToken: 1, effectId: "cleanup-1", resource: "workload_quiescence",
    attemptId: oldAttempt, attemptOwnerId: "owner-1", attemptFencingToken: 1,
    result: "verified", at: "2026-08-29T00:05:01.000Z",
  }), (error) => error instanceof StreamingSessionStoreError && error.code === "stale_fence");
});

test("takeover re-fences a retryable blocked cleanup fact with coherent blocker chronology", () => {
  const { writer, record } = blockedChannelCleanup("channel_detach_failed", "Streaming channel detach failed.");
  const taken = writer.apply({
    type: "takeover", sessionId: "stream-1", expectedRevision: record.revision,
    ownerId: "owner-1", fencingToken: 1, newOwnerId: "owner-2", newFencingToken: 2,
    leaseExpiresAt: "2026-08-29T00:10:00.000Z", at: "2026-08-29T00:05:00.000Z",
  });
  const cleanup = taken.effects.find((effect) => effect.kind === "cleanup")!;
  assert.equal(cleanup.blockedAt, "2026-08-29T00:05:00.000Z");
  const blocked = cleanupResources(taken as unknown as Record<string, unknown>)[3]!;
  assert.equal(blocked.ownerId, "owner-2");
  assert.equal(blocked.fencingToken, 2);
  const retried = writer.apply({
    type: "retry_cleanup_resource", sessionId: "stream-1", expectedRevision: taken.revision,
    ownerId: "owner-2", fencingToken: 2, effectId: "cleanup-1", resource: "channel_detach",
    at: "2026-08-29T00:05:01.000Z",
  });
  assert.equal(retried.state, "cleanup_pending");
});

test("takeover preserves retained deadline and unknown attempts under their historical proof owner", () => {
  for (const [code, message] of [
    ["cleanup_deadline_expired", "Cleanup deadline expired."],
    ["cleanup_effect_outcome_unknown", "Cleanup effect outcome is unknown."],
  ] as const) {
    const { writer, record, attemptId } = blockedChannelCleanup(code, message);
    const taken = writer.apply({
      type: "takeover", sessionId: "stream-1", expectedRevision: record.revision,
      ownerId: "owner-1", fencingToken: 1, newOwnerId: "owner-2", newFencingToken: 2,
      leaseExpiresAt: "2026-08-29T00:10:00.000Z", at: "2026-08-29T00:05:00.000Z",
    });
    const fact = cleanupResources(taken as unknown as Record<string, unknown>)[3]!;
    assert.equal(fact.ownerId, "owner-2");
    assert.equal(fact.fencingToken, 2);
    assert.deepEqual(fact.attempt, {
      attemptId,
      ownerId: "owner-1",
      fencingToken: 1,
      startedAt: "2026-08-29T00:00:03.000Z",
      deadlineAt: "2026-08-29T00:00:30.000Z",
    });
    assert.throws(() => writer.apply({
      type: "retry_cleanup_resource", sessionId: "stream-1", expectedRevision: taken.revision,
      ownerId: "owner-2", fencingToken: 2, effectId: "cleanup-1", resource: "channel_detach",
      at: "2026-08-29T00:05:01.000Z",
    }), StreamingSessionStoreError);
  }
});

test("retained cleanup attempt proof owner must exist in takeover provenance", () => {
  const { record } = blockedChannelCleanup("cleanup_deadline_expired", "Cleanup deadline expired.");
  const source = structuredClone(record) as unknown as Record<string, unknown>;
  const resources = cleanupResources(source);
  const fact = resources[3]!;
  const attempt = fact.attempt as Record<string, unknown>;
  Object.assign(attempt, {
    ownerId: "foreign-owner",
    fencingToken: 9,
    attemptId: deriveAdoptedCleanupAttemptId({
      effectId: "cleanup-1",
      resource: "channel_detach",
      ordinal: 1,
      ownerId: "foreign-owner",
      fencingToken: 9,
    }),
  });
  const forged = withCleanupResources(source, resources);
  assert.throws(() => parseStreamingSessionRecord(forged), StreamingSessionStoreError);
});

test("refuses an active record that tries to downgrade to the historical schema", () => {
  const { cleanupCreationAuthority: _cleanupCreationAuthority, ...legacyShape } = pendingTransferRecord();
  assert.throws(
    () => parseStreamingSessionRecord({ ...legacyShape, schemaVersion: 0 }),
    (error) => error instanceof StreamingSessionStoreError && error.code === "unsafe_downgrade",
  );
});

test("rejects a pending transfer whose cleanup ownership was forged as adopted", () => {
  assert.throws(
    () => parseStreamingSessionRecord(pendingTransferRecord({ cleanupOwner: "session_authority" })),
    (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_state",
  );
});

test("rejects impossible adopted states, illegal history, and malformed immutable timing evidence", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  const pending = writer.claim(pendingTransferRecord()).record;
  const active = writer.apply({
    type: "acknowledge_transfer", sessionId: "stream-1", expectedRevision: pending.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:01.000Z", effectId: "transfer-1",
  });
  for (const variant of [
    { ...active, cleanupOwner: "tool_broker" },
    { ...active, state: "released", cleanupOwner: "none" },
    { ...active, history: [{ state: "active", at: "2026-08-29T00:00:01.000Z" }] },
    { ...active, leaseExpiresAt: "not-a-timestamp" },
  ]) {
    assert.throws(
      () => parseStreamingSessionRecord(variant),
      (error) => error instanceof StreamingSessionStoreError &&
        (error.code === "invalid_state" || error.code === "invalid_record"),
    );
  }
});

test("refuses durable session data that carries a bearer credential", () => {
  const record = pendingTransferRecord({
    envelope: {
      access: [{ canonicalPath: "C:\\workspace", mode: "write" }],
      credentialNames: ["SERVICE_TOKEN"],
      networkApproved: false,
      externalApproved: false,
      destructiveApproved: false,
      bearerToken: "never-durable",
    },
  });
  assert.throws(
    () => parseStreamingSessionRecord(record),
    (error) => error instanceof StreamingSessionStoreError && error.code === "forbidden_durable_value",
  );
});

test("refuses every live capability and secret-shaped value before it can enter durable or model-visible state", () => {
  for (const field of [
    "opaqueGrant", "grant", "bearerToken", "token", "controlPort", "inputPayload", "payload",
    "writer", "nativeHandle", "channel", "endpoint", "liveEndpoint", "liveCapability",
  ]) {
    assert.throws(
      () => parseStreamingSessionRecord({ ...pendingTransferRecord(), [field]: "never-durable" }),
      (error) => error instanceof StreamingSessionStoreError && error.code === "forbidden_durable_value",
      field,
    );
  }
  const kernel = createInMemoryStreamingSessionStore();
  getStreamingSessionStoreWriter(kernel).claim(pendingTransferRecord());
  const modelVisible = JSON.stringify({ sessions: kernel.store.listSessionIds().map((id) => kernel.store.readBySession(id)) });
  assert.equal(/opaqueGrant|bearerToken|controlPort|inputPayload|nativeHandle|liveEndpoint|liveCapability/.test(modelVisible), false);
  assert.equal(JSON.stringify(kernel).includes("writer"), false);
});

test("rejects unknown fields nested inside immutable access envelopes", () => {
  const record = pendingTransferRecord({
    envelope: {
      access: [{ canonicalPath: "C:\\workspace", mode: "write" }],
      credentialNames: ["SERVICE_TOKEN"],
      networkApproved: false,
      externalApproved: false,
      destructiveApproved: false,
      unauthorizedExpansion: true,
    },
  });
  assert.throws(
    () => parseStreamingSessionRecord(record),
    (error) => error instanceof StreamingSessionStoreError && error.code === "unknown_field",
  );
});

test("refuses record-capacity overflow without evicting active cleanup ownership", () => {
  const kernel = createInMemoryStreamingSessionStore({ maxRecords: 1 });
  const writer = getStreamingSessionStoreWriter(kernel);
  writer.claim(pendingTransferRecord());
  assert.throws(
    () => writer.claim(pendingTransferRecord({ sessionId: "stream-2" })),
    (error) => error instanceof StreamingSessionStoreError && error.code === "capacity_exceeded",
  );
  const retained = kernel.store.readBySession("stream-1");
  assert.equal(retained?.cleanupOwner, "tool_broker");
  assert.equal(retained?.effects[0]?.effectId, "transfer-1");
});

test("makes an exact session claim idempotent but rejects a semantic session-ID collision in memory and SQLite", async () => {
  const assertCollision = (kernel: ReturnType<typeof createInMemoryStreamingSessionStore>) => {
    const writer = getStreamingSessionStoreWriter(kernel);
    const first = writer.claim(pendingTransferRecord());
    const exactRetry = writer.claim(pendingTransferRecord());
    assert.equal(first.won, true);
    assert.equal(exactRetry.won, false);
    assert.equal(exactRetry.record.runId, "run-1");
    assert.throws(
      () => writer.claim(pendingTransferRecord({ runId: "other-run" })),
      (error) => error instanceof StreamingSessionStoreError && (error as { code: string }).code === "identity_conflict",
    );
    assert.equal(kernel.store.readBySession("stream-1")?.runId, "run-1");
  };

  assertCollision(createInMemoryStreamingSessionStore());
  const root = await mkdtemp(join(tmpdir(), "runner-v2-stream-store-collision-"));
  const sqlite = openSqliteStreamingSessionStore(join(root, "sessions.sqlite"), new Uint8Array(32).fill(8));
  try {
    assertCollision(sqlite);
  } finally {
    sqlite.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("acknowledges the exact fenced transfer before making a session active", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  const claimed = writer.claim(pendingTransferRecord()).record;
  const active = writer.apply({
    type: "acknowledge_transfer",
    sessionId: "stream-1",
    expectedRevision: claimed.revision,
    ownerId: "owner-1",
    fencingToken: 1,
    at: "2026-08-29T00:00:01.000Z",
    effectId: "transfer-1",
  });
  assert.equal(active.state, "active");
  assert.equal(active.cleanupOwner, "session_authority");
  assert.equal(active.effects[0]?.status, "acknowledged");
});

test("rejects malformed durable owner identity instead of accepting a partial actor binding", () => {
  assert.throws(
    () => parseStreamingSessionRecord(pendingTransferRecord({ actor: { role: "worker" } })),
    (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_record",
  );
});

test("fails closed to provider-lease ownership when a transfer acknowledgement is ambiguous", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  const claimed = writer.claim(pendingTransferRecord()).record;
  const ambiguous = writer.apply({
    type: "mark_transfer_ambiguous",
    sessionId: "stream-1",
    expectedRevision: claimed.revision,
    ownerId: "owner-1",
    fencingToken: 1,
    at: "2026-08-29T00:00:01.000Z",
    effectId: "transfer-1",
  });
  assert.equal(ambiguous.state, "transfer_ambiguous");
  assert.equal(ambiguous.cleanupOwner, "provider_lease");
  assert.equal(ambiguous.effects[0]?.status, "pending");
});

test("reopens a durable streaming-session store without losing pending cleanup ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-stream-store-"));
  const path = join(root, "sessions.sqlite");
  try {
    const first = openSqliteStreamingSessionStore(path, new Uint8Array(32).fill(4));
    getStreamingSessionStoreWriter(first).claim(pendingTransferRecord());
    first.store.close();
    const reopened = openSqliteStreamingSessionStore(path, new Uint8Array(32).fill(4));
    const record = reopened.store.readBySession("stream-1");
    assert.equal(record?.state, "pending_transfer");
    assert.equal(record?.cleanupOwner, "tool_broker");
    reopened.store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a released session that lacks acknowledged cleanup evidence", () => {
  assert.throws(
    () => parseStreamingSessionRecord(pendingTransferRecord({
      revision: 1,
      state: "released",
      cleanupOwner: "none",
      history: [
        { state: "pending_transfer", at: "2026-08-29T00:00:00.000Z" },
        { state: "released", at: "2026-08-29T00:00:01.000Z" },
      ],
      effects: [],
    })),
    (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_state",
  );
});

test("rejects unsupported schema versions even when their record claims to be terminal", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  const pending = writer.claim(pendingTransferRecord()).record;
  const active = writer.apply({
    type: "acknowledge_transfer", sessionId: "stream-1", expectedRevision: pending.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:01.000Z", effectId: "transfer-1",
  });
  const cleaning = writer.apply({
    type: "begin_cleanup", sessionId: "stream-1", expectedRevision: active.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:02.000Z", effectId: "cleanup-1",
  });
  const released = verifyAndReleaseCurrentCleanup(writer, cleaning);
  assert.throws(
    () => parseStreamingSessionRecord({ ...released, schemaVersion: 99 }),
    (error) => error instanceof StreamingSessionStoreError && error.code === "unsupported_version",
  );
});

test("preserves the known historical terminal streaming-session schema", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  const pending = writer.claim(pendingTransferRecord()).record;
  const active = writer.apply({
    type: "acknowledge_transfer", sessionId: "stream-1", expectedRevision: pending.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:01.000Z", effectId: "transfer-1",
  });
  const cleaning = writer.apply({
    type: "begin_cleanup", sessionId: "stream-1", expectedRevision: active.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:02.000Z", effectId: "cleanup-1",
  });
  const released = verifyAndReleaseCurrentCleanup(writer, cleaning);
  const { cleanupCreationAuthority: _cleanupCreationAuthority, ...legacyReleased } = released;
  assert.equal(parseStreamingSessionRecord({
    ...legacyReleased,
    schemaVersion: 0,
    effects: released.effects.map((effect) => {
      const { cleanupProvenance: _cleanupProvenance, progress: _progress, ...legacyEffect } = effect;
      return legacyEffect;
    }),
  }).schemaVersion, 0);
});

test("changes the durable record digest for every independently meaningful claim category", () => {
  const record = pendingTransferRecord();
  const baseDigest = digestStreamingSessionRecord(record);
  const variants = [
    { ...record, sessionId: "other-session" },
    { ...record, ownerId: "other-owner" },
    { ...record, fencingToken: 2 },
    { ...record, leaseExpiresAt: "2026-08-29T00:06:00.000Z" },
    { ...record, actor: { role: "worker", id: "other-worker" } },
    { ...record, envelope: { ...(record.envelope as object), networkApproved: true } },
    { ...record, lease: { ...(record.lease as object), providerId: "other-provider" } },
    { ...record, backendBinding: { ...(record.backendBinding as object), backendId: "other-backend" } },
    {
      ...record,
      cleanupCreationAuthority: {
        effectId: "cleanup-1", ownerId: "owner-1", fencingToken: 1,
        createdAt: "2026-08-29T00:00:01.000Z",
      },
    },
    { ...record, effects: [{ ...(record.effects as Array<object>)[0]!, effectId: "other-effect" }] },
  ];
  for (const variant of variants) assert.notEqual(digestStreamingSessionRecord(variant), baseDigest);
});

test("includes every remaining streaming authority, envelope, lease, lifecycle, and backend claim in its digest", () => {
  const record = pendingTransferRecord();
  const digest = digestStreamingSessionRecord(record);
  const variants = [
    { ...record, recordKind: "other-kind" },
    { ...record, schemaVersion: 0 },
    { ...record, revision: 99 },
    { ...record, agentSessionId: "other-agent-session" },
    { ...record, toolName: "process.request" },
    { ...record, callId: "other-call" },
    { ...record, cleanupOwner: "provider_lease" },
    { ...record, state: "transfer_ambiguous" },
    { ...record, actor: { role: "architect", id: "worker-1" } },
    { ...record, envelope: { ...(record.envelope as object), credentialNames: ["OTHER_TOKEN"] } },
    { ...record, envelope: { ...(record.envelope as object), externalApproved: true } },
    { ...record, envelope: { ...(record.envelope as object), destructiveApproved: true } },
    { ...record, lease: { ...(record.lease as object), leaseId: "other-lease" } },
    { ...record, lease: { ...(record.lease as object), invocationId: "other-invocation" } },
    { ...record, lease: { ...(record.lease as object), acquiredAt: "2026-08-29T00:01:00.000Z" } },
    { ...record, backendBinding: { ...(record.backendBinding as object), implementationGeneration: "other-generation" } },
    { ...record, backendBinding: { ...(record.backendBinding as object), attestationVersion: 2 } },
    { ...record, backendBinding: { ...(record.backendBinding as object), opaqueIdentity: "other-child" } },
    { ...record, history: [{ state: "pending_transfer", at: "2026-08-29T00:00:01.000Z" }] },
    { ...record, effects: [{ ...(record.effects as Array<object>)[0]!, owner: "provider_lease" }] },
  ];
  for (const variant of variants) assert.notEqual(digestStreamingSessionRecord(variant), digest);
});

test("rejects unknown fields inside the immutable isolation lease", () => {
  const record = pendingTransferRecord({
    lease: {
      ...(pendingTransferRecord().lease as object),
      unexpectedLeaseExpansion: true,
    },
  });
  assert.throws(
    () => parseStreamingSessionRecord(record),
    (error) => error instanceof StreamingSessionStoreError && error.code === "unknown_field",
  );
});

test("rejects unknown fields inside the exact backend binding", () => {
  const record = pendingTransferRecord({
    backendBinding: {
      ...(pendingTransferRecord().backendBinding as object),
      liveEndpoint: "never-durable",
    },
  });
  assert.throws(
    () => parseStreamingSessionRecord(record),
    (error) => error instanceof StreamingSessionStoreError && error.code === "forbidden_durable_value",
  );
});

test("streaming backend binding lifecycle scope is versioned fail-closed", () => {
  const legacy = pendingTransferRecord().backendBinding as Record<string, unknown>;
  assert.throws(() => parseStreamingSessionRecord(pendingTransferRecord({
    backendBinding: { ...legacy, lifecycle: { scope: "process_group", termination: "enforced", emptiness: "enforced" } },
  })), (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_record");
  assert.throws(() => parseStreamingSessionRecord(pendingTransferRecord({
    backendBinding: { ...legacy, attestationVersion: 2 },
  })), (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_record");
  assert.doesNotThrow(() => parseStreamingSessionRecord(pendingTransferRecord({
    backendBinding: {
      ...legacy,
      attestationVersion: 2,
      lifecycle: { scope: "process_group", termination: "enforced", emptiness: "enforced" },
    },
  })));
});

test("accepts a bounded path-sized opaque backend identity and rejects oversized durable input", () => {
  const binding = pendingTransferRecord().backendBinding as Record<string, unknown>;
  assert.doesNotThrow(() => parseStreamingSessionRecord(pendingTransferRecord({
    backendBinding: { ...binding, opaqueIdentity: "x".repeat(4_096) },
  })));
  assert.throws(
    () => parseStreamingSessionRecord(pendingTransferRecord({
      backendBinding: { ...binding, opaqueIdentity: "x".repeat(64 * 1_024 + 1) },
    })),
    (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_record",
  );
});

test("rejects unknown fields inside exact path access claims", () => {
  const record = pendingTransferRecord({
    envelope: {
      access: [{ canonicalPath: "C:\\workspace", mode: "write", pathUnion: true }],
      credentialNames: ["SERVICE_TOKEN"],
      networkApproved: false,
      externalApproved: false,
      destructiveApproved: false,
    },
  });
  assert.throws(
    () => parseStreamingSessionRecord(record),
    (error) => error instanceof StreamingSessionStoreError && error.code === "unknown_field",
  );
});

test("refuses effect-capacity overflow without evicting the ambiguous transfer evidence", () => {
  const kernel = createInMemoryStreamingSessionStore({ maxEffectsPerRecord: 1 });
  const writer = getStreamingSessionStoreWriter(kernel);
  const pending = writer.claim(pendingTransferRecord()).record;
  const ambiguous = writer.apply({
    type: "mark_transfer_ambiguous", sessionId: "stream-1", expectedRevision: pending.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:01.000Z", effectId: "transfer-1",
  });
  assert.throws(
    () => writer.apply({
      type: "begin_cleanup", sessionId: "stream-1", expectedRevision: ambiguous.revision,
      ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:02.000Z", effectId: "cleanup-1",
    }),
    (error) => error instanceof StreamingSessionStoreError && error.code === "capacity_exceeded",
  );
  const retained = kernel.store.readBySession("stream-1");
  assert.equal(retained?.state, "transfer_ambiguous");
  assert.equal(retained?.effects[0]?.effectId, "transfer-1");
});

test("enforces configured effect capacity on initial claims without evicting active ownership", async () => {
  const source = createInMemoryStreamingSessionStore();
  const sourceWriter = getStreamingSessionStoreWriter(source);
  const pending = sourceWriter.claim(pendingTransferRecord()).record;
  const active = sourceWriter.apply({
    type: "acknowledge_transfer", sessionId: "stream-1", expectedRevision: pending.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:01.000Z", effectId: "transfer-1",
  });
  const otherSource = createInMemoryStreamingSessionStore();
  const otherWriter = getStreamingSessionStoreWriter(otherSource);
  const otherPending = otherWriter.claim(pendingTransferRecord({ sessionId: "stream-2" })).record;
  const otherActive = otherWriter.apply({
    type: "acknowledge_transfer", sessionId: "stream-2", expectedRevision: otherPending.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:01.000Z", effectId: "transfer-1",
  });
  const otherCleaning = otherWriter.apply({
    type: "begin_cleanup", sessionId: "stream-2", expectedRevision: otherActive.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:02.000Z", effectId: "cleanup-1",
  });
  const assertInitialClaimCap = (kernel: ReturnType<typeof createInMemoryStreamingSessionStore>) => {
    const writer = getStreamingSessionStoreWriter(kernel);
    writer.claim(active);
    assert.throws(
      () => writer.claim(otherCleaning),
      (error) => error instanceof StreamingSessionStoreError && error.code === "capacity_exceeded",
    );
    const retained = kernel.store.readBySession("stream-1");
    assert.equal(retained?.state, "active");
    assert.equal(retained?.cleanupOwner, "session_authority");
    assert.equal(retained?.effects[0]?.status, "acknowledged");
  };
  assertInitialClaimCap(createInMemoryStreamingSessionStore({ maxEffectsPerRecord: 1 }));

  const root = await mkdtemp(join(tmpdir(), "runner-v2-stream-store-initial-effect-cap-"));
  const sqlite = openSqliteStreamingSessionStore(join(root, "streaming.sqlite"), new Uint8Array(32).fill(7), {
    maxEffectsPerRecord: 1,
  });
  try {
    assertInitialClaimCap(sqlite);
  } finally {
    sqlite.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("durably blocks an exact cleanup effect without dropping its sole cleanup owner", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  const pending = writer.claim(pendingTransferRecord()).record;
  const ambiguous = writer.apply({
    type: "mark_transfer_ambiguous", sessionId: "stream-1", expectedRevision: pending.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:01.000Z", effectId: "transfer-1",
  });
  const transferAcknowledged = writer.apply({
    type: "acknowledge_ambiguous_transfer", sessionId: "stream-1", expectedRevision: ambiguous.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:02.000Z", effectId: "transfer-1",
  });
  const cleaning = writer.apply({
    type: "begin_cleanup", sessionId: "stream-1", expectedRevision: transferAcknowledged.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:03.000Z", effectId: "cleanup-1",
  });
  const blocked = writer.apply({
    type: "mark_cleanup_blocked", sessionId: "stream-1", expectedRevision: cleaning.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:04.000Z", effectId: "cleanup-1",
  });
  assert.equal(blocked.state, "cleanup_blocked");
  assert.equal(blocked.cleanupOwner, "provider_lease");
  assert.equal(blocked.effects.find((effect) => effect.kind === "cleanup")?.status, "blocked");
});

test("records a typed adopted-session outcome without relaunching or broadening authority", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  const pending = writer.claim(pendingTransferRecord()).record;
  const active = writer.apply({
    type: "acknowledge_transfer", sessionId: "stream-1", expectedRevision: pending.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:01.000Z", effectId: "transfer-1",
  });
  const unavailable = writer.apply({
    type: "mark_disposition", disposition: "outcome_unknown", sessionId: "stream-1",
    expectedRevision: active.revision, ownerId: "owner-1", fencingToken: 1,
    at: "2026-08-29T00:00:02.000Z",
  });
  assert.equal(unavailable.state, "outcome_unknown");
  assert.equal(unavailable.cleanupOwner, "session_authority");
  assert.equal(unavailable.effects.length, 1);
  assert.equal(unavailable.effects[0]?.status, "acknowledged");
});

test("requires a fenced stopping transition before an adopted session begins cleanup", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  const pending = writer.claim(pendingTransferRecord()).record;
  const active = writer.apply({
    type: "acknowledge_transfer", sessionId: "stream-1", expectedRevision: pending.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:01.000Z", effectId: "transfer-1",
  });
  const stopping = writer.apply({
    type: "begin_stopping", sessionId: "stream-1", expectedRevision: active.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:02.000Z",
  });
  assert.equal(stopping.state, "stopping");
  assert.equal(stopping.cleanupOwner, "session_authority");
  assert.equal(stopping.history.at(-1)?.state, "stopping");
});

test("fenced recovery can take over an adopted session without reviving an old owner", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  const pending = writer.claim(pendingTransferRecord({
    leaseExpiresAt: "2026-08-29T00:00:02.000Z",
  })).record;
  const active = writer.apply({
    type: "acknowledge_transfer", sessionId: "stream-1", expectedRevision: pending.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:01.000Z", effectId: "transfer-1",
  });
  const takenOver = writer.apply({
    type: "takeover", sessionId: "stream-1", expectedRevision: active.revision,
    ownerId: "owner-1", fencingToken: 1, newOwnerId: "owner-recovered", newFencingToken: 2,
    leaseExpiresAt: "2026-08-29T00:10:00.000Z", at: "2026-08-29T00:00:02.000Z",
  });
  assert.equal(takenOver.ownerId, "owner-recovered");
  assert.equal(takenOver.fencingToken, 2);
  assert.throws(
    () => writer.apply({
      type: "mark_disposition", disposition: "outcome_unknown", sessionId: "stream-1",
      expectedRevision: takenOver.revision, ownerId: "owner-1", fencingToken: 1,
      at: "2026-08-29T00:00:03.000Z",
    }),
    (error) => error instanceof StreamingSessionStoreError && error.code === "stale_fence",
  );
});

test("requires ownership-lease expiry for takeover and refuses expired-owner durable mutations", () => {
  const kernel = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(kernel);
  const pending = writer.claim(pendingTransferRecord({
    leaseExpiresAt: "2026-08-29T00:01:00.000Z",
  })).record;
  const active = writer.apply({
    type: "acknowledge_transfer", sessionId: "stream-1", expectedRevision: pending.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:01.000Z", effectId: "transfer-1",
  });
  assert.throws(
    () => writer.apply({
      type: "takeover", sessionId: "stream-1", expectedRevision: active.revision,
      ownerId: "owner-1", fencingToken: 1, newOwnerId: "owner-recovered", newFencingToken: 2,
      leaseExpiresAt: "2026-08-29T00:02:00.000Z", at: "2026-08-29T00:00:30.000Z",
    }),
    (error) => error instanceof StreamingSessionStoreError && (error as { code: string }).code === "lease_not_expired",
  );
  assert.throws(
    () => writer.apply({
      type: "mark_disposition", disposition: "outcome_unknown", sessionId: "stream-1",
      expectedRevision: active.revision, ownerId: "owner-1", fencingToken: 1,
      at: "2026-08-29T00:01:00.000Z",
    }),
    (error) => error instanceof StreamingSessionStoreError && (error as { code: string }).code === "lease_expired",
  );
  const takenOver = writer.apply({
    type: "takeover", sessionId: "stream-1", expectedRevision: active.revision,
    ownerId: "owner-1", fencingToken: 1, newOwnerId: "owner-recovered", newFencingToken: 2,
    leaseExpiresAt: "2026-08-29T00:02:00.000Z", at: "2026-08-29T00:01:00.000Z",
  });
  assert.equal(takenOver.ownerId, "owner-recovered");
  assert.equal(takenOver.fencingToken, 2);
  const cleaning = writer.apply({
    type: "begin_cleanup", sessionId: "stream-1", expectedRevision: takenOver.revision,
    ownerId: "owner-recovered", fencingToken: 2, at: "2026-08-29T00:01:01.000Z", effectId: "cleanup-1",
  });
  assert.throws(
    () => writer.apply({
      type: "takeover", sessionId: "stream-1", expectedRevision: cleaning.revision,
      ownerId: "owner-recovered", fencingToken: 2, newOwnerId: "owner-third", newFencingToken: 3,
      leaseExpiresAt: "2026-08-29T00:03:00.000Z", at: "2026-08-29T00:01:30.000Z",
    }),
    (error) => error instanceof StreamingSessionStoreError && error.code === "lease_not_expired",
  );
});

test("quarantines coherent forged active version-2 cleanup provenance without mutating SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-stream-cleanup-v2-quarantine-"));
  const path = join(root, "sessions.sqlite");
  const integrityKey = new Uint8Array(32).fill(12);
  let first: ReturnType<typeof openSqliteStreamingSessionStore> | undefined;
  let reopened: ReturnType<typeof openSqliteStreamingSessionStore> | undefined;
  try {
    const source = createInMemoryStreamingSessionStore();
    const sourceWriter = getStreamingSessionStoreWriter(source);
    const pending = sourceWriter.claim(pendingTransferRecord({
      leaseExpiresAt: "2026-08-29T00:01:00.000Z",
    })).record;
    const active = sourceWriter.apply({
      type: "acknowledge_transfer", sessionId: "stream-1", expectedRevision: pending.revision,
      ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:01.000Z", effectId: "transfer-1",
    });
    const cleaning = sourceWriter.apply({
      type: "begin_cleanup", sessionId: "stream-1", expectedRevision: active.revision,
      ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:02.000Z", effectId: "cleanup-1",
    });
    const takenOver = sourceWriter.apply({
      type: "takeover", sessionId: "stream-1", expectedRevision: cleaning.revision,
      ownerId: "owner-1", fencingToken: 1, newOwnerId: "owner-recovered", newFencingToken: 2,
      leaseExpiresAt: "2026-08-29T00:03:00.000Z", at: "2026-08-29T00:01:00.000Z",
    });
    const { cleanupCreationAuthority: _anchor, ...unanchored } = takenOver;
    const cleanup = takenOver.effects.find((effect) => effect.kind === "cleanup")!;
    const provenance = cleanup.cleanupProvenance!;
    const forged = {
      ...unanchored,
      schemaVersion: 2,
      effects: takenOver.effects.map((effect) => effect.kind === "cleanup"
        ? (() => {
          const { progress: _progress, ...legacyEffect } = effect;
          return {
          ...legacyEffect,
          cleanupProvenance: {
            ...provenance,
            originOwnerId: "forged-origin",
            takeovers: [{ ...provenance.takeovers[0]!, fromOwnerId: "forged-origin" }],
          },
        }; })()
        : effect),
    };
    const before = writeSignedStreamingSessionRow(path, integrityKey, forged);

    first = openSqliteStreamingSessionStore(path, integrityKey);
    const writer = getStreamingSessionStoreWriter(first);
    assert.throws(
      () => writer.apply({
        type: "takeover", sessionId: "stream-1", expectedRevision: forged.revision,
        ownerId: "owner-recovered", fencingToken: 2, newOwnerId: "owner-third", newFencingToken: 3,
        leaseExpiresAt: "2026-08-29T00:04:00.000Z", at: "2026-08-29T00:03:00.000Z",
      }),
      (error) => error instanceof StreamingSessionStoreError && error.code === "unsupported_active_version",
    );
    assert.throws(
      () => first!.store.readBySession("stream-1"),
      (error) => error instanceof StreamingSessionStoreError && error.code === "unsupported_active_version",
    );
    assert.deepEqual(readSignedStreamingSessionRow(path), before);
    first.store.close();

    reopened = openSqliteStreamingSessionStore(path, integrityKey);
    assert.throws(
      () => reopened!.store.readBySession("stream-1"),
      (error) => error instanceof StreamingSessionStoreError && error.code === "unsupported_active_version",
    );
    assert.deepEqual(readSignedStreamingSessionRow(path), before);
    reopened.store.close();
  } finally {
    try { first?.store.close(); } catch {}
    try { reopened?.store.close(); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test("upgrades cleanup-free active version-2 state only by creating independently anchored cleanup", () => {
  const source = createInMemoryStreamingSessionStore();
  const sourceWriter = getStreamingSessionStoreWriter(source);
  const pending = sourceWriter.claim(pendingTransferRecord()).record;
  const currentActive = sourceWriter.apply({
    type: "acknowledge_transfer", sessionId: "stream-1", expectedRevision: pending.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:01.000Z", effectId: "transfer-1",
  });
  const { cleanupCreationAuthority: _anchor, ...legacyActive } = currentActive;

  const store = createInMemoryStreamingSessionStore();
  const writer = getStreamingSessionStoreWriter(store);
  const active = writer.claim({ ...legacyActive, schemaVersion: 2 }).record;
  const cleaning = writer.apply({
    type: "begin_cleanup", sessionId: "stream-1", expectedRevision: active.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:02.000Z", effectId: "cleanup-1",
  });
  assert.equal(cleaning.schemaVersion, 4);
  assert.deepEqual(cleaning.cleanupCreationAuthority, {
    effectId: "cleanup-1", ownerId: "owner-1", fencingToken: 1,
    createdAt: "2026-08-29T00:00:02.000Z",
  });
  assert.deepEqual(cleaning.effects.find((effect) => effect.kind === "cleanup")?.cleanupProvenance, {
    effectId: "cleanup-1", originOwnerId: "owner-1", originFencingToken: 1, takeovers: [],
  });
  assert.equal(cleaning.effects.find((effect) => effect.kind === "cleanup")?.progress?.resources.length, 6);
});

test("keeps released version-2 cleanup history readable without making it mutable authority", () => {
  const source = createInMemoryStreamingSessionStore();
  const sourceWriter = getStreamingSessionStoreWriter(source);
  const pending = sourceWriter.claim(pendingTransferRecord()).record;
  const active = sourceWriter.apply({
    type: "acknowledge_transfer", sessionId: "stream-1", expectedRevision: pending.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:01.000Z", effectId: "transfer-1",
  });
  const cleaning = sourceWriter.apply({
    type: "begin_cleanup", sessionId: "stream-1", expectedRevision: active.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:02.000Z", effectId: "cleanup-1",
  });
  const released = verifyAndReleaseCurrentCleanup(sourceWriter, cleaning);
  const { cleanupCreationAuthority: _anchor, ...unanchoredReleased } = released;
  const historical = parseStreamingSessionRecord({
    ...unanchoredReleased,
    schemaVersion: 2,
    effects: released.effects.map((effect) => {
      const { progress: _progress, ...legacyEffect } = effect;
      return legacyEffect;
    }),
  });
  assert.equal(historical.state, "released");
  assert.equal(historical.schemaVersion, 2);
  assert.equal(historical.cleanupOwner, "none");
  assert.equal(historical.effects.find((effect) => effect.kind === "cleanup")?.status, "acknowledged");
  assert.equal(historical.cleanupCreationAuthority, undefined);
});

test("anchors multi-step cleanup takeover provenance and rejects coherent forgery", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-stream-cleanup-provenance-"));
  const path = join(root, "sessions.sqlite");
  let first: ReturnType<typeof openSqliteStreamingSessionStore> | undefined;
  let reopened: ReturnType<typeof openSqliteStreamingSessionStore> | undefined;
  try {
    first = openSqliteStreamingSessionStore(path, new Uint8Array(32).fill(9));
    const writer = getStreamingSessionStoreWriter(first);
    const pending = writer.claim(pendingTransferRecord({
      leaseExpiresAt: "2026-08-29T00:01:00.000Z",
    })).record;
    const active = writer.apply({
      type: "acknowledge_transfer", sessionId: "stream-1", expectedRevision: pending.revision,
      ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:01.000Z", effectId: "transfer-1",
    });
    const cleaning = writer.apply({
      type: "begin_cleanup", sessionId: "stream-1", expectedRevision: active.revision,
      ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:02.000Z", effectId: "cleanup-1",
    });
    const firstTakeover = writer.apply({
      type: "takeover", sessionId: "stream-1", expectedRevision: cleaning.revision,
      ownerId: "owner-1", fencingToken: 1, newOwnerId: "owner-recovered", newFencingToken: 2,
      leaseExpiresAt: "2026-08-29T00:02:00.000Z", at: "2026-08-29T00:01:00.000Z",
    });
    const takenOver = writer.apply({
      type: "takeover", sessionId: "stream-1", expectedRevision: firstTakeover.revision,
      ownerId: "owner-recovered", fencingToken: 2, newOwnerId: "owner-third", newFencingToken: 3,
      leaseExpiresAt: "2026-08-29T00:03:00.000Z", at: "2026-08-29T00:02:00.000Z",
    });
    const cleanup = takenOver.effects.find((effect) => effect.kind === "cleanup")!;
    assert.deepEqual(takenOver.cleanupCreationAuthority, {
      effectId: "cleanup-1", ownerId: "owner-1", fencingToken: 1,
      createdAt: "2026-08-29T00:00:02.000Z",
    });
    assert.equal(Object.isFrozen(takenOver.cleanupCreationAuthority), true);
    assert.deepEqual(cleanup.cleanupProvenance, {
      effectId: "cleanup-1", originOwnerId: "owner-1", originFencingToken: 1,
      takeovers: [{
        fromOwnerId: "owner-1", fromFencingToken: 1,
        toOwnerId: "owner-recovered", toFencingToken: 2,
        at: "2026-08-29T00:01:00.000Z",
      }, {
        fromOwnerId: "owner-recovered", fromFencingToken: 2,
        toOwnerId: "owner-third", toFencingToken: 3,
        at: "2026-08-29T00:02:00.000Z",
      }],
    });
    assert.equal(cleanup.fencingToken, 3);

    const { cleanupProvenance, ...withoutProvenance } = cleanup;
    const firstTransition = cleanupProvenance!.takeovers[0]!;
    const secondTransition = cleanupProvenance!.takeovers[1]!;
    const { cleanupCreationAuthority: _missingAnchor, ...withoutAnchor } = takenOver;
    assert.throws(
      () => parseStreamingSessionRecord(withoutAnchor),
      (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_record",
    );
    const variants = [
      { ...takenOver, cleanupCreationAuthority: null },
      {
        ...takenOver,
        effects: takenOver.effects.map((effect) => effect.kind === "cleanup"
          ? { ...effect, fencingToken: 1 }
          : effect),
      },
      {
        ...takenOver,
        effects: takenOver.effects.map((effect) => effect.kind === "cleanup" ? withoutProvenance : effect),
      },
      {
        ...takenOver,
        effects: takenOver.effects.map((effect) => effect.kind === "cleanup"
          ? {
            ...effect,
            cleanupProvenance: {
              ...cleanupProvenance!,
              originOwnerId: "forged-owner",
              takeovers: [{ ...firstTransition, fromOwnerId: "forged-owner" }, secondTransition],
            },
          }
          : effect),
      },
      {
        ...takenOver,
        cleanupCreationAuthority: { ...takenOver.cleanupCreationAuthority!, ownerId: "forged-owner" },
      },
      {
        ...takenOver,
        fencingToken: 4,
        effects: takenOver.effects.map((effect) => effect.kind === "cleanup"
          ? {
            ...effect,
            fencingToken: 4,
            cleanupProvenance: {
              ...cleanupProvenance!,
              originFencingToken: 2,
              takeovers: [
                { ...firstTransition, fromFencingToken: 2, toFencingToken: 3 },
                { ...secondTransition, fromFencingToken: 3, toFencingToken: 4 },
              ],
            },
          }
          : effect),
      },
      {
        ...takenOver,
        effects: takenOver.effects.map((effect) => effect.kind === "cleanup"
          ? {
            ...effect,
            cleanupProvenance: {
              ...cleanupProvenance!,
              takeovers: [firstTransition, { ...secondTransition, fromOwnerId: "wrong-owner" }],
            },
          }
          : effect),
      },
      {
        ...takenOver,
        effects: takenOver.effects.map((effect) => effect.kind === "cleanup"
          ? {
            ...effect,
            cleanupProvenance: {
              ...cleanupProvenance!,
              takeovers: [firstTransition, { ...secondTransition, fromFencingToken: 1 }],
            },
          }
          : effect),
      },
      {
        ...takenOver,
        effects: takenOver.effects.map((effect) => effect.kind === "cleanup"
          ? { ...effect, effectId: "other-cleanup" }
          : effect),
      },
    ];
    for (const variant of variants) {
      assert.throws(
        () => parseStreamingSessionRecord(variant),
        (error) => error instanceof StreamingSessionStoreError &&
          (error.code === "invalid_state" || error.code === "invalid_effect"),
      );
    }

    first.store.close();
    reopened = openSqliteStreamingSessionStore(path, new Uint8Array(32).fill(9));
    assert.deepEqual(reopened.store.readBySession("stream-1")?.effects.find((effect) => effect.kind === "cleanup"), cleanup);
    reopened.store.close();

    const database = new DatabaseSync(path);
    const row = database.prepare("SELECT record_json FROM streaming_sessions WHERE session_id = ?")
      .get("stream-1") as { record_json: string };
    const forged = JSON.parse(row.record_json) as Record<string, unknown>;
    const forgedEffects = forged.effects as Array<Record<string, unknown>>;
    const forgedCleanup = forgedEffects.find((effect) => effect.kind === "cleanup")!;
    const forgedProvenance = forgedCleanup.cleanupProvenance as Record<string, unknown>;
    const forgedTakeovers = forgedProvenance.takeovers as Array<Record<string, unknown>>;
    forgedProvenance.originOwnerId = "forged-owner";
    forgedTakeovers[0]!.fromOwnerId = "forged-owner";
    (forged.cleanupCreationAuthority as Record<string, unknown>).ownerId = "forged-owner";
    database.prepare("UPDATE streaming_sessions SET record_json = ? WHERE session_id = ?")
      .run(JSON.stringify(forged), "stream-1");
    database.close();
    const tampered = openSqliteStreamingSessionStore(path, new Uint8Array(32).fill(9));
    assert.throws(
      () => tampered.store.readBySession("stream-1"),
      (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_record",
    );
    tampered.store.close();
  } finally {
    try { first?.store.close(); } catch {}
    try { reopened?.store.close(); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test("persists fenced transfer acknowledgement through a SQLite reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-stream-store-transition-"));
  const path = join(root, "sessions.sqlite");
  let first: ReturnType<typeof openSqliteStreamingSessionStore> | undefined;
  let reopened: ReturnType<typeof openSqliteStreamingSessionStore> | undefined;
  try {
    first = openSqliteStreamingSessionStore(path, new Uint8Array(32).fill(5));
    const writer = getStreamingSessionStoreWriter(first);
    const pending = writer.claim(pendingTransferRecord()).record;
    writer.apply({
      type: "acknowledge_transfer", sessionId: "stream-1", expectedRevision: pending.revision,
      ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:01.000Z", effectId: "transfer-1",
    });
    first.store.close();
    reopened = openSqliteStreamingSessionStore(path, new Uint8Array(32).fill(5));
    assert.equal(reopened.store.readBySession("stream-1")?.state, "active");
    reopened.store.close();
  } finally {
    try { first?.store.close(); } catch {}
    try { reopened?.store.close(); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test("retains durable SQLite ownership and cleanup evidence when record capacity is full", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-stream-store-capacity-"));
  const path = join(root, "sessions.sqlite");
  let kernel: ReturnType<typeof openSqliteStreamingSessionStore> | undefined;
  try {
    kernel = openSqliteStreamingSessionStore(path, new Uint8Array(32).fill(6), { maxRecords: 1 });
    const writer = getStreamingSessionStoreWriter(kernel);
    writer.claim(pendingTransferRecord());
    assert.throws(
      () => writer.claim(pendingTransferRecord({ sessionId: "stream-2" })),
      (error) => error instanceof StreamingSessionStoreError && error.code === "capacity_exceeded",
    );
    assert.equal(kernel.store.readBySession("stream-1")?.cleanupOwner, "tool_broker");
    assert.equal(kernel.store.readBySession("stream-1")?.effects[0]?.effectId, "transfer-1");
  } finally {
    try { kernel?.store.close(); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

for (const backend of ["memory", "sqlite"] as const) for (const fault of [
  "none", "owner", "fence", "revision", "lease", "deadline", "effect", "identity", "wrong_blocker", "live_attempt",
  "missing_checkpoint", "checkpoint_revision", "checkpoint_owner", "checkpoint_fence", "checkpoint_session", "checkpoint_outcome",
  "accepted", "consuming", "unfinalized", "position", "reference", "loss",
] as const) test(`C3 round4 atomic observation ${backend} ${fault}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "c3-round4-store-"));
  t.diagnostic(`created exact fixture root: ${root}`);
  const kernel = backend === "memory" ? createInMemoryStreamingSessionStore() : openSqliteStreamingSessionStore(join(root, "sessions.sqlite"), Buffer.alloc(32, 24));
  t.after(async () => { kernel.store.close(); await rm(root, { recursive: true, force: true }); t.diagnostic(`removed exact fixture root: ${root}`); });
  const writer = getStreamingSessionKernelWriter(kernel);
  let record = claimCurrentCleanup(writer);
  for (const resource of ["workload_quiescence", "retained_output_settlement", "evidence"]) {
    record = writer.apply({ type: "begin_cleanup_resource", sessionId: record.sessionId, ownerId: record.ownerId, fencingToken: record.fencingToken,
      expectedRevision: record.revision, effectId: "cleanup-1", resource, at: "2026-08-29T00:00:03.000Z", startedAt: "2026-08-29T00:00:03.000Z", deadlineAt: "2026-08-29T00:00:30.000Z" });
    const attempt = record.effects.find((e) => e.kind === "cleanup")!.progress!.resources.find((r) => r.resource === resource)!.attempt!;
    record = writer.apply({ type: "settle_cleanup_resource", sessionId: record.sessionId, ownerId: record.ownerId, fencingToken: record.fencingToken,
      expectedRevision: record.revision, effectId: "cleanup-1", resource, attemptId: attempt.attemptId, attemptOwnerId: attempt.ownerId, attemptFencingToken: attempt.fencingToken,
      at: "2026-08-29T00:00:04.000Z", result: resource === "evidence" ? "blocked" : "verified",
      ...(resource === "evidence" ? { blocker: fault === "live_attempt" ? { code: "evidence_continuation_unavailable", message: "Durable evidence continuation is unavailable." } :
        fault === "wrong_blocker" ? { code: "channel_detach_failed", message: "Streaming channel detach failed." } :
          { code: "evidence_finalization_failed", message: "Evidence finalization failed." } } : {}),
    });
  }
  const meta = { stream: "stdout", sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1, digest: "a".repeat(64) };
  const finalized = { manifestHash: "b".repeat(64), resultHash: "c".repeat(64), legacyHead: null, lossy: false };
  const checkpoint = writer.claimOutputCheckpoint({ recordKind: "runner.output-checkpoint", schemaVersion: 2, sessionId: "stream-1", ownerId: fault === "checkpoint_owner" ? "foreign" : "owner-1", fencingToken: fault === "checkpoint_fence" ? 2 : 1,
    revision: 0, capacity: 4, outcome: fault === "checkpoint_outcome" ? "outcome_unknown" : "active",
    streams: ["stdout", "stderr"].map((stream) => ({ stream, consumed: [], lastConsumed: null,
      accepted: stream === "stdout" && (fault === "accepted" || fault === "consuming") ? [meta] : [], consumingIntent: stream === "stdout" && fault === "consuming" ? meta : null })),
    continuation: { version: 1, evidenceId: "00000000-0000-0000-0000-000000000024", head: null, pages: 0, retainedBytes: 0,
      loss: fault === "position" ? "legacy_gap" : "none", legacyHashes: [], positions: ["stdout", "stderr"].map((stream) => ({ stream,
        last: stream === "stdout" && fault === "position" ? meta : null, lostBytes: stream === "stdout" && fault === "position" ? 1 : 0 })),
      finalized: fault === "unfinalized" ? null : { ...finalized, lossy: fault === "position" } },
  }).record;
  record = kernel.store.readBySession("stream-1")!;
  const inputCheckpoint = structuredClone(checkpoint);
  if (fault === "checkpoint_revision") Object.assign(inputCheckpoint, { revision: 1 });
  if (fault === "checkpoint_owner") Object.assign(inputCheckpoint, { ownerId: "foreign" });
  if (fault === "checkpoint_fence") Object.assign(inputCheckpoint, { fencingToken: 2 });
  if (fault === "checkpoint_session") Object.assign(inputCheckpoint, { sessionId: "foreign" });
  if (fault === "reference") Object.assign(inputCheckpoint.continuation!.finalized!, { resultHash: "d".repeat(64) });
  if (fault === "loss") Object.assign(inputCheckpoint.continuation!.finalized!, { lossy: true });
  const command = { type: "observe_finalized_evidence", sessionId: "stream-1", ownerId: fault === "owner" ? "foreign" : "owner-1", fencingToken: fault === "fence" ? 2 : 1,
    expectedRevision: record.revision + (fault === "revision" ? 1 : 0), effectId: fault === "effect" ? "foreign" : "cleanup-1",
    resourceIdentity: fault === "identity" ? "foreign" : "evidence:stream-1", checkpoint: fault === "missing_checkpoint" ? undefined : inputCheckpoint,
    at: fault === "lease" ? record.leaseExpiresAt : "2026-08-29T00:00:05.000Z", deadlineAt: fault === "deadline" ? "2026-08-29T00:00:05.000Z" : "2026-08-29T00:10:00.000Z" };
  if (fault === "none") {
    const observed = writer.apply(command);
    assert.equal(observed.state, "cleanup_pending");
    assert.equal(observed.revision, record.revision + 1);
    const before = record.effects.find((e) => e.kind === "cleanup")!.progress!.resources[2]!;
    const after = observed.effects.find((e) => e.kind === "cleanup")!.progress!.resources[2]!;
    assert.equal(after.attempts, before.attempts); assert.equal(after.attempt, undefined);
    assert.deepEqual(after.evidence, { kind: "bounded_output_manifest", digest: finalized.manifestHash, lossy: false });
    assert.deepEqual(kernel.store.readOutputCheckpoint("stream-1"), checkpoint);
  } else {
    assert.throws(() => writer.apply(command), StreamingSessionStoreError);
    assert.deepEqual(kernel.store.readBySession("stream-1"), record);
    assert.deepEqual(kernel.store.readOutputCheckpoint("stream-1"), checkpoint);
  }
});
