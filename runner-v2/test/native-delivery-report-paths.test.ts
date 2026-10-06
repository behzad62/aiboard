import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { LOW_CONTENT } from "./support/delivery-factory-scenario.js";
import { runDeliveryBoundaryDirect } from "./support/delivery-boundary-harness.js";

test("N-R6-2: cd <dir> && node --test writes this run's report to the absolute runner-owned path and is accepted", async () => {
  const { boundary } = await runDeliveryBoundaryDirect(LOW_CONTENT, { test: "cd test && node --test" });
  const tests = boundary.checks.find((check) => check.checkId === "tests")!;
  assert.equal(tests.outcome, "passed", JSON.stringify(tests));
  assert.equal(tests.report!.counts!.selected, 1);
  assert.equal(boundary.passed, true);
});

test("R7-B1: a tsx --test script writes this run's report through node's runner and is accepted", async () => {
  // R7-B1: the fixture project has no node_modules of its own, so this test
  // provides tsx as an independently available user/project tool outside the
  // Runner install root. Runner-owned install paths (the install root and its
  // node_modules) are intentionally stripped from the child PATH by
  // createChildEnvironmentFactory, so the Runner's own node_modules/.bin
  // cannot be inherited here; this temp tool directory simulates that
  // independently available tsx executable. It does not depend on the
  // caller's PATH.
  const tsxCli = join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist", "cli.mjs");
  const toolDir = mkdtempSync(join(tmpdir(), "aiboard-tsx-tools-"));
  try {
    writeFileSync(join(toolDir, "tsx.cmd"), `@ECHO off\r\n"${process.execPath}" "${tsxCli}" %*\r\n`);
    // POSIX hosts resolve `tsx`, not `tsx.cmd`.
    writeFileSync(join(toolDir, "tsx"), `#!/bin/sh\nexec "${process.execPath}" "${tsxCli}" "$@"\n`);
    chmodSync(join(toolDir, "tsx"), 0o755);
    const { boundary } = await runDeliveryBoundaryDirect(LOW_CONTENT, { test: "tsx --test" }, { pathPrefix: toolDir });
    const tests = boundary.checks.find((check) => check.checkId === "tests")!;
    assert.equal(tests.outcome, "passed", JSON.stringify(tests));
    assert.equal(tests.report!.counts!.selected, 1);
    assert.equal(boundary.passed, true);
  } finally {
    rmSync(toolDir, { recursive: true, force: true });
  }
});

test("N-R7-1: cd <sibling> && node --test with a ../ path and a name pattern that selects no test is not accepted", async () => {
  const { boundary } = await runDeliveryBoundaryDirect(LOW_CONTENT, { test: 'cd src && node --test --test-name-pattern=nomatch "../test/*.test.mjs"' });
  const tests = boundary.checks.find((check) => check.checkId === "tests")!;
  assert.equal(tests.outcome, "unknown", JSON.stringify(tests));
  assert.equal(tests.report!.counts!.selected, 0);
  assert.equal(boundary.passed, false);
});

test("N-R7-1: cd <sibling> && node --test with a ../ path to a file with no test() call is not accepted", async () => {
  const { boundary } = await runDeliveryBoundaryDirect(LOW_CONTENT, { test: 'cd src && node --test "../test/*.test.mjs"' }, { testFile: 'import "../src/value.mjs";\n' });
  const tests = boundary.checks.find((check) => check.checkId === "tests")!;
  assert.equal(tests.outcome, "unknown", JSON.stringify(tests));
  assert.equal(tests.report!.counts!.selected, 0);
  assert.equal(boundary.passed, false);
});
