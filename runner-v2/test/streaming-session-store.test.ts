import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  StreamingSessionStoreError,
  createInMemoryStreamingSessionStore,
  digestStreamingSessionRecord,
  getStreamingSessionStoreWriter,
  openSqliteStreamingSessionStore,
  parseStreamingSessionRecord,
} from "../src/streaming-session-store.js";

function pendingTransferRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    recordKind: "runner.streaming-session",
    schemaVersion: 1,
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

test("rejects unknown fields on a durable pending-transfer session record", () => {
  assert.throws(
    () => parseStreamingSessionRecord({ ...pendingTransferRecord(), unknown: true }),
    (error) => error instanceof StreamingSessionStoreError && error.code === "unknown_field",
  );
});

test("rejects a pending-transfer record without its exact pending transfer effect", () => {
  assert.throws(
    () => parseStreamingSessionRecord(pendingTransferRecord({ effects: [] })),
    (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_state",
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
    (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_state",
  );
  const released = writer.apply({
    type: "acknowledge_cleanup", sessionId: "stream-1", expectedRevision: cleaning.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:03.000Z", effectId: "cleanup-1",
  });
  for (const owner of ["tool_broker", "provider_lease"] as const) {
    assert.throws(
      () => parseStreamingSessionRecord({
        ...released,
        effects: released.effects.map((effect) => effect.kind === "cleanup"
          ? { ...effect, owner }
          : effect),
      }),
      (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_state",
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
    () => parseStreamingSessionRecord(pendingTransferRecord({ schemaVersion: 2 })),
    (error) => error instanceof StreamingSessionStoreError && error.code === "unsupported_active_version",
  );
});

test("refuses an active record that tries to downgrade to the historical schema", () => {
  assert.throws(
    () => parseStreamingSessionRecord(pendingTransferRecord({ schemaVersion: 0 })),
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
  const released = writer.apply({
    type: "acknowledge_cleanup", sessionId: "stream-1", expectedRevision: cleaning.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:03.000Z", effectId: "cleanup-1",
  });
  assert.throws(
    () => parseStreamingSessionRecord({ ...released, schemaVersion: 2 }),
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
  const released = writer.apply({
    type: "acknowledge_cleanup", sessionId: "stream-1", expectedRevision: cleaning.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:03.000Z", effectId: "cleanup-1",
  });
  assert.equal(parseStreamingSessionRecord({ ...released, schemaVersion: 0 }).schemaVersion, 0);
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
  const cleaning = sourceWriter.apply({
    type: "begin_cleanup", sessionId: "stream-1", expectedRevision: active.revision,
    ownerId: "owner-1", fencingToken: 1, at: "2026-08-29T00:00:02.000Z", effectId: "cleanup-1",
  });
  const assertInitialClaimCap = (kernel: ReturnType<typeof createInMemoryStreamingSessionStore>) => {
    const writer = getStreamingSessionStoreWriter(kernel);
    writer.claim(active);
    assert.throws(
      () => writer.claim({ ...cleaning, sessionId: "stream-2" }),
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
      leaseExpiresAt: "2026-08-29T00:03:00.000Z", at: "2026-08-29T00:02:00.000Z",
    }),
    (error) => error instanceof StreamingSessionStoreError && error.code === "invalid_state",
  );
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
