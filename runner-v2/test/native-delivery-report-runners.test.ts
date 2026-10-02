import assert from "node:assert/strict";
import test from "node:test";

import { LOW_CONTENT } from "./support/delivery-factory-scenario.js";
import { runDeliveryBoundaryDirect } from "./support/delivery-boundary-harness.js";

test("R5-B3: node --test with an explicit glob writes this run's report and is accepted", async () => {
  const { boundary } = await runDeliveryBoundaryDirect(LOW_CONTENT, { test: "node --test test/*.test.mjs" });
  const tests = boundary.checks.find((check) => check.checkId === "tests")!;
  assert.equal(tests.outcome, "passed", JSON.stringify(tests));
  assert.equal(tests.report!.counts!.selected, 1);
  assert.equal(boundary.passed, true);
});

test("NODE_OPTIONS: a project's own NODE_OPTIONS is kept while this run's report is written, and the task is accepted", async () => {
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--max-old-space-size=3072";
  try {
    const { boundary } = await runDeliveryBoundaryDirect(LOW_CONTENT, { test: "node --test" }, {
      // The test itself proves the project's setting reached the test process.
      testFile: "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value', () => { assert.equal(value, 2); assert.match(process.env.NODE_OPTIONS ?? '', /--max-old-space-size=3072/); });\n",
    });
    const tests = boundary.checks.find((check) => check.checkId === "tests")!;
    assert.equal(tests.outcome, "passed", JSON.stringify(tests));
    assert.equal(tests.report!.counts!.passed, 1);
    assert.equal(boundary.passed, true);
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
});

test("R6-B1: a name pattern that selects no test is not accepted (node's file-level entry is not a test)", async () => {
  const { boundary } = await runDeliveryBoundaryDirect(LOW_CONTENT, { test: "node --test --test-name-pattern=nomatch" });
  const tests = boundary.checks.find((check) => check.checkId === "tests")!;
  assert.equal(tests.exitCode, 0);
  assert.equal(tests.outcome, "unknown");
  assert.equal(tests.report!.counts!.selected, 0);
  assert.match(tests.reason!, /file-level entries.*filters tests by name/);
  assert.equal(boundary.passed, false);
});

test("R6-B1: a name pattern that selects a real test is accepted", async () => {
  const { boundary } = await runDeliveryBoundaryDirect(LOW_CONTENT, { test: "node --test --test-name-pattern=value" });
  const tests = boundary.checks.find((check) => check.checkId === "tests")!;
  assert.equal(tests.outcome, "passed", JSON.stringify(tests));
  assert.equal(tests.report!.counts!.selected, 1);
  assert.equal(boundary.passed, true);
});
