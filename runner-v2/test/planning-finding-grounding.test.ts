import assert from "node:assert/strict";
import test from "node:test";

import { parsePlanCritiqueFindings } from "../src/plan-critique-contracts.js";
import type { BuildTask } from "../src/task-contracts.js";
import { parsePlanningFindingEvidence, type PlanningFindingEvidenceContext } from "../src/planning-finding-evidence.js";

const INVITATIONS = "Invite friends to tables, view invitations, and accept or decline them.";
const ONLINE_INVITATIONS = "The invitation picker displays only online friends.";
function tasks(invitationCriterion = INVITATIONS): Record<string, BuildTask> {
  return {
    T3: { id: "T3", objective: "Online Presence API", dependencies: [], status: "planned", requiredCapabilities: [], attempt: 0,
      acceptanceCriteria: [{ id: "presence", text: "GET /api/friends/presence returns online status." }] },
    T7: { id: "T7", objective: "Table Invitation UI", dependencies: [], status: "planned", requiredCapabilities: [], attempt: 0,
      acceptanceCriteria: [{ id: "invitations", text: invitationCriterion }] },
  };
}
function dependencyFinding(criterion = ONLINE_INVITATIONS) {
  return {
    findingId: "dependency-T7-T3", category: "missing_dependency", severity: "blocking", taskIds: ["T7", "T3"],
    claim: "T7 requires T3's presence endpoint to meet its invitation criterion.",
    evidence: ["T7:invitations", "T3:presence"],
    blockingEvidence: {
      taskIds: ["T7", "T3"],
      criteria: [{ kind: "task", taskId: "T7", criterionId: "invitations", text: criterion }],
      requiredContract: "GET /api/friends/presence",
      failureWithoutChange: "Run the invitation picker before T3: the required presence request is unavailable and the picker cannot filter to online friends.",
      proposedFix: "Add T3 to T7.dependencies.",
      dependency: { taskId: "T7", missingDependency: "T3" },
    },
  };
}
const strict = { requireBlockingEvidence: true, objective: "Deliver friends, presence and table invitations." };

test("the friends evaluation's invented online-sorting requirement cannot become a blocking dependency", () => {
  assert.throws(() => parsePlanCritiqueFindings([dependencyFinding()], tasks(), strict), /criterion.*text|text.*criterion/i);
});

test("an actual consumer criterion and named contract support a reviewable dependency finding", () => {
  const finding = dependencyFinding();
  const parsed = parsePlanCritiqueFindings([finding], tasks(ONLINE_INVITATIONS), strict);
  assert.deepEqual(parsed[0]?.blockingEvidence, finding.blockingEvidence);
});

test("every new blocking finding needs grounded failure evidence, while suggestions and old logs remain readable", () => {
  const { blockingEvidence: _proof, ...bare } = dependencyFinding();
  for (const category of ["missing_dependency", "oversized_task", "undersized_task", "incoherent_task", "overlapping_scope", "untestable_criterion", "missing_integration_task"]) {
    assert.throws(() => parsePlanCritiqueFindings([{ ...bare, category }], tasks(), strict), /blockingEvidence|blocking evidence/i);
    assert.equal(parsePlanCritiqueFindings([{ ...bare, category, severity: "advisory" }], tasks(), strict)[0]?.severity, "advisory");
  }
  assert.equal(parsePlanCritiqueFindings([bare], tasks())[0]?.severity, "blocking", "historical unversioned findings retain their recorded meaning");
});

test("dependency proof rejects unknown references, producer-only criteria, redundant edges and cycles", () => {
  const known = tasks(ONLINE_INVITATIONS);
  for (const bad of [
    { ...dependencyFinding(), blockingEvidence: { ...dependencyFinding().blockingEvidence, dependency: { taskId: "T7", missingDependency: "T404" } } },
    { ...dependencyFinding(), blockingEvidence: { ...dependencyFinding().blockingEvidence, criteria: [{ kind: "task", taskId: "T7", criterionId: "invented", text: ONLINE_INVITATIONS }] } },
    { ...dependencyFinding(), blockingEvidence: { ...dependencyFinding().blockingEvidence, criteria: [{ kind: "task", taskId: "T3", criterionId: "presence", text: known.T3!.acceptanceCriteria![0]!.text }] } },
    { ...dependencyFinding(), blockingEvidence: { ...dependencyFinding().blockingEvidence, dependency: { taskId: "T7", missingDependency: "T7" } } },
  ]) assert.throws(() => parsePlanCritiqueFindings([bad], known, strict));
  known.T7!.dependencies = ["T3"];
  assert.throws(() => parsePlanCritiqueFindings([dependencyFinding()], known, strict), /already|transitive/i);
  known.T7!.dependencies = ["T5"];
  known.T5 = { ...known.T3!, id: "T5", dependencies: ["T3"] };
  assert.throws(() => parsePlanCritiqueFindings([dependencyFinding()], known, strict), /already|transitive/i);
  known.T7!.dependencies = [];
  known.T3!.dependencies = ["T7"];
  assert.throws(() => parsePlanCritiqueFindings([dependencyFinding()], known, strict), /cycle/i);
});

test("blocking cohesion findings name the actual acceptance boundaries of every affected task", () => {
  const known = tasks();
  const evidence = {
    ...dependencyFinding().blockingEvidence,
    criteria: [
      { kind: "task", taskId: "T7", criterionId: "invitations", text: INVITATIONS },
      { kind: "task", taskId: "T3", criterionId: "presence", text: known.T3!.acceptanceCriteria![0]!.text },
    ],
  };
  const { dependency: _edge, ...proof } = evidence;
  const finding = { ...dependencyFinding(), category: "undersized_task", blockingEvidence: proof };
  assert.doesNotThrow(() => parsePlanCritiqueFindings([finding], known, strict));
  assert.throws(() => parsePlanCritiqueFindings([{ ...finding, blockingEvidence: { ...proof, criteria: proof.criteria.slice(0, 1) } }], known, strict), /criterion|criteria|acceptance/i);
  assert.throws(() => parsePlanCritiqueFindings([{ ...finding, taskIds: ["T7"], blockingEvidence: { ...proof, taskIds: ["T7"], criteria: proof.criteria.slice(0, 1) } }], known, strict), /two|2|tasks/i);
  for (const key of ["requiredContract", "failureWithoutChange", "proposedFix"] as const) {
    assert.throws(() => parsePlanCritiqueFindings([{ ...finding, blockingEvidence: { ...proof, [key]: " " } }], known, strict), new RegExp(key));
  }
});

test("scope blockers cite declared surfaces, while omitted work can cite a real source obligation", () => {
  const known = tasks();
  const context: PlanningFindingEvidenceContext = {
    tasks: Object.values(known).map((task) => ({ id: task.id, dependencies: task.dependencies, criteria: task.acceptanceCriteria!, writableSurfaces: ["src/friends.ts"] })),
    requirements: [{ id: "R1", acceptanceConditions: [{ id: "R1-ac1", description: "Invite friends to tables." }] }],
    obligations: [{ id: "O1", description: "Expired invitations are removed." }],
  };
  const { dependency: _edge, ...base } = dependencyFinding(INVITATIONS).blockingEvidence;
  const scope = { ...base, surfaces: [{ taskId: "T3", surface: "src/friends.ts" }, { taskId: "T7", surface: "src/friends.ts" }] };
  const finding = { category: "overlapping_scope", severity: "blocking", references: ["T7:invitations"] };
  assert.ok(parsePlanningFindingEvidence(scope, finding, context, true));
  assert.throws(() => parsePlanningFindingEvidence({ ...scope, surfaces: [{ taskId: "T3", surface: "invented.ts" }, scope.surfaces[1]] }, finding, context, true), /declared writable surface/);
  assert.throws(() => parsePlanningFindingEvidence({ ...scope, surfaces: scope.surfaces.slice(0, 1) }, finding, context, true), /every affected task/);
  const omitted = { ...base, taskIds: [], criteria: [{ kind: "obligation", obligationId: "O1", text: "Expired invitations are removed." }] };
  const gap = { category: "missing_coverage", severity: "blocking", references: ["O1"] };
  assert.ok(parsePlanningFindingEvidence(omitted, gap, context, true));
  assert.throws(() => parsePlanningFindingEvidence({ ...omitted, criteria: [{ kind: "obligation", obligationId: "O1", text: "Invented online sorting." }] }, gap, context, true), /recorded blind source obligations/);
  const requirement = { ...omitted, criteria: [{ kind: "requirement", requirementId: "R1", criterionId: "R1-ac1", text: "Invite friends to tables." }] };
  assert.ok(parsePlanningFindingEvidence(requirement, gap, context, true));
  assert.throws(() => parsePlanningFindingEvidence({ ...requirement, criteria: [{ ...requirement.criteria[0], criterionId: "invented" }] }, gap, context, true), /requirement criterion/);
  assert.throws(() => parsePlanningFindingEvidence(omitted, { ...gap, references: [] }, context, true), /non-empty evidence references/);
});
