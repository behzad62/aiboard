import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createChangeSet } from "../src/change-set.js";
import { captureGitBaseline } from "../src/git-baseline.js";
import { runGit } from "../src/git-command.js";
import { IntegrationManager } from "../src/integration-manager.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

test("change sets integrate serially and retries do not duplicate commits", async () => {
  const fixture = await createFixture("ordered");
  try {
    const alphaWorkspace = await fixture.workspaces.createTaskWorkspace("alpha");
    const betaWorkspace = await fixture.workspaces.createTaskWorkspace("beta");
    writeFileSync(join(alphaWorkspace.path, "alpha.txt"), "alpha\n");
    writeFileSync(join(betaWorkspace.path, "beta.txt"), "beta\n");
    const alphaCommit = await fixture.workspaces.commitTask("alpha", "Add alpha");
    const betaCommit = await fixture.workspaces.commitTask("beta", "Add beta");
    await assert.rejects(
      () => createChangeSet({
        workspacePath: alphaWorkspace.path,
        taskCommit: alphaCommit,
        artifacts: fixture.artifacts,
      }),
      /durable evidence/i
    );
    const alpha = await createChangeSet({
      workspacePath: alphaWorkspace.path,
      taskCommit: alphaCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [fixture.evidence.hash],
    });
    const beta = await createChangeSet({
      workspacePath: betaWorkspace.path,
      taskCommit: betaCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [fixture.evidence.hash],
      unresolvedConcerns: ["None"],
    });
    assert.match((await fixture.artifacts.get(alpha.diffArtifactHash)).toString(), /alpha\.txt/);

    const first = await fixture.integration.integrate(alpha);
    assert.equal(first.status, "integrated");
    const repeated = await fixture.integration.integrate(alpha);
    assert.deepEqual(repeated, first);

    const appliedRefs = (
      await gitText(fixture.project, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/aiboard/runs",
      ])
    )
      .split("\n")
      .filter((ref) => ref.includes("/integrated/"));
    assert.equal(appliedRefs.length, 1);
    await runGit({
      cwd: fixture.project,
      args: ["update-ref", "-d", appliedRefs[0]],
    });
    const recoveredManager = new IntegrationManager({
      repositoryRoot: fixture.project,
      stateDirectory: fixture.state,
      runId: "run_ordered",
      baselineRevision: fixture.baseline.revision,
    });
    await recoveredManager.initialize();
    const recovered = await recoveredManager.integrate(alpha);
    assert.deepEqual(recovered, first);
    assert.equal(
      await gitText(fixture.integration.path, [
        "rev-list",
        "--count",
        `${fixture.baseline.revision}..HEAD`,
      ]),
      "1"
    );

    const second = await fixture.integration.integrate(beta);
    assert.equal(second.status, "integrated");
    assert.notEqual(second.integrationRevision, first.integrationRevision);
    const history = await fixture.integration.history(10);
    assert.equal(history[0].revision, second.integrationRevision);
    assert.match(history[0].subject, /Add beta/);
    assert.equal(history.some((commit) => commit.revision === first.integrationRevision), true);
    assert.equal(
      readFileSync(join(fixture.integration.path, "alpha.txt"), "utf8").trim(),
      "alpha"
    );
    assert.equal(
      readFileSync(join(fixture.integration.path, "beta.txt"), "utf8").trim(),
      "beta"
    );
    assert.equal(readFileSync(join(fixture.project, "shared.txt"), "utf8"), "baseline\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("integration conflicts are mechanical results and leave canonical integration clean", async () => {
  const fixture = await createFixture("conflict");
  try {
    const firstWorkspace = await fixture.workspaces.createTaskWorkspace("first");
    const secondWorkspace = await fixture.workspaces.createTaskWorkspace("second");
    writeFileSync(join(firstWorkspace.path, "shared.txt"), "first\n");
    writeFileSync(join(secondWorkspace.path, "shared.txt"), "second\n");
    const firstCommit = await fixture.workspaces.commitTask("first", "First version");
    const secondCommit = await fixture.workspaces.commitTask("second", "Second version");
    const first = await createChangeSet({
      workspacePath: firstWorkspace.path,
      taskCommit: firstCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [fixture.evidence.hash],
    });
    const second = await createChangeSet({
      workspacePath: secondWorkspace.path,
      taskCommit: secondCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [fixture.evidence.hash],
    });
    const integrated = await fixture.integration.integrate(first);
    assert.equal(integrated.status, "integrated");
    const revisionBefore = fixture.integration.revision;
    const conflict = await fixture.integration.integrate(second);
    assert.equal(conflict.status, "conflict");
    assert.deepEqual(conflict.conflictPaths, ["shared.txt"]);
    assert.equal(fixture.integration.revision, revisionBefore);
    assert.equal(
      readFileSync(join(fixture.integration.path, "shared.txt"), "utf8").trim(),
      "first"
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a later attempt can integrate from the current integration revision", async () => {
  const fixture = await createFixture("attempt-base");
  try {
    const firstWorkspace = await fixture.workspaces.createTaskWorkspace("first");
    writeFileSync(join(firstWorkspace.path, "first.txt"), "integrated first\n");
    const firstCommit = await fixture.workspaces.commitTask("first", "Add first");
    const firstChangeSet = await createChangeSet({
      workspacePath: firstWorkspace.path,
      taskCommit: firstCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [fixture.evidence.hash],
    });
    const first = await fixture.integration.integrate(firstChangeSet);
    assert.equal(first.status, "integrated");

    const retryWorkspace = await fixture.workspaces.createTaskWorkspace("retry", {
      workspaceId: "retry:attempt:2",
      baselineRevision: first.integrationRevision,
    });
    assert.equal(
      readFileSync(join(retryWorkspace.path, "first.txt"), "utf8").trim(),
      "integrated first"
    );
    writeFileSync(join(retryWorkspace.path, "retry.txt"), "fresh retry\n");
    const retryCommit = await fixture.workspaces.commitWorkspace(
      retryWorkspace,
      "Add retry"
    );
    const retryChangeSet = await createChangeSet({
      workspacePath: retryWorkspace.path,
      taskCommit: retryCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [fixture.evidence.hash],
    });
    const integrated = await fixture.integration.integrate(retryChangeSet);
    assert.equal(integrated.status, "integrated");
    assert.equal(
      readFileSync(join(fixture.integration.path, "retry.txt"), "utf8").trim(),
      "fresh retry"
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("evidence-backed no-change tasks integrate without fabricating commits", async () => {
  const fixture = await createFixture("no-change");
  try {
    const workspace = await fixture.workspaces.createTaskWorkspace("inspection");
    const evidence = await fixture.artifacts.put(
      Buffer.from("inspection passed"),
      "text/plain",
      "Inspection evidence"
    );
    const taskCommit = {
      runId: "run_no-change",
      taskId: "inspection",
      revision: fixture.baseline.revision,
      baselineRevision: fixture.baseline.revision,
      commits: [],
      changedPaths: [],
    };
    await assert.rejects(
      () => createChangeSet({
        workspacePath: workspace.path,
        taskCommit,
        artifacts: fixture.artifacts,
      }),
      /durable evidence/i
    );
    const changeSet = await createChangeSet({
      workspacePath: workspace.path,
      taskCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [evidence.hash],
    });
    assert.deepEqual(changeSet.commits, []);
    const before = fixture.integration.revision;
    const result = await fixture.integration.integrate(changeSet);
    assert.equal(result.status, "integrated");
    assert.equal(result.integrationRevision, before);
    assert.deepEqual(result.changedPaths, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("final handoff applies the integrated diff only after a successful dry run", async () => {
  const fixture = await createFixture("handoff-apply");
  try {
    const workspace = await fixture.workspaces.createTaskWorkspace("feature");
    writeFileSync(join(workspace.path, "feature.txt"), "integrated\n");
    const taskCommit = await fixture.workspaces.commitTask("feature", "Add feature");
    const changeSet = await createChangeSet({
      workspacePath: workspace.path,
      taskCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [fixture.evidence.hash],
    });
    await fixture.integration.integrate(changeSet);

    const result = await fixture.integration.applyToProject();
    assert.equal(result.appliedToProject, true);
    assert.equal(result.integrationRevision, fixture.integration.revision);
    assert.match(result.integrationBranch, /^aiboard\//);
    assert.equal(
      readFileSync(join(fixture.project, "feature.txt"), "utf8").trim(),
      "integrated"
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("final handoff conflicts leave the original project unchanged", async () => {
  const fixture = await createFixture("handoff-conflict");
  try {
    const workspace = await fixture.workspaces.createTaskWorkspace("feature");
    writeFileSync(join(workspace.path, "shared.txt"), "integrated\n");
    const taskCommit = await fixture.workspaces.commitTask("feature", "Change shared");
    const changeSet = await createChangeSet({
      workspacePath: workspace.path,
      taskCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [fixture.evidence.hash],
    });
    await fixture.integration.integrate(changeSet);
    writeFileSync(join(fixture.project, "shared.txt"), "user changed this\n");

    await assert.rejects(
      () => fixture.integration.applyToProject(),
      /cannot be applied safely/i
    );
    assert.equal(
      readFileSync(join(fixture.project, "shared.txt"), "utf8"),
      "user changed this\n"
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `aiboard-integration-${label}-`));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "shared.txt"), "baseline\n");
  const baseline = await captureGitBaseline({
    projectPath: project,
    stateDirectory: state,
    runId: `run_${label}`,
  });
  const workspaces = new WorkspaceManager({
    repositoryRoot: project,
    stateDirectory: state,
    runId: `run_${label}`,
    baselineRevision: baseline.revision,
  });
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const evidence = await artifacts.put(
    Buffer.from("mechanical verification evidence"),
    "text/plain",
    "Fixture evidence"
  );
  const integration = new IntegrationManager({
    repositoryRoot: project,
    stateDirectory: state,
    runId: `run_${label}`,
    baselineRevision: baseline.revision,
  });
  await integration.initialize();
  return {
    root,
    project,
    state,
    baseline,
    workspaces,
    artifacts,
    evidence,
    integration,
  };
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  return (await runGit({ cwd, args })).stdout.trim();
}
