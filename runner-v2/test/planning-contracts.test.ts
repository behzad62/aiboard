import assert from "node:assert/strict";
import test from "node:test";

import {
  assertClaimReassignable,
  assertRequirementLedger,
  computeExecutionPlanRevisionDigest,
  computePlanReadiness,
  coverageReviewHoldsReadiness,
  PLANNING_FINDING_CATEGORIES,
  validateAssignmentClaim,
  validateCoverageReview,
  validateCoverageReviewBinding,
  validateDeliverableReview,
  validateEvidenceApplicabilityDecision,
  validateExecutionPlanRevision,
  validateExecutionTaskContract,
  validateHostPlanningCapabilities,
  validatePhaseAcceptance,
  validatePlanningCheckpoint,
  validateRepairApproachDecision,
  validateRequirementLedger,
  validateRequirementRemovalAgainstPrior,
  validateRequirementTaskCoverage,
  validateRequirementTaskLinkSymmetry,
  validateTaskAcceptance,
  validateTaskContractGraph,
  validateValidationIntent,
  validateValidationObservation,
  type AssignmentClaim,
  type CoverageReview,
  type DeliverableReview,
  type EvidenceApplicabilityDecision,
  type ExecutionTaskContract,
  type HostPlanningCapabilities,
  type PlanningCheckpoint,
  type RepairApproachDecision,
  type TaskAcceptance,
  type ValidationObservation,
} from "../src/planning-contracts.js";
import { validateApprovedSourceManifest } from "../src/source-manifest.js";
import {
  buildPlanningFixtureScenario,
  buildFixtureRequirements,
  buildFixtureTasks,
  FIXTURE_PHASES,
} from "./fixtures/planning-source-fixture.js";

// ---------------------------------------------------------------------------
// T1 acceptance/negative-proof: each of these six cannot produce a ready plan.
// ---------------------------------------------------------------------------

test("negative proof: removing a requirement while a task still references it is rejected (unknown requirement ref)", () => {
  const scenario = buildPlanningFixtureScenario();
  const revisionWithoutSecurity = {
    ...scenario.revision,
    requirements: scenario.revision.requirements.filter((r) => r.id !== "REQ-SECURITY"),
  };
  const boundRevision = { ...revisionWithoutSecurity, digest: computeExecutionPlanRevisionDigest(revisionWithoutSecurity) };
  const result = validateExecutionPlanRevision(boundRevision, scenario.manifest);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "unknown_requirement_ref" && issue.taskId === "T4"));
});

test("negative proof: dropping a source section is rejected at the manifest level, and a requirement referencing it is rejected too", () => {
  const scenario = buildPlanningFixtureScenario();
  const droppedManifest = {
    ...scenario.manifest,
    sections: scenario.manifest.sections.filter((section) => section.id !== "s4"),
  };
  const result = validateExecutionPlanRevision(scenario.revision, droppedManifest);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "unknown_section_ref" && issue.requirementId === "REQ-OPERATIONAL"));
});

test("negative proof: assigning a requirement two different accountable phases is rejected", () => {
  const scenario = buildPlanningFixtureScenario();
  const requirements = buildFixtureRequirements(scenario.manifest);
  const twoOwners = [
    ...requirements,
    { ...requirements.find((r) => r.id === "REQ-MANDATORY")!, accountablePhaseId: "BP2" },
  ];
  const result = validateRequirementLedger(twoOwners, scenario.manifest, FIXTURE_PHASES.map((p) => p.id));
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "duplicate_requirement_id"));
  assert.ok(result.issues.some((issue) => issue.code === "conflicting_owner"));
  assert.throws(() => assertRequirementLedger(twoOwners, scenario.manifest, FIXTURE_PHASES.map((p) => p.id)));
});

test("negative proof: changing the source digest invalidates the plan revision", () => {
  const scenario = buildPlanningFixtureScenario();
  const driftedManifest = { ...scenario.manifest, artifactDigest: "f".repeat(64) };
  const result = validateExecutionPlanRevision(scenario.revision, driftedManifest);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "source_digest_changed"));

  const readiness = computePlanReadiness({
    manifest: driftedManifest,
    revision: scenario.revision,
    coverageReview: scenario.coverageReview,
    hostCapabilities: scenario.hostCapabilities,
  });
  assert.equal(readiness.ready, false);
});

test("negative proof: cancelling a requirement's only implementation task without disposition orphans it", () => {
  const scenario = buildPlanningFixtureScenario();
  const taskStatuses = new Map(scenario.tasks.map((t) => [t.id, "planned"]));
  taskStatuses.set("T4", "cancelled"); // T4 is REQ-SECURITY's only contributing task
  const result = validateRequirementTaskCoverage(scenario.requirements, scenario.tasks, taskStatuses);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "orphaned_requirement" && issue.requirementId === "REQ-SECURITY"));
});

test("negative proof: silently marking an obligation not_applicable without an authorized disposition is rejected", () => {
  const scenario = buildPlanningFixtureScenario();
  const requirements = buildFixtureRequirements(scenario.manifest);
  const silentlyRetired = requirements.map((r) =>
    r.id === "REQ-NONFUNC"
      ? { ...r, applicability: { status: "not_applicable" as const }, contributingTaskIds: [] }
      : r,
  );
  const noDisposition = validateRequirementLedger(silentlyRetired, scenario.manifest, FIXTURE_PHASES.map((p) => p.id));
  assert.equal(noDisposition.valid, false);
  assert.ok(noDisposition.issues.some((issue) => issue.code === "missing_disposition" && issue.requirementId === "REQ-NONFUNC"));

  // Present disposition but citing neither an amendment nor evidence is also rejected (unauthorized).
  const unauthorized = requirements.map((r) =>
    r.id === "REQ-NONFUNC"
      ? {
          ...r,
          applicability: {
            status: "not_applicable" as const,
            disposition: { authorizedBy: "owner", rationale: "no longer needed", decidedAt: "2026-09-22T00:00:00.000Z" },
          },
          contributingTaskIds: [],
        }
      : r,
  );
  const unauthorizedResult = validateRequirementLedger(unauthorized, scenario.manifest, FIXTURE_PHASES.map((p) => p.id));
  assert.equal(unauthorizedResult.valid, false);
  assert.ok(unauthorizedResult.issues.some((issue) => issue.code === "unauthorized_disposition"));

  // Fully authorized disposition (mirrors REQ-RETIRED in the fixture) is accepted.
  const authorized = requirements.map((r) =>
    r.id === "REQ-NONFUNC"
      ? {
          ...r,
          applicability: {
            status: "not_applicable" as const,
            disposition: {
              authorizedBy: "owner",
              rationale: "superseded",
              amendmentRef: "amend-1",
              decidedAt: "2026-09-22T00:00:00.000Z",
            },
          },
          contributingTaskIds: [],
        }
      : r,
  );
  const authorizedResult = validateRequirementLedger(authorized, scenario.manifest, FIXTURE_PHASES.map((p) => p.id));
  assert.equal(authorizedResult.valid, true);
});

// ---------------------------------------------------------------------------
// Review repair cycle 1 — the four independent-review BLOCKING fixes (B1-B4),
// each with a dedicated named test.
// ---------------------------------------------------------------------------

test("B1: removing a requirement TOGETHER with its only task leaves the source section uncovered and blocks readiness", () => {
  const scenario = buildPlanningFixtureScenario();
  const requirementsWithoutSecurity = scenario.requirements.filter((r) => r.id !== "REQ-SECURITY");
  const tasksWithoutT4 = scenario.tasks.filter((t) => t.id !== "T4");
  const mutatedRevision = { ...scenario.revision, requirements: requirementsWithoutSecurity, tasks: tasksWithoutT4 };
  const boundRevision = { ...mutatedRevision, digest: computeExecutionPlanRevisionDigest(mutatedRevision) };

  const revisionResult = validateExecutionPlanRevision(boundRevision, scenario.manifest);
  assert.equal(revisionResult.valid, false);
  assert.ok(
    revisionResult.issues.some((issue) => issue.code === "uncovered_source_section"),
    "removing a requirement and its only task must leave section s5 uncovered",
  );

  const readiness = computePlanReadiness({
    manifest: scenario.manifest,
    revision: boundRevision,
    coverageReview: { ...scenario.coverageReview, planRevisionId: boundRevision.revisionId, planRevisionDigest: boundRevision.digest },
    hostCapabilities: scenario.hostCapabilities,
  });
  assert.equal(readiness.ready, false, "a plan with an uncovered section must never be ready");

  // An authorized non-normative disposition for the now-uncovered section
  // makes it valid again — the section coverage rule is satisfiable, not
  // merely a permanent block. It must cite the manifest's ACTUAL amendment.
  const authorizedRevision = {
    ...mutatedRevision,
    nonNormativeSections: [{
      sectionId: "s5",
      rationale: "Retired by amendment amend-1.",
      authorizedBy: "owner",
      amendmentRef: "amend-1",
      decidedAt: "2026-09-23T00:00:00.000Z",
    }],
  };
  const boundAuthorized = { ...authorizedRevision, digest: computeExecutionPlanRevisionDigest(authorizedRevision) };
  const authorizedResult = validateExecutionPlanRevision(boundAuthorized, scenario.manifest);
  assert.equal(authorizedResult.issues.some((issue) => issue.code === "uncovered_source_section"), false);
  assert.equal(authorizedResult.issues.some((issue) => issue.code === "unresolved_amendment_ref"), false);
});

test("NEW-1: an architect-authored, evidence-only non-normative section disposition cannot bypass the amendment requirement", () => {
  const scenario = buildPlanningFixtureScenario();
  const requirementsWithoutSecurity = scenario.requirements.filter((r) => r.id !== "REQ-SECURITY");
  const tasksWithoutT4 = scenario.tasks.filter((t) => t.id !== "T4");

  // Same removal as the B1 probe, but the non-normative disposition is
  // architect-authored with only an evidenceRef — no amendmentRef at all.
  const evidenceOnlyRevision = {
    ...scenario.revision,
    requirements: requirementsWithoutSecurity,
    tasks: tasksWithoutT4,
    nonNormativeSections: [{
      sectionId: "s5",
      rationale: "heading only",
      authorizedBy: "architect",
      amendmentRef: "",
      evidenceRef: "ev-x",
      decidedAt: "2026-09-23T00:00:00.000Z",
    }],
  };
  const boundEvidenceOnly = { ...evidenceOnlyRevision, digest: computeExecutionPlanRevisionDigest(evidenceOnlyRevision) };
  const evidenceOnlyResult = validateExecutionPlanRevision(boundEvidenceOnly, scenario.manifest);
  assert.equal(evidenceOnlyResult.valid, false);
  assert.ok(evidenceOnlyResult.issues.some((issue) => issue.code === "uncovered_source_section"));

  const readiness = computePlanReadiness({
    manifest: scenario.manifest,
    revision: boundEvidenceOnly,
    coverageReview: { ...scenario.coverageReview, planRevisionId: boundEvidenceOnly.revisionId, planRevisionDigest: boundEvidenceOnly.digest },
    hostCapabilities: scenario.hostCapabilities,
  });
  assert.equal(readiness.ready, false, "an architect evidence-only non-normative disposition must never make the plan ready");

  // Also: a non-empty but FABRICATED amendmentRef (does not resolve against
  // the manifest's actual amendment) is rejected too.
  const fabricatedRevision = {
    ...scenario.revision,
    requirements: requirementsWithoutSecurity,
    tasks: tasksWithoutT4,
    nonNormativeSections: [{
      sectionId: "s5",
      rationale: "heading only",
      authorizedBy: "owner",
      amendmentRef: "amend-does-not-exist",
      decidedAt: "2026-09-23T00:00:00.000Z",
    }],
  };
  const boundFabricated = { ...fabricatedRevision, digest: computeExecutionPlanRevisionDigest(fabricatedRevision) };
  const fabricatedResult = validateExecutionPlanRevision(boundFabricated, scenario.manifest);
  assert.equal(fabricatedResult.valid, false);
  assert.ok(fabricatedResult.issues.some((issue) => issue.code === "unresolved_amendment_ref"));
});

test("B1 (revision-to-revision): a requirement silently absent from a new revision, without an authorized removal record, is rejected", () => {
  const scenario = buildPlanningFixtureScenario();
  const priorRevision = scenario.revision;
  const requirementsWithoutNonfunc = scenario.requirements.filter((r) => r.id !== "REQ-NONFUNC");
  // Keep section s6 covered by an authorized non-normative disposition so
  // this test isolates the revision-to-revision guard from B1's section-
  // coverage guard. Cites the manifest's actual amendment id.
  const mutated = {
    ...scenario.revision,
    revisionId: "revision_2",
    requirements: requirementsWithoutNonfunc,
    tasks: scenario.tasks.filter((t) => t.id !== "T5"),
    nonNormativeSections: [{
      sectionId: "s6",
      rationale: "Retired.",
      authorizedBy: "owner",
      amendmentRef: "amend-1",
      decidedAt: "2026-09-23T00:00:00.000Z",
    }],
  };
  const unauthorized = { ...mutated, digest: computeExecutionPlanRevisionDigest(mutated) };
  const unauthorizedResult = validateRequirementRemovalAgainstPrior(unauthorized, priorRevision, scenario.manifest);
  assert.equal(unauthorizedResult.valid, false);
  assert.ok(unauthorizedResult.issues.some((issue) => issue.code === "unauthorized_requirement_removal" && issue.requirementId === "REQ-NONFUNC"));

  const withRecord = {
    ...mutated,
    retiredRequirementIds: [{
      requirementId: "REQ-NONFUNC",
      amendmentRef: "amend-1",
      authorizedBy: "owner",
      rationale: "Superseded.",
      decidedAt: "2026-09-23T00:00:00.000Z",
    }],
  };
  const authorized = { ...withRecord, digest: computeExecutionPlanRevisionDigest(withRecord) };
  const authorizedResult = validateRequirementRemovalAgainstPrior(authorized, priorRevision, scenario.manifest);
  assert.equal(authorizedResult.valid, true);

  // A retiredRequirementIds record citing a fabricated amendmentRef is rejected.
  const fabricatedRecord = {
    ...mutated,
    retiredRequirementIds: [{
      requirementId: "REQ-NONFUNC",
      amendmentRef: "amend-fabricated",
      authorizedBy: "owner",
      rationale: "Superseded.",
      decidedAt: "2026-09-23T00:00:00.000Z",
    }],
  };
  const boundFabricatedRecord = { ...fabricatedRecord, digest: computeExecutionPlanRevisionDigest(fabricatedRecord) };
  const fabricatedRecordResult = validateRequirementRemovalAgainstPrior(boundFabricatedRecord, priorRevision, scenario.manifest);
  assert.equal(fabricatedRecordResult.valid, false);
  assert.ok(fabricatedRecordResult.issues.some((issue) => issue.code === "unresolved_amendment_ref"));
});

test("B2: a dropped last section / uncovered trailing bytes makes the manifest unprovably complete, and computePlanReadiness calls the manifest validator", () => {
  const scenario = buildPlanningFixtureScenario();
  const lastSection = scenario.manifest.sections[scenario.manifest.sections.length - 1]!;

  // Dropping the trailing section: total byteLength stays the same, so a
  // naive gap/overlap check (with no known total) would validate cleanly.
  const droppedLastSection = { ...scenario.manifest, sections: scenario.manifest.sections.slice(0, -1) };
  const droppedResult = validateApprovedSourceManifest(droppedLastSection);
  assert.equal(droppedResult.valid, false);
  assert.ok(droppedResult.issues.some((issue) => issue.code === "trailing_bytes_uncovered"));

  // An endByte past the recorded byteLength (EOF) is rejected too.
  const overrunSections = [
    ...scenario.manifest.sections.slice(0, -1),
    { ...lastSection, endByte: scenario.manifest.byteLength + 50 },
  ];
  const overrunManifest = { ...scenario.manifest, sections: overrunSections };
  const overrunResult = validateApprovedSourceManifest(overrunManifest);
  assert.equal(overrunResult.valid, false);
  assert.ok(overrunResult.issues.some((issue) => issue.code === "section_exceeds_byte_length"));

  // computePlanReadiness must call the manifest validator, not just trust it.
  const readiness = computePlanReadiness({
    manifest: droppedLastSection,
    revision: scenario.revision,
    coverageReview: scenario.coverageReview,
    hostCapabilities: scenario.hostCapabilities,
  });
  assert.equal(readiness.ready, false);
  assert.ok(readiness.blockers.some((blocker) => blocker.includes("not provably complete")));
});

test("B3: a plan mutation invalidates a stale coverage review even though it keeps the same revisionId", () => {
  const scenario = buildPlanningFixtureScenario();
  // Mutate a task's steps — content changes, revisionId is deliberately kept
  // the same to prove the id-only check (pre-fix) was insufficient.
  const mutatedTasks = scenario.tasks.map((t) => (t.id === "T1" ? { ...t, steps: [...t.steps, "An added step."] } : t));
  const mutatedRevision = { ...scenario.revision, tasks: mutatedTasks };
  const newRevision = { ...mutatedRevision, digest: computeExecutionPlanRevisionDigest(mutatedRevision) };
  assert.equal(newRevision.revisionId, scenario.revision.revisionId, "revisionId is unchanged by design for this test");
  assert.notEqual(newRevision.digest, scenario.revision.digest, "content changed, so the digest must differ");

  const staleReview = scenario.coverageReview; // still references the OLD digest
  const bindingResult = validateCoverageReviewBinding(staleReview, newRevision, scenario.manifest);
  assert.equal(bindingResult.valid, false);
  assert.ok(bindingResult.issues.some((issue) => issue.code === "stale_coverage_review"));

  const readiness = computePlanReadiness({
    manifest: scenario.manifest,
    revision: newRevision,
    coverageReview: staleReview,
    hostCapabilities: scenario.hostCapabilities,
  });
  assert.equal(readiness.ready, false);

  // A fresh review of the exact new digest is accepted.
  const freshReview = { ...staleReview, planRevisionDigest: newRevision.digest };
  assert.equal(validateCoverageReviewBinding(freshReview, newRevision, scenario.manifest).valid, true);

  // A review that read the wrong source manifest, or belongs to a different
  // run, is rejected too.
  const wrongSource = { ...freshReview, sourceReadManifestId: "manifest_other" };
  assert.ok(validateCoverageReviewBinding(wrongSource, newRevision, scenario.manifest).issues.some((i) => i.code === "coverage_review_wrong_source"));
  const wrongRun = { ...freshReview, runId: "run_other" };
  assert.ok(validateCoverageReviewBinding(wrongRun, newRevision, scenario.manifest).issues.some((i) => i.code === "coverage_review_wrong_run"));
});

test("B4: a phase contract missing any EP06/source-§2 field is rejected, and contributing packets/requirement ids must resolve", () => {
  const scenario = buildPlanningFixtureScenario();
  const complete = validateExecutionPlanRevision(scenario.revision, scenario.manifest);
  assert.equal(complete.valid, true);

  const requiredPhaseFields = [
    "purpose",
    "requirementIds",
    "scope",
    "entryConditions",
    "contributingTaskIds",
    "exitCriteria",
    "requiredCombinedValidation",
    "exitUnlocks",
  ] as const;
  for (const field of requiredPhaseFields) {
    const brokenPhases = scenario.revision.phases.map((phase, index) => {
      if (index !== 0) return phase;
      const clone = { ...phase } as Record<string, unknown>;
      delete clone[field];
      return clone;
    });
    const brokenRevision = { ...scenario.revision, phases: brokenPhases as typeof scenario.revision.phases };
    const bound = { ...brokenRevision, digest: computeExecutionPlanRevisionDigest(brokenRevision) };
    const result = validateExecutionPlanRevision(bound, scenario.manifest);
    assert.equal(result.valid, false, `expected phase missing ${field} to be rejected`);
    assert.ok(result.issues.some((issue) => issue.code === "incomplete_phase_contract"));
  }

  // Contributing packets and requirement ids must resolve against the revision.
  const badRefsPhases = scenario.revision.phases.map((phase, index) =>
    index === 0 ? { ...phase, requirementIds: ["REQ-DOES-NOT-EXIST"], contributingTaskIds: ["T-DOES-NOT-EXIST"] } : phase,
  );
  const badRefsRevision = { ...scenario.revision, phases: badRefsPhases };
  const boundBadRefs = { ...badRefsRevision, digest: computeExecutionPlanRevisionDigest(badRefsRevision) };
  const badRefsResult = validateExecutionPlanRevision(boundBadRefs, scenario.manifest);
  assert.equal(badRefsResult.valid, false);
  assert.ok(badRefsResult.issues.some((issue) => issue.code === "unknown_requirement_ref" && issue.phaseId === "BP1"));
  assert.ok(badRefsResult.issues.some((issue) => issue.code === "unknown_task_ref" && issue.phaseId === "BP1"));
});

test("NEW-3: a phase's requirementIds/contributingTaskIds must exactly match which requirements/tasks actually name it as their accountablePhaseId", () => {
  const scenario = buildPlanningFixtureScenario();

  // Probe Q: every phase lists every requirement and task, including ones
  // whose accountablePhaseId names the OTHER phase.
  const allRequirementIds = scenario.requirements.map((r) => r.id);
  const allTaskIds = scenario.tasks.map((t) => t.id);
  const overclaimingPhases = scenario.revision.phases.map((phase) => ({
    ...phase,
    requirementIds: allRequirementIds,
    contributingTaskIds: allTaskIds,
  }));
  const overclaimingRevision = { ...scenario.revision, phases: overclaimingPhases };
  const boundOverclaiming = { ...overclaimingRevision, digest: computeExecutionPlanRevisionDigest(overclaimingRevision) };
  const overclaimingResult = validateExecutionPlanRevision(boundOverclaiming, scenario.manifest);
  assert.equal(overclaimingResult.valid, false);
  assert.ok(overclaimingResult.issues.some((issue) => issue.code === "phase_requirement_ownership_mismatch"));
  assert.ok(overclaimingResult.issues.some((issue) => issue.code === "phase_task_ownership_mismatch"));

  const readiness = computePlanReadiness({
    manifest: scenario.manifest,
    revision: boundOverclaiming,
    coverageReview: { ...scenario.coverageReview, planRevisionId: boundOverclaiming.revisionId, planRevisionDigest: boundOverclaiming.digest },
    hostCapabilities: scenario.hostCapabilities,
  });
  assert.equal(readiness.ready, false, "a phase claiming ownership of requirements/tasks it does not own must never be ready");

  // The fixture's own phases (exact ownership match) validate cleanly.
  assert.equal(
    validateExecutionPlanRevision(scenario.revision, scenario.manifest).issues.some(
      (issue) => issue.code === "phase_requirement_ownership_mismatch" || issue.code === "phase_task_ownership_mismatch",
    ),
    false,
  );

  // Under-claiming (a phase omitting a requirement it DOES own) is rejected too.
  const underclaimingPhases = scenario.revision.phases.map((phase) =>
    phase.id === "BP1" ? { ...phase, requirementIds: phase.requirementIds.filter((id) => id !== "REQ-SECURITY") } : phase,
  );
  const underclaimingRevision = { ...scenario.revision, phases: underclaimingPhases };
  const boundUnderclaiming = { ...underclaimingRevision, digest: computeExecutionPlanRevisionDigest(underclaimingRevision) };
  const underclaimingResult = validateExecutionPlanRevision(boundUnderclaiming, scenario.manifest);
  assert.equal(underclaimingResult.valid, false);
  assert.ok(underclaimingResult.issues.some((issue) => issue.code === "phase_requirement_ownership_mismatch" && issue.phaseId === "BP1"));
});

// ---------------------------------------------------------------------------
// Task contract completeness — missing any required field is rejected.
// ---------------------------------------------------------------------------

test("a complete task contract validates; each required field's absence is independently rejected", () => {
  const tasks = buildFixtureTasks();
  const complete = tasks.find((t) => t.id === "T1")!;
  assert.equal(validateExecutionTaskContract(complete).valid, true);

  const requiredFields: (keyof ExecutionTaskContract)[] = [
    "lineage",
    "accountablePhaseId",
    "requirementIds",
    "outcome",
    "scope",
    "writableSurfaces",
    "forbiddenSurfaces",
    "inputs",
    "outputs",
    "steps",
    "dependencies",
    "acceptance",
    "validation",
    "negativeProofApplicability",
    "reviewCriteria",
    "integrationChecks",
    "cleanup",
    "requirementCriteriaMap",
  ];
  for (const field of requiredFields) {
    const broken = { ...complete } as Record<string, unknown>;
    delete broken[field as string];
    const result = validateExecutionTaskContract(broken as unknown as ExecutionTaskContract);
    assert.equal(result.valid, false, `expected task missing ${String(field)} to be rejected`);
  }
});

test("investigation tasks require question, deliverable, decision criterion, and at least one dependent unlock", () => {
  const tasks = buildFixtureTasks();
  const investigation = tasks.find((t) => t.id === "T-INV")!;
  assert.equal(validateExecutionTaskContract(investigation).valid, true);

  const noDeliverable = {
    ...investigation,
    investigation: { ...investigation.investigation!, deliverable: "" },
  };
  const result = validateExecutionTaskContract(noDeliverable);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "incomplete_investigation_task"));

  const noUnlock = {
    ...investigation,
    investigation: { ...investigation.investigation!, dependentUnlockTaskIds: [] },
  };
  assert.equal(validateExecutionTaskContract(noUnlock).valid, false);
});

test("the task-contract dependency graph is acyclic and rejects duplicate task ids", () => {
  const tasks = buildFixtureTasks();
  assert.equal(validateTaskContractGraph(tasks).valid, true);

  const cyclic = tasks.map((t) => (t.id === "T1" ? { ...t, dependencies: ["T2"] } : t));
  const cycleResult = validateTaskContractGraph(cyclic);
  assert.equal(cycleResult.valid, false);
  assert.ok(cycleResult.issues.some((issue) => issue.code === "dependency_cycle"));

  const duplicated = [...tasks, { ...tasks[0]! }];
  const dupResult = validateTaskContractGraph(duplicated);
  assert.equal(dupResult.valid, false);
  assert.ok(dupResult.issues.some((issue) => issue.code === "duplicate_task_id"));
});

test("I5: validators never throw on malformed/null/undefined input — they return an issue instead", () => {
  const scenario = buildPlanningFixtureScenario();

  // Probe G: a task with a non-array dependencies field used to throw
  // "task.dependencies is not iterable".
  assert.doesNotThrow(() => validateTaskContractGraph([{ id: "bad", dependencies: undefined } as unknown as ExecutionTaskContract]));
  assert.doesNotThrow(() => validateTaskContractGraph(null as unknown as ExecutionTaskContract[]));

  // Probe G2: validateExecutionTaskContract(null) used to throw.
  assert.doesNotThrow(() => validateExecutionTaskContract(null as unknown as ExecutionTaskContract));
  assert.equal(validateExecutionTaskContract(null as unknown as ExecutionTaskContract).valid, false);
  assert.doesNotThrow(() => validateExecutionTaskContract(undefined as unknown as ExecutionTaskContract));

  // validateRequirementTaskCoverage and validatePhaseAcceptance used to
  // dereference requirement.applicability.status without a guard.
  const malformedRequirement = { ...scenario.requirements[0]!, applicability: null as unknown as never };
  assert.doesNotThrow(() =>
    validateRequirementTaskCoverage([malformedRequirement], scenario.tasks, new Map()),
  );
  assert.doesNotThrow(() =>
    validatePhaseAcceptance(
      { phaseId: "BP1", requirementIds: [], taskAcceptanceRefs: [], status: "accepted" },
      [malformedRequirement],
      new Map(),
      scenario.manifest,
    ),
  );
  // NEW-2: validatePhaseAcceptance and validateRequirementTaskCoverage with
  // a missing (undefined) map argument.
  assert.doesNotThrow(() =>
    validatePhaseAcceptance(
      { phaseId: "BP1", requirementIds: [], taskAcceptanceRefs: [], status: "accepted" },
      scenario.requirements,
      undefined as unknown as ReadonlyMap<string, TaskAcceptance>,
      scenario.manifest,
    ),
  );
  assert.doesNotThrow(() =>
    validateRequirementTaskCoverage(scenario.requirements, scenario.tasks, undefined as unknown as ReadonlyMap<string, string>),
  );

  // validateEvidenceApplicabilityDecision used to read impact.dependency on
  // a possibly-undefined inspectedImpact.
  assert.doesNotThrow(() =>
    validateEvidenceApplicabilityDecision({
      id: "ea-bad",
      observationId: "o1",
      oldSnapshotRevision: "a",
      newSnapshotRevision: "b",
      inspectedImpact: undefined as unknown as never,
      outcome: "reusable",
      rationale: "x",
    }),
  );
  assert.doesNotThrow(() => validateEvidenceApplicabilityDecision(null as unknown as EvidenceApplicabilityDecision));

  // validateApprovedSourceManifest(null) / with a null section entry.
  assert.doesNotThrow(() => validateApprovedSourceManifest(null as unknown as typeof scenario.manifest));
  assert.doesNotThrow(() =>
    validateApprovedSourceManifest({ ...scenario.manifest, sections: [null as unknown as never, ...scenario.manifest.sections] }),
  );

  // validateExecutionPlanRevision / computePlanReadiness with null inputs.
  assert.doesNotThrow(() => validateExecutionPlanRevision(null as unknown as typeof scenario.revision, scenario.manifest));
  assert.doesNotThrow(() => validateExecutionPlanRevision(scenario.revision, null as unknown as typeof scenario.manifest));
  assert.doesNotThrow(() =>
    computePlanReadiness({
      manifest: null as unknown as typeof scenario.manifest,
      revision: scenario.revision,
      coverageReview: scenario.coverageReview,
      hostCapabilities: scenario.hostCapabilities,
    }),
  );

  // Other validators with null/undefined primary input.
  assert.doesNotThrow(() => validateCoverageReview(null as unknown as CoverageReview));
  assert.doesNotThrow(() => validateDeliverableReview(null as unknown as DeliverableReview));
  assert.doesNotThrow(() => validateRepairApproachDecision(null as unknown as RepairApproachDecision));
  assert.doesNotThrow(() => validateTaskAcceptance(null as unknown as TaskAcceptance));
  assert.doesNotThrow(() => validatePlanningCheckpoint(null as unknown as PlanningCheckpoint));
  assert.doesNotThrow(() => validateAssignmentClaim(null as unknown as AssignmentClaim));
  assert.doesNotThrow(() => validateHostPlanningCapabilities(null as unknown as HostPlanningCapabilities));
  assert.doesNotThrow(() => validateValidationObservation(null as unknown as ValidationObservation));

  // NEW-2 exact probes from the r2 review.
  assert.doesNotThrow(() =>
    validateCoverageReview({ ...scenario.coverageReview, derivedObligations: [null as unknown as never] }),
  );
  assert.doesNotThrow(() =>
    validateTaskAcceptance({
      taskId: "T1",
      requiredChecks: [null as unknown as never],
      reviewId: "r1",
      integrationCheckIds: ["i1"],
      status: "accepted",
      acceptedAt: "2026-09-23T00:00:00.000Z",
    }),
  );
  assert.doesNotThrow(() =>
    computePlanReadiness({
      manifest: scenario.manifest,
      revision: scenario.revision,
      coverageReview: null as unknown as CoverageReview,
      hostCapabilities: scenario.hostCapabilities,
    }),
  );
  assert.doesNotThrow(() =>
    computePlanReadiness({
      manifest: scenario.manifest,
      revision: scenario.revision,
      coverageReview: { ...scenario.coverageReview, findings: [null as unknown as never] },
      hostCapabilities: scenario.hostCapabilities,
    }),
  );
  assert.doesNotThrow(() => computePlanReadiness(null as unknown as Parameters<typeof computePlanReadiness>[0]));
});

test("NEW-2 fuzz: every exported validator tolerates null/undefined/[null]/{} at each top-level and nested argument position", () => {
  const scenario = buildPlanningFixtureScenario();

  const validIntent = {
    id: "intent1",
    acceptanceConditionIds: ["c1"],
    intendedBehavior: "The behavior works.",
    assertions: ["assert1"],
    scope: "targeted" as const,
    scopeReason: "Exact new/changed behavior.",
  };
  const validObservation = {
    id: "obs1",
    intentId: "intent1",
    evidenceId: "evidence1",
    command: "npx tsx --test",
    method: "node:test",
    snapshotRevision: "sha:abc",
    dirty: false,
    exitCode: 0,
    environmentFingerprint: "node24:win32",
    configFingerprint: "sha:config",
    dependencyFingerprint: "sha:deps",
    outcome: "passed" as const,
    counts: { selected: 1, passed: 1, failed: 0, skipped: 0 },
  };
  const validDecision = {
    id: "ea1",
    observationId: "obs1",
    oldSnapshotRevision: "a",
    newSnapshotRevision: "a",
    inspectedImpact: {
      dependency: { inspected: true, oldIdentity: "x", newIdentity: "x" },
      contract: { inspected: true, oldIdentity: "x", newIdentity: "x" },
      config: { inspected: true, oldIdentity: "x", newIdentity: "x" },
      environment: { inspected: true, oldIdentity: "x", newIdentity: "x" },
    },
    outcome: "reusable" as const,
    rationale: "Nothing changed.",
  };
  const validDeliverableReview = {
    id: "dr1",
    taskId: "T1",
    reviewerRuntimeId: "reviewer:distinct",
    independence: "distinct_model" as const,
    changeSetOrDiffRef: "diff:abc",
    sourceCriteriaIds: ["c1"],
    findingsRecordedBeforeReport: true,
    findings: [],
    workerClaimVerdicts: [{ claim: "done", status: "verified" as const }],
    recordedAt: "2026-09-23T00:00:00.000Z",
  };
  const validRepairDecision = {
    id: "rad1",
    issueId: "issue1",
    taskLineageIds: ["T1"],
    priorFailedApproachIds: [],
    priorEvidenceIds: [],
    proposedApproachId: "approach-a",
    decision: "new_approach" as const,
    rationale: "First attempt.",
    newDiagnosticEvidenceIds: [],
    decidedAt: "2026-09-23T00:00:00.000Z",
  };
  const validTaskAcceptance = {
    taskId: "T1",
    requiredChecks: [{ kind: "test", refId: "c1", outcome: "passed" as const }],
    reviewId: "r1",
    integrationCheckIds: ["i1"],
    status: "accepted" as const,
    acceptedAt: "2026-09-23T00:00:00.000Z",
  };
  const validPhaseAcceptance = {
    phaseId: "BP1",
    requirementIds: [] as string[],
    taskAcceptanceRefs: [] as string[],
    status: "pending" as const,
  };
  const validCheckpoint = {
    id: "cp1",
    coveredSourceSectionIds: ["s1"],
    completedPlanningContractIds: ["REQ-MANDATORY"],
    remainingWork: [],
    nextAction: "Continue.",
    recordedAt: "2026-09-23T00:00:00.000Z",
  };
  const validClaim = {
    id: "claim1",
    packetId: "T1",
    laneId: "lane-A",
    workerOrSessionId: "worker1",
    acceptedBaseRevision: "sha:base",
    branchOrWorktree: "wt/T1",
    writableSurfaces: ["a.ts"],
    forbiddenSurfaces: [] as string[],
    ownershipGeneration: 1,
    state: "claimed" as const,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyFn = (...args: any[]) => unknown;
  const validators: { name: string; fn: AnyFn; args: unknown[] }[] = [
    { name: "validateRequirementLedger", fn: validateRequirementLedger as AnyFn, args: [scenario.requirements, scenario.manifest, FIXTURE_PHASES.map((p) => p.id), []] },
    { name: "validateRequirementTaskCoverage", fn: validateRequirementTaskCoverage as AnyFn, args: [scenario.requirements, scenario.tasks, new Map()] },
    { name: "validateExecutionTaskContract", fn: validateExecutionTaskContract as AnyFn, args: [scenario.tasks[0]] },
    { name: "validateTaskContractGraph", fn: validateTaskContractGraph as AnyFn, args: [scenario.tasks] },
    { name: "validateRequirementTaskLinkSymmetry", fn: validateRequirementTaskLinkSymmetry as AnyFn, args: [scenario.requirements, scenario.tasks] },
    { name: "validateExecutionPlanRevision", fn: validateExecutionPlanRevision as AnyFn, args: [scenario.revision, scenario.manifest] },
    { name: "validateRequirementRemovalAgainstPrior", fn: validateRequirementRemovalAgainstPrior as AnyFn, args: [scenario.revision, scenario.revision, scenario.manifest] },
    { name: "validateValidationIntent", fn: validateValidationIntent as AnyFn, args: [validIntent] },
    { name: "validateValidationObservation", fn: validateValidationObservation as AnyFn, args: [validObservation] },
    { name: "validateEvidenceApplicabilityDecision", fn: validateEvidenceApplicabilityDecision as AnyFn, args: [validDecision] },
    { name: "validateCoverageReview", fn: validateCoverageReview as AnyFn, args: [scenario.coverageReview] },
    { name: "validateCoverageReviewBinding", fn: validateCoverageReviewBinding as AnyFn, args: [scenario.coverageReview, scenario.revision, scenario.manifest] },
    { name: "validateDeliverableReview", fn: validateDeliverableReview as AnyFn, args: [validDeliverableReview] },
    { name: "validateRepairApproachDecision", fn: validateRepairApproachDecision as AnyFn, args: [validRepairDecision] },
    { name: "validateTaskAcceptance", fn: validateTaskAcceptance as AnyFn, args: [validTaskAcceptance] },
    { name: "validatePhaseAcceptance", fn: validatePhaseAcceptance as AnyFn, args: [validPhaseAcceptance, scenario.requirements, new Map([["T1", validTaskAcceptance]]), scenario.manifest] },
    { name: "validatePlanningCheckpoint", fn: validatePlanningCheckpoint as AnyFn, args: [validCheckpoint] },
    { name: "validateAssignmentClaim", fn: validateAssignmentClaim as AnyFn, args: [validClaim] },
    { name: "validateHostPlanningCapabilities", fn: validateHostPlanningCapabilities as AnyFn, args: [scenario.hostCapabilities] },
    { name: "validateApprovedSourceManifest", fn: validateApprovedSourceManifest as AnyFn, args: [scenario.manifest] },
    {
      name: "computePlanReadiness",
      fn: ((input: unknown) => computePlanReadiness(input as Parameters<typeof computePlanReadiness>[0])) as AnyFn,
      args: [{ manifest: scenario.manifest, revision: scenario.revision, coverageReview: scenario.coverageReview, hostCapabilities: scenario.hostCapabilities }],
    },
  ];

  let casesRun = 0;
  for (const { name, fn, args } of validators) {
    for (let i = 0; i < args.length; i += 1) {
      for (const bad of [null, undefined]) {
        const mutated = [...args];
        mutated[i] = bad;
        assert.doesNotThrow(() => fn(...mutated), `${name} must not throw with arg[${i}] = ${String(bad)}`);
        casesRun += 1;
      }
      const value = args[i];
      if (Array.isArray(value)) {
        const mutated = [...args];
        mutated[i] = [null];
        assert.doesNotThrow(() => fn(...mutated), `${name} must not throw with arg[${i}] = [null]`);
        casesRun += 1;
        const mutatedObj = [...args];
        mutatedObj[i] = [{}];
        assert.doesNotThrow(() => fn(...mutatedObj), `${name} must not throw with arg[${i}] = [{}]`);
        casesRun += 1;
      } else if (value !== null && typeof value === "object" && !(value instanceof Map)) {
        const mutated = [...args];
        mutated[i] = {};
        assert.doesNotThrow(() => fn(...mutated), `${name} must not throw with arg[${i}] = {}`);
        casesRun += 1;
        for (const key of Object.keys(value as object)) {
          const clone: Record<string, unknown> = { ...(value as Record<string, unknown>) };
          clone[key] = null;
          const mutatedNested = [...args];
          mutatedNested[i] = clone;
          assert.doesNotThrow(() => fn(...mutatedNested), `${name} must not throw with arg[${i}].${key} = null`);
          casesRun += 1;
          // One level deeper: if the nested value is itself an array or object, fuzz it too.
          const nestedValue = (value as Record<string, unknown>)[key];
          if (Array.isArray(nestedValue) && nestedValue.length > 0) {
            const clone2: Record<string, unknown> = { ...(value as Record<string, unknown>) };
            clone2[key] = [null];
            const mutatedNested2 = [...args];
            mutatedNested2[i] = clone2;
            assert.doesNotThrow(() => fn(...mutatedNested2), `${name} must not throw with arg[${i}].${key} = [null]`);
            casesRun += 1;
          } else if (nestedValue !== null && typeof nestedValue === "object" && !Array.isArray(nestedValue)) {
            const clone2: Record<string, unknown> = { ...(value as Record<string, unknown>) };
            clone2[key] = {};
            const mutatedNested2 = [...args];
            mutatedNested2[i] = clone2;
            assert.doesNotThrow(() => fn(...mutatedNested2), `${name} must not throw with arg[${i}].${key} = {}`);
            casesRun += 1;
          }
        }
      }
    }
  }
  // Proves the fuzz actually exercised a meaningful number of cases, not zero.
  assert.ok(casesRun > 100, `expected the fuzz to run well over 100 cases, ran ${casesRun}`);
});

// ---------------------------------------------------------------------------
// Conditional requirement pending state
// ---------------------------------------------------------------------------

test("a conditional requirement keeps a visible conditional_pending state with a condition and does not require immediate resolution", () => {
  const scenario = buildPlanningFixtureScenario();
  const conditional = scenario.requirements.find((r) => r.id === "REQ-CONDITIONAL")!;
  assert.equal(conditional.applicability.status, "conditional_pending");
  assert.ok(conditional.applicability.conditionExpression);
  // Still validates — conditional_pending is not itself a defect.
  const result = validateRequirementLedger(scenario.requirements, scenario.manifest, FIXTURE_PHASES.map((p) => p.id));
  assert.equal(result.valid, true);

  const missingCondition = scenario.requirements.map((r) =>
    r.id === "REQ-CONDITIONAL" ? { ...r, applicability: { status: "conditional_pending" as const } } : r,
  );
  const missingResult = validateRequirementLedger(missingCondition, scenario.manifest, FIXTURE_PHASES.map((p) => p.id));
  assert.equal(missingResult.valid, false);
  assert.ok(missingResult.issues.some((issue) => issue.code === "missing_condition_expression"));

  // Phase acceptance cannot accept a phase owning a still-pending conditional.
  const taskAcceptances = new Map<string, TaskAcceptance>(
    scenario.tasks.map((t) => [
      t.id,
      { taskId: t.id, requiredChecks: [{ kind: "test", refId: "x", outcome: "passed" }], reviewId: "r1", integrationCheckIds: ["i1"], status: "accepted", acceptedAt: "2026-09-08T00:00:00.000Z" },
    ]),
  );
  const phaseResult = validatePhaseAcceptance(
    { phaseId: "BP2", requirementIds: [], taskAcceptanceRefs: [], status: "accepted" },
    scenario.requirements,
    taskAcceptances,
    scenario.manifest,
  );
  assert.equal(phaseResult.valid, false);
  assert.ok(phaseResult.issues.some((issue) => issue.code === "unresolved_conditional"));
});

// ---------------------------------------------------------------------------
// Round-trip: verdict words and category words are disjoint vocabularies.
// ---------------------------------------------------------------------------

test("round-trip: a finding category cannot reuse a verdict word, and vice versa", () => {
  const scenario = buildPlanningFixtureScenario();
  assert.ok(!PLANNING_FINDING_CATEGORIES.includes("covered" as never));
  assert.ok(!PLANNING_FINDING_CATEGORIES.includes("weakened" as never));
  assert.ok(!PLANNING_FINDING_CATEGORIES.includes("missing" as never));

  const review = scenario.coverageReview;
  const verdictUsedAsCategory: CoverageReview = {
    ...review,
    findings: [
      { id: "f1", category: "missing" as never, severity: "advisory", claim: "bad category", evidenceRefs: [] },
    ],
  };
  const result1 = validateCoverageReview(verdictUsedAsCategory);
  assert.equal(result1.valid, false);
  assert.ok(result1.issues.some((issue) => issue.code === "invalid_finding_category"));

  const categoryUsedAsVerdict: CoverageReview = {
    ...review,
    obligationVerdicts: review.obligationVerdicts.map((v, index) =>
      index === 0 ? { ...v, verdict: "missing_coverage" } : v,
    ),
  };
  const result2 = validateCoverageReview(categoryUsedAsVerdict);
  assert.equal(result2.valid, false);
  assert.ok(result2.issues.some((issue) => issue.code === "invalid_verdict_value"));

  // A never-exercised criterion is expressible as "weakened", not "covered".
  const weakened: CoverageReview = {
    ...review,
    obligationVerdicts: review.obligationVerdicts.map((v, index) =>
      index === 0 ? { ...v, verdict: "weakened", severity: "advisory" } : v,
    ),
  };
  assert.equal(validateCoverageReview(weakened).valid, true);
});

// ---------------------------------------------------------------------------
// OA-1/OA-2/OA-3: obligations recorded before plan/diff; record-before-verdict.
// ---------------------------------------------------------------------------

test("coverage review requires derived obligations recorded before the plan was provided (record-before-verdict gate)", () => {
  const scenario = buildPlanningFixtureScenario();
  const valid = validateCoverageReview(scenario.coverageReview);
  assert.equal(valid.valid, true);

  const notRecordedFirst: CoverageReview = {
    ...scenario.coverageReview,
    derivedObligations: scenario.coverageReview.derivedObligations.map((o, index) =>
      index === 0 ? { ...o, recordedBeforePlanOrDiffProvided: false } : o,
    ),
  };
  const result = validateCoverageReview(notRecordedFirst);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "obligation_not_recorded_before_plan"));
});

test("EP44: a blocking missing or weakened coverage verdict holds plan readiness; a non-blocking one does not", () => {
  const scenario = buildPlanningFixtureScenario();
  const blocking: CoverageReview = {
    ...scenario.coverageReview,
    obligationVerdicts: scenario.coverageReview.obligationVerdicts.map((v, index) =>
      index === 0 ? { ...v, verdict: "missing", severity: "blocking" } : v,
    ),
  };
  assert.equal(coverageReviewHoldsReadiness(blocking), true);
  const readinessHeld = computePlanReadiness({
    manifest: scenario.manifest,
    revision: scenario.revision,
    coverageReview: blocking,
    hostCapabilities: scenario.hostCapabilities,
  });
  assert.equal(readinessHeld.ready, false);

  const advisoryWeakened: CoverageReview = {
    ...scenario.coverageReview,
    obligationVerdicts: scenario.coverageReview.obligationVerdicts.map((v, index) =>
      index === 0 ? { ...v, verdict: "weakened", severity: "advisory" } : v,
    ),
  };
  assert.equal(coverageReviewHoldsReadiness(advisoryWeakened), false);
  const readinessNotHeld = computePlanReadiness({
    manifest: scenario.manifest,
    revision: scenario.revision,
    coverageReview: advisoryWeakened,
    hostCapabilities: scenario.hostCapabilities,
  });
  assert.equal(readinessNotHeld.ready, true);

  // Resolution: a scoped re-review that fixes the verdict releases readiness.
  const resolved: CoverageReview = {
    ...blocking,
    id: "coverage_2",
    priorReviewId: blocking.id,
    correctionOwnViewRecordedFirst: true,
    obligationVerdicts: blocking.obligationVerdicts.map((v, index) =>
      index === 0 ? { ...v, verdict: "covered" } : v,
    ),
  };
  assert.equal(coverageReviewHoldsReadiness(resolved), false);
  assert.equal(validateCoverageReview(resolved).valid, true);

  // A correction that skips recording its own view first (OA-10 #2) is rejected.
  const skippedOwnView: CoverageReview = { ...resolved, correctionOwnViewRecordedFirst: false };
  assert.equal(validateCoverageReview(skippedOwnView).valid, false);
});

test("OA-3: deliverable review findings must be recorded before the worker report is seen; high tier requires obligations before the diff", () => {
  const review: DeliverableReview = {
    id: "dr1",
    taskId: "T1",
    reviewerRuntimeId: "reviewer:distinct",
    independence: "distinct_model",
    changeSetOrDiffRef: "diff:abc123",
    sourceCriteriaIds: ["REQ-MANDATORY-ac1"],
    findingsRecordedBeforeReport: true,
    findings: [],
    workerClaimVerdicts: [{ claim: "implemented X", status: "verified" }],
    recordedAt: "2026-09-08T00:00:00.000Z",
  };
  assert.equal(validateDeliverableReview(review).valid, true);

  const tooEarly = { ...review, findingsRecordedBeforeReport: false };
  const tooEarlyResult = validateDeliverableReview(tooEarly);
  assert.equal(tooEarlyResult.valid, false);
  assert.ok(tooEarlyResult.issues.some((issue) => issue.code === "findings_not_recorded_before_report"));

  const highTierMissingObligations: DeliverableReview = { ...review, reviewTier: "high" };
  const highResult = validateDeliverableReview(highTierMissingObligations);
  assert.equal(highResult.valid, false);
  assert.ok(highResult.issues.some((issue) => issue.code === "high_tier_missing_obligations"));

  const highTierComplete: DeliverableReview = {
    ...review,
    reviewTier: "high",
    highTierObligationsRecordedBeforeDiff: [
      { id: "ho1", description: "obligation", recordedBeforePlanOrDiffProvided: true, recordedAt: "2026-09-08T00:00:00.000Z" },
    ],
  };
  assert.equal(validateDeliverableReview(highTierComplete).valid, true);
});

// ---------------------------------------------------------------------------
// Validation observation: unknown selection is never inferred as passing.
// ---------------------------------------------------------------------------

test("a passed validation observation requires at least one selected assertion and zero failures", () => {
  const base: ValidationObservation = {
    id: "obs1",
    intentId: "intent1",
    evidenceId: "evidence1",
    command: "npx tsx --test",
    method: "node:test",
    snapshotRevision: "sha:abc",
    dirty: false,
    exitCode: 0,
    environmentFingerprint: "node24:win32",
    configFingerprint: "sha:config-abc",
    dependencyFingerprint: "sha:deps-abc",
    outcome: "passed",
    counts: { selected: 3, passed: 3, failed: 0, skipped: 0 },
  };
  assert.equal(validateValidationObservation(base).valid, true);

  const nonZeroExitPassed: ValidationObservation = { ...base, exitCode: 1 };
  assert.equal(validateValidationObservation(nonZeroExitPassed).valid, false);

  const zeroSelected: ValidationObservation = { ...base, counts: { selected: 0, passed: 0, failed: 0, skipped: 0 } };
  const zeroResult = validateValidationObservation(zeroSelected);
  assert.equal(zeroResult.valid, false);
  assert.ok(zeroResult.issues.some((issue) => issue.code === "invalid_passed_observation"));

  const passedWithFailures: ValidationObservation = { ...base, counts: { selected: 3, passed: 2, failed: 1, skipped: 0 } };
  assert.equal(validateValidationObservation(passedWithFailures).valid, false);

  const dirtyUndisclosed: ValidationObservation = { ...base, dirty: true };
  const dirtyResult = validateValidationObservation(dirtyUndisclosed);
  assert.equal(dirtyResult.valid, false);
  assert.ok(dirtyResult.issues.some((issue) => issue.code === "undisclosed_dirty_snapshot"));

  const unknownOutcome: ValidationObservation = { ...base, outcome: "unknown", counts: { selected: 0, passed: 0, failed: 0, skipped: 0 } };
  assert.equal(validateValidationObservation(unknownOutcome).valid, true);
});

// ---------------------------------------------------------------------------
// Evidence applicability: a blanket "unaffected" claim is insufficient.
// ---------------------------------------------------------------------------

test("evidence applicability: any inspected impact dimension mechanically forces invalidated, not reviewer discretion", () => {
  const unaffected = (): { inspected: true; oldIdentity: string; newIdentity: string } => ({
    inspected: true,
    oldIdentity: "sha:dep-a",
    newIdentity: "sha:dep-a",
  });
  const decision: EvidenceApplicabilityDecision = {
    id: "ea1",
    observationId: "obs1",
    oldSnapshotRevision: "sha:a",
    newSnapshotRevision: "sha:b",
    inspectedImpact: {
      dependency: unaffected(),
      contract: unaffected(),
      config: unaffected(),
      environment: unaffected(),
    },
    outcome: "reusable",
    rationale: "Every dimension was inspected and its identity is unchanged.",
  };
  assert.equal(validateEvidenceApplicabilityDecision(decision).valid, true);

  const changedIdentity: EvidenceApplicabilityDecision = {
    ...decision,
    inspectedImpact: { ...decision.inspectedImpact, contract: { inspected: true, oldIdentity: "sha:c1", newIdentity: "sha:c2" } },
    outcome: "reusable",
  };
  const result = validateEvidenceApplicabilityDecision(changedIdentity);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "blanket_unaffected_claim"));

  const correctlyInvalidated: EvidenceApplicabilityDecision = { ...changedIdentity, outcome: "invalidated" };
  assert.equal(validateEvidenceApplicabilityDecision(correctlyInvalidated).valid, true);

  // I8: "not inspected" and "inspected and found unaffected" are distinct —
  // an uninspected dimension cannot be waved through as reusable.
  const uninspected: EvidenceApplicabilityDecision = {
    ...decision,
    inspectedImpact: { ...decision.inspectedImpact, environment: { inspected: false } },
    outcome: "reusable",
  };
  const uninspectedResult = validateEvidenceApplicabilityDecision(uninspected);
  assert.equal(uninspectedResult.valid, false);
  assert.ok(uninspectedResult.issues.some((issue) => issue.code === "blanket_unaffected_claim"));

  // Inspected but missing an identity cannot mechanically prove "unaffected" either.
  const missingIdentity: EvidenceApplicabilityDecision = {
    ...decision,
    inspectedImpact: { ...decision.inspectedImpact, config: { inspected: true, oldIdentity: "sha:x" } },
    outcome: "reusable",
  };
  const missingIdentityResult = validateEvidenceApplicabilityDecision(missingIdentity);
  assert.equal(missingIdentityResult.valid, false);
  assert.ok(missingIdentityResult.issues.some((issue) => issue.code === "missing_dimension_identity"));
});

// ---------------------------------------------------------------------------
// Repair approach decisions: a repeated failed approach needs new evidence.
// ---------------------------------------------------------------------------

test("a repeated failed repair approach is refused without new inspectable evidence; new evidence unlocks it", () => {
  const base: RepairApproachDecision = {
    id: "rad1",
    issueId: "issue1",
    taskLineageIds: ["T1"],
    priorFailedApproachIds: ["approach-a"],
    priorEvidenceIds: ["evidence1", "evidence2"],
    proposedApproachId: "approach-a",
    decision: "new_approach",
    rationale: "Retrying with the same fix.",
    newDiagnosticEvidenceIds: ["evidence1"], // already known — not new
    decidedAt: "2026-09-08T00:00:00.000Z",
  };
  const result = validateRepairApproachDecision(base);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "repeated_approach_without_new_evidence"));

  const withNewEvidence: RepairApproachDecision = { ...base, newDiagnosticEvidenceIds: ["evidence1", "evidence3"] };
  assert.equal(validateRepairApproachDecision(withNewEvidence).valid, true);

  // A relabelled approach id (not in priorFailedApproachIds) claiming
  // decision=repeat_rejected is rejected — you cannot "reject a repeat" of
  // something that was never recorded as a prior failed approach.
  const relabelled: RepairApproachDecision = {
    ...base,
    proposedApproachId: "approach-a-v2",
    decision: "repeat_rejected",
    newDiagnosticEvidenceIds: [],
  };
  const relabelledResult = validateRepairApproachDecision(relabelled);
  assert.equal(relabelledResult.valid, false);
  assert.ok(relabelledResult.issues.some((issue) => issue.code === "repeat_rejected_not_a_known_repeat"));
});

test("M1: repeat_rejected is the Architect's OWN rejection record, not a further proposal — it is not gated by the new-evidence rule", () => {
  // The Architect records that a genuine repeat of approach-a was proposed
  // and rejected. This is the rejection itself: nothing is being dispatched,
  // so it does not need "new" diagnostic evidence the way an authorized
  // "new_approach" repeat would.
  const rejection: RepairApproachDecision = {
    id: "rad-rejection",
    issueId: "issue1",
    taskLineageIds: ["T1"],
    priorFailedApproachIds: ["approach-a"],
    priorEvidenceIds: ["evidence1"],
    proposedApproachId: "approach-a",
    decision: "repeat_rejected",
    rationale: "Rejected: this exact approach already failed and nothing new was offered.",
    newDiagnosticEvidenceIds: [],
    decidedAt: "2026-09-08T00:00:00.000Z",
  };
  assert.equal(validateRepairApproachDecision(rejection).valid, true);
});

// ---------------------------------------------------------------------------
// Task/phase acceptance: a submission is not acceptance.
// ---------------------------------------------------------------------------

test("task acceptance requires a bound review, integration checks, and no pending required check", () => {
  const pending: TaskAcceptance = {
    taskId: "T1",
    requiredChecks: [{ kind: "test", refId: "check1", outcome: "pending" }],
    reviewId: "",
    integrationCheckIds: [],
    status: "pending",
  };
  assert.equal(validateTaskAcceptance(pending).valid, true); // status pending doesn't require full evidence yet

  const acceptedWithoutReview: TaskAcceptance = { ...pending, status: "accepted" };
  const result = validateTaskAcceptance(acceptedWithoutReview);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "missing_review_ref"));
  assert.ok(result.issues.some((issue) => issue.code === "pending_required_check"));

  const complete: TaskAcceptance = {
    taskId: "T1",
    requiredChecks: [{ kind: "test", refId: "check1", outcome: "passed" }],
    reviewId: "review1",
    integrationCheckIds: ["integration1"],
    status: "accepted",
    acceptedAt: "2026-09-08T00:00:00.000Z",
  };
  assert.equal(validateTaskAcceptance(complete).valid, true);
});

// ---------------------------------------------------------------------------
// Assignment claim reassignment: proof of a stopped/fenced prior writer.
// ---------------------------------------------------------------------------

test("a claim can be reassigned only with proof the prior writer stopped/was fenced, advancing ownership generation", () => {
  const prior: AssignmentClaim = {
    id: "claim1",
    packetId: "T1",
    laneId: "lane-A",
    workerOrSessionId: "worker1",
    acceptedBaseRevision: "sha:base",
    branchOrWorktree: "wt/T1",
    writableSurfaces: ["runner-v2/src/example.ts"],
    forbiddenSurfaces: [],
    ownershipGeneration: 1,
    state: "claimed",
  };
  assert.equal(validateAssignmentClaim(prior).valid, true);

  const staleReassign: AssignmentClaim = { ...prior, id: "claim2", workerOrSessionId: "worker2", ownershipGeneration: 2 };
  assert.throws(() => assertClaimReassignable(prior, staleReassign), /stopped\/fenced writer evidence/);

  const stoppedPrior: AssignmentClaim = { ...prior, state: "stopped_fenced", writerStopEvidence: "process exited 0" };
  assert.equal(validateAssignmentClaim(stoppedPrior).valid, true);
  const nextGen: AssignmentClaim = { ...prior, id: "claim2", workerOrSessionId: "worker2", ownershipGeneration: 2 };
  assert.doesNotThrow(() => assertClaimReassignable(stoppedPrior, nextGen));

  const wrongGeneration: AssignmentClaim = { ...prior, id: "claim3", ownershipGeneration: 5 };
  assert.throws(() => assertClaimReassignable(stoppedPrior, wrongGeneration), /must advance ownershipGeneration/);

  const stoppedWithoutEvidence: AssignmentClaim = { ...prior, state: "stopped_fenced" };
  assert.equal(validateAssignmentClaim(stoppedWithoutEvidence).valid, false);
});

// ---------------------------------------------------------------------------
// PlanningCheckpoint and HostPlanningCapabilities structural completeness.
// ---------------------------------------------------------------------------

test("planning checkpoints require covered sections, completed contracts, remaining work, and next action", () => {
  const checkpoint: PlanningCheckpoint = {
    id: "cp1",
    coveredSourceSectionIds: ["s1", "s2"],
    completedPlanningContractIds: ["REQ-MANDATORY"],
    remainingWork: ["REQ-CONDITIONAL"],
    nextAction: "Resolve the conditional requirement.",
    recordedAt: "2026-09-08T00:00:00.000Z",
  };
  assert.equal(validatePlanningCheckpoint(checkpoint).valid, true);
  assert.equal(validatePlanningCheckpoint({ ...checkpoint, nextAction: "" }).valid, false);
});

test("host planning capabilities require an honest status and non-empty evidence for every named capability, including truthful unavailable/procedural marking", () => {
  const scenario = buildPlanningFixtureScenario();
  assert.equal(validateHostPlanningCapabilities(scenario.hostCapabilities).valid, true);
  // No invented capability: MAX_WORKERS ceiling is honestly recorded unavailable, not enforced.
  assert.equal(scenario.hostCapabilities.maxWorkersCeiling.status, "unavailable");
  assert.equal(scenario.hostCapabilities.atomicAssignmentClaims.status, "procedural");

  const missingEvidence: HostPlanningCapabilities = {
    ...scenario.hostCapabilities,
    maxWorkersCeiling: { status: "unavailable", evidence: "" },
  };
  assert.equal(validateHostPlanningCapabilities(missingEvidence).valid, false);
});

// ---------------------------------------------------------------------------
// Full fixture end-to-end sanity: the complete scenario is ready.
// ---------------------------------------------------------------------------

test("the complete synthetic fixture (mandatory/conditional/compatibility/operational/security/non-functional + amendment) is plan-ready", () => {
  const scenario = buildPlanningFixtureScenario();
  const revisionValidation = validateExecutionPlanRevision(scenario.revision, scenario.manifest);
  assert.deepEqual(revisionValidation.issues, []);
  assert.equal(revisionValidation.valid, true);

  const readiness = computePlanReadiness({
    manifest: scenario.manifest,
    revision: scenario.revision,
    coverageReview: scenario.coverageReview,
    hostCapabilities: scenario.hostCapabilities,
  });
  assert.deepEqual(readiness.blockers, []);
  assert.equal(readiness.ready, true);

  // scenario.manifest IS the approved amendment; it references its actual
  // predecessor (scenario.priorManifest) correctly, with a resolvable id.
  assert.equal(scenario.manifest.amendment?.id, "amend-1");
  assert.equal(scenario.manifest.amendment?.priorManifestId, scenario.priorManifest.manifestId);
  assert.equal(scenario.manifest.amendment?.priorArtifactDigest, scenario.priorManifest.artifactDigest);
  assert.equal(scenario.amendedManifest, scenario.manifest);

  // Every obligation kind is represented.
  const kinds = new Set(scenario.requirements.map((r) => r.obligationKind));
  for (const kind of ["mandatory", "conditional", "compatibility", "operational", "security", "non_functional"] as const) {
    assert.ok(kinds.has(kind), `expected obligation kind ${kind} in the fixture`);
  }
});

test("computeExecutionPlanRevisionDigest binds the complete snapshot: any mutation without rebinding the digest is rejected", () => {
  const scenario = buildPlanningFixtureScenario();
  const mutated = { ...scenario.revision, workflowPolicyVersion: 2 }; // digest not recomputed
  const result = validateExecutionPlanRevision(mutated, scenario.manifest);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "digest_mismatch"));
});

// ---------------------------------------------------------------------------
// Review repair cycle 1 — IMPORTANT fixes (I2, I3, I4, I6, I7) and M4.
// ---------------------------------------------------------------------------

test("I2: a mandatory (non-conditional) obligation cannot be retired by evidence alone — it requires an owner amendment; a conditional one can resolve by evidence", () => {
  const scenario = buildPlanningFixtureScenario();
  const requirements = buildFixtureRequirements(scenario.manifest);

  const evidenceOnlyMandatory = requirements.map((r) =>
    r.id === "REQ-MANDATORY"
      ? {
          ...r,
          applicability: {
            status: "not_applicable" as const,
            disposition: { authorizedBy: "architect", rationale: "no longer needed", evidenceRef: "ev1", decidedAt: "2026-09-22T00:00:00.000Z" },
          },
          contributingTaskIds: [],
        }
      : r,
  );
  const result = validateRequirementLedger(evidenceOnlyMandatory, scenario.manifest, FIXTURE_PHASES.map((p) => p.id));
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "unauthorized_mandatory_retirement" && issue.requirementId === "REQ-MANDATORY"));

  // The same evidence-only disposition on a CONDITIONAL requirement is fine —
  // that is exactly how a condition resolves to not_applicable.
  const evidenceOnlyConditional = requirements.map((r) =>
    r.id === "REQ-CONDITIONAL"
      ? {
          ...r,
          applicability: {
            status: "not_applicable" as const,
            disposition: { authorizedBy: "architect", rationale: "host has no launch-chip API", evidenceRef: "ev-host-probe", decidedAt: "2026-09-22T00:00:00.000Z" },
          },
          contributingTaskIds: [],
        }
      : r,
  );
  const conditionalResult = validateRequirementLedger(evidenceOnlyConditional, scenario.manifest, FIXTURE_PHASES.map((p) => p.id));
  assert.equal(conditionalResult.issues.some((issue) => issue.code === "unauthorized_mandatory_retirement"), false);
});

test("I3: acceptance criteria have resolvable ids, every criterion is mapped to a requirement the task claims, and requirement<->task links are bidirectionally consistent", () => {
  const scenario = buildPlanningFixtureScenario();
  const task = scenario.tasks.find((t) => t.id === "T1")!;

  // An empty requirementCriteriaMap is rejected (was previously valid).
  const emptyMap = { ...task, requirementCriteriaMap: [] };
  const emptyMapResult = validateExecutionTaskContract(emptyMap);
  assert.equal(emptyMapResult.valid, false);
  assert.ok(emptyMapResult.issues.some((issue) => issue.code === "incomplete_task_contract"));

  // A mapping to a nonexistent criterion id is rejected.
  const unknownCriterion = { ...task, requirementCriteriaMap: [{ taskLocalCriterionId: "does-not-exist", requirementId: "REQ-MANDATORY" }] };
  const unknownCriterionResult = validateExecutionTaskContract(unknownCriterion);
  assert.equal(unknownCriterionResult.valid, false);
  assert.ok(unknownCriterionResult.issues.some((issue) => issue.code === "unknown_criterion_ref"));

  // A mapping to a requirement the task does not claim in requirementIds is rejected.
  const unmappedRequirement = { ...task, requirementCriteriaMap: [{ taskLocalCriterionId: "c1", requirementId: "REQ-SECURITY" }] };
  const unmappedResult = validateExecutionTaskContract(unmappedRequirement);
  assert.equal(unmappedResult.valid, false);
  assert.ok(unmappedResult.issues.some((issue) => issue.code === "unmapped_requirement_ref"));

  // A criterion with no mapping entry at all is rejected.
  const twoCriteriaOneMapped = {
    ...task,
    acceptance: { ...task.acceptance, criteria: [...task.acceptance.criteria, { id: "c2", text: "A second criterion." }] },
  };
  const partialResult = validateExecutionTaskContract(twoCriteriaOneMapped);
  assert.equal(partialResult.valid, false);
  assert.ok(partialResult.issues.some((issue) => issue.code === "unmapped_criterion"));

  // Bidirectional trace: requirement.contributingTaskIds must agree with task.requirementIds.
  const asymmetricRequirements = scenario.requirements.map((r) => (r.id === "REQ-COMPAT" ? { ...r, contributingTaskIds: ["T1"] } : r)); // was T2
  const symmetryResult = validateExecutionPlanRevision(
    { ...scenario.revision, requirements: asymmetricRequirements, digest: computeExecutionPlanRevisionDigest({ ...scenario.revision, requirements: asymmetricRequirements }) },
    scenario.manifest,
  );
  assert.equal(symmetryResult.valid, false);
  assert.ok(symmetryResult.issues.some((issue) => issue.code === "asymmetric_requirement_task_link"));
});

test("I4: blank list entries are rejected, requiredBase is mandatory, and an investigation task cannot be an applicable requirement's only delivery", () => {
  const tasks = buildFixtureTasks();
  const t1 = tasks.find((t) => t.id === "T1")!;

  const blankStep = { ...t1, steps: [...t1.steps, "   "] };
  assert.equal(validateExecutionTaskContract(blankStep).valid, false);

  const noRequiredBase = { ...t1 } as Record<string, unknown>;
  delete noRequiredBase.requiredBase;
  const noBaseResult = validateExecutionTaskContract(noRequiredBase as unknown as ExecutionTaskContract);
  assert.equal(noBaseResult.valid, false);
  assert.ok(noBaseResult.issues.some((issue) => issue.code === "incomplete_task_contract"));

  // An applicable requirement whose ONLY contributing task is an
  // investigation task is rejected (investigation cannot substitute for
  // behavior delivery); a conditional_pending requirement is exempt.
  const scenario = buildPlanningFixtureScenario();
  const investigationOnlyRequirements = scenario.requirements.map((r) =>
    r.id === "REQ-MANDATORY" ? { ...r, contributingTaskIds: ["T-INV"] } : r,
  );
  const result = validateRequirementTaskCoverage(
    investigationOnlyRequirements,
    scenario.tasks,
    new Map(scenario.tasks.map((t) => [t.id, "planned"])),
  );
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "investigation_only_delivery" && issue.requirementId === "REQ-MANDATORY"));

  // REQ-CONDITIONAL's only contributing task IS an investigation task, and
  // that is fine while it stays conditional_pending.
  const conditionalOk = validateRequirementTaskCoverage(
    scenario.requirements,
    scenario.tasks,
    new Map(scenario.tasks.map((t) => [t.id, "planned"])),
  );
  assert.equal(conditionalOk.issues.some((issue) => issue.code === "investigation_only_delivery" && issue.requirementId === "REQ-CONDITIONAL"), false);
});

test("I6: an unresolved blocking finding holds plan readiness even when every obligation verdict is covered; a resolved disposition releases it", () => {
  const scenario = buildPlanningFixtureScenario();
  const withBlockingFinding: CoverageReview = {
    ...scenario.coverageReview,
    findings: [
      { id: "f-blocking", category: "scope_creep", severity: "blocking", claim: "The plan adds unrelated scope.", evidenceRefs: [] },
    ],
  };
  const readinessHeld = computePlanReadiness({
    manifest: scenario.manifest,
    revision: scenario.revision,
    coverageReview: withBlockingFinding,
    hostCapabilities: scenario.hostCapabilities,
  });
  assert.equal(readinessHeld.ready, false);

  // NEW-5: a self-set flag alone (no resolvedByReviewId/resolvedInRevisionDigest) does not clear it.
  const selfSetOnly: CoverageReview = {
    ...withBlockingFinding,
    findings: [
      {
        ...withBlockingFinding.findings[0]!,
        disposition: { resolution: "plan_reconciled", rationale: "Scope trimmed back.", resolvedAt: "2026-09-23T00:00:00.000Z" },
      },
    ],
  };
  const readinessSelfSetOnly = computePlanReadiness({
    manifest: scenario.manifest,
    revision: scenario.revision,
    coverageReview: selfSetOnly,
    hostCapabilities: scenario.hostCapabilities,
  });
  assert.equal(readinessSelfSetOnly.ready, false, "a disposition with no resolving review/revision reference must not clear a blocking finding");

  const resolved: CoverageReview = {
    ...withBlockingFinding,
    findings: [
      {
        ...withBlockingFinding.findings[0]!,
        disposition: {
          resolution: "plan_reconciled",
          rationale: "Scope trimmed back.",
          resolvedAt: "2026-09-23T00:00:00.000Z",
          resolvedByReviewId: "coverage_2",
        },
      },
    ],
  };
  const readinessReleased = computePlanReadiness({
    manifest: scenario.manifest,
    revision: scenario.revision,
    coverageReview: resolved,
    hostCapabilities: scenario.hostCapabilities,
  });
  assert.equal(readinessReleased.ready, true);
});

test("I7: phase acceptance requires EVERY contributing task to have a valid, accepted TaskAcceptance — not just any one of them", () => {
  const scenario = buildPlanningFixtureScenario();
  const bp1Requirements = scenario.requirements.filter((r) => r.accountablePhaseId === "BP1");
  const phaseAcceptance = {
    phaseId: "BP1",
    requirementIds: bp1Requirements.map((r) => r.id),
    taskAcceptanceRefs: ["T1", "T2", "T4"],
    status: "accepted" as const,
  };

  // T2 has NO recorded TaskAcceptance at all — the old "any accepted" rule
  // would have let T1/T4 alone satisfy their requirements; the new rule
  // requires every contributing task, so this must fail.
  const onlyT1AndT4: ReadonlyMap<string, TaskAcceptance> = new Map([
    ["T1", { taskId: "T1", requiredChecks: [{ kind: "test", refId: "c1", outcome: "passed" as const }], reviewId: "r1", integrationCheckIds: ["i1"], status: "accepted" as const, acceptedAt: "2026-09-23T00:00:00.000Z" }],
    ["T4", { taskId: "T4", requiredChecks: [{ kind: "test", refId: "c1", outcome: "passed" as const }], reviewId: "r2", integrationCheckIds: ["i2"], status: "accepted" as const, acceptedAt: "2026-09-23T00:00:00.000Z" }],
  ]);
  const partial = validatePhaseAcceptance(phaseAcceptance, scenario.requirements, onlyT1AndT4, scenario.manifest);
  assert.equal(partial.valid, false);
  assert.ok(partial.issues.some((issue) => issue.code === "unaccepted_contributing_task" && issue.taskId === "T2"));

  // A TaskAcceptance that is structurally invalid (e.g. missing acceptedAt)
  // does not count either, even if status says "accepted".
  const invalidT2: TaskAcceptance = { taskId: "T2", requiredChecks: [{ kind: "test", refId: "c1", outcome: "passed" }], reviewId: "r3", integrationCheckIds: [], status: "accepted" };
  const withInvalidT2 = new Map([...onlyT1AndT4, ["T2", invalidT2]]);
  const invalidResult = validatePhaseAcceptance(phaseAcceptance, scenario.requirements, withInvalidT2, scenario.manifest);
  assert.equal(invalidResult.valid, false);

  // requirementIds/taskAcceptanceRefs declared on the PhaseAcceptance must
  // match the phase's actual owned requirements/contributing tasks.
  const mismatchedRefs = { ...phaseAcceptance, requirementIds: ["REQ-DOES-NOT-EXIST"] };
  const mismatchResult = validatePhaseAcceptance(mismatchedRefs, scenario.requirements, withInvalidT2, scenario.manifest);
  assert.ok(mismatchResult.issues.some((issue) => issue.code === "requirement_refs_mismatch"));

  // Every T1/T2/T4 validly accepted -> the phase accepts.
  const validT2: TaskAcceptance = { taskId: "T2", requiredChecks: [{ kind: "test", refId: "c1", outcome: "passed" }], reviewId: "r3", integrationCheckIds: ["i3"], status: "accepted", acceptedAt: "2026-09-23T00:00:00.000Z" };
  const allAccepted = new Map([...onlyT1AndT4, ["T2", validT2]]);
  const fullResult = validatePhaseAcceptance(phaseAcceptance, scenario.requirements, allAccepted, scenario.manifest);
  assert.equal(fullResult.valid, true);
});

test("M4: a coverage verdict citing an obligation id that was never derived is rejected", () => {
  const scenario = buildPlanningFixtureScenario();
  const undeclaredVerdict: CoverageReview = {
    ...scenario.coverageReview,
    obligationVerdicts: [
      ...scenario.coverageReview.obligationVerdicts,
      { obligationId: "obl-NEVER-DERIVED", verdict: "covered", severity: "advisory", rationale: "x", evidenceRefs: [] },
    ],
  };
  const result = validateCoverageReview(undeclaredVerdict);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "verdict_for_undeclared_obligation"));
});
