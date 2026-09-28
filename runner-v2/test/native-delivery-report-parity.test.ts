import assert from "node:assert/strict";
import test from "node:test";

import { runDeliveryFactoryScenario, LOW_CONTENT } from "./support/delivery-factory-scenario.js";
import { runDeliveryBoundaryDirect } from "./support/delivery-boundary-harness.js";
import type { DeliveryBoundaryRecord } from "../src/delivery-acceptance.js";

/**
 * TX-1 parity: the fast harness cannot drift from production. For one
 * accepted and one not-accepted scenario, the full factory pump and the
 * harness must agree on the tests-check outcome, counts, runner and reason.
 */

function testsCheckOf(boundary: DeliveryBoundaryRecord) {
  return boundary.checks.find((check) => check.checkId === "tests") as {
    outcome: string;
    report?: { counts?: unknown; runner?: string };
    reason?: string;
  };
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

test("parity: not-accepted scenario agrees between the factory pump and the harness", async () => {
  const scripts = { test: "node --test" };
  const { boundary: factoryBoundary } = await runDeliveryFactoryScenario(LOW_CONTENT, scripts, { testFile: null, expect: "not_accepted" });
  const { boundary: harnessBoundary } = await runDeliveryBoundaryDirect(LOW_CONTENT, scripts, { testFile: null });
  const factory = testsCheckOf(factoryBoundary);
  const harness = testsCheckOf(harnessBoundary);
  assert.equal(harness.outcome, factory.outcome);
  assert.deepEqual(harness.report!.counts, factory.report!.counts);
  assert.equal(harness.report!.runner, factory.report!.runner);
  assert.equal(harness.reason, factory.reason);
});
