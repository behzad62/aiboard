import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureGitBaseline } from "./support/git-fixture.js";

for (const alias of ["symlink", "hardlink"] as const) {
  test(`bootstrap .gitignore ${alias} cannot mutate an outside object`, async (t) => {
    const root = fs.mkdtempSync(join(tmpdir(), "aiboard-task10-bootstrap-"));
    const project = join(root, "project"); const state = join(root, "state");
    fs.mkdirSync(project); fs.mkdirSync(state);
    const outside = join(root, "outside.txt"); const ignore = join(project, ".gitignore");
    fs.writeFileSync(outside, "outside-original\n");
    if (alias === "symlink") fs.symlinkSync(outside, ignore, "file");
    else fs.linkSync(outside, ignore);
    let passed = false;
    try {
      await assert.rejects(captureGitBaseline({ projectPath: project, stateDirectory: state, runId: "bootstrap-fence" }),
        { code: alias === "symlink" ? "filesystem_alias" : "hardlink_confinement_unprovable" });
      assert.equal(fs.readFileSync(outside, "utf8"), "outside-original\n");
      assert.equal(fs.existsSync(join(project, ".git")), false);
      passed = true;
    } finally {
      if (passed) fs.rmSync(root, { recursive: true, force: true });
      else t.diagnostic(`Task 10 RED bootstrap root retained: ${root}`);
    }
  });
}

test("bootstrap .gitignore refuses a stale prior read before creating Git metadata", async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), "aiboard-task10-bootstrap-"));
  const project = join(root, "project"), state = join(root, "state");
  fs.mkdirSync(project); fs.mkdirSync(state);
  const ignore = join(project, ".gitignore"); fs.writeFileSync(ignore, "original\n");
  const read = fs.promises.readFile; let injected = false; let passed = false;
  t.mock.method(fs.promises, "readFile", async (...args: Parameters<typeof fs.promises.readFile>) => {
    const bytes = await read(...args);
    if (String(args[0]) === ignore && !injected) { injected = true; fs.writeFileSync(ignore, "external-writer\n"); }
    return bytes;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(captureGitBaseline({ projectPath: project, stateDirectory: state, runId: "bootstrap-stale" }), { code: "revision_conflict" });
    assert.equal(injected, true);
    assert.equal(fs.readFileSync(ignore, "utf8"), "external-writer\n");
    assert.equal(fs.existsSync(join(project, ".git")), false);
    assert.deepEqual(fs.readdirSync(project), [".gitignore"]);
    passed = true;
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (passed) fs.rmSync(root, { recursive: true, force: true });
    else t.diagnostic(`Task 10 RED bootstrap root retained: ${root}`);
  }
});
