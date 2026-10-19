import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureGitBaseline, runGit } from "./support/git-fixture.js";
import { captureWorkingTreeIdentity } from "../src/command-evidence-identity.js";

test("runner-written test reports do not change the working-tree identity (tunnel run)", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-tree-reports-"));
  const project = join(root, "project"), state = join(root, "state");
  try {
    mkdirSync(join(project, "packages", "relay"), { recursive: true }); mkdirSync(state);
    writeFileSync(join(project, "packages", "relay", "index.ts"), "export const a = 1;\n");
    await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: "tree-reports" });
    const capture = () => captureWorkingTreeIdentity(project, join(state, "private-index"), runGit);
    const before = await capture();
    assert.equal(before.status, "known");
    writeFileSync(join(project, ".aiboard-report-abc.xml"), "<testsuites/>");
    writeFileSync(join(project, "packages", "relay", ".aiboard-report-abc.xml"), "<testsuites/>");
    assert.deepEqual(await capture(), before, "npm workspace reports land in each package directory");
    writeFileSync(join(project, "packages", "relay", "index.ts"), "export const a = 2;\n");
    assert.notDeepEqual(await capture(), before, "a real source change still changes the identity");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
