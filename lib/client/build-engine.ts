/**
 * Build mode runner: the Architect (judge model) plans tasks, worker models
 * implement them with focused context, the Architect reviews/fixes and adds
 * tasks until done. Files are written immediately — always to a virtual FS
 * (drives the artifact panel / zip), and also to the user's project folder
 * when one was granted.
 */

import { v4 as uuidv4 } from "uuid";
import type {
  BuildCheckpoint,
  BuildCommandProblem,
  BuildProblem,
  BuildStopReport,
  BuildStopReason,
  BuildToolReviewReport,
  Discussion,
  EffortLevel,
  ReasoningEffort,
  Verbosity,
} from "@/lib/db/schema";
import type { AttachmentPayload } from "@/lib/attachments/types";
import { modelSupportsInputTypes } from "@/lib/providers/capabilities";
import type {
  ChatMessage,
  NativeToolDefinition,
  SelectedModel,
  StreamUsage,
  StructuredOutputFormat,
} from "@/lib/providers/base";
import { parseModelId } from "@/lib/providers/base";
import {
  resolveClientModelContextProfile,
  resolveModelName,
} from "./providers";
import {
  BUILD_INTEGRATOR_MIN_TOKENS,
  BUILD_MAX_WAVES,
  BUILD_ROUND_MIN_TOKENS,
  BUILD_TASKS_PER_WAVE,
  EFFORT_CONFIG,
} from "@/lib/orchestrator/config";
import {
  normalizeBuildSettings,
  shouldStopForBuildGuardrail,
} from "@/lib/orchestrator/build-policy";
import {
  createBuildWorkerBudget,
  workerBudgetToolInstructionInput,
  type BuildWorkerToolInstructionBudget,
} from "@/lib/orchestrator/build-worker-budgets";
import {
  buildVerificationFailureTask,
  fingerprintBuildFailure,
  hasMeaningfulBuildProgress,
  recordBuildFailure,
  shouldStopForNoProgress,
} from "@/lib/orchestrator/build-progress";
import {
  createToolReplayCache,
  packToolBatchResult,
  scheduleBuildToolActions,
  skippedOnlyToolBatchRecoveryInstruction,
} from "@/lib/orchestrator/build-tool-scheduler";
import { createBuildStopReport } from "@/lib/orchestrator/build-stop-report";
import { createBuildToolReviewReport } from "@/lib/orchestrator/build-tool-review-report";
import {
  buildSkillEvidenceFixInstructions,
  evidenceOnlyRetryFiles,
  getBlockingSkillEvidence,
  isWorkerOutputBlockedByToolBudget,
  shouldAllowEvidenceOnlySkillExemptions,
  shouldReviewEvidenceOnlyTask,
  splitEvidenceOnlyReviewIssues,
} from "@/lib/orchestrator/build-evidence-gates";
import {
  filterBuildMcpToolsForPrompt,
  shouldRetryPlaywrightNavigateAfterClosedTarget,
  validateBuildMcpToolAction,
} from "@/lib/orchestrator/build-tool-safety";
import {
  evaluateBuildQualityGate,
  formatBuildQualityGateSummary,
  shouldRequireBrowserAcceptance,
  type BuildQualityGateRepoStatus,
  type BuildQualityRequiredCheck,
} from "@/lib/orchestrator/build-quality-gates";
import {
  addBuildUsageCall,
  createBuildUsageWindow,
  estimatedUsdForTokens,
} from "./build-usage";
import { getModelPricing } from "@/lib/providers/pricing";
import {
  createGameModelCallTrace,
  type GameAIDiagnosticLike,
  recordBenchmarkModelCallTrace,
} from "@/lib/benchmark/model-call-traces";
import type {
  BenchmarkRunEvent,
  BenchmarkToolCallTrace,
  HarnessProfile,
} from "@/lib/benchmark/types";
import type {
  CertifiedModelCallReservation,
  CertifiedModelCallUsage,
} from "@/lib/benchmark/certified/budget";
import { buildVerbosityInstruction } from "@/lib/orchestrator/prompts";
import { extractJudgeResult } from "@/lib/orchestrator/parse";
import { applyEditOps, extractArtifacts } from "@/lib/artifacts/extract";
import {
  buildCommandOutputDigest,
  buildFetchDigest,
  buildRepoDiffDigest,
  buildToolExchangeDigest,
  createContextBlob,
  formatBuildCheckCommandPreview,
  formatBuildCheckContextText,
  formatBuildCheckOutputSections,
  formatContextBlobForPrompt,
  formatFetchContextText,
  formatMcpToolContextText,
  retrieveContextBlobText,
  type ContextBlobKind,
} from "@/lib/build-context/context-store";
import {
  BuildContextManager,
  codeIntelResultToContextPack,
  createCodeIntelPhaseBudget,
  createCodeIntelProvider,
  filterCodebaseMemoryMcpToolsForGenericUse,
  isGenericMcpToolAllowed,
  shouldAutoIncludeCodeIntelArchitecture,
  type AssembledBuildContext,
  type CodeIntelStatus,
  type CodeIntelProvider,
  type ContextPack,
} from "@/lib/build-context";
import {
  buildArchitectPlanPrompt,
  buildArchitectSpecPrompt,
  buildArchitectActionResponseFormat,
  buildNativeBuildToolDefinitions,
  buildArchitectReviewPrompt,
  buildArchitectSummaryPrompt,
  buildArchitectGuidancePrompt,
  buildIncompleteTaskFailure,
  buildOutstandingTasksDigest,
  buildReviewDiffPackContent,
  buildWorkerToolInstructions,
  buildWaveReviewDigest,
  compactToolConversation,
  createToolCallTracker,
  formatBuildFileToolDiagnostic,
  buildWorkerTaskPrompt,
  classifyRunCommand,
  classifyVerifyCommandForProject,
  decideBuildTaskFailure,
  detectVerifyCommand,
  extractLocalServerUrls,
  findIncompleteBuildTasks,
  githubWorkflowRequested,
  hasCompleteBuildToolAction,
  inspectStrictToolActionBatchOutput,
  isBuildTaskDependencySatisfied,
  isArchitectTerminalActionForExpected,
  isReviewResultApproved,
  isGitHubWorkflowCommand,
  isRawCommitCommand,
  isRedundantToolCall,
  isTaskWritePathAllowed,
  isWorkerBuildToolAction,
  normalizeBuildTasksForResume,
  reopenBuildTasksForBlockedQualityGateCheckpoint,
  reopenBuildTasksForQualityGate,
  outputPathsForTask,
  applyTaskSplit,
  parseWorkerSplitAction,
  parseArchitectAction,
  parsePlanCritique,
  planCritiqueHasBlockingIssues,
  buildPlanCritiqueDigest,
  buildPlanCritiquePrompt,
  buildPlanRevisionPrompt,
  prCreateRefusalReason,
  buildRepoWorkflowSummary,
  buildReviewFixTaskUpdate,
  buildReviewGateFixInstructions,
  renderTaskGuidanceForWorker,
  recordToolCall,
  runBudgetStatus,
  filterNovelReviewTasks,
  selectBalancedWorkerIndex,
  shouldRecordToolCallResult,
  summarizeFileChange,
  DUPLICATE_TOOL_CALL_FEEDBACK,
  FORCED_PLAN_INSTRUCTION,
  FORCED_REVIEW_INSTRUCTION,
  STRICT_RETRY_INSTRUCTION,
  type ArchitectTerminalAction,
  type ArchitectAction,
  type BuildPlanningAction,
  type BuildPhaseSpec,
  type BuildSpec,
  type BuildTask,
  type BuildTaskGuidance,
  type CodeIntelAction,
  type ContextRetrieveAction,
  type FetchAction,
  type FileChangeOperation,
  type GuidanceAnswerAction,
  type GuidanceRequestAction,
  type SpecAction,
  type RepoBranchCreateAction,
  type RepoCommitAction,
  type RepoDiffAction,
  type RepoInitAction,
  type RepoIssueCreateAction,
  type RepoIssueListAction,
  type RepoMilestoneCreateAction,
  type RepoIssueReadAction,
  type RepoPushAction,
  type RepoPrCreateAction,
  type ReviewAction,
  type SkillRequestAction,
  type ToolCallResultStatus,
  type ToolAction,
} from "@/lib/orchestrator/build";
import {
  providerSupportsHostedBuildToolsFeature,
  providerSupportsNativeBuildToolsFeature,
} from "@/lib/providers/provider-registry";
import {
  getProjectHandle,
  listProjectTree,
  queryProjectPermission,
  readProjectFile,
  writeProjectFile,
} from "./project-fs";
import {
  getRepoStatusViaRunner,
  getRepoDiffViaRunner,
  initRepoViaRunner,
  createBranchViaRunner,
  commitViaRunner,
  createIssueViaRunner,
  createMilestoneViaRunner,
  readIssueViaRunner,
  listIssuesViaRunner,
  pushViaRunner,
  createPrViaRunner,
  classifyRepoBranchSafety,
  branchNameForTopic,
  repoCommitWorkflowEnabledFromStatus,
  type RepoStatus,
} from "./repo-runner";
import {
  appendFileViaRunner,
  callMcpTool,
  checkRunner,
  fetchViaRunner,
  formatCommandResult,
  listFilesViaRunner,
  listMcpServers,
  patchFileViaRunner,
  readFileRangeViaRunner,
  readFileViaRunner,
  listRunnerBackgroundProcesses,
  runCommand,
  searchViaRunner,
  stopRunnerBackgroundProcesses,
  stripAnsi,
  supportsSafeMcpBridge,
  writeFileViaRunner,
  type RunnerConfig,
} from "./runner";
import { loadAttachmentPayloads } from "./attachments";
import {
  accumulateModelStats,
  getBuildCheckpoint,
  getBuildFiles,
  getContextBlob,
  getDiscussionById,
  getFinalResult,
  getMessagesForDiscussion,
  getUserSettings,
  insertFinalResult,
  insertMessage,
  listActiveBuildMemories,
  migrateBuildMemoriesProjectKey,
  updateDiscussion,
  upsertBuildCheckpoint,
  upsertBuildFile,
  upsertBuildMemory,
  upsertContextBlob,
} from "./store";
import { drainBuildNotes } from "./build-notes";
import {
  abortError,
  collectStreamWithUsage,
  type CollectedStreamResult,
  isAbortError,
  type OrchestratorEvent,
} from "./engine";
import {
  estimateModelCallUsage,
  resolveModelCallUsage,
} from "./token-usage";
import {
  createSkillEvidence,
  formatSkillEvidenceDigest,
} from "@/lib/skills/evidence";
import { selectSkills } from "@/lib/skills/router";
import { activeSkillIds, renderSkillContext } from "@/lib/skills/render";
import type {
  BuildSkillEvent,
  SkillActivation,
  SkillActivationInput,
  SkillEvidence,
} from "@/lib/skills/types";
import {
  deriveBuildMemoryProjectKey,
  type BuildMemoryRecord,
} from "@/lib/build-context/memory-store";
import {
  commandProblemsToMemoryResults,
  extractCommandMemoriesForExecution,
  extractGuidanceMemories,
  extractProblemMemories,
  extractReviewMemories,
  extractSkillViolationMemories,
  extractUserNoteMemories,
  shouldRecordAutomatedBuildCheckFailure,
  type CommandMemoryResult,
} from "@/lib/build-context/memory-extractors";

type EventCallback = (event: OrchestratorEvent) => void;
type ContextAssembledEvent = Extract<OrchestratorEvent, { type: "context_assembled" }>;
type MemoryEvent = Extract<OrchestratorEvent, { type: "memory_event" }>;
type ContextBlobEvent = Extract<OrchestratorEvent, { type: "context_blob" }>;
type CodeIntelStatusEvent = Extract<OrchestratorEvent, { type: "code_intel_status" }>;
type StructuredTraceValidation =
  | { ok: true; parsedResponseJson?: string }
  | { ok: false; message: string };

export type CommandApprovalDecision = "allow" | "allow-all" | "deny";

/** UI hooks injected by the discussion page (e.g. the approval prompt). */
export interface BuildHooks {
  requestCommandApproval?: (
    command: string,
    reason?: string
  ) => Promise<CommandApprovalDecision>;
  benchmark?: {
    attemptId: string;
    runId?: string;
    caseId: string;
    harnessProfile: HarnessProfile;
    noHumanApproval: boolean;
    runnerOnly: boolean;
    disableMcp: boolean;
    allowedCommands?: string[];
    recordEvent?: (event: BenchmarkRunEvent) => void;
    recordToolCall?: (trace: BenchmarkToolCallTrace) => void;
    reserveModelCall?: (input?: CertifiedModelCallReservation) => void;
    recordModelCallUsage?: (input: CertifiedModelCallUsage) => void;
  };
  modelCallOverride?: (input: {
    model: SelectedModel;
    messages: ChatMessage[];
    maxTokens: number;
    label: string;
    reasoningEffort: ReasoningEffort;
    structuredOutput?: StructuredOutputFormat;
    attachments?: AttachmentPayload[];
  }) => Promise<string>;
}

export function validateBuildBenchmarkCommand(
  command: string,
  benchmark: BuildHooks["benchmark"] | undefined
): { allowed: boolean; reason?: string } {
  if (!benchmark) return { allowed: true };
  const trimmed = command.trim();
  const allowedCommands = benchmark.allowedCommands?.map((item) => item.trim());
  if (allowedCommands && !allowedCommands.includes(trimmed)) {
    return {
      allowed: false,
      reason: `Command is not in the certified benchmark allowlist: ${trimmed}`,
    };
  }
  return { allowed: true };
}

export function shouldBlockBuildBenchmarkAction(
  action: string,
  benchmark: BuildHooks["benchmark"] | undefined
): { blocked: boolean; reason?: string } {
  if (!benchmark) return { blocked: false };
  if (benchmark.disableMcp && action === "tool") {
    return {
      blocked: true,
      reason: "MCP tool calls are disabled for this certified benchmark.",
    };
  }
  if (action === "fetch") {
    return {
      blocked: true,
      reason: "External fetches are disabled for certified benchmark runs.",
    };
  }
  if (
    [
      "repo_init",
      "repo_branch_create",
      "repo_commit",
      "repo_milestone_create",
      "repo_issue_create",
      "repo_push",
      "repo_pr_create",
    ].includes(action)
  ) {
    return {
      blocked: true,
      reason: "Repository side-effect actions are disabled for certified benchmark runs.",
    };
  }
  return { blocked: false };
}

export function buildBenchmarkTraceContext(
  benchmark: BuildHooks["benchmark"] | undefined
): { attemptId?: string; runId?: string; caseId?: string } {
  return benchmark
    ? {
        attemptId: benchmark.attemptId,
        ...(benchmark.runId ? { runId: benchmark.runId } : {}),
        caseId: benchmark.caseId,
      }
    : {};
}

export async function resolveBuildModelContent(input: {
  model: SelectedModel;
  messages: ChatMessage[];
  maxTokens: number;
  label: string;
  reasoningEffort: ReasoningEffort;
  structuredOutput?: StructuredOutputFormat;
  attachments?: AttachmentPayload[];
  hooks?: BuildHooks;
  collect: () => Promise<string | CollectedStreamResult>;
  emitToken?: (token: string) => void;
}): Promise<{
  content: string;
  overrideUsed: boolean;
  reportedUsage?: StreamUsage;
}> {
  if (input.hooks?.modelCallOverride) {
    const content = await input.hooks.modelCallOverride({
      model: input.model,
      messages: input.messages,
      maxTokens: input.maxTokens,
      label: input.label,
      reasoningEffort: input.reasoningEffort,
      structuredOutput: input.structuredOutput,
      attachments: input.attachments,
    });
    assertNonEmptyBenchmarkModelContent(content, input.hooks);
    input.emitToken?.(content);
    return { content, overrideUsed: true };
  }
  const collected = await input.collect();
  const content =
    typeof collected === "string" ? collected : collected.content;
  assertNonEmptyBenchmarkModelContent(content, input.hooks);
  return {
    content,
    overrideUsed: false,
    ...(typeof collected === "string" || !collected.reportedUsage
      ? {}
      : { reportedUsage: collected.reportedUsage }),
  };
}

function assertNonEmptyBenchmarkModelContent(
  content: string,
  hooks: BuildHooks | undefined
): void {
  if (hooks?.benchmark && content.trim().length === 0) {
    throw new Error("Certified provider returned an empty response.");
  }
}

const SEARCHES_PER_PHASE = 4;
// MCP pools are runaway-loop stops like RUNS_PER_PHASE (see build.ts), not cost controls — the USD/time budget window governs spend; sized to outlast a wave's realistic browser-acceptance usage.
const MCP_CALLS_PER_PHASE = 24;
const TOTAL_MCP_CALLS = 96;
const CODE_INTEL_CALLS_PER_PHASE = 3;
const TOTAL_CODE_INTEL_CALLS = 10;
// Fetch pools are runaway-loop stops (like the MCP/run pools), not cost controls; the USD/time budget window governs spend. Architect AND workers now draw from this one shared pool, so it is sized to outlast a wave's realistic docs-lookup usage.
const FETCHES_PER_PHASE = 8;
const TOTAL_FETCHES = 24;
const WORKER_FINAL_OUTPUT_ATTEMPTS = 1;

// Tool batching: one combined tool-result message is capped so it fits common
// model contexts; in full-access mode the Architect may run a small queue of
// safe verification commands (read-only git / rg / npm scripts) per batch.
const TOOL_BATCH_RESULT_CHARS = 24_000;
const SAFE_RUN_QUEUE_LIMIT = 3;

function parseDiscussionAttachmentIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function buildBuildAttachmentManifest(attachments: AttachmentPayload[]): string {
  if (attachments.length === 0) return "";
  const lines = attachments.map((attachment) => {
    const details = [
      attachment.mimeType,
      `category: ${attachment.category}`,
      attachment.textContent
        ? `extracted text available: ${attachment.textContent.length} chars`
        : "",
      attachment.base64Data ? "raw bytes attached" : "raw bytes unavailable",
    ].filter(Boolean);
    return `- ${attachment.filename} (${details.join("; ")})`;
  });
  return [
    "User-attached build files:",
    "The raw files are attached only to the initial Architect planning call. They are not automatically sent to worker, review, or summary calls. During planning, summarize requirements, create tasks, or scaffold project files/assets that workers need later.",
    ...lines,
  ].join("\n");
}

function joinBuildContextSections(...sections: Array<string | undefined>): string {
  return sections.map((section) => section?.trim() ?? "").filter(Boolean).join("\n\n");
}

const MANIFEST_CANDIDATES = [
  "README.md",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
];

const MAX_CONTEXT_FILES = 8;
const PER_FILE_REVIEW_CHARS = 6_000;
const TOTAL_REVIEW_CHARS = 48_000;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}

/**
 * One-line shell/OS hint for the Architect's run-command prompt, derived from
 * the runner's reported platform. Returns "" for unknown/absent platforms (old
 * runners that don't report one) so no misleading hint is shown.
 */
function shellHintForPlatform(platform?: string, activeDir?: string): string {
  const cwdHint = activeDir
    ? ` Runner active project folder: ${activeDir}. Commands already start in this folder; do not cd to its parent unless explicitly required.`
    : "";
  if (platform === "win32") {
    return `SHELL: commands run on Windows via cmd.exe.${cwdHint} Do not assume Unix tools like grep, sed, test -f, cat, or ls. Use Windows commands (dir, type, findstr) or cross-platform \`node -e "..."\` scripts. To start a static server, use \`py -3 -m http.server 8000\` or \`python -m http.server 8000\`, and for browser navigation prefer \`http://127.0.0.1:<port>\` rather than localhost. Reuse active local server URLs; do not open replacement ports unless the current server is demonstrably unusable.`;
  }
  if (platform === "darwin" || platform === "linux") {
    return `SHELL: commands run in a POSIX shell (sh).${cwdHint} Standard Unix tools (sed/awk/grep/ls/cat) are available.`;
  }
  return "";
}

// How much repo state we surface to the UI. The diff is bounded BEFORE it ever
// reaches React state — never push a full diff into a `repo_diff` event.
const REPO_DIFF_FILE_CAP = 40;
const REPO_DIFF_SUMMARY_CHARS = 4_000;
/** Char cap for the diff text returned to the Architect from a repo_diff tool call. */
const REPO_DIFF_RESULT_CHARS = 4_000;
/** Char caps for the imported GitHub issue context returned to the Architect. */
const REPO_ISSUE_BODY_CHARS = 4_000;
const REPO_ISSUE_COMMENT_CHARS = 800;
const REPO_ISSUE_COMMENT_MAX = 8;

/**
 * Map the fuller `RepoStatus` (from the runner client) down to the
 * `repo_status` event's `status` shape, which intentionally OMITS `root`
 * (an absolute local path) and `gitAvailable` (a host detail). Keeping this in
 * the engine means no absolute path can leak into React state.
 */
function toRepoStatusEvent(status: RepoStatus): Extract<
  OrchestratorEvent,
  { type: "repo_status" }
>["status"] {
  return {
    isRepo: status.isRepo,
    currentBranch: status.currentBranch,
    defaultBranch: status.defaultBranch,
    remotes: status.remotes,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    staged: status.staged,
    unstaged: status.unstaged,
    untracked: status.untracked,
    conflicted: status.conflicted,
    clean: status.clean,
    recentCommits: status.recentCommits,
  };
}

/**
 * Convert a runner `git diff --stat` into the bounded `repo_diff` event payload.
 * The summary text is capped and the file list is limited to the first N files
 * so a huge working-tree diff can't bloat React state.
 */
function toRepoDiffEvent(diff: {
  diff: string;
  truncated: boolean;
}): Extract<OrchestratorEvent, { type: "repo_diff" }>["diff"] {
  const lines = diff.diff.split("\n").filter((l) => l.trim().length > 0);
  // `git diff --stat` lines look like " path/to/file | 12 +++---"; the final
  // " N files changed, …" summary line has no "|". Pull the file paths out.
  const files = lines
    .filter((l) => l.includes("|"))
    .map((l) => l.split("|")[0].trim())
    .filter(Boolean);
  const truncatedFiles = files.length > REPO_DIFF_FILE_CAP;
  return {
    summary: truncate(diff.diff, REPO_DIFF_SUMMARY_CHARS),
    files: files.slice(0, REPO_DIFF_FILE_CAP),
    truncated: diff.truncated || truncatedFiles,
  };
}

/**
 * Run a browser-side Build-mode discussion from planning through worker waves,
 * Architect review, file persistence, and final hand-off.
 */
export async function runBuildDiscussion(
  discussion: Discussion,
  models: SelectedModel[],
  emit: EventCallback,
  hooks?: BuildHooks,
  signal?: AbortSignal
): Promise<void> {
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw abortError();
  };
  const waitForRetry = (ms: number): Promise<void> =>
    new Promise((resolve, reject) => {
      if (ms <= 0) {
        resolve();
        return;
      }
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const timeout = window.setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        window.clearTimeout(timeout);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  // Effort no longer drives the Build workflow budget — it only sets per-response
  // token ceilings below. The run is governed by the Build run policy plus
  // optional USD/time guardrails; worker-call count is telemetry only.
  const effort = discussion.effort as EffortLevel;
  const config = EFFORT_CONFIG[effort];
  const buildSettings = normalizeBuildSettings(discussion);
  const settings = getUserSettings();
  let buildAttachments = loadAttachmentPayloads(
    parseDiscussionAttachmentIds(discussion.attachmentIds)
  );
  let buildAttachmentManifest = buildBuildAttachmentManifest(buildAttachments);
  const sentRawBuildAttachmentIds = new Set<string>();
  const refreshBuildAttachments = (): AttachmentPayload[] => {
    const latestDiscussion = getDiscussionById(discussion.id);
    buildAttachments = loadAttachmentPayloads(
      parseDiscussionAttachmentIds(
        latestDiscussion?.attachmentIds ?? discussion.attachmentIds
      )
    );
    buildAttachmentManifest = buildBuildAttachmentManifest(buildAttachments);
    return buildAttachments.filter(
      (attachment) => !sentRawBuildAttachmentIds.has(attachment.id)
    );
  };
  const claimRawBuildAttachmentsForArchitect = (): AttachmentPayload[] => {
    const unsent = refreshBuildAttachments();
    for (const attachment of unsent) {
      sentRawBuildAttachmentIds.add(attachment.id);
    }
    return unsent;
  };
  const benchmark = hooks?.benchmark;
  const benchmarkApprovalsBypassed = (): boolean =>
    benchmark?.noHumanApproval === true || allowAllCommands;
  const emitBenchmarkEvent = (
    input: Omit<BenchmarkRunEvent, "id" | "attemptId" | "caseId" | "at">
  ): void => {
    if (!benchmark?.recordEvent) return;
    benchmark.recordEvent({
      ...input,
      id: uuidv4(),
      attemptId: benchmark.attemptId,
      caseId: benchmark.caseId,
      at: new Date().toISOString(),
    });
  };
  const recordBenchmarkToolTrace = (
    input: Omit<BenchmarkToolCallTrace, "id" | "attemptId" | "caseId">
  ): void => {
    if (!benchmark?.recordToolCall) return;
    benchmark.recordToolCall({
      ...input,
      id: uuidv4(),
      attemptId: benchmark.attemptId,
      caseId: benchmark.caseId,
    });
  };

  // The active budget window. Resume always starts a fresh window (USD spent and
  // elapsed time reset to 0); historical spend lives in the saved checkpoint.
  const buildWindowStartedAt = new Date().toISOString();
  const buildWindowStartMs = Date.now();
  let usageWindow = createBuildUsageWindow(buildWindowStartedAt);
  const emitBuildUsage = (): void => {
    emit({ type: "build_usage", usage: usageWindow });
  };
  const currentGuardrailStop = (): BuildStopReason | null =>
    shouldStopForBuildGuardrail({
      settings: buildSettings,
      spentUsd: usageWindow.estimatedUsd,
      elapsedMs: Date.now() - buildWindowStartMs,
    });

  // Mark the run stopped (resumable) and emit the stop. Deliberately NOT thrown:
  // the engine caller turns any thrown error into a "failed" discussion, so a
  // clean budget/time/blocked/user stop must update state and return instead.
  const markStopped = (
    reason: BuildStopReason,
    message: string,
    report?: BuildStopReport,
    toolReviewReport?: BuildToolReviewReport | null
  ): void => {
    void stopBuildBackgroundProcesses(
      reason === "completed" ? "after Build completed" : "after Build stopped"
    );
    const now = new Date().toISOString();
    updateDiscussion(discussion.id, {
      status: reason === "completed" ? "completed" : "stopped",
      buildStopReason: reason,
      buildStoppedAt: now,
      updatedAt: now,
    });
    emit({
      type: "build_stopped",
      reason,
      message,
      usage: usageWindow,
      report,
      toolReviewReport,
    });
    emit({
      type: "status",
      status: reason === "completed" ? "completed" : "stopped",
    });
  };

  // Human-facing reason text for a guardrail stop (shared by the stop helper).
  const guardrailStopMessage = (reason: "budget" | "time"): string =>
    reason === "budget"
      ? "Build stopped because the active USD budget window was reached. Resume starts a fresh budget window."
      : "Build stopped because the active time budget window was reached. Resume starts a fresh time window.";
  // `stopForGuardrail` (the boundary check that also saves a checkpoint) is
  // defined later, once the repo refs it captures are in scope.
  const reasoningEffort = (discussion.reasoningEffort ?? "default") as ReasoningEffort;
  const verbosityInstruction = buildVerbosityInstruction(
    (discussion.verbosity ?? "balanced") as Verbosity,
    discussion.styleNote
  );
  const workerMinTokens = Math.max(config.maxTokens, BUILD_ROUND_MIN_TOKENS);
  const architectMinTokens = Math.max(
    config.judgeMaxTokens,
    BUILD_INTEGRATOR_MIN_TOKENS
  );

  const modelIds: string[] = JSON.parse(discussion.modelIds);
  const architectId = discussion.judgeModelId ?? modelIds[0];
  const resolveSelectedModelForId = (modelId: string): SelectedModel =>
    models.find((m) => m.modelId === modelId) ?? {
      modelId,
      providerId: parseModelId(modelId).providerId,
      displayName: resolveModelName(modelId),
      contextProfile: resolveClientModelContextProfile(modelId),
    };
  // The Architect is the JUDGE model — even when it isn't one of the
  // participating (worker) models. Resolve it on its own so a non-participant
  // judge (e.g. an expensive GPT-5.5 orchestrating cheap workers) is honored
  // instead of silently falling back to the first participant.
  const architect: SelectedModel = resolveSelectedModelForId(architectId);
  const reviewer: SelectedModel | null = discussion.reviewerModelId
    ? resolveSelectedModelForId(discussion.reviewerModelId)
    : null;
  const workerIds = modelIds.filter(
    (id) => id !== architect.modelId && id !== reviewer?.modelId
  );
  const workers = workerIds.map(resolveSelectedModelForId);
  if (workers.length === 0) workers.push(architect); // solo build
  const buildContextManager = new BuildContextManager();
  const modelContextProfile = (model: SelectedModel) =>
    model.contextProfile ?? resolveClientModelContextProfile(model.modelId);
  const buildMaxTokensForModel = (
    model: SelectedModel,
    fallbackTokens: number
  ): number => {
    const profile = modelContextProfile(model);
    const profiledBudget =
      typeof profile.buildOutputReserveTokens === "number" &&
      Number.isFinite(profile.buildOutputReserveTokens) &&
      profile.buildOutputReserveTokens > 0
        ? Math.floor(profile.buildOutputReserveTokens)
        : typeof profile.maxOutputTokens === "number" &&
            Number.isFinite(profile.maxOutputTokens) &&
            profile.maxOutputTokens > 0
          ? Math.floor(profile.maxOutputTokens)
          : null;
    if (profiledBudget === null) return fallbackTokens;
    const explicitProfile = profile.source === "registry" || profile.source === "override";
    return explicitProfile ? profiledBudget : Math.max(fallbackTokens, profiledBudget);
  };
  const workerMaxTokens = (model: SelectedModel): number =>
    buildMaxTokensForModel(model, workerMinTokens);
  const architectMaxTokens = (model: SelectedModel): number =>
    buildMaxTokensForModel(model, architectMinTokens);
  const emitContextAssembled = (
    assembled: AssembledBuildContext,
    input: {
      phase: ContextAssembledEvent["phase"];
      label: string;
      model: SelectedModel;
      taskId?: string;
    }
  ): void => {
    const { providerId } = parseModelId(input.model.modelId);
    const retrieveRefs = assembled.rendered.assembly.selected
      .map((pack) => pack.retrieveRef)
      .filter((ref): ref is NonNullable<typeof ref> => Boolean(ref))
      .slice(0, 10)
      .map((ref) => ({
        id: ref.id,
        label: ref.label,
        kind: ref.kind,
        tokenEstimate: ref.tokenEstimate,
      }));
    const droppedPacks = assembled.rendered.assembly.omitted
      .filter((pack) => pack.reason !== "empty")
      .slice(0, 10)
      .map((pack) => ({
        id: pack.id,
        title: pack.title,
        kind: pack.kind,
        reason: pack.reason,
        estimatedTokens: pack.estimatedTokens,
      }));
    const droppedPackCount = assembled.rendered.assembly.omitted.filter(
      (pack) => pack.reason !== "empty"
    ).length;
    const estimatedInputTokens = Math.min(
      assembled.budget.totalInputTokens,
      assembled.budget.fixedPromptTokens +
        assembled.budget.taskTokens +
        assembled.budget.historyTokens +
        assembled.rendered.renderedTokenTotal
    );

    emit({
      type: "context_assembled",
      role: assembled.role,
      phase: input.phase,
      label: input.label,
      taskId: input.taskId,
      modelId: input.model.modelId,
      modelName: input.model.displayName,
      providerId,
      contextTier: assembled.budget.tier,
      totalInputBudgetTokens: assembled.budget.totalInputTokens,
      modelContextWindowTokens: assembled.budget.modelContextWindowTokens,
      modelInputCeilingTokens: assembled.budget.modelInputCeilingTokens,
      estimatedInputTokens,
      contextPackBudgetTokens: assembled.budget.contextPackTokens,
      contextPackUsedTokens: assembled.rendered.contentTokenTotal,
      selectedPackCount: assembled.rendered.packCount,
      omittedPackCount: droppedPackCount,
      droppedPacks,
      retrieveRefs,
      notes: assembled.notes.slice(0, 4),
    });
  };

  // ── Worker scoreboard ─────────────────────────────────────────────────────
  // Tracks each worker's performance so the Architect can assign harder tasks
  // to the reliable ones, and so a model that stops responding gets benched
  // while others can carry on. Scores are derived objectively from the
  // Architect's approve/fix verdicts, failures, and response times — no model
  // is asked to self-report.
  interface WorkerStat {
    index: number;
    name: string;
    attempts: number;
    approvals: number;
    fixes: number;
    // Failures are split: a model's QUALITY is only judged by badOutput.
    badOutput: number; // responded with no usable files, or a non-infra error
    unavailable: number; // provider denied/timed out (429/503/quota/network) — NOT quality
    // Difficulty-weighted tallies (weight = task difficulty / 3, medium = 1)
    // for the global benchmark; hard-task outcomes count more than trivial ones.
    wApprovals: number;
    wFixes: number;
    wBadOutput: number;
    responseMs: number; // time of SUCCESSFUL responses only (clean throughput)
    responseChars: number; // output chars of successful responses only
    responses: number; // successful, non-empty responses
    // Token totals across ALL of this worker's calls on its tasks (tool turns +
    // finalize), including tasks that later fail or get fixed — that waste is
    // exactly what the tokens-per-approved-task KPI is meant to surface.
    inputTokens: number;
    outputTokens: number;
    active: boolean;
  }
  const scoreboard: WorkerStat[] = workers.map((w, index) => ({
    index,
    name: w.displayName,
    attempts: 0,
    approvals: 0,
    fixes: 0,
    badOutput: 0,
    unavailable: 0,
    wApprovals: 0,
    wFixes: 0,
    wBadOutput: 0,
    responseMs: 0,
    responseChars: 0,
    responses: 0,
    inputTokens: 0,
    outputTokens: 0,
    active: true,
  }));

  /** Normalized difficulty weight: medium (3) = 1.0, trivial = 0.33, hard = 1.67. */
  const difficultyWeight = (task: BuildTask): number =>
    Math.max(1, Math.min(5, task.difficulty ?? 3)) / 3;

  // Speed is judged by THROUGHPUT (ms per output char) of SUCCESSFUL responses,
  // relative to the other workers — never raw elapsed time (bigger tasks take
  // longer) and never polluted by failed attempts.
  const msPerChar = (s: WorkerStat): number | null =>
    s.responseChars > 0 ? s.responseMs / s.responseChars : null;

  const medianMsPerChar = (): number | null => {
    const rates = scoreboard
      .map(msPerChar)
      .filter((r): r is number => r != null)
      .sort((a, b) => a - b);
    if (rates.length < 2) return null; // a relative measure needs a peer
    const mid = Math.floor(rates.length / 2);
    return rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
  };

  // In-build operational score (drives assignment): raw counts, integer, and
  // excludes unavailable so a model isn't punished for the provider's outages.
  // (The global leaderboard uses the difficulty-weighted tallies instead.)
  const workerScore = (s: WorkerStat): number => {
    let score = s.approvals * 3 - s.fixes * 1 - s.badOutput * 4;
    const median = medianMsPerChar();
    const rate = msPerChar(s);
    if (median != null && rate != null) {
      if (rate < median * 0.5) score += 1;
      else if (rate > median * 2) score -= 1;
    }
    return score;
  };

  /** Active workers, best first (score desc, then better throughput, then order). */
  const rankedActiveWorkers = (): WorkerStat[] =>
    scoreboard
      .filter((s) => s.active)
      .sort((a, b) => {
        const ds = workerScore(b) - workerScore(a);
        if (ds !== 0) return ds;
        const rateA = msPerChar(a) ?? Infinity;
        const rateB = msPerChar(b) ?? Infinity;
        if (rateA !== rateB) return rateA - rateB;
        return a.index - b.index;
      });

  const scoreboardText = (): string =>
    scoreboard
      .slice()
      .sort((a, b) => workerScore(b) - workerScore(a))
      .map((s) => {
        const avg =
          s.responses > 0
            ? ` avg ${Math.round(s.responseMs / s.responses / 1000)}s`
            : "";
        const down = s.unavailable > 0 ? `, ${s.unavailable} unavailable` : "";
        const bench = s.active ? "" : " [BENCHED — not producing output]";
        return `- ${s.name}: score ${workerScore(s)} (${s.approvals} approved, ${s.fixes} fix${s.fixes === 1 ? "" : "es"}, ${s.badOutput} bad output${down}${avg})${bench}`;
      })
      .join("\n");

  // Bench workers that still haven't produced any usable output after more
  // than one try — never benches on a single attempt, and never the last
  // active worker. Benching is operational (a model that isn't producing,
  // for any reason, can't carry the build); it does NOT affect quality score.
  const benchUnresponsiveWorkers = (): void => {
    for (const stat of scoreboard) {
      if (!stat.active) continue;
      const neverProduced = stat.attempts >= 2 && stat.responses === 0;
      const othersActive = scoreboard.some((s) => s.active && s.index !== stat.index);
      if (neverProduced && othersActive) {
        stat.active = false;
        const why = stat.unavailable >= stat.badOutput ? "the provider keeps denying it" : "it hasn't produced usable output";
        emit({
          type: "diagnostic",
          phase: "round_preparing",
          message: `Benching ${stat.name} — ${why}; remaining workers will continue`,
        });
      }
    }
  };

  /** Match an Architect-provided assignTo name to a worker index. */
  const workerIndexByName = (name?: string): number | null => {
    if (!name) return null;
    const lower = name.trim().toLowerCase();
    const found = scoreboard.find((s) => s.name.toLowerCase() === lower);
    return found ? found.index : null;
  };

  // ── Filesystem: virtual always; the real folder when granted ──────────────
  // A folder problem (no permission, moved, or — common on Documents —
  // OneDrive "online-only" placeholder files that throw NotFoundError) must
  // never fail the build. Any error here degrades to in-app/virtual files.
  const dirHandle = benchmark ? null : await getProjectHandle(discussion.id);
  const virtualFs = new Map<string, string>();
  // Paths actually written THIS run — grounds the hand-off summary so it can
  // only describe changes that really happened.
  const writtenThisRun = new Set<string>();
  // Paths changed by this Build job across current and restored passes. The
  // final quality gate uses this to decide whether browser acceptance is needed
  // after a resume that performs no additional writes.
  const buildChangedFiles = new Set<string>();
  const recordWrittenPath = (path: string): void => {
    writtenThisRun.add(path);
    buildChangedFiles.add(path);
  };
  // Normalized path → writer label ("T3"/"Architect") for the CURRENT wave only
  // (cleared each cycle). Detects two workers writing the same path concurrently
  // — last-write-wins silently destroys the earlier output otherwise.
  const waveWrites = new Map<string, string>();
  // Task id -> bounded landed-change summaries for the CURRENT wave. The
  // Architect reviews this digest instead of full rewritten file bodies.
  let waveChangeSummaries = new Map<string, string[]>();
  // Seed with everything previous passes built — follow-up passes and resumes
  // must see the existing files instead of re-planning from an "empty" tree.
  for (const file of getBuildFiles(discussion.id)) {
    virtualFs.set(file.path, file.content);
    buildChangedFiles.add(file.path);
  }
  if (virtualFs.size > 0) {
    emit({
      type: "diagnostic",
      phase: "initializing",
      message: `Restored ${virtualFs.size} file(s) from the previous build pass`,
    });
  }
  let diskTree: string[] = [];
  let diskGranted = false;
  let diskWarning: string | null = null;
  if (dirHandle) {
    try {
      if (await queryProjectPermission(dirHandle)) {
        const tree = await listProjectTree(dirHandle);
        diskTree = tree.files;
        diskGranted = true;
      } else {
        diskWarning = "folder access was not granted";
      }
    } catch (err) {
      // Surface the real error in DevTools so the exact failing operation is
      // visible if a specific folder/handle misbehaves.
      console.error("[build] reading the project folder failed:", err);
      diskWarning =
        err instanceof Error
          ? `${err.name}: ${err.message}`
          : "the folder couldn't be read";
    }
  }
  if (diskWarning) {
    emit({
      type: "diagnostic",
      phase: "initializing",
      message: `Project folder unavailable — ${diskWarning}. Building in the app instead; download the files as a zip when done.`,
    });
  }

  emit({
    type: "diagnostic",
    phase: "initializing",
    message: diskGranted
      ? `Build mode: Architect ${architect.displayName}, ${workers.length} worker(s), writing to folder "${dirHandle?.name}"`
      : `Build mode: Architect ${architect.displayName}, ${workers.length} worker(s), files kept in the app (download as zip)`,
  });

  const githubWorkflow = githubWorkflowRequested(discussion.topic);
  // A pull request is an expected deliverable only when the request explicitly
  // asks for one — used to gate "done" and to flag an incomplete GitHub workflow
  // so a model can't "finish" (or claim success) without actually opening the PR.
  const prExpected =
    githubWorkflow && /(pull request|pull-request|\bpr\b)/i.test(discussion.topic);
  let githubCompletionDeferrals = 0;

  // ── Optional local runner (user-started; opt-in by config) ────────────────
  let runner: RunnerConfig | null = null;
  let runnerDirName: string | null = null;
  let buildMemoryRepoRemoteUrl: string | null = null;
  let buildMemoryRunnerProjectRoot: string | null = null;
  let buildMemoryProjectKey = deriveBuildMemoryProjectKey({
    repoRemoteUrl: buildMemoryRepoRemoteUrl,
    runnerProjectRoot: buildMemoryRunnerProjectRoot,
    discussionId: discussion.id,
  });
  const refreshBuildMemoryProjectKey = (): void => {
    const previousKey = buildMemoryProjectKey;
    const nextKey = deriveBuildMemoryProjectKey({
      repoRemoteUrl: buildMemoryRepoRemoteUrl,
      runnerProjectRoot: buildMemoryRunnerProjectRoot,
      discussionId: discussion.id,
    });
    if (previousKey !== nextKey) {
      migrateBuildMemoriesProjectKey(previousKey, nextKey);
      buildMemoryProjectKey = nextKey;
    }
  };
  const activeBuildMemories = (): BuildMemoryRecord[] =>
    listActiveBuildMemories(buildMemoryProjectKey);
  let lastMemoryEventSignature = "";
  const memoryItem = (
    record: BuildMemoryRecord
  ): MemoryEvent["activeDecisions"][number] => ({
    id: record.id,
    summary: record.summary,
    paths: record.paths?.slice(0, 4),
    taskIds: record.taskIds?.slice(0, 4),
    hitCount: record.hitCount,
  });
  const emitBuildMemoryEvent = (
    records: BuildMemoryRecord[] = activeBuildMemories()
  ): void => {
    const activeDecisions = records
      .filter((record) => record.kind === "decision" || record.kind === "user_correction")
      .slice(0, 6)
      .map(memoryItem);
    const failedApproaches = records
      .filter((record) => record.kind === "failed_approach" || record.kind === "skill_violation")
      .slice(0, 6)
      .map(memoryItem);
    const fragileFiles = records
      .filter((record) => record.kind === "fragile_file")
      .slice(0, 6)
      .map(memoryItem);
    const warnings = [
      ...fragileFiles.map((record) => `Fragile file: ${record.summary}`),
      ...failedApproaches.map((record) => `Avoid repeat: ${record.summary}`),
    ].slice(0, 6);
    const signature = JSON.stringify({
      activeDecisions,
      failedApproaches,
      fragileFiles,
      warnings,
    });
    if (signature === lastMemoryEventSignature) return;
    lastMemoryEventSignature = signature;
    emit({
      type: "memory_event",
      activeDecisions,
      failedApproaches,
      fragileFiles,
      warnings,
    });
  };
  const persistBuildMemories = (records: BuildMemoryRecord[]): void => {
    if (records.length === 0) return;
    for (const record of records) upsertBuildMemory(record);
    emitBuildMemoryEvent();
  };
  const commandMemoryResults: CommandMemoryResult[] = [];
  const rememberCommandMemory = (result: CommandMemoryResult): void => {
    if (result.command.trim() === "" || result.exitCode === -1) return;
    commandMemoryResults.push(result);
    if (commandMemoryResults.length > 80) {
      commandMemoryResults.splice(0, commandMemoryResults.length - 80);
    }
    persistBuildMemories(
      extractCommandMemoriesForExecution({
        projectKey: buildMemoryProjectKey,
        discussionId: discussion.id,
        current: result,
        history: commandMemoryResults,
      })
    );
  };
  // One-line note about the runner's shell/OS, fed to the Architect so it stops
  // emitting Unix-only commands (sed/awk/grep) on a Windows runner. Empty when
  // the platform is unknown (old runner) — no hint then.
  let shellHint = "";
  let runnerPlatform = "";
  let runnerActiveDir = "";
  let allowAllCommands = discussion.runnerAccess === "full";
  const shouldRequestRepoMutationApproval = () =>
    !benchmarkApprovalsBypassed() && !githubWorkflow;
  let totalRuns = 0;
  let totalFetches = 0;
  let mcpToolsDoc = "";
  let mcpServersForCodeIntel: Awaited<ReturnType<typeof listMcpServers>> = [];
  let totalMcpCalls = 0;
  let playwrightNavigated = false;
  let browserAcceptanceObserved = false;
  let browserAcceptanceEvidence: string | null = null;
  let codeIntelProvider: CodeIntelProvider | null = null;
  const codeIntelBudget = createCodeIntelPhaseBudget({
    perPhase: CODE_INTEL_CALLS_PER_PHASE,
    total: TOTAL_CODE_INTEL_CALLS,
  });
  let localServerUrls: string[] = [];
  let runnerBackgroundBaseline = new Set<number>();
  let backgroundCleanupNoticeEmitted = false;
  // Whether the runner folder is a Git repo, captured once when the runner
  // connects. Gates the post-wave diff refresh (no point diffing a non-repo).
  let repoIsGit = false;
  // Run-level gate (NRW-005): commit/PR-capable repo workflow is enabled ONLY
  // once a safe FEATURE branch is confirmed (engine-led auto-establish below).
  // It stays false on the default/main/master branch with no branch created,
  // when conflicts exist, or when the user denied branch creation. Later issues
  // (NRW-006+: commit/push/PR) gate their actions on this flag; ordinary file
  // writes are NEVER blocked by it.
  let repoCommitWorkflowEnabled = false;
  // If this build initialized the runner folder itself, allow the first local
  // commit on the requested initial branch instead of forcing a generated
  // feature branch immediately after `git init`.
  let repoInitializedByBuild = false;
  // Commits landed via the user-approved repo_commit workflow (NRW-006), and the
  // feature branch they were made on. Surfaced in the final build summary so the
  // user sees branch + commit hash(es) without digging through the transcript.
  const repoCommits: Array<{ hash: string; subject: string }> = [];
  let repoActiveBranch: string | null = null;
  // GitHub workflow milestones (NRW-008), surfaced in the UI panel + final
  // summary: the imported issue number, the pushed branch, and the opened PR URL.
  let repoIssueNumber: number | null = null;
  const repoCreatedIssues: Array<{ issue: number; title: string; url: string }> = [];
  let repoMilestoneTitle: string | null = null;
  let repoPushedBranch: string | null = null;
  let repoPrUrl: string | null = null;
  // Last automated build-check outcome (resolved verify command + passed/failed),
  // surfaced as the Verification line in the Repository workflow summary block.
  let repoVerification: string | null = null;

  // A previously saved checkpoint (resume) is loaded up front so failure history
  // and recovery notes carry across the stop; the resume restoration below reads
  // the same record. Failure fingerprints surviving a resume let a blocker that
  // persists across stops still be caught.
  const existingCheckpoint = getBuildCheckpoint(discussion.id);
  let failureFingerprints: Record<string, number> =
    existingCheckpoint?.failureFingerprints ?? {};
  const recoveryLog: string[] = existingCheckpoint?.recoveryLog ?? [];
  const buildProblems: BuildProblem[] = [...(existingCheckpoint?.buildProblems ?? [])];
  const commandProblems: BuildCommandProblem[] = [
    ...(existingCheckpoint?.commandProblems ?? []),
  ];

  const recordBuildProblem = (
    input: Omit<BuildProblem, "id" | "createdAt"> & {
      id?: string;
      createdAt?: string;
    }
  ): BuildProblem => {
    const problem: BuildProblem = {
      ...input,
      id: input.id ?? uuidv4(),
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    buildProblems.push(problem);
    if (buildProblems.length > 80) buildProblems.splice(0, buildProblems.length - 80);
    persistBuildMemories(
      extractProblemMemories({
        projectKey: buildMemoryProjectKey,
        discussionId: discussion.id,
        problems: [problem],
      })
    );
    return problem;
  };

  const recordCommandProblem = (
    input: Omit<BuildCommandProblem, "createdAt"> & { createdAt?: string }
  ): BuildCommandProblem => {
    const problem: BuildCommandProblem = {
      ...input,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    commandProblems.push(problem);
    if (commandProblems.length > 40) {
      commandProblems.splice(0, commandProblems.length - 40);
    }
    if (!problem.denied) {
      const current = commandProblemsToMemoryResults([problem])[0];
      persistBuildMemories(
        extractCommandMemoriesForExecution({
          projectKey: buildMemoryProjectKey,
          discussionId: discussion.id,
          current,
          history: commandProblemsToMemoryResults(
            commandProblems.filter((item) => !item.denied)
          ),
        })
      );
    }
    return problem;
  };

  const createStopReport = (input: {
    status: string;
    stopReason: BuildStopReason | "failed" | "incomplete";
    message: string;
    wave: number;
    tasks: BuildTask[];
    verifyCommand: string;
  }): BuildStopReport =>
    createBuildStopReport({
      discussionId: discussion.id,
      topic: discussion.topic,
      status: input.status,
      stopReason: input.stopReason,
      stopMessage: input.message,
      wave: input.wave,
      branch: repoActiveBranch,
      prUrl: repoPrUrl,
      verifyCommand: input.verifyCommand,
      tasks: input.tasks,
      problems: buildProblems,
      commandProblems,
      failureFingerprints,
      recoveryLog,
    });

  const createToolReviewReport = (input: {
    status: string;
    wave: number;
  }): BuildToolReviewReport | null =>
    createBuildToolReviewReport({
      discussionId: discussion.id,
      topic: discussion.topic,
      status: input.status,
      wave: input.wave,
      problems: buildProblems,
      commandProblems,
    });

  // ── Resumable checkpoint ───────────────────────────────────────────────────
  // Persist the run (task graph, repo refs, current budget window) so a stop by
  // budget, time, blocker, or user can be resumed from where it left off. Repo
  // refs are read live (closure) so the checkpoint always reflects the latest
  // branch/PR/milestone/issue state.
  const saveCheckpoint = (input: {
    status: BuildCheckpoint["status"];
    stopReason?: BuildStopReason | null;
    wave: number;
    tasks: BuildTask[];
    architectNotes: string;
    verifyCommand: string;
    failureFingerprints?: Record<string, number>;
    recoveryLog?: string[];
    stopReport?: BuildStopReport | null;
    toolReviewReport?: BuildToolReviewReport | null;
  }): void => {
    const toolReviewReport =
      input.toolReviewReport ?? createToolReviewReport(input);
    upsertBuildCheckpoint({
      discussionId: discussion.id,
      status: input.status,
      updatedAt: new Date().toISOString(),
      runPolicy: buildSettings.runPolicy,
      stopReason: input.stopReason ?? null,
      wave: input.wave,
      tasks: input.tasks.map((task) => ({ ...task })),
      architectNotes: input.architectNotes,
      verifyCommand: input.verifyCommand,
      phaseSpec: activePhaseSpec,
      branch: repoActiveBranch,
      prUrl: repoPrUrl,
      milestone: repoMilestoneTitle,
      issueNumbers: [
        ...(repoIssueNumber == null ? [] : [repoIssueNumber]),
        ...repoCreatedIssues.map((item) => item.issue),
      ],
      failureFingerprints: input.failureFingerprints ?? failureFingerprints,
      recoveryLog: input.recoveryLog ?? recoveryLog,
      buildProblems,
      commandProblems,
      stopReport: input.stopReport ?? null,
      toolReviewReport,
      usageWindow,
      skillMode: buildSettings.skillMode,
      skillEvidence: skillEvidenceRecords,
      skillEvents: skillEventRecords,
    });
  };

  // Boundary guardrail check: when the active USD/time window is consumed, save a
  // resumable "stopped" checkpoint (when run state is available) and mark the run
  // stopped. Returns true so the caller can `return` cleanly — never thrown, so a
  // budget/time stop is never reclassified as a failed build.
  const stopForGuardrail = (
    snapshot:
      | {
          wave: number;
          tasks: BuildTask[];
          architectNotes: string;
          verifyCommand: string;
        }
      | null
  ): boolean => {
    const reason = currentGuardrailStop();
    if (reason !== "budget" && reason !== "time") return false;
    const message = guardrailStopMessage(reason);
    const report = snapshot
      ? createStopReport({
          status: "stopped",
          stopReason: reason,
          message,
          wave: snapshot.wave,
          tasks: snapshot.tasks,
          verifyCommand: snapshot.verifyCommand,
        })
      : undefined;
    const toolReviewReport = snapshot
      ? createToolReviewReport({ status: "stopped", wave: snapshot.wave })
      : null;
    if (snapshot) {
      saveCheckpoint({
        status: "stopped",
        stopReason: reason,
        wave: snapshot.wave,
        tasks: snapshot.tasks,
        architectNotes: snapshot.architectNotes,
        verifyCommand: snapshot.verifyCommand,
        stopReport: report,
        toolReviewReport,
      });
    }
    markStopped(reason, message, report, toolReviewReport);
    return true;
  };

  // Runner's GitHub CLI state, captured from the initial repo status. Gates the
  // issue/push/PR typed-action docs in the plan/review prompts: only advertised
  // when gh is installed AND authenticated on the runner machine.
  let githubCli: RepoStatus["githubCli"] | null = null;
  // Existing GitHub label names — surfaced to the Architect so it prefers them
  // over inventing new ones (the runner still auto-creates any truly-new label).
  let repoLabels: string[] = [];
  if (discussion.runnerUrl && discussion.runnerToken) {
    const config = { url: discussion.runnerUrl, token: discussion.runnerToken };
    const health = await checkRunner(config);
    if (health.ok) {
      runner = config;
      runnerDirName = health.dir ?? null;
      refreshBuildMemoryProjectKey();
      runnerPlatform = health.platform ?? "";
      runnerActiveDir = health.activeDir ?? "";
      shellHint = shellHintForPlatform(health.platform, runnerActiveDir);
      const existingBackground = await listRunnerBackgroundProcesses(config);
      runnerBackgroundBaseline = new Set(
        (existingBackground ?? []).map((process) => process.pid)
      );
      emit({
        type: "diagnostic",
        phase: "initializing",
        message: `Local runner connected (folder "${health.dir}") — the Architect can run commands${benchmarkApprovalsBypassed() ? "" : " with your approval"}`,
      });
      if (githubWorkflow && !benchmarkApprovalsBypassed()) {
        emit({
          type: "diagnostic",
          phase: "initializing",
          message:
            "GitHub workflow requested — typed repo actions can create branches, issues, milestones, commits, pushes, and draft PRs without extra in-app approval prompts; review/merge remains the human gate on GitHub.",
        });
      }
      // The runner sees the REAL folder — use it for the tree so the
      // Architect is never blind to files it (or the user) put on disk,
      // even when no File System Access grant is active. Old runners
      // without /ls return null; the FSA tree then stands.
      const runnerTree = await listFilesViaRunner(config);
      if (runnerTree) {
        diskTree = [...new Set([...diskTree, ...runnerTree])];
        diskGranted = true;
      }
      // Sync files restored from previous passes (currently only in virtualFs)
      // into the runner's folder so a runner attached AFTER an earlier in-app
      // build pass starts from those files. Never overwrite what's already on
      // disk — the runner copy may be newer or user-edited; only write paths
      // the tree doesn't already contain. Same normalization the tree uses
      // (forward slash, lowercased, no leading "./" or "/").
      const normTreePath = (p: string): string =>
        p.replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
      const onDisk = new Set((runnerTree ?? []).map(normTreePath));
      let synced = 0;
      const syncFailures: string[] = [];
      for (const [path, content] of virtualFs) {
        if (onDisk.has(normTreePath(path))) continue;
        try {
          await writeFileViaRunner(config, path, content);
          synced += 1;
          if (!diskTree.includes(path)) diskTree.push(path);
        } catch (err) {
          console.error(`[build] syncing restored file ${path} to the runner failed:`, err);
          syncFailures.push(path);
        }
      }
      if (synced > 0 || syncFailures.length > 0) {
        const failNote =
          syncFailures.length > 0
            ? ` (${syncFailures.length} failed: ${syncFailures.slice(0, 5).join(", ")}${syncFailures.length > 5 ? "…" : ""})`
            : "";
        emit({
          type: "diagnostic",
          phase: "initializing",
          message: `Synced ${synced} restored file(s) into the runner folder${failNote}`,
        });
      }
      // MCP bridge: tools from stdio MCP servers the runner spawned
      // (e.g. Playwright to verify the build in a real browser). Each tool is
      // documented as a call signature from its input schema — without the
      // exact parameter names models guess them and get validation errors.
      const toolSignature = (t: {
        name: string;
        inputSchema?: { properties?: Record<string, { type?: string }>; required?: string[] } | null;
      }): string => {
        const props = t.inputSchema?.properties;
        if (!props || Object.keys(props).length === 0) return `${t.name}()`;
        const required = new Set(t.inputSchema?.required ?? []);
        const params = Object.entries(props)
          .slice(0, 10)
          .map(([key, def]) => `${key}${required.has(key) ? "" : "?"}: ${def?.type ?? "any"}`);
        return `${t.name}({${params.join(", ")}})`;
      };
      if (benchmark?.disableMcp) {
        emit({
          type: "diagnostic",
          phase: "initializing",
          message: "MCP bridge disabled for certified benchmark mode.",
        });
      } else if (!supportsSafeMcpBridge(health.version)) {
        emit({
          type: "diagnostic",
          phase: "initializing",
          message: `MCP bridge disabled: runner ${health.version == null ? "version is unknown" : `v${health.version}`} does not report truncation-safe MCP results. Update the local runner to v10+ before using MCP tools so long outputs remain retrievable.`,
        });
      } else {
        const servers = (await listMcpServers(config)) ?? [];
        mcpServersForCodeIntel = servers;
        const ready = servers.filter((s) => s.status === "ready" && s.tools.length > 0);
        const readyForDocs = ready
          .map((server) => filterCodebaseMemoryMcpToolsForGenericUse(server))
          .map((server) => filterBuildMcpToolsForPrompt(server))
          .filter((server) => server.tools.length > 0);
        if (readyForDocs.length > 0) {
          mcpToolsDoc = readyForDocs
          .map(
            (s) =>
              `Server "${s.name}":\n${s.tools
                .slice(0, 30)
                .map((t) => `- ${toolSignature(t)} — ${truncate(t.description ?? "", 160)}`)
                .join("\n")}`
          )
            .join("\n");
          emit({
            type: "diagnostic",
            phase: "initializing",
            message: `MCP bridge connected: ${ready.map((s) => `${s.name} (${s.tools.length} tools)`).join(", ")}`,
          });
        }
        for (const s of servers.filter((x) => x.status === "error")) {
          emit({
            type: "diagnostic",
            phase: "initializing",
            message: `MCP server "${s.name}" failed to start: ${s.error ?? "unknown error"}`,
          });
        }
      }
      // Capture INITIAL Git state of the runner folder (NRW-003). Surfacing
      // branch / dirty state in the UI keeps it out of the model transcript.
      // `getRepoStatusViaRunner` is a soft wrapper — null on an old runner or
      // failure, in which case we simply show no repo panel. When the folder
      // is reachable but not a repo, we still emit so the UI can state that
      // native repo workflow is unavailable.
      const repoStatus = await getRepoStatusViaRunner(config);
      if (repoStatus) {
        repoIsGit = repoStatus.isRepo;
        buildMemoryRunnerProjectRoot = repoStatus.root;
        buildMemoryRepoRemoteUrl =
          repoStatus.remotes.find((remote) => remote.name === "origin")?.url ??
          repoStatus.remotes[0]?.url ??
          null;
        refreshBuildMemoryProjectKey();
        // Capture the GitHub CLI state once — gates the issue/push/PR typed
        // actions in the Architect prompts (only when gh is installed + authed).
        githubCli = repoStatus.githubCli;
        repoLabels = repoStatus.labels ?? [];
        emit({ type: "repo_status", status: toRepoStatusEvent(repoStatus) });
      }
    } else {
      emit({
        type: "diagnostic",
        phase: "initializing",
        message: `Local runner not reachable (${health.error}) — continuing without command execution`,
      });
    }
  }
  if (benchmark?.runnerOnly && !runner) {
    const message = "Certified benchmark run requires a connected bench runner.";
    emitBenchmarkEvent({
      type: "run_blocked",
      phase: "initializing",
      message,
    });
    throw new Error(message);
  }

  const currentRunBudget = () =>
    runBudgetStatus({
      runnerAvailable: !!runner,
      totalRuns,
      githubWorkflow: githubWorkflow && !!runner,
    });

  /**
   * Re-read repo status (and a BOUNDED diff summary) and push them to the UI.
   * Called after each implementation wave so branch / dirty state and the
   * latest changes stay current as files are written. No-op without a Git
   * repo. All wrappers are soft — failures are swallowed so a flaky runner
   * never aborts the build.
   */
  const refreshRepoState = async (): Promise<RepoStatus | null> => {
    if (!runner || !repoIsGit) return null;
    try {
      const repoStatus = await getRepoStatusViaRunner(runner);
      if (repoStatus) {
        repoIsGit = repoStatus.isRepo;
        emit({ type: "repo_status", status: toRepoStatusEvent(repoStatus) });
      }
      // `--stat` keeps the payload small; `toRepoDiffEvent` caps it further.
      const repoDiff = await getRepoDiffViaRunner(runner, { stat: true });
      if (repoDiff) {
        emit({ type: "repo_diff", diff: toRepoDiffEvent(repoDiff) });
      }
      return repoStatus;
    } catch (err) {
      console.error("[build] refreshing repo status failed:", err);
      return null;
    }
  };

  const runsLeftThisPhase = (): number => currentRunBudget().normalRunsLeft;

  const canExecuteRunAction = (command: string): boolean => {
    const budget = currentRunBudget();
    return (
      budget.normalRunsLeft > 0 ||
      (budget.githubCommandsUnlimited && isGitHubWorkflowCommand(command))
    );
  };

  const fetchesLeftThisPhase = (): number =>
    runner ? Math.min(FETCHES_PER_PHASE, TOTAL_FETCHES - totalFetches) : 0;

  const mcpCallsLeftThisPhase = (): number =>
    runner && mcpToolsDoc
      ? Math.min(MCP_CALLS_PER_PHASE, TOTAL_MCP_CALLS - totalMcpCalls)
      : 0;

  const codeIntelCallsLeftThisPhase = (): number =>
    codeIntelProvider?.status.available ? codeIntelBudget.callsLeft() : 0;

  const codeIntelStatusForPrompt = (): string =>
    codeIntelProvider?.status.available ? codeIntelProvider.status.detail : "";

  const emitCodeIntelStatus = (
    status: CodeIntelStatus | null | undefined,
    options: {
      status?: CodeIntelStatusEvent["status"];
      detail?: string;
      architectureDigestIncluded?: boolean;
      changeImpactDigestIncluded?: boolean;
    } = {}
  ): void => {
    emit({
      type: "code_intel_status",
      provider: status?.mode ?? "none",
      status:
        options.status ??
        (status?.available ? "available" : "unavailable"),
      available: status?.available ?? false,
      detail:
        options.detail ??
        status?.detail ??
        "Code intelligence is unavailable.",
      tools: status?.tools.slice(0, 8),
      capabilities: status?.capabilities.slice(0, 8),
      architectureDigestIncluded: options.architectureDigestIncluded ?? false,
      changeImpactDigestIncluded: options.changeImpactDigestIncluded ?? false,
      callsLeft: codeIntelCallsLeftThisPhase(),
    });
  };

  const rememberLocalServerUrls = (text: string): void => {
    const next = extractLocalServerUrls(text);
    const merged = [...new Set([...localServerUrls, ...next])].slice(0, 5);
    if (merged.length === localServerUrls.length) return;
    localServerUrls = merged;
    emit({
      type: "diagnostic",
      phase: "model_streaming",
      message: `Detected local server URL(s) for browser tools: ${next.join(", ")}`,
    });
  };

  const isBackgroundRunCommand = (command: string): boolean => {
    const trimmed = command.trim();
    return trimmed.endsWith("&") && !trimmed.endsWith("&&");
  };

  const stopBuildBackgroundProcesses = async (reason: string): Promise<void> => {
    if (!runner) return;
    const processes = await listRunnerBackgroundProcesses(runner);
    if (!processes || processes.length === 0) return;
    const buildPids = processes
      .map((process) => process.pid)
      .filter((pid) => !runnerBackgroundBaseline.has(pid));
    if (buildPids.length === 0) return;
    const result = await stopRunnerBackgroundProcesses(runner, buildPids);
    if (!result || result.stopped <= 0) return;
    if (reason === "before starting a new background command") {
      localServerUrls = [];
    }
    if (!backgroundCleanupNoticeEmitted || reason !== "before starting a new background command") {
      backgroundCleanupNoticeEmitted = true;
      emit({
        type: "diagnostic",
        phase: "model_streaming",
        message: `Stopped ${result.stopped} Build-started background process(es) ${reason}.`,
      });
    }
  };

  /** Execute one MCP tool call (same approval flow as commands). */
  const executeTool = async (
    action: ToolAction,
    actor: SelectedModel = architect
  ): Promise<{
    text: string;
    status: ToolCallResultStatus;
    /** A screenshot/image the MCP tool returned (vision review). Older runners
     * never set this; the architect dispatch path ignores it. */
    image?: { mimeType: string; dataBase64: string };
  }> => {
    if (!runner) return { text: "No runner is available.", status: "error" };
    const label = `mcp:${action.server}.${action.tool} ${truncate(JSON.stringify(action.args ?? {}), 200)}`;
    const providerId = parseModelId(actor.modelId).providerId;
    const benchmarkBlock = shouldBlockBuildBenchmarkAction("tool", benchmark);
    if (benchmarkBlock.blocked) {
      const message = benchmarkBlock.reason ?? "MCP tool call blocked.";
      recordBenchmarkToolTrace({
        toolName: "mcp",
        command: label,
        status: "blocked",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 0,
        inputJson: JSON.stringify(action),
        outputPreview: message,
      });
      emitBenchmarkEvent({
        type: "tool_call_blocked",
        phase: "model_streaming",
        message,
        modelId: actor.modelId,
        providerId,
      });
      emit({
        type: "command_run",
        command: label,
        exitCode: -1,
        durationMs: 0,
        outputPreview: message,
        denied: true,
      });
      return {
        text: `${label}\n${message}`,
        status: "denied",
      };
    }
    const safety = validateBuildMcpToolAction(action, {
      playwrightNavigated,
    });
    if (!safety.allowed) {
      const message = safety.message ?? `MCP ${action.server}.${action.tool} is not allowed.`;
      const details = safety.guidance ?? message;
      recordBuildProblem({
        code: "tool_denied",
        severity: "warning",
        source: "mcp",
        action: label,
        modelId: actor.modelId,
        modelName: actor.displayName,
        providerId,
        message,
        details,
      });
      emit({
        type: "command_run",
        command: label,
        exitCode: -1,
        durationMs: 0,
        outputPreview: `${message}\n${details}`,
        denied: true,
      });
      return {
        text: `${label}\n${message}\n${details}`,
        status: "denied",
      };
    }
    const requestedServer = mcpServersForCodeIntel.find(
      (server) => server.name === action.server
    );
    if (!isGenericMcpToolAllowed(requestedServer, action.tool)) {
      const message = `MCP ${action.server}.${action.tool} is blocked: codebase-memory mutating tools are not available through generic MCP. Use read-only code_intel actions or non-mutating MCP tools.`;
      recordBuildProblem({
        code: "tool_denied",
        severity: "warning",
        source: "mcp",
        action: label,
        modelId: actor.modelId,
        modelName: actor.displayName,
        providerId,
        message,
      });
      emit({
        type: "command_run",
        command: label,
        exitCode: -1,
        durationMs: 0,
        outputPreview: message,
        denied: true,
      });
      return {
        text: `${label}\n${message}`,
        status: "denied",
      };
    }
    if (!benchmarkApprovalsBypassed()) {
      const decision = hooks?.requestCommandApproval
        ? await hooks.requestCommandApproval(label, action.reason)
        : "deny";
      if (decision === "allow-all") allowAllCommands = true;
      if (decision === "deny") {
        recordBuildProblem({
          code: "tool_denied",
          severity: "warning",
          source: "mcp",
          action: label,
          modelId: actor.modelId,
          modelName: actor.displayName,
          providerId,
          message: `MCP ${action.server}.${action.tool} was denied by the user.`,
        });
        emit({
          type: "command_run",
          command: label,
          exitCode: -1,
          durationMs: 0,
          outputPreview: "Denied by the user",
          denied: true,
        });
        return {
          text: `${label}\nThe user DENIED this tool call. Continue without it.`,
          status: "denied",
        };
      }
    }
    totalMcpCalls += 1;
    emit({
      type: "diagnostic",
      phase: "model_streaming",
      modelId: actor.modelId,
      modelName: actor.displayName,
      providerId,
      message: `MCP tool: ${action.server}.${action.tool}`,
    });
    const startedAt = Date.now();
    const traceStartedAt = new Date().toISOString();
    try {
      let result = await callMcpTool(
        runner,
        action.server,
        action.tool,
        action.args ?? {}
      );
      if (
        result.isError &&
        shouldRetryPlaywrightNavigateAfterClosedTarget(action, result.text)
      ) {
        emit({
          type: "diagnostic",
          phase: "model_streaming",
          modelId: actor.modelId,
          modelName: actor.displayName,
          providerId,
          message:
            "Retrying Playwright browser_navigate after the MCP reported a closed page/context.",
        });
        const firstError = result.text.trim();
        const retry = await callMcpTool(
          runner,
          action.server,
          action.tool,
          action.args ?? {}
        );
        result = {
          ...retry,
          text: retry.isError
            ? `${firstError}\n\nRetry after closed page/context also failed:\n${retry.text}`
            : `Recovered after retrying browser_navigate because the first Playwright target was closed.\n\n${retry.text}`,
        };
      }
      if (!result.isError && action.server.toLowerCase().includes("playwright")) {
        const toolName = action.tool.toLowerCase();
        if (toolName === "browser_navigate") {
          playwrightNavigated = true;
        } else if (
          playwrightNavigated &&
          /(snapshot|evaluate|screenshot)/i.test(toolName)
        ) {
          browserAcceptanceObserved = true;
          browserAcceptanceEvidence = `${action.server}.${action.tool}`;
        }
      }
      emit({
        type: "command_run",
        command: label,
        exitCode: result.isError ? 1 : 0,
        durationMs: Date.now() - startedAt,
        outputPreview: result.truncated
          ? `${truncate(result.text.trim(), 340)}\n[TRUNCATED to runner size cap]`
          : truncate(result.text.trim(), 400),
      });
      recordBenchmarkToolTrace({
        toolName: "mcp",
        command: label,
        status: result.isError ? "failed" : "ok",
        startedAt: traceStartedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        inputJson: JSON.stringify(action),
        outputPreview: truncate(result.text.trim(), 400),
        error: result.isError ? truncate(result.text.trim(), 1_500) : undefined,
      });
      if (result.isError) {
        recordBuildProblem({
          code: "command_failed",
          severity: "error",
          source: "mcp",
          action: label,
          modelId: actor.modelId,
          modelName: actor.displayName,
          providerId,
          message: `MCP ${action.server}.${action.tool} returned ERROR.`,
          details: truncate(result.text.trim(), 1_500),
        });
      }
      return {
        text: formatMcpToolContextText({
          server: action.server,
          tool: action.tool,
          isError: result.isError,
          truncated: result.truncated,
          text: result.text,
        }),
        status: result.isError ? "error" : "ok",
        ...(result.image ? { image: result.image } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "MCP call failed";
      recordBuildProblem({
        code: "command_failed",
        severity: "error",
        source: "mcp",
        action: label,
        modelId: actor.modelId,
        modelName: actor.displayName,
        providerId,
        message: `MCP ${action.server}.${action.tool} failed: ${message}`,
        details: message,
      });
      emit({
        type: "command_run",
        command: label,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        outputPreview: message,
      });
      recordBenchmarkToolTrace({
        toolName: "mcp",
        command: label,
        status: "failed",
        startedAt: traceStartedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        inputJson: JSON.stringify(action),
        outputPreview: message,
        error: message,
      });
      return {
        text: `MCP ${action.server}.${action.tool} failed: ${message}`,
        status: "error",
      };
    }
  };

  /** Execute one Architect-requested command (with approval when required). */
  const executeRun = async (
    command: string,
    reason?: string
  ): Promise<string> => {
    if (!runner) return "No runner is available.";
    const traceStartedAt = new Date().toISOString();
    const traceStartMs = Date.now();
    const benchmarkCommand = validateBuildBenchmarkCommand(command, benchmark);
    if (!benchmarkCommand.allowed) {
      const message = benchmarkCommand.reason ?? "Command blocked by benchmark policy.";
      recordBenchmarkToolTrace({
        toolName: "run",
        command,
        status: "blocked",
        startedAt: traceStartedAt,
        completedAt: new Date().toISOString(),
        durationMs: 0,
        outputPreview: message,
      });
      emitBenchmarkEvent({
        type: "tool_call_blocked",
        phase: "model_streaming",
        message,
        detailsJson: JSON.stringify({ command }),
      });
      emit({
        type: "command_run",
        command,
        exitCode: -1,
        durationMs: 0,
        outputPreview: message,
        denied: true,
      });
      return `$ ${command}\nCOMMAND REJECTED: ${message}`;
    }
    // NRW-006: block raw `git commit`/`git add` through the normal run path when
    // the runner folder is a Git repo. Commits must go through the typed,
    // user-approved repo_commit action (which gates on a safe feature branch).
    if (repoIsGit && isRawCommitCommand(command)) {
      const message =
        'Refusing a raw "git commit"/"git add" command. Use the typed {"action":"repo_commit","message":"…"} action instead — it stages and commits with the user\'s approval and only after a safe feature branch exists.';
      emit({
        type: "command_run",
        command,
        exitCode: -1,
        durationMs: 0,
        outputPreview: message,
        denied: true,
      });
      return `$ ${command}\nCOMMAND REJECTED: ${message}`;
    }
    const safety = classifyRunCommand(command);
    if (!safety.allowed) {
      const message = `Command rejected: ${safety.reason} Use patch/append/edit output for file changes, then run tests/build commands only for verification.`;
      emit({
        type: "command_run",
        command,
        exitCode: -1,
        durationMs: 0,
        outputPreview: message,
        denied: true,
      });
      return `$ ${command}\nCOMMAND REJECTED: ${message}`;
    }
    if (!benchmarkApprovalsBypassed()) {
      const decision = hooks?.requestCommandApproval
        ? await hooks.requestCommandApproval(command, reason)
        : "deny";
      if (decision === "allow-all") allowAllCommands = true;
      if (decision === "deny") {
        emit({
          type: "command_run",
          command,
          exitCode: -1,
          durationMs: 0,
          outputPreview: "Denied by the user",
          denied: true,
        });
        return `$ ${command}\nThe user DENIED this command. Continue without it.`;
      }
    }
    const githubBudgetExempt =
      githubWorkflow && isGitHubWorkflowCommand(command);
    if (!githubBudgetExempt) totalRuns += 1;
    emit({
      type: "diagnostic",
      phase: "model_streaming",
      message: `Running command: ${command}`,
    });
    try {
      if (isBackgroundRunCommand(command)) {
        await stopBuildBackgroundProcesses("before starting a new background command");
      }
      const result = await runCommand(runner, command);
      emit({
        type: "command_run",
        command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        background: result.background,
        outputPreview: truncate(
          stripAnsi(result.stdout || result.stderr).trim(),
          400
        ),
      });
      const outputPreview = truncate(
        stripAnsi(result.stdout || result.stderr).trim(),
        800
      );
      if (result.exitCode === 0) {
        rememberLocalServerUrls(
          [command, result.stdout, result.stderr].filter(Boolean).join("\n")
        );
      }
      rememberCommandMemory({
        command,
        exitCode: result.exitCode,
        outputPreview,
        createdAt: new Date().toISOString(),
      });
      recordBenchmarkToolTrace({
        toolName: "run",
        command,
        status: result.exitCode === 0 ? "ok" : "failed",
        exitCode: result.exitCode,
        startedAt: traceStartedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - traceStartMs,
        outputPreview: truncate(outputPreview, 400),
        error:
          result.exitCode === 0
            ? undefined
            : truncate(stripAnsi(result.stderr || result.stdout).trim(), 1_500),
      });
      // Commands can create files (scaffolders, installs) — refresh the tree.
      const refreshed = await listFilesViaRunner(runner);
      if (refreshed) diskTree = [...new Set([...diskTree, ...refreshed])];
      return formatCommandResult(command, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Runner request failed";
      emit({
        type: "command_run",
        command,
        exitCode: -1,
        durationMs: 0,
        outputPreview: message,
      });
      rememberCommandMemory({
        command,
        exitCode: 1,
        outputPreview: message,
        createdAt: new Date().toISOString(),
      });
      recordBenchmarkToolTrace({
        toolName: "run",
        command,
        status: "failed",
        startedAt: traceStartedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - traceStartMs,
        outputPreview: message,
        error: message,
      });
      return `$ ${command}\nRunner error: ${message}`;
    }
  };

  /** Fetch a public URL via the runner (same approval flow as commands). */
  const executeFetch = async (action: FetchAction): Promise<string> => {
    if (!runner) return "No runner is available.";
    const label = `fetch ${action.url}`;
    const benchmarkBlock = shouldBlockBuildBenchmarkAction("fetch", benchmark);
    if (benchmarkBlock.blocked) {
      const message = benchmarkBlock.reason ?? "Fetch blocked by benchmark policy.";
      emitBenchmarkEvent({
        type: "tool_call_blocked",
        phase: "model_streaming",
        message,
        detailsJson: JSON.stringify({ url: action.url }),
      });
      emit({
        type: "command_run",
        command: label,
        exitCode: -1,
        durationMs: 0,
        outputPreview: message,
        denied: true,
      });
      return `${label}\n${message}`;
    }
    if (!benchmarkApprovalsBypassed()) {
      const decision = hooks?.requestCommandApproval
        ? await hooks.requestCommandApproval(label, action.reason)
        : "deny";
      if (decision === "allow-all") allowAllCommands = true;
      if (decision === "deny") {
        emit({
          type: "command_run",
          command: label,
          exitCode: -1,
          durationMs: 0,
          outputPreview: "Denied by the user",
          denied: true,
        });
        return `${label}\nThe user DENIED this fetch. Continue without it.`;
      }
    }
    totalFetches += 1;
    emit({
      type: "diagnostic",
      phase: "model_streaming",
      message: `Fetching ${truncate(action.url, 120)}`,
    });
    const startedAt = Date.now();
    try {
      const result = await fetchViaRunner(runner, action.url);
      emit({
        type: "command_run",
        command: label,
        exitCode: result.status >= 200 && result.status < 400 ? 0 : 1,
        durationMs: result.durationMs,
        outputPreview: `HTTP ${result.status} ${result.statusText}; ${result.contentType || "unknown type"}; ${result.text.length} chars${result.truncated ? " (truncated)" : ""}`,
      });
      return formatFetchContextText({
        finalUrl: result.finalUrl,
        status: result.status,
        statusText: result.statusText,
        contentType: result.contentType,
        durationMs: result.durationMs,
        truncated: result.truncated,
        text: result.text,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Fetch failed";
      emit({
        type: "command_run",
        command: label,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        outputPreview: message,
      });
      return `${label}\nFetch failed: ${message}`;
    }
  };

  // ── Typed repo (Git) actions (NRW-004) ────────────────────────────────────
  // These run via the runner's /repo/* endpoints, never `runCommand`. Status
  // and diff are non-mutating inspection (no approval); mutating typed repo
  // actions prompt in ordinary Ask mode, but auto-run for an explicit GitHub
  // workflow so PR review/merge is the human gate.
  const repoUnavailable = (): string =>
    "Repo workflow is unavailable: no local runner is connected, or the runner is too old for typed repo endpoints. Continue without it.";

  /** Re-query repo status, push it to the UI, and return a compact summary. */
  const executeRepoStatus = async (): Promise<string> => {
    if (!runner) return repoUnavailable();
    let status: RepoStatus | null;
    try {
      status = await getRepoStatusViaRunner(runner);
    } catch (err) {
      return `Repo status failed: ${err instanceof Error ? err.message : "runner error"}.`;
    }
    if (!status) return repoUnavailable();
    repoIsGit = status.isRepo;
    emit({ type: "repo_status", status: toRepoStatusEvent(status) });
    if (!status.isRepo) {
      return status.gitAvailable
        ? "Repo status — the runner folder is not currently a Git repository. Use repo_init if the user asked for a local repo."
        : "Repo status — git is not installed or not on PATH, so the runner cannot initialize or inspect a repository.";
    }
    const dirty =
      status.staged.length +
      status.unstaged.length +
      status.untracked.length +
      status.conflicted.length;
    const parts = [
      `branch: ${status.currentBranch ?? "(detached HEAD)"}`,
      status.upstream ? `upstream: ${status.upstream} (ahead ${status.ahead}, behind ${status.behind})` : "no upstream",
      status.clean
        ? "working tree clean"
        : `dirty — staged ${status.staged.length}, unstaged ${status.unstaged.length}, untracked ${status.untracked.length}, conflicted ${status.conflicted.length}`,
    ];
    emitFileToolDiagnostic(
      `Architect repo_status · ${status.currentBranch ?? "detached"} · ${dirty} change(s)`,
      architect
    );
    return `Repo status — ${parts.join("; ")}.`;
  };

  /** Fetch a bounded diff, push it to the UI, and return a bounded summary. */
  const executeRepoDiff = async (action: RepoDiffAction): Promise<string> => {
    if (!runner || !repoIsGit) return repoUnavailable();
    let diff: Awaited<ReturnType<typeof getRepoDiffViaRunner>>;
    try {
      diff = await getRepoDiffViaRunner(runner, {
        paths: action.paths,
        staged: action.staged,
        stat: action.stat,
      });
    } catch (err) {
      return `Repo diff failed: ${err instanceof Error ? err.message : "runner error"}.`;
    }
    if (!diff) return repoUnavailable();
    emit({ type: "repo_diff", diff: toRepoDiffEvent(diff) });
    const scope = action.paths?.length ? ` for ${action.paths.join(", ")}` : "";
    const kind = action.staged ? "staged " : "";
    emitFileToolDiagnostic(
      `Architect repo_diff${scope ? ` (${action.paths?.length} path(s))` : ""} · ${kbOf(diff.diff)}`,
      architect
    );
    const fullDiff = diff.diff.trim();
    const body =
      fullDiff.length > REPO_DIFF_RESULT_CHARS
        ? storeLongToolResult(
            "repo_diff",
            `Repo diff${scope}`,
            fullDiff,
            REPO_DIFF_RESULT_CHARS
          )
        : fullDiff;
    return [
      `${kind}diff${scope}${diff.truncated ? " (truncated)" : ""}:`,
      body || "(no changes)",
    ].join("\n");
  };

  /**
   * Initialize the runner folder as a Git repository. MUTATING — requires user
   * approval unless runner access is "full" or this is an explicit GitHub
   * workflow. Never uses runCommand/executeRun.
   */
  const executeRepoInit = async (action: RepoInitAction): Promise<string> => {
    if (!runner) return repoUnavailable();
    const branch = action.branch?.trim() || "main";
    const label = `git init: ${branch}`;
    if (shouldRequestRepoMutationApproval()) {
      const decision = hooks?.requestCommandApproval
        ? await hooks.requestCommandApproval(label, action.reason)
        : "deny";
      if (decision === "allow-all") allowAllCommands = true;
      if (decision === "deny") {
        emit({
          type: "command_run",
          command: label,
          exitCode: -1,
          durationMs: 0,
          outputPreview: "Denied by the user",
          denied: true,
        });
        return `The user DENIED initializing a Git repository on branch "${branch}". Continue without repo workflow.`;
      }
    }

    let result: Awaited<ReturnType<typeof initRepoViaRunner>>;
    try {
      result = await initRepoViaRunner(runner, { branch });
    } catch (err) {
      const message = err instanceof Error ? err.message : "runner error";
      emit({
        type: "command_run",
        command: label,
        exitCode: -1,
        durationMs: 0,
        outputPreview: message,
      });
      return `Repo initialization failed: ${message}. Continue.`;
    }
    if (!result) return repoUnavailable();
    repoIsGit = true;
    repoCommitWorkflowEnabled = true;
    repoInitializedByBuild = repoInitializedByBuild || result.initialized;
    repoActiveBranch = result.branch ?? branch;
    emit({
      type: "command_run",
      command: label,
      exitCode: 0,
      durationMs: 0,
      outputPreview: result.alreadyRepo
        ? `Already a Git repository${result.branch ? ` on ${result.branch}` : ""}`
        : `Initialized Git repository on ${repoActiveBranch ?? branch}`,
    });
    try {
      const status = await getRepoStatusViaRunner(runner);
      if (status) {
        repoIsGit = status.isRepo;
        repoCommitWorkflowEnabled = status.isRepo;
        if (status.currentBranch) repoActiveBranch = status.currentBranch;
        emit({ type: "repo_status", status: toRepoStatusEvent(status) });
      }
    } catch {
      // best-effort refresh
    }
    return result.alreadyRepo
      ? `Runner folder is already a Git repository${result.branch ? ` on branch "${result.branch}"` : ""}.`
      : `Initialized a Git repository in the runner folder on branch "${repoActiveBranch ?? branch}". You may use repo_commit after file changes are ready.`;
  };

  /**
   * Create a branch via the typed runner endpoint. MUTATING — requires user
   * approval unless runner access is "full" or this is an explicit GitHub
   * workflow. Never uses runCommand/executeRun.
   */
  const executeRepoBranchCreate = async (
    action: RepoBranchCreateAction
  ): Promise<string> => {
    if (!runner || !repoIsGit) return repoUnavailable();
    const label = `git branch: ${action.name}`;
    if (shouldRequestRepoMutationApproval()) {
      const decision = hooks?.requestCommandApproval
        ? await hooks.requestCommandApproval(label, action.reason)
        : "deny";
      if (decision === "allow-all") allowAllCommands = true;
      if (decision === "deny") {
        emit({
          type: "command_run",
          command: label,
          exitCode: -1,
          durationMs: 0,
          outputPreview: "Denied by the user",
          denied: true,
        });
        return `The user DENIED creating branch "${action.name}". Continue without it.`;
      }
    }
    let result: Awaited<ReturnType<typeof createBranchViaRunner>>;
    try {
      result = await createBranchViaRunner(runner, {
        name: action.name,
        base: action.base,
        checkout: action.checkout,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "runner error";
      emit({
        type: "command_run",
        command: label,
        exitCode: -1,
        durationMs: 0,
        outputPreview: message,
      });
      return `Branch creation failed: ${message}. Continue.`;
    }
    if (!result) return repoUnavailable();
    emit({
      type: "command_run",
      command: label,
      exitCode: 0,
      durationMs: 0,
      outputPreview: `Created ${result.branch}${result.checkedOut ? " (checked out)" : ""}`,
    });
    // Branch creation changes HEAD — refresh the repo panel.
    try {
      const status = await getRepoStatusViaRunner(runner);
      if (status) {
        repoIsGit = status.isRepo;
        repoCommitWorkflowEnabled = repoCommitWorkflowEnabledFromStatus(status);
        if (repoCommitWorkflowEnabled && status.currentBranch) {
          repoActiveBranch = status.currentBranch;
        }
        emit({ type: "repo_status", status: toRepoStatusEvent(status) });
      }
    } catch {
      // best-effort refresh
    }
    return `Created branch "${result.branch}"${
      action.base ? ` from ${action.base}` : ""
    }${result.checkedOut ? " and checked it out" : " (not checked out)"}${
      result.previousBranch ? `; previous branch was "${result.previousBranch}"` : ""
    }.`;
  };

  /**
   * Commit changes via the typed runner endpoint. MUTATING; mirrors
   * executeRepoBranchCreate's approval gate, command_run emits, and post-action
   * repo_status refresh. ONLY available once a safe feature branch exists
   * (repoCommitWorkflowEnabled). Never uses runCommand/executeRun.
   */
  const executeRepoCommit = async (
    action: RepoCommitAction
  ): Promise<string> => {
    if (!runner || !repoIsGit) return repoUnavailable();
    // Require a safe feature branch from the NRW-005 gate. Without it, refuse
    // to commit (acceptance-critical) — never land work on default/main/master.
    if (!repoCommitWorkflowEnabled) {
      return (
        "Commit is unavailable: a safe feature branch has not been established for this run " +
        "(you're on the default/main/master branch, conflicts exist, or branch creation was " +
        "declined). Do not commit. Continue producing file changes; commits can only land on a " +
        "feature branch."
      );
    }

    // Refresh status + diff so the panel shows the pending changes, and build a
    // compact changed-files preview for the approval prompt.
    let preStatus: RepoStatus | null = null;
    try {
      preStatus = await getRepoStatusViaRunner(runner);
      if (preStatus) {
        repoIsGit = preStatus.isRepo;
        emit({ type: "repo_status", status: toRepoStatusEvent(preStatus) });
      }
      const preDiff = await getRepoDiffViaRunner(runner, { stat: true });
      if (preDiff) emit({ type: "repo_diff", diff: toRepoDiffEvent(preDiff) });
    } catch {
      // best-effort refresh; commit still proceeds
    }
    const changedFiles = action.paths?.length
      ? action.paths
      : preStatus
        ? [
            ...preStatus.staged,
            ...preStatus.unstaged,
            ...preStatus.untracked,
          ]
        : [];
    const uniqueChanged = [...new Set(changedFiles)];
    const filesPreview =
      uniqueChanged.length > 0
        ? uniqueChanged.slice(0, 20).join(", ") +
          (uniqueChanged.length > 20 ? `, …(+${uniqueChanged.length - 20} more)` : "")
        : "(staging all pending changes)";

    const firstLine = action.message.split("\n")[0];
    const label = `git commit: ${firstLine}`;
    const approvalReason = `Commit message: "${action.message}". Changed files: ${filesPreview}.${
      action.reason ? ` Reason: ${action.reason}` : ""
    }`;
    if (shouldRequestRepoMutationApproval()) {
      const decision = hooks?.requestCommandApproval
        ? await hooks.requestCommandApproval(label, approvalReason)
        : "deny";
      if (decision === "allow-all") allowAllCommands = true;
      if (decision === "deny") {
        emit({
          type: "command_run",
          command: label,
          exitCode: -1,
          durationMs: 0,
          outputPreview: "Denied by the user",
          denied: true,
        });
        return `The user DENIED the commit "${firstLine}". Continue without it.`;
      }
    }

    let result: Awaited<ReturnType<typeof commitViaRunner>>;
    try {
      result = await commitViaRunner(runner, {
        message: action.message,
        paths: action.paths,
      });
    } catch (err) {
      // e.g. empty commit / validation rejection — surface, don't crash.
      const message = err instanceof Error ? err.message : "runner error";
      emit({
        type: "command_run",
        command: label,
        exitCode: -1,
        durationMs: 0,
        outputPreview: message,
      });
      return `Commit failed: ${message}. Continue.`;
    }
    if (!result) return repoUnavailable();

    repoCommits.push({ hash: result.hash, subject: result.subject });
    // Remember the branch the commit landed on (status reflects HEAD's branch).
    if (preStatus?.currentBranch) repoActiveBranch = preStatus.currentBranch;
    emit({
      type: "command_run",
      command: label,
      exitCode: 0,
      durationMs: 0,
      outputPreview: `Committed ${result.hash} ${result.subject}`,
    });
    // Refresh repo status so the panel's recentCommits shows the new commit.
    try {
      const status = await getRepoStatusViaRunner(runner);
      if (status) {
        repoIsGit = status.isRepo;
        if (status.currentBranch) repoActiveBranch = status.currentBranch;
        emit({ type: "repo_status", status: toRepoStatusEvent(status) });
      }
    } catch {
      // best-effort refresh
    }
    return `Committed ${result.hash} "${result.subject}" (${
      result.committedFiles.length
    } file${result.committedFiles.length === 1 ? "" : "s"}: ${result.committedFiles
      .slice(0, 20)
      .join(", ")}${result.committedFiles.length > 20 ? ", …" : ""}).`;
  };

  const executeRepoIssueList = async (
    action: RepoIssueListAction
  ): Promise<string> => {
    if (!runner || !repoIsGit) return repoUnavailable();
    if (githubCli && (!githubCli.available || !githubCli.authenticated)) {
      return (
        "GitHub issue listing is unavailable: the runner's GitHub CLI (`gh`) is " +
        `${githubCli.available ? "not authenticated" : "not installed"}. Continue without GitHub issue context.`
      );
    }
    let result: Awaited<ReturnType<typeof listIssuesViaRunner>>;
    try {
      result = await listIssuesViaRunner(runner, {
        repo: action.repo,
        labels: action.labels,
        limit: action.limit,
      });
    } catch (err) {
      return `Issue listing failed: ${err instanceof Error ? err.message : "runner error"}. Continue.`;
    }
    if (!result) return repoUnavailable();
    emitFileToolDiagnostic(
      `Architect repo_issue_list · ${result.repo} · ${result.issues.length} open issue(s)`,
      architect
    );
    if (result.issues.length === 0) {
      return `Open GitHub issues for ${result.repo}: none found.`;
    }
    return [
      `Open GitHub issues for ${result.repo}:`,
      ...result.issues.slice(0, 30).map((issue) => {
        const labels = issue.labels.length ? ` [${issue.labels.join(", ")}]` : "";
        const body = truncate(issue.body.trim().replace(/\s+/g, " "), 500);
        return `- #${issue.number}: ${issue.title}${labels}${issue.url ? ` (${issue.url})` : ""}${body ? `\n  ${body}` : ""}`;
      }),
    ].join("\n");
  };

  const executeRepoMilestoneCreate = async (
    action: RepoMilestoneCreateAction
  ): Promise<string> => {
    if (!runner || !repoIsGit) return repoUnavailable();
    if (githubCli && (!githubCli.available || !githubCli.authenticated)) {
      return (
        "GitHub milestone creation is unavailable: the runner's GitHub CLI (`gh`) is " +
        `${githubCli.available ? "not authenticated" : "not installed"}. Continue without creating a milestone.`
      );
    }
    const label = `gh milestone create: ${action.title}`;
    if (shouldRequestRepoMutationApproval()) {
      const decision = hooks?.requestCommandApproval
        ? await hooks.requestCommandApproval(label, action.reason)
        : "deny";
      if (decision === "allow-all") allowAllCommands = true;
      if (decision === "deny") {
        emit({
          type: "command_run",
          command: label,
          exitCode: -1,
          durationMs: 0,
          outputPreview: "Denied by the user",
          denied: true,
        });
        return `The user DENIED creating milestone "${action.title}". Continue without it.`;
      }
    }
    let result: Awaited<ReturnType<typeof createMilestoneViaRunner>>;
    try {
      result = await createMilestoneViaRunner(runner, {
        repo: action.repo,
        title: action.title,
        description: action.description,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "runner error";
      emit({
        type: "command_run",
        command: label,
        exitCode: -1,
        durationMs: 0,
        outputPreview: message,
      });
      return `Milestone creation failed: ${message}. Continue.`;
    }
    if (!result) return repoUnavailable();
    repoMilestoneTitle = result.title;
    emit({ type: "repo_workflow", milestone: result.title });
    emit({
      type: "command_run",
      command: label,
      exitCode: 0,
      durationMs: 0,
      outputPreview: `${result.created ? "Created" : "Reused"} milestone ${result.title}`,
    });
    return `${result.created ? "Created" : "Reused"} GitHub milestone "${result.title}"${
      result.url ? ` — ${result.url}` : ""
    }.`;
  };

  const executeRepoIssueCreate = async (
    action: RepoIssueCreateAction
  ): Promise<string> => {
    if (!runner || !repoIsGit) return repoUnavailable();
    if (githubCli && (!githubCli.available || !githubCli.authenticated)) {
      return (
        "GitHub issue creation is unavailable: the runner's GitHub CLI (`gh`) is " +
        `${githubCli.available ? "not authenticated" : "not installed"}. Continue without creating the issue.`
      );
    }
    const label = `gh issue create: ${action.title}`;
    if (shouldRequestRepoMutationApproval()) {
      const decision = hooks?.requestCommandApproval
        ? await hooks.requestCommandApproval(label, action.reason)
        : "deny";
      if (decision === "allow-all") allowAllCommands = true;
      if (decision === "deny") {
        emit({
          type: "command_run",
          command: label,
          exitCode: -1,
          durationMs: 0,
          outputPreview: "Denied by the user",
          denied: true,
        });
        return `The user DENIED creating issue "${action.title}". Continue without it.`;
      }
    }
    let result: Awaited<ReturnType<typeof createIssueViaRunner>>;
    try {
      result = await createIssueViaRunner(runner, {
        repo: action.repo,
        title: action.title,
        body: action.body,
        milestone: action.milestone,
        labels: action.labels,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "runner error";
      emit({
        type: "command_run",
        command: label,
        exitCode: -1,
        durationMs: 0,
        outputPreview: message,
      });
      return `Issue creation failed: ${message}. Continue.`;
    }
    if (!result) return repoUnavailable();
    if (result.issue > 0) {
      repoCreatedIssues.push({
        issue: result.issue,
        title: result.title,
        url: result.url,
      });
      if (repoIssueNumber == null) repoIssueNumber = result.issue;
      emit({
        type: "repo_workflow",
        issue: repoIssueNumber,
        issues: repoCreatedIssues.map((item) => item.issue),
      });
    }
    emit({
      type: "command_run",
      command: label,
      exitCode: 0,
      durationMs: 0,
      outputPreview: `Created issue #${result.issue || "?"} ${result.title}`,
    });
    return `Created GitHub issue ${result.issue ? `#${result.issue}` : ""} "${result.title}"${
      result.url ? ` — ${result.url}` : ""
    }.`;
  };

  /**
   * Import a GitHub issue via the gh-backed runner endpoint (NRW-008).
   * NON-MUTATING — no approval gate. Returns bounded issue context (title +
   * body + comments, truncated) to the Architect and remembers the issue number
   * for the final summary. When gh is unavailable/unauthenticated or the runner
   * errors, returns a clear message and continues (no crash).
   */
  const executeRepoIssueRead = async (
    action: RepoIssueReadAction
  ): Promise<string> => {
    if (!runner || !repoIsGit) return repoUnavailable();
    if (githubCli && (!githubCli.available || !githubCli.authenticated)) {
      return (
        "GitHub issue import is unavailable: the runner's GitHub CLI (`gh`) is " +
        `${githubCli.available ? "not authenticated" : "not installed"}. ` +
        "Continue without the issue context."
      );
    }
    let issue: Awaited<ReturnType<typeof readIssueViaRunner>>;
    try {
      issue = await readIssueViaRunner(runner, {
        repo: action.repo,
        issue: action.issue,
      });
    } catch (err) {
      return `Issue import failed: ${err instanceof Error ? err.message : "runner error"}. Continue.`;
    }
    if (!issue) return repoUnavailable();
    repoIssueNumber = issue.issue;
    emit({ type: "repo_workflow", issue: issue.issue });
    emitFileToolDiagnostic(
      `Architect repo_issue_read · ${action.repo}#${issue.issue} · ${issue.comments.length} comment(s)`,
      architect
    );
    const commentLines = issue.comments
      .slice(0, REPO_ISSUE_COMMENT_MAX)
      .map(
        (c) =>
          `  - ${c.author || "(unknown)"}: ${truncate(c.body.trim(), REPO_ISSUE_COMMENT_CHARS)}`
      );
    const moreComments =
      issue.comments.length > REPO_ISSUE_COMMENT_MAX
        ? `  - …(+${issue.comments.length - REPO_ISSUE_COMMENT_MAX} more comment(s))`
        : "";
    return [
      `GitHub issue ${action.repo}#${issue.issue}: ${issue.title}`,
      issue.url ? `URL: ${issue.url}` : "",
      "",
      truncate(issue.body.trim(), REPO_ISSUE_BODY_CHARS) || "(no body)",
      commentLines.length > 0 ? "\nComments:" : "",
      ...commentLines,
      moreComments,
    ]
      .filter(Boolean)
      .join("\n");
  };

  /**
   * Push a branch to the remote via the typed runner endpoint (NRW-008).
   * MUTATES external state — requires user approval unless runner access is
   * "full" or this is an explicit GitHub workflow. Mirrors
   * executeRepoBranchCreate's approval gate / command_run emits.
   */
  const executeRepoPush = async (action: RepoPushAction): Promise<string> => {
    if (!runner || !repoIsGit) return repoUnavailable();
    const remote = action.remote ?? "origin";
    const label = `git push: ${remote} ${action.branch}`;
    if (shouldRequestRepoMutationApproval()) {
      const decision = hooks?.requestCommandApproval
        ? await hooks.requestCommandApproval(label, action.reason)
        : "deny";
      if (decision === "allow-all") allowAllCommands = true;
      if (decision === "deny") {
        emit({
          type: "command_run",
          command: label,
          exitCode: -1,
          durationMs: 0,
          outputPreview: "Denied by the user",
          denied: true,
        });
        return `The user DENIED pushing branch "${action.branch}". Continue without it.`;
      }
    }
    let result: Awaited<ReturnType<typeof pushViaRunner>>;
    try {
      result = await pushViaRunner(runner, {
        remote: action.remote,
        branch: action.branch,
        setUpstream: action.setUpstream,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "runner error";
      emit({
        type: "command_run",
        command: label,
        exitCode: -1,
        durationMs: 0,
        outputPreview: message,
      });
      return `Push failed: ${message}. Continue.`;
    }
    if (!result) return repoUnavailable();
    repoPushedBranch = result.branch;
    emit({ type: "repo_workflow", pushedBranch: result.branch });
    emit({
      type: "command_run",
      command: label,
      exitCode: 0,
      durationMs: 0,
      outputPreview: `Pushed ${result.branch} to ${result.remote}${result.setUpstream ? " (upstream set)" : ""}`,
    });
    await refreshRepoState();
    return `Pushed branch "${result.branch}" to ${result.remote}${
      result.setUpstream ? " and set the upstream" : ""
    }.`;
  };

  /**
   * Open a (draft, by default) pull request via the gh-backed runner endpoint
   * (NRW-008). MUTATES external state — requires user approval unless runner
   * access is "full" or this is an explicit GitHub workflow. PRECONDITION: a
   * commit landed this run OR a clean branch ahead of its upstream. When gh is
   * unavailable/unauthenticated, returns a clear message and continues WITHOUT
   * creating a PR. Denial/failure → graceful.
   */
  const executeRepoPrCreate = async (
    action: RepoPrCreateAction
  ): Promise<string> => {
    if (!runner || !repoIsGit) return repoUnavailable();
    if (githubCli && (!githubCli.available || !githubCli.authenticated)) {
      return (
        "Pull request creation is unavailable: the runner's GitHub CLI (`gh`) is " +
        `${githubCli.available ? "not authenticated" : "not installed"}. ` +
        "Continue without opening a PR."
      );
    }
    // PRECONDITION (acceptance-critical): a commit this run, OR a clean branch
    // already ahead of upstream. Re-read status for the ahead/clean signal.
    let status: RepoStatus | null = null;
    try {
      status = await getRepoStatusViaRunner(runner);
      if (status) {
        repoIsGit = status.isRepo;
        emit({ type: "repo_status", status: toRepoStatusEvent(status) });
      }
    } catch {
      // best-effort; fall back to commit count only
    }
    const refusal = prCreateRefusalReason({
      commitsThisRun: repoCommits.length,
      clean: status?.clean ?? false,
      ahead: status?.ahead ?? 0,
      repoCommitWorkflowEnabled,
    });
    if (refusal) return refusal;

    const draft = action.draft === undefined ? true : action.draft;
    const label = `gh pr create: ${action.title}${draft ? " (draft)" : ""}`;
    const approvalReason = `Open ${draft ? "a DRAFT " : "a "}pull request titled "${action.title}"${
      action.base ? ` into ${action.base}` : ""
    }.${action.reason ? ` Reason: ${action.reason}` : ""}`;
    if (shouldRequestRepoMutationApproval()) {
      const decision = hooks?.requestCommandApproval
        ? await hooks.requestCommandApproval(label, approvalReason)
        : "deny";
      if (decision === "allow-all") allowAllCommands = true;
      if (decision === "deny") {
        emit({
          type: "command_run",
          command: label,
          exitCode: -1,
          durationMs: 0,
          outputPreview: "Denied by the user",
          denied: true,
        });
        return `The user DENIED opening the pull request "${action.title}". Continue without it.`;
      }
    }
    let result: Awaited<ReturnType<typeof createPrViaRunner>>;
    try {
      result = await createPrViaRunner(runner, {
        repo: action.repo,
        title: action.title,
        body: action.body,
        base: action.base,
        head: action.head,
        draft,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "runner error";
      emit({
        type: "command_run",
        command: label,
        exitCode: -1,
        durationMs: 0,
        outputPreview: message,
      });
      return `PR creation failed: ${message}. Continue.`;
    }
    if (!result) return repoUnavailable();
    repoPrUrl = result.url || null;
    if (result.url) emit({ type: "repo_workflow", prUrl: result.url });
    emit({
      type: "command_run",
      command: label,
      exitCode: 0,
      durationMs: 0,
      outputPreview: `Opened ${result.draft ? "draft " : ""}PR ${result.url}`,
    });
    return `Opened ${result.draft ? "draft " : ""}pull request "${result.title}"${
      result.url ? ` — ${result.url}` : ""
    }.`;
  };

  /**
   * Run the wave build-check command (resolved verifyCommand) and format its
   * result for the review prompt. Honors command approval like any run, but
   * uses its OWN budget so it never starves the Architect's discretionary
   * runs. Returns "" when there's nothing to run.
   */
  const emitBuildCheckCommandRun = (
    event: Omit<Extract<OrchestratorEvent, { type: "command_run" }>, "type">
  ): void => {
    emit({ type: "command_run", ...event });
    if (!event.denied && event.exitCode === 0) {
      rememberCommandMemory({
        command: event.command,
        exitCode: event.exitCode,
        outputPreview: event.outputPreview,
        createdAt: new Date().toISOString(),
      });
    }
    if (event.exitCode !== 0 || event.denied) {
      recordCommandProblem({
        command: event.command,
        exitCode: event.exitCode,
        durationMs: event.durationMs,
        outputPreview: event.outputPreview,
        denied: event.denied,
        background: event.background,
      });
    }
  };

  const VERIFY_FEEDBACK_DIGEST_THRESHOLD_CHARS = 6_000;
  const VERIFY_COMMAND_PREVIEW_CHARS = 4_000;

  type BuildVerifyResult = {
    feedback: string;
    failed: boolean;
  };

  const runVerify = async (command: string): Promise<BuildVerifyResult> => {
    if (!runner || !command) return { feedback: "", failed: false };
    emitBenchmarkEvent({
      type: "verifier_started",
      phase: "verifier",
      message: command,
      detailsJson: JSON.stringify({ command }),
    });
    const benchmarkCommand = validateBuildBenchmarkCommand(command, benchmark);
    if (!benchmarkCommand.allowed) {
      const message = benchmarkCommand.reason ?? "Verification command blocked by benchmark policy.";
      emitBuildCheckCommandRun({
        command,
        exitCode: -1,
        durationMs: 0,
        outputPreview: message,
        denied: true,
      });
      emitBenchmarkEvent({
        type: "verifier_completed",
        phase: "verifier",
        message,
        detailsJson: JSON.stringify({ command, passed: false }),
      });
      return {
        feedback: `AUTOMATED BUILD CHECK - \`${command}\` was rejected before execution. ${message}`,
        failed: true,
      };
    }
    const safety = classifyVerifyCommandForProject(
      command,
      [...diskTree, ...virtualFs.keys()],
      runnerPlatform
    );
    if (!safety.allowed) {
      const message = `Automated build check rejected: ${safety.reason} Verification commands must not edit files; use patch/append/edit output for file changes.`;
      emitBuildCheckCommandRun({
        command,
        exitCode: -1,
        durationMs: 0,
        outputPreview: message,
        denied: true,
      });
      emitBenchmarkEvent({
        type: "verifier_completed",
        phase: "verifier",
        message,
        detailsJson: JSON.stringify({ command, passed: false }),
      });
      return {
        feedback: `AUTOMATED BUILD CHECK - \`${command}\` was rejected before execution. ${message}`,
        failed: true,
      };
    }
    if (!benchmarkApprovalsBypassed()) {
      const decision = hooks?.requestCommandApproval
        ? await hooks.requestCommandApproval(command, "Automated build check")
        : "deny";
      if (decision === "allow-all") allowAllCommands = true;
      if (decision === "deny") {
        emitBuildCheckCommandRun({
          command,
          exitCode: -1,
          durationMs: 0,
          outputPreview: "Denied by the user",
          denied: true,
        });
        return { feedback: "", failed: false };
      }
    }
    emit({
      type: "diagnostic",
      phase: "model_streaming",
      message: `Build check: ${command}`,
    });
    try {
      const result = await runCommand(runner, command);
      const resultStdout = stripAnsi(result.stdout);
      const resultStderr = stripAnsi(result.stderr);
      emitBuildCheckCommandRun({
        command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        background: result.background,
        outputPreview: formatBuildCheckCommandPreview({
          stdout: resultStdout,
          stderr: resultStderr,
          truncated: !!result.truncated,
          maxChars: VERIFY_COMMAND_PREVIEW_CHARS,
        }),
      });
      let finalCommand = command;
      let finalResult = result;
      const combinedOutput = `${resultStdout}\n${resultStderr}`;
      const tscShimFailure =
        result.exitCode !== 0 &&
        detectedVerifyCommand &&
        detectedVerifyCommand !== command &&
        /^npx\s+tsc\b/i.test(command.trim()) &&
        /not the tsc command|Use npm install typescript|To get access to the TypeScript compiler/i.test(
          combinedOutput
        );
      if (tscShimFailure) {
        if (!benchmarkApprovalsBypassed()) {
          const decision = hooks?.requestCommandApproval
            ? await hooks.requestCommandApproval(
                detectedVerifyCommand,
                "Retry automated build check with the detected TypeScript command"
              )
            : "deny";
          if (decision === "allow-all") allowAllCommands = true;
          if (decision === "deny") {
            const feedback = formatBuildCheckContextText({
              command,
              exitCode: result.exitCode,
              output: combinedOutput.trim() || "(no output)",
              outputTruncated: !!result.truncated,
              note: "The declared TypeScript command hit the npx tsc shim, and the user denied the detected retry.",
            });
            return {
              feedback: storeLongToolResult(
                "command_output",
                `Automated build check: ${command}`,
                feedback,
                VERIFY_FEEDBACK_DIGEST_THRESHOLD_CHARS
              ),
              failed: true,
            };
          }
        }
        emit({
          type: "diagnostic",
          phase: "model_streaming",
          message: `Retrying build check with detected command: ${detectedVerifyCommand}`,
        });
        const retryBenchmarkCommand = validateBuildBenchmarkCommand(
          detectedVerifyCommand,
          benchmark
        );
        const retrySafety = classifyVerifyCommandForProject(
          detectedVerifyCommand,
          [...diskTree, ...virtualFs.keys()],
          runnerPlatform
        );
        if (!retrySafety.allowed) {
          const message = `Detected verifier retry rejected: ${retrySafety.reason}`;
          emitBuildCheckCommandRun({
            command: detectedVerifyCommand,
            exitCode: -1,
            durationMs: 0,
            outputPreview: message,
            denied: true,
          });
          emitBenchmarkEvent({
            type: "verifier_completed",
            phase: "verifier",
            message,
            detailsJson: JSON.stringify({
              command: detectedVerifyCommand,
              passed: false,
            }),
          });
          return {
            feedback: `AUTOMATED BUILD CHECK - \`${detectedVerifyCommand}\` was rejected before execution. ${message}`,
            failed: true,
          };
        }
        if (!retryBenchmarkCommand.allowed) {
          const message =
            retryBenchmarkCommand.reason ??
            "Detected verifier retry blocked by benchmark policy.";
          emitBuildCheckCommandRun({
            command: detectedVerifyCommand,
            exitCode: -1,
            durationMs: 0,
            outputPreview: message,
            denied: true,
          });
          emitBenchmarkEvent({
            type: "verifier_completed",
            phase: "verifier",
            message,
            detailsJson: JSON.stringify({
              command: detectedVerifyCommand,
              passed: false,
            }),
          });
          return {
            feedback: `AUTOMATED BUILD CHECK - \`${detectedVerifyCommand}\` was rejected before execution. ${message}`,
            failed: true,
          };
        }
        finalResult = await runCommand(runner, detectedVerifyCommand);
        finalCommand = detectedVerifyCommand;
        const retryStdout = stripAnsi(finalResult.stdout);
        const retryStderr = stripAnsi(finalResult.stderr);
        emitBuildCheckCommandRun({
          command: detectedVerifyCommand,
          exitCode: finalResult.exitCode,
          durationMs: finalResult.durationMs,
          background: finalResult.background,
          outputPreview: formatBuildCheckCommandPreview({
            stdout: retryStdout,
            stderr: retryStderr,
            truncated: !!finalResult.truncated,
            maxChars: VERIFY_COMMAND_PREVIEW_CHARS,
          }),
        });
      }
      const ok = finalResult.exitCode === 0;
      emitBenchmarkEvent({
        type: "verifier_completed",
        phase: "verifier",
        message: `${finalCommand} ${ok ? "passed" : "failed"}`,
        detailsJson: JSON.stringify({
          command: finalCommand,
          exitCode: finalResult.exitCode,
          passed: ok,
        }),
      });
      // Remember the latest resolved build-check outcome for the final summary's
      // Verification line (bounded; only the command + pass/fail verdict).
      repoVerification = `${finalCommand} ${ok ? "passed" : "failed"}`;
      const feedback = formatBuildCheckContextText({
        command: finalCommand,
        exitCode: finalResult.exitCode,
        output: formatBuildCheckOutputSections({
          stdout: stripAnsi(finalResult.stdout),
          stderr: stripAnsi(finalResult.stderr),
        }),
        outputTruncated: !!finalResult.truncated,
      });
      return {
        feedback: storeLongToolResult(
          "command_output",
          `Automated build check: ${finalCommand}`,
          feedback,
          VERIFY_FEEDBACK_DIGEST_THRESHOLD_CHARS
        ),
        failed: !ok,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "build check failed";
      emitBuildCheckCommandRun({
        command,
        exitCode: -1,
        durationMs: 0,
        outputPreview: err instanceof Error ? err.message : "build check failed",
      });
      emitBenchmarkEvent({
        type: "verifier_completed",
        phase: "verifier",
        message,
        detailsJson: JSON.stringify({ command, passed: false }),
      });
      return {
        feedback: `AUTOMATED BUILD CHECK — \`${command}\` could not run: ${err instanceof Error ? err.message : "error"}.`,
        failed: true,
      };
    }
  };

  const acceptVerifyCommandForRunner = (
    command: string,
    source: string,
    candidateFiles: string[] = []
  ): string => {
    const trimmed = command.trim();
    if (!trimmed) return "";
    const projectFiles = [...diskTree, ...virtualFs.keys(), ...candidateFiles];
    const safety = classifyVerifyCommandForProject(
      trimmed,
      projectFiles,
      runnerPlatform
    );
    if (safety.allowed) return trimmed;
    const message = `${source} ignored: ${safety.reason}`;
    emit({
      type: "diagnostic",
      phase: "round_preparing",
      message,
    });
    recordCommandProblem({
      command: trimmed,
      exitCode: -1,
      durationMs: 0,
      outputPreview: message,
      denied: true,
    });
    return "";
  };

  const treeText = (): string => {
    const all = new Set([...diskTree, ...virtualFs.keys()]);
    return [...all].sort().slice(0, 400).join("\n");
  };

  /** Case-insensitive substring search over virtual files + the runner. */
  const searchProject = async (query: string): Promise<string> => {
    const MAX_MATCHES = 80;
    const matches: string[] = [];
    const q = query.toLowerCase();
    for (const [path, content] of virtualFs) {
      if (matches.length >= MAX_MATCHES) break;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          matches.push(`${path}:${i + 1}: ${truncate(lines[i].trim(), 200)}`);
        }
      }
    }
    if (runner && matches.length < MAX_MATCHES) {
      const remote = await searchViaRunner(runner, query);
      for (const m of remote ?? []) {
        if (matches.length >= MAX_MATCHES) break;
        const entry = `${m.path}:${m.line}: ${truncate(m.text.trim(), 200)}`;
        if (!matches.includes(entry)) matches.push(entry);
      }
    }
    emit({
      type: "diagnostic",
      phase: "model_streaming",
      message: `Searched the project for "${truncate(query, 60)}" — ${matches.length} match(es)`,
    });
    return matches.length > 0 ? matches.join("\n") : "(no matches)";
  };

  const readFile = async (path: string): Promise<string | null> => {
    // Prefer the runner when connected: it reads the REAL file from disk, so the
    // content is fresh (e.g. after a command touched it), it shows up in the
    // runner console (`[read]`), and whole-file reads stay consistent with
    // read_range/search which already hit the runner first. Fall back to the
    // in-memory virtual FS (in-app-only builds, or a file the runner couldn't
    // serve — missing/binary/sync failure), then the picked folder.
    if (runner) {
      const remote = await readFileViaRunner(runner, path);
      if (remote != null) return remote;
    }
    if (virtualFs.has(path)) return virtualFs.get(path)!;
    if (dirHandle) {
      try {
        const content = await readProjectFile(dirHandle, path);
        if (content != null) return content;
      } catch {
        // fall through
      }
    }
    return null;
  };

  const currentProjectFiles = (): string[] =>
    [...new Set([...diskTree, ...virtualFs.keys()])].sort();

  codeIntelProvider = createCodeIntelProvider({
    mcp:
      runner && mcpServersForCodeIntel
          ? {
              servers: mcpServersForCodeIntel ?? [],
              projectHints: [
                buildMemoryRunnerProjectRoot,
                runnerDirName,
                buildMemoryRepoRemoteUrl,
              ].filter(
                (value): value is string =>
                  typeof value === "string" && value.trim().length > 0
              ),
              callTool: (server, tool, args) =>
                callMcpTool(runner!, server, tool, args),
            }
        : null,
    native: {
      listFiles: currentProjectFiles,
      readFile,
      searchText: searchProject,
    },
  });

  emitCodeIntelStatus(codeIntelProvider.status);
  if (codeIntelProvider.status.available) {
    emit({
      type: "diagnostic",
      phase: "initializing",
      message: codeIntelProvider.status.detail,
    });
  }

  const repoStatusForQualityGate = (
    status: RepoStatus | null
  ): BuildQualityGateRepoStatus | null =>
    status
      ? {
          isRepo: status.isRepo,
          currentBranch: status.currentBranch,
          upstream: status.upstream,
          ahead: status.ahead,
          behind: status.behind,
          staged: status.staged,
          unstaged: status.unstaged,
          untracked: status.untracked,
          conflicted: status.conflicted,
          clean: status.clean,
        }
      : null;

  const addUniqueCommand = (commands: string[], command: string): void => {
    const trimmed = command.trim();
    if (!trimmed) return;
    if (!commands.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
      commands.push(trimmed);
    }
  };

  const detectFinalVerificationCommands = async (): Promise<string[]> => {
    const commands: string[] = [];
    addUniqueCommand(commands, verifyCommand);

    const packageJsonText = await readFile("package.json");
    if (packageJsonText) {
      try {
        const pkg = JSON.parse(packageJsonText) as {
          scripts?: Record<string, unknown>;
        };
        const scripts = pkg.scripts ?? {};
        const hasTsconfig = (await readFile("tsconfig.json")) != null;
        if (hasTsconfig) {
          addUniqueCommand(commands, "npx --yes tsc --noEmit");
        }
        if (typeof scripts.lint === "string") {
          addUniqueCommand(commands, "npm run lint");
        }
        if (typeof scripts.build === "string") {
          addUniqueCommand(commands, "npm run build");
        }
        if (
          typeof scripts.test === "string" &&
          !/no test specified|exit 1/i.test(scripts.test)
        ) {
          addUniqueCommand(commands, "npm test");
        }
      } catch {
        // Malformed package.json is already caught by TypeScript/build checks.
      }
    }

    return commands;
  };

  const classifyFinalCheckResult = (
    command: string,
    result: BuildVerifyResult
  ): BuildQualityRequiredCheck => {
    const feedback = result.feedback;
    const failed = result.failed || !feedback.trim();
    return {
      name: command,
      command,
      status: failed ? "failed" : "passed",
      outputPreview: failed ? truncate(feedback, 1_500) : undefined,
    };
  };

  const runFinalVerificationChecks = async (): Promise<
    BuildQualityRequiredCheck[]
  > => {
    if (!runner) return [];
    const commands = await detectFinalVerificationCommands();
    const checks: BuildQualityRequiredCheck[] = [];
    for (const command of commands) {
      const result = await runVerify(command);
      checks.push(classifyFinalCheckResult(command, result));
    }
    return checks;
  };

  const emitFileToolDiagnostic = (
    message: string,
    model?: SelectedModel
  ): void => {
    emit({
      type: "diagnostic",
      phase: "model_streaming",
      modelId: model?.modelId,
      modelName: model?.displayName,
      providerId: model ? parseModelId(model.modelId).providerId : undefined,
      message,
    });
  };

  const recordFileChange = (
    taskId: string | undefined,
    path: string,
    operation: FileChangeOperation,
    before: string | null,
    after: string
  ): void => {
    if (!taskId) return;
    const current = waveChangeSummaries.get(taskId) ?? [];
    current.push(
      summarizeFileChange({
        path,
        operation,
        before,
        after,
      })
    );
    waveChangeSummaries.set(taskId, current);
  };

  const readFileRange = async (
    path: string,
    startLine: number,
    lineCount: number
  ): Promise<string> => {
    const start = Math.max(1, Math.round(startLine || 1));
    const count = Math.max(1, Math.min(400, Math.round(lineCount || 80)));
    if (runner) {
      const remote = await readFileRangeViaRunner(runner, path, start, count);
      if (remote) {
        if (remote.content == null) return `--- ${path} ---\n[not found or binary]`;
        const rangeNote = remote.truncated
          ? " (request capped to max range size)"
          : remote.hasMoreBefore || remote.hasMoreAfter
            ? " (partial range)"
            : "";
        return [
          `--- ${path} lines ${remote.startLine}-${remote.endLine} of ${remote.totalLines}${rangeNote} ---`,
          remote.content,
        ].join("\n");
      }
    }
    const content = await readFile(path);
    if (content == null) return `--- ${path} ---\n[not found or binary]`;
    const lines = content.split("\n");
    const startIdx = Math.min(start - 1, lines.length);
    const selected = lines.slice(startIdx, startIdx + count);
    const endLine = selected.length > 0 ? startIdx + selected.length : startIdx;
    const rangeNote = endLine < lines.length || startIdx > 0 ? " (partial range)" : "";
    return [
      `--- ${path} lines ${startIdx + 1}-${endLine} of ${lines.length}${rangeNote} ---`,
      selected.join("\n"),
    ].join("\n");
  };

  const writeFile = async (
    path: string,
    content: string,
    taskId?: string,
    operation: FileChangeOperation = "rewrite",
    beforeOverride?: string | null
  ): Promise<void> => {
    const before = beforeOverride !== undefined ? beforeOverride : await readFile(path);
    virtualFs.set(path, content);
    recordWrittenPath(path);
    // Persist so follow-up passes and resumes still see this file.
    upsertBuildFile({
      discussionId: discussion.id,
      path,
      content,
      updatedAt: new Date().toISOString(),
    });
    let bytes = new TextEncoder().encode(content).length;
    let location: "disk" | "virtual" = "virtual";

    // Prefer the runner: it writes to the REAL project folder over HTTP with no
    // File System Access permission flakiness. Fall back to the picked folder
    // (FSA), then to in-app only.
    if (runner) {
      try {
        bytes = await writeFileViaRunner(runner, path, content);
        location = "disk";
      } catch (err) {
        console.error(`[build] writing ${path} via the runner failed:`, err);
        emit({
          type: "diagnostic",
          phase: "model_failed",
          message: `Couldn't write ${path} via the runner (${err instanceof Error ? err.message : "error"}); kept in the app.`,
        });
      }
    } else if (diskGranted && dirHandle) {
      try {
        bytes = await writeProjectFile(dirHandle, path, content);
        location = "disk";
      } catch (err) {
        // Stop trying the folder after the first failure (avoids a warning per
        // file) and keep everything in-app for the rest of the build.
        console.error(`[build] writing ${path} to the project folder failed:`, err);
        diskGranted = false;
        emit({
          type: "diagnostic",
          phase: "model_failed",
          message: `Couldn't write to the project folder (${err instanceof Error ? `${err.name}: ${err.message}` : "error"}). Switching to in-app files — download them as a zip when done.`,
        });
      }
    }
    emit({ type: "file_written", path, bytes, location, taskId });
    recordFileChange(
      taskId,
      path,
      before == null && operation === "rewrite" ? "create" : operation,
      before,
      content
    );
  };

  // ── Streaming helpers (persist as messages so the timeline works) ─────────
  // Continue the round numbering from any previous pass (follow-up builds keep
  // the earlier transcript) so the timeline stays in chronological order.
  const persistedMessages = getMessagesForDiscussion(discussion.id);
  let round = persistedMessages.reduce(
    (max, m) => Math.max(max, m.round),
    0
  );
  const history: Array<{ label: string; text: string }> = [];

  // ── User notes: drained at every Architect decision point ─────────────────
  // Seeded with the notes from previous passes (they persist as user messages)
  // so a requirement satisfied in pass 2 can't silently fall out of pass 3.
  const userNotes: string[] = persistedMessages
    .filter((m) => m.role === "user")
    .map((m) => m.content);
  const userNotesText = (): string => {
    const fresh = drainBuildNotes(discussion.id).filter(
      (n) => !userNotes.includes(n)
    );
    if (fresh.length > 0) {
      userNotes.push(...fresh);
      persistBuildMemories(
        extractUserNoteMemories({
          projectKey: buildMemoryProjectKey,
          discussionId: discussion.id,
          notes: fresh,
        })
      );
      emit({
        type: "diagnostic",
        phase: "round_preparing",
        message: `Handing ${fresh.length} user note${fresh.length === 1 ? "" : "s"} to the Architect`,
      });
    }
    return userNotes.map((n, i) => `${i + 1}. ${n}`).join("\n");
  };

  // The previous pass's hand-off summary (if any) tells the Architect what
  // already exists and must be preserved when planning a follow-up.
  const previousBuildContext = persistedMessages
    .filter((m) => m.role === "assistant" && m.content.trim())
    .sort((a, b) => a.round - b.round)
    .slice(-18)
    .map(
      (m) =>
        `Round ${m.round} (${resolveModelName(m.modelId)}):\n${truncate(
          m.content,
          1_500
        )}`
    )
    .join("\n\n");
  const previousSummary =
    getFinalResult(discussion.id)?.answer ??
    (previousBuildContext
      ? `Previous incomplete build transcript excerpt. Use this to resume from the stopped/failed state instead of starting over:\n\n${previousBuildContext}`
      : "");

  const skillEvidenceRecords: SkillEvidence[] = [
    ...(existingCheckpoint?.skillEvidence ?? []),
  ];
  const skillEventRecords: BuildSkillEvent[] = [
    ...(existingCheckpoint?.skillEvents ?? []),
  ];
  let requestedArchitectSkillIds: string[] = [];
  let requestedNextWorkerSkillIds: string[] = [];
  let requestedReviewerSkillIds: string[] = [];
  const skillInput = (
    phase: SkillActivationInput["phase"],
    actor: SkillActivationInput["actor"],
    extra: Partial<SkillActivationInput> = {}
  ): SkillActivationInput => ({
    ...extra,
    phase,
    actor,
    userRequest: discussion.topic,
    skillMode: buildSettings.skillMode,
    runnerAvailable: !!runner,
    repoAvailable: !!runner && repoIsGit,
    mcpServers:
      mcpServersForCodeIntel.length > 0
        ? mcpServersForCodeIntel.map((server) => server.name)
        : mcpToolsDoc
          ? ["runner-mcp"]
          : [],
    riskFlags: [
      ...(githubWorkflow ? ["github-workflow"] : []),
      ...(runner ? ["runner"] : []),
      ...(extra.riskFlags ?? []),
    ],
  });
  const emitSkillActivation = (
    scope: string,
    phase: SkillActivationInput["phase"],
    actor: SkillActivationInput["actor"],
    activation: SkillActivation,
    evidence?: SkillEvidence[],
    warnings?: string[]
  ) => {
    const event: BuildSkillEvent = {
      scope,
      phase,
      actor,
      activeSkills: activeSkillIds(activation),
      evidence,
      warnings: [...activation.warnings, ...(warnings ?? [])],
    };
    skillEventRecords.push(event);
    if (skillEventRecords.length > 80) {
      skillEventRecords.splice(0, skillEventRecords.length - 80);
    }
    emit({ type: "skill_evidence", ...event });
  };
  const mergeSkillIds = (current: string[], incoming: string[]): string[] => [
    ...new Set([...current, ...incoming]),
  ];
  const executeSkillRequest = (action: SkillRequestAction): string => {
    const target = action.target ?? "architect";
    const phase =
      target === "next_worker" ? "worker" : target === "reviewer" ? "review" : "plan";
    const actor =
      target === "next_worker" ? "worker" : target === "reviewer" ? "reviewer" : "architect";
    const activation = selectSkills(
      skillInput(phase, actor, {
        requestedSkillIds: action.ids,
      })
    );
    const accepted = activation.overlays.filter((id) => action.ids.includes(id));
    if (target === "next_worker") {
      requestedNextWorkerSkillIds = mergeSkillIds(requestedNextWorkerSkillIds, accepted);
    } else if (target === "reviewer") {
      requestedReviewerSkillIds = mergeSkillIds(requestedReviewerSkillIds, accepted);
    } else {
      requestedArchitectSkillIds = mergeSkillIds(requestedArchitectSkillIds, accepted);
    }
    emitSkillActivation(
      `Skill request: ${target}`,
      phase,
      actor,
      activation,
      undefined,
      [
        `Requested by Architect: ${action.reason}`,
        action.mode === "full"
          ? "Full skill text is not loaded in this MVP; compact overlays were applied."
          : "",
      ].filter(Boolean)
    );
    const loaded = accepted.length > 0 ? accepted.join(", ") : "none";
    return [
      `Skill request processed for ${target}. Loaded: ${loaded}.`,
      activation.warnings.length > 0
        ? `Warnings:\n${activation.warnings.map((warning) => `- ${warning}`).join("\n")}`
        : "",
      renderSkillContext(activation),
    ]
      .filter(Boolean)
      .join("\n\n");
  };

  const ARCHITECT_SYSTEM_ROLE =
    "You are the Architect orchestrating an AI engineering team. Follow the response format exactly.";

  /**
   * One model call over a FULL conversation. The agentic tool loops append the
   * model's turn and the tool result as real messages, so the model always sees
   * exactly what it already read — instead of the old design that re-injected a
   * single giant string and front-truncated it (silently dropping the newest
   * reads, which is what made the Architect re-read the same lines forever).
   */
  const streamConversation = async (
    model: SelectedModel,
    messages: ChatMessage[],
    opts: {
      maxTokens: number;
      label: string;
      stopWhen?: (content: string) => boolean;
      structuredOutput?: StructuredOutputFormat;
      nativeTools?: NativeToolDefinition[];
      attachments?: AttachmentPayload[];
      validateStructuredOutput?: (content: string) => StructuredTraceValidation;
      /**
       * Invoked exactly once per successful call, right after usage resolves,
       * with the same estimated-or-reported token counts the USD window gets.
       * Used to attribute worker tokens to the scoreboard (workers only —
       * architect/reviewer/critique calls do not pass this).
       */
      onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
    }
  ): Promise<string> => {
    round += 1;
    const messageId = uuidv4();
    const { providerId, model: rawModel } = parseModelId(model.modelId);
    const nativeTools =
      opts.nativeTools?.length &&
      providerSupportsNativeBuildToolsFeature(providerId, rawModel)
        ? opts.nativeTools
        : undefined;
    const hostedBuildTools =
      !!runner &&
      allowAllCommands &&
      !benchmark &&
      providerSupportsHostedBuildToolsFeature(providerId, rawModel);
    const structuredOutput = nativeTools ? undefined : opts.structuredOutput;
    const traceStartedAt = new Date().toISOString();
    const traceStartMs = Date.now();
    const tracePrompt = messages
      .map((message) => `${message.role}:\n${message.content}`)
      .join("\n\n");
    const diagnostics: GameAIDiagnosticLike[] = [];
    emit({
      type: "message_start",
      messageId,
      modelId: model.modelId,
      modelName: model.displayName,
      round,
      role: "assistant",
    });
    emit({
      type: "diagnostic",
      phase: "model_streaming",
      round,
      modelId: model.modelId,
      modelName: model.displayName,
      providerId,
      message: opts.label,
    });
    emitBenchmarkEvent({
      type: "model_call_started",
      phase: "model_streaming",
      message: opts.label,
      modelId: model.modelId,
      providerId,
    });
    const preflightUsage = estimateModelCallUsage({
      messages,
      output: "",
      maxTokens: opts.maxTokens,
    });
    try {
      benchmark?.reserveModelCall?.({ inputTokens: preflightUsage.inputTokens });
    } catch (error) {
      emitBenchmarkEvent({
        type: "run_blocked",
        phase: "budget",
        message: error instanceof Error ? error.message : String(error),
        modelId: model.modelId,
        providerId,
      });
      throw error;
    }
    let content: string;
    let reportedUsage: StreamUsage | undefined;
    try {
      const resolved = await resolveBuildModelContent({
        model,
        messages,
        maxTokens: opts.maxTokens,
        label: opts.label,
        reasoningEffort,
        structuredOutput: opts.structuredOutput,
        attachments: opts.attachments,
        hooks,
        emitToken: (token) => emit({ type: "message_token", messageId, token }),
        collect: () =>
          collectStreamWithUsage(
            model.modelId,
            providerId,
            rawModel,
            messages,
            opts.maxTokens,
            0.4,
            reasoningEffort,
            opts.attachments ?? [],
            (token) => emit({ type: "message_token", messageId, token }),
            signal,
            opts.stopWhen,
            structuredOutput,
            (retry) =>
              diagnostics.push({
                attempt: retry.attempt,
                type: "request",
                message: `Transient provider error; retrying in ${retry.delayMs}ms: ${retry.message}`,
              }),
            modelContextProfile(model),
            !benchmark,
            nativeTools,
            hostedBuildTools
          ),
      });
      content = resolved.content;
      reportedUsage = resolved.reportedUsage;
      if (nativeTools) {
        diagnostics.push({
          attempt: 1,
          type: "request",
          message: "Provider-native Build tools were offered for this call.",
        });
      }
      if (hostedBuildTools) {
        diagnostics.push({
          attempt: 1,
          type: "request",
          message:
            "Provider-hosted Build tools were permitted because runner full-access is active.",
        });
      }
      if (resolved.overrideUsed) {
        diagnostics.push({
          attempt: 1,
          type: "request",
          message: "Model call served by benchmark override.",
        });
      }
      emitBenchmarkEvent({
        type: "model_call_completed",
        phase: "model_streaming",
        message: opts.label,
        modelId: model.modelId,
        providerId,
        detailsJson: JSON.stringify({ overrideUsed: resolved.overrideUsed }),
      });
    } catch (error) {
      emitBenchmarkEvent({
        type: "model_call_failed",
        phase: "model_streaming",
        message: error instanceof Error ? error.message : String(error),
        modelId: model.modelId,
        providerId,
      });
      await recordBenchmarkModelCallTrace(
        createGameModelCallTrace({
          modelId: model.modelId,
          providerId,
          ...buildBenchmarkTraceContext(benchmark),
          participantId: opts.label,
          reasoningEffort,
          schemaMode: opts.structuredOutput || nativeTools ? "structured" : "text",
          promptText: tracePrompt,
          startedAt: traceStartedAt,
          completedAt: new Date().toISOString(),
          latencyMs: Date.now() - traceStartMs,
          diagnostics: [
            ...diagnostics,
            {
              attempt: diagnostics.length + 1,
              type: "request",
              message: error instanceof Error ? error.message : String(error),
            },
          ],
          finalStatus: "provider_error",
          error: error instanceof Error ? error.message : String(error),
        })
      );
      throw error;
    }
    insertMessage({
      id: messageId,
      discussionId: discussion.id,
      round,
      modelId: model.modelId,
      role: "assistant",
      content,
      createdAt: new Date().toISOString(),
    });
    emit({ type: "message_complete", messageId, content });
    const usage = resolveModelCallUsage({
      messages,
      output: content,
      maxTokens: opts.maxTokens,
      reportedUsage,
    });
    // Attribute this call's tokens (workers fold them into the scoreboard for
    // the tokens-per-approved-task KPI). Same estimated-or-reported numbers the
    // USD window receives below; fired once per successful call.
    opts.onUsage?.({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    const pricing = getModelPricing(model.modelId, settings.modelPricingOverrides);
    const estimatedUsd = pricing
      ? estimatedUsdForTokens({
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          pricing,
        })
      : null;
    const validation = opts.validateStructuredOutput?.(content);
    const traceParsedJson =
      validation?.ok === true
        ? validation.parsedResponseJson ?? content
        : validation?.ok === false
          ? undefined
          : opts.structuredOutput
            ? content
            : undefined;
    const traceStatus = validation?.ok === false ? "parse_error" : "parsed";
    await recordBenchmarkModelCallTrace(
      createGameModelCallTrace({
        modelId: model.modelId,
        providerId,
        ...buildBenchmarkTraceContext(benchmark),
        participantId: opts.label,
        reasoningEffort,
        schemaMode: opts.structuredOutput || nativeTools ? "structured" : "text",
        promptText: tracePrompt,
        startedAt: traceStartedAt,
        completedAt: new Date().toISOString(),
        latencyMs: Date.now() - traceStartMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        usageSource: usage.usageSource,
        reasoningTokens: usage.reasoningTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteInputTokens: usage.cacheWriteInputTokens,
        inputAudioTokens: usage.inputAudioTokens,
        outputAudioTokens: usage.outputAudioTokens,
        providerCost: usage.providerCost,
        providerCostUnit: usage.providerCostUnit,
        estimatedUsd,
        rawResponse: content,
        parsedResponseJson: traceParsedJson,
        diagnostics,
        finalStatus: traceStatus,
        error: validation?.ok === false ? validation.message : undefined,
      })
    );
    emit({
      type: "token_usage",
      messageId,
      modelId: model.modelId,
      modelName: model.displayName,
      providerId,
      round,
      label: opts.label,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      maxTokens: usage.maxTokens,
      estimated: usage.estimated,
      usageSource: usage.usageSource,
      reasoningTokens: usage.reasoningTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      inputAudioTokens: usage.inputAudioTokens,
      outputAudioTokens: usage.outputAudioTokens,
      providerCost: usage.providerCost,
      providerCostUnit: usage.providerCostUnit,
    });
    // Fold the call into the active Build budget window (aggregate per-model
    // tokens + estimated USD). Unknown-priced models leave USD null and surface
    // as a partial-estimate warning in the Build stats UI. (pricing/estimatedUsd
    // are computed above so the model-call trace can also carry the cost.)
    try {
      benchmark?.recordModelCallUsage?.({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedUsd,
      });
    } catch (error) {
      emitBenchmarkEvent({
        type: "run_blocked",
        phase: "budget",
        message: error instanceof Error ? error.message : String(error),
        modelId: model.modelId,
        providerId,
      });
      throw error;
    }
    usageWindow = addBuildUsageCall(usageWindow, {
      modelId: model.modelId,
      modelName: model.displayName,
      providerId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      pricing,
      elapsedSinceWindowStartMs: Date.now() - buildWindowStartMs,
    });
    emitBuildUsage();
    history.push({ label: opts.label, text: content });
    return content;
  };

  /** Single-shot turn (system + one user prompt) — used for the final summary. */
  const streamTurn = (
    model: SelectedModel,
    prompt: string,
    opts: {
      systemRole: string;
      maxTokens: number;
      label: string;
      stopWhen?: (content: string) => boolean;
      structuredOutput?: StructuredOutputFormat;
      attachments?: AttachmentPayload[];
    }
  ): Promise<string> =>
    streamConversation(
      model,
      [
        { role: "system", content: opts.systemRole },
        { role: "user", content: prompt },
      ],
      {
        maxTokens: opts.maxTokens,
        label: opts.label,
        attachments: opts.attachments,
        stopWhen: opts.stopWhen,
        structuredOutput: opts.structuredOutput,
      }
    );

  const claimWaveWrite = (path: string, taskId?: string): string | null => {
    if (taskId == null) return null;
    const writer = taskId;
    const key = path.toLowerCase();
    const prior = waveWrites.get(key);
    if (prior && prior !== writer) {
      const issue = `CONFLICT: ${writer} attempted to write ${path}, which ${prior} already wrote in this wave — the write was rejected before it could overwrite the earlier version`;
      recordBuildProblem({
        code: "write_conflict",
        severity: "error",
        source: "file_writer",
        taskId,
        path,
        message: issue,
      });
      emit({ type: "diagnostic", phase: "model_failed", message: issue });
      return issue;
    }
    waveWrites.set(key, writer);
    return null;
  };

  const rejectWorkerWriteOutsideTaskScope = (
    task: BuildTask,
    path: string
  ): string | null => {
    if (isTaskWritePathAllowed(task, path)) return null;
    const allowed = outputPathsForTask(task);
    const fallback = allowed.length > 0 ? allowed : task.contextFiles;
    const issue = `WRITE REJECTED: ${task.id} attempted to write ${path}, but this task may only write ${fallback.length > 0 ? fallback.join(", ") : "its declared output files"}. Evidence and browser-acceptance notes belong in the worker response, not in ad hoc result files.`;
    recordBuildProblem({
      code: "write_scope_rejected",
      severity: "error",
      source: "file_writer",
      taskId: task.id,
      path,
      message: issue,
    });
    emit({ type: "diagnostic", phase: "model_failed", message: issue });
    return issue;
  };

  const applyPatchAction = async (
    path: string,
    ops: Array<{ search: string; replace: string }>,
    taskId?: string
  ): Promise<{ written: string[]; issues: string[]; summary: string }> => {
    const conflict = claimWaveWrite(path, taskId);
    if (conflict) {
      return { written: [], issues: [conflict], summary: conflict };
    }

    const before = await readFile(path);
    if (runner) {
      try {
        const result = await patchFileViaRunner(runner, path, ops);
        if (result.content != null && result.applied > 0) {
          virtualFs.set(path, result.content);
          recordWrittenPath(path);
          upsertBuildFile({
            discussionId: discussion.id,
            path,
            content: result.content,
            updatedAt: new Date().toISOString(),
          });
          if (!diskTree.includes(path)) diskTree.push(path);
          emit({ type: "file_written", path, bytes: result.bytes, location: "disk", taskId });
          recordFileChange(taskId, path, "patch", before, result.content);
        }
        const details =
          result.failedOps?.length
            ? ` Missing SEARCH block(s): ${result.failedOps
                .map((op) => `#${op.index} "${truncate(op.searchPreview, 120)}"`)
                .join("; ")}.`
            : "";
        const issues =
          result.failed > 0
            ? [
                `${result.failed} patch op(s) to ${path} did NOT match the current file content and were skipped (${result.applied} applied).${details}`,
              ]
            : [];
        for (const issue of issues) {
          recordBuildProblem({
            code: "patch_failed",
            severity: "error",
            source: "file_writer",
            taskId,
            path,
            message: issue,
          });
        }
        return {
          written: result.applied > 0 ? [path] : [],
          issues,
          summary: `Patch ${path}: ${result.applied} applied, ${result.failed} failed`,
        };
      } catch (err) {
        const issue = `Patch to ${path} via the runner failed (${err instanceof Error ? err.message : "error"}).`;
        recordBuildProblem({
          code: "patch_failed",
          severity: "error",
          source: "file_writer",
          taskId,
          path,
          message: issue,
        });
        emit({ type: "diagnostic", phase: "model_failed", message: issue });
        return { written: [], issues: [issue], summary: issue };
      }
    }

    const current = before;
    if (current == null) {
      const issue = `Patch to ${path} skipped — the file doesn't exist.`;
      emit({ type: "diagnostic", phase: "model_failed", message: issue });
      return { written: [], issues: [issue], summary: issue };
    }
    const { content, applied, failed, failedOps } = applyEditOps(current, ops);
    const details =
      failedOps.length > 0
        ? ` Missing SEARCH block(s): ${failedOps
            .map((op) => `#${op.index} "${truncate(op.searchPreview, 120)}"`)
            .join("; ")}.`
        : "";
    const issues =
      failed > 0
        ? [
            `${failed} patch op(s) to ${path} did NOT match the current file content and were skipped (${applied} applied).${details}`,
          ]
        : [];
    for (const issue of issues) {
      recordBuildProblem({
        code: "patch_failed",
        severity: "error",
        source: "file_writer",
        taskId,
        path,
        message: issue,
      });
    }
    if (applied > 0) {
      await writeFile(path, content, taskId, "patch", current);
    }
    return {
      written: applied > 0 ? [path] : [],
      issues,
      summary: `Patch ${path}: ${applied} applied, ${failed} failed`,
    };
  };

  const applyAppendAction = async (
    path: string,
    content: string,
    reset: boolean,
    taskId?: string
  ): Promise<{ written: string[]; issues: string[]; summary: string }> => {
    const conflict = claimWaveWrite(path, taskId);
    if (conflict) {
      return { written: [], issues: [conflict], summary: conflict };
    }

    const before = await readFile(path);
    if (runner) {
      try {
        const result = await appendFileViaRunner(runner, path, content, reset);
        if (result.content != null) {
          virtualFs.set(path, result.content);
          recordWrittenPath(path);
          upsertBuildFile({
            discussionId: discussion.id,
            path,
            content: result.content,
            updatedAt: new Date().toISOString(),
          });
          if (!diskTree.includes(path)) diskTree.push(path);
          emit({ type: "file_written", path, bytes: result.totalBytes, location: "disk", taskId });
          recordFileChange(
            taskId,
            path,
            before == null ? "create" : reset ? "rewrite" : "append",
            before,
            result.content
          );
        }
        return {
          written: [path],
          issues: [],
          summary: `Append ${path}: +${result.bytes} bytes${reset ? " (reset first)" : ""}`,
        };
      } catch (err) {
        const issue = `Append to ${path} via the runner failed (${err instanceof Error ? err.message : "error"}).`;
        recordBuildProblem({
          code: "patch_failed",
          severity: "error",
          source: "file_writer",
          taskId,
          path,
          message: issue,
        });
        emit({ type: "diagnostic", phase: "model_failed", message: issue });
        return { written: [], issues: [issue], summary: issue };
      }
    }

    const current = reset ? "" : before ?? "";
    await writeFile(
      path,
      `${current}${content}`,
      taskId,
      before == null ? "create" : reset ? "rewrite" : "append",
      before
    );
    return {
      written: [path],
      issues: [],
      summary: `Append ${path}: +${new TextEncoder().encode(content).length} bytes${reset ? " (reset first)" : ""}`,
    };
  };

  /**
   * Write any ```lang path=...``` files and apply any ```edit path=...```
   * SEARCH/REPLACE blocks contained in a model's output.
   *
   * Returns the paths actually written plus `issues`: writes/edits that were
   * REJECTED or SKIPPED (truncated output, suspicious shrink rewrites, edits
   * that didn't match). Callers must surface issues to the Architect's review
   * — a skipped write the Architect never hears about gets approved blind.
   */
  const writeEmittedFiles = async (
    text: string,
    taskId?: string
  ): Promise<{ written: string[]; issues: string[] }> => {
    const { files, edits, truncatedPaths } = extractArtifacts(text);
    const written: string[] = [];
    const issues: string[] = [];
    const writer = taskId ?? "Architect";
    const taskForScope = taskId ? tasks.find((task) => task.id === taskId) : undefined;
    const rejectOutOfScope = (path: string): string | null =>
      taskForScope ? rejectWorkerWriteOutsideTaskScope(taskForScope, path) : null;

    // Record a landed write and flag it LOUDLY when a different writer already
    // touched the same path this wave (a same-writer re-emit or fix is fine).
    // Architect writes are exempt: its review fixes run AFTER the wave's
    // workers settle and overwrite their files deliberately — not a race.
    // Paths arrive already normalized by extractArtifacts (forward slash); key
    // on the lowercased form so case-only differences still collide.
    const noteWrite = (path: string): void => {
      if (taskId == null) return;
      const key = path.toLowerCase();
      const prior = waveWrites.get(key);
      if (prior && prior !== writer) {
        const issue = `CONFLICT: ${writer} overwrote ${path}, which ${prior} also wrote in this wave — the earlier version is lost`;
        issues.push(issue);
        recordBuildProblem({
          code: "write_conflict",
          severity: "error",
          source: "file_writer",
          taskId,
          path,
          message: issue,
        });
        emit({ type: "diagnostic", phase: "model_failed", message: issue });
      }
      waveWrites.set(key, writer);
    };

    for (const path of truncatedPaths) {
      const issue = `Output was cut off mid-block for ${path} — nothing from the truncated block was written. This file is too large for a single response; use read_range/search plus patch for existing files, or append chunks for large/missing files.`;
      issues.push(issue);
      recordBuildProblem({
        code: "truncated_output",
        severity: "error",
        source: "file_writer",
        taskId,
        path,
        message: issue,
      });
      emit({ type: "diagnostic", phase: "model_failed", message: `Truncated output block for ${path} rejected${taskId ? ` (${taskId})` : ""}` });
    }

    for (const file of files) {
      const scopeIssue = rejectOutOfScope(file.path);
      if (scopeIssue) {
        issues.push(scopeIssue);
        continue;
      }
      // A full-file rewrite that shrinks an existing file drastically is far
      // more often a truncated/lazy rewrite ("// rest unchanged") than a real
      // refactor — refuse it and tell the model to use edit blocks instead.
      const existing = await readFile(file.path);
      if (
        existing != null &&
        existing.length > 2_000 &&
        file.content.length < existing.length * 0.5
      ) {
        const issue = `Rewrite of ${file.path} skipped as suspicious: the existing file is ${existing.length} chars but the replacement is only ${file.content.length}. Use SEARCH/REPLACE edit blocks for changes, or re-emit the COMPLETE file if a smaller rewrite is genuinely intended.`;
        issues.push(issue);
        recordBuildProblem({
          code: "suspicious_rewrite",
          severity: "error",
          source: "file_writer",
          taskId,
          path: file.path,
          message: issue,
        });
        emit({
          type: "diagnostic",
          phase: "model_failed",
          message: `Skipped suspicious rewrite of ${file.path} (${existing.length} → ${file.content.length} chars)${taskId ? ` (${taskId})` : ""}`,
        });
        continue;
      }
      const conflict = claimWaveWrite(file.path, taskId);
      if (conflict) {
        issues.push(conflict);
        continue;
      }
      await writeFile(
        file.path,
        file.content,
        taskId,
        existing == null ? "create" : "rewrite",
        existing
      );
      noteWrite(file.path);
      written.push(file.path);
    }

    for (const edit of edits) {
      const scopeIssue = rejectOutOfScope(edit.path);
      if (scopeIssue) {
        issues.push(scopeIssue);
        continue;
      }
      const current = await readFile(edit.path);
      if (current == null) {
        issues.push(`Edit to ${edit.path} skipped — the file doesn't exist.`);
        emit({
          type: "diagnostic",
          phase: "model_failed",
          message: `Edit to ${edit.path} skipped — the file doesn't exist`,
        });
        continue;
      }
      const { content, applied, failed, failedOps } = applyEditOps(
        current,
        edit.ops
      );
      if (applied > 0) {
        const conflict = claimWaveWrite(edit.path, taskId);
        if (conflict) {
          issues.push(conflict);
        } else {
          await writeFile(edit.path, content, taskId, "patch", current);
          noteWrite(edit.path);
          written.push(edit.path);
        }
      }
      if (failed > 0) {
        const details =
          failedOps.length > 0
            ? ` Missing SEARCH block(s): ${failedOps
                .map((op) => `#${op.index} "${truncate(op.searchPreview, 120)}"`)
                .join("; ")}.`
            : "";
        issues.push(
          `${failed} edit(s) to ${edit.path} did NOT match the current file content and were skipped (${applied} applied).${details} The intended change is missing — re-issue it with SEARCH text copied verbatim from the current file.`
        );
        emit({
          type: "diagnostic",
          phase: "model_failed",
          message: `${failed} edit(s) to ${edit.path} didn't match the current content and were skipped`,
        });
      }
    }
    return { written, issues };
  };

  // ── Architect agentic inspection loop (shared by plan + review) ────────────
  // Maintains a real conversation: the Architect's tool call and the tool result
  // become successive messages, so it never loses what it read. Overlap-aware
  // dedup stops it re-reading the same lines, and when the inspection budget /
  // dedup / turn cap is hit we FORCE a final verdict instead of throwing the
  // whole build away.
  const kbOf = (text: string): string =>
    `${(new TextEncoder().encode(text).length / 1024).toFixed(1)} KB`;

  const TOOL_RESULT_DIGEST_THRESHOLD_CHARS = 10_000;

  const formatStoredMessages = (messages: ChatMessage[]): string =>
    messages
      .map((message, index) =>
        [`## ${index + 1}. ${message.role}`, message.content].join("\n")
      )
      .join("\n\n");

  const storeContextBlob = (
    kind: ContextBlobKind,
    label: string,
    text: string,
    metadata?: Record<string, string | number | boolean | null>
  ) => {
    const blob = createContextBlob({
      discussionId: discussion.id,
      kind,
      label,
      text,
      metadata,
    });
    upsertContextBlob(blob);
    emit({
      type: "context_blob",
      action: "created",
      ref: blob.id,
      label: blob.label,
      kind: blob.kind,
      source: typeof metadata?.source === "string" ? metadata.source : undefined,
      charCount: blob.charCount,
      tokenEstimate: blob.tokenEstimate,
    } satisfies ContextBlobEvent);
    return blob;
  };

  const digestForContextBlob = (blob: ReturnType<typeof storeContextBlob>): string => {
    switch (blob.kind) {
      case "command_output":
        return buildCommandOutputDigest(blob);
      case "fetch":
        return buildFetchDigest(blob);
      case "repo_diff":
        return buildRepoDiffDigest(blob);
      case "tool_exchange":
        return buildToolExchangeDigest(blob);
      default:
        return blob.digest;
    }
  };

  const storeLongToolResult = (
    kind: ContextBlobKind,
    label: string,
    text: string,
    threshold = TOOL_RESULT_DIGEST_THRESHOLD_CHARS
  ): string => {
    if (text.length <= threshold) return text;
    const blob = storeContextBlob(kind, label, text);
    return formatContextBlobForPrompt(blob, { thresholdChars: threshold });
  };

  const runCodeIntelQuery = async (
    action: CodeIntelAction,
    actor: SelectedModel = architect
  ) => {
    if (!codeIntelProvider?.status.available) {
      return {
        ok: false,
        content: "Code intelligence is unavailable; use read/search instead.",
        title: "Code intelligence unavailable",
        mode: "native" as const,
        op: action.op,
        status: codeIntelProvider?.status ?? {
          mode: "native" as const,
          available: false,
          detail: "Code intelligence unavailable.",
          tools: [],
          capabilities: [],
        },
      };
    }
    if (!codeIntelBudget.recordCall()) {
      throw new Error("No code_intel calls left in this phase.");
    }
    const result = await codeIntelProvider.query({
      ...action,
      repoFiles: currentProjectFiles(),
      maxChars: 10_000,
    });
    if (result.fallbackFrom) {
      emitCodeIntelStatus(result.status, {
        status: "fallback",
        detail: `${result.title}: ${result.error ?? "native fallback used"}`,
      });
    } else if (!result.ok) {
      emitCodeIntelStatus(result.status, {
        status: "error",
        detail: result.error ?? result.content,
      });
    }
    emitFileToolDiagnostic(
      `${actor.displayName} code_intel ${action.op} via ${result.mode}${result.toolName ? `:${result.toolName}` : ""} - ${kbOf(result.content)}`,
      actor
    );
    return result;
  };

  const autoCodeIntelPack = async (
    action: CodeIntelAction,
    options: { id: string; title: string; priority: number }
  ): Promise<ContextPack[]> => {
    if (!codeIntelProvider?.status.available || codeIntelCallsLeftThisPhase() <= 0) {
      return [];
    }
    try {
      const result = await runCodeIntelQuery(action);
      const pack = codeIntelResultToContextPack(result, options);
      if (pack) {
        emitCodeIntelStatus(result.status, {
          status: "auto_included",
          detail: `${pack.title} included via ${result.mode}${result.fallbackFrom ? " fallback" : ""}.`,
          architectureDigestIncluded: action.op === "architecture",
          changeImpactDigestIncluded: action.op === "detect_change_impact",
        });
      }
      return pack ? [pack] : [];
    } catch (err) {
      emit({
        type: "diagnostic",
        phase: "model_failed",
        message: `Code intelligence ${action.op} failed: ${err instanceof Error ? err.message : "unknown error"}`,
      });
      return [];
    }
  };

  const planCodeIntelPacks = async (): Promise<ContextPack[]> => {
    const files = currentProjectFiles();
    if (
      !codeIntelProvider ||
      !shouldAutoIncludeCodeIntelArchitecture(files, codeIntelProvider.status)
    ) {
      return [];
    }
    return autoCodeIntelPack(
      {
        action: "code_intel",
        op: "architecture",
        limit: 8,
        reason: "auto-include large-repo architecture digest for planning",
      },
      {
        id: "plan-code-intel-architecture",
        title: "Code intelligence architecture digest",
        priority: 75,
      }
    );
  };

  const reviewCodeIntelPacks = async (
    paths: string[],
    cycle: number
  ): Promise<ContextPack[]> => {
    const uniquePaths = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
    if (uniquePaths.length === 0) return [];
    return autoCodeIntelPack(
      {
        action: "code_intel",
        op: "detect_change_impact",
        paths: uniquePaths,
        limit: 8,
        reason: "auto-include changed-file impact digest for review",
      },
      {
        id: `review-code-intel-impact-wave-${cycle}`,
        title: "Code intelligence change-impact digest",
        priority: 145,
      }
    );
  };

  const buildCompactionPlaceholder =
    (label: string) =>
    ({ omitted }: { omitted: ChatMessage[] }): ChatMessage => {
      const blob = storeContextBlob(
        "tool_exchange",
        label,
        formatStoredMessages(omitted),
        { omittedMessages: omitted.length }
      );
      return {
        role: "user",
        content: digestForContextBlob(blob),
      };
    };

  const executeContextRetrieve = (
    action: ContextRetrieveAction,
    actorLabel: string,
    actor: SelectedModel
  ): string => {
    const blob = getContextBlob(action.ref);
    if (!blob || blob.discussionId !== discussion.id) {
      return `Context ref ${action.ref} was not found for this discussion. Use only refs shown in recent digests.`;
    }
    const retrieved = retrieveContextBlobText(blob, {
      maxTokens: action.maxTokens,
      offsetChars: action.offsetChars,
    });
    emit({
      type: "context_blob",
      action: "retrieved",
      ref: retrieved.ref,
      label: retrieved.label,
      kind: retrieved.kind,
      charCount: retrieved.totalChars,
      tokenEstimate: retrieved.totalTokens,
      offsetChars: retrieved.offsetChars,
      returnedChars: retrieved.returnedChars,
      returnedTokens: retrieved.returnedTokens,
      truncated: retrieved.truncated,
    } satisfies ContextBlobEvent);
    emit({
      type: "diagnostic",
      phase: "model_streaming",
      modelId: actor.modelId,
      modelName: actor.displayName,
      providerId: parseModelId(actor.modelId).providerId,
      message: `${actorLabel} retrieved context ${action.ref} at offset ${retrieved.offsetChars} (${kbOf(retrieved.text)})`,
    });
    const nextOffset = retrieved.offsetChars + retrieved.returnedChars;
    return [
      `CONTEXT RETRIEVE ${action.ref}`,
      `Label: ${retrieved.label}`,
      `Kind: ${retrieved.kind}`,
      `Offset: ${retrieved.offsetChars} chars`,
      `Returned: ${retrieved.returnedChars}/${retrieved.totalChars} chars, approx ${retrieved.returnedTokens}/${retrieved.totalTokens} tokens${retrieved.truncated ? " (truncated)" : ""}`,
      retrieved.omittedBeforeChars > 0
        ? `Omitted before: ${retrieved.omittedBeforeChars} chars`
        : "",
      retrieved.omittedAfterChars > 0
        ? `Omitted after: ${retrieved.omittedAfterChars} chars. To continue, request offsetChars ${nextOffset}.`
        : "",
      "Exact text:",
      retrieved.text || "(empty)",
      retrieved.truncated
        ? "[truncated: request the same ref with a larger maxTokens value if more exact text is necessary]"
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  };

  /** Parse the "--- path lines X-Y of Z ---" header readFileRange emits. */
  const parseDeliveredRange = (
    text: string
  ): { startLine: number; endLine: number } | undefined => {
    const m = /lines (\d+)-(\d+) of \d+/.exec(text);
    if (!m) return undefined;
    return { startLine: Number(m[1]), endLine: Number(m[2]) };
  };

  interface InspectionBudgets {
    reads: number;
    rangeReads: number;
    searches: number;
  }

  interface ArchitectDispatch {
    result: string;
    exhausted: boolean;
    deliveredRange?: { startLine: number; endLine: number };
    toolStatus?: ToolCallResultStatus;
  }

  /** Run one Architect tool action against the budgets; returns the result text. */
  const dispatchArchitectTool = async (
    action: ArchitectAction,
    budgets: InspectionBudgets,
    appendContext: (text: string) => void
  ): Promise<ArchitectDispatch> => {
    const benchmarkBlock = shouldBlockBuildBenchmarkAction(action.action, benchmark);
    if (benchmarkBlock.blocked) {
      const message = benchmarkBlock.reason ?? "Action blocked by benchmark policy.";
      emitBenchmarkEvent({
        type: "tool_call_blocked",
        phase: "model_streaming",
        message,
        detailsJson: JSON.stringify({ action: action.action }),
      });
      return { result: message, exhausted: false, toolStatus: "denied" };
    }
    if (action.action === "search") {
      if (budgets.searches <= 0)
        return {
          result:
            "No project searches left in this phase. Use a remaining tool, or produce your decision JSON now.",
          exhausted: true,
        };
      budgets.searches -= 1;
      const out = await searchProject(action.query);
      appendContext(`\nSearch results for "${action.query}":\n${out}`);
      emitFileToolDiagnostic(
        `${formatBuildFileToolDiagnostic({ actor: "Architect", action: "search", query: action.query })} · ${kbOf(out)} · ${budgets.searches} search(es) left`,
        architect
      );
      return { result: `Search results for "${action.query}":\n${out}`, exhausted: false };
    }
    if (action.action === "read") {
      if (budgets.reads <= 0)
        return {
          result:
            "No whole-file reads left in this phase. Use read_range for specific lines, or produce your decision JSON now.",
          exhausted: true,
        };
      budgets.reads -= 1;
      const paths = action.paths.slice(0, 8);
      const chunks: string[] = [];
      for (const path of paths) {
        const content = await readFile(path);
        chunks.push(`\n--- ${path} ---\n${content ?? "[not found or binary]"}`);
      }
      const joined = chunks.join("\n");
      appendContext(`\nRequested file contents:${joined}`);
      emitFileToolDiagnostic(
        `${formatBuildFileToolDiagnostic({ actor: "Architect", action: "read", paths })} · ${kbOf(joined)} · ${budgets.reads} read(s) left`,
        architect
      );
      return { result: `Requested file contents:${joined}`, exhausted: false };
    }
    if (action.action === "read_range") {
      if (budgets.rangeReads <= 0)
        return {
          result:
            "No range reads left in this phase. Produce your decision JSON now using what you already have.",
          exhausted: true,
        };
      budgets.rangeReads -= 1;
      const out = await readFileRange(action.path, action.startLine, action.lineCount);
      appendContext(`\nRequested file range:\n${out}`);
      const delivered = parseDeliveredRange(out);
      emitFileToolDiagnostic(
        `${formatBuildFileToolDiagnostic({ actor: "Architect", action: "read_range", path: action.path, startLine: action.startLine, lineCount: action.lineCount })} · ${kbOf(out)} · ${budgets.rangeReads} range read(s) left`,
        architect
      );
      return { result: out, exhausted: false, deliveredRange: delivered };
    }
    if (action.action === "context_retrieve") {
      return {
        result: executeContextRetrieve(action, "Architect", architect),
        exhausted: false,
      };
    }
    if (action.action === "code_intel") {
      if (!codeIntelProvider?.status.available) {
        return {
          result: "Code intelligence is unavailable. Use read/search tools instead.",
          exhausted: true,
        };
      }
      if (codeIntelCallsLeftThisPhase() <= 0) {
        return {
          result:
            "No code_intel calls left in this phase. Use read/search, or produce your decision JSON now.",
          exhausted: true,
        };
      }
      const result = await runCodeIntelQuery(action);
      return {
        result: storeLongToolResult("text", result.title, result.content),
        exhausted: false,
      };
    }
    if (action.action === "run") {
      // NRW-006: refuse raw commit commands before the budget check so the model
      // always gets the same redirect to repo_commit regardless of budget state.
      // executeRun enforces the same guard for any other entry point.
      if (repoIsGit && isRawCommitCommand(action.command)) {
        const result = await executeRun(action.command, action.reason);
        return {
          result: storeLongToolResult(
            "command_output",
            `Command: ${action.command}`,
            result
          ),
          exhausted: false,
        };
      }
      if (!canExecuteRunAction(action.command))
        return {
          result:
            "No command runs left in this phase. Produce your decision JSON now.",
          exhausted: true,
        };
      const result = await executeRun(action.command, action.reason);
      return {
        result: storeLongToolResult(
          "command_output",
          `Command: ${action.command}`,
          result
        ),
        exhausted: false,
      };
    }
    if (action.action === "tool") {
      if (mcpCallsLeftThisPhase() <= 0)
        return {
          result: "No MCP tool calls left in this phase. Produce your decision JSON now.",
          exhausted: true,
        };
      const toolResult = await executeTool(action);
      return {
        result: storeLongToolResult(
          "tool_exchange",
          `MCP ${action.server}.${action.tool}`,
          toolResult.text
        ),
        exhausted: false,
        toolStatus: toolResult.status,
      };
    }
    if (action.action === "fetch") {
      if (fetchesLeftThisPhase() <= 0)
        return {
          result: "No web fetches left in this phase. Produce your decision JSON now.",
          exhausted: true,
        };
      const result = await executeFetch(action);
      return {
        result: storeLongToolResult("fetch", `Fetch ${action.url}`, result),
        exhausted: false,
      };
    }
    if (action.action === "skill_request") {
      return { result: executeSkillRequest(action), exhausted: false };
    }
    if (action.action === "repo_status") {
      return { result: await executeRepoStatus(), exhausted: false };
    }
    if (action.action === "repo_diff") {
      return { result: await executeRepoDiff(action), exhausted: false };
    }
    if (action.action === "repo_init") {
      return { result: await executeRepoInit(action), exhausted: false };
    }
    if (action.action === "repo_branch_create") {
      return { result: await executeRepoBranchCreate(action), exhausted: false };
    }
    if (action.action === "repo_commit") {
      return { result: await executeRepoCommit(action), exhausted: false };
    }
    if (action.action === "repo_issue_list") {
      return { result: await executeRepoIssueList(action), exhausted: false };
    }
    if (action.action === "repo_milestone_create") {
      return { result: await executeRepoMilestoneCreate(action), exhausted: false };
    }
    if (action.action === "repo_issue_create") {
      return { result: await executeRepoIssueCreate(action), exhausted: false };
    }
    if (action.action === "repo_issue_read") {
      return { result: await executeRepoIssueRead(action), exhausted: false };
    }
    if (action.action === "repo_push") {
      return { result: await executeRepoPush(action), exhausted: false };
    }
    if (action.action === "repo_pr_create") {
      return { result: await executeRepoPrCreate(action), exhausted: false };
    }
    return {
      result: `Action "${action.action}" is not available here. Produce your decision JSON now.`,
      exhausted: true,
    };
  };

  const emitArchitectLoopDiag = (
    phase: "round_preparing" | "judging" | "model_failed" | "model_streaming",
    message: string,
    details?: string
  ): void => {
    if (phase === "model_failed") {
      recordBuildProblem({
        code: /tool-call rejected|TOOL CALL REJECTED|parseable/i.test(message)
          ? "malformed_tool_call"
          : /served nothing|duplicate/i.test(message)
            ? "empty_tool_batch"
            : "tool_warning",
        severity: "error",
        source: "architect",
        modelId: architect.modelId,
        modelName: architect.displayName,
        providerId: parseModelId(architect.modelId).providerId,
        message,
        details,
      });
    }
    emit({
      type: "diagnostic",
      phase,
      modelId: architect.modelId,
      modelName: architect.displayName,
      providerId: parseModelId(architect.modelId).providerId,
      message,
    });
  };

  // Dispatch a batch of Architect tool actions in one turn: the scheduler runs
  // safe reads/searches together, queues mutations in order, and keeps risky
  // commands single-step; duplicates are skipped (not re-dispatched); each served
  // action goes through the existing single-action dispatcher; and ONE combined
  // served/skipped tool-result message is returned for the conversation.
  const dispatchArchitectToolBatch = async (
    actions: ArchitectAction[],
    budgets: InspectionBudgets,
    appendContext: (text: string) => void,
    tracker: ReturnType<typeof createToolCallTracker>
  ): Promise<{
    result: string;
    exhausted: boolean;
    servedCount: number;
    skippedCount: number;
  }> => {
    const schedule = scheduleBuildToolActions(actions, {
      allowSafeRunQueue: benchmarkApprovalsBypassed(),
      maxSafeRuns: SAFE_RUN_QUEUE_LIMIT,
    });
    const served: Array<{
      label: string;
      result: string;
      preserveFullResult?: boolean;
    }> = [];
    const skipped = schedule.skipped.map((item) => ({
      label: item.label,
      reason: item.reason,
    }));
    let exhausted = false;
    for (const item of schedule.served) {
      if (isRedundantToolCall(tracker, item.action)) {
        skipped.push({
          label: item.label,
          reason: "duplicate tool request (already delivered)",
        });
        continue;
      }
      const dispatched = await dispatchArchitectTool(
        item.action,
        budgets,
        appendContext
      );
      served.push({
        label: item.label,
        result: dispatched.result,
        preserveFullResult: item.action.action === "context_retrieve",
      });
      // Match the single-action loop: only record (for dedup) a tool that
      // actually delivered — a budget-exhausted result is not "already read".
      if (dispatched.exhausted) exhausted = true;
      else if (
        shouldRecordToolCallResult(item.action, dispatched.toolStatus ?? "ok")
      ) {
        recordToolCall(tracker, item.action, dispatched.deliveredRange);
      }
    }
    emit({
      type: "tool_batch",
      actor: "Architect",
      served: served.length,
      skipped: skipped.length,
      summary: `${served.length} served, ${skipped.length} skipped`,
    });
    return {
      result: packToolBatchResult({
        served,
        skipped,
        maxChars: TOOL_BATCH_RESULT_CHARS,
      }),
      exhausted,
      servedCount: served.length,
      skippedCount: skipped.length,
    };
  };

  const architectActionResponseFormat = buildArchitectActionResponseFormat();

  const runArchitectInspectionLoop = async (args: {
    terminal: "plan" | "review";
    expectedAction?: ArchitectTerminalAction;
    label: string;
    initialUser: string;
    initialAttachments?: AttachmentPayload[];
    budgets: InspectionBudgets;
    actor?: SelectedModel;
    actorLabel?: string;
    /** Accumulate delivered read/search results for cross-phase memory. */
    appendContext: (text: string) => void;
  }): Promise<{ action: ArchitectAction; text: string; forced: boolean }> => {
    const { terminal } = args;
    const expectedAction = args.expectedAction ?? terminal;
    const actor = args.actor ?? architect;
    const actorLabel = args.actorLabel ?? "Architect";
    let messages: ChatMessage[] = [
      { role: "system", content: ARCHITECT_SYSTEM_ROLE },
      { role: "user", content: args.initialUser },
    ];
    const tracker = createToolCallTracker();
    const budgets = { ...args.budgets };
    const forcedInstruction =
      terminal === "review"
        ? FORCED_REVIEW_INSTRUCTION
        : expectedAction === "spec"
          ? 'STOP USING TOOLS. You have used your inspection budget for specification. Any further read/search/command requests will be IGNORED.\nUsing only what you already have, produce your spec now as exactly ONE fenced ```json block with action "spec".'
          : expectedAction === "build_plan"
            ? 'STOP USING TOOLS. You have used your inspection budget for build planning. Any further read/search/command requests will be IGNORED.\nUsing only what you already have and the Architect spec, produce your build plan now as exactly ONE fenced ```json block with action "build_plan".'
            : FORCED_PLAN_INSTRUCTION;
    const decisionPhase = terminal === "review" ? "judging" : "round_preparing";
    const HARD_TURN_CAP = 40;
    const DUP_LIMIT = 3;
    const BAD_LIMIT = 3;
    const EXHAUSTED_LIMIT = 2;
    let duplicates = 0;
    let badTurns = 0;
    let exhaustedStreak = 0;
    let forced = false;
    let forcedAttempts = 0;

    const forceNow = (why: string): void => {
      if (forced) return;
      forced = true;
      emitArchitectLoopDiag(
        decisionPhase,
        `${actorLabel} ${terminal} inspection ended (${why}) — forcing a final ${terminal} verdict with the current context`
      );
      messages.push({ role: "user", content: forcedInstruction });
    };

    const defaultReview = (text: string): { action: ArchitectAction; text: string; forced: boolean } => ({
      action: { action: "review", results: [], newTasks: [], done: false, notes: "" } as ReviewAction,
      text,
      forced: true,
    });

    for (let turn = 0; turn < HARD_TURN_CAP; turn++) {
      throwIfAborted();
      const compacted = compactToolConversation(
        messages,
        120_000,
        8,
        buildCompactionPlaceholder(
          `${actorLabel} ${terminal} omitted tool exchange`
        )
      );
      if (compacted.compacted > 0) {
        messages = compacted.messages;
        emitArchitectLoopDiag(
          "model_streaming",
          `Compacted the ${actorLabel}'s ${terminal} context — folded ${compacted.compacted} older tool exchange(s) to stay within budget`
        );
      }
      const text = await streamConversation(actor, messages, {
        maxTokens: architectMaxTokens(actor),
        label: forced ? `${args.label} (final verdict)` : args.label,
        attachments: turn === 0 ? args.initialAttachments : undefined,
        stopWhen: forced ? undefined : hasCompleteBuildToolAction,
        structuredOutput: architectActionResponseFormat,
        nativeTools: buildNativeBuildToolDefinitions(
          terminal === "review" ? "architect_review" : "architect_plan"
        ),
        validateStructuredOutput: (content) => {
          const parsed = parseArchitectAction(content);
          return parsed
            ? { ok: true, parsedResponseJson: JSON.stringify(parsed) }
            : {
                ok: false,
                message: "Architect action response could not be parsed as JSON.",
              };
        },
      });
      messages.push({ role: "assistant", content: text });

      const parsed = parseArchitectAction(text);
      if (isArchitectTerminalActionForExpected(parsed, expectedAction)) {
        return { action: parsed, text, forced };
      }
      if (forced) {
        // The forced turn still didn't produce the verdict.
        if (terminal === "review") {
          emitArchitectLoopDiag(
            "judging",
            "Architect did not return a review verdict even after being forced - sending this wave's landed work back for explicit two-gate review"
          );
          return defaultReview(text);
        }
        // For planning we make one more forced attempt below (bad-turn path).
      }

      const strict = inspectStrictToolActionBatchOutput(text);
      if (strict.actions.length === 0) {
        // No parseable tool action this turn (malformed JSON, or prose with no
        // action). Treat as a bad inspection turn and nudge — same recovery the
        // single-action loop used, now phrased for one-or-more actions.
        badTurns += 1;
        await writeEmittedFiles(text); // never lose files emitted in a bad turn
        if (forced && terminal === "plan") {
          throw new Error(
            `The Architect did not produce a parseable ${expectedAction} after being forced to.`
          );
        }
        const fb = strict.feedback ?? STRICT_RETRY_INSTRUCTION;
        emitArchitectLoopDiag(
          "model_failed",
          `Architect ${terminal} tool-call rejected: ${fb}`
        );
        messages.push({
          role: "user",
          content: `${fb}\nReply with one or more valid JSON tool actions, or produce your ${expectedAction} JSON now.`,
        });
        if (badTurns >= BAD_LIMIT) forceNow("too many malformed responses");
        continue;
      }

      if (forced) {
        // Tools are ignored once forced. Nudge once more, then give up rather
        // than burn turns (review already returned a default above; this only
        // guards planning, which has no safe default).
        forcedAttempts += 1;
        if (forcedAttempts >= 2) {
          throw new Error(
            "The Architect kept requesting tools after being told to stop; could not obtain a plan verdict."
          );
        }
        messages.push({ role: "user", content: forcedInstruction });
        continue;
      }

      const warning = strict.feedback ? `${strict.feedback}\n\n` : "";
      const batch = await dispatchArchitectToolBatch(
        strict.actions,
        budgets,
        args.appendContext,
        tracker
      );
      if (batch.servedCount > 0 && batch.skippedCount > 0) {
        recordBuildProblem({
          code: "tool_warning",
          severity: "warning",
          source: "architect",
          modelId: architect.modelId,
          modelName: architect.displayName,
          providerId: parseModelId(architect.modelId).providerId,
          message: `Architect ${terminal} batch skipped ${batch.skippedCount} action(s)`,
          details: batch.result,
        });
      }
      if (batch.servedCount === 0) {
        // Every requested action was a duplicate or unsafe/skipped — nothing
        // ran. Count it like a repeated lookup so a stuck loop still forces.
        duplicates += 1;
        emitArchitectLoopDiag(
          "model_failed",
          `Architect ${terminal} batch served nothing (all duplicate or skipped)`,
          batch.result
        );
        messages.push({
          role: "user",
          content: `${warning}${batch.result}\n\n${DUPLICATE_TOOL_CALL_FEEDBACK}`,
        });
        if (duplicates >= DUP_LIMIT) forceNow("repeated the same lookups");
        continue;
      }
      badTurns = 0;
      const budgetNote = `\n\n(Inspection budget left — whole-file reads: ${budgets.reads}, range reads: ${budgets.rangeReads}, searches: ${budgets.searches}. Produce your ${expectedAction} JSON as soon as you have what you need.)`;
      messages.push({
        role: "user",
        content: `${warning}${batch.result}${budgetNote}`,
      });
      if (batch.exhausted) {
        exhaustedStreak += 1;
        if (exhaustedStreak >= EXHAUSTED_LIMIT) forceNow("inspection budget exhausted");
      } else {
        exhaustedStreak = 0;
      }
    }

    // Hard turn cap — never let a stuck loop kill a working build.
    if (terminal === "review") {
      emitArchitectLoopDiag(
        "judging",
        "Architect review hit the turn cap - sending this wave's landed work back for explicit two-gate review"
      );
      return defaultReview("");
    }
    throw new Error(
      "The Architect did not produce a parseable plan after exhausting its planning turns."
    );
  };

  let activeSpec: BuildSpec | undefined;
  let activePhaseSpec: BuildPhaseSpec | undefined;

  const toTask = (
    raw: BuildPlanningAction["tasks"][number],
    index: number
  ): BuildTask => ({
    id: raw.id?.trim() || `T${index + 1}`,
    title: raw.title || `Task ${index + 1}`,
    instructions: raw.instructions || raw.title || "",
    phaseSpec: activePhaseSpec,
    implementationContract:
      typeof raw.implementationContract === "string" && raw.implementationContract.trim()
        ? raw.implementationContract.trim()
        : undefined,
    contextFiles: (raw.contextFiles ?? []).slice(0, MAX_CONTEXT_FILES),
    outputPaths: outputPathsForTask(raw),
    expectedOutputs: raw.expectedOutputs,
    status: "planned",
    dependsOn: Array.isArray(raw.dependsOn)
      ? raw.dependsOn.filter((d): d is string => typeof d === "string")
      : [],
    assignTo: typeof raw.assignTo === "string" ? raw.assignTo : undefined,
    difficulty:
      typeof raw.difficulty === "number"
        ? Math.max(1, Math.min(5, Math.round(raw.difficulty)))
        : undefined,
  });

  // ── Status bookkeeping ─────────────────────────────────────────────────────
  // Build mode runs open-ended toward completion (bounded by BUILD_MAX_WAVES as a
  // safety backstop, plus guardrails and no-progress detection), so there is no
  // fixed phase count to fill a progress bar — report maxRounds 0 (indeterminate).
  const totalPhases = 0;
  updateDiscussion(discussion.id, {
    status: "running",
    maxRounds: totalPhases,
    updatedAt: new Date().toISOString(),
  });
  emit({ type: "status", status: "running", round: 0, maxRounds: totalPhases });

  // ── 1) Plan (the Architect inspects files in a real conversation, then plans) ─
  let architectNotes = "";
  const promotedGuidanceNotes: string[] = [];
  let extraFileContext = "";
  let tasks: BuildTask[] = [];
  let planVerifyCommand = ""; // build/check command the Architect declared

  const nextGuidanceId = (task: BuildTask): string =>
    `G-${task.id}-${(task.guidance?.length ?? 0) + 1}`;

  const addGuidanceRequest = (
    task: BuildTask,
    action: GuidanceRequestAction,
    worker: SelectedModel,
    wave: number
  ): BuildTaskGuidance => {
    const record: BuildTaskGuidance = {
      id: nextGuidanceId(task),
      taskId: task.id,
      mode: action.mode,
      question: action.question,
      ...(action.reason ? { reason: action.reason } : {}),
      status: "pending",
      requestedBy: worker.displayName,
      requestedAtWave: wave,
    };
    task.guidance = [...(task.guidance ?? []), record];
    return record;
  };

  const answerGuidanceRequest = async (
    task: BuildTask,
    record: BuildTaskGuidance,
    wave: number
  ): Promise<void> => {
    const text = await streamConversation(
      architect,
      [
        { role: "system", content: ARCHITECT_SYSTEM_ROLE },
        {
          role: "user",
          content: buildArchitectGuidancePrompt({
            request: discussion.topic,
            treeText: treeText(),
            task,
            architectNotes,
            guidance: record,
          }),
        },
      ],
      {
        maxTokens: architectMaxTokens(architect),
        label: `Architect answering guidance ${record.id} for ${task.id}`,
        structuredOutput: architectActionResponseFormat,
        validateStructuredOutput: (content) => {
          const parsed = parseArchitectAction(content);
          return parsed?.action === "guidance_answer"
            ? { ok: true, parsedResponseJson: JSON.stringify(parsed) }
            : {
                ok: false,
                message:
                  "Architect guidance response must be a guidance_answer action.",
              };
        },
      }
    );
    const parsed = parseArchitectAction(text);
    if (!parsed || parsed.action !== "guidance_answer") {
      throw new Error(
        `Architect did not answer guidance ${record.id} for ${task.id}.`
      );
    }
    const answer: GuidanceAnswerAction = parsed;
    if (answer.guidanceId !== record.id || answer.taskId !== task.id) {
      throw new Error(
        `Architect guidance answer mismatch: expected ${record.id}/${task.id}, got ${answer.guidanceId}/${answer.taskId}.`
      );
    }
    record.status = "answered";
    record.answer = answer.answer;
    record.answeredAtWave = wave;
    const promotedMemory = answer.memory?.trim();
    if (promotedMemory) {
      const note = `Guidance ${record.id} for ${task.id}: ${truncate(promotedMemory, 700)}`;
      promotedGuidanceNotes.push(note);
      architectNotes = [architectNotes, note].filter(Boolean).join("\n");
      persistBuildMemories(
        extractGuidanceMemories({
          projectKey: buildMemoryProjectKey,
          discussionId: discussion.id,
          guidanceId: record.id,
          taskId: task.id,
          question: record.question,
          answer: answer.answer,
          memory: promotedMemory,
          paths: [
            ...(task.contextFiles ?? []),
            ...(task.outputPaths?.length ? task.outputPaths : outputPathsForTask(task)),
          ],
        })
      );
    }
    emit({
      type: "diagnostic",
      phase: "round_preparing",
      message: promotedMemory
        ? `Architect answered guidance ${record.id} for ${task.id} and promoted it to build memory`
        : `Architect answered guidance ${record.id} for ${task.id}`,
    });
  };

  const answerPendingGuidanceForTask = async (
    task: BuildTask,
    wave: number
  ): Promise<void> => {
    for (const record of task.guidance ?? []) {
      if (record.status === "pending") {
        await answerGuidanceRequest(task, record, wave);
      }
    }
  };

  const synthesizePhaseSpec = (objective?: string): BuildPhaseSpec => ({
    id: "P0",
    objective:
      objective?.trim() ||
      `Satisfy the current Build request: ${discussion.topic}`,
    acceptanceCriteria: [
      "The completed work satisfies the user request and any queued user notes for this phase.",
      "Each task's expected outputs are present in the files it owns.",
    ],
    qualityCriteria: [
      "Changes are scoped to the assigned files and preserve existing architecture.",
      "Relevant verification is run or the unverified gap is reported explicitly.",
    ],
    verification: planVerifyCommand ? [planVerifyCommand] : [],
  });

  // Give the Architect the obvious entry points of an existing project up front
  // so it usually doesn't need to spend a read hop on them.
  for (const manifest of MANIFEST_CANDIDATES) {
    if (!diskTree.includes(manifest)) continue;
    const content = await readFile(manifest);
    if (content != null) {
      extraFileContext += `\n--- ${manifest} ---\n${truncate(content, PER_FILE_REVIEW_CHARS)}`;
    }
  }
  if (extraFileContext) {
    extraFileContext = `\nKey project files:${extraFileContext}`;
  }

  // ── Resume from a saved checkpoint, if one survived a prior stop ───────────
  // Resume keeps the task graph, Architect notes, verify command, and repo refs,
  // but starts a fresh budget window (usageWindow was created empty above and is
  // deliberately NOT restored from the checkpoint's historical usage).
  let resumedFromCheckpoint = false;
  let wavesRun = 0;
  if (
    existingCheckpoint &&
    existingCheckpoint.status !== "completed" &&
    existingCheckpoint.tasks.length > 0
  ) {
    // Failed checkpoint tasks must be reopened on Resume; otherwise dependents
    // stay blocked and the build can burn waves without dispatching any work.
    const normalizedResumeTasks = normalizeBuildTasksForResume(existingCheckpoint.tasks.map((task) => ({
      ...task,
      // "in_progress"/"review" are transient mid-wave states. If the run stopped
      // while a task was being implemented or awaiting review, re-queue it as
      // "planned" so the resumed run re-dispatches and re-reviews it — otherwise
      // it is never picked up again (dispatch only takes planned/fixing) and the
      // build would end with a spurious "incomplete tasks" failure.
      status:
        task.status === "in_progress" || task.status === "review"
          ? "planned"
          : task.status,
    })));
    tasks = reopenBuildTasksForBlockedQualityGateCheckpoint(normalizedResumeTasks, {
      status: existingCheckpoint.status,
      stopReason: existingCheckpoint.stopReason,
      recoveryLog: existingCheckpoint.recoveryLog,
      stopMessage: existingCheckpoint.stopReport?.stopMessage,
      problems: [
        ...(existingCheckpoint.buildProblems ?? []),
        ...(existingCheckpoint.stopReport?.problems ?? []),
      ],
      skillEvidence: existingCheckpoint.skillEvidence,
      maxContextFiles: MAX_CONTEXT_FILES,
    });
    architectNotes = existingCheckpoint.architectNotes;
    planVerifyCommand = acceptVerifyCommandForRunner(
      existingCheckpoint.verifyCommand,
      "Checkpoint verifyCommand",
      tasks.flatMap((task) => task.outputPaths ?? [])
    );
    activePhaseSpec =
      existingCheckpoint.phaseSpec ??
      tasks.find((task) => task.phaseSpec)?.phaseSpec ??
      synthesizePhaseSpec(existingCheckpoint.architectNotes);
    repoActiveBranch = existingCheckpoint.branch;
    repoPrUrl = existingCheckpoint.prUrl;
    repoMilestoneTitle = existingCheckpoint.milestone;
    resumedFromCheckpoint = true;
    wavesRun = existingCheckpoint.wave;
    emit({
      type: "diagnostic",
      phase: "initializing",
      message: `Resuming Build checkpoint from wave ${existingCheckpoint.wave} with ${tasks.length} task(s).`,
    });
    emit({
      type: "build_plan",
      cycle: existingCheckpoint.wave,
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
      })),
    });
    for (const task of tasks) {
      emit({
        type: "task_status",
        taskId: task.id,
        title: task.title,
        status: task.status,
        worker:
          task.workerIndex == null
            ? undefined
            : workers[task.workerIndex]?.displayName,
        cycle: existingCheckpoint.wave,
      });
    }
  }

  // Guardrail check before the (potentially expensive) planning call.
  if (stopForGuardrail(null)) return;

  if (!resumedFromCheckpoint) {
    const planSkills = selectSkills(
      skillInput("plan", "architect", {
        requestedSkillIds: requestedArchitectSkillIds,
      })
    );
    emitSkillActivation(
      "Architect planning",
      "plan",
      "architect",
      planSkills,
      undefined,
      planSkills.evidenceRequired
    );
    const planSkillContext = renderSkillContext(planSkills);
    const specAttachments = claimRawBuildAttachmentsForArchitect();
    codeIntelBudget.resetPhase();
    const planningCodeIntelPacks = await planCodeIntelPacks();
    const planAssembledContext = buildContextManager.buildPlanContext({
      modelContextProfile: modelContextProfile(architect),
      request: discussion.topic,
      treeText: treeText(),
      fileContext: joinBuildContextSections(buildAttachmentManifest, extraFileContext),
      previousSummary: truncate(previousSummary, 6_000),
      userNotes: userNotesText(),
      memoryRecords: activeBuildMemories(),
      scoreboard: scoreboard.some((s) => s.attempts > 0) ? scoreboardText() : "",
      contextPacks: planningCodeIntelPacks,
    });
    emitBuildMemoryEvent();
    emitContextAssembled(planAssembledContext, {
      phase: "plan",
      label: "Architect planning",
      model: architect,
    });
    const specResult = await runArchitectInspectionLoop({
      terminal: "plan",
      expectedAction: "spec",
      label: "Architect is writing the build spec",
      initialUser: buildArchitectSpecPrompt({
        request: discussion.topic,
        treeText: treeText(),
        fileContext: "",
        workerNames: workers.map((w) => w.displayName),
        readHopsLeft: 2,
        runsLeft: runsLeftThisPhase(),
        githubWorkflow: githubWorkflow && !!runner,
        repoWorkflow: !!runner,
        githubCli: githubCli ?? undefined,
        githubLabels: repoLabels,
        searchesLeft: SEARCHES_PER_PHASE,
        codeIntelStatus: codeIntelStatusForPrompt(),
        codeIntelCallsLeft: codeIntelCallsLeftThisPhase(),
        mcpToolsDoc,
        mcpCallsLeft: mcpCallsLeftThisPhase(),
        userNotes: "",
        memoryBrief: "",
        scoreboard: "",
        previousSummary: "",
        fetchesLeft: fetchesLeftThisPhase(),
        shellHint,
        skillContext: planSkillContext,
        assembledContext: planAssembledContext,
      }),
      initialAttachments: specAttachments,
      // read_range isn't offered during planning, so reads + searches only.
      budgets: { reads: 2, rangeReads: 0, searches: SEARCHES_PER_PHASE },
      appendContext: (text) => {
        extraFileContext += text;
      },
    });
    const specAction = specResult.action as SpecAction;
    activeSpec = specAction.spec;
    const specVerifyCommand = specAction.verifyCommand ?? "";

    const planResult = await runArchitectInspectionLoop({
      terminal: "plan",
      expectedAction: "build_plan",
      label: "Architect is planning the implementation from the spec",
      initialUser: buildArchitectPlanPrompt({
        request: discussion.topic,
        treeText: treeText(),
        fileContext: "",
        maxTasks: BUILD_TASKS_PER_WAVE,
        workerNames: workers.map((w) => w.displayName),
        spec: activeSpec,
        readHopsLeft: 1,
        runsLeft: runsLeftThisPhase(),
        githubWorkflow: githubWorkflow && !!runner,
        repoWorkflow: !!runner,
        githubCli: githubCli ?? undefined,
        githubLabels: repoLabels,
        searchesLeft: SEARCHES_PER_PHASE,
        codeIntelStatus: codeIntelStatusForPrompt(),
        codeIntelCallsLeft: codeIntelCallsLeftThisPhase(),
        mcpToolsDoc,
        mcpCallsLeft: mcpCallsLeftThisPhase(),
        userNotes: "",
        memoryBrief: "",
        scoreboard: "",
        previousSummary: "",
        fetchesLeft: fetchesLeftThisPhase(),
        shellHint,
        skillContext: planSkillContext,
        assembledContext: planAssembledContext,
      }),
      budgets: { reads: 1, rangeReads: 0, searches: SEARCHES_PER_PHASE },
      appendContext: (text) => {
        extraFileContext += text;
      },
    });
    const planAction = planResult.action as BuildPlanningAction;

    // ── Plan critique gate ─────────────────────────────────────────────────
    // Before wave 1, a second model attacks the plan. Wrong decomposition is
    // the most expensive Build failure mode; one critique call + at most one
    // bounded revision catches it while it is still cheap. Skipped under the
    // benchmark harness and when no distinct-model critic is available (a model
    // critiquing its own plan is noise). Runs BEFORE any planAction consumption
    // so a revision fully replaces the plan the wave scheduler will build.
    const pickPlanCritic = (): SelectedModel | null => {
      if (reviewer && reviewer.modelId !== architect.modelId) return reviewer;
      for (const ranked of rankedActiveWorkers()) {
        const candidate = workers[ranked.index];
        if (candidate && candidate.modelId !== architect.modelId) return candidate;
      }
      return null;
    };
    const planCritic = pickPlanCritic();
    if (planCritic && !benchmark) {
      emit({
        type: "diagnostic",
        phase: "round_preparing",
        message: `${planCritic.displayName} is critiquing the plan before work starts`,
      });
      try {
        const tasksJson = JSON.stringify(planAction.tasks, null, 1);
        const critiqueText = await streamConversation(
          planCritic,
          [
            {
              role: "system",
              content:
                "You are a principal engineer reviewing a build plan before execution. Respond with a short rationale and the requested JSON verdict.",
            },
            {
              role: "user",
              content: buildPlanCritiquePrompt({
                request: discussion.topic,
                treeText: treeText(),
                spec: activeSpec,
                phaseSpec: planAction.phaseSpec,
                tasksJson,
                notes: planAction.notes,
                verifyCommand: planAction.verifyCommand,
                workerNames: workers.map((w) => w.displayName),
              }),
            },
          ],
          {
            maxTokens: architectMaxTokens(planCritic),
            label: `${planCritic.displayName} critiquing the plan`,
          }
        );
        const critique = parsePlanCritique(critiqueText);
        if (critique && planCritiqueHasBlockingIssues(critique)) {
          const blocking = critique.issues.filter((i) => i.severity === "blocking");
          const critiqueDigest = buildPlanCritiqueDigest(critique, 2000);
          emit({
            type: "diagnostic",
            phase: "round_preparing",
            message: `Plan critique found ${blocking.length} blocking issue(s) and ${critique.missingWork.length} missing-work item(s) — asking the Architect for one revision`,
          });
          const revisionText = await streamConversation(
            architect,
            [
              { role: "system", content: ARCHITECT_SYSTEM_ROLE },
              {
                role: "user",
                content: buildPlanRevisionPrompt({
                  request: discussion.topic,
                  treeText: treeText(),
                  spec: activeSpec,
                  originalPlanJson: tasksJson,
                  critiqueDigest,
                  maxTasks: BUILD_TASKS_PER_WAVE,
                }),
              },
            ],
            {
              maxTokens: architectMaxTokens(architect),
              label: "Architect revising plan after critique",
              structuredOutput: architectActionResponseFormat,
            }
          );
          const revised = parseArchitectAction(revisionText);
          if (
            revised &&
            (revised.action === "plan" || revised.action === "build_plan") &&
            Array.isArray(revised.tasks) &&
            revised.tasks.length > 0
          ) {
            // tasks come WHOLLY from the revision; the other fields fall back to
            // the original when the revision omitted them.
            planAction.tasks = revised.tasks;
            if (revised.notes?.trim()) planAction.notes = revised.notes;
            if (revised.phaseSpec) planAction.phaseSpec = revised.phaseSpec;
            if (
              typeof revised.verifyCommand === "string" &&
              revised.verifyCommand.trim()
            ) {
              planAction.verifyCommand = revised.verifyCommand;
            }
            emit({
              type: "diagnostic",
              phase: "round_preparing",
              message: `Plan revised after critique (${blocking.length} blocking issue(s) addressed)`,
            });
          } else {
            recordBuildProblem({
              code: "plan_critique_unresolved",
              severity: "warning",
              source: "architect",
              message:
                "The Architect did not produce a parseable revised plan after a blocking critique; continuing with the original plan.",
              details: critiqueDigest,
            });
          }
        } else if (critique && critique.issues.length > 0) {
          // Minor-only critique: fold the notes into planAction.notes so they
          // flow into architectNotes below and the review phase remembers them.
          planAction.notes = [
            planAction.notes,
            truncate(
              `Plan critique (minor): ${critique.issues.map((i) => i.issue).join("; ")}`,
              500
            ),
          ]
            .filter(Boolean)
            .join("\n");
        }
      } catch (err) {
        if (isAbortError(err)) throw err;
        emit({
          type: "diagnostic",
          phase: "round_preparing",
          message: `Plan critique skipped: ${
            err instanceof Error ? err.message : "error"
          }`,
        });
      }
    }

    if (planAction.action === "build_plan" && planAction.spec) {
      activeSpec = planAction.spec;
    }
    architectNotes = [
      specAction.notes,
      planAction.action === "build_plan" && planAction.implementationPlan
        ? `Implementation plan: ${truncate(planAction.implementationPlan, 1_000)}`
        : "",
      planAction.notes,
    ]
      .filter(Boolean)
      .join("\n");
    const plannedOutputPaths = planAction.tasks.flatMap((task) =>
      outputPathsForTask(task)
    );
    planVerifyCommand =
      typeof (planAction.verifyCommand || specVerifyCommand) === "string"
        ? acceptVerifyCommandForRunner(
            planAction.verifyCommand || specVerifyCommand,
            "Architect verifyCommand",
            plannedOutputPaths
          )
        : "";
    activePhaseSpec =
      planAction.phaseSpec ?? activeSpec ?? synthesizePhaseSpec(architectNotes);
    tasks = planAction.tasks.slice(0, BUILD_TASKS_PER_WAVE).map(toTask);
    // The Architect may scaffold files alongside the plan JSON.
    const { issues } = await writeEmittedFiles(planResult.text);
    if (issues.length > 0) {
      extraFileContext += `\nYOUR SCAFFOLD WRITES THAT DID NOT LAND:\n${issues.map((s) => `- ${s}`).join("\n")}`;
    }

    if (tasks.length === 0) {
      throw new Error("The Architect produced an empty plan.");
    }

    emit({
      type: "build_plan",
      cycle: 0,
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
    });
    for (const task of tasks) {
      emit({ type: "task_status", taskId: task.id, title: task.title, status: "planned" });
    }
  }

  // Plan-only policy: produce the plan (and any GitHub planning the Architect did)
  // without implementing code, then finish cleanly.
  if (buildSettings.runPolicy === "plan_only") {
    const planOnlyVerifyCommand = runner
      ? planVerifyCommand ||
        acceptVerifyCommandForRunner(
          detectVerifyCommand([...diskTree, ...virtualFs.keys()]),
          "Detected verifyCommand"
        )
      : "";
    const summary = [
      "Plan-only Build run completed.",
      "",
      "Planned tasks:",
      ...tasks.map((task) => `- ${task.id}: ${task.title}`),
    ].join("\n");
    insertFinalResult({
      discussionId: discussion.id,
      answer: summary,
      confidence: 1,
      dissent: JSON.stringify([]),
      createdAt: new Date().toISOString(),
    });
    const toolReviewReport = createToolReviewReport({
      status: "completed",
      wave: wavesRun,
    });
    saveCheckpoint({
      status: "completed",
      stopReason: "completed",
      wave: wavesRun,
      tasks,
      architectNotes,
      verifyCommand: planOnlyVerifyCommand,
      toolReviewReport,
    });
    emit({
      type: "final_answer",
      answer: summary,
      confidence: 1,
      dissent: [],
      toolReviewReport,
    });
    markStopped(
      "completed",
      "Plan-only Build run completed.",
      undefined,
      toolReviewReport
    );
    return;
  }

  // ── 2..n) Implement waves + Architect reviews ──────────────────────────────
  // (Worker-call count is no longer tracked — it never stops the run, and the
  // run is governed by completion, guardrails, and no-progress detection.)
  // Persists across batches and waves so small (even size-1) batches still
  // spread work over all active workers instead of piling onto the top rank.
  let assignCursor = 0;
  const workerAssignmentCounts = new Map<number, number>(
    workers.map((_, index) => [index, 0])
  );
  // Mechanical build/check backstop: a project-appropriate command run after
  // each wave (when a runner is connected) so broken code is caught by the
  // compiler in ANY language, not only by model review. The
  // Architect's declared command wins; otherwise we detect from the manifests.
  const detectedVerifyCommand = runner
    ? acceptVerifyCommandForRunner(
        detectVerifyCommand([...diskTree, ...virtualFs.keys()]),
        "Detected verifyCommand"
      )
    : "";
  let verifyCommand = runner ? (planVerifyCommand || detectedVerifyCommand) : "";
  if (verifyCommand) {
    emit({
      type: "diagnostic",
      phase: "round_preparing",
      message: `Build check each wave: \`${verifyCommand}\``,
    });
  }

  // ── Branch safety gate (NRW-005) ───────────────────────────────────────────
  // Before any worker writes files, make sure repo workflow won't accidentally
  // land commit-capable changes on the default / main / master branch. We
  // re-read status (it may have changed during planning), classify it, and —
  // when a feature branch is required — establish one through the same typed
  // repo path executeRepoBranchCreate uses. Denial or failure in ordinary Ask
  // mode simply disables commit/PR workflow for this run; ordinary file writes
  // continue.
  if (runner && repoIsGit) {
    const status = await getRepoStatusViaRunner(runner).catch(() => null);
    if (status) {
      repoIsGit = status.isRepo;
      emit({ type: "repo_status", status: toRepoStatusEvent(status) });
    }
    if (repoInitializedByBuild && status?.isRepo) {
      repoCommitWorkflowEnabled = true;
      repoActiveBranch = status.currentBranch ?? repoActiveBranch;
      emit({
        type: "diagnostic",
        phase: "round_preparing",
        message: `Commit workflow enabled on newly initialized repository${repoActiveBranch ? ` branch "${repoActiveBranch}"` : ""}.`,
      });
    } else {
      const decision = status
      ? classifyRepoBranchSafety({
          isRepo: status.isRepo,
          currentBranch: status.currentBranch,
          defaultBranch: status.defaultBranch,
          clean: status.clean,
          conflicted: status.conflicted,
        })
      : { safe: false, needsBranch: false, reason: "repo status unavailable" };

    if (!decision.safe && !decision.needsBranch) {
      // Unsafe for a reason a branch can't fix (e.g. unresolved conflicts):
      // keep commit/PR workflow OFF and tell the user. File writes continue.
      repoCommitWorkflowEnabled = false;
      emit({
        type: "diagnostic",
        phase: "round_preparing",
        message: `Commit & PR workflow disabled — ${decision.reason}. Worker file writes will still proceed.`,
      });
    } else if (decision.needsBranch) {
      // On default / main / master (or detached): establish a safe feature
      // branch via the typed runner path before any worker writes.
      const name = branchNameForTopic(discussion.topic, repoIssueNumber);
      const label = `git branch: ${name}`;
      let proceed = true;
      if (shouldRequestRepoMutationApproval()) {
        const approval = hooks?.requestCommandApproval
          ? await hooks.requestCommandApproval(
              label,
              `Repo workflow on ${decision.reason}; a feature branch is required before commit/PR work.`
            )
          : "deny";
        if (approval === "allow-all") allowAllCommands = true;
        if (approval === "deny") proceed = false;
      }
      if (!proceed) {
        // User denied: disable commit/PR workflow for this run and continue in
        // ordinary file-write mode. File writes must NOT break.
        repoCommitWorkflowEnabled = false;
        emit({
          type: "command_run",
          command: label,
          exitCode: -1,
          durationMs: 0,
          outputPreview: "Denied by the user",
          denied: true,
        });
        emit({
          type: "diagnostic",
          phase: "round_preparing",
          message: `Commit & PR workflow disabled — you declined to create feature branch "${name}". Worker file writes will still proceed in ordinary mode.`,
        });
      } else {
        let created: Awaited<ReturnType<typeof createBranchViaRunner>> = null;
        let failure = "";
        try {
          created = await createBranchViaRunner(runner, { name, checkout: true });
        } catch (err) {
          failure = err instanceof Error ? err.message : "runner error";
        }
        if (created) {
          repoCommitWorkflowEnabled = true;
          repoActiveBranch = created.branch;
          emit({
            type: "command_run",
            command: label,
            exitCode: 0,
            durationMs: 0,
            outputPreview: `Created ${created.branch}${created.checkedOut ? " (checked out)" : ""}`,
          });
          emit({
            type: "diagnostic",
            phase: "round_preparing",
            message: `Created feature branch "${created.branch}" — commit & PR workflow enabled for this run.`,
          });
          await refreshRepoState();
        } else {
          // Creation failed (or workflow unavailable): keep commit/PR OFF,
          // continue in ordinary file-write mode.
          repoCommitWorkflowEnabled = false;
          emit({
            type: "command_run",
            command: label,
            exitCode: -1,
            durationMs: 0,
            outputPreview: failure || "Branch creation unavailable",
          });
          emit({
            type: "diagnostic",
            phase: "round_preparing",
            message: `Commit & PR workflow disabled — could not create feature branch "${name}"${failure ? ` (${failure})` : ""}. Worker file writes will still proceed.`,
          });
        }
      }
    } else {
      // Already on a safe feature branch with no conflicts.
      repoCommitWorkflowEnabled = true;
      repoActiveBranch = status?.currentBranch ?? null;
    }
    }
  }

  // Persist the initial plan/state so a stop during the first wave is resumable.
  saveCheckpoint({
    status: "running",
    wave: wavesRun,
    tasks,
    architectNotes,
    verifyCommand,
  });

  let done = false;
  // No-progress tracking: a wave that changes nothing increments noProgressWaves;
  // a failure that keeps recurring with the same fingerprint is counted so the
  // build stops as "blocked" only after repeated recovery attempts truly stall.
  let noProgressWaves = 0;
  let lastFailureFingerprint: string | null = null;

  for (let cycle = 1; cycle <= BUILD_MAX_WAVES && !done; cycle++) {
    wavesRun = cycle;
    // Stop cleanly at the wave boundary if the active USD/time window is spent.
    if (stopForGuardrail({ wave: cycle, tasks, architectNotes, verifyCommand }))
      return;
    // Drive the hero progress bar one notch per review wave. Builds count
    // "waves" (review cycles), not panel-style discussion rounds. There is no
    // fixed wave budget anymore (BUILD_MAX_WAVES is only a safety backstop), so
    // report maxRounds 0 for an indeterminate, open-ended run.
    emit({
      type: "status",
      status: "running",
      round: cycle,
      maxRounds: 0,
    });
    const pending = tasks.filter(
      (t) => t.status === "planned" || t.status === "fixing"
    );
    if (pending.length === 0) break;
    // Write-conflict tracking and the deferral-announced set are per wave.
    waveWrites.clear();
    waveChangeSummaries = new Map<string, string[]>();
    const deferAnnounced = new Set<string>();

    const executed: Array<{
      task: BuildTask;
      worker: SelectedModel;
      files: string[];
      notes: string;
      changes: string[];
    }> = [];

    // Latest screenshot per task this wave (e.g. a Playwright browser_take_screenshot),
    // for the reviewer to judge visual acceptance. WAVE-scoped (like `executed`),
    // NOT batch-scoped like waveWrites — a screenshot outlives the tool batch that
    // produced it. Keyed by task id; a later shot for the same task replaces the
    // earlier one. Only wired when a vision-capable reviewer is used and not under
    // the benchmark harness (see the review-call assembly below).
    const waveScreenshots = new Map<string, AttachmentPayload>();

    // A failed attempt (threw, or returned no files) goes back to the pool
    // once so another — or a better — worker can retry it, instead of the
    // deliverable silently dying with the wave. The second failure is final.
    const failTask = (
      task: BuildTask,
      stat: WorkerStat,
      worker: SelectedModel,
      detail: string,
      kind: "bad" | "unavailable"
    ): void => {
      // "unavailable" = the provider denied/timed out; it's not the model's
      // fault, so it never dents the quality score (only badOutput does).
      if (kind === "unavailable") {
        stat.unavailable += 1;
      } else {
        stat.badOutput += 1;
        stat.wBadOutput += difficultyWeight(task);
      }
      const decision = decideBuildTaskFailure(task, kind, detail);
      task.failCount = decision.failCount;
      task.status = decision.status;
      if (task.status === "fixing") {
        task.workerIndex = undefined;
        task.assignTo = undefined;
        task.retryAfterMs = decision.retryDelayMs
          ? Date.now() + decision.retryDelayMs
          : undefined;
        task.instructions = `${task.instructions}\n\n${decision.instructionNote}`;
      } else {
        task.retryAfterMs = undefined;
      }
      recordBuildProblem({
        code: "no_output",
        severity: task.status === "failed" ? "blocked" : "error",
        source: "worker",
        modelId: worker.modelId,
        modelName: worker.displayName,
        providerId: parseModelId(worker.modelId).providerId,
        taskId: task.id,
        wave: cycle,
        message: `${worker.displayName} ${detail} for ${task.id}${
          task.status === "fixing"
            ? " - requeued for another attempt"
            : " - giving up on this task"
        }`,
      });
      emit({
        type: "task_status",
        taskId: task.id,
        title: task.title,
        status: task.status,
        worker: worker.displayName,
        cycle,
      });
      emit({
        type: "diagnostic",
        phase: "model_failed",
        message: `${worker.displayName} ${detail} for ${task.id}${
          task.status === "fixing"
            ? " - requeued for another attempt"
            : " - giving up on this task"
        }`,
      });
    };

    // Provider-side denials/transience are not a quality signal. Detected from
    // the error text the providers surface (status codes, "overloaded", quota,
    // timeouts, network) so a free-tier 429/503 doesn't tank a model's score.
    const UNAVAILABLE = /\b(429|500|502|503|504|529)\b|rate.?limit|over.?loaded|high demand|capacity|quota|exhausted|timed? ?out|temporarily|unavailable|econnreset|etimedout|enotfound|socket hang up|network|fetch failed/i;
    const classifyError = (message: string): "bad" | "unavailable" =>
      UNAVAILABLE.test(message) ? "unavailable" : "bad";

    const workerToolInstructions = (
      budget: BuildWorkerToolInstructionBudget,
      allowSplit = false
    ): string =>
      buildWorkerToolInstructions({
        ...budget,
        mcpToolsDoc,
        mcpCallsLeft: mcpCallsLeftThisPhase(),
        localServerUrls,
        shellHint,
        allowSplit,
      });

    const runWorkerTask = async (task: BuildTask): Promise<void> => {
      const worker = workers[task.workerIndex!];
      const stat = scoreboard[task.workerIndex!];
      stat.attempts += 1;
      // Fold a worker call's tokens into the scoreboard for the
      // tokens-per-approved-task KPI; shared by every streamConversation below.
      const attributeUsage = (u: { inputTokens: number; outputTokens: number }): void => {
        stat.inputTokens += u.inputTokens;
        stat.outputTokens += u.outputTokens;
      };

      emit({
        type: "task_status",
        taskId: task.id,
        title: task.title,
        status: "in_progress",
        worker: worker.displayName,
        cycle,
      });

      const contextChunks: string[] = [];
      for (const path of task.contextFiles) {
        const content = await readFile(path);
        if (content != null) {
          contextChunks.push(`\n--- ${path} ---\n${truncate(content, PER_FILE_REVIEW_CHARS)}`);
        }
      }
      const workerSkills = selectSkills(
        skillInput("worker", "worker", {
          task,
          touchedPaths: [...(task.contextFiles ?? []), ...(task.outputPaths ?? [])],
          requestedSkillIds: requestedNextWorkerSkillIds,
        })
      );
      requestedNextWorkerSkillIds = [];
      emitSkillActivation(
        `${task.id}: ${task.title}`,
        "worker",
        "worker",
        workerSkills,
        undefined,
        workerSkills.evidenceRequired
      );
      const workerContextFileText = contextChunks.length
        ? `\nContext files:${contextChunks.join("\n")}`
        : "";
      const workerSkillContext = renderSkillContext(workerSkills);
      const budgets = createBuildWorkerBudget({
        difficulty: task.difficulty,
        activeSkillIds: activeSkillIds(workerSkills),
        runsLeft: runsLeftThisPhase(),
        fetchesLeft: fetchesLeftThisPhase(),
        failCount: task.failCount,
      });
      const workerAssembledContext = buildContextManager.buildWorkerContext({
        modelContextProfile: modelContextProfile(worker),
        request: discussion.topic,
        treeText: treeText(),
        task,
        contextFileText: workerContextFileText,
        architectNotes,
        memoryRecords: activeBuildMemories(),
      });
      emitBuildMemoryEvent();
      emitContextAssembled(workerAssembledContext, {
        phase: "worker",
        label: `${task.id}: ${task.title}`,
        model: worker,
        taskId: task.id,
      });

      const startedAt = Date.now();
      let output = "";
      const patchedFiles: string[] = [];
      const toolIssues: string[] = [];
      try {
        await answerPendingGuidanceForTask(task, cycle);

        let workerMessages: ChatMessage[] = [
          {
            role: "system",
            content:
              "You are an AI engineer completing one assigned task. Use tools when needed, then output the final files or notes.",
          },
          {
            role: "user",
            content: buildWorkerTaskPrompt({
              request: discussion.topic,
              treeText: treeText(),
              task,
              contextFileText: "",
              architectNotes: "",
              memoryBrief: "",
              toolInstructions: workerToolInstructions(
                workerBudgetToolInstructionInput(budgets),
                (task.splitDepth ?? 0) === 0
              ),
              verbosityInstruction,
              skillContext: workerSkillContext,
              assembledContext: workerAssembledContext,
            }),
          },
        ];
        const tracker = createToolCallTracker();
        const replayCache = createToolReplayCache();
        let badToolCalls = 0;
        let skippedOnlyToolBatches = 0;
        let blockingGuidanceAsked = false;
        let terminalToolGuidanceAsked = false;

        // Dispatch a batch of worker tool actions in one turn: safe reads run
        // together; writes (patch/append) apply in order; MCP stays approval-gated;
        // duplicates and budget-exhausted/unsupported actions are skipped. Per-action side
        // effects (recordToolCall, patchedFiles/toolIssues, diagnostics) match
        // the single-action loop exactly; one combined result is returned.
        const dispatchWorkerToolBatch = async (
          actions: ArchitectAction[],
          actor: string
        ): Promise<{
          message: string;
          servedCount: number;
          skippedCount: number;
          terminalSkippedCount: number;
          terminalSkippedReasons: string[];
        }> => {
          const schedule = scheduleBuildToolActions(actions, {
            allowSafeRunQueue: false,
            maxSafeRuns: 0,
          });
          const served: Array<{
            label: string;
            result: string;
            preserveFullResult?: boolean;
          }> = [];
          const skipped = schedule.skipped.map((item) => ({
            label: item.label,
            reason: item.reason,
          }));
          const terminalSkippedReasons: string[] = [];
          const terminalSkip = (label: string, reason: string): void => {
            skipped.push({ label, reason });
            terminalSkippedReasons.push(`${label}: ${reason}`);
          };
          for (const item of schedule.served) {
            const action = item.action;
            if (!isWorkerBuildToolAction(action)) {
              skipped.push({ label: item.label, reason: "worker tool loop cannot run this action" });
              continue;
            }
            if (isRedundantToolCall(tracker, action)) {
              const replayed = replayCache.replay(action);
              if (replayed) {
                served.push({
                  label: `${item.label} (replayed)`,
                  result: replayed,
                  preserveFullResult: action.action === "context_retrieve",
                });
                continue;
              }
              skipped.push({ label: item.label, reason: "duplicate tool request (already delivered)" });
              continue;
            }
            if (action.action === "context_retrieve") {
              const result = executeContextRetrieve(action, actor, worker);
              recordToolCall(tracker, action);
              replayCache.remember(action, result);
              served.push({
                label: item.label,
                result,
                preserveFullResult: true,
              });
              continue;
            }
            if (action.action === "tool") {
              if (mcpCallsLeftThisPhase() <= 0) {
                terminalSkip(item.label, "no MCP tool call budget left in this phase");
                continue;
              }
              const toolResult = await executeTool(action, worker);
              if (shouldRecordToolCallResult(action, toolResult.status)) {
                recordToolCall(tracker, action);
              }
              // Any MCP tool result carrying an image (e.g. Playwright
              // browser_take_screenshot) becomes this task's LATEST acceptance
              // screenshot for the reviewer. Off under the benchmark harness.
              // Keep the base64 out of the served text (it would blow the tool
              // digest); instead tell the worker the shot was captured.
              let toolResultText = toolResult.text;
              if (toolResult.image && !benchmark) {
                const ext = toolResult.image.mimeType.split("/")[1] || "png";
                // Re-captures move to the Map tail so slice(-4) keeps the most RECENTLY captured tasks.
                waveScreenshots.delete(task.id);
                waveScreenshots.set(task.id, {
                  id: uuidv4(),
                  filename: `${task.id}-acceptance.${ext}`,
                  mimeType: toolResult.image.mimeType,
                  category: "image",
                  base64Data: toolResult.image.dataBase64,
                });
                toolResultText += "\n[screenshot captured and stored for the reviewer]";
              }
              served.push({
                label: item.label,
                result: storeLongToolResult(
                  "tool_exchange",
                  `MCP ${action.server}.${action.tool}`,
                  toolResultText
                ),
              });
              continue;
            }
            if (action.action === "run") {
              const replayed = replayCache.replay(action);
              if (replayed) {
                served.push({
                  label: `${item.label} (replayed)`,
                  result: replayed,
                });
                continue;
              }
              const serveRunResult = (result: string): void => {
                recordToolCall(tracker, action);
                replayCache.remember(action, result);
                served.push({
                  label: item.label,
                  result,
                });
              };
              if (!runner) {
                terminalSkip(item.label, "no local runner is available for command runs");
                continue;
              }
              if (budgets.runs <= 0) {
                terminalSkip(item.label, "no worker command runs left for this task");
                continue;
              }
              if (!canExecuteRunAction(action.command)) {
                terminalSkip(item.label, "no command runs left in this phase");
                continue;
              }
              budgets.runs -= 1;
              const result = await executeRun(action.command, action.reason);
              const packedResult = storeLongToolResult(
                "command_output",
                `Command: ${action.command}`,
                result
              );
              serveRunResult(packedResult);
              continue;
            }
            if (action.action === "fetch") {
              // Fetch is a non-mutating network read; workers draw from the SAME
              // shared phase pool as the Architect via executeFetch (which handles
              // the runner, per-fetch approval, pool accounting, and diagnostics).
              const replayed = replayCache.replay(action);
              if (replayed) {
                served.push({ label: `${item.label} (replayed)`, result: replayed });
                continue;
              }
              if (budgets.fetches <= 0) {
                terminalSkip(item.label, "no fetch budget left in this task");
                continue;
              }
              if (fetchesLeftThisPhase() <= 0) {
                terminalSkip(item.label, "no web fetches left in this phase");
                continue;
              }
              budgets.fetches -= 1;
              const result = await executeFetch(action);
              const packedResult = storeLongToolResult("fetch", `Fetch: ${action.url}`, result);
              recordToolCall(tracker, action);
              replayCache.remember(action, packedResult);
              served.push({ label: item.label, result: packedResult });
              continue;
            }
            if (action.action === "read" && budgets.reads > 0) {
              budgets.reads -= 1;
              const paths = action.paths.slice(0, 6);
              const chunks: string[] = [];
              for (const path of paths) {
                const content = await readFile(path);
                chunks.push(`\n--- ${path} ---\n${content ?? "[not found or binary]"}`);
              }
              const joined = chunks.join("\n");
              emitFileToolDiagnostic(
                `${formatBuildFileToolDiagnostic({ actor, action: "read", paths })} · ${kbOf(joined)} · ${budgets.reads} read(s) left`,
                worker
              );
              recordToolCall(tracker, action);
              replayCache.remember(action, joined);
              served.push({ label: item.label, result: truncate(joined, 18_000) });
              continue;
            }
            if (action.action === "read_range" && budgets.rangeReads > 0) {
              budgets.rangeReads -= 1;
              const out = await readFileRange(action.path, action.startLine, action.lineCount);
              emitFileToolDiagnostic(
                `${formatBuildFileToolDiagnostic({ actor, action: "read_range", path: action.path, startLine: action.startLine, lineCount: action.lineCount })} · ${kbOf(out)} · ${budgets.rangeReads} range read(s) left`,
                worker
              );
              const deliveredRange = parseDeliveredRange(out);
              recordToolCall(tracker, action, deliveredRange);
              replayCache.remember(action, out, deliveredRange);
              served.push({ label: item.label, result: out });
              continue;
            }
            if (action.action === "search" && budgets.searches > 0) {
              budgets.searches -= 1;
              const out = await searchProject(action.query);
              emitFileToolDiagnostic(
                `${formatBuildFileToolDiagnostic({ actor, action: "search", query: action.query })} · ${kbOf(out)} · ${budgets.searches} search(es) left`,
                worker
              );
              recordToolCall(tracker, action);
              const result = `Search results for "${action.query}":\n${out}`;
              replayCache.remember(action, result);
              served.push({ label: item.label, result });
              continue;
            }
            if (action.action === "patch" || action.action === "append") {
              const scopeIssue = rejectWorkerWriteOutsideTaskScope(task, action.path);
              if (scopeIssue) {
                toolIssues.push(scopeIssue);
                served.push({ label: item.label, result: scopeIssue });
                continue;
              }
            }
            if (action.action === "patch" && budgets.patches > 0) {
              budgets.patches -= 1;
              const result = await applyPatchAction(action.path, action.ops, task.id);
              emitFileToolDiagnostic(
                `${formatBuildFileToolDiagnostic({ actor, action: "patch", path: action.path, summary: result.summary })} · ${budgets.patches} patch(es) left`,
                worker
              );
              patchedFiles.push(...result.written);
              toolIssues.push(...result.issues);
              served.push({ label: item.label, result: result.summary });
              continue;
            }
            if (action.action === "append" && budgets.appends > 0) {
              budgets.appends -= 1;
              const result = await applyAppendAction(action.path, action.content, !!action.reset, task.id);
              emitFileToolDiagnostic(
                `${formatBuildFileToolDiagnostic({ actor, action: "append", path: action.path, summary: result.summary })} · ${budgets.appends} append(s) left`,
                worker
              );
              patchedFiles.push(...result.written);
              toolIssues.push(...result.issues);
              served.push({ label: item.label, result: result.summary });
              continue;
            }
            terminalSkip(item.label, `no ${action.action} budget left in this task`);
          }
          emit({
            type: "tool_batch",
            actor,
            served: served.length,
            skipped: skipped.length,
            summary: `${served.length} served, ${skipped.length} skipped`,
          });
          return {
            message: packToolBatchResult({ served, skipped, maxChars: TOOL_BATCH_RESULT_CHARS }),
            servedCount: served.length,
            skippedCount: skipped.length,
            terminalSkippedCount: terminalSkippedReasons.length,
            terminalSkippedReasons,
          };
        };

        for (let turn = 0; turn < budgets.toolTurns; turn++) {
          const compacted = compactToolConversation(
            workerMessages,
            80_000,
            8,
            buildCompactionPlaceholder(
              `${worker.displayName} ${task.id} omitted tool exchange`
            )
          );
          if (compacted.compacted > 0) {
            workerMessages = compacted.messages;
            emit({
              type: "diagnostic",
              phase: "model_streaming",
              modelId: worker.modelId,
              modelName: worker.displayName,
              providerId: parseModelId(worker.modelId).providerId,
              message: `Compacted ${worker.displayName}'s context for ${task.id} — folded ${compacted.compacted} older tool exchange(s)`,
            });
          }
          output = await streamConversation(worker, workerMessages, {
            maxTokens: workerMaxTokens(worker),
            label:
              turn === 0
                ? `${worker.displayName} working on ${task.id}: ${task.title}`
                : `${worker.displayName} continuing ${task.id}: ${task.title}`,
            stopWhen: hasCompleteBuildToolAction,
            nativeTools: buildNativeBuildToolDefinitions("worker"),
            onUsage: attributeUsage,
          });
          workerMessages.push({ role: "assistant", content: output });
          const inspected = inspectStrictToolActionBatchOutput(output);
          const hasGuidanceRequest = inspected.actions.some(
            (action) => action.action === "guidance_request"
          );
          const split =
            (task.splitDepth ?? 0) === 0 ? parseWorkerSplitAction(output) : null;
          if (hasGuidanceRequest && split) {
            badToolCalls += 1;
            const feedback =
              "GUIDANCE REQUEST REJECTED: guidance_request must be emitted by itself, with no other actions. Reply with one blocking/async guidance_request only, or continue with safe tool actions/final output.";
            toolIssues.push(feedback);
            workerMessages.push({ role: "user", content: feedback });
            emit({
              type: "diagnostic",
              phase: "model_failed",
              modelId: worker.modelId,
              modelName: worker.displayName,
              providerId: parseModelId(worker.modelId).providerId,
              message: `${worker.displayName} combined a guidance_request with split_task for ${task.id}`,
            });
            if (badToolCalls >= budgets.badToolCalls) {
              toolIssues.push(
                `Too many invalid guidance requests (${badToolCalls}); task stopped to avoid wasting more turns.`
              );
              break;
            }
            continue;
          }
          // Escape hatch: a worker may split an oversized task ONCE per lineage.
          // Children run in the next batch of the same wave; the parent is marked
          // done and never reaches review, so its scoreboard is left untouched.
          if (split) {
            const applied = applyTaskSplit(tasks, task.id, split, MAX_CONTEXT_FILES);
            if (applied.ok && applied.childIds) {
              architectNotes = [
                architectNotes,
                `${task.id} was split by ${worker.displayName} into ${applied.childIds.join(", ")}: ${truncate(split.reason, 300)}`,
              ]
                .filter(Boolean)
                .join("\n");
              emit({
                type: "task_status",
                taskId: task.id,
                title: task.title,
                status: "done",
                worker: worker.displayName,
                cycle,
              });
              for (const childId of applied.childIds) {
                const child = tasks.find((t) => t.id === childId);
                if (child) {
                  emit({
                    type: "task_status",
                    taskId: child.id,
                    title: child.title,
                    status: "planned",
                    cycle,
                  });
                }
              }
              emit({
                type: "diagnostic",
                phase: "round_preparing",
                message: `${worker.displayName} split ${task.id} into ${applied.childIds.length} subtasks (${applied.childIds.join(", ")})`,
              });
              return;
            }
            workerMessages.push({
              role: "user",
              content: `SPLIT REJECTED: ${applied.reason}. Either fix the split (2-4 subtasks, disjoint outputPaths within your task's declared files) or complete the task normally.`,
            });
            // Deliberate asymmetry: SPLIT REJECTED feedback is actionable and split-specific (unlike opaque malformed JSON), so it is NOT charged against the tighter badToolCalls budget; the tool-turn cap still bounds the worst case.
            continue;
          }
          if (inspected.actions.length === 0) {
            if (inspected.feedback && !inspected.valid) {
              badToolCalls += 1;
              const feedback = inspected.feedback;
              toolIssues.push(feedback);
              recordBuildProblem({
                code: "malformed_tool_call",
                severity: "error",
                source: "worker",
                modelId: worker.modelId,
                modelName: worker.displayName,
                providerId: parseModelId(worker.modelId).providerId,
                taskId: task.id,
                wave: cycle,
                message: `${worker.displayName} made an invalid tool call for ${task.id}: ${feedback}`,
              });
              emit({
                type: "diagnostic",
                phase: "model_failed",
                modelId: worker.modelId,
                modelName: worker.displayName,
                providerId: parseModelId(worker.modelId).providerId,
                message: `${worker.displayName} made an invalid tool call for ${task.id}: ${feedback}`,
              });
              workerMessages.push({
                role: "user",
                content: `${feedback}\nDo not repeat the same malformed response. Reply with one or more valid JSON tool actions, or stop using tools and provide final file output.`,
              });
              if (badToolCalls >= budgets.badToolCalls) {
                toolIssues.push(
                  `Too many malformed tool calls (${badToolCalls}); task stopped to avoid wasting more turns.`
                );
                break;
              }
              continue;
            }
            // No tool action this turn — the worker is done with tools; move on
            // to its final file output below.
            break;
          }

          const actor = `${worker.displayName} ${task.id}`;
          const warning = inspected.feedback ? `${inspected.feedback}\n\n` : "";
          if (warning) {
            recordBuildProblem({
              code: "tool_warning",
              severity: "warning",
              source: "worker",
              modelId: worker.modelId,
              modelName: worker.displayName,
              providerId: parseModelId(worker.modelId).providerId,
              taskId: task.id,
              wave: cycle,
              message: `${worker.displayName} tool-call warning for ${task.id}: ${inspected.feedback}`,
            });
            emit({
              type: "diagnostic",
              phase: "model_failed",
              modelId: worker.modelId,
              modelName: worker.displayName,
              providerId: parseModelId(worker.modelId).providerId,
              message: `${worker.displayName} tool-call warning for ${task.id}: ${inspected.feedback}`,
            });
          }

          const guidanceRequests = inspected.actions.filter(
            (action): action is GuidanceRequestAction =>
              action.action === "guidance_request"
          );
          if (guidanceRequests.length > 0) {
            if (inspected.actions.length > 1 || guidanceRequests.length > 1) {
              badToolCalls += 1;
              const feedback =
                "GUIDANCE REQUEST REJECTED: guidance_request must be emitted by itself, with no other actions. Reply with one blocking/async guidance_request only, or continue with safe tool actions/final output.";
              toolIssues.push(feedback);
              workerMessages.push({ role: "user", content: feedback });
              emit({
                type: "diagnostic",
                phase: "model_failed",
                modelId: worker.modelId,
                modelName: worker.displayName,
                providerId: parseModelId(worker.modelId).providerId,
                message: `${worker.displayName} combined a guidance_request with other actions for ${task.id}`,
              });
              if (badToolCalls >= budgets.badToolCalls) {
                toolIssues.push(
                  `Too many invalid guidance requests (${badToolCalls}); task stopped to avoid wasting more turns.`
                );
                break;
              }
              continue;
            }
            const guidanceAction = guidanceRequests[0];
            if (guidanceAction.mode === "blocking" && blockingGuidanceAsked) {
              badToolCalls += 1;
              const feedback =
                "GUIDANCE REQUEST REJECTED: one blocking guidance question was already asked during this task attempt. Continue with the Architect guidance already provided or produce final output.";
              toolIssues.push(feedback);
              workerMessages.push({ role: "user", content: feedback });
              emit({
                type: "diagnostic",
                phase: "model_failed",
                modelId: worker.modelId,
                modelName: worker.displayName,
                providerId: parseModelId(worker.modelId).providerId,
                message: `${worker.displayName} asked a second blocking guidance question for ${task.id}`,
              });
              if (badToolCalls >= budgets.badToolCalls) {
                toolIssues.push(
                  `Too many invalid guidance requests (${badToolCalls}); task stopped to avoid wasting more turns.`
                );
                break;
              }
              continue;
            }

            const guidanceRecord = addGuidanceRequest(
              task,
              guidanceAction,
              worker,
              cycle
            );
            emit({
              type: "diagnostic",
              phase: "round_preparing",
              modelId: worker.modelId,
              modelName: worker.displayName,
              providerId: parseModelId(worker.modelId).providerId,
              message: `${worker.displayName} requested ${guidanceAction.mode} Architect guidance ${guidanceRecord.id} for ${task.id}`,
            });
            if (guidanceAction.mode === "blocking") {
              blockingGuidanceAsked = true;
              await answerGuidanceRequest(task, guidanceRecord, cycle);
              workerMessages.push({
                role: "user",
                content: renderTaskGuidanceForWorker([guidanceRecord]),
              });
              continue;
            }
            workerMessages.push({
              role: "user",
              content: `Guidance ${guidanceRecord.id} was queued for the next same-task iteration. Continue only if the task is safe without the answer.`,
            });
            continue;
          }

          const batch = await dispatchWorkerToolBatch(inspected.actions, actor);
          const skippedOnlyRecovery = skippedOnlyToolBatchRecoveryInstruction(batch);
          const batchFeedback = `${warning}${batch.message}${skippedOnlyRecovery}`;
          if (batch.terminalSkippedCount > 0) {
            toolIssues.push(
              ...batch.terminalSkippedReasons.map(
                (reason) => `TOOL BUDGET BLOCKED: ${reason}`
              )
            );
            if (!terminalToolGuidanceAsked) {
              terminalToolGuidanceAsked = true;
              const guidanceRecord = addGuidanceRequest(
                task,
                {
                  action: "guidance_request",
                  mode: "blocking",
                  question: [
                    "The worker requested a tool that could not run because the required tool budget or runner resource is unavailable.",
                    "Unavailable request(s):",
                    ...batch.terminalSkippedReasons.map((reason) => `- ${reason}`),
                    "How should the worker proceed without that unavailable tool?",
                    "You may instruct the worker to continue from available context, produce scoped files with explicit verification gaps, or stop so review/planning can create follow-up work.",
                  ].join("\n"),
                  reason: truncate(
                    `Terminal tool result:\n${batch.message}`,
                    1_200
                  ),
                },
                worker,
                cycle
              );
              blockingGuidanceAsked = true;
              emit({
                type: "diagnostic",
                phase: "round_preparing",
                modelId: worker.modelId,
                modelName: worker.displayName,
                providerId: parseModelId(worker.modelId).providerId,
                message: `${worker.displayName} hit terminal tool exhaustion for ${task.id}; requesting blocking Architect guidance ${guidanceRecord.id}`,
              });
              await answerGuidanceRequest(task, guidanceRecord, cycle);
              workerMessages.push({
                role: "user",
                content: [
                  batchFeedback,
                  renderTaskGuidanceForWorker([guidanceRecord]),
                  "The unavailable tool did not run. Do not request that same unavailable tool again in this task attempt. Continue from available context and the Architect guidance, then emit final files/patches or a scoped verification-gap report.",
                ].join("\n\n"),
              });
              continue;
            }
            break;
          }
          workerMessages.push({
            role: "user",
            content: batchFeedback,
          });
          if (batch.servedCount > 0 && batch.skippedCount > 0) {
            recordBuildProblem({
              code: "tool_warning",
              severity: "warning",
              source: "worker",
              modelId: worker.modelId,
              modelName: worker.displayName,
              providerId: parseModelId(worker.modelId).providerId,
              taskId: task.id,
              wave: cycle,
              message: `${worker.displayName} tool batch skipped ${batch.skippedCount} action(s) for ${task.id}`,
              details: batch.message,
            });
          }
          if (batch.servedCount > 0) {
            skippedOnlyToolBatches = 0;
          }
          if (batch.servedCount === 0) {
            if (batch.skippedCount > 0) {
              skippedOnlyToolBatches += 1;
              if (skippedOnlyToolBatches === 1) {
                recordBuildProblem({
                  code: "tool_warning",
                  severity: "warning",
                  source: "worker",
                  modelId: worker.modelId,
                  modelName: worker.displayName,
                  providerId: parseModelId(worker.modelId).providerId,
                  taskId: task.id,
                  wave: cycle,
                  message: `${worker.displayName} tool batch for ${task.id} served nothing; requested actions were skipped and the worker was told to finalize without more tools.`,
                  details: batch.message,
                });
                continue;
              }
            }
            // Nothing ran repeatedly (all duplicate, unsupported, or budget-exhausted).
            // Count it like a malformed turn so a stuck worker still bails out.
            badToolCalls += 1;
            recordBuildProblem({
              code: "empty_tool_batch",
              severity: "error",
              source: "worker",
              modelId: worker.modelId,
              modelName: worker.displayName,
              providerId: parseModelId(worker.modelId).providerId,
              taskId: task.id,
              wave: cycle,
              message: `${worker.displayName} tool batch for ${task.id} served nothing (all duplicate, unsupported, or budget-exhausted)`,
              details: batch.message,
            });
            emit({
              type: "diagnostic",
              phase: "model_failed",
              modelId: worker.modelId,
              modelName: worker.displayName,
              providerId: parseModelId(worker.modelId).providerId,
              message: `${worker.displayName} tool batch for ${task.id} served nothing (all duplicate, unsupported, or budget-exhausted)`,
            });
            if (badToolCalls >= budgets.badToolCalls) {
              toolIssues.push(
                `Too many repeated or unusable tool calls (${badToolCalls}); task stopped to avoid wasting more turns.`
              );
              break;
            }
          }
          continue;
        }

        for (let finalAttempt = 0; finalAttempt < WORKER_FINAL_OUTPUT_ATTEMPTS; finalAttempt++) {
          const preview = extractArtifacts(output);
          if (
            patchedFiles.length > 0 ||
            preview.files.length > 0 ||
            preview.edits.length > 0 ||
            preview.truncatedPaths.length > 0 ||
            toolIssues.length === 0
          ) {
            break;
          }
          const instruction =
            "FINAL ATTEMPT: stop using tools. Using only the context and tool results already shown, output the files/patches for this task now. Do not emit JSON tool actions. If modifying an existing file, emit SEARCH/REPLACE edit blocks copied from the current content you already read. If creating a new file, emit a fenced file block with path=...";
          workerMessages.push({ role: "user", content: instruction });
          emit({
            type: "diagnostic",
            phase: "model_streaming",
            modelId: worker.modelId,
            modelName: worker.displayName,
            providerId: parseModelId(worker.modelId).providerId,
            message: `${worker.displayName} hit repeated tool issues for ${task.id}; requesting final file output without more tools`,
          });
          output = await streamConversation(worker, workerMessages, {
            maxTokens: workerMaxTokens(worker),
            label: `${worker.displayName} finalizing ${task.id}: ${task.title}`,
            onUsage: attributeUsage,
          });
          workerMessages.push({ role: "assistant", content: output });
        }

        const artifactResult = await writeEmittedFiles(output, task.id);
        const files = [...new Set([...patchedFiles, ...artifactResult.written])];
        const issues = [...toolIssues, ...artifactResult.issues];
        const { prose } = extractArtifacts(output);
        const declaredOutputPaths = task.outputPaths?.length
          ? task.outputPaths
          : outputPathsForTask(task);
        const toolBudgetBlockedNoFiles =
          files.length === 0 &&
          (toolIssues.some((issue) => issue.startsWith("TOOL BUDGET BLOCKED:")) ||
            isWorkerOutputBlockedByToolBudget(output));
        const skillEvidence = createSkillEvidence({
          taskId: task.id,
          actor: worker.displayName,
          activeSkillIds: workerSkills.overlays,
          workerOutput: output,
          allowVerificationOnlyExemptions: shouldAllowEvidenceOnlySkillExemptions({
            emittedFiles: files,
            declaredOutputPaths,
            taskInstructions: task.instructions,
          }),
        });
        if (skillEvidence.length > 0) {
          skillEvidenceRecords.push(...skillEvidence);
          const blockingSkillEvidence = getBlockingSkillEvidence(skillEvidence, task.id);
          for (const record of blockingSkillEvidence) {
            recordBuildProblem({
              code: "skill_evidence_missing",
              severity: "warning",
              source: "worker",
              taskId: task.id,
              modelId: worker.modelId,
              modelName: worker.displayName,
              providerId: parseModelId(worker.modelId).providerId,
              wave: cycle,
              message: `Required skill evidence is missing for ${task.id} (${record.skillId}).`,
              details: record.violations.join("\n") || record.missingEvidence.join("\n"),
            });
          }
          persistBuildMemories(
            extractSkillViolationMemories({
              projectKey: buildMemoryProjectKey,
              discussionId: discussion.id,
              violations: skillEvidence.flatMap((record) =>
                record.violations.map((violation) => ({
                  taskId: record.taskId,
                  skillId: record.skillId,
                  violation,
                  paths: [
                    ...(task.contextFiles ?? []),
                    ...(task.outputPaths?.length ? task.outputPaths : outputPathsForTask(task)),
                  ],
                }))
              ),
            })
          );
          emitSkillActivation(
            `${task.id}: ${task.title}`,
            "worker",
            "worker",
            workerSkills,
            skillEvidence,
            skillEvidence.flatMap((record) => record.violations)
          );
        }
        // The model DID respond — a no-files result is a quality failure
        // (bad output), distinct from a provider denial.
        const reviewFiles = evidenceOnlyRetryFiles({
          emittedFiles: files,
          priorFiles: task.contextFiles,
          evidence: skillEvidence,
          taskId: task.id,
          maxFiles: MAX_CONTEXT_FILES,
          workerOutput: output,
        });
        const evidenceOnlyNoFileReview = shouldReviewEvidenceOnlyTask({
          emittedFiles: files,
          priorFiles: task.contextFiles,
          declaredOutputPaths,
          evidence: skillEvidence,
          taskId: task.id,
          workerOutput: output,
        });
        if (
          toolBudgetBlockedNoFiles ||
          (reviewFiles.length === 0 && !evidenceOnlyNoFileReview)
        ) {
          failTask(
            task,
            stat,
            worker,
            toolBudgetBlockedNoFiles
              ? `could not complete because tool budget was exhausted (${truncate(
                  toolIssues.join("; ") || output,
                  300
                )})`
              : issues.length > 0
              ? `produced no usable files (${truncate(issues.join("; "), 300)})`
              : "returned no files",
            toolBudgetBlockedNoFiles ? "unavailable" : "bad"
          );
          return;
        }
        stat.responses += 1;
        stat.responseMs += Date.now() - startedAt;
        stat.responseChars += output.length;
        task.retryAfterMs = undefined;
        task.status = "review";
        // Issues are appended AFTER the truncation so the Architect always
        // sees them in the review prompt — a silently skipped write must
        // never be approved blind.
        const reviewIssues = evidenceOnlyNoFileReview
          ? splitEvidenceOnlyReviewIssues(issues)
          : { blocking: issues, warnings: [] };
        const issueNotes =
          issues.length > 0
            ? `\nWRITE ISSUES — these changes did NOT land; act on them in your review:\n${issues.map((s) => `- ${s}`).join("\n")}`
            : "";
        const filteredIssueNotes =
          evidenceOnlyNoFileReview && reviewIssues.blocking.length !== issues.length
            ? reviewIssues.blocking.length > 0
              ? `\nWRITE ISSUES - these changes did NOT land; act on them in your review:\n${reviewIssues.blocking.map((s) => `- ${s}`).join("\n")}`
              : ""
            : issueNotes;
        const warningNotes =
          reviewIssues.warnings.length > 0
            ? `\nRECOVERED TOOL WARNINGS - these happened before the final evidence-only response and did not skip a file write:\n${reviewIssues.warnings.map((s) => `- ${s}`).join("\n")}`
            : "";
        const skillNotes = formatSkillEvidenceDigest(skillEvidence);
        executed.push({
          task,
          worker,
          files: reviewFiles,
          notes:
            truncate(prose, 1_500) +
            (files.length === 0
              ? reviewFiles.length > 0
                ? `\n\nEvidence-only retry: no new files were emitted; reviewing previously landed file(s): ${reviewFiles.join(", ")}.`
                : "\n\nEvidence-only task: no files were emitted or expected; reviewing the worker's command evidence and notes."
              : "") +
            (skillNotes ? `\n\n${skillNotes}` : "") +
            filteredIssueNotes +
            warningNotes,
          changes: waveChangeSummaries.get(task.id) ?? [],
        });
        emit({
          type: "task_status",
          taskId: task.id,
          title: task.title,
          status: "review",
          worker: worker.displayName,
          cycle,
        });
      } catch (err) {
        if (isAbortError(err)) throw err;
        const message = err instanceof Error ? err.message : "error";
        const kind = classifyError(message);
        if (kind === "unavailable" && patchedFiles.length > 0) {
          stat.unavailable += 1;
          stat.responses += 1;
          stat.responseMs += Date.now() - startedAt;
          stat.responseChars += output.length;
          task.retryAfterMs = undefined;
          task.status = "review";
          executed.push({
            task,
            worker,
            files: [...new Set(patchedFiles)],
            notes:
              `Provider became unavailable after writing files (${message}). Review the landed files before approving.` +
              (toolIssues.length > 0
                ? `\nWRITE ISSUES - these changes did NOT land; act on them in your review:\n${toolIssues.map((s) => `- ${s}`).join("\n")}`
                : ""),
            changes: waveChangeSummaries.get(task.id) ?? [],
          });
          emit({
            type: "task_status",
            taskId: task.id,
            title: task.title,
            status: "review",
            worker: worker.displayName,
            cycle,
          });
          emit({
            type: "diagnostic",
            phase: "model_failed",
            message: `${worker.displayName} was unavailable after writing files for ${task.id} - sending landed files to Architect review instead of failing the task`,
          });
          return;
        }
        failTask(
          task,
          stat,
          worker,
          kind === "unavailable" ? `was unavailable (${message})` : `failed (${message})`,
          kind
        );
      }
    };

    // A dependency is satisfied only after the Architect has approved it.
    // "review" output is not enough: dependents should not patch files built
    // by an unreviewed task. Unknown ids are treated as satisfied by the shared
    // helper so a typo cannot deadlock a run forever.
    const dependencySettled = (depId: string): boolean => {
      const dep = tasks.find((t) => t.id === depId);
      return isBuildTaskDependencySatisfied(dep);
    };

    // Dispatch every ready task CONCURRENTLY; repeat so dependency chains run
    // batch by batch (independent tasks never wait on each other).
    for (;;) {
      throwIfAborted();
      // Worker-call count is telemetry only — it never stops the run. Stop here
      // only if the active USD/time budget window is consumed.
      if (stopForGuardrail({ wave: cycle, tasks, architectNotes, verifyCommand }))
        return;
      const ready = tasks.filter(
        (t) =>
          (t.status === "planned" || t.status === "fixing") &&
          (t.dependsOn ?? []).every(dependencySettled)
      );
      if (ready.length === 0) break;
      const now = Date.now();
      const due = ready.filter((t) => !t.retryAfterMs || t.retryAfterMs <= now);
      if (due.length === 0) {
        const waitMs = Math.max(
          0,
          Math.min(...ready.map((t) => t.retryAfterMs ?? now)) - now
        );
        emit({
          type: "diagnostic",
          phase: "round_preparing",
          message: `Waiting ${Math.ceil(waitMs / 1000)}s before retrying transiently failed task${ready.length === 1 ? "" : "s"}`,
        });
        await waitForRetry(waitMs);
        continue;
      }
      // Greedily fill the batch, but never run two tasks whose DECLARED outputs
      // overlap concurrently — that's exactly the silent last-write-wins clobber
      // we want to prevent. A task with no parseable outputs always joins (we
      // can't know its writes — don't over-block). Deferred tasks just stay
      // planned/fixing and get picked up by the next loop iteration.
      const cap = BUILD_TASKS_PER_WAVE;
      const batch: BuildTask[] = [];
      const claimed = new Set<string>();
      for (const task of due) {
        if (batch.length >= cap) break;
        const paths = (task.outputPaths?.length ? task.outputPaths : outputPathsForTask(task)).map((p) =>
          p.toLowerCase()
        );
        const clash = paths.find((p) => claimed.has(p));
        if (clash) {
          if (!deferAnnounced.has(task.id)) {
            deferAnnounced.add(task.id);
            const owner = batch.find((b) =>
              (b.outputPaths?.length ? b.outputPaths : outputPathsForTask(b))
                .map((p) => p.toLowerCase())
                .includes(clash)
            );
            emit({
              type: "diagnostic",
              phase: "round_preparing",
              message: `Deferred ${task.id} to the next batch — its declared outputs overlap ${owner?.id ?? "another task"}'s (${clash})`,
            });
          }
          continue;
        }
        for (const p of paths) claimed.add(p);
        batch.push(task);
      }
      // Nothing could be admitted (everything left clashes with itself across
      // iterations — shouldn't happen since claimed resets, but guard anyway).
      if (batch.length === 0) break;

      // Assign a worker to each task: a still-active in-progress pin wins, then
      // the Architect's assignTo is treated as a preference, then auto-assignment
      // spreads work across active workers best-first. This prevents one worker
      // from monopolizing the run when multiple selected workers are available.
      const ranked = rankedActiveWorkers();
      for (const task of batch) {
        const pinned =
          task.workerIndex != null && scoreboard[task.workerIndex]?.active
            ? task.workerIndex
            : null;
        const requested = workerIndexByName(task.assignTo);
        const requestedActive =
          requested != null && scoreboard[requested].active ? requested : null;
        if (task.assignTo && pinned == null && requestedActive == null) {
          emit({
            type: "diagnostic",
            phase: "round_preparing",
            message: `Requested worker "${task.assignTo}" for ${task.id} is unknown or benched — auto-assigning instead`,
          });
        }
        const selected = selectBalancedWorkerIndex({
          activeWorkerIndexes: ranked.map((worker) => worker.index),
          assignmentCounts: workerAssignmentCounts,
          assignCursor,
          pinnedIndex: pinned,
          requestedIndex: requestedActive,
        });
        assignCursor = selected.assignCursor;
        task.workerIndex = selected.index;
        if (task.assignTo && requestedActive != null && !selected.honoredRequest && pinned == null) {
          emit({
            type: "diagnostic",
            phase: "round_preparing",
            message: `Balanced ${task.id} away from requested worker "${task.assignTo}" to ${scoreboard[selected.index].name} so selected workers share the build.`,
          });
        }
      }

      if (batch.length > 1) {
        emit({
          type: "diagnostic",
          phase: "round_preparing",
          message: `Running ${batch.length} independent tasks concurrently: ${batch.map((t) => t.id).join(", ")}`,
        });
      }
      // The write guard only protects concurrently-running tasks. A later
      // batch may intentionally patch the same file after its dependency has
      // landed and been approved.
      waveWrites.clear();
      // allSettled so an abort in one task doesn't leave the siblings as
      // unhandled rejections; runWorkerTask only rethrows abort errors.
      const settled = await Promise.allSettled(batch.map(runWorkerTask));
      const rejected = settled.find(
        (r): r is PromiseRejectedResult => r.status === "rejected"
      );
      if (rejected) throw rejected.reason;
    }

    if (executed.length === 0) {
      // Nothing usable this wave. Try the next wave (bounded by BUILD_MAX_WAVES,
      // guardrails, and no-progress detection) instead of silently ending the
      // build half-done.
      benchUnresponsiveWorkers();
      emit({
        type: "diagnostic",
        phase: "round_preparing",
        message: `No task produced output in wave ${cycle} — retrying the remaining tasks`,
      });
      continue;
    }

    // Architect review of this wave.
    const executedText = buildWaveReviewDigest(
      executed.map(({ task, worker, files, notes, changes }) => ({
        task,
        workerName: worker.displayName,
        files,
        notes,
        changes,
      }))
    );

    // Mechanical backstop: compile/type-check the project now so the verdict
    // is informed by the actual compiler, not only the models' reading.
    const verifyResult = await runVerify(verifyCommand);
    const verifyFeedback = verifyResult.feedback;

    // Fingerprint a failing build/test so a recurring identical failure counts
    // toward the no-progress/blocked stop, while a failure that changes shape
    // after a fix counts as recovery progress (and resets the no-progress run).
    if (shouldRecordAutomatedBuildCheckFailure(verifyResult)) {
      const fingerprint = fingerprintBuildFailure(verifyCommand, verifyFeedback);
      const failureChanged =
        lastFailureFingerprint !== null && lastFailureFingerprint !== fingerprint;
      lastFailureFingerprint = fingerprint;
      failureFingerprints = recordBuildFailure(failureFingerprints, fingerprint);
      recordBuildProblem({
        code:
          (failureFingerprints[fingerprint] ?? 0) > 1
            ? "verification_repeated"
            : "verification_failed",
        severity: "error",
        source: "runner",
        action: verifyCommand,
        wave: cycle,
        message: `Automated build check failed in wave ${cycle}: ${verifyCommand}`,
        details: truncate(verifyFeedback, 1_500),
      });
      if (failureChanged) {
        recoveryLog.push(`Verification failure changed after wave ${cycle}.`);
      }
    }

    const waveTaskIds = new Set(executed.map(({ task }) => task.id));
    const waveSkillEvidence = skillEvidenceRecords.filter(
      (record) => record.taskId != null && waveTaskIds.has(record.taskId)
    );
    const reviewSkills = selectSkills(
      skillInput("review", "reviewer", {
        touchedPaths: executed.flatMap(({ files }) => files),
        riskFlags: verifyResult.failed ? ["verification"] : [],
        requestedSkillIds: requestedReviewerSkillIds,
      })
    );
    requestedReviewerSkillIds = [];
    emitSkillActivation(
      `Architect review wave ${cycle}`,
      "review",
      "reviewer",
      reviewSkills,
      waveSkillEvidence,
      [
        ...reviewSkills.evidenceRequired,
        ...waveSkillEvidence.flatMap((record) => record.violations),
      ]
    );

    const reviewActor = reviewer ?? architect;
    emit({
      type: "diagnostic",
      phase: "judging",
      message: `${reviewActor.displayName} is reviewing wave ${cycle}`,
    });

    // The Architect inspects files / runs commands in a real conversation, then
    // returns a verdict. If it loops or exhausts its budget the loop FORCES a
    // verdict; tasks without explicit two-gate approvals are sent back for review
    // rather than being approved blind.
    // Stop cleanly before the (expensive) Architect review call if spent.
    if (stopForGuardrail({ wave: cycle, tasks, architectNotes, verifyCommand }))
      return;
    const reviewSkillContext = renderSkillContext(reviewSkills);
    const reviewAttachments = claimRawBuildAttachmentsForArchitect();
    // Attach this wave's acceptance screenshots so the reviewer can judge visual
    // acceptance (layout, blank screens, error states) — not just the a11y tree
    // and console text. Only the LATEST four tasks' shots: each image is heavy
    // context, and four covers the most recently touched work without ballooning
    // the review call. Inert when: benchmark harness, no screenshots captured, or
    // the reviewer model can't accept images.
    const screenshotTaskIds = [...waveScreenshots.keys()];
    const screenshotAttachments =
      !benchmark &&
      screenshotTaskIds.length > 0 &&
      modelSupportsInputTypes(reviewActor.modelId, ["image"])
        ? screenshotTaskIds.slice(-4).map((id) => waveScreenshots.get(id)!)
        : [];
    const reviewSkillEvidenceText = formatSkillEvidenceDigest(waveSkillEvidence);
    const reviewOutstandingTasks = buildOutstandingTasksDigest(tasks);
    const reviewPhaseSpec =
      executed.find((item) => item.task.phaseSpec)?.task.phaseSpec ??
      activePhaseSpec;
    const reviewChangedFiles = [
      ...new Set(executed.flatMap(({ files }) => files)),
    ];
    codeIntelBudget.resetPhase();
    const reviewImpactPacks = await reviewCodeIntelPacks(
      reviewChangedFiles,
      cycle
    );
    // Diff-first review evidence: when a runner is connected to a Git repo, feed
    // the ACTUAL unified diff of this wave's changed files as the highest-priority
    // context pack so the reviewer judges real landed changes, not summaries.
    // Skipped for certified benchmark runs (repo side effects are policy-blocked
    // there) and when the fetch fails — a diff failure NEVER fails the review.
    const reviewContextPacks = [...reviewImpactPacks];
    let hasReviewDiffDigest = false;
    if (runner && repoIsGit && reviewChangedFiles.length > 0 && !benchmark) {
      try {
        const scopedPaths = reviewChangedFiles.slice(0, REPO_DIFF_FILE_CAP);
        // Two calls: getRepoDiffViaRunner returns one mode per request — full patch + a separate --stat summary.
        const [patchDiff, statDiff] = await Promise.all([
          getRepoDiffViaRunner(runner, { paths: scopedPaths, staged: false }),
          getRepoDiffViaRunner(runner, { paths: scopedPaths, staged: false, stat: true }),
        ]);
        const rawPatch = (patchDiff?.diff ?? "").trim();
        const stat = (statDiff?.diff ?? "").trim();
        // A huge patch is parked as a ctx blob first; the reviewer can
        // context_retrieve the rest from the digest reference.
        const patch =
          rawPatch.length > 24_000
            ? storeLongToolResult("repo_diff", `Wave ${cycle} diff`, rawPatch)
            : rawPatch;
        const diffContent = buildReviewDiffPackContent({
          stat,
          patch,
          files: reviewChangedFiles,
          maxChars: 24_000,
        });
        if (diffContent) {
          reviewContextPacks.push({
            id: `review-diff-wave-${cycle}`,
            kind: "diagnostic" as const,
            title: "Wave diff (primary review evidence)",
            content: diffContent,
            // Above the code-intel impact packs (145) so the real diff outranks
            // derived summaries when the token budget squeezes.
            priority: 160,
          });
          hasReviewDiffDigest = true;
          emitFileToolDiagnostic(
            `Wave ${cycle} diff attached for review · ${kbOf(rawPatch)}`,
            reviewActor
          );
        }
      } catch (err) {
        if (isAbortError(err)) throw err;
        emit({
          type: "diagnostic",
          phase: "judging",
          message: `Wave diff unavailable for review: ${err instanceof Error ? err.message : "runner error"}`,
        });
      }
    }
    const reviewAssembledContext = buildContextManager.buildReviewContext({
      modelContextProfile: modelContextProfile(reviewActor),
      request: discussion.topic,
      treeText: treeText(),
      fileContext: truncate(
        joinBuildContextSections(buildAttachmentManifest, extraFileContext),
        TOTAL_REVIEW_CHARS
      ),
      executedText,
      outstandingTasks: reviewOutstandingTasks,
      verificationText: verifyFeedback,
      userNotes: userNotesText(),
      memoryRecords: activeBuildMemories(),
      scoreboard: scoreboard.some((s) => s.attempts > 0) ? scoreboardText() : "",
      skillEvidenceText: reviewSkillEvidenceText,
      contextPacks: reviewContextPacks,
    });
    emitBuildMemoryEvent();
    emitContextAssembled(reviewAssembledContext, {
      phase: "review",
      label: `${reviewActor.displayName} review wave ${cycle}`,
      model: reviewActor,
    });
    const reviewResult = await runArchitectInspectionLoop({
      terminal: "review",
      label: `${reviewActor.displayName} is reviewing wave ${cycle}`,
      actor: reviewActor,
      actorLabel: reviewActor.modelId === architect.modelId ? "Architect" : "Reviewer",
      initialUser: buildArchitectReviewPrompt({
        request: discussion.topic,
        treeText: treeText(),
        // Everything read so far (plan-phase manifests + read hops) — without
        // this the Architect forgets file contents between phases and starts
        // inventing replacements for files it has already seen.
        fileContext: "",
        executedText: "",
        outstandingTasks: "",
        maxNewTasks: BUILD_TASKS_PER_WAVE,
        cyclesLeft: Math.max(0, BUILD_MAX_WAVES - cycle),
        readHopsLeft: 2,
        rangeReadsLeft: 6,
        runsLeft: runsLeftThisPhase(),
        githubWorkflow: githubWorkflow && !!runner,
        repoWorkflow: !!runner,
        githubCli: githubCli ?? undefined,
        githubLabels: repoLabels,
        searchesLeft: SEARCHES_PER_PHASE,
        codeIntelStatus: codeIntelStatusForPrompt(),
        codeIntelCallsLeft: codeIntelCallsLeftThisPhase(),
        mcpToolsDoc,
        mcpCallsLeft: mcpCallsLeftThisPhase(),
        userNotes: "",
        memoryBrief: "",
        scoreboard: "",
        fetchesLeft: fetchesLeftThisPhase(),
        shellHint,
        skillContext: reviewSkillContext,
        skillEvidenceText: "",
        spec: activeSpec,
        phaseSpec: reviewPhaseSpec,
        assembledContext: reviewAssembledContext,
        hasDiffDigest: hasReviewDiffDigest,
        // Name the tasks whose screenshots are attached so the prompt tells the
        // reviewer to judge them visually. Only when shots were actually attached.
        screenshotTaskIds:
          screenshotAttachments.length > 0 ? screenshotTaskIds.slice(-4) : undefined,
      }),
      initialAttachments: [...reviewAttachments, ...screenshotAttachments],
      budgets: { reads: 2, rangeReads: 6, searches: SEARCHES_PER_PHASE },
      appendContext: (textChunk) => {
        extraFileContext += textChunk;
      },
    });
    const action = reviewResult.action as ReviewAction;
    const text = reviewResult.text;
    persistBuildMemories(
      extractReviewMemories({
        projectKey: buildMemoryProjectKey,
        discussionId: discussion.id,
        results: action.results.map((result) => {
          const task = tasks.find((item) => item.id === result.taskId);
          const prior = executed.find((item) => item.task.id === result.taskId);
          return {
            taskId: result.taskId,
            verdict: isReviewResultApproved(result) ? "approve" : "fix",
            fixInstructions: isReviewResultApproved(result)
              ? result.fixInstructions
              : buildReviewGateFixInstructions(result),
            paths:
              prior?.files ??
              task?.outputPaths ??
              (task ? outputPathsForTask(task) : undefined),
          };
        }),
      })
    );
    // The architect's own fixes. If any were rejected/skipped, carry that into
    // the accumulated context so the next phase knows they did not land.
    const { issues: fixIssues } = await writeEmittedFiles(text);
    if (fixIssues.length > 0) {
      extraFileContext += `\nYOUR PREVIOUS FIXES THAT DID NOT LAND:\n${fixIssues.map((s) => `- ${s}`).join("\n")}`;
    }

    if (action.notes?.trim()) {
      const reviewNotes = action.notes.trim();
      architectNotes = [
        reviewNotes,
        ...promotedGuidanceNotes.filter((note) => !reviewNotes.includes(note)),
      ].join("\n");
    }

    const reviewedTaskIds = new Set<string>();
    const sendTaskBackForFix = (
      task: BuildTask,
      fixInstructions: string,
      problemMessage?: string
    ): void => {
      if (task.workerIndex != null) {
        const st = scoreboard[task.workerIndex];
        st.fixes += 1;
        st.wFixes += difficultyWeight(task);
      }
      const prior = executed.find((e) => e.task.id === task.id);
      Object.assign(
        task,
        buildReviewFixTaskUpdate(
          task,
          fixInstructions,
          prior?.files ?? [],
          MAX_CONTEXT_FILES
        )
      );
      if (problemMessage) {
        recordBuildProblem({
          code: "skill_evidence_missing",
          severity: "error",
          source: "engine",
          taskId: task.id,
          wave: cycle,
          message: problemMessage,
          details: fixInstructions,
        });
      }
      emit({ type: "task_status", taskId: task.id, title: task.title, status: "fixing", cycle });
    };

    for (const result of action.results) {
      const task = tasks.find((t) => t.id === result.taskId);
      if (!task || task.status === "done") continue;
      reviewedTaskIds.add(task.id);
      // Credit/debit the worker that produced this task's output.
      const verdictStat =
        task.workerIndex != null ? scoreboard[task.workerIndex] : null;
      if (isReviewResultApproved(result)) {
        const evidenceFix = buildSkillEvidenceFixInstructions(waveSkillEvidence, task.id);
        if (evidenceFix) {
          sendTaskBackForFix(
            task,
            evidenceFix,
            `Architect approval for ${task.id} was blocked because required skill evidence is missing.`
          );
          continue;
        }
        if (verdictStat) {
          verdictStat.approvals += 1;
          verdictStat.wApprovals += difficultyWeight(task);
        }
        task.status = "done";
        emit({ type: "task_status", taskId: task.id, title: task.title, status: "done", cycle });
      } else {
        if (verdictStat) {
          verdictStat.fixes += 1;
          verdictStat.wFixes += difficultyWeight(task);
        }
        const prior = executed.find((e) => e.task.id === task.id);
        Object.assign(
          task,
          buildReviewFixTaskUpdate(
            task,
            buildReviewGateFixInstructions(result),
            prior?.files ?? [],
            MAX_CONTEXT_FILES
          )
        );
        emit({ type: "task_status", taskId: task.id, title: task.title, status: "fixing", cycle });
      }
    }
    // Tasks the review didn't mention count as approved only when the review
    // was explicit and no deterministic gate found a problem.
    for (const { task } of executed) {
      if (task.status === "review") {
        const evidenceFix = buildSkillEvidenceFixInstructions(waveSkillEvidence, task.id);
        if (evidenceFix) {
          sendTaskBackForFix(
            task,
            evidenceFix,
            `Review omitted ${task.id}, but required skill evidence is missing.`
          );
          continue;
        }
        if (reviewResult.forced || !reviewedTaskIds.has(task.id)) {
          sendTaskBackForFix(
            task,
            reviewResult.forced
              ? "Architect review did not return explicit specVerdict and qualityVerdict before the inspection budget ended. Inspect the landed files against the current phase spec, run the relevant verification, and return concrete two-gate approval or fix verdicts with evidence."
              : "Architect review omitted this task. Inspect the landed files against the current phase spec, run the relevant verification, and return explicit specVerdict and qualityVerdict values.",
            reviewResult.forced
              ? `Forced review could not explicitly approve both gates for ${task.id}.`
              : `Review omitted explicit two-gate verdict for ${task.id}.`
          );
          continue;
        }
        if (task.workerIndex != null) {
          const st = scoreboard[task.workerIndex];
          st.approvals += 1;
          st.wApprovals += difficultyWeight(task);
        }
        task.status = "done";
        emit({ type: "task_status", taskId: task.id, title: task.title, status: "done", cycle });
      }
    }

    benchUnresponsiveWorkers();

    emit({
      type: "diagnostic",
      phase: "judging",
      message: `Worker scoreboard after wave ${cycle}:\n${scoreboardText()}`,
    });

    const novelTasks = filterNovelReviewTasks(
      tasks,
      (action.newTasks ?? []).slice(0, BUILD_TASKS_PER_WAVE)
    );
    if (action.phaseSpec) {
      activePhaseSpec = action.phaseSpec;
    }
    for (const skipped of novelTasks.skipped) {
      emit({
        type: "diagnostic",
        phase: "judging",
        message: `Skipped duplicate new task "${skipped.id}" from review — ${skipped.id} already exists (${skipped.existingStatus}: ${skipped.title}). Use a new id for replacement work or mark the existing task as fix.`,
      });
    }
    for (const raw of novelTasks.accepted) {
      const task = toTask(raw, tasks.length);
      tasks.push(task);
      emit({ type: "task_status", taskId: task.id, title: task.title, status: "planned", cycle });
    }

    let verifyCommandChangedThisWave = false;
    if (typeof action.verifyCommand === "string") {
      const requestedVerifyCommand = action.verifyCommand.trim();
      if (!requestedVerifyCommand) {
        if (verifyCommand) {
          emit({
            type: "diagnostic",
            phase: "judging",
            message: `${reviewActor.displayName} disabled the automated build check for future waves.`,
          });
        }
        verifyCommand = "";
        verifyCommandChangedThisWave = true;
      } else {
        const acceptedVerifyCommand = acceptVerifyCommandForRunner(
          requestedVerifyCommand,
          "Review verifyCommand",
          tasks.flatMap((task) => task.outputPaths ?? [])
        );
        if (acceptedVerifyCommand) {
          if (
            acceptedVerifyCommand.toLowerCase() !== verifyCommand.toLowerCase()
          ) {
            emit({
              type: "diagnostic",
              phase: "judging",
              message: `${reviewActor.displayName} changed the automated build check to \`${acceptedVerifyCommand}\`.`,
            });
            verifyCommandChangedThisWave = true;
          }
          verifyCommand = acceptedVerifyCommand;
        }
      }
      if (verifyCommandChangedThisWave && activePhaseSpec) {
        activePhaseSpec = {
          ...activePhaseSpec,
          verification: verifyCommand ? [verifyCommand] : [],
        };
      }
    }

    const verificationFixTask =
      !verifyCommandChangedThisWave && shouldRecordAutomatedBuildCheckFailure(verifyResult)
      ? buildVerificationFailureTask({
          tasks,
          verifyCommand,
          verifyFeedback,
          knownFiles: currentProjectFiles(),
        })
      : null;
    if (verificationFixTask) {
      tasks.push(verificationFixTask);
      recoveryLog.push(
        `Added ${verificationFixTask.id} to repair automated verification failure from wave ${cycle}.`
      );
      architectNotes = [
        architectNotes,
        `The automated verification command failed after wave ${cycle}; the engine added ${verificationFixTask.id} with scoped output paths ${verificationFixTask.outputPaths?.join(", ")}. Complete this task before marking the build done.`,
      ]
        .filter(Boolean)
        .join("\n");
      emit({
        type: "task_status",
        taskId: verificationFixTask.id,
        title: verificationFixTask.title,
        status: "planned",
        cycle,
      });
      emit({
        type: "diagnostic",
        phase: "judging",
        message: `Added ${verificationFixTask.id} to fix the failing verification path(s): ${verificationFixTask.outputPaths?.join(", ")}.`,
      });
    }

    // Did this wave change anything real? Files written, tasks advanced or added,
    // a failure that changed shape, or repo/branch/PR state moving all count as
    // progress and reset the no-progress run.
    const waveProgressed = hasMeaningfulBuildProgress({
      filesWritten: executed.reduce((sum, item) => sum + item.files.length, 0),
      tasksAdvanced:
        action.results.length + novelTasks.accepted.length + (verificationFixTask ? 1 : 0),
      failureChanged:
        verifyCommandChangedThisWave ||
        recoveryLog.some((entry) => entry.includes(`wave ${cycle}`)),
      repoAdvanced: !!repoActiveBranch || repoCommits.length > 0 || !!repoPrUrl,
    });
    noProgressWaves = waveProgressed ? 0 : noProgressWaves + 1;

    const remainingDigest = buildOutstandingTasksDigest(tasks);
    if (action.done && remainingDigest) {
      done = false;
      architectNotes = [
        architectNotes,
        "The previous review tried to finish the build, but the engine found required tasks still unfinished. Resolve these before marking done:",
        remainingDigest,
      ]
        .filter(Boolean)
        .join("\n");
      emit({
        type: "diagnostic",
        phase: "judging",
        message: `Completion deferred: required tasks are still unfinished.\n${remainingDigest}`,
      });
    } else {
      done = action.done;
    }

    // GitHub-completion gate: if the request explicitly asked for a pull request
    // and the Architect marked done WITHOUT one actually being opened, do not
    // accept "done" — push it to finish the workflow (commit → push → open PR)
    // instead of letting it "finish" (or hallucinate success). Bounded so a model
    // that genuinely cannot complete it still terminates (and the deterministic
    // summary block then flags the workflow INCOMPLETE).
    if (done && prExpected && !repoPrUrl && githubCompletionDeferrals < 2) {
      githubCompletionDeferrals += 1;
      done = false;
      architectNotes = [
        architectNotes,
        "You marked the build done, but the requested GitHub PULL REQUEST has NOT been opened (the engine has no record of repo_pr_create succeeding). Before you may finish, actually emit the typed repo actions: create any requested milestone/issues (repo_milestone_create / repo_issue_create), then repo_commit, repo_push, and repo_pr_create (draft). Do NOT claim these happened — emit the actions and let the tool results confirm them.",
      ]
        .filter(Boolean)
        .join("\n");
      emit({
        type: "diagnostic",
        phase: "judging",
        message: `Completion deferred: a pull request was requested but none was opened (attempt ${githubCompletionDeferrals}/2).`,
      });
    }

    // Stop as "blocked" (a resumable state with failure history preserved) when
    // recovery has genuinely stalled — repeated identical failures or several
    // waves with no progress — but never override an Architect that just
    // declared the build done.
    if (!done) {
      const repeatedFailureCount =
        lastFailureFingerprint == null
          ? 0
          : failureFingerprints[lastFailureFingerprint] ?? 0;
      if (shouldStopForNoProgress({ repeatedFailureCount, noProgressWaves })) {
        recoveryLog.push(
          `Stopped as blocked after wave ${cycle}: ${repeatedFailureCount} repeated failure(s), ${noProgressWaves} no-progress wave(s).`
        );
        recordBuildProblem({
          code: "repeated_no_progress",
          severity: "blocked",
          source: "engine",
          wave: cycle,
          message: `Build stopped after repeated no-progress recovery attempts: ${repeatedFailureCount} repeated failure(s), ${noProgressWaves} no-progress wave(s).`,
        });
        const message =
          "Build stopped after repeated no-progress recovery attempts. Resume keeps the checkpoint and lets you change settings or add guidance.";
        const report = createStopReport({
          status: "blocked",
          stopReason: "blocked",
          message,
          wave: cycle,
          tasks,
          verifyCommand,
        });
        const toolReviewReport = createToolReviewReport({
          status: "blocked",
          wave: cycle,
        });
        saveCheckpoint({
          status: "blocked",
          stopReason: "blocked",
          wave: cycle,
          tasks,
          architectNotes,
          verifyCommand,
          stopReport: report,
          toolReviewReport,
        });
        markStopped("blocked", message, report, toolReviewReport);
        return;
      }
    }

    // Refresh repo status/diff at the end of each wave so the UI reflects the
    // files just written; the last wave's refresh is thus the final state
    // shown before the summary.
    await refreshRepoState();

    // Checkpoint the reviewed wave so a later budget/time/blocked stop resumes
    // from the current task graph instead of re-planning from scratch.
    saveCheckpoint({
      status: "running",
      wave: cycle,
      tasks,
      architectNotes,
      verifyCommand,
    });
  }

  // Fold this build's scoreboard into the global per-model stats (the
  // "which models actually perform" view on the dashboard). The Architect is
  // the judge of record; a verdict is "independent" when the judge is a
  // different model from the one being scored (not grading its own work).
  accumulateModelStats({
    judgeModelId: architect.modelId,
    workers: scoreboard
      .filter((s) => s.attempts > 0)
      .map((s) => ({
        modelId: workers[s.index].modelId,
        displayName: s.name,
        attempts: s.attempts,
        approvals: s.approvals,
        fixes: s.fixes,
        badOutput: s.badOutput,
        unavailable: s.unavailable,
        wApprovals: s.wApprovals,
        wFixes: s.wFixes,
        wBadOutput: s.wBadOutput,
        responseMs: s.responseMs,
        responseChars: s.responseChars,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
      })),
  });

  // ── Final summary ──────────────────────────────────────────────────────────
  const incompleteTasks = findIncompleteBuildTasks(tasks);
  if (incompleteTasks.length > 0) {
    const message = buildIncompleteTaskFailure(incompleteTasks);
    recordBuildProblem({
      code: "incomplete_tasks",
      severity: "blocked",
      source: "engine",
      wave: wavesRun,
      message,
    });
    const report = createStopReport({
      status: "failed",
      stopReason: "incomplete",
      message,
      wave: wavesRun,
      tasks,
      verifyCommand,
    });
    const toolReviewReport = createToolReviewReport({
      status: "failed",
      wave: wavesRun,
    });
    // Preserve the work so the user can resume from the current task graph.
    saveCheckpoint({
      status: "blocked",
      wave: wavesRun,
      tasks,
      architectNotes,
      verifyCommand,
      stopReport: report,
      toolReviewReport,
    });
    emit({
      type: "build_stopped",
      reason: "blocked",
      message,
      usage: usageWindow,
      report,
      toolReviewReport,
    });
    emit({
      type: "diagnostic",
      phase: "model_failed",
      message,
    });
    throw new Error(message);
  }

  let finalQualityGateSummary = "";
  if (runner || githubWorkflow) {
    emit({
      type: "diagnostic",
      phase: "judging",
      message: "Running final Build quality gate",
    });
    const finalChecks = await runFinalVerificationChecks();
    if (finalChecks.length > 0) {
      repoVerification = finalChecks
        .map((check) => `${check.command} ${check.status}`)
        .join("; ");
    }
    const finalRepoStatus = await refreshRepoState();
    const issueNumbers = [
      ...(repoIssueNumber == null ? [] : [repoIssueNumber]),
      ...repoCreatedIssues.map((item) => item.issue),
    ];
    const browserAcceptanceRequired = shouldRequireBrowserAcceptance({
      request: discussion.topic,
      treeText: treeText(),
      changedFiles: [...buildChangedFiles],
    });
    const qualityGate = evaluateBuildQualityGate({
      githubWorkflow,
      expectedPr: prExpected,
      repoStatus: githubWorkflow
        ? repoStatusForQualityGate(finalRepoStatus)
        : null,
      repoPrUrl,
      repoPushedBranch,
      requiredChecks: finalChecks,
      issueNumbers,
      skillEvidence: skillEvidenceRecords,
      browserAcceptance: {
        required: browserAcceptanceRequired,
        observed: browserAcceptanceObserved,
        reason: browserAcceptanceObserved
          ? `Observed via ${browserAcceptanceEvidence ?? "browser MCP tool"} after browser navigation.`
          : "This appears to be a web app or UI-affecting build; Build mode must record a real-browser acceptance pass before completion.",
      },
    });
    finalQualityGateSummary = formatBuildQualityGateSummary(qualityGate);

    if (qualityGate.status === "blocked") {
      for (const blocker of qualityGate.blockers) {
        recordBuildProblem({
          code:
            blocker.code === "browser_acceptance_missing"
              ? "browser_acceptance_missing"
              : "quality_gate_failed",
          severity: "blocked",
          source: "engine",
          wave: wavesRun,
          message: blocker.message,
          details: blocker.details,
        });
      }
      const message = `Build blocked by final quality gate:\n${qualityGate.blockers
        .map((blocker) => `- ${blocker.message}`)
        .join("\n")}`;
      recoveryLog.push(
        `Stopped as blocked by final quality gate after wave ${wavesRun}.`
      );
      const browserAcceptanceBlocker = qualityGate.blockers.find(
        (blocker) => blocker.code === "browser_acceptance_missing"
      );
      tasks = reopenBuildTasksForQualityGate(tasks, {
        skillEvidence: skillEvidenceRecords,
        browserAcceptanceMissing: !!browserAcceptanceBlocker,
        browserAcceptanceReason:
          browserAcceptanceBlocker?.details ?? browserAcceptanceBlocker?.message,
        maxContextFiles: MAX_CONTEXT_FILES,
      });
      const report = createStopReport({
        status: "blocked",
        stopReason: "blocked",
        message,
        wave: wavesRun,
        tasks,
        verifyCommand:
          finalChecks.map((check) => check.command).join("; ") || verifyCommand,
      });
      const toolReviewReport = createToolReviewReport({
        status: "blocked",
        wave: wavesRun,
      });
      saveCheckpoint({
        status: "blocked",
        stopReason: "blocked",
        wave: wavesRun,
        tasks,
        architectNotes,
        verifyCommand,
        stopReport: report,
        toolReviewReport,
      });
      emit({
        type: "diagnostic",
        phase: "model_failed",
        message: `${message}\n\n${truncate(finalQualityGateSummary, 2_500)}`,
      });
      markStopped("blocked", message, report, toolReviewReport);
      return;
    }
  }

  throwIfAborted();
  emit({ type: "status", status: "judging" });
  emit({
    type: "diagnostic",
    phase: "judging",
    message: "Architect is writing the final build summary",
  });

  const historyText = history
    .map((h) => `## ${h.label}\n${truncate(h.text, 2_500)}`)
    .join("\n\n");
  const summarySkills = selectSkills(
    skillInput("summary", "architect", {
      requestedSkillIds: requestedArchitectSkillIds,
    })
  );
  emitSkillActivation(
    "Architect summary",
    "summary",
    "architect",
    summarySkills,
    skillEvidenceRecords,
    summarySkills.evidenceRequired
  );
  const summarySkillContext = renderSkillContext(summarySkills);
  const summarySkillEvidenceText = formatSkillEvidenceDigest(skillEvidenceRecords);
  const filesChangedText = [...writtenThisRun].sort().join("\n");
  const summaryVerificationText = [
    repoVerification ? `Recorded verification: ${repoVerification}` : "",
    finalQualityGateSummary,
  ]
    .filter(Boolean)
    .join("\n");
  const summaryKnownGaps = [
    !summaryVerificationText
      ? "No automated final verification result was recorded by the engine."
      : "",
    !filesChangedText ? "No files were created or modified in this run." : "",
    buildOutstandingTasksDigest(tasks),
  ]
    .filter(Boolean)
    .join("\n");
  const summaryAttachments = claimRawBuildAttachmentsForArchitect();
  const summaryAssembledContext = buildContextManager.buildSummaryContext({
    modelContextProfile: modelContextProfile(architect),
    request: discussion.topic,
    treeText: treeText(),
    filesChanged: filesChangedText,
    historyText: truncate(historyText, 60_000),
    verificationText: summaryVerificationText,
    knownGaps: summaryKnownGaps,
    userNotes: userNotesText(),
    memoryRecords: activeBuildMemories(),
    skillEvidenceText: summarySkillEvidenceText,
  });
  emitBuildMemoryEvent();
  emitContextAssembled(summaryAssembledContext, {
    phase: "summary",
    label: "Architect final summary",
    model: architect,
  });

  const summaryRaw = await streamTurn(
    architect,
    buildArchitectSummaryPrompt({
      request: discussion.topic,
      treeText: treeText(),
      filesChanged: filesChangedText,
      historyText: "",
      verbosityInstruction,
      userNotes: "",
      githubWorkflow,
      skillContext: summarySkillContext,
      skillEvidenceText: "",
      assembledContext: summaryAssembledContext,
    }),
    {
      systemRole:
        "You are the Architect writing the final hand-off summary in Markdown.",
      maxTokens: architectMaxTokens(architect),
      label: "Architect is writing the build summary",
      attachments: summaryAttachments,
    }
  );

  const { answer, confidence, dissent } = extractJudgeResult(summaryRaw);
  // Deterministically append a bounded "Repository workflow" block so the branch,
  // any user-approved commits, the imported issue, the pushed branch, the PR URL,
  // and the verification result ALWAYS appear in the build summary, regardless of
  // what the Architect chose to write (NRW-006/008). Pure helper keeps it bounded.
  let finalAnswer = answer;
  if (runner && repoIsGit) {
    const block = buildRepoWorkflowSummary({
      branch: repoActiveBranch,
      commits: repoCommits,
      issueNumber: repoIssueNumber,
      issueNumbers: repoCreatedIssues.map((item) => item.issue),
      milestoneTitle: repoMilestoneTitle,
      pushedBranch: repoPushedBranch,
      prUrl: repoPrUrl,
      verification: repoVerification,
      expectedPr: prExpected,
    });
    if (block) finalAnswer = `${answer}\n${block}`;
  }
  if (finalQualityGateSummary) {
    finalAnswer = `${finalAnswer}\n\n${finalQualityGateSummary}`;
  }
  await stopBuildBackgroundProcesses("after Build completed");
  insertFinalResult({
    discussionId: discussion.id,
    answer: finalAnswer,
    confidence,
    dissent: JSON.stringify(dissent),
    createdAt: new Date().toISOString(),
  });
  updateDiscussion(discussion.id, {
    status: "completed",
    buildStopReason: "completed",
    buildStoppedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  // Final checkpoint: a completed run is not resumed (resume skips "completed"),
  // but the record keeps the finished task graph and total budget window.
  const toolReviewReport = createToolReviewReport({
    status: "completed",
    wave: wavesRun,
  });
  saveCheckpoint({
    status: "completed",
    stopReason: "completed",
    wave: wavesRun,
    tasks,
    architectNotes,
    verifyCommand,
    toolReviewReport,
  });
  emit({
    type: "final_answer",
    answer: finalAnswer,
    confidence,
    dissent,
    toolReviewReport,
  });
  // Files land via the runner (its folder), the picked browser folder, or
  // in-app only — name whichever actually applied.
  const diskLabel = runner ? runnerDirName : diskGranted ? dirHandle?.name : null;
  // Note the repo-workflow state for the run so the user knows whether
  // commit/PR-capable work was active (the gate may have disabled it), and how
  // many commits landed (NRW-006).
  const commitNote =
    repoCommits.length > 0
      ? `, ${repoCommits.length} commit${repoCommits.length === 1 ? "" : "s"} (latest ${repoCommits[repoCommits.length - 1].hash})`
      : "";
  const createdIssueNote =
    repoCreatedIssues.length > 0
      ? `, ${repoCreatedIssues.length} GitHub issue${repoCreatedIssues.length === 1 ? "" : "s"}`
      : repoIssueNumber != null
        ? `, issue #${repoIssueNumber}`
        : "";
  const milestoneNote = repoMilestoneTitle ? `, milestone "${repoMilestoneTitle}"` : "";
  const ghNote = `${milestoneNote}${createdIssueNote}${
    repoPushedBranch ? `, pushed ${repoPushedBranch}` : ""
  }${repoPrUrl ? `, PR ${repoPrUrl}` : ""}`;
  const repoWorkflowLabel = repoInitializedByBuild
    ? `initialized repository${repoActiveBranch ? ` branch "${repoActiveBranch}"` : ""}`
    : `safe feature branch${repoActiveBranch ? ` "${repoActiveBranch}"` : ""}`;
  const repoWorkflowNote =
    runner && repoIsGit
      ? repoCommitWorkflowEnabled
        ? ` — commit & PR workflow was enabled (${repoWorkflowLabel})${commitNote}${ghNote}`
        : ` — commit & PR workflow stayed disabled (no safe feature branch)${ghNote}`
      : "";
  emit({
    type: "diagnostic",
    phase: "finished",
    message: `Build complete: ${virtualFs.size} file(s) produced${diskLabel ? ` in "${diskLabel}"` : " (download from the artifact panel)"}${repoWorkflowNote}`,
  });
  emit({ type: "complete" });
}
