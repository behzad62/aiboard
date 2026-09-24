import { createHash } from "node:crypto";

import type { ExecutionGrantAuthority } from "./execution-grants.js";
import type { RunGitExecutionContext } from "./git-run-context.js";

import type {
  AgentMessage,
  AgentModel,
  NativeTool,
  ToolExecutionContext,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import { runAgentLoop } from "./agent-loop.js";
import {
  buildCoverageDeriveContext,
  buildCoverageVerdictContext,
  coverageReviewerSystemPrompt,
} from "./agent-prompts.js";
import type { ArtifactStore } from "./artifact-store.js";
import type {
  BudgetLedger,
  ModelCostBasisSnapshot,
} from "./budget-ledger.js";
import { BudgetedAgentModel, type ModelCostEstimator } from "./budgeted-model.js";
import { BudgetedToolRuntime } from "./budgeted-tool-runtime.js";
import {
  ProtectedContextOverflowError,
  type ContextLimits,
} from "./context-assembler.js";
import { recordContextPack, type ContextManifestStore } from "./context-manifest-store.js";
import type { EvidenceStore } from "./evidence-store.js";
import {
  createInspectionTools,
  verifierModelAttribution,
} from "./native-verifier-runtime.js";
import type { SqlitePermissionStore } from "./permission-store.js";
import {
  assessPlanRisk,
  type PlanRiskAssessment,
} from "./plan-critique-contracts.js";
import {
  COVERAGE_VERDICT_VALUES,
  PLANNING_FINDING_CATEGORIES,
  T1A_SEEDED_HOST_PLANNING_CAPABILITIES,
  type CoverageReview,
  type DerivedObligation,
  type ExecutionPlanPhase,
  type ExecutionPlanRevision,
  type HostPlanningCapabilities,
  type PlanningFinding,
  type SourceRequirement,
} from "./planning-contracts.js";
import type {
  CoverageCorrectionViewRecord,
  CoverageObligationsRecord,
  CoveragePlanDeliveredRecord,
  CoveragePriorFindingCheck,
  CoverageReviewRequestRecord,
  CoverageSectionCoverage,
  CoverageSuspendedRecord,
  CoverageUnavailableRecord,
} from "./planning-projection.js";
import { openBlockingCoverageFindings, TERMINAL_COVERAGE_GATE_REASONS } from "./planning-projection.js";
import type {
  RunnerProviderRetryRuntime,
} from "./provider-call-retry.js";
import { classifyProviderFailure } from "./provider-health.js";
import { assertRoleToolSurface } from "./role-capabilities.js";
import type {
  AgentRuntimeCandidate,
  RuntimeRouter,
} from "./runtime-router.js";
import {
  rebuildSchedulerProjection,
  type SchedulerStore,
} from "./scheduler-store.js";
import type { SqliteAgentSessionStore } from "./sqlite-agent-session-store.js";
import {
  computeArtifactDigest,
  type ApprovedSourceManifest,
} from "./source-manifest.js";
import type { ToolInvocationLedger } from "./tool-ledger.js";
import {
  assertFreshContextRequest,
  assertFreshContextSessionStarted,
  type ReviewerIndependence,
} from "./verifier-contracts.js";

/**
 * Independent source-coverage review (Runner V2 P6.6, T3b; OA-1/OA-2/OA-3/OA-10).
 *
 * The Architect derives a plan from the approved source; this module's reviewer
 * derives obligations from the source FIRST (fresh session, source-only
 * context), records them durably, and only then receives the plan and returns
 * one verdict per obligation. The shape is the RG-6 record-before-verdict
 * device reused for the coverage purpose: a record tool, a submit tool, and a
 * reducer gate that refuses a verdict without recorded obligations
 * (`planning-projection.ts`). Reviewer selection reuses
 * `RuntimeRouter.selectVerifier` unchanged; fresh-context session assertions
 * are reused from `verifier-contracts.ts`. No verifier-family file changes
 * behavior for existing verifier purposes.
 */

/** Supplies the original approved-source bytes for a manifest. Explicitly not imported from planning-tools.ts (that module imports this one for the request tool). */
export type CoverageSourceReader = (
  manifest: ApprovedSourceManifest,
) => Promise<Uint8Array>;

// ---------------------------------------------------------------------------
// Durable authority: the coverage events behind the review tools.
// ---------------------------------------------------------------------------

export interface RecordCoverageObligationsInput {
  runId: string;
  reviewId: string;
  sourceManifestId: string;
  sourceManifestDigest: string;
  obligations: DerivedObligation[];
  sectionCoverage: CoverageSectionCoverage[];
  actor: { role: "verifier"; id: string };
  occurredAt: string;
}

export interface RecordCoverageCorrectionViewInput {
  runId: string;
  reviewId: string;
  priorReviewId: string;
  correctionView: string;
  reusedFromReviewId: string;
  sourceManifestId: string;
  sourceManifestDigest: string;
  actor: { role: "verifier"; id: string };
  occurredAt: string;
}

export interface SubmitCoverageReviewInput {
  runId: string;
  review: CoverageReview;
  priorFindingChecks?: CoveragePriorFindingCheck[];
  actor: { role: "verifier"; id: string };
  occurredAt: string;
}

export interface CoverageReviewAuthority {
  coverageRequest(runId: string, reviewId: string): CoverageReviewRequestRecord | undefined;
  recordedObligations(runId: string, reviewId: string): CoverageObligationsRecord | undefined;
  correctionView(runId: string, reviewId: string): CoverageCorrectionViewRecord | undefined;
  planDelivered(runId: string, reviewId: string): CoveragePlanDeliveredRecord | undefined;
  currentReview(runId: string): CoverageReview | undefined;
  reviewHistory(runId: string): readonly CoverageReview[];
  openBlockingFindings(runId: string): { reviewId: string; findingId: string }[];
  retiredFindingIds(runId: string): ReadonlySet<string>;
  latestBlindObligationsForManifest(runId: string, manifestId: string): CoverageObligationsRecord | undefined;
  coverageUnavailable(runId: string): CoverageUnavailableRecord | undefined;
  suspendedAttempts(runId: string, reviewId: string): CoverageSuspendedRecord | undefined;
  recordObligations(input: RecordCoverageObligationsInput): CoverageObligationsRecord;
  recordCorrectionView(input: RecordCoverageCorrectionViewInput): CoverageCorrectionViewRecord;
  recordPlanDelivered(input: {
    runId: string;
    reviewId: string;
    planRevisionId: string;
    planRevisionDigest: string;
    sourceManifestId: string;
    sessionId?: string;
    occurredAt: string;
  }): void;
  releasePriorFindings(input: {
    runId: string;
    reviewId: string;
    priorReviewId: string;
    occurredAt: string;
  }): void;
  recordUnavailable(input: {
    runId: string;
    reviewId?: string;
    reason: string;
    detail?: string;
    occurredAt: string;
  }): void;
  recordSuspended(input: {
    runId: string;
    reviewId: string;
    reason: string;
    runtimeId?: string;
    occurredAt: string;
  }): CoverageSuspendedRecord;
  authorizeCoverageRetry(input: {
    runId: string;
    reviewId: string;
    occurredAt: string;
  }): boolean;
  submitReview(input: SubmitCoverageReviewInput): CoverageReview;
  appendPlanReady(input: {
    runId: string;
    hostCapabilities: HostPlanningCapabilities;
    priorRevisionId?: string;
    occurredAt: string;
  }): void;
}

export class SchedulerCoverageReviewAuthority implements CoverageReviewAuthority {
  constructor(
    private readonly store: SchedulerStore,
    private readonly runnerId = "coverage-review-runtime",
  ) {}

  coverageRequest(runId: string, reviewId: string): CoverageReviewRequestRecord | undefined {
    const planning = this.planningOf(runId);
    const record = planning?.coverageRequests[reviewId];
    return record ? structuredClone(record) : undefined;
  }

  recordedObligations(runId: string, reviewId: string): CoverageObligationsRecord | undefined {
    const planning = this.planningOf(runId);
    const record = planning?.coverageObligations[reviewId];
    return record ? structuredClone(record) : undefined;
  }

  correctionView(runId: string, reviewId: string): CoverageCorrectionViewRecord | undefined {
    const planning = this.planningOf(runId);
    const record = planning?.coverageCorrectionViews[reviewId];
    return record ? structuredClone(record) : undefined;
  }

  planDelivered(runId: string, reviewId: string): CoveragePlanDeliveredRecord | undefined {
    const planning = this.planningOf(runId);
    const record = planning?.coveragePlanDelivered[reviewId];
    return record ? structuredClone(record) : undefined;
  }

  currentReview(runId: string): CoverageReview | undefined {
    const planning = this.planningOf(runId);
    return planning?.coverageReview ? structuredClone(planning.coverageReview) : undefined;
  }

  reviewHistory(runId: string): readonly CoverageReview[] {
    const planning = this.planningOf(runId);
    return structuredClone(planning?.coverageReviewHistory ?? []);
  }

  openBlockingFindings(runId: string): { reviewId: string; findingId: string }[] {
    const planning = this.planningOf(runId);
    if (!planning) return [];
    return openBlockingCoverageFindings(planning);
  }

  retiredFindingIds(runId: string): ReadonlySet<string> {
    const planning = this.planningOf(runId);
    return new Set(Object.keys(planning?.coverageRetiredFindings ?? {}));
  }

  latestBlindObligationsForManifest(runId: string, manifestId: string): CoverageObligationsRecord | undefined {
    const planning = this.planningOf(runId);
    if (!planning) return undefined;
    const events = this.store.readRun(runId);
    let latest: CoverageObligationsRecord | undefined;
    for (const event of events) {
      if (event.type !== "planning.coverage_obligations_recorded") continue;
      const payload = event.payload as { reviewId?: string; sourceManifestId?: string };
      if (payload.sourceManifestId !== manifestId || typeof payload.reviewId !== "string") continue;
      const record = planning.coverageObligations[payload.reviewId];
      if (record) latest = structuredClone(record);
    }
    return latest;
  }

  coverageUnavailable(runId: string): CoverageUnavailableRecord | undefined {
    const planning = this.planningOf(runId);
    return planning?.coverageUnavailable ? structuredClone(planning.coverageUnavailable) : undefined;
  }

  suspendedAttempts(runId: string, reviewId: string): CoverageSuspendedRecord | undefined {
    const planning = this.planningOf(runId);
    const record = planning?.coverageSuspended[reviewId];
    return record ? structuredClone(record) : undefined;
  }

  recordObligations(input: RecordCoverageObligationsInput): CoverageObligationsRecord {
    this.store.append({
      runId: input.runId,
      type: "planning.coverage_obligations_recorded",
      occurredAt: input.occurredAt,
      actor: { ...input.actor },
      idempotencyKey: `coverage:obligations:${input.reviewId}`,
      payload: {
        reviewId: input.reviewId,
        sourceManifestId: input.sourceManifestId,
        sourceManifestDigest: input.sourceManifestDigest,
        obligations: structuredClone(input.obligations),
        sectionCoverage: structuredClone(input.sectionCoverage),
        recordedAt: input.occurredAt,
      },
    });
    const recorded = this.recordedObligations(input.runId, input.reviewId);
    if (!recorded) throw new Error("Coverage obligations were not durably projected.");
    return recorded;
  }

  recordCorrectionView(input: RecordCoverageCorrectionViewInput): CoverageCorrectionViewRecord {
    this.store.append({
      runId: input.runId,
      type: "planning.coverage_correction_view_recorded",
      occurredAt: input.occurredAt,
      actor: { ...input.actor },
      idempotencyKey: `coverage:correction-view:${input.reviewId}`,
      payload: {
        reviewId: input.reviewId,
        priorReviewId: input.priorReviewId,
        correctionView: input.correctionView,
        reusedFromReviewId: input.reusedFromReviewId,
        sourceManifestId: input.sourceManifestId,
        sourceManifestDigest: input.sourceManifestDigest,
        recordedAt: input.occurredAt,
      },
    });
    const recorded = this.correctionView(input.runId, input.reviewId);
    if (!recorded) throw new Error("Coverage correction view was not durably projected.");
    return recorded;
  }

  recordPlanDelivered(input: {
    runId: string;
    reviewId: string;
    planRevisionId: string;
    planRevisionDigest: string;
    sourceManifestId: string;
    sessionId?: string;
    occurredAt: string;
  }): void {
    if (this.planDelivered(input.runId, input.reviewId)) return;
    this.store.append({
      runId: input.runId,
      type: "planning.coverage_plan_delivered",
      occurredAt: input.occurredAt,
      actor: { role: "runner", id: this.runnerId },
      idempotencyKey: `coverage:plan-delivered:${input.reviewId}`,
      payload: {
        reviewId: input.reviewId,
        planRevisionId: input.planRevisionId,
        planRevisionDigest: input.planRevisionDigest,
        sourceManifestId: input.sourceManifestId,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        deliveredAt: input.occurredAt,
      },
    });
  }

  releasePriorFindings(input: {
    runId: string;
    reviewId: string;
    priorReviewId: string;
    occurredAt: string;
  }): void {
    this.store.append({
      runId: input.runId,
      type: "planning.coverage_prior_findings_released",
      occurredAt: input.occurredAt,
      actor: { role: "runner", id: this.runnerId },
      idempotencyKey: `coverage:release:${input.reviewId}`,
      payload: { reviewId: input.reviewId, priorReviewId: input.priorReviewId },
    });
  }

  recordUnavailable(input: {
    runId: string;
    reviewId?: string;
    reason: string;
    detail?: string;
    occurredAt: string;
  }): void {
    // R2-3: de-duplicate against the durable log on EVERY gate path, not
    // only the current gate — when the current gate already IS this gate
    // (same review, reason, detail, current revision), recording again is a
    // no-op instead of an idempotency conflict.
    const planning = this.planningOf(input.runId);
    const current = planning?.coverageUnavailable;
    const sameGate =
      current !== undefined &&
      current.reviewId === input.reviewId &&
      current.reason === input.reason &&
      (current.detail ?? undefined) === (input.detail ?? undefined) &&
      current.planRevisionId === planning?.plan?.currentRevisionId &&
      current.sourceManifestId === planning?.source.currentManifestId;
    if (sameGate) {
      return;
    }
    // A cleared gate recorded again is a NEW occurrence with its own
    // deterministic key (counted from the durable log), so re-recording
    // after a flap never collides. The payload carries no timestamp, so a
    // retried occurrence is byte-identical and the store returns it.
    const occurrence = this.store.readRun(input.runId).filter(
      (event) =>
        event.type === "planning.coverage_review_unavailable" &&
        (event.payload.reviewId ?? undefined) === (input.reviewId ?? undefined) &&
        event.payload.reason === input.reason,
    ).length;
    this.store.append({
      runId: input.runId,
      type: "planning.coverage_review_unavailable",
      occurredAt: input.occurredAt,
      actor: { role: "runner", id: this.runnerId },
      idempotencyKey: `coverage:unavailable:${input.reviewId ?? "none"}:${input.reason}:${occurrence}`,
      payload: {
        ...(input.reviewId !== undefined ? { reviewId: input.reviewId } : {}),
        reason: input.reason,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
      },
    });
  }

  /**
   * R2-1: the owner's retry authorization for a terminal N6 exhaustion gate.
   * Appended by resume (owner actor); clears the gate and resets the
   * suspended-retry count so the review runs again. No-op (false) without
   * the terminal gate for that review.
   */
  authorizeCoverageRetry(input: {
    runId: string;
    reviewId: string;
    occurredAt: string;
  }): boolean {
    const gate = this.planningOf(input.runId)?.coverageUnavailable;
    if (
      !gate ||
      gate.reviewId !== input.reviewId ||
      !(TERMINAL_COVERAGE_GATE_REASONS as readonly string[]).includes(gate.reason)
    ) {
      return false;
    }
    const occurrence = this.store.readRun(input.runId).filter(
      (event) =>
        event.type === "planning.coverage_review_retry_authorized" &&
        event.payload.reviewId === input.reviewId,
    ).length;
    this.store.append({
      runId: input.runId,
      type: "planning.coverage_review_retry_authorized",
      occurredAt: input.occurredAt,
      actor: { role: "user", id: "local-user" },
      idempotencyKey: `coverage:review-retry:${input.reviewId}:${occurrence}`,
      payload: { reviewId: input.reviewId },
    });
    return true;
  }

  recordSuspended(input: {
    runId: string;
    reviewId: string;
    reason: string;
    runtimeId?: string;
    occurredAt: string;
  }): CoverageSuspendedRecord {
    const prior = this.suspendedAttempts(input.runId, input.reviewId);
    const attempts = (prior?.attempts ?? 0) + 1;
    // R3-1: the projected attempt count resets when the owner authorizes a
    // retry, so it cannot scope the idempotency key on its own — the first
    // post-retry suspension would reuse attempt 1's key and either be
    // swallowed (same payload, then "not durably projected") or conflict
    // (failover payload). The durable count of suspended events for this
    // review is monotonic and never resets, so it scopes the key across
    // retry epochs; deterministic and replay-safe (a pure function of the
    // durable log, like recordUnavailable's occurrence).
    const sequence = this.store.readRun(input.runId).filter(
      (event) =>
        event.type === "planning.coverage_review_suspended" &&
        event.payload.reviewId === input.reviewId,
    ).length;
    this.store.append({
      runId: input.runId,
      type: "planning.coverage_review_suspended",
      occurredAt: input.occurredAt,
      actor: { role: "runner", id: this.runnerId },
      idempotencyKey: `coverage:suspended:${input.reviewId}:${sequence}:${attempts}:${input.reason}`,
      payload: {
        reviewId: input.reviewId,
        reason: input.reason,
        ...(input.runtimeId !== undefined ? { runtimeId: input.runtimeId } : {}),
      },
    });
    const recorded = this.suspendedAttempts(input.runId, input.reviewId);
    if (!recorded) throw new Error("Coverage suspension was not durably projected.");
    return recorded;
  }

  submitReview(input: SubmitCoverageReviewInput): CoverageReview {
    this.store.append({
      runId: input.runId,
      type: "planning.coverage_review_recorded",
      occurredAt: input.occurredAt,
      actor: { ...input.actor },
      idempotencyKey: `coverage:verdict:${input.review.id}`,
      payload: {
        review: structuredClone(input.review),
        ...(input.priorFindingChecks !== undefined
          ? { priorFindingChecks: structuredClone(input.priorFindingChecks) }
          : {}),
      },
    });
    const review = this.currentReview(input.runId);
    if (!review || review.id !== input.review.id) {
      throw new Error("Coverage review was not durably projected.");
    }
    return review;
  }

  appendPlanReady(input: {
    runId: string;
    hostCapabilities: HostPlanningCapabilities;
    priorRevisionId?: string;
    occurredAt: string;
  }): void {
    const planning = this.planningOf(input.runId);
    const revisionId = planning?.plan?.currentRevisionId ?? "unknown";
    this.store.append({
      runId: input.runId,
      type: "planning.plan_ready",
      occurredAt: input.occurredAt,
      actor: { role: "runner", id: this.runnerId },
      idempotencyKey: `coverage:plan-ready:${revisionId}`,
      payload: {
        hostCapabilities: structuredClone(input.hostCapabilities),
        ...(input.priorRevisionId !== undefined ? { priorRevisionId: input.priorRevisionId } : {}),
      },
    });
  }

  private planningOf(runId: string) {
    const events = this.store.readRun(runId);
    if (events.length === 0) return undefined;
    return rebuildSchedulerProjection(events).planning;
  }
}

// ---------------------------------------------------------------------------
// Reviewer tools: blind obligations, re-review own view, verdict (RG-6 shape).
// ---------------------------------------------------------------------------

export interface CoverageObligationInput {
  id: string;
  description: string;
  requirementId?: string;
}

export interface CoverageSectionCoverageInput {
  sectionId: string;
  obligationIds: string[];
  noObligationReason?: string;
}

export interface RecordCoverageObligationsToolInput {
  obligations: CoverageObligationInput[];
  sectionCoverage: CoverageSectionCoverageInput[];
}

export interface RecordCoverageObligationsToolOptions {
  authority: CoverageReviewAuthority;
  runId: string;
  reviewId: string;
  sourceManifestId: string;
  sourceManifestDigest: string;
  runtimeId: string;
  sessionId: string;
  clock?: () => string;
}

export function createRecordCoverageObligationsTool(
  options: RecordCoverageObligationsToolOptions,
): NativeTool<RecordCoverageObligationsToolInput> {
  const clock = options.clock ?? (() => new Date().toISOString());
  return {
    definition: {
      name: "record_coverage_obligations",
      description:
        "Record, before seeing the plan, every distinct obligation the approved source imposes plus section coverage (each section maps to obligations or an explicit no-obligation reason). Blind only; a re-review reuses this set via its own view. The kernel refuses a coverage verdict without it.",
      inputSchema: {
        type: "object",
        properties: {
          obligations: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1 },
                description: { type: "string", minLength: 1 },
                requirementId: { type: "string", minLength: 1 },
              },
              required: ["id", "description"],
              additionalProperties: false,
            },
          },
          sectionCoverage: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                sectionId: { type: "string", minLength: 1 },
                obligationIds: { type: "array", items: { type: "string", minLength: 1 } },
                noObligationReason: { type: "string", minLength: 1 },
              },
              required: ["sectionId", "obligationIds"],
              additionalProperties: false,
            },
          },
        },
        required: ["obligations", "sectionCoverage"],
        additionalProperties: false,
      },
      readOnly: true,
      effect: "none",
      lifecycle: true,
    },
    validate: (input) => validateRecordCoverageObligations(input),
    assessAccess: () => ({
      capability: "coverage.obligations.record",
      external: false,
    }),
    execute: async (input, context) => {
      assertReviewerContext(context, options.runId, options.sessionId, options.runtimeId);
      const recordedAt = clock();
      const recorded = options.authority.recordObligations({
        runId: options.runId,
        reviewId: options.reviewId,
        sourceManifestId: options.sourceManifestId,
        sourceManifestDigest: options.sourceManifestDigest,
        obligations: input.obligations.map((obligation) => ({
          id: obligation.id,
          ...(obligation.requirementId !== undefined ? { requirementId: obligation.requirementId } : {}),
          description: obligation.description,
          recordedBeforePlanOrDiffProvided: true as const,
          recordedAt,
        })),
        sectionCoverage: input.sectionCoverage.map((entry) => ({
          sectionId: entry.sectionId,
          obligationIds: [...entry.obligationIds],
          ...(entry.noObligationReason !== undefined ? { noObligationReason: entry.noObligationReason } : {}),
        })),
        actor: { role: "verifier", id: options.runtimeId },
        occurredAt: recordedAt,
      });
      return {
        content: [{ type: "json", value: { reviewId: recorded.reviewId } }],
        isError: false,
        // The RG-6 lifecycle signal, reused: obligations recorded ends the deriving pass.
        lifecycle: { type: "verifier_expectations_recorded", reviewId: options.reviewId },
      };
    },
  };
}

function validateRecordCoverageObligations(
  input: unknown,
): ValidationResult<RecordCoverageObligationsToolInput> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, issues: ["Coverage obligations input must be an object."] };
  }
  const record = input as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== "obligations" && key !== "sectionCoverage");
  if (unknown.length > 0) {
    return { ok: false, issues: [`Coverage obligations have unknown fields: ${unknown.join(", ")}.`] };
  }
  if (!Array.isArray(record.obligations) || record.obligations.length === 0) {
    return { ok: false, issues: ["Coverage obligations require at least one derived obligation."] };
  }
  const seen = new Set<string>();
  const obligations: CoverageObligationInput[] = [];
  for (const [index, candidate] of record.obligations.entries()) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return { ok: false, issues: [`Coverage obligation ${index} is invalid.`] };
    }
    const entry = candidate as Record<string, unknown>;
    const entryUnknown = Object.keys(entry).filter(
      (key) => key !== "id" && key !== "description" && key !== "requirementId",
    );
    if (entryUnknown.length > 0) {
      return { ok: false, issues: [`Coverage obligation ${index} has unknown fields: ${entryUnknown.join(", ")}.`] };
    }
    const id = entry.id;
    const description = entry.description;
    const requirementId = entry.requirementId;
    if (typeof id !== "string" || id.trim().length === 0) {
      return { ok: false, issues: [`Coverage obligation ${index} requires a non-empty id.`] };
    }
    if (typeof description !== "string" || description.trim().length === 0) {
      return { ok: false, issues: [`Coverage obligation ${id} requires a non-empty description.`] };
    }
    if (requirementId !== undefined && (typeof requirementId !== "string" || requirementId.trim().length === 0)) {
      return { ok: false, issues: [`Coverage obligation ${id} has an invalid requirementId.`] };
    }
    if (seen.has(id)) {
      return { ok: false, issues: [`Duplicate derived obligation id ${id}.`] };
    }
    seen.add(id);
    obligations.push({
      id,
      description,
      ...(requirementId === undefined ? {} : { requirementId: requirementId as string }),
    });
  }
  if (!Array.isArray(record.sectionCoverage) || record.sectionCoverage.length === 0) {
    return { ok: false, issues: ["Coverage obligations require section coverage for every source section (N4)."] };
  }
  const seenSections = new Set<string>();
  const sectionCoverage: CoverageSectionCoverageInput[] = [];
  for (const [index, candidate] of record.sectionCoverage.entries()) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return { ok: false, issues: [`Coverage section entry ${index} is invalid.`] };
    }
    const entry = candidate as Record<string, unknown>;
    const entryUnknown = Object.keys(entry).filter(
      (key) => key !== "sectionId" && key !== "obligationIds" && key !== "noObligationReason",
    );
    if (entryUnknown.length > 0) {
      return { ok: false, issues: [`Coverage section entry ${index} has unknown fields: ${entryUnknown.join(", ")}.`] };
    }
    const sectionId = entry.sectionId;
    const obligationIds = entry.obligationIds;
    const noObligationReason = entry.noObligationReason;
    if (typeof sectionId !== "string" || sectionId.trim().length === 0) {
      return { ok: false, issues: [`Coverage section entry ${index} requires a non-empty sectionId.`] };
    }
    if (seenSections.has(sectionId)) {
      return { ok: false, issues: [`Duplicate coverage entry for source section ${sectionId}.`] };
    }
    seenSections.add(sectionId);
    if (!Array.isArray(obligationIds) || obligationIds.some((id) => typeof id !== "string" || id.trim().length === 0)) {
      return { ok: false, issues: [`Coverage for section ${sectionId} requires obligationIds.`] };
    }
    for (const id of obligationIds as string[]) {
      if (!seen.has(id)) {
        return { ok: false, issues: [`Coverage for section ${sectionId} cites unknown obligation ${id}.`] };
      }
    }
    if ((obligationIds as string[]).length === 0) {
      if (typeof noObligationReason !== "string" || noObligationReason.trim().length === 0) {
        return { ok: false, issues: [`Source section ${sectionId} needs a no-obligation reason (N4).`] };
      }
      sectionCoverage.push({ sectionId, obligationIds: [], noObligationReason });
    } else {
      if (noObligationReason !== undefined) {
        return { ok: false, issues: [`Source section ${sectionId} cannot name both obligations and a no-obligation reason.`] };
      }
      sectionCoverage.push({ sectionId, obligationIds: [...(obligationIds as string[])] });
    }
  }
  return { ok: true, value: { obligations, sectionCoverage } };
}

export interface RecordCoverageCorrectionViewToolInput {
  correctionView: string;
}

export interface RecordCoverageCorrectionViewToolOptions {
  authority: CoverageReviewAuthority;
  runId: string;
  reviewId: string;
  priorReviewId: string;
  reusedFromReviewId: string;
  sourceManifestId: string;
  sourceManifestDigest: string;
  runtimeId: string;
  sessionId: string;
  clock?: () => string;
}

export function createRecordCoverageCorrectionViewTool(
  options: RecordCoverageCorrectionViewToolOptions,
): NativeTool<RecordCoverageCorrectionViewToolInput> {
  const clock = options.clock ?? (() => new Date().toISOString());
  return {
    definition: {
      name: "record_coverage_correction_view",
      description:
        "Record the re-review's own view of the corrected plan against the reused blind obligations, before any prior findings are released. Exactly one call per re-review; the kernel refuses the release and verdict without it.",
      inputSchema: {
        type: "object",
        properties: {
          correctionView: { type: "string", minLength: 1 },
        },
        required: ["correctionView"],
        additionalProperties: false,
      },
      readOnly: true,
      effect: "none",
      lifecycle: true,
    },
    validate: (input) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return { ok: false, issues: ["Coverage correction view input must be an object."] };
      }
      const record = input as Record<string, unknown>;
      const unknown = Object.keys(record).filter((key) => key !== "correctionView");
      if (unknown.length > 0) {
        return { ok: false, issues: [`Coverage correction view has unknown fields: ${unknown.join(", ")}.`] };
      }
      if (typeof record.correctionView !== "string" || record.correctionView.trim().length === 0) {
        return { ok: false, issues: ["A coverage re-review must record its own view of the correction first."] };
      }
      return { ok: true, value: { correctionView: record.correctionView } };
    },
    assessAccess: () => ({
      capability: "coverage.correction_view.record",
      external: false,
    }),
    execute: async (input, context) => {
      assertReviewerContext(context, options.runId, options.sessionId, options.runtimeId);
      const recordedAt = clock();
      const recorded = options.authority.recordCorrectionView({
        runId: options.runId,
        reviewId: options.reviewId,
        priorReviewId: options.priorReviewId,
        correctionView: input.correctionView,
        reusedFromReviewId: options.reusedFromReviewId,
        sourceManifestId: options.sourceManifestId,
        sourceManifestDigest: options.sourceManifestDigest,
        actor: { role: "verifier", id: options.runtimeId },
        occurredAt: recordedAt,
      });
      return {
        content: [{ type: "json", value: { reviewId: recorded.reviewId } }],
        isError: false,
        lifecycle: { type: "verifier_expectations_recorded", reviewId: options.reviewId },
      };
    },
  };
}

export interface CoverageVerdictToolInput {
  obligationId: string;
  verdict: string;
  severity: "blocking" | "advisory";
  rationale: string;
  evidenceRefs: string[];
}

export interface CoverageFindingToolInput {
  id: string;
  category: string;
  severity: "blocking" | "advisory";
  claim: string;
  evidenceRefs: string[];
  requirementId?: string;
  location?: string;
}

export interface CoveragePriorFindingCheckInput {
  priorFindingId: string;
  status: "resolved" | "outstanding";
  rationale: string;
}

export interface SubmitCoverageVerdictToolInput {
  obligationVerdicts: CoverageVerdictToolInput[];
  findings: CoverageFindingToolInput[];
  priorFindingChecks?: CoveragePriorFindingCheckInput[];
}

export interface SubmitCoverageVerdictToolOptions {
  authority: CoverageReviewAuthority;
  runId: string;
  reviewId: string;
  reviewerRuntimeId: string;
  independence: "distinct_model" | "fresh_context";
  sourceReadManifestId: string;
  planRevisionId: string;
  planRevisionDigest: string;
  /** Obligation ids from the DURABLE record — the verdict must cover exactly these. */
  obligationIds: readonly string[];
  priorReviewId?: string;
  /** Prior finding ids from the DURABLE prior review — a re-review checks each one. */
  priorFindingIds?: readonly string[];
  /** Re-review only: the blind obligations record reused (B2). Defaults to reviewId. */
  reusedFromReviewId?: string;
  runtimeId: string;
  sessionId: string;
  clock?: () => string;
}

export function createSubmitCoverageVerdictTool(
  options: SubmitCoverageVerdictToolOptions,
): NativeTool<SubmitCoverageVerdictToolInput> {
  const clock = options.clock ?? (() => new Date().toISOString());
  return {
    definition: {
      name: "submit_coverage_verdict",
      description:
        "Submit one verdict per recorded obligation (covered, weakened, or missing) plus findings. Verdict words and finding categories are separate vocabularies; a re-review also checks each prior finding.",
      inputSchema: {
        type: "object",
        properties: {
          obligationVerdicts: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                obligationId: { type: "string", minLength: 1 },
                verdict: { type: "string", minLength: 1 },
                severity: { type: "string", enum: ["blocking", "advisory"] },
                rationale: { type: "string", minLength: 1 },
                evidenceRefs: { type: "array", items: { type: "string", minLength: 1 } },
              },
              required: ["obligationId", "verdict", "severity", "rationale", "evidenceRefs"],
              additionalProperties: false,
            },
          },
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1 },
                category: { type: "string", minLength: 1 },
                severity: { type: "string", enum: ["blocking", "advisory"] },
                claim: { type: "string", minLength: 1 },
                evidenceRefs: { type: "array", items: { type: "string", minLength: 1 } },
                requirementId: { type: "string", minLength: 1 },
                location: { type: "string", minLength: 1 },
              },
              required: ["id", "category", "severity", "claim", "evidenceRefs"],
              additionalProperties: false,
            },
          },
          priorFindingChecks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                priorFindingId: { type: "string", minLength: 1 },
                status: { type: "string", enum: ["resolved", "outstanding"] },
                rationale: { type: "string", minLength: 1 },
              },
              required: ["priorFindingId", "status", "rationale"],
              additionalProperties: false,
            },
          },
        },
        required: ["obligationVerdicts", "findings"],
        additionalProperties: false,
      },
      readOnly: true,
      effect: "none",
      lifecycle: true,
    },
    validate: (input) => validateSubmitCoverageVerdict(input, options),
    assessAccess: () => ({
      capability: "coverage.verdict.submit",
      external: false,
    }),
    execute: async (input, context) => {
      assertReviewerContext(context, options.runId, options.sessionId, options.runtimeId);
      const obligationsReviewId = options.reusedFromReviewId ?? options.reviewId;
      const recorded = options.authority.recordedObligations(options.runId, obligationsReviewId);
      if (!recorded) {
        throw new Error(
          `Coverage verdict ${options.reviewId} has no durably recorded obligations (record-before-verdict gate).`,
        );
      }
      // R2-2 (tool path; the reducer owns the kernel refusal): a finding id
      // already used by any earlier review of this run is refused.
      const usedFindingIds = new Map<string, string>();
      for (
        const recordedReview of [
          options.authority.currentReview(options.runId),
          ...options.authority.reviewHistory(options.runId),
        ]
      ) {
        if (!recordedReview) continue;
        for (const finding of recordedReview.findings) {
          if (!usedFindingIds.has(finding.id)) usedFindingIds.set(finding.id, recordedReview.id);
        }
      }
      for (const finding of input.findings) {
        const earlier = usedFindingIds.get(finding.id);
        if (earlier !== undefined) {
          throw new Error(
            `Coverage review ${options.reviewId} reuses finding id ${finding.id} from earlier review ${earlier}; finding ids must be unique across all reviews of the run.`,
          );
        }
      }
      const recordedAt = clock();
      const review: CoverageReview = {
        id: options.reviewId,
        runId: options.runId,
        reviewerRuntimeId: options.reviewerRuntimeId,
        independence: options.independence,
        sourceReadManifestId: options.sourceReadManifestId,
        planRevisionId: options.planRevisionId,
        planRevisionDigest: options.planRevisionDigest,
        derivedObligations: recorded.obligations.map((obligation) => ({ ...obligation })),
        obligationVerdicts: input.obligationVerdicts.map((verdict) => ({ ...verdict })),
        findings: input.findings.map((finding) => ({ ...finding })),
        ...(options.priorReviewId !== undefined
          ? { priorReviewId: options.priorReviewId, correctionOwnViewRecordedFirst: true as const }
          : {}),
        recordedAt,
      };
      const submitted = options.authority.submitReview({
        runId: options.runId,
        review,
        ...(input.priorFindingChecks !== undefined ? { priorFindingChecks: [...input.priorFindingChecks] } : {}),
        actor: { role: "verifier", id: options.runtimeId },
        occurredAt: recordedAt,
      });
      const satisfied = !submitted.obligationVerdicts.some(
        (verdict) =>
          verdict.severity === "blocking" && (verdict.verdict === "missing" || verdict.verdict === "weakened"),
      );
      return {
        content: [{ type: "json", value: submitted }],
        isError: false,
        // The RG-6 lifecycle signal, reused: the verdict ends the verdict pass.
        lifecycle: { type: "verifier_verdict_submitted", reviewId: options.reviewId, satisfied },
      };
    },
  };
}

function validateSubmitCoverageVerdict(
  input: unknown,
  options: SubmitCoverageVerdictToolOptions,
): ValidationResult<SubmitCoverageVerdictToolInput> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, issues: ["Coverage verdict input must be an object."] };
  }
  const record = input as Record<string, unknown>;
  const unknown = Object.keys(record).filter(
    (key) => key !== "obligationVerdicts" && key !== "findings" && key !== "priorFindingChecks",
  );
  if (unknown.length > 0) {
    return { ok: false, issues: [`Coverage verdict has unknown fields: ${unknown.join(", ")}.`] };
  }
  if (!Array.isArray(record.obligationVerdicts)) {
    return { ok: false, issues: ["Coverage verdict requires obligation verdicts."] };
  }
  const seenObligations = new Set<string>();
  const obligationVerdicts: CoverageVerdictToolInput[] = [];
  for (const [index, candidate] of record.obligationVerdicts.entries()) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return { ok: false, issues: [`Coverage obligation verdict ${index} is invalid.`] };
    }
    const entry = candidate as Record<string, unknown>;
    const entryUnknown = Object.keys(entry).filter(
      (key) =>
        key !== "obligationId" && key !== "verdict" && key !== "severity" &&
        key !== "rationale" && key !== "evidenceRefs",
    );
    if (entryUnknown.length > 0) {
      return { ok: false, issues: [`Coverage obligation verdict ${index} has unknown fields: ${entryUnknown.join(", ")}.`] };
    }
    const obligationId = entry.obligationId;
    const verdict = entry.verdict;
    const severity = entry.severity;
    const rationale = entry.rationale;
    const evidenceRefs = entry.evidenceRefs;
    if (typeof obligationId !== "string" || !options.obligationIds.includes(obligationId)) {
      return { ok: false, issues: [`Coverage verdict cites obligation ${String(obligationId)}, which was never durably recorded.`] };
    }
    if (seenObligations.has(obligationId)) {
      return { ok: false, issues: [`Duplicate coverage verdict for obligation ${obligationId}.`] };
    }
    seenObligations.add(obligationId);
    if (!(COVERAGE_VERDICT_VALUES as readonly string[]).includes(verdict as string)) {
      return {
        ok: false,
        issues: [`Obligation ${obligationId} has an invalid verdict "${String(verdict)}" (or a finding category used as a verdict).`],
      };
    }
    if (severity !== "blocking" && severity !== "advisory") {
      return { ok: false, issues: [`Obligation ${obligationId} verdict has an invalid severity.`] };
    }
    if (typeof rationale !== "string" || rationale.trim().length === 0) {
      return { ok: false, issues: [`Obligation ${obligationId} verdict requires a rationale.`] };
    }
    if (!Array.isArray(evidenceRefs) || evidenceRefs.some((ref) => typeof ref !== "string")) {
      return { ok: false, issues: [`Obligation ${obligationId} verdict requires evidenceRefs.`] };
    }
    obligationVerdicts.push({
      obligationId,
      verdict: verdict as string,
      severity,
      rationale,
      evidenceRefs: [...(evidenceRefs as string[])],
    });
  }
  for (const obligationId of options.obligationIds) {
    if (!seenObligations.has(obligationId)) {
      return { ok: false, issues: [`Derived obligation ${obligationId} has no recorded verdict.`] };
    }
  }
  if (!Array.isArray(record.findings)) {
    return { ok: false, issues: ["Coverage verdict requires findings."] };
  }
  const seenFindings = new Set<string>();
  const findings: CoverageFindingToolInput[] = [];
  for (const [index, candidate] of record.findings.entries()) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return { ok: false, issues: [`Coverage finding ${index} is invalid.`] };
    }
    const entry = candidate as Record<string, unknown>;
    const entryUnknown = Object.keys(entry).filter(
      (key) =>
        key !== "id" && key !== "category" && key !== "severity" && key !== "claim" &&
        key !== "evidenceRefs" && key !== "requirementId" && key !== "location",
    );
    if (entryUnknown.length > 0) {
      return { ok: false, issues: [`Coverage finding ${index} has unknown fields: ${entryUnknown.join(", ")}.`] };
    }
    const id = entry.id;
    const category = entry.category;
    const severity = entry.severity;
    const claim = entry.claim;
    const evidenceRefs = entry.evidenceRefs;
    if (typeof id !== "string" || id.trim().length === 0) {
      return { ok: false, issues: [`Coverage finding ${index} requires a non-empty id.`] };
    }
    if (seenFindings.has(id)) {
      return { ok: false, issues: [`Duplicate coverage finding id ${id}.`] };
    }
    seenFindings.add(id);
    if (!(PLANNING_FINDING_CATEGORIES as readonly string[]).includes(category as string)) {
      return {
        ok: false,
        issues: [`Finding ${id} category "${String(category)}" is not a valid finding category (or is a verdict word used as a category).`],
      };
    }
    if (severity !== "blocking" && severity !== "advisory") {
      return { ok: false, issues: [`Finding ${id} has an invalid severity.`] };
    }
    if (typeof claim !== "string" || claim.trim().length === 0) {
      return { ok: false, issues: [`Finding ${id} requires a non-empty claim.`] };
    }
    if (!Array.isArray(evidenceRefs) || evidenceRefs.some((ref) => typeof ref !== "string")) {
      return { ok: false, issues: [`Finding ${id} requires evidenceRefs.`] };
    }
    const requirementId = entry.requirementId;
    const location = entry.location;
    if (requirementId !== undefined && (typeof requirementId !== "string" || requirementId.trim().length === 0)) {
      return { ok: false, issues: [`Finding ${id} has an invalid requirementId.`] };
    }
    if (location !== undefined && (typeof location !== "string" || location.trim().length === 0)) {
      return { ok: false, issues: [`Finding ${id} has an invalid location.`] };
    }
    findings.push({
      id,
      category: category as string,
      severity,
      claim,
      evidenceRefs: [...(evidenceRefs as string[])],
      ...(requirementId === undefined ? {} : { requirementId: requirementId as string }),
      ...(location === undefined ? {} : { location: location as string }),
    });
  }
  if (options.priorReviewId !== undefined) {
    if (!Array.isArray(record.priorFindingChecks)) {
      return { ok: false, issues: ["A coverage re-review must check each prior finding."] };
    }
    const expected = new Set(options.priorFindingIds ?? []);
    const seen = new Set<string>();
    const priorFindingChecks: CoveragePriorFindingCheckInput[] = [];
    for (const [index, candidate] of record.priorFindingChecks.entries()) {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        return { ok: false, issues: [`Prior-finding check ${index} is invalid.`] };
      }
      const entry = candidate as Record<string, unknown>;
      const entryUnknown = Object.keys(entry).filter(
        (key) => key !== "priorFindingId" && key !== "status" && key !== "rationale",
      );
      if (entryUnknown.length > 0) {
        return { ok: false, issues: [`Prior-finding check ${index} has unknown fields: ${entryUnknown.join(", ")}.`] };
      }
      const priorFindingId = entry.priorFindingId;
      const status = entry.status;
      const rationale = entry.rationale;
      if (typeof priorFindingId !== "string" || !expected.has(priorFindingId)) {
        return { ok: false, issues: [`Prior-finding check ${index} cites an unknown prior finding.`] };
      }
      if (seen.has(priorFindingId)) {
        return { ok: false, issues: [`Duplicate prior-finding check for ${priorFindingId}.`] };
      }
      seen.add(priorFindingId);
      if (status !== "resolved" && status !== "outstanding") {
        return { ok: false, issues: [`Prior-finding check for ${priorFindingId} has an invalid status.`] };
      }
      if (typeof rationale !== "string" || rationale.trim().length === 0) {
        return { ok: false, issues: [`Prior-finding check for ${priorFindingId} requires a rationale.`] };
      }
      priorFindingChecks.push({ priorFindingId, status, rationale });
    }
    for (const id of expected) {
      if (!seen.has(id)) {
        return { ok: false, issues: [`Re-review leaves prior finding ${id} unchecked (every prior finding must be checked).`] };
      }
    }
    return { ok: true, value: { obligationVerdicts, findings, priorFindingChecks } };
  }
  if (record.priorFindingChecks !== undefined) {
    return { ok: false, issues: ["An initial coverage review checks no prior findings."] };
  }
  return { ok: true, value: { obligationVerdicts, findings } };
}

function assertReviewerContext(
  context: ToolExecutionContext,
  runId: string,
  sessionId: string,
  runtimeId: string,
): void {
  if (
    context.runId !== runId ||
    context.sessionId !== sessionId ||
    context.actor.role !== "verifier" ||
    context.actor.id !== runtimeId
  ) {
    throw new Error("Coverage review tool context is stale or foreign to its kernel binding.");
  }
}

// ---------------------------------------------------------------------------
// Architect lifecycle tool: request a coverage review of the current revision.
// ---------------------------------------------------------------------------

export interface RequestCoverageReviewToolOptions {
  store: SchedulerStore;
  clock?: () => string;
}

export function createRequestCoverageReviewTool(
  options: RequestCoverageReviewToolOptions,
): NativeTool<{ reviewId?: string }> {
  const clock = options.clock ?? (() => new Date().toISOString());
  return {
    definition: {
      name: "request_coverage_review",
      description:
        "Request an independent source-coverage review of the current plan revision. The reviewer derives obligations from the source first, then judges the plan; after a revision the next request becomes a scoped re-review of the prior findings.",
      inputSchema: {
        type: "object",
        properties: { reviewId: { type: "string", minLength: 1 } },
        required: [],
        additionalProperties: false,
      },
      readOnly: false,
      effect: "none",
      lifecycle: true,
    },
    validate: (input) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return { ok: false, issues: ["Coverage review request must be an object."] };
      }
      const record = input as Record<string, unknown>;
      const unknown = Object.keys(record).filter((key) => key !== "reviewId");
      if (unknown.length > 0) {
        return { ok: false, issues: [`Coverage review request has unknown fields: ${unknown.join(", ")}.`] };
      }
      if (record.reviewId !== undefined && (typeof record.reviewId !== "string" || record.reviewId.trim().length === 0)) {
        return { ok: false, issues: ["Coverage review request reviewId must be a non-empty string."] };
      }
      return {
        ok: true,
        value: record.reviewId === undefined ? {} : { reviewId: (record.reviewId as string).trim() },
      };
    },
    execute: async (input, context): Promise<ToolExecutionOutput> => {
      if (context.actor.role !== "architect") {
        return toolError("architect_only", "Only the Architect may use this tool.");
      }
      const projection = rebuildSchedulerProjection(options.store.readRun(context.runId));
      if (projection.planningPolicyVersion !== 1 || !projection.planning) {
        return toolError(
          "planning_not_configured",
          "Coverage review requires a new-policy run with a registered approved source.",
        );
      }
      const planning = projection.planning;
      if (!planning.plan) {
        return toolError(
          "plan_not_drafted",
          "No initial planning revision exists; draft the plan before requesting its coverage review.",
        );
      }
      const manifest = planning.source.manifestsById[planning.source.currentManifestId];
      const revisionId = planning.plan.currentRevisionId;
      const digest = planning.plan.currentDigest;
      const reviewId = input.reviewId ?? `coverage_${revisionId}`;
      const current = planning.coverageReview;
      if (
        current &&
        current.planRevisionId === revisionId &&
        current.planRevisionDigest === digest &&
        current.sourceReadManifestId === manifest.manifestId
      ) {
        return toolError(
          "coverage_review_current",
          `The current plan revision already has coverage review ${current.id}; revise the plan to request a scoped re-review.`,
        );
      }
      const existing = planning.coverageRequests[reviewId];
      if (existing) {
        if (
          existing.planRevisionId !== revisionId ||
          existing.planRevisionDigest !== digest ||
          existing.sourceManifestId !== manifest.manifestId
        ) {
          return toolError(
            "stale_coverage_review_request",
            `Coverage review ${reviewId} was requested for another plan revision or source; revise or amend, then request again.`,
          );
        }
        return toolError(
          "coverage_review_already_requested",
          `Coverage review ${reviewId} is already requested for the current plan revision; the runner drives it to completion.`,
        );
      }
      const priorReviewId = current?.id;
      try {
        const appended = options.store.append({
          runId: context.runId,
          type: "planning.coverage_review_requested",
          occurredAt: clock(),
          actor: { role: "architect", id: context.actor.id },
          idempotencyKey: `planning-coverage-request:${reviewId}`,
          payload: {
            reviewId,
            planRevisionId: revisionId,
            planRevisionDigest: digest,
            sourceManifestId: manifest.manifestId,
            ...(priorReviewId !== undefined ? { priorReviewId } : {}),
            requestedAt: clock(),
          },
        });
        return {
          content: [{ type: "json", value: appended }],
          isError: false,
          lifecycle: { type: "architect_action", action: "plan_reconciled", referenceId: reviewId },
        };
      } catch (error) {
        return toolError(
          "mechanical_transition_rejected",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}

function toolError(code: string, message: string): ToolExecutionOutput {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message },
  };
}

// ---------------------------------------------------------------------------
// Plan risk (P6.5 critic reuse), host capabilities, and the reviewer broker.
// ---------------------------------------------------------------------------

/**
 * High-risk plans earn same-pass critic checks. Reuses P6.5's pure
 * `assessPlanRisk` over the planning revision's own task graph (no scheduler
 * tasks exist yet); the Architect declares nothing here, so only the
 * structural signals apply.
 */
export function assessCoveragePlanRisk(revision: ExecutionPlanRevision): PlanRiskAssessment {
  return assessPlanRisk({
    architectDeclaration: "low",
    stricterQualification: false,
    tasks: revision.tasks.map((task) => ({
      id: task.id,
      dependencies: [...task.dependencies],
      status: "planned" as const,
      kind: "implementation" as const,
    })),
  });
}

/**
 * Host capabilities for the ready path. The coverage-selection observation is
 * current (it names this runtime's configured candidates); every other field
 * carries T1a's inspected seed until its owning task re-observes it (T4 owns
 * the worker ceiling, T6 the issue ceiling — recorded limits, not fresh
 * observations).
 */
export function buildCoverageHostCapabilities(input: {
  coverageCandidateRuntimeIds: readonly string[];
  recordedAt: string;
}): HostPlanningCapabilities {
  const candidates = input.coverageCandidateRuntimeIds.filter((id) => id.trim().length > 0);
  return {
    ...structuredClone(T1A_SEEDED_HOST_PLANNING_CAPABILITIES),
    independentReviewerSelection: candidates.length > 0
      ? {
          status: "enforced",
          evidence:
            `Coverage reviewer selected by RuntimeRouter.selectVerifier over ${candidates.length} ` +
            `configured candidate(s); independence recorded distinct_model|fresh_context (planning-review.ts).`,
        }
      : {
          status: "unavailable",
          evidence: "No coverage reviewer candidates configured; coverage review records an explicit outstanding gate.",
        },
    recordedAt: input.recordedAt,
  };
}

export function createCoverageReviewBroker(
  input: Omit<
    Parameters<typeof createInspectionTools>[0],
    "capabilityRole" | "capabilityBroker"
  >,
): ReturnType<typeof createInspectionTools> {
  const broker = createInspectionTools({
    ...input,
    capabilityRole: "verifier",
    capabilityBroker: "coverage",
  });
  assertRoleToolSurface(
    "verifier",
    "coverage",
    broker.definitions().map((definition) => definition.name),
  );
  return broker;
}

/** Same-pass high-risk checks from the P6.5 plan critic (optional hook; reused, never duplicated). */
export interface CoveragePlanCriticHook {
  critique(input: {
    runId: string;
    reviewId: string;
    planRevision: ExecutionPlanRevision;
    obligations: readonly DerivedObligation[];
  }): Promise<{ findings: PlanningFinding[] }>;
}

// ---------------------------------------------------------------------------
// The independent coverage reviewer runtime (two passes, separate sessions).
// ---------------------------------------------------------------------------

export interface CoverageDurableGuidanceSnapshot {
  id: string;
  text: string;
}

export interface NativeCoverageReviewRequest {
  runId: string;
  reviewId: string;
  architectRuntimeId: string;
  manifest: ApprovedSourceManifest;
  planRevision: ExecutionPlanRevision;
  ledger: {
    id: string;
    requirements: readonly SourceRequirement[];
    phases: readonly ExecutionPlanPhase[];
  };
  objective: string;
  guidance: readonly CoverageDurableGuidanceSnapshot[];
  /** Set only for a scoped re-review; withheld from the deriving pass. */
  priorReview?: CoverageReview;
  preferredRuntimeId?: string;
  providerRetryDeadlineMs?: number;
  signal?: AbortSignal;
}

export type CoverageCriticHookOutcome = "ran" | "skipped:low_risk" | "skipped:no_hook";

export type NativeCoverageReviewResult =
  | {
      readonly status: "reviewed";
      readonly reviewId: string;
      readonly review: CoverageReview;
      readonly deriveSessionId: string;
      readonly verdictSessionId: string;
      readonly runtimeId: string;
      readonly independence: ReviewerIndependence;
      readonly risk: PlanRiskAssessment;
      readonly criticHook: CoverageCriticHookOutcome;
      readonly deriveMessages: readonly AgentMessage[];
      readonly verdictMessages: readonly AgentMessage[];
      readonly replayed: boolean;
    }
  | {
      readonly status: "unavailable";
      readonly reviewId: string;
      readonly reason: string;
      readonly detail?: string;
      readonly runtimeId?: string;
    }
  | {
      readonly status: "suspended";
      readonly reviewId: string;
      readonly sessionId: string;
      readonly runtimeId: string;
      readonly reason: string;
      readonly error?: string;
      readonly messages: readonly AgentMessage[];
    };

export interface NativeCoverageReviewRuntimeOptions {
  git?: RunGitExecutionContext;
  executionGrants?: ExecutionGrantAuthority;
  router: RuntimeRouter;
  candidates: readonly AgentRuntimeCandidate[];
  models: ReadonlyMap<string, AgentModel>;
  coverageRuntimeIds: readonly string[];
  sessions: SqliteAgentSessionStore;
  artifacts: ArtifactStore;
  evidenceStore: EvidenceStore;
  /** Repository root the reviewer may read (read-only tools only). */
  projectRoot: string;
  authority: CoverageReviewAuthority;
  readSource?: CoverageSourceReader;
  budgetLedger?: BudgetLedger;
  ledger?: ToolInvocationLedger;
  contextLimits?: ContextLimits;
  outputTokenReserve?: number;
  modelCostEstimators?: ReadonlyMap<string, ModelCostEstimator>;
  modelCostBases?: ReadonlyMap<string, ModelCostBasisSnapshot>;
  providerRetryRuntime?: RunnerProviderRetryRuntime;
  contextManifests?: ContextManifestStore;
  recordContextPackText?: boolean;
  planCritic?: CoveragePlanCriticHook;
  maxTurns?: number;
  clock?: () => string;
  permissions?: SqlitePermissionStore;
}

export interface CoverageReviewDriver {
  candidateRuntimeIds: readonly string[];
  review(input: NativeCoverageReviewRequest): Promise<NativeCoverageReviewResult>;
}

/** Supplies host capabilities for the ready path; the factory wires an honest observed record. */
export type PlanningHostCapabilitiesProvider = () => HostPlanningCapabilities;

/**
 * N6: bound on suspended-review retries per review. Follows the
 * DEFAULT_REPAIR_PLAN_LIMIT constant pattern but is an independent budget
 * (G-5: repair cycles and coverage suspensions are different concerns).
 * On exhaustion the runtime records an explicit outstanding gate for the
 * owner and never loops.
 */
export const DEFAULT_COVERAGE_SUSPENDED_RETRY_LIMIT = 3;

/** Terminal gate reasons live in planning-projection.ts (the reducer owns them); re-exported so existing importers keep working. */
export { TERMINAL_COVERAGE_GATE_REASONS };

/**
 * B4: the coverage session identity includes the selected reviewer runtime
 * and independence mode. Failover to a fallback reviewer opens a new fresh
 * session instead of colliding with the suspended reviewer's session.
 */
export function coverageSessionId(
  runId: string,
  reviewId: string,
  contextDigest: string,
  mode: "derive" | "ownview" | "verdict",
  runtimeId: string,
  independence: ReviewerIndependence,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([runId, reviewId, contextDigest, mode, runtimeId, independence]))
    .digest("hex")
    .slice(0, 24);
  return `coverage:${runId}:${digest}`;
}

export class NativeCoverageReviewRuntime {
  private readonly candidateById: Map<string, AgentRuntimeCandidate>;
  private readonly clock: () => string;

  constructor(private readonly options: NativeCoverageReviewRuntimeOptions) {
    this.candidateById = new Map(
      options.candidates.map((candidate) => [candidate.runtimeId, candidate]),
    );
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async review(request: NativeCoverageReviewRequest): Promise<NativeCoverageReviewResult> {
    assertCoverageReviewRequest(request);
    if (
      request.preferredRuntimeId &&
      !this.options.coverageRuntimeIds.includes(request.preferredRuntimeId)
    ) {
      throw new Error(
        `Preferred coverage reviewer runtime ${request.preferredRuntimeId} is not configured for this Build.`,
      );
    }
    const isReReview = request.priorReview !== undefined;
    const sections = await this.readVerifiedSections(request);
    if (typeof sections === "string") {
      return await this.recordUnavailable(request, "source_bytes_unavailable", sections);
    }
    const risk = assessCoveragePlanRisk(request.planRevision);
    // OA-3 via the shared selector: prefer a model distinct from the
    // Architect's; no change authors exist yet at planning time, so only the
    // Architect identity is excluded. The fallback is recorded fresh_context.
    const selection = this.options.router.selectVerifier({
      requiredCapabilities: ["code"],
      candidateRuntimeIds: request.preferredRuntimeId
        ? [request.preferredRuntimeId]
        : this.options.coverageRuntimeIds,
      architectRuntimeId: request.architectRuntimeId,
      acceptedChangeAuthorRuntimeIds: [],
    });
    if (selection.status === "unavailable") {
      return await this.recordUnavailable(request, selection.reason);
    }
    const candidate = this.candidateById.get(selection.runtime.runtimeId);
    const model = this.options.models.get(selection.runtime.runtimeId);
    if (!candidate || !model) {
      return await this.recordUnavailable(request, "runtime_unavailable", undefined, selection.runtime.runtimeId);
    }
    // B2: obligations are source-derived and plan-independent. Blind
    // derivation runs for the first review and again only when the source
    // manifest revision changes; a re-review after a plan-only revision
    // reuses the current blind set instead of re-deriving with the plan.
    let obligations: readonly DerivedObligation[];
    let deriveSessionId: string;
    let deriveMessages: readonly AgentMessage[];
    let reusedFromReviewId: string | undefined;
    if (!isReReview) {
      const derive = await this.runDerivePass({ request, candidate, model, sections, independence: selection.independence, risk });
      if (derive.status !== "derived") return derive.result;
      obligations = derive.obligations;
      deriveSessionId = derive.sessionId;
      deriveMessages = derive.messages;
    } else {
      const blind = this.options.authority.latestBlindObligationsForManifest(request.runId, request.manifest.manifestId);
      const blindCurrent = blind !== undefined &&
        blind.sourceManifestId === request.manifest.manifestId &&
        blind.sourceManifestDigest === request.manifest.artifactDigest;
      if (blindCurrent) {
        obligations = blind!.obligations;
        reusedFromReviewId = blind!.reviewId;
        // No deriving turn ran for this re-review (reuse, not re-derive);
        // the own-view pass below is the re-review's first model turn.
        deriveSessionId = "";
        deriveMessages = [];
      } else {
        // Source changed: a fresh blind derivation in a fresh session with
        // an empty event list, identical to the initial review.
        const derive = await this.runDerivePass({ request, candidate, model, sections, independence: selection.independence, risk });
        if (derive.status !== "derived") return derive.result;
        obligations = derive.obligations;
        deriveSessionId = derive.sessionId;
        deriveMessages = derive.messages;
        reusedFromReviewId = request.reviewId;
      }
      const ownView = await this.runOwnViewPass({
        request,
        candidate,
        model,
        obligations,
        reusedFromReviewId: reusedFromReviewId!,
        independence: selection.independence,
      });
      if (ownView.status !== "viewed") return ownView.result;
      // OA-10 #2: the own view is durable, so the prior findings may now be
      // released — and only now. The reducer refuses a release without the
      // recorded view, and the verdict without the release.
      this.options.authority.releasePriorFindings({
        runId: request.runId,
        reviewId: request.reviewId,
        priorReviewId: request.priorReview!.id,
        occurredAt: this.clock(),
      });
    }
    let criticChecksJson: string | undefined;
    let criticHook: CoverageCriticHookOutcome = "skipped:no_hook";
    if (risk.risk === "high") {
      if (this.options.planCritic) {
        const critic = await this.options.planCritic.critique({
          runId: request.runId,
          reviewId: request.reviewId,
          planRevision: request.planRevision,
          obligations,
        });
        assertCriticFindings(critic.findings);
        criticChecksJson = JSON.stringify(critic.findings, null, 2);
        criticHook = "ran";
      }
    } else {
      criticHook = this.options.planCritic ? "skipped:low_risk" : "skipped:no_hook";
    }
    return await this.runVerdictPass({
      request,
      candidate,
      model,
      obligations,
      ...(reusedFromReviewId !== undefined ? { reusedFromReviewId } : {}),
      criticChecksJson,
      criticHook,
      risk,
      deriveSessionId,
      deriveMessages,
      independence: selection.independence,
    });
  }

  private async recordUnavailable(
    request: NativeCoverageReviewRequest,
    reason: string,
    detail?: string,
    runtimeId?: string,
  ): Promise<NativeCoverageReviewResult> {
    // Never controller self-review, never relabelled: the gate is recorded
    // under its own reason and readiness stays blocked until a new request.
    const already = this.options.authority.coverageUnavailable(request.runId);
    if (already?.reviewId !== request.reviewId || already.reason !== reason) {
      this.options.authority.recordUnavailable({
        runId: request.runId,
        reviewId: request.reviewId,
        reason,
        ...(detail !== undefined ? { detail } : {}),
        occurredAt: this.clock(),
      });
    }
    return {
      status: "unavailable",
      reviewId: request.reviewId,
      reason,
      ...(detail !== undefined ? { detail } : {}),
      ...(runtimeId !== undefined ? { runtimeId } : {}),
    };
  }

  private async readVerifiedSections(
    request: NativeCoverageReviewRequest,
  ): Promise<{ id: string; title?: string; digest: string; text: string }[] | string> {
    let bytes: Uint8Array;
    try {
      bytes = this.options.readSource
        ? await this.options.readSource(request.manifest)
        : await this.options.artifacts.get(request.manifest.artifactDigest);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    if (bytes.length !== request.manifest.byteLength) {
      return `Supplied source bytes have length ${bytes.length}, not the manifest's recorded ${request.manifest.byteLength}.`;
    }
    if (computeArtifactDigest(bytes) !== request.manifest.artifactDigest) {
      return "Supplied source bytes do not match the manifest's recorded artifact digest.";
    }
    const sections: { id: string; title?: string; digest: string; text: string }[] = [];
    for (const section of request.manifest.sections) {
      const slice = bytes.subarray(section.startByte, section.endByte);
      if (slice.length !== section.endByte - section.startByte) {
        return `Source section ${section.id} could only be read partially; a truncated section never counts as read.`;
      }
      if (computeArtifactDigest(slice) !== section.digest) {
        return `Source section ${section.id} does not match its recorded digest.`;
      }
      sections.push({
        id: section.id,
        ...(section.title !== undefined ? { title: section.title } : {}),
        digest: section.digest,
        text: Buffer.from(slice).toString("utf8"),
      });
    }
    return sections;
  }

  private async runDerivePass(input: {
    request: NativeCoverageReviewRequest;
    candidate: AgentRuntimeCandidate;
    model: AgentModel;
    sections: { id: string; title?: string; digest: string; text: string }[];
    independence: ReviewerIndependence;
    risk: PlanRiskAssessment;
  }): Promise<
    | { status: "derived"; sessionId: string; obligations: readonly DerivedObligation[]; messages: readonly AgentMessage[] }
    | { status: "not-derived"; result: NativeCoverageReviewResult }
  > {
    const { request, candidate, model, sections, independence } = input;
    const contextLimits = this.options.contextLimits ?? { maxBytes: 512 * 1024, maxEstimatedTokens: 128 * 1024 };
    let pack: ReturnType<typeof buildCoverageDeriveContext>;
    try {
      // B2: blind derivation — source + amendments + objective/guidance
      // only. Never the plan, never prior findings. Runs for the first
      // review and again only when the source manifest revision changes.
      pack = buildCoverageDeriveContext({
        limits: contextLimits,
        manifest: {
          manifestId: request.manifest.manifestId,
          sourceId: request.manifest.sourceId,
          artifactDigest: request.manifest.artifactDigest,
          byteLength: request.manifest.byteLength,
          sections: request.manifest.sections.map((section) => ({
            id: section.id,
            ...(section.title !== undefined ? { title: section.title } : {}),
            startByte: section.startByte,
            endByte: section.endByte,
            digest: section.digest,
          })),
          ...(request.manifest.amendment !== undefined ? { amendment: request.manifest.amendment } : {}),
        },
        sections,
        objective: request.objective,
        guidance: request.guidance.map((item) => ({ ...item })),
      });
    } catch (error) {
      if (error instanceof ProtectedContextOverflowError) {
        return {
          status: "not-derived",
          result: await this.recordUnavailable(
            request,
            "source_pack_overflow",
            `Protected source context (${error.requiredBytes} bytes) exceeds the limit (${error.limitBytes} bytes); an incomplete review never counts.`,
          ),
        };
      }
      throw error;
    }
    const sessionId = coverageSessionId(request.runId, request.reviewId, pack.digest, "derive", candidate.runtimeId, independence);
    await recordContextPack({
      store: this.options.contextManifests,
      artifacts: this.options.artifacts,
      recordPackText: this.options.recordContextPackText,
      runId: request.runId,
      sessionId,
      actor: { role: "verifier", id: candidate.runtimeId },
      role: "verifier",
      purpose: "coverage:derive",
      limits: contextLimits,
      pack,
      recordedAt: this.clock(),
    });
    const systemMessage: AgentMessage = {
      id: "coverage-derive-system",
      role: "system",
      content: coverageReviewerSystemPrompt("derive"),
    };
    const contextMessage: AgentMessage = {
      id: `coverage-context:${pack.digest}`,
      role: "user",
      content: pack.text,
    };
    let messages: AgentMessage[] = [systemMessage, contextMessage];
    const sessionEvents = this.options.sessions.events(sessionId);
    const freshStart = sessionEvents.length === 0;
    if (freshStart) {
      assertFreshContextRequest({
        independence,
        priorEventCount: sessionEvents.length,
        messages,
        packMessageIds: [systemMessage.id, contextMessage.id],
      });
      await this.options.sessions.create({
        sessionId,
        runId: request.runId,
        actor: { role: "verifier", id: candidate.runtimeId },
        occurredAt: this.clock(),
      });
      assertFreshContextSessionStarted(independence, this.options.sessions.events(sessionId));
    } else {
      const recovered = await this.options.sessions.load(sessionId);
      if (
        recovered.actor.role !== "verifier" ||
        recovered.actor.id !== candidate.runtimeId ||
        recovered.runId !== request.runId
      ) {
        throw new Error(
          independence === "fresh_context"
            ? "A fresh-context reviewer cannot resume or reuse another session."
            : "Recovered coverage session identity does not match the request.",
        );
      }
      if (recovered.checkpoint) messages = [...recovered.checkpoint.messages];
      if (!messages.some((message) => message.id === contextMessage.id)) {
        messages.push(contextMessage);
      }
    }
    const already = this.options.authority.recordedObligations(request.runId, request.reviewId);
    if (already) {
      this.options.sessions.complete(sessionId, this.clock());
      return { status: "derived", sessionId, obligations: already.obligations, messages };
    }
    const broker = createCoverageReviewBroker({
      git: this.options.git,
      executionGrants: this.options.executionGrants,
      workspacePath: this.options.projectRoot,
      artifacts: this.options.artifacts,
      evidenceStore: this.options.evidenceStore,
      runId: request.runId,
      clock: this.clock,
      ...(this.options.ledger ? { ledger: this.options.ledger } : {}),
      ...(this.options.permissions ? { permissions: this.options.permissions } : {}),
      lifecycleTool: createRecordCoverageObligationsTool({
        authority: this.options.authority,
        runId: request.runId,
        reviewId: request.reviewId,
        sourceManifestId: request.manifest.manifestId,
        sourceManifestDigest: request.manifest.artifactDigest,
        runtimeId: candidate.runtimeId,
        sessionId,
        clock: this.clock,
      }),
    });
    const result = await runAgentLoop({
      model: this.budgetedModel(model, candidate, request.runId, sessionId),
      registry: this.budgetedTools(broker, request.runId),
      context: {
        runId: request.runId,
        sessionId,
        actor: { role: "verifier", id: candidate.runtimeId },
        workspacePath: this.options.projectRoot,
        signal: request.signal,
      },
      initialMessages: messages,
      maxTurns: this.options.maxTurns ?? 20,
      signal: request.signal,
      providerRetry: {
        runtimeId: candidate.runtimeId,
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        deadlineMs: request.providerRetryDeadlineMs,
        classify: classifyProviderFailure,
        ...(this.options.providerRetryRuntime
          ? {
              now: this.options.providerRetryRuntime.now,
              random: this.options.providerRetryRuntime.random,
              sleep: this.options.providerRetryRuntime.sleep,
            }
          : {}),
      },
      onCheckpoint: async (checkpoint) => {
        await this.options.sessions.checkpoint(sessionId, checkpoint, this.clock());
      },
    });
    if (result.status === "verifier_expectations_recorded") {
      const recorded = this.options.authority.recordedObligations(request.runId, request.reviewId);
      if (!recorded || result.reviewId !== request.reviewId) {
        throw new Error("Coverage obligations were not durable after the deriving pass.");
      }
      this.options.sessions.complete(sessionId, this.clock());
      return { status: "derived", sessionId, obligations: recorded.obligations, messages: result.messages };
    }
    if (result.status === "suspended") {
      return { status: "not-derived", result: this.suspend(sessionId, candidate, request, result) };
    }
    this.options.sessions.suspend(sessionId, `unexpected_coverage_lifecycle:${result.status}`, undefined, this.clock());
    return {
      status: "not-derived",
      result: {
        status: "suspended",
        reviewId: request.reviewId,
        sessionId,
        runtimeId: candidate.runtimeId,
        reason: `unexpected_coverage_lifecycle:${result.status}`,
        messages: result.messages,
      },
    };
  }

  private async runOwnViewPass(input: {
    request: NativeCoverageReviewRequest;
    candidate: AgentRuntimeCandidate;
    model: AgentModel;
    obligations: readonly DerivedObligation[];
    reusedFromReviewId: string;
    independence: ReviewerIndependence;
  }): Promise<
    | { status: "viewed"; sessionId: string; messages: readonly AgentMessage[] }
    | { status: "not-viewed"; result: NativeCoverageReviewResult }
  > {
    const { request, candidate, model, obligations, reusedFromReviewId, independence } = input;
    const priorReview = request.priorReview!;
    const contextLimits = this.options.contextLimits ?? { maxBytes: 512 * 1024, maxEstimatedTokens: 128 * 1024 };
    let pack: ReturnType<typeof buildCoverageVerdictContext>;
    try {
      // B2/EP42: the re-review's first turn — reused blind obligations plus
      // the corrected plan, but never the prior findings (withheld until
      // the own view is durable).
      pack = buildCoverageVerdictContext({
        limits: contextLimits,
        obligationsJson: JSON.stringify(obligations, null, 2),
        planRevisionJson: JSON.stringify(request.planRevision, null, 2),
        ledgerJson: JSON.stringify(request.ledger, null, 2),
      });
    } catch (error) {
      if (error instanceof ProtectedContextOverflowError) {
        return {
          status: "not-viewed",
          result: await this.recordUnavailable(
            request,
            "plan_pack_overflow",
            `Protected plan context (${error.requiredBytes} bytes) exceeds the limit (${error.limitBytes} bytes); an incomplete review never counts.`,
          ),
        };
      }
      throw error;
    }
    const sessionId = coverageSessionId(request.runId, request.reviewId, pack.digest, "ownview", candidate.runtimeId, independence);
    await recordContextPack({
      store: this.options.contextManifests,
      artifacts: this.options.artifacts,
      recordPackText: this.options.recordContextPackText,
      runId: request.runId,
      sessionId,
      actor: { role: "verifier", id: candidate.runtimeId },
      role: "verifier",
      purpose: "coverage:rereview-ownview",
      limits: contextLimits,
      pack,
      recordedAt: this.clock(),
    });
    const systemMessage: AgentMessage = {
      id: "coverage-rereview-ownview-system",
      role: "system",
      content: coverageReviewerSystemPrompt("rereview-ownview"),
    };
    const contextMessage: AgentMessage = {
      id: `coverage-context:${pack.digest}`,
      role: "user",
      content: pack.text,
    };
    let messages: AgentMessage[] = [systemMessage, contextMessage];
    const sessionEvents = this.options.sessions.events(sessionId);
    const freshStart = sessionEvents.length === 0;
    if (freshStart) {
      assertFreshContextRequest({
        independence,
        priorEventCount: sessionEvents.length,
        messages,
        packMessageIds: [systemMessage.id, contextMessage.id],
      });
      await this.options.sessions.create({
        sessionId,
        runId: request.runId,
        actor: { role: "verifier", id: candidate.runtimeId },
        occurredAt: this.clock(),
      });
      assertFreshContextSessionStarted(independence, this.options.sessions.events(sessionId));
    } else {
      const recovered = await this.options.sessions.load(sessionId);
      if (
        recovered.actor.role !== "verifier" ||
        recovered.actor.id !== candidate.runtimeId ||
        recovered.runId !== request.runId
      ) {
        throw new Error(
          independence === "fresh_context"
            ? "A fresh-context reviewer cannot resume or reuse another session."
            : "Recovered coverage session identity does not match the request.",
        );
      }
      if (recovered.checkpoint) messages = [...recovered.checkpoint.messages];
      if (!messages.some((message) => message.id === contextMessage.id)) {
        messages.push(contextMessage);
      }
    }
    const already = this.options.authority.correctionView(request.runId, request.reviewId);
    if (already) {
      this.options.sessions.complete(sessionId, this.clock());
      return { status: "viewed", sessionId, messages };
    }
    // The plan is shown in this turn: record the durable delivery before the
    // model runs, so a later true-stamped derivation for this review is
    // refused (B2).
    this.options.authority.recordPlanDelivered({
      runId: request.runId,
      reviewId: request.reviewId,
      planRevisionId: request.planRevision.revisionId,
      planRevisionDigest: request.planRevision.digest,
      sourceManifestId: request.manifest.manifestId,
      sessionId,
      occurredAt: this.clock(),
    });
    const broker = createCoverageReviewBroker({
      git: this.options.git,
      executionGrants: this.options.executionGrants,
      workspacePath: this.options.projectRoot,
      artifacts: this.options.artifacts,
      evidenceStore: this.options.evidenceStore,
      runId: request.runId,
      clock: this.clock,
      ...(this.options.ledger ? { ledger: this.options.ledger } : {}),
      ...(this.options.permissions ? { permissions: this.options.permissions } : {}),
      lifecycleTool: createRecordCoverageCorrectionViewTool({
        authority: this.options.authority,
        runId: request.runId,
        reviewId: request.reviewId,
        priorReviewId: priorReview.id,
        reusedFromReviewId,
        sourceManifestId: request.manifest.manifestId,
        sourceManifestDigest: request.manifest.artifactDigest,
        runtimeId: candidate.runtimeId,
        sessionId,
        clock: this.clock,
      }),
    });
    const result = await runAgentLoop({
      model: this.budgetedModel(model, candidate, request.runId, sessionId),
      registry: this.budgetedTools(broker, request.runId),
      context: {
        runId: request.runId,
        sessionId,
        actor: { role: "verifier", id: candidate.runtimeId },
        workspacePath: this.options.projectRoot,
        signal: request.signal,
      },
      initialMessages: messages,
      maxTurns: this.options.maxTurns ?? 20,
      signal: request.signal,
      providerRetry: {
        runtimeId: candidate.runtimeId,
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        deadlineMs: request.providerRetryDeadlineMs,
        classify: classifyProviderFailure,
        ...(this.options.providerRetryRuntime
          ? {
              now: this.options.providerRetryRuntime.now,
              random: this.options.providerRetryRuntime.random,
              sleep: this.options.providerRetryRuntime.sleep,
            }
          : {}),
      },
      onCheckpoint: async (checkpoint) => {
        await this.options.sessions.checkpoint(sessionId, checkpoint, this.clock());
      },
    });
    if (result.status === "verifier_expectations_recorded") {
      const recorded = this.options.authority.correctionView(request.runId, request.reviewId);
      if (!recorded || result.reviewId !== request.reviewId) {
        throw new Error("Coverage correction view was not durable after the own-view pass.");
      }
      this.options.sessions.complete(sessionId, this.clock());
      return { status: "viewed", sessionId, messages: result.messages };
    }
    if (result.status === "suspended") {
      return { status: "not-viewed", result: this.suspend(sessionId, candidate, request, result) };
    }
    this.options.sessions.suspend(sessionId, `unexpected_coverage_lifecycle:${result.status}`, undefined, this.clock());
    return {
      status: "not-viewed",
      result: {
        status: "suspended",
        reviewId: request.reviewId,
        sessionId,
        runtimeId: candidate.runtimeId,
        reason: `unexpected_coverage_lifecycle:${result.status}`,
        messages: result.messages,
      },
    };
  }

  private async runVerdictPass(input: {
    request: NativeCoverageReviewRequest;
    candidate: AgentRuntimeCandidate;
    model: AgentModel;
    obligations: readonly DerivedObligation[];
    reusedFromReviewId?: string;
    criticChecksJson: string | undefined;
    criticHook: CoverageCriticHookOutcome;
    risk: PlanRiskAssessment;
    deriveSessionId: string;
    deriveMessages: readonly AgentMessage[];
    independence: ReviewerIndependence;
  }): Promise<NativeCoverageReviewResult> {
    const { request, candidate, model, obligations, independence } = input;
    const isReReview = request.priorReview !== undefined;
    const contextLimits = this.options.contextLimits ?? { maxBytes: 512 * 1024, maxEstimatedTokens: 128 * 1024 };
    // B3: a re-review checks the immediate prior's every finding plus every
    // cumulative open blocking finding from older reviews.
    const requiredPriorFindings = isReReview ? this.requiredPriorFindingsForVerdict(request) : [];
    let pack: ReturnType<typeof buildCoverageVerdictContext>;
    try {
      pack = buildCoverageVerdictContext({
        limits: contextLimits,
        obligationsJson: JSON.stringify(obligations, null, 2),
        planRevisionJson: JSON.stringify(request.planRevision, null, 2),
        ledgerJson: JSON.stringify(request.ledger, null, 2),
        ...(isReReview
          ? { priorFindingsJson: JSON.stringify(requiredPriorFindings, null, 2) }
          : {}),
        ...(input.criticChecksJson !== undefined ? { criticChecksJson: input.criticChecksJson } : {}),
      });
    } catch (error) {
      if (error instanceof ProtectedContextOverflowError) {
        return await this.recordUnavailable(
          request,
          "plan_pack_overflow",
          `Protected plan context (${error.requiredBytes} bytes) exceeds the limit (${error.limitBytes} bytes); an incomplete review never counts.`,
        );
      }
      throw error;
    }
    const mode = isReReview ? "rereview-verdict" : "verdict";
    const sessionId = coverageSessionId(request.runId, request.reviewId, pack.digest, "verdict", candidate.runtimeId, independence);
    await recordContextPack({
      store: this.options.contextManifests,
      artifacts: this.options.artifacts,
      recordPackText: this.options.recordContextPackText,
      runId: request.runId,
      sessionId,
      actor: { role: "verifier", id: candidate.runtimeId },
      role: "verifier",
      purpose: isReReview ? "coverage:rereview-verdict" : "coverage:verdict",
      limits: contextLimits,
      pack,
      recordedAt: this.clock(),
    });
    const systemMessage: AgentMessage = {
      id: `coverage-${mode}-system`,
      role: "system",
      content: coverageReviewerSystemPrompt(mode),
    };
    const contextMessage: AgentMessage = {
      id: `coverage-context:${pack.digest}`,
      role: "user",
      content: pack.text,
    };
    let messages: AgentMessage[] = [systemMessage, contextMessage];
    const sessionEvents = this.options.sessions.events(sessionId);
    const freshStart = sessionEvents.length === 0;
    if (freshStart) {
      assertFreshContextRequest({
        independence,
        priorEventCount: sessionEvents.length,
        messages,
        packMessageIds: [systemMessage.id, contextMessage.id],
      });
      await this.options.sessions.create({
        sessionId,
        runId: request.runId,
        actor: { role: "verifier", id: candidate.runtimeId },
        occurredAt: this.clock(),
      });
      assertFreshContextSessionStarted(independence, this.options.sessions.events(sessionId));
    } else {
      const recovered = await this.options.sessions.load(sessionId);
      if (
        recovered.actor.role !== "verifier" ||
        recovered.actor.id !== candidate.runtimeId ||
        recovered.runId !== request.runId
      ) {
        throw new Error(
          independence === "fresh_context"
            ? "A fresh-context reviewer cannot resume or reuse another session."
            : "Recovered coverage session identity does not match the request.",
        );
      }
      if (recovered.checkpoint) messages = [...recovered.checkpoint.messages];
      if (!messages.some((message) => message.id === contextMessage.id)) {
        messages.push(contextMessage);
      }
    }
    const submitted = this.options.authority.currentReview(request.runId);
    if (submitted?.id === request.reviewId) {
      this.options.sessions.complete(sessionId, this.clock());
      return {
        status: "reviewed",
        reviewId: request.reviewId,
        review: submitted,
        deriveSessionId: input.deriveSessionId,
        verdictSessionId: sessionId,
        runtimeId: candidate.runtimeId,
        independence,
        risk: input.risk,
        criticHook: input.criticHook,
        deriveMessages: input.deriveMessages,
        verdictMessages: messages,
        replayed: true,
      };
    }
    if (!freshStart) {
      const completed = await this.options.sessions.load(sessionId);
      if (completed.status === "completed") {
        throw new Error("Completed coverage session has no durable typed verdict.");
      }
    }
    // The plan is shown in this turn (initial review; a re-review already
    // recorded its delivery at own-view time — idempotent).
    this.options.authority.recordPlanDelivered({
      runId: request.runId,
      reviewId: request.reviewId,
      planRevisionId: request.planRevision.revisionId,
      planRevisionDigest: request.planRevision.digest,
      sourceManifestId: request.manifest.manifestId,
      sessionId,
      occurredAt: this.clock(),
    });
    const broker = createCoverageReviewBroker({
      git: this.options.git,
      executionGrants: this.options.executionGrants,
      workspacePath: this.options.projectRoot,
      artifacts: this.options.artifacts,
      evidenceStore: this.options.evidenceStore,
      runId: request.runId,
      clock: this.clock,
      ...(this.options.ledger ? { ledger: this.options.ledger } : {}),
      ...(this.options.permissions ? { permissions: this.options.permissions } : {}),
      lifecycleTool: createSubmitCoverageVerdictTool({
        authority: this.options.authority,
        runId: request.runId,
        reviewId: request.reviewId,
        reviewerRuntimeId: candidate.runtimeId,
        independence,
        sourceReadManifestId: request.manifest.manifestId,
        planRevisionId: request.planRevision.revisionId,
        planRevisionDigest: request.planRevision.digest,
        obligationIds: obligations.map((obligation) => obligation.id),
        ...(request.priorReview !== undefined
          ? {
              priorReviewId: request.priorReview.id,
              priorFindingIds: requiredPriorFindings.map((finding) => finding.id),
            }
          : {}),
        ...(input.reusedFromReviewId !== undefined ? { reusedFromReviewId: input.reusedFromReviewId } : {}),
        runtimeId: candidate.runtimeId,
        sessionId,
        clock: this.clock,
      }),
    });
    const result = await runAgentLoop({
      model: this.budgetedModel(model, candidate, request.runId, sessionId),
      registry: this.budgetedTools(broker, request.runId),
      context: {
        runId: request.runId,
        sessionId,
        actor: { role: "verifier", id: candidate.runtimeId },
        workspacePath: this.options.projectRoot,
        signal: request.signal,
      },
      initialMessages: messages,
      maxTurns: this.options.maxTurns ?? 20,
      signal: request.signal,
      providerRetry: {
        runtimeId: candidate.runtimeId,
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        deadlineMs: request.providerRetryDeadlineMs,
        classify: classifyProviderFailure,
        ...(this.options.providerRetryRuntime
          ? {
              now: this.options.providerRetryRuntime.now,
              random: this.options.providerRetryRuntime.random,
              sleep: this.options.providerRetryRuntime.sleep,
            }
          : {}),
      },
      onCheckpoint: async (checkpoint) => {
        await this.options.sessions.checkpoint(sessionId, checkpoint, this.clock());
      },
    });
    if (result.status === "verifier_verdict_submitted") {
      const durable = this.options.authority.currentReview(request.runId);
      if (
        !durable ||
        durable.id !== request.reviewId ||
        result.reviewId !== request.reviewId ||
        durable.reviewerRuntimeId !== candidate.runtimeId ||
        durable.planRevisionId !== request.planRevision.revisionId ||
        durable.planRevisionDigest !== request.planRevision.digest
      ) {
        throw new Error("Coverage lifecycle returned before its exact typed verdict was durable.");
      }
      this.options.router.recordSuccess(candidate.runtimeId);
      this.options.sessions.complete(sessionId, this.clock());
      return {
        status: "reviewed",
        reviewId: request.reviewId,
        review: durable,
        deriveSessionId: input.deriveSessionId,
        verdictSessionId: sessionId,
        runtimeId: candidate.runtimeId,
        independence,
        risk: input.risk,
        criticHook: input.criticHook,
        deriveMessages: input.deriveMessages,
        verdictMessages: result.messages,
        replayed: false,
      };
    }
    if (result.status === "suspended") {
      return this.suspend(sessionId, candidate, request, result);
    }
    this.options.sessions.suspend(sessionId, `unexpected_coverage_lifecycle:${result.status}`, undefined, this.clock());
    return {
      status: "suspended",
      reviewId: request.reviewId,
      sessionId,
      runtimeId: candidate.runtimeId,
      reason: `unexpected_coverage_lifecycle:${result.status}`,
      messages: result.messages,
    };
  }

  private requiredPriorFindingsForVerdict(request: NativeCoverageReviewRequest): PlanningFinding[] {
    const prior = request.priorReview!;
    const byId = new Map<string, PlanningFinding>();
    for (const finding of prior.findings) byId.set(finding.id, finding);
    for (const review of this.options.authority.reviewHistory(request.runId)) {
      for (const finding of review.findings) {
        if (!byId.has(finding.id)) byId.set(finding.id, finding);
      }
    }
    const current = this.options.authority.currentReview(request.runId);
    if (current) {
      for (const finding of current.findings) {
        if (!byId.has(finding.id)) byId.set(finding.id, finding);
      }
    }
    // N-R2-2: findings retired by a source amendment need no check.
    const retired = this.options.authority.retiredFindingIds(request.runId);
    const requiredIds = new Set<string>(
      prior.findings.filter((finding) => !retired.has(finding.id)).map((finding) => finding.id),
    );
    for (const entry of this.options.authority.openBlockingFindings(request.runId)) {
      requiredIds.add(entry.findingId);
    }
    const required: PlanningFinding[] = [];
    for (const id of requiredIds) {
      const finding = byId.get(id);
      if (finding) required.push(finding);
    }
    required.sort((left, right) => left.id.localeCompare(right.id));
    return required;
  }

  private suspend(
    sessionId: string,
    candidate: AgentRuntimeCandidate,
    request: NativeCoverageReviewRequest,
    result: { reason: string; error?: string; providerError?: unknown; messages: readonly AgentMessage[] },
  ): NativeCoverageReviewResult {
    if (result.reason === "provider_error") {
      this.options.router.recordFailure(
        candidate.runtimeId,
        classifyProviderFailure({
          ...(result.providerError as Record<string, never>),
          message: result.error ?? "Coverage reviewer provider failed.",
        }),
      );
    }
    this.options.sessions.suspend(sessionId, result.reason, result.error, this.clock());
    return {
      status: "suspended",
      reviewId: request.reviewId,
      sessionId,
      runtimeId: candidate.runtimeId,
      reason: result.reason,
      ...(result.error ? { error: result.error } : {}),
      messages: result.messages,
    };
  }

  private budgetedModel(
    model: AgentModel,
    candidate: AgentRuntimeCandidate,
    runId: string,
    sessionId: string,
  ): AgentModel {
    if (!this.options.budgetLedger) return model;
    return new BudgetedAgentModel({
      model,
      ledger: this.options.budgetLedger,
      scopeId: runId,
      attribution: verifierModelAttribution(candidate, sessionId),
      outputTokenReserve: this.options.outputTokenReserve ?? 16_384,
      estimateCostMicros: this.options.modelCostEstimators?.get(candidate.runtimeId),
      costBasis: this.options.modelCostBases?.get(candidate.runtimeId),
      clock: this.clock,
    });
  }

  private budgetedTools(broker: ReturnType<typeof createInspectionTools>, runId: string) {
    if (!this.options.budgetLedger) return broker;
    return new BudgetedToolRuntime({
      runtime: broker,
      ledger: this.options.budgetLedger,
      scopeId: runId,
      clock: this.clock,
    });
  }
}

function assertCoverageReviewRequest(request: NativeCoverageReviewRequest): void {
  if (!request.runId.trim() || !request.reviewId.trim()) {
    throw new Error("Coverage review identity is required.");
  }
  if (!request.architectRuntimeId.trim()) {
    throw new Error("Coverage review requires the Architect runtime identity.");
  }
  if (request.manifest.sections.length === 0) {
    throw new Error("Coverage review requires a non-empty source inventory.");
  }
  if (!request.planRevision.revisionId.trim() || !request.planRevision.digest.trim()) {
    throw new Error("Coverage review requires the exact plan revision identity.");
  }
  if (!request.objective.trim()) {
    throw new Error("Coverage review requires the build objective.");
  }
  if (request.priorReview && request.priorReview.id === request.reviewId) {
    throw new Error("A coverage re-review cannot be its own prior review.");
  }
}

function assertCriticFindings(findings: unknown): asserts findings is PlanningFinding[] {
  if (!Array.isArray(findings)) {
    throw new Error("Coverage plan-critic hook must return findings.");
  }
  for (const [index, finding] of findings.entries()) {
    if (
      typeof finding !== "object" || finding === null || Array.isArray(finding) ||
      typeof (finding as PlanningFinding).id !== "string" ||
      typeof (finding as PlanningFinding).claim !== "string"
    ) {
      throw new Error(`Coverage plan-critic finding ${index} is invalid.`);
    }
  }
}
