import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessDeliveryRisk,
  deliveryReviewId,
  deriveReviewTaskPrefill,
  diffReviewTaskVerdicts,
  type DeliveryReviewRecord,
} from "../src/delivery-acceptance.js";
import {
  acceptanceContractAuditProjection,
  currentExplicitStartIdentity,
  reduceSchedulerEvent,
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
  type SchedulerActorRole,
  type SchedulerEvent,
  type SchedulerEventType,
  type SchedulerProjection,
} from "../src/scheduler-store.js";
import type { BuildTask } from "../src/task-contracts.js";
import type { CriterionEvidenceLink } from "../src/acceptance-contracts.js";
import type { CommandEvidenceFact } from "../src/evidence-store.js";
import {
  architectTurnSessionId,
  captureArchitectEvidenceReads,
} from "../src/review-evidence.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { createArtifactTools } from "../src/artifact-tools.js";
import { createEvidenceTools } from "../src/evidence-tools.js";
import { ToolBroker } from "../src/tool-broker.js";
import { architectContextSections } from "../src/agent-prompts.js";
import { createArchitectTools } from "../src/architect-tools.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import type { ToolCallBlock } from "../src/agent-contracts.js";
import {
  FIXTURE_AMENDED_TEXT,
  buildPlanningFixtureScenario,
  type PlanningFixtureScenario,
} from "./fixtures/planning-source-fixture.js";

// W3 (AR-R29/AR-3): the Architect confirms a runner-owned prefill or records a
// reasoned override; unverified -> verified additionally needs same-session
// evidence reads. Pure prefill/deviation, reducer, ledger-capture, and prompt
// tests. The lifecycle tool path is proven by w3-product-disposition.test.ts.

const RUN = "w3-disposition";
const AT = "2026-10-05T00:00:00.000Z";
const STDOUT = "a".repeat(64);
const DIFF = "e".repeat(64);
const TREE = "c".repeat(40);
const SESSION = architectTurnSessionId(RUN);
const ACTOR = "arch:architect";

function link(criterionId: string, evidenceId: string): CriterionEvidenceLink {
  return {
    criterionId,
    evidenceId,
    artifactHashes: [STDOUT],
    taskId: "T1",
    attempt: 1,
    freshness: { status: "current", submittedTreeId: TREE, evidenceTreeId: TREE },
  };
}

function taskFixture(): BuildTask {
  return {
    id: "T1",
    objective: "Deliver the value module.",
    dependencies: [],
    status: "submitted",
    requiredCapabilities: [],
    attempt: 1,
    acceptanceCriteria: [
      { id: "c1", text: "The value module exports 2." },
      { id: "c2", text: "The guard caps the value." },
    ],
    criterionEvidenceLinks: [link("c1", "ev-1"), link("c2", "ev-2")],
    assignedWorkerId: "worker:T1:1",
    changeSetId: "changeset_T1",
  };
}

function reviewFixture(overrides: Partial<DeliveryReviewRecord> = {}): DeliveryReviewRecord {
  return {
    taskId: "T1",
    reviewId: "review_T1",
    generation: 1,
    submissionAttempt: 1,
    changeSetId: "changeset_T1",
    diffArtifactHash: DIFF,
    criteriaIds: ["c1", "c2"],
    authorRuntimeId: "work:author",
    authorModelIdentity: "author",
    architectRuntimeId: ACTOR,
    architectModelIdentity: "architect",
    stage: "completed",
    startedSequence: 1,
    reviewerRuntimeId: "rev:reviewer",
    reviewerModelIdentity: "reviewer",
    independence: "distinct_model",
    risk: { tier: "medium", score: 2, digest: "b".repeat(64), signals: [] },
    sessionIds: ["findings-session", "verdict-session"],
    claims: [
      { id: "claim:c1", text: "Criterion c1 is satisfied.", evidenceIds: ["ev-1"], mechanical: { label: "verified", reason: "Mechanical fields match." } },
      { id: "claim:c2", text: "Criterion c2 is satisfied.", evidenceIds: ["ev-2"], mechanical: { label: "verified", reason: "Mechanical fields match." } },
      { id: "claim:summary", text: "Summary.", evidenceIds: [], mechanical: { label: "reviewer_judgement", reason: "Freeform summary." } },
    ],
    findings: [],
    claimVerdicts: [
      { claimId: "claim:c1", claim: "Criterion c1 is satisfied.", status: "verified", rationale: "Confirmed." },
      { claimId: "claim:c2", claim: "Criterion c2 is satisfied.", status: "verified", rationale: "Confirmed." },
      { claimId: "claim:summary", claim: "Summary.", status: "verified", rationale: "Reads well." },
    ],
    summary: "Reviewed.",
    satisfied: true,
    completedSequence: 9,
    ...overrides,
  };
}

const initial: SchedulerEvent = {
  runId: RUN, eventId: "init", sequence: 1, type: "run.initialized",
  occurredAt: AT, actor: { role: "runner", id: "build-runtime" },
  idempotencyKey: "init", payload: {},
};

function projectionWith(task: BuildTask, review: DeliveryReviewRecord, newPolicy: boolean): SchedulerProjection {
  const projection = rebuildSchedulerProjection([initial]);
  if (newPolicy) projection.planningPolicyVersion = 1;
  projection.tasks = { T1: task };
  projection.delivery = {
    reviews: { T1: review }, reviewHistory: {}, authorModelIdentities: {},
    boundaries: {}, taskAcceptances: {}, phaseAcceptances: {},
  };
  return projection;
}

function decidedEvent(payload: Record<string, unknown>): SchedulerEvent {
  return {
    ...initial, eventId: "decided", sequence: 2, type: "review.decided",
    actor: { role: "architect", id: ACTOR }, idempotencyKey: "decided",
    payload: { taskId: "T1", summary: "Architect decision.", evidenceArtifactHashes: [], ...payload },
  };
}

function proof(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    toolName: "inspect_evidence",
    invocationKey: `${RUN}\0${SESSION}\0call-1`,
    completedSequence: 5,
    ...entry,
  };
}

// --- A. Prefill derivation. ---

test("W3 review_task exposes the exact runner-owned prefill derived from the completed review", () => {
  const review = reviewFixture({
    claimVerdicts: [
      { claimId: "claim:c1", claim: "Criterion c1 is satisfied.", status: "verified", rationale: "Saw the test pass.", citations: [{ evidenceId: "ev-1" }] },
      { claimId: "claim:c2", claim: "Criterion c2 is satisfied.", status: "unverified", rationale: "Guard unproven." },
      { claimId: "claim:summary", claim: "Summary.", status: "verified", rationale: "Reads well." },
    ],
    satisfied: false,
  });
  const prefill = deriveReviewTaskPrefill({ task: taskFixture(), review });
  assert.deepEqual(prefill, {
    taskId: "T1",
    reviewId: "review_T1",
    submissionAttempt: 1,
    changeSetId: "changeset_T1",
    reviewSatisfied: false,
    openBlockingFindingIds: [],
    criteria: [
      {
        criterionId: "c1",
        claimId: "claim:c1",
        prefilledVerdict: "satisfied",
        prefilledEvidenceIds: ["ev-1"],
        reviewerStatus: "verified",
        reviewerRationale: "Saw the test pass.",
        reviewerCitations: [{ evidenceId: "ev-1" }],
        mechanicalLabel: "verified",
        mechanicalReason: "Mechanical fields match.",
      },
      {
        criterionId: "c2",
        claimId: "claim:c2",
        prefilledVerdict: "unsatisfied",
        prefilledEvidenceIds: ["ev-2"],
        reviewerStatus: "unverified",
        reviewerRationale: "Guard unproven.",
        reviewerCitations: [],
        mechanicalLabel: "verified",
        mechanicalReason: "Mechanical fields match.",
      },
    ],
  });
});

test("W3 the mechanical floor wins over reviewer prose in the prefill", () => {
  const review = reviewFixture({
    claims: [
      { id: "claim:c1", text: "c1.", evidenceIds: ["ev-1"], mechanical: { label: "unverified_claim", reason: "Exit 1." } },
      { id: "claim:c2", text: "c2.", evidenceIds: ["ev-2"], mechanical: { label: "verified", reason: "Match." } },
      { id: "claim:summary", text: "Summary.", evidenceIds: [], mechanical: { label: "reviewer_judgement", reason: "Freeform." } },
    ],
  });
  const prefill = deriveReviewTaskPrefill({ task: taskFixture(), review });
  assert.equal(prefill?.criteria.find((entry) => entry.criterionId === "c1")?.prefilledVerdict, "unsatisfied");
  assert.equal(prefill?.criteria.find((entry) => entry.criterionId === "c2")?.prefilledVerdict, "satisfied");
});

test("W3 prefill is absent without a completed, current, labeled review", () => {
  const task = taskFixture();
  const review = reviewFixture();
  assert.equal(deriveReviewTaskPrefill({ task, review: undefined }), undefined);
  assert.equal(deriveReviewTaskPrefill({ task, review: { ...review, stage: "report_delivered" } }), undefined);
  assert.equal(deriveReviewTaskPrefill({ task, review: { ...review, submissionAttempt: 2 } }), undefined);
  assert.equal(deriveReviewTaskPrefill({ task, review: { ...review, changeSetId: "changeset_other" } }), undefined);
  assert.equal(deriveReviewTaskPrefill({ task: { ...task, changeSetId: undefined }, review }), undefined);
  const unlabeled = reviewFixture({
    claims: [
      { id: "claim:c1", text: "c1.", evidenceIds: ["ev-1"] },
      { id: "claim:c2", text: "c2.", evidenceIds: ["ev-2"] },
      { id: "claim:summary", text: "Summary.", evidenceIds: [] },
    ],
  });
  assert.equal(deriveReviewTaskPrefill({ task, review: unlabeled }), undefined);
  const missingVerdict = reviewFixture({
    claimVerdicts: [
      { claimId: "claim:c1", claim: "c1.", status: "verified", rationale: "Confirmed." },
      { claimId: "claim:summary", claim: "Summary.", status: "verified", rationale: "Reads well." },
    ],
  });
  const partial = deriveReviewTaskPrefill({ task, review: missingVerdict });
  assert.deepEqual(partial?.criteria.map((entry) => entry.criterionId), ["c1"]);
});

test("W3 verdict deviations distinguish confirms, downgrades, and upgrades", () => {
  const prefill = deriveReviewTaskPrefill({ task: taskFixture(), review: reviewFixture() });
  assert.deepEqual(
    diffReviewTaskVerdicts(prefill, [
      { criterionId: "c1", verdict: "satisfied" },
      { criterionId: "c2", verdict: "unsatisfied" },
      { criterionId: "cX", verdict: "satisfied" },
    ]),
    [
      { criterionId: "c1", prefilled: "satisfied", submitted: "satisfied", deviates: false, upgrades: false },
      { criterionId: "c2", prefilled: "satisfied", submitted: "unsatisfied", deviates: true, upgrades: false },
      { criterionId: "cX", prefilled: undefined, submitted: "satisfied", deviates: false, upgrades: false },
    ],
  );
  assert.deepEqual(
    diffReviewTaskVerdicts(undefined, [{ criterionId: "c1", verdict: "satisfied" }]),
    [{ criterionId: "c1", prefilled: undefined, submitted: "satisfied", deviates: false, upgrades: false }],
  );
});

// --- B. Kernel review.decided: confirm and override. ---

test("W3 confirming the unchanged prefill succeeds with no override reason and no reads", () => {
  const projection = projectionWith(taskFixture(), reviewFixture(), true);
  const next = reduceSchedulerEvent(projection, decidedEvent({
    decision: "approved",
    criterionVerdicts: [
      { criterionId: "c1", verdict: "satisfied", rationale: "Confirming the independent review.", evidenceIds: ["ev-1"] },
      { criterionId: "c2", verdict: "satisfied", rationale: "Confirming the independent review.", evidenceIds: ["ev-2"] },
    ],
  }));
  assert.equal(next.tasks.T1?.status, "approved");
  assert.deepEqual(next.reviews.T1?.criterionVerdicts?.map((verdict) => verdict.overrideReason), [undefined, undefined]);
});

test("W3 changing a prefilled criterion verdict without a reason is refused", () => {
  const projection = projectionWith(taskFixture(), reviewFixture(), true);
  assert.throws(
    () => reduceSchedulerEvent(projection, decidedEvent({
      decision: "rejected",
      criterionVerdicts: [
        { criterionId: "c1", verdict: "satisfied", rationale: "Confirming.", evidenceIds: ["ev-1"] },
        { criterionId: "c2", verdict: "unsatisfied", rationale: "I disagree.", evidenceIds: ["ev-2"] },
      ],
    })),
    /override reason is required/,
  );
  // A downgrade with a reason and no reads succeeds.
  const next = reduceSchedulerEvent(projection, decidedEvent({
    decision: "rejected",
    criterionVerdicts: [
      { criterionId: "c1", verdict: "satisfied", rationale: "Confirming.", evidenceIds: ["ev-1"] },
      { criterionId: "c2", verdict: "unsatisfied", rationale: "The guard is missing.", evidenceIds: ["ev-2"], overrideReason: "Re-reading the criterion, the guard was never shown." },
    ],
  }));
  assert.equal(next.tasks.T1?.status, "rejected");
  assert.equal(next.reviews.T1?.criterionVerdicts?.find((verdict) => verdict.criterionId === "c2")?.overrideReason, "Re-reading the criterion, the guard was never shown.");
});

test("W3 an unverified to verified override without a same-session read is refused", () => {
  const review = reviewFixture({
    claimVerdicts: [
      { claimId: "claim:c1", claim: "c1.", status: "unverified", rationale: "Unproven." },
      { claimId: "claim:c2", claim: "c2.", status: "unverified", rationale: "Unproven." },
      { claimId: "claim:summary", claim: "Summary.", status: "verified", rationale: "Reads well." },
    ],
    satisfied: false,
  });
  const projection = projectionWith(taskFixture(), review, true);
  assert.throws(
    () => reduceSchedulerEvent(projection, decidedEvent({
      decision: "rejected",
      criterionVerdicts: [
        { criterionId: "c1", verdict: "satisfied", rationale: "Actually fine.", evidenceIds: ["ev-1"], overrideReason: "The evidence shows it." },
        { criterionId: "c2", verdict: "unsatisfied", rationale: "Still open.", evidenceIds: ["ev-2"] },
      ],
    })),
    /has not read the cited evidence/,
  );
});

test("W3 the same override succeeds with a well-formed same-session read proof", () => {
  const review = reviewFixture({
    claimVerdicts: [
      { claimId: "claim:c1", claim: "c1.", status: "unverified", rationale: "Unproven." },
      { claimId: "claim:c2", claim: "c2.", status: "unverified", rationale: "Unproven." },
      { claimId: "claim:summary", claim: "Summary.", status: "verified", rationale: "Reads well." },
    ],
    satisfied: false,
  });
  const projection = projectionWith(taskFixture(), review, true);
  const next = reduceSchedulerEvent(projection, decidedEvent({
    decision: "rejected",
    criterionVerdicts: [
      { criterionId: "c1", verdict: "satisfied", rationale: "Read the passing run.", evidenceIds: ["ev-1"], overrideReason: "The reviewer missed the green run I read.", overrideReadProof: [proof({ evidenceId: "ev-1" })] },
      { criterionId: "c2", verdict: "unsatisfied", rationale: "Still open.", evidenceIds: ["ev-2"] },
    ],
  }));
  assert.equal(next.tasks.T1?.status, "rejected");
  // A proof for the wrong evidence does not authorize the override.
  assert.throws(
    () => reduceSchedulerEvent(projection, decidedEvent({
      decision: "rejected",
      criterionVerdicts: [
        { criterionId: "c1", verdict: "satisfied", rationale: "Read something else.", evidenceIds: ["ev-1"], overrideReason: "Citing an unread record.", overrideReadProof: [proof({ evidenceId: "ev-2" })] },
        { criterionId: "c2", verdict: "unsatisfied", rationale: "Still open.", evidenceIds: ["ev-2"] },
      ],
    })),
    /has not read the cited evidence: ev-1/,
  );
  // A foreign-session proof is not authority.
  assert.throws(
    () => reduceSchedulerEvent(projection, decidedEvent({
      decision: "rejected",
      criterionVerdicts: [
        { criterionId: "c1", verdict: "satisfied", rationale: "Foreign read.", evidenceIds: ["ev-1"], overrideReason: "Borrowed.", overrideReadProof: [proof({ evidenceId: "ev-1", invocationKey: `${RUN}\0foreign-session\0call-1` })] },
        { criterionId: "c2", verdict: "unsatisfied", rationale: "Still open.", evidenceIds: ["ev-2"] },
      ],
    })),
    /not bound to this Architect session/,
  );
});

test("W3 an override reason without a deviation is refused", () => {
  const projection = projectionWith(taskFixture(), reviewFixture(), true);
  assert.throws(
    () => reduceSchedulerEvent(projection, decidedEvent({
      decision: "approved",
      criterionVerdicts: [
        { criterionId: "c1", verdict: "satisfied", rationale: "Confirming.", evidenceIds: ["ev-1"], overrideReason: "No deviation happened." },
        { criterionId: "c2", verdict: "satisfied", rationale: "Confirming.", evidenceIds: ["ev-2"] },
      ],
    })),
    /without a deviation/,
  );
});

test("W3 unlabeled reviews and legacy runs keep legacy judging", () => {
  const unlabeled = reviewFixture({
    claims: [
      { id: "claim:c1", text: "c1.", evidenceIds: ["ev-1"] },
      { id: "claim:c2", text: "c2.", evidenceIds: ["ev-2"] },
      { id: "claim:summary", text: "Summary.", evidenceIds: [] },
    ],
    claimVerdicts: [
      { claimId: "claim:c1", claim: "c1.", status: "unverified", rationale: "Unproven." },
      { claimId: "claim:c2", claim: "c2.", status: "unverified", rationale: "Unproven." },
      { claimId: "claim:summary", claim: "Summary.", status: "verified", rationale: "Reads well." },
    ],
    satisfied: false,
  });
  // Legacy judging: a satisfied verdict on a reviewer-unverified claim needs
  // no override reason (old logs replay unchanged).
  const next = reduceSchedulerEvent(
    projectionWith(taskFixture(), unlabeled, true),
    decidedEvent({
      decision: "rejected",
      criterionVerdicts: [
        { criterionId: "c1", verdict: "satisfied", rationale: "Legacy judging.", evidenceIds: ["ev-1"] },
        { criterionId: "c2", verdict: "unsatisfied", rationale: "Still open.", evidenceIds: ["ev-2"] },
      ],
    }),
  );
  assert.equal(next.tasks.T1?.status, "rejected");
  // But an override reason with no prefill to override is refused.
  assert.throws(
    () => reduceSchedulerEvent(
      projectionWith(taskFixture(), unlabeled, true),
      decidedEvent({
        decision: "rejected",
        criterionVerdicts: [
          { criterionId: "c1", verdict: "satisfied", rationale: "Legacy.", evidenceIds: ["ev-1"], overrideReason: "Nothing to override." },
          { criterionId: "c2", verdict: "unsatisfied", rationale: "Still open.", evidenceIds: ["ev-2"] },
        ],
      }),
    ),
    /without a deviation/,
  );
  // Non-new-policy runs never consult the prefill either.
  const legacyRun = reduceSchedulerEvent(
    projectionWith(taskFixture(), reviewFixture(), false),
    decidedEvent({
      decision: "approved",
      criterionVerdicts: [
        { criterionId: "c1", verdict: "satisfied", rationale: "Legacy run.", evidenceIds: ["ev-1"] },
        { criterionId: "c2", verdict: "satisfied", rationale: "Legacy run.", evidenceIds: ["ev-2"] },
      ],
    }),
  );
  assert.equal(legacyRun.tasks.T1?.status, "approved");
});

// --- C. Claim dispositions. ---

function unverifiedReview(): DeliveryReviewRecord {
  return reviewFixture({
    claimVerdicts: [
      { claimId: "claim:c1", claim: "c1.", status: "unverified", rationale: "Unproven." },
      { claimId: "claim:c2", claim: "c2.", status: "unverified", rationale: "Unproven." },
      { claimId: "claim:summary", claim: "Summary.", status: "verified", rationale: "Reads well." },
    ],
    satisfied: false,
  });
}

function dispositionVerdicts(): Record<string, unknown>[] {
  return [
    { criterionId: "c1", verdict: "unsatisfied", rationale: "Confirming reviewer.", evidenceIds: ["ev-1"] },
    { criterionId: "c2", verdict: "unsatisfied", rationale: "Confirming reviewer.", evidenceIds: ["ev-2"] },
  ];
}

test("W3 an unverified claim disposition without a same-session read is refused", () => {
  const projection = projectionWith(taskFixture(), unverifiedReview(), true);
  assert.throws(
    () => reduceSchedulerEvent(projection, decidedEvent({
      decision: "rejected",
      criterionVerdicts: dispositionVerdicts(),
      claimDispositions: [{ claimId: "claim:c1", status: "verified", rationale: "Trust me." }],
    })),
    /requires this Architect session .* to have read the cited evidence/,
  );
});

test("W3 the same disposition succeeds with covering same-session read proofs", () => {
  const projection = projectionWith(taskFixture(), unverifiedReview(), true);
  const next = reduceSchedulerEvent(projection, decidedEvent({
    decision: "rejected",
    criterionVerdicts: dispositionVerdicts(),
    claimDispositions: [{ claimId: "claim:c1", status: "verified", rationale: "Read the green run.", readProof: [proof({ evidenceId: "ev-1" })] }],
  }));
  const verdict = next.delivery?.reviews.T1?.claimVerdicts?.find((entry) => entry.claimId === "claim:c1");
  assert.equal(verdict?.disposition?.status, "verified");
  // Malformed proofs fail closed instead of authorizing.
  assert.throws(
    () => reduceSchedulerEvent(projection, decidedEvent({
      decision: "rejected",
      criterionVerdicts: dispositionVerdicts(),
      claimDispositions: [{ claimId: "claim:c1", status: "verified", rationale: "Bad proof.", readProof: [{ toolName: "fs.read" }] }],
    })),
    /invalid Architect read proof/,
  );
});

test("W3 an evidence-less claim disposition needs a complete submitted-diff read", () => {
  const review = reviewFixture({
    claimVerdicts: [
      { claimId: "claim:c1", claim: "c1.", status: "verified", rationale: "Confirmed." },
      { claimId: "claim:c2", claim: "c2.", status: "verified", rationale: "Confirmed." },
      { claimId: "claim:summary", claim: "Summary.", status: "unverified", rationale: "Misleading." },
    ],
    satisfied: false,
  });
  const projection = projectionWith(taskFixture(), review, true);
  const verdicts = [
    { criterionId: "c1", verdict: "satisfied", rationale: "Confirming.", evidenceIds: ["ev-1"] },
    { criterionId: "c2", verdict: "satisfied", rationale: "Confirming.", evidenceIds: ["ev-2"] },
  ];
  assert.throws(
    () => reduceSchedulerEvent(projection, decidedEvent({
      decision: "rejected",
      criterionVerdicts: [
        { criterionId: "c1", verdict: "unsatisfied", rationale: "Downgrade.", evidenceIds: ["ev-1"], overrideReason: "Keeping the rejection honest." },
        verdicts[1],
      ],
      claimDispositions: [{ claimId: "claim:summary", status: "verified", rationale: "Summary is fine." }],
    })),
    /read the complete submitted diff/,
  );
  const next = reduceSchedulerEvent(projection, decidedEvent({
    decision: "rejected",
    criterionVerdicts: [
      { criterionId: "c1", verdict: "unsatisfied", rationale: "Downgrade.", evidenceIds: ["ev-1"], overrideReason: "Keeping the rejection honest." },
      verdicts[1],
    ],
    claimDispositions: [{
      claimId: "claim:summary",
      status: "verified",
      rationale: "Read the full diff; the summary is accurate.",
      readProof: [{ toolName: "artifact.read", invocationKey: `${RUN}\0${SESSION}\0call-9`, completedSequence: 11, artifactHash: DIFF }],
    }],
  }));
  assert.equal(next.delivery?.reviews.T1?.claimVerdicts?.find((entry) => entry.claimId === "claim:summary")?.disposition?.status, "verified");
});

test("W3 unlabeled reviews keep rationale-only dispositions (replay compatibility)", () => {
  const unlabeled = unverifiedReview();
  unlabeled.claims = [
    { id: "claim:c1", text: "c1.", evidenceIds: ["ev-1"] },
    { id: "claim:c2", text: "c2.", evidenceIds: ["ev-2"] },
    { id: "claim:summary", text: "Summary.", evidenceIds: [] },
  ];
  const next = reduceSchedulerEvent(
    projectionWith(taskFixture(), unlabeled, true),
    decidedEvent({
      decision: "rejected",
      criterionVerdicts: dispositionVerdicts(),
      claimDispositions: [{ claimId: "claim:c1", status: "verified", rationale: "Legacy rationale." }],
    }),
  );
  assert.equal(next.delivery?.reviews.T1?.claimVerdicts?.find((entry) => entry.claimId === "claim:c1")?.disposition?.status, "verified");
});

// --- D. Ledger capture: only genuine same-session evidence reads count. ---

test("W3 Architect read capture honors successful same-session evidence reads only", async () => {
  const root = mkdtempSync(join(tmpdir(), "w3-arch-reads-"));
  const ledger = new SqliteToolLedger(join(root, "tools.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const broker = new ToolBroker({ permissionProfile: "guarded", workspacePath: root, ledger, artifacts });
  for (const tool of [...createArtifactTools(artifacts), ...createEvidenceTools({ store: evidence, artifacts, taskId: "T1" })]) broker.register(tool);
  try {
    const output = await artifacts.put(Buffer.from("test output\n"), "text/plain");
    const empty = await artifacts.put(Buffer.alloc(0), "text/plain");
    const unrelated = await artifacts.put(Buffer.from("unrelated bytes\n"), "text/plain");
    const fact: CommandEvidenceFact = {
      kind: "command", label: "tests", command: "node", args: ["--test"], cwd: root,
      startedAt: AT, finishedAt: AT, exitCode: 0, signal: null, timedOut: false, cancelled: false,
      outputTruncated: false, stdoutArtifactHash: output.hash, stderrArtifactHash: empty.hash,
    };
    const own = evidence.record({ runId: RUN, taskId: "T1", actor: { role: "worker", id: "worker:T1:1" }, fact, createdAt: AT, idempotencyKey: "own" });
    evidence.record({ runId: RUN, taskId: "T2", actor: { role: "worker", id: "other" }, fact, createdAt: AT, idempotencyKey: "foreign" });
    let ordinal = 0;
    const invoke = (name: string, args: unknown, sessionId = SESSION, actor: { role: "architect" | "verifier"; id: string } = { role: "architect", id: ACTOR }) =>
      broker.invoke({ type: "tool_call", callId: `arch-${++ordinal}`, name, arguments: args }, { runId: RUN, sessionId, actor });
    const binding = { runId: RUN, sessionId: SESSION, actorId: ACTOR, taskId: "T1" };
    assert.deepEqual(captureArchitectEvidenceReads(ledger, binding, evidence), []);
    // A partial artifact read grants nothing.
    await invoke("artifact.read", { hash: output.hash, maxBytes: 3 });
    assert.deepEqual(captureArchitectEvidenceReads(ledger, binding, evidence), []);
    // A complete artifact read binds its owning evidence.
    await invoke("artifact.read", { hash: output.hash });
    assert.ok(captureArchitectEvidenceReads(ledger, binding, evidence).some(
      (proof) => proof.toolName === "artifact.read" && proof.evidenceId === own.id && proof.artifactHash === output.hash,
    ));
    // A complete read of bytes outside same-task evidence is hash-only.
    await invoke("artifact.read", { hash: unrelated.hash });
    assert.ok(captureArchitectEvidenceReads(ledger, binding, evidence).some(
      (proof) => proof.toolName === "artifact.read" && proof.evidenceId === undefined && proof.artifactHash === unrelated.hash,
    ));
    // A failed read grants nothing.
    await invoke("artifact.read", { hash: "0".repeat(64) });
    // Foreign-task facts grant nothing to this task binding.
    await invoke("inspect_evidence", { taskId: "T2" });
    // Failed validation grants nothing.
    await invoke("inspect_evidence", { taskId: "" });
    const beforeInspect = captureArchitectEvidenceReads(ledger, binding, evidence);
    assert.ok(beforeInspect.every((proof) => proof.toolName === "artifact.read"));
    // Foreign session and foreign actor reads grant nothing.
    await invoke("inspect_evidence", { taskId: "T1" }, "foreign-session");
    await invoke("inspect_evidence", { taskId: "T1" }, SESSION, { role: "architect", id: "arch:other" });
    await invoke("inspect_evidence", { taskId: "T1" }, SESSION, { role: "verifier", id: ACTOR });
    assert.deepEqual(captureArchitectEvidenceReads(ledger, binding, evidence), beforeInspect);
    // The genuine same-session inspect binds the evidence.
    await invoke("inspect_evidence", { taskId: "T1" });
    assert.ok(captureArchitectEvidenceReads(ledger, binding, evidence).some(
      (proof) => proof.toolName === "inspect_evidence" && proof.evidenceId === own.id,
    ));
  } finally {
    ledger.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// --- E. Prompt: confirm/override framing replaces the mandatory diff reread. ---

function bareProjection(newPolicy: boolean): SchedulerProjection {
  const projection = rebuildSchedulerProjection([initial]);
  if (newPolicy) projection.planningPolicyVersion = 1;
  return projection;
}

test("W3 new-policy review context confirms the independent review instead of mandating a diff reread", () => {
  const prefill = deriveReviewTaskPrefill({ task: taskFixture(), review: reviewFixture() });
  const sections = architectContextSections({
    limits: { maxBytes: 1024 * 1024, maxEstimatedTokens: 256 * 1024 },
    objective: "Build it.",
    reason: { type: "review_required", taskId: "T1", changeSetId: "changeset_T1" },
    projection: bareProjection(true),
    reviewSubmission: {
      taskId: "T1",
      attempt: 1,
      changeSetId: "changeset_T1",
      baselineRevision: "b".repeat(40),
      taskRevision: "t".repeat(40),
      changedPaths: ["src/value.mjs"],
      diffArtifactHash: DIFF,
      evidenceArtifactHashes: [STDOUT],
      dispositionPrefill: prefill,
    },
    instructions: [],
    skills: [],
    memories: [],
    evidence: [],
    recentHistory: [],
  });
  const current = sections.find((section) => section.id === "current-submission")?.content ?? "";
  assert.match(current, /independent/i);
  assert.match(current, /confirm/i);
  assert.match(current, /override/i);
  assert.match(current, /review_T1/);
  assert.doesNotMatch(current, /artifact\.read/);
  assert.doesNotMatch(current, /Use artifact\.read with diffArtifactHash/);
});

test("W3 legacy review context keeps its exact behavior without a prefill", () => {
  for (const newPolicy of [false, true]) {
    const sections = architectContextSections({
      limits: { maxBytes: 1024 * 1024, maxEstimatedTokens: 256 * 1024 },
      objective: "Build it.",
      reason: { type: "review_required", taskId: "T1", changeSetId: "changeset_T1" },
      projection: bareProjection(newPolicy),
      reviewSubmission: {
        taskId: "T1",
        attempt: 1,
        changeSetId: "changeset_T1",
        baselineRevision: "b".repeat(40),
        taskRevision: "t".repeat(40),
        changedPaths: ["src/value.mjs"],
        diffArtifactHash: DIFF,
        evidenceArtifactHashes: [STDOUT],
      },
      instructions: [],
      skills: [],
      memories: [],
      evidence: [],
      recentHistory: [],
    });
    const current = sections.find((section) => section.id === "current-submission")?.content ?? "";
    assert.match(current, /Review this immutable submitted attempt, not a prior attempt or the project working tree\./);
    assert.match(current, /Use artifact\.read with diffArtifactHash for the authoritative submitted diff\./);
  }
});

// --- F. Audit visibility and citation mapping. ---

test("W3 the acceptance-contract audit projection preserves the override reason", () => {
  const projection = projectionWith(taskFixture(), reviewFixture(), true);
  const next = reduceSchedulerEvent(projection, decidedEvent({
    decision: "rejected",
    criterionVerdicts: [
      { criterionId: "c1", verdict: "satisfied", rationale: "Confirming.", evidenceIds: ["ev-1"] },
      { criterionId: "c2", verdict: "unsatisfied", rationale: "The guard is missing.", evidenceIds: ["ev-2"], overrideReason: "Re-reading the criterion, the guard was never shown." },
    ],
  }));
  const verdicts = acceptanceContractAuditProjection(next).tasks.T1?.criterionVerdicts ?? [];
  assert.equal(
    verdicts.find((verdict) => verdict.criterionId === "c2")?.overrideReason,
    "Re-reading the criterion, the guard was never shown.",
  );
  const confirmed = verdicts.find((verdict) => verdict.criterionId === "c1");
  assert.equal(confirmed?.overrideReason, undefined);
  assert.equal(Object.hasOwn(confirmed ?? {}, "overrideReason"), false);
});

test("W3 reviewer citation evidence maps only to its corresponding criterion", () => {
  const review = reviewFixture({
    claimVerdicts: [
      { claimId: "claim:c1", claim: "c1.", status: "verified", rationale: "Saw it.", citations: [{ evidenceId: "ev-1" }] },
      { claimId: "claim:c2", claim: "c2.", status: "verified", rationale: "Saw it too." },
      { claimId: "claim:summary", claim: "Summary.", status: "verified", rationale: "Reads well." },
    ],
  });
  const prefill = deriveReviewTaskPrefill({ task: taskFixture(), review });
  const c1 = prefill?.criteria.find((entry) => entry.criterionId === "c1");
  const c2 = prefill?.criteria.find((entry) => entry.criterionId === "c2");
  assert.deepEqual(c1?.reviewerCitations, [{ evidenceId: "ev-1" }]);
  assert.deepEqual(c2?.reviewerCitations, []);
  // Submitted links stay per-criterion as well: no evidence fan-out across criteria.
  assert.deepEqual(c1?.prefilledEvidenceIds, ["ev-1"]);
  assert.deepEqual(c2?.prefilledEvidenceIds, ["ev-2"]);
});

// --- G. Tool path: model input cannot smuggle read authority. ---

const W3_TOOL_RUN = "w3-tool-smuggle";
const W3_TOOL_CLOCK = "2026-10-05T00:00:00.000Z";
const W3_TOOL_DIFF = "d".repeat(64);

function w3ToolEvent(
  type: SchedulerEventType | string,
  key: string,
  actor: { role: SchedulerActorRole; id: string },
  payload: Record<string, unknown>,
): NewSchedulerEvent {
  return { runId: W3_TOOL_RUN, type: type as SchedulerEventType, occurredAt: W3_TOOL_CLOCK, actor, idempotencyKey: key, payload };
}

/** New-policy run through a ready plan, mirroring delivery-acceptance.test.ts planningInputs. */
function w3ToolPlanningEvents(fixture: PlanningFixtureScenario): NewSchedulerEvent[] {
  return [
    w3ToolEvent("run.policy_configured", "policy", { role: "runner", id: "build-runtime" }, { runPolicy: "finish" }),
    w3ToolEvent("planning.policy_configured", "planning-policy", { role: "runner", id: "build-runtime" }, { version: 1 }),
    w3ToolEvent("project_docs.policy_configured", "docs-policy", { role: "runner", id: "build-runtime" }, { version: 1 }),
    w3ToolEvent("planning.source_registered", "source", { role: "user", id: "owner" }, { manifest: fixture.priorManifest }),
    w3ToolEvent("planning.source_amended", "source-amendment", { role: "user", id: "owner" }, { manifest: fixture.manifest }),
    w3ToolEvent("request.triaged", "triage", { role: "architect", id: "architect" }, { decision: "build", rationale: "Build the fixture." }),
    w3ToolEvent("planning.ledger_persisted", "ledger", { role: "architect", id: "architect" }, { id: "ledger", requirements: fixture.requirements, phases: fixture.phases, nonNormativeSections: [] }),
    ...fixture.manifest.sections.map((section) => w3ToolEvent("planning.source_section_read", `read:${section.id}`, { role: "architect", id: "architect" }, { manifestId: fixture.manifest.manifestId, manifestDigest: fixture.manifest.artifactDigest, sectionId: section.id, sectionDigest: section.digest, readAt: "2026-09-25T00:00:01.000Z" })),
    w3ToolEvent("planning.plan_drafted", "plan", { role: "architect", id: "architect" }, { revision: fixture.revision, expectedRevisionId: null, expectedDigest: null }),
    w3ToolEvent("planning.coverage_review_requested", "coverage-request", { role: "architect", id: "architect" }, { reviewId: fixture.coverageReview.id, planRevisionId: fixture.revision.revisionId, planRevisionDigest: fixture.revision.digest, sourceManifestId: fixture.manifest.manifestId, requestedAt: "2026-09-25T00:00:02.000Z" }),
    w3ToolEvent("planning.coverage_obligations_recorded", "coverage-obligations", { role: "verifier", id: "coverage-reviewer" }, { reviewId: fixture.coverageReview.id, sourceManifestId: fixture.manifest.manifestId, sourceManifestDigest: fixture.manifest.artifactDigest, obligations: fixture.coverageReview.derivedObligations, sectionCoverage: fixture.manifest.sections.map((section) => ({ sectionId: section.id, obligationIds: fixture.coverageReview.derivedObligations.map((obligation) => obligation.id) })), recordedAt: "2026-09-25T00:00:03.000Z" }),
    w3ToolEvent("planning.coverage_plan_delivered", "coverage-plan", { role: "runner", id: "build-runtime" }, { reviewId: fixture.coverageReview.id, planRevisionId: fixture.revision.revisionId, planRevisionDigest: fixture.revision.digest, sourceManifestId: fixture.manifest.manifestId, deliveredAt: "2026-09-25T00:00:04.000Z" }),
    w3ToolEvent("planning.coverage_review_recorded", "coverage-review", { role: "verifier", id: "coverage-reviewer" }, { review: fixture.coverageReview }),
    w3ToolEvent("planning.plan_ready", "ready", { role: "runner", id: "build-runtime" }, { hostCapabilities: fixture.hostCapabilities }),
  ];
}

/** Depth that satisfies the kernel's tier gate, mirroring support/delivery-seed.ts. */
function w3ToolDepthForTier(tier: string): Record<string, unknown> {
  if (tier !== "high") return { inspectionToolCalls: 1 };
  return {
    inspectionToolCalls: 1,
    affectedTests: {
      executedScope: "full_test_script",
      selectionRung: "seed",
      changedFiles: ["src/feature.ts"],
      selectedTests: ["test/feature.test.ts"],
      fullSuiteCount: 1,
      command: "seed",
      args: [],
      evidenceIds: [],
      exitCode: null,
      outcome: "unknown",
      report: { status: "unknown", runner: "seed" },
    },
    probe: {
      rung: "seed",
      mutantsGenerated: 0,
      mutantsExecuted: 0,
      mutantsCaught: 0,
      survivors: [],
      partial: true,
      evidenceIds: [],
      notes: ["seeded high-tier depth"],
    },
  };
}

/**
 * Completed labeled review for a submitted task, mirroring
 * support/delivery-seed.ts but with mechanical claims: every criterion claim
 * carries its submitted evidence and a verified label, and the reviewer marks
 * each one unverified (a seeded miss the Architect may only override after a
 * genuine same-session read).
 */
function seedW3ToolLabeledReview(
  store: SqliteSchedulerStore,
  taskId: string,
  criterionEvidenceId: string,
): string {
  let projection = rebuildSchedulerProjection(store.readRun(W3_TOOL_RUN));
  const task = projection.tasks[taskId]!;
  const authorRuntimeId = "w3-tool-author";
  const append = (type: string, key: string, actor: NewSchedulerEvent["actor"], payload: Record<string, unknown>) =>
    store.append({ runId: W3_TOOL_RUN, type: type as NewSchedulerEvent["type"], occurredAt: W3_TOOL_CLOCK, actor, idempotencyKey: key, payload });
  if (!projection.runtime.workerAssignments[`${taskId}:${task.attempt}`]) {
    append("worker.runtime_assigned", `seed-author:${taskId}:${task.attempt}`, { role: "runner", id: "runtime-router" }, {
      taskId, attempt: task.attempt, runtimeId: authorRuntimeId, sessionId: `seed-session:${taskId}:${task.attempt}`,
    });
    projection = rebuildSchedulerProjection(store.readRun(W3_TOOL_RUN));
  }
  const author = projection.runtime.workerAssignments[`${taskId}:${task.attempt}`]!.runtimeId;
  const reviewId = deliveryReviewId(taskId, task.attempt, 1);
  const criteriaIds = (task.acceptanceCriteria ?? []).map((criterion) => criterion.id);
  const runner = { role: "runner" as const, id: "delivery-review-runtime" };
  const reviewerRuntimeId = "w3-tool-reviewer";
  const reviewer = { role: "verifier" as const, id: reviewerRuntimeId };
  append("delivery.review_started", `${reviewId}:started`, runner, {
    taskId, reviewId, generation: 1, attempt: task.attempt, changeSetId: task.changeSetId,
    diffArtifactHash: W3_TOOL_DIFF, criteriaIds,
    authorRuntimeId: author, authorModelIdentity: `${author}-model`.toLowerCase().replaceAll(":", "-"),
    architectRuntimeId: projection.runtime.architect.runtimeId ?? "architect_1",
    architectModelIdentity: "w3-tool-architect-model",
  });
  const riskInput = {
    authorModelId: `${author}-model`.toLowerCase().replaceAll(":", "-"),
    changedFiles: ["src/feature.ts"],
    linesAdded: 3,
    linesRemoved: 1,
    attempts: task.attempt,
    acceptedFailuresUsed: false,
  };
  const risk = assessDeliveryRisk(riskInput);
  append("delivery.review_requested", `${reviewId}:requested`, runner, {
    taskId, reviewId, reviewerRuntimeId, reviewerModelIdentity: "w3-tool-reviewer-model",
    independence: "distinct_model", reviewTier: risk.tier, riskDigest: risk.digest, riskInput,
  });
  if (risk.tier === "high") {
    append("delivery.obligations_recorded", `${reviewId}:obligations`, reviewer, {
      taskId, reviewId, sessionId: `${reviewId}:obligations`, obligations: [{ id: "o1", description: "Meet the criteria." }],
    });
  }
  append("delivery.criteria_and_diff_delivered", `${reviewId}:diff`, runner, { taskId, reviewId, diffArtifactHash: W3_TOOL_DIFF });
  append("delivery.findings_recorded", `${reviewId}:findings`, reviewer, {
    taskId, reviewId, sessionId: `${reviewId}:findings`, findings: [], depth: w3ToolDepthForTier(risk.tier),
  });
  append("delivery.report_delivered", `${reviewId}:report`, runner, {
    taskId, reviewId,
    claims: [
      ...criteriaIds.map((id) => ({ id: `claim:${id}`, text: `Criterion ${id} is satisfied.`, evidenceIds: [criterionEvidenceId], mechanical: { label: "verified", reason: "Seeded green command evidence." } })),
      { id: "claim:summary", text: "Implemented.", evidenceIds: [], mechanical: { label: "reviewer_judgement", reason: "Freeform summary." } },
    ],
  });
  append("delivery.review_recorded", `${reviewId}:verdict`, reviewer, {
    taskId, reviewId, sessionId: `${reviewId}:verdict`, summary: "Reviewed.", satisfied: false,
    claimVerdicts: [
      ...criteriaIds.map((id) => ({ claimId: `claim:${id}`, status: "unverified", rationale: "Seeded miss: the green run does cover the criterion." })),
      { claimId: "claim:summary", status: "verified", rationale: "Summary reads well." },
    ],
  });
  return reviewId;
}

test("W3 model-supplied read proofs cannot authorize an unverified to verified override", async () => {
  const root = mkdtempSync(join(tmpdir(), "w3-tool-smuggle-"));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore: evidence, artifacts });
  // No reads are ever recorded: there is no genuine Architect-session read authority.
  const ledger = new SqliteToolLedger(join(root, "tools.sqlite"));
  try {
    const base = buildPlanningFixtureScenario();
    const fixture: PlanningFixtureScenario = {
      ...base,
      manifest: {
        ...base.manifest,
        amendment: {
          ...base.manifest.amendment!,
          recordedImpact: { addsSectionIds: ["s8"], retiresSectionIds: ["s7"], addsRequirementIds: [], retiresRequirementIds: ["REQ-RETIRED"] },
        },
      },
    };
    for (const input of w3ToolPlanningEvents(fixture)) store.append(input);
    // The ready plan waits for its explicit owner start. The test acts as
    // owner through the genuine authorization event, covering the kernel's
    // own current ready identity (mirrors w1-review-economics; no authority
    // is seeded or invented: the identity is read from the real projection).
    const startIdentity = currentExplicitStartIdentity(rebuildSchedulerProjection(store.readRun(W3_TOOL_RUN)));
    assert.ok(startIdentity, "the fixture plan is ready with a complete start identity");
    store.append(w3ToolEvent("planning.execution_authorized", "owner-start", { role: "user", id: "local-user" }, { authorization: { ...startIdentity!, version: 1, ownerChoice: "execute" } }));
    // The kernel verifies the current source artifact authority from the
    // real bytes: the exact fixture bytes hash to the manifest digest.
    const stored = await artifacts.put(Buffer.from(FIXTURE_AMENDED_TEXT, "utf8"), "text/plain", "w3 approved source");
    assert.equal(stored.hash, fixture.manifest.artifactDigest, "the stored source bytes are the manifest authority");
    const fact: CommandEvidenceFact = {
      kind: "command", label: "tests", command: "node", args: ["--test"], cwd: root,
      startedAt: W3_TOOL_CLOCK, finishedAt: W3_TOOL_CLOCK, exitCode: 0, signal: null, timedOut: false, cancelled: false,
      outputTruncated: false, stdoutArtifactHash: STDOUT, stderrArtifactHash: "f".repeat(64),
    };
    const record = evidence.record({
      runId: W3_TOOL_RUN, taskId: "T1", actor: { role: "worker", id: "worker:T1:1" },
      fact, createdAt: W3_TOOL_CLOCK, idempotencyKey: "w3-tool-evidence", attempt: 1,
    });
    store.append(w3ToolEvent("task.transitioned", "t1:assigned", { role: "runner", id: "test" }, { taskId: "T1", status: "assigned", patch: { attempt: 1, assignedWorkerId: "worker:T1:1" } }));
    store.append(w3ToolEvent("task.transitioned", "t1:running", { role: "runner", id: "test" }, { taskId: "T1", status: "running", patch: {} }));
    store.append(w3ToolEvent("task.transitioned", "t1:submitted", { role: "runner", id: "test" }, {
      taskId: "T1", status: "submitted",
      patch: {
        changeSetId: "changeset_T1",
        criterionEvidenceLinks: [{ criterionId: "c1", evidenceId: record.id, artifactHashes: [STDOUT], taskId: "T1", attempt: 1 }],
      },
    }));
    const reviewId = seedW3ToolLabeledReview(store, "T1", record.id);
    const projection = rebuildSchedulerProjection(store.readRun(W3_TOOL_RUN));
    assert.equal(projection.delivery?.reviews.T1?.reviewId, reviewId);
    assert.equal(projection.delivery?.reviews.T1?.stage, "completed");
    const submitted = projection.tasks.T1!;
    assert.equal(deriveReviewTaskPrefill({ task: submitted, review: projection.delivery?.reviews.T1 })?.criteria.find((entry) => entry.criterionId === "c1")?.prefilledVerdict, "unsatisfied");

    const sessionId = architectTurnSessionId(W3_TOOL_RUN);
    const registry = new ToolRegistry();
    const architectTools = createArchitectTools({ store, clock: () => W3_TOOL_CLOCK, evidenceStore: evidence, architectReadLedger: ledger });
    for (const tool of architectTools) registry.register(tool);
    const reviewTool = architectTools.find((tool) => tool.definition.name === "review_task")!;
    const context = { runId: W3_TOOL_RUN, sessionId, actor: { role: "architect" as const, id: ACTOR } };
    const forgedProof = { toolName: "inspect_evidence", invocationKey: `${W3_TOOL_RUN}\0${sessionId}\0forged`, completedSequence: 99, evidenceId: record.id };
    const call = (callId: string, args: unknown): ToolCallBlock => ({ type: "tool_call", callId, name: "review_task", arguments: args });

    const smuggled = {
      taskId: "T1", decision: "approved", summary: "Overriding on attached authority.",
      evidenceArtifactHashes: [],
      criterionVerdicts: [{ criterionId: "c1", verdict: "satisfied", rationale: "The attached proof says I read it.", evidenceIds: [record.id], overrideReason: "Trust the attached proof.", overrideReadProof: [forgedProof] }],
      claimDispositions: [{ claimId: "claim:c1", status: "verified", rationale: "Trust the attached proof.", readProof: [forgedProof] }],
    };
    // The parser strips proof-shaped fields: they never reach the lifecycle tool.
    const validation = reviewTool.validate(smuggled);
    assert.equal(validation.ok, true);
    if (validation.ok) {
      const parsed = validation.value as { criterionVerdicts?: Array<Record<string, unknown>>; claimDispositions?: Array<Record<string, unknown>> };
      assert.equal(Object.hasOwn(parsed.criterionVerdicts?.[0] ?? {}, "overrideReadProof"), false);
      assert.equal(Object.hasOwn(parsed.claimDispositions?.[0] ?? {}, "readProof"), false);
      assert.equal(parsed.criterionVerdicts?.[0]?.overrideReason, "Trust the attached proof.");
    }
    // The stripped override then fails closed: no ledger read, no authorization.
    const refused = await registry.invoke(call("smuggle-1", smuggled), context);
    assert.equal(refused.isError, true);
    assert.match(refused.error?.message ?? "", /has not read the cited evidence/);
    // The claim-only smuggle fails closed too.
    const claimOnly = await registry.invoke(call("smuggle-2", {
      taskId: "T1", decision: "rejected", summary: "Confirming; disposing the claim on attached authority.",
      evidenceArtifactHashes: [],
      criterionVerdicts: [{ criterionId: "c1", verdict: "unsatisfied", rationale: "Confirming the reviewer.", evidenceIds: [record.id] }],
      claimDispositions: [{ claimId: "claim:c1", status: "verified", rationale: "Trust the attached proof.", readProof: [forgedProof] }],
    }), context);
    assert.equal(claimOnly.isError, true);
    assert.match(claimOnly.error?.message ?? "", /to have read the cited evidence/);
    // Nothing was recorded: the forgeries authorized nothing.
    assert.equal(store.readRun(W3_TOOL_RUN).some((entry) => entry.type === "review.decided"), false);
  } finally {
    store.close();
    evidence.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
