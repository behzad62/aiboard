import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { runGit, runGitBytes } from "./support/git-fixture.js";

test("fixture Git allows its explicit canonical temporary repository", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-git-canonical-")));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    const init = await runGit({ cwd: repo, args: ["init"] });
    assert.equal(init.exitCode, 0);
    writeFileSync(join(repo, "note.txt"), "hello\n");
    const add = await runGit({ cwd: repo, args: ["add", "note.txt"] });
    assert.equal(add.exitCode, 0);
    const status = await runGit({ cwd: repo, args: ["status", "--porcelain=v1"] });
    assert.equal(status.exitCode, 0);
    assert.match(status.stdout, /note\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture Git rejects relative cwd", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-git-relative-")));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    const init = await runGit({ cwd: repo, args: ["init"] });
    assert.equal(init.exitCode, 0);
    const originalCwd = process.cwd();
    process.chdir(repo);
    try {
      await assert.rejects(
        () => runGitBytes({ cwd: ".", args: ["status"] }),
        /Fixture Git may operate only in its explicit temporary repository/,
      );
    } finally {
      process.chdir(originalCwd);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture Git rejects actual outside-TMP cwd", async () => {
  const canonicalTmp = realpathSync.native(tmpdir());
  const outside = dirname(canonicalTmp);
  assert.notEqual(outside, canonicalTmp);
  await assert.rejects(
    () => runGitBytes({ cwd: outside, args: ["status"] }),
    /Fixture Git may operate only in its explicit temporary repository/,
  );
});

test("fixture Git rejects user alias inside TMP pointing outside", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-git-alias-")));
  try {
    const canonicalTmp = realpathSync.native(tmpdir());
    const outside = dirname(canonicalTmp);
    const alias = join(root, "alias-outside");
    symlinkSync(outside, alias, "junction");
    await assert.rejects(
      () => runGitBytes({ cwd: alias, args: ["status"] }),
      /Fixture Git may operate only in its explicit temporary repository/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
