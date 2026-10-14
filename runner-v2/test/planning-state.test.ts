import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  coverageReviewHoldsReadiness,
  buildExecutionPlanRevision,
  validateRepairApproachDecision,
  assertClaimReassignable,
  type AssignmentClaim,
  type RepairApproachDecision,
} from "../src/planning-contracts.js";
import {
  derivePlanningOwnershipView,
  PLANNING_EVENT_ACTOR_ROLES,
  PLANNING_EVENT_TRANSITIONS,
  reducePlanningProjection,
  type PlanningActorRole,
  type PlanningEventType,
} from "../src/planning-projection.js";
import {
  rebuildSchedulerProjection,
  reduceSchedulerEvent,
  type NewSchedulerEvent,
  type SchedulerActorRole,
  type SchedulerEvent,
  type SchedulerProjection,
  type SchedulerStore,
} from "../src/scheduler-store.js";
import { manifestResolvesAmendmentRef, buildSourceManifest, type ApprovedSourceManifest } from "../src/source-manifest.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import {
  buildFixtureCoverageReview,
  buildPlanningFixtureScenario,
  type PlanningFixtureScenario,
} from "./fixtures/planning-source-fixture.js";

const RUN_ID = "run_fixture";
const EVIDENCE_DIGEST = "1".repeat(64);

class MemorySchedulerStore implements SchedulerStore {
  readonly events: SchedulerEvent[] = [];
  private projection: SchedulerProjection | undefined;

  append(input: NewSchedulerEvent): SchedulerEvent {
    const existing = this.events.find((event) => event.runId === input.runId && event.idempotencyKey === input.idempotencyKey);
    if (existing) return existing;
    const event: SchedulerEvent = {
      ...input,
      eventId: `memory_${this.events.length + 1}`,
      sequence: this.events.filter((candidate) => candidate.runId === input.runId).length + 1,
    };
    this.projection = reduceSchedulerEvent(this.projection, event);
    this.events.push(event);
    return event;
  }

  readRun(runId: string): SchedulerEvent[] {
    return this.events.filter((event) => event.runId === runId);
  }

  close(): void {}
}

function event(
  type: PlanningEventType | "run.policy_configured" | "planning.policy_configured" | "plan.created" | "request.triaged",
  idempotencyKey: string,
  actor: { role: PlanningActorRole | SchedulerActorRole; id: string },
  payload: Record<string, unknown>,
): NewSchedulerEvent {
  return {
    runId: RUN_ID,
    type,
    occurredAt: "2026-09-24T00:00:00.000Z",
    actor,
    idempotencyKey,
    payload,
  };
}

function fixtureWithScopedAmendment(): PlanningFixtureScenario & { manifest: ApprovedSourceManifest } {
  const fixture = buildPlanningFixtureScenario();
  const amendment = fixture.manifest.amendment!;
  const manifest = {
    ...fixture.manifest,
    amendment: {
      ...amendment,
      recordedImpact: {
        addsSectionIds: ["s8"],
        retiresSectionIds: ["s7"],
        addsRequirementIds: [],
        retiresRequirementIds: ["REQ-RETIRED"],
      },
    },
  };
  return { ...fixture, manifest };
}

function rebuildRevision(
  fixture: PlanningFixtureScenario,
  overrides: Partial<PlanningFixtureScenario["revision"]>,
) {
  const { digest: _digest, ...withoutDigest } = fixture.revision;
  return buildExecutionPlanRevision({ ...withoutDigest, ...overrides });
}

function planningInputs(fixture: PlanningFixtureScenario & { manifest: ApprovedSourceManifest }): NewSchedulerEvent[] {
  return [
    event("run.policy_configured", "policy", { role: "runner", id: "runner" }, { runPolicy: "finish" }),
    event("planning.policy_configured", "planning-policy:1", { role: "runner", id: "runner" }, { version: 1 }),
    event("planning.source_registered", "source:base", { role: "user", id: "owner" }, { manifest: fixture.priorManifest }),
    event("planning.source_amended", "source:amend-1", { role: "user", id: "owner" }, { manifest: fixture.manifest }),
    // T9: the Architect's first action — triage to build precedes all plan progress.
    event("request.triaged", "triage:build", { role: "architect", id: "architect" }, {
      decision: "build",
      rationale: "Seed triage: the fixture request changes the project.",
    }),
    event("planning.ledger_persisted", "ledger:1", { role: "architect", id: "architect" }, {
      id: "ledger-1",
      requirements: fixture.requirements,
      phases: fixture.phases,
      nonNormativeSections: [],
    }),
    // T3b (N2): durable full verified reads precede any coverage claim and readiness.
    ...fixture.manifest.sections.map((section) =>
      event("planning.source_section_read", `read:${section.id}`, { role: "architect", id: "architect" }, {
        manifestId: fixture.manifest.manifestId,
        manifestDigest: fixture.manifest.artifactDigest,
        sectionId: section.id,
        sectionDigest: section.digest,
        readAt: "2026-09-24T00:00:30.000Z",
      }),
    ),
    event("planning.checkpoint_recorded", "checkpoint:1", { role: "architect", id: "architect" }, {
      checkpoint: {
        id: "checkpoint-1",
        coveredSourceSectionIds: ["s1"],
        completedPlanningContractIds: ["requirement-ledger"],
        remainingWork: ["Cover source section s2"],
        nextAction: "Cover source section s2.",
        recordedAt: "2026-09-24T00:01:00.000Z",
      },
    }),
    event("planning.plan_drafted", "plan:revision-1", { role: "architect", id: "architect" }, {
      revision: fixture.revision,
      expectedRevisionId: null,
      expectedDigest: null,
    }),
    // T3b: request → obligations (record-before-verdict) precede the verdict.
    event("planning.coverage_review_requested", "coverage-request:1", { role: "architect", id: "architect" }, {
      reviewId: fixture.coverageReview.id,
      planRevisionId: fixture.revision.revisionId,
      planRevisionDigest: fixture.revision.digest,
      sourceManifestId: fixture.manifest.manifestId,
      requestedAt: "2026-09-24T00:02:00.000Z",
    }),
    event("planning.coverage_obligations_recorded", "coverage-obligations:1", { role: "verifier", id: "reviewer" }, {
      reviewId: fixture.coverageReview.id,
      sourceManifestId: fixture.manifest.manifestId,
      sourceManifestDigest: fixture.manifest.artifactDigest,
      obligations: structuredClone(fixture.coverageReview.derivedObligations),
      sectionCoverage: fixture.manifest.sections.map((section) => ({
        sectionId: section.id,
        obligationIds: fixture.coverageReview.derivedObligations.map((obligation) => obligation.id),
      })),
      recordedAt: "2026-09-24T00:05:00.000Z",
    }),
    event("planning.coverage_plan_delivered", "coverage-plan-delivered:1", { role: "runner", id: "runner" }, {
      reviewId: fixture.coverageReview.id,
      planRevisionId: fixture.revision.revisionId,
      planRevisionDigest: fixture.revision.digest,
      sourceManifestId: fixture.manifest.manifestId,
      deliveredAt: "2026-09-24T00:06:00.000Z",
    }),
    event("planning.coverage_review_recorded", "coverage:1", { role: "verifier", id: "reviewer" }, {
      review: fixture.coverageReview,
    }),
    event("planning.plan_ready", "ready:1", { role: "runner", id: "runner" }, {
      hostCapabilities: fixture.hostCapabilities,
    }),
  ];
}

function claim(packetId = "T1", id = "assignment-1", workerOrSessionId = "worker-T1"): AssignmentClaim {
  return {
    id,
    packetId,
    laneId: "BP1",
    workerOrSessionId,
    acceptedBaseRevision: "a".repeat(40),
    branchOrWorktree: `worktrees/${packetId}`,
    writableSurfaces: [`runner-v2/src/${packetId.toLowerCase()}.ts`],
    forbiddenSurfaces: ["runner-v2/src/scheduler-store.ts"],
    ownershipGeneration: 1,
    state: "claimed",
  };
}

function validationIntent(id = "validation-1") {
  return {
    id,
    acceptanceConditionIds: ["REQ-MANDATORY-ac1"],
    intendedBehavior: "The requirement ledger preserves every obligation.",
    assertions: ["The ledger remains source-traceable."],
    scope: "targeted",
    scopeReason: "Exact planning-state behavior under test.",
  };
}

function validationObservation(
  id = "observation-1",
  intentId = "validation-1",
  evidenceId = "evidence-1",
  outcome: "passed" | "failed" | "unknown" = "passed",
) {
  return {
    id,
    intentId,
    evidenceId,
    command: "node --test targeted",
    method: "command",
    snapshotRevision: "b".repeat(40),
    dirty: false,
    exitCode: outcome === "passed" ? 0 : 1,
    environmentFingerprint: "environment-1",
    configFingerprint: "config-1",
    dependencyFingerprint: "dependencies-1",
    outcome,
    counts: outcome === "passed"
      ? { selected: 1, passed: 1, failed: 0, skipped: 0 }
      : { selected: 1, passed: 0, failed: 1, skipped: 0 },
  };
}

function recovery(
  workspaceExists = true,
  assignmentId = "assignment-1",
  packetId = "T1",
  evidenceId = "evidence-1",
) {
  return {
    assignments: [{
      assignmentId,
      workspaceExists,
      branchOrWorktree: `worktrees/${packetId}`,
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40),
    }],
    evidence: [{ id: evidenceId, digest: EVIDENCE_DIGEST }],
  };
}

function acceptedTask(
  taskId = "T1",
  observationId = "observation-1",
  integrationCheckId = "integration-1",
) {
  return {
    taskId,
    requiredChecks: [{ kind: "validation", refId: observationId, outcome: "passed" }],
    reviewId: "coverage_1",
    integrationCheckIds: [integrationCheckId],
    status: "accepted",
    acceptedAt: "2026-09-24T00:10:00.000Z",
  };
}

function appendAll(store: SchedulerStore, inputs: readonly NewSchedulerEvent[]): void {
  for (const input of inputs) store.append(input);
}

function seedReady(store: SchedulerStore): PlanningFixtureScenario & { manifest: ApprovedSourceManifest } {
  const fixture = fixtureWithScopedAmendment();
  appendAll(store, planningInputs(fixture));
  return fixture;
}

function currentPlanBinding(store: SchedulerStore) {
  const plan = rebuildSchedulerProjection(store.readRun(RUN_ID)).planning!.plan!;
  return {
    expectedRevisionId: plan.currentRevisionId,
    expectedDigest: plan.currentDigest,
  };
}

function recordIntegrationReference(store: SchedulerStore, id = "integration-1"): void {
  store.append(event(
    "planning.reference_recorded",
    `reference:${id}`,
    { role: "runner", id: "runner" },
    { references: { [id]: { kind: "integration", id } } },
  ));
}

function recordValidation(
  store: SchedulerStore,
  taskId: string,
  intentId: string,
  observationId: string,
  outcome: "passed" | "failed" | "unknown",
  evidenceId: string,
  digest: string,
  workerOrSessionId = `worker-${taskId}`,
): void {
  store.append(event(
    "planning.validation_intent_recorded",
    `validation:intent:${intentId}`,
    { role: "architect", id: "architect" },
    { taskId, intent: validationIntent(intentId), ...currentPlanBinding(store) },
  ));
  store.append(event(
    "planning.validation_observed",
    `validation:observed:${observationId}`,
    { role: "worker", id: workerOrSessionId },
    {
      taskId,
      intentId,
      observation: validationObservation(observationId, intentId, evidenceId, outcome),
      evidenceIdentity: { evidenceId, digest },
      ...currentPlanBinding(store),
    },
  ));
}

function recordObservation(
  store: SchedulerStore,
  taskId: string,
  intentId: string,
  observationId: string,
  outcome: "passed" | "failed" | "unknown",
  evidenceId: string,
  digest: string,
  workerOrSessionId = `worker-${taskId}`,
): void {
  store.append(event(
    "planning.validation_observed",
    `validation:observed:${observationId}`,
    { role: "worker", id: workerOrSessionId },
    {
      taskId,
      intentId,
      observation: validationObservation(observationId, intentId, evidenceId, outcome),
      evidenceIdentity: { evidenceId, digest },
      ...currentPlanBinding(store),
    },
  ));
}

function prepareAcceptedTask(
  store: SchedulerStore,
  taskId: string,
  index: number,
  recordAcceptance = true,
  outcome: "passed" | "failed" | "unknown" = "passed",
): { assignmentId: string; observationId: string; integrationCheckId: string } {
  const assignmentId = `assignment-${index}`;
  const workerOrSessionId = `worker-${taskId}`;
  const validationId = `validation-${index}`;
  const observationId = `observation-${index}`;
  const evidenceId = `evidence-${index}`;
  const integrationCheckId = `integration-${index}`;
  store.append(event(
    "planning.assignment_claimed",
    `assignment:${taskId}`,
    { role: "runner", id: "runner" },
    { claim: claim(taskId, assignmentId, workerOrSessionId) },
  ));
  store.append(event(
    "planning.validation_intent_recorded",
    `validation:intent:${taskId}`,
    { role: "architect", id: "architect" },
    { taskId, intent: validationIntent(validationId), ...currentPlanBinding(store) },
  ));
  store.append(event(
    "planning.validation_observed",
    `validation:observed:${taskId}`,
    { role: "worker", id: workerOrSessionId },
    {
      taskId,
      intentId: validationId,
      observation: validationObservation(observationId, validationId, evidenceId, outcome),
      evidenceIdentity: { evidenceId, digest: EVIDENCE_DIGEST },
      ...currentPlanBinding(store),
    },
  ));
  store.append(event(
    "planning.recovery_reconciled",
    `recovery:${taskId}`,
    { role: "runner", id: "runner" },
    {
      assignmentId,
      recovery: (() => {
        const planning = rebuildSchedulerProjection(store.readRun(RUN_ID)).planning!;
        return {
          assignments: Object.values(planning.assignments)
            .filter((state) => state.status === "claimed")
            .map((state) => ({
              assignmentId: state.claim.id,
              workspaceExists: true,
              branchOrWorktree: state.claim.branchOrWorktree,
              baseRevision: state.claim.acceptedBaseRevision,
              headRevision: "b".repeat(40),
            })),
          evidence: Object.values(planning.references)
            .filter((reference) => reference.kind === "evidence")
            .map((reference) => ({ id: reference.id, digest: reference.digest! })),
        };
      })(),
    },
  ));
  store.append(event(
    "planning.reference_recorded",
    `reference:integration:${taskId}`,
    { role: "runner", id: "runner" },
    {
      references: {
        [integrationCheckId]: { kind: "integration", id: integrationCheckId },
      },
    },
  ));
  if (recordAcceptance) {
    store.append(event(
      "planning.acceptance_recorded",
      `acceptance:${taskId}`,
      { role: "runner", id: "runner" },
      {
        kind: "task",
        taskId,
        acceptance: acceptedTask(taskId, observationId, integrationCheckId),
        ...currentPlanBinding(store),
      },
    ));
  }
  return { assignmentId, observationId, integrationCheckId };
}

function planningStateAfter(inputs: readonly NewSchedulerEvent[]): ReturnType<typeof rebuildSchedulerProjection>["planning"] {
  const store = new MemorySchedulerStore();
  try {
    appendAll(store, inputs);
    return rebuildSchedulerProjection(store.readRun(RUN_ID)).planning;
  } finally {
    store.close();
  }
}

test("T2 R-1: amendment recorded impact rejects out-of-scope section and requirement retirements", () => {
  const fixture = fixtureWithScopedAmendment();
  const wrongRequirementImpact = {
    ...fixture.manifest,
    amendment: {
      ...fixture.manifest.amendment!,
      recordedImpact: {
        addsSectionIds: ["s8"],
        retiresSectionIds: ["s5"],
        addsRequirementIds: [],
        retiresRequirementIds: ["REQ-SECURITY"],
      },
    },
  };
  const wrongRequirementInputs = planningInputs({ ...fixture, manifest: wrongRequirementImpact });
  assert.throws(
    () => planningStateAfter(wrongRequirementInputs.slice(0, 6)),
    /does not (cover|retire)/,
  );

  const wrongSectionRevision = rebuildRevision(fixture, {
    revisionId: "revision-wrong-section",
    nonNormativeSections: [{
      sectionId: "s5",
      rationale: "Incorrectly retire security.",
      authorizedBy: "owner",
      amendmentRef: "amend-1",
      decidedAt: "2026-09-24T00:00:00.000Z",
    }],
    createdAt: "2026-09-24T00:02:00.000Z",
  });
  const state = planningStateAfter(planningInputs(fixture).slice(0, 6));
  assert.throws(
    () => reducePlanningProjection(state, event(
      "planning.plan_drafted",
      "plan:wrong-section",
      { role: "architect", id: "architect" },
      { revision: wrongSectionRevision },
    ) as never),
    /does not retire source section s5/,
  );
});

test("T2 B1: plan draft cannot drop a ledger requirement without retirement history", () => {
  const fixture = fixtureWithScopedAmendment();
  const requirements = fixture.revision.requirements
    .filter((requirement) => requirement.id !== "REQ-COMPAT")
    .map((requirement) => requirement.id === "REQ-MANDATORY"
      ? {
          ...requirement,
          reference: { ...requirement.reference, sectionIds: ["s1", "s3"] },
          contributingTaskIds: ["T1", "T2"],
        }
      : requirement);
  const phases = fixture.revision.phases.map((phase) => ({
    ...phase,
    requirementIds: phase.requirementIds.filter((id) => id !== "REQ-COMPAT"),
  }));
  const tasks = fixture.revision.tasks.map((task) => task.id === "T2"
    ? {
        ...task,
        requirementIds: ["REQ-MANDATORY"],
        requirementCriteriaMap: [{ taskLocalCriterionId: "c1", requirementId: "REQ-MANDATORY" }],
      }
    : task);
  const { digest: _digest, ...withoutDigest } = fixture.revision;
  const dropped = buildExecutionPlanRevision({
    ...withoutDigest,
    requirements,
    phases,
    tasks,
  });
  const state = planningStateAfter(planningInputs(fixture).slice(0, 6));
  assert.throws(
    () => reducePlanningProjection(state, event(
      "planning.plan_drafted",
      "plan:drop-ledger-requirement",
      { role: "architect", id: "architect" },
      { revision: dropped },
    ) as never),
    /drops ledger requirement REQ-COMPAT/,
  );
});

test("T2 I7: ledger persistence enforces amendment retirement scope", () => {
  const fixture = fixtureWithScopedAmendment();
  const requirements = fixture.requirements.map((requirement) => requirement.id === "REQ-SECURITY"
    ? {
        ...requirement,
        obligationKind: "mandatory" as const,
        contributingTaskIds: [],
        acceptanceConditions: [],
        applicability: {
          status: "not_applicable" as const,
          disposition: {
            authorizedBy: "owner",
            rationale: "Incorrectly cite the section 7 amendment.",
            amendmentRef: "amend-1",
            decidedAt: "2026-09-24T00:00:00.000Z",
          },
        },
      }
    : requirement);
  const inputs = planningInputs(fixture);
  inputs[5] = event("planning.ledger_persisted", "ledger:out-of-scope", { role: "architect", id: "architect" }, {
    id: "ledger-1",
    requirements,
    phases: fixture.phases,
    nonNormativeSections: [],
  });
  assert.throws(
    () => planningStateAfter(inputs.slice(0, 6)),
    /Amendment amend-1 does not retire requirement REQ-SECURITY/,
  );
});

test("T2 I6: legacy runs refuse planning events and cannot be upgraded by direct append", () => {
  const fixture = fixtureWithScopedAmendment();
  const store = new MemorySchedulerStore();
  try {
    store.append(event("run.policy_configured", "legacy-policy", { role: "runner", id: "runner" }, { runPolicy: "plan_only" }));
    store.append(event("plan.created", "legacy-plan", { role: "architect", id: "architect" }, { revision: 1, tasks: [] }));
    assert.throws(
      () => store.append(event("planning.policy_configured", "planning-policy:mid-run", { role: "runner", id: "runner" }, { version: 1 })),
      /only be configured during run creation/,
    );
    assert.throws(
      () => store.append(event("planning.source_registered", "legacy-source", { role: "user", id: "owner" }, { manifest: fixture.priorManifest })),
      /require a durable planning policy stamp/,
    );
    assert.equal(rebuildSchedulerProjection(store.readRun(RUN_ID)).planning, undefined);
    assert.equal(rebuildSchedulerProjection(store.readRun(RUN_ID)).planningPolicyVersion, undefined);
  } finally {
    store.close();
  }
});

test("T2 I5: only the claim owner or runner may record a validation observation", () => {
  const fixture = fixtureWithScopedAmendment();
  const store = new MemorySchedulerStore();
  try {
    appendAll(store, planningInputs(fixture));
    store.append(event("planning.assignment_claimed", "assignment:1", { role: "runner", id: "runner" }, { claim: claim() }));
    store.append(event("planning.validation_intent_recorded", "validation:intent", { role: "architect", id: "architect" }, {
      taskId: "T1",
      intent: validationIntent(),
      ...currentPlanBinding(store),
    }));
    assert.throws(
      () => store.append(event("planning.validation_observed", "validation:foreign-worker", { role: "worker", id: "some-other-worker" }, {
        taskId: "T1",
        intentId: "validation-1",
        observation: validationObservation(),
        evidenceIdentity: { evidenceId: "evidence-1", digest: EVIDENCE_DIGEST },
        ...currentPlanBinding(store),
      })),
      /Only the claim owner or runner/,
    );
  } finally {
    store.close();
  }
});

test("T2 N4: workers cannot write integration references through validation observations", () => {
  const fixture = fixtureWithScopedAmendment();
  const store = new MemorySchedulerStore();
  try {
    appendAll(store, planningInputs(fixture));
    store.append(event("planning.assignment_claimed", "assignment:1", { role: "runner", id: "runner" }, { claim: claim() }));
    store.append(event("planning.validation_intent_recorded", "validation:intent", { role: "architect", id: "architect" }, {
      taskId: "T1",
      intent: validationIntent(),
      ...currentPlanBinding(store),
    }));
    assert.throws(
      () => store.append(event("planning.validation_observed", "validation:worker-reference", { role: "worker", id: "worker-T1" }, {
        taskId: "T1",
        intentId: "validation-1",
        observation: validationObservation(),
        evidenceIdentity: { evidenceId: "evidence-1", digest: EVIDENCE_DIGEST },
        references: {
          "integration-worker": { kind: "integration", id: "integration-worker" },
        },
        ...currentPlanBinding(store),
      })),
      /Only planning.reference_recorded may write planning references/,
    );
  } finally {
    store.close();
  }
});

test("T2 N5: evidence ids are write-once and identical digests are idempotent", () => {
  const fixture = fixtureWithScopedAmendment();
  const store = new MemorySchedulerStore();
  try {
    appendAll(store, planningInputs(fixture));
    store.append(event("planning.assignment_claimed", "assignment:1", { role: "runner", id: "runner" }, { claim: claim() }));
    recordValidation(store, "T1", "validation-1", "observation-1", "passed", "evidence-1", "1".repeat(64));
    assert.throws(
      () => recordValidation(store, "T1", "validation-2", "observation-2", "passed", "evidence-1", "9".repeat(64)),
      /already exists with a different identity/,
    );
    recordValidation(store, "T1", "validation-3", "observation-3", "passed", "evidence-1", "1".repeat(64));
    assert.deepEqual(
      rebuildSchedulerProjection(store.readRun(RUN_ID)).planning!.references["evidence-1"],
      { kind: "evidence", id: "evidence-1", digest: "1".repeat(64) },
    );
  } finally {
    store.close();
  }
});

test("T2 N1: latest current GREEN supersedes RED history", () => {
  const fixture = fixtureWithScopedAmendment();

  const redThenGreen = new MemorySchedulerStore();
  try {
    appendAll(redThenGreen, planningInputs(fixture));
    redThenGreen.append(event("planning.assignment_claimed", "assignment:1", { role: "runner", id: "runner" }, { claim: claim() }));
    recordIntegrationReference(redThenGreen, "integration-1");
    recordValidation(redThenGreen, "T1", "validation-red", "observation-red", "failed", "evidence-red", "2".repeat(64));
    recordValidation(redThenGreen, "T1", "validation-green", "observation-green", "passed", "evidence-green", "1".repeat(64));
    redThenGreen.append(event("planning.recovery_reconciled", "recovery:red-green", { role: "runner", id: "runner" }, {
      assignmentId: "assignment-1",
      recovery: {
        ...recovery(true),
        evidence: [
          { id: "evidence-red", digest: "2".repeat(64) },
          { id: "evidence-green", digest: "1".repeat(64) },
        ],
      },
    }));
    assert.doesNotThrow(() => redThenGreen.append(event(
      "planning.acceptance_recorded",
      "acceptance:red-green",
      { role: "runner", id: "runner" },
      {
        kind: "task",
        taskId: "T1",
        acceptance: acceptedTask("T1", "observation-green", "integration-1"),
        ...currentPlanBinding(redThenGreen),
      },
    )));
    assert.equal(rebuildSchedulerProjection(redThenGreen.readRun(RUN_ID)).planning!.acceptances["task:T1"].status, "accepted");
  } finally {
    redThenGreen.close();
  }

  const greenThenRed = new MemorySchedulerStore();
  try {
    appendAll(greenThenRed, planningInputs(fixture));
    greenThenRed.append(event("planning.assignment_claimed", "assignment:1", { role: "runner", id: "runner" }, { claim: claim() }));
    recordIntegrationReference(greenThenRed, "integration-1");
    recordValidation(greenThenRed, "T1", "validation-green", "observation-green", "passed", "evidence-green", "1".repeat(64));
    recordValidation(greenThenRed, "T1", "validation-red", "observation-red", "failed", "evidence-red", "2".repeat(64));
    greenThenRed.append(event("planning.recovery_reconciled", "recovery:green-red", { role: "runner", id: "runner" }, {
      assignmentId: "assignment-1",
      recovery: {
        ...recovery(true),
        evidence: [
          { id: "evidence-green", digest: "1".repeat(64) },
          { id: "evidence-red", digest: "2".repeat(64) },
        ],
      },
    }));
    assert.throws(
      () => greenThenRed.append(event("planning.acceptance_recorded", "acceptance:green-red", { role: "runner", id: "runner" }, {
        kind: "task",
        taskId: "T1",
        acceptance: acceptedTask("T1", "observation-green", "integration-1"),
        ...currentPlanBinding(greenThenRed),
      })),
      /Current failed validation for check/,
    );
  } finally {
    greenThenRed.close();
  }

  const oldRedCurrentGreen = new MemorySchedulerStore();
  try {
    appendAll(oldRedCurrentGreen, planningInputs(fixture));
    oldRedCurrentGreen.append(event("planning.assignment_claimed", "assignment:1", { role: "runner", id: "runner" }, { claim: claim() }));
    recordIntegrationReference(oldRedCurrentGreen, "integration-1");
    recordValidation(oldRedCurrentGreen, "T1", "validation-old-red", "observation-old-red", "failed", "evidence-old-red", "2".repeat(64));
    const revisionTwo = rebuildRevision(fixture, {
      revisionId: "revision_2",
      createdAt: "2026-09-24T00:07:00.000Z",
    });
    oldRedCurrentGreen.append(event("planning.plan_revised", "plan:revision-2", { role: "architect", id: "architect" }, {
      revision: revisionTwo,
      ...currentPlanBinding(oldRedCurrentGreen),
    }));
    // T3b: the revision-2 verdict needs its own request → obligations chain;
    // reusing the revision-1 review id would cite a stale request.
    const reviewTwo = {
      ...buildFixtureCoverageReview(revisionTwo, fixture.manifest),
      id: "coverage_2",
    };
    oldRedCurrentGreen.append(event("planning.coverage_review_requested", "coverage-request:revision-2", { role: "architect", id: "architect" }, {
      reviewId: reviewTwo.id,
      planRevisionId: revisionTwo.revisionId,
      planRevisionDigest: revisionTwo.digest,
      sourceManifestId: fixture.manifest.manifestId,
      requestedAt: "2026-09-24T00:08:00.000Z",
    }));
    oldRedCurrentGreen.append(event("planning.coverage_obligations_recorded", "coverage-obligations:revision-2", { role: "verifier", id: "reviewer" }, {
      reviewId: reviewTwo.id,
      sourceManifestId: fixture.manifest.manifestId,
      sourceManifestDigest: fixture.manifest.artifactDigest,
      obligations: structuredClone(reviewTwo.derivedObligations),
      sectionCoverage: fixture.manifest.sections.map((section) => ({
        sectionId: section.id,
        obligationIds: reviewTwo.derivedObligations.map((obligation) => obligation.id),
      })),
      recordedAt: "2026-09-24T00:08:30.000Z",
    }));
    oldRedCurrentGreen.append(event("planning.coverage_plan_delivered", "coverage-plan-delivered:revision-2", { role: "runner", id: "runner" }, {
      reviewId: reviewTwo.id,
      planRevisionId: revisionTwo.revisionId,
      planRevisionDigest: revisionTwo.digest,
      sourceManifestId: fixture.manifest.manifestId,
      deliveredAt: "2026-09-24T00:08:40.000Z",
    }));
    oldRedCurrentGreen.append(event("planning.coverage_review_recorded", "coverage:revision-2", { role: "verifier", id: "reviewer" }, {
      review: reviewTwo,
    }));
    oldRedCurrentGreen.append(event("planning.plan_ready", "ready:revision-2", { role: "runner", id: "runner" }, {
      hostCapabilities: fixture.hostCapabilities,
    }));
    recordValidation(oldRedCurrentGreen, "T1", "validation-current-green", "observation-current-green", "passed", "evidence-current-green", "1".repeat(64));
    oldRedCurrentGreen.append(event("planning.recovery_reconciled", "recovery:old-red-current-green", { role: "runner", id: "runner" }, {
      assignmentId: "assignment-1",
      recovery: {
        ...recovery(true),
        evidence: [
          { id: "evidence-old-red", digest: "2".repeat(64) },
          { id: "evidence-current-green", digest: "1".repeat(64) },
        ],
      },
    }));
    oldRedCurrentGreen.append(event("planning.acceptance_recorded", "acceptance:old-red-current-green", { role: "runner", id: "runner" }, {
      kind: "task",
      taskId: "T1",
      acceptance: { ...acceptedTask("T1", "observation-current-green", "integration-1"), reviewId: "coverage_2" },
      ...currentPlanBinding(oldRedCurrentGreen),
    }));
    assert.equal(rebuildSchedulerProjection(oldRedCurrentGreen.readRun(RUN_ID)).planning!.acceptances["task:T1"].status, "accepted");
  } finally {
    oldRedCurrentGreen.close();
  }
});

test("T2 R3-B1: interleaved intents use observation append order and refuse newer RED", () => {
  const fixture = fixtureWithScopedAmendment();
  const store = new MemorySchedulerStore();
  try {
    appendAll(store, planningInputs(fixture));
    store.append(event("planning.assignment_claimed", "assignment:1", { role: "runner", id: "runner" }, { claim: claim() }));
    recordIntegrationReference(store, "integration-1");
    store.append(event("planning.validation_intent_recorded", "validation:intent:A", { role: "architect", id: "architect" }, {
      taskId: "T1",
      intent: validationIntent("validation-a"),
      ...currentPlanBinding(store),
    }));
    store.append(event("planning.validation_intent_recorded", "validation:intent:B", { role: "architect", id: "architect" }, {
      taskId: "T1",
      intent: validationIntent("validation-b"),
      ...currentPlanBinding(store),
    }));
    recordObservation(store, "T1", "validation-b", "observation-b-green", "passed", "evidence-b-green", "1".repeat(64));
    recordObservation(store, "T1", "validation-a", "observation-a-red", "failed", "evidence-a-red", "2".repeat(64));
    store.append(event("planning.recovery_reconciled", "recovery:interleaved", { role: "runner", id: "runner" }, {
      assignmentId: "assignment-1",
      recovery: {
        ...recovery(true),
        evidence: [
          { id: "evidence-b-green", digest: "1".repeat(64) },
          { id: "evidence-a-red", digest: "2".repeat(64) },
        ],
      },
    }));
    assert.throws(
      () => store.append(event("planning.acceptance_recorded", "acceptance:interleaved", { role: "runner", id: "runner" }, {
        kind: "task",
        taskId: "T1",
        acceptance: acceptedTask("T1", "observation-b-green", "integration-1"),
        ...currentPlanBinding(store),
      })),
      /not the latest passed observation|Current failed validation/,
    );
  } finally {
    store.close();
  }
});

test("T2 R3-I1: current failed validation on an uncited check blocks acceptance", () => {
  const fixture = fixtureWithScopedAmendment();
  const store = new MemorySchedulerStore();
  try {
    appendAll(store, planningInputs(fixture));
    store.append(event("planning.assignment_claimed", "assignment:1", { role: "runner", id: "runner" }, { claim: claim() }));
    recordIntegrationReference(store, "integration-1");
    store.append(event("planning.validation_intent_recorded", "validation:intent:x", { role: "architect", id: "architect" }, {
      taskId: "T1",
      intent: validationIntent("validation-x"),
      ...currentPlanBinding(store),
    }));
    recordObservation(store, "T1", "validation-x", "observation-x-green", "passed", "evidence-x-green", "1".repeat(64));
    store.append(event("planning.validation_intent_recorded", "validation:intent:y", { role: "architect", id: "architect" }, {
      taskId: "T1",
      intent: {
        ...validationIntent("validation-y"),
        acceptanceConditionIds: ["REQ-MANDATORY-ac1", "REQ-OTHER"],
      },
      ...currentPlanBinding(store),
    }));
    recordObservation(store, "T1", "validation-y", "observation-y-red", "failed", "evidence-y-red", "2".repeat(64));
    store.append(event("planning.recovery_reconciled", "recovery:uncited-red", { role: "runner", id: "runner" }, {
      assignmentId: "assignment-1",
      recovery: {
        ...recovery(true),
        evidence: [
          { id: "evidence-x-green", digest: "1".repeat(64) },
          { id: "evidence-y-red", digest: "2".repeat(64) },
        ],
      },
    }));
    assert.throws(
      () => store.append(event("planning.acceptance_recorded", "acceptance:uncited-red", { role: "runner", id: "runner" }, {
        kind: "task",
        taskId: "T1",
        acceptance: acceptedTask("T1", "observation-x-green", "integration-1"),
        ...currentPlanBinding(store),
      })),
      /Current failed validation for check/,
    );
  } finally {
    store.close();
  }
});

test("T2 R3-M1: reopened acceptance requires an observation recorded after reopen", () => {
  const fixture = fixtureWithScopedAmendment();
  const store = new MemorySchedulerStore();
  try {
    appendAll(store, planningInputs(fixture));
    prepareAcceptedTask(store, "T1", 1);
    store.append(event("planning.acceptance_reopened", "acceptance:reopen-freshness", { role: "architect", id: "architect" }, {
      kind: "task",
      taskId: "T1",
      ...currentPlanBinding(store),
    }));
    assert.throws(
      () => store.append(event("planning.acceptance_recorded", "acceptance:old-evidence", { role: "runner", id: "runner" }, {
        kind: "task",
        taskId: "T1",
        acceptance: acceptedTask("T1", "observation-1", "integration-1"),
        ...currentPlanBinding(store),
      })),
      /recorded after the reopen/,
    );
    recordValidation(store, "T1", "validation-fresh", "observation-fresh", "passed", "evidence-fresh", "3".repeat(64));
    store.append(event("planning.recovery_reconciled", "recovery:fresh", { role: "runner", id: "runner" }, {
      assignmentId: "assignment-1",
      recovery: {
        ...recovery(true),
        evidence: [
          { id: "evidence-1", digest: EVIDENCE_DIGEST },
          { id: "evidence-fresh", digest: "3".repeat(64) },
        ],
      },
    }));
    store.append(event("planning.acceptance_recorded", "acceptance:fresh", { role: "runner", id: "runner" }, {
      kind: "task",
      taskId: "T1",
      acceptance: acceptedTask("T1", "observation-fresh", "integration-1"),
      ...currentPlanBinding(store),
    }));
    assert.equal(rebuildSchedulerProjection(store.readRun(RUN_ID)).planning!.acceptances["task:T1"].status, "accepted");
  } finally {
    store.close();
  }
});

test("T2 R3-M2: reference recording requires a plan and a non-empty payload", () => {
  const fixture = fixtureWithScopedAmendment();
  const noPlan = new MemorySchedulerStore();
  try {
    appendAll(noPlan, planningInputs(fixture).slice(0, 5));
    assert.throws(
      () => noPlan.append(event("planning.reference_recorded", "reference:before-plan", { role: "runner", id: "runner" }, {
        references: { "integration-early": { kind: "integration", id: "integration-early" } },
      })),
      /require a drafted plan/,
    );
  } finally {
    noPlan.close();
  }

  const empty = new MemorySchedulerStore();
  try {
    appendAll(empty, planningInputs(fixture));
    assert.throws(
      () => empty.append(event("planning.reference_recorded", "reference:empty", { role: "runner", id: "runner" }, {})),
      /requires at least one reference/,
    );
  } finally {
    empty.close();
  }
});

test("T2 N2: reopened acceptance can be accepted again with new evidence", () => {
  const fixture = fixtureWithScopedAmendment();
  const store = new MemorySchedulerStore();
  try {
    appendAll(store, planningInputs(fixture));
    store.append(event("planning.assignment_claimed", "assignment:1", { role: "runner", id: "runner" }, { claim: claim() }));
    recordIntegrationReference(store, "integration-1");
    recordValidation(store, "T1", "validation-1", "observation-1", "passed", "evidence-1", "1".repeat(64));
    store.append(event("planning.recovery_reconciled", "recovery:first", { role: "runner", id: "runner" }, {
      assignmentId: "assignment-1",
      recovery: recovery(true),
    }));
    store.append(event("planning.acceptance_recorded", "acceptance:first", { role: "runner", id: "runner" }, {
      kind: "task",
      taskId: "T1",
      acceptance: acceptedTask("T1", "observation-1", "integration-1"),
      ...currentPlanBinding(store),
    }));
    store.append(event("planning.acceptance_reopened", "acceptance:reopen", { role: "architect", id: "architect" }, {
      kind: "task",
      taskId: "T1",
      ...currentPlanBinding(store),
    }));
    recordValidation(store, "T1", "validation-2", "observation-2", "passed", "evidence-2", "2".repeat(64));
    store.append(event("planning.recovery_reconciled", "recovery:second", { role: "runner", id: "runner" }, {
      assignmentId: "assignment-1",
      recovery: {
        ...recovery(true),
        evidence: [
          { id: "evidence-1", digest: "1".repeat(64) },
          { id: "evidence-2", digest: "2".repeat(64) },
        ],
      },
    }));
    assert.doesNotThrow(() => store.append(event(
      "planning.acceptance_recorded",
      "acceptance:second",
      { role: "runner", id: "runner" },
      {
        kind: "task",
        taskId: "T1",
        acceptance: acceptedTask("T1", "observation-2", "integration-1"),
        ...currentPlanBinding(store),
      },
    )));
    const acceptance = rebuildSchedulerProjection(store.readRun(RUN_ID)).planning!.acceptances["task:T1"];
    assert.equal(acceptance.status, "accepted");
    assert.equal(acceptance.history?.length, 2);
  } finally {
    store.close();
  }
});

test("T2 N3: acceptance cannot create its integration reference in the same append", () => {
  const fixture = fixtureWithScopedAmendment();
  const store = new MemorySchedulerStore();
  try {
    appendAll(store, planningInputs(fixture));
    prepareAcceptedTask(store, "T1", 1, false);
    const integrationReference = store.readRun(RUN_ID).some((record) => record.idempotencyKey === "reference:integration:T1");
    assert.equal(integrationReference, true);
    const neverRanStore = new MemorySchedulerStore();
    try {
      appendAll(neverRanStore, planningInputs(fixture));
      prepareAcceptedTask(neverRanStore, "T1", 1, false);
      assert.throws(
        () => neverRanStore.append(event("planning.acceptance_recorded", "acceptance:never-ran", { role: "architect", id: "architect" }, {
          kind: "task",
          taskId: "T1",
          acceptance: acceptedTask("T1", "observation-1", "never-ran"),
          references: { "never-ran": { kind: "integration", id: "never-ran" } },
          ...currentPlanBinding(neverRanStore),
        })),
        /Only planning.reference_recorded may write planning references/,
      );
    } finally {
      neverRanStore.close();
    }
  } finally {
    store.close();
  }
});

test("T2 M4 remainder: checkpoint after plan_ready requires a new readiness transition", () => {
  const fixture = fixtureWithScopedAmendment();
  const store = new MemorySchedulerStore();
  try {
    appendAll(store, planningInputs(fixture));
    assert.throws(
      () => store.append(event("planning.checkpoint_recorded", "checkpoint:after-ready", { role: "architect", id: "architect" }, {
        checkpoint: {
          id: "checkpoint-after-ready",
          coveredSourceSectionIds: ["s1"],
          completedPlanningContractIds: ["requirement-ledger"],
          remainingWork: [],
          nextAction: "Continue.",
          recordedAt: "2026-09-24T00:08:00.000Z",
        },
      })),
      /cannot be recorded after plan_ready/,
    );
  } finally {
    store.close();
  }
});

test("T2 R-2: amendment references resolve across the complete amendment chain", () => {
  const fixture = fixtureWithScopedAmendment();
  const first = fixture.manifest.amendment!;
  const second = buildSourceManifest(Buffer.from("second amendment", "utf8"), [{ id: "s1", startByte: 0, endByte: 16 }], {
    manifestId: "manifest_amend_2",
    sourceId: fixture.manifest.sourceId,
    mediaType: "text/plain",
    encoding: "utf-8",
    authority: "owner",
    createdAt: "2026-09-24T00:00:00.000Z",
    amendment: {
      id: "amend-2",
      priorManifestId: fixture.manifest.manifestId,
      priorArtifactDigest: fixture.manifest.artifactDigest,
      authorizedBy: "owner",
      rationale: "Add a later amendment.",
      recordedImpact: {
        addsSectionIds: ["s1"],
        retiresSectionIds: [],
        addsRequirementIds: ["REQ-LATER"],
        retiresRequirementIds: [],
      },
    },
  });
  assert.equal(manifestResolvesAmendmentRef(second, "amend-1", [first, second.amendment!]), true);
  assert.equal(manifestResolvesAmendmentRef(second, "amend-2", [first, second.amendment!]), true);
  assert.equal(manifestResolvesAmendmentRef(second, "amend-missing", [first, second.amendment!]), false);
});

test("T2 R-4: readiness predicates fail closed and repair arrays reject null", () => {
  assert.equal(coverageReviewHoldsReadiness(null), true);
  assert.equal(coverageReviewHoldsReadiness(undefined), true);
  const prior: AssignmentClaim = { ...claim(), state: "stopped_fenced", writerStopEvidence: "writer stopped" };
  assert.throws(
    () => assertClaimReassignable(null as unknown as AssignmentClaim, prior),
    /valid prior and next AssignmentClaim/,
  );
  const malformed = {
    id: "repair-1",
    issueId: "issue-1",
    taskLineageIds: ["T1"],
    priorFailedApproachIds: null,
    priorEvidenceIds: null,
    proposedApproachId: "approach-2",
    decision: "new_approach",
    rationale: "Try a distinct approach.",
    newDiagnosticEvidenceIds: null,
    decidedAt: "2026-09-24T00:00:00.000Z",
  } as unknown as RepairApproachDecision;
  const validation = validateRepairApproachDecision(malformed);
  assert.equal(validation.valid, false);
  assert.deepEqual(validation.issues.map((issue) => issue.code).sort(), [
    "invalid_new_diagnostic_evidence",
    "invalid_prior_evidence",
    "invalid_prior_failed_approaches",
  ]);
});

test("T2 planning event authority tables cover every event and derive requirement and phase ownership", () => {
  const fixture = fixtureWithScopedAmendment();
  const store = new MemorySchedulerStore();
  try {
    appendAll(store, planningInputs(fixture));
    const projection = rebuildSchedulerProjection(store.readRun(RUN_ID)).planning!;
    const ownership = derivePlanningOwnershipView(projection);
    assert.equal(ownership.requirementOwners["REQ-SECURITY"], "BP1");
    assert.deepEqual(ownership.phaseOwners.BP1, ["REQ-MANDATORY", "REQ-COMPAT", "REQ-SECURITY", "REQ-RETIRED"]);
    for (const type of Object.keys(PLANNING_EVENT_ACTOR_ROLES) as PlanningEventType[]) {
      assert.equal(PLANNING_EVENT_ACTOR_ROLES[type].length > 0, true, type);
      assert.equal(typeof PLANNING_EVENT_TRANSITIONS[type], "string", type);
    }
  } finally {
    store.close();
  }
});

test("T2 duplicate events and SQLite WAL reopen preserve ids counts status and memory parity", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-planning-wal-"));
  const database = join(root, "scheduler.sqlite");
  const memory = new MemorySchedulerStore();
  let sqlite: SqliteSchedulerStore | undefined;
  try {
    const inputs = planningInputs(fixtureWithScopedAmendment());
    appendAll(memory, inputs);
    sqlite = new SqliteSchedulerStore(database);
    appendAll(sqlite, inputs);
    const first = sqlite.readRun(RUN_ID)[1];
    const duplicate = sqlite.append(inputs[1]);
    assert.equal(duplicate.eventId, first.eventId);
    assert.equal(sqlite.readRun(RUN_ID).length, inputs.length);
    sqlite.close();
    sqlite = new SqliteSchedulerStore(database);
    const reopenedEvents = sqlite.readRun(RUN_ID);
    const memoryProjection = rebuildSchedulerProjection(memory.readRun(RUN_ID));
    const reopenedProjection = rebuildSchedulerProjection(reopenedEvents);
    assert.equal(reopenedEvents.length, inputs.length);
    assert.equal(reopenedProjection.planning?.readiness, "ready");
    assert.deepEqual(reopenedProjection, memoryProjection);
  } finally {
    sqlite?.close();
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T2 guard: worker cannot self-accept planning work", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-planning-self-accept-"));
  let store: SqliteSchedulerStore | undefined;
  try {
    store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
    seedReady(store);
    prepareAcceptedTask(store, "T1", 1, false);
    assert.throws(
      () => store!.append(event("planning.acceptance_recorded", "acceptance:worker", { role: "worker", id: "worker-T1" }, {
        kind: "task",
        taskId: "T1",
        expectedRevisionId: "revision_1",
        expectedDigest: rebuildSchedulerProjection(store!.readRun(RUN_ID)).planning!.plan!.currentDigest,
        acceptance: acceptedTask(),
      })),
      /Workers cannot self-accept planning work/,
    );
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T2 guard: worker cannot rewrite the planning ledger", () => {
  const fixture = fixtureWithScopedAmendment();
  const state = planningStateAfter(planningInputs(fixture).slice(0, 3));
  assert.throws(
    () => reducePlanningProjection(state, event(
      "planning.ledger_persisted",
      "ledger:worker",
      { role: "worker", id: "worker" },
      {
        id: "ledger-forged",
        requirements: fixture.requirements,
        phases: fixture.phases,
        nonNormativeSections: [],
      },
    ) as never),
    /Workers cannot rewrite the planning ledger/,
  );
});

test("T2 guard: stale plan revision cannot advance planning", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-planning-stale-"));
  let store: SqliteSchedulerStore | undefined;
  try {
    store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
    const fixture = seedReady(store);
    const current = rebuildSchedulerProjection(store.readRun(RUN_ID)).planning!;
    const revisionTwo = rebuildRevision(fixture, {
      revisionId: "revision_2",
      createdAt: "2026-09-24T00:03:00.000Z",
    });
    store.append(event("planning.plan_revised", "plan:revision-2", { role: "architect", id: "architect" }, {
      revision: revisionTwo,
      expectedRevisionId: current.plan!.currentRevisionId,
      expectedDigest: current.plan!.currentDigest,
    }));
    assert.throws(
      () => store!.append(event("planning.plan_revised", "plan:stale", { role: "architect", id: "architect" }, {
        revision: rebuildRevision(fixture, {
          revisionId: "revision_3",
          createdAt: "2026-09-24T00:04:00.000Z",
        }),
        expectedRevisionId: "revision_1",
        expectedDigest: current.plan!.currentDigest,
      })),
      /stale plan revision/,
    );
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T2 guard: changed artifact digest prevents planning advancement", () => {
  const fixture = fixtureWithScopedAmendment();
  const state = planningStateAfter(planningInputs(fixture).slice(0, 6));
  const changed = rebuildRevision(fixture, {
    revisionId: "revision-drift",
    sourceManifestDigest: "b".repeat(64),
    createdAt: "2026-09-24T00:05:00.000Z",
  });
  assert.throws(
    () => reducePlanningProjection(state, event(
      "planning.plan_drafted",
      "plan:drift",
      { role: "architect", id: "architect" },
      { revision: changed },
    ) as never),
    /source digest.*no longer matches/i,
  );
});

test("T2 forged planning role cannot append lifecycle state", () => {
  const fixture = fixtureWithScopedAmendment();
  const state = planningStateAfter(planningInputs(fixture));
  assert.throws(
    () => reducePlanningProjection(state, event(
      "planning.checkpoint_recorded",
      "checkpoint:forged",
      { role: "owner" as PlanningActorRole, id: "forged" },
      {
        checkpoint: {
          id: "forged",
          coveredSourceSectionIds: ["s1"],
          completedPlanningContractIds: ["requirement-ledger"],
          remainingWork: [],
          nextAction: "Forge state.",
          recordedAt: "2026-09-24T00:00:00.000Z",
        },
      },
    ) as never),
    /Role owner cannot append/,
  );
});

test("T2 guard: interrupted validation is never passed", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-planning-interrupted-"));
  let store: SqliteSchedulerStore | undefined;
  try {
    store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
    seedReady(store);
    prepareAcceptedTask(store, "T1", 1, false);
    store.append(event("planning.validation_intent_recorded", "validation:intent", { role: "architect", id: "architect" }, {
      taskId: "T1",
      intent: validationIntent("validation-interrupted"),
      expectedRevisionId: "revision_1",
      expectedDigest: rebuildSchedulerProjection(store.readRun(RUN_ID)).planning!.plan!.currentDigest,
    }));
    const digest = rebuildSchedulerProjection(store.readRun(RUN_ID)).planning!.plan!.currentDigest;
    store.append(event("planning.validation_interrupted", "validation:interrupted", { role: "runner", id: "runner" }, {
      taskId: "T1",
      intentId: "validation-interrupted",
      interruptedCommandId: "command-1",
      expectedRevisionId: "revision_1",
      expectedDigest: digest,
    }));
    assert.throws(
      () => store!.append(event("planning.acceptance_recorded", "acceptance:interrupted", { role: "runner", id: "runner" }, {
        kind: "task",
        taskId: "T1",
        expectedRevisionId: "revision_1",
        expectedDigest: digest,
        acceptance: acceptedTask(),
      })),
      /Interrupted or unknown validation prevents planning advancement/,
    );
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T2 cancelled task with an orphaned requirement prevents advancement", () => {
  const fixture = fixtureWithScopedAmendment();
  const inputs = [
    ...planningInputs(fixture),
    event("planning.assignment_claimed", "assignment:1", { role: "runner", id: "runner" }, { claim: claim() }),
    event("planning.recovery_reconciled", "recovery:1", { role: "runner", id: "runner" }, {
      assignmentId: "assignment-1",
      recovery: recovery(true),
    }),
  ];
  const state = planningStateAfter(inputs);
  assert.throws(
    () => reducePlanningProjection(state, event(
      "planning.acceptance_recorded",
      "acceptance:orphan",
      { role: "runner", id: "runner" },
      {
        kind: "task",
        taskId: "T1",
        expectedRevisionId: "revision_1",
        expectedDigest: state!.plan!.currentDigest,
        acceptance: acceptedTask(),
      },
    ) as never, { taskStatuses: new Map([["T1", "cancelled"]]) }),
    /only implementation task.*cancelled|orphaned/i,
  );
});

test("T2 lost owned workspace prevents planning acceptance", () => {
  const fixture = fixtureWithScopedAmendment();
  const state = planningStateAfter([
    ...planningInputs(fixture),
    event("planning.assignment_claimed", "assignment:1", { role: "runner", id: "runner" }, { claim: claim() }),
    event("planning.recovery_reconciled", "recovery:lost", { role: "runner", id: "runner" }, {
      assignmentId: "assignment-1",
      recovery: recovery(false),
    }),
  ]);
  assert.throws(
    () => reducePlanningProjection(state, event(
      "planning.acceptance_recorded",
      "acceptance:lost",
      { role: "runner", id: "runner" },
      {
        kind: "task",
        taskId: "T1",
        expectedRevisionId: "revision_1",
        expectedDigest: state!.plan!.currentDigest,
        acceptance: acceptedTask(),
      },
    ) as never),
    /verified exclusive workspace ownership/,
  );
});

test("T2 interrupt after ledger resumes the first uncovered section without inferring readiness", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-planning-resume-"));
  let store: SqliteSchedulerStore | undefined;
  try {
    const fixture = fixtureWithScopedAmendment();
    const inputs = planningInputs(fixture).slice(0, 6);
    store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
    appendAll(store, inputs);
    store.close();
    store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
    const resumed = rebuildSchedulerProjection(store.readRun(RUN_ID)).planning!;
    assert.equal(resumed.ledger?.id, "ledger-1");
    assert.deepEqual(resumed.resume.coveredSourceSectionIds, []);
    assert.equal(resumed.resume.nextSourceSectionId, "s1");
    assert.equal(resumed.resume.nextAction, "Cover source section s1.");
    assert.equal(resumed.readiness, "not_ready");
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T2 interrupt after one covered section resumes the exact next section without repeating accepted work", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-planning-resume-section-"));
  let store: SqliteSchedulerStore | undefined;
  try {
    const fixture = fixtureWithScopedAmendment();
    store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
    // C4: reads are authority. Ledger (index 5 after the T9 seed triage) plus
    // the single s1 durable read (index 6) plus the matching old checkpoint
    // replay (index 6 + section count). No other reads are seeded.
    const all = planningInputs(fixture);
    const checkpointIndex = 6 + fixture.manifest.sections.length;
    assert.equal(all[6]!.idempotencyKey, "read:s1");
    assert.equal(all[checkpointIndex]!.idempotencyKey, "checkpoint:1");
    appendAll(store, [...all.slice(0, 7), all[checkpointIndex]!]);
    store.close();
    store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
    const resumed = rebuildSchedulerProjection(store.readRun(RUN_ID)).planning!;
    assert.deepEqual(resumed.resume.coveredSourceSectionIds, ["s1"]);
    assert.equal(resumed.resume.nextSourceSectionId, "s2");
    assert.deepEqual(resumed.resume.completedPlanningContractIds, ["requirement-ledger"]);
    assert.equal(resumed.readiness, "not_ready");
    store.append(event("planning.checkpoint_recorded", "checkpoint:unrelated-resume", { role: "architect", id: "architect" }, {
      checkpoint: {
        id: "checkpoint-2",
        coveredSourceSectionIds: ["s1"],
        completedPlanningContractIds: ["requirement-ledger"],
        remainingWork: ["Inspect unrelated runtime capability."],
        nextAction: "Cover source section s2.",
        recordedAt: "2026-09-24T00:02:00.000Z",
      },
    }));
    const unrelatedResume = rebuildSchedulerProjection(store.readRun(RUN_ID)).planning!;
    assert.deepEqual(unrelatedResume.resume.coveredSourceSectionIds, ["s1"]);
    assert.equal(unrelatedResume.resume.nextSourceSectionId, "s2");
    assert.deepEqual(unrelatedResume.resume.completedPlanningContractIds, ["requirement-ledger"]);
    // C4 negative: a stored checkpoint advertising s2 cannot count it without a
    // current-manifest durable full read of s2.
    assert.throws(
      () => store!.append(event("planning.checkpoint_recorded", "checkpoint:fake-s2", { role: "architect", id: "architect" }, {
        checkpoint: {
          id: "checkpoint-fake-s2",
          coveredSourceSectionIds: ["s1", "s2"],
          completedPlanningContractIds: ["requirement-ledger"],
          remainingWork: ["Cover source section s3."],
          nextAction: "Cover source section s3.",
          recordedAt: "2026-09-24T00:03:00.000Z",
        },
      })),
      /without a durable full read/,
    );
    const afterFake = rebuildSchedulerProjection(store!.readRun(RUN_ID)).planning!;
    assert.deepEqual(afterFake.resume.coveredSourceSectionIds, ["s1"]);
    assert.equal(afterFake.resume.nextSourceSectionId, "s2");
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T2 legacy terminal and active fixtures replay unchanged without planning state", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-planning-legacy-"));
  let store: SqliteSchedulerStore | undefined;
  try {
    const legacyEvent = (
      runId: string,
      sequence: number,
      type: "run.policy_configured" | "plan.created" | "run.completed",
      actor: { role: SchedulerActorRole; id: string },
      payload: Record<string, unknown>,
    ): SchedulerEvent => ({
      eventId: `legacy_${runId}_${sequence}`,
      runId,
      sequence,
      type,
      occurredAt: "2026-09-24T00:00:00.000Z",
      actor,
      idempotencyKey: `legacy:${sequence}`,
      payload,
    });
    const plan = { revision: 1, tasks: [] };
    const active = [
      legacyEvent("legacy_active", 1, "run.policy_configured", { role: "runner", id: "runner" }, { runPolicy: "plan_only" }),
      legacyEvent("legacy_active", 2, "plan.created", { role: "architect", id: "architect" }, plan),
    ];
    const terminal = [
      legacyEvent("legacy_terminal", 1, "run.policy_configured", { role: "runner", id: "runner" }, { runPolicy: "plan_only" }),
      legacyEvent("legacy_terminal", 2, "plan.created", { role: "architect", id: "architect" }, plan),
      legacyEvent("legacy_terminal", 3, "run.completed", { role: "architect", id: "architect" }, {}),
    ];
    const expectedActive = rebuildSchedulerProjection(active);
    const expectedTerminal = rebuildSchedulerProjection(terminal);
    assert.equal(expectedActive.status, "running");
    assert.equal(expectedTerminal.status, "completed");
    assert.equal(expectedActive.planning, undefined);
    assert.equal(expectedTerminal.planning, undefined);
    store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
    for (const eventRecord of [...active, ...terminal]) {
      store.append({
        runId: eventRecord.runId,
        type: eventRecord.type,
        occurredAt: eventRecord.occurredAt,
        actor: eventRecord.actor,
        idempotencyKey: eventRecord.idempotencyKey,
        payload: eventRecord.payload,
      });
    }
    store.close();
    store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
    assert.deepEqual(rebuildSchedulerProjection(store.readRun("legacy_active")), expectedActive);
    assert.deepEqual(rebuildSchedulerProjection(store.readRun("legacy_terminal")), expectedTerminal);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T2 unrelated resume preserves accepted work while reopened acceptance can be recorded again", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-planning-acceptance-"));
  let store: SqliteSchedulerStore | undefined;
  try {
    store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
    seedReady(store);
    store.append(event("planning.assignment_claimed", "assignment:1", { role: "runner", id: "runner" }, { claim: claim() }));
    store.append(event("planning.validation_intent_recorded", "validation:intent", { role: "architect", id: "architect" }, {
      taskId: "T1",
      intent: validationIntent(),
      expectedRevisionId: "revision_1",
      expectedDigest: rebuildSchedulerProjection(store.readRun(RUN_ID)).planning!.plan!.currentDigest,
    }));
    store.append(event("planning.validation_observed", "validation:observed", { role: "worker", id: "worker-T1" }, {
      taskId: "T1",
      intentId: "validation-1",
      observation: validationObservation(),
      evidenceIdentity: { evidenceId: "evidence-1", digest: EVIDENCE_DIGEST },
      expectedRevisionId: "revision_1",
      expectedDigest: rebuildSchedulerProjection(store.readRun(RUN_ID)).planning!.plan!.currentDigest,
    }));
    store.append(event("planning.recovery_reconciled", "recovery:verified", { role: "runner", id: "runner" }, {
      assignmentId: "assignment-1",
      recovery: recovery(true),
    }));
    store.append(event("planning.reference_recorded", "reference:integration:T1", { role: "runner", id: "runner" }, {
      references: {
        "integration-1": { kind: "integration", id: "integration-1" },
        "BP1-exit": { kind: "gate", id: "BP1-exit" },
      },
    }));
    const digest = rebuildSchedulerProjection(store.readRun(RUN_ID)).planning!.plan!.currentDigest;
    store.append(event("planning.acceptance_recorded", "acceptance:T1", { role: "runner", id: "runner" }, {
      kind: "task",
      taskId: "T1",
      expectedRevisionId: "revision_1",
      expectedDigest: digest,
      acceptance: acceptedTask(),
    }));
    assert.throws(
      () => store!.append(event("planning.acceptance_recorded", "acceptance:T1:while-accepted", { role: "runner", id: "runner" }, {
        kind: "task",
        taskId: "T1",
        expectedRevisionId: "revision_1",
        expectedDigest: digest,
        acceptance: acceptedTask(),
      })),
      /already recorded/,
    );
    store.append(event("planning.acceptance_reopened", "acceptance:T1:reopen", { role: "architect", id: "architect" }, {
      kind: "task",
      taskId: "T1",
      expectedRevisionId: "revision_1",
      expectedDigest: digest,
    }));
    store.append(event("planning.validation_intent_recorded", "validation:intent:reaccept", { role: "architect", id: "architect" }, {
      taskId: "T1",
      intent: validationIntent("validation-2"),
      expectedRevisionId: "revision_1",
      expectedDigest: digest,
    }));
    store.append(event("planning.validation_observed", "validation:observed:reaccept", { role: "worker", id: "worker-T1" }, {
      taskId: "T1",
      intentId: "validation-2",
      observation: validationObservation("observation-2", "validation-2", "evidence-2"),
      evidenceIdentity: { evidenceId: "evidence-2", digest: "2".repeat(64) },
      expectedRevisionId: "revision_1",
      expectedDigest: digest,
    }));
    store.append(event("planning.recovery_reconciled", "recovery:reaccept", { role: "runner", id: "runner" }, {
      assignmentId: "assignment-1",
      recovery: {
        ...recovery(true),
        evidence: [
          { id: "evidence-1", digest: EVIDENCE_DIGEST },
          { id: "evidence-2", digest: "2".repeat(64) },
        ],
      },
    }));
    store.append(event("planning.acceptance_recorded", "acceptance:T1:reaccepted", { role: "runner", id: "runner" }, {
      kind: "task",
      taskId: "T1",
      expectedRevisionId: "revision_1",
      expectedDigest: digest,
      acceptance: acceptedTask("T1", "observation-2", "integration-1"),
    }));
    const acceptedEventId = store.readRun(RUN_ID).find((record) => record.idempotencyKey === "acceptance:T1")!.eventId;
    store.close();
    store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
    const events = store.readRun(RUN_ID);
    const projection = rebuildSchedulerProjection(events).planning!;
    assert.equal(events.find((record) => record.idempotencyKey === "acceptance:T1")!.eventId, acceptedEventId);
    assert.equal(projection.acceptances["task:T1"].status, "accepted");
    assert.equal(projection.acceptances["task:T1"].history?.length, 2);
    assert.deepEqual(projection.references["BP1-exit"], { kind: "gate", id: "BP1-exit" });
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T2 I3: acceptance refuses zero validations and fabricated check or review references", () => {
  const fixture = fixtureWithScopedAmendment();
  const zero = new MemorySchedulerStore();
  try {
    appendAll(zero, planningInputs(fixture));
    zero.append(event("planning.assignment_claimed", "assignment:1", { role: "runner", id: "runner" }, { claim: claim() }));
    zero.append(event("planning.recovery_reconciled", "recovery:1", { role: "runner", id: "runner" }, {
      assignmentId: "assignment-1",
      recovery: recovery(true),
    }));
    zero.append(event("planning.reference_recorded", "reference:integration:zero", { role: "runner", id: "runner" }, {
      references: { "integration-zero": { kind: "integration", id: "integration-zero" } },
    }));
    assert.throws(
      () => zero.append(event("planning.acceptance_recorded", "acceptance:zero-validations", { role: "runner", id: "runner" }, {
        kind: "task",
        taskId: "T1",
        acceptance: acceptedTask("T1", "fabricated-obs", "integration-zero"),
        ...currentPlanBinding(zero),
      })),
      /requires at least one validation observation/,
    );
  } finally {
    zero.close();
  }

  const fabricated = new MemorySchedulerStore();
  try {
    appendAll(fabricated, planningInputs(fixture));
    const prepared = prepareAcceptedTask(fabricated, "T2", 2, false);
    assert.throws(
      () => fabricated.append(event("planning.acceptance_recorded", "acceptance:fabricated-refs", { role: "runner", id: "runner" }, {
        kind: "task",
        taskId: "T2",
        acceptance: {
          ...acceptedTask("T2", "fabricated-obs", "integration-2"),
          reviewId: "fabricated-review",
        },
        ...currentPlanBinding(fabricated),
      })),
      /does not resolve to a current passed validation observation/,
    );
    assert.equal(prepared.observationId, "observation-2");
  } finally {
    fabricated.close();
  }
});

test("T2 I3: failed validation and tasks outside the current plan prevent advancement", () => {
  const fixture = fixtureWithScopedAmendment();
  const failed = new MemorySchedulerStore();
  try {
    appendAll(failed, planningInputs(fixture));
    prepareAcceptedTask(failed, "T2", 2, false, "failed");
    assert.throws(
      () => failed.append(event("planning.acceptance_recorded", "acceptance:failed-validation", { role: "runner", id: "runner" }, {
        kind: "task",
        taskId: "T2",
        acceptance: acceptedTask("T2", "observation-2", "integration-2"),
        ...currentPlanBinding(failed),
      })),
      /Current failed validation for check/,
    );
  } finally {
    failed.close();
  }

  const unknownTask = new MemorySchedulerStore();
  try {
    appendAll(unknownTask, planningInputs(fixture));
    assert.throws(
      () => unknownTask.append(event("planning.assignment_claimed", "assignment:unknown", { role: "runner", id: "runner" }, {
        claim: claim("TASK-NOT-IN-PLAN"),
      })),
      /not in the current plan revision/,
    );
  } finally {
    unknownTask.close();
  }
});

test("T2 I3: phase acceptance is reachable through accepted contributing tasks", () => {
  const fixture = fixtureWithScopedAmendment();
  const store = new MemorySchedulerStore();
  try {
    appendAll(store, planningInputs(fixture));
    prepareAcceptedTask(store, "T1", 1);
    prepareAcceptedTask(store, "T2", 2);
    prepareAcceptedTask(store, "T4", 4);
    const revision = rebuildSchedulerProjection(store.readRun(RUN_ID)).planning!.plan!.revisionsById.revision_1;
    store.append(event("planning.acceptance_recorded", "acceptance:BP1", { role: "architect", id: "architect" }, {
      kind: "phase",
      phaseId: "BP1",
      acceptance: {
        phaseId: "BP1",
        requirementIds: revision.requirements
          .filter((requirement) => requirement.accountablePhaseId === "BP1")
          .map((requirement) => requirement.id),
        taskAcceptanceRefs: ["T1", "T2", "T4"],
        status: "accepted",
      },
      ...currentPlanBinding(store),
    }));
    const projection = rebuildSchedulerProjection(store.readRun(RUN_ID)).planning!;
    assert.equal(projection.acceptances["phase:BP1"].status, "accepted");
  } finally {
    store.close();
  }
});

test("T2 M4: changed accepted task contracts reopen acceptance while unrelated revisions do not", () => {
  const fixture = fixtureWithScopedAmendment();
  const changedStore = new MemorySchedulerStore();
  try {
    appendAll(changedStore, planningInputs(fixture));
    prepareAcceptedTask(changedStore, "T1", 1);
    const changedTasks = fixture.revision.tasks.map((task) => task.id === "T1"
      ? { ...task, outcome: { ...task.outcome, system: "Changed accepted task behavior." } }
      : task);
    const changed = rebuildRevision(fixture, {
      revisionId: "revision_changed_task",
      tasks: changedTasks,
      createdAt: "2026-09-24T00:05:00.000Z",
    });
    changedStore.append(event("planning.plan_revised", "plan:changed-task", { role: "architect", id: "architect" }, {
      revision: changed,
      ...currentPlanBinding(changedStore),
    }));
    const changedState = rebuildSchedulerProjection(changedStore.readRun(RUN_ID)).planning!;
    assert.equal(changedState.acceptances["task:T1"].status, "reopened");
    assert.equal(changedState.acceptances["task:T1"].reopenedByPlanRevisionId, "revision_changed_task");
  } finally {
    changedStore.close();
  }

  const unrelatedStore = new MemorySchedulerStore();
  try {
    appendAll(unrelatedStore, planningInputs(fixture));
    prepareAcceptedTask(unrelatedStore, "T1", 1);
    const unrelated = rebuildRevision(fixture, {
      revisionId: "revision_unrelated",
      planningDecisions: [
        ...fixture.revision.planningDecisions,
        { id: "D-unrelated", description: "Unrelated planning decision.", decidedAt: "2026-09-24T00:06:00.000Z" },
      ],
      createdAt: "2026-09-24T00:06:00.000Z",
    });
    unrelatedStore.append(event("planning.plan_revised", "plan:unrelated", { role: "architect", id: "architect" }, {
      revision: unrelated,
      ...currentPlanBinding(unrelatedStore),
    }));
    const unrelatedState = rebuildSchedulerProjection(unrelatedStore.readRun(RUN_ID)).planning!;
    assert.equal(unrelatedState.acceptances["task:T1"].status, "accepted");
    assert.equal(unrelatedState.acceptances["task:T1"].reopenedByPlanRevisionId, undefined);
  } finally {
    unrelatedStore.close();
  }
});

test("T2 crash between validation intent and durable append preserves planning ids and counts", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-planning-crash-before-"));
  let store: SqliteSchedulerStore | undefined;
  try {
    store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
    seedReady(store);
    store.append(event("planning.assignment_claimed", "assignment:1", { role: "runner", id: "runner" }, { claim: claim() }));
    const before = store.readRun(RUN_ID);
    const intentInput = event("planning.validation_intent_recorded", "validation:intent:crash", { role: "architect", id: "architect" }, {
      taskId: "T1",
      intent: validationIntent("validation-crash"),
      ...currentPlanBinding(store),
    });
    assert.throws(
      () => {
        const events = store!.readRun(RUN_ID);
        reduceSchedulerEvent(rebuildSchedulerProjection(events), {
          ...intentInput,
          eventId: "crash-before-insert",
          sequence: events.length + 1,
        });
        throw new Error("simulated crash before durable append");
      },
      /simulated crash before durable append/,
    );
    store.close();
    store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
    const after = store.readRun(RUN_ID);
    assert.deepEqual(after.map((record) => record.eventId), before.map((record) => record.eventId));
    assert.equal(after.length, before.length);
    assert.equal(rebuildSchedulerProjection(after).planning?.validations["T1:validation-crash"], undefined);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T2 crash after validation-intent durable append preserves planning ids and counts", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-planning-crash-after-"));
  let store: SqliteSchedulerStore | undefined;
  try {
    store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
    seedReady(store);
    store.append(event("planning.assignment_claimed", "assignment:1", { role: "runner", id: "runner" }, { claim: claim() }));
    const appended = store.append(event("planning.validation_intent_recorded", "validation:intent:durable", { role: "architect", id: "architect" }, {
      taskId: "T1",
      intent: validationIntent("validation-durable"),
      ...currentPlanBinding(store),
    }));
    const before = store.readRun(RUN_ID);
    store.close();
    store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
    const after = store.readRun(RUN_ID);
    assert.deepEqual(after.map((record) => record.eventId), before.map((record) => record.eventId));
    assert.equal(after.at(-1)!.eventId, appended.eventId);
    assert.equal(rebuildSchedulerProjection(after).planning?.validations["T1:validation-durable"].status, "planned");
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
