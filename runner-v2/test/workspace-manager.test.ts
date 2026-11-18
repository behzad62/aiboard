import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";

import { captureGitBaseline } from "./support/git-fixture.js";
import { runGit } from "./support/git-fixture.js";
import { ForeignHistoryError, NoTaskChangesError, PROJECT_STATE_MAX_OUTPUT_BYTES } from "../src/workspace-manager.js";
import { GitCommandError, type GitCommandOptions } from "../src/git-command.js";
import { inspectSubmissionTree } from "../src/submission-guard-git.js";
import { policyGit } from "./support/cli-worker-fixture.js";
import { WorkspaceManager } from "./support/git-fixture.js";

test("T4 exclusive worktree ownership refuses a second task writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-workspace-exclusive-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "file.txt"), "baseline\n");
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_exclusive",
    });
    const first = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_exclusive",
      baselineRevision: baseline.revision,
    });
    await first.createTaskWorkspace("task-a", { workspaceId: "shared-attempt" });

    const second = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_exclusive",
      baselineRevision: baseline.revision,
    });
    await assert.rejects(
      second.createTaskWorkspace("task-b", { workspaceId: "shared-attempt" }),
      /owned by task task-a|ambiguous task ownership/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T4 ownership ledger refuses a second task owner without Git config", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-workspace-owner-ledger-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  try {
    const manager = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_owner_ledger",
      baselineRevision: "a".repeat(40),
    });
    const descriptor = {
      runId: "run_owner_ledger",
      taskId: "task-a",
      workspaceId: "shared-attempt",
      path: join(root, "shared-attempt"),
      branch: "refs/heads/aiboard/run_owner_ledger/tasks/shared-attempt",
      baselineRevision: "a".repeat(40),
    };
    const privateManager = manager as unknown as {
      setWorkspaceTaskOwner(workspace: typeof descriptor, taskId: string): Promise<void>;
    };
    await privateManager.setWorkspaceTaskOwner(descriptor, "task-a");
    await assert.rejects(
      privateManager.setWorkspaceTaskOwner(descriptor, "task-b"),
      /owned by task task-a/,
    );
    const secondManager = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_owner_ledger",
      baselineRevision: "a".repeat(40),
    });
    await assert.rejects(
      (
        secondManager as unknown as {
          assertWorkspaceTaskOwner(
            workspace: typeof descriptor,
            taskId: string,
          ): Promise<void>;
        }
      ).assertWorkspaceTaskOwner(descriptor, "task-b"),
      /owned by task task-a/,
    );
    const ownershipFiles = readdirSync(join(state, "workspace-owners"));
    assert.equal(ownershipFiles.length, 1);
    assert.match(
      readFileSync(join(state, "workspace-owners", ownershipFiles[0]!), "utf8"),
      /"taskId": "task-a"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T4 runner-private ownership preserves independent task commits and cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-workspace-private-owner-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "file.txt"), "baseline\n");
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_private_owner",
    });
    const manager = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_private_owner",
      baselineRevision: baseline.revision,
    });
    const first = await manager.createTaskWorkspace("task-a");
    const second = await manager.createTaskWorkspace("task-b");
    assert.equal(
      (await runGit({
        cwd: project,
        args: ["config", "--local", "--get-all", "aiboard.taskOwner"],
        allowFailure: true,
      })).stdout.trim(),
      "",
    );
    writeFileSync(join(first.path, "a.txt"), "a\n");
    writeFileSync(join(second.path, "b.txt"), "b\n");
    await manager.commitTask("task-a", "Commit first task");
    await manager.commitTask("task-b", "Commit second task");
    await manager.cleanup();
    assert.equal(existsSync(first.path), false);
    assert.equal(existsSync(second.path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

// ---------------------------------------------------------------------------------------------------------------
// CW5 (CLI workers plan §3.5, §3.7): what a CLI at Full access may leave in its worktree.

async function cliWorktree(label: string, withDocs = true) {
  // Git reports the worktree by its real path (macOS /private/var, a Windows 8.3 name spelled out), as the launcher
  // gives the Runner its project and state folders: realpathSync.native expands 8.3 names, plain realpathSync does not.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `aiboard-cw5-${label}-`)));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "value.txt"), "one\n");
  if (withDocs) {
    mkdirSync(join(project, "docs", "project"), { recursive: true });
    writeFileSync(join(project, "docs", "project", "STATE.md"), "state\n");
  }
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: "run_cw5" });
  // Production runs the manager's Git through the Runner Git policy; the fixture's plain runGit would hide a refused verb.
  const manager = new WorkspaceManager({ repositoryRoot: project, stateDirectory: state, runId: "run_cw5", baselineRevision: baseline.revision, execute: policyGit });
  const workspace = await manager.createTaskWorkspace("task_cli");
  const cliGit = async (...args: string[]) =>
    await gitText(workspace.path, ["-c", "user.name=Fake CLI", "-c", "user.email=fake-cli@example.invalid", "-c", "commit.gpgsign=false", ...args]);
  return { root, project, manager, workspace, cliGit, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

test("CW5 undoForeignCommits moves the task branch back to the recorded tip and keeps the CLI's content for the guarded commit", async () => {
  const cli = await cliWorktree("undo");
  try {
    const tip = await gitText(cli.workspace.path, ["rev-parse", "HEAD"]);
    assert.deepEqual(await cli.manager.undoForeignCommits(cli.workspace, tip), { replacedCommits: 0, head: tip });
    writeFileSync(join(cli.workspace.path, "value.txt"), "two\n");
    await cli.cliGit("commit", "-q", "-am", "one");
    writeFileSync(join(cli.workspace.path, "extra.txt"), "extra\n");
    await cli.cliGit("add", "extra.txt");
    await cli.cliGit("commit", "-q", "-m", "two");
    assert.deepEqual(await cli.manager.undoForeignCommits(cli.workspace, tip), { replacedCommits: 2, head: tip });
    assert.equal(await gitText(cli.workspace.path, ["rev-parse", "HEAD"]), tip);
    assert.equal(readFileSync(join(cli.workspace.path, "value.txt"), "utf8"), "two\n");
    const commit = await cli.manager.commitWorkspace(cli.workspace, "The Runner's commit");
    assert.deepEqual([...commit.changedPaths].sort(), ["extra.txt", "value.txt"]);
    assert.equal(await gitText(cli.workspace.path, ["rev-parse", "HEAD~1"]), tip);
  } finally {
    cli.cleanup();
  }
});

test("CW5 a CLI's committed secret is refused by the guarded commit after the undo, and the branch stays at the recorded tip", async () => {
  const cli = await cliWorktree("secret");
  try {
    const tip = await gitText(cli.workspace.path, ["rev-parse", "HEAD"]);
    // Built at runtime so this file holds no literal key header.
    writeFileSync(join(cli.workspace.path, "notes.txt"), `${["-----BEGIN", "PRIVATE", "KEY-----"].join(" ")}\nnot a real key\n`);
    await cli.cliGit("add", "notes.txt");
    await cli.cliGit("commit", "-q", "-m", "key");
    assert.equal((await cli.manager.undoForeignCommits(cli.workspace, tip)).replacedCommits, 1);
    await assert.rejects(
      cli.manager.commitWorkspace(cli.workspace, "The Runner's commit", async (candidateRevision) => {
        await inspectSubmissionTree({ git: runGit, workspacePath: cli.workspace.path, baselineRevision: cli.workspace.baselineRevision,
          candidateRevision, claim: { writableSurfaces: ["**"], forbiddenSurfaces: [] } });
      }),
      /Submission refused: secret or key material detected/,
    );
    assert.equal(await gitText(cli.workspace.path, ["rev-parse", "HEAD"]), tip);
  } finally {
    cli.cleanup();
  }
});

test("CW5 undoForeignCommits refuses rewritten history, a detached HEAD, another branch and an unsettled operation, changing nothing", async () => {
  const cli = await cliWorktree("refuse");
  try {
    writeFileSync(join(cli.workspace.path, "value.txt"), "runner\n");
    const runnerCommit = (await cli.manager.commitWorkspace(cli.workspace, "Runner commit")).revision;
    await cli.cliGit("reset", "-q", "--hard", "HEAD~1");
    await assert.rejects(cli.manager.undoForeignCommits(cli.workspace, runnerCommit),
      (error: unknown) => error instanceof ForeignHistoryError && error.code === "cli_history_rewritten" && error.kind === "rewritten");
    await cli.cliGit("reset", "-q", "--hard", runnerCommit);

    await cli.cliGit("checkout", "-q", "--detach");
    await assert.rejects(cli.manager.undoForeignCommits(cli.workspace, runnerCommit), (error: unknown) => error instanceof ForeignHistoryError && error.kind === "detached");
    await cli.cliGit("checkout", "-q", "-b", "cli-branch");
    await assert.rejects(cli.manager.undoForeignCommits(cli.workspace, runnerCommit), (error: unknown) => error instanceof ForeignHistoryError && error.kind === "other_branch");
    await cli.cliGit("checkout", "-q", cli.workspace.branch.replace(/^refs\/heads\//, ""));

    const mergeHead = resolve(cli.workspace.path, await gitText(cli.workspace.path, ["rev-parse", "--git-path", "MERGE_HEAD"]));
    writeFileSync(mergeHead, `${runnerCommit}\n`);
    await assert.rejects(cli.manager.undoForeignCommits(cli.workspace, runnerCommit), (error: unknown) => error instanceof ForeignHistoryError && error.kind === "unsettled");
    rmSync(mergeHead);
    assert.equal(await gitText(cli.workspace.path, ["rev-parse", "HEAD"]), runnerCommit);
    await assert.rejects(cli.manager.undoForeignCommits(cli.workspace, "not-a-commit"), /not a commit id/);

    // A merge after the recorded tip brings in history from outside the task branch: refused, the branch unmoved.
    await cli.cliGit("checkout", "-q", "-b", "side", runnerCommit);
    writeFileSync(join(cli.workspace.path, "side.txt"), "side\n");
    await cli.cliGit("add", "side.txt");
    await cli.cliGit("commit", "-q", "-m", "side");
    await cli.cliGit("checkout", "-q", cli.workspace.branch.replace(/^refs\/heads\//, ""));
    writeFileSync(join(cli.workspace.path, "main.txt"), "main\n");
    await cli.cliGit("add", "main.txt");
    await cli.cliGit("commit", "-q", "-m", "on the task branch");
    await cli.cliGit("merge", "-q", "--no-ff", "--no-edit", "side");
    const merged = await gitText(cli.workspace.path, ["rev-parse", "HEAD"]);
    await assert.rejects(cli.manager.undoForeignCommits(cli.workspace, runnerCommit),
      (error: unknown) => error instanceof ForeignHistoryError && error.code === "cli_history_rewritten" && error.kind === "merge");
    assert.equal(await gitText(cli.workspace.path, ["rev-parse", "HEAD"]), merged);
    // The same check runs before a launch: on the task branch it passes; detached it refuses.
    await cli.manager.assertOnTaskBranch(cli.workspace);
    await cli.cliGit("checkout", "-q", "--detach");
    await assert.rejects(cli.manager.assertOnTaskBranch(cli.workspace), (error: unknown) => error instanceof ForeignHistoryError && error.kind === "detached");
    // createTaskWorkspace (every worker's entry) refuses it as before, now typed, so the CLI driver can code it.
    await assert.rejects(cli.manager.createTaskWorkspace("task_cli"), (error: unknown) => error instanceof ForeignHistoryError && error.kind === "detached");
    // Only exit 1 is a detached HEAD: Git's fatal 128 (a broken repository, a missing worktree) stays Git's error.
    const fatal = new WorkspaceManager({
      repositoryRoot: cli.project, stateDirectory: join(cli.root, "state"), runId: "run_cw5",
      baselineRevision: cli.workspace.baselineRevision,
      execute: async (options) => options.args[0] === "symbolic-ref"
        ? { exitCode: 128, stdout: "", stderr: "fatal: not a git repository" }
        : await policyGit(options),
    });
    await assert.rejects(fatal.createTaskWorkspace("task_cli"),
      (error: unknown) => error instanceof GitCommandError && !(error instanceof ForeignHistoryError) && /symbolic-ref --quiet HEAD failed: fatal: not a git repository/.test(error.message));
    await cli.cliGit("checkout", "-q", "-b", "cli-elsewhere");
    await assert.rejects(cli.manager.createTaskWorkspace("task_cli"),
      (error: unknown) => error instanceof ForeignHistoryError && error.kind === "other_branch" && /unexpected branch/.test(error.message));
  } finally {
    cli.cleanup();
  }
});

test("CW5 restoreProjectDocs puts docs/project back to the baseline in the worktree and the index, with or without it in the baseline", async () => {
  const cli = await cliWorktree("docs");
  try {
    assert.deepEqual(await cli.manager.restoreProjectDocs(cli.workspace), []);
    writeFileSync(join(cli.workspace.path, "docs", "project", "STATE.md"), "changed\n");
    writeFileSync(join(cli.workspace.path, "docs", "project", "staged.md"), "staged\n");
    await cli.cliGit("add", "docs/project/staged.md");
    mkdirSync(join(cli.workspace.path, "docs", "project", "deep"));
    writeFileSync(join(cli.workspace.path, "docs", "project", "deep", "new.md"), "new\n");
    writeFileSync(join(cli.workspace.path, "value.txt"), "kept\n");
    assert.deepEqual(await cli.manager.restoreProjectDocs(cli.workspace),
      ["docs/project/STATE.md", "docs/project/deep/new.md", "docs/project/staged.md"]);
    assert.equal(readFileSync(join(cli.workspace.path, "docs", "project", "STATE.md"), "utf8"), "state\n");
    assert.equal(existsSync(join(cli.workspace.path, "docs", "project", "staged.md")), false);
    assert.equal(existsSync(join(cli.workspace.path, "docs", "project", "deep")), false);
    assert.equal(await gitText(cli.workspace.path, ["diff", "--cached", "--name-only"]), "");
    assert.equal(readFileSync(join(cli.workspace.path, "value.txt"), "utf8"), "kept\n", "only docs/project is restored");
  } finally {
    cli.cleanup();
  }

  const bare = await cliWorktree("docs-absent", false);
  try {
    mkdirSync(join(bare.workspace.path, "docs", "project"), { recursive: true });
    writeFileSync(join(bare.workspace.path, "docs", "project", "a.md"), "a\n");
    writeFileSync(join(bare.workspace.path, "docs", "project", "b.md"), "b\n");
    await bare.cliGit("add", "docs/project/b.md");
    assert.deepEqual(await bare.manager.restoreProjectDocs(bare.workspace), ["docs/project/a.md", "docs/project/b.md"]);
    assert.equal(existsSync(join(bare.workspace.path, "docs", "project", "a.md")), false);
    assert.equal(existsSync(join(bare.workspace.path, "docs", "project", "b.md")), false);
    assert.equal(await gitText(bare.workspace.path, ["status", "--porcelain"]), "");
  } finally {
    bare.cleanup();
  }
});

test("CW5 projectFolderState changes with the project folder's HEAD, index and status", async () => {
  const cli = await cliWorktree("project-state");
  try {
    const before = await cli.manager.projectFolderState();
    assert.match(before.head, /^[a-f0-9]{40,64}$/);
    writeFileSync(join(cli.project, "outside.txt"), "written outside the worktree\n");
    const after = await cli.manager.projectFolderState();
    assert.equal(after.head, before.head);
    assert.equal(after.index, before.index);
    assert.notEqual(after.status, before.status);
    await gitText(cli.project, ["add", "outside.txt"]);
    assert.notEqual((await cli.manager.projectFolderState()).index, before.index);
  } finally {
    cli.cleanup();
  }
});

test("CW5 projectFolderState reads past Git's 4 MiB default and takes no optional lock, so it never writes the user's index", async () => {
  const cli = await cliWorktree("project-state-limit");
  try {
    const calls: GitCommandOptions[] = [];
    const recording = new WorkspaceManager({
      repositoryRoot: cli.project, stateDirectory: join(cli.root, "state"), runId: "run_cw5",
      baselineRevision: await gitText(cli.project, ["rev-parse", "HEAD"]),
      execute: async (options) => { calls.push(options); return await policyGit(options); },
    });
    // A tracked file whose stat changed: a status with optional locks would refresh and rewrite the index.
    const index = join(cli.project, ".git", "index");
    const indexBefore = readFileSync(index);
    utimesSync(join(cli.project, "value.txt"), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const state = await recording.projectFolderState();
    assert.notEqual(state.status, "unknown");
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.maxOutputBytes === PROJECT_STATE_MAX_OUTPUT_BYTES));
    assert.equal(PROJECT_STATE_MAX_OUTPUT_BYTES, 64 * 1024 * 1024);
    assert.deepEqual(calls.find((call) => call.args[0] === "status")?.env, { GIT_OPTIONAL_LOCKS: "0" });
    assert.deepEqual(readFileSync(index), indexBefore, "status left the user's index as it was");

    // Past even that limit, Git's runner throws output_limit whatever allowFailure says: that read is "unknown" (the
    // before/after comparison skips it), never a thrown error that fails the attempt. Any other error still throws.
    const limited = (failing: string, error: Error) => new WorkspaceManager({
      repositoryRoot: cli.project, stateDirectory: join(cli.root, "state"), runId: "run_cw5",
      baselineRevision: state.head,
      execute: async (options) => { if (options.args[0] === failing) throw error; return await policyGit(options); },
    });
    const huge = await limited("ls-files", new GitCommandError("output_limit", "Git output exceeded 67108864 bytes.")).projectFolderState();
    assert.deepEqual(huge, { head: state.head, index: "unknown", status: huge.status });
    assert.match(huge.status, /^[a-f0-9]{64}$/);
    await assert.rejects(limited("status", new GitCommandError("command_failed", "Git runtime did not finish.")).projectFolderState(), /did not finish/);
  } finally {
    cli.cleanup();
  }
});
