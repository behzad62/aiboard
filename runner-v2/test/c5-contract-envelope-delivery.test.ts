import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModelRequest, NativeTool, ToolExecutionOutput } from "../src/agent-contracts.js";
import {
  buildReviewerContractBlock,
  buildWorkerContext,
  buildWorkerContractBlock,
  REVIEWER_CONTRACT_SECTION_ID,
  WORKER_CONTRACT_SECTION_ID,
  workerContextSections,
  type BuildWorkerContextInput,
} from "../src/agent-prompts.js";
import { ContextAssembler, ProtectedContextOverflowError, type ContextSection } from "../src/context-assembler.js";
import { toContextManifest } from "../src/context-manifest-store.js";
import {
  buildExecutionPlanRevision,
  computeExecutionPlanRevisionDigest,
  KERNEL_STAMPED_REVISION_FIELDS,
  normalizePlanSubmission,
  requiredBaseForRevision,
  validateExecutionPlanRevision,
  validateCoverageReviewBinding,
  type ExecutionPlanRevision,
  type ExecutionPlanRevisionWithoutDigest,
  type PlanSubmissionActuals,
  type PlanSubmissionRevision,
  type StampedPlanSubmission,
} from "../src/planning-contracts.js";
import { createPlanningTools } from "../src/planning-tools.js";
import { DELIVERABLE_REVIEW_CONTEXT_LIMITS, NativeDeliverableReviewRuntime, type DeliverableReviewInputs } from "../src/native-deliverable-review.js";
import { loadDeliverableReviewInputs, type DurableSubmission } from "../src/delivery-execution.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { NATIVE_WORKER_CONTEXT_LIMITS, resolveWorkerTaskContract, WorkerContractUnavailableError } from "../src/native-worker-driver.js";
import {
  readyPlanIdentity,
  rebuildSchedulerProjection,
  reduceSchedulerEvent,
  resolveTaskContractAtRef,
  resolveTaskContractReference,
  type NewSchedulerEvent,
  type SchedulerEvent,
  type SchedulerProjection,
  type SchedulerStore,
} from "../src/scheduler-store.js";
import type { ApprovedSourceManifest } from "../src/source-manifest.js";
import type { BuildTask, TaskContractRef } from "../src/task-contracts.js";
import { HIGH_CONTENT, runDeliveryFactoryScenario } from "./support/delivery-factory-scenario.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { buildPlanningFixtureScenario } from "./fixtures/planning-source-fixture.js";
import { seedBoundCoverageAndReady } from "./support/planning-seed.js";
import { buildFixtureCoverageReview } from "./fixtures/planning-source-fixture.js";

/**
 * C5 (AR-R15/AR-R16): kernel envelope stamping, reciprocal link
 * derivation, and compact contract delivery to workers and reviewers.
 *
 * anything here must fail if the kernel stops owning the envelope or the
 * worker context stops carrying the authoritative compact contract.
 */

const CLOCK = "2026-09-24T00:00:00.000Z";
const clock = () => CLOCK;

class MemorySchedulerStore implements SchedulerStore {
  readonly events: SchedulerEvent[] = [];
  private readonly projections = new Map<string, SchedulerProjection | undefined>();

  append(input: NewSchedulerEvent): SchedulerEvent {
    const existing = this.events.find(
      (event) => event.runId === input.runId && event.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return existing;
    const event: SchedulerEvent = {
      ...input,
      eventId: `memory_${this.events.length + 1}`,
      sequence: this.events.filter((candidate) => candidate.runId === input.runId).length + 1,
    };
    this.projections.set(
      input.runId,
      reduceSchedulerEvent(this.projections.get(input.runId), event),
    );
    this.events.push(event);
    return event;
  }

  readRun(runId: string): SchedulerEvent[] {
    return this.events.filter((event) => event.runId === runId);
  }

  close(): void {}
}

function projectionOf(store: SchedulerStore, runId: string): SchedulerProjection {
  return rebuildSchedulerProjection(store.readRun(runId));
}

async function invokePlanningTool(
  tools: readonly NativeTool<unknown>[],
  name: string,
  args: unknown,
  runId: string,
): Promise<ToolExecutionOutput> {
  const tool = tools.find((candidate) => candidate.definition.name === name);
  assert.ok(tool, `planning tool ${name} is registered`);
  const validation = tool.validate(args);
  assert.equal(validation.ok, true, `arguments for ${name} validate`);
  return await tool.execute(
    validation.ok ? validation.value : undefined,
    { runId, sessionId: `architect:${runId}`, actor: { role: "architect", id: "architect_1" } },
  );
}

type C5Fixture = ReturnType<typeof buildPlanningFixtureScenario>;

function c5Fixture(runId: string): C5Fixture {
  const raw = buildPlanningFixtureScenario({ runId, createdAt: CLOCK });
  const amendment = raw.manifest.amendment!;
  return {
    ...raw,
    manifest: {
      ...raw.manifest,
      amendment: {
        ...amendment,
        recordedImpact: {
          addsSectionIds: ["s8"],
          retiresSectionIds: ["s7"],
          addsRequirementIds: [],
          retiresRequirementIds: ["REQ-RETIRED"],
        },
      },
    },
  };
}

function actualsFor(runId: string, manifest: ApprovedSourceManifest): PlanSubmissionActuals {
  return {
    runId,
    sourceManifestId: manifest.manifestId,
    sourceManifestDigest: manifest.artifactDigest,
    ledgerRequirements: c5Fixture(runId).requirements,
    workflowPolicyVersion: 1,
    createdAt: CLOCK,
  };
}

/** The submission with every kernel-owned value omitted (stamping path). */
function strippedSubmission(fixture: C5Fixture, revisionId: string): PlanSubmissionRevision {
  const clone = structuredClone(fixture.revision) as unknown as Record<string, unknown>;
  for (const field of [...KERNEL_STAMPED_REVISION_FIELDS]) delete clone[field];
  const tasks = clone["tasks"] as Record<string, unknown>[];
  for (const task of tasks) delete task["requiredBase"];
  // Kernel-owned decision/disposition timestamps are omitted so the
  // boundary stamps them; a supplied fixture time would mismatch the
  // kernel clock and must be refused, never silently repaired.
  for (const key of ["planningDecisions", "nonNormativeSections", "retiredRequirementIds"] as const) {
    const records = clone[key];
    if (Array.isArray(records)) {
      for (const record of records) delete (record as Record<string, unknown>)["decidedAt"];
    }
  }
  for (const requirement of clone["requirements"] as Array<{ applicability: { disposition?: Record<string, unknown> } }>) {
    if (requirement.applicability.disposition) delete requirement.applicability.disposition["decidedAt"];
  }
  clone["revisionId"] = revisionId;
  if (revisionId !== "revision_1") {
    for (const task of tasks) task["requiredBase"] = requiredBaseForRevision(revisionId);
  }
  delete clone["digest"];
  return clone as unknown as PlanSubmissionRevision;
}

function seedPolicySourceLedger(store: SchedulerStore, runId: string, fixture: C5Fixture): void {
  store.append({
    runId,
    type: "run.policy_configured",
    occurredAt: CLOCK,
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: "run-policy-configured",
    payload: { runPolicy: "finish" },
  });
  store.append({
    runId,
    type: "planning.policy_configured",
    occurredAt: CLOCK,
    actor: { role: "runner", id: "runner" },
    idempotencyKey: "planning-policy:1",
    payload: { version: 1 },
  });
  store.append({
    runId,
    type: "planning.source_registered",
    occurredAt: CLOCK,
    actor: { role: "user", id: "owner" },
    idempotencyKey: "source:base",
    payload: { manifest: fixture.priorManifest },
  });
  store.append({
    runId,
    type: "planning.source_amended",
    occurredAt: CLOCK,
    actor: { role: "user", id: "owner" },
    idempotencyKey: "source:amend-1",
    payload: { manifest: fixture.manifest },
  });
  store.append({
    runId,
    type: "request.triaged",
    occurredAt: CLOCK,
    actor: { role: "architect", id: "architect_1" },
    idempotencyKey: "triage:build",
    payload: { decision: "build", rationale: "C5: the fixture request changes the project." },
  });
  store.append({
    runId,
    type: "planning.ledger_persisted",
    occurredAt: CLOCK,
    actor: { role: "architect", id: "architect_1" },
    idempotencyKey: "ledger:1",
    payload: {
      id: "ledger-1",
      requirements: fixture.requirements,
      phases: fixture.phases,
      nonNormativeSections: [],
    },
  });
}

function assertOk(result: StampedPlanSubmission): asserts result is {
  ok: true;
  revision: ExecutionPlanRevisionWithoutDigest;
  derived: readonly string[];
} {
  assert.equal(result.ok, true, result.ok ? "" : result.failure.message);
}

// ---------------------------------------------------------------------------
// Envelope: omission stamps, supplied values must match.
// ---------------------------------------------------------------------------

test("C5 omitted envelope is stamped from actuals with requiredBase per task", () => {
  const runId = "run_c5_stamp";
  const fixture = c5Fixture(runId);
  const result = normalizePlanSubmission(strippedSubmission(fixture, "revision_9"), actualsFor(runId, fixture.manifest));
  assertOk(result);
  const revision = result.revision as unknown as Record<string, unknown>;
  assert.equal(revision["runId"], runId);
  assert.equal(revision["sourceManifestId"], fixture.manifest.manifestId);
  assert.equal(revision["sourceManifestDigest"], fixture.manifest.artifactDigest);
  assert.equal(revision["workflowPolicyVersion"], 1);
  assert.equal(revision["createdAt"], CLOCK);
  assert.equal("coverageReviewId" in revision, false);
  assert.equal("repairBudgetLineageId" in revision, false);
  for (const task of revision["tasks"] as Record<string, unknown>[]) {
    assert.equal(task["requiredBase"], "accepted plan revision revision_9");
  }
});

test("C5 supplied matching envelope is kept and the digest binds the stamped content", () => {
  const runId = "run_c5_kept";
  const fixture = c5Fixture(runId);
  const { digest: _digest, ...supplied } = fixture.revision;
  void _digest;
  // A supplied timestamp must match the kernel actual: for a new record
  // with no durable identity that is the kernel submission time (CLOCK).
  const decisions = (supplied as unknown as { planningDecisions: Array<Record<string, unknown>> }).planningDecisions;
  for (const decision of decisions) decision["decidedAt"] = CLOCK;
  const result = normalizePlanSubmission(supplied as PlanSubmissionRevision, actualsFor(runId, fixture.manifest));
  assertOk(result);
  const stored = buildExecutionPlanRevision(result.revision);
  assert.equal(stored.digest, computeExecutionPlanRevisionDigest(result.revision));
  assert.equal(validateExecutionPlanRevision(stored, fixture.manifest).valid, true);
});

test("C5 authoritative absence: omitted review/lineage stay absent, supplied values refused", () => {
  const runId = "run_c5_absence";
  const fixture = c5Fixture(runId);
  const actuals = actualsFor(runId, fixture.manifest);
  const omitted = normalizePlanSubmission(strippedSubmission(fixture, "revision_1"), actuals);
  assertOk(omitted);
  assert.equal("coverageReviewId" in (omitted.revision as unknown as Record<string, unknown>), false);
  for (const field of ["coverageReviewId", "repairBudgetLineageId"] as const) {
    const supplied = { ...strippedSubmission(fixture, "revision_1"), [field]: "some_stamped_id" } as unknown as PlanSubmissionRevision;
    const refused = normalizePlanSubmission(supplied, actuals);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.failure.code, "envelope_mismatch");
  }
});

test("C5 carried review/lineage actuals stamp when present and match when supplied", () => {
  const runId = "run_c5_carry";
  const fixture = c5Fixture(runId);
  const actuals: PlanSubmissionActuals = {
    ...actualsFor(runId, fixture.manifest),
    coverageReviewId: "coverage_live",
    repairBudgetLineageId: "lineage_7",
  };
  const omitted = normalizePlanSubmission(strippedSubmission(fixture, "revision_1"), actuals);
  assertOk(omitted);
  const revision = omitted.revision as unknown as Record<string, unknown>;
  assert.equal(revision["coverageReviewId"], "coverage_live");
  assert.equal(revision["repairBudgetLineageId"], "lineage_7");
  const kept = {
    ...strippedSubmission(fixture, "revision_1"),
    coverageReviewId: "coverage_live",
    repairBudgetLineageId: "lineage_7",
  } as PlanSubmissionRevision;
  assert.equal(normalizePlanSubmission(kept, actuals).ok, true);
  const wrong = {
    ...strippedSubmission(fixture, "revision_1"),
    coverageReviewId: "coverage_other",
  } as PlanSubmissionRevision;
  const refused = normalizePlanSubmission(wrong, actuals);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.failure.code, "envelope_mismatch");
});

test("C5 explicit blank, null and wrong-typed envelope values are refused, never repaired", () => {
  const runId = "run_c5_strict";
  const fixture = c5Fixture(runId);
  const actuals = actualsFor(runId, fixture.manifest);
  const cases: [string, unknown][] = [
    ["blank runId", { runId: "" }],
    ["blank createdAt", { createdAt: "   " }],
    ["null runId", { runId: null }],
    ["null sourceManifestId", { sourceManifestId: null }],
    ["wrong-typed policy version", { workflowPolicyVersion: "1" }],
    ["wrong-typed createdAt", { createdAt: 0 }],
  ];
  for (const [label, patch] of cases) {
    const submission = { ...strippedSubmission(fixture, "revision_1"), ...(patch as Record<string, unknown>) } as unknown as PlanSubmissionRevision;
    const refused = normalizePlanSubmission(submission, actuals);
    assert.equal(refused.ok, false, label);
    if (!refused.ok) assert.equal(refused.failure.code, "envelope_mismatch", label);
  }
  const baseBlank = strippedSubmission(fixture, "revision_1");
  (baseBlank.tasks[0] as unknown as Record<string, unknown>)["requiredBase"] = "";
  const baseRefused = normalizePlanSubmission(baseBlank, actuals);
  assert.equal(baseRefused.ok, false);
  if (!baseRefused.ok) assert.equal(baseRefused.failure.code, "base_mismatch");
});

// ---------------------------------------------------------------------------
// Reciprocal links: derive the silent side, refuse conflict/unknown.
// ---------------------------------------------------------------------------

function linkNode(
  revision: PlanSubmissionRevision,
  collection: "requirements" | "tasks" | "phases",
  id: string,
): Record<string, unknown> {
  const list = (revision as unknown as Record<string, Record<string, unknown>[]>)[collection];
  const node = list.find((entry) => entry["id"] === id);
  assert.ok(node, `${collection} ${id} exists`);
  return node;
}

function withLinkEdits(
  fixture: C5Fixture,
  revisionId: string,
  edit: (revision: PlanSubmissionRevision) => void,
): PlanSubmissionRevision {
  const submission = strippedSubmission(fixture, revisionId);
  edit(submission);
  return submission;
}

function deleteField(revision: PlanSubmissionRevision, collection: "requirements" | "tasks" | "phases", id: string, field: string): void {
  delete linkNode(revision, collection, id)[field];
}

test("C5 one-sided requirement/task links derive in both directions", () => {
  const runId = "run_c5_link_both";
  const fixture = c5Fixture(runId);
  const actuals = actualsFor(runId, fixture.manifest);
  const fromTask = withLinkEdits(fixture, "revision_1", (revision) => {
    deleteField(revision, "tasks", "T1", "requirementIds");
  });
  const derivedTask = normalizePlanSubmission(fromTask, actuals);
  assertOk(derivedTask);
  assert.deepEqual(linkNode(derivedTask.revision as unknown as PlanSubmissionRevision, "tasks", "T1")["requirementIds"], ["REQ-MANDATORY"]);
  const fromRequirement = withLinkEdits(fixture, "revision_1", (revision) => {
    deleteField(revision, "requirements", "REQ-MANDATORY", "contributingTaskIds");
  });
  const derivedRequirement = normalizePlanSubmission(fromRequirement, actuals);
  assertOk(derivedRequirement);
  assert.deepEqual(
    linkNode(derivedRequirement.revision as unknown as PlanSubmissionRevision, "requirements", "REQ-MANDATORY")["contributingTaskIds"],
    ["T1"],
  );
});

test("C5 fan-in derives without false conflict on the shared silent side", () => {
  const runId = "run_c5_fanin";
  const fixture = c5Fixture(runId);
  const actuals = actualsFor(runId, fixture.manifest);
  // Two requirements name one silent task.
  const twoToOne = withLinkEdits(fixture, "revision_1", (revision) => {
    linkNode(revision, "requirements", "REQ-COMPAT")["contributingTaskIds"] = ["T1"];
    linkNode(revision, "tasks", "T2")["requirementIds"] = [];
    deleteField(revision, "tasks", "T1", "requirementIds");
  });
  const first = normalizePlanSubmission(twoToOne, actuals);
  assertOk(first);
  assert.deepEqual(linkNode(first.revision as unknown as PlanSubmissionRevision, "tasks", "T1")["requirementIds"], [
    "REQ-MANDATORY",
    "REQ-COMPAT",
  ]);
  // Two tasks name one silent requirement.
  const tasksToOne = withLinkEdits(fixture, "revision_1", (revision) => {
    linkNode(revision, "tasks", "T2")["requirementIds"] = ["REQ-MANDATORY"];
    linkNode(revision, "requirements", "REQ-COMPAT")["contributingTaskIds"] = [];
    deleteField(revision, "requirements", "REQ-MANDATORY", "contributingTaskIds");
  });
  const second = normalizePlanSubmission(tasksToOne, actuals);
  assertOk(second);
  assert.deepEqual(
    linkNode(second.revision as unknown as PlanSubmissionRevision, "requirements", "REQ-MANDATORY")["contributingTaskIds"],
    ["T1", "T2"],
  );
  // Several members derive into one silent phase list.
  const membersToPhase = withLinkEdits(fixture, "revision_1", (revision) => {
    deleteField(revision, "phases", "BP1", "requirementIds");
  });
  const third = normalizePlanSubmission(membersToPhase, actuals);
  assertOk(third);
  assert.deepEqual(linkNode(third.revision as unknown as PlanSubmissionRevision, "phases", "BP1")["requirementIds"], [
    "REQ-MANDATORY",
    "REQ-COMPAT",
    "REQ-SECURITY",
    "REQ-RETIRED",
  ]);
});

test("C5 conflicting supplied sides are refused in both directions", () => {
  const runId = "run_c5_conflict";
  const fixture = c5Fixture(runId);
  const actuals = actualsFor(runId, fixture.manifest);
  const requirementFirst = withLinkEdits(fixture, "revision_1", (revision) => {
    linkNode(revision, "requirements", "REQ-MANDATORY")["contributingTaskIds"] = ["T3"];
  });
  const first = normalizePlanSubmission(requirementFirst, actuals);
  assert.equal(first.ok, false);
  if (!first.ok) assert.equal(first.failure.code, "link_conflict");
  const taskFirst = withLinkEdits(fixture, "revision_1", (revision) => {
    linkNode(revision, "tasks", "T1")["requirementIds"] = ["REQ-COMPAT"];
  });
  const second = normalizePlanSubmission(taskFirst, actuals);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.failure.code, "link_conflict");
  // An explicitly disagreeing phase owner is refused.
  const ownerDisagrees = withLinkEdits(fixture, "revision_1", (revision) => {
    linkNode(revision, "phases", "BP1")["requirementIds"] = ["REQ-COMPAT", "REQ-SECURITY", "REQ-RETIRED"];
  });
  const third = normalizePlanSubmission(ownerDisagrees, actuals);
  assert.equal(third.ok, false);
  if (!third.ok) assert.equal(third.failure.code, "link_conflict");
});

test("C5 omitted accountablePhaseId derives from one unique phase membership", () => {
  const runId = "run_c5_reverse";
  const fixture = c5Fixture(runId);
  const actuals = actualsFor(runId, fixture.manifest);
  const reverse = withLinkEdits(fixture, "revision_1", (revision) => {
    deleteField(revision, "requirements", "REQ-MANDATORY", "accountablePhaseId");
    deleteField(revision, "tasks", "T1", "accountablePhaseId");
  });
  const result = normalizePlanSubmission(reverse, actuals);
  assertOk(result);
  assert.equal(linkNode(result.revision as unknown as PlanSubmissionRevision, "requirements", "REQ-MANDATORY")["accountablePhaseId"], "BP1");
  assert.equal(linkNode(result.revision as unknown as PlanSubmissionRevision, "tasks", "T1")["accountablePhaseId"], "BP1");
  // Two naming phases are ambiguous and refused.
  const ambiguous = withLinkEdits(fixture, "revision_1", (revision) => {
    deleteField(revision, "requirements", "REQ-MANDATORY", "accountablePhaseId");
    (linkNode(revision, "phases", "BP2")["requirementIds"] as string[]).push("REQ-MANDATORY");
  });
  const refused = normalizePlanSubmission(ambiguous, actuals);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.failure.code, "link_conflict");
});

test("C5 unknown identities are refused on every side", () => {
  const runId = "run_c5_unknown";
  const fixture = c5Fixture(runId);
  const actuals = actualsFor(runId, fixture.manifest);
  const cases: [string, (revision: PlanSubmissionRevision) => void, string][] = [
    ["task names unknown requirement", (revision) => {
      linkNode(revision, "tasks", "T1")["requirementIds"] = ["REQ-NOPE"];
    }, "unknown_requirement_ref"],
    ["requirement names unknown task", (revision) => {
      linkNode(revision, "requirements", "REQ-MANDATORY")["contributingTaskIds"] = ["T-NOPE"];
    }, "unknown_task_ref"],
    ["requirement names unknown phase", (revision) => {
      linkNode(revision, "requirements", "REQ-MANDATORY")["accountablePhaseId"] = "BP-NOPE";
    }, "unknown_phase_ref"],
    ["task names unknown phase", (revision) => {
      linkNode(revision, "tasks", "T1")["accountablePhaseId"] = "BP-NOPE";
    }, "unknown_phase_ref"],
    ["phase lists unknown requirement", (revision) => {
      (linkNode(revision, "phases", "BP1")["requirementIds"] as string[]).push("REQ-NOPE");
    }, "unknown_requirement_ref"],
    ["phase lists unknown task", (revision) => {
      (linkNode(revision, "phases", "BP1")["contributingTaskIds"] as string[]).push("T-NOPE");
    }, "unknown_task_ref"],
  ];
  for (const [label, edit, code] of cases) {
    const refused = normalizePlanSubmission(withLinkEdits(fixture, "revision_1", edit), actuals);
    assert.equal(refused.ok, false, label);
    if (!refused.ok) assert.equal(refused.failure.code, code, label);
  }
});

test("C5 omitted reciprocal arrays initialize; malformed sides fail closed", () => {
  const runId = "run_c5_shapes";
  const fixture = c5Fixture(runId);
  const actuals = actualsFor(runId, fixture.manifest);
  // A legitimately omitted side initializes instead of throwing on push.
  const omitted = withLinkEdits(fixture, "revision_1", (revision) => {
    deleteField(revision, "phases", "BP1", "contributingTaskIds");
  });
  const initialized = normalizePlanSubmission(omitted, actuals);
  assertOk(initialized);
  assert.deepEqual(linkNode(initialized.revision as unknown as PlanSubmissionRevision, "phases", "BP1")["contributingTaskIds"], [
    "T1",
    "T2",
    "T4",
  ]);
  const malformed: [string, (revision: PlanSubmissionRevision) => void][] = [
    ["null task side", (revision) => {
      linkNode(revision, "tasks", "T1")["requirementIds"] = null;
    }],
    ["bare-string requirement side", (revision) => {
      linkNode(revision, "requirements", "REQ-MANDATORY")["contributingTaskIds"] = "T1";
    }],
    ["non-string phase entries", (revision) => {
      linkNode(revision, "phases", "BP1")["requirementIds"] = [42];
    }],
    ["numeric owner", (revision) => {
      linkNode(revision, "tasks", "T1")["accountablePhaseId"] = 7;
    }],
  ];
  for (const [label, edit] of malformed) {
    const refused = normalizePlanSubmission(withLinkEdits(fixture, "revision_1", edit), actuals);
    assert.equal(refused.ok, false, label);
    if (!refused.ok) assert.equal(refused.failure.code, "malformed_link", label);
  }
});

test("C5 links missing on both sides still fail strict EP06 validation", () => {
  const runId = "run_c5_ep06";
  const fixture = c5Fixture(runId);
  const actuals = actualsFor(runId, fixture.manifest);
  const silent = withLinkEdits(fixture, "revision_1", (revision) => {
    deleteField(revision, "tasks", "T1", "requirementIds");
    deleteField(revision, "requirements", "REQ-MANDATORY", "contributingTaskIds");
  });
  const normalized = normalizePlanSubmission(silent, actuals);
  assertOk(normalized);
  const validation = validateExecutionPlanRevision(
    buildExecutionPlanRevision(normalized.revision as unknown as Omit<ExecutionPlanRevision, "digest">),
    fixture.manifest,
  );
  assert.equal(validation.valid, false);
});

// ---------------------------------------------------------------------------
// Tool boundary: every envelope mismatch refused on draft AND revise.
// ---------------------------------------------------------------------------

const ENVELOPE_WRONG: [string, Record<string, unknown>][] = [
  ["runId", { runId: "run_wrong" }],
  ["sourceManifestId", { sourceManifestId: "manifest_wrong" }],
  ["sourceManifestDigest", { sourceManifestDigest: "0".repeat(64) }],
  ["workflowPolicyVersion", { workflowPolicyVersion: 999 }],
  ["createdAt", { createdAt: "2020-01-01T00:00:00.000Z" }],
  ["coverageReviewId", { coverageReviewId: "coverage_wrong" }],
  ["repairBudgetLineageId", { repairBudgetLineageId: "lineage_wrong" }],
];

for (const [field, patch] of ENVELOPE_WRONG) {
  test(`C5 draft refuses a wrong supplied ${field}`, async () => {
    const runId = `run_c5_draft_${field}`;
    const fixture = c5Fixture(runId);
    const store = new MemorySchedulerStore();
    seedPolicySourceLedger(store, runId, fixture);
    const tools = createPlanningTools({ store, clock });
    const submission = { ...strippedSubmission(fixture, "revision_1"), ...patch } as unknown as PlanSubmissionRevision;
    const result = await invokePlanningTool(tools, "draft_planning_plan", { revision: submission }, runId);
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "envelope_mismatch");
    assert.equal(projectionOf(store, runId).planning!.plan, undefined);
  });

  test(`C5 revise refuses a wrong supplied ${field}`, async () => {
    const runId = `run_c5_revise_${field}`;
    const fixture = c5Fixture(runId);
    const store = new MemorySchedulerStore();
    seedPolicySourceLedger(store, runId, fixture);
    const tools = createPlanningTools({ store, clock });
    const drafted = await invokePlanningTool(
      tools,
      "draft_planning_plan",
      { revision: strippedSubmission(fixture, "revision_1") },
      runId,
    );
    assert.equal(drafted.isError, false);
    const plan = projectionOf(store, runId).planning!.plan!;
    const submission = { ...strippedSubmission(fixture, "revision_2"), ...patch } as unknown as PlanSubmissionRevision;
    const result = await invokePlanningTool(tools, "revise_planning_plan", {
      revision: submission,
      expectedRevisionId: plan.currentRevisionId,
      expectedDigest: plan.currentDigest,
    }, runId);
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "envelope_mismatch");
    assert.equal(projectionOf(store, runId).planning!.plan!.currentRevisionId, "revision_1");
  });
}

test("C5 draft and revise refuse a wrong requiredBase", async () => {
  const runId = "run_c5_base";
  const fixture = c5Fixture(runId);
  const store = new MemorySchedulerStore();
  seedPolicySourceLedger(store, runId, fixture);
  const tools = createPlanningTools({ store, clock });
  const bad = strippedSubmission(fixture, "revision_1");
  (bad.tasks[0] as unknown as Record<string, unknown>)["requiredBase"] = "accepted plan revision revision_2";
  const refused = await invokePlanningTool(tools, "draft_planning_plan", { revision: bad }, runId);
  assert.equal(refused.isError, true);
  assert.equal(refused.error?.code, "base_mismatch");
  const drafted = await invokePlanningTool(
    tools,
    "draft_planning_plan",
    { revision: strippedSubmission(fixture, "revision_1") },
    runId,
  );
  assert.equal(drafted.isError, false);
  const plan = projectionOf(store, runId).planning!.plan!;
  const staleBase = strippedSubmission(fixture, "revision_2");
  (staleBase.tasks[0] as unknown as Record<string, unknown>)["requiredBase"] = "accepted plan revision revision_1";
  const refusedRevise = await invokePlanningTool(tools, "revise_planning_plan", {
    revision: staleBase,
    expectedRevisionId: plan.currentRevisionId,
    expectedDigest: plan.currentDigest,
  }, runId);
  assert.equal(refusedRevise.isError, true);
  assert.equal(refusedRevise.error?.code, "base_mismatch");
});

test("C5 omitted envelope drafts and revises through the tools with kernel stamping", async () => {
  const runId = "run_c5_roundtrip";
  const fixture = c5Fixture(runId);
  const store = new MemorySchedulerStore();
  seedPolicySourceLedger(store, runId, fixture);
  const tools = createPlanningTools({ store, clock });
  const drafted = await invokePlanningTool(
    tools,
    "draft_planning_plan",
    { revision: strippedSubmission(fixture, "revision_1") },
    runId,
  );
  assert.equal(drafted.isError, false, JSON.stringify(drafted.error));
  const stored = projectionOf(store, runId).planning!.plan!.revisionsById["revision_1"]!;
  assert.equal(stored.runId, runId);
  assert.equal(stored.sourceManifestId, fixture.manifest.manifestId);
  assert.equal(stored.sourceManifestDigest, fixture.manifest.artifactDigest);
  assert.equal(stored.workflowPolicyVersion, 1);
  assert.equal(stored.createdAt, CLOCK);
  assert.equal("coverageReviewId" in stored, false);
  for (const task of stored.tasks) {
    assert.equal(task.requiredBase, "accepted plan revision revision_1");
  }
  // The stamped digest binds the stamped content and still validates.
  const { digest: _storedDigest, ...storedContent } = stored;
  void _storedDigest;
  assert.equal(stored.digest, computeExecutionPlanRevisionDigest(storedContent));
  assert.equal(validateExecutionPlanRevision(stored, fixture.manifest).valid, true);
  const revised = await invokePlanningTool(tools, "revise_planning_plan", {
    revision: strippedSubmission(fixture, "revision_2"),
    expectedRevisionId: "revision_1",
    expectedDigest: stored.digest,
  }, runId);
  assert.equal(revised.isError, false, JSON.stringify(revised.error));
  const after = projectionOf(store, runId).planning!.plan!;
  assert.equal(after.currentRevisionId, "revision_2");
  assert.deepEqual(after.revisionHistoryIds, ["revision_1", "revision_2"]);
  assert.equal(
    after.revisionsById["revision_2"]!.tasks.find((task) => task.id === "T1")!.requiredBase,
    "accepted plan revision revision_2",
  );
});

test("C5 revise clears prior coverage binding and preserves repair lineage for a fresh review", async () => {
  const runId = "run_c5_carry_tool";
  const fixture = c5Fixture(runId);
  const store = new MemorySchedulerStore();
  seedPolicySourceLedger(store, runId, fixture);
  // A recorded prior binding (e.g. a pre-C5 record) rides the stored revision.
  const { digest: _priorDigest, ...priorContent } = fixture.revision;
  void _priorDigest;
  const boundR1 = buildExecutionPlanRevision({
    ...priorContent,
    coverageReviewId: "coverage_legacy",
    repairBudgetLineageId: "lineage_legacy",
  });
  store.append({
    runId,
    type: "planning.plan_drafted",
    occurredAt: CLOCK,
    actor: { role: "architect", id: "architect_1" },
    idempotencyKey: "plan:revision-1",
    payload: { revision: boundR1, expectedRevisionId: null, expectedDigest: null },
  });
  const tools = createPlanningTools({ store, clock });
  const carried = await invokePlanningTool(tools, "revise_planning_plan", {
    revision: strippedSubmission(fixture, "revision_2"),
    expectedRevisionId: boundR1.revisionId,
    expectedDigest: boundR1.digest,
  }, runId);
  assert.equal(carried.isError, false, JSON.stringify(carried.error));
  const storedR2 = projectionOf(store, runId).planning!.plan!.revisionsById["revision_2"]!;
  assert.equal(storedR2.coverageReviewId, undefined);
  const freshReview = { ...buildFixtureCoverageReview(storedR2, fixture.manifest, { runId }), id: "coverage_fresh_revision_2" };
  const binding = validateCoverageReviewBinding(freshReview, storedR2, fixture.manifest);
  assert.equal(binding.valid, true, JSON.stringify(binding.issues));
  seedBoundCoverageAndReady(store, runId, {
    revision: storedR2, manifest: fixture.manifest, review: freshReview,
    hostCapabilities: fixture.hostCapabilities, occurredAt: CLOCK,
  });
  assert.equal(projectionOf(store, runId).planning!.readiness, "ready");
  assert.equal(projectionOf(store, runId).planning!.plan!.revisionsById[boundR1.revisionId]!.digest, boundR1.digest);
  assert.equal(storedR2.repairBudgetLineageId, "lineage_legacy");
  // Any supplied old review binding is refused for an unevaluated revision.
  const plan = projectionOf(store, runId).planning!.plan!;
  const rival = { ...strippedSubmission(fixture, "revision_3"), coverageReviewId: "coverage_legacy" } as unknown as PlanSubmissionRevision;
  const refused = await invokePlanningTool(tools, "revise_planning_plan", {
    revision: rival,
    expectedRevisionId: plan.currentRevisionId,
    expectedDigest: plan.currentDigest,
  }, runId);
  assert.equal(refused.isError, true);
  assert.equal(refused.error?.code, "envelope_mismatch");
});

test("C5 missing EP06 fields are still refused through the tools", async () => {
  const runId = "run_c5_ep06_tool";
  const fixture = c5Fixture(runId);
  const store = new MemorySchedulerStore();
  seedPolicySourceLedger(store, runId, fixture);
  const tools = createPlanningTools({ store, clock });
  const submission = strippedSubmission(fixture, "revision_1");
  const target = (submission as unknown as Record<string, unknown[]>)["tasks"] as Record<string, unknown>[];
  delete (target.find((task) => task["id"] === "T1")!["scope"] as Record<string, unknown>)["excludes"];
  const result = await invokePlanningTool(tools, "draft_planning_plan", { revision: submission }, runId);
  assert.equal(result.isError, true);
  assert.equal(result.error?.code, "invalid_plan_revision");
});

test("C5 stored historical revisions keep validating with their original digests", () => {
  const runId = "run_c5_history";
  const fixture = c5Fixture(runId);
  const store = new MemorySchedulerStore();
  seedPolicySourceLedger(store, runId, fixture);
  // A pre-C5 stored record bypasses the new boundary untouched.
  store.append({
    runId,
    type: "planning.plan_drafted",
    occurredAt: CLOCK,
    actor: { role: "architect", id: "architect_1" },
    idempotencyKey: "plan:revision-1",
    payload: { revision: fixture.revision, expectedRevisionId: null, expectedDigest: null },
  });
  const stored = projectionOf(store, runId).planning!.plan!.revisionsById["revision_1"]!;
  assert.equal(stored.digest, fixture.revision.digest);
  assert.equal(validateExecutionPlanRevision(stored, fixture.manifest).valid, true);
  // Replay derives the identical record: no restamping of history.
  const replayed = rebuildSchedulerProjection(store.readRun(runId)).planning!.plan!.revisionsById["revision_1"]!;
  assert.equal(replayed.digest, fixture.revision.digest);
  assert.deepEqual(replayed, stored);
});

// ---------------------------------------------------------------------------
// Contract reference: current, restart, stale, dropped, mismatched.
// ---------------------------------------------------------------------------

async function readyJourneyStore(runId: string, fixture: C5Fixture, store: SchedulerStore): Promise<void> {
  seedPolicySourceLedger(store, runId, fixture);
  const tools = createPlanningTools({ store, clock });
  const drafted = await invokePlanningTool(
    tools,
    "draft_planning_plan",
    { revision: strippedSubmission(fixture, "revision_1") },
    runId,
  );
  assert.equal(drafted.isError, false, JSON.stringify(drafted.error));
  const stored = projectionOf(store, runId).planning!.plan!.revisionsById["revision_1"]!;
  const review = { ...buildFixtureCoverageReview(stored, fixture.manifest, { runId }), id: "coverage_1" };
  seedBoundCoverageAndReady(store, runId, {
    revision: stored,
    manifest: fixture.manifest,
    review,
    hostCapabilities: fixture.hostCapabilities,
  });
  assert.equal(projectionOf(store, runId).planning!.readiness, "ready");
}

test("C5 task contract reference resolves current, stale, dropped and mismatched states", async () => {
  const runId = "run_c5_resolution";
  const fixture = c5Fixture(runId);
  const store = new MemorySchedulerStore();
  await readyJourneyStore(runId, fixture, store);
  const projection = projectionOf(store, runId);
  const ready = readyPlanIdentity(projection)!;
  assert.equal(ready.revisionId, "revision_1");
  const current = resolveTaskContractReference(projection, "T1");
  assert.equal(current.status, "current");
  if (current.status !== "current") throw new Error("unreachable");
  assert.equal(current.ref.revisionId, "revision_1");
  assert.equal(current.ref.digest, ready.digest);
  assert.equal(current.contract.id, "T1");
  const pinned = resolveTaskContractAtRef(projection, current.ref);
  assert.ok(pinned);
  assert.equal(pinned.contract.id, "T1");
  assert.equal(resolveTaskContractReference(projection, "no-such-task").status, "unmapped");
  // A new revision supersedes the ready one; a second review re-readies it.
  const tools = createPlanningTools({ store, clock });
  const revised = await invokePlanningTool(tools, "revise_planning_plan", {
    revision: strippedSubmission(fixture, "revision_2"),
    expectedRevisionId: ready.revisionId,
    expectedDigest: ready.digest,
  }, runId);
  assert.equal(revised.isError, false, JSON.stringify(revised.error));
  assert.equal(projectionOf(store, runId).planning!.readiness, "not_ready");
  const storedR2 = projectionOf(store, runId).planning!.plan!.revisionsById["revision_2"]!;
  seedBoundCoverageAndReady(store, runId, {
    revision: storedR2,
    manifest: fixture.manifest,
    review: { ...buildFixtureCoverageReview(storedR2, fixture.manifest, { runId }), id: "coverage_2" },
    hostCapabilities: fixture.hostCapabilities,
  });
  const now = projectionOf(store, runId);
  assert.equal(now.planning!.readiness, "ready");
  const currentR2 = resolveTaskContractReference(now, "T1");
  assert.equal(currentR2.status, "current");
  if (currentR2.status !== "current") throw new Error("unreachable");
  assert.equal(currentR2.ref.revisionId, "revision_2");
  // A task the rebind never refreshed still names the old ready identity.
  const staleProjection: SchedulerProjection = {
    ...now,
    tasks: {
      ...now.tasks,
      T1: { ...now.tasks["T1"]!, contractRef: current.ref },
    },
    readyPlanTaskBindings: { T1: { revisionId: current.ref.revisionId, digest: current.ref.digest, contractId: "T1" } },
  };
  const stale = resolveTaskContractReference(staleProjection, "T1");
  assert.equal(stale.status, "stale");
  if (stale.status !== "stale") throw new Error("unreachable");
  assert.equal(stale.currentRevisionId, "revision_2");
  // A contract that left the current revision is dropped, not invented.
  const droppedProjection: SchedulerProjection = {
    ...now,
    planning: {
      ...now.planning!,
      plan: {
        ...now.planning!.plan!,
        revisionsById: {
          ...now.planning!.plan!.revisionsById,
          revision_2: {
            ...now.planning!.plan!.revisionsById["revision_2"]!,
            tasks: now.planning!.plan!.revisionsById["revision_2"]!.tasks.filter(
              (task) => task.id !== "T1",
            ),
          },
        },
      },
    },
  };
  assert.equal(resolveTaskContractReference(droppedProjection, "T1").status, "dropped");
  // A contractRef that contradicts its ready-plan binding is refused.
  const mismatched: SchedulerProjection = {
    ...now,
    readyPlanTaskBindings: {
      ...now.readyPlanTaskBindings,
      T1: { revisionId: "revision_2", digest: "f".repeat(64), contractId: "T1" },
    },
  };
  assert.equal(resolveTaskContractReference(mismatched, "T1").status, "mismatched");
  // Legacy runs and runs with no ready plan carry no contracts.
  assert.equal(
    resolveTaskContractReference({ ...now, planningPolicyVersion: 0 } as unknown as SchedulerProjection, "T1").status,
    "legacy",
  );
  const bare = new MemorySchedulerStore();
  seedPolicySourceLedger(bare, "run_c5_bare", c5Fixture("run_c5_bare"));
  const bareProjection: SchedulerProjection = {
    ...projectionOf(bare, "run_c5_bare"),
    tasks: { T1: { id: "T1" } as never },
  };
  assert.equal(resolveTaskContractReference(bareProjection, "T1").status, "not_ready");
});

// ---------------------------------------------------------------------------
// Review inputs: the durable contract reference rides into the reviewer.
// ---------------------------------------------------------------------------

test("C5 review inputs carry the durable accepted contract and no placeholder", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-c5-inputs-"));
  const runId = "run_c5_inputs";
  const fixture = c5Fixture(runId);
  const store = new MemorySchedulerStore();
  try {
    await readyJourneyStore(runId, fixture, store);
    const projection = projectionOf(store, runId);
    const resolution = resolveTaskContractReference(projection, "T1");
    assert.equal(resolution.status, "current");
    if (resolution.status !== "current") throw new Error("unreachable");
    const artifacts = new ArtifactStore(join(root, "artifacts"));
    const diffHash = (await artifacts.put(Buffer.from("diff --git a/src/t1.ts b/src/t1.ts\n", "utf8"), "text/x-diff", "diff")).hash;
    const submission = {
      changeSet: {
        id: "changeset_1",
        baselineRevision: "b".repeat(40),
        taskRevision: "c".repeat(40),
        diffArtifactHash: diffHash,
        changedPaths: ["src/t1.ts"],
        unresolvedConcerns: [],
        criterionEvidenceLinks: [],
      },
      summary: "Worker summary for T1.",
      authorRuntimeId: "author-runtime",
    } as unknown as DurableSubmission;
    const task = { ...projection.tasks["T1"]!, changeSetId: "changeset_1", attempt: 0 };
    const inputs = await loadDeliverableReviewInputs({ task, submission, artifacts, contract: resolution.contract, contractRef: resolution.ref });
    assert.equal(inputs.contract, resolution.contract);
    assert.deepEqual(inputs.contractRef, resolution.ref);
    assert.ok(inputs.diffText.includes("src/t1.ts"));
    const legacy = await loadDeliverableReviewInputs({ task, submission, artifacts });
    assert.equal(legacy.contract, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Store-backed contexts: worker/reviewer section assembly over a real
// SQLite scheduler store (restart included) — assembly-level coverage,
// not the factory pump (see the actual factory journey below).
// ---------------------------------------------------------------------------


function workerInputFor(
  projection: SchedulerProjection,
  taskId: string,
): BuildWorkerContextInput {
  const resolution = resolveTaskContractReference(projection, taskId);
  assert.equal(resolution.status, "current");
  if (resolution.status !== "current") throw new Error("unreachable");
  return {
    limits: { ...NATIVE_WORKER_CONTEXT_LIMITS },
    task: projection.tasks[taskId]!,
    contract: resolution.contract,
    contractRef: resolution.ref,
    guidance: [],
    instructions: [],
    skills: [],
    memories: [],
    repositorySnapshot: `HEAD ${"a".repeat(40)}\n`,
    evidence: [],
    recentHistory: [],
  };
}

function assertCompactWorkerContract(text: string, contractId: string, revisionId: string, digest: string): void {
  for (const required of [
    `Authoritative plan contract ${contractId}`,
    `accepted revision ${revisionId} (digest ${digest})`,
    "required base accepted plan revision revision_1",
    "Outcome (user):",
    "Outcome (system):",
    "Scope includes:",
    "Scope excludes:",
    "Writable surfaces:",
    "Forbidden surfaces:",
    "Acceptance criteria:",
    "Definition of done:",
    "Targeted validation:",
    "Affected-scope validation:",
    "Negative proof:",
    "Cleanup:",
  ]) {
    assert.ok(text.includes(required), `worker contract carries ${required}`);
  }
}

test("C5 store-backed worker and reviewer contexts carry the current accepted contract within caps", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-c5-journey-"));
  const database = join(root, "scheduler.sqlite");
  const runId = "run_c5_journey";
  const fixture = c5Fixture(runId);
  const store = new SqliteSchedulerStore(database);
  let storeOpen = true;
  const closeStore = (): void => {
    if (storeOpen) {
      storeOpen = false;
      store.close();
    }
  };
  try {
    await readyJourneyStore(runId, fixture, store);
    const projection = projectionOf(store, runId);
    const ready = readyPlanIdentity(projection)!;
    // The worker's direct assembly path carries the authoritative block.
    const input = workerInputFor(projection, "T1");
    const pack = buildWorkerContext(input);
    console.log(`C5 worker contract pack: ${pack.byteLength} bytes, ~${pack.estimatedTokens} tokens (cap ${NATIVE_WORKER_CONTEXT_LIMITS.maxBytes} B / ${NATIVE_WORKER_CONTEXT_LIMITS.maxEstimatedTokens} tok)`);
    assertCompactWorkerContract(pack.text, "T1", ready.revisionId, ready.digest);
    const contractSection = pack.sections.find((section) => section.id === WORKER_CONTRACT_SECTION_ID);
    assert.ok(contractSection, "worker pack includes the task-contract section");
    const renderedContract = workerContextSections(input).find((section) => section.id === WORKER_CONTRACT_SECTION_ID);
    assert.ok(renderedContract, "worker sections render the task-contract block");
    assert.equal(renderedContract.content, buildWorkerContractBlock(input.contract!, input.contractRef));
    assert.ok(!pack.omissions.some((omission) => omission.id === WORKER_CONTRACT_SECTION_ID), "contract is never omitted");
    assert.ok(pack.byteLength <= NATIVE_WORKER_CONTEXT_LIMITS.maxBytes, `worker pack fits bytes (${pack.byteLength})`);
    assert.ok(
      pack.estimatedTokens <= NATIVE_WORKER_CONTEXT_LIMITS.maxEstimatedTokens,
      `worker pack fits tokens (${pack.estimatedTokens})`,
    );
    const workerManifest = toContextManifest({
      runId,
      sessionId: "worker:T1",
      actor: { role: "worker", id: "worker_1" },
      role: "worker",
      purpose: "worker:task",
      taskId: "T1",
      attempt: 0,
      limits: { ...NATIVE_WORKER_CONTEXT_LIMITS },
      pack,
      recordedAt: CLOCK,
    });
    assert.deepEqual(workerManifest.limits, NATIVE_WORKER_CONTEXT_LIMITS);
    assert.equal(workerManifest.packDigest, pack.digest);
    assert.equal(workerManifest.byteLength, pack.byteLength);
    assert.equal(workerManifest.estimatedTokens, pack.estimatedTokens);
    assert.ok(workerManifest.sections.some((section) => section.id === WORKER_CONTRACT_SECTION_ID));
    // The extension assembly path consumes the same sections, contract included.
    const shared = workerContextSections(input);
    assert.ok(shared.some((section) => section.id === WORKER_CONTRACT_SECTION_ID), "extension base includes the contract");
    // Restart: close and reopen the durable store; the current reference survives.
    closeStore();
    const reopened = new SqliteSchedulerStore(database);
    try {
      const afterRestart = resolveTaskContractReference(projectionOf(reopened, runId), "T1");
      assert.equal(afterRestart.status, "current");
      if (afterRestart.status !== "current") throw new Error("unreachable");
      assert.deepEqual(afterRestart.ref, input.contractRef);
      // The reviewer renders the same accepted contract on findings and
      // verdict passes only — never on the obligations pass.
      const reviewRuntime = new NativeDeliverableReviewRuntime({
        store: reopened,
        architectRuntimeId: "architect-runtime",
        router: { selectVerifier: () => { throw new Error("unused"); } } as never,
        candidates: [],
        models: new Map(),
        reviewerRuntimeIds: ["reviewer-runtime"],
        sessions: {} as never,
        artifacts: {} as never,
        evidenceStore: {} as never,
        loadInputs: async () => { throw new Error("unused"); },
        workspace: { create: async () => ({ path: root }), cleanup: async () => undefined },
        depth: { run: async () => { throw new Error("unused"); } },
      });
      const sectionsFor = (pass: "obligations" | "findings" | "verdict"): ContextSection[] =>
        (reviewRuntime as unknown as { sections(context: unknown, pass: string): ContextSection[] }).sections(
          {
            request: { runId },
            reviewId: "review_1",
            inputs: {
              taskId: "T1",
              attempt: 0,
              changeSetId: "changeset_1",
              baselineRevision: "b".repeat(40),
              taskRevision: "c".repeat(40),
              diffArtifactHash: "d".repeat(64),
              diffText: "diff --git a/src/t1.ts b/src/t1.ts",
              changedPaths: ["src/t1.ts"],
              objective: afterRestart.contract.outcome.user,
              criteria: afterRestart.contract.acceptance.criteria.map((criterion) => ({
                id: criterion.id,
                text: criterion.text,
              })),
              workerSummary: "Worker summary for T1.",
              unresolvedConcerns: [],
              claims: [],
              authorRuntimeId: "author-runtime",
              contract: afterRestart.contract,
              contractRef: afterRestart.ref,
            },
            candidate: {},
            model: {},
            independence: "distinct_model",
            tier: "low",
          },
          pass,
        );
      const obligations = sectionsFor("obligations");
      assert.ok(!obligations.some((section) => section.id === REVIEWER_CONTRACT_SECTION_ID), "obligations stays criteria-only");
      assert.ok(obligations.some((section) => section.id === "acceptance-criteria"), "obligations keeps the criteria");
      assert.ok(!obligations.some((section) => section.id === "submitted-diff"), "obligations precedes the diff");
      for (const pass of ["findings", "verdict"] as const) {
        const sections = sectionsFor(pass);
        const contract = sections.find((section) => section.id === REVIEWER_CONTRACT_SECTION_ID);
        assert.ok(contract, `${pass} carries the reviewer contract block`);
        assert.equal(contract.content, buildReviewerContractBlock(afterRestart.contract, afterRestart.ref));
        for (const required of [
          "Authoritative plan contract T1",
          `accepted revision ${ready.revisionId} (digest ${ready.digest})`,
          "Outcome (user):",
          "Scope includes:",
          "Scope excludes:",
          "Acceptance criteria:",
          "Definition of done:",
          "Review criteria:",
          "Integration checks:",
          "Negative proof:",
          "Targeted validation rationale:",
          "Affected-scope validation rationale:",
        ]) {
          assert.ok(contract.content.includes(required), `${pass} contract carries ${required}`);
        }
        const assembled = new ContextAssembler({ ...DELIVERABLE_REVIEW_CONTEXT_LIMITS }).assemble(sections);
        console.log(`C5 reviewer ${pass} pack: ${assembled.byteLength} bytes, ~${assembled.estimatedTokens} tokens (cap ${DELIVERABLE_REVIEW_CONTEXT_LIMITS.maxBytes} B / ${DELIVERABLE_REVIEW_CONTEXT_LIMITS.maxEstimatedTokens} tok)`);
        assert.ok(
          assembled.byteLength <= DELIVERABLE_REVIEW_CONTEXT_LIMITS.maxBytes,
          `${pass} fits bytes (${assembled.byteLength})`,
        );
        assert.ok(
          assembled.estimatedTokens <= DELIVERABLE_REVIEW_CONTEXT_LIMITS.maxEstimatedTokens,
          `${pass} fits tokens (${assembled.estimatedTokens})`,
        );
        const manifest = toContextManifest({
          runId,
          sessionId: `reviewer:T1:${pass}`,
          actor: { role: "worker", id: "reviewer-runtime" },
          role: "verifier",
          purpose: `verifier:${pass}`,
          taskId: "T1",
          limits: { ...DELIVERABLE_REVIEW_CONTEXT_LIMITS },
          pack: assembled,
          recordedAt: CLOCK,
        });
        assert.deepEqual(manifest.limits, DELIVERABLE_REVIEW_CONTEXT_LIMITS);
        assert.equal(manifest.packDigest, assembled.digest);
        assert.ok(manifest.sections.some((section) => section.id === REVIEWER_CONTRACT_SECTION_ID));
      }
      // Findings-before-claims: the worker's report rides the verdict pass only.
      const findingsIds = sectionsFor("findings").map((section) => section.id);
      assert.ok(!findingsIds.includes("worker-report"), "findings precede the worker report");
      assert.ok(!findingsIds.includes("worker-claims"), "findings precede worker claims");
      const verdictIds = sectionsFor("verdict").map((section) => section.id);
      assert.ok(verdictIds.includes("worker-report"), "verdict judges the worker report");
      assert.ok(verdictIds.includes("worker-claims"), "verdict judges worker claims");
    } finally {
      reopened.close();
      closeStore();
    }
  } finally {
    closeStore();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F5: an explicitly supplied ref.taskId that names no current contract
// fails closed — even when a repair parent would resolve. Parent identity
// derivation applies only when the bridge holds no explicit identity,
// and the returned ref then names the actual resolved contract.
// ---------------------------------------------------------------------------

test("C5 explicit ref identity fails closed; parent derivation names the resolved contract", async () => {
  const runId = "run_c5_explicit_ref";
  const fixture = c5Fixture(runId);
  const store = new MemorySchedulerStore();
  await readyJourneyStore(runId, fixture, store);
  const now = projectionOf(store, runId);
  const ready = readyPlanIdentity(now)!;
  const withRepair = (contractRef?: TaskContractRef): SchedulerProjection => ({
    ...now,
    tasks: {
      ...now.tasks,
      R1: {
        id: "R1",
        kind: "verification_repair",
        objective: "Repair T1.",
        dependencies: ["T1"],
        status: "planned",
        requiredCapabilities: [],
        attempt: 0,
        ...(contractRef ? { contractRef } : {}),
      },
    },
  });
  // Explicitly supplied but missing: dropped, never the parent's contract
  // under the wrong identity.
  const wrong = resolveTaskContractReference(
    withRepair({ revisionId: ready.revisionId, digest: ready.digest, taskId: "NOPE" }),
    "R1",
  );
  assert.equal(wrong.status, "dropped");
  if (wrong.status !== "dropped") throw new Error("unreachable");
  assert.equal(wrong.ref.taskId, "NOPE");
  // No explicit identity: the repair resolves through its parent, and the
  // returned ref names the actual resolved contract.
  const derived = resolveTaskContractReference(withRepair(), "R1");
  assert.equal(derived.status, "current");
  if (derived.status !== "current") throw new Error("unreachable");
  assert.equal(derived.ref.taskId, "T1");
  assert.equal(derived.contract.id, "T1");
  assert.equal(derived.ref.revisionId, ready.revisionId);
  assert.equal(derived.ref.digest, ready.digest);
  // A direct task with an explicit unknown ref fails closed as well.
  const direct = resolveTaskContractReference(
    {
      ...now,
      tasks: {
        ...now.tasks,
        T9: {
          id: "T9",
          objective: "Rogue.",
          dependencies: [],
          status: "planned",
          requiredCapabilities: [],
          attempt: 0,
          contractRef: { revisionId: ready.revisionId, digest: ready.digest, taskId: "NOPE" },
        },
      },
    },
    "T9",
  );
  assert.equal(direct.status, "dropped");
});

// ---------------------------------------------------------------------------
// F2: decision/disposition timestamps stamp from kernel actuals at the
// submission boundary only. Omitted stamps the matching durable time for
// a known identity, else the kernel submission time; a supplied value
// must match. History, replay and digests are untouched.
// ---------------------------------------------------------------------------

test("C5 omitted decision timestamps stamp the kernel submission time", () => {
  const runId = "run_c5_stamp_time";
  const fixture = c5Fixture(runId);
  const result = normalizePlanSubmission(
    strippedSubmission(fixture, "revision_1"),
    actualsFor(runId, fixture.manifest),
  );
  assertOk(result);
  const decisions = (result.revision as unknown as {
    planningDecisions: Array<{ id: string; decidedAt: string }>;
  }).planningDecisions;
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.id, "D3");
  assert.equal(decisions[0]!.decidedAt, CLOCK);
});

test("C5 supplied decision timestamps must match the kernel actual", () => {
  const runId = "run_c5_time_match";
  const fixture = c5Fixture(runId);
  const actuals = actualsFor(runId, fixture.manifest);
  const kept = strippedSubmission(fixture, "revision_1");
  (kept.planningDecisions[0] as unknown as Record<string, unknown>)["decidedAt"] = CLOCK;
  assert.equal(normalizePlanSubmission(kept, actuals).ok, true);
  const stale = strippedSubmission(fixture, "revision_1");
  (stale.planningDecisions[0] as unknown as Record<string, unknown>)["decidedAt"] = "2026-09-22T00:00:00.000Z";
  const refused = normalizePlanSubmission(stale, actuals);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.failure.code, "timestamp_mismatch");
});

test("C5 draft and revise stamp omitted decision times and refuse mismatches", async () => {
  const runId = "run_c5_tool_time";
  const fixture = c5Fixture(runId);
  const store = new MemorySchedulerStore();
  seedPolicySourceLedger(store, runId, fixture);
  const tools = createPlanningTools({ store, clock });
  const drafted = await invokePlanningTool(
    tools,
    "draft_planning_plan",
    { revision: strippedSubmission(fixture, "revision_1") },
    runId,
  );
  assert.equal(drafted.isError, false, JSON.stringify(drafted.error));
  const storedR1 = projectionOf(store, runId).planning!.plan!.revisionsById["revision_1"]!;
  assert.equal(storedR1.planningDecisions[0]!.decidedAt, CLOCK);
  // A new decision identity stamps the kernel submission time when omitted.
  const plan = projectionOf(store, runId).planning!.plan!;
  const next = strippedSubmission(fixture, "revision_2");
  (next.planningDecisions as unknown as Array<Record<string, unknown>>).push({
    id: "D9",
    description: "A new ledger call.",
  });
  const revised = await invokePlanningTool(tools, "revise_planning_plan", {
    revision: next,
    expectedRevisionId: plan.currentRevisionId,
    expectedDigest: plan.currentDigest,
  }, runId);
  assert.equal(revised.isError, false, JSON.stringify(revised.error));
  const storedR2 = projectionOf(store, runId).planning!.plan!.revisionsById["revision_2"]!;
  assert.equal(storedR2.planningDecisions.find((decision) => decision.id === "D3")!.decidedAt, CLOCK);
  assert.equal(storedR2.planningDecisions.find((decision) => decision.id === "D9")!.decidedAt, CLOCK);
  // A wrong supplied time for a carried identity is refused.
  const bad = strippedSubmission(fixture, "revision_3");
  (bad.planningDecisions[0] as unknown as Record<string, unknown>)["decidedAt"] = "2020-01-01T00:00:00.000Z";
  const refused = await invokePlanningTool(tools, "revise_planning_plan", {
    revision: bad,
    expectedRevisionId: "revision_2",
    expectedDigest: storedR2.digest,
  }, runId);
  assert.equal(refused.isError, true);
  assert.equal(refused.error?.code, "timestamp_mismatch");
});

// ---------------------------------------------------------------------------
// F3: the revise expected identity stamps the durable current revision
// when omitted; a supplied wrong/null/blank/malformed value is refused.
// The event payload carries the actual resolved identity, never undefined.
// ---------------------------------------------------------------------------

test("C5 revise stamps an omitted expected identity and keeps stale refusal", async () => {
  const runId = "run_c5_expected_stamp";
  const fixture = c5Fixture(runId);
  const store = new MemorySchedulerStore();
  seedPolicySourceLedger(store, runId, fixture);
  const tools = createPlanningTools({ store, clock });
  const drafted = await invokePlanningTool(
    tools,
    "draft_planning_plan",
    { revision: strippedSubmission(fixture, "revision_1") },
    runId,
  );
  assert.equal(drafted.isError, false, JSON.stringify(drafted.error));
  const storedR1 = projectionOf(store, runId).planning!.plan!.revisionsById["revision_1"]!;
  const revised = await invokePlanningTool(tools, "revise_planning_plan", {
    revision: strippedSubmission(fixture, "revision_2"),
  }, runId);
  assert.equal(revised.isError, false, JSON.stringify(revised.error));
  const after = projectionOf(store, runId).planning!.plan!;
  assert.equal(after.currentRevisionId, "revision_2");
  const revisedEvent = store.readRun(runId).find((event) => event.type === "planning.plan_revised")!;
  const payload = revisedEvent.payload as { expectedRevisionId: string; expectedDigest: string };
  assert.equal(payload.expectedRevisionId, "revision_1");
  assert.equal(payload.expectedDigest, storedR1.digest);
  // A supplied stale base is still refused.
  const stale = await invokePlanningTool(tools, "revise_planning_plan", {
    revision: strippedSubmission(fixture, "revision_3"),
    expectedRevisionId: "revision_1",
    expectedDigest: storedR1.digest,
  }, runId);
  assert.equal(stale.isError, true);
  assert.equal(stale.error?.code, "stale_plan_revision");
  assert.equal(projectionOf(store, runId).planning!.plan!.currentRevisionId, "revision_2");
});

test("C5 revise refuses null, blank and malformed expected identity without stamping", async () => {
  const runId = "run_c5_expected_bad";
  const fixture = c5Fixture(runId);
  const store = new MemorySchedulerStore();
  seedPolicySourceLedger(store, runId, fixture);
  const tools = createPlanningTools({ store, clock });
  const drafted = await invokePlanningTool(
    tools,
    "draft_planning_plan",
    { revision: strippedSubmission(fixture, "revision_1") },
    runId,
  );
  assert.equal(drafted.isError, false, JSON.stringify(drafted.error));
  const plan = projectionOf(store, runId).planning!.plan!;
  const tool = tools.find((candidate) => candidate.definition.name === "revise_planning_plan")!;
  const bad: Array<Record<string, unknown>> = [
    { expectedRevisionId: null, expectedDigest: plan.currentDigest },
    { expectedRevisionId: plan.currentRevisionId, expectedDigest: "" },
    { expectedRevisionId: "   ", expectedDigest: plan.currentDigest },
    { expectedRevisionId: 42, expectedDigest: plan.currentDigest },
  ];
  for (const patch of bad) {
    const validation = tool.validate({
      revision: strippedSubmission(fixture, "revision_9"),
      ...patch,
    });
    assert.equal(validation.ok, false, JSON.stringify(patch));
  }
  // Omitted entirely validates: the kernel stamps the durable current.
  assert.equal(tool.validate({ revision: strippedSubmission(fixture, "revision_9") }).ok, true);
  assert.equal(projectionOf(store, runId).planning!.plan!.currentRevisionId, "revision_1");
});

// ---------------------------------------------------------------------------
// F4: the reviewer resolves the CURRENT accepted contract before any
// loader or provider call. A superseded (non-ready) reference fails
// closed without invoking the loader; a loader-carried historical
// contract, a drifted scheduler criterion text, or a reference without
// substance is refused. An exact authority passes the gate with no
// provider call. The obligations pass stays criteria-only.
// ---------------------------------------------------------------------------

test("C5 reviewer resolves current authority before any loader or provider call", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-c5-review-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runId = "run_c5_review_gate";
  const fixture = c5Fixture(runId);
  const store = new MemorySchedulerStore();
  await readyJourneyStore(runId, fixture, store);
  // Drive T1 to a real submission through kernel events.
  store.append({
    runId,
    type: "task.transitioned",
    occurredAt: CLOCK,
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: "assign:T1",
    payload: { taskId: "T1", status: "assigned", patch: { assignedWorkerId: "worker_1" } },
  });
  store.append({
    runId,
    type: "task.transitioned",
    occurredAt: CLOCK,
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: "running:T1",
    payload: { taskId: "T1", status: "running" },
  });
  store.append({
    runId,
    type: "task.transitioned",
    occurredAt: CLOCK,
    actor: { role: "runner", id: "worker_1" },
    idempotencyKey: "submit:T1",
    payload: {
      taskId: "T1",
      status: "submitted",
      patch: {
        changeSetId: "changeset_1",
        criterionEvidenceLinks: [
          { criterionId: "c1", evidenceId: "e1", artifactHashes: ["ab".repeat(32)], attempt: 1 },
        ],
      },
    },
  });
  assert.equal(projectionOf(store, runId).tasks["T1"]!.status, "submitted");
  // W1 (F6): the review boundary verifies the exact immutable diff bytes
  // at their addressed artifact before identity lookup. Provision the
  // exact fixture bytes so the gate reaches the identity assertion.
  const DIFF_TEXT = "diff --git a/src/t1.ts b/src/t1.ts";
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const diffArtifactHash = (await artifacts.put(Buffer.from(DIFF_TEXT, "utf8"), "text/x-diff", "diff")).hash;
  const buildInputs = (projection: SchedulerProjection, mutate?: (inputs: DeliverableReviewInputs) => void): DeliverableReviewInputs => {
    const task = projection.tasks["T1"]!;
    const resolution = resolveTaskContractReference(projection, "T1");
    assert.equal(resolution.status, "current");
    if (resolution.status !== "current") throw new Error("unreachable");
    const inputs: DeliverableReviewInputs = {
      taskId: "T1",
      attempt: task.attempt,
      changeSetId: "changeset_1",
      baselineRevision: "b".repeat(40),
      taskRevision: "c".repeat(40),
      diffArtifactHash,
      diffText: DIFF_TEXT,
      changedPaths: ["src/t1.ts"],
      objective: resolution.contract.outcome.user,
      criteria: resolution.contract.acceptance.criteria.map((criterion) => ({ id: criterion.id, text: criterion.text })),
      workerSummary: "Worker summary for T1.",
      unresolvedConcerns: [],
      claims: [],
      authorRuntimeId: "author-runtime",
      contract: resolution.contract,
      contractRef: resolution.ref,
    };
    mutate?.(inputs);
    return inputs;
  };
  const reviewWith = (
    target: SchedulerStore,
    loadInputs: (input: { task: BuildTask; projection: SchedulerProjection }) => Promise<DeliverableReviewInputs>,
  ): { runtime: NativeDeliverableReviewRuntime; calls: { count: number } } => {
    const calls = { count: 0 };
    const runtime = new NativeDeliverableReviewRuntime({
      store: target,
      architectRuntimeId: "architect-runtime",
      router: { selectVerifier: () => { throw new Error("unused"); } } as never,
      candidates: [],
      models: new Map(),
      reviewerRuntimeIds: [],
      sessions: {} as never,
      artifacts,
      evidenceStore: {} as never,
      loadInputs: async (input) => {
        calls.count += 1;
        return loadInputs(input);
      },
      workspace: { create: async () => ({ path: "unused" }), cleanup: async () => undefined },
      depth: { run: async () => { throw new Error("unused"); } },
    });
    return { runtime, calls };
  };
  const reasonOf = (result: { status: string; reason?: string }): string => {
    assert.equal(result.status, "unavailable");
    return (result as { reason: string }).reason;
  };
  // Exact authority passes the gate with no provider: empty candidates
  // fail identity lookup only after authority checks.
  {
    const { runtime, calls } = reviewWith(store, async ({ projection }) => buildInputs(projection));
    const result = await runtime.review({ runId, taskId: "T1" });
    assert.equal(reasonOf(result), "delivery_identity_unavailable");
    assert.equal(calls.count, 1);
  }
  // Restart shape: the same durable events replayed into a fresh store
  // pass the gate identically.
  {
    const replayed = new MemorySchedulerStore();
    for (const event of store.readRun(runId)) {
      const { eventId: _eventId, sequence: _sequence, ...input } = event;
      void _eventId;
      void _sequence;
      replayed.append(input);
    }
    const { runtime, calls } = reviewWith(replayed, async ({ projection }) => buildInputs(projection));
    const result = await runtime.review({ runId, taskId: "T1" });
    assert.equal(reasonOf(result), "delivery_identity_unavailable");
    assert.equal(calls.count, 1);
  }
  // A loader-carried historical contract (stale digest) is refused.
  {
    const { runtime, calls } = reviewWith(store, async ({ projection }) => buildInputs(projection, (inputs) => {
      inputs.contractRef = { ...inputs.contractRef!, digest: "f".repeat(64) };
    }));
    const result = await runtime.review({ runId, taskId: "T1" });
    assert.equal(reasonOf(result), "delivery_inputs_unavailable");
    assert.equal(calls.count, 1);
  }
  // A same-ID changed scheduler criterion text is refused.
  {
    const { runtime } = reviewWith(store, async ({ projection }) => buildInputs(projection, (inputs) => {
      inputs.criteria = inputs.criteria.map((criterion) => ({ ...criterion, text: `${criterion.text} (edited)` }));
    }));
    const result = await runtime.review({ runId, taskId: "T1" });
    assert.equal(reasonOf(result), "delivery_inputs_unavailable");
  }
  // A matching reference with no loader contract is bound from durable authority.
  {
    const { runtime } = reviewWith(store, async ({ projection }) => buildInputs(projection, (inputs) => {
      delete (inputs as unknown as Record<string, unknown>)["contract"];
    }));
    const result = await runtime.review({ runId, taskId: "T1" });
    assert.equal(reasonOf(result), "delivery_identity_unavailable");
  }
  // Missing both optional copies cannot bypass semantic checks.
  for (const changed of [false, true]) {
    const { runtime } = reviewWith(store, async ({ projection }) => buildInputs(projection, (inputs) => {
      delete inputs.contract;
      delete inputs.contractRef;
      if (changed) inputs.criteria = inputs.criteria.map((criterion) => ({ ...criterion, text: `${criterion.text} (edited)` }));
    }));
    assert.equal(reasonOf(await runtime.review({ runId, taskId: "T1" })), changed ? "delivery_inputs_unavailable" : "delivery_identity_unavailable");
  }
  // A supplied contract-only copy is also checked, not silently replaced.
  {
    const { runtime } = reviewWith(store, async ({ projection }) => buildInputs(projection, (inputs) => {
      delete inputs.contractRef;
      inputs.contract = { ...inputs.contract!, outcome: { ...inputs.contract!.outcome, user: "forged" } };
    }));
    assert.equal(reasonOf(await runtime.review({ runId, taskId: "T1" })), "delivery_inputs_unavailable");
  }
  // A superseded plan (revised but not re-readied) fails closed before
  // the loader runs at all.
  {
    const tools = createPlanningTools({ store, clock });
    const plan = projectionOf(store, runId).planning!.plan!;
    const revised = await invokePlanningTool(tools, "revise_planning_plan", {
      revision: strippedSubmission(fixture, "revision_2"),
      expectedRevisionId: plan.currentRevisionId,
      expectedDigest: plan.currentDigest,
    }, runId);
    assert.equal(revised.isError, false, JSON.stringify(revised.error));
    assert.equal(projectionOf(store, runId).planning!.readiness, "not_ready");
    const { runtime, calls } = reviewWith(store, async ({ projection }) => buildInputs(projection));
    const result = await runtime.review({ runId, taskId: "T1" });
    assert.equal(result.status, "unavailable");
    if (result.status !== "unavailable") throw new Error("unreachable");
    assert.equal(result.reason, "delivery_contract_not_current");
    assert.equal(calls.count, 0);
  }
});

// ---------------------------------------------------------------------------
// F1 actual journey: NativeBuildFactory -> runtime.step() over real
// SQLite, scripting ONLY the AgentModel transport. The real worker
// writes, runs evidence and submits through real tools; the real
// reviewer receives the submitted diff and renders findings/verdict
// contexts from the current accepted contract.
// ---------------------------------------------------------------------------

function requestText(request: AgentModelRequest): string {
  return request.messages
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n");
}

function requestPass(request: AgentModelRequest): string {
  return request.messages.find((message) => message.role === "system")?.id ?? "";
}

test("C5 actual factory journey pins the current accepted contract in real worker and reviewer requests", async () => {
  const workerRequests: AgentModelRequest[] = [];
  const reviewerRequests: AgentModelRequest[] = [];
  const { projection, manifests } = await runDeliveryFactoryScenario(
    HIGH_CONTENT,
    { test: "node --test" },
    { observe: { workerRequests, reviewerRequests } },
  );
  const ready = readyPlanIdentity(projection)!;
  assert.equal(projection.planning!.plan!.currentRevisionId, "revision_value");
  const provenance = `accepted revision revision_value (digest ${ready.digest})`;
  // The real worker's requests carry the exact current contract block.
  assert.ok(workerRequests.length >= 1, "the real worker made model calls");
  const workerText = workerRequests.map(requestText).join("\n");
  for (const required of [
    "Authoritative plan contract T1",
    provenance,
    "required base accepted plan revision revision_value",
    "Create src/value.mjs exporting value = 2.",
    "- c1: src/value.mjs exports value = 2 and the tests pass.",
    "Outcome (system): The value module exports 2.",
    "Scope includes: src/value.mjs",
    "Scope excludes: test/value.test.mjs",
    "Inputs: accepted plan revision",
    "Outputs: src/value.mjs",
    "Writable surfaces: src/value.mjs",
    "Forbidden surfaces: test/value.test.mjs",
    "Steps:\n1. Write the module.\n2. Run the tests.",
    "Definition of done: Tests pass.",
    "Targeted validation: The value test.",
    "Affected-scope validation: The module only.",
    "Negative proof: not applicable — A new module has no prior-incorrect case.",
    "Cleanup: None. / Recovery: Retry. / Rollback: Revert.",
  ]) {
    assert.ok(workerText.includes(required), `real worker requests carry ${required}`);
  }
  assert.ok(!workerText.includes("(unpinned)"), "real worker requests are pinned");
  // The real reviewer's findings and verdict requests carry the same
  // authority; the obligations pass stays criteria-only and precedes diff.
  const byPass = new Map<string, string>();
  for (const request of reviewerRequests) {
    const pass = requestPass(request);
    byPass.set(pass, `${byPass.get(pass) ?? ""}\n${requestText(request)}`);
  }
  assert.ok(byPass.has("delivery-obligations-system"), "obligations pass ran");
  assert.ok(byPass.has("delivery-findings-system"), "findings pass ran");
  assert.ok(byPass.has("delivery-verdict-system"), "verdict pass ran");
  const obligations = byPass.get("delivery-obligations-system")!;
  assert.ok(!obligations.includes("Authoritative plan contract"), "obligations stays criteria-only");
  assert.ok(!obligations.includes("Unified diff"), "obligations precedes the diff");
  for (const pass of ["delivery-findings-system", "delivery-verdict-system"] as const) {
    const text = byPass.get(pass)!;
    for (const required of [
      "Authoritative plan contract T1", provenance,
      "- c1: src/value.mjs exports value = 2 and the tests pass.",
      "Scope includes: src/value.mjs", "Scope excludes: test/value.test.mjs",
      "Definition of done: Tests pass.",
      "Review criteria:\n- Independent review confirms the value.",
      "Integration checks:\n- Post-integration tests.",
      "Targeted validation rationale: The value test.",
      "Affected-scope validation rationale: The module only.",
      "Negative proof: not applicable — A new module has no prior-incorrect case.",
    ]) {
      assert.ok(text.includes(required), `real reviewer ${pass} carries ${required}`);
    }
    assert.ok(!text.includes("(unpinned)"), `real reviewer ${pass} is pinned`);
  }
  // Bind each persisted worker/reviewer manifest to the actual transport
  // request bytes, rather than trusting its own reported digest/counts.
  const actualMessages = [...workerRequests, ...reviewerRequests].flatMap((request) => request.messages);
  for (const manifest of manifests.filter((entry) => entry.purpose === "worker:task" || entry.purpose.startsWith("delivery:"))) {
    const message = actualMessages.find((entry) => entry.id === `context:${manifest.packDigest}`);
    assert.ok(message, `${manifest.purpose} durable pack reached the actual model transport`);
    assert.equal(typeof message.content, "string");
    const text = message.content as string;
    const bytes = Buffer.byteLength(text, "utf8");
    assert.equal(createHash("sha256").update(text, "utf8").digest("hex"), manifest.packDigest);
    assert.equal(bytes, manifest.byteLength);
    assert.equal(Math.ceil(bytes / 4), manifest.estimatedTokens);
    console.log(`C5 actual ${manifest.purpose}: ${bytes} B, ${manifest.estimatedTokens} estimated tokens, SHA256 ${manifest.packDigest}`);
  }
  // The durable context manifest store records the actual packs within caps.
  const workerManifests = manifests.filter((manifest) => manifest.purpose === "worker:task");
  assert.ok(workerManifests.length >= 1, "worker packs are recorded");
  for (const manifest of workerManifests) {
    assert.deepEqual(manifest.limits, NATIVE_WORKER_CONTEXT_LIMITS);
    assert.match(manifest.packDigest, /^[a-f0-9]{64}$/);
    assert.ok(manifest.byteLength > 0 && manifest.byteLength <= manifest.limits.maxBytes);
    assert.ok(manifest.estimatedTokens > 0 && manifest.estimatedTokens <= manifest.limits.maxEstimatedTokens);
    assert.ok(manifest.sections.some((section) => section.id === "task-contract"), "recorded worker pack includes the contract");
    assert.ok(!manifest.omissions.some((omission) => omission.id === "task-contract"), "recorded worker pack never omits the contract");
  }
  for (const purpose of ["delivery:findings", "delivery:verdict"] as const) {
    const recorded = manifests.filter((manifest) => manifest.purpose === purpose);
    assert.ok(recorded.length >= 1, `${purpose} pack is recorded`);
    for (const manifest of recorded) {
      assert.deepEqual(manifest.limits, DELIVERABLE_REVIEW_CONTEXT_LIMITS);
      assert.ok(manifest.byteLength <= manifest.limits.maxBytes);
      assert.ok(manifest.estimatedTokens <= manifest.limits.maxEstimatedTokens);
      assert.ok(manifest.sections.some((section) => section.id === "task-contract"), `recorded ${purpose} pack includes the contract`);
    }
  }
  const recordedObligations = manifests.filter((manifest) => manifest.purpose === "delivery:obligations");
  assert.ok(recordedObligations.length >= 1, "obligations pack is recorded");
  for (const manifest of recordedObligations) {
    assert.ok(!manifest.sections.some((section) => section.id === "task-contract"), "recorded obligations stay criteria-only");
  }
  console.log(`C5 actual journey: ${workerRequests.length} worker + ${reviewerRequests.length} reviewer requests, ${manifests.length} manifests, first worker pack ${workerManifests[0]!.byteLength} B`);
});

test("C5 required contract facts fail closed instead of truncating under caps", async () => {
  const runId = "run_c5_overflow";
  const fixture = c5Fixture(runId);
  const store = new MemorySchedulerStore();
  await readyJourneyStore(runId, fixture, store);
  const input = workerInputFor(projectionOf(store, runId), "T1");
  try {
    buildWorkerContext({ ...input, limits: { maxBytes: 64, maxEstimatedTokens: 16 } });
    assert.fail("expected a protected overflow, not a truncated contract");
  } catch (error) {
    assert.ok(error instanceof ProtectedContextOverflowError, `expected ProtectedContextOverflowError, got ${error}`);
    assert.ok(error.requiredSectionIds.includes("task-contract"), "the contract block is protected");
  }
});

test("C5 nested applicability decision times reuse only matching durable authorization and basis", () => {
  const runId = "run_c5_nested_time";
  const fixture = c5Fixture(runId);
  const actuals = { ...actualsFor(runId, fixture.manifest), ledgerRequirements: fixture.requirements };
  const source = fixture.requirements.find((requirement) => requirement.applicability.disposition)!;
  assert.ok(source);
  const submit = () => strippedSubmission(fixture, "revision_1");
  const disposition = (revision: PlanSubmissionRevision) => revision.requirements.find((requirement) => requirement.id === source.id)!.applicability.disposition!;
  const omitted = normalizePlanSubmission(submit(), actuals);
  assertOk(omitted);
  assert.equal(omitted.revision.requirements.find((requirement) => requirement.id === source.id)!.applicability.disposition!.decidedAt, source.applicability.disposition!.decidedAt);
  for (const time of ["wrong", "", null, 42]) {
    const revision = submit();
    (disposition(revision) as unknown as Record<string, unknown>)["decidedAt"] = time;
    const result = normalizePlanSubmission(revision, actuals);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.code, "timestamp_mismatch");
  }
  const changed = submit();
  (disposition(changed) as unknown as Record<string, unknown>)["rationale"] += " Newly decided basis.";
  const fresh = normalizePlanSubmission(changed, actuals);
  assertOk(fresh);
  assert.equal(fresh.revision.requirements.find((requirement) => requirement.id === source.id)!.applicability.disposition!.decidedAt, CLOCK);
  (disposition(changed) as unknown as Record<string, unknown>)["decidedAt"] = source.applicability.disposition!.decidedAt;
  assert.equal(normalizePlanSubmission(changed, actuals).ok, false, "a changed decision cannot backdate itself");
  const noApproval = submit();
  delete (disposition(noApproval) as unknown as Record<string, unknown>)["authorizedBy"];
  const normalized = normalizePlanSubmission(noApproval, actuals);
  assertOk(normalized);
  assert.equal(validateExecutionPlanRevision(buildExecutionPlanRevision(normalized.revision), fixture.manifest).valid, false);
});

test("C5 same decision id with changed semantics takes a new time and preserves history", () => {
  const runId = "run_c5_changed_decision";
  const fixture = c5Fixture(runId);
  const before = JSON.stringify(fixture.revision);
  const actuals = { ...actualsFor(runId, fixture.manifest), priorRevision: fixture.revision };
  const omitted = normalizePlanSubmission(strippedSubmission(fixture, "revision_2"), actuals);
  assertOk(omitted);
  assert.equal(omitted.revision.planningDecisions[0]!.decidedAt, fixture.revision.planningDecisions[0]!.decidedAt);
  const changed = strippedSubmission(fixture, "revision_2");
  (changed.planningDecisions[0] as unknown as Record<string, unknown>)["description"] += " New decision.";
  const fresh = normalizePlanSubmission(changed, actuals);
  assertOk(fresh);
  assert.equal(fresh.revision.planningDecisions[0]!.decidedAt, CLOCK);
  (changed.planningDecisions[0] as unknown as Record<string, unknown>)["decidedAt"] = fixture.revision.planningDecisions[0]!.decidedAt;
  assert.equal(normalizePlanSubmission(changed, actuals).ok, false);
  assert.equal(JSON.stringify(fixture.revision), before);
});

test("C5 worker refuses conflicting scheduler semantic copies before context/provider admission", async () => {
  const runId = "run_c5_worker_semantics";
  const fixture = c5Fixture(runId);
  const store = new MemorySchedulerStore();
  await readyJourneyStore(runId, fixture, store);
  const projection = projectionOf(store, runId);
  assert.ok(resolveWorkerTaskContract(projection, "T1"));
  for (const field of ["objective", "criteria"] as const) {
    const changed = structuredClone(projection);
    const task = changed.tasks["T1"]!;
    if (field === "objective") task.objective += " stale copy";
    else task.acceptanceCriteria = task.acceptanceCriteria!.map((criterion) => ({ ...criterion, text: `${criterion.text} stale copy` }));
    assert.throws(() => resolveWorkerTaskContract(changed, "T1"), (error: unknown) => error instanceof WorkerContractUnavailableError && error.resolution === "scheduler_contract_mismatch");
  }
});
