import assert from "node:assert/strict";
import test from "node:test";
import { rebuildSchedulerProjection, reduceSchedulerEvent, type SchedulerEvent, type SchedulerProjection } from "../src/scheduler-store.js";
import type { DeliveryReviewRecord } from "../src/delivery-acceptance.js";

const initial: SchedulerEvent = { runId: "e5-proof", eventId: "init", sequence: 1, type: "run.initialized", occurredAt: "2026-10-04T00:00:00Z", actor: { role: "runner", id: "build-runtime" }, idempotencyKey: "init", payload: {} };
function fixture(active: boolean, stage: DeliveryReviewRecord["stage"]): SchedulerProjection {
  const p = rebuildSchedulerProjection([initial]); p.planningPolicyVersion = 1;
  if (active) Object.assign(p, { reviewEvidencePolicyVersion: 1 });
  const review: DeliveryReviewRecord = {
    taskId: "T1", reviewId: "review_T1", generation: 1, submissionAttempt: 1, changeSetId: "changeset_T1", diffArtifactHash: "a".repeat(64), criteriaIds: ["c1"],
    authorRuntimeId: "work:author", authorModelIdentity: "author", architectRuntimeId: "arch:architect", architectModelIdentity: "architect",
    stage, startedSequence: 1, reviewerRuntimeId: "rev:reviewer", reviewerModelIdentity: "reviewer", independence: "distinct_model",
    risk: { tier: "medium", score: 2, digest: "b".repeat(64), signals: [] }, sessionIds: [],
    claims: [{ id: "claim:c1", text: "Value is delivered.", evidenceIds: ["evidence-1"] }], findings: [],
  };
  if (active) Object.assign(review, { reviewEvidencePolicyVersion: 1 });
  p.delivery = { reviews: { T1: review }, reviewHistory: {}, authorModelIdentities: {}, boundaries: {}, taskAcceptances: {}, phaseAcceptances: {} };
  return p;
}
function event(type: SchedulerEvent["type"], payload: Record<string, unknown>): SchedulerEvent {
  return { ...initial, eventId: "next", sequence: 2, type, actor: { role: "verifier", id: "rev:reviewer" }, idempotencyKey: "next", payload: { taskId: "T1", reviewId: "review_T1", sessionId: "verdict-session", ...payload } };
}

test("E5 fresh activation is recorded while historical initialization retains absent shape", () => {
  assert.equal(Object.hasOwn(rebuildSchedulerProjection([initial]), "reviewEvidencePolicyVersion"), false);
  const active = rebuildSchedulerProjection([{ ...initial, payload: { reviewEvidencePolicyVersion: 1 } }]) as SchedulerProjection & { reviewEvidencePolicyVersion?: number };
  assert.equal(active.reviewEvidencePolicyVersion, 1);
});

test("E5 probe survivors cannot disappear when a reviewer returns no findings", () => {
  const findings = event("delivery.findings_recorded", { findings: [], depth: { inspectionToolCalls: 1,
    probe: { rung: "builtin_mutator", mutantsGenerated: 1, mutantsExecuted: 1, mutantsCaught: 0, survivors: ["mutant1 src/value.ts:1: > -> >="], partial: false, evidenceIds: ["probe-evidence-1"], notes: [] } } });
  assert.deepEqual(reduceSchedulerEvent(fixture(false, "diff_delivered"), findings).delivery!.reviews.T1!.findings, []);
  const active = reduceSchedulerEvent(fixture(true, "diff_delivered"), findings);
  assert.ok(active.delivery!.reviews.T1!.findings!.some((finding) => finding.severity === "blocking"), "An undispositioned survivor must be a blocking mechanical finding.");
});

test("E5 verified claims require a citation actually read in the reviewing session", () => {
  const verdict = event("delivery.review_recorded", { summary: "Done", satisfied: true, claimVerdicts: [{ claimId: "claim:c1", status: "verified", rationale: "I believe it is complete." }] });
  assert.equal(reduceSchedulerEvent(fixture(false, "report_delivered"), verdict).delivery!.reviews.T1!.satisfied, true);
  assert.throws(() => reduceSchedulerEvent(fixture(true, "report_delivered"), verdict), /citation|read|inspection/i);
});
