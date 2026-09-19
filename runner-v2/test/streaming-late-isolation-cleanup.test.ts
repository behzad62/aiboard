import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import { createSessionAuthority } from "../src/session-authority.js";
import { createStreamingProcessSessionRuntime, type StreamingRuntimeOptions } from "../src/streaming-process-session-runtime.js";
import { createInMemoryStreamingSessionStore, openSqliteStreamingSessionStore } from "../src/streaming-session-store.js";

const at = "2026-09-11T00:00:00.000Z";
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Real runtime, grants, authority and both durable stores; all resource effects
// are synthetic gates. No OS workload, port, channel or provider is launched.
for (const store of ["memory", "sqlite"] as const) {
  for (const schedule of ["during-host-cleanup", "after-caller-timeout", "release-retry"] as const) {
    test(`C2 round12 ${store} late isolation ${schedule} binds before terminal release`, { timeout: 5_000 }, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "c2r12-"));
      t.diagnostic(`new synthetic lease fixture acquired: ${root}`);
      const path = join(root, "sessions.sqlite");
      const key = Buffer.alloc(32, 73);
      let kernel = store === "sqlite" ? openSqliteStreamingSessionStore(path, key) : createInMemoryStreamingSessionStore();
      const clock = () => new Date(at);
      const grants = createExecutionGrantAuthority({ clock });
      const binding = { runId: "run-1", sessionId: "agent-1", actor: { role: "worker" as const, id: "worker-1" }, toolName: "process.start", callId: "call-1", permissionProfile: "full" as const };
      const grant = await grants.issue({ ...binding, workspacePath: root, access: [], externalApproved: false, destructiveApproved: false, networkApproved: false });
      const lease = { leaseId: "late-lease", providerId: "fake", invocationId: "late-invoke", providerIdentity: "a".repeat(64), acquiredAt: at, access: [] };
      const acquisitionEntered = gate(); const acquisitionReturn = gate();
      const quiescenceEntered = gate(); const quiescenceReturn = gate();
      const releaseReturn = gate();
      const events: string[] = [];
      let acquireCalls = 0; let quiesceCalls = 0; let backendReleaseCalls = 0;
      let releaseCalls = 0; let successfulReleases = 0; let activeReleases = 0;
      const abort = new AbortController();
      const options: StreamingRuntimeOptions = {
        kernel, clock, sessions: createSessionAuthority({ grants, sessions: kernel, clock }),
        isolation: {
          acquire: async () => {
            acquireCalls++; events.push("acquire-entered"); acquisitionEntered.resolve();
            await acquisitionReturn.promise; events.push("acquire-returned"); return lease;
          },
          release: async (observed) => {
            assert.deepEqual(observed, lease);
            const durable = kernel.store.readHostLaunch("launch-1")!;
            assert.deepEqual(durable.leaseBinding, lease, "the acquired lease is durable before its release effect");
            const fact = durable.effects.find((effect) => effect.kind === "cleanup")!.resources!.find((resource) => resource.resource === "isolation_lease")!;
            assert.ok(fact, "the exact lease is in the durable cleanup work item");
            assert.equal(fact.identity, `lease:${createHash("sha256").update(JSON.stringify(lease)).digest("hex")}`);
            assert.equal(fact.ownerId, durable.ownerId); assert.equal(fact.fencingToken, durable.fencingToken);
            assert.notEqual(durable.state, "released");
            releaseCalls++; activeReleases++; events.push("lease-release-entered");
            try {
              assert.equal(activeReleases, 1, "a bounded caller cannot overlap the retained release effect");
              await releaseReturn.promise;
              if (schedule === "release-retry" && releaseCalls === 1) throw new Error("controlled lease release failure");
              successfulReleases++; events.push("lease-released");
            } finally { activeReleases--; }
          },
        },
        host: {
          launch: async () => assert.fail("cancelled isolation must not launch a workload"),
          quiesce: async ({ fence }) => {
            assert.deepEqual(fence, { ownerId: "host:run-1", fencingToken: 1 });
            quiesceCalls++; events.push("quiesce-entered"); quiescenceEntered.resolve();
            await quiescenceReturn.promise; events.push("quiesced"); return "verified";
          },
          observeQuiescence: async () => assert.fail("no adopted capability exists"),
          release: async () => { backendReleaseCalls++; events.push("backend-released"); return "verified"; },
        },
        channel: { version: 2, replayCapacityBytes: 16, replayCapacityChunks: 4, acquire: async () => assert.fail("no channel may be acquired") },
        handshake: { verify: async () => assert.fail("cancelled isolation cannot handshake") },
        output: { maxQueueBytes: 16, maxQueueChunks: 4, maxFrameBytes: 16, maxAcceptedChunks: 4, protocolStreams: ["stdout"],
          createEvidenceSpool: () => assert.fail("no output was acquired"), deliver: async () => assert.fail("no output may be delivered") },
      };
      let runtime = createStreamingProcessSessionRuntime(options);
      let failed = false; let primary: unknown;
      const started = performance.now();
      const opening = runtime.open({ sessionId: "stream-1", launchId: "launch-1", grant, binding,
        envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false }, signal: abort.signal })
        .then(() => assert.fail("cancelled launch cannot be adopted"), (error: unknown) => error);
      try {
        await acquisitionEntered.promise; abort.abort(); await quiescenceEntered.promise;
        assert.equal(kernel.store.readHostLaunch("launch-1")!.state, "cleanup_pending");
        assert.equal(kernel.store.readHostLaunch("launch-1")!.leaseBinding, undefined);
        if (schedule === "after-caller-timeout") {
          assert.equal((await opening as { code: string }).code, "cancelled");
          assert.ok(performance.now() - started < 1_000, "the caller must not wait for the provider or cleanup gates");
          assert.equal(kernel.store.readHostLaunch("launch-1")!.state, "cleanup_blocked");
        }
        acquisitionReturn.resolve();
        // Drain the provider's promise reactions without releasing host cleanup.
        for (let i = 0; i < 12; i++) await Promise.resolve();
        assert.ok(events.includes("acquire-returned"));
        assert.equal(successfulReleases, 0);
        quiescenceReturn.resolve();
        assert.equal((await opening as { code: string }).code, "cancelled");
        await turn();
        const pending = kernel.store.readHostLaunch("launch-1")!;
        assert.deepEqual(pending.leaseBinding, lease, "late acquisition cannot disappear behind host-only terminal cleanup");
        assert.notEqual(pending.state, "released", "a held lease release must block terminal release");
        assert.equal(kernel.store.readBySession("stream-1"), undefined);
        assert.equal(acquireCalls, 1); assert.equal(releaseCalls, 1);
        const held = await runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 30 });
        assert.equal(held.outcomes[0]?.disposition, "blocked");
        assert.equal(releaseCalls, 1, "recovery joins the retained release, never repeats it");
        releaseReturn.resolve(); await turn();
        if (schedule === "release-retry") {
          const blocked = kernel.store.readHostLaunch("launch-1")!;
          assert.equal(blocked.state, "cleanup_blocked");
          assert.deepEqual(blocked.leaseBinding, lease);
          assert.equal(blocked.effects.find((effect) => effect.kind === "cleanup")!.resources!.find((resource) => resource.resource === "isolation_lease")!.status, "failed");
          if (store === "sqlite") { kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key); }
          runtime = createStreamingProcessSessionRuntime({ ...options, kernel, sessions: createSessionAuthority({ grants, sessions: kernel, clock }) });
        }
        await runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 1_000 });
        const released = kernel.store.readHostLaunch("launch-1")!;
        assert.equal(released.state, "released");
        assert.ok(released.effects.find((effect) => effect.kind === "cleanup")!.resources!.every((resource) => resource.status === "succeeded"));
        assert.equal(releaseCalls, schedule === "release-retry" ? 2 : 1); assert.equal(successfulReleases, 1);
        assert.equal(quiesceCalls, 1); assert.equal(backendReleaseCalls, 1);
        assert.equal(kernel.store.readOutputCheckpoint("stream-1"), undefined);
        if (store === "sqlite") { kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key); }
        const fresh = createStreamingProcessSessionRuntime({ ...options, kernel, sessions: createSessionAuthority({ grants, sessions: kernel, clock }) });
        runtime = fresh; // Finalization must use the reopened store, not its closed predecessor.
        assert.deepEqual((await fresh.reconcileStartup({ maxRecords: 4, timeoutMs: 100 })).outcomes, []);
        assert.deepEqual(kernel.store.readHostLaunch("launch-1"), released);
        assert.equal(successfulReleases, 1); assert.equal(backendReleaseCalls, 1);
      } catch (error) { failed = true; primary = error; }
      finally {
        acquisitionReturn.resolve(); quiescenceReturn.resolve(); releaseReturn.resolve();
        const finalizerFailures: unknown[] = [];
        try { await opening; await turn(); await runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 1_000 }); } catch (error) { finalizerFailures.push(error); }
        t.diagnostic(JSON.stringify({ root, store, schedule, events, acquireCalls, quiesceCalls, backendReleaseCalls, releaseCalls, successfulReleases, finalState: kernel.store.readHostLaunch("launch-1")?.state, finalizerFailures: finalizerFailures.length }));
        try { kernel.store.close(); } catch (error) { finalizerFailures.push(error); }
        if (!failed && finalizerFailures.length === 0) { await rm(root, { recursive: true }); t.diagnostic(`closed synthetic store; exact successful root removed: ${root}`); }
        else t.diagnostic(`closed synthetic store; failure evidence retained: ${root}`);
        if (finalizerFailures.length) throw new AggregateError(failed ? [primary, ...finalizerFailures] : finalizerFailures, "Late isolation fixture finalization failed");
      }
      if (failed) throw primary;
    });
  }
}
