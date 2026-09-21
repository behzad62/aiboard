import assert from "node:assert/strict";
import test from "node:test";

import {
  assessPlanRisk,
  parsePlanCritiqueFindings,
  planCritiqueRequired,
  PLAN_CRITIQUE_CATEGORIES,
  PLAN_CRITIQUE_FAN_IN_THRESHOLD,
  PLAN_CRITIQUE_MAX_FINDINGS,
  PLAN_CRITIQUE_TASK_COUNT_THRESHOLD,
} from "../src/plan-critique-contracts.js";
import type { BuildTask } from "../src/task-contracts.js";

function task(id: string, dependencies: string[] = []): BuildTask {
  return {
    id, objective: `Do ${id}`, dependencies, status: "planned", requiredCapabilities: ["code"], attempt: 0,
    acceptanceCriteria: [{ id: "AC-1", text: `${id} works.` }], acceptanceCriteriaVersion: 1,
  };
}

test("plan risk is high on Architect declaration, strict qualification, task count, or dependency fan-in", () => {
  const low = assessPlanRisk({
    architectDeclaration: "low", stricterQualification: false, tasks: [task("A"), task("B"), task("C", ["A"])],
  });
  assert.deepEqual(low, { risk: "low", reasons: [] });
  assert.equal(PLAN_CRITIQUE_TASK_COUNT_THRESHOLD, 4);
  const count = assessPlanRisk({
    architectDeclaration: "low", stricterQualification: false,
    tasks: [task("A"), task("B"), task("C"), task("D")],
  });
  assert.deepEqual(count.reasons, [{ code: "task_count", evidence: ["tasks:4"] }]);
  assert.equal(count.risk, "high");
  const fanIn = assessPlanRisk({
    architectDeclaration: "low", stricterQualification: false,
    tasks: [task("A"), task("B"), task("C", ["A", "B"])],
  });
  assert.deepEqual(fanIn.reasons, [{ code: "dependency_fan_in", evidence: ["C:2"] }]);
  assert.equal(PLAN_CRITIQUE_FAN_IN_THRESHOLD, 2);
  const declared = assessPlanRisk({ architectDeclaration: "high", stricterQualification: true, tasks: [task("A")] });
  assert.deepEqual(declared.reasons.map((reason) => reason.code), ["architect_declared_high", "stricter_qualification"]);
  assert.equal(planCritiqueRequired("risk_based", low), false);
  assert.equal(planCritiqueRequired("risk_based", count), true);
  assert.equal(planCritiqueRequired("always", low), true);
  assert.equal(planCritiqueRequired("off", declared), false);
});

test("findings are validated against the current plan", () => {
  const tasks = { A: task("A"), B: task("B") };
  const valid = parsePlanCritiqueFindings([{
    findingId: "F-1", severity: "blocking", category: "untestable_criterion",
    taskIds: ["A"], criterionIds: [{ taskId: "A", criterionId: "AC-1" }],
    claim: "AC-1 has no observable behavior to test.", evidence: ["A/AC-1: 'A works.'"],
  }, {
    findingId: "F-2", severity: "advisory", category: "missing_integration_task", taskIds: [],
    claim: "No task integrates A and B.", evidence: ["task graph has no task depending on both A and B"],
  }], tasks);
  assert.equal(valid.length, 2);
  assert.throws(() => parsePlanCritiqueFindings([{
    findingId: "F-1", severity: "blocking", category: "overlapping_scope", taskIds: ["Z"], claim: "x", evidence: ["y"],
  }], tasks), /references unknown task Z/);
  assert.throws(() => parsePlanCritiqueFindings([{
    findingId: "F-1", severity: "blocking", category: "overlapping_scope", taskIds: ["A"], claim: "x", evidence: [],
  }], tasks), /requires at least one evidence string/);
  assert.throws(() => parsePlanCritiqueFindings([
    { findingId: "F-1", severity: "blocking", category: "overlapping_scope", taskIds: ["A"], claim: "x", evidence: ["y"] },
    { findingId: "F-1", severity: "advisory", category: "oversized_task", taskIds: ["B"], claim: "x", evidence: ["y"] },
  ], tasks), /duplicate finding F-1/);
  assert.throws(() => parsePlanCritiqueFindings([{
    findingId: "F-1", severity: "fatal", category: "overlapping_scope", taskIds: ["A"], claim: "x", evidence: ["y"],
  }], tasks), /severity fatal is invalid/);
  assert.throws(() => parsePlanCritiqueFindings([{
    findingId: "F-1", severity: "blocking", category: "style", taskIds: ["A"], claim: "x", evidence: ["y"],
  }], tasks), /category style is invalid/);
});

test("cancelled and final-verification tasks are excluded from risk count and fan-in", () => {
  const cancelled = { ...task("D"), status: "cancelled" as const };
  const finalVerification = { ...task("FV"), kind: "final_verification" as const };
  const belowThreshold = assessPlanRisk({
    architectDeclaration: "low",
    stricterQualification: false,
    tasks: [task("A"), task("B"), task("C"), cancelled, finalVerification],
  });
  assert.deepEqual(belowThreshold, { risk: "low", reasons: [] });
  const fanInOnCancelled = assessPlanRisk({
    architectDeclaration: "low",
    stricterQualification: false,
    tasks: [task("A"), task("B"), { ...task("C", ["A", "B"]), status: "cancelled" }],
  });
  assert.deepEqual(fanInOnCancelled, { risk: "low", reasons: [] });
  const fanInOnFinalVerification = assessPlanRisk({
    architectDeclaration: "low",
    stricterQualification: false,
    tasks: [task("A"), task("B"), { ...task("C", ["A", "B"]), kind: "final_verification" }],
  });
  assert.deepEqual(fanInOnFinalVerification, { risk: "low", reasons: [] });
});

test("each plan-risk trigger is independently sufficient and independently visible", () => {
  assert.deepEqual(
    assessPlanRisk({ architectDeclaration: "high", stricterQualification: false, tasks: [task("A")] }).reasons,
    [{ code: "architect_declared_high", evidence: ["architect:high"] }],
  );
  assert.deepEqual(
    assessPlanRisk({ architectDeclaration: "low", stricterQualification: true, tasks: [task("A")] }).reasons,
    [{ code: "stricter_qualification", evidence: ["qualification:strict"] }],
  );
  const combined = assessPlanRisk({
    architectDeclaration: "high",
    stricterQualification: true,
    tasks: [task("A"), task("B"), task("C"), task("D", ["A", "B"])],
  });
  assert.deepEqual(combined.reasons.map((reason) => reason.code), [
    "architect_declared_high",
    "stricter_qualification",
    "task_count",
    "dependency_fan_in",
  ]);
  assert.deepEqual(combined.reasons.find((reason) => reason.code === "dependency_fan_in")?.evidence, ["D:2"]);
});

test("plan critique required is false for off, true for always, and risk-gated for risk_based", () => {
  const low = { risk: "low" as const, reasons: [] };
  const high = { risk: "high" as const, reasons: [{ code: "task_count" as const, evidence: ["tasks:4"] }] };
  assert.equal(planCritiqueRequired("off", low), false);
  assert.equal(planCritiqueRequired("off", high), false);
  assert.equal(planCritiqueRequired("always", low), true);
  assert.equal(planCritiqueRequired("always", high), true);
  assert.equal(planCritiqueRequired("risk_based", low), false);
  assert.equal(planCritiqueRequired("risk_based", high), true);
});

test("findings reject cancelled tasks, final-verification tasks, and unknown criteria independently", () => {
  const tasks = {
    A: task("A"),
    B: { ...task("B"), status: "cancelled" as const },
    FV: { ...task("FV"), kind: "final_verification" as const },
  };
  assert.throws(() => parsePlanCritiqueFindings([{
    findingId: "F-1", severity: "blocking", category: "overlapping_scope", taskIds: ["B"], claim: "x", evidence: ["y"],
  }], tasks), /references unknown task B/);
  assert.throws(() => parsePlanCritiqueFindings([{
    findingId: "F-1", severity: "blocking", category: "overlapping_scope", taskIds: ["FV"], claim: "x", evidence: ["y"],
  }], tasks), /references unknown task FV/);
  assert.throws(() => parsePlanCritiqueFindings([{
    findingId: "F-1", severity: "blocking", category: "untestable_criterion", taskIds: ["A"],
    criterionIds: [{ taskId: "A", criterionId: "AC-MISSING" }], claim: "x", evidence: ["y"],
  }], tasks), /references unknown criterion A:AC-MISSING/);
  assert.throws(() => parsePlanCritiqueFindings([{
    findingId: "F-1", severity: "blocking", category: "untestable_criterion", taskIds: ["A"],
    criterionIds: [{ taskId: "Z", criterionId: "AC-1" }], claim: "x", evidence: ["y"],
  }], tasks), /references unknown criterion Z:AC-1/);
});

test("findings reject non-arrays, oversize batches, empty claims, and invalid entries independently", () => {
  const tasks = { A: task("A") };
  assert.throws(() => parsePlanCritiqueFindings({}, tasks), /must be an array/);
  assert.throws(
    () => parsePlanCritiqueFindings(
      Array.from({ length: PLAN_CRITIQUE_MAX_FINDINGS + 1 }, (_, index) => ({
        findingId: `F-${index}`,
        severity: "advisory",
        category: "oversized_task",
        taskIds: ["A"],
        claim: "x",
        evidence: ["y"],
      })),
      tasks,
    ),
    /at most 50 findings/,
  );
  assert.equal(PLAN_CRITIQUE_MAX_FINDINGS, 50);
  assert.throws(() => parsePlanCritiqueFindings([null], tasks), /finding 0 is invalid/);
  assert.throws(() => parsePlanCritiqueFindings([[]], tasks), /finding 0 is invalid/);
  assert.throws(() => parsePlanCritiqueFindings([{
    findingId: "F-1", severity: "blocking", category: "overlapping_scope", taskIds: ["A"], claim: "   ", evidence: ["y"],
  }], tasks), /claim is required/);
  assert.throws(() => parsePlanCritiqueFindings([{
    findingId: "F-1", severity: "blocking", category: "overlapping_scope", taskIds: ["A"], evidence: ["y"],
  }], tasks), /claim is required/);
  assert.throws(() => parsePlanCritiqueFindings([{
    findingId: "F-1", severity: "blocking", category: "overlapping_scope", taskIds: ["A"], claim: "x", evidence: ["  "],
  }], tasks), /must contain non-empty strings/);
  assert.throws(() => parsePlanCritiqueFindings([{
    findingId: "F-1", severity: "blocking", category: "overlapping_scope", taskIds: "A", claim: "x", evidence: ["y"],
  }], tasks), /must contain non-empty strings/);
});

test("every published finding category is accepted and duplicate task ids are stored once", () => {
  const tasks = { A: task("A"), B: task("B") };
  const parsed = parsePlanCritiqueFindings(
    PLAN_CRITIQUE_CATEGORIES.map((category, index) => ({
      findingId: `F-${index}`,
      severity: index % 2 === 0 ? "blocking" : "advisory",
      category,
      taskIds: index === 0 ? ["A", "A", "B"] : ["A"],
      claim: `${category} claim`,
      evidence: [`${category} evidence`],
    })),
    tasks,
  );
  assert.equal(parsed.length, PLAN_CRITIQUE_CATEGORIES.length);
  assert.deepEqual(parsed[0]?.taskIds, ["A", "B"]);
  assert.deepEqual(parsed.map((finding) => finding.category), [...PLAN_CRITIQUE_CATEGORIES]);
});
