import { createHash } from "node:crypto";
import { decideUnverifiedClaim, type ClaimCitation } from "./evidence-applicability.js";
import type { EvidenceRecord } from "./evidence-store.js";
import type { CriterionEvidenceLink } from "./acceptance-contracts.js";
import { assessChangeRisk, type ChangeRiskInput, type ChangeRiskLevel, type ModelTrackRecordSnapshot } from "./change-risk.js";
import {
  PLANNING_FINDING_CATEGORIES,
  phaseValidationCheckId,
  type DerivedObligation,
  type PlanningFinding,
  type RequiredCheckRef,
} from "./planning-contracts.js";
import type { ReviewerIndependence } from "./verifier-contracts.js";
import type { TestIntegrityBoundary, TestConsolidationDisposition } from "./test-integrity-contracts.js";
import { validateLateFindingBasis, type DeltaHunk, type PriorReadRange } from "./review-delta.js";

/**
 * T6a (P6.6, OA-3/OA-4/OA-10/OA-11/OA-13): mandatory deliverable review and
 * post-integration acceptance for new-policy runs.
 *
 * This module holds the durable record shapes and the pure rules shared by
 * the kernel (scheduler-store.ts), the reviewer runtime
 * (native-deliverable-review.ts), and the pump (build-runtime.ts). It has no
 * value imports from the scheduler store, so the store may import it.
 *
 * The review is a kernel-ordered sequence of durable stages. Each reviewer
 * pass ends with a lifecycle tool that writes one kernel event, and the next
 * pass's context is built only after that event is durable:
 *
 *   started -> requested -> [high: obligations_recorded] -> diff_delivered
 *     -> findings_recorded -> report_delivered -> completed
 *
 * After integration, the pump runs boundary checks at the integrated revision
 * through the audited executor. Task acceptance needs a completed review with
 * no open blocking finding and no unverified claim, plus a passed boundary on
 * the current integration revision. Phase acceptance is bound to the current
 * plan revision and re-evaluated whenever its inputs change.
 */

export const DELIVERY_REVIEW_RUNNER_ID = "delivery-review-runtime";
export const DELIVERY_ACCEPTANCE_RUNNER_ID = "build-runtime";

export type DeliveryReviewTier = ChangeRiskLevel;

export type DeliveryReviewStage =
  | "started"
  | "requested"
  | "obligations_recorded"
  | "diff_delivered"
  | "findings_recorded"
  | "report_delivered"
  | "completed"
  | "abandoned";

export type MechanicalClaimLabel = "verified" | "unverified_claim" | "reviewer_judgement";

export interface MechanicalClaimAssessment {
  label: MechanicalClaimLabel;
  reason: string;
}

export interface DeliveryClaim {
  /** W3 (AR-R29): runner-computed mechanical floor. Absent on legacy claims. */
  mechanical?: MechanicalClaimAssessment;
  id: string;
  text: string;
  evidenceIds: string[];
}

export interface DeliveryClaimVerdict {
  citations?: import("./review-evidence.js").ReviewCitation[];
  claimId: string;
  claim: string;
  status: "verified" | "unverified";
  rationale: string;
  /** Present once the Architect verified an unverified claim itself. */
  disposition?: { status: "verified"; rationale: string; resolvedAt: string };
}

export interface DeliveryPriorFindingCheck {
  findingId: string;
  resolution: "resolved" | "outstanding";
  rationale: string;
}

/**
 * Owner decision 2026-09-25 ("real counts"): a `tests` result is `passed`
 * only when a machine-readable report produced by THIS run (a fresh,
 * runner-owned path) shows at least one executed test and none failed. A
 * non-zero exit is `failed`; anything else (no report, unreadable, zero
 * selected, all skipped) is `unknown`.
 */
export interface DeliveryTestReport {
  status: "passed" | "failed" | "unknown";
  /** The detected test runner (for example `node --test`), or what was found. */
  runner: string;
  format?: "junit" | "trx";
  /** The runner-owned report path this run wrote (relative to the checkout). */
  path?: string;
  /** ArtifactStore sha256 of the report bytes that were read. */
  artifactHash?: string;
  counts?: { selected: number; passed: number; failed: number; skipped: number };
  /** Test identities failed according to this run's machine-readable report. */
  failingTestIds?: string[];
  reason?: string;
  /**
   * The test runner rejected the report flags (for example a Node version
   * without the JUnit reporter): the run proved nothing either way.
   */
  reporterUnsupported?: boolean;
}

/** The one rule for a `tests` outcome (exit code, then the run's own report). */
export function testsOutcome(exitCode: number | null, report: DeliveryTestReport | undefined): "passed" | "failed" | "unknown" {
  if (exitCode === null) return "unknown";
  if (exitCode !== 0) return report?.reporterUnsupported === true ? "unknown" : "failed";
  if (!report) return "unknown";
  return report.status;
}

/** Kernel check that a recorded tests outcome follows the real-counts rule. */
export function assertTestsOutcome(
  label: string,
  exitCode: number | null,
  outcome: unknown,
  report: DeliveryTestReport | undefined,
): void {
  if (outcome !== testsOutcome(exitCode, report)) {
    throw new Error(`${label} outcome must follow the exit code and this run's own test report.`);
  }
  if (report?.status === "passed") {
    const counts = report.counts;
    if (
      !counts || counts.passed < 1 || counts.failed !== 0 || counts.selected < 1 ||
      !report.path || !report.artifactHash || !/^[a-f0-9]{64}$/.test(report.artifactHash)
    ) {
      throw new Error(`${label} passes only with a recorded report of at least one executed and zero failed tests.`);
    }
  }
}

export interface DeliveryAffectedTestsRecord {
  /**
   * N-R4-1: what actually ran — the project's whole test script (the OA-12
   * full-suite safe floor). The selection below is informational only.
   */
  executedScope: "full_test_script";
  /** The computeAffectedTests rung that produced the informational selection. */
  selectionRung: string;
  changedFiles: string[];
  /** Informational: the tests the selection names; the whole script ran. */
  selectedTests: string[];
  fullSuiteCount: number;
  /**
   * The project test command that was actually run. Runner-specific
   * narrowing is not mechanized; the recorded selection is what the
   * command must cover, and the full-suite command is its safe superset.
   */
  command: string;
  args: string[];
  evidenceIds: string[];
  exitCode: number | null;
  outcome: "passed" | "failed" | "unknown";
  report: DeliveryTestReport;
}

export interface DeliveryProbeRecord {
  rung: string;
  mutantsGenerated: number;
  mutantsExecuted: number;
  mutantsCaught: number;
  survivors: string[];
  partial: boolean;
  evidenceIds: string[];
  notes: string[];
}

export interface DeliveryDepthRecord {
  /** Successful non-lifecycle reviewer tool calls in the findings pass. */
  inspectionToolCalls: number;
  affectedTests?: DeliveryAffectedTestsRecord;
  probe?: DeliveryProbeRecord;
}

export interface DeliveryRiskRecord {
  tier: DeliveryReviewTier;
  score: number;
  digest: string;
  signals: string[];
}

export interface DeliveryReviewRecord {
  reviewEvidencePolicyVersion?: 1;
  readCapture?: import("./review-evidence.js").ReviewReadCapture;
  survivorDispositions?: Array<{ findingId: string; disposition: "not_a_real_gap"; rationale: string }>;
  runnerEncoding?: import("./encoding-safety.js").EncodingSubmissionRecord;
  reviewIntegrityPolicyVersion?: 1;
  taskId: string;
  reviewId: string;
  generation: number;
  submissionAttempt: number;
  changeSetId: string;
  diffArtifactHash: string;
  criteriaIds: string[];
  authorRuntimeId: string;
  authorModelIdentity: string;
  architectRuntimeId: string;
  architectModelIdentity: string;
  stage: DeliveryReviewStage;
  startedSequence: number;
  reviewerRuntimeId?: string;
  reviewerModelIdentity?: string;
  independence?: ReviewerIndependence;
  risk?: DeliveryRiskRecord;
  priorReviewId?: string;
  sessionIds: string[];
  obligations?: DerivedObligation[];
  findings?: PlanningFinding[];
  depth?: DeliveryDepthRecord;
  claims?: DeliveryClaim[];
  claimVerdicts?: DeliveryClaimVerdict[];
  priorFindingChecks?: DeliveryPriorFindingCheck[];
  summary?: string;
  satisfied?: boolean;
  completedSequence?: number;
  testConsolidation?: TestConsolidationDisposition;
  runnerScope?: import("./submission-scope-contracts.js").SubmissionScopeRecord;
  // W1 (AR-R27): ReviewKey this review was requested under, with audit
  // inputs. Absent on pre-W1 historical records: they never hit reuse
  // (conservative miss, never cache invention). reusedFrom binds a reuse
  // to its prior verdict without minting duplicate provenance. The
  // fingerprint fields carry S3 L7 real-diff lineage for oscillation.
  reviewKey?: string;
  reviewKeyInputs?: import("./review-key.js").ReviewKeyInputs;
  reusedFrom?: string;
  diffFingerprint?: string;
  diffReverseFingerprint?: string;
  failedRepairFingerprints?: import("./review-key.js").FailedRepairDiff[];
  // W2 (AR-R28): delta-first re-review input. Absent on pre-W2 records
  // and initial reviews: the conservative floor is the full cumulative
  // diff with every finding staying blocking. followUpFindings retains
  // late observations the kernel demoted to nonblocking; they never
  // gate acceptance.
  delta?: DeliveryReviewDelta;
  followUpFindings?: PlanningFinding[];
}

/**
 * W2 (AR-R28, S2 section 7.2 item 5): runner-computed fix re-review
 * input. The fix delta runs prior reviewed head -> current head; the
 * unnamed files list carries PATHS ONLY (never prior finding names or
 * claims); invalidated evidence derives from changed tree identity.
 * `fallback` marks the explicit conservative floor: prior trees,
 * artifacts or evidence were unavailable, so the available full
 * cumulative input stands in and unknown surfaces stay blocking.
 */
export interface DeliveryReviewDelta {
  readonly priorReviewId: string;
  readonly priorHeadTree?: string;
  /** Absent only on the explicit conservative fallback (trees unavailable). */
  readonly headTree?: string;
  readonly deltaFiles: readonly string[];
  /**
   * Verified prior reviewed surface: prior cumulative changed files
   * from actual Git trees, byte-exact. Read paths NEVER join: a ranged
   * read authorizes only its range (see priorReadRanges). Empty means
   * nothing proven reviewed: every late candidate stays blocking.
   */
  readonly priorReviewedFiles: readonly string[];
  /**
   * Verified prior line coverage: new-side lines SHOWN in the prior
   * cumulative diff hunks, per file. A filename inventory never confers
   * line coverage. Absent (fallback, oversize, unparsed) restricts line
   * authority to read ranges.
   */
  readonly priorShownLines?: Readonly<Record<string, readonly number[]>>;
  /**
   * Authentic prior read ranges: actual returned start/end lines per
   * path from the kernel-captured tool ledger. A range authorizes
   * exactly its lines — never its whole file. Empty means no read
   * authority.
   */
  readonly priorReadRanges: readonly PriorReadRange[];
  /**
   * Verified fix-delta hunks per file, from verified diff bytes.
   * Absent (or a missing file entry) stays blocking; only omitted on
   * oversized deltas that skip hunk mapping.
   */
  readonly deltaHunks?: Readonly<Record<string, readonly DeltaHunk[]>>;
  readonly filesWithoutPriorFindings: readonly string[];
  readonly invalidatedEvidenceIds: readonly string[];
  readonly cumulativeIncludedUpFront: boolean;
  readonly overCorrection: boolean;
  readonly fallback?: "full_cumulative";
  readonly deltaArtifactHash?: string;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${label} must be an array of paths.`);
  }
  return [...value as string[]];
}

/** Validates a runner-supplied re-review delta binding; absent stays absent. */
export function validateReviewDelta(value: unknown, priorReviewId: string | undefined): DeliveryReviewDelta | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Deliverable review delta is invalid.");
  const priorId = text(value.priorReviewId, "Deliverable review delta prior review");
  if (priorReviewId === undefined || priorId !== priorReviewId) {
    throw new Error("Deliverable review delta must bind the current review's prior review.");
  }
  // W2: the head tree is absent only on the explicit conservative
  // fallback (actual trees unavailable); the fallback flag is then
  // required and the available full cumulative input stands in.
  let headTree: string | undefined;
  if (value.headTree !== undefined) {
    headTree = text(value.headTree, "Deliverable review delta head tree");
    if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(headTree)) {
      throw new Error("Deliverable review delta head tree is not an actual Git tree.");
    }
  }
  if (value.priorHeadTree !== undefined) {
    const priorTree = text(value.priorHeadTree, "Deliverable review delta prior tree");
    if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(priorTree)) {
      throw new Error("Deliverable review delta prior tree is not an actual Git tree.");
    }
  }
  const deltaFiles = stringList(value.deltaFiles, "Deliverable review delta files");
  const unnamed = stringList(value.filesWithoutPriorFindings, "Deliverable review delta unnamed files");
  const deltaSet = new Set(deltaFiles);
  for (const file of unnamed) {
    if (!deltaSet.has(file)) throw new Error("Deliverable review delta unnamed files must be delta files.");
  }
  const invalidated = stringList(value.invalidatedEvidenceIds, "Deliverable review delta invalidated evidence");
  const priorReviewedFiles = stringList(value.priorReviewedFiles, "Deliverable review delta prior reviewed files");
  let priorShownLines: Record<string, number[]> | undefined;
  if (value.priorShownLines !== undefined) {
    if (!isRecord(value.priorShownLines)) throw new Error("Deliverable review delta shown lines are invalid.");
    priorShownLines = {};
    for (const [path, lines] of Object.entries(value.priorShownLines)) {
      if (!path.length) throw new Error("Deliverable review delta shown lines carry an empty path.");
      if (!Array.isArray(lines) || lines.some((line) => !Number.isSafeInteger(line) || (line as number) < 1)) {
        throw new Error(`Deliverable review delta shown lines for ${path} are invalid.`);
      }
      priorShownLines[path] = [...lines as number[]];
    }
  }
  if (!Array.isArray(value.priorReadRanges)) throw new Error("Deliverable review delta prior read ranges are invalid.");
  const priorReadRanges: PriorReadRange[] = (value.priorReadRanges as unknown[]).map((range) => {
    if (!isRecord(range) || typeof range.path !== "string" || !range.path.length) {
      throw new Error("Deliverable review delta prior read ranges carry an empty path.");
    }
    if (!Number.isSafeInteger(range.startLine) || !Number.isSafeInteger(range.endLine) ||
      (range.startLine as number) < 1 || (range.endLine as number) < (range.startLine as number)) {
      throw new Error(`Deliverable review delta read range for ${range.path as string} is invalid.`);
    }
    return { path: range.path, startLine: range.startLine as number, endLine: range.endLine as number };
  });
  let deltaHunks: Record<string, DeltaHunk[]> | undefined;
  if (value.deltaHunks !== undefined) {
    if (!isRecord(value.deltaHunks)) throw new Error("Deliverable review delta hunks are invalid.");
    deltaHunks = {};
    for (const [path, hunks] of Object.entries(value.deltaHunks)) {
      if (!path.length) throw new Error("Deliverable review delta hunks carry an empty path.");
      if (!Array.isArray(hunks)) throw new Error(`Deliverable review delta hunks for ${path} are invalid.`);
      deltaHunks[path] = (hunks as unknown[]).map((hunk) => {
        if (!isRecord(hunk) || !["oldStart", "oldCount", "newStart", "newCount"].every((key) =>
          Number.isSafeInteger(hunk[key]) && (hunk[key] as number) >= 0)) {
          throw new Error(`Deliverable review delta hunk for ${path} is invalid.`);
        }
        return {
          oldStart: hunk.oldStart as number,
          oldCount: hunk.oldCount as number,
          newStart: hunk.newStart as number,
          newCount: hunk.newCount as number,
        };
      });
    }
  }
  if (typeof value.cumulativeIncludedUpFront !== "boolean" || typeof value.overCorrection !== "boolean") {
    throw new Error("Deliverable review delta must state its cumulative and over-correction flags.");
  }
  if (value.fallback !== undefined && value.fallback !== "full_cumulative") {
    throw new Error("Deliverable review delta fallback is invalid.");
  }
  if (headTree === undefined && value.fallback !== "full_cumulative") {
    throw new Error("Deliverable review delta without an actual head tree must mark the explicit full-cumulative fallback.");
  }
  if (value.deltaArtifactHash !== undefined) {
    const hash = text(value.deltaArtifactHash, "Deliverable review delta artifact");
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Deliverable review delta artifact hash is invalid.");
  }
  return {
    priorReviewId: priorId,
    ...(value.priorHeadTree !== undefined ? { priorHeadTree: value.priorHeadTree as string } : {}),
    ...(headTree !== undefined ? { headTree } : {}),
    deltaFiles,
    priorReviewedFiles,
    ...(priorShownLines !== undefined ? { priorShownLines } : {}),
    priorReadRanges,
    ...(deltaHunks !== undefined ? { deltaHunks } : {}),
    filesWithoutPriorFindings: unnamed,
    invalidatedEvidenceIds: invalidated,
    cumulativeIncludedUpFront: value.cumulativeIncludedUpFront as boolean,
    overCorrection: value.overCorrection as boolean,
    ...(value.fallback !== undefined ? { fallback: value.fallback as "full_cumulative" } : {}),
    ...(value.deltaArtifactHash !== undefined ? { deltaArtifactHash: value.deltaArtifactHash as string } : {}),
  };
}

export interface DeliveryBoundaryCheck {
  checkId: string;
  command?: string;
  args?: string[];
  evidenceIds: string[];
  exitCode: number | null;
  outcome: "passed" | "failed" | "unknown";
  reason?: string;
  /** Required for the `tests` check (real counts). */
  report?: DeliveryTestReport;
}

export interface DeliveryBoundaryResolution {
  resolution: "recheck" | "repair_planned";
  rationale: string;
  repairTaskIds?: string[];
  sequence: number;
  /** A recheck grant is consumed by the next boundary run. */
  consumed?: boolean;
}

export interface DeliveryBoundaryRecord {
  taskId: string;
  boundaryId: string;
  generation: number;
  /** N-R4-3: the durable run attempt (a retry after an interruption is a new attempt). */
  attempt: number;
  integrationRevision: string;
  changedFiles: string[];
  /** N-R4-1: the project's whole build/test scripts ran; the selection is informational. */
  executedScope: "full_test_script";
  selection: { rung: string; selectedTests: string[] };
  checks: DeliveryBoundaryCheck[];
  passed: boolean;
  sequence: number;
  resolution?: DeliveryBoundaryResolution;
  /** Earlier resolutions superseded after their repairs ended without a new revision. */
  resolutionHistory?: DeliveryBoundaryResolution[];
  testIntegrity?: TestIntegrityBoundary;
}

export interface DeliveryTaskAcceptanceRecord {
  taskId: string;
  reviewId: string;
  submissionAttempt: number;
  changeSetId: string;
  boundaryId: string;
  integrationRevision: string;
  requiredChecks: RequiredCheckRef[];
  acceptedAt: string;
  sequence: number;
}

export interface DeliveryPhaseExitCheck {
  validation: string;
  checkId: string;
  boundaryId: string;
}

export interface DeliveryPhaseAcceptanceRecord {
  phaseId: string;
  planRevisionId: string;
  integrationRevision: string;
  requirementIds: string[];
  taskAcceptanceRefs: string[];
  exitChecks: DeliveryPhaseExitCheck[];
  acceptedAt: string;
  sequence: number;
}

export interface DeliveryState {
  reviews: Record<string, DeliveryReviewRecord>;
  reviewHistory: Record<string, DeliveryReviewRecord[]>;
  /** Every change-author runtime recorded on this run, with its model identity. */
  authorModelIdentities: Record<string, string>;
  boundaries: Record<string, DeliveryBoundaryRecord[]>;
  /** N-R4-3: last durably started run attempt per boundary id. */
  boundaryStarts?: Record<string, number>;
  taskAcceptances: Record<string, DeliveryTaskAcceptanceRecord>;
  /** Keyed `${planRevisionId}:${phaseId}` (N4: bound to its revision). */
  phaseAcceptances: Record<string, DeliveryPhaseAcceptanceRecord>;
}

export function emptyDeliveryState(): DeliveryState {
  return {
    reviews: {},
    reviewHistory: {},
    authorModelIdentities: {},
    boundaries: {},
    boundaryStarts: {},
    taskAcceptances: {},
    phaseAcceptances: {},
  };
}

export function deliveryReviewId(taskId: string, attempt: number, generation: number): string {
  return `delivery:${taskId}:${attempt}:${generation}`;
}

export function deliveryBoundaryId(taskId: string, generation: number): string {
  return `boundary:${taskId}:${generation}`;
}

export function phaseAcceptanceKey(planRevisionId: string, phaseId: string): string {
  return `${planRevisionId}:${phaseId}`;
}

/** OA-4: review depth by the deterministic T5 risk tier. */
export function deliveryReviewDepthForTier(tier: DeliveryReviewTier, reviewIntegrityPolicyVersion?: 1): {
  obligationsFirst: boolean;
  repositoryInspection: boolean;
  affectedTests: boolean;
  probe: boolean;
} {
  return {
    obligationsFirst: tier === "high",
    repositoryInspection: reviewIntegrityPolicyVersion === 1 || tier !== "low",
    affectedTests: tier === "high",
    probe: tier === "high",
  };
}

/** The T5 risk inputs a review request records; the kernel recomputes the tier from them. */
export interface DeliveryRiskInput {
  runnerSignals?: { unreferencedSourceFiles: string[]; testOnlyDiff: boolean };
  authorModelId: string;
  changedFiles: string[];
  linesAdded: number;
  linesRemoved: number;
  attempts: number;
  acceptedFailuresUsed: boolean;
  /** T6b repair (EP50): OA-16 track-record snapshot for the author tier. */
  trackRecord?: ModelTrackRecordSnapshot;
}

export function assessDeliveryRisk(input: DeliveryRiskInput): DeliveryRiskRecord {
  const riskInput: ChangeRiskInput = {
    authorModelId: input.authorModelId,
    changedFiles: [...input.changedFiles],
    linesAdded: input.linesAdded,
    linesRemoved: input.linesRemoved,
    attempts: input.attempts,
    acceptedFailuresUsed: input.acceptedFailuresUsed,
    ...(input.trackRecord ? { trackRecordSnapshot: input.trackRecord } : {}),
  };
  const assessment = assessChangeRisk(riskInput);
  if (input.runnerSignals) {
    const signals = input.runnerSignals;
    if (!Array.isArray(signals.unreferencedSourceFiles) || signals.unreferencedSourceFiles.some((path) => typeof path !== "string" || !input.changedFiles.includes(path)) || typeof signals.testOnlyDiff !== "boolean") throw new Error("Invalid runner review signals.");
    const raised = signals.testOnlyDiff || signals.unreferencedSourceFiles.length > 0;
    return {
      tier: raised && assessment.tier === "low" ? "medium" : assessment.tier,
      score: raised ? Math.max(2, assessment.score) : assessment.score,
      digest: createHash("sha256").update(JSON.stringify([assessment.digest, signals])).digest("hex"),
      signals: [...assessment.signals.map((signal) => `${signal.signal}:${signal.points}`),
        ...(signals.unreferencedSourceFiles.length ? [`unreferenced_source:${signals.unreferencedSourceFiles.join(",")}`] : []),
        ...(signals.testOnlyDiff ? ["test_only_diff:medium_floor"] : [])],
    };
  }
  return {
    tier: assessment.tier,
    score: assessment.score,
    digest: assessment.digest,
    signals: assessment.signals.map((signal) => `${signal.signal}:${signal.points}`),
  };
}

/**
 * OA-4 signal: whether any Architect review of this task accepted an
 * evidence failure (a prior attempt's waiver counts for the fix re-review).
 */
export function taskAcceptedFailuresUsed(
  reviews: readonly { criterionVerdicts?: readonly { acceptedFailures?: readonly unknown[] }[] }[],
): boolean {
  return reviews.some((review) =>
    (review.criterionVerdicts ?? []).some((verdict) => (verdict.acceptedFailures ?? []).length > 0));
}

/**
 * T6b (OA-16/B7): per-author defect outcomes across every review round of
 * one task. A task whose first review found a defect keeps that defect on
 * its original author even when a different model wrote the accepted fix;
 * the store keeps defect_found sticky per (model, task), so earlier rounds
 * are never erased by the accepting round.
 */
export function reviewOutcomeByAuthor(
  reviews: readonly Pick<DeliveryReviewRecord, "reviewId" | "authorModelIdentity" | "findings">[],
): { modelId: string; defectFound: boolean }[] {
  const seen = new Set<string>();
  const defectByAuthor = new Map<string, boolean>();
  for (const entry of reviews) {
    if (seen.has(entry.reviewId)) continue;
    seen.add(entry.reviewId);
    const found = (entry.findings?.length ?? 0) > 0;
    defectByAuthor.set(entry.authorModelIdentity, (defectByAuthor.get(entry.authorModelIdentity) ?? false) || found);
  }
  return [...defectByAuthor].map(([modelId, defectFound]) => ({ modelId, defectFound }));
}

/** Counts added and removed lines of a unified diff, skipping file headers. */
export function diffLineCounts(diffText: string): { linesAdded: number; linesRemoved: number } {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) linesAdded += 1;
    else if (line.startsWith("-")) linesRemoved += 1;
  }
  return { linesAdded, linesRemoved };
}

/**
 * Worker claims derive only from the durable submission: one claim per
 * acceptance criterion (with the evidence the worker linked to it), plus the
 * worker's own summary.
 */
/** W3 (AR-R29): the submitted link facts the mechanical labeler reads. */
export interface MechanicalClaimLink {
  readonly evidenceId: string;
  readonly artifactHashes?: readonly string[];
  readonly freshness?: CriterionEvidenceLink["freshness"];
}

/**
 * W3 (AR-R29, S3 L2): mechanically classify one delivery claim against the
 * actual durable evidence records, reusing decideUnverifiedClaim (never a
 * weaker reimplementation). Conservative floor: missing/fabricated evidence,
 * failed command facts, stale or missing revision/artifact binding, and empty
 * link sets are unverified_claim; only mechanically matching command evidence
 * is verified; everything mechanics cannot decide (including the freeform
 * summary) is reviewer_judgement.
 */
export function labelDeliveryClaim(input: {
  claimId: string;
  links: readonly MechanicalClaimLink[];
  recordsById: ReadonlyMap<string, EvidenceRecord>;
  isSummary: boolean;
}): MechanicalClaimAssessment {
  if (input.isSummary) {
    return {
      label: "reviewer_judgement",
      reason: "Freeform worker summary; no mechanical command/exit/revision/artifact comparison applies.",
    };
  }
  if (input.links.length === 0) {
    return {
      label: "unverified_claim",
      reason: `Criterion claim ${input.claimId} cites no evidence (an empty link set proves nothing).`,
    };
  }
  let judgement: MechanicalClaimAssessment | undefined;
  for (const link of input.links) {
    const perLink = labelDeliveryClaimLink(input.claimId, link, input.recordsById);
    // A criterion with multiple links is verified only when every required
    // link is mechanically verified; one unverified link blocks certainty.
    if (perLink.label === "unverified_claim") return perLink;
    if (perLink.label === "reviewer_judgement" && !judgement) judgement = perLink;
  }
  if (judgement) return judgement;
  return {
    label: "verified",
    reason: `All ${input.links.length} cited evidence record(s) mechanically match for ${input.claimId}.`,
  };
}

function labelDeliveryClaimLink(
  claimId: string,
  link: MechanicalClaimLink,
  recordsById: ReadonlyMap<string, EvidenceRecord>,
): MechanicalClaimAssessment {
  const record = recordsById.get(link.evidenceId);
  if (record && record.fact.kind !== "command") {
    // Non-command facts carry no command/exit/revision/artifacts to compare;
    // mechanics cannot decide them, so the residue stays reviewer judgement.
    const assessed = decideUnverifiedClaim({
      claim: {
        evidenceId: link.evidenceId,
        command: "",
        args: [],
        exitCode: 0,
        snapshotRevision: "",
        artifactHashes: [...(link.artifactHashes ?? [])],
      },
      recordsById,
      hasSemanticResidue: true,
      semanticNote: `cited evidence ${link.evidenceId} is ${record.fact.kind}, not a command record`,
    });
    return { label: assessed.status, reason: assessed.reason };
  }
  if (record?.fact.kind === "command" && (record.fact.signal !== null || record.fact.timedOut || record.fact.cancelled)) {
    return {
      label: "unverified_claim",
      reason: `Cited evidence ${record.id} did not complete successfully (signal ${String(record.fact.signal)}, timed out ${String(record.fact.timedOut)}, cancelled ${String(record.fact.cancelled)}).`,
    };
  }
  if (record?.fact.kind === "command" && !link.freshness) {
    return {
      label: "unverified_claim",
      reason: `Cited evidence ${link.evidenceId} for ${claimId} has no revision binding (missing working-tree freshness).`,
    };
  }
  if (record?.fact.kind === "command" && link.freshness && link.freshness.status !== "current") {
    return {
      label: "unverified_claim",
      reason: `Cited evidence ${link.evidenceId} for ${claimId} is ${link.freshness.status}: ${link.freshness.reason ?? "working-tree identity does not match the submitted tree"}.`,
    };
  }
  // The criterion claim asserts green evidence at a bound revision with the
  // linked artifacts. Command/args come from the durable record itself: the
  // worker submits no independent command assertion, so exit, revision
  // presence, and artifact binding are the deciding mechanical dimensions.
  const citation: ClaimCitation = {
    evidenceId: link.evidenceId,
    command: record?.fact.kind === "command" ? record.fact.command : "",
    args: record?.fact.kind === "command" ? [...record.fact.args] : [],
    exitCode: 0,
    snapshotRevision: record?.fact.kind === "command" ? (record.fact.repositoryRevision ?? "") : "",
    artifactHashes: [...(link.artifactHashes ?? [])],
  };
  const assessed = decideUnverifiedClaim({ claim: citation, recordsById, hasSemanticResidue: false });
  return { label: assessed.status, reason: assessed.reason };
}

/** W3 (AR-R29/AR-3): one runner-owned prefilled criterion of review_task. */
export interface ReviewTaskPrefilledCriterion {
  criterionId: string;
  /** Deterministic join to the reviewer claim verdict. */
  claimId: string;
  prefilledVerdict: "satisfied" | "unsatisfied";
  /** Submitted criterion evidence links; reviewer citations stay per-claim below, never sprayed. */
  prefilledEvidenceIds: string[];
  reviewerStatus: "verified" | "unverified";
  reviewerRationale: string;
  reviewerCitations: import("./review-evidence.js").ReviewCitation[];
  mechanicalLabel?: MechanicalClaimLabel;
  mechanicalReason?: string;
}

/** W3 (AR-R29/AR-3): the runner-owned prefilled review_task disposition. */
export interface ReviewTaskPrefill {
  taskId: string;
  reviewId: string;
  submissionAttempt: number;
  changeSetId: string;
  reviewSatisfied: boolean;
  openBlockingFindingIds: string[];
  criteria: ReviewTaskPrefilledCriterion[];
}

/**
 * W3: a review carries the mechanical floor exactly when every durable claim
 * carries a runner-computed label. Pre-W3 reviews carry none and keep legacy
 * judging, so every stored log replays unchanged.
 */
export function deliveryReviewHasMechanicalLabels(review: DeliveryReviewRecord): boolean {
  return (review.claims?.length ?? 0) > 0 && (review.claims ?? []).every((claim) => claim.mechanical !== undefined);
}

/**
 * W3 (AR-R29/AR-3): derive the runner-owned review_task prefill from the
 * completed independent delivery review of the CURRENT submission plus runner
 * evidence. Undefined when there is no completed current-submission review or
 * when the review predates mechanical labels (legacy judging applies). A
 * criterion is prefilled satisfied only when the reviewer verified it AND no
 * mechanical unverified_claim floor binds it; raw reviewer status is used
 * (Architect dispositions never rewrite the prefill). Criteria without a
 * reviewer verdict get no entry and stay legacy-judged.
 */
export function deriveReviewTaskPrefill(input: {
  task: {
    id: string;
    attempt: number;
    changeSetId?: string;
    /** Optional like BuildTask: absent criteria prefill no entries (legacy judging for the task). */
    acceptanceCriteria?: readonly { id: string }[];
    criterionEvidenceLinks?: readonly CriterionEvidenceLink[];
  };
  review: DeliveryReviewRecord | undefined;
}): ReviewTaskPrefill | undefined {
  const review = input.review;
  if (!review || review.stage !== "completed") return undefined;
  if (review.taskId !== input.task.id) return undefined;
  if (review.submissionAttempt !== input.task.attempt) return undefined;
  if (!input.task.changeSetId || review.changeSetId !== input.task.changeSetId) return undefined;
  if (!deliveryReviewHasMechanicalLabels(review)) return undefined;
  const criteria: ReviewTaskPrefilledCriterion[] = [];
  for (const criterion of input.task.acceptanceCriteria ?? []) {
    const claimId = `claim:${criterion.id}`;
    const verdict = review.claimVerdicts?.find((candidate) => candidate.claimId === claimId);
    if (!verdict) continue;
    const claim = review.claims?.find((candidate) => candidate.id === claimId);
    const mechanical = claim?.mechanical;
    const prefilledVerdict = mechanical?.label === "unverified_claim" || verdict.status !== "verified"
      ? "unsatisfied"
      : "satisfied";
    criteria.push({
      criterionId: criterion.id,
      claimId,
      prefilledVerdict,
      prefilledEvidenceIds: [...new Set(
        (input.task.criterionEvidenceLinks ?? [])
          .filter((link) => link.criterionId === criterion.id)
          .map((link) => link.evidenceId),
      )].sort(),
      reviewerStatus: verdict.status,
      reviewerRationale: verdict.rationale,
      reviewerCitations: [...(verdict.citations ?? [])],
      ...(mechanical ? { mechanicalLabel: mechanical.label, mechanicalReason: mechanical.reason } : {}),
    });
  }
  return {
    taskId: input.task.id,
    reviewId: review.reviewId,
    submissionAttempt: review.submissionAttempt,
    changeSetId: review.changeSetId,
    reviewSatisfied: review.satisfied ?? false,
    openBlockingFindingIds: openBlockingFindings(review).map((finding) => finding.id),
    criteria,
  };
}

/** W3: one submitted verdict compared against its prefilled verdict. */
export interface ReviewTaskVerdictDeviation {
  criterionId: string;
  /** Undefined when the criterion has no prefill (legacy judging for it). */
  prefilled: "satisfied" | "unsatisfied" | undefined;
  submitted: "satisfied" | "unsatisfied";
  deviates: boolean;
  upgrades: boolean;
}

/**
 * W3: compare submitted criterion verdicts against the prefill, in input
 * order. Only the verdict word deviates; evidence selection stays governed by
 * the existing criterion evidence validation.
 */
export function diffReviewTaskVerdicts(
  prefill: ReviewTaskPrefill | undefined,
  verdicts: readonly { criterionId: string; verdict: "satisfied" | "unsatisfied" }[],
): ReviewTaskVerdictDeviation[] {
  const prefilledByCriterion = new Map(
    (prefill?.criteria ?? []).map((entry) => [entry.criterionId, entry.prefilledVerdict] as const),
  );
  return verdicts.map((verdict) => {
    const prefilled = prefilledByCriterion.get(verdict.criterionId);
    const deviates = prefilled !== undefined && prefilled !== verdict.verdict;
    return {
      criterionId: verdict.criterionId,
      prefilled,
      submitted: verdict.verdict,
      deviates,
      upgrades: deviates && prefilled === "unsatisfied" && verdict.verdict === "satisfied",
    };
  });
}

export function deliveryClaimsFromSubmission(input: {
  summary: string;
  criteria: readonly { id: string; text: string }[];
  links: readonly { criterionId: string; evidenceId: string; artifactHashes?: readonly string[]; freshness?: import("./acceptance-contracts.js").CriterionEvidenceLink["freshness"] }[];
  /** W3: when present, every claim carries its mechanical label; absent keeps legacy unlabeled claims. */
  evidenceById?: ReadonlyMap<string, EvidenceRecord>;
}): DeliveryClaim[] {
  const claims: DeliveryClaim[] = input.criteria.map((criterion) => ({
    id: `claim:${criterion.id}`,
    text: `Criterion ${criterion.id} is satisfied: ${criterion.text}` + input.links.filter((link) => link.criterionId === criterion.id && link.freshness && link.freshness.status !== "current").map((link) => `\nEvidence ${link.evidenceId}: ${link.freshness!.status}: ${link.freshness!.reason} (submitted tree ${link.freshness!.submittedTreeId ?? "unknown"}; evidence tree ${link.freshness!.evidenceTreeId ?? "unknown"}).`).join(""),
    evidenceIds: [...new Set(input.links
      .filter((link) => link.criterionId === criterion.id)
      .map((link) => link.evidenceId))].sort(),
  }));
  claims.push({ id: "claim:summary", text: input.summary, evidenceIds: [] });
  if (input.evidenceById) {
    for (const claim of claims) {
      claim.mechanical = labelDeliveryClaim({
        claimId: claim.id,
        links: input.links.filter((link) => `claim:${link.criterionId}` === claim.id),
        recordsById: input.evidenceById,
        isSummary: claim.id === "claim:summary",
      });
    }
  }
  return claims;
}

export function validateDeliveryFindings(value: unknown): PlanningFinding[] {
  if (!Array.isArray(value)) throw new Error("Deliverable findings must be an array.");
  const seen = new Set<string>();
  return value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Deliverable finding is invalid.");
    const id = text(candidate.id, "Deliverable finding id");
    if (seen.has(id)) throw new Error(`Duplicate deliverable finding ${id}.`);
    seen.add(id);
    const category = text(candidate.category, "Deliverable finding category");
    validateOptionalDefectClass(candidate.defectClass, id);
    if (!(PLANNING_FINDING_CATEGORIES as readonly string[]).includes(category)) {
      throw new Error(`Deliverable finding ${id} category ${category} is invalid.`);
    }
    if (candidate.severity !== "blocking" && candidate.severity !== "advisory") {
      throw new Error(`Deliverable finding ${id} severity is invalid.`);
    }
    const evidenceRefs = Array.isArray(candidate.evidenceRefs)
      ? candidate.evidenceRefs.map((ref) => text(ref, "Deliverable finding evidence ref"))
      : [];
    // W2 (AR-R28): optional reviewer-asserted late-finding exception
    // basis. Structurally validated here; the kernel honors it only on
    // unchanged already-reviewed code with a valid basis.
    const lateFinding = validateLateFindingBasis(candidate.lateFinding, id);
    return {
      id,
      category,
      severity: candidate.severity,
      ...(typeof candidate.location === "string" && candidate.location.trim()
        ? { location: candidate.location }
        : {}),
      ...(typeof candidate.requirementId === "string" && candidate.requirementId.trim()
        ? { requirementId: candidate.requirementId }
        : {}),
      claim: text(candidate.claim, "Deliverable finding claim"),
      evidenceRefs,
      ...(lateFinding !== undefined ? { lateFinding } : {}),
    };
  });
}

export function validateDeliveryObligations(value: unknown, recordedAt: string): DerivedObligation[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("High-tier review requires derived obligations.");
  }
  const seen = new Set<string>();
  return value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Derived obligation is invalid.");
    const id = text(candidate.id, "Derived obligation id");
    if (seen.has(id)) throw new Error(`Duplicate derived obligation ${id}.`);
    seen.add(id);
    return {
      id,
      ...(typeof candidate.requirementId === "string" && candidate.requirementId.trim()
        ? { requirementId: candidate.requirementId }
        : {}),
      description: text(candidate.description, "Derived obligation description"),
      recordedBeforePlanOrDiffProvided: true,
      recordedAt,
    };
  });
}

export function openBlockingFindings(review: DeliveryReviewRecord | undefined): PlanningFinding[] {
  return (review?.findings ?? []).filter(
    (finding) => finding.severity === "blocking" && !review?.survivorDispositions?.some((item) => item.findingId === finding.id) && (review?.runnerScope?.findings.some((fact) => fact.id === finding.id)
      ? finding.disposition?.resolution !== "plan_reconciled" || !finding.disposition.resolvedInRevisionDigest
      : finding.disposition === undefined),
  );
}

export function unverifiedClaims(review: DeliveryReviewRecord | undefined): DeliveryClaimVerdict[] {
  return (review?.claimVerdicts ?? []).filter(
    (verdict) => verdict.status === "unverified" && verdict.disposition === undefined,
  );
}

/** The latest completed review in a task's history (the prior of a re-review). */
export function latestCompletedReview(
  state: DeliveryState | undefined,
  taskId: string,
): DeliveryReviewRecord | undefined {
  const current = state?.reviews[taskId];
  if (current?.stage === "completed") return current;
  return [...(state?.reviewHistory[taskId] ?? [])]
    .reverse()
    .find((review) => review.stage === "completed");
}

export function currentSubmissionReview(
  state: DeliveryState | undefined,
  task: { id: string; attempt: number; changeSetId?: string },
): DeliveryReviewRecord | undefined {
  const review = state?.reviews[task.id];
  return review &&
    review.submissionAttempt === task.attempt &&
    review.changeSetId === task.changeSetId
    ? review
    : undefined;
}

/** Issues that prevent approval or integration of the current submission. */
export function deliveryReviewApprovalIssues(
  state: DeliveryState | undefined,
  task: { id: string; attempt: number; changeSetId?: string },
): string[] {
  const review = currentSubmissionReview(state, task);
  if (!review || review.stage !== "completed") {
    return [`Task ${task.id} requires a completed mandatory deliverable review for the current submission.`];
  }
  const issues: string[] = [];
  const blocking = openBlockingFindings(review);
  if (blocking.length > 0) {
    issues.push(`Task ${task.id} has unresolved blocking deliverable findings: ${blocking.map((finding) => finding.id).join(", ")}.`);
  }
  const claims = unverifiedClaims(review);
  if (claims.length > 0) {
    issues.push(`Task ${task.id} has unverified worker claims: ${claims.map((claim) => claim.claimId).join(", ")}.`);
  }
  return issues;
}

export function latestBoundary(
  state: DeliveryState | undefined,
  taskId: string,
): DeliveryBoundaryRecord | undefined {
  return state?.boundaries[taskId]?.at(-1);
}

export type DeliveryBoundaryAction =
  | { type: "accept"; boundary: DeliveryBoundaryRecord }
  | { type: "run" }
  | { type: "architect"; boundary: DeliveryBoundaryRecord; resolutionGeneration: number }
  | { type: "wait"; boundary: DeliveryBoundaryRecord };

/** Statuses after which a planned repair can no longer change the integrated revision. */
const TERMINAL_REPAIR_STATUSES = new Set(["integrated", "cancelled", "failed"]);

/** The generation the Architect's next resolution of this boundary must carry. */
export function boundaryResolutionGeneration(boundary: DeliveryBoundaryRecord): number {
  return (boundary.resolutionHistory?.length ?? 0) + (boundary.resolution ? 1 : 0) + 1;
}

/**
 * N-R4-2: a failed boundary needs the Architect when it is unresolved, or
 * when every repair planned for it ended (integrated, cancelled, or failed)
 * without a new integration revision re-running the boundary.
 */
export function boundaryNeedsArchitect(
  boundary: DeliveryBoundaryRecord,
  taskStatus: (taskId: string) => string | undefined,
): boolean {
  if (boundary.passed) return false;
  const resolution = boundary.resolution;
  if (!resolution) return true;
  return resolution.resolution === "repair_planned" &&
    (resolution.repairTaskIds ?? []).every((id) => TERMINAL_REPAIR_STATUSES.has(taskStatus(id) ?? "cancelled"));
}

/**
 * What the pump may do next for an integrated, unaccepted task. The kernel
 * enforces the same rules on the resulting events: a failed boundary is never
 * re-run on the same integration revision without an Architect recheck grant.
 */
export function deliveryBoundaryAction(
  state: DeliveryState | undefined,
  taskId: string,
  integrationRevision: string,
  taskStatus: (taskId: string) => string | undefined = () => undefined,
  boundaryIsCurrent: (boundary: DeliveryBoundaryRecord) => boolean = () => true,
): DeliveryBoundaryAction {
  const boundary = latestBoundary(state, taskId);
  if (!boundary || boundary.integrationRevision !== integrationRevision) return { type: "run" };
  if (!boundaryIsCurrent(boundary)) return { type: "run" };
  if (boundary.passed) return { type: "accept", boundary };
  if (boundaryNeedsArchitect(boundary, taskStatus)) {
    return { type: "architect", boundary, resolutionGeneration: boundaryResolutionGeneration(boundary) };
  }
  if (boundary.resolution?.resolution === "recheck" && !boundary.resolution.consumed) {
    return { type: "run" };
  }
  return { type: "wait", boundary };
}

/**
 * Phase-validation words map to runner boundary checks through the one fixed
 * vocabulary in planning-contracts.ts (plan readiness refuses any other word).
 */
export { phaseValidationCheckId };

export interface PhaseAcceptanceInputs {
  phase: {
    id: string;
    requirementIds: readonly string[];
    contributingTaskIds: readonly string[];
    requiredCombinedValidation: readonly string[];
  };
  requirements: readonly {
    id: string;
    contributingTaskIds: readonly string[];
    applicability: { status: "applicable" | "conditional_pending" | "not_applicable" };
  }[];
  taskStatuses: ReadonlyMap<string, string>;
  state: DeliveryState | undefined;
  integrationRevision: string | undefined;
}

/**
 * Pure phase-acceptance evaluation shared by the pump (to decide) and the
 * kernel (to validate). Exit checks are satisfied only by a passed boundary
 * run at the CURRENT integration revision.
 */
export function evaluatePhaseAcceptance(input: PhaseAcceptanceInputs): {
  ready: boolean;
  issues: string[];
  taskAcceptanceRefs: string[];
  exitChecks: DeliveryPhaseExitCheck[];
} {
  const issues: string[] = [];
  const accepted = (taskId: string) => input.state?.taskAcceptances[taskId] !== undefined;
  for (const requirementId of input.phase.requirementIds) {
    const requirement = input.requirements.find((candidate) => candidate.id === requirementId);
    if (!requirement) {
      issues.push(`Phase ${input.phase.id} requirement ${requirementId} is missing from the plan.`);
      continue;
    }
    if (requirement.applicability.status === "conditional_pending") {
      issues.push(`Phase ${input.phase.id} requirement ${requirementId} remains conditional_pending.`);
    }
    if (requirement.applicability.status === "applicable") {
      for (const taskId of requirement.contributingTaskIds) {
        if (input.taskStatuses.get(taskId) !== "cancelled" && !accepted(taskId)) {
          issues.push(`Phase ${input.phase.id} requirement ${requirementId} needs task ${taskId} accepted.`);
        }
      }
    }
  }
  const taskAcceptanceRefs: string[] = [];
  for (const taskId of input.phase.contributingTaskIds) {
    if (input.taskStatuses.get(taskId) === "cancelled") continue;
    if (!accepted(taskId)) issues.push(`Phase ${input.phase.id} task ${taskId} is not accepted.`);
    else taskAcceptanceRefs.push(taskId);
  }
  const exitChecks: DeliveryPhaseExitCheck[] = [];
  const currentBoundaries = Object.values(input.state?.boundaries ?? {})
    .flat()
    .filter((boundary) => boundary.passed && boundary.integrationRevision === input.integrationRevision)
    .sort((left, right) => left.sequence - right.sequence);
  for (const validation of input.phase.requiredCombinedValidation) {
    const checkId = phaseValidationCheckId(validation);
    if (!checkId) {
      issues.push(`Phase ${input.phase.id} exit check "${validation}" names no runner check.`);
      continue;
    }
    const boundary = currentBoundaries.find((candidate) =>
      candidate.checks.some((check) => check.checkId === checkId && check.outcome === "passed"));
    if (!boundary) {
      issues.push(`Phase ${input.phase.id} exit check "${validation}" has no passed ${checkId} run at the current integration revision.`);
      continue;
    }
    exitChecks.push({ validation, checkId, boundaryId: boundary.boundaryId });
  }
  return {
    ready: issues.length === 0,
    issues,
    taskAcceptanceRefs: taskAcceptanceRefs.sort(),
    exitChecks,
  };
}

export function finalReadyRequirementIssues(requirements: readonly { readonly id: string; readonly applicability: { readonly status: "applicable" | "conditional_pending" | "not_applicable"; readonly disposition?: { readonly amendmentRef?: string; readonly evidenceRef?: string }; }; }[]): string[] {
  const issues: string[] = [];
  for (const requirement of requirements) {
    if (requirement.applicability.status === "conditional_pending") issues.push(`Requirement ${requirement.id} remains conditional_pending.`);
    if (requirement.applicability.status === "not_applicable" && !requirement.applicability.disposition?.amendmentRef && !requirement.applicability.disposition?.evidenceRef) issues.push(`Requirement ${requirement.id} has no authorized not-applicable disposition.`);
  }
  return issues;
}

export function finalReadyCoverageIssues(
  requirements: readonly {
    readonly id: string;
    readonly contributingTaskIds: readonly string[];
    readonly applicability: { readonly status: "applicable" | "conditional_pending" | "not_applicable" };
  }[],
  taskStatuses: ReadonlyMap<string, string>,
): string[] {
  const issues: string[] = [];
  for (const requirement of requirements) {
    if (requirement.applicability.status !== "applicable") continue;
    const contributors = requirement.contributingTaskIds;
    if (contributors.length === 0) {
      issues.push(`Requirement ${requirement.id} has no contributing task coverage.`);
      continue;
    }
    if (contributors.every((taskId) => taskStatuses.get(taskId) === "cancelled")) {
      issues.push(`Requirement ${requirement.id} has cancelled-only coverage.`);
    }
  }
  return issues;
}

export function assertContractTaskRevisionAllowed(input: {
  readonly taskId: string;
  readonly patch: { readonly dependencies?: readonly string[]; readonly acceptanceCriteria?: unknown; readonly requiredCapabilities?: readonly string[] };
  readonly contract?: { readonly dependencies: readonly string[] };
}): void {
  if (!input.contract) return;
  if (input.patch.dependencies !== undefined && JSON.stringify(input.patch.dependencies) !== JSON.stringify(input.contract.dependencies)) {
    throw new Error(`Task ${input.taskId} contract dependencies change only through a new ready plan revision.`);
  }
  if (input.patch.acceptanceCriteria !== undefined || input.patch.requiredCapabilities !== undefined) {
    throw new Error(`Task ${input.taskId} contract fields change only through a new ready plan revision.`);
  }
}

/**
 * T6b seams. T6a only marks where T6b adds flaky isolation
 * (before a failing check charges a repair). It is an identity function now.
 */
export const T6B_FLAKY_ISOLATION_HOOK = "failing_check_requires_flaky_isolation_before_repair_charge" as const;

export interface FailingCheckRepairChargeInput {
  readonly flakyIsolation: { readonly outcome: "flaky" | "consistent_failure"; readonly failingTestIds: readonly string[] };
}

/**
 * T6b (OA-14): the charge decision for a failing check after flaky
 * isolation ran. `flaky` charges nothing — the check still blocks
 * acceptance until it passes on its own run. `consistent_failure`
 * charges exactly one issue-level cycle.
 */
export function failingCheckRepairChargeDecision(input: FailingCheckRepairChargeInput): "charge" | "no_charge_flaky" {
  if (input.flakyIsolation.outcome === "flaky") {
    if (input.flakyIsolation.failingTestIds.length === 0) throw new Error("A flaky finding must retain its failing test ids.");
    return "no_charge_flaky";
  }
  return "charge";
}

export function beforeFailingCheckRepairCharge<T>(value: T, input: FailingCheckRepairChargeInput): T {
  failingCheckRepairChargeDecision(input);
  void T6B_FLAKY_ISOLATION_HOOK;
  return value;
}

/**
 * T6b (OA-15): defect classes ride alongside findings until
 * `PlanningFinding` can carry one (planning-contracts.ts is frozen for
 * T6b — reported in evidence/T6b.md). Present classes are validated;
 * absent classes are kept for replay compatibility with older reviews.
 */
export function validateOptionalDefectClass(value: unknown, findingId: string): void {
  if (value === undefined) return;
  normalizeDefectClassLabel(value, findingId);
}

export function normalizeDefectClassLabel(value: unknown, findingId: string): string {
  const label = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!label) throw new Error(`Deliverable finding ${findingId} defect class is invalid.`);
  return label;
}

/** Defect classes in finding order; `undefined` where the review recorded none. */
export function deliveryFindingDefectClasses(value: unknown): Array<string | undefined> {
  if (!Array.isArray(value)) throw new Error("Deliverable findings must be an array.");
  return value.map((candidate) => {
    if (!isRecord(candidate) || candidate.defectClass === undefined) return undefined;
    return normalizeDefectClassLabel(candidate.defectClass, typeof candidate.id === "string" ? candidate.id : "?");
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value;
}
