import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureGitBaseline } from "../src/git-baseline.js";
import { IntegrationManager } from "../src/integration-manager.js";
import {
  FinalVerificationDiagnosticsArchive,
  OwnedFinalVerificationCleanup,
} from "../src/final-verification-cleanup.js";
import { VerificationWorkspaceManager } from "../src/verification-workspace.js";

test("failed verification diagnostics archive dirty files before exact cleanup", async () => {
  const fixture = await createFixture("archive");
  try {
    const workspace = await fixture.workspace.create();
    writeFileSync(join(workspace.path, "generated.log"), "token=super-secret\nfailed output\n");
    const calls: string[] = [];
    const cleanup = new OwnedFinalVerificationCleanup({
      stateDirectory: fixture.state,
      runId: fixture.runId,
      stopRun: async () => { calls.push("process"); },
      closeBrowserRun: async () => { calls.push("browser"); },
      workspaceManager: fixture.workspace,
      diagnostics: new FinalVerificationDiagnosticsArchive({
        stateDirectory: fixture.state,
        runId: fixture.runId,
        workspaceManager: fixture.workspace,
      }),
    });
    const result = await cleanup.cleanup({ ...cleanupIdentity(fixture), failed: diagnosticsInput(fixture) });
    calls.push("done");
    assert.deepEqual(calls, ["process", "browser", "done"]);
    assert.equal(existsSync(workspace.path), false);
    const archive = JSON.parse(readFileSync(result.diagnosticsPath!, "utf8")) as {
      targetRevision: string; changedPaths: string[]; logs: string[];
    };
    assert.equal(archive.targetRevision, fixture.integration.revision);
    assert.deepEqual(archive.changedPaths, ["generated.log"]);
    assert.equal(JSON.stringify(archive).includes("super-secret"), false);
  } finally { await closeFixture(fixture); }
});

test("diagnostics failure retains verification workspace", async () => {
  const fixture = await createFixture("diagnostic-failure");
  try {
    const workspace = await fixture.workspace.create();
    const cleanup = new OwnedFinalVerificationCleanup({
      stateDirectory: fixture.state,
      runId: fixture.runId,
      stopRun: async () => undefined,
      closeBrowserRun: async () => undefined,
      workspaceManager: fixture.workspace,
      diagnostics: { persist: async () => { throw new Error("audit disk unavailable"); } },
    });
    await assert.rejects(cleanup.cleanup({ ...cleanupIdentity(fixture), failed: diagnosticsInput(fixture) }), /audit disk unavailable/);
    assert.equal(existsSync(workspace.path), true);
  } finally { await closeFixture(fixture); }
});

test("process stop failure never falls through to workspace removal", async () => {
  const fixture = await createFixture("process-failure");
  try {
    const workspace = await fixture.workspace.create();
    let browserClosed = false;
    const cleanup = new OwnedFinalVerificationCleanup({
      stateDirectory: fixture.state,
      runId: fixture.runId,
      stopRun: async () => { throw new Error("authenticated stop failed"); },
      closeBrowserRun: async () => { browserClosed = true; },
      workspaceManager: fixture.workspace,
    });
    await assert.rejects(cleanup.cleanup(cleanupIdentity(fixture)), /authenticated stop failed/);
    assert.equal(browserClosed, true);
    assert.equal(existsSync(workspace.path), true);
  } finally { await closeFixture(fixture); }
});

test("wrong workspace ownership refuses deletion and successful cleanup is idempotent", async () => {
  const fixture = await createFixture("owner-idempotent");
  try {
    const workspace = await fixture.workspace.create();
    const metadata = JSON.parse(readFileSync(workspace.metadataPath, "utf8")) as Record<string, unknown>;
    writeFileSync(workspace.metadataPath, JSON.stringify({ ...metadata, runId: "foreign-run" }));
    const cleanup = new OwnedFinalVerificationCleanup({
      stateDirectory: fixture.state,
      runId: fixture.runId,
      stopRun: async () => undefined,
      closeBrowserRun: async () => undefined,
      workspaceManager: fixture.workspace,
    });
    await assert.rejects(cleanup.cleanup(cleanupIdentity(fixture)), /ownership|does not match/i);
    assert.equal(existsSync(workspace.path), true);
    writeFileSync(workspace.metadataPath, JSON.stringify(metadata));
    await cleanup.cleanup(cleanupIdentity(fixture));
    await cleanup.cleanup(cleanupIdentity(fixture));
    assert.equal(existsSync(workspace.path), false);
  } finally { await closeFixture(fixture); }
});

test("later generation cleanup is not skipped and quiesce preserves its workspace", async () => {
  const fixture = await createFixture("multiple-generations");
  try {
    const first = await fixture.workspace.create();
    const calls: string[] = [];
    const cleanup = new OwnedFinalVerificationCleanup({
      stateDirectory: fixture.state,
      runId: fixture.runId,
      stopRun: async () => { calls.push("process"); },
      closeBrowserRun: async () => { calls.push("browser"); },
      workspaceManager: fixture.workspace,
    });
    await cleanup.cleanup(cleanupIdentity(fixture));
    assert.equal(existsSync(first.path), false);
    const reopened = new OwnedFinalVerificationCleanup({
      stateDirectory: fixture.state, runId: fixture.runId,
      stopRun: async () => { calls.push("process"); },
      closeBrowserRun: async () => { calls.push("browser"); },
      workspaceManager: fixture.workspace,
    });
    await reopened.cleanup(cleanupIdentity(fixture));
    assert.deepEqual(calls, ["process", "browser"]);
    const second = await fixture.workspace.create();
    await cleanup.quiesceRun();
    assert.equal(existsSync(second.path), true);
    await cleanup.cleanup({ ...cleanupIdentity(fixture), generationId: "generation-2", taskId: "verification-2" });
    assert.equal(existsSync(second.path), false);
    assert.deepEqual(calls, ["process", "browser", "process", "browser", "process", "browser"]);
  } finally { await closeFixture(fixture); }
});

function diagnosticsInput(fixture: Fixture) {
  return {
    generationId: "generation-1",
    taskId: "final-verification-1",
    targetRevision: fixture.integration.revision,
    checks: [{ category: "tests", green: false, evidenceReferences: ["evidence-1"] }],
    evidenceReferences: ["evidence-1"],
    logs: ["token=super-secret", "test failed"],
  };
}
function cleanupIdentity(fixture: Fixture) {
  return { generationId: "generation-1", taskId: "final-verification-1", targetRevision: fixture.integration.revision };
}

interface Fixture { root: string; project: string; state: string; runId: string; integration: IntegrationManager; workspace: VerificationWorkspaceManager }
async function createFixture(name: string): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-fv-cleanup-${name}-`));
  const project = join(root, "project");
  const state = join(root, "runner-state");
  mkdirSync(project, { recursive: true }); mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "README.md"), "baseline\n");
  const runId = `run-${name}`;
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const integration = new IntegrationManager({ repositoryRoot: project, stateDirectory: state, runId, baselineRevision: baseline.revision });
  await integration.initialize();
  const workspace = new VerificationWorkspaceManager({ repositoryRoot: project, stateDirectory: state, runId, integrationManager: integration });
  return { root, project, state, runId, integration, workspace };
}
async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.workspace.cleanup().catch(() => undefined);
  await fixture.integration.cleanup().catch(() => undefined);
  rmSync(fixture.root, { recursive: true, force: true });
}
