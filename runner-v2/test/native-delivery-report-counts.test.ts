import assert from "node:assert/strict";
import test from "node:test";

import { LOW_CONTENT, STALE_JUNIT } from "./support/delivery-factory-scenario.js";
import { runDeliveryBoundaryDirect } from "./support/delivery-boundary-harness.js";

test("real counts: a test command that runs zero tests is not accepted and the Architect gets the named reason", async () => {
  const { boundary } = await runDeliveryBoundaryDirect(LOW_CONTENT, { test: "node --test" }, { testFile: null });
  const tests = boundary.checks.find((check) => check.checkId === "tests")!;
  assert.equal(tests.exitCode, 0);
  assert.equal(tests.outcome, "unknown");
  assert.equal(tests.report!.runner, "node --test");
  assert.equal(tests.report!.counts!.passed, 0);
  assert.match(tests.reason!, /exited 0 but did not prove a run: .*(at least one executed test|no testsuites).*runner: node --test/);
  assert.equal(boundary.passed, false);
});

test("real counts: an old committed junit.xml is never read as this run's result", async () => {
  const { boundary } = await runDeliveryBoundaryDirect(LOW_CONTENT, { test: "node --test" }, {
    testFile: null,
    extraFiles: { "junit.xml": STALE_JUNIT, "test-results.xml": STALE_JUNIT },
  });
  const tests = boundary.checks.find((check) => check.checkId === "tests")!;
  assert.equal(tests.outcome, "unknown");
  assert.match(tests.report!.path!, /^\.aiboard-report-[a-f0-9]{24}\.xml$/, "only this run's fresh report path is read");
  assert.equal(tests.report!.counts!.selected, 0, "the committed 5-test report was ignored");
  assert.equal(boundary.passed, false);
});

test("real counts: an unrecognized test runner is not accepted and the reason names it", async () => {
  const { boundary } = await runDeliveryBoundaryDirect(LOW_CONTENT, { test: "node -e 0" });
  const tests = boundary.checks.find((check) => check.checkId === "tests")!;
  assert.equal(tests.exitCode, 0);
  assert.equal(tests.outcome, "unknown");
  assert.match(tests.reason!, /not a test runner the runner can make write a machine-readable report/);
  assert.match(tests.reason!, /runner: "node -e/);
  assert.equal(boundary.passed, false);
});

test("R5-B1: an empty describe (zero tests) is not accepted", async () => {
  const { boundary } = await runDeliveryBoundaryDirect(LOW_CONTENT, { test: "node --test" }, {
    testFile: "import { describe } from 'node:test'; import { value } from '../src/value.mjs'; void value; describe('empty', () => {});\n",
  });
  const tests = boundary.checks.find((check) => check.checkId === "tests")!;
  assert.equal(tests.exitCode, 0);
  assert.equal(tests.outcome, "unknown");
  assert.deepEqual(tests.report!.counts, { selected: 0, passed: 0, failed: 0, skipped: 0 });
  assert.match(tests.reason!, /suites without tests do not count/);
  assert.equal(boundary.passed, false);
});

test("R5-B2: a script that masks a failing test command with || is unknown and not accepted", async () => {
  const { boundary } = await runDeliveryBoundaryDirect(LOW_CONTENT, { test: "node --test failing.mjs || node --test" }, {
    extraFiles: { "failing.mjs": "import test from 'node:test'; test('boom', () => { throw new Error('boom'); });\n" },
  });
  const tests = boundary.checks.find((check) => check.checkId === "tests")!;
  assert.equal(tests.outcome, "unknown");
  assert.match(tests.reason!, /joins commands with "\|\|"/);
  assert.equal(boundary.passed, false);
});

test("B1: the kernel record validation rejects a boundary whose tests report counts were edited", async () => {
  await assert.rejects(
    runDeliveryBoundaryDirect(LOW_CONTENT, { test: "node --test" }, {
      mutateBoundaryForTest: (boundary) => {
        // The reviewer's probe shape: the report now claims a failure while
        // the check outcome stays passed.
        boundary.checks.find((check) => check.checkId === "tests")!.report!.counts!.failed = 1;
      },
    }),
    /at least one executed and zero failed/,
  );
});
