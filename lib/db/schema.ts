export type {
  GameAIInteraction,
  GameExport,
  GameId,
  GameParticipant,
  GameSessionRecord,
  GameSessionStatus,
  GenericGameMatchRecord,
} from "@/lib/games/core/types";
import type {
  BuildSkillEvent,
  BuildSkillMode,
  SkillEvidence,
} from "@/lib/skills/types";
import type { ModelContextOverrides } from "@/lib/providers/model-context";
import type { BuildPhaseSpec } from "@/lib/orchestrator/build";
import type { BuildPlanContractValidation } from "@/lib/orchestrator/build-plan-contract";
import type { BuildEvidenceLedgerEntry } from "@/lib/orchestrator/build-progress";
import type { BuildTaskVerificationFact } from "@/lib/orchestrator/build-review-evidence";
export type {
  ContextBlob,
  ContextBlobKind,
  ContextBlobMetadata,
} from "@/lib/build-context/context-store";
export type {
  BuildMemoryEvidenceKind,
  BuildMemoryEvidenceRef,
  BuildMemoryKind,
  BuildMemoryRecord,
  BuildMemoryStatus,
} from "@/lib/build-context/memory-store";
export type { BuildSkillMode } from "@/lib/skills/types";

export interface ModelPricingOverride {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cachedInputUsdPer1M?: number | null;
  updatedAt: string;
}

export type BuildRunPolicy = "finish" | "budgeted" | "plan_only";
export type BuildStopReason =
  | "budget"
  | "time"
  | "blocked"
  | "user"
  | "completed";

export interface BuildUsageModelTotal {
  modelId: string;
  modelName: string;
  providerId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedUsd: number | null;
  priced: boolean;
}

export interface BuildUsageWindow {
  startedAt: string;
  elapsedMs: number;
  estimatedUsd: number;
  unknownPricedModelIds: string[];
  models: BuildUsageModelTotal[];
}

export type BuildProblemSeverity = "info" | "warning" | "error" | "blocked";
export type BuildProblemSource =
  | "engine"
  | "architect"
  | "reviewer"
  | "worker"
  | "file_writer"
  | "runner"
  | "mcp";
export type BuildProblemCode =
  | "malformed_tool_call"
  | "tool_warning"
  | "empty_tool_batch"
  | "duplicate_tool_call"
  | "budget_exhausted"
  | "verification_failed"
  | "verification_repeated"
  | "patch_failed"
  | "edit_failed"
  | "write_conflict"
  | "write_scope_rejected"
  | "suspicious_rewrite"
  | "large_existing_file_rewrite"
  | "truncated_output"
  | "command_failed"
  | "tool_denied"
  | "no_output"
  | "skill_evidence_missing"
  | "browser_acceptance_missing"
  | "request_fulfillment_missing"
  | "repeated_no_progress"
  | "incomplete_tasks"
  | "quality_gate_failed"
  | "review_fix_required"
  | "review_contract_invalid"
  | "plan_contract_invalid"
  | "plan_critique_unresolved";

export interface BuildProblem {
  id: string;
  createdAt: string;
  code: BuildProblemCode;
  severity: BuildProblemSeverity;
  source: BuildProblemSource;
  message: string;
  details?: string;
  modelId?: string;
  modelName?: string;
  providerId?: string;
  taskId?: string;
  action?: string;
  path?: string;
  wave?: number;
}

export interface BuildCommandProblem {
  command: string;
  exitCode: number;
  durationMs: number;
  outputPreview: string;
  cwd?: string;
  denied?: boolean;
  background?: boolean;
  createdAt: string;
}

export interface BuildToolReviewGroup {
  key: string;
  code: BuildProblemCode;
  source: BuildProblemSource;
  severity: BuildProblemSeverity;
  actor: string;
  count: number;
  latestAt: string;
  latestMessage: string;
  taskId?: string;
  action?: string;
}

export interface BuildToolReviewReport {
  id: string;
  discussionId: string;
  createdAt: string;
  topic: string;
  status: string;
  wave: number;
  summary: string;
  totalProblems: number;
  warningCount: number;
  errorCount: number;
  blockedCount: number;
  groups: BuildToolReviewGroup[];
  problems: BuildProblem[];
  commandProblems: BuildCommandProblem[];
}

export interface BuildStopReport {
  id: string;
  discussionId: string;
  createdAt: string;
  topic: string;
  status: string;
  stopReason: BuildStopReason | "failed" | "incomplete";
  stopMessage: string;
  wave: number;
  branch: string | null;
  prUrl: string | null;
  verifyCommand: string;
  summary: string;
  nextAction: string;
  tasksDone: number;
  tasksTotal: number;
  incompleteTasks: Array<{
    id: string;
    title: string;
    status: BuildCheckpointTask["status"];
    failCount?: number;
  }>;
  primaryCause: BuildProblem | null;
  problems: BuildProblem[];
  commandProblems: BuildCommandProblem[];
  repeatedFailureCount: number;
  recoveryLog: string[];
}

export interface BuildTaskGuidanceRecord {
  id: string;
  taskId: string;
  mode: "blocking" | "async";
  question: string;
  reason?: string;
  status: "pending" | "answered";
  answer?: string;
  requestedBy?: string;
  requestedAtWave: number;
  answeredAtWave?: number;
}

export interface BuildCheckpointTask {
  id: string;
  title: string;
  instructions: string;
  reviewInstructions?: string;
  retryInstructions?: string;
  nextAttemptPhase?: "gathering" | "finalizing";
  kind?: "modify" | "audit" | "verify" | "repo";
  completionMode?: "files" | "evidence" | "either";
  verificationPolicy?: "architect" | "tool" | "external" | "none";
  requiredEvidence?: string[];
  requiredToolActions?: string[];
  contextFiles: string[];
  outputPaths?: string[];
  expectedOutputs?: string;
  phaseSpec?: BuildPhaseSpec;
  status: "planned" | "in_progress" | "review" | "fixing" | "done" | "failed";
  dependsOn?: string[];
  assignTo?: string;
  workerIndex?: number;
  failCount?: number;
  retryAfterMs?: number;
  avoidWorkerIndexes?: number[];
  difficulty?: number;
  guidance?: BuildTaskGuidanceRecord[];
}

export interface BuildCheckpoint {
  discussionId: string;
  status: "running" | "stopped" | "blocked" | "completed";
  updatedAt: string;
  engineVersion?: string;
  checkpointContractVersion?: number;
  runPolicy: BuildRunPolicy;
  stopReason?: BuildStopReason | null;
  wave: number;
  tasks: BuildCheckpointTask[];
  architectNotes: string;
  verifyCommand: string;
  phaseSpec?: BuildPhaseSpec;
  branch: string | null;
  prUrl: string | null;
  milestone: string | null;
  issueNumbers: number[];
  failureFingerprints: Record<string, number>;
  recoveryLog: string[];
  planContractValidation?: BuildPlanContractValidation;
  planContractRevisionCount?: number;
  buildProblems?: BuildProblem[];
  commandProblems?: BuildCommandProblem[];
  stopReport?: BuildStopReport | null;
  toolReviewReport?: BuildToolReviewReport | null;
  evidenceLedger?: BuildEvidenceLedgerEntry[];
  taskVerificationFacts?: BuildTaskVerificationFact[];
  usageWindow: BuildUsageWindow;
  skillMode?: BuildSkillMode;
  skillEvidence?: SkillEvidence[];
  skillEvents?: BuildSkillEvent[];
}

export interface UserSettings {
  id: string;
  defaultEffort: EffortLevel;
  defaultMode: DiscussionMode;
  judgeModelId: string | null;
  defaultVerbosity?: Verbosity;
  defaultStyleNote?: string;
  defaultReasoningEffort?: ReasoningEffort;
  defaultBuildRunPolicy?: BuildRunPolicy;
  defaultBuildSkillMode?: BuildSkillMode;
  defaultBuildBudgetUsd?: number;
  defaultBuildTimeLimitMinutes?: number;
  modelPricingOverrides?: Record<string, ModelPricingOverride>;
  modelContextOverrides?: ModelContextOverrides;
}

export interface ProviderKey {
  providerId: string;
  // Server representation: AES-encrypted at rest with ENCRYPTION_SECRET.
  encryptedKey?: string;
  iv?: string;
  authTag?: string;
  // Client representation: plaintext key, protected by the store-level passphrase
  // envelope (see lib/client/crypto-box.ts). Set after the browser-side migration.
  apiKey?: string;
  /** Endpoint override for gateway providers (e.g. Azure AI Foundry). */
  baseURL?: string | null;
  /** Local provider-runner token for providers that use a CORS proxy. */
  runnerToken?: string | null;
  runnerTokenHint?: string | null;
  /**
   * User-defined model ids for gateway providers whose available models depend
   * on the user's own deployment (Azure AI Foundry). Empty/absent for providers
   * with a fixed catalog.
   */
  models?: string[] | null;
  defaultModel: string | null;
  enabled: boolean;
  keyHint: string | null;
  lastValidationSucceeded?: boolean | null;
  lastValidatedAt?: string | null;
  updatedAt: string;
}

export interface Discussion {
  id: string;
  topic: string;
  mode: DiscussionMode;
  effort: EffortLevel;
  status: DiscussionStatus;
  modelIds: string;
  judgeModelId: string | null;
  /**
   * Build mode: optional mid-tier model that pre-screens the workers' code
   * each wave and hands the (expensive) Architect a compact digest instead
   * of full files.
   */
  reviewerModelId?: string | null;
  attachmentIds: string | null;
  /** Build mode: display name of the granted project folder (handle lives in IndexedDB). */
  projectFolderName?: string | null;
  /** Build mode: optional local command runner (user-started; opt-in). */
  runnerUrl?: string | null;
  runnerToken?: string | null;
  /** "ask" = approve each command in the UI; "full" = run without asking. */
  runnerAccess?: "ask" | "full" | null;
  buildRunPolicy?: BuildRunPolicy;
  buildSkillMode?: BuildSkillMode;
  buildBudgetUsd?: number;
  buildTimeLimitMinutes?: number;
  buildStopReason?: BuildStopReason | null;
  buildStoppedAt?: string | null;
  currentRound: number;
  maxRounds: number;
  convergenceScore: number | null;
  verbosity?: Verbosity;
  styleNote?: string | null;
  reasoningEffort?: ReasoningEffort;
  createdAt: string;
  updatedAt: string;
}

/**
 * A user-defined, OpenAI-API-compatible model endpoint (e.g. a local Gemma via
 * Ollama/LM Studio, or any hosted OpenAI-compatible server). Reached with the
 * OpenAI SDK pointed at `baseURL`. Treated as text-only.
 */
export interface CustomModel {
  id: string;
  label: string;
  baseURL: string;
  model: string;
  encryptedKey?: string | null;
  iv?: string | null;
  authTag?: string | null;
  /** Client representation: plaintext key, protected by the store-level envelope. */
  apiKey?: string;
  hasKey: boolean;
  /** Which non-text inputs this endpoint accepts. Defaults to all false. */
  capabilities?: {
    image: boolean;
    document: boolean;
    audio: boolean;
    video: boolean;
  };
  lastValidationSucceeded?: boolean | null;
  lastValidatedAt?: string | null;
  createdAt: string;
}

export interface Message {
  id: string;
  discussionId: string;
  round: number;
  modelId: string;
  role: string;
  content: string;
  createdAt: string;
}

export interface FinalResult {
  discussionId: string;
  answer: string;
  confidence: number;
  dissent: string | null;
  createdAt: string;
}

/**
 * A file produced by a build, persisted per discussion so follow-up passes
 * and resumes see everything already built (the in-memory virtual FS alone
 * dies with the run).
 */
export interface BuildFileRecord {
  discussionId: string;
  path: string;
  content: string;
  updatedAt: string;
}

/**
 * Global, per-model Build-mode performance, accumulated across every build
 * the user runs (the in-run scoreboard dies with the run; this persists).
 * Three honest axes are kept separate rather than collapsed into one number:
 *  - QUALITY: approvals/fixes/badOutput, plus difficulty-weighted (w*) tallies
 *    so a hard-task approval counts more than a trivial one.
 *  - SPEED: responseChars / responseMs — successful responses only.
 *  - RELIABILITY: unavailable (provider denials/timeouts) vs attempts; these
 *    never touch the quality score (a free-tier 429 isn't the model's fault).
 * `judges` records who graded this model (and how many verdicts each made),
 * with independentVerdicts = verdicts by a judge other than this model itself,
 * so a future leaderboard can filter out self-graded / weak-judge noise.
 * Both count Architect approve/fix verdicts only — engine-detected bad output
 * and provider denials are not judge verdicts and never appear here.
 */
export interface ModelBuildStat {
  /** Full namespaced id (providerId:modelId). */
  modelId: string;
  displayName: string;
  builds: number;
  attempts: number;
  approvals: number;
  fixes: number;
  badOutput: number;
  unavailable: number;
  /** Difficulty-weighted (weight = difficulty/3) quality tallies. */
  wApprovals: number;
  wFixes: number;
  wBadOutput: number;
  /** Time + output of successful responses only (for clean throughput). */
  responseMs: number;
  responseChars: number;
  /**
   * Worker token totals across ALL of this model's Build calls (tool turns +
   * finalize), including calls on tasks that later failed or were fixed — the
   * point of the tokens-per-approved-task KPI is that failure waste is visible.
   * Reviews/architect/critique calls are never worker-attributed here.
   */
  inputTokens: number;
  outputTokens: number;
  /** judge modelId -> Architect approve/fix verdicts that judge contributed. */
  judges: Record<string, number>;
  /** Architect approve/fix verdicts made by a judge that was NOT this model. */
  independentVerdicts: number;
  updatedAt: string;
}

export type DiscussionStatus =
  | "pending"
  | "running"
  | "completed"
  | "stopped"
  | "failed";

export type DiscussionMode = "panel" | "debate" | "specialist" | "build";
export type EffortLevel = "low" | "medium" | "high";
export type Verbosity = "brief" | "balanced" | "comprehensive" | "exhaustive";
/** Per-model reasoning effort, mapped to each provider's parameter. */
export type ReasoningEffort =
  | "default"
  | "none"
  | "low"
  | "medium"
  | "high"
  | "max";

// Legacy schema export for imports
export const schema = {};
