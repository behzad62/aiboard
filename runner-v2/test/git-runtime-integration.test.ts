import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { createRunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";

test("real run-owned Git preserves binary bytes and closes exact nested command ownership", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p6-native-git-"));
  const project = join(root, "project"); const state = join(root, "state");
  await mkdir(project); await mkdir(state);
  t.diagnostic(`acquired exact real Git fixture: ${root}`);
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")) });
  let hasPrimaryFailure = false; let primaryFailure: unknown;
  try {
    const config = emptyRunnerCapabilitiesConfig();
    const contract = await createRunnerCapabilityContract(config, { commandSearchDirectory: project });
    const run = await host.bindRun({ runId: "native-git-run", permissionProfile: "full", capabilityContract: contract, capabilitiesConfig: config });
    assert.ok(run.git, "the actual run must own and inject Git execution");
    const initialized = await run.git.lifecycle("baseline").run({ cwd: project, args: ["init"] });
    assert.equal(initialized.exitCode, 0);
    const bytes = Buffer.from([0, 255, 254, 128, 13, 10, 0, 65]);
    await writeFile(join(project, "payload.bin"), bytes);
    const binding = { runId: run.runId, sessionId: "actual-git-test-worker", actor: { role: "worker" as const, id: "git-test-worker" },
      toolName: "git.binary-check", callId: "binary-roundtrip", permissionProfile: "full" as const };
    const grant = await run.executionGrants.issue({ ...binding, workspacePath: project,
      access: [{ path: project, mode: "write" }], externalApproved: false, destructiveApproved: false, networkApproved: false });
    const git = run.git.forCall({ ...binding, workspacePath: project, executionGrant: grant });
    const stored = await git.run({ cwd: project, args: ["hash-object", "-w", "payload.bin"] });
    assert.match(stored.stdout.trim(), /^[a-f0-9]{40,64}$/);
    const read = await git.runBytes({ cwd: project, args: ["cat-file", "blob", stored.stdout.trim()] });
    assert.deepEqual(read.stdout, bytes);
    assert.equal(run.executionGrants.activeSnapshots().length, 1, "completed command grants must be released, leaving only ToolBroker's parent");
    await run.executionGrants.revoke(grant, "completed");
    await assert.rejects(git.run({ cwd: project, args: ["status"] }), /revoked|closed/i);
    await run.close();
    assert.deepEqual(host.activeRunIds(), []);
    t.diagnostic("actual Git initialization, binary object write/read and authenticated cleanup verified");
  } catch (error) { hasPrimaryFailure = true; primaryFailure = error; }
  finally {
    await finalizeCertifiedFixture({ fixtureName: "runtime-backed Git", root, hasPrimaryFailure, primaryFailure,
      cleanup: () => host.close(), certify: async () => { assert.deepEqual(host.activeRunIds(), []); },
      removeRoot: async () => { await rm(root, { recursive: true }); t.diagnostic(`certified real Git fixture removed: ${root}`); },
    });
  }
});
