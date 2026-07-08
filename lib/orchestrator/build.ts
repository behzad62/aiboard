/**
 * Build mode: the Architect-orchestrated project loop.
 *
 * The judge model acts as the Architect (planner/reviewer); the other selected
 * models are workers. This module holds the shared vocabulary: task types, the
 * Architect's JSON action protocol (with tolerant parsing), and every prompt.
 * The loop itself runs in lib/client/build-engine.ts.
 */

import { FILE_OUTPUT_INSTRUCTION, META_FOOTER_INSTRUCTION } from "./prompts";
import type {
  JsonSchemaObject,
  ModelCapabilities,
  NativeToolCall,
  NativeToolDefinition,
  StructuredOutputFormat,
} from "../providers/base";
import type { CapabilityInputType } from "../attachments/types";
import {
  renderAssembledContext,
  type BuildPromptContextInput,
} from "@/lib/build-context/prompt-assembly";
import type { CodeIntelOperation } from "@/lib/build-context/code-intel";
import {
  clampContextRetrieveOffsetChars,
  clampContextRetrieveMaxTokens,
  CONTEXT_RETRIEVE_DEFAULT_TOKENS,
  isContextBlobRef,
} from "@/lib/build-context/context-store";
import {
  buildSkillEvidenceFixInstructions,
  getBlockingSkillEvidence,
} from "./build-evidence-gates";
import type { SkillEvidence } from "@/lib/skills/types";

export type BuildTaskStatus =
  | "planned"
  | "in_progress"
  | "review"
  | "fixing"
  | "done"
  | "failed";

export interface BuildPhaseSpec {
  id: string;
  objective: string;
  acceptanceCriteria: string[];
  qualityCriteria: string[];
  verification: string[];
  constraints?: string[];
}

export interface BuildSpec extends BuildPhaseSpec {
  /** User-visible requirements owned by the Architect before task planning. */
  requirements: string[];
  /** Explicitly excluded scope so workers do not invent adjacent work. */
  nonGoals?: string[];
  /** Architect-owned implementation direction that should not be delegated. */
  implementationDecisions?: string[];
  /** Known risks or edge cases the build plan must cover or preserve. */
  risks?: string[];
}

export interface BuildTaskGuidance {
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

export type BuildTaskKind = "modify" | "audit" | "verify" | "repo";
export type BuildTaskCompletionMode = "files" | "evidence" | "either";
export type BuildTaskVerificationPolicy = "architect" | "tool" | "external" | "none";

export interface BuildTask {
  id: string;
  title: string;
  instructions: string;
  /**
   * High-level task intent. The engine uses this to decide whether "no file
   * changes needed" is a valid output or a failed implementation attempt.
   */
  kind?: BuildTaskKind;
  /**
   * What must be produced before this task can go to Architect review.
   * Legacy tasks are normalized from outputPaths/title/instructions.
   */
  completionMode?: BuildTaskCompletionMode;
  /**
   * Who owns the final verification gate. The engine should enforce evidence,
   * not force a command when the Architect chose Architect/manual review.
   */
  verificationPolicy?: BuildTaskVerificationPolicy;
  /** Concrete evidence the worker/reviewer should provide when no files land. */
  requiredEvidence?: string[];
  /** Current wave/phase contract this task must satisfy. */
  phaseSpec?: BuildPhaseSpec;
  /** Exact implementation contract from the Architect; workers should not redesign this. */
  implementationContract?: string;
  /** Existing files the worker needs to see to do the task. */
  contextFiles: string[];
  /** Exact files this task is allowed/expected to create or modify. */
  outputPaths?: string[];
  /** What the Architect expects back (free text, e.g. file paths). */
  expectedOutputs?: string;
  status: BuildTaskStatus;
  /** Pinned worker index — in-progress/review bookkeeping for the last worker. */
  workerIndex?: number;
  /**
   * Task ids that must finish before this one starts. Tasks with no pending
   * dependencies run CONCURRENTLY, so the Architect should only add an edge
   * when one task genuinely consumes another's output.
   */
  dependsOn?: string[];
  /** Architect's preferred worker (display name) for this task, if any. */
  assignTo?: string;
  /** Architect's 1-5 difficulty rating (5 = hardest). Weights the global
   * model score so a hard-task approval counts more than a trivial one. */
  difficulty?: number;
  /** Failed attempts so far — the engine requeues with an escalated budget
   * tier per failure until BUILD_TASK_MAX_FAILURES, then marks it failed. */
  failCount?: number;
  /** Epoch milliseconds before this task may be retried after transient failure. */
  retryAfterMs?: number;
  /** Worker indexes that should be avoided for the next retry when alternatives exist. */
  avoidWorkerIndexes?: number[];
  guidance?: BuildTaskGuidance[];
  /** 1 = created by a worker split; such tasks may not split again. */
  splitDepth?: number;
}

export const BUILD_TASK_MAX_FAILURES = 3;
export const BUILD_TASK_TRANSIENT_RETRY_DELAYS_MS = [15_000, 45_000];

const TASK_CONTRACT_VALUES = {
  kind: new Set<BuildTaskKind>(["modify", "audit", "verify", "repo"]),
  completionMode: new Set<BuildTaskCompletionMode>(["files", "evidence", "either"]),
  verificationPolicy: new Set<BuildTaskVerificationPolicy>([
    "architect",
    "tool",
    "external",
    "none",
  ]),
};

function cleanTaskKind(value: unknown): BuildTaskKind | undefined {
  return typeof value === "string" && TASK_CONTRACT_VALUES.kind.has(value as BuildTaskKind)
    ? (value as BuildTaskKind)
    : undefined;
}

function cleanTaskCompletionMode(value: unknown): BuildTaskCompletionMode | undefined {
  return typeof value === "string" &&
    TASK_CONTRACT_VALUES.completionMode.has(value as BuildTaskCompletionMode)
    ? (value as BuildTaskCompletionMode)
    : undefined;
}

function cleanTaskVerificationPolicy(
  value: unknown
): BuildTaskVerificationPolicy | undefined {
  return typeof value === "string" &&
    TASK_CONTRACT_VALUES.verificationPolicy.has(value as BuildTaskVerificationPolicy)
    ? (value as BuildTaskVerificationPolicy)
    : undefined;
}

function taskContractText(task: Pick<BuildTask, "title" | "instructions" | "expectedOutputs" | "implementationContract">): string {
  return [
    task.title,
    task.instructions,
    task.implementationContract,
    task.expectedOutputs,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function inferBuildTaskKind(task: Pick<BuildTask, "title" | "instructions" | "expectedOutputs" | "implementationContract" | "outputPaths">): BuildTaskKind {
  const text = taskContractText(task);
  if (/\b(commit|branch|pull request|pr |github|repo_status|repo status|repository workflow)\b/.test(text)) {
    return "repo";
  }
  if (/\b(verify|verification|test|check|audit|inspect|baseline|confirm|validate|status)\b/.test(text)) {
    if (/\b(audit|inspect|baseline|assess|survey|inventory|no changes?|already present)\b/.test(text)) {
      return "audit";
    }
    return "verify";
  }
  return outputPathsForTask(task).length > 0 ? "modify" : "audit";
}

function defaultCompletionModeForTask(
  task: Pick<BuildTask, "kind" | "title" | "instructions" | "expectedOutputs" | "implementationContract" | "outputPaths">
): BuildTaskCompletionMode {
  if (task.kind === "audit" || task.kind === "verify" || task.kind === "repo") {
    return outputPathsForTask(task).length > 0 ? "either" : "evidence";
  }
  return outputPathsForTask(task).length > 0 ? "files" : "evidence";
}

function defaultVerificationPolicyForTask(
  task: Pick<BuildTask, "kind" | "completionMode" | "outputPaths">
): BuildTaskVerificationPolicy {
  if (task.kind === "audit" || task.completionMode === "evidence") return "architect";
  if (task.kind === "repo") return "external";
  return outputPathsForTask(task).length > 0 ? "tool" : "architect";
}

export function normalizeBuildTaskContract<T extends BuildTask>(task: T): T {
  const kind = cleanTaskKind(task.kind) ?? inferBuildTaskKind(task);
  const completionMode =
    cleanTaskCompletionMode(task.completionMode) ??
    defaultCompletionModeForTask({ ...task, kind });
  const verificationPolicy =
    cleanTaskVerificationPolicy(task.verificationPolicy) ??
    defaultVerificationPolicyForTask({ ...task, kind, completionMode });
  const requiredEvidence = stringArrayFromUnknown(task.requiredEvidence);
  return {
    ...task,
    kind,
    completionMode,
    verificationPolicy,
    ...(requiredEvidence.length > 0 ? { requiredEvidence } : {}),
  };
}

export function taskRequiresToolVerification(
  task: Pick<BuildTask, "verificationPolicy">
): boolean {
  return task.verificationPolicy === "tool";
}

function hasSubstantiveEvidenceText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 40) return false;
  return /\b(verified|verification|confirmed|complete|passed|clean|commit|status|no action required|already present|no changes? needed|satisfies|evidence)\b/i.test(
    trimmed
  );
}

export interface WorkerOutputReviewDecision {
  ok: boolean;
  reason: "files" | "evidence" | "blocked" | "missing_files" | "empty";
  completionMode: BuildTaskCompletionMode;
  verificationPolicy: BuildTaskVerificationPolicy;
  expectsFileOutput: boolean;
  failureDetail?: string;
}

export function canWorkerOutputAdvanceToReview(input: {
  task: BuildTask;
  emittedFiles: string[];
  reviewFiles: string[];
  declaredOutputPaths: string[];
  workerOutput: string;
  evidence?: SkillEvidence[];
  hasBlockingWriteIssues: boolean;
  toolBudgetBlocked: boolean;
}): WorkerOutputReviewDecision {
  const task = normalizeBuildTaskContract(input.task);
  const declaredOutputPaths =
    input.declaredOutputPaths.length > 0
      ? input.declaredOutputPaths
      : outputPathsForTask(task);
  const expectsFileOutput =
    task.completionMode === "files" ||
    (task.completionMode === "either" && declaredOutputPaths.length > 0);
  const base = {
    completionMode: task.completionMode ?? "files",
    verificationPolicy: task.verificationPolicy ?? "tool",
    expectsFileOutput,
  };

  if (input.toolBudgetBlocked) {
    return {
      ...base,
      ok: false,
      reason: "blocked",
      failureDetail: "could not complete because tool budget was exhausted",
    };
  }
  if (input.emittedFiles.length > 0 || input.reviewFiles.length > 0) {
    return { ...base, ok: true, reason: "files" };
  }
  if (input.hasBlockingWriteIssues && task.completionMode !== "evidence") {
    return {
      ...base,
      ok: false,
      reason: "missing_files",
      failureDetail: "write issues prevented expected files from landing",
    };
  }
  const blockingEvidence = input.evidence?.length
    ? getBlockingSkillEvidence(input.evidence, task.id)
    : [];
  if (blockingEvidence.length > 0) {
    return {
      ...base,
      ok: false,
      reason: "blocked",
      failureDetail: "required evidence is missing",
    };
  }
  const evidenceAllowed =
    task.completionMode === "evidence" || task.completionMode === "either";
  if (evidenceAllowed && hasSubstantiveEvidenceText(input.workerOutput)) {
    return { ...base, ok: true, reason: "evidence" };
  }
  if (expectsFileOutput) {
    return {
      ...base,
      ok: false,
      reason: "missing_files",
      failureDetail: "returned no files",
    };
  }
  return {
    ...base,
    ok: false,
    reason: "empty",
    failureDetail: "returned no substantive completion evidence",
  };
}

function isLikelyBaselineAuditBlocker(task: BuildTask): boolean {
  const normalized = normalizeBuildTaskContract(task);
  if (normalized.kind !== "audit" && normalized.completionMode !== "evidence") {
    return false;
  }
  if (outputPathsForTask(normalized).length > 0) return false;
  const text = taskContractText(normalized);
  return /\b(audit|inspect|baseline|survey|inventory|existing|current)\b/.test(text);
}

export interface BuildPlanDispatchValidation {
  tasks: BuildTask[];
  warnings: string[];
}

export function validateBuildPlanForDispatch(
  tasks: BuildTask[]
): BuildPlanDispatchValidation {
  const normalized = tasks.map((task) => normalizeBuildTaskContract({ ...task }));
  const auditBlockerIds = new Set(
    normalized.filter(isLikelyBaselineAuditBlocker).map((task) => task.id)
  );
  const warnings: string[] = [];
  if (auditBlockerIds.size === 0) return { tasks: normalized, warnings };

  const nextTasks = normalized.map((task) => {
    if (!task.dependsOn?.length) return task;
    const stripped = task.dependsOn.filter((dep) => !auditBlockerIds.has(dep));
    if (stripped.length !== task.dependsOn.length) {
      warnings.push(
        `Removed nonessential baseline/audit dependency from ${task.id}: ${task.dependsOn
          .filter((dep) => auditBlockerIds.has(dep))
          .join(", ")}.`
      );
      return { ...task, dependsOn: stripped };
    }
    return task;
  });
  return { tasks: nextTasks, warnings };
}

export interface BuildTaskFailureDecision {
  failCount: number;
  status: "fixing" | "failed";
  instructionNote: string;
  retryDelayMs?: number;
}

export function shouldRequestWorkerFinalOutput(input: {
  hasLandedFiles: boolean;
  hasPreviewArtifacts: boolean;
  hasScopedVerificationGapReport: boolean;
  expectsFileOutput: boolean;
  toolIssueCount: number;
}): boolean {
  if (
    input.hasLandedFiles ||
    input.hasPreviewArtifacts ||
    input.hasScopedVerificationGapReport
  ) {
    return false;
  }
  return input.expectsFileOutput || input.toolIssueCount > 0;
}

export function decideBuildTaskFailure(
  task: Pick<BuildTask, "failCount">,
  kind: "bad" | "unavailable",
  detail: string
): BuildTaskFailureDecision {
  const failCount = (task.failCount ?? 0) + 1;
  const status = failCount < BUILD_TASK_MAX_FAILURES ? "fixing" : "failed";
  const retryDelayMs =
    kind === "unavailable" && status === "fixing"
      ? BUILD_TASK_TRANSIENT_RETRY_DELAYS_MS[
          Math.min(failCount - 1, BUILD_TASK_TRANSIENT_RETRY_DELAYS_MS.length - 1)
        ]
      : undefined;
  const instructionNote =
    kind === "unavailable"
      ? `NOTE: a previous attempt hit a transient provider failure (${detail}). Retry the task from the current project state, inspect any files that may already exist, and continue with the smallest necessary file tool actions.`
      : `NOTE: a previous attempt produced no usable output (${detail}). Do not retry by emitting one large full-file block. Use read_range/search plus patch for existing files; use append chunks with reset=true to create or replace a large/missing file.`;

  return { failCount, status, instructionNote, retryDelayMs };
}

export function normalizeBuildTasksForResume(tasks: BuildTask[]): BuildTask[] {
  return tasks.map((task) => {
    if (task.status === "in_progress" || task.status === "review") {
      return {
        ...task,
        status: "planned",
        workerIndex: undefined,
        retryAfterMs: undefined,
      };
    }

    if (task.status === "failed") {
      return {
        ...task,
        status: "fixing",
        // Resume starts a new retry window; failure history is kept in
        // buildProblems/recovery notes rather than this live retry counter.
        failCount: undefined,
        workerIndex: undefined,
        assignTo: undefined,
        retryAfterMs: undefined,
      };
    }

    return { ...task };
  });
}

export interface BuildQualityGateReopenInput {
  skillEvidence?: SkillEvidence[];
  browserAcceptanceMissing?: boolean;
  browserAcceptanceReason?: string;
  requestFulfillmentMissing?: boolean;
  requestFulfillmentReason?: string;
  maxContextFiles?: number;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value?.trim()))];
}

function isLikelyUiTask(task: BuildTask): boolean {
  const text = [
    task.title,
    task.instructions,
    ...(task.outputPaths ?? []),
    ...task.contextFiles,
  ]
    .join("\n")
    .toLowerCase();
  return /\b(web|browser|ui|frontend|front-end|page|app|game|renderer|canvas)\b/.test(text) ||
    /(^|\/)(app|pages|components|public|src)\/|\.((tsx|jsx|css|scss|html))$/i.test(text);
}

function isLikelyDocumentationTask(task: BuildTask): boolean {
  const text = [
    task.title,
    task.instructions,
    ...(task.outputPaths ?? []),
    ...task.contextFiles,
  ]
    .join("\n")
    .toLowerCase();
  return /\b(readme|docs?|documentation|usage guide|changelog)\b/.test(text) ||
    /(^|\/)(docs?\/|readme(\.|$)|changelog(\.|$))|\.md$/i.test(text);
}

function browserAcceptanceFixInstructions(reason?: string): string {
  return [
    "Real-browser acceptance is missing for this web/UI build.",
    reason?.trim() ? reason.trim() : "",
    "Start or reuse the active local server URL, navigate with the browser MCP, exercise the main workflow, and verify the settled UI.",
    "Report the URL, action performed, expected content visible, no visible stuck loading, no error banner, no blank screen, no blocking overlay, and console result.",
    "Only change files if browser acceptance reveals a defect.",
  ]
    .filter(Boolean)
    .join("\n");
}

function requestFulfillmentFixInstructions(reason?: string): string {
  return [
    "Request fulfillment evidence is missing for this build.",
    reason?.trim() ? reason.trim() : "",
    "Compare the landed output against the original user request, Architect spec, current phase spec, task contracts, changed files, and verification evidence.",
    "Report structured requestFulfillment evidence with reviewed=true, satisfied=true only if the delivered result satisfies the request, a concise summary, evidence, and any gaps.",
    "If the request includes a browser, UI, visual, CLI, API, documentation, repo workflow, or other observable behavior, verify the relevant surface before claiming it is satisfied.",
    "Only change files if the comparison reveals an unmet requirement.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function reopenBuildTasksForQualityGate(
  tasks: BuildTask[],
  input: BuildQualityGateReopenInput
): BuildTask[] {
  const blockingEvidence = getBlockingSkillEvidence(input.skillEvidence ?? []);
  const targetIds = new Set(
    blockingEvidence
      .map((record) => record.taskId)
      .filter((taskId): taskId is string => !!taskId?.trim())
  );

  if (
    (input.browserAcceptanceMissing || input.requestFulfillmentMissing) &&
    targetIds.size === 0
  ) {
    const doneTasks = tasks.filter((task) => task.status === "done");
    const targetTask = input.browserAcceptanceMissing
      ? [...doneTasks].reverse().find(isLikelyUiTask) ??
        [...doneTasks].reverse().find((task) => !isLikelyDocumentationTask(task)) ??
        doneTasks.at(-1) ??
        tasks.at(-1)
      : [...doneTasks].reverse().find((task) => !isLikelyDocumentationTask(task)) ??
        doneTasks.at(-1) ??
        tasks.at(-1);
    if (targetTask) targetIds.add(targetTask.id);
  }

  if (targetIds.size === 0) return tasks.map((task) => ({ ...task }));

  const maxContextFiles = input.maxContextFiles ?? 12;
  return tasks.map((task) => {
    if (!targetIds.has(task.id)) return { ...task };

    const skillInstructions = buildSkillEvidenceFixInstructions(
      blockingEvidence,
      task.id
    );
    const fixInstructions = [
      skillInstructions,
      input.browserAcceptanceMissing
        ? browserAcceptanceFixInstructions(input.browserAcceptanceReason)
        : "",
      input.requestFulfillmentMissing
        ? requestFulfillmentFixInstructions(input.requestFulfillmentReason)
        : "",
    ]
      .filter((part) => part.trim())
      .join("\n\n");
    const note = fixInstructions
      ? `FIX (from final Build quality gate):\n${fixInstructions}`
      : "FIX (from final Build quality gate): address the blocked completion gate.";
    const instructions = task.instructions.includes("FIX (from final Build quality gate):")
      ? task.instructions
      : `${task.instructions}\n\n${note}`;

    return {
      ...task,
      status: "fixing",
      workerIndex: undefined,
      assignTo: undefined,
      retryAfterMs: undefined,
      contextFiles: uniqueStrings([
        ...task.contextFiles,
        ...(task.outputPaths ?? []),
      ]).slice(0, maxContextFiles),
      instructions,
    };
  });
}

export interface BuildQualityGateCheckpointProblemSignal {
  code?: string;
  message?: string;
  details?: string;
}

export interface BuildQualityGateCheckpointReopenInput {
  status?: string;
  stopReason?: string | null;
  recoveryLog?: string[];
  stopMessage?: string | null;
  problems?: BuildQualityGateCheckpointProblemSignal[];
  skillEvidence?: SkillEvidence[];
  maxContextFiles?: number;
}

function checkpointWasBlockedByQualityGate(
  input: BuildQualityGateCheckpointReopenInput
): boolean {
  if (input.status !== "blocked" && input.stopReason !== "blocked") return false;
  const text = [
    input.stopMessage ?? "",
    ...(input.recoveryLog ?? []),
    ...(input.problems ?? []).map((problem) =>
      [problem.code, problem.message, problem.details].filter(Boolean).join(" ")
    ),
  ].join("\n");
  return /final Build quality gate|quality_gate_failed|browser_acceptance_missing|request_fulfillment_missing|request fulfillment|requestFulfillment/i.test(
    text
  );
}

export function reopenBuildTasksForBlockedQualityGateCheckpoint(
  tasks: BuildTask[],
  input: BuildQualityGateCheckpointReopenInput
): BuildTask[] {
  if (!checkpointWasBlockedByQualityGate(input)) {
    return tasks.map((task) => ({ ...task }));
  }

  const browserProblem = (input.problems ?? []).find(
    (problem) => problem.code === "browser_acceptance_missing"
  );
  const requestFulfillmentProblem = (input.problems ?? []).find(
    (problem) => problem.code === "request_fulfillment_missing"
  );
  const stopMessage = input.stopMessage ?? "";
  return reopenBuildTasksForQualityGate(tasks, {
    skillEvidence: input.skillEvidence,
    browserAcceptanceMissing:
      !!browserProblem || /real-browser acceptance|browser acceptance/i.test(stopMessage),
    browserAcceptanceReason:
      browserProblem?.details ?? browserProblem?.message ?? stopMessage,
    requestFulfillmentMissing:
      !!requestFulfillmentProblem ||
      /request fulfillment|requestFulfillment/i.test(stopMessage),
    requestFulfillmentReason:
      requestFulfillmentProblem?.details ??
      requestFulfillmentProblem?.message ??
      stopMessage,
    maxContextFiles: input.maxContextFiles,
  });
}

export interface ReviewTaskFilterResult {
  accepted: PlanAction["tasks"];
  skipped: Array<{
    id: string;
    title: string;
    existingStatus: BuildTaskStatus;
  }>;
}

const TASK_ID_NUMBER_RE = /^T(\d+)(?:\D.*)?$/i;

function buildTaskIdKey(id: string | undefined): string {
  return id?.trim().toLowerCase() ?? "";
}

function numericTaskIdPart(id: string | undefined): number | null {
  const match = id?.trim().match(TASK_ID_NUMBER_RE);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function nextIncrementalBuildTaskNumber(
  tasks: Array<Pick<BuildTask, "id">>
): number {
  let max = 0;
  for (const task of tasks) {
    const value = numericTaskIdPart(task.id);
    if (value != null && value > max) max = value;
  }
  return max + 1;
}

export function nextIncrementalBuildTaskId(
  tasks: Array<Pick<BuildTask, "id">>
): string {
  return `T${nextIncrementalBuildTaskNumber(tasks)}`;
}

export interface IncrementalTaskIdAllocation {
  tasks: PlanAction["tasks"];
  remapped: Array<{
    from: string;
    to: string;
    title: string;
  }>;
  nextNumber: number;
}

export function allocateIncrementalTaskIds(
  existingTasks: Array<Pick<BuildTask, "id">>,
  candidates: PlanAction["tasks"]
): IncrementalTaskIdAllocation {
  const existingIds = new Set(
    existingTasks.map((task) => buildTaskIdKey(task.id)).filter(Boolean)
  );
  const idRemap = new Map<string, string>();
  const remapped: IncrementalTaskIdAllocation["remapped"] = [];
  const allocated: PlanAction["tasks"] = [];
  let nextNumber = nextIncrementalBuildTaskNumber(existingTasks);

  for (const candidate of candidates) {
    let nextId = `T${nextNumber}`;
    while (existingIds.has(buildTaskIdKey(nextId))) {
      nextNumber += 1;
      nextId = `T${nextNumber}`;
    }
    nextNumber += 1;
    existingIds.add(buildTaskIdKey(nextId));

    const originalId = candidate.id?.trim();
    if (originalId && originalId !== nextId) {
      remapped.push({ from: originalId, to: nextId, title: candidate.title });
    }
    const originalKey = buildTaskIdKey(originalId);
    if (originalKey && !idRemap.has(originalKey) && !existingIds.has(originalKey)) {
      idRemap.set(originalKey, nextId);
    }
    allocated.push({ ...candidate, id: nextId });
  }

  const tasks = allocated.map((task) => {
    if (!Array.isArray(task.dependsOn) || task.dependsOn.length === 0) {
      return task;
    }
    const dependsOn: string[] = [];
    for (const rawDep of task.dependsOn) {
      if (typeof rawDep !== "string") continue;
      const dep = rawDep.trim();
      if (!dep) continue;
      const depKey = buildTaskIdKey(dep);
      const target = idRemap.get(depKey) ?? dep;
      if (target === task.id || dependsOn.includes(target)) continue;
      dependsOn.push(target);
    }
    return { ...task, dependsOn };
  });

  return { tasks, remapped, nextNumber };
}

export function filterNovelReviewTasks(
  existingTasks: Pick<BuildTask, "id" | "title" | "status" | "outputPaths">[],
  candidates: PlanAction["tasks"]
): ReviewTaskFilterResult {
  const existingByOutputPath = new Map<
    string,
    { title: string; status: BuildTaskStatus }
  >();
  for (const task of existingTasks) {
    if (task.status === "done") continue;
    for (const outputPath of task.outputPaths ?? []) {
      const normalized = outputPath.trim().replace(/\\/g, "/").toLowerCase();
      if (normalized) {
        existingByOutputPath.set(normalized, {
          title: task.title,
          status: task.status,
        });
      }
    }
  }
  const accepted: PlanAction["tasks"] = [];
  const skipped: ReviewTaskFilterResult["skipped"] = [];
  for (const candidate of candidates) {
    const id = candidate.id?.trim();
    const duplicateOutput = (candidate.outputPaths ?? [])
      .map((path) => path.trim().replace(/\\/g, "/").toLowerCase())
      .filter(Boolean)
      .map((path) => existingByOutputPath.get(path))
      .find((match): match is { title: string; status: BuildTaskStatus } => !!match);
    if (duplicateOutput) {
      skipped.push({
        id: id || "(unassigned)",
        title: duplicateOutput.title,
        existingStatus: duplicateOutput.status,
      });
      continue;
    }
    accepted.push(candidate);
    for (const outputPath of candidate.outputPaths ?? []) {
      const normalized = outputPath.trim().replace(/\\/g, "/").toLowerCase();
      if (normalized) {
        existingByOutputPath.set(normalized, {
          title: candidate.title,
          status: "planned",
        });
      }
    }
  }
  return { accepted, skipped };
}

export function shouldApplyReviewResultToTask(
  task: Pick<BuildTask, "status"> | null | undefined
): boolean {
  return task?.status === "review";
}

export interface BalancedWorkerSelectionInput {
  activeWorkerIndexes: number[];
  assignmentCounts: Map<number, number>;
  assignCursor: number;
  pinnedIndex?: number | null;
  requestedIndex?: number | null;
  avoidWorkerIndexes?: number[];
}

export interface BalancedWorkerSelectionResult {
  index: number;
  assignCursor: number;
  honoredPinned: boolean;
  honoredRequest: boolean;
}

export function selectBalancedWorkerIndex(
  input: BalancedWorkerSelectionInput
): BalancedWorkerSelectionResult {
  const active = input.activeWorkerIndexes;
  if (active.length === 0) {
    throw new Error("Cannot assign a build task without an active worker.");
  }
  const activeSet = new Set(active);
  const assign = (
    index: number,
    assignCursor: number,
    honoredPinned: boolean,
    honoredRequest: boolean
  ): BalancedWorkerSelectionResult => {
    input.assignmentCounts.set(index, (input.assignmentCounts.get(index) ?? 0) + 1);
    return { index, assignCursor, honoredPinned, honoredRequest };
  };

  if (input.pinnedIndex != null && activeSet.has(input.pinnedIndex)) {
    return assign(input.pinnedIndex, input.assignCursor, true, false);
  }

  const avoidSet = new Set(input.avoidWorkerIndexes ?? []);
  const preferredActive = active.filter((index) => !avoidSet.has(index));
  const assignable = preferredActive.length > 0 ? preferredActive : active;
  const assignableSet = new Set(assignable);
  const minAssigned = Math.min(
    ...assignable.map((index) => input.assignmentCounts.get(index) ?? 0)
  );
  const requestedCount =
    input.requestedIndex != null
      ? input.assignmentCounts.get(input.requestedIndex) ?? 0
      : Number.POSITIVE_INFINITY;
  if (
    input.requestedIndex != null &&
    assignableSet.has(input.requestedIndex) &&
    requestedCount <= minAssigned
  ) {
    return assign(input.requestedIndex, input.assignCursor, false, true);
  }

  const eligible = assignable.filter(
    (index) => (input.assignmentCounts.get(index) ?? 0) === minAssigned
  );
  const chosen = eligible[input.assignCursor % eligible.length] ?? assignable[0];
  return assign(chosen, input.assignCursor + 1, false, false);
}

function uniqueWorkerIndexes(values: Array<number | undefined | null>): number[] {
  return [
    ...new Set(
      values.filter(
        (value): value is number =>
          typeof value === "number" &&
          Number.isInteger(value) &&
          value >= 0
      )
    ),
  ];
}

export function buildReviewFixTaskUpdate(
  task: BuildTask,
  fixInstructions: string | undefined,
  priorFiles: string[],
  maxContextFiles: number,
  options?: { avoidWorkerIndex?: number | null }
): BuildTask {
  const contextFiles = [
    ...new Set([...task.contextFiles, ...priorFiles]),
  ].slice(0, maxContextFiles);
  const avoidWorkerIndexes = uniqueWorkerIndexes([
    ...(task.avoidWorkerIndexes ?? []),
    options?.avoidWorkerIndex,
  ]);
  return {
    ...task,
    status: "fixing",
    workerIndex: undefined,
    assignTo: undefined,
    retryAfterMs: undefined,
    avoidWorkerIndexes: avoidWorkerIndexes.length > 0 ? avoidWorkerIndexes : undefined,
    contextFiles,
    instructions: `${task.instructions}\n\nFIX (from the Architect's review): ${
      fixInstructions ?? "address the review feedback"
    }`,
  };
}

export interface BuildReviewFixProblem {
  code: "review_fix_required";
  message: string;
  details: string;
}

export function buildReviewFixProblem(input: {
  taskId: string;
  taskTitle: string;
  reviewerName: string;
  result: ReviewResult;
}): BuildReviewFixProblem {
  const fixInstructions = buildReviewGateFixInstructions(input.result);
  const verdicts = [
    `spec=${input.result.specVerdict}`,
    `quality=${input.result.qualityVerdict}`,
  ].join(", ");
  return {
    code: "review_fix_required",
    message: `${input.reviewerName} requested fixes for ${input.taskId} (${input.taskTitle}); ${verdicts}.`,
    details: fixInstructions || "Review returned a fix verdict without detailed instructions.",
  };
}

// ── Architect action protocol ─────────────────────────────────────────────────

export interface ReadAction {
  action: "read";
  paths: string[];
}

/** Read a bounded line range from a single project file. */
export interface ReadRangeAction {
  action: "read_range";
  path: string;
  startLine: number;
  lineCount: number;
}

/** Retrieve bounded exact text from a stored context blob by ctx_ ref. */
export interface ContextRetrieveAction {
  action: "context_retrieve";
  ref: string;
  maxTokens?: number;
  offsetChars?: number;
  reason?: string;
}

export interface GuidanceRequestAction {
  action: "guidance_request";
  mode: "blocking" | "async";
  question: string;
  reason?: string;
}

export interface GuidanceAnswerAction {
  action: "guidance_answer";
  guidanceId: string;
  taskId: string;
  answer: string;
  memory?: string;
}

export interface SpecAction {
  action: "spec";
  spec: BuildSpec;
  notes?: string;
  verifyCommand?: string;
}

export interface PlanAction {
  action: "plan";
  /** Compact contract for the current build wave. */
  phaseSpec?: BuildPhaseSpec;
  tasks: Array<{
    id?: string;
    title: string;
    instructions: string;
    kind?: BuildTaskKind;
    completionMode?: BuildTaskCompletionMode;
    verificationPolicy?: BuildTaskVerificationPolicy;
    requiredEvidence?: string[];
    /**
     * Binding implementation details chosen by the Architect so cheaper workers
     * execute a narrow slice instead of inventing architecture.
     */
    implementationContract?: string;
    contextFiles?: string[];
    outputPaths?: string[];
    expectedOutputs?: string;
    dependsOn?: string[];
    /** Optional: pin this task to a worker by display name (e.g. the best
     * performer for a hard task). The engine matches it case-insensitively. */
    assignTo?: string;
    /** Optional 1-5 difficulty rating used to weight model performance. */
    difficulty?: number;
  }>;
  notes?: string;
  /**
   * Optional shell command that compiles/type-checks the project, run by the
   * engine automatically each wave (when a runner is connected) as a
   * mechanical backstop — its output goes into the review so broken code is
   * caught regardless of language. The Architect knows the stack, so it sets
   * this (e.g. "dotnet build", "go build ./...", "cargo check",
   * "npx tsc --noEmit"). Omit / "" when there's nothing meaningful to run.
   */
  verifyCommand?: string;
}

export interface BuildPlanAction {
  action: "build_plan";
  /** The Architect spec this task graph implements. */
  spec?: BuildSpec;
  /** Compact contract for this implementation wave. */
  phaseSpec?: BuildPhaseSpec;
  /** Human-readable implementation sequence and integration strategy. */
  implementationPlan?: string;
  tasks: PlanAction["tasks"];
  notes?: string;
  verifyCommand?: string;
}

export type BuildPlanningAction = PlanAction | BuildPlanAction;
export type ArchitectTerminalAction = "spec" | "build_plan" | "plan" | "review";

export type ReviewGateVerdict = "approve" | "fix";

export interface ReviewResult {
  taskId: string;
  /** Backward-compatible aggregate verdict. Derived from the two gates. */
  verdict?: ReviewGateVerdict;
  specVerdict: ReviewGateVerdict;
  qualityVerdict: ReviewGateVerdict;
  specIssues?: string;
  qualityIssues?: string;
  fixInstructions?: string;
}

export interface RequestFulfillmentReview {
  reviewed: boolean;
  satisfied: boolean;
  summary?: string;
  evidence?: string[];
  gaps?: string[];
}

export interface ReviewAction {
  action: "review";
  results: ReviewResult[];
  newTasks?: PlanAction["tasks"];
  /** Optional next phase spec for newly planned follow-up tasks. */
  phaseSpec?: BuildPhaseSpec;
  /**
   * Optional replacement for the automated verifier. Use when review evidence
   * shows the current verifier is wrong for the stack, or "" when no meaningful
   * non-mutating verifier exists for the current project.
   */
  verifyCommand?: string;
  /** Explicit review that the landed output still satisfies the user's request. */
  requestFulfillment?: RequestFulfillmentReview;
  done: boolean;
  notes?: string;
}

const stringSchema = (description?: string): JsonSchemaObject => ({
  type: "string",
  ...(description ? { description } : {}),
});

const stringArraySchema = (description?: string): JsonSchemaObject => ({
  type: "array",
  ...(description ? { description } : {}),
  items: { type: "string" },
});

function stringArrayFromUnknown(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeRequestFulfillmentReview(
  value: unknown
): RequestFulfillmentReview | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  return {
    reviewed: raw.reviewed === true,
    satisfied: raw.satisfied === true,
    ...(stringFromUnknown(raw.summary) ? { summary: stringFromUnknown(raw.summary) } : {}),
    ...(stringArrayFromUnknown(raw.evidence).length
      ? { evidence: stringArrayFromUnknown(raw.evidence) }
      : {}),
    ...(stringArrayFromUnknown(raw.gaps).length
      ? { gaps: stringArrayFromUnknown(raw.gaps) }
      : {}),
  };
}

export function normalizeBuildPhaseSpec(value: unknown): BuildPhaseSpec | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const objective = stringFromUnknown(raw.objective);
  if (!objective) return undefined;
  const id = stringFromUnknown(raw.id) ?? "P1";
  return {
    id,
    objective,
    acceptanceCriteria: stringArrayFromUnknown(raw.acceptanceCriteria),
    qualityCriteria: stringArrayFromUnknown(raw.qualityCriteria),
    verification: stringArrayFromUnknown(raw.verification),
    ...(stringArrayFromUnknown(raw.constraints).length
      ? { constraints: stringArrayFromUnknown(raw.constraints) }
      : {}),
  };
}

export function normalizeBuildSpec(value: unknown): BuildSpec | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const phaseSpec = normalizeBuildPhaseSpec(raw);
  if (!phaseSpec) return undefined;
  const requirements = stringArrayFromUnknown(raw.requirements);
  if (requirements.length === 0) return undefined;
  const id = stringFromUnknown(raw.id) ?? "S1";
  return {
    ...phaseSpec,
    id,
    requirements,
    ...(stringArrayFromUnknown(raw.nonGoals).length
      ? { nonGoals: stringArrayFromUnknown(raw.nonGoals) }
      : {}),
    ...(stringArrayFromUnknown(raw.implementationDecisions).length
      ? { implementationDecisions: stringArrayFromUnknown(raw.implementationDecisions) }
      : {}),
    ...(stringArrayFromUnknown(raw.risks).length
      ? { risks: stringArrayFromUnknown(raw.risks) }
      : {}),
  };
}

function normalizeReviewGateVerdict(value: unknown): ReviewGateVerdict | undefined {
  return value === "approve" || value === "fix" ? value : undefined;
}

export function normalizeReviewResult(value: unknown): ReviewResult | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const taskId = stringFromUnknown(raw.taskId);
  if (!taskId) return null;
  const legacyVerdict = normalizeReviewGateVerdict(raw.verdict);
  const specVerdict =
    normalizeReviewGateVerdict(raw.specVerdict) ?? legacyVerdict ?? "fix";
  const qualityVerdict =
    normalizeReviewGateVerdict(raw.qualityVerdict) ?? legacyVerdict ?? "fix";
  return {
    taskId,
    specVerdict,
    qualityVerdict,
    verdict:
      specVerdict === "approve" && qualityVerdict === "approve"
        ? "approve"
        : "fix",
    ...(stringFromUnknown(raw.specIssues)
      ? { specIssues: stringFromUnknown(raw.specIssues) }
      : {}),
    ...(stringFromUnknown(raw.qualityIssues)
      ? { qualityIssues: stringFromUnknown(raw.qualityIssues) }
      : {}),
    ...(stringFromUnknown(raw.fixInstructions)
      ? { fixInstructions: stringFromUnknown(raw.fixInstructions) }
      : {}),
  };
}

export function isReviewResultApproved(
  result: Pick<ReviewResult, "specVerdict" | "qualityVerdict">
): boolean {
  return result.specVerdict === "approve" && result.qualityVerdict === "approve";
}

export function buildReviewGateFixInstructions(result: ReviewResult): string {
  const sections = [
    result.specVerdict === "fix"
      ? `Spec-compliance issues: ${
          result.specIssues?.trim() ||
          "Review did not approve the implementation against the phase spec."
        }`
      : "",
    result.qualityVerdict === "fix"
      ? `Code-quality issues: ${
          result.qualityIssues?.trim() ||
          "Review did not approve the code-quality gate."
        }`
      : "",
    result.fixInstructions?.trim()
      ? `Fix instructions: ${result.fixInstructions.trim()}`
      : "",
  ].filter(Boolean);
  return sections.join("\n");
}

const buildTaskActionSchema = (): JsonSchemaObject => ({
  type: "object",
  properties: {
    id: stringSchema("Optional model-local task id. The engine assigns the final incremental T<number> id."),
    title: stringSchema("Short task title."),
    instructions: stringSchema("Concrete implementation instructions."),
    kind: {
      type: "string",
      enum: ["modify", "audit", "verify", "repo"],
      description:
        "Task intent: modify writes files, audit inspects/reports current state, verify gathers acceptance evidence, repo performs repository workflow.",
    },
    completionMode: {
      type: "string",
      enum: ["files", "evidence", "either"],
      description:
        "Completion contract. files requires landed files; evidence allows no-file completion with substantive evidence; either accepts files or evidence.",
    },
    verificationPolicy: {
      type: "string",
      enum: ["architect", "tool", "external", "none"],
      description:
        "Verification owner. Use architect when Architect review is sufficient; tool only when a command/browser/tool result is required.",
    },
    requiredEvidence: stringArraySchema(
      "Concrete evidence expected when no files land or when completionMode is evidence/either."
    ),
    implementationContract: stringSchema(
      "Binding Architect-owned implementation contract: APIs, file boundaries, state shape, edge cases, and verification evidence the worker must follow."
    ),
    contextFiles: stringArraySchema("Files the worker should inspect."),
    outputPaths: stringArraySchema("Files this task may create or modify."),
    expectedOutputs: stringSchema("Expected completion signal."),
    dependsOn: stringArraySchema("Task ids that must complete first."),
    assignTo: stringSchema("Optional worker display-name preference."),
    difficulty: {
      type: "number",
      description: "Task difficulty from 1 to 5.",
    },
  },
  required: ["title", "instructions"],
  additionalProperties: false,
});

const buildPhaseSpecSchema = (): JsonSchemaObject => ({
  type: "object",
  properties: {
    id: stringSchema("Short stable phase id such as P1."),
    objective: stringSchema("Current phase objective."),
    acceptanceCriteria: stringArraySchema("Spec-compliance criteria for this phase."),
    qualityCriteria: stringArraySchema("Code-quality criteria for this phase."),
    verification: stringArraySchema("Commands or evidence expected for this phase."),
    constraints: stringArraySchema("Constraints that workers and reviewers must preserve."),
  },
  required: ["objective", "acceptanceCriteria", "qualityCriteria", "verification"],
  additionalProperties: false,
});

const buildSpecSchema = (): JsonSchemaObject => ({
  type: "object",
  properties: {
    ...buildPhaseSpecSchema().properties,
    requirements: stringArraySchema("Concrete requirements the implementation must satisfy."),
    nonGoals: stringArraySchema("Explicitly excluded scope."),
    implementationDecisions: stringArraySchema(
      "Architect-owned design decisions that must be preserved by the build plan."
    ),
    risks: stringArraySchema("Known risks and edge cases the plan must cover or call out."),
  },
  required: [
    "objective",
    "requirements",
    "acceptanceCriteria",
    "qualityCriteria",
    "verification",
  ],
  additionalProperties: false,
});

/**
 * Bounds for a worker `split_task` decomposition (see {@link SplitTaskAction}).
 * Declared here (ahead of the schema and tool descriptions that interpolate
 * them at module load) so every site — schema, prompt text, validator — derives
 * the same numbers.
 */
const SPLIT_MIN_SUBTASKS = 2;
const SPLIT_MAX_SUBTASKS = 4;

/**
 * JSON schema for the Build Architect protocol. It is intentionally a single
 * object shape with an `action` discriminator instead of a root union, because
 * provider schema subsets vary. The existing parser remains the final validator.
 */
export function buildArchitectActionResponseFormat(): StructuredOutputFormat {
  const taskSchema = buildTaskActionSchema();
  const phaseSpecSchema = buildPhaseSpecSchema();
  const specSchema = buildSpecSchema();
  return {
    name: "architect_action",
    strict: false,
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "read",
            "read_range",
            "context_retrieve",
            "guidance_request",
            "guidance_answer",
            "code_intel",
            "spec",
            "build_plan",
            "plan",
            "review",
            "run",
            "search",
            "tool",
            "fetch",
            "skill_request",
            "patch",
            "append",
            "repo_status",
            "repo_diff",
            "repo_init",
            "repo_branch_create",
            "repo_commit",
            "repo_issue_list",
            "repo_milestone_create",
            "repo_issue_create",
            "repo_issue_read",
            "repo_push",
            "repo_pr_create",
          ],
          // split_task and guidance_request are worker-only; guidance_answer is for the focused Architect guidance prompt. Shared fields live here because the parser uses one protocol schema.
          description: "Architect action discriminator.",
        },
        paths: stringArraySchema("Paths for read or repo_commit actions."),
        path: stringSchema("Single file path for range, patch, or append actions."),
        ref: stringSchema("ctx_ reference for context_retrieve actions."),
        maxTokens: {
          type: "number",
          description: "Bounded token cap for context_retrieve.",
        },
        offsetChars: {
          type: "number",
          description: "Optional character offset for paging through a context blob.",
        },
        op: {
          type: "string",
          enum: [
            "architecture",
            "search_symbols",
            "trace_symbol",
            "detect_change_impact",
          ],
          description: "Code intelligence operation.",
        },
        startLine: { type: "number" },
        lineCount: { type: "number" },
        spec: specSchema,
        phaseSpec: phaseSpecSchema,
        tasks: { type: "array", items: taskSchema },
        implementationPlan: stringSchema(
          "Architect-owned implementation sequence and integration strategy."
        ),
        notes: stringSchema("Brief persistent Architect notes."),
        verifyCommand: stringSchema("Optional mechanical verification command."),
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              taskId: stringSchema("Task id being reviewed."),
              verdict: { type: "string", enum: ["approve", "fix"] },
              specVerdict: { type: "string", enum: ["approve", "fix"] },
              qualityVerdict: { type: "string", enum: ["approve", "fix"] },
              specIssues: stringSchema("Spec-compliance issues when specVerdict is fix."),
              qualityIssues: stringSchema("Code-quality issues when qualityVerdict is fix."),
              fixInstructions: stringSchema("Instructions for a fix round."),
            },
            required: ["taskId"],
            additionalProperties: false,
          },
        },
        requestFulfillment: {
          type: "object",
          description:
            "Explicit comparison of landed output against the original user request.",
          properties: {
            reviewed: {
              type: "boolean",
              description:
                "True only when the reviewer compared the landed output to the original user request and active spec.",
            },
            satisfied: {
              type: "boolean",
              description:
                "True only when the delivered result satisfies the user request with no known blocking gaps.",
            },
            summary: stringSchema("Concise fulfillment conclusion."),
            evidence: stringArraySchema(
              "Concrete files, checks, browser observations, CLI/API behavior, docs, or repo workflow evidence reviewed."
            ),
            gaps: stringArraySchema(
              "Unmet user requirements or missing evidence; empty when satisfied is true."
            ),
          },
          required: ["reviewed", "satisfied"],
          additionalProperties: false,
        },
        newTasks: { type: "array", items: taskSchema },
        done: { type: "boolean" },
        command: stringSchema("Shell command to run."),
        reason: stringSchema("Short reason for the requested action."),
        guidanceId: stringSchema("Guidance request id being answered."),
        taskId: stringSchema("Task id for a guidance answer."),
        question: stringSchema("Worker guidance question."),
        answer: stringSchema("Architect guidance answer."),
        memory: stringSchema(
          "Optional promoted build convention when the answer applies beyond this task."
        ),
        query: stringSchema("Search query."),
        symbol: stringSchema("Symbol name for code_intel trace_symbol."),
        server: stringSchema("MCP server name."),
        tool: stringSchema("MCP tool name."),
        args: {
          type: "object",
          description: "MCP tool arguments.",
          additionalProperties: true,
        },
        url: stringSchema("Public http(s) URL to fetch."),
        ids: stringArraySchema("Skill ids for skill_request actions."),
        target: {
          type: "string",
          enum: ["architect", "next_worker", "reviewer"],
          description: "Actor that should receive requested skills.",
        },
        mode: {
          type: "string",
          enum: ["compact", "full", "blocking", "async"],
          description: "Requested skill overlay detail or guidance request mode.",
        },
        ops: {
          type: "array",
          items: {
            type: "object",
            properties: {
              search: stringSchema("Exact existing text."),
              replace: stringSchema("Replacement text."),
            },
            required: ["search", "replace"],
            additionalProperties: false,
          },
        },
        content: stringSchema("Append content."),
        reset: { type: "boolean" },
        staged: { type: "boolean" },
        stat: { type: "boolean" },
        name: stringSchema("Branch name."),
        base: stringSchema("Base branch."),
        checkout: { type: "boolean" },
        message: stringSchema("Commit message."),
        repo: stringSchema("GitHub owner/repo slug."),
        labels: stringArraySchema("GitHub labels."),
        limit: { type: "number" },
        title: stringSchema("Issue, milestone, or PR title."),
        body: stringSchema("Issue or PR body."),
        milestone: stringSchema("GitHub milestone title."),
        issue: { type: "number" },
        remote: stringSchema("Git remote."),
        branch: stringSchema("Git branch."),
        setUpstream: { type: "boolean" },
        head: stringSchema("PR head branch."),
        draft: { type: "boolean" },
        subtasks: {
          type: "array",
          description: "Subtasks for a worker split_task action.",
          minItems: SPLIT_MIN_SUBTASKS,
          maxItems: SPLIT_MAX_SUBTASKS,
          items: {
            type: "object",
            properties: {
              title: stringSchema("Short subtask title."),
              instructions: stringSchema("Complete self-contained instructions."),
              contextFiles: stringArraySchema("Existing files the subtask must see."),
              outputPaths: stringArraySchema("Files this subtask owns exclusively."),
              dependsOn: stringArraySchema(
                'Earlier sibling ordinals ("1", "2", ...) this subtask depends on.'
              ),
              difficulty: { type: "number", description: "Subtask difficulty 1-5." },
            },
            required: ["title", "instructions", "outputPaths"],
            additionalProperties: false,
          },
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };
}

type NativeBuildToolProfile =
  | "architect_plan"
  | "architect_review"
  | "worker";

const NATIVE_BUILD_TOOL_DESCRIPTIONS: Record<string, string> = {
  read: "Read one or more small project files.",
  read_range: "Read a bounded line range from one project file.",
  context_retrieve: "Retrieve exact text from a previously compacted context blob.",
  code_intel: "Run read-only structural code intelligence.",
  spec: "Return the Architect-owned requirements and quality specification.",
  build_plan: "Return the Architect implementation plan from an approved spec.",
  plan: "Return the Architect implementation plan.",
  review: "Return the Architect review verdict for completed worker tasks.",
  run: "Run a bounded project check command through the AI Board runner.",
  search: "Search project text.",
  tool: "Call an MCP tool exposed through the local runner.",
  fetch: "Fetch a known public http(s) URL through the local runner.",
  skill_request: "Request an AI Board skill overlay for a future Build turn.",
  guidance_request: "Ask the Architect a task-local advisory question.",
  patch: "Apply exact SEARCH/REPLACE operations to one existing file.",
  append: "Create or append a bounded content chunk to a project file.",
  repo_status: "Inspect the Git working tree status through the runner.",
  repo_diff: "Inspect a bounded Git diff through the runner.",
  repo_init: "Initialize a Git repository in the runner folder.",
  repo_branch_create: "Create and optionally check out a Git branch through the runner.",
  repo_commit: "Stage and commit changes through the runner after approval.",
  repo_issue_list: "List open GitHub issues through the runner.",
  repo_milestone_create: "Create a GitHub milestone through the runner.",
  repo_issue_create: "Create a GitHub issue through the runner.",
  repo_issue_read: "Read a GitHub issue through the runner.",
  repo_push: "Push a branch through the runner after approval.",
  repo_pr_create: "Open a GitHub pull request through the runner after approval.",
  split_task: `End your turn by splitting this oversized task into ${SPLIT_MIN_SUBTASKS}-${SPLIT_MAX_SUBTASKS} subtasks.`,
};

const ARCHITECT_PLAN_NATIVE_ACTIONS = [
  "read",
  "read_range",
  "context_retrieve",
  "code_intel",
  "spec",
  "build_plan",
  "plan",
  "run",
  "search",
  "tool",
  "fetch",
  "skill_request",
  "patch",
  "append",
  "repo_status",
  "repo_diff",
  "repo_init",
  "repo_branch_create",
  "repo_commit",
  "repo_issue_list",
  "repo_milestone_create",
  "repo_issue_create",
  "repo_issue_read",
  "repo_push",
  "repo_pr_create",
] as const;

const ARCHITECT_REVIEW_NATIVE_ACTIONS = [
  "read",
  "read_range",
  "context_retrieve",
  "code_intel",
  "review",
  "run",
  "search",
  "tool",
  "fetch",
  "skill_request",
  "patch",
  "append",
  "repo_status",
  "repo_diff",
  "repo_init",
  "repo_branch_create",
  "repo_commit",
  "repo_issue_list",
  "repo_milestone_create",
  "repo_issue_create",
  "repo_issue_read",
  "repo_push",
  "repo_pr_create",
] as const;

const WORKER_NATIVE_ACTIONS = [
  "read",
  "read_range",
  "context_retrieve",
  "code_intel",
  "guidance_request",
  "search",
  "patch",
  "append",
  "run",
  "tool",
  "fetch",
  "split_task",
] as const;

const NATIVE_BUILD_TOOL_REQUIRED: Record<string, string[]> = {
  read: ["paths"],
  read_range: ["path", "startLine", "lineCount"],
  context_retrieve: ["ref"],
  guidance_request: ["question"],
  guidance_answer: ["guidanceId", "taskId", "answer"],
  code_intel: ["op"],
  spec: ["spec"],
  build_plan: ["tasks"],
  plan: ["tasks"],
  review: ["results", "done"],
  run: ["command"],
  search: ["query"],
  tool: ["server", "tool"],
  fetch: ["url"],
  skill_request: ["ids", "reason"],
  patch: ["path", "ops"],
  append: ["path", "content"],
  repo_branch_create: ["name"],
  repo_commit: ["message"],
  repo_issue_list: ["repo"],
  repo_milestone_create: ["repo", "title"],
  repo_issue_create: ["repo", "title", "body"],
  repo_issue_read: ["repo", "issue"],
  repo_push: ["branch"],
  repo_pr_create: ["title", "body"],
  split_task: ["reason", "subtasks"],
};

function nativeActionNames(profile: NativeBuildToolProfile): readonly string[] {
  if (profile === "architect_plan") return ARCHITECT_PLAN_NATIVE_ACTIONS;
  if (profile === "architect_review") return ARCHITECT_REVIEW_NATIVE_ACTIONS;
  return WORKER_NATIVE_ACTIONS;
}

export function buildNativeBuildToolDefinitions(
  profile: NativeBuildToolProfile
): NativeToolDefinition[] {
  const schema = buildArchitectActionResponseFormat().schema;
  const properties = schema.properties ?? {};
  return nativeActionNames(profile).map((action) => {
    const toolProperties = Object.fromEntries(
      Object.entries(properties).filter(([key]) => key !== "action")
    );
    return {
      name: action,
      description:
        NATIVE_BUILD_TOOL_DESCRIPTIONS[action] ??
        `Run the AI Board Build action "${action}".`,
      parameters: {
        type: "object",
        properties: toolProperties,
        required: NATIVE_BUILD_TOOL_REQUIRED[action] ?? [],
        additionalProperties: false,
      },
      strict: false,
    };
  });
}

function parseNativeToolArguments(call: NativeToolCall): Record<string, unknown> {
  if (
    call.arguments &&
    typeof call.arguments === "object" &&
    Object.keys(call.arguments).length > 0
  ) {
    return call.arguments;
  }
  if (!call.argumentsJson?.trim()) return {};
  try {
    const parsed = JSON.parse(call.argumentsJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function nativeToolCallsToActionText(calls: NativeToolCall[]): string {
  return calls
    .map((call) =>
      JSON.stringify({
        action: call.name,
        ...parseNativeToolArguments(call),
      })
    )
    .join("\n");
}

/**
 * Best-guess build/check command for a project from its manifest files —
 * a language-agnostic fallback used when the Architect doesn't declare a
 * verifyCommand. Returns "" when no confident command applies: languages
 * whose check is per-file (PHP `php -l`, Ruby `ruby -c`), build systems with
 * platform-specific wrappers (gradlew vs gradlew.bat), and bare package.json
 * projects are left to the Architect's explicit verifyCommand. Compiled
 * languages are checked first; `files` are project-relative paths.
 */
export function mergeNativeToolActionContent(input: {
  content: string;
  nativeActionContent: string;
  actionText: string;
}): { content: string; nativeActionContent: string } {
  const actionText = input.actionText.trim();
  if (!actionText) {
    return {
      content: input.content,
      nativeActionContent: input.nativeActionContent,
    };
  }
  const nativeActionContent = input.nativeActionContent
    ? `${input.nativeActionContent}\n${actionText}`
    : actionText;
  return {
    content: nativeActionContent,
    nativeActionContent,
  };
}

export function detectVerifyCommand(files: string[]): string {
  const hasRoot = (re: RegExp) =>
    normalizedProjectFiles(files).some((file) => !file.includes("/") && re.test(file));
  if (hasRoot(/^go\.mod$/)) return "go build ./...";
  if (hasRoot(/^cargo\.toml$/)) return "cargo check";
  if (hasRoot(/\.(?:csproj|fsproj|sln)$/)) return "dotnet build";
  if (hasRoot(/^pom\.xml$/)) return "mvn -q -DskipTests compile";
  if (hasRoot(/^mix\.exs$/)) return "mix compile";
  // C/C++: configure into a scratch dir, then build (&& works in cmd and sh).
  if (hasRoot(/^cmakelists\.txt$/))
    return "cmake -S . -B .verify-build && cmake --build .verify-build";
  if (hasRoot(/^makefile$/)) return "make";
  if (hasRoot(/^tsconfig\.json$/)) return "npx --yes tsc --noEmit";
  // Python: stdlib byte-compile catches syntax errors; no deps assumed.
  if (hasRoot(/\.py$/)) return "python -m compileall -q .";
  return "";
}

export function resolveRunnerProjectTree(input: {
  browserTree: string[];
  runnerTree: string[] | null | undefined;
}): string[] {
  return [...new Set(input.runnerTree ?? input.browserTree)];
}

/** A compact worker-performance line for the prompt scoreboard. */
export function scoreboardSection(scoreboard?: string): string {
  return scoreboard?.trim()
    ? `Worker performance so far (the engine tracks this automatically from your approve/fix verdicts, failures, and output speed relative to the other workers — higher score = more reliable). Use assignTo sparingly as a worker preference only when a task truly needs that model; otherwise omit it so the engine balances work across the selected workers. Benched workers won't be given tasks:\n${scoreboard}`
    : "";
}

export interface BuildWorkerCapabilitySummary {
  name: string;
  capabilities?: ModelCapabilities | null;
}

function supportedCapabilityLabels(
  capabilities: ModelCapabilities | null | undefined
): string {
  if (!capabilities) return "capabilities unknown";
  const labels: Record<CapabilityInputType, string> = {
    image: "image input",
    document: "document input",
    audio: "audio input",
    video: "video input",
  };
  const supported = (Object.keys(labels) as CapabilityInputType[]).filter(
    (type) => capabilities[type]
  );
  return supported.length > 0
    ? supported.map((type) => labels[type]).join(", ")
    : "text only; no image input, document input, audio input, or video input";
}

export function workerCapabilityRosterSection(
  workers?: BuildWorkerCapabilitySummary[]
): string {
  if (!workers || workers.length === 0) return "";
  const lines = workers.map(
    (worker) => `- ${worker.name}: ${supportedCapabilityLabels(worker.capabilities)}`
  );
  return [
    "Worker input capabilities:",
    ...lines,
    "Routing rule: assign raw image, document, audio, or video inspection tasks to a worker that supports the needed input type. If no worker supports the needed raw input, inspect the media yourself as Architect and pass concise text findings/evidence in the task instructions and implementationContract for a text-only worker.",
  ].join("\n");
}

/** Run a shell command in the project folder via the user's local runner. */
export interface RunAction {
  action: "run";
  command: string;
  reason?: string;
}

export interface RunCommandSafety {
  allowed: boolean;
  reason?: string;
}

// Shared run-command pools are runaway-loop stops, NOT cost controls: the
// USD/time budget window governs spend. Per-worker run budgets can sum above
// the phase pool; the scheduler caps workers by the shared remaining pool and
// escalates back to the Architect when normal runs are exhausted.
export const RUNS_PER_PHASE = 120;
export const TOTAL_RUNS = 500;

export function classifyRunCommand(command: string): RunCommandSafety {
  const trimmed = command.trim();
  if (!trimmed) return { allowed: false, reason: "Empty commands are not allowed." };

  const checks: Array<[RegExp, string]> = [
    [/\bfs\.(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|truncate|truncateSync|rm|rmSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|mkdir|mkdirSync|rmdir|rmdirSync)\b/i, "Node fs write/delete APIs bypass the patch system."],
    [/\brequire\(["']fs["']\)\.(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|truncate|truncateSync|rm|rmSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|mkdir|mkdirSync|rmdir|rmdirSync)\b/i, "Node fs write/delete APIs bypass the patch system."],
    [/(?:^|[\s;|&])(?:set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item)\b/i, "PowerShell file mutation commands bypass the patch system."],
    [/(?:^|[\s;|&])(?:rm|del|erase|move|mv|cp|copy|ren|rename|mkdir|rmdir)\b/i, "Shell file mutation commands bypass the patch system."],
    [/(?:^|[\s;|&])(?:sed\s+-i|perl\s+-pi)\b/i, "In-place editing commands bypass the patch system."],
    [/(?:^|\s)(?:\d?>|>>)\s*\S/, "Shell redirection writes files outside the patch system."],
  ];

  for (const [pattern, reason] of checks) {
    if (pattern.test(trimmed)) return { allowed: false, reason };
  }

  return { allowed: true };
}

const WINDOWS_UNAVAILABLE_VERIFY_COMMANDS = [
  "test",
  "[",
  "grep",
  "sed",
  "awk",
  "cat",
  "ls",
  "find",
] as const;

function findWindowsUnavailableVerifyCommand(command: string): string | null {
  const parts = command
    .split(/(?:&&|\|\||[;|])/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts) {
    const first = /^([^\s]+)/.exec(part)?.[1]?.toLowerCase();
    if (
      first &&
      WINDOWS_UNAVAILABLE_VERIFY_COMMANDS.some((candidate) => candidate === first)
    ) {
      return first;
    }
  }
  return null;
}

export function classifyVerifyCommand(
  command: string,
  platform?: string
): RunCommandSafety {
  const base = classifyRunCommand(command);
  if (!base.allowed) return base;
  if (platform === "win32") {
    const unavailable = findWindowsUnavailableVerifyCommand(command);
    if (unavailable) {
      return {
        allowed: false,
        reason:
          `POSIX command "${unavailable}" is not available in the Windows cmd.exe runner. ` +
          'Use a cross-platform verifier such as `node -e "const fs=require(\'fs\'); if (!fs.existsSync(\'index.html\')) process.exit(1)"`, `npm test`, or `npm run build`.',
      };
    }
  }
  return { allowed: true };
}

function normalizedProjectFiles(files: string[]): string[] {
  return files.map((file) => file.replace(/\\/g, "/").toLowerCase());
}

function hasProjectFile(files: string[], pattern: RegExp): boolean {
  return normalizedProjectFiles(files).some((file) => pattern.test(file));
}

function hasRootProjectFile(files: string[], pattern: RegExp): boolean {
  return normalizedProjectFiles(files).some(
    (file) => !file.includes("/") && pattern.test(file)
  );
}

function verificationSuggestionForProject(files: string[]): string {
  const detected = detectVerifyCommand(files);
  if (detected) return `Use \`${detected}\` or another verifier for the detected stack.`;
  if (hasProjectFile(files, /(^|\/)package\.json$/)) {
    return "Use an existing npm script such as `npm test` or `npm run build`.";
  }
  if (
    hasProjectFile(files, /(^|\/)index\.html$/) ||
    hasProjectFile(files, /\.(?:js|mjs|cjs|css|html)$/)
  ) {
    return 'For a static web app, use a `node -e` file/syntax check or omit `verifyCommand` when no meaningful build exists.';
  }
  return "Use a verifier that matches files actually present in the project, or omit `verifyCommand` when no meaningful build exists.";
}

function commandMentions(command: string, pattern: RegExp): boolean {
  return pattern.test(command.toLowerCase().replace(/\s+/g, " "));
}

function commandMentionsProjectPath(command: string, pattern: RegExp): boolean {
  return pattern.test(command.toLowerCase().replace(/\\/g, "/"));
}

function stackMismatchReason(command: string, files: string[]): string | null {
  const reject = (tool: string, required: string): string =>
    `${tool} does not match this project tree; ${required} was not found. ${verificationSuggestionForProject(files)}`;

  if (
    commandMentions(command, /(?:^|(?:&&|\|\||[;|])\s*)dotnet\s+build\b/) &&
    !hasRootProjectFile(files, /\.(?:csproj|fsproj|sln)$/) &&
    !commandMentionsProjectPath(command, /\.(?:csproj|fsproj|sln)\b/)
  ) {
    return reject("`dotnet build`", "no root .sln, .csproj, or .fsproj file");
  }
  if (
    commandMentions(command, /(?:^|(?:&&|\|\||[;|])\s*)cargo\s+(?:check|build|test)\b/) &&
    !hasRootProjectFile(files, /^cargo\.toml$/) &&
    !commandMentionsProjectPath(command, /cargo\.toml\b/)
  ) {
    return reject("`cargo`", "root Cargo.toml");
  }
  if (
    commandMentions(command, /(?:^|(?:&&|\|\||[;|])\s*)go\s+(?:build|test)\b/) &&
    !(
      hasRootProjectFile(files, /^go\.mod$/) ||
      hasRootProjectFile(files, /\.go$/)
    )
  ) {
    return reject("`go build`", "root go.mod or a root .go file");
  }
  if (
    commandMentions(command, /(?:^|(?:&&|\|\||[;|])\s*)mvn\b/) &&
    !hasRootProjectFile(files, /^pom\.xml$/) &&
    !commandMentionsProjectPath(command, /pom\.xml\b/)
  ) {
    return reject("`mvn`", "root pom.xml");
  }
  if (
    commandMentions(command, /(?:^|(?:&&|\|\||[;|])\s*)mix\s+(?:compile|test)\b/) &&
    !hasRootProjectFile(files, /^mix\.exs$/) &&
    !commandMentionsProjectPath(command, /mix\.exs\b/)
  ) {
    return reject("`mix`", "root mix.exs");
  }
  if (
    commandMentions(command, /(?:^|(?:&&|\|\||[;|])\s*)cmake\b/) &&
    !hasRootProjectFile(files, /^cmakelists\.txt$/) &&
    !commandMentionsProjectPath(command, /cmakelists\.txt\b/)
  ) {
    return reject("`cmake`", "root CMakeLists.txt");
  }
  if (
    commandMentions(command, /(?:^|(?:&&|\|\||[;|])\s*)make\b/) &&
    !hasRootProjectFile(files, /^makefile$/) &&
    !commandMentionsProjectPath(command, /makefile\b/)
  ) {
    return reject("`make`", "root Makefile");
  }
  if (
    commandMentions(command, /(?:^|(?:&&|\|\||[;|])\s*)(?:npx\s+(?:--yes\s+)?tsc|tsc)\b/) &&
    !hasRootProjectFile(files, /^tsconfig\.json$/) &&
    !commandMentionsProjectPath(command, /tsconfig\.json\b/)
  ) {
    return reject("`tsc`", "root tsconfig.json");
  }
  if (
    commandMentions(command, /(?:^|(?:&&|\|\||[;|])\s*)(?:python|python3|py(?:\s+-3)?)\s+-m\s+compileall\b/) &&
    !hasProjectFile(files, /\.py$/)
  ) {
    return reject("`python -m compileall`", "a .py file");
  }
  if (
    commandMentions(command, /(?:^|(?:&&|\|\||[;|])\s*)npm\s+(?:test|run\s+(?:build|check|lint|test))\b/) &&
    !hasRootProjectFile(files, /^package\.json$/) &&
    !commandMentionsProjectPath(command, /package\.json\b/)
  ) {
    return reject("`npm`", "root package.json");
  }
  return null;
}

export function classifyVerifyCommandForProject(
  command: string,
  files: string[],
  platform?: string
): RunCommandSafety {
  const base = classifyVerifyCommand(command, platform);
  if (!base.allowed) return base;
  const mismatch = stackMismatchReason(command, files);
  if (mismatch) return { allowed: false, reason: mismatch };
  return { allowed: true };
}

export function isGitHubWorkflowCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!/^(?:gh|git)(?:\s|$)/i.test(trimmed)) return false;
  // Keep the unlimited path to one direct command, not shell pipelines/chains.
  return !/(?:[;&|]|\d?>|>>)/.test(trimmed);
}

/**
 * NRW-006 raw-commit guard: detect a `run` command that is `git commit` (or a
 * `git add` used to stage for a commit) so the engine can refuse it and steer
 * the model to the typed, user-approved `repo_commit` action instead. Narrow on
 * purpose — only `git commit` / `git add` as the leading command word, so
 * neighbours like `git commit-graph`, `git add-foo`, or `gitk` do NOT match.
 * This is an EXECUTION guard only; it does NOT affect `isGitHubWorkflowCommand`
 * classification (which deliberately treats `git commit` as a workflow command).
 */
export function isRawCommitCommand(command: string): boolean {
  const trimmed = command.trim();
  // `(?:\s|$)` after the sub-command keeps `git commit-graph` / `git add-foo`
  // from matching: the sub-command must be followed by whitespace or end-of-string.
  return /^git\s+(?:commit|add)(?:\s|$)/i.test(trimmed);
}

export function githubWorkflowRequested(request: string): boolean {
  const text = request.trim();
  const hasRepoAddress =
    /github\.com[/:][A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/i.test(text) ||
    /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/.test(text);
  const asksForGitHubWork =
    /\b(github|issue|issues|pull request|pull requests|pr|prs|branch)\b/i.test(text);
  return hasRepoAddress && asksForGitHubWork;
}

export function runBudgetStatus(input: {
  runnerAvailable: boolean;
  totalRuns: number;
  githubWorkflow: boolean;
}): {
  normalRunsLeft: number;
  totalNormalRunsLeft: number;
  githubCommandsUnlimited: boolean;
  toolAvailable: boolean;
} {
  if (!input.runnerAvailable) {
    return {
      normalRunsLeft: 0,
      totalNormalRunsLeft: 0,
      githubCommandsUnlimited: false,
      toolAvailable: false,
    };
  }
  const totalNormalRunsLeft = Math.max(0, TOTAL_RUNS - input.totalRuns);
  const normalRunsLeft = Math.min(RUNS_PER_PHASE, totalNormalRunsLeft);
  const githubCommandsUnlimited = input.githubWorkflow;
  return {
    normalRunsLeft,
    totalNormalRunsLeft,
    githubCommandsUnlimited,
    toolAvailable: normalRunsLeft > 0 || githubCommandsUnlimited,
  };
}

/** Case-insensitive substring search across all project files. */
export interface SearchAction {
  action: "search";
  query: string;
  reason?: string;
}

/** Read-only structural code intelligence via native fallback or MCP. */
export interface CodeIntelAction {
  action: "code_intel";
  op: CodeIntelOperation;
  query?: string;
  symbol?: string;
  paths?: string[];
  limit?: number;
  reason?: string;
}

/** Call an MCP tool exposed by the user's local runner bridge. */
export interface ToolAction {
  action: "tool";
  server: string;
  tool: string;
  args?: Record<string, unknown>;
  reason?: string;
}

/** Fetch a public http(s) URL via the user's local runner (runner v3+). */
export interface FetchAction {
  action: "fetch";
  url: string;
  reason?: string;
}

export interface SkillRequestAction {
  action: "skill_request";
  ids: string[];
  reason: string;
  target?: "architect" | "next_worker" | "reviewer";
  mode?: "compact" | "full";
}

/** Apply exact SEARCH/REPLACE operations to one existing project file. */
export interface PatchAction {
  action: "patch";
  path: string;
  ops: Array<{ search: string; replace: string }>;
  reason?: string;
}

/** Append one bounded content chunk to a project file; reset starts a new file. */
export interface AppendAction {
  action: "append";
  path: string;
  content: string;
  reset?: boolean;
  reason?: string;
}

// ── Typed repo (Git) actions — constrained operations via the runner's
// /repo/* endpoints instead of raw `git` shell commands (NRW-004). ───────────

/** Re-query the runner's Git working-tree status (non-mutating). */
export interface RepoStatusAction {
  action: "repo_status";
  reason?: string;
}

/** Request a bounded Git diff via the runner (non-mutating). */
export interface RepoDiffAction {
  action: "repo_diff";
  paths?: string[];
  staged?: boolean;
  stat?: boolean;
  reason?: string;
}

/** Initialize a Git repository in the runner folder (mutating). */
export interface RepoInitAction {
  action: "repo_init";
  branch?: string;
  reason?: string;
}

/** Create (and optionally check out) a Git branch via the runner (mutating). */
export interface RepoBranchCreateAction {
  action: "repo_branch_create";
  name: string;
  base?: string;
  checkout?: boolean;
  reason?: string;
}

/**
 * Max length (after trimming) of a `repo_commit` message. Single source of truth
 * for the parse-time check and the Architect-facing prompt copy. NOTE: the local
 * runner (scripts/runner.mjs) enforces the SAME limit independently — it cannot
 * import from lib/ — so keep its literal `200` in sync with this constant.
 */
export const REPO_COMMIT_MESSAGE_MAX = 200;

/**
 * Stage and commit changes via the runner (mutating, user-approved — NRW-006).
 * When `paths` is omitted everything pending is staged; otherwise only those
 * relative paths. `message` is the commit subject (validated ≤REPO_COMMIT_MESSAGE_MAX chars).
 */
export interface RepoCommitAction {
  action: "repo_commit";
  message: string;
  paths?: string[];
  reason?: string;
}

/** Max length (after trimming) of a `repo_pr_create` title — UI/runner-friendly. */
export const REPO_PR_TITLE_MAX = 200;
export const REPO_ISSUE_TITLE_MAX = 200;
export const REPO_MILESTONE_TITLE_MAX = 200;

/** List open GitHub issues so the Architect can choose tagged work. */
export interface RepoIssueListAction {
  action: "repo_issue_list";
  repo: string;
  labels?: string[];
  limit?: number;
  reason?: string;
}

/** Create a GitHub milestone for a planned feature/work stream. */
export interface RepoMilestoneCreateAction {
  action: "repo_milestone_create";
  repo: string;
  title: string;
  description?: string;
  reason?: string;
}

/** Create a GitHub issue from an Architect task. */
export interface RepoIssueCreateAction {
  action: "repo_issue_create";
  repo: string;
  title: string;
  body: string;
  milestone?: string;
  labels?: string[];
  reason?: string;
}

/**
 * Import a GitHub issue (title + body + comments) via the runner's gh-backed
 * endpoint (NRW-007/008). NON-MUTATING — read-only context for the Architect.
 */
export interface RepoIssueReadAction {
  action: "repo_issue_read";
  repo: string;
  issue: number;
  reason?: string;
}

/**
 * Push a branch to a remote via the runner (NRW-008). MUTATES external state
 * (the remote). In ordinary Ask mode the engine requests approval; in an
 * explicit GitHub workflow, the typed repo path can run without an extra prompt.
 */
export interface RepoPushAction {
  action: "repo_push";
  remote?: string;
  branch: string;
  setUpstream?: boolean;
  reason?: string;
}

/**
 * Open a (draft, by default) pull request via the runner's gh-backed endpoint
 * (NRW-008). MUTATES external state and requires a commit precondition. In an
 * explicit GitHub workflow, PR review/merge is the human approval gate.
 */
export interface RepoPrCreateAction {
  action: "repo_pr_create";
  repo?: string;
  title: string;
  body: string;
  base?: string;
  head?: string;
  draft?: boolean;
  reason?: string;
}

/** Worker terminal action: decompose an oversized task into 2-4 subtasks. */
export interface SplitTaskAction {
  action: "split_task";
  reason: string;
  subtasks: Array<{
    title: string;
    instructions: string;
    contextFiles?: string[];
    outputPaths: string[];
    dependsOn?: string[];
    difficulty?: number;
  }>;
}

export type ArchitectAction =
  | ReadAction
  | ReadRangeAction
  | ContextRetrieveAction
  | GuidanceRequestAction
  | GuidanceAnswerAction
  | SpecAction
  | PlanAction
  | BuildPlanAction
  | ReviewAction
  | RunAction
  | SearchAction
  | CodeIntelAction
  | ToolAction
  | FetchAction
  | SkillRequestAction
  | PatchAction
  | AppendAction
  | SplitTaskAction
  | RepoStatusAction
  | RepoDiffAction
  | RepoInitAction
  | RepoBranchCreateAction
  | RepoCommitAction
  | RepoIssueListAction
  | RepoMilestoneCreateAction
  | RepoIssueCreateAction
  | RepoIssueReadAction
  | RepoPushAction
  | RepoPrCreateAction;

function looksLikePath(value: string): boolean {
  const v = value.trim();
  if (!v || /\s/.test(v)) return false;
  return v.includes("/") || /\.[A-Za-z0-9]+$/.test(v);
}

function normalizeOutputPath(raw: string): string | null {
  const path = raw
    .trim()
    .replace(/^["'`([{]+/, "")
    .replace(/["'`.,;:)\]}]+$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/^\/+/, "");
  if (!looksLikePath(path)) return null;
  return path;
}

function normalizeExplicitOutputPath(raw: string): string | null {
  const path = raw
    .trim()
    .replace(/^["'`([{]+/, "")
    .replace(/["'`.,;:)\]}]+$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/^\/+/, "");
  if (!path || /\s/.test(path)) return null;
  return path;
}

function pathsFromExpectedOutputs(expectedOutputs?: string): string[] {
  if (!expectedOutputs) return [];
  const paths: string[] = [];
  for (const token of expectedOutputs.split(/[,\s\n]+/)) {
    const normalized = normalizeOutputPath(token);
    if (normalized) paths.push(normalized);
  }
  return paths;
}

export function outputPathsForTask(task: {
  outputPaths?: unknown;
  expectedOutputs?: string;
}): string[] {
  const explicit = Array.isArray(task.outputPaths)
    ? task.outputPaths.filter((p): p is string => typeof p === "string")
    : [];
  const candidates =
    explicit.length > 0 ? explicit : pathsFromExpectedOutputs(task.expectedOutputs);
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const raw of candidates) {
    const path =
      explicit.length > 0
        ? normalizeExplicitOutputPath(raw)
        : normalizeOutputPath(raw);
    if (!path) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
  }
  return paths;
}

const SUSPICIOUS_BUILD_ARTIFACT_PATHS = new Set([
  "actions/result",
  "actions/results",
  "action/result",
  "result",
  "results",
  "summary",
  "notes",
  "evidence",
]);

export function isSuspiciousBuildArtifactPath(rawPath: string): boolean {
  const path = normalizeExplicitOutputPath(rawPath);
  if (!path) return true;
  const lower = path.toLowerCase();
  if (SUSPICIOUS_BUILD_ARTIFACT_PATHS.has(lower)) return true;
  return /^(?:actions?\/)?(?:result|results|summary|notes|evidence)\.(?:txt|md|json)$/i.test(lower);
}

function normalizedPathSet(paths: string[]): Set<string> {
  return new Set(
    paths
      .map((path) => normalizeExplicitOutputPath(path)?.toLowerCase())
      .filter((path): path is string => !!path)
  );
}

export function isTaskWritePathAllowed(
  task: Pick<BuildTask, "contextFiles" | "outputPaths" | "expectedOutputs">,
  rawPath: string
): boolean {
  const path = normalizeExplicitOutputPath(rawPath);
  if (!path || isSuspiciousBuildArtifactPath(path)) return false;
  const outputPaths = outputPathsForTask(task);
  const scope =
    outputPaths.length > 0
      ? normalizedPathSet(outputPaths)
      : normalizedPathSet(task.contextFiles ?? []);
  if (scope.size === 0) return false;
  return scope.has(path.toLowerCase());
}

export const MIN_WORKER_CONTEXT_FILE_CHARS = 6_000;
export const MAX_WORKER_CONTEXT_FILE_CHARS = 160_000;
export const WORKER_CONTEXT_TOKEN_TO_CHAR_RATIO = 3.2;

export function buildWorkerContextFileCharLimit(input: {
  contextPackTokens: number;
  fileCount: number;
}): number {
  const files = Math.max(1, Math.floor(input.fileCount || 1));
  const contextTokens =
    typeof input.contextPackTokens === "number" && Number.isFinite(input.contextPackTokens)
      ? Math.max(0, Math.floor(input.contextPackTokens))
      : 0;
  const perFile = Math.floor((contextTokens * WORKER_CONTEXT_TOKEN_TO_CHAR_RATIO) / files);
  return Math.max(
    MIN_WORKER_CONTEXT_FILE_CHARS,
    Math.min(MAX_WORKER_CONTEXT_FILE_CHARS, perFile)
  );
}

export const LARGE_EXISTING_FILE_REWRITE_CHARS = 20_000;
export const SUSPICIOUS_REWRITE_SHRINK_RATIO = 0.5;

export type ExistingFileRewriteRejectionCode =
  | "large_existing_file_rewrite"
  | "suspicious_rewrite";

export interface ExistingFileRewriteEvaluation {
  reject: boolean;
  code?: ExistingFileRewriteRejectionCode;
  message?: string;
}

export function evaluateExistingFileRewrite(input: {
  path: string;
  existingLength: number;
  replacementLength: number;
  writer?: "worker" | "architect" | string;
  allowLargeRewrite?: boolean;
}): ExistingFileRewriteEvaluation {
  const existingLength = Math.max(0, Math.floor(input.existingLength || 0));
  const replacementLength = Math.max(0, Math.floor(input.replacementLength || 0));
  if (
    existingLength > 2_000 &&
    replacementLength < existingLength * SUSPICIOUS_REWRITE_SHRINK_RATIO
  ) {
    return {
      reject: true,
      code: "suspicious_rewrite",
      message: `Rewrite of ${input.path} skipped as suspicious: the existing file is ${existingLength} chars but the replacement is only ${replacementLength}. Use SEARCH/REPLACE edit blocks for changes, or append chunks with reset=true only when an explicit full replacement is required.`,
    };
  }
  if (
    !input.allowLargeRewrite &&
    existingLength >= LARGE_EXISTING_FILE_REWRITE_CHARS
  ) {
    const actor = input.writer === "architect" ? "Architect" : "worker";
    return {
      reject: true,
      code: "large_existing_file_rewrite",
      message: `Full-file rewrite of large existing file ${input.path} was rejected for ${actor}: the existing file is ${existingLength} chars and the replacement is ${replacementLength}. Use targeted SEARCH/REPLACE patch ops, append chunks with reset=true only when explicitly authorized, or split the task.`,
    };
  }
  return { reject: false };
}

export interface TaskSplitResult {
  ok: boolean;
  reason?: string;
  childIds?: string[];
}

/**
 * Apply a worker `split_task` action to the live task array IN PLACE.
 *
 * The Build engine runs up to 8 workers concurrently, each mutating its own
 * captured task object; this function therefore VALIDATES FULLY FIRST and makes
 * ZERO mutations if anything is rejected, then mutates `tasks` in place while
 * preserving the object identity of every pre-existing task (the parent and any
 * dependents are the SAME references, never clones). Children are inserted
 * immediately after the parent, get `splitDepth: 1` (so they can never split
 * again), and other tasks' `dependsOn` edges from the parent are rewritten to
 * all child ids.
 */
export function applyTaskSplit(
  tasks: BuildTask[],
  parentId: string,
  split: SplitTaskAction,
  maxContextFiles: number
): TaskSplitResult {
  const parentIndex = tasks.findIndex((task) => task.id === parentId);
  if (parentIndex < 0) {
    return { ok: false, reason: `no task with id ${parentId} to split` };
  }
  const parent = tasks[parentIndex];
  if ((parent.splitDepth ?? 0) !== 0) {
    return {
      ok: false,
      reason: "task was already created by a split and cannot split again",
    };
  }

  // Normalize + validate every child's outputPaths before touching the array.
  const normalizedOutputsPerChild: string[][] = [];
  for (const subtask of split.subtasks) {
    const normalized: string[] = [];
    for (const rawPath of subtask.outputPaths) {
      const path = normalizeExplicitOutputPath(rawPath);
      if (!path) {
        return { ok: false, reason: `invalid subtask output path: ${rawPath}` };
      }
      if (isSuspiciousBuildArtifactPath(path)) {
        return {
          ok: false,
          reason: `subtask output path looks like a scratch artifact and is not allowed: ${path}`,
        };
      }
      normalized.push(path);
    }
    if (normalized.length === 0) {
      return { ok: false, reason: "each subtask must declare at least one output path" };
    }
    normalizedOutputsPerChild.push(normalized);
  }

  // Every child path must fall within the parent's declared outputs (when the
  // parent declared any).
  const parentOutputs = outputPathsForTask(parent);
  if (parentOutputs.length > 0) {
    const parentSet = new Set(parentOutputs.map((path) => path.toLowerCase()));
    for (const normalized of normalizedOutputsPerChild) {
      for (const path of normalized) {
        if (!parentSet.has(path.toLowerCase())) {
          return {
            ok: false,
            reason: `subtask output path ${path} is outside the parent task's declared files`,
          };
        }
      }
    }
  }

  // Sibling outputPaths must be disjoint (case-insensitive).
  const claimed = new Set<string>();
  for (const normalized of normalizedOutputsPerChild) {
    for (const path of normalized) {
      const key = path.toLowerCase();
      if (claimed.has(key)) {
        return {
          ok: false,
          reason: `two subtasks both claim the output path ${path}`,
        };
      }
      claimed.add(key);
    }
  }

  // Compute child ids up front (needed to resolve dependsOn). Split children
  // are normal tasks and must continue the global T<number> sequence.
  const existingIds = new Set(tasks.map((task) => buildTaskIdKey(task.id)));
  const childIds: string[] = [];
  let nextNumber = nextIncrementalBuildTaskNumber(tasks);
  for (let i = 0; i < split.subtasks.length; i++) {
    let candidate = `T${nextNumber}`;
    while (existingIds.has(buildTaskIdKey(candidate))) {
      nextNumber += 1;
      candidate = `T${nextNumber}`;
    }
    nextNumber += 1;
    existingIds.add(buildTaskIdKey(candidate));
    childIds.push(candidate);
  }

  // Build the child tasks. dependsOn accepts either an ordinal ("1".."N") or a
  // resolved child id, and only edges pointing at a LOWER-numbered sibling are
  // kept; anything else is silently dropped (not an error).
  const children: BuildTask[] = split.subtasks.map((subtask, i) => {
    const deps: string[] = [];
    for (const rawDep of subtask.dependsOn ?? []) {
      let targetIndex = -1;
      const ordinal = Number(rawDep);
      if (Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= childIds.length) {
        targetIndex = ordinal - 1;
      } else {
        targetIndex = childIds.indexOf(rawDep);
      }
      if (targetIndex >= 0 && targetIndex < i) {
        const childId = childIds[targetIndex];
        if (!deps.includes(childId)) deps.push(childId);
      }
    }
    return normalizeBuildTaskContract({
      id: childIds[i],
      title: subtask.title,
      instructions: subtask.instructions,
      kind: parent.kind,
      completionMode: parent.completionMode,
      verificationPolicy: parent.verificationPolicy,
      requiredEvidence: parent.requiredEvidence,
      phaseSpec: parent.phaseSpec,
      implementationContract: parent.implementationContract,
      contextFiles: [
        ...new Set([...parent.contextFiles, ...(subtask.contextFiles ?? [])]),
      ].slice(0, maxContextFiles),
      outputPaths: normalizedOutputsPerChild[i],
      status: "planned",
      ...(deps.length > 0 ? { dependsOn: deps } : {}),
      difficulty: subtask.difficulty ?? parent.difficulty,
      splitDepth: 1,
    });
  });

  // ---- Mutation only past this point (validation fully passed). ----
  tasks.splice(parentIndex + 1, 0, ...children);
  parent.status = "done";
  parent.workerIndex = undefined;
  parent.assignTo = undefined;
  parent.title = `${parent.title} (split into ${childIds.join(", ")})`;

  // Rewrite every other task's dependency on the parent to all child ids.
  for (const task of tasks) {
    if (task === parent) continue;
    if (!task.dependsOn?.length) continue;
    if (!task.dependsOn.includes(parentId)) continue;
    const rewritten: string[] = [];
    for (const dep of task.dependsOn) {
      if (dep === parentId) {
        for (const childId of childIds) {
          if (!rewritten.includes(childId)) rewritten.push(childId);
        }
      } else if (!rewritten.includes(dep)) {
        rewritten.push(dep);
      }
    }
    task.dependsOn = rewritten;
  }

  return { ok: true, childIds };
}

export function findIncompleteBuildTasks(tasks: BuildTask[]): BuildTask[] {
  return tasks.filter((task) => task.status !== "done");
}

export function isBuildTaskDependencySatisfied(
  dependency: Pick<BuildTask, "status"> | null | undefined
): boolean {
  // Unknown dependency ids are treated as satisfied so a typo cannot deadlock
  // the build forever. Known tasks must be fully done; "review" is only a
  // pending verdict, and "failed" must block dependents until the Architect
  // replans or explicitly replaces the work.
  return !dependency || dependency.status === "done";
}

export function buildOutstandingTasksDigest(tasks: BuildTask[]): string {
  const outstanding = findIncompleteBuildTasks(tasks);
  if (outstanding.length === 0) return "";
  return outstanding
    .map((task) => {
      const bits = [
        `- ${task.id} (${task.status}${task.failCount ? `, ${task.failCount} failed attempt${task.failCount === 1 ? "" : "s"}` : ""}): ${task.title}`,
      ];
      if (task.dependsOn?.length) {
        const blockedBy = task.dependsOn.filter((depId) => {
          const dep = tasks.find((t) => t.id === depId);
          return !isBuildTaskDependencySatisfied(dep);
        });
        if (blockedBy.length > 0) bits.push(`  blocked by: ${blockedBy.join(", ")}`);
      }
      if (task.outputPaths?.length) {
        bits.push(`  outputPaths: ${task.outputPaths.join(", ")}`);
      }
      return bits.join("\n");
    })
    .join("\n");
}

export function buildIncompleteTaskFailure(tasks: BuildTask[]): string {
  const incomplete = findIncompleteBuildTasks(tasks);
  if (incomplete.length === 0) return "";
  const listed = incomplete
    .map((task) => `${task.id} (${task.status}): ${task.title}`)
    .join("; ");
  return `Build incomplete: ${incomplete.length} required task${incomplete.length === 1 ? "" : "s"} did not finish: ${listed}`;
}

export type FileChangeOperation = "create" | "rewrite" | "patch" | "append";

export interface FileChangeInput {
  path: string;
  operation: FileChangeOperation;
  before: string | null;
  after: string;
}

const CHANGE_PREVIEW_CONTEXT = 4;
const CHANGE_PREVIEW_LINES = 10;
const CHANGE_LINE_CHARS = 160;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function compactLine(line: string): string {
  const singleLine = line.replace(/\t/g, "  ");
  return singleLine.length <= CHANGE_LINE_CHARS
    ? singleLine
    : `${singleLine.slice(0, CHANGE_LINE_CHARS)}...[line truncated]`;
}

function firstDifferentLine(before: string[], after: string[]): number {
  const max = Math.max(before.length, after.length);
  for (let i = 0; i < max; i++) {
    if ((before[i] ?? "") !== (after[i] ?? "")) return i;
  }
  return -1;
}

function numberedWindow(lines: string[], center: number): string {
  if (lines.length === 0) return "(empty)";
  const safeCenter = Math.max(0, Math.min(center, lines.length - 1));
  const start = Math.max(0, safeCenter - CHANGE_PREVIEW_CONTEXT);
  const end = Math.min(lines.length, start + CHANGE_PREVIEW_LINES);
  return lines
    .slice(start, end)
    .map((line, i) => `${start + i + 1}: ${compactLine(line)}`)
    .join("\n");
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

/**
 * Compact, bounded summary of one landed file change. This intentionally does
 * not include whole file contents; the Architect can use read/search/range
 * tools for exact inspection.
 */
export function summarizeFileChange(input: FileChangeInput): string {
  const before = input.before ?? "";
  const beforeLines = input.before == null ? [] : before.split("\n");
  const afterLines = input.after.split("\n");
  const diffIndex =
    input.before == null ? 0 : firstDifferentLine(beforeLines, afterLines);
  const previewCenter =
    diffIndex >= 0 ? diffIndex : Math.max(0, afterLines.length - 1);
  const beforeBytes = input.before == null ? 0 : byteLength(before);
  const afterBytes = byteLength(input.after);
  const beforeLineCount = input.before == null ? 0 : beforeLines.length;
  const lines = [
    `- ${input.operation.toUpperCase()} ${input.path}: ${beforeBytes} -> ${afterBytes} bytes (${signed(afterBytes - beforeBytes)}), ${beforeLineCount} -> ${afterLines.length} lines (${signed(afterLines.length - beforeLineCount)})`,
  ];

  if (input.before != null && diffIndex >= 0) {
    lines.push("  Previous near first change:");
    lines.push(numberedWindow(beforeLines, previewCenter));
  } else if (input.before != null) {
    lines.push("  No textual delta detected after write.");
  }

  lines.push("  Current near first change:");
  lines.push(numberedWindow(afterLines, previewCenter));
  return lines.join("\n");
}

export interface WaveReviewDigestTask {
  task: Pick<BuildTask, "id" | "title" | "implementationContract">;
  workerName: string;
  files: string[];
  notes?: string;
  changes: string[];
}

export function buildWaveReviewDigest(items: WaveReviewDigestTask[]): string {
  if (items.length === 0) return "No worker output landed in this wave.";
  return items
    .map((item) => {
      const changes =
        item.changes.length > 0
          ? item.changes.join("\n")
          : "- No landed file-change summary was recorded.";
      return [
        `### ${item.task.id}: ${item.task.title} (worker: ${item.workerName})`,
        item.task.implementationContract?.trim()
          ? `Implementation contract: ${item.task.implementationContract.trim()}`
          : "",
        `Files touched: ${item.files.length > 0 ? item.files.join(", ") : "none"}`,
        `Worker notes: ${item.notes?.trim() ? item.notes.trim() : "none"}`,
        "Landed change summaries:",
        changes,
      ].join("\n");
    })
    .join("\n\n");
}

export type BuildFileToolAction =
  | "read"
  | "read_range"
  | "search"
  | "patch"
  | "append";

export function formatBuildFileToolDiagnostic(input: {
  actor: string;
  action: BuildFileToolAction;
  path?: string;
  paths?: string[];
  query?: string;
  startLine?: number;
  lineCount?: number;
  summary?: string;
}): string {
  const actor = input.actor.trim() || "Model";
  if (input.action === "read") {
    const paths = (input.paths ?? []).filter(Boolean);
    const listed = paths.length > 0 ? paths.join(", ") : "requested files";
    return `${actor} read ${paths.length || 1} file${paths.length === 1 ? "" : "s"}: ${listed}`;
  }
  if (input.action === "read_range") {
    const start = Math.max(1, Math.round(input.startLine ?? 1));
    const count = Math.max(1, Math.round(input.lineCount ?? 1));
    const end = start + count - 1;
    return `${actor} read ${input.path ?? "file"} lines ${start}-${end}`;
  }
  if (input.action === "search") {
    return `${actor} searched the project for "${input.query ?? ""}"`;
  }
  if (input.action === "patch") {
    return `${actor} patched ${input.path ?? "file"}${input.summary ? ` - ${input.summary}` : ""}`;
  }
  return `${actor} appended ${input.path ?? "file"}${input.summary ? ` - ${input.summary}` : ""}`;
}

/** The balanced top-level {...} starting exactly at `start`, or null. */
function balancedObjectAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = inString;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Every top-level balanced {...} in the text, in document order (capped). */
function balancedObjects(text: string, max = 20): string[] {
  const found: string[] = [];
  let start = text.indexOf("{");
  while (start >= 0 && found.length < max) {
    const obj = balancedObjectAt(text, start);
    if (obj) {
      found.push(obj);
      start = text.indexOf("{", start + obj.length);
    } else {
      start = text.indexOf("{", start + 1);
    }
  }
  return found;
}

function uniqueActionCandidates(text: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string): void => {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };
  const blocks = fencedBlocks(text);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const lang = blocks[i].info.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (lang === "" || lang === "json" || lang === "jsonc") {
      add(blocks[i].body);
    }
  }
  const balanced = balancedObjects(text);
  for (let i = balanced.length - 1; i >= 0; i--) {
    add(balanced[i]);
  }
  return candidates;
}

function uniqueActionCandidatesInDocumentOrder(text: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string): void => {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };
  for (const block of fencedBlocks(text)) {
    const lang = block.info.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (lang === "" || lang === "json" || lang === "jsonc") {
      add(block.body);
    }
  }
  for (const candidate of balancedObjects(text)) {
    add(candidate);
  }
  return candidates;
}

/**
 * All fenced code blocks, scanned line by line so a closing fence can never be
 * mistaken for an opening one — the failure a regex scan has when other code
 * blocks precede the action block (it then misses the action entirely).
 */
function fencedBlocks(text: string): Array<{ info: string; body: string }> {
  const lines = text.split("\n");
  const blocks: Array<{ info: string; body: string }> = [];
  let i = 0;
  while (i < lines.length) {
    const open = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!open) {
      i += 1;
      continue;
    }
    const closeRe = open[1][0] === "`" ? /^\s*`{3,}\s*$/ : /^\s*~{3,}\s*$/;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !closeRe.test(lines[j])) {
      body.push(lines[j]);
      j += 1;
    }
    blocks.push({ info: (open[2] ?? "").trim(), body: body.join("\n") });
    i = j + 1;
  }
  return blocks;
}

/**
 * Validate a Git ref name (branch or base) for the typed `repo_branch_create`
 * action — the same constraints the runner enforces, applied client-side so the
 * parser rejects a malformed branch creation before it is ever dispatched.
 */
export function isValidGitRefName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const value = name.trim();
  if (!value) return false;
  if (value.startsWith("-")) return false;
  if (value.endsWith("/")) return false;
  if (value.includes("..")) return false;
  if (value.includes("//")) return false;
  if (value.includes("@{")) return false;
  if (value.includes("\\")) return false;
  if (/\s/.test(value)) return false;
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

/**
 * Validate a GitHub `owner/repo` slug for the typed `repo_issue_read` /
 * `repo_pr_create` actions — exactly one `/`, with both halves drawn from the
 * characters GitHub allows in owner and repository names. Applied client-side so
 * a malformed slug is rejected before it ever reaches the gh-backed endpoint.
 * MIRRORS the runner's `REPO_SLUG_RE` in scripts/runner.mjs (which enforces the
 * same rule independently — it cannot import this) — keep the two in lockstep.
 */
export function isValidRepoSlug(slug: unknown): slug is string {
  if (typeof slug !== "string") return false;
  const value = slug.trim();
  if (!value) return false;
  const parts = value.split("/");
  if (parts.length !== 2) return false;
  const [owner, repo] = parts;
  if (!owner || !repo) return false;
  return /^[A-Za-z0-9_.-]+$/.test(owner) && /^[A-Za-z0-9_.-]+$/.test(repo);
}

function cleanRepoLabels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const labels = value
    .filter((label): label is string => typeof label === "string")
    .map((label) => label.trim())
    .filter((label) => label.length > 0 && label.length <= 80)
    .slice(0, 10);
  return labels.length > 0 ? labels : undefined;
}

const CODE_INTEL_OPS: CodeIntelOperation[] = [
  "architecture",
  "search_symbols",
  "trace_symbol",
  "detect_change_impact",
];

function isCodeIntelOperation(value: unknown): value is CodeIntelOperation {
  return (
    typeof value === "string" &&
    CODE_INTEL_OPS.includes(value as CodeIntelOperation)
  );
}

function cleanCodeIntelPaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const paths = value
    .filter((path): path is string => typeof path === "string")
    .map((path) =>
      path.trim().replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^\/+/, "")
    )
    .filter(Boolean)
    .slice(0, 20);
  return paths.length > 0 ? paths : undefined;
}

function cleanCodeIntelLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(10, Math.round(value)));
}

function normalizePlanningTaskAction(
  task: BuildPlanningAction["tasks"][number]
): BuildPlanningAction["tasks"][number] {
  const raw = task as Record<string, unknown>;
  const implementationContract = stringFromUnknown(raw.implementationContract);
  const kind = cleanTaskKind(raw.kind);
  const completionMode = cleanTaskCompletionMode(raw.completionMode);
  const verificationPolicy = cleanTaskVerificationPolicy(raw.verificationPolicy);
  const requiredEvidence = stringArrayFromUnknown(raw.requiredEvidence);
  return {
    ...task,
    ...(implementationContract ? { implementationContract } : {}),
    ...(kind ? { kind } : {}),
    ...(completionMode ? { completionMode } : {}),
    ...(verificationPolicy ? { verificationPolicy } : {}),
    ...(requiredEvidence.length > 0 ? { requiredEvidence } : {}),
  };
}

function parseActionCandidate(candidate: string): ArchitectAction | null {
  try {
    const parsed = JSON.parse(candidate) as Partial<ArchitectAction>;
    if (parsed && typeof parsed === "object" && "action" in parsed) {
      const actionName = (parsed as { action?: unknown }).action;
      const cleanReadPaths = (value: unknown): string[] => {
        const rawPaths = Array.isArray(value)
          ? value
          : typeof value === "string"
            ? [value]
            : [];
        return rawPaths
          .filter((path): path is string => typeof path === "string")
          .map((path) => path.trim())
          .filter(Boolean);
      };
      if (actionName === "read_file") {
        const readFile = parsed as { path?: unknown; paths?: unknown };
        const paths = cleanReadPaths(readFile.paths).length > 0
          ? cleanReadPaths(readFile.paths)
          : cleanReadPaths(readFile.path);
        if (paths.length > 0) return { action: "read", paths };
      }
      if (parsed.action === "read") {
        const paths = cleanReadPaths((parsed as { paths?: unknown }).paths);
        if (paths.length > 0) {
          return {
            ...(parsed as ReadAction),
            paths,
          };
        }
      }
      if (
        parsed.action === "read_range" &&
        typeof (parsed as ReadRangeAction).path === "string" &&
        Number.isFinite((parsed as ReadRangeAction).startLine) &&
        Number.isFinite((parsed as ReadRangeAction).lineCount)
      ) {
        const action = parsed as ReadRangeAction;
        return {
          ...action,
          path: action.path.trim(),
          startLine: Math.max(1, Math.round(action.startLine)),
          lineCount: Math.max(1, Math.round(action.lineCount)),
        };
      }
      if (parsed.action === "context_retrieve") {
        const action = parsed as ContextRetrieveAction;
        if (!isContextBlobRef(action.ref)) return null;
        return {
          action: "context_retrieve",
          ref: action.ref.trim(),
          maxTokens: clampContextRetrieveMaxTokens(action.maxTokens),
          offsetChars: clampContextRetrieveOffsetChars(action.offsetChars),
          reason: typeof action.reason === "string" ? action.reason : undefined,
        };
      }
      if (parsed.action === "guidance_request") {
        return normalizeGuidanceRequestAction(parsed);
      }
      if (parsed.action === "guidance_answer") {
        return normalizeGuidanceAnswerAction(parsed);
      }
      if (parsed.action === "spec") {
        const spec = normalizeBuildSpec((parsed as { spec?: unknown }).spec);
        if (!spec) return null;
        const verifyCommand = stringFromUnknown(
          (parsed as { verifyCommand?: unknown }).verifyCommand
        );
        const notes = stringFromUnknown((parsed as { notes?: unknown }).notes);
        return {
          action: "spec",
          spec,
          ...(notes ? { notes } : {}),
          ...(verifyCommand ? { verifyCommand } : {}),
        };
      }
      if (
        (parsed.action === "plan" || parsed.action === "build_plan") &&
        Array.isArray((parsed as BuildPlanningAction).tasks)
      ) {
        const tasks = (parsed as BuildPlanningAction).tasks.map(
          normalizePlanningTaskAction
        );
        if (parsed.action === "build_plan") {
          const plan = parsed as BuildPlanAction;
          return {
            ...plan,
            tasks,
            spec: normalizeBuildSpec((parsed as { spec?: unknown }).spec),
            phaseSpec: normalizeBuildPhaseSpec(
              (parsed as { phaseSpec?: unknown }).phaseSpec
            ),
            implementationPlan: stringFromUnknown(
              (parsed as { implementationPlan?: unknown }).implementationPlan
            ),
          };
        }
        const plan = parsed as PlanAction;
        return {
          ...plan,
          tasks,
          phaseSpec: normalizeBuildPhaseSpec(
            (parsed as { phaseSpec?: unknown }).phaseSpec
          ),
        };
      }
      if (parsed.action === "review") {
        const review = parsed as ReviewAction & { results?: unknown[] };
        const verifyCommand =
          typeof (parsed as { verifyCommand?: unknown }).verifyCommand === "string"
            ? (parsed as { verifyCommand: string }).verifyCommand.trim()
            : undefined;
        return {
          ...review,
          results: Array.isArray(review.results)
            ? review.results
                .map(normalizeReviewResult)
                .filter((item): item is ReviewResult => item != null)
            : [],
          phaseSpec: normalizeBuildPhaseSpec(
            (parsed as { phaseSpec?: unknown }).phaseSpec
          ),
          ...(Array.isArray(review.newTasks)
            ? { newTasks: review.newTasks.map(normalizePlanningTaskAction) }
            : {}),
          requestFulfillment: normalizeRequestFulfillmentReview(
            (parsed as { requestFulfillment?: unknown }).requestFulfillment
          ),
          ...(verifyCommand !== undefined ? { verifyCommand } : {}),
          done: !!review.done,
        };
      }
      if (
        parsed.action === "run" &&
        typeof (parsed as RunAction).command === "string" &&
        (parsed as RunAction).command.trim()
      ) {
        const action = parsed as RunAction;
        return { ...action, command: action.command.trim() };
      }
      if (actionName === "shell") {
        const shell = parsed as Partial<RunAction> & { cmd?: unknown };
        const command =
          typeof shell.command === "string"
            ? shell.command
            : typeof shell.cmd === "string"
              ? shell.cmd
              : "";
        if (command.trim()) {
          return {
            action: "run",
            command: command.trim(),
            reason: typeof shell.reason === "string" ? shell.reason : undefined,
          };
        }
      }
      if (
        parsed.action === "search" &&
        typeof (parsed as SearchAction).query === "string" &&
        (parsed as SearchAction).query.trim()
      ) {
        return parsed as SearchAction;
      }
      if (parsed.action === "code_intel") {
        const action = parsed as CodeIntelAction;
        if (!isCodeIntelOperation(action.op)) return null;
        const query =
          typeof action.query === "string" && action.query.trim()
            ? action.query.trim()
            : undefined;
        const symbol =
          typeof action.symbol === "string" && action.symbol.trim()
            ? action.symbol.trim()
            : query;
        if (action.op === "search_symbols" && !query && !symbol) return null;
        if (action.op === "trace_symbol" && !symbol) return null;
        return {
          action: "code_intel",
          op: action.op,
          query,
          symbol,
          paths: cleanCodeIntelPaths(action.paths),
          limit: cleanCodeIntelLimit(action.limit),
          reason:
            typeof action.reason === "string" ? action.reason : undefined,
        };
      }
      if (
        parsed.action === "tool" &&
        typeof (parsed as ToolAction).server === "string" &&
        (parsed as ToolAction).server.trim() &&
        typeof (parsed as ToolAction).tool === "string" &&
        (parsed as ToolAction).tool.trim()
      ) {
        return parsed as ToolAction;
      }
      if (
        parsed.action === "fetch" &&
        typeof (parsed as FetchAction).url === "string" &&
        /^https?:\/\//i.test((parsed as FetchAction).url.trim())
      ) {
        return { ...(parsed as FetchAction), url: (parsed as FetchAction).url.trim() };
      }
      if (
        parsed.action === "skill_request" &&
        Array.isArray((parsed as SkillRequestAction).ids) &&
        typeof (parsed as SkillRequestAction).reason === "string" &&
        (parsed as SkillRequestAction).reason.trim()
      ) {
        const action = parsed as SkillRequestAction;
        const ids = action.ids
          .filter((id): id is string => typeof id === "string")
          .map((id) => id.trim())
          .filter(Boolean)
          .slice(0, 5);
        const target = action.target ?? "architect";
        const mode = action.mode ?? "compact";
        if (
          ids.length > 0 &&
          ["architect", "next_worker", "reviewer"].includes(target) &&
          ["compact", "full"].includes(mode)
        ) {
          return {
            action: "skill_request",
            ids,
            reason: action.reason.trim(),
            target,
            mode,
          };
        }
      }
      if (
        parsed.action === "patch" &&
        typeof (parsed as PatchAction).path === "string" &&
        Array.isArray((parsed as PatchAction).ops)
      ) {
        const action = parsed as PatchAction;
        const ops = action.ops.filter(
          (op) =>
            op &&
            typeof op.search === "string" &&
            op.search.length > 0 &&
            typeof op.replace === "string"
        );
        if (ops.length > 0) {
          return { ...action, path: action.path.trim(), ops };
        }
      }
      if (
        actionName === "edit" &&
        typeof (parsed as PatchAction).path === "string" &&
        Array.isArray((parsed as PatchAction).ops)
      ) {
        const action = parsed as PatchAction;
        const ops = action.ops.filter(
          (op) =>
            op &&
            typeof op.search === "string" &&
            op.search.length > 0 &&
            typeof op.replace === "string"
        );
        if (ops.length > 0) {
          return { ...action, action: "patch", path: action.path.trim(), ops };
        }
      }
      if (
        parsed.action === "append" &&
        typeof (parsed as AppendAction).path === "string" &&
        typeof (parsed as AppendAction).content === "string"
      ) {
        const action = parsed as AppendAction;
        return {
          ...action,
          path: action.path.trim(),
          reset: !!action.reset,
        };
      }
      if (parsed.action === "repo_status") {
        return {
          action: "repo_status",
          reason:
            typeof (parsed as RepoStatusAction).reason === "string"
              ? (parsed as RepoStatusAction).reason
              : undefined,
        };
      }
      if (parsed.action === "repo_diff") {
        const diff = parsed as RepoDiffAction;
        const paths = Array.isArray(diff.paths)
          ? diff.paths.filter((p): p is string => typeof p === "string")
          : undefined;
        return {
          action: "repo_diff",
          paths: paths && paths.length > 0 ? paths : undefined,
          staged: !!diff.staged,
          stat: !!diff.stat,
          reason: typeof diff.reason === "string" ? diff.reason : undefined,
        };
      }
      if (parsed.action === "repo_init") {
        const init = parsed as RepoInitAction;
        const branch =
          typeof init.branch === "string" && init.branch.trim()
            ? init.branch.trim()
            : undefined;
        if (branch !== undefined && !isValidGitRefName(branch)) return null;
        return {
          action: "repo_init",
          branch,
          reason: typeof init.reason === "string" ? init.reason : undefined,
        };
      }
      if (parsed.action === "repo_branch_create") {
        const branch = parsed as RepoBranchCreateAction;
        // Reject malformed branch creation outright (mutating action).
        if (!isValidGitRefName(branch.name)) return null;
        if (branch.base !== undefined && !isValidGitRefName(branch.base)) return null;
        return {
          action: "repo_branch_create",
          name: branch.name.trim(),
          base: branch.base !== undefined ? branch.base.trim() : undefined,
          // Defaults to true: the Architect normally wants to switch.
          checkout: branch.checkout === undefined ? true : !!branch.checkout,
          reason: typeof branch.reason === "string" ? branch.reason : undefined,
        };
      }
      if (parsed.action === "repo_commit") {
        const commit = parsed as RepoCommitAction;
        // Reject malformed commits outright (mutating action): the message must
        // be a non-empty string ≤REPO_COMMIT_MESSAGE_MAX chars after trimming.
        if (typeof commit.message !== "string") return null;
        const message = commit.message.trim();
        if (!message || message.length > REPO_COMMIT_MESSAGE_MAX) return null;
        const paths = Array.isArray(commit.paths)
          ? commit.paths.filter((p): p is string => typeof p === "string")
          : undefined;
        return {
          action: "repo_commit",
          message,
          paths: paths && paths.length > 0 ? paths : undefined,
          reason: typeof commit.reason === "string" ? commit.reason : undefined,
        };
      }
      if (parsed.action === "repo_issue_list") {
        const list = parsed as RepoIssueListAction;
        if (!isValidRepoSlug(list.repo)) return null;
        const limit =
          typeof list.limit === "number" && Number.isFinite(list.limit)
            ? Math.max(1, Math.min(50, Math.round(list.limit)))
            : undefined;
        return {
          action: "repo_issue_list",
          repo: list.repo.trim(),
          labels: cleanRepoLabels(list.labels),
          limit,
          reason: typeof list.reason === "string" ? list.reason : undefined,
        };
      }
      if (parsed.action === "repo_milestone_create") {
        const milestone = parsed as RepoMilestoneCreateAction;
        if (!isValidRepoSlug(milestone.repo)) return null;
        if (typeof milestone.title !== "string") return null;
        const title = milestone.title.trim();
        if (!title || title.length > REPO_MILESTONE_TITLE_MAX) return null;
        return {
          action: "repo_milestone_create",
          repo: milestone.repo.trim(),
          title,
          description:
            typeof milestone.description === "string"
              ? milestone.description
              : undefined,
          reason:
            typeof milestone.reason === "string" ? milestone.reason : undefined,
        };
      }
      if (parsed.action === "repo_issue_create") {
        const issueCreate = parsed as RepoIssueCreateAction;
        if (!isValidRepoSlug(issueCreate.repo)) return null;
        if (typeof issueCreate.title !== "string") return null;
        const title = issueCreate.title.trim();
        if (!title || title.length > REPO_ISSUE_TITLE_MAX) return null;
        return {
          action: "repo_issue_create",
          repo: issueCreate.repo.trim(),
          title,
          body: typeof issueCreate.body === "string" ? issueCreate.body : "",
          milestone:
            typeof issueCreate.milestone === "string" &&
            issueCreate.milestone.trim()
              ? issueCreate.milestone.trim()
              : undefined,
          labels: cleanRepoLabels(issueCreate.labels),
          reason:
            typeof issueCreate.reason === "string" ? issueCreate.reason : undefined,
        };
      }
      if (parsed.action === "repo_issue_read") {
        const issueRead = parsed as RepoIssueReadAction;
        // Reject malformed input: a valid owner/repo slug and a positive integer
        // issue number are both required (non-mutating, but still validated).
        if (!isValidRepoSlug(issueRead.repo)) return null;
        const issue = issueRead.issue;
        if (typeof issue !== "number" || !Number.isInteger(issue) || issue <= 0) {
          return null;
        }
        return {
          action: "repo_issue_read",
          repo: issueRead.repo.trim(),
          issue,
          reason: typeof issueRead.reason === "string" ? issueRead.reason : undefined,
        };
      }
      if (parsed.action === "repo_push") {
        const push = parsed as RepoPushAction;
        // Reject malformed push outright (mutating): branch must be a valid ref;
        // remote, when present, must also be a valid ref name.
        if (!isValidGitRefName(push.branch)) return null;
        if (push.remote !== undefined && !isValidGitRefName(push.remote)) return null;
        return {
          action: "repo_push",
          remote: push.remote !== undefined ? push.remote.trim() : undefined,
          branch: push.branch.trim(),
          setUpstream: push.setUpstream === undefined ? undefined : !!push.setUpstream,
          reason: typeof push.reason === "string" ? push.reason : undefined,
        };
      }
      if (parsed.action === "repo_pr_create") {
        const pr = parsed as RepoPrCreateAction;
        // Reject malformed PR creation outright (mutating): title 1–REPO_PR_TITLE_MAX
        // chars; repo (when present) a valid slug; base/head (when present) valid refs.
        if (typeof pr.title !== "string") return null;
        const title = pr.title.trim();
        if (!title || title.length > REPO_PR_TITLE_MAX) return null;
        if (pr.repo !== undefined && !isValidRepoSlug(pr.repo)) return null;
        if (pr.base !== undefined && !isValidGitRefName(pr.base)) return null;
        if (pr.head !== undefined && !isValidGitRefName(pr.head)) return null;
        return {
          action: "repo_pr_create",
          repo: pr.repo !== undefined ? pr.repo.trim() : undefined,
          title,
          body: typeof pr.body === "string" ? pr.body : "",
          base: pr.base !== undefined ? pr.base.trim() : undefined,
          head: pr.head !== undefined ? pr.head.trim() : undefined,
          // Prefer DRAFT PRs: default to a draft when the model omits the flag.
          draft: pr.draft === undefined ? true : !!pr.draft,
          reason: typeof pr.reason === "string" ? pr.reason : undefined,
        };
      }
      if (parsed.action === "split_task") {
        return normalizeSplitTaskAction(parsed);
      }
    }
  } catch {
    // not a valid action candidate
  }
  return null;
}

function normalizeGuidanceRequestAction(
  parsed: unknown
): GuidanceRequestAction | null {
  if (!parsed || typeof parsed !== "object") return null;
  const raw = parsed as { mode?: unknown; question?: unknown; reason?: unknown };
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  if (!question) return null;
  const mode = raw.mode === "async" ? "async" : "blocking";
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  return {
    action: "guidance_request",
    mode,
    question,
    ...(reason ? { reason } : {}),
  };
}

function normalizeGuidanceAnswerAction(
  parsed: unknown
): GuidanceAnswerAction | null {
  if (!parsed || typeof parsed !== "object") return null;
  const raw = parsed as {
    guidanceId?: unknown;
    taskId?: unknown;
    answer?: unknown;
  };
  const guidanceId =
    typeof raw.guidanceId === "string" ? raw.guidanceId.trim() : "";
  const taskId = typeof raw.taskId === "string" ? raw.taskId.trim() : "";
  const answer = typeof raw.answer === "string" ? raw.answer.trim() : "";
  if (!guidanceId || !taskId || !answer) return null;
  const memoryRaw = (raw as { memory?: unknown }).memory;
  const memory = typeof memoryRaw === "string" ? memoryRaw.trim() : "";
  return {
    action: "guidance_answer",
    guidanceId,
    taskId,
    answer,
    ...(memory ? { memory } : {}),
  };
}

/**
 * Tolerant validator/normalizer for a worker `split_task` action. Returns a
 * clean {@link SplitTaskAction} only when `reason` is a non-empty string and
 * `subtasks` is an array of 2-4 entries each with a non-empty title, non-empty
 * instructions, and at least one usable outputPath; otherwise null. Fields are
 * trimmed; contextFiles/dependsOn are filtered to non-empty strings; difficulty
 * is rounded and clamped to 1-5 (dropped when non-numeric).
 */
function normalizeSplitTaskAction(parsed: unknown): SplitTaskAction | null {
  if (!parsed || typeof parsed !== "object") return null;
  const raw = parsed as {
    reason?: unknown;
    subtasks?: unknown;
  };
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  if (!reason) return null;
  if (!Array.isArray(raw.subtasks)) return null;
  if (
    raw.subtasks.length < SPLIT_MIN_SUBTASKS ||
    raw.subtasks.length > SPLIT_MAX_SUBTASKS
  )
    return null;

  const subtasks: SplitTaskAction["subtasks"] = [];
  for (const entry of raw.subtasks) {
    if (!entry || typeof entry !== "object") return null;
    const sub = entry as {
      title?: unknown;
      instructions?: unknown;
      contextFiles?: unknown;
      outputPaths?: unknown;
      dependsOn?: unknown;
      difficulty?: unknown;
    };
    const title = typeof sub.title === "string" ? sub.title.trim() : "";
    if (!title) return null;
    const instructions =
      typeof sub.instructions === "string" ? sub.instructions.trim() : "";
    if (!instructions) return null;
    const outputPaths = Array.isArray(sub.outputPaths)
      ? sub.outputPaths
          .filter((p): p is string => typeof p === "string")
          .map((p) => p.trim())
          .filter(Boolean)
      : [];
    if (outputPaths.length === 0) return null;
    const contextFiles = Array.isArray(sub.contextFiles)
      ? sub.contextFiles
          .filter((p): p is string => typeof p === "string")
          .map((p) => p.trim())
          .filter(Boolean)
      : undefined;
    const dependsOn = Array.isArray(sub.dependsOn)
      ? sub.dependsOn
          .filter((p): p is string => typeof p === "string")
          .map((p) => p.trim())
          .filter(Boolean)
      : undefined;
    const difficulty =
      typeof sub.difficulty === "number" && Number.isFinite(sub.difficulty)
        ? Math.max(1, Math.min(5, Math.round(sub.difficulty)))
        : undefined;
    subtasks.push({
      title,
      instructions,
      ...(contextFiles && contextFiles.length > 0 ? { contextFiles } : {}),
      outputPaths,
      ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
      ...(difficulty !== undefined ? { difficulty } : {}),
    });
  }

  return { action: "split_task", reason, subtasks };
}

/**
 * Scan model output for a worker `split_task` action and return the first one
 * that validates. Reuses the shared action-candidate extraction so a split can
 * appear in a ```json fence or as a bare balanced object inside prose.
 */
export function parseWorkerSplitAction(text: string): SplitTaskAction | null {
  for (const candidate of uniqueActionCandidatesInDocumentOrder(text)) {
    try {
      const parsed = JSON.parse(candidate) as { action?: unknown };
      if (parsed && typeof parsed === "object" && parsed.action === "split_task") {
        const normalized = normalizeSplitTaskAction(parsed);
        if (normalized) return normalized;
      }
    } catch {
      // not a valid JSON candidate — keep scanning
    }
  }
  return null;
}

export function isBuildToolAction(action: ArchitectAction): boolean {
  return (
    action.action === "read" ||
    action.action === "read_range" ||
    action.action === "context_retrieve" ||
    action.action === "guidance_request" ||
    action.action === "guidance_answer" ||
    action.action === "code_intel" ||
    action.action === "search" ||
    action.action === "patch" ||
    action.action === "append" ||
    action.action === "run" ||
    action.action === "tool" ||
    action.action === "fetch" ||
    action.action === "skill_request" ||
    action.action === "repo_status" ||
    action.action === "repo_diff" ||
    action.action === "repo_init" ||
    action.action === "repo_branch_create" ||
    action.action === "repo_commit" ||
    action.action === "repo_issue_list" ||
    action.action === "repo_milestone_create" ||
    action.action === "repo_issue_create" ||
    action.action === "repo_issue_read" ||
    action.action === "repo_push" ||
    action.action === "repo_pr_create"
  );
}

export function isWorkerBuildToolAction(action: ArchitectAction): boolean {
  return (
    action.action === "read" ||
    action.action === "read_range" ||
    action.action === "context_retrieve" ||
    action.action === "code_intel" ||
    action.action === "guidance_request" ||
    action.action === "search" ||
    action.action === "patch" ||
    action.action === "append" ||
    action.action === "run" ||
    action.action === "tool" ||
    action.action === "fetch"
  );
}

export function hasCompleteBuildToolAction(text: string): boolean {
  return uniqueActionCandidatesInDocumentOrder(text).some((candidate) => {
    const action = parseActionCandidate(candidate);
    return action != null && isBuildToolAction(action);
  });
}

export function isSafeFirstToolAction(action: ArchitectAction): boolean {
  return (
    action.action === "read" ||
    action.action === "read_range" ||
    action.action === "context_retrieve" ||
    action.action === "code_intel" ||
    action.action === "search" ||
    action.action === "skill_request" ||
    // Non-mutating repo inspection — safe to auto-run as the first action.
    // repo_branch_create is deliberately excluded (it mutates the repo).
    action.action === "repo_status" ||
    action.action === "repo_diff" ||
    // repo_issue_read is read-only (gh-backed) — safe to auto-run first.
    // repo_milestone_create / repo_issue_create / repo_push / repo_pr_create
    // mutate external state and are NOT safe-first.
    action.action === "repo_issue_list" ||
    action.action === "repo_issue_read"
  );
}

function isSingleFencedJson(text: string, candidate: string): boolean {
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^\\s*(?:\`\`\`|~~~)(?:json|jsonc)?\\s*\\n${escaped}\\s*\\n(?:\`\`\`|~~~)\\s*$`,
    "s"
  ).test(text.trim());
}

export function inspectStrictToolActionOutput(text: string): {
  action: ArchitectAction | null;
  valid: boolean;
  feedback?: string;
} {
  const actions = uniqueActionCandidatesInDocumentOrder(text)
    .map((candidate) => ({ candidate, action: parseActionCandidate(candidate) }))
    .filter(
      (item): item is { candidate: string; action: ArchitectAction } =>
        item.action != null && isBuildToolAction(item.action)
    );
  if (actions.length === 0) {
    if (looksLikeIncompleteToolAction(text)) {
      return {
        action: null,
        valid: false,
        feedback:
          "TOOL CALL REJECTED: your JSON tool action looks incomplete or was cut off before it became valid JSON. Reply again with exactly one smaller JSON tool action. For large patches, split the change into smaller patch operations or use append chunks.",
      };
    }
    return { action: null, valid: false };
  }
  if (actions.length > 1) {
    if (isSafeFirstToolAction(actions[0].action)) {
      return {
        action: actions[0].action,
        valid: true,
        feedback: `TOOL CALL WARNING: you emitted multiple JSON tool actions in one response (${actions.length}). I executed only the first safe inspection action (${actions[0].action.action}) and ignored the remaining action(s). Next time reply with exactly one JSON tool action, then wait for the tool result before deciding the next step.`,
      };
    }
    return {
      action: actions[0].action,
      valid: false,
      feedback: `TOOL CALL REJECTED: you emitted multiple JSON tool actions in one response (${actions.length}). The engine executes at most one tool per turn. Reply again with ONLY the single next JSON action you want executed, with no prose and no second action. After the tool result comes back, decide the next step.`,
    };
  }
  const only = actions[0];
  const trimmed = text.trim();
  const isolated =
    trimmed === only.candidate || isSingleFencedJson(trimmed, only.candidate);
  if (!isolated) {
    return {
      action: only.action,
      valid: true,
      feedback:
        "TOOL CALL WARNING: I executed the single JSON tool action, but tool calls should be the entire response. Next time reply with ONLY one JSON tool action and no prose; wait for the tool result before deciding the next step.",
    };
  }
  return { action: only.action, valid: true };
}

export interface StrictToolActionBatchInspection {
  valid: boolean;
  actions: ArchitectAction[];
  feedback?: string;
}

/**
 * Batch-aware tool inspection: parse EVERY tool action the model emitted (in
 * document order) instead of accepting only the first. The tool scheduler then
 * decides which can run together (safe reads), which queue (mutations), and
 * which are skipped — so a model can request a small batch of safe inspections
 * in one turn. Falls back to single-action inspection when no tool actions are
 * found, so non-tool (plan/review) turns keep their exact existing behavior.
 */
export function inspectStrictToolActionBatchOutput(
  text: string
): StrictToolActionBatchInspection {
  const candidates = uniqueActionCandidatesInDocumentOrder(text);
  if (hasIncompleteTrailingActionCandidate(text, candidates)) {
    return {
      valid: false,
      actions: [],
      feedback:
        "TOOL CALL REJECTED: the JSON tool action batch looks incomplete or truncated. Reply again with complete valid JSON action object(s) only, or stop using tools and provide final file output.",
    };
  }

  const actions = candidates
    .map((candidate) => parseActionCandidate(candidate))
    .filter(
      (action): action is ArchitectAction =>
        action != null && isBuildToolAction(action)
    );
  if (actions.length === 0) {
    const single = inspectStrictToolActionOutput(text);
    return {
      valid: !!single.valid && !!single.action,
      actions: single.action ? [single.action] : [],
      feedback: single.feedback,
    };
  }
  const chatty = text.trim().replace(/```json|```/g, "").trim();
  const feedback =
    actions.length > 1
      ? "TOOL CALL BATCH: multiple tool actions were requested. The engine will schedule safe actions and report served/skipped results."
      : chatty.startsWith("{")
        ? undefined
        : "TOOL CALL WARNING: tool calls should be JSON actions with no prose.";
  return { valid: true, actions, feedback };
}

function hasIncompleteTrailingActionCandidate(
  text: string,
  candidates: string[]
): boolean {
  if (candidates.length === 0) return false;
  const lastEnd = candidates.reduce((maxEnd, candidate) => {
    const start = text.lastIndexOf(candidate);
    return start >= 0 ? Math.max(maxEnd, start + candidate.length) : maxEnd;
  }, -1);
  if (lastEnd < 0) return false;
  const trailing = text.slice(lastEnd).trim();
  if (!trailing) return false;

  const normalized = trailing.replace(/^```(?:json|jsonc)?\s*/i, "").trim();
  if (!/^(?:,|\[|;)?\s*\{/.test(normalized)) return false;
  const objectStart = normalized.indexOf("{");
  return objectStart >= 0 && balancedObjectAt(normalized, objectStart) == null;
}

function looksLikeIncompleteToolAction(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!/"action"\s*:\s*"(?:read|read_range|context_retrieve|code_intel|search|patch|append|run|shell|tool|fetch|skill_request|repo_status|repo_diff|repo_init|repo_branch_create|repo_commit|repo_issue_list|repo_milestone_create|repo_issue_create|repo_issue_read|repo_push|repo_pr_create)"/i.test(trimmed)) {
    return false;
  }
  return /\{\s*"action"\s*:/i.test(trimmed) || /```(?:json|jsonc)?\s*\n\s*\{/i.test(trimmed);
}

/**
 * Parse the Architect's action from its (possibly chatty) output. The prompts
 * say "END with ONE fenced json block", so candidates are tried LAST first:
 * json/unlabelled fenced blocks, then any balanced {...} in the text.
 * Returns null when nothing parseable is found.
 */
export function parseArchitectAction(text: string): ArchitectAction | null {
  const candidates = uniqueActionCandidates(text);

  for (const candidate of candidates) {
    const action = parseActionCandidate(candidate);
    if (action) return action;
  }
  return null;
}

export function isArchitectTerminalActionForExpected(
  action: ArchitectAction | null,
  expected: ArchitectTerminalAction
): action is ArchitectAction {
  if (!action) return false;
  if (action.action === expected) return true;
  // Compatibility: old planner outputs are still valid implementation plans.
  return expected === "build_plan" && action.action === "plan";
}

// ── Plan critique gate ────────────────────────────────────────────────────────
//
// Before wave 1, a second model attacks the Architect's plan. Wrong
// decomposition is the most expensive Build failure mode, and it is far cheaper
// to catch here — one critique call, at most one bounded revision — than after
// workers have already built against a broken plan.

/** One issue a plan critic raised against the Architect's decomposition. */
export interface PlanCritiqueIssue {
  /** Task id the issue is about, when the critic named one. */
  taskId?: string;
  /** "blocking" only when the build will fail or produce wrong output otherwise. */
  severity: "blocking" | "minor";
  issue: string;
  suggestion?: string;
}

/** A parsed plan critique verdict. */
export interface PlanCritiqueResult {
  verdict: "approve" | "revise";
  issues: PlanCritiqueIssue[];
  missingWork: string[];
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizePlanCritique(parsed: unknown): PlanCritiqueResult | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = parsed as {
    verdict?: unknown;
    issues?: unknown;
    missingWork?: unknown;
  };
  if (raw.verdict !== "approve" && raw.verdict !== "revise") return null;

  const issues: PlanCritiqueIssue[] = [];
  if (Array.isArray(raw.issues)) {
    for (const entry of raw.issues) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as {
        taskId?: unknown;
        severity?: unknown;
        issue?: unknown;
        suggestion?: unknown;
      };
      const issue = normalizeTrimmedString(item.issue);
      if (!issue) continue; // an issue with no text is noise; drop it.
      issues.push({
        ...(normalizeTrimmedString(item.taskId)
          ? { taskId: normalizeTrimmedString(item.taskId) }
          : {}),
        severity: item.severity === "blocking" ? "blocking" : "minor",
        issue,
        ...(normalizeTrimmedString(item.suggestion)
          ? { suggestion: normalizeTrimmedString(item.suggestion) }
          : {}),
      });
    }
  }

  return {
    verdict: raw.verdict,
    issues,
    missingWork: normalizeStringList(raw.missingWork),
  };
}

/**
 * Scan model output for a plan critique verdict object and return the first one
 * whose `verdict` is "approve"|"revise". Reuses the shared action-candidate
 * extraction so the critique may appear in a ```json fence or as a bare balanced
 * object inside prose. Returns null when nothing matches.
 */
export function parsePlanCritique(text: string): PlanCritiqueResult | null {
  for (const candidate of uniqueActionCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      const normalized = normalizePlanCritique(parsed);
      if (normalized) return normalized;
    } catch {
      // not a valid JSON candidate — keep scanning
    }
  }
  return null;
}

/**
 * True when the critique asks for a revision AND names something that would
 * break the build if ignored: a blocking issue, or missing work. A "revise"
 * verdict carrying only minor issues does not trip this — minor notes are folded
 * into the Architect's notes instead of forcing a revision round.
 */
export function planCritiqueHasBlockingIssues(critique: PlanCritiqueResult): boolean {
  return (
    critique.verdict === "revise" &&
    (critique.issues.some((issue) => issue.severity === "blocking") ||
      critique.missingWork.length > 0)
  );
}

/**
 * Render a plan critique into a compact digest for the revision prompt: blocking
 * issues first (`- [blocking T1] issue — fix: suggestion`), then missing work
 * (`- [missing work] ...`), then minor issues (`- [minor ...] ...`), truncated
 * to `maxChars` (matching the engine's truncate: a trailing `\n…[truncated]`).
 */
export function buildPlanCritiqueDigest(
  critique: PlanCritiqueResult,
  maxChars: number
): string {
  const digestLines = [
    ...critique.issues
      .filter((i) => i.severity === "blocking")
      .map(
        (i) =>
          `- [blocking${i.taskId ? ` ${i.taskId}` : ""}] ${i.issue}${
            i.suggestion ? ` — fix: ${i.suggestion}` : ""
          }`
      ),
    ...critique.missingWork.map((w) => `- [missing work] ${w}`),
    ...critique.issues
      .filter((i) => i.severity === "minor")
      .map((i) => `- [minor${i.taskId ? ` ${i.taskId}` : ""}] ${i.issue}`),
  ];
  const digest = digestLines.join("\n");
  return digest.length <= maxChars ? digest : `${digest.slice(0, maxChars)}\n…[truncated]`;
}

// ── Tool-loop robustness: dedup, forced verdicts, conversation compaction ─────
//
// The Architect and workers run an agentic tool loop (read/search/run, then a
// terminal plan/review/file output). Two things keep that loop from spinning
// forever the way it used to: overlap-aware dedup (so a model can't dodge the
// "you already read this" guard by nudging a line range), and forced verdicts
// (when the inspection budget or dedup limit is hit we make the model commit to
// an answer instead of throwing the whole build away).

export interface ReadInterval {
  start: number;
  end: number;
}

export interface ToolCallTracker {
  /** Exact keys for whole-file reads / searches / runs / fetches / mcp calls. */
  exact: Set<string>;
  /** path (lowercased) -> merged line intervals already delivered to the model. */
  ranges: Map<string, ReadInterval[]>;
}

export function createToolCallTracker(): ToolCallTracker {
  return { exact: new Set(), ranges: new Map() };
}

/** Stable key for the non-range tool actions (read/search/run/fetch/tool). */
export function exactToolKey(action: ArchitectAction): string | null {
  switch (action.action) {
    case "read":
      return `read:${action.paths
        .map((p) => p.trim().toLowerCase())
        .sort()
        .join("|")}`;
    case "context_retrieve":
      return `context_retrieve:${action.ref.trim()}:${clampContextRetrieveMaxTokens(action.maxTokens)}:${clampContextRetrieveOffsetChars(action.offsetChars)}`;
    case "code_intel":
      return `code_intel:${action.op}:${(action.query ?? "").trim().toLowerCase()}:${(action.symbol ?? "").trim().toLowerCase()}:${(action.paths ?? [])
        .map((path) => path.trim().toLowerCase())
        .sort()
        .join("|")}:${action.limit ?? ""}`;
    case "search":
      return `search:${action.query.trim().toLowerCase()}`;
    case "run":
      return `run:${action.command.trim().toLowerCase()}`;
    case "fetch":
      return `fetch:${action.url.trim().toLowerCase()}`;
    case "tool":
      return `tool:${action.server.trim().toLowerCase()}.${action.tool
        .trim()
        .toLowerCase()}:${JSON.stringify(action.args ?? {})}`;
    case "skill_request":
      return `skill_request:${(action.target ?? "architect").trim()}:${action.ids
        .map((id) => id.trim().toLowerCase())
        .sort()
        .join("|")}`;
    case "repo_init":
      return `repo_init:${(action.branch ?? "main").trim()}`;
    case "repo_branch_create":
      // Branch creation is idempotent-by-name: re-requesting the same branch is
      // redundant. Git branch names are CASE-SENSITIVE, so do NOT lowercase —
      // "Feature/X" and "feature/x" are different branches and must not collapse
      // to one dedup key. repo_status/repo_diff intentionally fall through to
      // null — repo state legitimately changes between calls, so the Architect
      // must be able to re-query after writes (the loop caps bound runaway looping).
      return `repo_branch_create:${action.name.trim()}`;
    case "repo_commit":
      // Key by the (case-sensitive) commit message: re-emitting the identical
      // commit in the same loop is almost always a duplicate, not a second
      // intended commit. A genuine follow-up commit uses a different message.
      // The user approval gate is the real safety net; this just stops an
      // immediate accidental re-fire of the exact same action.
      return `repo_commit:${action.message.trim()}`;
    case "repo_issue_read":
      // Re-reading the same issue in one loop is redundant — its content is
      // already in context. Key by repo + issue number (repo case-insensitive
      // per GitHub; the issue number is the discriminator).
      return `repo_issue_read:${action.repo.trim().toLowerCase()}#${action.issue}`;
    case "repo_issue_list":
      return `repo_issue_list:${action.repo.trim().toLowerCase()}:${(action.labels ?? [])
        .map((label) => label.trim().toLowerCase())
        .sort()
        .join(",")}`;
    case "repo_milestone_create":
      return `repo_milestone_create:${action.repo.trim().toLowerCase()}:${action.title.trim().toLowerCase()}`;
    case "repo_issue_create":
      return `repo_issue_create:${action.repo.trim().toLowerCase()}:${action.title.trim().toLowerCase()}`;
    case "repo_push":
      // One-shot per branch: re-pushing the same branch in the same loop is
      // almost always an accidental re-fire (a genuine re-push targets a new
      // branch). Branch names are case-sensitive — do NOT lowercase.
      return `repo_push:${(action.remote ?? "origin").trim()}/${action.branch.trim()}`;
    case "repo_pr_create":
      // One-shot per (repo, head): a second PR for the same head branch in one
      // loop is a duplicate. The user approval gate is the real safety net.
      return `repo_pr_create:${(action.repo ?? "").trim().toLowerCase()}:${(action.head ?? "").trim()}`;
    default:
      return null;
  }
}

/** A requested range counts as redundant once this fraction is already shown. */
const RANGE_REDUNDANT_COVERAGE = 0.9;

function mergeInterval(
  intervals: ReadInterval[],
  add: ReadInterval
): ReadInterval[] {
  const all = [...intervals, add].sort((a, b) => a.start - b.start);
  const merged: ReadInterval[] = [];
  for (const iv of all) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end + 1) {
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ ...iv });
    }
  }
  return merged;
}

function coverageFraction(intervals: ReadInterval[], req: ReadInterval): number {
  const reqLines = req.end - req.start + 1;
  if (reqLines <= 0) return 1;
  let covered = 0;
  for (const iv of intervals) {
    const lo = Math.max(iv.start, req.start);
    const hi = Math.min(iv.end, req.end);
    if (hi >= lo) covered += hi - lo + 1;
  }
  return covered / reqLines;
}

/**
 * Is this read/read_range action redundant given what the model has already been
 * shown? For read_range we use line-interval COVERAGE, so a model can't dodge
 * the guard by nudging startLine/lineCount (e.g. 265/100 then 265/80) — a range
 * ≥90% already delivered counts as redundant. read/search/run/fetch/tool use an
 * exact key.
 */
export function isRedundantToolCall(
  tracker: ToolCallTracker,
  action: ArchitectAction
): boolean {
  if (action.action === "read_range") {
    const path = action.path.trim().toLowerCase();
    const start = Math.max(1, Math.round(action.startLine));
    const end = start + Math.max(1, Math.round(action.lineCount)) - 1;
    const intervals = tracker.ranges.get(path);
    if (!intervals || intervals.length === 0) return false;
    return coverageFraction(intervals, { start, end }) >= RANGE_REDUNDANT_COVERAGE;
  }
  const key = exactToolKey(action);
  if (!key) return false;
  return tracker.exact.has(key);
}

/**
 * Record a delivered tool result so future identical/overlapping calls are
 * caught. For read_range pass the ACTUAL delivered span when known (the runner
 * may cap or clip the requested range); otherwise the requested span is used.
 */
export function recordToolCall(
  tracker: ToolCallTracker,
  action: ArchitectAction,
  delivered?: { startLine: number; endLine: number }
): void {
  if (action.action === "read_range") {
    const path = action.path.trim().toLowerCase();
    const start = delivered
      ? delivered.startLine
      : Math.max(1, Math.round(action.startLine));
    const end = delivered
      ? delivered.endLine
      : start + Math.max(1, Math.round(action.lineCount)) - 1;
    if (end < start) return;
    tracker.ranges.set(
      path,
      mergeInterval(tracker.ranges.get(path) ?? [], { start, end })
    );
    return;
  }
  const key = exactToolKey(action);
  if (key) tracker.exact.add(key);
}

export type ToolCallResultStatus = "ok" | "error" | "denied";

export function shouldRecordToolCallResult(
  action: ArchitectAction,
  status: ToolCallResultStatus
): boolean {
  if (action.action !== "tool") return true;
  return status === "ok" || status === "denied";
}

export const DUPLICATE_TOOL_CALL_FEEDBACK =
  "DUPLICATE TOOL CALL REJECTED: you already received this exact (or a fully overlapping) read/search/command result — it is already in this conversation above. Do not repeat it. Read a DIFFERENT range/file, search a different term, or produce your decision JSON now.";

export const FORCED_REVIEW_INSTRUCTION = [
  "STOP USING TOOLS. You have used your inspection budget for this review (or repeated the same lookups). Any further read/search/command requests will be IGNORED.",
  "Using ONLY the file contents, change digests, and tool results already in this conversation, produce your final review now as exactly ONE fenced ```json block matching the review schema.",
  "For every reviewed task, return both `specVerdict` and `qualityVerdict`. If a task is not explicitly verified, has unresolved write/tool issues, is missing required skill evidence, misses the current phase spec, has code-quality problems, or is a web app without browser acceptance evidence, set the relevant gate to `fix` with concrete instructions. Also return requestFulfillment and do NOT set done=true unless requestFulfillment.reviewed=true and requestFulfillment.satisfied=true. Approve only tasks whose spec and quality gates are demonstrably complete.",
].join("\n");

export const FORCED_PLAN_INSTRUCTION = [
  "STOP USING TOOLS. You have used your inspection budget for planning. Any further read/search/command requests will be IGNORED.",
  "Using only what you already have, produce your plan now as exactly ONE fenced ```json block matching the plan schema.",
].join("\n");

export interface ConversationMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompactToolConversationPlaceholderInput<
  T extends ConversationMessage,
> {
  omitted: T[];
  head: T[];
  tail: T[];
  totalChars: number;
  maxChars: number;
}

/**
 * Bound a tool-loop conversation so it can never grow past a char budget. Keeps
 * the system + initial instruction (indices 0-1) and the most recent
 * `keepRecent` messages verbatim; older tool-result turns in between collapse
 * into a single placeholder. Returns a NEW array (input untouched) plus how many
 * messages were folded away, so the caller can log it.
 */
export function compactToolConversation<T extends ConversationMessage>(
  messages: T[],
  maxChars: number,
  keepRecent = 6,
  buildPlaceholder?: (
    input: CompactToolConversationPlaceholderInput<T>
  ) => T
): { messages: T[]; compacted: number } {
  const total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total <= maxChars || messages.length <= keepRecent + 3) {
    return { messages, compacted: 0 };
  }
  const head = messages.slice(0, 2);
  const tail = messages.slice(messages.length - keepRecent);
  const omittedMessages = messages.slice(head.length, messages.length - keepRecent);
  const omitted = messages.length - head.length - tail.length;
  if (omitted <= 0) return { messages, compacted: 0 };
  const placeholder =
    buildPlaceholder?.({
      omitted: omittedMessages,
      head,
      tail,
      totalChars: total,
      maxChars,
    }) ??
    ({
      role: "user",
      content: `[${omitted} earlier tool exchange(s) omitted to stay within the context budget - rely on the file contents and results retained above and below; do not re-request them.]`,
    } as T);
  return { messages: [...head, placeholder, ...tail], compacted: omitted };
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const ARCHITECT_ROLE =
  "You are the Architect — the senior engineer orchestrating a team of AI worker models building a project for the user. You plan tasks, review the workers' output, fix problems, and decide when the project is done. Be decisive and concrete; the workers only know what you put in their task instructions.";

function treeSection(treeText: string): string {
  return treeText.trim()
    ? `Current project files:\n${treeText}`
    : "The project folder is currently empty.";
}

function userNotesSection(notes?: string): string {
  return notes?.trim()
    ? `NOTES FROM THE USER (added while the team was building — treat them as requirements and address every one):\n${notes}`
    : "";
}

function bulletList(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- None declared.";
}

export function buildPhaseSpecSection(phaseSpec?: BuildPhaseSpec): string {
  if (!phaseSpec) return "";
  return [
    `Current phase spec (${phaseSpec.id}):`,
    `Objective: ${phaseSpec.objective}`,
    "Acceptance criteria:",
    bulletList(phaseSpec.acceptanceCriteria),
    "Code-quality criteria:",
    bulletList(phaseSpec.qualityCriteria),
    "Verification expectations:",
    bulletList(phaseSpec.verification),
    phaseSpec.constraints?.length
      ? `Constraints:\n${bulletList(phaseSpec.constraints)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const WEB_APP_BROWSER_ACCEPTANCE_INSTRUCTION = [
  "For web apps or UI-affecting tasks, browser acceptance is required when a local server and browser/MCP tools are available.",
  "Exercise the main user workflow in a real browser after starting the app: load the page, perform the primary form/click/navigation actions, and inspect the post-action settled state.",
  "Report a structured acceptance record with these exact fields when they apply: canvasPresent, webglContext, labelCount, screenshotTaken, visualQualityReviewed, visibleOutputMatchesRequest, requestedVisualCriteriaMet, pixelChangedAfterRun, startPauseWorked, resetWorked, newArenaChanged, speedChanged, ammoApplied, consoleErrors.",
  "For requests with visual, layout, media, animation, or interactive output, visibleOutputMatchesRequest must judge the screenshot or settled UI against the user-requested appearance and behavior.",
  "Verify expected content is visible and there are no console errors, visible stuck loading indicators, error banners, blank screens, or blocking overlays. If you cannot run browser acceptance, say exactly what was not verified and do not claim it passed.",
].join(" ");

const WORKER_SKILL_EVIDENCE_INSTRUCTION = [
  "If the active skills require evidence, include a brief `Skill evidence:` section in your final prose. Use the exact gate wording that applies; do not invent evidence you did not actually gather.",
  "Skill evidence:",
  "- agent:test-driven-development: RED test/check failure before implementation: <command or check and failing result>; GREEN test/check pass after implementation: <command or check and passing result>.",
  "- superpowers:systematic-debugging: Root cause or reproduction identified before the fix: <root cause, reproduction, hypothesis, or trace>; Fix verified against the reproduced failure: <command, test, or browser result>.",
  "- agent:security-and-hardening: Trust boundary reviewed and unsafe case considered: <untrusted input, secret, file path, shell, network, or storage boundary and the unsafe case considered>.",
  "- aiboard:browser-acceptance: browser_navigate <exact local URL>; structured fields canvasPresent, webglContext, labelCount, screenshotTaken, visualQualityReviewed, visibleOutputMatchesRequest, requestedVisualCriteriaMet, pixelChangedAfterRun, startPauseWorked, resetWorked, newArenaChanged, speedChanged, ammoApplied, consoleErrors; browser_snapshot/browser_evaluate expected content visible, no visible stuck loading, no error banner, no blank screen, no blocking overlay; browser_console_messages returned no console errors.",
  "Only include lines for active/applicable skills or explicit exemption reasons.",
].join("\n");

function searchToolDoc(searchesLeft?: number): string {
  if (!searchesLeft || searchesLeft <= 0) return "";
  return [
    "TOOL — search the project: to find where something is defined or used (instead of guessing paths), respond with ONLY:",
    '{"action":"search","query":"text to find","reason":"why"}',
    `Case-insensitive substring match across all project files; results come back as path:line: text. ${searchesLeft} search${searchesLeft === 1 ? "" : "es"} left in this phase.`,
  ].join("\n");
}

function readRangeToolDoc(rangeReadsLeft?: number): string {
  if (!rangeReadsLeft || rangeReadsLeft <= 0) return "";
  return [
    "TOOL - read part of a file: when the change digest points at a large file and you only need exact nearby lines, respond with ONLY:",
    '{"action":"read_range","path":"relative/path","startLine":40,"lineCount":80}',
    `The result is bounded and includes line numbers. Prefer this over whole-file reads for large files. If a returned range is partial, continue from endLine + 1 instead of rereading overlapping lines unless you truly need overlap. After search results, read_range around the matching line numbers, not from the start of the file. ${rangeReadsLeft} range read${rangeReadsLeft === 1 ? "" : "s"} left in this review.`,
  ].join("\n");
}

function contextRetrieveToolDoc(): string {
  return [
    "TOOL - retrieve old compacted context: when a digest shows a Ref like ctx_..., request bounded exact text with ONLY:",
    `{"action":"context_retrieve","ref":"ctx_...","maxTokens":${CONTEXT_RETRIEVE_DEFAULT_TOKENS},"offsetChars":0,"reason":"why you need the exact omitted text"}`,
    "The result is exact text from that character offset up to the requested cap; it reports omitted text before/after. For later pages, increase offsetChars by the returned character count. Do not use this for current source files - read/read_range current files instead.",
  ].join("\n");
}

function codeIntelToolDoc(
  status?: string,
  callsLeft?: number
): string {
  if (!status?.trim() || !callsLeft || callsLeft <= 0) return "";
  return [
    "TOOL - code intelligence: use read-only structural codebase intelligence before broad file-by-file exploration. Respond with ONLY one JSON action:",
    '{"action":"code_intel","op":"architecture","reason":"orient on the repo structure"}',
    '{"action":"code_intel","op":"search_symbols","query":"BuildContextManager","limit":8,"reason":"find definitions/usages"}',
    '{"action":"code_intel","op":"trace_symbol","symbol":"runBuildDiscussion","limit":8,"reason":"trace callers/callees"}',
    '{"action":"code_intel","op":"detect_change_impact","paths":["lib/client/build-engine.ts"],"limit":8,"reason":"review blast radius"}',
    `Status: ${status.trim()}`,
    `Operations are bounded and read-only; if MCP code intelligence is unavailable or errors, AIBoard falls back to native tree/search summaries. ${callsLeft} code_intel call${callsLeft === 1 ? "" : "s"} left in this phase.`,
  ].join("\n");
}

/**
 * How models modify EXISTING files: targeted SEARCH/REPLACE edit blocks
 * instead of re-emitting whole files (cheaper, and immune to truncation
 * corrupting untouched parts of the file).
 */
export const EDIT_BLOCK_INSTRUCTION = [
  "To MODIFY an existing file, emit a targeted edit block instead of re-emitting the whole file:",
  "```edit path=src/example.js",
  "<<<<<<< SEARCH",
  "(copy the exact current lines being replaced — include enough surrounding lines to be unique)",
  "=======",
  "(the replacement lines)",
  ">>>>>>> REPLACE",
  "```",
  "The SEARCH text must match the current file content verbatim. Multiple SEARCH/REPLACE sections are allowed in one block. Use full ```lang path=... blocks only for NEW files or small complete rewrites; never use them for large existing files.",
].join("\n");

function mcpToolDoc(mcpToolsDoc?: string, mcpCallsLeft?: number): string {
  if (!mcpToolsDoc?.trim() || !mcpCallsLeft || mcpCallsLeft <= 0) return "";
  return [
    "TOOL — MCP tools (via the user's local runner; e.g. drive a real browser to verify your build). To call one, respond with ONLY:",
    '{"action":"tool","server":"<server>","tool":"<tool name>","args":{ /* per the tool\'s signature */ },"reason":"why"}',
    `The result comes back to you as text. Each tool below shows its exact argument names as name: type ("?" = optional) — use EXACTLY those names in "args". ${mcpCallsLeft} tool call${mcpCallsLeft === 1 ? "" : "s"} left in this phase. The user may deny a call — respect that and continue. Available tools:`,
    mcpToolsDoc,
  ].join("\n");
}

function playwrightWorkerToolDoc(
  mcpToolsDoc: string | undefined,
  localServers: string[]
): string {
  if (!mcpToolsDoc?.toLowerCase().includes("playwright")) return "";
  const url = localServers[0] ?? "http://localhost:<port>";
  return [
    "PLAYWRIGHT MCP CONTRACT:",
    `- Navigate with exactly: {"action":"tool","server":"playwright","tool":"browser_navigate","args":{"url":"${url}"},"reason":"open the app under test"}`,
    '- Inspect visible UI with exactly: {"action":"tool","server":"playwright","tool":"browser_snapshot","args":{},"reason":"capture settled UI state"}',
    '- Check console errors with exactly: {"action":"tool","server":"playwright","tool":"browser_console_messages","args":{"level":"error"},"reason":"check browser console errors"}',
    '- After browser_snapshot, use exact element refs from the snapshot as "target" for user interactions; do not guess labels, CSS selectors, or accessible names when a ref is available.',
    '- Type into a control with exactly: {"action":"tool","server":"playwright","tool":"browser_type","args":{"target":"e19","element":"Local Repository Path textbox","text":"C:\\\\Users\\\\...\\\\CodeSketch"},"reason":"enter repository path"}',
    '- Click a control with exactly: {"action":"tool","server":"playwright","tool":"browser_click","args":{"target":"e24","element":"Analyze Repository button"},"reason":"start analysis"}',
    '- Fill a form with exactly: {"action":"tool","server":"playwright","tool":"browser_fill_form","args":{"fields":[{"name":"Local Repository Path","type":"textbox","target":"e19","value":"C:\\\\Users\\\\...\\\\CodeSketch"}]},"reason":"fill form from snapshot refs"}',
    '- For browser_fill_form fields, use "target". Do not use "ref". If a Playwright error says the target is invalid, call browser_snapshot again and use the latest ref.',
    '- Use browser_evaluate only for DOM/page-state checks after browser_navigate; never put require, child_process, process, fs, npm, shell commands, or project file reads in browser_evaluate.',
    '- After the main workflow settles, capture ONE screenshot for the reviewer with exactly: {"action":"tool","server":"playwright","tool":"browser_take_screenshot","args":{},"reason":"visual acceptance evidence"}',
    '- Do not emit bare calls such as {"action":"browser_snapshot"}. Do not use "arguments" instead of "args". Do not put MCP actions in arrays. Do not concatenate multiple JSON objects without waiting for tool results when the next action depends on the prior result.',
    "- Browser acceptance evidence must name the URL, the action performed, the visible settled result, stuck-loading/error/blank/overlay absence, console result, and for visual, layout, media, animation, or interactive output the screenshot-reviewed visibleOutputMatchesRequest and requestedVisualCriteriaMet fields.",
  ].join("\n");
}

function skillRequestDoc(): string {
  return [
    "TOOL — skill request: if the compact skill index shows a relevant skill that is not currently active, the Architect may request it for a future turn. AIBoard validates ids, conflicts, and budgets; workers cannot self-load skills. Respond with ONLY:",
    '{"action":"skill_request","ids":["agent:security-and-hardening"],"reason":"why this skill is needed","target":"architect","mode":"compact"}',
    'Targets: "architect" for this planning/review loop, "next_worker" for the next worker task, or "reviewer" for the next review. Full mode may be requested, but the engine may downgrade to compact.',
  ].join("\n");
}

export function extractLocalServerUrls(text: string): string[] {
  const urls = new Set<string>();
  const directUrl = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})(?:\/[^\s"'`)]*)?/gi;
  for (const match of text.matchAll(directUrl)) {
    urls.add(match[0].replace(/[.,;]+$/, ""));
  }

  const portFlags =
    /(?:^|\s)(?:-p|--port|--port=|-l|--listen|--listen=)\s*=?\s*(\d{2,5})(?=\s|$)/gi;
  for (const match of text.matchAll(portFlags)) {
    const port = Number(match[1]);
    if (port > 0 && port <= 65535) urls.add(`http://localhost:${port}`);
  }

  const hostPort = /\b(?:localhost|127\.0\.0\.1):(\d{2,5})\b/gi;
  for (const match of text.matchAll(hostPort)) {
    const port = Number(match[1]);
    if (port > 0 && port <= 65535) urls.add(`http://localhost:${port}`);
  }

  return [...urls].slice(0, 5);
}

export function buildWorkerToolInstructions(budget: {
  reads: number;
  rangeReads: number;
  searches: number;
  runs?: number;
  fetches?: number;
  patches: number;
  appends: number;
  mcpToolsDoc?: string;
  mcpCallsLeft?: number;
  localServerUrls?: string[];
  shellHint?: string;
  allowSplit?: boolean;
  codeIntelStatus?: string;
  codeIntelCallsLeft?: number;
}): string {
  const localServers = [...new Set(budget.localServerUrls ?? [])].filter(Boolean);
  return [
    "TOOLS - before your final answer, you may inspect, verify, or patch by responding with one or more JSON tool actions (and nothing else). The engine runs safe reads/searches together, applies writes in order, keeps MCP calls approval-gated, and reports which were served or skipped:",
    budget.reads > 0
      ? `- Read whole small files: {"action":"read","paths":["src/file.ts"]} (${budget.reads} left).`
      : "",
    budget.rangeReads > 0
      ? `- Read part of a file: {"action":"read_range","path":"src/file.ts","startLine":40,"lineCount":80} (${budget.rangeReads} left). Prefer this for large files. If a returned range is partial, continue from endLine + 1 instead of rereading overlapping lines unless you truly need overlap.`
      : "",
    budget.searches > 0
      ? `- Search project text: {"action":"search","query":"functionName"} (${budget.searches} left). After search results, read_range around the returned path:line matches, not from the start of the file.`
      : "",
    codeIntelToolDoc(budget.codeIntelStatus, budget.codeIntelCallsLeft),
    budget.runs && budget.runs > 0
      ? `- Run project checks: {"action":"run","command":"npm test","reason":"verify the reproduced failure"} (${budget.runs} left). Use simple project-root commands only; no cd, pipes, redirects; no installs or file writes. Long-lived dev servers/watchers are allowed only for browser acceptance and must be background commands with one trailing & after a host-valid command. Reuse active local server URLs before starting another server; do not move to a new port unless the current server is demonstrably unusable.`
      : "",
    budget.shellHint?.trim()
      ? `- Runner shell environment: ${budget.shellHint.trim()} Use commands valid for this host shell. For background dev servers/watchers, append one trailing & only after a command that is valid for that shell.`
      : "",
    budget.fetches && budget.fetches > 0
      ? `- Fetch a PUBLIC docs/API-reference URL through the user's runner: {"action":"fetch","url":"https://example.com/docs","reason":"why"} (${budget.fetches} left). Known URLs only — this is not a search engine; local/private addresses are refused. The user may deny a fetch — respect that and continue.`
      : "",
    `- Retrieve compacted old context by ref: {"action":"context_retrieve","ref":"ctx_...","maxTokens":${CONTEXT_RETRIEVE_DEFAULT_TOKENS},"offsetChars":0,"reason":"why"} when a prior digest includes a ctx_ ref. This returns exact stored text from that character offset up to the cap; use read/read_range for current source files.`,
    '- Ask the Architect for task-local guidance: {"action":"guidance_request","mode":"blocking","question":"specific question","reason":"why Architect guidance is needed"} or mode "async". Use blocking when you cannot safely proceed without the answer. Use async when you can continue and want the answer on a later same-task iteration. Emit guidance_request by itself, with no other actions or prose.',
    budget.patches > 0
      ? `- Patch an existing file exactly: {"action":"patch","path":"src/file.ts","ops":[{"search":"copy exact current text","replace":"replacement text"}],"reason":"why"} (${budget.patches} left).`
      : "",
    budget.appends > 0
      ? `- Create or extend a large/missing file in chunks: {"action":"append","path":"tests/run-tests.ts","content":"chunk text","reset":true,"reason":"start file"} then more append actions with reset false/omitted (${budget.appends} left).`
      : "",
    "TOOL SIZE RULE: keep each JSON tool action small. If a tool call would be long or was rejected as incomplete, reply with one smaller JSON tool action; split large patch changes into smaller SEARCH/REPLACE patch ops or use append chunks for large/missing files.",
    mcpToolDoc(budget.mcpToolsDoc, budget.mcpCallsLeft),
    playwrightWorkerToolDoc(budget.mcpToolsDoc, localServers),
    budget.mcpToolsDoc?.toLowerCase().includes("playwright")
      ? `MCP browser/Playwright tools are for browser/page inspection only. Do NOT use Playwright/MCP tools to run npm, shell, Node, tests, read project files, or inspect the filesystem; ${
          budget.runs && budget.runs > 0
            ? 'use {"action":"run"} for shell checks'
            : "do not request shell checks when no run action is listed"
        } and read/read_range/search for files. For Playwright browser_navigate, use the exact app URL and never navigate to about:blank. For browser_console_messages, use level error, warning, info, or debug only.`
      : "",
    budget.mcpToolsDoc?.toLowerCase().includes("playwright")
      ? "REAL-BROWSER ACCEPTANCE: for web apps, use the active local server URL for real-browser acceptance. Exercise the main workflow and verify the post-action settled state: expected content visible, no visible stuck loading, no error banner, no blank screen, no blocking overlay, and no console errors."
      : "",
    localServers.length > 0
      ? `Active local server URL${localServers.length === 1 ? "" : "s"} for browser MCP navigation: ${localServers.join(", ")}. Use these exact URL(s) instead of guessing localhost ports; do not start another server unless these fail after a fresh navigation/snapshot attempt.`
      : "",
    budget.allowSplit
      ? [
          "ESCAPE HATCH — split an oversized task: if you genuinely cannot complete this task well in one response, END your turn with ONLY:",
          '{"action":"split_task","reason":"why this must be decomposed","subtasks":[{"title":"...","instructions":"complete self-contained instructions","outputPaths":["files this subtask owns"],"dependsOn":[],"difficulty":3},{"title":"...","instructions":"...","outputPaths":["another file"],"dependsOn":["1"],"difficulty":3}]}',
          `${SPLIT_MIN_SUBTASKS}-${SPLIT_MAX_SUBTASKS} subtasks; each must own disjoint outputPaths within your task's declared files; dependsOn lists earlier sibling ordinals ("1", "2", ...) — a subtask may only depend on earlier siblings. Splitting ends your turn — do not also emit files. Use this ONCE and only when truly necessary; prefer completing the task.`,
        ].join("\n")
      : "",
    "Patch SEARCH text must come from the current file content. If a patch fails, read/search and try again. Do not emit full-file blocks for existing files. For large or missing files, use append chunks instead of one giant fenced block.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildSpecSection(spec?: BuildSpec): string {
  if (!spec) return "";
  return [
    `Architect spec (${spec.id}):`,
    `Objective: ${spec.objective}`,
    "Requirements:",
    bulletList(spec.requirements),
    spec.nonGoals?.length ? `Non-goals:\n${bulletList(spec.nonGoals)}` : "",
    "Acceptance criteria:",
    bulletList(spec.acceptanceCriteria),
    "Code-quality criteria:",
    bulletList(spec.qualityCriteria),
    "Verification expectations:",
    bulletList(spec.verification),
    spec.constraints?.length ? `Constraints:\n${bulletList(spec.constraints)}` : "",
    spec.implementationDecisions?.length
      ? `Architect implementation decisions:\n${bulletList(spec.implementationDecisions)}`
      : "",
    spec.risks?.length ? `Risks and edge cases:\n${bulletList(spec.risks)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderTaskGuidanceForWorker(
  guidance?: BuildTaskGuidance[]
): string {
  const records = guidance ?? [];
  const answered = records.filter(
    (item) => item.status === "answered" && item.answer?.trim()
  );
  const pending = records.filter((item) => item.status === "pending");
  const sections: string[] = [];
  if (answered.length > 0) {
    sections.push(
      [
        "ARCHITECT GUIDANCE FOR THIS TASK",
        ...answered.flatMap((item) => [
          "",
          `Guidance ${item.id}`,
          "Worker question:",
          item.question,
          item.reason ? `Reason:\n${item.reason}` : "",
          "Architect answer:",
          item.answer ?? "",
        ]),
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  if (pending.length > 0) {
    sections.push(
      [
        "PENDING GUIDANCE REQUESTS",
        ...pending.map(
          (item) =>
            `Guidance ${item.id} is still waiting for Architect response.\nWorker question: ${item.question}\nContinue only if the task is safe without it.`
        ),
      ].join("\n\n")
    );
  }
  return sections.join("\n\n");
}

function fetchToolDoc(fetchesLeft?: number): string {
  if (!fetchesLeft || fetchesLeft <= 0) return "";
  return [
    "TOOL — fetch a web page: the user's local runner can retrieve a PUBLIC http(s) URL for you (docs, READMEs, API references). This fetches a KNOWN URL — it is not a search engine. To fetch, respond with ONLY:",
    '{"action":"fetch","url":"https://example.com/docs","reason":"why"}',
    `The page text comes back to you (truncated to a safe size). Local/private addresses are refused. ${fetchesLeft} fetch${fetchesLeft === 1 ? "" : "es"} left in this phase. The user may deny a fetch — respect that and continue.`,
  ].join("\n");
}

/**
 * GitHub issue-to-PR guidance.
 *
 * When the runner exposes the typed `/repo/*` endpoints (`typedRepoAvailable`),
 * the workflow is driven by the TYPED actions (repo_issue_read / repo_commit /
 * repo_push / repo_pr_create) documented by `repoToolDoc` — so this doc must NOT
 * instruct the model to run raw `gh pr create` / `git push` commands. It only
 * sets the high-level strategy (issue selection, branch-per-issue) and points at
 * the typed actions.
 *
 * COMPATIBILITY FALLBACK: for older runners WITHOUT the `/repo/*` endpoints
 * (`typedRepoAvailable` false), the model has no typed path, so this keeps the
 * raw-command instructions — non-interactive `gh`/`git` through the run tool,
 * with the budget exemption — exactly as before.
 */
function githubWorkflowDoc(
  enabled?: boolean,
  typedRepoAvailable?: boolean,
  labels?: string[]
): string {
  if (!enabled) return "";
  const labelLine =
    labels && labels.length > 0
      ? `Labels: this repo already has these labels — ${labels.join(", ")}. Prefer an existing label when one fits. You MAY attach a brand-new label via the issue "labels" field (the engine creates it automatically), but keep the label set small: reuse labels across related issues and do not over-populate it with near-duplicates.`
      : `Labels: you may attach labels via the issue "labels" field; missing labels are created automatically, but keep the set small and reuse labels across related issues rather than inventing many.`;
  if (typedRepoAvailable) {
    return [
      "GITHUB WORKFLOW SKILL - the user asked you to handle GitHub issue-to-PR work for the provided repository.",
      "Drive the whole workflow through the TYPED repo actions documented above (repo_issue_list, repo_milestone_create, repo_issue_create, repo_issue_read, repo_branch_create, repo_commit, repo_push, repo_pr_create) — never raw shell commands for issues, milestones, commits, pushing, or opening pull requests.",
      "If the user asks to create milestones/issues, create REAL GitHub milestones/issues with repo_milestone_create and repo_issue_create; do not substitute local roadmap markdown files.",
      labelLine,
      "Issue selection: first use repo_issue_list on the provided repo. Prefer an open issue whose title/body mentions `#aiboard` or `@aiboard`; if none exists and the request is new feature work, create a milestone and task issues, then use the primary created issue as the implementation target.",
      "Before assigning worker tasks, the engine establishes a safe feature branch (or you can request repo_branch_create with an issue-numbered name).",
      "Turn the selected issue into focused worker tasks, then review/fix/verify normally. At the end commit via repo_commit, push via repo_push, and open a DRAFT PR via repo_pr_create that references the issue.",
      "For this explicit GitHub workflow, typed repo mutations can run without extra in-app approval prompts; human approval happens by reviewing and merging the draft PR on GitHub.",
    ].join("\n");
  }
  return [
    "GITHUB WORKFLOW SKILL - the user asked you to handle GitHub issue-to-PR work for the provided repository.",
    "This runner does not expose the typed repo endpoints, so use non-interactive `gh` and `git` commands through the run tool. Assume `gh` is installed and authenticated.",
    "Issue selection: list open issues, prefer an issue whose title/body/comments contain `#aiboard` or `@aiboard`; if none exists and the user asks for new planning artifacts, create real GitHub milestones/issues with `gh`, then use the primary created issue as the implementation target.",
    "Before assigning worker tasks, create and switch to a feature branch for the chosen issue. Use a clear branch name that includes the issue number when available.",
    "Turn the selected issue into focused worker tasks, then review/fix/verify normally. At the end, commit the intended changes, push the feature branch, and create a PR that references the issue.",
    "When typed repo endpoints are unavailable, raw shell commands may still follow the runner's command-approval mode; human approval for the completed work happens on GitHub when reviewing and merging the PR.",
    labelLine,
    "GitHub workflow commands beginning with `gh` or `git` do not count against the normal command budget, but still run one command at a time and must be non-interactive.",
  ].join("\n");
}

function repoToolDoc(
  repoWorkflow?: boolean,
  githubCli?: { available: boolean; authenticated: boolean },
  githubWorkflow?: boolean
): string {
  if (!repoWorkflow) return "";
  const repoMutationNote = githubWorkflow
    ? "This MUTATES repo state. Because this is an explicit GitHub workflow, this typed action can run without an extra in-app approval prompt; PR review/merge is the human gate."
    : "This MUTATES the repo, so it needs the user's approval; the user may deny it — respect that and continue.";
  const githubMutationNote = githubWorkflow
    ? "This MUTATES external GitHub state. Because this is an explicit GitHub workflow, this typed action can run without an extra in-app approval prompt; PR review/merge is the human gate."
    : "This MUTATES external state, so it needs the user's approval; the user may deny it — respect that and continue.";
  const lines = [
    "TOOL — repo (Git): the runner folder exposes typed Git operations. Use these TYPED actions instead of raw `git`/`gh` commands. Emit exactly one JSON action per turn and wait for the result before the next.",
    '- Status: {"action":"repo_status","reason":"why"} — reports whether the runner folder is a Git repo, plus current branch, dirty file counts, and ahead/behind when it is. Non-mutating; re-query freely after writes.',
    `- Initialize repo: {"action":"repo_init","branch":"main","reason":"why"} — runs git init in the runner folder when it is not already a repo. Branch is optional and defaults to "main". ${repoMutationNote} Use this when the user asks to create a local Git repo.`,
    '- Diff: {"action":"repo_diff","paths":["optional/scope"],"staged":false,"stat":false,"reason":"why"} — a bounded diff; "stat" gives a summary, "staged" diffs the index. Non-mutating. Available after the folder is a Git repo.',
    `- Create branch: {"action":"repo_branch_create","name":"feature/topic","base":"main","checkout":true,"reason":"why"} — creates (and by default checks out) a branch. Branch names allow letters, digits, ".", "_", "/", "-" only. ${repoMutationNote}`,
    `- Commit: {"action":"repo_commit","message":"feat: add X","paths":["optional/scope"],"reason":"why"} — stages and commits. Omit "paths" to commit everything pending, or list relative paths to commit only those. The message must be 1–${REPO_COMMIT_MESSAGE_MAX} chars. ${repoMutationNote} ONLY available after a safe feature branch exists. Do NOT run \`git commit\`/\`git add\` as a raw command — use this typed action.`,
  ];
  // The GitHub (issue/push/PR) actions only work when the runner reports an
  // installed AND authenticated GitHub CLI — advertise them only then, so the
  // model never attempts a workflow the runner can't fulfil.
  if (githubCli?.available && githubCli?.authenticated) {
    lines.push(
      `- List issues: {"action":"repo_issue_list","repo":"owner/repo","labels":["optional"],"limit":20,"reason":"why"} — lists open issues with title/body snippets. Non-mutating. Use this before selecting work; prefer issues mentioning #aiboard or @aiboard.`,
      `- Create milestone: {"action":"repo_milestone_create","repo":"owner/repo","title":"Milestone title","description":"optional","reason":"why"} — creates or reuses a GitHub milestone. ${githubMutationNote}`,
      `- Create issue: {"action":"repo_issue_create","repo":"owner/repo","title":"Issue title","body":"task details","milestone":"optional milestone title","labels":["optional"],"reason":"why"} — creates a GitHub issue. ${githubMutationNote}`,
      `- Import issue: {"action":"repo_issue_read","repo":"owner/repo","issue":42,"reason":"why"} — fetches a GitHub issue's title, body, and comments as task context. Non-mutating.`,
      `- Push branch: {"action":"repo_push","branch":"feature/topic","remote":"origin","setUpstream":true,"reason":"why"} — pushes the branch to the remote. ${githubMutationNote}`,
      `- Open pull request: {"action":"repo_pr_create","title":"Fix ...","body":"...","base":"main","head":"feature/topic","draft":true,"reason":"why"} — opens a PR. PREFER DRAFT PRs (draft defaults to true). Requires at least one committed change on the feature branch first. ${githubMutationNote} Always use these typed push/PR actions — never raw shell commands for pushing or opening pull requests.`
    );
  }
  return lines.join("\n");
}

function runToolDoc(
  runsLeft?: number,
  shellHint?: string,
  githubWorkflow?: boolean,
  /** Whether the runner exposes the typed /repo/* endpoints — switches the
   * GitHub workflow doc from raw-command instructions to "use typed actions". */
  typedRepoAvailable?: boolean,
  /** Existing GitHub label names so the model can prefer them. */
  githubLabels?: string[]
): string {
  if ((!runsLeft || runsLeft <= 0) && !githubWorkflow) return "";
  return [
    "TOOL — run commands: the user granted you a local runner that executes shell commands in the project folder. Use it to install dependencies, run tests, build, or inspect the environment. To run a command, respond with ONLY:",
    '{"action":"run","command":"npm test","reason":"verify the suite passes"}',
    "Commands must NOT edit project files: do not use fs.writeFileSync, redirection, Set-Content, sed -i, rm/move/copy, or scripts that modify source files. Use patch/append/edit output for file changes, then run commands only to verify or inspect.",
    githubWorkflowDoc(githubWorkflow, typedRepoAvailable, githubLabels),
    runsLeft && runsLeft > 0
      ? `One non-interactive command at a time (no editors/watch modes/prompts); stdout, stderr, and the exit code come back to you. ${runsLeft} normal run${runsLeft === 1 ? "" : "s"} left in this phase. The user may deny a command — respect that and continue without it.`
      : typedRepoAvailable
        ? "Normal command budget is exhausted; continue via the typed repo actions above."
        : "Only GitHub workflow `gh`/`git` commands are currently available; normal command budget is exhausted.",
    "Long-lived dev servers/watchers must be intentional background commands: add a single trailing `&` (example: `npx serve . -l 3000 --no-clipboard &`). The runner returns after a short startup window and keeps that process alive until the runner exits. Do not add `&` to normal finite commands like tests/builds.",
    shellHint?.trim() ? shellHint.trim() : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildArchitectSpecPrompt(input: BuildPromptContextInput & {
  request: string;
  treeText: string;
  fileContext: string;
  workerNames: string[];
  workerCapabilities?: BuildWorkerCapabilitySummary[];
  readHopsLeft: number;
  runsLeft?: number;
  searchesLeft?: number;
  codeIntelStatus?: string;
  codeIntelCallsLeft?: number;
  fetchesLeft?: number;
  mcpToolsDoc?: string;
  mcpCallsLeft?: number;
  userNotes?: string;
  scoreboard?: string;
  shellHint?: string;
  githubWorkflow?: boolean;
  repoWorkflow?: boolean;
  githubCli?: { available: boolean; authenticated: boolean };
  githubLabels?: string[];
  previousSummary?: string;
  memoryBrief?: string;
  skillContext?: string;
}): string {
  const assembledContext = renderAssembledContext(input.assembledContext);
  const hasAssembledContext = assembledContext.trim().length > 0;
  const readOption = input.readHopsLeft > 0
    ? `If you need to inspect existing files before writing the spec, respond with only JSON tool actions - e.g.\n{"action":"read","paths":["relative/path", "..."]}\n(max 8 paths; you have ${input.readHopsLeft} read request${input.readHopsLeft === 1 ? "" : "s"} left). Otherwise, write the spec now.`
    : "Write the spec now - no more file reads are available.";

  return [
    ARCHITECT_ROLE,
    "",
    "Project request from the user:",
    input.request,
    "",
    treeSection(input.treeText),
    hasAssembledContext ? assembledContext : "",
    !hasAssembledContext && input.previousSummary?.trim()
      ? `\nThis is a FOLLOW-UP pass: a previous build already delivered the project summarized below. Everything delivered is still a requirement - preserve it. Specify ONLY the delta unless the notes/request require repair.\nPrevious hand-off summary:\n${input.previousSummary}`
      : "",
    !hasAssembledContext ? input.fileContext : "",
    !hasAssembledContext ? userNotesSection(input.userNotes) : "",
    !hasAssembledContext ? input.memoryBrief : "",
    "",
    `Your workers later in the build: ${input.workerNames.join(", ")}.`,
    workerCapabilityRosterSection(input.workerCapabilities),
    !hasAssembledContext ? scoreboardSection(input.scoreboard) : "",
    input.skillContext,
    "",
    readOption,
    skillRequestDoc(),
    contextRetrieveToolDoc(),
    codeIntelToolDoc(input.codeIntelStatus, input.codeIntelCallsLeft),
    searchToolDoc(input.searchesLeft),
    runToolDoc(input.runsLeft, input.shellHint, input.githubWorkflow, input.repoWorkflow, input.githubLabels),
    fetchToolDoc(input.fetchesLeft),
    repoToolDoc(input.repoWorkflow, input.githubCli, input.githubWorkflow),
    mcpToolDoc(input.mcpToolsDoc, input.mcpCallsLeft),
    "",
    "Before implementation planning, write an Architect-owned spec. This is where the strongest model makes the high-leverage choices: requirements, non-goals, acceptance criteria, code-quality bar, verification plan, constraints, implementation decisions, and known risks.",
    "Do not assign worker work here. Do not leave architecture, APIs, state shape, file boundaries, or verification strategy for cheaper workers to infer later.",
    "Respond with a short rationale followed by ONE fenced json block:",
    "```json",
    `{"action":"spec","spec":{"id":"S1","objective":"overall objective","requirements":["user-visible requirement or required file outcome"],"nonGoals":["explicitly excluded scope"],"acceptanceCriteria":["observable behavior or file outcome required before the build can pass"],"qualityCriteria":["maintainability, scope, integration, and test expectations"],"verification":["non-mutating command or browser/manual evidence expected"],"constraints":["repo/user constraints to preserve"],"implementationDecisions":["architectural/API/state/file-boundary decision workers must follow"],"risks":["edge case, integration risk, or ambiguity to cover"]},"notes":"durable conventions for planning/review","verifyCommand":"preferred non-mutating compile/type/lint/test command, or omit when none is meaningful"}`,
    "```",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildArchitectPlanPrompt(input: BuildPromptContextInput & {
  request: string;
  treeText: string;
  fileContext: string;
  maxTasks: number;
  workerNames: string[];
  workerCapabilities?: BuildWorkerCapabilitySummary[];
  spec?: BuildSpec;
  readHopsLeft: number;
  runsLeft?: number;
  searchesLeft?: number;
  codeIntelStatus?: string;
  codeIntelCallsLeft?: number;
  fetchesLeft?: number;
  mcpToolsDoc?: string;
  mcpCallsLeft?: number;
  userNotes?: string;
  scoreboard?: string;
  /** One-line note about the runner's shell/OS (e.g. Windows cmd.exe). */
  shellHint?: string;
  githubWorkflow?: boolean;
  /** Whether a runner is connected to a Git repo — gates the typed repo doc. */
  repoWorkflow?: boolean;
  /** Runner's GitHub CLI state — gates the issue/push/PR typed-action docs. */
  githubCli?: { available: boolean; authenticated: boolean };
  /** Existing GitHub label names so the model can prefer them over new ones. */
  githubLabels?: string[];
  /** Hand-off summary from a previous pass — this is a follow-up build. */
  previousSummary?: string;
  /** Durable AIBoard Build memory brief selected by the engine. */
  memoryBrief?: string;
  /** AIBoard-native compact skill context selected by the engine. */
  skillContext?: string;
}): string {
  const assembledContext = renderAssembledContext(input.assembledContext);
  const hasAssembledContext = assembledContext.trim().length > 0;
  const readOption = input.readHopsLeft > 0
    ? `If you need to inspect existing files before planning, respond with only JSON tool actions — e.g.\n{"action":"read","paths":["relative/path", "..."]}\n(max 8 paths; you have ${input.readHopsLeft} read request${input.readHopsLeft === 1 ? "" : "s"} left). You may send a few independent reads/searches together; the engine runs the safe ones as a batch and returns a served/skipped report. Otherwise, plan now.`
    : "Plan now — no more file reads are available.";

  return [
    ARCHITECT_ROLE,
    "",
    "Project request from the user:",
    input.request,
    "",
    treeSection(input.treeText),
    buildSpecSection(input.spec),
    hasAssembledContext ? assembledContext : "",
    !hasAssembledContext && input.previousSummary?.trim()
      ? `\nThis is a FOLLOW-UP pass: a previous build already delivered the project summarized below. Everything delivered is still a requirement — preserve it. Plan ONLY the delta (changes the notes/request ask for), editing existing files where possible instead of rebuilding.\nPrevious hand-off summary:\n${input.previousSummary}`
      : "",
    !hasAssembledContext ? input.fileContext : "",
    !hasAssembledContext ? userNotesSection(input.userNotes) : "",
    !hasAssembledContext ? input.memoryBrief : "",
    "",
    `Your workers: ${input.workerNames.join(", ")}.`,
    workerCapabilityRosterSection(input.workerCapabilities),
    !hasAssembledContext ? scoreboardSection(input.scoreboard) : "",
    input.skillContext,
    "",
    readOption,
    skillRequestDoc(),
    contextRetrieveToolDoc(),
    codeIntelToolDoc(input.codeIntelStatus, input.codeIntelCallsLeft),
    searchToolDoc(input.searchesLeft),
    runToolDoc(input.runsLeft, input.shellHint, input.githubWorkflow, input.repoWorkflow, input.githubLabels),
    fetchToolDoc(input.fetchesLeft),
    repoToolDoc(input.repoWorkflow, input.githubCli, input.githubWorkflow),
    mcpToolDoc(input.mcpToolsDoc, input.mcpCallsLeft),
    "",
    input.spec
      ? "Build the implementation plan FROM THE ARCHITECT SPEC above. Do not weaken, reinterpret, or leave the listed design decisions to workers. If the spec is insufficient, fill in the missing detail in phaseSpec, notes, or each task's implementationContract instead of making workers infer it."
      : "Before listing worker tasks, define a compact current phase spec. This is the contract for the current wave only: objective, acceptance criteria, code-quality criteria, verification expectations, and constraints workers/reviewers must follow.",
    `To plan, respond with a short rationale followed by ONE fenced json block:`,
    "```json",
    `{"action":"build_plan","phaseSpec":{"id":"P1","objective":"current phase objective","acceptanceCriteria":["observable behavior or file outcome required before this phase can pass"],"qualityCriteria":["maintainability, scope, integration, and test expectations for this phase"],"verification":["non-mutating command or evidence expected for this phase"],"constraints":["important repo/user constraints workers must preserve"]},"implementationPlan":"brief Architect-owned implementation sequence and integration strategy","tasks":[{"id":"T1","title":"...","instructions":"complete, self-contained instructions — the worker sees nothing else; include the relevant phase acceptance and quality criteria","implementationContract":"binding design details for this worker: exact APIs/components/state shape/file boundaries/error cases/tests or evidence; do not leave these choices to the worker","contextFiles":["existing files the worker must see"],"outputPaths":["every file this task may create or modify"],"expectedOutputs":"short prose summary of expected files or outcomes","dependsOn":["ids of tasks whose output this one needs, [] when independent"],"assignTo":"optional worker display name for this task (omit to auto-assign by performance)","difficulty":3}],"notes":"conventions all workers must follow","verifyCommand":"ONE non-interactive shell command that compiles or syntax-checks this project; it runs automatically after every wave and its errors come back to you. Match the stack: dotnet build | go build ./... | cargo check | npx --yes tsc --noEmit | cmake -S . -B .verify-build && cmake --build .verify-build | g++ -fsyntax-only src/*.cpp | php -l src/index.php | python -m compileall -q . | ./gradlew compileJava. On Windows runners, do not use POSIX-only checks like test -f or grep; use npm/build commands or a node -e verifier. Omit only when nothing meaningful can run."}`,
    "```",
    `Task ids are advisory; the engine assigns the final incremental T<number> ids before workers start. Keep dependsOn internally consistent within your JSON plan.`,
    `verifyCommand must be a non-mutating verification command. It must not edit files; all source changes must go through worker output, patch, or append.`,
    `Rules: at most ${input.maxTasks} tasks this wave (you can add more after reviewing); make each task independently doable by one model in one response; put shared conventions (naming, stack, structure) in notes AND in each task's instructions; put binding design details in each task's implementationContract.`,
    `Task contract rule: use kind="modify" + completionMode="files" for tasks that must write files; kind="audit" or "verify" + completionMode="evidence" for no-change/current-state/acceptance-evidence tasks; completionMode="either" only when existing work may already satisfy the task. Do not force a file patch for an audit task.`,
    `Verification rule: verificationPolicy="tool" only when a command/browser/tool result is required. Use verificationPolicy="architect" when Architect review of available evidence is enough; the system will not force a tool check for that task.`,
    `Tasks run CONCURRENTLY whenever their "dependsOn" tasks are finished — maximize parallelism: keep dependsOn empty unless a task truly consumes another task's files, and prefer many independent tasks over one long chain. Workers cannot see each other's in-progress output, so each task must own its files exclusively.`,
    `List in every task's "outputPaths" ALL files it may create or modify; an integration/wiring/final-pass task that edits files produced by other tasks MUST name those tasks in its "dependsOn" — tasks with overlapping outputPaths are never run concurrently (the engine defers them), so omitting the dependency only stalls the wave, it cannot make them safe.`,
    `Rate each task's "difficulty" 1-5 honestly (1 = trivial boilerplate, 3 = typical feature, 5 = hard/architectural). It does not change who does the work — it weights the global model leaderboard so a model approved on a hard task outranks one approved on a trivial one. Be consistent across tasks.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Prompt for the plan critic: a second model attacks the Architect's plan
 * BEFORE any worker starts. The critic gets no tools and no structured-output
 * format — it replies with a short rationale and one fenced json verdict that
 * {@link parsePlanCritique} tolerantly extracts.
 */
export function buildPlanCritiquePrompt(input: {
  request: string;
  treeText: string;
  spec?: BuildSpec;
  phaseSpec?: BuildPhaseSpec;
  tasksJson: string;
  notes?: string;
  verifyCommand?: string;
  workerNames: string[];
  workerCapabilities?: BuildWorkerCapabilitySummary[];
}): string {
  return [
    "You are a principal engineer reviewing another architect's task plan BEFORE any work starts. Attack the decomposition, not the style. Workers are AI models that each get ONE task and see nothing else.",
    "",
    "Project request from the user:",
    input.request,
    "",
    treeSection(input.treeText),
    buildSpecSection(input.spec),
    buildPhaseSpecSection(input.phaseSpec),
    input.notes?.trim() ? `Architect notes for the workers:\n${input.notes.trim()}` : "",
    input.verifyCommand?.trim()
      ? `Architect's verifyCommand: ${input.verifyCommand.trim()}`
      : "",
    `The workers who will implement this plan: ${input.workerNames.join(", ")}.`,
    workerCapabilityRosterSection(input.workerCapabilities),
    "",
    "The plan's tasks (JSON):",
    input.tasksJson,
    "",
    "Attack the plan on these points, in order:",
    "1. Missing work: anything the request or Architect spec needs that no task covers.",
    '2. Wrong or missing dependsOn edges: a task that consumes another task\'s files MUST depend on it. Workers cannot see each other\'s in-progress output.',
    "3. Overlapping outputPaths between tasks that are supposed to be independent (they will clobber each other or be serialized, defeating the split).",
    "4. Tasks too large to complete well in one model response — these should have been pre-split into smaller tasks.",
    "5. contextFiles a worker will obviously need to do its task but was not given.",
    "6. Missing or vague implementationContract fields that leave APIs, file boundaries, state shape, edge cases, or verification evidence for cheap workers to invent.",
    "7. Any task, dependency, contract, or verifier choice that conflicts with the Architect spec's requirements, non-goals, implementation decisions, constraints, or risks.",
    "8. An unrealistic or missing verifyCommand for this stack (must be a real, non-mutating compile/check command).",
    "",
    "Reply with a short rationale then ONE fenced json block:",
    "```json",
    '{"verdict":"approve"|"revise","issues":[{"taskId":"T1","severity":"blocking"|"minor","issue":"what is wrong","suggestion":"how to fix"}],"missingWork":["work the plan forgot"]}',
    "```",
    'Blocking = the build will fail or produce wrong output if unaddressed. Minor = improvement. Use verdict "approve" when nothing is blocking.',
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Prompt sent back to the Architect after an independent critique found blocking
 * problems. Asks for exactly ONE revised complete plan (same plan schema the
 * plan prompt uses) that addresses every blocking issue.
 */
export function buildPlanRevisionPrompt(input: {
  request: string;
  treeText: string;
  spec?: BuildSpec;
  originalPlanJson: string;
  critiqueDigest: string;
  maxTasks: number;
}): string {
  return [
    ARCHITECT_ROLE,
    "",
    "An independent review found blocking problems in your plan. Produce a REVISED complete plan that addresses every blocking issue (and any minor ones you agree with). Do not restart from scratch — keep what was right.",
    "Keep each surviving task's id from your original plan (do not renumber), so dependsOn edges between tasks stay valid.",
    "",
    "Project request from the user:",
    input.request,
    "",
    treeSection(input.treeText),
    buildSpecSection(input.spec),
    "",
    "Your original plan:",
    input.originalPlanJson,
    "",
    "Review findings:",
    input.critiqueDigest,
    "",
    `End with ONE fenced json block matching the build-plan schema (action "build_plan" with phaseSpec, implementationPlan, tasks[], notes, verifyCommand). At most ${input.maxTasks} tasks. Every task must include an implementationContract.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildWorkerTaskPrompt(input: BuildPromptContextInput & {
  request: string;
  treeText: string;
  task: BuildTask;
  contextFileText: string;
  architectNotes: string;
  toolInstructions?: string;
  verbosityInstruction?: string;
  /** AIBoard-native compact skill context selected by the engine. */
  skillContext?: string;
  /** Durable task/path-relevant AIBoard Build memory brief selected by the engine. */
  memoryBrief?: string;
}): string {
  const assembledContext = renderAssembledContext(input.assembledContext);
  const hasAssembledContext = assembledContext.trim().length > 0;
  return [
    `You are an AI engineer on a team building a project. The Architect assigned you ONE task. Complete it fully — other tasks are handled by teammates, so do not do their work or restructure files outside your task.`,
    "",
    "Overall project request (for context only):",
    input.request,
    "",
    treeSection(input.treeText),
    buildPhaseSpecSection(input.task.phaseSpec),
    hasAssembledContext ? assembledContext : "",
    !hasAssembledContext && input.architectNotes
      ? `\nArchitect's conventions:\n${input.architectNotes}`
      : "",
    !hasAssembledContext ? input.contextFileText : "",
    "",
    `YOUR TASK — ${input.task.id}: ${input.task.title}`,
    input.task.instructions,
    input.task.implementationContract?.trim()
      ? `Implementation contract from Architect:\n${input.task.implementationContract.trim()}`
      : "",
    `Task contract: kind=${input.task.kind ?? "auto"}, completionMode=${input.task.completionMode ?? "auto"}, verificationPolicy=${input.task.verificationPolicy ?? "auto"}.`,
    input.task.requiredEvidence?.length
      ? `Required evidence:\n${bulletList(input.task.requiredEvidence)}`
      : "",
    input.task.outputPaths?.length
      ? `Files you may create or modify for this task: ${input.task.outputPaths.join(", ")}`
      : "",
    input.task.expectedOutputs ? `Expected outputs: ${input.task.expectedOutputs}` : "",
    renderTaskGuidanceForWorker(input.task.guidance),
    !hasAssembledContext ? input.memoryBrief : "",
    input.skillContext,
    input.skillContext?.trim()
      ? WORKER_SKILL_EVIDENCE_INSTRUCTION
      : "",
    "Do not add or import a new test framework, browser automation package, or config file unless this task explicitly includes updating dependency files such as package.json and the lockfile. For browser verification, prefer MCP browser tools when available instead of creating Playwright/Cypress test files; if you must create tests that import a package, add the dependency and keep the verify command passing.",
    WEB_APP_BROWSER_ACCEPTANCE_INSTRUCTION,
    input.task.status === "fixing"
      ? "This is a FIX round: the Architect reviewed previous output and the instructions above tell you what to correct. Use read_range/search plus patch for existing files. If a file is missing or too large for one response, use append chunks. Do not emit full-file blocks for existing files."
      : "",
    "",
    input.toolInstructions ?? "",
    input.toolInstructions?.trim()
      ? "STRICT TOOL CALL RULE: if you use file tools, your entire response must be one or more JSON tool actions and nothing else — no prose before or after. The engine runs safe reads/searches together, applies writes in order, and reports which actions were served or skipped. Do not claim what a tool returned until the next turn, after the engine sends the tool result."
      : "",
    FILE_OUTPUT_INSTRUCTION,
    EDIT_BLOCK_INSTRUCTION,
    input.verbosityInstruction ?? "",
    "Keep prose brief — a short note on decisions is enough; the files are the deliverable.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildArchitectGuidancePrompt(input: BuildPromptContextInput & {
  request: string;
  treeText: string;
  task: BuildTask;
  architectNotes: string;
  guidance: BuildTaskGuidance;
}): string {
  return [
    "You are the Build Architect answering a worker's task-local guidance request.",
    "Answer the worker's exact question. Keep the answer advisory and scoped to this task.",
    'If the answer affects conventions across the build, include a short optional "memory" field with that reusable convention. Omit "memory" for task-only answers.',
    "Do not change outputPaths, dependsOn, file ownership, or write permissions. If the task contract is wrong, say what follow-up planning or review should do, but do not rewrite the contract in this answer.",
    "",
    "Overall project request:",
    input.request,
    "",
    treeSection(input.treeText),
    buildPhaseSpecSection(input.task.phaseSpec),
    input.architectNotes?.trim()
      ? `Architect notes:\n${input.architectNotes.trim()}`
      : "",
    "",
    `Task ${input.task.id}: ${input.task.title}`,
    input.task.instructions,
    input.task.outputPaths?.length
      ? `Task outputPaths: ${input.task.outputPaths.join(", ")}`
      : "Task outputPaths: none declared.",
    input.task.expectedOutputs
      ? `Expected outputs: ${input.task.expectedOutputs}`
      : "",
    "",
    `Guidance ${input.guidance.id}`,
    "Worker question:",
    input.guidance.question,
    input.guidance.reason ? `Reason:\n${input.guidance.reason}` : "",
    "",
    "Return ONLY one fenced json block:",
    `{"action":"guidance_answer","guidanceId":"${input.guidance.id}","taskId":"${input.task.id}","answer":"concise advisory answer for the worker","memory":"optional convention to reuse when this affects conventions across the build"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Marker appended when the wave diff patch is cut to fit the pack budget. */
const REVIEW_DIFF_TRUNCATION_MARKER =
  "\n...[diff truncated - use read_range for the rest]";

/** Cap on the number of changed-file paths listed in the review diff pack. */
const REVIEW_DIFF_FILES_CAP = 40;

/**
 * Render the wave's actual git diff as a bounded review context-pack body.
 *
 * Sections, in order: a header, the comma-joined changed-file list (capped at
 * {@link REVIEW_DIFF_FILES_CAP} with a `(+N more)` suffix), an optional `Stat:`
 * block, and the `Patch:` body. The patch is truncated so the TOTAL output never
 * exceeds `maxChars` (plus the marker's own length) — when cut, it ends with
 * {@link REVIEW_DIFF_TRUNCATION_MARKER}. Returns "" when both stat and patch are
 * empty/whitespace. The non-patch prefix is built first; the patch then gets
 * whatever room remains (floor 0), so a tiny budget yields a prefix-only pack
 * with no Patch section rather than a broken half-line.
 *
 * The prefix (files list + stat) is assumed small — a `git diff --stat` over
 * ≤{@link REVIEW_DIFF_FILES_CAP} paths is a few KB — and is intentionally NOT
 * bounded by `maxChars`; only the patch body is.
 */
export function buildReviewDiffPackContent(input: {
  stat?: string;
  patch?: string;
  files: string[];
  maxChars: number;
}): string {
  const stat = (input.stat ?? "").trim();
  const patch = (input.patch ?? "").trim();
  if (!stat && !patch) return "";

  const shownFiles = input.files.slice(0, REVIEW_DIFF_FILES_CAP);
  const overflow = input.files.length - shownFiles.length;
  const filesLine = `${shownFiles.join(", ")}${overflow > 0 ? ` (+${overflow} more)` : ""}`;

  const prefixLines = [
    "Unified diff of this wave's landed changes (primary review evidence):",
    filesLine,
  ];
  if (stat) prefixLines.push("Stat:", stat);
  const prefix = prefixLines.join("\n");

  if (!patch) return prefix;

  // Reserve room for the patch header, the patch body, and the marker within
  // maxChars. The marker only counts against maxChars when we actually truncate,
  // but reserving it up front keeps the "when full, no marker" output within
  // maxChars while a truncated output stays within maxChars + marker length.
  const patchHeader = "\nPatch:\n";
  const patchBudget =
    input.maxChars -
    prefix.length -
    patchHeader.length -
    REVIEW_DIFF_TRUNCATION_MARKER.length;
  if (patchBudget <= 0) return prefix;

  if (patch.length <= patchBudget) {
    return `${prefix}${patchHeader}${patch}`;
  }
  return `${prefix}${patchHeader}${patch.slice(0, patchBudget)}${REVIEW_DIFF_TRUNCATION_MARKER}`;
}

export function buildArchitectReviewPrompt(input: BuildPromptContextInput & {
  request: string;
  treeText: string;
  fileContext?: string;
  executedText: string;
  outstandingTasks?: string;
  maxNewTasks: number;
  cyclesLeft: number;
  readHopsLeft?: number;
  rangeReadsLeft?: number;
  runsLeft?: number;
  searchesLeft?: number;
  codeIntelStatus?: string;
  codeIntelCallsLeft?: number;
  mcpToolsDoc?: string;
  mcpCallsLeft?: number;
  fetchesLeft?: number;
  userNotes?: string;
  scoreboard?: string;
  workerCapabilities?: BuildWorkerCapabilitySummary[];
  /** One-line note about the runner's shell/OS (e.g. Windows cmd.exe). */
  shellHint?: string;
  githubWorkflow?: boolean;
  /** Whether a runner is connected to a Git repo — gates the typed repo doc. */
  repoWorkflow?: boolean;
  /** Runner's GitHub CLI state — gates the issue/push/PR typed-action docs. */
  githubCli?: { available: boolean; authenticated: boolean };
  /** Existing GitHub label names so the model can prefer them over new ones. */
  githubLabels?: string[];
  /** AIBoard-native compact skill context selected by the engine. */
  skillContext?: string;
  /** Durable AIBoard Build memory brief selected by the engine. */
  memoryBrief?: string;
  /** Durable worker skill evidence and gaps captured by the engine. */
  skillEvidenceText?: string;
  /** Full Architect-owned build spec that review verdicts must preserve. */
  spec?: BuildSpec;
  /** Current phase contract that review verdicts must check against. */
  phaseSpec?: BuildPhaseSpec;
  /** Whether a "Wave diff" pack (the actual landed git diff) is in the assembled
   * context — when true, tell the reviewer to judge from the diff first. */
  hasDiffDigest?: boolean;
  /** Task ids whose acceptance screenshots are ATTACHED to this review call —
   * when non-empty, tell the reviewer to judge visual acceptance from them. */
  screenshotTaskIds?: string[];
}): string {
  const assembledContext = renderAssembledContext(input.assembledContext);
  const hasAssembledContext = assembledContext.trim().length > 0;
  return [
    ARCHITECT_ROLE,
    "",
    "Project request from the user:",
    input.request,
    "",
    treeSection(input.treeText),
    buildSpecSection(input.spec),
    buildPhaseSpecSection(input.phaseSpec),
    hasAssembledContext ? assembledContext : "",
    !hasAssembledContext && input.fileContext?.trim()
      ? `\nFile contents you have already read — ground every decision in these; NEVER invent replacement content for an existing file:${input.fileContext}`
      : "",
    !hasAssembledContext ? userNotesSection(input.userNotes) : "",
    "",
    !hasAssembledContext
      ? "Work completed since your last review (compact landed-change digest, not full file contents):"
      : "",
    !hasAssembledContext ? input.executedText : "",
    !hasAssembledContext && input.skillEvidenceText?.trim()
      ? `\n${input.skillEvidenceText}\nMissing required skill evidence is a blocking review issue: return a fix verdict unless the task is clearly exempt and the exemption evidence is present.`
      : "",
    !hasAssembledContext && input.outstandingTasks?.trim()
      ? `\nRequired tasks still not done:\n${input.outstandingTasks}\nDo NOT set "done": true while any required task is listed here. Approve completed outstanding tasks, send unfinished ones back with precise fix instructions, or create replacement tasks that explicitly cover the missing work.`
      : "",
    "",
    !hasAssembledContext ? scoreboardSection(input.scoreboard) : "",
    workerCapabilityRosterSection(input.workerCapabilities),
    !hasAssembledContext ? input.memoryBrief : "",
    input.skillContext,
    input.hasDiffDigest
      ? 'A "Wave diff" pack in the assembled context is the PRIMARY evidence for this review — judge the landed changes from the diff first; use read/read_range only for surrounding context the diff does not show.'
      : "",
    "Review each task's output from the Architect spec, current phase spec, task instructions, task implementation contract, landed-change digest, automated build checks, and targeted reads/searches when needed. You can fix small problems YOURSELF before your decision — your changes overwrite the workers'. For bigger problems, send the task back with precise fix instructions.",
    EDIT_BLOCK_INSTRUCTION,
    `${WEB_APP_BROWSER_ACCEPTANCE_INSTRUCTION} Browser acceptance is a completion gate for web apps: do NOT set "done": true without evidence that the main workflow was exercised in a browser and finished with no visible stuck loading, visible error state, blank screen, blocking overlay, or console errors.`,
    input.screenshotTaskIds && input.screenshotTaskIds.length > 0
      ? `Screenshot(s) of the running app are ATTACHED for: ${input.screenshotTaskIds.join(", ")} — judge visual acceptance from them (requested appearance/behavior, layout, obvious breakage, error states, blank screens), in addition to the textual evidence. For any request with visual or interactive output, do not set "done": true unless the screenshot visibly matches the requested result; if the evidence is weak, placeholder-like, or ambiguous, return a fix or create a follow-up task.`
      : "",
    'Request fulfillment is a completion gate for EVERY build: compare the original user request, Architect spec, current phase spec, landed output, and verification evidence. Return `requestFulfillment` with reviewed=true only after doing that comparison. Set satisfied=true only when the landed output satisfies the request with no blocking gaps. Do NOT set "done": true unless requestFulfillment.reviewed=true and requestFulfillment.satisfied=true.',
    skillRequestDoc(),
    contextRetrieveToolDoc(),
    input.readHopsLeft && input.readHopsLeft > 0
      ? `If you need to see an existing file's contents before deciding, respond with only JSON tool actions — e.g.\n{"action":"read","paths":["relative/path", "..."]}\n(max 8 paths; ${input.readHopsLeft} read request${input.readHopsLeft === 1 ? "" : "s"} left in this review). You may combine a few independent reads/searches in one turn. Never guess at a file's contents — read it.`
      : "",
    readRangeToolDoc(input.rangeReadsLeft),
    codeIntelToolDoc(input.codeIntelStatus, input.codeIntelCallsLeft),
    searchToolDoc(input.searchesLeft),
    runToolDoc(input.runsLeft, input.shellHint, input.githubWorkflow, input.repoWorkflow, input.githubLabels),
    fetchToolDoc(input.fetchesLeft),
    repoToolDoc(input.repoWorkflow, input.githubCli, input.githubWorkflow),
    mcpToolDoc(input.mcpToolsDoc, input.mcpCallsLeft),
    "",
    'If the automated verifier itself is wrong for this stack, replace the automated verifier by adding `verifyCommand` to your review JSON. Use a real non-mutating command that matches the files, or `""` only when no meaningful automated verifier exists. Do not replace a failing valid verifier just to hide real implementation failures.',
    "End with ONE fenced json block:",
    "```json",
    `{"action":"review","results":[{"taskId":"T1","specVerdict":"approve","qualityVerdict":"fix","specIssues":"","qualityIssues":"code-quality issue when qualityVerdict is fix","fixInstructions":"required when either verdict is fix"}],"newTasks":[{"id":"T9","title":"...","instructions":"...","implementationContract":"binding design details for this new task: exact APIs/components/state shape/file boundaries/error cases/tests or evidence; do not leave these choices to the worker","contextFiles":["existing files the worker must see"],"outputPaths":["every file this task may create or modify"],"dependsOn":[],"assignTo":"optional worker display name","difficulty":3}],"phaseSpec":{"id":"P2","objective":"next phase objective for newTasks when the phase changes","acceptanceCriteria":["criterion for new tasks"],"qualityCriteria":["quality bar for new tasks"],"verification":["command or evidence"],"constraints":["constraint to preserve"]},"requestFulfillment":{"reviewed":true,"satisfied":false,"summary":"Compared landed output to the original user request; gaps remain.","evidence":["files, checks, browser/CLI/API/docs/repo evidence reviewed"],"gaps":["blocking unmet requirement or missing evidence"]},"verifyCommand":"optional replacement verifier when the current one is wrong for this stack","done":false,"notes":"updated conventions if any"}`,
    "```",
    `Task ids in newTasks are advisory only; the engine assigns the next incremental T<number> ids and preserves existing task ids across refresh/resume. Use dependsOn only for existing task ids or other new-task ids you defined in the same JSON.`,
    `New tasks run CONCURRENTLY when their "dependsOn" tasks are finished — keep dependsOn empty unless a task consumes another task's output, and give each task exclusive ownership of its files via outputPaths. Always list the existing files a new task builds on in contextFiles. Every new task must include an implementationContract so workers do not invent architecture, APIs, state shape, file boundaries, edge cases, or verification evidence.`,
    `Every new task should also include kind, completionMode, verificationPolicy, and requiredEvidence when no-file or Architect-reviewed completion is acceptable.`,
    "Spec-compliance review checks whether the landed work satisfies the Architect spec, current phase spec, task instructions, and implementation contract. Code-quality review checks maintainability, scoped changes, integration, verification evidence, and repo conventions. A task is approved only when BOTH specVerdict and qualityVerdict are approve.",
    `Rules: max ${input.maxNewTasks} new tasks; ${input.cyclesLeft} review cycle${input.cyclesLeft === 1 ? "" : "s"} remain after this one, so prioritize what makes the project complete and working. Set "done": true ONLY when the project fulfils the request with no outstanding fixes.`,
    input.userNotes?.trim()
      ? 'The user\'s notes above are requirements: turn any that aren\'t covered yet into fix instructions or new tasks, and do NOT set "done": true while one remains unaddressed.'
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildArchitectSummaryPrompt(input: BuildPromptContextInput & {
  request: string;
  treeText: string;
  /** Paths actually written this run — the summary may only claim these. */
  filesChanged?: string;
  historyText: string;
  verbosityInstruction?: string;
  userNotes?: string;
  /** AIBoard-native ship/summary skill context selected by the engine. */
  skillContext?: string;
  /** Durable worker skill evidence and gaps captured by the engine. */
  skillEvidenceText?: string;
  /** When the run was a GitHub workflow, forbid claiming GitHub outcomes —
   * the engine appends an authoritative Repository-workflow section. */
  githubWorkflow?: boolean;
}): string {
  const assembledContext = renderAssembledContext(input.assembledContext);
  const hasAssembledContext = assembledContext.trim().length > 0;
  return [
    ARCHITECT_ROLE,
    "",
    "The build is finished. Write the final hand-off summary for the user in GitHub-flavored Markdown:",
    "- What was built and how it is structured (reference real file paths).",
    "- How to run / use it.",
    "- Key decisions and trade-offs.",
    "- Known gaps or follow-ups, if any.",
    "",
    "Project request:",
    input.request,
    "",
    treeSection(input.treeText),
    input.filesChanged?.trim()
      ? `\nFiles actually created or modified in THIS run (the complete list — do NOT claim changes to any file not listed here; if something planned is missing from this list, it did NOT happen and belongs under known gaps):\n${input.filesChanged}`
      : "\nNo files were created or modified in this run — say so plainly and describe what went wrong instead of describing planned work as done.",
    hasAssembledContext ? assembledContext : "",
    !hasAssembledContext ? userNotesSection(input.userNotes) : "",
    !hasAssembledContext && input.memoryBrief?.trim()
      ? `\n${input.memoryBrief}`
      : "",
    !hasAssembledContext && input.verificationText?.trim()
      ? `\nVerification actually performed:\n${input.verificationText}`
      : "",
    !hasAssembledContext && input.knownGaps?.trim()
      ? `\nKnown gaps and unperformed work:\n${input.knownGaps}`
      : "",
    "",
    !hasAssembledContext ? "Build history (plans, reviews, outcomes):" : "",
    !hasAssembledContext ? input.historyText : "",
    input.skillContext,
    !hasAssembledContext && input.skillEvidenceText?.trim()
      ? `\nSkill evidence and gaps to account for in the hand-off:\n${input.skillEvidenceText}`
      : "",
    "",
    input.verbosityInstruction ?? "",
    input.githubWorkflow
      ? "GITHUB OUTCOMES: do NOT state whether any GitHub milestone, issue, branch, commit, push, or pull request was created, nor its status — the engine appends an authoritative \"Repository workflow\" section below your summary with the REAL outcomes. Never assert a GitHub action succeeded; if you didn't see the engine confirm it via a tool result, it may not have happened."
      : "",
    hasAssembledContext
      ? "Known gaps, failed checks, and unperformed work in the assembled context must be reported as gaps, not described as completed work."
      : "",
    "Do not re-emit file contents. Do NOT wrap the summary in JSON.",
    META_FOOTER_INSTRUCTION,
  ]
    .filter(Boolean)
    .join("\n");
}

export const STRICT_RETRY_INSTRUCTION =
  'Your previous response did not contain a parseable JSON action. Respond again with ONLY the fenced json block (no other text), exactly matching the schema you were given, including the "action" field.';

// ── GitHub workflow: PR precondition + final-summary block (NRW-008) ──────────

/**
 * Whether a pull request may be opened in the current run. PRECONDITION
 * (acceptance-critical): there must be either a successful commit landed in THIS
 * run, OR a clean branch that is already ahead of its upstream (so there is real
 * work to open a PR for). Pure so the test can lock the boundary without a live
 * runner. Returns null when allowed, or a clear refusal message when not.
 */
export function prCreateRefusalReason(input: {
  commitsThisRun: number;
  clean: boolean;
  ahead: number;
  repoCommitWorkflowEnabled?: boolean;
}): string | null {
  if (input.repoCommitWorkflowEnabled === false) {
    return (
      "Cannot open a pull request yet: commit & PR workflow is not enabled on a " +
      "safe feature branch for this run. Create or switch to a safe feature branch " +
      "first, then commit and open the PR. Continue."
    );
  }
  const hasCommit = input.commitsThisRun > 0;
  const hasAheadCleanBranch = input.clean && input.ahead > 0;
  if (hasCommit || hasAheadCleanBranch) return null;
  return (
    "Cannot open a pull request yet: no commit landed in this run and the branch " +
    "is not a clean branch with commits ahead of its upstream. Commit your changes " +
    "first (repo_commit), then open the PR. Continue."
  );
}

function compactInlineCodeList(values: string[], cap = 20): string {
  if (values.length === 0) return "none recorded";
  const shown = values.slice(0, cap).map((value) => `\`${value}\``).join(", ");
  return values.length > cap ? `${shown}, +${values.length - cap} more` : shown;
}

export function buildEngineVerifiedOutputSummary(input: {
  filesChanged?: string[];
  producedFileCount?: number | null;
}): string {
  const filesChanged = [
    ...new Set(
      (input.filesChanged ?? [])
        .map((file) => file.trim())
        .filter(Boolean)
    ),
  ].sort();
  const lines = [
    "## Engine-verified outputs",
    "",
    "This section is generated by Build and overrides contradictory prose below.",
    `- Files created or modified this run: ${compactInlineCodeList(filesChanged)}`,
  ];
  if (
    typeof input.producedFileCount === "number" &&
    Number.isFinite(input.producedFileCount)
  ) {
    lines.push(`- Build artifact file count: ${Math.max(0, Math.trunc(input.producedFileCount))}`);
  }
  return lines.join("\n");
}

/**
 * Build the deterministic `## Repository workflow` summary block appended to the
 * Architect's final answer (NRW-006/008). Pure + bounded so the engine and the
 * test both render the exact same shape. Returns "" when there is nothing to
 * show (no branch, commits, issue, push, or PR). The optional verification line
 * states the resolved verify command's result when known.
 */
export function buildRepoWorkflowSummary(input: {
  targetRoot?: string | null;
  branch?: string | null;
  commits?: Array<{ hash: string; subject: string }>;
  issueNumber?: number | null;
  issueNumbers?: number[];
  milestoneTitle?: string | null;
  pushedBranch?: string | null;
  prUrl?: string | null;
  verification?: string | null;
  /** The request asked for a pull request — used to flag an incomplete workflow
   * when none was actually opened (guards against the Architect claiming it). */
  expectedPr?: boolean;
}): string {
  const commits = input.commits ?? [];
  const incompletePr = !!input.expectedPr && !input.prUrl;
  const issueNumbers = [
    ...new Set(
      [
        ...(input.issueNumbers ?? []),
        ...(input.issueNumber != null ? [input.issueNumber] : []),
      ].filter((issue) => Number.isInteger(issue) && issue > 0)
    ),
  ];
  const hasAnything =
    !!input.targetRoot?.trim() ||
    !!input.branch ||
    commits.length > 0 ||
    issueNumbers.length > 0 ||
    !!input.milestoneTitle?.trim() ||
    !!input.pushedBranch ||
    !!input.prUrl ||
    !!input.verification?.trim() ||
    incompletePr;
  if (!hasAnything) return "";

  const lines = ["", "## Repository workflow", ""];
  if (input.targetRoot?.trim()) {
    lines.push(`- Target repository: \`${input.targetRoot.trim()}\``);
  }
  if (input.branch) lines.push(`- Branch: \`${input.branch}\``);
  if (commits.length > 0) {
    for (const c of commits.slice(0, 20)) {
      lines.push(`- Commit \`${c.hash}\` ${c.subject}`);
    }
    if (commits.length > 20) {
      lines.push(`- …(+${commits.length - 20} more commit(s))`);
    }
  } else if (input.branch) {
    lines.push("- No commit action was recorded by Build this run.");
  }
  if (input.milestoneTitle?.trim()) {
    lines.push(`- Milestone: ${input.milestoneTitle.trim()}`);
  }
  if (issueNumbers.length === 1) lines.push(`- Issue: #${issueNumbers[0]}`);
  if (issueNumbers.length > 1) {
    lines.push(`- Issues: ${issueNumbers.map((issue) => `#${issue}`).join(", ")}`);
  }
  if (input.pushedBranch) lines.push(`- Pushed: \`${input.pushedBranch}\``);
  if (input.prUrl) lines.push(`- Pull request: ${input.prUrl}`);
  if (input.verification?.trim()) {
    lines.push(`- Verification: ${input.verification.trim()}`);
  }
  if (incompletePr) {
    lines.push(
      "- ⚠️ INCOMPLETE: a pull request was requested but none was opened on GitHub this run. This section is authoritative — disregard any claim above that a PR (or milestone/issues) was created if it is not listed here."
    );
  }
  return lines.join("\n");
}

