import assert from "node:assert/strict";
import { createRequire } from "node:module";
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
  // R8-B1: the fixture project has no node_modules of its own, so this test
  // puts this repository's node_modules/.bin (which holds tsx) first on the
  // execution host's ambient PATH. It does not depend on the caller's PATH.
  const bin = join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "..", ".bin");
  const { boundary } = await runDeliveryBoundaryDirect(LOW_CONTENT, { test: "tsx --test" }, { pathPrefix: bin });
  const tests = boundary.checks.find((check) => check.checkId === "tests")!;
  assert.equal(tests.outcome, "passed", JSON.stringify(tests));
  assert.equal(tests.report!.counts!.selected, 1);
  assert.equal(boundary.passed, true);
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
