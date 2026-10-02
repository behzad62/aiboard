import assert from "node:assert/strict";
import test from "node:test";

import { runDeliveryFactoryScenario, LOW_CONTENT, HIGH_CONTENT, BUILD_SCRIPTS } from "./support/delivery-factory-scenario.js";

test("B2/B9: a high-tier factory review runs the real affected-test command and OA-11 probe through the audited executor", async () => {
  const { review } = await runDeliveryFactoryScenario(HIGH_CONTENT);
  assert.equal(review.depth!.affectedTests!.executedScope, "full_test_script", "the record states that the whole test script ran");
  assert.equal(review.risk!.tier, "high");
  assert.ok(review.obligations && review.obligations.length > 0);
  const affected = review.depth!.affectedTests!;
  assert.equal(affected.outcome, "passed", JSON.stringify(affected));
  assert.equal(affected.exitCode, 0);
  assert.ok(affected.evidenceIds.length > 0);
  assert.deepEqual(affected.changedFiles, ["src/value.mjs"]);
  assert.ok(affected.fullSuiteCount >= 1);
  assert.equal(affected.report.status, "passed", "real counts: this run's own JUnit report");
  assert.ok((affected.report.counts?.passed ?? 0) >= 1);
  assert.match(affected.report.path!, /^\.aiboard-report-[a-f0-9]{24}\.xml$/);
  const probe = review.depth!.probe!;
  assert.ok(probe.mutantsExecuted > 0, JSON.stringify(probe));
  assert.ok(probe.evidenceIds.length >= probe.mutantsExecuted, "each probe command is recorded evidence");
});

test("R4-B1: a project with a build script reaches task and phase acceptance at medium tier (build and tests both run)", async () => {
  const { review, boundary } = await runDeliveryFactoryScenario(LOW_CONTENT, BUILD_SCRIPTS);
  assert.equal(review.risk!.tier, "medium");
  assert.deepEqual(boundary.checks.map((check) => [check.checkId, check.outcome]), [["build", "passed"], ["tests", "passed"]]);
  assert.equal(boundary.executedScope, "full_test_script");
});
