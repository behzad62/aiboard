import assert from "node:assert/strict";
import test from "node:test";

import { runDeliveryFactoryScenario, LOW_CONTENT, HIGH_CONTENT, BUILD_SCRIPTS } from "./support/delivery-factory-scenario.js";

test("B9: NativeBuildFactory wires the deliverable review and boundary checks from submission to task and phase acceptance", async () => {
  const { review } = await runDeliveryFactoryScenario(LOW_CONTENT);
  assert.equal(review.risk!.tier, "medium");
  assert.equal(review.depth!.affectedTests, undefined);
});

test("R4-B1: a project with a build script reaches task and phase acceptance at high tier (depth runs the real tests)", async () => {
  const { review, boundary } = await runDeliveryFactoryScenario(HIGH_CONTENT, BUILD_SCRIPTS);
  assert.equal(review.risk!.tier, "high");
  assert.equal(review.depth!.affectedTests!.outcome, "passed", JSON.stringify(review.depth!.affectedTests));
  assert.deepEqual(boundary.checks.map((check) => [check.checkId, check.outcome]), [["build", "passed"], ["tests", "passed"], ["test_integrity", "passed"]]);
});
