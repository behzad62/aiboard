import assert from "node:assert/strict";
import test from "node:test";

import { createSubmitCoverageVerdictTool } from "../src/planning-review.js";

const prior = [
  { obligationId: "o1", verdict: "covered", severity: "blocking" as const, rationale: "task-1 owns it", evidenceRefs: ["plan:task-1"] },
  { obligationId: "o2", verdict: "covered", severity: "blocking" as const, rationale: "task-2 owns it", evidenceRefs: ["plan:task-2"] },
];
const tool = (priorObligationVerdicts?: typeof prior) => createSubmitCoverageVerdictTool({
  authority: {} as never,
  runId: "r",
  reviewId: "coverage-v2",
  reviewerRuntimeId: "rev",
  independence: "fresh_context",
  sourceReadManifestId: "m",
  planRevisionId: "plan-v2",
  planRevisionDigest: "d".repeat(64),
  obligationIds: ["o1", "o2"],
  priorReviewId: "coverage-v1",
  priorFindingIds: [],
  ...(priorObligationVerdicts ? { priorObligationVerdicts } : {}),
  runtimeId: "rev",
  sessionId: "s",
});

test("a re-review restates only the obligations its diff affects and carries the rest forward", () => {
  const restated = { obligationId: "o1", verdict: "covered", severity: "blocking", rationale: "task-1 now lists its files", evidenceRefs: ["plan:task-1"] };
  const result = tool(prior).validate({ obligationVerdicts: [restated], carryForwardObligationIds: ["o2"], findings: [], priorFindingChecks: [] });
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join("; "));
  if (!result.ok) return;
  assert.deepEqual(result.value.obligationVerdicts.map((verdict) => [verdict.obligationId, verdict.rationale]), [
    ["o1", "task-1 now lists its files"],
    ["o2", "Carried forward from coverage-v1: task-2 owns it"],
  ]);

  const issues = (input: unknown, verdicts?: typeof prior) => { const outcome = tool(verdicts).validate(input); return outcome.ok ? [] : outcome.issues; };
  assert.match(issues({ obligationVerdicts: [restated], carryForwardObligationIds: ["o1", "o2"], findings: [] }, prior)[0]!, /both restated and carried forward/);
  assert.match(issues({ obligationVerdicts: [restated], findings: [] }, prior)[0]!, /o2 has no recorded verdict \(restate it or carry it forward\)/);
  assert.match(issues({ obligationVerdicts: [restated], carryForwardObligationIds: ["o2"], findings: [] })[0]!, /only for a re-review/, "no prior verdicts, no carry-forward");
});
