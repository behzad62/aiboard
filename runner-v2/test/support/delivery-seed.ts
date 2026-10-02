import { assessDeliveryRisk, deliveryReviewId } from "../../src/delivery-acceptance.js";
import {
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
  type SchedulerStore,
} from "../../src/scheduler-store.js";

/**
 * T6a test support: drive one complete, kernel-valid deliverable review for a
 * submitted new-policy task, stage by stage, through the real reducer.
 */
export interface SeedDeliveryReviewOptions {
  clock?: string;
  authorRuntimeId?: string;
  reviewerRuntimeId?: string;
  reviewerModelIdentity?: string;
  independence?: "distinct_model" | "fresh_context";
  /** Record a worker.runtime_assigned first (fixtures without a worker driver). */
  assignAuthor?: boolean;
  findings?: unknown[];
  claimStatus?: (claimId: string) => "verified" | "unverified";
  changedFiles?: string[];
}

export const SEED_DIFF_HASH = "d".repeat(64);

/** Seed depth that satisfies the kernel's tier gate (high tier needs the affected-test run and the probe). */
function seedDepthForTier(tier: string): Record<string, unknown> {
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

export function seedCompletedDeliveryReview(
  store: SchedulerStore,
  runId: string,
  taskId: string,
  options: SeedDeliveryReviewOptions = {},
): string {
  const clock = options.clock ?? "2026-09-25T00:00:00.000Z";
  let projection = rebuildSchedulerProjection(store.readRun(runId));
  const task = projection.tasks[taskId]!;
  const authorRuntimeId = options.authorRuntimeId ?? "fixture-author";
  const append = (type: string, key: string, actor: NewSchedulerEvent["actor"], payload: Record<string, unknown>) =>
    store.append({ runId, type: type as NewSchedulerEvent["type"], occurredAt: clock, actor, idempotencyKey: key, payload });
  if (options.assignAuthor !== false && !projection.runtime.workerAssignments[`${taskId}:${task.attempt}`]) {
    append("worker.runtime_assigned", `seed-author:${taskId}:${task.attempt}`, { role: "runner", id: "runtime-router" }, {
      taskId, attempt: task.attempt, runtimeId: authorRuntimeId, sessionId: `seed-session:${taskId}:${task.attempt}`,
    });
    projection = rebuildSchedulerProjection(store.readRun(runId));
  }
  const author = projection.runtime.workerAssignments[`${taskId}:${task.attempt}`]!.runtimeId;
  const current = projection.delivery?.reviews[taskId];
  const history = projection.delivery?.reviewHistory[taskId] ?? [];
  const generation = Math.max(0, current?.generation ?? 0, ...history.map((review) => review.generation)) + 1;
  const reviewId = deliveryReviewId(taskId, task.attempt, generation);
  const criteriaIds = (task.acceptanceCriteria ?? []).map((criterion) => criterion.id);
  const runner = { role: "runner" as const, id: "delivery-review-runtime" };
  const reviewerRuntimeId = options.reviewerRuntimeId ?? "fixture-reviewer";
  const reviewer = { role: "verifier" as const, id: reviewerRuntimeId };
  append("delivery.review_started", `${reviewId}:started`, runner, {
    taskId, reviewId, generation, attempt: task.attempt, changeSetId: task.changeSetId,
    diffArtifactHash: SEED_DIFF_HASH, criteriaIds,
    authorRuntimeId: author, authorModelIdentity: `${author}-model`.toLowerCase().replaceAll(":", "-"),
    architectRuntimeId: projection.runtime.architect.runtimeId ?? "architect_1",
    architectModelIdentity: "fixture-architect-model",
  });
  const riskInput = {
    authorModelId: `${author}-model`.toLowerCase().replaceAll(":", "-"),
    changedFiles: options.changedFiles ?? ["src/feature.ts"],
    linesAdded: 3,
    linesRemoved: 1,
    attempts: task.attempt,
    acceptedFailuresUsed: false,
  };
  const risk = assessDeliveryRisk(riskInput);
  const prior = [...history, ...(current ? [current] : [])].reverse().find((review) => review.stage === "completed");
  append("delivery.review_requested", `${reviewId}:requested`, runner, {
    taskId, reviewId, reviewerRuntimeId, reviewerModelIdentity: options.reviewerModelIdentity ?? "fixture-reviewer-model",
    independence: options.independence ?? "distinct_model", reviewTier: risk.tier, riskDigest: risk.digest, riskInput,
    ...(prior ? { priorReviewId: prior.reviewId } : {}),
  });
  if (risk.tier === "high") {
    append("delivery.obligations_recorded", `${reviewId}:obligations`, reviewer, {
      taskId, reviewId, sessionId: `${reviewId}:obligations`, obligations: [{ id: "o1", description: "Meet the criteria." }],
    });
  }
  append("delivery.criteria_and_diff_delivered", `${reviewId}:diff`, runner, { taskId, reviewId, diffArtifactHash: SEED_DIFF_HASH });
  append("delivery.findings_recorded", `${reviewId}:findings`, reviewer, {
    taskId, reviewId, sessionId: `${reviewId}:findings`, findings: options.findings ?? [], depth: seedDepthForTier(risk.tier),
  });
  const claims = [
    ...criteriaIds.map((id) => ({ id: `claim:${id}`, text: `Criterion ${id} is satisfied.`, evidenceIds: [] })),
    { id: "claim:summary", text: "Implemented.", evidenceIds: [] },
  ];
  append("delivery.report_delivered", `${reviewId}:report`, runner, { taskId, reviewId, claims });
  const claimVerdicts = claims.map((claim) => ({
    claimId: claim.id,
    status: options.claimStatus?.(claim.id) ?? "verified",
    rationale: "Checked against the diff.",
  }));
  const blocking = (options.findings ?? []).some((finding) => (finding as { severity?: string }).severity === "blocking") ||
    claimVerdicts.some((verdict) => verdict.status === "unverified");
  append("delivery.review_recorded", `${reviewId}:verdict`, reviewer, {
    taskId, reviewId, sessionId: `${reviewId}:verdict`, summary: "Reviewed.", satisfied: !blocking, claimVerdicts,
    ...(prior ? { priorFindingChecks: (prior.findings ?? []).map((finding) => ({ findingId: finding.id, resolution: "resolved", rationale: "Fixed." })) } : {}),
  });
  return reviewId;
}
