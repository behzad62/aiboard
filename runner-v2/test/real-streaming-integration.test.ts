import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createRealStreamingHarness } from "./support/real-streaming-harness.js";
import { finalizeRealStreamingFixture } from "./support/real-streaming-fixture-finalizer.js";
import { waitForRealStreamingOutputReadiness } from "./support/real-streaming-output-readiness.js";
import { runRealStreamingCrashFixture, verifyCrashReconcileReplay } from "./support/real-streaming-crash-lifecycle.js";
import { BoundedOutputSpool, createNodeOutputSpillStorage } from "../src/bounded-output-spool.js";
import type { ExecutionGrantBinding, OpaqueExecutionGrant } from "../src/execution-grants.js";

const here = dirname(fileURLToPath(import.meta.url));
const tsxPath = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));

// Includes the owned launcher join and the existing recovery/host-close windows.
test("real Runner crash before transfer is cleaned exactly once without fabricated adoption", { timeout: 255_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-b3-real-crash-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const keyPath = join(root, "integrity.key");
  const leaseMarker = join(root, "lease-releases.log");
  await runRealStreamingCrashFixture({
    root,
    prepare: async () => {
      await mkdir(project);
      await mkdir(state);
      await writeFile(keyPath, Buffer.alloc(32, 17), { flag: "wx" });
    },
    spawn: () => spawn(process.execPath, [
      tsxPath,
      join(here, "fixtures", "streaming-host-crash.mts"),
      state,
      project,
      keyPath,
      leaseMarker,
    ], { stdio: "ignore", windowsHide: true }),
    createOwner: async () => await createRealStreamingHarness({
      stateDirectory: state,
      projectDirectory: project,
      integrityKey: new Uint8Array(await readFile(keyPath)),
      leaseReleaseMarker: leaseMarker,
      childScript: join(here, "fixtures", "persistent-stream-child.mjs"),
    }),
    inspect: async (harness) => {
      const before = harness.kernel.store.readHostLaunch("b3-crash-launch");
      assert.equal(before?.state, "handshake_verified");
      assert.equal(harness.kernel.store.readBySession("b3-stream-session"), undefined);
      assert.equal(processExists(before?.backendBinding?.rootPid ?? 0), true);
      const first = await harness.runtime.reconcileStartup({
        maxRecords: 16,
        timeoutMs: 60_000,
      });
      assert.deepEqual(first.outcomes, [{ launchId: "b3-crash-launch", disposition: "cleaned" }]);
      const released = harness.kernel.store.readHostLaunch("b3-crash-launch");
      assert.equal(released?.state, "released");
      assert.equal(released?.history.filter((entry) => entry.state === "cleanup_pending").length, 1);
      assert.equal(harness.kernel.store.readBySession("b3-stream-session"), undefined);
      assert.equal(processExists(before?.backendBinding?.rootPid ?? 0), false);
      assert.deepEqual(await readdir(harness.backendStateDirectory), []);

      await verifyCrashReconcileReplay({
        reconcile: () => harness.runtime.reconcileStartup({ maxRecords: 16, timeoutMs: 15_000 }),
        readLaunch: () => harness.kernel.store.readHostLaunch("b3-crash-launch"),
      });
    },
  });
});

test("real persistent output stays private between calls and spill failure never corrupts protocol bytes", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-b3-real-output-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const leaseMarker = join(root, "lease-releases.log");
  await mkdir(project);
  await mkdir(state);
  const expected = Buffer.from(Array.from({ length: 12 }, (_, index) =>
    `frame-${String(index).padStart(2, "0")}:${"x".repeat(48)}\n`
  ).join(""));
  const delivered: Buffer[] = [];
  const nodeStorage = createNodeOutputSpillStorage();
  let harness: Awaited<ReturnType<typeof createRealStreamingHarness>> | undefined;
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  try {
    harness = await createRealStreamingHarness({
      stateDirectory: state,
      projectDirectory: project,
      integrityKey: new Uint8Array(Buffer.alloc(32, 23)),
      leaseReleaseMarker: leaseMarker,
      childScript: join(here, "fixtures", "persistent-output-child.mjs"),
      createEvidenceSpool: (sessionId) => {
        const spool = new BoundedOutputSpool({
          spillRoot: join(state, "streaming-spill-fault"),
          projectRoot: project,
          ownershipId: `b3-output-${sessionId}`,
          tailBytes: 32,
          spillBytes: 64,
          storage: {
            ...nodeStorage,
            attest: async () => ({
              currentPrincipalPrivacy: true,
              identityStableDeletion: true,
              unlinkedEntries: true,
            }),
            openExclusive: async () => { throw new Error("injected private spill open failure"); },
          },
        });
        return {
          write: async (stream, bytes) => await spool.write(stream, bytes),
          finalize: async () => await spool.finalize(),
          cleanup: async () => await spool.cleanup(),
        };
      },
      deliver: async (stream, bytes) => {
        if (stream === "stdout") delivered.push(Buffer.from(bytes));
      },
    });
    const preparedOutputCalls: Array<{ binding: ExecutionGrantBinding; grant: OpaqueExecutionGrant }> = [];
    for (let index = 1; index < 24; index++) {
      const callBinding: ExecutionGrantBinding = {
        ...harness.binding,
        toolName: "process.output",
        callId: `b3-output-call-${index}`,
      };
      preparedOutputCalls.push({
        binding: callBinding,
        grant: await harness.grants.issue({
          ...callBinding,
          workspacePath: project,
          access: [{ path: project, mode: "write" }],
          externalApproved: false,
          destructiveApproved: false,
          networkApproved: false,
        }),
      });
    }
    const stopBinding: ExecutionGrantBinding = {
      ...harness.binding,
      toolName: "process.stop",
      callId: "b3-output-stop",
    };
    const stopGrant = await harness.grants.issue({
      ...stopBinding,
      workspacePath: project,
      access: [{ path: project, mode: "write" }],
      externalApproved: false,
      destructiveApproved: false,
      networkApproved: false,
    });
    const facade = await harness.crashOpen();
    assert.equal("channel" in facade, false, "the live channel must never escape to an unauthorized caller");
    const active = harness.kernel.store.readBySession("b3-stream-session");
    assert.equal(active?.state, "active");
    const rootPid = active?.backendBinding.rootPid ?? 0;

    const operationBase = {
      sessionId: "b3-stream-session",
      requestAccess: [],
      credentialNames: [],
      networkApproved: false,
      externalApproved: false,
      destructiveApproved: false,
    } as const;
    await waitForCondition(() => acceptedOutputCount(harness!.kernel) > 0, 10_000);
    await waitForRealStreamingOutputReadiness(facade, 10_000);
    const firstOperation = { ...operationBase, operation: "family_delivery" as const };
    assert.equal(await facade.deliverOutput(
      facade.authorizeFirstOperation(firstOperation),
      { ...firstOperation, binding: harness.binding },
    ), true);
    let deliveryCalls = 1;
    const afterFirstCall = Buffer.concat(delivered).byteLength;
    await waitForCondition(() => acceptedOutputCount(harness!.kernel) > 0, 10_000);
    assert.equal(Buffer.concat(delivered).byteLength, afterFirstCall,
      "privately accepted output must not reach family delivery between authorized calls");

    while (Buffer.concat(delivered).byteLength < expected.byteLength) {
      assert.ok(deliveryCalls < 24, "persistent output did not converge within its exact frame bound");
      await waitForCondition(() => acceptedOutputCount(harness!.kernel) > 0, 10_000);
      await waitForRealStreamingOutputReadiness(facade, 10_000);
      const prepared = preparedOutputCalls[deliveryCalls - 1]!;
      const operation = { ...operationBase, operation: "family_delivery" as const, grant: prepared.grant, binding: prepared.binding };
      const authorization = facade.authorizeOperation(operation);
      assert.equal(await facade.deliverOutput(
        authorization,
        { ...operationBase, operation: "family_delivery", binding: prepared.binding },
      ), true);
      deliveryCalls += 1;
    }
    assert.ok(deliveryCalls > 1, "the persistent process must span more than one authorized call");
    assert.deepEqual(Buffer.concat(delivered), expected);
    await waitForCondition(() => acceptedOutputCount(harness!.kernel) === 0, 10_000);

    const stopOperation = { ...operationBase, operation: "stop" as const, grant: stopGrant, binding: stopBinding };
    const stopped = await facade.stop(
      facade.authorizeOperation(stopOperation),
      { ...operationBase, operation: "stop", binding: stopBinding },
    );
    const evidence = stopped.evidence as {
      evidenceLossy: boolean;
      result?: { streams: Array<{ stream: string; totalBytes: number; tailByteLength: number; lossyOutput: boolean; lossReasons: Array<{ code: string }> }> };
    };
    const stdout = evidence.result?.streams.find((stream) => stream.stream === "stdout");
    assert.equal(evidence.evidenceLossy, true);
    assert.equal(stdout?.totalBytes, expected.byteLength);
    assert.equal(stdout?.tailByteLength, 32);
    assert.equal(stdout?.lossyOutput, true);
    assert.ok(stdout?.lossReasons.some((reason) => reason.code === "spill_open_failed"));
    assert.equal(harness.kernel.store.readBySession("b3-stream-session")?.state, "released");
    assert.equal(processExists(rootPid), false);
    assert.deepEqual(await readdir(harness.backendStateDirectory), []);
  } catch (error) {
    primaryFailure = error;
    hasPrimaryFailure = true;
  } finally {
    await finalizeRealStreamingFixture({
      fixtureName: "real persistent-output",
      root,
      owner: harness,
      primaryFailure,
      hasPrimaryFailure,
    });
  }
});

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function acceptedOutputCount(kernel: Awaited<ReturnType<typeof createRealStreamingHarness>>["kernel"]): number {
  return kernel.store.readOutputCheckpoint("b3-stream-session")?.streams
    .reduce((count, stream) => count + stream.accepted.length, 0) ?? 0;
}

async function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("B3 real fixture condition did not become true within its test bound.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
