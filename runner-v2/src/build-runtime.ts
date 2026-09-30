import { createHash } from "node:crypto";

import type {
  AgentToolRuntime,
} from "./tool-registry.js";
import type { NativeTool, ToolExecutionContext } from "./agent-contracts.js";
import { createArchitectTools, type ArchitectToolsOptions } from "./architect-tools.js";
import { ANSWER_PATH_LIFECYCLE_TOOLS, ARCHITECT_LIFECYCLE_TOOLS } from "./role-capabilities.js";
import type { NativeBuildRunPolicy } from "./build-spec.js";
import type {
  BuildRiskAssessmentProjection,
  HandoffFilesOption,
  ProjectHandoffChoice,
  SchedulerActor,
  SchedulerEvent,
  SchedulerProjection,
  SchedulerStore,
} from "./scheduler-store.js";
import {
  describeSnapshotCommitFacts,
  handoffLinkRawTargetsClaudeDotMd,
  V2_AGENTS_SECTION_BODY,
  V2_CLAUDE_POINTER_LINE,
} from "./project-docs.js";
import {
  clearContextRecordingSuspension,
  ContextManifestRecordingError,
  suspendContextRecording,
} from "./context-manifest-store.js";
import {
  architectLifecycleEventMatchesReason,
  buildCompletionReadiness,
  contextRecordingRetriesRemaining,
  currentAnswerReviewVerdict,
  DEFAULT_REPAIR_PLAN_LIMIT,
  deriveFinalVerificationFailure,
  handoffFilesOf,
  handoffSnapshotRetryPending,
  isAnsweredRun,
  isPlanningState,
  specCopyOf,
  latestAnswerReviewVerdict,
  latestUnresolvedContextRecordingNote,
  newPolicyStaleTasksRequireArchitect,
  nextAnswerReviewId,
  readyPlanIdentity,
  classifyStopSnapshot,
  EXCEPTIONAL_RECOVERY_PAUSE_REASON,
  rebuildSchedulerProjection,
  effectiveRepairPlanLimit,
  repairCyclesExhausted,
  type StopSnapshotStopKind,
} from "./scheduler-store.js";
import type { PlanningSourceReader } from "./planning-tools.js";
import {
  DEFAULT_COVERAGE_SUSPENDED_RETRY_LIMIT,
  SchedulerCoverageReviewAuthority,
  TERMINAL_COVERAGE_GATE_REASONS,
  type CoverageReviewDriver,
  type NativeCoverageReviewRequest,
  type PlanningHostCapabilitiesProvider,
} from "./planning-review.js";
import {
  DELIVERY_ACCEPTANCE_RUNNER_ID,
  beforeFailingCheckRepairCharge,
  failingCheckRepairChargeDecision,
  type DeliveryReviewRecord,
  currentSubmissionReview,
  reviewOutcomeByAuthor,
  deliveryBoundaryAction,
  deliveryBoundaryId,
  evaluatePhaseAcceptance,
  openBlockingFindings,
  phaseAcceptanceKey,
  unverifiedClaims,
  type DeliveryBoundaryCheck,
} from "./delivery-acceptance.js";
import type { NativeDeliverableReviewResult } from "./native-deliverable-review.js";
import { DEFAULT_ISSUE_REPAIR_CYCLE_LIMIT, deliveryBoundaryRootCause, failingTestIdsByCategory, repairIssueIdentity, repairMemberIssues, withFailingIds } from "./repair-budget-contracts.js";
import {
  SchedulerAnswerReviewAuthority,
  type AnswerReviewAuthority,
  type AnswerReviewDriver,
} from "./request-triage.js";
import { computePlanReadiness, coverageReviewHoldsReadiness } from "./planning-contracts.js";
import { coveragePlanReadinessInput, openBlockingCoverageFindings } from "./planning-projection.js";
import type { BuildTask } from "./task-contracts.js";
import {
  PREVIOUS_SNAPSHOT_EDITED_NOTICE_LINE,
  handoffSnapshotInputFromProjection,
  renderHandoffSnapshot,
  verifyHandoffSnapshotDigest,
} from "./handoff-snapshot.js";
import type { HandoffSnapshotCommitRequest } from "./integration-manager.js";
import type { EvidenceStore } from "./evidence-store.js";
import type {
  DocumentTipRelation,
  ProjectDocCommitRequest,
  ProjectDocCommitResult,
} from "./project-docs.js";
import type {
  FinalVerificationCategory,
  FinalVerificationPlan,
} from "./final-verification-contracts.js";
import type {
  FinalVerificationCheckResult,
  FinalVerificationRun,
} from "./final-verification-runtime.js";
import { submitFinalVerification } from "./final-verification-submission.js";
import {
  TaskScheduler,
  type TaskSchedulerOptions,
  type WorkerRuntimeDriver,
} from "./task-scheduler.js";
import { ToolRegistry } from "./tool-registry.js";
import { redactSensitiveText } from "./sensitive-redaction.js";
import type { FinalVerificationExecutionProfile } from "./final-verification-profile.js";
import type { ArtifactStore } from "./artifact-store.js";
import { ArtifactNotFoundError } from "./artifact-store.js";
import type { ArchitectActionReason } from "./user-steering-contracts.js";
import {
  assessBuildRisk,
  type BuildRiskAssessmentInput,
} from "./risk-policy.js";
import {
  assessPlanRisk,
  planCritiqueRequired,
  type PlanCritiqueMode,
  type PlanCritiqueSkipReason,
  type PlanRiskLevel,
  type PlanRiskReason,
} from "./plan-critique-contracts.js";
export type { ArchitectActionReason } from "./user-steering-contracts.js";

export interface ArchitectActionRequest {
  runId: string;
  reason: ArchitectActionReason;
  projection: SchedulerProjection;
  tools: AgentToolRuntime;
  context: ToolExecutionContext;
  providerRetryDeadlineMs?: number;
}

export interface ArchitectRuntimeDriver {
  run(request: ArchitectActionRequest): Promise<void>;
}

export type IntegrationRuntimeResult =
  | { status: "integrated"; integrationRevision: string }
  | {
      status: "conflict";
      integrationRevision: string;
      conflictPaths: string[];
    };

export interface IntegrationRuntimeDriver {
  integrate(input: {
    runId: string;
    taskId: string;
    changeSetId: string;
  }): Promise<IntegrationRuntimeResult>;
}

export interface FinalVerificationCheckDriverInput {
  runId: string;
  taskId: string;
  generationId: string;
  targetRevision: string;
  attempt: number;
  plan: FinalVerificationPlan;
  category: FinalVerificationCategory;
  executionProfile: FinalVerificationExecutionProfile;
  signal?: AbortSignal;
}

export interface FinalVerificationCheckExecution {
  workspacePath: string;
  startedAt: string;
  finishedAt: string;
  check: FinalVerificationCheckResult;
}

export interface FinalVerificationCheckDriver {
  executeCheck(input: FinalVerificationCheckDriverInput): Promise<FinalVerificationCheckExecution>;
}

export interface FinalVerificationCleanupDriver {
  cleanup(input: {
    runId: string;
    generationId: string;
    taskId: string;
    targetRevision: string;
    attempt: number;
    failed?: {
      generationId: string;
      taskId: string;
      targetRevision: string;
      checks: readonly unknown[];
      evidenceReferences: readonly string[];
      logs?: readonly string[];
    };
  }): Promise<{ diagnosticsPath?: string }>;
}

/**
 * T6b (OA-14): re-runs only the failing tests of one check, once, on the
 * same revision and environment through the audited executor. The factory
 * wires the production implementation (filtered node --test rerun through
 * FinalVerificationRuntime); tests may substitute a double at this seam.
 */
export interface FlakyRerunInput {
  runId: string;
  category: string;
  failingTestIds: readonly string[];
  generationId: string;
  taskId: string;
  targetRevision: string;
  plan: FinalVerificationPlan;
  executionProfile: FinalVerificationExecutionProfile;
  attempt: number;
  signal?: AbortSignal;
}

export type FlakyRerunResult =
  | { status: "rerun"; green: boolean; evidenceIds: readonly string[]; note: string }
  | { status: "unsupported"; note: string };

export interface FlakyIsolationDriver {
  rerunFailingTests(input: FlakyRerunInput): Promise<FlakyRerunResult>;
}

/** T6b (OA-16): records the per-model outcome of every reviewed accepted task. */
export interface ReviewOutcomeRecorder {
  projectId: string;
  record(input: {
    readonly runId: string;
    readonly modelId: string;
    readonly taskId: string;
    readonly accepted: boolean;
    readonly defectFound: boolean;
    readonly recordedAt: string;
  }): void;
}

export interface IndependentVerifierRequest {
  runId: string;
  projection: SchedulerProjection;
  risk: BuildRiskAssessmentProjection;
  preferredRuntimeId?: string;
  signal?: AbortSignal;
}

export type IndependentVerifierResult =
  | { status: "verdict_submitted" }
  | {
      status: "unavailable";
      reason:
        | "no_independent_healthy_capability_match"
        | "runtime_unavailable";
    }
  | {
      status: "suspended";
      reason: string;
      runtimeId?: string;
      error?: string;
    };

export interface IndependentVerifierDriver {
  candidateRuntimeIds: readonly string[];
  /** Optional only for legacy/test drivers; production always supplies it. */
  alwaysRequireIndependentVerifier?: boolean;
  /** New runs default to two-pass; absent keeps a caller on single-pass. */
  twoPass?: boolean;
  assessRisk(input: {
    runId: string;
    projection: SchedulerProjection;
  }): Promise<BuildRiskAssessmentInput>;
  verify(input: IndependentVerifierRequest): Promise<IndependentVerifierResult>;
}

export type PlanCriticResult =
  | { status: "submitted"; critiqueId: string }
  | { status: "unavailable"; reason: "no_independent_healthy_capability_match" | "runtime_unavailable" }
  | { status: "suspended"; reason: string; runtimeId?: string; error?: string };

export interface PlanCriticDriver {
  candidateRuntimeIds: readonly string[];
  mode: PlanCritiqueMode;
  stricterQualification: boolean;
  architectDeclaration(projection: SchedulerProjection): PlanRiskLevel;
  critique(input: {
    runId: string;
    projection: SchedulerProjection;
    riskReasons: readonly PlanRiskReason[];
    preferredRuntimeId?: string;
    signal?: AbortSignal;
  }): Promise<PlanCriticResult>;
}

/** T6a: the mandatory deliverable reviewer (NativeDeliverableReviewRuntime in production). */
export interface DeliveryReviewDriver {
  review(input: {
    runId: string;
    taskId: string;
    signal?: AbortSignal;
    providerRetryDeadlineMs?: number;
  }): Promise<NativeDeliverableReviewResult>;
}

/**
 * T6a: runs the affected checks for an integrated task at the CURRENT
 * integration revision through the audited executor and returns the real
 * outcomes (never placeholders; a check that cannot run is `unknown`).
 */
export interface DeliveryBoundaryDriver {
  check(input: {
    runId: string;
    taskId: string;
    boundaryId: string;
    /** N-R4-3: the durably started attempt; scopes process and evidence keys. */
    attempt: number;
    integrationRevision: string;
    signal?: AbortSignal;
  }): Promise<{
    changedFiles: string[];
    selection: { rung: string; selectedTests: string[] };
    checks: DeliveryBoundaryCheck[];
  }>;
}
export interface BuildRuntimeOptions {
  runId: string;
  initialObjective?: string;
  runPolicy?: NativeBuildRunPolicy;
  /**
   * C2b run options (CD-5): verbatim spec copy (default true) and handoff
   * file handling (default "commit"). Recorded durably in
   * `run.policy_configured`; the recorded values govern the run.
   */
  specCopy?: boolean;
  handoffFiles?: HandoffFilesOption;
  store: SchedulerStore;
  workerDriver: WorkerRuntimeDriver;
  architectDriver: ArchitectRuntimeDriver;
  integrationDriver: IntegrationRuntimeDriver;
  deliveryReview?: DeliveryReviewDriver;
  deliveryBoundary?: DeliveryBoundaryDriver;
  maxConcurrency: number;
  /**
   * T4: actual resource/provider capacity when the host reports one,
   * forwarded to the scheduler. New-policy pump admission is bounded by
   * `min(MAX_WORKERS, maxConcurrency, resourceCapacity)`; legacy capacity
   * is unchanged. Absent means unknown (no further bound).
   */
  resourceCapacity?: TaskSchedulerOptions["resourceCapacity"];
  workspaceFor: TaskSchedulerOptions["workspaceFor"];
  maxTaskAttempts?: number;
  architectId?: string;
  clock?: () => string;
  renewBudgetWindow?: (idempotencyKey: string, occurredAt: string) => void;
  providerRetryDeadlineMs?: () => number | undefined;
  evidenceStore?: EvidenceStore;
  artifacts?: ArtifactStore;
  /** Commits Architect project documents on the integration branch. */
  projectDocs?: ProjectDocsPort;
  finalVerificationDriver?: FinalVerificationCheckDriver;
  finalVerificationCleanupDriver?: FinalVerificationCleanupDriver;
  finalVerificationProfileFor?: (targetRevision: string) => Promise<FinalVerificationExecutionProfile>;
  discardFinalVerificationProfile?: (profile: FinalVerificationExecutionProfile) => Promise<void>;
  independentVerifier?: IndependentVerifierDriver;
  planCritic?: PlanCriticDriver;
  repairPlanLimit?: number;
  /**
   * T6b: stable project identity for issue-level repair budgets. Falls back
   * to the run id when absent (issues stay per-run).
   */
  projectId?: string;
  /**
   * T6b: explicit project policy override for the issue-level repair budget.
   * Defaults to DEFAULT_ISSUE_REPAIR_CYCLE_LIMIT, independent from the
   * run-level DEFAULT_REPAIR_PLAN_LIMIT (G-5).
   */
  issueRepairLimit?: number;
  repairApproachAvailable?: boolean;
  flakyIsolation?: FlakyIsolationDriver;
  cleanupAfterAttempt?: (context: { readonly taskAttempt: "task_attempt" | "verification"; readonly sessionIds?: readonly string[] }) => Promise<import("./cleanup-ownership.js").CleanupSearchFinding>;
  reviewOutcomeRecorder?: ReviewOutcomeRecorder;
  /** Test probe applied to lifecycle tools immediately before the allow-list assert. */
  architectLifecycleProbe?: (
    tools: readonly NativeTool<unknown>[],
  ) => readonly NativeTool<unknown>[];
  /**
   * Supplies approved-source bytes for new-policy planning reads. When absent
   * the read tool falls back to the artifact store by artifact digest, and
   * errors explicitly when neither is provisioned.
   */
  planningSourceReader?: PlanningSourceReader;
  /**
   * T3b: drives the independent source-coverage review for new-policy runs.
   * When absent, a requested review records an explicit outstanding gate
   * instead of running. Legacy runs never consult it.
   */
  coverageReview?: CoverageReviewDriver;
  /**
   * T9 (OA-5): drives the opt-in independent answer review as a sibling of
   * the other reviewer drivers. Consulted only for triage-`answer` runs with
   * a recorded user opt-in and no verdict yet; every other run ignores it.
   * When set, candidateRuntimeIds must be unique and non-empty.
   */
  answerReview?: AnswerReviewDriver;
  /**
   * T3b: supplies host capabilities for the plan_ready transition. Required
   * before a bound non-blocking review can become ready.
   */
  planningHostCapabilities?: PlanningHostCapabilitiesProvider;
  /**
   * T3b repair cycle 1 (N6): bound on suspended-review retries per review.
   * Independent from repairPlanLimit (G-5). On exhaustion the runtime
   * records an explicit outstanding gate for the owner and never loops.
   */
  coverageSuspendedRetryLimit?: number;
}

const HANDOFF_SNAPSHOT_FAILURE_DETAIL_MAX_LENGTH = 300;

/**
 * C2a repair (M4): bounded, redacted failure cause for the pause detail --
 * the error message only (never a stack), single-lined and truncated.
 */
/**
 * C3a (AR-R08): the "no notes" reason every stop snapshot renders until
 * C3b adds the Architect stop notes.
 */
const STOP_SNAPSHOT_NO_NOTES_REASON = "stop notes are added in C3b";

/**
 * C3a (AR-R08): the log event that recorded the current stop (the latest
 * stop event). `project.handoff_requested` is C2's stop and is never
 * returned here -- the caller stands down while a handoff is requested.
 * Terminal failure is the abort resolution; an exceptional-recovery pause
 * carries its fixed reason; every other stop is the latest pause-typed
 * event (`run.paused`, `repair.issue_paused`, `repair.cycle_limit_reached`,
 * or the recording failure's own `run.paused`).
 */
function findCurrentStopEvent(
  events: SchedulerEvent[],
  projection: SchedulerProjection,
): SchedulerEvent | undefined {
  if (projection.status === "failed") {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]!.type === "context_manifest.recording_resolved") return events[index]!;
    }
    return undefined;
  }
  if (projection.pauseReason?.reason === EXCEPTIONAL_RECOVERY_PAUSE_REASON) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]!.type === "process.recovery_updated") return events[index]!;
    }
    return undefined;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]!.type;
    if (
      type === "run.paused" ||
      type === "repair.issue_paused" ||
      type === "repair.cycle_limit_reached" ||
      type === "context_manifest.recording_failed"
    ) {
      return events[index]!;
    }
  }
  return undefined;
}

function snapshotFailureDetail(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const singleLine = message.replace(/\s+/g, " ").trim();
  return singleLine.slice(0, HANDOFF_SNAPSHOT_FAILURE_DETAIL_MAX_LENGTH) || "handoff snapshot failed";
}

/** Windows reserved device names: never a spec file stem, with or without an extension. */
const WINDOWS_RESERVED_FILE_STEMS: ReadonlySet<string> = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/** C2b repair m4: spec file stems are capped so the copy path stays portable. */
const SPEC_SOURCE_ID_MAX_LENGTH = 100;

/**
 * C2b (CD-5): the `docs/project/specs/<source-id>.md` file stem for an
 * approved source id. Path-unsafe characters become `_`, capped in length;
 * a Windows reserved stem (any case, with or without an extension), an
 * empty result, or a dot-only result falls back to a digest-based name so
 * the copy never fails the snapshot commit. Without a digest there is no
 * fallback, and the copy is skipped with a recorded reason instead.
 */
export function sanitizeSpecSourceId(sourceId: string, digest?: string): string | undefined {
  const trimmed = sourceId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  const safe = trimmed.slice(0, SPEC_SOURCE_ID_MAX_LENGTH);
  const head = (safe.split(".")[0] ?? "").toUpperCase();
  if (!safe || safe === '.' || safe === '..' || WINDOWS_RESERVED_FILE_STEMS.has(head)) {
    if (digest !== undefined && /^[a-f0-9]{64}$/.test(digest)) return `spec-${digest.slice(0, 16)}`;
    return undefined;
  }
  return safe;
}

/**
 * Per-entry-file handoff status from the COMMIT tree facts alone (C2c
 * NF-2/CD-15, NF-3). Each file is satisfied directly, through a link whose
 * target blob holds the section (redirected at stage time, recorded on the
 * redirect), or -- for CLAUDE.md only -- through the legacy link to
 * AGENTS.md. A link to anything else satisfies the file through the
 * recorded skip reason, but only when the commit tree corroborates the
 * link (its raw target); otherwise the layout is refused (null), so a
 * commit tree without the lines is never accepted on a live checkout's
 * word alone (U1, U2). A redirect reason counts only with its ViaLink
 * proof: a redirect the tree disproves is a failure, not a skip.
 */
export function handoffEntryFileStatus(
  entryPoint: ProjectDocCommitResult["entryPoint"],
  reasons: {
    agentsRedirect?: string;
    agentsRedirectTarget?: string;
    agentsSkip?: string;
    claudeRedirect?: string;
    claudeSkip?: string;
  },
): {
  agentsSectionCommitted: boolean;
  agentsSectionViaLink?: string;
  claudeLineCommitted: boolean;
  claudeLineViaLink?: string;
} | null {
  let agentsSectionCommitted = entryPoint.agentsMarkedSectionV2;
  let agentsSectionViaLink = reasons.agentsRedirect;
  if (entryPoint.agentsSectionV2ViaLink === true) {
    agentsSectionCommitted = true;
  } else {
    agentsSectionViaLink = undefined;
  }
  if (!agentsSectionCommitted) {
    // C2d repair cycle 1 (escalation): a colliding entry file carries no
    // link, so the recorded skip counts with the commit tree's
    // corroborating spellings instead (the describer only yields the skip
    // then). Anything else still pauses fail-closed.
    const agentsCollision = (entryPoint.agentsCollisionSpellings ?? []).length > 1;
    if (reasons.agentsSkip === undefined || (entryPoint.agentsLinkTarget === undefined && !agentsCollision)) return null;
    agentsSectionViaLink = reasons.agentsSkip;
  }
  let claudeLineCommitted = entryPoint.claudePointerV2;
  let claudeLineViaLink = reasons.claudeRedirect;
  if (entryPoint.claudePointerV2ViaAgentsLink === true) {
    claudeLineCommitted = true;
    claudeLineViaLink = "CLAUDE.md is a symbolic link to AGENTS.md";
  } else if (entryPoint.claudePointerV2ViaLink === true) {
    claudeLineCommitted = true;
  } else {
    claudeLineViaLink = undefined;
  }
  if (!claudeLineCommitted) {
    // C2c repair M-6: when AGENTS.md resolves to CLAUDE.md the merged
    // section carries no @AGENTS.md self-import (recorded as the CLAUDE.md
    // skip reason); the AGENTS.md section in CLAUDE.md satisfies both
    // entry lines when the commit tree proves the redirect into CLAUDE.md.
    if (
      reasons.claudeSkip !== undefined &&
      // C2d repair cycle 1 (B3): the redirect-target identity folds case --
      // `claude.md` (the index's own spelling) counts the way `CLAUDE.md`
      // does. Only this comparison folds; the redirect itself still
      // requires the exact index entry.
      (reasons.agentsRedirectTarget ?? "").toLowerCase() === "claude.md" &&
      entryPoint.agentsLinkTarget !== undefined &&
      handoffLinkRawTargetsClaudeDotMd(entryPoint.agentsLinkTarget) &&
      entryPoint.agentsSectionV2ViaLink === true
    ) {
      claudeLineCommitted = true;
      claudeLineViaLink = reasons.claudeSkip;
    } else {
      // C2d repair cycle 1 (escalation): same collision rule as the
      // AGENTS.md section above -- the recorded skip counts with the
      // commit tree's corroborating spellings, never on a bare claim.
      const claudeCollision = (entryPoint.claudeCollisionSpellings ?? []).length > 1;
      if (reasons.claudeSkip === undefined || (entryPoint.claudeLinkTarget === undefined && !claudeCollision)) return null;
      claudeLineViaLink = reasons.claudeSkip;
    }
  }
  return {
    agentsSectionCommitted,
    ...(agentsSectionViaLink !== undefined ? { agentsSectionViaLink } : {}),
    claudeLineCommitted,
    ...(claudeLineViaLink !== undefined ? { claudeLineViaLink } : {}),
  };
}

export interface ProjectDocsPort {
  commit(input: ProjectDocCommitRequest): Promise<ProjectDocCommitResult>;
  commitHandoffSnapshot(input: HandoffSnapshotCommitRequest): Promise<ProjectDocCommitResult>;
  readHandoffSnapshotFile(input: { commit: string; path: string }): Promise<{ content: string | null; paths: string[] }>;
  relateRevision(input: { revision: string; tip: string }): Promise<DocumentTipRelation>;
  /**
   * C2b (AR-R07): read a file from the integration tip commit (blob bytes,
   * never the working tree) for hand-edit detection.
   */
  readIntegrationTipFile(input: { path: string }): Promise<{ content: string | null; commit: string }>;
  /**
   * C2b (CD-5): find a tracked file at the integration tip whose bytes hash
   * to the digest, or null. Bounds the "already a repository file" decision.
   */
  findTrackedFileWithDigest(input: { digest: string; byteLength: number }): Promise<{ path: string } | null>;
  /**
   * C2b repair B1 (required): lookup-only snapshot find for a stop key --
   * the runner snapshot commit carrying the key, or null. Never commits.
   * Required so a missing factory wiring is a type error, never a silent
   * skip of withdrawn-stop reconciliation (C2b repair B1-R).
   */
  findHandoffSnapshotCommit(input: { snapshotKey: string }): Promise<ProjectDocCommitResult | null>;
  /**
   * C2b repair CD-14/N6 (required): the recorded integration baseline
   * revision, the handed-off revision when a docs-v2 run has no plan
   * revision and no integration revision yet. Required for the same
   * reason: production always wires it.
   */
  readIntegrationBaselineRevision(): Promise<{ revision: string }>;
  /**
   * C2c (NF-1 residual, required): whether a spec-copy path can be staged
   * right now. The check writes nothing and answers with a dry-run
   * `git add`, which stages nothing; a link at any component of the path,
   * or other bytes already at the path, reports unstageable. Required so a
   * missing wiring is a type error, never a silently wrong `spec:` line:
   * the runtime asks before rendering STATE.md and renders "not recorded"
   * when the copy will be skipped.
   */
  canStageSpecPath(input: { path: string; content: string }): Promise<{ stageable: boolean; unstageableReason?: "path_occupied" | "write_failed" }>;
}

export interface BuildStepResult {
  status: "progressed" | "paused" | "completed" | "idle" | "blocked" | "failed";
  action?: string;
}

/** Mechanical step shape of a projection after a context-recording decision turn. */
export function buildStepResultForProjection(
  projection: SchedulerProjection,
): BuildStepResult {
  if (projection.status === "completed") return { status: "completed" };
  if (projection.status === "failed") {
    return {
      status: "failed",
      action: projection.failureReason ?? "context_recording_aborted",
    };
  }
  if (projection.status === "paused" || projection.status === "stopped") {
    return projection.pauseReason?.reason
      ? { status: "paused", action: projection.pauseReason.reason }
      : { status: "paused" };
  }
  return { status: "progressed" };
}

/**
 * T9 (OA-5): the first answer-review id the pump drives per run. Repair
 * cycle 1 (B1): a re-recorded answer after a verdict drives a re-review as
 * `answer_review_{n}` (see `nextAnswerReviewId`) with the latest verdict
 * attached as the prior review (OA-10 #2).
 */
export const ANSWER_REVIEW_ID = "answer_review_1";

export class BuildRuntime {
  readonly id: string;
  private readonly runId: string;
  private readonly initialObjective?: string;
  private readonly store: SchedulerStore;
  private readonly scheduler: TaskScheduler;
  private readonly architectDriver: ArchitectRuntimeDriver;
  private readonly integrationDriver: IntegrationRuntimeDriver;
  private readonly deliveryReview?: DeliveryReviewDriver;
  private readonly deliveryBoundary?: DeliveryBoundaryDriver;
  private readonly runPolicy: NativeBuildRunPolicy;
  private readonly specCopy: boolean;
  private readonly handoffFiles: HandoffFilesOption;
  private readonly maxTaskAttempts: number;
  private readonly resourceCapacity?: TaskSchedulerOptions["resourceCapacity"];
  private readonly architectId: string;
  private readonly clock: () => string;
  private readonly renewBudgetWindow?: BuildRuntimeOptions["renewBudgetWindow"];
  private readonly providerRetryDeadlineMs?: BuildRuntimeOptions["providerRetryDeadlineMs"];
  private readonly evidenceStore?: EvidenceStore;
  private readonly artifacts?: ArtifactStore;
  private readonly projectDocs?: ProjectDocsPort;
  private readonly finalVerificationDriver?: FinalVerificationCheckDriver;
  private readonly finalVerificationCleanupDriver?: FinalVerificationCleanupDriver;
  private readonly finalVerificationProfileFor?: BuildRuntimeOptions["finalVerificationProfileFor"];
  private readonly discardFinalVerificationProfile?: BuildRuntimeOptions["discardFinalVerificationProfile"];
  private readonly independentVerifier?: IndependentVerifierDriver;
  private readonly planCritic?: PlanCriticDriver;
  private readonly repairPlanLimit: number;
  /**
   * Owner decision 2026-09-26 ("Scale with tasks"): true when the operator
   * set an explicit run-level repair-plan cap, which wins over the scaled
   * 3 + ready-plan-tasks default. Recorded durably on repair.policy_configured.
   */
  private readonly explicitRepairPlanLimit: boolean;
  private readonly projectId?: string;
  private readonly issueRepairLimit: number;
  private readonly repairApproachAvailable: boolean;
  private readonly flakyIsolation: BuildRuntimeOptions["flakyIsolation"];
  private readonly cleanupAfterAttempt: BuildRuntimeOptions["cleanupAfterAttempt"];
  private readonly reviewOutcomeRecorder: BuildRuntimeOptions["reviewOutcomeRecorder"];
  private readonly architectLifecycleProbe?: BuildRuntimeOptions["architectLifecycleProbe"];
  private readonly planningSourceReader?: PlanningSourceReader;
  private readonly coverageReview?: CoverageReviewDriver;
  private readonly answerReview?: AnswerReviewDriver;
  private readonly answerAuthority: AnswerReviewAuthority;
  private readonly planningHostCapabilities?: PlanningHostCapabilitiesProvider;
  private readonly coverageSuspendedRetryLimit: number;
  private lifecycleController = new AbortController();
  private stepQueue = Promise.resolve();
  private recordingFailureContext: {
    taskId?: string;
    attempt?: number;
    revision?: string;
  } = {};

  constructor(options: BuildRuntimeOptions) {
    this.id = options.runId;
    this.runId = options.runId;
    this.initialObjective = options.initialObjective;
    this.store = options.store;
    this.architectDriver = options.architectDriver;
    this.integrationDriver = options.integrationDriver;
    this.deliveryReview = options.deliveryReview;
    this.deliveryBoundary = options.deliveryBoundary;
    this.runPolicy = options.runPolicy ?? "finish";
    this.specCopy = options.specCopy ?? true;
    this.handoffFiles = options.handoffFiles ?? "commit";
    this.maxTaskAttempts = options.maxTaskAttempts ?? 2;
    this.resourceCapacity = options.resourceCapacity;
    this.architectId = options.architectId ?? "architect_1";
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.renewBudgetWindow = options.renewBudgetWindow;
    this.providerRetryDeadlineMs = options.providerRetryDeadlineMs;
    this.evidenceStore = options.evidenceStore;
    this.artifacts = options.artifacts;
    this.projectDocs = options.projectDocs;
    this.finalVerificationDriver = options.finalVerificationDriver;
    this.finalVerificationCleanupDriver = options.finalVerificationCleanupDriver;
    this.finalVerificationProfileFor = options.finalVerificationProfileFor;
    this.discardFinalVerificationProfile = options.discardFinalVerificationProfile;
    this.independentVerifier = options.independentVerifier;
    this.planCritic = options.planCritic;
    this.repairPlanLimit = options.repairPlanLimit ?? DEFAULT_REPAIR_PLAN_LIMIT;
    this.explicitRepairPlanLimit = options.repairPlanLimit !== undefined;
    this.projectId = options.projectId;
    this.issueRepairLimit = options.issueRepairLimit ?? DEFAULT_ISSUE_REPAIR_CYCLE_LIMIT;
    this.repairApproachAvailable = options.repairApproachAvailable ?? true;
    this.flakyIsolation = options.flakyIsolation;
    this.cleanupAfterAttempt = options.cleanupAfterAttempt;
    this.reviewOutcomeRecorder = options.reviewOutcomeRecorder;
    this.architectLifecycleProbe = options.architectLifecycleProbe;
    this.planningSourceReader = options.planningSourceReader;
    this.coverageReview = options.coverageReview;
    this.answerReview = options.answerReview;
    this.answerAuthority = new SchedulerAnswerReviewAuthority(options.store);
    this.planningHostCapabilities = options.planningHostCapabilities;
    this.coverageSuspendedRetryLimit = options.coverageSuspendedRetryLimit ?? DEFAULT_COVERAGE_SUSPENDED_RETRY_LIMIT;
    if (!Number.isSafeInteger(this.coverageSuspendedRetryLimit) || this.coverageSuspendedRetryLimit < 0) {
      throw new Error("coverageSuspendedRetryLimit must be a non-negative integer.");
    }
    if (
      this.coverageReview &&
      (
        this.coverageReview.candidateRuntimeIds.length === 0 ||
        new Set(this.coverageReview.candidateRuntimeIds).size !==
          this.coverageReview.candidateRuntimeIds.length ||
        this.coverageReview.candidateRuntimeIds.some((runtimeId) => !runtimeId.trim())
      )
    ) {
      throw new Error(
        "Coverage review requires unique non-empty candidate runtime IDs.",
      );
    }
    if (
      this.answerReview &&
      (
        this.answerReview.candidateRuntimeIds.length === 0 ||
        new Set(this.answerReview.candidateRuntimeIds).size !==
          this.answerReview.candidateRuntimeIds.length ||
        this.answerReview.candidateRuntimeIds.some((runtimeId) => !runtimeId.trim())
      )
    ) {
      throw new Error(
        "Answer review requires unique non-empty candidate runtime IDs.",
      );
    }
    if (
      this.independentVerifier &&
      (
        this.independentVerifier.candidateRuntimeIds.length === 0 ||
        new Set(this.independentVerifier.candidateRuntimeIds).size !==
          this.independentVerifier.candidateRuntimeIds.length ||
        this.independentVerifier.candidateRuntimeIds.some((runtimeId) => !runtimeId.trim())
      )
    ) {
      throw new Error(
        "Independent verifier requires unique non-empty candidate runtime IDs.",
      );
    }
    if (this.planCritic) {
      if (
        this.planCritic.candidateRuntimeIds.length === 0 ||
        new Set(this.planCritic.candidateRuntimeIds).size !==
          this.planCritic.candidateRuntimeIds.length ||
        this.planCritic.candidateRuntimeIds.some((runtimeId) => !runtimeId.trim())
      ) {
        throw new Error(
          "Plan critic requires unique non-empty candidate runtime IDs.",
        );
      }
      if (
        this.independentVerifier &&
        (
          this.planCritic.candidateRuntimeIds.length !==
            this.independentVerifier.candidateRuntimeIds.length ||
          this.planCritic.candidateRuntimeIds.some(
            (runtimeId, index) =>
              runtimeId !== this.independentVerifier!.candidateRuntimeIds[index],
          )
        )
      ) {
        throw new Error(
          "Plan critic candidate runtime IDs must equal the verifier policy candidates.",
        );
      }
    }
    this.configureProjectDocsPolicy();
    this.initializeRun();
    this.configureRunPolicy();
    this.configureVerifierPolicy();
    this.configureRepairPolicy();
    this.configurePlanCritiquePolicy();
    this.rederiveContextRecordingSuspension();
    this.scheduler = new TaskScheduler({
      runId: options.runId,
      store: options.store,
      driver: options.workerDriver,
      maxConcurrency: options.maxConcurrency,
      // T4: host-reported capacity further bounds new-policy admission.
      resourceCapacity: this.resourceCapacity,
      workspaceFor: options.workspaceFor,
      maxTaskAttempts: options.maxTaskAttempts,
      clock: this.clock,
      lifecycleSignal: () => this.activeLifecycleSignal(),
      providerRetryDeadlineMs: this.providerRetryDeadlineMs,
    });
  }

  projection(): SchedulerProjection {
    const events = this.store.readRun(this.runId);
    return events.length === 0
      ? emptyProjection(this.runId)
      : rebuildSchedulerProjection(events);
  }

  events(afterSequence = 0) {
    return this.store.readRun(this.runId, afterSequence);
  }

  pause(reason: string, idempotencyKey: string): SchedulerProjection {
    this.ensureInitialized();
    const projection = this.projection();
    if (projection.status === "completed") {
      throw new Error("A completed Build cannot be paused.");
    }
    this.lifecycleController.abort(
      new DOMException(`Build ${this.runId} paused.`, "AbortError")
    );
    this.store.append({
      runId: this.runId,
      type: "run.paused",
      occurredAt: this.clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey,
      payload: { reason },
    });
    return this.projection();
  }

  resume(idempotencyKey: string): SchedulerProjection {
    return this.resumeInternal(idempotencyKey, true);
  }

  continue(idempotencyKey: string): SchedulerProjection {
    return this.resumeInternal(idempotencyKey, false);
  }

  private resumeInternal(
    idempotencyKey: string,
    renewBudgetWindow: boolean
  ): SchedulerProjection {
    this.ensureInitialized();
    const projection = this.projection();
    if (projection.status === "completed") {
      throw new Error("A completed Build cannot be resumed.");
    }
    if (projection.status === "failed") {
      throw new Error("A failed Build cannot be resumed.");
    }
    if (!renewBudgetWindow && projection.status !== "paused") {
      throw new Error("A benchmark continuation requires a paused Build.");
    }
    if (this.lifecycleController.signal.aborted) {
      this.lifecycleController = new AbortController();
    }
    // C2a: a failed kernel snapshot pauses the handoff instead of blocking it;
    // the owner's resume retries the commit. C2b (N2): the exemption is
    // "docs v2, handoff requested, no snapshot for the current stop", not
    // the current pause reason alone -- an owner pause stacked on a
    // snapshot failure still allows resume to retry.
    if (
      projection.projectHandoff?.status === "requested" &&
      projection.pauseReason?.reason !== "handoff_snapshot_failed" &&
      !handoffSnapshotRetryPending(projection)
    ) {
      throw new Error(
        "This Build is awaiting the user's final project handoff selection."
      );
    }
    if (projection.verifierSelection?.status === "required") {
      throw new Error(
        "This Build is awaiting the user's independent verifier selection."
      );
    }
    if (projection.repairCycles?.pause) {
      throw new Error("This Build is awaiting the user's repair-cycle decision.");
    }
    // R2-1: an owner's resume clears a terminal N6 exhaustion gate durably
    // (an owner-authorized retry event) and resets the suspended-retry
    // count, so the next step runs the review again instead of re-pausing.
    // Non-terminal gates need no clearing: the next step retries them.
    const terminalGate = projection.planning?.coverageUnavailable;
    if (
      terminalGate?.reviewId !== undefined &&
      (TERMINAL_COVERAGE_GATE_REASONS as readonly string[]).includes(terminalGate.reason)
    ) {
      new SchedulerCoverageReviewAuthority(this.store).authorizeCoverageRetry({
        runId: this.runId,
        reviewId: terminalGate.reviewId,
        occurredAt: this.clock(),
      });
    }
    const occurredAt = this.clock();
    if (
      renewBudgetWindow &&
      projection.status === "paused" &&
      this.runPolicy === "budgeted"
    ) {
      this.renewBudgetWindow?.(`budget-window:${idempotencyKey}`, occurredAt);
    }
    const unresolvedRecording = projection.status === "paused" &&
      projection.pauseReason?.reason === "context_recording_failed"
      ? latestUnresolvedContextRecordingNote(projection)
      : undefined;
    if (unresolvedRecording) {
      this.store.append({
        runId: this.runId,
        type: "context_manifest.recording_resolved",
        occurredAt,
        actor: { role: "user", id: "local-user" },
        idempotencyKey: `context-recording-resolved:user:${unresolvedRecording.sequence}`,
        payload: {
          noteSequence: unresolvedRecording.sequence,
          resolution: "retry",
          rationale: "User resumed the run.",
        },
      });
    }
    this.store.append({
      runId: this.runId,
      type: "run.resumed",
      occurredAt,
      actor: { role: "user", id: "local-user" },
      idempotencyKey,
      payload: {},
    });
    return this.projection();
  }

  selectArchitectHandoff(
    runtimeId: string,
    idempotencyKey: string
  ): SchedulerProjection {
    // FX-2 repair 1 (M2): scope the stored key to the requirement this
    // answer belongs to. The client reuses one key per runtime
    // (`architect-handoff:<run>:<runtime>`), so without scoping an answer to
    // a second handoff offer dedupes into the first selection and the run
    // stays paused. The first requirement keeps the bare caller key so
    // pre-fix logs and in-flight runs behave as before; a replay of the same
    // answer sees the same requirement count and still dedupes. Selections
    // never record requirements, so the count is stable across the answer
    // itself. The reducer never inspects the key.
    const handoffRequirements = this.recordedArchitectHandoffRequirements();
    const storedArchitectKey = handoffRequirements <= 1
      ? idempotencyKey
      : `${idempotencyKey}:req-${handoffRequirements}`;
    this.store.append({
      runId: this.runId,
      type: "architect.handoff_selected",
      occurredAt: this.clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: storedArchitectKey,
      payload: { runtimeId },
    });
    return this.projection();
  }

  selectVerifierRuntime(
    runtimeId: string,
    idempotencyKey: string,
  ): SchedulerProjection {
    // FX-2 repair 1 (B1): scope the stored key to the requirement this
    // answer belongs to. The client reuses one key per runtime
    // (`verifier-handoff:<run>:<runtime>`), so without scoping an answer to
    // a re-required selection dedupes into the first selection: the API
    // reports success with the projection unchanged, the selection stays
    // `required`, and a run with one verifier candidate stays stuck. The
    // first requirement keeps the bare caller key so pre-fix logs and
    // in-flight runs behave as before; a replay of the same answer sees the
    // same requirement count and still dedupes. Selections never record
    // requirements, so the count is stable across the answer itself. The
    // reducer never inspects the key.
    const verifierRequirements = this.recordedVerifierRequirements();
    const storedVerifierKey = verifierRequirements <= 1
      ? idempotencyKey
      : `${idempotencyKey}:req-${verifierRequirements}`;
    this.store.append({
      runId: this.runId,
      type: "verifier.selection_selected",
      occurredAt: this.clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: storedVerifierKey,
      payload: { runtimeId },
    });
    return this.projection();
  }

  /**
   * FX-2 repair 1 (B1/M2): the occurrence an owner answer belongs to -- the
   * number of recorded requirements. Durable log state, so a replay of the
   * same answer computes the same count and still dedupes, a new requirement
   * increments it, and a restart records nothing new.
   */
  private recordedVerifierRequirements(): number {
    return this.store.readRun(this.runId).filter(
      (event) => event.type === "verifier.selection_required",
    ).length;
  }

  private recordedArchitectHandoffRequirements(): number {
    return this.store.readRun(this.runId).filter(
      (event) => event.type === "architect.handoff_required",
    ).length;
  }

  extendRepairCycles(additionalRepairPlans: number, idempotencyKey: string): SchedulerProjection {
    this.store.append({
      runId: this.runId,
      type: "repair.cycle_limit_extended",
      occurredAt: this.clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey,
      payload: { additionalRepairPlans },
    });
    return this.projection();
  }

  submitUserGuidance(input: {
    guidanceId: string;
    text: string;
    version: number;
    idempotencyKey: string;
  }): SchedulerProjection {
    const submitted = this.submitManagedUserGuidance(input);
    const guidance = submitted.userGuidance[input.guidanceId];
    if (guidance?.interruptionStatus === "pending") {
      return this.completeManagedUserGuidanceInterruption(
        input.guidanceId,
        input.version,
      );
    }
    return submitted;
  }

  submitManagedUserGuidance(input: {
    guidanceId: string;
    text: string;
    version: number;
    idempotencyKey: string;
  }): SchedulerProjection {
    const sequenceBefore = this.store.readRun(this.runId).at(-1)?.sequence ?? 0;
    const appended = this.store.append({
      runId: this.runId,
      type: "user.guidance_submitted",
      occurredAt: this.clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: input.idempotencyKey,
      payload: {
        guidanceId: input.guidanceId,
        text: input.text,
        version: input.version,
        interruptionProtocolVersion: 1,
      },
    });
    if (appended.sequence > sequenceBefore) {
      this.lifecycleController.abort(
        new DOMException(`Build ${this.runId} received user guidance.`, "AbortError")
      );
    }
    return this.projection();
  }

  completeManagedUserGuidanceInterruption(
    guidanceId: string,
    expectedVersion: number,
  ): SchedulerProjection {
    this.store.append({
      runId: this.runId,
      type: "user.guidance_interruption_completed",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-manager" },
      idempotencyKey: `guidance-interruption:${guidanceId}:version:${expectedVersion}`,
      payload: { guidanceId, expectedVersion },
    });
    return this.projection();
  }

  answerArchitectQuestion(input: {
    questionId: string;
    expectedVersion: number;
    answer: string;
    idempotencyKey: string;
  }): SchedulerProjection {
    this.store.append({
      runId: this.runId,
      type: "architect.question_answered",
      occurredAt: this.clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: input.idempotencyKey,
      payload: {
        questionId: input.questionId,
        expectedVersion: input.expectedVersion,
        answer: input.answer,
      },
    });
    return this.projection();
  }

  selectProjectHandoff(
    choice: ProjectHandoffChoice,
    result: {
      integrationRevision: string;
      integrationBranch: string;
      appliedToProject: boolean;
      projectRevision?: string;
    },
    idempotencyKey: string,
    actor: SchedulerActor = { role: "user", id: "local-user" }
  ): SchedulerProjection {
    this.store.append({
      runId: this.runId,
      type: "project.handoff_selected",
      occurredAt: this.clock(),
      actor,
      idempotencyKey,
      payload: { choice, ...result },
    });
    return this.projection();
  }

  async step(): Promise<BuildStepResult> {
    const previous = this.stepQueue;
    let release!: () => void;
    this.stepQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.stepOnce();
    } finally {
      release();
    }
  }

  async runUntilBlocked(maxSteps = 100): Promise<BuildStepResult> {
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
      throw new Error("maxSteps must be a positive integer.");
    }
    let latest: BuildStepResult = { status: "idle" };
    for (let index = 0; index < maxSteps; index += 1) {
      latest = await this.step();
      if (latest.status !== "progressed") return latest;
    }
    return { status: "progressed", action: "step_allowance_yielded" };
  }

  private async stepOnce(): Promise<BuildStepResult> {
    try {
      return await this.dispatchStep();
    } catch (error) {
      if (!(error instanceof ContextManifestRecordingError)) throw error;
      try {
        this.recordContextRecordingFailure(error);
      } catch {
        throw error;
      }
      return { status: "paused", action: "context_recording_failed" };
    }
  }

  private async dispatchStep(): Promise<BuildStepResult> {
    this.recordingFailureContext = {};
    let events = this.store.readRun(this.runId);
    if (events.length === 0) {
      await this.runArchitect({ type: "plan_required" }, emptyProjection(this.runId));
      return this.afterArchitect("plan_required");
    }

    let projection = rebuildSchedulerProjection(events);
    if (projection.status === "completed") return { status: "completed" };
    // C3a (AR-R08): snapshot at every stop other than handoff. Order
    // against C2's handoff commit below is irrelevant: while a handoff is
    // requested this stands down, otherwise that call is a no-op. Never
    // blocks or changes the stop; the paused/failed returns below read the
    // same projection values as before (a stop record never touches them).
    await this.maybeCommitStopSnapshot(projection);
    const handoffSnapshot = await this.maybeCommitHandoffSnapshot(projection);
    if (handoffSnapshot) return handoffSnapshot;
    if (projection.status === "failed") {
      return { status: "failed", action: "context_recording_aborted" };
    }
    if (projection.status === "paused") {
      return { status: "paused", action: projection.pauseReason?.reason };
    }
    await this.recoverPendingProjectDocs();
    events = this.store.readRun(this.runId);
    projection = events.length === 0
      ? emptyProjection(this.runId)
      : rebuildSchedulerProjection(events);
    const pendingInterruption = Object.values(projection.userGuidance)
      .filter((guidance) => guidance.interruptionStatus !== "completed")
      .sort((left, right) => left.version - right.version)[0];
    if (pendingInterruption) {
      return { status: "blocked", action: "user_guidance_interruption_pending" };
    }
    if (projection.blockingArchitectQuestionId) {
      return { status: "blocked", action: "architect_question_pending" };
    }
    const pendingQuestionResume = Object.values(projection.architectQuestions)
      .filter((question) =>
        question.status === "answered" &&
        question.checkpoint !== undefined &&
        (question.resumeStatus === "pending" || question.resumeStatus === "started")
      )
      .sort((left, right) => left.version - right.version)[0];
    // T9 repair cycle 1 (B3): pending user guidance routes to the Architect
    // whenever the run is new-policy and non-terminal — regardless of
    // planRevision, which stays 0 on new-policy runs until tasks exist (and
    // answered runs never get tasks). The T3 seam this closes predates T9.
    // Legacy routing is unchanged.
    const guidanceRoutes = projection.planRevision > 0 ||
      (projection.planningPolicyVersion === 1 && projection.status !== "stopped");
    if (guidanceRoutes) {
      const pendingGuidance = firstPendingUserGuidance(projection);
      if (pendingGuidance) {
        const resumeReason = pendingQuestionResume?.checkpoint?.reason;
        if (
          resumeReason?.type === "user_guidance_required" &&
          resumeReason.guidanceId === pendingGuidance.guidanceId &&
          resumeReason.version === pendingGuidance.version
        ) {
          return await this.resumeArchitectQuestion(pendingQuestionResume.questionId);
        }
        await this.runArchitect({
          type: "user_guidance_required",
          guidanceId: pendingGuidance.guidanceId,
          version: pendingGuidance.version,
        }, projection);
        return this.afterArchitect("user_guidance_required");
      }
    }
    if (pendingQuestionResume?.checkpoint) {
      return await this.resumeArchitectQuestion(pendingQuestionResume.questionId);
    }
    if (
      projection.acceptanceContractStatus ===
      "acceptance_contract_upgrade_required"
    ) {
      if (
        !events.some((event) => event.type === "acceptance_contract.upgrade_required")
      ) {
        this.store.append({
          runId: this.runId,
          type: "acceptance_contract.upgrade_required",
          occurredAt: this.clock(),
          actor: { role: "runner", id: "build-runtime" },
          idempotencyKey: "acceptance-contract-upgrade-required",
          payload: {
            taskIds: Object.values(projection.tasks)
              .filter(
                (task) =>
                  task.status !== "cancelled" &&
                  task.acceptanceCriteria === undefined
              )
              .map((task) => task.id)
              .sort(),
          },
        });
        projection = this.projection();
      }
      await this.runArchitect(
        { type: "acceptance_contract_upgrade_required" },
        projection
      );
      return this.afterArchitect("acceptance_contract_upgrade_required");
    }
    // T9 (EP39/OA-5): the answer path owns triage-`answer` runs outright —
    // before planning, critique, workers, integration, and final
    // verification. Answered runs complete with no plan, no critic, no
    // coverage review, and no verifier except the opted-in answer review.
    if (projection.planningPolicyVersion === 1 && isAnsweredRun(projection)) {
      return this.advanceAnswerPath(projection);
    }
    if (projection.planningPolicyVersion === 1) {
      // T3a/T3b: new-policy runs plan through the planning tools, not
      // plan_tasks, so legacy planRevision stays 0; planning continues until
      // the ready plan identity exists. A requested coverage review is driven
      // here; otherwise the Architect plans. (T9: triage precedes all of
      // this — the planning tools and events refuse until triage is `build`.)
      if (!readyPlanIdentity(projection)) {
        const coverage = await this.advanceCoverageReview(projection);
        if (coverage) return coverage;
        await this.runArchitect({ type: "plan_required" }, projection);
        return this.afterArchitect("plan_required");
      }
    } else if (projection.planRevision === 0) {
      await this.runArchitect({ type: "plan_required" }, projection);
      return this.afterArchitect("plan_required");
    }

    const critique = await this.advancePlanCritique(projection);
    if (critique) return critique;

    const openGuidance = Object.values(projection.guidance)
      .filter((guidance) => guidance.status === "open")
      .sort((left, right) => left.requestId.localeCompare(right.requestId))[0];
    if (openGuidance) {
      await this.runArchitect({
        type: "guidance_required",
        requestId: openGuidance.requestId,
        taskId: openGuidance.taskId,
      }, projection);
      return this.afterArchitect("guidance_required");
    }

    if (this.runPolicy === "plan_only") {
      await this.runArchitect({
        type: "completion_decision_required",
        runPolicy: "plan_only",
      }, projection);
      return this.afterArchitect("completion_decision_required");
    }

    const submitted = firstTask(projection, "submitted");
    if (submitted?.changeSetId) {
      // T6a: a new-policy submission reaches the Architect only after its
      // mandatory deliverable review completed.
      if (
        projection.planningPolicyVersion === 1 &&
        currentSubmissionReview(projection.delivery, submitted)?.stage !== "completed"
      ) {
        return await this.advanceDeliveryReview(submitted);
      }
      await this.runArchitect(this.reviewRequiredReason(submitted, projection), projection);
      return this.afterArchitect("review_required");
    }

    const approved = firstTask(projection, "approved");
    if (approved?.changeSetId) {
      await this.runArchitect({
        type: "integration_approval_required",
        taskId: approved.id,
        changeSetId: approved.changeSetId,
      }, projection);
      return this.afterArchitect("integration_approval_required");
    }

    const integrating = firstTask(projection, "integrating");
    if (integrating?.changeSetId) {
      const result = await this.integrationDriver.integrate({
        runId: this.runId,
        taskId: integrating.id,
        changeSetId: integrating.changeSetId,
      });
      let integrationRevision = result.integrationRevision;
      if (result.status === "integrated") {
        const tip = projection.projectDocs?.documentTip;
        if (tip) {
          if (!this.projectDocs) {
            throw new Error("Document tip classification requires the project document port.");
          }
          const relation = await this.projectDocs.relateRevision({
            revision: result.integrationRevision,
            tip,
          });
          if (relation === "equal_to_tip" || relation === "ancestor") {
            if (!projection.integrationRevision) {
              throw new Error("Document tip has no canonical integration revision.");
            }
            integrationRevision = projection.integrationRevision;
          }
        }
      }
      this.store.append({
        runId: this.runId,
        type: "task.transitioned",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "integration-manager" },
        idempotencyKey: `integration:${integrating.changeSetId}:${result.status}`,
        payload: {
          taskId: integrating.id,
          status:
            result.status === "integrated"
              ? "integrated"
              : "integration_resolution",
          patch: {
            integrationRevision,
            ...(result.status === "conflict"
              ? { conflictPaths: result.conflictPaths }
              : {}),
          },
        },
      });
      return { status: "progressed", action: `integration_${result.status}` };
    }

    const acceptance = await this.advanceDeliveryAcceptance(projection);
    if (acceptance) return acceptance;
    const phaseAcceptance = this.recordPhaseAcceptancesIfReady(projection);
    if (phaseAcceptance) return phaseAcceptance;
    const conflict = firstTask(projection, "integration_resolution");
    if (conflict) {
      await this.runArchitect({
        type: "integration_resolution_required",
        taskId: conflict.id,
      }, projection);
      return this.afterArchitect("integration_resolution_required");
    }

    const failed = [...Object.values(projection.tasks)]
      .sort((left, right) => left.id.localeCompare(right.id))
      .find((task) => task.status === "failed");
    if (failed) {
      await this.runArchitect({
        type: "task_failure_resolution_required",
        taskId: failed.id,
        attempt: failed.attempt,
        failureReason: failed.failureReason ?? "worker_failed",
      }, projection);
      return this.afterArchitect("task_failure_resolution_required");
    }

    const rejected = [...Object.values(projection.tasks)]
      .sort((left, right) => left.id.localeCompare(right.id))
      .find((task) => task.status === "rejected");
    if (rejected) {
      if (rejected.attempt >= (rejected.attemptLimit ?? this.maxTaskAttempts)) {
        await this.runArchitect({
          type: "task_failure_resolution_required",
          taskId: rejected.id,
          attempt: rejected.attempt,
          failureReason: "architect_rejected_attempt_budget_exhausted",
        }, projection);
        return this.afterArchitect("rejected_task_resolution_required");
      }
      // T6b repair (R2-B5): a blocking review that dispatches a fix round
      // charges the review issue budget before the retry is planned.
      const reviewFixPause = await this.chargeReviewFixRound(rejected);
      if (reviewFixPause) return reviewFixPause;
      this.store.append({
        runId: this.runId,
        type: "task.transitioned",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `retry:${rejected.id}:${rejected.attempt}`,
        payload: { taskId: rejected.id, status: "planned" },
      });
      return { status: "progressed", action: "task_retry_planned" };
    }

    const exhaustedPlanned = [...Object.values(projection.tasks)]
      .sort((left, right) => left.id.localeCompare(right.id))
      .find(
        (task) =>
          task.status === "planned" &&
          task.attempt >= (task.attemptLimit ?? this.maxTaskAttempts)
      );
    if (exhaustedPlanned) {
      await this.runArchitect({
        type: "task_failure_resolution_required",
        taskId: exhaustedPlanned.id,
        attempt: exhaustedPlanned.attempt,
        failureReason: "task_attempt_budget_exhausted",
      }, projection);
      return this.afterArchitect("planned_task_resolution_required");
    }

    projection = this.projection();
    const finalVerification = projection.finalVerification?.current;
    if (finalVerification) {
      const result = await this.advanceFinalVerification(finalVerification);
      if (result) return result;
    }
    const tasks = Object.values(projection.tasks);
    const implementationTasks = tasks.filter(
      (task) => task.kind !== "final_verification"
    );
    const implementationTasksTerminal = implementationTasks.every(
      (task) => task.status === "integrated" || task.status === "cancelled"
    );
    if (
      implementationTasksTerminal &&
      projection.integrationRevision &&
      !projection.finalVerification?.current
    ) {
      await this.runArchitect({
        type: "final_verification_plan_required",
        integrationRevision: projection.integrationRevision,
      }, projection);
      const planned = this.projection().finalVerification?.current;
      if (!planned || planned.targetRevision !== projection.integrationRevision) {
        throw new Error(
          "Architect returned from final_verification_plan_required without a typed action."
        );
      }
      return this.afterArchitect("final_verification_plan_required");
    }
    if (
      tasks.every(
        (task) => task.status === "integrated" || task.status === "cancelled"
      )
    ) {
      await this.runArchitect({ type: "completion_decision_required" }, projection);
      return this.afterArchitect("completion_decision_required");
    }

    const sequenceBeforeWorkers = projection.lastSequence;
    await this.scheduler.tick();
    await this.scheduler.awaitIdle();
    if (this.projection().lastSequence > sequenceBeforeWorkers) {
      await this.recordCleanupSearch("task_attempt", this.workerSessionIdsSince(sequenceBeforeWorkers));
    }
    const afterWorkers = this.projection();
    if (afterWorkers.status === "paused") {
      return {
        status: "paused",
        action: afterWorkers.pauseReason?.reason === "context_recording_failed"
          ? "context_recording_failed"
          : "worker_paused",
      };
    }
    if (afterWorkers.status === "completed") {
      return { status: "completed", action: "worker_completed" };
    }
    if (afterWorkers.lastSequence > sequenceBeforeWorkers) {
      return { status: "progressed", action: "workers_advanced" };
    }
    // T3a repair cycle 2 (B2): never idle forever when pending work exists
    // but admission blocks all of it — wake the Architect to reconcile
    // instead of returning idle with zero Architect calls.
    if (newPolicyStaleTasksRequireArchitect(afterWorkers)) {
      await this.runArchitect({ type: "plan_required" }, afterWorkers);
      return this.afterArchitect("plan_required");
    }
    return { status: "idle", action: "no_mechanical_progress" };
  }

  private async advanceFinalVerification(
    generation: NonNullable<SchedulerProjection["finalVerification"]>["current"] & {},
  ): Promise<BuildStepResult | undefined> {
    if (generation.submission) {
      if (!generation.submissionResult) {
        return { status: "idle", action: "final_verification_submission_unvalidated" };
      }
      if (generation.cleanup?.status !== "succeeded") {
        return await this.advanceFinalVerificationCleanup(generation);
      }
      if (generation.review?.status === "approved") {
        const verifierResult = await this.advanceIndependentVerification();
        if (verifierResult) return verifierResult;
        await this.runArchitect(
          { type: "completion_decision_required" },
          this.projection(),
        );
        const completed = this.projection();
        if (completed.projectHandoff?.status !== "requested") {
          throw new Error(
            "Architect returned from completion_decision_required without a typed action.",
          );
        }
        return this.afterArchitect("completion_decision_required");
      }
      if (
        generation.review?.status === "repair_required" ||
        generation.review?.status === "rejected"
      ) {
        if (generation.review.status === "rejected") {
          return { status: "idle", action: "final_verification_repair_required" };
        }
        if (generation.repairTaskIds?.length) return undefined;
        const decision = generation.review.decision;
        if (!decision) {
          throw new Error("Final verification repair review lacks a structured decision.");
        }
        const pausedForRepair = this.pauseIfRepairCyclesExhausted(
          this.projection(),
          "final_verification",
          generation.targetRevision,
        );
        if (pausedForRepair) return pausedForRepair;
        const reviewDispatch = await this.prepareRepairDispatch(decision.failedCategories, { taskId: generation.taskId, evidenceIds: [...new Set(decision.categoryReviews.flatMap((review) => review.verdict === "repair_required" ? review.evidenceIds : []))], failingIdsByCategory: failingTestIdsByCategory(generation.completedChecks ?? []) });
        if (reviewDispatch.paused) return reviewDispatch.paused;
        await this.runArchitect({
          type: "final_verification_repair_plan_required",
          finalVerificationTaskId: generation.taskId,
          generationId: generation.generationId,
          targetRevision: generation.targetRevision,
          source: {
            type: "semantic_review",
            submissionId: generation.submission.submissionId,
            reviewId: generation.review.reviewId,
          },
          failedCategories: reviewDispatch.categories,
          evidenceIds: [...new Set(decision.categoryReviews.flatMap(
            (review) => review.verdict === "repair_required" ? review.evidenceIds : [],
          ))],
        }, this.projection());
        const repaired = this.projection().finalVerification?.current;
        // T6b repair (B3): a pause recorded during the turn returns paused,
        // never throws.
        if (this.projection().status === "paused") {
          return { status: "paused", action: this.projection().pauseReason?.reason ?? "repair_issue_paused" };
        }
        if (
          repaired?.generationId !== generation.generationId ||
          !repaired.repairTaskIds?.length
        ) {
          throw new Error(
            "Architect returned from final_verification_repair_plan_required without a typed action.",
          );
        }
        return this.afterArchitect("final_verification_repair_plan_required");
      }
      const reviewId = `final-verification-review:${generation.generationId}`;
      if (!generation.review) {
        this.store.append({
          runId: this.runId,
          type: "final_verification.review_requested",
          occurredAt: this.clock(),
          actor: { role: "runner", id: "build-runtime" },
          idempotencyKey: `${generation.generationId}:review-request`,
          payload: {
            taskId: generation.taskId,
            generationId: generation.generationId,
            targetRevision: generation.targetRevision,
            submissionId: generation.submission.submissionId,
            reviewId,
            attempt: generation.submission.attempt,
          },
        });
      }
      const current = this.projection().finalVerification?.current;
      if (!current?.submission || current.review?.status !== "requested") {
        throw new Error("Final verification review request was not durably recorded.");
      }
      await this.runArchitect({
        type: "final_verification_review_required",
        taskId: current.taskId,
        generationId: current.generationId,
        submissionId: current.submission.submissionId,
        targetRevision: current.targetRevision,
      }, this.projection());
      const reviewed = this.projection().finalVerification?.current;
      if (
        reviewed?.generationId !== current.generationId ||
        reviewed.review?.status === "requested" ||
        !reviewed.review
      ) {
        throw new Error(
          "Architect returned from final_verification_review_required without a typed action.",
        );
      }
      return this.afterArchitect("final_verification_review_required");
    }
    if (generation.completedChecks?.some((check) => !check.green)) {
      if (!generation.failure) {
        const failure = deriveFinalVerificationFailure(generation, 1);
        this.store.append({
          runId: this.runId,
          type: "final_verification.failure_reported",
          occurredAt: this.clock(),
          actor: { role: "runner", id: "build-runtime" },
          idempotencyKey: `${generation.generationId}:failure:${failure.failureId}`,
          payload: failure,
        });
        // T6b repair (R3-B2): a dispatched repair whose validation just
        // failed again has its consumed approach durably failed here.
        this.markDispatchedApproachesFailed(failure, generation.completedChecks);
        return { status: "progressed", action: "final_verification_failure_reported" };
      }
      if (generation.cleanup?.status !== "succeeded") {
        return await this.advanceFinalVerificationCleanup(generation);
      }
      if (generation.repairTaskIds?.length) return undefined;
      const pausedForRepair = this.pauseIfRepairCyclesExhausted(
        this.projection(),
        "final_verification",
        generation.targetRevision,
      );
      if (pausedForRepair) return pausedForRepair;
      const mechanicalDispatch = await this.prepareRepairDispatch(generation.failure.failedCategories, { taskId: generation.taskId, evidenceIds: [...generation.failure.evidenceIds], failingIdsByCategory: failingTestIdsByCategory(generation.completedChecks ?? []) });
      if (mechanicalDispatch.paused) return mechanicalDispatch.paused;
      await this.runArchitect({
        type: "final_verification_repair_plan_required",
        finalVerificationTaskId: generation.taskId,
        generationId: generation.generationId,
        targetRevision: generation.targetRevision,
        source: {
          type: "mechanical_failure",
          failureId: generation.failure.failureId,
          issueIds: [...generation.failure.issueIds],
          factIds: [...generation.failure.factIds],
        },
        failedCategories: mechanicalDispatch.categories,
        evidenceIds: [...generation.failure.evidenceIds],
      }, this.projection());
      const repaired = this.projection().finalVerification?.current;
      // T6b repair (B3): a pause recorded during the turn returns paused,
      // never throws.
      if (this.projection().status === "paused") {
        return { status: "paused", action: this.projection().pauseReason?.reason ?? "repair_issue_paused" };
      }
      if (repaired?.generationId !== generation.generationId || !repaired.repairTaskIds?.length) {
        throw new Error(
          "Architect returned from final_verification_repair_plan_required without a typed action.",
        );
      }
      return this.afterArchitect("final_verification_repair_plan_required");
    }
    const pending = generation.plan.checks.find(
      (planned) => !generation.completedChecks?.some(
        (completed) => completed.category === planned.category,
      ),
    );
    if (pending) {
      if (!this.finalVerificationDriver) {
        throw new Error("Final verification execution requires a FinalVerificationCheckDriver.");
      }
      let result: FinalVerificationCheckExecution;
      const signal = this.activeLifecycleSignal();
      try {
        result = await this.finalVerificationDriver.executeCheck({
          runId: this.runId,
          taskId: generation.taskId,
          generationId: generation.generationId,
          targetRevision: generation.targetRevision,
          attempt: 1,
          plan: generation.plan,
          category: pending.category,
          executionProfile: generation.executionProfile,
          signal,
        });
        if (signal.aborted) {
          return {
            status: this.projection().status === "paused" ? "paused" : "progressed",
            action: "final_verification_interrupted",
          };
        }
      } catch (error) {
        if (signal.aborted) {
          return {
            status: this.projection().status === "paused" ? "paused" : "progressed",
            action: "final_verification_interrupted",
          };
        }
        if (!this.isCurrentGeneration(generation)) {
          return { status: "progressed", action: "final_verification_invalidated" };
        }
        throw error;
      }
      if (!this.isCurrentGeneration(generation)) {
        return { status: "progressed", action: "final_verification_invalidated" };
      }
      if (result.check.category !== pending.category) {
        throw new Error(
          `Final verification driver returned ${result.check.category} for ${pending.category}.`,
        );
      }
      this.store.append({
        runId: this.runId,
        type: "final_verification.check_completed",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `${generation.generationId}:check:${pending.category}`,
        payload: {
          generationId: generation.generationId,
          taskId: generation.taskId,
          targetRevision: generation.targetRevision,
          attempt: 1,
          workspacePath: result.workspacePath,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          result: result.check,
        },
      });
      const status = this.projection().status === "paused" ? "paused" : "progressed";
      return {
        status,
        action: (await this.applyFailingCheckRepairCharge(result.check, {
          generationId: generation.generationId,
          taskId: generation.taskId,
          targetRevision: generation.targetRevision,
          plan: generation.plan,
          executionProfile: generation.executionProfile,
          attempt: 1,
          signal,
        })).green
          ? "final_verification_check_completed"
          : "final_verification_check_non_green",
      };
    }
    if (!this.evidenceStore) {
      throw new Error("Final verification submission requires an EvidenceStore.");
    }
    const completed = generation.completedChecks ?? [];
    const run: FinalVerificationRun = {
      generationId: generation.generationId,
      runId: this.runId,
      taskId: generation.taskId,
      attempt: 1,
      plan: generation.plan,
      executionProfile: generation.executionProfile,
      targetRevision: generation.targetRevision,
      workspacePath: completed[0]!.workspacePath,
      startedAt: completed[0]!.startedAt,
      finishedAt: completed.at(-1)!.finishedAt,
      checks: completed.map(({ attempt: _attempt, workspacePath: _workspacePath,
        startedAt: _startedAt, finishedAt: _finishedAt, ...check }) => check),
      green: true,
    };
    const submission = await submitFinalVerification(
      { plan: generation.plan, run },
      {
        evidenceStore: this.evidenceStore,
        artifacts: this.artifacts,
        currentIntegrationRevision: () => this.projection().integrationRevision ?? "",
        clock: this.clock,
      },
    );
    if (!this.isCurrentGeneration(generation)) {
      return { status: "progressed", action: "final_verification_invalidated" };
    }
    this.store.append({
      runId: this.runId,
      type: "final_verification.submitted",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `${generation.generationId}:submission`,
      payload: {
        generationId: generation.generationId,
        taskId: generation.taskId,
        targetRevision: generation.targetRevision,
        submissionId: `final-verification-submission:${generation.generationId}`,
        attempt: 1,
        submissionResult: submission,
      },
    });
    return { status: "progressed", action: "final_verification_submitted" };
  }

  private async advanceIndependentVerification(): Promise<BuildStepResult | undefined> {
    const driver = this.independentVerifier;
    if (!driver) return undefined;
    let projection = this.projection();
    const targetRevision = projection.integrationRevision;
    const finalVerification = projection.finalVerification?.current;
    if (!targetRevision || !finalVerification) {
      throw new Error("Independent verification requires a current integrated revision.");
    }
    const risk = projection.buildRisk?.current;
    if (
      !risk || risk.state !== "current" ||
      risk.targetRevision !== targetRevision
    ) {
      const assessed = await driver.assessRisk({ runId: this.runId, projection });
      const input: BuildRiskAssessmentInput = {
        ...assessed,
        stricterQualification:
          driver.alwaysRequireIndependentVerifier === true,
      };
      projection = this.projection();
      if (
        projection.integrationRevision !== targetRevision ||
        projection.finalVerification?.current?.generationId !==
          finalVerification.generationId
      ) {
        return { status: "progressed", action: "build_risk_assessment_invalidated" };
      }
      // FX-1: key the assessment by the final-verification generation it
      // qualifies, not just the revision. Guidance invalidates the current
      // assessment without moving the revision, and the green re-run lands a
      // new generation; a revision-only key dedupes the re-assessment into
      // the old event and the run spins on assessRisk forever. The
      // generation id is durable log state (history only grows), so replays
      // of the same step still dedupe and restarts record nothing new.
      // Pre-FX-1 logs carry `build-risk:${targetRevision}`; the reducer
      // never inspects the key, so they replay unchanged.
      this.store.append({
        runId: this.runId,
        type: "build.risk_assessed",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `build-risk:${targetRevision}:${finalVerification.generationId}`,
        payload: {
          targetRevision,
          input,
          assessment: assessBuildRisk(input),
        },
      });
      return { status: "progressed", action: "build_risk_assessed" };
    }
    if (risk.assessment.risk === "low") return undefined;

    const currentReview = projection.verifier?.current;
    if (
      currentReview?.status === "submitted" &&
      currentReview.verdict?.satisfied === true
    ) {
      return undefined;
    }
    if (
      currentReview?.status === "submitted" &&
      currentReview.verdict?.satisfied === false
    ) {
      if (currentReview.repairTaskIds?.length) return undefined;
      const pausedForRepair = this.pauseIfRepairCyclesExhausted(
        projection,
        "verifier",
        currentReview.targetRevision,
      );
      if (pausedForRepair) return pausedForRepair;
      const unsatisfiedCriteria = currentReview.verdict.criterionVerdicts
        .filter((criterion) => criterion.verdict === "unsatisfied")
        .map((criterion) => ({
          taskId: criterion.taskId,
          criterionId: criterion.criterionId,
          rationale: criterion.rationale,
          evidenceIds: [...criterion.evidenceIds],
        }));
      // T6b repair (R4-B1): this unsatisfied verdict is the next validation
      // of any dispatched verifier repair — durably fail consumed
      // approaches here so the next dispatch needs a new decision.
      this.markDispatchedApproachesFailedForMembers(
        this.repairMembers(unsatisfiedCriteria.map((criterion) => `verifier:${criterion.taskId}:${criterion.criterionId}`)),
        currentReview.reviewId,
      );
      const verifierDispatch = await this.prepareRepairDispatch(
        unsatisfiedCriteria.map((criterion) => `verifier:${criterion.taskId}:${criterion.criterionId}`),
        { taskId: finalVerification.taskId, evidenceIds: unsatisfiedCriteria.flatMap((criterion) => criterion.evidenceIds) },
      );
      if (verifierDispatch.paused) return verifierDispatch.paused;
      await this.runArchitect({
        type: "verifier_repair_plan_required",
        reviewId: currentReview.reviewId,
        targetRevision: currentReview.targetRevision,
        unsatisfiedCriteria,
      }, projection);
      const repaired = this.projection().verifier?.current;
      // T6b repair (B3): a pause recorded during the turn returns paused,
      // never throws.
      if (this.projection().status === "paused") {
        return { status: "paused", action: this.projection().pauseReason?.reason ?? "repair_issue_paused" };
      }
      if (
        repaired?.reviewId !== currentReview.reviewId ||
        !repaired.repairTaskIds?.length
      ) {
        throw new Error(
          "Architect returned from verifier_repair_plan_required without a typed action.",
        );
      }
      return this.afterArchitect("verifier_repair_plan_required");
    }

    this.recordingFailureContext = {
      ...(targetRevision ? { revision: targetRevision } : {}),
    };
    const result = await driver.verify({
      runId: this.runId,
      projection,
      risk,
      ...(projection.verifierSelection?.status === "selected" &&
          projection.verifierSelection.selectedRuntimeId
        ? { preferredRuntimeId: projection.verifierSelection.selectedRuntimeId }
        : {}),
      signal: this.activeLifecycleSignal(),
    });
    // T6b repair (R2-B6): the OA-17 cleanup search also runs after this
    // checkout-backed step (no-op for legacy runs).
    await this.recordCleanupSearch("verification");
    const afterVerification = this.projection();
    if (
      afterVerification.integrationRevision !== targetRevision ||
      afterVerification.finalVerification?.current?.generationId !==
        finalVerification.generationId ||
      afterVerification.buildRisk?.current?.targetRevision !== targetRevision ||
      Object.values(afterVerification.userGuidance).some(
        (guidance) => guidance.status === "submitted",
      )
    ) {
      return { status: "progressed", action: "verifier_invalidated" };
    }
    if (result.status === "verdict_submitted") {
      const durable = this.projection().verifier?.current;
      if (
        durable?.status !== "submitted" || !durable.verdict ||
        durable.targetRevision !== targetRevision
      ) {
        throw new Error(
          "Verifier returned before its revision-bound verdict was durable.",
        );
      }
      return { status: "progressed", action: "verifier_verdict_submitted" };
    }
    if (result.status === "suspended" && result.reason === "provider_error") {
      return { status: "progressed", action: "verifier_provider_failed" };
    }
    if (
      result.status === "suspended" && result.reason === "cancelled" &&
      this.projection().status === "paused"
    ) {
      return { status: "paused", action: "verifier_interrupted" };
    }
    const reason = result.status === "unavailable"
      ? result.reason
      : result.reason || "verifier_suspended";
    // FX-2 (N1): key a new selection requirement by the owner selection it
    // follows. After the owner selects, the same reason at the same revision
    // must record a NEW requirement: the old revision+reason key dedupes the
    // append, step() returns paused while the projection stays running with
    // selection "selected", and the run sits with no prompt. The recorded
    // selection count is durable log state that is stable on replay: 0 keeps
    // the old key shape so old logs replay unchanged. The reducer never
    // inspects the key.
    const verifierSelections = this.recordedVerifierSelections();
    const verifierSelectionKey = verifierSelections === 0
      ? `verifier-selection:${targetRevision}:${reason}`
      : `verifier-selection:${targetRevision}:${reason}:sel-${verifierSelections}`;
    this.store.append({
      runId: this.runId,
      type: "verifier.selection_required",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: verifierSelectionKey,
      payload: {
        reason,
        requiredCapabilities: ["code"],
        candidateRuntimeIds: [...driver.candidateRuntimeIds],
      },
    });
    return { status: "paused", action: "verifier_selection_required" };
  }

  /**
   * FX-2 (N1): the occurrence a verifier-selection requirement follows --
   * the number of recorded owner selections. Durable log state, so a replay
   * of the same step computes the same count and still dedupes, and a
   * restart records nothing new.
   */
  private recordedVerifierSelections(): number {
    return this.store.readRun(this.runId).filter(
      (event) => event.type === "verifier.selection_selected",
    ).length;
  }

  private async advanceFinalVerificationCleanup(
    generation: NonNullable<SchedulerProjection["finalVerification"]>["current"] & {},
  ): Promise<BuildStepResult> {
    if (!this.finalVerificationCleanupDriver) {
      throw new Error("Final verification cleanup requires an exact-owned cleanup driver.");
    }
    let cleanup = generation.cleanup;
    if (!cleanup || cleanup.status === "failed") {
      const attempt = (cleanup?.attempt ?? 0) + 1;
      this.store.append({
        runId: this.runId,
        type: "final_verification.cleanup_started",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `${generation.generationId}:cleanup:${attempt}:started`,
        payload: {
          generationId: generation.generationId,
          taskId: generation.taskId,
          targetRevision: generation.targetRevision,
          attempt,
        },
      });
      cleanup = this.projection().finalVerification?.current?.cleanup;
    }
    if (!cleanup || cleanup.status !== "started") {
      throw new Error("Final verification cleanup start was not durably recorded.");
    }
    try {
      const result = await this.finalVerificationCleanupDriver.cleanup({
        runId: this.runId,
        generationId: generation.generationId,
        taskId: generation.taskId,
        targetRevision: generation.targetRevision,
        attempt: cleanup.attempt,
        ...(generation.failure ? {
          failed: {
            generationId: generation.generationId,
            taskId: generation.taskId,
            targetRevision: generation.targetRevision,
            checks: [...(generation.completedChecks ?? [])],
            evidenceReferences: [...generation.failure.evidenceIds],
            logs: (generation.completedChecks ?? [])
              .filter((check) => !check.green)
              .flatMap((check) => check.issues),
          },
        } : {}),
      });
      if (!this.isCurrentGeneration(generation)) {
        return { status: "progressed", action: "final_verification_invalidated" };
      }
      this.store.append({
        runId: this.runId,
        type: "final_verification.cleanup_succeeded",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `${generation.generationId}:cleanup:${cleanup.attempt}:succeeded`,
        payload: {
          generationId: generation.generationId,
          taskId: generation.taskId,
          targetRevision: generation.targetRevision,
          attempt: cleanup.attempt,
          ...(result.diagnosticsPath ? { diagnosticsPath: result.diagnosticsPath } : {}),
        },
      });
      return { status: "progressed", action: "final_verification_cleanup_succeeded" };
    } catch (error) {
      if (!this.isCurrentGeneration(generation)) {
        return { status: "progressed", action: "final_verification_invalidated" };
      }
      this.store.append({
        runId: this.runId,
        type: "final_verification.cleanup_failed",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `${generation.generationId}:cleanup:${cleanup.attempt}:failed`,
        payload: {
          generationId: generation.generationId,
          taskId: generation.taskId,
          targetRevision: generation.targetRevision,
          attempt: cleanup.attempt,
          error: boundedCleanupError(error),
        },
      });
      return { status: "idle", action: "final_verification_cleanup_failed" };
    }
  }

  private isCurrentGeneration(
    generation: NonNullable<SchedulerProjection["finalVerification"]>["current"] & {},
  ): boolean {
    const projection = this.projection();
    const current = projection.finalVerification?.current;
    return projection.integrationRevision === generation.targetRevision &&
      current?.generationId === generation.generationId &&
      current.targetRevision === generation.targetRevision;
  }

  private initializeRun(): void {
    const events = this.store.readRun(this.runId);
    const durable = events.filter((event) => event.type !== "project_docs.policy_configured");
    if (durable.length > 0) {
      const durableObjective = rebuildSchedulerProjection(events).initialObjective;
      if (
        durableObjective !== undefined &&
        this.initialObjective !== undefined &&
        durableObjective !== this.initialObjective
      ) {
        throw new Error(
          "The durable initial objective does not match the Build specification."
        );
      }
      return;
    }
    this.store.append({
      runId: this.runId,
      type: "run.initialized",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "run-initialized",
      payload: {
        ...(this.initialObjective !== undefined
          ? { objective: this.initialObjective }
          : {}),
      },
    });
  }

  private configureProjectDocsPolicy(): void {
    const events = this.store.readRun(this.runId);
    if (events.length > 0) return;
    this.store.append({
      runId: this.runId,
      type: "project_docs.policy_configured",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "project-docs-policy",
      payload: { version: 1 },
    });
  }

  private bindProjectDocCommit(
    tools: readonly NativeTool<unknown>[],
  ): NativeTool<unknown>[] {
    if (!this.projectDocs) return [...tools];
    return tools.map((tool) => {
      if (tool.definition.name !== "write_project_doc") return tool;
      return {
        definition: tool.definition,
        validate: (input: unknown) => tool.validate(input),
        ...(tool.assessAccess
          ? { assessAccess: (input: unknown, context: ToolExecutionContext) => tool.assessAccess!(input, context) }
          : {}),
        execute: async (input: unknown, context: ToolExecutionContext) => {
          const output = await tool.execute(input, context);
          if (output.isError) return output;
          await this.commitRequestedProjectDoc(input);
          return output;
        },
      };
    });
  }

  private async commitRequestedProjectDoc(input: unknown): Promise<void> {
    if (!this.projectDocs) return;
    if (!isProjectDocToolInput(input)) {
      throw new Error("Project document commit input is invalid.");
    }
    const events = this.store.readRun(this.runId);
    const requested = [...events].reverse().find((event) =>
      event.type === "project_doc.requested" && event.payload.path === input.path
    );
    const requestId = requested?.payload.requestId;
    if (!requested || typeof requestId !== "string") {
      throw new Error("Project document request was not recorded.");
    }
    if (events.some((event) =>
      event.type === "project_doc.committed" && event.payload.requestId === requestId
    )) {
      return;
    }
    const result = await this.projectDocs.commit({
      writes: [{ path: input.path, content: input.content }],
      summary: input.summary,
      runId: this.runId,
      requestId,
    });
    this.appendProjectDocCommitted(requestId, input.path, result);
  }

  /**
   * C2a: after `project.handoff_requested` on a docs-v2 run that is not
   * answered, the kernel renders the C1 snapshot and commits
   * docs/project/STATE.md through the handoff port, then records
   * `project_docs.handoff_snapshot_committed`. No model call. A failed
   * attempt pauses with `handoff_snapshot_failed` and retries on resume; a
   * commit already found by its snapshot key is reused, never duplicated.
   *
   * C2a repair: the snapshot renders from the projection rebuilt from
   * the events up to and including the stop event (B4/M5), so a later
   * pause never enters STATE.md; the event and the file describe the
   * same revision (M2); the recorded digest is read back from the
   * commit's own tree (B4); the failure pause key is per attempt (B3)
   * with the bounded cause in its detail (M4). Called from
   * `afterArchitect` (the same step that records the stop) and from the
   * top of `dispatchStep` (resume retries and crash recovery).
   *
   * C2b: the same commit also carries the static v2 AGENTS.md section and
   * the marked `@AGENTS.md` line (AR-R04, spliced, never overwritten),
   * the verbatim spec copy when due (CD-5), and the hand-edit notice line
   * when the tip STATE.md was edited outside AIBoard (AR-R07). With
   * `handoffFiles: "export_only"` nothing is written at any stop.
   */
  private async maybeCommitHandoffSnapshot(
    projection: SchedulerProjection,
  ): Promise<BuildStepResult | undefined> {
    if (projection.projectDocsPolicyVersion !== 2) return undefined;
    if (isAnsweredRun(projection)) return undefined;
    if (projection.projectHandoff?.status !== "requested") return undefined;
    // C2b (CD-5): `export_only` writes no handoff file at any stop; the
    // recorded run option satisfies the AR-R05 gate on its own.
    if (handoffFilesOf(projection) !== "commit") return undefined;
    const events = this.store.readRun(this.runId);
    const stop = [...events].reverse().find((event) => event.type === "project.handoff_requested");
    if (!stop) return undefined;
    const stopSequence = stop.sequence;
    if ((projection.projectDocs?.snapshots ?? []).some((record) => record.stopSequence === stopSequence)) {
      return undefined;
    }
    // C2b repair B1: a kernel commit that landed but was never recorded (a
    // read failure after the commit, or a crash before the append) still
    // belongs to the chain once its stop is withdrawn. Record every
    // withdrawn stop's landed commit as history BEFORE the next stop
    // commits, so the new snapshot continues the documents instead of
    // breaking them.
    // C2b repair B2: reconciliation runs before the current stop commits,
    // and a withdrawn stop that cannot be classified fails closed -- the
    // current stop pauses with the reconciliation failure named, and the
    // next resume retries. The chain never breaks on a transient error.
    let lastSequence = events[events.length - 1]!.sequence;
    let reconciled = false;
    try {
      reconciled = await this.reconcileWithdrawnSnapshotCommits(projection, stopSequence);
    } catch (error) {
      return this.pauseForHandoffSnapshotFailure(stopSequence, lastSequence, error);
    }
    if (reconciled) {
      const fresh = this.store.readRun(this.runId);
      lastSequence = fresh[fresh.length - 1]!.sequence;
    }
    const stopProjection = rebuildSchedulerProjection(events.filter((event) => event.sequence <= stopSequence));
    const stopKind = stopProjection.runPolicy === "plan_only" ? "plan_only" : "completed";
    // C2b repair CD-14 (N6): a docs-v2 run without a plan revision hands
    // off the integration revision, or the recorded baseline when even that
    // is absent (legacy planning, no integration revision yet) -- never an
    // endless snapshot-failure pause. The pause below stays as fail-closed
    // fallback for ports without the baseline lookup.
    const revision = await this.handedOffRevision(stopProjection);
    if (!revision.trim()) {
      return this.pauseForHandoffSnapshotFailure(stopSequence, lastSequence, "no handed-off revision recorded at the stop");
    }
    if (!this.projectDocs) {
      return this.pauseForHandoffSnapshotFailure(stopSequence, lastSequence, "the project document port is unavailable");
    }
    const port = this.projectDocs;
    // C2b (AR-R07): hand-edit detection reads STATE.md from the integration
    // tip COMMIT (blob bytes, not the working tree). A tip file that exists
    // but fails the digest check -- or has no generated header, which also
    // fails the check -- was edited outside AIBoard and is named in the new
    // snapshot. No tip file means this is the first snapshot: not an edit.
    let previousSnapshotEdited = false;
    try {
      const tip = await port.readIntegrationTipFile({ path: "docs/project/STATE.md" });
      previousSnapshotEdited = tip.content !== null && !verifyHandoffSnapshotDigest(tip.content);
    } catch (error) {
      return this.pauseForHandoffSnapshotFailure(stopSequence, lastSequence, error);
    }
    // C2b (CD-5): the verbatim spec copy decision. The approved source's
    // bytes live in the artifact store under the manifest artifact digest;
    // the source is "already a repository file" exactly when a tracked file
    // at the integration tip hashes to the same digest (same-byte-length
    // blobs only). Opted out, missing bytes, a digest mismatch, or a
    // non-text source means no copy -- recorded, never a handoff failure.
    let specWrite: { path: string; content: string } | undefined;
    let specPath: string | undefined;
    let specCopySkipped: string | undefined;
    const manifest = stopProjection.planning === undefined
      ? undefined
      : stopProjection.planning.source.manifestsById[stopProjection.planning.source.currentManifestId];
    // C2b repair m4: every non-copy outcome records its bounded reason, and
    // a spec-copy failure never fails the snapshot commit -- the copy is
    // conditional, the snapshot is not.
    if (!specCopyOf(projection)) {
      specCopySkipped = "opted_out";
    } else if (manifest === undefined) {
      specCopySkipped = "no_manifest";
    } else {
      const specBytes = await this.readApprovedSourceBytes(manifest.artifactDigest);
      if (specBytes === null) {
        specCopySkipped = "missing_bytes";
      } else if (createHash("sha256").update(specBytes).digest("hex") !== manifest.artifactDigest) {
        specCopySkipped = "digest_mismatch";
      } else if (!manifest.mediaType.startsWith("text/")) {
        specCopySkipped = "non_text_source";
      } else if (manifest.encoding !== "utf-8") {
        specCopySkipped = "unsupported_encoding";
      } else {
        let existing: { path: string } | null = null;
        try {
          existing = await port.findTrackedFileWithDigest({
            digest: manifest.artifactDigest,
            byteLength: specBytes.byteLength,
          });
        } catch {
          specCopySkipped = "tracked_search_failed";
        }
        if (specCopySkipped === undefined) {
          if (existing !== null) {
            specPath = existing.path;
          } else {
            const stem = sanitizeSpecSourceId(manifest.sourceId, manifest.artifactDigest);
            if (stem === undefined) {
              specCopySkipped = "unusable_source_id";
            } else {
              // C2c (NF-4): the final spec path is decided BEFORE rendering
              // STATE.md, from the integration tip blobs -- never assumed.
              // The `spec:` line then names the real copy; a skip renders
              // "not recorded" (facts omit specPath) and the event omits it.
              const wantedText = specBytes.toString("utf8");
              const resolved = await this.resolveHandoffSpecCopyPath(
                `docs/project/specs/${stem}.md`,
                wantedText,
              );
              if ("skipped" in resolved) {
                specCopySkipped = resolved.skipped;
              } else if (resolved.written) {
                // C2c (NF-1 residual): the copy needs a worktree write and a
                // stage, so ask the port first. An unstageable path (a
                // gitignored specs directory) skips the copy here -- the
                // facts omit specPath and STATE.md renders "not recorded".
                // An unreadable answer defers to the stage-time truth (the
                // separate spec `git add` still drops it with write_failed).
                // C2c repair cycle 2 (m-2): a check error never fails open.
                // The copy is optional, so the path counts as not stageable:
                // STATE.md renders "not recorded" and the reason is recorded.
                // (m-4) an occupant reads back as path_occupied, every other
                // refusal as write_failed.
                let stageable = true;
                let unstageableReason: "path_occupied" | "write_failed" | undefined;
                try {
                  const answer = await port.canStageSpecPath({ path: resolved.path, content: wantedText });
                  stageable = answer.stageable;
                  unstageableReason = answer.unstageableReason;
                } catch {
                  stageable = false;
                  unstageableReason = undefined;
                }
                if (!stageable) {
                  specCopySkipped = unstageableReason === "path_occupied" ? "path_occupied" : "write_failed";
                } else {
                  specPath = resolved.path;
                  specWrite = { path: resolved.path, content: wantedText };
                }
              } else {
                specPath = resolved.path;
              }
            }
          }
        }
      }
    }
    const snapshotKey = `handoff-snapshot:${stopSequence}`;
    let body: string;
    try {
      body = renderHandoffSnapshot(handoffSnapshotInputFromProjection(stopProjection, {
        stopAt: stop.occurredAt,
        revision,
        ...(specPath !== undefined ? { specPath } : {}),
        ...(previousSnapshotEdited ? { previousSnapshotEdited: true as const } : {}),
      }));
    } catch (error) {
      return this.pauseForHandoffSnapshotFailure(stopSequence, lastSequence, error);
    }
    if (!verifyHandoffSnapshotDigest(body)) {
      return this.pauseForHandoffSnapshotFailure(stopSequence, lastSequence, "the rendered snapshot failed its digest check");
    }
    let result: ProjectDocCommitResult;
    try {
      result = await port.commitHandoffSnapshot({
        writes: [
          { path: "docs/project/STATE.md", content: body },
          { path: "AGENTS.md", content: V2_AGENTS_SECTION_BODY },
          { path: "CLAUDE.md", content: V2_CLAUDE_POINTER_LINE },
          ...(specWrite !== undefined ? [specWrite] : []),
        ],
        summary: `AIBoard handoff snapshot (${stopKind}) for run ${this.runId}`,
        runId: this.runId,
        snapshotKey,
      });
    } catch (error) {
      return this.pauseForHandoffSnapshotFailure(stopSequence, lastSequence, error);
    }
    // B4: the event describes the committed tree, never the fresh render:
    // read the file back from the commit (fresh or reused) and record
    // that digest with the commit's real paths.
    let stored: { content: string | null; paths: string[] };
    try {
      stored = await port.readHandoffSnapshotFile({ commit: result.commit, path: "docs/project/STATE.md" });
    } catch (error) {
      return this.pauseForHandoffSnapshotFailure(stopSequence, lastSequence, error);
    }
    // C2c repair cycle 2 (NB-1, NB-2, m-1, m-3, m-4): every recorded fact
    // about this commit -- fresh or reused -- comes from the ONE commit-tree
    // describer. The fresh path, the reuse path and the withdrawn-stop path
    // below share it, so no reuse layout needs its own patch. Stage-time
    // facts only confirm the tree, never replace it: a reused commit
    // carries none, and an uncorroborated stage-time reason (an out-of-band
    // junction the tree never held) records nothing, pausing fail-closed.
    // The AR-R05 gate accepts the recorded reason the way it accepts
    // export_only.
    const described = describeSnapshotCommitFacts({
      entryPoint: result.entryPoint,
      storedPaths: stored.paths,
      ...(result.dirLinks?.[0] !== undefined ? { commitStateLink: result.dirLinks[0] } : {}),
      // C2e repair cycle 1 (N-1): the blocker kind travels to the
      // recorded skip reason; absent keeps the legacy link wording.
      ...(result.stateBlockerKind !== undefined ? { commitStateBlockerKind: result.stateBlockerKind } : {}),
      ...(result.skipped !== undefined ? { stageSkipped: result.skipped } : {}),
      ...(result.redirected !== undefined ? { stageRedirected: result.redirected } : {}),
    });
    const stateChanged = described.stateChanged;
    const stateSkippedReason = described.stateSkippedReason;
    // A commit with no fresh STATE.md but a recorded link reason takes the
    // CD-17 path below (no digest to record); without a reason it still
    // fails closed exactly as before.
    let committedDigest = "";
    if (stateChanged || stateSkippedReason === undefined) {
      if (stored.content === null || !verifyHandoffSnapshotDigest(stored.content)) {
        return this.pauseForHandoffSnapshotFailure(
          stopSequence,
          lastSequence,
          stored.content === null
            ? `commit ${result.commit} holds no docs/project/STATE.md`
            : `commit ${result.commit} holds a STATE.md that failed its digest check`,
        );
      }
      committedDigest = /body_sha256: ([a-f0-9]{64})/.exec(stored.content.split("\n")[0] ?? "")?.[1] ?? "";
      if (!committedDigest) {
        return this.pauseForHandoffSnapshotFailure(stopSequence, lastSequence, "the committed snapshot carries no digest");
      }
      if (!stateChanged) {
        return this.pauseForHandoffSnapshotFailure(
          stopSequence,
          lastSequence,
          `commit ${result.commit} lists no docs/project/STATE.md path`,
        );
      }
    }
    // C2b (AR-R05): the full gate needs the v2 entry lines in the commit's
    // own tree. The entry-point facts above were read back from the commit
    // (never the checkout); a commit without them fails the snapshot like a
    // missing STATE.md -- recorded, never silently accepted.
    // C2b repair m5: a CLAUDE.md that links to AGENTS.md satisfies the line
    // through the link (recorded below); any other missing line still fails.
    // C2c (NF-2/CD-15, NF-3): each entry file is satisfied by the COMMIT
    // tree alone -- directly, through a link whose target blob holds the
    // section (the runner wrote it into the target path, recorded on the
    // redirect), or through the legacy CLAUDE.md-to-AGENTS.md link. A link
    // to anything else skips that entry file with a recorded reason, and
    // the gate accepts the reason when the commit tree corroborates the
    // link. Anything without commit-tree proof pauses fail-closed (U1, U2).
    // The entry facts come from the same describer above: on a reused
    // commit the M-6 omission and every skip are re-described from the
    // commit tree (BL-2/NB-1), so a retry that reuses a skip-layout commit
    // records it instead of pausing again on every resume. A reason is
    // accepted only with commit-tree corroboration
    // (handoffEntryFileStatus), so this cannot accept a commit the tree
    // does not prove.
    const entryStatus = handoffEntryFileStatus(result.entryPoint, {
      ...(described.agentsRedirect !== undefined ? { agentsRedirect: described.agentsRedirect } : {}),
      ...(described.agentsRedirectTarget !== undefined ? { agentsRedirectTarget: described.agentsRedirectTarget } : {}),
      ...(described.agentsSkip !== undefined ? { agentsSkip: described.agentsSkip } : {}),
      ...(described.claudeRedirect !== undefined ? { claudeRedirect: described.claudeRedirect } : {}),
      ...(described.claudeSkip !== undefined ? { claudeSkip: described.claudeSkip } : {}),
    });
    if (entryStatus === null) {
      return this.pauseForHandoffSnapshotFailure(
        stopSequence,
        lastSequence,
        `commit ${result.commit} lacks the v2 AGENTS.md section or the CLAUDE.md line`,
      );
    }
    const { agentsSectionCommitted, agentsSectionViaLink, claudeLineCommitted, claudeLineViaLink } = entryStatus;
    // C2b repair m2/m4: the event describes the committed tree. On a reused
    // commit the pre-commit reads are stale (the tip is the commit itself),
    // so previousSnapshotEdited comes from the notice line in the committed
    // STATE.md, and a spec copy is claimed only after the committed blob
    // hashes to the source digest.
    const commitClaim = await this.specCopyClaimFromCommit(
      result.commit,
      stored.paths,
      manifest?.artifactDigest,
    );
    // C2b repair N-1/N-2: the kernel reports an unstageable spec copy on
    // the commit result (never by failing the snapshot). A skipped spec
    // path surfaces as specCopySkipped -- write_failed, or path_occupied
    // when the kernel names it -- unless the committed tree proves the
    // copy after all (a reused commit staged on an earlier attempt).
    const stagedSpecSkip = (result.skipped ?? []).find((entry) => entry.path.startsWith("docs/project/specs/"));
    const stagedSpecSkipped = stagedSpecSkip === undefined
      ? undefined
      : stagedSpecSkip.reason.includes("(path_occupied)") ? "path_occupied" : "write_failed";
    // C2c (NF-4): the event omits specPath when no copy was written (its
    // field doc). A copy was attempted exactly when specWrite was set; when
    // the committed tree proves nothing, the copy never landed -- the
    // separate spec `git add` dropped it (NF-1) -- so the path stays out
    // while the skip reason is still recorded below.
    const eventSpecPath = commitClaim.specPath ?? (specWrite !== undefined ? undefined : specPath);
    const eventSpecCopySkipped = commitClaim.specCopied
      ? undefined
      : (commitClaim.specCopySkipped ?? stagedSpecSkipped ?? specCopySkipped);
    // C2e (m-7): a snapshot append the reducer refuses (any future
    // runtime/reducer disagreement) is a retryable pause with the
    // reducer's reason -- never a pump error. A resume retries the same
    // stop, reusing the landed commit by key.
    try {
      this.appendHandoffSnapshotCommitted({
        stopSequence,
        stopKind,
        revision,
        commit: result.commit,
        parent: result.parent,
        head: result.head,
        bodyDigest: committedDigest,
        paths: stored.paths,
      // C2c repair CD-17: with no fresh STATE.md there is no committed
      // notice line to read; the skip reason below carries the facts.
      previousSnapshotEdited: stateChanged && stored.content !== null
        ? stored.content.includes(PREVIOUS_SNAPSHOT_EDITED_NOTICE_LINE)
        : false,
      ...(eventSpecPath !== undefined ? { specPath: eventSpecPath } : {}),
      ...(commitClaim.specCopied ? { specCopied: true as const } : {}),
      ...(eventSpecCopySkipped !== undefined ? { specCopySkipped: eventSpecCopySkipped } : {}),
      ...(agentsSectionViaLink !== undefined ? { agentsSectionViaLink } : {}),
      ...(claudeLineViaLink !== undefined ? { claudeLineViaLink } : {}),
      ...(agentsSectionCommitted ? {} : { agentsSectionCommitted: false as const }),
      ...(claudeLineCommitted ? {} : { claudeLineCommitted: false as const }),
      ...(stateSkippedReason !== undefined ? { stateSkippedReason } : {}),
      });
    } catch (error) {
      return this.pauseForHandoffSnapshotFailure(stopSequence, lastSequence, error);
    }
    return { status: "paused", action: "handoff_snapshot_committed" };
  }

  /**
   * C2b (CD-5): the approved source's verbatim bytes from the artifact
   * store, or null when the store is not provisioned or the bytes are
   * missing. A missing artifact skips the spec copy; it never fails the
   * handoff (the copy is explicitly conditional).
   */
  private async readApprovedSourceBytes(artifactDigest: string): Promise<Buffer | null> {
    if (!this.artifacts) return null;
    try {
      return await this.artifacts.get(artifactDigest);
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) return null;
      throw error;
    }
  }

  /**
   * C2c (NF-4): the final spec-copy path, decided from the integration tip
   * blobs before STATE.md renders. Absent target: the copy lands there.
   * Target holding the wanted bytes: the tree already holds it, so no write
   * is needed and the line still names it. Target holding other bytes: the
   * copy moves to the digest-suffixed sibling (the same name the kernel
   * staging uses), unless that is taken too -- then the copy is skipped as
   * path_occupied. An unreadable tip skips the copy with a reason instead
   * of failing the snapshot (the copy is conditional, the snapshot is not).
   */
  private async resolveHandoffSpecCopyPath(
    target: string,
    wantedText: string,
  ): Promise<{ path: string; written: boolean } | { skipped: string }> {
    const port = this.projectDocs;
    if (!port) return { skipped: "spec_tip_unreadable" };
    let tip: { content: string | null };
    try {
      tip = await port.readIntegrationTipFile({ path: target });
    } catch {
      return { skipped: "spec_tip_unreadable" };
    }
    if (tip.content === null || tip.content === wantedText) {
      return { path: target, written: tip.content === null };
    }
    const sibling = target.replace(
      /\.md$/,
      `-${createHash("sha256").update(wantedText, "utf8").digest("hex").slice(0, 16)}.md`,
    );
    let siblingTip: { content: string | null };
    try {
      siblingTip = await port.readIntegrationTipFile({ path: sibling });
    } catch {
      return { skipped: "spec_tip_unreadable" };
    }
    if (siblingTip.content === null || siblingTip.content === wantedText) {
      return { path: sibling, written: siblingTip.content === null };
    }
    return { skipped: "path_occupied" };
  }

  /**
   * C2a repair (B3/M4): the failure pause key is per attempt (the log
   * sequence, like `answer-paused:`), so a second failure pauses again
   * and the next resume retries. The bounded, message-only cause travels
   * in the pause detail.
   */
  /**
   * C2b repair CD-14 (N6): the handed-off revision for a stop. A docs-v2
   * run without a plan revision uses the integration revision, or the
   * recorded baseline when even that is absent (legacy planning, no
   * integration revision yet). The baseline lookup is required on the
   * port (C2b repair B1-R), so this is empty only without a docs port;
   * the caller then pauses fail-closed.
   */
  private async handedOffRevision(stopProjection: SchedulerProjection): Promise<string> {
    const direct = stopProjection.integrationRevision
      ?? stopProjection.planning?.plan?.currentRevisionId
      ?? "";
    if (direct.trim()) return direct;
    const baseline = await this.projectDocs?.readIntegrationBaselineRevision();
    return baseline?.revision ?? "";
  }

  /**
   * C2b repair m4: the spec-copy claim for a committed snapshot. A specs
   * path in the commit whose blob hashes to the source digest was copied
   * by this snapshot; anything else is reported without the copy claim.
   * Blob read failures and digest mismatches skip the claim with a reason
   * instead of failing the snapshot. No commit specs path means this
   * helper claims nothing (the caller keeps its already-a-repo-file path).
   */
  private async specCopyClaimFromCommit(
    commit: string,
    commitPaths: string[],
    manifestDigest: string | undefined,
  ): Promise<{ specPath?: string; specCopied: boolean; specCopySkipped?: string }> {
    const commitSpecPath = commitPaths.find((path) => path.startsWith("docs/project/specs/") && path.endsWith(".md"));
    if (commitSpecPath === undefined || manifestDigest === undefined) return { specCopied: false };
    let blob: { content: string | null };
    try {
      blob = await this.projectDocs!.readHandoffSnapshotFile({ commit, path: commitSpecPath });
    } catch {
      return { specPath: commitSpecPath, specCopied: false, specCopySkipped: "spec_blob_unreadable" };
    }
    if (blob.content !== null && createHash("sha256").update(blob.content, "utf8").digest("hex") === manifestDigest) {
      return { specPath: commitSpecPath, specCopied: true };
    }
    return { specPath: commitSpecPath, specCopied: false, specCopySkipped: "commit_blob_mismatch" };
  }

  /**
   * C2b repair B1: record every withdrawn stop's landed commit as history
   * before the next stop commits. A kernel snapshot commit that landed but
   * whose event was never appended (a read failure after the commit, or a
   * crash before the append) is found by its stop key through the
   * lookup-only port method -- never by committing -- and appended as a
   * history event. The record moves the document tip but satisfies no later
   * gate (the gate binds to the latest request), so the next stop's
   * snapshot continues the chain.
   * C2b repair B2: fail closed. A withdrawn stop with no landed commit is
   * simply not there yet (skip), but a stop that cannot be classified -- a
   * lookup or read-back throw, an unreadable or entry-less commit, or
   * missing stop facts -- throws, and the caller pauses the current stop
   * before committing. Resume retries.
   */
  /**
   * C3a (AR-R08; packet C3 steps 1, 2 and 4): snapshot at every stop other
   * than handoff. Runs at the top of `dispatchStep` after C2's handoff
   * commit: when the run is stopped (paused, failed or stopped) and the
   * stop is not C2's handoff wait, render C1 with the stop kind and commit
   * STATE.md (plus the entry lines when missing) on the integration branch
   * through C2's kernel-commit method and event, with "no notes" (C3b adds
   * notes). Never blocks or changes the stop: skips record the CD-9/CD-5
   * reason durably, and a commit failure records a `commit_failed` finding
   * while the stop proceeds. Idempotent per stop event: a recorded stop is
   * never retried, so replay and resume create no duplicate commit.
   */
  private async maybeCommitStopSnapshot(projection: SchedulerProjection): Promise<void> {
    if (projection.projectDocsPolicyVersion !== 2) return;
    if (projection.status !== "paused" && projection.status !== "failed" && projection.status !== "stopped") return;
    // C2's stop owns the handoff wait: the handoff snapshot (or its retry
    // pause) already covers it, so C3a stands down while one is requested.
    if (projection.projectHandoff?.status === "requested") return;
    const events = this.store.readRun(this.runId);
    const stop = findCurrentStopEvent(events, projection);
    if (!stop) return;
    if (
      (projection.projectDocs?.snapshots ?? []).some((record) => record.stopSequence === stop.sequence) ||
      (projection.projectDocs?.stopSnapshotSkips ?? []).some((record) => record.stopSequence === stop.sequence)
    ) {
      return;
    }
    const stopProjection = rebuildSchedulerProjection(events.filter((event) => event.sequence <= stop.sequence));
    const classified = classifyStopSnapshot({
      status: stopProjection.status === "failed" ? "failed" : stopProjection.status === "stopped" ? "stopped" : "paused",
      ...(stopProjection.pauseReason?.reason !== undefined ? { reason: stopProjection.pauseReason.reason } : {}),
      ...(stopProjection.pauseReason?.detail !== undefined ? { detail: stopProjection.pauseReason.detail } : {}),
      ownerInitiated: stop.actor.role === "user",
    });
    // Skip rule (CD-9, CD-5): no snapshot before the triage decision
    // `build`, while a `clarify` triage is pending, on an answered run,
    // with `handoffFiles: "export_only"`, or for C2's own
    // `handoff_snapshot_failed` pause (C2 retries that commit itself).
    // Decided on the stop projection, so a pause during triage stays
    // skipped after the run is answered.
    const triage = stopProjection.planningTriageDecision;
    const skipReason = triage !== "build"
      ? triage === "clarify" ? "clarify_pending" : triage === "answer" ? "answered_run" : "pre_triage"
      : handoffFilesOf(stopProjection) !== "commit"
        ? "export_only"
        : stopProjection.pauseReason?.reason === "handoff_snapshot_failed"
          ? "handoff_snapshot_failed"
          : undefined;
    if (skipReason !== undefined) {
      this.appendStopSnapshotSkipped({ stopSequence: stop.sequence, stopKind: classified.stopKind, reason: skipReason });
      return;
    }
    try {
      await this.commitStopSnapshot({ stop, stopProjection, stopKind: classified.stopKind });
    } catch (error) {
      this.appendStopSnapshotSkipped({
        stopSequence: stop.sequence,
        stopKind: classified.stopKind,
        reason: `commit_failed: ${snapshotFailureDetail(error)}`,
      });
    }
  }

  /** C3a: one append for every stop without a snapshot commit (skip rule or commit failure). */
  private appendStopSnapshotSkipped(input: {
    stopSequence: number;
    stopKind: StopSnapshotStopKind;
    reason: string;
  }): void {
    this.store.append({
      runId: this.runId,
      type: "project_docs.stop_snapshot_skipped",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `stop-snapshot-skip:${input.stopSequence}:${input.reason}`,
      payload: {
        stopSequence: input.stopSequence,
        stopKind: input.stopKind,
        reason: input.reason,
      },
    });
  }

  /**
   * C3a: render the stop snapshot and commit it through C2's
   * kernel-commit method (`commitHandoffSnapshot`, idempotent per stop
   * key), then record it through C2's event. The entry-line writes ride
   * along so the commit keeps the v2 entry shape; the spec copy stays a
   * handoff-only concern. Throws with a bounded cause; the caller records
   * the finding and the stop proceeds.
   */
  private async commitStopSnapshot(input: {
    stop: SchedulerEvent;
    stopProjection: SchedulerProjection;
    stopKind: StopSnapshotStopKind;
  }): Promise<void> {
    const { stop, stopProjection, stopKind } = input;
    const stopSequence = stop.sequence;
    const revision = await this.handedOffRevision(stopProjection);
    if (!revision.trim()) {
      throw new Error("no handed-off revision recorded at the stop");
    }
    if (!this.projectDocs) {
      throw new Error("the project document port is unavailable");
    }
    const port = this.projectDocs;
    let previousSnapshotEdited = false;
    try {
      const tip = await port.readIntegrationTipFile({ path: "docs/project/STATE.md" });
      previousSnapshotEdited = tip.content !== null && !verifyHandoffSnapshotDigest(tip.content);
    } catch (error) {
      throw new Error(`stop snapshot tip read failed (${snapshotFailureDetail(error)})`);
    }
    const rendered = handoffSnapshotInputFromProjection(stopProjection, {
      stopAt: stop.occurredAt,
      revision,
      notesAbsentReason: STOP_SNAPSHOT_NO_NOTES_REASON,
      ...(previousSnapshotEdited ? { previousSnapshotEdited: true as const } : {}),
    });
    let body: string;
    try {
      body = renderHandoffSnapshot({ ...rendered, stopKind });
    } catch (error) {
      throw new Error(`stop snapshot render failed (${snapshotFailureDetail(error)})`);
    }
    if (!verifyHandoffSnapshotDigest(body)) {
      throw new Error("the rendered stop snapshot failed its digest check");
    }
    const snapshotKey = `stop-snapshot:${stopSequence}`;
    let result: ProjectDocCommitResult;
    try {
      result = await port.commitHandoffSnapshot({
        writes: [
          { path: "docs/project/STATE.md", content: body },
          { path: "AGENTS.md", content: V2_AGENTS_SECTION_BODY },
          { path: "CLAUDE.md", content: V2_CLAUDE_POINTER_LINE },
        ],
        summary: `AIBoard stop snapshot (${stopKind}) for run ${this.runId}`,
        runId: this.runId,
        snapshotKey,
      });
    } catch (error) {
      throw new Error(`stop snapshot commit failed (${snapshotFailureDetail(error)})`);
    }
    let stored: { content: string | null; paths: string[] };
    try {
      stored = await port.readHandoffSnapshotFile({ commit: result.commit, path: "docs/project/STATE.md" });
    } catch (error) {
      throw new Error(`stop snapshot read-back failed (${snapshotFailureDetail(error)})`);
    }
    const described = describeSnapshotCommitFacts({
      entryPoint: result.entryPoint,
      storedPaths: stored.paths,
      ...(result.dirLinks?.[0] !== undefined ? { commitStateLink: result.dirLinks[0] } : {}),
      ...(result.stateBlockerKind !== undefined ? { commitStateBlockerKind: result.stateBlockerKind } : {}),
      ...(result.skipped !== undefined ? { stageSkipped: result.skipped } : {}),
      ...(result.redirected !== undefined ? { stageRedirected: result.redirected } : {}),
    });
    const stateChanged = described.stateChanged;
    const stateSkippedReason = described.stateSkippedReason;
    let committedDigest = "";
    if (stateChanged || stateSkippedReason === undefined) {
      if (stored.content === null || !verifyHandoffSnapshotDigest(stored.content)) {
        throw new Error(stored.content === null
          ? `commit ${result.commit} holds no docs/project/STATE.md`
          : `commit ${result.commit} holds a STATE.md that failed its digest check`);
      }
      committedDigest = /body_sha256: ([a-f0-9]{64})/.exec(stored.content.split("\n")[0] ?? "")?.[1] ?? "";
      if (!committedDigest) {
        throw new Error("the committed stop snapshot carries no digest");
      }
      if (!stateChanged) {
        throw new Error(`commit ${result.commit} lists no docs/project/STATE.md path`);
      }
    }
    const entryStatus = handoffEntryFileStatus(result.entryPoint, {
      ...(described.agentsRedirect !== undefined ? { agentsRedirect: described.agentsRedirect } : {}),
      ...(described.agentsRedirectTarget !== undefined ? { agentsRedirectTarget: described.agentsRedirectTarget } : {}),
      ...(described.agentsSkip !== undefined ? { agentsSkip: described.agentsSkip } : {}),
      ...(described.claudeRedirect !== undefined ? { claudeRedirect: described.claudeRedirect } : {}),
      ...(described.claudeSkip !== undefined ? { claudeSkip: described.claudeSkip } : {}),
    });
    if (entryStatus === null) {
      throw new Error(`commit ${result.commit} lacks the v2 AGENTS.md section or the CLAUDE.md line`);
    }
    this.appendHandoffSnapshotCommitted({
      stopSequence,
      stopKind,
      revision,
      commit: result.commit,
      parent: result.parent,
      head: result.head,
      bodyDigest: committedDigest,
      paths: stored.paths,
      previousSnapshotEdited: stateChanged && stored.content !== null
        ? stored.content.includes(PREVIOUS_SNAPSHOT_EDITED_NOTICE_LINE)
        : false,
      ...(entryStatus.agentsSectionViaLink !== undefined ? { agentsSectionViaLink: entryStatus.agentsSectionViaLink } : {}),
      ...(entryStatus.claudeLineViaLink !== undefined ? { claudeLineViaLink: entryStatus.claudeLineViaLink } : {}),
      ...(entryStatus.agentsSectionCommitted ? {} : { agentsSectionCommitted: false as const }),
      ...(entryStatus.claudeLineCommitted ? {} : { claudeLineCommitted: false as const }),
      ...(stateSkippedReason !== undefined ? { stateSkippedReason } : {}),
    });
  }

  private async reconcileWithdrawnSnapshotCommits(
    projection: SchedulerProjection,
    currentStopSequence: number,
  ): Promise<boolean> {
    const port = this.projectDocs;
    if (!port) return false;
    const recorded = new Set(
      (projection.projectDocs?.snapshots ?? []).map((record) => record.stopSequence),
    );
    let appended = false;
    for (const handoff of projection.projectHandoffHistory ?? []) {
      const stopSequence = handoff.requestedSequence;
      if (stopSequence === undefined || stopSequence === currentStopSequence || recorded.has(stopSequence)) continue;
      let found: ProjectDocCommitResult | null;
      try {
        found = await port.findHandoffSnapshotCommit({ snapshotKey: `handoff-snapshot:${stopSequence}` });
      } catch (error) {
        throw new Error(`withdrawn-stop reconciliation failed for stop ${stopSequence}: lookup threw (${snapshotFailureDetail(error)}).`);
      }
      if (!found) continue;
      let stored: { content: string | null; paths: string[] };
      try {
        stored = await port.readHandoffSnapshotFile({ commit: found.commit, path: "docs/project/STATE.md" });
      } catch (error) {
        throw new Error(`withdrawn-stop reconciliation failed for stop ${stopSequence}: read-back threw (${snapshotFailureDetail(error)}).`);
      }
      // C2c repair cycle 2: a withdrawn commit is described by the same ONE
      // describer as the current stop -- a withdrawn commit with no fresh
      // STATE.md is history with a recorded link reason instead of a
      // failure, so the current stop never wedges on it. History only: the
      // gate still binds to the latest request, so this never satisfies a
      // later gate.
      // C2e (m-4): a withdrawn commit carries the fresh-worded entry skips
      // the port re-derived from its own tree, so the history record uses
      // the same wording a fresh commit of the same layout records.
      const withdrawnDescribed = describeSnapshotCommitFacts({
        entryPoint: found.entryPoint,
        storedPaths: stored.paths,
        ...(found.dirLinks?.[0] !== undefined ? { commitStateLink: found.dirLinks[0] } : {}),
        // C2e repair cycle 1 (N-1): same kind pass-through as the
        // current-stop path above.
        ...(found.stateBlockerKind !== undefined ? { commitStateBlockerKind: found.stateBlockerKind } : {}),
        ...(found.skipped !== undefined ? { stageSkipped: found.skipped } : {}),
      });
      const withdrawnStateChanged = withdrawnDescribed.stateChanged;
      const withdrawnStateSkipped = withdrawnDescribed.stateSkippedReason;
      let withdrawnDigest = "";
      if (withdrawnStateChanged || withdrawnStateSkipped === undefined) {
        if (stored.content === null || !verifyHandoffSnapshotDigest(stored.content)) {
          throw new Error(`withdrawn-stop reconciliation failed for stop ${stopSequence}: commit ${found.commit} holds no verifiable STATE.md.`);
        }
        withdrawnDigest = /body_sha256: ([a-f0-9]{64})/.exec(stored.content.split("\n")[0] ?? "")?.[1] ?? "";
        if (!withdrawnDigest || !withdrawnStateChanged) {
          throw new Error(`withdrawn-stop reconciliation failed for stop ${stopSequence}: commit ${found.commit} cannot be recorded.`);
        }
      }
      // The lookup path carries no staging decisions, so every entry fact
      // comes from the same describer (link-to-elsewhere skips and the M-6
      // omission re-described from the commit tree). History only: the gate
      // still binds to the latest request, so this never satisfies a later
      // gate.
      const withdrawnStatus = handoffEntryFileStatus(found.entryPoint, {
        ...(withdrawnDescribed.agentsRedirect !== undefined ? { agentsRedirect: withdrawnDescribed.agentsRedirect } : {}),
        ...(withdrawnDescribed.agentsRedirectTarget !== undefined ? { agentsRedirectTarget: withdrawnDescribed.agentsRedirectTarget } : {}),
        ...(withdrawnDescribed.agentsSkip !== undefined ? { agentsSkip: withdrawnDescribed.agentsSkip } : {}),
        ...(withdrawnDescribed.claudeRedirect !== undefined ? { claudeRedirect: withdrawnDescribed.claudeRedirect } : {}),
        ...(withdrawnDescribed.claudeSkip !== undefined ? { claudeSkip: withdrawnDescribed.claudeSkip } : {}),
      });
      if (withdrawnStatus === null) {
        throw new Error(`withdrawn-stop reconciliation failed for stop ${stopSequence}: commit ${found.commit} lacks the v2 entry lines.`);
      }
      const facts = await this.withdrawnStopFacts(stopSequence);
      if (!facts) {
        throw new Error(`withdrawn-stop reconciliation failed for stop ${stopSequence}: no handed-off revision recorded at the stop.`);
      }
      const claim = await this.specCopyClaimFromCommit(found.commit, stored.paths, facts.manifestDigest);
      this.appendHandoffSnapshotCommitted({
        stopSequence,
        stopKind: facts.stopKind,
        revision: facts.revision,
        commit: found.commit,
        parent: found.parent,
        head: found.head,
        bodyDigest: withdrawnDigest,
        paths: stored.paths,
        previousSnapshotEdited: withdrawnStateChanged && stored.content !== null
          ? stored.content.includes(PREVIOUS_SNAPSHOT_EDITED_NOTICE_LINE)
          : false,
        ...(claim.specPath !== undefined ? { specPath: claim.specPath } : {}),
        ...(claim.specCopied ? { specCopied: true as const } : {}),
        ...(claim.specCopied || claim.specCopySkipped === undefined ? {} : { specCopySkipped: claim.specCopySkipped }),
        ...(withdrawnStatus.agentsSectionViaLink !== undefined ? { agentsSectionViaLink: withdrawnStatus.agentsSectionViaLink } : {}),
        ...(withdrawnStatus.claudeLineViaLink !== undefined ? { claudeLineViaLink: withdrawnStatus.claudeLineViaLink } : {}),
        ...(withdrawnStatus.agentsSectionCommitted ? {} : { agentsSectionCommitted: false as const }),
        ...(withdrawnStatus.claudeLineCommitted ? {} : { claudeLineCommitted: false as const }),
        ...(withdrawnStateSkipped !== undefined ? { stateSkippedReason: withdrawnStateSkipped } : {}),
      });
      recorded.add(stopSequence);
      appended = true;
    }
    return appended;
  }

  /** Stop facts for a withdrawn stop's history record: its own kind and handed-off revision. */
  private async withdrawnStopFacts(
    stopSequence: number,
  ): Promise<{ stopKind: string; revision: string; manifestDigest?: string } | null> {
    const events = this.store.readRun(this.runId);
    const stopProjection = rebuildSchedulerProjection(events.filter((event) => event.sequence <= stopSequence));
    const stopKind = stopProjection.runPolicy === "plan_only" ? "plan_only" : "completed";
    const revision = await this.handedOffRevision(stopProjection);
    if (!revision.trim()) return null;
    const manifest = stopProjection.planning === undefined
      ? undefined
      : stopProjection.planning.source.manifestsById[stopProjection.planning.source.currentManifestId];
    return { stopKind, revision, ...(manifest !== undefined ? { manifestDigest: manifest.artifactDigest } : {}) };
  }

  /** One append for every recorded handoff snapshot: current stop or withdrawn-stop history. */
  private appendHandoffSnapshotCommitted(input: {
    stopSequence: number;
    stopKind: string;
    revision: string;
    commit: string;
    parent: string;
    head: string;
    /**
     * The committed STATE.md body digest (C2c repair CD-17: "" when
     * stateSkippedReason carries the skip instead -- no STATE.md was
     * committed, so there is no digest to record).
     */
    bodyDigest: string;
    paths: string[];
    previousSnapshotEdited: boolean;
    specPath?: string;
    specCopied?: boolean;
    specCopySkipped?: string;
    agentsSectionCommitted?: boolean;
    agentsSectionViaLink?: string;
    claudeLineCommitted?: boolean;
    claudeLineViaLink?: string;
    /** C2c repair CD-17: why no STATE.md was committed (a linked directory above it). Absent means STATE.md committed. */
    stateSkippedReason?: string;
  }): void {
    this.store.append({
      runId: this.runId,
      type: "project_docs.handoff_snapshot_committed",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `handoff-snapshot:${input.stopSequence}`,
      payload: {
        stopSequence: input.stopSequence,
        stopKind: input.stopKind,
        revision: input.revision,
        commit: input.commit,
        parent: input.parent,
        head: input.head,
        bodyDigest: input.bodyDigest,
        paths: input.paths,
        previousSnapshotEdited: input.previousSnapshotEdited,
        agentsSectionCommitted: input.agentsSectionCommitted ?? true,
        claudeLineCommitted: input.claudeLineCommitted ?? true,
        ...(input.specPath !== undefined ? { specPath: input.specPath } : {}),
        ...(input.specCopied === true ? { specCopied: true as const } : {}),
        ...(input.specCopySkipped !== undefined ? { specCopySkipped: input.specCopySkipped } : {}),
        ...(input.agentsSectionViaLink !== undefined ? { agentsSectionViaLink: input.agentsSectionViaLink } : {}),
        ...(input.claudeLineViaLink !== undefined ? { claudeLineViaLink: input.claudeLineViaLink } : {}),
        ...(input.stateSkippedReason !== undefined ? { stateSkippedReason: input.stateSkippedReason } : {}),
      },
    });
  }

  private pauseForHandoffSnapshotFailure(stopSequence: number, lastSequence: number, cause: unknown): BuildStepResult {
    this.store.append({
      runId: this.runId,
      type: "run.paused",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `handoff-snapshot-failed:${stopSequence}:${lastSequence}`,
      payload: { reason: "handoff_snapshot_failed", detail: snapshotFailureDetail(cause) },
    });
    return { status: "paused", action: "handoff_snapshot_failed" };
  }

  private async recoverPendingProjectDocs(): Promise<void> {
    if (!this.projectDocs || !this.artifacts) return;
    const events = this.store.readRun(this.runId);
    const settled = new Set(
      events.flatMap((event) =>
        (event.type === "project_doc.committed" || event.type === "project_doc.abandoned") &&
        typeof event.payload.requestId === "string"
          ? [event.payload.requestId]
          : []
      ),
    );
    const pending = events.filter((event) =>
      event.type === "project_doc.requested" &&
      typeof event.payload.requestId === "string" &&
      !settled.has(event.payload.requestId)
    );
    for (const event of pending) {
      const requestId = event.payload.requestId;
      const path = event.payload.path;
      const summary = event.payload.summary;
      const hash = event.payload.contentArtifactHash;
      if (
        typeof requestId !== "string" ||
        typeof path !== "string" ||
        typeof summary !== "string" ||
        typeof hash !== "string"
      ) {
        throw new Error("Project document request is incomplete.");
      }
      if (projectDocSummaryRejected(summary)) {
        this.recordAbandonedProjectDoc(requestId, path);
        continue;
      }
      const bytes = await this.artifacts.get(hash);
      if (createHash("sha256").update(bytes).digest("hex") !== hash) {
        throw new Error(`Project document artifact ${hash} does not match its request.`);
      }
      try {
        const result = await this.projectDocs.commit({
          writes: [{ path, content: bytes.toString("utf8") }],
          summary,
          runId: this.runId,
          requestId,
        });
        this.appendProjectDocCommitted(requestId, path, result);
      } catch (error) {
        if (error instanceof Error && error.message === "Project document summary is invalid.") {
          this.recordAbandonedProjectDoc(requestId, path);
          continue;
        }
        throw error;
      }
    }
  }

  private recordAbandonedProjectDoc(requestId: string, path: string): void {
    this.store.append({
      runId: this.runId,
      type: "project_doc.abandoned",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `project-doc-abandoned:${requestId}`,
      payload: {
        requestId,
        path,
        reason: "Project document summary is invalid.",
      },
    });
  }

  private appendProjectDocCommitted(
    requestId: string,
    path: string,
    result: ProjectDocCommitResult,
  ): void {
    this.store.append({
      runId: this.runId,
      type: "project_doc.committed",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `project-doc-committed:${requestId}`,
      payload: {
        requestId,
        path,
        commit: result.commit,
        parent: result.parent,
        head: result.head,
        readme: result.entryPoint.readme,
        agentsMarkedSection: result.entryPoint.agentsMarkedSection,
        claudePointer: result.entryPoint.claudePointer,
      },
    });
  }

  private ensureInitialized(): void {
    this.initializeRun();
  }

  private rederiveContextRecordingSuspension(): void {
    const events = this.store.readRun(this.runId);
    if (events.length === 0) return;
    const waiver = rebuildSchedulerProjection(events).contextRecording?.waiver;
    if (waiver) suspendContextRecording(this.runId, waiver.rationale);
  }

  async resolveContextRecordingFailure(): Promise<"resumed" | "aborted" | "unresolved"> {
    const projection = this.projection();
    if (projection.status === "failed") return "aborted";
    const note = latestUnresolvedContextRecordingNote(projection);
    if (
      projection.status !== "paused" ||
      projection.pauseReason?.reason !== "context_recording_failed" ||
      !note
    ) {
      return "unresolved";
    }
    suspendContextRecording(this.runId, "context_recording_decision_turn");
    try {
      await this.runArchitect({
        type: "context_recording_decision_required",
        purpose: note.purpose,
        attempts: note.attempts,
        reason: note.reason,
        noteSequence: note.sequence,
        ...(note.taskId ? { taskId: note.taskId } : {}),
        ...(note.attempt !== undefined ? { attempt: note.attempt } : {}),
        ...(note.revision ? { revision: note.revision } : {}),
        retriesRemaining: contextRecordingRetriesRemaining(projection),
      }, projection);
    } catch (error) {
      if (!(error instanceof ContextManifestRecordingError)) throw error;
      if (this.projection().status === "failed") return "aborted";
      if (latestUnresolvedContextRecordingNote(this.projection())) return "unresolved";
    } finally {
      if (!this.projection().contextRecording?.waiver) {
        clearContextRecordingSuspension(this.runId);
      }
    }
    return this.finishContextRecordingResolution();
  }

  private finishContextRecordingResolution(): "resumed" | "aborted" | "unresolved" {
    const projection = this.projection();
    if (projection.status === "failed") return "aborted";
    const note = projection.contextRecording?.notes.at(-1);
    const resolution = note?.resolution;
    if (!resolution) return "unresolved";
    if (resolution.resolution === "abort") return "aborted";
    if (projection.status === "running") return "resumed";
    if (resolution.resolution === "proceed_without_manifest") {
      suspendContextRecording(this.runId, resolution.rationale ?? projection.contextRecording?.waiver?.rationale ?? "");
    }
    this.store.append({
      runId: this.runId,
      type: "run.resumed",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `context-recording-resumed:${note?.sequence ?? projection.lastSequence}`,
      payload: {},
    });
    return "resumed";
  }

  private recordContextRecordingFailure(error: ContextManifestRecordingError): void {
    const projection = this.projection();
    const details = this.recordingFailureContext;
    this.store.append({
      runId: this.runId,
      type: "context_manifest.recording_failed",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `context-recording-failed:${error.purpose}:${projection.lastSequence}`,
      payload: {
        purpose: error.purpose,
        attempts: error.attempts,
        reason: error.message,
        ...(details.taskId ? { taskId: details.taskId } : {}),
        ...(details.attempt !== undefined ? { attempt: details.attempt } : {}),
        ...(details.revision ? { revision: details.revision } : {}),
      },
    });
    const noted = this.projection();
    this.store.append({
      runId: this.runId,
      type: "run.paused",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `context-recording-paused:${noted.lastSequence}`,
      payload: {
        reason: "context_recording_failed",
        ...(details.taskId ? { taskId: details.taskId } : {}),
      },
    });
  }

  private async runArchitect(
    reason: ArchitectActionReason,
    projection: SchedulerProjection
  ): Promise<void> {
    this.recordingFailureContext = {
      ...("taskId" in reason && reason.taskId ? { taskId: reason.taskId } : {}),
      ...("attempt" in reason && typeof reason.attempt === "number" ? { attempt: reason.attempt } : {}),
      ...(projection.integrationRevision ? { revision: projection.integrationRevision } : {}),
    };
    const sequenceBefore = this.store.readRun(this.runId).at(-1)?.sequence ?? 0;
    const providerRetryDeadlineMs = this.providerRetryDeadlineMs?.();
    const tools = new ToolRegistry();
    const created = this.bindProjectDocCommit(createArchitectTools({
      store: this.store,
      clock: this.clock,
      runPolicy: this.runPolicy,
      planOnlyCompletionAvailable:
        this.runPolicy === "plan_only" &&
        reason.type === "completion_decision_required" &&
        (projection.planningPolicyVersion === 1
          // T9 (EP39): a plan_only run given a pure question is answered —
          // complete_run is offered on the answer path too. The tool still
          // enforces full completion readiness (answer plus the STATE.md gate).
          ? readyPlanIdentity(projection) !== undefined || isAnsweredRun(projection)
          : projection.planRevision > 0),
      finalVerificationPlanAvailable:
        reason.type === "final_verification_plan_required",
      finalVerificationReviewAvailable:
        reason.type === "final_verification_review_required",
      finalVerificationRepairPlanAvailable:
        reason.type === "final_verification_repair_plan_required",
      verifierRepairPlanAvailable:
        reason.type === "verifier_repair_plan_required",
      // T6b repair: the approach/blocker tools are non-terminal, so every
      // non-answer turn carries them; dispatch still needs a live decision.
      repairApproachAvailable: this.repairApproachAvailable,
      repairProjectId: this.projectId ?? this.runId,
      deliveryBoundaryResolutionAvailable:
        reason.type === "delivery_boundary_failed",
      planCritiqueResolutionAvailable:
        projection.planCritique?.current?.status === "submitted",
      architectAction: {
        reason,
        sequence: projection.lastSequence,
      },
      ...(projection.planningPolicyVersion === 1
        ? {
            planningTools: {
              ...(this.planningSourceReader
                ? { readSource: this.planningSourceReader }
                : {}),
            },
            // T9 (EP39): triage tools ride every new-policy turn; each tool
            // refuses when its decision does not apply.
            triageTools: true,
          }
        : {}),
      // T3a repair (B1b): in planning state the legacy plan/task tools are
      // not offered. False for legacy runs and once a plan is ready.
      ...(isPlanningState(projection) ? { planningState: true as const } : {}),
      // T9 (EP39): on the answer path no mutation lifecycle tool is offered.
      ...(isAnsweredRun(projection) ? { answerPath: true as const } : {}),
      // T9 repair cycle 1 (B3): a new-policy triage/answer/planning turn with
      // guidance pending also offers the acknowledgement, so the gate's
      // refusal is actionable in the same turn. Legacy turns are untouched.
      ...(reason.type === "plan_required" &&
        projection.planningPolicyVersion === 1 &&
        firstPendingUserGuidance(projection)
        ? { acknowledgeGuidanceAvailable: true as const }
        : {}),
      ...(this.finalVerificationProfileFor
        ? { finalVerificationProfileFor: this.finalVerificationProfileFor }
        : {}),
      ...(this.discardFinalVerificationProfile
        ? { discardFinalVerificationProfile: this.discardFinalVerificationProfile }
        : {}),
      ...(this.evidenceStore ? { evidenceStore: this.evidenceStore } : {}),
      ...(this.artifacts ? { artifacts: this.artifacts } : {}),
    }));
    const registered = this.architectLifecycleProbe
      ? this.architectLifecycleProbe(created)
      : created;
    // T9 (EP39): answer turns omit the mutation lifecycle tools by design,
    // so they require the answer-path core instead of the standard core.
    const standardTurn = this.runPolicy !== "plan_only" &&
      reason.type !== "context_recording_decision_required" &&
      !isAnsweredRun(projection);
    const answerTurn = this.runPolicy !== "plan_only" &&
      reason.type !== "context_recording_decision_required" &&
      isAnsweredRun(projection);
    assertArchitectLifecycleRegistration(
      registered.map((tool) => tool.definition.name),
      standardTurn,
      this.store,
      this.clock,
      answerTurn ? ANSWER_PATH_LIFECYCLE_TOOLS : undefined,
    );
    for (const tool of registered) {
      tools.register(tool);
    }
    await this.architectDriver.run({
      runId: this.runId,
      reason,
      projection,
      tools,
      ...(providerRetryDeadlineMs !== undefined
        ? { providerRetryDeadlineMs }
        : {}),
      context: {
        runId: this.runId,
        sessionId: `architect:${this.runId}`,
        actor: { role: "architect", id: this.architectId },
        signal: this.activeLifecycleSignal(true),
      },
    });
    const sequenceAfter = this.store.readRun(this.runId).at(-1)?.sequence ?? 0;
    if (sequenceAfter <= sequenceBefore) {
      throw new Error(
        `Architect returned from ${reason.type} without a typed action.`
      );
    }
  }

  private async resumeArchitectQuestion(questionId: string): Promise<BuildStepResult> {
    let events = this.store.readRun(this.runId);
    let projection = rebuildSchedulerProjection(events);
    let question = projection.architectQuestions[questionId];
    if (
      !question ||
      question.status !== "answered" ||
      !question.checkpoint ||
      (question.resumeStatus !== "pending" && question.resumeStatus !== "started")
    ) {
      return { status: "idle" };
    }
    const checkpoint = question.checkpoint;
    let actionEvent = question.resumeStartedSequence === undefined
      ? undefined
      : firstMatchingArchitectActionEvent(
          events,
          question.resumeStartedSequence,
          checkpoint.reason
        );
    if (!actionEvent) {
      if (question.resumeStatus === "pending") {
        this.store.append({
          runId: this.runId,
          type: "architect.question_resume_started",
          occurredAt: this.clock(),
          actor: { role: "runner", id: "build-runtime" },
          idempotencyKey: `architect-question-resume-started:${question.questionId}:${question.version}`,
          payload: { questionId: question.questionId, expectedVersion: question.version },
        });
        events = this.store.readRun(this.runId);
        projection = rebuildSchedulerProjection(events);
        question = projection.architectQuestions[questionId];
      }
      const startedSequence = question.resumeStartedSequence;
      if (startedSequence === undefined) {
        throw new Error(`Architect question ${questionId} has no durable resume start.`);
      }
      await this.runArchitect(checkpoint.reason, projection);
      events = this.store.readRun(this.runId);
      actionEvent = firstMatchingArchitectActionEvent(
        events,
        startedSequence,
        checkpoint.reason
      );
      if (!actionEvent) {
        return { status: "progressed", action: "architect_question_interrupted" };
      }
    }
    this.store.append({
      runId: this.runId,
      type: "architect.question_resume_consumed",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `architect-question-resume-consumed:${question.questionId}:${question.version}`,
      payload: {
        questionId: question.questionId,
        expectedVersion: question.version,
        actionEventSequence: actionEvent.sequence,
      },
    });
    return this.afterArchitect("architect_question_resumed");
  }

  private activeLifecycleSignal(allowPendingGuidanceReset = false): AbortSignal {
    const projection = this.projection();
    if (
      this.lifecycleController.signal.aborted &&
      projection.status === "running" &&
      (allowPendingGuidanceReset || !firstPendingUserGuidance(projection))
    ) {
      this.lifecycleController = new AbortController();
    }
    return this.lifecycleController.signal;
  }

  /**
   * T6a: drive the mandatory deliverable review of the current submission.
   * The reviewer runtime writes every stage durably; a pass that cannot
   * finish pauses the run with a delivery-specific, owner-visible reason and
   * owner resume starts a new durable generation (no controller self-review).
   */
  private async advanceDeliveryReview(task: BuildTask): Promise<BuildStepResult> {
    if (!this.deliveryReview) {
      throw new Error("New-policy task review requires the mandatory deliverable reviewer.");
    }
    const providerRetryDeadlineMs = this.providerRetryDeadlineMs?.();
    let result: Awaited<ReturnType<DeliveryReviewDriver["review"]>>;
    try {
      result = await this.deliveryReview.review({
        runId: this.runId,
        taskId: task.id,
        signal: this.activeLifecycleSignal(),
        ...(providerRetryDeadlineMs !== undefined ? { providerRetryDeadlineMs } : {}),
      });
    } catch (error) {
      await this.recordCleanupSearch("verification");
      return this.pauseForDeliveryGate(task.id, "delivery_review_failed", error instanceof Error ? error.message : String(error));
    }
    // T6b repair (R2-B6): the OA-17 cleanup search also runs after this
    // checkout-backed step (no-op for legacy runs).
    await this.recordCleanupSearch("verification");
    if (result.status === "reviewed") {
      return { status: "progressed", action: "deliverable_review_recorded" };
    }
    return this.pauseForDeliveryGate(
      task.id,
      result.status === "suspended" ? `delivery_review_suspended:${result.reason}` : result.reason,
      result.status === "suspended" ? result.error : result.detail,
    );
  }

  /** The review_required reason carries what the deliverable review left open. */
  private reviewRequiredReason(task: BuildTask, projection: SchedulerProjection): ArchitectActionReason {
    const review = projection.planningPolicyVersion === 1
      ? currentSubmissionReview(projection.delivery, task)
      : undefined;
    return {
      type: "review_required",
      taskId: task.id,
      changeSetId: task.changeSetId!,
      ...(review
        ? {
            delivery: {
              reviewId: review.reviewId,
              openFindingIds: openBlockingFindings(review).map((finding) => finding.id),
              unverifiedClaimIds: unverifiedClaims(review).map((claim) => claim.claimId),
            },
          }
        : {}),
    };
  }

  /**
   * T6a (B3/B4): post-integration boundary checks and task acceptance.
   * A failed/unknown boundary keeps the task `integrated` (no illegal
   * transition), routes to the Architect once, and is never re-run on the same
   * revision without a state change. Returns undefined when nothing applies.
   */
  private async advanceDeliveryAcceptance(projection: SchedulerProjection): Promise<BuildStepResult | undefined> {
    if (projection.planningPolicyVersion !== 1) return undefined;
    const integrationRevision = projection.integrationRevision;
    if (!integrationRevision) return undefined;
    const pending = Object.values(projection.tasks)
      .filter((task) => task.kind !== "final_verification" && task.status === "integrated" && !projection.delivery?.taskAcceptances[task.id])
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const task of pending) {
      const action = deliveryBoundaryAction(
        projection.delivery,
        task.id,
        integrationRevision,
        (id) => projection.tasks[id]?.status,
      );
      if (action.type === "wait") continue;
      if (action.type === "accept") {
        const review = projection.delivery!.reviews[task.id]!;
        this.recordReviewOutcome(task.id, review);
        this.store.append({
          runId: this.runId,
          type: "task.acceptance_recorded",
          occurredAt: this.clock(),
          actor: { role: "runner", id: DELIVERY_ACCEPTANCE_RUNNER_ID },
          idempotencyKey: `delivery-acceptance:${task.id}:${action.boundary.boundaryId}`,
          payload: { taskId: task.id, reviewId: review.reviewId, boundaryId: action.boundary.boundaryId },
        });
        return { status: "progressed", action: "task_acceptance_recorded" };
      }
      if (action.type === "architect") {
        // T6b repair (R2-B2): open the member delivery-boundary issues
        // before the Architect turn, so resolve_delivery_boundary_failure
        // works through the tools. Exhaustion pauses instead.
        // T6b repair (R3-B1): the member key is per task and per failing
        // check (plus failing test ids when known) via the shared helper,
        // so unrelated tasks never share one budget.
        const failedBoundaryChecks = (action.boundary.checks ?? []).filter((check) => check.outcome !== "passed");
        const boundaryRootCauses = failedBoundaryChecks.length > 0
          ? failedBoundaryChecks.map((check) => deliveryBoundaryRootCause({ taskId: task.id, checkId: check.checkId, failingIds: check.report?.failingTestIds }))
          : [deliveryBoundaryRootCause({ taskId: task.id, checkId: action.boundary.boundaryId })];
        // T6b repair (R4-B1): this failed boundary is the next validation
        // of any dispatched boundary repair — durably fail consumed
        // approaches here so the next dispatch needs a new decision.
        this.markDispatchedApproachesFailedForMembers(
          this.repairMembers(boundaryRootCauses),
          `boundary:${action.boundary.boundaryId}`,
        );
        const boundaryDispatch = await this.prepareRepairDispatch(
          boundaryRootCauses,
          { taskId: task.id, evidenceIds: failedBoundaryChecks.flatMap((check) => check.evidenceIds ?? []) },
        );
        if (boundaryDispatch.paused) return boundaryDispatch.paused;
        await this.runArchitect({
          type: "delivery_boundary_failed",
          taskId: task.id,
          boundaryId: action.boundary.boundaryId,
          integrationRevision,
          resolutionGeneration: action.resolutionGeneration,
        }, this.projection());
        return this.afterArchitect("delivery_boundary_failed");
      }
      if (!this.deliveryBoundary) {
        throw new Error("New-policy task acceptance requires the integrated-boundary check driver.");
      }
      const generation = (projection.delivery?.boundaries[task.id]?.length ?? 0) + 1;
      const boundaryId = deliveryBoundaryId(task.id, generation);
      // N-R4-3: durably start the attempt before any command runs.
      const attempt = (projection.delivery?.boundaryStarts?.[boundaryId] ?? 0) + 1;
      this.store.append({
        runId: this.runId,
        type: "delivery.boundary_started",
        occurredAt: this.clock(),
        actor: { role: "runner", id: DELIVERY_ACCEPTANCE_RUNNER_ID },
        idempotencyKey: `delivery-boundary-start:${boundaryId}:${attempt}`,
        payload: { taskId: task.id, boundaryId, attempt, integrationRevision },
      });
      let outcome: Awaited<ReturnType<DeliveryBoundaryDriver["check"]>>;
      try {
        outcome = await this.deliveryBoundary.check({
          runId: this.runId,
          taskId: task.id,
          boundaryId,
          attempt,
          integrationRevision,
          signal: this.activeLifecycleSignal(),
        });
      } catch (error) {
        await this.recordCleanupSearch("verification");
        return this.pauseForDeliveryGate(task.id, "delivery_boundary_unavailable", error instanceof Error ? error.message : String(error));
      }
      this.store.append({
        runId: this.runId,
        type: "delivery.boundary_checked",
        occurredAt: this.clock(),
        actor: { role: "runner", id: DELIVERY_ACCEPTANCE_RUNNER_ID },
        idempotencyKey: `delivery-boundary:${boundaryId}`,
        payload: {
          taskId: task.id,
          boundaryId,
          generation,
          attempt,
          integrationRevision,
          executedScope: "full_test_script",
          changedFiles: [...outcome.changedFiles],
          selection: { rung: outcome.selection.rung, selectedTests: [...outcome.selection.selectedTests] },
          checks: outcome.checks.map((check) => ({ ...check, evidenceIds: [...check.evidenceIds] })),
          passed: outcome.checks.every((check) => check.outcome === "passed"),
        },
      });
      // T6b repair (R2-B6): the OA-17 cleanup search also runs after this
      // checkout-backed step (no-op for legacy runs).
      await this.recordCleanupSearch("verification");
      return { status: "progressed", action: "delivery_boundary_checked" };
    }
    return undefined;
  }

  /**
   * T6a (N4): phase acceptance is bound to the current plan revision and
   * re-evaluated on every pump step, so any relevant input change (a task
   * acceptance, a new boundary run, a new revision) is picked up.
   */
  private recordPhaseAcceptancesIfReady(projection: SchedulerProjection): BuildStepResult | undefined {
    if (projection.planningPolicyVersion !== 1) return undefined;
    const plan = projection.planning?.plan;
    const revision = plan?.revisionsById[plan.currentRevisionId];
    if (!revision || !readyPlanIdentity(projection)) return undefined;
    const taskStatuses = new Map(Object.entries(projection.tasks).map(([id, task]) => [id, task.status]));
    for (const phase of revision.phases) {
      if (projection.delivery?.phaseAcceptances[phaseAcceptanceKey(revision.revisionId, phase.id)]) continue;
      const evaluation = evaluatePhaseAcceptance({
        phase,
        requirements: revision.requirements,
        taskStatuses,
        state: projection.delivery,
        integrationRevision: projection.integrationRevision,
      });
      if (!evaluation.ready) continue;
      this.store.append({
        runId: this.runId,
        type: "phase.acceptance_recorded",
        occurredAt: this.clock(),
        actor: { role: "runner", id: DELIVERY_ACCEPTANCE_RUNNER_ID },
        idempotencyKey: `phase-acceptance:${revision.revisionId}:${phase.id}`,
        payload: {
          phaseId: phase.id,
          planRevisionId: revision.revisionId,
          taskAcceptanceRefs: evaluation.taskAcceptanceRefs,
          exitChecks: evaluation.exitChecks,
        },
      });
      return { status: "progressed", action: "phase_acceptance_recorded" };
    }
    return undefined;
  }

  private pauseForDeliveryGate(taskId: string, reason: string, detail?: string): BuildStepResult {
    this.store.append({
      runId: this.runId,
      type: "run.paused",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `delivery-paused:${taskId}:${reason}:${this.projection().lastSequence}`,
      payload: {
        reason: reason.startsWith("delivery_") ? reason : `delivery_${reason}`,
        taskId,
        ...(detail ? { detail } : {}),
      },
    });
    return { status: "paused", action: reason.startsWith("delivery_") ? reason : `delivery_${reason}` };
  }

  private async afterArchitect(action: string): Promise<BuildStepResult> {
    const events = this.store.readRun(this.runId);
    if (events.length === 0) {
      throw new Error(`Architect returned from ${action} without a typed action.`);
    }
    const projection = rebuildSchedulerProjection(events);
    // C2a repair (B1): commit the kernel snapshot in the same step that
    // recorded `project.handoff_requested`, before returning `paused` --
    // the production flow never takes another step from the handoff stop.
    const handoffSnapshot = await this.maybeCommitHandoffSnapshot(projection);
    if (handoffSnapshot) return handoffSnapshot;
    return projection.status === "completed"
      ? { status: "completed", action }
      : projection.status === "paused"
        ? { status: "paused", action }
        : { status: "progressed", action };
  }

  private configureRunPolicy(): void {
    const events = this.store.readRun(this.runId);
    if (events.length > 0) {
      const recovered = rebuildSchedulerProjection(events);
      if (recovered.runPolicy && recovered.runPolicy !== this.runPolicy) {
        throw new Error(
          `Scheduler run policy is already configured as ${recovered.runPolicy}.`
        );
      }
      if (recovered.runPolicy) {
        // C2b: the run policy is already recorded; the recorded values
        // govern. Re-appending would conflict on the payload shape (C2b
        // records the run options additively), so recovery records nothing.
        // A conflicting restamp is refused loudly instead of being ignored.
        if (
          this.specCopy !== specCopyOf(recovered) ||
          this.handoffFiles !== handoffFilesOf(recovered)
        ) {
          throw new Error("Scheduler run options conflict with the recorded run policy.");
        }
        return;
      }
    }
    this.store.append({
      runId: this.runId,
      type: "run.policy_configured",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "run-policy-configured",
      // C2b (CD-5): the run options are recorded durably in the run policy
      // (additive: logs written before C2b carry neither field and replay
      // with the defaults). The recorded values govern the run.
      payload: { runPolicy: this.runPolicy, specCopy: this.specCopy, handoffFiles: this.handoffFiles },
    });
  }

  private configureVerifierPolicy(): void {
    if (!this.independentVerifier || this.runPolicy === "plan_only") return;
    const expected = {
      mode: "risk_based" as const,
      candidateRuntimeIds: [...this.independentVerifier.candidateRuntimeIds],
      alwaysRequireIndependentVerifier:
        this.independentVerifier.alwaysRequireIndependentVerifier === true,
    };
    const recovered = this.projection().verifierPolicy;
    if (recovered) {
      if (
        recovered.mode !== expected.mode ||
        recovered.alwaysRequireIndependentVerifier !==
          expected.alwaysRequireIndependentVerifier ||
        recovered.candidateRuntimeIds.length !==
          expected.candidateRuntimeIds.length ||
        recovered.candidateRuntimeIds.some(
          (runtimeId, index) =>
            runtimeId !== expected.candidateRuntimeIds[index],
        )
      ) {
        throw new Error(
          "Scheduler independent verifier policy is already configured differently.",
        );
      }
      return;
    }
    this.store.append({
      runId: this.runId,
      type: "verifier.policy_configured",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "verifier-policy-configured",
      payload: {
        ...expected,
        twoPass: this.independentVerifier.twoPass === true,
      },
    });
  }

  private configureRepairPolicy(): void {
    const events = this.store.readRun(this.runId);
    if (events.some((event) => event.type === "repair.policy_configured")) return;
    if (events.some((event) => event.type === "plan.created")) return; // in-flight pre-P6.5 runs stay uncapped
    this.store.append({
      runId: this.runId,
      type: "repair.policy_configured",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "repair-policy",
      payload: { repairPlanLimit: this.repairPlanLimit, explicit: this.explicitRepairPlanLimit },
    });
  }

  private configurePlanCritiquePolicy(): void {
    const events = this.store.readRun(this.runId);
    if (events.some((event) => event.type === "plan_critique.policy_configured")) return;
    if (events.some((event) => event.type === "plan.created")) return;
    this.store.append({
      runId: this.runId,
      type: "plan_critique.policy_configured",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "plan-critique-policy",
      payload: { mode: this.planCritic?.mode ?? "off" },
    });
  }

  /**
   * T3b: drives an outstanding coverage review toward plan_ready. Returns a
   * step result when the coverage path owns this step, or undefined when the
   * Architect must act (nothing drafted, nothing requested, or blocking
   * findings/unread sections/readiness blockers to resolve — all visible in
   * planning-status). Legacy runs never reach here (planningPolicyVersion 1
   * only).
   *
   * Repair cycle 1 (B1): an unavailable gate for the current revision is
   * outstanding but retryable, never permanent. Each step re-attempts the
   * still-current review (selection re-checks provider cooldown timing, so a
   * cooled-down provider is picked up; one attempt per step, no busy loop).
   * When a reviewer is available the review proceeds and the gate clears
   * durably via the recorded derivation, delivery, own view, or verdict.
   * Repair cycle 2 (R2-1): a gate pauses the run with a durable,
   * owner-visible reason (the verifier selection_required mechanism) — never
   * a silent blocked while the run shows running. The owner's normal resume
   * re-drives the retry; resume also clears a terminal N6 exhaustion gate
   * and resets its count. A non-terminal suspension is transient progress
   * (the pump retries immediately); only exhaustion pauses.
   */
  private async advanceCoverageReview(projection: SchedulerProjection): Promise<BuildStepResult | undefined> {
    const planning = projection.planning;
    if (!planning?.plan || !planning.ledger) return undefined;
    const revisionId = planning.plan.currentRevisionId;
    const digest = planning.plan.currentDigest;
    const manifest = planning.source.manifestsById[planning.source.currentManifestId];
    const review = planning.coverageReview;
    const bound = review &&
        review.planRevisionId === revisionId &&
        review.planRevisionDigest === digest &&
        review.sourceReadManifestId === manifest.manifestId
      ? review
      : undefined;
    const unavailable = planning.coverageUnavailable;
    const gateForCurrent = unavailable &&
        unavailable.planRevisionId === revisionId &&
        unavailable.sourceManifestId === manifest.manifestId
      ? unavailable
      : undefined;
    // Terminal gates (N6 exhaustion) pause for the owner and never retry
    // on their own; the owner's resume clears them (see resumeInternal).
    // Every other gate for the current revision falls through to the retry
    // attempt below.
    if (gateForCurrent && (TERMINAL_COVERAGE_GATE_REASONS as readonly string[]).includes(gateForCurrent.reason)) {
      return this.pauseForCoverageGate(gateForCurrent.reviewId ?? "none", gateForCurrent.reason);
    }
    if (bound) {
      // T9 repair cycle 3 (B4-r3): a bound review requested at or before the
      // latest folded acknowledgement never saw the folded guidance. It goes
      // back to the Architect as plan_required — with the guidance in context
      // — instead of making the plan ready. The kernel refuses plan_ready on
      // the same condition; this is the pump mirror so the run visibly waits
      // for a planning turn and a new review instead of stalling or throwing.
      const folded = projection.latestFoldedIntoPlanningAck;
      if (folded) {
        const requestedSequence = planning.coverageRequests[bound.id]?.requestedSequence ?? 0;
        if (requestedSequence <= folded.sequence) return undefined;
      }
      // Blocking verdicts, blocking findings, or cumulative outstanding
      // blocking prior findings: the Architect resolves by revising
      // (planning-status shows them with text and rationale).
      if (coverageReviewHoldsReadiness(bound)) return undefined;
      if (
        bound.findings.some(
          (finding) => finding.severity === "blocking" && finding.disposition?.resolution !== "plan_reconciled",
        )
      ) {
        return undefined;
      }
      // Cumulative open blocking findings from earlier reviews (the same
      // shared helper as the reducer and status; retired excluded). The
      // bound review's own blocking findings were handled just above.
      {
        const outstanding = openBlockingCoverageFindings(planning).filter(
          (entry) => entry.reviewId !== bound.id,
        );
        if (outstanding.length > 0) return undefined;
      }
      // Full durable reads, mirroring the reducer pre-check (Architect fixes gaps).
      const reads = planning.sourceReadIndex[manifest.manifestId] ?? {};
      if (manifest.sections.some((section) => reads[section.id] !== section.digest)) return undefined;
      // N2: readiness blockers the runtime did not pre-check (revision
      // validation, requirement removal, host capabilities) hand control to
      // the Architect with the blocker text recorded as an explicit
      // outstanding gate (visible in planning-status) — never throw out of
      // the step. A later revision/request clears the gate.
      const readyAuthority = new SchedulerCoverageReviewAuthority(this.store);
      if (!this.planningHostCapabilities) {
        readyAuthority.recordUnavailable({
          runId: this.runId,
          reviewId: bound.id,
          reason: "plan_ready_blocked",
          detail: "No host capabilities provider is configured.",
          occurredAt: this.clock(),
        });
        return undefined;
      }
      const history = planning.plan.revisionHistoryIds;
      const priorRevisionId = history.length > 1 ? history[history.length - 2] : undefined;
      const hostCapabilities = this.planningHostCapabilities();
      // N-R2-1: the readiness pre-check builds from the ONE shared helper —
      // the same input (including amendment history) the reducer decides on.
      const readinessInput = coveragePlanReadinessInput(planning, priorRevisionId);
      const readiness = readinessInput
        ? computePlanReadiness({ ...readinessInput, hostCapabilities })
        : { ready: false, blockers: ["Plan readiness requires a plan, coverage review, and host capabilities."] };
      if (!readiness.ready) {
        readyAuthority.recordUnavailable({
          runId: this.runId,
          reviewId: bound.id,
          reason: "plan_ready_blocked",
          detail: readiness.blockers.join(" "),
          occurredAt: this.clock(),
        });
        return undefined;
      }
      try {
        readyAuthority.appendPlanReady({
          runId: this.runId,
          hostCapabilities,
          ...(priorRevisionId !== undefined ? { priorRevisionId } : {}),
          occurredAt: this.clock(),
        });
      } catch (error) {
        readyAuthority.recordUnavailable({
          runId: this.runId,
          reviewId: bound.id,
          reason: "plan_ready_blocked",
          detail: error instanceof Error ? error.message : String(error),
          occurredAt: this.clock(),
        });
        return undefined;
      }
      return { status: "progressed", action: "plan_ready" };
    }
    const request = Object.values(planning.coverageRequests).find(
      (candidate) =>
        candidate.planRevisionId === revisionId &&
        candidate.planRevisionDigest === digest &&
        candidate.sourceManifestId === manifest.manifestId,
    );
    if (!request) return undefined;
    const authority = new SchedulerCoverageReviewAuthority(this.store);
    if (!this.coverageReview) {
      authority.recordUnavailable({
        runId: this.runId,
        reviewId: request.reviewId,
        reason: "no_coverage_review_driver",
        occurredAt: this.clock(),
      });
      return this.pauseForCoverageGate(request.reviewId, "no_coverage_review_driver");
    }
    const revision = planning.plan.revisionsById[revisionId];
    const priorReview = request.priorReviewId === undefined
      ? undefined
      : [planning.coverageReview, ...planning.coverageReviewHistory]
        .find((candidate) => candidate?.id === request.priorReviewId);
    // N2: an unknown prior review hands control to the Architect (whose next
    // request clears the stale binding) instead of throwing out of the step.
    if (request.priorReviewId !== undefined && !priorReview) return undefined;
    const input: NativeCoverageReviewRequest = {
      runId: this.runId,
      reviewId: request.reviewId,
      architectRuntimeId: projection.runtime.architect.runtimeId ?? this.architectId,
      manifest,
      planRevision: revision,
      ledger: {
        id: planning.ledger.id,
        requirements: planning.ledger.requirements,
        phases: planning.ledger.phases,
      },
      objective: this.initialObjective ?? projection.initialObjective ?? "",
      guidance: Object.values(projection.userGuidance).map((guidance) => ({
        id: `${guidance.guidanceId}:v${guidance.version}`,
        text: guidance.text,
      })),
      ...(priorReview !== undefined ? { priorReview } : {}),
      signal: this.activeLifecycleSignal(),
    };
    const result = await this.coverageReview.review(input);
    if (result.status === "reviewed") return { status: "progressed", action: "coverage_review_recorded" };
    if (result.status === "unavailable") return this.pauseForCoverageGate(request.reviewId, result.reason);
    // A suspension is transient progress: the pump retries with a fresh
    // attempt on the next step. On N6 exhaustion record an explicit
    // outstanding gate for the owner and pause instead of looping.
    if (result.status === "suspended" && result.reason === "cancelled" && this.projection().status === "paused") {
      return { status: "paused", action: "coverage_review_suspended" };
    }
    const suspended = authority.recordSuspended({
      runId: this.runId,
      reviewId: request.reviewId,
      reason: result.reason,
      runtimeId: result.runtimeId,
      occurredAt: this.clock(),
    });
    if (suspended.attempts >= this.coverageSuspendedRetryLimit) {
      authority.recordUnavailable({
        runId: this.runId,
        reviewId: request.reviewId,
        reason: "coverage_review_suspended_exhausted",
        detail: `Suspended ${suspended.attempts} time(s); last reason ${suspended.lastReason}.`,
        occurredAt: this.clock(),
      });
      return this.pauseForCoverageGate(request.reviewId, "coverage_review_suspended_exhausted");
    }
    return { status: "progressed", action: "coverage_review_suspended" };
  }

  /**
   * R2-1: a coverage gate pauses the run with a durable, owner-visible
   * reason — the same runner-initiated pause mechanism as the verifier's
   * selection_required path (a durable event flips the run to paused; the
   * step returns paused). The verifier/manager path has no timed wake, so
   * the owner's normal resume re-drives the retry (and clears a terminal
   * N6 gate — see resumeInternal).
   */
  private pauseForCoverageGate(reviewId: string, reason: string): BuildStepResult {
    this.store.append({
      runId: this.runId,
      type: "run.paused",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `coverage-paused:${reviewId}:${reason}:${this.projection().lastSequence}`,
      payload: { reason: "coverage_reviewer_unavailable" },
    });
    return { status: "paused", action: "coverage_reviewer_unavailable" };
  }

  /**
   * T9 (EP39/OA-5): advance a triage-`answer` run. The answer turn records the
   * answer; the opted-in review runs via the answer review driver until a
   * verdict covers the CURRENT answer (repair cycle 1 B1: a re-recorded
   * answer after a verdict drives a re-review with the prior review attached,
   * OA-10 #2); anything else missing (normally the STATE.md docs gate) gets an
   * Architect turn to fix; then the normal completion decision completes the
   * run through the explicit handoff. No critic, coverage, worker,
   * integration, or final-verification step is reachable from here.
   */
  private async advanceAnswerPath(projection: SchedulerProjection): Promise<BuildStepResult> {
    const answer = projection.requestAnswer;
    if (!answer) {
      await this.runArchitect({ type: "plan_required" }, projection);
      return this.afterArchitect("plan_required");
    }
    // Repair cycle 1 (B1): readiness binds the verdict to the current answer,
    // so the pump re-reviews while no verdict covers it — with the latest
    // verdict attached as the prior review when one exists.
    if (projection.answerReviewOptIn && !currentAnswerReviewVerdict(projection)) {
      const review = this.answerReview;
      const reviewId = nextAnswerReviewId(projection);
      const priorReview = latestAnswerReviewVerdict(projection);
      if (!review) {
        // No review driver configured: record the explicit gate and pause
        // for the owner — never silently skip an opted-in review.
        this.answerAuthority.recordUnavailable({
          runId: this.runId,
          reviewId,
          reason: "no_answer_review_driver",
          occurredAt: this.clock(),
        });
        return this.pauseForAnswerReviewGate(reviewId, "no_answer_review_driver");
      }
      const result = await review.review({
        runId: this.runId,
        reviewId,
        architectRuntimeId: projection.runtime.architect.runtimeId ?? this.architectId,
        question: this.initialObjective?.trim()
          ? this.initialObjective
          : (projection.requestTriage?.rationale ?? this.runId),
        answerText: answer.answerText,
        addressedParts: answer.addressedParts,
        answerSequence: answer.sequence,
        // T9 repair cycle 3 (N-C): the answer review sees every acknowledged
        // guidance text — including guidance folded after the answer — so a
        // re-answer driven by folded guidance is reviewed against it.
        guidance: acknowledgedUserGuidanceSnapshots(projection),
        ...(priorReview ? { priorReview } : {}),
        signal: this.activeLifecycleSignal(),
      });
      if (result.status === "reviewed") return { status: "progressed", action: "answer_review_recorded" };
      if (result.status === "suspended") {
        // A suspension is transient: record the visible gate and pause for
        // the owner; the owner's normal resume re-drives the retry.
        this.answerAuthority.recordUnavailable({
          runId: this.runId,
          reviewId,
          reason: "answer_review_suspended",
          detail: result.reason,
          occurredAt: this.clock(),
        });
        return this.pauseForAnswerReviewGate(reviewId, "answer_review_suspended");
      }
      return this.pauseForAnswerReviewGate(reviewId, result.reason);
    }
    const readiness = buildCompletionReadiness(this.projection());
    if (!readiness.ready) {
      await this.runArchitect({ type: "plan_required" }, projection);
      return this.afterArchitect("plan_required");
    }
    // Repair cycle 1 (B2): the handoff is already requested (the opt-in
    // arrived at the handoff pause and the review has since run): the request
    // is durable, so wait for the owner's selection instead of driving a
    // second completion turn whose complete_run would dedup to a no-op and
    // throw. Idempotent: no event is appended; repeatable until selected.
    if (this.projection().projectHandoff?.status === "requested") {
      return { status: "paused", action: "project_handoff_requested" };
    }
    const completionReason = projection.runPolicy === "plan_only"
      ? { type: "completion_decision_required", runPolicy: "plan_only" } as const
      : { type: "completion_decision_required" } as const;
    await this.runArchitect(completionReason, projection);
    return this.afterArchitect("completion_decision_required");
  }

  private pauseForAnswerReviewGate(reviewId: string, reason: string): BuildStepResult {
    this.store.append({
      runId: this.runId,
      type: "run.paused",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `answer-paused:${reviewId}:${reason}:${this.projection().lastSequence}`,
      payload: { reason: "answer_reviewer_unavailable" },
    });
    return { status: "paused", action: "answer_reviewer_unavailable" };
  }

  private async advancePlanCritique(projection: SchedulerProjection): Promise<BuildStepResult | undefined> {
    const driver = this.planCritic;
    const state = projection.planCritique;
    if (!driver || !state?.policy || state.policy.mode === "off" || state.skipped) return undefined;
    if (state.current?.status === "resolved") return undefined;
    const skip = (reason: PlanCritiqueSkipReason): BuildStepResult => {
      this.store.append({
        runId: this.runId, type: "plan_critique.skipped", occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `plan-critique:skip:${projection.planRevision}:${reason}`,
        payload: { planRevision: projection.planRevision, reason },
      });
      return { status: "progressed", action: "plan_critique_skipped" };
    };
    if (this.runPolicy === "plan_only") return skip("plan_only");
    if (!state.risk) {
      const input = {
        architectDeclaration: driver.architectDeclaration(projection),
        stricterQualification: driver.stricterQualification,
        tasks: Object.values(projection.tasks),
      };
      this.store.append({
        runId: this.runId, type: "plan_critique.risk_assessed", occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `plan-critique:risk:${projection.planRevision}`,
        payload: {
          planRevision: projection.planRevision,
          architectDeclaration: input.architectDeclaration,
          stricterQualification: input.stricterQualification,
          assessment: assessPlanRisk(input),
        },
      });
      return { status: "progressed", action: "plan_risk_assessed" };
    }
    if (!planCritiqueRequired(state.policy.mode, state.risk.assessment)) return skip("low_plan_risk");
    const current = state.current;
    if (current?.status === "submitted") {
      if ((current.blockingFindingIds ?? []).length === 0) {
        this.store.append({
          runId: this.runId, type: "plan_critique.resolved", occurredAt: this.clock(),
          actor: { role: "runner", id: "build-runtime" },
          idempotencyKey: `plan-critique:resolve:${current.critiqueId}`,
          payload: { critiqueId: current.critiqueId, planRevision: current.planRevision, resolutions: [] },
        });
        return { status: "progressed", action: "plan_critique_resolved_by_runner" };
      }
      await this.runArchitect({
        type: "plan_critique_resolution_required",
        critiqueId: current.critiqueId,
        planRevision: current.planRevision,
        blockingFindingIds: [...current.blockingFindingIds!],
      }, projection);
      if (this.projection().planCritique?.current?.status !== "resolved") {
        throw new Error("Architect returned from plan_critique_resolution_required without a typed action.");
      }
      return this.afterArchitect("plan_critique_resolution_required");
    }
    this.recordingFailureContext = {
      ...(projection.integrationRevision ? { revision: projection.integrationRevision } : {}),
    };
    const result = await driver.critique({
      runId: this.runId,
      projection,
      riskReasons: state.risk.assessment.reasons,
      ...(projection.verifierSelection?.status === "selected" && projection.verifierSelection.selectedRuntimeId
        ? { preferredRuntimeId: projection.verifierSelection.selectedRuntimeId }
        : {}),
      signal: this.activeLifecycleSignal(),
    });
    if (result.status === "submitted") return { status: "progressed", action: "plan_critique_submitted" };
    if (result.status === "suspended" && result.reason === "cancelled" && this.projection().status === "paused") {
      return { status: "paused", action: "plan_critic_interrupted" };
    }
    const failures = this.projection().planCritique?.history.length ?? 0;
    if (result.status === "suspended" && result.reason === "provider_error" && failures < 2) {
      return { status: "progressed", action: "plan_critic_provider_failed" };
    }
    if (!driver.stricterQualification && result.status === "suspended") return skip("critic_failed");
    // FX-2 (N1): same occurrence key as the final-verification selection
    // path -- a re-requirement after an owner selection must record anew.
    const critiqueSelections = this.recordedVerifierSelections();
    const critiqueSelectionBase = `verifier-selection:plan-critique:${projection.planRevision}:${result.status === "unavailable" ? result.reason : result.reason}`;
    const critiqueSelectionKey = critiqueSelections === 0
      ? critiqueSelectionBase
      : `${critiqueSelectionBase}:sel-${critiqueSelections}`;
    this.store.append({
      runId: this.runId, type: "verifier.selection_required", occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: critiqueSelectionKey,
      payload: {
        reason: "plan_critique_no_independent_runtime",
        requiredCapabilities: ["code"],
        candidateRuntimeIds: [...driver.candidateRuntimeIds],
      },
    });
    return { status: "paused", action: "verifier_selection_required" };
  }

  private pauseIfRepairCyclesExhausted(
    projection: SchedulerProjection,
    source: "final_verification" | "verifier",
    targetRevision: string,
  ): BuildStepResult | undefined {
    if (!repairCyclesExhausted(projection)) return undefined;
    const cycles = projection.repairCycles!;
    this.store.append({
      runId: this.runId,
      type: "repair.cycle_limit_reached",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `repair-cycle-limit:${targetRevision}:${cycles.used}:${cycles.extensions}`,
      payload: { source, targetRevision, used: cycles.used, limit: effectiveRepairPlanLimit(projection) ?? cycles.limit },
    });
    return { status: "paused", action: "repair_cycle_limit_reached" };
  }

  /** T6b repair (B5/R2-B5): one member issue per category, shared by dispatch and charge; failing ids enrich the identity. */
  private repairMembers(categories: readonly string[], failingIdsByCategory?: ReadonlyMap<string, readonly string[]>): { issueId: string; rootCause: string }[] {
    return repairMemberIssues(this.projectId ?? this.runId, categories.map((category) => failingIdsByCategory ? withFailingIds(category, failingIdsByCategory) : category));

  }

  /**
   * T6b repair (B3): an exhausted issue, a recorded external blocker, or
   * an exhausted task/run cap pauses the run with a durable owner-visible
   * reason instead of throwing, so step() never rejects on a repair
   * refusal and the run never loops. The owner resumes with
   * repair.issue_budget_extended (authorized amendment) or
   * repair.external_blocker_cleared; the resumed run gives the Architect
   * a turn to record a new approach, re-scope, or declare a blocker.
   * T6b repair (R2-B1): the pause idempotency key carries the durable
   * generation (used/limit plus sequence), so a pause after an owner
   * extension is a new occurrence and a generic resume re-pauses durably.
   */
  private pauseOnRepairIssue(issueId: string, cause: "budget_exhausted" | "external_blocker" | "approach_failed", detail: string): BuildStepResult {
    const reason = `repair_issue_paused:${issueId}`;
    const projection = this.projection();
    if (projection.status === "paused" && projection.pauseReason?.reason === reason) {
      return { status: "paused", action: reason };
    }
    const issue = projection.repairIssues?.[issueId];
    const generation = issue ? `${issue.used}/${issue.limit}` : "unknown";
    this.store.append({
      runId: this.runId,
      type: "repair.issue_paused",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `repair-issue-paused:${issueId}:${cause}:${generation}:${projection.lastSequence}`,
      payload: { issueId, cause, detail },
    });
    const after = this.projection();
    if (after.status !== "paused") throw new Error(`Repair-issue pause for ${issueId} did not pause the run.`);
    return { status: "paused", action: "repair_issue_paused" };
  }

  private async ensureRepairIssue(issueId: string, rootCause: string): Promise<void> {
    if (this.projection().repairIssues?.[issueId]) return;
    this.store.append({
      runId: this.runId,
      type: "repair.issue_recorded",
      occurredAt: this.clock(),
      actor: { role: "runner", id: DELIVERY_ACCEPTANCE_RUNNER_ID },
      idempotencyKey: `repair-issue:${issueId}`,
      payload: { issueId, rootCause, limit: this.issueRepairLimit },
    });
  }

  /**
   * T6b repair (B3/B4/B5): the gate before every repair dispatch. Opens
   * one durable issue per member root cause (never a joined category set;
   * dispatch and charge share the key) and checks every member allowance.
   * The first failure opens the issue; no cycle is charged here. An
   * exhausted issue, a recorded external blocker, or an exhausted
   * task/run cap pauses with a durable owner-visible reason instead of
   * throwing. The kernel never synthesizes an approach decision: the
   * Architect records one through its non-terminal tool on the repair
   * turn, and the repair planning tools require it before dispatching.
   * Legacy runs bypass the gate unchanged.
   */
  private async prepareRepairDispatch(
    categories: readonly string[],
    scope: { taskId: string; evidenceIds: readonly string[]; failingIdsByCategory?: ReadonlyMap<string, readonly string[]> },
  ): Promise<{ categories: string[]; paused?: BuildStepResult }> {
    if (this.projection().planningPolicyVersion !== 1) return { categories: [...categories] };
    // The durable issue identity namespaces bare final-verification
    // categories exactly like the failing-check charge path, so dispatch
    // reads the issue the checks charged. Already-namespaced verifier
    // categories pass through unchanged. The returned categories stay in
    // the caller's namespace: the Architect-facing failedCategories keep
    // the bare contract the repair tools validate.
    const members = this.repairMembers(categories, scope.failingIdsByCategory);
    for (const member of members) {
      await this.ensureRepairIssue(member.issueId, member.rootCause);
    }
    const projection = this.projection();
    const task = projection.tasks[scope.taskId];
    const maxTaskAttemptsRemaining = Math.max(0, (task?.attemptLimit ?? this.maxTaskAttempts) - (task?.attempt ?? 0));
    const maxRepairPlanRemaining = Math.max(0, (effectiveRepairPlanLimit(projection) ?? this.repairPlanLimit) - (projection.repairCycles?.used ?? 0));
    for (const member of members) {
      const issue = this.projection().repairIssues?.[member.issueId];
      if (!issue) throw new Error("Repair dispatch requires its durable issue.");
      if (issue.externalBlocker) {
        return {
          categories: [...categories],
          paused: this.pauseOnRepairIssue(member.issueId, "external_blocker",
            `External blocker on ${member.rootCause}: ${issue.externalBlocker.acceptanceCondition} Required owner action: ${issue.externalBlocker.requiredOwnerAction}`),
        };
      }
      if (issue.used >= issue.limit) {
        return {
          categories: [...categories],
          paused: this.pauseOnRepairIssue(member.issueId, "budget_exhausted",
            `Issue ${member.rootCause} used ${issue.used}/${issue.limit} repair cycles. The owner may extend the budget with additionalCycles via repair.issue_budget_extended.`),
        };
      }
      if (maxTaskAttemptsRemaining <= 0) {
        return {
          categories: [...categories],
          paused: this.pauseOnRepairIssue(member.issueId, "budget_exhausted",
            `Task ${scope.taskId} has no attempts remaining for ${member.rootCause}; re-scope the plan before dispatching another repair.`),
        };
      }
      if (maxRepairPlanRemaining <= 0) {
        return {
          categories: [...categories],
          paused: this.pauseOnRepairIssue(member.issueId, "budget_exhausted",
            `Run-level repair-plan budget is exhausted for ${member.rootCause}: used ${projection.repairCycles?.used ?? 0} of ${effectiveRepairPlanLimit(projection) ?? this.repairPlanLimit} repair plans; the owner may raise the run repair-plan limit before dispatching another repair.`),
        };
      }
    }
    return { categories: [...categories] };
  }

  /**
   * T6b (OA-14): the gate before a failing check charges a repair cycle.
   * Green checks charge nothing. A proven external blocker consumes no
   * futile charge. Otherwise the single failing-test rerun decides: a
   * pass-on-rerun records `flaky`, charges nothing, and still blocks
   * acceptance until the check passes on its own run; any other outcome
   * charges exactly one issue-level cycle against the check's category
   * issue, linked to the standing recorded approach when one exists.
   * Legacy runs bypass the gate unchanged.
   */
  /**
   * T6b repair (R3-B2): when a dispatched repair's next validation fails,
   * its consumed approach is durably failed (no charge: an observation is
   * not an attempt). The next dispatch then needs a new recorded decision;
   * a repeat of the same approach still needs evidence NEW to its sets.
   * Legacy runs bypass (their flows record no approaches).
   */
  private markDispatchedApproachesFailed(
    failure: ReturnType<typeof deriveFinalVerificationFailure>,
    completedChecks: Parameters<typeof failingTestIdsByCategory>[0] | undefined,
  ): void {
    if (this.projection().planningPolicyVersion !== 1) return;
    const members = this.repairMembers(failure.failedCategories, failingTestIdsByCategory(completedChecks ?? []));
    this.markDispatchedApproachesFailedForMembers(members, failure.failureId);
  }

  /**
   * T6b repair (R4-B1): when a dispatched repair's next validation fails —
   * a failed boundary, an unsatisfied verifier verdict, or a failed final
   * verification — its consumed approach is durably failed (no charge: an
   * observation is not an attempt). The next dispatch then needs a new
   * recorded decision. Members with no dispatched live approach are
   * skipped; repeats stay idempotent on the failure key.
   */
  private markDispatchedApproachesFailedForMembers(
    members: readonly { issueId: string; rootCause: string }[],
    failureKey: string,
  ): void {
    if (this.projection().planningPolicyVersion !== 1) return;
    for (const member of members) {
      const issue = this.projection().repairIssues?.[member.issueId];
      const latest = issue?.approaches.at(-1);
      if (!issue || !latest || latest.failed || !latest.dispatched) continue;
      this.store.append({
        runId: this.runId,
        type: "repair.approach_failed",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `repair-approach-failed:${member.issueId}:${failureKey}`,
        payload: { issueId: member.issueId, approachId: latest.approachId },
      });
    }
  }

  private async chargeReviewFixRound(rejected: BuildTask): Promise<BuildStepResult | undefined> {
    if (this.projection().planningPolicyVersion !== 1) return undefined;
    const members = new Map<string, { evidenceIds: string[]; rationale: string }>();
    const review = this.projection().reviews[rejected.id];
    for (const verdict of review?.criterionVerdicts ?? []) {
      if (verdict.verdict !== "unsatisfied") continue;
      const key = `delivery-review:${rejected.id}:${verdict.criterionId}`;
      const entry = members.get(key) ?? { evidenceIds: [], rationale: "" };
      entry.evidenceIds.push(...verdict.evidenceIds);
      if (!entry.rationale) entry.rationale = verdict.rationale;
      members.set(key, entry);
    }
    const deliveryReview = this.projection().delivery?.reviews[rejected.id];
    for (const finding of openBlockingFindings(deliveryReview)) {
      const key = `delivery-review:${rejected.id}:${finding.category}`;
      const entry = members.get(key) ?? { evidenceIds: [], rationale: "" };
      if (!entry.rationale) entry.rationale = finding.claim;
      members.set(key, entry);
    }
    if (members.size === 0) return undefined;
    const links = (rejected.criterionEvidenceLinks ?? []).map((link) => link.evidenceId);
    for (const rootCause of members.keys()) {
      const issueId = repairIssueIdentity({ projectId: this.projectId ?? this.runId, rootCause });
      await this.ensureRepairIssue(issueId, rootCause);
    }
    for (const [rootCause, member] of members) {
      const issueId = repairIssueIdentity({ projectId: this.projectId ?? this.runId, rootCause });
      const issue = this.projection().repairIssues?.[issueId];
      if (!issue) throw new Error("Review fix round requires its durable issue.");
      if (issue.used >= issue.limit) {
        return this.pauseOnRepairIssue(issueId, "budget_exhausted",
          `Issue ${rootCause} used ${issue.used}/${issue.limit} repair cycles. The owner may extend the budget with additionalCycles via repair.issue_budget_extended.`);
      }
      const evidenceIds = [...new Set([...member.evidenceIds, ...links])];
      // T6b repair (R3 N-1): a review fix round with no evidence still
      // charges — against the durable delivery review record — never
      // silently uncharged. Without any review record either, the run
      // pauses instead of charging blind.
      const chargeEvidence = evidenceIds.length > 0 ? evidenceIds : deliveryReview?.reviewId ? [deliveryReview.reviewId] : [];
      if (chargeEvidence.length === 0) {
        return this.pauseOnRepairIssue(issueId, "approach_failed",
          `Review fix round for ${rootCause} cites no evidence and has no durable review record; the owner may re-scope before another fix round.`);
      }
      this.store.append({
        runId: this.runId,
        type: "repair.cycle_recorded",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `repair-cycle:delivery-review:${rejected.id}:${rejected.attempt}:${issueId}`,
        payload: {
          issueId,
          hypothesis: `rework ${rootCause}: ${member.rationale}`.slice(0, 1000),
          outcome: "rework_dispatched",
          evidenceIds: chargeEvidence,
        },
      });
    }
    return undefined;
  }

  private async applyFailingCheckRepairCharge(
    check: FinalVerificationCheckResult,
    rerun: {
      generationId: string;
      taskId: string;
      targetRevision: string;
      plan: FinalVerificationPlan;
      executionProfile: FinalVerificationExecutionProfile;
      attempt: number;
      signal?: AbortSignal;
    },
  ): Promise<{ green: boolean }> {
    if (this.projection().planningPolicyVersion !== 1) return { green: check.green };
    // T6b repair (B6): both searches run after every verification, green or red.
    if (check.green) {
      await this.recordCleanupSearch("verification");
      return { green: true };
    }
    const failingTestIds = [...new Set(check.facts.flatMap((fact) => fact.kind === "command" ? fact.report?.failingTestIds ?? [] : []))];
    const [member] = this.repairMembers([`final-verification:${check.category}`], new Map([[check.category, failingTestIds]]));
    if (!member) throw new Error("Failing check requires a repair issue.");
    const { issueId, rootCause } = member;
    await this.ensureRepairIssue(issueId, rootCause);
    const issue = this.projection().repairIssues?.[issueId];
    if (!issue) throw new Error("Failing check requires its durable repair issue.");
    if (issue.externalBlocker) {
      await this.recordCleanupSearch("verification");
      return { green: false };
    }
    const flakyKey = `${rerun.generationId}:${check.category}`;
    let flaky = this.projection().repairFlaky?.[flakyKey];
    // T6b repair (B2): the rerun runs once per failing check through the
    // audited path with the real failing test ids. When no rerun can be
    // performed (no driver, or an unsupported command shape), record
    // not_performed with the reason; the cycle is charged on dispatch.
    // T6b repair (N7): the rerun selector needs the first run failing
    // test ids AND the failing check durable evidence.
    if (!flaky && failingTestIds.length > 0) {
      if (this.flakyIsolation && check.evidenceIds.length > 0) {
      const outcome = await this.flakyIsolation.rerunFailingTests({
        runId: this.runId,
        category: check.category,
        failingTestIds,
        generationId: rerun.generationId,
        taskId: rerun.taskId,
        targetRevision: rerun.targetRevision,
        plan: rerun.plan,
        executionProfile: rerun.executionProfile,
        attempt: rerun.attempt,
        ...(rerun.signal ? { signal: rerun.signal } : {}),
      });
      if (outcome.status === "rerun") {
        this.store.append({
          runId: this.runId,
          type: "repair.flaky_isolated",
          occurredAt: this.clock(),
          actor: { role: "runner", id: "build-runtime" },
          idempotencyKey: `repair-flaky:${rerun.generationId}:${check.category}`,
          payload: {
            category: check.category,
            generationId: rerun.generationId,
            taskId: rerun.taskId,
            targetRevision: rerun.targetRevision,
            failingTestIds: [...failingTestIds],
            rerunGreen: outcome.green,
            rerunEvidenceIds: [...outcome.evidenceIds],
            finding: outcome.green
              ? `flaky: ${check.category} failed [${failingTestIds.join(", ")}] then passed on a rerun of only those tests; still requires a clean run.`
              : `consistent failure: ${check.category} failed [${failingTestIds.join(", ")}] and failed again on rerun.`,
          },
        });
        flaky = this.projection().repairFlaky?.[flakyKey];
      } else {
        this.store.append({
          runId: this.runId,
          type: "repair.flaky_isolated",
          occurredAt: this.clock(),
          actor: { role: "runner", id: "build-runtime" },
          idempotencyKey: `repair-flaky:${rerun.generationId}:${check.category}`,
          payload: {
            category: check.category,
            generationId: rerun.generationId,
            taskId: rerun.taskId,
            targetRevision: rerun.targetRevision,
            failingTestIds: [...failingTestIds],
            rerunGreen: false,
            rerunEvidenceIds: [],
            finding: `not_performed: ${outcome.note}`,
          },
        });
        flaky = this.projection().repairFlaky?.[flakyKey];
      }
      } else {
        this.store.append({
          runId: this.runId,
          type: "repair.flaky_isolated",
          occurredAt: this.clock(),
          actor: { role: "runner", id: "build-runtime" },
          idempotencyKey: `repair-flaky:${rerun.generationId}:${check.category}`,
          payload: {
            category: check.category,
            generationId: rerun.generationId,
            taskId: rerun.taskId,
            targetRevision: rerun.targetRevision,
            failingTestIds: [...failingTestIds],
            rerunGreen: false,
            rerunEvidenceIds: [],
            finding: `not_performed: ${this.flakyIsolation ? "the failing check has no durable evidence to select the rerun" : "no flaky-isolation driver is configured for this run"}.`,
          },
        });
        flaky = this.projection().repairFlaky?.[flakyKey];
      }
    }
    // T6b repair (B2): a failing tests check with no failing test ids
    // (an npm-managed command or a missing report) cannot be narrowed, so
    // the pump records not_performed with the reason instead of silently
    // skipping the rerun decision.
    if (!flaky && check.category === "tests" && failingTestIds.length === 0) {
      this.store.append({
        runId: this.runId,
        type: "repair.flaky_isolated",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `repair-flaky:${rerun.generationId}:${check.category}`,
        payload: {
          category: check.category,
          generationId: rerun.generationId,
          taskId: rerun.taskId,
          targetRevision: rerun.targetRevision,
          failingTestIds: [],
          rerunGreen: false,
          rerunEvidenceIds: [],
          finding: `not_performed: the failing tests check produced no failing test ids to narrow (npm-managed command or missing report)${this.flakyIsolation ? "" : "; no flaky-isolation driver is configured for this run"}.`,
        },
      });
      flaky = this.projection().repairFlaky?.[flakyKey];
    }
    const isolation = { outcome: (flaky?.rerunGreen === true ? "flaky" : "consistent_failure") as "flaky" | "consistent_failure", failingTestIds };
    beforeFailingCheckRepairCharge(check, { flakyIsolation: isolation });
    await this.recordCleanupSearch("verification");
    // T6b repair (B5): a failing check opens the issue (above) but never
    // charges it here. The cycle is charged when a correction is dispatched
    // through a repair planning tool; a flaky pass-on-rerun still blocks
    // acceptance until the check passes on its own run.
    void failingCheckRepairChargeDecision({ flakyIsolation: isolation });
    return { green: false };
  }

  /**
   * T6b repair (N-6): sessions of the worker attempts that moved since the
   * given sequence, so attempt cleanup stops only those processes. A task
   * touched by the window contributes every session assigned to it: an
   * older attempt of the same task is done, so its leftovers are fair
   * game, while concurrent untouched attempts stay out of scope.
   */
  private workerSessionIdsSince(sequence: number): string[] {
    const tasks = new Set<string>();
    const sessions = new Set<string>();
    for (const event of this.store.readRun(this.runId, sequence)) {
      const payload = event.payload as { readonly taskId?: unknown; readonly sessionId?: unknown };
      if (event.type === "worker.runtime_assigned" && typeof payload.sessionId === "string") {
        sessions.add(payload.sessionId);
      }
      if (typeof payload.taskId === "string") tasks.add(payload.taskId);
    }
    for (const assignment of Object.values(this.projection().runtime.workerAssignments)) {
      if (tasks.has(assignment.taskId)) sessions.add(assignment.sessionId);
    }
    return [...sessions];
  }


  private async recordCleanupSearch(trigger: "task_attempt" | "verification", sessionIds?: readonly string[]): Promise<void> {
    // T6b (OA-17) binds new-policy runs; legacy runs keep P6.5 behavior.
    if (this.projection().planningPolicyVersion !== 1) return;
    const sequence = this.projection().lastSequence;
    const findings = await this.cleanupAfterAttempt?.({ taskAttempt: trigger, ...(sessionIds ? { sessionIds: [...sessionIds] } : {}) }) ?? { processes: [], tempPaths: [] };
    this.store.append({
      runId: this.runId,
      type: "cleanup.checked",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `cleanup:${trigger}:${sequence}`,
      payload: { trigger, findings: [...findings.processes.map((process) => ({ ...process, kind: "process" })), ...findings.tempPaths.map((path) => ({ ...path, kind: "temp_path" }))] },
    });
  }

  /**
   * T6b (OA-16/B7): the per-model outcome for every reviewed accepted
   * task. Runs before the acceptance event so an unrecorded outcome cannot
   * be accepted. A no-op without a wired recorder. Every review round of
   * the task counts, per author identity of its reviewed revision: a task
   * whose first review found a defect keeps that defect on its original
   * author even when a different model wrote the accepted fix. The store
   * keeps defect_found sticky per (run, model, task), so earlier rounds are
   * never erased by the accepting round.
   */
  private recordReviewOutcome(taskId: string, review: DeliveryReviewRecord): void {
    const recorder = this.reviewOutcomeRecorder;
    if (!recorder) return;
    const history = this.projection().delivery?.reviewHistory[taskId] ?? [];
    const recordedAt = this.clock();
    for (const outcome of reviewOutcomeByAuthor([...history, review])) {
      recorder.record({ runId: this.runId, modelId: outcome.modelId, taskId, accepted: true, defectFound: outcome.defectFound, recordedAt });
    }
  }
}

function firstTask(
  projection: SchedulerProjection,
  status: BuildTask["status"]
): BuildTask | undefined {
  return Object.values(projection.tasks)
    .filter((task) => task.status === status)
    .sort((left, right) => left.id.localeCompare(right.id))[0];
}

function firstMatchingArchitectActionEvent(
  events: readonly SchedulerEvent[],
  afterSequence: number,
  reason: ArchitectActionReason,
): SchedulerEvent | undefined {
  return events.find((event) =>
    event.sequence > afterSequence && architectLifecycleEventMatchesReason(event, reason)
  );
}

function firstPendingUserGuidance(projection: SchedulerProjection) {
  return Object.values(projection.userGuidance)
    .filter((guidance) => guidance.status === "submitted")
    .sort((left, right) => left.version - right.version)[0];
}

/**
 * T9 repair cycle 3 (N-C): every acknowledged user guidance as an
 * id-and-text snapshot for reviewer inputs. The reviewer that re-checks an
 * answer after folded guidance must see the guidance text.
 */
function acknowledgedUserGuidanceSnapshots(
  projection: SchedulerProjection,
): { id: string; text: string }[] {
  return Object.values(projection.userGuidance)
    .filter((guidance) => guidance.status === "acknowledged")
    .sort((left, right) => left.version - right.version)
    .map((guidance) => ({
      id: `${guidance.guidanceId}:v${guidance.version}`,
      text: guidance.text,
    }));
}

function emptyProjection(runId: string): SchedulerProjection {
  return {
    runId,
    status: "running",
    acceptanceContractStatus: "current",
    acceptanceUpgradeRequiredEventRecorded: false,
    planRevision: 0,
    tasks: {},
    guidance: {},
    userGuidance: {},
    userGuidanceVersion: 0,
    architectQuestions: {},
    architectQuestionVersion: 0,
    reviews: {},
    runtime: {
      providerHealth: {},
      workerAssignments: {},
      architect: {},
    },
    lastSequence: 0,
  };
}

function boundedCleanupError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message, 4_096) || "Final verification cleanup failed.";
}

function projectDocSummaryRejected(summary: string): boolean {
  return !summary.trim() || summary.includes("\n") || summary.includes("\0");
}

function isProjectDocToolInput(input: unknown): input is {
  path: string;
  content: string;
  summary: string;
} {
  if (typeof input !== "object" || input === null) return false;
  const value = input as Record<string, unknown>;
  return typeof value.path === "string" &&
    typeof value.content === "string" &&
    typeof value.summary === "string";
}

/**
 * Exact sorted names `createArchitectTools` can register from an Architect turn.
 * One turn registers a subset: reason gates and `plan_only` omit tools. A4 may
 * move this list into role-capabilities. It is not a broker.
 */
export const ARCHITECT_LIFECYCLE_SURFACE: readonly string[] = Object.freeze([
  "acknowledge_user_guidance",
  "answer_guidance",
  "ask_user",
  "complete_run",
  "convert_to_build",
  "draft_planning_plan",
  "persist_planning_ledger",
  "plan_final_verification",
  "plan_tasks",
  "plan_verification_repairs",
  "plan_verifier_repairs",
  "read_planning_source_section",
  "reconcile_plan",
  "record_answer",
  "record_external_blocker",
  "record_planning_checkpoint",
  "record_repair_approach_decision",
  "record_triage",
  "request_coverage_review",
  "request_integration",
  "resolve_context_recording",
  "resolve_delivery_boundary_failure",
  "resolve_plan_critique",
  "review_final_verification",
  "review_task",
  "revise_planning_plan",
  "revise_task",
  "upgrade_acceptance_contract",
  "write_project_doc",
]);

const ARCHITECT_LIFECYCLE_UNIVERSE: readonly Omit<ArchitectToolsOptions, "store" | "clock">[] = [
  {
    runPolicy: "finish",
    architectAction: { reason: { type: "plan_required" }, sequence: 0 },
  },
  {
    runPolicy: "budgeted",
    architectAction: { reason: { type: "plan_required" }, sequence: 0 },
  },
  {
    runPolicy: "plan_only",
    architectAction: { reason: { type: "plan_required" }, sequence: 0 },
  },
  {
    runPolicy: "plan_only",
    planOnlyCompletionAvailable: true,
    architectAction: {
      reason: { type: "completion_decision_required", runPolicy: "plan_only" },
      sequence: 0,
    },
  },
  {
    runPolicy: "finish",
    architectAction: {
      reason: {
        type: "context_recording_decision_required",
        purpose: "record",
        attempts: 1,
        reason: "failed",
        noteSequence: 1,
      },
      sequence: 0,
    },
  },
  {
    runPolicy: "finish",
    architectAction: {
      reason: { type: "user_guidance_required", guidanceId: "guidance", version: 1 },
      sequence: 0,
    },
  },
  {
    runPolicy: "finish",
    finalVerificationPlanAvailable: true,
    architectAction: {
      reason: { type: "final_verification_plan_required", integrationRevision: "rev" },
      sequence: 0,
    },
  },
  {
    runPolicy: "finish",
    finalVerificationReviewAvailable: true,
    architectAction: {
      reason: {
        type: "final_verification_review_required",
        taskId: "task",
        generationId: "generation",
        submissionId: "submission",
        targetRevision: "rev",
      },
      sequence: 0,
    },
  },
  {
    runPolicy: "finish",
    finalVerificationRepairPlanAvailable: true,
    repairApproachAvailable: true,
    architectAction: {
      reason: {
        type: "final_verification_repair_plan_required",
        finalVerificationTaskId: "task",
        generationId: "generation",
        targetRevision: "rev",
        source: { type: "semantic_review", submissionId: "submission", reviewId: "review" },
        failedCategories: [],
        evidenceIds: [],
      },
      sequence: 0,
    },
  },
  {
    runPolicy: "finish",
    verifierRepairPlanAvailable: true,
    repairApproachAvailable: true,
    architectAction: {
      reason: {
        type: "verifier_repair_plan_required",
        reviewId: "review",
        targetRevision: "rev",
        unsatisfiedCriteria: [],
      },
      sequence: 0,
    },
  },
  {
    // T6a: the failed integrated-boundary turn.
    runPolicy: "finish",
    deliveryBoundaryResolutionAvailable: true,
    repairApproachAvailable: true,
    architectAction: {
      reason: { type: "delivery_boundary_failed", taskId: "task", boundaryId: "boundary", integrationRevision: "rev", resolutionGeneration: 1 },
      sequence: 0,
    },
  },
  {
    runPolicy: "finish",
    planCritiqueResolutionAvailable: true,
    architectAction: { reason: { type: "plan_required" }, sequence: 0 },
  },
  {
    runPolicy: "finish",
    planningTools: {},
    architectAction: { reason: { type: "plan_required" }, sequence: 0 },
  },
  {
    // T3a repair (B1b): the planning-state registration shape. It registers
    // a subset of the universe (no legacy plan/task tools), so the surface
    // assert still holds; the entry keeps future shapes inside the surface.
    runPolicy: "finish",
    planningTools: {},
    planningState: true,
    architectAction: { reason: { type: "plan_required" }, sequence: 0 },
  },
  {
    // T9: the new-policy triage turn registers the triage tools alongside
    // the planning tools.
    runPolicy: "finish",
    planningTools: {},
    triageTools: true,
    architectAction: { reason: { type: "plan_required" }, sequence: 0 },
  },
  {
    // T9: the answer-path registration shape. It registers a subset of the
    // universe (no mutation lifecycle tools), so the surface assert still
    // holds; the entry keeps future shapes inside the surface.
    runPolicy: "finish",
    planningTools: {},
    triageTools: true,
    answerPath: true,
    architectAction: { reason: { type: "plan_required" }, sequence: 0 },
  },
];

/** Names produced by calling `createArchitectTools` across every registration shape. */
export function architectLifecycleUniverseNames(
  store: SchedulerStore,
  clock: () => string,
): readonly string[] {
  const names = new Set<string>();
  for (const options of ARCHITECT_LIFECYCLE_UNIVERSE) {
    for (const tool of createArchitectTools({
      store,
      clock,
      ...options,
      artifacts: ARCHITECT_LIFECYCLE_UNIVERSE_ARTIFACTS,
    })) {
      names.add(tool.definition.name);
    }
  }
  return Object.freeze([...names].sort(compareToolNames));
}

function assertArchitectLifecycleRegistration(
  registeredNames: readonly string[],
  requireLifecycleTools: boolean,
  store: SchedulerStore,
  clock: () => string,
  answerPathRequired?: readonly string[],
): void {
  const universe = architectLifecycleUniverseNames(store, clock);
  const surface = ARCHITECT_LIFECYCLE_SURFACE;
  if (!sortedNamesEqual(universe, surface)) {
    const allowed = new Set<string>(surface);
    const extra = universe.find((name) => !allowed.has(name));
    if (extra) {
      throw new Error(`Architect lifecycle registered tool ${extra} is not on the allow-list.`);
    }
    const present = new Set<string>(universe);
    const missing = surface.find((name) => !present.has(name));
    throw new Error(`Architect lifecycle surface omitted ${missing ?? "a required tool"}.`);
  }
  if (requireLifecycleTools) {
    for (const name of ARCHITECT_LIFECYCLE_TOOLS) {
      if (!registeredNames.includes(name)) {
        throw new Error(`Architect lifecycle required tool ${name} is missing.`);
      }
    }
  }
  if (answerPathRequired) {
    for (const name of answerPathRequired) {
      if (!registeredNames.includes(name)) {
        throw new Error(`Answer path required tool ${name} is missing.`);
      }
    }
  }
  const allowed = new Set<string>(surface);
  for (const name of registeredNames) {
    if (!allowed.has(name)) {
      throw new Error(`Architect lifecycle registered tool ${name} is not on the allow-list.`);
    }
  }
}

function sortedNamesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function compareToolNames(left: string, right: string): number {
  return left.localeCompare(right);
}

/** Present only so universe derivation lists write_project_doc. Never executed. */
const ARCHITECT_LIFECYCLE_UNIVERSE_ARTIFACTS = {} as ArtifactStore;
