/** Regression check for Architect inspection budget constants. */
import assert from "node:assert/strict";
import {
  ARCHITECT_RANGE_READS_PER_PHASE,
  ARCHITECT_READS_PER_PHASE,
  ARCHITECT_SEARCHES_PER_PHASE,
} from "../lib/orchestrator/build-architect-budgets";

assert.equal(ARCHITECT_READS_PER_PHASE, 20);
assert.equal(ARCHITECT_RANGE_READS_PER_PHASE, 30);
assert.equal(ARCHITECT_SEARCHES_PER_PHASE, 20);

console.log("PASS build architect budgets");
