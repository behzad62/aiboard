import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { planTestReport, readNodeWorkspaceReportSet } from "../src/delivery-execution.js";

function workspaceProject(testScripts: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "aiboard-ws-reports-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"], scripts: { test: "npm run test --workspaces --if-present" } }));
  for (const [name, script] of Object.entries(testScripts)) {
    mkdirSync(join(root, "packages", name, "test"), { recursive: true });
    writeFileSync(join(root, "packages", name, "package.json"), JSON.stringify({ name, version: "1.0.0", scripts: { test: script } }));
    writeFileSync(join(root, "packages", name, "test", "a.test.mjs"), `import test from "node:test"; test("${name} one", () => {}); test("${name} two", () => {});\n`);
  }
  mkdirSync(join(root, "packages", "docs"), { recursive: true });
  writeFileSync(join(root, "packages", "docs", "package.json"), JSON.stringify({ name: "docs", version: "1.0.0" }));
  return root;
}

const command = { label: "tests", executable: "npm", args: ["run", "test"] };

test("npm workspaces running node --test prove a run with one report per workspace (tunnel run)", { timeout: 120_000 }, async () => {
  const root = workspaceProject({ alpha: "node --test \"test/*.test.mjs\"", beta: "node --test \"test/**/*.test.mjs\"" });
  try {
    const plan = planTestReport({ checkoutPath: root, command, reportName: "unit" });
    assert.equal(plan.unsupported, undefined);
    assert.deepEqual(plan.reportSet, { kind: "node-workspace-reports", reportPaths: ["packages/alpha/.aiboard-report-unit.xml", "packages/beta/.aiboard-report-unit.xml"] });
    // As the runner does: drop NODE_TEST_CONTEXT so the child runs its own reporters (this test runs under node --test).
    const { NODE_TEST_CONTEXT: _context, ...environment } = process.env;
    const run = spawnSync("npm", ["run", "test"], { cwd: root, shell: true, encoding: "utf8", env: { ...environment, NODE_OPTIONS: plan.command!.environment!.NODE_OPTIONS! } });
    assert.equal(run.status, 0, run.stderr);
    const report = await readNodeWorkspaceReportSet({ ...plan, reportSet: plan.reportSet as { kind: "node-workspace-reports"; reportPaths: string[] } }, root, new ArtifactStore(join(root, ".artifacts")));
    assert.equal(report.status, "passed", report.reason ?? "");
    assert.deepEqual(report.counts, { selected: 4, passed: 4, failed: 0, skipped: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a workspace that does not end with node --test keeps the run unprovable, with the reason", () => {
  const root = workspaceProject({ alpha: "node --test test/", beta: "vitest run" });
  try {
    const plan = planTestReport({ checkoutPath: root, command, reportName: "unit" });
    assert.match(plan.unsupported ?? "", /workspace packages\/beta tests do not end with node --test/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
