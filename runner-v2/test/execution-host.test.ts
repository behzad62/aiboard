import assert from "node:assert/strict";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";
import { createHmac, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { ExecutionGrantError } from "../src/execution-grants.js";
import { outputFor } from "../src/one-shot-command-executor.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { runnerRunStateSegment } from "../src/run-state-identity.js";
import {
  STREAMING_SESSION_RECORD_VERSION,
  HOST_LAUNCH_RECORD_VERSION,
  getStreamingSessionKernelWriter,
  parseHostLaunchRecord,
  getStreamingSessionStoreWriter,
  openSqliteStreamingSessionStore,
  type StreamingSessionRecord,
  type StreamingSessionState,
  type HostLaunchRecord,
} from "../src/streaming-session-store.js";

test("ExecutionHost close conjunction retains a pre-adoption unknown launch and exact retry authority", async () => {
  const fixture = await closeConjunctionFixture();
  try {
    fixture.prepare("pending", true);
    assert.deepEqual(fixture.binding.streamingState.listSessionIds(), []);
    await assert.rejects(fixture.host.close(), /cleanup failed/);
    assert.deepEqual(fixture.host.activeRunIds(), [fixture.runId]);
    const blocked = fixture.binding.streamingState.readHostLaunch("pending");
    assert.equal(blocked?.state, "cleanup_blocked");
    assert.equal(blocked?.effects.find((effect) => effect.kind === "cleanup")?.blocker?.code, "host_outcome_unknown");
    const verifiedBefore = blocked!.effects.find((effect) => effect.kind === "cleanup")!.resources!.filter((resource) => resource.status === "succeeded");
    assert.ok(verifiedBefore.length > 0, "the fixture must preserve an already-settled independent resource");
    fixture.releaseSyntheticLaunch("pending");
    const settled = fixture.binding.streamingState.readHostLaunch("pending")!.effects.find((effect) => effect.kind === "cleanup")!.resources!;
    for (const proof of verifiedBefore) assert.deepEqual(settled.find((resource) => resource.resource === proof.resource), proof);
    // Recovery must surface its retained failure before a subsequent exact retry.
    await assert.rejects(fixture.host.close(), /cleanup failed/);
    assert.equal(fixture.binding.streamingState.readHostLaunch("pending")?.state, "released");
    await fixture.host.close();
    assert.deepEqual(fixture.host.activeRunIds(), []);
  } finally {
    await fixture.close();
  }
});

test("ExecutionHost close conjunction independently checks launches beyond bounded recovery", async () => {
  const fixture = await closeConjunctionFixture(1_025);
  try {
    fixture.prepare("a-0000");
    fixture.releaseSyntheticLaunch("a-0000");
    fixture.seedReleasedPrefix(1_024);
    fixture.prepare("z-uninspected");
    await assert.rejects(fixture.host.close(), /cleanup failed/);
    assert.equal(fixture.binding.streamingState.readHostLaunch("z-uninspected")?.state, "prepared");
    assert.deepEqual(fixture.host.activeRunIds(), [fixture.runId]);
    fixture.releaseSyntheticLaunch("z-uninspected");
    await fixture.host.close();
  } finally { await fixture.close(); }
});

test("ExecutionHost close conjunction consumes blocked recovery when durable settlement fails", async () => {
  const fixture = await closeConjunctionFixture();
  try {
    fixture.prepare("pending", true);
    fixture.blockSettlement(true);
    await assert.rejects(fixture.host.close(), (error) => errorContains(error, "recovery remains blocked"));
    assert.equal(fixture.binding.streamingState.readHostLaunch("pending")?.state, "cleanup_pending");
    assert.deepEqual(fixture.host.activeRunIds(), [fixture.runId]);
    fixture.blockSettlement(false);
    fixture.releaseSyntheticLaunch("pending");
    await fixture.host.close();
  } finally { fixture.blockSettlement(false); await fixture.close(); }
});

for (const missing of [false, true]) {
  test(`ExecutionHost close conjunction validates handed-off launch with ${missing ? "missing" : "released"} session`, async () => {
    const fixture = await closeConjunctionFixture();
    try {
      const session = fixture.seedHandedOff(!missing);
      if (missing) {
        await assert.rejects(fixture.host.close(), /cleanup failed/);
        assert.deepEqual(fixture.host.activeRunIds(), [fixture.runId]);
        assert.throws(() => fixture.binding.streamingState.readHostLaunch("handed-off"), /adoption pair is missing or corrupt/);
        fixture.writer.claim(session);
      }
      await fixture.host.close();
      assert.deepEqual(fixture.host.activeRunIds(), []);
    } finally { await fixture.close(); }
  });
}

async function closeConjunctionFixture(maxHostLaunchRecords = 256) {
  const root = resolve(tmpdir(), `c2-close-${randomUUID()}`);
  console.log(JSON.stringify({ fixture: "c2-close-conjunction", event: "planned", root }));
  await mkdir(root);
  const project = join(root, "project");
  const state = join(root, "state");
  await mkdir(project);
  await mkdir(state);
  const runId = "close-conjunction";
  const runRoot = join(state, "builds", runnerRunStateSegment(runId));
  await mkdir(runRoot, { recursive: true });
  const key = Buffer.alloc(32, 41);
  await writeFile(join(runRoot, "streaming-sessions.key"), key);
  const statePath = join(runRoot, "streaming-sessions.sqlite");
  const kernel = openSqliteStreamingSessionStore(statePath, key, { maxHostLaunchRecords });
  const writer = getStreamingSessionKernelWriter(kernel);
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state,
    artifacts: new ArtifactStore(join(state, "artifacts")), platform: "posix",
    streamingStoreOptions: { maxHostLaunchRecords },
  });
  const binding = await host.bindRun(runBinding(runId, "a"));
  const transition = (launchId: string, type: string, extra: Record<string, unknown> = {}) => {
    const record = kernel.store.readHostLaunch(launchId)!;
    return writer.transitionLaunch({ type, launchId, ownerId: record.ownerId,
      fencingToken: record.fencingToken, expectedRevision: record.revision,
      at: new Date().toISOString(), ...extra });
  };
  const releaseSyntheticLaunch = (launchId: string) => {
    const current = kernel.store.readHostLaunch(launchId)!;
    if (current.state === "released" || current.state === "handed_off") return;
    // These directly seeded records never launched a process or opened a channel.
    // A seeded unconfined lease has no provisioned resource; preserve its verified fact.
    // Only the fixture's exact authenticated writer supplies their synthetic facts.
    assert.equal(current.backendBinding, undefined);
    assert.ok(!current.leaseBinding || current.leaseBinding.providerId === "runner-unconfined-explicit-full", "only this fixture's non-provisioning lease may be synthesized");
    const pending = current.state === "cleanup_pending" ? current : transition(launchId, "begin_cleanup");
    const resources = pending.effects.find((effect) => effect.kind === "cleanup")!.resources!;
    transition(launchId, "settle_cleanup_cleaned", {
      results: resources.filter((resource) => resource.status !== "succeeded").map((resource) => ({ resource: resource.resource, identity: resource.identity,
        ownerId: resource.ownerId, fencingToken: resource.fencingToken, status: "succeeded" })),
    });
  };
  let terminalSession: StreamingSessionRecord | undefined;
  return { root, runId, host, binding, kernel, writer, transition, releaseSyntheticLaunch,
    blockSettlement(blocked: boolean) {
      const database = new DatabaseSync(statePath);
      try {
        if (blocked) database.exec("CREATE TRIGGER close_fixture_block BEFORE UPDATE ON streaming_host_launches WHEN json_extract(NEW.record_json, '$.state') = 'cleanup_blocked' BEGIN SELECT RAISE(ABORT, 'synthetic settlement failure'); END");
        else database.exec("DROP TRIGGER IF EXISTS close_fixture_block");
      } finally { database.close(); }
    },
    seedReleasedPrefix(count: number) {
      const template = kernel.store.readHostLaunch("a-0000")!;
      assert.equal(template.state, "released");
      const database = new DatabaseSync(statePath);
      try {
        database.exec("BEGIN IMMEDIATE");
        const insert = database.prepare("INSERT INTO streaming_host_launches (launch_id, record_json, integrity, revision) VALUES (?, ?, ?, ?)");
        for (let index = 1; index < count; index++) {
          const launchId = `a-${String(index).padStart(4, "0")}`;
          // Copy the validated, never-spawned terminal fixture in one seed transaction.
          const record = parseHostLaunchRecord(JSON.parse(JSON.stringify(template).replaceAll("a-0000", launchId)));
          const json = JSON.stringify(record);
          insert.run(launchId, json, createHmac("sha256", key).update(json).digest("hex"), record.revision);
        }
        database.exec("COMMIT");
      } finally { database.close(); }
    },
    seedHandedOff(includeSession: boolean) {
      const at = "2026-09-05T00:00:00.000Z";
      const cleaning = adoptedSessionRecord(runId, "cleanup_pending");
      terminalSession = { ...cleaning, revision: 4, state: "released", cleanupOwner: "none",
        history: [...cleaning.history, { state: "released", at }],
        effects: cleaning.effects.map((effect) => effect.kind === "cleanup"
          ? { ...effect, status: "acknowledged", acknowledgedAt: at } : effect),
      };
      // A supported historical terminal row avoids exercising unrelated live
      // process cleanup. The missing-pair corruption cannot be made by adoption.
      if (includeSession) writer.claim(terminalSession);
      const launch = parseHostLaunchRecord({ recordKind: "runner.host-launch", schemaVersion: HOST_LAUNCH_RECORD_VERSION,
        revision: 7, launchId: "handed-off", sessionId: terminalSession.sessionId, runId,
        agentSessionId: terminalSession.agentSessionId, actor: terminalSession.actor,
        toolName: terminalSession.toolName, callId: terminalSession.callId,
        ownerId: "none", fencingToken: 1, ownerExpiresAt: "2099-09-05T00:00:00.000Z",
        cleanupOwner: "none", state: "handed_off", leaseBinding: terminalSession.lease,
        backendBinding: terminalSession.backendBinding, handshakeDigest: "d".repeat(64),
        channelAcquisitionStartedAt: at, outputCheckpointCreatedAt: at,
        history: ["prepared", "isolated", "launching", "bound", "bound", "bound", "handshake_verified", "handed_off"].map((state) => ({ state, at })),
        effects: ["isolate", "launch", "handoff"].map((kind) => ({ effectId: `${kind}:handed-off`, kind,
          status: "acknowledged", ownerId: `host:${runId}`, fencingToken: 1, createdAt: at, acknowledgedAt: at })),
      });
      const database = new DatabaseSync(statePath);
      try {
        const json = JSON.stringify(launch);
        database.prepare("INSERT INTO streaming_host_launches (launch_id, record_json, integrity, revision) VALUES (?, ?, ?, ?)")
          .run(launch.launchId, json, createHmac("sha256", key).update(json).digest("hex"), launch.revision);
      } finally { database.close(); }
      return terminalSession;
    },
    prepare(launchId: string, ambiguousLaunch = false) {
      const at = new Date().toISOString();
      const record: HostLaunchRecord = { recordKind: "runner.host-launch", schemaVersion: HOST_LAUNCH_RECORD_VERSION,
        revision: 0, launchId, sessionId: `session-${launchId}`, runId, agentSessionId: "synthetic-agent",
        actor: { role: "worker", id: "synthetic-worker" }, toolName: "process.start", callId: launchId,
        ownerId: `host:${runId}`, fencingToken: 1, ownerExpiresAt: "2099-09-05T00:00:00.000Z",
        state: "prepared", cleanupOwner: "host_control", history: [{ state: "prepared", at }],
        effects: [{ effectId: `isolate:${launchId}`, kind: "isolate", status: "pending", ownerId: `host:${runId}`, fencingToken: 1, createdAt: at }],
      };
      writer.prepareLaunch(record);
      if (ambiguousLaunch) {
        // An unknown backend outcome requires a durable issued launch, not a
        // rejected pre-launch request that never reached a backend at all.
        transition(launchId, "bind_isolation", { lease: { leaseId: `synthetic-${launchId}`, providerId: "runner-unconfined-explicit-full", invocationId: launchId, providerIdentity: "a".repeat(64), acquiredAt: at, access: [] } });
        transition(launchId, "begin_launch");
      }
    },
    async close() {
      if (terminalSession && !kernel.store.readBySession(terminalSession.sessionId)) writer.claim(terminalSession);
      if (terminalSession) {
        assert.equal(kernel.store.readBySession(terminalSession.sessionId)?.state, "released");
        // Dispose only the exact, directly seeded handoff fixture after its
        // adopted terminal proof. It never represented a native workload.
        const database = new DatabaseSync(statePath);
        try { database.prepare("DELETE FROM streaming_host_launches WHERE launch_id = ?").run("handed-off"); }
        finally { database.close(); }
      }
      for (const id of kernel.store.listHostLaunchIds()) releaseSyntheticLaunch(id);
      // One recovery can still report the historical failure that it just retired.
      await host.close().catch(() => undefined);
      await host.close();
      assert.deepEqual(host.activeRunIds(), []);
      kernel.store.close();
      console.log(JSON.stringify({ fixture: "c2-close-conjunction", event: "handles-closed", root }));
      assert.equal(dirname(root), resolve(tmpdir()));
      assert.equal(root.startsWith(join(resolve(tmpdir()), "c2-close-")), true);
      await rm(root, { recursive: true });
      console.log(JSON.stringify({ fixture: "c2-close-conjunction", event: "removed", root }));
    },
  };
}

test("one ExecutionHost creates isolated per-run grants stores runtimes and cleanup ownership", async () => {
  const fixture = await hostFixture();
  try {
    const host = createExecutionHost({
      projectRoot: fixture.project,
      stateDirectory: fixture.state,
      artifacts: new ArtifactStore(join(fixture.state, "artifacts")),
      platform: "posix",
      ambientEnvironment: { SAFE_HOST_VALUE: "captured", OPENAI_API_KEY: "removed" },
    });
    const [left, right] = await Promise.all([
      host.bindRun(runBinding("run-left", "a")),
      host.bindRun(runBinding("run-right", "b")),
    ]);
    const leftSnapshot = left.snapshot();
    const rightSnapshot = right.snapshot();
    assert.equal(leftSnapshot.hostId, rightSnapshot.hostId);
    assert.notEqual(leftSnapshot.bindingId, rightSnapshot.bindingId);
    assert.notEqual(leftSnapshot.subprocessStatePath, rightSnapshot.subprocessStatePath);
    assert.notEqual(leftSnapshot.streamingStatePath, rightSnapshot.streamingStatePath);
    assert.notEqual(left.executionGrants, right.executionGrants);
    assert.notEqual(left.sessionAuthority, right.sessionAuthority);
    assert.notEqual(left.streamingRuntime, right.streamingRuntime);
    assert.equal(leftSnapshot.capabilityContractDigest, "a".repeat(64));
    assert.equal(rightSnapshot.capabilityContractDigest, "b".repeat(64));
    assert.deepEqual(host.activeRunIds(), ["run-left", "run-right"]);

    const binding = {
      runId: "run-left",
      sessionId: "session-left",
      actor: { role: "worker" as const, id: "worker-left" },
      toolName: "process.run",
      callId: "call-left",
      permissionProfile: "full" as const,
    };
    const grant = await left.executionGrants.issue({
      ...binding,
      workspacePath: fixture.project,
      access: [{ path: fixture.project, mode: "write" }],
      externalApproved: false,
      destructiveApproved: false,
      networkApproved: false,
    });
    assert.throws(
      () => right.executionGrants.consume(grant, binding),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_forged",
    );

    const recovery = await left.recover({ maxRecords: 16, timeoutMs: 500 });
    assert.equal(recovery.streaming.processed, 0);
    await left.close();
    assert.deepEqual(host.activeRunIds(), ["run-right"]);
    assert.equal(right.snapshot().closed, false);
    await right.close();
    await host.close();
    assert.deepEqual(host.activeRunIds(), []);
  } finally {
    await fixture.close();
  }
});

test("ExecutionHost captures one filtered ambient source and rejects duplicate live run bindings", async () => {
  const fixture = await hostFixture();
  const original = process.env.B3_HOST_TEST_VALUE;
  try {
    process.env.B3_HOST_TEST_VALUE = "before";
    const host = createExecutionHost({
      projectRoot: fixture.project,
      stateDirectory: fixture.state,
      artifacts: new ArtifactStore(join(fixture.state, "artifacts")),
      platform: "posix",
    });
    process.env.B3_HOST_TEST_VALUE = "after";
    assert.equal(host.filteredEnvironmentSource().B3_HOST_TEST_VALUE, "before");
    const binding = await host.bindRun(runBinding("run-one", "c"));
    await assert.rejects(host.bindRun(runBinding("run-one", "c")), /already has a live execution binding/);
    await binding.close();
    const rebound = await host.bindRun(runBinding("run-one", "c"));
    assert.notEqual(rebound.snapshot().bindingId, binding.snapshot().bindingId);
    await host.close();
  } finally {
    if (original === undefined) delete process.env.B3_HOST_TEST_VALUE;
    else process.env.B3_HOST_TEST_VALUE = original;
    await fixture.close();
  }
});

test("ExecutionHost excludes provider-prefixed credentials from its captured child source", async () => {
  const fixture = await hostFixture();
  const sentinel = "SYNTHETIC_HOST_CREDENTIAL_SENTINEL";
  const host = createExecutionHost({
    projectRoot: fixture.project,
    stateDirectory: fixture.state,
    artifacts: new ArtifactStore(join(fixture.state, "artifacts")),
    platform: "posix",
    ambientEnvironment: {
      PATH: "/bin",
      OPENAI_API_KEY: sentinel,
      ANTHROPIC_FOUNDRY_API_KEY: sentinel,
      AZURE_OPENAI_API_KEY: sentinel,
      SERVICE_PRIVATE_KEY: sentinel,
      OPENAI_API_VERSION: "2026-09-01",
    },
  });
  try {
    const source = host.filteredEnvironmentSource();
    assert.deepEqual(source, { PATH: "/bin", OPENAI_API_VERSION: "2026-09-01" });
    assert.doesNotMatch(JSON.stringify(source), new RegExp(sentinel));
  } finally {
    await host.close();
    await fixture.close();
  }
});

test("failed ExecutionHost run construction unwinds its opened SQLite resources", async () => {
  const fixture = await hostFixture();
  const host = createExecutionHost({
    projectRoot: fixture.project,
    stateDirectory: fixture.state,
    artifacts: new ArtifactStore(join(fixture.state, "artifacts")),
    platform: "posix",
  });
  const runId = "construction-unwind";
  const runRoot = join(fixture.state, "builds", runnerRunStateSegment(runId));
  const subprocessState = join(runRoot, "subprocess-runtime.sqlite");
  const movedState = join(runRoot, "subprocess-runtime.closed.sqlite");
  try {
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "streaming-sessions.key"), Buffer.alloc(31, 7));
    await assert.rejects(host.bindRun(runBinding(runId, "f")), /state key is invalid/i);
    assert.deepEqual(host.activeRunIds(), []);
    await rename(subprocessState, movedState);
    await rename(movedState, subprocessState);
  } finally {
    await host.close();
    await fixture.close();
  }
});

test("run binding retains membership and retries a transient cleanup failure", async () => {
  const fixture = await hostFixture();
  let remainingFaults = 1;
  const options = {
    projectRoot: fixture.project,
    stateDirectory: fixture.state,
    artifacts: new ArtifactStore(join(fixture.state, "artifacts")),
    platform: "posix" as const,
    cleanupFault: async (event: { readonly runId: string; readonly point: string }) => {
      if (event.runId === "run-binding-cleanup-retry" &&
          event.point === "before_isolation_recovery" && remainingFaults > 0) {
        remainingFaults -= 1;
        throw new Error("transient run binding cleanup failure");
      }
    },
  };
  const host = createExecutionHost(options);
  try {
    const binding = await host.bindRun(runBinding("run-binding-cleanup-retry", "7"));
    await assert.rejects(
      binding.close(),
      (error: unknown) => errorContains(error, "transient run binding cleanup failure"),
    );
    assert.deepEqual(host.activeRunIds(), ["run-binding-cleanup-retry"]);
    await binding.close();
    assert.deepEqual(host.activeRunIds(), []);
    await host.close();
  } finally {
    await host.close().catch(() => undefined);
    await fixture.close();
  }
});

test("ExecutionHost close retains failed bindings and retries its exact cleanup graph", async () => {
  const fixture = await hostFixture();
  let remainingFaults = 1;
  const options = {
    projectRoot: fixture.project,
    stateDirectory: fixture.state,
    artifacts: new ArtifactStore(join(fixture.state, "artifacts")),
    platform: "posix" as const,
    cleanupFault: async (event: { readonly runId: string; readonly point: string }) => {
      if (event.runId === "run-host-cleanup-retry" &&
          event.point === "before_isolation_recovery" && remainingFaults > 0) {
        remainingFaults -= 1;
        throw new Error("transient host cleanup failure");
      }
    },
  };
  const host = createExecutionHost(options);
  try {
    await host.bindRun(runBinding("run-host-cleanup-retry", "8"));
    await assert.rejects(
      host.close(),
      (error: unknown) => errorContains(error, "transient host cleanup failure"),
    );
    assert.deepEqual(host.activeRunIds(), ["run-host-cleanup-retry"]);
    await host.close();
    assert.deepEqual(host.activeRunIds(), []);
  } finally {
    await host.close().catch(() => undefined);
    await fixture.close();
  }
});

for (const state of ["active", "stopping", "input_unavailable", "backend_unavailable", "outcome_unknown", "cleanup_pending", "cleanup_blocked"] as const) {
  test(`fresh ExecutionHost close accounts for unreleased adopted ${state}`, async () => {
    const fixture = await hostFixture();
    const runId = `durable-close-${state}`;
    const runRoot = join(fixture.state, "builds", runnerRunStateSegment(runId));
    const statePath = join(runRoot, "streaming-sessions.sqlite");
    const keyPath = join(runRoot, "streaming-sessions.key");
    const key = Buffer.alloc(32, state.length);
    await mkdir(runRoot, { recursive: true });
    await writeFile(keyPath, key);
    const seeded = openSqliteStreamingSessionStore(statePath, key);
    getStreamingSessionStoreWriter(seeded).claim(adoptedSessionRecord(runId, state));
    seeded.store.close();
    const assertNoRelaunch = () => {
      const inspection = openSqliteStreamingSessionStore(statePath, key);
      try { assert.deepEqual(inspection.store.listHostLaunchIds(), [], "recovery and close must not launch a replacement"); }
      finally { inspection.store.close(); }
    };

    const host = createExecutionHost({
      projectRoot: fixture.project,
      stateDirectory: fixture.state,
      artifacts: new ArtifactStore(join(fixture.state, "artifacts")),
      platform: "posix",
    });
    try {
      const binding = await host.bindRun(runBinding(runId, "9"));
      const recovery = await binding.streamingRuntime.reconcileStartup({ maxRecords: 4, timeoutMs: 100 });
      assert.deepEqual(recovery.sessionOutcomes, state === "active"
        ? [{ sessionId: `session-${runId}`, disposition: "outcome_unknown" }]
        : [{ sessionId: `session-${runId}`, disposition: "cleanup_blocked", cleanupBlocked: true }]);
      assertNoRelaunch();
      await assert.rejects(
        binding.close(),
        /cleanup|unreleased|outcome|authority|provenance/i,
        `${state} must prevent a successful close until its exact cleanup is verified`,
      );
      const retained = binding.streamingState.readSession(`session-${runId}`);
      assert.equal(retained?.state, "cleanup_blocked");
      assert.ok(retained?.effects.some((effect) =>
        effect.kind === "cleanup" && effect.progress?.resources.some((resource) =>
          resource.status === "blocked" && resource.blocker !== undefined,
        ),
      ));
      assert.deepEqual(host.activeRunIds(), [runId]);
      assertNoRelaunch();
    } finally {
      await host.close().catch(() => undefined);
      await fixture.close().catch(() => undefined);
    }
  });
}

test("two real concurrent run bindings cannot cross grants outputs or cleanup effects", { timeout: 60_000 }, async () => {
  const fixture = await hostFixture();
  const host = createExecutionHost({
    projectRoot: fixture.project,
    stateDirectory: fixture.state,
    artifacts: new ArtifactStore(join(fixture.state, "artifacts")),
  });
  let hasPrimaryFailure = false; let primaryFailure: unknown;
  try {
    const [left, right] = await Promise.all([
      host.bindRun(runBinding("run-real-left", "d")),
      host.bindRun(runBinding("run-real-right", "e")),
    ]);
    const [leftResult, rightResult] = await Promise.all([
      executeTagged(left, fixture.project, "run-real-left", "LEFT_ONLY"),
      executeTagged(right, fixture.project, "run-real-right", "RIGHT_ONLY"),
    ]);
    assertOwnedTail(outputFor(leftResult.process, "stdout").tail, "LEFT_ONLY", "RIGHT_ONLY");
    assertOwnedTail(outputFor(rightResult.process, "stdout").tail, "RIGHT_ONLY", "LEFT_ONLY");
    assert.notEqual(left.snapshot().subprocessStatePath, right.snapshot().subprocessStatePath);

    const crossBinding = executionBinding("run-real-left", "cross-call");
    const crossGrant = await left.executionGrants.issue({
      ...crossBinding,
      workspacePath: fixture.project,
      access: [{ path: fixture.project, mode: "write" }],
      externalApproved: false,
      destructiveApproved: false,
      networkApproved: false,
    });
    await assert.rejects(
      right.commandExecution.execute(commandRequest(
        fixture.project,
        "run-real-right",
        "cross-call",
        "CROSS_FORBIDDEN",
        crossGrant,
      )),
      (error: unknown) => error instanceof ExecutionGrantError && error.code === "grant_forged",
    );

    await left.close();
    assert.deepEqual(host.activeRunIds(), ["run-real-right"]);
    const afterCleanup = await executeTagged(
      right,
      fixture.project,
      "run-real-right",
      "RIGHT_STILL_OWNED",
      "after-left-cleanup",
    );
    assertOwnedTail(
      outputFor(afterCleanup.process, "stdout").tail,
      "RIGHT_STILL_OWNED",
      "LEFT_ONLY",
    );
    await right.close();
    assert.deepEqual(host.activeRunIds(), []);
  } catch (error) { hasPrimaryFailure = true; primaryFailure = error; }
  finally {
    await finalizeCertifiedFixture({ fixtureName: "two-run isolation", root: fixture.state, hasPrimaryFailure, primaryFailure,
      cleanup: () => host.close(), certify: async () => undefined,
      removeRoot: () => fixture.close(),
    });
  }
});

function runBinding(runId: string, digest: string) {
  return {
    runId,
    permissionProfile: "full" as const,
    capabilityContract: { digest: digest.repeat(64) } as RunnerCapabilityContract,
    capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
  };
}

function adoptedSessionRecord(
  runId: string,
  state: Exclude<StreamingSessionState, "pending_transfer" | "transfer_ambiguous" | "released">,
): StreamingSessionRecord {
  const at = "2026-09-05T00:00:00.000Z";
  const sessionId = `session-${runId}`;
  const cleaning = state === "cleanup_pending" || state === "cleanup_blocked";
  const cleanupEffect = {
    effectId: `cleanup:${sessionId}:1`,
    kind: "cleanup" as const,
    status: state === "cleanup_blocked" ? "blocked" as const : "pending" as const,
    owner: "session_authority" as const,
    fencingToken: 1,
    createdAt: at,
    ...(state === "cleanup_blocked" ? { blockedAt: at } : {}),
    cleanupProvenance: {
      effectId: `cleanup:${sessionId}:1`,
      originOwnerId: `session-authority:${runId}:grant`,
      originFencingToken: 1,
      takeovers: [],
    },
  };
  return {
    recordKind: "runner.streaming-session",
    schemaVersion: cleaning ? 3 : STREAMING_SESSION_RECORD_VERSION,
    revision: state === "cleanup_blocked" ? 3 : 2,
    sessionId,
    ownerId: `session-authority:${runId}:grant`,
    fencingToken: 1,
    leaseExpiresAt: "2099-09-05T00:00:00.000Z",
    runId,
    agentSessionId: `agent-${runId}`,
    actor: { role: "worker", id: `worker-${runId}` },
    toolName: "mcp.transport.open",
    callId: `call-${runId}`,
    envelope: {
      access: [], credentialNames: [], networkApproved: false,
      externalApproved: false, destructiveApproved: false,
    },
    lease: {
      leaseId: `lease-${runId}`,
      providerId: "runner-unconfined-explicit-full",
      invocationId: `launch-${runId}`,
      providerIdentity: "a".repeat(64),
      acquiredAt: at,
      access: [],
    },
    backendBinding: {
      registryId: "runner-process-backends-v1",
      backendId: "runner-posix-process-group-v1",
      implementationGeneration: "test-generation",
      implementationDigest: "b".repeat(64),
      attestationVersion: 1,
      attestationDigest: "c".repeat(64),
      opaqueIdentity: `backend-${runId}`,
      birthFingerprint: { observedAt: at, discriminator: `birth-${runId}` },
      startedAt: at,
    },
    cleanupCreationAuthority: !cleaning ? null : {
      effectId: cleanupEffect.effectId,
      ownerId: `session-authority:${runId}:grant`,
      fencingToken: 1,
      createdAt: at,
    },
    cleanupOwner: "session_authority",
    state,
    history: [
      { state: "pending_transfer", at },
      { state: "active", at },
      ...(state === "active" ? [] : [{ state: cleaning ? "cleanup_pending" as const : state, at }]),
      ...(state === "cleanup_blocked" ? [{ state: "cleanup_blocked" as const, at }] : []),
    ],
    effects: [{
      effectId: `transfer:${runId}`,
      kind: "transfer",
      status: "acknowledged",
      owner: "tool_broker",
      fencingToken: 1,
      createdAt: at,
      acknowledgedAt: at,
    }, ...(cleaning ? [cleanupEffect] : [])],
  };
}

type BoundRun = Awaited<ReturnType<ReturnType<typeof createExecutionHost>["bindRun"]>>;

async function executeTagged(
  binding: BoundRun,
  project: string,
  runId: string,
  tag: string,
  callId = `call-${runId}`,
) {
  const exactBinding = executionBinding(runId, callId);
  const grant = await binding.executionGrants.issue({
    ...exactBinding,
    workspacePath: project,
    access: [{ path: project, mode: "write" }],
    externalApproved: false,
    destructiveApproved: false,
    networkApproved: false,
  });
  return await binding.commandExecution.execute(
    commandRequest(project, runId, callId, tag, grant),
  );
}

function executionBinding(runId: string, callId: string) {
  return {
    runId,
    sessionId: `session-${runId}`,
    actor: { role: "worker" as const, id: `worker-${runId}` },
    toolName: "process.run",
    callId,
    permissionProfile: "full" as const,
  };
}

function commandRequest(
  project: string,
  runId: string,
  callId: string,
  tag: string,
  executionGrant: Awaited<ReturnType<BoundRun["executionGrants"]["issue"]>>,
) {
  return {
    executable: process.execPath,
    arguments: ["-e", "process.stdout.write(process.env.B3_RUN_TAG ?? '')"],
    workingDirectory: project,
    explicitEnvironment: { B3_RUN_TAG: tag },
    timeoutMs: 30_000,
    context: {
      ...executionBinding(runId, callId),
      executionGrant,
    },
  };
}

function assertOwnedTail(tail: string, expected: string, forbidden: string): void {
  assert.equal(tail.endsWith(expected), true);
  assert.equal(tail.includes(forbidden), false);
  if (process.platform === "win32") {
    assert.match(tail, /^\[runner output lossy: private_spill_unavailable\]\n/);
  }
}

async function hostFixture() {
  const root = resolve(tmpdir(), `runner-execution-host-${randomUUID()}`);
  console.log(JSON.stringify({ fixture: "execution-host", event: "planned", root }));
  await mkdir(root);
  const project = join(root, "project");
  const state = join(root, "state");
  await mkdir(project);
  await mkdir(state);
  return {
    root,
    project,
    state,
    close: async () => {
      assert.equal(dirname(root), resolve(tmpdir()));
      assert.equal(root.startsWith(join(resolve(tmpdir()), "runner-execution-host-")), true);
      await rm(root, { recursive: true, force: true });
      console.log(JSON.stringify({ fixture: "execution-host", event: "removed", root }));
    },
  };
}

function errorContains(error: unknown, expected: string, seen = new Set<unknown>()): boolean {
  if (seen.has(error)) return false;
  seen.add(error);
  if (error instanceof Error && error.message.includes(expected)) return true;
  if (error instanceof AggregateError) {
    return error.errors.some((entry) => errorContains(entry, expected, seen));
  }
  return false;
}
