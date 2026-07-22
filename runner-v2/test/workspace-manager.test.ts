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
import { dirname, join, relative } from "node:path";
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

test("long run and task identifiers use bounded worktree and branch segments", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-workspace-bounded-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "file.txt"), "baseline\n");
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "baseline",
    });
    const manager = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: `run-${"long-identifier-".repeat(12)}`,
      baselineRevision: baseline.revision,
    });
    const workspace = await manager.createTaskWorkspace(
      `task-${"long-identifier-".repeat(12)}`
    );
    assert.ok(workspace.path.split(/[\\/]/).at(-1)!.length <= 24);
    assert.ok(workspace.branch.length <= 80);
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

test("cleanup removes every owned task worktree and branch, prunes, and is idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-workspace-cleanup-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "file.txt"), "baseline\n");
  const commands: string[][] = [];
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_cleanup",
    });
    const manager = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_cleanup",
      baselineRevision: baseline.revision,
      execute: async (options) => {
        commands.push([...options.args]);
        return await runGit(options);
      },
    });
    const first = await manager.createTaskWorkspace("first");
    const second = await manager.createTaskWorkspace("second", {
      workspaceId: "second:attempt:2",
    });

    await manager.cleanup();

    assert.equal(existsSync(first.path), false);
    assert.equal(existsSync(second.path), false);
    assert.equal(existsSync(dirname(first.path)), false);
    assert.equal(
      await gitText(project, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/aiboard/",
      ]),
      ""
    );
    assert.equal(
      commands.some(
        (args) => args[0] === "worktree" && args[1] === "prune"
      ),
      true
    );

    await manager.cleanup();
    assert.equal(existsSync(first.path), false);
    assert.equal(existsSync(second.path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup preserves a file created immediately before workspace root removal", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-workspace-root-race-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "file.txt"), "baseline\n");
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_root_race",
    });
    const manager = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_root_race",
      baselineRevision: baseline.revision,
      beforeWorkspaceRootRemoval: (workspaceRoot) => {
        writeFileSync(join(workspaceRoot, "raced.txt"), "preserve me\n");
      },
    });
    const workspace = await manager.createTaskWorkspace("task");
    const workspaceRoot = dirname(workspace.path);

    await assert.rejects(
      manager.cleanup(),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOTEMPTY"
    );

    assert.equal(existsSync(workspaceRoot), true);
    assert.equal(
      readFileSync(join(workspaceRoot, "raced.txt"), "utf8"),
      "preserve me\n"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup removes an empty task directory after its stale worktree record was pruned", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-workspace-empty-stale-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "file.txt"), "baseline\n");
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_empty_stale",
    });
    const manager = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_empty_stale",
      baselineRevision: baseline.revision,
    });
    const workspace = await manager.createTaskWorkspace("task");
    rmSync(workspace.path, { recursive: true, force: true });
    await runGit({
      cwd: project,
      args: ["worktree", "prune", "--expire", "now"],
    });
    assert.equal(
      (await gitText(project, ["worktree", "list", "--porcelain"]))
        .replaceAll("\\", "/")
        .includes(workspace.path.replaceAll("\\", "/")),
      false
    );
    mkdirSync(workspace.path);

    await manager.cleanup();

    assert.equal(existsSync(workspace.path), false);
    assert.notEqual(
      (
        await runGit({
          cwd: project,
          args: ["rev-parse", "--verify", workspace.branch],
          allowFailure: true,
        })
      ).exitCode,
      0
    );
    assert.equal(
      (await gitText(project, ["worktree", "list", "--porcelain"]))
        .replaceAll("\\", "/")
        .includes(workspace.path.replaceAll("\\", "/")),
      false
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup refuses a nonempty invalid task directory with a stale worktree record", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-workspace-nonempty-stale-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "file.txt"), "baseline\n");
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_nonempty_stale",
    });
    const manager = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_nonempty_stale",
      baselineRevision: baseline.revision,
    });
    const workspace = await manager.createTaskWorkspace("task");
    rmSync(workspace.path, { recursive: true, force: true });
    mkdirSync(workspace.path);
    writeFileSync(join(workspace.path, "user.txt"), "preserve me\n");

    await assert.rejects(manager.cleanup());

    assert.equal(readFileSync(join(workspace.path, "user.txt"), "utf8"), "preserve me\n");
    assert.equal(
      await gitText(project, ["rev-parse", "--verify", workspace.branch]),
      baseline.revision
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup rejects a task worktree whose ownership no longer matches", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-workspace-owner-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "file.txt"), "baseline\n");
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_owner",
    });
    const manager = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_owner",
      baselineRevision: baseline.revision,
    });
    const workspace = await manager.createTaskWorkspace("task");
    await runGit({
      cwd: workspace.path,
      args: ["switch", "-c", "user/unexpected"],
    });

    await assert.rejects(manager.cleanup(), /unexpected branch/i);
    assert.equal(existsSync(workspace.path), true);
    assert.equal(
      await gitText(project, ["rev-parse", "--verify", workspace.branch]),
      baseline.revision
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup rejects a missing descriptor associated with another worktree path", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-workspace-associated-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const unexpectedPath = join(root, "unexpected-task-path");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "file.txt"), "baseline\n");
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_associated",
    });
    const manager = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_associated",
      baselineRevision: baseline.revision,
    });
    const workspace = await manager.createTaskWorkspace("task");
    await runGit({
      cwd: project,
      args: ["worktree", "move", workspace.path, unexpectedPath],
    });
    assert.equal(existsSync(workspace.path), false);

    await assert.rejects(manager.cleanup(), /unexpected worktree path/i);
    assert.equal(existsSync(unexpectedPath), true);
    assert.equal(
      await gitText(project, ["rev-parse", "--verify", workspace.branch]),
      baseline.revision
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function gitText(cwd: string, args: string[]): Promise<string> {
  return (await runGit({ cwd, args })).stdout.trim();
}
