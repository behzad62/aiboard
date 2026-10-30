import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { removeRunnerReports } from "../src/delivery-execution.js";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "aiboard-report-cleanup-"));
  const checkout = join(base, "checkout");
  const outside = join(base, "outside");
  mkdirSync(join(checkout, "packages", "alpha"), { recursive: true });
  mkdirSync(outside);
  return { base, checkout, outside };
}

test("report cleanup removes the runner's own report inside the checkout", (t) => {
  const { base, checkout } = fixture();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const report = join(checkout, "packages", "alpha", ".aiboard-report-unit.xml");
  writeFileSync(report, "<testsuites/>");

  removeRunnerReports({ runner: "node", reportSet: { kind: "node-workspace-reports", reportPaths: ["packages/alpha/.aiboard-report-unit.xml"] } }, checkout);

  assert.equal(existsSync(report), false);
});

test("report cleanup never deletes through a workspace folder linked outside the checkout", (t) => {
  const { base, checkout, outside } = fixture();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  // A junction on Windows (no privilege needed), a directory symlink elsewhere.
  symlinkSync(outside, join(checkout, "packages", "linked"), "junction");
  const foreign = join(outside, ".aiboard-report-unit.xml");
  writeFileSync(foreign, "<testsuites/>");

  removeRunnerReports({ runner: "node", reportSet: { kind: "node-workspace-reports", reportPaths: ["packages/linked/.aiboard-report-unit.xml"] } }, checkout);

  assert.equal(existsSync(foreign), true, "a report-named file outside the checkout must survive cleanup");
});

test("report cleanup ignores names and paths it does not own", (t) => {
  const { base, checkout } = fixture();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = join(checkout, "results.xml");
  const escaped = join(base, ".aiboard-report-unit.xml");
  writeFileSync(project, "<testsuites/>");
  writeFileSync(escaped, "<testsuites/>");

  removeRunnerReports({ runner: "node", reportPath: "results.xml" }, checkout);
  removeRunnerReports({ runner: "node", reportPath: "../.aiboard-report-unit.xml" }, checkout);

  assert.equal(existsSync(project), true);
  assert.equal(existsSync(escaped), true);
});
