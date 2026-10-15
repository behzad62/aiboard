import assert from "node:assert/strict";
import test from "node:test";

import {
  architectContextSections,
  currentSubmissionDiffLines,
  currentSubmissionIntroLines,
  type ArchitectReviewSubmission,
} from "../src/agent-prompts.js";
import { loadArchitectReviewSubmission } from "../src/native-architect-runtime.js";
import type { SchedulerProjection } from "../src/scheduler-store.js";
import type { ValidationScope } from "../src/validation-scope.js";

/**
 * IV-1 (CD-23): the Architect's review context carries the durable
 * validationScope beside the current submission and prefill. No second
 * Architect review pass: W3 "independent review IS the review" stays intact.
 */

function iv1Scope(): ValidationScope {
  return {
    changed: ["src/value.mjs"],
    verified: ["value exports 2"],
    testsRun: [
      {
        command: "node --test test/value.test.mjs",
        counts: { selected: 2, passed: 2, failed: 0, skipped: 0 },
      },
    ],
    notRun: [{ what: "full suite", why: "narrow change with no shared contract touched" }],
  };
}

function iv1SessionsStub(changeSet: unknown): { load: (sessionId: string) => Promise<{ changeSet: unknown }> } {
  return {
    load: async () => ({ changeSet }),
  };
}

function iv1Projection(taskScope?: ValidationScope): SchedulerProjection {
  return {
    status: "running",
    planRevision: 0,
    tasks: {
      T1: {
        id: "T1",
        objective: "Export value 2.",
        dependencies: [],
        status: "submitted",
        requiredCapabilities: [],
        attempt: 1,
        assignedWorkerId: "worker_T1_1",
        changeSetId: "changeset_1",
        ...(taskScope ? { validationScope: taskScope } : {}),
      },
    },
    guidance: {},
    userGuidance: {},
    userGuidanceVersion: 0,
    architectQuestions: {},
    architectQuestionVersion: 0,
    reviews: {},
    runtime: { providerHealth: {}, workerAssignments: {}, architect: {} },
  } as unknown as SchedulerProjection;
}

function iv1ChangeSet(scope: ValidationScope | undefined): Record<string, unknown> {
  return {
    id: "changeset_1",
    runId: "run_iv1_architect",
    taskId: "T1",
    baselineRevision: "b".repeat(40),
    taskRevision: "c".repeat(40),
    commits: [],
    changedPaths: ["src/value.mjs"],
    diffArtifactHash: "d".repeat(64),
    evidenceArtifactHashes: ["ab".repeat(32)],
    unresolvedConcerns: [],
    ...(scope ? { validationScope: scope } : {}),
  };
}

test("IV-1 Architect review submission carries the durable scope on exact match", async () => {
  const scope = iv1Scope();
  const submission = await loadArchitectReviewSubmission(
    iv1SessionsStub(iv1ChangeSet(structuredClone(scope))) as never,
    "run_iv1_architect",
    { type: "review_required", taskId: "T1", changeSetId: "changeset_1" },
    iv1Projection(scope)
  );
  assert.ok(submission);
  assert.deepEqual(submission.validationScope, iv1Scope());
  assert.equal(submission.changeSetId, "changeset_1");
});

test("IV-1 Architect refuses one-sided and mismatched scope copies", async () => {
  const scope = iv1Scope();
  await assert.rejects(
    () => loadArchitectReviewSubmission(
      iv1SessionsStub(iv1ChangeSet(undefined)) as never,
      "run_iv1_architect",
      { type: "review_required", taskId: "T1", changeSetId: "changeset_1" },
      iv1Projection(scope)
    ),
    /differs from its durable kernel binding/
  );
  await assert.rejects(
    () => loadArchitectReviewSubmission(
      iv1SessionsStub(iv1ChangeSet(scope)) as never,
      "run_iv1_architect",
      { type: "review_required", taskId: "T1", changeSetId: "changeset_1" },
      iv1Projection()
    ),
    /differs from its durable kernel binding/
  );
  await assert.rejects(
    () => loadArchitectReviewSubmission(
      iv1SessionsStub(iv1ChangeSet({ ...scope, changed: ["src/forged.mjs"] })) as never,
      "run_iv1_architect",
      { type: "review_required", taskId: "T1", changeSetId: "changeset_1" },
      iv1Projection(scope)
    ),
    /differs from its durable kernel binding/
  );
});

test("IV-1 Architect review submission without a scope stays legacy-compatible", async () => {
  const submission = await loadArchitectReviewSubmission(
    iv1SessionsStub(iv1ChangeSet(undefined)) as never,
    "run_iv1_architect",
    { type: "review_required", taskId: "T1", changeSetId: "changeset_1" },
    iv1Projection()
  );
  assert.ok(submission);
  assert.equal(submission.validationScope, undefined);
});

test("IV-1 Architect review context renders the scope beside the W3 prefill", () => {
  const reviewSubmission: ArchitectReviewSubmission = {
    taskId: "T1",
    attempt: 1,
    changeSetId: "changeset_1",
    baselineRevision: "b".repeat(40),
    taskRevision: "c".repeat(40),
    changedPaths: ["src/value.mjs"],
    diffArtifactHash: "d".repeat(64),
    evidenceArtifactHashes: ["ab".repeat(32)],
    validationScope: iv1Scope(),
    dispositionPrefill: { reviewId: "delivery:T1:1:1" } as never,
  };
  const sections = architectContextSections({
    limits: { maxBytes: 512 * 1024, maxEstimatedTokens: 128 * 1024 },
    objective: "Export value 2.",
    reason: { type: "review_required", taskId: "T1", changeSetId: "changeset_1" },
    projection: { ...iv1Projection(), projectDocsPolicyVersion: 2 } as SchedulerProjection,
    reviewSubmission,
    instructions: [],
    skills: [],
    memories: [],
    evidence: [],
    recentHistory: [],
  });
  const current = sections.find((section) => section.id === "current-submission");
  assert.ok(current, "review turns carry the current submission");
  assert.ok(current.content.includes("node --test test/value.test.mjs"), "the scope rides the submission");
  assert.ok(current.content.includes('"notRun"'), "omissions ride the submission");
  assert.ok(current.content.includes("delivery:T1:1:1"), "the W3 prefill rides beside the scope");
  assert.ok(/independent/i.test(current.content) && /confirm/i.test(current.content), "W3 confirm framing intact");
  assert.ok(
    !current.content.includes("Use artifact.read with diffArtifactHash"),
    "no mandatory full-diff reread on confirm/override turns"
  );
});

test("IV-1 W3 intro and diff lines keep their confirm/override vs legacy split", () => {
  const prefilled: ArchitectReviewSubmission = {
    taskId: "T1",
    attempt: 1,
    changeSetId: "changeset_1",
    baselineRevision: "b".repeat(40),
    taskRevision: "c".repeat(40),
    changedPaths: ["src/value.mjs"],
    diffArtifactHash: "d".repeat(64),
    evidenceArtifactHashes: [],
    validationScope: iv1Scope(),
    dispositionPrefill: { reviewId: "delivery:T1:1:1" } as never,
  };
  const intro = currentSubmissionIntroLines(prefilled).join("\n");
  assert.ok(intro.includes("delivery:T1:1:1"), "prefill names its review");
  assert.ok(/independent review IS the review/.test(intro), "W3 ownership line intact");
  assert.deepEqual(currentSubmissionDiffLines(prefilled), [], "confirm turns omit the reread line");
  const { dispositionPrefill: _dropped, ...legacy } = prefilled;
  void _dropped;
  assert.deepEqual(currentSubmissionIntroLines(legacy), [
    "Review this immutable submitted attempt, not a prior attempt or the project working tree.",
  ]);
  assert.deepEqual(currentSubmissionDiffLines(legacy), [
    "Use artifact.read with diffArtifactHash for the authoritative submitted diff.",
  ]);
});
