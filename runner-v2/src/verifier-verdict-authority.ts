import {
  rebuildSchedulerProjection,
  type SchedulerStore,
} from "./scheduler-store.js";
import {
  cloneVerifierReview,
  type VerifierCriterionReference,
  type VerifierCriterionVerdict,
  type VerifierExcludedModel,
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
  criteria: VerifierCriterionReference[];
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
  submitVerdict(input: SubmitVerifierVerdictInput): VerifierVerdictProjection;
}

export class SchedulerVerifierVerdictAuthority
implements VerifierVerdictAuthority {
  constructor(
    private readonly store: SchedulerStore,
    private readonly runnerId = "native-verifier-runtime",
  ) {}

  requestReview(input: RequestVerifierReviewInput): VerifierReviewProjection {
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
        criteria: input.criteria.map((criterion) => ({ ...criterion })),
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
