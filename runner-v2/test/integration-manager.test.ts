import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createChangeSet } from "../src/change-set.js";
import { captureGitBaseline } from "../src/git-baseline.js";
import { runGit } from "../src/git-command.js";
import type { GitRunner } from "../src/git-repository.js";
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
    const projectBefore = await gitText(fixture.project, ["rev-parse", "HEAD"]);
    const workspace = await fixture.workspaces.createTaskWorkspace("feature");
    writeFileSync(join(workspace.path, "feature.txt"), "integrated\n");
    writeFileSync(join(workspace.path, "binary.bin"), Buffer.from([0, 1, 2, 255]));
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
    assert.ok(result.projectRevision);
    assert.notEqual(result.projectRevision, projectBefore);
    assert.equal(
      await gitText(fixture.project, ["rev-parse", "HEAD"]),
      result.projectRevision
    );
    assert.equal(
      await gitText(fixture.project, [
        "rev-list",
        "--count",
        `${projectBefore}..HEAD`,
      ]),
      "1"
    );
    assert.equal(
      await gitText(fixture.project, [
        "diff",
        "--name-only",
        "HEAD",
        result.integrationRevision,
      ]),
      ""
    );
    assert.equal(await gitText(fixture.project, ["status", "--porcelain=v1"]), "");
    assert.equal(
      await gitText(fixture.project, [
        "show",
        "-s",
        "--format=%an <%ae>%n%cn <%ce>%n%B",
        "HEAD",
      ]),
      [
        "AIBoard Integrator <integrator@aiboard.local>",
        "AIBoard Integrator <integrator@aiboard.local>",
        "Apply completed AIBoard build",
        "",
        "AIBoard-Run: run_handoff-apply",
        `AIBoard-Integration: ${result.integrationRevision}`,
      ].join("\n")
    );
    assert.equal(
      readFileSync(join(fixture.project, "feature.txt"), "utf8").trim(),
      "integrated"
    );
    assert.deepEqual(
      readFileSync(join(fixture.project, "binary.bin")),
      Buffer.from([0, 1, 2, 255])
    );
    const replay = await fixture.integration.applyToProject();
    assert.equal(replay.projectRevision, result.projectRevision);
    assert.equal(await gitText(fixture.project, ["rev-parse", "HEAD"]), result.projectRevision);
    assert.equal(
      await gitText(fixture.project, ["rev-list", "--count", `${projectBefore}..HEAD`]),
      "1"
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("final handoff rejects dirty projects without changing their worktree, index, or revision", async () => {
  const fixture = await createFixture("handoff-dirty");
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
    writeFileSync(join(fixture.project, "staged.txt"), "staged by user\n");
    await runGit({ cwd: fixture.project, args: ["add", "staged.txt"] });
    writeFileSync(join(fixture.project, "untracked.txt"), "untracked by user\n");
    const before = await projectState(fixture.project);

    await assert.rejects(
      () => fixture.integration.applyToProject(),
      /clean project worktree and index/i
    );
    assert.deepEqual(await projectState(fixture.project), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("final handoff rejects a detached project without changing it", async () => {
  const fixture = await createFixture("handoff-detached");
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
    await runGit({ cwd: fixture.project, args: ["checkout", "--detach", "HEAD"] });
    const before = await projectState(fixture.project);

    await assert.rejects(
      () => fixture.integration.applyToProject(),
      /named branch/i
    );
    assert.deepEqual(await projectState(fixture.project), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("final handoff conflicts leave a clean project branch unchanged", async () => {
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
    writeFileSync(join(fixture.project, "shared.txt"), "user committed this\n");
    await runGit({ cwd: fixture.project, args: ["add", "shared.txt"] });
    await runGit({
      cwd: fixture.project,
      args: ["commit", "-m", "User change"],
      env: {
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    const before = await projectState(fixture.project);

    await assert.rejects(
      () => fixture.integration.applyToProject(),
      /cannot be applied safely/i
    );
    assert.deepEqual(await projectState(fixture.project), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed project commit rolls back only the Runner patch", async () => {
  const execute: GitRunner = async (options) => {
    if (
      (options.args[0] === "commit" || options.args[0] === "commit-tree") &&
      options.env?.GIT_AUTHOR_NAME === "AIBoard Integrator"
    ) {
      writeFileSync(join(options.cwd, "user-during-commit.txt"), "preserve me\n");
      return { exitCode: 1, stdout: "", stderr: "commit rejected" };
    }
    return await runGit(options);
  };
  const fixture = await createFixture("handoff-rollback", execute);
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
    const beforeRevision = await gitText(fixture.project, ["rev-parse", "HEAD"]);

    await assert.rejects(
      () => fixture.integration.applyToProject(),
      /could not be committed[\s\S]*commit rejected/i
    );
    assert.equal(
      await gitText(fixture.project, ["rev-parse", "HEAD"]),
      beforeRevision
    );
    assert.equal(existsSync(join(fixture.project, "feature.txt")), false);
    assert.equal(
      readFileSync(join(fixture.project, "user-during-commit.txt"), "utf8"),
      "preserve me\n"
    );
    assert.equal(
      (await runGit({
        cwd: fixture.project,
        args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      })).stdout,
      "?? user-during-commit.txt\u0000"
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("concurrent staged user changes are not swept into the AIBoard commit", async () => {
  let raced = false;
  const execute: GitRunner = async (options) => {
    if (
      !raced &&
      (options.args[0] === "commit" || options.args[0] === "commit-tree") &&
      options.env?.GIT_AUTHOR_NAME === "AIBoard Integrator"
    ) {
      raced = true;
      writeFileSync(join(options.cwd, "user-staged.txt"), "user staged\n");
      await runGit({ cwd: options.cwd, args: ["add", "user-staged.txt"] });
    }
    return await runGit(options);
  };
  const fixture = await createFixture("handoff-stage-race", execute);
  try {
    await integrateFeature(fixture, "feature.txt", "integrated\n");
    const beforeRevision = await gitText(fixture.project, ["rev-parse", "HEAD"]);

    await assert.rejects(
      () => fixture.integration.applyToProject(),
      /project changed during automatic handoff/i
    );
    assert.equal(await gitText(fixture.project, ["rev-parse", "HEAD"]), beforeRevision);
    assert.equal(existsSync(join(fixture.project, "feature.txt")), false);
    assert.equal(
      (await runGit({ cwd: fixture.project, args: ["diff", "--cached", "--name-only"] }))
        .stdout.trim(),
      "user-staged.txt"
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a concurrent project commit wins the branch compare-and-swap", async () => {
  let raced = false;
  const execute: GitRunner = async (options) => {
    if (
      !raced &&
      (options.args[0] === "commit" || options.args[0] === "commit-tree") &&
      options.env?.GIT_AUTHOR_NAME === "AIBoard Integrator"
    ) {
      raced = true;
      writeFileSync(join(options.cwd, "user-commit.txt"), "user commit\n");
      await runGit({ cwd: options.cwd, args: ["add", "user-commit.txt"] });
      await runGit({
        cwd: options.cwd,
        args: ["commit", "-m", "Concurrent user commit"],
        env: {
          GIT_AUTHOR_NAME: "User",
          GIT_AUTHOR_EMAIL: "user@example.com",
          GIT_COMMITTER_NAME: "User",
          GIT_COMMITTER_EMAIL: "user@example.com",
        },
      });
    }
    return await runGit(options);
  };
  const fixture = await createFixture("handoff-ref-race", execute);
  try {
    await integrateFeature(fixture, "feature.txt", "integrated\n");
    const beforeRevision = await gitText(fixture.project, ["rev-parse", "HEAD"]);

    await assert.rejects(
      () => fixture.integration.applyToProject(),
      /project changed during automatic handoff/i
    );
    assert.notEqual(await gitText(fixture.project, ["rev-parse", "HEAD"]), beforeRevision);
    assert.equal(
      await gitText(fixture.project, ["show", "-s", "--format=%s", "HEAD"]),
      "Concurrent user commit"
    );
    assert.equal(existsSync(join(fixture.project, "feature.txt")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a thrown commit executor leaves the project unchanged", async () => {
  const execute: GitRunner = async (options) => {
    if (
      (options.args[0] === "commit" || options.args[0] === "commit-tree") &&
      options.env?.GIT_AUTHOR_NAME === "AIBoard Integrator"
    ) {
      throw new Error("executor exploded");
    }
    return await runGit(options);
  };
  const fixture = await createFixture("handoff-throw", execute);
  try {
    await integrateFeature(fixture, "feature.txt", "integrated\n");
    const before = await projectState(fixture.project);

    await assert.rejects(
      () => fixture.integration.applyToProject(),
      /executor exploded/i
    );
    assert.deepEqual(await projectState(fixture.project), before);
    assert.equal(existsSync(join(fixture.project, "feature.txt")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("files returns bounded tracked UTF-8 content from the integration revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-integration-files-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "00-readable.txt"), "hello, revision\n");
  writeFileSync(join(project, "01-binary.bin"), Buffer.from([0, 1, 2, 255]));
  writeFileSync(join(project, "02-oversized.txt"), "x".repeat(1024 * 1024 + 1));
  writeFileSync(join(project, "03-valid-replacement.txt"), "kept \uFFFD\n");
  writeFileSync(join(project, "04-invalid-utf8.txt"), Buffer.from([0xc3, 0x28]));
  for (let index = 0; index < 11; index += 1) {
    writeFileSync(
      join(project, `budget-${String(index).padStart(2, "0")}.txt`),
      "b".repeat(1024 * 1024)
    );
  }
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_files",
    });
    const integration = new IntegrationManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_files",
      baselineRevision: baseline.revision,
    });
    await integration.initialize();

    const snapshot = await integration.files("integration");

    assert.equal(snapshot.source, "integration");
    assert.equal(snapshot.revision, integration.revision);
    assert.equal(snapshot.appliedToProject, false);
    assert.deepEqual(
      snapshot.files.find((file) => file.path === "00-readable.txt"),
      { path: "00-readable.txt", content: "hello, revision\n" }
    );
    assert.equal(snapshot.files.some((file) => file.path === "01-binary.bin"), false);
    assert.equal(
      snapshot.files.some((file) => file.path === "02-oversized.txt"),
      false
    );
    assert.deepEqual(
      snapshot.files.find((file) => file.path === "03-valid-replacement.txt"),
      { path: "03-valid-replacement.txt", content: "kept \uFFFD\n" }
    );
    assert.equal(
      snapshot.files.some((file) => file.path === "04-invalid-utf8.txt"),
      false
    );
    assert.equal(
      snapshot.files.some((file) => file.path === "budget-09.txt"),
      false
    );
    assert.equal(
      snapshot.files.some((file) => file.path === "budget-10.txt"),
      false
    );
    assert.equal(snapshot.omittedFileCount, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("files budgets the serialized JSON envelope including control-character escaping", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-integration-json-budget-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "control-a.txt"), Buffer.alloc(1024 * 1024, 1));
  writeFileSync(join(project, "control-b.txt"), Buffer.alloc(1024 * 1024, 1));
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_json_budget",
    });
    const integration = new IntegrationManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_json_budget",
      baselineRevision: baseline.revision,
    });
    await integration.initialize();

    const snapshot = await integration.files("integration");

    assert.equal(
      snapshot.files.filter((file) => file.path.startsWith("control-")).length,
      1
    );
    assert.equal(snapshot.omittedFileCount, 1);
    assert.equal(
      Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= 10 * 1024 * 1024,
      true
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("files reads the committed project revision when project is the source", async () => {
  const fixture = await createFixture("project-files");
  try {
    writeFileSync(join(fixture.project, "project-only.txt"), "applied result\n");
    await runGit({ cwd: fixture.project, args: ["add", "project-only.txt"] });
    await runGit({
      cwd: fixture.project,
      args: ["commit", "-m", "Apply result"],
      env: {
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    const projectRevision = await gitText(fixture.project, ["rev-parse", "HEAD"]);

    const snapshot = await fixture.integration.files("project");

    assert.equal(snapshot.source, "project");
    assert.equal(snapshot.revision, projectRevision);
    assert.equal(snapshot.appliedToProject, true);
    assert.deepEqual(
      snapshot.files.find((file) => file.path === "project-only.txt"),
      { path: "project-only.txt", content: "applied result\n" }
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("cleanup removes the owned integration worktree but retains its audit branch", async () => {
  const fixture = await createFixture("cleanup");
  try {
    const revision = fixture.integration.revision;
    const branch = fixture.integration.integrationBranch;

    await fixture.integration.cleanup();

    assert.equal(existsSync(fixture.integration.path), false);
    assert.equal(
      await gitText(fixture.project, ["rev-parse", "--verify", branch]),
      revision
    );
    await fixture.integration.cleanup();
    assert.equal(existsSync(fixture.integration.path), false);
    assert.equal(
      await gitText(fixture.project, ["rev-parse", "--verify", branch]),
      revision
    );
    const history = await fixture.integration.history();
    assert.deepEqual(history, []);
    assert.equal(existsSync(fixture.integration.path), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(label: string, execute?: GitRunner) {
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
    ...(execute ? { execute } : {}),
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

async function integrateFeature(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  path: string,
  content: string
): Promise<void> {
  const workspace = await fixture.workspaces.createTaskWorkspace("feature");
  writeFileSync(join(workspace.path, path), content);
  const taskCommit = await fixture.workspaces.commitTask("feature", "Add feature");
  const changeSet = await createChangeSet({
    workspacePath: workspace.path,
    taskCommit,
    artifacts: fixture.artifacts,
    evidenceArtifactHashes: [fixture.evidence.hash],
  });
  await fixture.integration.integrate(changeSet);
}

async function projectState(cwd: string) {
  return {
    head: await gitText(cwd, ["rev-parse", "HEAD"]),
    branch: (await runGit({
      cwd,
      args: ["symbolic-ref", "--quiet", "HEAD"],
      allowFailure: true,
    })).stdout,
    status: (await runGit({
      cwd,
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    })).stdout,
    unstaged: (await runGit({ cwd, args: ["diff", "--binary", "--full-index"] })).stdout,
    staged: (await runGit({
      cwd,
      args: ["diff", "--cached", "--binary", "--full-index"],
    })).stdout,
    shared: readFileSync(join(cwd, "shared.txt")),
    stagedFile: existsSync(join(cwd, "staged.txt"))
      ? readFileSync(join(cwd, "staged.txt"))
      : undefined,
    untrackedFile: existsSync(join(cwd, "untracked.txt"))
      ? readFileSync(join(cwd, "untracked.txt"))
      : undefined,
  };
}
