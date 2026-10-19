import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addedLinesByPath } from "../src/submission-guard-git.js";
import { runGit } from "./support/git-fixture.js";

test("one whole-tree diff yields the same added lines as a diff per file", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-added-lines-"));
  const git = async (args: readonly string[]) => {
    const result = await runGit({ cwd: root, args: [...args] });
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout;
  };
  try {
    await git(["init", "-q"]);
    await git(["config", "user.email", "fixture@example.invalid"]);
    await git(["config", "user.name", "fixture"]);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "kept.ts"), "one\ntwo\nthree\n");
    writeFileSync(join(root, "src", "removed.ts"), "gone\n");
    writeFileSync(join(root, "src", "with space.ts"), "a\n");
    await git(["add", "-A"]);
    await git(["commit", "-qm", "baseline"]);
    const baseline = (await git(["rev-parse", "HEAD"])).trim();
    writeFileSync(join(root, "src", "kept.ts"), "one\n+++ b/looks-like-a-header\nthree\nfour\n");
    rmSync(join(root, "src", "removed.ts"));
    writeFileSync(join(root, "src", "with space.ts"), "a\nb\n");
    writeFileSync(join(root, "src", "added.ts"), "diff --git not a header\nx\n");
    writeFileSync(join(root, "src", "café.ts"), "accent\n");
    await git(["add", "-A"]);
    await git(["commit", "-qm", "task"]);
    const revision = (await git(["rev-parse", "HEAD"])).trim();
    const paths = ["src/kept.ts", "src/removed.ts", "src/with space.ts", "src/added.ts", "src/café.ts"];

    const batched = await addedLinesByPath(git, baseline, revision, paths);
    for (const path of paths) {
      const diff = await git(["diff", "--text", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", baseline, revision, "--", `:(literal)${path}`]);
      let inHunk = false;
      const expected: string[] = [];
      for (const line of diff.split("\n")) {
        if (line.startsWith("@@ ")) inHunk = true;
        else if (inHunk && line.startsWith("+")) expected.push(line.slice(1));
      }
      assert.deepEqual(batched.get(path), expected, path);
    }
    assert.deepEqual(batched.get("src/kept.ts"), ["+++ b/looks-like-a-header", "four"], "an added line that looks like a header stays content");
    assert.deepEqual(batched.get("src/added.ts"), ["diff --git not a header", "x"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
