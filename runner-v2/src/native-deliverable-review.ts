import { captureReviewReads } from "./review-evidence.js";
import { createHash } from "node:crypto";
import { resolveEvidenceContent } from "./evidence-content.js";
import {
  REVIEWER_POLICY_VERSION,
  claimBindingDigest,
  combineEvidenceContentDigests,
  computeReviewKey,
  repairDiffFingerprint,
  repairDiffReverseFingerprint,
  semanticContractDigest,
  testIntegrityDigest,
  type FailedRepairDiff,
  type ReviewKeyInputs,
  type TestIntegrityInputs,
} from "./review-key.js";
import { isDeepStrictEqual } from "node:util";

import type {
  AgentMessage,
  AgentModel,
  NativeTool,
  ToolCallBlock,
  ToolExecutionContext,
  ToolExecutionOutput,
  ToolResult,
} from "./agent-contracts.js";
import { deltaFilesWithoutPriorFindings, invalidatedEvidenceIds, parseDiffHunks, parseShownLines } from "./review-delta.js";
import { runAgentLoop, type AgentLoopResult } from "./agent-loop.js";
import {
  RUNNER_KERNEL_INVARIANTS,
  REVIEWER_CONTRACT_SECTION_ID,
  buildReviewerContractBlock,
  defectClassBrief,
} from "./agent-prompts.js";
import type { ReviewDefectRecorder } from "./defect-history.js";
import { modelTrackRecordSnapshot } from "./defect-history.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { BudgetLedger, ModelCostBasisSnapshot } from "./budget-ledger.js";
import { BudgetedAgentModel, type ModelCostEstimator } from "./budgeted-model.js";
import { BudgetedToolRuntime } from "./budgeted-tool-runtime.js";
import {
  ContextAssembler,
  ProtectedContextOverflowError,
  type ContextLimits,
  type ContextPack,
  type ContextSection,
} from "./context-assembler.js";
import { recordContextPack, type ContextManifestStore } from "./context-manifest-store.js";
import {
  DELIVERY_REVIEW_RUNNER_ID,
  assessDeliveryRisk,
  currentSubmissionReview,
  deliveryReviewDepthForTier,
  deliveryReviewId,
  diffLineCounts,
  latestCompletedReview,
  normalizeDefectClassLabel,
  taskAcceptedFailuresUsed,
  type DeliveryAffectedTestsRecord,
  type DeliveryClaim,
  type DeliveryState,
  type DeliveryProbeRecord,
  type DeliveryReviewRecord,
  type DeliveryReviewTier,
} from "./delivery-acceptance.js";
import type { EvidenceStore } from "./evidence-store.js";
import type { ExecutionGrantAuthority } from "./execution-grants.js";
import type { RunGitExecutionContext } from "./git-run-context.js";
import {
  LayeredToolRuntime,
  createInspectionTools,
  createVerifierCommandBroker,
  verifierModelAttribution,
} from "./native-verifier-runtime.js";
import type { OneShotCommandExecutor } from "./one-shot-command-executor.js";
import type { PermissionProfile } from "./contracts.js";
import type { SqlitePermissionStore } from "./permission-store.js";
import { PLANNING_FINDING_CATEGORIES, type ExecutionTaskContract } from "./planning-contracts.js";
import type { RunnerProviderRetryRuntime } from "./provider-call-retry.js";
import { classifyProviderFailure } from "./provider-health.js";
import { assertRoleToolSurface, type RoleCapabilityBroker } from "./role-capabilities.js";
import type { AgentRuntimeCandidate, RuntimeRouter } from "./runtime-router.js";
import {
  rebuildSchedulerProjection,
  resolveTaskContractReference,
  type SchedulerProjection,
  type SchedulerStore,
} from "./scheduler-store.js";
import type { SqliteAgentSessionStore } from "./sqlite-agent-session-store.js";
import type { BuildTask, TaskContractRef } from "./task-contracts.js";
import type { ToolInvocationLedger } from "./tool-ledger.js";
import { ToolRegistry, type AgentToolRuntime } from "./tool-registry.js";
import {
  assertFreshContextRequest,
  assertFreshContextSessionStarted,
  canonicalModelIdentity,
  type ReviewerIndependence,
} from "./verifier-contracts.js";

/**
 * T6a (P6.6, OA-3/OA-4/OA-10/OA-11/OA-13): the mandatory independent
 * deliverable reviewer for new-policy runs.
 *
 * Inputs come only from durable state: the plan-contract acceptance criteria,
 * the submitted change set (its real diff bytes from the artifact store), and
 * the worker's submit_task summary and cited evidence ids as claims. The risk
 * tier is the deterministic T5 tier of the real change.
 *
 * The review is a sequence of kernel-controlled passes. Each pass runs in its
 * own new session and ends with a lifecycle tool that writes one kernel event;
 * the next pass's context is built only after that event is durable:
 *
 *   A (high only): criteria only                 -> record_deliverable_obligations
 *   B: criteria (+obligations) + real diff + tools -> record_deliverable_findings
 *   C: + worker report and claims (+ prior findings) -> submit_deliverable_verdict
 *
 * At high tier the runtime (not the model) runs the affected-test command and
 * the OA-11 probe through the audited executor before pass B and attaches
 * their records to the findings event. Every medium/high findings event
 * carries the count of real inspection tool calls the reviewer made.
 */

export interface DeliverableReviewInputs {
  taskId: string;
  attempt: number;
  changeSetId: string;
  baselineRevision: string;
  taskRevision: string;
  diffArtifactHash: string;
  diffText: string;
  changedPaths: string[];
  objective: string;
  criteria: { id: string; text: string }[];
  workerSummary: string;
  unresolvedConcerns: string[];
  claims: DeliveryClaim[];
  authorRuntimeId: string;
  /**
   * W2 (AR-R28): delta-first re-review input, assembled by the runtime
   * from the prior completed review and the audited Git trees. Absent on
   * initial reviews and when no prior actual tree is available (the
   * findings pass then keeps the full cumulative diff).
   */
  fixDelta?: FixDeltaInputs;
  /**
   * C5 (AR-R16): the authoritative accepted contract from durable state,
   * rendered as the required compact contract block on the findings and
   * verdict passes. Optional loader copies are checked against the current
   * durable authority; review() always supplies the authoritative pair.
   */
  contract?: ExecutionTaskContract;
  /** The accepted revision/digest/task identity the contract was resolved at. */
  contractRef?: TaskContractRef;
  testIntegrityReference?: {
    planRevisionId: string; planDigest: string; baselinePinDigest: string; candidatePinDigest: string;
    baselineKind: "executed_report" | "no_configured_test_suite"; baselineExecuted?: number; baselineRevision: string;
    findings: readonly import("./test-integrity.js").TestIntegrityFinding[];
  };
}

/** W2 (AR-R28): ordered delta-first input for one fix re-review. */
export interface FixDeltaInputs {
  readonly priorReviewId: string;
  readonly priorHeadTree?: string;
  readonly headTree?: string;
  /** Changed files, prior reviewed head -> current head (full cumulative on fallback). */
  readonly deltaFiles: string[];
  /** Verified prior reviewed surface: prior cumulative files from actual Git trees ONLY. */
  readonly priorReviewedFiles: string[];
  /** Verified prior line coverage: new-side lines SHOWN in the prior cumulative diff. */
  readonly priorShownLines?: Record<string, number[]>;
  /** Authentic prior read ranges: actual returned lines, never widened. */
  readonly priorReadRanges: Array<{ path: string; startLine: number; endLine: number }>;
  /** Verified fix-delta hunks per file; absent when hunk mapping is skipped. */
  readonly deltaHunks?: Record<string, import("./review-delta.js").DeltaHunk[]>;
  /** Delta files no prior finding location names — PATHS ONLY, never finding names or claims. */
  readonly filesWithoutPriorFindings: string[];
  readonly invalidatedEvidenceIds: string[];
  /** Fix-delta unified diff text; empty on explicit fallback. */
  readonly deltaText: string;
  readonly deltaArtifactHash?: string;
  /** Submitted cumulative diff artifact (baseline -> current): the tool reference. */
  readonly cumulativeArtifactHash: string;
  readonly cumulativeIncludedUpFront: boolean;
  readonly overCorrection: boolean;
  readonly fallback?: "full_cumulative";
}

/** W2 (AR-R28): audited fix-delta diff primitive. Real Git trees only; undefined is an explicit miss. */
export interface FixDeltaResolver {
  (input: { priorBaseTree?: string; priorHeadTree: string; headTree: string }): Promise<{
    deltaFiles: string[];
    deltaText: string;
    priorReviewed: string[];
  } | undefined>;
}

export class DeliverableReviewInputsUnavailableError extends Error {}

export interface DeliveryReviewWorkspace {
  create(taskRevision: string): Promise<{ path: string }>;
  cleanup(): Promise<void>;
}

/** High-tier depth work the runtime performs through the audited executor. */
export interface DeliveryDepthRunner {
  run(input: {
    runId: string;
    taskId: string;
    reviewId: string;
    sessionId: string;
    reviewerRuntimeId: string;
    workspacePath: string;
    taskRevision: string;
    baselineRevision: string;
    changedFiles: readonly string[];
    diffText: string;
    signal?: AbortSignal;
  }): Promise<{ affectedTests: DeliveryAffectedTestsRecord; probe: DeliveryProbeRecord }>;
}

export interface NativeDeliverableReviewRuntimeOptions {
  store: SchedulerStore;
  architectRuntimeId: string;
  git?: RunGitExecutionContext;
  executionGrants?: ExecutionGrantAuthority;
  execution?: OneShotCommandExecutor;
  permissionProfile?: PermissionProfile;
  permissions?: SqlitePermissionStore;
  router: Pick<RuntimeRouter, "selectVerifier">;
  candidates: readonly AgentRuntimeCandidate[];
  models: ReadonlyMap<string, AgentModel>;
  reviewerRuntimeIds: readonly string[];
  sessions: SqliteAgentSessionStore;
  artifacts: ArtifactStore;
  evidenceStore: EvidenceStore;
  loadInputs(input: { runId: string; task: BuildTask; projection: SchedulerProjection }): Promise<DeliverableReviewInputs>;
  /**
   * W1 (AR-R27): cheap authority subset for the reuse decision — the
   * same validated submission, contract and diff bytes as loadInputs
   * but without the test-integrity candidate-pin workspace. Absent
   * only on historical harnesses, which fall back to loadInputs.
   */
  peekInputs?(input: { runId: string; task: BuildTask; projection: SchedulerProjection }): Promise<DeliverableReviewInputs>;
  /**
   * W1 (F6): actual Git tree resolution through the audited git
   * context. Unavailable or unresolvable revisions must yield
   * undefined (conservative reuse miss, never a substitute label);
   * the real diff digest always binds content separately.
   */
  resolveTrees?(input: { baselineRevision: string; taskRevision: string }): Promise<{ baseTree: string; headTree: string } | undefined>;
  /**
   * W2 (AR-R28): audited fix-delta diff between two ACTUAL Git trees,
   * wired by the factory through the audited verification runner (no new
   * product child_process). Unavailable or unresolvable trees must yield
   * undefined: the runtime then records the explicit conservative
   * fallback with the available full cumulative input.
   */
  resolveFixDelta?: FixDeltaResolver;
  workspace: DeliveryReviewWorkspace;
  depth: DeliveryDepthRunner;
  budgetLedger?: BudgetLedger;
  ledger?: ToolInvocationLedger;
  modelCostEstimators?: ReadonlyMap<string, ModelCostEstimator>;
  modelCostBases?: ReadonlyMap<string, ModelCostBasisSnapshot>;
  outputTokenReserve?: number;
  contextManifests?: ContextManifestStore;
  recordContextPackText?: boolean;
  defectClasses?: readonly string[];
  /** T6b repair (N-5): fresh top defect-class labels per review; wins over defectClasses. */
  defectClassesFor?: () => readonly string[];
  defectRecorder?: ReviewDefectRecorder;
  contextLimits?: ContextLimits;
  maxTurns?: number;
  providerRetryRuntime?: RunnerProviderRetryRuntime;
  clock?: () => string;
}

export interface NativeDeliverableReviewRequest {
  runId: string;
  taskId: string;
  signal?: AbortSignal;
  providerRetryDeadlineMs?: number;
}

export type NativeDeliverableReviewResult =
  | {
      readonly status: "reviewed";
      readonly reviewId: string;
      readonly runtimeId: string;
      readonly independence: ReviewerIndependence;
      readonly tier: DeliveryReviewTier;
      readonly replayed: boolean;
    }
  | {
      readonly status: "unavailable";
      readonly reviewId?: string;
      readonly reason: string;
      readonly detail?: string;
      readonly runtimeId?: string;
    }
  | {
      readonly status: "suspended";
      readonly reviewId: string;
      readonly reason: string;
      readonly runtimeId: string;
      readonly error?: string;
    };

type Pass = "obligations" | "findings" | "verdict";

/**
 * Session identity per (review, pass, runtime, independence); the review
 * id carries the durable generation. Ordinal 0 is the deterministic
 * first-try session. A missing stage whose session already carries
 * partial tool calls is retried in a NEW genuinely fresh session with
 * a higher ordinal — the contaminated session stays immutable and is
 * never borrowed. Ordinal 0 keeps its exact historical identity.
 */
export function deliverySessionId(
  runId: string,
  reviewId: string,
  pass: Pass,
  runtimeId: string,
  independence: ReviewerIndependence,
  retryOrdinal = 0,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([runId, reviewId, pass, runtimeId, independence]))
    .digest("hex")
    .slice(0, 24);
  const base = `delivery:${runId}:${digest}`;
  return retryOrdinal > 0 ? `${base}:retry${retryOrdinal}` : base;
}

export class NativeDeliverableReviewRuntime {
  private readonly clock: () => string;
  private readonly candidateById: Map<string, AgentRuntimeCandidate>;

  constructor(private readonly options: NativeDeliverableReviewRuntimeOptions) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.candidateById = new Map(options.candidates.map((candidate) => [candidate.runtimeId, candidate]));
  }

  async review(request: NativeDeliverableReviewRequest): Promise<NativeDeliverableReviewResult> {
    const projection = this.projection(request.runId);
    const task = projection.tasks[request.taskId];
    if (!task || task.status !== "submitted" || !task.changeSetId || projection.planningPolicyVersion !== 1) {
      throw new Error(`Deliverable review requires a submitted new-policy task ${request.taskId}.`);
    }
    // C5 (AR-R16): the CURRENT accepted contract is the only reviewer
    // authority, resolved here before any loader or provider call. An
    // invalid, stale, dropped or mismatched reference fails closed —
    // never a historical fallback on the live readiness path.
    // W1 (AR-R27): reuse is decided only AFTER these current authority
    // checks. A previously completed review never authorizes itself:
    // historical authority, fake identities, missing immutable artifacts
    // and stale observations cannot authorize reuse.
    const authority = resolveTaskContractReference(projection, task.id);
    if (authority.status !== "current") {
      return {
        status: "unavailable",
        reason: "delivery_contract_not_current",
        detail: `Task ${task.id} has no current accepted contract (resolution: ${authority.status}).`,
      };
    }
    // W1: cheap peek first — the same validated submission, contract and
    // diff bytes, but no candidate-pin workspace, no model and no depth.
    // The full inputs load only when a real review actually proceeds.
    let inputs: DeliverableReviewInputs;
    try {
      inputs = await (this.options.peekInputs ?? this.options.loadInputs)({ runId: request.runId, task, projection });
      assertInputs(inputs, task);
      inputs = bindContractAuthority(inputs, task, authority);
      // W1 (F6): the exact submitted immutable diff bytes at their
      // addressed artifact must verify, AND the supplied text must
      // equal those exact bytes — before model, workspace or cache
      // authority. Missing/tampered bytes fail closed as unavailable.
      await this.verifySubmittedDiff(inputs);
    } catch (error) {
      return { status: "unavailable", reason: "delivery_inputs_unavailable", detail: message(error) };
    }
    const architectRuntimeId = projection.runtime.architect.runtimeId ?? this.options.architectRuntimeId;
    const author = this.candidateById.get(inputs.authorRuntimeId);
    const architect = this.candidateById.get(architectRuntimeId);
    if (!author || !architect) {
      return {
        status: "unavailable",
        reason: "delivery_identity_unavailable",
        detail: `Author ${inputs.authorRuntimeId} or Architect ${architectRuntimeId} is not a configured runtime.`,
      };
    }
    const authorIdentity = canonicalModelIdentity(author.modelId);
    if (projection.encodingSafetyPolicyVersion === 1 && (!task.encodingSubmission || task.encodingSubmission.taskRevision !== inputs.taskRevision || task.encodingSubmission.baselineRevision !== inputs.baselineRevision)) throw new DeliverableReviewInputsUnavailableError("Exact submitted encoding facts unavailable.");
    if (projection.reviewIntegrityPolicyVersion === 1) {
      const history = projection.runtime.workerAssignmentHistory?.[`${task.id}:${task.attempt}`];
      if (!history?.length) throw new DeliverableReviewInputsUnavailableError("Captured attempt author history unavailable.");
      for (const assignment of history) {
        const candidate = this.candidateById.get(assignment.runtimeId);
        if (!candidate || canonicalModelIdentity(candidate.modelId) !== assignment.modelIdentity) throw new DeliverableReviewInputsUnavailableError("Captured author model identity differs from configured runtime.");
      }
      if (!task.reviewSignals || task.reviewSignals.taskRevision !== inputs.taskRevision || task.reviewSignals.baselineRevision !== inputs.baselineRevision) throw new DeliverableReviewInputsUnavailableError("Exact submitted review signals unavailable.");
    }
    // W1 (F1): no same-submission shortcut. A completed review for the
    // current submission never authorizes itself: validity is not equal
    // semantic contract/key. The current key, evidence integrity, tier
    // and policy are recomputed below for every hit, and only an exact
    // key match returns the prior verdict (as an additive reuse
    // binding). A different or unknown key archives the original
    // unchanged and opens a fresh generation instead; missing or
    // tampered evidence can never return the old verdict, and legacy
    // no-key reviews are a conservative miss.
    const existing = currentSubmissionReview(projection.delivery, task);
    // T6b repair (EP50): the OA-16 track-record snapshot feeds the T5
    // change-risk author tier; without outcomes the recorded default tier
    // applies exactly as before.
    const trackRecord = this.options.defectRecorder?.modelOutcomes
      ? modelTrackRecordSnapshot(this.options.defectRecorder.modelOutcomes(this.options.defectRecorder.projectId, request.runId))
      : undefined;
    const riskInput = {
      ...(projection.reviewIntegrityPolicyVersion === 1 ? { runnerSignals: structuredClone(task.reviewSignals!.signals) } : {}),
      authorModelId: authorIdentity,
      changedFiles: [...inputs.changedPaths],
      ...diffLineCounts(inputs.diffText),
      attempts: task.attempt,
      // OA-4: a prior attempt's accepted evidence failure counts on a fix re-review.
      acceptedFailuresUsed: taskAcceptedFailuresUsed([
        ...(projection.reviewHistory?.[task.id] ?? []),
        ...(projection.reviews[task.id] ? [projection.reviews[task.id]!] : []),
      ]),
      ...(trackRecord ? { trackRecord } : {}),
    };
    const risk = assessDeliveryRisk(riskInput);
    const authors = Object.keys(this.projection(request.runId).delivery?.authorModelIdentities ?? {});
    const selection = this.options.router.selectVerifier({
      requiredCapabilities: ["code"],
      candidateRuntimeIds: [...this.options.reviewerRuntimeIds],
      architectRuntimeId,
      acceptedChangeAuthorRuntimeIds: authors,
    });
    if (selection.status === "unavailable") {
      return { status: "unavailable", reason: "delivery_reviewer_unavailable", detail: selection.reason };
    }
    const candidate = this.candidateById.get(selection.runtime.runtimeId);
    const model = this.options.models.get(selection.runtime.runtimeId);
    if (!candidate || !model) {
      return { status: "unavailable", reason: "delivery_reviewer_unavailable", runtimeId: selection.runtime.runtimeId };
    }
    const independence = selection.independence;
    // W1 (F1): exact-key reuse. The CURRENT key above already
    // recomputed every verdict-affecting dimension (contract, actual
    // trees, real diff bytes, verified evidence content, claim
    // bindings, test-integrity reference, tier, reviewer policy).
    // The same exact key returns the PRIOR actual durable verdict: no
    // new review opens, no model or depth workspace work runs, and no
    // new repair cycle is charged. Original verdict/finding/read/depth
    // provenance is preserved; nothing is re-minted and no
    // current-session citation is invented. A different or unknown key
    // (including legacy no-key reviews) is a conservative miss.
    const reuseKey = await this.computeReviewKey(request.runId, task, inputs, authority.contract, authority.ref, risk.tier, authorIdentity);
    if (reuseKey) {
      const prior = findCompletedReviewByKey(projection.delivery, task.id, reuseKey.key);
      if (prior) {
        this.append(request.runId, "delivery.review_reused", `${task.id}:${task.attempt}:${reuseKey.key.slice(0, 16)}`, {
          taskId: task.id,
          attempt: task.attempt,
          changeSetId: task.changeSetId,
          criteriaIds: inputs.criteria.map((criterion) => criterion.id),
          authorRuntimeId: inputs.authorRuntimeId,
          authorModelIdentity: authorIdentity,
          architectRuntimeId,
          architectModelIdentity: canonicalModelIdentity(architect.modelId),
          priorReviewId: prior.reviewId,
          reviewKey: reuseKey.key,
        });
        return {
          status: "reviewed",
          reviewId: prior.reviewId,
          runtimeId: prior.reviewerRuntimeId!,
          independence: prior.independence!,
          tier: prior.risk!.tier,
          replayed: true,
        };
      }
    }
    // W1 (F3): an interrupted review resumes at its FIRST MISSING
    // durable stage when the same exact KNOWN reviewer runtime/model/
    // key and eligible identity continue. A different reviewer,
    // runtime, model, independence, identity or key starts a new
    // generation instead (the unfinished review is abandoned and stays
    // immutable). An unknown previous key never continues: without a
    // proven prior identity the review restarts at its first stage in
    // a new generation once the actual tree is known. Completed stages
    // keep their original sessions and never veto a resume; a missing
    // stage whose session already carries partial tool calls is
    // retried in a NEW genuinely fresh retry session after the partial
    // work — only durably completed stages are ever reused, partial
    // reads are never borrowed. A completed current submission without
    // an exact key match is never resumed here: it is archived
    // unchanged and a fresh generation opens below.
    const unfinished = existing && existing.stage !== "completed" ? existing : undefined;
    const keyContinues = reuseKey !== undefined &&
      unfinished?.reviewKey !== undefined && unfinished.reviewKey === reuseKey.key;
    if (
      unfinished &&
      keyContinues &&
      unfinished.reviewerRuntimeId === candidate.runtimeId &&
      unfinished.reviewerModelIdentity === canonicalModelIdentity(candidate.modelId) &&
      unfinished.independence === independence &&
      unfinished.risk?.tier === risk.tier &&
      !unfinished.reusedFrom &&
      firstMissingResumePass(unfinished) !== undefined
    ) {
      inputs = await this.ensureFullInputs(request.runId, task, projection, inputs, authority);
      // W2: a resumed re-review rebuilds the same deterministic delta-first
      // input (same prior, same actual trees) before its remaining stages.
      const resumeFixDelta = await this.assembleFixDelta(task, inputs, latestCompletedReview(this.projection(request.runId).delivery, task.id), reuseKey?.inputs.headTree, risk.tier);
      if (resumeFixDelta) inputs = { ...inputs, fixDelta: resumeFixDelta };
      const context: PassContext = { request, reviewId: unfinished.reviewId, inputs, candidate, model, independence, tier: risk.tier, ...(projection.reviewIntegrityPolicyVersion === 1 ? { reviewIntegrityPolicyVersion: 1 } : {}), defectClasses: this.resolveDefectClasses(), retryOrdinals: {} };
      // W1 (F3): durably completed stages whose sessions lack
      // session.complete (close/reopen between the lifecycle event and
      // completion) are reconciled WITHOUT re-executing their passes.
      this.reconcileCompletedStageSessions(unfinished);
      return await this.runRemainingStages(context, unfinished.reviewId);
    }
    const generation = nextGeneration(projection, task.id);
    const reviewId = deliveryReviewId(task.id, task.attempt, generation);
    this.append(request.runId, "delivery.review_started", `${reviewId}:started`, {
      taskId: task.id,
      reviewId,
      generation,
      attempt: task.attempt,
      changeSetId: task.changeSetId,
      diffArtifactHash: inputs.diffArtifactHash,
      criteriaIds: inputs.criteria.map((criterion) => criterion.id),
      authorRuntimeId: inputs.authorRuntimeId,
      authorModelIdentity: authorIdentity,
      architectRuntimeId,
      architectModelIdentity: canonicalModelIdentity(architect.modelId),
    });
    const prior = latestCompletedReview(this.projection(request.runId).delivery, task.id);
    // W2 (AR-R28): delta-first input for a fix re-review, assembled from
    // the prior completed review and the audited actual trees before any
    // new reviewer session opens. Initial reviews carry no delta.
    const fixDelta = await this.assembleFixDelta(task, inputs, prior, reuseKey?.inputs.headTree, risk.tier);
    if (fixDelta) inputs = { ...inputs, fixDelta };
    this.append(request.runId, "delivery.review_requested", `${reviewId}:requested`, {
      taskId: task.id,
      reviewId,
      reviewerRuntimeId: candidate.runtimeId,
      reviewerModelIdentity: canonicalModelIdentity(candidate.modelId),
      independence,
      reviewTier: risk.tier,
      riskDigest: risk.digest,
      riskInput,
      ...(prior ? { priorReviewId: prior.reviewId } : {}),
      ...(await this.reviewKeyRequestFields(request.runId, task, inputs, reuseKey)),
      ...(fixDelta ? { delta: toDurableReviewDelta(fixDelta) } : {}),
    });
    const tier = risk.tier;
    inputs = await this.ensureFullInputs(request.runId, task, projection, inputs, authority);
    const context: PassContext = { request, reviewId, inputs, candidate, model, independence, tier, ...(projection.reviewIntegrityPolicyVersion === 1 ? { reviewIntegrityPolicyVersion: 1 } : {}), defectClasses: this.resolveDefectClasses() };
    return await this.runRemainingStages(context, reviewId);
  }
  /** Runs one pass; returns a terminal result when the pass did not record its stage. */
  private async runPass(
    context: PassContext,
    pass: Pass,
    workspacePath: string | undefined,
  ): Promise<NativeDeliverableReviewResult | undefined> {
    const { request, reviewId, candidate, model, independence } = context;
    const expectedStage = expectedStageForPass(pass);
    // W1 (F3): the missing stage runs in its deterministic session
    // when empty, else in a new genuinely fresh retry session.
    const sessionId = this.passSessionId(context, pass);
    const earlyDurable = this.projection(request.runId).delivery?.reviews[context.inputs.taskId];
    if (earlyDurable?.reviewId === reviewId && earlyDurable.stage === expectedStage) {
      // W1: the lifecycle event is durable but session.complete may be
      // missing (for example SQLite close/reopen between them).
      // Complete the open session conservatively; a completed stage is
      // never re-executed and no duplicate verdict provenance is minted.
      if (this.options.sessions.events(sessionId).length > 0) {
        try {
          this.options.sessions.complete(sessionId, this.clock());
        } catch {
          // Already completed: the durable stage stands either way.
        }
      }
      return undefined;
    }
    const limits = this.options.contextLimits ?? { ...DELIVERABLE_REVIEW_CONTEXT_LIMITS };
    let pack: ContextPack;
    try {
      pack = new ContextAssembler(limits).assemble(this.sections(context, pass));
    } catch (error) {
      if (error instanceof ProtectedContextOverflowError) {
        return { status: "unavailable", reviewId, reason: `delivery_${pass}_context_overflow`, detail: message(error), runtimeId: candidate.runtimeId };
      }
      throw error;
    }
    await recordContextPack({
      store: this.options.contextManifests,
      artifacts: this.options.artifacts,
      recordPackText: this.options.recordContextPackText,
      runId: request.runId,
      sessionId,
      actor: { role: "verifier", id: candidate.runtimeId },
      role: "verifier",
      purpose: `delivery:${pass}`,
      limits,
      pack,
      recordedAt: this.clock(),
    });
    const messages: AgentMessage[] = [
      { id: `delivery-${pass}-system`, role: "system", content: deliveryReviewerSystemPrompt(pass, context.tier, context.reviewIntegrityPolicyVersion, context.inputs.fixDelta !== undefined) },
      { id: `context:${pack.digest}`, role: "user", content: pack.text },
    ];
    // Fresh-context device: every pass opens a new session whose event list
    // is empty, and its first request carries only the pack messages.
    assertFreshContextRequest({
      independence,
      priorEventCount: this.options.sessions.events(sessionId).length,
      messages,
      packMessageIds: messages.map((item) => item.id),
    });
    await this.options.sessions.create({
      sessionId,
      runId: request.runId,
      actor: { role: "verifier", id: candidate.runtimeId },
      occurredAt: this.clock(),
    });
    assertFreshContextSessionStarted(independence, this.options.sessions.events(sessionId));
    const counter = { calls: 0 };
    const tools = this.passTools(context, pass, sessionId, workspacePath, counter);
    const result = await runAgentLoop({
      model: this.budgetedModel(model, candidate, request.runId, sessionId),
      registry: tools,
      context: {
        runId: request.runId,
        sessionId,
        actor: { role: "verifier", id: candidate.runtimeId },
        ...(workspacePath ? { workspacePath } : {}),
        signal: request.signal,
      },
      initialMessages: messages,
      maxTurns: this.options.maxTurns ?? 24,
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
    const durable = this.projection(request.runId).delivery?.reviews[context.inputs.taskId];
    if (passEnded(result, pass, reviewId) && durable?.reviewId === reviewId && durable.stage === expectedStageForPass(pass)) {
      this.options.sessions.complete(sessionId, this.clock());
      return undefined;
    }
    if (result.status === "suspended") {
      return {
        status: "suspended",
        reviewId,
        reason: result.reason,
        runtimeId: candidate.runtimeId,
        ...(result.error ? { error: result.error } : {}),
      };
    }
    return {
      status: "unavailable",
      reviewId,
      reason: `delivery_${pass}_incomplete`,
      detail: `The ${pass} pass ended with status ${result.status} and no durable ${expectedStage} stage.`,
      runtimeId: candidate.runtimeId,
    };
  }

  private sections(context: PassContext, pass: Pass): ContextSection[] {
    const { inputs } = context;
    const durable = this.projection(context.request.runId).delivery?.reviews[inputs.taskId];
    const sections: ContextSection[] = [
      section("kernel-invariants", "system", RUNNER_KERNEL_INVARIANTS),
      section("task-objective", "task", `Task ${inputs.taskId} objective:\n${inputs.objective}`),
      section(
        "acceptance-criteria",
        "criteria",
        `Plan-contract acceptance criteria (the source of truth):\n${inputs.criteria.map((criterion) => `- ${criterion.id}: ${criterion.text}`).join("\n")}`,
      ),
    ];
    // C5 (AR-R16): the authoritative compact contract on the findings and
    // verdict passes. The obligations pass keeps criteria only
    // (obligations-before-diff isolation); findings-before-claims and
    // prior-findings isolation below are unchanged.
    if (pass !== "obligations" && inputs.contract) {
      sections.push(section(
        REVIEWER_CONTRACT_SECTION_ID,
        "contract",
        buildReviewerContractBlock(inputs.contract, inputs.contractRef),
      ));
    }
    if (pass === "obligations") return sections;
    if (durable?.runnerEncoding) {
      sections.push(section("submission-encoding-findings", "contract", "Runner encoding byte facts (blocking changes require an Architect disposition or repair):\n" + JSON.stringify(durable.runnerEncoding, null, 2) + "\nThese facts remain blocking when you return no findings. Do not use reserved submission-encoding IDs. Your verdict must be unsatisfied while a runner encoding finding remains unresolved."));
    }
    if (context.reviewIntegrityPolicyVersion === 1) {
      const record = this.projection(context.request.runId).tasks[inputs.taskId]?.reviewSignals;
      if (!record || record.changeSetId !== inputs.changeSetId) throw new DeliverableReviewInputsUnavailableError("Exact runner signals unavailable for review context.");
      sections.push(section("runner-signals", "depth", `Runner submission signals (mechanical reference facts; inspect their implications):\n${JSON.stringify(record.signals, null, 2)}`));
    }
    if (durable?.runnerScope) {
      sections.push(section("submission-scope-findings", "contract",
        "Runner submission scope findings (blocking; only the Architect can resolve them against the current plan):\n" +
        JSON.stringify(durable.runnerScope, null, 2) +
        "\nThese facts remain blocking even when you return no findings. Do not copy or reuse their reserved submission-scope IDs. Your verdict must be unsatisfied while any runner scope finding remains unresolved."));
    }
    if (inputs.testIntegrityReference) {
      sections.push(section("test-integrity-reference", "contract",
        "Runner test-integrity baseline and candidate fingerprints (observational; no automatic exception):\n" + JSON.stringify(inputs.testIntegrityReference, null, 2) +
        "\nIf tests are legitimately obsolete or merged, independently inspect their replacement behavior. In the verdict, an optional testConsolidation must name affected test IDs, the behavior proof reference, exact plan/fingerprints, permitted changes and a positive minimum executed count. Ordinary approval prose grants no exception. Unexplained command/config changes or suite shrink remain blocking at the boundary."));
    }
    if (durable?.obligations) {
      sections.push(section(
        "own-obligations",
        "obligations",
        `Obligations you recorded before seeing the diff:\n${JSON.stringify(durable.obligations, null, 2)}`,
      ));
    }
    // F4: initial reviews keep the full cumulative diff here. Fix
    // re-reviews render it inside deltaContextSections AFTER the correction
    // input (criteria -> fix delta -> unnamed files -> invalidated evidence
    // -> allowed cumulative). Prior findings stay withheld until durable
    // own findings exist.
    if (!inputs.fixDelta) {
      sections.push(section(
        "submitted-diff",
        "diff",
        `Submitted change ${inputs.changeSetId} (baseline ${inputs.baselineRevision} -> task revision ${inputs.taskRevision}).\n` +
          `Changed files:\n${inputs.changedPaths.map((path) => `- ${path}`).join("\n")}\n\n${this.cumulativeDiffTail(context)}`,
      ));
    }
    // W2 (AR-R28): delta-first re-review input rides both the findings
    // and the verdict pass (each pass runs in a fresh session). Prior
    // findings are never included here — the verdict context releases
    // them only after the reviewer records its own findings.
    for (const deltaSection of this.deltaContextSections(context)) sections.push(deltaSection);
    if (context.depthRecords) {
      sections.push(section(
        "runner-depth",
        "depth",
        `Runner-executed high-tier checks (audited; recorded with your findings):\n${JSON.stringify(context.depthRecords, null, 2)}`,
      ));
    }
    // T6b (OA-15/EP49): the project's top defect classes ride the regular
    // pack (never the obligations pass, which derives from the criteria
    // alone), so the inclusion and its cost are recorded in the pass's
    // context manifest (EP40) like every other section.
    if (context.defectClasses?.length) {
      sections.push({
        id: "defect-classes",
        kind: "defects",
        required: false,
        priority: 650,
        content: defectClassBrief(context.defectClasses),
      });
    }
    if (pass === "findings") return sections;
    sections.push(section(
      "own-findings",
      "own-findings",
      `Your durably recorded findings:\n${JSON.stringify(durable?.findings ?? [], null, 2)}`,
    ));
    sections.push(section(
      "worker-report",
      "report",
      `The worker's report (a claim, not evidence):\nSummary: ${inputs.workerSummary}\n` +
        `Unresolved concerns:\n${inputs.unresolvedConcerns.length > 0 ? inputs.unresolvedConcerns.map((item) => `- ${item}`).join("\n") : "- none"}`,
    ));
    if (durable?.reviewEvidencePolicyVersion === 1) sections.push(section("review-evidence-policy", "contract", "Every verified claim requires citations: [{path, line}] or [{evidenceId}], backed by successful fs.read, inspect_evidence or complete artifact.read in THIS fresh verdict session. Earlier pass reads and context prose grant no citation authority. Surviving mutants are reserved blocking findings. Release only with survivorDispositions: [{findingId, disposition: \"not_a_real_gap\", rationale}] explaining why each survivor is not a real gap; otherwise return unsatisfied."));
    sections.push(section(
      "worker-claims",
      "claims",
      `Worker claims to judge one by one (verified only when you confirmed it yourself):\n${JSON.stringify(inputs.claims, null, 2)}`,
    ));
    // W2 (AR-R28): the late-finding rule rides the fix re-review verdict
    // pass, before the released prior findings.
    if (durable?.priorReviewId !== undefined) sections.push(this.lateFindingRuleSection());
    const prior = durable?.priorReviewId
      ? (this.projection(context.request.runId).delivery?.reviewHistory[inputs.taskId] ?? [])
          .find((review) => review.reviewId === durable.priorReviewId)
      : undefined;
    if (prior) {
      sections.push(section(
        "prior-findings",
        "prior-findings",
        `Prior review ${prior.reviewId} findings, released after your own findings were recorded. Check each one:\n${JSON.stringify(prior.findings ?? [], null, 2)}`,
      ));
    }
    return sections;
  }

  /**
   * W2 (AR-R28): cumulative-diff gating for fix re-reviews. The full
   * cumulative baseline->current text rides up front only at high tier
   * or when the actual fix delta touches files outside prior finding
   * locations (over-correction signal), or on the explicit fallback.
   * Otherwise the reviewer gets a real tool/artifact reference and the
   * fix delta as the primary surface. Initial reviews always include
   * the full diff.
   */
  private cumulativeDiffTail(context: PassContext): string {
    const { inputs } = context;
    const delta = inputs.fixDelta;
    if (!delta || delta.cumulativeIncludedUpFront) return `Unified diff:\n${inputs.diffText}`;
    return `Unified diff: withheld up front on this fix re-review (ordinary ${context.tier}-tier repair with no over-correction signal). ` +
      `The complete cumulative diff (baseline ${inputs.baselineRevision} -> task revision ${inputs.taskRevision}) remains available: ` +
      `open it with the artifact read tool at hash ${inputs.diffArtifactHash}, or inspect the task-revision checkout with your git tools. ` +
      `Judge the fix delta below first.`;
  }

  /**
   * F4: correction-first sections for a fix re-review, in required order:
   * criteria (already first), the actual fix delta (prior reviewed head
   * -> current head), the delta files no prior finding location names
   * (paths only — never finding names or claims), the invalidated evidence
   * facts, and only then the allowed cumulative context (full text at high
   * tier or on the over-correction signal, else a real tool reference).
   * Prior findings are NEVER included here: the verdict context releases
   * them only after the reviewer records its own findings.
   */
  private deltaContextSections(context: PassContext): ContextSection[] {
    const { inputs } = context;
    const delta = inputs.fixDelta;
    if (!delta) return [];
    const fixBody = delta.fallback
      ? `Explicit conservative fallback (${delta.fallback}): prior trees, artifacts or evidence were unavailable, so the available full cumulative input stands in. ` +
        `Treat every unknown surface as unreviewed; do not assume the repair is small.`
      : `Fix delta (prior reviewed head ${delta.priorHeadTree ?? "unknown"} -> current head ${delta.headTree ?? "unknown"}).\n` +
        `Changed files:\n${delta.deltaFiles.map((path) => `- ${path}`).join("\n")}\n\nUnified fix diff:\n${delta.deltaText}` +
        (delta.deltaArtifactHash ? `\nFix-delta bytes are also stored at artifact hash ${delta.deltaArtifactHash}.` : "");
    return [
      section("fix-delta", "diff", fixBody),
      section(
        "delta-files-without-findings",
        "diff",
        `Runner-computed fix-delta files that no prior finding location names (over-correction signal; PATHS ONLY — no finding names or claims):\n` +
          (delta.filesWithoutPriorFindings.length > 0
            ? delta.filesWithoutPriorFindings.map((path) => `- ${path}`).join("\n")
            : "- none") +
          (delta.overCorrection ? "\nThe delta touches files outside prior finding locations: the full cumulative diff is included up front." : ""),
      ),
      section(
        "invalidated-evidence",
        "evidence",
        `Evidence facts invalidated by changed tree/content identity (re-verify them; prior reads grant no authority):\n` +
          (delta.invalidatedEvidenceIds.length > 0 ? delta.invalidatedEvidenceIds.map((id) => `- ${id}`).join("\n") : "- none"),
      ),
      section(
        "submitted-diff",
        "diff",
        `Submitted change ${inputs.changeSetId} (baseline ${inputs.baselineRevision} -> task revision ${inputs.taskRevision}).\n` +
          `Changed files:\n${inputs.changedPaths.map((path) => `- ${path}`).join("\n")}\n\n${this.cumulativeDiffTail(context)}`,
      ),
    ];
  }

  /**
   * W2 (AR-R28, CD-4): late-finding rule reminder for a fix re-review
   * verdict pass. The kernel enforces the mechanical side; this states
   * the reviewer's obligations, including the both-directions check.
   */
  private lateFindingRuleSection(): ContextSection {
    return section(
      "late-finding-rule",
      "contract",
      `Fix re-review, both directions: check EVERY prior finding as resolved or outstanding with a rationale (exactly once each), AND check that no change goes beyond what the findings require and no previously satisfied criterion regressed. ` +
        `After the first review, a NEW blocking finding on unchanged already-reviewed code counts only when it is critical (security, data loss, false acceptance) with an explicit rationale, or backed by an actual failing test from this review's runner checks — mark the basis on the finding. ` +
        `Other late observations are retained as nonblocking follow-up. Findings on changed, unreviewed or unknown surfaces stay blocking. ` +
        `Runner scope, encoding, mutation-survivor and oscillation facts keep their reserved blocking force regardless of this rule.`,
    );
  }

  private passTools(
    context: PassContext,
    pass: Pass,
    sessionId: string,
    workspacePath: string | undefined,
    counter: { calls: number },
  ): AgentToolRuntime {
    const lifecycle: NativeTool<unknown> = pass === "obligations"
      ? createRecordDeliverableObligationsTool(this.lifecycleOptions(context, pass, sessionId)) as NativeTool<unknown>
      : pass === "findings"
        ? createRecordDeliverableFindingsTool({
            ...this.lifecycleOptions(context, pass, sessionId),
            depth: () => ({
              inspectionToolCalls: counter.calls,
              ...(context.depthRecords ? context.depthRecords : {}),
            }),
          }) as NativeTool<unknown>
        : createSubmitDeliverableVerdictTool(this.lifecycleOptions(context, pass, sessionId)) as NativeTool<unknown>;
    let runtime: AgentToolRuntime;
    let broker: RoleCapabilityBroker;
    if (pass === "obligations") {
      broker = "delivery_obligations";
      const registry = new ToolRegistry();
      registry.register(lifecycle);
      runtime = registry;
    } else {
      const commands = pass === "findings" && deliveryReviewDepthForTier(context.tier).affectedTests;
      broker = commands ? "delivery_commands" : "delivery";
      const base = {
        git: this.options.git,
        executionGrants: this.options.executionGrants,
        workspacePath: workspacePath!,
        artifacts: this.options.artifacts,
        evidenceStore: this.options.evidenceStore,
        runId: context.request.runId,
        clock: this.clock,
        ...(this.options.ledger ? { ledger: this.options.ledger } : {}),
        ...(this.options.permissions ? { permissions: this.options.permissions } : {}),
      };
      const inspection = createInspectionTools({
        ...base,
        capabilityRole: "verifier",
        capabilityBroker: broker,
        lifecycleTool: lifecycle,
      });
      runtime = commands
        ? new LayeredToolRuntime(inspection, createVerifierCommandBroker({
            ...base,
            ...(this.options.execution ? { execution: this.options.execution } : {}),
            ...(this.options.permissionProfile ? { permissionProfile: this.options.permissionProfile } : {}),
          }))
        : inspection;
    }
    assertRoleToolSurface("verifier", broker, runtime.definitions().map((definition) => definition.name));
    const budgeted = this.options.budgetLedger
      ? new BudgetedToolRuntime({
          runtime,
          ledger: this.options.budgetLedger,
          scopeId: context.request.runId,
          clock: this.clock,
        })
      : runtime;
    return new InspectionCountingRuntime(budgeted, counter);
  }

  private lifecycleOptions(context: PassContext, pass: Pass, sessionId: string): DeliveryLifecycleToolOptions {
    return {
      store: this.options.store,
      runId: context.request.runId,
      taskId: context.inputs.taskId,
      reviewId: context.reviewId,
      runtimeId: context.candidate.runtimeId,
      sessionId,
      // W1 (F3): the retry ordinal of the session this pass actually
      // runs in, so the read-capture authority gate binds the real
      // retry session instead of only the deterministic first try.
      retryOrdinal: context.retryOrdinals?.[pass] ?? 0,
      clock: this.clock,
      ...(this.options.ledger ? { ledger: this.options.ledger } : {}),
      evidenceStore: this.options.evidenceStore,
      sessions: this.options.sessions,
      ...(this.options.defectRecorder ? { defects: { ...this.options.defectRecorder } } : {}),
    };
  }

  /**
   * W1 (F3): the session a pass runs in — its deterministic session
   * when still empty, else the first genuinely fresh retry session.
   * Ordinals resolve once per review call and are memoized on the
   * context, so depth work, session creation, lifecycle tools and the
   * read-capture gate all bind the SAME session.
   */
  private passSessionId(context: PassContext, pass: Pass): string {
    const ordinal = context.retryOrdinals?.[pass] ?? this.resolvePassSessionOrdinal(context, pass);
    return deliverySessionId(
      context.request.runId,
      context.reviewId,
      pass,
      context.candidate.runtimeId,
      context.independence,
      ordinal,
    );
  }

  private resolvePassSessionOrdinal(context: PassContext, pass: Pass): number {
    let ordinal = 0;
    while (
      this.options.sessions.events(deliverySessionId(
        context.request.runId,
        context.reviewId,
        pass,
        context.candidate.runtimeId,
        context.independence,
        ordinal,
      )).length !== 0
    ) {
      ordinal += 1;
    }
    if (context.retryOrdinals) context.retryOrdinals[pass] = ordinal;
    else context.retryOrdinals = { [pass]: ordinal };
    return ordinal;
  }

  /**
   * W1 (F3): completes the open sessions of durably recorded stages
   * when the lifecycle event is durable but session.complete is
   * absent (for example SQLite close/reopen between them). Only
   * sessions already bound to durable stages are completed — partial
   * sessions of missing stages are never touched — and no stage is
   * ever re-executed to reconcile.
   */
  private reconcileCompletedStageSessions(review: DeliveryReviewRecord): void {
    for (const sessionId of review.sessionIds ?? []) {
      const events = this.options.sessions.events(sessionId);
      if (events.length === 0) continue;
      if (events.some((event) =>
        event.type === "session.completed" || event.type === "session.submitted" || event.type === "session.suspended",
      )) continue;
      try {
        this.options.sessions.complete(sessionId, this.clock());
      } catch {
        // The durable stage stands either way; never re-execute to reconcile.
      }
    }
  }

  private resolveDefectClasses(): readonly string[] | undefined {
    const classes = this.options.defectClassesFor?.() ?? this.options.defectClasses;
    return classes?.length ? [...classes] : undefined;
  }

  private append(runId: string, type: string, key: string, payload: Record<string, unknown>): void {
    this.options.store.append({
      runId,
      type: type as Parameters<SchedulerStore["append"]>[0]["type"],
      occurredAt: this.clock(),
      actor: { role: "runner", id: DELIVERY_REVIEW_RUNNER_ID },
      idempotencyKey: `delivery-review:${key}`,
      payload,
    });
  }

  private projection(runId: string): SchedulerProjection {
    return rebuildSchedulerProjection(this.options.store.readRun(runId));
  }

  /**
   * W1: runs only the stages the durable record is still missing for
   * this review. Completed stages are never re-executed, and every
   * runner-emitted stage event is gated on its exact expected
   * predecessor, so a retried call cannot duplicate durable history.
   * Depth work runs only while its consuming findings stage is still
   * missing; an exact repeat performs no workspace, depth or model work.
   */
  private async runRemainingStages(context: PassContext, reviewId: string): Promise<NativeDeliverableReviewResult> {
    const { request, inputs, candidate, independence, tier } = context;
    const taskId = inputs.taskId;
    const durable = (): DeliveryReviewRecord | undefined => this.projection(request.runId).delivery?.reviews[taskId];
    const atStage = (stage: DeliveryReviewRecord["stage"]): boolean => {
      const record = durable();
      return record?.reviewId === reviewId && record.stage === stage;
    };
    const depth = deliveryReviewDepthForTier(tier, context.reviewIntegrityPolicyVersion);
    let workspace: { path: string } | undefined;
    try {
      if (depth.obligationsFirst && atStage("requested")) {
        const obligations = await this.runPass(context, "obligations", undefined);
        if (obligations) return obligations;
      }
      if (atStage("requested") || atStage("obligations_recorded")) {
        this.append(request.runId, "delivery.criteria_and_diff_delivered", `${reviewId}:diff`, {
          taskId,
          reviewId,
          diffArtifactHash: inputs.diffArtifactHash,
        });
      }
      const record = durable();
      const needsWorkspace = record?.reviewId === reviewId &&
        (record.stage === "diff_delivered" || record.stage === "findings_recorded" || record.stage === "report_delivered");
      if (needsWorkspace) {
        await this.options.workspace.cleanup();
        workspace = await this.options.workspace.create(inputs.taskRevision);
        if (depth.affectedTests && atStage("diff_delivered")) {
          try {
            context.depthRecords = await this.options.depth.run({
              runId: request.runId,
              taskId,
              reviewId,
              sessionId: this.passSessionId(context, "findings"),
              reviewerRuntimeId: candidate.runtimeId,
              workspacePath: workspace.path,
              taskRevision: inputs.taskRevision,
              baselineRevision: inputs.baselineRevision,
              changedFiles: inputs.changedPaths,
              diffText: inputs.diffText,
              ...(request.signal ? { signal: request.signal } : {}),
            });
          } catch (error) {
            return { status: "unavailable", reviewId, reason: "delivery_depth_unavailable", detail: message(error), runtimeId: candidate.runtimeId };
          }
        }
      }
      if (atStage("diff_delivered")) {
        if (!workspace) throw new Error("Findings pass requires its review workspace.");
        const findings = await this.runPass(context, "findings", workspace.path);
        if (findings) return findings;
      }
      if (atStage("findings_recorded")) {
        this.append(request.runId, "delivery.report_delivered", `${reviewId}:report`, {
          taskId,
          reviewId,
          claims: inputs.claims.map((claim) => ({ ...claim, evidenceIds: [...claim.evidenceIds] })),
        });
      }
      if (atStage("report_delivered")) {
        if (!workspace) throw new Error("Verdict pass requires its review workspace.");
        const verdict = await this.runPass(context, "verdict", workspace.path);
        if (verdict) return verdict;
      }
    } finally {
      if (workspace) await this.options.workspace.cleanup().catch(() => undefined);
    }
    const finished = durable();
    if (finished?.reviewId === reviewId && finished.stage === "completed") {
      return { status: "reviewed", reviewId, runtimeId: candidate.runtimeId, independence, tier, replayed: false };
    }
    return { status: "unavailable", reviewId, reason: "delivery_review_incomplete", detail: `Review ${reviewId} ended at stage ${finished?.stage ?? "unknown"}.`, runtimeId: candidate.runtimeId };
  }

  /**
   * W1: upgrades peek inputs to the full loader (test-integrity pin
   * workspace included) once a real review — fresh or resumed — is
   * certain. The peek already carried the validated submission,
   * contract and diff bytes, so this only adds the pin workspace the
   * reuse decision must not buy. Harnesses without a peek loader are
   * already full and pass through untouched.
   */
  private async ensureFullInputs(
    runId: string,
    task: BuildTask,
    projection: SchedulerProjection,
    inputs: DeliverableReviewInputs,
    authority: { readonly ref: TaskContractRef; readonly contract: ExecutionTaskContract },
  ): Promise<DeliverableReviewInputs> {
    if (!this.options.peekInputs) return inputs;
    const full = await this.options.loadInputs({ runId, task, projection });
    assertInputs(full, task);
    const bound = bindContractAuthority(full, task, authority);
    // W2: the peek already assembled the delta-first input from the same
    // validated submission; the full loader only adds the pin workspace.
    return inputs.fixDelta ? { ...bound, fixDelta: inputs.fixDelta } : bound;
  }

  /**
   * W1 (F1/F5/F6/F7): computes the ReviewKey for the CURRENT
   * submission. Every dimension is verified: the current accepted
   * contract, the ACTUAL base and head Git trees through the audited
   * resolver (never a manufactured label), the real diff bytes from
   * the immutable artifact, the observed current-run evidence with
   * immutable artifact verification, the content-bound claim
   * semantics and evidence associations, the durable
   * baseline/candidate test-integrity identity, tier and reviewer
   * policy. Any failure is a conservative miss (undefined): unknown
   * inputs never hit.
   */
  private async computeReviewKey(
    runId: string,
    task: BuildTask,
    inputs: DeliverableReviewInputs,
    contract: ExecutionTaskContract,
    contractRef: TaskContractRef,
    tier: string,
    authorIdentity: string,
  ): Promise<{ key: string; inputs: ReviewKeyInputs } | undefined> {
    try {
      const projection = this.projection(runId);
      const trees = await this.resolveReviewTrees(inputs);
      const diffDigest = createHash("sha256").update(inputs.diffText, "utf8").digest("hex");
      const evidenceIds = [...new Set(inputs.claims.flatMap((claim) => claim.evidenceIds))];
      const digests = resolveEvidenceContent(this.options.evidenceStore, this.options.artifacts, runId, evidenceIds);
      const keyInputs: ReviewKeyInputs = {
        semanticContractDigest: semanticContractDigest(contract),
        baseTree: trees.baseTree,
        headTree: trees.headTree,
        diffDigest,
        diffArtifactHash: inputs.diffArtifactHash,
        evidenceContentDigest: combineEvidenceContentDigests(digests),
        claimBindingDigest: claimBindingDigest({
          objective: inputs.objective,
          criteria: inputs.criteria,
          claims: inputs.claims.map((claim) => ({
            id: claim.id,
            text: claim.text,
            evidenceContent: claim.evidenceIds.map((id) => {
              const digest = digests[id];
              if (!digest) throw new Error(`Unresolved current-run evidence ${id}.`);
              return digest;
            }),
          })),
          workerSummary: inputs.workerSummary,
          unresolvedConcerns: inputs.unresolvedConcerns,
          ...(task.kind !== undefined && task.kind !== "implementation" ? { repairTaskKind: task.kind } : {}),
        }),
        // W1 (F6): the candidate side binds the ACTUAL head content
        // tree, never the commit label: an identical resubmission under
        // a new commit keeps its identity instead of over-keying.
        testIntegrityDigest: testIntegrityDigest(currentTestIntegrityInputs(projection, contractRef, trees.headTree)),
        tier,
        reviewerPolicyVersion: REVIEWER_POLICY_VERSION,
        authorModelIdentity: authorIdentity,
        policyVersions: activeReviewPolicyVersions(projection),
      };
      return { key: computeReviewKey(keyInputs), inputs: keyInputs };
    } catch {
      return undefined;
    }
  }

  /**
   * W1 (F6): ACTUAL base and head Git trees through the audited
   * resolver only. An unknown or unresolved actual base tree is a
   * conservative reuse miss (throw): a substitute `commit:` label is
   * never manufactured. Digest syntax is validated and the submitted
   * diff bytes (bound separately via the diff digest) stay verified
   * from the immutable artifact.
   */
  /**
   * W2 (AR-R28): assembles the ordered delta-first input for a fix
   * re-review — criteria stay first in context; then the actual fix
   * delta (prior reviewed head -> current head from ACTUAL Git trees
   * through the audited resolver, never a diff filename guess or a
   * manufactured label); then the runner-computed delta files no prior
   * finding location names (paths only); then the invalidated evidence
   * facts from changed tree identity. Missing or unavailable prior
   * trees, artifacts or evidence yield the EXPLICIT conservative
   * fallback with the available full cumulative input — never a silent
   * empty correction. Initial reviews get no delta and keep their
   * normal full-diff behavior.
   */
  private async assembleFixDelta(
    task: BuildTask,
    inputs: DeliverableReviewInputs,
    prior: DeliveryReviewRecord | undefined,
    headTree: string | undefined,
    tier: DeliveryReviewTier,
  ): Promise<FixDeltaInputs | undefined> {
    if (!prior) return undefined;
    // F6: invalidation from every authentic prior tree-bound evidence
    // source — worker claims, verdict citations, runner depth/probe
    // evidence, finding evidence refs, and read-capture evidence refs.
    // Ids only: never finding text or claims (no leak into the blind
    // pass). Tree/content identity decides; model prose never revalidates.
    const priorEvidenceIds = [
      ...(prior.claims ?? []).flatMap((claim) => claim.evidenceIds),
      ...(prior.claimVerdicts ?? []).flatMap((verdict) =>
        (verdict.citations ?? []).flatMap((citation) =>
          "evidenceId" in citation && typeof citation.evidenceId === "string" ? [citation.evidenceId] : [],
        ),
      ),
      ...(prior.depth?.affectedTests?.evidenceIds ?? []),
      ...(prior.depth?.probe?.evidenceIds ?? []),
      ...(prior.findings ?? []).flatMap((finding) => finding.evidenceRefs),
      ...(prior.readCapture?.reads ?? []).flatMap((read) =>
        typeof read.evidenceId === "string" && read.evidenceId.length > 0 ? [read.evidenceId] : [],
      ),
    ];
    const priorHeadTree = prior.reviewKeyInputs?.headTree;
    const priorBaseTree = prior.reviewKeyInputs?.baseTree;
    // F5: authentic prior read RANGES from the kernel-captured tool
    // ledger. Only successful fs.read facts with actual returned ranges;
    // a range authorizes exactly its lines, never its whole file. Paths
    // ride raw: captured strings keep byte-exact identity (no trim).
    const priorReadRanges = (prior.readCapture?.reads ?? [])
      .filter((read) => read.toolName === "fs.read" && typeof read.path === "string" && read.path.length > 0 &&
        Number.isSafeInteger(read.startLine) && Number.isSafeInteger(read.endLine) &&
        (read.startLine as number) >= 1 && (read.endLine as number) >= (read.startLine as number))
      .map((read) => ({
        path: read.path as string,
        startLine: read.startLine as number,
        endLine: read.endLine as number,
      }));
    // F5: verified prior line coverage = new-side lines SHOWN in the
    // prior cumulative diff's verified bytes. Unavailable, unparsed or
    // oversized bytes mean absent: line authority then rests on read
    // ranges only.
    const priorShownLines = await this.readPriorShownLines(prior);
    const resolved = await this.resolveFixDeltaDiff(priorBaseTree, priorHeadTree, headTree);
    if (!resolved) {
      return {
        priorReviewId: prior.reviewId,
        ...(isHexTree(priorHeadTree) ? { priorHeadTree: priorHeadTree as string } : {}),
        ...(isHexTree(headTree) ? { headTree: headTree as string } : {}),
        deltaFiles: [...inputs.changedPaths],
        priorReviewedFiles: [],
        ...(priorShownLines ? { priorShownLines } : {}),
        priorReadRanges,
        filesWithoutPriorFindings: [...inputs.changedPaths],
        invalidatedEvidenceIds: invalidatedEvidenceIds(priorEvidenceIds, priorHeadTree, headTree),
        deltaText: "",
        cumulativeArtifactHash: inputs.diffArtifactHash,
        cumulativeIncludedUpFront: true,
        overCorrection: false,
        fallback: "full_cumulative" as const,
      };
    }
    const split = deltaFilesWithoutPriorFindings(resolved.deltaFiles, prior.findings ?? []);
    let deltaArtifactHash: string | undefined;
    try {
      const record = await this.options.artifacts.put(
        Buffer.from(resolved.deltaText, "utf8"),
        "text/x-diff",
        `fix-delta ${prior.reviewId} -> current`,
      );
      deltaArtifactHash = record.hash;
    } catch {
      deltaArtifactHash = undefined;
    }
    const overCorrection = split.unnamed.length > 0;
    // Hunk mapping is skipped on oversized deltas: the file stays
    // blocking instead of guessing line facts.
    const hunkMap = diffHunkMap(resolved.deltaText);
    return {
      priorReviewId: prior.reviewId,
      priorHeadTree: resolved.priorHeadTree,
      headTree: resolved.headTree,
      deltaFiles: resolved.deltaFiles,
      priorReviewedFiles: [...resolved.priorReviewed],
      ...(priorShownLines ? { priorShownLines } : {}),
      priorReadRanges,
      ...(hunkMap ? { deltaHunks: hunkMap } : {}),
      filesWithoutPriorFindings: split.unnamed,
      invalidatedEvidenceIds: invalidatedEvidenceIds(priorEvidenceIds, priorHeadTree, headTree),
      deltaText: resolved.deltaText,
      ...(deltaArtifactHash ? { deltaArtifactHash } : {}),
      cumulativeArtifactHash: inputs.diffArtifactHash,
      cumulativeIncludedUpFront: tier === "high" || overCorrection,
      overCorrection,
    };
  }

  /**
   * W2: the audited fix-delta diff between two actual Git trees. Only
   * hex-validated trees reach the factory primitive; anything else is
   * an explicit miss (fallback), never a manufactured label.
   */
  /**
   * F5: new-side lines SHOWN in the prior cumulative diff's verified
   * bytes (context plus added hunks): the prior review's actual line
   * coverage. Bytes are hash-verified like the submitted diff; missing,
   * tampered, unparsed or oversized bytes mean absent (line authority
   * then rests on read ranges only), never an empty fabrication.
   */
  private async readPriorShownLines(prior: DeliveryReviewRecord): Promise<Record<string, number[]> | undefined> {
    try {
      const hash = prior.diffArtifactHash;
      if (!/^[a-f0-9]{64}$/.test(hash)) return undefined;
      const bytes = await this.options.artifacts.get(hash);
      if (createHash("sha256").update(bytes).digest("hex") !== hash) return undefined;
      if (bytes.byteLength > 512 * 1024) return undefined;
      const shown = parseShownLines(bytes.toString("utf8"));
      return Object.fromEntries([...shown.entries()].map(([path, numbers]) => [path, [...numbers]]));
    } catch {
      return undefined;
    }
  }

  private async resolveFixDeltaDiff(
    priorBaseTree: string | undefined,
    priorHeadTree: string | undefined,
    headTree: string | undefined,
  ): Promise<{ priorHeadTree: string; headTree: string; deltaFiles: string[]; deltaText: string; priorReviewed: string[] } | undefined> {
    if (!isHexTree(priorHeadTree) || !isHexTree(headTree) || !this.options.resolveFixDelta) return undefined;
    try {
      const resolved = await this.options.resolveFixDelta({
        ...(isHexTree(priorBaseTree) ? { priorBaseTree: priorBaseTree as string } : {}),
        priorHeadTree: priorHeadTree as string,
        headTree: headTree as string,
      });
      if (!resolved || !Array.isArray(resolved.deltaFiles) || typeof resolved.deltaText !== "string") return undefined;
      if (resolved.deltaFiles.some((file) => typeof file !== "string" || !file.length)) return undefined;
      if (!Array.isArray(resolved.priorReviewed) || resolved.priorReviewed.some((file) => typeof file !== "string" || !file.length)) return undefined;
      return { priorHeadTree: priorHeadTree as string, headTree: headTree as string, deltaFiles: [...resolved.deltaFiles], deltaText: resolved.deltaText, priorReviewed: [...resolved.priorReviewed] };
    } catch {
      return undefined;
    }
  }

  private async resolveReviewTrees(inputs: DeliverableReviewInputs): Promise<{ baseTree: string; headTree: string }> {
    if (!inputs.baselineRevision || !inputs.taskRevision) throw new Error("ReviewKey requires submitted revisions.");
    if (!this.options.resolveTrees) throw new Error("ReviewKey requires the audited actual Git tree resolver; unknown trees never hit.");
    const resolved = await this.options.resolveTrees({ baselineRevision: inputs.baselineRevision, taskRevision: inputs.taskRevision });
    if (!resolved) throw new Error("ReviewKey requires resolved actual Git trees; unknown trees never hit.");
    const tree = (value: unknown, side: string): string => {
      if (typeof value === "string" && /^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(value)) return value;
      throw new Error(`ReviewKey requires a valid actual ${side} Git tree; unknown trees never hit.`);
    };
    return { baseTree: tree(resolved.baseTree, "base"), headTree: tree(resolved.headTree, "head") };
  }

  /**
   * W1 (F6): verifies the exact submitted immutable diff bytes at
   * their addressed artifact, and that the supplied text equals those
   * exact bytes. A custom loader could supply text that never came
   * from the addressed bytes, so both checks run here at the review
   * boundary (the product loader already verifies on read). Missing
   * or tampered bytes throw and the review fails closed as
   * unavailable — never a freshly reviewed or cached authority.
   */
  private async verifySubmittedDiff(inputs: DeliverableReviewInputs): Promise<void> {
    let bytes: Buffer;
    try {
      const record = await this.options.artifacts.verify(inputs.diffArtifactHash);
      bytes = await this.options.artifacts.get(inputs.diffArtifactHash);
      if (createHash("sha256").update(bytes).digest("hex") !== inputs.diffArtifactHash ||
          bytes.byteLength !== record.byteLength) {
        throw new Error("Captured submitted diff artifact hash mismatch.");
      }
    } catch {
      throw new DeliverableReviewInputsUnavailableError(
        `Submitted diff artifact ${inputs.diffArtifactHash} is missing or its bytes no longer hash to that address.`,
      );
    }
    if (bytes.toString("utf8") !== inputs.diffText) {
      throw new DeliverableReviewInputsUnavailableError(
        "Supplied diff text differs from the verified immutable diff artifact bytes.",
      );
    }
  }

  /**
   * W1 (F2): key/audit/fingerprint fields stored at request time for
   * future reuse and oscillation checks. The current diff
   * fingerprints and the FAILED lineage are ALWAYS derived —
   * independently of ReviewKey eligibility — so a cache-key miss can
   * never disable the mandatory blocking oscillation detection.
   */
  private async reviewKeyRequestFields(
    runId: string,
    task: BuildTask,
    inputs: DeliverableReviewInputs,
    reuseKey: { key: string; inputs: ReviewKeyInputs } | undefined,
  ): Promise<Record<string, unknown>> {
    return {
      ...(reuseKey ? { reviewKey: reuseKey.key, reviewKeyInputs: reuseKey.inputs } : {}),
      diffFingerprint: repairDiffFingerprint(inputs.diffText),
      diffReverseFingerprint: repairDiffReverseFingerprint(inputs.diffText),
      failedRepairFingerprints: await this.failedRepairFingerprints(runId, task.id),
    };
  }

  /**
   * W1 (S3 L7, F6): fingerprints of every FAILED completed review's
   * real diff, with durable attempt lineage. The lineage is ALWAYS
   * re-derived from the VERIFIED immutable artifact bytes — stored
   * fingerprints are worker labels, never content proof. A missing
   * or tampered failed artifact contributes nothing: an oscillation
   * that cannot be proven from verified bytes is a miss, never a guess.
   */
  private async failedRepairFingerprints(runId: string, taskId: string): Promise<FailedRepairDiff[]> {
    const history = this.projection(runId).delivery?.reviewHistory[taskId] ?? [];
    const entries: FailedRepairDiff[] = [];
    for (const review of history) {
      if (review.stage !== "completed" || review.satisfied !== false) continue;
      try {
        const record = await this.options.artifacts.verify(review.diffArtifactHash);
        const bytes = await this.options.artifacts.get(review.diffArtifactHash);
        if (createHash("sha256").update(bytes).digest("hex") !== review.diffArtifactHash ||
            bytes.byteLength !== record.byteLength) continue;
        const text = bytes.toString("utf8");
        entries.push({ attempt: review.submissionAttempt, forward: repairDiffFingerprint(text), reverse: repairDiffReverseFingerprint(text) });
      } catch {
        // Missing/tampered immutable artifact: this lineage cannot be proven.
      }
    }
    return entries;
  }

  private budgetedModel(model: AgentModel, candidate: AgentRuntimeCandidate, runId: string, sessionId: string): AgentModel {
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
}

interface PassContext {
  reviewIntegrityPolicyVersion?: 1;
  request: NativeDeliverableReviewRequest;
  reviewId: string;
  inputs: DeliverableReviewInputs;
  candidate: AgentRuntimeCandidate;
  model: AgentModel;
  independence: ReviewerIndependence;
  tier: DeliveryReviewTier;
  defectClasses?: readonly string[];
  depthRecords?: { affectedTests: DeliveryAffectedTestsRecord; probe: DeliveryProbeRecord };
  /**
   * W1 (F3): resolved retry-session ordinals per pass. The missing
   * stage runs in its deterministic session when empty, else in a new
   * genuinely fresh retry session; completed stages always reuse 0
   * (their original sessions, never re-executed).
   */
  retryOrdinals?: Partial<Record<Pass, number>>;
}

function passEnded(result: AgentLoopResult, pass: Pass, reviewId: string): boolean {
  if (pass === "verdict") return result.status === "verifier_verdict_submitted" && result.reviewId === reviewId;
  return result.status === "verifier_expectations_recorded" && result.reviewId === reviewId;
}

function expectedStageForPass(pass: Pass): DeliveryReviewRecord["stage"] {
  return pass === "obligations" ? "obligations_recorded" : pass === "findings" ? "findings_recorded" : "completed";
}

/**
 * W1 (F3): the first missing durable stage of an unfinished review —
 * the only stage a same-runtime resume may still run. Completed
 * stages are never re-executed. `started` (requested event missing)
 * has no resumable stage: the run must open a new generation.
 */
export function firstMissingResumePass(review: DeliveryReviewRecord): Pass | undefined {
  switch (review.stage) {
    case "requested":
      return deliveryReviewDepthForTier(review.risk?.tier ?? "low").obligationsFirst ? "obligations" : "findings";
    case "obligations_recorded":
    case "diff_delivered":
      return "findings";
    case "findings_recorded":
    case "report_delivered":
      return "verdict";
    default:
      return undefined;
  }
}

/** W1: the latest completed review whose stored ReviewKey exactly matches. Pre-W1 records carry no key. */
function findCompletedReviewByKey(state: DeliveryState | undefined, taskId: string, key: string): DeliveryReviewRecord | undefined {
  const current = state?.reviews[taskId];
  if (current?.stage === "completed" && current.reviewKey === key) return current;
  return [...(state?.reviewHistory[taskId] ?? [])].reverse().find((review) => review.stage === "completed" && review.reviewKey === key);
}

/**
 * W1 (F5/F7): durable baseline/candidate identity for the ReviewKey,
 * derived from durable state without any workspace. The accepted plan
 * pin, the durable baseline pin (or a stable absent sentinel) and
 * the candidate content tree bind the test-integrity reference: relevant
 * baseline/candidate drift invalidates reuse even on the cheap path,
 * while the full validated reference still rides the real review's
 * inputs for reviewer authority.
 */
function currentTestIntegrityInputs(
  projection: SchedulerProjection,
  contractRef: TaskContractRef,
  candidateRevision: string,
): TestIntegrityInputs {
  const baseline = projection.testIntegrity?.baseline;
  return {
    planRevisionId: contractRef.revisionId,
    planDigest: contractRef.digest,
    ...(baseline
      ? {
          baselinePinDigest: baseline.pinDigest,
          baselineKind: baseline.kind,
          baselineRevision: baseline.pin.revision,
          ...(baseline.kind === "executed_report" ? { baselineExecuted: baseline.executed } : {}),
        }
      : {}),
    candidateRevision,
  };
}

/** W1: active reviewer-affecting policy flags bound into every ReviewKey. */
function activeReviewPolicyVersions(projection: SchedulerProjection): string {
  return [
    `evidence:${projection.reviewEvidencePolicyVersion ?? 0}`,
    `integrity:${projection.reviewIntegrityPolicyVersion ?? 0}`,
    `scope:${projection.submissionScopePolicyVersion ?? 0}`,
    `encoding:${projection.encodingSafetyPolicyVersion ?? 0}`,
  ].join("|");
}

function nextGeneration(projection: SchedulerProjection, taskId: string): number {
  const current = projection.delivery?.reviews[taskId];
  const history = projection.delivery?.reviewHistory[taskId] ?? [];
  return Math.max(0, current?.generation ?? 0, ...history.map((review) => review.generation)) + 1;
}

function assertInputs(inputs: DeliverableReviewInputs, task: BuildTask): void {
  if (task.submissionScope && (inputs.taskRevision !== task.submissionScope.taskRevision || inputs.baselineRevision !== task.submissionScope.baselineRevision)) throw new DeliverableReviewInputsUnavailableError("Review revision differs from the exact guarded submission.");
  if (inputs.taskId !== task.id || inputs.attempt !== task.attempt || inputs.changeSetId !== task.changeSetId) {
    throw new DeliverableReviewInputsUnavailableError("Deliverable review inputs do not describe the current submission.");
  }
  if (!/^[a-f0-9]{64}$/.test(inputs.diffArtifactHash) || !inputs.diffText.trim()) {
    throw new DeliverableReviewInputsUnavailableError("The submitted diff is unavailable.");
  }
  if (inputs.changedPaths.length === 0) {
    throw new DeliverableReviewInputsUnavailableError("The submitted change lists no changed files.");
  }
  if (!inputs.workerSummary.trim()) {
    throw new DeliverableReviewInputsUnavailableError("The worker's submit_task summary is unavailable.");
  }
  const criteria = (task.acceptanceCriteria ?? []).map((criterion) => criterion.id).sort();
  if (criteria.length === 0 || JSON.stringify(inputs.criteria.map((criterion) => criterion.id).sort()) !== JSON.stringify(criteria)) {
    throw new DeliverableReviewInputsUnavailableError("Deliverable review inputs must carry the task's exact acceptance criteria.");
  }
}

/**
 * Bind the current durable authority regardless of optional loader copies.
 * Supplied copies are assertions, never alternate authority. Direct tasks'
 * scheduler and input objective/criteria must match the accepted semantics;
 * repair tasks keep their own durable semantics and the resolved parent ref.
 */
function bindContractAuthority(
  inputs: DeliverableReviewInputs,
  task: BuildTask,
  authority: { readonly ref: TaskContractRef; readonly contract: ExecutionTaskContract },
): DeliverableReviewInputs {
  if (inputs.contractRef !== undefined && !isDeepStrictEqual(inputs.contractRef, authority.ref)) {
    throw new DeliverableReviewInputsUnavailableError("Deliverable review inputs carry a contract reference that is not the current accepted reference.");
  }
  if (inputs.contract !== undefined && !isDeepStrictEqual(inputs.contract, authority.contract)) {
    throw new DeliverableReviewInputsUnavailableError("Deliverable review inputs carry a contract that is not the current accepted contract.");
  }
  const direct = authority.ref.taskId === task.id;
  const expectedCriteria = direct
    ? authority.contract.acceptance.criteria
    : (task.acceptanceCriteria ?? []);
  const want = expectedCriteria.map((criterion) => `${criterion.id}\n${criterion.text}`).sort();
  const got = inputs.criteria.map((criterion) => `${criterion.id}\n${criterion.text}`).sort();
  if (want.length === 0 || JSON.stringify(got) !== JSON.stringify(want)) {
    throw new DeliverableReviewInputsUnavailableError("Deliverable review inputs must carry the current authoritative acceptance criteria (criterion ids and text).");
  }
  const schedulerCriteria = (task.acceptanceCriteria ?? []).map((criterion) => `${criterion.id}\n${criterion.text}`).sort();
  if (direct && JSON.stringify(schedulerCriteria) !== JSON.stringify(want)) {
    throw new DeliverableReviewInputsUnavailableError("Scheduler criteria no longer match the current authoritative contract.");
  }
  if (direct && (inputs.objective !== authority.contract.outcome.user || task.objective !== authority.contract.outcome.user)) {
    throw new DeliverableReviewInputsUnavailableError("Deliverable review inputs must carry the current authoritative task objective.");
  }
  // Claims parse from the authoritative criteria above: a claim citing
  // any other criterion (or forged evidence linkage) is refused — the
  // worker's summary claim stays a claim, never evidence.
  const expectedClaimIds = new Set(expectedCriteria.map((criterion) => `claim:${criterion.id}`));
  for (const claim of inputs.claims) {
    if (claim.id === "claim:summary") continue;
    if (!expectedClaimIds.has(claim.id)) {
      throw new DeliverableReviewInputsUnavailableError("Deliverable review claims must cite the current authoritative acceptance criteria.");
    }
  }
  return { ...inputs, contract: authority.contract, contractRef: authority.ref };
}

/**
 * W2: durable delta binding for the review_requested event. Context-only
 * bytes (the delta text, the cumulative reference) are excluded: hashes
 * bind bytes, and the cumulative hash already rides the review record.
 */
function toDurableReviewDelta(delta: FixDeltaInputs): Record<string, unknown> {
  return {
    priorReviewId: delta.priorReviewId,
    ...(delta.priorHeadTree ? { priorHeadTree: delta.priorHeadTree } : {}),
    ...(delta.headTree ? { headTree: delta.headTree } : {}),
    deltaFiles: [...delta.deltaFiles],
    priorReviewedFiles: [...delta.priorReviewedFiles],
    ...(delta.priorShownLines ? { priorShownLines: delta.priorShownLines } : {}),
    priorReadRanges: delta.priorReadRanges.map((range) => ({ ...range })),
    ...(delta.deltaHunks ? { deltaHunks: delta.deltaHunks } : {}),
    filesWithoutPriorFindings: [...delta.filesWithoutPriorFindings],
    invalidatedEvidenceIds: [...delta.invalidatedEvidenceIds],
    cumulativeIncludedUpFront: delta.cumulativeIncludedUpFront,
    overCorrection: delta.overCorrection,
    ...(delta.fallback ? { fallback: delta.fallback } : {}),
    ...(delta.deltaArtifactHash ? { deltaArtifactHash: delta.deltaArtifactHash } : {}),
  };
}

/**
 * W2: verified fix-delta hunks per file as a durable record, or
 * undefined when the delta is oversized (512 KiB, the review context
 * cap): unknown hunk facts stay blocking instead of guessed.
 */
function diffHunkMap(deltaText: string): Record<string, import("./review-delta.js").DeltaHunk[]> | undefined {
  if (Buffer.byteLength(deltaText, "utf8") > 512 * 1024) return undefined;
  const hunks = parseDiffHunks(deltaText);
  return Object.fromEntries([...hunks.entries()].map(([path, list]) => [path, [...list]]));
}

/** W2: an actual Git tree id (40-hex SHA-1 or 64-hex SHA-256), never a label. */
function isHexTree(value: unknown): value is string {
  return typeof value === "string" && (/^[a-f0-9]{40}$/.test(value) || /^[a-f0-9]{64}$/.test(value));
}

function section(id: string, kind: string, content: string): ContextSection {
  return { id, kind, required: true, priority: 1000, content };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * C5 (AR-R16/EP40): the concrete deliverable-review context caps.
 * Applied by the assembler on every pass and recorded on every pass
 * manifest beside the pack digest, token count and limits of the actual
 * request.
 */
export const DELIVERABLE_REVIEW_CONTEXT_LIMITS: ContextLimits = {
  maxBytes: 512 * 1024,
  maxEstimatedTokens: 128 * 1024,
};

export const DELIVERABLE_REVIEWER_INVARIANTS = [
  "You are an independent reviewer of a submitted change. You did not write it.",
  "The plan-contract acceptance criteria are the source of truth; the worker's report is a claim, not evidence.",
  "Never invent findings: every finding cites the file, line, command, or evidence that shows it.",
  "Your records are durable evidence; another reviewer may audit them without seeing your session.",
].join("\n");

export function deliveryReviewerSystemPrompt(pass: Pass, tier: DeliveryReviewTier, reviewIntegrityPolicyVersion?: 1, isReReview?: boolean): string {
  const instructions = pass === "obligations"
    ? [
        "You see the acceptance criteria only. You have NOT seen the diff yet.",
        "Derive the concrete obligations a correct change must meet, then call record_deliverable_obligations exactly once.",
      ]
    : pass === "findings"
      ? [
          "Inspect the task-revision checkout with your read tools and judge the diff against every criterion.",
          tier === "low" && reviewIntegrityPolicyVersion !== 1
            ? "Record your findings with record_deliverable_findings exactly once."
            : "At this risk tier you must use at least one inspection tool before record_deliverable_findings; the kernel refuses findings without a real inspection.",
          "Severity blocking means a criterion is not met or the change is unsafe; advisory means a gap worth noting. An empty list means the change checks out.",
          ...(isReReview ? ["On this fix re-review, independently inspect and judge the repair delta first, including whether the correction introduces any regression or over-correction. Prior findings are withheld until the later verdict pass; record your own findings without inferring or reconstructing them."] : []),
          "You have NOT seen the worker's report. Form your own view first.",
        ]
      : [
          "Judge each worker claim as verified (you confirmed it yourself) or unverified, with a rationale.",
          ...(isReReview
            ? [
                "On this fix re-review, your own findings are now durable and the prior findings are released — check BOTH directions: each prior finding resolved or outstanding with a rationale, AND no change beyond what the findings require and no previously satisfied criterion regressed.",
                "After the first review, a new blocking finding on unchanged already-reviewed code counts only when critical (security, data loss, false acceptance) with an explicit rationale or backed by an actual failing test from this review's runner checks — mark the basis on the finding; other late observations are retained as nonblocking follow-up.",
              ]
            : []),
          "Set satisfied true only when no blocking finding and no unverified claim remains. Call submit_deliverable_verdict exactly once.",
        ];
  return `${DELIVERABLE_REVIEWER_INVARIANTS}\n${instructions.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Lifecycle tools. Each pass registers exactly one. Each writes one kernel
// event as the bound reviewer; the kernel owns every refusal.
// ---------------------------------------------------------------------------

export interface DeliveryLifecycleToolOptions {
  store: SchedulerStore;
  runId: string;
  taskId: string;
  reviewId: string;
  runtimeId: string;
  sessionId: string;
  /**
   * W1 (F3): retry ordinal of the bound session (0 for the
   * deterministic first try). The read-capture authority gate binds
   * this exact session, never an assumed base id.
   */
  retryOrdinal?: number;
  clock: () => string;
  defects?: ReviewDefectRecorder;
  ledger?: ToolInvocationLedger;
  evidenceStore?: EvidenceStore;
  sessions?: SqliteAgentSessionStore;
}

function assertDeliveryReviewerContext(context: ToolExecutionContext, options: DeliveryLifecycleToolOptions): void {
  if (context.runId !== options.runId || context.sessionId !== options.sessionId) {
    throw new Error("Deliverable reviewer tool context does not match its review session.");
  }
  if (context.actor.role !== "verifier" || context.actor.id !== options.runtimeId) {
    throw new Error("Only the bound deliverable reviewer runtime may use this tool.");
  }
}

function appendAsReviewer(
  options: DeliveryLifecycleToolOptions,
  context: ToolExecutionContext,
  type: string,
  pass: Pass,
  payload: Record<string, unknown>,
  lifecycle: NonNullable<ToolExecutionOutput["lifecycle"]>,
): ToolExecutionOutput {
  try {
    assertDeliveryReviewerContext(context, options);
    if (type === "delivery.review_recorded") {
      const review = rebuildSchedulerProjection(options.store.readRun(options.runId)).delivery?.reviews[options.taskId];
      if (review?.reviewEvidencePolicyVersion === 1) {
        if (!options.ledger) throw new Error("Verified claim read capture requires the native tool ledger.");
        if (review.reviewId !== options.reviewId || review.reviewerRuntimeId !== options.runtimeId || review.stage !== "report_delivered" || options.sessionId !== deliverySessionId(options.runId, options.reviewId, "verdict", options.runtimeId, review.independence!, options.retryOrdinal ?? 0)) throw new Error("Read capture requires the current bound review.");
        const sessionEvents = options.sessions?.events(options.sessionId) ?? [];
        const created = sessionEvents[0];
        const actor = created?.payload.actor as { role?: string; id?: string } | undefined;
        if (created?.type !== "session.created" || created.payload.runId !== options.runId || actor?.role !== "verifier" || actor.id !== options.runtimeId || sessionEvents.some((event) => event.type === "session.completed" || event.type === "session.submitted" || event.type === "session.suspended") || review.sessionIds.includes(options.sessionId)) throw new Error("Read capture requires the active fresh native verdict session.");
        const capture = captureReviewReads(options.ledger, { runId: options.runId, taskId: options.taskId, reviewId: options.reviewId, changeSetId: review.changeSetId, submissionAttempt: review.submissionAttempt, reviewerRuntimeId: options.runtimeId, reviewerModelIdentity: review.reviewerModelIdentity!, sessionId: options.sessionId }, options.evidenceStore);
        options.store.append({ runId: options.runId, type: "delivery.reads_captured", occurredAt: options.clock(), actor: { role: "runner", id: DELIVERY_REVIEW_RUNNER_ID }, idempotencyKey: `delivery-reads:${options.reviewId}:${options.sessionId}:${createHash("sha256").update(JSON.stringify(capture)).digest("hex")}`, payload: { taskId: options.taskId, reviewId: options.reviewId, sessionId: options.sessionId, capture } });
      }
    }
    options.store.append({
      runId: options.runId,
      type: type as Parameters<SchedulerStore["append"]>[0]["type"],
      occurredAt: options.clock(),
      actor: { role: "verifier", id: options.runtimeId },
      idempotencyKey: `delivery-review:${options.reviewId}:${pass}`,
      payload: { taskId: options.taskId, reviewId: options.reviewId, sessionId: options.sessionId, ...payload },
    });
    return { content: [{ type: "json", value: { reviewId: options.reviewId, recorded: type } }], isError: false, lifecycle };
  } catch (error) {
    return {
      content: [{ type: "text", text: message(error) }],
      isError: true,
      error: { code: "mechanical_transition_rejected", message: message(error) },
    };
  }
}

function objectInput(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : null;
}

export function createRecordDeliverableObligationsTool(
  options: DeliveryLifecycleToolOptions,
): NativeTool<{ obligations: unknown[] }> {
  return {
    definition: {
      name: "record_deliverable_obligations",
      description: "Record the obligations a correct change must meet, derived from the criteria only, exactly once.",
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
        },
        required: ["obligations"],
        additionalProperties: false,
      },
      readOnly: false,
      effect: "none",
      lifecycle: true,
    },
    validate: (input) => {
      const value = objectInput(input);
      return value && Array.isArray(value.obligations) && value.obligations.length > 0
        ? { ok: true, value: { obligations: value.obligations } }
        : { ok: false, issues: ["obligations must be a non-empty array"] };
    },
    execute: async (input, context) => appendAsReviewer(
      options,
      context,
      "delivery.obligations_recorded",
      "obligations",
      { obligations: input.obligations },
      { type: "verifier_expectations_recorded", reviewId: options.reviewId },
    ),
  };
}

export function createRecordDeliverableFindingsTool(
  options: DeliveryLifecycleToolOptions & { depth: () => Record<string, unknown> },
): NativeTool<{ findings: unknown[] }> {
  return {
    definition: {
      name: "record_deliverable_findings",
      description:
        "Record your own findings on the submitted change exactly once, before the worker's report is shown. " +
        "On a fix re-review, a finding on unchanged already-reviewed code stays blocking only with a lateFinding basis (critical with an explicit rationale, or failing_test naming this review's actual failing test ids); other late observations are retained as nonblocking follow-up. " +
        "Each finding carries a short defect class (for example \"guard never exercised\"); the runner remembers the project's top classes. " +
        "The runner attaches your inspection count and any runner-executed checks.",
      inputSchema: {
        type: "object",
        properties: {
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1 },
                category: { type: "string", enum: [...PLANNING_FINDING_CATEGORIES] },
                severity: { type: "string", enum: ["blocking", "advisory"] },
                claim: { type: "string", minLength: 1 },
                location: { type: "string", minLength: 1 },
                requirementId: { type: "string", minLength: 1 },
                evidenceRefs: { type: "array", items: { type: "string", minLength: 1 } },
                defectClass: { type: "string", minLength: 1 },
                lateFinding: {
                  type: "object",
                  properties: {
                    basis: { type: "string", enum: ["critical", "failing_test"] },
                    criticalKind: { type: "string", enum: ["security", "data_loss", "false_acceptance"] },
                    testIds: { type: "array", items: { type: "string", minLength: 1 } },
                    rationale: { type: "string", minLength: 1 },
                  },
                  required: ["basis", "rationale"],
                  additionalProperties: false,
                },
              },
              required: ["id", "category", "severity", "claim", "evidenceRefs", "defectClass"],
              additionalProperties: false,
            },
          },
        },
        required: ["findings"],
        additionalProperties: false,
      },
      readOnly: false,
      effect: "none",
      lifecycle: true,
    },
    validate: (input) => {
      const value = objectInput(input);
      if (!value || !Array.isArray(value.findings)) {
        return { ok: false, issues: ["findings must be an array"] };
      }
      for (const finding of value.findings) {
        const candidate = (typeof finding === "object" && finding !== null ? finding : {}) as Record<string, unknown>;
        if (typeof candidate.id !== "string" || !candidate.id.trim()) {
          return { ok: false, issues: ["every finding requires an id"] };
        }
        try {
          normalizeDefectClassLabel(candidate.defectClass, candidate.id);
        } catch {
          return { ok: false, issues: [`finding ${candidate.id} requires a short defect class`] };
        }
      }
      return { ok: true, value: { findings: value.findings } };
    },
    execute: async (input, context) => {
      // T6b repair (N2): defect classes are recorded only after the
      // kernel accepts the findings below.
      const accepted = await appendAsReviewer(
        options,
        context,
        "delivery.findings_recorded",
        "findings",
        { findings: input.findings, depth: options.depth() },
        { type: "verifier_expectations_recorded", reviewId: options.reviewId },
      );
      if (!accepted.isError && options.defects) {
        for (const finding of input.findings) {
          const candidate = finding as Record<string, unknown>;
          options.defects.store.recordDefectFinding({
            projectId: options.defects.projectId,
            label: normalizeDefectClassLabel(candidate.defectClass, String(candidate.id)),
            taskId: options.taskId,
            reviewId: options.reviewId,
            findingId: String(candidate.id),
            recordedAt: options.clock(),
          });
        }
      }
      return accepted;
    },
  };
}

interface SubmitDeliverableVerdictInput {
  summary: string;
  satisfied: boolean;
  claimVerdicts: unknown[];
  priorFindingChecks?: unknown[];
  testConsolidation?: Record<string, unknown>;
  survivorDispositions?: unknown[];
}

export function createSubmitDeliverableVerdictTool(
  options: DeliveryLifecycleToolOptions,
): NativeTool<SubmitDeliverableVerdictInput> {
  return {
    definition: {
      name: "submit_deliverable_verdict",
      description:
        "Submit the deliverable verdict exactly once: a verdict per worker claim and, on a re-review, a check per prior finding.",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1 },
          satisfied: { type: "boolean" },
          testConsolidation: {
            type: "object", additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1 }, disposition: { type: "string", enum: ["obsolete", "merged"] },
              affectedTestIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
              behaviorProof: { type: "string", minLength: 1 }, reason: { type: "string", minLength: 1 },
              planRevisionId: { type: "string", minLength: 1 }, planDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
              baselinePinDigest: { type: "string", pattern: "^[a-f0-9]{64}$" }, candidatePinDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
              allowedChanges: { type: "array", minItems: 1, items: { type: "string", enum: ["test_command_changed", "test_config_changed", "suite_shrank"] } },
              minimumExecuted: { type: "integer", minimum: 1 },
            }, required: ["id", "disposition", "affectedTestIds", "behaviorProof", "reason", "planRevisionId", "planDigest", "baselinePinDigest", "candidatePinDigest", "allowedChanges", "minimumExecuted"],
          },
          survivorDispositions: { type: "array", items: { type: "object", properties: { findingId: { type: "string", minLength: 1 }, disposition: { type: "string", enum: ["not_a_real_gap"] }, rationale: { type: "string", minLength: 1 } }, required: ["findingId", "disposition", "rationale"], additionalProperties: false } },
          claimVerdicts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                citations: { type: "array", minItems: 1, items: { oneOf: [{ type: "object", properties: { path: { type: "string", minLength: 1 }, line: { type: "integer", minimum: 1 } }, required: ["path", "line"], additionalProperties: false }, { type: "object", properties: { evidenceId: { type: "string", minLength: 1 } }, required: ["evidenceId"], additionalProperties: false }] } },
                claimId: { type: "string", minLength: 1 },
                status: { type: "string", enum: ["verified", "unverified"] },
                rationale: { type: "string", minLength: 1 },
              },
              required: ["claimId", "status", "rationale"],
              additionalProperties: false,
            },
          },
          priorFindingChecks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                findingId: { type: "string", minLength: 1 },
                resolution: { type: "string", enum: ["resolved", "outstanding"] },
                rationale: { type: "string", minLength: 1 },
              },
              required: ["findingId", "resolution", "rationale"],
              additionalProperties: false,
            },
          },
        },
        required: ["summary", "satisfied", "claimVerdicts"],
        additionalProperties: false,
      },
      readOnly: false,
      effect: "none",
      lifecycle: true,
    },
    validate: (input) => {
      const value = objectInput(input);
      if (!value || typeof value.summary !== "string" || !value.summary.trim() || typeof value.satisfied !== "boolean" || !Array.isArray(value.claimVerdicts)) {
        return { ok: false, issues: ["summary, satisfied, and claimVerdicts are required"] };
      }
      if (value.priorFindingChecks !== undefined && !Array.isArray(value.priorFindingChecks)) {
        return { ok: false, issues: ["priorFindingChecks must be an array"] };
      }
      if (value.survivorDispositions !== undefined && !Array.isArray(value.survivorDispositions)) return { ok: false, issues: ["survivorDispositions must be an array"] };
      if (value.testConsolidation !== undefined && !objectInput(value.testConsolidation)) return { ok: false, issues: ["testConsolidation must be an object"] };
      return {
        ok: true,
        value: {
          summary: value.summary,
          satisfied: value.satisfied,
          claimVerdicts: value.claimVerdicts,
          ...(value.priorFindingChecks !== undefined ? { priorFindingChecks: value.priorFindingChecks as unknown[] } : {}),
          ...(value.survivorDispositions !== undefined ? { survivorDispositions: value.survivorDispositions as unknown[] } : {}),
          ...(value.testConsolidation !== undefined ? { testConsolidation: value.testConsolidation as Record<string, unknown> } : {}),
        },
      };
    },
    execute: async (input, context) => appendAsReviewer(
      options,
      context,
      "delivery.review_recorded",
      "verdict",
      {
        summary: input.summary,
        satisfied: input.satisfied,
        claimVerdicts: input.claimVerdicts,
        ...(input.priorFindingChecks !== undefined ? { priorFindingChecks: input.priorFindingChecks } : {}),
        ...(input.survivorDispositions !== undefined ? { survivorDispositions: input.survivorDispositions } : {}),
        ...(input.testConsolidation !== undefined ? { testConsolidation: input.testConsolidation } : {}),
      },
      { type: "verifier_verdict_submitted", reviewId: options.reviewId, satisfied: input.satisfied },
    ),
  };
}

/**
 * Counts the reviewer's successful non-lifecycle tool calls in a pass. The
 * count is attached to the findings event, and the kernel refuses a
 * medium/high review without at least one real inspection.
 */
class InspectionCountingRuntime implements AgentToolRuntime {
  constructor(private readonly inner: AgentToolRuntime, private readonly counter: { calls: number }) {}
  definitions() { return this.inner.definitions(); }
  isLifecycleTool(name: string): boolean { return this.inner.isLifecycleTool(name); }
  isReadOnlyTool(name: string): boolean { return this.inner.isReadOnlyTool(name); }
  assertUniqueCallIds(calls: readonly ToolCallBlock[], seen: ReadonlySet<string>): void {
    this.inner.assertUniqueCallIds(calls, seen);
  }
  async invoke(call: ToolCallBlock, context: ToolExecutionContext): Promise<ToolResult> {
    const result = await this.inner.invoke(call, context);
    if (!result.isError && !this.inner.isLifecycleTool(call.name)) this.counter.calls += 1;
    return result;
  }
}
