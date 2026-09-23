import {
  rebuildSchedulerProjection,
  type SchedulerStore,
} from "./scheduler-store.js";
import {
  cloneVerifierReview,
  type ReviewerIndependence,
  type VerifierCriterionReference,
  type VerifierCriterionVerdict,
  type VerifierExcludedModel,
  type VerifierExpectation,
  type VerifierReviewProjection,
  type VerifierRuntimeBinding,
  type VerifierVerdictProjection,
} from "./verifier-contracts.js";
import type { AgentActor } from "./agent-contracts.js";

export interface RequestVerifierReviewInput {
  runId: string;
  reviewId: string;
  targetRevision: string;
  finalVerificationGenerationId: string;
  runtime: VerifierRuntimeBinding;
  excludedModels: VerifierExcludedModel[];
  independence?: ReviewerIndependence;
  criteria: VerifierCriterionReference[];
  twoPass?: boolean;
  baselineRevision?: string;
  occurredAt: string;
}

export interface RecordVerifierExpectationsInput {
  runId: string;
  reviewId: string;
  targetRevision: string;
  baselineRevision: string;
  sessionId: string;
  actor: AgentActor & { role: "verifier" };
  expectations: VerifierExpectation[];
  occurredAt: string;
}

export interface SubmitVerifierVerdictInput {
  runId: string;
  reviewId: string;
  targetRevision: string;
  sessionId: string;
  actor: AgentActor & { role: "verifier" };
  criterionVerdicts: VerifierCriterionVerdict[];
  occurredAt: string;
}

export interface VerifierVerdictAuthority {
  requestReview(input: RequestVerifierReviewInput): VerifierReviewProjection;
  currentReview(runId: string): VerifierReviewProjection | undefined;
  recordExpectations(input: RecordVerifierExpectationsInput): VerifierReviewProjection;
  submitVerdict(input: SubmitVerifierVerdictInput): VerifierVerdictProjection;
}

export class SchedulerVerifierVerdictAuthority
implements VerifierVerdictAuthority {
  constructor(
    private readonly store: SchedulerStore,
    private readonly runnerId = "native-verifier-runtime",
  ) {}

  requestReview(input: RequestVerifierReviewInput): VerifierReviewProjection {
    const current = this.currentReview(input.runId);
    const supersedesReviewId =
      current?.status === "requested" && current.reviewId !== input.reviewId
        ? current.reviewId
        : undefined;
    this.store.append({
      runId: input.runId,
      type: "verifier.review_requested",
      occurredAt: input.occurredAt,
      actor: { role: "runner", id: this.runnerId },
      idempotencyKey: `verifier:review:${input.reviewId}`,
      payload: {
        reviewId: input.reviewId,
        targetRevision: input.targetRevision,
        finalVerificationGenerationId: input.finalVerificationGenerationId,
        runtime: { ...input.runtime },
        excludedModels: input.excludedModels.map((model) => ({ ...model })),
        ...(input.independence ? { independence: input.independence } : {}),
        criteria: input.criteria.map((criterion) => ({ ...criterion })),
        ...(input.twoPass === true ? { twoPass: true } : {}),
        ...(input.baselineRevision ? { baselineRevision: input.baselineRevision } : {}),
        ...(supersedesReviewId ? { supersedesReviewId } : {}),
      },
    });
    const review = this.currentReview(input.runId);
    if (!review || review.reviewId !== input.reviewId) {
      throw new Error("Requested verifier review was not durably projected.");
    }
    return review;
  }

  currentReview(runId: string): VerifierReviewProjection | undefined {
    const events = this.store.readRun(runId);
    if (events.length === 0) return undefined;
    const current = rebuildSchedulerProjection(events).verifier?.current;
    return current ? cloneVerifierReview(current) : undefined;
  }

  recordExpectations(input: RecordVerifierExpectationsInput): VerifierReviewProjection {
    this.store.append({
      runId: input.runId,
      type: "verifier.expectations_recorded",
      occurredAt: input.occurredAt,
      actor: { ...input.actor },
      idempotencyKey: `verifier:expectations:${input.reviewId}`,
      payload: {
        reviewId: input.reviewId,
        targetRevision: input.targetRevision,
        baselineRevision: input.baselineRevision,
        sessionId: input.sessionId,
        expectations: input.expectations.map((expectation) => ({
          taskId: expectation.taskId,
          criterionId: expectation.criterionId,
          expectedBehaviors: [...expectation.expectedBehaviors],
          edgeCases: [...expectation.edgeCases],
          regressionSurfaces: [...expectation.regressionSurfaces],
          requiredTests: [...expectation.requiredTests],
        })),
      },
    });
    const review = this.currentReview(input.runId);
    if (
      !review?.expectations ||
      review.reviewId !== input.reviewId ||
      review.expectationsSessionId !== input.sessionId ||
      review.baselineRevision !== input.baselineRevision
    ) {
      throw new Error("Verifier expectations were not durably projected.");
    }
    return review;
  }

  submitVerdict(input: SubmitVerifierVerdictInput): VerifierVerdictProjection {
    this.store.append({
      runId: input.runId,
      type: "verifier.verdict_submitted",
      occurredAt: input.occurredAt,
      actor: { ...input.actor },
      idempotencyKey: `verifier:verdict:${input.reviewId}`,
      payload: {
        reviewId: input.reviewId,
        targetRevision: input.targetRevision,
        sessionId: input.sessionId,
        criterionVerdicts: input.criterionVerdicts.map((verdict) => ({
          ...verdict,
          evidenceIds: [...verdict.evidenceIds],
        })),
      },
    });
    const review = this.currentReview(input.runId);
    if (
      !review?.verdict ||
      review.reviewId !== input.reviewId ||
      review.runtime.sessionId !== input.sessionId
    ) {
      throw new Error("Verifier verdict was not durably projected.");
    }
    return structuredClone(review.verdict);
  }
}
