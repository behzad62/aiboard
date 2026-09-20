import type { BuildRunPolicy } from "@/lib/db/schema";

export const DEFAULT_RUNNER_V2_URL = "http://127.0.0.1:8787";

export interface NativeRunnerConnection {
  url: string;
  token: string;
}

export interface NativeRunnerHealth {
  ok: true;
  protocolVersion: 2;
  projectPath: string;
  nodeVersion: string;
}

export interface NativeProviderConfig {
  runtimeId: string;
  providerId: string;
  modelId: string;
  displayName?: string;
  billingBasis: "account_not_metered" | "api_priced" | "unknown";
  transport: "account-runner" | "openai-compatible" | "anthropic" | "google";
  baseUrl?: string;
  secret: string;
  runnerToken?: string;
  capabilities: string[];
  inputCapabilities?: {
    image: boolean;
    document: boolean;
    audio: boolean;
    video: boolean;
  };
  priority: number;
  reasoningEffort?: string;
  protocol?: "chat-completions" | "responses";
  inputCostMicrosPerMillion?: number;
  outputCostMicrosPerMillion?: number;
  cachedInputCostMicrosPerMillion?: number;
  cacheWriteInputCostMicrosPerMillion?: number;
}

export interface NativePermissionRequest {
  requestId: string;
  runId: string;
  sessionId: string;
  callId: string;
  toolName: string;
  actor: { role: "architect" | "worker" | "subagent" | "verifier"; id: string };
  permissionProfile: "guarded" | "project" | "full";
  access: { capability: string; external?: boolean; destructive?: boolean; credentialChange?: boolean };
  outsideWorkspace: boolean;
  status: "pending" | "approved" | "denied";
  occurredAt: string;
}

export interface CreateNativeBuildInput {
  runId: string;
  projectPath: string;
  permissionProfile: "guarded" | "project" | "full";
  idempotencyKey: string;
  build: {
    projectId: string;
    objective: string;
    architectRuntimeId: string;
    workerRuntimeIds: string[];
    verifierRuntimeIds: string[];
    alwaysRequireIndependentVerifier: boolean;
    maxConcurrency: number;
    runPolicy: BuildRunPolicy;
    budgetLimits: {
      maxEstimatedCostMicros?: number;
      maxActiveMs?: number;
    };
    benchmark?: {
      attemptId: string;
      allowedCommands: string[];
      hiddenPaths: string[];
      protectedPaths: string[];
    };
  };
}

export interface NativeBuildTask {
  id: string;
  objective: string;
  dependencies: string[];
  status: string;
  requiredCapabilities: string[];
  acceptanceCriteria?: NativeAcceptanceCriterion[];
  acceptanceCriteriaVersion?: number;
  criterionEvidenceLinks?: NativeCriterionEvidenceLink[];
  attempt: number;
  assignedWorkerId?: string;
  changeSetId?: string;
  failureReason?: string;
  integrationRevision?: string;
  conflictPaths?: string[];
  kind?: "implementation" | "verification_repair" | "final_verification";
  generationId?: string;
  targetRevision?: string;
  verificationRepair?: NativeVerificationRepairProvenance;
  verifierRepair?: {
    sourceReviewId: string;
    targetRevision: string;
    criteria: Array<{ taskId: string; criterionId: string }>;
    evidenceIds: string[];
  };
}

export type NativeFinalVerificationCategory = "build" | "tests" | "runtime_smoke" | "browser";
export type NativeFinalVerificationDiagnosticValue =
  | null | boolean | number | string
  | NativeFinalVerificationDiagnosticValue[]
  | { [key: string]: NativeFinalVerificationDiagnosticValue };

export interface NativeVerificationRepairProvenance {
  sourceGenerationId: string;
  finalVerificationTaskId: string;
  targetRevision: string;
  categories: NativeFinalVerificationCategory[];
  evidenceIds: string[];
  source:
    | { type: "semantic_review"; submissionId: string; reviewId: string }
    | { type: "mechanical_failure"; failureId: string; issueIds: string[]; factIds: string[] };
}

export interface NativeFinalVerificationObservability {
  canonicalRevision?: string;
  current?: NativeFinalVerificationGenerationObservability;
  history: Array<{
    generationId: string;
    taskId: string;
    targetRevision: string;
    revisionStatus: "stale";
    invalidatedByRevision?: string;
    invalidatedByGuidanceId?: string;
  }>;
}

export interface NativeFinalVerificationGenerationObservability {
  generationId: string;
  taskId: string;
  targetRevision: string;
  revisionStatus: "current" | "stale";
  categories: Array<{
    category: NativeFinalVerificationCategory;
    applicability: "required" | "not_applicable";
    rationale?: string;
    repositoryInspection?: { inspectedPaths: string[]; summary: string };
    status: "pending" | "passed" | "failed" | "not_applicable";
    evidenceIds: string[];
    issues: string[];
  }>;
  submission: { status: "pending" | "submitted"; submissionId?: string; green?: boolean };
  mechanicalFailure?: { failureId: string; failedCategories: NativeFinalVerificationCategory[]; evidenceIds: string[] };
  cleanup: {
    status: "pending" | "started" | "succeeded" | "failed";
    attempt?: number;
    error?: string;
    diagnosticsAvailable: boolean;
    diagnostics?: {
      version: 1;
      kind: "final-verification-diagnostics";
      runId: string;
      generationId: string;
      taskId: string;
      targetRevision: string;
      changedPaths: string[];
      checks: NativeFinalVerificationDiagnosticValue[];
      evidenceReferences: string[];
      logs: string[];
    };
  };
  review: { status: "pending" | "requested" | "approved" | "repair_required" | "rejected"; summary?: string };
  repairs: Array<{ taskId: string; status: string }>;
}

export type NativeAcceptanceContractStatus =
  | "current"
  | "acceptance_contract_upgrade_required"
  | "legacy_completed";

export interface NativeAcceptanceCriterion {
  id: string;
  text: string;
}

export interface NativeCriterionEvidenceLink {
  criterionId: string;
  evidenceId: string;
  artifactHashes: string[];
  taskId?: string;
  attempt?: number;
}

export interface NativeCriterionReviewVerdict {
  criterionId: string;
  verdict: "satisfied" | "unsatisfied";
  rationale: string;
  evidenceIds: string[];
  artifactHashes?: string[];
}

export interface NativeCriterionSubmissionProjection {
  taskId: string;
  attempt: number;
  acceptanceCriteriaVersion?: number;
  changeSetId?: string;
  criterionEvidenceLinks?: NativeCriterionEvidenceLink[];
}

export interface NativeGuidanceProjection {
  requestId: string;
  taskId: string;
  blocking: boolean;
  question: string;
  evidenceSequence: number;
  version: number;
  status: "open" | "answered";
  answer?: string;
  challengeEvidenceSequence?: number;
  challengedVersion?: number;
  challengeReason?: string;
}

export interface NativeReviewProjection {
  taskId: string;
  /** Omitted only for legacy projections that predate attempt binding. */
  attempt?: number;
  /** Omitted only for legacy projections that predate criterion versioning. */
  acceptanceCriteriaVersion?: number;
  status: "requested" | "approved" | "rejected";
  summary?: string;
  evidenceArtifactHashes: string[];
  criterionEvidenceLinks?: NativeCriterionEvidenceLink[];
  criterionVerdicts?: NativeCriterionReviewVerdict[];
}

export interface NativeUserGuidanceProjection {
  guidanceId: string;
  text: string;
  version: number;
  status: "submitted" | "acknowledged";
  /** Omitted only by Runner projections created before durable interruption completion. */
  interruptionStatus?: "pending" | "completed";
  resolution?:
    | { type: "no_plan_change"; rationale: string; evidenceIds: string[] }
    | {
        type: "plan_reconciled";
        rationale: string;
        planReconciliation: {
          revision: number;
          summary: string;
          taskUpdates: NativePlanTaskUpdate[];
          newTasks?: NativePlanNewTask[];
        };
      };
}

export interface NativePlanTaskUpdate {
  taskId: string;
  action: "cancel" | "revise";
  objective?: string;
  dependencies?: string[];
  requiredCapabilities?: string[];
  acceptanceCriteria?: NativeAcceptanceCriterion[];
}

export interface NativePlanNewTask {
  id: string;
  objective: string;
  dependencies: string[];
  requiredCapabilities: string[];
  acceptanceCriteria: NativeAcceptanceCriterion[];
}

export type NativeArchitectQuestionDecisionKind =
  | "authority_decision"
  | "destructive_action"
  | "requirement_conflict"
  | "external_dependency"
  | "control_weakening"
  | "repair_budget_exhausted";

export type NativeArchitectActionReason =
  | { type: "plan_required" }
  | { type: "acceptance_contract_upgrade_required" }
  | { type: "user_guidance_required"; guidanceId: string; version: number }
  | { type: "guidance_required"; requestId: string; taskId: string }
  | { type: "review_required"; taskId: string; changeSetId: string }
  | { type: "integration_approval_required"; taskId: string; changeSetId: string }
  | { type: "completion_decision_required"; runPolicy?: "plan_only" }
  | { type: "final_verification_plan_required"; integrationRevision: string }
  | {
      type: "final_verification_review_required";
      taskId: string;
      generationId: string;
      submissionId: string;
      targetRevision: string;
    }
  | {
      type: "final_verification_repair_plan_required";
      finalVerificationTaskId: string;
      generationId: string;
      targetRevision: string;
      source:
        | { type: "semantic_review"; submissionId: string; reviewId: string }
        | { type: "mechanical_failure"; failureId: string; issueIds: string[]; factIds: string[] };
      failedCategories: string[];
      evidenceIds: string[];
    }
  | {
      type: "verifier_repair_plan_required";
      reviewId: string;
      targetRevision: string;
      unsatisfiedCriteria: Array<{
        taskId: string;
        criterionId: string;
        rationale: string;
        evidenceIds: string[];
      }>;
    }
  | { type: "task_failure_resolution_required"; taskId: string; attempt: number; failureReason: string }
  | { type: "integration_resolution_required"; taskId: string };

export interface NativeArchitectQuestionProjection {
  questionId: string;
  question: string;
  version: number;
  decisionKind?: NativeArchitectQuestionDecisionKind;
  status: "open" | "answered";
  answer?: string;
  checkpoint?: {
    reason: NativeArchitectActionReason;
    sequence: number;
  };
  resumeStatus?: "pending" | "started" | "consumed" | "superseded";
  resumeStartedSequence?: number;
  resumeConsumedSequence?: number;
  resumeSupersededSequence?: number;
  supersededByGuidanceId?: string;
  supersededRationale?: string;
}

export type NativeBuildRiskReasonCode =
  | "architect_declared_high"
  | "stricter_qualification"
  | "destructive_effect"
  | "credential_effect"
  | "external_write_effect"
  | "integration_conflict"
  | "security_auth_crypto_path"
  | "migration_schema_data_path"
  | "dependency_lockfile"
  | "ci_deployment_infrastructure_path";

export interface NativeBuildRiskAssessmentProjection {
  targetRevision: string;
  input: {
    architectDeclaration: "low" | "high";
    stricterQualification: boolean;
    kernelFacts: {
      destructiveEffects: boolean;
      credentialEffects: boolean;
      externalWriteEffects: boolean;
      integrationConflict: boolean;
      changedPaths: string[];
    };
  };
  assessment: {
    risk: "low" | "high";
    reasons: Array<{ code: NativeBuildRiskReasonCode; evidence: string[] }>;
    normalizedChangedPaths: string[];
  };
  state: "current" | "invalidated" | "superseded";
  assessedAt: string;
  invalidatedByRevision?: string;
  invalidatedByGuidanceId?: string;
}

export interface NativeBuildRiskObservation {
  targetRevision: string;
  state: "current" | "invalidated" | "superseded";
  risk: "low" | "high";
  architectDeclaration: "low" | "high";
  architectRationale?: string;
  architectRiskSource?: "architect" | "legacy_default";
  stricterQualification: boolean;
  kernelFacts: {
    destructiveEffects: boolean;
    credentialEffects: boolean;
    externalWriteEffects: boolean;
    integrationConflict: boolean;
    changedPaths: string[];
  };
  reasons: Array<{ code: NativeBuildRiskReasonCode; evidence: string[] }>;
  normalizedChangedPaths: string[];
  assessedAt: string;
  invalidatedByRevision?: string;
  invalidatedByGuidanceId?: string;
}

export interface NativeVerifierRuntimeBinding {
  runtimeId: string;
  providerId: string;
  modelId: string;
  modelIdentity: string;
  sessionId: string;
}

export interface NativeVerifierReviewProjection {
  reviewId: string;
  targetRevision: string;
  finalVerificationGenerationId: string;
  runtime: NativeVerifierRuntimeBinding;
  excludedModels: Array<{
    source: "architect" | "accepted_change_author";
    runtimeId: string;
    modelIdentity: string;
  }>;
  criteria: Array<{ taskId: string; criterionId: string }>;
  status: "requested" | "submitted";
  state: "current" | "invalidated" | "superseded";
  requestedAt: string;
  invalidatedByRevision?: string;
  invalidatedByGuidanceId?: string;
  supersededByReviewId?: string;
  repairTaskIds?: string[];
  verdict?: {
    reviewId: string;
    targetRevision: string;
    sessionId: string;
    satisfied: boolean;
    criterionVerdicts: Array<{
      taskId: string;
      criterionId: string;
      verdict: "satisfied" | "unsatisfied";
      rationale: string;
      evidenceIds: string[];
    }>;
    submittedAt: string;
  };
}

export interface NativeIndependentVerifierObservability {
  policy?: {
    mode: "risk_based";
    candidateRuntimeIds: string[];
    alwaysRequireIndependentVerifier: boolean;
  };
  risk: {
    current?: NativeBuildRiskObservation;
    history: NativeBuildRiskObservation[];
  };
  selection?: {
    status: "required" | "selected";
    reason: string;
    requiredCapabilities: string[];
    candidateRuntimeIds: string[];
    selectedRuntimeId?: string;
  };
  review: {
    current?: NativeVerifierReviewProjection;
    history: NativeVerifierReviewProjection[];
  };
}

export interface NativeBuildProjection {
  runId: string;
  status: "running" | "paused" | "completed";
  pauseReason?: {
    reason: string;
    taskId?: string;
  };
  runPolicy?: BuildRunPolicy;
  planRevision: number;
  acceptanceContractStatus?: NativeAcceptanceContractStatus;
  acceptanceUpgradeRequiredEventRecorded?: boolean;
  tasks: Record<string, NativeBuildTask>;
  guidance: Record<string, NativeGuidanceProjection>;
  /** Optional only for projections cached from Runner versions before durable steering. */
  userGuidance?: Record<string, NativeUserGuidanceProjection>;
  userGuidanceVersion?: number;
  /** Optional only for projections cached from Runner versions before durable steering. */
  architectQuestions?: Record<string, NativeArchitectQuestionProjection>;
  architectQuestionVersion?: number;
  blockingArchitectQuestionId?: string;
  reviews: Record<string, NativeReviewProjection>;
  submissionHistory?: Record<string, NativeCriterionSubmissionProjection[]>;
  reviewHistory?: Record<string, NativeReviewProjection[]>;
  runtime: {
    providerHealth: Record<string, unknown>;
    workerAssignments: Record<string, { runtimeId: string }>;
    architect: {
      runtimeId?: string;
      handoff?: {
        reason: string;
        requiredCapabilities: string[];
        candidateRuntimeIds: string[];
      };
    };
  };
  projectHandoff?: {
    status: "requested" | "selected";
    summary: string;
    options: NativeProjectHandoffChoice[];
    choice?: NativeProjectHandoffChoice;
    integrationRevision?: string;
    integrationBranch?: string;
    appliedToProject?: boolean;
    projectRevision?: string;
  };
  verifierPolicy?: NativeIndependentVerifierObservability["policy"];
  buildRisk?: {
    current?: NativeBuildRiskAssessmentProjection;
    history: NativeBuildRiskAssessmentProjection[];
  };
  verifierSelection?: NativeIndependentVerifierObservability["selection"];
  verifier?: {
    current?: NativeVerifierReviewProjection;
    history: NativeVerifierReviewProjection[];
  };
  projectHandoffHistory?: Array<{
    status: "withdrawn";
    summary: string;
    options: NativeProjectHandoffChoice[];
    choice?: NativeProjectHandoffChoice;
    integrationRevision?: string;
    integrationBranch?: string;
    appliedToProject?: boolean;
    projectRevision?: string;
    withdrawnByGuidanceId: string;
  }>;
  integrationRevision?: string;
  finalVerification?: {
    current?: {
      taskId: string;
      generationId: string;
      targetRevision: string;
      planVersion: number;
      plan: { checks: Array<{ category: NativeFinalVerificationCategory; status: "required" | "not_applicable"; rationale?: string; repositoryInspection?: { paths: string[]; summary: string } }> };
      state: "current" | "invalidated";
      invalidatedByRevision?: string;
      invalidatedByGuidanceId?: string;
      cleanup?: { generationId: string; taskId: string; targetRevision: string; attempt: number; status: "started" | "succeeded" | "failed"; startedAt: string; finishedAt?: string; error?: string; diagnosticsPath?: string };
      failure?: { failureId: string; generationId: string; taskId: string; targetRevision: string; attempt: number; failedCategories: NativeFinalVerificationCategory[]; issueIds: string[]; factIds: string[]; evidenceIds: string[]; reportedAt: string };
      submission?: { submissionId: string; generationId: string; targetRevision: string; attempt: number };
      submissionResult?: { kind: "final_verification_submission"; generationId: string; runId: string; taskId: string; attempt: number; targetRevision: string; evidenceIds: string[]; submittedAt: string; green: boolean };
      review?: { reviewId: string; submissionId: string; generationId: string; targetRevision: string; attempt: number; status: "requested" | "approved" | "repair_required" | "rejected"; decision?: { decision: "approved" | "repair_required"; summary: string; targetRevision: string; architectRisk: { risk: "low" | "high"; rationale?: string; source: "architect" | "legacy_default" }; failedCategories: NativeFinalVerificationCategory[]; categoryReviews: Array<{ category: NativeFinalVerificationCategory; verdict: "approved" | "repair_required"; rationale: string; evidenceIds: string[] }> } };
      repairTaskIds?: string[];
      completedChecks?: Array<{ category: NativeFinalVerificationCategory; status: "required" | "not_applicable"; rationale?: string; green: boolean; evidenceIds: string[]; issues: string[]; attempt: number; startedAt: string; finishedAt: string }>;
    };
    history: Array<{ generationId: string; taskId: string; targetRevision: string; state: "invalidated"; invalidatedByRevision?: string; invalidatedByGuidanceId?: string }>;
  };
  lastSequence: number;
}

export interface NativeAcceptanceContractTaskProjection {
  acceptanceCriteria: NativeAcceptanceCriterion[];
  acceptanceCriteriaVersion?: number;
  criterionEvidenceLinks: NativeCriterionEvidenceLink[];
  criterionVerdicts: NativeCriterionReviewVerdict[];
  reviewStatus?: NativeReviewProjection["status"];
  submissionHistory: NativeCriterionSubmissionProjection[];
  reviewHistory: NativeReviewProjection[];
}

export interface NativeAcceptanceContractProjection {
  status: NativeAcceptanceContractStatus;
  planRevision: number;
  tasks: Record<string, NativeAcceptanceContractTaskProjection>;
}

export type NativeProjectHandoffChoice =
  | "keep_integration_branch"
  | "apply_to_project";

export interface NativeBuildEvent {
  sequence: number;
  type: string;
  occurredAt: string;
  actor: { role: string; id: string };
  payload: Record<string, unknown>;
}

export interface NativeBuildUsageProjection {
  scopeId: string;
  reservations: Record<string, NativeBudgetReservationProjection>;
  activeSegments: Record<string, unknown>;
  effective: {
    modelCalls: number;
    toolCalls: number;
    inputTokens: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    outputTokens: number;
    estimatedCostMicros: number;
    activeMs: number;
    artifactBytes: number;
  };
  lifetime?: {
    modelCalls: number;
    toolCalls: number;
    inputTokens: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    outputTokens: number;
    estimatedCostMicros: number;
    activeMs: number;
    artifactBytes: number;
  };
  window?: { index: number; startedAt?: string };
  attributedModelReservationCount?: number;
  models?: NativeModelUsageProjection[];
  lastSequence: number;
}

export interface NativeBudgetReservationProjection {
  reservationId: string;
  kind: "model" | "tool";
  attribution?: {
    runtimeId: string;
    providerId: string;
    modelId: string;
    role: "architect" | "worker" | "subagent" | "verifier";
    sessionId: string;
    taskId?: string;
  };
  estimate: {
    inputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    outputTokens?: number;
    estimatedCostMicros?: number;
    artifactBytes?: number;
  };
  actual?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    outputTokens?: number;
    estimatedCostMicros?: number;
    artifactBytes?: number;
  };
  tokenSources?: {
    inputTokens: "reported" | "estimated";
    outputTokens: "reported" | "estimated";
  };
  costBasis?: {
    kind: "api_estimate" | "account_not_metered" | "unknown";
  };
  settledAt?: string;
  status: "reserved" | "settled";
  windowIndex: number;
}

export type NativeModelUsageRole =
  | "architect"
  | "worker"
  | "subagent"
  | "verifier";
export type NativeModelUsageStatus =
  | "healthy"
  | "cooldown"
  | "unavailable"
  | "unused";
export type NativeModelCostBasis =
  | "api_estimate"
  | "account_not_metered"
  | "unknown";
export type NativeModelUsageQuality =
  | "reported"
  | "mixed"
  | "estimated"
  | "none";

export interface NativeModelUsageProjection {
  runtimeId: string;
  providerId: string;
  modelId: string;
  roles: NativeModelUsageRole[];
  status: NativeModelUsageStatus;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostMicros: number | null;
  costBasis: NativeModelCostBasis;
  usageQuality: NativeModelUsageQuality;
  lastUsedAt: string | null;
  displayName?: string;
  cooldownUntil?: number;
  failureCode?: string;
  failureSummary?: string;
}

export interface NativeCommandEvidenceFact {
  kind: "command";
  label: string;
  command: string;
  args: string[];
  cwd: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
  stdoutArtifactHash: string;
  stderrArtifactHash: string;
  repositoryRevision?: string;
}

export interface NativeBrowserSnapshotEvidenceFact {
  kind: "browser_snapshot";
  label: string;
  url: string;
  title: string;
  capturedAt: string;
  htmlArtifactHash: string;
  htmlBytes: number;
  truncated: boolean;
}

export interface NativeBrowserScreenshotEvidenceFact {
  kind: "browser_screenshot";
  label: string;
  capturedAt: string;
  screenshotArtifactHash: string;
  mediaType: "image/png";
  byteLength: number;
}

export interface NativeBrowserEventsEvidenceFact {
  kind: "browser_events";
  label: string;
  capturedAt: string;
  eventsArtifactHash: string;
  consoleEventCount: number;
  consoleErrorCount: number;
  networkEventCount: number;
  networkFailureCount: number;
}

export type NativeBuildEvidenceFact =
  | NativeCommandEvidenceFact
  | NativeBrowserSnapshotEvidenceFact
  | NativeBrowserScreenshotEvidenceFact
  | NativeBrowserEventsEvidenceFact;

export type NativeExecutionSafetyCapabilityName =
  | "tree_termination"
  | "crash_cleanup"
  | "verified_emptiness"
  | "write_confinement";
export type NativeExecutionSafetyCapabilityState = "enforced" | "partial" | "unavailable" | "unverified";
export interface NativeProcessRecoveryScope {
  kind: "subprocess" | "streaming";
  runId: string;
  invocationId: string;
  logicalProcessId: string;
  taskId?: string;
  sessionId?: string;
  revision: number;
  ownerId: string;
  fencingToken: number;
  rootPid?: number;
  state: string;
  backendIdentity: string;
  birthFingerprint: string;
}
export interface NativeProcessRecoveryRecord {
  version: 1;
  proposalId: string;
  callId: string;
  scope: NativeProcessRecoveryScope;
  requestedAction: "inspect" | "terminate" | "remove_owned_artifact";
  targetScope: string[];
  requestedCapabilities: NativeExecutionSafetyCapabilityName[];
  expiresAt: string;
  proposalFingerprint: string;
  commandFingerprint: string;
  argumentsFingerprint: string;
  rationaleFingerprint: string;
  createdAt: string;
  updatedAt: string;
  state: "proposed" | "user_decision_required" | "authorized" | "executing" | "executed" | "rejected" | "failed" | "outcome_unknown";
  reason: "submitted" | "validated" | "destructive_requires_user" | "user_approved" | "user_denied" | "scope_changed" | "expired" | "execution_started" | "inspection_completed" | "cleanup_verified" | "effect_failed" | "effect_outcome_unknown" | "resolved_by_verified_cleanup" | "model_failed";
  attemptId?: string;
  observation?: "running" | "exited" | "identity_mismatch" | "outcome_unknown";
  cleanupState?: "not_required" | "pending" | "verified_empty" | "failed";
}
export type NativeBuildExecutionSafetyObservability =
  | {
      availability: "live";
      fullBypass: boolean;
      isolation: {
        status: "unconfined_explicit_full" | "write_confinement_exact_grant" | "blocked" | "unverified";
        securityBoundary: "provider_specific_not_universal_security_boundary";
        activeLeaseCount: number;
        blockers: string[];
      };
      grants: { active: number; consumed: number };
      processes: Array<{
        kind: "subprocess" | "streaming";
        invocationId: string;
        logicalProcessId: string;
        lifecycleState: string;
        owned: boolean;
        pendingEffects: boolean;
        backend?: { backendId: string; implementationDigest: string; providerId?: string };
        lifecycle?: {
          scope: "process_group" | "contained_workload";
          termination: NativeExecutionSafetyCapabilityState;
          emptiness: NativeExecutionSafetyCapabilityState;
        };
        requiredLifecycleScope?: "process_group" | "contained_workload";
        capabilities: Record<NativeExecutionSafetyCapabilityName, NativeExecutionSafetyCapabilityState>;
        requiredCapabilities: string[];
        leaseExpiresAt?: string;
        cleanup: { state: "not_required" | "pending" | "verified_empty" | "failed"; detail?: string; verifiedAt?: string };
        output: { status: "complete" | "truncated" | "lossy"; totalBytes: number; truncated: boolean; lossyBytes: number } | { status: "unavailable" };
      }>;
      recovery: Array<Pick<NativeProcessRecoveryRecord, "proposalId" | "requestedAction" | "state" | "reason" | "updatedAt" | "observation" | "cleanupState">>;
    }
  | { availability: "unavailable"; reason: "historical_execution_safety_unavailable" };

export interface NativeBuildObservability {
  runId: string;
  budget: NativeBuildUsageProjection;
  toolCallCount: number;
  agents: Array<{
    sessionId: string;
    actor: { role: "architect" | "worker" | "subagent" | "verifier"; id: string };
    status: "active" | "suspended" | "submitted" | "completed";
    turns: number;
    suspensionReason?: string;
    error?: string;
    changeSetId?: string;
    lastSequence: number;
  }>;
  tools: Array<{
    sequence: number;
    sessionId: string;
    callId: string;
    toolName: string;
    extensionId?: string;
    status: "started" | "retrying" | "completed";
    occurredAt: string;
    isError?: boolean;
    errorCode?: string;
  }>;
  evidence: Array<{
    id: string;
    runId: string;
    taskId: string;
    actor: { role: "architect" | "worker" | "subagent" | "verifier"; id: string };
    status: "observed";
    fact: NativeBuildEvidenceFact;
    createdAt: string;
    idempotencyKey: string;
  }>;
  memories: Array<{
    id: string;
    content: string;
    concepts: string[];
    status: "proposed" | "promoted" | "archived";
    updatedAt: string;
  }>;
  skills: Array<{
    id: string;
    name: string;
    description: string;
    source: "project" | "built-in" | "user";
    digest: string;
  }>;
  processes: Array<{
    processId: string;
    sessionId: string;
    command: string;
    args: string[];
    status: "running" | "stopped" | "exited_unknown";
    startedAt: string;
    updatedAt: string;
    exitCode: number | null;
  }>;
  providers: Array<{
    providerId: string;
    status: "healthy" | "cooldown";
    consecutiveFailures: number;
    updatedAt: number;
    failureKind?: string;
    failureMessage?: string;
    cooldownUntil?: number;
  }>;
  events: Array<{
    sequence: number;
    type: string;
    occurredAt: string;
    actor: { role: string; id: string };
    payload: Record<string, unknown>;
  }>;
  git: {
    integrationBranch: string;
    integrationRevision: string;
    commits: Array<{ revision: string; parents: string[]; subject: string }>;
  };
  executionSafety?: NativeBuildExecutionSafetyObservability;
  finalVerification?: NativeFinalVerificationObservability;
  independentVerifier?: NativeIndependentVerifierObservability;
}

export interface NativeBuildAuditExport {
  protocolVersion: 2;
  run: NativeRunProjection;
  build: NativeBuildProjection;
  acceptanceContract: NativeAcceptanceContractProjection;
  usage: NativeBuildUsageProjection;
  observability: NativeBuildObservability;
  runEvents: Array<Record<string, unknown>>;
  buildEvents: NativeBuildEvent[];
}

/**
 * Projects the scheduler-owned acceptance contract into a stable client/audit
 * shape. Evidence links and Architect verdicts remain separate fields: the
 * presence of evidence never becomes a semantic verdict in this projection.
 */
export function projectNativeAcceptanceContract(
  projection: Pick<
    NativeBuildProjection,
    | "planRevision"
    | "tasks"
    | "reviews"
    | "submissionHistory"
    | "reviewHistory"
    | "acceptanceContractStatus"
  >
): NativeAcceptanceContractProjection {
  const tasks = Object.fromEntries(
    Object.values(projection.tasks).map((task) => {
      const candidateReview = projection.reviews[task.id];
      const review = candidateReview &&
        task.status !== "planned" &&
        isCurrentAcceptanceProjection(task, candidateReview)
        ? candidateReview
        : undefined;
      const criterionEvidenceLinks = (task.criterionEvidenceLinks ?? [])
        .filter((link) => link.attempt === undefined || link.attempt === task.attempt);
      return [task.id, {
        acceptanceCriteria: (task.acceptanceCriteria ?? []).map((criterion) => ({
          id: criterion.id,
          text: criterion.text,
        })),
        ...(task.acceptanceCriteriaVersion !== undefined
          ? { acceptanceCriteriaVersion: task.acceptanceCriteriaVersion }
          : {}),
        criterionEvidenceLinks: criterionEvidenceLinks.map((link) => ({
          criterionId: link.criterionId,
          evidenceId: link.evidenceId,
          artifactHashes: [...link.artifactHashes],
          ...(link.taskId !== undefined ? { taskId: link.taskId } : {}),
          ...(link.attempt !== undefined ? { attempt: link.attempt } : {}),
        })),
        criterionVerdicts: (review?.criterionVerdicts ?? []).map((verdict) => ({
          criterionId: verdict.criterionId,
          verdict: verdict.verdict,
          rationale: verdict.rationale,
          evidenceIds: [...verdict.evidenceIds],
          ...(verdict.artifactHashes
            ? { artifactHashes: [...verdict.artifactHashes] }
            : {}),
        })),
        ...(review ? { reviewStatus: review.status } : {}),
        submissionHistory: (projection.submissionHistory?.[task.id] ?? []).map(
          cloneNativeSubmissionProjection
        ),
        reviewHistory: (projection.reviewHistory?.[task.id] ?? []).map(
          cloneNativeReviewProjection
        ),
      } satisfies NativeAcceptanceContractTaskProjection];
    })
  ) as Record<string, NativeAcceptanceContractTaskProjection>;
  return {
    status: projection.acceptanceContractStatus ?? "current",
    planRevision: projection.planRevision,
    tasks,
  };
}

function isCurrentAcceptanceProjection(
  task: NativeBuildTask,
  projection: Pick<NativeReviewProjection, "attempt" | "acceptanceCriteriaVersion">
): boolean {
  return (
    (projection.attempt === undefined || projection.attempt === task.attempt) &&
    (projection.acceptanceCriteriaVersion === undefined ||
      task.acceptanceCriteriaVersion === undefined ||
      projection.acceptanceCriteriaVersion === task.acceptanceCriteriaVersion)
  );
}

function cloneNativeSubmissionProjection(
  submission: NativeCriterionSubmissionProjection
): NativeCriterionSubmissionProjection {
  return {
    ...submission,
    ...(submission.criterionEvidenceLinks
      ? {
          criterionEvidenceLinks: submission.criterionEvidenceLinks.map((link) => ({
            ...link,
            artifactHashes: [...link.artifactHashes],
          })),
        }
      : {}),
  };
}

function cloneNativeReviewProjection(
  review: NativeReviewProjection
): NativeReviewProjection {
  return {
    ...review,
    evidenceArtifactHashes: [...review.evidenceArtifactHashes],
    ...(review.criterionEvidenceLinks
      ? {
          criterionEvidenceLinks: review.criterionEvidenceLinks.map((link) => ({
            ...link,
            artifactHashes: [...link.artifactHashes],
          })),
        }
      : {}),
    ...(review.criterionVerdicts
      ? {
          criterionVerdicts: review.criterionVerdicts.map((verdict) => ({
            ...verdict,
            evidenceIds: [...verdict.evidenceIds],
            ...(verdict.artifactHashes
              ? { artifactHashes: [...verdict.artifactHashes] }
              : {}),
          })),
        }
      : {}),
  };
}

export interface NativeBuildStepResult {
  status: "progressed" | "paused" | "completed" | "idle" | "blocked";
  action?: string;
}

export interface SubmitNativeBuildUserGuidanceInput {
  guidanceId: string;
  text: string;
  idempotencyKey: string;
}

export interface AnswerNativeArchitectQuestionInput {
  expectedVersion: number;
  answer: string;
  idempotencyKey: string;
}

export interface NativeRunProjection {
  runId: string;
  state: "created" | "running" | "paused" | "stopping" | "stopped" | "completed" | "failed";
  projectPath: string;
  permissionProfile: "guarded" | "project" | "full";
  createdAt: string;
  updatedAt: string;
  lastSequence: number;
  stopReason?: string;
}

export interface NativeBuildReference {
  runId: string;
  projectId: string;
  state: NativeRunProjection["state"];
  createdAt: string;
  updatedAt: string;
}

export type NativeBuildActorRole =
  | "architect"
  | "worker"
  | "subagent"
  | "verifier";

export interface NativeBuildTranscriptTurn {
  id: string;
  sessionId: string;
  actor: { role: NativeBuildActorRole; id: string };
  sequence: number;
  ordinal: number;
  occurredAt: string;
  text: string;
}

export interface NativeBuildTranscriptPage {
  turns: NativeBuildTranscriptTurn[];
  cursor: number;
}

export interface NativeBuildFileSnapshot {
  source: "integration" | "project";
  revision: string;
  appliedToProject: boolean;
  omittedFileCount: number;
  files: Array<{ path: string; content: string }>;
}

export class NativeRunnerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "NativeRunnerError";
  }
}

export async function getNativeRunnerHealth(
  connection: NativeRunnerConnection,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<NativeRunnerHealth> {
  return await request(connection, "/v2/health", { signal }, fetchImpl);
}

export async function configureNativeProviders(
  connection: NativeRunnerConnection,
  configs: readonly NativeProviderConfig[],
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<void> {
  await request(connection, "/v2/provider-configs", {
    method: "PUT",
    body: JSON.stringify({ configs }),
    signal,
  }, fetchImpl);
}

export async function createNativeBuild(
  connection: NativeRunnerConnection,
  input: CreateNativeBuildInput,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<void> {
  await request(connection, "/v2/runs", {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  }, fetchImpl);
}

export async function commandNativeRun(
  connection: NativeRunnerConnection,
  runId: string,
  command: "start" | "pause" | "resume" | "continue" | "stop",
  idempotencyKey: string,
  reason?: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<void> {
  await request(connection, `/v2/runs/${encodeURIComponent(runId)}/commands`, {
    method: "POST",
    body: JSON.stringify({ command, idempotencyKey, ...(reason ? { reason } : {}) }),
    signal,
  }, fetchImpl);
}

export async function getNativeRun(
  connection: NativeRunnerConnection,
  runId: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<NativeRunProjection> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}`,
    { signal },
    fetchImpl
  );
}

export async function getNativeBuild(
  connection: NativeRunnerConnection,
  runId: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<NativeBuildProjection> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build`,
    { signal },
    fetchImpl
  );
}

export async function getNativeBuildReferences(
  connection: NativeRunnerConnection,
  projectId: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<NativeBuildReference[]> {
  const result = await request<{ builds: NativeBuildReference[] }>(
    connection,
    `/v2/builds?projectId=${encodeURIComponent(projectId)}`,
    { signal },
    fetchImpl
  );
  return result.builds;
}

export async function resolveNativeBuildRunId(
  connection: NativeRunnerConnection,
  savedRunId: string,
  projectId: string,
  fetchImpl?: typeof fetch
): Promise<string>;
export async function resolveNativeBuildRunId(
  connection: NativeRunnerConnection,
  savedRunId: string,
  projectId: string,
  fetchImpl: typeof fetch,
  options: { allowMissing: true; requestedAt?: string | null }
): Promise<string | undefined>;
export async function resolveNativeBuildRunId(
  connection: NativeRunnerConnection,
  savedRunId: string,
  projectId: string,
  fetchImpl: typeof fetch = fetch,
  options: { allowMissing?: boolean; requestedAt?: string | null } = {}
): Promise<string | undefined> {
  const [references, savedExists] = await Promise.all([
    getNativeBuildReferences(connection, projectId, fetchImpl),
    getNativeBuild(connection, savedRunId, fetchImpl).then(
      () => true,
      (error: unknown) => {
        if (error instanceof NativeRunnerError && error.status === 404) return false;
        throw error;
      }
    ),
  ]);

  const requestedAt = options.requestedAt
    ? Date.parse(options.requestedAt)
    : Number.NaN;
  const intentionalNewPass = options.allowMissing && Number.isFinite(requestedAt);
  const eligibleReferences = intentionalNewPass
    ? references.filter((reference) => Date.parse(reference.createdAt) >= requestedAt)
    : references;
  const newestReference = [...eligibleReferences].sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt < right.createdAt ? 1 : -1;
    }
    if (left.runId === right.runId) return 0;
    return left.runId < right.runId ? 1 : -1;
  })[0];
  if (newestReference) return newestReference.runId;
  if (savedExists) return savedRunId;
  if (options.allowMissing) return undefined;
  throw new Error(
    `The saved Runner V2 Build ${savedRunId} no longer exists, and this project has no matching Build reference.`
  );
}

export async function getNativeBuildTranscript(
  connection: NativeRunnerConnection,
  runId: string,
  afterSequence = 0,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<NativeBuildTranscriptPage> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/transcript?after=${afterSequence}`,
    { signal },
    fetchImpl
  );
}

export async function getNativeBuildFiles(
  connection: NativeRunnerConnection,
  runId: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<NativeBuildFileSnapshot> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/files`,
    { signal },
    fetchImpl
  );
}

export async function getNativeBuildUsage(
  connection: NativeRunnerConnection,
  runId: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<NativeBuildUsageProjection> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/usage`,
    { signal },
    fetchImpl
  );
}

export async function getNativeBuildObservability(
  connection: NativeRunnerConnection,
  runId: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<NativeBuildObservability> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/observability`,
    { signal },
    fetchImpl
  );
}

export async function getNativeProcessRecovery(
  connection: NativeRunnerConnection,
  runId: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<NativeProcessRecoveryRecord[]> {
  const result = await request<{ records: NativeProcessRecoveryRecord[] }>(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/recovery`,
    { signal },
    fetchImpl,
  );
  return result.records;
}

export async function generateNativeProcessRecovery(
  connection: NativeRunnerConnection,
  runId: string,
  invocationId: string,
  proposalId: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<NativeProcessRecoveryRecord> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/recovery/generate`,
    { method: "POST", body: JSON.stringify({ invocationId, proposalId }), signal },
    fetchImpl,
  );
}

export async function decideNativeProcessRecovery(
  connection: NativeRunnerConnection,
  runId: string,
  proposalId: string,
  fingerprint: string,
  decision: "approve" | "reject",
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<NativeProcessRecoveryRecord> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/recovery/${encodeURIComponent(proposalId)}/decision`,
    { method: "POST", body: JSON.stringify({ fingerprint, decision }), signal },
    fetchImpl,
  );
}

export async function executeNativeProcessRecovery(
  connection: NativeRunnerConnection,
  runId: string,
  proposalId: string,
  fingerprint: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<NativeProcessRecoveryRecord> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/recovery/${encodeURIComponent(proposalId)}/execute`,
    { method: "POST", body: JSON.stringify({ fingerprint }), signal },
    fetchImpl,
  );
}

export async function getNativeBuildAudit(
  connection: NativeRunnerConnection,
  runId: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<NativeBuildAuditExport> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/audit`,
    { signal },
    fetchImpl
  );
}

export async function getNativeBuildEvents(
  connection: NativeRunnerConnection,
  runId: string,
  afterSequence = 0,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<NativeBuildEvent[]> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/events?after=${afterSequence}`,
    { signal },
    fetchImpl
  );
}

export async function pumpNativeBuild(
  connection: NativeRunnerConnection,
  runId: string,
  maxSteps = 100,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<NativeBuildStepResult> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/run`,
    {
      method: "POST",
      body: JSON.stringify({ maxSteps }),
      signal,
    },
    fetchImpl
  );
}

export async function submitNativeBuildUserGuidance(
  connection: NativeRunnerConnection,
  runId: string,
  input: SubmitNativeBuildUserGuidanceInput,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<NativeBuildProjection> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/user-guidance`,
    { method: "POST", body: JSON.stringify(input), signal },
    fetchImpl,
  );
}

export async function answerNativeArchitectQuestion(
  connection: NativeRunnerConnection,
  runId: string,
  questionId: string,
  input: AnswerNativeArchitectQuestionInput,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<NativeBuildProjection> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/architect-questions/${encodeURIComponent(questionId)}/answer`,
    { method: "POST", body: JSON.stringify(input), signal },
    fetchImpl,
  );
}

export async function stepNativeBuild(
  connection: NativeRunnerConnection,
  runId: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<NativeBuildStepResult> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/step`,
    { method: "POST", body: "{}", signal },
    fetchImpl
  );
}

export async function selectNativeArchitectHandoff(
  connection: NativeRunnerConnection,
  runId: string,
  runtimeId: string,
  idempotencyKey: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<NativeBuildProjection> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/architect-handoff`,
    {
      method: "POST",
      body: JSON.stringify({ runtimeId, idempotencyKey }),
      signal,
    },
    fetchImpl
  );
}

export async function selectNativeVerifierRuntime(
  connection: NativeRunnerConnection,
  runId: string,
  runtimeId: string,
  idempotencyKey: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<NativeBuildProjection> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/verifier-handoff`,
    {
      method: "POST",
      body: JSON.stringify({ runtimeId, idempotencyKey }),
      signal,
    },
    fetchImpl,
  );
}

export async function selectNativeProjectHandoff(
  connection: NativeRunnerConnection,
  runId: string,
  choice: NativeProjectHandoffChoice,
  idempotencyKey: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<NativeBuildProjection> {
  return await request(
    connection,
    `/v2/runs/${encodeURIComponent(runId)}/build/project-handoff`,
    {
      method: "POST",
      body: JSON.stringify({ choice, idempotencyKey }),
      signal,
    },
    fetchImpl
  );
}

export async function getNativePermissions(
  connection: NativeRunnerConnection,
  runId: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<NativePermissionRequest[]> {
  const result = await request<{ permissions: NativePermissionRequest[] }>(
    connection,
    `/v2/permissions?runId=${encodeURIComponent(runId)}`,
    { signal },
    fetchImpl
  );
  return result.permissions;
}

export async function decideNativePermission(
  connection: NativeRunnerConnection,
  requestId: string,
  decision: "approved" | "denied",
  idempotencyKey: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<NativePermissionRequest> {
  return await request(
    connection,
    `/v2/permissions/${encodeURIComponent(requestId)}`,
    {
      method: "POST",
      body: JSON.stringify({ decision, idempotencyKey }),
      signal,
    },
    fetchImpl
  );
}

async function request<T>(
  connection: NativeRunnerConnection,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch
): Promise<T> {
  const response = await fetchImpl(`${connection.url.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const data = await response.json().catch(() => ({})) as {
    error?: string;
    code?: string;
  } & T;
  if (!response.ok) {
    throw new NativeRunnerError(
      data.error ?? `Native runner request failed (HTTP ${response.status}).`,
      response.status,
      data.code
    );
  }
  return data;
}
