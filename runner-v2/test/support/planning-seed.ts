import type {
  CoverageReview,
  ExecutionPlanRevision,
  HostPlanningCapabilities,
} from "../../src/planning-contracts.js";
import type { CoveragePriorFindingCheck } from "../../src/planning-projection.js";
import type { SchedulerStore } from "../../src/scheduler-store.js";
import type { ApprovedSourceManifest } from "../../src/source-manifest.js";

/**
 * T3b seed helpers: durable source reads plus the ordered coverage chain
 * (request → blind obligations → plan delivered → [correction view →
 * release] → verdict → ready) that the T3b reducer gates require. Replaces
 * the T3a "T3b stand-in" direct seeds.
 */

export const SEED_CLOCK = "2026-09-24T00:00:00.000Z";

/** One durable full verified read per manifest section (N2). Idempotent per section. */
export function seedDurableSourceReads(
  store: SchedulerStore,
  runId: string,
  manifest: ApprovedSourceManifest,
  occurredAt = SEED_CLOCK,
): void {
  for (const section of manifest.sections) {
    store.append({
      runId,
      type: "planning.source_section_read",
      occurredAt,
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: `planning-sourceread:${manifest.manifestId}:${section.id}`,
      payload: {
        manifestId: manifest.manifestId,
        manifestDigest: manifest.artifactDigest,
        sectionId: section.id,
        sectionDigest: section.digest,
        readAt: occurredAt,
      },
    });
  }
}

export function seedCoverageRequest(
  store: SchedulerStore,
  runId: string,
  input: {
    reviewId: string;
    revision: ExecutionPlanRevision;
    manifest: ApprovedSourceManifest;
    priorReviewId?: string;
    occurredAt?: string;
  },
): void {
  store.append({
    runId,
    type: "planning.coverage_review_requested",
    occurredAt: input.occurredAt ?? SEED_CLOCK,
    actor: { role: "architect", id: "architect_1" },
    idempotencyKey: `planning-coverage-request:${input.reviewId}`,
    payload: {
      reviewId: input.reviewId,
      planRevisionId: input.revision.revisionId,
      planRevisionDigest: input.revision.digest,
      sourceManifestId: input.manifest.manifestId,
      ...(input.priorReviewId !== undefined ? { priorReviewId: input.priorReviewId } : {}),
      requestedAt: input.occurredAt ?? SEED_CLOCK,
    },
  });
}

export function seedCoverageObligations(
  store: SchedulerStore,
  runId: string,
  input: {
    review: CoverageReview;
    manifest: ApprovedSourceManifest;
    occurredAt?: string;
  },
): void {
  const obligationIds = input.review.derivedObligations.map((obligation) => obligation.id);
  store.append({
    runId,
    type: "planning.coverage_obligations_recorded",
    occurredAt: input.occurredAt ?? SEED_CLOCK,
    actor: { role: "verifier", id: "reviewer" },
    idempotencyKey: `coverage:obligations:${input.review.id}`,
    payload: {
      reviewId: input.review.id,
      sourceManifestId: input.manifest.manifestId,
      sourceManifestDigest: input.manifest.artifactDigest,
      obligations: structuredClone(input.review.derivedObligations),
      sectionCoverage: input.manifest.sections.map((section) => ({
        sectionId: section.id,
        obligationIds: [...obligationIds],
      })),
      recordedAt: input.occurredAt ?? SEED_CLOCK,
    },
  });
}

export function seedCoveragePlanDelivered(
  store: SchedulerStore,
  runId: string,
  input: {
    reviewId: string;
    revision: ExecutionPlanRevision;
    manifest: ApprovedSourceManifest;
    sessionId?: string;
    occurredAt?: string;
  },
): void {
  store.append({
    runId,
    type: "planning.coverage_plan_delivered",
    occurredAt: input.occurredAt ?? SEED_CLOCK,
    actor: { role: "runner", id: "coverage-review-runtime" },
    idempotencyKey: `coverage:plan-delivered:${input.reviewId}`,
    payload: {
      reviewId: input.reviewId,
      planRevisionId: input.revision.revisionId,
      planRevisionDigest: input.revision.digest,
      sourceManifestId: input.manifest.manifestId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      deliveredAt: input.occurredAt ?? SEED_CLOCK,
    },
  });
}

export function seedCoverageCorrectionView(
  store: SchedulerStore,
  runId: string,
  input: {
    reviewId: string;
    priorReviewId: string;
    reusedFromReviewId: string;
    manifest: ApprovedSourceManifest;
    correctionView?: string;
    occurredAt?: string;
  },
): void {
  store.append({
    runId,
    type: "planning.coverage_correction_view_recorded",
    occurredAt: input.occurredAt ?? SEED_CLOCK,
    actor: { role: "verifier", id: "reviewer" },
    idempotencyKey: `coverage:correction-view:${input.reviewId}`,
    payload: {
      reviewId: input.reviewId,
      priorReviewId: input.priorReviewId,
      correctionView: input.correctionView ?? "Seeded own view of the correction.",
      reusedFromReviewId: input.reusedFromReviewId,
      sourceManifestId: input.manifest.manifestId,
      sourceManifestDigest: input.manifest.artifactDigest,
      recordedAt: input.occurredAt ?? SEED_CLOCK,
    },
  });
}

export function seedCoverageRelease(
  store: SchedulerStore,
  runId: string,
  input: { reviewId: string; priorReviewId: string; occurredAt?: string },
): void {
  store.append({
    runId,
    type: "planning.coverage_prior_findings_released",
    occurredAt: input.occurredAt ?? SEED_CLOCK,
    actor: { role: "runner", id: "coverage-review-runtime" },
    idempotencyKey: `coverage:release:${input.reviewId}`,
    payload: { reviewId: input.reviewId, priorReviewId: input.priorReviewId },
  });
}

export function seedCoverageVerdict(
  store: SchedulerStore,
  runId: string,
  input: {
    review: CoverageReview;
    priorFindingChecks?: CoveragePriorFindingCheck[];
    keySuffix?: string;
    occurredAt?: string;
  },
): void {
  store.append({
    runId,
    type: "planning.coverage_review_recorded",
    occurredAt: input.occurredAt ?? SEED_CLOCK,
    actor: { role: "verifier", id: "reviewer" },
    idempotencyKey: `coverage:${input.keySuffix ?? input.review.id}`,
    payload: {
      review: structuredClone(input.review),
      ...(input.priorFindingChecks !== undefined
        ? { priorFindingChecks: structuredClone(input.priorFindingChecks) }
        : {}),
    },
  });
}

/**
 * The full ordered chain to a bound review plus plan_ready: durable reads for
 * every section, request, blind obligations, plan delivered, optional
 * correction view + release, verdict, ready. Pass skipReads/skipReady for
 * negative tests. For a re-review that reuses a prior blind set, pass
 * reusedFromReviewId (different from the review id) and ensure that blind
 * set was seeded already; otherwise a fresh blind set is seeded for the
 * review itself (source-changed shape).
 */
export function seedBoundCoverageAndReady(
  store: SchedulerStore,
  runId: string,
  input: {
    revision: ExecutionPlanRevision;
    manifest: ApprovedSourceManifest;
    review: CoverageReview;
    hostCapabilities: HostPlanningCapabilities;
    priorFindingChecks?: CoveragePriorFindingCheck[];
    correctionView?: string;
    reusedFromReviewId?: string;
    skipReads?: boolean;
    skipReady?: boolean;
    readyKeySuffix?: string;
    occurredAt?: string;
  },
): void {
  const occurredAt = input.occurredAt ?? SEED_CLOCK;
  if (!input.skipReads) {
    seedDurableSourceReads(store, runId, input.manifest, occurredAt);
  }
  seedCoverageRequest(store, runId, {
    reviewId: input.review.id,
    revision: input.revision,
    manifest: input.manifest,
    ...(input.review.priorReviewId !== undefined ? { priorReviewId: input.review.priorReviewId } : {}),
    occurredAt,
  });
  const isReReview = input.review.priorReviewId !== undefined;
  const reusedFrom = input.reusedFromReviewId ?? input.review.id;
  const needsOwnBlind = !isReReview || reusedFrom === input.review.id;
  if (needsOwnBlind) {
    seedCoverageObligations(store, runId, {
      review: input.review,
      manifest: input.manifest,
      occurredAt,
    });
  }
  seedCoveragePlanDelivered(store, runId, {
    reviewId: input.review.id,
    revision: input.revision,
    manifest: input.manifest,
    occurredAt,
  });
  if (isReReview) {
    seedCoverageCorrectionView(store, runId, {
      reviewId: input.review.id,
      priorReviewId: input.review.priorReviewId!,
      reusedFromReviewId: reusedFrom,
      manifest: input.manifest,
      ...(input.correctionView !== undefined ? { correctionView: input.correctionView } : {}),
      occurredAt,
    });
    seedCoverageRelease(store, runId, {
      reviewId: input.review.id,
      priorReviewId: input.review.priorReviewId!,
      occurredAt,
    });
  }
  seedCoverageVerdict(store, runId, {
    review: input.review,
    ...(input.priorFindingChecks !== undefined ? { priorFindingChecks: input.priorFindingChecks } : {}),
    occurredAt,
  });
  if (!input.skipReady) {
    store.append({
      runId,
      type: "planning.plan_ready",
      occurredAt,
      actor: { role: "runner", id: "runner" },
      idempotencyKey: `ready:${input.readyKeySuffix ?? input.review.id}`,
      payload: { hostCapabilities: structuredClone(input.hostCapabilities) },
    });
  }
}
