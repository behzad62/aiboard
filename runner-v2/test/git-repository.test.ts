import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GitCommandError, runGit } from "../src/git-command.js";
import { inspectRepository } from "../src/git-repository.js";

const identity = {
  GIT_AUTHOR_NAME: "AIBoard Test",
  GIT_AUTHOR_EMAIL: "aiboard-test@localhost",
  GIT_COMMITTER_NAME: "AIBoard Test",
  GIT_COMMITTER_EMAIL: "aiboard-test@localhost",
};

test("repository inspection handles non-repositories and paths with spaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard git inspect "));
  const project = join(root, "project with spaces");
  mkdirSync(project);
  try {
    assert.deepEqual(await inspectRepository(project), {
      repository: false,
      root: null,
      headRevision: null,
      headRef: null,
      dirty: { staged: false, unstaged: false, untracked: false },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository inspection attributes staged, unstaged, and untracked state", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-git-inspect-"));
  const project = join(root, "repository");
  mkdirSync(project);
  try {
    await runGit({ cwd: project, args: ["init", "-b", "main"] });
    writeFileSync(join(project, "staged.txt"), "one\n");
    writeFileSync(join(project, "unstaged.txt"), "one\n");
    await runGit({ cwd: project, args: ["add", "-A"] });
    await runGit({ cwd: project, args: ["commit", "-m", "initial"], env: identity });

    writeFileSync(join(project, "staged.txt"), "two\n");
    await runGit({ cwd: project, args: ["add", "staged.txt"] });
    writeFileSync(join(project, "unstaged.txt"), "two\n");
    writeFileSync(join(project, "untracked.txt"), "new\n");

    const inspection = await inspectRepository(project);
    assert.equal(inspection.repository, true);
    assert.equal(inspection.root, project);
    assert.match(inspection.headRevision ?? "", /^[a-f0-9]{40,64}$/);
    assert.equal(inspection.headRef, "main");
    assert.deepEqual(inspection.dirty, {
      staged: true,
      unstaged: true,
      untracked: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git command output is bounded and never routed through a shell", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-git-output-"));
  try {
    await runGit({ cwd: root, args: ["init", "-b", "main"] });
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(root, `untracked-${index}.txt`), "x");
    }
    await assert.rejects(
      runGit({
        cwd: root,
        args: ["status", "--porcelain=v1", "--untracked-files=all"],
        maxOutputBytes: 32,
      }),
      (error: unknown) =>
        error instanceof GitCommandError && error.code === "output_limit"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
