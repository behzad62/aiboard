/** Regression check for Architect inspection budget constants. */
import assert from "node:assert/strict";
import {
  ARCHITECT_RANGE_READS_PER_PHASE,
  ARCHITECT_READS_PER_PHASE,
  ARCHITECT_REVIEW_RANGE_READS_PER_PHASE,
  ARCHITECT_REVIEW_READS_PER_PHASE,
  ARCHITECT_REVIEW_SEARCHES_PER_PHASE,
  ARCHITECT_SEARCHES_PER_PHASE,
} from "../lib/orchestrator/build-architect-budgets";

assert.equal(ARCHITECT_READS_PER_PHASE, 20);
assert.equal(ARCHITECT_RANGE_READS_PER_PHASE, 30);
assert.equal(ARCHITECT_SEARCHES_PER_PHASE, 20);
assert.equal(ARCHITECT_REVIEW_READS_PER_PHASE, 32);
assert.equal(ARCHITECT_REVIEW_RANGE_READS_PER_PHASE, 48);
assert.equal(ARCHITECT_REVIEW_SEARCHES_PER_PHASE, 32);
assert.ok(
  ARCHITECT_REVIEW_READS_PER_PHASE > ARCHITECT_READS_PER_PHASE,
  "review reads should exceed planning reads"
);
assert.ok(
  ARCHITECT_REVIEW_RANGE_READS_PER_PHASE > ARCHITECT_RANGE_READS_PER_PHASE,
  "review range reads should exceed planning range reads"
);
assert.ok(
  ARCHITECT_REVIEW_SEARCHES_PER_PHASE > ARCHITECT_SEARCHES_PER_PHASE,
  "review searches should exceed planning searches"
);

console.log("PASS build architect budgets");
