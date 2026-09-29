import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { NativeBuildManager } from "../src/native-build-manager.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";
import type { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { runGit } from "./support/git-fixture.js";
import {
  advancingClock,
  buildRuntimeForHandoff,
  driveHandoff,
  failNextSnapshotReadOnce,
  managedHandle,
  managerSpec,
  openFactoryPort,
  openHandoffStore,
  resumeHandoff,
  selectHandoffOwner,
  silentArchitect,
  v2PlanOnlySeed,
  type FactoryPortFixture,
} from "./support/handoff-snapshot-harness.js";

/**
 * TX-2 parity: the fast harness cannot drift from production. For one
 * normal handoff and one reuse-after-failed-read scenario, the full
 * manager pump and the harness must agree on the recorded snapshot event
 * fields (stop kind, paths, body digest, skip reasons, spec status) and
 * the committed tree. Both runs share the run id (separate temp
 * directories), so deterministic bodies, keys and trailers coincide; only
 * the commit hashes differ (git wall-clock metadata).
 */

async function driveFullManager(
  fixture: FactoryPortFixture,
  runId: string,
  architect: ReturnType<typeof silentArchitect>,
): Promise<{ manager: NativeBuildManager; closeStore: () => void }> {
  let store: SqliteSchedulerStore | undefined;
  const manager = new NativeBuildManager({
    specs: new SqliteBuildSpecStore(join(fixture.root, "builds.sqlite")),
    createRuntime: async () => {
      store = openHandoffStore(fixture, runId);
      const runtime = buildRuntimeForHandoff({
        runId, store, projectDocs: fixture.port,
        architect, clock: advancingClock(), runPolicy: "plan_only",
      });
      return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), runId);
    },
  });
  await manager.create(managerSpec(runId, "plan_only"));
  manager.activate(runId);
  await manager.awaitIdle(runId);
  return { manager, closeStore: () => store?.close() };
}

function snapshotPayloadOf(events: Array<{ type: string; payload: unknown }>) {
  const snapshots = events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
  assert.equal(snapshots.length, 1);
  return snapshots[0]!.payload as Record<string, unknown>;
}

async function treeOf(fixture: FactoryPortFixture, commit: string): Promise<{ tree: string; files: string[]; state: string }> {
  const tree = await runGit({ cwd: fixture.integration.path, args: ["rev-parse", `${commit}^{tree}`] });
  const files = await runGit({ cwd: fixture.integration.path, args: ["show", "--name-only", "--format=", commit] });
  const state = await runGit({ cwd: fixture.integration.path, args: ["show", `${commit}:docs/project/STATE.md`] });
  return {
    tree: tree.stdout.trim(),
    files: files.stdout.split("\n").map((line) => line.trim()).filter(Boolean),
    state: state.stdout,
  };
}

function assertSameSnapshotField(payload: Record<string, unknown>, harness: Record<string, unknown>): void {
  assert.equal(harness.stopKind, payload.stopKind);
  assert.deepEqual(harness.paths, payload.paths);
  assert.equal(harness.bodyDigest, payload.bodyDigest);
  assert.equal(harness.stateSkippedReason, payload.stateSkippedReason);
  assert.equal(harness.agentsSectionViaLink, payload.agentsSectionViaLink);
  assert.equal(harness.claudeLineViaLink, payload.claudeLineViaLink);
  assert.equal(harness.specCopied, payload.specCopied);
  assert.equal(harness.specCopySkipped, payload.specCopySkipped);
  assert.equal(harness.specPath, payload.specPath);
  assert.equal(harness.revision, payload.revision);
  assert.equal(harness.previousSnapshotEdited, payload.previousSnapshotEdited);
  assert.equal(harness.agentsSectionCommitted, payload.agentsSectionCommitted);
  assert.equal(harness.claudeLineCommitted, payload.claudeLineCommitted);
}

test("parity: a normal handoff agrees between the full manager and the harness", async () => {
  const RUN = "run-tx2-parity-normal";
  // Both arms share one label: openFactoryPort bakes the label into the
  // fixture package.json, so distinct labels would fork every tree hash
  // below the snapshot. Temp directories still differ (mkdtemp suffix).
  const factoryFixture = await openFactoryPort("parity-normal", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const harnessFixture = await openFactoryPort("parity-normal", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  let manager: NativeBuildManager | undefined;
  let closeStore: (() => void) | undefined;
  try {
    const factoryArchitect = silentArchitect();
    ({ manager, closeStore } = await driveFullManager(factoryFixture, RUN, factoryArchitect));
    const factoryPayload = snapshotPayloadOf(manager.events(RUN));
    const harnessArchitect = silentArchitect();
    const driven = await driveHandoff(harnessFixture, RUN, { architect: harnessArchitect });
    const harnessPayload = snapshotPayloadOf(driven.events);
    assertSameSnapshotField(factoryPayload, harnessPayload);
    const factoryTree = await treeOf(factoryFixture, String(factoryPayload.commit));
    const harnessTree = await treeOf(harnessFixture, String(harnessPayload.commit));
    assert.deepEqual(harnessTree.files, factoryTree.files);
    assert.equal(harnessTree.tree, factoryTree.tree);
    assert.equal(harnessTree.state, factoryTree.state);
    // Selection smoke check: the manager arm selects through
    // NativeBuildManager.selectProjectHandoff and the harness arm through the
    // harness selectHandoffOwner (both stub the non-apply choice without
    // touching the project). Both must accept the same selection and reach
    // the same status. This is not a revision guard: a plan_only run skips
    // the revision check, and choice and revision are echoed stub values.
    const factorySelected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:parity-normal-manager");
    const harnessSelected = await selectHandoffOwner(harnessFixture, RUN, "keep_integration_branch", "handoff:parity-normal-harness");
    assert.equal(harnessSelected.status, factorySelected.status);
    assert.equal(harnessSelected.projectHandoff?.status, factorySelected.projectHandoff?.status);
    assert.equal(harnessSelected.projectHandoff?.choice, factorySelected.projectHandoff?.choice);
    assert.equal(harnessSelected.projectHandoff?.integrationRevision, factorySelected.projectHandoff?.integrationRevision);
  } finally {
    await manager?.close();
    // The manager-side scheduler store is owned by the test (the managed
    // handle never closes it): release it before removing the temp root,
    // or the open SQLite handle locks the directory on Windows.
    closeStore?.();
    await factoryFixture.close();
    await harnessFixture.close();
  }
});

test("parity: a reuse after a failed read agrees between the full manager and the harness", async () => {
  const RUN = "run-tx2-parity-reuse";
  // Both arms share one label (see the normal case above): distinct labels
  // would fork every tree hash below the snapshot.
  const factoryFixture = await openFactoryPort("parity-reuse", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  const harnessFixture = await openFactoryPort("parity-reuse", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  let manager: NativeBuildManager | undefined;
  let closeStore: (() => void) | undefined;
  try {
    failNextSnapshotReadOnce(factoryFixture.integration, "Injected handoff snapshot read failure.");
    failNextSnapshotReadOnce(harnessFixture.integration, "Injected handoff snapshot read failure.");
    const factoryArchitect = silentArchitect();
    ({ manager, closeStore } = await driveFullManager(factoryFixture, RUN, factoryArchitect));
    assert.equal(manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    await manager.resume(RUN, "resume:parity-reuse-manager");
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const factoryPayload = snapshotPayloadOf(manager.events(RUN));
    const harnessArchitect = silentArchitect();
    let driven = await driveHandoff(harnessFixture, RUN, { architect: harnessArchitect });
    assert.equal(driven.events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    await resumeHandoff(harnessFixture, RUN, "resume:parity-reuse-harness", { architect: harnessArchitect });
    driven = await driveHandoff(harnessFixture, RUN, { architect: harnessArchitect });
    const harnessPayload = snapshotPayloadOf(driven.events);
    assertSameSnapshotField(factoryPayload, harnessPayload);
    const factoryTree = await treeOf(factoryFixture, String(factoryPayload.commit));
    const harnessTree = await treeOf(harnessFixture, String(harnessPayload.commit));
    assert.deepEqual(harnessTree.files, factoryTree.files);
    assert.equal(harnessTree.tree, factoryTree.tree);
    assert.equal(harnessTree.state, factoryTree.state);
    for (const fixture of [factoryFixture, harnessFixture]) {
      const count = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
      assert.equal(count.stdout.trim(), "1", "the retry reuses the commit instead of duplicating it");
    }
  } finally {
    await manager?.close();
    // The manager-side scheduler store is owned by the test (the managed
    // handle never closes it): release it before removing the temp root,
    // or the open SQLite handle locks the directory on Windows.
    closeStore?.();
    await factoryFixture.close();
    await harnessFixture.close();
  }
});
