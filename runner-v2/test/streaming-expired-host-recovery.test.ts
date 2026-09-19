import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import { createSessionAuthority } from "../src/session-authority.js";
import { createStreamingProcessSessionRuntime, type StreamingRuntimeOptions } from "../src/streaming-process-session-runtime.js";
import { createInMemoryStreamingSessionStore, getStreamingSessionKernelWriter, HOST_LAUNCH_RECORD_VERSION, openSqliteStreamingSessionStore } from "../src/streaming-session-store.js";

const at = "2026-09-11T00:00:00.000Z";
const expires = "2026-09-11T00:01:00.000Z";
for (const storage of ["memory", "sqlite"] as const) {
  for (const stage of ["prepared", "isolated", "launching", "bound", "channel-started", "cleanup_pending", "cleanup_blocked"] as const) {
    test(`expired host recovery ${storage} ${stage} records a fenced cleanup instead of remaining stranded`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "c-phase-expired-host-"));
      t.diagnostic(`exact synthetic root acquired: ${root}`);
      const key = Buffer.alloc(32, 37);
      const path = join(root, "sessions.sqlite");
      let kernel = storage === "sqlite" ? openSqliteStreamingSessionStore(path, key) : createInMemoryStreamingSessionStore();
      const writer = getStreamingSessionKernelWriter(kernel);
      const identity = { launchId: "expired-host", ownerId: "host:expired-run", fencingToken: 1 };
      const lease = { leaseId: "exact-lease", providerId: "fake", invocationId: "exact-invocation", providerIdentity: "a".repeat(64), acquiredAt: at, access: [] };
      writer.prepareLaunch({ recordKind: "runner.host-launch", schemaVersion: HOST_LAUNCH_RECORD_VERSION, revision: 0,
        launchId: identity.launchId, sessionId: "stream", runId: "expired-run", agentSessionId: "agent", actor: { role: "worker", id: "worker" },
        toolName: "process.start", callId: "call", ownerId: identity.ownerId, fencingToken: 1, ownerExpiresAt: expires,
        state: "prepared", cleanupOwner: "host_control", history: [{ state: "prepared", at }],
        effects: [{ effectId: "isolate:expired-host", kind: "isolate", status: "pending", ownerId: identity.ownerId, fencingToken: 1, createdAt: at }] });
      const transition = (type: string, extra: Record<string, unknown> = {}) => writer.transitionLaunch({ type, ...identity,
        expectedRevision: kernel.store.readHostLaunch(identity.launchId)!.revision, at, ...extra });
      if (stage !== "prepared") transition("bind_isolation", { lease });
      if (!["prepared", "isolated"].includes(stage)) transition("begin_launch");
      if (!["prepared", "isolated", "launching"].includes(stage)) transition("bind_backend", { backendBinding: {
        registryId: "registry", backendId: "fake", implementationGeneration: "g1", implementationDigest: "b".repeat(64), attestationVersion: 1,
        attestationDigest: "c".repeat(64), opaqueIdentity: "synthetic-only", birthFingerprint: { observedAt: at, discriminator: "exact" }, rootPid: 42, startedAt: at } });
      if (stage === "channel-started") transition("begin_channel");
      if (stage === "cleanup_pending" || stage === "cleanup_blocked") transition("begin_cleanup");
      if (stage === "cleanup_blocked") {
        const failure = { code: "host_reconciliation_failed", message: "Host reconciliation failed." };
        const resources = kernel.store.readHostLaunch(identity.launchId)!.effects.find((effect) => effect.kind === "cleanup")!.resources!;
        transition("settle_cleanup_blocked", { blocker: failure, results: resources.map(({ resource, identity, ownerId, fencingToken }) => ({ resource, identity, ownerId, fencingToken, status: "failed", failure })) });
      }
      const before = kernel.store.readHostLaunch(identity.launchId)!;
      if (storage === "sqlite") { kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key); }
      const clock = () => new Date(expires); // Equality is expired, not a live lease.
      const grants = createExecutionGrantAuthority({ clock });
      const calls: string[] = [];
      const check = () => {
        const record = kernel.store.readHostLaunch(identity.launchId)!;
        assert.equal(record.fencingToken, 2); assert.notEqual(record.ownerId, identity.ownerId);
        assert.ok(Date.parse(record.ownerExpiresAt) > clock().getTime());
        assert.equal(record.state, "cleanup_pending");
      };
      const options: StreamingRuntimeOptions = { kernel, clock, sessions: createSessionAuthority({ grants, sessions: kernel, clock }),
        isolation: { acquire: async () => assert.fail("recovery must never reacquire isolation"), release: async (actual) => { check(); assert.deepEqual(actual, lease); calls.push("lease"); } },
        host: { launch: async () => assert.fail("recovery must not relaunch"),
          quiesce: async ({ fence }) => { check(); assert.equal(fence.fencingToken, 2); calls.push("quiesce"); return "verified"; },
          observeQuiescence: async () => assert.fail("no adopted session exists"), release: async () => { check(); calls.push("backend"); return "verified"; } },
        channel: { version: 2, replayCapacityBytes: 16, replayCapacityChunks: 4, acquire: async () => assert.fail("no new channel"),
          reattach: async () => { check(); calls.push("reattach"); throw new Error("controlled unavailable original channel"); } },
        handshake: { verify: async () => assert.fail("no adoption handshake") },
        output: { maxQueueBytes: 16, maxQueueChunks: 4, maxFrameBytes: 16, maxAcceptedChunks: 4, protocolStreams: ["stdout"],
          createEvidenceSpool: () => assert.fail("no evidence spool acquired"), deliver: async () => assert.fail("no family output") },
      };
      let passed = false;
      try {
        const result = await createStreamingProcessSessionRuntime(options).reconcileStartup({ maxRecords: 4, timeoutMs: 200 });
        const after = kernel.store.readHostLaunch(identity.launchId)!;
        assert.equal(after.fencingToken, 2, "every expired pre-adoption state must enter exact takeover cleanup");
        assert.ok(after.revision > before.revision);
        assert.equal(kernel.store.readBySession("stream"), undefined);
        assert.equal(after.effects.find((effect) => effect.kind === "cleanup")!.takeovers!.length, 1);
        assert.throws(() => getStreamingSessionKernelWriter(kernel).transitionLaunch({ type: "begin_cleanup", ...identity,
          expectedRevision: after.revision, at: expires }), (error: unknown) => (error as { code?: string }).code === "stale_fence");
        if (stage === "channel-started") {
          assert.equal(result.outcomes[0]?.disposition, "blocked"); assert.equal(after.state, "cleanup_blocked");
          assert.ok(calls.includes("reattach")); assert.ok(!calls.includes("quiesce"), "missing channel evidence cannot certify host release");
        } else {
          assert.equal(result.outcomes[0]?.disposition, "cleaned"); assert.equal(after.state, "released");
          assert.ok(after.effects.find((effect) => effect.kind === "cleanup")!.resources!.every((resource) => resource.status === "succeeded"));
          const count = calls.length;
          const repeat = await createStreamingProcessSessionRuntime(options).reconcileStartup({ maxRecords: 4, timeoutMs: 100 });
          assert.deepEqual(repeat.outcomes, []); assert.equal(calls.length, count); assert.deepEqual(kernel.store.readHostLaunch(identity.launchId), after);
        }
        passed = true;
      } finally {
        kernel.store.close(); key.fill(0);
        if (passed) { await rm(root, { recursive: true }); t.diagnostic(`exact synthetic root removed: ${root}`); }
        else t.diagnostic(`exact failed synthetic evidence retained: ${root}`);
      }
    });
  }
}
