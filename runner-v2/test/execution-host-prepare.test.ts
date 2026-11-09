import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { createRunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(process.cwd(), "runner-v2", "test", ".host-prepare-"));
  const project = join(root, "project"), state = join(root, "state");
  await mkdir(project); await mkdir(state);
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return host;
}

test("prepare runs the host process checks once, before the first run binds", { timeout: 120_000 }, async (t) => {
  const host = await fixture(t);
  const config = emptyRunnerCapabilitiesConfig();
  const contract = await createRunnerCapabilityContract(config);
  let started = performance.now();
  await host.prepare!();
  const prepareMs = performance.now() - started;
  started = performance.now();
  await host.prepare!();
  assert.ok(performance.now() - started < 500, "a second prepare reuses the first one's checks");
  started = performance.now();
  const binding = await host.bindRun({ runId: "prepared-run", permissionProfile: "full", capabilityContract: contract, capabilitiesConfig: config });
  const bindMs = performance.now() - started;
  await binding.close();
  // On Windows the checks take seconds; once prepared, binding does not repeat them.
  if (process.platform === "win32") assert.ok(bindMs < Math.max(2_000, prepareMs / 2), `bind took ${Math.round(bindMs)} ms after a ${Math.round(prepareMs)} ms prepare`);
});

test("closing the host while prepare is still running waits for it and closes cleanly", { timeout: 120_000 }, async (t) => {
  const host = await fixture(t);
  const warming = host.prepare!();
  await host.close();
  await warming;
  await host.prepare!();
  assert.deepEqual(host.activeRunIds(), []);
});
