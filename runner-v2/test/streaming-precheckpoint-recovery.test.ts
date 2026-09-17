import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { ArtifactStore } from "../src/artifact-store.js";
import { BoundedOutputSpool } from "../src/bounded-output-spool.js";
import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import { createSessionAuthority } from "../src/session-authority.js";
import { initialEvidenceContinuation } from "../src/evidence-continuation.js";
import { createPortableProcessChannelProvider } from "../src/portable-process-channel.js";
import { createStreamingProcessSessionRuntime, type StreamingRuntimeOptions } from "../src/streaming-process-session-runtime.js";
import { createInMemoryStreamingSessionStore, openSqliteStreamingSessionStore, getStreamingSessionKernelWriter, HOST_LAUNCH_RECORD_VERSION } from "../src/streaming-session-store.js";

// External process boundary only: no process launch, provider calls or signals.
// The unchanged missing-checkpoint branch must fail the never-initialized cases
// before reattach; the checkpoint-present controls exercise the identical bytes.
const at = "2026-09-08T00:00:00.000Z";
const clock = () => new Date(at);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const forbidden = async (): Promise<never> => { throw new Error("Unexpected execution capability in cleanup-only fixture"); };

for (const store of ["memory", "sqlite"] as const) for (const scenario of ["control", "recover", "missing-proof", "consumed-stdout", "consumed-stderr", "pending-ack", "corrupt-payload", "missing-replay", "wrong-binding", "bad-sequence", "bad-offset", "terminal-blocked", "takeover", "deadline", "revision-change", "same-runtime-retry", "fresh-runtime-retry", "detach-failed", "spool-failed"] as const) {
  const initialized = scenario === "control";
  const retry = scenario === "same-runtime-retry" || scenario === "fresh-runtime-retry";
  const positive = initialized || scenario === "recover" || retry;
  const title = retry ? scenario : positive ? `${initialized ? "checkpoint-present control" : "never-initialized recovery"} preserves exact retained and new bytes` : `rejects ${scenario}`;
  test(`C2 round9 ${store} ${title}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "c2r9-"));
    t.diagnostic(`fresh synthetic fixture retained: ${root}`);
    const path = join(root, "sessions.sqlite");
    const key = Buffer.alloc(32, 49);
    let kernel = store === "sqlite" ? openSqliteStreamingSessionStore(path, key) : createInMemoryStreamingSessionStore();
    const artifacts = new ArtifactStore(join(root, "artifacts"));
    const spools: BoundedOutputSpool[] = [];
    const events: string[] = [];
    let output = Promise.resolve();
    let outputFailure: unknown;
    let reattachments = 0;
    let currentTime = new Date(at); let attempts = 0;
    const binding = { registryId: "registry-1", backendId: "fake", implementationGeneration: "g1", implementationDigest: "c".repeat(64), attestationVersion: 1, attestationDigest: "d".repeat(64), opaqueIdentity: "synthetic-1", birthFingerprint: { observedAt: at, discriminator: "birth-1" }, rootPid: 42, startedAt: at };
    const lease = { leaseId: "lease-1", providerId: "fake", invocationId: "invoke-1", providerIdentity: "a".repeat(64), acquiredAt: at, access: [] };
    const original = Buffer.from("original");
    const suffix = Buffer.from("+suffix");
    const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 8, byteLength: 8, digest: digest(original) };
    const trailing = { stream: "stdout" as const, sequence: 2, startOffset: 8, endOffset: 15, byteLength: 7, digest: digest(suffix) };
    try {
      const writer = getStreamingSessionKernelWriter(kernel);
      writer.prepareLaunch({ recordKind: "runner.host-launch", schemaVersion: HOST_LAUNCH_RECORD_VERSION, revision: 0, launchId: "launch-1", sessionId: "stream-1", runId: "run-1", agentSessionId: "agent-1", actor: { role: "worker", id: "worker-1" }, toolName: "process.start", callId: "call-1", ownerId: "host:run-1", fencingToken: 1, ownerExpiresAt: "2026-09-08T00:01:00.000Z", state: "prepared", cleanupOwner: "host_control", history: [{ state: "prepared", at }], effects: [{ effectId: "isolate:launch-1", kind: "isolate", status: "pending", ownerId: "host:run-1", fencingToken: 1, createdAt: at }] });
      for (const [type, fields] of [["bind_isolation", { lease }], ["begin_launch", {}], ["bind_backend", { backendBinding: binding }], ["begin_channel", {}]] as const) {
        const host = kernel.store.readHostLaunch("launch-1")!;
        writer.transitionLaunch({ type, launchId: host.launchId, ownerId: host.ownerId, fencingToken: host.fencingToken, expectedRevision: host.revision, at, ...fields });
      }
      if (initialized) writer.claimHostOutputCheckpoint({ launchId: "launch-1", ownerId: "host:run-1", fencingToken: 1, expectedRevision: 4, at,
        record: { recordKind: "runner.output-checkpoint", schemaVersion: 1, revision: 0, sessionId: "stream-1", ownerId: "host:run-1", fencingToken: 1, capacity: 4, outcome: "active", streams: [
          { stream: "stdout", lastConsumed: null, consumed: [], accepted: [], consumingIntent: null },
          { stream: "stderr", lastConsumed: null, consumed: [], accepted: [], consumingIntent: null },
        ] } });
      if (store === "sqlite") { kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key); }
      assert.equal(kernel.store.readBySession("stream-1"), undefined);
      assert.equal(Boolean(kernel.store.readOutputCheckpoint("stream-1")), initialized);
      const options: StreamingRuntimeOptions = {
        kernel, clock: () => currentTime, sessions: createSessionAuthority({ grants: createExecutionGrantAuthority({ clock }), sessions: kernel, clock: () => currentTime }),
        isolation: { acquire: forbidden, release: async (observed) => { assert.deepEqual(observed, lease); events.push("isolation"); } },
        host: { launch: forbidden, observeQuiescence: forbidden,
          quiesce: async () => { events.push("quiesce"); await output; attempts++; return retry && attempts === 1 ? "blocked" : events.includes("ack2") || scenario === "missing-replay" ? "verified" : "blocked"; },
          release: async () => { events.push("release"); return "verified"; } },
        channel: { version: 2, replayCapacityBytes: 32, replayCapacityChunks: 4, acquire: forbidden,
          reattach: async (observed, fence) => {
            assert.deepEqual(observed, binding); assert.deepEqual(fence, { ownerId: "host:run-1", fencingToken: 1 });
            reattachments++; events.push("reattach");
            if (scenario === "deadline") currentTime = new Date(Date.parse(at) + 2000);
            if (scenario === "takeover" || scenario === "revision-change") {
              const host = kernel.store.readHostLaunch("launch-1")!;
              if (scenario === "takeover") currentTime = new Date(Date.parse(at) + 60_000);
              getStreamingSessionKernelWriter(kernel).transitionLaunch({ type: scenario === "takeover" ? "takeover_cleanup" : "settle_cleanup_blocked", launchId: host.launchId, ownerId: host.ownerId, fencingToken: host.fencingToken, expectedRevision: host.revision, at: currentTime.toISOString(),
                ...(scenario === "takeover" ? { newOwnerId: "next", newFencingToken: 2, ownerExpiresAt: "2026-09-08T00:02:00.000Z" } : { results: host.effects.find((effect) => effect.kind === "cleanup")!.resources!.map((fact) => ({ resource: fact.resource, identity: fact.identity, ownerId: fact.ownerId, fencingToken: fact.fencingToken, status: "failed", failure: { code: "cleanup_timeout_or_cancelled", message: "Cleanup timed out or was cancelled." } })), blocker: { code: "cleanup_timeout_or_cancelled", message: "Cleanup timed out or was cancelled." } }) });
            }
            return { version: 2, binding: scenario === "wrong-binding" ? { ...observed, rootPid: 43 } : observed, replayCapacityBytes: 32, replayCapacityChunks: 4,
              retainedWindow: [{ ...metadata, ...(scenario === "bad-sequence" ? { sequence: 2 } : {}), ...(scenario === "bad-offset" ? { startOffset: 1, endOffset: 9 } : {}) }],
              ...(scenario === "missing-proof" || scenario === "detach-failed" ? {} : { cleanupBootstrap: { version: 1 as const, consumed: { stdout: { sequence: scenario === "consumed-stdout" ? 1 : 0, endOffset: 0 }, stderr: { sequence: 0, endOffset: scenario === "consumed-stderr" ? 1 : 0 } }, pendingAcknowledgements: scenario === "pending-ack" ? 1 : 0 } }), channel: {
              subscribeBackpressuredOutput: (sink) => {
                events.push("subscribe");
                output = (async () => {
                  if (scenario === "missing-replay") return;
                  for (const [chunk, bytes] of [[metadata, original], [trailing, suffix]] as const) {
                    assert.deepEqual(await sink(chunk, scenario === "corrupt-payload" ? Buffer.alloc(bytes.length) : bytes), chunk);
                    const checkpoint = kernel.store.readOutputCheckpoint("stream-1")!;
                    assert.ok((checkpoint.continuation?.positions[0]?.last?.sequence ?? 0) >= chunk.sequence, "durable exact evidence must precede each ACK");
                    assert.deepEqual(await artifacts.get(chunk.digest), bytes);
                    events.push(`ack${chunk.sequence}`);
                  }
                })().catch((error) => { outputFailure = error; });
                return () => { events.push("unsubscribe"); };
              },
              settleBackpressuredOutput: async () => { await output; return outputFailure || scenario === "terminal-blocked" ? { status: "blocked", reason: "output_unaccounted" } : { status: "settled" }; },
              detach: async () => { events.push("detach"); if (scenario === "detach-failed" && events.filter((event) => event === "detach").length === 1) throw new Error("Synthetic exact detach failure"); },
            } };
          } },
        handshake: { verify: forbidden },
        output: { artifacts, maxQueueBytes: 32, maxQueueChunks: 4, maxFrameBytes: 32, maxAcceptedChunks: 4, protocolStreams: ["stdout"], deliver: forbidden,
          createEvidenceSpool: () => {
            if (scenario === "spool-failed") throw new Error("Synthetic spool construction failure");
            const spool = new BoundedOutputSpool({ spillRoot: join(root, `spool-${spools.length}`), projectRoot: process.cwd(), ownershipId: "round9-synthetic", artifactStore: artifacts });
            spools.push(spool); return spool;
          } },
      };
      let runtime = createStreamingProcessSessionRuntime(options);
      let result = await runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 2000 });
      if (retry) {
        assert.notEqual(kernel.store.readHostLaunch("launch-1")!.state, "released");
        if (scenario === "fresh-runtime-retry") {
          if (store === "sqlite") { kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key); }
          runtime = createStreamingProcessSessionRuntime({ ...options, kernel,
            sessions: createSessionAuthority({ grants: createExecutionGrantAuthority({ clock }), sessions: kernel, clock: () => currentTime }) });
        }
        result = await runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 2000 });
      }
      await output;
      t.diagnostic(JSON.stringify({ initialized, reattachments, events, outcomes: result.outcomes, outputFailure: outputFailure instanceof Error ? outputFailure.message : null }));
      if (!positive) {
        if (scenario === "spool-failed") {
          assert.equal(events.filter((event) => event === "detach").length, 1, "failed intake construction must dispose its exact acquired channel");
          assert.equal(kernel.store.readOutputCheckpoint("stream-1")!.streams[0]!.accepted.length, 1);
        }
        if (scenario === "detach-failed") {
          await runtime.reconcileStartup({ maxRecords: 1, timeoutMs: 2000 });
          assert.equal(reattachments, 1, "retry must retain and finish the rejected exact capability before new acquisition");
          assert.equal(events.filter((event) => event === "detach").length, 2);
        }
        assert.notEqual(kernel.store.readHostLaunch("launch-1")!.state, "released", "uncertain output must retain ownership");
        assert.equal(events.includes("release"), false, "backend release requires actual complete output evidence");
        assert.ok(result.outcomes.every((outcome) => outcome.disposition !== "cleaned"));
        return;
      }
      assert.equal(reattachments, scenario === "fresh-runtime-retry" ? 2 : 1, "legal begin_channel recovery must reach private exact reattachment");
      assert.equal(outputFailure, undefined);
      assert.deepEqual(result.outcomes, [{ launchId: "launch-1", disposition: "cleaned" }]);
      const host = kernel.store.readHostLaunch("launch-1")!;
      assert.equal(host.state, "released");
      assert.equal(kernel.store.readBySession("stream-1"), undefined);
      assert.equal(kernel.store.readOutputCheckpoint("stream-1"), undefined);
      assert.ok(events.indexOf("subscribe") < events.indexOf("quiesce"));
      assert.ok(events.indexOf("ack2") < events.indexOf("release"));
      const reference = host.effects.find((effect) => effect.kind === "cleanup")!.resources!.find((fact) => fact.resource === "output_checkpoint")!.evidence!;
      const manifest = JSON.parse((await artifacts.get(reference.digest)).toString());
      const chunks: Buffer[] = [];
      let pageHash = manifest.previousHash;
      while (pageHash) {
        const page = JSON.parse((await artifacts.get(pageHash)).toString());
        chunks.unshift(await artifacts.get(page.segmentHash)); pageHash = page.previousHash;
      }
      assert.equal(Buffer.concat(chunks).toString(), "original+suffix");
      assert.equal(manifest.summary.loss, "none", "the durable continuation must preserve all exact protocol bytes");
      const finalResult = JSON.parse((await artifacts.get(manifest.resultHash)).toString());
      assert.equal(reference.lossy, finalResult.streams.some((stream: { lossyOutput: boolean }) => stream.lossyOutput));
      t.diagnostic(JSON.stringify({ continuationLoss: manifest.summary.loss, diagnosticSpoolLoss: reference.lossy }));
    } finally {
      await output;
      for (const spool of spools) await spool.cleanup();
      kernel.store.close();
      t.diagnostic(`closed owned DB and ${spools.length} spool handles; exact DB/artifact fixture retained: ${root}`);
    }
  });
}

function prepareBootstrapHost(kernel: ReturnType<typeof createInMemoryStreamingSessionStore>) {
  const writer = getStreamingSessionKernelWriter(kernel);
  writer.prepareLaunch({ recordKind: "runner.host-launch", schemaVersion: HOST_LAUNCH_RECORD_VERSION, revision: 0, launchId: "launch-1", sessionId: "stream-1", runId: "run-1", agentSessionId: "agent-1", actor: { role: "worker", id: "worker-1" }, toolName: "process.start", callId: "call-1", ownerId: "host:run-1", fencingToken: 1, ownerExpiresAt: "2026-09-08T00:01:00.000Z", state: "prepared", cleanupOwner: "host_control", history: [{ state: "prepared", at }], effects: [{ effectId: "isolate:launch-1", kind: "isolate", status: "pending", ownerId: "host:run-1", fencingToken: 1, createdAt: at }] });
  const lease = { leaseId: "lease-1", providerId: "fake", invocationId: "invoke-1", providerIdentity: "a".repeat(64), acquiredAt: at, access: [] };
  const backendBinding = { registryId: "registry-1", backendId: "fake", implementationGeneration: "g1", implementationDigest: "c".repeat(64), attestationVersion: 1, attestationDigest: "d".repeat(64), opaqueIdentity: "synthetic-1", birthFingerprint: { observedAt: at, discriminator: "birth-1" }, rootPid: 42, startedAt: at };
  for (const [type, fields] of [["bind_isolation", { lease }], ["begin_launch", {}], ["bind_backend", { backendBinding }], ["begin_channel", {}], ["begin_cleanup", {}]] as const) {
    const host = kernel.store.readHostLaunch("launch-1")!;
    writer.transitionLaunch({ type, launchId: host.launchId, ownerId: host.ownerId, fencingToken: host.fencingToken, expectedRevision: host.revision, at, ...fields });
  }
  const host = kernel.store.readHostLaunch("launch-1")!;
  const record = { recordKind: "runner.output-checkpoint", schemaVersion: 2, revision: 0, sessionId: host.sessionId, ownerId: host.ownerId, fencingToken: host.fencingToken, capacity: 4, outcome: "active",
    streams: ["stdout", "stderr"].map((stream) => ({ stream, lastConsumed: null, consumed: [], accepted: [], consumingIntent: null })), continuation: initialEvidenceContinuation() };
  return { launchId: host.launchId, ownerId: host.ownerId, fencingToken: host.fencingToken, expectedRevision: host.revision, at, record };
}

for (const store of ["memory", "sqlite"] as const) test(`C2 round9 ${store} atomic bootstrap rejects stale and fabricated authority`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "c2r9-s-")); t.diagnostic(`fresh synthetic store fixture retained: ${root}`);
  const kernel = store === "memory" ? createInMemoryStreamingSessionStore() : openSqliteStreamingSessionStore(join(root, "sessions.sqlite"), Buffer.alloc(32, 51));
  try {
    const command = prepareBootstrapHost(kernel); const writer = getStreamingSessionKernelWriter(kernel);
    const before = kernel.store.readHostLaunch(command.launchId);
    for (const [name, changed, code] of [
      ["owner", { ownerId: "foreign" }, "stale_fence"],
      ["fence", { fencingToken: 2 }, "stale_fence"],
      ["revision", { expectedRevision: 4 }, "revision_conflict"],
      ["expired", { at: "2026-09-08T00:01:00.000Z" }, "lease_expired"],
      ["session", { record: { ...command.record, sessionId: "foreign" } }, "identity_conflict"],
      ["checkpoint-owner", { record: { ...command.record, ownerId: "foreign" } }, "identity_conflict"],
      ["checkpoint-fence", { record: { ...command.record, fencingToken: 2 } }, "identity_conflict"],
      ["historical-continuation", { record: { ...command.record, continuation: { ...command.record.continuation, legacyHashes: ["a".repeat(64)] } } }, "invalid_record"],
    ] as const) {
      assert.throws(() => writer.bootstrapHostCleanupOutputCheckpoint({ ...command, ...changed }), (error: unknown) => (error as { code?: string }).code === code, name);
      assert.deepEqual(kernel.store.readHostLaunch(command.launchId), before);
      assert.equal(kernel.store.readOutputCheckpoint(command.record.sessionId), undefined);
    }
    const first = writer.bootstrapHostCleanupOutputCheckpoint(command);
    assert.equal(first.won, true);
    assert.deepEqual(first.host.effects.find((effect) => effect.kind === "cleanup")!.resources!.slice(0, 3), before!.effects.find((effect) => effect.kind === "cleanup")!.resources);
    assert.equal(writer.bootstrapHostCleanupOutputCheckpoint({ ...command, expectedRevision: first.host.revision }).won, false);
    assert.throws(() => writer.bootstrapHostCleanupOutputCheckpoint(command), (error: unknown) => (error as { code?: string }).code === "revision_conflict");
    assert.deepEqual(kernel.store.readOutputCheckpoint(command.record.sessionId), first.record);
  } finally { kernel.store.close(); t.diagnostic(`closed exact store; retained: ${root}`); }
});

for (const boundary of ["before-output", "after-output", "before-host", "after-host"] as const) test(`C2 round9 SQLite bootstrap rollback and reopen at ${boundary}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "c2r9-t-")); t.diagnostic(`fresh synthetic transaction fixture retained: ${root}`);
  const path = join(root, "sessions.sqlite"); const key = Buffer.alloc(32, 52);
  let kernel = openSqliteStreamingSessionStore(path, key);
  try {
    const command = prepareBootstrapHost(kernel); const before = kernel.store.readHostLaunch(command.launchId);
    let db = new DatabaseSync(path);
    try { db.exec(`CREATE TRIGGER round9_interrupt ${boundary.startsWith("before") ? "BEFORE" : "AFTER"} ${boundary.endsWith("output") ? "INSERT ON streaming_output_checkpoints" : "UPDATE ON streaming_host_launches"} BEGIN SELECT RAISE(ABORT, 'round9 transaction interruption'); END`); } finally { db.close(); }
    assert.throws(() => getStreamingSessionKernelWriter(kernel).bootstrapHostCleanupOutputCheckpoint(command), /round9 transaction interruption/);
    kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key);
    assert.deepEqual(kernel.store.readHostLaunch(command.launchId), before);
    assert.equal(kernel.store.readOutputCheckpoint(command.record.sessionId), undefined);
    db = new DatabaseSync(path); try { db.exec("DROP TRIGGER round9_interrupt"); } finally { db.close(); }
    const first = getStreamingSessionKernelWriter(kernel).bootstrapHostCleanupOutputCheckpoint(command);
    kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key);
    assert.deepEqual(kernel.store.readHostLaunch(command.launchId), first.host);
    assert.deepEqual(kernel.store.readOutputCheckpoint(command.record.sessionId), first.record);
    assert.equal(getStreamingSessionKernelWriter(kernel).bootstrapHostCleanupOutputCheckpoint({ ...command, expectedRevision: first.host.revision }).won, false);
  } finally { kernel.store.close(); t.diagnostic(`closed DB; exact transaction test state retained: ${root}`); }
});

for (const scenario of ["pristine", "retired-prefix", "pending-ack", "corrupt-bytes", "missing-checkpoint", "retirement-intent"] as const) test(`C2 round9 portable private snapshot ${scenario}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "c2r9-p-")); t.diagnostic(`fresh non-native portable snapshot fixture retained: ${root}`);
  for (const directory of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, directory), { recursive: true });
  const fence = { ownerId: "synthetic-owner", fencingToken: 1 };
  const binding = { registryId: "registry-1", backendId: "fake", implementationGeneration: "g1", implementationDigest: "c".repeat(64), attestationVersion: 1, attestationDigest: "d".repeat(64), opaqueIdentity: "synthetic-1", birthFingerprint: { observedAt: at, discriminator: "birth-1" }, rootPid: 42, startedAt: at };
  const nonce = "synthetic-private";
  if (scenario !== "missing-checkpoint") writeFileSync(join(root, "channel/output-checkpoint.json"), JSON.stringify({ nonce, stdout: { sequence: scenario === "retired-prefix" ? 1 : 0, endOffset: scenario === "retired-prefix" ? 3 : 0 }, stderr: { sequence: 0, endOffset: 0 } }));
  const bytes = Buffer.from("abc");
  const metadata = { stream: "stdout", sequence: scenario === "retired-prefix" ? 2 : 1, startOffset: scenario === "retired-prefix" ? 3 : 0, endOffset: scenario === "retired-prefix" ? 6 : 3, byteLength: 3, digest: digest(bytes) };
  const name = `stdout-${String(metadata.sequence).padStart(12, "0")}.json`;
  writeFileSync(join(root, "channel/output", name), JSON.stringify({ nonce, metadata, bytes: (scenario === "corrupt-bytes" ? Buffer.from("xyz") : bytes).toString("base64") }));
  if (scenario === "pending-ack") writeFileSync(join(root, "channel/ack", name), JSON.stringify({ nonce, metadata, ...fence }));
  if (scenario === "retirement-intent") writeFileSync(join(root, "channel/output-retirement.json"), "{}");
  let snapshots = 0;
  const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 4, replayCapacityBytes: 32, pollIntervalMs: 20,
    authority: (observed, observedFence) => {
      assert.deepEqual(observed, binding); assert.deepEqual(observedFence, fence);
      return { directory: root, nonce, fence, reattest: () => "live", effect: async (_kind, effect) => effect(), snapshot: (read) => { snapshots++; return { status: "applied", value: read() }; } };
    } });
  let recovered: Awaited<ReturnType<typeof provider.reattach>> | undefined;
  try {
    if (["corrupt-bytes", "missing-checkpoint", "retirement-intent"].includes(scenario)) {
      await assert.rejects(provider.reattach(binding, fence));
    } else {
      recovered = await provider.reattach(binding, fence);
      assert.equal(snapshots, 1, "retained metadata and prefix/ACK proof must share one coherent observation");
      assert.deepEqual(recovered.retainedWindow, [metadata]);
      assert.deepEqual(recovered.cleanupBootstrap, { version: 1, consumed: { stdout: { sequence: scenario === "retired-prefix" ? 1 : 0, endOffset: scenario === "retired-prefix" ? 3 : 0 }, stderr: { sequence: 0, endOffset: 0 } }, pendingAcknowledgements: scenario === "pending-ack" ? 1 : 0 });
      assert.equal(JSON.stringify(recovered.cleanupBootstrap).includes(nonce), false);
    }
  } finally { await recovered?.channel.detach(); t.diagnostic(`no native process/timer/subscription created; channel detached when returned; exact fixture retained: ${root}`); }
});

test("C2 round9 pending acquisition and late detach remain joined across timeout retry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "c2r9-l-")); t.diagnostic(`fresh late-effect fixture retained: ${root}`);
  const kernel = openSqliteStreamingSessionStore(join(root, "sessions.sqlite"), Buffer.alloc(32, 53));
  prepareBootstrapHost(kernel);
  let currentTime = new Date(at); let acquisitions = 0; let detaches = 0; let subscriptions = 0;
  let returnChannel!: () => void; const acquisition = new Promise<void>((resolve) => { returnChannel = resolve; });
  let completeDetach!: () => void; const detach = new Promise<void>((resolve) => { completeDetach = resolve; });
  let enteredDetach!: () => void; const detaching = new Promise<void>((resolve) => { enteredDetach = resolve; });
  const runtime = createStreamingProcessSessionRuntime({ kernel, clock: () => currentTime,
    sessions: createSessionAuthority({ grants: createExecutionGrantAuthority({ clock }), sessions: kernel, clock: () => currentTime }),
    isolation: { acquire: forbidden, release: async () => undefined },
    host: { launch: forbidden, quiesce: forbidden, observeQuiescence: forbidden, release: forbidden }, handshake: { verify: forbidden },
    channel: { version: 2, replayCapacityChunks: 4, replayCapacityBytes: 32, acquire: forbidden, reattach: async (binding) => {
      acquisitions++; await acquisition;
      return { version: 2, binding, replayCapacityChunks: 4, replayCapacityBytes: 32, retainedWindow: [], cleanupBootstrap: { version: 1, consumed: { stdout: { sequence: 0, endOffset: 0 }, stderr: { sequence: 0, endOffset: 0 } }, pendingAcknowledgements: 0 },
        channel: { subscribeBackpressuredOutput: () => { subscriptions++; return () => undefined; }, detach: async () => { detaches++; enteredDetach(); await detach; } } };
    } }, output: { maxQueueBytes: 32, maxQueueChunks: 4, maxFrameBytes: 32, maxAcceptedChunks: 4, protocolStreams: ["stdout"], deliver: forbidden, createEvidenceSpool: () => { throw new Error("Late expired acquisition cannot install evidence intake"); } } });
  try {
    const first = await runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 20 });
    assert.equal(first.outcomes[0]?.disposition, "blocked");
    const retry = runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 20 });
    assert.equal(acquisitions, 1);
    currentTime = new Date(Date.parse(at) + 2000); returnChannel(); await detaching;
    const joined = await retry;
    assert.equal(joined.outcomes[0]?.disposition, "blocked");
    assert.equal(acquisitions, 1); assert.equal(detaches, 1); assert.equal(subscriptions, 0);
    assert.equal(kernel.store.readOutputCheckpoint("stream-1"), undefined);
    assert.notEqual(kernel.store.readHostLaunch("launch-1")!.state, "released");
    completeDetach(); await detach; await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(kernel.store.readOutputCheckpoint("stream-1"), undefined);
  } finally { returnChannel(); completeDetach(); await detach; await new Promise<void>((resolve) => setImmediate(resolve)); kernel.store.close(); t.diagnostic(`late acquisition/detach joined and DB closed; exact fixture retained: ${root}`); }
});

for (const scenario of ["marker-without-row", "row-without-marker", "foreign-row-without-marker", "session-already-exists"] as const) test(`C2 round9 SQLite refuses contradictory ${scenario}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "c2r9-c-")); t.diagnostic(`fresh contradictory-authority fixture retained: ${root}`);
  const path = join(root, "sessions.sqlite"); const key = Buffer.alloc(32, 54);
  const kernel = openSqliteStreamingSessionStore(path, key);
  try {
    const command = prepareBootstrapHost(kernel); const writer = getStreamingSessionKernelWriter(kernel);
    let revision = command.expectedRevision;
    if (scenario === "session-already-exists") {
      const host = kernel.store.readHostLaunch(command.launchId)!;
      writer.claim({ recordKind: "runner.streaming-session", schemaVersion: 3, revision: 0, sessionId: host.sessionId, ownerId: "adopting-owner", fencingToken: 1, leaseExpiresAt: "2026-09-08T00:05:00.000Z", runId: host.runId, agentSessionId: host.agentSessionId, actor: host.actor, toolName: host.toolName, callId: host.callId, envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false }, lease: host.leaseBinding, backendBinding: host.backendBinding, cleanupCreationAuthority: null, cleanupOwner: "tool_broker", state: "pending_transfer", history: [{ state: "pending_transfer", at }], effects: [{ effectId: "transfer-1", kind: "transfer", status: "pending", owner: "tool_broker", fencingToken: 1, createdAt: at }] });
      const active = writer.apply({ type: "acknowledge_transfer", sessionId: host.sessionId, expectedRevision: 0, ownerId: "adopting-owner", fencingToken: 1, at, effectId: "transfer-1" });
      assert.equal(active.state, "active"); assert.equal(active.cleanupOwner, "session_authority");
    } else {
      if (scenario === "marker-without-row") revision = writer.bootstrapHostCleanupOutputCheckpoint(command).host.revision;
      const db = new DatabaseSync(path);
      try {
        if (scenario === "marker-without-row") db.exec("DELETE FROM streaming_output_checkpoints");
        else {
          const record = { ...command.record, ...(scenario === "foreign-row-without-marker" ? { ownerId: "foreign" } : {}) };
          const json = JSON.stringify(record); const integrity = createHmac("sha256", key).update(json).digest("hex");
          db.prepare("INSERT INTO streaming_output_checkpoints(session_id, record_json, integrity, revision) VALUES (?, ?, ?, 0)").run(record.sessionId, json, integrity);
        }
      } finally { db.close(); }
    }
    assert.throws(() => writer.bootstrapHostCleanupOutputCheckpoint({ ...command, expectedRevision: revision }), (error: unknown) => ["identity_conflict", "invalid_state"].includes((error as { code: string }).code));
    if (scenario === "row-without-marker" || scenario === "foreign-row-without-marker") assert.throws(() => kernel.store.readHostLaunch(command.launchId));
    else assert.notEqual(kernel.store.readHostLaunch(command.launchId)!.state, "released");
  } finally { kernel.store.close(); t.diagnostic(`closed exact deliberately contradictory test DB; no repair/deletion of fixture root: ${root}`); }
});
