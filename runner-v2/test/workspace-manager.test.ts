import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { captureGitBaseline } from "../src/git-baseline.js";
import { runGit } from "../src/git-command.js";
import {
  NoTaskChangesError,
  WorkspaceManager,
} from "../src/workspace-manager.js";

test("task worktrees isolate concurrent edits and create attributable commits", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-workspaces-"));
  const project = join(root, "project");
  const state = join(root, "runner state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "shared.txt"), "baseline\n");

  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run/one",
    });
    const manager = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run/one",
      baselineRevision: baseline.revision,
    });

    const [first, second] = await Promise.all([
      manager.createTaskWorkspace("task/alpha"),
      manager.createTaskWorkspace("../../task beta"),
    ]);
    assert.notEqual(first.path, second.path);
    assert.equal(relative(state, first.path).startsWith(".."), false);
    assert.equal(relative(state, second.path).startsWith(".."), false);
    assert.equal(readFileSync(join(first.path, "shared.txt"), "utf8").trim(), "baseline");
    assert.equal(readFileSync(join(second.path, "shared.txt"), "utf8").trim(), "baseline");

    writeFileSync(join(first.path, "shared.txt"), "alpha\n");
    writeFileSync(join(first.path, "alpha.txt"), "alpha only\n");
    writeFileSync(join(second.path, "shared.txt"), "beta\n");
    writeFileSync(join(second.path, "beta.txt"), "beta only\n");
    assert.equal(readFileSync(join(project, "shared.txt"), "utf8"), "baseline\n");

    const [alphaCommit, betaCommit] = await Promise.all([
      manager.commitTask("task/alpha", "Implement alpha"),
      manager.commitTask("../../task beta", "Implement beta"),
    ]);
    assert.notEqual(alphaCommit.revision, betaCommit.revision);
    assert.equal(alphaCommit.baselineRevision, baseline.revision);
    assert.deepEqual(alphaCommit.changedPaths.sort(), ["alpha.txt", "shared.txt"]);
    assert.deepEqual(betaCommit.changedPaths.sort(), ["beta.txt", "shared.txt"]);
    assert.match(
      await gitText(first.path, ["show", "-s", "--format=%B", "HEAD"]),
      /AIBoard-Run: run\/one[\s\S]*AIBoard-Task: task\/alpha/
    );
    assert.equal(readFileSync(join(project, "shared.txt"), "utf8"), "baseline\n");

    const repeatedWorkspace = await manager.createTaskWorkspace("task/alpha");
    assert.deepEqual(repeatedWorkspace, first);
    const repeatedCommit = await manager.commitTask("task/alpha", "Implement alpha");
    assert.deepEqual(repeatedCommit, alphaCommit);
  } finally {
    await runGit({
      cwd: project,
      args: ["worktree", "prune", "--expire", "now"],
      allowFailure: true,
    }).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("committing an unchanged task produces a typed mechanical error", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-workspace-clean-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "file.txt"), "baseline\n");
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_clean",
    });
    const manager = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_clean",
      baselineRevision: baseline.revision,
    });
    await manager.createTaskWorkspace("task_clean");
    await assert.rejects(
      manager.commitTask("task_clean", "No changes"),
      (error: unknown) => error instanceof NoTaskChangesError
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retries use fresh worktrees based on the current integration revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-workspace-retries-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "shared.txt"), "baseline\n");
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_retry",
    });
    const manager = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_retry",
      baselineRevision: baseline.revision,
    });
    const first = await manager.createTaskWorkspace("task_a", {
      workspaceId: "task_a:attempt:1",
      baselineRevision: baseline.revision,
    });
    writeFileSync(join(first.path, "rejected.txt"), "do not inherit\n");
    await manager.commitWorkspace(first, "Rejected experiment");

    writeFileSync(join(project, "integrated.txt"), "accepted dependency\n");
    await runGit({ cwd: project, args: ["add", "integrated.txt"] });
    await runGit({
      cwd: project,
      args: ["commit", "-m", "Integrate dependency"],
      env: {
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    const integrationRevision = await gitText(project, ["rev-parse", "HEAD"]);
    const second = await manager.createTaskWorkspace("task_a", {
      workspaceId: "task_a:attempt:2",
      baselineRevision: integrationRevision,
    });

    assert.notEqual(second.path, first.path);
    assert.equal(second.baselineRevision, integrationRevision);
    assert.equal(existsSync(join(second.path, "rejected.txt")), false);
    assert.equal(
      readFileSync(join(second.path, "integrated.txt"), "utf8").trim(),
      "accepted dependency"
    );
  } finally {
    await runGit({
      cwd: project,
      args: ["worktree", "prune", "--expire", "now"],
      allowFailure: true,
    }).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

async function gitText(cwd: string, args: string[]): Promise<string> {
  return (await runGit({ cwd, args })).stdout.trim();
}
