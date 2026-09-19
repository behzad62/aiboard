import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { initialEvidenceContinuation } from "../src/evidence-continuation.js";
import { createInMemoryStreamingSessionStore, getStreamingSessionKernelWriter, openSqliteStreamingSessionStore, parseHostLaunchRecord, type HostLaunchRecord, type HostLaunchState } from "../src/streaming-session-store.js";

// Real store commands and authentication only; no runtime/native effects.
const start = "2026-09-08T00:00:00.000Z";
const channelAt = "2026-09-08T00:00:00.001Z";
const checkpointAt = "2026-09-08T00:00:00.002Z";
const takeoverAt = "2026-09-08T00:01:00.000Z";
const nextExpiry = "2026-09-08T00:02:00.000Z";
const failure = { code: "cleanup_timeout_or_cancelled", message: "Cleanup timed out or was cancelled." };
type Kernel = ReturnType<typeof createInMemoryStreamingSessionStore>;
type StoreKind = "memory" | "sqlite";

async function fixture(t: TestContext, store: StoreKind, run: (fixture: { kernel: Kernel; path: string; reopen: () => void }) => void) {
  const root = await mkdtemp(join(tmpdir(), "c2r11-history-"));
  t.diagnostic(`fresh synthetic history root acquired before store open: ${root}`);
  const path = join(root, "sessions.sqlite"); const key = Buffer.alloc(32, 71);
  const context = {
    path, kernel: store === "memory" ? createInMemoryStreamingSessionStore() : openSqliteStreamingSessionStore(path, key),
    reopen: () => { if (store === "sqlite") { context.kernel.store.close(); context.kernel = openSqliteStreamingSessionStore(path, key); } },
  };
  let passed = false;
  try { run(context); passed = true; }
  finally {
    context.kernel.store.close();
    if (passed) { await rm(root, { recursive: true }); t.diagnostic(`store handles closed; successful synthetic root removed: ${root}`); }
    else t.diagnostic(`store handles closed; exact failure evidence retained: ${root}`);
  }
}

function transition(kernel: Kernel, type: string, fields: Record<string, unknown> = {}, at = channelAt) {
  const host = kernel.store.readHostLaunch("launch-1")!;
  getStreamingSessionKernelWriter(kernel).transitionLaunch({ type, launchId: host.launchId, ownerId: host.ownerId, fencingToken: host.fencingToken, expectedRevision: host.revision, at, ...fields });
  return kernel.store.readHostLaunch(host.launchId)!;
}

function checkpoint(host: Readonly<HostLaunchRecord>) {
  return { recordKind: "runner.output-checkpoint", schemaVersion: 2, revision: 0, sessionId: host.sessionId, ownerId: host.ownerId, fencingToken: host.fencingToken, capacity: 4, outcome: "active",
    streams: ["stdout", "stderr"].map((stream) => ({ stream, lastConsumed: null, consumed: [], accepted: [], consumingIntent: null })), continuation: initialEvidenceContinuation() };
}

function bootstrapCommand(host: Readonly<HostLaunchRecord>, at = takeoverAt) {
  return { launchId: host.launchId, ownerId: host.ownerId, fencingToken: host.fencingToken, expectedRevision: host.revision, at, record: checkpoint(host) };
}

function prepare(kernel: Kernel, state: HostLaunchState) {
  const writer = getStreamingSessionKernelWriter(kernel);
  writer.prepareLaunch({ recordKind: "runner.host-launch", schemaVersion: 2, revision: 0, launchId: "launch-1", sessionId: "stream-1", runId: "run-1", agentSessionId: "agent-1", actor: { role: "worker", id: "worker-1" }, toolName: "process.start", callId: "call-1", ownerId: "host:run-1", fencingToken: 1, ownerExpiresAt: takeoverAt, state: "prepared", cleanupOwner: "host_control", history: [{ state: "prepared", at: start }], effects: [{ effectId: "isolate:launch-1", kind: "isolate", status: "pending", ownerId: "host:run-1", fencingToken: 1, createdAt: start }] });
  if (state === "prepared") return;
  transition(kernel, "bind_isolation", { lease: { leaseId: "lease-1", providerId: "fake", invocationId: "invoke-1", providerIdentity: "a".repeat(64), acquiredAt: start, access: [] } }, start);
  if (state === "isolated") return;
  transition(kernel, "begin_launch", {}, start);
  if (state === "launching") return;
  transition(kernel, "bind_backend", { backendBinding: { registryId: "registry-1", backendId: "fake", implementationGeneration: "g1", implementationDigest: "c".repeat(64), attestationVersion: 1, attestationDigest: "d".repeat(64), opaqueIdentity: "synthetic-1", birthFingerprint: { observedAt: start, discriminator: "birth-1" }, rootPid: 42, startedAt: start } }, start);
  transition(kernel, "begin_channel");
  if (state === "bound") return;
  if (state === "handshake_verified") {
    writer.claimHostOutputCheckpoint(bootstrapCommand(kernel.store.readHostLaunch("launch-1")!, checkpointAt));
    transition(kernel, "verify_handshake", { handshakeDigest: "e".repeat(64) }, checkpointAt);
    return;
  }
  transition(kernel, "begin_cleanup");
  if (state === "cleanup_blocked") {
    const host = kernel.store.readHostLaunch("launch-1")!;
    transition(kernel, "settle_cleanup_blocked", { blocker: failure, results: host.effects.find((effect) => effect.kind === "cleanup")!.resources!.map((resource) => ({ resource: resource.resource, identity: resource.identity, ownerId: resource.ownerId, fencingToken: resource.fencingToken, status: "failed", failure })) });
  }
}

function takeover(kernel: Kernel) {
  return transition(kernel, "takeover_cleanup", { newOwnerId: "next", newFencingToken: 2, ownerExpiresAt: nextExpiry }, takeoverAt);
}

for (const store of ["memory", "sqlite"] as const) {
  for (const source of ["prepared", "isolated", "launching", "bound", "handshake_verified", "cleanup_pending", "cleanup_blocked"] as const) {
    test(`C2 round11 ${store} takeover from ${source} consumes its actual history edge`, async (t) => fixture(t, store, (f) => {
      prepare(f.kernel, source);
      const before = f.kernel.store.readHostLaunch("launch-1")!;
      f.reopen(); assert.deepEqual(f.kernel.store.readHostLaunch("launch-1"), before, "existing authenticated row remains readable");
      const taken = takeover(f.kernel);
      assert.deepEqual(taken.history.slice(-2), [{ state: source, at: before.history.at(-1)!.at }, { state: "cleanup_pending", at: takeoverAt }]);
      assert.equal(taken.ownerId, "next"); assert.equal(taken.fencingToken, 2);
      assert.deepEqual(taken.effects.find((effect) => effect.kind === "cleanup")!.takeovers, [{ fromOwnerId: "host:run-1", fromFencingToken: 1, toOwnerId: "next", toFencingToken: 2, at: takeoverAt }]);
      let expected = taken;
      if (source === "bound" || source === "cleanup_pending" || source === "cleanup_blocked") {
        const result = getStreamingSessionKernelWriter(f.kernel).bootstrapHostCleanupOutputCheckpoint(bootstrapCommand(taken));
        assert.equal(result.won, true); expected = result.host;
        assert.equal(result.host.outputCheckpointCreatedAt, takeoverAt);
        assert.deepEqual(result.host.history.slice(-2), [{ state: "cleanup_pending", at: takeoverAt }, { state: "cleanup_pending", at: takeoverAt }]);
        assert.deepEqual(f.kernel.store.readOutputCheckpoint("stream-1"), result.record);
        assert.equal(result.host.effects.find((effect) => effect.kind === "cleanup")!.resources!.find((resource) => resource.resource === "output_checkpoint")!.status, "pending");
      }
      f.reopen(); assert.deepEqual(f.kernel.store.readHostLaunch("launch-1"), expected);
      if (expected.outputCheckpointCreatedAt) assert.ok(f.kernel.store.readOutputCheckpoint("stream-1"));
      assert.equal(f.kernel.store.readBySession("stream-1"), undefined);
    }));
  }

  test(`C2 round11 ${store} same-time bootstrap rejects stale authority without half writes`, async (t) => fixture(t, store, (f) => {
    prepare(f.kernel, "cleanup_blocked"); const taken = takeover(f.kernel); const command = bootstrapCommand(taken);
    for (const [name, changed, code] of [
      ["owner", { ownerId: "host:run-1" }, "stale_fence"],
      ["fence", { fencingToken: 1 }, "stale_fence"],
      ["revision", { expectedRevision: taken.revision - 1 }, "revision_conflict"],
      ["expiry", { at: nextExpiry }, "lease_expired"],
      ["backward-time", { at: "2026-09-08T00:00:59.999Z" }, "invalid_state"],
    ] as const) {
      assert.throws(() => getStreamingSessionKernelWriter(f.kernel).bootstrapHostCleanupOutputCheckpoint({ ...command, ...changed }), (error: unknown) => (error as { code?: string }).code === code, name);
      f.reopen(); assert.deepEqual(f.kernel.store.readHostLaunch("launch-1"), taken); assert.equal(f.kernel.store.readOutputCheckpoint("stream-1"), undefined);
    }
    const result = getStreamingSessionKernelWriter(f.kernel).bootstrapHostCleanupOutputCheckpoint(command);
    assert.equal(result.won, true);
    f.reopen(); assert.deepEqual(f.kernel.store.readHostLaunch("launch-1"), result.host); assert.deepEqual(f.kernel.store.readOutputCheckpoint("stream-1"), result.record);
  }));

  test(`C2 round11 ${store} marker and takeover history cannot be missing or misclassified`, async (t) => fixture(t, store, (f) => {
    prepare(f.kernel, "cleanup_blocked"); const taken = takeover(f.kernel);
    // Distinct-time valid control isolates malformed-history rejection even on
    // the pre-fix parser, independently of the positive same-time regression.
    const valid = getStreamingSessionKernelWriter(f.kernel).bootstrapHostCleanupOutputCheckpoint(bootstrapCommand(taken, "2026-09-08T00:01:00.001Z")).host;
    const variants: Array<[string, unknown]> = [
      ["missing-channel-marker", { ...valid, revision: valid.revision - 1, history: valid.history.filter((_, index) => index !== 4) }],
      ["missing-checkpoint-marker", { ...valid, revision: valid.revision - 1, history: valid.history.slice(0, -1) }],
      ["impossible-marker-edge", { ...valid, history: valid.history.map((entry, index) => index === valid.history.length - 2 ? { ...entry, state: "isolated" } : entry) }],
      ["out-of-order-markers", { ...valid, channelAcquisitionStartedAt: valid.outputCheckpointCreatedAt, outputCheckpointCreatedAt: valid.channelAcquisitionStartedAt }],
      ["nonmonotonic-history", { ...valid, history: valid.history.map((entry, index) => index === valid.history.length - 1 ? { ...entry, at: start } : entry) }],
      ...(["unmatched-takeover", "foreign-origin", "skipped-fence"] as const).map((name): [string, unknown] => [name, { ...valid, effects: valid.effects.map((effect) => effect.kind === "cleanup" ? { ...effect, takeovers: effect.takeovers!.map((entry) => ({ ...entry, ...(name === "unmatched-takeover" ? { at: "2026-09-08T00:01:00.002Z" } : name === "foreign-origin" ? { fromOwnerId: "foreign" } : { toFencingToken: 3 }) })) } : effect) }]),
    ];
    const second = transition(f.kernel, "takeover_cleanup", { newOwnerId: "next-2", newFencingToken: 3, ownerExpiresAt: "2026-09-08T00:03:00.000Z" }, nextExpiry);
    assert.equal(second.ownerId, "next-2"); assert.equal(second.fencingToken, 3);
    variants.push(["out-of-order-takeovers", { ...second, effects: second.effects.map((effect) => effect.kind === "cleanup" ? { ...effect, takeovers: effect.takeovers!.map((entry, index) => ({ ...entry, at: index === 0 ? nextExpiry : takeoverAt })) } : effect) }]);
    const accepted: string[] = [];
    for (const [name, value] of variants) {
      try { parseHostLaunchRecord(value); accepted.push(name); }
      catch (error) { assert.ok(["invalid_state", "invalid_effect"].includes((error as { code: string }).code), name); }
    }
    assert.deepEqual(accepted, [], "malformed histories must not be accepted");
    f.reopen(); assert.deepEqual(f.kernel.store.readHostLaunch("launch-1"), second);
  }));
}

for (const boundary of ["before-output", "after-output", "before-host", "after-host"] as const) {
  test(`C2 round11 SQLite same-time bootstrap rolls back at ${boundary}`, async (t) => fixture(t, "sqlite", (f) => {
    prepare(f.kernel, "cleanup_blocked"); const taken = takeover(f.kernel); const command = bootstrapCommand(taken);
    let db = new DatabaseSync(f.path);
    try { db.exec(`CREATE TRIGGER round11_interrupt ${boundary.startsWith("before") ? "BEFORE" : "AFTER"} ${boundary.endsWith("output") ? "INSERT ON streaming_output_checkpoints" : "UPDATE ON streaming_host_launches"} BEGIN SELECT RAISE(ABORT, 'round11 transaction interruption'); END`); }
    finally { db.close(); }
    assert.throws(() => getStreamingSessionKernelWriter(f.kernel).bootstrapHostCleanupOutputCheckpoint(command), /round11 transaction interruption/);
    f.reopen(); assert.deepEqual(f.kernel.store.readHostLaunch("launch-1"), taken); assert.equal(f.kernel.store.readOutputCheckpoint("stream-1"), undefined);
    db = new DatabaseSync(f.path); try { db.exec("DROP TRIGGER round11_interrupt"); } finally { db.close(); }
    const result = getStreamingSessionKernelWriter(f.kernel).bootstrapHostCleanupOutputCheckpoint(command);
    f.reopen(); assert.deepEqual(f.kernel.store.readHostLaunch("launch-1"), result.host); assert.deepEqual(f.kernel.store.readOutputCheckpoint("stream-1"), result.record);
  }));
}
