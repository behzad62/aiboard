import assert from "node:assert/strict";
import test from "node:test";
import { assertContractTaskRevisionAllowed } from "../src/delivery-acceptance.js";
import { assertCritiqueReconciledByPlanRevision } from "../src/scheduler-store.js";

test("a refused contract change tells the Architect the valid ways forward", () => {
  const refuse = (patch: Parameters<typeof assertContractTaskRevisionAllowed>[0]["patch"]) =>
    assert.throws(
      () => assertContractTaskRevisionAllowed({ taskId: "p7-baseline", patch, contract: { dependencies: ["a"] } }),
      (error: Error) =>
        /contract (fields|dependencies) change only through a new ready plan revision/.test(error.message) &&
        /revise_planning_plan/.test(error.message) &&
        /plan_reconciled/.test(error.message) &&
        /Do not resend this change unchanged/.test(error.message),
    );
  refuse({ acceptanceCriteria: [{ id: "c1", text: "changed" }] });
  refuse({ dependencies: ["b"] });
  assert.doesNotThrow(() => assertContractTaskRevisionAllowed({ taskId: "p7-baseline", patch: { dependencies: ["a"] }, contract: { dependencies: ["a"] } }));
});

test("evidence-gated critique findings reconcile only through a newer, not-yet-ready plan revision", () => {
  const plan = { currentRevisionId: "p7-plan-r3", currentDigest: "d3" };
  const reconciled = [{ findingId: "F1", resolution: "plan_reconciled" as const, rationale: "fixed", planRevisionId: "p7-plan-r3", planDigest: "d3" }];
  assert.doesNotThrow(() =>
    assertCritiqueReconciledByPlanRevision({ reconciled, hasPlanReconciliation: false, plan, readiness: "not_ready" }));
  assert.throws(
    () => assertCritiqueReconciledByPlanRevision({ reconciled, hasPlanReconciliation: false, plan, readiness: "ready" }),
    /call revise_planning_plan first/,
    "the already-started plan cannot be cited as the reconciliation",
  );
  assert.throws(
    () => assertCritiqueReconciledByPlanRevision({
      reconciled: [{ ...reconciled[0]!, planRevisionId: "p7-plan-r2" }],
      hasPlanReconciliation: false,
      plan,
      readiness: "not_ready",
    }),
    /must cite the current plan revision p7-plan-r3/,
  );
  assert.throws(
    () => assertCritiqueReconciledByPlanRevision({ reconciled, hasPlanReconciliation: true, plan, readiness: "not_ready" }),
    /must not also carry a planReconciliation/,
  );
});
