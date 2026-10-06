import assert from "node:assert/strict";
import test from "node:test";

import { runDeliveryFactoryScenario, LOW_CONTENT } from "./support/delivery-factory-scenario.js";
import { runDeliveryBoundaryDirect } from "./support/delivery-boundary-harness.js";
import type { DeliveryBoundaryScope } from "../src/delivery-acceptance.js";

/**
 * TX-1 parity: the fast harness cannot drift from production. For one
 * accepted and one not-accepted scenario, the full factory pump and the
 * harness must agree on the tests-check outcome, counts, runner and reason.
 * The not-accepted scenario must reach a delivery boundary on both paths:
 * zero-test projects are pre-boundary test-integrity refusals (the factory
 * pauses before any boundary for lack of a usable initial executed-test
 * baseline, which the fast harness does not model), and a failing-test
 * fixture would make WorkerModel's existing submission summary and
 * validationScope falsely claim "node --test passes". So the negative case
 * keeps the normal passing VALUE_TEST (worker node --test truthfully
 * passes) and adds a deliberately failing build script; both paths reach
 * the shared boundary with tests passing and the build check failing.
 */

function testsCheckOf(boundary: DeliveryBoundaryScope) {
  return boundary.checks.find((check) => check.checkId === "tests") as {
    outcome: string;
    report?: { counts?: unknown; runner?: string };
    reason?: string;
  };
}

function buildCheckOf(boundary: DeliveryBoundaryScope) {
  const check = boundary.checks.find((check) => check.checkId === "build") as {
    outcome: string;
    reason?: string;
  } | undefined;
  assert.ok(check, "expected a build check on the delivery boundary");
  return check;
}

test("parity: accepted scenario agrees between the factory pump and the harness", async () => {
  const scripts = { test: "node --test" };
  const { boundary: factoryBoundary } = await runDeliveryFactoryScenario(LOW_CONTENT, scripts);
  const { boundary: harnessBoundary } = await runDeliveryBoundaryDirect(LOW_CONTENT, scripts);
  const factory = testsCheckOf(factoryBoundary);
  const harness = testsCheckOf(harnessBoundary);
  assert.equal(harness.outcome, factory.outcome);
  assert.deepEqual(harness.report!.counts, factory.report!.counts);
  assert.equal(harness.report!.runner, factory.report!.runner);
  assert.equal(harness.reason, factory.reason);
});

test("parity: failing-build scenario agrees between the factory pump and the harness", async () => {
  // Passing VALUE_TEST keeps the worker/reviewer claims truthful; the
  // failing build script drives the shared not-accepted boundary.
  const scripts = { test: "node --test", build: "node -e \"process.exit(1)\"" };
  const { boundary: factoryBoundary } = await runDeliveryFactoryScenario(LOW_CONTENT, scripts, { expect: "not_accepted" });
  const { boundary: harnessBoundary } = await runDeliveryBoundaryDirect(LOW_CONTENT, scripts);
  assert.equal(factoryBoundary.passed, false);
  assert.equal(harnessBoundary.passed, false);
  const factoryTests = testsCheckOf(factoryBoundary);
  const harnessTests = testsCheckOf(harnessBoundary);
  assert.equal(factoryTests.outcome, "passed");
  assert.equal(harnessTests.outcome, factoryTests.outcome);
  assert.deepEqual(harnessTests.report!.counts, factoryTests.report!.counts);
  assert.equal(harnessTests.report!.runner, factoryTests.report!.runner);
  assert.equal(harnessTests.reason, factoryTests.reason);
  const factoryBuild = buildCheckOf(factoryBoundary);
  const harnessBuild = buildCheckOf(harnessBoundary);
  assert.equal(factoryBuild.outcome, "failed");
  assert.equal(harnessBuild.outcome, factoryBuild.outcome);
  assert.equal(harnessBuild.reason, factoryBuild.reason);
});
