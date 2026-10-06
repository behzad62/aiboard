import assert from "node:assert/strict";
import test from "node:test";

import { runDeliveryBoundaryDirect } from "./support/delivery-boundary-harness.js";

/**
 * IV-2 (CD-23/EP16) boundary execution: a narrow module-graph rung RUNS
 * the selected tests through the audited executor; widening, full_suite,
 * unsupported shapes, and docs-only changes run the whole script.
 * The untouched workspace carries a sentinel test that fails when run, so
 * a passing boundary proves the sentinel never executed.
 */

const A_TEST = "packages/a/test/a.test.mjs";
const SENTINEL_TEST = "packages/b/test/sentinel.test.mjs";

const WORKSPACE_FILES: Record<string, string> = {
  "packages/a/package.json": JSON.stringify({ name: "a", version: "1.0.0" }),
  "packages/a/src/a.mjs": "export const a = 1;\n",
  "packages/a/test/a.test.mjs": [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { a } from "../src/a.mjs";',
    'test("a is one", () => assert.equal(a, 1));',
    "",
  ].join("\n"),
  "packages/b/package.json": JSON.stringify({ name: "b", version: "1.0.0" }),
  "packages/b/src/b.mjs": "export const b = 2;\n",
  [SENTINEL_TEST]: [
    'import test from "node:test";',
    'test("full-only sentinel", () => { throw new Error("SENTINEL RAN: the full suite executed"); });',
    "",
  ].join("\n"),
};

const PASSING_WORKSPACE_FILES: Record<string, string> = {
  ...WORKSPACE_FILES,
  [SENTINEL_TEST]: [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { b } from "../src/b.mjs";',
    'test("b is two", () => assert.equal(b, 2));',
    "",
  ].join("\n"),
};

function workspacesOptions(extraFiles: Record<string, string>, changedFiles: string[]) {
  return {
    manifestExtra: { workspaces: ["packages/a", "packages/b"] },
    skipDefaultFiles: true,
    extraFiles,
    changedFiles,
  };
}

test("IV-2 boundary runs exactly the selected tests for a narrow module-graph rung", async () => {
  const { boundary } = await runDeliveryBoundaryDirect("iv2-narrow", { test: "node --test" }, {
    ...workspacesOptions(WORKSPACE_FILES, ["packages/a/src/a.mjs"]),
  });
  assert.equal(boundary.executedScope, "selected");
  assert.equal(boundary.selection.rung, "module_graph");
  assert.deepEqual(boundary.selection.selectedTests, [A_TEST]);
  assert.equal(boundary.selection.widened, false);
  assert.deepEqual(boundary.selection.wideningReasons, []);
  const tests = boundary.checks.find((check) => check.checkId === "tests")!;
  assert.equal(tests.outcome, "passed");
  assert.deepEqual(tests.args!.slice(-2), ["--", A_TEST]);
  assert.ok(!tests.args!.some((arg) => arg.includes("sentinel")), "the executed argv never names the sentinel");
  assert.equal(tests.report?.status, "passed");
  assert.deepEqual(tests.report?.counts, { selected: 1, passed: 1, failed: 0, skipped: 0 });
  assert.ok(tests.evidenceIds.length > 0);
  assert.equal(boundary.passed, true, "the failing sentinel never ran, so the boundary passes");
});

test("IV-2 boundary runs the whole script when a widening trigger applies", async () => {
  const { boundary } = await runDeliveryBoundaryDirect("iv2-widened", { test: "node --test" }, {
    ...workspacesOptions(WORKSPACE_FILES, ["packages/a/src/a.mjs", "package-lock.json"]),
  });
  assert.equal(boundary.executedScope, "full_test_script");
  assert.equal(boundary.selection.widened, true);
  assert.ok((boundary.selection.wideningReasons ?? []).length > 0);
  const tests = boundary.checks.find((check) => check.checkId === "tests")!;
  assert.equal(tests.outcome, "failed", "the full run executes the failing sentinel");
  assert.equal(boundary.passed, false);
});

test("IV-2 boundary runs the whole script for a full_suite rung", async () => {
  const { boundary } = await runDeliveryBoundaryDirect("export const value = 2;\n", { test: "node --test" });
  assert.equal(boundary.executedScope, "full_test_script");
  assert.equal(boundary.selection.rung, "full_suite");
  const tests = boundary.checks.find((check) => check.checkId === "tests")!;
  assert.deepEqual(tests.args!.slice(-2), ["run", "test"]);
  assert.equal(tests.outcome, "passed");
  assert.equal(boundary.passed, true);
});

test("IV-2 boundary fails safe to the whole script for an unselectable test command", async () => {
  const { boundary } = await runDeliveryBoundaryDirect("iv2-unselectable", { test: "node --test --test-concurrency=1" }, {
    ...workspacesOptions(PASSING_WORKSPACE_FILES, ["packages/a/src/a.mjs"]),
  });
  assert.equal(boundary.executedScope, "full_test_script");
  assert.equal(boundary.selection.rung, "module_graph");
  const tests = boundary.checks.find((check) => check.checkId === "tests")!;
  assert.deepEqual(tests.args!.slice(-2), ["run", "test"], "no selected paths are appended to the full command");
  assert.equal(tests.outcome, "passed");
  assert.deepEqual(tests.report?.counts, { selected: 2, passed: 2, failed: 0, skipped: 0 });
  assert.equal(boundary.passed, true);
});

test("IV-2 boundary runs the whole script for docs-only changes (never fabricated as selected)", async () => {
  const { boundary } = await runDeliveryBoundaryDirect("export const value = 2;\n", { test: "node --test" }, {
    changedFiles: ["README.md"],
  });
  assert.equal(boundary.executedScope, "full_test_script");
  assert.equal(boundary.selection.rung, "no_tests_required");
  assert.deepEqual(boundary.selection.selectedTests, []);
  const tests = boundary.checks.find((check) => check.checkId === "tests")!;
  assert.equal(tests.outcome, "passed");
  assert.equal(boundary.passed, true);
});
