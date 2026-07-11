import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureGitBaseline } from "../src/git-baseline.js";
import { runGit } from "../src/git-command.js";

const identity = {
  GIT_AUTHOR_NAME: "AIBoard Test",
  GIT_AUTHOR_EMAIL: "aiboard-test@localhost",
  GIT_COMMITTER_NAME: "AIBoard Test",
  GIT_COMMITTER_EMAIL: "aiboard-test@localhost",
};

test("dirty repository baseline preserves branch, HEAD, index, status, and files", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-baseline-dirty-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  try {
    await runGit({ cwd: project, args: ["init", "-b", "main"] });
    writeFileSync(join(project, "staged.txt"), "initial staged\n");
    writeFileSync(join(project, "unstaged.txt"), "initial unstaged\n");
    await runGit({ cwd: project, args: ["add", "-A"] });
    await runGit({ cwd: project, args: ["commit", "-m", "initial"], env: identity });

    writeFileSync(join(project, "staged.txt"), "captured staged\n");
    await runGit({ cwd: project, args: ["add", "staged.txt"] });
    writeFileSync(join(project, "unstaged.txt"), "captured unstaged\n");
    writeFileSync(join(project, "untracked.txt"), "captured untracked\n");
    writeFileSync(join(project, ".env"), "SECRET=not-captured\n");

    const headBefore = await gitText(project, ["rev-parse", "HEAD"]);
    const branchBefore = await gitText(project, ["symbolic-ref", "--short", "HEAD"]);
    const statusBefore = await gitRaw(project, ["status", "--porcelain=v1", "-z"]);
    const indexBefore = readFileSync(join(project, ".git", "index"));
    const filesBefore = new Map(
      ["staged.txt", "unstaged.txt", "untracked.txt", ".env"].map((path) => [
        path,
        readFileSync(join(project, path)),
      ])
    );

    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "Run With Spaces/1",
    });
    assert.equal(baseline.initializedRepository, false);
    assert.match(baseline.ref, /^refs\/aiboard\/runs\//);
    assert.equal(
      await gitText(project, ["rev-parse", baseline.ref]),
      baseline.revision
    );
    const treePaths = (
      await gitText(project, ["ls-tree", "-r", "--name-only", baseline.revision])
    ).split("\n");
    assert.equal(treePaths.includes("staged.txt"), true);
    assert.equal(treePaths.includes("unstaged.txt"), true);
    assert.equal(treePaths.includes("untracked.txt"), true);
    assert.equal(treePaths.includes(".env"), false);
    assert.equal(
      await gitText(project, ["show", `${baseline.revision}:staged.txt`]),
      "captured staged"
    );
    assert.equal(
      await gitText(project, ["show", `${baseline.revision}:unstaged.txt`]),
      "captured unstaged"
    );

    assert.equal(await gitText(project, ["rev-parse", "HEAD"]), headBefore);
    assert.equal(
      await gitText(project, ["symbolic-ref", "--short", "HEAD"]),
      branchBefore
    );
    assert.deepEqual(
      await gitRaw(project, ["status", "--porcelain=v1", "-z"]),
      statusBefore
    );
    assert.deepEqual(readFileSync(join(project, ".git", "index")), indexBefore);
    for (const [path, bytes] of filesBefore) {
      assert.deepEqual(readFileSync(join(project, path)), bytes);
    }

    const repeated = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "Run With Spaces/1",
    });
    assert.deepEqual(repeated, baseline);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-repository bootstrap creates an initial safe baseline without global identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-baseline-new-"));
  const project = join(root, "new project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "app.ts"), "export const ready = true;\n");
  writeFileSync(join(project, ".env.local"), "TOKEN=secret\n");
  mkdirSync(join(project, "node_modules"));
  writeFileSync(join(project, "node_modules", "dependency.js"), "ignored\n");

  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_new",
    });
    assert.equal(baseline.initializedRepository, true);
    assert.equal(await gitText(project, ["rev-parse", "HEAD"]), baseline.revision);
    assert.equal(await gitText(project, ["status", "--porcelain"]), "");
    const paths = (
      await gitText(project, ["ls-tree", "-r", "--name-only", "HEAD"])
    ).split("\n");
    assert.equal(paths.includes("app.ts"), true);
    assert.equal(paths.includes(".gitignore"), true);
    assert.equal(paths.includes(".env.local"), false);
    assert.equal(paths.some((path) => path.startsWith("node_modules/")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function gitText(cwd: string, args: string[]): Promise<string> {
  return (await runGit({ cwd, args })).stdout.trim();
}

async function gitRaw(cwd: string, args: string[]): Promise<Buffer> {
  return Buffer.from((await runGit({ cwd, args })).stdout);
}
