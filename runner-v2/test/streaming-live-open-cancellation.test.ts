import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/artifact-store.js";
import { BoundedOutputSpool } from "../src/bounded-output-spool.js";
import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import { createSessionAuthority } from "../src/session-authority.js";
import { createStreamingProcessSessionRuntime, type StreamingRuntimeOptions } from "../src/streaming-process-session-runtime.js";
import { createInMemoryStreamingSessionStore, getStreamingSessionKernelWriter, openSqliteStreamingSessionStore } from "../src/streaming-session-store.js";

// Actual open/store/authority/output. Only isolation, process and channel effects
// are synthetic. No native imports, launch, signals, ports or historical roots.
const at = "2026-09-08T00:00:00.000Z";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate() {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const store of ["memory", "sqlite"] as const) {
  for (const schedule of ["held-acquire", "returned-cancel", "resolved-cancel", "failed-detach", "rejected-acquire", "takeover-acquire", "takeover-detach", "revision-detach", "deadline-detach"] as const) {
    test(`C2 round10 ${store} live open ${schedule} retains exact capability until detach`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "c2r10-"));
      t.diagnostic(`fresh synthetic live-open root acquired before effects: ${root}`);
      const path = join(root, "sessions.sqlite"); const key = Buffer.alloc(32, 61);
      let kernel = store === "memory" ? createInMemoryStreamingSessionStore() : openSqliteStreamingSessionStore(path, key);
      let currentTime = new Date(at); const clock = () => currentTime;
      let cleanupFence = { ownerId: "host:run-1", fencingToken: 1 };
      const grants = createExecutionGrantAuthority({ clock });
      const artifacts = new ArtifactStore(join(root, "artifacts"));
      const spools: BoundedOutputSpool[] = [];
      const events: string[] = [];
      const acquired = gate(); const acquireReturn = gate(); const detachEntered = gate();
      const detachReturn = gate(); const retryDetachReturn = gate();
      const abort = new AbortController();
      let detaches = 0; let reattachments = 0; let deliveries = 0;
      let output = Promise.resolve(); let outputFailure: unknown;
      let primary: unknown;
      const binding = { runId: "run-1", sessionId: "agent-1", actor: { role: "worker" as const, id: "worker-1" }, toolName: "process.start", callId: "call-1", permissionProfile: "full" as const };
      const grant = await grants.issue({ ...binding, workspacePath: root, access: [], externalApproved: false, destructiveApproved: false, networkApproved: false });
      const lease = { leaseId: "lease-1", providerId: "fake", invocationId: "invoke-1", providerIdentity: "a".repeat(64), acquiredAt: at, access: [] };
      const backend = { registryId: "registry-1", backendId: "fake", implementationGeneration: "g1", implementationDigest: "c".repeat(64), attestationVersion: 1, attestationDigest: "d".repeat(64), opaqueIdentity: "synthetic-1", birthFingerprint: { observedAt: at, discriminator: "birth-1" }, rootPid: 42, startedAt: at };
      const bytes = Buffer.from("live+suffix");
      const metadata = { stream: "stdout" as const, sequence: 1, startOffset: 0, endOffset: 11, byteLength: 11, digest: createHash("sha256").update(bytes).digest("hex") };
      const options: StreamingRuntimeOptions = {
        kernel, clock, sessions: createSessionAuthority({ grants, sessions: kernel, clock }),
        isolation: {
          acquire: async (input) => { assert.equal(input.launchId, "launch-1"); events.push("isolate"); return lease; },
          release: async (observed) => { assert.deepEqual(observed, lease); events.push("isolation-release"); },
        },
        host: {
          launch: async (input) => { assert.deepEqual(input.lease, lease); events.push("launch"); return backend; },
          quiesce: async ({ record, fence, deadlineAt }) => {
            assert.equal((record as { launchId: string }).launchId, "launch-1");
            assert.deepEqual(fence, cleanupFence);
            assert.ok(deadlineAt > clock().getTime()); events.push("quiesce"); await output; return "verified";
          },
          observeQuiescence: async () => { throw new Error("No adopted control capability is authorized"); },
          release: async () => { events.push("backend-release"); return "verified"; },
        },
        channel: {
          version: 2, replayCapacityBytes: 32, replayCapacityChunks: 4,
          acquire: (observed, fence) => {
            assert.deepEqual(observed, backend); assert.deepEqual(fence, { ownerId: "host:run-1", fencingToken: 1 });
            events.push("acquire"); acquired.resolve();
            const result = acquireReturn.promise.then(() => {
            if (schedule === "rejected-acquire") throw new Error("Synthetic original acquire rejection");
            if (schedule === "returned-cancel") abort.abort();
            events.push("original-return");
            return {
              subscribeBackpressuredOutput: () => { throw new Error("Cancelled bare capability cannot admit output"); },
              detach: async () => {
                detaches++; events.push(`original-detach-${detaches}`); detachEntered.resolve();
                await (detaches === 1 ? detachReturn.promise : retryDetachReturn.promise);
                events.push("original-detached");
              },
            };
            });
            if (schedule === "resolved-cancel") {
              // Register after runtime.open's await reaction, so cancellation
              // runs after its bare capability installation, before adoption.
              queueMicrotask(() => { void result.then(() => { events.push("resolved-cancel"); abort.abort(); }); });
            }
            return result;
          },
          reattach: async (observed, fence) => {
            assert.deepEqual(observed, backend); assert.deepEqual(fence, cleanupFence);
            reattachments++; events.push("reattach");
            return { version: 2, binding: observed, replayCapacityBytes: 32, replayCapacityChunks: 4, retainedWindow: [metadata],
              cleanupBootstrap: { version: 1, consumed: { stdout: { sequence: 0, endOffset: 0 }, stderr: { sequence: 0, endOffset: 0 } }, pendingAcknowledgements: 0 },
              channel: {
                subscribeBackpressuredOutput: (sink) => {
                  events.push("subscribe");
                  output = (async () => {
                    assert.deepEqual(await sink(metadata, bytes), metadata);
                    assert.equal(kernel.store.readOutputCheckpoint("stream-1")!.continuation!.positions[0]!.last!.sequence, 1, "durable evidence must precede ACK");
                    if (store === "sqlite") {
                      // Reopen a separate real reader at the continuation boundary
                      // without forgetting the original runtime's live effects.
                      const reader = openSqliteStreamingSessionStore(path, key);
                      try { assert.deepEqual(reader.store.readOutputCheckpoint("stream-1"), kernel.store.readOutputCheckpoint("stream-1")); }
                      finally { reader.store.close(); }
                      events.push("continuation-reopened");
                    }
                    assert.deepEqual(await artifacts.get(metadata.digest), bytes); events.push("ack");
                  })().catch((error) => { outputFailure = error; });
                  return () => { events.push("unsubscribe"); };
                },
                settleBackpressuredOutput: async () => { await output; return outputFailure ? { status: "blocked", reason: "output_unaccounted" } : { status: "settled" }; },
                detach: async () => { events.push("recovery-detached"); },
              },
            };
          },
        },
        handshake: { verify: async () => { events.push("handshake"); throw new Error("Cancelled open cannot handshake"); } },
        output: { artifacts, maxQueueBytes: 32, maxQueueChunks: 4, maxFrameBytes: 32, maxAcceptedChunks: 4, protocolStreams: ["stdout"],
          deliver: async () => { deliveries++; },
          createEvidenceSpool: () => { const spool = new BoundedOutputSpool({ spillRoot: join(root, `spool-${spools.length}`), projectRoot: root, ownershipId: "round10-synthetic", artifactStore: artifacts }); spools.push(spool); return spool; },
        },
      };
      let runtime = createStreamingProcessSessionRuntime(options);
      const opening = runtime.open({ sessionId: "stream-1", launchId: "launch-1", grant, binding, envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false }, signal: abort.signal }).then(() => { throw new Error("Cancelled launch cannot be adopted"); }, (error: unknown) => error);
      const assertBlocked = () => {
        const host = kernel.store.readHostLaunch("launch-1")!;
        assert.notEqual(host.state, "released"); assert.equal(kernel.store.readBySession("stream-1"), undefined);
        assert.equal(kernel.store.readOutputCheckpoint("stream-1"), undefined);
        assert.equal(reattachments, 0, "original acquisition/detach owns the only channel capability");
        assert.equal(events.includes("quiesce"), false, "quiescence must wait for exact channel ownership");
        assert.equal(events.includes("backend-release"), false);
      };
      const takeover = () => {
        currentTime = new Date(Date.parse(at) + 60_000);
        const host = kernel.store.readHostLaunch("launch-1")!;
        getStreamingSessionKernelWriter(kernel).transitionLaunch({ type: "takeover_cleanup", launchId: "launch-1", ownerId: host.ownerId, fencingToken: host.fencingToken, expectedRevision: host.revision,
          newOwnerId: "next", newFencingToken: 2, ownerExpiresAt: "2026-09-08T00:02:00.000Z", at: clock().toISOString() });
        cleanupFence = { ownerId: "next", fencingToken: 2 };
      };
      try {
        await acquired.promise;
        const host = kernel.store.readHostLaunch("launch-1")!;
        assert.equal(host.state, "bound"); assert.ok(host.channelAcquisitionStartedAt);
        assert.equal(kernel.store.readOutputCheckpoint("stream-1"), undefined);
        if (schedule === "returned-cancel" || schedule === "resolved-cancel") acquireReturn.resolve(); else abort.abort();
        const cancelled = await opening;
        assert.equal((cancelled as { code?: string }).code, "cancelled");
        assertBlocked();
        assert.ok(kernel.store.readHostLaunch("launch-1")!.history.some((entry) => entry.state === "cleanup_blocked"), "cancellation must durably record its unresolved effect");
        if (schedule !== "returned-cancel" && schedule !== "resolved-cancel") {
          const pending = await runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 20 });
          assert.equal(pending.outcomes[0]?.disposition, "blocked"); assertBlocked();
          if (schedule === "takeover-acquire") { takeover(); assertBlocked(); }
          acquireReturn.resolve();
        }
        if (schedule !== "rejected-acquire") {
          await detachEntered.promise; await tick(); assertBlocked();
          const held = await runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 20 });
          assert.equal(held.outcomes[0]?.disposition, "blocked"); assert.equal(detaches, 1); assertBlocked();
          if (["takeover-detach", "revision-detach", "deadline-detach"].includes(schedule)) {
            // This caller joins the retained preparation, including its original
            // deadline and revision. No competing detach may be issued.
            const predecessor = runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 1000 });
            if (schedule === "takeover-detach") takeover();
            else if (schedule === "deadline-detach") currentTime = new Date(Date.parse(at) + 2000);
            else {
              const host = kernel.store.readHostLaunch("launch-1")!;
              const failure = { code: "cleanup_timeout_or_cancelled", message: "Cleanup timed out or was cancelled." };
              getStreamingSessionKernelWriter(kernel).transitionLaunch({ type: "settle_cleanup_blocked", launchId: host.launchId, ownerId: host.ownerId, fencingToken: host.fencingToken, expectedRevision: host.revision,
                at: clock().toISOString(), blocker: failure, results: host.effects.find((effect) => effect.kind === "cleanup")!.resources!.filter((resource) => resource.status !== "succeeded").map((resource) => ({ resource: resource.resource, identity: resource.identity, ownerId: resource.ownerId, fencingToken: resource.fencingToken, status: "failed", failure })) });
            }
            assertBlocked(); detachReturn.resolve(); await predecessor; await tick();
            assertBlocked(); assert.equal(detaches, 1, "late completion cannot replace the capability or repeat detach");
          }
          if (schedule === "failed-detach") {
            const failureAttempt = runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 1000 });
            detachReturn.reject(new Error("Synthetic original detach failure"));
            assert.equal((await failureAttempt).outcomes[0]?.disposition, "blocked"); await tick();
            const channelFailure = kernel.store.readHostLaunch("launch-1")!.effects.find((effect) => effect.kind === "cleanup")!.resources!.find((resource) => resource.resource === "channel")!;
            assert.equal(channelFailure.status, "failed"); assert.equal(channelFailure.failure?.code, "channel_detach_failed");
            assert.equal(detaches, 1, "failed detach is inspectable before a later attempt retries it"); assertBlocked();
            const failed = await runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 20 });
            assert.equal(failed.outcomes[0]?.disposition, "blocked"); assertBlocked();
            assert.equal(detaches, 2, "a later bounded attempt must retry only the exact failed detach");
            retryDetachReturn.resolve();
          } else detachReturn.resolve();
        }
        await tick();
        let completed = await runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 2000 });
        if (completed.outcomes[0]?.disposition === "blocked") {
          // A call joining open's already-issued 25ms cleanup keeps that exact
          // deadline. After it settles, a distinct bounded retry can continue.
          assert.notEqual(kernel.store.readHostLaunch("launch-1")!.state, "released");
          await output; await tick();
          completed = await runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 2000 });
        }
        assert.equal(completed.outcomes[0]?.disposition ?? "cleaned", "cleaned");
        await output; assert.equal(outputFailure, undefined);
        const released = kernel.store.readHostLaunch("launch-1")!;
        assert.equal(released.state, "released"); assert.equal(reattachments, 1);
        if (schedule === "takeover-acquire") {
          assert.equal(released.outputCheckpointCreatedAt, "2026-09-08T00:01:00.000Z");
          assert.equal(released.effects.find((effect) => effect.kind === "cleanup")!.takeovers![0]!.at, released.outputCheckpointCreatedAt);
          assert.equal(clock().toISOString(), released.outputCheckpointCreatedAt, "same-time recovery must not need clock advancement");
        }
        assert.equal(detaches, schedule === "rejected-acquire" ? 0 : schedule === "failed-detach" ? 2 : 1);
        assert.equal(deliveries, 0); assert.equal(events.filter((event) => event === "ack").length, 1);
        assert.equal(events.includes("handshake"), false);
        assert.ok(events.indexOf("ack") < events.indexOf("backend-release"));
        assert.equal(kernel.store.readOutputCheckpoint("stream-1"), undefined);
        const evidence = released.effects.find((effect) => effect.kind === "cleanup")!.resources!.find((resource) => resource.resource === "output_checkpoint")!.evidence!;
        const manifest = JSON.parse((await artifacts.get(evidence.digest)).toString());
        const chunks: Buffer[] = []; let pageHash = manifest.previousHash;
        while (pageHash) { const page = JSON.parse((await artifacts.get(pageHash)).toString()); chunks.unshift(await artifacts.get(page.segmentHash)); pageHash = page.previousHash; }
        assert.equal(Buffer.concat(chunks).toString(), "live+suffix"); assert.equal(manifest.summary.loss, "none");
        if (store === "sqlite") {
          kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key);
          assert.deepEqual(kernel.store.readHostLaunch("launch-1"), released);
          runtime = createStreamingProcessSessionRuntime({ ...options, kernel, sessions: createSessionAuthority({ grants, sessions: kernel, clock }) });
          assert.deepEqual((await runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 100 })).outcomes, []);
        }
      } catch (error) { primary = error; }
      finally {
        acquireReturn.resolve(); detachReturn.resolve(); retryDetachReturn.resolve();
        const failures: unknown[] = [];
        try { await opening; await tick(); await runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 2000 }); await output; } catch (error) { failures.push(error); }
        for (const spool of spools) { try { await spool.cleanup(); } catch (error) { failures.push(error); } }
        try { kernel.store.close(); } catch (error) { failures.push(error); }
        t.diagnostic(JSON.stringify({ root, schedule, events, detaches, reattachments, spools: spools.length, finalizerFailures: failures.length, outputFailure: outputFailure instanceof Error ? outputFailure.message : null }));
        if (!primary && !failures.length && !outputFailure) {
          await rm(root, { recursive: true });
          t.diagnostic(`owned DB and ${spools.length} spools finalized/closed; successful synthetic root removed: ${root}`);
        } else t.diagnostic(`owned DB and ${spools.length} spools finalized/closed; exact failure evidence retained: ${root}`);
        if (failures.length) throw new AggregateError(primary ? [primary, ...failures] : failures, "Live-open fixture finalization failed");
      }
      if (primary) throw primary;
    });
  }
}
