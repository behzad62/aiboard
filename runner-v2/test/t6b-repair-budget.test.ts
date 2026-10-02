import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ISSUE_REPAIR_CYCLE_LIMIT,
  chargeRepairIssue,
  isDiagnosticRepairCycle,
  newRepairBudgetRecord,
  recordExternalBlocker,
  repairBudgetAllowsDispatch,
  repairIssueIdentity,
} from "../src/repair-budget-contracts.js";
import { validateRepairApproachDecision } from "../src/repair-approach-contracts.js";
import { escapeRegExpPattern, flakyRerunPattern, narrowNodeTestCommand } from "../src/flaky-rerun.js";

test("three substantive cycles charge and a fourth is refused", () => {
  let budget = newRepairBudgetRecord("issue", "root");
  for (let index = 0; index < DEFAULT_ISSUE_REPAIR_CYCLE_LIMIT; index += 1) {
    assert.equal(repairBudgetAllowsDispatch(budget, { maxTaskAttemptsRemaining: 2, maxRepairPlanRemaining: 3 }).allowed, true);
    budget = chargeRepairIssue(budget, { hypothesis: `h${index}`, outcome: "failed", evidenceIds: [`e${index}`] });
  }
  assert.equal(budget.used, 3);
  assert.equal(repairBudgetAllowsDispatch(budget, { maxTaskAttemptsRemaining: 2, maxRepairPlanRemaining: 3 }).allowed, false);
});

test("diagnostics and related symptoms share root-cause identity", () => {
  const first = repairIssueIdentity({ projectId: "p", rootCause: "same root" });
  const renamed = repairIssueIdentity({ projectId: "p", rootCause: "same root" });
  assert.equal(first, renamed);
  const budget = newRepairBudgetRecord("issue", "same root");
  const diagnostic = chargeRepairIssue({ ...budget, used: 0 }, { hypothesis: "inspect", outcome: "diagnostic", evidenceIds: ["e"] });
  assert.equal(diagnostic.used, 0, "diagnostics are not substantive cycles");
});

test("all applicable caps refuse dispatch and external blockers do not consume attempts", () => {
  const budget = newRepairBudgetRecord("issue", "root");
  assert.equal(repairBudgetAllowsDispatch(budget, { maxTaskAttemptsRemaining: 0, maxRepairPlanRemaining: 3 }).allowed, false);
  assert.equal(repairBudgetAllowsDispatch(budget, { maxTaskAttemptsRemaining: 2, maxRepairPlanRemaining: 0 }).allowed, false);
  const blocked = recordExternalBlocker(budget, {
    acceptanceCondition: "external service is available",
    evidence: ["evidence"],
    attemptedResolutions: ["retry"],
    requiredOwnerAction: "owner enables service",
  });
  assert.equal(repairBudgetAllowsDispatch(blocked, { maxTaskAttemptsRemaining: 2, maxRepairPlanRemaining: 3 }).allowed, false);
});

test("repeated failed approaches require evidence new to the recorded diagnostic set", () => {
  const base = { actorRole: "architect" as const, actorId: "a", decisionActorRole: "architect" as const, decisionActorId: "a" };
  const prior = [{ approachId: "a1", failed: true, hypothesis: "first remedy", diagnosticSet: ["d1"], evidenceIds: ["d1"], failureEvidenceIds: ["check-ev-1"] as string[] }];
  assert.throws(() => validateRepairApproachDecision({ ...base, priorApproaches: prior, decision: { approachId: "a1", repeat: false, hypothesis: "same", diagnosticSet: [], evidenceIds: ["d1"] } }), /relabeled|resubmitted/i);
  assert.throws(() => validateRepairApproachDecision({ ...base, priorApproaches: prior, decision: { approachId: "a2", repeat: true, hypothesis: "same", diagnosticSet: [], evidenceIds: ["d1"] } }), /NEW/i);
  validateRepairApproachDecision({ ...base, priorApproaches: prior, decision: { approachId: "a1", repeat: true, hypothesis: "new evidence", diagnosticSet: [], evidenceIds: ["d2"] } });
});

test("renamed approaches, failure-evidence repeats, and fabricated ids are refused", () => {
  const base = { actorRole: "architect" as const, actorId: "a", decisionActorRole: "architect" as const, decisionActorId: "a" };
  const prior = [{ approachId: "a1", failed: true, hypothesis: "first remedy", diagnosticSet: ["d1"], evidenceIds: ["d1"], failureEvidenceIds: ["check-ev-1"] as string[] }];
  // Relabel with identical evidence cannot pass as a new approach.
  assert.throws(() => validateRepairApproachDecision({ ...base, priorApproaches: prior, decision: { approachId: "a1-renamed", repeat: false, hypothesis: "same", diagnosticSet: ["d1"], evidenceIds: ["d1"] } }), /identical evidence/i);
  // A repeat citing the failure's own evidence is refused even with new evidence alongside.
  assert.throws(() => validateRepairApproachDecision({ ...base, priorApproaches: prior, decision: { approachId: "a1", repeat: true, hypothesis: "same", diagnosticSet: ["d1"], evidenceIds: ["check-ev-1", "d2"] } }), /failure's own evidence/i);
  // A repeat citing only the failure's evidence is refused.
  assert.throws(() => validateRepairApproachDecision({ ...base, priorApproaches: prior, decision: { approachId: "a1", repeat: true, hypothesis: "same", diagnosticSet: ["d1"], evidenceIds: ["check-ev-1"] } }), /failure's own evidence/i);
  // A fabricated evidence id is refused against the evidence store.
  assert.throws(() => validateRepairApproachDecision({ ...base, priorApproaches: prior, knownEvidenceIds: ["d1", "d2"], decision: { approachId: "a1", repeat: true, hypothesis: "new", diagnosticSet: [], evidenceIds: ["not-an-evidence-record"] } }), /unknown evidence id/i);
  // Genuinely new evidence validates.
  validateRepairApproachDecision({ ...base, priorApproaches: prior, knownEvidenceIds: ["d1", "d2"], decision: { approachId: "a1", repeat: true, hypothesis: "new", diagnosticSet: [], evidenceIds: ["d2"] } });
});

test("a relabelled failed approach with no evidence, or the same hypothesis, is refused", () => {
  const base = { actorRole: "architect" as const, actorId: "a", decisionActorRole: "architect" as const, decisionActorId: "a" };
  const prior = [{ approachId: "a1", failed: true, hypothesis: "first remedy", diagnosticSet: ["d1"], evidenceIds: ["d1"], failureEvidenceIds: ["check-ev-1"] as string[] }];
  // T6b repair (R2-B3, probe I): empty evidence never passes, even with the same hypothesis and diagnostic set.
  assert.throws(() => validateRepairApproachDecision({ ...base, priorApproaches: prior, decision: { approachId: "a1-renamed", repeat: false, hypothesis: "first remedy", diagnosticSet: ["d1"], evidenceIds: [] } }), /empty evidence never passes/i);
  // A new id reusing the failed hypothesis and diagnostic set is a relabel even when it cites fresh evidence.
  assert.throws(() => validateRepairApproachDecision({ ...base, priorApproaches: prior, knownEvidenceIds: ["d1", "d2"], decision: { approachId: "a1-renamed", repeat: false, hypothesis: "first remedy", diagnosticSet: ["d1"], evidenceIds: ["d2"] } }), /relabel, not a new approach/i);
  // A genuinely new hypothesis with fresh evidence still validates.
  validateRepairApproachDecision({ ...base, priorApproaches: prior, knownEvidenceIds: ["d1", "d2"], decision: { approachId: "a2", repeat: false, hypothesis: "second remedy", diagnosticSet: [], evidenceIds: ["d2"] } });
});

test("issue identity is stable across renames and normalizes symptom text", () => {
  const project = "delivery-fixture";
  assert.equal(
    repairIssueIdentity({ projectId: project, rootCause: "final-verification:tests" }),
    repairIssueIdentity({ projectId: project, rootCause: "  Final-Verification:Tests " }),
  );
  assert.notEqual(
    repairIssueIdentity({ projectId: project, rootCause: "final-verification:tests" }),
    repairIssueIdentity({ projectId: project, rootCause: "final-verification:build" }),
  );
  assert.notEqual(
    repairIssueIdentity({ projectId: project, rootCause: "final-verification:tests" }),
    repairIssueIdentity({ projectId: "other-project", rootCause: "final-verification:tests" }),
  );
  assert.throws(() => repairIssueIdentity({ projectId: "p", rootCause: "   " }), /root cause/);
});

test("diagnostic variants charge zero and never mask a substantive count", () => {
  assert.equal(isDiagnosticRepairCycle("Diagnostic: inspect logs", "failed"), true);
  assert.equal(isDiagnosticRepairCycle("inspect", "diagnostic-pass"), true);
  assert.equal(isDiagnosticRepairCycle("repair guard", "failed"), false);
  let budget = newRepairBudgetRecord("issue", "root");
  budget = chargeRepairIssue(budget, { hypothesis: "diagnostic: inspect", outcome: "complete", evidenceIds: [] });
  assert.equal(budget.used, 0);
  assert.deepEqual(budget.hypotheses, []);
  budget = chargeRepairIssue(budget, { hypothesis: "h", outcome: "failed", evidenceIds: ["e"] });
  assert.equal(budget.used, 1);
  assert.throws(() => chargeRepairIssue(budget, { hypothesis: "", outcome: "failed", evidenceIds: ["e"] }), /hypothesis, outcome/);
});

test("external blocker records require every owner-action field", () => {
  const full = {
    acceptanceCondition: "service reachable",
    evidence: ["probe failed: connection refused"],
    attemptedResolutions: ["restarted service", "checked config"],
    requiredOwnerAction: "owner enables service",
  };
  const blocked = recordExternalBlocker(newRepairBudgetRecord("issue", "root"), { ...full });
  assert.deepEqual(blocked.externalBlocker, { ...full });
  assert.throws(() => recordExternalBlocker(newRepairBudgetRecord("i", "r"), { ...full, acceptanceCondition: "  " }), /acceptance condition/);
  assert.throws(() => recordExternalBlocker(newRepairBudgetRecord("i", "r"), { ...full, evidence: [] }), /evidence/);
  assert.throws(() => recordExternalBlocker(newRepairBudgetRecord("i", "r"), { ...full, attemptedResolutions: [] }), /attempted resolutions/);
  assert.throws(() => recordExternalBlocker(newRepairBudgetRecord("i", "r"), { ...full, requiredOwnerAction: "" }), /owner action/);
});

test("failing-test selection narrows only direct node --test commands", () => {
  const command = { label: "tests", executable: "node", args: ["--test", "test/"], timeoutMs: 1000 };
  const narrowed = narrowNodeTestCommand(command, ["red one", "blue(two)"]);
  assert.ok(narrowed);
  // The selection flag precedes the positional test path: node ignores
  // options placed after positionals.
  assert.deepEqual(narrowed.args, ["--test", `--test-name-pattern=${flakyRerunPattern(["red one", "blue(two)"])}`, "test/"]);
  assert.deepEqual(narrowNodeTestCommand({ ...command, args: ["--test"] }, ["red one"])?.args, ["--test", `--test-name-pattern=${flakyRerunPattern(["red one"])}`]);
  assert.equal(flakyRerunPattern(["red one", "blue(two)"]), "^red one$|^blue\\(two\\)$");
  assert.equal(escapeRegExpPattern("a.b*c"), "a\\.b\\*c");
  assert.equal(narrowNodeTestCommand({ ...command, executable: "npm" }, ["red one"]), undefined);
  assert.equal(narrowNodeTestCommand({ ...command, args: ["--test", "--test-name-pattern=^x$"] }, ["red one"]), undefined);
  assert.equal(narrowNodeTestCommand(command, []), undefined);
  assert.ok(narrowNodeTestCommand({ ...command, executable: "C:\\nodejs\\node.exe" }, ["t"]), "windows node paths narrow");
});
