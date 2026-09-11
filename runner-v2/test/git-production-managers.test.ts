import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { ArtifactStore } from "../src/artifact-store.js";
import { captureRunGitBaseline } from "../src/git-bootstrap.js";
import { createExecutionHost, type ExecutionHostRunBinding } from "../src/execution-host.js";
import { WorkspaceManager } from "../src/workspace-manager.js";
import { IntegrationManager } from "../src/integration-manager.js";
import { VerificationWorkspaceManager } from "../src/verification-workspace.js";
import { createChangeSet } from "../src/change-set.js";
import { createRunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";

test("actual baseline task integration verification and historical Git use their real run owner", { timeout: 300_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p6-native-git-managers-"));
  const project = join(root, "project"); const state = join(root, "state");
  await mkdir(project); await mkdir(state); await writeFile(join(project, "app.txt"), "baseline\n");
  await writeFile(join(project, ".gitattributes"), "*.txt text eol=lf\n");
  t.diagnostic(`exact native Git manager fixture acquired: ${root}`);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts });
  const config = emptyRunnerCapabilitiesConfig();
  const runId = "native-manager-routing";
  let run: ExecutionHostRunBinding | undefined;
  let workspaces: WorkspaceManager | undefined; let integration: IntegrationManager | undefined; let verification: VerificationWorkspaceManager | undefined;
  let failed = false; let primary: unknown;
  try {
    const baseline = await captureRunGitBaseline({ host, projectPath: project, stateDirectory: state, runId, permissionProfile: "full", capabilitiesConfig: config });
    assert.match(baseline.revision, /^[a-f0-9]{40,64}$/); assert.deepEqual(host.activeRunIds(), []);
    const contract = await createRunnerCapabilityContract(config);
    run = await host.bindRun({ runId, permissionProfile: "full", capabilitiesConfig: config, capabilityContract: contract });
    const git = run.git;
    workspaces = new WorkspaceManager({ repositoryRoot: project, stateDirectory: state, runId, baselineRevision: baseline.revision, execute: git.lifecycle("workspace").run });
    integration = new IntegrationManager({ repositoryRoot: project, stateDirectory: state, runId, baselineRevision: baseline.revision,
      execute: git.lifecycle("integration").run, executeBytes: git.lifecycle("integration").runBytes });
    await integration.initialize();
    const workspace = await workspaces.createTaskWorkspace("task-one");
    await writeFile(join(workspace.path, "app.txt"), "task change\n");
    const commit = await workspaces.commitTask("task-one", "Controlled fixture change");
    const evidence = await artifacts.put(Buffer.from("fixture assertion evidence"), "text/plain");
    const change = await createChangeSet({ workspacePath: workspace.path, taskCommit: commit, artifacts,
      evidenceArtifactHashes: [evidence.hash], execute: git.lifecycle("inspection").run });
    const result = await integration.integrate(change); assert.equal(result.status, "integrated");
    assert.equal(await readFile(join(project, "app.txt"), "utf8"), "baseline\n");
    assert.equal(await readFile(join(integration.path, "app.txt"), "utf8"), "task change\n");
    verification = new VerificationWorkspaceManager({ repositoryRoot: integration.path, stateDirectory: state, runId,
      integrationManager: integration, execute: git.lifecycle("verification").run });
    const verified = await verification.create(integration.revision);
    assert.equal(await readFile(join(verified.path, "app.txt"), "utf8"), "task change\n");
    assert.equal(run.executionGrants.activeSnapshots().length, 0);
    const enforcement = await run.isolation.enforcementState();
    assert.ok(enforcement.records.length > 0);
    assert.ok(enforcement.records.every((record) => record.enforcement === "unconfined_explicit_full"));
    await verification.cleanup(); await workspaces.cleanup(); await integration.cleanup();
    await run.close(); assert.deepEqual(host.activeRunIds(), []);
    const before = await fileHashes(state);
    const history = await host.withGitInspection({ runId, permissionProfile: "full", capabilitiesConfig: config, capabilityContract: contract },
      (query) => query.run({ cwd: project, args: ["rev-parse", "HEAD"] }));
    assert.equal(history.stdout.trim(), baseline.revision);
    assert.deepEqual(await fileHashes(state), before, "a historical query cannot alter original durable run state");
    t.diagnostic("all actual Git manager workflows, Full disclosure and reverse cleanup verified");
  } catch (error) { failed = true; primary = error; }
  finally {
    await finalizeCertifiedFixture({ fixtureName: "real Git caller graph", root, hasPrimaryFailure: failed, primaryFailure: primary,
      cleanup: async () => {
        if (run && !run.snapshot().closed) {
          await verification?.cleanup(); await workspaces?.cleanup(); await integration?.cleanup();
        }
        await host.close();
      },
      certify: async () => { assert.deepEqual(host.activeRunIds(), []); },
      removeRoot: async () => { await rm(root, { recursive: true }); t.diagnostic(`certified native manager fixture removed: ${root}`); },
    });
  }
});

async function fileHashes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string, prefix: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`; const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, relative + "/");
      else if (entry.isFile()) result[relative] = createHash("sha256").update(await readFile(path)).digest("hex");
      else assert.fail("unexpected alias in owned test state");
    }
  };
  await visit(root, ""); return result;
}
