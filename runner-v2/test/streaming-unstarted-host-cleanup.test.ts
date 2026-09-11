import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createChildEnvironmentFactory } from "../src/child-environment.js";
import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import { createExecutionHostStreamingGraph } from "../src/execution-host-streaming.js";
import { createProcessBackendRegistry } from "../src/process-backend.js";
import { createSessionAuthority } from "../src/session-authority.js";
import { createInMemoryStreamingSessionStore, getStreamingSessionKernelWriter, HOST_LAUNCH_RECORD_VERSION, openSqliteStreamingSessionStore } from "../src/streaming-session-store.js";

for (const storage of ["memory", "sqlite"] as const) {
  for (const phase of ["prepared", "isolated", "launching"] as const) {
    test(`unstarted host ${storage} ${phase} requires durable absence of a launch effect before certifying cleanup`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "c-phase-no-launch-"));
      t.diagnostic(`exact synthetic root acquired: ${root}`);
      const key = Buffer.alloc(32, 57); const path = join(root, "sessions.sqlite");
      let kernel = storage === "sqlite" ? openSqliteStreamingSessionStore(path, key) : createInMemoryStreamingSessionStore();
      const writer = getStreamingSessionKernelWriter(kernel); const at = new Date().toISOString();
      const identity = { launchId: "unstarted", ownerId: "host:run", fencingToken: 1 };
      writer.prepareLaunch({ recordKind: "runner.host-launch", schemaVersion: HOST_LAUNCH_RECORD_VERSION, revision: 0,
        launchId: identity.launchId, sessionId: "stream", runId: "run", agentSessionId: "agent", actor: { role: "worker", id: "worker" },
        toolName: "process.start", callId: "call", ownerId: identity.ownerId, fencingToken: 1, ownerExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        state: "prepared", cleanupOwner: "host_control", history: [{ state: "prepared", at }],
        effects: [{ effectId: "isolate:unstarted", kind: "isolate", status: "pending", ownerId: identity.ownerId, fencingToken: 1, createdAt: at }] });
      const lease = { leaseId: "synthetic-lease", providerId: "fake", invocationId: "unstarted", providerIdentity: "a".repeat(64), acquiredAt: at, access: [] };
      if (phase !== "prepared") writer.transitionLaunch({ type: "bind_isolation", ...identity, expectedRevision: 0, at, lease });
      if (phase === "launching") writer.transitionLaunch({ type: "begin_launch", ...identity, expectedRevision: 1, at });
      if (storage === "sqlite") { kernel.store.close(); kernel = openSqliteStreamingSessionStore(path, key); }
      const grants = createExecutionGrantAuthority(); let recoveries = 0;
      const graph = createExecutionHostStreamingGraph({ permissionProfile: "full", ambientEnvironment: {}, kernel,
        sessions: createSessionAuthority({ grants, sessions: kernel }),
        environments: createChildEnvironmentFactory({ credentialResolver: { consume: () => assert.fail("no credentials") } }),
        registry: createProcessBackendRegistry([]), channelBackends: new Map(),
        isolation: { acquire: async () => assert.fail("cleanup must never acquire isolation"), release: async () => assert.fail("no in-memory selection exists"),
          prepareExecution: async () => assert.fail("cleanup must never launch"), activeLeases: () => [],
          recoverOwnedLeases: async () => { recoveries++; return []; }, enforcementState: async () => assert.fail("no capability discovery") },
        output: { maxQueueBytes: 16, maxQueueChunks: 4, maxFrameBytes: 16, maxAcceptedChunks: 4, protocolStreams: ["stdout"],
          createEvidenceSpool: () => assert.fail("no output was launched"), deliver: async () => assert.fail("no family delivery") },
      });
      let passed = false;
      try {
        const result = await graph.runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 500 });
        const record = kernel.store.readHostLaunch(identity.launchId)!;
        assert.equal(kernel.store.readBySession("stream"), undefined);
        if (phase === "launching") {
          assert.equal(record.state, "cleanup_blocked");
          assert.equal(result.outcomes[0]?.disposition, "outcome_unknown");
          assert.equal(record.effects.find((effect) => effect.kind === "cleanup")!.resources!.find((resource) => resource.resource === "host")!.status, "failed",
            "a launch intent without a returned binding is genuinely ambiguous, never successful cleanup");
        } else {
          assert.equal(record.state, "released", "a rejected pre-launch isolation request cannot invent an unknown backend resource");
          assert.equal(result.outcomes[0]?.disposition, "cleaned");
          assert.equal(record.effects.some((effect) => effect.kind === "launch"), false);
          assert.ok(record.effects.find((effect) => effect.kind === "cleanup")!.resources!.every((resource) => resource.status === "succeeded"));
          assert.deepEqual((await graph.runtime.reconcileStartup({ maxRecords: 4, timeoutMs: 100 })).outcomes, []);
        }
        assert.equal(recoveries, phase === "prepared" ? 0 : 1);
        passed = true;
      } finally {
        kernel.store.close(); key.fill(0);
        if (passed) { await rm(root, { recursive: true }); t.diagnostic(`exact synthetic root removed: ${root}`); }
        else t.diagnostic(`exact failed synthetic evidence retained: ${root}`);
      }
    });
  }
}
