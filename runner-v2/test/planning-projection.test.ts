import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlanningProjection,
  derivePlanningOwnershipView,
  reducePlanningProjection,
  reconcilePlanningProjection,
  type PlanningEventInput,
  type PlanningProjection,
} from "../src/planning-projection.js";
import { buildSourceManifest } from "../src/source-manifest.js";
import { buildPlanningFixtureScenario } from "./fixtures/planning-source-fixture.js";

function planningEvent(
  type: PlanningEventInput["type"],
  actor: PlanningEventInput["actor"],
  payload: Record<string, unknown>,
): PlanningEventInput {
  return {
    runId: "run_fixture",
    type,
    occurredAt: "2026-09-24T00:00:00.000Z",
    actor,
    idempotencyKey: type,
    payload,
  };
}

/** T3b (N2): durable full verified reads must precede any checkpoint coverage claim. */
function readEventsFor(
  manifest: { manifestId: string; artifactDigest: string; sections: readonly { id: string; digest: string }[] },
  sectionIds: readonly string[],
): PlanningEventInput[] {
  return sectionIds.map((sectionId, index) => ({
    runId: "run_fixture",
    type: "planning.source_section_read",
    occurredAt: "2026-09-24T00:00:00.000Z",
    actor: { role: "architect", id: "architect" },
    idempotencyKey: `read:${manifest.manifestId}:${sectionId}:${index}`,
    payload: {
      manifestId: manifest.manifestId,
      manifestDigest: manifest.artifactDigest,
      sectionId,
      sectionDigest: manifest.sections.find((section) => section.id === sectionId)!.digest,
      readAt: "2026-09-24T00:00:00.000Z",
    },
  }));
}

test("planning projection creates source state and derives the initial resume index", () => {
  const fixture = buildPlanningFixtureScenario();
  const projection = createPlanningProjection(planningEvent(
    "planning.source_registered",
    { role: "user", id: "owner" },
    { manifest: fixture.priorManifest },
  ));
  assert.equal(projection.source.artifactDigest, fixture.priorManifest.artifactDigest);
  assert.equal(projection.resume.nextSourceSectionId, "s1");
  assert.equal(projection.readiness, "not_ready");
});

test("planning projection derives ownership and cumulative checkpoint views", () => {
  const fixture = buildPlanningFixtureScenario();
  let projection = createPlanningProjection(planningEvent(
    "planning.source_registered",
    { role: "user", id: "owner" },
    { manifest: fixture.priorManifest },
  ));
  projection = reducePlanningProjection(projection, planningEvent(
    "planning.source_amended",
    { role: "user", id: "owner" },
    {
      manifest: {
        ...fixture.manifest,
        amendment: {
          ...fixture.manifest.amendment!,
          recordedImpact: {
            addsSectionIds: ["s8"],
            retiresSectionIds: ["s7"],
            addsRequirementIds: [],
            retiresRequirementIds: ["REQ-RETIRED"],
          },
        },
      },
    },
  ));
  projection = reducePlanningProjection(projection, planningEvent(
    "planning.ledger_persisted",
    { role: "architect", id: "architect" },
    {
      id: "ledger-1",
      requirements: fixture.requirements,
      phases: fixture.phases,
      nonNormativeSections: [],
    },
  ));
  for (const read of readEventsFor(fixture.manifest, ["s1"])) {
    projection = reducePlanningProjection(projection, read);
  }
  projection = reducePlanningProjection(projection, planningEvent(
    "planning.checkpoint_recorded",
    { role: "architect", id: "architect" },
    {
      checkpoint: {
        id: "checkpoint-1",
        coveredSourceSectionIds: ["s1"],
        completedPlanningContractIds: ["requirement-ledger"],
        remainingWork: ["Cover source section s2"],
        nextAction: "Cover source section s2.",
        recordedAt: "2026-09-24T00:01:00.000Z",
      },
    },
  ));
  const ownership = derivePlanningOwnershipView(projection);
  assert.equal(ownership.requirementOwners["REQ-SECURITY"], "BP1");
  assert.deepEqual(projection.resume.coveredSourceSectionIds, ["s1"]);
  assert.equal(projection.resume.nextSourceSectionId, "s2");
});

test("planning recovery reconciliation distinguishes verified mismatched and unknown actual identity", () => {
  const fixture = buildPlanningFixtureScenario();
  const source = createPlanningProjection(planningEvent(
    "planning.source_registered",
    { role: "user", id: "owner" },
    { manifest: fixture.priorManifest },
  ));
  const projection: PlanningProjection = {
    ...source,
    assignments: {
      "assignment-1": {
        claim: {
          id: "assignment-1",
          packetId: "T1",
          laneId: "lane-A",
          workerOrSessionId: "worker-T1",
          acceptedBaseRevision: "a".repeat(40),
          branchOrWorktree: "worktrees/T1",
          writableSurfaces: [],
          forbiddenSurfaces: [],
          ownershipGeneration: 1,
          state: "claimed",
        },
        status: "claimed",
        recoveryStatus: "unchecked",
      },
    },
    references: {
      "evidence-1": { kind: "evidence", id: "evidence-1", digest: "1".repeat(64) },
    },
  };
  const actual = {
    assignments: [{
      assignmentId: "assignment-1",
      workspaceExists: true,
      branchOrWorktree: "worktrees/T1",
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40),
    }],
    evidence: [{ id: "evidence-1", digest: "1".repeat(64) }],
  };
  assert.equal(reconcilePlanningProjection(projection, actual).status, "verified");
  assert.equal(reconcilePlanningProjection(projection, {
    ...actual,
    assignments: [{ ...actual.assignments[0], workspaceExists: false }],
  }).status, "mismatch");
  assert.equal(reconcilePlanningProjection(projection, { assignments: [], evidence: [] }).status, "unknown");
});

test("planning checkpoint coverage is invalidated when an amendment changes a section digest", () => {
  const baseBytes = Buffer.from("AAA\nBBB\nCCC", "utf8");
  const amendedBytes = Buffer.from("AAA\nBXB\nCCC", "utf8");
  const spans = [
    { id: "s1", startByte: 0, endByte: 4 },
    { id: "s2", startByte: 4, endByte: 8 },
    { id: "s3", startByte: 8, endByte: 11 },
  ];
  const base = buildSourceManifest(baseBytes, spans, {
    manifestId: "manifest_checkpoint_base",
    sourceId: "source_checkpoint",
    mediaType: "text/plain",
    encoding: "utf-8",
    authority: "owner",
    createdAt: "2026-09-24T00:00:00.000Z",
  });
  const amended = buildSourceManifest(amendedBytes, spans, {
    manifestId: "manifest_checkpoint_amended",
    sourceId: "source_checkpoint",
    mediaType: "text/plain",
    encoding: "utf-8",
    authority: "owner",
    createdAt: "2026-09-24T00:01:00.000Z",
    amendment: {
      id: "amend-checkpoint",
      priorManifestId: base.manifestId,
      priorArtifactDigest: base.artifactDigest,
      authorizedBy: "owner",
      rationale: "Change section s2.",
      recordedImpact: {
        addsSectionIds: [],
        retiresSectionIds: ["s2"],
        addsRequirementIds: [],
        retiresRequirementIds: [],
      },
    },
  });
  const requirement = {
    id: "REQ-CHECKPOINT",
    reference: { sourceId: base.sourceId, sectionIds: ["s1", "s2", "s3"] },
    purpose: "Cover the source.",
    observableOutcome: "Every section is covered.",
    obligationKind: "mandatory",
    applicability: { status: "applicable" },
    accountablePhaseId: "BP1",
    contributingTaskIds: ["T1"],
    acceptanceConditions: [{
      id: "AC-1",
      description: "Coverage is recorded.",
      responsibleGateId: "BP1-exit",
      requiredEvidenceKinds: ["command"],
    }],
  };
  let projection = createPlanningProjection(planningEvent(
    "planning.source_registered",
    { role: "user", id: "owner" },
    { manifest: base },
  ));
  projection = reducePlanningProjection(projection, planningEvent(
    "planning.ledger_persisted",
    { role: "architect", id: "architect" },
    {
      id: "ledger-checkpoint",
      requirements: [requirement],
      phases: [{ id: "BP1" }],
      nonNormativeSections: [],
    },
  ));
  for (const read of readEventsFor(base, ["s1", "s2", "s3"])) {
    projection = reducePlanningProjection(projection, read);
  }
  projection = reducePlanningProjection(projection, planningEvent(
    "planning.checkpoint_recorded",
    { role: "architect", id: "architect" },
    {
      checkpoint: {
        id: "checkpoint-all",
        coveredSourceSectionIds: ["s1", "s2", "s3"],
        completedPlanningContractIds: ["requirement-ledger"],
        remainingWork: [],
        nextAction: "Draft the execution plan.",
        recordedAt: "2026-09-24T00:02:00.000Z",
      },
    },
  ));
  projection = reducePlanningProjection(projection, planningEvent(
    "planning.source_amended",
    { role: "user", id: "owner" },
    { manifest: amended },
  ));
  assert.deepEqual(projection.resume.coveredSourceSectionIds, ["s1", "s3"]);
  assert.deepEqual(projection.resume.remainingSourceSectionIds, ["s2"]);
  assert.equal(projection.resume.nextSourceSectionId, "s2");
});
