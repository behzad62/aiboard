import assert from "node:assert/strict";
import test from "node:test";
import {
  deliveryClaimsFromSubmission,
  type DeliveryClaim,
} from "../src/delivery-acceptance.js";
import {
  reduceSchedulerEvent,
  rebuildSchedulerProjection,
  type SchedulerEvent,
  type SchedulerProjection,
} from "../src/scheduler-store.js";
import type { DeliveryReviewRecord } from "../src/delivery-acceptance.js";
import type { CriterionEvidenceLink } from "../src/acceptance-contracts.js";
import type { CommandEvidenceFact, EvidenceRecord } from "../src/evidence-store.js";

// W3 (AR-R29/AR-3, S3 L2): mechanical claim labels via decideUnverifiedClaim
// plus the kernel floor that refuses a reviewer `verified` on a mechanically
// `unverified_claim` claim. Pure labeler plus reducer tests; no seeded
// authority beyond the durable records the labeler reads.

const RUN = "w3-labels";
const TASK = "T1";
const AT = "2026-10-05T00:00:00.000Z";
const STDOUT = "a".repeat(64);
const STDERR = "b".repeat(64);
const TREE = "c".repeat(40);
const REVISION = "d".repeat(40);

function commandFact(overrides: Partial<CommandEvidenceFact> = {}): CommandEvidenceFact {
  return {
    kind: "command",
    label: "tests",
    command: "node",
    args: ["--test"],
    cwd: "/work",
    startedAt: AT,
    finishedAt: AT,
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    outputTruncated: false,
    stdoutArtifactHash: STDOUT,
    stderrArtifactHash: STDERR,
    repositoryRevision: REVISION,
    ...overrides,
  };
}

function record(id: string, fact: CommandEvidenceFact | EvidenceRecord["fact"]): EvidenceRecord {
  return {
    id,
    runId: RUN,
    taskId: TASK,
    actor: { role: "worker", id: "worker:T1:1" },
    status: "observed",
    fact,
    createdAt: AT,
    idempotencyKey: `w3:${id}`,
    attempt: 1,
  };
}

function link(
  criterionId: string,
  evidenceId: string,
  overrides: Partial<CriterionEvidenceLink> = {},
): CriterionEvidenceLink {
  return {
    criterionId,
    evidenceId,
    artifactHashes: [STDOUT],
    taskId: TASK,
    attempt: 1,
    freshness: { status: "current", submittedTreeId: TREE, evidenceTreeId: TREE },
    ...overrides,
  };
}

function claimsFor(
  links: readonly CriterionEvidenceLink[],
  records: readonly EvidenceRecord[],
): DeliveryClaim[] {
  return deliveryClaimsFromSubmission({
    summary: "Worker summary.",
    criteria: [{ id: "c1", text: "The value module works." }],
    links,
    evidenceById: new Map(records.map((entry) => [entry.id, entry] as const)),
  });
}

function labelOf(claims: readonly DeliveryClaim[], id: string): string | undefined {
  return claims.find((claim) => claim.id === id)?.mechanical?.label;
}

test("W3 matching command evidence is mechanically verified; the summary stays reviewer judgement", () => {
  const claims = claimsFor([link("c1", "ev-1")], [record("ev-1", commandFact())]);
  assert.equal(labelOf(claims, "claim:c1"), "verified");
  assert.equal(labelOf(claims, "claim:summary"), "reviewer_judgement");
  assert.match(claims.find((claim) => claim.id === "claim:c1")?.mechanical?.reason ?? "", /.+/);
});

test("W3 failed-exit evidence is unverified_claim", () => {
  for (const fact of [
    commandFact({ exitCode: 1 }),
    commandFact({ exitCode: null, signal: "SIGKILL" }),
    commandFact({ exitCode: 0, signal: "SIGTERM" }),
    commandFact({ exitCode: null, timedOut: true }),
    commandFact({ exitCode: null, cancelled: true }),
  ]) {
    const claims = claimsFor([link("c1", "ev-1")], [record("ev-1", fact)]);
    assert.equal(labelOf(claims, "claim:c1"), "unverified_claim");
  }
});

test("W3 mismatched artifact binding is unverified_claim", () => {
  const claims = claimsFor(
    [link("c1", "ev-1", { artifactHashes: ["f".repeat(64)] })],
    [record("ev-1", commandFact())],
  );
  assert.equal(labelOf(claims, "claim:c1"), "unverified_claim");
});

test("W3 missing evidence is unverified_claim", () => {
  const claims = claimsFor([link("c1", "ev-missing")], [record("ev-1", commandFact())]);
  assert.equal(labelOf(claims, "claim:c1"), "unverified_claim");
});

test("W3 stale or missing revision binding is unverified_claim", () => {
  const stale = claimsFor(
    [link("c1", "ev-1", { freshness: { status: "stale", submittedTreeId: TREE, evidenceTreeId: "e".repeat(40), reason: "taken before later edits" } })],
    [record("ev-1", commandFact())],
  );
  assert.equal(labelOf(stale, "claim:c1"), "unverified_claim");
  const unknown = claimsFor(
    [link("c1", "ev-1", { freshness: { status: "unknown", reason: "working-tree identity unavailable" } })],
    [record("ev-1", commandFact())],
  );
  assert.equal(labelOf(unknown, "claim:c1"), "unverified_claim");
  const missingFreshness = claimsFor(
    [link("c1", "ev-1", { freshness: undefined })],
    [record("ev-1", commandFact())],
  );
  assert.equal(labelOf(missingFreshness, "claim:c1"), "unverified_claim");
  const missingRevision = claimsFor(
    [link("c1", "ev-1")],
    [record("ev-1", commandFact({ repositoryRevision: undefined }))],
  );
  assert.equal(labelOf(missingRevision, "claim:c1"), "unverified_claim");
});

test("W3 non-command evidence is reviewer judgement, not fabricated verification", () => {
  const claims = claimsFor(
    [link("c1", "ev-shot", { artifactHashes: ["9".repeat(64)] })],
    [record("ev-shot", {
      kind: "browser_screenshot",
      label: "ui",
      capturedAt: AT,
      screenshotArtifactHash: "9".repeat(64),
      mediaType: "image/png",
      byteLength: 12,
    })],
  );
  assert.equal(labelOf(claims, "claim:c1"), "reviewer_judgement");
});

test("W3 an empty link set never manufactures verification", () => {
  const claims = claimsFor([], [record("ev-1", commandFact())]);
  assert.equal(labelOf(claims, "claim:c1"), "unverified_claim");
});

test("W3 a criterion with multiple links needs every link mechanically verified", () => {
  const bothGreen = deliveryClaimsFromSubmission({
    summary: "Worker summary.",
    criteria: [{ id: "c1", text: "The value module works." }],
    links: [link("c1", "ev-1"), link("c1", "ev-2")],
    evidenceById: new Map([
      ["ev-1", record("ev-1", commandFact())],
      ["ev-2", record("ev-2", commandFact())],
    ]),
  });
  assert.equal(labelOf(bothGreen, "claim:c1"), "verified");
  const oneFailing = deliveryClaimsFromSubmission({
    summary: "Worker summary.",
    criteria: [{ id: "c1", text: "The value module works." }],
    links: [link("c1", "ev-1"), link("c1", "ev-2")],
    evidenceById: new Map([
      ["ev-1", record("ev-1", commandFact())],
      ["ev-2", record("ev-2", commandFact({ exitCode: 3 }))],
    ]),
  });
  assert.equal(labelOf(oneFailing, "claim:c1"), "unverified_claim");
});

test("W3 claims without an evidence map carry no mechanical label (legacy)", () => {
  const claims = deliveryClaimsFromSubmission({
    summary: "Worker summary.",
    criteria: [{ id: "c1", text: "The value module works." }],
    links: [{ criterionId: "c1", evidenceId: "ev-1" }],
  });
  assert.equal(claims.find((claim) => claim.id === "claim:c1")?.mechanical, undefined);
  assert.equal(claims.find((claim) => claim.id === "claim:summary")?.mechanical, undefined);
});

// --- Kernel floor: the reviewer cannot record verified on unverified_claim. ---

const initial: SchedulerEvent = {
  runId: RUN, eventId: "init", sequence: 1, type: "run.initialized",
  occurredAt: AT, actor: { role: "runner", id: "build-runtime" },
  idempotencyKey: "init", payload: {},
};

function reviewFixture(claims: DeliveryClaim[], activeE5: boolean): SchedulerProjection {
  const projection = rebuildSchedulerProjection([initial]);
  projection.planningPolicyVersion = 1;
  if (activeE5) Object.assign(projection, { reviewEvidencePolicyVersion: 1 });
  const review: DeliveryReviewRecord = {
    taskId: TASK, reviewId: "review_T1", generation: 1, submissionAttempt: 1,
    changeSetId: "changeset_T1", diffArtifactHash: "e".repeat(64), criteriaIds: ["c1"],
    authorRuntimeId: "work:author", authorModelIdentity: "author",
    architectRuntimeId: "arch:architect", architectModelIdentity: "architect",
    stage: "report_delivered", startedSequence: 1,
    reviewerRuntimeId: "rev:reviewer", reviewerModelIdentity: "reviewer",
    independence: "distinct_model",
    risk: { tier: "medium", score: 2, digest: "b".repeat(64), signals: [] },
    sessionIds: ["findings-session"], claims, findings: [],
  };
  if (activeE5) {
    Object.assign(review, {
      reviewEvidencePolicyVersion: 1,
      readCapture: {
        runId: RUN, taskId: TASK, reviewId: "review_T1", changeSetId: "changeset_T1",
        submissionAttempt: 1, reviewerRuntimeId: "rev:reviewer", reviewerModelIdentity: "reviewer",
        sessionId: "verdict-session",
        reads: [{
          invocationKey: `${RUN}\0verdict-session\0read-1`, completedSequence: 2,
          toolName: "fs.read", path: "src/value.mjs", startLine: 1, endLine: 4,
        }],
      },
    });
  }
  projection.delivery = {
    reviews: { [TASK]: review }, reviewHistory: {}, authorModelIdentities: {},
    boundaries: {}, taskAcceptances: {}, phaseAcceptances: {},
  };
  return projection;
}

function verdictEvent(claimVerdicts: unknown[], satisfied: boolean): SchedulerEvent {
  return {
    ...initial, eventId: "verdict", sequence: 2, type: "delivery.review_recorded",
    actor: { role: "verifier", id: "rev:reviewer" }, idempotencyKey: "verdict",
    payload: {
      taskId: TASK, reviewId: "review_T1", sessionId: "verdict-session",
      summary: "Reviewed.", satisfied, claimVerdicts,
    },
  };
}

test("W3 the reviewer kernel refuses verified for a mechanically unverified_claim claim", () => {
  const claims = claimsFor(
    [link("c1", "ev-1")],
    [record("ev-1", commandFact({ exitCode: 1 }))],
  );
  assert.equal(labelOf(claims, "claim:c1"), "unverified_claim");
  const projection = reviewFixture(claims, false);
  assert.throws(
    () => reduceSchedulerEvent(projection, verdictEvent([
      { claimId: "claim:c1", status: "verified", rationale: "The prose says it works." },
      { claimId: "claim:summary", status: "verified", rationale: "Summary reads well." },
    ], true)),
    /mechanically labeled unverified_claim/,
  );
  // Staying harsher than the mechanics is always allowed.
  const refused = reduceSchedulerEvent(projection, verdictEvent([
    { claimId: "claim:c1", status: "unverified", rationale: "Exit 1 proves nothing." },
    { claimId: "claim:summary", status: "verified", rationale: "Summary reads well." },
  ], false));
  assert.equal(refused.delivery?.reviews[TASK]?.satisfied, false);
});

test("W3 reviewer judgement labels remain reviewable; the E5 citation rule is intact", () => {
  const verifiedClaims = claimsFor([link("c1", "ev-1")], [record("ev-1", commandFact())]);
  assert.equal(labelOf(verifiedClaims, "claim:c1"), "verified");
  // E5 active: a verified verdict on a verified-labeled claim still needs a
  // same-session citation.
  const active = reviewFixture(verifiedClaims, true);
  assert.throws(
    () => reduceSchedulerEvent(active, verdictEvent([
      { claimId: "claim:c1", status: "verified", rationale: "No citation." },
      { claimId: "claim:summary", status: "verified", rationale: "No citation.", citations: [{ path: "src/value.mjs", line: 2 }] },
    ], true)),
    /citation actually read/,
  );
  const cited = reduceSchedulerEvent(active, verdictEvent([
    { claimId: "claim:c1", status: "verified", rationale: "Read the module.", citations: [{ path: "src/value.mjs", line: 2 }] },
    { claimId: "claim:summary", status: "verified", rationale: "Read the module.", citations: [{ path: "src/value.mjs", line: 3 }] },
  ], true));
  assert.equal(cited.delivery?.reviews[TASK]?.satisfied, true);
  // The mechanical floor binds even when the E5 citation rule is satisfied.
  const failingClaims = claimsFor(
    [link("c1", "ev-1")],
    [record("ev-1", commandFact({ exitCode: 1 }))],
  );
  assert.throws(
    () => reduceSchedulerEvent(reviewFixture(failingClaims, true), verdictEvent([
      { claimId: "claim:c1", status: "verified", rationale: "Read but failed.", citations: [{ path: "src/value.mjs", line: 2 }] },
      { claimId: "claim:summary", status: "verified", rationale: "Read.", citations: [{ path: "src/value.mjs", line: 2 }] },
    ], true)),
    /mechanically labeled unverified_claim/,
  );
});

test("W3 unlabeled legacy claims keep their exact legacy behavior", () => {
  const legacy: DeliveryClaim[] = [
    { id: "claim:c1", text: "Criterion c1 is satisfied.", evidenceIds: ["ev-1"] },
    { id: "claim:summary", text: "Summary.", evidenceIds: [] },
  ];
  const accepted = reduceSchedulerEvent(reviewFixture(legacy, false), verdictEvent([
    { claimId: "claim:c1", status: "verified", rationale: "Legacy prose." },
    { claimId: "claim:summary", status: "verified", rationale: "Legacy prose." },
  ], true));
  assert.equal(accepted.delivery?.reviews[TASK]?.satisfied, true);
});
