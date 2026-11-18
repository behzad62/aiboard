import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ArtifactStore } from "../../src/artifact-store.js";
import { createExecutionHost } from "../../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../../src/native-build-factory.js";
import { emptyRunnerCapabilitiesConfig } from "../../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../../src/runner-capability-contract.js";
import { finalizeCertifiedFixture } from "../support/certified-fixture-cleanup.js";

// Run only as a child by certified-fixture-retained-exit.test.ts (AIBOARD_RETAINED_EXIT_CASE picks the case). Each
// case's test catches its own unverified cleanup, so the tests pass and only the retained-cleanup exit can fail the
// file. hold: the failed cleanup keeps a live handle. drain: it keeps nothing. host: a real ExecutionHost run whose
// close fails (injected), so its owners keep what they hold, as the CW5a run on main did (run 44299442959).
const scenario = process.env.AIBOARD_RETAINED_EXIT_CASE;

test(`a fixture cleanup that stays unverified (${scenario})`, async () => {
  const root = await mkdtemp(join(tmpdir(), `retained-exit-${scenario}-`));
  process.stdout.write(`RETAINED_ROOT=${root}\n`);
  if (scenario === "hold" || scenario === "drain") {
    await assert.rejects(finalizeCertifiedFixture({
      fixtureName: `retained exit (${scenario})`, root, hasPrimaryFailure: false,
      cleanup: async () => {
        if (scenario === "hold") setInterval(() => undefined, 1_000);
        // Nested past the reporter's depth: only the retained-cleanup dump shows it.
        throw new AggregateError([new AggregateError([new Error("retained-deep-cause")], "middle")], "synthetic cleanup failed");
      },
      certify: async () => undefined,
      removeRoot: async () => undefined,
    }), /cleanup remains unverified/);
    return;
  }
  assert.equal(scenario, "host");
  const project = join(root, "project"), state = join(root, "state");
  await mkdir(project); await mkdir(state);
  const host = createExecutionHost({
    projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment: snapshotNativeBuildAmbientEnvironment(),
    ...(process.platform === "win32"
      ? { processHostFacts: { portableDuplex: "verified", windowsBatchArgv: "verified", exactTreeBirth: "verified", jobContainment: "unavailable" } as const }
      : {}),
    cleanupFault: async () => { throw new Error("injected run cleanup fault"); },
  });
  const run = await host.bindRun({ runId: "retained-exit", permissionProfile: "full", capabilityContract: { digest: "d".repeat(64) } as RunnerCapabilityContract, capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
  await assert.rejects(finalizeCertifiedFixture({
    fixtureName: "retained exit (host)", root, hasPrimaryFailure: false,
    cleanup: async () => {
      const errors: unknown[] = [];
      for (const close of [() => run.close(), () => host.close()]) { try { await close(); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, "retained exit host cleanup failed");
    },
    certify: async () => assert.deepEqual(host.activeRunIds(), []),
    removeRoot: async () => undefined,
  }), /cleanup remains unverified/);
});

// The exit waits for every test of the file, not only the one whose cleanup failed.
test(`a later test still runs (${scenario})`, async () => {
  await delay(200);
  process.stdout.write("LATER_TEST_RAN\n");
});
